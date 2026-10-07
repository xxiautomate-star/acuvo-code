/**
 * ── ⭐⭐⭐ THE FOURTH OPTION `parallel.mjs` DID NOT HAVE ─────────────────────
 *
 * `parallel.mjs` opens by naming the problem exactly right — *"Two agents in
 * ONE workspace will eventually write the same file. Whoever finishes second
 * wins, silently, and the first task reports success for work that no longer
 * exists"* — and then lists three options: merge them, lock per file, or let
 * them run and DETECT the overlap. It picks detect, and the reasoning against
 * the other two is sound.
 *
 * ⚠️ THERE WAS A FOURTH AND IT WAS NOT ON THE LIST: give each task its own
 * checkout. Detection is honest and it is still after-the-fact — it tells you
 * two agents collided, which is a better outcome than silence and a worse one
 * than the collision being impossible. `git worktree` makes it impossible, and
 * has since git 2.5.
 *
 * ⭐ AND IT IS NOT A HYPOTHETICAL FOR THIS REPO. Two entries in its own memory:
 * *"3 PARALLEL AGENTS IN ONE WORKTREE — they stage each other's files and read
 * a dirty baseline"* and *"`git checkout <file>` DESTROYED UNCOMMITTED WORK"*.
 * The first is what this file fixes; the second is what `git-safety.mjs` fixes.
 *
 * ── ⭐ WHY A WORKTREE AND NOT A COPY, WHICH IS THE OBVIOUS ALTERNATIVE ──────
 *
 * `cp -r` gives isolation too. It also gives: no shared object store (N copies
 * of every blob), no way to `git diff` one agent's work against the base
 * without inventing one, no branch, and nothing that knows the copy exists once
 * the process dies. A worktree shares `.git/objects` — so creating one costs a
 * checkout and no object copying at all — carries a real branch, and git itself
 * tracks it: `git worktree list` from the main checkout enumerates every agent
 * that is running, which is a fleet dashboard nobody had to build.
 *
 * ── ⚠️⚠️ THE PART THAT IS ACTUALLY HARD: CLEANING UP WITHOUT DESTROYING ─────
 *
 * "Cleaned up when unchanged" is the whole brief, and the failure mode is the
 * word "unchanged". `git worktree remove` deletes the directory. If the agent
 * left work in there, that is the exact `git checkout`-shaped disaster this
 * repo already has a memory about, only with a nicer name.
 *
 * ⭐ SO REMOVAL IS CONDITIONAL AND THE CONDITION IS MEASURED, NOT ASSUMED:
 * `git status --porcelain` inside the worktree, plus a comparison of its HEAD
 * against the commit it was created at. Clean AND unmoved → removed. Anything
 * else → KEPT, and the caller is told the paths, by name, so the human can go
 * and look. `force` exists for the operator and is never passed by any
 * automatic path in this package.
 *
 * ⚠️ AND EVEN `force` SNAPSHOTS FIRST. `git-safety.mjs` is imported here rather
 * than reimplemented, so a forced removal of a dirty worktree is recoverable
 * from the shared object store — which is the one place a worktree's work is
 * still reachable after its directory is gone.
 *
 * ── ⚠️ WHERE THEY LIVE, AND WHY NOT IN THE REPOSITORY ───────────────────────
 * Under `$ACUVO_HOME/worktrees/<repo>/<name>`, never inside the workspace. A
 * worktree checked out inside its own repository shows up as an untracked
 * directory in `git status` — which the agent then reads, believes is its own
 * mess, and tries to tidy. (`.gitignore` would fix the display and not the
 * `rm -rf`.)
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { spawnBounded } from './command.mjs';
import { gitEnvironment, validateBranchName } from './git.mjs';
import { snapshotWorkingTree } from './git-safety.mjs';

/**
 * ⚠️ ONE SPELLING PER DIRECTORY. Git prints the LONG Windows name
 * (`C:/Users/runneradmin/...`) while a home taken from `TEMP` is often the 8.3
 * alias (`RUNNER~1`), so a prefix test between the two said "not ours" about
 * every worktree we made — and cleanup removed nothing on the Windows CI
 * cells. `realpathSync.native` expands the alias; a path that does not exist
 * yet keeps its resolved spelling.
 */
function canonical(p) {
  const r = resolve(p);
  try { return realpathSync.native(r); } catch { return r; }
}

/** A checkout of a large repository is seconds, not minutes. */
export const WORKTREE_TIMEOUT_MS = 120_000;

/**
 * ⚠️ A CEILING, BECAUSE EACH ONE IS A FULL CHECKOUT ON DISK. The objects are
 * shared; the working files are not. Eight copies of a large repository is
 * already a surprising amount of somebody's disk, and an agent in a loop that
 * creates one per round would fill it without ever noticing.
 */
export const MAX_WORKTREES = 8;

/** The branch prefix. Never `friend/`, never a bare name — see CLAUDE.md §6. */
export const WORKTREE_BRANCH_PREFIX = 'acuvo/wt';

/** @typedef {(file: string, args: string[], opts: object) => any} SpawnImpl */

async function git(cwd, args, { spawnImpl, timeoutMs = WORKTREE_TIMEOUT_MS, env = process.env } = {}) {
  const r = await spawnBounded({
    file: 'git',
    args: ['--no-pager', ...args],
    cwd,
    timeoutMs,
    spawnImpl,
    env: gitEnvironment(env),
  });
  if (!r.ok) return { ok: false, error: r.error ?? 'git could not be started — is it installed and on PATH?' };
  if (r.timedOut) return { ok: false, error: `git ${args[0]} timed out after ${timeoutMs}ms` };
  return { ok: true, exitCode: r.exitCode, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

/** Where worktrees live. Under HOME, never under a workspace — see the header. */
export function worktreesHome(env = process.env, home = homedir()) {
  const override = String(env?.ACUVO_HOME ?? '').trim();
  return join(override || join(home, '.acuvo'), 'worktrees');
}

/**
 * ⚠️ THE DIRECTORY IS NAMED FOR THE REPOSITORY, NOT JUST THE TASK. Two projects
 * both called `api` would otherwise share a namespace and the second agent's
 * `create` would collide with the first's live worktree. The basename is kept
 * for a human reading `ls`, and a short digest of the absolute path makes it
 * unambiguous.
 */
export function repoKey(root) {
  const abs = resolve(root);
  let h = 5381;
  for (let i = 0; i < abs.length; i++) h = ((h * 33) ^ abs.charCodeAt(i)) >>> 0;
  const safe = basename(abs).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'repo';
  return `${safe}-${h.toString(36)}`;
}

/**
 * ⚠️ THE NAME IS VALIDATED AS A BRANCH NAME, NOT AS A FILENAME, and it is
 * `git.mjs`'s validator rather than a second one written here. It becomes both
 * — a branch and a directory — and branch names are the stricter of the two, so
 * one validator covers both and cannot drift from the one `git_branch` uses.
 */
export function validateWorktreeName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return { ok: false, error: 'a worktree needs a name — something short that says what the task is, e.g. "auth-fix"' };
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, error: `"${name}" contains a slash. A worktree name is one segment; it becomes a directory and a branch under ${WORKTREE_BRANCH_PREFIX}/.` };
  }
  const asBranch = validateBranchName(`${WORKTREE_BRANCH_PREFIX}/${name}`);
  if (!asBranch.ok) return asBranch;
  return { ok: true, name, branch: `${WORKTREE_BRANCH_PREFIX}/${name}` };
}

/** Is `git worktree` usable here at all? */
export async function worktreeSupported(root, { spawnImpl } = {}) {
  const r = await git(root, ['rev-parse', '--is-inside-work-tree'], { spawnImpl, timeoutMs: 20_000 });
  if (!r.ok) return { ok: false, error: r.error };
  if (r.exitCode !== 0 || r.stdout.trim() !== 'true') {
    return { ok: false, error: 'this workspace is not a git repository, so it has no worktrees. Isolation needs one — `git init` first.' };
  }
  return { ok: true };
}

/**
 * Every worktree of this repository, ours and the user's alike.
 *
 * ⚠️ `--porcelain` RATHER THAN THE HUMAN FORMAT, which is aligned columns a
 * path with a space in it silently breaks. The porcelain form is one
 * `key value` per line with a blank line between records, and it is stable
 * across versions — which the column format explicitly is not.
 */
export async function listWorktrees(root, { spawnImpl, env = process.env, home = homedir() } = {}) {
  const r = await git(root, ['worktree', 'list', '--porcelain'], { spawnImpl, timeoutMs: 20_000 });
  if (!r.ok) return r;
  if (r.exitCode !== 0) return { ok: false, error: 'could not list worktrees — this may not be a git repository' };

  const ours = worktreesHome(env, home);
  const out = [];
  let cur = null;
  for (const raw of r.stdout.split('\n')) {
    const line = raw.trim();
    if (!line) { if (cur) out.push(cur); cur = null; continue; }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') cur = { path: canonical(value), head: '', branch: '', detached: false, bare: false, acuvo: false };
    else if (!cur) continue;
    else if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
  }
  if (cur) out.push(cur);
  const oursCanon = canonical(ours).toLowerCase();
  for (const w of out) w.acuvo = w.path.toLowerCase().startsWith(oursCanon);
  return { ok: true, worktrees: out, mine: out.filter((w) => w.acuvo) };
}

/**
 * Create an isolated checkout.
 *
 * ⚠️ `--detach` IS NOT USED. A detached worktree's commits are reachable from
 * nothing once it is removed, which turns "clean up the empty ones" into a way
 * to lose work — the precise trap this file exists to avoid. A named branch
 * under `acuvo/wt/` means the commits survive the directory.
 *
 * @param {string} root
 * @param {{ name: string, base?: string, spawnImpl?: SpawnImpl, env?: NodeJS.ProcessEnv, home?: string }} opts
 */
export async function createWorktree(root, { name, base = 'HEAD', spawnImpl, env = process.env, home = homedir() } = {}) {
  const valid = validateWorktreeName(name);
  if (!valid.ok) return valid;

  const supported = await worktreeSupported(root, { spawnImpl });
  if (!supported.ok) return supported;

  const listed = await listWorktrees(root, { spawnImpl, env, home });
  if (!listed.ok) return listed;
  if (listed.mine.length >= MAX_WORKTREES) {
    return {
      ok: false,
      error: `there are already ${listed.mine.length} isolated worktrees for this repository (the ceiling is ${MAX_WORKTREES}); each is a full checkout on disk. Remove one first — the unchanged ones go automatically.`,
    };
  }

  const dir = join(worktreesHome(env, home), repoKey(root), valid.name);
  if (existsSync(dir)) {
    const already = listed.worktrees.find((w) => w.path.toLowerCase() === canonical(dir).toLowerCase());
    if (already) return { ok: true, created: false, path: resolve(dir), branch: already.branch || valid.branch, head: already.head };
    /**
     * ⚠️ A DIRECTORY GIT DOES NOT KNOW ABOUT IS NOT SWEPT AWAY. It is somebody
     * else's, or the remains of a crash that still holds work, and deleting it
     * to make room is the failure mode with the bad memory. `prune` is offered
     * as the deliberate act instead.
     */
    return { ok: false, error: `${dir} already exists but git does not list it as a worktree. Look at it, then remove it yourself — this will not delete a directory it cannot account for.` };
  }
  mkdirSync(join(worktreesHome(env, home), repoKey(root)), { recursive: true });

  /**
   * ⚠️ `-B` RATHER THAN `-b`: a leftover branch from a crashed run must not make
   * every later `create` with that name fail. It is safe here in a way it would
   * not be generally, because the namespace `acuvo/wt/` is ours alone and a
   * `validateBranchName` that admits nothing outside it is what makes that true.
   */
  const add = await git(root, ['worktree', 'add', '-B', valid.branch, dir, base], { spawnImpl, env });
  if (!add.ok) return add;
  if (add.exitCode !== 0) {
    const first = (add.stderr || add.stdout).trim().split('\n').filter(Boolean).pop() || 'git worktree add failed';
    return { ok: false, error: `could not create the worktree: ${first}` };
  }

  const head = await git(dir, ['rev-parse', 'HEAD'], { spawnImpl, timeoutMs: 20_000, env });
  return {
    ok: true,
    created: true,
    path: resolve(dir),
    branch: valid.branch,
    head: head.ok && head.exitCode === 0 ? head.stdout.trim() : '',
    base,
  };
}

/**
 * Has anything happened in this worktree? The question `remove` is built on, so
 * it answers with EVIDENCE — the paths — rather than a boolean somebody has to
 * trust.
 */
export async function worktreeStatus(path, { spawnImpl, baseHead = null, env = process.env } = {}) {
  if (!existsSync(path)) return { ok: false, error: `${path} is not there` };
  const st = await git(path, ['status', '--porcelain'], { spawnImpl, timeoutMs: 30_000, env });
  if (!st.ok) return st;
  if (st.exitCode !== 0) return { ok: false, error: `could not read the status of ${path}` };
  const changed = st.stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);

  const head = await git(path, ['rev-parse', 'HEAD'], { spawnImpl, timeoutMs: 20_000, env });
  const now = head.ok && head.exitCode === 0 ? head.stdout.trim() : '';
  /**
   * ⭐ TWO QUESTIONS, NOT ONE. A worktree whose agent COMMITTED its work has a
   * spotlessly clean `git status` and is the last thing anyone should delete.
   * Checking only the status is the version of this that throws away finished
   * work rather than unfinished work.
   */
  const moved = Boolean(baseHead) && Boolean(now) && now !== baseHead;
  return { ok: true, clean: changed.length === 0 && !moved, changed, head: now, moved };
}

/**
 * Remove one worktree — but only if nothing would be lost.
 *
 * @param {string} root
 * @param {{ name: string, force?: boolean, baseHead?: string|null, spawnImpl?: SpawnImpl, env?: NodeJS.ProcessEnv, home?: string }} opts
 */
export async function removeWorktree(root, { name, force = false, baseHead = null, spawnImpl, env = process.env, home = homedir() } = {}) {
  const valid = validateWorktreeName(name);
  if (!valid.ok) return valid;
  const dir = join(worktreesHome(env, home), repoKey(root), valid.name);

  if (!existsSync(dir)) {
    await git(root, ['worktree', 'prune'], { spawnImpl, timeoutMs: 20_000, env });
    return { ok: true, removed: false, reason: 'it was not there' };
  }

  const status = await worktreeStatus(dir, { spawnImpl, baseHead, env });
  if (!status.ok) return status;

  if (!status.clean && !force) {
    return {
      ok: false,
      kept: true,
      changed: status.changed,
      moved: status.moved,
      path: resolve(dir),
      branch: valid.branch,
      error: [
        `${valid.name} still holds work, so it was KEPT, not removed:`,
        status.changed.length ? `  ${status.changed.length} uncommitted file(s): ${status.changed.slice(0, 10).join(', ')}${status.changed.length > 10 ? ' …' : ''}` : '',
        status.moved ? `  and it has commits of its own on ${valid.branch}` : '',
        `  Look at ${resolve(dir)}, or merge ${valid.branch}. Automatic cleanup only removes what is unchanged.`,
      ].filter(Boolean).join('\n'),
    };
  }

  /**
   * ⭐ EVEN THE FORCED PATH IS RECOVERABLE. The snapshot goes into the SHARED
   * object database, which outlives the directory about to be deleted, so a
   * forced removal of a dirty worktree can still be read back out of it.
   */
  let undo = null;
  if (!status.clean && force) {
    const snap = await snapshotWorkingTree(dir, { spawnImpl, label: `before force-removing ${valid.name}`, env });
    if (snap.ok) undo = snap.commit;
  }

  const rm = await git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), dir], { spawnImpl, env });
  if (!rm.ok) return rm;
  if (rm.exitCode !== 0) {
    return { ok: false, error: `could not remove the worktree: ${(rm.stderr || rm.stdout).trim().split('\n').pop() || 'git worktree remove failed'}` };
  }
  await git(root, ['worktree', 'prune'], { spawnImpl, timeoutMs: 20_000, env });
  return { ok: true, removed: true, path: resolve(dir), branch: valid.branch, undo };
}

/**
 * The automatic half: remove every isolated worktree that is unchanged, and
 * report by name every one that was kept because it was not.
 *
 * ⚠️ IT NEVER FORCES. This is the path a `--parallel` run calls when it
 * finishes, and a cleanup that runs by itself must be incapable of deleting
 * work — otherwise the isolation feature becomes a second way to lose the thing
 * it was protecting.
 */
export async function cleanupWorktrees(root, { spawnImpl, env = process.env, home = homedir(), baseHeads = {} } = {}) {
  const listed = await listWorktrees(root, { spawnImpl, env, home });
  if (!listed.ok) return listed;

  const removed = [];
  const kept = [];
  for (const w of listed.mine) {
    const name = basename(w.path);
    const r = await removeWorktree(root, { name, baseHead: baseHeads[name] ?? null, spawnImpl, env, home });
    if (r.ok && r.removed) removed.push(name);
    else if (r.kept) kept.push({ name, path: w.path, branch: w.branch, changed: r.changed ?? [] });
  }
  await git(root, ['worktree', 'prune'], { spawnImpl, timeoutMs: 20_000, env });
  return { ok: true, removed, kept };
}

/** One line per worktree, for a human or for a tool result. */
export function formatWorktrees(worktrees) {
  if (!worktrees.length) return 'no isolated worktrees';
  return worktrees.map((w) => `  ${basename(w.path).padEnd(24)} ${(w.branch || '(detached)').padEnd(28)} ${w.path}`).join('\n');
}

/**
 * ── ⚠️ ONE SCHEMA, THREE ACTIONS — `gh.mjs`'S RULE, NOT A NEW ONE ───────────
 *
 * *"THREE SCHEMAS, NOT NINE — grouped by NOUN with an enumerated action… nine
 * schemas is roughly 900 tokens on EVERY round of every run."* The same
 * arithmetic applies here and harder, because `CLAUDE.md` records the per-round
 * fixed payload as *"nearly full"*. Three verbs sharing one parameter bag is
 * one schema.
 *
 * ⚠️ AND `force` IS DELIBERATELY NOT A PARAMETER. Forcing is how a cleanup
 * deletes work, and the model is the party whose mistakes this exists to
 * contain — an operator can force from a shell; the agent cannot, at all, by
 * construction rather than by refusal. That is this package's whole doctrine
 * applied to the one verb where getting it wrong is unrecoverable.
 */
export function worktreeToolSchemas() {
  return [{
    type: 'function',
    function: {
      name: 'git_worktree',
      description: [
        'Work in an ISOLATED copy of this repository, so parallel work cannot overwrite itself.',
        'create returns a path — do the task\'s file work THERE, not in the original.',
        'Use it before delegating, before trying two approaches at once, or whenever another agent may be editing the same files.',
        'remove REFUSES while a worktree still holds uncommitted changes or commits of its own, so cleanup can never lose work; the unchanged ones go automatically.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'remove'], description: 'create, list or remove.' },
          name: { type: 'string', description: 'create/remove — one short segment naming the task, e.g. "auth-fix". No slashes.' },
        },
        required: ['action'],
      },
    },
  }];
}

/**
 * ⚠️ GATED ON `allowRun`, FOR `git_branch`'S REASON: it executes git and creates
 * a branch. And multi-round only — a worktree whose path nothing can be done
 * with is the dead button `tools.mjs` refuses to ship.
 */
export function worktreeToolNames({ allowRun = true, maxRounds = 2 } = {}) {
  return allowRun && maxRounds > 1 ? ['git_worktree'] : [];
}

/** The dispatcher. Kept here so `tools.mjs` gains one case, not thirty lines. */
export async function executeWorktree(root, args, { spawnImpl, env = process.env, home = homedir() } = {}) {
  const action = String(args?.action ?? '').trim().toLowerCase();

  /**
   * ⚠️ THE ACTION IS RE-VALIDATED HERE AND NOT TRUSTED FROM THE ENUM, exactly as
   * `gh.mjs:planGh` argues: *"a provider that echoes a stale tool list, or a
   * resumed session, can put any string in `action`"*. The enum is an offer,
   * never a boundary.
   */
  if (action === 'list') {
    const listed = await listWorktrees(root, { spawnImpl, env, home });
    if (!listed.ok) return listed;
    return { ok: true, worktrees: listed.mine, summary: formatWorktrees(listed.mine) };
  }
  if (action === 'create') {
    const made = await createWorktree(root, { name: args?.name, spawnImpl, env, home });
    if (!made.ok) return made;
    return {
      ok: true,
      path: made.path,
      branch: made.branch,
      summary: `isolated worktree ready at ${made.path} on ${made.branch}. Do this task's file work there — read and write with that path as the root. Nothing you do there can touch the original checkout.`,
    };
  }
  if (action === 'remove') {
    const gone = await removeWorktree(root, { name: args?.name, spawnImpl, env, home });
    if (!gone.ok) return gone;
    return { ok: true, removed: gone.removed, summary: gone.removed ? `removed ${args?.name} (it was unchanged)` : `${args?.name} was not there` };
  }
  return { ok: false, error: `git_worktree has no action "${action}" — it is create, list or remove.` };
}
