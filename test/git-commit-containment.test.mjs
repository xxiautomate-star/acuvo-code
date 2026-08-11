/**
 * ── ⚠️⚠️ THE ONE TOOL THAT WRITES PERMANENT HISTORY HAD A LEXICAL PATH GUARD ──
 *
 * Every file verb in this package resolves a model-supplied path through
 * `resolveInWorkspace` — realpath the deepest EXISTING ancestor, compare against
 * the realpath'd root — precisely because a purely lexical check cannot see a
 * link. `git_commit` did not. It called `normalizeRelativePath` (the LEXICAL
 * half, which is pure and never touches the disk) and then handed the string to
 * `git add`.
 *
 * ⭐ MEASURED, NOT ARGUED, on 2026-08-11 in a scratch repo:
 *
 *     repo/link  ->  (junction)  ->  ../outside          [mklink /J, no admin]
 *     outside/secret.txt = "SECRET-OUTSIDE-CONTENT"
 *
 *     gitCommit(repo, { paths: ['link/secret.txt'] })
 *       -> { ok: true, hash: '63367e7', files: ['link/secret.txt'] }
 *     git show HEAD:link/secret.txt
 *       -> SECRET-OUTSIDE-CONTENT
 *
 * A file from outside the workspace, in permanent history. `write_file` refuses
 * that exact path; `git_commit` accepted it — and history is the one place a
 * mistake survives deleting the file.
 *
 * ⚠️ WHY WINDOWS SPECIFICALLY. On POSIX, `git add` refuses a path "beyond a
 * symbolic link" itself, so git's own behaviour hid the missing guard. A Windows
 * DIRECTORY JUNCTION is not a symlink to git — it walks straight through it as
 * an ordinary directory. The platform where this agent actually runs is the one
 * platform where git does not cover for us.
 *
 * ── ⚠️ AND THE OTHER DIRECTION, WHICH IS THE EASIER MISTAKE ─────────────────
 * A containment check that is too literal REFUSES REAL WORK, and on Windows that
 * is one line of code away: a repo inside a junctioned/symlinked home directory,
 * a drive letter in the other case, a staged DELETION (the path no longer exists
 * on disk at all), a submodule, a link pointing INSIDE the repo. Each of those
 * is asserted below as a commit that MUST still succeed. Half this file exists
 * to stop the fix from becoming the next bug — a guard that blocks a normal
 * commit is worse than the hole it closed.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { gitCommit, refusedCommitPath } from '../lib/git.mjs';

const madeDirs = [];

function tempDir(tag) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), `acuvo-git-${tag}-`));
  madeDirs.push(dir);
  return dir;
}

/** A real repository — this defect only exists against a real `git add`. */
function makeRepo(dir) {
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 'test@acuvo.local');
  run('config', 'user.name', 'Acuvo Test');
  run('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'readme.md'), '# repo\n');
  run('add', 'readme.md');
  run('commit', '-qm', 'init');
  return run;
}

function write(dir, rel, content) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/**
 * A directory link that git treats as a plain directory on Windows. Node's
 * 'junction' type needs no elevation, which is exactly why an agent could be
 * standing next to one it did not create.
 */
function linkDir(target, path) {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

const cleanup = () => {
  for (const d of madeDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a junction on a busy dir */ }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// THE HOLE
// ─────────────────────────────────────────────────────────────────────────────

test('git_commit refuses a file reached through a junction that leaves the workspace', async (t) => {
  t.after(cleanup);
  const base = tempDir('hole');
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  mkdirSync(repo);
  mkdirSync(outside);
  makeRepo(repo);
  writeFileSync(join(outside, 'secret.txt'), 'SECRET-OUTSIDE-CONTENT\n');
  linkDir(outside, join(repo, 'link'));

  const r = await gitCommit(repo, { message: 'commit an outside file', paths: ['link/secret.txt'] });

  assert.equal(r.ok, false, 'a path that resolves outside the workspace must never be committed');
  assert.match(r.error, /workspace/i, 'the refusal must say WHY, in words a model can route around');

  // ⭐ The assertion that actually matters: history is unchanged. `ok:false` with
  // the commit already made would be the worst possible outcome.
  const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
  assert.equal(log.length, 1, `history must still hold only the init commit, got:\n${log.join('\n')}`);
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' });
  assert.ok(!tracked.includes('secret'), `the outside file must not be tracked, got:\n${tracked}`);
  // And nothing left staged for the NEXT commit to sweep up.
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(staged, '', `nothing may be left in the index, got:\n${staged}`);
});

test('git_commit refuses the junction DIRECTORY itself, not just a file under it', async (t) => {
  t.after(cleanup);
  const base = tempDir('holedir');
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  mkdirSync(repo);
  mkdirSync(outside);
  makeRepo(repo);
  writeFileSync(join(outside, 'a.txt'), 'outside a\n');
  writeFileSync(join(outside, 'b.txt'), 'outside b\n');
  linkDir(outside, join(repo, 'link'));

  const r = await gitCommit(repo, { message: 'commit the whole linked tree', paths: ['link'] });

  assert.equal(r.ok, false, 'naming the junction directory is the same escape with fewer keystrokes');
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' });
  assert.ok(!tracked.includes('a.txt'), `nothing behind the junction may be tracked, got:\n${tracked}`);
});

test('git_commit refuses an outside path even when a legitimate path is committed alongside it', async (t) => {
  t.after(cleanup);
  const base = tempDir('mixed');
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  mkdirSync(repo);
  mkdirSync(outside);
  makeRepo(repo);
  writeFileSync(join(outside, 'secret.txt'), 'SECRET\n');
  linkDir(outside, join(repo, 'link'));
  write(repo, 'src/app.ts', 'export const x = 1;\n');

  const r = await gitCommit(repo, {
    message: 'sneak one in',
    paths: ['src/app.ts', 'link/secret.txt'],
  });

  assert.equal(r.ok, false, 'one bad path must fail the whole commit, before anything is staged');
  // ⚠️ The refusal has to happen BEFORE `git add`, or the good path is left
  // staged and the model\'s next commit picks it up without being told.
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(staged, '', `an all-or-nothing refusal must leave the index empty, got:\n${staged}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER DIRECTION — REAL COMMITS THAT MUST STILL WORK
// ─────────────────────────────────────────────────────────────────────────────

test('git_commit still commits ordinary, nested and awkwardly-named files', async (t) => {
  t.after(cleanup);
  const repo = tempDir('normal');
  makeRepo(repo);
  write(repo, 'notes.md', 'hello\n');
  write(repo, 'src/deep/nested/app.tsx', 'export default 1;\n');
  write(repo, 'app/[tenantSlug]/My Component.tsx', 'export default 2;\n');
  write(repo, 'app/(dashboard)/café.js', 'export default 3;\n');

  const r = await gitCommit(repo, {
    message: 'add the real files',
    paths: ['notes.md', 'src/deep/nested/app.tsx', 'app/[tenantSlug]/My Component.tsx', 'app/(dashboard)/café.js'],
  });

  assert.equal(r.ok, true, `a normal commit must not be blocked: ${r.ok === false ? r.error : ''}`);
  assert.equal(r.fileCount, 4);
});

test('git_commit still commits when the workspace root is itself reached through a junction', async (t) => {
  t.after(cleanup);
  const base = tempDir('linkedroot');
  const real = join(base, 'real');
  mkdirSync(real);
  makeRepo(real);
  const via = join(base, 'via-link');
  linkDir(real, via);
  write(real, 'work.ts', 'export const y = 2;\n');

  // ⚠️ THE COMMONEST FALSE POSITIVE: a repo under a symlinked home directory, a
  // Windows junction, or /tmp on macOS. Every path under it "resolves
  // elsewhere" if the ROOT is not realpath'd too.
  const r = await gitCommit(via, { message: 'commit through the linked root', paths: ['work.ts'] });

  assert.equal(r.ok, true, `a junctioned workspace root is normal, not an escape: ${r.ok === false ? r.error : ''}`);
  assert.deepEqual(r.files, ['work.ts']);
});

test('git_commit still commits through a link that points INSIDE the workspace', async (t) => {
  t.after(cleanup);
  const repo = tempDir('innerlink');
  makeRepo(repo);
  write(repo, 'packages/lib/index.ts', 'export const z = 3;\n');
  linkDir(join(repo, 'packages'), join(repo, 'pkg'));

  // Resolves back inside the root, so it is contained — a monorepo convenience
  // link is not an escape and refusing it would be the guard being too literal.
  const r = await gitCommit(repo, { message: 'commit through an inner link', paths: ['pkg/lib/index.ts'] });

  assert.equal(r.ok, true, `a link that stays inside the workspace must be allowed: ${r.ok === false ? r.error : ''}`);
});

test('git_commit still stages a DELETION, whose path no longer exists on disk', async (t) => {
  t.after(cleanup);
  const repo = tempDir('deletion');
  makeRepo(repo);
  write(repo, 'doomed.txt', 'bye\n');
  execFileSync('git', ['add', 'doomed.txt'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'add doomed'], { cwd: repo, stdio: 'pipe' });
  unlinkSync(join(repo, 'doomed.txt'));

  // ⚠️ A containment check that demands the path EXIST would refuse every
  // deletion — the file is gone, that is the point of the commit.
  const r = await gitCommit(repo, { message: 'remove the file', paths: ['doomed.txt'] });

  assert.equal(r.ok, true, `staging a deletion must still work: ${r.ok === false ? r.error : ''}`);
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' });
  assert.ok(!tracked.includes('doomed.txt'), 'the deletion must actually be recorded');
});

test('git_commit still commits a nested repository (submodule-shaped) as a gitlink', async (t) => {
  t.after(cleanup);
  const repo = tempDir('submodule');
  makeRepo(repo);
  const sub = join(repo, 'vendor', 'thing');
  mkdirSync(sub, { recursive: true });
  makeRepo(sub);

  const r = await gitCommit(repo, { message: 'vendor the thing', paths: ['vendor/thing'] });

  assert.equal(r.ok, true, `a nested repo is a real directory inside the workspace: ${r.ok === false ? r.error : ''}`);
});

test('git_commit still commits when the caller spells the drive letter in the other case', async (t) => {
  t.after(cleanup);
  const repo = tempDir('drivecase');
  makeRepo(repo);
  write(repo, 'case.txt', 'ok\n');
  const flipped = process.platform === 'win32'
    ? repo.replace(/^([A-Za-z]):/, (_m, d) => (d === d.toLowerCase() ? d.toUpperCase() : d.toLowerCase()) + ':')
    : repo;

  const r = await gitCommit(flipped, { message: 'drive letter case', paths: ['case.txt'] });

  assert.equal(r.ok, true, `Windows paths are case-insensitive; a case-only difference is not an escape: ${r.ok === false ? r.error : ''}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REFUSAL THAT ALREADY EXISTED MUST NOT BE WEAKENED BY THE NEW ONE
// ─────────────────────────────────────────────────────────────────────────────

test('git_commit still refuses credential files, with the credential wording', async (t) => {
  t.after(cleanup);
  const repo = tempDir('creds');
  makeRepo(repo);
  write(repo, '.env', 'OPENROUTER_API_KEY=sk-live\n');

  const r = await gitCommit(repo, { message: 'ship the env', paths: ['.env'] });

  assert.equal(r.ok, false);
  assert.match(r.error, /credential/i, 'the credential refusal must keep its own, more specific message');
  assert.ok(refusedCommitPath('config/id_rsa'), 'the credential list itself is untouched');
  assert.equal(refusedCommitPath('src/env.ts'), null, 'and it still lets ordinary files through');
});
