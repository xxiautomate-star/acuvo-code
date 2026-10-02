/**
 * ── ⭐⭐ MULTI-LINE INPUT AND TAB COMPLETION AT THE PROMPT ──────────────────────
 *
 * Parity audit 2026-09-26 against Claude Code's interactive-mode docs. Before
 * this, pasting a multi-line stack trace submitted LINE ONE as the whole task
 * and dropped the rest — a paid turn spent on a third of what was meant. And
 * Tab did nothing, so `/con` + Tab never became `/config`.
 *
 * Every assertion below goes red if the matching branch in `applyKey`,
 * `bracketBarePaste` or `completeSlash` is removed — see the MUTATION tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  applyKey, splitKeys, renderBox, readBoxedLine,
  bracketBarePaste, completeSlash, PASTE_START, PASTE_END, ALT_ENTER, NEWLINE_GLYPH,
  BRACKETED_PASTE_ON, BRACKETED_PASTE_OFF,
} from '../lib/input-box.mjs';

const type = (s, text) => splitKeys(text).reduce(applyKey, s);
const fresh = (over = {}) => ({ value: '', cursor: 0, history: [], historyIndex: 0, ...over });

/* ── paste ─────────────────────────────────────────────────────────────────── */

test('⭐⭐⭐ a BRACKETED paste keeps every line and does not submit', () => {
  const s = type(fresh(), `${PASTE_START}Error: boom\r\n    at a.js:1\r\n    at b.js:2${PASTE_END}`);
  assert.equal(s.done, undefined, 'a paste must never send the message');
  assert.equal(s.value, 'Error: boom\n    at a.js:1\n    at b.js:2', 'CRLF is ONE newline, and no line is lost');
  assert.equal(s.pasting, false, 'the paste ended, so Enter submits again');
  assert.equal(applyKey(s, '\r').done, 'submit');
});

test('⭐⭐ an UNBRACKETED paste (newline with text after it) is re-shaped into one', () => {
  assert.equal(bracketBarePaste('line one\nline two\n'), `${PASTE_START}line one\nline two${PASTE_END}`,
    'the trailing newline of a paste is dropped, not obeyed');
  const s = type(fresh(), bracketBarePaste('line one\nline two\n'));
  assert.equal(s.value, 'line one\nline two');
  assert.equal(s.done, undefined);
});

test('⚠️ typing fast then Enter in ONE chunk is still Enter — scripted drivers write exactly this', () => {
  assert.equal(bracketBarePaste('hi\r'), 'hi\r');
  assert.equal(bracketBarePaste('\r'), '\r');
  assert.equal(bracketBarePaste('\r\n'), '\r\n');
  assert.equal(type(fresh(), bracketBarePaste('hi\r')).done, 'submit');
});

test('⭐ backslash + Enter continues the line, and the backslash is consumed', () => {
  const s = type(fresh(), 'first\\\rsecond');
  assert.equal(s.done, undefined);
  assert.equal(s.value, 'first\nsecond');
});

test('⭐ Alt+Enter inserts a newline — splitKeys keeps ESC CR together', () => {
  assert.deepEqual(splitKeys(`a${ALT_ENTER}b`), ['a', ALT_ENTER, 'b']);
  const s = type(fresh(), `a${ALT_ENTER}b`);
  assert.equal(s.value, 'a\nb');
  assert.equal(s.done, undefined);
});

test('⚠️ a newline is DRAWN as one glyph, so the box stays one row and the cursor maths holds', () => {
  const { lines, cursorColumn } = renderBox({ value: 'a\nb', cursor: 3, columns: 40 });
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes(`a${NEWLINE_GLYPH}b`), lines[1]);
  assert.ok(!lines[1].includes('\n'));
  assert.equal(cursorColumn, 1 + 2 + 3, 'one column per character, newline included');
});

test('⭐⭐⭐ WIRED: readBoxedLine returns the WHOLE paste, then submits on a real Enter', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  let text = '';
  const output = { columns: 80, write(s) { text += s; } };
  const done = readBoxedLine({ input, output, lifecycle: null });
  await new Promise((r) => setImmediate(r));
  input.write('fix this:\nTypeError: x is undefined\n    at run (a.js:3)\n');
  await new Promise((r) => setImmediate(r));
  input.write('\r');
  const got = await done;
  assert.equal(got.value, 'fix this:\nTypeError: x is undefined\n    at run (a.js:3)');
  assert.ok(text.includes(BRACKETED_PASTE_ON), 'bracketed paste is requested from a real terminal');
  assert.ok(text.includes(BRACKETED_PASTE_OFF), 'and turned off again, or the SHELL inherits it');
});

/* ── Tab completion ──────────────────────────────────────────────────────── */

test('⭐⭐ Tab completes a unique slash command, with a space ready for arguments', () => {
  assert.equal(completeSlash('/con', ['config', 'cost', 'clear']), '/config ');
  const s = applyKey(fresh({ value: '/con', cursor: 4, commands: ['config', 'cost'] }), '\t');
  assert.equal(s.value, '/config ');
  assert.equal(s.cursor, 8);
});

test('⭐ Tab extends to the longest common prefix, and does nothing when there is none to add', () => {
  assert.equal(completeSlash('/s', ['spend', 'skills', 'status']), null, 'nothing common beyond /s');
  assert.equal(completeSlash('/re', ['resume', 'rewind', 'rename-me']), null);
  assert.equal(completeSlash('/rew', ['rewind', 'rewrite']), null, 'common prefix is what was typed');
  assert.equal(completeSlash('/re', ['review', 'reviewer']), '/review');
  assert.equal(completeSlash('fix the /con', ['config']), null, 'mid-sentence is prose');
  assert.equal(completeSlash('/zz', ['config']), null);
});

test('⚠️ Tab never inserts a literal tab outside a paste, and keeps the commands list on the state', () => {
  const s = applyKey(fresh({ value: 'hello', cursor: 5, commands: ['help'] }), '\t');
  assert.equal(s.value, 'hello');
  const t = applyKey(s, 'x');
  assert.deepEqual(t.commands, ['help'], 'a keystroke must not drop the list Tab needs next time');
});

/* ── mutation: prove the tests bite ────────────────────────────────────────── */

test('MUTATION: without the paste branch, the first newline of a paste submits', () => {
  const mutated = (state, key) => (key === PASTE_START || key === PASTE_END ? state : applyKey({ ...state, pasting: false }, key));
  const s = splitKeys(`${PASTE_START}a\rb${PASTE_END}`).reduce((st, k) => (st.done ? st : mutated(st, k)), fresh());
  assert.equal(s.done, 'submit', 'the mutation reproduces the measured defect — so the real test can see it');
});
