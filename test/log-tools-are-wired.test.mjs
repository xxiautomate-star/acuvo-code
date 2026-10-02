/**
 * ── ⭐⭐⭐ THE LOG TOOLS REACH A REAL LOG — THROUGH THE REAL DISPATCH ─────────
 *
 * `wait_for_output`, `read_log` and `summarize_log` were advertised to the model
 * in every run and refused 100% of them. `runLogTailTool` takes its log source
 * by injection — `readLog(id)` — and the production call site in `tools.mjs`
 * passed `{ executor }` alone. Nothing outside `log-tail.test.mjs` ever supplied
 * it, and `background.mjs` exported no such function at all.
 *
 * ⚠️ AND `log-tail.test.mjs` PASSED THE WHOLE TIME, because it injects its own
 * fake `readLog`. That is the trap: the unit test proved the ALGORITHM and could
 * never prove the WIRING, so a green suite reported a tool that always refused.
 *
 * ⭐ SO THIS FILE DELIBERATELY INJECTS NOTHING. It starts a real process, and
 * calls `executeToolCall` — the same entry the model's tool calls go through.
 * If the call site ever drops `readLog` again, these fail.
 *
 * Measured cost of the defect, from a real Terminal-Bench trial: the agent asked
 * for `wait_for_output` by name in round 17, was refused, and spent 53 of its 84
 * rounds on a `sleep N` → `check_process` ping-pong instead.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startBackground, stopAllBackground, readLog } from '../lib/background.mjs';
import { executeToolCall } from '../lib/tools.mjs';

const made = [];
after(() => {
  stopAllBackground();
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows handle lag */ } }
});

/** A workspace whose one script prints a banner after a beat, then keeps going. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-logwire-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"lw","version":"1.0.0"}\n');
  writeFileSync(join(root, 'slow.mjs'), [
    "console.log('booting');",
    "setTimeout(() => console.log('SERVER READY on 4173'), 150);",
    // Stay alive so the tools see a RUNNING process, which is the real case.
    'setTimeout(() => {}, 10_000);',
  ].join('\n'));
  return { root, dryRun: false, readFile: () => null };
}

const call = (name, args) => ({ id: 'c_1', function: { name, arguments: JSON.stringify(args) } });

test('⭐⭐ wait_for_output blocks on a REAL process and returns the line', async () => {
  const ex = workspace();
  const started = startBackground({ command: 'node slow.mjs', executor: ex });
  assert.equal(started.ok, true, started.error);

  const rec = await executeToolCall(
    call('wait_for_output', { id: started.id, contains: 'SERVER READY', timeoutMs: 8000 }),
    ex,
  );

  /**
   * ⚠️ THE ASSERTION THAT CATCHES THE REGRESSION. An unwired call site answers
   * "the log tools are not wired to a log source in this run" — which is an
   * `ok:false`, not a throw, so anything checking only for absence of an
   * exception would have passed against the broken code.
   */
  assert.doesNotMatch(JSON.stringify(rec.result), /not wired to a log source/);
  assert.equal(rec.result.ok, true, JSON.stringify(rec.result));
  assert.match(String(rec.result.text ?? rec.result.matched ?? ''), /SERVER READY/);
});

test('⭐ read_log returns what the process actually printed', async () => {
  const ex = workspace();
  const started = startBackground({ command: 'node slow.mjs', executor: ex });
  assert.equal(started.ok, true, started.error);

  // Let the first line land before reading.
  await executeToolCall(call('wait_for_output', { id: started.id, contains: 'booting', timeoutMs: 8000 }), ex);

  const rec = await executeToolCall(call('read_log', { id: started.id }), ex);
  assert.equal(rec.result.ok, true, JSON.stringify(rec.result));
  assert.match(String(rec.result.text ?? ''), /booting/);
});

test('⚠️ an unknown id NAMES the ids that exist, rather than dead-ending', () => {
  const ex = workspace();
  const started = startBackground({ command: 'node slow.mjs', executor: ex });
  assert.equal(started.ok, true, started.error);

  const missing = readLog('bg-nope');
  assert.equal(missing.ok, false);
  /**
   * "no background process" alone sends the model guessing at ids. Listing the
   * live ones turns a dead end into the next call.
   */
  assert.match(missing.error, new RegExp(started.id));
});

test('⚠️ readLog returns the ring buffer WHOLE — log-tail owns the cursor', () => {
  const ex = workspace();
  const started = startBackground({ command: 'node slow.mjs', executor: ex });
  const got = readLog(started.id);
  assert.equal(typeof got.text, 'string');
  assert.equal(got.running, true);
  // Tailing here would silently drop the lines a cursor was about to resume from.
  assert.equal(got.exitCode, null);
});
