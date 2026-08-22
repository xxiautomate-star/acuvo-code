/**
 * ── ⚠️⚠️ CLAMPED JSON IS UNPARSEABLE JSON ───────────────────────────────────
 *
 * 39 of the 63 dispatched tools have no formatter in `toolResultText`, and
 * neither does any MCP result (their names are `mcp__<server>__<tool>`, so no
 * case can match). All of them went through
 * `clampOutput(JSON.stringify(result))`.
 *
 * `clampOutput` is right for prose: 35% head, 65% tail, with
 * `… N characters omitted …` spliced between. On a serialised OBJECT that
 * splice lands mid-structure and the reply stops being JSON. Measured on
 * `git_diff` against an ordinary 400-line refactor: 8,030 characters that
 * `JSON.parse` rejects. The model then reads a broken object and infers fields.
 *
 * ⭐ `stringifyForModel` shrinks the large string FIELDS instead of the syntax,
 * so the reply stays valid and every flag, count and cursor survives — those
 * are the bytes that must never be the ones sacrificed.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { readFileSync } from 'node:fs';

import { stringifyForModel } from '../lib/model-json.mjs';

const MAX = 8_000;
const parses = (s) => { try { JSON.parse(s); return true; } catch { return false; } };

test('⚠️⚠️ an oversized result is still valid JSON', () => {
  const out = stringifyForModel({ ok: true, diff: 'x'.repeat(30_000), truncated: false }, MAX);
  assert.ok(parses(out), 'the model was handed something JSON.parse rejects');
  assert.ok(out.length <= MAX, `${out.length} chars exceeds the ${MAX} ceiling`);
});

test('⭐ the flags survive — they are never what gets sacrificed', () => {
  /**
   * The whole point. `nextPage` and `truncated` are a handful of bytes that
   * change what the model does next; `diff` is the payload. Cutting the former
   * to preserve the latter is exactly backwards, and is what an earlier bug did
   * when `read_document` rendered one page of four with `"nextPage":null`.
   */
  const out = JSON.parse(stringifyForModel(
    { ok: true, path: 'src/app.ts', diff: 'x'.repeat(30_000), truncated: true, nextPage: 3 },
    MAX,
  ));
  assert.equal(out.ok, true);
  assert.equal(out.path, 'src/app.ts');
  assert.equal(out.truncated, true);
  assert.equal(out.nextPage, 3, 'the pagination cursor was lost, so the model stops reading');
});

test('⭐ and the cut says so, inside the field it cut', () => {
  const out = JSON.parse(stringifyForModel({ ok: true, diff: 'x'.repeat(30_000) }, MAX));
  assert.match(out.diff, /characters omitted/, 'the diff was silently shortened');
  assert.ok(out.diff.length < 30_000);
});

test('⚠️ a result that already fits is passed through UNCHANGED', () => {
  /**
   * The find-nothing half, and the one that protects 39 tools' ordinary path.
   * If this ever differs from `JSON.stringify`, every small tool result in the
   * binary silently changed shape — including the ones with tests that pin
   * exact strings.
   */
  const small = { ok: true, path: 'a.ts', bytes: 12, created: false };
  assert.equal(stringifyForModel(small, MAX), JSON.stringify(small));
});

test('⭐ only the LARGEST field pays', () => {
  /**
   * A budget divided evenly would mangle a 40-char `path` to save a 9KB `diff`.
   * Shrink the biggest, re-measure, stop as soon as it fits.
   */
  const out = JSON.parse(stringifyForModel(
    { ok: true, summary: 'y'.repeat(400), diff: 'x'.repeat(30_000) },
    MAX,
  ));
  assert.equal(out.summary, 'y'.repeat(400), 'a small field was cut while a huge one remained');
});

test('⭐ strings nested inside arrays are found too', () => {
  // `read_table`, `gh_pr` and most MCP results nest their payload one level down.
  const out = JSON.parse(stringifyForModel(
    { ok: true, count: 1, items: [{ name: 'a', body: 'y'.repeat(20_000) }] },
    MAX,
  ));
  assert.equal(out.count, 1);
  assert.ok(out.items[0].body.length < 20_000);
  assert.equal(out.items[0].name, 'a');
});

test('⚠️⚠️ it does NOT mutate the live result object', () => {
  /**
   * This renders an object the caller keeps using — the transcript writer and
   * the usage recorder both read it afterwards. Truncating in place would
   * corrupt the one record of what the tool actually returned.
   */
  const live = { ok: true, diff: 'z'.repeat(20_000) };
  stringifyForModel(live, MAX);
  assert.equal(live.diff.length, 20_000, 'the live result was truncated in place');
});

test('⚠️ when the size is STRUCTURAL, it says so rather than lying', () => {
  /**
   * Ten thousand tiny rows cannot be reduced by trimming prose. The honest
   * answer is a short note that still parses — not a broken object, and not a
   * confident-looking partial set the model believes is complete.
   */
  const out = stringifyForModel(
    { ok: true, total: 4_000, rows: Array.from({ length: 4_000 }, (_, i) => ({ i, v: i * 2 })) },
    MAX,
  );
  assert.ok(parses(out), 'the structural fallback is not valid JSON either');
  const o = JSON.parse(out);
  assert.equal(o._truncated, true);
  assert.equal(o.total, 4_000, 'the scalar that describes the result was dropped with it');
  assert.match(o._note, /narrower slice/, 'the model is not told how to get the rest');
  assert.ok(!Array.isArray(o.rows), 'a partial row set is being presented as the result');
});

test('⭐ REACH — the default branch actually calls it', () => {
  /**
   * Seven capabilities in this codebase were built end to end and wired to
   * nothing. Comments stripped so the guard cannot match its own explanation.
   */
  const src = readFileSync(new URL('../lib/turn.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /default:\s*\n\s*return stringifyForModel\(result, MAX_TOOL_RESULT_CHARS\);/);
  assert.match(src, /from '\.\/model-json\.mjs'/);
  assert.doesNotMatch(
    src,
    /clampOutput\(JSON\.stringify\(result\)/,
    'the old unparseable path is still there',
  );
});
