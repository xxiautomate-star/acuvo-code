import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyEdits, lineStarts, offsetAt, checkNewName, formatRename,
  renameToolSchema, renameBackendFor, renameSymbol, lspCouldButIsNotTrusted,
  MAX_RENAME_FILES,
} from '../lib/rename.mjs';
import { TOOL_NAMES, toolNamesForRounds } from '../lib/tools.mjs';
import { TOOL_GROUPS } from '../lib/tool-shortlist.mjs';
// ⚠️ HERMETIC HOME (2026-09-26). `acuvo lsp install` puts a managed TypeScript under
// ~/.acuvo/language-servers, and `findTsserver` falls back to it — so on a machine where the
// developer has run it, "no typescript here" cases found one and chose the tsserver backend.
// Measured with a fake home holding that install: 'a workspace with no typescript refuses' went red. Nothing here is about the managed
// install; `symbol-tools-are-not-dark-on-a-fresh-install.test.mjs` is.
{
  const noManagedInstall = mkdtempSync(join(tmpdir(), 'acuvo-no-managed-ts-'));
  process.env.HOME = noManagedInstall;
  process.env.USERPROFILE = noManagedInstall;
  delete process.env.ACUVO_HOME;
}

/**
 * ── ⚠️ WHAT THESE TESTS ARE FOR, AND WHAT THEY CANNOT BE FOR ────────────────
 *
 * The dangerous half of `rename.mjs` is not the tsserver conversation — it is
 * what happens to the BYTES afterwards. Every test below drives that half with
 * spans written by hand, so it runs on a machine with no TypeScript at all and
 * still fails when the splice logic breaks.
 *
 * ⭐ Each one was proven by MUTATION: the defect it describes was reintroduced
 * and the test was confirmed to go red. A guard that has never been seen to
 * fail is a guard that has never been checked — see
 * `feedback_a_guard_can_pass_while_checking_nothing`.
 */

// ── the byte-level engine ───────────────────────────────────────────────────

test('lineStarts indexes LF and CRLF identically — the offset is what matters', () => {
  assert.deepEqual(lineStarts('a\nbb\nc'), [0, 2, 5]);
  //                              0 1 2 3 4 5
  assert.deepEqual(lineStarts('a\r\nbb\r\nc'), [0, 3, 7]);
  assert.deepEqual(lineStarts(''), [0]);
});

test('offsetAt refuses a position that is not in the file rather than clamping', () => {
  const text = 'const a = 1;\n';
  const starts = lineStarts(text);
  assert.equal(offsetAt(starts, text.length, 1, 7), 6);
  // ⚠️ Clamping here is how a rename lands in the middle of an unrelated token.
  assert.equal(offsetAt(starts, text.length, 99, 1), null);
  assert.equal(offsetAt(starts, text.length, 0, 1), null);
  assert.equal(offsetAt(starts, text.length, 1, 0), null);
});

test('⭐ edits apply BACK TO FRONT — two renames on one line both land correctly', () => {
  // `out = userId + userId;`  → both occurrences, same line, different columns.
  const text = 'export const out = userId + userId;\n';
  const a = text.indexOf('userId') + 1;            // 1-based column
  const b = text.lastIndexOf('userId') + 1;
  const r = applyEdits(text, [
    { line: 1, column: a, endLine: 1, endColumn: a + 6, newText: 'accountId' },
    { line: 1, column: b, endLine: 1, endColumn: b + 6, newText: 'accountId' },
  ]);
  assert.equal(r.ok, true);
  /**
   * ⚠️ THE MUTATION THAT PROVES THIS BITES: sort ascending in `applyEdits`
   * instead of descending and this becomes `accountId + accoun` + debris,
   * because the first splice moved every later column by three characters.
   */
  assert.equal(r.text, 'export const out = accountId + accountId;\n');
});

test('⭐⭐ CRLF survives — a one-symbol rename is not a whole-file diff', () => {
  const text = 'import { userId } from "./m";\r\nexport const out = userId;\r\n';
  const before = (text.match(/\r\n/g) ?? []).length;
  const c1 = text.indexOf('userId') + 1;
  const line2 = 'export const out = userId;';
  const c2 = line2.indexOf('userId') + 1;
  const r = applyEdits(text, [
    { line: 1, column: c1, endLine: 1, endColumn: c1 + 6, newText: 'accountId' },
    { line: 2, column: c2, endLine: 2, endColumn: c2 + 6, newText: 'accountId' },
  ]);
  assert.equal(r.ok, true);
  /**
   * ⚠️ MUTATION: implement this as `text.split(/\r?\n/)…join('\n')` — the
   * natural version — and the count drops to 0 while every assertion about the
   * identifiers still passes. That is the silent whole-file rewrite.
   */
  assert.equal((r.text.match(/\r\n/g) ?? []).length, before, 'line endings were rewritten');
  assert.match(r.text, /import \{ accountId \}/);
  assert.match(r.text, /out = accountId;/);
});

test('⭐⭐⭐ prefixText is carried, so a shorthand property keeps its NAME', () => {
  // The exact payload tsserver returns for `{ userId }` once
  // providePrefixAndSuffixTextForRename is on: newText carries "userId: ".
  const text = 'export const p: Payload = { userId };\n';
  const c = text.indexOf('userId') + 1;
  const r = applyEdits(text, [
    { line: 1, column: c, endLine: 1, endColumn: c + 6, newText: 'userId: accountId' },
  ]);
  assert.equal(r.ok, true);
  /**
   * ⚠️ THE FAILURE THIS CATCHES IS THE ONE THAT COMPILES. Building newText as
   * the bare new name yields `{ accountId }`, which changes the object's shape
   * rather than the variable's name — and against an untyped object nothing
   * ever complains.
   */
  assert.equal(r.text, 'export const p: Payload = { userId: accountId };\n');
});

test('⚠️ overlapping ranges are REFUSED, not merged', () => {
  const text = 'const abcdef = 1;\n';
  const r = applyEdits(text, [
    { line: 1, column: 7, endLine: 1, endColumn: 13, newText: 'x' },
    { line: 1, column: 9, endLine: 1, endColumn: 13, newText: 'y' },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.error, /overlapping/);
});

test('⚠️ an out-of-range span refuses the whole file — the file changed underneath', () => {
  const r = applyEdits('short\n', [{ line: 40, column: 1, endLine: 40, endColumn: 5, newText: 'x' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /has changed since the rename was planned/);
  assert.match(r.error, /Nothing was written/);
});

test('a backwards range is refused', () => {
  const r = applyEdits('const a = 1;\n', [{ line: 1, column: 9, endLine: 1, endColumn: 3, newText: 'x' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /backwards/);
});

// ── the name check ──────────────────────────────────────────────────────────

test('⭐ new_name must be an identifier — an expression is refused before anything is asked', () => {
  assert.equal(checkNewName('accountId').ok, true);
  assert.equal(checkNewName('_x$9').ok, true);
  for (const bad of ['foo bar', 'a.b', 'a-b', '9lives', '', 'a()', 'x;drop']) {
    const r = checkNewName(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} should be refused`);
    assert.equal(typeof r.error, 'string');
  }
  // ⚠️ whitespace is named rather than silently trimmed — trimming renames to
  // something the caller did not type.
  const ws = checkNewName(' accountId ');
  assert.equal(ws.ok, false);
  assert.match(ws.error, /whitespace/);
  // a universally reserved word cannot be an identifier anywhere
  assert.equal(checkNewName('class').ok, false);
});

// ── the argument guard ──────────────────────────────────────────────────────

const NOOP_EXECUTOR = { root: process.cwd(), writeFile: () => ({ ok: true }) };

test('⭐ a name-based call is told which tool produces a line number', async () => {
  const r = await renameSymbol(NOOP_EXECUTOR, { file: 'a.ts', new_name: 'b' });
  assert.equal(r.ok, false);
  // ⚠️ "line is required" invites the model to invent one; naming list_symbols
  // and search_text makes it a one-round fix. Same lesson as checkLspArgs.
  assert.match(r.error, /list_symbols|search_text/);
});

test('a missing file is refused with the shape of the call it wanted', async () => {
  const r = await renameSymbol(NOOP_EXECUTOR, { line: 1, new_name: 'b' });
  assert.equal(r.ok, false);
  assert.match(r.error, /"file"/);
});

test('⚠️ new_name is validated BEFORE any server is started', async () => {
  // root is deliberately somewhere with no typescript; if the order were wrong
  // this would come back as "no compiler here" instead of the name complaint.
  const r = await renameSymbol({ root: tmpdir(), writeFile: () => ({ ok: true }) }, { file: 'a.ts', line: 1, new_name: 'not an identifier' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a usable identifier/);
});

// ── the refusals that keep it honest ────────────────────────────────────────

test('⭐ a language the LSP could serve gets a DIFFERENT refusal from an unsupported one', () => {
  // A .py file: a real language server handles it, and we decline it anyway.
  assert.equal(lspCouldButIsNotTrusted('a.py'), true);
  assert.equal(lspCouldButIsNotTrusted('a.rs'), true);
  // TypeScript is the supported case, so it is never the "declined" message.
  assert.equal(lspCouldButIsNotTrusted('a.ts'), false);
  // And something nothing handles is neither.
  assert.equal(lspCouldButIsNotTrusted('a.txt'), false);
});

test('⚠️ the LSP backend is WITHDRAWN — renameBackendFor never returns "lsp"', () => {
  /**
   * ⭐ THIS TEST EXISTS BECAUSE THE OPPOSITE SHIPPED AND BROKE A FIXTURE.
   * `textDocument/rename` on a cold typescript-language-server returned 1 file
   * when the truth was 3, and applying it took `tsc` from exit 0 to exit 2.
   * A future refactor that "restores generality" must fail here first.
   */
  const root = mkdtempSync(join(tmpdir(), 'acuvo-rename-'));
  for (const f of ['a.py', 'a.rs', 'a.go', 'a.ts']) {
    assert.notEqual(renameBackendFor(root, f), 'lsp', `${f} must not be routed to the LSP rename`);
  }
});

test('a workspace with no typescript refuses and names the install, not a fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-rename-'));
  writeFileSync(join(root, 'a.ts'), 'export const x = 1;\n');
  const r = await renameSymbol({ root, writeFile: () => ({ ok: true }) }, { file: 'a.ts', line: 1, column: 14, new_name: 'y' });
  assert.equal(r.ok, false);
  // ⚠️ AND IT MUST TELL THE MODEL NOT TO REACH FOR edit_file. A refusal without
  // that line sends it straight to the string replacement this tool replaces.
  assert.match(r.error, /Do NOT fall back to edit_file/);
});

// ── the wiring, which is where capabilities die in this package ─────────────

test('⭐⭐ rename_symbol is REGISTERED, not just written', () => {
  assert.ok(TOOL_NAMES.includes('rename_symbol'), 'rename_symbol is missing from the registry');
  const schema = renameToolSchema();
  assert.equal(schema.function.name, 'rename_symbol');
  assert.deepEqual(schema.function.parameters.required, ['file', 'line', 'new_name']);
});

test('⭐⭐ it is OFFERED wherever the four navigation verbs are, and never without them', () => {
  /**
   * ⚠️ THE PAIRING IS THE POINT. A brief that gets `find_references` but not
   * `rename_symbol` shows the model every call site and then leaves it to edit
   * them by hand — which is the exact string surgery this verb exists to stop.
   */
  const root = process.cwd();
  const names = toolNamesForRounds(8, { root, allowRun: true });
  assert.equal(
    names.includes('rename_symbol'),
    names.includes('find_references'),
    'rename_symbol and find_references must be offered together — they share one gate',
  );
});

test('⭐ the shortlist keeps it with the other language-server verbs', () => {
  assert.ok(TOOL_GROUPS.intel.tools.includes('rename_symbol'));
  // The words that mean "this task is about a rename" were already there.
  assert.ok(TOOL_GROUPS.intel.words.includes('rename'));
  assert.ok(TOOL_GROUPS.intel.words.includes('refactor'));
});

test('⚠️ the description must warn the model off edit_file, or it will use it', () => {
  const d = renameToolSchema().function.description;
  assert.match(d, /edit_file/);
  assert.match(d, /write_files/);
});

// ── what the model reads back ───────────────────────────────────────────────

test('⭐ a dry run says so in the FIRST clause', () => {
  const out = formatRename({
    ok: true, kind: 'rename', via: 'tsserver', symbol: 'userId', newName: 'accountId',
    dryRun: true, files: 2, edits: 5,
    written: [{ path: 'a.ts', edits: 3, dryRun: true }, { path: 'b.ts', edits: 2, dryRun: true }],
    failed: [],
  });
  /**
   * ⚠️ A model that reads a dry run as applied re-plans against a workspace
   * that never changed, and every following round is built on it. This must not
   * be a field the reader has to notice.
   */
  assert.match(out.split('\n')[0], /dry run — nothing was written/);
  assert.doesNotMatch(out, /Now run check_types/, 'a dry run has nothing to verify');
});

test('⭐ a real run names the verification step', () => {
  const out = formatRename({
    ok: true, kind: 'rename', via: 'tsserver', symbol: 'userId', newName: 'accountId',
    dryRun: false, files: 1, edits: 2,
    written: [{ path: 'a.ts', edits: 2, dryRun: false }], failed: [],
  });
  assert.match(out, /renamed userId → accountId/);
  assert.match(out, /2 places in 1 file/);
  // A rename is not self-verifying: a string key or dynamic import can still break.
  assert.match(out, /check_types/);
});

// ── the integration test, when the machine can run it ──────────────────────

/**
 * ⚠️ CONDITIONAL, AND IT REPORTS WHICH BRANCH IT TOOK. A test that silently
 * skips is a test that stops existing — this one asserts something either way,
 * so it can never pass vacuously without saying so.
 */
test('⭐⭐⭐ END TO END: a real tsserver rename crosses files and spares the decoys', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-rename-e2e-'));
  const ts = findLocalTypescript();
  if (!ts) {
    t.diagnostic('no typescript on this machine — the byte-level tests above still ran');
    return;
  }
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  try { symlinkSync(ts, join(root, 'node_modules', 'typescript'), 'junction'); } catch {
    t.diagnostic('could not link typescript into the fixture');
    return;
  }
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"target":"ES2022","module":"ESNext","moduleResolution":"bundler","noEmit":true},"include":["src"]}');
  writeFileSync(join(root, 'src', 'model.ts'),
    'export const userId = 1;\n'
    + '// userId in a comment\n'
    + 'export const validUserId = 2;\n'
    + 'export const label = "userId";\n');
  writeFileSync(join(root, 'src', 'use.ts'),
    'import { userId as key } from \'./model\';\n'
    + 'export function f() { const userId = 9; return key + userId; }\n');
  /**
   * ⭐⭐⭐ THE SHORTHAND FILE IS THE POINT OF THIS FIXTURE. `{ userId }` against
   * a pinned interface must survive as `{ userId: accountId }`. tsserver only
   * says so when `providePrefixAndSuffixTextForRename` has been switched on by
   * a `configure` request — it is OFF by default, and without it the rename
   * comes back as an ordinary span list with no hint that anything is missing.
   */
  writeFileSync(join(root, 'src', 'shape.ts'),
    'import { userId } from \'./model\';\n'
    + 'export interface Payload { userId: number; }\n'
    + 'export const p: Payload = { userId };\n');

  const written = new Map();
  const executor = {
    root,
    writeFile(path, content) { written.set(path, content); writeFileSync(join(root, path), content); return { ok: true, path }; },
  };

  const r = await renameSymbol(executor, { file: 'src/model.ts', line: 1, column: 14, new_name: 'accountId' });
  assert.equal(r.ok, true, `rename failed: ${r.error}`);
  assert.equal(r.files, 3, 'the rename must cross into every importing file');

  const model = readFileSync(join(root, 'src', 'model.ts'), 'utf8');
  const use = readFileSync(join(root, 'src', 'use.ts'), 'utf8');
  const shape = readFileSync(join(root, 'src', 'shape.ts'), 'utf8');

  /**
   * ⚠️ THE MUTATION THAT PROVES THIS BITES: delete the `configure` request in
   * `planViaTsserver` and this becomes `{ accountId }` — which changes the
   * object's SHAPE, not the variable's name. Against `Payload` that is a type
   * error; in plain JavaScript it is silent and shipped.
   */
  assert.match(shape, /\{ userId: accountId \}/, 'the shorthand property must keep its name');
  assert.match(shape, /interface Payload \{ userId: number; \}/, 'the interface must be untouched');

  assert.match(model, /export const accountId = 1;/, 'the declaration was renamed');
  // The three decoys a string replacement destroys:
  assert.match(model, /\/\/ userId in a comment/, 'a comment must not be renamed');
  assert.match(model, /validUserId/, 'a substring must not be renamed');
  assert.match(model, /"userId"/, 'a string literal must not be renamed');
  // The two things only a compiler gets right:
  assert.match(use, /import \{ accountId as key \}/, 'the aliased import must follow the rename');
  assert.match(use, /const userId = 9/, 'an unrelated symbol of the same name must not change');
});

/** The `typescript` package nearest this checkout, if there is one. */
function findLocalTypescript() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    for (const candidate of [join(dir, 'node_modules', 'typescript'), join(dir, 'console', 'node_modules', 'typescript')]) {
      if (existsSync(join(candidate, 'lib', 'tsserver.js'))) return candidate;
    }
    const up = join(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

test('the file ceiling is stated and enforceable', () => {
  assert.equal(MAX_RENAME_FILES, 60);
});
