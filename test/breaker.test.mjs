/**
 * The breaker decides to DISABLE a capability, so being wrong about it is worse
 * than not having it. These tests pin the two directions separately, because
 * they fail for opposite reasons: not tripping wastes minutes, and tripping too
 * eagerly silently removes a working tool for the rest of the run.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { throughBreaker, deadReason, markUnreachable, skipMessage, resetBreakers } from '../lib/breaker.mjs';
import { seePage } from '../lib/media.mjs';

const URL_A = 'https://example.invalid/a';
const URL_B = 'https://example.invalid/b';

beforeEach(() => resetBreakers());

test('a timeout trips it, and the second call never runs', async () => {
  let attempts = 0;
  const timeout = () => {
    attempts += 1;
    const e = new Error('aborted');
    e.name = 'TimeoutError';
    throw e;
  };

  await assert.rejects(() => throughBreaker(URL_A, 'The image service', timeout));
  assert.equal(attempts, 1);
  assert.equal(deadReason(URL_A), 'timed out');

  const second = await throughBreaker(URL_A, 'The image service', timeout);
  assert.equal(second.ok, false);
  assert.equal(second.skipped, true);
  // ⚠️ THE POINT OF THE WHOLE MODULE: the function was not called again, so no
  // second 180-second wait was spent.
  assert.equal(attempts, 1, 'the dead endpoint must not be contacted a second time');
});

test('a DNS/connection failure trips it too', async () => {
  const refused = () => {
    const e = new Error('fetch failed');
    e.cause = { code: 'ECONNREFUSED' };
    throw e;
  };
  await assert.rejects(() => throughBreaker(URL_A, 'x', refused));
  assert.equal(deadReason(URL_A), 'ECONNREFUSED');
});

/**
 * ⚠️ THE DANGEROUS DIRECTION. An HTTP 400 means the request was wrong, not that
 * the service is down — the next one may well be right. Tripping here would
 * disable a healthy service because the model sent one bad prompt.
 */
test('an application-level refusal does NOT trip it', async () => {
  const four_hundred = async () => ({ ok: false, status: 400 });
  const r = await throughBreaker(URL_A, 'x', four_hundred);
  assert.equal(r.status, 400);
  assert.equal(deadReason(URL_A), null, 'a 400 must never mark an endpoint dead');
});

test('a thrown application error does not trip it either', async () => {
  // No `cause.code`, not a timeout — a bug in our own parsing, say.
  await assert.rejects(() => throughBreaker(URL_A, 'x', () => { throw new TypeError('bad json'); }));
  assert.equal(deadReason(URL_A), null);
});

test('endpoints are tracked separately — one dead service does not disable another', async () => {
  markUnreachable(URL_A, 'timed out');
  assert.equal(deadReason(URL_A), 'timed out');
  assert.equal(deadReason(URL_B), null);
  let ran = false;
  await throughBreaker(URL_B, 'x', async () => { ran = true; return { ok: true }; });
  assert.equal(ran, true);
});

/**
 * ⚠️ THE MESSAGE IS AIMED AT A MODEL, and the original text ("try once more")
 * caused the failure this module fixes — it was read as an instruction, because
 * it is one. The replacement must close the door explicitly.
 */
test('the skip message tells the model to stop, not to retry', () => {
  markUnreachable(URL_A, 'timed out');
  const msg = skipMessage('The image service', URL_A);
  assert.match(msg, /do not call this tool again in this run/i);
  assert.doesNotMatch(msg, /try (once more|again)/i);
  assert.match(msg, /timed out/);
});

test('media tools honour the breaker without re-contacting the endpoint', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const e = new Error('aborted');
    e.name = 'TimeoutError';
    throw e;
  };
  const env = { RENDER_AUDIT_URL: URL_A };
  const first = await seePage(process.cwd(), 'package.json', { env, fetchImpl, dryRun: true });
  assert.equal(first.ok, false);
  assert.equal(calls, 1);

  const second = await seePage(process.cwd(), 'package.json', { env, fetchImpl, dryRun: true });
  assert.equal(second.ok, false);
  assert.equal(calls, 1, 'the render endpoint must not be waited on twice');
  assert.match(second.error, /not responding this session/);
});
