/**
 * ── ⭐⭐ THE PLAN MATH, IN CODE ──────────────────────────────────────────────
 *
 * Everything about what a user gets for their money lived in conversations and
 * spreadsheets. That is fine until somebody has to ENFORCE it, and then the
 * question "has this account run out?" has no function to call. This module is
 * the one place that answers it.
 *
 * ── ⚠️ THE RATES THEMSELVES ARE NOT WRITTEN DOWN HERE ───────────────────────
 *
 * They are DERIVED from `rate-card.mjs`, which is the single module allowed to
 * hold one. This file does arithmetic on them and renders an ALLOWANCE to the
 * user; it does not publish an input cost, and nothing it prints by default
 * discloses one. See `formatPlan` — that separation is deliberate and there is
 * a test pinning it.
 *
 * ── ⚠️⚠️ THE ONE FACT THAT DECIDES THE BUSINESS ─────────────────────────────
 *
 * **The cache rate dominates everything else combined.** The same product doing
 * the same work is several times more expensive to serve on a cold session than
 * on a warm one, and the spread between a poor cache month and a good one is
 * wider than every other lever in this file put together. Which is why the
 * provider pin and compaction discipline are not housekeeping.
 *
 * ⚠️⚠️ AND THE NUMBERS HERE HAVE BEEN WRONG BEFORE, IN THE FLATTERING
 * DIRECTION. An upstream restructured its card and eight hard-typed copies of
 * the old one did not move — for nine days. Nothing about the product changed;
 * a price sheet did. That is the entire reason rates are now derived from one
 * module instead of typed here, and why `test/rate-card.test.mjs` fails when
 * any table disagrees with it.
 *
 * ── ⚠️⚠️ AND THE ROUTING RULE THAT USED TO FALL OUT OF IT NO LONGER DOES ────
 *
 * Acuvo Pro's premium over Acuvo Flash used to COLLAPSE as the cache warmed —
 * 6.40x cold, 1.86x at 95% — because the two were priced off different shapes.
 * That supported a real routing rule: *"a long warm session can afford the
 * strong model; a short cold one cannot."*
 *
 * ⭐ THEY ARE NOW PRICED OFF THE SAME SHAPE (a cache read is roughly a
 * thirtieth of a miss on each), so the premium is **FLAT at ~3.0x from 0% cache
 * to 98%**:
 *
 *     cache   0%   3.00x        cache  95%   3.04x
 *     cache  65%   3.01x        cache  98%   3.06x
 *
 * ⚠️ SO THE RULE IS DEAD, NOT WEAKENED. There is no cache rate at which Pro
 * becomes affordable relative to Flash; it is three times the price, always.
 * Combined with Terminal Bench 2.1 (Flash 82.7, Pro 72.1) that leaves no
 * argument for Pro at any temperature, which is where Roman already was:
 * *"no Pro should ever be used… only Flash for coding in general."*
 *
 * ── 🔒 WHAT THIS FILE MAY AND MAY NOT SAY OUT LOUD ──────────────────────────
 *
 * This package is published. `lib/` ships inside the tarball and the repo is
 * readable, so a comment here is a public statement. The line, and it is a line
 * rather than a purge:
 *
 *   KEEP    the engineering — why a design exists, what was measured, how it
 *           failed before, what a reviewer needs to trust the code.
 *   REMOVE  an upstream's NAME next to a price, what an input token costs us,
 *           a margin figure, the pin ORDER, and anything that reads as
 *           "here is how to buy this cheaper without us".
 *
 * "We pin one upstream because the cache lives on it, measured 98.3% against
 * 0%" is engineering and belongs here. The same sentence naming the upstream
 * and its per-call price is a shopping list and does not.
 */

import { labelForModelId } from './acuvo-models.mjs';
/**
 * ⭐ THE PIN, IMPORTED. `provider` below used to be four hand-typed strings and
 * the comment beside the first one already had to say *"a KEY into
 * PROVIDER_PIN_BY_MODEL, not a label"* — which is the admission that a copy was
 * standing in for a lookup. `provider-pin.mjs` has no imports of its own, so
 * this cannot cycle back through `rate-card.mjs`.
 */
import { PROVIDER_PIN_BY_MODEL } from './provider-pin.mjs';

/**
 * The upstream this row's price describes. ⚠️ DERIVED, NEVER TYPED — the same
 * table, hand-copied, is what `provider-pin.mjs`'s header is a post-mortem of.
 * `null` for a model with no pin, which is the honest answer and is what
 * `provider-pin-per-model.test.mjs` should then see.
 */
const pinnedPrimary = (model) => PROVIDER_PIN_BY_MODEL[model]?.[0] ?? null;
import {
  FLASH as FLASH_ID,
  FLASH_0731 as FLASH_0731_ID,
  PRO as PRO_ID,
  VISION as VISION_ID,
  GLM as GLM_ID,
  ratesFor,
  OUTPUT_TOKEN_SHARE as CARD_OUTPUT_TOKEN_SHARE,
} from './rate-card.mjs';

/**
 * Per-million prices, USD, for the endpoint each model is PINNED to.
 *
 * ⚠️ THE PINNED ENDPOINT, NOT THE MODEL PAGE. The model page shows a headline;
 * one model is served by many upstreams at wildly different prices. Acuvo Pro
 * spent a period unpinned and landing on an endpoint charging ~2.8x on fresh
 * tokens and ~28x on cache reads. Quoting the page would have hidden that
 * entirely. See `PROVIDER_PIN_BY_MODEL` in model.mjs.
 *
 * ── ⭐ THE TWO PRIMARY ROWS ARE DERIVED, NOT TYPED ──────────────────────────
 *
 * They come from `rate-card.mjs` (the PEAK column; off-peak is exactly half).
 * They used to be hand-typed, and when the upstream restructured they sat stale
 * for nine days — every plan size and break-even rate this file computes was
 * drawn from that table, so all of them were fiction in the same direction.
 * Deriving them is the only change that makes the next restructure a one-line
 * edit instead of an eight-file hunt. `test/rate-card.test.mjs` fails if this
 * table and the card disagree.
 *
 * ⚠️ PRO'S CACHE READ IS NO LONGER CHEAPER THAN FLASH'S, AND THAT INVERTS A
 * CONCLUSION THIS FILE'S HEADER USED TO DRAW. Pro used to read cache at a small
 * fraction of Flash's rate, which is what made "a long warm session can afford
 * the strong model" arithmetically true. On the current card Pro is ~3.1x
 * DEARER on cache reads, so its premium no longer collapses as the cache warms
 * — it is ~3.0x Flash at every rate. Roman's *"no Pro should ever be used"* was
 * already the decision; the price change removes the last argument against it.
 *
 * ⚠️ THE TWO SECONDARY ROWS ARE UNVERIFIED SINCE THE RESTRUCTURE and are left
 * as last read. Neither shares an upstream with the primary pair, so that event
 * does not apply to them; both are also effectively unrouted (the review model
 * is `internal: true` and reached only by `read_image`/`--refute`, and the other
 * is a rarely-served backup). Left ALONE rather than guessed at — an unmeasured
 * edit to a price is the disease, not the cure.
 *
 * ⚠️ `provider` IS A KEY INTO `PROVIDER_PIN_BY_MODEL`, NOT DOCUMENTATION.
 * `test/provider-pin-per-model.test.mjs` cross-checks the two tables and would
 * go silent without it. Nothing renders this field to a user.
 */
const FLASH_CARD = ratesFor(FLASH_ID);
const FLASH_0731_CARD = ratesFor(FLASH_0731_ID);
const PRO_CARD = ratesFor(PRO_ID);
const VISION_CARD = ratesFor(VISION_ID);
const GLM_CARD = ratesFor(GLM_ID);

export const MODEL_PRICES = Object.freeze({
  [FLASH_ID]: Object.freeze({
    in: FLASH_CARD.inPerM, out: FLASH_CARD.outPerM, cacheRead: FLASH_CARD.cachedInPerM, provider: pinnedPrimary(FLASH_ID),
  }),
  /** ⚠️ The previous Acuvo Flash — no longer the default (2026-09-28), still priced from the card. */
  [FLASH_0731_ID]: Object.freeze({
    in: FLASH_0731_CARD.inPerM, out: FLASH_0731_CARD.outPerM, cacheRead: FLASH_0731_CARD.cachedInPerM, provider: pinnedPrimary(FLASH_0731_ID),
  }),
  [PRO_ID]: Object.freeze({
    in: PRO_CARD.inPerM, out: PRO_CARD.outPerM, cacheRead: PRO_CARD.cachedInPerM, provider: pinnedPrimary(PRO_ID),
  }),
  /**
   * ── ⭐⭐⭐ DERIVED, NOT TYPED — THERE IS NO SECOND PRICE TABLE ANY MORE ─────
   *
   * Roman, 2026-08-28: *"fix the two price tables, this economics and pricing
   * shit has fucked us and the real ones need to be unforgettable."*
   *
   * FLASH and PRO were already derived from `RATE_CARD` and could not drift.
   * These two were HAND-TYPED and nothing compared them to anything — the exact
   * shape of the 7x error, which was a stale copy of a price no guard read.
   * ⚠️ And qwen is not a spare: it is THE EYES, the only model in the chain
   * that can see. Its price was live, in use, and unverifiable.
   *
   * ⭐ `every-price-comes-from-the-card.test.mjs` now fails if ANY entry here
   * is not equal to `ratesFor()`. A new model cannot be added with a typed
   * price — it has to go in the card, where the live-feed guard already checks
   * it against the market.
   */
  [VISION_ID]: Object.freeze({
    in: VISION_CARD.inPerM, out: VISION_CARD.outPerM, cacheRead: VISION_CARD.cachedInPerM, provider: pinnedPrimary(VISION_ID),
  }),
  [GLM_ID]: Object.freeze({
    in: GLM_CARD.inPerM, out: GLM_CARD.outPerM, cacheRead: GLM_CARD.cachedInPerM, provider: pinnedPrimary(GLM_ID),
  }),
});

/**
 * ⚠️ MEASURED, AND SMALLER THAN ANYONE GUESSES. A real 3-round run: 33,544
 * tokens total, 33,258 of them prompt — so **output is 0.9% of the tokens.**
 * That is why cache rate dominates everything: 99% of what we pay for is input,
 * and input is the only half that can be cached. It is also why "make the model
 * write less" is a much weaker lever than it sounds.
 *
 * ⭐ RE-MEASURED 2026-08-25 (`ECONOMICS.md` §3): output is **2.1% of the BILL**
 * and 0.34%–0.56% of the tokens across the surviving ledger. 0.9% stands as the
 * pessimistic end of the observed band. Re-exported from `rate-card.mjs` so the
 * console's cost model and this one cannot hold different values for one fact.
 */
export const OUTPUT_TOKEN_SHARE = CARD_OUTPUT_TOKEN_SHARE;

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
 * ── ⭐ THE PLANS — ONE MODEL, ONE NUMBER (locked 2026-08-21, re-locked 08-23) ─
 *
 * ⚠️⚠️ THIS FILE USED TO SELL THREE TOKEN BUCKETS AND THE ROUTING NEVER MATCHED
 * THEM. It sized Starter as qwen 88M + flash 59M + pro 5M — a mix that assumes
 * qwen carries ~58% of the volume. Measured, qwen leads exactly ONE surface (the
 * tenant assistant route). The builder loop, builder planning (which is not even
 * a separate model call) and EVERY CLI turn run
 * `deepseek/deepseek-v4-flash-0731`: `model.mjs` declares
 * `DEFAULT_MODEL = deepseek/deepseek-v4-flash-0731`, and `engine-names.ts` marks
 * qwen `internal: true` — it never appears in a picker. In the CLI qwen is
 * reached only by `read_image` and opt-in `--refute`; pro only by explicit
 * escalation.
 *
 * ⭐ SO THE ALLOWANCE WAS SIZED ON THE CHEAP MODEL WHILE THE DEAR ONE DID THE
 * WORK. Re-costing the SAME 152M grant at the routing that actually happens
 * moved it several points at every cache rate, and the property that justified
 * the 152M grant in the first place — "it still clears its target in a poor
 * cache month" — was never true. The arithmetic is in the private economics
 * note; what belongs here is the shape of the error, not the figures.
 *
 * ⭐⭐ AND PRO IS NOT A TIER, IT IS A TAX. Roman, 2026-08-21: *"no Pro should
 * ever be used… only Flash for coding in general."* It is not only a cost call:
 * on Terminal Bench 2.1 — practical agentic CLI loops, the task we actually
 * sell — Flash scores 82.7 and Pro 72.1, while Pro costs several times more per
 * token. Paying multiples for ten points WORSE is not an upgrade path.
 *
 * ⚠️ QWEN LEAVES THE ALLOWANCE, NOT THE PRODUCT. It stays a cheap internal lane
 * (review, vision, the image critic). It is no longer SOLD as a number, because
 * three buckets make a buyer do arithmetic to discover what they bought — and
 * because `gateTokens` on the console reads exactly one field, so the other two
 * were allowances nothing metered and nothing enforced.
 *
 * ⚠️ THE ZEROES ARE LOAD-BEARING, NOT LEFTOVERS. `plan-drift.test.ts` compares
 * all three buckets against the console catalogue, and `undefined / 1e6` is
 * `NaN` — deleting the keys would break the guard rather than satisfy it. Zero
 * also carries the right meaning downstream: `allowanceRemaining` reports a 0
 * grant as `available: false` ("not on this plan"), never as `exhausted`
 * ("come back next month").
 */
/** AUD→USD, deliberately conservative — a plan must not depend on a good day. */
export const AUD_USD = 0.645;

/** ⚡ The allowance is granted on the model that runs — v4.1 since 2026-09-28. */
const FLASH = FLASH_ID;
const PRO = 'deepseek/deepseek-v4-pro-0813';
/**
 * ── ⚠️⚠️ THE THIRD MODEL, AND THE CLAIM THAT DID NOT SURVIVE MEASUREMENT ────
 *
 * This constant used to introduce qwen as "the margin lever", on the reasoning
 * that *"roughly 58% of an agent run's tokens are reading rather than writing"*,
 * and that naming it made *"every tier bigger AND more profitable"* — Starter
 * 95M → 152M. Kept here rather than deleted, because the number was not
 * invented and the shape of the error is worth recognising again.
 *
 * ⚠️ THE PRICE ARITHMETIC WAS RIGHT AND THE ROUTING ASSUMPTION WAS WRONG. The
 * review model really is materially cheaper per token than the builder. It
 * simply never gets 58% of the tokens: it is `internal: true`, off every picker,
 * and reached in the CLI only by `read_image` and opt-in `--refute`. A cheaper
 * model that nothing routes to saves nothing, and dividing an allowance by its
 * share turns that into a BIGGER grant — the error compounds in the expensive
 * direction.
 *
 * ⭐ THE LESSON, STATED PLAINLY: a per-model allowance is a claim about
 * ROUTING, not about prices. Nothing in this file could have caught it, because
 * every price in it was correct.
 *
 * The constant stays because the key must stay — see the note on the zeroes.
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
 * ── ⭐⭐ THE ALLOWANCES, DERIVED FROM THE REAL ROUTING (2026-08-24) ──────────
 *
 * With one model doing the work there is one equation, and it is SOLVED rather
 * than chosen — the allowance falls out of the revenue, the target and the
 * cache rate (`planEconomics` and `breakEvenCacheRate` below are that solver).
 * The inputs and the resulting table are business figures and live in the
 * private economics note, not in a published source file.
 *
 * ⭐ WHAT BELONGS HERE IS WHY 95M IS THE CONSERVATIVE ANSWER AND NOT A ROUND
 * ONE: it is sized BELOW the figure a poor cache month would justify, which
 * buys the property worth having — it clears its target from a mediocre cache
 * rate upward, and survives a TOTAL cache failure without going underwater. The
 * old 152M grant did not; it needed a good cache month merely to reach target.
 *
 * ⚠️⚠️ AND THE ENTRY TIER IS DELIBERATELY THE GENEROUS RUNG. Starter grants
 * substantially more tokens per revenue dollar than Growth or Scale, so it
 * earns several points less than they do. That is a real pricing shape, not an
 * arithmetic slip: 95M is a POSITIONING number (more coding tokens than $200 of
 * Claude Max buys at list) while Growth and Scale were sized against the target.
 * Recorded rather than corrected — whether Growth should get more Flash is
 * Roman's call, and `c91f9c4ab` says so explicitly.
 *
 * ⚠️ THIS FILE COSTS TOKENS ONLY. The console's `worstCaseMargin` also loads
 * every credit and every voice minute onto the same revenue, so it answers a
 * harsher question and gets a lower number. Neither is wrong; the console's is
 * the one that decides whether a tier is sellable.
 */
export const PLANS = Object.freeze({
  /**
   * ⚠️ THE REVIEW-MODEL BUCKET WENT WITH THE REST. The free tier's job is to
   * let someone FORM A JUDGEMENT, and a bucket they cannot spend on the thing
   * they came to try is not part of that. 4M is small enough to be affordable
   * even with the cache failed completely — that is the constraint it was sized
   * against.
   */
  free: Object.freeze({
    id: 'free', label: 'Free', priceUsd: 0, currency: 'AUD', priceLocal: 0,
    tokens: Object.freeze({ [QWEN]: 0, [FLASH]: 4_000_000, [PRO]: 0 }),
    includesReview: true,
  }),
  /**
   * ── ⭐ 95M FLASH AND NOTHING ELSE ──────────────────────────────────────────
   *
   *     was  three buckets totalling 152M, priced at a routing that never
   *          happened — so it was never worth what it advertised
   *     now  95M Acuvo Flash, sized at the routing that actually runs
   *
   * ⚠️ THE HEADLINE FELL 152M → 95M AND THAT IS THE POINT, not a cut to be
   * apologised for. 152M was the size of a grant priced at qwen rates for work
   * that runs on flash; it was never worth what it said. 95M is what A$29 buys
   * at the routing that actually happens, and it is still more coding tokens
   * than $200 of Claude Max buys at list — which is the comparison to make,
   * because it is about volume and not about quality.
   */
  starter: Object.freeze({
    id: 'starter', label: 'Starter', priceUsd: 29 * AUD_USD, currency: 'AUD', priceLocal: 29,
    tokens: Object.freeze({ [QWEN]: 0, [FLASH]: 95_000_000, [PRO]: 0 }),
    includesReview: true,
  }),
  /**
   * ⚠️ THE FLASH FIGURES ARE UNTOUCHED — 161M and 406M are exactly what the
   * console already sells. Only the pro and qwen buckets were withdrawn, and
   * withdrawing a cost we were never going to pay is a consistency fix. Whether
   * Growth should get MORE flash to make up for it is a PRICING decision and it
   * is Roman's; folding it in silently under a drift fix is how a pricing page
   * changes without anyone deciding to change it.
   *
   * ⚠️ The 2026-08-18 note here said the split was re-cut to hold Starter's
   * model blend for `acuvo-gateway/lib/topups.mjs`, which "refuses when the
   * mixes drift apart". That constraint is satisfied trivially now — every tier
   * is 100% flash — but ⚠️ THE GATEWAY HAS ITS OWN THIRD LADDER
   * (`acuvo-gateway/lib/meter.mjs`, `PLANS.*.tokenCaps`) still carrying the old
   * 88/59/5 split, and unlike this one it is ENFORCED. See the report note.
   */
  growth: Object.freeze({
    id: 'growth', label: 'Growth', priceUsd: 79 * AUD_USD, currency: 'AUD', priceLocal: 79,
    tokens: Object.freeze({ [QWEN]: 0, [FLASH]: 161_000_000, [PRO]: 0 }),
    includesReview: true,
  }),
  scale: Object.freeze({
    id: 'scale', label: 'Scale', priceUsd: 199 * AUD_USD, currency: 'AUD', priceLocal: 199,
    tokens: Object.freeze({ [QWEN]: 0, [FLASH]: 406_000_000, [PRO]: 0 }),
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
 * **A pooled allowance with the strong model billed at a multiplier.** Elegant,
 * and the multiplier WAS NOT A CONSTANT on the card in force when this was
 * proposed — it swung by more than 2x across the cache range. Any published
 * figure is therefore wrong most of the time: either we overcharge on warm
 * sessions or we lose money on cold ones, and the user cannot predict their own
 * limit either way. Two honest numbers beat one that lies. (⚠️ The premium is
 * flat now, so the arithmetic objection is weaker — but the tier is gone
 * entirely, which makes the question moot rather than reopened.)
 *
 * **Unlimited default model, metered strong model.** Measured against real
 * usage, the return falls away sharply across the usage percentiles and the top
 * one does not survive. "Unlimited" needs a fair-use cap to hold, and a cap is
 * an allowance with worse manners.
 */
export const REJECTED_STRUCTURES = Object.freeze(['pooled-with-multiplier', 'unlimited-flash']);

/**
 * ── 🔒 INTERNAL ACCOUNTING. NOT RENDERED TO A USER. ─────────────────────────
 *
 * Unit economics for a plan at a given cache rate: what it costs to serve and
 * what that leaves. It exists so pricing decisions are SOLVED rather than
 * chosen, and so a tier cannot be moved without the arithmetic moving with it.
 *
 * ⚠️⚠️ NOTHING ON A DEFAULT CODE PATH MAY PRINT WHAT THIS RETURNS. It used to:
 * `formatPlan` put a per-model unit cost and a margin percentage straight onto
 * the terminal of anyone who typed `acuvo spend`, which told every
 * customer what we pay and what we make on them. `formatPlan` now renders the
 * ALLOWANCE only, and the economics lines are behind an off-by-default env var.
 * If you add a caller, it must be an internal one.
 *
 * ⚠️ IT TAKES THE CACHE RATE BECAUSE THERE IS NO SINGLE ANSWER. A figure quoted
 * without one is a number somebody chose.
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
 * ── 🔒 INTERNAL. THE CACHE RATE AT WHICH A PLAN STOPS PAYING ────────────────
 *
 * The single most useful number for pricing a plan, and it cannot be reasoned
 * to — it has to be solved for. Below this rate the plan misses its target,
 * which is the alarm the pin and the compaction rules exist to keep from
 * ringing.
 *
 * ⚠️ ITS `note` IS A SENTENCE ABOUT OUR ECONOMICS, so it renders only behind
 * `ACUVO_PLAN_ECONOMICS` — see `formatPlan`, which used to print it unguarded.
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

/**
 * ⚠️ THE ENV VAR THAT TURNS THE INTERNAL LINES ON. Unset in every shipped
 * environment; nothing in `--help`, the README or the install path mentions it.
 * A user cannot reach the economics view by accident, and reaching it on purpose
 * requires already knowing this name.
 */
export const PLAN_ECONOMICS_ENV = 'ACUVO_PLAN_ECONOMICS';

/**
 * ── ⚠️⚠️ THIS PRINTED OUR COST STRUCTURE TO THE CUSTOMER ────────────────────
 *
 * `acuvo spend` — a normal, documented, no-flag command — ended with three
 * lines that, until 2026-08-25, carried in this order: the raw UPSTREAM MODEL
 * ID beside what that allowance COSTS US to serve at the observed cache rate; a
 * total unit cost and a MARGIN PERCENTAGE; and the cache rate below which the
 * plan stops clearing its target.
 *
 * Three separate disclosures in three lines: who we buy from, what a plan costs
 * us to serve, and what we make on it. (The figures are deliberately not
 * reproduced here — republishing them in the comment that removes them would be
 * the same leak with better manners.)
 *
 * An outside evaluator had already read the developers page and concluded the
 * sensible move was to skip us and buy direct. This was the same invitation,
 * printed by the product itself, to every paying customer.
 *
 * ⭐ WHAT A USER SHOULD SEE IS THEIR SIDE OF THE DEAL, and that is what is left:
 * the plan, the price they pay, and the allowance they get. Those are the
 * product. `bin/acuvo.mjs` prints the used-of-granted lines immediately above
 * this block, so the whole answer to "how much have I got left" survives intact.
 *
 * ⚠️ THE MODEL IS NAMED WITH OUR NAME, NOT THE UPSTREAM ID. It printed the raw
 * vendor id while the usage lines four rows higher already used
 * `labelForModelId` — the same fact, two vocabularies, one of them somebody
 * else's product name in the middle of ours. `acuvo-models.mjs` states the
 * doctrine; this line was violating it.
 *
 * ⚠️ THE ECONOMICS ARE NOT DELETED, THEY ARE GATED. `planEconomics` and
 * `breakEvenCacheRate` are how a tier gets priced, and a pricing session needs
 * to see them. They render only when `ACUVO_PLAN_ECONOMICS=1` is set in the
 * environment, which is off everywhere by default.
 */
export function formatPlan(plan, cacheRate = 0.95) {
  const price = plan.currency === 'AUD' ? `$${plan.priceLocal} AUD (~$${plan.priceUsd.toFixed(2)} USD)` : `$${plan.priceUsd} USD`;
  const lines = [`${plan.label} — ${plan.priceUsd === 0 ? 'free' : price}`];
  for (const [model, tokens] of Object.entries(plan.tokens)) {
    if (!tokens) continue;
    lines.push(`  ${(tokens / 1e6).toFixed(0)}M  ${labelFor(model)}`);
  }

  /**
   * ⚠️ READ AT CALL TIME, NOT AT IMPORT. A module-level snapshot would make the
   * gate untestable without a subprocess, and a gate nobody can test is a gate
   * nobody can prove is shut.
   */
  if (process.env?.[PLAN_ECONOMICS_ENV] !== '1') return lines;

  const e = planEconomics(plan, cacheRate);
  lines.push(`  [internal · ${PLAN_ECONOMICS_ENV}]`);
  for (const [model, tokens] of Object.entries(plan.tokens)) {
    if (!tokens) continue;
    const per = costPerMillion(model, cacheRate);
    lines.push(`    ${labelFor(model)}: ${per === null ? 'unpriced' : `$${((tokens / 1e6) * per).toFixed(2)} at ${(cacheRate * 100).toFixed(0)}% cache`}`);
  }
  if (e.marginPct !== null) {
    lines.push(`    unit cost $${e.cogsUsd.toFixed(2)} · ${e.marginPct.toFixed(0)}%`);
    lines.push(`    ${breakEvenCacheRate(plan, 80).note}`);
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
 * have used 95M of 95M Acuvo Flash this period — Growth grants 161M" is a
 * decision. A gate that cannot be acted on just moves the user to a competitor
 * with a clearer error message.
 *
 * ── ⚠️⚠️ AN OPEN HAZARD, RECORDED BECAUSE IT IS NOT MINE TO CLOSE ───────────
 *
 * Since 2026-08-24 NO tier grants qwen or pro, so this function answers
 * `not-on-plan` for either on every metered tier — including the internal qwen
 * calls behind `read_image` and `--refute`, which are things the product does
 * rather than things the user buys. Nothing breaks TODAY because this function
 * has no runtime caller in the CLI (`bin/acuvo.mjs` uses `allowanceRemaining`
 * for display; real enforcement is `gateTokens` behind the console gateway,
 * which reads the flash field only). ⚠️ But wiring this gate to the request
 * path without first deciding how internal models are treated would refuse a
 * paid user's `read_image` on a plan that has 95M tokens left. The fix is a
 * decision about whether internal lanes bill the flash bucket or nothing at
 * all — it spans this file and the gateway, so it is stated, not guessed.
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

/**
 * ── ⚠️⚠️ THIS WAS A SECOND COPY OF THE BRAND MAP, AND IT DRIFTED ────────────
 *
 * It read: *"Acuvo's name for a provider id, without importing the catalogue
 * into the math"* — and hardcoded `Acuvo Flash` / `Acuvo Pro`. The moment the
 * labels were versioned in `acuvo-models.mjs`, this file kept printing the old
 * names, in the messages a user sees when they run out of allowance. Two places
 * naming the same product, one of them silently a version behind.
 *
 * ⭐ THE STATED REASON DID NOT HOLD. `acuvo-models.mjs` is a LEAF — it imports
 * nothing — so pulling it in adds no dependency chain to "the math"; it is a
 * frozen object. Avoiding the import bought nothing and cost a divergence.
 *
 * This is the fourth instance of the same shape found today: a mapping copied
 * rather than imported, correct on the day it was written, wrong the first time
 * the original changed.
 */

const labelFor = labelForModelId;

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
