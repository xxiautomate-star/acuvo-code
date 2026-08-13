/**
 * ── ⭐ THE FLEET CEILING — "CHEAP" HAS TO BE TRUE IN AGGREGATE, NOT PER WORKER ──
 *
 * The product direction is seven terminals working one repository at once. Every
 * piece of that is measured and working except one thing nobody had checked:
 * `lib/budget.mjs` caps a RUN. Seven runs multiply the spend by seven, so the
 * ceiling a person actually chose ($0.02) silently becomes a different number
 * ($0.14) as soon as they do the thing the product tells them to do.
 *
 * ⚠️ That is the same defect as the per-turn-vs-per-run bug fixed on 2026-08-12,
 * scaled by the fleet: a limit enforced at the wrong granularity is not a limit,
 * it is a unit of measurement. And the governor — *tell me the price before it
 * runs and stop at the number I gave you* — is the one differentiator a public
 * company's finance function structurally cannot copy. A fleet is exactly where
 * it has to hold, or it was never the claim we said it was.
 *
 * ── ⭐⭐ THERE IS NO NEW LEDGER HERE, AND THAT IS THE POINT ───────────────────
 *
 * The obvious build is a shared `.acuvo/fleet-budget.json` with a lock around
 * it: a new file, a new write path, a new race between seven processes, and a
 * new way to be wrong about money. None of that is necessary, because the
 * ledger already exists and every run already writes to it:
 *
 *     .acuvo/audit/YYYY-MM-DD.jsonl   ← appended by EVERY run in this workspace
 *                                       with `run.costUsd`, one JSON line each
 *
 * Seven terminals in one repository are already writing to one audit directory,
 * in day files, with O_APPEND. So the fleet's spend is a QUESTION asked of data
 * that is already on disk, not a second book to keep in sync with the first.
 * `spend.mjs` already sums it — this module only decides what the sum means.
 *
 * ⭐ And the day file makes the window obvious: the fleet ceiling is a spend cap
 * for this workspace for today, across every terminal. That is the number
 * somebody needs before they dare leave seven workers running overnight, and it
 * composes with the per-run ceiling rather than replacing it — one bounds the
 * blast radius of a single mistake, the other bounds the blast radius of the
 * whole fleet.
 *
 * ── ⚠️ WHAT THIS CANNOT SEE, STATED PLAINLY RATHER THAN GLOSSED ─────────────
 *
 * A run appends its audit record when it FINISHES. So at any moment the log
 * knows what the fleet has SPENT, not what it is CURRENTLY spending: six other
 * workers may each be mid-run with money already committed and nothing written
 * down yet.
 *
 * The overshoot that allows is bounded and worth naming, because a bound you can
 * state is a different thing from a hole:
 *
 *     worst case  =  fleetLimit  +  (other live workers × their own per-run ceiling)
 *
 * With the default $0.02 per-run ceiling and seven terminals that is at most
 * about twelve cents past the line. ⚠️ It is NOT bounded for a worker running
 * `--budget none`, which is precisely why `fleetVerdict` refuses to report a
 * comfortable number when it knows its inputs are incomplete: see `unknown` and
 * `damaged` below.
 */

import { readAuditFiles, summariseSpend } from './spend.mjs';
import { formatUsd, USD_EPSILON, FLEET_STOP_REASONS } from './budget.mjs';

/**
 * Reasons a fleet check can come back.
 *
 * ⚠️ THE STOPS ARE SPREAD IN FROM `budget.mjs`, NOT RETYPED. They have to
 * appear in `BUDGET_REASONS` too — that is how `escalate.mjs` learns a fleet
 * stop is a budget stop — and two hand-maintained copies of the same strings is
 * how a reason ends up named in one place and never emitted from the other.
 * The import direction is fleet → budget only; budget never imports this file.
 */
export const FLEET_REASONS = ['ok', 'no-fleet-budget', ...FLEET_STOP_REASONS];

/**
 * The UTC start of the day a moment falls in — the same boundary `dayFileName`
 * uses, so the window and the files it reads can never disagree.
 *
 * ⚠️ UTC, not local. The audit files are named in UTC; a local-midnight window
 * would ask for "today" and be handed two half-days for anyone east or west of
 * Greenwich, twice reporting a fleet total that is not the one the day file
 * holds. Being consistently wrong about which 24 hours is far better than being
 * inconsistently right.
 */
export function startOfUtcDay(now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * What has this workspace spent since `since`, across every terminal?
 *
 * Thin by design: the reading and the summing already exist and are already
 * tested. `readImpl` is injected for the same reason every other disk touch in
 * this package is — a money decision must be testable without a filesystem.
 *
 * @param {string} root
 * @param {{ since?: Date|null, readImpl?: (root: string) => {name: string, text: string}[] }} [opts]
 */
export function readFleetSpend(root, { since = null, readImpl = readAuditFiles } = {}) {
  let files;
  try {
    files = readImpl(root);
  } catch (err) {
    /**
     * ⚠️ AN UNREADABLE LEDGER IS NOT A ZERO. Returning 0 here would make an
     * unreadable audit directory look like a fresh, unspent day and hand the
     * fleet its entire ceiling again — the failure mode where the safety
     * feature pays for the accident. The verdict below refuses instead.
     */
    return { ok: false, error: `could not read the fleet ledger: ${err?.message ?? err}`, totalUsd: 0, runs: 0, unknown: 0, damaged: 0 };
  }
  const summary = summariseSpend(files, { since });
  return {
    ok: true,
    totalUsd: summary.totalUsd,
    runs: summary.runs,
    /** Runs whose cost is genuinely unknown — never counted as zero. */
    unknown: summary.unknown,
    /** Lines that would not parse. Seven appenders can interleave; say so. */
    damaged: summary.damaged,
  };
}

/**
 * Does the fleet have room for what this run is about to do?
 *
 * Pure. Everything that touches the disk happened in `readFleetSpend`, so every
 * branch below is reachable from a test with three numbers and no temp
 * directory.
 *
 * @param {object} args
 * @param {number|null} args.fleetLimitUsd  the ceiling across all terminals. null = off.
 * @param {object} args.fleetSpend          what `readFleetSpend` returned.
 * @param {number} args.thisRunUsd          what THIS run has spent so far (not yet in the log).
 * @param {number} args.projectedUsd        what the next round is projected to cost.
 */
export function fleetVerdict({ fleetLimitUsd = null, fleetSpend, thisRunUsd = 0, projectedUsd = 0 } = {}) {
  if (fleetLimitUsd === null || fleetLimitUsd === undefined) {
    return { ok: true, reason: 'no-fleet-budget', message: '', fleetSpentUsd: 0, fleetRemainingUsd: Infinity };
  }

  if (!fleetSpend || fleetSpend.ok !== true) {
    return {
      ok: false,
      reason: 'fleet-limit-reached',
      message:
        `the fleet ceiling of ${formatUsd(fleetLimitUsd)} cannot be enforced because the shared ledger could not be read `
        + `(${fleetSpend?.error ?? 'no reason given'}). Refusing rather than assuming nothing has been spent — `
        + 'fix the workspace .acuvo/audit directory, or drop --fleet-budget to run without a fleet ceiling.',
      fleetSpentUsd: 0,
      fleetRemainingUsd: 0,
    };
  }

  /**
   * ⚠️ THIS RUN'S OWN SPEND IS ADDED SEPARATELY, AND IT MUST BE. Its audit
   * record is not written until the run ends, so it is absent from the log by
   * construction — leaving it out would let a single long run spend the fleet's
   * whole ceiling while the ledger insisted the fleet had spent nothing.
   */
  const fleetSpentUsd = fleetSpend.totalUsd + thisRunUsd;
  const fleetRemainingUsd = fleetLimitUsd - fleetSpentUsd;

  /**
   * ⭐ THE HONESTY CLAUSE. `unknown` runs had no reported price and were never
   * summed as zero; `damaged` lines could not be parsed at all. Either means the
   * true total is HIGHER than the one being enforced, so the number gets a floor
   * marker rather than being presented as exact. A budget that quietly
   * undercounts is a budget that overspends.
   */
  const incomplete = fleetSpend.unknown > 0 || fleetSpend.damaged > 0;
  const floorNote = incomplete
    ? ` (at least — ${fleetSpend.unknown} run${fleetSpend.unknown === 1 ? '' : 's'} reported no price`
      + `${fleetSpend.damaged > 0 ? ` and ${fleetSpend.damaged} ledger line${fleetSpend.damaged === 1 ? '' : 's'} could not be read` : ''}, `
      + 'so the real total is higher than this)'
    : '';

  /** Every refusal names the flag that lifts it. */
  const wayOut = ' Raise it with --fleet-budget, or drop the flag to bound each terminal only.';

  if (fleetRemainingUsd <= USD_EPSILON) {
    return {
      ok: false,
      reason: 'fleet-limit-reached',
      message:
        `the fleet has spent ${formatUsd(fleetSpentUsd)}${floorNote} of its ${formatUsd(fleetLimitUsd)} ceiling `
        + `across ${fleetSpend.runs} run${fleetSpend.runs === 1 ? '' : 's'} in this workspace today. `
        + `This terminal has spent ${formatUsd(thisRunUsd)} of that.${wayOut}`,
      fleetSpentUsd,
      fleetRemainingUsd: Math.max(0, fleetRemainingUsd),
      incomplete,
    };
  }

  if (fleetSpentUsd + projectedUsd > fleetLimitUsd + USD_EPSILON) {
    return {
      ok: false,
      reason: 'fleet-would-exceed',
      message:
        `stopping on the fleet ceiling: ${formatUsd(fleetSpentUsd)}${floorNote} of ${formatUsd(fleetLimitUsd)} is spent `
        + `across every terminal in this workspace today, and the next round is projected at ~${formatUsd(projectedUsd)}, `
        + `which would cross the line.${wayOut}`,
      fleetSpentUsd,
      fleetRemainingUsd,
      incomplete,
    };
  }

  return {
    ok: true,
    reason: 'ok',
    message: `${formatUsd(fleetRemainingUsd)} left of the ${formatUsd(fleetLimitUsd)} fleet ceiling${floorNote}`,
    fleetSpentUsd,
    fleetRemainingUsd,
    incomplete,
  };
}

/**
 * The one line a caller needs: turn a `--fleet-budget` value into the gate
 * `createBudget` accepts, or `null` when the flag was never given.
 *
 * ⭐ RETURNING `null` WHEN OFF IS THE WHOLE ERGONOMIC. `createBudget` guards on
 * `if (fleetGate)`, so "no fleet ceiling" costs exactly one falsy check and not
 * a single disk read — the feature is invisible to everyone who has not asked
 * for it, which is the bar for adding anything to a path that spends money.
 *
 * ⚠️ THE LEDGER IS RE-READ ON EVERY CALL, DELIBERATELY. Six other terminals
 * finish work while this one is thinking; a total captured once at start-up
 * would be stale by the second round and would drift further the longer and
 * more expensive the run got — worst exactly when it matters most. A directory
 * read per round is nothing beside the model call it is gating.
 *
 * @param {string} root
 * @param {{ fleetLimitUsd?: number|null, now?: () => Date, readImpl?: Function }} [opts]
 */
export function createFleetGate(root, { fleetLimitUsd = null, now = () => new Date(), readImpl } = {}) {
  if (fleetLimitUsd === null || fleetLimitUsd === undefined) return null;
  return ({ projectedUsd = 0, thisRunUsd = 0 } = {}) => fleetVerdict({
    fleetLimitUsd,
    fleetSpend: readFleetSpend(root, { since: startOfUtcDay(now()), readImpl }),
    thisRunUsd,
    projectedUsd,
  });
}
