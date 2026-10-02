/**
 * ── ⭐ THE LADDER RETRIED WITH THE SAME MODEL, WHICH IS THE WEAK VERSION ────
 *
 * `escalate.mjs` climbs solo → fresh context → best-of N, and every rung asked
 * **the same model** the failing one used. That is the cheapest kind of "try
 * harder": a fresh context helps because the old one was poisoned, and parallel
 * attempts help because sampling varies — but neither adds capability the model
 * did not have on the first try.
 *
 * ⭐ Model tiers add the missing axis. A rung can be given a STRONGER model, so
 * "spend more on the hard ones" becomes true of the thing doing the work and not
 * only of how many times it is asked.
 *
 * ── ⚠️⚠️ OFF BY DEFAULT, AND THE REASON IS ARITHMETIC, NOT CAUTION ─────────
 *
 * `escalate.projectTierCost` prices the next rung from **what the last attempt
 * measurably cost**. That is the honest way to project when the model is
 * constant, and it is WRONG the moment it is not: a rung on a model that costs
 * 20x per token would be projected at 3x the price of a cheap attempt, the
 * budget would wave it through, and the ceiling the user typed would be crossed
 * by an order of magnitude — by the one code path whose entire job is not to do
 * that.
 *
 * We cannot fix that by guessing prices: this package has no price table, and a
 * wrong one is worse than none. So:
 *
 *   · with no configuration, every tier is the SAME model and nothing changes;
 *   · configuring tiers is an explicit act (`ACUVO_MODEL_TIERS`), which is the
 *     user saying "I know what these cost";
 *   · and when a rung's model differs from the previous rung's, the caller is
 *     TOLD (`changed: true`) so the projection can be widened rather than
 *     quietly trusted.
 *
 * ⭐ The default therefore costs nothing and changes nothing, which is the only
 * safe shape for a feature that can multiply a bill.
 */

/** The variable that turns this on. Cheapest first, strongest last. */
export const TIERS_ENV = 'ACUVO_MODEL_TIERS';

/**
 * ⚠️ A CEILING ON HOW FAR A SINGLE RUN CAN ESCALATE. Someone will paste a list
 * of ten models; the ladder has three rungs and the rest would be dead config
 * that reads as if it were doing something.
 */
export const MAX_TIERS = 4;

/**
 * Parse the configured ladder.
 *
 * ⚠️ AN EMPTY OR ABSENT VARIABLE IS NOT AN ERROR — it is the normal case, and
 * it means "one tier: whatever the run is already using".
 *
 * @param {string} baseModel
 * @param {object} env
 * @returns {string[]} cheapest first, always at least one entry
 */
/**
 * ── ⚠️⚠️⚠️ THE ESCALATION MODEL IS AN OPT-IN AGAIN. IT WAS ON BY DEFAULT AND
 *    THE JUSTIFICATION NEVER EXISTED. ────────────────────────────────────────
 *
 * ⭐ ROMAN, 2026-09-01: *"you underestimate flash lol, and we never switch to
 * pro, pro is worse on benchmarks dude. the model is 82.7 on benchmark run."*
 * That is the decision this line was waiting for, and it is why it changed.
 *
 * ── WHAT THE DEFAULT USED TO DO, MEASURED HERE BEFORE CHANGING IT ───────────
 *
 *     parseTiers('…-flash-0731', {})  →  ['…-flash-0731', '…-pro-0813']
 *     planRung(0) → flash     planRung(1) → pro     planRung(2) → pro
 *
 * So with NO configuration at all, rungs 1 and 2 of every escalation ran pro.
 *
 * ── ⚠️ AND THE FILE ARGUED WITH ITSELF ABOUT IT ─────────────────────────────
 *
 * The block above this one — *"OFF BY DEFAULT, AND THE REASON IS ARITHMETIC,
 * NOT CAUTION"* — is still there, still correct, and was contradicted by the
 * paragraph that used to sit here. Its closing sentence is the one that
 * mattered: **"The default therefore costs nothing and changes nothing, which
 * is the only safe shape for a feature that can multiply a bill."**
 *
 * ── ⚠️⚠️ THE THREE FACTS THAT SETTLE IT, ALL ALREADY IN THIS REPOSITORY ─────
 *
 *   1. **COST: pro is 11.2x flash per unit of work.** Not a list price — the
 *      measured blended ratio on our own traffic (`escalate.mjs`
 *      MODEL_COST_INDEX). The old paragraph here quoted "1.29x on a cache HIT",
 *      which is true and is the wrong column: output is never cached and is
 *      where the whole gap lives.
 *   2. **BENEFIT: never demonstrated.** The paragraph removed from here said so
 *      itself — *"How much pro actually BUYS is still unmeasured; that is a
 *      bench run, not an opinion"* — and then enabled it by default anyway.
 *   3. **The one capability datapoint is VOID.** `escalate.mjs` cites a 13-task
 *      bench at flash 12/13, pro 5/13. `WHAT-NEEDS-TO-HAPPEN.md` item 13
 *      corrects it: *"The 5/13 bench result was a BUDGET ARTIFACT — every pro
 *      failure was 1 round at 0% cache, because DEFAULT_BUDGET_USD = 0.02
 *      affords exactly one cold pro round ($0.0134)."* It is evidence of a
 *      budget, not of a model.
 *
 * ⭐ SO THE DEFAULT PAID 11.2x FOR AN UNMEASURED BENEFIT. Removing it restores
 * the shape the block above argues for; the ladder still climbs
 * solo → fresh context → best-of-N, which is where its measured value is.
 *
 * ⚠️ THIS IS NOT A CLAIM THAT PRO IS WORSE — that remains unmeasured here, and
 * a proper re-run is costed at ~$0.16 in `WHAT-NEEDS-TO-HAPPEN.md` item 13.
 * It is a claim that a default which multiplies a bill needs evidence, and had
 * none. Set `ACUVO_MODEL_TIERS` to bring it back for a run.
 *
 * ⚠️ THE DATED SNAPSHOT IS STILL DELIBERATE, for whoever opts in.
 * `deepseek-v4-pro-0813` is $0.435/M; the undated `deepseek-v4-pro` pointer is
 * $1.168/M — 2.7x dearer for what is meant to be the same family. A moving
 * pointer under a benchmark is how a "regression" appears that nobody caused.
 */
export const DEFAULT_ESCALATION_MODEL = 'deepseek/deepseek-v4-pro-0813';

/**
 * ⭐ THE DOCUMENTED OPT-IN, SPELLED OUT SO THE REFUSAL CAN NAME IT.
 * `ACUVO_MODEL_TIERS=deepseek/deepseek-v4-flash-0731,deepseek/deepseek-v4-pro-0813`
 */
export const ESCALATION_OPT_IN = `${TIERS_ENV}=<cheap-model>,${DEFAULT_ESCALATION_MODEL}`;

export function parseTiers(baseModel, env = process.env) {
  const raw = String(env?.[TIERS_ENV] ?? '').trim();
  /**
   * ⭐⭐ NO CONFIGURATION MEANS ONE TIER: the model the run is already using.
   * Every rung then gets the same model, `planRung` reports `changed: false`,
   * `describeSwitch` returns null, and the cost projection stays sound because
   * nothing about the model changed between rungs — which is the condition
   * `projectTierCost` was written for in the first place.
   */
  if (raw === '') return [baseModel];

  const seen = new Set();
  const tiers = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tiers.push(id);
    if (tiers.length >= MAX_TIERS) break;
  }
  return tiers.length > 0 ? tiers : [baseModel];
}

/**
 * Which model a given rung should use.
 *
 * ⚠️ THE LAST TIER IS REUSED, NEVER WRAPPED. With two tiers configured and three
 * rungs, the third rung gets the strongest configured model — not tier[0] again.
 * Wrapping would send the hardest attempt to the weakest model, which is the
 * exact inverse of the feature.
 *
 * @param {number} rungIndex  0-based position in the ladder
 * @param {string[]} tiers
 * @returns {string}
 */
export function modelForRung(rungIndex, tiers) {
  const list = Array.isArray(tiers) && tiers.length > 0 ? tiers : [null];
  const i = Math.max(0, Math.min(list.length - 1, Number.isInteger(rungIndex) ? rungIndex : 0));
  return list[i];
}

/**
 * What model does this rung use, and is it a different one from last time?
 *
 * `changed` is the load-bearing field: it is the signal that a cost projection
 * derived from the previous rung no longer applies.
 *
 * @returns {{model: string, changed: boolean, tier: number, of: number}}
 */
export function planRung(rungIndex, { baseModel, env = process.env, previousModel = null } = {}) {
  const tiers = parseTiers(baseModel, env);
  const model = modelForRung(rungIndex, tiers);
  return {
    model,
    changed: previousModel !== null && previousModel !== model,
    tier: Math.min(rungIndex, tiers.length - 1),
    of: tiers.length,
  };
}

/**
 * One line for a human when the ladder changes model mid-run.
 *
 * ⚠️ SAID OUT LOUD, ALWAYS. A run that silently switches to a pricier model has
 * changed what it costs without telling the person paying, and "why was this
 * bill different" must never be unanswerable.
 */
export function describeSwitch(from, to) {
  if (!from || !to || from === to) return null;
  return `escalating the model as well: ${from} → ${to} (its price is not projected from the previous rung — see --budget)`;
}
