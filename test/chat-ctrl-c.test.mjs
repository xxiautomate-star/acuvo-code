/**
 * ── ⚠️⚠️⭐ READLINE EATS CTRL-C, AND THAT ALMOST SHIPPED UNNOTICED ──────────
 *
 * A correct interrupt handler in `bin/acuvo.mjs` is NECESSARY AND NOT
 * SUFFICIENT. Read out of `process.binding('natives')` on node v22.17.0,
 * `internal/readline/interface.js`, the ttyWrite ctrl-key switch:
 *
 *     case 'c':
 *       if (this.listenerCount('SIGINT') > 0) { this.emit('SIGINT'); }
 *       else { this.close(); ... }
 *
 * ⚠️ With a TTY readline open and no `'SIGINT'` listener on the INTERFACE,
 * Ctrl-C never reaches `process.on('SIGINT')` — readline quietly closes itself
 * and the run in flight carries on to completion. The user would press Ctrl-C
 * and watch nothing happen for minutes. That is strictly worse than the bug
 * this whole feature fixes, and it is invisible to every test that does not
 * drive a real readline with a real 0x03 byte. So this file does exactly that.
 *
 * ⚠️ THE SECOND TRAP IS `process.emit`. It is plain `EventEmitter.emit`, NOT
 * the OS default action — with zero listeners it does nothing at all. And
 * `turn.mjs` installs the process signal handlers inside `runSession`, so at
 * the very FIRST prompt of a session there are none. Every path out of
 * `deliverInterrupt` therefore ends in a delegation or in an exit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { runChat, deliverInterrupt } from '../lib/chat.mjs';
import { EXIT_INTERRUPTED } from '../lib/interrupt.mjs';

const CTRL_C = String.fromCharCode(3);

/** A stream readline will treat as a terminal, so the real key path runs. */
function fakeTty() {
  const s = new PassThrough();
  s.isTTY = true;
  s.setRawMode = () => {};
  return s;
}

function sink() {
  const s = new PassThrough();
  s.isTTY = true;
  s.text = '';
  s.on('data', (c) => { s.text += c.toString(); });
  return s;
}

/* ── the delivery decision ──────────────────────────────────────────────── */

test('⭐ with process listeners present, the signal is delegated to them', () => {
  let emitted = null;
  const verdict = deliverInterrupt({
    emit: (sig) => { emitted = sig; },
    listenerCount: () => 2,
    exit: () => assert.fail('must not exit while somebody is listening'),
  });
  assert.equal(verdict, 'delegated');
  assert.equal(emitted, 'SIGINT', 'the one policy in interrupt.mjs decides, not this function');
});

test('⚠️⚠️ with NO listeners it exits 130 — a synthetic emit into an empty emitter does nothing', () => {
  /**
   * This is the inert-Ctrl-C trap. Before the first turn of a session
   * `turn.mjs` has not installed its handlers yet, so delegating would return
   * `false` having done absolutely nothing while readline had already
   * swallowed the key.
   */
  let code = null;
  const verdict = deliverInterrupt({
    emit: () => assert.fail('emitting into nothing is the bug'),
    listenerCount: () => 0,
    exit: (c) => { code = c; },
  });
  assert.equal(verdict, 'exited');
  assert.equal(code, EXIT_INTERRUPTED, 'and 130, not 1 — an interrupt is not a verdict');
});

/* ── REACH: a real 0x03 byte through a real readline ────────────────────── */

test('⭐⭐ REACH — a real Ctrl-C keystroke reaches the interrupt path', async () => {
  const input = fakeTty();
  const output = sink();
  const seen = [];

  const done = runChat({
    runOne: async () => ({ ok: true, messages: [], stoppedBecause: 'no-tool-calls' }),
    render: () => {},
    input,
    output,
    onInterrupt: () => { seen.push('interrupt'); },
  });

  // Let runChat reach its first prompt, then press Ctrl-C.
  await new Promise((r) => setImmediate(r));
  input.write(CTRL_C);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(seen, ['interrupt'],
    'readline swallowed the key — nothing in bin/acuvo.mjs could ever have seen it');

  /**
   * ⚠️ AND THE SESSION MUST STILL BE ALIVE. `this.close()` is what readline
   * does when nobody listens; if our listener were missing or once-only, the
   * interface would be closed here and the turn below would never run.
   */
  seen.length = 0;
  input.write(CTRL_C);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['interrupt'], 'the SECOND press — the one that quits — must arrive too');

  input.end();
  await done;
});

test('⭐ a piped (non-TTY) session is untouched — no readline, no listener, no change', async () => {
  /**
   * Ctrl-C in a pipe is delivered to the process by the OS in the ordinary way;
   * there is no readline in the path to intercept it. This asserts we did not
   * quietly change the scripted path while fixing the interactive one.
   */
  const input = new PassThrough();
  const output = sink();
  const tasks = [];
  const done = runChat({
    runOne: async (t) => { tasks.push(t); return { ok: true, messages: [] }; },
    render: () => {},
    input,
    output,
    onInterrupt: () => assert.fail('a pipe must not route interrupts through readline'),
  });
  input.end('write a test\n');
  const { turns } = await done;
  assert.equal(turns, 1);
  assert.deepEqual(tasks, ['write a test']);
});
