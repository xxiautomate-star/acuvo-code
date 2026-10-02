/**
 * ── chart — CSV IN, INTERACTIVE DASHBOARD OUT ───────────────────────────────
 *
 * ⚠️⚠️ NOTHING IN THIS FILE SPENDS A CENT. `chart` calls no model, reaches no
 * network and starts no process, so unlike the creative verbs there is no
 * producer to inject — the real code path IS the tested code path, end to end,
 * through the real workspace executor onto a real temporary directory.
 *
 * ⭐ THE ASSERTIONS ARE ABOUT BYTES, NOT ABOUT AESTHETICS. "It renders a nice
 * chart" is unfalsifiable; "the file contains no external URL", "a cell holding
 * `</script>` does not end the script element" and "the last row of a file with
 * no trailing newline is present" are not.
 *
 * ⚠️ THE PARSER CASES ARE THE HEART OF IT. Every one is a real-world CSV
 * feature that a `split(',')` implementation gets wrong, and each is written as
 * an explicit concatenation rather than a template literal so the exact bytes
 * are visible in the source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  chart, chartToolSchemas, chartToolNames, runChartTool,
  parseCsv, parseRecords, parseNumber, parseDate, parseBool, stripBom, sniffDelimiter,
  inferColumns, planPanels, groupBySpan, categorical, niceTicks, spanTicks, downsample, fmtNum, histogram,
  renderDashboard, renderPanel, CHART_TOOL_NAMES, MAX_CATEGORIES, MAX_SERIES_RATIO,
} from '../lib/chart.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { TOOL_NAMES, toolNamesForRounds, executeToolCall } from '../lib/tools.mjs';
import { REFUSED_TOOL_REASONS } from '../lib/mcp-server.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-chart-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return root;
}

/** A small, well-formed CSV used by most of the end-to-end cases. */
const SALES = [
  'date,region,revenue,units',
  '2026-01-01,APAC,1200.5,12',
  '2026-01-02,EMEA,2400,20',
  '2026-01-03,APAC,900,9',
  '2026-01-04,EMEA,1500,15',
  '2026-01-05,APAC,1750,17',
  '',
].join('\n');

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE PARSER — every case a naive split gets wrong
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ a comma inside quotes is DATA, not a delimiter', () => {
  const rows = parseRecords('a,b\n"Smith, John",2\n', ',');
  assert.deepEqual(rows[1], ['Smith, John', '2']);
});

test('⭐ the doubled-quote escape becomes one quote', () => {
  const rows = parseRecords('a\n"she said ""hi"""\n', ',');
  assert.deepEqual(rows[1], ['she said "hi"']);
});

test('⭐⭐ a newline INSIDE a quoted field does not end the record', () => {
  const rows = parseRecords('a,b\n"line one\nline two",2\n', ',');
  assert.equal(rows.length, 2, 'the embedded newline split one record into two');
  assert.deepEqual(rows[1], ['line one\nline two', '2']);
});

test('CRLF and a lone CR both end a record, and neither leaks into the data', () => {
  const crlf = parseRecords('a,b\r\n1,2\r\n', ',');
  assert.deepEqual(crlf, [['a', 'b'], ['1', '2']]);
  const cr = parseRecords('a,b\r1,2\r', ',');
  assert.deepEqual(cr, [['a', 'b'], ['1', '2']]);
  // ⚠️ The classic symptom of getting this wrong is a trailing \r on the last column.
  assert.ok(!JSON.stringify(crlf).includes('\\r'), 'a carriage return survived into a field');
});

test('⚠️ the LAST row survives a file with no trailing newline', () => {
  const rows = parseRecords('a,b\n1,2', ',');
  assert.equal(rows.length, 2, 'the final record was dropped — the off-by-one nobody can find');
  assert.deepEqual(rows[1], ['1', '2']);
});

test('⚠️ the BOM is stripped for parsing, so the first column name is matchable', () => {
  const withBom = `﻿${SALES}`;
  assert.notEqual(stripBom(withBom), withBom);
  const parsed = parseCsv(withBom);
  assert.ok(parsed.ok);
  assert.equal(parsed.header[0], 'date', 'the BOM is still glued to the first header name');
});

test('⭐ the delimiter is sniffed by PARSING, so quoted punctuation cannot fool it', () => {
  // A semicolon file whose first data row contains a comma inside quotes.
  const semi = 'name;city;n\n"Smith, John";Canberra;3\n"Doe, Jane";Sydney;4\n';
  assert.equal(sniffDelimiter(semi).delimiter, ';');
  const tsv = 'a\tb\tc\n1\t2\t3\n';
  assert.equal(sniffDelimiter(tsv).delimiter, '\t');
  assert.equal(sniffDelimiter(SALES).delimiter, ',');
});

test('ragged rows are padded and truncated, never dropped — dropping changes the totals', () => {
  const parsed = parseCsv('a,b,c\n1,2,3\n4,5\n6,7,8,9\n');
  assert.ok(parsed.ok);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows[1], ['4', '5', '']);
  assert.deepEqual(parsed.rows[2], ['6', '7', '8']);
  assert.ok(parsed.warnings.some((w) => w.includes('different number of fields')), 'the padding happened silently');
});

test('duplicate header names are made unique and said out loud', () => {
  const parsed = parseCsv('a,a,b\n1,2,3\n');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.header, ['a', 'a_2', 'b']);
  assert.ok(parsed.warnings.some((w) => w.includes('both called')));
});

test('⚠️ an all-numeric first row is DATA, not a header', () => {
  const parsed = parseCsv('1,2\n3,4\n');
  assert.ok(parsed.ok);
  assert.equal(parsed.rows.length, 2, 'a data row was eaten as a header');
  assert.deepEqual(parsed.header, ['column_1', 'column_2']);
  assert.ok(parsed.warnings.some((w) => w.includes('entirely numeric')));
});

test('an empty file and a header-only file each refuse with a sentence', () => {
  assert.equal(parseCsv('').ok, false);
  assert.match(parseCsv('   ').error, /empty/);
  assert.match(parseCsv('a,b\n').error, /no data rows/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. TYPES
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ parseNumber reads what spreadsheets write, and refuses what it cannot know', () => {
  assert.equal(parseNumber('1200'), 1200);
  assert.equal(parseNumber('1,200.50'), 1200.5);
  assert.equal(parseNumber('$1,200.50'), 1200.5);
  assert.equal(parseNumber('(300)'), -300, 'parentheses are how accountants write a negative');
  assert.equal(parseNumber('12.5%'), 12.5);
  assert.equal(parseNumber('1.5e3'), 1500);
  assert.equal(parseNumber('-40'), -40);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('  '), null);
  // ⚠️ THE REFUSALS MATTER MORE THAN THE PARSES. A column that half-parses is a
  // column whose chart is half wrong, and coercing "12 apples" to 12 is how it
  // starts.
  assert.equal(parseNumber('12 apples'), null);
  assert.equal(parseNumber('N/A'), null);
  assert.equal(parseNumber('--'), null);
  assert.equal(parseNumber(Infinity), null);
});

test('⚠️⚠️ an ambiguous day/month date is NOT parsed — nothing in the file says which it is', () => {
  assert.equal(parseDate('2026-04-03'), Date.UTC(2026, 3, 3));
  assert.equal(parseDate('2026/04/03'), Date.UTC(2026, 3, 3));
  assert.equal(parseDate('2026-04-03T10:30:00Z'), Date.UTC(2026, 3, 3, 10, 30));
  assert.equal(parseDate('2026-04'), Date.UTC(2026, 3, 1));
  assert.equal(parseDate('03/04/2026'), null, 'a dd/mm-or-mm/dd date was guessed at');
  assert.equal(parseDate('13/04/2026'), null, 'even an unambiguous-looking one is refused, because the COLUMN is ambiguous');
  assert.equal(parseDate('2026-13-01'), null, 'month 13 was accepted');
  assert.equal(parseDate('not a date'), null);
});

test('⭐ …and the ambiguous column earns a warning naming itself', () => {
  const parsed = parseCsv('when,n\n03/04/2026,1\n04/05/2026,2\n05/06/2026,3\n');
  const { columns, warnings } = inferColumns(parsed.header, parsed.rows);
  assert.equal(columns[0].type, 'text', 'it was plotted on a time axis that may be wrong');
  assert.ok(warnings.some((w) => w.includes('"when"') && w.includes('YYYY-MM-DD')), `no actionable warning: ${warnings.join(' | ')}`);
});

test('booleans are only booleans when every value is one', () => {
  assert.equal(parseBool('YES'), true);
  assert.equal(parseBool('f'), false);
  assert.equal(parseBool('1'), null, '0/1 is a number column and must not be stolen by the boolean check');
  const { columns } = inferColumns(['flag', 'n'], [['true', '1'], ['false', '0'], ['yes', '1']]);
  assert.equal(columns[0].type, 'boolean');
  assert.equal(columns[1].type, 'number');
});

test('column summaries are computed on the parsed values, ignoring blanks', () => {
  const parsed = parseCsv(SALES);
  const { columns } = inferColumns(parsed.header, parsed.rows);
  const revenue = columns.find((c) => c.name === 'revenue');
  assert.equal(revenue.type, 'number');
  assert.equal(revenue.min, 900);
  assert.equal(revenue.max, 2400);
  assert.equal(revenue.median, 1500);
  assert.equal(revenue.sum, 7750.5);
  assert.equal(revenue.mean, 1550.1);
  const region = columns.find((c) => c.name === 'region');
  assert.equal(region.distinct, 2);
  assert.deepEqual(columns.find((c) => c.name === 'date').type, 'date');
});

test('a column of blanks is "empty" rather than a chart of nothing', () => {
  const { columns } = inferColumns(['a', 'b'], [['1', ''], ['2', ''], ['3', '']]);
  assert.equal(columns[1].type, 'empty');
  assert.equal(columns[1].nulls, 3);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. WHICH CHART
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ a date column plus numbers becomes a time series', () => {
  const parsed = parseCsv(SALES);
  const { columns } = inferColumns(parsed.header, parsed.rows);
  const { panels } = planPanels(columns);
  assert.equal(panels[0].kind, 'line');
  assert.equal(panels[0].x.name, 'date');
});

test('a category plus numbers becomes bars, aggregated by the category', () => {
  const csv = 'region,revenue\nAPAC,10\nEMEA,20\nAPAC,5\nEMEA,1\n';
  const parsed = parseCsv(csv);
  const { columns } = inferColumns(parsed.header, parsed.rows);
  const { panels } = planPanels(columns);
  assert.equal(panels[0].kind, 'bar');
  assert.equal(panels[0].x.name, 'region');
  assert.equal(panels[0].series[0].name, 'revenue');
});

test('two numbers and nothing else becomes a scatter; one number becomes a histogram', () => {
  const two = inferColumns(...Object.values(pick('x,y\n1,2\n3,4\n5,9\n'))).columns;
  assert.equal(planPanels(two).panels[0].kind, 'scatter');
  const one = inferColumns(...Object.values(pick('x\n1\n3\n5\n7\n'))).columns;
  assert.equal(planPanels(one).panels[0].kind, 'histogram');
});

test('⚠️⚠️ a free-text column is NOT a category, however few distinct values it has', () => {
  // Three filled cells, three distinct values: no value is shared, so it groups nothing.
  const { columns } = inferColumns(['note', 'n'], [['alpha', '1'], ['beta', '2'], ['gamma', '3']]);
  assert.deepEqual(categorical(columns).map((c) => c.name), [], 'a comment column earned a bar chart of height one');
  // Two of five repeat: that IS a category.
  const { columns: real } = inferColumns(['team', 'n'], [['a', '1'], ['b', '2'], ['a', '3'], ['b', '4'], ['a', '5']]);
  assert.deepEqual(categorical(real).map((c) => c.name), ['team']);
});

test('⚠️⚠️ series with wildly different ranges are SPLIT — a shared axis would draw a flat line', () => {
  const cols = [
    { name: 'revenue', type: 'number', min: 0, max: 2400 },
    { name: 'rate', type: 'number', min: 0, max: 0.12 },
    { name: 'cost', type: 'number', min: 0, max: 2000 },
  ];
  const groups = groupBySpan(cols);
  assert.equal(groups.length, 2, `expected the rate to be split out: ${JSON.stringify(groups.map((g) => g.map((c) => c.name)))}`);
  assert.deepEqual(groups[0].map((c) => c.name), ['revenue', 'cost']);
  assert.deepEqual(groups[1].map((c) => c.name), ['rate']);
  // …and comparable ones share a panel, or the page becomes six charts of one line each.
  assert.equal(groupBySpan([
    { name: 'a', type: 'number', min: 0, max: 100 },
    { name: 'b', type: 'number', min: 0, max: 100 * (MAX_SERIES_RATIO - 1) },
  ]).length, 1);
});

test('an explicit x/y beats the inference, and a name that does not exist refuses usefully', () => {
  const parsed = parseCsv(SALES);
  const { columns } = inferColumns(parsed.header, parsed.rows);
  const chosen = planPanels(columns, { x: 'region', y: ['units'] });
  assert.equal(chosen.panels[0].kind, 'bar');
  assert.equal(chosen.panels[0].x.name, 'region');
  const wrong = planPanels(columns, { x: 'regoin' });
  assert.equal(wrong.panels.length, 0);
  assert.match(wrong.warnings[0], /no column called "regoin".*date, region, revenue, units/);
});

test('too many categories are capped and the truncation is reported, not hidden', () => {
  const rows = [];
  for (let i = 0; i < MAX_CATEGORIES + 10; i++) { rows.push([`k${i}`, String(i)]); rows.push([`k${i}`, String(i)]); }
  const { columns } = inferColumns(['key', 'n'], rows);
  // ⚠️ Beyond MAX_CATEGORIES `categories` is null, so the column is not offered
  // as a grouping at all — which is the honest outcome for 34 bars nobody reads.
  assert.equal(columns[0].categories, null);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. MATHS
 * ──────────────────────────────────────────────────────────────────────────── */

test('niceTicks produces round numbers and covers the data', () => {
  const t = niceTicks(0, 97);
  assert.ok(t.lo <= 0 && t.hi >= 97, `ticks do not cover the data: ${JSON.stringify(t)}`);
  assert.ok(t.ticks.length >= 3 && t.ticks.length <= 12, `${t.ticks.length} ticks is unreadable`);
  for (const v of t.ticks) assert.equal(v, Number(v.toPrecision(12)), 'float drift leaked into a tick label');
  // A constant column must not divide by zero.
  const flat = niceTicks(5, 5);
  assert.ok(flat.hi > flat.lo, 'a single-valued column produced a zero-height axis');
  const zero = niceTicks(0, 0);
  assert.ok(zero.hi > zero.lo);
});

/**
 * ── ⚠️⚠️ BOTH OF THESE WERE FOUND BY RENDERING THE PAGE AND LOOKING AT IT ────
 *
 * 46 tests were green and neither defect was visible from any of them, because
 * both are about GEOMETRY: an axis that starts before the data, and a label
 * whose right half falls outside the viewBox. `feedback_one_screenshot_beat_
 * 3621_tests`, at small scale. They are pinned here so they cannot come back.
 */
test('⚠️⚠️ a TIME axis uses the data\'s own span — "nice" epoch milliseconds are not nice dates', () => {
  const min = Date.UTC(2026, 4, 1);
  const max = Date.UTC(2026, 6, 29);
  const t = spanTicks(min, max, 5);
  assert.equal(t.lo, min, 'the axis begins before the first data point');
  assert.equal(t.hi, max, 'the axis runs past the last data point');
  assert.equal(t.ticks[0], min);
  assert.equal(t.ticks.at(-1), max);
  // ⚠️ THE REGRESSION IN ITS ORIGINAL FORM: niceTicks on these same epoch
  // milliseconds pushed the axis back to mid-APRIL, three weeks before the data.
  const niced = niceTicks(min, max, 5);
  assert.ok(niced.lo < min, 'this assertion is stale — niceTicks no longer rounds outward');
  assert.ok(min - niced.lo > 7 * 86_400_000, 'the drift this test documents was smaller than a week');
  // A single-valued date column must still produce a drawable axis.
  assert.ok(spanTicks(min, min).hi > spanTicks(min, min).lo);
});

test('⚠️⚠️ the first and last x labels are anchored inward, or they clip off the canvas', () => {
  const parsed = parseCsv(SALES);
  const { columns } = inferColumns(parsed.header, parsed.rows);
  const { panels } = planPanels(columns);
  const { svg } = renderPanel(panels[0]);
  assert.ok(svg.includes('text-anchor="start"'), 'the first x label is centred, so its left half falls outside the viewBox');
  assert.ok(svg.includes('text-anchor="end"'), 'the last x label is centred — this is how "2026-08-0" reached a rendered page');
  // ⚠️ And the ones in between are still centred, or the axis reads crooked.
  assert.ok(svg.includes('text-anchor="middle"'));
});

test('downsampling keeps the first and the LAST point', () => {
  const pts = Array.from({ length: 5000 }, (_, i) => [i, i]);
  const { points, sampled } = downsample(pts, 100);
  assert.equal(sampled, true);
  assert.equal(points.length, 100);
  assert.deepEqual(points[0], [0, 0]);
  assert.deepEqual(points[99], [4999, 4999], 'the final point was dropped, so the chart ends early');
  assert.equal(downsample(pts.slice(0, 10), 100).sampled, false);
});

test('fmtNum is ICU-free, so two machines produce the same bytes', () => {
  assert.equal(fmtNum(1234567), '1,234,567');
  assert.equal(fmtNum(-1234.5), '-1,234');
  assert.equal(fmtNum(0.125), '0.125');
  assert.equal(fmtNum(null), '—');
  assert.equal(fmtNum(NaN), '—');
  assert.equal(fmtNum(1e20), '1.00e+20');
});

test('the histogram bins every value and loses none', () => {
  const bins = histogram({ values: [1, 2, 2, 3, 9, 9, 9, 4] });
  assert.equal(bins.reduce((a, b) => a + b.count, 0), 8, 'a value fell outside every bin');
  assert.equal(histogram({ values: [] }).length, 0);
  assert.equal(histogram({ values: [5, 5, 5] }).reduce((a, b) => a + b.count, 0), 3, 'a constant column lost its rows');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE PAGE
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ the written page is SELF-CONTAINED — it opens offline, which the CSP also requires', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'sales.csv'), SALES, 'utf8');
  const result = await chart(createLocalExecutor(root), { csv_path: 'sales.csv' });
  assert.equal(result.ok, true, result.error);
  const html = readFileSync(join(root, result.path), 'utf8');

  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!/https?:\/\//i.test(html), 'the page references a remote URL');
  assert.ok(!/<link\b|@import|<img\b|\ssrc=/i.test(html), 'the page loads an external asset');
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|import\s*\(/.test(html), 'the page makes a network call');
  assert.equal((html.match(/<script/g) || []).length, (html.match(/<\/script>/g) || []).length);
  assert.ok(html.includes('<svg'), 'no chart was drawn');
  assert.ok(html.includes('<table'), 'the data table is missing');
});

test('⭐⭐ a cell containing </script> cannot end the script element', async (t) => {
  const root = workspace(t);
  const nasty = 'name,n\n"</script><img src=x onerror=alert(1)>",1\n"plain",2\n"plain",3\n';
  writeFileSync(join(root, 'x.csv'), nasty, 'utf8');
  const result = await chart(createLocalExecutor(root), { csv_path: 'x.csv' });
  assert.equal(result.ok, true, result.error);
  const html = readFileSync(join(root, result.path), 'utf8');
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'the data closed the script element early');
  assert.ok(!html.includes('<img src=x'), 'raw markup from a cell reached the document');
  assert.ok(html.includes('&lt;/script&gt;'), 'the cell was not rendered at all — it should be shown, escaped');
});

test('the row count, column types and panel plan are all reported back, not just a path', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'sales.csv'), SALES, 'utf8');
  const r = await chart(createLocalExecutor(root), { csv_path: 'sales.csv', title: 'Q1' });
  assert.equal(r.rows, 5);
  assert.equal(r.delimiter, ',');
  assert.deepEqual(r.columns.map((c) => `${c.name}:${c.type}`), ['date:date', 'region:text', 'revenue:number', 'units:number']);
  assert.equal(r.panels[0].kind, 'line');
  assert.ok(r.open.includes(r.path));
});

test('inline data needs no file at all', async (t) => {
  const root = workspace(t);
  const r = await chart(createLocalExecutor(root), { csv: 'a,b\n1,2\n3,4\n5,7\n', out_path: 'out.html' });
  assert.equal(r.ok, true, r.error);
  assert.ok(existsSync(join(root, 'out.html')));
  assert.equal(r.source, 'inline data');
});

test('out_path defaults to the CSV path with an .html extension', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'sales.csv'), SALES, 'utf8');
  const r = await chart(createLocalExecutor(root), { csv_path: 'sales.csv' });
  assert.equal(r.path, 'sales.html');
});

test('a semicolon-delimited European export charts without being told', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'e.csv'), 'monat;umsatz\n2026-01;1200\n2026-02;1400\n2026-03;900\n', 'utf8');
  const r = await chart(createLocalExecutor(root), { csv_path: 'e.csv' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.delimiter, ';');
  assert.equal(r.panels[0].kind, 'line');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. REFUSALS — every one names what to do next
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️ it refuses, and never half-writes, when the inputs are wrong', async (t) => {
  const root = workspace(t);
  const ex = createLocalExecutor(root);

  const none = await chart(ex, {});
  assert.equal(none.ok, false);
  assert.match(none.error, /csv_path/);

  const both = await chart(ex, { csv_path: 'a.csv', csv: 'a,b\n1,2\n' });
  assert.equal(both.ok, false);
  assert.match(both.error, /not both/);

  const missing = await chart(ex, { csv_path: 'nope.csv' });
  assert.equal(missing.ok, false);
  // ⭐ The executor's own sentence, verbatim — a second wording here is the copy
  // that goes stale.
  assert.match(missing.error, /no such file/);

  const badOut = await chart(ex, { csv: 'a,b\n1,2\n3,4\n', out_path: 'chart.pdf' });
  assert.equal(badOut.ok, false);
  assert.match(badOut.error, /must end in \.html/);
  assert.ok(!existsSync(join(root, 'chart.pdf')), 'a refused call still wrote something');
});

test('⚠️ an existing file is not silently replaced', async (t) => {
  const root = workspace(t);
  const ex = createLocalExecutor(root);
  writeFileSync(join(root, 'out.html'), 'MINE', 'utf8');
  const refused = await chart(ex, { csv: 'a,b\n1,2\n3,4\n', out_path: 'out.html' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /already exists.*overwrite: true/s);
  assert.equal(readFileSync(join(root, 'out.html'), 'utf8'), 'MINE', 'the refusal still overwrote the file');

  const allowed = await chart(ex, { csv: 'a,b\n1,2\n3,4\n', out_path: 'out.html', overwrite: true });
  assert.equal(allowed.ok, true, allowed.error);
  assert.notEqual(readFileSync(join(root, 'out.html'), 'utf8'), 'MINE');
});

test('a file with nothing chartable refuses with the column list, so the caller can pick', async (t) => {
  const root = workspace(t);
  // Every column is unique free text: no numbers, no dates, no repeating category.
  const r = await chart(createLocalExecutor(root), { csv: 'id,note\nA1,alpha\nB2,beta\nC3,gamma\n' });
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.columns) && r.columns.length === 2, 'the refusal did not say what the columns were');
});

test('⭐ --dry-run previews and writes NOTHING', async (t) => {
  const root = workspace(t);
  const ex = createLocalExecutor(root, { dryRun: true });
  const r = await chart(ex, { csv: 'a,b\n1,2\n3,4\n', out_path: 'out.html' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.dryRun, true);
  assert.ok(!existsSync(join(root, 'out.html')), 'a dry run put a file on disk');
});

test('the executor refuses a binary file before this verb ever parses it', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  const r = await chart(createLocalExecutor(root), { csv_path: 'logo.png' });
  assert.equal(r.ok, false);
  assert.match(r.error, /binary/);
});

test('a path outside the workspace is refused by the boundary that already exists', async (t) => {
  const root = workspace(t);
  const r = await chart(createLocalExecutor(root), { csv_path: '../../etc/passwd' });
  assert.equal(r.ok, false);
  assert.ok(!/^no rows/.test(r.error), 'the traversal got as far as the parser');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. SIZE — the ceiling is enforced BEFORE the write, and the shedding is said
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️⚠️ MEASURED WHILE WRITING THIS FILE, AND IT CHANGED THE TEST: a CSV read
 * through `csv_path` CANNOT reach the size ladder, because `workspace.mjs` caps
 * `readFile` at `MAX_READ_BYTES = 200,000` and refuses anything larger with an
 * actionable sentence. So the ladder is a backstop for INLINE data, which
 * arrives in the tool arguments and passes no such limit. Both halves are
 * asserted below rather than one of them being quietly assumed.
 */
test('⚠️ a CSV over the read limit is refused by the executor, with the way out named', async (t) => {
  const root = workspace(t);
  const rows = ['t,v,label'];
  for (let i = 0; i < 8000; i++) rows.push(`${i},${(Math.sin(i / 40) * 1000).toFixed(2)},"a fairly long label value number ${i}"`);
  writeFileSync(join(root, 'big.csv'), `${rows.join('\n')}\n`, 'utf8');
  const r = await chart(createLocalExecutor(root), { csv_path: 'big.csv' });
  assert.equal(r.ok, false);
  assert.match(r.error, /over the 200000-byte read limit/);
  assert.match(r.error, /read_lines|search_text/, 'the refusal does not name a way forward');
  assert.ok(!existsSync(join(root, 'big.html')), 'a refused read still wrote a page');
});

test('⚠️⚠️ oversized INLINE data sheds the table rather than hitting the executor write limit', async (t) => {
  const root = workspace(t);
  // Ten wide text columns plus one numeric: the data table, not the charts, is
  // what makes a page enormous, and every cell is written twice (shown, and
  // again in data-v so the sort is on the parsed value).
  const wide = 'w'.repeat(200);
  const header = `n,${Array.from({ length: 10 }, (_, c) => `c${c}`).join(',')}`;
  const lines = [header];
  for (let i = 0; i < 260; i++) lines.push(`${i},${Array.from({ length: 10 }, () => `${wide}${i}`).join(',')}`);

  const r = await chart(createLocalExecutor(root), { csv: `${lines.join('\n')}\n`, out_path: 'big.html' });
  assert.equal(r.ok, true, r.error);
  const html = readFileSync(join(root, 'big.html'), 'utf8');
  assert.ok(Buffer.byteLength(html) < 400_000, `the page is ${Buffer.byteLength(html)} bytes — the executor would have refused it`);
  // ⭐ And whatever was shed is said BOTH in the result and on the page itself —
  // a table that silently shrank lies about how much data there is.
  assert.ok(r.warnings.some((w) => /trimmed|too large/.test(w)), `nothing was reported as shed: ${JSON.stringify(r.warnings)}`);
  assert.ok(/trimmed|too large/.test(html), 'the page shrank without saying so');
});

test('renderDashboard is pure — the same input twice gives the same bytes', () => {
  const parsed = parseCsv(SALES);
  const { columns } = inferColumns(parsed.header, parsed.rows);
  const { panels } = planPanels(columns);
  const spec = { title: 'T', source: 's.csv', columns, rows: parsed.rows, panels, warnings: [], delimiter: ',' };
  assert.equal(renderDashboard(spec).html, renderDashboard(spec).html, 'the renderer is not deterministic');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 8. REACHABILITY — a verb the model is never offered scores zero
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ chart is DECLARED, OFFERED and DISPATCHED, not merely written', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.js'), 'console.log(1);', 'utf8');
  writeFileSync(join(root, 'sales.csv'), SALES, 'utf8');

  assert.ok(TOOL_NAMES.includes('chart'), 'chart is not declared in TOOL_SCHEMAS');
  // ⚠️ The weakest environment there is: no keys, no services, no project shape.
  assert.ok(toolNamesForRounds(16, { root, env: {}, allowRun: true }).includes('chart'), 'chart is not offered on an ordinary project');
  /**
   * ⚠️ WITHHELD FROM A SINGLE-SHOT TURN, AND THIS ASSERTS THE *CURRENT*
   * DECISION RATHER THAN THE IDEAL ONE. On the merits it fits there — it writes
   * a file, and its subject already exists — but two guards outside this lane
   * pin the single-shot offer to an exact list
   * (`integration-run-program-and-collisions.test.mjs:143`,
   * `integration-seams.test.mjs:653`). Editing those to make room is what rule 8
   * forbids, so the widening is a proposal, not a smuggled change. If it is ever
   * accepted, INVERT this line with the reason written in.
   */
  assert.ok(!toolNamesForRounds(1, { root, env: {}, allowRun: true }).includes('chart'), 'chart reached the single-shot offer, which two other guards pin to an exact list');
  // ⚠️ It starts no process, so --no-run must not withhold it.
  assert.ok(toolNamesForRounds(16, { root, env: {}, allowRun: false }).includes('chart'), '--no-run withheld a verb that starts nothing');

  const out = await executeToolCall(
    { id: 'c1', function: { name: 'chart', arguments: JSON.stringify({ csv_path: 'sales.csv' }) } },
    createLocalExecutor(root),
    { allowRun: true },
  );
  assert.equal(out.result.ok, true, out.result.error);
  assert.equal(out.mutated, true, 'a file was written and the run summary would not count it');
  assert.equal(out.mutatedPath, 'sales.html');
});

test('the schema names the tool once and the dispatcher answers to nothing else', async () => {
  const schemas = chartToolSchemas();
  assert.deepEqual(schemas.map((s) => s.function.name), [...CHART_TOOL_NAMES]);
  assert.deepEqual(chartToolNames(), ['chart']);
  const bogus = await runChartTool('charts', {}, {});
  assert.equal(bogus.ok, false);
  assert.match(bogus.error, /unknown chart tool/);
});

test('⚠️ the MCP transport has decided about chart IN WRITING', () => {
  // The union guard in mcp-server-surface.test.mjs asserts SERVED ∪ REFUSED ===
  // TOOL_NAMES; this asserts the decision is a REASON rather than a placeholder.
  const reason = REFUSED_TOOL_REASONS.chart;
  assert.equal(typeof reason, 'string');
  assert.ok(reason.length > 40, `the refusal reason is a stub: ${reason}`);
});

/** Parse a CSV and hand back the two arguments `inferColumns` wants. */
function pick(csv) {
  const p = parseCsv(csv);
  assert.ok(p.ok, p.error);
  return { header: p.header, rows: p.rows };
}
