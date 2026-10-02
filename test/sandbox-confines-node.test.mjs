/**
 * ── ⭐⭐⭐ THE HOLE `command.mjs` NAMED, NOW ASSERTED SHUT ────────────────────
 *
 * `lib/command.mjs`'s own header ends by naming a hole it does not close: *"the
 * code the command runs can do anything Node can do, including writing outside
 * the workspace. The mitigation is not a technical one."* This file exists to
 * make that sentence false for `node <file>`, and — more importantly — to keep
 * proving it, because a security claim nobody re-runs is a security claim that
 * quietly stops being true.
 *
 * ── ⚠️⚠️ THE DECOY IS THE POINT, AND IT IS TEST 2 ──────────────────────────
 *
 * A test that asserts "the file outside the workspace does not exist" is exactly
 * the shape of guard this package has caught passing while checking nothing —
 * it stays green if the script never ran, if the path was mistyped, if the
 * workspace was cleaned first, if `node` was not on the allowlist that day.
 * EVERY ONE of those is a green that means nothing.
 *
 * ⭐ So the same script, the same path, the same driver runs TWICE, and the
 * second run — `ACUVO_SANDBOX=off` — asserts the escape file DOES exist, with
 * the exact bytes. That is the assertion that cannot be satisfied by accident:
 * it proves the script executes, reaches the write, and lands on that path,
 * so the absence in test 1 can only be the sandbox.
 *
 * ⚠️ AND NOTHING HERE IS STUBBED. `fakeSpawn` is the right tool for asserting an
 * argv and the wrong tool for asserting a KERNEL boundary — a recorded argv
 * proves we asked, never that anyone enforced. These tests spawn real Node.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeRunCommand, formatRunForModel, buildInvocation } from '../lib/command.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import {
  DEFAULT_SANDBOX_MODE,
  SANDBOX_ENV,
  SANDBOX_MODES,
  classifyDenial,
  describeSandbox,
  nodeSandboxFlags,
  resolveSandboxMode,
  rootIsDescribable,
  sandboxRootSpec,
  sandboxSupport,
} from '../lib/sandbox.mjs';

const SUPPORT = sandboxSupport();

/** A workspace, plus a path OUTSIDE it that the script under test aims at. */
function ws() {
  const base = mkdtempSync(join(tmpdir(), 'acuvo-sandbox-'));
  const root = join(base, 'workspace');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"sb","type":"module"}');
  const outside = join(base, 'OUTSIDE.txt');
  const secret = join(base, 'secret.env');
  writeFileSync(secret, 'TOKEN=sk-not-a-real-key\n');
  return { base, root, outside, secret, executor: createLocalExecutor(root), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function writeEscapeScript(root, outside) {
  writeFileSync(join(root, 'escape.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(String.raw\`${outside}\`, 'ESCAPED');`,
    "console.log('wrote outside the workspace');",
  ].join('\n'));
}

/**
 * ⚠️ THE ENVIRONMENT IS PASSED, NOT MUTATED. `ACUVO_SANDBOX` is read from the
 * `env` threaded into `executeRunCommand`, so two tests asserting opposite modes
 * cannot race each other through `process.env` under node --test's concurrency.
 */
const run = (executor, command, env = {}) => executeRunCommand({ command, executor, env });

/* ───────────────────────── 1 + 2: the pair that means something ─────────── */

test('⭐⭐⭐ a script the agent wrote CANNOT write outside the workspace', async (t) => {
  if (!SUPPORT.available) return t.skip(SUPPORT.reason);
  const w = ws();
  try {
    writeEscapeScript(w.root, w.outside);
    const result = await run(w.executor, 'node escape.mjs');

    assert.equal(result.ok, true, 'the command must RUN — a refusal would pass this test for the wrong reason');
    assert.equal(result.sandboxed, true, 'the run must report itself sandboxed, or nothing below is about the sandbox');
    assert.notEqual(result.exitCode, 0, 'the script must have died');
    assert.equal(existsSync(w.outside), false, 'the write outside the workspace must not have landed');

    // ⭐ The model must be TOLD, or it burns rounds "fixing" code that is correct.
    const shown = formatRunForModel(result);
    assert.match(shown, /SANDBOX DENIED THIS/);
    assert.match(shown, /WRITE a file outside the workspace/);
    assert.ok(shown.includes('OUTSIDE.txt'), 'the denial must name the resource, not just the rule');
    assert.match(shown, /ACUVO_SANDBOX=off/, 'the denial must name the escape hatch, and name the HUMAN as the one who turns it');
  } finally { w.cleanup(); }
});

test('⚠️ THE DECOY — with the sandbox off the very same script DOES escape', async (t) => {
  if (!SUPPORT.available) return t.skip(SUPPORT.reason);
  const w = ws();
  try {
    writeEscapeScript(w.root, w.outside);
    const result = await run(w.executor, 'node escape.mjs', { ...process.env, [SANDBOX_ENV]: 'off' });
    assert.equal(result.ok, true);
    assert.equal(result.sandboxed, false);
    assert.equal(result.exitCode, 0, 'unsandboxed, this script succeeds');
    /**
     * ⚠️⚠️ THE LOAD-BEARING ASSERTION OF THE WHOLE FILE. If this fails, test 1
     * above proved nothing whatsoever: the file's absence there would be
     * explained by the script never running rather than by any boundary.
     */
    assert.equal(existsSync(w.outside), true, 'unsandboxed the escape MUST land — otherwise test 1 is a false green');
    assert.equal(readFileSync(w.outside, 'utf8'), 'ESCAPED');
    assert.doesNotMatch(formatRunForModel(result), /SANDBOX DENIED/);
  } finally { w.cleanup(); }
});

test('⭐ reading a credential file outside the workspace is denied too', async (t) => {
  if (!SUPPORT.available) return t.skip(SUPPORT.reason);
  const w = ws();
  try {
    writeFileSync(join(w.root, 'peek.mjs'), [
      "import { readFileSync } from 'node:fs';",
      `process.stdout.write(readFileSync(String.raw\`${w.secret}\`, 'utf8'));`,
    ].join('\n'));
    const result = await run(w.executor, 'node peek.mjs');
    assert.equal(result.sandboxed, true);
    assert.notEqual(result.exitCode, 0);
    assert.ok(!result.stdout.includes('sk-not-a-real-key'), 'the secret must never reach the transcript');
    assert.match(formatRunForModel(result), /READ a file outside the workspace/);
  } finally { w.cleanup(); }
});

/* ──────────────── 4: the false-positive half — ordinary work still works ─── */

test('⭐⭐ ORDINARY WORK IS UNTOUCHED — in-workspace read, write and a local dep still run', async (t) => {
  if (!SUPPORT.available) return t.skip(SUPPORT.reason);
  const w = ws();
  try {
    mkdirSync(join(w.root, 'node_modules', 'padder'), { recursive: true });
    writeFileSync(join(w.root, 'node_modules', 'padder', 'package.json'), '{"name":"padder","version":"1.0.0","type":"module","main":"index.mjs"}');
    writeFileSync(join(w.root, 'node_modules', 'padder', 'index.mjs'), 'export const pad = (s) => String(s).padStart(3, "0");\n');
    writeFileSync(join(w.root, 'work.mjs'), [
      "import { readFileSync, writeFileSync, readdirSync } from 'node:fs';",
      "import { pad } from 'padder';",
      "readFileSync(new URL('./package.json', import.meta.url), 'utf8');",
      "readdirSync(new URL('./', import.meta.url));",
      "writeFileSync(new URL('./built.txt', import.meta.url), pad(7));",
      "console.log('OK ' + pad(7));",
    ].join('\n'));
    const result = await run(w.executor, 'node work.mjs');
    assert.equal(result.sandboxed, true, 'this must be a SANDBOXED run or it proves nothing about false positives');
    assert.equal(result.exitCode, 0, `sandboxed ordinary work must still pass — stderr was:\n${result.stderr}`);
    assert.match(result.stdout, /OK 007/);
    assert.equal(readFileSync(join(w.root, 'built.txt'), 'utf8'), '007');
    assert.doesNotMatch(formatRunForModel(result), /SANDBOX DENIED/);
  } finally { w.cleanup(); }
});

/* ───────────────── 5: the classifier cannot fire on its own vocabulary ───── */

test('⚠️ classifyDenial NEVER fires on an unsandboxed run, even on a perfect denial transcript', () => {
  const transcript = [
    "Error: Access to this API has been restricted. Use --allow-fs-write to manage permissions.",
    "  code: 'ERR_ACCESS_DENIED',",
    "  permission: 'FileSystemWrite',",
    "  resource: '\\\\\\\\?\\\\C:\\\\Users\\\\x\\\\a.txt'",
  ].join('\n');
  // The exact text a test suite for THIS feature prints. Unsandboxed → not ours.
  assert.equal(classifyDenial({ exitCode: 1, stderr: transcript, sandboxed: false }).denied, false);
  // Sandboxed and failing → ours.
  assert.equal(classifyDenial({ exitCode: 1, stderr: transcript, sandboxed: true }).denied, true);
  // Sandboxed but PASSED → not a denial. A zero exit is never a denial.
  assert.equal(classifyDenial({ exitCode: 0, stderr: transcript, sandboxed: true }).denied, false);
  // Sandboxed, failing, but nothing to do with us.
  assert.equal(classifyDenial({ exitCode: 1, stderr: 'AssertionError: 1 !== 2', sandboxed: true }).denied, false);

  const d = classifyDenial({ exitCode: 1, stderr: transcript, sandboxed: true });
  assert.equal(d.permission, 'FileSystemWrite');
  assert.equal(d.resource, 'C:\\Users\\x\\a.txt', 'the Windows long-path prefix is noise and must be stripped');
});

/* ─────────────────────────── 6: the flag construction ───────────────────── */

test('⭐ the permission flags precede the script path, always', (t) => {
  if (!SUPPORT.available) return t.skip(SUPPORT.reason);
  const inv = buildInvocation({ binary: 'node', tokens: ['node', 'app.mjs'] }, '/ws', { execPath: 'NODE', env: {} });
  assert.equal(inv.ok, true);
  const script = inv.args.indexOf('app.mjs');
  assert.ok(script > 0, 'the script must not be first — the flags go in front of it');
  /**
   * ⚠️ NOT COSMETIC. Node stops parsing its own options at the first non-option
   * argument, so a flag after the script path is silently handed to the SCRIPT
   * and the boundary never exists. This is the assertion that catches a future
   * refactor that appends instead of prepends.
   */
  for (let i = 0; i < script; i += 1) assert.match(inv.args[i], /^--/);
  assert.equal(inv.sandbox.on, true);
});

test('⚠️ npm, npx and tsc are deliberately NOT sandboxed', () => {
  for (const binary of ['npm', 'npx']) {
    const inv = buildInvocation({ binary, tokens: [binary, 'test'] }, '/ws', { execPath: process.execPath, env: {} });
    if (!inv.ok) continue; // npm not next to this node — nothing to assert
    assert.ok(!inv.args.some((a) => String(a).startsWith('--allow-fs-')), `${binary} must not carry fs flags — it legitimately reads the npm cache outside the workspace`);
    assert.equal(inv.sandbox, undefined);
  }
});

/* ──────────────────────── 7: the fail-open paths, each with a reason ────── */

test('⚠️ a comma in the workspace path disables the sandbox WITH A STATED REASON', () => {
  assert.equal(rootIsDescribable('/a/b,c').ok, false);
  const d = nodeSandboxFlags('/a/b,c', { mode: 'workspace', support: { available: true, flag: '--permission', version: 'x', reason: null } });
  assert.equal(d.on, false);
  assert.match(d.reason, /comma/);
  assert.deepEqual(d.flags, [], 'fail-open means NO flags, not half of them');
});

test('⚠️ a Node without the permission model falls back silently-but-visibly', () => {
  const none = sandboxSupport({ flags: new Set(), version: '18.0.0' });
  assert.equal(none.available, false);
  assert.match(none.reason, /no permission model/);
  const d = nodeSandboxFlags('/ws', { mode: 'workspace', support: none });
  assert.equal(d.on, false);
  assert.deepEqual(d.flags, []);

  // Knows --permission but not --allow-fs-write: an EMPTY allowance would break
  // every legitimate write. Must be treated as unavailable, not as "good enough".
  const half = sandboxSupport({ flags: new Set(['--permission', '--allow-fs-read']), version: '20.0.0' });
  assert.equal(half.available, false);
  assert.match(half.reason, /--allow-fs-write/);
});

test('the mode resolves from the env, and an unrecognised value is not silently "off"', () => {
  assert.equal(resolveSandboxMode({ env: {} }).mode, DEFAULT_SANDBOX_MODE);
  assert.equal(DEFAULT_SANDBOX_MODE, 'workspace', 'the DEFAULT is the boundary — an option nobody turns on is not a feature');
  assert.equal(resolveSandboxMode({ env: { [SANDBOX_ENV]: 'OFF' } }).mode, 'off');
  const bad = resolveSandboxMode({ env: { [SANDBOX_ENV]: 'on' } });
  assert.equal(bad.mode, 'workspace', '"on" is not a mode; guessing it means "off" would be the worst answer available');
  assert.match(bad.error, /not a mode/);
  assert.deepEqual([...SANDBOX_MODES], ['off', 'workspace', 'strict']);
});

/* ─────────── 8: the measured trade-off, pinned so it cannot drift back ───── */

test('⭐⭐⭐ THE MEASURED TRADE-OFF — workspace spawns, strict does not, both confine the disk', async (t) => {
  if (!SUPPORT.available) return t.skip(SUPPORT.reason);
  const w = ws();
  try {
    /**
     * ⚠️⚠️ THIS TEST IS THE 5-REGRESSION MEASUREMENT, TURNED INTO AN ASSERTION.
     * Withholding --allow-child-process broke five real tests, every one of them
     * node spawning node or npm to do ordinary work. If a later change decides
     * to withhold it by default again "to be safe", this goes red and points at
     * the number instead of at an opinion.
     */
    writeFileSync(join(w.root, 'spawner.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      "const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(\"child ran\")'], { encoding: 'utf8' });",
      "if (r.error) throw r.error;",
      "console.log(r.stdout);",
    ].join('\n'));

    const relaxed = await run(w.executor, 'node spawner.mjs');
    assert.equal(relaxed.sandboxed, true);
    assert.equal(relaxed.exitCode, 0, `the DEFAULT must still be able to spawn — stderr was:\n${relaxed.stderr}`);
    assert.match(relaxed.stdout, /child ran/);
    // ⚠️ And the warning Node prints about that grant must not reach the model.
    assert.doesNotMatch(relaxed.stderr, /SecurityWarning/, 'the SecurityWarning is a per-run token cost and is suppressed by type');

    const strict = await run(w.executor, 'node spawner.mjs', { [SANDBOX_ENV]: 'strict' });
    assert.equal(strict.sandboxed, true);
    assert.notEqual(strict.exitCode, 0, 'strict must deny the spawn — that is the entire difference between the modes');
    assert.match(formatRunForModel(strict), /spawn another process/);

    // ⭐ AND THE DISK BOUNDARY HOLDS IN *BOTH*, which is the point of shipping
    // the relaxed one as the default rather than shipping nothing.
    writeEscapeScript(w.root, w.outside);
    for (const mode of ['workspace', 'strict']) {
      rmSync(w.outside, { force: true });
      const r = await run(w.executor, 'node escape.mjs', { [SANDBOX_ENV]: mode });
      assert.notEqual(r.exitCode, 0, `${mode}: the escape must fail`);
      assert.equal(existsSync(w.outside), false, `${mode}: the write outside must not land`);
    }
  } finally { w.cleanup(); }
});

test('the root spec is one trailing-star value on this platform', () => {
  assert.equal(sandboxRootSpec('/a/b', { sep: '/' }), '/a/b/*');
  assert.equal(sandboxRootSpec('/a/b/', { sep: '/' }), '/a/b/*');
  assert.equal(sandboxRootSpec('C:\\a\\b', { sep: '\\' }), 'C:\\a\\b\\*');
});

test('describeSandbox states the negative case in full', () => {
  const off = describeSandbox({ root: '/ws', env: { [SANDBOX_ENV]: 'off' } });
  assert.equal(off.on, false);
  assert.match(off.line, /read and write anywhere/);
  if (SUPPORT.available) {
    const on = describeSandbox({ root: '/ws', env: {} });
    assert.equal(on.on, true);
    assert.match(on.line, /Network is NOT gated/, 'the honest limitation must be in the line we show, not only in a comment');
  }
});
