/**
 * ── ⭐⭐⭐ A BENCH NOBODY CAN RUN IS A VERB NOBODY IS OFFERED ───────────────
 *
 * `bench/hard-tasks-v2.mjs` is the six hardest tasks in this repository — the
 * only ones that measure work spanning many files at once — and for weeks the
 * single line that wires them in existed ONLY AS A COMMENT INSIDE THE FILE IT
 * WOULD WIRE:
 *
 *     HOW THE LEAD WIRES THIS IN (one line, in bench/tasks.mjs)
 *
 * So `node bench/run.mjs` could not reach them, `--only renamewide` answered
 * *"No task matched"*, and `bench/tasks.mjs`'s own header went on saying we had
 * no evidence about complex work — while the evidence-gathering apparatus sat
 * finished, self-checked offline by `test/hard-bench-v2.test.mjs`, and
 * unreachable from the runner.
 *
 * ⚠️ `test/hard-bench-v2.test.mjs` COULD NOT CATCH THIS, and that is the point
 * worth keeping: it imports `HARD_TASKS_V2` directly, so it proved every check
 * in the corpus was correct while nothing could execute the corpus. A guard
 * whose universe is the module cannot see that the product never imports it —
 * *"a guard's universe matters as much as its assertion"*, again.
 *
 * ⭐ THIS FILE'S UNIVERSE IS `TASKS` — the array the runner actually reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { TASKS, SUITES, suiteOf } from '../bench/tasks.mjs';
import { HARD_V2_IDS } from '../bench/hard-tasks-v2.mjs';
import { benchDocument, BENCH_SCHEMA } from '../bench/result-document.mjs';

const RUNNER = fileURLToPath(new URL('../bench/run.mjs', import.meta.url));

test('⭐⭐⭐ every hard-v2 task is in the corpus the runner reads', () => {
  const ids = new Set(TASKS.map((t) => t.id));
  const missing = HARD_V2_IDS.filter((id) => !ids.has(id));
  assert.deepEqual(
    missing, [],
    'bench/run.mjs iterates TASKS and nothing else. A hard task that is not in it cannot be run, cannot be named by --only, and cannot appear in --list — which is how the six hardest tasks in this package went weeks without ever executing.',
  );
});

test('⭐⭐ they carry the hard-v2 suite tag, and everything else stays core', () => {
  const tagged = TASKS.filter((t) => suiteOf(t) === 'hard-v2').map((t) => t.id);
  assert.deepEqual(tagged.sort(), [...HARD_V2_IDS].sort());
  assert.ok(SUITES.includes('core') && SUITES.includes('hard-v2'), `--suite must offer both halves; got ${SUITES.join(', ')}`);

  /**
   * ⚠️ THE SIXTEEN OLDER TASKS MUST NOT HAVE BEEN RETAGGED. `suiteOf` defaults
   * to 'core' precisely so nobody has to add a field to each of them, and a
   * refactor that "tidied" them into an explicit tag is the sort of change that
   * silently removes tasks from the default sweep.
   */
  assert.ok(TASKS.filter((t) => suiteOf(t) === 'core').length >= 13, 'the core sweep must not have lost tasks to the tagging');
});

test('⚠️ a hard-v2 task is a real task, not a stub the runner would crash on', () => {
  for (const id of HARD_V2_IDS) {
    const t = TASKS.find((x) => x.id === id);
    assert.ok(typeof t.prompt === 'string' && t.prompt.length > 20, `${id} has no usable prompt`);
    assert.ok(Number.isInteger(t.rounds) && t.rounds > 0, `${id} has no round budget — run.mjs passes it to --max-rounds`);
    assert.ok(t.setup && typeof t.setup.files === 'object', `${id} has no fixture — makeWorkspace would lay down nothing`);
    assert.ok(Array.isArray(t.checks) && t.checks.length > 0, `${id} would pass by having no checks`);
  }
});

/* ── THE MACHINE-READABLE RESULT ─────────────────────────────────────────── */

test('⭐⭐⭐ the result document carries the score AND what makes two runs comparable', () => {
  const doc = benchDocument({
    results: [
      { task: { id: 'renamewide', what: 'HARD', checks: [1, 2], rounds: 14 }, failures: [], res: { rounds: 14, seconds: 90, cost: 0.01, verified: true, exitCode: 0, providers: { Relace: 14 }, cacheHit: 0.91, refusals: [] } },
      { task: { id: 'twohops', what: 'HARD', checks: [1], rounds: 9 }, failures: ['it patched the middle file'], res: { rounds: 4, seconds: 20, cost: 0.002, verified: false, exitCode: 1, providers: null, cacheHit: null, refusals: [{ tool: 'run_command', why: 'blocked' }] } },
    ],
    suiteOf: () => 'hard-v2',
    selection: { only: null, suite: 'hard-v2' },
    env: { at: '2026-09-17T00:00:00.000Z', cli: '0.6.22', node: 'v22', platform: 'win32' },
  });

  assert.equal(doc.schema, BENCH_SCHEMA);
  assert.equal(doc.totals.passed, 1);
  assert.equal(doc.totals.ofTasks, 2);
  assert.equal(doc.totals.refusals, 1, 'a refusal costs a round whether or not the task passes — it is a tax no pass/fail column shows');

  const [wide, two] = doc.tasks;
  assert.equal(wide.cacheHit, 0.91, 'without the cache rate a cost difference between two runs cannot be told apart from a cold prefix');
  assert.deepEqual(wide.providers, { Relace: 14 }, 'the same call was measured 7x apart across upstreams — the score is meaningless without knowing which served it');
  assert.deepEqual(two.failures, ['it patched the middle file'], 'the failure STRINGS, not a count: a count says it broke, these say how');
  assert.equal(two.cacheHit, null, '"nothing reported" must not render as "0% cached"');
});

test('⭐⭐ a task that spent its whole round budget is named — it may have passed by luck', () => {
  const doc = benchDocument({
    results: [
      { task: { id: 'capped', what: '', checks: [1], rounds: 14 }, failures: [], res: { rounds: 14, seconds: 1, cost: 0, verified: true, exitCode: 0, refusals: [] } },
      { task: { id: 'roomy', what: '', checks: [1], rounds: 9 }, failures: [], res: { rounds: 4, seconds: 1, cost: 0, verified: true, exitCode: 0, refusals: [] } },
    ],
  });
  assert.deepEqual(doc.totals.atRoundCap, ['capped'], 'passing on the last round you were allowed is a different fact from passing in four, and only one of them survives a harder variant');
});

/* ── THE RUNNER'S OWN WIRING ─────────────────────────────────────────────── */

test('⚠️ the runner writes a result by default — an opt-in artefact does not exist', async () => {
  const src = await readFile(RUNNER, 'utf8');
  assert.match(src, /benchDocument\(\{/, 'the runner must build the document through the shared, testable function rather than an inline literal nothing can assert');
  assert.match(src, /has\('--no-out'\) \? null :/, 'writing the result must be the default; `--no-out` is the escape, not the switch');
  assert.match(src, /--suite/, '--suite is how the hard half is run on its own, and how the cheap sweep survives it arriving');
});
