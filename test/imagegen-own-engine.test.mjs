/**
 * ── ⭐⭐ OUR OWN GPU IS THE PRIMARY IMAGE ENGINE ─────────────────────────────
 *
 * Measured live 2026-08-12 before any of this was written: A10G,
 * segmind/SSD-1B, 1024×1024 PNG in **8.8–10.5s warm, 13.1s cold**, 1.0–1.8MB,
 * and the pictures are genuinely good — correct bicycle spoke and chain
 * geometry, a usable corporate headshot.
 *
 * It was the THIRD leg of the chain. It is now the first, because the two ahead
 * of it are no longer dependable: Perchance answers `{"status":"not_verified"}`
 * behind a human verification wall (our own headless browser hung on it and had
 * to be aborted at 150s), and Pollinations throttles from 2.6s to 45s under
 * real use. Ours cannot be walled off by anyone.
 *
 * ⚠️ THE 60s TIMEOUT IS WHY IT LOOKED DEAD FOR A WEEK. A cold container spends
 * its first seconds pulling 4.5GB of weights; the caller aborted before the GPU
 * finished waking, and a WORKING engine reported as unreachable. The failure was
 * never in the model — it was in the caller's patience.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateViaOwnEngine,
  generateThroughProviders,
  engineConfig,
  ENGINE_SECRET_ENV,
  ENGINE_URL_ENV,
  DEFAULT_ENGINE_URL,
} from '../lib/imagegen.mjs';

/**
 * ⚠️ BIG ENOUGH TO BE ACCEPTED, ON PURPOSE. A valid but tiny 1×1 PNG is
 * correctly REJECTED by the fallback leg's size check, so a fixture that used
 * one made a passing chain look like a failing one — the test was wrong and the
 * code was right, which is the most expensive way round for this to happen.
 */
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'),
  Buffer.alloc(4096, 0x7a),
  Buffer.from('0000000049454e44ae426082', 'hex'),
]);
const b64 = `${PNG.toString('base64')}${'A'.repeat(200)}`;

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-img-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/**
 * ⚠️ `arrayBuffer` IS ON HERE BECAUSE THE FALLBACK LEG READS BYTES, NOT JSON.
 * My first fixture had only `json`/`text`, so the moment a test let the chain
 * fall through to Pollinations it died with "res.arrayBuffer is not a function"
 * — a fixture failure wearing the costume of a code failure. A stub has to
 * satisfy EVERY leg the call might reach, not the one you had in mind.
 */
const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'image/png' : null) },
  json: async () => body,
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
});

const ENV = { [ENGINE_SECRET_ENV]: 'shh' };

/* ── configuration ────────────────────────────────────────────────────────── */

test('the endpoint has a built-in default, so only the secret must be supplied', () => {
  const cfg = engineConfig({ [ENGINE_SECRET_ENV]: 'shh' });
  assert.equal(cfg.base, DEFAULT_ENGINE_URL);
  assert.equal(cfg.configured, true);
});

test('⚠️ it FAILS SHUT with no secret — a paid GPU must never default to open', async () => {
  const ws = workspace();
  try {
    const r = await generateViaOwnEngine({ prompt: 'x', executor: ws, env: {}, fetchImpl: () => { throw new Error('must not be called'); } });
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(ENGINE_SECRET_ENV));
    assert.match(r.reason, /dark/, 'unconfigured is DARK, not broken — the distinction is the whole doctor');
  } finally { ws.cleanup(); }
});

test('an explicitly empty URL turns the engine off, overriding the default', () => {
  assert.equal(engineConfig({ [ENGINE_URL_ENV]: '', [ENGINE_SECRET_ENV]: 'shh' }).configured, false);
});

/* ── the success path ─────────────────────────────────────────────────────── */

test('⭐ a real render is written to disk and labelled as OURS', async () => {
  const ws = workspace();
  try {
    const r = await generateViaOwnEngine({
      prompt: 'a red bicycle',
      executor: ws,
      env: ENV,
      fetchImpl: async () => jsonRes({ ok: true, image_b64: b64, format: 'png', width: 1024, height: 1024, model: 'segmind/SSD-1B', render_ms: 5192 }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'acuvo-gpu', 'the caller must be able to tell WHOSE model drew this');
    assert.equal(r.model, 'segmind/SSD-1B');
    assert.equal(r.renderMs, 5192);
    assert.ok(existsSync(join(ws.root, r.path)), 'the file was reported but not written');
    assert.ok(readFileSync(join(ws.root, r.path)).length > 0);
  } finally { ws.cleanup(); }
});

test('⚠️ the secret is sent in the HEADER and in the BODY', async () => {
  /**
   * ⚠️ The service accepts either. Sending only the header means a proxy that
   * strips `Authorization` turns a working call into an unexplainable 401 —
   * and 401 from our own service is the last thing anyone would think to debug.
   */
  const ws = workspace();
  let seen = null;
  try {
    await generateViaOwnEngine({
      prompt: 'x',
      executor: ws,
      env: ENV,
      fetchImpl: async (url, init) => { seen = { url, init }; return jsonRes({ ok: true, image_b64: b64 }); },
    });
    assert.match(seen.url, /\/generate-image$/, 'the canonical route, not the alias');
    assert.equal(seen.init.headers.authorization, 'Bearer shh');
    assert.equal(JSON.parse(seen.init.body).secret, 'shh');
  } finally { ws.cleanup(); }
});

/* ── ⚠️⚠️ the failure that arrives as HTTP 200 ────────────────────────────── */

test('⚠️⚠️ a 200 carrying ok:false is a FAILURE, and writes nothing', async () => {
  /**
   * ⚠️ VERIFIED AGAINST THE LIVE SERVICE by sending the wrong secret: it
   * answers **HTTP 200** with `{"ok":false,"error":"unauthorised"}`. Reading
   * `res.ok` alone would have written a zero-byte PNG and called it a render.
   *
   * ⭐ `res.ok` answers a question about the HTTP CONVERSATION, never about
   * whether the work happened. That single confusion has cost this codebase
   * more time than any other bug class.
   */
  const ws = workspace();
  try {
    const r = await generateViaOwnEngine({
      prompt: 'x', executor: ws, env: ENV,
      fetchImpl: async () => jsonRes({ ok: false, error: 'unauthorised' }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /unauthorised/);
    assert.equal(readdirSync(ws.root).length, 0, 'a failed render must leave NOTHING on disk');
  } finally { ws.cleanup(); }
});

test('⚠️ a 200 with no image is a failure, not an empty image', async () => {
  const ws = workspace();
  try {
    const r = await generateViaOwnEngine({ prompt: 'x', executor: ws, env: ENV, fetchImpl: async () => jsonRes({ ok: true }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /returned no image/);
    assert.equal(readdirSync(ws.root).length, 0);
  } finally { ws.cleanup(); }
});

test('a non-2xx status is reported with its code', async () => {
  const ws = workspace();
  try {
    const r = await generateViaOwnEngine({ prompt: 'x', executor: ws, env: ENV, fetchImpl: async () => jsonRes({ error: 'boom' }, 502) });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 502/);
  } finally { ws.cleanup(); }
});

test('a body that is not JSON is reported as such, not as a crash', async () => {
  const ws = workspace();
  try {
    const r = await generateViaOwnEngine({
      prompt: 'x', executor: ws, env: ENV,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); }, text: async () => '<html>' }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /not JSON/);
  } finally { ws.cleanup(); }
});

/* ── the chain order ──────────────────────────────────────────────────────── */

test('⭐⭐ our own GPU is tried FIRST, before any rented endpoint', async () => {
  const ws = workspace();
  const hits = [];
  try {
    const r = await generateThroughProviders({
      prompt: 'x', executor: ws, env: ENV,
      fetchImpl: async (url) => { hits.push(String(url)); return jsonRes({ ok: true, image_b64: b64, model: 'segmind/SSD-1B' }); },
    });
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'acuvo-gpu');
    assert.equal(hits.length, 1, 'a successful first leg must not call anything else');
    assert.match(hits[0], /image-engine|generate-image/);
  } finally { ws.cleanup(); }
});

test('⚠️ when our engine is DARK the chain moves on without blaming it', async () => {
  /**
   * ⚠️ An unconfigured leg is not a failure to report. A chain that announces
   * every dark provider trains the reader to skip the line where a real one
   * finally does fail.
   */
  const ws = workspace();
  try {
    const r = await generateThroughProviders({
      prompt: 'x', executor: ws, env: { [ENGINE_URL_ENV]: '' },
      fetchImpl: async () => jsonRes({ ok: true, image_b64: b64 }),
    });
    assert.equal(r.ok, true);
    assert.notEqual(r.provider, 'acuvo-gpu');
    assert.equal(
      /ACUVO_IMAGE_SECRET/.test(String(r.fellBackFrom ?? '')),
      false,
      'a dark leg must not be reported as the reason a later leg was used',
    );
  } finally { ws.cleanup(); }
});
