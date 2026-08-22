/**
 * ── ⭐ DELETE — THE MISSING PRIMITIVE THAT DERAILED WHOLE SESSIONS ───────────
 *
 * FOUND BY RUNNING THE CLI, 2026-08-09, and it is the clearest example in this
 * package of why running it beats reasoning about it.
 *
 * The task was "fix slugify, then commit it". The model fixed it, wrote a
 * `check.mjs` to verify, ran it, and it passed. Then, with three rounds left,
 * it tried to tidy up — and could not, because `write_file` was the only verb
 * that touched the filesystem. Its own words in round 8:
 *
 *     "I need to remove the scratch file. Since I can't use rm, let me check
 *      if there's another way. Actually, the empty file is still there."
 *
 * ⚠️ SO IT OVERWROTE THE FILE WITH ZERO BYTES — the only deletion available to
 * it — and then spent every remaining round circling the problem. **The commit
 * never happened.** A missing primitive does not merely block its own task; it
 * captures the loop, and everything downstream of it silently does not occur.
 * The observable symptom was "the agent won't commit", and the cause was three
 * tools away.
 *
 * ── ⚠️ WHY THIS IS THE MOST DANGEROUS TOOL IN THE PACKAGE, AND WHAT BOUNDS IT ─
 * `write_file` can destroy a file's contents, but the file is still there and
 * `git diff` still shows what it was. Delete removes the evidence too. So:
 *
 *   1. **One path per call.** No globs, no recursion, no arrays. Deleting a
 *      tree is the operation nobody can review, and an agent that can only
 *      remove one named file at a time cannot do it by accident.
 *   2. **Files only.** A directory is refused outright — see above.
 *   3. **The workspace rules, unchanged.** `resolveInWorkspace(…, 'write')`
 *      already forbids `.git`, `node_modules`, `.next` and `.vercel`, so the
 *      repository's own history is not reachable from here. That is inherited,
 *      not re-implemented — one place decides what "writable" means.
 *   4. **Size-capped, and the size is REPORTED.** Removing a 4KB scratch file
 *      and removing a 400KB source file should not read identically in a
 *      summary, so the byte count comes back and the summary prints it.
 *
 * ⭐ AND THE HONEST LIMIT: this does not stop a model deleting a real source
 * file it wrongly believes is scratch. Nothing here can, short of refusing to
 * delete anything the session did not create — which would forbid "remove the
 * deprecated module", a legitimate and common request. The mitigation is that
 * it is one file, named, printed, and (in a repo) recoverable with git. That is
 * the trade, stated rather than papered over.
 */

import { unlinkSync, statSync } from 'node:fs';
import { resolveInWorkspace } from './workspace.mjs';

/**
 * @typedef {{ ok: false, error: string }} DeleteRefused
 * @param {string} root
 * @param {unknown} rawPath
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {DeleteRefused | { ok: true, path: string, bytes: number, dryRun: boolean }}
 */
export function deleteFile(root, rawPath, { dryRun = false } = {}) {
  const target = resolveInWorkspace(root, rawPath, 'write');
  if (!target.ok) return { ok: false, error: target.reason };

  let stat;
  try {
    stat = statSync(target.absolute);
  } catch {
    /**
     * ⚠️ "ALREADY GONE" IS REPORTED AS A REFUSAL, NOT QUIETLY AS SUCCESS, and
     * the wording matters. A model told "deleted" for a file that never existed
     * will believe a path it invented was real, and carry that belief into the
     * next round. Saying it plainly is what stops the invention compounding.
     */
    return { ok: false, error: `no such file: ${target.relative} — nothing was deleted` };
  }
  if (stat.isDirectory()) {
    return {
      ok: false,
      error: `${target.relative} is a directory. This agent deletes one FILE at a time and never a directory — removing a tree is the operation nobody can review.`,
    };
  }

  const bytes = stat.size;
  if (!dryRun) {
    try {
      unlinkSync(target.absolute);
    } catch (err) {
      return { ok: false, error: `could not delete ${target.relative}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: true, path: target.relative, bytes, dryRun };
}

export function deleteToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'delete_file',
      description: [
        'Delete ONE file from the workspace.',
        'Use it to remove a scratch or temporary file you created while verifying your work —',
        'do NOT leave an empty file behind by writing "" to it, delete it properly.',
        'One file per call: no globs, no directories, no recursion.',
        'Be certain before deleting anything you did not create in this session.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of the file to delete.' },
        },
        required: ['path'],
      },
    },
  };
}
