/**
 * ── ⚠️⚠️ A RUN THAT RAN OUT OF MONEY DID NOT COMPLETE ───────────────────────
 *
 * `sessionFailed` fails a run whose PROVIDER died, and the reasoning is written
 * out at turn.mjs: *"THE EXIT CODE IS A VERDICT ON WHETHER THE TASK COMPLETED,
 * not on whether some command inside it passed. A run that stopped because the
 * provider died did not complete, whatever it managed first."*
 *
 * A run stopped by the budget is the same sentence with a different noun. It
 * exited 0 anyway: files on disk, nothing verified, `acuvo … && git push`
 * pushes a half-written repo and calls it a success.
 *
 * ⭐ THE CODEBASE ALREADY KNEW. `outOfRoad()` treats 'would-exceed' and
 * 'limit-reached' as hitting a wall, and the escalation ladder consumes it via
 * `verified: (o) => !sessionFailed(o) && !outOfRoad(o)`. Only the PROCESS verdict
 * was left behind — and escalate.test.mjs said so out loud: "the process verdict
 * tolerates it — that is why the bug hid".
 *
 * ⚠️ AND IT ONLY BECAME EVERYONE'S PROBLEM ON 2026-08-12, when the $0.02 ceiling
 * was turned on by default. Before that you had to type `--budget` to reach it.
 * Turning a governor on without teaching the exit code about it is how a safety
 * feature becomes a silent-failure feature.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sessionFailed } from '../lib/turn.mjs';
import { BUDGET_REASONS } from '../lib/budget.mjs';

/** The exact shape the real run produced: ok, files written, nothing verified. */
const budgetStopped = (reason) => ({
  ok: true,
  stage: 'done',
  stoppedBecause: reason,
  executed: [{ name: 'write_file', mutated: true, result: {}, args: {}, id: '1' }],
  verification: { ran: false, passed: false, command: null, exitCode: null, timedOut: false, attempts: 0 },
  acceptance: null,
  usage: { cost: 0.0199 },
});

test('⭐⭐ a run cut off by the budget FAILS — half-written work is not a success', () => {
  for (const reason of ['would-exceed', 'limit-reached']) {
    assert.equal(
      sessionFailed(budgetStopped(reason)), true,
      `${reason} means the job was cut short with work outstanding — the shell must not be told it succeeded`,
    );
  }
});

test('⚠️ it fails WITHOUT --strict, because this is a fact and not an opinion', () => {
  /**
   * `--strict` is for the judgement call "nothing happened, is that ok?".
   * Running out of money is not a judgement call: the run was stopped by a
   * limit, mid-job, and did not finish. Same standing as 'model-error'.
   */
  const cut = budgetStopped('would-exceed');
  assert.equal(sessionFailed(cut), true, 'no flag required');
  assert.equal(sessionFailed(cut, { strict: true }), true);
});

test('⚠️ a run that finished on its own terms is STILL a success — this must not overreach', () => {
  /**
   * The check-that-fails-correct-work guard. 'verified' and 'no-tool-calls' are
   * the model finishing, not a wall. If these ever start failing, the ladder
   * charges twice for work that was already right and every ordinary run exits 1.
   */
  const finished = (reason) => ({
    ...budgetStopped(reason),
    verification: { ran: true, passed: true, command: 'npm test', exitCode: 0, timedOut: false, attempts: 1 },
  });
  assert.equal(sessionFailed(finished('verified')), false);
  assert.equal(sessionFailed(finished('no-tool-calls')), false);
});

test('⚠️ the budget reasons asserted here are the ones budget.mjs actually emits', () => {
  /**
   * ⭐ Without this, the fix above is a list of strings that can silently stop
   * matching reality — exactly the prose-coupling that let a timeout skip the
   * fallback chain for weeks. If someone renames a reason, this fails and points
   * at the file to update.
   */
  for (const reason of ['would-exceed', 'limit-reached']) {
    assert.ok(
      BUDGET_REASONS.includes(reason),
      `budget.mjs no longer emits "${reason}" — sessionFailed's list is now stale`,
    );
  }
  // 'too-small' is deliberately absent: it is a PREFLIGHT refusal that already
  // returns ok:false, so adding it here would be dead code claiming to be a guard.
  assert.ok(BUDGET_REASONS.includes('too-small'));
});
