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

import { existsSync, statSync } from 'node:fs';
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
export function loadEnvFiles(roots, { load = process.loadEnvFile } = {}) {
  const loaded = [];
  const failed = [];
  if (typeof load !== 'function') return { loaded, failed };

  const seen = new Set();
  for (const root of roots) {
    for (const file of envFileCandidates(root)) {
      if (seen.has(file)) continue;
      seen.add(file);
      try {
        load(file);
        loaded.push(file);
      } catch (e) {
        failed.push({ file, error: e?.message ?? String(e) });
      }
    }
  }
  return { loaded, failed };
}
