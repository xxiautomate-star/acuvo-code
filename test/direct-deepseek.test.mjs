/**
 * ── ⚠️⚠️⚠️ THE CACHE MISSES ARE A ROUTING LOTTERY, NOT PREFIX DRIFT ─────────
 *
 * Roman: *"the caching still isn't 90 percent … if it's not 90 our product is
 * gone."* Measured over four consecutive real runs on OpenRouter:
 *
 *     run 1  cache 65%  round 1  0%      same task, three times:
 *     run 2  cache 98%  round 1 98%        0% → 79% → 99%
 *     run 3  cache 31%  round 1  0%
 *     run 4  cache 98%  round 1 98%
 *
 * ⭐ And it is NOT our prompt: **99.9% of the payload is byte-identical across
 * two completely different tasks** — the tools JSON alone is 60,799 chars, 92%
 * of it, and never changes. The ceiling is 99.9%.
 *
 * A prompt cache lives on ONE SERVER. Pinning `provider: ['StreamLake']` pins a
 * FLEET, not a machine, so every run rolls the dice and warms whichever server
 * it hit. Nothing we do to the prompt can fix that.
 *
 * Going direct removes the lottery: one vendor, one endpoint, their own context
 * cache, no aggregator choosing a server — and no OpenRouter margin.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { callModel, directDeepSeek, DEEPSEEK_DIRECT_MODELS } from '../lib/model.mjs';

const FLASH = 'deepseek/deepseek-v4-flash-0731';

function recorder() {
  const seen = [];
  return {
    seen,
    fetchImpl: async (url, opts) => {
      seen.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }) };
    },
  };
}

test('⚠️⚠️ with no DeepSeek key NOTHING changes — it still goes to OpenRouter, pinned', async () => {
  // The find-nothing half. This must never silently re-route someone's traffic
  // or spend on an account they did not choose.
  const r = recorder();
  await callModel({ apiKey: 'or', model: FLASH, messages: [{ role: 'user', content: 'x' }], fetchImpl: r.fetchImpl, env: {} });
  assert.match(r.seen[0].url, /openrouter\.ai/);
  assert.equal(r.seen[0].body.model, FLASH, 'the aggregator slug must survive');
  /**
   * The warm lock is now a WHITELIST, not an ORDER, and that is the caching
   * fix rather than a cosmetic one: OpenRouter's docs say a manual
   * `provider.order` disables their sticky routing, which is the mechanism
   * that pins the SERVER inside a provider's fleet. `only` restricts exactly
   * the same set with no ordering to take priority over.
   */
  assert.deepEqual(r.seen[0].body.provider.only, ['StreamLake'], 'the warm lock still applies');
  assert.equal(r.seen[0].body.provider.order, undefined, 'an ORDER here would switch sticky routing off');
});

test('⭐ with a DeepSeek key it goes DIRECT — one endpoint, one cache', async () => {
  const r = recorder();
  await callModel({
    apiKey: 'or', model: FLASH, messages: [{ role: 'user', content: 'x' }],
    fetchImpl: r.fetchImpl, env: { DEEPSEEK_API_KEY: 'ds-key', ACUVO_DEEPSEEK_DIRECT: '1' },
  });
  assert.match(r.seen[0].url, /api\.deepseek\.com/);
  assert.equal(r.seen[0].auth, 'Bearer ds-key', 'the DeepSeek key must be used, not the OpenRouter one');
  assert.equal(r.seen[0].body.model, 'deepseek-chat', 'their id, not the aggregator slug');
});

test('⚠️⚠️ the OpenRouter `provider` field NEVER reaches DeepSeek', async () => {
  /**
   * The base payload carries `provider`, and the per-attempt spread can only
   * OVERRIDE it — it cannot remove it. So a direct call was shipping
   * `order: ['StreamLake', …]` to an API that has never heard of StreamLake.
   * Caught by printing the wire body, not by trusting the branch.
   */
  const r = recorder();
  await callModel({
    apiKey: 'or', model: FLASH, messages: [{ role: 'user', content: 'x' }],
    fetchImpl: r.fetchImpl, env: { DEEPSEEK_API_KEY: 'ds-key', ACUVO_DEEPSEEK_DIRECT: '1' },
  });
  assert.equal(r.seen[0].body.provider, undefined,
    'an OpenRouter routing field on DeepSeek 400s and reads as "DeepSeek is down"');
});

test('⚠️ an UNMAPPED model falls through to OpenRouter rather than being guessed at', () => {
  // A wrong model id is a 404 that reads like an outage.
  assert.equal(directDeepSeek('anthropic/claude-3', { DEEPSEEK_API_KEY: 'k', ACUVO_DEEPSEEK_DIRECT: '1' }), null);
  assert.equal(directDeepSeek(FLASH, {}), null, 'no key means no direct route');
  assert.ok(directDeepSeek(FLASH, { DEEPSEEK_API_KEY: 'k', ACUVO_DEEPSEEK_DIRECT: '1' }));
});

test('⭐⭐⭐ A KEY IS NOT A REQUEST — direct is OFF unless ACUVO_DEEPSEEK_DIRECT=1', () => {
  /**
   * ── WHY THIS GUARD EXISTS (Roman, 2026-08-22: "no direct deepseek api") ────
   *
   * Every OTHER test in this file sets the flag, because they test the direct
   * leg's mechanics. That makes them all blind to the default — so without this
   * one, deleting the gate in `directDeepSeek` turns the whole file green while
   * silently routing every build back onto DeepSeek's own API.
   *
   * ⚠️ THE COST OF THAT REGRESSION IS NOT SMALL. Direct is 3.7x dearer on OUTPUT
   * ($0.66/M vs OpenRouter's $0.18/M) and DOUBLES for 7 hours a day under peak
   * billing (01:00-04:00 + 06:00-10:00 UTC = 11am-2pm / 4pm-8pm AEST). Measured
   * across 95M tokens at 90% cache: 62.3% margin against 85.6%.
   */
  assert.equal(
    directDeepSeek(FLASH, { DEEPSEEK_API_KEY: 'ds-key' }),
    null,
    'a funded DeepSeek key alone must NOT re-admit the direct endpoint',
  );
  assert.ok(
    directDeepSeek(FLASH, { DEEPSEEK_API_KEY: 'ds-key', ACUVO_DEEPSEEK_DIRECT: '1' }),
    'and the flag must still re-admit it, or bake-offs become impossible',
  );
});

test('⭐ every mapped id is a real DeepSeek model name, not an aggregator slug', () => {
  for (const [slug, id] of Object.entries(DEEPSEEK_DIRECT_MODELS)) {
    assert.match(slug, /\//, `${slug} should be the aggregator slug`);
    assert.doesNotMatch(id, /\//, `${id} is a slug, not a DeepSeek model id`);
  }
});

/**
 * ── ⚠️⚠️⚠️ THE TRAP A LIVE PROBE EXPOSED, 2026-08-19 ────────────────────────
 *
 * The key in this repo is VALID and has NO MONEY:
 *
 *     POST api.deepseek.com/chat/completions -> 402 "Insufficient Balance"
 *
 * `worthFallingBackFrom` excludes 401/402/404 on the stated grounds that "a bad
 * key, an empty balance or a wrong model id fails identically on every
 * provider". That was TRUE when every attempt was a different provider ORDER on
 * one OpenRouter key — one account, one balance. It is FALSE the moment a route
 * is a different VENDOR with a different key and a different balance.
 *
 * Combined with the direct route having no fallback at all, exporting that key
 * would have made every model call in the CLI fail hard, first try, no retry.
 */
function failingThenOk(status) {
  const seen = [];
  return {
    seen,
    fetchImpl: async (url, opts) => {
      seen.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
      if (/api\.deepseek\.com/.test(url)) {
        return { ok: false, status, text: async () => JSON.stringify({ error: { message: 'Insufficient Balance' } }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }) };
    },
  };
}

test('⚠️⚠️ an UNFUNDED DeepSeek key falls back to OpenRouter instead of failing the call', async () => {
  const r = failingThenOk(402);
  const out = await callModel({
    apiKey: 'or', model: FLASH, messages: [{ role: 'user', content: 'x' }],
    fetchImpl: r.fetchImpl, env: { DEEPSEEK_API_KEY: 'ds-key', ACUVO_DEEPSEEK_DIRECT: '1' },
  });

  assert.match(r.seen[0].url, /api\.deepseek\.com/, 'direct is still tried FIRST — the cache is why we came');
  assert.ok(r.seen[1], 'a 402 from DeepSeek must not end the call: their balance says nothing about OpenRouter');
  assert.match(r.seen[1].url, /openrouter\.ai/);
  assert.equal(out.ok, true, 'a cold answer beats no answer');
});

test('⚠️ a 401 from DeepSeek falls back too — a bad key THERE is not a bad key HERE', async () => {
  const r = failingThenOk(401);
  await callModel({
    apiKey: 'or', model: FLASH, messages: [{ role: 'user', content: 'x' }],
    fetchImpl: r.fetchImpl, env: { DEEPSEEK_API_KEY: 'ds-key', ACUVO_DEEPSEEK_DIRECT: '1' },
  });
  assert.match(r.seen[1].url, /openrouter\.ai/);
});

test('⭐ the fallback is still PINNED — the ladder is not silently unpinned by going direct', async () => {
  /**
   * ⚠️ THE BUG THE FIX ITSELF INTRODUCED, caught by reading the loop that was
   * changed. `if (direct) delete body.provider` had to become
   * `if (attempt.direct)`: `direct` is now true for the whole CALL whenever a
   * DeepSeek key exists, so testing it would strip the warm lock off every
   * OpenRouter fallback — handing back the exact routing lottery going direct
   * was meant to escape.
   */
  const r = failingThenOk(402);
  await callModel({
    apiKey: 'or', model: FLASH, messages: [{ role: 'user', content: 'x' }],
    fetchImpl: r.fetchImpl, env: { DEEPSEEK_API_KEY: 'ds-key', ACUVO_DEEPSEEK_DIRECT: '1' },
  });
  assert.equal(r.seen[0].body.provider, undefined, 'DeepSeek must never see an OpenRouter field');
  assert.deepEqual(r.seen[1].body.provider.only, ['StreamLake'], 'the OpenRouter leg keeps its warm lock');
  assert.equal(r.seen[1].body.model, FLASH, 'and the aggregator slug, not the DeepSeek id');
});

test('⚠️ a SUCCESSFUL direct call makes exactly one request — the fallback is for failure only', async () => {
  // The cache argument only ever applied to a call that SUCCEEDED. If a good
  // direct call also hit OpenRouter, going direct would cost double and warm
  // a second machine for nothing.
  const r = recorder();
  await callModel({
    apiKey: 'or', model: FLASH, messages: [{ role: 'user', content: 'x' }],
    fetchImpl: r.fetchImpl, env: { DEEPSEEK_API_KEY: 'ds-key', ACUVO_DEEPSEEK_DIRECT: '1' },
  });
  assert.equal(r.seen.length, 1);
});

test('⭐⭐ a session id is sent, and it is what makes stickiness start on request ONE', async () => {
  /**
   * Without it, OpenRouter derives a sticky key from the opening messages and
   * only engages "after a cache hit is detected" — so round 1 is always cold
   * and an N-round run is capped at (N-1)/N. That cap is the whole reason
   * "90% always" was arithmetically impossible rather than merely unmet.
   */
  const r = recorder();
  await callModel({
    apiKey: 'or', model: FLASH, messages: [{ role: 'user', content: 'x' }],
    fetchImpl: r.fetchImpl, env: {}, sessionId: 'conv-abc',
  });
  assert.equal(r.seen[0].body.session_id, 'conv-abc');
});

test('⚠️ no session id means no field — an existing wire body is unchanged', async () => {
  const r = recorder();
  await callModel({ apiKey: 'or', model: FLASH, messages: [{ role: 'user', content: 'x' }], fetchImpl: r.fetchImpl, env: {} });
  assert.equal('session_id' in r.seen[0].body, false);
});

test('⚠️ a session id is bounded to the 256 chars OpenRouter accepts', async () => {
  const r = recorder();
  await callModel({
    apiKey: 'or', model: FLASH, messages: [{ role: 'user', content: 'x' }],
    fetchImpl: r.fetchImpl, env: {}, sessionId: 'x'.repeat(500),
  });
  assert.equal(r.seen[0].body.session_id.length, 256);
});
