/**
 * ── ⚠️⚠️ THE RUN THAT DID NOTHING AND REPORTED SUCCESS ──────────────────────
 *
 * From a real Terminal-Bench artifact on disk, 2026-08-12:
 *
 *   results/2026-08-12__19-10-43/write-compressor__qiRTrvh/agent/acuvo-result.json
 *   {"ok":true,"rounds":2,"stoppedBecause":"no-tool-calls",
 *    "verification":{"ran":false,"passed":false},"changes":[],
 *    "costUsd":0.003,"failed":false,"exitCode":0}
 *   verifier/reward.txt = 0
 *
 * Two of sixteen rounds, nothing written, nothing run, 3% of the budget, exit 0.
 * `acuvo … && git push` would have pushed nothing and called it a success.
 *
 * ⭐ Every other clause in sessionFailed is a statement about something that
 * HAPPENED. None of them can fire when nothing did — which is why the gap
 * survived 1,600 green tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sessionFailed, nothingHappened } from '../lib/turn.mjs';

/** The archived artifact above, in the shape sessionFailed actually receives. */
function theArchivedRun(over = {}) {
  return {
    ok: true,
    stage: 'done',
    stoppedBecause: 'no-tool-calls',
    roundsUsed: 2,
    maxRounds: 16,
    executed: [],
    verification: { ran: false, passed: false, command: null, exitCode: null, timedOut: false, attempts: 0 },
    acceptance: null,
    ...over,
  };
}

test('⭐⭐ the archived run that exited 0 having done nothing now fails under --strict', () => {
  const run = theArchivedRun();

  // The bug, pinned: without strict this is still a success, deliberately.
  assert.equal(sessionFailed(run), false, 'default behaviour is unchanged — this is the opt-in');
  assert.equal(sessionFailed(run, { strict: true }), true, 'under strict, a run that did nothing is a failed run');
});

test('nothingHappened tests EFFECT, not effort — rounds and dollars are not evidence', () => {
  // Burned every round, spent money, produced nothing. Still nothing happened.
  assert.equal(nothingHappened(theArchivedRun({ roundsUsed: 16, stoppedBecause: 'round-cap' })), true);

  // One mutating tool call is enough to count as having happened.
  const wrote = theArchivedRun({ executed: [{ name: 'write_file', mutated: true, result: {}, args: {}, id: '1' }] });
  assert.equal(nothingHappened(wrote), false, 'a file was written');
  assert.equal(sessionFailed(wrote, { strict: true }), false);

  // A command that RAN counts even when nothing was written — that is a real
  // answer to "run the tests and tell me what breaks".
  const ranOnly = theArchivedRun({ verification: { ran: true, passed: true, command: 'npm test', exitCode: 0, timedOut: false, attempts: 1 } });
  assert.equal(nothingHappened(ranOnly), false, 'something ran');
  assert.equal(sessionFailed(ranOnly, { strict: true }), false);
});

test('⚠️ non-mutating tool calls are NOT evidence — reading is not doing', () => {
  /**
   * The exact failure this is guarding: a run that greps, reads three files,
   * decides, and writes nothing. It looks busy in the transcript and produced
   * no artifact. `mutated` is set by the dispatcher per record, so this is the
   * distinction the codebase already makes everywhere else.
   */
  const readOnly = theArchivedRun({
    executed: [
      { name: 'search_text', mutated: false, result: {}, args: {}, id: '1' },
      { name: 'read_file', mutated: false, result: {}, args: {}, id: '2' },
    ],
  });
  assert.equal(nothingHappened(readOnly), true);
  assert.equal(sessionFailed(readOnly, { strict: true }), true);
});

test('⚠️⚠️ strict must NEVER turn a real failure into a success', () => {
  /**
   * The clause is placed first and returns only `true`. A failing command, a
   * dead provider and an unmet gating criterion must all still fail — including
   * in the case where nothing was written, where the new clause also fires.
   */
  const outage = theArchivedRun({ stoppedBecause: 'model-error' });
  assert.equal(sessionFailed(outage, { strict: true }), true);
  assert.equal(sessionFailed(outage), true, 'and without strict too');

  const redSuite = theArchivedRun({
    verification: { ran: true, passed: false, command: 'npm test', exitCode: 1, timedOut: false, attempts: 1 },
  });
  assert.equal(sessionFailed(redSuite, { strict: true }), true);
  assert.equal(sessionFailed(redSuite), true);

  const unmet = theArchivedRun({
    executed: [{ name: 'write_file', mutated: true, result: {}, args: {}, id: '1' }],
    acceptance: { source: 'declared', gating: true, criteria: [], verdict: { verdict: 'unmet' } },
  });
  assert.equal(sessionFailed(unmet, { strict: true }), true);
});

test('a run that never started is a failure regardless — nothingHappened does not claim it', () => {
  /**
   * ⚠️ nothingHappened answers ONLY for a completed run. `{ok:false}` is
   * already a failure by the first clause, and reporting it as "nothing
   * happened" would be a second, competing explanation for the same exit code.
   */
  const dead = { ok: false, stage: 'model', error: 'every provider in the chain failed' };
  assert.equal(nothingHappened(dead), false, 'not its question to answer');
  assert.equal(sessionFailed(dead, { strict: true }), true);
  assert.equal(sessionFailed(dead), true);
});

test('the existing callers are unaffected — strict is opt-in by omission', () => {
  /**
   * best-of.mjs and escalate.mjs both use sessionFailed() as their definition of
   * a winning attempt and pass no options. If strict were the default, an
   * attempt that correctly answered a read-only question would be scored as a
   * loss, and the ladder would escalate — spending money to redo work that was
   * already right.
   */
  const readOnlyButCorrect = theArchivedRun({
    executed: [{ name: 'read_file', mutated: false, result: {}, args: {}, id: '1' }],
  });
  assert.equal(sessionFailed(readOnlyButCorrect), false, 'unchanged for every existing caller');
  assert.equal(sessionFailed(readOnlyButCorrect, {}), false, 'an empty options object is not strict');
  assert.equal(sessionFailed(readOnlyButCorrect, { strict: false }), false);
  // ⚠️ Only the literal `true` opts in — a truthy string must not silently arm it.
  assert.equal(sessionFailed(readOnlyButCorrect, { strict: 'yes' }), false, 'only === true arms it');
});
