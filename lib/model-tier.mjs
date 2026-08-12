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
export function parseTiers(baseModel, env = process.env) {
  const raw = String(env?.[TIERS_ENV] ?? '').trim();
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
