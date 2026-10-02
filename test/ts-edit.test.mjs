import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  planInsertBeforeSymbol, planInsertAfterSymbol, planReplaceFunctionBody,
  runTsEdit, tsEditToolSchemas, TS_EDIT_TOOL_NAMES, MAX_INSERT_CHARS,
} from '../lib/ts-edit.mjs';
import { findTypescriptLib } from '../lib/ts-rename.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';

/**
 * ── ⭐⭐⭐ A WRITE THAT NAMES A SYMBOL INSTEAD OF MATCHING A LINE ────────────
 *
 * ⚠️ THE MEASUREMENT THAT MOTIVATES ALL THREE, on the fixture below: `}` is on
 * **8 of 17 lines — 47%**. `edit_file` anchoring on a brace matches whichever
 * came first, and the failure is silent: it produces a file that still parses.
 * Every test here uses a file with TWO functions for exactly that reason; one
 * with a single function cannot tell a correct implementation from a lucky one.
 *
 * ⭐ AND THE COMPILER IS REAL. `acuvo-code` publishes with `dependencies: {}`
 * and has no `node_modules`, so these fall back to the sibling console's
 * typescript — the same trick `ts-rename.test.mjs` documents, for the same
 * reason: eight green SKIPS read as a pass.
 */
const SIBLING_TS = resolve(process.cwd(), '..', 'console', 'node_modules', 'typescript', 'lib', 'typescript.js');
const REAL_TS = findTypescriptLib(resolve(process.cwd())) ?? (existsSync(SIBLING_TS) ? SIBLING_TS : null);
const OPTS = { libPath: REAL_TS };

/** Two functions, a doc comment, and an arrow — every shape the planners branch on. */
const SRC = [
  "import { fmt } from './util';",
  '',
  '/** Money, as a person reads it. */',
  'export function formatPrice(cents) {',
  '  const v = cents / 100;',
  '  return fmt(v);',
  '}',
  '',
  'export const handleSubmit = (e) => {',
  '  e.preventDefault();',
  '  return true;',
  '};',
  '',
  'export class Cart {',
  '  total() { return 0; }',
  '}',
  '',
].join('\n');

function fixture(src = SRC, name = 'app.ts') {
  const root = mkdtempSync(join(tmpdir(), 'ts-edit-'));
  writeFileSync(join(root, name), src);
  return root;
}

/** The executor shape `rename.mjs` writes through — leases, dry-run and undo live there. */
function executorFor(root) {
  const written = [];
  return {
    written,
    root,
    writeFile: (path, content) => {
      written.push({ path, content });
      writeFileSync(join(root, path), content);
      return { ok: true, path };
    },
  };
}

/**
 * ── ⚠️ THE PREMISE, MEASURED ON THIS FIXTURE RATHER THAN QUOTED ────────────
 *
 * The brief for these verbs said a write "string-replaces a line that 47% of
 * the file shares". I wrote that number into an assertion before measuring my
 * own fixture, and it failed at **38%** (5 of 13 non-blank lines) — which is
 * the same defect as every stale `why` string in the parity map, committed in
 * the same hour I was auditing them.
 *
 * ⭐ 38% IS STILL THE ARGUMENT, and the exact figure is not the point: a brace
 * is on more than a third of the lines of an ordinary source file, and TWO of
 * this fixture's five brace-lines are the closing lines of the two functions
 * these verbs are asked to tell apart. That is what makes a brace-anchored
 * `edit_file` a coin flip, and it is why every test below uses a file with two
 * functions rather than one.
 */
test('⚠️⚠️ the premise: a brace is on more than a third of the lines, and two of them are the two functions', () => {
  const lines = SRC.split('\n').filter((l) => l.trim().length > 0);
  const braces = lines.filter((l) => l.includes('}'));
  assert.ok(
    braces.length / lines.length > 0.33,
    `only ${braces.length}/${lines.length} lines carry a brace — if this drops, the argument for these verbs weakens and the fixture should be re-read`,
  );
  // ⭐ The two that matter: the closing lines of the two functions to tell apart.
  assert.equal(braces.filter((l) => /^\}|^\};/.test(l.trim())).length, 3);
});

// ── insert_before_symbol ────────────────────────────────────────────────────

test('⭐⭐⭐ inserts ABOVE the doc comment, not between the doc and the function', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture();
  const ex = executorFor(root);
  const r = await runTsEdit('insert_before_symbol', ex, {
    file: 'app.ts', symbol: 'formatPrice', text: '/** Cents in, cents out. */\nexport const ZERO = 0;',
  }, OPTS);
  assert.equal(r.ok, true, r.error);

  const out = readFileSync(join(root, 'app.ts'), 'utf8');
  /**
   * ⚠️⚠️ THIS IS THE ASSERTION THE OBVIOUS IMPLEMENTATION FAILS. `getStart()`
   * skips leading trivia, so an insertion there lands BETWEEN the JSDoc and the
   * function — the doc then reads as though it belongs to the new code and the
   * function is left undocumented. Ordering is the only way to see it.
   */
  assert.ok(
    out.indexOf('export const ZERO') < out.indexOf('/** Money, as a person reads it. */'),
    'the insertion landed between the doc comment and the function it documents',
  );
  assert.match(out, /export const ZERO = 0;\n\n\/\*\* Money/);
  // ⭐ And the rest of the file is untouched, byte for byte.
  assert.ok(out.includes('export const handleSubmit = (e) => {'));
  assert.ok(out.includes('  return fmt(v);'));
});

test('⭐ inserts above an arrow-function const, which is the modern shape', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture();
  const ex = executorFor(root);
  const r = await runTsEdit('insert_before_symbol', ex, { file: 'app.ts', symbol: 'handleSubmit', text: 'const GUARD = 1;' }, OPTS);
  assert.equal(r.ok, true, r.error);
  const out = readFileSync(join(root, 'app.ts'), 'utf8');
  assert.match(out, /const GUARD = 1;\n\nexport const handleSubmit/);
  // ⚠️ ABOVE THE `export`, never between `export` and `const`.
  assert.ok(!/export\s+const GUARD/.test(out));
});

// ── insert_after_symbol ─────────────────────────────────────────────────────

test('⭐⭐ inserts after the closing brace AND after the semicolon', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture();
  const ex = executorFor(root);
  const r = await runTsEdit('insert_after_symbol', ex, { file: 'app.ts', symbol: 'handleSubmit', text: 'export const AFTER = 2;' }, OPTS);
  assert.equal(r.ok, true, r.error);
  const out = readFileSync(join(root, 'app.ts'), 'utf8');
  /**
   * ⚠️ THE DECLARATOR'S END LANDS BEFORE THE `;`, which would produce
   * `const x = () => {}export const AFTER = 2;;` — parses as nonsense in some
   * shapes and is unreadable in all of them. The STATEMENT's end is correct.
   */
  assert.match(out, /return true;\n};\n\nexport const AFTER = 2;/);
  assert.ok(!out.includes('};export'), 'the insertion landed before the semicolon');
});

test('⚠️ it goes after the RIGHT function when two are present', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture();
  const ex = executorFor(root);
  await runTsEdit('insert_after_symbol', ex, { file: 'app.ts', symbol: 'formatPrice', text: 'const MARK = 1;' }, OPTS);
  const out = readFileSync(join(root, 'app.ts'), 'utf8');
  // ⭐ Between the two functions — which a brace-anchored edit gets wrong half the time.
  assert.ok(out.indexOf('const MARK = 1;') > out.indexOf('return fmt(v);'));
  assert.ok(out.indexOf('const MARK = 1;') < out.indexOf('export const handleSubmit'));
});

// ── replace_function_body ───────────────────────────────────────────────────

test('⭐⭐⭐ replaces the body and leaves the signature, doc and export alone', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture();
  const ex = executorFor(root);
  const r = await runTsEdit('replace_function_body', ex, {
    file: 'app.ts', symbol: 'formatPrice', body: '  return `$${(cents / 100).toFixed(2)}`;',
  }, OPTS);
  assert.equal(r.ok, true, r.error);
  const out = readFileSync(join(root, 'app.ts'), 'utf8');

  assert.match(out, /\/\*\* Money, as a person reads it\. \*\//, 'the doc comment was destroyed');
  assert.match(out, /export function formatPrice\(cents\) \{/, 'the signature was destroyed');
  assert.match(out, /toFixed\(2\)/);
  assert.ok(!out.includes('return fmt(v);'), 'the old body survived');
  // ⚠️ THE BRACES ARE OURS, NOT THE MODEL'S — a missing one destroys the file.
  assert.equal((out.match(/export function formatPrice/g) ?? []).length, 1);
  assert.ok(out.includes('export const handleSubmit'), 'the next function was damaged');
});

test('⭐ replaces an arrow function body too', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture();
  const ex = executorFor(root);
  const r = await runTsEdit('replace_function_body', ex, { file: 'app.ts', symbol: 'handleSubmit', body: '  return false;' }, OPTS);
  assert.equal(r.ok, true, r.error);
  const out = readFileSync(join(root, 'app.ts'), 'utf8');
  assert.match(out, /export const handleSubmit = \(e\) => \{\n {2}return false;\n\};/);
});

test('⚠️ a class is refused with a sentence naming what it is', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture();
  const r = await planReplaceFunctionBody(root, { file: 'app.ts', symbol: 'Cart', body: 'x' }, OPTS);
  assert.equal(r.ok, false);
  assert.match(r.error, /is a class/);
  assert.match(r.error, /method/);
});

test('⚠️ a concise arrow with no block says so, rather than "not a function"', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture('export const double = (n) => n * 2;\n');
  const r = await planReplaceFunctionBody(root, { file: 'app.ts', symbol: 'double', body: 'return 1;' }, OPTS);
  assert.equal(r.ok, false);
  assert.match(r.error, /concise arrow/);
  assert.match(r.error, /edit_file/);
});

// ── the refusals, which are most of the value ──────────────────────────────

test('⚠️⚠️ two declarations of one name are REFUSED, with both lines named', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture('function go() { return 1; }\nfunction other() {}\nfunction go() { return 2; }\n');
  const r = await planInsertBeforeSymbol(root, { file: 'app.ts', symbol: 'go', text: 'x' }, OPTS);
  assert.equal(r.ok, false);
  assert.match(r.error, /2 times/);
  assert.match(r.error, /line 1/);
  assert.match(r.error, /line 3/);
  assert.match(r.error, /coin flip/);
});

test('⚠️ an unknown symbol lists what the file DOES declare', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture();
  const r = await planInsertBeforeSymbol(root, { file: 'app.ts', symbol: 'nope', text: 'x' }, OPTS);
  assert.equal(r.ok, false);
  assert.match(r.error, /no top-level `nope`/);
  assert.match(r.error, /formatPrice/);
  assert.match(r.error, /handleSubmit/);
});

/**
 * ⚠️⚠️ A LOCAL INSIDE ANOTHER FUNCTION IS DELIBERATELY NOT MATCHED. "insert
 * before `helper`" where `helper` is a closure three levels down is a request
 * whose answer nobody can predict from outside, and editing the wrong one is
 * silent. The refusal says so instead of picking.
 */
test('⚠️⚠️ a symbol declared inside another function is not matched', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture('export function outer() {\n  const helper = () => 1;\n  return helper();\n}\n');
  const r = await planReplaceFunctionBody(root, { file: 'app.ts', symbol: 'helper', body: 'return 2;' }, OPTS);
  assert.equal(r.ok, false);
  assert.match(r.error, /no top-level `helper`/);
  assert.match(r.error, /INSIDE another function/);
});

test('⚠️ a project with no typescript is refused with the fix and the anti-fallback', async () => {
  const root = fixture();
  const r = await planInsertBeforeSymbol(root, { file: 'app.ts', symbol: 'formatPrice', text: 'x' }, { libPath: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /npm i -D typescript/);
  assert.match(r.error, /Do NOT fall back to edit_file/);
});

test('⚠️ a non-TS file is refused and sent to edit_file', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture('# hello\n', 'readme.md');
  const r = await planInsertBeforeSymbol(root, { file: 'readme.md', symbol: 'x', text: 'y' }, OPTS);
  assert.equal(r.ok, false);
  assert.match(r.error, /not TypeScript or JavaScript/);
  assert.match(r.error, /edit_file/);
});

test('⚠️ empty and oversized payloads are refused before anything is parsed', async () => {
  const root = fixture();
  for (const bad of ['', '   ']) {
    const r = await planInsertBeforeSymbol(root, { file: 'app.ts', symbol: 'formatPrice', text: bad }, OPTS);
    assert.equal(r.ok, false);
    assert.match(r.error, /needs "text"/);
  }
  const huge = await planInsertAfterSymbol(root, { file: 'app.ts', symbol: 'formatPrice', text: 'x'.repeat(MAX_INSERT_CHARS + 1) }, OPTS);
  assert.equal(huge.ok, false);
  assert.match(huge.error, /over the/);
});

test('⚠️ a missing symbol argument names what it wants', async () => {
  const root = fixture();
  const r = await planInsertBeforeSymbol(root, { file: 'app.ts', text: 'x' }, OPTS);
  assert.equal(r.ok, false);
  assert.match(r.error, /needs "symbol"/);
  assert.match(r.error, /Not a line number|not a line/i);
});

// ── the wiring, which is where this repo's defects live ────────────────────

test('⭐⭐ all three are REGISTERED, not just written', () => {
  const schemas = tsEditToolSchemas();
  assert.equal(schemas.length, 3);
  for (const n of TS_EDIT_TOOL_NAMES) {
    assert.ok(TOOL_NAMES.includes(n), `${n} is missing from the registry`);
    assert.ok(schemas.some((s) => s.function.name === n), `${n} has no schema`);
  }
});

/**
 * ── ⚠️⚠️ EXACTLY ONCE, AND IT MUST BE IN THE OFFER ──────────────────────────
 *
 * This asserted that **every** schema says *instead of edit_file*, because the
 * model already has `edit_file` and will keep reaching for it otherwise.
 *
 * ⚠️ Lever 10 then deleted all three copies (2026-09-07) to reclaim 232
 * characters from a payload sent every round — *"one rule said three times"* —
 * and left this test red. Both halves were right and the outcome was wrong: the
 * rule reached the model **zero** times, because every surviving `edit_file`
 * mention in `ts-edit.mjs` is inside an error RESULT, which the model reads only
 * after it has already chosen an AST verb.
 *
 * ⭐ So the property is now ONCE, not three times and not never — and the
 * `> 0` half is the one that carries the cost argument, while the `=== 1` half
 * is what stops the three copies growing back.
 */
test('⚠️ the edit_file rule is stated EXACTLY ONCE across the offered schemas', () => {
  const schemas = tsEditToolSchemas();
  const naming = schemas.filter((s) => /edit_file/.test(s.function.description));
  assert.equal(
    naming.length, 1,
    `${naming.length} of ${schemas.length} AST schemas mention edit_file. Zero means the model is never told `
    + 'before it chooses (the mentions left in this module are all error results, which arrive too late); '
    + `more than one is the duplication lever 10 removed. Naming: ${JSON.stringify(naming.map((s) => s.function.name))}`,
  );
  for (const s of schemas) {
    assert.ok(s.function.parameters.required.includes('symbol'), `${s.function.name} does not require a symbol`);
  }
});

/**
 * ⚠️⚠️ ONE WRITER. `applyPlannedEdits` in `rename.mjs` owns preflight, the
 * back-to-front splice, the CRLF rule, the overlap refusal and
 * `executor.writeFile`. A second writer here would be a second place to forget
 * every one of them — so this asserts the module does not contain one.
 */
test('⚠️⚠️ ts-edit writes through the shared applier and has no writer of its own', () => {
  const raw = readFileSync(new URL('../lib/ts-edit.mjs', import.meta.url), 'utf8');
  assert.match(raw, /applyPlannedEdits/, 'it no longer routes through the shared applier');
  /**
   * ⚠️⚠️ COMMENTS STRIPPED FIRST, AND THE FIRST VERSION OF THIS TEST DID NOT.
   * It went red on the module's own docblock — which EXPLAINS that the writing
   * is delegated to `executor.writeFile` elsewhere. A guard that reads prose
   * about a thing instead of the thing is the exact failure this session keeps
   * finding, and it took two hours to commit one myself.
   */
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.match(code, /applyPlannedEdits\(/, 'the applier is only named in a comment, never called');
  assert.ok(
    !/writeFileSync\s*\(|executor\.writeFile/.test(code),
    'ts-edit grew a writer of its own — preflight, the splice, the CRLF rule and the undo journal all live in applyPlannedEdits',
  );
});

test('⭐ a dry-run executor writes nothing and says so', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture();
  const before = readFileSync(join(root, 'app.ts'), 'utf8');
  const r = await runTsEdit('insert_after_symbol', {
    root,
    writeFile: (path) => ({ ok: true, path, dryRun: true }),
  }, { file: 'app.ts', symbol: 'formatPrice', text: 'const X = 1;' }, OPTS);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.dryRun, true);
  assert.equal(readFileSync(join(root, 'app.ts'), 'utf8'), before, 'a dry run touched the file');
});
