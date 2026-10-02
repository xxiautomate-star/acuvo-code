/**
 * ── ⭐⭐⭐ MCP HAS REACHED ONE BUILD, EVER ───────────────────────────────────
 *
 * Six modules, a 19-entry curated catalogue, sixteen test files — and one server
 * ever connected (`deepwiki`), disconnected four seconds later. The capability
 * was never the missing part. **Nothing has ever suggested a server**, so a
 * person had to know MCP exists, know which server answers their problem, know
 * its npm name, and hand-write JSON before anything happened.
 *
 * This file pins the detector that closes that, and the three rules it must not
 * break: only VERIFIED entries, no tree walk, and it never connects anything.
 *
 * ⚠️ COSTS $0.00 — the filesystem is injected, so none of this touches a disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectServers, detectionNote } from '../lib/mcp-detect.mjs';
import { catalogueEntry, CATALOGUE } from '../lib/mcp-defaults.mjs';

/** An in-memory project. Any path not present simply does not exist. */
function project(files) {
  return {
    exists: (p) => Object.hasOwn(files, p),
    read: (p) => (Object.hasOwn(files, p) ? files[p] : null),
  };
}

const withCatalogue = { entryFor: catalogueEntry };

test('⭐⭐ a Playwright project is offered the playwright server, named by its evidence', () => {
  const found = detectServers(project({ 'playwright.config.ts': 'export default {}' }), withCatalogue);
  const hit = found.find((f) => f.server === 'playwright');
  assert.ok(hit, `nothing detected. Found: ${JSON.stringify(found)}`);
  assert.match(hit.evidence, /playwright\.config\.ts/, 'the evidence must be the fact, not a category guess');
});

test('⭐⭐ a dependency is evidence too — not just a config file', () => {
  const found = detectServers(project({
    'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1.40.0' } }),
  }), withCatalogue);
  assert.ok(found.some((f) => f.server === 'playwright'));
});

test('⭐⭐⭐ a database project is pointed at dbhub — NEVER at the inert `postgres` entry', () => {
  /**
   * ⚠️ THE RULE THAT MAKES THIS SAFE. `postgres` is `verified: false` and is
   * INERT — it can never be enabled — so suggesting it would send a person to a
   * door that does not open. `dbhub` is verified and speaks Postgres.
   */
  const found = detectServers(project({
    'package.json': JSON.stringify({ dependencies: { pg: '^8.11.0' } }),
  }), withCatalogue);
  assert.ok(found.some((f) => f.server === 'dbhub'), 'a Postgres project got no database server');
  assert.ok(!found.some((f) => f.server === 'postgres'), 'suggested the INERT postgres entry');
});

test('⚠️ an unverified entry can never be suggested, whatever the evidence says', () => {
  /**
   * Asserted against the REAL catalogue rather than a copy, so the rule cannot
   * drift when an entry is verified or un-verified later.
   */
  const inert = new Set(CATALOGUE.filter((e) => e.verified !== true).map((e) => e.name));
  assert.ok(inert.size > 0, 'precondition: the catalogue must actually contain an inert entry');
  const found = detectServers(project({
    'package.json': JSON.stringify({ dependencies: { pg: '1', puppeteer: '1', svelte: '1', astro: '1' } }),
    'wrangler.toml': 'name = "x"',
    'serverless.yml': 'service: x',
  }), withCatalogue);
  for (const f of found) assert.ok(!inert.has(f.server), `${f.server} is inert and was suggested anyway`);
});

test('⚠️⚠️ a docker-compose with no database in it is NOT evidence of a database', () => {
  /**
   * Without the content check this would suggest `dbhub` to every project that
   * has ever containerised anything — a suggestion that is wrong most of the
   * time is a suggestion people learn to skip.
   */
  const nope = detectServers(project({ 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' }), withCatalogue);
  assert.equal(nope.some((f) => f.server === 'dbhub'), false, 'an nginx compose file was read as a database');

  const yes = detectServers(project({ 'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n' }), withCatalogue);
  assert.ok(yes.some((f) => f.server === 'dbhub'), 'a postgres compose file is real evidence and was missed');
});

test('⚠️ a connection string is named by its KEY and never by its value', () => {
  /**
   * The sentence is printed to a terminal and may be pasted into an issue. A
   * `DATABASE_URL` value is a credential.
   */
  const secret = 'postgres://admin:hunter2@db.example.com:5432/prod';
  const found = detectServers(project({ '.env': `DATABASE_URL=${secret}\n` }), withCatalogue);
  const hit = found.find((f) => f.server === 'dbhub');
  assert.ok(hit, 'a DATABASE_URL is evidence of a database and was missed');
  assert.ok(hit.evidence.includes('DATABASE_URL'), 'the key must be named');
  assert.ok(!hit.evidence.includes('hunter2'), 'the credential leaked into the suggestion');
  assert.ok(!JSON.stringify(found).includes('hunter2'), 'the credential leaked anywhere at all');
});

test('⚠️ a server that is already configured is never suggested again', () => {
  const io = project({ 'playwright.config.ts': 'export default {}' });
  assert.ok(detectServers(io, withCatalogue).some((f) => f.server === 'playwright'));
  const after = detectServers(io, { ...withCatalogue, already: ['playwright'] });
  assert.equal(after.some((f) => f.server === 'playwright'), false, 'nagged about a server the person already added');
});

test('⭐ an empty project says nothing at all', () => {
  assert.deepEqual(detectServers(project({}), withCatalogue), []);
  assert.equal(detectionNote([]), null, 'an empty suggestion must not print an empty heading');
});

test('⚠️ unreadable and malformed files are simply no evidence — never a crash', () => {
  const hostile = {
    exists: () => true,
    read: (p) => { if (p === 'package.json') return '{ not json at all'; throw new Error('EIO'); },
  };
  assert.doesNotThrow(() => detectServers(hostile, withCatalogue));
  assert.doesNotThrow(() => detectServers({}, withCatalogue), 'an executor with no methods must not throw');
  assert.doesNotThrow(() => detectServers(null, withCatalogue));
});

test('⚠️ NO TREE WALK — package.json is read ONCE, however many signals ask for it', () => {
  /**
   * ⭐ THE COST BOUND, ASSERTED BY COUNTING READS rather than by reading the
   * code. Eight signals each asking for the manifest is eight reads of the same
   * file on every session start, and a recursive scan would be far worse — a tax
   * paid by every run, including the overwhelming majority with nothing to find.
   */
  const reads = [];
  const io = {
    exists: () => false,
    read: (p) => { reads.push(p); return p === 'package.json' ? '{"dependencies":{}}' : null; },
  };
  detectServers(io, withCatalogue);
  assert.equal(reads.filter((p) => p === 'package.json').length, 1, `package.json was read ${reads.filter((p) => p === 'package.json').length} times`);
  assert.ok(reads.length <= 6, `${reads.length} reads on an empty project — this runs on every session start`);
});

test('⭐ the note names one command, and says nothing runs until you type it', () => {
  const note = detectionNote([
    { server: 'dbhub', why: 'run SQL', evidence: 'package.json depends on pg' },
    { server: 'playwright', why: 'drive a browser', evidence: 'playwright.config.ts is in this project' },
    { server: 'astro', why: 'docs', evidence: 'astro.config.mjs is in this project' },
  ]);
  assert.match(note, /acuvo mcp add dbhub/, 'a suggestion with no command is a suggestion nobody acts on');
  assert.match(note, /Nothing runs until you do/i, 'consent must be stated where the offer is made');
  // ⚠️ Capped at two, with the remainder counted rather than hidden.
  assert.ok(note.includes('dbhub') && note.includes('playwright'));
  assert.ok(!note.includes('astro'), 'a wall of suggestions is ignored exactly like an empty one');
  assert.match(note, /1 more/);
});

/**
 * ── ⭐⭐⭐ THE SHAPE SEAM — WHERE THE `already` RULE ACTUALLY BROKE ──────────
 *
 * Every `already` test above passes a hand-written `['playwright']` and proves
 * the rule works. It worked. The CALLER never satisfied it:
 *
 *     bin/acuvo.mjs:  Object.keys(readMcpConfig(root)?.servers ?? {})
 *
 * `readMcpConfig().servers` is an ARRAY of `{name, …}` objects, so `Object.keys`
 * returns INDICES. Measured on a real one-server config: `["0"]`. `already` was
 * therefore always effectively empty, and a server the user had ALREADY ADDED
 * was suggested again on every run — reproduced end to end on 2026-08-29 with
 * `acuvo mcp add convex` followed by a run that recommended convex.
 *
 * ⚠️ NEITHER SIDE'S TESTS COULD SEE IT. That is the whole lesson: a unit test on
 * each side of a seam proves nothing about the seam. This test writes a REAL
 * config, reads it with the REAL `readMcpConfig`, and asserts on the result —
 * so a change to the config shape breaks it here rather than in a user's
 * terminal.
 */
import { readMcpConfig } from '../lib/mcp.mjs';
import { configuredServerNames } from '../lib/mcp-detect.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { after as afterAll } from 'node:test';

const _seamDirs = [];
afterAll(() => { for (const d of _seamDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function realConfigRoot(servers) {
  const root = mkdtempSync(pathJoin(osTmpdir(), 'acuvo-seam-'));
  _seamDirs.push(root);
  mkdirSync(pathJoin(root, '.acuvo'), { recursive: true });
  writeFileSync(pathJoin(root, '.acuvo', 'mcp.json'), JSON.stringify({ mcpServers: servers }));
  return root;
}

test('⭐⭐⭐ THE SEAM: a configured server is never suggested again', () => {
  const root = realConfigRoot({
    convex: { type: 'http', url: 'https://mcp.convex.dev/mcp' },
    playwright: { command: 'npx', args: ['@playwright/mcp'] },
  });
  const cfg = readMcpConfig(root);
  assert.equal(cfg.ok, true, `the fixture config was rejected: ${cfg.error}`);

  /**
   * ⚠️ THE BUG ITSELF, PINNED. If `servers` ever becomes a name-keyed object
   * this assertion goes red and whoever changed it is told that a caller once
   * assumed exactly that and shipped the wrong thing for it.
   */
  assert.ok(Array.isArray(cfg.servers), 'servers is no longer an array — re-check every caller that indexes it');
  assert.deepEqual(
    Object.keys(cfg.servers), ['0', '1'],
    'this is what the old bin/acuvo.mjs line produced: array INDICES, never names',
  );

  assert.deepEqual(
    configuredServerNames(cfg).sort(), ['convex', 'playwright'],
    'the names the detector must skip could not be recovered from a real config',
  );

  // And the rule it feeds actually fires end to end.
  const io = project({ 'playwright.config.ts': 'export default {}' });
  assert.ok(
    detectServers(io, withCatalogue).some((f) => f.server === 'playwright'),
    'the fixture does not even produce the suggestion this test is about',
  );
  assert.deepEqual(
    detectServers(io, { ...withCatalogue, already: configuredServerNames(cfg) }),
    [],
    'a server named in the workspace config was suggested anyway — this is the shipped bug',
  );
});

test('⚠️ configuredServerNames never throws on the shapes a broken config produces', () => {
  assert.deepEqual(configuredServerNames(null), []);
  assert.deepEqual(configuredServerNames({}), []);
  assert.deepEqual(configuredServerNames({ ok: false, error: 'nope' }), []);
  // ⚠️ The pre-fix shape. If someone "restores" it, it must still be empty, not ['0'].
  assert.deepEqual(configuredServerNames({ servers: { convex: {} } }), []);
  assert.deepEqual(configuredServerNames({ servers: [{}, { name: '' }, { name: 'ok' }] }), ['ok']);
});

// ───────────────────────────────────────────────────────────────────────────
// ⭐⭐⭐ 2026-09-19 — THE TWO KNOWLEDGE SIGNALS, AND THE ONE THAT MUST STAY QUIET
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ an Azure/.NET project is offered mslearn — it had no signal at all for 25 days', () => {
  const byDep = detectServers(project({ 'package.json': JSON.stringify({ dependencies: { '@azure/functions': '^4.0.0' } }) }), withCatalogue);
  assert.ok(byDep.some((f) => f.server === 'mslearn'), `nothing detected: ${JSON.stringify(byDep)}`);

  const bySdk = detectServers(project({ 'global.json': '{ "sdk": { "version": "8.0.100" } }' }), withCatalogue);
  const hit = bySdk.find((f) => f.server === 'mslearn');
  assert.ok(hit, `a pinned .NET SDK is not evidence of a Microsoft stack? ${JSON.stringify(bySdk)}`);
  /**
   * ⚠️ THE EVIDENCE MUST NAME WHAT ACTUALLY MATCHED. This used to print the
   * FIRST alternative of the regex regardless — "global.json mentions
   * extensionBundle" for a file containing no such string. An evidence line
   * that is checkable and false is worse than a category.
   */
  assert.match(hit.evidence, /"sdk"/, `the evidence names a string that is not in the file: ${hit.evidence}`);
});

test('⚠️ Azure DevOps CI alone is NOT evidence of a Microsoft stack', () => {
  // A JavaScript shop can run its pipeline on Azure DevOps and never write .NET.
  // `azure-pipelines.yml` was weighed and deliberately left out of the signal.
  const found = detectServers(project({
    'azure-pipelines.yml': 'trigger: [main]',
    'package.json': JSON.stringify({ dependencies: { react: '^18.3.1' } }),
  }), withCatalogue);
  assert.ok(!found.some((f) => f.server === 'mslearn'), 'mslearn fired on a React project with a CI file');
});

test('⭐⭐⭐ a project with dependencies is offered `docs` — 3 of 9 real repos were told NOTHING', () => {
  const found = detectServers(project({ 'package.json': JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }) }), withCatalogue);
  const hit = found.find((f) => f.server === 'docs');
  assert.ok(hit, `the single biggest quality lever is still suggested to nobody: ${JSON.stringify(found)}`);
  // ⚠️ The COUNT is the evidence — a fact the reader can check in the file they
  //    already have open, not the category "you have dependencies".
  assert.match(hit.evidence, /declares 2 dependencies/);
});

test('⚠️ …and it stays SILENT on a project that declares none — the evidence would be false', () => {
  // `acuvo-code` itself declares zero dependencies. A documentation server
  // suggested to a project with nothing to document is the noise this module
  // exists to avoid.
  for (const files of [{}, { 'package.json': '{}' }, { 'package.json': 'not json' }]) {
    const found = detectServers(project(files), withCatalogue);
    assert.ok(!found.some((f) => f.server === 'docs'), `docs fired with no dependencies: ${JSON.stringify(files)}`);
  }
});

test('⭐ `docs` is LAST, so a project with a real stack signal still hears about its stack first', () => {
  /**
   * `detectionNote` shows the FIRST TWO. If the universal signal drifted up the
   * array it would crowd out the specific ones on every project that has any —
   * which is how a suggestion line stops being read.
   */
  const found = detectServers(project({
    'playwright.config.ts': 'export default {}',
    'package.json': JSON.stringify({ dependencies: { playwright: '^1', convex: '^1' } }),
  }), withCatalogue);
  assert.equal(found.at(-1).server, 'docs', `order: ${found.map((f) => f.server).join(', ')}`);
  const note = detectionNote(found);
  assert.ok(!note.split('Add one with')[0].includes('· docs'), 'the universal signal took a slot from a specific one');
});
