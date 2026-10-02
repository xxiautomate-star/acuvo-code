import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRenderReport, ruler } from '../lib/render-report.mjs';

/**
 * ⚠️ THE REPORT EXISTS TO BE PASTED INTO A CHAT, so the properties that matter
 * are about legibility in that medium — no escape codes, no colour, and an
 * honest "unknown" wherever nothing could be measured. A diagnostic that
 * asserts a comfortable default is worse than none: it argues with the person
 * looking at the broken screen.
 */

const base = {
  columns: 80, rows: 24, isTTY: true, stdinIsTTY: true,
  blockCellWidth: 1, asciiCellWidth: 1, style: 'blocks',
  env: { TERM: 'xterm-256color' }, version: '1.2.3',
};

test('⭐ the ruler marks tens and fives so an off-by-N is visible', () => {
  const r = ruler(20);
  assert.equal(r.length, 20);
  assert.equal(r[9], '1', 'column 10 should be marked 1');
  assert.equal(r[19], '2', 'column 20 should be marked 2');
  assert.equal(r[4], '+', 'column 5 should be a tick');
});

test('⚠️ absurd widths fall back or clamp — never allocate unbounded', () => {
  /**
   * ⚠️ 0 IS NOT A WIDTH, so it takes the default rather than producing a
   * one-character ruler nobody can read. The property that matters is the
   * upper bound: a terminal reporting a nonsense width must not make this
   * build a 10^9-character string.
   */
  assert.equal(ruler(0).length, 80, '0 is nonsense and should fall back to the default');
  assert.equal(ruler(1e9).length, 400, 'the upper clamp is the one that protects memory');
  assert.equal(ruler(undefined).length, 80);
});

test('⭐⭐⭐ NOTHING measured is reported as a comfortable default', () => {
  /**
   * A null cell width means the terminal did not answer the probe. Printing
   * "1" there would assert the blocks are safe on the one terminal where we
   * could not tell — which is exactly the machine most likely to be the broken
   * one.
   */
  const out = formatRenderReport({ ...base, blockCellWidth: null, asciiCellWidth: null, columns: null, rows: null });
  assert.match(out, /block glyph width\s+unknown/);
  assert.match(out, /ascii glyph width\s+unknown/);
  assert.match(out, /terminal size\s+unknown x unknown/);
});

test('⚠️⚠️ the report carries NO escape codes — it is meant to be pasted', () => {
  const out = formatRenderReport(base);
  assert.doesNotMatch(out, /\x1b/, 'an escape code leaked into a report meant for a chat window');
});

test('⭐ it names the two numbers the diagnosis turns on', () => {
  const out = formatRenderReport(base);
  assert.match(out, /block glyph width\s+1 cell/);
  assert.match(out, /chosen mark\s+blocks/);
});

test('⚠️ an environment with nothing set says so rather than printing a blank', () => {
  const out = formatRenderReport({ ...base, env: { TERM: null, COLORTERM: null } });
  assert.match(out, /none of the relevant variables are set/);
});

test('⭐⭐ the banner it prints obeys the width it reports', () => {
  for (const columns of [30, 60, 80, 120]) {
    const out = formatRenderReport({ ...base, columns });
    for (const line of out.split('\n')) {
      assert.ok(line.length <= Math.max(columns, 78), `a ${line.length}-char line at ${columns} columns`);
    }
  }
});
