/**
 * ── ⭐⭐ THE CORE AGENTIC CODING LOOP MUST READ AS PROSE, NOT AS JSON ────────
 *
 * "start a server, watch its log, wait for the line that means ready" is the
 * loop. All six of those verbs used to reach the model through
 * `stringifyForModel` — parseable, and with every newline of a build log
 * escaped as `\n` inside one long string. The fields that decide the NEXT move
 * (is it running? what exit code? which id?) sat mid-object.
 *
 * ⚠️ THIS IS NOT A BUG FIX AND THE TESTS SHOULD NOT PRETEND IT IS. The default
 * was correct — `stringifyForModel` shrinks large string FIELDS rather than
 * splicing the middle out of a serialised object, which is what once made a
 * `git_diff` reply fail `JSON.parse`. What these assert is LEGIBILITY, which is
 * what the model actually acts on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolResultText } from '../lib/turn.mjs';

const render = (name, result) => toolResultText({ name, result });

test('⭐ start_process leads with the id and the pid', () => {
  const out = render('start_process', { ok: true, id: 'bg-1', pid: 4242, note: 'started in the background as bg-1.' });
  assert.match(out, /started bg-1/);
  assert.match(out, /pid 4242/);
});

test('⚠️⚠️ and the note that names wait_for_output survives VERBATIM', () => {
  /**
   * `background.mjs` records the measurement: the previous wording taught the
   * model to poll `check_process` — **146 times across the measured archive, at
   * one whole model call each**. The first sentence about a job now names the
   * BLOCKING verb, and a formatter that dropped it would silently reintroduce
   * the poll.
   */
  const note = 'started in the background as bg-1. ⚠️ To WAIT for it, call wait_for_output {"id":"bg-1"}';
  const out = render('start_process', { ok: true, id: 'bg-1', pid: 1, note });
  assert.ok(out.includes('wait_for_output'), 'the anti-poll advice must reach the model');
  assert.ok(out.includes(note), 'the note is passed through, not paraphrased');
});

test('⭐ check_process states RUNNING or the exit code FIRST — it decides the next move', () => {
  const running = render('check_process', { ok: true, id: 'bg-1', command: 'npm run dev', running: true, output: 'listening on 3000' });
  assert.match(running.split('\n')[0], /RUNNING/);
  assert.match(running, /\$ npm run dev/);
  assert.match(running, /listening on 3000/);

  const done = render('check_process', { ok: true, id: 'bg-1', command: 'npm test', running: false, exitCode: 1, output: '3 failing' });
  assert.match(done.split('\n')[0], /exited with code 1/);
});

test('⚠️ "no output yet" is said out loud — an empty string reads as neither fact', () => {
  const out = render('check_process', { ok: true, id: 'bg-1', command: 'x', running: true, output: '' });
  assert.match(out, /no output yet/);
});

test('the argv receipt survives, because it is the thing the string runner cannot show', () => {
  const out = render('check_process', { ok: true, id: 'bg-1', running: true, argv: ['node', 'x.js', '--port', '3005'] });
  assert.match(out, /--port/);
  assert.ok(out.includes('"3005"'), 'each argument in its own slot');
});

test('stop_process says when it was not running at all', () => {
  assert.match(render('stop_process', { ok: true, id: 'bg-1', stopped: false }), /was not running/);
  assert.match(render('stop_process', { ok: true, id: 'bg-1', stopped: true, output: 'bye' }), /final output/);
});

test('⭐ the log verbs lead with the process state, not with the text', () => {
  const still = render('wait_for_output', { ok: true, text: 'compiling…', running: true });
  assert.match(still.split('\n')[0], /STILL RUNNING/);

  const exited = render('read_log', { ok: true, text: 'Error: boom', running: false, exitCode: 2 });
  assert.match(exited.split('\n')[0], /exited with code 2/);
  assert.match(exited, /Error: boom/);
});

test('⚠️⚠️ a wait that TIMED OUT no longer reaches the model as "unknown error"', () => {
  /**
   * ⭐ MEASURED 2026-09-01, and it is the same defect the audit found in
   * `review_code`:
   *
   *     wait_for_output { ok:false, reason:'timeout', waitedMs:30000, text:'…' }
   *       →  "wait_for_output failed: unknown error"
   *
   * A timeout is the MOST COMMON outcome of this verb and the one that decides
   * what happens next — the line never came, here is how long we waited, and
   * here is what the log DOES say. All three were discarded because the result
   * carried `reason` rather than `error`, and the single funnel every failure
   * passes through read exactly one key.
   *
   * ⚠️ The log text riding along matters as much as the reason: without it the
   * model spends another round on `read_log` for text we already held.
   */
  const out = render('wait_for_output', { ok: false, reason: 'timeout', waitedMs: 30_000, text: 'still starting' });
  assert.match(out, /failed: timeout/);
  assert.match(out, /after 30s/);
  assert.match(out, /still starting/, 'the log we already had must come with the failure');
  assert.ok(!out.includes('unknown error'));
});

test('⚠️ but an explicit `error` still WINS — no existing message changes', () => {
  const out = render('wait_for_output', { ok: false, reason: 'timeout', error: 'the pattern never matched' });
  assert.match(out, /the pattern never matched/);
  assert.ok(!out.includes('failed: timeout'), 'a deliberate human sentence outranks a machine code');
});

test('⚠️ an empty log says so rather than rendering as nothing at all', () => {
  assert.match(render('read_log', { ok: true, text: '' }), /nothing in the log yet/);
});

test('repl shows the value, then the console, then the time', () => {
  const out = render('repl', { ok: true, value: '42', logs: ['a', 'b'], ms: 12 });
  const lines = out.split('\n');
  assert.equal(lines[0], '42');
  assert.match(out, /--- console ---/);
  assert.match(out, /\(12ms\)/);
});

test('⚠️ a repl that returned nothing says that, instead of an empty string', () => {
  assert.match(render('repl', { ok: true, logs: [] }), /no value and no output/);
});

test('⚠️ 40 console lines are shown and the remainder is COUNTED, never dropped silently', () => {
  const logs = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  const out = render('repl', { ok: true, value: 'x', logs });
  assert.match(out, /line 39/);
  assert.ok(!out.includes('line 41'), 'beyond the cap is not printed');
  assert.match(out, /20 more console line\(s\)/);
});

test('⚠️⚠️ every formatter is DEFENSIVE — an unexpected shape must not throw', () => {
  /**
   * A formatter that throws turns a working tool into a failed one. That is
   * exactly what `review_code` did: it returned no `ok` field, so every
   * SUCCESSFUL review reached the model as "review_code failed: unknown error".
   */
  const names = ['start_process', 'check_process', 'stop_process', 'read_log', 'wait_for_output', 'summarize_log', 'repl', 'repl_reset'];
  for (const n of names) {
    for (const weird of [{}, { ok: true }, { ok: true, text: null }, { ok: true, logs: 'not-an-array' }, { ok: true, output: 42 }]) {
      assert.doesNotThrow(() => render(n, weird), `${n} threw on ${JSON.stringify(weird)}`);
      assert.equal(typeof render(n, weird), 'string');
    }
  }
});
