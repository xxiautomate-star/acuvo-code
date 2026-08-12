/**
 * ── ⚠️⚠️ THE AGENT WAS SHOWN THE MIDDLE AND TOLD IT WAS THE TAIL ────────────
 *
 * Every real test runner prints its verdict LAST — "5 failed, 212 passed", the
 * stack traces, the summary. That is the single most valuable region of output
 * a coding agent can read.
 *
 * What actually happened (lib/command.mjs, verified 2026-08-13):
 *   · capture stopped at `MAX_CAPTURED_CHARS * 4` = 32,000 chars, keeping the
 *     FIRST 32KB: `if (stdout.length < cap) stdout += d`
 *   · `clampOutput` then took head+tail OF THAT ALREADY-TRUNCATED STRING, so the
 *     "tail" handed to the model was the middle of the real output
 *   · and `omitted = text.length - maxChars` reported ~24,000 characters missing
 *     when the true loss could be megabytes.
 *
 * So on any suite louder than 32KB the loop fixed whatever appeared in the first
 * few thousand characters and never learned the run had failed at all. The exit
 * code stayed honest, so it read as "it tried" rather than "it was shown the
 * wrong evidence" — which is why it survived this long.
 *
 * ⭐ The cap itself is correct and must stay: a build loop printing a gigabyte
 * cannot be held in memory to be trimmed afterwards. The fix is to keep BOTH
 * ends while streaming, and to count what was really produced.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampOutput, MAX_CAPTURED_CHARS } from '../lib/command.mjs';

test('clampOutput keeps a real head and a real tail', () => {
  const text = `${'H'.repeat(50)}${'M'.repeat(50_000)}${'T'.repeat(50)}`;
  const r = clampOutput(text);
  assert.equal(r.truncated, true);
  assert.match(r.text, /^H{50}/, 'the head survives');
  assert.match(r.text, /T{50}$/, 'and so does the tail — this is the part a test runner uses for its verdict');
  assert.equal(r.omitted, text.length - MAX_CAPTURED_CHARS, 'and it says how much it dropped');
});

test('⭐⭐ the LAST line of a loud command reaches the model', async () => {
  /**
   * The end-to-end property, driven through the real executor against a real
   * child process. A unit test on clampOutput alone cannot see this bug, because
   * the loss happens upstream in the stream handler — which is exactly why the
   * defect survived a suite with a clampOutput test in it.
   */
  const { spawnBounded } = await import('../lib/command.mjs');

  // 200k characters of noise, then the line that actually matters.
  const script = [
    'const noise = "x".repeat(100);',
    'for (let i = 0; i < 2000; i++) console.log(noise);',
    'console.log("FAILURE SUMMARY: 5 failed, 212 passed");',
  ].join('\n');

  const r = await spawnBounded({
    file: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.match(
    r.stdout, /FAILURE SUMMARY: 5 failed, 212 passed/,
    'the last line of a loud command must reach the model — it is where every test runner puts its verdict',
  );
});

test('⚠️ the omitted count must describe what was PRODUCED, not what survived the cap', async () => {
  /**
   * Reporting "24,000 characters omitted" for a 5MB run is a confident
   * falsehood, and this package treats a silent truncation as the worst class of
   * bug it can ship. If the number cannot be exact it must at least not
   * understate by two orders of magnitude.
   */
  const { spawnBounded } = await import('../lib/command.mjs');
  const script = 'const n = "y".repeat(100); for (let i = 0; i < 5000; i++) console.log(n);';

  const r = await spawnBounded({
    file: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  assert.equal(r.ok, true);
  // ~505,000 characters were produced; the old code could only ever say ~24,000.
  assert.ok(
    r.stdoutOmitted > 100_000,
    `omitted was reported as ${r.stdoutOmitted}, which understates a ~505,000-character run — `
    + 'the count must come from what the process produced, not from the buffer we kept',
  );
});
