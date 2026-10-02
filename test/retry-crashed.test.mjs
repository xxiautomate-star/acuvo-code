/**
 * ── ⭐⭐ A HOST FAILURE IS NOT A RESULT ──────────────────────────────────────
 *
 * Measured: `deep100` attempted 89 tasks, scored 16, and lost 63 to one fact —
 * the Docker daemon collapsing. Those trials wrote `exception.txt` and no
 * `reward.txt`, so they are neither a pass nor a fail; they simply are not
 * there. The run looked "37.5%" while three quarters of it never started.
 *
 * ⚠️ THE SEPARATION IS THE WHOLE POINT AND IT CUTS BOTH WAYS. Retrying a task
 * that genuinely failed would inflate the score — which is the opposite of the
 * honesty this exists for. So an `AgentTimeoutError` (our agent hanging) must
 * NEVER land in the retry list, however much we would like the point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyTrial, survey, retryTasks, taskOf } from '../bench/terminal-bench/retry-crashed.mjs';

const made = [];
function results(trials) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-retry-'));
  made.push(root);
  for (const [name, spec] of Object.entries(trials)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (spec.reward !== undefined) {
      mkdirSync(join(dir, 'verifier'), { recursive: true });
      writeFileSync(join(dir, 'verifier', 'reward.txt'), String(spec.reward));
    }
    if (spec.exception) writeFileSync(join(dir, 'exception.txt'), spec.exception);
  }
  return root;
}

test.after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* lag */ } } });

test('⭐⭐ a Docker collapse is retryable', () => {
  const root = results({
    'build-pmars__a': { exception: 'Traceback\nRuntimeError: Docker compose command failed for environment build-pmars' },
  });
  const out = survey(root);
  assert.deepEqual(retryTasks(out), ['build-pmars']);
});

test('⚠️⚠️ OUR agent timing out is NOT retryable, however much we want the point', () => {
  /**
   * This is the assertion that keeps the tool honest. An AgentTimeoutError is a
   * real failure of ours; re-running it spends money to reproduce a true result.
   */
  const root = results({
    'extract-moves__b': { exception: 'harbor.trial.errors.AgentTimeoutError: Agent execution timed out after 1800.0 seconds' },
  });
  const out = survey(root);
  assert.deepEqual(retryTasks(out), []);
  assert.equal(out.unclear.length, 1);
  assert.match(out.unclear[0].reason, /AgentTimeoutError/);
});

test('⭐ a scored trial is left alone, pass or fail', () => {
  const root = results({
    'won__c': { reward: '1' },
    'lost__d': { reward: '0' },
  });
  const out = survey(root);
  assert.equal(out.scored, 2);
  assert.equal(out.passed, 1);
  assert.deepEqual(retryTasks(out), []);
});

test('⚠️ the same task crashing twice is retried ONCE', () => {
  const root = results({
    'flaky__e': { exception: 'RuntimeError: Docker compose command failed' },
    'flaky__f': { exception: 'RuntimeError: Docker compose command failed' },
  });
  assert.deepEqual(retryTasks(survey(root)), ['flaky']);
});

test('⭐ 0xC0000142 and a dead daemon both count as the host', () => {
  const root = results({
    'a__1': { exception: 'exited with code 3221225794' },
    'b__2': { exception: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' },
    'c__3': { exception: 'harbor.trial.errors.EnvironmentStartTimeoutError: Environment start timed out' },
  });
  assert.deepEqual(retryTasks(survey(root)), ['a', 'b', 'c']);
});

test('⚠️ a trial with no verdict and no exception is PENDING, not crashed', () => {
  // Still running. Reporting it as crashed would send someone re-running work
  // that is currently in flight.
  const root = results({ 'inflight__g': {} });
  const out = survey(root);
  assert.equal(out.pending, 1);
  assert.deepEqual(retryTasks(out), []);
});

test('taskOf strips the trial hash', () => {
  assert.equal(taskOf('build-pmars__iYnNgzu'), 'build-pmars');
  assert.equal(taskOf('plain'), 'plain');
});

test('⚠️ classifyTrial reads reward BEFORE exception — a scored crash still scored', () => {
  /**
   * A trial can crash during cleanup AFTER the verifier wrote a reward. That is
   * a real result and must not be thrown back into the retry pile.
   */
  const root = results({ 'late__h': { reward: '1', exception: 'RuntimeError: Docker compose command failed' } });
  const out = survey(root);
  assert.equal(out.passed, 1);
  assert.deepEqual(retryTasks(out), []);
});
