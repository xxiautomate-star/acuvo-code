/**
 * ── ⭐⭐ THE DIFFERENTIATOR WAS TWO FLAGS AWAY AND NOBODY TYPES UNKNOWN FLAGS ─
 *
 * A hard dollar cap enforced BEFORE the round — not an alert after it — is the
 * one thing in this package a competitor structurally cannot copy: it caps
 * revenue per run, and no public company's finance function approves that.
 *
 * It was also unreachable. `budgetUsd` defaulted to null, so the governor never
 * engaged unless someone typed `--budget`, and `--until-done` refused to start
 * without it. A feature nobody can find is not a feature.
 *
 * ⚠️ TURNING IT ON IS EXACTLY THE MOVE THAT COULD BECOME "A CHECK THAT FAILS
 * CORRECT WORK", which has cost this repo four days before. Three things keep
 * it honest, and all three are asserted below:
 *   1. it is a CEILING, never a spend commitment — nothing costs more,
 *   2. `--budget none` restores the old unbounded behaviour exactly,
 *   3. when it fires on a number the user never chose, the message SAYS SO and
 *      names the flag that raises it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv } from '../lib/cli-args.mjs';
import { createBudget, DEFAULT_BUDGET_USD } from '../lib/budget.mjs';

const opts = (argv) => {
  const r = parseArgv(argv);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  return r.options;
};

test('⭐⭐ a bare run gets the ceiling — the whole point of this change', () => {
  const o = opts(['fix the failing test']);
  assert.equal(o.budgetUsd, DEFAULT_BUDGET_USD);
  assert.equal(o.budgetExplicit, false, 'and it knows the user did not choose it');
});

test('the default is generous against MEASURED cost, not a guess', () => {
  /**
   * Measured on this package: a task is $0.0008–$0.003, a full three-rung
   * escalation $0.0035, one round $0.000231. A ceiling that fires on ordinary
   * work would be the check-that-fails-correct-work failure, so assert the
   * headroom rather than trusting the comment.
   */
  const dearestObservedTask = 0.0035;
  assert.ok(
    DEFAULT_BUDGET_USD >= dearestObservedTask * 5,
    `${DEFAULT_BUDGET_USD} must clear the dearest observed task (${dearestObservedTask}) several times over`,
  );
  assert.ok(DEFAULT_BUDGET_USD <= 0.05, 'and stay small enough that a runaway is cheap to discover');
});

test('⭐ --budget none restores the old unbounded behaviour exactly', () => {
  for (const word of ['none', 'off', 'unlimited', 'NONE']) {
    const o = opts(['--budget', word, 'x']);
    assert.equal(o.budgetUsd, null, `--budget ${word} means no ceiling`);
    assert.equal(o.budgetExplicit, true, 'and it was a choice, so nothing may second-guess it');
  }
  const unbounded = createBudget({ limitUsd: null });
  unbounded.record({ costUsd: 999 });
  assert.equal(unbounded.canContinue().ok, true, 'no ceiling means no stop');
});

test('an explicit --budget still wins, and is marked as chosen', () => {
  const o = opts(['--budget', '0.50', 'x']);
  assert.equal(o.budgetUsd, 0.5);
  assert.equal(o.budgetExplicit, true);
});

test('⚠️⚠️ --until-done still DEMANDS an explicit ceiling — the default must not satisfy it', () => {
  /**
   * The trap this change could have walked into: with a default present,
   * `budgetUsd === null` never fires, the refusal silently dies, and the
   * unbounded mode inherits $0.02 — stopping almost at once and reading as a
   * broken feature rather than a missing flag.
   */
  const refused = parseArgv(['--until-done', 'x']);
  assert.equal(refused.ok, false, 'the default ceiling must not satisfy --until-done');
  assert.match(refused.error, /--budget/, 'and the refusal must name the flag');

  const allowed = parseArgv(['--until-done', '--budget', '0.50', 'x']);
  assert.equal(allowed.ok, true);
});

test('⭐⭐ a ceiling the user never set SAYS SO, and names the way out', () => {
  const spend = (limitIsDefault) => {
    const b = createBudget({ limitUsd: DEFAULT_BUDGET_USD, limitIsDefault });
    b.record({ costUsd: DEFAULT_BUDGET_USD - 0.0001 });
    return b.canContinue();
  };

  const fromDefault = spend(true);
  assert.equal(fromDefault.ok, false);
  assert.match(fromDefault.message, /default ceiling/, 'it must admit the number was not the user\'s');
  assert.match(fromDefault.message, /--budget/, 'and name the flag that raises it');
  assert.match(fromDefault.message, /--budget none/, 'and the escape hatch it promises must be named too');

  const fromUser = spend(false);
  assert.equal(fromUser.ok, false);
  assert.doesNotMatch(fromUser.message, /default ceiling/, 'a number you chose is not explained back to you');
  assert.match(fromUser.message, /--budget/, 'but the way to raise it is still named');
});

test('limitIsDefault changes only the SENTENCE, never the enforcement', () => {
  /**
   * ⚠️ If this ever diverges, the flag has become a behaviour switch and the
   * two paths will drift. Same spend, same limit, same verdict — only the prose
   * may differ.
   */
  const verdict = (limitIsDefault) => {
    const b = createBudget({ limitUsd: 0.01, limitIsDefault });
    b.record({ costUsd: 0.0099 });
    const v = b.canContinue();
    return { ok: v.ok, reason: v.reason, spentUsd: v.spentUsd, remainingUsd: v.remainingUsd };
  };
  assert.deepEqual(verdict(true), verdict(false));
});
