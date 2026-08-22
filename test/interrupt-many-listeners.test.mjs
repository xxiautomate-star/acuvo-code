/**
 * ── ⚠️⚠️ ONE KEYPRESS, MANY LISTENERS — THE PRESS THAT WAS HONOURED KILLED IT ──
 *
 * `armInterrupt` shipped, and refutation found the invariant nobody had
 * written down: that exactly ONE process-level SIGINT listener exists.
 * `exitIsDeferred()` consumed `asked` once per PROCESS, while Node invokes
 * EVERY listener for a SINGLE delivery, synchronously. So with two listeners
 * the first press did the graceful abort AND THEN DIED — listener one deferred
 * and printed "stopping after this round", listener two saw `asked === true`,
 * read that as the second press, and exited on the spot. No summary, no
 * session, no audit line, no `--resume`.
 *
 * ⚠️ AND TWO LISTENERS IS THE ORDINARY CASE. `turn.mjs` installs one
 * unconditionally; `repl`, `start_process`, tsserver and LSP each install
 * another the moment the model uses that tool. One `repl` call was enough.
 *
 * ⚠️⚠️ WHY 16 GREEN TESTS MISSED IT. The existing suite exercised the policy
 * with one listener, and `interrupt-orphans-lifecycle.test.mjs` actively PINS
 * `SIGINT_LISTENERS = 1` — the one number that would have caught this, asserted
 * as a constant of the system in the single session shape where it is true. A
 * number pinned in the only configuration that satisfies it is not a guard.
 *
 * So these tests are written the other way round: they never assert how many
 * listeners exist. They register several, deliver one signal, and assert that
 * NOBODY EXITED.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  armInterrupt, exitIsDeferred, resetInterruptState, FIRST_PRESS_NOTICE,
} from '../lib/interrupt.mjs';

/**
 * A stand-in for the five real signal handlers. Each does its cleanup, consults
 * the shared policy, and "exits" — recorded rather than performed, because a
 * test that really called `process.exit` would take the runner with it.
 */
function handlerSet(count, log, opts = {}) {
  return Array.from({ length: count }, (_, i) => () => {
    log.push({ listener: i, cleanedUp: true });
    if (!exitIsDeferred('you pressed Ctrl-C', opts)) log.push({ listener: i, exited: 130 });
  });
}

/** Deliver one signal: every listener, synchronously, in registration order. */
const press = (handlers) => { for (const h of handlers) h(); };

/**
 * The real code schedules the window's close on `process.nextTick`. Tests drive
 * it explicitly so a "second press" is unambiguous rather than a race with the
 * runner's own microtasks.
 */
function manualSchedule() {
  const queued = [];
  const schedule = (fn) => queued.push(fn);
  return { schedule, tick: () => { while (queued.length) queued.shift()(); } };
}

test('⚠️⚠️ ONE press, TWO listeners: the run aborts and NOBODY exits', () => {
  resetInterruptState();
  const log = [];
  let aborted = 0;
  const { signal } = armInterrupt({ notify: () => log.push({ notice: true }) });
  signal.addEventListener('abort', () => { aborted += 1; });

  const { schedule } = manualSchedule();
  press(handlerSet(2, log, { schedule }));

  assert.equal(aborted, 1, 'the run must be asked to stop exactly once');
  assert.equal(log.filter((e) => e.exited).length, 0,
    `a listener exited on the press that was honoured: ${JSON.stringify(log)}`);
  assert.equal(log.filter((e) => e.cleanedUp).length, 2, 'both listeners must still do their cleanup');
});

test('⚠️⚠️ FIVE listeners — the real count when the model has used repl, start_process, tsserver and LSP', () => {
  resetInterruptState();
  const log = [];
  armInterrupt({ notify: () => {} });
  const { schedule } = manualSchedule();
  press(handlerSet(5, log, { schedule }));
  assert.equal(log.filter((e) => e.exited).length, 0, JSON.stringify(log));
});

test('⭐ the SECOND press still kills it — the escape hatch is not what was widened', () => {
  resetInterruptState();
  const log = [];
  armInterrupt({ notify: () => {} });
  const { schedule, tick } = manualSchedule();
  const handlers = handlerSet(2, log, { schedule });

  press(handlers);
  assert.equal(log.filter((e) => e.exited).length, 0, 'first press');

  tick(); // the delivery ends; a genuinely later press is a new delivery
  press(handlers);
  const exits = log.filter((e) => e.exited);
  assert.ok(exits.length >= 1, 'the second press must exit — a user who presses twice has stopped negotiating');
  assert.equal(exits[0].exited, 130, 'exit is 128+SIGINT, never 1');
});

test('⚠️ the first listener to reach the policy is the one that fires the handler — exactly once', () => {
  resetInterruptState();
  let fired = 0;
  armInterrupt({ notify: () => { fired += 1; } });
  const { schedule } = manualSchedule();
  press(handlerSet(4, [], { schedule }));
  assert.equal(fired, 1, 'the notice must not be printed once per listener');
});

test('⚠️⚠️ a THROWING handler does not wedge the process — every listener still exits', () => {
  /**
   * The window is deliberately not opened when the handler threw: nothing was
   * deferred, so telling the remaining listeners to hold would leave a Ctrl-C
   * that does nothing, which this module documents as worse than the original
   * bug.
   */
  resetInterruptState();
  const log = [];
  armInterrupt({ notify: () => { throw new Error('the notifier is broken'); } });
  const { schedule } = manualSchedule();
  press(handlerSet(3, log, { schedule }));
  assert.equal(log.filter((e) => e.exited).length, 3,
    `a broken handler must degrade to the OLD behaviour — immediate exit: ${JSON.stringify(log)}`);
});

test('⚠️ with NO handler armed, every listener exits — unarmed behaviour is untouched', () => {
  resetInterruptState();
  const log = [];
  const { schedule } = manualSchedule();
  press(handlerSet(3, log, { schedule }));
  assert.equal(log.filter((e) => e.exited).length, 3);
});

test('⭐ the window really is closed by the SCHEDULER, not by wall-clock luck', () => {
  // If the close were never scheduled, a later press would be deferred forever
  // and Ctrl-C would stop working after the first one — the failure mode this
  // module names as the worst it knows.
  resetInterruptState();
  armInterrupt({ notify: () => {} });
  const { schedule, tick } = manualSchedule();
  assert.equal(exitIsDeferred('x', { schedule }), true, 'first');
  assert.equal(exitIsDeferred('x', { schedule }), true, 'same delivery');
  tick();
  assert.equal(exitIsDeferred('x', { schedule }), false, 'a new delivery must be fatal');
});

test('⭐ the production default really is process.nextTick — no test-only seam holding this up', async () => {
  /**
   * ⚠️ THE SEAM IS THE RISK. `schedule` exists so the tests above can be exact,
   * and a default that was never exercised would mean the shipped path closes
   * the window never. This drives `exitIsDeferred` with NO options at all.
   */
  resetInterruptState();
  armInterrupt({ notify: () => {} });
  assert.equal(exitIsDeferred(), true, 'first press');
  assert.equal(exitIsDeferred(), true, 'same delivery, still deferred');
  await new Promise((r) => setImmediate(r)); // nextTick callbacks run before this
  assert.equal(exitIsDeferred(), false, 'the window must have closed on its own');
});

test('⚠️ dispose closes the delivery window too — a handed-over window swallows the next run\'s Ctrl-C', () => {
  /**
   * ⚠️ FOUND BY A SURVIVING MUTATION, not by reasoning. Dropping
   * `deferringThisDelivery = false` from dispose left all 19 tests green.
   *
   * The case: a run defers a press, disposes, and a second run arms — the
   * ladder and the steering loop both run segments back to back. With the
   * window still open, the new run's FIRST press returns "deferred" without
   * ever firing its handler: nothing aborts, nobody exits, and Ctrl-C does
   * nothing. That is the exact failure this module calls the worst it knows,
   * and it would be intermittent, because whether `nextTick` beat the `finally`
   * decides it.
   */
  resetInterruptState();
  const first = armInterrupt({ notify: () => {} });
  const { schedule } = manualSchedule(); // the window is opened and never ticked closed
  assert.equal(exitIsDeferred('x', { schedule }), true);
  first.dispose();

  let secondAborted = false;
  const second = armInterrupt({ notify: () => { secondAborted = true; } });
  assert.equal(exitIsDeferred('x', { schedule }), true, 'the new run must defer its own press');
  assert.equal(secondAborted, true, 'the new run\'s handler never fired — its Ctrl-C did nothing');
  second.dispose();
});

test('⭐ the notice the user sees still names both halves', () => {
  resetInterruptState();
  let seen = null;
  armInterrupt({ notify: (notice) => { seen = notice; } });
  exitIsDeferred('you pressed Ctrl-C', manualSchedule());
  assert.equal(seen, FIRST_PRESS_NOTICE);
  assert.match(seen, /again/, 'a user not told about the second press has no way out of a hung round');
});
