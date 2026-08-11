/**
 * ── PINNING A PRIVATE API SO ITS BREAKAGE IS DIAGNOSABLE ────────────────────
 *
 * `perchance.mjs` talks to an undocumented endpoint through a TLS fingerprint a
 * CDN may stop honouring. It WILL break. The question these tests answer is not
 * "does it work" — the live path already proved that — but "when it breaks, will
 * the error tell the next person what happened".
 *
 * ⚠️ Every response fixture below was captured from the real service today, not
 * invented. Being wrong about the shape is the entire failure mode: my first
 * attempt sent a GET with correct fields and got `invalid_parameter`, and my
 * second built a polling loop for a queue that a fresh caller never enters.
 *
 * No network. Everything is stubbed at the request boundary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyUser, requestGeneration, downloadImage, awaitImage, generateNative } from '../lib/perchance.mjs';

/** The real verifyUser reply. */
const VERIFY_OK = { ok: true, status: 200, json: { status: 'already_verified', userKey: 'ce8d1c59194b86e0a517c0f7d1276bc2e7144de5aaacd45f1baea65f8a1e7cf1' } };

/** The real generate reply — note it is SYNCHRONOUS and carries everything. */
const GENERATE_OK = {
  ok: true,
  status: 200,
  json: {
    status: 'success',
    imageId: '2a30324a8900e953f5b5d862fd8c924a1acb8afbb8f91264d1d817b435344f7f',
    fileExtension: 'jpeg',
    seed: 760211433,
    prompt: 'a red rowboat',
    width: 768,
    height: 768,
    maybeNsfw: false,
    imageDownloadUrl: '/api/downloadTemporaryImageViaProxy?t=v1.Q3MZeePtW2wPGWh0.signed-token-here',
  },
};

const JPEG = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(60_000, 7)]);
const stub = (value) => async () => value;

test('verifyUser returns a key from the real reply shape', async () => {
  const r = await verifyUser({ requestImpl: stub(VERIFY_OK) });
  assert.equal(r.ok, true);
  assert.equal(r.userKey.length, 64);
  assert.equal(r.status, 'already_verified');
});

/**
 * ⚠️ A CHALLENGE IS NOT A 403 AND MUST NOT READ LIKE ONE. A 403 suggests
 * credentials; a challenge means the fingerprint stopped passing and no
 * credential, retry or key will change it. Conflating them sends the next
 * person hunting for an auth bug that does not exist.
 */
test('a bot challenge is reported as a challenge', async () => {
  const r = await verifyUser({ requestImpl: stub({ ok: false, status: 403, challenged: true, error: 'the host served a bot challenge' }) });
  assert.equal(r.ok, false);
  assert.equal(r.challenged, true);
});

test('a reply without a usable key is refused, not passed on as empty', async () => {
  const r = await verifyUser({ requestImpl: stub({ ok: true, status: 200, json: { status: 'ok' } }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /no usable key/);
});

/**
 * ⚠️⭐ THE FIELD THAT COST ME NINETY SECONDS. The POST reply already contains
 * imageDownloadUrl; I read only `status` and then polled a queue the caller
 * never enters, reading `not_in_queue` until the budget ran out. If a future
 * edit drops these fields again, this goes red.
 */
test('generate keeps every field from the synchronous reply', async () => {
  const r = await requestGeneration({ prompt: 'a red rowboat', userKey: 'k'.repeat(64), requestImpl: stub(GENERATE_OK) });
  assert.equal(r.ok, true);
  assert.ok(r.downloadPath, 'downloadPath must survive — the image is ready in THIS reply');
  assert.equal(r.imageId.length, 64);
  assert.equal(r.seed, 760211433);
  assert.equal(r.maybeNsfw, false);
});

test('generate sends a POST with a JSON body, not a GET with query params', async () => {
  let seen = null;
  await requestGeneration({
    prompt: 'x', userKey: 'k'.repeat(64),
    requestImpl: async (url, opts) => { seen = { url, opts }; return GENERATE_OK; },
  });
  // The verb was the whole bug: every field was right and the request was wrong.
  assert.equal(seen.opts.method, 'POST');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.channel, 'ai-text-to-image-generator');
  assert.equal(body.subChannel, 'public');
  assert.equal(body.seed, -1);
  assert.ok(seen.url.includes('userKey='), 'the key rides in the query too — the service checks both');
});

/**
 * ⚠️ OUR BUG, NOT THEIR OUTAGE, and the message has to say so. `invalid_parameter`
 * means the shape drifted; the endpoint is answering fine. Telling a model to
 * retry that would burn a round budget on a request that can never succeed.
 */
test('invalid_parameter is named as a contract break and forbids retrying', async () => {
  const r = await requestGeneration({
    prompt: 'x', userKey: 'k'.repeat(64),
    requestImpl: stub({ ok: true, status: 200, json: { status: 'invalid_parameter' } }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /needs re-capturing/);
  assert.match(r.error, /retrying will not help/);
});

test('the download url comes from the response, never rebuilt from an imageId', async () => {
  let requested = null;
  await downloadImage({
    downloadPath: '/api/downloadTemporaryImageViaProxy?t=v1.SIGNED',
    requestImpl: async (url) => { requested = url; return { ok: true, status: 200, body: JPEG }; },
  });
  // Reconstructing it drops the signature and fails the next time they rotate it.
  assert.match(requested, /t=v1\.SIGNED/);
  assert.ok(requested.startsWith('https://image-generation.perchance.org'));
});

test('a 200 that is not an image is refused', async () => {
  const html = Buffer.from('<html>rate limited</html>'.repeat(80));
  const r = await downloadImage({ downloadPath: '/x', requestImpl: stub({ ok: true, status: 200, body: html }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /not an image/);
});

test('a missing download path is an error, not a silent empty file', async () => {
  const r = await downloadImage({ downloadPath: null });
  assert.equal(r.ok, false);
});

/**
 * ⚠️ THE POLL IS BOUNDED BY WALL CLOCK. A queue stuck at "position 4" is
 * indistinguishable from a broken one, and an unbounded poll inside a coding
 * agent's round is how a whole session disappears — which is exactly what
 * happened to me before the bound existed.
 */
test('the queue fallback gives up on a budget and says what it last saw', async () => {
  let calls = 0;
  const r = await awaitImage({
    userKey: 'k', requestId: '1', budgetMs: 60,
    requestImpl: async () => { calls += 1; return { ok: true, status: 200, json: { status: 'not_in_queue' } }; },
    sleepImpl: async () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /not_in_queue/);
  assert.match(r.error, /use another provider/);
  assert.ok(calls > 0);
});

test('technical difficulties on their side are distinguished from our failure', async () => {
  const r = await awaitImage({
    userKey: 'k', requestId: '1', budgetMs: 5000,
    requestImpl: stub({ ok: true, status: 200, json: { status: 'waiting', havingTechnicalDifficulties: true } }),
    sleepImpl: async () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /on its own side/);
  assert.match(r.error, /not our request/);
});

test('an empty prompt never reaches the network', async () => {
  const r = await generateNative({ prompt: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /needs a prompt/);
});
