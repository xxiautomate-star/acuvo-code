/**
 * ── ⭐⭐⭐ A GREEN VERDICT ABOUT THE WRONG THING ─────────────────────────────
 *
 * MEASURED (`largest-eigenval`): the session exited `ok: true`,
 * `stoppedBecause: "verified"` at round 9 of 16, on less than half its budget,
 * with its own acceptance check reading `unmet` — and its writes listed only
 * scratch files. It never touched `eigen.py`, the one file the task names.
 *
 * A command really did pass. That is what makes this the most expensive kind of
 * wrong answer: nothing about it looks wrong. `promisedButMissing` cannot catch
 * it, because that scans the model's PROSE — and prose that never claims the
 * file never trips it. This scans the REQUEST.
 *
 * ⚠️ THE ABSENT-FROM-DISK CONDITION IS WHAT KEEPS IT QUIET. Tasks name files
 * they want READ far more often than files they want CREATED, and those exist.
 * A warning that fires on almost every task is one nobody reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

/** A model that answers once, runs nothing, writes nothing, and stops. */
const idleModel = async () => ({
  ok: true,
  content: 'All done.',
  usage: { cost: 0.001, total_tokens: 100 },
  finishReason: 'stop',
  toolCalls: [],
});

function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-absent-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  return root;
}

test('⭐⭐ REACH: the file the TASK named, never written and not on disk, is reported', async () => {
  const root = workspace();
  try {
    const outcome = await runSession({
      task: 'implement eigen.py so it returns the largest eigenvalue',
      executor: createLocalExecutor(root),
      config: { apiKey: 'k', model: 'm' },
      maxRounds: 3,
      callModelImpl: idleModel,
    });
    assert.deepEqual(outcome.askedForButAbsent, ['eigen.py']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️⚠️ a file the task names that ALREADY EXISTS is never reported', async () => {
  /**
   * The common case by far — "fix the bug in parser.js". Not writing it may be
   * perfectly correct, and reporting it would make the warning worthless.
   */
  const root = workspace({ 'parser.js': 'export const x = 1;\n' });
  try {
    const outcome = await runSession({
      task: 'fix the bug in parser.js',
      executor: createLocalExecutor(root),
      config: { apiKey: 'k', model: 'm' },
      maxRounds: 3,
      callModelImpl: idleModel,
    });
    assert.deepEqual(outcome.askedForButAbsent, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ a file the task named AND the session wrote is not reported', async () => {
  const root = workspace();
  /**
   * ⚠️ TWO RESPONSES, AND `finishReason` MATTERS. Emitting tool calls alongside
   * `stop` does not run them — the first version of this test did exactly that
   * and then blamed the code for a write that never happened.
   */
  let turn = 0;
  const writer = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        ok: true,
        content: 'writing it now',
        usage: { cost: 0.001, total_tokens: 100 },
        finishReason: 'tool_calls',
        /**
         * ⚠️ THE NESTED `function: { name, arguments }` SHAPE, WITH ARGUMENTS AS
         * A STRING. A flat `{ id, name, arguments }` is accepted without
         * complaint and executes NOTHING — `executed` records `(unnamed): false`
         * and no file appears. My first two attempts at this test used the flat
         * form and blamed the code for a write that never happened.
         */
        toolCalls: [{ id: 'w1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'eigen.py', content: 'print(1)\n' }) } }],
      };
    }
    return { ok: true, content: 'done', usage: { cost: 0.001, total_tokens: 100 }, finishReason: 'stop', toolCalls: [] };
  };
  try {
    const outcome = await runSession({
      task: 'create eigen.py',
      executor: createLocalExecutor(root),
      config: { apiKey: 'k', model: 'm' },
      maxRounds: 2,
      callModelImpl: writer,
    });
    assert.deepEqual(outcome.askedForButAbsent, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
