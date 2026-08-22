/**
 * ── ⭐⭐ THE WIRING HALF: A REAL runSession, NOT A UNIT ──────────────────────
 *
 * `test/plan-belongs-to-task.test.mjs` proves the DECISION is right. This one
 * proves it is REACHED — that a real loop, with a real executor and a real plan
 * on disk, stops putting another task's steps in front of the model.
 *
 * ⚠️ THIS PACKAGE'S MOST COMMON DEFECT BY FAR is the feature whose parts all
 * exist and which nothing calls; it shipped four times in one day, including
 * inside the commits fixing it. `plan-ledger.mjs` and `acceptance.mjs` were
 * both finished, documented and tested while imported by nothing. So the
 * decision lives in lib/ and this file drives the loop that consumes it.
 *
 * ── ⚠️ AND THE MESSAGES ARE THE ASSERTION, not the events ───────────────────
 * `outcome.messages` is what the model was actually sent. An event is what a
 * human watching would have seen. The bug was a per-round MESSAGE, so a test
 * that only counted events could pass while the pollution continued.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession, planBannerFor, foreignPlanNoticeFor } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { taskKey, loadPlan } from '../lib/plan-ledger.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-plan-wire-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The dogfood plan, byte-for-byte the shape found on disk: six steps, none
 *  marked, `createdAt` and `updatedAt` milliseconds apart. */
function writeDogfoodPlan(dir, { runTask } = {}) {
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  const iso = new Date().toISOString();
  writeFileSync(join(dir, '.acuvo', 'plan.json'), `${JSON.stringify({
    version: 1,
    task: 'write a key-value store library with a CLI and tests',
    ...(runTask ? { runTaskKey: taskKey(runTask) } : {}),
    createdAt: iso,
    updatedAt: iso,
    steps: [
      'Write lib/store.mjs with get/set/delete',
      'Write lib/cli.mjs argument parsing',
      'Write bin/kv.mjs entry point',
      'Write test/store.test.mjs',
      'Run the tests and fix failures',
      'Write README.md usage section',
    ].map((text, i) => ({ id: `s${i + 1}`, text, state: 'todo' })),
  }, null, 2)}\n`, 'utf8');
}

/** Spends round 1 on a read and then stops — two real rounds. */
function twoRoundModel() {
  let round = 0;
  return async () => {
    round += 1;
    if (round === 1) {
      return {
        ok: true,
        content: 'looking first',
        toolCalls: [{ id: 'c1', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
        usage: null,
        finishReason: 'tool_calls',
      };
    }
    return { ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' };
  };
}

const planMessages = (outcome) => outcome.messages.filter(
  (m) => m.role === 'user' && String(m.content).startsWith('plan:'),
);

/* ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ THE BUG: a plan from an EARLIER task no longer rides on every round', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'index.js'), 'export const x = 1;\n');
  // Run 1 planned this; run 2 is a completely different job.
  writeDogfoodPlan(dir, { runTask: 'write a small key-value store with a CLI' });

  const events = [];
  const outcome = await runSession({
    task: 'add a package.json',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: 2,
    allowRun: false,
    onEvent: (e) => events.push(e),
    callModelImpl: twoRoundModel(),
  });
  assert.equal(outcome.ok, true);

  const msgs = planMessages(outcome);
  assert.equal(msgs.length, 1, 'the other task\'s plan is mentioned ONCE, not once per round');

  /**
   * ⚠️⚠️ THE STEPS ARE THE POLLUTION. The measured session's model read
   * "Write lib/store.mjs" every round and eventually argued with the runner:
   * "this session's actual task was only to add package.json". Not one step
   * text may reach the model.
   */
  const all = outcome.messages.map((m) => String(m.content)).join('\n');
  assert.equal(/store\.mjs|lib\/cli\.mjs|bin\/kv\.mjs/.test(all), false,
    'no step from another task\'s plan may appear anywhere in the conversation');

  // And it says outright that it is not this task's work.
  assert.match(msgs[0].content, /NOT this task|not your task/i);
  assert.equal(events.filter((e) => e.type === 'plan').length, 1);
});

test('⭐ THE SAME task still gets its countdown every round — resume is not a casualty', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'index.js'), 'export const x = 1;\n');
  const prompt = 'write a small key-value store with a CLI';
  writeDogfoodPlan(dir, { runTask: prompt });

  const outcome = await runSession({
    task: prompt,
    executor: createLocalExecutor(dir),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: 2,
    allowRun: false,
    callModelImpl: twoRoundModel(),
  });

  const msgs = planMessages(outcome);
  assert.equal(msgs.length, 2, 'one banner per round, exactly as before');
  assert.match(msgs[0].content, /round 1 of 2/);
  assert.match(msgs[1].content, /round 2 of 2/);
  assert.match(msgs[0].content, /0\/6 done/);
});

test('⚠️ FAIL-SAFE: a LEGACY plan that overlaps the task keeps today\'s behaviour exactly', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'index.js'), 'export const x = 1;\n');
  writeDogfoodPlan(dir); // no runTaskKey — every plan on disk today

  const outcome = await runSession({
    task: 'finish the key-value store',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: 2,
    allowRun: false,
    callModelImpl: twoRoundModel(),
  });
  assert.equal(planMessages(outcome).length, 2, 'an unproven relation must not cost a run its countdown');
});

test('⭐ a plan RECORDED by the loop knows its own task — the round object carries it', async (t) => {
  const dir = workspace(t);
  const model = (() => {
    let round = 0;
    return async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          content: 'planning',
          toolCalls: [{
            id: 'c1',
            function: {
              name: 'plan_start',
              arguments: JSON.stringify({ task: 'build the store', steps: ['write lib/store.mjs', 'write the tests'] }),
            },
          }],
          usage: null,
          finishReason: 'tool_calls',
        };
      }
      return { ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' };
    };
  })();

  const outcome = await runSession({
    task: 'write a small key-value store with a CLI',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: 2,
    allowRun: false,
    callModelImpl: model,
  });
  assert.equal(outcome.ok, true);

  /**
   * ⭐ THE END-TO-END LINK. `plan_start` never sees the runner's task unless
   * turn.mjs puts it in the `round` object that tools.mjs spreads into the
   * plan tools' options. Without that one field this whole feature is inert on
   * every plan it writes, which is precisely the "built but unreached" defect
   * this package keeps shipping.
   */
  const plan = loadPlan(dir).plan;
  assert.equal(plan.runTaskKey, taskKey('write a small key-value store with a CLI'));

  // And that key immediately protects the NEXT, different run.
  const executor = createLocalExecutor(dir);
  assert.equal(planBannerFor(executor, { roundIndex: 1, maxRounds: 3, task: 'add a package.json' }), null);
  assert.match(foreignPlanNoticeFor(executor, { task: 'add a package.json' }), /^plan: a plan from an earlier task/);
});

test('⚠️ a DRY RUN still reads nothing — the notice may not resurrect the disk read', (t) => {
  const dir = workspace(t);
  writeDogfoodPlan(dir, { runTask: 'write a small key-value store with a CLI' });
  const executor = createLocalExecutor(dir, { dryRun: true });
  assert.equal(planBannerFor(executor, { roundIndex: 1, maxRounds: 3, task: 'add a package.json' }), null);
  assert.equal(foreignPlanNoticeFor(executor, { task: 'add a package.json' }), null,
    '--dry-run promises nothing is written, and loadPlan can rename a corrupt plan');
});

test('⚠️ no plan at all ⇒ no notice, so the 90% of runs are byte-identical', (t) => {
  const dir = workspace(t);
  assert.equal(foreignPlanNoticeFor(createLocalExecutor(dir), { task: 'anything' }), null);
});
