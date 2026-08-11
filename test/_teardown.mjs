/**
 * ── TEST TEARDOWN THAT DOES NOT LIE ─────────────────────────────────────────
 *
 * Not a test file (no `.test.mjs`), so `node --test test/*.test.mjs` does not
 * pick it up; it is imported by the tests that kill process trees.
 *
 * ⚠️ WHY THIS EXISTS. On Windows, `rmSync(dir, { recursive: true, force: true })`
 * intermittently throws `EBUSY: resource busy or locked, rmdir …` for a short
 * window after a process that lived in that directory is killed — the handle
 * outlives the pid. Measured here: 1 failure in 22 isolated runs of
 * `command-tree-kill-timeout.regression.test.mjs`, with every assertion in the
 * test passing and only the `finally` failing.
 *
 * ⚠️ THE SCOPE IS CLEANUP, AND ONLY CLEANUP. Retrying an assertion would turn a
 * real intermittent product bug green, which is the worst outcome available
 * here. This helper removes directories. It cannot be pointed at an assertion.
 *
 * ⚠️ AND IT DOES NOT HIDE REAL FAILURES:
 *   · an error code that is not a known lock code is RETHROWN immediately;
 *   · exhausting the budget returns `removed: false` and warns — it never
 *     pretends the directory is gone.
 */

import { rmSync } from 'node:fs';

/**
 * The codes Windows presents when a handle outlives its process. `EPERM` and
 * `EACCES` are on this list because Windows reports a locked file as a
 * permission problem as often as a busy one; `ENOTEMPTY` is what a recursive
 * remove reports when one child inside it could not go.
 */
export const RETRYABLE_RM_CODES = ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Remove a directory, outlasting a transient OS lock.
 *
 * @param {string} dir
 * @param {{ attempts?: number, delayMs?: number, rmImpl?: Function, onGiveUp?: (msg: string) => void }} [opts]
 * @returns {Promise<{ removed: boolean, attempts: number, error?: Error }>}
 */
export async function rmDirWithRetry(dir, opts = {}) {
  const attempts = opts.attempts ?? 20;      // ×100ms ⇒ a 2s ceiling, bounded
  const delayMs = opts.delayMs ?? 100;
  const rmImpl = opts.rmImpl ?? rmSync;
  const onGiveUp = opts.onGiveUp ?? ((msg) => { process.emitWarning(msg); });

  let error;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmImpl(dir, { recursive: true, force: true });
      return { removed: true, attempts: attempt };
    } catch (err) {
      // Not a lock — a genuine problem. Surfacing it is the whole point.
      if (!RETRYABLE_RM_CODES.includes(err && err.code)) throw err;
      error = err;
      if (attempt < attempts) await sleep(delayMs);
    }
  }

  onGiveUp(
    `could not remove the temp directory ${dir} after ${attempts} attempts `
    + `(${error && error.code}) — it is leaked, not cleaned up`,
  );
  return { removed: false, attempts, error };
}
