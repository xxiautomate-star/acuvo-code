/**
 * ── ⭐⭐⭐ PUTTING THE TERMINAL BACK — THE THING NOBODY FILES A TICKET FOR ────
 *
 * Roman, on this whole class of work: *"I will never know to ask for that, it
 * is your job."* Nobody reports "acuvo left my shell in raw mode", because by
 * the time they notice, acuvo is gone and what is broken is their terminal. They
 * type `reset` blind, or close the window, and think their shell is flaky.
 *
 * ── ⚠️ WHAT IS AND IS NOT PROVABLE WITHOUT A REAL TTY ───────────────────────
 *
 * These tests drive the DECISIONS: that a restore hook is registered while the
 * process is sitting in raw mode, that it is removed afterwards so a hundred
 * turns do not leak a hundred listeners, that firing it lowers raw mode and
 * re-shows the cursor, and that a reserved scroll region releases itself even
 * when the caller forgets.
 *
 * ⚠️ WHAT THEY CANNOT PROVE is that a real terminal emulator obeys the bytes.
 * That needs a human in a real VS Code / Windows Terminal / iTerm session, and
 * the manual check is written down in `unknowns` rather than faked here. A test
 * that supplies its own terminal cannot discover that the real one disagreed —
 * which is exactly how `spawn('npm.cmd')` stayed broken on every Windows machine
 * while its test passed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readBoxedLine, pinRegion, restoreTerminal, paint } from '../lib/input-box.mjs';

/** A stand-in for `process` that records what was hooked, with no real signals. */
const fakeLifecycle = () => {
  const ee = new EventEmitter();
  return {
    ee,
    once: (n, fn) => ee.once(n, fn),
    off: (n, fn) => ee.off(n, fn),
    count: () => ee.listenerCount('exit'),
    fire: () => ee.emit('exit'),
  };
};

const tty = (rows) => ({ isTTY: true, rows, columns: 80, text: '', write(s) { this.text += s; } });

test('⭐⭐⭐ raw mode and a hidden cursor are undone on the way out', () => {
  let raw = 'never called';
  const input = { setRawMode: (v) => { raw = v; } };
  const output = { text: '', write(s) { this.text += s; } };

  restoreTerminal({ input, output });

  assert.equal(raw, false, 'a shell with no echo and no line editing is the worst exit a CLI can make');
  assert.match(output.text, /\x1b\[\?25h/, 'the cursor must come back — a hidden one reads as a frozen shell');
  assert.match(output.text, /\x1b\[0m/, 'and an open SGR would colour everything the user types next');
});

test('⚠️ restoring must never throw, whatever is left of the terminal', () => {
  assert.doesNotThrow(() => restoreTerminal({}));
  assert.doesNotThrow(() => restoreTerminal({
    input: { setRawMode() { throw new Error('not a TTY any more'); } },
    output: { write() { throw Object.assign(new Error('write after end'), { code: 'ERR_STREAM_DESTROYED' }); } },
  }));
});

test('⭐⭐⭐ THE WINDOW: while waiting for a keystroke, an exit still restores the terminal', async () => {
  /**
   * ── WHY THIS IS THE WINDOW THAT MATTERS ─────────────────────────────────────
   *
   * Between `setRawMode(true)` and the user pressing Enter is where an
   * interactive session spends nearly all of its wall-clock life. A SIGTERM from
   * a supervisor, an `exit()` from one of the five signal handlers, or an
   * uncaught throw anywhere else in the program all end the process from HERE —
   * and `finish`, the only code that lowered raw mode, never runs.
   */
  const life = fakeLifecycle();
  const input = new PassThrough();
  input.isTTY = true;
  let raw = null;
  input.setRawMode = (v) => { raw = v; };
  const output = { columns: 80, text: '', write(s) { this.text += s; } };

  const done = readBoxedLine({ input, output, lifecycle: life });
  await new Promise((r) => setImmediate(r));

  assert.equal(raw, true, 'the read really is in raw mode — otherwise this test proves nothing');
  assert.equal(life.count(), 1, 'nothing would have put the terminal back');

  output.text = '';
  life.fire();
  assert.equal(raw, false, 'raw mode survived the exit');
  assert.match(output.text, /\x1b\[\?25h/, 'the cursor survived the exit');

  input.write('hi\r');
  await done;
});

test('⚠️⚠️ and the hook comes OFF again — one per turn would warn the user about a leak', async () => {
  /**
   * `chat.mjs` calls `readBoxedLine` once per turn. A hook left behind on every
   * turn is a listener leak, and Node announces those by printing a
   * MaxListenersExceededWarning at the user in the middle of their conversation
   * — a memory-leak warning about acuvo that reads like a bug in THEIR project.
   * `turn.mjs`'s registry header records that exact incident.
   */
  const life = fakeLifecycle();
  for (let turn = 0; turn < 12; turn += 1) {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => {};
    const done = readBoxedLine({ input, output: { columns: 80, write() {} }, lifecycle: life });
    await new Promise((r) => setImmediate(r));
    input.write('go\r');
    await done;
    assert.equal(life.count(), 0, `turn ${turn + 1} left a dead exit listener behind`);
  }
});

test('⭐⭐⭐ a reserved scroll region releases ITSELF — a caller must not be able to forget', () => {
  /**
   * ── ⚠️ THE HEADER PROMISED THIS AND THE CODE DID NOT DO IT ──────────────────
   *
   * `pinRegion`'s own comment says the region "must be released on every path
   * out — normal exit, Ctrl-C, SIGTERM, and an uncaught throw", and then left
   * all four to whoever called it. `chat.mjs` does register three of them, and
   * it is the only correct call site in the package. One more caller, or one
   * refactor of that block, and the user is left with a terminal that scrolls
   * inside a box until they type `reset` blind, with nothing on screen to
   * explain why.
   */
  const life = fakeLifecycle();
  const out = tty(40);
  const pin = pinRegion(out, { env: {}, lifecycle: life });
  assert.equal(pin.enabled, true);
  assert.match(out.text, /\x1b\[1;38r/, 'the region really was set — otherwise there is nothing to release');
  assert.equal(life.count(), 1, 'nobody would have released the region');

  out.text = '';
  life.fire();
  assert.match(out.text, /\x1b\[r/, 'ESC[r with no arguments is what gives the user their whole screen back');
  assert.match(out.text, /\x1b\[\?25h/, 'and the cursor goes back with it');
});

test('⚠️ release is idempotent and takes its own hook off with it', () => {
  const life = fakeLifecycle();
  const out = tty(40);
  const pin = pinRegion(out, { env: {}, lifecycle: life });

  pin.release();
  assert.equal(life.count(), 0, 'a session-per-listener would accumulate over a long-lived process');

  out.text = '';
  pin.release();
  life.fire();
  assert.equal(out.text, '', 'releasing twice must write nothing — chat.mjs already calls it in a finally');
});

test('⚠️ a pin that never engaged registers nothing', () => {
  const life = fakeLifecycle();
  const pin = pinRegion({ rows: 40, write() {} }, { env: {}, lifecycle: life });
  assert.equal(pin.enabled, false, 'off a TTY');
  assert.equal(life.count(), 0, 'there is no region to release, so there must be no hook');
});

test('⚠️⚠️ closing the terminal mid-render must not throw out of the renderer', () => {
  /**
   * The asynchronous half of this class — `EPIPE` emitted on the stream — is
   * handled once in `lib/interrupt.mjs`. This is the SYNCHRONOUS half:
   * `ERR_STREAM_DESTROYED` and `ERR_STREAM_WRITE_AFTER_END` can come straight
   * back out of `write`, from inside a keystroke handler, where nothing is
   * waiting to catch them. Neither guard covers the other.
   */
  const dead = { columns: 80, write() { throw Object.assign(new Error('write after end'), { code: 'ERR_STREAM_DESTROYED' }); } };
  assert.doesNotThrow(() => paint(dead, { value: 'hi', cursor: 2, columns: 80 }, { first: true }));
  assert.doesNotThrow(() => paint(dead, { value: 'hi', cursor: 2, columns: 80 }, { atRow: 39 }));
  assert.doesNotThrow(() => pinRegion(
    { isTTY: true, rows: 40, columns: 80, write() { throw new Error('gone'); } },
    { env: {}, lifecycle: fakeLifecycle() },
  ).release());
});

test('⚠️⚠️ a keystroke arriving after the terminal died must not crash the session', async () => {
  const life = fakeLifecycle();
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  let alive = true;
  const output = {
    columns: 80,
    write() { if (!alive) throw Object.assign(new Error('gone'), { code: 'ERR_STREAM_DESTROYED' }); },
  };

  const done = readBoxedLine({ input, output, lifecycle: life });
  await new Promise((r) => setImmediate(r));
  alive = false;
  input.write('abc');
  await new Promise((r) => setImmediate(r));
  input.write('\r');
  const got = await done;
  assert.equal(got.value, 'abc', 'the line the user typed is still the answer, terminal or no terminal');
});
