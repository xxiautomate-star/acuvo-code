/**
 * ── THE TWO DEFECTS AT THE FILESYSTEM BOUNDARY, PINNED ──────────────────────
 *
 * (A) THE WHITELIST REFUSED A QUARTER OF A MODERN REPO. `^[A-Za-z0-9._-]+$` was
 *     inherited from a STATIC SITE bundler, where the only legal names are
 *     `index.html` and `js/app.js`. Point it at an App Router tree and
 *     `app/[tenantSlug]/page.tsx` is contraband. Measured on the real repo:
 *     565 of 2,077 tracked files in `console/` — 27% — could not be opened.
 *
 *     ⭐ AND THE TWO HALVES OF THE TOOL DISAGREED. `find_files` and
 *     `search_text` walk the disk directly and happily RETURN those paths, so
 *     the model was handed a filename and then refused it. End to end that
 *     burns rounds, gives up, and still exits 0 with ok:true — a silent
 *     capability hole rather than a failure anybody could see.
 *
 * (B) ONE UNREADABLE FILE KILLED THE WHOLE SESSION. `readFileSync` in
 *     `readFile` had no try/catch while the `statSync` two lines above it did.
 *     `gatherWorkspaceContext` pre-reads every small file in the top two
 *     directory levels BEFORE the first model call, so a single
 *     permission-denied file in the workspace root aborted the run with a raw
 *     EPERM stack — before a token was spent, with nothing the user could act
 *     on. The file's own header promises "plain data (never throws for an
 *     expected failure)"; a file the owner cannot read is the most expected
 *     failure a filesystem has.
 *
 * ⚠️ NEITHER FIX WEAKENS CONTAINMENT, AND THE CORPUS BELOW IS THE PROOF. The
 * refusal of `..`, absolute paths, drive letters, UNC, URLs and NUL is not the
 * character whitelist's job and never was — it is `resolveInWorkspace`'s
 * realRoot + isInside + realpath-the-deepest-existing-ancestor. Those cases are
 * asserted here alongside the newly-permitted ones so the two lists have to be
 * read together.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { normalizeRelativePath, resolveInWorkspace, createLocalExecutor } from '../lib/workspace.mjs';
import { gatherWorkspaceContext } from '../lib/turn.mjs';

/**
 * Real paths from real repos. Every one of these was refused before the fix;
 * the first two are the commonest filenames in a Next.js codebase.
 */
const MUST_ACCEPT = [
  'app/[tenantSlug]/page.tsx',
  'app/(dashboard)/x.ts',
  'src/[...slug]/page.tsx',
  '@modal/x.tsx',
  'My Component.tsx',
  'café.js',
  '日本語.ts',
  'a+b.ts',
  "don't.md",
  'v1.2.3/notes.md',
  '.gitignore',
  'Dockerfile',
  'src/index.js',
];

/**
 * ⚠️ Two families here, and only one of them is about security.
 *  · Traversal / absolute / URL / NUL — containment, enforced structurally.
 *  · `...`, `trail.`, `nul`, `com1.txt` — WINDOWS DEBRIS. The old whitelist let
 *    all four through (every character in them is in `[A-Za-z0-9._-]`), and
 *    each one produces a file the owner cannot delete through Explorer, cmd or
 *    PowerShell. An agent that can create undeletable litter in someone's
 *    project is a worse neighbour than one that refuses a filename.
 */
const MUST_REFUSE = [
  '../outside/x',
  '..\\outside\\x',
  'src/../../outside/x',
  '/etc/passwd',
  'C:/Windows/win.ini',
  '//server/share/x',
  'a\u0000b',
  'https://x/y',
  '...',
  'src/....',
  'trail.',
  // ⚠️ A MIDDLE segment, deliberately. `normalizeRelativePath` trims the whole
  // string first, so `'src/trail '` legitimately becomes `src/trail` — trailing
  // whitespace on a path is sloppiness, not intent, and forgiving it is right.
  // Only an interior segment can carry a trailing space past that trim, so this
  // is the case that actually exercises the rule.
  'src/trail /x.ts',
  'nul',
  'com1.txt',
  'src/LPT9.log',
  'a:b.txt',
  'a*b.txt',
  'a?b.txt',
  'a|b.txt',
  'a"b.txt',
  'src/a<b>c.txt',
];

test('⭐ the paths a modern repo is actually made of are reachable', () => {
  for (const p of MUST_ACCEPT) {
    const r = normalizeRelativePath(p);
    assert.ok(r.ok, `refused a legitimate path: ${JSON.stringify(p)} — ${r.ok ? '' : r.reason}`);
  }
  // The normalised spelling must be the path itself, not a mangled one — the
  // model gets this string back and will call read_file with it next round.
  assert.deepStrictEqual(normalizeRelativePath('app/[tenantSlug]/page.tsx'), { ok: true, path: 'app/[tenantSlug]/page.tsx' });
  assert.deepStrictEqual(normalizeRelativePath('./app/(dashboard)/x.ts'), { ok: true, path: 'app/(dashboard)/x.ts' });
});

test('⚠️ and containment plus the Windows-debris rules still refuse everything they should', () => {
  for (const p of MUST_REFUSE) {
    const r = normalizeRelativePath(p);
    assert.strictEqual(r.ok, false, `ACCEPTED a path that must be refused: ${JSON.stringify(p)}`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `refused ${JSON.stringify(p)} with no reason`);
  }
});

test('⚠️ a bracket path resolves INSIDE the workspace, and traversal still cannot', () => {
  const ws = mkdtempSync(join(tmpdir(), 'acuvo-q7k-ws-'));
  try {
    mkdirSync(join(ws, 'app', '[tenantSlug]'), { recursive: true });
    writeFileSync(join(ws, 'app', '[tenantSlug]', 'page.tsx'), 'export default function P(){return null}\n');

    const exec = createLocalExecutor(ws);
    const read = exec.readFile('app/[tenantSlug]/page.tsx');
    assert.ok(read.ok, `the executor could not read a real App Router file: ${read.ok ? '' : read.error}`);
    assert.match(read.content, /export default/);

    // The structural half is what holds the line, so say so out loud.
    assert.strictEqual(resolveInWorkspace(ws, '../outside/x').ok, false);
    assert.strictEqual(resolveInWorkspace(ws, 'app/[tenantSlug]/../../../outside/x').ok, false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('⚠️ listing a FILE says it is a file — it used to say the directory did not exist', () => {
  /**
   * `readdirSync` on a file throws ENOTDIR and the catch answered "no such
   * directory". ⭐ A model told a path does not exist does not investigate — it
   * invents a plausible name and writes there instead. The lie is the defect;
   * the missing branch is only the cause.
   */
  const ws = mkdtempSync(join(tmpdir(), 'acuvo-q7k-notdir-'));
  try {
    writeFileSync(join(ws, 'notes.md'), '# hi\n');
    const r = createLocalExecutor(ws).listDir('notes.md');
    assert.strictEqual(r.ok, false);
    assert.ok(!/no such directory/i.test(r.error), `told the model a file that exists is a missing directory: ${r.error}`);
    assert.match(r.error, /is a file/i);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('⚠️⚠️ one unreadable file must not kill the session', (t) => {
  /**
   * The fixture denies the CURRENT account read access to one file and then
   * checks, with a raw `readFileSync`, that the OS really is refusing. If the
   * deny did not take (elevated shell, exotic filesystem) the test skips loudly
   * rather than passing on a fixture that proves nothing.
   */
  const ws = mkdtempSync(join(tmpdir(), 'acuvo-q7k-perm-'));
  const locked = join(ws, 'locked.txt');
  const who = userInfo().username;
  let denied = false;
  try {
    writeFileSync(join(ws, 'app.mjs'), 'export const a = 1;\n');
    writeFileSync(locked, 'unreadable\n');
    try {
      if (process.platform === 'win32') execFileSync('icacls', [locked, '/deny', `${who}:(R)`], { stdio: 'ignore' });
      else chmodSync(locked, 0o000);
    } catch { /* reported by the probe below, not here */ }

    try { readFileSync(locked, 'utf8'); } catch { denied = true; }
    if (!denied) {
      t.skip('could not make a file unreadable on this machine — the defect is real, this fixture is not');
      return;
    }

    const exec = createLocalExecutor(ws);
    // BEFORE THE FIX this line throws EPERM and takes the process with it.
    const read = exec.readFile('locked.txt');
    assert.strictEqual(read.ok, false, 'an unreadable file reported success');
    assert.match(read.error, /permission denied/i, `unhelpful error: ${read.error}`);

    // ⭐ THE DAMAGE, not just the symptom: the pre-load runs before the first
    // model call, so this is the whole run dying on one file it did not need.
    const ctx = gatherWorkspaceContext(exec);
    assert.ok(ctx.ok, 'the pre-load failed because of one unreadable file');
    assert.ok(ctx.text.includes('export const a = 1'), 'the readable files were lost with the unreadable one');
    assert.ok(!ctx.text.includes('unreadable\n'), 'read a file the OS refused');
  } finally {
    try {
      if (process.platform === 'win32') execFileSync('icacls', [locked, '/remove:d', who], { stdio: 'ignore' });
      else chmodSync(locked, 0o644);
    } catch { /* the rm below is best-effort anyway */ }
    rmSync(ws, { recursive: true, force: true });
  }
});
