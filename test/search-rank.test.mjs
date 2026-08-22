/**
 * ── ⚠️ `search_text` RETURNED MATCHES IN FILESYSTEM WALK ORDER ──────────────
 *
 * Measured 2026-08-18: `searchText` pushes hits as the directory walk yields
 * them and caps at `MAX_MATCHES = 60`. A model hunting a symbol therefore read
 * whatever the walk reached first, and the DEFINITION landing near the top was
 * luck. That is the "which snippets do we send" half of local code indexing —
 * `repo-map.mjs` already solved the "what exists" half.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
// ⚠️ `require` does not exist in an ESM test file — the first version of the
// reach check used it and failed for that reason rather than for the thing it
// was checking, which is the most misleading way for a guard to go red.
import { readFileSync } from 'node:fs';
import { rankMatches, identifierFrom } from '../lib/search-rank.mjs';

const m = (path, line) => ({ path, line });

test('the identifier is the LAST word, not the first', () => {
  // A model searches `export function assemble` — the qualifier leads, the
  // thing it wants trails.
  assert.equal(identifierFrom('export function assembleSystemMessage'), 'assembleSystemMessage');
  assert.equal(identifierFrom('class\\s+Workspace'), 'Workspace');
  assert.equal(identifierFrom('rankMatches'), 'rankMatches');
  assert.equal(identifierFrom(''), '');
});

test('a definition outranks every mention of the same name', () => {
  const out = rankMatches([
    m('lib/caller.mjs', '  const r = rankMatches(hits, pattern);'),
    m('lib/other.mjs', '  return rankMatches(x);'),
    m('lib/search-rank.mjs', 'export function rankMatches(matches, pattern) {'),
  ], 'rankMatches');
  assert.equal(out[0].path, 'lib/search-rank.mjs');
});

test('a file named for the symbol is treated as its home', () => {
  const out = rankMatches([
    m('lib/zzz/deep/thing.mjs', 'workspace.write()'),
    m('lib/workspace.mjs', 'workspace.write()'),
  ], 'workspace');
  assert.equal(out[0].path, 'lib/workspace.mjs');
});

test('⚠️ tests are DEMOTED, not excluded — sometimes they are the answer', () => {
  const out = rankMatches([
    m('test/turn.test.mjs', 'const x = buildPrompt();'),
    m('lib/turn.mjs', 'const x = buildPrompt();'),
  ], 'buildPrompt');
  assert.equal(out[0].path, 'lib/turn.mjs');
  // Still present — a filter would lose "where is this tested".
  assert.equal(out.length, 2);
  // And a DEFINITION inside a test still beats a bare mention in source.
  const strong = rankMatches([
    m('lib/a.mjs', 'helper();'),
    m('test/a.test.mjs', 'export function helper() {}'),
  ], 'helper');
  assert.equal(strong[0].path, 'test/a.test.mjs');
});

test('shallow paths beat deep ones at equal strength', () => {
  const out = rankMatches([
    m('a/b/c/d/e/f.mjs', 'thing()'),
    m('lib/f.mjs', 'thing()'),
  ], 'thing');
  assert.equal(out[0].path, 'lib/f.mjs');
});

test('⚠️⚠️ STABLE — equal scores keep walk order', () => {
  /**
   * A search whose order shuffled between identical runs would void the prompt
   * cache on every round that ran one. `repo-map.mjs` sorts by code point for
   * the same reason.
   */
  const input = [m('a.mjs', 'x()'), m('b.mjs', 'x()'), m('c.mjs', 'x()')];
  const once = rankMatches(input, 'x').map((r) => r.path);
  const twice = rankMatches(input, 'x').map((r) => r.path);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, ['a.mjs', 'b.mjs', 'c.mjs']);
});

test('⚠️ it never adds, drops or alters a match', () => {
  // Anything else would make `total` and `nextOffset` lie.
  const input = [m('a.mjs', 'q()'), m('b.mjs', 'export const q = 1'), m('c.mjs', 'q()')];
  const out = rankMatches(input, 'q');
  assert.equal(out.length, input.length);
  assert.deepEqual([...out].sort((x, y) => x.path.localeCompare(y.path)), [...input].sort((x, y) => x.path.localeCompare(y.path)));
});

test('a pattern with regex metacharacters does not blow up the scorer', () => {
  // The pattern comes from a model; `identifierFrom` strips punctuation but the
  // scorer must be safe even if something odd survives.
  assert.doesNotThrow(() => rankMatches([m('a.mjs', 'x'), m('b.mjs', 'y')], 'foo.*+?[](){}|^$'));
});

test('one match or none is returned untouched', () => {
  assert.deepEqual(rankMatches([], 'x'), []);
  const one = [m('a.mjs', 'x')];
  assert.equal(rankMatches(one, 'x'), one);
});

test('⭐ the ranker is REACHED from searchText, not merely exported', () => {
  // Declared-but-unwired is this repo's most expensive recurring defect.
  const src = readFileSync(new URL('../lib/search.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ rankMatches \} from '\.\/search-rank\.mjs'/);
  assert.match(src, /matches: rankMatches\(matches, pattern\)/);
});
