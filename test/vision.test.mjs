/**
 * ── ⭐⭐ EYES ────────────────────────────────────────────────────────────────
 *
 * Proven live 2026-08-12 before these tests were written: pointed at a generated
 * neon-street image whose signage is pseudo-Japanese, `read_image` answered
 * "**The text in this image is NOT readable or correctly spelled real language.
 * It is garbled**" and explained why. 16.4s, **$0.00008**, qwen3.7-flash.
 *
 * ⚠️⚠️ THE ONE BEHAVIOUR THIS MODULE MUST NEVER HAVE is producing a plausible
 * sentence about an image it did not receive. The coder model is text-only;
 * handed an image it answers anyway, from the filename and the surrounding
 * conversation, in fluent confident prose. A hallucinated "the layout looks
 * clean" about a page nobody rendered is worse than silence — it ENDS the
 * investigation with a false all-clear. Most of the tests below exist to pin
 * that, not to check the happy path.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readImage,
  sniffImage,
  imageSize,
  estimateLookTokens,
  resetVisionState,
  visionToolSchemas,
  MAX_IMAGE_BYTES,
  MAX_LOOKS_PER_PROCESS,
} from '../lib/vision.mjs';

/* ── fixtures built byte by byte, because the parsers read bytes ──────────── */

function png(width, height, pad = 2048) {
  const head = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(head, 0);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(pad, 0x5a)]);
}

/**
 * ⚠️ A REAL SEGMENT WALK, NOT A FIXED OFFSET. JPEG puts its dimensions in
 * whichever SOF marker turns up, after any number of EXIF/comment segments of
 * arbitrary length — so this fixture deliberately puts a fat APP0 in front of
 * the SOF0. A parser that assumes an offset reports a 6000x4000 photo as 2x19029.
 */
function jpeg(width, height, appLen = 300) {
  const app = Buffer.alloc(2 + appLen);
  app.writeUInt16BE(0xffe0, 0);
  const appBody = Buffer.alloc(appLen, 0x11);
  appBody.writeUInt16BE(appLen, 0);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2);       // segment length
  sof.writeUInt8(8, 4);          // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from('ffd8', 'hex'), app.slice(0, 2), appBody, sof, Buffer.alloc(2048, 0x33)]);
}

const gif = (w, h) => {
  const b = Buffer.alloc(2048, 0x21);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
};

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-vis-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const reply = (content, { status = 200, cost = 0.00008 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ choices: [{ message: { content } }], usage: { cost } }),
  text: async () => 'body',
});

const KEY = { apiKey: 'sk-or-v1-test' };

test.beforeEach(() => resetVisionState());

/* ── the byte parsers ─────────────────────────────────────────────────────── */

test('formats are sniffed from magic bytes, not the extension', () => {
  assert.equal(sniffImage(png(1, 1)), 'image/png');
  assert.equal(sniffImage(jpeg(1, 1)), 'image/jpeg');
  assert.equal(sniffImage(gif(1, 1)), 'image/gif');
  assert.equal(sniffImage(Buffer.from('<!doctype html><html></html>')), null);
});

test('PNG and GIF dimensions are read from their fixed offsets', () => {
  assert.deepEqual(imageSize(png(1024, 768)), { width: 1024, height: 768 });
  assert.deepEqual(imageSize(gif(320, 240)), { width: 320, height: 240 });
});

test('⚠️ JPEG dimensions survive a fat segment in front of the SOF marker', () => {
  assert.deepEqual(imageSize(jpeg(1920, 1080, 400)), { width: 1920, height: 1080 });
  assert.deepEqual(imageSize(jpeg(640, 480, 4)), { width: 640, height: 480 });
});

test('an unparseable size returns null so the caller says "unknown" instead of inventing one', () => {
  assert.equal(imageSize(Buffer.from('not an image at all, really')), null);
  assert.equal(estimateLookTokens(null), null);
});

test('the token estimate is derived from pixels, which is how vision is billed', () => {
  assert.equal(estimateLookTokens({ width: 1024, height: 1024 }), Math.ceil((1024 * 1024) / 750));
});

/* ── ⚠️⚠️ abstention: the tests that matter ──────────────────────────────── */

test('⚠️⚠️ with no API key it REFUSES and forbids describing from the filename', async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, 'hero.png'), png(64, 64));
    const r = await readImage({ root: ws.root, path: 'hero.png', apiKey: '', fetchImpl: () => { throw new Error('must not be called'); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /say you could not see it/i, 'the refusal must tell the model what to do INSTEAD, or it invents');
  } finally { ws.cleanup(); }
});

test('⚠️⚠️ an EMPTY reply inside a 200 is a failure, not an empty description', async () => {
  /**
   * ⚠️ THE FIFTH PLACE THIS EXACT BUG HAS APPEARED — model.mjs, media.mjs,
   * transcribe, the image engine, and now here. Measured cause on this account:
   * a reasoning model spends its whole max_tokens budget thinking (15,999
   * reasoning tokens, empty content). An empty reply from a vision model is
   * indistinguishable from "I looked and saw nothing" unless it is refused.
   */
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, 'a.png'), png(64, 64));
    for (const empty of ['', '   ', null, undefined]) {
      const r = await readImage({ root: ws.root, path: 'a.png', ...KEY, fetchImpl: async () => reply(empty) });
      assert.equal(r.ok, false, `an empty reply (${JSON.stringify(empty)}) was treated as a description`);
      assert.match(r.error, /Do not describe it/i);
      resetVisionState();
    }
  } finally { ws.cleanup(); }
});

test('a transport failure abstains and says not to describe the image', async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, 'a.png'), png(64, 64));
    const r = await readImage({ root: ws.root, path: 'a.png', ...KEY, fetchImpl: async () => { throw new Error('socket hang up'); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /unable to look/i);
  } finally { ws.cleanup(); }
});

test('a non-2xx is reported with its status', async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, 'a.png'), png(64, 64));
    const r = await readImage({ root: ws.root, path: 'a.png', ...KEY, fetchImpl: async () => reply('x', { status: 429 }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 429/);
  } finally { ws.cleanup(); }
});

/* ── inputs that are not images ───────────────────────────────────────────── */

test('⚠️ a file that is not an image is named by WHAT IT IS, not "unsupported"', async () => {
  /**
   * ⚠️ "unsupported format" sends the model round the same loop. Saying the
   * bytes match no image format tells it the file is probably an error page or
   * a truncated download — which is what it usually is.
   */
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, 'shot.png'), '<html>503 Service Unavailable</html>');
    const r = await readImage({ root: ws.root, path: 'shot.png', ...KEY, fetchImpl: () => { throw new Error('must not be called'); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /error page|truncated|not an image/i);
  } finally { ws.cleanup(); }
});

test('a missing file says so and names how to find the real one', async () => {
  const ws = workspace();
  try {
    const r = await readImage({ root: ws.root, path: 'nope.png', ...KEY });
    assert.equal(r.ok, false);
    assert.match(r.error, /no such file/i);
    assert.match(r.error, /list_dir/, 'a refusal that names the next tool costs one round instead of three');
  } finally { ws.cleanup(); }
});

test('⚠️ a path outside the workspace is refused, exactly like every other read', async () => {
  const ws = workspace();
  try {
    const r = await readImage({ root: ws.root, path: '../../etc/passwd', ...KEY });
    assert.equal(r.ok, false);
    assert.equal(/^no such file/i.test(r.error), false, 'this must be refused as a path, not as a missing file');
  } finally { ws.cleanup(); }
});

test('⚠️ an oversized image is refused with the number and a way forward', async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, 'huge.png'), png(8000, 8000, MAX_IMAGE_BYTES + 1024));
    const r = await readImage({ root: ws.root, path: 'huge.png', ...KEY, fetchImpl: () => { throw new Error('must not be called'); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /MB/);
    assert.match(r.error, /cannot resize/, 'zero dependencies means no image library — say so rather than failing vaguely');
  } finally { ws.cleanup(); }
});

/* ── the happy path, and the cap ──────────────────────────────────────────── */

test('⭐ a real look returns the text, the model, the size and the cost', async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, 'hero.png'), png(1024, 768));
    let sent = null;
    const r = await readImage({
      root: ws.root, path: 'hero.png', question: 'is the heading spelled correctly?', ...KEY,
      fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return reply('The heading reads "Acuvo" and is spelled correctly.'); },
    });
    assert.equal(r.ok, true);
    assert.match(r.text, /spelled correctly/);
    assert.equal(r.width, 1024);
    assert.equal(r.height, 768);
    assert.equal(r.costUsd, 0.00008);

    const parts = sent.messages[0].content;
    assert.equal(parts[0].text, 'is the heading spelled correctly?');
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,/, 'the image must actually be attached');
    assert.equal(sent.reasoning.enabled, false, 'reasoning ON spends the whole token budget and returns nothing');
  } finally { ws.cleanup(); }
});

test('with no question it still asks for defects to be called out', async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, 'a.png'), png(64, 64));
    let sent = null;
    await readImage({ root: ws.root, path: 'a.png', ...KEY, fetchImpl: async (u, i) => { sent = JSON.parse(i.body); return reply('ok'); } });
    assert.match(sent.messages[0].content[0].text, /broken|misaligned|garbled/i);
    assert.match(sent.messages[0].content[0].text, /do not speculate/i);
  } finally { ws.cleanup(); }
});

test('⚠️ the per-run cap refuses and says looking again will not help', async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws.root, 'a.png'), png(64, 64));
    const look = () => readImage({ root: ws.root, path: 'a.png', ...KEY, fetchImpl: async () => reply('fine') });
    for (let i = 0; i < MAX_LOOKS_PER_PROCESS; i += 1) assert.equal((await look()).ok, true);
    const over = await look();
    assert.equal(over.ok, false);
    assert.match(over.error, /act on what you saw/);
  } finally { ws.cleanup(); }
});

test('the schema tells the model it cannot see, and forbids describing from the filename', () => {
  const [s] = visionToolSchemas();
  assert.equal(s.function.name, 'read_image');
  assert.match(s.function.description, /You cannot see images yourself/);
  assert.match(s.function.description, /never describe the image from its filename/);
  assert.deepEqual(s.function.parameters.required, ['path']);
});
