/**
 * ── ⚠️⚠️ THE FOUR-MODEL CHAIN NEVER FIRED ON A TIMEOUT ──────────────────────
 *
 * `chain.mjs`'s own header promises: "RETRY 429 (rate limit) · 5xx (their
 * fault) · **timeout** · connection error". It did not.
 *
 * `describeTransportError` (model.mjs:302) emits, for a real abort:
 *   "No response from OpenRouter within 180s — the call was aborted rather
 *    than left hanging."
 * `isRetryable` (chain.mjs:78) matched:
 *   /timed out|could not reach|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed/i
 *
 * Not one of those substrings appears in that sentence. So the commonest
 * failure of a LONG job — the one where three healthy fallbacks are sitting
 * right there — stopped the chain dead after one attempt. Long tasks failed
 * more, by design, which is precisely backwards.
 *
 * ⭐ AND THE SUITE WAS GREEN THE WHOLE TIME, because
 * `chain-failover-policy.test.mjs` asserted `isRetryable('timed out')` — a
 * hand-written literal the code never produces. A test that invents its own
 * input cannot discover that two modules have drifted apart.
 *
 * ⭐ SO THE FIX IS NOT A BIGGER REGEX. Prose-coupling is what let them drift;
 * a wider regex just moves the next drift somewhere else. The transport now
 * reports a KIND, and the classifier switches on it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeTransportError, transportErrorKind } from '../lib/model.mjs';
import { isRetryable } from '../lib/chain.mjs';

/** The exact error undici raises when `AbortSignal.timeout` fires. */
function realTimeoutError() {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'TimeoutError';
  return e;
}

test('⭐⭐ the string our own code emits for a timeout is retryable — asserted on the REAL output', () => {
  const message = describeTransportError(realTimeoutError(), 180_000);

  // Pin the shape so a future rewording is a visible change, not a silent one.
  assert.match(message, /No response from OpenRouter within 180s/);

  assert.equal(
    isRetryable(message, transportErrorKind(realTimeoutError())), true,
    'a timeout must reach the fallbacks — this is the commonest failure of a long job',
  );
});

test('the kind is what carries it, not the prose', () => {
  assert.equal(transportErrorKind(realTimeoutError()), 'timeout');

  const aborted = new Error('aborted'); aborted.name = 'AbortError';
  assert.equal(transportErrorKind(aborted), 'timeout', 'an abort is the same case');

  const dns = new Error('fetch failed'); dns.cause = { code: 'ENOTFOUND' };
  assert.equal(transportErrorKind(dns), 'network');

  const refused = new Error('fetch failed'); refused.cause = { code: 'ECONNREFUSED' };
  assert.equal(transportErrorKind(refused), 'network');

  // ⚠️ Not everything is a transport problem. A 401 must stay non-retryable, or
  // a revoked key burns four attempts instead of one.
  assert.equal(transportErrorKind(new Error('HTTP 401: invalid api key')), null);
  assert.equal(transportErrorKind(null), null);
  assert.equal(transportErrorKind(undefined), null);
});

test('⭐ a kind of "timeout" or "network" is retryable WHATEVER the sentence says', () => {
  /**
   * The point of the kind: reword the message freely and the classifier cannot
   * drift. This asserts that directly — a sentence with none of the old regex
   * substrings in it still retries.
   */
  assert.equal(isRetryable('something entirely new and unmatched', 'timeout'), true);
  assert.equal(isRetryable('something entirely new and unmatched', 'network'), true);
  assert.equal(isRetryable('something entirely new and unmatched'), false, 'without a kind, prose still decides');
});

test('⚠️ a kind must never make a NON-retryable failure retryable', () => {
  /**
   * A bad key fails identically on every provider, so retrying it turns a
   * two-second error into an eight-second one and spends money doing it.
   */
  assert.equal(isRetryable('HTTP 401: invalid api key', null), false);
  assert.equal(isRetryable('HTTP 400: messages must be an array', null), false);
  assert.equal(isRetryable('HTTP 402: insufficient credits', null), false);
});

test('every case the old regex classified still classifies the same way', () => {
  // ⚠️ The fix is additive. Nothing that used to retry may stop retrying.
  for (const e of ['timed out', 'ECONNRESET', 'fetch failed', 'HTTP 503', 'HTTP 429', 'empty reply', 'could not reach']) {
    assert.equal(isRetryable(e), true, `${e} must still be retryable`);
  }
  for (const e of ['HTTP 401: invalid api key', 'HTTP 400: messages must be an array']) {
    assert.equal(isRetryable(e), false, `${e} must still not be retryable`);
  }
});
