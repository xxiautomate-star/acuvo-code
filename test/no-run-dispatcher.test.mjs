/**
 * ── ⚠️⚠️ `--no-run` RAN THE COMMAND ANYWAY ──────────────────────────────────
 *
 * `run_program` checks `allowRun` at the DISPATCHER, and its comment states the
 * reason precisely: "a model can emit a call for a tool it was never shown (a
 * resumed session, a stale conversation, a provider echoing an old tool list),
 * and the flag has to hold at the point the process would actually start."
 *
 * ⚠️ EVERY WORD OF THAT APPLIED TO `run_command`, the tool the model reaches
 * for constantly, and it was the one without the check. Reproduced before the
 * fix: `executeToolCall({name:'run_command', command:'npm install
 * evil-package'}, executor, {allowRun:false})` returned `{ok:true,
 * exitCode:0}`, and the executor really ran it.
 *
 * ⚠️ AND AN EXECUTOR WITH ITS OWN RUNNER MADE IT WORSE. `executor.runCommand`
 * is called directly, bypassing `executeRunCommand` entirely — so any gate
 * living downstream was not on that path at all. A flag whose enforcement
 * depends on which executor happens to be installed is not a flag.
 *
 * ⭐ THE ASSERTIONS COUNT WHAT THE EXECUTOR WAS ASKED TO RUN, not what the
 * result object says. A refusal that returns `{ok:false}` after the command has
 * already run would satisfy a result-shaped test and change nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { executeToolCall } from '../lib/tools.mjs';

/** An executor that owns its runner — the browser-builder shape, and the worse case. */
function spyExecutor() {
  const ran = [];
  return {
    ran,
    root: process.cwd(),
    runCommand: async (command) => { ran.push(command); return { ok: true, stdout: 'RAN', exitCode: 0 }; },
  };
}

const call = (name, args) => ({ id: 't1', function: { name, arguments: JSON.stringify(args) } });

test('⚠️⚠️ THE BUG: run_command with --no-run must not reach the executor', async () => {
  const ex = spyExecutor();
  const r = await executeToolCall(call('run_command', { command: 'npm install evil-package' }), ex, { allowRun: false });
  assert.deepEqual(ex.ran, [], 'the command was executed despite --no-run');
  assert.equal(r.result.ok, false);
});

test('⭐ the refusal SAYS --no-run, and says nothing was verified', async () => {
  const ex = spyExecutor();
  const r = await executeToolCall(call('run_command', { command: 'npm test' }), ex, { allowRun: false });
  assert.match(r.result.error, /--no-run/, 'the model has to learn which flag stopped it, or it retries forever');
  assert.match(r.result.error, /nothing was verified/,
    'a model told only "refused" will report the work as done');
});

test('⚠️ one flag, one explanation — run_command and run_program must not drift', async () => {
  /**
   * Two runners with two wordings teaches the model that they have two
   * policies, and it will go looking for the lenient one.
   */
  const ex = spyExecutor();
  const a = await executeToolCall(call('run_command', { command: 'ls' }), ex, { allowRun: false });
  const b = await executeToolCall(call('run_program', { program: 'ls', args: [] }), ex, { allowRun: false });
  const shape = (s) => String(s).replace(/\bcommand\b|\bprogram\b/g, '<x>');
  assert.equal(shape(a.result.error), shape(b.result.error),
    `the two refusals differ beyond the noun:\n  ${a.result.error}\n  ${b.result.error}`);
});

test('⭐ allowRun defaulting to true is untouched — the gate must not become the default', async () => {
  // A guard that accidentally refuses correct work is worse than none; this
  // package has paid for that four times in one day.
  const ex = spyExecutor();
  const r = await executeToolCall(call('run_command', { command: 'npm test' }), ex, {});
  assert.deepEqual(ex.ran, ['npm test'], 'an ordinary run must still execute');
  assert.equal(r.result.ok, true);
});

test('⭐ allowRun: true still runs — the flag is honoured, not inverted', async () => {
  const ex = spyExecutor();
  await executeToolCall(call('run_command', { command: 'echo hi' }), ex, { allowRun: true });
  assert.deepEqual(ex.ran, ['echo hi']);
});

test('⚠️ mutated stays false on the refusal — a refused command wrote nothing', async () => {
  // `mutated` feeds the "N files written" line, the one honest number in the
  // summary. A refusal that counted would put a phantom entry in it.
  const ex = spyExecutor();
  const r = await executeToolCall(call('run_command', { command: 'rm -rf /' }), ex, { allowRun: false });
  assert.equal(r.mutated, false);
});
