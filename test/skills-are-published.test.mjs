/**
 * ── ⚠️⚠️ TWENTY SKILLS SHIPPED IN NEITHER DISTRIBUTION ──────────────────────
 *
 * Measured 2026-08-19. `skills/` held 20 authored `.md` files and
 * `package.json`'s `files` array did not list it, so `npm pack` produced a
 * tarball with **zero** of them. An installed CLI ran `discoverAllSkills()` →
 * `{ count: 0 }`, and `lib/tools.mjs` therefore never even offered `read_skill`.
 *
 * ⭐ SILENTLY. There is no SKILLS section in `--doctor`, so the capability was
 * absent with nothing anywhere saying so — which is verbatim the defect
 * `lib/builtin-skills.mjs`'s header was written to end.
 *
 * ⚠️ This is the packaging flavour of the same failure the whole codebase keeps
 * hitting: **built is not shipped**. A skill that exists in the repo and not in
 * the tarball has not shipped, in exactly the way a module nobody imports has
 * not shipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('⭐ the walk finds real skills — one that found none would pass trivially', () => {
  const skills = readdirSync(join(ROOT, 'skills')).filter((f) => f.endsWith('.md'));
  assert.ok(skills.length > 10, `only ${skills.length} skills found on disk — this guard is blind`);
});

test('⚠️⚠️ `skills/` is in the published files list', () => {
  assert.ok(
    pkg.files.includes('skills/'),
    'package.json `files` does not include skills/, so npm pack ships ZERO skills and '
    + 'read_skill is never offered to an installed CLI',
  );
});

test('⭐ every skill on disk is inside a published directory', () => {
  /**
   * Asserted against the DIRECTORIES npm will copy rather than against a count,
   * because a count drifts every time somebody writes a skill and a drifting
   * number gets "fixed" by editing the test.
   */
  const published = pkg.files.filter((f) => f.endsWith('/')).map((f) => f.replace(/\/$/, ''));
  assert.ok(published.includes('skills'), `skills is not among published dirs: ${published.join(', ')}`);
});
