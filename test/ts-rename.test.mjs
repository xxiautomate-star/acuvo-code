import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  findTypescriptLib, typescriptLibAvailable, indexProjectSources,
  projectFilesFor, planViaTypeScriptLib, MAX_INDEXED_FILES,
} from '../lib/ts-rename.mjs';
import { renameBackendFor, renameSymbol, applyEdits } from '../lib/rename.mjs';
// ⚠️ HERMETIC HOME (2026-09-26). `acuvo lsp install` puts a managed TypeScript under
// ~/.acuvo/language-servers, and `findTsserver` falls back to it — so on a machine where the
// developer has run it, "no typescript here" cases found one and chose the tsserver backend.
// Measured with a fake home holding that install: the two backend-precedence cases went red. Nothing here is about the managed
// install; `symbol-tools-are-not-dark-on-a-fresh-install.test.mjs` is.
{
  const noManagedInstall = mkdtempSync(join(tmpdir(), 'acuvo-no-managed-ts-'));
  process.env.HOME = noManagedInstall;
  process.env.USERPROFILE = noManagedInstall;
  delete process.env.ACUVO_HOME;
}

/**
 * ── ⭐⭐⭐ THE SAME FIXTURE THAT DECIDED THE PRECEDENCE, RE-DRIVEN ───────────
 *
 * `rename.mjs`'s header records the measurement that chose tsserver:
 *
 *     FIXTURE: 4 files, `userId` exported from one and used in three, tsc-clean.
 *     tsserver, cold                     →  6 places in 3 files   ✅ COMPLETE
 *     typescript-language-server, cold   →  2 places in 1 file    ❌ INCOMPLETE
 *
 * ⚠️⚠️ A FALLBACK NOBODY MEASURED IS HOW THE INCOMPLETE-WRITE DISASTER ARRIVES
 * BY A DIFFERENT ROAD. So this file rebuilds that fixture and asserts the
 * COMPLETE answer out of the library backend — the same standard the backend it
 * falls back from had to meet, not a weaker one because it is second.
 *
 * ⭐ AND THE ASSERTION IS THE FILE COUNT, NOT "more than zero". The LSP failure
 * mode was a CONFIDENT partial answer: `ok: true`, real locations, three files
 * missing. A test that only checked `ok` would have passed on it.
 */

/**
 * ── ⚠️⚠️ A SKIPPED TEST PROVES NOTHING, SO THIS LOOKS IN TWO PLACES ────────
 *
 * `acuvo-code` publishes with `"dependencies": {}` and has no `node_modules` of
 * its own — which is the whole point of the package and also why the obvious
 * `findTypescriptLib(process.cwd())` skipped EVERY behavioural test in this
 * file on the first run. Eight green skips reading as "14 pass" is precisely
 * the shape `feedback_a_guard_can_pass_while_checking_nothing` names.
 *
 * ⭐ THE SIBLING'S COMPILER IS A REAL ONE and it is the same package the walk
 * would find in any project that has one. Using it here tests the backend, not
 * the walk — the walk has its own tests below.
 */
const SIBLING_TS = resolve(process.cwd(), '..', 'console', 'node_modules', 'typescript', 'lib', 'typescript.js');
const REAL_TS = findTypescriptLib(resolve(process.cwd()))
  ?? (existsSync(SIBLING_TS) ? SIBLING_TS : null);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'model.ts'), 'export const userId = "u1";\nexport const other = 2;\n');
  writeFileSync(join(root, 'src', 'direct.ts'), "import { userId } from './model';\nexport const a = userId;\n");
  writeFileSync(join(root, 'src', 'other.ts'), "import { userId } from './model';\nexport function b() { return userId; }\n");
  writeFileSync(join(root, 'src', 'unrelated.ts'), 'export const userId = "a local one";\nexport const c = userId;\n');
  return root;
}

/** The project's own typescript, symlink-free: point the walk at OUR node_modules. */
function withRealTs(root) {
  return { libPath: REAL_TS };
}

/**
 * ── ⚠️⚠️ THE INSTRUMENT WAS WINDOWS-BLIND, AND IT FAILED AS THE PRODUCT ─────
 *
 * Three tests in this file were red on Windows and green everywhere else, and
 * the failure text read exactly like the defect they hunt — "the rename came
 * back with the wrong file list". It did not. The comparison was
 *
 *     f.absolute.replace(root, '').replace(/\\/g, '/')
 *
 * and the two sides do not use the same separator. `mkdtempSync` returns a
 * NATIVE path (`C:\Users\...\ts-rename-PTPAZG`); `planViaTypeScriptLib` returns
 * TypeScript's own normalised form, which is forward-slashed on every platform.
 * So `replace(root, '')` matched nothing, the whole absolute path survived, and
 * the later backslash pass had nothing left to repair.
 *
 * ⭐ THE ORDER IS THE ENTIRE FIX: normalise BOTH sides, THEN strip. What was
 * there normalised one side, after the strip that needed it.
 *
 * ⚠️ AND IT THROWS WHEN THERE IS NOTHING TO STRIP. Silently returning the
 * untouched absolute path is exactly how this read as a product defect for as
 * long as it did; a helper that cannot tell "not under the root" from "stripped
 * nothing" would hide the next one the same way.
 */
function relativeToRoot(root, absolute) {
  const slash = (p) => String(p).split('\\').join('/');
  const r = slash(root).replace(/\/+$/, '');
  const a = slash(absolute);
  if (!a.startsWith(`${r}/`)) {
    throw new Error(`path is not under the fixture root — root=${r} path=${a}`);
  }
  return a.slice(r.length);
}

test('⭐⭐⭐ the library backend finds EVERY use of an exported symbol, across files', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture();
  const plan = await planViaTypeScriptLib(root, 'src/model.ts', 1, 14, 'accountId', withRealTs(root));

  assert.equal(plan.ok, true, plan.error);
  const files = plan.files.map((f) => relativeToRoot(root, f.absolute)).sort();
  /**
   * ⚠️ THREE FILES AND NOT FOUR. `unrelated.ts` declares its OWN `userId`, and a
   * rename that touched it would be the string-replacement damage this whole
   * module exists to prevent — the assertion is as much about what is ABSENT.
   */
  assert.deepEqual(files, ['/src/direct.ts', '/src/model.ts', '/src/other.ts']);
  const total = plan.files.reduce((n, f) => n + f.edits.length, 0);
  assert.equal(total, 5, `expected the declaration plus two imports and two uses, got ${total}`);
  assert.equal(plan.via, 'typescript');
});

test('⚠️⚠️ the shorthand property is expanded, not silently changed', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-short-'));
  const src = 'const foo = 1;\nexport const o = { foo };\n';
  writeFileSync(join(root, 'a.ts'), src);

  const plan = await planViaTypeScriptLib(root, 'a.ts', 1, 7, 'bar', { libPath: REAL_TS });
  assert.equal(plan.ok, true, plan.error);
  const applied = applyEdits(src, plan.files[0].edits);
  assert.equal(applied.ok, true, applied.error);
  /**
   * ⭐ `{ bar }` WOULD COMPILE AND BE WRONG — the object's property would change
   * name. This is item 1 of `rename.mjs`'s header, and the trap has two doors,
   * so it is checked at both.
   */
  assert.match(applied.text, /\{ foo: bar \}/);
});

test('⭐ plain JavaScript works, which is what `allowJs` is for', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-js-'));
  writeFileSync(join(root, 'util.js'), 'export const TAX = 0.1;\n');
  writeFileSync(join(root, 'cart.js'), "import { TAX } from './util.js';\nexport const t = (n) => n * TAX;\n");

  const plan = await planViaTypeScriptLib(root, 'util.js', 1, 14, 'VAT', { libPath: REAL_TS });
  assert.equal(plan.ok, true, plan.error);
  const files = plan.files.map((f) => relativeToRoot(root, f.absolute)).sort();
  assert.deepEqual(files, ['/cart.js', '/util.js'], 'a plain-JS project must resolve across files');
});

test('⚠️ a comment and a string mentioning the name are NOT renamed', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-str-'));
  const src = '// userId is the id\nexport const userId = "userId";\nexport const q = "select userId from t";\n';
  writeFileSync(join(root, 'a.ts'), src);

  const plan = await planViaTypeScriptLib(root, 'a.ts', 2, 14, 'accountId', { libPath: REAL_TS });
  assert.equal(plan.ok, true, plan.error);
  const applied = applyEdits(src, plan.files[0].edits);
  assert.equal(applied.ok, true, applied.error);
  assert.match(applied.text, /^\/\/ userId is the id/, 'the comment must be untouched');
  assert.match(applied.text, /"userId"/, 'the string literal must be untouched');
  assert.match(applied.text, /select userId from t/, 'the SQL must be untouched');
  assert.match(applied.text, /export const accountId/, 'and the declaration must be renamed');
});

test('⚠️ a project with no typescript is refused with the reason and the fix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-none-'));
  writeFileSync(join(root, 'a.ts'), 'export const x = 1;\n');
  const plan = await planViaTypeScriptLib(root, 'a.ts', 1, 14, 'y', { libPath: null });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /npm i -D typescript/);
  /**
   * ⚠️ AND IT SAYS WHAT NOT TO DO NEXT. A model told only "no compiler" reaches
   * for `edit_file`, which is the string replacement this module exists to
   * replace — so the refusal names it.
   */
  assert.match(plan.error, /Do NOT fall back to edit_file/);
});

test('⚠️ a position that is not in the file is a sentence, never a crash', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-pos-'));
  writeFileSync(join(root, 'a.ts'), 'export const x = 1;\n');
  const far = await planViaTypeScriptLib(root, 'a.ts', 99, 1, 'y', { libPath: REAL_TS });
  assert.equal(far.ok, false);
  assert.match(far.error, /no line 99/);
});

test('⚠️ a position on nothing renameable answers empty rather than guessing', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-empty-'));
  writeFileSync(join(root, 'a.ts'), 'export const x = 1;\n\n\n');
  const plan = await planViaTypeScriptLib(root, 'a.ts', 2, 1, 'y', { libPath: REAL_TS });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.files, []);
});

// ── the walk, which only runs where there is no tsconfig ────────────────────

test('⚠️ node_modules and build output are never indexed', () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-walk-'));
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'x', 'i.js'), '1');
  writeFileSync(join(root, 'dist', 'b.js'), '1');
  writeFileSync(join(root, 'src', 'a.ts'), '1');
  writeFileSync(join(root, 'readme.md'), '1');

  const found = indexProjectSources(root).map((p) => relativeToRoot(root, p));
  assert.deepEqual(found, ['/src/a.ts']);
});

test('⚠️ the walk is bounded — a huge tree cannot hang the verb', () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-cap-'));
  for (let i = 0; i < 12; i += 1) writeFileSync(join(root, `f${i}.ts`), '1');
  assert.equal(indexProjectSources(root, { max: 5 }).length, 5);
  assert.ok(MAX_INDEXED_FILES >= 100, 'the real cap must not be so small it breaks ordinary projects');
});

test("⭐ a tsconfig decides the file list, because it is the project's own answer", (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-cfg-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'legacy'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'legacy', 'b.ts'), 'export const y = 1;\n');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ include: ['src'] }));

  return import(pathToFileURL(REAL_TS).href).then((mod) => {
    const ts = mod?.default ?? mod;
    const got = projectFilesFor(ts, root);
    assert.equal(got.via, 'tsconfig');
    const names = got.fileNames.map((p) => p.replace(/\\/g, '/'));
    assert.ok(names.some((n) => n.endsWith('/src/a.ts')), 'the included file is missing');
    assert.ok(!names.some((n) => n.endsWith('/legacy/b.ts')), 'an excluded file was indexed');
  });
});

// ── the precedence, which is the part that must not move ───────────────────

test('⚠️⚠️ tsserver still wins where it exists — the fallback never displaces it', () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-prec-'));
  mkdirSync(join(root, 'node_modules', 'typescript', 'lib'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js'), '1');
  writeFileSync(join(root, 'node_modules', 'typescript', 'lib', 'typescript.js'), '1');
  assert.equal(renameBackendFor(root, 'a.ts'), 'tsserver');
});

test('⭐ the library backend is chosen when tsserver.js is absent and the lib is not', () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-libonly-'));
  mkdirSync(join(root, 'node_modules', 'typescript', 'lib'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'typescript', 'lib', 'typescript.js'), '1');
  assert.equal(renameBackendFor(root, 'a.ts'), 'typescript');
  assert.equal(typescriptLibAvailable(root), true);
});

test('⚠️ neither backend, and a non-TS file, are still refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-neither-'));
  assert.equal(renameBackendFor(root, 'a.ts'), null);
  mkdirSync(join(root, 'node_modules', 'typescript', 'lib'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'typescript', 'lib', 'typescript.js'), '1');
  assert.equal(renameBackendFor(root, 'main.py'), null, 'a Python file has no TypeScript answer');
});

/**
 * ── ⭐⭐⭐ THE VERB, END TO END, WITH NO CHILD PROCESS ANYWHERE ──────────────
 *
 * ⚠️ THIS IS THE ONE THAT MATTERS FOR "the machine has Node". A runtime that
 * cannot spawn has `typescript` in `node_modules` and used to be told "no
 * compiler here" — which sends the model to `edit_file` and to exactly the
 * damage a semantic rename exists to prevent.
 */
test('⭐⭐⭐ renameSymbol writes a correct multi-file rename through the library backend', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = fixture();
  // Give the project a `typescript` the LIBRARY walk finds and tsserver does not.
  mkdirSync(join(root, 'node_modules', 'typescript', 'lib'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'typescript', 'lib', 'typescript.js'), readFileSync(REAL_TS));

  assert.equal(renameBackendFor(root, 'src/model.ts'), 'typescript', 'the fallback must be the chosen backend here');

  const written = [];
  const executor = {
    root,
    writeFile: (path, content) => {
      written.push({ path, content });
      writeFileSync(join(root, path), content);
      return { ok: true, path };
    },
  };

  const r = await renameSymbol(executor, { file: 'src/model.ts', line: 1, column: 14, new_name: 'accountId' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.via, 'typescript');
  assert.equal(r.files, 3, 'the declaration file and both importers');

  assert.match(readFileSync(join(root, 'src', 'model.ts'), 'utf8'), /export const accountId/);
  assert.match(readFileSync(join(root, 'src', 'direct.ts'), 'utf8'), /import \{ accountId \}/);
  assert.match(readFileSync(join(root, 'src', 'other.ts'), 'utf8'), /return accountId;/);
  /**
   * ⚠️⚠️ THE FILE THAT MUST NOT HAVE MOVED. `unrelated.ts` has its own `userId`,
   * and this is the assertion that separates a semantic rename from a
   * find-and-replace.
   */
  assert.match(readFileSync(join(root, 'src', 'unrelated.ts'), 'utf8'), /export const userId/);
});

/**
 * ── ⚠️⚠️ THE TWO TESTS BELOW EXIST BECAUSE TWO MUTATIONS SURVIVED ───────────
 *
 * `allowJs: false` and "do not force the target file into the roots" both left
 * this file green on its first pass. Both produce the SAME failure — a program
 * that is missing a file, so the rename comes back `ok: true` with real
 * locations and one file unrenamed. That is the confident-partial-write shape,
 * and a suite that cannot see it is not guarding this module's actual hazard.
 */
test('⚠️⚠️ a .js file in a tsconfig project is renamed too — allowJs is forced over the project', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-mixed-'));
  writeFileSync(join(root, 'model.ts'), 'export const userId = "u1";\n');
  writeFileSync(join(root, 'legacy.js'), "import { userId } from './model';\nexport const a = userId;\n");
  /**
   * ⭐ THE PROJECT ITSELF SAYS `allowJs: false`, which is an ordinary thing for
   * a TypeScript project to say — and it must not be allowed to make the rename
   * silently miss a file that plainly uses the symbol.
   */
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: false }, include: ['.'] }));

  const plan = await planViaTypeScriptLib(root, 'model.ts', 1, 14, 'accountId', { libPath: REAL_TS });
  assert.equal(plan.ok, true, plan.error);
  const files = plan.files.map((f) => relativeToRoot(root, f.absolute)).sort();
  assert.deepEqual(files, ['/legacy.js', '/model.ts'], 'the .js user was dropped from the program');
});

test('⚠️⚠️ a file the tsconfig EXCLUDES can still be the one you rename in', async (t) => {
  if (!REAL_TS) return t.skip('no typescript in this checkout');
  const root = mkdtempSync(join(tmpdir(), 'ts-rename-excl-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'scripts', 'tool.ts'), 'const helper = 1;\nexport const y = helper;\n');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ include: ['src'] }));

  /**
   * ⚠️ WITHOUT THE TARGET FILE FORCED INTO THE ROOTS this answers "nothing to
   * rename" about a file that plainly has the symbol in it — which a model
   * reads as a broken tool rather than as a tsconfig it could change.
   */
  const plan = await planViaTypeScriptLib(root, 'scripts/tool.ts', 1, 7, 'base', { libPath: REAL_TS });
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.files.length, 1, 'an excluded file must still be renameable in');
  assert.equal(plan.files[0].edits.length, 2, 'the declaration and its use');
});
