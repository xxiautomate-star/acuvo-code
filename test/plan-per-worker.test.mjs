/**
 * ── ⚠️⚠️ SEVEN TERMINALS SHARED ONE PLAN, AND ONE MARKED ANOTHER'S WORK DONE ─
 *
 * Measured 2026-08-13, two terminals in one checkout, before the fix:
 *
 *   terminal 1  plan_start "port the auth module" → [port auth, add tests, commit]
 *   terminal 2  plan_start "fix the CSS"          → REFUSED ("a plan for this
 *                                                   workspace already exists…
 *                                                   pass replace:true to discard it")
 *   terminal 2  plan_step s1 done                 → ACCEPTED
 *   on disk     done: port auth                   ← work terminal 2 never did
 *   terminal 2's banner every round:
 *               "plan: 1/3 done · 2 remaining: add tests, commit"
 *
 * Three harms from one cause: terminal 2 cannot plan, the refusal invites it to
 * DESTROY terminal 1's plan, and its every round is prefixed with somebody
 * else's task. The product direction is seven of these at once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

import {
  planStart, planStep, loadPlan, formatBanner, planFileFor, PLAN_FILE,
} from '../lib/plan-ledger.mjs';

const made = [];
const ws = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), 'acuvo-plan-')); made.push(d); return d; };
const cleanup = () => { for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows */ } } };

const as = (holder) => ({ planFile: planFileFor(holder) });

test('⭐⭐ two terminals each plan their OWN task in one checkout', (t) => {
  t.after(cleanup);
  const root = ws();

  assert.equal(planStart(root, { task: 'port the auth module', steps: ['port auth', 'add tests'] }, as('t1')).ok, true);
  const second = planStart(root, { task: 'fix the CSS', steps: ['fix css'] }, as('t2'));

  assert.equal(second.ok, true, `terminal 2 was blocked by terminal 1's plan: ${second.ok === false ? second.error : ''}`);
});

test('⭐⭐ a step marked done by one terminal does NOT complete another\'s work', (t) => {
  t.after(cleanup);
  const root = ws();
  planStart(root, { task: 'port the auth module', steps: ['port auth', 'add tests'] }, as('t1'));
  planStart(root, { task: 'fix the CSS', steps: ['fix css'] }, as('t2'));

  planStep(root, { id: 's1', state: 'done' }, as('t2'));

  const one = loadPlan(root, as('t1')).plan;
  const two = loadPlan(root, as('t2')).plan;
  assert.deepEqual(one.steps.map((s) => s.state), ['todo', 'todo'], 'terminal 1\'s work was marked done by terminal 2');
  assert.deepEqual(two.steps.map((s) => s.state), ['done'], 'terminal 2\'s own step did not record');
});

test('⚠️ each terminal\'s banner describes ITS task, not the other one\'s', (t) => {
  t.after(cleanup);
  const root = ws();
  planStart(root, { task: 'port the auth module', steps: ['port auth'] }, as('t1'));
  planStart(root, { task: 'fix the CSS', steps: ['fix css'] }, as('t2'));

  const b2 = formatBanner(loadPlan(root, as('t2')).plan, { roundIndex: 1, maxRounds: 5 });
  assert.match(b2, /fix css/);
  assert.ok(!b2.includes('port auth'), `terminal 2 is being told about terminal 1's work every round: ${b2}`);
});

test('⚠️⚠️ a terminal that names NO holder keeps today\'s path — resume depends on it', () => {
  /**
   * The default holder is `pid-<pid>` and it changes every run. Keying on that
   * would send `--resume` looking for a plan under a pid that no longer exists,
   * silently losing the ledger the feature exists for. Only an EXPLICIT holder
   * gets its own file.
   */
  assert.equal(planFileFor(undefined), PLAN_FILE);
  assert.equal(planFileFor(null), PLAN_FILE);
  assert.equal(planFileFor('   '), PLAN_FILE);
  assert.equal(planFileFor('pid-12345'), PLAN_FILE, 'the pid-shaped default must NOT get its own file');
  assert.notEqual(planFileFor('t1'), PLAN_FILE);
});

test('⚠️ a holder is user input and becomes a PATH — traversal cannot survive it', () => {
  for (const nasty of ['../../etc/passwd', '..\\..\\windows', '/absolute', '.hidden', 'a/b/c']) {
    const f = planFileFor(nasty);
    assert.ok(f.startsWith('.acuvo/plans/'), `${nasty} escaped the plans directory: ${f}`);
    assert.ok(!f.includes('..'), `${nasty} kept a traversal segment: ${f}`);
  }
});

test('a single terminal is completely unaffected — the old path still works', (t) => {
  t.after(cleanup);
  const root = ws();
  assert.equal(planStart(root, { task: 'do the thing', steps: ['step one'] }).ok, true);
  const loaded = loadPlan(root);
  assert.equal(loaded.plan.steps.length, 1);
  assert.equal(planStep(root, { id: 's1', state: 'done' }).ok, true);
  assert.equal(loadPlan(root).plan.steps[0].state, 'done');
});
