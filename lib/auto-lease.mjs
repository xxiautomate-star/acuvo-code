/**
 * ── ⭐⭐ `--lease` IS A DECLARATION; THIS IS THE GUARANTEE ────────────────────
 *
 * `bin/acuvo.mjs` states the limit honestly at the import of `lease.mjs`:
 *
 *   "a coding agent does not know which files it will write until it writes
 *    them, so `--lease a.ts --lease b.ts` is a DECLARATION, not a guarantee.
 *    It protects exactly the paths named. The complete fix is one `acquire()`
 *    call inside the executor's write path."
 *
 * This is that call. Every write and every delete claims its own path first, so
 * protection no longer depends on the user having correctly predicted, in
 * advance, what the model was going to do.
 *
 * ⚠️ WHY IT MATTERS MORE THAN IT SOUNDS. The product direction is seven
 * terminals against one checkout. Today two of them writing the same file is
 * SILENT DATA LOSS that surfaces later as "the agent undid my change" — the
 * worst class of bug this package can ship, because the evidence is gone by the
 * time anyone notices. `parallel.mjs` has `detectConflicts`, but read what it
 * does: it walks the results AFTER both tasks have finished and reports which
 * paths two of them wrote. Reporting a collision is not preventing one.
 *
 * ── ⚠️⚠️ THE JUDGEMENT THAT MATTERS: WHEN TO REFUSE ─────────────────────────
 *
 * A guard on the write path can destroy this tool. If it refuses wrongly, the
 * agent cannot write files, which is the entire product. So the two failures
 * are split deliberately and they are NOT treated the same:
 *
 *  · **A known conflict — another terminal holds this exact path — REFUSES.**
 *    We have positive evidence someone else owns the file. Refusing is the
 *    whole feature, and the refusal names the holder so it can be acted on.
 *
 *  · **An infrastructure failure — the lease directory is unwritable, the disk
 *    is full, a record is corrupt — ALLOWS THE WRITE and marks it degraded.**
 *    ⭐ This is the important half. Yesterday there was no protection at all,
 *    so a broken `.acuvo/leases` directory that BLOCKED every write would be a
 *    strictly worse product than the one that shipped without leases. "A check
 *    that fails correct work is worse than no check" is the rule this package
 *    has been burned by four times in one day, and a guard on the write path is
 *    where it would hurt most. We refuse only what we can prove.
 *
 * `heldBy` is the discriminator: `lease.mjs` sets it only when a live record
 * belonging to somebody else is what stopped the acquire.
 *
 * ── ⭐ RE-ENTRANT, BECAUSE A RUN WRITES THE SAME FILE MANY TIMES ─────────────
 *
 * A write → run → fix loop rewrites one file three or four times. Claiming it
 * once and remembering that is not an optimisation, it is correctness: the
 * second acquire would be refused by our OWN lease, and the agent would be
 * blocked by itself, which is the most confusing possible failure.
 *
 * ⭐ A repeat claim RENEWS instead. That is a free keepalive on exactly the
 * files being worked on: a run that outlives the TTL keeps what it is actively
 * using and lets go of what it touched once and abandoned, which is the
 * behaviour you would design on purpose.
 */

import { acquire, release, renew, DEFAULT_TTL_MS } from './lease.mjs';

/**
 * @param {string} root
 * @param {object} [opts]
 * @param {string} [opts.holder]        who to record as holding. Defaults to the pid.
 * @param {number} [opts.ttlMs]
 * @param {Function} [opts.acquireImpl] injected for tests — no disk required
 * @param {Function} [opts.releaseImpl]
 * @param {Function} [opts.renewImpl]
 */
export function createPathClaimer(root, {
  holder = `pid-${process.pid}`,
  ttlMs = DEFAULT_TTL_MS,
  acquireImpl = acquire,
  releaseImpl = release,
  renewImpl = renew,
} = {}) {
  /** @type {Map<string, any>} relative path -> the lease handle we hold */
  const mine = new Map();
  /** Paths we could not protect, so the caller can say so once at the end. */
  const degraded = new Set();

  return {
    /**
     * Claim `relPath` for writing.
     *
     * @returns {{ok: true, degraded?: boolean} | {ok: false, error: string, heldBy: string}}
     */
    claim(relPath) {
      const path = String(relPath ?? '').trim();
      if (!path) return { ok: true };

      // Already ours: renew and carry on. Never re-acquire — see the header.
      const existing = mine.get(path);
      if (existing) {
        try { renewImpl(existing, { ttlMs }); } catch { /* a failed keepalive is not a reason to block a write */ }
        return { ok: true };
      }

      let got;
      try {
        got = acquireImpl(root, { path, holder, pid: process.pid, ttlMs });
      } catch (err) {
        /**
         * ⚠️ A THROW IS INFRASTRUCTURE, NEVER A CONFLICT. `lease.mjs` returns
         * its refusals; it throws only when something underneath it broke. Let
         * the write through rather than making a filesystem problem look like a
         * colleague holding the file.
         */
        degraded.add(path);
        return { ok: true, degraded: true, reason: err?.message ?? String(err) };
      }

      if (got?.ok) {
        /**
         * ⚠️ `got.lease`, NOT `got`. `acquire` returns
         * `{ok, lease, warnings}` and the HANDLE — the thing `release` and
         * `renew` need, carrying `file` and `token` — is nested inside it.
         * Storing the result instead of the handle made `release` a silent
         * no-op: it type-checks its argument and returns
         * `{ok:true, released:false, reason:'not a lease handle'}`, so every
         * path stayed locked for its full TTL and nothing said so.
         *
         * ⭐ Caught by the round-trip test (claim → release → another terminal
         * claims), never by the unit tests — their stub `acquireImpl` returned
         * a shape the real module does not use. A stub that does not match
         * reality tests the stub.
         */
        mine.set(path, got.lease ?? got);
        return { ok: true };
      }

      if (got?.heldBy) {
        return {
          ok: false,
          heldBy: got.heldBy,
          error:
            `${path} is being written by another terminal (${got.heldBy}) right now, so this write was refused `
            + 'rather than silently overwriting their work. Wait for them to finish, work on a different file, or run '
            + '`acuvo leases` to see who holds what.',
        };
      }

      /**
       * Refused for a reason that is not a conflict — an unwritable lease
       * directory, a corrupt record, a path the lease layer will not normalise.
       * The write proceeds unprotected, which is exactly what happened on every
       * run before this module existed.
       */
      degraded.add(path);
      return { ok: true, degraded: true, reason: got?.error ?? 'the lease could not be taken' };
    },

    /** Paths written without protection, if any. For one honest line at the end. */
    unprotected() {
      return [...degraded];
    },

    held() {
      return [...mine.keys()];
    },

    /**
     * ⚠️ Release must never throw. It runs from an `exit` handler, where a
     * throw is an ugly crash on the way out of a run that already succeeded —
     * and every lease has a TTL, so the worst case of a missed release is a
     * path that frees itself shortly afterwards.
     */
    releaseAll() {
      for (const handle of mine.values()) {
        try { releaseImpl(handle); } catch { /* the TTL will clear it */ }
      }
      mine.clear();
    },
  };
}
