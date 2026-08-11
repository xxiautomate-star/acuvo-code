/**
 * ── ⚠️ CTRL-C USED TO ORPHAN EVERY MCP SERVER, AND EVERY TURN LEAKED A LISTENER ─
 *
 * Two failures that live on the same line of `turn.mjs`, both measured on this
 * machine rather than reasoned about:
 *
 *   (a) `process.once('exit', cleanup)` was registered PER SESSION, and an
 *       interactive chat calls `runSession` once per turn. Turn 11 printed
 *       Node's MaxListenersExceededWarning into the middle of the user's
 *       conversation — a memory-leak warning about acuvo that reads like a bug
 *       in the project they are working on.
 *   (b) An 'exit' listener does NOT run on a signal. Measured for SIGINT,
 *       SIGTERM and SIGKILL: the handler never fired. So the one line whose
 *       comment promised the CLI "cannot leave orphaned processes behind" was
 *       inert on the exact path it was written for — Ctrl-C — and two true
 *       orphans from acuvo-code runs were found and killed here tonight.
 *
 * ⚠️ THE SIGNAL HALF IS TESTED IN A CHILD PROCESS, ON PURPOSE. The handler must
 * call `process.exit` itself (registering a SIGINT listener suppresses Node's
 * default terminate-on-Ctrl-C, and chat.mjs drives a readline), so proving it
 * works means proving something exits. Doing that in-process would take the test
 * runner with it.
 *
 * ⚠️ AND IT EMITS THE EVENT RATHER THAN SENDING A REAL SIGNAL, because Windows
 * has no POSIX signals: `process.kill(pid, 'SIGINT')` there terminates the
 * target unconditionally without ever running a listener, so a real-signal test
 * would pass vacuously on the platform this CLI is developed on. `process.emit`
 * exercises the same listener Node itself invokes on delivery.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** A model that answers instantly and asks for nothing — the session shape is
 *  what is under test, not the conversation. */
const SILENT_MODEL = async () => ({
  ok: true,
  content: 'nothing to do',
  toolCalls: [],
  usage: null,
  finishReason: 'stop',
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-lifecycle-'));
  writeFileSync(join(dir, 'index.js'), 'export const x = 1;\n');
  return dir;
}

test('many turns register exactly one exit listener, not one per turn', async (t) => {
  const dir = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const before = process.listenerCount('exit');
  for (let i = 0; i < 6; i += 1) {
    const outcome = await runSession({
      task: `turn ${i}`,
      executor: createLocalExecutor(dir),
      config: { apiKey: 'not-used', model: 'stub' },
      maxRounds: 1,
      allowRun: false,
      callModelImpl: SILENT_MODEL,
    });
    assert.equal(outcome.ok, true, 'the stubbed session should complete');
  }
  const added = process.listenerCount('exit') - before;

  // One hook for the life of the PROCESS. Before the fix this was 6, and at 11
  // Node starts printing a leak warning at whoever is using the CLI.
  assert.equal(added, 1, `runSession added ${added} exit listeners across 6 turns`);
});

test('Ctrl-C runs the MCP cleanup and exits 130 instead of falling through', () => {
  const dir = workspace();
  const script = join(dir, 'interrupt-probe.mjs');
  writeFileSync(
    script,
    `import { runSession } from ${JSON.stringify(pathToFileURL(join(REPO, 'lib/turn.mjs')).href)};
import { createLocalExecutor } from ${JSON.stringify(pathToFileURL(join(REPO, 'lib/workspace.mjs')).href)};

await runSession({
  task: 'probe',
  executor: createLocalExecutor(process.argv[2]),
  config: { apiKey: 'not-used', model: 'stub' },
  maxRounds: 1,
  allowRun: false,
  callModelImpl: async () => ({ ok: true, content: 'x', toolCalls: [], usage: null, finishReason: 'stop' }),
});

console.log('SIGINT_LISTENERS=' + process.listeners('SIGINT').length);
// Node invokes exactly these listeners when a real Ctrl-C arrives.
process.emit('SIGINT');
// Reached only if nothing handled it — i.e. the interrupt path is still inert.
console.log('FELL_THROUGH');
`,
    'utf8',
  );

  try {
    const run = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', timeout: 60_000 });
    const out = `${run.stdout}${run.stderr}`;
    assert.match(out, /SIGINT_LISTENERS=1/, `no SIGINT handler was installed:\n${out}`);
    assert.doesNotMatch(out, /FELL_THROUGH/, `SIGINT did not stop the process:\n${out}`);
    // 128 + SIGINT(2). Not 1 — bin/acuvo.mjs spends exit 1 on "the code it wrote
    // still does not pass", and an interrupt is not that answer.
    assert.equal(run.status, 130, `expected exit 130, got ${run.status}:\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
