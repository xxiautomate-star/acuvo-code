/**
 * ── ⭐⭐⭐ WHAT THE MODEL ACTUALLY RECEIVES — THE TWO DEFECTS THIS PINS ────────
 *
 * MEASURED 2026-08-24 by rendering a realistic OVERSIZED result for every one of
 * the 69 dispatched tools through the real `toolResultText`:
 *
 *   13 of 69 renders were defective
 *     · 11 returned `stringifyForModel`'s structural note and NOTHING ELSE —
 *       `review_code`, `gh_issue`, `gh_pr`, `gh_run`, `read_log`, `inspect_db`,
 *       `sample_db_rows`, `list_engines`, `list_sessions`, `web_search`,
 *       `read_table`. 245 characters of apology in place of the answer.
 *     · 2 blew straight past the 8,000-character ceiling every other tool obeys:
 *       `run_command` and `run_program` at 20,177 characters for an ordinary
 *       400-line test run, and up to ~64,000 in the worst case.
 *
 * ⚠️ THE FIRST IS WORSE THAN THE UNPARSEABLE JSON IT REPLACED. Broken JSON at
 * least carried the data. A note carries none, and the model's only move is to
 * call the tool again and receive the same note — a tool that can never answer.
 *
 * Every assertion below is one of those measurements, so a regression names
 * itself rather than being rediscovered by an agent that cannot see its own
 * search results.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { stringifyForModel } from '../lib/model-json.mjs';
import { toolResultText, clampRunForModel } from '../lib/turn.mjs';
import { checkEditBeforeCommit, bracketBalance, jsonVerdict } from '../lib/edit-diagnostics.mjs';
import { executeToolCall } from '../lib/tools.mjs';

const MAX = 8_000;

/* ────────────────────────────────────────────────────────────────────────────
 * 1. A RESULT WHOSE SIZE IS STRUCTURAL MUST STILL CARRY ITS PAYLOAD
 * ──────────────────────────────────────────────────────────────────────────── */

test('300 small rows arrive as rows, not as an apology', () => {
  const result = { ok: true, table: 't', rows: Array.from({ length: 300 }, (_, i) => ({ id: i, name: 'x'.repeat(40) })) };
  const text = stringifyForModel(result, MAX);

  assert.ok(text.length <= MAX, `rendered ${text.length} characters, ceiling is ${MAX}`);
  const parsed = JSON.parse(text);            // ⚠️ still valid JSON at any size
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.rows));
  /**
   * ⭐ THE NUMBER THAT MATTERS. Before this fix `parsed.rows` did not exist at
   * all — the whole reply was `{ok, _truncated, _note}`. Anything above a
   * handful proves the payload survives; the exact count is arithmetic and must
   * not be pinned, or a harmless budget change breaks a test about capability.
   */
  assert.ok(parsed.rows.length > 20, `only ${parsed.rows.length} rows survived`);
  const marker = parsed.rows[parsed.rows.length - 1];
  assert.equal(typeof marker, 'string');
  assert.match(marker, /more omitted/);
  // ⚠️ The marker is an INSTRUCTION, not a label — it must name the way out.
  assert.match(marker, /offset|limit|narrower path/);
});

test('the count in the marker is the truth, not an estimate', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: i, name: 'x'.repeat(40) }));
  const parsed = JSON.parse(stringifyForModel({ ok: true, rows }, MAX));
  const kept = parsed.rows.length - 1;
  const dropped = Number(String(parsed.rows[kept]).match(/\d+/)[0]);
  assert.equal(kept + dropped, 300, `${kept} kept + ${dropped} dropped should be 300`);
});

test('a result that already fits is byte-identical to JSON.stringify', () => {
  const small = { ok: true, path: 'a.ts', bytes: 12 };
  assert.equal(stringifyForModel(small, MAX), JSON.stringify(small));
});

test('prose still loses prose first — a big string beside a small array', () => {
  const result = { ok: true, path: 'a.diff', files: ['a', 'b'], diff: 'x'.repeat(40_000) };
  const parsed = JSON.parse(stringifyForModel(result, MAX));
  assert.deepEqual(parsed.files, ['a', 'b'], 'the tiny array must not be touched');
  assert.ok(parsed.diff.includes('characters omitted'));
});

test('a result carrying a function does not take the round down with it', () => {
  /**
   * ⚠️ `structuredClone` THROWS on a function where `JSON.stringify` drops it.
   * That threw inside `toolResultText`, i.e. lost the whole round, for a field
   * that was never going to be sent.
   */
  const result = { ok: true, rows: Array.from({ length: 400 }, (_, i) => ({ i, s: 'y'.repeat(30) })), cb: () => {} };
  const text = stringifyForModel(result, MAX);
  assert.ok(text.length <= MAX);
  assert.equal(JSON.parse(text).ok, true);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE RUN VERBS MUST OBEY THE BUDGET *AND* KEEP THE FAILURE
 * ──────────────────────────────────────────────────────────────────────────── */

const noisyRun = () => {
  const noise = (n, tag) => Array.from({ length: n }, (_, i) => `ok ${i} ${tag} test with a reasonably long name so this is realistic`).join('\n');
  const stdout = `${noise(500, 'early')}\nnot ok 501 - adds two numbers\n  AssertionError [ERR_ASSERTION]: expected 1 to equal 2\n  at Object.<anonymous> (test/math.test.js:12:3)\n${noise(500, 'late')}\n# pass 1000\n# fail 1\n`;
  return { ok: true, command: 'npm test', exitCode: 1, stdout, stderr: '', durationMs: 900, passed: false };
};

test('run_command is clamped to the same ceiling every other tool obeys', () => {
  const text = toolResultText({ name: 'run_command', args: {}, result: noisyRun() });
  assert.ok(text.length <= MAX, `run_command rendered ${text.length} characters`);
});

test('the assertion survives the clamp that would otherwise eat it', () => {
  /**
   * ⚠️ THE MUTATION THIS PINS: replace `clampRunForModel` with a plain
   * `clampOutput(...)` and this fails, because a 66,000-character run puts the
   * failing line in the omitted MIDDLE. `failureExcerpt`'s own header measured
   * the same thing for the terminal — the model was the party still not shown.
   */
  const text = toolResultText({ name: 'run_command', args: {}, result: noisyRun() });
  assert.match(text, /AssertionError/);
  assert.match(text, /math\.test\.js:12/);
  assert.match(text, /pinned/);
});

test('the command and the exit code are never inside anything that can be spliced', () => {
  const text = toolResultText({ name: 'run_command', args: {}, result: noisyRun() });
  const [first, second] = text.split('\n');
  assert.equal(first, '$ npm test');
  assert.match(second, /^exit code: 1/);
});

test('a run that fits is returned byte-identical — no excerpt, no notice', () => {
  const result = { ok: true, command: 'npm test', exitCode: 0, stdout: 'all good\n', stderr: '', durationMs: 10, passed: true };
  const text = toolResultText({ name: 'run_command', args: {}, result });
  assert.ok(!text.includes('pinned'), 'a short passing run must carry no excerpt');
  assert.ok(!text.includes('omitted'));
});

test('clampRunForModel leaves a short string alone', () => {
  assert.equal(clampRunForModel('short', { exitCode: 0 }), 'short');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. (b) EDIT-THEN-LINT-BEFORE-COMMIT
 * ──────────────────────────────────────────────────────────────────────────── */

test('bracketBalance ignores brackets inside strings, comments and regexes', () => {
  assert.equal(bracketBalance('function f() { return 1; }'), 0);
  assert.equal(bracketBalance('const s = "a ( b [ c {";'), 0);
  assert.equal(bracketBalance('// ) ) )\nconst x = 1;'), 0);
  assert.equal(bracketBalance('/* } } } */ const x = 1;'), 0);
  assert.equal(bracketBalance('const r = /[)]{2}/g;'), 0);
  assert.equal(bracketBalance('const t = `a ${ f(1) } b`;'), 0);
  assert.equal(bracketBalance('function f() {'), 1);
  assert.equal(bracketBalance('}'), -1);
});

test('⭐⭐ THE CORPUS: every .mjs in this package reads as balanced', () => {
  /**
   * ── ⚠️⚠️ THE NUMBER THAT KILLED THE FIRST TWO VERSIONS ─────────────────────
   *
   * A balance checker is only worth having if it is silent on correct code.
   * Measured against this package's own source, same day, same corpus:
   *
   *     naive string scanner                326 of 381 files mis-read
   *     + template-literal nesting stack      59 of 381
   *     + "a closing backtick returns to
   *        CODE, never to its parent"          0 of 382
   *
   * ⭐ The middle number is the one that matters: a checker firing on 15% of
   * real files is not a conservative check, it is noise the model learns to
   * ignore — and this repo has already recorded that a warning printed always
   * is a warning read never.
   */
  const dir = new URL('../lib/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length > 100, 'the corpus disappeared, so this guard proves nothing');
  const wrong = files.filter((f) => bracketBalance(readFileSync(new URL(f, dir), 'utf8')) !== 0);
  assert.deepEqual(wrong, [], `${wrong.length} valid files were read as unbalanced`);
});

test('the language list contains only what was counted', () => {
  /**
   * ⚠️ `.tsx` mis-read 223 of 409 real files (a closing `</div>` opens a
   * "regex"), so React files get no warning at all. Pinned so nobody adds the
   * extension back on the reasoning that JSX is "basically JavaScript".
   */
  const before = 'const a = () => {\n  return 1;\n};\n';
  const after = 'const a = () => {\n  return 1;\n';
  assert.ok(checkEditBeforeCommit('src/a.ts', before, after).note, '.ts must be checked');
  assert.equal(checkEditBeforeCommit('src/a.tsx', before, after).note, null, '.tsx must NOT be checked');
  assert.equal(checkEditBeforeCommit('src/a.py', before, after).note, null);
  assert.equal(checkEditBeforeCommit('README.md', before, after).note, null);
});

test('an edit that unbalances a balanced file is warned about, never refused', () => {
  const before = 'function f() {\n  return 1;\n}\n';
  const after = 'function f() {\n  return 1;\n';
  const { block, note } = checkEditBeforeCommit('src/a.ts', before, after);
  assert.equal(block, null, 'a heuristic may never refuse an edit');
  assert.match(note, /bracket-balanced before this edit and is not now/);
  assert.match(note, /1 bracket opened and never closed/);
});

test('a file that was ALREADY unbalanced is never blamed on this edit', () => {
  const { block, note } = checkEditBeforeCommit('src/a.ts', 'function f() {', 'function g() {');
  assert.equal(block, null);
  assert.equal(note, null);
});

test('broken JSON is REFUSED, and the refusal says the file is untouched', () => {
  const before = '{\n  "name": "app",\n  "version": "1.0.0"\n}\n';
  const after = '{\n  "name": "app",\n  "version": "1.0.0",\n}\n';   // trailing comma
  const { block } = checkEditBeforeCommit('package.json', before, after);
  assert.ok(block, 'a trailing comma in package.json must block');
  assert.match(block, /would stop being valid JSON/);
  assert.match(block, /NOTHING WAS WRITTEN/);
});

test('JSON-with-comments cannot be blocked, because it never parsed to begin with', () => {
  /**
   * ⚠️ THE FALSE POSITIVE THAT WOULD HAVE MADE THIS UNSHIPPABLE. `tsconfig.json`
   * is jsonc; `JSON.parse` has never accepted it. Requiring "valid before" is
   * what keeps a real parser from refusing a correct edit to a real file.
   */
  const before = '{\n  // the compiler options\n  "strict": true\n}\n';
  const { block } = checkEditBeforeCommit('tsconfig.json', before, '{\n  // still jsonc\n  "strict": false,\n}\n');
  assert.equal(block, null);
});

test('a NEW json file is not blocked — there is no "was valid" to compare against', () => {
  assert.equal(checkEditBeforeCommit('new.json', null, '{ oops }').block, null);
});

test('jsonVerdict is terse — one line, no stack', () => {
  const v = jsonVerdict('{ "a": }');
  assert.equal(v.ok, false);
  assert.ok(v.error.length <= 200);
  assert.ok(!v.error.includes('\n'), 'a multi-line parser dump burns context');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. AND IT IS WIRED — the dispatcher refuses, and the note reaches the model
 * ──────────────────────────────────────────────────────────────────────────── */

/** The smallest executor the dispatcher accepts: a Map with the four verbs. */
function memoryExecutor(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    root: '/fake-root',
    readFile: (p) => (files.has(p) ? { ok: true, path: p, content: files.get(p), bytes: files.get(p).length } : { ok: false, error: 'no such file' }),
    writeFile: (p, c) => { files.set(p, c); return { ok: true, path: p, bytes: c.length, created: false }; },
    deleteFile: (p) => { files.delete(p); return { ok: true, path: p, bytes: 0 }; },
    listDir: () => ({ ok: true, path: '.', entries: [] }),
    files,
  };
}

const call = (name, args) => ({ id: 't1', function: { name, arguments: JSON.stringify(args) } });

test('write_file REFUSES to break a valid package.json, and writes nothing', async () => {
  const executor = memoryExecutor({ 'package.json': '{ "name": "app" }' });
  const record = await executeToolCall(call('write_file', { path: 'package.json', content: '{ "name": "app", }' }), executor);
  assert.equal(record.result.ok, false);
  assert.match(record.result.error, /would stop being valid JSON/);
  assert.equal(record.mutated, false);
  assert.equal(executor.files.get('package.json'), '{ "name": "app" }', 'the file on disk must be untouched');
});

test('edit_file REFUSES the same break through the other verb', async () => {
  const executor = memoryExecutor({ 'package.json': '{\n  "name": "app"\n}' });
  const record = await executeToolCall(
    call('edit_file', { path: 'package.json', old_string: '"name": "app"', new_string: '"name": "app",' }),
    executor,
  );
  assert.equal(record.result.ok, false);
  assert.match(record.result.error, /valid JSON/);
  assert.equal(executor.files.get('package.json'), '{\n  "name": "app"\n}');
});

test('write_files refuses the WHOLE batch — the bulk verb is not a side door', async () => {
  const executor = memoryExecutor({ 'package.json': '{ "a": 1 }' });
  const record = await executeToolCall(call('write_files', {
    files: [{ path: 'ok.ts', content: 'export const a = 1;\n' }, { path: 'package.json', content: '{ "a": 1, }' }],
  }), executor);
  assert.equal(record.result.ok, false);
  assert.equal(executor.files.has('ok.ts'), false, 'no file may land when one is refused');
});

test('the balance warning REACHES THE MODEL, which is the whole point', async () => {
  const executor = memoryExecutor({ 'src/a.ts': 'function f() {\n  return 1;\n}\n' });
  const record = await executeToolCall(
    call('edit_file', { path: 'src/a.ts', old_string: '  return 1;\n}\n', new_string: '  return 1;\n' }),
    executor,
  );
  assert.equal(record.result.ok, true, 'a warning may never fail a write');
  /**
   * ⚠️ THE MUTATION THIS PINS: delete the `editCheck` line from
   * `toolResultText` and the write still succeeds, the note is still computed,
   * and the model is told nothing — the exact "capability lost in transit"
   * failure this whole pass exists to remove.
   */
  const seen = toolResultText(record);
  assert.match(seen, /<edit-check/);
  assert.match(seen, /bracket-balanced before this edit/);
});

test('a clean edit adds not one byte to what the model reads', async () => {
  const executor = memoryExecutor({ 'src/a.ts': 'function f() {\n  return 1;\n}\n' });
  const record = await executeToolCall(
    call('edit_file', { path: 'src/a.ts', old_string: 'return 1;', new_string: 'return 2;' }),
    executor,
  );
  assert.equal(record.result.ok, true);
  assert.ok(!toolResultText(record).includes('edit-check'));
});
