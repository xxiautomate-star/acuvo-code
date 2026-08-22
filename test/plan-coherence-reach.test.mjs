/**
 * ── ⭐⭐⭐ THE MODULE IS 1,084 LINES AND WAS IMPORTED BY NOTHING ─────────────
 *
 * `plan-coherence.test.mjs` beside this file proves the DECISIONS are right.
 * It proved them for weeks while `wiring-reach.test.mjs` reported the module as
 * reachable from no entry point — so every one of those green tests was about
 * code no run could ever execute.
 *
 * ⚠️ THIS FILE IS THE OTHER HALF, AND IT IS THE HALF THAT WAS MISSING: does a
 * real `runSession` actually call it? A capability nobody can reach has not
 * shipped, and a unit test cannot tell you which side of that line you are on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { wasAppendOnly } from '../lib/plan-coherence.mjs';
import { planStart } from '../lib/plan-ledger.mjs';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'coh-'));
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.js'), 'export const b = 2;\n');
  return root;
}

/**
 * ⚠️ WRITTEN BY THE REAL WRITER, NOT HAND-ROLLED JSON. My first version invented
 * the file shape — `status` instead of `state`, numeric ids, no `version` — and
 * `parsePlan` correctly refused all of it, so the run saw NO PLAN and the test
 * failed claiming the wiring was unreached. A fixture that is a guess about a
 * schema tests the guess.
 */
function plantPlan(root, task, steps) {
  const r = planStart(root, { task, steps }, { task });
  assert.ok(r.ok, `the fixture could not write a plan: ${r.ok ? '' : r.error}`);
}

const reply = (content, toolCalls = []) => ({
  ok: true, content, toolCalls, usage: { cost: 0.0005, total_tokens: 900 }, finishReason: 'stop', model: 'fake/model',
});
const call = (name, args) => ({ id: `c${Math.random().toString(36).slice(2, 7)}`, function: { name, arguments: JSON.stringify(args) } });

async function run(root, task, script, extra = {}) {
  const sent = [];
  const events = [];
  let i = 0;
  const model = async (opts) => {
    sent.push(opts.messages.map((m) => JSON.stringify(m)));
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return step;
  };
  const outcome = await runSession({
    task,
    executor: createLocalExecutor(root),
    config: { apiKey: 'x', model: 'fake/model' },
    maxRounds: 10,
    allowRun: false,
    callModelImpl: model,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { sent, events, outcome };
}

test('⭐⭐⭐ a run with a plan RECONCILES it — the model\'s own `done` is scored', async () => {
  const root = workspace();
  plantPlan(root, 'look at a.js and b.js', ['read a.js', 'read b.js', 'write c.js']);

  const { outcome } = await run(root, 'look at a.js and b.js', [
    reply('reading', [call('read_file', { path: 'a.js' })]),
    reply('reading', [call('read_file', { path: 'b.js' })]),
    reply('done'),
  ]);

  assert.ok(outcome.reconciliation, 'the run produced no reconciliation — plan-coherence is unreached again');
  assert.ok(Array.isArray(outcome.reconciliation.steps), 'reconciliation must report per STEP, not a total');
  assert.equal(outcome.reconciliation.steps.length, 3);
});

test('⚠️ a run with NO plan reports nothing rather than an empty reconciliation', async () => {
  /**
   * Most runs have no plan. An always-present object would put a block in every
   * summary that had nothing to reconcile — the noise `acceptance` avoids for
   * the same reason one field away.
   */
  const root = workspace();
  const { outcome } = await run(root, 'just say hi', [reply('hi')]);
  assert.equal(outcome.reconciliation ?? null, null);
});

test('⚠️⚠️ a plan from an EARLIER TASK is not reconciled against this one', async () => {
  /**
   * The regression this wiring caused on its first run, and the reason
   * `planForTask` exists. `.acuvo/plan.json` outlives the run that wrote it,
   * and `loadPlanQuietly` returns it regardless — so a foreign plan started
   * riding every round again through a brand new door, past a guard that had
   * already been built for exactly this.
   */
  const root = workspace();
  plantPlan(root, 'build a completely different thing', ['step one', 'step two']);
  const { outcome } = await run(root, 'look at a.js', [reply('done')]);
  assert.equal(outcome.reconciliation ?? null, null, 'another task\'s plan was reconciled against this run');
});

test('⭐⭐ every injection is APPEND-ONLY — an edit would cost 2.4x and turn nothing red', async () => {
  /**
   * `plan-coherence.mjs` exports `wasAppendOnly` precisely so this can be
   * asserted rather than remembered: a nudge spliced into the middle of the
   * conversation rewrites the cached prefix from that byte onward.
   *
   * ⭐ And the prefix instrument wired the same night would now CATCH it —
   * `usage.cache.prefix.driftRounds` would name the round. Two independent
   * pieces of tonight's work checking each other.
   */
  const root = workspace();
  plantPlan(root, 'look at a.js and b.js', ['read a.js', 'read b.js', 'write c.js', 'write d.js']);

  const { sent, outcome } = await run(root, 'look at a.js and b.js', [
    reply('poking', [call('read_file', { path: 'a.js' })]),
    reply('poking', [call('read_file', { path: 'a.js' })]),
    reply('poking', [call('list_dir', { path: '.' })]),
    reply('poking', [call('read_file', { path: 'b.js' })]),
    reply('poking', [call('list_dir', { path: '.' })]),
    reply('done'),
  ]);

  assert.ok(sent.length >= 3, `expected several rounds, got ${sent.length}`);
  for (let i = 1; i < sent.length; i += 1) {
    assert.ok(
      wasAppendOnly(sent[i - 1], sent[i]),
      `round ${i + 1} did not merely APPEND to round ${i} — a rewritten prefix costs the whole prompt`,
    );
  }

  // ⚠️ And the run's own instrument must agree, or one of the two is lying.
  const prefix = outcome.usage?.cache?.prefix;
  if (prefix) assert.deepEqual(prefix.driftRounds, [], 'the prefix instrument saw drift the append-only check did not');
});
