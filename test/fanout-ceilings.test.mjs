/**
 * ── ⚠️⚠️ THE CEILING WAS ABSENT ON THE TWO MODES THAT SPEND THE MOST ────────
 *
 * `runSession` defaults `budgetUsd = null`, and null is UNLIMITED. Both fan-out
 * paths built their own `runSession` call and omitted it, so:
 *
 *   · `--best-of N` ran N full sessions with no wall, bounded only by the round
 *     cap — on the one mode whose whole purpose is to spend several times over.
 *     Worse: an explicit `--budget` was ACCEPTED without complaint and silently
 *     DISCARDED. Measured — `--best-of 2 --budget 0.005` ran both attempts and
 *     printed no budget line at all.
 *   · `--parallel` REFUSES `--budget` on the stated grounds that "N
 *     conversations getting N × $0.02 is what it means" — while giving each
 *     conversation no ceiling whatsoever. The promise was made in the refusal
 *     message and kept nowhere.
 *
 * ⭐ Taking a user's instruction about money and dropping it is a different and
 * worse failure than never offering the feature at all.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { bestOfAttemptBudget, DEFAULT_BUDGET_USD } from '../lib/budget.mjs';


test('⭐⭐ an EXPLICIT budget is a TOTAL across attempts, never per attempt', () => {
  // `--best-of 5 --budget 0.05` means "spend at most five cents". The reading
  // that multiplies it by N would be indefensible on an invoice.
  assert.equal(bestOfAttemptBudget({ bestOf: 5, budgetUsd: 0.05, budgetExplicit: true }), 0.01);
  assert.equal(bestOfAttemptBudget({ bestOf: 2, budgetUsd: 0.005, budgetExplicit: true }), 0.0025);
});

test('⚠️ the DEFAULT ceiling is NOT divided — a guard rail is not a promise', () => {
  /**
   * DEFAULT_BUDGET_USD is a per-run blast radius nobody chose. Splitting an
   * unchosen number into fifths would starve each attempt at four tenths of a
   * cent, turning a safety net into a feature that silently stops working at
   * N > 2. A ceiling the user CHOSE is a promise; one they did not is a guard
   * rail, and they behave differently on purpose.
   */
  assert.equal(bestOfAttemptBudget({ bestOf: 5, budgetUsd: DEFAULT_BUDGET_USD, budgetExplicit: false }), DEFAULT_BUDGET_USD);
  assert.equal(bestOfAttemptBudget({ bestOf: 9, budgetExplicit: false }), DEFAULT_BUDGET_USD);
});

test('⚠️ every attempt gets SOME ceiling — null is unlimited and must be unreachable', () => {
  // The defect in one assertion: whatever the options, this must never hand
  // back null/0/undefined, because runSession reads that as "no wall".
  for (const opts of [
    {}, { bestOf: 0 }, { bestOf: 1 }, { bestOf: 3 },
    { bestOf: 3, budgetUsd: null, budgetExplicit: true },
    { bestOf: 3, budgetUsd: 0, budgetExplicit: true },
    { bestOf: 3, budgetUsd: NaN, budgetExplicit: true },
    { bestOf: 3, budgetUsd: -1, budgetExplicit: true },
  ]) {
    const v = bestOfAttemptBudget(opts);
    assert.ok(Number.isFinite(v) && v > 0, `${JSON.stringify(opts)} produced ${v} — unlimited`);
  }
});

test('⭐ a nonsense attempt count cannot multiply into a bigger allowance', () => {
  // n is floored at 1, so a garbage --best-of can only ever make each attempt
  // POORER than the total, never richer.
  for (const bestOf of [0, -3, NaN, undefined, 'lots']) {
    const v = bestOfAttemptBudget({ bestOf, budgetUsd: 0.06, budgetExplicit: true });
    assert.ok(v <= 0.06, `bestOf=${String(bestOf)} produced ${v}, which exceeds the stated total`);
    /**
     * ⚠️ `> 0` IS THE HALF THAT ACTUALLY MATTERS, AND I LEFT IT OUT FIRST TIME.
     * With only the `<= 0.06` check above, removing the `Math.max(1, …)` floor
     * SURVIVED its mutation: `bestOf: -3` divides by a negative and returns
     * -$0.02, which is happily "not more than the total". A negative ceiling is
     * not a small ceiling — `canContinue` compares spend against it, so it
     * either refuses instantly or behaves as nonsense, and either way the test
     * that exists to catch it was passing.
     */
    assert.ok(v > 0, `bestOf=${String(bestOf)} produced ${v} — a ceiling must be a positive number of dollars`);
  }
});
