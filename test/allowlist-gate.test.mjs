/**
 * ── ⭐⭐ FOUR DOORS, ONE ANSWER — AND THE GATE STILL BITES ────────────────────
 *
 * ⚠️⚠️ THE DEFECT THIS FILE PINS, MEASURED 2026-08-29 IN ONE WORKSPACE, ONE
 * PROCESS, ONE OPERATOR CONFIGURATION:
 *
 *     run_command   {command:"make test"}            → RAN
 *     start_process {command:"make test"}            → RAN
 *     run_program   {program:"make", args:["test"]}  → refused
 *     start_process {program:"make", args:["test"]}  → refused
 *
 * and the refusal read *"Allowed: node, npm, npx, tsc … python … not reachable
 * from here at all"* while `python -m pytest -q` was running through the door
 * next to it.
 *
 * ⭐ WHY IT IS A SAFETY BUG AND NOT A CONVENIENCE ONE. The argv form is the SAFE
 * primitive — no string, no tokenizer, nothing that can re-read `"buy milk"` or
 * a `;` as anything but data. The string form is the one defending a parser, and
 * under `--shell` it IS the parser. The package refused the safe door and
 * permitted the unsafe one, and in seven Terminal-Bench transcripts the model
 * did the obvious thing: read the refusal, and in the very next round downgraded
 * to a `run_command` string — once narrating it, *"I can't use start_process
 * with python3. Let me use run_command."* A gate that is cheaper to route around
 * than to satisfy is a signpost pointing at the hole.
 *
 * ── ⚠️ SO THE HALF OF THIS FILE THAT MATTERS IS THE REFUSALS ────────────────
 *
 * Widening a gate is the easy half and the dangerous half. Every test below the
 * agreement table exists to prove the argv door did not become a laxer copy of
 * the string door: the same subcommand whitelist, the same flag whitelist, the
 * same `-m` value rule that stops `python -m pip install`, the same operand
 * containment, and the same absolute refusal of a shell — through BOTH doors,
 * asserted side by side so they cannot drift apart silently.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ALLOWLIST,
  buildAllowlist,
  executeRunCommand,
  unknownBinaryRefusal,
  validatePresetArgv,
} from '../lib/command.mjs';
import { resolveWorkspaceAllowlist, workspaceAllowlistOrDefault } from '../lib/allowlist-gate.mjs';
import { runProgram, planSingleSpawn, spawnArgvToolSchemas } from '../lib/spawn-argv.mjs';
import { backgroundToolSchemas } from '../lib/background.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

/** A workspace with the manifests a project uses to declare its language. */
function ws(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-gate-'));
  for (const [name, body] of Object.entries(files)) {
    const abs = join(root, ...name.split('/'));
    if (name.includes('/')) mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, executor: createLocalExecutor(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Records the spawn instead of performing it, so nothing here runs a program. */
function fakeSpawn(seen = []) {
  const impl = (file, args) => {
    seen.push({ file, args });
    const l = {};
    const c = {
      pid: 4242,
      stdout: { on() {}, setEncoding() {} },
      stderr: { on() {}, setEncoding() {} },
      on: (e, f) => { l[e] = f; return c; },
      kill() {},
      unref() {},
    };
    setImmediate(() => l.close?.(0, null));
    return c;
  };
  impl.seen = seen;
  return impl;
}

const MAKE_WS = { Makefile: 'test:\n\t@echo hi\n' };
const PY_WS = { 'requirements.txt': '' };

/* ── ⭐ THE AGREEMENT TABLE — the defect, stated as an assertion ──────────── */

test('⭐⭐ all four doors give the SAME answer for a program the workspace enables', async () => {
  const w = ws(MAKE_WS);
  try {
    const viaString = await executeRunCommand({ command: 'make test', executor: w.executor, spawnImpl: fakeSpawn() });
    const viaArgv = await runProgram({ root: w.root, program: 'make', args: ['test'], spawnImpl: fakeSpawn() });
    const planned = planSingleSpawn({ root: w.root, program: 'make', args: ['test'] });

    assert.equal(viaString.ok, true, 'the string door ran make — this is the behaviour that already existed');
    assert.equal(viaArgv.ok, true, `run_program refused what run_command ran: ${viaArgv.error}`);
    assert.equal(planned.ok, true, `start_process's argv form refused what its string form ran: ${planned.error}`);
  } finally { w.cleanup(); }
});

test('⭐ the argv door reaches python the same way the string door does', async () => {
  const w = ws(PY_WS);
  try {
    const viaArgv = await runProgram({ root: w.root, program: 'python', args: ['-m', 'pytest', '-q'], spawnImpl: fakeSpawn() });
    assert.equal(viaArgv.ok, true, `run_program refused pytest: ${viaArgv.error}`);
  } finally { w.cleanup(); }
});

test('⚠️ ARGUMENTS, not a zero-arg check — the 2026-08-24 attempt passed `make` and failed `make -j4`', async () => {
  /**
   * ⭐ THE POINT OF THIS TEST IS THE ARGUMENT. `background.mjs` records a
   * previous fix that punched past the binary gate and left the argv walk
   * falling through to TSC's flag grammar: `make` (no arguments) passed and
   * `make -j4` did not, so a zero-argument test would have called it fixed.
   * Both forms are asserted, and the flagged one is the one that bites.
   */
  const w = ws(MAKE_WS);
  const argv = (args) => runProgram({ root: w.root, program: 'make', args, spawnImpl: fakeSpawn() });
  const str = (command) => executeRunCommand({ command, executor: w.executor, spawnImpl: fakeSpawn() });
  try {
    assert.equal((await argv([])).ok, true, 'bare make — the case the old attempt passed on');

    /**
     * ⭐ ASSERTED AS PARITY RATHER THAN AS A GUESS. `-j` is a separate-value
     * flag, so `-j 4` is legal and `-j4` is not — and the point is not which of
     * those is right, it is that the two doors must give the SAME answer. A test
     * that hard-coded my belief about make's grammar would pass while the doors
     * disagreed about a different flag.
     */
    for (const [args, command] of [
      [['-j', '4', 'test'], 'make -j 4 test'],
      [['-j4', 'test'], 'make -j4 test'],
      [['-k', 'test'], 'make -k test'],
      [['-j', 'abc'], 'make -j abc'],
      [['--jobs=4', 'test'], 'make --jobs=4 test'],
    ]) {
      const a = await argv(args);
      const s = await str(command);
      assert.equal(a.ok, s.ok, `the doors disagree about \`${command}\`: argv ${a.ok} / string ${s.ok} — ${a.error ?? s.error}`);
    }

    // …and at least one of those is a REFUSAL, so the loop above cannot be
    // satisfied by both doors saying yes to everything.
    assert.equal((await argv(['-j', 'abc'])).ok, false, 'a separate-value flag took a value its rule rejects');
  } finally { w.cleanup(); }
});

/* ── ⚠️⚠️ THE GATE STILL BITES — the half that matters ────────────────────── */

test('⚠️ a workspace that declares NOTHING still gets only the four', async () => {
  const w = ws({ 'readme.md': 'hi' });
  try {
    const r = await runProgram({ root: w.root, program: 'make', args: ['test'], spawnImpl: fakeSpawn() });
    assert.equal(r.ok, false, 'make ran in a workspace with no Makefile and no config');
    assert.match(r.error, /is not a program this agent may run/);
  } finally { w.cleanup(); }
});

test('⚠️⚠️ `python -m pip install` stays refused THROUGH BOTH DOORS', async () => {
  /**
   * ⚠️ THE SHARPEST REGRESSION AVAILABLE. `-m`'s value has its own rule
   * (`checkFlagValue`) precisely because `pip`, `install` and `requests` are all
   * legal relative paths — if the argv door validated them as ordinary operands
   * the whole thing would pass. A registry fetch is the one thing no allowlist
   * of program NAMES can check, so it must die on both roads or on neither.
   */
  const w = ws(PY_WS);
  try {
    const viaString = await executeRunCommand({ command: 'python -m pip install requests', executor: w.executor, spawnImpl: fakeSpawn() });
    const viaArgv = await runProgram({ root: w.root, program: 'python', args: ['-m', 'pip', 'install', 'requests'], spawnImpl: fakeSpawn() });
    assert.equal(viaString.ok, false, 'the string door installed from a registry');
    assert.equal(viaArgv.ok, false, 'THE ARGV DOOR IS A LAXER COPY: it installed from a registry');
  } finally { w.cleanup(); }
});

test('⚠️ a refused flag is still refused, with the reason, through the argv door', async () => {
  const w = ws(MAKE_WS);
  try {
    const r = await runProgram({ root: w.root, program: 'make', args: ['-C', '/etc', 'all'], spawnImpl: fakeSpawn() });
    assert.equal(r.ok, false, 'make -C walked out of the workspace');
    assert.match(r.error, /-C is refused/);
  } finally { w.cleanup(); }
});

test('⚠️ an undeclared flag is still refused through the argv door', async () => {
  const w = ws(MAKE_WS);
  try {
    const r = await runProgram({ root: w.root, program: 'make', args: ['--eval=$(shell id)'], spawnImpl: fakeSpawn() });
    assert.equal(r.ok, false, 'an unlisted make flag was accepted');
  } finally { w.cleanup(); }
});

test('⚠️ an operand is still contained in the workspace through the argv door', async () => {
  const w = ws(MAKE_WS);
  try {
    const r = await runProgram({ root: w.root, program: 'make', args: ['../../../etc/passwd'], spawnImpl: fakeSpawn() });
    assert.equal(r.ok, false, 'an operand escaped the workspace root');
  } finally { w.cleanup(); }
});

test('⚠️ an argv slot is still not a place to hide a second command', async () => {
  /**
   * There is no shell, so `; rm -rf /` in an argv slot is inert data — but it is
   * also not a path and not a declared flag, so the grammar refuses it anyway.
   * Asserting it keeps "inert" from quietly becoming "unchecked".
   */
  const w = ws(MAKE_WS);
  try {
    const r = await runProgram({ root: w.root, program: 'make', args: ['; rm -rf /'], spawnImpl: fakeSpawn() });
    assert.equal(r.ok, false, 'a shell-shaped operand was accepted');
  } finally { w.cleanup(); }
});

test('⚠️⚠️ NO configuration reaches a shell through the widened argv door', async () => {
  /**
   * ⚠️ `NEVER_ALLOWED_BINARIES` is the one hard line in `command.mjs` and it
   * applies to the administrator too. The widening must not have created a
   * second road to it: an env-declared `bash` is refused at parse time, so the
   * allowlist never contains it and the argv gate never sees it.
   */
  const w = ws({});
  try {
    const resolved = resolveWorkspaceAllowlist(w.root, { env: { ACUVO_ALLOW_COMMANDS: 'bash' } });
    assert.equal(resolved.ok, false, 'ACUVO_ALLOW_COMMANDS=bash was accepted');
    // …and the never-fails helper falls back to the DEFAULT, never to something wider.
    const fallback = workspaceAllowlistOrDefault(w.root, { env: { ACUVO_ALLOW_COMMANDS: 'bash' } });
    assert.deepEqual([...fallback.binaries], [...DEFAULT_ALLOWLIST.binaries]);
    const r = await runProgram({ root: w.root, program: 'bash', args: ['-c', 'id'], spawnImpl: fakeSpawn() });
    assert.equal(r.ok, false, 'bash was reachable through run_program');
  } finally { w.cleanup(); }
});

test('⚠️ a malformed .acuvo/commands.json does not silently widen or silently work', () => {
  const w = ws({ '.acuvo/commands.json': '{"preset": ["python"]}' });
  try {
    const resolved = resolveWorkspaceAllowlist(w.root, { env: {} });
    assert.equal(resolved.ok, false, 'a typo\'d key parsed as a valid config');
    assert.deepEqual([...workspaceAllowlistOrDefault(w.root, { env: {} }).binaries], [...DEFAULT_ALLOWLIST.binaries]);
  } finally { w.cleanup(); }
});

test('⚠️ an EXPLICIT config wins — detection does not add to a stated list', () => {
  /**
   * A Makefile is present, so detection alone would enable `make`. The config
   * names only python, and a person who listed exactly what this agent may run
   * has made a decision.
   */
  const w = ws({ ...MAKE_WS, '.acuvo/commands.json': '{"presets":["python"]}' });
  try {
    const r = resolveWorkspaceAllowlist(w.root, { env: {} });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.stated, true);
    assert.equal(r.allowlist.binaries.includes('python'), true);
    assert.equal(r.allowlist.binaries.includes('make'), false, 'detection overruled the operator\'s own file');
  } finally { w.cleanup(); }
});

test('⚠️⚠️ the CONTROL is `validatePresetArgv`, and it refuses on its own', () => {
  /**
   * ── ⚠️⚠️ THIS TEST EXISTS BECAUSE A MUTATION CAME BACK GREEN ──────────────
   *
   * Deleting the binary check from BOTH gates in `spawn-argv.mjs`
   * (`if (!list$.binaries.includes(program))` → `if (false)`, twice) left the
   * whole suite GREEN. Not because the tests were weak about the outcome — every
   * refusal above still fired — but because `planBinaryInvocation` routes every
   * non-builtin to `validatePresetArgv`, which checks the same list again. The
   * outer gate is DEFENCE IN DEPTH and a fail-fast message; the control is here.
   *
   * ⭐ SO THE CONTROL IS ASSERTED WHERE IT LIVES. A guard whose removal changes
   * nothing is not a guard the suite is entitled to claim credit for, and the
   * honest fix is to name which layer is load-bearing rather than to invent a
   * test that only distinguishes them by accident. `command.mjs` sets the
   * precedent in the same house style for `&& !script`, which is also measured
   * unreachable and also kept.
   */
  const bare = DEFAULT_ALLOWLIST;
  assert.equal(validatePresetArgv('make', ['test'], { allowlist: bare }).ok, false);
  assert.equal(validatePresetArgv('bash', ['-c', 'id'], { allowlist: bare }).ok, false);
  assert.equal(validatePresetArgv('python', ['x.py'], { allowlist: bare }).ok, false);
  // …and it says yes exactly when the allowlist says yes, so the check is a
  // lookup and not a blanket refusal that would pass this test for free.
  assert.equal(validatePresetArgv('make', ['test'], { allowlist: buildAllowlist({ presets: ['make'] }) }).ok, true);
});

test('⚠️ the builtin four never route through the preset validator', () => {
  /**
   * node's OPTIONS→DATA boundary is not expressible as a flat operand list, so
   * a builtin arriving here would be a second, laxer walk of the same argv —
   * the exact defect shape `spawn-argv.mjs` exists to prevent.
   */
  for (const bin of ['node', 'npm', 'npx', 'tsc']) {
    const r = validatePresetArgv(bin, ['x'], { allowlist: DEFAULT_ALLOWLIST });
    assert.equal(r.ok, false, `${bin} was validated as a preset`);
  }
});

/* ── ⭐ THE REFUSAL HAS TO NAME THE WAY OUT ───────────────────────────────── */

test('⭐⭐ the refusal names the preset and where to switch it on — one sentence, both doors', async () => {
  /**
   * ⚠️ THE OLD ARGV REFUSAL NAMED NO WAY OUT AND WAS FACTUALLY FALSE. It cost a
   * round every time it fired, seven times in our own bench logs, and what the
   * model did with the round was find a worse tool. There is now ONE sentence,
   * `unknownBinaryRefusal`, and both doors call it.
   */
  const w = ws({ 'readme.md': 'hi' });
  try {
    const viaArgv = await runProgram({ root: w.root, program: 'cargo', args: ['test'], spawnImpl: fakeSpawn() });
    const viaString = await executeRunCommand({ command: 'cargo test', executor: w.executor, spawnImpl: fakeSpawn() });
    assert.equal(viaArgv.ok, false);
    assert.equal(viaString.ok, false);
    for (const [label, msg] of [['argv', viaArgv.error], ['string', viaString.error]]) {
      assert.match(msg, /"rust" preset/, `${label} refusal does not name the preset`);
      assert.match(msg, /\.acuvo\/commands\.json/, `${label} refusal does not name the config file`);
      assert.match(msg, /ACUVO_ALLOW_COMMANDS/, `${label} refusal does not name the environment variable`);
    }
    assert.equal(viaArgv.error, viaString.error, 'the two doors have drifted into two sentences again');
  } finally { w.cleanup(); }
});

test('⚠️ the refusal no longer claims python and make are unreachable', async () => {
  /**
   * ⚠️ THE OLD SENTENCE, VERBATIM: "curl, python, rm, bash, sh, cmd and
   * powershell are not reachable from here at all." Two of those seven were
   * simply untrue — python and make ARE reachable, through a preset, and saying
   * otherwise stops the reader looking. A stale claim about ARCHITECTURE is
   * worse than no claim.
   */
  const w = ws({ 'readme.md': 'hi' });
  try {
    const r = await runProgram({ root: w.root, program: 'python', args: ['x.py'], spawnImpl: fakeSpawn() });
    assert.equal(r.ok, false);
    assert.equal(/not reachable from here at all/.test(r.error), false, 'the false sentence is back');
    assert.match(r.error, /"python" preset/);
  } finally { w.cleanup(); }
});

/* ── ⚠️⚠️ REACHABILITY — a capability the model is told it lacks is absent ── */

test('⚠️⚠️ neither argv schema still tells the model that only four programs exist', () => {
  /**
   * ⚠️ THIS IS THE HALF THAT WOULD HAVE MADE THE WHOLE FIX DEAD. Both schemas
   * carried `enum: ['node','npm','npx','tsc']` and the sentence "Nothing else is
   * reachable". A model told a capability does not exist never tries it, nothing
   * errors, and nobody finds out — `shell-mode.test.mjs` states the same rule for
   * `run_command`'s description.
   */
  const runProg = spawnArgvToolSchemas()[0].function.parameters.properties.program;
  const startProc = backgroundToolSchemas()[0].function.parameters.properties.program;
  for (const [label, prop] of [['run_program', runProg], ['start_process', startProc]]) {
    assert.equal(prop.enum, undefined, `${label} still pins an enum of four, so the widened gate is unreachable`);
    assert.equal(/Nothing else is reachable/.test(prop.description), false, `${label} still tells the model nothing else exists`);
  }
});

/* ── the resolver's own contract ──────────────────────────────────────────── */

test('detection is per-manifest, and a bare directory gets the default', () => {
  const bare = ws({});
  const go = ws({ 'go.mod': 'module x\n' });
  try {
    assert.deepEqual([...workspaceAllowlistOrDefault(bare.root, { env: {} }).binaries], [...DEFAULT_ALLOWLIST.binaries]);
    const r = resolveWorkspaceAllowlist(go.root, { env: {} });
    assert.equal(r.ok, true);
    assert.deepEqual(r.detected, ['go']);
    assert.equal(r.allowlist.binaries.includes('go'), true);
  } finally { bare.cleanup(); go.cleanup(); }
});

test('a directory that cannot be listed costs capability, never grants it', () => {
  const r = resolveWorkspaceAllowlist(join(tmpdir(), 'acuvo-does-not-exist-' + Date.now()), { env: {} });
  assert.equal(r.ok, true, 'a missing directory failed the run');
  assert.deepEqual([...r.allowlist.binaries], [...DEFAULT_ALLOWLIST.binaries]);
});

test('the refusal sentence is built from the allowlist it is given, not from a constant', () => {
  const wide = buildAllowlist({ presets: ['python'] });
  const msg = unknownBinaryRefusal('cargo', wide.binaries);
  assert.match(msg, /Allowed here: node, npm, npx, tsc, python/, 'the refusal lists a stale set of binaries');
});
