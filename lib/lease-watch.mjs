/**
 * ── ⚠️⚠️ A LEASE GUARDS THE FILE VERBS. IT CANNOT GUARD CODE THE AGENT RUNS ──
 *
 * `auto-lease.mjs` claims a path on every `write_file` and `delete_file`, so a
 * second terminal is refused rather than silently overwriting the first. That
 * is true, and it is not the whole truth.
 *
 * PROVEN 2026-08-13, two terminals, one checkout:
 *
 *     terminal-1 holds src/app.ts
 *     terminal-2  write_file src/app.ts   -> refused, "held by terminal-1"  ✅
 *     terminal-2  evaluate  (writes it)   -> src/app.ts is now "CLOBBERED"  ❌
 *
 * `evaluate` and `run_command` start a real process. A process can write
 * anything the user can write, and no in-process guard can prevent that without
 * removing the ability to run code — which is the product.
 *
 * ⭐ SO THE ANSWER IS NOT PREVENTION, IT IS DETECTION, and detection here is
 * cheap for a reason worth stating: **the only files that matter are the ones
 * another terminal has claimed**, and the lease directory lists exactly those.
 * A handful of `statSync` calls, not a walk of the tree. Watching the whole
 * workspace would cost more than the command usually does and would report
 * every build artefact; watching four leased paths costs nothing and reports
 * only the thing somebody needs to know.
 *
 * ⚠️ THIS DOES NOT MAKE THE WRITE SAFE. It makes it LOUD. The other terminal's
 * work is already overwritten by the time this fires — what changes is that
 * somebody finds out immediately, from the run that did it, instead of a week
 * later from a git log. That is the honest thing this layer can offer, and
 * claiming more would be the false-safety problem it exists to correct.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

import { inspect } from './lease.mjs';

/**
 * Fingerprint every path another holder currently owns.
 *
 * @param {string} root
 * @param {string|null} myHolder  leases with this holder are OURS and ignored
 * @param {{ inspectImpl?: Function, statImpl?: Function }} [opts]
 * @returns {{ path: string, holder: string, mtimeMs: number|null, size: number|null }[]}
 */
export function snapshotForeignLeases(root, myHolder, { inspectImpl = inspect, statImpl = statSync } = {}) {
  let view;
  try {
    view = inspectImpl(root);
  } catch {
    // ⚠️ An unreadable lease directory means we cannot warn, not that the run
    // should stop. This layer is a smoke alarm; a broken alarm does not
    // condemn the building.
    return [];
  }
  const mine = String(myHolder ?? '').trim();
  const out = [];
  for (const l of view?.leases ?? []) {
    if (!l?.path) continue;
    if (mine && l.holder === mine) continue;
    let mtimeMs = null;
    let size = null;
    try {
      const st = statImpl(join(root, l.path));
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      // The path may not exist yet — a lease can be taken on a file about to be
      // created. `null` records that, and a file appearing IS a change.
    }
    out.push({ path: l.path, holder: l.holder ?? '(unknown)', mtimeMs, size });
  }
  return out;
}

/**
 * Which of those paths changed while the command ran?
 *
 * @returns {{ path: string, holder: string, what: 'modified'|'created'|'deleted' }[]}
 */
export function detectForeignChanges(snapshot, root, { statImpl = statSync } = {}) {
  const changed = [];
  for (const before of snapshot ?? []) {
    let after = null;
    try {
      const st = statImpl(join(root, before.path));
      after = { mtimeMs: st.mtimeMs, size: st.size };
    } catch { /* gone */ }

    if (before.mtimeMs === null && after) { changed.push({ ...before, what: 'created' }); continue; }
    if (before.mtimeMs !== null && !after) { changed.push({ ...before, what: 'deleted' }); continue; }
    if (!after) continue;
    /**
     * ⚠️ SIZE **OR** MTIME. A same-length edit — flipping a digit, swapping a
     * flag — leaves the size identical, and those are exactly the edits worth
     * catching. Filesystems with coarse mtime granularity are the reason size
     * is checked too, rather than instead.
     */
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
      changed.push({ ...before, what: 'modified' });
    }
  }
  return changed;
}

/** The sentence somebody needs to read, once, loudly. */
export function formatForeignChanges(changes) {
  if (!changes || changes.length === 0) return null;
  const lines = [
    `⚠️  a command this run started ${changes.length === 1 ? 'changed a file' : `changed ${changes.length} files`} another terminal is holding:`,
  ];
  for (const c of changes) lines.push(`      ${c.what.padEnd(8)} ${c.path}  ← held by ${c.holder}`);
  lines.push('    A lease stops `write_file`; it cannot stop code the agent runs. Their work may be overwritten.');
  return lines.join('\n');
}
