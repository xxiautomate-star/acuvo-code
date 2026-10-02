/**
 * ── ⭐⭐⭐ THE PLAN IS THE ALLOWANCE. ONE NUMBER, ONE GATE ────────────────────
 *
 * Roman, 2026-08-28: *"all we should have to do is set a gate. In a month if a
 * $29 user hits that, that's their usage."* And: *"the economics and pricing
 * shit has fucked us and the real ones need to be unforgettable."*
 *
 * ⚠️⚠️ THERE WERE TWO GATES AND NEITHER FIRED. `PLANS` grants RAW TOKENS
 * (95,000,000 flash on Starter). `cost-units.mjs` meters COST UNITS and reads
 * its ceiling from `ACUVO_UNIT_ALLOWANCE` — an env var, set by nothing. So:
 *
 *   · the raw-token ladder was the number on the pricing page and enforced
 *     nowhere;
 *   · the unit meter was the number the 85% guarantee rests on and had no
 *     source;
 *   · and the two disagree. 95M raw tokens AT OUR MEASURED SHAPE is ~244M
 *     units — **$3.91 worst case, not $2.72.** The pricing page and the
 *     guarantee were describing different products.
 *
 * ── ⭐ SO THE ALLOWANCE IS DERIVED FROM PRICE AND MARGIN, NEVER TYPED ────────
 *
 * `unitsForPlan` computes what a plan may spend from three things we already
 * hold and none we invent:
 *
 *     units = (priceUSD × (1 − targetMargin)) ÷ costPerUnitUSD
 *
 * where `costPerUnitUSD` comes from `unitWeights()` and the rate card. Change
 * the price, the margin, or a provider's rate, and the ceiling moves with it —
 * there is no second number to update and no way for one to go stale. That is
 * what "unforgettable" has to mean in code: not a comment saying remember, but
 * an arithmetic path where forgetting is impossible.
 *
 * ⚠️ THE MARGIN IS THE INPUT AND THE TOKENS ARE THE OUTPUT — that inversion is
 * the whole point. Every previous version picked a token count and then asked
 * what margin it produced, which is how six different "worst cases" got quoted.
 * Fix the margin, and the token count is a consequence you can publish.
 */

import { PLANS } from './plan.mjs';
import { unitWeights, typicalTokensFrom } from './cost-units.mjs';
import { ratesFor, FLASH, MEASURED_BLENDED_USD_PER_M } from './rate-card.mjs';

/**
 * ⭐ 85% is the settled floor (`ECONOMICS-SETTLED.md`). It is a FLOOR, not a
 * forecast: the meter refuses past it, so the realised margin is this or better
 * for every customer, whatever they do.
 */
export const TARGET_MARGIN = 0.85;

/**
 * ⚠️ WHAT REACHES US, NOT WHAT THEY PAY. A$29 is not $29, and Stripe takes a
 * cut before we see any of it. Granting against the sticker price would
 * overstate every allowance by roughly a third and quietly eat the margin this
 * module exists to protect.
 *
 * Domestic AU card: 1.75% + A$0.30. International is 2.9% + A$0.30 and is the
 * pessimistic case, so it is the one used — an allowance that is slightly too
 * SMALL costs a customer nothing they will notice; too large costs us money.
 */
export const STRIPE_PCT = 0.029;
export const STRIPE_FIXED_AUD = 0.30;

/** Net USD a plan actually delivers, after fees and conversion. */
export function netRevenueUsd(plan, audUsd) {
  const priceAud = Number(plan?.priceLocal);
  const rate = Number(audUsd);
  if (!Number.isFinite(priceAud) || priceAud <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  const afterFees = priceAud * (1 - STRIPE_PCT) - STRIPE_FIXED_AUD;
  return Math.max(0, afterFees * rate);
}

/** USD cost of one unit — by definition, one cache-read token. */
export function costPerUnitUsd(model = FLASH) {
  const w = unitWeights(model);
  const r = ratesFor(model);
  // ⚠️ `basis` matters: when a provider lists cache reads as free the weights
  // are expressed against cache-MISS input instead, and the unit is that token.
  const perMillion = w.basis === 'cachedIn' ? r.cachedInPerM : r.inPerM;
  return perMillion / 1e6;
}

/**
 * How many cost-units a plan may spend before the gate refuses.
 *
 * ⚠️ Returns `null` for a plan with no price (free) or no ceiling (enterprise) —
 * NEVER 0. Zero would refuse every round, turning a guardrail into an outage,
 * which is the rule `allowanceFrom` and `fal-spend-cap` already both follow.
 */
export function unitsForPlan(plan, { audUsd, targetMargin = TARGET_MARGIN, model = FLASH } = {}) {
  if (!plan) return null;
  const net = netRevenueUsd(plan, audUsd);
  if (net <= 0) return null;
  const margin = Number(targetMargin);
  if (!Number.isFinite(margin) || margin <= 0 || margin >= 1) return null;

  const perUnit = costPerUnitUsd(model);
  if (!(perUnit > 0)) return null;

  const spendable = net * (1 - margin);
  return Math.floor(spendable / perUnit);
}

/**
 * The free plan is the one case where the allowance is a MARKETING decision
 * rather than an arithmetic one — there is no revenue to take a margin of.
 *
 * ⚠️ So it is stated, not derived, and stated in UNITS so it lives in the same
 * currency as every other gate. `PLANS.free` grants 4,000,000 raw flash tokens;
 * at our measured builder shape that is ~10M units and **at most $0.16** of our
 * money. That is the number that decides how much a stranger can spend before
 * the upgrade card appears, and it should be argued about in dollars.
 */
export const FREE_PLAN_UNITS = 10_000_000;

/** The allowance for any plan id, free included. `null` means unmetered. */
/**
 * ── ⛔⭐⭐ THE HARD CEILING, IN DOLLARS OF SUPPLY ───────────────────
 *
 * Roman, 2026-09-20, asked what to do about the gap below: *"nothing needs to
 * change, we just cap it at like a 5.7 USD i reckon."*
 *
 * ── THE GAP HE WAS ANSWERING, MEASURED THAT DAY (AUD/USD 0.66) ─────────
 *
 *     plan      page promises   we deliver      honouring it   margin then
 *     starter        95.0M       82.1M (86.5%)      $3.19          82.7%
 *     growth        161.0M      225.3M (139.9%)        —             —
 *     scale         406.0M      568.9M (140.1%)        —             —
 *
 * ⚠️ ONLY STARTER IS SHORT, AND ONLY BY 13%; the other two over-deliver.
 * The options put to him were: raise the price, lower the published count,
 * accept a lower margin, or repin the ceiling provider. **He took none of
 * them** — so the derivation above is UNCHANGED and starter still delivers
 * 86.5% of what the page advertises. That is a decided state, not an
 * oversight, and it is recorded here rather than in a report nobody re-reads.
 * ⚠️ Closing it later is one line (`max(derived, unitsToHonourPublished)`)
 * and costs 2.3 points of margin. **It is a pricing decision and it is his.**
 *
 * ── ⭐⭐⭐ SUPERSEDED 2026-09-28: EVERY PLAN IS CAPPED, AND THE CAP IS DERIVED ──
 *
 * Owner ruling: the advertised allowances are FIXED, and each plan's cap cuts
 * spend off at an exact USD equal to the token value. The hand-typed $5.70 bought
 * only ~74.6M of Starter's 95M on v4.1 at the measured rate — it under-delivered.
 * So the cap is now, for EVERY metered plan:
 *
 *     cap(plan) = PLANS[plan].tokens[FLASH] / 1e6 × MEASURED_BLENDED_USD_PER_M
 *
 *     free $0.3056 · starter $7.2580 · growth $12.3004 · scale $31.0184
 *
 * — the same numbers the console's `tierSpendCapUsdMicros` enforces, from a copy
 * of the same constant (`rate-card-one-source.test.ts` + `plan-drift.test.ts`
 * fail on any disagreement). Enterprise has a null allowance, so no entry: it is
 * unmetered, never capped at zero.
 *
 * ⚠️ STILL A CEILING, NEVER A GRANT (`Math.min` below). In THIS module the cap
 * only lowers the 85%-derived unit allowance; whether that local unit meter
 * itself delivers the advertised tokens is a separate question, not settled here.
 */
export const SUPPLY_CAP_USD = Object.freeze(Object.fromEntries(
  Object.values(PLANS)
    .filter((p) => Number.isFinite(p?.tokens?.[FLASH]) && p.tokens[FLASH] > 0)
    .map((p) => [p.id, (p.tokens[FLASH] / 1e6) * MEASURED_BLENDED_USD_PER_M]),
));

/** The cap in units for one plan, or `null` where no ceiling is set. */
export function capUnitsForPlan(planId, model = FLASH) {
  const capUsd = SUPPLY_CAP_USD[String(planId ?? '')];
  if (!Number.isFinite(capUsd) || capUsd <= 0) return null;
  const perUnit = costPerUnitUsd(model);
  if (!(perUnit > 0)) return null;
  return Math.floor(capUsd / perUnit);
}

export function allowanceForPlan(planId, opts = {}) {
  const id = String(planId ?? '');
  const plan = PLANS[id];
  if (!plan) return null;

  /**
   * ── ⭐⭐⭐ THE CAP IS THE GRANT (owner, 2026-09-28) ─────────────────────
   *
   * *"I'm not changing the advertised amount… 95M tokens is not that much
   * cost."* The ruling is that every plan delivers EXACTLY its advertised
   * tokens and is cut off at the dollar value of them. The `Math.min(derived,
   * cap)` this replaced let the 85%-margin derivation win, so Starter's CLI
   * meter granted ~30.8M of the 95M on the page (`cost-units.test.mjs` was red
   * saying so). Now: a metered plan's allowance IS `capUnitsForPlan` — the same
   * dollars the console's `tierSpendCapUsdMicros` enforces, from the same
   * measured constant. Margin at that cap stays positive on every paid tier
   * (priced in `plan-economics.test.mjs`); the 85% target is no longer the gate.
   * Enterprise has no cap and falls back to the derivation (unmetered → null).
   */
  const model = opts?.model ?? FLASH;
  const cap = capUnitsForPlan(id, model);
  if (cap !== null) {
    /**
     * ⚠️ AND THE PROMISE IS KEPT AT THE CLI'S OWN SHAPE, NOT ONLY THE BUILDER'S.
     * The cap dollars come from the builder's measured blend; priced on this
     * meter's envelope (dearest pinned provider, the CLI's typical cache rate)
     * those dollars buy ~91M of Starter's 95M. The advertised count is the
     * promise, so the grant is whichever is larger: the cap, or exactly the
     * units that deliver the advertised tokens. The server-side USD cap still
     * gates real spend, and at the real provider price 95M fits inside it.
     */
    const promised = plan.tokens?.[model];
    const toKeepPromise = Number.isFinite(promised) && promised > 0 ? unitsToDeliver(promised, model) : 0;
    return Math.max(cap, toKeepPromise);
  }
  if (plan.priceLocal === 0) return FREE_PLAN_UNITS;
  return unitsForPlan(plan, opts);
}

/** Units that deliver `tokens` at the typical shape — the inverse of `typicalTokensFrom`. */
export function unitsToDeliver(tokens, model = FLASH, { outputShare = 0.008, cacheRate = 0.82 } = {}) {
  const w = unitWeights(model);
  const perToken = outputShare * w.output + (1 - outputShare) * (cacheRate * w.cachedIn + (1 - cacheRate) * w.missIn);
  // +1: `typicalTokensFrom` floors, so a bare ceil can land one token short of the promise
  return Math.ceil(tokens * perToken) + 1;
}
