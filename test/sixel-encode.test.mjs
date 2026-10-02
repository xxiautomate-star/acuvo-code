/**
 * ── SIXEL: THE PARTS THAT CAN BE PROVEN WITHOUT A SCREEN ────────────────────
 *
 * ⚠️ I STILL CANNOT SEE THE PICTURE FROM HERE, and this file says so for the
 * same reason its sibling does: no assertion below proves an image appears on
 * anyone's monitor. What it proves is everything upstream of the monitor —
 * that a known bitmap encodes to exactly the bytes the sixel specification
 * says, that a PNG we build byte-by-byte decodes back to the pixels we put in,
 * and that every input we cannot handle returns null instead of a guess.
 *
 * ⭐ THE FIXTURES ARE CONSTRUCTED, NOT GENERATED. Not one byte here came from a
 * model, a GPU or a network call: `makePng` writes the chunks, CRCs and zlib
 * stream by hand. That is deliberate — an image feature whose tests need an
 * image generator is an image feature nobody can run in CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePng, fitImage, sixelSequence } from '../lib/terminal-graphics.mjs';
import { PALETTE_ANSI_256, sixelEncode, introducer, FINALIZER } from '../lib/vendor/sixel-encode.mjs';

/* ── a minimal PNG writer, so the fixtures are ours end to end ────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** `rows` are FILTERED scanlines: each begins with its filter-type byte. */
function makePng({ width, height, depth = 8, colourType = 6, rows, plte, trns, interlace = 0 }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colourType;
  ihdr[12] = interlace;
  const parts = [
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
  ];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', deflateSync(Buffer.concat(rows.map((r) => Buffer.from(r))))));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

/** 2×2 RGBA: a red row above a blue row, unfiltered. */
const RED_OVER_BLUE = makePng({
  width: 2,
  height: 2,
  rows: [[0, ...RED, ...RED], [0, ...BLUE, ...BLUE]],
});

/* ── the encoder ──────────────────────────────────────────────────────────── */

/**
 * ⭐ THE ONE TEST THAT IS REALLY A SPECIFICATION. Every byte below was derived
 * by hand from DEC STD 070 before the code was run, so it fails if the encoder
 * drifts in ANY direction — raster attributes, colour registers (which are
 * percentages, not 0–255), the `$` carriage return that ends a colour's pass
 * over the band, or the run-length form.
 *
 *   "1;1;2;2      raster attributes: aspect 1:1, 2 wide, 2 high
 *   #0;2;100;0;0  register 0 = RGB(100%, 0%, 0%) — red
 *   #1;2;0;0;100  register 1 = blue
 *   #0@@$         register 0: bit 0 set (top row) for 2 columns, then CR
 *   #1AA$         register 1: bit 1 set (bottom row) for 2 columns, then CR
 *
 * '@' is 0x40 = 63 + 1, i.e. the sixel whose only lit pixel is row 0. 'A' is
 * 63 + 2, i.e. row 1. That +63 offset is the whole trick of the format.
 */
test('a known 2×2 bitmap encodes to exactly the sixel the spec describes', () => {
  const { seq, reason } = sixelSequence(RED_OVER_BLUE, { palette: [[255, 0, 0], [0, 0, 255]] });
  assert.equal(reason, null);
  assert.equal(seq, '\x1bP0;1;q"1;1;2;2#0;2;100;0;0#1;2;0;0;100#0@@$#1AA$\x1b\\');
});

test('the sequence is framed as a DCS string — that framing is what makes it safe', () => {
  const { seq } = sixelSequence(RED_OVER_BLUE);
  // ESC P … ST. A terminal that does not implement sixel still recognises the
  // frame and swallows the payload, which is why WT is on the allowlist at all.
  assert.ok(seq.startsWith('\x1bP'), 'must open with DCS');
  assert.ok(seq.endsWith(FINALIZER), 'must close with ST');
  assert.equal(introducer(1), '\x1bP0;1;q');
});

/**
 * ── ⚠️⚠️ THE UPSTREAM BUG. This is the regression test for change 2 in
 * `lib/vendor/sixel-encode.mjs`.
 *
 * node-sixel 0.16.0 writes `colorMap.get(color) || 0`, which collapses "this
 * colour is not in the palette" into slot 0 — the background — and makes its
 * own nearest-colour fallback unreachable. `processBand` then SKIPS slot 0, so
 * the pixel is not drawn at all. Against a fixed palette that is most of a
 * photograph.
 *
 * The pixel here is RGB(250, 0, 0) and the palette holds RGB(255, 0, 0): close,
 * but not equal. With the bug the band is empty; with the fix it draws on
 * register 0. Both outcomes are "no crash", which is exactly why it needs a test
 * rather than a look.
 */
test('a colour that is NOT in the palette is drawn in the nearest register, not dropped', () => {
  const nearlyRed = makePng({ width: 1, height: 1, rows: [[0, 250, 0, 0, 255]] });
  const { seq } = sixelSequence(nearlyRed, { palette: [[255, 0, 0], [0, 0, 255]] });
  assert.ok(seq.includes('#0@$'), `unmatched colour was dropped instead of matched: ${JSON.stringify(seq)}`);
});

/**
 * ⚠️ Change 3: upstream reinterpreted the whole ArrayBuffer, ignoring the view's
 * offset. Every Node Buffer under 4KB is a slice of a shared pool, so "the view
 * starts at 0" is the exception, not the rule — and the symptom is a picture
 * made of whatever else was in the pool.
 */
test('encoding a view that does not start at byte 0 reads the view, not the buffer', () => {
  const pixels = new Uint8Array(2 * 1 * 4);
  pixels.set([255, 0, 0, 255, 0, 0, 255, 255]);
  const padded = new Uint8Array(8 + pixels.length);
  padded.set(pixels, 8);
  const view = padded.subarray(8);

  assert.equal(
    sixelEncode(view, 2, 1, [[255, 0, 0], [0, 0, 255]]),
    sixelEncode(pixels, 2, 1, [[255, 0, 0], [0, 0, 255]]),
  );
});

/**
 * ⚠️ 256 COLOURS DECLARE 249 REGISTERS, and the seven missing ones are not a
 * bug — they are the overlap between the 16 base ANSI colours and the 6×6×6
 * cube plus grey ramp (pure black, red, green, yellow, blue, magenta, cyan and
 * white appear in both halves). `sixelEncode` de-duplicates, which matters
 * because DEC STD 070 caps a device at 256 registers and a naive encoder that
 * declared the same colour twice would waste two of them.
 *
 * The number is pinned rather than computed so that a change to the palette has
 * to be a decision someone makes, not a diff nobody reads.
 */
test('the 256-colour palette declares 249 distinct registers — duplicates are merged', () => {
  assert.equal(PALETTE_ANSI_256.length, 256);
  const { seq } = sixelSequence(RED_OVER_BLUE);
  assert.equal((seq.match(/#\d+;2;/g) ?? []).length, 249);
  assert.ok(seq.includes('#0;2;0;0;0'), 'register 0 is black');
});

test('an output that would flood the pty declines with a reason instead of shipping it', () => {
  const { seq, reason } = sixelSequence(RED_OVER_BLUE, { maxBytes: 10 });
  assert.equal(seq, null);
  assert.equal(reason, 'too-large');
});

/* ── the decoder ──────────────────────────────────────────────────────────── */

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** The encoder side of a PNG scanline filter — the inverse of what we decode. */
function filterRow(type, cur, prev, bpp) {
  const out = [type];
  for (let x = 0; x < cur.length; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= bpp ? prev[x - bpp] : 0;
    let p = 0;
    if (type === 1) p = a;
    else if (type === 2) p = b;
    else if (type === 3) p = (a + b) >> 1;
    else if (type === 4) p = paeth(a, b, c);
    out.push((cur[x] - p) & 0xFF);
  }
  return out;
}

/**
 * ⭐ ALL FIVE FILTERS, NOT THE ONE OUR OWN WRITER EMITS. Real PNGs are written
 * by libpng and by browsers, which pick a filter per scanline on a heuristic —
 * so a decoder tested only against filter 0 is a decoder tested against nothing
 * it will ever meet. Paeth in particular is the one that goes subtly wrong and
 * produces a picture with a diagonal smear.
 */
test('every scanline filter round-trips — 0 through 4', () => {
  const width = 4;
  const height = 3;
  const rgb = [
    [10, 20, 30, 200, 100, 50, 0, 0, 0, 255, 255, 255],
    [11, 22, 33, 199, 99, 49, 1, 2, 3, 254, 253, 252],
    [90, 80, 70, 5, 6, 7, 128, 128, 128, 60, 70, 80],
  ];
  for (let type = 0; type <= 4; type++) {
    const rows = rgb.map((row, y) => filterRow(type, row, y ? rgb[y - 1] : null, 3));
    const img = decodePng(makePng({ width, height, colourType: 2, rows }));
    assert.ok(img, `filter ${type} failed to decode`);
    const expected = [];
    for (const row of rgb) for (let i = 0; i < row.length; i += 3) expected.push(row[i], row[i + 1], row[i + 2], 255);
    assert.deepEqual([...img.rgba], expected, `filter ${type} decoded wrong`);
  }
});

test('truecolour with alpha decodes to the pixels that went in', () => {
  const img = decodePng(RED_OVER_BLUE);
  assert.equal(img.width, 2);
  assert.equal(img.height, 2);
  assert.deepEqual([...img.rgba], [...RED, ...RED, ...BLUE, ...BLUE]);
});

test('an indexed PNG resolves through PLTE, and tRNS gives it transparency', () => {
  // depth 4, so two pixels share a byte: indices 0 and 1 → 0x01.
  const img = decodePng(makePng({
    width: 2,
    height: 1,
    depth: 4,
    colourType: 3,
    plte: Buffer.from([1, 2, 3, 250, 251, 252]),
    trns: Buffer.from([0, 128]),
    rows: [[0, 0x01]],
  }));
  assert.deepEqual([...img.rgba], [1, 2, 3, 0, 250, 251, 252, 128]);
});

test('sub-byte greyscale is scaled to full range, not left as 0 and 1', () => {
  // 1-bit grey, 4 pixels: 1,0,1,1 → 0b1011 in the high nibble.
  const img = decodePng(makePng({ width: 4, height: 1, depth: 1, colourType: 0, rows: [[0, 0b10110000]] }));
  assert.deepEqual([...img.rgba], [
    255, 255, 255, 255,
    0, 0, 0, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
  ]);
});

test('greyscale with alpha keeps the alpha', () => {
  const img = decodePng(makePng({ width: 2, height: 1, colourType: 4, rows: [[0, 40, 255, 90, 0]] }));
  assert.deepEqual([...img.rgba], [40, 40, 40, 255, 90, 90, 90, 0]);
});

test('16-bit samples are truncated to the high byte, which is all a terminal can show', () => {
  const img = decodePng(makePng({
    width: 1,
    height: 1,
    depth: 16,
    colourType: 2,
    rows: [[0, 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC]],
  }));
  assert.deepEqual([...img.rgba], [0x12, 0x56, 0x9A, 255]);
});

/**
 * ⚠️ THE ABSTENTIONS. Each of these is a file we could half-read and draw
 * WRONG. Returning null costs the user a file path — the thing they had before
 * this feature existed — and drawing a guess costs them their trust in every
 * picture we print after it.
 */
test('anything we cannot decode returns null so the caller prints the path', () => {
  const rows = [[0, ...RED]];
  assert.equal(decodePng(Buffer.from('not a png at all')), null, 'non-PNG');
  assert.equal(decodePng(Buffer.alloc(0)), null, 'empty');
  assert.equal(
    decodePng(makePng({ width: 1, height: 1, rows, interlace: 1 })),
    null,
    'Adam7 interlacing — declined, not guessed',
  );
  assert.equal(
    decodePng(makePng({ width: 1, height: 1, depth: 4, colourType: 6, rows })),
    null,
    'a bit depth the spec does not allow for this colour type',
  );
  assert.equal(
    decodePng(makePng({ width: 1, height: 1, colourType: 3, rows })),
    null,
    'indexed with no PLTE',
  );
  assert.equal(
    decodePng(makePng({ width: 4000, height: 5000, rows }), { maxPixels: 100 }),
    null,
    'a header claiming more pixels than we will allocate',
  );
  assert.equal(decodePng(makePng({ width: 1, height: 1, rows }).subarray(0, 40)), null, 'truncated file');
});

test('a PNG whose IDAT is not valid zlib is declined, not thrown', () => {
  const good = makePng({ width: 1, height: 1, rows: [[0, ...RED]] });
  const broken = Buffer.from(good);
  // Corrupt the deflate stream in place; the chunk framing stays intact.
  broken[broken.indexOf(Buffer.from('IDAT')) + 6] ^= 0xFF;
  assert.equal(decodePng(broken), null);
});

/* ── scaling ──────────────────────────────────────────────────────────────── */

test('downscaling averages the box it replaces — 4×4 to 2×2, by hand', () => {
  // Four 2×2 quadrants of one flat colour each, so every output pixel has an
  // arithmetic mean that can be written down.
  const rgba = new Uint8Array(4 * 4 * 4);
  const quad = [[0, 0, 0, 255], [100, 100, 100, 255], [200, 200, 200, 255], [40, 40, 40, 255]];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const c = quad[(y < 2 ? 0 : 2) + (x < 2 ? 0 : 1)];
      rgba.set(c, (y * 4 + x) * 4);
    }
  }
  const out = fitImage({ width: 4, height: 4, rgba }, 2, 2);
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.deepEqual([...out.rgba], [
    0, 0, 0, 255,
    100, 100, 100, 255,
    200, 200, 200, 255,
    40, 40, 40, 255,
  ]);
});

test('a small image is never upscaled into a blurry wall', () => {
  const image = { width: 2, height: 2, rgba: new Uint8Array(16) };
  assert.equal(fitImage(image, 800, 480), image, 'must be the same object — no work done at all');
});

test('a wide image is bounded by width and keeps its aspect ratio', () => {
  const out = fitImage({ width: 1600, height: 400, rgba: new Uint8Array(1600 * 400 * 4) }, 800, 480);
  assert.equal(out.width, 800);
  assert.equal(out.height, 200);
});
