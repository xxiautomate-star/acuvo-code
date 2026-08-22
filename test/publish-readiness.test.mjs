/**
 * ── ⚠️⚠️ THE PACKAGE HAS NEVER BEEN PUBLISHED, SO NOBODY CAN INSTALL IT ─────
 *
 * Measured 2026-08-20 against the live registry:
 *
 *     npm view acuvo-code
 *     # npm error code E404
 *     # npm error 404 Not Found - GET https://registry.npmjs.org/acuvo-code
 *
 * Zero adoption is not a capability gap here. Every tool in `lib/tools.mjs`
 * could be perfect and the install count would still be zero, because there is
 * nothing on the registry to install. ⭐ This is the packaging flavour of the
 * defect this repo keeps paying for — *built is not shipped* — one level above
 * `test/skills-are-published.test.mjs`, which caught 20 skills that existed in
 * the repo and in none of the tarballs.
 *
 * ⚠️ THIS FILE DOES NOT PUBLISH ANYTHING and must never try to. It asserts the
 * MANIFEST is correct so that the day somebody runs `npm publish`, the tarball
 * that lands is installable, honestly licensed, and free of secrets. Publishing
 * is the owner's call; being ready for it is ours.
 *
 * ⚠️ AND IT MAKES NO NETWORK CALL. Every fact it needs is on disk. A test that
 * pings the registry fails on a plane, and a check that fails correct work is
 * worse than no check at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** The directories npm will copy, without their trailing slash. */
const publishedDirs = pkg.files.filter((f) => f.endsWith('/')).map((f) => f.replace(/\/$/, ''));
/** Individual files named in the allowlist, plus the three npm always includes. */
const publishedFiles = new Set([
  ...pkg.files.filter((f) => !f.endsWith('/')),
  'package.json', 'README.md', 'LICENSE',
]);

/** A repo-relative POSIX path is shipped if it is allowlisted, or lives under a shipped dir. */
function isShipped(rel) {
  return publishedFiles.has(rel) || publishedDirs.includes(rel.split('/')[0]);
}

// ───────────────────────────────────────────────────────────────────────────
// 1. The manifest permits publishing at all
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ `private` is not set — it makes `npm publish` refuse outright', () => {
  /**
   * `private: true` is a hard stop in npm itself ("This package has been marked
   * as private"), and it is the single field most likely to be added by a
   * well-meaning edit that wanted to stop an *accidental* publish. There is no
   * partial version of this failure: the field is either absent or the package
   * can never ship.
   */
  assert.equal(
    pkg.private,
    undefined,
    'package.json sets `private`, so `npm publish` will refuse and this package can never be installed by anyone',
  );
});

test('⚠️ the npm page has the fields a stranger judges the package by', () => {
  /**
   * These are not decoration. `description` is the one line that appears in
   * `npm search` results; `homepage` is the only route a reader has to anything
   * that is not this tarball. A package with neither reads as abandoned before
   * anybody runs it.
   */
  for (const field of ['name', 'version', 'description', 'homepage', 'author', 'keywords']) {
    assert.ok(
      pkg[field] !== undefined && String(pkg[field]).length > 0,
      `package.json has no \`${field}\` — the npm page a stranger lands on is built from these fields`,
    );
  }
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, `version ${pkg.version} is not semver, and npm will reject it`);
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Everything the installed package needs is actually in the tarball
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ every `bin` target exists AND ships', () => {
  /**
   * The bin shim is the whole product surface: `acuvo "fix the test"` resolves
   * through it. A bin entry pointing at a path outside `files` installs a
   * symlink to nothing, and the failure a user sees is
   * `Cannot find module .../bin/acuvo.mjs` — after they have already paid the
   * install, which is the worst possible moment to discover it.
   */
  const names = Object.keys(pkg.bin ?? {});
  assert.ok(names.length > 0, 'package.json declares no `bin`, so installing it puts no command on PATH');
  for (const [name, target] of Object.entries(pkg.bin)) {
    const rel = target.replace(/^\.\//, '');
    assert.ok(existsSync(join(ROOT, rel)), `bin "${name}" points at ${target}, which does not exist on disk`);
    assert.ok(isShipped(rel), `bin "${name}" points at ${target}, which is NOT inside the \`files\` allowlist — it will not be in the tarball`);
  }
});

test('⚠️ every `exports` target exists AND ships', () => {
  /**
   * `exports` is the programmatic half of the surface — `import { … } from
   * "acuvo-code/turn"`. Unlike `bin`, a broken subpath fails only for the
   * consumer who imports it, so it can sit wrong for a long time without
   * anybody noticing.
   */
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== 'string' || target.includes('*')) continue; // glob subpaths are covered by the graph walk below
    const rel = target.replace(/^\.\//, '');
    assert.ok(existsSync(join(ROOT, rel)), `exports "${subpath}" points at ${target}, which does not exist`);
    assert.ok(isShipped(rel), `exports "${subpath}" points at ${target}, which is not in the \`files\` allowlist`);
  }
});

/**
 * ⭐⭐ THE GENERAL FORM OF THE `skills/` BUG.
 *
 * `skills-are-published` asserts one directory is listed. That guard is exact
 * and it only ever catches the directory somebody already thought of. The
 * failure underneath it is structural: a module can be imported at runtime and
 * live outside the allowlist, and NOTHING in a green local suite notices,
 * because locally the file is simply there.
 *
 * So this walks the real import graph out of the `bin` entries and asserts every
 * module it reaches is inside a shipped directory. Measured on 2026-08-20:
 * 114 modules reached, 0 outside — the allowlist is correct today, and this is
 * what keeps it correct after the next `lib/` split.
 */
function importGraphFromBins() {
  const seen = new Set();
  const walk = (abs) => {
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    /**
     * ⚠️ BLOCK COMMENTS ARE STRIPPED FIRST. Without this the walk "reaches"
     * `lib/lib/thing.mjs` and `lib/x.js` — paths that appear only inside the
     * prose of the header comments, which this codebase writes a great deal of.
     * Chasing them produced four phantom missing modules on the first run.
     */
    const src = readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const specs = [
      ...src.matchAll(/(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g),
      ...src.matchAll(/(?:^|\n)\s*export\s+(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/g),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]).filter((s) => s.startsWith('.'));
    for (const s of specs) walk(resolve(dirname(abs), s));
  };
  for (const target of Object.values(pkg.bin ?? {})) walk(resolve(ROOT, target.replace(/^\.\//, '')));
  return seen;
}

test('⭐⭐ every module the CLI imports at runtime is inside the `files` allowlist', () => {
  const reached = importGraphFromBins();
  /**
   * ⚠️ A BLINDNESS GUARD, because the assertion below passes trivially on an
   * empty set. If a regex change ever stops the walk finding imports, this is
   * the line that says so instead of reporting a clean bill of health.
   */
  assert.ok(reached.size > 50, `the import walk only reached ${reached.size} modules — it has gone blind, and "0 outside the allowlist" would mean nothing`);

  const outside = [...reached]
    .map((abs) => relative(ROOT, abs).split(sep).join('/'))
    .filter((rel) => !isShipped(rel))
    .sort();
  assert.deepEqual(
    outside,
    [],
    `these modules are imported by the installed CLI but are NOT in the \`files\` allowlist, so the tarball ships a CLI that cannot boot:\n${outside.join('\n')}`,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 3. The licence npm advertises is the licence in the file
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ the `license` field is the SPDX id of the licence actually in LICENSE', () => {
  /**
   * ── THE ABBREVIATION IN OUR OWN LICENCE FILE IS NOT A VALID SPDX ID ────────
   *
   * `LICENSE` opens with "Functional Source License, Version 1.1, Apache 2.0
   * Future License" and declares the abbreviation **FSL-1.1-Apache-2.0**. That
   * is what fsl.software calls it, and it is not what SPDX registered.
   *
   * Measured 2026-08-20 against `https://spdx.org/licenses/licenses.json`
   * (list version 3.28.0) and against the SPDX id list bundled inside the npm
   * on this machine (667 ids):
   *
   *     FSL-1.1-ALv2  | Functional Source License, Version 1.1, ALv2 Future License
   *     FSL-1.1-MIT   | Functional Source License, Version 1.1, MIT Future License
   *     FSL-1.1-Apache-2.0 → NOT PRESENT in either list
   *
   * ⭐ So the id is `FSL-1.1-ALv2` (ALv2 *is* Apache License v2), and it is a
   * real SPDX id, which is why this field must not be `SEE LICENSE IN LICENSE`.
   * That string is the correct npm idiom only for a licence SPDX does not
   * carry; here it would render on the npm page as an unnamed custom licence —
   * the exact ambiguity an enterprise buyer's legal review stops at, for a
   * package whose whole commercial model rests on the licence being readable.
   */
  const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
  assert.match(license, /Functional Source License, Version 1\.1/i, 'LICENSE is no longer FSL 1.1 — this mapping has to be redone, not edited to match');

  const future = /MIT Future License/i.test(license) ? 'FSL-1.1-MIT'
    : /(?:Apache 2\.0|ALv2) Future License/i.test(license) ? 'FSL-1.1-ALv2'
      : null;
  assert.ok(future, 'LICENSE declares no recognised future licence, so no SPDX id can be derived from it');

  assert.equal(
    pkg.license,
    future,
    `package.json says license "${pkg.license}" but LICENSE is ${future}. `
    + 'npm publishes this field verbatim, so a mismatch is npm telling every reader the wrong terms.',
  );
});

test('⚠️ the LICENSE file itself ships', () => {
  /**
   * npm always includes a root `LICENSE`, so this cannot currently fail — which
   * is the point of writing it down: a source-available licence that is not in
   * the tarball is an unlicensed tarball, and this records that we checked.
   */
  assert.ok(existsSync(join(ROOT, 'LICENSE')), 'there is no LICENSE file for the `license` field to refer to');
  assert.ok(isShipped('LICENSE'), 'LICENSE is not shipped');
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The repository field points somewhere a person can actually go
// ───────────────────────────────────────────────────────────────────────────

test('⚠️ `repository` is a normalised git URL, and names a directory if it is a monorepo', () => {
  /**
   * ⚠️ THIS ASSERTS SHAPE, NOT REACHABILITY, and deliberately so. Whether
   * `github.com/xxiautomate-star/acuvo-code` resolves is a fact about the
   * internet on the day the test runs; on 2026-08-20 github.com was not
   * reachable from this machine at all (`UND_ERR_CONNECT_TIMEOUT`, while
   * registry.npmjs.org answered fine), so a reachability assertion here would
   * have failed correct work. The repo's own documents disagree about it too:
   * README.md records cloning it successfully on 2026-08-11 and again on
   * 2026-08-13, while `docs-truth.test.mjs` still describes it as 404ing.
   * ⭐ That disagreement is a thing for a human to settle with a browser, not
   * something a unit test should arbitrate.
   *
   * ⭐ What IS checkable offline: npm rewrites a bare `https://…` into
   * `git+https://….git` on publish, so storing the normalised form keeps the
   * manifest identical to what the registry will show — and if the repo path's
   * last segment is not the package name, this is a monorepo checkout and npm
   * needs `repository.directory` or every "Repository" link on the npm page
   * lands on a root that does not contain this code.
   */
  const repo = pkg.repository;
  assert.ok(repo && typeof repo === 'object', 'package.json has no `repository` object');
  assert.equal(repo.type, 'git');
  assert.match(
    repo.url,
    /^git\+https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\.git$/,
    `repository.url "${repo.url}" is not the normalised form npm stores (git+https://host/owner/repo.git)`,
  );
  const repoName = repo.url.replace(/\.git$/, '').split('/').pop();
  if (repoName !== pkg.name) {
    assert.ok(
      repo.directory,
      `repository.url points at "${repoName}" but the package is "${pkg.name}", so this is a monorepo `
      + 'and `repository.directory` must say where inside it the package lives',
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Nothing ships that should not
// ───────────────────────────────────────────────────────────────────────────

/** Everything npm would copy, walked from the allowlist itself. */
function shippedPaths() {
  const out = [];
  const walk = (rel) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const child of readdirSync(abs)) walk(`${rel}/${child}`);
    } else out.push(rel);
  };
  for (const entry of pkg.files) walk(entry.replace(/\/$/, ''));
  for (const always of ['README.md', 'LICENSE', 'package.json']) walk(always);
  return out;
}

test('⚠️⚠️ no secret, scratch file or build artefact is inside the published set', () => {
  /**
   * ⚠️ THE RISK IS REAL AND IT IS SITTING IN THE REPO ROOT RIGHT NOW: this
   * directory contains `.env.local`, plus a dozen scratch captures
   * (`f.err`, `h.out`, `ws5.out`, …) left by earlier shakedown runs. None of
   * them ship today — the `files` allowlist names directories, and npm adds
   * only README/LICENSE/package.json from the root — so the ONLY thing standing
   * between `.env.local` and the public registry is that nobody has widened the
   * allowlist. That is one careless line away, and an unpublish does not
   * un-leak a key.
   *
   * ⭐ Asserted against a walk of what npm would actually copy rather than
   * against the `files` strings, because the danger is a file appearing inside
   * an already-shipped directory — `lib/.env`, `test/fixtures/token.json` —
   * where no change to `files` is needed at all.
   */
  const DANGEROUS = [
    { rx: /(^|\/)\.env(\.|$)/i, why: 'an env file — credentials' },
    { rx: /\.(pem|key|p12|pfx)$/i, why: 'a private key' },
    { rx: /(^|\/)\.npmrc$/i, why: 'an .npmrc, which can carry an auth token' },
    { rx: /\.(err|out|log)$/i, why: 'a scratch capture from a debugging run' },
    { rx: /\.(tgz|tar\.gz|zip)$/i, why: 'a build artefact' },
    { rx: /(^|\/)node_modules\//, why: 'a vendored dependency tree' },
    { rx: /(^|\/)\.git\//, why: 'git internals' },
    { rx: /(^|\/)results\//, why: 'benchmark results, which go stale and read as claims' },
  ];
  const all = shippedPaths();
  assert.ok(all.length > 100, `the shipped-file walk found only ${all.length} files — it is not looking at the real tree`);

  const offenders = [];
  for (const rel of all) {
    for (const { rx, why } of DANGEROUS) if (rx.test(rel)) offenders.push(`${rel} — ${why}`);
  }
  assert.deepEqual(offenders, [], `these would be published to the public registry:\n${offenders.join('\n')}`);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. The npm landing page answers the only question a reader has
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ ONE SCREEN, MEASURED IN CHARACTERS, NOT IN LINES. npmjs.com renders the
 * README below a metadata block; a reader who has to scroll to find out what
 * the package is for has already decided. 4,000 characters is roughly what is
 * visible before the first scroll on a laptop and is deliberately generous —
 * the point is to catch the value proposition being moved to the bottom or
 * deleted, not to police prose length.
 */
const README_FIRST_SCREEN = readFileSync(join(ROOT, 'README.md'), 'utf8').slice(0, 4000);

test('⭐⭐ the first screen answers why a Claude Code user would install this', () => {
  /**
   * ── THE DIFFERENTIATOR IS COMMERCIAL, NOT TECHNICAL ────────────────────────
   *
   * Every rival in this class is BYOK: you supply an Anthropic/OpenAI/OpenRouter
   * key and they meter your provider account. The one thing this package has
   * that they structurally cannot is a single account —
   * `DEFAULT_GATEWAY_URL = https://acuvo.xxiautomate.com/api/cli/v1/chat/completions`
   * in `lib/account.mjs`, reached by `acuvo --login`.
   *
   * ⭐ Both strings are asserted because both are CHECKABLE FACTS about the
   * code, not adjectives. `--login` is a real flag; the host is the real
   * default gateway. Prose can be rewritten freely as long as it still tells the
   * reader the two things that are actually true and actually differentiating.
   */
  assert.match(
    README_FIRST_SCREEN,
    /--login/,
    'the first screen of README.md never mentions `acuvo --login` — the one-account, no-BYOK route is the entire reason to install this over Claude Code, and it is not above the fold',
  );
  assert.match(
    README_FIRST_SCREEN,
    /acuvo\.xxiautomate\.com/,
    'the first screen never names the gateway host, so "no BYOK" reads as a slogan rather than a thing the reader can go and check',
  );
});

test('⚠️⚠️ the README quotes no Terminal-Bench score, because there is not one', () => {
  /**
   * ── THERE IS NOTHING TO QUOTE, AND THE TEMPTATION IS PERMANENT ─────────────
   *
   * `bench/terminal-bench/results/` holds **12 run directories** (counted
   * 2026-08-20). Not one `result.json` carries an `accuracy`, `n_resolved` or
   * `resolved_trials` field, and every scored trial came back **0.0**. So any
   * percentage on this page would be a number about our harness — most likely
   * about how the harness failed — presented as a number about the agent.
   *
   * ⚠️ Competitors publish real ones (Claude Code, 89.1% Terminal-Bench), which
   * is exactly why a placeholder gets typed here eventually. This is the guard
   * against that afternoon.
   *
   * ⭐ IT DOES NOT BAN THE WORD. The README is free to say a bench exists, to
   * report the internal 7-task bench in `bench/tasks.mjs` (the "5/7 → 7/7" line
   * is about that, and it is a different artefact), or to say the score is
   * unpublished. What it may not do is put a FIGURE next to Terminal-Bench or
   * SWE-bench — banning discussion would fail correct work, which is worse than
   * having no guard.
   */
  const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const offenders = README.split('\n').filter((line) => (
    /(?:terminal[- ]bench|swe[- ]bench)/i.test(line)
    && /\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*(?:of|\/)\s*\d+\b/i.test(line)
  ));
  assert.deepEqual(
    offenders,
    [],
    'the README puts a figure next to a public benchmark. 12 runs exist and every scored trial was 0.0 — '
    + `there is no number to publish:\n${offenders.join('\n')}`,
  );
});

test('⭐ `engines.node` is declared, so an old Node fails at install and not at runtime', () => {
  /**
   * The CLI uses `node:test`, top-level await and ESM throughout. Without
   * `engines`, Node 18 installs it happily and dies on first run with a syntax
   * error that names none of this.
   */
  assert.ok(pkg.engines?.node, 'package.json declares no `engines.node`');
  const major = Number(/(\d+)/.exec(pkg.engines.node)?.[1]);
  assert.ok(major >= 20, `engines.node is "${pkg.engines.node}"; this code requires Node 20 or newer`);
});
