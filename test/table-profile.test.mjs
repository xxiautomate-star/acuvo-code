import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_NAMES, toolNamesForRounds, toolSchemasFor, executeToolCall } from '../lib/tools.mjs';
import { shortlistTools, TOOL_GROUPS } from '../lib/tool-shortlist.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { readWindow } from '../lib/read-window.mjs';
import {
  profileTable, guessDelimiter, tableProfileToolSchemas, tableEvidence, resetTableEvidenceCache,
  MAX_DISTINCT_TRACKED, MAX_HEAD_ROWS, CHUNK_BYTES, TABULAR_EXTENSIONS,
} from '../lib/table-profile.mjs';
import { Parser } from '../lib/vendor/csv-parser.mjs';

/**
 * ── ⭐⭐ WHY THIS VERB EXISTS, IN NUMBERS FROM OUR OWN RUNS ──────────────────
 *
 * `bench/terminal-bench/results/` — 139 real runs, every `error` string in every
 * `acuvo-result.json` tallied 2026-08-29. After `absolute path` (22, already
 * fixed in workspace.mjs) the next class is the read ceiling, and EVERY hit is a
 * data file: `bn_sample_10k.csv` 844,949 B refused eight times, `input.csv`
 * 51,066,691 B and `expected.csv` 38,066,688 B refused past the 8 MB window with
 * *"no tool here opens a file that large"* — a sentence the model read back in
 * the next round before falling out to `head -c 2000`, which a shell-less
 * install does not have.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-table-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return root;
}

const write = (root, name, text) => { writeFileSync(join(root, name), text); return name; };

/* ════════════════════════════════════════════════════════════════════════════
 * 1. THE VENDORED PARSER IS FAITHFUL — upstream's own fixtures, not ours.
 *
 * ⚠️ THIS IS THE TEST THAT ALREADY EARNED ITS KEEP. The first cut of
 * `vendor/csv-parser.mjs` passed 59 of these 63 and threw `ReferenceError:
 * stripBom is not defined` on the other four — the helper is referenced ONCE,
 * inside the duplicate-header rename branch, so every ordinary CSV worked and
 * the failure waited for a file whose header repeats a name. Reading the cut did
 * not find it. Running upstream's fixtures did.
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ the vendored PapaParse core reproduces all 63 upstream CORE_PARSER_TESTS', () => {
  const cases = JSON.parse(readFileSync(join(HERE, 'fixtures', 'papaparse-5.7.0-core-parser-cases.json'), 'utf8'));
  assert.equal(cases.length, 63, 'the upstream fixture set changed size — re-cut it from the tarball, do not edit it');

  const failures = [];
  for (const c of cases) {
    let got;
    try { got = new Parser(c.config).parse(c.input); } catch (e) { got = { threw: String(e && e.message) }; }
    if (JSON.stringify(got) !== JSON.stringify(c.expected)) failures.push(c.description);
  }
  assert.deepEqual(failures, [], `vendored parser diverges from papaparse 5.7.0 on: ${failures.join(' · ')}`);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. REACHABILITY — declared, offered, dispatched, classified. Any one missing
 *    and the capability does not exist for a model.
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ profile_table is declared, OFFERED and dispatched — all three', async (t) => {
  assert.ok(TOOL_NAMES.includes('profile_table'), 'profile_table is not in TOOL_SCHEMAS');

  const root = workspace(t);
  write(root, 'd.csv', 'a,b\n1,2\n');
  resetTableEvidenceCache();
  const offered = toolNamesForRounds(16, { allowRun: true, root });
  assert.ok(offered.includes('profile_table'), 'declared but never offered — a dead schema');

  /**
   * ⚠️ NOT GATED ON `allowRun`. It spawns nothing; withholding it under
   * `--no-run` would remove the only large-data reader from exactly the surface
   * with no `head -5` to fall back to.
   */
  const noRun = toolNamesForRounds(16, { allowRun: false, root });
  assert.ok(noRun.includes('profile_table'), 'profile_table must survive --no-run: it reads, it does not execute');

  const executor = createLocalExecutor(root);
  const out = await executeToolCall(
    { id: 'c1', function: { name: 'profile_table', arguments: JSON.stringify({ path: 'd.csv' }) } },
    executor,
  );
  assert.equal(out.result.ok, true, `dispatcher did not reach the verb: ${JSON.stringify(out.result)}`);
  assert.equal(out.result.rows, 1);
  assert.equal(out.mutated, false, 'a read verb must never report a mutation');
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2b. THE TWO GATES — one asks "is there data HERE", the other "is this brief
 *     ABOUT data". Neither replaces the other, and the byte cost is measured.
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ the offer is gated on EVIDENCE, and the ceiling is why', async (t) => {
  const code = workspace(t);
  writeFileSync(join(code, 'index.js'), 'console.log(1);');
  resetTableEvidenceCache();
  assert.equal(tableEvidence(code), false, 'a plain JS project claims table evidence');
  assert.ok(
    !toolNamesForRounds(16, { allowRun: true, root: code, env: {} }).includes('profile_table'),
    'offered where there is no delimited file to point it at',
  );

  const data = workspace(t);
  writeFileSync(join(data, 'index.js'), 'console.log(1);');
  mkdirSync(join(data, 'data'));
  writeFileSync(join(data, 'data', 'sales.csv'), 'a,b\n1,2\n');
  resetTableEvidenceCache();
  assert.equal(tableEvidence(data), true, 'data/ one level down is how real repositories are shaped');
  const on = toolNamesForRounds(16, { allowRun: true, root: data, env: {} });
  assert.ok(on.includes('profile_table'), 'missing where it applies');

  /**
   * ⭐ THE MEASURED PRICE OF THE GATE. The ceiling in
   * `declared-tools-are-named.test.mjs` is 60,000 B on the raw 16-round offer;
   * without this gate the verb's 962 bytes crossed it on every project in the
   * world, including one with no data file at all.
   */
  const off = toolNamesForRounds(16, { allowRun: true, root: code, env: {} });
  const cost = JSON.stringify(toolSchemasFor(on)).length - JSON.stringify(toolSchemasFor(off)).length;
  assert.ok(cost > 900 && cost < 1100, `expected ~962 B for the verb, measured ${cost}`);

  /** ⚠️ Single-shot turns offer no reads — a profile with no round after it has
   *  nowhere to go, the rule read_lines already follows. */
  assert.ok(!toolNamesForRounds(1, { allowRun: true, root: data, env: {} }).includes('profile_table'));
});

test('⭐ the extension set workspace.mjs points at is the one this module publishes', async (t) => {
  /**
   * ⚠️ DRIVEN, NOT RESTATED. `workspace.mjs` cannot import `TABULAR_EXTENSIONS`
   * (this module imports IT — the cycle is argued at that line), so the only
   * honest guard is to run the real refusal for every extension in the set and
   * for a control that must NOT be in it.
   */
  const root = workspace(t);
  const executor = createLocalExecutor(root);
  const big = `a,b,c\n${'1,2,3\n'.repeat(40000)}`;
  for (const ext of TABULAR_EXTENSIONS) {
    write(root, `sample${ext}`, big);
    const r = executor.readFile(`sample${ext}`);
    assert.equal(r.ok, false);
    assert.match(r.error, /profile_table/, `${ext} is in TABULAR_EXTENSIONS but workspace.mjs does not name the verb for it`);
  }
  for (const ext of ['.map', '.gcode', '.log', '.js']) {
    write(root, `sample${ext}`, big);
    const r = executor.readFile(`sample${ext}`);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error, /profile_table/, `${ext} is not delimited data and must not be sent to a table reader`);
  }
});

test('⭐ profile_table is CLASSIFIED, so an unsignalled brief pays nothing for it', async (t) => {
  const inAGroup = Object.values(TOOL_GROUPS).some((g) => g.tools.includes('profile_table'));
  assert.ok(inAGroup, 'unclassified verbs ride along on "hi" forever — see tool-shortlist.mjs');

  const root = workspace(t);
  write(root, 'data.csv', 'a,b\n1,2\n');
  resetTableEvidenceCache();
  const offer = toolNamesForRounds(16, { allowRun: true, root });
  assert.ok(offer.includes('profile_table'), 'the shortlist can only narrow what the offer contains');

  const bytes = (brief) => JSON.stringify(toolSchemasFor(shortlistTools(brief, offer))).length;
  const bytesWithout = (brief) => JSON.stringify(
    toolSchemasFor(shortlistTools(brief, offer).filter((n) => n !== 'profile_table')),
  ).length;

  for (const quiet of ['hi', 'fix the typo in the header', 'deploy the site']) {
    assert.equal(bytes(quiet) - bytesWithout(quiet), 0, `"${quiet}" paid for profile_table`);
  }

  /**
   * ⭐ AND IT IS OFFERED ON THE BRIEFS THAT WERE ACTUALLY REFUSED. Both bench
   * families name the file in the instruction, so the word `csv` — already in
   * the `docs` group — is what reaches it.
   */
  for (const loud of [
    'recover the DAG from bn_sample_10k.csv',
    'transform /app/input.csv to match /app/expected.csv exactly',
    'summarise this dataset for me',
  ]) {
    assert.ok(shortlistTools(loud, offer).includes('profile_table'), `"${loud}" was not offered profile_table`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. THE REFUSALS THAT SENT MODELS TO THE SHELL NOW NAME THE VERB.
 *
 * ⚠️ ASSERTED THROUGH THE REAL REFUSAL PATHS, not by restating the strings —
 * a copy of the sentence here would pass while the two drifted apart.
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ the over-limit refusals name profile_table for a data file — and only for one', async (t) => {
  const root = workspace(t);
  const executor = createLocalExecutor(root);

  // 844,949 B was the real one; anything over MAX_READ_BYTES exercises the branch.
  write(root, 'huge.csv', `a,b,c\n${'1,2,3\n'.repeat(40000)}`);
  write(root, 'huge.map', `${'  0x0001 symbol_name_here\n'.repeat(9000)}`);

  const csv = executor.readFile('huge.csv');
  assert.equal(csv.ok, false);
  assert.match(csv.error, /profile_table/, 'the read_file ceiling still sends a CSV to read_lines only');
  assert.match(csv.error, /read_lines/, 'the existing next move must survive — this is an append, not a rewrite');

  const map = executor.readFile('huge.map');
  assert.equal(map.ok, false);
  assert.doesNotMatch(map.error, /profile_table/, 'a linker map is not a table — two of the recorded hits were exactly this');

  /**
   * ⚠️ THE 8 MB WINDOW REFUSAL IS THE ONE THAT SAID *"no tool here opens a file
   * that large"*. That claim is now false, and a description that denies a
   * capability IS the capability not existing.
   */
  const big = join(root, 'big.csv');
  writeFileSync(big, `a,b\n${'1,2\n'.repeat(2_200_000)}`); // > 8 MB
  const win = readWindow(root, { path: 'big.csv', offset: 1, limit: 5 }, 'read_lines');
  assert.equal(win.ok, false);
  assert.doesNotMatch(win.error, /no tool here opens a file that large/, 'the stale claim is back');
  assert.match(win.error, /profile_table/, 'the 8 MB wall must name the verb that has no wall');

  // …and the verb it names actually answers.
  const p = profileTable(root, { path: 'big.csv' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.rows, 2_200_000);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. THE ANSWER IS CORRECT ON THE SHAPES THAT BREAK NAIVE SPLITTERS.
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ a quoted field containing the delimiter, a doubled quote AND a newline', async (t) => {
  const root = workspace(t);
  write(root, 'tricky.csv', 'id;note;price\n1;"line one\nline two";3.50\n2;"he said ""hi"", then left";12\n3;;NA\n');

  const r = profileTable(root, { path: 'tricky.csv' });
  assert.equal(r.ok, true);
  /**
   * ⚠️ THE ROW COUNT IS THE ASSERTION THAT BITES. A line-oriented splitter sees
   * five lines here and reports four data rows; there are three.
   */
  assert.equal(r.rows, 3);
  assert.equal(r.columnCount, 3);
  assert.equal(r.delimiter, ';', 'consistency-based detection, not comma-counting — the note field contains a comma');
  assert.equal(r.delimiterDetected, true);

  const [id, note, price] = r.columns;
  assert.equal(id.type, 'integer');
  assert.equal(note.type, 'text');
  assert.equal(note.missing, 1, 'an empty cell is missing, not a category');
  assert.equal(price.type, 'number');
  assert.equal(price.missing, 1, '"NA" is missing — every ecosystem writes it and none means it as a value');
  assert.equal(price.min, 3.5);
  assert.equal(price.max, 12);
  assert.deepEqual(r.head[0], ['1', 'line one\nline two', '3.50'], 'the embedded newline survives inside its field');
});

test('⭐ header, headerless, and the type/cardinality answer the bench runs spent two rounds getting', async (t) => {
  const root = workspace(t);
  // A replica of bn_sample_10k.csv: five binary columns, 10,000 rows.
  let csv = 'U,Y,R,D,M\n';
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 10000; i++) csv += [0, 0, 0, 0, 0].map(() => (rnd() < 0.5 ? 0 : 1)).join(',') + '\n';
  write(root, 'bn.csv', csv);

  const r = profileTable(root, { path: 'bn.csv' });
  assert.equal(r.rows, 10000, 'a trailing newline is not a row');
  assert.deepEqual(r.columns.map((c) => c.name), ['U', 'Y', 'R', 'D', 'M']);
  for (const c of r.columns) {
    assert.equal(c.type, 'integer');
    assert.equal(c.distinct, 2, 'BINARY is the fact the task needed and head -5 only implies');
    assert.equal(c.min, 0);
    assert.equal(c.max, 1);
    assert.equal(c.absentInSomeRows, undefined, 'a phantom row would surface here');
  }

  write(root, 'plain.tsv', 'a\t1\tx\nb\t2\ty\nc\t3\tz\n');
  const h = profileTable(root, { path: 'plain.tsv', header: false });
  assert.equal(h.rows, 3);
  assert.equal(h.header, false);
  assert.equal(h.delimiter, '\t');
  assert.deepEqual(h.columns.map((c) => c.name), ['column_1', 'column_2', 'column_3']);

  const withHeader = profileTable(root, { path: 'plain.tsv' });
  assert.equal(withHeader.rows, 2, 'header:true consumes the first row');

  /**
   * ⚠️ A BYTE-ORDER MARK IS A COLUMN NAME NOBODY CAN MATCH. Excel writes one on
   * every CSV it exports, and a header of `"﻿id"` silently fails every
   * lookup a model then writes against it.
   *
   * ⚠️ AND THIS ASSERTION EXISTS BECAUSE A MUTATION FOUND A HOLE, not because
   * the case was imagined. Neutering the vendored `stripBom` left the 63
   * upstream fixtures GREEN — an equivalent mutant, because none of them starts
   * with a BOM and this module never passes `header` to the Parser. What
   * actually strips it here is the `.trim()` on the header row, which is
   * incidental and would vanish with an innocuous refactor.
   */
  write(root, 'bom.csv', '﻿id,name\n1,x\n2,y\n');
  const bom = profileTable(root, { path: 'bom.csv' });
  assert.deepEqual(bom.columns.map((c) => c.name), ['id', 'name'], 'the BOM survived into a column name');
  assert.equal(bom.rows, 2);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. THE CHUNK BOUNDARY — the bug that does not throw, it lies.
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐⭐ rows spanning a chunk boundary are framed once, not twice', async (t) => {
  const root = workspace(t);
  /**
   * ⚠️ EVERY ROW CARRIES A QUOTED NEWLINE, so a line-oriented resume cannot
   * work and only the parser knows where a row ends. Sized to cross many
   * `CHUNK_BYTES` boundaries.
   *
   * ⚠️ THIS IS THE REGRESSION FOR A REAL, MEASURED DEFECT. Resuming from
   * `parser.getCharIndex()` — the obvious call, and the wrong one — reported
   * **700,095 rows for a 700,000-row file** and shifted the columns so a text
   * column came back with a numeric min and max. `meta.cursor` is the resume
   * upstream's own ChunkStreamer uses. Neither version throws.
   */
  const ROWS = 30000;
  let csv = 'id,name,score,note\n';
  for (let i = 1; i <= ROWS; i++) {
    csv += `${i},user${i % 50},${(i * 37) % 1000 / 10},"a note, with a comma\nand a newline ${i}"\n`;
  }
  write(root, 'span.csv', csv);
  assert.ok(Buffer.byteLength(csv) > CHUNK_BYTES * 4, 'fixture must cross several chunk boundaries');

  const r = profileTable(root, { path: 'span.csv' });
  assert.equal(r.ok, true);
  assert.equal(r.rows, ROWS, 'phantom rows mean a mis-framed chunk boundary');
  assert.equal(r.columnCount, 4);
  assert.equal(r.raggedRows, undefined, 'a mis-framed row is a ragged row');

  const [id, name, score, note] = r.columns;
  assert.equal(id.type, 'integer');
  assert.equal(id.min, 1);
  assert.equal(id.max, ROWS);
  assert.equal(name.type, 'text');
  assert.equal(name.min, undefined, 'a text column with a numeric min means the columns shifted');
  assert.equal(name.distinct, 50);
  assert.equal(score.type, 'number');
  assert.equal(note.type, 'text');

  /**
   * ⭐ THE COMPRESSION IS THE PRODUCT. The answer's size is set by the COLUMN
   * count, not the row count — which is the whole argument for a summary verb
   * over a bigger read window.
   */
  assert.ok(JSON.stringify(r).length < 1200, `the summary grew with the data: ${JSON.stringify(r).length} B`);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6. THE REFUSALS OF ITS OWN.
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐ profile_table refuses what it cannot honestly answer, and says the next move', async (t) => {
  const root = workspace(t);

  assert.match(profileTable(root, {}).error, /name a path/);
  assert.match(profileTable(root, { path: '/etc/passwd' }).error, /absolute path/i);
  assert.match(profileTable(root, { path: '../escape.csv' }).error, /\.\.|outside|relative/i);
  assert.match(profileTable(root, { path: 'nope.csv' }).error, /^no such file/);

  mkdirSync(join(root, 'adir'));
  assert.match(profileTable(root, { path: 'adir' }).error, /is a directory/);

  write(root, 'empty.csv', '');
  assert.match(profileTable(root, { path: 'empty.csv' }).error, /empty/);

  writeFileSync(join(root, 'blob.csv'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x41]));
  assert.match(profileTable(root, { path: 'blob.csv' }).error, /NUL byte/);

  // Not delimited: every candidate yields one column, so there is no honest profile.
  write(root, 'prose.txt', 'the quick brown fox\njumped over the lazy dog\nand kept going\n');
  const prose = profileTable(root, { path: 'prose.txt' });
  assert.equal(prose.ok, false);
  assert.match(prose.error, /no delimiter/);
  assert.match(prose.error, /read_lines/, 'a refusal without a next move costs a round');

  /**
   * ⚠️ A CREDENTIAL FILE IS REFUSED HERE TOO. A new door into the workspace that
   * does not repeat this rule is a new way to exfiltrate a `.env`.
   */
  write(root, '.env', 'KEY=abc,DEF\nB=2,3\n');
  const env = profileTable(root, { path: '.env' });
  assert.equal(env.ok, false);
  assert.match(env.error, /credential/);
});

test('⭐ the delimiter is chosen by CONSISTENCY, and an explicit one always wins', async (t) => {
  const root = workspace(t);
  // More commas than semicolons, but only the semicolon gives a consistent width.
  const euro = 'a;b;c\n1;"x, y, z";3\n2;"p, q, r, s";4\n3;"m, n";5\n';
  assert.equal(guessDelimiter(euro), ';');

  write(root, 'euro.csv', euro);
  assert.equal(profileTable(root, { path: 'euro.csv' }).delimiter, ';');

  const forced = profileTable(root, { path: 'euro.csv', delimiter: ',' });
  assert.equal(forced.delimiter, ',');
  assert.equal(forced.delimiterDetected, undefined, 'an explicit delimiter is not a detection');
  assert.ok(forced.raggedRows > 0, 'forcing the wrong delimiter should be visible, not silent');
});

test('⭐ cardinality is capped and SAID to be capped, and head_rows is clamped', async (t) => {
  const root = workspace(t);
  let csv = 'id,flag\n';
  for (let i = 0; i < MAX_DISTINCT_TRACKED * 3; i++) csv += `${i},${i % 2 === 0 ? 'yes' : 'no'}\n`;
  write(root, 'wide.csv', csv);

  const r = profileTable(root, { path: 'wide.csv', head_rows: 999 });
  assert.equal(r.columns[0].distinctAtLeast, MAX_DISTINCT_TRACKED, 'a capped count reported as an exact one is a lie');
  assert.equal(r.columns[0].distinct, undefined, 'never both');
  assert.equal(r.columns[1].type, 'boolean');
  assert.deepEqual([...r.columns[1].values].sort(), ['no', 'yes']);
  assert.equal(r.head.length, MAX_HEAD_ROWS, 'head_rows must clamp, not truncate silently');

  const none = profileTable(root, { path: 'wide.csv', head_rows: 0 });
  assert.equal(none.head, undefined);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 7. THE MEMORY WORKSPACE — refused with a sentence, never an ENOENT about a
 *    directory literally named "(memory)".
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐ a memory workspace is refused by name, not by accident', async () => {
  const out = await executeToolCall(
    { id: 'c1', function: { name: 'profile_table', arguments: JSON.stringify({ path: 'a.csv' }) } },
    { root: '(memory)', readFile: () => ({ ok: false, error: 'no such file' }) },
  );
  assert.equal(out.result.ok, false);
  assert.match(out.result.error, /held in memory/);
  assert.doesNotMatch(out.result.error, /ENOENT/);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 8. THE SCHEMA ITSELF — the description is the feature.
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐ the schema names the refusal the model will be holding, and read_table', () => {
  const [schema] = tableProfileToolSchemas();
  const d = schema.function.description;
  assert.match(d, /refused/, 'the model reaches for read_file first — the description must meet it there');
  assert.match(d, /read_table/, 'read_table is the nearest miss in the registry and must be disambiguated');
  assert.ok(schema.function.parameters.required.includes('path'));
  assert.ok(JSON.stringify(schema).length < 1200, 'the byte ceiling is real — keep this schema tight');
});
