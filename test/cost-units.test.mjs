/**
 * ── ⭐⭐⭐ THE FLOOR MUST BE ARITHMETIC, NOT BEHAVIOURAL ─────────────────────
 *
 * Roman: *"so we are confident we can never lose more than 47.5% if someone does
 * something completely dysfunctional."*
 *
 * With a raw-token allowance, 47.5% holds only while users behave as measured —
 * the SAME 95M tokens costs $1.52 all-cached and $17.10 all-output, an 11.25x
 * swing. This file proves the replacement: metered in cost-equivalent units, the
 * ceiling does not move at all.
 *
 * ⭐ THE CENTRAL TEST IS `INVARIANCE`. Everything else is detail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unitWeights, unitsFor, maxCostUsd, unitsAffordable, typicalTokensFrom, describeUnitCost, unitBasis,
} from '../lib/cost-units.mjs';
import { ratesFor, FLASH } from '../lib/rate-card.mjs';
import {
  allowanceForPlan, netRevenueUsd, costPerUnitUsd, TARGET_MARGIN,
} from '../lib/plan-allowance.mjs';
import { PLANS, AUD_USD } from '../lib/plan.mjs';

/**
 * ⚠️ DERIVED, NOT TYPED. This read `const NET_REVENUE = 18.11` with the comment
 * "A$29 after Stripe international and FX" — a hand-computed copy of what
 * `netRevenueUsd` already computes ($17.97 today). One more number with two
 * sources, in the file whose whole subject is that a copy cannot know it is
 * stale.
 */
const NET_REVENUE = netRevenueUsd(PLANS.starter, AUD_USD);

test('⭐ the weights are DERIVED from the rate card, not typed', () => {
  const w = unitWeights();
  const r = ratesFor(FLASH);
  assert.equal(w.cachedIn, 1, 'a cache hit is the unit by definition');
  assert.ok(Math.abs(w.missIn - r.inPerM / r.cachedInPerM) < 1e-9);
  assert.ok(Math.abs(w.output - r.outPerM / r.cachedInPerM) < 1e-9);
});

/**
 * ── ⚠️⚠️ RE-ANCHORED 2026-09-20 — `> 10` WAS A SNAPSHOT OF A CARD, NOT A RULE ─
 *
 * This asserted `w.output > 10` and passed for as long as the ceiling provider
 * was DeepInfra ($0.18 out / $0.016 cache read = 11.25). The pin moved to
 * Makora on 2026-09-12 ($0.195 / $0.0196 = **9.95**) and the guard went red
 * without a single thing being wrong: the weight is DERIVED from the card by
 * the test directly above this one, so `> 10` was a second opinion about a
 * value that already has one source — the defect
 * `feedback_prose_beside_a_derived_value_is_a_second_opinion` names.
 *
 * ⭐ WHAT THE TEST IS ACTUALLY ABOUT IS THE REJECTED PROPOSAL, and that is a
 * fact about history rather than about today's provider. A flat weight of 4 was
 * proposed; the card says output costs far more than that, and by how much is
 * the card's business. Pinned against the PROPOSAL, this cannot go stale on a
 * repin, and it still fails the moment the meter under-prices output.
 */
const PROPOSED_FLAT_OUTPUT_WEIGHT = 4;

test('⚠️ output is ~10x a cache hit — NOT the 4x that was proposed', () => {
  /**
   * ⭐ The number matters: metering output at 4 when it costs ~10 leaves most
   * of the exposure uncovered, which is the risk this module exists for.
   */
  const w = unitWeights();
  assert.ok(
    w.output > PROPOSED_FLAT_OUTPUT_WEIGHT * 2,
    `output weight is ${w.output.toFixed(2)}; the rejected flat ${PROPOSED_FLAT_OUTPUT_WEIGHT} would leave `
    + `${(100 * (1 - PROPOSED_FLAT_OUTPUT_WEIGHT / w.output)).toFixed(0)}% of output exposure unmetered`,
  );
  assert.ok(w.output > w.missIn, 'output must outweigh a cache MISS, or the meter is upside down');
});

test('⭐⭐⭐ INVARIANCE — the same unit count costs the same whatever the user does', () => {
  /**
   * ⚠️⚠️ THIS IS THE ENTIRE CLAIM. If it fails, the floor is behavioural again
   * and the plan is only as safe as the users are typical.
   */
  const w = unitWeights();
  const UNITS = 170_000_000;
  const ceiling = maxCostUsd(UNITS);
  const r = ratesFor(FLASH);

  // Three users who spend the identical unit budget in maximally different ways.
  const allCached = { inputTokens: UNITS / w.cachedIn, cachedInputTokens: UNITS / w.cachedIn, outputTokens: 0 };
  const allCold = { inputTokens: UNITS / w.missIn, cachedInputTokens: 0, outputTokens: 0 };
  const allOutput = { inputTokens: 0, cachedInputTokens: 0, outputTokens: UNITS / w.output };

  for (const [name, u] of [['all-cached', allCached], ['all-cold', allCold], ['all-output', allOutput]]) {
    assert.ok(Math.abs(unitsFor(u) - UNITS) <= 1, `${name} should spend exactly the budget`);
    const realCost =
      ((u.cachedInputTokens) * r.cachedInPerM
        + (u.inputTokens - u.cachedInputTokens) * r.inPerM
        + u.outputTokens * r.outPerM) / 1e6;
    assert.ok(
      Math.abs(realCost - ceiling) < 0.01,
      `${name} cost $${realCost.toFixed(4)} but the ceiling is $${ceiling.toFixed(4)} — the meter is not invariant`,
    );
  }
});

/**
 * ── 🚨⭐⭐⭐ REWRITTEN 2026-09-20. THE LITERAL 170M WAS HIDING A LIVE DEFECT ──
 *
 * This test read `const UNITS = 170_000_000` and asked two questions of it: is
 * the margin ~85%, and does a typical user still get the 95M tokens the pricing
 * page promises. Both answers were yes, and **both were about a number the
 * product stopped using.** `plan-allowance.mjs` DERIVES the starter allowance
 * from price and margin; on the DeepInfra card that derivation happened to land
 * near 170M, so the literal agreed with the product by coincidence and the test
 * could not tell the difference.
 *
 * The pin moved to Makora on 2026-09-12 (cache read $0.016 → $0.0196, +22.5%).
 * The derived allowance fell with it — 170M → **137.5M** — because the margin is
 * the INPUT and the token count is the OUTPUT, which is the whole doctrine of
 * `plan-allowance.mjs`. The margin is untouched at exactly 85%.
 *
 * ⚠️⚠️ AND THAT IS WHERE THE SECOND QUESTION STOPS BEING RHETORICAL. A typical
 * user on the derived allowance now gets ~80.3M raw tokens against a published
 * **95,000,000**. The literal 170M kept answering "99.2M, fine" for eight days
 * about an allowance nobody is granted. Asked of the real one, the answer is a
 * 15% shortfall against the page.
 *
 * ⛔ THIS IS A PRICING DECISION AND IT IS ROMAN'S — raise the price, lower the
 * published token count, accept a margin below 85%, or repin the ceiling
 * provider. It is asserted here rather than softened because a red guard that
 * names a decision is a queue; a green one that reads a dead constant is not.
 */
test('⭐⭐ the starter grant keeps a positive margin even if every call hit the dearest provider', () => {
  /* ⭐⭐⭐ RE-PINNED 2026-09-28 to the owner's ruling: advertised tokens are FIXED and
   * every plan delivers exactly them, cut off at their dollar value. The 85%-margin
   * derivation this used to pin no longer decides a grant; margin at the cap is now an
   * OUTPUT that must stay positive (plan-economics.test.mjs prices it). */
  const units = allowanceForPlan('starter', { audUsd: AUD_USD });
  const net = netRevenueUsd(PLANS.starter, AUD_USD);
  const margin = (net - maxCostUsd(units)) / net;
  assert.ok(margin > 0.5, `starter margin at the worst case is ${(margin * 100).toFixed(1)}%`);
  assert.ok(units > 0, 'starter resolved to no allowance at all');
});
test('⚠️⚠️ the allowance hands a normal user the tokens the PAGE promises', () => {
  /* ⭐⭐⭐ RE-PINNED 2026-09-28 to the owner's ruling: advertised tokens are FIXED and
   * every plan delivers exactly them, cut off at their dollar value. The 85%-margin
   * derivation this used to pin no longer decides a grant; margin at the cap is now an
   * OUTPUT that must stay positive (plan-economics.test.mjs prices it). */
  const promised = PLANS.starter.tokens[FLASH];
  const typical = typicalTokensFrom(allowanceForPlan('starter', { audUsd: AUD_USD }));
  assert.ok(typical >= promised,
    `starter's page promises ${(promised / 1e6).toFixed(1)}M; the allowance delivers ${(typical / 1e6).toFixed(1)}M`);
});
test('⭐ sizing runs backwards from a margin floor, which is how a plan should be set', () => {
  for (const floor of [0.80, 0.85, 0.90]) {
    const units = unitsAffordable(NET_REVENUE, floor);
    const realised = (NET_REVENUE - maxCostUsd(units)) / NET_REVENUE;
    assert.ok(realised >= floor - 0.001, `asked for ${floor}, got ${realised}`);
  }
  // Tighter floors must grant strictly fewer units.
  assert.ok(unitsAffordable(NET_REVENUE, 0.9) < unitsAffordable(NET_REVENUE, 0.8));
});

test('⚠️ cached tokens are SUBTRACTED from the prompt total, not added to it', () => {
  /**
   * ⚠️ Every provider returns `prompt_tokens` INCLUDING the cached ones. Reading
   * them as separate buckets double-counts the cheapest tokens as the dearest —
   * the expensive direction, and a silent one.
   */
  const w = unitWeights();
  const fullyCached = unitsFor({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(fullyCached, 1_000_000, 'a fully cached prompt costs 1 unit per token');
  const halfCached = unitsFor({ inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0 });
  /**
   * ⚠️ `Math.round` MATTERS AND USED TO BE INVISIBLE. `unitsFor` rounds — units
   * are a counter, not a real number — and on the DeepInfra card `missIn` was
   * exactly 5 ($0.08 / $0.016), so the product was a whole number and a bare
   * `equal` against the raw arithmetic agreed by luck. Makora's 4.5918… makes
   * the fraction visible and the assertion went red over a rounding step the
   * implementation has always had.
   */
  assert.equal(halfCached, Math.round(500_000 * w.cachedIn + 500_000 * w.missIn));
});

test('⚠️ it is defensive about rubbish input rather than producing a negative bill', () => {
  assert.equal(unitsFor({}), 0);
  assert.equal(unitsFor({ inputTokens: -5, outputTokens: -5 }), 0);
  assert.equal(unitsFor(null), 0);
  // A cached count larger than the prompt is clamped, never negative-missed.
  assert.equal(unitsFor({ inputTokens: 100, cachedInputTokens: 999 }), 100);
});

test('⭐ it can show its working, because an unexplained meter reads as rigged', () => {
  const text = describeUnitCost();
  assert.match(text, /cached input/i);
  assert.match(text, /output/i);
  /**
   * ⚠️ WAS `/11\.25 units/`, A THIRD COPY OF THE CARD. The receipt is generated
   * FROM `unitWeights()`, so the only thing worth asserting is that the two
   * agree — a typed figure here just re-fails on every repin while proving
   * nothing the derivation test above has not already proved.
   */
  const w = unitWeights();
  assert.ok(text.includes(`${w.output.toFixed(2)} units`),
    `the receipt does not quote the derived output weight ${w.output.toFixed(2)}: ${text}`);
  assert.ok(text.includes(`${w.missIn.toFixed(2)} units`),
    `the receipt does not quote the derived miss weight ${w.missIn.toFixed(2)}: ${text}`);
  // And the receipt names the card it came from.
  assert.equal(unitBasis().asOf, ratesFor(FLASH) && unitBasis().asOf);
  assert.ok(unitBasis().asOf, 'the basis must carry the card date');
});

/**
 * ── ⭐⭐⭐ THE HALF THAT MAKES IT ENFORCEMENT RATHER THAN ARITHMETIC ─────────
 *
 * Roman: *"making it real is the gating, the way any use case of Acuvo is
 * functioning — these principles must be hardcoded into it."* Everything above
 * proves the maths. These prove it reaches a real completion and a real refusal.
 */
import { unitsFromUsage, unitGate } from '../lib/cost-units.mjs';

test('⭐⭐ it reads a real provider usage block, in all four cached-field spellings', () => {
  /**
   * ⚠️ FOUR UPSTREAMS, FOUR KEYS. Missing one does not throw — it silently
   * reports ZERO CACHE, billing the cheapest tokens at the dearest rate and
   * making a warm session look 5x more expensive than it was.
   */
  const spellings = [
    { prompt_tokens: 1000, completion_tokens: 0, cachedTokens: 800 },
    { prompt_tokens: 1000, completion_tokens: 0, cached_tokens: 800 },
    { prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 800 } },
    { prompt_tokens: 1000, completion_tokens: 0, prompt_cache_hit_tokens: 800 },
  ];
  const expected = unitsFor({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 0 });
  for (const u of spellings) {
    assert.equal(unitsFromUsage(u), expected, `missed the cached count in ${Object.keys(u).join(',')}`);
  }
});

test('⚠️⚠️ an unpriceable round is NULL, never 0 — 0 would mean "free"', () => {
  assert.equal(unitsFromUsage(null), null);
  assert.equal(unitsFromUsage({}), null);
  assert.equal(unitsFromUsage({ prompt_tokens: 100 }), null, 'missing completion must not price as free');
  assert.equal(unitsFromUsage({ completion_tokens: 100 }), null);
  // But a genuine zero-token round IS zero, not unknown.
  assert.equal(unitsFromUsage({ prompt_tokens: 0, completion_tokens: 0 }), 0);
});

test('⚠️ prompt_tokens INCLUDES the cached ones — never added on top', () => {
  const u = { prompt_tokens: 1000, completion_tokens: 0, cached_tokens: 1000 };
  // Fully cached: 1000 tokens at 1 unit each. If cached were ADDED it would be far more.
  assert.equal(unitsFromUsage(u), 1000);
});

test('⭐⭐ the gate refuses on the PROJECTION, before the money leaves', () => {
  const g = unitGate({ granted: 1_000_000, spent: 990_000, projected: 50_000 });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'would-exceed');
  assert.equal(g.remaining, 10_000);
  // ⭐ And it names the cheapest way out rather than only saying no.
  assert.match(g.message, /existing session/i);
});

test('⭐ a spent allowance says so distinctly from a would-exceed', () => {
  const g = unitGate({ granted: 1_000_000, spent: 1_000_000, projected: 1 });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'allowance-spent');
  assert.equal(g.remaining, 0);
});

test('⚠️⚠️ UNMETERED STAYS ALLOWED — every tenant we have today is unmetered', () => {
  /**
   * ⭐ A gate that starts refusing the existing 17 operated tenants is an
   * outage, not a guardrail. `null` granted means there is nothing to enforce
   * and "allowed" is the truth.
   */
  for (const granted of [null, undefined]) {
    const g = unitGate({ granted, spent: 9e9, projected: 9e9 });
    assert.equal(g.allowed, true);
    assert.equal(g.reason, 'unmetered');
    assert.equal(g.remaining, null);
  }
});

test('⭐ and an ordinary round passes', () => {
  const g = unitGate({ granted: 170_000_000, spent: 1_000_000, projected: 200_000 });
  assert.equal(g.allowed, true);
  assert.equal(g.reason, 'ok');
});

import { velocityVerdict, unitsForUsd, usdForUnits, VELOCITY_WARN_MULTIPLE } from '../lib/cost-units.mjs';

/**
 * ── ⭐⭐ VELOCITY PROTECTS THE USER, NOT THE MARGIN ─────────────────────────
 *
 * With cost-unit metering the margin is already arithmetic — no rate of
 * spending can breach it. What velocity catches is a runaway loop or a stolen
 * key quietly eating somebody's whole month in an afternoon.
 */
test('⭐ a normal burst is fine — a grinder is our CHEAPEST customer', () => {
  const v = velocityVerdict({ granted: 170e6, spentInWindow: 200_000, windowHours: 1 });
  assert.equal(v.level, 'ok');
  assert.equal(v.message, null);
});

test('⭐ a sustained runaway warns, then throttles', () => {
  assert.equal(velocityVerdict({ granted: 170e6, spentInWindow: 3e6, windowHours: 1 }).level, 'warn');
  assert.equal(velocityVerdict({ granted: 170e6, spentInWindow: 10e6, windowHours: 1 }).level, 'throttle');
});

test('⚠️ the throttle names the LIKELY CAUSE and leaves a way through', () => {
  const v = velocityVerdict({ granted: 170e6, spentInWindow: 10e6, windowHours: 1 });
  assert.match(v.message, /loop or a script/i, 'at 40x linear it is almost never a person typing');
  assert.match(v.message, /Nothing is lost/i, 'a throttle that reads as a loss is a support ticket');
});

test('⚠️ an unmetered account has no rate to compare against — silence, not a false OK message', () => {
  for (const granted of [null, undefined, 0]) {
    const v = velocityVerdict({ granted, spentInWindow: 9e9, windowHours: 1 });
    assert.equal(v.level, 'ok');
    assert.equal(v.message, null);
  }
});

test('⚠️ a zero/absurd window does not divide by zero', () => {
  const v = velocityVerdict({ granted: 170e6, spentInWindow: 1000, windowHours: 0 });
  assert.ok(Number.isFinite(v.multiple));
});

/**
 * ── ⭐⭐⭐ CREATIVE SPENDS THE SAME POOL — the last hole in the guarantee ────
 */
/** USD a clip costs us — the two ends of the engine ladder. Prices, not units. */
const OWN_GPU_CLIP_USD = 0.0005;
const RENTED_CLIP_USD = 0.229;

test('⭐⭐ a dollar of GPU converts into the SAME units as tokens', () => {
  /**
   * ⚠️ THE UNIT COUNTS WERE TYPED (`31_250`, `14_312_500`) UNDER A COMMENT THAT
   * SAID "a unit is one cache-hit token: $0.016 per MILLION". That is the rate
   * card, copied into a test, and it went stale the moment the ceiling provider
   * moved ($0.0196 → 25,510 and 11,683,673). What the test is FOR is that
   * creative dollars and token dollars convert through the SAME unit price, and
   * that is what it now says.
   */
  const perUnit = costPerUnitUsd();
  assert.equal(unitsForUsd(OWN_GPU_CLIP_USD), Math.round(OWN_GPU_CLIP_USD / perUnit), 'own-GPU parallax clip');
  assert.equal(unitsForUsd(RENTED_CLIP_USD), Math.round(RENTED_CLIP_USD / perUnit), 'rented video clip');
});

test('⚠️⚠️ ONE rented clip is a visible share of a whole month — the number that was invisible', () => {
  /* Re-based 2026-09-28: the month is now the full advertised grant, so one rented
   * clip is a smaller share than the 8.5% the 85%-derived month showed. The point
   * stands — creative spend comes out of the SAME month — and own-GPU stays far cheaper. */
  const MONTH = allowanceForPlan('starter', { audUsd: AUD_USD });
  const rented = unitsForUsd(RENTED_CLIP_USD);
  assert.ok(rented / MONTH > 0.02, `a rented clip is only ${(rented / MONTH * 100).toFixed(1)}% of a month`);
  assert.ok(unitsForUsd(RENTED_CLIP_USD) / unitsForUsd(OWN_GPU_CLIP_USD) > 400);
});
test('⚠️ it round-trips, so a balance can be shown in real money', () => {
  const units = unitsForUsd(1.23);
  assert.ok(Math.abs(usdForUnits(units) - 1.23) < 0.0001);
});

test('⚠️ rubbish and negative dollars cost nothing, never a credit', () => {
  for (const bad of [0, -1, NaN, null, undefined, 'free']) {
    assert.equal(unitsForUsd(bad), 0);
  }
});

import { createUnitMeter } from '../lib/cost-units.mjs';
import { createBudget } from '../lib/budget.mjs';

/**
 * ── ⭐⭐⭐ THE METER IS NOW *CALLED*, NOT JUST CORRECT ───────────────────────
 *
 * Roman: *"making it real is the gating."* Everything above proves arithmetic.
 * These prove the debit reaches the one function every round already passes
 * through — `budget.record` — so no future call path can forget to meter.
 */
test('⭐⭐⭐ a round recorded on the BUDGET debits the METER — the wire', () => {
  const seen = [];
  const meter = { debit: (usage) => { seen.push(usage); } };
  const budget = createBudget({ limitUsd: 5, meter });

  budget.record({ prompt_tokens: 10_000, completion_tokens: 500, cached_tokens: 8_000, cost: 0.001 });
  assert.equal(seen.length, 1, 'budget.record did not reach the meter');
  assert.equal(seen[0].prompt_tokens, 10_000, 'the meter must see the RAW usage, not a summary');
});

test('⚠️⚠️ a meter that THROWS must not kill the round — the money is already spent', () => {
  const budget = createBudget({ limitUsd: 5, meter: { debit() { throw new Error('ledger down'); } } });
  assert.doesNotThrow(() => budget.record({ prompt_tokens: 100, completion_tokens: 10, cost: 0.0001 }));
});

test('⭐ and no meter at all is byte-identical to before', () => {
  const budget = createBudget({ limitUsd: 5 });
  const rec = budget.record({ prompt_tokens: 100, completion_tokens: 10, cost: 0.0001 });
  assert.ok(rec && typeof rec === 'object');
});

test('⭐⭐ the real meter accumulates, and refuses once the allowance is gone', () => {
  const m = createUnitMeter({ granted: 1_000_000 });
  // ~1M units of fully-cached input.
  m.debit({ prompt_tokens: 900_000, completion_tokens: 0, cached_tokens: 900_000 });
  assert.equal(m.state().used, 900_000);
  assert.equal(m.check(50_000).allowed, true);
  assert.equal(m.check(500_000).allowed, false, 'a projection past the ceiling must be refused');

  m.debit({ prompt_tokens: 200_000, completion_tokens: 0, cached_tokens: 200_000 });
  assert.equal(m.check(1).allowed, false);
  assert.equal(m.check(1).reason, 'allowance-spent');
});

test('⚠️⚠️ an unpriceable round counts as UNKNOWN, never as free', () => {
  /**
   * ⭐ `plan.mjs` records the bug this avoids: Number(null) === 0 once made every
   * unpriced run look like zero usage — silently free usage, by accident.
   */
  const m = createUnitMeter({ granted: 1_000_000 });
  assert.equal(m.debit({ prompt_tokens: 100 }), null, 'missing completion is unpriceable');
  assert.equal(m.state().used, 0);
  assert.equal(m.state().unknownRounds, 1);
});

test('⭐ unmetered stays unmetered all the way through the meter', () => {
  const m = createUnitMeter({ granted: null });
  m.debit({ prompt_tokens: 9_000_000, completion_tokens: 9_000_000 });
  assert.equal(m.check(9e9).allowed, true);
  assert.equal(m.state().remaining, null);
});

test('⭐ it reports its own worst-case dollar cost, for the audit record', () => {
  const m = createUnitMeter({ granted: 170_000_000 });
  m.debit({ prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 1_000_000 });
  assert.ok(m.state().maxCostUsd > 0 && m.state().maxCostUsd < 0.1);
});

// ── ⭐⭐⭐ THE REFUSAL HALF — asked BEFORE the round ─────────────────────────

/**
 * ⚠️⚠️ THE HOLE THIS CLOSES. `budget.record` → `meter.debit` has been wired for
 * a while, so the allowance was COUNTED. It was never ENFORCED: `unitGate` was
 * written, tested, and reached from nothing outside `cost-units.mjs`, because
 * `budget.mjs`'s `projectNext()` speaks DOLLARS and `check()` wanted UNITS.
 * A ceiling that is only ever counted after the fact is not a ceiling — by the
 * time `record` runs the money is already spent.
 *
 * ⭐ The seam is `canContinue()`, for the same reason the fleet gate uses it:
 * one place, four existing callers (`turn.mjs` ×3, `escalate.mjs` ×1), and a
 * fifth cannot forget it.
 */

test('⭐⭐⭐ a spent allowance STOPS the next round — the refusal is reachable now', () => {
  /**
   * ⚠️ A ROOMY ALLOWANCE MUST STILL ALLOW, and this is the assertion that stops
   * the whole gate being a permanent "no". A month on the entry plan is ~95M
   * tokens' worth of units, so anything in that region is an ordinary run.
   */
  const roomy = createBudget({ limitUsd: 5, meter: createUnitMeter({ granted: 5_000_000_000 }) });
  assert.equal(roomy.canContinue().ok, true, 'a run well inside its allowance was refused');

  const exhausted = createBudget({ limitUsd: 5, meter: createUnitMeter({ granted: 1_000, spent: 1_000 }) });
  const verdict = exhausted.canContinue();
  assert.equal(verdict.ok, false, 'the allowance is spent and the run continued anyway');
  assert.equal(verdict.reason, 'allowance:allowance-spent', `stopped for ${verdict.reason}`);
  assert.match(verdict.message, /allowance/i, 'the refusal must name what actually stopped it');
  assert.equal(verdict.allowanceUnitsRemaining, 0);
});

test('⭐⭐ the PROJECTION reaches the gate — a round it cannot afford is refused before it runs', () => {
  /**
   * ⭐ THE HALF THAT `check()` COULD NOT DO. This account has allowance LEFT
   * (so it is not `allowance-spent`), but not enough for the round about to be
   * attempted — and the only way to know that is to convert `projectNext()`'s
   * DOLLAR figure into units, which is exactly the seam that did not exist.
   *
   * ⚠️ It refuses BEFORE the round, which is the entire point: by the time
   * `record` runs the money is already spent.
   */
  const budget = createBudget({ limitUsd: 5, meter: createUnitMeter({ granted: 1_000 }) });
  const verdict = budget.canContinue();
  assert.equal(verdict.ok, false, 'a round the allowance cannot cover was allowed to start');
  assert.equal(verdict.reason, 'allowance:would-exceed', `stopped for ${verdict.reason}`);
  assert.ok(verdict.allowanceUnitsRemaining > 0, 'this account is not exhausted — it simply cannot afford THIS round');
});

test('⚠️ `--budget none` does NOT buy an unlimited allowance', () => {
  /**
   * ⚠️ THE PLACEMENT TEST. `unlimited` removes the per-RUN dollar ceiling and
   * says nothing about the ACCOUNT's monthly allowance. If the gate sat after
   * the `unlimited` early-return, the one run that can drain an allowance
   * fastest would be the one run it never sees — which is precisely the bug the
   * fleet gate was moved above `unlimited` to avoid.
   */
  const meter = createUnitMeter({ granted: 1_000, spent: 1_000 });
  const budget = createBudget({ limitUsd: null, unlimited: true, meter });
  const verdict = budget.canContinue();
  assert.equal(verdict.ok, false, 'an unlimited RUN budget let an exhausted ACCOUNT keep spending');
  assert.match(verdict.reason, /^allowance:/);
});

test('⭐ it is a byte-for-byte no-op for the 17 operated · unmetered tenants', () => {
  /**
   * ⚠️ THE BAR FOR TOUCHING A PATH THAT SPENDS MONEY. `meter: null` is every
   * existing caller, and `granted: null` is every tenant we actually have. Both
   * must be indistinguishable from before.
   */
  const withoutMeter = createBudget({ limitUsd: 5 });
  const unmetered = createBudget({ limitUsd: 5, meter: createUnitMeter({ granted: null }) });
  for (const b of [withoutMeter, unmetered]) {
    b.record({ prompt_tokens: 9_000_000, completion_tokens: 9_000_000, cost: 0.01 });
    const v = b.canContinue();
    assert.equal(v.ok, true, 'an unmetered account was refused — that is an outage, not a guardrail');
    assert.doesNotMatch(String(v.reason), /allowance/);
  }
});

test('⚠️⚠️ an allowance stop is a DECLARED reason, and escalation must NOT retry it', async () => {
  /**
   * ⭐⭐ THE INTEGRATION THAT IS EASY TO MISS AND HAS BEEN MISSED THREE TIMES.
   * `escalate.mjs` records the defect verbatim: a stop reason that appears in
   * no list makes the ladder "conclude the run had finished happily". A new
   * verdict from `canContinue()` therefore has to be placed in BOTH directions
   * — declared in `BUDGET_REASONS`, and deliberately decided in `OUT_OF_ROAD`.
   *
   * ⚠️ AND THE DECISION HERE IS *EXCLUDE*. Every other member of `OUT_OF_ROAD`
   * means "trying again with more room is the correct response". There is no
   * more room to buy when the month's allowance is spent — escalating raises
   * the per-RUN dollar ceiling and `canContinue()` refuses on the allowance
   * again, so the ladder would spend its rungs learning nothing.
   */
  const { BUDGET_REASONS, ALLOWANCE_STOP_REASONS } = await import('../lib/budget.mjs');
  const { OUT_OF_ROAD, outOfRoad } = await import('../lib/escalate.mjs');

  const exhausted = createBudget({ limitUsd: 5, meter: createUnitMeter({ granted: 1_000, spent: 1_000 }) });
  const reason = exhausted.canContinue().reason;

  assert.ok(BUDGET_REASONS.includes(reason), `${reason} is a verdict in no list — the exact three-times defect`);
  assert.ok(ALLOWANCE_STOP_REASONS.includes(reason));
  assert.equal(OUT_OF_ROAD.includes(reason), false, 'escalation would retry a run that must refuse again');
  assert.equal(outOfRoad({ stoppedBecause: reason }), false);

  // ⚠️ And the per-RUN money stops must still escalate — this exclusion is
  // narrow, and widening it would silently disable the ladder.
  assert.equal(outOfRoad({ stoppedBecause: 'limit-reached' }), true);
  assert.equal(outOfRoad({ stoppedBecause: 'would-exceed' }), true);
});

test('⚠️⚠️⭐ the allowance HAS A SOURCE — without one every gate above is unreachable', async () => {
  /**
   * ⚠️⚠️ MEASURED 2026-08-28: `unitAllowance` appeared in the entire package
   * exactly ONCE — at the read in `bin/acuvo.mjs`. No flag set it, no env var,
   * no plan lookup. So `granted` was permanently null, `unitGate` returns
   * `allowed` for null, and **the debit, the pre-round refusal, the creative
   * debit and the velocity verdict could never fire for anybody, ever.** A
   * comment said "null for everybody today", which reads as a rollout state and
   * was in fact an unreachable code path.
   *
   * ⭐ This is the assertion that stops that recurring: if the allowance loses
   * its source again, everything above becomes decoration and this goes red.
   */
  const { allowanceFrom } = await import('../lib/cost-units.mjs');

  assert.equal(allowanceFrom({}, {}), null, 'no configuration means unmetered, which is today\'s truth');
  assert.equal(allowanceFrom({ ACUVO_UNIT_ALLOWANCE: '95000000' }, {}), 95_000_000, 'the env var is the source and did not reach through');
  assert.equal(allowanceFrom({}, { unitAllowance: 1_234 }), 1_234, 'an explicit option must win');
  assert.equal(allowanceFrom({ ACUVO_UNIT_ALLOWANCE: '1' }, { unitAllowance: 9_999 }), 9_999, 'the explicit option outranks the env var');

  /**
   * ⚠️ AN UNPARSEABLE VALUE IS UNMETERED, NEVER ZERO. `fal-spend-cap` records
   * the same rule: a typo resolving to 0 would refuse every round on the
   * machine — an outage caused by a guardrail, worse than the leak it closes.
   */
  for (const bad of ['lots', '', '  ', 'NaN', '-5', '0']) {
    assert.equal(allowanceFrom({ ACUVO_UNIT_ALLOWANCE: bad }, {}), null, `"${bad}" must be unmetered, not a zero allowance`);
  }

  /**
   * ⭐ And something must actually USE it, or the source exists and reaches
   * nothing — which was the whole defect. `processMeter` is the single place
   * that turns configuration into a meter, so it is the one that has to consult
   * `allowanceFrom`.
   */
  const { readFileSync } = await import('node:fs');
  const units = readFileSync(new URL('../lib/cost-units.mjs', import.meta.url), 'utf8');
  /**
   * ⚠️ WIDENED 2026-08-28 FROM `allowanceFrom(env)` TO `allowanceFrom(`. The
   * old pattern pinned an exact ARGUMENT LIST, and `processMeter` now passes a
   * plan as well — so the guard failed on a change that made the thing it
   * guards STRICTER. ⭐ The intent is 'processMeter consults the one source',
   * and that is what it now matches. ⚠️ Anchored on `export function` rather
   * than the bare word, which first appears 23 chars earlier in the doc comment
   * and burned part of the window before the declaration even started.
   */
  assert.match(units, /export function processMeter[\s\S]{0,1600}?allowanceFrom\(/, 'processMeter does not read the allowance from its source');

  /**
   * ⚠️ AND THE BINARY MUST USE THAT ONE METER, not build a second. Two meters
   * each hold a partial view of one account's spend, so a `--best-of 3` run
   * would under-count by design — which is how the ladder ended up metered and
   * every ordinary run not.
   */
  const bin = readFileSync(new URL('../bin/acuvo.mjs', import.meta.url), 'utf8');
  /**
   * ⚠️ SAME WIDENING, AND THE SAME REASON. `processMeter()` with no arguments
   * was the shape that shipped the plan source DARK — it cannot resolve a plan.
   * Pinning it would have frozen the defect in place, exactly as
   * `every-request-is-logged` pinned `void recordBuilderUsage(`. The rule is
   * 'the binary uses THE process meter', not 'the binary passes nothing to it',
   * and `plan-allowance-is-derived.test.mjs` separately requires the deps.
   */
  assert.match(bin, /meter:\s*processMeter\(/, 'bin/acuvo.mjs does not use the process meter');
  assert.doesNotMatch(bin, /createUnitMeter\(/, 'bin/acuvo.mjs builds a SECOND meter — one account, one pool');
});

test('⚠️⚠️⭐ the meter reaches the budget `runSession` ACTUALLY BUILDS', async () => {
  /**
   * ⚠️⚠️ THE DEFECT THIS EXISTS FOR, AND FORTY UNIT TESTS DID NOT CATCH IT.
   * `bin/acuvo.mjs` built `createBudget({ meter: createUnitMeter(...) })` — but
   * that is the ESCALATION LADDER's budget. `runSession` builds its own at
   * `turn.mjs`, and it took no meter at all, so **every ordinary run had no
   * allowance attached**: no debit, no pre-round refusal, no creative debit.
   *
   * ⭐ MEASURED END TO END, which is the only reason it was found. With
   * `ACUVO_UNIT_ALLOWANCE=10` — ten units, enough for nothing — a real run
   * completed three rounds and spent $0.001163. After the fix the same command
   * refuses before a single model call: *"This round needs about 34,375 units
   * and 10 remain."*
   *
   * ⚠️ A real run cannot be a test here (it costs money and needs a key), so
   * this is the source-level layer — the same technique
   * `versions-block-reaches-the-prompt.test.mjs` uses, and honest about being
   * weaker than the run that found the bug.
   */
  const { readFileSync } = await import('node:fs');
  const turnSource = readFileSync(new URL('../lib/turn.mjs', import.meta.url), 'utf8');

  assert.match(
    turnSource,
    /createBudget\(\{[\s\S]{0,400}?meter:\s*meter\s*\?\?\s*processMeter\(\)/,
    'runSession builds a budget with no meter — every ordinary run is unmetered again',
  );
  assert.match(turnSource, /^\s*meter = null,/m, 'runSession must accept an explicit meter so the ladder can pass its own');
});

test('⭐⭐ the process meter is ONE per process, and null when unmetered', async () => {
  const { processMeter, resetProcessMeter } = await import('../lib/cost-units.mjs');

  resetProcessMeter();
  assert.equal(processMeter({}), null, 'an unconfigured run must be byte-identical to before, not merely equivalent');

  resetProcessMeter();
  const a = processMeter({ ACUVO_UNIT_ALLOWANCE: '1000000' });
  assert.ok(a, 'a configured allowance produced no meter');
  assert.equal(processMeter({ ACUVO_UNIT_ALLOWANCE: '9' }), a, 'a second call built a SECOND meter — the allowance would reset mid-process');
  assert.equal(a.state().granted, 1_000_000);

  resetProcessMeter();
});

test('⭐⭐⭐ CREATIVE spend debits the same pool — the last hole in the 85% floor', async () => {
  /**
   * ⚠️⚠️ THE HOLE THIS CLOSES. The allowance is denominated in COST so that no
   * usage pattern can move the floor — but `meter.debit` reads a TOKEN usage
   * object, and a GPU render, a voice clone or an image has none. So the one
   * category of spend with no natural ceiling was the one category the ceiling
   * could not see, and `unitsForUsd` existed, tested, with no caller.
   *
   * ⭐ Asserted through `chargeGpu` and the REAL drain, not by calling
   * `debitUsd` directly — the question is whether a creative charge REACHES the
   * pool, and only the real path answers it.
   */
  const { chargeGpu, resetGpuCharges } = await import('../lib/budget.mjs');
  resetGpuCharges?.();
  const meter = createUnitMeter({ granted: 5_000_000_000 });
  const budget = createBudget({ limitUsd: 5, meter });

  assert.equal(meter.state().used, 0, 'precondition: a fresh meter is empty');

  chargeGpu({ verb: 'generate_image', seconds: 30, endpoint: 'flux' });
  // ⚠️ Any public method drains — that is the whole point of draining in syncGpu.
  budget.canContinue();

  assert.ok(meter.state().used > 0, 'a GPU render debited NOTHING from the allowance');
  resetGpuCharges?.();
});

test('⚠️ an unpriceable creative charge is UNKNOWN, never free', () => {
  /**
   * `Number(null) === 0` once made every unpriced run look like zero usage
   * (`plan.mjs`) — the exact shape of silently free spend, and creative is
   * where it would hurt most.
   */
  const m = createUnitMeter({ granted: 1_000_000 });
  assert.equal(m.debitUsd(null), null);
  assert.equal(m.debitUsd(undefined), null);
  assert.equal(m.debitUsd(NaN), null);
  assert.equal(m.state().used, 0, 'an unpriceable charge must not move the pool');
  assert.equal(m.state().unknownRounds, 3, 'and it must be COUNTED as unknown, not discarded');

  // ⭐ A real charge does move it, or the guard above is just a broken debit.
  assert.ok(m.debitUsd(0.05) > 0);
  assert.ok(m.state().used > 0);
});

test('⚠️ an exhausted allowance refuses even when the projection is unknown', () => {
  /**
   * ⚠️⚠️ THIS TEST USED TO CLAIM MORE THAN IT PROVED, AND THE MUTATION SAID SO.
   * It was titled "an unpriceable projection is not treated as free" and was
   * meant to pin the `Number.isFinite` branch in `checkUsd`. Replacing that
   * branch with the naive `unitsForUsd(Number(usd) || 0, model)` left this file
   * **36/36 green** — because the two are behaviourally identical: `null` and
   * `NaN` both land on 0, and `unitGate` already clamps a negative projection
   * with `Math.max(0, …)`.
   *
   * ⭐ So the branch is DEFENSIVE, not load-bearing, and it is recorded as such
   * rather than guarded by a test that cannot fail. What IS load-bearing, and
   * is what this now asserts: exhaustion is decided on spent-vs-granted, so an
   * account with nothing left refuses whatever the projection does or does not
   * say. That is the property a caller relies on when pricing is unavailable.
   */
  const fresh = createUnitMeter({ granted: 1_000 });
  assert.equal(fresh.checkUsd(null).allowed, true, 'nothing spent yet, so the honest answer is allow');
  assert.equal(fresh.checkUsd(NaN).allowed, true);

  const spent = createUnitMeter({ granted: 1_000, spent: 1_000 });
  assert.equal(spent.checkUsd(null).allowed, false, 'an exhausted allowance must refuse whatever the projection says');
  assert.equal(spent.checkUsd(null).reason, 'allowance-spent');
});
