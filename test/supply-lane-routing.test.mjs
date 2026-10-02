/**
 * ── ⭐⭐⭐ THE SUPPLY LADDER, AND THE TRAP THAT WOULD HAVE VOIDED IT ─────────
 *
 * Measured against the live per-model endpoint board on 2026-08-26 (29
 * endpoints; free metadata, zero inference calls), the pin this package has
 * shipped for weeks is the **dearest viable endpoint on the board** and the
 * **only discounted one**. Its cache-miss input moved `0.2024 -> 0.2470`
 * overnight — 22.0% — because a published discount narrowed from 54.0% to
 * 43.9%. Nothing reported it, because we recorded the price and not the
 * discount.
 *
 * So supply is now a LADDER (cheap fp4 for the low rungs, full-precision fp8
 * for the high ones, a named seam for enterprise), and this file holds the four
 * properties that make it safe to have:
 *
 *   1. the default has NOT moved, so nothing routes differently today;
 *   2. every lane is >= 2 names, because a single name plus `allow_fallbacks`
 *      degrades to *anything*, and *anything* on this board is 0.44/M;
 *   3. a lane is never STRICT — it names a class of supply, not a machine
 *      somebody watched serve a round;
 *   4. ⭐⭐ warmth is learnable ON EVERY LANE. That one is the whole file.
 *
 * ⚠️⚠️ ON (4), AND WHY IT IS THE DANGEROUS ONE. `warm-provider.mjs` refuses to
 * learn a provider "not in the configured pin" — a guard added after a stray
 * upstream locked itself in with `allow_fallbacks:false` and charged a multiple
 * on cache reads. It read the DEFAULT PIN table. The moment a session runs on a
 * new lane, the endpoint that legitimately serves it is not in that table, so
 * warmth is refused every round — and the symptom is not an error, it is a
 * permanently cold prefix cache at up to **4.6x** the bill with a byte-identical
 * transcript. The guard written to stop the expensive-silent-failure would have
 * caused one.
 *
 * ⚠️ COSTS $0.00 TO RUN. Every call below goes through a scripted `fetchImpl`.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  PROVIDER_LANES, PROVIDER_PIN_BY_MODEL, KNOWN_PROVIDERS_BY_MODEL,
  SUPPLY_LANE_IDS, LANE_BY_PLAN, DEFAULT_SUPPLY_LANE,
  supplyLaneFrom, providerOrderFor, callModel, DEFAULT_PROVIDER_ORDER,
} from '../lib/model.mjs';
import { freshWarmth, rememberWarm, warmProviderFor, pruneUnchosen } from '../lib/warm-provider.mjs';

const FLASH = 'deepseek/deepseek-v4-flash-0731';

/** One scripted round; returns the body that would have gone on the wire. */
async function sentFor(model, env) {
  const sent = [];
  const fake = async (_u, o) => {
    sent.push(JSON.parse(o.body));
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }) };
  };
  await callModel({ apiKey: 'k', model, messages: [{ role: 'user', content: 'hi' }], tools: [], fetchImpl: fake, env });
  return sent[0];
}

test('⚠️⚠️⚠️ THE DEFAULT HAS NOT MOVED — adding a ladder may not re-route anybody', async () => {
  /**
   * ⭐ THE LADDER IS REACHABLE BEFORE IT IS DEFAULT, ON PURPOSE. Flipping the
   * default is a COORDINATED change: this package welds the pin name into
   * `lib/plan.mjs`'s `MODEL_PRICES[flash].provider`, and
   * `provider-pin-per-model.test.mjs` asserts the two agree — the guard that
   * stopped "the price we quote is not the endpoint we ask for", which is the
   * defect that made pro look 11.2x flash when it was really the routing.
   * Breaking a working guard to move a default would be trading it for a
   * saving.
   */
  assert.equal(DEFAULT_SUPPLY_LANE, 'legacy',
    'the default lane moved — MODEL_PRICES and console/lib/rate-card.ts must move in the SAME change');

  const body = await sentFor(FLASH, {});
  // ⚡ 2026-09-28: `DEFAULT_PROVIDER_ORDER` now names the DEFAULT model's head (v4.1 → Together);
  // the lanes belong to `-0731`, so its unset case must warm-lock ITS pin's head.
  assert.deepEqual(body.provider.only, [PROVIDER_PIN_BY_MODEL[FLASH][0]],
    'the unset case must still warm-lock exactly the endpoint the cost table quotes');
  /**
   * ⚠️ `source` MUST STILL READ `'model'` WITH NOTHING SELECTED. The default
   * lane and the default pin are the same list, so both branches would return
   * the right ORDER — but `'model'` is the string every existing caller has
   * been reading for weeks, and re-labelling an unchanged route is how a later
   * bisect ends up lying about when behaviour moved.
   */
  assert.deepEqual(providerOrderFor(FLASH, {}), { order: [...PROVIDER_PIN_BY_MODEL[FLASH]], source: 'model' });
});

test('⭐ selecting a lane really re-routes — the seam is live, not decorative', async () => {
  for (const lane of SUPPLY_LANE_IDS) {
    const expected = PROVIDER_LANES[FLASH][lane];
    const body = await sentFor(FLASH, { ACUVO_SUPPLY_LANE: lane });
    /**
     * ⚠️ ATTEMPT ONE ONLY. `callModel` sends `{ only: [lead] }` first — a
     * whitelist, because a manual `provider.order` switches OpenRouter's sticky
     * routing off and stickiness is what pins the actual SERVER rather than the
     * company. The ordered fallback leg only runs if that fails, so a happy
     * round never puts it on the wire; it is asserted off `providerOrderFor`.
     */
    assert.deepEqual(body.provider.only, [expected[0]], `${lane}: the warm attempt must whitelist the lane lead`);
    assert.deepEqual(providerOrderFor(FLASH, { ACUVO_SUPPLY_LANE: lane }).order, [...expected],
      `${lane}: the fallback leg must stay inside the lane`);
  }
});

test('⭐ a PLAN selects a lane, and an explicit lane beats it', () => {
  for (const [plan, lane] of Object.entries(LANE_BY_PLAN)) {
    assert.deepEqual(supplyLaneFrom({ ACUVO_PLAN: plan }), { lane, source: 'plan' }, plan);
  }
  assert.deepEqual(supplyLaneFrom({ ACUVO_PLAN: 'scale', ACUVO_SUPPLY_LANE: 'economy' }),
    { lane: 'economy', source: 'env' }, 'naming a lane is an intent; a plan id only implies one');

  /**
   * ⚠️ A ROUTING HINT MAY NEVER BE THE REASON A RUN DOES NOT HAPPEN. Garbage in
   * either variable degrades to the default rather than throwing — the same
   * rule `loadWarmth` follows for a corrupt file.
   */
  for (const bad of [{ ACUVO_SUPPLY_LANE: 'gold' }, { ACUVO_PLAN: 'platinum' }, {}, { ACUVO_SUPPLY_LANE: '' }]) {
    assert.equal(supplyLaneFrom(bad).lane, DEFAULT_SUPPLY_LANE, JSON.stringify(bad));
  }
});

test('⚠️ the explicit override still wins over a lane, and an empty string still unpins', async () => {
  const named = await sentFor(FLASH, { ACUVO_SUPPLY_LANE: 'economy', ACUVO_PROVIDER_ORDER: 'Baidu' });
  assert.deepEqual(named.provider.only, ['Baidu'], 'a human-typed name outranks a lane');

  const off = await sentFor(FLASH, { ACUVO_SUPPLY_LANE: 'economy', ACUVO_PROVIDER_ORDER: '' });
  assert.equal('provider' in off, false, 'the off switch must survive the ladder');
});

test('⚠️⚠️ a lane is never STRICT — it names a class of supply, not a machine that served us', () => {
  /**
   * `callModel` promotes a pin to `allow_fallbacks:false` only when
   * `source === 'env'`. A lane must not qualify: strict turns one provider
   * having a bad ten minutes into an outage for every user on that plan at
   * once, which is exactly the "never single" failure this package refuses.
   */
  assert.equal(providerOrderFor(FLASH, { ACUVO_SUPPLY_LANE: 'economy' }).source, 'lane');
  assert.equal(providerOrderFor(FLASH, { ACUVO_PROVIDER_ORDER: 'OpenInference' }).source, 'env');
  assert.equal(providerOrderFor('somebody/brand-new-model', { ACUVO_SUPPLY_LANE: 'economy' }).source, 'none',
    'a model with no lane table must stay UNPINNED rather than borrow flash\'s ladder');
});

test('⚠️ every lane is at least two names — a single name degrades to *anything*', () => {
  assert.ok(Object.keys(PROVIDER_LANES).length >= 1, 'the lane table is empty, so every test here passes vacuously');
  for (const [model, lanes] of Object.entries(PROVIDER_LANES)) {
    assert.deepEqual(Object.keys(lanes).sort(), [...SUPPLY_LANE_IDS].sort(), `${model} does not cover every lane`);
    for (const [lane, order] of Object.entries(lanes)) {
      assert.ok(order.length >= 2, `${model}/${lane} has ${order.length} name(s) — "never single" is the standing rule`);
      for (const p of order) assert.ok(typeof p === 'string' && p.trim().length >= 2, `${model}/${lane} blank name`);
      assert.equal(new Set(order).size, order.length, `${model}/${lane} repeats a name`);
    }
  }
});

test('⭐⭐⭐ WARMTH IS LEARNABLE ON EVERY LANE — the trap that would have voided the ladder', () => {
  /**
   * Without the union, the economy lane's own lead would be REFUSED by the
   * guard, warmth would never be recorded, and every round would route cold at
   * up to 4.6x for byte-identical input — with no error anywhere.
   */
  for (const [lane, order] of Object.entries(PROVIDER_LANES[FLASH])) {
    for (const provider of order) {
      const s = rememberWarm(freshWarmth(), FLASH, provider);
      assert.equal(warmProviderFor(s, FLASH), provider,
        `${lane}: ${provider} legitimately serves this lane and must be learnable — refusing it means a permanently cold cache`);
    }
  }
});

test('⚠️⚠️ and the widening is BOUNDED — the stray that caused the incident is still refused', () => {
  /**
   * `Novita` is the upstream that learned itself onto this machine, served 6 of
   * 6 runs, and charged a multiple on CACHE READS specifically. It is in no
   * lane and no pin, so the guard must still reject it — on the write path and
   * on the load path.
   */
  assert.equal(KNOWN_PROVIDERS_BY_MODEL[FLASH].includes('Novita'), false);
  assert.equal(warmProviderFor(rememberWarm(freshWarmth(), FLASH, 'Novita'), FLASH), null);

  const stale = freshWarmth();
  stale.byModel.set(FLASH, 'Novita');
  pruneUnchosen(stale);
  assert.equal(warmProviderFor(stale, FLASH), null, 'an unchosen pin must not survive a reload');
});

test('💰 the union is exactly the lanes plus the default pin — no name arrives from nowhere', () => {
  for (const [model, known] of Object.entries(KNOWN_PROVIDERS_BY_MODEL)) {
    const expected = new Set([
      ...(PROVIDER_PIN_BY_MODEL[model] ?? []),
      ...Object.values(PROVIDER_LANES[model] ?? {}).flat(),
    ]);
    assert.deepEqual([...known].sort(), [...expected].sort(), model);
  }
  // Both source tables must be non-empty or the check above passes for the wrong reason.
  assert.ok(Object.keys(PROVIDER_PIN_BY_MODEL).length >= 4);
});
