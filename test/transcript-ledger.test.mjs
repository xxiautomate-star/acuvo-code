/**
 * ── ⭐⭐ THE FAILURES ARE THE PRODUCT ────────────────────────────────────────
 *
 * A transcript's successes are already in the code. What dies with the tab is
 * what was tried and failed, and where the user said no. This pins that the
 * reducer keeps exactly that, throws away the restatable bulk, and never carries
 * a secret out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceTranscript, ledgerBrief, redactSecrets, reductionRatio, LIMITS,
} from '../lib/transcript-ledger.mjs';

const rec = (o) => JSON.stringify(o);
const userText = (t) => rec({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } });
const toolResult = (content, isError) => rec({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content, is_error: isError }] },
});
const toolUse = (path) => rec({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path } }] },
});

test('keeps the failures and throws away the successful bulk', () => {
  const big = 'total 40\ndrwxr-xr-x  ok listing '.repeat(500);
  const r = reduceTranscript([
    userText('build me a booking form'),
    toolResult(big, false),
    toolResult(big, false),
    toolResult('Error: EADDRINUSE port 3000 already in use', true),
  ]);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /EADDRINUSE/);

  const brief = ledgerBrief(r);
  const ratio = reductionRatio(r, brief);
  assert.ok(ratio.ratio > 10, `expected >10x reduction, got ${ratio.ratio.toFixed(1)}x`);
  assert.equal(brief.includes('ok listing'), false, 'a successful listing survived into the brief');
});

/**
 * ⚠️ `is_error` IS NOT ALWAYS SET. A command that exits non-zero routinely comes
 * back as ordinary text starting "Error:". Relying on the flag alone loses most
 * real failures — which would empty the one column this feature exists for.
 */
test('detects a failure that never set is_error', () => {
  const r = reduceTranscript([toolResult('Error: cannot find module ./nope', false)]);
  assert.equal(r.failures.length, 1);
});

test('does not call a file a failure just because it contains the word error', () => {
  const r = reduceTranscript([toolResult('const handleError = (e) => log(e); // error handling utils', false)]);
  assert.equal(r.failures.length, 0);
});

/**
 * ⭐ THE HUMAN OVERRULING THE AGENT is the highest-signal, lowest-volume thing in
 * a transcript, and it is unrecoverable from the code.
 */
test('captures the user saying no, and files it as intent too', () => {
  const r = reduceTranscript([
    userText('add a signup form'),
    userText("no, don't use Tailwind for this"),
  ]);
  assert.equal(r.corrections.length, 1);
  assert.match(r.corrections[0], /Tailwind/);
  assert.equal(r.intents.length, 2, 'a correction was dropped from the intent thread');
});

test('collects the files that were actually edited', () => {
  const r = reduceTranscript([toolUse('app/page.tsx'), toolUse('app/page.tsx'), toolUse('lib/db.ts')]);
  assert.deepEqual(r.files.sort(), ['app/page.tsx', 'lib/db.ts']);
});

/**
 * ⚠️⚠️ TOOL OUTPUT PRINTS KEYS, and `.credentials.json` sits one directory ABOVE
 * the transcript store. A distiller that leaked a token would be worse than no
 * distiller.
 */
test('redacts secrets out of everything it keeps', () => {
  const tok = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const r = reduceTranscript([
    toolResult(`Error: auth failed using ${tok}`, true),
    userText(`no, the token is sk-abcdefghijklmnopqrstuvwxyz123456`),
  ]);
  const all = JSON.stringify(r) + ledgerBrief(r);
  assert.equal(all.includes(tok), false, 'a GitHub token survived');
  assert.equal(all.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), false, 'an sk- key survived');
  assert.match(r.failures[0], /\[redacted\]/);
});

test('redacts a key given as an assignment, keeping the name', () => {
  const out = redactSecrets('DATABASE_PASSWORD="hunter2hunter2hunter2"');
  assert.match(out, /DATABASE_PASSWORD/);
  assert.equal(out.includes('hunter2hunter2hunter2'), false);
});

/**
 * ⚠️ THE INPUT IS ADVERSARIALLY LARGE — 62.3 MB measured, with individual records
 * that are themselves payloads. Nothing may grow with the input.
 */
test('bounded against a huge transcript', () => {
  const lines = [];
  for (let i = 0; i < 400; i += 1) {
    lines.push(userText(`ask number ${i}`));
    lines.push(toolResult(`Error: failure ${i}`, true));
  }
  lines.push('x'.repeat(LIMITS.maxLineBytes + 10));
  const r = reduceTranscript(lines);
  assert.equal(r.intents.length, LIMITS.maxIntents);
  assert.equal(r.failures.length, LIMITS.maxFailures);
  assert.equal(r.skippedHuge, 1);
});

test('malformed lines are skipped, not fatal', () => {
  const r = reduceTranscript(['{ not json', '', userText('still works')]);
  assert.equal(r.intents.length, 1);
});

/**
 * ⚠️ THE BRIEF MUST NOT CLAIM A `DONE` COLUMN. A transcript records what the old
 * agent BELIEVED it finished; importing that unchecked inherits someone else's
 * "builds clean" at the moment of first impression.
 */
test('the brief refuses to assert that anything works', () => {
  const brief = ledgerBrief(reduceTranscript([userText('build it'), toolResult('Error: nope', true)]));
  assert.match(brief, /not evidence that anything works|Nothing here is/);
  assert.match(brief, /Verify against the actual tree/);
  assert.equal(/^\s*DONE/m.test(brief), false, 'the brief grew a DONE column');
});

test('an empty transcript says nothing', () => {
  assert.equal(ledgerBrief(reduceTranscript([])), null);
});
