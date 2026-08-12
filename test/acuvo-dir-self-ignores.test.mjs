/**
 * ── ⚠️ OUR BOOKKEEPING DIRTIED THE USER'S GIT TREE ──────────────────────────
 *
 * Found by our own bench, not by a unit test — the `git` task on 2026-08-13.
 * The agent did the work correctly and the task still failed:
 *
 *     left the tree dirty: ?? .acuvo/
 *
 * Every run writes an audit line and a session into `.acuvo/`. In a repository
 * that is an untracked directory in every `git status` the user runs afterwards,
 * and it breaks exactly the "tidy up and commit" workflow the bench grades.
 *
 * ⭐ `doctor.mjs`'s `gitignoreCoversAcuvo` already DETECTED this and printed
 * `add ".acuvo/" to .gitignore`. Detection without action — the shape of nearly
 * every defect found in this repo this week.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureAcuvoDirIgnored, SELF_IGNORE_BODY, ACUVO_DIR } from '../lib/acuvo-dir.mjs';

const ws = () => mkdtempSync(join(tmpdir(), 'acuvo-dir-'));

test('⭐⭐ .acuvo/ ignores itself, so it can never appear in git status', () => {
  const root = ws();
  const r = ensureAcuvoDirIgnored(root);

  assert.equal(r.ignored, true, r.error ?? '');
  const body = readFileSync(join(root, ACUVO_DIR, '.gitignore'), 'utf8');
  assert.match(body, /^\*$/m, 'a bare * is what makes git ignore the whole directory, including this file');
});

test('⭐ it does NOT touch the user\'s own .gitignore', () => {
  /**
   * ⚠️ Editing their root .gitignore would be a write to a tracked file nobody
   * asked us to change — it would appear in the very diff we are keeping clean,
   * and would need reverting if they uninstall. The self-ignoring directory
   * achieves the same thing while owning only our own bytes.
   */
  const root = ws();
  const theirs = join(root, '.gitignore');
  writeFileSync(theirs, 'node_modules\n', 'utf8');

  ensureAcuvoDirIgnored(root);

  assert.equal(readFileSync(theirs, 'utf8'), 'node_modules\n', 'their file is byte-identical');
});

test('⚠️ an existing .acuvo/.gitignore is never overwritten', () => {
  /**
   * A user who deliberately un-ignored something has made a decision. Silently
   * reversing it on every run is worse than the litter it prevents.
   */
  const root = ws();
  mkdirSync(join(root, ACUVO_DIR), { recursive: true });
  const mine = join(root, ACUVO_DIR, '.gitignore');
  writeFileSync(mine, '# deliberately kept\n!audit/\n', 'utf8');

  const r = ensureAcuvoDirIgnored(root);

  assert.equal(r.ignored, true);
  assert.equal(readFileSync(mine, 'utf8'), '# deliberately kept\n!audit/\n', 'their choice survives');
});

test('it is idempotent — twice is the same as once', () => {
  const root = ws();
  const first = ensureAcuvoDirIgnored(root);
  const body1 = readFileSync(join(root, ACUVO_DIR, '.gitignore'), 'utf8');
  const second = ensureAcuvoDirIgnored(root);
  const body2 = readFileSync(join(root, ACUVO_DIR, '.gitignore'), 'utf8');

  assert.equal(first.created, true);
  assert.equal(second.created, false, 'the directory already existed the second time');
  assert.equal(body1, body2);
  assert.equal(body1, SELF_IGNORE_BODY);
});

test('⚠️ it NEVER throws — a read-only checkout must not fail the user\'s task', () => {
  /**
   * The litter is a nuisance; failing a run that was otherwise fine, over
   * housekeeping, is not a trade worth making. An unwritable root returns an
   * error to the caller instead of taking the process down.
   */
  assert.doesNotThrow(() => ensureAcuvoDirIgnored('/definitely/not/a/real/path/anywhere'));
  const r = ensureAcuvoDirIgnored('/definitely/not/a/real/path/anywhere');
  assert.equal(typeof r.ignored, 'boolean', 'it still returns a verdict rather than throwing');

  assert.doesNotThrow(() => ensureAcuvoDirIgnored(null));
  assert.doesNotThrow(() => ensureAcuvoDirIgnored(undefined));
});

test('⭐ the file explains itself — someone will find it and wonder', () => {
  const root = ws();
  ensureAcuvoDirIgnored(root);
  const body = readFileSync(join(root, ACUVO_DIR, '.gitignore'), 'utf8');
  assert.match(body, /Acuvo/, 'name the tool that put it there');
  assert.match(body, /gitignore/i, 'and say why it exists rather than editing theirs');
});
