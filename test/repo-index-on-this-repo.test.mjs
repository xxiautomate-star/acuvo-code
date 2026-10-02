/**
 * ── test/repo-index-on-this-repo.test.mjs ───────────────────────────────────
 *
 * ⚠️ EVERY OTHER ASSERTION ABOUT THIS MODULE RUNS AGAINST A FIVE-FILE FIXTURE.
 * A fixture proves the mechanism and proves nothing about the thing that
 * actually matters — whether the index answers correctly, and cheaply, on a
 * real four-hundred-file repository with a real `.gitignore`, real generated
 * output and real files nobody meant to index. So this file runs against THIS
 * PACKAGE, the tree the test itself is sitting in.
 *
 * ⚠️ IT WRITES NOTHING INTO THE WORKING TREE. The index is redirected into an
 * in-memory store through `writeFileImpl`/`readFileImpl`, so a test run never
 * leaves a `.acuvo/index/symbols.json` behind for someone else's `git status`
 * to trip over — the litter defect this package has already been graded down
 * for once. Everything else is the real filesystem.
 *
 * ⚠️ AND IT ASSERTS NO WALL-CLOCK NUMBER. Cost is asserted in READS and BYTES,
 * which are properties of the algorithm; a millisecond threshold on a laptop
 * running eleven other agents is a test that fails for reasons nobody can fix.
 * The timings are PRINTED, so a regression is visible, and never asserted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INDEX_REL_PATH,
  definitionsOf,
  openIndex,
  repoIndexToolSchemas,
  searchSymbols,
  serialiseIndex,
  verifyIndex,
} from '../lib/repo-index.mjs';
import { TOOL_SCHEMAS, executeToolCall, toolNamesForRounds } from '../lib/tools.mjs';
import { LSP_TOOL_NAMES } from '../lib/lsp.mjs';
import { searchText } from '../lib/search.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');

/**
 * The real filesystem for reads, an in-memory slot for the index file itself.
 * `openIndex` supplies the rest of the defaults, so this is the production path
 * with exactly one byte of it diverted.
 */
function divertedIndexFile(root) {
  const store = new Map();
  return {
    store,
    impls: {
      readFileImpl: (rel) => {
        if (rel === INDEX_REL_PATH) return store.get(rel) ?? null;
        try { return readFileSync(join(root, rel), 'utf8'); } catch { return null; }
      },
      writeFileImpl: (rel, text) => { store.set(rel, text); },
    },
  };
}

test('the index answers real questions about this repository', async () => {
  const fx = divertedIndexFile(PACKAGE_ROOT);
  const state = openIndex(PACKAGE_ROOT, fx.impls);

  assert.ok(state.walk.filesFound > 200, `expected a real tree, walked ${state.walk.filesFound} files`);
  assert.equal(state.saved, true);

  // ⭐ Three symbols this repository genuinely defines, in three different files,
  // one of them a module this test does not import.
  assert.deepEqual(definitionsOf(state.index, 'rankFiles'), ['lib/repo-map.mjs']);
  assert.deepEqual(definitionsOf(state.index, 'byCodePoint'), ['lib/prefix-order.mjs']);
  assert.deepEqual(definitionsOf(state.index, 'refusedCommitPath'), ['lib/secret-paths.mjs']);

  // …and one it does not, so a false positive would show.
  assert.deepEqual(definitionsOf(state.index, 'thisSymbolDoesNotExistAnywhere'), []);
});

test('nothing under node_modules, dist or .acuvo is indexed', async () => {
  const fx = divertedIndexFile(PACKAGE_ROOT);
  const { index } = openIndex(PACKAGE_ROOT, fx.impls);
  const bad = [...index.entries.keys()].filter((p) => /(^|\/)(node_modules|dist|\.acuvo|\.git)\//.test(p));
  assert.deepEqual(bad, []);
  // `dist/acuvo.mjs` is the generated bundle — it defines every symbol in the
  // package, so indexing it would make every lookup ambiguous.
  assert.equal(index.entries.has('dist/acuvo.mjs'), false);
});

test('a warm index over this repository costs ZERO file reads', async () => {
  const fx = divertedIndexFile(PACKAGE_ROOT);

  const t0 = process.hrtime.bigint();
  const cold = openIndex(PACKAGE_ROOT, fx.impls);
  const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;

  let sourceReads = 0;
  const counting = {
    ...fx.impls,
    readFileImpl: (rel) => {
      if (rel !== INDEX_REL_PATH && !rel.endsWith('.gitignore')) sourceReads += 1;
      return fx.impls.readFileImpl(rel);
    },
  };

  const t1 = process.hrtime.bigint();
  const warm = openIndex(PACKAGE_ROOT, counting);
  const warmMs = Number(process.hrtime.bigint() - t1) / 1e6;

  const bytes = fx.store.get(INDEX_REL_PATH).length;
  console.log(`    repo-index on ${PACKAGE_ROOT}`);
  console.log(`      cold ${coldMs.toFixed(0)}ms · ${cold.refresh.misses} files read · ${(cold.refresh.bytesRead / 1024).toFixed(0)}KB scanned`);
  console.log(`      warm ${warmMs.toFixed(0)}ms · ${warm.refresh.hits} hits · ${sourceReads} source reads`);
  console.log(`      index ${(bytes / 1024).toFixed(0)}KB on disk for ${cold.index.entries.size} files`);

  assert.equal(cold.refresh.hits, 0);
  assert.ok(cold.refresh.misses > 200);
  // ⭐ THE WHOLE CLAIM, IN ONE ASSERTION. Nothing changed, so nothing is opened.
  assert.equal(warm.refresh.hits, cold.refresh.misses);
  assert.equal(warm.refresh.misses, 0);
  assert.equal(sourceReads, 0);
  assert.equal(warm.saved, false, 'an unchanged tree must not rewrite the index');
});

test('the index of this repository is smaller than the source it indexes', async () => {
  const fx = divertedIndexFile(PACKAGE_ROOT);
  const cold = openIndex(PACKAGE_ROOT, fx.impls);
  const bytes = fx.store.get(INDEX_REL_PATH).length;
  // A cache larger than the thing it caches is a cache nobody should ship.
  assert.ok(bytes < cold.refresh.bytesRead / 10,
    `index is ${(bytes / 1024).toFixed(0)}KB against ${(cold.refresh.bytesRead / 1024).toFixed(0)}KB of source`);
});

test('the index of this repository is byte-identical when rebuilt', async () => {
  const a = divertedIndexFile(PACKAGE_ROOT);
  const b = divertedIndexFile(PACKAGE_ROOT);
  const one = serialiseIndex(openIndex(PACKAGE_ROOT, a.impls, { save: false }).index);
  const two = serialiseIndex(openIndex(PACKAGE_ROOT, b.impls, { save: false }).index);
  assert.equal(one.length, two.length);
  assert.equal(one, two);
});

test('every cached entry still matches the file on disk', async () => {
  const fx = divertedIndexFile(PACKAGE_ROOT);
  const { index } = openIndex(PACKAGE_ROOT, fx.impls, { save: false });
  const verdict = verifyIndex(index, PACKAGE_ROOT, fx.impls);
  assert.ok(verdict.checked > 200);
  assert.deepEqual(verdict.stale, []);
});

test('a partial name over the real tree returns names that exist', async () => {
  const fx = divertedIndexFile(PACKAGE_ROOT);
  const { index } = openIndex(PACKAGE_ROOT, fx.impls, { save: false });
  const near = searchSymbols(index, 'rankfile');
  assert.equal(near.exact, false);
  assert.ok(near.suggestions.some((s) => s.name === 'rankFiles'),
    `expected rankFiles among ${JSON.stringify(near.suggestions.map((s) => s.name))}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE WIRING CONTRACT — ⭐ NOW THE WIRING ITSELF (2026-08-25)
//
// This block used to say it "cannot prove the model reaches the tool, because
// registering it means editing lib/tools.mjs, which another change is landing
// in". That edit has landed: `find_symbol` is pushed into `TOOL_SCHEMAS` ahead
// of the search pair, named in `toolNamesForRounds`, and dispatched in
// `executeToolCall`. So these assertions are no longer preconditions for a
// future edit — they are the contract the shipped wiring has to keep.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── ⚠️⚠️ THE OLD VERSION OF THIS TEST WAS A CHECK THAT COULD NOT FAIL ───────
 *
 * It asserted `collisions.length <= 1` for each of MY names against the CURRENT
 * registry. While the module was unwired that count was 1 — because
 * `lib/lsp.mjs` ALREADY declared `find_definition`, unconditionally — and 1 is
 * `<= 1`, so the test reported "no collision" about the exact collision it was
 * written to find. Registering the schema would have put two entries with
 * different parameter shapes (`{file,line,column}` against `{name}`) under one
 * name into the wire payload.
 *
 * ⭐ SO IT ASKS THE QUESTION THAT ACTUALLY MATTERS: is the name claimed by any
 * OTHER module? `LSP_TOOL_NAMES` is imported rather than typed, because a
 * guessed name is how the first version passed.
 */
test('⭐⭐ find_symbol is claimed by no other module, and is declared exactly once', async () => {
  const mine = repoIndexToolSchemas().map((s) => s.function.name);
  assert.deepEqual(mine, ['find_symbol']);

  for (const name of mine) {
    assert.equal(
      LSP_TOOL_NAMES.includes(name), false,
      `${name} is also an LSP tool name — two schemas, two parameter shapes, one name on the wire`,
    );
    const declared = TOOL_SCHEMAS.filter((s) => s.function.name === name);
    assert.equal(
      declared.length, 1,
      `${name} is declared ${declared.length} times in TOOL_SCHEMAS; a duplicate silently shadows one of them`,
    );
  }
});

/**
 * ⭐⭐ THE REACH ASSERTION — the one that would have caught this module sitting
 * finished and imported by nothing. It drives the REAL dispatcher against a
 * real tree and asserts the answer comes out the far end, and it asserts the
 * name is in the offer, because a dispatched verb the model is never told about
 * is the same orphan by another name.
 */
test('⭐⭐ the DISPATCHER reaches the index, and the model is offered the verb', async () => {
  const offered = toolNamesForRounds(16, { root: PACKAGE_ROOT, env: {}, allowRun: true });
  assert.ok(offered.includes('find_symbol'),
    `find_symbol is declared but never offered — toolNamesForRounds returned ${offered.length} names without it`);

  const record = await executeToolCall(
    { id: 'c1', function: { name: 'find_symbol', arguments: JSON.stringify({ name: 'rankFiles' }) } },
    // ⚠️ dryRun, so driving the real dispatcher against the real checkout
    // cannot leave `.acuvo/index/symbols.json` in somebody's `git status`.
    { root: PACKAGE_ROOT, dryRun: true },
    {},
  );
  assert.equal(record.name, 'find_symbol');
  assert.equal(record.mutated, false, 'a lookup must not be reported as a change to the user\'s work');
  assert.equal(record.result.ok, true, `the dispatcher did not reach the index: ${record.result.error}`);
  assert.deepEqual(record.result.definitions.map((d) => d.path), ['lib/repo-map.mjs'],
    'the dispatcher returned something, but not this repository\'s real definition of rankFiles');
});

/**
 * ── ⭐⭐ WHY THE VERB EXISTS AT ALL, ASSERTED RATHER THAN CLAIMED ────────────
 *
 * The case for a lookup verb is not "it is tidier than grep" — it is that on
 * THIS repository `search_text` gives the WRONG ANSWER for symbols defined in
 * `lib/`. Its scan budget is spent inside `bench/` before the walk arrives, so
 * it returns zero matches with `scanCapped: true`. It is honest about having
 * stopped looking, and an honest empty answer still costs a round and invites
 * the model to conclude the symbol does not exist.
 *
 * ⚠️ ASSERTED BOTH WAYS ON PURPOSE. If somebody later raises the scan budget or
 * prunes `bench/`, `scanCapped` goes false and this test tells them the premise
 * moved — rather than passing on a stale story.
 */
test('⭐⭐ find_symbol answers what search_text on this repo cannot', async () => {
  const grep = await searchText(PACKAGE_ROOT, 'rankFiles', {});
  assert.equal(grep.ok, true);

  const fx = divertedIndexFile(PACKAGE_ROOT);
  const { index } = openIndex(PACKAGE_ROOT, fx.impls, { save: false });
  assert.deepEqual(definitionsOf(index, 'rankFiles'), ['lib/repo-map.mjs']);

  if (grep.scanCapped) {
    assert.equal(
      grep.total, 0,
      'search_text stopped early but still found rankFiles — the premise for this verb has changed, re-measure it',
    );
  } else {
    // The budget now reaches lib/. The verb is still worth having — grep returns
    // every MENTION — so assert the discrimination instead of the miss.
    const files = new Set(grep.matches.map((m) => m.path));
    assert.ok(files.size > 1,
      `search_text now reaches lib/ and returned ${files.size} file(s); if it ever returns exactly the definition site, this tool\'s argument needs restating`);
  }
});

test('the schema is shaped like every schema already in TOOL_SCHEMAS', async () => {
  const reference = TOOL_SCHEMAS.find((s) => s.function.name === 'search_text');
  assert.ok(reference, 'search_text is the shape this mirrors and it has moved');
  for (const s of repoIndexToolSchemas()) {
    assert.deepEqual(Object.keys(s).sort(), Object.keys(reference).sort());
    assert.deepEqual(Object.keys(s.function).sort(), Object.keys(reference.function).sort());
    assert.equal(typeof s.function.description, 'string');
    assert.ok(s.function.description.length > 200, 'a one-line description is how a tool ends up unused');
    for (const [key, prop] of Object.entries(s.function.parameters.properties)) {
      assert.ok(typeof prop.description === 'string' && prop.description.length > 0, `${key} has no description`);
    }
  }
});

test('the module is a leaf of the dependency graph the bundler walks', async () => {
  // ⚠️ `scripts/bundle.mjs` REFUSES a cycle by name, and a cycle here would only
  // show up at ship time. repo-index imports repo-map; repo-map must never
  // import repo-index back.
  const map = readFileSync(join(PACKAGE_ROOT, 'lib', 'repo-map.mjs'), 'utf8');
  assert.doesNotMatch(map, /from '\.\/repo-index\.mjs'/);
  const self = readFileSync(join(PACKAGE_ROOT, 'lib', 'repo-index.mjs'), 'utf8');
  // ⚠️ `^import … from` alone MISSES the multi-line `import {\n a,\n} from '…'`
  // form, which is how this module imports repo-map.mjs — the first draft of
  // this assertion passed by not seeing the one import it most needed to see.
  const imports = [...self.matchAll(/^(?:import [^\n]*|\}) from '(\.\/[^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./acuvo-dir.mjs', './prefix-order.mjs', './repo-map.mjs', './secret-paths.mjs']);
  // Every one of them exists — a bundler failure at ship time is the worst place
  // to learn a path was typed wrong.
  for (const rel of imports) assert.ok(statSync(join(PACKAGE_ROOT, 'lib', rel.slice(2))).isFile());
});
