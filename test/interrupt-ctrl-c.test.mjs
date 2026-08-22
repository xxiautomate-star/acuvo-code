/**
 * ── ⭐⭐ CTRL-C: THE FIRST PRESS ASKS, THE SECOND ONE INSISTS ────────────────
 *
 * `lib/interrupt.mjs` shipped INERT. The policy existed, all five signal
 * handlers (background, lsp, repl, tsserver, turn) already consulted it before
 * exiting — and **nothing ever registered a handler**, so `exitIsDeferred()`
 * returned false every time and the first Ctrl-C still killed the run and lost
 * its transcript. That is this package's most-shipped defect wearing a new
 * hat: every part built, nothing calling it.
 *
 * ── ⚠️⚠️ THE THREE RULES THAT MAKE THIS DANGEROUS TO GET WRONG ─────────────
 *
 *   1. **A SIGINT listener SUPPRESSES Node's default terminate-on-Ctrl-C.** So
 *      a path that neither aborts nor exits leaves Ctrl-C doing NOTHING, which
 *      is worse than the bug being fixed. Every test below that describes a
 *      path checks which of the two it ends in.
 *   2. **Exit is 128+n (130), never 1.** `bin/acuvo.mjs` spends 1 on "the code
 *      it wrote still does not pass". A script that cannot tell an interrupt
 *      from a verdict retries the wrong one.
 *   3. **Dispose per run.** An interactive session runs many turns; a handler
 *      belonging to turn 3 would swallow the Ctrl-C pressed during turn 9.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  armInterrupt, exitIsDeferred, resetInterruptState, wasAbortedByInterrupt,
  EXIT_INTERRUPTED, FIRST_PRESS_NOTICE, interruptAlreadyRequested,
} from '../lib/interrupt.mjs';

/* ── the policy ─────────────────────────────────────────────────────────── */

test('⚠️ with nothing armed the caller MUST exit — the old behaviour, unchanged', () => {
  resetInterruptState();
  assert.equal(exitIsDeferred('you pressed Ctrl-C'), false,
    'a run nobody armed has to die on Ctrl-C exactly as it did before this existed');
});

test('⭐⭐ the FIRST press aborts the run and says so, in that order', () => {
  resetInterruptState();
  const said = [];
  const gate = armInterrupt({ notify: (notice, why) => said.push([notice, why]) });

  assert.equal(gate.signal.aborted, false, 'arming alone must not cancel anything');
  assert.equal(gate.wasInterrupted(), false);

  const deferred = exitIsDeferred('you pressed Ctrl-C');

  assert.equal(deferred, true, 'the signal handler must NOT exit on the first press');
  assert.equal(gate.signal.aborted, true, 'the run must actually be asked to stop');
  assert.equal(gate.signal.reason, 'you pressed Ctrl-C');
  assert.equal(gate.wasInterrupted(), true);
  /**
   * ⭐ THE USER MUST BE TOLD WHAT THE PRESS DID, IMMEDIATELY. A press that
   * silently set a hidden flag reads as Ctrl-C being broken, and a user who is
   * not told a second press exists has no escape from a round that hangs.
   */
  assert.deepEqual(said, [[FIRST_PRESS_NOTICE, 'you pressed Ctrl-C']]);
  assert.match(FIRST_PRESS_NOTICE, /again/, 'the notice has to offer the escape hatch');
  gate.dispose();
});

test('⭐⭐ the SECOND press is fatal — the caller exits', async () => {
  /**
   * ── ⚠️⚠️ THIS TEST'S PREMISE CHANGED, AND THE CHANGE IS THE WHOLE POINT ────
   *
   * It used to call `exitIsDeferred()` twice in a row, synchronously, and read
   * the second call as the second press. That is exactly the conflation that
   * shipped the defect: two calls in ONE tick are not two presses, they are ONE
   * keypress reaching TWO of the five SIGINT listeners, and Node invokes all of
   * them synchronously for a single delivery. Under the old policy the second
   * listener got `false` and killed the process on the press that had just been
   * honoured — after printing "stopping after this round".
   *
   * ⭐ The INTENT survives unchanged and is what this test is for: a user who
   * presses twice has stopped negotiating. Only the mechanism moves — a second
   * press is a second DELIVERY, so the calls are separated by a tick. See
   * `interrupt-many-listeners.test.mjs` for the many-listener half.
   */
  resetInterruptState();
  const gate = armInterrupt({});
  assert.equal(exitIsDeferred(), true, 'first press: graceful');
  assert.equal(interruptAlreadyRequested(), true);
  assert.equal(exitIsDeferred(), true,
    'the SAME press reaching a second listener must get the same answer, or the honoured press also exits');
  await new Promise((r) => setImmediate(r)); // the delivery ends
  assert.equal(exitIsDeferred(), false,
    'second press: a user who presses twice has stopped negotiating');
  gate.dispose();
});

test('⚠️⚠️ dispose makes the NEXT press fatal — the many-turns rule', () => {
  /**
   * `runChat` calls the turn function once per turn for the life of a session.
   * Without dispose, turn 3's handler is still registered during turn 9: the
   * user presses, sees the notice, and turn 9 keeps running because the signal
   * that got aborted belongs to a controller nobody reads any more.
   */
  resetInterruptState();
  const turn3 = armInterrupt({});
  turn3.dispose();
  assert.equal(exitIsDeferred(), false, 'between turns, Ctrl-C must kill the process');

  const turn9 = armInterrupt({});
  assert.equal(exitIsDeferred(), true, 'and turn 9 must get its own graceful press');
  assert.equal(turn9.signal.aborted, true);
  assert.equal(turn3.signal.aborted, false, 'the finished turn must not be re-aborted');
  turn9.dispose();
});

test('⚠️ a LATE dispose from a finished run cannot disarm the live one', () => {
  /**
   * `dispose()` lands in a `finally`, and a `finally` runs late. The steering
   * loop and the escalation ladder both start a second run immediately after
   * the first returns — an unguarded `graceful = null` would disarm the live
   * run on behalf of the dead one, and the symptom is the worst one this file
   * knows: Ctrl-C doing nothing, intermittently.
   */
  resetInterruptState();
  const first = armInterrupt({});
  const second = armInterrupt({});
  first.dispose();                    // the late, stale dispose
  assert.equal(exitIsDeferred(), true, 'the LIVE run must still be armed');
  assert.equal(second.signal.aborted, true);
  assert.equal(first.signal.aborted, false);
  second.dispose();
});

test('⚠️ a throwing notify still aborts, and still ends in an exit', () => {
  /**
   * If our own callback is broken the honest outcome is the OLD one — exit now
   * — never a Ctrl-C that does nothing because acuvo failed at printing.
   */
  resetInterruptState();
  const gate = armInterrupt({ notify: () => { throw new Error('stdout is gone'); } });
  assert.equal(exitIsDeferred(), false, 'a broken handler must fall back to exiting');
  assert.equal(gate.signal.aborted, true, 'and the abort must have happened first anyway');
  gate.dispose();
});

/* ── the exit code ──────────────────────────────────────────────────────── */

test('⚠️⭐ the interrupt exit code is 130 and must never collide with the verdict', () => {
  assert.equal(EXIT_INTERRUPTED, 130, '128 + SIGINT(2)');
  for (const documented of [0, 1, 2, 3, 64]) {
    assert.notEqual(EXIT_INTERRUPTED, documented,
      `exit ${documented} already means something else in bin/acuvo.mjs`);
  }
});

test('⭐⭐ BOTH halves are required to call a run "stopped by Ctrl-C"', () => {
  // The press caused the stop: 130.
  assert.equal(wasAbortedByInterrupt({ interrupted: true, outcome: { stoppedBecause: 'aborted' } }), true);

  /**
   * ⚠️ A press that lands during the LAST round leaves a completed, verified
   * run. Reporting 130 there tells a script to retry a job that succeeded.
   */
  assert.equal(wasAbortedByInterrupt({ interrupted: true, outcome: { stoppedBecause: 'verified' } }), false);

  /**
   * ⚠️ The signal is also how a lost lease or a fleet ceiling stops a run —
   * `abort-signal.test.mjs` keeps three distinct causes distinguishable on
   * purpose. Those are not interrupts and keep the ordinary verdict exit.
   */
  assert.equal(wasAbortedByInterrupt({ interrupted: false, outcome: { stoppedBecause: 'aborted' } }), false);

  // And the ordinary run, which is every run.
  assert.equal(wasAbortedByInterrupt({}), false);
  assert.equal(wasAbortedByInterrupt({ interrupted: true, outcome: null }), false);
});

/* ── REACH: the arming actually stops the real loop ─────────────────────── */

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('⭐⭐ REACH — a press mid-run stops the REAL loop at the round boundary', async () => {
  /**
   * The unit tests above prove the policy. This proves the policy is CONNECTED:
   * `armInterrupt` → `runSession({ signal })` → the round-boundary check →
   * `stoppedBecause: 'aborted'` → a clean return that still carries the
   * transcript. Every one of those links was present before today and none of
   * them was joined up.
   */
  resetInterruptState();
  const notices = [];
  const gate = armInterrupt({ notify: (n) => notices.push(n) });

  let calls = 0;
  const out = await runSession({
    task: 'keep going forever',
    executor: createLocalExecutor(mkdtempSync(join(tmpdir(), 'acuvo-ctrlc-'))),
    config: { apiKey: 'k', model: 'm' },
    signal: gate.signal,
    maxRounds: 8,
    callModelImpl: async () => {
      calls += 1;
      // The user presses Ctrl-C while round 2 is in flight. This is the exact
      // call the five signal handlers make.
      if (calls === 2) exitIsDeferred('you pressed Ctrl-C');
      return {
        ok: true,
        content: 'still working',
        // A tool call keeps the loop going; without one it stops itself with
        // `no-tool-calls` and this test would pass for the wrong reason.
        toolCalls: [{ id: `c${calls}`, name: 'read_file', arguments: { path: 'nope.txt' } }],
        usage: {},
        finishReason: 'tool_calls',
      };
    },
    onEvent: () => {},
  });
  gate.dispose();

  assert.equal(out.stoppedBecause, 'aborted', 'the loop must have seen the abort');
  assert.equal(calls, 2, 'it must stop at the NEXT boundary — not mid-round, not two rounds later');
  assert.ok(calls < 8, 'and it must not have run to the round cap');
  assert.equal(out.ok, true, 'an abort is a clean outcome — that is what saves the transcript');
  assert.ok(Array.isArray(out.messages) && out.messages.length > 0,
    'the conversation must survive, or --resume has nothing to resume');
  assert.deepEqual(notices, [FIRST_PRESS_NOTICE]);
  assert.equal(wasAbortedByInterrupt({ interrupted: gate.wasInterrupted(), outcome: out }), true,
    'and the exit code decision must agree that this was an interrupt');
});

test('⭐⭐ an unarmed run is byte-identical to yesterday — no signal, no stop', async () => {
  resetInterruptState();
  let calls = 0;
  const out = await runSession({
    task: 'do the thing',
    executor: createLocalExecutor(mkdtempSync(join(tmpdir(), 'acuvo-ctrlc-'))),
    config: { apiKey: 'k', model: 'm' },
    maxRounds: 1,
    callModelImpl: async () => { calls += 1; return { ok: true, content: 'done', toolCalls: [], usage: {}, finishReason: 'stop' }; },
    onEvent: () => {},
  });
  assert.equal(calls, 1);
  assert.notEqual(out.stoppedBecause, 'aborted');
});
