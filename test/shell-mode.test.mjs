/**
 * ── ⚠️⭐ `--shell`: THE ONE FLAG THAT REMOVES A GUARANTEE ────────────────────
 *
 * Every other flag in this CLI narrows what the agent may do. This one widens
 * it to every program on the machine, at the caller's own privileges. It exists
 * because the allowlist is a MEASURED ceiling, not a theoretical one: on our own
 * `polyglot` bench task the agent fixed a Python bug correctly, could not run
 * `pytest`, and — correctly — did not grant itself permission. Terminal-Bench is
 * largely tasks of exactly that shape.
 *
 * ⭐ SO THE LOCKED DEFAULT HAS TO SURVIVE INTACT, and most of this file exists
 * to prove it does. "It can only run node, npm, npx and tsc" must stay TRUE of
 * the default install, or the sentence we sell an enterprise becomes a
 * fact-with-an-asterisk.
 *
 * VERIFIED LIVE before these were written — default refused `echo hi | tr a-z
 * A-Z`, `git status` and `node x > out.txt`; with `--shell` all three ran, exit
 * 3 came back as 3, and the child's `OPENROUTER_API_KEY` was still **scrubbed**.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeRunCommand,
  buildShellInvocation,
  SHELL_MAX_COMMAND_LENGTH,
} from '../lib/command.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { toolSchemasFor, executeToolCall } from '../lib/tools.mjs';

const ws = () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-shell-'));
  return { root, executor: createLocalExecutor(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/** Captures the spawn without running anything. */
function fakeSpawn(seen) {
  return (file, args, opts) => {
    seen.push({ file, args, opts });
    const listeners = {};
    const child = {
      pid: 4242,
      stdout: { on: () => {}, setEncoding: () => {} },
      stderr: { on: () => {}, setEncoding: () => {} },
      on: (ev, fn) => { listeners[ev] = fn; return child; },
      kill: () => {},
    };
    setImmediate(() => listeners.close?.(0, null));
    return child;
  };
}

/* ── ⭐ the locked default, which must not move ──────────────────────────── */

test('⭐ DEFAULT still refuses a pipe', async () => {
  const w = ws();
  try {
    const r = await executeRunCommand({ command: 'echo hi | tr a-z A-Z', executor: w.executor });
    assert.equal(r.ok, false);
    assert.match(r.error, /not allowed in a command/);
  } finally { w.cleanup(); }
});

test('⭐ DEFAULT still refuses a program outside the allowlist', async () => {
  const w = ws();
  try {
    const r = await executeRunCommand({ command: 'git status', executor: w.executor });
    assert.equal(r.ok, false);
    assert.match(r.error, /"git" is not a program this agent may run/);
  } finally { w.cleanup(); }
});

test('⭐ DEFAULT still refuses redirection', async () => {
  const w = ws();
  try {
    const r = await executeRunCommand({ command: 'node x.mjs > out.txt', executor: w.executor });
    assert.equal(r.ok, false);
    assert.match(r.error, /not allowed/);
  } finally { w.cleanup(); }
});

test('⚠️⚠️ a caller that does not NAME shell never gets it', async () => {
  /**
   * ⚠️ The single most important test here. `shell` defaults to false in
   * `executeRunCommand`, in `executeToolCall` and in `runSession` — three
   * defaults, because a capability this large must be unreachable by a caller
   * who merely forgot a flag, not merely discouraged.
   */
  const w = ws();
  const seen = [];
  try {
    await executeRunCommand({ command: 'node -v', executor: w.executor, spawnImpl: fakeSpawn(seen) });
    assert.equal(seen.length, 1);
    assert.equal(/(^|[\\/])(sh|bash|cmd\.exe)$/i.test(seen[0].file), false, `a shell was spawned without being asked for: ${seen[0].file}`);
  } finally { w.cleanup(); }
});

/* ── the shell invocation itself ──────────────────────────────────────────── */

test('posix hands the line to sh -c', () => {
  const r = buildShellInvocation('echo hi | tr a-z A-Z', { platform: 'linux', env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.file, '/bin/sh');
  assert.deepEqual(r.args, ['-c', 'echo hi | tr a-z A-Z']);
});

test('⚠️ windows passes /d, which disables AutoRun', () => {
  /**
   * ⚠️ WITHOUT `/d`, cmd.exe RUNS SOMEONE ELSE'S SCRIPT FIRST. Whatever sits in
   * HKCU\\Software\\Microsoft\\Command Processor\\AutoRun executes before our
   * command — inside what the audit log records as ours.
   */
  const r = buildShellInvocation('dir', { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } });
  assert.equal(r.ok, true);
  assert.equal(r.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(r.args, ['/d', '/s', '/c', 'dir']);
});

test('an empty command is refused rather than spawning an idle shell', () => {
  assert.equal(buildShellInvocation('   ', { platform: 'linux', env: {} }).ok, false);
});

test('⚠️ an over-long line is refused, with the number and a way forward', () => {
  const r = buildShellInvocation('echo '.padEnd(SHELL_MAX_COMMAND_LENGTH + 10, 'x'), { platform: 'linux', env: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp(String(SHELL_MAX_COMMAND_LENGTH)));
  assert.match(r.error, /script file/, 'a limit with no alternative costs a round');
});

/* ── shell mode actually running ──────────────────────────────────────────── */

test('⭐ with shell:true a pipeline runs and the shell is what gets spawned', async () => {
  const w = ws();
  const seen = [];
  try {
    const r = await executeRunCommand({ command: 'echo hi | tr a-z A-Z', executor: w.executor, shell: true, spawnImpl: fakeSpawn(seen) });
    assert.equal(r.ok, true);
    assert.equal(r.viaShell, true, 'the result must say a shell ran this, so the audit does not have to re-derive it');
    assert.equal(seen.length, 1);
    assert.ok(/(sh|cmd\.exe)$/i.test(seen[0].file), `expected a shell, got ${seen[0].file}`);
    assert.ok(seen[0].args.join(' ').includes('echo hi | tr a-z A-Z'));
  } finally { w.cleanup(); }
});

test('⚠️ the child is STILL spawned with shell:false, cwd in the workspace, and no API key', async () => {
  /**
   * ⚠️ THE SHELL IS INVOKED AS A PROGRAM, NOT VIA node's `shell: true`. That is
   * what keeps `spawnBounded` byte-identical — so the timeout, the process-TREE
   * kill, the output caps and the environment scrub all still apply. Those
   * guarantees cost nothing to keep, so losing them would be carelessness
   * rather than a trade.
   */
  const w = ws();
  const seen = [];
  const before = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-secret';
  try {
    await executeRunCommand({ command: 'printenv', executor: w.executor, shell: true, spawnImpl: fakeSpawn(seen) });
    assert.equal(seen[0].opts.shell, false, 'node must not add a SECOND layer of shell parsing');
    assert.equal(seen[0].opts.cwd, w.root);
    assert.equal(seen[0].opts.env.OPENROUTER_API_KEY, undefined, 'the API key reached a shell-mode child');
  } finally {
    if (before === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = before;
    w.cleanup();
  }
});

test('⚠️ --dry-run still refuses, even with shell on', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-shell-dry-'));
  try {
    const executor = createLocalExecutor(root, { dryRun: true });
    const r = await executeRunCommand({ command: 'rm -rf .', executor, shell: true, spawnImpl: () => { throw new Error('must not spawn'); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /dry-run/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── ⚠️ the schema has to tell the truth about the mode ──────────────────── */

test('⚠️⚠️ under shell the run_command description no longer claims there is NO SHELL', () => {
  /**
   * ⚠️ A LIE HERE SILENTLY DISABLES THE FEATURE. The model reads the tool
   * description, believes pipes are impossible, and never tries — so the flag
   * the operator deliberately enabled does nothing, and nothing errors, so
   * nobody finds out. A capability the model is told it does not have is a
   * capability it does not have.
   */
  const locked = toolSchemasFor(['run_command']);
  assert.match(locked[0].function.description, /There is NO SHELL/);

  const open = toolSchemasFor(['run_command'], { shell: true });
  assert.equal(/There is NO SHELL/.test(open[0].function.description), false);
  assert.match(open[0].function.description, /A SHELL IS AVAILABLE/);
  assert.match(open[0].function.description, /any program installed on this machine/);
});

test('the shell description swap touches ONLY run_command', () => {
  const names = ['read_file', 'run_command', 'write_file'];
  const locked = toolSchemasFor(names);
  const open = toolSchemasFor(names, { shell: true });
  for (const n of ['read_file', 'write_file']) {
    const a = locked.find((t) => t.function.name === n);
    const b = open.find((t) => t.function.name === n);
    assert.equal(a.function.description, b.function.description, `${n} was rewritten and should not have been`);
  }
});

test('⭐ the dispatcher passes shell through — built is not wired', async () => {
  /**
   * ⚠️ THE FAILURE THIS CATCHES HAS HAPPENED FOUR TIMES IN THIS PACKAGE: a
   * capability finished, tested at module level, and reached by nothing. A
   * `--shell` that the dispatcher never forwards is a flag that lies.
   */
  const w = ws();
  const seen = [];
  try {
    const call = { id: 'c1', function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo a | wc -l' }) } };
    const off = await executeToolCall(call, w.executor, { spawnImpl: fakeSpawn(seen) });
    assert.equal(off.result.ok, false, 'without shell the pipe must still be refused through the dispatcher');

    const on = await executeToolCall(call, w.executor, { shell: true });
    assert.equal(on.result.ok, true, 'the dispatcher dropped the shell flag');
    assert.equal(on.result.viaShell, true);
  } finally { w.cleanup(); }
});
