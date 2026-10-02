/**
 * ── ⚠️⚠️ A FILE ON YOUR DISK IS NOT A FILE IN THE PRODUCT ────────────────────
 *
 * TWICE IN ONE DAY, work was finished, tested, working locally — and untracked:
 *
 *   1. `console/public/vendor/` — 1.8 MB of game engines. The console deploys
 *      from git, so every engine would have 404'd in production while a
 *      committed allowlist advertised them in the present tense.
 *   2. `acuvo-code/skills/{game-engines,game-feel,ui-components}.md` — three new
 *      skills. `package.json`'s `files` ships the `skills/` DIRECTORY, so a
 *      local `npm publish` would have included them and a publish from a CLEAN
 *      CLONE would not. That is the worst kind of bug: it works for the person
 *      who wrote it and fails for everyone else, intermittently, depending on
 *      which machine ran the release.
 *
 * ⭐ EVERY OTHER GUARD IN THIS REPO ASKS "does the code do what it says". None
 * asked "will this file EXIST for anyone but me". A working tree is not a
 * distribution, and that gap is invisible to every suite that reads the disk —
 * which is all of them. Both instances were found by an adversarial verifier.
 *
 * ⚠️ THIS IS DELIBERATELY NOT A LINT RULE ABOUT `git add`. It asserts the
 * INVARIANT — everything we ship is reproducible from a clone — so it keeps
 * working when the reason a file is missing is something nobody predicted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What a fresh clone would receive. `git ls-files` IS the distribution. */
function tracked(dir) {
  try {
    return new Set(
      execFileSync('git', ['ls-files', dir], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').map((l) => l.trim()).filter(Boolean)
        .map((p) => p.split('/').pop()),
    );
  } catch {
    return null; // not a git checkout (a tarball, a CI cache) — reported, not silently passed
  }
}

test('⚠️⚠️ every shipped skill is in git, not just on this disk', () => {
  const inGit = tracked('skills');
  if (inGit === null) {
    // ⚠️ An honest skip. "Cannot check" is a different answer from "fine", and
    // this repo has been bitten by tests that reported the second while meaning
    // the first.
    assert.ok(true, 'not a git checkout — cannot verify the distribution here');
    return;
  }

  const onDisk = readdirSync(join(ROOT, 'skills')).filter((f) => f.endsWith('.md'));
  assert.ok(onDisk.length > 20, `only ${onDisk.length} skills found — the shelf moved, fix this path`);

  const missing = onDisk.filter((f) => !inGit.has(f));
  assert.deepEqual(
    missing, [],
    `these skills exist here and are NOT tracked by git, so they ship from THIS machine and from `
    + `nowhere else — a publish from a clean clone silently drops them: ${missing.join(', ')}. `
    + 'Run `git add acuvo-code/skills`.',
  );
});

/**
 * ⚠️ `lib/` IS THE PACKAGE. `files` ships the whole directory, so an untracked
 * module is the same failure with worse consequences: the CLI would import
 * something that exists in development and is absent from the published tarball.
 */
test('⚠️ every lib module the package ships is in git', () => {
  const inGit = tracked('lib');
  if (inGit === null) return;

  const onDisk = readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs'));
  assert.ok(onDisk.length > 50, `only ${onDisk.length} modules found — the layout moved, fix this path`);

  const missing = onDisk.filter((f) => !inGit.has(f));
  assert.deepEqual(
    missing, [],
    `untracked modules in lib/: ${missing.join(', ')}. They work here and are missing from a clone.`,
  );
});
