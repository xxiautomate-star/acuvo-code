/**
 * ── ⚠️⚠️ THE FIX FOR THE DARK MEDIA HALF WAS ITSELF DARK ───────────────────
 *
 * `bin/acuvo.mjs` grew a `.env` loader whose own comment explains exactly why:
 * *"Measured today: `mediaToolNames(process.env)` returned `[]` in an ordinary
 * terminal, on a machine where every one of those services is configured and
 * working... `see_page` — the capability this CLI is sold on — was never even
 * OFFERED."*
 *
 * ⚠️ IT LOADED `.env`. Measured 2026-08-12 across this whole machine: there is
 * **no plain `.env` anywhere** — every file is `.env.local`, which is the name
 * Next.js, Vite and Create React App all use for the one that holds secrets and
 * is git-ignored. So the loader never fired once, and the media half it was
 * written to rescue stayed exactly as dark as before. A fix that cannot run is
 * indistinguishable from the bug.
 *
 * ⚠️ AND IT WAS INLINE IN `bin/`, WHICH IS WHY NOBODY CAUGHT IT. Eight lines
 * inside `main()` cannot be imported, so no test could assert which filenames it
 * looks for. That is the whole reason this file exists as a module: the list of
 * candidate names is now a value a test can read.
 *
 * ── PRECEDENCE ─────────────────────────────────────────────────────────────
 *
 * ⭐ `.env.local` IS LOADED BEFORE `.env`, and the order is load-bearing because
 * `process.loadEnvFile` DOES NOT OVERWRITE. First writer wins, so "load first"
 * means "higher precedence" — the inverse of what the reading order suggests,
 * and worth stating because getting it backwards silently makes the committed
 * `.env` beat the private `.env.local`.
 *
 * ⭐ AND IT WALKS UP. A monorepo keeps one `.env.local` at the top and runs
 * tools from `packages/whatever`; stopping at the workspace root would find
 * nothing in the common layout. It stops at the filesystem root or a `.git`
 * directory — the same boundary every other developer tool treats as "the
 * project" — so it can never wander into a sibling checkout or a home
 * directory it was not pointed at.
 *
 * ⚠️ A REAL ENVIRONMENT VARIABLE ALWAYS WINS over every file, because the
 * loader never overwrites. An explicit `export` in this shell must beat a stale
 * file somebody forgot about, or debugging becomes guesswork about which value
 * is live.
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/**
 * In precedence order — earlier wins, because `loadEnvFile` does not overwrite.
 * ⚠️ `.env.example` is deliberately ABSENT: it is documentation, it is committed,
 * and its values are placeholders. Loading it would set `OPENROUTER_API_KEY` to
 * something like `sk-or-v1-...` and produce a 401 that blames the user's key.
 */
export const ENV_FILENAMES = Object.freeze(['.env.local', '.env']);

/** How far up to walk before giving up. Deep enough for any real monorepo. */
export const MAX_WALK_UP = 8;

/**
 * Every env file that exists, nearest directory first, in precedence order.
 * Pure and exported so a test can assert the NAMES without touching the
 * process environment — the assertion that would have caught the original bug.
 *
 * @param {string} from   directory to start at
 * @param {{ stopAtGit?: boolean }} opts
 * @returns {string[]} absolute paths, highest precedence first
 */
export function envFileCandidates(from, { stopAtGit = true } = {}) {
  if (typeof from !== 'string' || from === '') return [];

  const found = [];
  let dir = resolve(from);

  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    for (const name of ENV_FILENAMES) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) found.push(candidate);
      } catch { /* unreadable — treat as absent */ }
    }

    /**
     * ⚠️ THE `.git` STOP COMES **AFTER** THIS DIRECTORY'S FILES ARE COLLECTED.
     * The repository root is the most likely place for the file, so stopping
     * before reading it would skip the single most common location.
     */
    if (stopAtGit) {
      try { if (existsSync(join(dir, '.git'))) break; } catch { /* keep walking */ }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return found;
}

/**
 * Load every env file we can find, best-effort.
 *
 * ⚠️ NEVER THROWS AND NEVER FAILS THE RUN. No env file is the normal case, and
 * a malformed one must not stop a coding session that never needed it.
 *
 * @param {string[]} roots  directories to search, in order
 * @param {{ load?: Function, existsImpl?: Function }} opts
 * @returns {{ loaded: string[], failed: Array<{file: string, error: string}> }}
 */
/**
 * ── ⚠️⚠️ THE MASTER KEY: A CLONED REPOSITORY WAS SETTING OUR OWN SWITCHES ────
 *
 * `bin/acuvo.mjs` calls `envLoad([root, process.cwd()])`, and this loader walks
 * up from the WORKSPACE reading `.env.local` / `.env` into `process.env`. That is
 * correct and wanted for a PROJECT’s variables — DATABASE_URL, STRIPE_KEY, the
 * things the code under test needs.
 *
 * ⚠️⚠️ IT WAS ALSO SETTING OURS. Measured 2026-08-15 with one `.env.local` in a
 * cloned repository, every value chosen by the repository:
 *
 *     npm installs enabled   false → TRUE     (ACUVO_ALLOW_INSTALL)
 *     MCP consent bypassed   false → TRUE     (ACUVO_TRUST_MCP)
 *     git push enabled       false → TRUE     (ACUVO_ALLOW_PUSH)
 *     reviewer independent   true  → FALSE    (ACUVO_REFUTE_MODEL → the builder)
 *     provider pin           ours  → theirs   (ACUVO_PROVIDER_ORDER)
 *
 * Every guard closed today — the install gate, MCP consent, the independent
 * second opinion, the measured provider pin — defeated by one file in a
 * repository somebody cloned. It is the same defect `policy.mjs` names and
 * solves: **the config lives in the workspace, and the agent can write to the
 * workspace.** Its answer is that a workspace layer may only ever REMOVE
 * permission, never add. This is that rule, applied to the environment.
 *
 * ⭐ SO A WORKSPACE ENV FILE MAY SET THE PROJECT’S VARIABLES AND NONE OF OURS.
 * The refusal is REPORTED, never silent — a variable that vanishes without a
 * word is a bug report we would never receive.
 *
 * ⚠️ AND IT IS A PREFIX RULE, NOT A LIST OF THE SWITCHES WE HAPPEN TO HAVE
 * TODAY. A list goes stale the moment somebody adds `ACUVO_ALLOW_ANYTHING`, and
 * the person adding it will not be reading this file. Anything beginning
 * `ACUVO_` is ours by construction.
 *
 * ⚠️ `process.loadEnvFile` DOES NOT OVERRIDE AN ALREADY-SET VARIABLE, which is
 * why our own OPENROUTER_API_KEY survived the probe. That is a mitigation, not a
 * defence: every variable the operator has NOT set is the repository’s to
 * choose, and the switches above are all unset by default. Relying on it would
 * be relying on the user having already configured the thing being attacked.
 */
export const OURS_PREFIX = /^ACUVO_/i;

/**
 * Variables that steer a CHILD PROCESS rather than this one. A repository that
 * cannot set our switches directly must not be able to set them through the
 * environment a spawned python, gh or node inherits either.
 *
 * ⚠️ `command.mjs`’s `scrubEnvironment` already strips conventionally-named
 * secrets and the node injection variables from CHILDREN. This list is the
 * INBOUND half — stopping them entering `process.env` at all — because a
 * variable we never accept is one no future spawn site can forget to scrub.
 */
export const CHILD_STEERING_VARS = Object.freeze([
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
  'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PYTHONWARNINGS', 'PYTEST_ADDOPTS',
  'GH_HOST', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR',
  'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER',
  'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
  'OPENROUTER_API_KEY', 'OPENROUTER_CODEGEN_MODEL',
]);

/**
 * Is this a name a file INSIDE the workspace may set?
 * @param {string} name
 */
export function workspaceMaySet(name) {
  const n = String(name ?? '');
  if (OURS_PREFIX.test(n)) return false;
  return !CHILD_STEERING_VARS.some((v) => v.toLowerCase() === n.toLowerCase());
}

/**
 * The NAMES an env file declares, without evaluating it.
 *
 * ⚠️ NAMES ONLY, DELIBERATELY. The value is never needed to decide whether the
 * name is allowed, and not parsing values means this cannot become a second,
 * subtly-different dotenv implementation that disagrees with Node’s about
 * quoting or multi-line strings. Node still does the actual loading.
 */
export function declaredNames(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}
export function loadEnvFiles(roots, { load = process.loadEnvFile, readImpl = null, env = process.env } = {}) {
  const loaded = [];
  const failed = [];
  /** Names a workspace file tried to set and was not allowed to. Reported, never silent. */
  const refused = [];
  if (typeof load !== 'function') return { loaded, failed, refused };

  const readText = readImpl ?? ((f) => readFileSync(f, 'utf8'));

  const seen = new Set();
  for (const root of roots) {
    for (const file of envFileCandidates(root)) {
      if (seen.has(file)) continue;
      seen.add(file);

      /**
       * ⭐ SNAPSHOT THE NAMES WE OWN, LOAD, THEN PUT THEM BACK.
       *
       * ⚠️ Why not filter BEFORE loading? Because `process.loadEnvFile` is
       * Node’s own parser and offers no hook — reimplementing dotenv to filter
       * first would be a second parser that disagrees with the first about
       * quoting, which is a worse bug than the one being fixed. So the file is
       * loaded, and anything it set that it may not set is restored exactly as
       * it was, including "was not set at all".
       */
      let guarded = [];
      try {
        guarded = declaredNames(readText(file)).filter((n) => !workspaceMaySet(n));
      } catch {
        // Unreadable here means load() fails below and is recorded there.
      }
      const restore = guarded.map((n) => [n, Object.prototype.hasOwnProperty.call(env, n) ? env[n] : undefined]);

      try {
        load(file);
        loaded.push(file);
      } catch (e) {
        failed.push({ file, error: e?.message ?? String(e) });
        continue;
      }

      for (const [name, previous] of restore) {
        const now = env[name];
        if (previous === undefined) delete env[name];
        else env[name] = previous;
        /**
         * ⚠️ Only a name the file actually CHANGED is reported. Declaring a
         * variable that already held the same value is not an attempt at
         * anything, and crying wolf about it teaches people to ignore the line.
         */
        if (now !== previous) refused.push({ file, name });
      }
    }
  }
  return { loaded, failed, refused };
}
