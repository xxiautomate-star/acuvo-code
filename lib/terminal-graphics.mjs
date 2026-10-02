/**
 * ── ⭐⭐ THE TERMINAL IS A CANVAS, NOT A LOG ─────────────────────────────────
 *
 * Every coding CLI treats the terminal as append-only text. It is not. It is a
 * grid of cells with 24-bit colour, and several modern terminals accept ACTUAL
 * PIXELS through documented escape sequences — no dependency, no framework, no
 * permission. Just bytes on stdout.
 *
 * ⭐ WHY THIS IS OURS AND NOT ANYONE ELSE'S. A coding agent has nothing to show
 * you: it writes text, so it prints text. This one renders pages, generates
 * images and draws faces, and until now it has been describing them in prose
 * like a radio announcer calling a painting. `see_page` already produces a real
 * screenshot and then tells you a FILE PATH. Printing the picture instead is a
 * capability the competition structurally cannot copy, because they have no
 * picture to print.
 *
 * ── ⭐⭐ SIXEL SHIPPED 2026-08-25, AND THE HISTORY IS THE LESSON ─────────────
 *
 * This header used to say, at length, **"No sixel."** The stated reason was that
 * sixel needs raw pixels, which means owning a PNG decoder and a palette
 * quantiser — "perhaps 300 lines with genuine correctness risk". That estimate
 * was made while an MIT-licensed sixel encoder AND quantiser sat in our own
 * `INTEGRATIONS.md`, already licence-cleared. **The doctrine is: read the
 * register before estimating the build.** What we actually wrote is the PNG
 * decoder — inflate is free from `node:zlib`, and un-filtering is five documented
 * cases — while the band packing, the part with the real correctness risk, is
 * vendored from `node-sixel` (see `lib/vendor/NOTICE.md`).
 *
 * ⚠️ AND VENDORING IT CAUGHT A BUG THAT WOULD HAVE SHIPPED A BLANK PICTURE.
 * node-sixel 0.16.0's nearest-colour fallback is unreachable — `colorMap.get(c)
 * || 0` makes "colour not in palette" indistinguishable from "transparent", so
 * every unmatched pixel is dropped. Reading the source we copied is what found
 * it; installing the package would have hidden it. It is fixed, and pinned by a
 * test, in `lib/vendor/sixel-encode.mjs`.
 *
 * ⭐ THE POINT OF ALL THIS IS WINDOWS TERMINAL, which is what Roman himself uses
 * and which shipped sixel in v1.22. Before today this entire feature did nothing
 * on the author's own machine — a feature that silently does nothing where its
 * author works is how "it works" becomes a lie.
 *
 * ⭐ WHAT IT COSTS, MEASURED on a synthetic 1440×900 screenshot: decoded,
 * downscaled to 768×480 and encoded in **198ms**, producing **12KB** of sixel —
 * about a fifth of the 62KB PNG. Round-tripped through a throwaway sixel parser,
 * 100% of pixels are drawn with a mean channel error of 7.78/255 (the error is
 * the 6-level colour cube showing up in gradients, and nowhere else).
 *
 * ⚠️ AND IT MUST NEVER CORRUPT A TERMINAL THAT CANNOT READ IT. An unrecognised
 * escape sequence does not always render as nothing — it can render as garbage,
 * and a few kilobytes of base64 vomited into a pipe is worse than any missing
 * feature. So detection stays ALLOWLIST-ONLY: a terminal we do not positively
 * recognise gets text, forever. Guessing costs more than abstaining.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import {
  BIG_ENDIAN,
  FINALIZER,
  PALETTE_ANSI_256,
  introducer,
  sixelEncode,
} from './vendor/sixel-encode.mjs';

/** Terminals whose support we have positively identified, and by which protocol. */
const KITTY_PROTOCOL = 'kitty';
const ITERM_PROTOCOL = 'iterm';
const SIXEL_PROTOCOL = 'sixel';

const PROTOCOLS = new Set([KITTY_PROTOCOL, ITERM_PROTOCOL, SIXEL_PROTOCOL]);

/**
 * Which inline-image protocol this terminal speaks, or null.
 *
 * ⚠️ ENV IS READ AT CALL TIME, never captured at import — the same rule the
 * media config follows, and for the same reason: a test must be able to hand in
 * a different environment without reloading the module.
 */
export function detectImageProtocol(env = process.env, { isTTY = process.stdout.isTTY } = {}) {
  /**
   * ⚠️ THE OVERRIDE IS CHECKED FIRST AND IN BOTH DIRECTIONS. Someone on a
   * terminal we have not heard of should be able to turn this on — or name a
   * protocol outright with `ACUVO_INLINE_IMAGES=sixel` — and someone piping our
   * output somewhere should be able to turn it off. `0` must win over every
   * piece of cleverness below it.
   */
  const forced = env.ACUVO_INLINE_IMAGES?.trim().toLowerCase();
  if (forced === '0' || forced === 'false' || forced === 'off') return null;
  const forcedProtocol = PROTOCOLS.has(forced) ? forced : null;

  /**
   * ⚠️ NOT A TTY MEANS SOMETHING IS READING THIS, not someone. `acuvo --json |
   * jq` must never receive image bytes; it would not just look wrong, it would
   * break the parse. This check sits above the allowlist deliberately: being
   * ON kitty is irrelevant when stdout is a file.
   */
  if (!isTTY && forced !== '1' && !forcedProtocol) return null;
  if (forcedProtocol) return forcedProtocol;

  const program = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();

  /**
   * ⚠️ A MULTIPLEXER IS A TERMINAL THAT REWRITES YOUR ESCAPE SEQUENCES. tmux and
   * screen parse the stream and forward what they understand; a DCS or APC image
   * payload needs passthrough wrapping they do not do by default, and the usual
   * result is the payload printed as text across the screen. The outer terminal
   * being capable is irrelevant when something sits in between, so this is
   * checked BEFORE any allowlist below.
   */
  if (env.TMUX || term.startsWith('screen') || term.startsWith('tmux')) return null;

  // Kitty itself, and the terminals that implement its protocol. Preferred
  // where available: it takes the PNG byte-for-byte, at full colour depth.
  if (env.KITTY_WINDOW_ID) return KITTY_PROTOCOL;
  if (term.includes('kitty')) return KITTY_PROTOCOL;
  if (program === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) return KITTY_PROTOCOL;
  if (program === 'wezterm' || env.WEZTERM_PANE !== undefined) return KITTY_PROTOCOL;
  if (env.KONSOLE_VERSION) return KITTY_PROTOCOL;

  if (program === 'iterm.app' || env.ITERM_SESSION_ID) return ITERM_PROTOCOL;

  /**
   * ── SIXEL, AND WHY EACH OF THESE IS SAFE ────────────────────────────────────
   *
   * ⭐ SIXEL DATA IS A DCS STRING, and that is the property that makes this
   * allowlist defensible where the kitty one had to be paranoid. A VT-conformant
   * parser that does not implement sixel still recognises `ESC P … ST` as a
   * device-control STRING and swallows the payload — the DCS-ignore state exists
   * precisely for sequences a terminal does not know. So the failure mode on a
   * conformant-but-old terminal is "nothing appears", not "screenful of noise".
   * That is what lets Windows Terminal onto the list on the strength of an env
   * var alone, where guessing was previously refused.
   *
   * ⚠️ WHAT IS STILL NOT GUESSED: anything whose VT parser we cannot vouch for.
   * The legacy Windows console does NOT set WT_SESSION, so it is untouched.
   * VS Code's terminal can do sixel but only behind a setting that is off by
   * default, so it stays on the text side. GNOME Terminal / VTE likewise.
   */
  if (env.WT_SESSION) return SIXEL_PROTOCOL;       // Windows Terminal ≥ 1.22
  if (env.MLTERM) return SIXEL_PROTOCOL;           // mlterm sets this to its version
  if (program === 'mintty') return SIXEL_PROTOCOL; // mintty (Git Bash on Windows)
  if (program === 'contour') return SIXEL_PROTOCOL;
  if (term.startsWith('foot')) return SIXEL_PROTOCOL;
  if (term.includes('sixel')) return SIXEL_PROTOCOL; // xterm started with -ti vt340
  if (term.startsWith('mlterm') || term.startsWith('yaft')) return SIXEL_PROTOCOL;

  // ⚠️ Everything else — VS Code, plain xterm, CI, unknown — gets text.
  if (forced === '1') return KITTY_PROTOCOL;
  return null;
}

/**
 * Kitty graphics protocol: transmit-and-display a PNG.
 *
 * ⚠️ CHUNKED AT 4096 BASE64 CHARACTERS, WHICH IS THE SPEC AND NOT A PREFERENCE.
 * Terminals drop escape sequences longer than their input buffer, and the
 * failure is silent — no image, no error, nothing to debug. `m=1` means another
 * chunk follows; the final chunk carries `m=0`.
 */
export function kittySequence(pngBytes) {
  const b64 = Buffer.from(pngBytes).toString('base64');
  const CHUNK = 4096;
  if (b64.length <= CHUNK) return `\x1b_Ga=T,f=100;${b64}\x1b\\`;

  const parts = [];
  for (let i = 0; i < b64.length; i += CHUNK) {
    const slice = b64.slice(i, i + CHUNK);
    const more = i + CHUNK < b64.length ? 1 : 0;
    // Control keys go on the FIRST chunk only; later chunks carry just `m`.
    parts.push(i === 0
      ? `\x1b_Ga=T,f=100,m=${more};${slice}\x1b\\`
      : `\x1b_Gm=${more};${slice}\x1b\\`);
  }
  return parts.join('');
}

/**
 * iTerm2 inline image protocol.
 *
 * `size` is the byte length of the DECODED image — iTerm uses it for a progress
 * indicator, and getting it wrong shows a stalled bar on a picture that already
 * arrived. `inline=1` displays rather than downloads.
 */
export function itermSequence(pngBytes, { name = 'acuvo.png' } = {}) {
  const buf = Buffer.from(pngBytes);
  const args = [
    'inline=1',
    `size=${buf.length}`,
    `name=${Buffer.from(name, 'utf8').toString('base64')}`,
    'width=60', // cells, not pixels — a full-width screenshot swamps the scrollback
    'preserveAspectRatio=1',
  ].join(';');
  return `\x1b]1337;File=${args}:${buf.toString('base64')}\x07`;
}

/* ════════════════════════════════════════════════════════════════════════════
 * PNG → RGBA. The half sixel does not give us.
 *
 * ⚠️ THIS IS A DECODER FOR OUR OWN SCREENSHOTS, NOT A GENERAL IMAGE LIBRARY, and
 * the difference is deliberate. Every format it does not handle returns `null`
 * and the caller prints the path — which is the behaviour of the entire feature
 * anyway, so an unsupported PNG costs a user nothing they had yesterday. A
 * decoder that GUESSED at an interlaced file would cost them a wrong picture.
 * ════════════════════════════════════════════════════════════════════════════ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** Samples per pixel, by PNG colour type. Types 1 and 5 do not exist. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Scale a sub-byte greyscale sample to 0–255 without a division per pixel. */
const GREY_SCALE = { 1: 255, 2: 85, 4: 17, 8: 1, 16: 1 };

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Buffer.from(bytes);
}

/** The Paeth predictor, verbatim from the PNG specification (RFC 2083 §6.6). */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG to `{ width, height, rgba }`, or `null` if we cannot.
 *
 * Handles: colour types 0/2/3/4/6, bit depths 1/2/4/8/16, all five scanline
 * filters, and palette transparency (`tRNS`). Declines: interlaced (Adam7)
 * images, and anything whose header does not add up.
 *
 * ⚠️ `maxPixels` IS A MEMORY GUARD, NOT AN AESTHETIC ONE. The RGBA buffer is
 * four bytes a pixel and the header is attacker-controlled in the sense that it
 * is whatever a tool wrote; a 30000×30000 header should be refused, not
 * allocated.
 */
export function decodePng(bytes, { maxPixels = 16_000_000 } = {}) {
  const b = asBuffer(bytes);
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  let plte = null;
  let trns = null;
  const idat = [];

  let pos = 8;
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos);
    // +12 = 4 length, 4 type, 4 CRC. A chunk claiming more than the file holds
    // is a truncated download, not a picture.
    if (len > b.length - pos - 12) return null;
    const type = b.toString('latin1', pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      if (len < 13) return null;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colourType = data[9];
      if (data[10] !== 0 || data[11] !== 0) return null; // compression / filter method
      interlace = data[12];
    } else if (type === 'PLTE') {
      plte = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  const channels = CHANNELS[colourType];
  if (!width || !height || !channels || !idat.length) return null;
  if (interlace !== 0) return null;                       // Adam7 — declined, not guessed
  if (![1, 2, 4, 8, 16].includes(depth)) return null;
  if (depth < 8 && colourType !== 0 && colourType !== 3) return null; // spec: only grey/palette
  if (colourType === 3 && !plte) return null;
  if (width * height > maxPixels) return null;

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  // Filtering operates on whole bytes: one byte for sub-8-bit rows, else the
  // full pixel width.
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil(width * channels * depth / 8);
  if (raw.length < height * (stride + 1)) return null;

  const lines = new Uint8Array(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    if (filter > 4) return null;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp + x];
      const a = x >= bpp ? lines[rowStart + x - bpp] : 0;
      const bb = y ? lines[prevStart + x] : 0;
      const c = y && x >= bpp ? lines[prevStart + x - bpp] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + bb;
      else if (filter === 3) v = cur + ((a + bb) >> 1);
      else v = cur + paeth(a, bb, c);
      lines[rowStart + x] = v & 0xFF;
    }
    rp += stride;
  }

  const rgba = new Uint8Array(width * height * 4);
  const mask = (1 << depth) - 1;
  const greyScale = GREY_SCALE[depth];

  /**
   * Read the `i`-th sample of the row starting at `rowStart`. 8- and 16-bit
   * samples come back as 0–255 (16-bit keeps the high byte — the low one is
   * below the precision of every terminal that will ever see this). Sub-byte
   * samples come back RAW, because there they are a grey LEVEL or a palette
   * INDEX, which are scaled or looked up respectively.
   */
  const sample = (rowStart, i) => {
    if (depth === 16) return lines[rowStart + i * 2];
    if (depth === 8) return lines[rowStart + i];
    const bit = i * depth;
    return (lines[rowStart + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
  };

  let o = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    for (let x = 0; x < width; x++) {
      const base = x * channels;
      let r;
      let g;
      let bl;
      let al = 255;
      if (colourType === 3) {
        const idx = sample(rowStart, base);
        if (idx * 3 + 2 >= plte.length) return null;
        r = plte[idx * 3];
        g = plte[idx * 3 + 1];
        bl = plte[idx * 3 + 2];
        if (trns && idx < trns.length) al = trns[idx];
      } else if (colourType === 0 || colourType === 4) {
        r = g = bl = sample(rowStart, base) * greyScale;
        if (colourType === 4) al = sample(rowStart, base + 1);
      } else {
        r = sample(rowStart, base);
        g = sample(rowStart, base + 1);
        bl = sample(rowStart, base + 2);
        if (colourType === 6) al = sample(rowStart, base + 3);
      }
      rgba[o++] = r;
      rgba[o++] = g;
      rgba[o++] = bl;
      rgba[o++] = al;
    }
  }

  return { width, height, rgba };
}

/**
 * Box-average downscale to fit within `maxWidth` × `maxHeight`.
 *
 * ⚠️ SIZE IS THE WHOLE GAME FOR SIXEL. Unlike kitty, where the terminal scales a
 * PNG for us, sixel output is roughly proportional to the pixel count — a 1440p
 * screenshot is megabytes of text crawling through a pty one byte at a time,
 * which stalls the session and scrolls everything useful away. Averaging rather
 * than nearest-neighbour costs a few lines and is the difference between
 * readable small text and aliased noise.
 *
 * Never upscales: a 40×40 favicon stays 40×40 rather than becoming a blurry wall.
 */
export function fitImage(image, maxWidth, maxHeight) {
  const { width, height, rgba } = image;
  const factor = Math.min(1, maxWidth / width, maxHeight / height);
  if (factor >= 1) return image;

  const w = Math.max(1, Math.round(width * factor));
  const h = Math.max(1, Math.round(height * factor));
  const out = new Uint8Array(w * h * 4);
  let o = 0;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * height / h);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * width / w);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let p = (sy * width + x0) * 4;
        for (let sx = x0; sx < x1; sx++) {
          r += rgba[p];
          g += rgba[p + 1];
          b += rgba[p + 2];
          a += rgba[p + 3];
          p += 4;
          n++;
        }
      }
      out[o++] = Math.round(r / n);
      out[o++] = Math.round(g / n);
      out[o++] = Math.round(b / n);
      out[o++] = Math.round(a / n);
    }
  }
  return { width: w, height: h, rgba: out };
}

/**
 * ⚠️ THE CEILINGS EXIST BECAUSE THE TERMINAL IS NOT A GALLERY.
 *
 * · kitty/iTerm2 take the file as-is, so the ceiling is the FILE size.
 * · sixel is re-encoded from pixels, so the file may be larger — but the decoded
 *   image is scaled down first and the ENCODED text is what actually travels.
 */
const MAX_INLINE_BYTES = 1_500_000;
const MAX_SIXEL_SOURCE_BYTES = 8_000_000;
const MAX_SIXEL_OUTPUT_BYTES = 2_000_000;

/** Default drawing box in pixels: about 100×28 cells on a typical font. */
export const SIXEL_MAX_WIDTH = 800;
export const SIXEL_MAX_HEIGHT = 480;

/**
 * Encode a PNG as a complete sixel escape sequence.
 *
 * Returns `{ seq, reason }` — exactly one of the two is set. `reason` is for the
 * caller to decide whether to say something out loud (`too-large`) or stay quiet
 * and let the file path do the work (`undecodable`).
 *
 * ⭐ `backgroundSelect = 1` — "no action on zero-bit positions" — so a PNG with
 * transparency shows the terminal's own background through it rather than a
 * black rectangle. The default of 0 is what makes screenshots of dark UIs look
 * like they have been cut out and pasted onto a card.
 */
export function sixelSequence(pngBytes, {
  maxWidth = SIXEL_MAX_WIDTH,
  maxHeight = SIXEL_MAX_HEIGHT,
  palette = PALETTE_ANSI_256,
  maxBytes = MAX_SIXEL_OUTPUT_BYTES,
} = {}) {
  /**
   * ⚠️ THE ENCODER READS RGBA BYTES AS UINT32. On a big-endian machine that
   * swaps every channel, so the honest answer there is a file path, not a
   * picture in the wrong colours.
   */
  if (BIG_ENDIAN) return { seq: null, reason: 'big-endian' };

  const image = decodePng(pngBytes);
  if (!image) return { seq: null, reason: 'undecodable' };

  const fitted = fitImage(image, maxWidth, maxHeight);
  let data;
  try {
    data = sixelEncode(fitted.rgba, fitted.width, fitted.height, palette);
  } catch {
    return { seq: null, reason: 'undecodable' };
  }
  if (!data) return { seq: null, reason: 'undecodable' };

  const seq = `${introducer(1)}${data}${FINALIZER}`;
  if (seq.length > maxBytes) return { seq: null, reason: 'too-large' };
  return { seq, reason: null };
}

/** The line we print when we could draw it but should not. */
function tooLarge(bytes) {
  return `  (${Math.round(bytes / 1024)}KB — too large to show inline; open the file)`;
}

/**
 * Render an image file into the terminal if we can, and say what we did.
 *
 * Returns `{ shown, text }` — `text` is always safe to print, so the caller
 * never needs to know which branch it took. Never throws: a picture failing to
 * display must not end a coding session.
 */
export function renderImage(absolutePath, { env = process.env, isTTY = process.stdout.isTTY, readImpl = readFileSync } = {}) {
  const protocol = detectImageProtocol(env, { isTTY });
  if (!protocol) return { shown: false, text: null };

  let bytes;
  try {
    bytes = readImpl(absolutePath);
  } catch {
    // The path is printed by the caller regardless; a missing file here is not
    // this function's problem to report.
    return { shown: false, text: null };
  }

  if (protocol === SIXEL_PROTOCOL) {
    if (bytes.length > MAX_SIXEL_SOURCE_BYTES) return { shown: false, text: tooLarge(bytes.length) };
    const { seq, reason } = sixelSequence(bytes);
    if (seq) return { shown: true, text: `${seq}\n` };
    /**
     * ⚠️ ONLY ONE OF THESE SPEAKS. "Too large" is a decision the user can act on
     * — open the file. "Undecodable" is us, not them: an interlaced PNG or a
     * JPEG is our limitation and announcing it in the middle of a coding session
     * would be noise about a feature they did not ask for.
     */
    return { shown: false, text: reason === 'too-large' ? tooLarge(bytes.length) : null };
  }

  if (bytes.length > MAX_INLINE_BYTES) {
    return { shown: false, text: tooLarge(bytes.length) };
  }

  const seq = protocol === KITTY_PROTOCOL
    ? kittySequence(bytes)
    : itermSequence(bytes, { name: absolutePath.split(/[\\/]/).pop() });

  // A newline after the sequence, or the next line of output lands on top of
  // the image — which looks exactly like a rendering bug and is not one.
  return { shown: true, text: `${seq}\n` };
}
