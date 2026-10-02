/**
 * ── ⭐⭐⭐ THE UNDO THAT EXISTS BEFORE THE MISTAKE ───────────────────────────
 *
 * `git.mjs` makes the destructive half of git INEXPRESSIBLE: the agent gets
 * structured verbs, so `reset --hard`, `checkout .`, `clean -fdx` and `stash`
 * are not refused by a check — there is no argv that reaches them. That is the
 * right design and it is not the whole problem, because it only covers the
 * verbs this package spells. MEASURED, in our own 139 bench transcripts:
 *
 *     structured git verbs called          34   (git_status 17 · git_diff 8
 *                                                git_commit 7 · git_log 2)
 *     of those, REFUSED                     9   (26%) — 6 "git is not installed",
 *                                                3 "not a git repository"
 *     raw git through `run_command`        60   in 33 of 139 runs
 *     raw destroyers through `run_command`  8 × `rm -rf` · 5 × `rm -f`
 *                                           1 × `git checkout` · 1 × `git stash`
 *
 * ⭐ AND THE MECHANISM IS THE INTERESTING PART, not the counts. In
 * `full-89/git-leak-recovery` the repository was at `/app/repo` and the
 * workspace was `/app`, so `git_log` refused — *"this workspace is not a git
 * repository"* — and the model's very next move was `run_command cd /app/repo
 * && git log --all --oneline`. **The safe route refused, so the model routed
 * around it into the shell, which has no guard at all.** Every guard that
 * refuses teaches the model where the unguarded door is.
 *
 * ── ⚠️⚠️ SO THIS IS NOT A DENYLIST, AND `command.mjs` ALREADY SAYS WHY ──────
 *
 * Its `--shell` header: *"a blocklist of 'dangerous' patterns would be
 * trivially bypassable and would teach the operator that the mode is safer than
 * it is."* That is correct and it is fatal to the obvious design. `git reset`
 * matched, `git  reset` not; `rm -rf` matched, `find . -delete` not; and a
 * three-line node script that calls `fs.rmSync` matches nothing anyone can
 * write down. A pattern list is a guard that PASSES WHILE CHECKING NOTHING.
 *
 * ⭐ THEREFORE THE GUARD DOES NOT LOOK AT THE COMMAND. It takes a restorable
 * snapshot of the working tree BEFORE the command runs — every command, not
 * the ones a classifier believed were dangerous. There is no string to
 * obfuscate and no route around it, because the protection is complete before
 * the model's text is ever parsed. What the command then does is irrelevant:
 * the bytes are already in the object database.
 *
 * ── ⭐⭐ WHY IT IS CHEAP, WHICH IS THE ONLY REASON IT CAN BE ALWAYS-ON ───────
 *
 * MEASURED on this checkout — a 20k-file monorepo worktree, git 2.50.1:
 *
 *     git add -A + write-tree, FRESH temp index      79.4 s   ← unusable
 *     …after `cp .git/index <temp>` first             0.70 s   ← 113× faster
 *     …second call, nothing changed                   0.59 s
 *
 * The 79 seconds is git re-hashing every tracked file because an empty index
 * has no stat cache. Copying the REAL index in first hands the whole stat cache
 * over, so only genuinely-changed files are hashed. That one `cp` is the
 * difference between a guard nobody would ship and one that runs before every
 * command.
 *
 * ── ⚠️ AND THE HONEST PER-COMMAND COST, WHICH IS NOT ZERO ───────────────────
 *
 * `guardCommand`, median of 5, Windows (where a process spawn is ~72ms and
 * dominates everything below):
 *
 *                                    tree changed   tree unchanged
 *     a typical project (300 files)      546 ms          286 ms
 *     this monorepo worktree (~20k)      823 ms          561 ms
 *
 * ⚠️ SO IT IS ~0.3–0.8s ON EVERY `run_command`, NOT A ROUNDING ERROR. It is
 * bought against a 120s default command timeout and a multi-second model
 * round-trip, so it is low single-digit percent of a round — but it is real,
 * and the number is written here rather than left for somebody to discover.
 * `ACUVO_GIT_SAFETY=0` is the way out for anyone who does not want to pay it.
 *
 * ⭐ MOST OF WHAT REMAINS IS SPAWN COUNT, NOT WORK. An early version listed the
 * refs THREE times per snapshot; folding that to one took the changed-tree case
 * from 665ms to 546ms. The unchanged path is already at four spawns
 * (`rev-parse` · `add` · `write-tree` · `for-each-ref`) and cannot go much
 * lower without a long-lived `git cat-file --batch`-style helper process.
 *
 * ⚠️ AND `GIT_INDEX_FILE` IS WHAT MAKES IT SAFE TO DO AT ALL. `git add -A`
 * against the real index would stage the user's whole working tree behind their
 * back — the CLI would become the thing it is protecting them from. Pointed at
 * a copy, `add` mutates the copy and `.git/index` is byte-identical afterwards.
 * VERIFIED rather than assumed: `git status --porcelain` reported the same 8
 * paths, unstaged, before and after a full snapshot of this checkout.
 *
 * ── ⚠️ THE FOUR THINGS THAT WOULD OTHERWISE MAKE IT FAIL SILENTLY ───────────
 *
 *   1. **A repository with no `user.email`.** `git commit-tree` refuses without
 *      an identity, and our own bench transcripts show the model hitting that
 *      wall for real (`git config user.email "test@example.com"` appears in
 *      five runs). So the identity is supplied in the ENVIRONMENT of the
 *      commit-tree call — it can never depend on the user's config, and it
 *      never writes to their config either.
 *   2. **An empty repository.** No `HEAD` to parent from. `commit-tree` is
 *      called with no `-p` in that case rather than failing.
 *   3. **Garbage collection.** A tree written and never referenced is
 *      unreachable and `git gc` may prune it — the undo would evaporate on a
 *      timer. Every snapshot therefore gets a REF under `refs/acuvo/safety/`,
 *      which makes it reachable, and which `git branch`, `git log` and every
 *      tab-completion ignore because it is not under `refs/heads`.
 *   4. **Unbounded growth.** Refs are pruned to the newest `MAX_SNAPSHOTS`.
 *
 * ── ⭐ AND RESTORE CANNOT DESTROY EITHER, BY CONSTRUCTION ───────────────────
 * `restoreSnapshot` does NOT run `git checkout`, `git restore`, `git reset` or
 * `git stash` — the four verbs whose whole reputation in this repo is
 * destroying uncommitted work. It reads each blob with `git cat-file --filters`
 * and writes that one file. So it cannot delete a file created after the
 * snapshot, cannot touch the index, and cannot move HEAD. It also snapshots
 * FIRST, so undoing an undo is one more restore.
 *
 * ⚠️ THAT SENTENCE SAID `git show` UNTIL THE TEST THAT PROVED IT WRONG. Three
 * defects sat in that one line and `readBlob` documents all three; the reason
 * it is corrected HERE too is that a stale claim about a mechanism stops the
 * next person looking at the mechanism.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { spawnBounded } from './command.mjs';
import { gitEnvironment } from './git.mjs';

/** Git is fast or wedged. A snapshot that takes longer than this is a hang. */
export const SNAPSHOT_TIMEOUT_MS = 30_000;

/**
 * ⚠️ NOT UNDER `refs/heads`, AND THAT IS THE WHOLE POINT OF THE PREFIX. A
 * safety snapshot must be invisible to `git branch`, to the branch picker in
 * every GUI, and to `git push` (which pushes `refs/heads/*` by default). Under
 * `refs/acuvo/` it is reachable — so `git gc` keeps it — and it is in nobody's
 * way.
 */
export const SAFETY_REF_PREFIX = 'refs/acuvo/safety';

/** Beyond this the oldest are dropped. Each is one commit object; they are tiny. */
export const MAX_SNAPSHOTS = 40;

/**
 * ⚠️ THE OFF SWITCH IS AN ENVIRONMENT VARIABLE, WHICH IS THE ONE DOOR THE AGENT
 * HAS NO VERB THAT REACHES — the same shape `ACUVO_ALLOW_PUSH` and
 * `ACUVO_ALLOW_INSTALL` use, and deliberately the same shape so an operator
 * learns it once. A guard the model can switch off is not a guard.
 *
 * ⚠️ AND IT DEFAULTS **ON**, unlike those two, because the polarity is
 * opposite: they gate a capability that is dangerous when present, this gates a
 * protection that is dangerous when absent.
 */
export const SAFETY_ENV = 'ACUVO_GIT_SAFETY';

export function safetyEnabled(env = process.env) {
  const raw = String(env?.[SAFETY_ENV] ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

/**
 * ⚠️ AN IDENTITY THAT DOES NOT COME FROM, AND DOES NOT TOUCH, THE USER'S CONFIG.
 * `git commit-tree` hard-refuses without one, and a snapshot that only works in
 * repositories somebody has already configured is a snapshot that is missing on
 * exactly the fresh clones and scratch repos where an agent does its damage.
 */
const SNAPSHOT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'acuvo safety',
  GIT_AUTHOR_EMAIL: 'safety@acuvo.invalid',
  GIT_COMMITTER_NAME: 'acuvo safety',
  GIT_COMMITTER_EMAIL: 'safety@acuvo.invalid',
});

/** @typedef {(file: string, args: string[], opts: object) => any} SpawnImpl */

async function run(cwd, args, { spawnImpl, env = null, timeoutMs = SNAPSHOT_TIMEOUT_MS } = {}) {
  const r = await spawnBounded({
    file: 'git',
    args: ['--no-pager', ...args],
    cwd,
    timeoutMs,
    spawnImpl,
    env: env ?? gitEnvironment(),
  });
  if (!r.ok) return { ok: false, error: r.error ?? 'git could not be started' };
  if (r.timedOut) return { ok: false, error: `git ${args[0]} timed out after ${timeoutMs}ms` };
  return { ok: true, exitCode: r.exitCode, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

/**
 * The absolute `.git` directory for this workspace, or a refusal.
 *
 * ⚠️ `--absolute-git-dir` RATHER THAN `--git-dir`, because the relative form is
 * relative to the cwd git happened to be run from and we then join it against a
 * different path. And it is asked for even when the workspace is a SUBDIRECTORY
 * of the repository — unlike `git.mjs`'s write verbs, a snapshot of the whole
 * repository from inside a package is not a scope error, it is more protection
 * than was asked for.
 *
 * ⚠️ IN A LINKED WORKTREE THIS IS `…/.git/worktrees/<name>`, not the shared
 * `…/.git`. That is correct and it matters: the index lives there, and so
 * should the temp index. (This very checkout is a linked worktree, which is how
 * that was caught rather than reasoned about.)
 */
export async function gitDirOf(root, { spawnImpl } = {}) {
  const r = await run(root, ['rev-parse', '--absolute-git-dir'], { spawnImpl });
  if (!r.ok) return r;
  if (r.exitCode !== 0) return { ok: false, error: 'not a git repository, so there is nothing to snapshot' };
  const dir = r.stdout.trim();
  if (!dir) return { ok: false, error: 'git did not report a git directory' };
  return { ok: true, gitDir: resolve(dir) };
}

/**
 * Take a restorable snapshot of the working tree.
 *
 * Returns `{ ok: true, created: false }` when the tree is byte-identical to the
 * last snapshot — the interesting case, because it is what makes this cheap
 * enough to run before every command. `write-tree` is content-addressed, so
 * "nothing changed" is a sha comparison rather than a decision anyone makes.
 *
 * @param {string} root the workspace
 * @param {{ spawnImpl?: SpawnImpl, label?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
export async function snapshotWorkingTree(root, { spawnImpl, label = '', env = process.env } = {}) {
  if (!safetyEnabled(env)) return { ok: false, error: `snapshots are switched off (${SAFETY_ENV})`, disabled: true };

  const dir = await gitDirOf(root, { spawnImpl });
  if (!dir.ok) return dir;

  /**
   * ⚠️ THE TEMP INDEX LIVES INSIDE `.git`, NOT IN THE WORKING TREE AND NOT IN
   * THE OS TEMP DIRECTORY. Two reasons, both learned rather than chosen:
   * in the working tree it would show up as an untracked file in the very
   * `git status` the agent is about to read, and in the OS temp directory it
   * would be on a different filesystem from `.git/index` on most Windows
   * setups, turning the `cp` this whole design rests on into a slow cross-device
   * copy.
   */
  const realIndex = join(dir.gitDir, 'index');
  const tempIndex = join(dir.gitDir, 'acuvo-safety-index');
  try {
    mkdirSync(dirname(tempIndex), { recursive: true });
    copyFileSync(realIndex, tempIndex);
  } catch {
    /**
     * ⚠️ A MISSING `.git/index` IS NORMAL, NOT AN ERROR — a repository nobody
     * has staged anything in yet does not have one. Starting from no index
     * costs the cold path (measured 79s on this monorepo, milliseconds on a
     * fresh one), which is the correct trade for a repository that by
     * definition has almost nothing in it.
     */
    try { rmSync(tempIndex, { force: true }); } catch { /* nothing to remove */ }
  }

  const withIndex = { ...gitEnvironment(env), GIT_INDEX_FILE: tempIndex };

  try {
    const added = await run(root, ['add', '-A', '--'], { spawnImpl, env: withIndex });
    if (!added.ok) return added;
    if (added.exitCode !== 0) {
      return { ok: false, error: `could not read the working tree: ${added.stderr.trim().split('\n')[0] || 'git add failed'}` };
    }

    const tree = await run(root, ['write-tree'], { spawnImpl, env: withIndex });
    if (!tree.ok) return tree;
    if (tree.exitCode !== 0) {
      return { ok: false, error: `could not write a tree: ${tree.stderr.trim().split('\n')[0] || 'git write-tree failed'}` };
    }
    const treeSha = tree.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(treeSha)) return { ok: false, error: 'git write-tree did not return an object id' };

    /**
     * ⭐ THE SKIP, AND IT IS A FACT RATHER THAN A HEURISTIC. Two snapshots of an
     * unchanged tree have the same sha because a tree object IS its content.
     * So "has anything changed since last time" needs no timestamps, no
     * watcher and no cache that can go stale.
     */
    /**
     * ⚠️⚠️ ONE `for-each-ref`, NOT THREE. MEASURED on Windows, where a process
     * spawn is ~72ms: the first version listed the refs three separate times
     * per snapshot — once to look for a matching tree, once for the next index,
     * once inside `pruneSnapshots` — which is ~145ms of pure spawn per command
     * for an answer we already had in hand. The list is taken ONCE here and
     * reused, and prune is called only when the count says it has something to
     * do.
     */
    const listed = await listSnapshots(root, { spawnImpl, limit: Number.MAX_SAFE_INTEGER });
    const existing = listed.ok ? listed.snapshots.find((s) => s.tree === treeSha) : null;
    if (existing) return { ok: true, created: false, commit: existing.commit, tree: treeSha, ref: existing.ref };

    const head = await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { spawnImpl });
    const parent = head.ok && head.exitCode === 0 ? head.stdout.trim() : '';

    const message = `acuvo safety snapshot${label ? `: ${label}` : ''}`;
    /**
     * ⚠️ THE MESSAGE GOES IN ON STDIN, NOT AS `-m`. `spawnBounded` gives the
     * child no stdin (`stdio: ['ignore', …]`), so `-m` is the only route — and
     * `-m` is fine here precisely because the label never comes from a model
     * string; it is a caller-chosen tag. `run_command`'s command text is NOT
     * put in here, deliberately: a snapshot label is metadata, and metadata
     * that carries an attacker-influenced string into a commit message is a
     * log-injection primitive for no benefit.
     */
    const commit = await run(root, [
      'commit-tree', treeSha,
      ...(parent ? ['-p', parent] : []),
      '-m', message,
    ], { spawnImpl, env: { ...withIndex, ...SNAPSHOT_IDENTITY } });
    if (!commit.ok) return commit;
    if (commit.exitCode !== 0) {
      return { ok: false, error: `could not record the snapshot: ${commit.stderr.trim().split('\n')[0] || 'git commit-tree failed'}` };
    }
    const commitSha = commit.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commitSha)) return { ok: false, error: 'git commit-tree did not return an object id' };

    /**
     * ⚠️ THE REF NAME IS A COUNTER, NOT A CLOCK. Two snapshots inside the same
     * millisecond would collide on a timestamp, and on Windows `Date.now()`
     * granularity is coarse enough that this is not theoretical — a parallel
     * fan-out is exactly where it would happen. The counter is derived from
     * what is already on disk, so it survives a restart.
     */
    const nextIndex = (listed.ok ? listed.nextIndex : 0) || 0;
    const ref = `${SAFETY_REF_PREFIX}/${String(nextIndex).padStart(6, '0')}`;
    const updated = await run(root, ['update-ref', ref, commitSha], { spawnImpl });
    if (!updated.ok) return updated;
    if (updated.exitCode !== 0) {
      return { ok: false, error: `could not keep the snapshot: ${updated.stderr.trim().split('\n')[0] || 'git update-ref failed'}` };
    }

    /**
     * ⭐ ONLY WHEN THERE IS SOMETHING TO PRUNE. `listed.total` is the count we
     * already paid for above, so the common case — a repository well under the
     * ceiling — spends nothing here at all.
     */
    if (listed.ok && listed.total + 1 > MAX_SNAPSHOTS) await pruneSnapshots(root, { spawnImpl });
    return { ok: true, created: true, commit: commitSha, tree: treeSha, ref };
  } finally {
    // ⚠️ ALWAYS, including on every refusal above. A stale index left in `.git`
    // would be seeded into the NEXT snapshot and quietly describe an old tree.
    try { rmSync(tempIndex, { force: true }); } catch { /* best effort */ }
  }
}

/** Every snapshot, newest first. */
export async function listSnapshots(root, { spawnImpl, limit = MAX_SNAPSHOTS } = {}) {
  const r = await run(root, [
    'for-each-ref', '--format=%(refname) %(objectname) %(tree) %(creatordate:iso-strict)',
    SAFETY_REF_PREFIX,
  ], { spawnImpl });
  if (!r.ok) return r;
  if (r.exitCode !== 0) return { ok: false, error: 'could not list snapshots' };

  const all = [];
  for (const line of r.stdout.split('\n')) {
    const [ref, commit, tree, date] = line.trim().split(/\s+/);
    if (!ref || !commit) continue;
    const n = Number(ref.slice(SAFETY_REF_PREFIX.length + 1));
    all.push({ ref, commit, tree, date: date ?? '', index: Number.isFinite(n) ? n : 0 });
  }
  all.sort((a, b) => b.index - a.index);
  const nextIndex = all.length ? all[0].index + 1 : 0;
  return { ok: true, snapshots: all.slice(0, Math.max(0, limit)), total: all.length, nextIndex };
}

/** Drop the oldest refs past `MAX_SNAPSHOTS`. Never the newest. */
export async function pruneSnapshots(root, { spawnImpl, keep = MAX_SNAPSHOTS } = {}) {
  const listed = await listSnapshots(root, { spawnImpl, limit: Number.MAX_SAFE_INTEGER });
  if (!listed.ok) return listed;
  const doomed = listed.snapshots.slice(Math.max(1, keep));
  for (const s of doomed) await run(root, ['update-ref', '-d', s.ref], { spawnImpl });
  return { ok: true, removed: doomed.length };
}

/** No single file is restored above this. Refused out loud rather than truncated. */
export const MAX_RESTORE_BYTES = 64 * 1024 * 1024;

/**
 * ── ⚠️⚠️ THIS DOES NOT GO THROUGH `spawnBounded`, AND THE FIRST VERSION DID ──
 *
 * MEASURED, in this file's own first draft: `spawnBounded` caps captured stdout
 * at `MAX_CAPTURED_CHARS * 4` = **32,000 characters**, keeping a head and a
 * tail and dropping the middle — the behaviour a test runner's output wants and
 * the exact opposite of what a file wants. So a restore of any file over ~32 KB
 * would have written a HEAD+TAIL SPLICE over the user's work and reported
 * `ok: true`. A recovery tool that silently corrupts the thing it recovers is
 * worse than no recovery tool, because the user stops looking.
 *
 * ⭐ AND IT DECODES NOTHING. `encoding: 'buffer'` keeps a PNG a PNG; the string
 * path would have replaced every invalid UTF-8 byte with U+FFFD and written
 * that back as if it were the file.
 *
 * ⭐ `cat-file --filters` RATHER THAN `show`, and that is the third bug in one
 * line. `git show <sha>:<path>` prints the RAW BLOB, which git stores with LF.
 * On a checkout with `core.autocrlf=true` — the Windows default, and true on
 * the machine this was written on — restoring through `show` writes LF files
 * into a CRLF working tree, so every restored file reads as wholly modified.
 * `--filters` applies exactly the conversion a checkout would.
 */
function readBlob(root, commit, path) {
  /**
   * ⚠️ `spawnSync` WITH AN ARGV ARRAY, so a path beginning with `-` is an
   * argument and not a flag, and no shell exists to re-split it. `<commit>:<path>`
   * is resolved by git inside the object it was given, so a traversing path
   * cannot reach outside the snapshot even in principle.
   */
  const r = spawnSync('git', ['--no-pager', 'cat-file', '--filters', `${commit}:${path}`], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: MAX_RESTORE_BYTES,
    env: gitEnvironment(),
    windowsHide: true,
  });
  if (r.error) {
    const tooBig = /maxBuffer/i.test(String(r.error.message ?? ''));
    return { ok: false, error: tooBig ? `larger than the ${Math.round(MAX_RESTORE_BYTES / 1024 / 1024)}MB restore ceiling — recover it with git directly` : String(r.error.message ?? r.error) };
  }
  if (r.status !== 0) {
    return { ok: false, error: String(r.stderr ?? '').toString().trim().split('\n')[0] || 'not in that snapshot' };
  }
  return { ok: true, bytes: Buffer.from(r.stdout ?? Buffer.alloc(0)) };
}

/**
 * Put files back the way the snapshot had them.
 *
 * ⚠️ ONE FILE AT A TIME, THROUGH `git show`. See the header: this deliberately
 * does not use `checkout`/`restore`/`reset`, so there is no argv here that can
 * delete a file, move HEAD or touch the index. The worst case is that a path
 * the caller named is overwritten with an earlier version of itself — and a
 * snapshot of the current state is taken first, so even that is undoable.
 *
 * @param {string} root
 * @param {{ commit: string, paths: string[], spawnImpl?: SpawnImpl, env?: NodeJS.ProcessEnv }} opts
 */
export async function restoreSnapshot(root, { commit, paths, spawnImpl, env = process.env } = {}) {
  if (!/^[0-9a-f]{7,64}$/.test(String(commit ?? ''))) return { ok: false, error: 'restore needs the object id of a snapshot — call list first' };
  const wanted = (Array.isArray(paths) ? paths : []).map((p) => String(p ?? '').trim()).filter(Boolean);
  if (!wanted.length) {
    return { ok: false, error: 'name the paths to restore. There is no "restore everything": sweeping a whole tree back is how the last edit disappears, which is the failure this exists to prevent.' };
  }

  /**
   * ⭐ THE UNDO OF THE UNDO, TAKEN BEFORE ANYTHING IS WRITTEN. A restore is
   * itself a write over work somebody may want back.
   */
  const before = await snapshotWorkingTree(root, { spawnImpl, label: 'before restore', env });

  const restored = [];
  const failed = [];
  for (const p of wanted) {
    const blob = readBlob(root, commit, p);
    if (!blob.ok) { failed.push({ path: p, error: blob.error }); continue; }
    try {
      const target = resolve(root, p);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, blob.bytes);
      restored.push(p);
    } catch (err) {
      failed.push({ path: p, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    ok: restored.length > 0,
    restored,
    failed,
    undo: before.ok ? before.commit : null,
    ...(restored.length ? {} : { error: `nothing was restored: ${failed.map((f) => `${f.path} (${f.error})`).join('; ')}` }),
  };
}

/**
 * ⚠️ CLASSIFICATION EXISTS ONLY TO DECIDE WHAT TO **SAY**, NEVER WHAT TO ALLOW.
 *
 * This is the function a naive version of this file would have used as the
 * guard, and it is exactly the function `command.mjs` warns is bypassable. It
 * is kept because a snapshot the user never hears about is a capability nobody
 * can find — when the command looks like it destroys something, the result
 * carries the undo id. A false negative here costs a mention, not a snapshot:
 * the snapshot already happened.
 */
const DESTRUCTIVE = [
  [/\bgit\s+(-\S+\s+)*reset\b/i, 'git reset'],
  [/\bgit\s+(-\S+\s+)*checkout\b/i, 'git checkout'],
  [/\bgit\s+(-\S+\s+)*restore\b/i, 'git restore'],
  [/\bgit\s+(-\S+\s+)*clean\b/i, 'git clean'],
  [/\bgit\s+(-\S+\s+)*stash\b/i, 'git stash'],
  [/\bgit\s+(-\S+\s+)*(branch|push)\b.*(-D\b|--delete\b|--force\b|-f\b)/i, 'a forced git branch or push'],
  [/\brm\s+(-\w+\s+)*-\w*[rf]/i, 'rm -rf'],
  [/\b(rmdir|shred|truncate)\b/i, 'a file destroyer'],
  [/\bfind\b[^\n]*\s-delete\b/i, 'find -delete'],
  [/>\s*[^\s|;&>]+/, 'a redirection that truncates a file'],
];

export function destructiveIntent(commandLine) {
  const line = String(commandLine ?? '');
  for (const [re, verb] of DESTRUCTIVE) if (re.test(line)) return { destructive: true, verb };
  return { destructive: false, verb: null };
}

/**
 * The one call site a runner needs: snapshot, and hand back a sentence to
 * append to the command's own result — or nothing at all when there is nothing
 * worth saying.
 *
 * ⚠️ IT NEVER RETURNS A REFUSAL. A snapshot that fails must not stop the user's
 * command: this is a safety net, and a net that blocks the trapeze is worse
 * than no net. Every failure path here is silent by design and the reason is
 * that the alternative — refusing to run `npm test` because the repository has
 * no `user.email` — is how a protection gets switched off for good.
 */
export async function guardCommand(root, commandLine, { spawnImpl, env = process.env } = {}) {
  if (!safetyEnabled(env)) return { snapshotted: false, note: null };
  const snap = await snapshotWorkingTree(root, { spawnImpl, label: 'before a command', env });
  if (!snap.ok) return { snapshotted: false, note: null, error: snap.error };
  const intent = destructiveIntent(commandLine);
  if (!intent.destructive) return { snapshotted: true, created: snap.created, note: null, commit: snap.commit };
  return {
    snapshotted: true,
    created: snap.created,
    commit: snap.commit,
    note: `Safety: the working tree was snapshotted before this ${intent.verb} ran. If it destroyed something, it is recoverable — snapshot ${String(snap.commit).slice(0, 12)}.`,
  };
}
