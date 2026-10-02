/**
 * ── ⚠️⚠️ THE BUNDLE DOES NOT REBUILD ITSELF, AND THE BENCH SCORES IT ─────────
 *
 * `dist/acuvo.mjs` is produced by `npm run bundle`. Nothing triggers that: not a
 * test run, not a commit, not `npm publish`. So it silently drifts behind `lib/`
 * the moment anybody edits a module and forgets.
 *
 * ⭐ WHAT IS AND IS NOT AFFECTED — the distinction matters, and getting it wrong
 * caused a wrong alarm the day this file was written:
 *
 *   · `npm i -g acuvo-code` is NOT affected. `package.json`'s `files` field ships
 *     `bin/` and `lib/` and NOT `dist/`, so an installed CLI runs from source.
 *   · **The BENCH is affected**, and that is the expensive one. This repo has
 *     already paid for it once: a 3.5-hour, 60-task scored run returned 0/60
 *     because it was measuring a three-day-old bundle. The lesson is recorded as
 *     `feedback_rebuild_the_bundle_before_a_scored_run`, and it was walked into
 *     three more times on 2026-08-25 alone — twice by an agent, once by me.
 *
 * ⚠️ SO THIS TEST IS A REMINDER, NOT A GATE. It fails when the bundle is older
 * than the newest source file, and its message says exactly what to type. It
 * does NOT fail when the bundle is absent: a fresh clone has no `dist/` (it is
 * gitignored), and a test that fails on checkout is a test people delete.
 *
 * ⚠️ AND IT COMPARES MTIMES, NOT CONTENT. Hashing every module on every run to
 * detect a no-op edit would cost more than the mistake it prevents; a touched
 * file that changed nothing costs one cheap rebuild.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(ROOT, 'dist', 'acuvo.mjs');

/** Newest mtime across the sources the bundler actually reads. */
function newestSource() {
  let newest = { path: null, at: 0 };
  for (const dir of ['lib', 'bin']) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (!name.endsWith('.mjs')) continue;
      const p = join(abs, name);
      const at = statSync(p).mtimeMs;
      if (at > newest.at) newest = { path: `${dir}/${name}`, at };
    }
  }
  return newest;
}

test('⚠️ dist/acuvo.mjs is not older than lib/ — the bench scores the bundle, not the source', () => {
  if (!existsSync(BUNDLE)) {
    // A fresh clone has no dist/. Nothing to be stale, nothing to warn about.
    return;
  }

  const built = statSync(BUNDLE).mtimeMs;
  const newest = newestSource();
  assert.ok(newest.path, 'no source modules found — the layout moved and this check is reading nothing');

  assert.ok(
    built >= newest.at,
    `dist/acuvo.mjs is STALE: ${newest.path} was modified after the bundle was built.\n`
    + `  bundle built: ${new Date(built).toISOString()}\n`
    + `  ${newest.path}: ${new Date(newest.at).toISOString()}\n`
    + '  Run `npm run bundle` before any scored bench run. An installed CLI is unaffected '
    + '(package.json ships lib/, not dist/), but the bench measures the bundle — a stale one '
    + 'once returned 0/60 on a 3.5-hour run.',
  );
});
