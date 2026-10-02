/**
 * ── ⭐⭐ "USE THE SHELL" IS AN ORDER, AND IT IS GATED ────────────────────────
 *
 * Three bench transcripts showed the same failure: a shell available, and never
 * used. `mteb-leaderboard` ran 15 rounds with `grep -c run_command` returning
 * ZERO; `chess-best-move` the same in 6; `financial-document-processor` had no
 * PDF library, `allow_internet = true`, and never tried installing one. So the
 * prompt now tells the model to run the thing that computes the answer, and to
 * install a missing tool rather than work around it.
 *
 * ⚠️ THE GATE IS THE SAFETY ARGUMENT, NOT A DETAIL. This agent runs on people's
 * own machines. "Install what you need" is defensible only inside `--shell`,
 * whose banner reads "may run ANY program, with your privileges". If it ever
 * leaks into the default mode, the CLI starts apt-getting on someone's laptop
 * because a prompt line said so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { systemPrompt } from '../lib/turn.mjs';

const INSTALL = /INSTALL IT/;
const COMPUTE = /RUN the thing that computes the answer/;

test('⭐ in shell mode the model is TOLD to compute and to install', () => {
  const p = systemPrompt({ maxRounds: 100, allowRun: true, shell: true });
  assert.match(p, INSTALL);
  assert.match(p, COMPUTE);
  /**
   * ⚠️ Imperative, not permissive. "you can install" is the phrasing that
   * produced three transcripts with zero run_command calls.
   */
  assert.doesNotMatch(p, /you may install if you want/i);
});

test('⚠️⚠️ it NEVER appears outside shell mode', () => {
  const off = systemPrompt({ maxRounds: 100, allowRun: true, shell: false });
  assert.doesNotMatch(off, INSTALL);
  assert.doesNotMatch(off, COMPUTE);
});

test('⚠️ nor when commands are forbidden entirely', () => {
  // `--shell` without `allowRun` is contradictory, but a prompt that advertises
  // installing while every command is refused is a dead button in text form.
  const noRun = systemPrompt({ maxRounds: 100, allowRun: false, shell: true });
  assert.doesNotMatch(noRun, INSTALL);
});

test('⚠️ the one-shot prompt never carries it either — there is no round to install in', () => {
  const once = systemPrompt({ maxRounds: 1, allowRun: true, shell: true });
  assert.doesNotMatch(once, INSTALL);
});
