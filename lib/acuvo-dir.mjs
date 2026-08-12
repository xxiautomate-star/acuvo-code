/**
 * ── ⚠️ WE DIRTIED THE USER'S GIT TREE WITH OUR OWN BOOKKEEPING ──────────────
 *
 * Found by our own bench on 2026-08-13, on the `git` task. The agent did the job
 * correctly — fixed the function, matched the repo's commit style, committed the
 * one file — and the task still FAILED:
 *
 *     left the tree dirty: ?? .acuvo/
 *
 * Every run writes an audit line, a session and sometimes a rendered artifact
 * into `.acuvo/`. In a git repository that is an untracked directory the user
 * never asked for, sitting in every `git status` they run afterwards. For a tool
 * whose own bench includes "tidy up and commit", leaving litter in the tree is
 * not a cosmetic issue: it breaks the workflow it is being graded on.
 *
 * ⭐ AND WE ALREADY KNEW. `doctor.mjs`'s `gitignoreCoversAcuvo` detects exactly
 * this and prints `add ".acuvo/" to .gitignore`. Detection without action, which
 * is the shape of nearly every defect found in this repo this week.
 *
 * ── WHY A SELF-IGNORING DIRECTORY AND NOT AN EDIT TO THEIR .gitignore ───────
 *
 * A `.gitignore` containing `*` INSIDE `.acuvo/` makes git ignore the whole
 * directory — including that file — without touching a single byte the user
 * owns. Editing their root `.gitignore` would be a write to a tracked file they
 * did not ask us to change, which would show up in the very diff we are trying
 * to keep clean, and would need reverting if they uninstall.
 *
 * ⚠️ IT IS NEVER OVERWRITTEN. If the file exists we leave it alone, whatever it
 * says: a user who deliberately un-ignored something has made a decision, and
 * silently reversing it every run is worse than the litter.
 *
 * ⚠️ AND IT NEVER THROWS. A read-only checkout or a permission error must not
 * take down a run that was otherwise fine — the litter is a nuisance, failing
 * the user's task over it is not.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ACUVO_DIR = '.acuvo';

/** `*` ignores every entry including this file itself. */
export const SELF_IGNORE_BODY = [
  '# Acuvo Code writes its audit log, sessions and artifacts here.',
  '# This file keeps them out of your repository without touching your .gitignore.',
  '*',
  '',
].join('\n');

/**
 * Make sure `.acuvo/` exists and cannot dirty a git tree.
 *
 * @param {string} root workspace root
 * @returns {{ created: boolean, ignored: boolean, error: string|null }}
 */
export function ensureAcuvoDirIgnored(root) {
  const dir = join(String(root ?? ''), ACUVO_DIR);
  const ignoreFile = join(dir, '.gitignore');
  let created = false;

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created = true;
    }
    if (existsSync(ignoreFile)) return { created, ignored: true, error: null };
    writeFileSync(ignoreFile, SELF_IGNORE_BODY, 'utf8');
    return { created, ignored: true, error: null };
  } catch (err) {
    return { created, ignored: false, error: err instanceof Error ? err.message : String(err) };
  }
}
