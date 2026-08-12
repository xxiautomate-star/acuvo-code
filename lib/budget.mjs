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
 * ── PURE, AND DELIBERATELY SO ───────────────────────────────────────────────
 * No network, no model, no fs, no ambient time. Data in, data out, plus an
 * injected clock — which is why the whole thing is provable for $0.00, and why
 * the "$0.01 is a lot when testing" rule is not even slightly strained by it.
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
 */
export const DEFAULT_BUDGET_USD = 0.02;

/**
 * The fallback price when the provider reports tokens but no cost.
 *
 * Same measurement, inverted: 1,036 tokens for $0.000231 is $0.223 per million.
 * Rounded UP to $0.30, because over-pricing an unknown stops the run slightly
 * early and under-pricing it lets the run overshoot — and only one of those two
 * shows up on a bill.
 */
export const DEFAULT_USD_PER_MILLION_TOKENS = 0.30;

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

/** Every verdict `canContinue()` can return, so a caller can switch on it. */
export const BUDGET_REASONS = ['ok', 'no-budget-set', 'too-small', 'would-exceed', 'limit-reached'];

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
      costUsd = (tokens / 1e6) * usdPerMillionTokens;
      source = 'tokens';
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
    const projection = projectNext();
    const elapsedMs = clock() - startedAt;
    const base = {
      spentUsd,
      projectedUsd: projection.usd,
      estimated: estimatedRounds > 0,
      rounds: rounds.length,
      limitUsd: unlimited ? null : limitUsd,
      reserveUsd,
      elapsedMs,
    };

    if (unlimited) {
      return {
        ok: true,
        reason: 'no-budget-set',
        message: `no budget limit set — ${formatUsd(spentUsd)} spent so far`,
        remainingUsd: Infinity,
        ...base,
      };
    }

    const remainingUsd = effectiveLimit - spentUsd;

    /**
     * ⭐ A REFUSAL THAT DOES NOT SAY WHAT TO TYPE IS JUST AN OBSTACLE. That rule
     * is why this package's refusals are its best-written part, and it applies
     * hardest here — because the ceiling is now ON BY DEFAULT, so the first
     * person to meet it will not have chosen the number.
     */
    const wayOut = limitIsDefault
      ? ` This is the default ceiling of ${formatUsd(limitUsd)}, not one you set — raise it with --budget (e.g. --budget 0.50) or remove it with --budget none.`
      : ' Raise it with --budget if the job needs more.';

    if (remainingUsd <= USD_EPSILON) {
      return {
        ok: false,
        reason: 'limit-reached',
        message: `budget spent: ${formatUsd(spentUsd)} of ${formatUsd(limitUsd)} after ${rounds.length} round${rounds.length === 1 ? '' : 's'}.${wayOut}`,
        remainingUsd: Math.max(0, remainingUsd),
        ...base,
      };
    }

    if (spentUsd + projection.usd > effectiveLimit + USD_EPSILON) {
      const tooSmall = rounds.length === 0;
      return {
        ok: false,
        reason: tooSmall ? 'too-small' : 'would-exceed',
        message: tooSmall
          ? `budget of ${formatUsd(limitUsd)} cannot cover even one round (projected ~${formatUsd(projection.usd)}). Nothing was started — raise it or drop the flag.`
          : `stopping on budget after ${rounds.length} round${rounds.length === 1 ? '' : 's'}: ${formatUsd(spentUsd)} of ${formatUsd(limitUsd)} spent and the next round is projected at ~${formatUsd(projection.usd)}, which would cross the line.${wayOut}`,
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

  function stats() {
    return {
      rounds: rounds.length,
      spentUsd,
      totalTokens,
      estimated: estimatedRounds > 0,
      estimatedRounds,
      limitUsd: unlimited ? null : limitUsd,
      reserveUsd,
      remainingUsd: unlimited ? Infinity : effectiveLimit - spentUsd,
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
    const n = rounds.length;
    const roundWord = `${n} round${n === 1 ? '' : 's'}`;
    const tail = estimatedRounds > 0
      ? ` · ⚠ ${estimatedRounds} of ${n} rounds reported no cost, so the total is an estimate`
      : '';
    if (unlimited) {
      return `budget: ${formatUsd(spentUsd)} spent · ${roundWord} · no limit set${tail}`;
    }
    const projected = projectNext().usd;
    const remaining = Math.max(0, effectiveLimit - spentUsd);
    return `budget: ${formatUsd(spentUsd)} of ${formatUsd(limitUsd)} spent · ${roundWord} · next ~${formatUsd(projected)} · ${formatUsd(remaining)} left${tail}`;
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
      estimated: s.estimated,
      estimatedRounds: s.estimatedRounds,
      elapsedMs: s.elapsedMs,
    };
  }

  /** A copy. The ledger is not editable from outside. */
  const history = () => rounds.map((r) => ({ ...r }));

  return { record, projectNext, canContinue, report, stats, toJSON, history };
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
