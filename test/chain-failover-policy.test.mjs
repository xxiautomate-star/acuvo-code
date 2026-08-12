/**
 * ── ⚠️ THE CHAIN STOPS ON FAILURES THAT ONLY APPLY TO ONE MODEL ─────────────
 *
 * `callChain` stops the moment a failure is not retryable, and its reasoning is
 * right for the case it was written against: a bad key or a malformed request
 * "will fail identically on every provider", so burning three more attempts
 * turns a two-second error into an eight-second one.
 *
 * ⚠️ BUT THAT ARGUMENT DOES NOT HOLD FOR A FAILURE ABOUT THE MODEL ITSELF.
 * Every candidate in the chain sends a DIFFERENT model id. A 404 "model not
 * found", a retired id, or "No endpoints found that support tool use" is a fact
 * about ONE candidate and says nothing whatsoever about the next three.
 *
 * ⭐ AND WE HAVE A REAL INSTANCE OF EXACTLY THIS. The OpenCode integration sat
 * broken because its configured model was an IMAGE model with no tool support,
 * and every request came back `404 "No endpoints found that support tool use"`.
 * Three healthy fallbacks were sitting right there, each of which would have
 * sent a different id, and the chain refused to try any of them.
 *
 * ⭐ THE DISTINCTION TO ENCODE: is the failure about the REQUEST (identical on
 * every provider, so stop) or about the MODEL (different per candidate, so
 * advance)? That is one predicate, and it is the difference between a chain and
 * a list.
 *
 * ── ⚠️ AND THE SECOND DEFECT: THE CHAIN HAS NO BACKOFF ──────────────────────
 * Retries fire immediately and `Retry-After` is never read, so all four attempts
 * are spent in milliseconds against a rate limiter that would have served us a
 * second later. A "chain" that burns itself out faster than the limiter's window
 * is a chain that exists only on paper.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { callChain, isRetryable } from '../lib/chain.mjs';

const ENV = { ACUVO_FALLBACK_MODELS: '' };

/** A callImpl that fails the first N candidates with `error`, then succeeds. */
function failFirst(n, error) {
  const seen = [];
  return {
    seen,
    impl: async ({ model }) => {
      seen.push(model);
      if (seen.length <= n) return { ok: false, error };
      return { ok: true, content: 'done', toolCalls: [], model, usage: null, finishReason: 'stop' };
    },
  };
}

test('⚠️ a MODEL-specific 404 advances the chain — the next candidate sends a different id', async () => {
  const { seen, impl } = failFirst(1, 'HTTP 404: No endpoints found that support tool use');
  const r = await callChain({
    apiKey: 'k', model: 'openrouter/an-image-model', messages: [], tools: [], env: ENV, callImpl: impl,
  });
  assert.equal(
    r.ok,
    true,
    `the chain gave up on a failure that was only true of the first model. It tried: ${seen.join(' -> ')}`,
  );
  assert.ok(seen.length >= 2, `only ${seen.length} candidate(s) were tried: ${seen.join(' -> ')}`);
});

test('a retired / unknown model id also advances', async () => {
  for (const err of ['HTTP 404: model not found', 'HTTP 400: the model `x/y-old` does not exist']) {
    const { seen, impl } = failFirst(1, err);
    const r = await callChain({ apiKey: 'k', model: 'x/y-old', messages: [], tools: [], env: ENV, callImpl: impl });
    assert.equal(r.ok, true, `did not fail over on: ${err} (tried ${seen.length})`);
  }
});

/**
 * ⚠️⚠️ THE REGRESSION HALF, AND IT IS THE ONE THAT MATTERS. The original
 * stop-early behaviour is CORRECT for a request-level failure and must survive.
 * A bad key really does fail identically everywhere, and turning a two-second
 * error into an eight-second one teaches the user the tool is slow rather than
 * that their key is wrong.
 */
test('a bad key still stops the chain immediately — this must not regress', async () => {
  const { seen, impl } = failFirst(99, 'HTTP 401: invalid api key');
  const r = await callChain({ apiKey: 'bad', model: 'a/b', messages: [], tools: [], env: ENV, callImpl: impl });
  assert.equal(r.ok, false);
  assert.equal(seen.length, 1, `a bad key burned ${seen.length} attempts — it fails identically on every provider`);
  assert.equal(r.stoppedEarly, true);
});

test('a malformed request also still stops immediately', async () => {
  const { seen, impl } = failFirst(99, 'HTTP 400: messages must be an array');
  const r = await callChain({ apiKey: 'k', model: 'a/b', messages: [], tools: [], env: ENV, callImpl: impl });
  assert.equal(r.ok, false);
  assert.equal(seen.length, 1, `a malformed request burned ${seen.length} attempts`);
});

test('a 403 stops too', async () => {
  const { seen, impl } = failFirst(99, 'HTTP 403: forbidden');
  await callChain({ apiKey: 'k', model: 'a/b', messages: [], tools: [], env: ENV, callImpl: impl });
  assert.equal(seen.length, 1);
});

/**
 * ⭐ BACKOFF. Injected, never real — a test that actually sleeps is a test
 * nobody runs. The assertion is that the chain WAITS between attempts and that
 * the wait grows, not that any particular millisecond value was chosen.
 */
test('⭐ the chain backs off between attempts instead of burning itself out in 43ms', async () => {
  const waits = [];
  const { impl } = failFirst(2, 'HTTP 429 rate limited');
  const r = await callChain({
    apiKey: 'k', model: 'a/b', messages: [], tools: [], env: ENV, callImpl: impl,
    sleepImpl: async (ms) => { waits.push(ms); },
  });
  assert.equal(r.ok, true, 'the chain should recover once a candidate succeeds');
  assert.ok(waits.length >= 2, `no backoff happened at all — waits: ${JSON.stringify(waits)}`);
  assert.ok(waits.every((w) => w > 0), `a zero wait is not a backoff: ${JSON.stringify(waits)}`);
  assert.ok(waits[1] > waits[0], `the wait must grow: ${JSON.stringify(waits)}`);
});

test('⭐ Retry-After is honoured when the provider sends one', async () => {
  const waits = [];
  const seen = [];
  const impl = async ({ model }) => {
    seen.push(model);
    if (seen.length === 1) return { ok: false, error: 'HTTP 429 rate limited', retryAfterMs: 2_500 };
    return { ok: true, content: 'done', toolCalls: [], model, usage: null, finishReason: 'stop' };
  };
  const r = await callChain({
    apiKey: 'k', model: 'a/b', messages: [], tools: [], env: ENV, callImpl: impl,
    sleepImpl: async (ms) => { waits.push(ms); },
  });
  assert.equal(r.ok, true);
  assert.equal(waits[0], 2_500, `the provider asked for 2500ms and we waited ${waits[0]}ms — guessing over an explicit instruction`);
});

test('backoff never applies before the FIRST attempt', async () => {
  const waits = [];
  const { impl } = failFirst(0, 'x');
  await callChain({
    apiKey: 'k', model: 'a/b', messages: [], tools: [], env: ENV, callImpl: impl,
    sleepImpl: async (ms) => { waits.push(ms); },
  });
  assert.equal(waits.length, 0, 'the first call must be immediate — nobody should wait to be told their key works');
});

test('isRetryable still classifies the transport and 5xx cases it always did', () => {
  /**
   * ⚠️ THESE ARE HAND-WRITTEN LITERALS AND THAT IS THE LIMIT OF THIS TEST.
   * `'timed out'` is a string `describeTransportError` has never once produced —
   * the real timeout sentence is "No response from OpenRouter within 180s…",
   * which matched none of these rules, so the four-model chain never failed over
   * on a timeout while this test sat green. A test that invents its own input
   * cannot discover that two modules have drifted apart.
   *
   * ⭐ The real-output assertions live in `test/timeout-is-retryable.test.mjs`,
   * which calls `describeTransportError` and feeds it straight in. Keep this one
   * for the classification rules; keep that one for the contract.
   */
  for (const e of ['timed out', 'ECONNRESET', 'fetch failed', 'HTTP 503', 'HTTP 429', 'empty reply']) {
    assert.equal(isRetryable(e), true, `${e} should be retryable`);
  }
  for (const e of ['HTTP 401: invalid api key', 'HTTP 400: messages must be an array']) {
    assert.equal(isRetryable(e), false, `${e} should not be retryable`);
  }
});
