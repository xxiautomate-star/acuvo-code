/**
 * ── ⭐⭐⭐ THE KILL THAT DID NOT NAME ITS OWN LIMIT ──────────────────────────
 *
 * `TIMED OUT after 120s and was killed. It produced no exit code.` is a dead
 * end. It does not say that 120s WAS the limit rather than the honest duration,
 * and it does not name `timeoutMs` — the parameter that has existed on
 * `run_command` since 2026-08-24 for exactly this.
 *
 * MEASURED on the 45 archived bench runs whose binary post-dates the
 * `looksLikeVerification` fix: 83 of 783 commands were killed (10.6%), 44 of
 * them at exactly 120s; those kills consumed 61% of all command wall-clock and
 * returned no exit code; 27% of them were a re-run of a command already killed
 * once. Eleven transcripts say in the model's own words that it wants a longer
 * timeout — one of them concludes *"the timeout seems to be fixed around 120s
 * for run_command"* and another wraps the command in the shell's `timeout 300`,
 * a binary that can only LOWER the ceiling.
 *
 * ⚠️ WHAT THIS FILE GUARDS, IN ORDER OF HOW QUIETLY IT WOULD BREAK:
 *
 *   1. the applied limit reaches the RESULT — from a real kill, not a literal;
 *   2. the sentence names `timeoutMs` AND the ceiling, so the next move is a
 *      thing the model can type rather than a thing it has to guess;
 *   3. it does NOT tell a command already at the ceiling to raise it — advice
 *      that cannot be followed is worse than none;
 *   4. a result with no limit still gets the half that is true, and never a
 *      guessed number;
 *   5. ⭐ it survives COMPACTION. `compact.mjs` keeps the first TWO lines of a
 *      superseded command result and drops the rest, so this has to live on
 *      line 2 — which is exactly the run, long and full of kills, where it
 *      matters most. A third line would be deleted before it was read twice.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeRunCommand,
  formatRunForModel,
  MAX_COMMAND_TIMEOUT_MS,
} from '../lib/command.mjs';
import { compactMessages } from '../lib/compact.mjs';

const made = [];
after(() => {
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows handle lag */ } }
});

/**
 * ⚠️ A REAL SLEEPING PROCESS IN A FILE, borrowed from
 * `run-command-timeout.test.mjs` for the reason recorded there: an inline
 * `node -e "…"` loses its quotes crossing the shell layer and exits instantly,
 * which makes a timeout test pass against a command that never slept.
 */
function sleeper(ms) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-timeout-msg-'));
  made.push(root);
  writeFileSync(join(root, 'sleeper.mjs'), `setTimeout(function () {}, ${ms});\n`);
  return { root, dryRun: false, readFile: () => ({ ok: false, error: 'no such file' }) };
}

test('⭐ a REAL kill carries the limit that killed it onto the result', async () => {
  const executor = sleeper(20_000);
  const result = await executeRunCommand({
    command: 'node sleeper.mjs', executor, timeoutMs: 1_500, shell: true,
  });
  assert.equal(result.timedOut, true, JSON.stringify(result).slice(0, 200));
  // Not `durationMs`: the whole point is that the two are different facts.
  assert.equal(result.timeoutMs, 1_500, 'the applied limit must be on the result');
});

test('⭐ the allowlist branch carries it too — not just the shell one', async () => {
  const executor = sleeper(20_000);
  const result = await executeRunCommand({
    command: 'node sleeper.mjs', executor, timeoutMs: 1_500, shell: false,
  });
  assert.equal(result.timedOut, true, JSON.stringify(result).slice(0, 200));
  assert.equal(result.timeoutMs, 1_500);
});

test('⭐⭐⭐ the message names the LIMIT, the PARAMETER and the CEILING', () => {
  const text = formatRunForModel({
    ok: true, command: 'pip3 install pgmpy', timedOut: true,
    durationMs: 120_000, timeoutMs: 120_000, stdout: '', stderr: '',
  });
  assert.match(text, /TIMED OUT/);
  // It was the LIMIT, not the duration of the work.
  assert.match(text, /120s was this call's LIMIT/);
  // The parameter, spelled the way the model has to type it.
  assert.match(text, /timeoutMs: 600000/);
  // And the fact that made 27% of the archive's kills repeats.
  assert.match(text, /re-running it unchanged will be killed/i);
});

test('⚠️ a command ALREADY at the ceiling is not told to raise it', () => {
  const text = formatRunForModel({
    ok: true, command: 'make -j4', timedOut: true,
    durationMs: MAX_COMMAND_TIMEOUT_MS, timeoutMs: MAX_COMMAND_TIMEOUT_MS,
    stdout: '', stderr: '',
  });
  assert.match(text, /is also the ceiling/);
  /**
   * ⚠️ Advice that cannot be followed is worse than none: a model told to pass
   * `timeoutMs: 600000` when it already did spends the round proving the tool
   * wrong. The escape at the ceiling is a different shape of work.
   */
  assert.ok(!/retry with timeoutMs/.test(text), `must not tell it to raise the ceiling:\n${text}`);
  assert.match(text, /background/);
});

test('⚠️ no limit on the result ⇒ the true half, and never a guessed number', () => {
  const text = formatRunForModel({
    ok: true, command: 'npm test', timedOut: true,
    durationMs: 120_000, stdout: '', stderr: '',
  });
  assert.match(text, /Re-running it unchanged will be killed/);
  // A confident wrong ceiling costs the same round the bare sentence did.
  assert.ok(!/LIMIT/.test(text), `must not invent a limit it was not given:\n${text}`);
});

test('⭐⭐ a PASSING run is untouched — this text is only ever a timeout', () => {
  const text = formatRunForModel({
    ok: true, command: 'npm test', timedOut: false, exitCode: 0, passed: true,
    durationMs: 1_000, timeoutMs: 120_000, stdout: 'ok', stderr: '',
  });
  assert.ok(!/timeoutMs/.test(text), `no advice on a healthy run:\n${text}`);
  assert.match(text, /exit code: 0/);
});

test('⭐⭐⭐ it SURVIVES compaction — compact.mjs keeps only the first two lines', () => {
  const timeoutText = formatRunForModel({
    ok: true, command: 'pip3 install pgmpy', timedOut: true,
    durationMs: 120_000, timeoutMs: 120_000,
    stdout: Array.from({ length: 4_000 }, (_, i) => `noise line ${i}`).join('\n'),
    stderr: '',
  });
  const c1 = { id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"command":"pip3 install pgmpy"}' } };
  const c2 = { id: 'c2', type: 'function', function: { name: 'run_command', arguments: '{"command":"pip3 install pgmpy"}' } };
  const messages = [
    { role: 'system', content: 'You are acuvo, a terminal coding agent.' },
    { role: 'user', content: 'TASK: fit the bayesian network in bn.py.' },
    { role: 'assistant', content: 'installing', tool_calls: [c1] },
    { role: 'tool', tool_call_id: 'c1', name: 'run_command', content: timeoutText },
    { role: 'assistant', content: 'again', tool_calls: [c2] },
    { role: 'tool', tool_call_id: 'c2', name: 'run_command', content: '$ pip3 install pgmpy\nexit code: 0 (2.0s) — PASSED' },
  ];
  const out = compactMessages(messages, { budgetTokens: 0, keepLastRounds: 0 });
  const gutted = out.messages.filter((m) => m.role === 'tool')[0].content;
  assert.match(gutted, /TIMED OUT/);
  /**
   * ⭐ THE ASSERTION THIS FILE EXISTS FOR. Moving the advice to its own line
   * reads better and deletes it on precisely the long, kill-heavy runs that
   * compact — the runs the measurement came from.
   */
  assert.match(gutted, /timeoutMs: 600000/, `the way out must survive compaction:\n${gutted}`);
});
