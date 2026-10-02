/**
 * ── test/repo-index.test.mjs ────────────────────────────────────────────────
 *
 * The four properties this module is only worth having if it actually holds:
 *
 *   1. IT IS INCREMENTAL. An unchanged file costs one integer comparison, and a
 *      changed one costs exactly one read. Asserted by counting READS through an
 *      injected `readFileImpl`, never by timing — a stopwatch assertion is flaky
 *      on a busy laptop and proves nothing about the mechanism.
 *   2. IT INVALIDATES ITSELF. Size, mtime, deletion, format, and — the one
 *      everybody forgets — a change to the EXTRACTOR that produced the cached
 *      answers.
 *   3. IT IS DETERMINISTIC. The same tree serialises to the same bytes,
 *      regardless of the order the filesystem handed the files over.
 *   4. IT NEVER LEAKS AND NEVER THROWS. No file body reaches the index, no
 *      credential file is opened, and a read-only workspace degrades to "no
 *      cache" rather than to a failed run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INDEX_EXT,
  INDEX_FORMAT,
  INDEX_REL_PATH,
  MAX_INDEX_FILE_BYTES,
  definitionsOf,
  emptyIndex,
  executeRepoIndexTool,
  extractorFingerprint,
  hashText,
  loadIndex,
  openIndex,
  parseIndex,
  refreshIndex,
  repoIndexToolSchemas,
  saveIndex,
  searchSymbols,
  serialiseIndex,
  symbolsOf,
  verifyIndex,
  walkIndexable,
} from '../lib/repo-index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');

// ─────────────────────────────────────────────────────────────────────────────
// A tiny on-disk fixture, and an in-memory one for the injected-impl tests.
// ─────────────────────────────────────────────────────────────────────────────

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-index-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

/** An injected filesystem, so reads can be COUNTED rather than guessed at. */
function memoryImpls(files, { shuffle = false } = {}) {
  const reads = [];
  const state = new Map(Object.entries(files).map(([p, body], i) => [p, { body, mtimeMs: 1000 + i }]));
  const dirsOf = (rel) => {
    const prefix = rel === '' ? '' : `${rel}/`;
    const out = new Map();
    for (const path of state.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) out.set(rest, 'file');
      else out.set(rest.slice(0, slash), 'dir');
    }
    const list = [...out.entries()].map(([name, type]) => ({ name, type }));
    // ⚠️ THE POINT OF THE SHUFFLE: `readdir` makes no order promise, so the
    // index has to produce the same bytes when the order changes.
    if (shuffle) list.reverse();
    return list;
  };
  return {
    reads,
    written: new Map(),
    impls: {
      existsImpl: () => true,
      readdirImpl: dirsOf,
      statImpl: (rel) => {
        const f = state.get(rel);
        return f ? { size: f.body.length, mtimeMs: f.mtimeMs, dir: false } : null;
      },
      readFileImpl: (rel) => {
        reads.push(rel);
        return state.get(rel)?.body ?? null;
      },
      writeFileImpl: () => { /* the memory fixture does not persist */ },
    },
    set(path, body, mtimeMs) {
      const prev = state.get(path);
      state.set(path, { body, mtimeMs: mtimeMs ?? (prev ? prev.mtimeMs + 1 : 1) });
    },
    remove(path) { state.delete(path); },
  };
}

const SAMPLE = {
  'package.json': '{"name":"fx"}',
  'src/alpha.mjs': 'export function alphaOne() {}\nexport const alphaTwo = 1;\n',
  'src/beta.mjs': 'export class BetaThing {}\nimport { alphaOne } from "./alpha.mjs";\n',
  'src/deep/gamma.ts': 'export interface GammaShape { x: number }\nexport function gammaGo() {}\n',
  'README.md': '# not indexable',
};

// ─────────────────────────────────────────────────────────────────────────────
// 1 — THE DRIFT GUARD
//
// ⚠️ `repo-map.mjs` does not export `SYMBOL_EXT` or `MAX_SYMBOL_FILE_BYTES`, so
// this module mirrors them. Two ideas about which files hold symbols IS the bug:
// the index would answer "no definition" for a symbol the map can see. This is
// the same guard `repo-map.mjs` runs against `search.mjs`, pointed the other way.
// ─────────────────────────────────────────────────────────────────────────────

test('INDEX_EXT is byte-identical to repo-map.mjs SYMBOL_EXT', () => {
  const src = readFileSync(join(PACKAGE_ROOT, 'lib', 'repo-map.mjs'), 'utf8');
  const m = src.match(/^const SYMBOL_EXT = (\/.*\/[a-z]*);$/m);
  assert.ok(m, 'could not find SYMBOL_EXT in repo-map.mjs — the guard itself has drifted');
  assert.equal(INDEX_EXT.source, new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), 'i').source);
  assert.equal(m[1], `${INDEX_EXT}`);
});

test('MAX_INDEX_FILE_BYTES matches repo-map.mjs MAX_SYMBOL_FILE_BYTES', () => {
  const src = readFileSync(join(PACKAGE_ROOT, 'lib', 'repo-map.mjs'), 'utf8');
  const m = src.match(/^const MAX_SYMBOL_FILE_BYTES = (.+);$/m);
  assert.ok(m, 'could not find MAX_SYMBOL_FILE_BYTES in repo-map.mjs');
  assert.equal(MAX_INDEX_FILE_BYTES, Function(`"use strict"; return (${m[1]});`)());
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 — THE WALK
// ─────────────────────────────────────────────────────────────────────────────

test('the walk finds only files that could hold a symbol', () => {
  const fx = memoryImpls(SAMPLE);
  const { files } = walkIndexable('/fake', fx.impls);
  assert.deepEqual(files.map((f) => f.path), ['src/alpha.mjs', 'src/beta.mjs', 'src/deep/gamma.ts']);
});

test('the walk honours .gitignore, skip dirs and hidden files', () => {
  const fx = memoryImpls({
    '.gitignore': 'generated/\n',
    'src/a.mjs': 'export const a = 1;',
    'generated/b.mjs': 'export const b = 1;',
    'node_modules/pkg/c.mjs': 'export const c = 1;',
    'dist/d.mjs': 'export const d = 1;',
    '.hidden/e.mjs': 'export const e = 1;',
  });
  const { files, stats } = walkIndexable('/fake', fx.impls);
  assert.deepEqual(files.map((f) => f.path), ['src/a.mjs']);
  assert.equal(stats.gitignored, 1);
  assert.equal(stats.skippedDirs, 2);
  assert.equal(stats.hidden, 1);
});

test('a credential-shaped file is WITHHELD, and the counter says so', () => {
  // ⭐ The counter is the assertion that matters. `.env.mjs` is also hidden, so
  // an ordering that checked "hidden" first would exclude it while leaving
  // `withheld` at zero — a guard nobody could prove still fires.
  const fx = memoryImpls({ 'src/a.mjs': 'export const a = 1;', 'config/.env.mjs': 'export const KEY = "sk-live";' });
  const { files, stats } = walkIndexable('/fake', fx.impls);
  assert.deepEqual(files.map((f) => f.path), ['src/a.mjs']);
  assert.equal(stats.withheld, 1);
  assert.equal(stats.hidden, 0);
});

test('a file larger than the symbol ceiling is not opened', () => {
  const fx = memoryImpls({ 'big.mjs': 'x'.repeat(MAX_INDEX_FILE_BYTES + 1), 'small.mjs': 'export const s = 1;' });
  const { files, stats } = walkIndexable('/fake', fx.impls);
  assert.deepEqual(files.map((f) => f.path), ['small.mjs']);
  assert.equal(stats.filesTooLarge, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — INCREMENTAL, COUNTED IN READS
// ─────────────────────────────────────────────────────────────────────────────

test('a cold index reads every file; a warm one reads none', () => {
  const fx = memoryImpls(SAMPLE);
  const cold = openIndex('/fake', fx.impls, { save: false });
  assert.equal(cold.refresh.misses, 3);
  assert.equal(cold.refresh.hits, 0);
  const sourceReads = fx.reads.filter((p) => INDEX_EXT.test(p));
  assert.equal(sourceReads.length, 3);

  fx.reads.length = 0;
  const warm = refreshIndex(cold.index, walkIndexable('/fake', fx.impls).files, '/fake', fx.impls);
  assert.equal(warm.hits, 3);
  assert.equal(warm.misses, 0);
  assert.deepEqual(fx.reads.filter((p) => INDEX_EXT.test(p)), []);
});

test('changing ONE file re-reads exactly that one file', () => {
  const fx = memoryImpls(SAMPLE);
  const state = openIndex('/fake', fx.impls, { save: false });
  fx.set('src/beta.mjs', 'export class BetaThing {}\nexport function betaAdded() {}\n');

  fx.reads.length = 0;
  const again = refreshIndex(state.index, walkIndexable('/fake', fx.impls).files, '/fake', fx.impls);
  assert.equal(again.misses, 1);
  assert.equal(again.hits, 2);
  assert.deepEqual(fx.reads.filter((p) => INDEX_EXT.test(p)), ['src/beta.mjs']);
  assert.deepEqual(symbolsOf(state.index, 'src/beta.mjs'), ['BetaThing', 'betaAdded']);
});

test('a same-size edit is still caught, because mtime moved', () => {
  const fx = memoryImpls(SAMPLE);
  const state = openIndex('/fake', fx.impls, { save: false });
  const before = SAMPLE['src/alpha.mjs'];
  const after = before.replace('alphaTwo', 'alphaTwX');
  assert.equal(after.length, before.length);
  fx.set('src/alpha.mjs', after);
  const again = refreshIndex(state.index, walkIndexable('/fake', fx.impls).files, '/fake', fx.impls);
  assert.equal(again.misses, 1);
  assert.deepEqual(symbolsOf(state.index, 'src/alpha.mjs'), ['alphaOne', 'alphaTwX']);
});

test('a deleted file is pruned, and stops answering', () => {
  const fx = memoryImpls(SAMPLE);
  const state = openIndex('/fake', fx.impls, { save: false });
  assert.deepEqual(definitionsOf(state.index, 'BetaThing'), ['src/beta.mjs']);
  fx.remove('src/beta.mjs');
  const again = refreshIndex(state.index, walkIndexable('/fake', fx.impls).files, '/fake', fx.impls);
  assert.equal(again.pruned, 1);
  assert.deepEqual(definitionsOf(state.index, 'BetaThing'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 — DETERMINISM
// ─────────────────────────────────────────────────────────────────────────────

test('the same tree serialises to the same bytes whatever order readdir used', () => {
  const forward = memoryImpls(SAMPLE);
  const reverse = memoryImpls(SAMPLE, { shuffle: true });
  const a = serialiseIndex(openIndex('/fake', forward.impls, { save: false }).index);
  const b = serialiseIndex(openIndex('/fake', reverse.impls, { save: false }).index);
  assert.equal(a, b);
});

test('the string table is rebuilt, so a pruned file leaves no trace in the bytes', () => {
  const fx = memoryImpls(SAMPLE);
  const state = openIndex('/fake', fx.impls, { save: false });
  assert.match(serialiseIndex(state.index), /BetaThing/);
  fx.remove('src/beta.mjs');
  refreshIndex(state.index, walkIndexable('/fake', fx.impls).files, '/fake', fx.impls);
  const after = serialiseIndex(state.index);
  assert.doesNotMatch(after, /BetaThing/);

  // …and it equals what a from-scratch index of the same tree would write.
  const fresh = memoryImpls({ ...SAMPLE });
  fresh.remove('src/beta.mjs');
  assert.equal(after, serialiseIndex(openIndex('/fake', fresh.impls, { save: false }).index));
});

test('serialise → parse → serialise is a fixed point', () => {
  const fx = memoryImpls(SAMPLE);
  const text = serialiseIndex(openIndex('/fake', fx.impls, { save: false }).index);
  const parsed = parseIndex(text);
  assert.ok(parsed);
  assert.equal(serialiseIndex(parsed), text);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 — INVALIDATION
// ─────────────────────────────────────────────────────────────────────────────

test('a changed extractor fingerprint discards the whole index', () => {
  const root = fixture(SAMPLE);
  try {
    openIndex(root);
    const path = join(root, INDEX_REL_PATH);
    const poisoned = readFileSync(path, 'utf8').replace(/"extractor":"[^"]*"/, '"extractor":"0.0"');
    writeFileSync(path, poisoned, 'utf8');
    const loaded = loadIndex(root);
    assert.equal(loaded.loaded, false);
    assert.equal(loaded.reason, 'extractor-changed');
    assert.equal(loaded.index.entries.size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the extractor fingerprint is stable across calls and non-empty', () => {
  const a = extractorFingerprint();
  assert.equal(a, extractorFingerprint());
  assert.match(a, /^[0-9a-z]+\.[0-9a-z]+$/);
});

test('a wrong format number, or corrupt JSON, is discarded rather than half-loaded', () => {
  assert.equal(parseIndex('{ not json'), null);
  assert.equal(parseIndex(''), null);
  assert.equal(parseIndex(JSON.stringify({ format: INDEX_FORMAT + 1, extractor: 'x', idents: false, strings: [], files: [] })), null);
  assert.equal(parseIndex(JSON.stringify({ format: INDEX_FORMAT, extractor: 'x', idents: false, strings: [], files: [['a.mjs', 1]] })), null);
});

test('turning identifiers on invalidates an index written without them', () => {
  const fx = memoryImpls(SAMPLE);
  const state = openIndex('/fake', fx.impls, { save: false });
  assert.equal(state.index.idents, false);
  const on = refreshIndex(state.index, walkIndexable('/fake', fx.impls).files, '/fake', fx.impls, { withIdentifiers: true });
  assert.equal(on.modeChanged, true);
  assert.equal(on.misses, 3);
  assert.ok(state.index.entries.get('src/beta.mjs').idents.includes('alphaOne'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 — NO CONTENT LEAVES
// ─────────────────────────────────────────────────────────────────────────────

test('the index holds names, never a file body', () => {
  const fx = memoryImpls({
    'src/a.mjs': 'export const token = "sk-live-DO-NOT-COPY-THIS";\n// a comment nobody should cache\n',
  });
  const text = serialiseIndex(openIndex('/fake', fx.impls, { save: false }).index);
  assert.match(text, /"token"/);
  assert.doesNotMatch(text, /sk-live/);
  assert.doesNotMatch(text, /nobody should cache/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 — VERIFY: the expensive check the fast path skips
// ─────────────────────────────────────────────────────────────────────────────

test('verifyIndex catches the edit that size and mtime cannot see', () => {
  // ⚠️ THE HOLE IS CONSTRUCTED THROUGH INJECTED IMPLS, NOT ON DISK, AND THAT IS
  // A FINDING RATHER THAN A CONVENIENCE. The first draft of this test tried to
  // build it for real — write the same byte count, then `utimesSync` the
  // timestamps back — and it FAILED, because `utimesSync` rounds to whole
  // milliseconds while NTFS keeps 100ns ticks: the restored mtime came back
  // 1787580371823 against an original 1787580371823.4138, so the fast path
  // correctly saw a change. Sub-millisecond mtime resolution makes this hole
  // far narrower in practice than the doc-comment claims. It is still a hole on
  // a filesystem with coarse timestamps, so the check stays — but the honest
  // statement is "narrow", and only an injected clock can exercise it.
  const fx = memoryImpls({ 'src/a.mjs': 'export const aaa = 1;\n' });
  const state = openIndex('/fake', fx.impls, { save: false });
  assert.equal(verifyIndex(state.index, '/fake', fx.impls).ok, true);

  const stored = state.index.entries.get('src/a.mjs');
  fx.set('src/a.mjs', 'export const bbb = 1;\n', stored.mtimeMs);

  const again = refreshIndex(state.index, walkIndexable('/fake', fx.impls).files, '/fake', fx.impls);
  assert.equal(again.hits, 1);
  assert.equal(again.misses, 0);
  assert.deepEqual(symbolsOf(state.index, 'src/a.mjs'), ['aaa'], 'the fast path is fooled — the documented hole');

  const verdict = verifyIndex(state.index, '/fake', fx.impls);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.stale, ['src/a.mjs']);
});

/**
 * ── ⚠️⚠️ THIS TEST USED TO ASSERT A TIMESTAMP COINCIDENCE ───────────────────
 *
 * It ended `assert.equal(again.misses, 1)` unconditionally, and the sibling
 * comment above states its entire premise: *"`utimesSync` rounds to whole
 * milliseconds while NTFS keeps 100ns ticks"*. That is a property of the CLOCK,
 * not of the code. When the original `mtimeMs` happens to land exactly on a
 * millisecond boundary the restore round-trips EXACTLY — and because the two
 * bodies are deliberately the same 22 bytes, `size` matches too. The fast path
 * is then *correctly* reporting a hit (it is the same-tick, same-size hole the
 * module documents), and the test called it a failure.
 *
 * ⚠️ IT IS WHY THE SUITE COULD NOT GATE A RELEASE. Three consecutive full runs
 * each failed ONE test and a different one each time; this was one of them,
 * reported as `expected: 1, actual: 0`, and it passes on every re-run in
 * isolation. Measured on this machine: 500 samples at idle and under CPU load,
 * `mtimeMs` round-tripped exactly 0 times — so the window is narrow, which is
 * exactly what makes it a rare random red rather than an obvious one.
 *
 * ⭐ THE FIX IS TO ASSERT THE MECHANISM, NOT THE COINCIDENCE. The precondition
 * is now READ rather than assumed, and both branches make a real claim:
 *   · timestamp moved  -> the fast path MUST notice (the original claim)
 *   · timestamp identical -> we reproduced the documented hole on real disk, so
 *     a hit is CORRECT, and the safety net (`verifyIndex`) must still catch it.
 * There is no outcome left where a passing implementation reports red.
 */
test('on a real filesystem, restoring the timestamp does NOT fool the fast path', () => {
  const root = fixture({ 'src/a.mjs': 'export const aaa = 1;\n' });
  try {
    const abs = join(root, 'src/a.mjs');
    const before = statSync(abs);
    const state = openIndex(root, {}, { save: false });
    writeFileSync(abs, 'export const bbb = 1;\n', 'utf8');
    utimesSync(abs, before.atime, before.mtime);

    // ⚠️ The fixture must be the one the claim is about: a SAME-SIZE rewrite.
    // Without this the fast path would notice via `size` and prove nothing.
    assert.equal(statSync(abs).size, before.size);

    const restored = statSync(abs).mtimeMs;
    const again = refreshIndex(state.index, walkIndexable(root).files, root);

    if (restored !== before.mtimeMs) {
      // The ordinary case: sub-millisecond precision survived, so `mtimeMs`
      // moved and the fast path has everything it needs.
      assert.equal(again.misses, 1,
        `mtimeMs moved (${before.mtimeMs} -> ${restored}) and the fast path still did not re-read the file`);
      assert.deepEqual(symbolsOf(state.index, 'src/a.mjs'), ['bbb']);
    } else {
      /**
       * ⭐ THE DOCUMENTED HOLE, REPRODUCED FOR REAL. `size` and `mtimeMs` are
       * both identical, so a hit is the CORRECT answer from a fast path that
       * compares exactly those two fields — and the thing that must still hold
       * is the expensive check, which is the whole reason it exists.
       */
      assert.equal(again.misses, 0, 'size and mtimeMs are both identical, so the fast path cannot know');
      assert.deepEqual(symbolsOf(state.index, 'src/a.mjs'), ['aaa']);
      assert.equal(verifyIndex(state.index, root).ok, false,
        'the safety net missed a stale entry that the fast path could not possibly see — that IS the defect');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hashText separates same-length and different-length text', () => {
  assert.notEqual(hashText('abc'), hashText('abd'));
  assert.notEqual(hashText('abc'), hashText('abcd'));
  assert.equal(hashText('abc'), hashText('abc'));
  assert.equal(hashText(''), hashText(null));
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 — PERSISTENCE, AND FAILING SOFT
// ─────────────────────────────────────────────────────────────────────────────

test('the index survives the process and is reused, without dirtying the tree', () => {
  const root = fixture(SAMPLE);
  try {
    const cold = openIndex(root);
    assert.equal(cold.saved, true);
    assert.equal(cold.refresh.misses, 3);

    const warm = openIndex(root);
    assert.equal(warm.loaded, true);
    assert.equal(warm.refresh.hits, 3);
    assert.equal(warm.refresh.misses, 0);
    // ⭐ Nothing was rewritten, because nothing changed.
    assert.equal(warm.saved, false);

    // `.acuvo/` ignores itself — no git litter, which is a bench failure we
    // have already been graded down for once.
    assert.equal(readFileSync(join(root, '.acuvo', '.gitignore'), 'utf8').includes('*'), true);
    assert.deepEqual(definitionsOf(warm.index, 'gammaGo'), ['src/deep/gamma.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a workspace that cannot be written still answers, it just does not cache', () => {
  const fx = memoryImpls(SAMPLE);
  const impls = {
    ...fx.impls,
    writeFileImpl: () => { throw new Error('EROFS: read-only file system'); },
  };
  const state = openIndex('/fake', impls);
  assert.equal(state.saved, false);
  assert.deepEqual(definitionsOf(state.index, 'alphaOne'), ['src/alpha.mjs']);

  const save = saveIndex('/fake', emptyIndex(), impls);
  assert.equal(save.ok, false);
  assert.match(save.error, /EROFS/);
});

test('an unreadable root degrades to an empty index rather than throwing', () => {
  const impls = {
    existsImpl: () => { throw new Error('EACCES'); },
    readdirImpl: () => { throw new Error('EACCES'); },
    statImpl: () => null,
    readFileImpl: () => null,
    writeFileImpl: () => {},
  };
  const state = openIndex('/nope', impls);
  assert.equal(state.index.entries.size, 0);
  assert.deepEqual(definitionsOf(state.index, 'anything'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 — QUERIES
// ─────────────────────────────────────────────────────────────────────────────

test('an exact match wins, and brings the file\'s other exports with it', () => {
  const fx = memoryImpls(SAMPLE);
  const { index } = openIndex('/fake', fx.impls, { save: false });
  const hit = searchSymbols(index, 'alphaOne');
  assert.equal(hit.exact, true);
  assert.deepEqual(hit.matches.map((m) => m.path), ['src/alpha.mjs']);
  assert.deepEqual(hit.matches[0].siblings, ['alphaTwo']);
});

test('a near miss returns names that EXIST — never a bare "not found"', () => {
  const fx = memoryImpls(SAMPLE);
  const { index } = openIndex('/fake', fx.impls, { save: false });
  const miss = searchSymbols(index, 'alphaone');
  assert.equal(miss.exact, false);
  assert.deepEqual(miss.suggestions.map((s) => s.name), ['alphaOne']);

  const prefix = searchSymbols(index, 'alpha');
  assert.deepEqual(prefix.suggestions.map((s) => s.name), ['alphaOne', 'alphaTwo']);
});

test('a query answers identically twice, and is sorted by code point', () => {
  const fx = memoryImpls({
    'z.mjs': 'export function shared() {}',
    'a.mjs': 'export function shared() {}',
    'm.mjs': 'export function shared() {}',
  });
  const { index } = openIndex('/fake', fx.impls, { save: false });
  const one = searchSymbols(index, 'shared');
  const two = searchSymbols(index, 'shared');
  assert.deepEqual(one.matches.map((m) => m.path), ['a.mjs', 'm.mjs', 'z.mjs']);
  assert.deepEqual(one, two);
});

test('limit is capped and never returns an unbounded list', () => {
  const files = {};
  for (let i = 0; i < 80; i++) files[`f${String(i).padStart(3, '0')}.mjs`] = 'export function shared() {}';
  const fx = memoryImpls(files);
  const { index } = openIndex('/fake', fx.impls, { save: false });
  assert.equal(searchSymbols(index, 'shared', { limit: 9999 }).matches.length, 50);
  assert.equal(searchSymbols(index, 'shared').matches.length, 10);
  assert.equal(searchSymbols(index, 'shared').total, 80);
});

test('symbolsOf distinguishes "not indexed" from "defines nothing"', () => {
  const fx = memoryImpls({ 'a.mjs': 'const private1 = 1;', 'b.mjs': 'export const b = 1;' });
  const { index } = openIndex('/fake', fx.impls, { save: false });
  assert.deepEqual(symbolsOf(index, 'a.mjs'), []);
  assert.equal(symbolsOf(index, 'never/seen.mjs'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10 — THE TOOL
// ─────────────────────────────────────────────────────────────────────────────

test('the schema is the shape tools.mjs pushes, and names one tool', () => {
  const schemas = repoIndexToolSchemas();
  assert.equal(schemas.length, 1);
  const [s] = schemas;
  assert.equal(s.type, 'function');
  assert.equal(s.function.name, 'find_symbol');
  assert.equal(s.function.parameters.type, 'object');
  assert.deepEqual(s.function.parameters.required, ['name']);
  // ⭐ The description has to tell the model WHEN to reach for it, not just what
  // it is — an option is not a default.
  assert.match(s.function.description, /search_text/);
  assert.match(s.function.description, /regex, not a parser/);
});

test('the tool answers a real question against a real tree', () => {
  const root = fixture(SAMPLE);
  try {
    const result = executeRepoIndexTool('find_symbol', { name: 'gammaGo' }, { root });
    assert.equal(result.ok, true);
    assert.deepEqual(result.definitions, [{ path: 'src/deep/gamma.ts', alsoDefines: ['GammaShape'] }]);
    assert.equal(result.total, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the tool refuses usefully — never "ok:false" with no next move', () => {
  const root = fixture(SAMPLE);
  try {
    assert.match(executeRepoIndexTool('find_symbol', {}, { root }).error, /pass the symbol name/);
    assert.match(executeRepoIndexTool('nope', { name: 'x' }, { root }).error, /unknown tool/);
    // An in-memory executor has no root — the reply names the verb to use instead.
    const memory = executeRepoIndexTool('find_symbol', { name: 'x' }, {});
    assert.equal(memory.ok, false);
    assert.match(memory.error, /search_text/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a miss through the tool carries suggestions, not a dead end', () => {
  const root = fixture(SAMPLE);
  try {
    const result = executeRepoIndexTool('find_symbol', { name: 'alphaOn' }, { root });
    assert.equal(result.ok, true);
    assert.deepEqual(result.definitions, []);
    assert.deepEqual(result.didYouMean.map((s) => s.name), ['alphaOne']);
    assert.match(result.note, /did you mean/i);

    const nothing = executeRepoIndexTool('find_symbol', { name: 'zzzNotHere' }, { root });
    assert.deepEqual(nothing.definitions, []);
    assert.equal(nothing.didYouMean, undefined);
    assert.match(nothing.note, /search_text/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * ── ⚠️⚠️ `--dry-run` PROMISES NOTHING APPEARS ON DISK, AND A CACHE IS A FILE ─
 *
 * `openIndex` writes `.acuvo/index/symbols.json`. Every other read verb in the
 * dispatcher writes nothing at all, so nobody would think to check this one —
 * which is exactly why it is asserted rather than assumed.
 *
 * ⭐ AND THE RULE LIVES IN `executeRepoIndexTool`, NOT AT THE CALL SITE, so
 * this test binds the behaviour every door gets: the CLI dispatcher, the MCP
 * server (which dispatches through the same seam) and a library embedder.
 */
test('⚠️ a dry run answers the question and writes NOTHING to disk', () => {
  const root = fixture(SAMPLE);
  try {
    const dry = executeRepoIndexTool('find_symbol', { name: 'gammaGo' }, { root, dryRun: true });
    assert.equal(dry.ok, true, 'a dry run must still answer — withholding the answer is not the promise');
    assert.deepEqual(dry.definitions, [{ path: 'src/deep/gamma.ts', alsoDefines: ['GammaShape'] }]);
    assert.equal(
      statSync(join(root, INDEX_REL_PATH), { throwIfNoEntry: false }),
      undefined,
      `--dry-run wrote ${INDEX_REL_PATH} into the workspace`,
    );

    // …and the ordinary path DOES cache, or the assertion above passes for the
    // wrong reason (a tool that never writes would satisfy it forever).
    executeRepoIndexTool('find_symbol', { name: 'gammaGo' }, { root });
    assert.ok(
      statSync(join(root, INDEX_REL_PATH), { throwIfNoEntry: false })?.isFile(),
      'the ordinary path never wrote the index, so the dry-run assertion proves nothing',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the tool result carries no clock, no duration and no run counter', () => {
  const root = fixture(SAMPLE);
  try {
    const a = executeRepoIndexTool('find_symbol', { name: 'alphaOne' }, { root });
    const b = executeRepoIndexTool('find_symbol', { name: 'alphaOne' }, { root });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.doesNotMatch(JSON.stringify(a), /ms\b|elapsed|took|Date|20\d\d-/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
