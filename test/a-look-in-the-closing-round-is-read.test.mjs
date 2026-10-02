/**
 * ── ⚠️⭐ A LOOK TAKEN IN THE CLOSING ROUND IS READ BEFORE THE RUN ENDS (2026-09-26) ─
 *
 * Found by using the CLI on a real task: *"…open it in a browser and check that
 * adding two items shows the right total before you finish."* The grace round ran
 * `npm test` and `see_page` together; the second green test closed the run, the
 * model never saw the page, and the summary said VERIFIED on a check nobody asked
 * for. A look in the closing round now buys exactly one more round, once.
 *
 * Same harness as `four-questions-reach.test.mjs`: a real executor and a REAL
 * passing `node --test`, because `doneDecision` reads `result.passed`, which only
 * a process that ran can set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-look-read-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n", 'utf8');
  writeFileSync(join(dir, 'page.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  return dir;
}

/** Every round: a passing test, plus (optionally) a look at an image. */
function model(counter, { look }) {
  return async () => {
    counter.rounds += 1;
    const calls = [{ id: `v${counter.rounds}`, function: { name: 'run_command', arguments: JSON.stringify({ command: 'node --test ok.test.mjs' }) } }];
    if (look) calls.push({ id: `l${counter.rounds}`, function: { name: 'read_image', arguments: JSON.stringify({ path: 'page.png' }) } });
    return { ok: true, content: 'checking', toolCalls: calls, usage: null, finishReason: 'tool_calls' };
  };
}

const base = (dir, callModelImpl, events) => ({
  task: 'fix it and check the page',
  executor: createLocalExecutor(dir),
  config: { apiKey: 'test', model: 'test/model' },
  callModelImpl,
  maxRounds: 8,
  budgetUsd: null,
  onEvent: (e) => events.push(e),
});

test('without a look, the default still closes after one grace round', async (t) => {
  const counter = { rounds: 0 }; const events = [];
  const outcome = await runSession(base(workspace(t), model(counter, { look: false }), events));
  assert.equal(outcome.stoppedBecause, 'verified');
  assert.equal(counter.rounds, 2);
  assert.ok(!events.some((e) => e.reason === 'verified-look-pending'));
});

test('a look in the closing round buys exactly one round to read it', async (t) => {
  const counter = { rounds: 0 }; const events = [];
  const outcome = await runSession(base(workspace(t), model(counter, { look: true }), events));
  assert.equal(outcome.stoppedBecause, 'verified');
  assert.equal(counter.rounds, 3, `took ${counter.rounds} rounds`);
  assert.equal(events.filter((e) => e.reason === 'verified-look-pending').length, 1);
  const told = outcome.messages.filter((m) => m.role === 'user' && String(m.content).includes('You also looked at the page this round'));
  assert.equal(told.length, 1, 'the model was not told to read what it looked at');
});
