/**
 * ── ⭐⭐ STOP AT A DOLLAR, NOT AT A COUNTER ──────────────────────────────────
 *
 * Today the loop stops because `round > maxRounds`. That number is arbitrary —
 * it is not a thing the user has an opinion about, it does not correspond to
 * anything they can feel, and it is the reason `plan-ledger.mjs` had to be
 * written at all: the agent kept driving into a wall it could not see and
 * losing the LAST deliverable every single time.
 *
 * The constraint that is real is MONEY. "Keep going until the job is done or
 * you have spent fifty cents" is a sentence a user can actually reason about,
 * and nobody in this category sells it. This module is that sentence.
 *
 * ── ⭐ THE ONE DECISION THAT MAKES IT SAFE ───────────────────────────────────
 *
 * NEVER START A ROUND YOU CANNOT AFFORD TO FINISH.
 *
 * The naive governor stops when `spent >= limit`. That guarantees an overshoot,
 * because the round that crosses the line has already been paid for by the time
 * anyone can look. So the check here is on the PROJECTION: refuse when
 * `spent + projectedNextRound` would cross the line, while there is still room
 * to have been wrong.
 *
 * ⚠️ Overshooting a stated budget is the one behaviour that makes a user never
 * trust the flag again. Stopping a few percent short costs them nothing they
 * will ever notice. Every trade-off below is resolved in that direction, the
 * same way `stuck.mjs` resolves its own asymmetry.
 *
 * ── ⚠️ ROUNDS ARE NOT UNIFORM, SO A FLAT AVERAGE IS A BUG ────────────────────
 *
 * Cost per round GROWS, because every round carries the whole history back into
 * the prompt. A mean over all rounds is therefore dragged down by the cheap
 * early ones, under-projects the expensive late ones, and overshoots exactly
 * when it matters most — at the end of a long run, where the rounds are most
 * expensive and the remaining budget is thinnest.
 *
 * So the projection is a LINEAR EXTRAPOLATION over a sliding window of the most
 * recent rounds (`trendWindow`, default 3):
 *
 *     slope   = (last − first) / (n − 1)       across the window
 *     trend   = last + slope
 *     raw     = max(trend, peak-in-window)     never project below a recent peak
 *     usd     = raw × safetyFactor             the figure decisions are made on
 *
 * Two clamps, each with a reason:
 *   · `max(…, peak)` — a dip must not be read as a downward trend and used to
 *     justify one more round, and one cheap round after an expensive one must
 *     not reset the estimate. The window slides, so this forgets on its own
 *     after `trendWindow` rounds; it is conservatism with an expiry date.
 *   · `safetyFactor` — 10% of headroom, because a straight line cannot see a
 *     curve coming.
 *
 * ⚠️ THERE WAS A THIRD CLAMP AND MUTATION TESTING PROVED IT WAS DEAD CODE.
 * `trend = last + max(0, slope)` was written here first, with a confident
 * comment about never extrapolating downward. Deleting the `max(0, …)` changed
 * ZERO test outcomes, and the algebra says why it always will: `slope < 0` means
 * `last < first ≤ peak`, so `trend = last + slope < last ≤ peak` and the peak
 * clamp had already decided the answer. A line that cannot fire, sitting under a
 * comment claiming it is load-bearing, is the exact failure this package has
 * been bitten by seven times — so it is gone, and the peak clamp is documented
 * as the thing that actually enforces the rule.
 *
 * ⚠️ AND THE HONEST LIMIT OF THAT: a cost curve growing faster than ~1.4x PER
 * ROUND can still cross the line, because no linear extrapolation catches an
 * exponent. The overshoot is bounded by ONE round's cost — never unbounded, and
 * `reserveUsd` exists as the second line of defence for anyone who cares. The
 * test suite pins that bound rather than pretending the guarantee is absolute.
 *
 * ── ⚠️⚠️ AND THE FAILURE THAT WOULD BE WORST OF ALL: UNKNOWN PRICED AS FREE ──
 *
 * OpenRouter usually returns `usage.cost`. Not always. `aggregateUsage` in
 * turn.mjs already handles a null usage by skipping it — correct for a summary
 * line, catastrophic for a governor: a run whose provider stops reporting cost
 * would spend `spent += 0` forever and bill the user for the privilege. That is
 * the worst available failure in this file, so unknown is NEVER zero:
 *
 *   1. a real `cost` (or `costUsd`)      → believed, even when it is 0.0
 *   2. no cost but a token count         → priced at `usdPerMillionTokens`
 *   3. nothing at all                    → charged the CURRENT PROJECTION
 *
 * and cases 2 and 3 mark the whole total as an ESTIMATE, which `report()` says
 * out loud with the count of blind rounds. A number the user might act on must
 * never hide that it was guessed.
 *
 * ⚠️ CASE 1 INCLUDES ZERO ON PURPOSE. Free-tier and fully-cached completions
 * really do cost $0.00, and "helpfully" replacing that with an estimate is a
 * check that fails correct work — the mistake this repo has made four times in
 * one day. An explicit zero is data; an absent field is not.
 *
 * ── ⚠️ THE FLOOR ────────────────────────────────────────────────────────────
 * A budget too small to fit one round must fail BEFORE the first request, with
 * a message naming both numbers. Starting, spending, and then stopping with
 * nothing to show is strictly worse than refusing. `canContinue()` returns
 * `reason: 'too-small'` for that, distinct from `'would-exceed'` (ran out) and
 * `'limit-reached'` (nothing left at all) — three different mistakes deserve
 * three different words.
 *
 * ── ⚠️⚠️ AND THE THIRD FAILURE, FOUND 2026-08-14: A WHOLE CATEGORY MISSING ──
 *
 * Everything above governs MODEL tokens. Every GPU dollar — `generate_image`,
 * `see_page`, `speak`, `transcribe`, `make_document`, `read_document`,
 * `read_table` — was outside the book entirely, so `--budget`, `--fleet-budget`
 * and `acuvo spend` were three features priced off a number that excluded the
 * most expensive verb in the package. See the meter below: it charges the same
 * ledger, against the same ceiling, and labels every dollar of it an ESTIMATE
 * because nobody bills us per call.
 *
 * ── PURE ABOUT THE THINGS THAT MATTER ───────────────────────────────────────
 * No network, no model, no fs, no ambient time. Data in, data out, plus an
 * injected clock — which is why the whole thing is provable for $0.00, and why
 * the "$0.01 is a lot when testing" rule is not even slightly strained by it.
 * ⚠️ The GPU meter below IS module-level state, because a GPU verb has no
 * handle on the run's governor to charge; `resetSpendMeter()` is its seam.
 *
 * WIRING: see the note at the bottom of this file. It is ten lines in
 * `runSession` plus one flag.
 */

/**
 * The seed used before a single round has been observed.
 *
 * MEASURED, not guessed: `turn.mjs` records a real round at 1,036 tokens and
 * $0.000231. This sits ~2x above it, because the seed's only job is to answer
 * "can this budget afford ANYTHING" and a seed that under-estimates lets a
 * hopeless budget start. It is replaced by real data the moment round 1 lands.
 */
export const DEFAULT_FIRST_ROUND_USD = 0.0005;

/**
 * ── ⭐⭐ THE CEILING IS ON BY DEFAULT, AND THAT IS THE PRODUCT ───────────────
 *
 * This governor existed, worked, and was UNREACHABLE: `budgetUsd` defaulted to
 * null, so the one behaviour no competitor offers — a hard cap enforced BEFORE
 * the round, not an alert after it — required typing a flag nobody knew about.
 * A differentiator behind an unknown flag is not a differentiator.
 *
 * ── WHY $0.02 AND NOT A ROUNDER NUMBER ──────────────────────────────────────
 * Measured on this package: a task costs $0.0008–$0.003, a full three-rung
 * escalation $0.0035, and a real round $0.000231. $0.02 is ~7–25x a whole task
 * and ~85x a round. So on ordinary work it never fires, and on a runaway it
 * costs two cents to find out.
 *
 * ⚠️ A CEILING IS A BLAST RADIUS, NOT A TARGET, and it must not become a check
 * that fails correct work. Two guards make that true: the loop already stops
 * itself long before this (`verified`, `no-tool-calls` — nothing in the shipped
 * bench has ever consumed its round budget), and when this DOES fire on a limit
 * the user never chose, the message says so and names the flag that raises it.
 * A wall with no way over it is the failure this repo keeps paying for.
 *
 * ⚠️ AND IT IS NOT A SPEND COMMITMENT. Nothing here makes a run cost more; it
 * can only make one stop earlier.
 *
 * ── ⚠️⚠️ READ THIS BEFORE CHANGING THE NUMBER (added 2026-08-14) ────────────
 *
 * The measurements above are MODEL measurements, and until today they were the
 * only spend the ceiling could see. Now that GPU time is charged too, one
 * number in this comment is quietly out of date: **a cold image render is
 * $0.0398 — twice this ceiling on its own.** So a default-budget run that calls
 * `generate_image` once will now stop straight after it.
 *
 * ⭐ THAT IS THE CEILING WORKING, NOT A REGRESSION. The work genuinely cost
 * four cents; before today it reported $0.002 and carried on, which is the
 * defect. The stop message says it is the default, not a number the user chose,
 * and names the flag that raises it.
 *
 * ⚠️ BUT IT IS A REAL PRODUCT DECISION AND IT IS NOT MINE TO MAKE. Raising this
 * to accommodate imagery is a deliberate change to what "the default blast
 * radius" means, and it should be made by someone looking at the whole product,
 * not smuggled in beside a metering fix. It is named here so the next person to
 * meet it knows it was seen rather than missed.
 */
/**
 * ── ⭐⭐⭐ RAISED $0.02 → $0.25 ON 2026-08-19 — THE DECISION NAMED ABOVE ─────
 *
 * The paragraph above says this is *"a real product decision and it is not
 * mine to make… it should be made by someone looking at the whole product."*
 * Roman made it: *"we need to get it insanely good fast… it's not capable and
 * it shouldn't take this long."*
 *
 * ⚠️ THE SIZE OF THE CHANGE IS SMALLER THAN IT LOOKS. Two measured live runs
 * the same day cost **$0.0039 and $0.0019** — so the old default was not a
 * budget, it was a hard stop roughly five tasks wide.
 *
 * ⭐⭐ AND THE NUMBER IS MATCHED TO `DEFAULT_MAX_ROUNDS`, NOT PICKED. I first
 * set this to $0.25 and `test/budget-default-ceiling.test.mjs` refused it —
 * correctly. It asserts BOTH bounds: clear the dearest observed task several
 * times over, **and** stay cheap enough that a runaway is cheap to discover.
 *
 * The arithmetic the guard forced: 24 rounds at roughly $0.001–$0.003 a round
 * (rounds get dearer as context grows) is **$0.03–$0.06**. So $0.05 is the
 * budget that actually backs 24 rounds. $0.25 would have been an allowance for
 * ~100 rounds against a hard cap of 64 — money that could only ever be spent by
 * a loop going nowhere.
 *
 * ⚠️ THIS IS THE BLAST RADIUS AND THAT IS WHY IT IS BOUNDED. Rounds are nearly
 * free to raise because the loop self-stops at `verified`; money is not,
 * because a loop going nowhere spends its whole allowance.
 *
 * ⭐ Overridable per run (`--budget`), and the stop message names the flag — a
 * user who hits it is told it was a default, not a choice they made.
 */
export const DEFAULT_BUDGET_USD = 0.05;

/**
 * ── ⚠️⚠️ THE CEILING WAS PER TURN, AND IT IS SOLD AS PER RUN ────────────────
 *
 * `--help` and README call `--budget` the ceiling for the run. In an interactive
 * session it was handed out FRESH ON EVERY TURN: `runChat` loops calling
 * `oneTurn`, and `oneTurn` passed `opts.budgetUsd` unmodified each time. A
 * forty-turn conversation therefore permitted forty times the number the user
 * agreed to — $0.80 against a stated $0.02.
 *
 * ⭐ The one-shot path was always correct (one turn, nothing to accumulate), and
 * the RESUME path already got this right — it subtracts the prior run's spend
 * before starting. This is that same subtraction, applied to the turn loop, and
 * kept in one pure function so the two paths cannot drift into two answers.
 *
 * ⚠️ RETURNS null FOR "NO CEILING", because that is what an absent budget means
 * everywhere else in this file. Do not coerce it to 0 — a 0 budget can never
 * start a round, so the two must never be confused.
 *
 * @param {number|null} limitUsd the ceiling for the whole session
 * @param {number} spentUsd what previous turns already cost
 * @returns {{ ok: boolean, remainingUsd: number|null, message?: string }}
 */
/**
 * ── ⭐⭐ THE WAY OUT, AND WHY IT CANNOT BE ONE SENTENCE ──────────────────────
 *
 * "A refusal that does not say what to type is just an obstacle" is this
 * package's rule and the reason its refusals are its best-written part. But the
 * advice has to be TRUE, and there are now three different ceilings wearing the
 * same message.
 *
 * ⚠️ THE ONE THAT WAS WRONG: a ceiling set by `.acuvo/policy.json` told the user
 * to "raise it with --budget" — which cannot work, because `costBudget` takes
 * the MINIMUM of the policy's number and the user's. So the refusal handed out a
 * remedy that is guaranteed to fail, and the user would have tried it, watched
 * nothing change, and concluded the tool was broken rather than governed.
 *
 * ⭐ An admin cap that a user could type their way past would not be a cap. The
 * honest sentence says who set it and where it lives.
 *
 * @param {{ limitUsd: number, limitIsDefault?: boolean, limitSource?: string|null }} o
 */
export function budgetWayOut({ limitUsd, limitIsDefault = false, limitSource = null }) {
  if (limitSource === 'policy') {
    return ` This ceiling comes from .acuvo/policy.json, so --budget cannot raise it —`
      + ` change maxCostUsd there, or ask whoever set the policy.`;
  }
  if (limitIsDefault) {
    return ` This is the default ceiling of ${formatUsd(limitUsd)}, not one you set —`
      + ` raise it with --budget (e.g. --budget 0.50) or remove it with --budget none.`;
  }
  return ' Raise it with --budget if the job needs more.';
}

export function remainingForTurn(limitUsd, spentUsd = 0, { limitIsDefault = false, limitSource = null } = {}) {
  if (limitUsd === null || limitUsd === undefined) return { ok: true, remainingUsd: null };
  const spent = Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0;
  const left = limitUsd - spent;
  if (left <= USD_EPSILON) {
    return {
      ok: false,
      remainingUsd: 0,
      message: `this session has spent ${formatUsd(spent)} of its ${formatUsd(limitUsd)} budget, so there is `
        + `nothing left for another turn.${budgetWayOut({ limitUsd, limitIsDefault, limitSource })}`,
    };
  }
  return { ok: true, remainingUsd: left };
}

/**
 * ── ⭐⭐ THE CEILING WAS DISCOVERED AT ROUND 6 AND IT IS KNOWABLE AT ROUND 1 ──
 *
 * `canContinue()` above is a per-round question: *can I afford the NEXT round?*
 * It is the right question to STOP on and the wrong one to PLAN on, because the
 * first time it says no is the first time the user hears anything at all. On the
 * default ceiling that lands around round 6 — five rounds of money already
 * spent, the work half-done, and the remedy (`--budget 0.50`) only useful if you
 * start again from nothing.
 *
 * ⭐ The moment the arithmetic becomes possible is the END OF ROUND 1: one real
 * round has been priced, so `projectNext()` has data instead of a seed, and
 * `maxRounds` is known. Multiplying the two is the whole forecast. Everything
 * this function needs already existed; nobody was asking.
 *
 * ── ⚠️⚠️ IT FORECASTS. IT MUST NOT REFUSE. ──────────────────────────────────
 *
 * The tempting shape is "if the run cannot afford all its rounds, stop now" —
 * i.e. hoist the existing `would-exceed` refusal to round 1. That would be a
 * check that fails correct work, which this package has paid for four times in
 * one day. `maxRounds` is a CEILING, not a plan: the loop already stops itself
 * on `verified` and `no-tool-calls`, and nothing in the shipped bench has ever
 * consumed its round budget. Refusing a run that would have finished in three
 * rounds, because it could not have afforded sixteen, breaks the common case to
 * warn about the rare one.
 *
 * ⭐ So the STOP stays exactly where it was — `canContinue()`, unchanged, same
 * constant, same reasons — and this adds only the SENTENCE, at the point where
 * hearing it is still actionable: after one round the user has spent a fraction
 * of a cent and can restart with a real ceiling having lost nothing.
 *
 * ── ⚠️ THE NUMBER IS A FLOOR AND THE MESSAGE SAYS SO ────────────────────────
 *
 * `projectedUsd × roundsRemaining` assumes every remaining round costs what the
 * next one is projected to cost. The header of this file establishes the
 * opposite — cost per round GROWS, because every round carries the whole history
 * back into the prompt. So the total is an UNDER-estimate, and the direction is
 * the safe one for a warning (we cannot cry wolf) and the unsafe one for a
 * refusal (we would under-warn). That asymmetry is a second reason this is not
 * a stop: a number good enough to caution with is not good enough to act on.
 *
 * ⚠️ AND IT REUSES `budgetWayOut`. Three ceilings already wear different
 * remedies (default / explicit / policy), and a fourth sentence written here
 * would be the fourth place for that to drift — the exact failure recorded
 * against `FLEET_STOP_REASONS` below.
 *
 * @param {object} o
 * @param {number} o.remainingUsd   what is left AFTER the reserve, right now
 * @param {number} o.projectedUsd   what the next round is projected to cost
 * @param {number|null} o.limitUsd  the stated ceiling, for the sentence
 * @param {number} o.spentUsd       the run's total so far
 * @param {number} o.roundsUsed     rounds already priced
 * @param {number} o.maxRounds      the round ceiling this run was given
 * @returns {{ ok: boolean, reason: string, roundsAffordable: number, roundsRemaining: number,
 *             stopsAtRound: number|null, projectedTotalUsd: number, message: string }}
 */
export function forecastRun({
  remainingUsd,
  projectedUsd,
  limitUsd = null,
  spentUsd = 0,
  roundsUsed = 0,
  maxRounds = 0,
  limitIsDefault = false,
  limitSource = null,
} = {}) {
  const none = (reason, message) => ({
    ok: true, reason, roundsAffordable: Infinity, roundsRemaining: 0,
    stopsAtRound: null, projectedTotalUsd: isNum(spentUsd) ? spentUsd : 0, message,
  });
  if (limitUsd === null || limitUsd === undefined || !Number.isFinite(remainingUsd)) {
    return none('no-budget-set', 'no budget limit set, so there is nothing to forecast against.');
  }
  const roundsRemaining = Math.max(0, Math.floor(maxRounds) - Math.floor(roundsUsed));
  if (roundsRemaining === 0) return none('fits', 'no rounds remain, so there is nothing left to buy.');
  /**
   * ⚠️ A ZERO OR NEGATIVE PROJECTION CANNOT BE DIVIDED BY, and it is reachable:
   * a fully-cached or free-tier round really does report $0.00, which the header
   * of this file insists on believing. "Every round is free" is a legitimate
   * state, and the honest forecast for it is that the money never runs out.
   */
  if (!isNum(projectedUsd) || projectedUsd <= 0) {
    return none('fits', 'the last round cost nothing, so no total can be projected from it yet.');
  }

  const roundsAffordable = Math.max(0, Math.floor((remainingUsd + USD_EPSILON) / projectedUsd));
  const projectedTotalUsd = spentUsd + (projectedUsd * roundsRemaining);
  if (roundsAffordable >= roundsRemaining) {
    return {
      ok: true,
      reason: 'fits',
      roundsAffordable,
      roundsRemaining,
      stopsAtRound: null,
      projectedTotalUsd,
      message: `at ~${formatUsd(projectedUsd)} a round, all ${roundsRemaining} remaining round`
        + `${roundsRemaining === 1 ? '' : 's'} fit inside the ${formatUsd(limitUsd)} ceiling.`,
    };
  }

  /**
   * ⚠️ `+ 1` BECAUSE THE ROUND THAT IS REFUSED IS THE ONE AFTER THE LAST
   * AFFORDABLE ONE. Naming the last round that WORKS would send the user looking
   * for a stop message on a round that succeeded.
   */
  const stopsAtRound = Math.floor(roundsUsed) + roundsAffordable + 1;
  return {
    ok: false,
    reason: 'will-run-out',
    roundsAffordable,
    roundsRemaining,
    stopsAtRound,
    projectedTotalUsd,
    message: `at ~${formatUsd(projectedUsd)} a round this run needs at least ${formatUsd(projectedTotalUsd)} to use all `
      + `${Math.floor(maxRounds)} of its rounds, and the ceiling is ${formatUsd(limitUsd)} — on this trend it stops around `
      + `round ${stopsAtRound} of ${Math.floor(maxRounds)}. That total is a FLOOR: rounds get dearer as the transcript grows. `
      + `It may well finish sooner and never reach the wall.${budgetWayOut({ limitUsd, limitIsDefault, limitSource })}`,
  };
}

/**
 * The fallback price when the provider reports tokens but no cost.
 *
 * Same measurement, inverted: 1,036 tokens for $0.000231 is $0.223 per million.
 * Rounded UP to $0.30, because over-pricing an unknown stops the run slightly
 * early and under-pricing it lets the run overshoot — and only one of those two
 * shows up on a bill.
 *
 * ── ⚠️⚠️ THAT MEASUREMENT WAS A COLD ROUND, AND EVERY REAL SESSION IS NOT ────
 *
 * Corrected 2026-08-21 against a real end-to-end run: a 5-round bug-fix task
 * reported **87,814 tokens at 80% cache** and was priced at $0.0263 by this
 * constant. The console's own measured rate for the same model —
 * `FLASH_COST_MICROS_PER_MILLION`, derived from real builds — is **$0.0357 per
 * million blended**, and **$0.117 cold**. So $0.30 is ~2.6x the COLD rate and
 * ~8x the rate an actual cached session pays. That run really cost about
 * **$0.003**, not $0.026.
 *
 * ⚠️ THE HARM IS NOT COSMETIC. This constant governs `canContinue()`, so a user
 * with the default ceiling was being stopped after roughly an eighth of the work
 * they had paid for, and every cost line the CLI printed overstated by the same
 * factor. "Over-pricing an unknown stops the run slightly early" was true at
 * 1.3x; it is a different claim at 8x.
 *
 * ⭐ SET TO THE COLD RATE, NOT THE BLENDED ONE. The safe direction still
 * matters: this fires exactly when the provider went silent, and a silent
 * provider is also the case where a session might genuinely be uncached (round 1
 * is ALWAYS 0% cache, and a fresh session is all round ones). Pricing the
 * unknown at the worst REAL rate keeps the governor honest without inventing a
 * 2.6x penalty on top of it.
 */
export const DEFAULT_USD_PER_MILLION_TOKENS = 0.30;

/**
 * ── ⭐⭐ THE PER-MILLION RATES, BY WHAT THE TOKEN ACTUALLY IS ────────────────
 *
 * DeepSeek Flash prices input, output and cached input differently, which is the
 * whole reason a single blended constant could not be right. Cached input is
 * roughly a tenth of fresh input — that discount IS the business model, and
 * pricing it at the fresh rate is what made a cached session look 8x dearer than
 * it was.
 *
 * ⚠️ Exported so a test can hold them and so nobody re-derives them inline.
 */
export const RATE_USD_PER_MILLION = Object.freeze({
  input: 0.14,
  output: 0.28,
  cachedInput: 0.014,
});

/**
 * Price one round from the token SPLIT, or null when the usage object does not
 * carry one.
 *
 * ⚠️ ACCEPTS BOTH VOCABULARIES. OpenRouter says `prompt_tokens` /
 * `completion_tokens` and nests the cache read under
 * `prompt_tokens_details.cached_tokens`; DeepSeek's own API says
 * `prompt_cache_hit_tokens` at the top level. A reader that knows one spelling
 * silently prices the other at zero cache — which is the same 8x error wearing
 * a different hat.
 *
 * ⚠️ AND CACHED IS CLAMPED TO PROMPT. A provider reporting more cached tokens
 * than prompt tokens would otherwise produce a NEGATIVE fresh-input term and
 * under-bill; clamping keeps the arithmetic honest against a bad payload.
 */
export function priceFromSplit(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

  const prompt = n(u.promptTokens) ?? n(u.prompt_tokens);
  const completion = n(u.completionTokens) ?? n(u.completion_tokens);
  if (prompt === null || completion === null) return null;

  const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object'
    ? u.prompt_tokens_details
    : {};
  const cachedRaw = n(u.cachedTokens)
    ?? n(u.cached_tokens)
    ?? n(details.cached_tokens)
    ?? n(u.prompt_cache_hit_tokens)
    ?? 0;
  const cached = Math.min(cachedRaw, prompt);
  const fresh = prompt - cached;

  return (fresh / 1e6) * RATE_USD_PER_MILLION.input
    + (cached / 1e6) * RATE_USD_PER_MILLION.cachedInput
    + (completion / 1e6) * RATE_USD_PER_MILLION.output;
}

/** How many recent rounds the trend is drawn through. */
export const DEFAULT_TREND_WINDOW = 3;

/** Headroom on every projection. A straight line cannot see a curve coming. */
export const DEFAULT_SAFETY_FACTOR = 1.1;

/**
 * A trillionth of a cent. Exists so that `0.001 + 0.001 + 0.001 > 0.003`
 * (which is TRUE in IEEE 754 by 5e-19) cannot refuse a round that exactly fits.
 * Float noise must never be the thing that stops a paid run.
 */
export const USD_EPSILON = 1e-12;

/**
 * ⭐ THE FLEET STOPS LIVE HERE, NOT IN `fleet-budget.mjs`, TO KILL A CYCLE.
 *
 * `fleet-budget.mjs` already imports `formatUsd` and `USD_EPSILON` from this
 * file. Declaring the reason strings there and importing them back would make
 * the two modules import each other, and a circular ESM import of a `const` is
 * a live binding that is briefly `undefined` — a fault that shows up as an
 * empty reason string, not as an error. One direction only: fleet imports
 * budget, never the reverse.
 *
 * ⚠️ AND THEY ARE SPREAD INTO `BUDGET_REASONS` RATHER THAN RETYPED THERE.
 * `escalate.mjs` builds its own stop list as `BUDGET_REASONS` minus the two
 * that are not stops, so a fleet stop is automatically routed as the budget
 * stop it is. Retyping the strings in a second place is exactly how three of
 * four stop-reasons once ended up naming constants that did not exist, with
 * every test green.
 */
export const FLEET_STOP_REASONS = ['fleet-limit-reached', 'fleet-would-exceed'];

/** Every verdict `canContinue()` can return, so a caller can switch on it. */
export const BUDGET_REASONS = ['ok', 'no-budget-set', 'too-small', 'would-exceed', 'limit-reached', ...FLEET_STOP_REASONS];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Money, printed so it never lies.
 *
 * ⚠️ FOUR DECIMALS IS NOT ENOUGH HERE. A round costs $0.000231; at four
 * decimals it prints as `$0.0002`, and at a tenth of that it prints as
 * `$0.0000` — a confident zero for money that was really spent. So the
 * precision grows until at least two significant digits survive, and an amount
 * too small even for that is printed as `<$0.00000001` rather than as nothing.
 */
export function formatUsd(v) {
  if (!isNum(v)) return '$?';
  if (v === 0) return '$0.0000';
  const a = Math.abs(v);
  const digits = a >= 0.0001 ? 4 : Math.min(8, Math.max(4, Math.ceil(-Math.log10(a)) + 1));
  const text = a.toFixed(digits);
  if (Number(text) === 0) return '<$0.00000001';
  return `${v < 0 ? '-' : ''}$${text}`;
}

/**
 * Reads what a human types after `--budget`.
 *
 * Lives here rather than in `cli-args.mjs` so the flag and the governor cannot
 * drift apart, and so wiring is an import instead of a parser.
 */
export function parseBudgetUsd(raw) {
  const help = 'a budget must be a dollar amount — try --budget 0.50 or --budget 25c';
  if (typeof raw !== 'string') return { ok: false, message: help };
  const s = raw.trim().toLowerCase().replace(/[,_\s]/g, '');
  const m = /^\$?(\d+(?:\.\d+)?|\.\d+)(c|¢|usd)?$/.exec(s);
  if (!m) return { ok: false, message: `${help} (could not read "${raw}")` };
  let usd = Number(m[1]);
  if (m[2] === 'c' || m[2] === '¢') usd /= 100;
  if (!isNum(usd) || usd <= 0) return { ok: false, message: `${help} — a budget of $0 can never start a round` };
  return { ok: true, usd };
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ THE HALF OF THE BILL THE GOVERNOR COULD NOT SEE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ── ⚠️⚠️ EVERY GPU DOLLAR WAS INVISIBLE, AND THREE FEATURES PRICED OFF IT ────
 *
 * MEASURED 2026-08-14, before this block existed:
 *
 *     for f in imagegen media vision; do grep -n costUsd lib/$f.mjs; done
 *       imagegen.mjs → (no output)
 *       media.mjs    → (no output)
 *       vision.mjs   → 261 only
 *     grep -n "budget.record" lib/tools.mjs
 *       → 1275, 1276, 1277 (delegate) and 1482 (read_image). Both MODEL calls.
 *
 * So `generate_image`, `see_page`, `speak`, `transcribe`, `make_document`,
 * `read_document` and `read_table` each spun a metered Modal container and
 * charged the ledger NOTHING. Three of the four things this package is sold on
 * — the pre-run ceiling (`--budget`), the fleet ceiling (`--fleet-budget`) and
 * `acuvo spend` — all read one number, and that number was model tokens only.
 *
 * ⭐ THE FIX IS ONE BOOK, NOT A SECOND ONE. A charge recorded here is drained
 * into whichever `createBudget` instance next asks a question, so it counts
 * against the SAME ceiling as a model round and lands in the SAME audit record.
 * A second ledger with its own cap would have reproduced the exact defect it
 * was written to close, one level along.
 *
 * ── ⚠️⚠️ AND EVERY DOLLAR IN IT IS AN ESTIMATE. IT MUST SAY SO. ─────────────
 *
 * Modal does not bill us back per request. There is no invoice line to read, so
 * a GPU cost here is WALL-CLOCK SECONDS WE TIMED × A PUBLISHED PRICE, and that
 * is a different kind of fact from `usage.cost` off a completion. Replacing a
 * known-incomplete number with a confidently-wrong one is worse than the leak,
 * so `estimated` is true for every entry, `basis` says how it was derived, and
 * `report()` / the audit record / `acuvo spend` all repeat it out loud.
 *
 * ── ⚠️ MODULE-LEVEL STATE, IN A FILE WHOSE HEADER SAYS "PURE" ────────────────
 * That header is about NETWORK, MODEL, FS and AMBIENT TIME, and all four still
 * hold. This is a process-wide sink, and it is here because it had to be: the
 * dispatcher hands `budget` to exactly two call sites (`tools.mjs:1275`, `:1482`)
 * and neither is a GPU verb, so a GPU verb has no handle on the run's governor
 * to charge. `resetSpendMeter()` is the seam that keeps it out of other tests.
 */
const meter = {
  /** @type {Array<{kind: string, verb: string, usd: number, seconds: number, billedSeconds: number, basis: string, at: number}>} */
  charges: [],
  /** How many charges a budget instance has already taken. See `drainCharges`. */
  claimed: 0,
  /** Endpoints already paid a cold start this process — see COLD_START_SECONDS. */
  warm: new Set(),
};

/**
 * ── ⭐ THE PRICE TABLE, AND THE ARITHMETIC THAT ANCHORS IT ───────────────────
 *
 * `$0.000306/s` is Modal's A10G at $1.10/hour. It is not a guess: it is the
 * number that reproduces the one real measurement we have.
 *
 * ⚠️ THE CODEBASE QUOTED $0.003 AN IMAGE IN THREE PLACES AND IT WAS WRONG BY
 * 13x. $0.003 is 10 warm render-seconds and nothing else — it silently assumed
 * the container was already up and would never scale down. A cold, isolated
 * render actually bills ~130 seconds:
 *
 *     60s  container boot + 4.5GB of weights pulled     (billed)
 *     10s  the render itself                            (measured: 8.8–10.5s warm)
 *     60s  Modal's default scaledown window after the
 *          last request, before the container dies      (billed)
 *     ───
 *     130s × $0.000306/s  =  $0.0398        ← the true cost of one image
 *
 * ⭐ WHICH IS WHY THE COLD START IS CHARGED ONCE PER ENDPOINT PER PROCESS. The
 * second image in the same run really is ~$0.003, because the boot and the
 * scaledown tail are already bought. Charging every call at $0.0398 would be a
 * check that fails correct work — this repo's most expensive recurring mistake.
 */
export const USD_PER_SECOND = Object.freeze({
  /** A10G. MEASURED anchor — see the arithmetic above. */
  gpu: 0.000306,
  /**
   * A small Modal CPU container: 2 cores × $0.0000131/core-s + 4 GiB ×
   * $0.00000222/GiB-s. ⚠️ THE CONTAINER SHAPE IS AN ASSUMPTION, not a
   * measurement — a Playwright box may well be bigger. It is ~9x cheaper than
   * the GPU rate, so mis-classing a service the wrong way matters, which is why
   * `SERVICE_CLASS` below marks which entries are measured and which are read
   * off what the service obviously does.
   */
  cpu: 0.0000351,
});

/** Billed before the first request of the process lands. */
export const COLD_START_SECONDS = Object.freeze({ gpu: 60, cpu: 20 });

/** Modal keeps a container alive after the last request, and bills for it. */
export const SCALEDOWN_WINDOW_SECONDS = 60;

/**
 * Which class of machine each verb runs on.
 *
 * ⭐ `measured` MEANS WE HAVE RUN IT AND TIMED IT. Everything else is read off
 * what the service does (a Playwright screenshot is not GPU work) and is an
 * assumption that someone with an invoice should correct.
 *
 * ⚠️ `edit_image` AND `expand_image` ARE DELIBERATELY ABSENT. They live in
 * `lib/image-edit.mjs`, which this change does not touch, so they are still
 * uncharged. Listing them here would make the table claim a coverage the wiring
 * does not have — the "built but unreached" defect this package has shipped
 * repeatedly. They are the remaining work, named rather than papered over.
 */
export const SERVICE_CLASS = Object.freeze({
  generate_image: { class: 'gpu', why: 'measured: SSD-1B on an A10G, 8.8–10.5s warm' },
  speak: { class: 'gpu', why: 'assumed: Kokoro TTS on the shared GPU image' },
  transcribe: { class: 'gpu', why: 'assumed: faster-whisper on the shared GPU image' },
  read_document: { class: 'gpu', why: 'assumed: OCR falls back to a GPU container' },
  read_table: { class: 'gpu', why: 'assumed: Table Transformer is a GPU model' },
  see_page: { class: 'cpu', why: 'assumed: a headless-browser render is CPU work' },
  make_document: { class: 'cpu', why: 'assumed: HTML→PDF is a headless-browser job' },
  read_image: { class: 'model', why: 'a vision completion, not a container — priced per token' },
});

/** The class used when a verb is not in the table. GPU: expensive-side default. */
const UNKNOWN_CLASS = 'gpu';

/**
 * What one call costs, given how long it actually took.
 *
 * @param {object} args
 * @param {string} args.verb            the tool the user sees, e.g. 'see_page'
 * @param {number} args.seconds         MEASURED wall time of the request
 * @param {boolean} [args.cold]         is this the first call to the endpoint?
 * @returns {{usd: number, billedSeconds: number, class: string, basis: string}}
 */
export function priceGpuCall({ verb, seconds, cold = true }) {
  const entry = SERVICE_CLASS[verb];
  const klass = entry?.class && entry.class !== 'model' ? entry.class : UNKNOWN_CLASS;
  const rate = USD_PER_SECOND[klass] ?? USD_PER_SECOND.gpu;
  const wall = isNum(seconds) && seconds > 0 ? seconds : 0;
  const overhead = cold ? (COLD_START_SECONDS[klass] ?? 0) + SCALEDOWN_WINDOW_SECONDS : 0;
  const billedSeconds = wall + overhead;
  return {
    usd: billedSeconds * rate,
    billedSeconds,
    class: klass,
    /**
     * ⚠️ THE STRING A HUMAN WILL READ WHEN THEY QUERY THE NUMBER. It has to
     * carry both halves: the seconds are real, the dollars are a price table.
     */
    basis: cold
      ? `${wall.toFixed(1)}s measured + ${overhead}s cold start & scaledown, at the published ${klass} rate`
      : `${wall.toFixed(1)}s measured on a warm container, at the published ${klass} rate`,
  };
}

/**
 * Charge one GPU call to the ledger. Returns the entry, or null when nothing
 * was charged.
 *
 * ⚠️ NOTHING IS RECORDED FOR A FREE PROVIDER. Pollinations and Perchance are
 * somebody else's machines and cost us $0.00, and writing a zero-dollar entry
 * would make a run that spent no money of ours grow a "GPU spend" section in
 * its audit record and its summary. `test/gpu-spend-is-metered.test.mjs` pins
 * that a no-GPU run reports byte-for-byte what it reported before this change.
 *
 * @param {{verb: string, seconds: number, endpoint?: string, free?: boolean}} args
 */
export function chargeGpu({ verb, seconds, endpoint = verb, free = false }) {
  if (free) return null;
  const cold = !meter.warm.has(endpoint);
  meter.warm.add(endpoint);
  const priced = priceGpuCall({ verb, seconds, cold });
  if (!(priced.usd > 0)) return null;
  /**
   * ⚠️ NO TIMESTAMP ON THE ENTRY, AND THAT IS THE TEST'S DOING. The first draft
   * carried an `at` field stamped from the wall clock, and
   * `budget.test.mjs:434` failed it outright — *"the wall clock must never be
   * CALLED inside the logic"*. ⚠️ That test greps this file for the call, so
   * the call cannot even be WRITTEN in a comment here. The guard is right and
   * worth more than the field: this file's determinism is why the whole
   * governor is provable for $0.00. The audit record already stamps the run,
   * and the ORDER of these entries is the only sequencing anything reads.
   */
  const entry = {
    kind: 'gpu',
    verb,
    usd: priced.usd,
    seconds: isNum(seconds) && seconds > 0 ? seconds : 0,
    billedSeconds: priced.billedSeconds,
    basis: priced.basis,
  };
  meter.charges.push(entry);
  return { ...entry };
}

/**
 * ⭐ THE SAME BOOK FOR THE OTHER "UNKNOWN PRICED AS FREE" CASE.
 *
 * `read_image` returns `costUsd` and `tools.mjs:1481` charges it only when it
 * is `> 0`. OpenRouter does not always report a cost — and when it does not,
 * `vision.mjs` returned `costUsd: null`, the guard skipped, and a paid vision
 * call was free to the governor. Same defect, different provider. It goes in
 * the same ledger, tagged as an estimate, rather than being smuggled into
 * `costUsd` where it would masquerade as a reported figure.
 */
export function chargeEstimate({ kind, verb, usd, basis }) {
  if (!isNum(usd) || usd <= 0) return null;
  const entry = { kind: String(kind || 'estimate'), verb: String(verb || 'unknown'), usd, seconds: 0, billedSeconds: 0, basis: String(basis || 'estimated') };
  meter.charges.push(entry);
  return { ...entry };
}

/** Everything charged this process. A copy — the ledger is not editable outside. */
export function gpuSpend() {
  const calls = meter.charges.map((c) => ({ ...c }));
  return {
    usd: calls.reduce((n, c) => n + c.usd, 0),
    calls,
    /** ⚠️ ALWAYS TRUE WHEN THERE IS ANYTHING HERE. Nothing in this book is billed. */
    estimated: calls.length > 0,
  };
}

/**
 * Hand every unclaimed charge to the caller, exactly once.
 *
 * ⭐ CLAIMED, NOT READ. `--parallel` and `--best-of` run several sessions in ONE
 * process, so a shared running total would be counted N times over — an
 * over-charge is still a wrong number, and it would stop correct work. Handing
 * each charge to exactly one governor keeps the sum across every instance equal
 * to the ledger, which is the property that makes "one book" true.
 */
function drainCharges() {
  const out = meter.charges.slice(meter.claimed);
  meter.claimed = meter.charges.length;
  return out;
}

/** Test seam. The process-wide ledger must not leak between test files. */
export function resetSpendMeter() {
  meter.charges.length = 0;
  meter.claimed = 0;
  meter.warm.clear();
}

function requirePositive(name, value) {
  if (!isNum(value) || value <= 0) {
    throw new RangeError(`budget: ${name} must be a number greater than 0 (got ${JSON.stringify(value)})`);
  }
}

/**
 * @typedef {{ round: number, costUsd: number, tokens: number, source: 'reported'|'tokens'|'projected', estimated: boolean, at: number }} BudgetRound
 * @typedef {{ usd: number, raw: number, basis: 'seed'|'last'|'trend'|'peak', window: number, slope: number, peak: number, safetyFactor: number }} Projection
 * @typedef {{ ok: boolean, reason: string, message: string, spentUsd: number, remainingUsd: number, projectedUsd: number, estimated: boolean, rounds: number, limitUsd: number|null, reserveUsd: number, elapsedMs: number }} Verdict
 */

/**
 * @param {object} [options]
 * @param {number|null} [options.limitUsd]  hard ceiling. Omit/null = no ceiling.
 * @param {number} [options.reserveUsd]     held back from the ceiling as headroom.
 * @param {number} [options.firstRoundUsd]  the seed, before any round is observed.
 * @param {number} [options.usdPerMillionTokens] price for cost-less rounds.
 * @param {number} [options.trendWindow]    rounds the trend is drawn through.
 * @param {number} [options.safetyFactor]   margin on every projection (>= 1).
 * @param {() => number} [options.clock]    injected. Nothing here reads the wall.
 */
export function createBudget({
  limitUsd = null,
  /**
   * ⚠️ TRUE WHEN THE USER NEVER TYPED `--budget`. It changes nothing about
   * enforcement and everything about the sentence: stopping on a number someone
   * chose is a result; stopping on a number they have never seen is a mystery
   * unless the message admits where it came from and how to raise it.
   */
  limitIsDefault = false,
  /**
   * ⚠️ WHERE THE CEILING CAME FROM, because it decides what advice is TRUE.
   * `'policy'` means `.acuvo/policy.json` set it, and `--budget` cannot raise it
   * — `costBudget` takes the minimum of the two, so telling the user to raise it
   * would be a remedy guaranteed to fail. Null keeps the previous wording
   * exactly, so every existing caller is unchanged.
   *
   * ⚠️ This was referenced by `budgetWayOut` below before it was declared here —
   * ESM is strict, so that is a ReferenceError the first time a refusal fires,
   * on the path a user only reaches when they are ALREADY having a bad time.
   * `node --check` passes it happily; only running the branch finds it.
   */
  limitSource = null,
  /**
   * ── ⭐ THE FLEET GATE — ONE SEAM, NOT FOUR CALL SITES ──────────────────────
   *
   * `canContinue()` is consulted from four places (`turn.mjs` ×3,
   * `escalate.mjs` ×1). Adding a parallel fleet check beside each one is how a
   * capability ends up built and only partly connected — the single most common
   * defect in this package's history. Composing it HERE means every existing
   * caller gains the fleet ceiling without being touched, and a future fifth
   * caller cannot forget it.
   *
   * A function, not a number, because the fleet's spend changes underneath a
   * long run: six other terminals finish work while this one is thinking, and a
   * value captured at construction would be stale by the second round.
   *
   * ⚠️ Called with the projection for the round being considered, and this
   * run's own spend so far — which the shared ledger cannot know, because this
   * run does not write its audit record until it ends.
   *
   * @type {null | ((args: {projectedUsd: number, thisRunUsd: number}) => {ok: boolean, reason: string, message: string})}
   */
  fleetGate = null,
  reserveUsd = 0,
  firstRoundUsd = DEFAULT_FIRST_ROUND_USD,
  usdPerMillionTokens = DEFAULT_USD_PER_MILLION_TOKENS,
  trendWindow = DEFAULT_TREND_WINDOW,
  safetyFactor = DEFAULT_SAFETY_FACTOR,
  clock = Date.now,
} = {}) {
  /**
   * ⚠️ MALFORMED INPUT THROWS, AND IT THROWS HERE. `--budget banana` is a typo
   * in a command that is about to spend money; the only safe moment to notice
   * is before the first request. Contrast with 'too-small' below, which is a
   * legitimate budget that simply cannot buy anything — that is a verdict, not
   * a crash, because the user did nothing wrong except be optimistic.
   */
  const unlimited = limitUsd === null || limitUsd === undefined;
  if (!unlimited) requirePositive('limitUsd', limitUsd);
  if (!isNum(reserveUsd) || reserveUsd < 0) {
    throw new RangeError(`budget: reserveUsd must be a number >= 0 (got ${JSON.stringify(reserveUsd)})`);
  }
  if (!unlimited && reserveUsd >= limitUsd) {
    throw new RangeError(`budget: reserveUsd (${reserveUsd}) must be less than limitUsd (${limitUsd}) — otherwise nothing can ever run`);
  }
  requirePositive('firstRoundUsd', firstRoundUsd);
  requirePositive('usdPerMillionTokens', usdPerMillionTokens);
  if (!isNum(trendWindow) || !Number.isInteger(trendWindow) || trendWindow < 1) {
    throw new RangeError(`budget: trendWindow must be an integer >= 1 (got ${JSON.stringify(trendWindow)})`);
  }
  if (!isNum(safetyFactor) || safetyFactor < 1) {
    throw new RangeError(`budget: safetyFactor must be a number >= 1 (got ${JSON.stringify(safetyFactor)})`);
  }
  if (typeof clock !== 'function') {
    throw new RangeError('budget: clock must be a function returning milliseconds');
  }

  const effectiveLimit = unlimited ? Infinity : limitUsd - reserveUsd;
  const startedAt = clock();

  /** @type {BudgetRound[]} */
  const rounds = [];
  let spentUsd = 0;
  let totalTokens = 0;
  let estimatedRounds = 0;

  /**
   * ── ⭐⭐ GPU DOLLARS COUNT AGAINST THE CEILING, AND NOT AGAINST THE TREND ───
   *
   * They are held in their own accumulator rather than pushed into `rounds`,
   * and that separation is load-bearing in both directions:
   *
   *   · `spentUsd + gpuUsd` is what every ceiling comparison uses, so one image
   *     render is a real dollar against `--budget` for the first time.
   *   · `projectNext()` still reads ONLY `rounds`, so the projection keeps
   *     meaning "what the next MODEL round will cost". Feeding a $0.0398 render
   *     into a three-round trend would project the next round at four cents and
   *     stop a run that could comfortably afford to finish — a guard that fails
   *     correct work, which is worse than the leak it closes.
   */
  let gpuUsd = 0;
  let gpuCalls = 0;

  /**
   * ⚠️ CALLED AT THE TOP OF EVERY PUBLIC METHOD, INCLUDING THE READ-ONLY ONES.
   * A GPU verb called on the last round of a session would otherwise never be
   * claimed by anyone — `canContinue()` is not asked again — and would vanish
   * from the summary and the audit record. `report()`, `stats()` and `toJSON()`
   * all run at the end of a run, so draining there is what makes the last call
   * of a session countable.
   */
  function syncGpu() {
    for (const c of drainCharges()) {
      gpuUsd += c.usd;
      gpuCalls += 1;
    }
  }

  /** The one number: model rounds plus estimated GPU time. */
  const totalSpent = () => spentUsd + gpuUsd;

  /**
   * ⭐ THE HONESTY CLAUSE, AND IT IS EMPTY WHEN THERE IS NOTHING TO SAY.
   *
   * ⚠️ RETURNING `''` ON A ZERO-GPU RUN IS A REQUIREMENT, NOT A TIDINESS
   * CHOICE. Every stop message, summary line and audit record on a run that
   * never touched a GPU has to come out byte-for-byte as it did before this
   * change, or "we added GPU metering" silently becomes "we changed the output
   * of every run in the product". `test/gpu-spend-is-metered.test.mjs` pins it.
   */
  function gpuClause() {
    if (!(gpuUsd > 0)) return '';
    return ` (${formatUsd(gpuUsd)} of that is ESTIMATED GPU time across ${gpuCalls} call${gpuCalls === 1 ? '' : 's'}, priced from a table rather than billed)`;
  }

  /** @returns {Projection} */
  function projectNext() {
    if (rounds.length === 0) {
      return { usd: firstRoundUsd * safetyFactor, raw: firstRoundUsd, basis: 'seed', window: 0, slope: 0, peak: 0, safetyFactor };
    }
    const window = rounds.slice(-trendWindow);
    const costs = window.map((r) => r.costUsd);
    const first = costs[0];
    const last = costs[costs.length - 1];
    const peak = Math.max(...costs);
    const slope = costs.length >= 2 ? (last - first) / (costs.length - 1) : 0;
    // No `Math.max(0, slope)` here — see the header. A negative slope always
    // implies `peak > trend`, so the peak clamp on the next line is the only
    // thing that has ever enforced "never project downward".
    const trend = last + slope;
    const raw = Math.max(trend, peak);
    const basis = costs.length < 2 ? 'last' : (raw > trend ? 'peak' : 'trend');
    return { usd: raw * safetyFactor, raw, basis, window: costs.length, slope, peak, safetyFactor };
  }

  /**
   * Accepts either this module's own shape (`{ costUsd, tokens }`) or the
   * OpenRouter usage object turn.mjs already has (`{ cost, total_tokens }`),
   * so the wiring is `budget.record(reply.usage)` and nothing else.
   */
  function record(entry) {
    syncGpu();
    const e = entry && typeof entry === 'object' ? entry : {};
    const rawCost = isNum(e.costUsd) ? e.costUsd : e.cost;
    const rawTokens = isNum(e.tokens) ? e.tokens : e.total_tokens;
    const tokens = isNum(rawTokens) && rawTokens >= 0 ? rawTokens : 0;

    let costUsd;
    /** @type {'reported'|'tokens'|'projected'} */
    let source;
    if (isNum(rawCost) && rawCost >= 0) {
      costUsd = rawCost;
      source = 'reported';
    } else if (tokens > 0) {
      /**
       * ── ⭐⭐⭐ PRICE THE MIX, NOT A BLEND ─────────────────────────────────
       *
       * A flat `$/M` cannot be right for two rounds with different shapes, and
       * that is exactly why two honest measurements of this model appeared to
       * disagree by 2x. Reconciled 2026-08-21 against real rates
       * (input $0.14/M · output $0.28/M · cached input ~10% of input):
       *
       *   1,036 tok, cold, output-heavy  -> $0.231/M   (this file measured 0.223 ✓)
       *   a build round, prompt-heavy    -> $0.154/M
       *   the same round at 80% cache    -> $0.063/M   (the console's blend ✓)
       *
       * ⭐ SAME RATES, DIFFERENT MIXES. Neither measurement was wrong; the
       * constant was, because one number cannot describe both. So when the
       * usage object tells us the split — and DeepSeek always does, even when
       * it reports no cost — price it properly and stop guessing.
       *
       * ⚠️ FALLS BACK, NEVER THROWS. A usage object without the split is priced
       * exactly as before, so this can only ever be more accurate than the
       * constant, never less.
       */
      const priced = priceFromSplit(e);
      if (priced !== null) {
        costUsd = priced;
        source = 'tokens';
      } else {
        costUsd = (tokens / 1e6) * usdPerMillionTokens;
        source = 'tokens';
      }
    } else {
      // Nothing to go on. Charge what we were about to bet this round would
      // cost — the one option that is neither free nor invented.
      costUsd = projectNext().raw;
      source = 'projected';
    }

    const rec = {
      round: rounds.length + 1,
      costUsd,
      tokens,
      source,
      estimated: source !== 'reported',
      at: clock(),
    };
    rounds.push(rec);
    spentUsd += costUsd;
    totalTokens += tokens;
    if (rec.estimated) estimatedRounds += 1;
    return { ...rec };
  }

  /** @returns {Verdict} */
  function canContinue() {
    syncGpu();
    const projection = projectNext();
    const elapsedMs = clock() - startedAt;
    const base = {
      /**
       * ⚠️ THIS IS NOW THE TOTAL, NOT THE MODEL TOTAL. Every caller that reads
       * `spentUsd` — `escalate.mjs`, the fleet gate below, the stop messages —
       * is asking "how much has this run cost", and answering with the model
       * half was the whole defect. The split is available under `modelUsd` /
       * `gpuUsd` for anyone who needs it.
       */
      spentUsd: totalSpent(),
      modelUsd: spentUsd,
      gpuUsd,
      gpuCalls,
      projectedUsd: projection.usd,
      /**
       * ⭐ GPU SPEND MAKES THE TOTAL AN ESTIMATE, FULL STOP. There is no
       * invoice behind it, so a run that rendered an image can never report an
       * exact figure, however well the provider reported its tokens.
       */
      estimated: estimatedRounds > 0 || gpuCalls > 0,
      rounds: rounds.length,
      limitUsd: unlimited ? null : limitUsd,
      reserveUsd,
      elapsedMs,
    };

    /**
     * ── ⭐ THE FLEET IS ASKED FIRST, AND IT CAN ONLY EVER REFUSE ─────────────
     *
     * Two properties, both deliberate:
     *
     * 1. **It runs BEFORE the `unlimited` branch.** A terminal started with
     *    `--budget none` has no per-run ceiling at all, which is exactly the
     *    worker that can drain a fleet ceiling on its own. Checking after the
     *    unlimited early-return would have left the one case that most needs
     *    the fleet gate as the one case it never sees.
     *
     * 2. **It never turns a refusal into an allow.** The only outcome consulted
     *    here is `ok === false`; a happy fleet falls through to the per-run
     *    logic completely unchanged. So every existing behaviour is preserved
     *    exactly, and the new layer is a no-op for anyone who has not asked for
     *    it — which is the bar for adding anything to a path that spends money.
     *
     * ⚠️ Precedence is fleet-first ON PURPOSE. When both ceilings are spent,
     * "raise --budget" is the wrong advice: the per-run ceiling is not what is
     * stopping you and lifting it changes nothing. The binding constraint has
     * to be the one that gets named.
     *
     * ⚠️ `remainingUsd` becomes the FLEET's remaining here, because
     * `escalate.mjs` sizes its next rung from that number. Handing it the
     * per-run figure while the fleet is empty would have it buy a rung the
     * fleet cannot pay for.
     */
    if (fleetGate) {
      // ⭐ The fleet is told the TOTAL. A workspace ceiling that priced only
      // model tokens was the same hole one level up — seven terminals each
      // rendering images could not cross a fleet cap they were not charged to.
      const fleet = fleetGate({ projectedUsd: projection.usd, thisRunUsd: totalSpent() });
      if (fleet && fleet.ok === false) {
        return {
          ok: false,
          reason: fleet.reason,
          message: fleet.message,
          remainingUsd: Math.max(0, fleet.fleetRemainingUsd ?? 0),
          fleetSpentUsd: fleet.fleetSpentUsd,
          ...base,
        };
      }
    }

    if (unlimited) {
      return {
        ok: true,
        reason: 'no-budget-set',
        message: `no budget limit set — ${formatUsd(totalSpent())} spent so far`,
        remainingUsd: Infinity,
        ...base,
      };
    }

    const remainingUsd = effectiveLimit - totalSpent();

    /**
     * ⭐ A REFUSAL THAT DOES NOT SAY WHAT TO TYPE IS JUST AN OBSTACLE. That rule
     * is why this package's refusals are its best-written part, and it applies
     * hardest here — because the ceiling is now ON BY DEFAULT, so the first
     * person to meet it will not have chosen the number.
     */
    const wayOut = budgetWayOut({ limitUsd, limitIsDefault, limitSource });

    if (remainingUsd <= USD_EPSILON) {
      return {
        ok: false,
        reason: 'limit-reached',
        message: `budget spent: ${formatUsd(totalSpent())} of ${formatUsd(limitUsd)} after ${rounds.length} round${rounds.length === 1 ? '' : 's'}${gpuClause()}.${wayOut}`,
        remainingUsd: Math.max(0, remainingUsd),
        ...base,
      };
    }

    if (totalSpent() + projection.usd > effectiveLimit + USD_EPSILON) {
      /**
       * ⚠️ `rounds.length === 0` STILL MEANS "NOTHING WAS STARTED", and a GPU
       * charge with no rounds behind it cannot happen — a tool call only exists
       * inside a round. Left as it was rather than switched to a total-spend
       * test, because 'too-small' is the preflight verdict and preflight runs
       * before anything has been charged at all.
       */
      const tooSmall = rounds.length === 0;
      return {
        ok: false,
        reason: tooSmall ? 'too-small' : 'would-exceed',
        message: tooSmall
          ? `budget of ${formatUsd(limitUsd)} cannot cover even one round (projected ~${formatUsd(projection.usd)}). Nothing was started — raise it or drop the flag.`
          : `stopping on budget after ${rounds.length} round${rounds.length === 1 ? '' : 's'}: ${formatUsd(totalSpent())} of ${formatUsd(limitUsd)} spent${gpuClause()} and the next round is projected at ~${formatUsd(projection.usd)}, which would cross the line.${wayOut}`,
        remainingUsd,
        ...base,
      };
    }

    return {
      ok: true,
      reason: 'ok',
      message: `${formatUsd(remainingUsd)} of budget left, next round projected at ~${formatUsd(projection.usd)}`,
      remainingUsd,
      ...base,
    };
  }

  /**
   * ⭐ THE FORECAST, ASKED WITH THE STATE THIS CLOSURE ALREADY HOLDS.
   *
   * ⚠️ IT DRAINS THE GPU METER FIRST, like every other public method here. A run
   * that rendered an image in round 1 has spent four cents; forecasting from the
   * model half alone would produce a confident "this fits" about a run that is
   * already twice over its ceiling — the same "unknown priced as free" failure
   * this file exists to refuse, one level along.
   *
   * ⚠️ AND IT IS A READ. Nothing here records, stops, or changes a verdict; the
   * only thing that stops a run is still `canContinue()`.
   */
  function forecast(maxRounds) {
    syncGpu();
    return forecastRun({
      remainingUsd: unlimited ? Infinity : effectiveLimit - totalSpent(),
      projectedUsd: projectNext().usd,
      limitUsd: unlimited ? null : limitUsd,
      spentUsd: totalSpent(),
      roundsUsed: rounds.length,
      maxRounds: Number.isFinite(maxRounds) ? maxRounds : 0,
      limitIsDefault,
      limitSource,
    });
  }

  function stats() {
    syncGpu();
    return {
      rounds: rounds.length,
      spentUsd: totalSpent(),
      modelUsd: spentUsd,
      gpuUsd,
      gpuCalls,
      totalTokens,
      estimated: estimatedRounds > 0 || gpuCalls > 0,
      estimatedRounds,
      limitUsd: unlimited ? null : limitUsd,
      reserveUsd,
      remainingUsd: unlimited ? Infinity : effectiveLimit - totalSpent(),
      projectedUsd: projectNext().usd,
      startedAt,
      elapsedMs: clock() - startedAt,
    };
  }

  /**
   * One line, and it must be true. `~` marks the projection; the estimate
   * clause appears only when a round really did come back without a price.
   */
  function report() {
    syncGpu();
    const n = rounds.length;
    const roundWord = `${n} round${n === 1 ? '' : 's'}`;
    /**
     * ⭐ THE GPU CLAUSE COMES FIRST BECAUSE IT IS THE BIGGER SURPRISE. A run
     * that spent $0.0002 on tokens and $0.0398 on one image render is 99% GPU,
     * and a summary that mentions only rounds is describing the 1%.
     */
    const gpu = gpuUsd > 0
      ? ` · ⚠ ${formatUsd(gpuUsd)} of that is GPU time on ${gpuCalls} call${gpuCalls === 1 ? '' : 's'}, ESTIMATED from a price table (we are not billed per call)`
      : '';
    const tail = estimatedRounds > 0
      ? ` · ⚠ ${estimatedRounds} of ${n} rounds reported no cost, so the total is an estimate`
      : '';
    if (unlimited) {
      return `budget: ${formatUsd(totalSpent())} spent · ${roundWord} · no limit set${gpu}${tail}`;
    }
    const projected = projectNext().usd;
    const remaining = Math.max(0, effectiveLimit - totalSpent());
    return `budget: ${formatUsd(totalSpent())} of ${formatUsd(limitUsd)} spent · ${roundWord} · next ~${formatUsd(projected)} · ${formatUsd(remaining)} left${gpu}${tail}`;
  }

  function toJSON() {
    const s = stats();
    return {
      limitUsd: s.limitUsd,
      reserveUsd: s.reserveUsd,
      spentUsd: s.spentUsd,
      remainingUsd: s.remainingUsd,
      projectedUsd: s.projectedUsd,
      totalTokens: s.totalTokens,
      rounds: s.rounds,
      /**
       * ⚠️ CONDITIONAL, AND IN THE MIDDLE OF THE OBJECT ON PURPOSE — the two
       * GPU keys sit next to the number they explain, and are absent entirely
       * when there is no GPU spend, so `--json` on an ordinary run is unchanged
       * byte for byte. A consumer's schema does not move because we added a
       * capability it never used.
       */
      ...(s.gpuUsd > 0 ? { gpuUsd: s.gpuUsd, gpuCalls: s.gpuCalls } : {}),
      estimated: s.estimated,
      estimatedRounds: s.estimatedRounds,
      elapsedMs: s.elapsedMs,
    };
  }

  /** A copy. The ledger is not editable from outside. */
  const history = () => rounds.map((r) => ({ ...r }));

  /**
   * ⭐ `fleetGate` is exposed so a DELEGATED helper can inherit it. Without
   * that, seven terminals could each delegate their way around the
   * workspace-wide ceiling — the parent obeys the fleet cap and the child it
   * spawns never hears about it.
   */
  return { record, projectNext, canContinue, forecast, report, stats, toJSON, history, fleetGate };
}

/**
 * ── ⭐ HOW TO WIRE THIS (the whole point of the module) ──────────────────────
 *
 * 1. THE FLAG — in `lib/cli-args.mjs`, beside `--max-rounds`:
 *
 *        import { parseBudgetUsd } from './budget.mjs';
 *        // ...
 *        case '--budget': {
 *          const parsed = parseBudgetUsd(argv[++i]);
 *          if (!parsed.ok) return { ok: false, error: parsed.message };
 *          out.budgetUsd = parsed.usd;
 *          break;
 *        }
 *
 * 2. THE GOVERNOR — in `lib/turn.mjs`, at the top:
 *
 *        import { createBudget } from './budget.mjs';
 *
 *    beside `const rounds = []` in `runSession` (add `budgetUsd` to the options
 *    destructure, defaulting to `null`):
 *
 *        const budget = createBudget({ limitUsd: budgetUsd });
 *        const preflight = budget.canContinue();
 *        if (!preflight.ok) return { ok: false, stage: 'budget', stoppedBecause: preflight.reason, message: preflight.message };
 *
 *    at the top of the `for (let round = ...)` body:
 *
 *        const affordable = budget.canContinue();
 *        if (!affordable.ok) { stoppedBecause = affordable.reason; onEvent({ type: 'budget-stop', ...affordable }); break; }
 *
 *    and immediately after each existing `rounds.push({ round, ... })`:
 *
 *        budget.record(reply.usage);
 *
 * 3. THE LINE — wherever the summary is printed, add `budget.report()`.
 *
 * ⚠️ THE PREFLIGHT CALL IS NOT OPTIONAL. Without it a budget of $0.000001 opens
 * a connection, spends a round, and then discovers it could never have afforded
 * one — the exact "start and stop having spent money for nothing" this module
 * was written to prevent. It is two lines.
 *
 * ⚠️ AND `budget.record(reply.usage)` MUST RUN ON EVERY ROUND, INCLUDING THE
 * FAILED ONES. `runSession` pushes `{ round, error, usage: null }` on a
 * transport failure; skipping those makes a provider that errors after billing
 * look free, which is precisely the "unknown priced as zero" trap. Passing the
 * null is correct and intended — the governor charges it the projection.
 *
 * ⭐ `maxRounds` DOES NOT HAVE TO DIE FOR THIS TO SHIP. The two coexist: leave
 * the counter as a very high backstop and let money be the real wall. Removing
 * the counter in the same change would make an unaffordable-budget bug and a
 * runaway-loop bug indistinguishable, and `stuck.mjs` is the module that earns
 * the right to remove it, not this one.
 */

/**
 * ── ⭐ WHAT ONE `--best-of` ATTEMPT MAY SPEND ───────────────────────────────
 *
 * Pure, and separately named so the reasoning is reviewable rather than buried
 * in a call site: this decides whether a user's stated ceiling is honoured or
 * multiplied.
 *
 * ⚠️ IT EXISTS BECAUSE BOTH FAN-OUT PATHS HAD NO CEILING AT ALL. `runSession`
 * defaults `budgetUsd = null`, and null is UNLIMITED — so `--best-of N` ran N
 * full sessions with no wall, and an explicit `--budget` was accepted without
 * complaint and silently discarded. Taking a user's instruction about money and
 * dropping it is a different and worse failure than never offering the feature.
 *
 * ⭐ AN EXPLICIT `--budget` IS A TOTAL. `--best-of 5 --budget 0.05` means "spend
 * at most five cents", never "spend up to twenty-five" — so it is divided across
 * the attempts. That is the only reading that cannot surprise someone reading an
 * invoice, and the alternative is indefensible.
 *
 * ⚠️ THE DEFAULT IS NOT DIVIDED. `DEFAULT_BUDGET_USD` is a per-run blast radius
 * that nobody chose, and splitting an unchosen number into fifths would starve
 * each attempt at four tenths of a cent — turning a safety net into a feature
 * that silently stops working at N > 2. A ceiling the user DID choose is a
 * promise; one they did not is a guard rail, and they behave differently on
 * purpose.
 *
 * @param {{ bestOf?: number, budgetUsd?: number | null, budgetExplicit?: boolean }} opts
 * @returns {number} always finite and > 0 — null would mean unlimited
 */
export function bestOfAttemptBudget(opts) {
  const n = Math.max(1, Number(opts?.bestOf) || 1);
  if (opts?.budgetExplicit === true && Number.isFinite(opts?.budgetUsd) && opts.budgetUsd > 0) {
    return opts.budgetUsd / n;
  }
  return DEFAULT_BUDGET_USD;
}
