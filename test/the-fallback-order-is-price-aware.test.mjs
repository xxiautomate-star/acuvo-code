/**
 * ── 💰🔀⭐⭐⭐ WHEN A LEG FAILS, THE NEXT ONE IS THE CHEAPEST WE TRUST ────────
 *
 * Roman, 2026-09-18: *"these switches when a provider fucks up, we need to have
 * a process where the cheapest next one at that current moment goes through,
 * smoothly."*
 *
 * ⚠️ THE HAZARD IS NOT THE SORT, IT IS EVERY WAY THE SORT COULD GO WRONG. A
 * routing function that gets cleverer about price and stupider about
 * availability is worse than the hand-typed list it replaces — `supply-watch.ts`
 * records two occasions where cheapest-on-paper was the wrong answer and the
 * price sheet could not have said so. So each test here pins a REFUSAL:
 *
 *   1. position 0 never moves          — the primary is Roman's decision
 *   2. no name is ever added           — a permutation, never a discovery
 *   3. no evidence, no move            — unpriced or unproven keeps its place
 *   4. a dead price lookup changes NOTHING, byte for byte
 *
 * ⭐ AND THE LAST ONE IS THE POINT OF THE WHOLE FILE. This machine sits behind a
 * TLS-inspecting firewall that hangs the OpenRouter catalogue. A router that
 * degrades when a price lookup fails would be a worse outage than the provider
 * failure it exists to survive.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { costOrderedFallback, PROVIDER_PIN_BY_MODEL, REFUSED_PROVIDERS } from '../lib/provider-pin.mjs';
import { providerRateFor, blendedPerMillion, OUTPUT_TOKEN_SHARE, PROVIDER_RATES } from '../lib/rate-card.mjs';
import { callModel, CACHE_MEASURED } from '../lib/model.mjs';

const FLASH = 'deepseek/deepseek-v4-flash-0731';
const PIN = [...PROVIDER_PIN_BY_MODEL[FLASH]];
const PROVEN = Object.keys(CACHE_MEASURED).filter((n) => CACHE_MEASURED[n].caches === true);
const costAt = (cacheRate) => (name) => {
  const r = providerRateFor(FLASH, name);
  return r ? blendedPerMillion(r, cacheRate, OUTPUT_TOKEN_SHARE) : null;
};

test('⚠️⚠️ 4 — NO PRICES, NO CHANGE: a dead lookup returns the static order byte for byte', () => {
  assert.ok(PIN.length >= 3, 'the pin shrank below what this file can test');

  for (const [label, opts] of [
    ['no costOf at all (the firewall case)', {}],
    ['costOf present, every lookup null', { costOf: () => null, proven: PROVEN }],
    ['costOf present, every lookup NaN', { costOf: () => Number.NaN, proven: PROVEN }],
    ['costOf throws nothing but returns a string', { costOf: () => '0.01', proven: PROVEN }],
    ['nothing proven', { costOf: costAt(0.775), proven: [] }],
  ]) {
    const out = costOrderedFallback(PIN, opts);
    assert.deepEqual(out.order, PIN, `${label}: the order moved`);
    assert.equal(out.source, 'static', `${label}: reported a cost decision it did not make`);
    assert.equal(out.moved, false, `${label}: claimed to have moved something`);
  }
});

test('⚠️ 1 — the pinned PRIMARY never moves, whatever the prices say', () => {
  /** A cost function that would put the primary last if position 0 were sortable. */
  const inverted = (name) => (name === PIN[0] ? 99 : 0.001);
  const out = costOrderedFallback(PIN, { costOf: inverted, proven: PIN });
  assert.equal(out.order[0], PIN[0], 'the primary was re-sorted — that is Roman\'s decision, not a price sort');
});

test('⚠️ 2 — the result is a PERMUTATION: no name added, none dropped', () => {
  const out = costOrderedFallback(PIN, { costOf: costAt(0.775), proven: PROVEN });
  assert.deepEqual([...out.order].sort(), [...PIN].sort(), 'the fallback set changed membership');
  assert.equal(out.order.length, PIN.length);
  /**
   * ⭐ THE ONE THAT MATTERS COMMERCIALLY. `StreamLake` is priced in
   * `PROVIDER_RATES` and is 61% cheaper on our shape than the pinned primary.
   * It is NOT in the pin, so no amount of price advantage may route to it.
   */
  assert.ok(PROVIDER_RATES[FLASH].StreamLake, 'the cheap unpinned provider left the card — this test now proves nothing');
  assert.ok(!out.order.includes('StreamLake'), 'an unpinned provider was routed to on price alone');
});

test('⚠️ 3 — an UNPROVEN name is never promoted, however cheap', () => {
  const pin = [PIN[0], 'Makora', 'Bargain Basement', 'DeepInfra'];
  const costOf = (n) => (n === 'Bargain Basement' ? 0.0000001 : costAt(0.775)(n));
  const out = costOrderedFallback(pin, { costOf, proven: PROVEN });
  assert.ok(
    out.order.indexOf('Bargain Basement') > out.order.indexOf('DeepInfra'),
    'the cheapest name won without ever having been observed to work',
  );
});

test('⚠️ 3b — a REFUSED provider is pushed behind every ranked name', () => {
  const refused = Object.keys(REFUSED_PROVIDERS)[0];
  assert.ok(refused, 'the refused list is empty — this test asserts nothing');
  const pin = [PIN[0], refused, 'Makora', 'DeepInfra'];
  const costOf = (n) => (n === refused ? 0.0000001 : costAt(0.775)(n));
  const out = costOrderedFallback(pin, { costOf, proven: [...PROVEN, refused] });
  assert.equal(out.order[out.order.length - 1], refused, `${refused} was ranked on price despite a named failure`);
});

test('⭐ the reorder it actually produces today, and it is not cosmetic', () => {
  const out = costOrderedFallback(PIN, { costOf: costAt(0.775), proven: PROVEN });
  assert.equal(out.source, 'cost');
  assert.equal(out.moved, true, 'the pin already happened to be in cost order — re-measure before trusting this file');

  const cheap = costAt(0.775)('DeepInfra');
  const dear = costAt(0.775)('Makora');
  assert.ok(cheap < dear, 'the two priced fallbacks no longer disagree — the finding has expired');
  assert.ok(
    out.order.indexOf('DeepInfra') < out.order.indexOf('Makora'),
    'the dearer fallback is still tried first — the whole point of this change',
  );
  /** Unpriced and unreachable: it keeps its hand-typed place, at the back. */
  assert.equal(providerRateFor(FLASH, 'OpenInference'), null, 'OpenInference got priced — re-check this expectation');
  assert.equal(out.order[out.order.length - 1], 'OpenInference');
});

test('⭐ the ORDER is stable across every cache rate we have ever measured', () => {
  /**
   * ⚠️ THIS IS WHY THE 0.775 CONSTANT IN `model.mjs` IS NOT A HIDDEN DECISION.
   * Our observed cache share has ranged 0% (cold round 1) to 95.8% (pinned and
   * warm). If the winner changed across that band, the constant would be
   * choosing the provider; it does not, so it only changes the numbers printed
   * in a decision doc.
   */
  const seen = new Set();
  for (const rate of [0, 0.32, 0.512, 0.775, 0.958, 0.9998]) {
    seen.add(costOrderedFallback(PIN, { costOf: costAt(rate), proven: PROVEN }).order.join(' > '));
  }
  assert.equal(seen.size, 1, `the fallback order depends on the assumed cache rate: ${[...seen].join(' | ')}`);
});

test('⭐ a one- or two-name pin is left alone — there is nothing to reorder safely', () => {
  for (const pin of [['Venice'], ['Venice', 'DeepInfra']]) {
    const out = costOrderedFallback(pin, { costOf: () => 1, proven: pin });
    assert.deepEqual(out.order, pin);
    assert.equal(out.source, 'static');
  }
});

/**
 * ── ⭐⭐⭐ AND IT REACHES THE WIRE. A pure function nothing calls is the defect ─
 *
 * `project_acuvo_built_and_unwired_is_the_defect` — eight capabilities built and
 * unreached in 48 hours. This drives `callModel` with a stub transport and reads
 * the bodies it actually posts, because a source regex could only ever prove the
 * text changed.
 */
test('🔌⭐⭐ the REAL payload: attempt 1 unchanged, attempt 2 cost-ordered', async () => {
  const bodies = [];
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: false, status: 503, headers: new Map(), text: async () => 'upstream down', json: async () => ({}) };
  };
  const res = await callModel({
    apiKey: 'sk-test-not-a-real-key',
    model: FLASH,
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
    env: {},
  });
  assert.equal(res.ok, false, 'the stub answered 503 and the call reported success');
  assert.equal(bodies.length, 2, 'the two-attempt ladder is gone — the lock has no way out');

  /** ⚠️ ATTEMPT 1 IS THE CACHE FLOOR AND MUST BE BYTE-IDENTICAL TO BEFORE. */
  assert.deepEqual(bodies[0].provider, { only: [PIN[0]] }, 'the warm lock changed — this is almost every round');

  const sent = bodies[1].provider;
  assert.equal(sent.allow_fallbacks, true, 'attempt 2 stopped allowing fallbacks');
  assert.equal(sent.order[0], PIN[0], 'the primary lost its place on the fallback leg');
  assert.ok(
    sent.order.indexOf('DeepInfra') < sent.order.indexOf('Makora'),
    'the wire still carries the hand-typed order — costOrderedFallback is not reaching the payload',
  );
  assert.deepEqual([...sent.order].sort(), [...PIN].sort(), 'the wire gained or lost a provider');
});
