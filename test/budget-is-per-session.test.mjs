/**
 * ── ⚠️⚠️ THE CEILING WAS PER TURN, AND IT IS SOLD AS PER RUN ────────────────
 *
 * `--help` and `README.md` both describe `--budget` as the ceiling for the run.
 * In an interactive session it was handed out FRESH ON EVERY TURN: `runChat`
 * (lib/chat.mjs:158) loops calling `runOne`, which is `oneTurn`, which passed
 * `opts.budgetUsd` unmodified each time. A forty-turn conversation therefore
 * permitted forty times the number the user agreed to — $0.80 against a stated
 * $0.02.
 *
 * ⚠️ It became everyone's problem on 2026-08-12, when the $0.02 ceiling was
 * turned on by default. Before that you had to type `--budget` to be misled.
 * Pricing is the first thing a payer looks at and the one number we cannot have
 * wrong, so this outranks every capability item on the list.
 *
 * ⭐ The one-shot path was always correct (one turn, nothing to accumulate) and
 * the RESUME path already subtracted prior spend before starting. The fix is
 * that same subtraction for the turn loop, in ONE pure function so the two
 * paths cannot drift into two answers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { remainingForTurn, DEFAULT_BUDGET_USD } from '../lib/budget.mjs';

test('⭐⭐ a session with no ceiling is unchanged — null means unlimited, never zero', () => {
  /**
   * ⚠️ The distinction that must never blur: `--budget none` gives null, and a
   * budget of 0 can never start a round. Collapsing them would turn "unlimited"
   * into "refuse everything".
   */
  for (const spent of [0, 0.5, 999]) {
    const r = remainingForTurn(null, spent);
    assert.equal(r.ok, true);
    assert.equal(r.remainingUsd, null, 'no ceiling stays no ceiling however much was spent');
  }
  assert.equal(remainingForTurn(undefined, 1).remainingUsd, null);
});

test('⭐⭐ each turn gets what is LEFT, not the whole ceiling again', () => {
  /**
   * ⚠️ COMPARED WITH A TOLERANCE, and the first draft of this test did not:
   * `0.02 - 0.005` is 0.015000000000000001 in IEEE-754, so a strict equality
   * here fails on CORRECT code. Money in floating point always needs the
   * tolerance — and `budget.mjs` already keeps one, USD_EPSILON, for exactly
   * this reason.
   */
  const near = (actual, expected, what) => assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}: expected ~${expected}, got ${actual}`,
  );
  near(remainingForTurn(0.02, 0).remainingUsd, 0.02, 'turn one gets it all');
  near(remainingForTurn(0.02, 0.005).remainingUsd, 0.015, 'turn two gets the remainder');
  near(remainingForTurn(0.02, 0.015).remainingUsd, 0.005, 'and turn three what is left of that');
});

test('⭐⭐ forty turns cannot spend forty ceilings — the defect, stated as arithmetic', () => {
  /**
   * The old behaviour: every turn received DEFAULT_BUDGET_USD, so N turns
   * permitted N x the ceiling. This walks a session and asserts the total can
   * never exceed what the user agreed to.
   */
  let spent = 0;
  let granted = 0;
  for (let turn = 0; turn < 40; turn += 1) {
    const room = remainingForTurn(DEFAULT_BUDGET_USD, spent);
    if (!room.ok) break;
    granted += room.remainingUsd;
    spent += DEFAULT_BUDGET_USD / 8; // each turn actually costs an eighth
  }
  assert.ok(spent <= DEFAULT_BUDGET_USD + 1e-9, `a session spent ${spent}, over its ${DEFAULT_BUDGET_USD} ceiling`);
  assert.ok(
    granted < DEFAULT_BUDGET_USD * 40,
    'the old behaviour granted the full ceiling forty times over; this must be strictly less',
  );
});

test('⚠️ an exhausted session refuses the next turn AND names the way out', () => {
  const r = remainingForTurn(0.02, 0.02);
  assert.equal(r.ok, false, 'nothing left means no turn');
  assert.equal(r.remainingUsd, 0);
  assert.match(r.message, /--budget/, 'a refusal that does not say what to type is just an obstacle');
  assert.match(r.message, /0\.02/, 'and it must state the ceiling it is enforcing');

  const over = remainingForTurn(0.02, 0.05);
  assert.equal(over.ok, false, 'overspend is still refusal, never a negative allowance');
  assert.equal(over.remainingUsd, 0, 'and never a negative number handed to the governor');
});

test('⚠️ a nonsense spent value is treated as zero, not as a crash or a negative budget', () => {
  /**
   * `usage.cost` is null on a run where no call completed. Coercing that to NaN
   * and subtracting would produce a NaN ceiling, which compares false against
   * everything and silently disables the governor — a safety feature failing
   * open, which is the worst direction.
   */
  for (const bad of [null, undefined, NaN, -5, 'abc']) {
    const r = remainingForTurn(0.02, bad);
    assert.equal(r.ok, true, `spent=${String(bad)} must not break the governor`);
    assert.equal(r.remainingUsd, 0.02, 'and must not silently shrink the allowance either');
  }
});
