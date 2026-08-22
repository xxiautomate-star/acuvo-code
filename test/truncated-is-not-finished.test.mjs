/**
 * ── ⚠️⚠️ THE MODEL WAS CUT OFF MID-SENTENCE AND WE CALLED IT "FINISHED" ──────
 *
 * MEASURED 2026-08-16 on Terminal-Bench 2.1 task `write-compressor`, the first
 * benchmark trial that ever reached a model. Verbatim from the result document:
 *
 *     "rounds": 2,
 *     "finishReason": "length",
 *     "stoppedBecause": "no-tool-calls",
 *     "changes": [],
 *     "verification": { "ran": false },
 *     budget: spent $0.0025 of $0.05
 *
 * The model read `decomp.c` and `data.txt`, started reasoning about an
 * arithmetic coder, and **ran out of output tokens in the middle of a
 * sentence**. It never emitted a tool call because it never got that far. The
 * loop saw `toolCalls.length === 0`, assigned `no-tool-calls` — whose own doc
 * comment reads *"the model had nothing more to do"* — and ended the session at
 * round 2 of 16 with 94% of the budget unspent. The verifier's complaint was
 * `/app/data.comp does not exist`. The task scored 0.
 *
 * ⭐ NOTHING ABOUT THIS WAS THE MODEL'S FAULT, AND THAT IS THE POINT. Every
 * ceiling in that run was ours. `finishReason: 'length'` is the provider
 * stating that it truncated the reply; there is no reading of that field under
 * which "stop the session" is the right response.
 *
 * ⚠️ WHY NO EXISTING TEST CAUGHT IT. The only continuation the loop had was
 * `pressOnForAcceptance`, gated on `--until-done` AND on a declared acceptance
 * file being present in the workspace. A benchmark container has neither, and
 * nor does most real work — so the mechanism was structurally unreachable in
 * exactly the situation that needed it, and every test of it passed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sessionFailed } from '../lib/turn.mjs';
import { OUT_OF_ROAD, outOfRoad } from '../lib/escalate.mjs';

/**
 * The exact shape the real trial produced: the success path, nothing written,
 * nothing verified. Only `stoppedBecause` varies between the old and new code.
 */
const truncatedRun = (stoppedBecause, verification = { ran: false, passed: false }) => ({
  ok: true,
  stage: 'done',
  stoppedBecause,
  finishReason: 'length',
  executed: [],
  verification,
  acceptance: null,
  usage: { cost: 0.00251549424 },
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐ THE CLASSIFICATION — a truncated run is CUT OFF, not finished
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ a truncated run is out of road, so the ladder may escalate it', () => {
  assert.equal(
    outOfRoad(truncatedRun('truncated')), true,
    'being chopped off by the output limit is the most literal "cut off" there is',
  );
});

test('⚠️ `no-tool-calls` is still NOT out of road — the distinction is the fix', () => {
  /**
   * This is the half that must not regress. "Write me a README" legitimately
   * ends with no tool call and no command to run, and escalating it three times
   * would charge for two attempts nobody needed. The bug was never that
   * `no-tool-calls` behaved wrongly — it was that truncation was FILED AS IT.
   */
  assert.equal(outOfRoad(truncatedRun('no-tool-calls')), false);
  assert.equal(OUT_OF_ROAD.includes('no-tool-calls'), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐ THE PROCESS VERDICT — exit 0 on a run that wrote nothing
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ a truncated run with nothing verified FAILS — it exited 0 before', () => {
  /**
   * The real trial's shape. `acuvo … && git push` would have pushed a repo in
   * which the requested file was never created, and been told it succeeded.
   */
  assert.equal(sessionFailed(truncatedRun('truncated')), true);
});

test('⚠️ it fails WITHOUT --strict, because being cut off is a fact not an opinion', () => {
  const cut = truncatedRun('truncated');
  assert.equal(sessionFailed(cut), true, 'no flag required');
  assert.equal(sessionFailed(cut, { strict: true }), true);
});

test('⚠️⚠️ but a truncated CLOSING PARAGRAPH after a passing check does NOT fail', () => {
  /**
   * The check-that-fails-correct-work case, which this repo has paid for four
   * times. A model that wrote the code, ran the test, watched it pass and then
   * got cut off composing its summary has completed the task. Failing that run
   * would be a guard that punishes success — worse than no guard.
   */
  const finishedThenCutOff = truncatedRun('truncated', { ran: true, passed: true, command: 'npm test', exitCode: 0, attempts: 1 });
  assert.equal(sessionFailed(finishedThenCutOff), false);
});

test('⚠️ "I cannot tell whether it passed" is NOT "it passed"', () => {
  /**
   * The permissive reading is what let the original bug exit 0, so every
   * not-definitely-true shape must land in the failing branch. Truthiness would
   * pass the first of these; `=== true` on both halves is why it does not.
   */
  for (const v of [undefined, null, {}, { ran: true }, { ran: true, passed: undefined }, { passed: true }]) {
    assert.equal(
      sessionFailed(truncatedRun('truncated', v)), true,
      `verification ${JSON.stringify(v)} does not prove the task completed`,
    );
  }
});

test('⚠️⚠️ TRUTHY IS NOT TRUE — and the cases above could not tell the difference', () => {
  /**
   * ⭐ THIS TEST EXISTS BECAUSE MUTATION TESTING CAUGHT THE ONE ABOVE BEING
   * DECORATIVE. Rewriting the guard's `!(v?.ran === true && v.passed === true)`
   * as the loose `!(v?.ran && v?.passed)` left the whole file green: every
   * fixture in the previous test is FALSY, and the two readings agree on
   * everything falsy. The assertion named strictness and measured nothing.
   *
   * These are the shapes that separate them — truthy, and not `true`. Under the
   * strict reading each is "I cannot tell whether it passed", which must fail a
   * truncated run; under truthiness each silently counts as proof the task
   * completed, and the run exits 0 having written nothing.
   *
   * ⚠️ The lesson generalises past this file: a test that only feeds a predicate
   * values it already agrees on is not testing the predicate.
   */
  for (const v of [
    { ran: true, passed: 1 },
    { ran: true, passed: 'yes' },
    { ran: 1, passed: true },
    { ran: 'yes', passed: 'yes' },
    { ran: true, passed: {} },
  ]) {
    assert.equal(
      sessionFailed(truncatedRun('truncated', v)), true,
      `verification ${JSON.stringify(v)} is truthy but is not a boolean pass — it must not clear a truncated run`,
    );
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE GUARD THAT ALMOST DIDN'T GUARD
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ turn.mjs assigns `truncated` as a BARE LITERAL, or escalate.test goes blind', () => {
  /**
   * `escalate.test.mjs` proves `OUT_OF_ROAD` only names real stop reasons by
   * scraping this file with `/stoppedBecause = '([a-z-]+)'/`. The first draft of
   * the fix wrote the assignment as a ternary —
   *
   *     stoppedBecause = reply.finishReason === 'length' ? 'truncated' : 'no-tool-calls'
   *
   * — which hides both literals from that regex. The scraper then reported
   * "turn.mjs never sets truncated" while this very file set it, and would have
   * gone on trusting a list it could no longer verify.
   *
   * ⭐ So the CONVENTION is load-bearing, not cosmetic, and this pins it here
   * rather than leaving the next person to rediscover it by breaking a test in
   * another file.
   */
  const src = readFileSync(new URL('../lib/turn.mjs', import.meta.url), 'utf8');
  const assigned = new Set([...src.matchAll(/stoppedBecause = '([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(assigned.has('truncated'), 'the literal must be greppable by escalate.test.mjs');
  assert.ok(assigned.has('no-tool-calls'), 'and the sibling it was split out of must still be too');
});
