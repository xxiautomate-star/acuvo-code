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
 * The provider usually returns `usage.cost`. Not always. `aggregateUsage` in
 * turn.mjs already handles a null usage by skipping it — correct for a summary
 * line, catastrophic for a governor: a run whose provider stops reporting cost
 * would spend `spent += 0` forever and bill the user for the privilege. That is
 * the worst available failure in this file, so unknown is NEVER zero:
 *
 *   1. a real `cost` (or `costUsd`) > 0  → believed
 *   2. no cost but a token count         → priced at `usdPerMillionTokens`
 *   3. nothing at all                    → charged the CURRENT PROJECTION
 *
 * and cases 2 and 3 mark the whole total as an ESTIMATE, which `report()` says
 * out loud with the count of blind rounds. A number the user might act on must
 * never hide that it was guessed.
 *
 * ── ⚠️⚠️⭐ AND THE FOURTH CASE, MEASURED 2026-08-29: **A REPORTED ZERO** ─────
 *
 * This block used to end *"CASE 1 INCLUDES ZERO ON PURPOSE… an explicit zero is
 * data; an absent field is not"*, and `test/spend-ceiling-stops-a-runaway.test.mjs`
 * then measured what that sentence buys: `{cost: 0, total_tokens: 2000}` for
 * twelve rounds, `$0.00` metered, **zero budget-stops**. The dollar ceiling was
 * inert and the only remaining wall was the round cap — 24 by default, 200 under
 * `--until-done`. `policy.mjs` states the sibling rule correctly (*"a provider
 * that reports no cost must not read as free"*) and it did not help, because
 * "reported AS zero" is not "not reported" and slips past a check written for
 * the other case.
 *
 * ⭐ THE SENTENCE ABOVE WAS NOT WRONG, IT WAS UNDER-SPECIFIED. Both of these are
 * real and they are not the same event:
 *
 *   · a FREE LEG — a free-tier provider, one of the three cost levers — really
 *     did cost $0.00, and charging it at card rate is a check that fails correct
 *     work, the mistake this repo has made four times in one day; and
 *   · a SILENT LEG — a proxy, a stub, a self-hosted OpenAI-compatible endpoint,
 *     or `aggregateUsage` itself, which initialises `cost = 0` and only adds to
 *     it when a round carries the field — saying "zero" because it has nothing
 *     to say.
 *
 * ⚠️ THE NUMBER `0` CANNOT TELL THEM APART, SO THE NUMBER IS NOT ASKED. What
 * separates them is CORROBORATION — did any token actually move, and does the
 * payload DECLARE the leg free (`free: true`, `tier: 'free'`, or an OpenRouter
 * `:free` model id — see `freeLegDeclaration`)?
 *
 *   4a. `cost: 0` and no tokens moved     → believed. Nothing happened; a failed
 *       call with no key reports exactly this and must never be charged.
 *   4b. `cost: 0`, tokens moved, DECLARED → believed, `source: 'free'`. Lever 3
 *       survives, and it is not an estimate: it is a stated fact.
 *   4c. `cost: 0`, tokens moved, silent   → PRICED FROM THOSE TOKENS at the rate
 *       in force, `source: 'zero-unpriced'`, flagged as an estimate, counted
 *       separately, and said out loud in `report()` and in the stop message so
 *       a genuinely-free user is told why they were charged and what to type.
 *
 * ⚠️ THE ASYMMETRY IS WHY 4c FAILS CLOSED. Being wrong that way stops a free run
 * early and costs the user nothing but the run; being wrong the other way is an
 * unbounded bill on a laptop that pays out of pocket. The narrowness is the
 * safety: only a zero WITH moved tokens AND no declaration is ever disbelieved.
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
 * ⭐ THE PRICES LIVE IN ONE PLACE NOW. `rate-card.mjs` carries the current card
 * (peak and off-peak) and nothing else in this package may hand-type a per-token
 * rate — including, deliberately, the comments in this file. Zero runtime
 * dependencies are preserved: it is a local module with no imports of its own.
 */
import { FLASH, ratesFor, blendedPerMillion } from './rate-card.mjs';

/**
 * The seed used before a single round has been observed.
 *
 * MEASURED, not guessed: `turn.mjs` records a real round at 1,036 tokens and
 * $0.000231. This sits ~2x above it, because the seed's only job is to answer
 * "can this budget afford ANYTHING" and a seed that under-estimates lets a
 * hopeless budget start. It is replaced by real data the moment round 1 lands.
 *
 * ⚡ RAISED 0.0005 → 0.001 ON 2026-09-28 when the default moved to v4.1 (owner: every plan). The
 * same 1,036-token round on v4.1's pin card (`rate-card.mjs`: $0.30 in / $1.20 out, cold) is
 * ~$0.0003-0.0005 depending on the output split, so 0.0005 had fallen to ~1x — no longer the
 * "~2x above" this seed promises. 0.001 restores it.
 */
export const DEFAULT_FIRST_ROUND_USD = 0.001;

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
   * ⚠️ A ZERO OR NEGATIVE PROJECTION CANNOT BE DIVIDED BY, and it is still
   * reachable after case 4 in the header: a DECLARED free-tier leg, and a round
   * where no tokens moved at all, are both believed at $0.00. (A silent zero
   * beside real tokens is not — it is priced, so it cannot reach here.) "Every
   * round is free" remains a legitimate state, and the honest forecast for it is
   * that the money never runs out.
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
 * ── ⚠️⚠️ IT WAS HAND-TYPED FOR MONTHS, AND WRONG IN BOTH DIRECTIONS ─────────
 *
 * It began as one COLD round, inverted to a per-million figure and rounded up,
 * on the reasoning that over-pricing an unknown stops a run slightly early while
 * under-pricing it lets a run overshoot — and only one of those shows up on a
 * bill. The reasoning is right. The constant was not.
 *
 * ⚠️ A COLD ROUND IS NOT A SESSION. Corrected 2026-08-21 against a real
 * end-to-end run: a 5-round bug-fix task reported **87,814 tokens at 80% cache**
 * and this constant priced it at roughly **8x** what it actually cost. THE HARM
 * WAS NOT COSMETIC — this governs `canContinue()`, so a user on the default
 * ceiling was stopped after about an eighth of the work they had paid for, and
 * every cost line the CLI printed overstated by the same factor. "Stops the run
 * slightly early" is true at 1.3x and a different claim at 8x.
 *
 * ⚠️⚠️ AND THEN THE UPSTREAM RESTRUCTURED ITS CARD AND THIS DID NOT MOVE FOR
 * NINE DAYS — under-braking, this time, on the one path that exists to be
 * careful. Wrong in one direction, then the other, from the same cause.
 *
 * ⭐ SO: DERIVED, NOT TYPED — `blendedPerMillion(peak, 0 cache)` from the one
 * module allowed to hold a rate. And the COLD figure, not the blended one: this
 * fires exactly when a provider goes silent, and a silent provider is also the
 * case where a session may genuinely be uncached (round 1 is ALWAYS 0% cache,
 * and a fresh session is all round ones). A hand-typed rate is a measurement
 * with an expiry date and no label saying when it was taken, which is the whole
 * reason this was wrong twice.
 */
export const DEFAULT_USD_PER_MILLION_TOKENS = blendedPerMillion(ratesFor(FLASH), 0);

/**
 * ── ⭐⭐ THE PER-MILLION RATES, BY WHAT THE TOKEN ACTUALLY IS ────────────────
 *
 * Input, output and cached input are priced differently, which is the whole
 * reason a single blended constant could not be right. A cache read is roughly a
 * THIRTIETH of a fresh input token — that ratio is why the cache rate dominates
 * the bill, and pricing a cached round at the fresh rate is what made a warm
 * session look ~8x dearer than it was.
 *
 * ── ⚠️⚠️ THESE THREE WERE HAND-TYPED AND WENT STALE ─────────────────────────
 *
 * The upstream restructured its card and nothing here moved for nine days — all
 * three were low, by different multiples each. This table feeds `priceFromSplit`,
 * which prices any round where the provider omits a cost, so a `--budget`
 * ceiling set against it did not stop where the user was told it would.
 *
 * ⚠️ Mitigating, and worth knowing before panicking: `costUsd` is provider-
 * REPORTED whenever it is available (see `record()` below, `source: 'reported'`),
 * and every surviving audit record shows `roundsUnknown: 0`. So the ledger
 * totals were honest and this path is rare — it is simply the path that fires
 * exactly when a provider goes quiet, which is the worst moment to be wrong.
 *
 * ⭐ NOW DERIVED FROM `rate-card.mjs`, THE PEAK COLUMN. Off-peak is exactly half
 * on every token type; the governor takes peak because under-braking is the only
 * one of the two errors that reaches a bill, and because five of six ledger
 * records were billed at peak — including two on a Saturday.
 *
 * ⚠️ Exported so a test can hold them and so nobody re-derives them inline.
 */
const FLASH_PEAK_RATES = ratesFor(FLASH);
export const RATE_USD_PER_MILLION = Object.freeze({
  input: FLASH_PEAK_RATES.inPerM,
  output: FLASH_PEAK_RATES.outPerM,
  cachedInput: FLASH_PEAK_RATES.cachedInPerM,
});

/**
 * Price one round from the token SPLIT, or null when the usage object does not
 * carry one.
 *
 * ⚠️ ACCEPTS BOTH VOCABULARIES. The aggregator says `prompt_tokens` /
 * `completion_tokens` and nests the cache read under
 * `prompt_tokens_details.cached_tokens`; an upstream's own API says
 * `prompt_cache_hit_tokens` at the top level. A reader that knows one spelling
 * silently prices the other at zero cache — which is the same ~8x error wearing
 * a different hat.
 *
 * ⚠️ AND CACHED IS CLAMPED TO PROMPT. A provider reporting more cached tokens
 * than prompt tokens would otherwise produce a NEGATIVE fresh-input term and
 * under-bill; clamping keeps the arithmetic honest against a bad payload.
 */
/**
 * ── ⭐⭐⭐ THE SPLIT, EXTRACTED — BECAUSE NOBODY COULD SEE THE CACHE RATE ────
 *
 * ⚠️⚠️ MEASURED 2026-08-29 ACROSS ALL 139 BENCH RUNS: **not one carries a cache
 * figure.** The `budget` block records `spentUsd`, `totalTokens`, `rounds` and
 * seven more fields, and nothing about caching. So Roman's first and hardest
 * MVP acceptance point — *"caching solid EVEN WHEN MODELS SWITCH"* — could not
 * be evaluated from 139 runs, because the harness never recorded the number.
 *
 * ⭐ AND THE NUMBER WAS ALREADY IN OUR HANDS. `priceFromSplit` has read
 * `cached_tokens` on every single round since it was written — it computes
 * `cached` and `fresh`, prices them at different rates, and then **returns only
 * a dollar figure and drops both.** The whole margin story rests on a quantity
 * this file calculated and threw away once a round.
 *
 * So the reader is extracted rather than duplicated. One vocabulary, one clamp,
 * one place to be wrong — this file already warns that "a reader that knows one
 * spelling silently prices the other at zero cache", and a second reader is how
 * the price and the reported cache rate would come to disagree without either
 * looking wrong.
 *
 * @returns {{prompt:number, cached:number, fresh:number, completion:number}|null}
 *   `null` when the usage object cannot be read — which is NOT zero. An
 *   unpriceable round is unknown, and the caller counts it as such.
 */
export function splitFromUsage(usage) {
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
  /**
   * ⚠️ CLAMPED TO PROMPT. A provider reporting more cached tokens than prompt
   * tokens would otherwise produce a NEGATIVE fresh-input term and under-bill —
   * and, now that the same numbers are reported, a cache rate above 100%.
   */
  const cached = Math.min(cachedRaw, prompt);
  return { prompt, cached, fresh: prompt - cached, completion };
}

/**
 * ── ⭐⭐ DID THIS LEG DECLARE ITSELF FREE? ───────────────────────────────────
 *
 * The one thing that makes a reported `$0.00` believable beside real tokens.
 * Three shapes, because three different things produce a usage object:
 *
 *   · an explicit boolean — `free` / `isFree` / `is_free` / `freeTier` /
 *     `free_tier` — which is what a caller inside this package would set;
 *   · `tier: 'free'`, the shape an aggregator uses;
 *   · a MODEL ID ending `:free`, OpenRouter's own convention and the exact
 *     string `doctor.mjs` and `model.mjs` tell a user to set when their credit
 *     runs out (*"set OPENROUTER_CODEGEN_MODEL to a `:free` model id"*). That
 *     advice is the reason this reader exists: a user who takes it must not
 *     then be billed at the DeepSeek card rate for tokens nobody charged for.
 *
 * ⚠️ A LITERAL RegExp, NOT ONE BUILT FROM A TEMPLATE STRING. `\b` inside a
 * template literal is the BACKSPACE character, matches nothing, and a guard
 * built that way goes green against text that plainly contains the word — a
 * trap this repo hit today.
 *
 * ⚠️ IT ONLY EVER SAYS "BELIEVE THE ZERO". It cannot create a charge, cannot
 * change a positive cost, and a payload that says nothing is simply undeclared.
 *
 * @returns {{ free: boolean, why: string|null }}
 */
export const FREE_LEG_FIELDS = Object.freeze(['free', 'isFree', 'is_free', 'freeTier', 'free_tier']);
export const FREE_MODEL_ID = /:free\b/i;

export function freeLegDeclaration(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  for (const k of FREE_LEG_FIELDS) {
    if (u[k] === true) return { free: true, why: `usage.${k} is true` };
  }
  if (typeof u.tier === 'string' && u.tier.trim().toLowerCase() === 'free') {
    return { free: true, why: "usage.tier is 'free'" };
  }
  const id = [u.model, u.modelId, u.model_id].find((v) => typeof v === 'string' && v.length > 0);
  if (id && FREE_MODEL_ID.test(id)) return { free: true, why: `"${id}" is a free-tier model id` };
  return { free: false, why: null };
}

/**
 * Did any token actually move on this leg?
 *
 * ⚠️ THE COROBORATION, AND IT FAILS TOWARDS "YES". A payload whose split says
 * nothing moved but whose `total_tokens` says 2,000 is inconsistent, and the
 * safe reading of an inconsistent bill is the expensive one. A leg with no
 * token evidence at all reads FALSE — a model call that failed before it left
 * the machine (`{ok: false, error: 'no OPENROUTER_API_KEY is set',
 * usage: {cost: 0}}`, which `escalate.test.mjs` pins) genuinely cost nothing,
 * and charging it would be a guard that fails correct work.
 */
export function tokensMoved(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const s = splitFromUsage(u);
  if (s && s.prompt + s.completion > 0) return true;
  const t = isNum(u.tokens) ? u.tokens : u.total_tokens;
  return isNum(t) && t > 0;
}

export function priceFromSplit(usage) {
  const s = splitFromUsage(usage);
  if (s === null) return null;
  return (s.fresh / 1e6) * RATE_USD_PER_MILLION.input
    + (s.cached / 1e6) * RATE_USD_PER_MILLION.cachedInput
    + (s.completion / 1e6) * RATE_USD_PER_MILLION.output;
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

/**
 * ── ⭐⭐ THE ACCOUNT'S ALLOWANCE IS A THIRD KIND OF STOP ─────────────────────
 *
 * Namespaced so a caller can tell it apart from a per-RUN money stop by prefix
 * alone, because the right advice is completely different: `--budget` is the
 * answer to `would-exceed` and is **no answer at all** to an exhausted monthly
 * allowance.
 *
 * ⚠️ AND THAT IS WHY THESE ARE DELIBERATELY *NOT* IN `escalate.mjs`'s
 * `OUT_OF_ROAD`. That list means "cut off, and trying again WITH MORE ROOM is
 * the correct response" — there is no more room to buy here, so escalating
 * would retry a run that must refuse again. See the note there.
 */
export const ALLOWANCE_STOP_REASONS = Object.freeze(['allowance:allowance-spent', 'allowance:would-exceed']);

/**
 * Every verdict `canContinue()` can return, so a caller can switch on it.
 *
 * ⚠️ THE ALLOWANCE REASONS BELONG HERE EVEN THOUGH ESCALATION EXCLUDES THEM.
 * This constant answers "what can this function return"; `OUT_OF_ROAD` answers
 * "which of those should be retried". Conflating the two is how a stop reason
 * ends up in no list at all — the defect `escalate.mjs` records having paid for
 * three separate times.
 */
export const BUDGET_REASONS = ['ok', 'no-budget-set', 'too-small', 'would-exceed', 'limit-reached', ...FLEET_STOP_REASONS, ...ALLOWANCE_STOP_REASONS];

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
 * The GPU rate is the published hourly price of the accelerator class we run
 * on, converted to seconds. It is not a guess: it is the number that reproduces
 * the one real measurement we have.
 *
 * ⚠️ THE ARITHMETIC THAT MATTERS IS THE BILLED WINDOW, NOT THE RATE. The
 * codebase quoted a per-image figure in three places and it was wrong by **13x**,
 * because it counted the render and nothing else — it silently assumed the
 * container was already up and would never scale down. A cold, isolated render
 * actually bills ~130 seconds:
 *
 *      60s  container boot + several GB of weights pulled  (billed)
 *      10s  the render itself             (measured: 8.8–10.5s warm)
 *      60s  the platform's default scaledown window after
 *           the last request, before the container dies    (billed)
 *     ────
 *     130s  ← 13x the render alone, which is the whole error
 *
 * ⭐ WHICH IS WHY THE COLD START IS CHARGED ONCE PER ENDPOINT PER PROCESS. The
 * second image in the same run costs a small fraction of the first, because the
 * boot and the scaledown tail are already bought. Charging every call the cold
 * price would be a check that fails correct work — this repo's most expensive
 * recurring mistake.
 */
export const USD_PER_SECOND = Object.freeze({
  /** MEASURED anchor — see the arithmetic above. */
  gpu: 0.000306,
  /**
   * A small CPU container, from its published per-core-second and per-GiB-second
   * rates. ⚠️ THE CONTAINER SHAPE IS AN ASSUMPTION, not a measurement — a
   * Playwright box may well be bigger. It is ~9x cheaper than the GPU rate, so
   * mis-classing a service the wrong way matters, which is why `SERVICE_CLASS`
   * below marks which entries are measured and which are read off what the
   * service obviously does.
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

/**
 * ── ⚠️ THE NOUN FOLLOWS THE PRICE TABLE (2026-09-26, found by using it) ─────
 * A dashboard run that took one `see_page` screenshot printed *"$0.0032 of that
 * is GPU time on 1 call"* while its own ledger entry said *"at the published
 * cpu rate"* — a hosted browser is a CPU container. Every other clause on that
 * line is careful about provenance; the hardware was simply hard-coded. So the
 * noun is derived from the classes actually charged, and a run that used only
 * GPU verbs still reads exactly "GPU time".
 */
export function computeNoun(classes) {
  const set = new Set(classes);
  if (set.size === 1 && set.has('gpu')) return 'GPU time';
  if (set.size === 1 && set.has('cpu')) return 'hosted CPU time';
  return 'hosted compute';
}

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
    /** Which hardware the price table charged — see `computeNoun`. */
    class: priced.class,
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
 * is `> 0`. The provider does not always report a cost — and when it does not,
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
   * ── ⭐⭐ THE UNIT METER — the ACCOUNT's allowance, not this RUN's budget ────
   *
   * ⚠️ TWO DIFFERENT CEILINGS AND THEY MUST NOT BE CONFLATED. `limitUsd` is
   * THIS RUN's dollar budget, set with `--budget`. The meter is the ACCOUNT's
   * monthly cost-unit allowance, set by the plan. A run can sit well inside its
   * own budget and still be out of allowance, and the reverse.
   *
   * ⭐ `null` FOR EVERY EXISTING CALLER, so nothing changes for anyone who has
   * not opted in — including all 17 operated·unmetered tenants, for whom there
   * is no allowance to enforce and "allowed" is the truth.
   *
   * Shape: `{ debit(usage, pricedRound) }`. See `lib/cost-units.mjs`.
   */
  meter = null,
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
  /**
   * ── ⭐⭐ WHAT A CRASHED PROCESS ALREADY SPENT ───────────────────────────────
   *
   * Everything else in this closure is per-PROCESS. Kill the terminal mid-round
   * and the next invocation starts a fresh meter at $0.00 against the same
   * ceiling — so "at most five cents" silently became "five cents per crash",
   * and the more unstable the run, the more it was allowed to spend. That is the
   * exact inversion a ceiling exists to prevent.
   *
   * ⭐ IT IS A NUMBER, NOT A FILE. `openSpendJournal` below does the reading and
   * hands the total here, so this file keeps its "no fs, no clock" property and
   * the resume rule stays provable for $0.00.
   *
   * ⚠️ IT COUNTS AGAINST THE CEILING AND NOT AGAINST THE TREND — the same split
   * `gpuUsd` gets, for the same reason. A resumed total fed into `projectNext()`
   * would project the next round at the cost of a whole previous run.
   */
  resumedUsd = 0,
  /**
   * The append side of the same journal: `{ record({ usd, rounds }) }`. Called
   * after every `record()`, so a crash loses at most the round in flight.
   *
   * ⚠️ IT MUST NEVER THROW INTO THE GOVERNOR. A full disk is not a reason to
   * kill a paid run mid-flight, so the call is wrapped — the cost of a failed
   * append is that a crash forgets one round, which is strictly better than
   * ending a run that was working.
   */
  journal = null,
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
  /**
   * ⚠️ A NEGATIVE OR NONSENSE RESUME IS ZERO, NOT A THROW. It arrives from a
   * FILE, and a corrupt journal must not be able to stop a run — `openSpendJournal`
   * already refuses a file it cannot read at all, which is the case that matters.
   * A junk number here fails toward "spend the full ceiling", which is the same
   * position as having no journal, i.e. exactly yesterday.
   */
  const carriedUsd = isNum(resumedUsd) && resumedUsd > 0 ? resumedUsd : 0;

  const effectiveLimit = unlimited ? Infinity : limitUsd - reserveUsd;
  const startedAt = clock();

  /** @type {BudgetRound[]} */
  const rounds = [];
  let spentUsd = 0;
  let totalTokens = 0;
  /**
   * ── ⭐⭐⭐ THE CACHE LEDGER. Roman's FIRST MVP acceptance point. ──────────
   *
   * *"caching solid even when models switch"* — and across 139 archived bench
   * runs, **not one carried a cache figure**, so it could not be evaluated at
   * all. `priceFromSplit` had the numbers every round and returned a dollar.
   *
   * ⚠️ `cacheUnknownRounds` IS NOT A ROUNDING ERROR, IT IS THE HONESTY. A
   * round whose usage cannot be read is UNKNOWN, not 0% cached. Folding it in
   * as a miss would understate every rate and make a reporting gap look like a
   * caching failure — the same rule `unitsFromUsage` follows one seam down.
   */
  let cachedInTokens = 0;
  let freshInTokens = 0;
  let outTokens = 0;
  let cacheKnownRounds = 0;
  let cacheUnknownRounds = 0;
  let estimatedRounds = 0;
  /**
   * ── ⚠️⚠️ THE TWO KINDS OF ZERO, COUNTED APART ──────────────────────────────
   *
   * `repricedZeroRounds` are rounds that reported $0.00 beside real tokens with
   * nothing to back the claim, and were therefore priced from those tokens.
   * `freeRounds` are rounds that DECLARED themselves free and were believed.
   *
   * ⚠️ THEY ARE SEPARATE FROM `estimatedRounds` BECAUSE THE SENTENCE IS
   * DIFFERENT. *"reported no cost"* is not what happened to a repriced round —
   * it reported a cost and we refused it — and a user on a genuinely free model
   * needs to read the difference to know what to do about it.
   */
  let repricedZeroRounds = 0;
  let freeRounds = 0;
  /** The first declaration seen, so `report()` can name WHY a zero was believed. */
  let freeWhy = null;

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
  /** The hardware classes drained so far (`gpu`, `cpu`, `vision`…), for the report's noun. */
  const gpuClasses = new Set();

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
      gpuClasses.add(c.kind === 'gpu' ? String(c.class ?? 'gpu') : String(c.kind ?? 'estimate'));
      /**
       * ── ⭐⭐⭐ CREATIVE DEBITS THE SAME POOL — THE LAST HOLE IN THE FLOOR ───
       *
       * ⚠️ The allowance is denominated in COST so no usage pattern can move
       * the floor. But `meter.debit` reads a TOKEN usage object, and a GPU
       * render, a voice clone or an image has no tokens — so the one category
       * of spend with no natural ceiling was the one the ceiling could not see.
       *
       * ⭐ HERE, FOR THE SAME REASON THE MODEL DEBIT LIVES INSIDE `record`.
       * `syncGpu` is called at the top of every public method, including the
       * read-only ones, precisely so a charge can never go unclaimed. Debiting
       * at the individual creative call sites would be a dozen chances to
       * forget; debiting inside the drain is structural.
       *
       * ⚠️ AND IT NEVER THROWS. By the time a charge is drained the money is
       * already spent — refusing to count it would only make the loss invisible.
       * The refusal belongs before the work (`checkUsd`, on the projection).
       */
      if (meter && typeof meter.debitUsd === 'function') {
        try { meter.debitUsd(c.usd); } catch { /* bookkeeping must never kill a run */ }
      }
    }
  }

  /**
   * The one number: model rounds plus estimated GPU time plus whatever a
   * crashed earlier process already spent against this same ceiling.
   */
  const totalSpent = () => spentUsd + gpuUsd + carriedUsd;

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

  /**
   * ⭐ THE WAY OUT FOR THE ONE USER THIS FIX COULD BE UNFAIR TO.
   *
   * If the provider really was free and simply did not say so, the run has just
   * been stopped on money it never spent. That user must not be left guessing —
   * the clause names the count, the reason, and both ways past it. It is EMPTY
   * on every other run, so no existing message changes by a byte.
   */
  function zeroClause() {
    if (repricedZeroRounds < 1) return '';
    return ` ⚠ ${repricedZeroRounds} round${repricedZeroRounds === 1 ? '' : 's'} reported $0.00 beside real tokens`
      + ` and ${repricedZeroRounds === 1 ? 'was' : 'were'} priced from those tokens rather than believed —`
      + ` if the model genuinely is free, run it with --budget none.`;
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
   * upstream usage object turn.mjs already has (`{ cost, total_tokens }`),
   * so the wiring is `budget.record(reply.usage)` and nothing else.
   */
  function record(entry) {
    syncGpu();
    const e = entry && typeof entry === 'object' ? entry : {};
    const rawCost = isNum(e.costUsd) ? e.costUsd : e.cost;
    const rawTokens = isNum(e.tokens) ? e.tokens : e.total_tokens;
    const tokens = isNum(rawTokens) && rawTokens >= 0 ? rawTokens : 0;

    /**
     * ── ⭐⭐ THE CACHE LEDGER, ABOVE EVERY PRICING BRANCH ─────────────────
     *
     * ⚠️⚠️ IT WAS INSIDE THE `tokens > 0` BRANCH AND MY OWN TEST CAUGHT IT.
     * `record` prices a round three ways — a REPORTED cost, a token split, or
     * a projection — and only the middle one ran the accumulator. A round
     * arriving with `costUsd` already set was counted in NEITHER `known` nor
     * `unknown`, so `known + unknown < rounds` and the gap was indistinguishable
     * from an uncached round.
     *
     * ⭐ Hoisting it above the branches makes the ledger total by construction
     * rather than by three branches each remembering — the same argument this
     * function already makes for debiting the unit meter here instead of at
     * its three call sites.
     */
    const split = splitFromUsage(e);
    if (split) {
      cachedInTokens += split.cached;
      freshInTokens += split.fresh;
      outTokens += split.completion;
      cacheKnownRounds += 1;
    } else {
      cacheUnknownRounds += 1;
    }

    let costUsd;
    /** @type {'reported'|'free'|'zero-unpriced'|'tokens'|'projected'} */
    let source;
    /**
     * ── ⚠️⚠️⭐ THE REPORTED ZERO. See case 4 in the header of this file. ──────
     *
     * A zero is only ever disbelieved when BOTH halves of the corroboration
     * fail: tokens demonstrably moved, and nothing in the payload declares the
     * leg free. Every other zero is believed exactly as it was before.
     */
    const reportedZero = isNum(rawCost) && rawCost === 0;
    const declaredFree = reportedZero ? freeLegDeclaration(e) : { free: false, why: null };
    const moved = reportedZero ? tokensMoved(e) : false;
    if (isNum(rawCost) && rawCost > 0) {
      costUsd = rawCost;
      source = 'reported';
    } else if (reportedZero && !moved) {
      // Nothing moved, so there is nothing to disbelieve. A call that failed
      // before it reached a provider reports exactly this.
      costUsd = 0;
      source = 'reported';
    } else if (reportedZero && declaredFree.free) {
      // Lever 3, intact: a free-tier leg that SAYS it is free is free, and that
      // is a stated fact rather than an estimate.
      costUsd = 0;
      source = 'free';
      freeRounds += 1;
      freeWhy = freeWhy ?? declaredFree.why;
    } else if (reportedZero) {
      /**
       * ⭐ THE HOLE, CLOSED. Tokens moved and the leg is silent about why they
       * were free, so they are priced from the tokens themselves at the rate in
       * force — the same arithmetic the branch below has always used for a
       * provider that omits the field. The user is told, because being wrong
       * here means charging a genuinely free run.
       */
      const pricedZero = priceFromSplit(e);
      costUsd = pricedZero !== null ? pricedZero : (tokens / 1e6) * usdPerMillionTokens;
      source = 'zero-unpriced';
      repricedZeroRounds += 1;
    } else if (tokens > 0) {
      /**
       * ── ⭐⭐⭐ PRICE THE MIX, NOT A BLEND ─────────────────────────────────
       *
       * A flat `$/M` cannot be right for two rounds with different shapes, and
       * that is exactly why two honest measurements of the same model appeared
       * to disagree by 2x. Reconciled 2026-08-21 across three real mixes — a
       * short cold output-heavy round, a prompt-heavy build round, and that same
       * build round at 80% cache — the effective per-million rate spanned a
       * **3.7x** range. On the card in force now it spans **4.6x**, because
       * output moved further from input. The one-flat-rate error is bigger than
       * it was, not smaller.
       *
       * ⭐ SAME RATES, DIFFERENT MIXES. Neither measurement was wrong; the
       * constant was, because one number cannot describe both. So when the usage
       * object tells us the split — and the upstream always does, even when it
       * reports no cost — price it properly and stop guessing.
       *
       * ⚠️ FALLS BACK, NEVER THROWS. A usage object without the split is priced
       * exactly as before, so this can only ever be more accurate than the
       * constant, never less.
       */
      const priced = priceFromSplit(e);
      /**
       * ⭐ THE SAME OBJECT THE PRICE READ. Accumulating here rather than at a
       * call site is the rule this function already follows for the unit
       * meter: `record` is the one place that means "a round happened", so a
       * future path cannot forget to count its cache.
       */
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
      /**
       * ⚠️ `'free'` IS NOT AN ESTIMATE. The other four sources either read a
       * bill or guessed at one; a declared free leg is a stated fact, and
       * marking it "estimated" would put an ⚠ on the summary of a run that is
       * priced exactly right — the cry-wolf failure that makes the honest
       * warning on `'zero-unpriced'` worth nothing.
       */
      estimated: source !== 'reported' && source !== 'free',
      at: clock(),
    };
    rounds.push(rec);
    spentUsd += costUsd;
    totalTokens += tokens;
    if (rec.estimated) estimatedRounds += 1;
    /**
     * ⭐ WRITTEN AFTER THE ROUND IS COUNTED, NOT BEFORE. A journal entry for a
     * round that then failed to be counted would over-charge the next process;
     * the reverse loses at most the round in flight, which is the direction that
     * cannot bill somebody twice.
     */
    if (journal && typeof journal.record === 'function') {
      try { journal.record({ usd: totalSpent(), rounds: rounds.length }); } catch { /* see the note on `journal` */ }
    }
    /**
     * ── ⭐⭐⭐ THE UNIT METER, DEBITED AT THE ONE PLACE EVERY ROUND PASSES ────
     *
     * Roman: *"making it real is the gating, the way any use case of Acuvo is
     * functioning — these principles must be hardcoded into it."*
     *
     * ⭐ WHY HERE AND NOT AT THE CALL SITES. `turn.mjs` calls `budget.record`
     * from THREE places (3924, 3966, 4544) and any future path will call it too,
     * because it is the one function that already means "a round happened and
     * it cost something". Debiting at the call sites would be three chances to
     * forget; debiting here is structural.
     *
     * ⚠️ AND IT NEVER THROWS. `lib/audit.mjs` states the rule this follows: a
     * round must never die because bookkeeping did. A meter that can take down
     * a customer's build is worse than no meter — the spend has already
     * happened by the time we get here, so refusing to record it changes
     * nothing except making the loss invisible.
     *
     * ⚠️ `entry` IS THE RAW PROVIDER USAGE — the same object `priceFromSplit`
     * reads for the cached/fresh/output split, so the meter sees exactly what
     * the price saw. `unitsFromUsage` returns null for a round it cannot price,
     * and null is
     * NOT zero — an unpriceable round is unknown, not free. It is passed through
     * so the meter can count it as unknown rather than silently forgiving it.
     */
    if (meter && typeof meter.debit === 'function') {
      try { meter.debit(entry, rec); } catch { /* bookkeeping must never kill a round */ }
    }
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

    /**
     * ── ⭐⭐⭐ THE ACCOUNT'S ALLOWANCE, ASKED BEFORE THE ROUND ────────────────
     *
     * The debit half has been wired since `budget.record` → `meter.debit`. This
     * is the REFUSAL half, and until now it did not exist: `unitGate` was
     * written, tested, and reached from nothing outside `cost-units.mjs`. A
     * ceiling that is only ever counted after the fact is not a ceiling.
     *
     * ⚠️ IT IS COMPOSED HERE FOR THE SAME REASON THE FLEET GATE IS — one seam,
     * not four call sites. `canContinue()` is consulted from `turn.mjs` ×3 and
     * `escalate.mjs` ×1, and a future fifth caller cannot forget it.
     *
     * ⚠️ AND IT SITS BEFORE THE `unlimited` BRANCH, deliberately, exactly as the
     * fleet gate does. `--budget none` removes the per-RUN ceiling; it says
     * nothing about the ACCOUNT's monthly allowance. Checking after the
     * unlimited early-return would leave the one run that can drain an
     * allowance fastest as the one run the allowance never sees.
     *
     * ⭐ IT CAN ONLY EVER REFUSE. `meter === null` for every existing caller and
     * all 17 `operated · unmetered` tenants, and `unitGate` returns
     * `allowed: true` on `granted === null` — so this is a byte-for-byte no-op
     * for everyone who has not opted in, which is the bar for adding anything
     * to a path that spends money.
     */
    if (meter && typeof meter.checkUsd === 'function') {
      const allowance = meter.checkUsd(projection.usd);
      if (allowance && allowance.allowed === false) {
        /**
         * ⚠️ THE NAMESPACED REASON MUST BE ONE `BUDGET_REASONS` DECLARES. A
         * verdict in no list is the exact defect `escalate.mjs` records paying
         * for three times, so an unrecognised allowance reason falls back to
         * the spent case rather than inventing a fourth string.
         */
        const namespaced = `allowance:${allowance.reason}`;
        return {
          ok: false,
          reason: ALLOWANCE_STOP_REASONS.includes(namespaced) ? namespaced : ALLOWANCE_STOP_REASONS[0],
          message: allowance.message,
          /**
           * ⚠️ THE PER-RUN DOLLARS ARE STILL REPORTED HONESTLY. The allowance is
           * denominated in units and converting it back into a dollar figure
           * here would invent a number; what stopped the run is named in
           * `reason`, and `escalate.mjs` reads `ok === false` before it reads
           * anything else.
           */
          remainingUsd: unlimited ? Infinity : Math.max(0, effectiveLimit - totalSpent()),
          allowanceUnitsRemaining: allowance.remaining,
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
        message: `budget spent: ${formatUsd(totalSpent())} of ${formatUsd(limitUsd)} after ${rounds.length} round${rounds.length === 1 ? '' : 's'}${gpuClause()}.${wayOut}${zeroClause()}`,
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
      /**
       * ⚠️ A RESUMED RUN IS NEVER 'too-small'. `rounds.length === 0` means
       * "nothing was started" only when nothing was carried in — after a crash
       * the work DID start, and telling the user "nothing was started, raise it
       * or drop the flag" about money they have already spent is an output that
       * lies about what the tool did.
       */
      const tooSmall = rounds.length === 0 && carriedUsd <= 0;
      return {
        ok: false,
        reason: tooSmall ? 'too-small' : 'would-exceed',
        message: tooSmall
          ? `budget of ${formatUsd(limitUsd)} cannot cover even one round (projected ~${formatUsd(projection.usd)}). Nothing was started — raise it or drop the flag.`
          : `stopping on budget after ${rounds.length} round${rounds.length === 1 ? '' : 's'}: ${formatUsd(totalSpent())} of ${formatUsd(limitUsd)} spent${gpuClause()} and the next round is projected at ~${formatUsd(projection.usd)}, which would cross the line.${wayOut}${zeroClause()}`,
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
      /** What a crashed earlier process of this run already spent. 0 normally. */
      resumedUsd: carriedUsd,
      totalTokens,
      /**
       * ⭐ THE CACHE LEDGER. `cacheRate` is cached ÷ TOTAL INPUT, over the
       * rounds we could actually read — never over all rounds, or an
       * unreadable round would masquerade as a cache miss.
       *
       * ⚠️ `null` WHEN NOTHING IS KNOWN. Zero would say "we cached nothing";
       * null says "we do not know", and those are the two answers this whole
       * ledger exists to stop anyone confusing.
       */
      cachedInTokens,
      freshInTokens,
      outTokens,
      cacheKnownRounds,
      cacheUnknownRounds,
      cacheRate: cachedInTokens + freshInTokens > 0
        ? cachedInTokens / (cachedInTokens + freshInTokens)
        : null,
      estimated: estimatedRounds > 0 || gpuCalls > 0,
      estimatedRounds,
      /**
       * ⭐ THE TWO ZERO COUNTS, ON THE OBJECT `toJSON` AND THE AUDIT RECORD
       * READ. A run that was charged for tokens a provider called free must be
       * able to prove it later — the whole reason `record()` stopped believing
       * a bare zero is that nobody could see it happening.
       */
      repricedZeroRounds,
      freeRounds,
      freeWhy,
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
      ? ` · ⚠ ${formatUsd(gpuUsd)} of that is ${computeNoun(gpuClasses)} on ${gpuCalls} call${gpuCalls === 1 ? '' : 's'}, ESTIMATED from a price table (we are not billed per call)`
      : '';
    /**
     * ⚠️ THE BLIND ROUNDS ARE COUNTED WITHOUT THE REPRICED ONES. A repriced
     * round did NOT "report no cost" — it reported zero and was refused — and
     * folding the two into one sentence would describe neither. With no
     * repricing the arithmetic is `estimatedRounds - 0` and this string is
     * byte-for-byte what it has always been.
     */
    const blindRounds = estimatedRounds - repricedZeroRounds;
    const tail = blindRounds > 0
      ? ` · ⚠ ${blindRounds} of ${n} rounds reported no cost, so the total is an estimate`
      : '';
    const zeros = repricedZeroRounds > 0
      ? ` · ⚠ ${repricedZeroRounds} of ${n} rounds reported $0.00 beside real tokens and were priced from those tokens (--budget none if the model really is free)`
      : '';
    const freeSaid = freeRounds > 0
      ? ` · ${freeRounds} free round${freeRounds === 1 ? '' : 's'}${freeWhy ? ` (${freeWhy})` : ''}`
      : '';
    /**
     * ── ⭐⭐⭐ THE CACHE RATE, ON THE LINE A HUMAN ACTUALLY READS ───────────
     *
     * Roman's first MVP acceptance point is *"caching solid even when models
     * switch"*, and across 139 archived bench runs the number appeared
     * NOWHERE — not in the JSON, not on screen. A metric the whole margin
     * rests on was invisible while being computed once a round.
     *
     * ⚠️ IT PRINTS ONLY WHEN IT IS KNOWN. A run whose provider reported no
     * usage says nothing rather than "0%" — the difference between a cold
     * cache and an unmeasured one is the entire point of this clause.
     *
     * ⚠️ And it names the UNKNOWN rounds when there are any, because a 99%
     * rate over two of thirty rounds is not a 99% run.
     */
    const cacheRate = cachedInTokens + freshInTokens > 0
      ? cachedInTokens / (cachedInTokens + freshInTokens)
      : null;
    const cache = cacheRate === null
      ? ''
      : ` · cache ${(cacheRate * 100).toFixed(1)}%`
        + (cacheUnknownRounds > 0
          ? ` (of ${cacheKnownRounds} measured round${cacheKnownRounds === 1 ? '' : 's'}; ${cacheUnknownRounds} unmeasured)`
          : '');
    if (unlimited) {
      return `budget: ${formatUsd(totalSpent())} spent · ${roundWord}${cache} · no limit set${gpu}${tail}${zeros}${freeSaid}`;
    }
    const projected = projectNext().usd;
    const remaining = Math.max(0, effectiveLimit - totalSpent());
    return `budget: ${formatUsd(totalSpent())} of ${formatUsd(limitUsd)} spent · ${roundWord}${cache} · next ~${formatUsd(projected)} · ${formatUsd(remaining)} left${gpu}${tail}${zeros}${freeSaid}`;
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
      /** ⚠️ ABSENT ON AN ORDINARY RUN, for the same reason the GPU keys are —
       *  `--json` must not grow a field because a capability nobody used exists. */
      ...(s.resumedUsd > 0 ? { resumedUsd: s.resumedUsd } : {}),
      /**
       * ⚠️ ABSENT WHEN NOTHING WAS MEASURED, exactly like the GPU and resumed
       * keys above — `--json` on a run that read no usage is unchanged byte
       * for byte, so no consumer's schema moves because a capability exists.
       * When it IS present it is the number Roman's first MVP point turns on.
       */
      ...(s.cacheKnownRounds > 0 ? {
        cachedInTokens: s.cachedInTokens,
        freshInTokens: s.freshInTokens,
        outTokens: s.outTokens,
        cacheRate: s.cacheRate,
        cacheKnownRounds: s.cacheKnownRounds,
        ...(s.cacheUnknownRounds > 0 ? { cacheUnknownRounds: s.cacheUnknownRounds } : {}),
      } : {}),
      estimated: s.estimated,
      estimatedRounds: s.estimatedRounds,
      /**
       * ⚠️ ABSENT UNLESS IT HAPPENED — the same rule as every conditional key
       * above, so `--json` and every audit record on an ordinary run are
       * unchanged byte for byte. When present, this is the receipt that a
       * provider claimed $0.00 for tokens that moved and was not believed.
       */
      ...(s.repricedZeroRounds > 0 ? { repricedZeroRounds: s.repricedZeroRounds } : {}),
      ...(s.freeRounds > 0 ? { freeRounds: s.freeRounds, freeWhy: s.freeWhy } : {}),
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
/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ CRASH SAFETY — A CEILING THAT DIES WITH THE PROCESS IS NOT A CEILING
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ── ⚠️⚠️ THE FAILURE THIS CLOSES, STATED PLAINLY ────────────────────────────
 *
 * Everything in `createBudget` lives in one closure in one process. Ctrl-C the
 * run, or lose the terminal, and the next invocation starts a brand-new meter at
 * $0.00 against the same stated ceiling. So `--budget 0.50` meant "fifty cents
 * per surviving process", and a run that crashed four times was permitted two
 * dollars — the ceiling got LOOSER the worse things went, which is the exact
 * inversion a blast radius exists to prevent.
 *
 * ⭐ ONE LINE PER RECORDED ROUND, APPEND-ONLY, LAST-WINS. Not a rewritten JSON
 * document: a process killed in the middle of a rewrite leaves a truncated file,
 * and a truncated file that fails to parse is precisely how a ceiling silently
 * becomes "no ceiling". A half-written final LINE is discarded and the line
 * before it is still true.
 *
 * ⚠️ AND AN UNREADABLE JOURNAL STOPS THE RUN — `policy.mjs`'s rule, verbatim:
 * *absent is not malformed.* A missing file is the common case and means "this
 * run has spent nothing"; a present-but-unreadable one is a broken control, and
 * quietly reading it as $0.00 is fail-open on a permissions error.
 *
 * ⚠️ NO CLOCK, NO `fs` IMPORT. The reader and the appender arrive as arguments,
 * the same discipline `readConfigSources` and `readPolicySources` use, which is
 * why the whole resume rule is provable without touching a disk.
 */
export const SPEND_JOURNAL_FILE = '.acuvo/spend.jsonl';

/**
 * How many journal lines are kept before the reader stops caring. A run that
 * has written more than this has bigger problems than the tail of its ledger,
 * and an unbounded read of a file an agent can append to is a memory footgun.
 */
export const SPEND_JOURNAL_MAX_LINES = 5_000;

/**
 * Read the prior spend for one run key, and hand back the appender.
 *
 * @param {object} args
 * @param {string} args.runKey   what identifies THIS run across processes
 * @param {() => string} args.read   returns the journal text, or throws ENOENT
 * @param {(line: string) => void} [args.append]  appends one line, terminator included
 * @param {number|null} [args.ceilingUsd]  the ceiling this process was given
 * @returns {{ ok: true, priorUsd: number, priorRounds: number, priorCeilingUsd: number|null,
 *             record: (e: {usd: number, rounds: number}) => void }
 *           | { ok: false, error: string }}
 */
export function openSpendJournal({ runKey, read, append = null, ceilingUsd = null } = {}) {
  const key = String(runKey ?? '').trim();
  if (!key) return { ok: false, error: 'openSpendJournal needs a runKey — a journal nobody can match is a journal nobody can resume' };
  if (typeof read !== 'function') return { ok: false, error: 'openSpendJournal needs a reader' };

  let text = null;
  try {
    text = read();
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : null;
    // ⚠️ Absent is "nothing spent". Anything else is a broken control.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return { ok: false, error: `the spend journal could not be read — ${err instanceof Error ? err.message : String(err)}. Refusing to start a fresh ceiling over spend it cannot see.` };
    }
  }

  let priorUsd = 0;
  let priorRounds = 0;
  let priorCeilingUsd = null;
  let sawCeilingLine = false;

  const lines = String(text ?? '').split('\n').slice(-SPEND_JOURNAL_MAX_LINES);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let row;
    /**
     * ⚠️ A LINE THAT DOES NOT PARSE IS SKIPPED, NOT FATAL. The last line of a
     * file whose writer was killed mid-append is legitimately half a line, and
     * refusing to start because of it would turn every crash into a wedged
     * workspace. The lines before it are intact and are what we came for.
     */
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || row.k !== key) continue;
    if (isNum(row.u) && row.u >= 0) priorUsd = Math.max(priorUsd, row.u);
    if (isNum(row.n) && row.n >= 0) priorRounds = Math.max(priorRounds, Math.floor(row.n));
    if ('c' in row) {
      sawCeilingLine = true;
      /**
       * ⭐ THE TIGHTEST CEILING EVER RECORDED FOR THIS RUN WINS — the same meet
       * `policy.mjs` uses, for the same reason. Otherwise the way to escape a
       * ceiling is to crash and restart without the flag.
       */
      const c = isNum(row.c) && row.c > 0 ? row.c : null;
      if (c !== null) priorCeilingUsd = priorCeilingUsd === null ? c : Math.min(priorCeilingUsd, c);
    }
  }
  /**
   * ⚠️ A RUN RECORDED WITH NO CEILING AT ALL (`--budget none`) MUST NOT COME
   * BACK AS A CEILING. `null` after a ceiling line was seen means "the user
   * really did ask for unlimited", and inventing one here would be this file
   * refusing work the user paid to be allowed.
   */
  if (sawCeilingLine && priorCeilingUsd === null) priorCeilingUsd = null;

  const write = (obj) => {
    if (typeof append !== 'function') return;
    append(`${JSON.stringify(obj)}\n`);
  };

  // The ceiling this process is running under, recorded before a cent is spent.
  try {
    write({ k: key, c: isNum(ceilingUsd) && ceilingUsd > 0 ? ceilingUsd : null });
  } catch { /* an unwritable journal must not stop a run — see the header */ }

  return {
    ok: true,
    priorUsd,
    priorRounds,
    priorCeilingUsd,
    record: ({ usd, rounds }) => write({ k: key, u: isNum(usd) && usd > 0 ? usd : 0, n: Math.floor(rounds) || 0 }),
  };
}

/**
 * ── ⭐ THE CEILING A RESUMED RUN ACTUALLY GETS ──────────────────────────────
 *
 * PURE, and separated from `createBudget` so the rule is reviewable rather than
 * buried: this decides whether a crash can widen a limit.
 *
 * ⚠️ THE MINIMUM, UNLESS THE USER TYPED A NEW NUMBER THIS TIME. Taking the
 * minimum unconditionally would mean a user who deliberately raises the ceiling
 * after a crash ("that job needs more than five cents") is silently held to the
 * old one — which is a tool ignoring an instruction, the failure
 * `bestOfAttemptBudget` was written to stop doing with `--budget`. Taking the
 * new one unconditionally is the hole. `explicit` is the fact that separates
 * them, and it already exists (`budgetExplicit`, cli-args.mjs).
 *
 * @param {{ limitUsd: number|null, priorCeilingUsd: number|null, explicit?: boolean }} o
 * @returns {{ usd: number|null, carriedOver: boolean, reason: string|null }}
 */
export function resumeCeiling({ limitUsd = null, priorCeilingUsd = null, explicit = false } = {}) {
  if (priorCeilingUsd === null || priorCeilingUsd === undefined) {
    return { usd: limitUsd ?? null, carriedOver: false, reason: null };
  }
  if (explicit) {
    return {
      usd: limitUsd ?? null,
      carriedOver: false,
      reason: `an earlier process of this run was capped at ${formatUsd(priorCeilingUsd)}; you asked for `
        + `${limitUsd === null ? 'no ceiling' : formatUsd(limitUsd)} this time, so that is what applies.`,
    };
  }
  if (limitUsd === null || limitUsd === undefined || priorCeilingUsd < limitUsd) {
    return {
      usd: priorCeilingUsd,
      carriedOver: true,
      reason: `keeping the ${formatUsd(priorCeilingUsd)} ceiling an earlier process of this run was started with — `
        + 'a crash must not be a way to spend more. Pass --budget to set a new one deliberately.',
    };
  }
  return { usd: limitUsd, carriedOver: false, reason: null };
}

export function bestOfAttemptBudget(opts) {
  const n = Math.max(1, Number(opts?.bestOf) || 1);
  if (opts?.budgetExplicit === true && Number.isFinite(opts?.budgetUsd) && opts.budgetUsd > 0) {
    return opts.budgetUsd / n;
  }
  return DEFAULT_BUDGET_USD;
}
