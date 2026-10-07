import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TOOL_NAMES, toolNamesForRounds, executeToolCall } from '../lib/tools.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import {
  checkTools, probe, presetFor, allowlistInForce, MAX_PROGRAMS_PER_CALL,
} from '../lib/toolchain.mjs';
import { validateCommand, buildAllowlist, DEFAULT_ALLOWLIST } from '../lib/command.mjs';

/**
 * ── ⭐⭐ WHY THIS VERB EXISTS, IN NUMBERS FROM OUR OWN RUNS ──────────────────
 *
 * `bench/terminal-bench/results/` — 139 real runs. **201 `which` / `command -v`
 * segments in 52 of them**, the most hand-rolled shell idiom in the corpus with
 * no verb behind it; seven hard refusals of the shape *"python3 is not a program
 * this agent may run"*, each followed in the transcript by the model downgrading
 * to raw `run_command`; 31 exit-127 command-not-found.
 *
 * ⚠️ THE TEST THAT MATTERS IS THE AGREEMENT ONE, not the shape ones. An advisory
 * that disagrees with the gate is worse than no advisory: the model believes it,
 * writes the command, is refused anyway, and has paid for both. So the guard
 * below drives the REAL `validateCommand` rather than restating a list.
 */

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-toolchain-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return root;
}

const call = (args) => ({ id: 'c_1', function: { name: 'check_tools', arguments: JSON.stringify(args) } });

/* ════════════════════════════════════════════════════════════════════════════
 * 1. REACHABILITY — declared, dispatched AND offered. Any one missing is a
 *    capability that does not exist.
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ check_tools is declared, dispatched and OFFERED — all three', async (t) => {
  assert.ok(TOOL_NAMES.includes('check_tools'), 'check_tools is not in TOOL_SCHEMAS');

  const root = workspace(t);
  const rec = await executeToolCall(call({}), createLocalExecutor(root), { allowRun: true });
  assert.ok(!/unknown tool/.test(String(rec.result?.error ?? '')), 'declared but not dispatched');
  assert.equal(rec.result.ok, true, rec.result.error);

  const offered = toolNamesForRounds(8, { root, env: {}, allowRun: true });
  assert.ok(offered.includes('check_tools'), 'a multi-round run is never offered it');
});

/**
 * ⭐ THE POSITION IS THE HINT, and it is load-bearing rather than tidy: the
 * whole saving is the round NOT spent being refused, so a model reading the
 * offer top-down has to meet "what may I run" before "run this".
 */
test('⭐ it is wired AHEAD of run_command, because met afterwards it is a verb for apologising with', () => {
  const offered = toolNamesForRounds(8, { root: process.cwd(), env: {}, allowRun: true });
  assert.ok(offered.indexOf('check_tools') < offered.indexOf('run_command'),
    'check_tools must be declared before run_command in TOOL_SCHEMAS');
});

/**
 * ⚠️ THE OFFER RIDES WITH `allowRun`. Under `--no-run` the answer is "nothing,
 * regardless" — a button whose only possible reply is already known.
 */
test('⚠️ --no-run withholds it at the offer AND refuses it at the dispatcher', async (t) => {
  const root = workspace(t);
  const offered = toolNamesForRounds(8, { root, env: {}, allowRun: false });
  assert.ok(!offered.includes('check_tools'), 'offered under --no-run');

  const rec = await executeToolCall(call({}), createLocalExecutor(root), { allowRun: false });
  assert.equal(rec.result.ok, false);
  assert.match(rec.result.error, /--no-run/);
});

test('⚠️ single-shot turns are not offered it — there is no round after the answer', () => {
  assert.ok(!toolNamesForRounds(1, { root: process.cwd(), allowRun: true }).includes('check_tools'));
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. THE AGREEMENT GUARD — the reason to trust the answer at all.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️⚠️ THIS RUNS THE GATE. `validateCommand` is what actually refuses a command
 * at spawn time; a test that re-listed `ALLOWED_BINARIES` here would pass while
 * checking nothing, which is this repository's signature failure.
 */
test('⚠️⚠️ every binary it calls runnable really is accepted by validateCommand', (t) => {
  const root = workspace(t);
  const out = checkTools(createLocalExecutor(root), { env: {} });
  assert.equal(out.ok, true);
  assert.ok(out.runnable.length + (out.allowedButNotInstalled?.length ?? 0) > 0, 'no binaries reported at all');

  for (const bin of [...out.runnable, ...(out.allowedButNotInstalled ?? [])]) {
    const verdict = validateCommand(bin, { allowlist: DEFAULT_ALLOWLIST });
    // It may be refused for its OPERANDS (a bare `npm` has no subcommand); it
    // must never be refused for being an unknown program.
    assert.ok(!/not a program this agent may run|is not an allowed/i.test(String(verdict.error ?? '')),
      `check_tools claims ${bin} is allowed, and the gate refuses the binary: ${verdict.error}`);
  }
});

/**
 * ⭐ AND THE OTHER DIRECTION, WHICH IS THE ONE THAT WOULD ACTUALLY MISLEAD: a
 * binary a preset provides must NOT be reported allowed while the preset is off.
 */
test('⭐ a preset binary is reported NOT runnable until the preset is on, and the enable line is the real one', (t) => {
  /**
   * ⚠️ NO `pyproject.toml` HERE, AND THAT IS THE POINT. `executeRunCommand`
   * auto-enables a preset a project's own files declare, so a Python marker in
   * this workspace would make python legitimately allowed and the assertion
   * below would be testing the fixture rather than the rule.
   */
  const root = workspace(t);
  writeFileSync(join(root, 'index.js'), 'export const a = 1;\n');

  /**
   * ⚠️⚠️ THE PATH IS SYNTHETIC AND THAT IS THE WHOLE TEST. My first draft wrote
   * `if (entry.installed) { … }` and a mutation that made EVERY program runnable
   * SURVIVED it — because this machine has no `python` on PATH, so the guarded
   * assertion never executed. A conditional assertion is a check that cannot
   * fail, and it passed while checking nothing for exactly one run of the
   * mutation harness. Planting the binary makes `installed` a fact.
   */
  const path = mkdtempSync(join(tmpdir(), 'acuvo-fakepath-'));
  t.after(() => { try { rmSync(path, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  writeFileSync(join(path, 'python'), '#!/bin/sh\n');
  writeFileSync(join(path, 'python.exe'), 'MZ');

  const off = checkTools(createLocalExecutor(root), { programs: ['python'], env: { PATH: path } });
  assert.equal(off.ok, true);
  const entry = off.programs[0];
  assert.equal(entry.name, 'python');
  assert.equal(entry.installed, true, 'the planted binary was not found — the fixture, not the code, is wrong');
  assert.equal(entry.runnable, false, 'python was called runnable with no preset enabled');
  assert.match(entry.enableWith, /presets.*python/);

  const on = checkTools(createLocalExecutor(root), { programs: ['python'], env: { PATH: path, ACUVO_ALLOW_COMMANDS: 'python' } });
  assert.ok(on.presetsOn.includes('python'), 'ACUVO_ALLOW_COMMANDS=python did not reach the answer');
  assert.equal(on.programs[0].runnable, true,
    'with the preset on and the binary present, it must be runnable');
  // and the gate agrees
  const withPreset = buildAllowlist({ presets: ['python'] });
  assert.ok(withPreset.binaries.includes('python'));
});

/**
 * ⚠️ THE AUTO-DETECT BRANCH — `command.mjs`'s "a project that declares its
 * language gets that language". Its condition is `sources.length === 0`, NOT
 * `presets.length === 0`; getting that wrong makes this verb under-report on
 * exactly the Python and Go repositories it exists to serve.
 */
test('⚠️ a Python repo with no config auto-detects, exactly as run_command does', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname="x"\n');
  const state = allowlistInForce(createLocalExecutor(root), {});
  assert.equal(state.ok, true);
  assert.ok(state.presetsOn.includes('python'), 'detectPresets did not reach the answer');
  assert.ok(state.binaries.includes('python'));
  assert.equal(state.stated, false);
});

test('⚠️ and an explicit config still wins — detection never overrules a human', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname="x"\n');
  const state = allowlistInForce(createLocalExecutor(root), { ACUVO_ALLOW_COMMANDS: 'go' });
  assert.deepEqual(state.presetsOn, ['go'], 'auto-detection overruled a stated source');
  assert.ok(!state.binaries.includes('python'));
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. THE NAME GUARD — a PATH probe must never become a filesystem probe.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️⚠️ `probe` JOINS EACH PATH DIRECTORY TO THE STRING IT IS GIVEN. Without the
 * shape rule, `check_tools {"programs":["../../../etc/shadow"]}` is a
 * directory-listing oracle a model can drive on somebody else's machine.
 */
test('⚠️⚠️ a path is refused, not probed', (t) => {
  const root = workspace(t);
  const ex = createLocalExecutor(root);
  for (const bad of ['/usr/bin/python3', '../node', 'C:\\Windows\\System32\\cmd.exe', './x', 'a/b', '..', '-rf', '']) {
    const out = checkTools(ex, { programs: [bad], env: {} });
    assert.equal(out.ok, false, `${JSON.stringify(bad)} was accepted as a program name`);
    assert.match(out.error, /plain program name/);
  }
});

test('⚠️ the ask is bounded, and the refusal says the number rather than truncating', (t) => {
  const root = workspace(t);
  const many = Array.from({ length: MAX_PROGRAMS_PER_CALL + 1 }, (_, i) => `p${i}`);
  const out = checkTools(createLocalExecutor(root), { programs: many, env: {} });
  assert.equal(out.ok, false);
  assert.match(out.error, new RegExp(String(MAX_PROGRAMS_PER_CALL)));
});

test('⚠️ programs must be an array, and the refusal names the way out', (t) => {
  const root = workspace(t);
  const out = checkTools(createLocalExecutor(root), { programs: 'python3', env: {} });
  assert.equal(out.ok, false);
  assert.match(out.error, /array/);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. probe() — PATH resolution, including the Windows rule that makes
 *    "installed" a lie.
 * ════════════════════════════════════════════════════════════════════════════ */

test('probe finds a real file on a synthetic PATH, and misses what is not there', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'zzfake'), '#!/bin/sh\n');
  // ⚠️ A Windows temp dir (`C:\...`) split on the posix ':' is two bogus entries,
  // so the synthetic PATH is read with the HOST's own rule.
  const plat = process.platform === 'win32' ? 'win32' : 'linux';
  assert.deepEqual(probe('zzfake', { PATH: root }, plat), { installed: true, spawnable: true });
  assert.deepEqual(probe('zznope', { PATH: root }, plat), { installed: false, spawnable: false });
});

/**
 * ⚠️ ON WINDOWS A `.cmd` HIT IS NOT A SPAWNABLE PROGRAM — Node refuses it
 * without `shell: true` (CVE-2024-27980). Reporting "installed" alone produces
 * an EINVAL from a path that demonstrably exists, which is the hardest kind of
 * failure to diagnose, so the shim is reported as what it is.
 */
test('⚠️ a Windows .cmd shim is present and NOT spawnable, and the entry says so', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'zzshim.cmd'), '@echo off\n');
  assert.deepEqual(probe('zzshim', { PATH: root, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32'),
    { installed: true, spawnable: false });

  const out = checkTools(createLocalExecutor(root), { programs: ['node'], env: process.env });
  assert.equal(out.ok, true); // the shape holds on whatever this machine is
});

test('an unreadable PATH entry is not a hit', () => {
  assert.deepEqual(probe('anything', { PATH: join(tmpdir(), 'acuvo-no-such-dir-zz') }, 'linux'),
    { installed: false, spawnable: false });
});

test('presetFor names the preset that provides a binary, and null for one nothing provides', () => {
  assert.equal(presetFor('python'), 'python');
  assert.equal(presetFor('cargo'), 'rust');
  assert.equal(presetFor('definitely-not-a-preset-binary'), null);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. --shell, and the executor that runs somewhere else.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⭐ `--shell` REPLACES THE FIRST HALF OF THE ANSWER AND NOT THE SECOND. Every
 * program is permitted, so "is it here" becomes the whole question — which is
 * exactly the 201 `which` calls the bench recorded, all of them in shell mode.
 */
test('⭐ under --shell, installed IS runnable, and no enable line is offered', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'zzfake'), '#!/bin/sh\n');
  const out = checkTools(createLocalExecutor(root), { programs: ['zzfake'], shell: true, env: { PATH: root } });
  assert.equal(out.ok, true);
  assert.equal(out.programs[0].installed, true);
  assert.equal(out.programs[0].runnable, true, 'shell mode still refused a program that is on PATH');
  assert.equal(out.programs[0].enableWith, undefined);
  assert.equal(out.presetsAvailable, undefined, 'a preset enable line under --shell is noise');
});

/**
 * ⚠️⚠️ THE SUMMARY HALF WAS THE MISLEADING ONE, and no assertion caught it.
 * `runnable` is built from the ALLOWLIST — the ceiling only while the shell is
 * off. Under `--shell` a bare `runnable: ["node","npm","npx","tsc"]` reads as
 * "and nothing else", which is false and is exactly the plausible-lie failure
 * this verb refuses elsewhere.
 */
test('⚠️⚠️ under --shell the standing list says out loud that it is not the ceiling', (t) => {
  const root = workspace(t);
  const ex = createLocalExecutor(root);

  const off = checkTools(ex, { env: process.env });
  assert.equal(off.shellNote, undefined, 'the caveat must not appear when it is not true');

  const on = checkTools(ex, { shell: true, env: process.env });
  assert.ok(on.runnable.length > 0, 'nothing to be misleading about — the fixture moved');
  assert.match(String(on.shellNote), /ANY installed program/,
    '--shell returns an allowlist-shaped answer with nothing saying the allowlist no longer binds');
});

/**
 * ⚠️⚠️ AND THE DISPATCHER HAS TO HAND `shell` DOWN, which is a separate fact
 * from `checkTools` handling it. This package's recorded failure shape is a
 * capability that is correct in its own module and never reached with the
 * argument that makes it true — so the assertion goes through `executeToolCall`,
 * with the flag, and would survive nothing less.
 */
test('⚠️⚠️ --shell reaches the verb THROUGH the dispatcher, not just through the module', async (t) => {
  const root = workspace(t);
  const ex = createLocalExecutor(root);

  const off = await executeToolCall(call({}), ex, { allowRun: true, shell: false });
  assert.equal(off.result.shell, false);
  assert.ok(off.result.presetsAvailable, 'the preset advice vanished on the default surface');

  const on = await executeToolCall(call({}), ex, { allowRun: true, shell: true });
  assert.equal(on.result.shell, true, 'the dispatcher dropped shell on the floor');
  assert.equal(on.result.presetsAvailable, undefined, 'preset advice under --shell is noise the flag should remove');
});

/**
 * ⚠️⚠️ AN EXECUTOR THAT OWNS ITS OWN RUNNER RUNS SOMEWHERE ELSE. Answering from
 * THIS process's PATH would be a fact about the wrong computer, and a verb whose
 * failure mode is a plausible lie is worse than one that says it does not know.
 */
test('⚠️⚠️ an executor with its own runCommand gets a refusal, never a confident wrong answer', async (t) => {
  const root = workspace(t);
  const remote = createLocalExecutor(root);
  remote.runCommand = async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' });
  const rec = await executeToolCall(call({ programs: ['gcc'] }), remote, { allowRun: true });
  assert.equal(rec.result.ok, false);
  assert.match(rec.result.error, /somewhere other than this machine/);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6. The answer is small — it is sent to a model, on every call.
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐ the no-argument answer stays small, and never leaks an absolute path', (t) => {
  const root = workspace(t);
  const out = checkTools(createLocalExecutor(root), { env: process.env });
  const json = JSON.stringify(out);
  assert.ok(json.length < 1200, `the standing answer is ${json.length} chars — it is sent every time it is asked`);
  /**
   * ⚠️ `--doctor` prints resolved paths because a human debugging their own
   * PATH needs them. A model does not, and the path is a third-party disclosure
   * of somebody's directory layout for ~40 tokens of nothing.
   */
  assert.ok(!/[A-Za-z]:\\|\/usr\/|\/bin\//.test(json), `an absolute path reached the model: ${json}`);
});
