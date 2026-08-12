/**
 * ── ⭐⭐ THE BUDGET AS A STRATEGY, NOT A CEILING ────────────────────────────
 *
 * `lib/budget.mjs` answers one question: *may I afford another round?* That is
 * a brake. It has never once decided to spend MORE on a task because the task
 * was hard — and spending more on the hard ones is the only advantage we
 * actually have.
 *
 * Measured, this repo, 2026-08-11: **$0.000738 per task.** Three attempts cost
 * less than one attempt on Claude or GPT pricing. So the loop every competitor
 * is forced to run is *"one attempt, be smart"*, and the loop we can afford is
 * *"escalate until it passes, and stop at the dollar."* That is not a margin
 * trick. On a pass/fail task it is a capability, and it gets HARDER to copy the
 * more expensive the competitor's model is.
 *
 * ⚠️ IT WAS UNREACHABLE FROM THE ONLY MODE THAT NEEDED IT. `runBestOf` had
 * exactly one caller — `bin/acuvo.mjs:1092`, a top-level `--best-of` mode that
 * refuses to combine with `--resume`. So the unattended runner, the one thing
 * that runs for hours with nobody watching, could not use it. Built, tested,
 * green, and locked out of its own use case: the failure mode this package has
 * hit often enough to have a name for it.
 *
 * ── THE LADDER ─────────────────────────────────────────────────────────────
 *
 *   1. `solo`     one session. What every run does today. Cheapest.
 *   2. `fresh`    the SAME task, a NEW context, carrying the FAILURE and not
 *                 the transcript. The industry calls this the Ralph loop; the
 *                 reason it works is that the context which produced the loop
 *                 is the context least able to escape it. `stuck.mjs` nudges
 *                 INSIDE that context (`turn.mjs:2142`) — this is the rung
 *                 above the nudge, and it is what the nudge escalates to.
 *   3. `best-of`  N isolated copies of the workspace, N independent attempts,
 *                 keep the one that VERIFIES. `best-of.mjs` already does all of
 *                 this and picks by what ran, not by what was claimed.
 *
 * ── ⚠️⚠️ FOUR HONESTY RULES, AND EACH ONE IS A TEST ────────────────────────
 *
 * 1. **NEVER START A RUNG THE BUDGET CANNOT FINISH.** Half a best-of is worse
 *    than none: it spends real money and applies nothing, because the winner is
 *    chosen by comparison and there is nothing to compare. So a rung is entered
 *    only when the remaining budget covers its PROJECTION.
 *
 * 2. **THE PROJECTION IS MEASURED, NOT A CONSTANT.** `best-of N` costs about N
 *    times what the last attempt cost, because it is literally N of them. A
 *    flat estimate is a lie that overspends by 3x on the one code path whose
 *    entire job is not to.
 *
 * 3. **A SKIPPED RUNG IS REPORTED, NEVER ABSENT.** "It failed" and "it failed
 *    and I could not afford to try harder" are different facts, and only one of
 *    them means *give me another dollar*. A ladder that silently stops short
 *    reads as a capability failure when it was a funding decision.
 *
 * 4. **A CRASH IS NOT A RUNG.** A transport error, a killed process, a 429 —
 *    those are not evidence the approach was wrong, so they must not consume an
 *    escalation. Escalating on a network blip pays triple for a bad connection.
 *    Only a completed-and-unverified attempt moves the ladder.
 */

import { runBestOf } from './best-of.mjs';
import { formatUsd, BUDGET_REASONS } from './budget.mjs';
import { planRung, describeSwitch } from './model-tier.mjs';

/**
 * The rungs, cheapest first. Order is load-bearing: `nextTier` walks this
 * array, and `maxTier` is an index into it.
 */
export const TIERS = Object.freeze(['solo', 'fresh', 'best-of']);

/** Default attempts for the `best-of` rung. `best-of.mjs` clamps to 2..5. */
export const DEFAULT_ATTEMPTS = 3;

/**
 * ⚠️ A FLOOR UNDER THE PROJECTION, because the first attempt can legitimately
 * cost ~$0 (a cache hit, a refusal, an immediate answer) and a projection of
 * zero would wave a rung through that the budget cannot actually pay for.
 * Seeded from the same measured order of magnitude as `budget.mjs`.
 */
export const MIN_PROJECTION_USD = 0.0005;

/**
 * How much more a rung costs than the attempt before it.
 *
 * `fresh` is one more session, so ~1x — plus a little, because a fresh context
 * re-reads the files the old one already had cached, and a cache miss is the
 * expensive direction (measured 3.05x in `turn-cache-and-prefix.test.mjs`).
 *
 * `best-of` is N sessions, so it is `attempts` x — computed, never guessed.
 */
export const FRESH_MULTIPLIER = 1.4;

/**
 * What the next rung will cost, in dollars, based on what the last one actually
 * cost. Exported because rule 2 is only true if this is testable on its own.
 *
 * @param {string} tier
 * @param {{ lastAttemptUsd?: number, attempts?: number }} opts
 * @returns {number}
 */
export function projectTierCost(tier, { lastAttemptUsd = 0, attempts = DEFAULT_ATTEMPTS } = {}) {
  const base = Number.isFinite(lastAttemptUsd) && lastAttemptUsd > 0
    ? lastAttemptUsd
    : MIN_PROJECTION_USD;

  switch (tier) {
    case 'solo':
      return base;
    case 'fresh':
      return base * FRESH_MULTIPLIER;
    case 'best-of': {
      const n = Math.max(2, Math.min(5, Number(attempts) || DEFAULT_ATTEMPTS));
      return base * n;
    }
    default:
      throw new RangeError(`escalate: unknown tier ${JSON.stringify(tier)} — expected one of ${TIERS.join(', ')}`);
  }
}

/**
 * ── ⚠️⚠️ THE BUDGET MUST BE ALLOCATED, OR THE LADDER IS DECORATIVE ─────────
 *
 * `runSession` already accepts `budgetUsd` and enforces it per session. Hand
 * every rung the SAME `--budget 2.00` and the first one is entitled to spend
 * all of it — so the ladder would sit there, correct and green and permanently
 * on rung one, having been engineered out of its own job by a default.
 *
 * ⭐ So each rung gets a SLICE, weighted by what that rung costs relative to
 * the others. Weights are the same multipliers `projectTierCost` uses, so the
 * allocation and the projection can never drift apart.
 *
 * ⚠️ THE CHEAP RUNG GETS A SMALL SHARE, AND THAT IS THE POINT. A solo attempt
 * that cannot finish in ~18% of the budget is exactly the attempt whose
 * remaining 82% is better spent on a fresh context and three parallel tries.
 * The budget is a ceiling, not a target: when rung one verifies, the other 82%
 * is never spent at all.
 *
 * @param {number} totalUsd
 * @param {{ maxTier?: string, attempts?: number }} opts
 * @returns {Record<string, number>} per-rung ceiling in dollars
 */
export function allocate(totalUsd, { maxTier = 'best-of', attempts = DEFAULT_ATTEMPTS } = {}) {
  const ceiling = TIERS.indexOf(maxTier);
  if (ceiling === -1) throw new RangeError(`escalate: unknown maxTier ${JSON.stringify(maxTier)}`);
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return {};

  const rungs = TIERS.slice(0, ceiling + 1);
  const weights = rungs.map((t) => projectTierCost(t, { lastAttemptUsd: 1, attempts }));
  const sum = weights.reduce((a, b) => a + b, 0);

  /** @type {Record<string, number>} */
  const out = {};
  rungs.forEach((t, i) => { out[t] = (totalUsd * weights[i]) / sum; });
  return out;
}

/**
 * The rung above `current`, or null at the top.
 * @param {string} current
 * @param {{ maxTier?: string }} opts
 */
export function nextTier(current, { maxTier = 'best-of' } = {}) {
  const i = TIERS.indexOf(current);
  if (i === -1) throw new RangeError(`escalate: unknown tier ${JSON.stringify(current)}`);
  const ceiling = TIERS.indexOf(maxTier);
  if (ceiling === -1) throw new RangeError(`escalate: unknown maxTier ${JSON.stringify(maxTier)}`);
  if (i >= ceiling) return null;
  return TIERS[i + 1];
}

/**
 * ⚠️ THE FAILURE IS CARRIED, THE TRANSCRIPT IS NOT — that is the entire point
 * of the `fresh` rung. Handing the new context the old conversation recreates
 * the state that got stuck; handing it the OUTCOME gives it the one thing the
 * old context learned without any of what trapped it.
 *
 * Kept short on purpose: this text is a prompt prefix, it is paid for on every
 * round of the new session, and a long one buys nothing.
 *
 * @param {string} task
 * @param {object|null} prior
 * @returns {string}
 */
export function freshBriefing(task, prior) {
  const lines = [task];
  if (!prior) return lines.join('\n');

  const notes = [];
  if (prior.reason) notes.push(`it stopped because: ${prior.reason}`);
  if (prior.failure) notes.push(`the check that did not pass: ${prior.failure}`);

  if (notes.length === 0) return lines.join('\n');

  lines.push('');
  lines.push(
    '[runner — automatic, not from the user] An earlier attempt at this exact task did not '
    + `verify. You are starting over with a clean context and the workspace as that attempt left it. ${notes.join('; ')}. `
    + 'Do not assume the earlier approach was right — check the current state of the files yourself before changing anything.',
  );
  return lines.join('\n');
}

/**
 * ── ⚠️⚠️ RULE 5: SOME FAILURES WILL FAIL IDENTICALLY ON EVERY RUNG ─────────
 *
 * FOUND WHILE DESIGNING THE $0 REACH TEST, before it could cost anything. Point
 * the CLI at an invalid key and rung one fails; rungs two and three then fail
 * the same way, for the same reason, at triple the wall-clock — and the report
 * says "every rung tried and none verified — this one is genuinely hard", which
 * is a lie about a typo in an environment variable.
 *
 * ⭐ THE TEST: would a fresh context change the answer? An unusable key, an
 * exhausted balance, a model id that does not exist and a workspace we cannot
 * write to are all NO. They are conditions of the machine, not of the task, and
 * the honest move is to stop and name the condition.
 *
 * ⚠️ DELIBERATELY NARROW. Anything not on this list escalates, because the
 * expensive direction here is a false stop: refusing to try harder on a task
 * that a second attempt would have solved is the exact capability this module
 * exists to add.
 */
export const BLOCKING_PATTERNS = Object.freeze([
  [/\b401\b|invalid api key|no api key|OPENROUTER_API_KEY/i, 'the API key is missing or not accepted'],
  [/\b402\b|balance is exhausted|cannot pay/i, 'the account cannot pay for the call'],
  [/\b404\b.*model|does not serve that model/i, 'the configured model does not exist'],
  [/EACCES|EROFS|read-only file system/i, 'the workspace cannot be written to'],
]);

/**
 * If this outcome failed for a reason the next rung would hit identically,
 * return why. Otherwise null.
 * @param {object|null} outcome
 * @returns {string|null}
 */
export function blockedBy(outcome) {
  const text = String(outcome?.error ?? '');
  if (text === '') return null;
  for (const [pattern, why] of BLOCKING_PATTERNS) {
    if (pattern.test(text)) return why;
  }
  return null;
}

/**
 * ── ⚠️⚠️ "THE PROCESS FAILED" AND "TRY HARDER" ARE DIFFERENT QUESTIONS ─────
 *
 * FOUND BY RUNNING IT, 2026-08-12, for $0.0016 — after the unit tests were
 * green. The first wiring used `!sessionFailed(outcome)` as the definition of
 * success, reasoning that one verdict is safer than two. It is not, because
 * `sessionFailed` is deliberately LENIENT: `turn.mjs:3202` only fails a run
 * whose verification actually RAN and lost, so a session that wrote two files,
 * ran out of money and verified nothing returns `false` — not failed. Correct
 * for an exit code. Fatal for a ladder, which read it as "it worked" and never
 * climbed. The one run engineered to force an escalation produced none.
 *
 * ⭐ THE MISSING IDEA: a run can end three ways, not two — verified, wrong, or
 * OUT OF ROAD. Out of road is budget, rounds, or a stuck loop, and it is the
 * exact condition escalation exists for: nothing is known to be wrong, the run
 * simply never got to find out.
 *
 * ⚠️ AND THE OPPOSITE ERROR IS THE MORE EXPENSIVE ONE. A model that finishes on
 * its own terms with no command to run — "write me a README" — has done correct
 * work, and a strict `stoppedBecause === 'verified'` test would escalate it
 * three times and charge for two attempts nobody needed. That is the
 * check-that-fails-correct-work failure this repo has paid for four times. So
 * this list is the three ways a run gets CUT OFF, and nothing else.
 *
 * ⚠️⚠️ AND THE VALUES ARE THE REAL ONES, WHICH COST A SECOND $0.0018 RUN TO
 * LEARN. The first version of this list was `['budget','rounds','stuck',
 * 'max-rounds']` — typed from memory, and THREE of the four do not exist.
 * `turn.mjs` sets exactly `round-cap`, `model-error`, `no-tool-calls`, `stuck`,
 * `verified`, and routes a budget stop through `budget.mjs`'s own reasons
 * (`too-small` · `would-exceed` · `limit-reached`). So the ladder read
 * `stoppedBecause: 'would-exceed'`, found it in no list, and concluded the run
 * had finished happily — the same feature disabled twice, by two different
 * invented constants.
 *
 * ⭐ THE FIX IS STRUCTURAL, NOT A LONGER LIST: the money half is imported from
 * `BUDGET_REASONS`, so it cannot drift, and `escalate.test.mjs` asserts every
 * remaining value against the ones `turn.mjs` actually assigns. A constant that
 * names another module's strings has to be checked against that module, or it
 * is a guess with a comment on it.
 */
export const OUT_OF_ROAD = Object.freeze([
  // Cut off by the loop's own wall.
  'round-cap',
  // Cut off by `stuck.mjs` under --until-done: circling, and the nudge failed.
  'stuck',
  // Cut off by money. These three are `BUDGET_REASONS` minus the two that never
  // stop anything ('ok', 'no-budget-set') — the same split `turn.mjs` makes.
  ...BUDGET_REASONS.filter((r) => r !== 'ok' && r !== 'no-budget-set'),
]);

/**
 * True when the run was cut off rather than finished — the case where trying
 * again with more room is the correct response.
 * @param {object|null} outcome
 */
export function outOfRoad(outcome) {
  return OUT_OF_ROAD.includes(String(outcome?.stoppedBecause ?? ''));
}

/** The dollars an outcome reports having spent. Absent is 0, never invented. */
function costOf(outcome) {
  const c = outcome?.usage?.cost;
  return Number.isFinite(c) && c > 0 ? c : 0;
}

/**
 * ⚠️ "DID IT WORK" IS THE CALLER'S QUESTION, NOT OURS. The default is
 * deliberately strict — a session that stopped for any reason other than a
 * verified check is NOT verified — because the expensive mistake in this
 * package has always been a proxy for "done" that stopped being one.
 */
export function defaultVerified(outcome) {
  if (!outcome || outcome.ok !== true) return false;
  if (outcome.acceptance && outcome.acceptance.passed !== true) return false;
  return outcome.stoppedBecause === 'verified';
}

/**
 * Run the ladder.
 *
 * Every collaborator is injected so the whole thing is testable for $0.00 —
 * the rule this repo learned the hard way, that a test which only passes on a
 * configured machine is a test that gets deleted the first week it fires.
 *
 * @param {object} opts
 * @param {string} opts.root                  workspace root
 * @param {string} opts.task                  the task, verbatim as the user typed it
 * @param {object} opts.budget                a `createBudget()` instance
 * @param {(ctx: {root: string, task: string, tier: string, label: string, attempt: number}) => Promise<object>} opts.runOne
 * @param {(outcome: object) => boolean} [opts.verified]
 * @param {number} [opts.attempts]            attempts for the best-of rung
 * @param {string} [opts.maxTier]
 * @param {(ev: object) => void} [opts.onEvent]
 * @param {Function} [opts.bestOf]            injectable `runBestOf`
 * @param {Function} [opts.pool]              injectable concurrency pool
 */
export async function escalate({
  root,
  task,
  budget,
  runOne,
  verified = defaultVerified,
  attempts = DEFAULT_ATTEMPTS,
  maxTier = 'best-of',
  onEvent = () => {},
  bestOf = runBestOf,
  pool,
  /** The model the run is already using — tier 0, and the only one unless tiers are configured. */
  baseModel = null,
  env = process.env,
}) {
  if (typeof runOne !== 'function') {
    throw new TypeError('escalate: runOne must be a function — it is the only thing that does any work');
  }
  if (TIERS.indexOf(maxTier) === -1) {
    throw new RangeError(`escalate: unknown maxTier ${JSON.stringify(maxTier)} — expected one of ${TIERS.join(', ')}`);
  }

  /**
   * ⚠️ READ OFF THE BUDGET ITSELF, never passed in separately — two numbers
   * meaning "the limit" is how they end up disagreeing. `null` (no `--budget`)
   * yields an empty allocation and every rung runs uncapped, which is exactly
   * what a user who set no ceiling asked for.
   */
  const limitUsd = budget?.canContinue?.()?.limitUsd ?? null;
  const share = limitUsd === null ? {} : allocate(limitUsd, { maxTier, attempts });

  /** @type {Array<{tier: string, verified: boolean, costUsd: number, why: string}>} */
  const rungs = [];
  /** @type {Array<{tier: string, why: string, projectedUsd: number, remainingUsd: number}>} */
  const skipped = [];

  let tier = 'solo';
  let last = null;
  let lastAttemptUsd = 0;
  let spentUsd = 0;
  let lastModel = null;

  for (;;) {
    const label = `${tier} attempt ${rungs.length + 1}`;

    /**
     * ⭐ THE RUNG MAY ALSO GET A STRONGER MODEL. Off unless `ACUVO_MODEL_TIERS`
     * is set, in which case every tier is the same model and nothing changes —
     * see `model-tier.mjs` for why the default has to be inert.
     */
    const plan = planRung(TIERS.indexOf(tier), { baseModel, env, previousModel: lastModel });
    const rungModel = plan.model;
    if (plan.changed) {
      const line = describeSwitch(lastModel, rungModel);
      if (line) onEvent({ type: 'escalate-model', from: lastModel, to: rungModel, note: line });
      /**
       * ⚠️⚠️ A CHANGED MODEL INVALIDATES THE COST PROJECTION. `projectTierCost`
       * prices the next rung from what the LAST one measurably cost, which is
       * only sound while the model is constant. Rather than guess at a price
       * table this package does not have, the measured basis is DISCARDED so
       * the projection falls back to its floor and the budget check below stays
       * conservative instead of confidently wrong.
       */
      lastAttemptUsd = 0;
    }
    lastModel = rungModel;

    onEvent({ type: 'escalate-start', tier, attempt: rungs.length + 1, label, model: rungModel });

    let outcome = null;
    let crashed = null;

    try {
      if (tier === 'best-of') {
        const result = await bestOf({
          root,
          attempts,
          pool,
          onEvent,
          failed: (o) => !verified(o),
          runOne: ({ root: dir, label: attemptLabel }) => runOne({
            root: dir,
            task,
            tier,
            label: attemptLabel,
            attempt: rungs.length + 1,
            /**
             * ⚠️ THE RUNG'S SHARE DIVIDED BY N, because this rung runs N of
             * them. Handing each parallel attempt the whole rung budget is how
             * `--budget 2.00` quietly becomes $6.
             */
            budgetUsd: share[tier] === undefined ? undefined : share[tier] / Math.max(1, attempts),
            model: rungModel,
          }),
        });
        /**
         * ⚠️ `runBestOf` REPORTS ITS OWN REFUSAL AS `ok:false` — the workspace
         * being too large to copy three times is not a failed attempt, it is a
         * rung that could not be entered. Treating it as a failure would let
         * the ladder claim it tried something it never started.
         */
        if (result?.ok !== true) {
          skipped.push({
            tier, why: String(result?.error ?? 'best-of could not start'), projectedUsd: 0, remainingUsd: 0,
          });
          onEvent({ type: 'escalate-skipped', tier, why: String(result?.error ?? 'best-of could not start') });
          break;
        }
        outcome = result.winner;
        spentUsd += result.totalCost ?? 0;
        lastAttemptUsd = (result.totalCost ?? 0) / Math.max(1, result.attempts ?? 1);
        onEvent({ type: 'escalate-best-of', tier, ...result });
      } else {
        const briefed = tier === 'fresh' ? freshBriefing(task, last) : task;
        outcome = await runOne({
          root, task: briefed, tier, label, attempt: rungs.length + 1, budgetUsd: share[tier],
          model: rungModel,
        });
        const c = costOf(outcome);
        spentUsd += c;
        lastAttemptUsd = c;
      }
    } catch (e) {
      crashed = e?.message ?? String(e);
    }

    /**
     * ── ⚠️ RULE 4: A CRASH IS NOT A RUNG ────────────────────────────────────
     *
     * A thrown error is the transport, the process, or us — never evidence that
     * the APPROACH was wrong. Consuming an escalation for it means a flaky
     * connection buys the expensive rung, which is the precise opposite of
     * spending more on hard problems. It ends the ladder honestly instead.
     */
    if (crashed !== null) {
      onEvent({ type: 'escalate-crashed', tier, error: crashed });
      return {
        ok: false,
        stopped: 'crashed',
        error: crashed,
        tier,
        outcome: last,
        rungs,
        skipped,
        spentUsd,
      };
    }

    const passed = verified(outcome);
    const costThisRung = tier === 'best-of' ? spentUsd - rungs.reduce((s, r) => s + r.costUsd, 0) : lastAttemptUsd;
    rungs.push({
      tier,
      verified: passed,
      costUsd: costThisRung,
      why: passed ? 'verified' : (outcome?.stoppedBecause ?? outcome?.error ?? 'did not verify'),
    });
    last = {
      reason: outcome?.stoppedBecause ?? null,
      failure: outcome?.acceptance?.failing?.[0]?.command ?? null,
      outcome,
    };

    if (passed) {
      onEvent({ type: 'escalate-verified', tier, attempts: rungs.length, spentUsd });
      return { ok: true, stopped: 'verified', tier, outcome, rungs, skipped, spentUsd };
    }

    /**
     * ⚠️ RULE 5, CHECKED BEFORE THE BUDGET CHECK ON PURPOSE. A blocked run has
     * usually spent almost nothing, so the budget would happily wave the next
     * rung through — and the two remaining attempts would fail identically. The
     * cheaper stop has to win.
     */
    const blocked = blockedBy(outcome);
    if (blocked !== null) {
      onEvent({ type: 'escalate-blocked', tier, why: blocked });
      return { ok: false, stopped: 'blocked', why: blocked, tier, outcome, rungs, skipped, spentUsd };
    }

    const up = nextTier(tier, { maxTier });
    if (up === null) {
      onEvent({ type: 'escalate-exhausted', tier, spentUsd });
      return { ok: false, stopped: 'exhausted', tier, outcome, rungs, skipped, spentUsd };
    }

    /**
     * ── ⚠️ RULES 1 + 2 + 3, THE WHOLE POINT OF THE MODULE ───────────────────
     *
     * The projection is derived from what the last rung MEASURABLY cost, and
     * the rung is entered only if the remaining budget covers it. When it does
     * not, that is recorded as a SKIP with the two numbers that explain it —
     * so the caller can tell "this is hard" from "this needed another dollar".
     */
    const verdict = budget?.canContinue?.() ?? { ok: true, remainingUsd: Infinity };
    const remainingUsd = Number.isFinite(verdict.remainingUsd) ? verdict.remainingUsd : Infinity;
    const projectedUsd = projectTierCost(up, { lastAttemptUsd, attempts });

    if (projectedUsd > remainingUsd) {
      const why = `the ${up} rung projects at ~${formatUsd(projectedUsd)} and only ${formatUsd(remainingUsd)} of the budget is left`;
      skipped.push({ tier: up, why, projectedUsd, remainingUsd });
      onEvent({ type: 'escalate-skipped', tier: up, why, projectedUsd, remainingUsd });
      return { ok: false, stopped: 'budget', tier, outcome, rungs, skipped, spentUsd };
    }

    onEvent({ type: 'escalate-up', from: tier, to: up, projectedUsd, remainingUsd });
    tier = up;
  }

  return { ok: false, stopped: 'exhausted', tier, outcome: last?.outcome ?? null, rungs, skipped, spentUsd };
}

/**
 * Render the ladder for a human. Rule 3 lives here too: a skipped rung must be
 * as visible as an attempted one, or the report quietly becomes a lie of
 * omission at exactly the moment the operator is deciding whether to pay more.
 */
export function formatEscalation(result) {
  if (!result) return '';
  const lines = [];

  for (const r of result.rungs ?? []) {
    const mark = r.verified ? '✔' : '✖';
    lines.push(`  ${mark} ${r.tier.padEnd(8)} ${formatUsd(r.costUsd).padStart(9)}  ${r.why}`);
  }
  for (const s of result.skipped ?? []) {
    lines.push(`  · ${s.tier.padEnd(8)} ${'skipped'.padStart(9)}  ${s.why}`);
  }

  /**
   * ⚠️ THE HEADER SAYS THESE ARE SLICES. Each rung ran under its own share of
   * `--budget`, so a reader comparing a rung's figure to the ceiling they typed
   * would otherwise conclude the run barely spent anything.
   */
  if (lines.length > 0) lines.unshift('  the ladder (each rung ran on its own slice of --budget):');

  const total = formatUsd(result.spentUsd ?? 0);
  switch (result.stopped) {
    case 'verified':
      lines.push(`  → verified at the ${result.tier} rung for ${total}.`);
      break;
    case 'budget':
      /**
       * ⚠️ THIS SENTENCE IS THE PRODUCT. It is the only place a run says "I did
       * not fail, I ran out of money, and here is what the next dollar buys".
       */
      lines.push(`  → stopped on budget, not on capability: ${total} spent and the next rung was unaffordable.`);
      break;
    case 'exhausted':
      lines.push(`  → every rung tried and none verified — ${total} spent. This one is genuinely hard.`);
      break;
    case 'crashed':
      lines.push(`  → the ladder stopped on an error, which is not a verdict on the work: ${result.error}`);
      break;
    case 'blocked':
      /**
       * ⚠️ NAMES THE MACHINE, NOT THE TASK. Trying twice more would have cost
       * three times the wall-clock to reprint this same sentence.
       */
      lines.push(`  → did not escalate: ${result.why}. Every rung would fail the same way, so trying harder would only cost more.`);
      break;
    default:
      break;
  }
  return lines.join('\n');
}
