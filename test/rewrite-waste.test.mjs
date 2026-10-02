/**
 * ── ⭐⭐⭐ THE OUTPUT HALF OF THE BILL, WHICH NO CACHE CAN REACH ─────────────
 *
 * `cost-units.mjs` prices an output token at **11.25 units against a cache
 * hit's 1**. Every efficiency layer in this package works on the INPUT side; a
 * needless whole-file rewrite is the one expensive thing none of them touch.
 * The builder measured it at **56% of a build's cost** and shipped
 * `rewrite-waste.ts` in response — and the CLI, the surface actually published
 * on npm, had no equivalent at all until this file's module.
 *
 * ⚠️ TWO SEPARATE QUESTIONS, AND THIS REPO HAS SHIPPED THE FIRST WITHOUT THE
 * SECOND REPEATEDLY: is the arithmetic right, and does the sentence REACH THE
 * MODEL. Both are asserted below, and the second one is the one that matters.
 *
 * ⚠️ COSTS $0.00 — pure functions and an in-memory executor. No model, no key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import {
  rewriteWaste, rewriteWasteNote, wasteNoteForWrite,
  MIN_BYTES_TO_REPORT, MIN_WASTE_RATIO,
} from '../lib/rewrite-waste.mjs';
import { executeToolCall } from '../lib/tools.mjs';
import { toolResultText } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-waste-'));
  made.push(root);
  return root;
}

/** A file big enough to be worth a sentence, with a recognisable middle. */
const filler = (n) => 'const x = 1;\n'.repeat(n);
const BIG_BEFORE = `${filler(200)}// MIDDLE MARKER\n${filler(200)}`;
const BIG_AFTER = `${filler(200)}// MIDDLE CHANGED\n${filler(200)}`;

// ── the arithmetic ──────────────────────────────────────────────────────────

test('⭐ a rewrite that changed almost nothing is reported with the real numbers', () => {
  const w = rewriteWaste(BIG_BEFORE, BIG_AFTER);
  assert.ok(w.wrote >= MIN_BYTES_TO_REPORT, 'precondition: the fixture must be big enough to report');
  assert.ok(w.wasteRatio > 0.99, `only ${(w.wasteRatio * 100).toFixed(1)}% detected as unchanged`);
  assert.equal(w.worthSaying, true);

  const note = rewriteWasteNote('app.js', w);
  assert.ok(note.includes('app.js'), 'the note must name the file');
  assert.match(note, /\d/, 'a note with no number is the advice the model already ignores');
  assert.ok(note.includes('edit_file'), 'it must name the cheaper verb');
});

test('⚠️ a genuine rewrite is NOT nagged about — a false positive is worse than silence', () => {
  /**
   * The rule this repo has paid for four times in one day: a check that fails
   * correct work. A file that really did change everywhere is exactly what
   * `write_file` is for.
   */
  const w = rewriteWaste(filler(300), 'export default function App() { return null; }\n'.repeat(60));
  assert.ok(w.wasteRatio < MIN_WASTE_RATIO, `${(w.wasteRatio * 100).toFixed(1)}% looked unchanged in a full rewrite`);
  assert.equal(w.worthSaying, false);
  assert.equal(rewriteWasteNote('app.js', w), null);
});

test('⚠️ a NEW file is never waste, and a small one is never worth the tokens', () => {
  assert.equal(rewriteWaste(null, BIG_AFTER).worthSaying, false, 'a new file has nothing to compare against');
  assert.equal(rewriteWaste('', BIG_AFTER).worthSaying, false);
  // ⚠️ Identical content is 100% waste by ratio but under the byte floor.
  assert.equal(rewriteWaste('tiny', 'tiny').worthSaying, false, 'nagging about 4 bytes costs more than the rewrite did');
});

// ── the read, and its cost bound ────────────────────────────────────────────

test('⭐⭐ the disk read is SKIPPED below the byte floor — the guard must not tax every write', () => {
  /**
   * ⚠️ The builder holds the project in a Map, so `before` is free there. Here
   * it is a real read, and a read on every write would be a tax paid by every
   * build. A write under the floor can never be `worthSaying`, so there is
   * nothing to learn from reading it.
   */
  let reads = 0;
  const executor = { readFile: (p) => { reads += 1; return { ok: true, content: 'x'.repeat(50_000) }; } };

  assert.equal(wasteNoteForWrite(executor, 'a.js', 'small'), null);
  assert.equal(reads, 0, 'a small write must not touch the disk at all');

  wasteNoteForWrite(executor, 'a.js', 'x'.repeat(MIN_BYTES_TO_REPORT));
  assert.equal(reads, 1, 'a large write must read the old bytes to compare');
});

test('⚠️ it can never fail a write — an unreadable file is simply "new"', () => {
  /**
   * A bookkeeping read that throws on the write path would be a meter that
   * breaks the build it is measuring.
   */
  const throws = { readFile: () => { throw new Error('disk on fire'); } };
  assert.equal(wasteNoteForWrite(throws, 'a.js', BIG_AFTER), null);
  assert.equal(wasteNoteForWrite({}, 'a.js', BIG_AFTER), null, 'an executor with no readFile must not throw');
  assert.equal(wasteNoteForWrite({ readFile: () => ({ ok: false }) }, 'a.js', BIG_AFTER), null);
});

// ── ⭐⭐⭐ REACH: does the sentence actually get to the model? ───────────────

test('⭐⭐⭐ REACH: the note arrives in what the MODEL reads, through the real dispatcher', async () => {
  /**
   * ⚠️⚠️ THE ASSERTION THIS FILE EXISTS FOR. Everything above proves the
   * arithmetic; none of it proves the model is ever told. This repo's recorded
   * failure mode is exactly that gap — `licenceIssues` shipped complete, with
   * tests, and was called by nothing; `packageDocsChecks` says "kept for the
   * doctor" and the doctor never called it.
   *
   * ⭐ So this goes through `executeToolCall` — the real dispatcher — and then
   * through `toolResultText`, which is literally the string handed to DeepSeek.
   */
  const root = workspace();
  writeFileSync(join(root, 'app.js'), BIG_BEFORE);
  const executor = createLocalExecutor(root);

  const record = await executeToolCall(
    { id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'app.js', content: BIG_AFTER }) } },
    executor,
    {},
  );

  assert.equal(record.result.ok, true, 'precondition: the write must actually land');
  assert.equal(readFileSync(join(root, 'app.js'), 'utf8'), BIG_AFTER, 'the guard must not have blocked the write');

  const seenByModel = toolResultText(record);
  assert.match(seenByModel, /rewrote all/, `the model was never told. It read: ${JSON.stringify(seenByModel)}`);
  assert.ok(seenByModel.includes('edit_file'), 'the cheaper verb must be named where the model reads it');
  // ⚠️ And the tool's own result is still there — the note is APPENDED, never substituted.
  assert.match(seenByModel, /app\.js/);
});

test('⭐⭐ REACH: the BULK verb carries it too — that is where a rewrite is biggest', async () => {
  /**
   * `write_files` takes up to 45 files, so it is the verb that can re-emit a
   * whole project. A signal wired only to the singular verb would be off
   * exactly where the waste is largest — the same hole the pre-commit lint
   * names in its own comment.
   */
  const root = workspace();
  writeFileSync(join(root, 'a.js'), BIG_BEFORE);
  writeFileSync(join(root, 'b.js'), BIG_BEFORE);
  const executor = createLocalExecutor(root);

  const record = await executeToolCall(
    {
      id: 'c2',
      function: {
        name: 'write_files',
        arguments: JSON.stringify({ files: [{ path: 'a.js', content: BIG_AFTER }, { path: 'b.js', content: BIG_AFTER }] }),
      },
    },
    executor,
    {},
  );

  assert.equal(record.result.ok, true, 'precondition: the batch must land');
  const seenByModel = toolResultText(record);
  assert.match(seenByModel, /rewrote all/, `the bulk path told the model nothing. It read: ${JSON.stringify(seenByModel)}`);
});

test('⚠️ REACH: a legitimate new file produces NO note at the dispatcher either', async () => {
  /**
   * The negative case through the real path. Without it, a guard that appended
   * its sentence to every write would pass every assertion above.
   */
  const root = workspace();
  const executor = createLocalExecutor(root);
  const record = await executeToolCall(
    { id: 'c3', function: { name: 'write_file', arguments: JSON.stringify({ path: 'new.js', content: BIG_AFTER }) } },
    executor,
    {},
  );
  assert.equal(record.result.ok, true);
  assert.doesNotMatch(toolResultText(record), /rewrote all/, 'a brand-new file was reported as waste');
});
