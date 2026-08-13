/**
 * ── ⭐⭐ WHAT THE MODEL ACTUALLY RECEIVES FROM A TOOL ─────────────────────────
 *
 * `toolResultText` is the hottest rendering path in the binary and it had a
 * `default:` branch clamping to 2,000 characters while every formatted branch
 * used 8,000. Measured in this repository before the fix: `search_text` for
 * `export function` found 60 matches, produced 10,281 characters of JSON, and
 * delivered 2,000 of them — **16 matches, 27%, cut mid-structure so the result
 * did not even parse**.
 *
 * ⚠️ Nothing failed. No error, no warning; the agent simply searched at a
 * quarter strength on every install, forever.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { toolResultText } from '../lib/turn.mjs';

const matchList = (n) => Array.from({ length: n }, (_, i) => ({
  path: `lib/module-${i}.mjs`,
  line: i + 1,
  text: `export function thing${i}() { /* a line of real length, as a search hit has */ }`,
}));

test('⭐⭐ every match a search found reaches the model, not a quarter of them', () => {
  const record = {
    name: 'search_text',
    result: {
      ok: true, pattern: 'export function', matches: matchList(60), total: 60,
      scanned: 1919, countCapped: false, nextOffset: null,
    },
  };
  const text = toolResultText(record);
  const delivered = text.split('\n').filter((l) => /^\S+:\d+: /.test(l)).length;

  assert.equal(delivered, 60, `only ${delivered} of 60 matches reached the model`);
  assert.match(text, /60 matches for export function in 1919 files/, 'the model must know how many there were in total');
});

test('⚠️ the formatted form is what buys the room — raw JSON spends it on punctuation', () => {
  const result = {
    ok: true, pattern: 'x', matches: matchList(60), total: 60, scanned: 10, countCapped: false, nextOffset: null,
  };
  const rendered = toolResultText({ name: 'search_text', result });
  assert.ok(
    rendered.length < JSON.stringify(result).length,
    'path:line: text must be smaller than the JSON carrying the same matches',
  );
});

test('⚠️ the "there is more" hint survives the clamp — it is what stops a false conclusion', () => {
  // Far more matches than any budget can carry.
  const record = {
    name: 'search_text',
    result: {
      ok: true, pattern: 'x', matches: matchList(4_000), total: 4_000,
      scanned: 10, countCapped: true, nextOffset: 60,
    },
  };
  const text = toolResultText(record);
  assert.match(
    text,
    /call search_text again with offset 60/,
    'a truncated search that does not say it was truncated teaches the model it has seen everything',
  );
});

test('a search with no matches says so, and says what was scanned', () => {
  const text = toolResultText({ name: 'search_text', result: { ok: true, pattern: 'nope', matches: [], total: 0, scanned: 500 } });
  assert.match(text, /no matches for nope/);
  assert.match(text, /500 files/, '"nothing found" is only actionable if you know how hard it looked');
});

test('⭐ git_status renders through formatStatusForModel, which had ZERO callers', () => {
  const record = {
    name: 'git_status',
    result: { ok: true, branch: 'main', clean: false, files: [{ path: 'src/a.ts', staged: false, untracked: true, code: '??' }] },
  };
  const text = toolResultText(record);
  assert.match(text, /branch main/);
  assert.match(text, /untracked\s+src\/a\.ts/);
  assert.ok(!text.includes('"untracked":true'), 'the raw JSON shape must not be what reaches the model');
});

test('⚠️⚠️ the DEFAULT branch is no poorer than the formatted ones', () => {
  /**
   * 29 of the 48 tools fall through `default:`, plus every MCP result — their
   * names are `mcp__<server>__<tool>`, so no case can ever match one. They are
   * unformatted because nobody has got to them yet, which is an argument for
   * more room rather than less.
   */
  const big = { ok: true, blob: 'y'.repeat(20_000) };
  const text = toolResultText({ name: 'mcp__somewhere__something', result: big });
  assert.ok(text.length > 4_000, `an MCP result was clamped to ${text.length} characters — the 2,000 default is back`);
});
