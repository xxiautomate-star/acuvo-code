/**
 * ── ⭐⭐ RE-CHECKING A PAST CLAIM, FOR NOTHING ───────────────────────────────
 *
 * Every run already writes the exact command this process observed exiting 0:
 * `verification: { ran, passed, command: "npm test", exitCode: 0 }`. So a claim
 * made yesterday can be tested today by RUNNING it again — no model call, no
 * cost.
 *
 * ⭐ It is not hard, it is DOWNSTREAM: you cannot re-check a machine-checkable
 * verdict until you have one, and an agent whose success criterion is its own
 * closing paragraph has nothing to re-check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadRuns, pickRun, recheckClaim, formatRecheck } from '../lib/verify-claim.mjs';

const rec = (id, over = {}) => ({
  v: 1, id, at: `2026-08-13T${id}:00:00.000Z`,
  run: { ok: true, verification: { ran: true, passed: true, command: 'npm test', exitCode: 0 }, changes: [{ path: 'src/m.js' }], ...over },
});
const runner = (exitCode) => async (command) => ({ ok: true, command, exitCode });

test('⭐⭐ a claim that still holds is reported as holding, and costs nothing', async () => {
  const r = await recheckClaim(rec('10'), { runner: runner(0) });
  assert.equal(r.status, 'holds');
  assert.match(formatRecheck(r), /STILL HOLDS/);
  assert.match(formatRecheck(r), /cost nothing/, 'the zero cost is the point — it must be said');
});

test('⭐⭐ a claim that no longer holds is caught', async () => {
  const r = await recheckClaim(rec('11'), { runner: runner(1) });
  assert.equal(r.status, 'broken');
  assert.equal(r.claimedExit, 0);
  assert.equal(r.actualExit, 1);
  assert.match(formatRecheck(r), /NO LONGER HOLDS/);
  assert.match(formatRecheck(r), /src\/m\.js/, 'what that run changed is the first place to look');
});

test('⚠️⚠️ a broken re-check does NOT accuse the run of lying', async () => {
  /**
   * Somebody may have edited the file since; a dependency may have moved; the
   * test may be flaky. Presenting it as an accusation would make the command
   * untrustworthy the first time it was wrong about a cause.
   */
  const text = formatRecheck(await recheckClaim(rec('12'), { runner: runner(1) }));
  assert.match(text, /does not say the run lied/);
  assert.match(text, /not true now/);
});

test('⚠️⚠️ "no checkable claim" is NOT a pass', async () => {
  const r = await recheckClaim(rec('13', { verification: { ran: false, passed: false, command: null } }), { runner: runner(0) });
  assert.equal(r.status, 'unclaimed');
  assert.match(r.message, /not the same as it having passed/,
    'a run that executed nothing proved nothing, and reporting that as success is the dishonesty every verdict here exists to prevent');
});

test('⚠️ a runner that cannot start the command is an ERROR, not a refutation', async () => {
  const r = await recheckClaim(rec('14'), { runner: async () => ({ ok: false, error: 'binary not allowed here' }) });
  assert.equal(r.status, 'error');
  assert.match(formatRecheck(r), /could not re-check/);
});

test('⭐ with no id it takes the most recent run THAT MADE A CLAIM', () => {
  const runs = [
    rec('20', { verification: { ran: false, command: null } }),   // newest, but proved nothing
    rec('19'),
  ];
  const picked = pickRun(runs, null);
  assert.equal(picked.run.id, '19', 'checking a read-only question and reporting "nothing to check" is technically true and useless');
});

test('⭐ an id can be given as a unique prefix, and an ambiguous one is refused', () => {
  const runs = [rec('2026-08-13T10'), rec('2026-08-13T11')];
  assert.equal(pickRun(runs, '2026-08-13T10').run.id, '2026-08-13T10');

  const ambiguous = pickRun(runs, '2026-08-13T');
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /matches 2 runs/);

  const missing = pickRun(runs, 'nope');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no run here has the id/);
});

test('⚠️ an unreadable log is an error, not an empty pass', () => {
  const r = loadRuns('/ws', { readImpl: () => { throw new Error('EACCES'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /EACCES/);
});

test('runs come back newest first', () => {
  const r = loadRuns('/ws', {
    readImpl: () => [{ name: 'a.jsonl', text: `${JSON.stringify(rec('10'))}\n${JSON.stringify(rec('12'))}\n` }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.runs.map((x) => x.id), ['12', '10']);
});
