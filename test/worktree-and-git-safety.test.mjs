/**
 * ── ⭐⭐⭐ THE TWO FAILURES THIS REPOSITORY HAS ALREADY HAD ──────────────────
 *
 * Not a competitor checklist. Two entries in this project's own memory:
 *
 *   · *"3 PARALLEL AGENTS IN ONE WORKTREE — they stage each other's files and
 *     read a dirty baseline"*
 *   · *"`git checkout <file>` DESTROYED UNCOMMITTED WORK"*
 *
 * ── ⚠️ WHAT THIS FILE IS CAREFUL ABOUT ──────────────────────────────────────
 *
 * · **Every assertion runs against a REAL repository and REAL `git worktree`.**
 *   A mock cannot tell you that `git worktree add` shares an object store, that
 *   `git status` inside a linked worktree reports only that worktree, or that
 *   `GIT_INDEX_FILE` really leaves `.git/index` byte-identical. Those are the
 *   only three claims the design rests on, and all three are git's behaviour
 *   rather than ours.
 * · **The destruction is performed for real.** `git reset --hard` and
 *   `git clean -fd` actually run, and the assertions are on the bytes that come
 *   back afterwards. A test that asserts a snapshot object exists proves
 *   nothing about whether the work can be recovered from it.
 * · **Half the file asserts what must still be REFUSED** — a cleanup that
 *   removes a worktree holding work, or a model that can pass `force`, would be
 *   worse than having no isolation at all, because it would be a new way to
 *   lose the thing the feature exists to protect.
 * · ⚠️ **`ACUVO_HOME` IS ALWAYS OVERRIDDEN TO A TEMP DIRECTORY.** Worktrees
 *   live under it; a test that used the real one would create checkouts in the
 *   developer's home and leave them there.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  destructiveIntent, guardCommand, listSnapshots, restoreSnapshot,
  safetyEnabled, snapshotWorkingTree, SAFETY_ENV, SAFETY_REF_PREFIX,
} from '../lib/git-safety.mjs';
import {
  cleanupWorktrees, createWorktree, listWorktrees, removeWorktree,
  repoKey, validateWorktreeName, worktreeStatus, worktreeToolNames, worktreeToolSchemas, worktreesHome,
} from '../lib/worktree.mjs';
import { TOOL_NAMES, executeToolCall, toolNamesForRounds } from '../lib/tools.mjs';
import { shortlistTools, TOOL_GROUPS } from '../lib/tool-shortlist.mjs';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/**
 * ⚠️ `raw` IS KEPT ALONGSIDE `out`, AND THAT IS NOT TIDINESS. `git status
 * --porcelain` encodes staged-vs-unstaged in COLUMN ONE, so ` M f` and `M  f`
 * differ by a leading space — and `.trim()` deletes exactly that byte. An
 * assertion written against `out` cannot tell "staged" from "not staged",
 * which is the single property the index test exists to prove.
 */
function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim(), raw: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

/** A real repository, plus an `ACUVO_HOME` nothing outside this test can see. */
function scratch(tag, { autocrlf = 'false' } = {}) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), `acuvo-wt-${tag}-`));
  made.push(base);
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'test@acuvo.local');
  g(repo, 'config', 'user.name', 'Acuvo Test');
  g(repo, 'config', 'commit.gpgsign', 'false');
  /**
   * ⚠️ PINNED, BECAUSE THE MACHINE THIS WAS WRITTEN ON HAS `core.autocrlf=true`
   * GLOBALLY. Left to the developer's config, every byte assertion in this file
   * passes or fails depending on whose laptop it runs on — and the one test
   * that genuinely cares asks for `autocrlf: 'true'` explicitly.
   */
  g(repo, 'config', 'core.autocrlf', autocrlf);
  writeFileSync(join(repo, 'shared.txt'), 'BASE\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'init');
  /**
   * ── ⚠️⚠️ `ACUVO_GIT_SAFETY: '1'` IS THE POINT OF THIS LINE ─────────────────
   *
   * `scripts/test.mjs` sets `ACUVO_GIT_SAFETY=0` for the WHOLE suite, and it is
   * right to: `lib/git-safety.mjs` snapshots into `refs/acuvo/safety/`, some
   * tests use a root inside this checkout, and the first shipped run left 8 real
   * refs in the developer's own repository.
   *
   * ⚠️ BUT THIS FILE SPREADS `process.env`, so under `npm test` it INHERITED the
   * kill switch and every snapshot assertion tested a mechanism that was turned
   * off. Measured 2026-09-01: **22/22 with `node --test`, 10/22 under `npm test`
   * — the same 12 failures, reproducible with a bare `ACUVO_GIT_SAFETY=0`.**
   *
   * ⭐ AND IT WAS INVISIBLE FOR A SECOND REASON. `scripts/test.mjs` ran with the
   * default 1 MiB `spawnSync` buffer against ~1.05 MB of TAP, so the `# tests N`
   * line was truncated and the runner exited 1 for "unreadable result" — which
   * masked a real 12-test failure behind a plumbing one. Raising the buffer is
   * what surfaced this.
   *
   * Re-enabling here is safe because `repo` is a throwaway `mkdtemp` and `home`
   * is an isolated `ACUVO_HOME` — the two reasons the global kill switch exists
   * do not apply to it.
   */
  return { base, repo, home, env: { ...process.env, ACUVO_HOME: home, ACUVO_GIT_SAFETY: '1' } };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. ISOLATION — the failure that has a memory entry
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐⭐ three agents write the SAME file and none of them can see another\'s work', async () => {
  const { repo, env } = scratch('three');

  const wts = [];
  for (const name of ['agent-a', 'agent-b', 'agent-c']) {
    const w = await createWorktree(repo, { name, env });
    assert.equal(w.ok, true, `create ${name}: ${w.error}`);
    assert.equal(w.branch, `acuvo/wt/${name}`);
    wts.push(w);
  }

  /**
   * ⚠️ CONCURRENTLY, NOT IN SEQUENCE. Sequential writes would pass even with no
   * isolation at all, because the last one would simply win — which is the bug.
   */
  await Promise.all(wts.map((w, i) => {
    writeFileSync(join(w.path, 'shared.txt'), `AGENT ${'ABC'[i]}\n`);
    writeFileSync(join(w.path, `only-${'ABC'[i]}.txt`), 'private\n');
    return null;
  }));

  for (const [i, w] of wts.entries()) {
    assert.equal(readFileSync(join(w.path, 'shared.txt'), 'utf8'), `AGENT ${'ABC'[i]}\n`,
      'each worktree must hold its own version of the shared file');
    assert.equal(existsSync(join(w.path, `only-${'ABC'[(i + 1) % 3]}.txt`)), false,
      'no agent may see another agent\'s private file');
  }

  // ⭐ THE ORIGINAL CHECKOUT IS UNTOUCHED — the half the collision detector could
  // never give you, because by the time it reports, the damage is on disk.
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'BASE\n');
  assert.equal(g(repo, 'status', '--porcelain').out, '', 'the main checkout must not be dirtied, and nothing may be staged into it');

  // Each worktree's own status names only its own changes — no dirty baseline.
  for (const [i, w] of wts.entries()) {
    const st = g(w.path, 'status', '--porcelain').out;
    assert.match(st, /shared\.txt/);
    assert.match(st, new RegExp(`only-${'ABC'[i]}\\.txt`));
    assert.equal(/only-[^ABC]/.test(st), false);
  }
});

test('⭐⭐ cleanup removes the UNCHANGED one and KEEPS both that hold work', async () => {
  const { repo, env } = scratch('cleanup');
  const base = g(repo, 'rev-parse', 'HEAD').out;

  const a = await createWorktree(repo, { name: 'dirty', env });
  const b = await createWorktree(repo, { name: 'committed', env });
  const c = await createWorktree(repo, { name: 'untouched', env });

  writeFileSync(join(a.path, 'shared.txt'), 'unfinished work\n');

  /**
   * ⚠️⚠️ THE CASE A `git status` CHECK ALONE GETS WRONG, AND IT IS THE
   * EXPENSIVE ONE. An agent that COMMITTED its result leaves a spotlessly clean
   * status — so a cleanup that only asks "is it clean" deletes finished work
   * and keeps unfinished work, which is exactly backwards.
   */
  writeFileSync(join(b.path, 'shared.txt'), 'finished work\n');
  g(b.path, 'add', '-A');
  g(b.path, 'commit', '-qm', 'agent b result');
  assert.equal(g(b.path, 'status', '--porcelain').out, '', 'the committed worktree must look CLEAN — that is the trap');

  const heads = { dirty: base, committed: base, untouched: base };
  const r = await cleanupWorktrees(repo, { env, baseHeads: heads });
  assert.equal(r.ok, true);

  assert.deepEqual(r.removed, ['untouched'], `only the unchanged worktree may be removed, got ${JSON.stringify(r.removed)}`);
  assert.equal(existsSync(c.path), false, 'the unchanged worktree must actually be gone from disk');
  assert.equal(existsSync(a.path), true, 'a worktree with uncommitted work must survive');
  assert.equal(existsSync(b.path), true, 'a worktree with its own commits must survive');

  const keptNames = r.kept.map((k) => k.name).sort();
  assert.deepEqual(keptNames, ['committed', 'dirty']);
  // ⭐ It names the paths, so a human can go and look. A boolean would not do.
  assert.ok(r.kept.find((k) => k.name === 'dirty').changed.includes('shared.txt'));

  // And the committed work is still reachable by branch after the cleanup ran.
  assert.equal(g(repo, 'log', '--oneline', '-1', 'acuvo/wt/committed').out.includes('agent b result'), true);
});

test('⚠️ remove REFUSES a worktree that holds work, and says which files', async () => {
  const { repo, env } = scratch('refuse');
  const w = await createWorktree(repo, { name: 'busy', env });
  writeFileSync(join(w.path, 'in-progress.txt'), 'an hour of work\n');

  const r = await removeWorktree(repo, { name: 'busy', env });
  assert.equal(r.ok, false);
  assert.equal(r.kept, true);
  assert.match(r.error, /in-progress\.txt/, 'the refusal must name the file, not just say no');
  assert.equal(existsSync(w.path), true);
  assert.equal(readFileSync(join(w.path, 'in-progress.txt'), 'utf8'), 'an hour of work\n');
});

test('⚠️ a forced removal still leaves the work recoverable in the shared object store', async () => {
  const { repo, env } = scratch('forced');
  const w = await createWorktree(repo, { name: 'doomed', env });
  writeFileSync(join(w.path, 'shared.txt'), 'PRECIOUS\n');

  const r = await removeWorktree(repo, { name: 'doomed', force: true, env });
  assert.equal(r.ok, true);
  assert.equal(existsSync(w.path), false, 'force must really remove it');
  assert.ok(r.undo, 'a forced removal must hand back a snapshot id');

  /**
   * ⭐ THE OBJECT DATABASE IS SHARED, so the snapshot taken inside a directory
   * that no longer exists is still readable from the main checkout. That is the
   * one property that makes forcing survivable, and it is git's, not ours.
   */
  const shown = spawnSync('git', ['show', `${r.undo}:shared.txt`], { cwd: repo, encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, 'PRECIOUS\n');
});

test('⚠️ a name that is not one clean segment is refused before anything is created', async () => {
  for (const bad of ['', '   ', 'a/b', 'a\\b', '..', 'x..y', 'x.lock', 'a b']) {
    const r = validateWorktreeName(bad);
    assert.equal(r.ok, false, `"${bad}" must be refused`);
  }
  /**
   * ⚠️ `-x` IS **ACCEPTED**, AND THAT IS CORRECT RATHER THAN AN OVERSIGHT. It is
   * a valid git ref name, and the argv-injection worry it raises does not apply:
   * the name is joined onto an ABSOLUTE path before it reaches `git worktree
   * add`, so what git receives never begins with a dash. Asserting it were
   * refused would be a check that fails correct work.
   */
  assert.equal(validateWorktreeName('-x').ok, true);
  assert.equal(validateWorktreeName('auth-fix').branch, 'acuvo/wt/auth-fix');
  // Two different repositories with the same basename must not share a namespace.
  assert.notEqual(repoKey('/a/api'), repoKey('/b/api'));
});

test('⚠️ a directory git does not account for is never swept away', async () => {
  const { repo, env } = scratch('stranger');
  const dir = join(worktreesHome(env), repoKey(repo), 'stranger');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'someone-elses.txt'), 'not ours\n');

  const r = await createWorktree(repo, { name: 'stranger', env });
  assert.equal(r.ok, false, 'it must refuse rather than delete a directory it cannot explain');
  assert.equal(readFileSync(join(dir, 'someone-elses.txt'), 'utf8'), 'not ours\n');
});

// ───────────────────────────────────────────────────────────────────────────
// 2. THE SAFETY NET — the `git checkout` memory
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐⭐ `git reset --hard` + `git clean -fd` really destroy the work, and it comes back', async () => {
  const { repo, env } = scratch('destroy');

  writeFileSync(join(repo, 'shared.txt'), 'AN HOUR OF WORK\n');
  writeFileSync(join(repo, 'brand-new.txt'), 'NEVER COMMITTED ANYWHERE\n');

  const snap = await snapshotWorkingTree(repo, { label: 'test', env });
  assert.equal(snap.ok, true, snap.error);
  assert.equal(snap.created, true);

  // ⭐ THE DESTRUCTION IS REAL. Both verbs, exactly as they appear in the memory.
  assert.equal(g(repo, 'reset', '--hard', 'HEAD').code, 0);
  assert.equal(g(repo, 'clean', '-fd').code, 0);
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'BASE\n', 'the tracked edit must really be gone');
  assert.equal(existsSync(join(repo, 'brand-new.txt')), false, 'the untracked file must really be gone');

  const r = await restoreSnapshot(repo, { commit: snap.commit, paths: ['shared.txt', 'brand-new.txt'], env });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.restored.sort(), ['brand-new.txt', 'shared.txt']);
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'AN HOUR OF WORK\n');
  assert.equal(readFileSync(join(repo, 'brand-new.txt'), 'utf8'), 'NEVER COMMITTED ANYWHERE\n');
});

test('⚠️⚠️ the snapshot leaves `.git/index` BYTE-IDENTICAL — it must never stage for the user', async () => {
  const { repo, env } = scratch('index');
  writeFileSync(join(repo, 'shared.txt'), 'changed\n');
  writeFileSync(join(repo, 'untracked.txt'), 'new\n');

  const indexPath = join(repo, '.git', 'index');
  const before = readFileSync(indexPath);
  const beforeStatus = g(repo, 'status', '--porcelain').raw;

  const snap = await snapshotWorkingTree(repo, { env });
  assert.equal(snap.ok, true, snap.error);

  assert.equal(Buffer.compare(before, readFileSync(indexPath)), 0,
    'a snapshot that writes the real index would stage the user\'s tree behind their back');
  assert.equal(g(repo, 'status', '--porcelain').raw, beforeStatus,
    'nothing may become staged: the porcelain must be identical, flags included');
  // ⚠️ COLUMN ONE IS THE ASSERTION. ` M` is unstaged; `M ` would mean we staged it.
  assert.match(beforeStatus, /^ M shared\.txt/m, 'and it must still read as UNSTAGED');
  assert.match(beforeStatus, /^\?\? untracked\.txt/m, 'and the untracked file must still be untracked');

  // The temp index must not be left behind to be seeded into the next snapshot.
  assert.equal(existsSync(join(repo, '.git', 'acuvo-safety-index')), false);
});

test('⭐ a repository with NO usable identity still snapshots — raw `commit-tree` cannot', async () => {
  /**
   * ── ⚠️⚠️ THIS TEST PASSED WHILE CHECKING NOTHING, AND ONLY MUTATION SAID SO ─
   *
   * The first version did `git config --unset user.email` and asserted the
   * snapshot still worked. Deleting the injected identity from `git-safety.mjs`
   * left it **GREEN**: `--unset` removes only the LOCAL setting, and this
   * machine has `user.email` set in the GLOBAL config, so
   * the repository was never identity-less at all. The control appeared to fail
   * only because the control itself passed empty `GIT_AUTHOR_*` variables —
   * i.e. the test proved that empty env vars break git, which nobody doubted.
   *
   * ⭐ THE REAL IDENTITY-LESS SHAPE IS `user.useConfigOnly`, which is what stops
   * git guessing a name from the OS user and hostname. That is the CI-container
   * case the injection exists for, and with it the mutation goes red.
   */
  const { repo, env } = scratch('identity');
  g(repo, 'config', 'user.useConfigOnly', 'true');
  g(repo, 'config', '--unset', 'user.email');
  g(repo, 'config', '--unset', 'user.name');
  // ⚠️ And the developer's global config is taken out of the picture, or this
  // test's result depends on whose laptop it runs on.
  const blind = { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  writeFileSync(join(repo, 'shared.txt'), 'work\n');

  /**
   * ⚠️ THE CONTROL, AND WITHOUT IT THIS TEST PROVES NOTHING. If plain
   * `commit-tree` succeeded here, the identity we inject would be dead code
   * that a green test was describing as load-bearing.
   */
  const tree = g(repo, 'write-tree').out;
  const raw = spawnSync('git', ['commit-tree', tree, '-m', 'x'], { cwd: repo, encoding: 'utf8', env: blind });
  assert.notEqual(raw.status, 0, 'the control must FAIL, or the identity injection is untested');
  assert.match(String(raw.stderr), /identity unknown|empty ident/i);

  const snap = await snapshotWorkingTree(repo, { env: blind });
  assert.equal(snap.ok, true, `ours must succeed where the control failed: ${snap.error}`);
  assert.equal(snap.created, true);
});

test('⭐ an unchanged tree is not snapshotted twice — the skip is a sha, not a guess', async () => {
  const { repo, env } = scratch('skip');
  writeFileSync(join(repo, 'shared.txt'), 'one\n');

  const a = await snapshotWorkingTree(repo, { env });
  assert.equal(a.created, true);
  const b = await snapshotWorkingTree(repo, { env });
  assert.equal(b.created, false, 'nothing changed, so nothing new may be written');
  assert.equal(b.commit, a.commit);

  writeFileSync(join(repo, 'shared.txt'), 'two\n');
  const c = await snapshotWorkingTree(repo, { env });
  assert.equal(c.created, true, 'a changed tree must produce a new snapshot');
  assert.notEqual(c.commit, a.commit);
});

test('⚠️ snapshots live outside `refs/heads` — invisible to branch, log and push', async () => {
  const { repo, env } = scratch('refs');
  writeFileSync(join(repo, 'shared.txt'), 'x\n');
  const snap = await snapshotWorkingTree(repo, { env });
  assert.ok(snap.ref.startsWith(SAFETY_REF_PREFIX));

  assert.equal(g(repo, 'branch', '--list').out.includes('acuvo'), false, 'no snapshot may appear as a branch');
  const listed = await listSnapshots(repo);
  assert.equal(listed.ok, true);
  assert.equal(listed.snapshots[0].commit, snap.commit);
});

test('⚠️ restore refuses "everything" and never deletes a file made after the snapshot', async () => {
  const { repo, env } = scratch('restore-limits');
  writeFileSync(join(repo, 'shared.txt'), 'before\n');
  const snap = await snapshotWorkingTree(repo, { env });

  const none = await restoreSnapshot(repo, { commit: snap.commit, paths: [], env });
  assert.equal(none.ok, false);
  assert.match(none.error, /name the paths/);

  writeFileSync(join(repo, 'made-later.txt'), 'newer work\n');
  const r = await restoreSnapshot(repo, { commit: snap.commit, paths: ['shared.txt'], env });
  assert.equal(r.ok, true, r.error);
  assert.equal(existsSync(join(repo, 'made-later.txt')), true,
    'restore must never sweep away work created after the snapshot');
  assert.ok(r.undo, 'restore must itself be undoable');
});

test('⚠️⚠️ restore is BYTE-EXACT — the first draft spliced head+tail over the user\'s file', async () => {
  /**
   * ── THE DEFECT THIS PINS, FOUND IN THIS FILE'S OWN FIRST DRAFT ─────────────
   *
   * `restoreSnapshot` originally read the blob through `spawnBounded`, which
   * caps captured stdout at `MAX_CAPTURED_CHARS * 4` = 32,000 chars and keeps a
   * HEAD AND A TAIL, dropping the middle. Correct for a test runner's output;
   * catastrophic for a file. Every restore over ~32 KB wrote a splice over the
   * user's work and returned `ok: true`.
   *
   * ⚠️ AND A SMALL-FILE TEST WOULD HAVE PASSED THE WHOLE TIME. The size here is
   * the assertion.
   */
  const { repo, env } = scratch('big');
  const big = Array.from({ length: 40_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  assert.ok(big.length > 100_000, 'the fixture must exceed the 32,000-char capture cap by a wide margin');
  writeFileSync(join(repo, 'big.txt'), big);

  // And a genuinely binary file, which a string decode would fill with U+FFFD.
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01, 0x80, 0x00, 0x7f]);
  writeFileSync(join(repo, 'logo.png'), binary);

  const snap = await snapshotWorkingTree(repo, { env });
  assert.equal(snap.ok, true, snap.error);

  writeFileSync(join(repo, 'big.txt'), 'destroyed\n');
  writeFileSync(join(repo, 'logo.png'), Buffer.from([0x00]));

  const r = await restoreSnapshot(repo, { commit: snap.commit, paths: ['big.txt', 'logo.png'], env });
  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(join(repo, 'big.txt'), 'utf8'), big, 'a large file must come back whole, not head+tail');
  assert.equal(Buffer.compare(readFileSync(join(repo, 'logo.png')), binary), 0, 'a binary file must come back byte-for-byte');
});

test('⚠️ restore honours the repository\'s line endings — `git show` alone does not', async () => {
  /**
   * ⚠️ THE SECOND DEFECT IN THE SAME LINE. `git show <sha>:<path>` prints the
   * RAW BLOB, which git stores with LF. On `core.autocrlf=true` — the Windows
   * default, and set globally on the machine this was written on — that writes
   * LF files into a CRLF checkout, so every restored file reads as wholly
   * modified afterwards. `cat-file --filters` applies what a checkout would.
   */
  const { repo, env } = scratch('crlf', { autocrlf: 'true' });
  writeFileSync(join(repo, 'shared.txt'), 'one\r\ntwo\r\n');
  const snap = await snapshotWorkingTree(repo, { env });
  assert.equal(snap.ok, true, snap.error);

  writeFileSync(join(repo, 'shared.txt'), 'destroyed\r\n');
  const r = await restoreSnapshot(repo, { commit: snap.commit, paths: ['shared.txt'], env });
  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'one\r\ntwo\r\n',
    'the restored file must carry the checkout\'s line endings, not the blob\'s');
});

test('⚠️ the classifier is a mouth, not a gate — a miss costs a sentence, never the snapshot', async () => {
  const { repo, env } = scratch('classify');
  writeFileSync(join(repo, 'shared.txt'), 'work\n');

  assert.equal(destructiveIntent('git reset --hard').destructive, true);
  assert.equal(destructiveIntent('rm -rf build').destructive, true);
  assert.equal(destructiveIntent('npm test').destructive, false);

  /**
   * ⭐ THE POINT OF THE WHOLE DESIGN. A command the classifier does not
   * recognise is still snapshotted — this one destroys a file through node,
   * which no pattern list will ever match.
   */
  const sneaky = 'node -e "require(\'fs\').unlinkSync(\'shared.txt\')"';
  assert.equal(destructiveIntent(sneaky).destructive, false, 'the classifier must genuinely miss this');
  const guarded = await guardCommand(repo, sneaky, { env });
  assert.equal(guarded.snapshotted, true, 'and the snapshot must have been taken anyway');
  assert.equal(guarded.note, null, 'with no note, because nothing looked destructive');

  const g2 = await guardCommand(repo, 'git checkout -- .', { env });
  assert.equal(g2.snapshotted, true);
  assert.match(String(g2.note), /snapshot/i);
});

test('⚠️ the guard never refuses, and the off switch is an env var the agent cannot reach', async () => {
  const notARepo = mkdtempSync(join(realpathSync(tmpdir()), 'acuvo-norepo-'));
  made.push(notARepo);
  const r = await guardCommand(notARepo, 'git reset --hard');
  assert.equal(r.snapshotted, false);
  assert.equal(r.note, null, 'a failure to snapshot must be silent, never a refusal');

  assert.equal(safetyEnabled({}), true, 'it must default ON — the polarity is opposite to ALLOW_PUSH');
  for (const off of ['0', 'false', 'no', 'off', 'OFF']) assert.equal(safetyEnabled({ [SAFETY_ENV]: off }), false);
  assert.equal(safetyEnabled({ [SAFETY_ENV]: '1' }), true);
});

test('⭐⭐ both halves work from INSIDE a linked worktree — which is what this checkout is', async () => {
  /**
   * ── ⚠️ THE SHAPE THAT BREAKS A NAIVE IMPLEMENTATION ────────────────────────
   *
   * `C:/Projects/claude-build-closer-wt` — where this package is developed — is
   * itself a linked worktree of `C:/Projects/claude-build`, one of 29. In a
   * linked worktree `rev-parse --git-dir` returns `…/.git/worktrees/<name>`,
   * NOT the shared `…/.git`, and the index lives in the former. Code that
   * assumes `<root>/.git/index` seeds the snapshot from the WRONG repository's
   * index — silently, and only for the people most likely to be running it.
   *
   * ⭐ And `git worktree add` from inside a linked worktree is legal; a guard
   * that refused it would darken the feature exactly here.
   */
  const { base, repo, env } = scratch('linked');
  const linked = join(base, 'linked-wt');
  assert.equal(g(repo, 'worktree', 'add', '-q', linked, '-b', 'feature').code, 0);

  assert.match(g(linked, 'rev-parse', '--absolute-git-dir').out, /worktrees[\\/]/,
    'the fixture must really be a linked worktree, or this test proves nothing');

  const w = await createWorktree(linked, { name: 'from-linked', env });
  assert.equal(w.ok, true, `create from a linked worktree: ${w.error}`);

  writeFileSync(join(linked, 'shared.txt'), 'WORK IN THE LINKED WORKTREE\n');
  const snap = await snapshotWorkingTree(linked, { env });
  assert.equal(snap.ok, true, snap.error);
  assert.equal(snap.created, true, 'it must see the LINKED worktree\'s changes, not the main one\'s');

  // ⭐ The exact command from the memory entry, run for real.
  assert.equal(g(linked, 'checkout', '--', 'shared.txt').code, 0);
  assert.equal(readFileSync(join(linked, 'shared.txt'), 'utf8'), 'BASE\n', 'it must really have destroyed the work');

  const r = await restoreSnapshot(linked, { commit: snap.commit, paths: ['shared.txt'], env });
  assert.equal(r.ok, true, r.error);
  assert.equal(readFileSync(join(linked, 'shared.txt'), 'utf8'), 'WORK IN THE LINKED WORKTREE\n');
});

// ───────────────────────────────────────────────────────────────────────────
// 3. REACH — the dispatcher and the offer, not just the library
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐⭐ both halves REACH the model through the real dispatcher', async () => {
  const { repo, env } = scratch('reach');
  const executor = { root: repo, dryRun: false, env };
  const call = (name, args) => executeToolCall(
    { id: 't1', function: { name, arguments: JSON.stringify(args) } },
    executor,
    { allowRun: true, shell: true, commandTimeoutMs: 60_000 },
  );

  assert.ok(TOOL_NAMES.includes('git_worktree'), 'it must be in the registry');
  assert.ok(toolNamesForRounds(5, { allowRun: true, root: repo, env }).includes('git_worktree'), 'and it must be OFFERED');

  const created = await call('git_worktree', { action: 'create', name: 'dispatch-test' });
  assert.equal(created.result.ok, true, JSON.stringify(created.result));
  assert.ok(existsSync(created.result.path));

  const listed = await call('git_worktree', { action: 'list' });
  assert.equal(listed.result.worktrees.length, 1);

  const bogus = await call('git_worktree', { action: 'nuke', name: 'x' });
  assert.equal(bogus.result.ok, false, 'the enum is an offer, never the boundary — the dispatcher must re-check');

  /**
   * ⚠️⚠️ THE ONE THAT MATTERS MOST. `force` is not a schema parameter, and the
   * dispatcher must not forward it even when a model emits it anyway — a
   * resumed session or a provider echoing a stale tool list is all it takes.
   */
  writeFileSync(join(created.result.path, 'shared.txt'), 'work in the worktree\n');
  const forced = await call('git_worktree', { action: 'remove', name: 'dispatch-test', force: true });
  assert.equal(forced.result.ok, false, 'a model must never be able to force a removal');
  assert.equal(existsSync(created.result.path), true);
});

test('⭐⭐ run_command snapshots BEFORE it runs — proved by destroying work through it', async () => {
  const { repo, env } = scratch('run-guard');
  const executor = { root: repo, dryRun: false, env };
  const call = (name, args) => executeToolCall(
    { id: 't1', function: { name, arguments: JSON.stringify(args) } },
    executor,
    { allowRun: true, shell: true, commandTimeoutMs: 60_000 },
  );

  writeFileSync(join(repo, 'shared.txt'), 'AGENT WORK\n');
  writeFileSync(join(repo, 'extra.txt'), 'ALSO AGENT WORK\n');

  const r = await call('run_command', { command: 'git reset --hard HEAD && git clean -fd' });
  assert.equal(r.result.ok, true, JSON.stringify(r.result));
  assert.match(String(r.result.safety), /snapshot/i, 'a destructive-looking command must carry the undo id');

  // It really destroyed both.
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'BASE\n');
  assert.equal(existsSync(join(repo, 'extra.txt')), false);

  // And the snapshot taken by the dispatcher — not by this test — brings them back.
  const snaps = await listSnapshots(repo);
  const restored = await restoreSnapshot(repo, { commit: snaps.snapshots.at(-1).commit, paths: ['shared.txt', 'extra.txt'], env });
  assert.equal(restored.ok, true, restored.error);
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'AGENT WORK\n');
  assert.equal(readFileSync(join(repo, 'extra.txt'), 'utf8'), 'ALSO AGENT WORK\n');

  // ⚠️ And an ordinary command carries no note — a guard that talks constantly
  // is one the model learns to skim.
  const quiet = await call('run_command', { command: 'node -e "console.log(1)"' });
  assert.equal('safety' in quiet.result, false);
});

test('⚠️ `--no-run` withholds git_worktree at the DISPATCHER, not only at the offer', async () => {
  const { repo, env } = scratch('no-run');
  const executor = { root: repo, dryRun: false, env };
  const r = await executeToolCall(
    { id: 't1', function: { name: 'git_worktree', arguments: JSON.stringify({ action: 'create', name: 'x' }) } },
    executor,
    { allowRun: false },
  );
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /--no-run/);
  assert.equal(worktreeToolNames({ allowRun: false, maxRounds: 5 }).length, 0);
  assert.equal(worktreeToolNames({ allowRun: true, maxRounds: 1 }).length, 0, 'single-shot has no round to use the path in');
});

test('⚠️ a memory workspace has no disk, so git_worktree refuses by capability', async () => {
  const r = await executeToolCall(
    { id: 't1', function: { name: 'git_worktree', arguments: JSON.stringify({ action: 'list' }) } },
    { root: '(memory)', dryRun: false },
    { allowRun: true },
  );
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /not backed by a git repository/);
});

// ───────────────────────────────────────────────────────────────────────────
// 4. THE BYTE CEILING — a verb costs on EVERY round, including "hi"
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ git_worktree costs ZERO bytes on an unsignalled brief — it is classified', async () => {
  /**
   * ⚠️ THE DEFECT THIS PINS HAS SHIPPED TWICE (`chart` + `syndicate`, 2,852 B;
   * `find_symbol` + `apply_patch` + `pipe_to_asset`, 5,293 B). `shortlistTools`
   * KEEPS anything it cannot classify, so a verb in no group rides along on
   * "hi" and is paid for on every request of every task for ever.
   */
  assert.ok(TOOL_GROUPS.vcs.tools.includes('git_worktree'), 'it must be in a group, or it is charged to every task');

  const offer = toolNamesForRounds(5);
  assert.equal(shortlistTools('hi', offer).includes('git_worktree'), false);
  assert.equal(shortlistTools('fix the failing type error in src/auth.ts', offer).includes('git_worktree'), false);
  assert.equal(shortlistTools('commit the changes and open a PR', offer).includes('git_worktree'), true);
  assert.equal(shortlistTools('run three agents in isolated worktrees', offer).includes('git_worktree'), true,
    'the words that mean isolation must reach it without the word "git"');

  const schema = worktreeToolSchemas()[0];
  assert.ok(JSON.stringify(schema).length < 1_200, 'one schema, three actions — see gh.mjs on why nine would be wrong');
  assert.deepEqual(schema.function.parameters.properties.action.enum, ['create', 'list', 'remove']);
  assert.equal('force' in schema.function.parameters.properties, false,
    'forcing is an operator act; the model must not even be shown the word');
});
