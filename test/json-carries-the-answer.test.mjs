/**
 * ── ⚠️⚠️ THE MACHINE-READABLE DOCUMENT DID NOT CONTAIN THE ANSWER ───────────
 *
 * MEASURED 2026-08-15 on a real run: a `--json` document carried `ok`, `task`,
 * `model`, `rounds`, `stoppedBecause`, `verification`, `changes`, `costUsd` —
 * and no `note`. The agent's actual reply, the thing a person reads to learn
 * what happened, reached the terminal and stopped there. Anything driving this
 * tool through `--json` got everything except the answer.
 *
 * ⭐ THE PATTERN, WHICH IS THE REAL FINDING: the human summary is rich and the
 * machine document is thin. Ten fields on the outcome never reached it —
 * including `promisedButMissing`, which the human summary prints in bold and a
 * script could not see at all. This is the same defect as the cache reading and
 * the compaction count before it: computed on every run, returned on the
 * outcome, dropped at the one line where it becomes visible.
 *
 * ⚠️ AND THE ONE THAT MOTIVATED IT: a round-cap run reports `ok: true`,
 * `exitCode: 0`, `failed: false` while `verification.ran` is false — cut off
 * mid-task, four files written, nothing verified. Without `maxRounds`, a
 * consumer reading `rounds: 2` cannot tell a tidy little session from a run
 * that hit its ceiling with work outstanding.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { toJson } from '../lib/report.mjs';

/** The shape `runSession` actually returns, per the SessionDone typedef. */
const outcome = (over = {}) => ({
  ok: true,
  stage: 'done',
  model: 'deepseek/deepseek-v4-flash-0731',
  note: 'I added subtract() and exported it.',
  noteAlreadyShown: false,
  finishReason: 'stop',
  usage: { cost: 0.0021, total_tokens: 41_000 },
  compactions: 0,
  executed: [],
  rounds: [],
  roundsUsed: 2,
  maxRounds: 2,
  allowRun: true,
  stoppedBecause: 'round-cap',
  verification: { ran: false, passed: false },
  acceptance: null,
  promisedButMissing: [],
  ...over,
});

test('⭐⭐ the ANSWER reaches the document', () => {
  const doc = toJson(outcome(), { changes: [], task: 't' });
  assert.equal(doc.note, 'I added subtract() and exported it.');
});

test('⚠️ a run with no answer says null, not an empty string', () => {
  // Absent and empty are different facts: the model returning nothing is a
  // finding, and "" would read as a reply that happened to be blank.
  const doc = toJson(outcome({ note: null }), { changes: [], task: 't' });
  assert.equal(doc.note, null);
});

test('⚠️⚠️ files the reply CLAIMED but did not write reach the document', () => {
  /**
   * The human summary prints this in bold — "The reply named 2 files it did not
   * write" — and a script could not see it. It is the difference between "the
   * agent says it wrote your migration" and "your migration exists".
   */
  const doc = toJson(outcome({ promisedButMissing: ['b.mjs', 'c.mjs'] }), { changes: [], task: 't' });
  assert.deepEqual(doc.promisedButMissing, ['b.mjs', 'c.mjs']);
});

test('⭐ promisedButMissing is an ARRAY even when nothing is missing', () => {
  // A consumer doing `.length` must not have to null-check the common case.
  const doc = toJson(outcome(), { changes: [], task: 't' });
  assert.deepEqual(doc.promisedButMissing, []);
});

test('⭐⭐ maxRounds makes a TRUNCATED run detectable', () => {
  /**
   * `rounds: 2` alone reads as a tidy little session. `rounds: 2, maxRounds: 2`
   * plus `stoppedBecause: 'round-cap'` is a run that hit its ceiling with work
   * outstanding — and it exits 0, so the exit code will not tell you.
   */
  const doc = toJson(outcome({ roundsUsed: 2, maxRounds: 2 }), { changes: [], task: 't' });
  assert.equal(doc.maxRounds, 2);
  assert.equal(doc.stoppedBecause, 'round-cap');
  assert.ok(doc.rounds >= doc.maxRounds, 'a capped run must be visible as rounds >= maxRounds');
});

test('⭐ a run that finished early is distinguishable from one that was capped', () => {
  const done = toJson(outcome({ roundsUsed: 3, maxRounds: 16, stoppedBecause: 'verified' }), { changes: [], task: 't' });
  assert.ok(done.rounds < done.maxRounds);
  assert.equal(done.stoppedBecause, 'verified');
});

test('⚠️ the provider stop reason travels — `length` means a cut-off answer', () => {
  // Not the same as OUR stoppedBecause: a model truncated mid-sentence will
  // often be recorded by us as a perfectly ordinary `no-tool-calls`.
  const doc = toJson(outcome({ finishReason: 'length' }), { changes: [], task: 't' });
  assert.equal(doc.finishReason, 'length');
});

test('⭐ allowRun explains a verification that never ran', () => {
  // "Could not execute anything" and "chose not to verify" look identical from
  // outside without this.
  const cant = toJson(outcome({ allowRun: false }), { changes: [], task: 't' });
  assert.equal(cant.allowRun, false);
  assert.equal(cant.verification.ran, false);
});

test('⚠️ every added field survives a threadbare outcome without throwing', () => {
  // toJson is called on failure paths too, where most of this is absent.
  const doc = toJson({ ok: false, error: 'boom' }, { changes: [], task: 't' });
  assert.equal(doc.note, null);
  assert.deepEqual(doc.promisedButMissing, []);
  assert.equal(doc.maxRounds, null);
  assert.equal(doc.finishReason, null);
  assert.equal(doc.allowRun, null);
});
