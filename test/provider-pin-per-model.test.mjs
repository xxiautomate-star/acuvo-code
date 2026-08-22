/**
 * ── ⚠️⚠️ A SINGLE GLOBAL PIN IS ONLY EVER CORRECT FOR ONE MODEL ─────────────
 *
 * `DEFAULT_PROVIDER_ORDER = 'StreamLake'` was chosen by measuring FLASH, and
 * StreamLake does not serve `deepseek-v4-pro-0813` AT ALL — it is not among
 * pro's 7 endpoints. So every pro run asked for a provider that could not
 * answer, the pin matched nothing, `allow_fallbacks` did its job, and
 * OpenRouter routed freely.
 *
 * MEASURED on the 13-task bench, 2026-08-15: **pro was served by GMICloud on
 * 13 of 13 runs**, while flash held its pin (StreamLake 13, Baidu 5).
 *
 *   DeepSeek (the model's author)   in $0.435  out $0.870  cache-read $0.0036
 *   GMICloud (what we actually got) in $1.218  out $2.436  cache-read $0.1015
 *
 * ⚠️ 2.8x on tokens and 28x on CACHE READS. The "pro costs 11.2x flash" number
 * this package quotes was measured on the most expensive pro endpoint
 * available, purely because nobody had pinned the cheap one. Pinned to
 * DeepSeek's own endpoint, pro's cached reads ($0.0036) are ~3.8x CHEAPER than
 * flash's ($0.0137) — which is the opposite conclusion.
 *
 * ⭐ A provider list is a fact about a MODEL, not about this package.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { providerOrderFor, PROVIDER_PIN_BY_MODEL, callModel } from '../lib/model.mjs';
import { MODEL_PRICES } from '../lib/plan.mjs';

const FLASH = 'deepseek/deepseek-v4-flash-0731';
const PRO = 'deepseek/deepseek-v4-pro-0813';

/** Drive the REAL callModel and read the request body it would have sent. */
async function sentFor(model, env) {
  let body = null;
  const fake = async (_u, o) => {
    body = JSON.parse(o.body);
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }) };
  };
  await callModel({ apiKey: 'k', model, messages: [{ role: 'user', content: 'hi' }], tools: [], fetchImpl: fake, env });
  return body;
}

test('⚠️⚠️ THE BUG: pro must NOT be pinned to a provider that does not serve it', async () => {
  const body = await sentFor(PRO, {});
  const order = body.provider?.only ?? body.provider?.order ?? [];
  assert.ok(order.length > 0, 'pro went out unpinned — that is the routing lottery that cost 2.8x');
  assert.equal(order.includes('StreamLake'), false,
    'StreamLake does not serve pro; asking for it matches nothing and routes freely to the dearest endpoint');
});

test('⭐⭐ pro asks for DeepSeek FIRST — the author\'s own endpoint, 2.8x cheaper than what we got', async () => {
  const body = await sentFor(PRO, {});
  assert.equal(body.provider.only[0], 'DeepSeek',
    'the cheapest pro endpoint by in+out must lead, or the pin is decorative');
});

test('⭐ flash keeps the pin that was measured for it', async () => {
  const body = await sentFor(FLASH, {});
  assert.equal(body.provider.only[0], 'StreamLake', 'the measured 2.4x caching win was on StreamLake');
});

test('⚠️⚠️ the FIRST attempt is a real lock, not one name wearing a pin', async () => {
  /**
   * ⚠⚠ THIS TEST'S PREMISE CHANGED, AND THE CONCERN BEHIND IT DID NOT.
   *
   * It used to assert `order.length >= 2` with `allow_fallbacks: true`, for a
   * good reason: one name PLUS fallbacks means the fallback is the whole open
   * market, so a cheap run silently becomes an expensive one.
   *
   * ⭐ The first attempt now sends ONE provider with `allow_fallbacks: FALSE`.
   * That is not "one name wearing a pin" — it is a genuine lock that cannot
   * reach the open market at all, which is what buys the prompt cache. Measured
   * across 90 real runs before this change: token-weighted hit rate 51.2%, with
   * round 1 non-zero on 3 of 16 runs, because a preference over three upstreams
   * lands wherever and a cache lives on exactly one of them.
   *
   * The cost concern is preserved by the SECOND attempt, asserted below.
   *
   * -- AND THE PREMISE CHANGED A SECOND TIME, 2026-08-19 --------------------
   *
   * The lock is now expressed as `provider.only` rather than
   * `provider.order` + `allow_fallbacks: false`. It restricts exactly the same
   * set. The difference is what OpenRouter does around it, quoted from their
   * prompt-caching docs:
   *
   *   "Sticky routing is not used when you specify a manual provider order via
   *    `provider.order` -- in that case, your explicit ordering takes priority."
   *
   * Sticky routing is the mechanism that pins the SERVER inside a provider's
   * fleet. So the lock written to win the cache back was switching off the
   * feature that wins it -- which is why the fleet-level diagnosis ("pinning
   * the provider does not pin the machine") was right about the symptom and
   * wrong to conclude the machine could not be pinned.
   *
   * WARNING: that `only` PRESERVES stickiness is an inference. Their docs
   * discuss `order` and do not mention `only`. It is the right change anyway
   * because it is weakly dominant -- identical restriction, and either
   * stickiness survives or behaviour is exactly what it is today.
   */
  const body = await sentFor(FLASH, {});
  assert.equal(body.provider.only.length, 1, 'the warm attempt must pin exactly one upstream');
  assert.equal(body.provider.order, undefined,
    'an ORDER here is the old defect twice over: it can land cold AND it disables sticky routing');
  assert.equal(body.provider.only[0], 'StreamLake', 'the measured caching win was on StreamLake');
});

test('⚠️⚠️ …and the FALLBACK attempt is still a cheap LIST, so "never single" holds', async () => {
  /**
   * The half that keeps the lock safe. If the pinned upstream is down, the
   * retry must degrade to another CHEAP endpoint first — never to the open
   * market. A lock without this retry would be an outage for every user at
   * once, which is exactly what "never single" forbids.
   */
  const sent = [];
  const fetchImpl = async (_url, opts) => {
    sent.push(JSON.parse(opts.body));
    if (sent.length === 1) return { ok: false, status: 503, text: async () => 'busy' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }) };
  };
  await callModel({
    apiKey: 'k', model: FLASH, messages: [{ role: 'user', content: 'x' }], fetchImpl, env: {},
  });

  assert.equal(sent.length, 2, 'a 503 on the pinned upstream must be retried, not surfaced');
  assert.ok(sent[1].provider.order.length >= 2,
    'the fallback degrades to a single name — that is the open market one hop away');
  assert.equal(sent[1].provider.allow_fallbacks, true, '"never single" is the standing rule');
});

test('⭐ a 401 is NOT retried — a second provider cannot fix a bad key', async () => {
  const sent = [];
  const fetchImpl = async (_url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: false, status: 401, text: async () => 'no' };
  };
  await callModel({
    apiKey: 'k', model: FLASH, messages: [{ role: 'user', content: 'x' }], fetchImpl, env: {},
  });
  assert.equal(sent.length, 1, 'retrying an auth failure doubles the latency of the commonest error');
});

test('⚠️ an UNKNOWN model is left UNPINNED rather than given flash\'s pin', async () => {
  /**
   * Handing an unknown model the flash pin recreates the exact bug: it looks
   * pinned, matches nothing, and routes to whatever is dearest. No pin at least
   * tells the truth, and `pinOutcome` reports what actually served the round.
   */
  const body = await sentFor('somebody/brand-new-model', {});
  assert.equal('provider' in body, false, 'an unknown model must send no provider block at all');
  assert.equal(providerOrderFor('somebody/brand-new-model', {}).source, 'none');
});

test('⚠️⚠️ ACUVO_PROVIDER_ORDER still wins, and an explicit empty string still unpins', async () => {
  // The off switch. A `??` here was a real bug once — the documented way to
  // unpin quietly did nothing, and the routing lottery stayed on.
  const named = await sentFor(PRO, { ACUVO_PROVIDER_ORDER: 'Novita' });
  assert.deepEqual(named.provider.only, ['Novita'], 'an explicit override must beat the per-model default');

  const off = await sentFor(PRO, { ACUVO_PROVIDER_ORDER: '' });
  assert.equal('provider' in off, false, 'an explicit empty string must send NO provider block');
});

test('⚠️ every pinned model names providers that are plausible for it, and pro never names a flash-only one', () => {
  /**
   * The specific mistake this whole file exists for: pro's endpoint list and
   * flash's overlap only at GMICloud. StreamLake and Baidu are flash-only, so
   * neither may appear under pro.
   */
  const proPins = PROVIDER_PIN_BY_MODEL[PRO];
  for (const flashOnly of ['StreamLake', 'Baidu', 'DigitalOcean', 'DeepInfra']) {
    assert.equal(proPins.includes(flashOnly), false, `${flashOnly} does not serve pro`);
  }
  // And every entry in the table is a non-empty list of non-empty strings.
  for (const [model, order] of Object.entries(PROVIDER_PIN_BY_MODEL)) {
    assert.ok(Array.isArray(order) && order.length > 0, `${model} has an empty pin, which is the same as none`);
    for (const p of order) assert.ok(typeof p === 'string' && p.trim(), `${model} has a blank provider name`);
  }
});

test('⭐ the reviewer\'s model is pinned too — it is a real call and a real bill', async () => {
  // qwen has exactly one endpoint today, so pinning it changes nothing and
  // states the fact. The assertion is that it is not left to chance.
  const body = await sentFor('qwen/qwen3.7-flash', {});
  assert.deepEqual(body.provider.only, ['Alibaba']);
});

/**
 * ── 💰⭐⭐⭐ THE PIN TABLE AND THE PRICE TABLE STATE ONE FACT TWICE ──────────
 *
 * Every test above pins a model somebody thought about. Neither of the two ways
 * that stops being true is covered:
 *
 *   1. A MODEL IS ADDED AND NOBODY PINS IT. `providerOrderFor` deliberately
 *      leaves an unknown model UNPINNED rather than guess — correct, and it
 *      also means the failure is SILENT. The model routes freely, lands on
 *      whatever endpoint is dearest, and the only symptom is a bigger bill.
 *      Pro cost us 2.8x on tokens and 28x on cache reads in exactly this way,
 *      for as long as nobody looked.
 *
 *   2. THE TWO TABLES DRIFT. `MODEL_PRICES[m].provider` names the endpoint the
 *      MARGIN MATH IS QUOTED FROM; `PROVIDER_PIN_BY_MODEL[m][0]` names the
 *      endpoint we actually ASK FOR. They are the same fact written in two
 *      files, and this package's own history is what happens when they
 *      disagree: the "pro costs 11.2x flash" figure was measured on GMICloud
 *      while the plan was priced against DeepSeek's endpoint, and the true
 *      answer turned out to be the OPPOSITE — pinned pro's cached reads are
 *      ~3.8x CHEAPER than flash's.
 *
 * ⚠️ A WRONG PRICE HERE IS NOT A REPORTING BUG. `lib/plan.mjs` is what the
 * A$29 / 95M-token ladder is derived from. If the quoted endpoint is not the
 * requested one, every margin number in the business is measured against a
 * price we never pay.
 */
test('💰 every priced model is pinned — an unpinned model routes to the dearest endpoint in silence', () => {
  const unpinned = Object.keys(MODEL_PRICES).filter((m) => !PROVIDER_PIN_BY_MODEL[m]);
  assert.deepEqual(unpinned, [],
    `these models are priced but not pinned, so we pay whatever OpenRouter picks: ${unpinned.join(', ')}`);
});

test('💰 the price we quote is the endpoint we ask for FIRST', () => {
  for (const [model, price] of Object.entries(MODEL_PRICES)) {
    const order = PROVIDER_PIN_BY_MODEL[model];
    if (!order) continue;   // the test above owns that failure; don't report it twice
    assert.equal(order[0], price.provider,
      `${model}: plan.mjs prices it on ${price.provider} but model.mjs asks for ${order[0]} first — `
      + 'the margin math is quoting an endpoint we do not request');
  }
});

test('⚠️ and the guard is looking at something — not an empty table', () => {
  // A completeness check over an empty list passes for the wrong reason. Both
  // tables must be non-empty for the two above to mean anything at all.
  assert.ok(Object.keys(MODEL_PRICES).length >= 4, 'MODEL_PRICES shrank — the guards above went quiet');
  assert.ok(Object.keys(PROVIDER_PIN_BY_MODEL).length >= 4, 'PROVIDER_PIN_BY_MODEL shrank');
});
