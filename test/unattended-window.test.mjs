/**
 * ── ⭐ THE TWO FLAGS THAT MAKE AN UNATTENDED RUN SAFE TO SCHEDULE ────────────
 *
 * A pre-run dollar ceiling is this package's one structural differentiator, and
 * pointing a cron at it quietly voids the claim: every fire is a new run with a
 * FRESH per-run ceiling, so the number somebody chose stops being a total and
 * becomes a rate. $0.02 an hour is $14 a month, and nobody typed $14.
 *
 * `--budget-window` makes the fleet ceiling a total again. `--unattended` makes
 * the outcome legible to a log nobody is reading in real time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFleetGate } from '../lib/fleet-budget.mjs';
import { FLEET_STOP_REASONS, BUDGET_REASONS } from '../lib/budget.mjs';
import { parseArgv } from '../lib/cli-args.mjs';

const line = (usd, at) => `${JSON.stringify({ at, run: { costUsd: usd, ok: true } })}\n`;
/** $0.05 a day on three consecutive days. */
const threeDays = () => [{
  name: '2026-08-13.jsonl',
  text: line(0.05, '2026-08-11T04:00:00.000Z') + line(0.05, '2026-08-12T04:00:00.000Z') + line(0.05, '2026-08-13T04:00:00.000Z'),
}];
const now = () => new Date('2026-08-13T12:00:00.000Z');

test('⭐⭐ the window changes the verdict — today allows, a week refuses', () => {
  const today = createFleetGate('/ws', { fleetLimitUsd: 0.10, now, readImpl: threeDays });
  const week = createFleetGate('/ws', {
    fleetLimitUsd: 0.10, since: new Date('2026-08-06T00:00:00.000Z'), now, readImpl: threeDays,
  });

  assert.equal(today({ projectedUsd: 0.01 }).ok, true, 'today sees $0.05 of the $0.10 — it must allow');
  assert.equal(week({ projectedUsd: 0.01 }).ok, false, 'a week sees $0.15 against a $0.10 ceiling — a cron would have kept going forever');
});

test('⚠️ the default is still today, so nobody who did not ask is affected', () => {
  const gate = createFleetGate('/ws', { fleetLimitUsd: 0.10, now, readImpl: threeDays });
  assert.equal(gate({ projectedUsd: 0.01 }).ok, true);
});

test('⭐ --budget-window parses periods and dates, and refuses nonsense', () => {
  assert.ok(parseArgv(['--budget-window', '7d', 'x']).options.budgetWindow instanceof Date);
  assert.ok(parseArgv(['--budget-window', '24h', 'x']).options.budgetWindow instanceof Date);
  assert.ok(parseArgv(['--budget-window', '2026-08-01', 'x']).options.budgetWindow instanceof Date);

  const bad = parseArgv(['--budget-window', 'soonish', 'x']);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a period/);
});

test('⭐ --unattended parses, and defaults off', () => {
  assert.equal(parseArgv(['--unattended', 'x']).options.unattended, true);
  assert.equal(parseArgv(['x']).options.unattended, false);
});

test('⚠️ the fleet stop reasons are shared, not retyped', () => {
  /**
   * `bin/acuvo.mjs` decides EXIT_SKIPPED by testing `stoppedBecause` against
   * this list. Two hand-maintained copies of the same strings is how a stop
   * ends up named in one place and never matched in the other.
   */
  assert.ok(FLEET_STOP_REASONS.length >= 2);
  for (const r of FLEET_STOP_REASONS) {
    assert.ok(BUDGET_REASONS.includes(r), `${r} is a fleet stop that canContinue can never report`);
  }
});
