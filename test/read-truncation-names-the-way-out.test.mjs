/**
 * ── ⭐ A TRUNCATION THAT NAMES THE WAY OUT ──────────────────────────────────
 *
 * MEASURED on a 25,200-character file: `read_file` hands the model 8,055
 * characters — head 35%, tail 65% — and the middle is gone.
 *
 * ⭐ IT IS ALREADY HONEST ABOUT IT. `clampOutput` writes
 * `… 17200 characters omitted …` into the text, so this is not the silent
 * data-loss the audit first suggested. The model knows something is missing.
 *
 * ⚠️ BUT KNOWING IS NOT ENOUGH, AND HEAD+TAIL IS THE WRONG SHAPE FOR A FILE.
 * For a command's output it is exactly right — you want the start and the error
 * at the end. For a source file the middle is usually the part you needed, and
 * a model told only "17200 characters omitted" has no stated next move. In
 * practice it re-reads the same file and gets the same clamp.
 *
 * ⭐ `read_lines` AND `read_around` ALREADY EXIST AND ARE WIRED. This is the
 * repo's own rule applied to a truncation notice: an error string is an
 * INSTRUCTION. Naming the tool turns a dead end into a next action, and it costs
 * one sentence.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeToolCall } from '../lib/tools.mjs';
import { toolResultText } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

function bigFile() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-bigread-'));
  let body = '';
  for (let i = 1; i <= 1200; i += 1) body += `LINE${String(i).padStart(5, '0')}${' '.repeat(10)}x\n`;
  writeFileSync(join(root, 'big.txt'), body);
  return root;
}

async function readBig(root) {
  const ex = createLocalExecutor(root);
  const rec = await executeToolCall(
    { id: '1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'big.txt' }) } },
    ex,
    {},
  );
  return { rec, seen: toolResultText(rec) };
}

test('⚠️ a clamped read still SAYS how much it dropped', async () => {
  const root = bigFile();
  try {
    const { seen } = await readBig(root);
    assert.match(seen, /omitted/i, 'the model was handed a partial file with no sign it was partial');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ …and NAMES the tool that gets the rest', async () => {
  const root = bigFile();
  try {
    const { seen } = await readBig(root);
    assert.match(
      seen,
      /read_lines|read_around/,
      'the truncation notice is a dead end — the model is told the middle is missing and not how to get it, '
      + 'so it re-reads the same file and receives the same clamp',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a file that FITS is untouched — no notice, no advice, no noise', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-smallread-'));
  try {
    writeFileSync(join(root, 'big.txt'), 'just a few lines\nnothing to clamp\n');
    const { seen } = await readBig(root);
    assert.equal(/omitted/i.test(seen), false, 'a complete file was described as truncated');
    assert.equal(/read_lines/.test(seen), false, 'advice was attached to a read that needed none');
    assert.match(seen, /just a few lines/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the underlying read is NOT lossy — only the model-facing rendering clamps', async () => {
  const root = bigFile();
  try {
    const { rec } = await readBig(root);
    assert.equal(rec.result.ok, true);
    assert.ok(rec.result.content.includes('LINE00600'), 'read_file itself lost the middle — that would be real data loss');
    assert.equal(rec.result.content.length, 25_200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
