/**
 * ── THE RENTED BACKEND, PROVEN WITHOUT A BALANCE ────────────────────────────
 *
 * ⚠️ EVERY TEST HERE IS OFFLINE. The FAL account is locked (403 "User is
 * locked. Reason: Exhausted balance."), and even if it were not, a scored test
 * run must never spend. `fetchImpl` is injected everywhere; a real `fetch` in
 * this file would be a defect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  falConfig, falUnavailable, classifyFalFailure, extractAssetUrl, readQueueStatus,
  runFalJob, FAL_MODELS, MIN_PLAUSIBLE_BYTES,
} from '../lib/fal.mjs';

const KEY_ONLY = { FAL_KEY: 'k'.repeat(69) };
const FUNDED = { ...KEY_ONLY, FAL_ACCOUNT_FUNDED: '1' };

const never = async () => { throw new Error('the network must not be reached'); };

/* ── the two gates ───────────────────────────────────────────────────────── */

test('⚠️⚠️ a key is not a balance — the two gates are separate and say different things', () => {
  assert.equal(falConfig({}).usable, false);
  assert.equal(falConfig(KEY_ONLY).usable, false, 'a key on an empty account is not usable');
  assert.equal(falConfig(FUNDED).usable, true);
});

test('⭐⭐⭐ a locked account says OUT OF BALANCE, not "not configured" and not a bare 403', () => {
  /**
   * The exact failure this module exists for. The console adapter turns the same
   * state into "rejected the request (HTTP 403)", which sends the reader to
   * check the key, the slug and the payload — none of which is wrong. Fifty-one
   * engines are dark for ONE unpaid bill.
   */
  const r = falUnavailable('video', KEY_ONLY);
  assert.equal(r.code, 'fal_out_of_balance');
  assert.equal(r.remedy, 'top-up-fal');
  assert.match(r.error, /out of balance/i);
  assert.match(r.error, /Exhausted balance/, 'quote what FAL itself says, so the symptom is recognisable');
  assert.match(r.error, /nothing was charged/i);
  assert.doesNotMatch(r.error, /not configured|set FAL_KEY/i, 'telling somebody to set a key that is already set is the bug this replaces');
});

test('⚠️ NO key and NO balance are opposite problems with opposite remedies', () => {
  const noKey = falUnavailable('video', {});
  assert.equal(noKey.code, 'fal_no_key');
  assert.equal(noKey.remedy, 'set-fal-key');
  assert.notEqual(noKey.remedy, falUnavailable('video', KEY_ONLY).remedy);
});

test('⭐ a funded, wired capability is not refused at all', () => {
  assert.equal(falUnavailable('video', FUNDED), null);
  assert.equal(falUnavailable('lipsync', FUNDED), null);
});

test('⚠️ a capability with no wired model is named as OUR gap, and lists what is wired', () => {
  const r = falUnavailable('interpretive-dance', FUNDED);
  assert.equal(r.code, 'fal_no_model');
  for (const k of Object.keys(FAL_MODELS)) assert.match(r.error, new RegExp(k.replace(/[-]/g, '[-]')));
});

/* ── reading what FAL actually said ──────────────────────────────────────── */

test('⭐⭐ 401 and 403 are classified apart — a bad key is not an empty wallet', () => {
  const locked = classifyFalFailure(403, '{"detail":"User is locked. Reason: Exhausted balance."}');
  assert.equal(locked.code, 'fal_out_of_balance');
  assert.equal(locked.remedy, 'top-up-fal');

  const badKey = classifyFalFailure(401, '{"detail":"Unauthorized"}');
  assert.equal(badKey.code, 'fal_bad_key');
  assert.equal(badKey.remedy, 'set-fal-key');
  assert.notEqual(badKey.remedy, locked.remedy, 'the next action differs and one of them costs money');
});

test('⚠️ an exhausted-balance body is caught even behind an unexpected status code', () => {
  /**
   * The funded flag is a human assertion and goes stale. If the balance runs out
   * mid-session we must not fall back to "HTTP 500", which is the generic answer
   * this whole module exists to avoid.
   */
  const r = classifyFalFailure(500, 'insufficient credits for this request');
  assert.equal(r.code, 'fal_out_of_balance');
});

test('⭐ a 404 blames OUR unverified slug rather than the user', () => {
  const r = classifyFalFailure(404, 'not found');
  assert.equal(r.code, 'fal_no_such_model');
  assert.match(r.error, /NEVER been run/i, 'the slugs are mirrored data, not verified knowledge — say so');
});

test('⚠️ a rate limit is the one failure worth retrying, and says so', () => {
  const r = classifyFalFailure(429, 'slow down');
  assert.equal(r.code, 'fal_rate_limited');
  assert.match(r.error, /worth retrying/i);
});

/* ── payload shapes ──────────────────────────────────────────────────────── */

test('⭐ the asset URL is found in every shape our own catalogue produces', () => {
  assert.equal(extractAssetUrl({ images: [{ url: 'https://a/1.png' }] }), 'https://a/1.png');
  assert.equal(extractAssetUrl({ video: { url: 'https://a/1.mp4' } }), 'https://a/1.mp4');
  assert.equal(extractAssetUrl({ audio: { url: 'https://a/1.wav' } }), 'https://a/1.wav');
  assert.equal(extractAssetUrl({ url: 'https://a/bare.png' }), 'https://a/bare.png');
  assert.equal(extractAssetUrl({ nothing: 1 }), null);
});

test('⚠️ a non-http string is not an asset — a relative path would be written as bytes', () => {
  assert.equal(extractAssetUrl({ url: '/tmp/not-a-url' }), null);
});

test('⭐ queue states: only COMPLETED is done, and IN_PROGRESS is not failure', () => {
  assert.equal(readQueueStatus({ status: 'IN_QUEUE' }).state, 'running');
  assert.equal(readQueueStatus({ status: 'IN_PROGRESS' }).state, 'running');
  assert.equal(readQueueStatus({ status: 'COMPLETED' }).state, 'done');
  assert.equal(readQueueStatus({ status: 'ERROR' }).state, 'failed');
  assert.equal(readQueueStatus({}).state, 'failed');
});

/* ── the whole path, mocked ──────────────────────────────────────────────── */

function mockFal({ submitStatus = 200, bytes = MIN_PLAUSIBLE_BYTES + 10, polls = 1 } = {}) {
  let seen = 0;
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {} });
      if (String(url).endsWith('/status')) {
        seen += 1;
        return { ok: true, status: 200, json: async () => ({ status: seen < polls ? 'IN_PROGRESS' : 'COMPLETED' }) };
      }
      if (String(url).startsWith('https://cdn')) {
        return {
          ok: true, status: 200,
          headers: { get: (k) => (k === 'content-length' ? String(bytes) : 'video/mp4') },
          arrayBuffer: async () => new Uint8Array(bytes).buffer,
        };
      }
      if (init.method === 'POST') {
        if (submitStatus !== 200) {
          return { ok: false, status: submitStatus, text: async () => '{"detail":"User is locked. Reason: Exhausted balance."}' };
        }
        return { ok: true, status: 200, json: async () => ({ request_id: 'req-1' }) };
      }
      return { ok: true, status: 200, json: async () => ({ video: { url: 'https://cdn/x.mp4' } }) };
    },
  };
}

test('⭐⭐ submit → poll → fetch, end to end, with the key in the FAL header shape', async () => {
  const m = mockFal({ polls: 2 });
  const r = await runFalJob({ capability: 'video', input: { prompt: 'x' }, env: FUNDED, fetchImpl: m.fetchImpl, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.slug, FAL_MODELS.video.slug);
  assert.ok(r.base64.length > 0);
  assert.match(m.calls[0].url, /^https:\/\/queue\.fal\.run\//);
  assert.equal(m.calls[0].headers.authorization, `Key ${FUNDED.FAL_KEY}`, 'FAL takes "Key <k>", not "Bearer <k>" — the auth mistake this repo has already paid for once');
});

test('⭐⭐⭐ a locked account is refused BEFORE a request is sent — the cheapest check first', async () => {
  const r = await runFalJob({ capability: 'video', input: {}, env: KEY_ONLY, fetchImpl: never });
  assert.equal(r.code, 'fal_out_of_balance');
});

test('⚠️ a live 403 is still classified, because the funded flag can be stale', async () => {
  const m = mockFal({ submitStatus: 403 });
  const r = await runFalJob({ capability: 'video', input: {}, env: FUNDED, fetchImpl: m.fetchImpl, sleep: async () => {} });
  assert.equal(r.code, 'fal_out_of_balance');
  assert.match(r.error, /Exhausted balance/);
});

test('⚠️⚠️ a tiny artifact is a FAILURE, not an empty success', async () => {
  /**
   * This package has already shipped a zero-byte PNG and called it a render. A
   * short body from a CDN is an error page wearing a content-type.
   */
  const m = mockFal({ bytes: 10 });
  const r = await runFalJob({ capability: 'video', input: {}, env: FUNDED, fetchImpl: m.fetchImpl, sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'fal_artifact_too_small');
});

test('⚠️ a timeout reports the request_id, because the render carries on being charged', async () => {
  const m = mockFal({ polls: 999 });
  let t = 0;
  const r = await runFalJob({
    capability: 'video', input: {}, env: FUNDED, fetchImpl: m.fetchImpl,
    sleep: async () => { t += 60_000; }, now: () => t, budgetMs: 120_000,
  });
  assert.equal(r.code, 'fal_timeout');
  assert.match(r.error, /req-1/);
});
