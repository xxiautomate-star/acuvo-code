/**
 * ── ⭐⭐ THE PROMPT'S FIRST BYTES MUST BE THE SAME ON EVERY MACHINE ──────────
 *
 * A prompt cache is worth exactly its length up to the FIRST DIFFERING BYTE.
 * Two properties follow, and this package had written down only one of them:
 *
 *   1. DETERMINISM — the same inputs render the same string. `repo-map.mjs`
 *      designed for this, banned `localeCompare` in a comment ("⚠️ ICU differs
 *      per machine"), and two other modules ignored the ban.
 *   2. STABILITY UNDER OUR OWN EDITS — the agent writes a file and the prompt
 *      diverges LATE rather than early. Nothing designed for this at all, and
 *      the repo map put its two size/mtime-ordered sections AHEAD of the file
 *      listing, so one write reshuffled ~60% of the map.
 *
 * ⚠️ WHY IT IS WORTH A TEST FILE. Both defects are invisible in review, silent
 * at runtime, and paid for on every later call. Measured 2026-08-14 on real
 * runs: the same 4-round task cost $0.002184 at a 46.7% hit rate and $0.000910
 * at 95.8%. Nothing in the output of either run said which one you were getting.
 *
 * ⚠️ IT COSTS $0.00 — every assertion here is about bytes we assemble locally.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { byCodePoint, byCodePointOn } from '../lib/prefix-order.mjs';
import { recall, remember } from '../lib/learned.mjs';
import { discoverSkills } from '../lib/skills.mjs';
import { buildRepoMap } from '../lib/repo-map.mjs';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function tmp(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  made.push(root);
  return root;
}

/** Length of the shared leading byte-run — what a prefix cache actually reuses. */
function sharedPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

// ── 1. THE COMPARATOR ───────────────────────────────────────────────────────

test('⭐⭐ byCodePoint is NOT localeCompare, and the difference is the whole point', () => {
  /**
   * ⚠️ THIS IS THE DISCRIMINATING CASE. Locale collation folds case, so
   * `'alpha'.localeCompare('Zeta') < 0` — 'alpha' first. Code points do not:
   * 'Z' is 0x5A and 'a' is 0x61, so 'Zeta' comes first. If this assertion ever
   * reads the other way round, somebody put ICU back in the prompt path.
   */
  const names = ['alpha', 'Zeta', 'Beta', 'gamma'];
  assert.deepEqual([...names].sort(byCodePoint), ['Beta', 'Zeta', 'alpha', 'gamma']);
  // And that is genuinely different from what the platform's collator does.
  assert.notDeepEqual([...names].sort(byCodePoint), [...names].sort((a, b) => a.localeCompare(b)));
});

test('byCodePointOn reads one field and applies the same rule', () => {
  const rows = [{ name: 'alpha' }, { name: 'Zeta' }];
  assert.deepEqual([...rows].sort(byCodePointOn('name')).map((r) => r.name), ['Zeta', 'alpha']);
});

// ── 2. THE TWO BLOCKS THAT OCCUPY BYTE 0 OF EVERY PROMPT ────────────────────

test('the learned block — the first bytes of every prompt — sorts by code point', () => {
  /**
   * ⚠️ IT USED TO USE `localeCompare`. `recall()` feeds the system-message
   * preamble, so its order decides byte 0 of every request, and `localeCompare`
   * with no locale argument resolves against the runtime's default locale and
   * the Node build's ICU data.
   *
   * ⚠️⚠️ AND I COULD NOT PRODUCE A FAILING CASE FOR THIS ONE — SAY SO RATHER
   * THAN IMPLY OTHERWISE. `slugify` reduces every name to `[a-z0-9-]`, and on
   * this machine's ICU (full, not small) the two comparators agree on every
   * slug-shaped set I probed: `ab-c/abc/ab1`, `a--b/a-b/ab`, `not-e/not1/note`
   * and three more all ordered identically. So the learned change removes a
   * cross-machine HAZARD that no single machine can demonstrate — unlike the
   * skills catalogue below, whose filenames keep their case and where the two
   * comparators visibly disagree. What this test therefore guards is the
   * property the block actually needs: a stable, name-based order, so a future
   * "sort by recency" (the tempting change, and the one the comment above
   * `recall` was written to prevent) goes red.
   */
  const root = tmp('acuvo-learned-');
  for (const name of ['alpha', 'zeta', 'beta']) {
    const r = remember(root, { name, fact: `the fact about ${name}`, why: `measured while testing ${name}` });
    assert.equal(r.ok, true, r.error);
  }
  const got = recall(root);
  assert.equal(got.ok, true);
  const names = got.entries.map((e) => e.name);
  assert.deepEqual(names, ['alpha', 'beta', 'zeta'], `expected a stable name order, got ${names.join(', ')}`);
  assert.deepEqual(names, [...names].sort(byCodePoint));
});

test('⭐⭐ the skills catalogue sorts by code point too', () => {
  const root = tmp('acuvo-skills-');
  mkdirSync(join(root, '.acuvo', 'skills'), { recursive: true });
  for (const name of ['alpha', 'Zeta', 'Beta']) {
    writeFileSync(join(root, '.acuvo', 'skills', `${name}.md`), `---\nname: ${name}\ndescription: does ${name}\n---\n\nbody\n`);
  }
  const d = discoverSkills(root);
  assert.equal(d.ok, true, d.error);
  /**
   * ⚠️ THE ORDER IS DECIDED ON THE FILENAMES, WHICH IS WHERE THE COMPARATOR
   * RUNS — `normalizeSkillName` lowercases afterwards, so asserting on the
   * lowercase names alone would not distinguish the two comparators at all.
   * Code points sort Beta.md, Zeta.md, alpha.md; locale collation sorts
   * alpha.md, Beta.md, Zeta.md. The catalogue therefore reads beta, zeta, alpha.
   */
  const names = d.skills.map((s) => s.name);
  assert.deepEqual(names, ['beta', 'zeta', 'alpha'], `expected code-point order of the FILES, got ${names.join(', ')}`);
});

// ── 3. THE REPO MAP: A WRITE MUST DIVERGE THE PROMPT LATE, NOT EARLY ────────

function mapWorkspace() {
  const root = tmp('acuvo-map-');
  writeFileSync(join(root, 'package.json'), '{"name":"m","version":"1.0.0"}\n');
  // Enough files that FILES is unambiguously the bulk of the map, which is the
  // condition that makes the placement matter on a real repo.
  for (let i = 0; i < 24; i += 1) {
    writeFileSync(join(root, `mod${String(i).padStart(2, '0')}.js`), `export const v${i} = ${i};\n${'// pad\n'.repeat(i + 1)}`);
  }
  return root;
}

test('⭐⭐ LARGEST and RECENTLY CHANGED come AFTER the FILES listing', () => {
  /**
   * ⚠️ THE ORDER IS LOAD-BEARING, NOT COSMETIC. Both sections are ranked by
   * something the AGENT ITSELF CHANGES — byte size and mtime — so one write
   * reshuffles them. Ahead of FILES they moved the prompt a third of the way in;
   * behind it they move it at ~95%. Same information either way.
   */
  const root = mapWorkspace();
  const map = buildRepoMap(root).text;
  const files = map.indexOf('\nFILES');
  const largest = map.indexOf('\nLARGEST');
  const recent = map.indexOf('\nRECENTLY CHANGED');
  assert.ok(files > 0, 'the map must have a FILES section');
  assert.ok(largest > files, `LARGEST (${largest}) must come after FILES (${files})`);
  assert.ok(recent > files, `RECENTLY CHANGED (${recent}) must come after FILES (${files})`);
});

test('⭐⭐ one write moves the map LATE — measured as a shared-prefix share', () => {
  /**
   * ⭐ THE PROPERTY THE PLACEMENT BUYS, stated as the number that is actually
   * billed: how much of the NEXT run's map is byte-identical to this one's. The
   * common case for a CLI is being invoked over and over in one repo, so this is
   * the cache the tool lives or dies on, and it is the one nothing measured.
   */
  const root = mapWorkspace();
  const before = buildRepoMap(root).text;

  // The agent does the most ordinary thing there is: it grows one file. That
  // changes the file's SIZE (reordering LARGEST) and its MTIME (reordering
  // RECENTLY CHANGED) without adding or removing a single path.
  const target = join(root, 'mod05.js');
  writeFileSync(target, `export const v5 = 5;\n${'// pad\n'.repeat(200)}`);
  const now = Date.now() / 1000;
  utimesSync(target, now, now);

  const after_ = buildRepoMap(root).text;
  const diverged = sharedPrefix(before, after_);

  /**
   * ⭐ ASSERTED AS A POSITION, NOT AS A PERCENTAGE, because the percentage is a
   * property of the REPO and the position is a property of the CODE. On this
   * 25-file fixture the whole map is 769 bytes and the two ranked sections are
   * ~190 of them, so surviving the entire listing measures 74.9%; on a repo with
   * hundreds of files the same code measures ~95%. A percentage threshold would
   * therefore encode the fixture, and would go green again the moment somebody
   * added padding files.
   */
  const filesStart = before.indexOf('\nFILES');
  assert.ok(filesStart > 0, 'the map must have a FILES section');
  /**
   * ⚠️ MEASURED AGAINST THE END OF THE FILES LISTING, NOT THE START OF THE
   * RANKED SECTIONS. "diverged after LARGEST begins" is satisfied trivially when
   * LARGEST is moved back to the FRONT — the divergence point moves with it —
   * so that phrasing is a check that cannot fail. The listing surviving WHOLE is
   * the property, and it is only true when the volatile sections are behind it.
   */
  const filesEnd = Math.min(
    ...['\nLARGEST', '\nRECENTLY CHANGED', '\nNOT LISTED']
      .map((h) => before.indexOf(h, filesStart + 1))
      .filter((i) => i > 0)
      .concat([before.length]),
  );
  assert.ok(
    diverged >= filesEnd,
    `one write diverged the map at byte ${diverged}, INSIDE the FILES listing (which ends at ${filesEnd} `
      + `of ${before.length}). A section ordered by size or mtime is in front of the listing again — that `
      + `measured ~33% of the map shared; whole-listing survival measures ${((diverged / before.length) * 100).toFixed(1)}% `
      + 'on this 25-file fixture and ~95% on a real repo.',
  );
});

/**
 * ── ⚠️⚠️ THE TEST ABOVE COVERS AN EDIT. CREATING A FILE COST 99.9%. ─────────
 *
 * The test above is careful to say what it exercises — it grows a file "without
 * adding or removing a single path" — and that case really did measure 99.0% on
 * this repo. The case it does NOT exercise is the one an agent performs most:
 * writing a file that did not exist. MEASURED 2026-08-16 on this repo (346
 * files, a 19,950-byte map), by building the map, creating ONE file, and
 * building it again:
 *
 *     create one new source file   13 of 19,975 bytes survive   0.1%
 *     create one new test file     13 of 19,987 bytes survive   0.1%
 *     EDIT an existing file     19,760 of 19,952 bytes survive  99.0%
 *
 * Thirteen bytes. `REPO MAP — 346 files` became `REPO MAP — 347 files`, and a
 * prefix cache is worth nothing past its first differing byte, so the whole map
 * — every section, including the ~19,000 bytes that did not change — was re-paid
 * at full price. `TESTS\n  test/  190 files` was the same defect 350 bytes later.
 *
 * ⭐ WHY THE PLACEMENT FIX ABOVE COULD NOT CATCH IT. LARGEST and RECENTLY
 * CHANGED were moved behind FILES because they REORDER; the header and the test
 * count do not reorder, they COUNT, and a count is volatile for a different
 * reason. Same cure, different symptom — and the existing test measured only the
 * symptom it was written for.
 */

/** The map's file listing, in the order it renders. */
function filesSection(map) {
  const start = map.indexOf('\nFILES\n');
  assert.ok(start > 0, 'the map must have a FILES section');
  return start;
}

test('⭐⭐ CREATING a file must not move the map at byte 13 — the header carries no count', () => {
  /**
   * ⭐ ASSERTED AS A POSITION, NOT A PERCENTAGE, for the reason the test above
   * already argues: the percentage is a property of the fixture and the position
   * is a property of the code. The property is that everything up to the new
   * file's OWN line survives — divergence at the genuinely new information is
   * correct and unavoidable in a sorted listing; divergence in the preamble is
   * not.
   */
  const root = mapWorkspace();
  const before = buildRepoMap(root).text;

  // A file that sorts LAST, so nothing but its own line and the volatile tail
  // has any reason to move.
  writeFileSync(join(root, 'zz-new.js'), 'export const zz = 1;\n');
  const after_ = buildRepoMap(root).text;

  const diverged = sharedPrefix(before, after_);
  const listingEnd = Math.min(
    ...['\nLARGEST', '\nRECENTLY CHANGED', '\nNOT LISTED', '\nTOTALS']
      .map((h) => before.indexOf(h, filesSection(before) + 1))
      .filter((i) => i > 0)
      .concat([before.length]),
  );
  assert.ok(
    diverged >= listingEnd,
    `creating ONE file diverged the map at byte ${diverged} of ${before.length}, before the FILES listing `
      + `ended at ${listingEnd}. A count that changes when a file appears is back in the preamble — that `
      + `measured 13 bytes shared (0.1%) on a 19,950-byte map. Shared now: `
      + `${((diverged / before.length) * 100).toFixed(1)}%.`,
  );
});

test('⚠️ the count did not vanish — TOTALS states it, behind the listing', () => {
  /**
   * ⚠️⚠️ THE FIX THAT DELETES THE NUMBER IS NOT A FIX, IT IS A REGRESSION WEARING
   * A CACHE WIN. "N files found, M listed" is what makes INCOMPLETE actionable;
   * without it the model is told the map is short and cannot tell by how much.
   * The change is placement, and this is the half that proves nothing was lost.
   */
  const root = mapWorkspace();
  const map = buildRepoMap(root);

  const header = map.text.split('\n')[0];
  assert.match(header, /COMPLETE/, 'the header must still say whether the map is the whole repo');
  assert.ok(!/\d/.test(header), `the header carries a digit again: ${JSON.stringify(header)}`);

  const totals = map.text.indexOf('\nTOTALS');
  assert.ok(totals > 0, 'the counts were dropped rather than moved — INCOMPLETE becomes unactionable');
  assert.ok(totals > filesSection(map.text), 'TOTALS is ahead of the FILES listing, which is where it was');
  assert.ok(
    map.text.slice(totals).includes(String(map.stats.totalFiles)),
    `TOTALS does not state the ${map.stats.totalFiles} files the walk found`,
  );
});

test('⭐⭐ the TESTS section names the directory — its file count is a TOTAL and sits with the totals', () => {
  /**
   * ⚠️ THE SECOND COUNT AHEAD OF THE LISTING, AND IT WOULD HAVE BECOME THE NEW
   * BYTE 13 THE MOMENT THE HEADER WAS FIXED. `test/  190 files` becomes
   * `191 files` when the agent writes one test — which is not an edge case, it
   * is the write→run→read→fix loop doing its job. On this repo that line sits
   * ~350 bytes into a 19,950-byte map, so fixing only the header would have
   * moved "create a test file" from 0.1% shared to 1.8%.
   *
   * ⭐ NOTHING IS LOST: "where are the tests" is answered whole by the directory
   * name, which is the question the section exists for. How BIG the suite is is a
   * total, and the totals are together at the end.
   */
  const root = tmp('acuvo-map-tests-');
  writeFileSync(join(root, 'package.json'), '{"name":"m","version":"1.0.0"}\n');
  mkdirSync(join(root, 'test'), { recursive: true });
  for (let i = 0; i < 12; i += 1) writeFileSync(join(root, 'test', `t${String(i).padStart(2, '0')}.test.js`), 'export const t = 1;\n');
  for (let i = 0; i < 12; i += 1) writeFileSync(join(root, `mod${String(i).padStart(2, '0')}.js`), `export const v${i} = ${i};\n`);

  const before = buildRepoMap(root).text;
  // ⚠️ PROVE THE FIXTURE REACHES THE CODE FIRST. A workspace whose top-level
  // directory is not in TEST_DIR_NAMES renders no TESTS section at all, and this
  // test would then pass while asserting nothing.
  assert.ok(before.includes('\nTESTS\n'), 'the fixture produced no TESTS section, so this test is vacuous');
  const testsBlock = before.slice(before.indexOf('\nTESTS\n'), before.indexOf('\n', before.indexOf('\nTESTS\n') + 8) + 1);
  assert.ok(!/\d/.test(testsBlock), `the TESTS section carries a count again: ${JSON.stringify(testsBlock)}`);
  assert.ok(/test\/\s+\d+ files/.test(before.slice(before.indexOf('\nTOTALS'))), 'the suite size was dropped rather than moved');

  // ⚠️ A NAME THAT SORTS LAST, so the only line with a reason to move is its own.
  writeFileSync(join(root, 'test', 'zz-new.test.js'), 'export const z = 1;\n');
  const diverged = sharedPrefix(before, buildRepoMap(root).text);
  const listingEnd = Math.min(
    ...['\nLARGEST', '\nRECENTLY CHANGED', '\nNOT LISTED', '\nTOTALS']
      .map((h) => before.indexOf(h, filesSection(before) + 1))
      .filter((i) => i > 0)
      .concat([before.length]),
  );
  assert.ok(
    diverged >= listingEnd,
    `writing one TEST file diverged the map at byte ${diverged} of ${before.length}, before the listing `
      + `ended at ${listingEnd} — a per-directory count is ahead of FILES again.`,
  );
});

test('⭐ a TRUNCATED map states BOTH numbers, and still says INCOMPLETE up front', () => {
  const root = tmp('acuvo-map-cut-');
  writeFileSync(join(root, 'package.json'), '{"name":"m","version":"1.0.0"}\n');
  for (let i = 0; i < 300; i += 1) writeFileSync(join(root, `f${String(i).padStart(3, '0')}.js`), 'export const v = 1;\n');
  const map = buildRepoMap(root, {}, { budgetTokens: 300 });
  assert.equal(map.truncated, true, 'the fixture no longer truncates, so it is not testing the truncated header');

  const header = map.text.split('\n')[0];
  assert.match(header, /INCOMPLETE/);
  assert.ok(!/\d/.test(header), `the truncated header carries a digit again: ${JSON.stringify(header)}`);

  const tail = map.text.slice(map.text.indexOf('\nTOTALS'));
  assert.ok(tail.includes(String(map.stats.totalFiles)), 'the total is missing, so "some were omitted" is unactionable');
  assert.ok(tail.includes(String(map.stats.listedFiles)), 'how many WERE listed is missing');
});

// ── 4. THE ONE PART OF THE PREFIX A STRANGER OWNS ──────────────────────────

test('⭐⭐ MCP tool schemas are sorted, so a remote server cannot move our prefix', async () => {
  /**
   * ⚠️ THE ORDER USED TO BE `tools/list`'s. Within one session the connection is
   * made once so it is fixed; across turns of a CONTINUING session each turn
   * reconnects and re-lists, so a server whose list comes out of an unordered
   * map reorders OUR tools array — and the tools array sits AHEAD of the
   * messages in the cached prefix, making that 100% of the prompt rather than a
   * tail. Invisibly, and decided by a third party.
   *
   * `skills.mjs` already sorted its catalogue for precisely this reason and said
   * so in a comment; MCP never inherited the rule.
   */
  const { mcpToolSchemas } = await import('../lib/mcp.mjs');

  const listing = (order) => [
    { ok: true, name: 'zulu', tools: order.map((n) => ({ name: n, description: `does ${n}` })) },
    { ok: true, name: 'alpha', tools: [{ name: 'ping', description: 'ping' }] },
  ];

  const a = mcpToolSchemas(listing(['write', 'read', 'list']));
  // The SAME server, returning the SAME tools in a different order, and the
  // servers themselves swapped — which `Object.entries` can also do to us.
  const b = mcpToolSchemas([...listing(['list', 'write', 'read'])].reverse());

  assert.deepEqual(
    a.map((t) => t.function.name),
    b.map((t) => t.function.name),
    'a remote server reordering its tools/list response changed the bytes we send',
  );
  // And it is code-point order, not the machine's collator.
  const names = a.map((t) => t.function.name);
  assert.deepEqual(names, [...names].sort(byCodePoint));
});
