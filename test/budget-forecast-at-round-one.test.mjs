/**
 * ── ⚠️⚠️ THE CEILING WAS DISCOVERED AT ROUND 6 AND IT IS KNOWABLE AT ROUND 1 ──
 *
 * `budget.canContinue()` only ever speaks when it is REFUSING. On the default
 * `DEFAULT_BUDGET_USD = 0.02` ceiling that first happens around round 6 — five
 * rounds of money already spent, the work half-done, and the remedy it names
 * (`--budget 0.50`) only usable by throwing the run away and starting again.
 *
 * ⭐ ONE PRICED ROUND IS ALL THE ARITHMETIC NEEDS. After round 1, `projectNext()`
 * is running on measured data rather than its seed, and `maxRounds` is known.
 * Multiplying the two is the entire forecast; every part of it already existed
 * and nobody was asking.
 *
 * ── ⚠️⚠️ WHAT THIS FILE IS MOSTLY DEFENDING: IT MUST NOT BECOME A STOP ───────
 *
 * The tempting shape is to hoist the `would-exceed` refusal to round 1. That is
 * a check that fails correct work — the failure this repo has paid for four
 * times in one day. `maxRounds` is a CEILING, not a plan: the loop stops itself
 * on `verified` and `no-tool-calls` long before it, and nothing in the shipped
 * bench has ever consumed its round budget. Refusing a run that would have
 * finished in three rounds, because it could not have afforded sixteen, breaks
 * the common case to warn about the rare one.
 *
 * ⭐ And the number is a FLOOR, which is a second reason it cannot be a stop.
 * `budget.mjs`'s header establishes that cost per round GROWS, so a flat
 * projection under-estimates. Under-estimating is the safe direction for a
 * caution and the unsafe one for a refusal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  forecastRun, createBudget, DEFAULT_BUDGET_USD, chargeGpu, resetSpendMeter,
} from '../lib/budget.mjs';
import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐ THE ARITHMETIC — pure, so it is provable for $0.00
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ a run that cannot afford its rounds is told at round 1, with the round it will stop on', () => {
  /**
   * The measured shape of the defect: the default ceiling, a round that cost
   * half a cent, and sixteen rounds of road. $0.02 buys about three more.
   */
  const f = forecastRun({
    remainingUsd: 0.015,
    projectedUsd: 0.005,
    limitUsd: DEFAULT_BUDGET_USD,
    spentUsd: 0.005,
    roundsUsed: 1,
    maxRounds: 16,
    limitIsDefault: true,
  });

  assert.equal(f.ok, false);
  assert.equal(f.reason, 'will-run-out');
  assert.equal(f.roundsAffordable, 3, '$0.015 left at $0.005 a round is three rounds, not two and not four');
  assert.equal(f.roundsRemaining, 15);
  /**
   * ⚠️ THE ROUND NAMED IS THE ONE THAT IS REFUSED, not the last one that works.
   * Naming round 4 would send the user looking for a stop message on a round
   * that succeeded.
   */
  assert.equal(f.stopsAtRound, 5, 'round 1 is spent, 2-4 are affordable, so 5 is the one that is refused');
  assert.match(f.message, /round 5 of 16/);
  // ⭐ A refusal that does not say what to type is just an obstacle — and this
  // ceiling is the DEFAULT, so the sentence has to admit the user never chose it.
  assert.match(f.message, /--budget/, 'the forecast must name the way out, like every other refusal here');
  assert.match(f.message, /default ceiling/, 'a number the user never chose must say so');
});

test('⚠️ the projected total is a FLOOR and the sentence says so — rounds get dearer', () => {
  const f = forecastRun({
    remainingUsd: 0.015, projectedUsd: 0.005, limitUsd: 0.02,
    spentUsd: 0.005, roundsUsed: 1, maxRounds: 16,
  });
  /**
   * spent + projection x rounds-remaining. Flat, deliberately: the linear
   * extrapolation in `projectNext` describes ONE step, and compounding it over
   * fifteen would be inventing a curve nobody measured.
   */
  assert.ok(Math.abs(f.projectedTotalUsd - (0.005 + 0.005 * 15)) < 1e-9,
    `projected ${f.projectedTotalUsd}, expected the flat 0.08`);
  assert.match(f.message, /FLOOR/, 'an under-estimate presented as a total is the dishonesty this repo hunts');
  assert.match(f.message, /finish sooner/i, 'and it must not read as a verdict — most runs never reach the wall');
});

test('⭐ a run that comfortably fits says so and raises nothing', () => {
  const f = forecastRun({
    remainingUsd: 0.5, projectedUsd: 0.001, limitUsd: 0.6,
    spentUsd: 0.1, roundsUsed: 1, maxRounds: 8,
  });
  assert.equal(f.ok, true);
  assert.equal(f.reason, 'fits');
  assert.equal(f.stopsAtRound, null, 'a run that fits has no stopping round to name');
});

test('⚠️ the boundary is not off by one — exactly enough rounds still FITS', () => {
  /**
   * 7 rounds remain and $0.007 is left at $0.001 a round. That is exactly
   * enough, and a forecast that warned here would be a check that fails correct
   * work on the most common shape there is: a run sized to its budget.
   */
  const exact = forecastRun({
    remainingUsd: 0.007, projectedUsd: 0.001, limitUsd: 0.01,
    spentUsd: 0.003, roundsUsed: 1, maxRounds: 8,
  });
  assert.equal(exact.ok, true, `7 rounds at $0.001 against $0.007 must fit — got ${exact.message}`);

  const oneShort = forecastRun({
    remainingUsd: 0.006, projectedUsd: 0.001, limitUsd: 0.01,
    spentUsd: 0.004, roundsUsed: 1, maxRounds: 8,
  });
  assert.equal(oneShort.ok, false, 'one round short must warn');
  assert.equal(oneShort.roundsAffordable, 6);
});

test('⚠️ no ceiling means no forecast — null is unlimited everywhere in this file', () => {
  const f = forecastRun({ remainingUsd: Infinity, projectedUsd: 0.01, limitUsd: null, roundsUsed: 1, maxRounds: 64 });
  assert.equal(f.ok, true);
  assert.equal(f.reason, 'no-budget-set');
});

test('⚠️ a genuinely free round does not divide by zero, and is not called a failure', () => {
  /**
   * `budget.mjs` believes a reported $0.00 on purpose — free-tier and fully
   * cached completions really do cost nothing. The forecast has to survive it,
   * and the honest answer is that no total can be projected yet.
   */
  for (const projectedUsd of [0, -1, NaN, null, undefined]) {
    const f = forecastRun({ remainingUsd: 0.02, projectedUsd, limitUsd: 0.02, roundsUsed: 1, maxRounds: 16 });
    assert.equal(f.ok, true, `a projection of ${projectedUsd} must not be reported as running out`);
    assert.ok(Number.isFinite(f.projectedTotalUsd), 'and it must never hand back NaN dollars');
  }
});

test('⚠️ with no rounds left there is nothing to forecast', () => {
  const f = forecastRun({ remainingUsd: 0.0001, projectedUsd: 0.01, limitUsd: 0.02, roundsUsed: 16, maxRounds: 16 });
  assert.equal(f.ok, true, 'a run at its round cap is stopping for a reason that is not money');
  assert.equal(f.roundsRemaining, 0);
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐ THE GOVERNOR'S OWN METHOD — it must read the state the closure holds
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ budget.forecast() uses the REAL projection, not a number the caller invented', () => {
  const budget = createBudget({ limitUsd: DEFAULT_BUDGET_USD, limitIsDefault: true });
  budget.record({ costUsd: 0.005, tokens: 1_000 });

  const f = budget.forecast(16);
  const projected = budget.projectNext().usd;
  assert.equal(f.ok, false);
  assert.ok(Math.abs(f.projectedTotalUsd - (0.005 + projected * 15)) < 1e-9,
    'the forecast must be built from projectNext(), or it is a second pricing model to keep in agreement');
});

test('⚠️⚠️ GPU dollars count — forecasting from the model half alone is the old leak, one level along', () => {
  resetSpendMeter();
  try {
    const budget = createBudget({ limitUsd: 0.5 });
    budget.record({ costUsd: 0.001, tokens: 1_000 });
    const before = budget.forecast(8);
    assert.equal(before.ok, true, 'eight cheap rounds fit inside fifty cents');

    // One cold image render: ~$0.0398, which `budget.mjs` prices from wall time.
    chargeGpu({ verb: 'generate_image', seconds: 10, endpoint: 'images' });
    const after = budget.forecast(8);
    assert.ok(after.projectedTotalUsd > before.projectedTotalUsd,
      'a GPU charge that does not move the forecast is the "unknown priced as free" failure this file exists to refuse');
  } finally {
    resetSpendMeter();
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ REACH — the sentence has to arrive in a REAL run, at round 1, and stop nothing
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ REACH: a real runSession emits the forecast ONCE, at round 1, and does not end the run', async () => {
  /**
   * ⚠️ THE ONLY THING FAKED IS THE MODEL. Everything else is the shipped loop —
   * because "built but unreached" is the defect this package ships most often,
   * and a unit test of `forecastRun` alone would pass with the wiring deleted.
   */
  const root = mkdtempSync(join(tmpdir(), 'acuvo-forecast-reach-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  try {
    let round = 0;
    const model = async () => {
      round += 1;
      return {
        ok: true,
        content: 'still working',
        /**
         * ⚠️ CALIBRATED TO THE DEFAULT, AND IT HAD TO MOVE WITH IT. This was
         * $0.004 against a $0.02 ceiling — "about four rounds of road against
         * eight given", which is what makes a forecast worth emitting. When the
         * default rose to $0.05 the same fixture bought 12.5 rounds of road, so
         * there was nothing to forecast and this test failed against correct
         * code. The RATIO is the fixture, not the number.
         *
         * $0.01 a round against $0.05: five rounds of road, eight given.
         */
        usage: { cost: 0.01, total_tokens: 2_000 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: `r${round}`, name: 'read_file', arguments: { path: 'nope.txt' } }],
      };
    };

    const events = [];
    const outcome = await runSession({
      task: 'do a long job',
      executor: createLocalExecutor(root),
      config: { apiKey: 'k', model: 'm' },
      maxRounds: 8,
      budgetUsd: DEFAULT_BUDGET_USD,
      budgetIsDefault: true,
      callModelImpl: model,
      onEvent: (e) => events.push(e),
    });

    const forecasts = events.filter((e) => e.type === 'budget-forecast');
    assert.equal(forecasts.length, 1, `the forecast fired ${forecasts.length} times — it is said once, or it is noise`);
    assert.equal(forecasts[0].round, 1, 'said at round 1 is the whole point; anywhere later is the thing being fixed');
    assert.match(forecasts[0].message, /round \d+ of 8/);

    /**
     * ⭐⭐ AND IT CHANGED NOTHING. The run carried on past round 1 and ended for
     * a MONEY reason later, exactly as it did before this existed.
     */
    assert.ok(outcome.roundsUsed > 1, `the forecast ended the run at round ${outcome.roundsUsed} — it must only speak`);
    const stops = events.filter((e) => e.type === 'budget-stop');
    assert.equal(stops.length, 1, 'the STOP is still the thing that stops, and it is still exactly one event');
    assert.ok(
      events.findIndex((e) => e.type === 'budget-forecast') < events.findIndex((e) => e.type === 'budget-stop'),
      'the forecast has to arrive BEFORE the stop, or it is not a forecast',
    );
    /**
     * ⚠️ THE PREDICTION HAS TO BE TRUE. A forecast naming a round the run sails
     * past is worse than silence — it teaches the user to ignore it. The floor
     * means the real stop lands at or BEFORE the round named.
     */
    assert.ok(
      outcome.roundsUsed <= forecasts[0].stopsAtRound,
      `forecast said it would stop by round ${forecasts[0].stopsAtRound}; it ran ${outcome.roundsUsed}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐ REACH: a run that fits its ceiling says nothing at all', async () => {
  /**
   * ⚠️ THE OTHER HALF OF "a check that fails correct work". An ordinary cheap
   * run must be byte-for-byte as quiet as it was before this change.
   */
  const root = mkdtempSync(join(tmpdir(), 'acuvo-forecast-quiet-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  try {
    let round = 0;
    const model = async () => {
      round += 1;
      if (round > 1) return { ok: true, content: 'done', usage: { cost: 0.00001 }, finishReason: 'stop', toolCalls: [] };
      return {
        ok: true,
        content: 'looking',
        usage: { cost: 0.00001, total_tokens: 100 },
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'nope.txt' } }],
      };
    };
    const events = [];
    await runSession({
      task: 'a small job',
      executor: createLocalExecutor(root),
      config: { apiKey: 'k', model: 'm' },
      maxRounds: 8,
      budgetUsd: DEFAULT_BUDGET_USD,
      budgetIsDefault: true,
      callModelImpl: model,
      onEvent: (e) => events.push(e),
    });
    assert.equal(events.filter((e) => e.type === 'budget-forecast').length, 0,
      'a run that fits must be exactly as quiet as it was before this feature existed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
