/**
 * ── 🚨⭐⭐⭐ AN HTTP 200 THAT IS THE PROVIDER SAYING NO ──────────────────────
 *
 * Measured against the live OpenRouter API on 2026-09-18 by
 * `scripts/zz-what-can-the-fallback-actually-take.mjs`. `deepseek/deepseek-chat`
 * — the FIRST fallback in `buildChain`, and the one model in the chain with no
 * entry in `PROVIDER_PIN_BY_MODEL` — is served by a DeepInfra deployment that
 * ADVERTISES a 163,840-token window and ENFORCES 32,768. Ask it for more and
 * OpenRouter answers:
 *
 *     HTTP 200
 *     {"error":{"message":"Upstream error from DeepInfra: The sum of prompt
 *      length (90948.0), query length (0) should not exceed max_num_tokens
 *      (32768)","code":400}}
 *
 * Two hundred. No `choices`. Before the fix these tests pin, that body produced
 * the string *"the model returned no choices — nothing to act on"* — which
 * matched no rule in `isRetryable`, so the chain STOPPED with two healthy
 * fallback models untried, on a fallback leg, i.e. on the run where the primary
 * was already down. The user was told nothing about size, provider or limit.
 *
 * ⭐ THIS IS THE THIRD COSTUME OF ONE DEFECT. `chain.mjs` already carries the
 * argument for the empty-200 (*"the single most important line here"*) and
 * `extractReply` already carries it for the degenerate-200. Both were written
 * after the same hole cost a session. The rule those two earned and this file
 * extends: **a reply path that invents its own error prose must be read by the
 * classifier that decides what to do about it, and something must hold the two
 * together.** That is what these tests are.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { extractReply, upstreamErrorMessage } from '../lib/model.mjs';
import { isRetryable, isModelSpecific, callChain } from '../lib/chain.mjs';

/** The body, verbatim from the wire. */
const UPSTREAM_200 = {
  error: {
    message: 'Upstream error from DeepInfra: The sum of prompt length (90948.0), query length (0) should not exceed max_num_tokens (32768)',
    code: 400,
  },
  user_id: 'user_abc',
};

test('⭐ the provider\'s own sentence survives — the size, the limit and the name', () => {
  const r = extractReply(UPSTREAM_200);
  assert.equal(r.ok, false);
  assert.match(r.error, /DeepInfra/, 'the user must learn WHICH machine refused');
  assert.match(r.error, /32768/, 'and what it would have accepted');
  assert.match(r.error, /90948/, 'and what we sent it');
  assert.doesNotMatch(
    r.error,
    /returned no choices/,
    'the generic wording discards every fact a human needs and was never matched by anything',
  );
});

test('⭐⭐ and the chain is told to move on — this is the half that ends sessions', () => {
  const r = extractReply(UPSTREAM_200);
  assert.equal(
    isRetryable(r.error),
    true,
    'a capacity refusal from ONE endpoint says nothing about the next model in the chain',
  );
});

test('⚠️ the two halves are wired to each other, not merely both correct', () => {
  /**
   * ⭐ THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. Rewording
   * `upstreamErrorMessage`'s prefix without teaching `isRetryable` the new
   * wording re-opens the hole exactly as it was, and every other test in this
   * file would still pass, because each checks one side.
   */
  assert.equal(isRetryable(upstreamErrorMessage(UPSTREAM_200)), true);
});

test('⚠️ a 200 with NO error and no choices keeps the old wording', () => {
  /**
   * ⚠️ SCOPE, WHICH IS WHERE GUARDS IN THIS REPO FAIL RATHER THAN IN THEIR
   * ASSERTIONS. An `error` key holding nothing carries no information, and
   * manufacturing a sentence out of it would make an unexplained 200 retryable
   * on the strength of an empty object.
   */
  for (const body of [{}, { error: null }, { error: {} }, { error: '' }, { error: { message: '   ' } }]) {
    const r = extractReply(body);
    assert.equal(r.ok, false);
    assert.match(r.error, /returned no choices/, `an empty error must not be dressed up: ${JSON.stringify(body)}`);
    assert.equal(isRetryable(r.error), false, 'and an unexplained 200 must not become four attempts');
  }
});

test('⚠️ a plain-string `error` is read too — providers are not consistent', () => {
  const r = extractReply({ error: 'Upstream error from Somewhere: capacity' });
  assert.match(r.error, /Upstream error from Somewhere/);
  assert.equal(isRetryable(r.error), true);
});

test('⚠️ it is NOT classified as a failure about the model id', () => {
  /**
   * `isModelSpecific` short-circuits the retry logic with a `continue`. A
   * capacity refusal is about the HOST, not the id, and if it matched there the
   * chain would advance for the right reason by accident — and would keep
   * advancing after this rule was ever removed.
   */
  const r = extractReply(UPSTREAM_200);
  assert.equal(isModelSpecific(r.error), false);
});

test('⭐⭐⭐ end to end: the chain recovers instead of dying on the fallback leg', async () => {
  /**
   * The real shape of the incident: the primary is down, the chain drops to
   * `deepseek/deepseek-chat`, the unpinned request lands on the endpoint that
   * enforces 32,768, and `z-ai/glm-4.6` — a 200k window — is sitting right
   * there. Before the fix this returned `stoppedEarly: true` after two
   * attempts and the session ended.
   */
  const seen = [];
  const res = await callChain({
    apiKey: 'k',
    model: 'deepseek/deepseek-v4-flash-0731',
    messages: [{ role: 'user', content: 'go' }],
    env: {},
    sleepImpl: async () => {},
    callImpl: async ({ model }) => {
      seen.push(model);
      if (model === 'deepseek/deepseek-v4-flash-0731') return { ok: false, error: 'HTTP 503 upstream is unavailable' };
      if (model === 'deepseek/deepseek-chat') return { ok: false, ...extractReply(UPSTREAM_200) };
      return { ok: true, content: 'done', toolCalls: [], usage: null };
    },
  });

  assert.equal(res.ok, true, `the chain should have reached glm-4.6; it tried ${seen.join(' → ')}`);
  assert.equal(res.usedFallback, true);
  assert.deepEqual(seen, [
    'deepseek/deepseek-v4-flash-0731',
    'deepseek/deepseek-chat',
    'z-ai/glm-4.6',
  ]);
  assert.notEqual(res.stoppedEarly, true);
  /** ⭐ And the reason it moved is recorded, not lost — see `fellBackFrom`. */
  assert.match(res.fellBackFrom.map((f) => f.error).join('\n'), /max_num_tokens \(32768\)/);
});
