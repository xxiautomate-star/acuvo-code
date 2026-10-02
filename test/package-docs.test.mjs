/**
 * ── ⭐⭐ THE PACKAGE FACT — FIXTURES ONLY, NO NETWORK, NO KEY, NO CLOCK ───────
 *
 * Every fixture below is the SHAPE of a real response measured against
 * `registry.npmjs.org` on 2026-08-25 (see `lib/package-docs.mjs` for the raw
 * numbers). Nothing here reaches the network: a test whose verdict depends on
 * npm being up is a test that gets deleted the first week it fires in CI.
 *
 * ⚠️ THE EXTRACTOR IS THE RISKIEST PART OF THIS MODULE and gets the most
 * coverage. npm's real name grammar matches ordinary English, so a lazy
 * extractor fires a lookup on almost every search and occasionally prepends a
 * confident, irrelevant fact to an unrelated question. A wrong fact is worse
 * than no fact, because the model repeats it.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  packageDocs,
  packageCandidate,
  formatPackageDocs,
  isPackageNameShaped,
  registryUrl,
  resetPackageDocsState,
  MAX_LOOKUPS_PER_PROCESS,
} from '../lib/package-docs.mjs';

beforeEach(() => resetPackageDocsState());

/* ── fixtures: the exact shape the registry returned on 2026-08-25 ────────── */

const ZOD = JSON.stringify({
  name: 'zod',
  version: '4.4.3',
  description: 'TypeScript-first schema declaration and validation library with static type inference',
  homepage: 'https://zod.dev',
  repository: { type: 'git', url: 'git+https://github.com/colinhacks/zod.git' },
  types: 'index.d.ts',
});

const REQUEST = JSON.stringify({
  name: 'request',
  version: '2.88.2',
  deprecated: 'request has been deprecated, see https://github.com/request/request/issues/3142',
  repository: { type: 'git', url: 'git+https://github.com/request/request.git' },
});

const ok = (body) => async () => ({ status: 200, body });
const status = (code) => async () => ({ status: code, body: '' });

/* ── the fact itself ──────────────────────────────────────────────────────── */

test('⭐ the exact current version comes back, which search cannot reliably give', async () => {
  const r = await packageDocs({ name: 'zod', fetchImpl: ok(ZOD) });
  assert.equal(r.ok, true);
  assert.equal(r.version, '4.4.3');
  assert.equal(r.docsUrl, 'https://zod.dev', 'the canonical docs URL removes the "search and hope" step');
  assert.equal(r.deprecated, null);
});

test('⭐⭐ a maintainer deprecation is surfaced verbatim — the whole point of the module', async () => {
  const r = await packageDocs({ name: 'request', fetchImpl: ok(REQUEST) });
  assert.equal(r.ok, true);
  assert.match(r.deprecated, /has been deprecated/);
});

test('a bare `deprecated: true` is still a deprecation, not a dropped field', async () => {
  const body = JSON.stringify({ name: 'x-old', version: '1.0.0', deprecated: true });
  const r = await packageDocs({ name: 'x-old', fetchImpl: ok(body) });
  assert.match(r.deprecated, /marked this package deprecated/);
});

test('the git+ prefix and .git suffix are stripped so the URL is fetchable as-is', async () => {
  const r = await packageDocs({ name: 'request', fetchImpl: ok(REQUEST) });
  assert.equal(r.repository, 'https://github.com/request/request');
});

test('a string `repository` (old packages) is read too', async () => {
  const body = JSON.stringify({ name: 'old', version: '0.1.0', repository: 'git+https://github.com/a/b.git' });
  const r = await packageDocs({ name: 'old', fetchImpl: ok(body) });
  assert.equal(r.repository, 'https://github.com/a/b');
});

/* ── failure is soft, and every reason is named ───────────────────────────── */

test('⚠️ a 404 is "not a package name", NOT "the library does not exist"', async () => {
  const r = await packageDocs({ name: 'definitely-not-a-real-package-xxi', fetchImpl: status(404) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no package called/);
});

test('⚠️ a registry outage degrades to a reason and never throws', async () => {
  const r = await packageDocs({ name: 'zod', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not be reached/);
});

test('a non-JSON body is a named failure, not a crash', async () => {
  const r = await packageDocs({ name: 'zod', fetchImpl: ok('<html>maintenance</html>') });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not be read/);
});

test('a 200 with no version is refused rather than reported as a fact', async () => {
  const r = await packageDocs({ name: 'zod', fetchImpl: ok(JSON.stringify({ name: 'zod' })) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /without a version/);
});

test('an invalid name never reaches the network at all', async () => {
  let called = false;
  const r = await packageDocs({ name: 'Not A Package', fetchImpl: async () => { called = true; return { status: 200, body: ZOD }; } });
  assert.equal(r.ok, false);
  assert.equal(called, false, 'a name that cannot exist must not cost a request');
});

/* ── budgets ──────────────────────────────────────────────────────────────── */

test('⚠️ the same package twice costs ONE request', async () => {
  let hits = 0;
  const counting = async () => { hits += 1; return { status: 200, body: ZOD }; };
  await packageDocs({ name: 'zod', fetchImpl: counting });
  await packageDocs({ name: 'zod', fetchImpl: counting });
  assert.equal(hits, 1);
});

test('⚠️ the per-run cap refuses with a reason', async () => {
  for (let i = 0; i < MAX_LOOKUPS_PER_PROCESS; i += 1) {
    await packageDocs({ name: `pkg-${i}`, fetchImpl: ok(JSON.stringify({ name: `pkg-${i}`, version: '1.0.0' })) });
  }
  const r = await packageDocs({ name: 'one-too-many', fetchImpl: ok(ZOD) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /which is the cap/);
});

/* ── the URL ──────────────────────────────────────────────────────────────── */

test('⚠️ a scoped name is percent-encoded — a raw slash resolves to a different document', () => {
  assert.equal(registryUrl('@tanstack/react-query'), 'https://registry.npmjs.org/@tanstack%2freact-query/latest');
  assert.equal(registryUrl('zod', '3.23.8'), 'https://registry.npmjs.org/zod/3.23.8');
});

test('name grammar accepts scoped and hyphenated, refuses uppercase and spaces', () => {
  assert.equal(isPackageNameShaped('date-fns'), true);
  assert.equal(isPackageNameShaped('@tanstack/react-query'), true);
  assert.equal(isPackageNameShaped('React'), false);
  assert.equal(isPackageNameShaped('two words'), false);
  assert.equal(isPackageNameShaped('@scope'), false, 'a scope with no name is not a package');
});

/* ── ⚠️ THE EXTRACTOR — where a false positive costs the most ─────────────── */

test('⭐ a scoped name wins outright, wherever it sits in the query', () => {
  assert.equal(packageCandidate('how do I invalidate a query with @tanstack/react-query'), '@tanstack/react-query');
});

test('⭐ a hyphen is structural evidence and beats position', () => {
  // "migrate" and "moment" both precede it; neither is evidence of anything.
  // `date-fns` cannot be an English word, so it wins outright.
  assert.equal(packageCandidate('migrate from moment to date-fns'), 'date-fns');
  assert.equal(packageCandidate('the ts-node loader flag'), 'ts-node');
  assert.equal(packageCandidate('socket.io rooms'), 'socket.io');
});

test('⭐ a bare name is read only when the QUERY names a library concern', () => {
  // "v4" is the marker; without it the same three letters are just a word.
  assert.equal(packageCandidate('zod email validation v4'), 'zod');
  assert.equal(packageCandidate('zod email validation'), null);
  assert.equal(packageCandidate('express api docs'), 'express');
});

test('⚠️⚠️ ordinary prose does NOT trigger a lookup', () => {
  /**
   * Every one of `failing`, `callback`, `email` and `http` is a REAL published
   * npm package, and the first version of the extractor returned each of them.
   * Firing here does not 404 harmlessly — it resolves, and prepends a
   * confident, irrelevant fact in the position reserved for the authoritative
   * line.
   */
  for (const q of [
    'why is this test failing',
    'what does the error mean',
    'how do I use the config option',
    'best practices for naming css variables',
    'add a new component to the app',
    'use ky for http',
    'fix my bug',
  ]) {
    assert.equal(packageCandidate(q), null, `"${q}" must not be read as a package name`);
  }
});

test('⚠️ Capitalised words are prose, not package names', () => {
  assert.equal(packageCandidate('Should I use Promise or callback'), null);
  assert.equal(packageCandidate('which React version has the new API'), null, 'Capitalised even with a marker present');
});

test('⚠️ STRICT IS THE SAFE DIRECTION, and the miss is recorded rather than hidden', () => {
  // No marker, no punctuation: nothing distinguishes this from a prose
  // question, so it gets no lookup. The cost is one un-enriched search.
  assert.equal(packageCandidate('express middleware order'), null);
});

test('an empty or absent query yields no candidate', () => {
  assert.equal(packageCandidate(''), null);
  assert.equal(packageCandidate(undefined), null);
});

/* ── the rendering the model actually reads ───────────────────────────────── */

test('⭐⭐ a deprecation is rendered as an ORDER, not as a note', async () => {
  const doc = await packageDocs({ name: 'request', fetchImpl: ok(REQUEST) });
  const text = formatPackageDocs(doc);
  assert.match(text, /DEPRECATED/);
  assert.match(text, /Do NOT write new code against it/, 'informing a model is not the same as instructing it');
});

test('⚠️ "current on npm" is never presented as "the version this project pins"', async () => {
  const text = formatPackageDocs(await packageDocs({ name: 'zod', fetchImpl: ok(ZOD) }));
  assert.match(text, /4\.4\.3/);
  assert.match(text, /NOT necessarily the one this project pins/, 'this module never sees package.json and must say so');
  assert.match(text, /fetch_url this before coding/, 'a fact with no next action is a fact the model skips');
});

test('a failed lookup renders as nothing at all — silence, not an apology', () => {
  assert.equal(formatPackageDocs({ ok: false, reason: 'x' }), '');
  assert.equal(formatPackageDocs(null), '');
});
