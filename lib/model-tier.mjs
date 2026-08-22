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
 * ── ⭐⭐ THE ESCALATION MODEL, ON BY DEFAULT ────────────────────────────────
 *
 * This ladder climbs solo → fresh context → best-of-N, and until now every rung
 * ran the SAME cheap model. So the loop got more determined and never got
 * smarter, and every benchmark number this package holds is a FLOOR taken with
 * one hand tied: 19 of 19 runs measured on flash, with the stronger rungs
 * switched off and nobody having tried them.
 *
 * ⭐ THE ARITHMETIC THAT MAKES IT AFFORDABLE, and it is not what you would
 * guess. Pro is 3.1x flash on a cache MISS and 3.1x on OUTPUT — but only
 * **1.29x on a cache HIT** ($0.0036/M against $0.0028/M direct). At the cache
 * rates this package now sustains, pro's INPUT is nearly flash's price and the
 * entire gap is output.
 *
 * ⭐ AND ESCALATION IS ALREADY FRESH-CONTEXT, WHICH IS WHAT MAKES THE SWITCH
 * CHEAP. `escalate.mjs` passes the TASK to each rung, never the transcript, so
 * moving to a different model does not re-send a 41,000-token conversation at
 * the dearer model's miss price. A prompt cache is per-model — switching MID-
 * CONVERSATION would cost a full cold prompt every time, and nothing about this
 * default does that.
 *
 * ⚠️ MODELLED, NOT MEASURED: at ~8% of tasks escalating (our bench passes 12 of
 * 13 on flash alone), the blended cost is about $4.13 per user-month against
 * $3.28 for flash-only — 78% margin instead of 83%. Five points of margin to
 * put a materially better model on the tasks that already failed once. How much
 * pro actually BUYS is still unmeasured; that is a bench run, not an opinion.
 *
 * ⚠️ THE DATED SNAPSHOT IS DELIBERATE. `deepseek-v4-pro-0813` is $0.435/M;
 * the undated `deepseek-v4-pro` pointer is $1.168/M — 2.7x dearer for what is
 * meant to be the same family. Pinning the snapshot is both cheaper and
 * reproducible, and a moving pointer under a benchmark is how a "regression"
 * appears that nobody changed.
 *
 * ⚠️ Set `ACUVO_MODEL_TIERS` to override, or to a single id to switch this off.
 */
export const DEFAULT_ESCALATION_MODEL = 'deepseek/deepseek-v4-pro-0813';

export function parseTiers(baseModel, env = process.env) {
  const raw = String(env?.[TIERS_ENV] ?? '').trim();
  /**
   * ⚠️ THE BASE MODEL STAYS RUNG ZERO, WHATEVER THE USER CONFIGURED. This adds a
   * rung above it; it never replaces the model somebody chose. And when the base
   * IS the escalation model — somebody set `OPENROUTER_CODEGEN_MODEL` to pro —
   * the ladder collapses to one entry rather than listing pro twice, because
   * `modelForRung` reuses the last tier and a duplicate would read as a switch
   * that is not happening.
   */
  if (raw === '') {
    return baseModel === DEFAULT_ESCALATION_MODEL
      ? [baseModel]
      : [baseModel, DEFAULT_ESCALATION_MODEL];
  }

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
