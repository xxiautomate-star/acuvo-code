/**
 * ── THE TEST THAT DID NOT EXIST, WHICH IS WHY THE BUG DID ──────────────────
 *
 * The `.env` loader lived inline in `bin/acuvo.mjs`, so nothing could import it
 * and nothing could assert which filenames it looked for. It looked for `.env`;
 * every file on the machine is `.env.local`. It never fired, and the media half
 * it was written to rescue — `see_page`, `speak`, `transcribe`, `make_document`,
 * `read_document`, `read_table` — stayed dark. Measured: 29 tools offered where
 * 35 were available.
 *
 * ⚠️ EVERY ASSERTION HERE IS ABOUT NAMES AND ORDER, not about behaviour that
 * needs a real environment. The bug was a string.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envFileCandidates, loadEnvFiles, ENV_FILENAMES, MAX_WALK_UP } from '../lib/env-file.mjs';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

function tree(spec) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-env-'));
  made.push(root);
  for (const [rel, body] of Object.entries(spec)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

// ── the regression itself ──────────────────────────────────────────────────

test('.env.local is a filename we look for', () => {
  // ⚠️ THE WHOLE BUG. Without this name the loader is a no-op on every machine
  // that follows the Next.js / Vite / CRA convention, which is most of them.
  assert.ok(ENV_FILENAMES.includes('.env.local'), 'the file everyone actually has');
  assert.ok(ENV_FILENAMES.includes('.env'));
});

test('.env.local outranks .env, and precedence is load ORDER', () => {
  // `process.loadEnvFile` does not overwrite, so first-loaded wins. Reading the
  // list top-down therefore reads highest-precedence first — easy to get
  // backwards, which would let a committed .env beat a private .env.local.
  assert.ok(
    ENV_FILENAMES.indexOf('.env.local') < ENV_FILENAMES.indexOf('.env'),
    '.env.local must be loaded first to win',
  );

  const root = tree({ '.env': 'A=from-env\n', '.env.local': 'A=from-local\n' });
  const seen = [];
  loadEnvFiles([root], { load: (f) => seen.push(f) });
  assert.match(seen[0], /\.env\.local$/, 'the local file is offered to the loader first');
});

test('.env.example is never loaded', () => {
  // ⚠️ It is committed documentation full of placeholders. Loading it sets
  // OPENROUTER_API_KEY to something like "sk-or-v1-..." and produces a 401 that
  // blames the user's real key.
  assert.equal(ENV_FILENAMES.includes('.env.example'), false);

  const root = tree({ '.env.example': 'A=placeholder\n' });
  assert.deepEqual(envFileCandidates(root), []);
});

// ── walking up ─────────────────────────────────────────────────────────────

test('it finds a parent .env.local from a subdirectory', () => {
  const root = tree({ '.env.local': 'A=1\n', 'packages/app/package.json': '{}\n' });
  const found = envFileCandidates(join(root, 'packages', 'app'));
  assert.equal(found.length, 1, 'the monorepo layout: one env file at the top');
  assert.match(found[0], /\.env\.local$/);
});

test('a nearer file outranks a further one', () => {
  const root = tree({ '.env.local': 'A=top\n', 'app/.env.local': 'A=near\n' });
  const found = envFileCandidates(join(root, 'app'));
  assert.equal(found.length, 2);
  assert.match(found[0], /app[\\/]\.env\.local$/, 'nearest first — it wins');
});

test('the walk stops at a repository root but reads that directory first', () => {
  // ⚠️ The repo root is the MOST likely place for the file, so stopping before
  // collecting it would skip the commonest location.
  const root = tree({ '.env.local': 'A=outside\n', 'repo/.git/HEAD': 'ref: x\n', 'repo/.env.local': 'A=inside\n' });
  const found = envFileCandidates(join(root, 'repo'));
  assert.equal(found.length, 1, 'it must not escape the repository');
  assert.match(found[0], /repo[\\/]\.env\.local$/);
});

test('the walk is bounded', () => {
  assert.ok(MAX_WALK_UP >= 4 && MAX_WALK_UP <= 16, 'deep enough for a monorepo, not unbounded');
  const root = tree({ 'a/b/c/d/e/f/g/h/i/j/k/keep.txt': 'x\n' });
  // Nothing to find, but it must terminate rather than walk to the filesystem root.
  assert.deepEqual(envFileCandidates(join(root, 'a/b/c/d/e/f/g/h/i/j/k')), []);
});

// ── never fails the run ────────────────────────────────────────────────────

test('a malformed env file is reported, not thrown', () => {
  const root = tree({ '.env.local': 'this is not valid\n' });
  const r = loadEnvFiles([root], { load: () => { throw new Error('bad syntax'); } });
  assert.equal(r.loaded.length, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /bad syntax/);
});

test('no env file anywhere is the normal case, not an error', () => {
  const root = tree({ 'src/index.js': '\n' });
  const r = loadEnvFiles([join(root, 'src')], { load: () => { throw new Error('must not be called'); } });
  assert.deepEqual(r.loaded, []);
  assert.deepEqual(r.failed, []);
});

test('the same file is never loaded twice', () => {
  // bin passes [root, cwd] and they are usually the SAME directory.
  const root = tree({ '.env.local': 'A=1\n' });
  const seen = [];
  loadEnvFiles([root, root], { load: (f) => seen.push(f) });
  assert.equal(seen.length, 1);
});

test('an absent loader (old node) is a no-op, not a crash', () => {
  /**
   * ⚠️ `{ load: undefined }` WOULD NOT TEST THIS — an explicit undefined
   * re-triggers the default parameter and loads for real. On a Node without
   * `process.loadEnvFile` the default itself evaluates to undefined and the
   * `typeof` guard catches it; `null` is how that state is expressed here.
   * Caught by this test failing, which is the point of writing it.
   */
  const root = tree({ '.env.local': 'A=1\n' });
  const r = loadEnvFiles([root], { load: null });
  assert.deepEqual(r.loaded, []);
  assert.deepEqual(r.failed, []);
});

// ── ⭐⭐ the capability this exists to unlock ───────────────────────────────

test('loading a .env.local with a media secret offers the whole media half', async () => {
  const { toolNamesForRounds } = await import('../lib/tools.mjs');
  const { mediaToolNames } = await import('../lib/media.mjs');
  const bare = { PATH: process.env.PATH };
  const withSecret = { ...bare, ACUVO_MEDIA_SECRET: 'test-secret', RENDER_AUDIT_URL: 'https://example.invalid/render' };

  const root = tree({ 'package.json': '{"name":"x"}\n' });
  const before = toolNamesForRounds(10, { allowRun: true, root, env: bare });
  const after = toolNamesForRounds(10, { allowRun: true, root, env: withSecret });

  /**
   * ⚠️ DERIVED FROM `media.mjs`, NEVER TYPED OUT. The first version of this test
   * listed six names and went red the same day `edit_image` and `expand_image`
   * landed — a test that fails correct work, and the second time in one day that
   * restating another module's strings caused a false failure. Asking the module
   * what its tools are makes the two impossible to drift.
   */
  const expected = mediaToolNames(withSecret);
  assert.ok(expected.length >= 6, `the media half should be substantial, got ${expected.length}`);

  const gained = after.filter((n) => !before.includes(n));

  /**
   * ⚠️ A SUPERSET, NOT AN EQUALITY, AND THE DIFFERENCE IS THE POINT. The same
   * secret also unlocks image tools declared in `image-edit.mjs` (`edit_image`,
   * `expand_image`) — a different module, the same credential. Asserting exact
   * equality against `media.mjs` alone made this test fail the day a sibling
   * module added a capability, which is a check that fails correct work.
   */
  for (const name of expected) {
    assert.ok(gained.includes(name), `${name} should have been unlocked by the secret`);
  }
  assert.ok(gained.length >= expected.length, 'and at least the media half was gained');
  assert.equal(before.some((n) => expected.includes(n)), false, 'none of it is reachable without the secret');
});
