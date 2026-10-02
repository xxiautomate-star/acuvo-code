/**
 * The agent's `see_page` screenshots (`.acuvo/render-<ms>.png`) are not files it wrote for
 * you. Found by using it, 2026-09-26: a run that built two files printed "4 files written",
 * its photographs of the page listed beside the page. They are still named, on one line.
 * The record shape is the real one — `mutatedPath` is what `describeChange` reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSummary } from '../lib/turn.mjs';
import { reconcile } from '../lib/plan-coherence.mjs';

const executed = [
  { name: 'write_file', mutated: true, args: { path: 'public/index.html' }, result: { ok: true, path: 'public/index.html', bytes: 4954, created: true } },
  { name: 'see_page', mutated: true, mutatedPath: '.acuvo/render-1790380129973.png', args: { path: 'public/index.html' },
    result: { ok: true, path: 'public/index.html', screenshot: '.acuvo/render-1790380129973.png', screenshotBytes: 62992, looked: true } },
];

test('the count and the list are the project files only', () => {
  const out = formatSummary({ ok: true, executed, rounds: 3, messages: [], usage: null, stoppedBecause: 'model-done' }).join('\n');
  assert.match(out, /^1 file written:$/m);
  assert.doesNotMatch(out, /created\s+\.acuvo\/render-/);
});

test('the screenshot is still named, on its own line', () => {
  const out = formatSummary({ ok: true, executed, rounds: 3, messages: [], usage: null, stoppedBecause: 'model-done' }).join('\n');
  assert.match(out, /1 screenshot it took to check its work: \.acuvo\/render-1790380129973\.png/);
});

test('any other .acuvo write is still listed as a write', () => {
  const other = [{ name: 'write_file', mutated: true, args: { path: '.acuvo/memory/notes.md' }, result: { ok: true, path: '.acuvo/memory/notes.md', bytes: 10, created: true } }];
  const out = formatSummary({ ok: true, executed: other, rounds: 1, messages: [], usage: null, stoppedBecause: 'model-done' }).join('\n');
  assert.match(out, /created\s+\.acuvo\/memory\/notes\.md/);
});

test('the plan check does not call the screenshot an unpromised change', () => {
  const plan = { version: 1, task: 'build the page', steps: [{ id: 's1', text: 'write public/index.html', state: 'done' }] };
  const rounds = [{ round: 1, note: '', usage: null, finishReason: 'tool_calls', model: 'test', executed: executed.map((e, i) => ({ id: `c${i}`, ...e })) }];
  const rec = reconcile({ plan, rounds });
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.unpromised, []);
  assert.ok(!rec.changed.some((c) => c.path.startsWith('.acuvo/')));
});
