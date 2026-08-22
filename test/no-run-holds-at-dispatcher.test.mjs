/**
 * ── ⚠️⚠️ `--no-run` WAS HELD AT THE OFFER AND NOWHERE ELSE ──────────────────
 *
 * `tools.mjs` already states the rule, at `run_program`'s own dispatcher guard:
 * *"a model can emit a call for a tool it was never shown (a resumed session, a
 * stale conversation, a provider echoing an old tool list), and the flag has to
 * hold at the point the process would actually start."*
 *
 * Two tools did not follow it. MEASURED 2026-08-14, through the real
 * `executeToolCall` with `allowRun: false`, in a real workspace:
 *
 *   run_program    → refused, correctly
 *   repl           → RAN THE CODE — `1+1` came back as "2"
 *   start_process  → STARTED A REAL SERVER, pid 780, still in the registry
 *                    after the call returned
 *
 * ⭐ `start_process` is the sharper of the two, and it is why this file exists
 * rather than a line in an existing one: a background process is the ONE thing
 * in this package that outlives the round that started it. So `--no-run` could
 * finish, report that nothing was executed, and leave a server holding a port —
 * the flag's single promise, broken in the most durable way available.
 *
 * ⚠️ AND THE OTHER HALF OF THE FIX IS WHAT IS **NOT** GATED. `stop_process` and
 * `repl_reset` execute nothing; they KILL a child. Refusing the cleanup verbs
 * under a flag about running things would strand exactly what the flag exists to
 * prevent — the orphan `background.mjs`'s header says this repo has already paid
 * for twice, once with a pid that ran until reboot.
 *
 * ⭐ $0.00, no key, no network: every subject is a `node` child process.
 */

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeToolCall, toolNamesForRounds } from '../lib/tools.mjs';
import { listBackground, stopAllBackground } from '../lib/background.mjs';
import { replStopAll } from '../lib/repl.mjs';

/**
 * ⚠️ THE REGISTRY IS MODULE-LEVEL AND CAPPED AT FOUR, so one test that leaks a
 * live process makes later ones fail for a reason that has nothing to do with
 * what they assert. Found while mutation-testing this file: killing the
 * start_process guard reddened the CLEANUP test too, which would have made the
 * mutation signal unreadable — a red test must name its own cause.
 */
beforeEach(() => { stopAllBackground(); replStopAll(); });

const made = [];
after(() => {
  stopAllBackground();
  replStopAll();
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** A server that would bind a port and keep running — the durable failure. */
const SERVER = `
import { createServer } from 'node:http';
const argv = process.argv.slice(2);
createServer((_q, r) => { r.writeHead(200); r.end('ok'); })
  .listen(Number(argv[argv.indexOf('--port') + 1]), '127.0.0.1', () => console.log('listening'));
`;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-norun-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"n","version":"1.0.0","type":"module"}\n');
  writeFileSync(join(root, 'server.mjs'), SERVER);
  return {
    root,
    dryRun: false,
    readFile: (rel) => {
      try { return { ok: true, content: readFileSync(join(root, rel), 'utf8') }; } catch (e) { return { ok: false, error: e.message }; }
    },
  };
}

/**
 * ⚠️ THE REAL DISPATCHER, IN ITS REAL CALL SHAPE. Calling `runBackgroundTool` or
 * `runReplTool` directly would test the module and MISS the bug entirely — the
 * bug was never in those modules, it was in the dispatcher that reaches them.
 */
const call = (executor, name, args, allowRun) => executeToolCall(
  { id: 'c', function: { name, arguments: JSON.stringify(args) } },
  executor,
  { allowRun },
);

// ── ⚠️ THE OFFER, WHICH WAS ALREADY CORRECT AND IS NOT THE POINT ───────────

test('the offer withholds both tools under --no-run — this half always worked', () => {
  const names = toolNamesForRounds(40, { allowRun: false, root: process.cwd() });
  assert.equal(names.includes('start_process'), false);
  assert.equal(names.includes('repl'), false);
  // ⭐ And it OFFERS them normally, or the test below would pass vacuously.
  const open = toolNamesForRounds(40, { allowRun: true, root: process.cwd() });
  assert.equal(open.includes('start_process'), true);
  assert.equal(open.includes('repl'), true);
});

// ── ⭐⭐ THE GAP: A CALL THAT ARRIVES ANYWAY ────────────────────────────────

test('⭐⭐ start_process is refused at the DISPATCHER, so --no-run cannot leave a server running', async () => {
  const ex = workspace();
  const r = await call(ex, 'start_process', {
    program: 'node', args: ['server.mjs', '--port', '4531'],
  }, false);

  assert.equal(r.result.ok, false, 'a --no-run run must not start a process');
  assert.match(r.result.error, /--no-run/);
  assert.match(r.result.error, /outlive/, 'and it says WHY this one is worse than a command that exits');
  /**
   * ⭐ THE ASSERTION THAT ACTUALLY MATTERS. An error string is cheap; an empty
   * registry is the fact. Before the fix this list held one live record.
   */
  assert.deepEqual(listBackground(), [], 'nothing may be left running behind a --no-run run');
});

test('⭐ the string form is refused too — the gate is on the verb, not on the input shape', async () => {
  const ex = workspace();
  const r = await call(ex, 'start_process', { command: 'node server.mjs' }, false);
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /--no-run/);
  assert.deepEqual(listBackground(), []);
});

test('⭐⭐ repl is refused at the DISPATCHER — it runs the workspace\'s JavaScript for real', async () => {
  const ex = workspace();
  const r = await call(ex, 'repl', { code: 'globalThis.__norun_ran = true; 1+1' }, false);
  assert.equal(r.result.ok, false, 'a --no-run run must not execute code');
  assert.match(r.result.error, /--no-run/);
  /**
   * ⚠️ AND THE VALUE MUST NOT BE THERE. Measured before the fix: `value: "2"`.
   * Asserting only on the error string would still pass if the code ran and the
   * refusal were bolted on afterwards.
   */
  assert.equal(r.result.value, undefined, 'the code must not have run');
});

// ── ⚠️ THE CLEANUP VERBS STAY OPEN, ON PURPOSE ─────────────────────────────

test('⚠️ stop_process and repl_reset are NOT gated — refusing cleanup would strand a process', async () => {
  const ex = workspace();

  /**
   * ⭐ Started with `allowRun: true` (the normal run), then cleaned up under
   * `--no-run`. That is the real sequence this guard must not break: a flag
   * flip, a resumed session, or a second executor reaching the same registry.
   */
  const started = await call(ex, 'start_process', {
    program: 'node', args: ['server.mjs', '--port', '4532'],
  }, true);
  assert.equal(started.result.ok, true, started.result.error);

  const checked = await call(ex, 'check_process', { id: started.result.id }, false);
  assert.equal(checked.result.ok, true, 'reading a buffer executes nothing and must stay available');

  const stopped = await call(ex, 'stop_process', { id: started.result.id }, false);
  assert.equal(stopped.result.ok, true, 'the KILL verb must never be withheld by --no-run');
  assert.deepEqual(listBackground(), [], 'and it really stopped it');

  const reset = await call(ex, 'repl_reset', {}, false);
  assert.equal(reset.result.ok, true, 'repl_reset kills a child rather than running one');
});

// ── the flag must not break the ordinary run ───────────────────────────────

test('with allowRun true, both tools still work exactly as before', async () => {
  const ex = workspace();
  const r = await call(ex, 'repl', { code: 'const z=5; z*2' }, true);
  assert.equal(r.result.ok, true, r.result.error);
  assert.equal(r.result.value, '10', 'the guard must not have changed the normal path');
  await call(ex, 'repl_reset', {}, true);

  const started = await call(ex, 'start_process', {
    program: 'node', args: ['server.mjs', '--port', '4533'],
  }, true);
  assert.equal(started.result.ok, true, started.result.error);
  await call(ex, 'stop_process', { id: started.result.id }, true);
});
