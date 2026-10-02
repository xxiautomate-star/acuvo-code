/**
 * ── ⭐⭐ THE FRONT DOOR LINKED AT A FILE THAT DOES NOT SHIP ─────────────────
 *
 * On 2026-09-15 `README.md` went from 1,459 lines of caveats to an 84-line front
 * door, and the engineering record moved VERBATIM to `docs/STATUS.md`. That was
 * the right call and three guards were repointed with it.
 *
 * ⚠️⚠️ WHAT NOBODY CHECKED IS WHETHER THE NEW ADDRESS IS IN THE PACKAGE.
 * `package.json`'s `files` allowlist is `bin/ lib/ skills/ scripts/` plus five
 * named documents — **`docs/` was not among them**. So the most prominent link
 * on the front door, under the heading *"We publish our own limits"*, pointed at
 * a file that is not in the tarball at all.
 *
 * ⭐ IT WOULD HAVE LOOKED FINE ON npmjs.com AND THAT IS WHY IT SURVIVES. npm
 * rewrites relative README links against `repository`, so the website resolves
 * them to GitHub and they work. The reader who actually gets the dead link is
 * the one in `node_modules/acuvo-code` — and `ENTERPRISE.md` explicitly invites
 * exactly that reader to audit the package. A claim to publish our own limits,
 * shipped without the limits, is worse than not making it.
 *
 * ⚠️ THE ASSERTION IS ABOUT THE TARBALL, NOT ABOUT THE WEBSITE. It reads the
 * `files` allowlist — the thing that decides what a user receives — rather than
 * checking the file exists on disk, which it always does in a checkout and is
 * therefore no evidence at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

/**
 * npm always ships these regardless of `files`, so a link to one is safe even
 * though the allowlist does not name it.
 *
 * ⚠️ `LICENSE` IS IN BOTH and that is deliberate — npm's implicit set is not a
 * contract we control, and this repo's whole habit is to say the thing rather
 * than rely on a default holding.
 */
const ALWAYS_SHIPPED = ['package.json', 'README.md', 'LICENSE', 'LICENCE'];

/** Does the published allowlist cover this path? */
function ships(target) {
  if (ALWAYS_SHIPPED.includes(target)) return true;
  return (pkg.files ?? []).some((entry) => (entry.endsWith('/')
    ? target.startsWith(entry)
    : target === entry));
}

test('⭐⭐ every relative link on the front door points at a file that SHIPS', () => {
  const readme = read('README.md');
  /**
   * ⚠️ ANCHORS AND ABSOLUTE URLS ARE NOT LINKS TO FILES. `](#licence)` is an
   * in-page jump and `](https://…)` leaves the package entirely; treating either
   * as a missing file would make this guard fail correct work, which this repo
   * has paid for repeatedly.
   */
  const targets = [...readme.matchAll(/\]\(([^)]+)\)/g)]
    .map((m) => m[1].trim())
    .filter((t) => !t.startsWith('#') && !/^[a-z]+:/i.test(t))
    .map((t) => t.split('#')[0])
    .filter(Boolean);

  assert.ok(targets.length >= 3, `only ${targets.length} relative links found — the matcher has stopped matching`);

  const dead = [...new Set(targets.filter((t) => !ships(t)))];
  assert.deepEqual(
    dead,
    [],
    `README.md links to ${dead.join(', ')}, which package.json's "files" allowlist does not publish. `
    + 'npmjs.com hides this by rewriting relative links to the repository; the reader in node_modules gets '
    + 'a dead link. Add the path to "files", or link to it absolutely.',
  );
});

test('⚠️ the matcher is genuinely wired — an unshipped link IS caught', () => {
  /**
   * ⚠️ WITHOUT THIS THE TEST ABOVE COULD BE PASSING ON AN EMPTY LIST. This repo
   * has shipped several guards that passed while checking nothing, and the
   * filter chain above is exactly the kind that silently removes everything.
   */
  assert.equal(ships('docs/STATUS.md'), true, 'docs/ is not published — the finding this file records has regressed');
  assert.equal(ships('CHANGELOG.md'), true, 'CHANGELOG.md is named in files and should ship');
  assert.equal(ships('MVP-PLAN.md'), false, 'a file that is genuinely not published reads as published — ships() checks nothing');
  assert.equal(ships('bin/acuvo.mjs'), true, 'a directory entry in files must cover the files under it');
});
