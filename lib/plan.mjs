/**
 * ── ⭐⭐ THE PLAN MATH, IN CODE, FROM MEASURED PRICES ────────────────────────
 *
 * Everything about what a user gets for their money lived in conversations and
 * spreadsheets. That is fine until somebody has to ENFORCE it, and then the
 * question "has this account run out?" has no function to call. This module is
 * the one place that answers it, and every number in it is either a real
 * OpenRouter endpoint price read on 2026-08-15 or a figure from our own bench.
 *
 * ── ⚠️⚠️ THE ONE FACT THAT DECIDES THE BUSINESS ─────────────────────────────
 *
 * **The cache rate IS the margin.** Not a contributor to it — the whole of it.
 * Blended cost per million flash tokens, measured:
 *
 *     cache   0%  $0.0686      cache  85%  $0.0228
 *     cache  65%  $0.0336      cache  95%  $0.0174
 *
 * A 95M-token plan costs $3.19 at 65% cache and $1.66 at 95%. On $29 AUD that
 * is the difference between an 83% margin and a 91% one, from the same product
 * doing the same work. Which is why `PROVIDER_PIN_BY_MODEL` and compaction
 * discipline are not housekeeping — they are the P&L.
 *
 * ── ⭐⭐ AND THE ROUTING RULE THAT FALLS OUT OF IT ──────────────────────────
 *
 * Pro's premium over flash COLLAPSES as the cache warms:
 *
 *     cache   0%   6.40x        cache  95%   1.86x
 *     cache  65%   4.78x        cache  98%   1.23x
 *
 * So the honest rule is NOT "use the cheap model" — it is **"a long warm
 * session can afford the strong model; a short cold one cannot."** That is the
 * opposite of escalate-on-failure, which reaches for pro exactly when the
 * context is coldest, and it is measured rather than reasoned.
 */

/**
 * Per-million prices, USD, from OpenRouter's per-model endpoint feed on
 * 2026-08-15, for the endpoint each model is PINNED to.
 *
 * ⚠️ THE PINNED ENDPOINT, NOT THE MODEL PAGE. The model page shows a headline;
 * a model is served by many providers at wildly different prices. Pro was
 * unpinned and landing on GMICloud at $1.218/M in and $0.1015/M cache-read —
 * 2.8x and 28x DeepSeek's own endpoint. Quoting the page would have hidden
 * that entirely. See `PROVIDER_PIN_BY_MODEL` in model.mjs.
 */
export const MODEL_PRICES = Object.freeze({
  'deepseek/deepseek-v4-flash-0731': Object.freeze({ in: 0.068, out: 0.137, cacheRead: 0.0137, provider: 'StreamLake' }),
  'deepseek/deepseek-v4-pro-0813': Object.freeze({ in: 0.435, out: 0.870, cacheRead: 0.0036, provider: 'DeepSeek' }),
  'qwen/qwen3.7-flash': Object.freeze({ in: 0.030, out: 0.130, cacheRead: 0.0060, provider: 'Alibaba' }),
  'z-ai/glm-4.6': Object.freeze({ in: 0.430, out: 1.750, cacheRead: 0.0800, provider: 'Venice' }),
});

/**
 * ⚠️ MEASURED, AND SMALLER THAN ANYONE GUESSES. A real 3-round run: 33,544
 * tokens total, 33,258 of them prompt — so **output is 0.9% of the tokens.**
 * That is why cache rate dominates everything: 99% of what we pay for is input,
 * and input is the only half that can be cached. It is also why "make the model
 * write less" is a much weaker lever than it sounds.
 */
export const OUTPUT_TOKEN_SHARE = 0.009;

/**
 * Blended cost per million tokens at a given cache hit rate.
 *
 * @param {string} model
 * @param {number} cacheRate 0..1
 * @returns {number|null} USD per million, or null for a model we have not priced
 */
export function costPerMillion(model, cacheRate = 0) {
  const p = MODEL_PRICES[String(model ?? '')];
  if (!p) return null;
  const c = Math.min(1, Math.max(0, Number(cacheRate) || 0));
  const inputCost = c * p.cacheRead + (1 - c) * p.in;
  return (1 - OUTPUT_TOKEN_SHARE) * inputCost + OUTPUT_TOKEN_SHARE * p.out;
}

/**
 * ── ⭐ THE PLANS ────────────────────────────────────────────────────────────
 *
 * ⚠️ SEPARATE ALLOWANCES PER MODEL, NOT ONE POOLED NUMBER, and the reason is
 * arithmetic rather than taste. Pro costs between 1.23x and 6.40x flash
 * depending on cache, so a single "N tokens" pool would be worth wildly
 * different amounts of money depending on which model spent it — and the user
 * could not predict their own limit. Claude splits Opus from Sonnet for exactly
 * this reason. Two numbers a user can read beat one number that lies.
 *
 * ⚠️ AND THE PRO ALLOWANCE IS THE RISK. At 95% cache the whole $29 AUD plan
 * costs us $1.98 (89% margin); at 65% it costs $4.80 (74%). The plan is sound
 * BECAUSE the cache holds, which makes the pin a revenue control.
 */
/** AUD→USD, deliberately conservative — a plan must not depend on a good day. */
export const AUD_USD = 0.645;

const FLASH = 'deepseek/deepseek-v4-flash-0731';
const PRO = 'deepseek/deepseek-v4-pro-0813';
/**
 * ── ⭐⭐⭐ THE THIRD MODEL, ADDED 2026-08-16, AND IT IS THE MARGIN LEVER ─────
 *
 * Every tier below used to grant FLASH and PRO only, which quietly assumed the
 * build model also does the READING. It does not, and it should not: the locked
 * role split is *"qwen3.7-flash — interpreting, review, vision, chat. NEVER
 * building."* Qwen's blended rate is **3.2x cheaper than flash**, and roughly
 * 58% of an agent run's tokens are reading rather than writing.
 *
 * ⭐ SO NAMING IT MADE EVERY TIER BIGGER *AND* MORE PROFITABLE. Starter went
 * from 95M tokens to **152M** while its margin at a poor (70%) cache month rose
 * — because the volume that was being priced at flash rates was never flash
 * work in the first place. Measured 2026-08-16.
 */
const QWEN = 'qwen/qwen3.7-flash';

/**
 * ── ⚠️⚠️ ONE LADDER, AND IT IS THE SHIPPED ONE ─────────────────────────────
 *
 * This file first invented its own tiers — free/code/pro/max at 5M/95M/200M/
 * 500M — while `console/lib/plan-catalog.ts` was already SELLING
 * free/starter/growth/scale at 4M/95M/330M/1000M. Two ladders, both
 * plausible, already disagreeing on three of four rungs. A price the CLI
 * quotes and a price the customer is charged must be the same number, and
 * the console is the one with customers on it.
 *
 * ⭐ So these mirror the catalogue exactly, and
 * `console/lib/plan-drift.test.ts` FAILS if either side moves. Change one,
 * the test names the other — which is what makes the numbers safe to change
 * at will rather than merely easy to change in one place and forget in the
 * other.
 *
 * ── ✅ THE CONFESSED DEFECT IS FIXED (2026-08-16) ───────────────────────────
 *
 * This paragraph used to read: *"⚠️ Growth and Scale sit below 80% on a poor
 * cache month. Their FLASH allowances were already generous, so any pro on top
 * is squeezed — a pricing decision to revisit deliberately, recorded rather
 * than hidden."* It quoted 95/85/75/65% cache margins of
 * `starter 90/86/82/79 · growth 87/82/77/72 · scale 85/80/75/69`.
 *
 * ⭐ THE FIX WAS NOT SMALLER ALLOWANCES — IT WAS NAMING THE THIRD MODEL. Those
 * tiers granted FLASH and PRO only, which priced the READING half of every run
 * at build-model rates. Qwen is 3.2x cheaper and does ~58% of the volume, so
 * adding it made every tier **larger and more profitable at once**:
 *
 *   starter  95M -> 152M     growth  349M -> 415M     scale  1036M -> 1046M
 *
 * All three now clear **80% at a poor 70% cache month** and sit at ~87.7% at
 * the 90% floor the gateway engineers. ⚠️ At a total cache failure (0%) they
 * are 52–53% — thin, never a loss. Holding 80% at 0% would mean granting ~60M
 * on Starter, which is a worse product than the risk justifies: the floor is
 * something we BUILD (shared prompt head + pinned provider + multi-tenant
 * traffic), not something we hope for.
 */
export const PLANS = Object.freeze({
  free: Object.freeze({
    id: 'free', label: 'Free', priceUsd: 0, currency: 'AUD', priceLocal: 0,
    tokens: Object.freeze({ [QWEN]: 6_000_000, [FLASH]: 4_000_000, [PRO]: 0 }),
    includesReview: true,
  }),
  /**
   * ── ⭐ RESIZED 2026-08-16 — BIGGER *AND* MORE PROFITABLE ────────────────────
   *
   * Was `flash 95M + pro 5M`. Now `qwen 88M + flash 59M + pro 5M = 152M`, sized
   * so 80% margin holds at a **poor 70% cache month**, on this file's own
   * measured prices and its measured 0.9% output share.
   *
   *     @70% cache  $3.78   79.8%
   *     @90% cache  $2.30   87.7%     ← the floor the gateway engineers
   *     @0%  cache  $8.96   52.1%     ← total cache failure: thin, never a loss
   *
   * ⚠️ 0% is the honest worst case and it is NOT 80%. Holding 80% with no cache
   * at all would mean granting ~60M tokens, which is a worse product than the
   * risk justifies — the floor is something we build (shared prompt head +
   * pinned provider + multi-tenant traffic), not something we hope for.
   */
  starter: Object.freeze({
    id: 'starter', label: 'Starter', priceUsd: 29 * AUD_USD, currency: 'AUD', priceLocal: 29,
    tokens: Object.freeze({ [QWEN]: 88_000_000, [FLASH]: 59_000_000, [PRO]: 5_000_000 }),
    includesReview: true,
  }),
  /**
   * ⚠️ THIS FIXES A DEFECT THIS FILE ALREADY CONFESSED. Its own header said:
   * *"Growth and Scale sit below 80% on a poor cache month … a pricing decision
   * to revisit deliberately, recorded rather than hidden."* This is that revisit.
   * Was `flash 330M + pro 19M`; now 415M total and 80.1% at the same poor month.
   */
  growth: Object.freeze({
    id: 'growth', label: 'Growth', priceUsd: 79 * AUD_USD, currency: 'AUD', priceLocal: 79,
    // ⭐ Re-split 2026-08-18 to hold STARTER'S MODEL BLEND, which
    // `acuvo-gateway/lib/topups.mjs` requires — it prices one blended top-up
    // across the whole ladder and refuses when the mixes drift apart.
    tokens: Object.freeze({ [QWEN]: 240_000_000, [FLASH]: 161_000_000, [PRO]: 14_000_000 }),
    includesReview: true,
  }),
  scale: Object.freeze({
    id: 'scale', label: 'Scale', priceUsd: 199 * AUD_USD, currency: 'AUD', priceLocal: 199,
    tokens: Object.freeze({ [QWEN]: 606_000_000, [FLASH]: 406_000_000, [PRO]: 34_000_000 }),
    includesReview: true,
  }),
  /**
   * ⚠️ UNMETERED, NOT UNLIMITED-BY-OVERSIGHT. `null` means the allowance is
   * negotiated rather than absent, and `planGate` treats a null as "no ceiling
   * to enforce here" rather than as zero.
   */
  enterprise: Object.freeze({
    id: 'enterprise', label: 'Enterprise', priceUsd: 1000 * AUD_USD, currency: 'AUD', priceLocal: 1000,
    tokens: Object.freeze({ [QWEN]: null, [FLASH]: null, [PRO]: null }),
    includesReview: true,
  }),
});

/**
 * ── ⚠️⚠️ TWO STRUCTURES THAT LOOK BETTER AND MEASURE WORSE ──────────────────
 *
 * Recorded so nobody re-proposes them from first principles, because both are
 * the obvious idea and both are refuted by the price table above.
 *
 * **A pooled allowance with pro billed at a multiplier.** Elegant, and the
 * multiplier is NOT A CONSTANT: pro is 1.9x flash at 95% cache, 3.3x at 85%
 * and 4.8x at 65%. Any published figure is therefore wrong most of the time —
 * either we overcharge on warm sessions or we lose money on cold ones, and the
 * user cannot predict their own limit either way. Two honest numbers beat one
 * that lies.
 *
 * **Unlimited flash, metered pro.** Measured against real usage: a 100-task/day
 * user leaves an 88% margin, 200/day leaves 75%, and 400/day leaves **51%**.
 * "Unlimited" needs a fair-use cap to survive its top percentile, and a cap is
 * an allowance with worse manners.
 */
export const REJECTED_STRUCTURES = Object.freeze(['pooled-with-multiplier', 'unlimited-flash']);

/**
 * What a plan costs us, and what margin it leaves, at a given cache rate.
 *
 * ⚠️ IT TAKES THE CACHE RATE BECAUSE THERE IS NO SINGLE ANSWER. A margin quoted
 * without one is a number somebody chose. `acuvo spend` reports the real rate
 * for a workspace; feed that in and this tells the truth about that account.
 *
 * @param {object} plan
 * @param {number} cacheRate
 */
export function planEconomics(plan, cacheRate = 0.95) {
  let cogsUsd = 0;
  const unpriced = [];
  /**
   * ⚠️⚠️ AN UNMETERED ALLOWANCE MAKES THE MARGIN UNKNOWABLE, NOT 100%.
   * `null` means "negotiated, no ceiling", and skipping it as if it were zero
   * reported Enterprise at a 100% margin — a plan whose customers use real
   * tokens, costed at nothing. That is the exact shape of lie this file spends
   * its comments guarding against, committed inside the file that guards it.
   */
  const unmetered = Object.entries(plan?.tokens ?? {})
    .filter(([, t]) => t === null)
    .map(([m]) => m);
  for (const [model, tokens] of Object.entries(plan?.tokens ?? {})) {
    if (tokens === null || !tokens) continue;
    const per = costPerMillion(model, cacheRate);
    if (per === null) { unpriced.push(model); continue; }
    cogsUsd += (tokens / 1e6) * per;
  }
  const revenueUsd = Number(plan?.priceUsd ?? 0);
  return {
    cacheRate,
    cogsUsd,
    revenueUsd,
    /** null rather than a made-up 100% for a free plan — it has no margin. */
    /**
     * null when there is no revenue (free) OR no ceiling (enterprise). Both are
     * "we cannot state a margin", and inventing one for either is worse than
     * saying so.
     */
    marginPct: revenueUsd > 0 && unmetered.length === 0 ? ((revenueUsd - cogsUsd) / revenueUsd) * 100 : null,
    unmetered,
    profitUsd: revenueUsd - cogsUsd,
    /** ⚠️ Named, never silently skipped — an unpriced model understates COGS. */
    unpriced,
  };
}

/**
 * ── ⚠️ THE CACHE RATE AT WHICH A PLAN STOPS PAYING ─────────────────────────
 *
 * The single most useful number for pricing a plan, and it cannot be reasoned
 * to — it has to be solved for. Below this rate the plan earns less than the
 * target margin, which is the alarm the pin and the compaction rules exist to
 * keep from ringing.
 *
 * @returns {{ rate: number|null, note: string }}
 */
export function breakEvenCacheRate(plan, targetMarginPct = 80) {
  // Monotonic in cacheRate, so a coarse scan is exact enough to act on and has
  // no solver to get wrong.
  for (let r = 0; r <= 1.0001; r += 0.01) {
    const e = planEconomics(plan, Math.min(1, r));
    if (e.marginPct !== null && e.marginPct >= targetMarginPct) {
      return { rate: Math.min(1, r), note: `at or above ${(r * 100).toFixed(0)}% cache this plan clears ${targetMarginPct}%` };
    }
  }
  return { rate: null, note: `this plan never reaches ${targetMarginPct}% margin, at any cache rate` };
}

/**
 * How much of a plan's allowance is left.
 *
 * @param {object} plan
 * @param {Record<string, number>} usedByModel tokens already spent, per model
 */
export function allowanceRemaining(plan, usedByModel = {}) {
  const out = {};
  for (const [model, granted] of Object.entries(plan?.tokens ?? {})) {
    const used = Number(usedByModel?.[model]) || 0;
    if (granted === null) {
      // ⚠️ Unmetered is AVAILABLE and never exhausted. Treating null as 0 would
      // tell an enterprise customer their negotiated capacity had run out.
      out[model] = { granted: null, used, remaining: null, exhausted: false, available: true };
      continue;
    }
    out[model] = {
      granted,
      used,
      remaining: Math.max(0, granted - used),
      exhausted: used >= granted,
      /** ⚠️ A plan that grants 0 of a model is NOT "exhausted" — it never had any. */
      available: granted > 0,
    };
  }
  return out;
}

/** One screen for a human, and every figure is computed here rather than quoted. */
export function formatPlan(plan, cacheRate = 0.95) {
  const e = planEconomics(plan, cacheRate);
  const price = plan.currency === 'AUD' ? `$${plan.priceLocal} AUD (~$${plan.priceUsd.toFixed(2)} USD)` : `$${plan.priceUsd} USD`;
  const lines = [`${plan.label} — ${plan.priceUsd === 0 ? 'free' : price}`];
  for (const [model, tokens] of Object.entries(plan.tokens)) {
    if (!tokens) continue;
    const per = costPerMillion(model, cacheRate);
    lines.push(`  ${(tokens / 1e6).toFixed(0)}M  ${model}${per === null ? '  (unpriced)' : `   costs us $${((tokens / 1e6) * per).toFixed(2)} at ${(cacheRate * 100).toFixed(0)}% cache`}`);
  }
  if (e.marginPct !== null) {
    lines.push(`  total COGS $${e.cogsUsd.toFixed(2)} · margin ${e.marginPct.toFixed(0)}%`);
    const be = breakEvenCacheRate(plan, 80);
    lines.push(`  ${be.note}`);
  }
  return lines;
}

/**
 * ── ⚠️⚠️ AN ALLOWANCE NOTHING ENFORCES IS A NUMBER ON A PRICING PAGE ────────
 *
 * `allowanceRemaining` shipped and was called by nobody, which is this
 * package's signature defect wearing a business hat: the plan was expressible,
 * auditable and completely unenforced. A limit that does not stop a run is
 * marketing.
 *
 * ⚠️ IT REFUSES BEFORE THE SPEND, NOT AFTER. `budget.mjs` already states the
 * rule — "it never spends money to discover it had none" — and the same applies
 * one layer up: discovering an exhausted allowance by exhausting it further is
 * the failure this gate exists to prevent.
 *
 * ⚠️ AND EVERY REFUSAL NAMES THE WAY OUT. "Limit reached" is an obstacle; "you
 * have used 95M of 95M Acuvo Flash this period — Acuvo Pro grants 200M" is a
 * decision. A gate that cannot be acted on just moves the user to a competitor
 * with a clearer error message.
 *
 * @param {object} args
 * @param {object} args.plan
 * @param {Record<string, number>} args.usedByModel  tokens already spent, per PROVIDER id
 * @param {string} args.model                        the provider id about to run
 * @param {number} [args.projectedTokens]            what this run is expected to add
 * @param {object[]} [args.ladder]                   plans to suggest upgrading to
 */
export function planGate({ plan, usedByModel = {}, model, projectedTokens = 0, ladder = Object.values(PLANS) } = {}) {
  const id = String(model ?? '');
  const rawGranted = plan?.tokens?.[id];
  if (rawGranted === null) {
    // Unmetered: there is nothing to enforce, and saying "allowed" is the truth.
    return { allowed: true, reason: 'unmetered', remaining: null, message: null };
  }
  const granted = Number(rawGranted ?? 0);
  const used = Number(usedByModel?.[id]) || 0;
  const remaining = Math.max(0, granted - used);

  /**
   * ⭐ THE UPGRADE THAT WOULD ACTUALLY HELP, found rather than hardcoded: the
   * cheapest plan in the ladder that grants more of THIS model than the current
   * one. Naming a tier that does not solve the problem is worse than naming none.
   */
  const upgrade = ladder
    .filter((p) => Number(p?.tokens?.[id] ?? 0) > granted)
    .sort((a, b) => a.priceUsd - b.priceUsd)[0] ?? null;
  const upgradeNote = upgrade
    ? ` ${upgrade.label} grants ${(upgrade.tokens[id] / 1e6).toFixed(0)}M.`
    : '';

  if (granted <= 0) {
    return {
      allowed: false,
      reason: 'not-on-plan',
      remaining: 0,
      message: `${labelFor(id)} is not included in ${plan?.label ?? 'this plan'}.${upgradeNote}`,
    };
  }
  if (remaining <= 0) {
    return {
      allowed: false,
      reason: 'exhausted',
      remaining: 0,
      message: `${plan?.label ?? 'this plan'} has used all ${(granted / 1e6).toFixed(0)}M ${labelFor(id)} tokens for this period.${upgradeNote}`,
    };
  }
  /**
   * ⚠️ A PROJECTION THAT WOULD CROSS THE LINE STOPS THE RUN, matching
   * `budget.mjs`'s "stop when the NEXT round would cross it". Starting a run
   * that cannot finish spends the remainder and delivers nothing, which is the
   * worst of both outcomes.
   */
  if (projectedTokens > 0 && projectedTokens > remaining) {
    return {
      allowed: false,
      reason: 'would-exceed',
      remaining,
      message: `this run is projected at ${(projectedTokens / 1e6).toFixed(1)}M ${labelFor(id)} tokens and only ${(remaining / 1e6).toFixed(1)}M remain on ${plan?.label ?? 'this plan'}.${upgradeNote}`,
    };
  }
  return { allowed: true, reason: 'ok', remaining, message: null };
}

/** Acuvo's name for a provider id, without importing the catalogue into the math. */
function labelFor(id) {
  if (id === 'deepseek/deepseek-v4-flash-0731') return 'Acuvo Flash';
  if (id === 'deepseek/deepseek-v4-pro-0813') return 'Acuvo Pro';
  return id;
}

/**
 * Tokens used per PROVIDER id, from audit records.
 *
 * ⚠️ THE MODEL THAT ANSWERED, NOT THE ONE REQUESTED. A run that fell back to a
 * different model spent tokens on the model that actually served it, and
 * charging the requested one would bill an allowance that was never touched.
 *
 * ⚠️ AND A RECORD WITH NO TOKEN COUNT IS COUNTED AS UNKNOWN, never as zero —
 * silently free usage is how an allowance stops meaning anything.
 */
export function usageByModel(records = []) {
  const byModel = {};
  let unknown = 0;
  for (const rec of records) {
    const run = rec?.run;
    if (!run) continue;
    const id = run.model?.answered ?? run.model?.requested ?? null;
    /**
     * ⚠️⚠️ CHECKED BEFORE COERCION, AND MY FIRST VERSION WAS NOT. `Number(null)`
     * is `0`, and `Number.isFinite(0)` is TRUE — so a run that recorded no token
     * count was silently counted as ZERO USAGE rather than as unknown, which is
     * precisely the "silently free usage" this function's comment forbids. The
     * test caught it; the code and its own documentation disagreed.
     */
    const tokens = typeof run.tokens === 'number' && Number.isFinite(run.tokens) ? run.tokens : null;
    if (!id || tokens === null) { unknown += 1; continue; }
    byModel[id] = (byModel[id] ?? 0) + tokens;
  }
  return { byModel, unknown };
}
