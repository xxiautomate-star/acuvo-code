/**
 * ── ⭐ GIT — THE AGENT CAN FINALLY SEE WHAT IT CHANGED ───────────────────────
 *
 * Until now the CLI wrote files and had no idea what it had done to the repo.
 * That gap is bigger than it sounds, because it removes the one check a human
 * developer performs constantly and for free: `git diff` before committing.
 * Without it the model's only model of the working tree is its own memory of
 * the files it wrote this session — which is wrong the moment anything existed
 * before the session started.
 *
 * ── ⚠️ WHY GIT IS NOT A `run_command` BINARY ────────────────────────────────
 * The obvious implementation is to add `git` to `ALLOWED_BINARIES`. It is the
 * wrong one, twice over, and both reasons are structural rather than fussy:
 *
 *   1. **The character whitelist would make commit impossible.** `command.mjs`
 *      refuses quotes, so a commit message could never contain an apostrophe, a
 *      comma, a newline or a colon — i.e. could never be a commit message. The
 *      only way to allow one through a command STRING is to weaken the
 *      whitelist that protects every other command, for the sake of one verb.
 *   2. **Git's surface is enormous and mostly destructive.** `reset --hard`,
 *      `checkout .`, `clean -fdx`, `push --force`, `filter-branch` — an agent
 *      with a git command string is one hallucination away from deleting work
 *      that was never its own. A flag denylist for a program with a thousand
 *      flags is a promise nobody can keep.
 *
 * ⭐ So git is exposed as STRUCTURED VERBS. The model supplies parameters, this
 * file builds the exact `argv`, and there is no path from a model-authored
 * string to a git subcommand it was not given. `push`, `reset`, `checkout`,
 * `clean`, `rebase` and `remote` are not refused by a check — they are simply
 * not expressible. That is the whitelist doctrine the rest of the package uses,
 * applied where it matters most.
 *
 * ── ⚠️ THE SUBDIRECTORY TRAP, WHICH IS THE REAL BUG IN HERE ─────────────────
 * `git` walks UP from its cwd to find a repository. Point this CLI at
 * `~/work/monorepo/packages/thing` and every command silently operates on the
 * whole monorepo: `git status` reports other people's work in progress, and a
 * commit lands in a repository the user never pointed us at. Nothing errors.
 *
 * So every verb first resolves `--show-toplevel` and REFUSES unless it equals
 * the workspace root. A workspace inside someone else's repo is a legitimate
 * place to write code and never a legitimate place to commit from.
 *
 * ── ⚠️⚠️ AND THE SECOND ESCAPE, WHICH THAT ONE DOES NOT CATCH (fixed 08-11) ──
 * Proving the REPO is the workspace says nothing about whether a PATH inside it
 * really is. `gitCommit` validated its paths with `normalizeRelativePath` — the
 * pure, LEXICAL half of the workspace guard, which by design never touches the
 * disk and therefore cannot see a link. Measured in a scratch repo: a directory
 * junction (`mklink /J`, no elevation) pointing out of the workspace let
 * `paths: ['link/secret.txt']` commit an outside file, `ok: true`, and
 * `git show HEAD:link/secret.txt` printed its contents.
 *
 * ⭐ So the containment every file verb enforces — `resolveInWorkspace`, i.e.
 * realpath the deepest EXISTING ancestor and compare against the realpath'd root
 * — is now applied in `gitCommit` too, and by the same means rather than a
 * second invention. The full argument, including why it is not too tight, sits
 * at the check itself; the bidirectional proof is
 * `test/git-commit-containment.test.mjs`.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { clampOutput, scrubEnvironment, spawnBounded } from './command.mjs';
import { normalizeRelativePath, resolveInWorkspace } from './workspace.mjs';

/**
 * ⚠️ THE SHAPES ARE DECLARED, NOT INFERRED — the same rule `workspace.mjs` and
 * `command.mjs` follow, and for the same reason. Left to inference, `ok` widens
 * to `boolean` instead of the literals, so a caller that has ALREADY checked
 * `if (!r.ok)` still cannot reach `r.error` without a cast. A discriminated
 * union is what makes the refusal path type-safe at every call site.
 *
 * @typedef {{ ok: false, error: string }} GitRefused
 * @typedef {{ ok: true, exitCode: number | null, stdout: string, stderr: string, timedOut: boolean }} GitRan
 * @typedef {(file: string, args: string[], opts: object) => any} SpawnImpl
 * @typedef {{ spawnImpl?: SpawnImpl }} GitOpts
 */

/** Git is fast or wedged; there is no slow-but-fine case worth waiting on. */
export const GIT_TIMEOUT_MS = 20_000;
/** A diff is the output most likely to be enormous, and the model pays per token. */
export const MAX_DIFF_CHARS = 12_000;
export const MAX_COMMIT_MESSAGE_CHARS = 4_000;
export const MAX_COMMIT_PATHS = 50;
/** More than this and the answer is "read the log yourself". */
export const MAX_LOG_COUNT = 50;

/**
 * ⚠️ NEVER STAGED, WHATEVER THE MODEL ASKS OR `.gitignore` SAYS.
 *
 * The failure this prevents: the agent writes a `.env` so the app it just built
 * can run, then helpfully commits "all the project files". The secret is now in
 * history — a place from which deleting it does not remove it — and the repo may
 * be pushed by a human later who has no idea it is in there.
 *
 * Git already refuses ignored files without `-f` (which is never passed), so
 * this only fires when the file is NOT ignored, which is exactly the dangerous
 * case: the repository has no protection and nobody noticed.
 */
/**
 * ⚠️⚠️ THIS IS THE ONE LIST. `read-window.mjs` used to keep a second one
 * (`CREDENTIAL_BASENAME`) for `read_lines` and `read_around`, written
 * separately, and the two DISAGREED. Measured 2026-08-13 through the real
 * dispatcher:
 *
 *   read_lines LEAKED : vault.pfx · keys.jks · secrets.json · credentials.yml
 *                       · service-account.json
 *   read_file  LEAKED : .git-credentials
 *
 * Each list covered holes the other left, so which of a user's secrets were
 * protected depended on which verb the model happened to pick. Both consumers
 * now call `refusedCommitPath`, and `.git-credentials` — which only the other
 * list had — is folded in below. Add the next pattern HERE and every consumer
 * gains it at once.
 */
const NEVER_COMMIT = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|pfx|p12|key|keystore|jks)$/i,
  /(^|\/)(credentials|secrets?|service-account)\.(json|ya?ml)$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.aws\//i,
  // ⭐ Contributed by the list this one absorbed. Git stores plaintext
  // usernames and passwords here, which is precisely the file it is named for.
  /(^|\/)\.git-credentials$/i,
];

export function refusedCommitPath(path) {
  const hit = NEVER_COMMIT.find((rx) => rx.test(path));
  return hit ? `${path} looks like a credential file — this agent never commits one, because history keeps it after you delete it` : null;
}

/**
 * ⚠️ THE GIT ENVIRONMENT, AND WHY IT IS MORE LOCKED DOWN THAN THE COMMAND ONE.
 *
 * `scrubEnvironment` already removes conventionally-named secrets. On top of
 * that:
 *
 * · `GIT_TERMINAL_PROMPT=0` — git asking for a username on a machine with no
 *   terminal attached is a process that hangs until the timeout kills it. Every
 *   credential prompt becomes an immediate, legible error instead.
 * · `GIT_PAGER=cat` + `--no-pager` — a pager waits for a keypress that will
 *   never come. Same hang, different cause, so both are closed.
 * · `GIT_OPTIONAL_LOCKS=0` — a plain `status` should not take the index lock
 *   and fight the editor the user has open in the same repo.
 *
 * ⭐ And a property worth stating rather than discovering: because the scrub
 * removes tokens and this file never offers a network verb, git here has no
 * credentials AND nowhere to send them. Fetch and push are not merely absent
 * from the verb list, they would fail if they were reachable.
 */
export function gitEnvironment(env = process.env) {
  const out = scrubEnvironment(env);
  out.GIT_TERMINAL_PROMPT = '0';
  out.GIT_PAGER = 'cat';
  out.GIT_OPTIONAL_LOCKS = '0';
  return out;
}

/**
 * Run git with an argv this file constructed. `args` never contains anything
 * derived from a model string except as a SEPARATE ARRAY ELEMENT, which is
 * where the safety comes from: an element is one argument no matter what is in
 * it, because no shell exists to re-split it.
 */
/** @returns {Promise<GitRefused | GitRan>} */
async function git(root, args, { spawnImpl, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const run = await spawnBounded({
    file: 'git',
    args: ['--no-pager', ...args],
    cwd: root,
    timeoutMs,
    spawnImpl,
    env: gitEnvironment(),
  });
  if (!run.ok) {
    /**
     * ⚠️ ENOENT HERE MEANS GIT IS NOT INSTALLED, and the raw spawn error says
     * "spawn git ENOENT", which reads like a bug in this CLI rather than a
     * missing program. Translate it once, here.
     */
    const missing = /ENOENT/.test(run.error ?? '');
    return { ok: false, error: missing ? 'git is not installed, or not on PATH for this process' : run.error };
  }
  return {
    ok: true,
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    timedOut: run.timedOut,
  };
}

/**
 * Resolve the repository and prove it is THIS workspace — see the subdirectory
 * trap in the header. Every verb goes through here first.
 */
/**
 * @param {string} root
 * @param {GitOpts} [opts]
 * @returns {Promise<GitRefused | { ok: true, root: string }>}
 */
export async function resolveRepo(root, { spawnImpl } = {}) {
  const top = await git(root, ['rev-parse', '--show-toplevel'], { spawnImpl });
  if (!top.ok) return top;
  if (top.exitCode !== 0) {
    return { ok: false, error: 'this workspace is not a git repository, so there is nothing to inspect or commit' };
  }
  const reported = top.stdout.trim();
  if (!reported) return { ok: false, error: 'git did not report a repository root' };

  /**
   * ⚠️ COMPARED THROUGH `realpath`, NOT AS STRINGS. Git prints forward slashes
   * on Windows and resolves symlinks; the workspace root may be `C:\...` and a
   * symlinked path besides. A string compare would report a MISMATCH for the
   * ordinary case and refuse to work at all — the failure mode of a safety
   * check that is too literal is that it gets deleted.
   */
  let a; let b;
  try {
    a = realpathSync(resolve(reported));
    b = realpathSync(resolve(root));
  } catch (err) {
    return { ok: false, error: `could not resolve the repository path: ${err instanceof Error ? err.message : String(err)}` };
  }
  const same = process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same) {
    return {
      ok: false,
      error:
        `this workspace is INSIDE a git repository rooted at ${reported}, not at the workspace root. ` +
        'Git commands are refused here: they would report and commit changes from the whole outer ' +
        'repository, which nobody pointed this agent at.',
    };
  }
  return { ok: true, root: b };
}

/** Parse `status --porcelain=v1` into something a model can reason about. */
export function parseStatus(porcelain) {
  const files = [];
  for (const raw of String(porcelain).split('\n')) {
    if (raw.length < 4) continue;
    const x = raw[0];
    const y = raw[1];
    let path = raw.slice(3);
    // A rename is printed as `old -> new`; the new name is the useful one.
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    files.push({
      path: path.replace(/^"|"$/g, ''),
      staged: x !== ' ' && x !== '?',
      // `??` is untracked — new work, which is the common case for this agent
      // and the one a model most often forgets it has to `add`.
      untracked: x === '?' && y === '?',
      code: `${x}${y}`,
    });
  }
  return files;
}

/**
 * @param {string} root
 * @param {GitOpts} [opts]
 * @returns {Promise<GitRefused | { ok: true, branch: string, files: {path:string,staged:boolean,untracked:boolean,code:string}[], clean: boolean }>}
 */
export async function gitStatus(root, { spawnImpl } = {}) {
  const repo = await resolveRepo(root, { spawnImpl });
  if (!repo.ok) return repo;

  const [status, branch] = await Promise.all([
    git(root, ['status', '--porcelain=v1'], { spawnImpl }),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { spawnImpl }),
  ]);
  if (!status.ok) return status;
  if (status.exitCode !== 0) return { ok: false, error: status.stderr.trim() || 'git status failed' };

  const files = parseStatus(status.stdout);
  return {
    ok: true,
    // ⚠️ A repository with no commits reports a branch name but `rev-parse`
    // fails; an empty string here is honest and the caller renders "(no
    // commits yet)" rather than printing an error for a normal new repo.
    branch: branch.ok && branch.exitCode === 0 ? branch.stdout.trim() : '',
    files,
    clean: files.length === 0,
  };
}

/**
 * @param {string} root
 * @param {{ path?: string | null, staged?: boolean } & GitOpts} [opts]
 * @returns {Promise<GitRefused | { ok: true, staged: boolean, path: string | null, diff: string, truncated: boolean, empty: boolean }>}
 */
export async function gitDiff(root, { path = null, staged = false, spawnImpl } = {}) {
  const repo = await resolveRepo(root, { spawnImpl });
  if (!repo.ok) return repo;

  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  // ⚠️ "." IS HOW A MODEL SAYS "EVERYTHING", and normalizeRelativePath refuses
  // it ("resolves to the workspace root itself") — correctly, for a file tool.
  // Here it means the default, so it is translated rather than rejected with a
  // message the model would try to work around.
  if (path !== null && path !== undefined && path !== '' && path !== '.' && path !== './') {
    const norm = normalizeRelativePath(path);
    if (!norm.ok) return { ok: false, error: `"${path}" is not a usable path: ${norm.reason}` };
    // ⚠️ `--` FIRST. Without it a path that begins with a dash, or that happens
    // to equal a branch name, is parsed as a revision — and `git diff main`
    // means something entirely different from `git diff -- main`.
    args.push('--', norm.path);
  }
  const run = await git(root, args, { spawnImpl });
  if (!run.ok) return run;
  if (run.exitCode !== 0) return { ok: false, error: run.stderr.trim() || 'git diff failed' };

  const clamped = clampOutput(run.stdout, MAX_DIFF_CHARS);
  return {
    ok: true,
    staged,
    path: path ?? null,
    diff: clamped.text,
    truncated: clamped.truncated,
    // ⚠️ An empty diff is a RESULT, not a failure — and specifically it is the
    // answer to "did my edit apply?", so it must be reported as a fact rather
    // than as an absence the model has to infer from a blank string.
    empty: run.stdout.trim() === '',
  };
}

/**
 * @param {string} root
 * @param {{ count?: number, path?: string | null } & GitOpts} [opts]
 * @returns {Promise<GitRefused | { ok: true, commits: {hash:string,author:string,when:string,subject:string}[], empty: boolean }>}
 */
export async function gitLog(root, { count = 10, path = null, spawnImpl } = {}) {
  const repo = await resolveRepo(root, { spawnImpl });
  if (!repo.ok) return repo;

  const n = Math.min(Math.max(1, Number.isFinite(count) ? Math.floor(count) : 10), MAX_LOG_COUNT);
  // Unit-separator delimited rather than a pretty format with spaces: a subject
  // line contains anything, including whatever character seemed safe to split on.
  const args = ['log', `-n${n}`, '--no-color', '--pretty=format:%h\u001f%an\u001f%ar\u001f%s'];
  if (path) {
    const norm = normalizeRelativePath(path);
    if (!norm.ok) return { ok: false, error: `"${path}" is not a usable path: ${norm.reason}` };
    args.push('--', norm.path);
  }
  const run = await git(root, args, { spawnImpl });
  if (!run.ok) return run;
  if (run.exitCode !== 0) {
    const err = run.stderr.trim();
    // A brand-new repo has no HEAD; that is not an error worth alarming about.
    if (/does not have any commits yet|unknown revision/i.test(err)) return { ok: true, commits: [], empty: true };
    return { ok: false, error: err || 'git log failed' };
  }
  const commits = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, author, when, ...subject] = line.split('\u001f');
      return { hash, author, when, subject: subject.join('\u001f') };
    });
  return { ok: true, commits, empty: commits.length === 0 };
}

/**
 * Validate a model-authored commit message.
 *
 * Pure, and stricter than git is: git accepts almost anything, but a message
 * that starts with `-` becomes a flag at some future call site, and control
 * characters make a log unreadable in ways nobody debugs.
 */
/**
 * @param {unknown} raw
 * @returns {{ ok: true, message: string } | GitRefused}
 */
export function validateCommitMessage(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'a commit message is required' };
  const message = raw.trim();
  if (!message) return { ok: false, error: 'the commit message is empty — say what changed and why' };
  if (message.length > MAX_COMMIT_MESSAGE_CHARS) {
    return { ok: false, error: `the commit message is ${message.length} characters, over the ${MAX_COMMIT_MESSAGE_CHARS} limit` };
  }
  if (message.startsWith('-')) {
    return { ok: false, error: 'a commit message may not start with "-" — it would be read as a flag' };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message)) {
    return { ok: false, error: 'the commit message contains control characters (newlines and tabs are fine, nothing else)' };
  }
  return { ok: true, message };
}

/**
 * Stage the named paths and commit them.
 *
 * ── ⚠️ WHY `paths` IS REQUIRED AND THERE IS NO "COMMIT EVERYTHING" ──────────
 * `git add -A` is one keystroke for a human who can see the file list, and a
 * loaded gun for an agent that cannot. It sweeps up the scratch file, the
 * accidental 40MB fixture, the other lane's half-finished work in the same
 * checkout, and the `.env` written two tool calls ago. Requiring the paths
 * forces the model to have looked — which is the behaviour we want anyway, and
 * `git_status` is right there.
 */
/**
 * @param {string} root
 * @param {{ message?: unknown, paths?: unknown, dryRun?: boolean } & GitOpts} [opts]
 * @returns {Promise<GitRefused | { ok: true, hash: string, message: string, files: string[], fileCount: number }>}
 */
export async function gitCommit(root, { message, paths, spawnImpl, dryRun = false } = {}) {
  const repo = await resolveRepo(root, { spawnImpl });
  if (!repo.ok) return repo;

  const valid = validateCommitMessage(message);
  if (!valid.ok) return valid;

  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: 'paths is required — name the files to commit. Call git_status first; there is no "commit everything".' };
  }
  if (paths.length > MAX_COMMIT_PATHS) {
    return { ok: false, error: `${paths.length} paths is over the ${MAX_COMMIT_PATHS} limit for one commit` };
  }

  const clean = [];
  for (const p of paths) {
    const norm = normalizeRelativePath(p);
    if (!norm.ok) return { ok: false, error: `"${p}" is not a usable path: ${norm.reason}` };
    const refused = refusedCommitPath(norm.path);
    if (refused) return { ok: false, error: refused };
    /**
     * ── ⚠️⚠️ THE CONTAINMENT CHECK, AND WHY IT CANNOT BE THE LEXICAL ONE ─────
     *
     * `normalizeRelativePath` above is PURE — it never touches the disk, so it
     * refuses `../x` and `C:\x` and cannot possibly see that `link/` is a
     * junction to somewhere else. For months that was the only guard on the one
     * verb in this package that writes PERMANENT HISTORY, while `write_file`,
     * `read_file` and `delete_file` all went through `resolveInWorkspace`.
     *
     * ⭐ Measured on 2026-08-11, `mklink /J` needing no elevation:
     *     repo/link -> ../outside ; gitCommit(paths:['link/secret.txt'])
     *     -> ok:true, and `git show HEAD:link/secret.txt` printed the outside
     *     file. Deleting it afterwards does not remove it from history.
     *
     * ⚠️ ON POSIX `git add` REFUSES "beyond a symbolic link" ITSELF, which is
     * exactly why this went unnoticed: git covered for the missing guard on the
     * platform nobody here runs on. A Windows directory junction is not a
     * symlink to git — it walks through it as an ordinary directory.
     *
     * So the answer is the SAME mechanism the file tools use, not a second
     * invention: realpath the deepest EXISTING ancestor and compare against the
     * realpath'd root. That is also what keeps it from being too tight —
     * · the root is realpath'd too, so a repo under a junctioned/symlinked home
     *   directory is normal rather than an escape;
     * · a path that does not exist is contained by its parent, so staging a
     *   DELETION (the file is gone — that IS the commit) still works;
     * · `isInside` folds case, so a drive letter in the other case is not a
     *   mismatch;
     * · a link pointing back INSIDE the workspace resolves inside and is allowed.
     *
     * ⚠️ Intent is 'read', deliberately. 'write' would additionally refuse
     * `node_modules/`, `.next/` and `.vercel/` with "it executes code on the
     * owner's next command" — true of writing a file there and NOT true of
     * recording one in history, and a repository that deliberately vendors its
     * dependencies is somebody's real, legitimate commit. This check is about
     * containment and nothing else.
     *
     * ⚠️ And it runs in the validation loop, BEFORE `git add`. Refusing after
     * staging would leave the good paths of a mixed commit sitting in the index
     * for the next commit to sweep up silently.
     */
    const contained = resolveInWorkspace(repo.root, norm.path, 'read');
    if (!contained.ok) {
      return {
        ok: false,
        error:
          `"${p}" cannot be committed: ${contained.reason}. It resolves outside the workspace `
          + `(${repo.root}) once links are followed, and committing it would put a file nobody `
          + 'pointed this agent at into permanent history. Commit only paths that live inside the workspace.',
      };
    }
    clean.push(norm.path);
  }

  if (dryRun) {
    return { ok: false, error: 'this is a --dry-run, so nothing is staged or committed' };
  }

  // `--` again: a path called `main` must not be read as a revision.
  const add = await git(root, ['add', '--', ...clean], { spawnImpl });
  if (!add.ok) return add;
  if (add.exitCode !== 0) {
    const err = add.stderr.trim();
    /**
     * ⚠️ THE IGNORED-FILE REFUSAL IS A FEATURE AND MUST READ LIKE ONE. Git's own
     * message suggests `-f`, which this agent will never pass; left unrewritten
     * the model reads the hint, tries to obey it, and burns a round discovering
     * the flag does not exist here.
     */
    if (/ignored by one of your \.gitignore|is ignored/i.test(err)) {
      return { ok: false, error: `${err}\n\nThat file is gitignored and this agent never force-adds — leave it out of the commit.` };
    }
    return { ok: false, error: err || 'git add failed' };
  }

  const staged = await git(root, ['diff', '--cached', '--name-only'], { spawnImpl });
  const stagedFiles = staged.ok ? staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  if (stagedFiles.length === 0) {
    /**
     * ⚠️ CAUGHT BEFORE COMMITTING, because `git commit` with nothing staged
     * exits non-zero with a wall of advice, and the model reads a failed commit
     * as "something broke" when the truth is "those files are already
     * committed, unchanged" — a completely different next action.
     */
    return { ok: false, error: 'nothing to commit: those paths have no changes staged (they may already be committed, or identical to HEAD)' };
  }

  const commit = await git(root, ['commit', '-m', valid.message], { spawnImpl });
  if (!commit.ok) return commit;
  if (commit.exitCode !== 0) {
    const err = `${commit.stdout}\n${commit.stderr}`.trim();
    if (/Please tell me who you are|unable to auto-detect email|empty ident name/i.test(err)) {
      return {
        ok: false,
        error: 'git has no author identity configured on this machine, so it cannot record a commit. Set user.name and user.email in your git config and ask again.',
      };
    }
    return { ok: false, error: err || 'git commit failed' };
  }

  const head = await git(root, ['rev-parse', '--short', 'HEAD'], { spawnImpl });
  return {
    ok: true,
    hash: head.ok && head.exitCode === 0 ? head.stdout.trim() : '',
    message: valid.message,
    files: stagedFiles,
    // ⭐ Reported because it is the number a human checks first, and because it
    // differs from `paths.length` whenever a named path was already clean.
    fileCount: stagedFiles.length,
  };
}

/** Render for the model — compact, and leading with the fact that drives the next move. */
export function formatStatusForModel(result) {
  if (!result.ok) return `git status: ${result.error}`;
  if (result.clean) return `branch ${result.branch || '(no commits yet)'} — working tree clean, nothing to commit`;
  const lines = [`branch ${result.branch || '(no commits yet)'} — ${result.files.length} changed:`];
  for (const f of result.files.slice(0, 60)) {
    const tag = f.untracked ? 'untracked' : f.staged ? 'staged' : 'modified';
    lines.push(`  ${tag.padEnd(9)} ${f.path}`);
  }
  if (result.files.length > 60) lines.push(`  … and ${result.files.length - 60} more`);
  return lines.join('\n');
}

export function gitToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'git_status',
        description: [
          'List what has changed in the workspace repository: branch, and every modified, staged or',
          'untracked file. Call this BEFORE git_commit — commit requires you to name the files, and',
          'this is how you know what they are.',
        ].join(' '),
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_diff',
        description: [
          'Show the actual line-by-line changes in the working tree. This is how you CHECK your own',
          'edit did what you meant before committing it, and how you see changes that existed before',
          'this session. Optionally limit to one path, or pass staged=true for what is already staged.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional workspace-relative file or directory.' },
            staged: { type: 'boolean', description: 'true to diff what is staged rather than the working tree.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_log',
        description: [
          'Recent commits: hash, author, relative date and subject. Use it to learn a repository\'s',
          'commit-message conventions before writing one, or to see what recently changed in a file.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            count: { type: 'number', description: `How many commits, 1–${MAX_LOG_COUNT} (default 10).` },
            path: { type: 'string', description: 'Optional path — only commits touching it.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_commit',
        description: [
          'Stage the named files and commit them. You MUST list the paths — there is no "commit',
          'everything", because sweeping up files you have not looked at is how scratch files and',
          'secrets get committed. Call git_status and git_diff first, then commit deliberately.',
          'Match the repository\'s existing message style (git_log shows it).',
          'This agent cannot push, reset, checkout, merge or rebase — commit is the only write verb.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The commit message. Multi-line is fine.' },
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Workspace-relative paths to stage and commit. Required, and non-empty.',
            },
          },
          required: ['message', 'paths'],
        },
      },
    },
  ];
}
