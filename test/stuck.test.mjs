/**
 * ── ⚠️⚠️ THE FALSE POSITIVE IS THE ONLY EXPENSIVE DIRECTION ─────────────────
 *
 * This detector exists so the round cap can be removed. That makes its two
 * failure modes wildly asymmetric:
 *
 *   · MISSING a loop costs a few more cents of a budget the user set anyway.
 *   · CALLING a working run stuck costs the user the WORK AND the money —
 *     everything spent so far is thrown away one round before it succeeded.
 *
 * So this file is deliberately lopsided: five tests pin the patterns, and a
 * larger block pins the LEGITIMATE shapes that look superficially identical and
 * must never be flagged. If you tighten a threshold, the negatives are the ones
 * that will catch you.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStuck, nudgeMessage, STUCK_PATTERNS } from '../lib/stuck.mjs';

/* ── builders in the exact shape lib/turn.mjs pushes onto `rounds` ────────────
 * `{ round, note, executed: [record], usage, finishReason, model }` where a
 * record is `{ id, name, args, result, mutated }` from tools.mjs's dispatcher.
 * Getting this shape wrong is how a detector passes its unit tests and sees
 * nothing in production, so it is copied from the source, not invented. */

let seq = 0;
const round = (n, executed, note = '') => ({
  round: n, note, executed, usage: null, finishReason: 'tool_calls', model: 'test',
});

const write = (path, content, ok = true) => ({
  id: `c${seq++}`, name: 'write_file', args: { path, content },
  result: ok
    ? { ok: true, path, bytes: content.length, previousBytes: 0, created: false }
    : { ok: false, error: `cannot write ${path}` },
  mutated: ok,
});

const editOk = (path, oldString = 'a', newString = 'b') => ({
  id: `c${seq++}`, name: 'edit_file', args: { path, old_string: oldString, new_string: newString },
  result: { ok: true, path, bytes: 42 }, mutated: true,
});

const editFail = (path, oldString, error) => ({
  id: `c${seq++}`, name: 'edit_file', args: { path, old_string: oldString, new_string: 'x' },
  result: { ok: false, error }, mutated: false,
});

const cmd = (command, exitCode, stderr = '') => ({
  id: `c${seq++}`, name: 'run_command', args: { command },
  result: {
    ok: true, command, exitCode, passed: exitCode === 0,
    stdout: '', stderr, timedOut: false, argv: [], durationMs: 5,
  },
  mutated: false,
});

const read = (path) => ({
  id: `c${seq++}`, name: 'read_file', args: { path },
  result: { ok: true, path, content: 'contents of ' + path, bytes: 12 }, mutated: false,
});

const search = (pattern) => ({
  id: `c${seq++}`, name: 'search_text', args: { pattern },
  result: { ok: true, matches: [] }, mutated: false,
});

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE PATTERNS — each one observed in a real transcript
 * ══════════════════════════════════════════════════════════════════════════ */

test('the same file written with byte-identical content twice is a loop', () => {
  const body = 'export const x = 1;\n';
  const r = detectStuck([
    round(1, [write('src/x.js', body), cmd('node src/x.js', 1, 'ReferenceError: y is not defined')]),
    round(2, [write('src/x.js', body), cmd('node src/x.js', 1, 'ReferenceError: y is not defined')]),
  ]);

  assert.equal(r.stuck, true);
  assert.equal(r.pattern, 'repeated-identical-edit');
  assert.equal(r.evidence.path, 'src/x.js');
  assert.equal(r.evidence.count, 2);
  // ⭐ the suggestion is the payload — it must name the artifact, not just assert a verdict
  assert.match(r.suggestion, /src\/x\.js/);
  assert.ok(r.suggestion.length > 40, 'a one-word verdict is not actionable');
});

test('a file flipped A -> B -> A is thrashing, and outranks the identical-write report', () => {
  const A = 'const mode = "sync";\n';
  const B = 'const mode = "async";\n';
  const r = detectStuck([
    round(1, [write('lib/mode.js', A)]),
    round(2, [write('lib/mode.js', B)]),
    round(3, [write('lib/mode.js', A)]),
  ]);

  assert.equal(r.stuck, true);
  // A -> B -> A also contains two identical writes of A; the more specific
  // diagnosis has to win or the nudge tells the model the wrong thing.
  assert.equal(r.pattern, 'thrashing');
  assert.equal(r.evidence.path, 'lib/mode.js');
  assert.match(r.suggestion, /lib\/mode\.js/);
});

test('the same command, same exit code, same first error line, three times', () => {
  const err = 'TypeError: cannot read properties of undefined\n    at run (test/a.js:3:9)\n';
  const r = detectStuck([
    round(1, [cmd('npm test', 1, err)]),
    round(2, [cmd('npm test', 1, err)]),
    round(3, [cmd('npm test', 1, err)]),
  ]);

  assert.equal(r.stuck, true);
  assert.equal(r.pattern, 'repeated-command-failure');
  assert.equal(r.evidence.command, 'npm test');
  assert.equal(r.evidence.exitCode, 1);
  assert.equal(r.evidence.count, 3);
  assert.match(r.evidence.errorLine, /TypeError/);
  assert.match(r.suggestion, /npm test/);
});

test('rounds that write nothing, run nothing and re-ask the same questions', () => {
  const r = detectStuck([
    round(1, [read('README.md'), read('package.json')]),
    round(2, [read('README.md')]),
    round(3, [read('package.json'), read('README.md')]),
    round(4, [read('README.md')]),
  ]);

  assert.equal(r.stuck, true);
  assert.equal(r.pattern, 'no-progress');
  assert.ok(r.evidence.count >= 3);
  assert.ok(r.suggestion.length > 40);
});

test('a tool refusing three times with the identical message is a loop', () => {
  const why = 'lib/a.js: old_string not found in file';
  const r = detectStuck([
    round(1, [editFail('lib/a.js', 'function foo() {', why)]),
    round(2, [editFail('lib/a.js', 'function foo(){', why)]),
    round(3, [editFail('lib/a.js', 'function  foo() {', why)]),
  ]);

  assert.equal(r.stuck, true);
  assert.equal(r.pattern, 'tool-error-loop');
  assert.equal(r.evidence.tool, 'edit_file');
  assert.equal(r.evidence.count, 3);
  assert.match(r.suggestion, /edit_file/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. THE LEGITIMATE SHAPES — the expensive direction. All five must be clean.
 * ══════════════════════════════════════════════════════════════════════════ */

test('LEGIT: reading the same file over and over while editing different parts of it', () => {
  const r = detectStuck([
    round(1, [read('src/app.js'), editOk('src/app.js', 'const a = 1', 'const a = 2')]),
    round(2, [read('src/app.js'), editOk('src/app.js', 'const b = 1', 'const b = 2')]),
    round(3, [read('src/app.js'), editOk('src/app.js', 'const c = 1', 'const c = 2')]),
    round(4, [read('src/app.js'), editOk('src/app.js', 'const d = 1', 'const d = 2')]),
  ]);
  assert.equal(r.stuck, false, `flagged a working edit session as ${r.pattern}`);
  assert.equal(r.pattern, null);
});

test('LEGIT: a test failing the same way while the code genuinely changes between runs', () => {
  const err = 'AssertionError: expected 1 to equal 2\n';
  const r = detectStuck([
    round(1, [write('src/sum.js', 'export const sum = (a,b) => a;\n'), cmd('npm test', 1, err)]),
    round(2, [write('src/sum.js', 'export const sum = (a,b) => a - b;\n'), cmd('npm test', 1, err)]),
    round(3, [write('src/sum.js', 'export const sum = (a,b) => a * b;\n'), cmd('npm test', 1, err)]),
  ]);
  assert.equal(r.stuck, false, `flagged real iteration as ${r.pattern}`);
});

test('LEGIT: a long research phase — many reads, no writes, no commands', () => {
  const r = detectStuck([
    round(1, [read('a.js'), read('b.js')]),
    round(2, [search('createServer'), read('c.js')]),
    round(3, [read('d.js'), search('listen(')]),
    round(4, [read('e.js'), read('f.js')]),
    round(5, [search('router'), read('g.js')]),
  ]);
  assert.equal(r.stuck, false, `flagged research as ${r.pattern}`);
});

test('LEGIT: retrying after a transient failure that then succeeds', () => {
  const net = 'FetchError: ETIMEDOUT registry.npmjs.org';
  const r = detectStuck([
    round(1, [cmd('npm install', 1, net)]),
    round(2, [cmd('npm install', 1, net)]),
    round(3, [cmd('npm install', 0, '')]),
    round(4, [cmd('npm test', 0, '')]),
  ]);
  assert.equal(r.stuck, false, `flagged a recovered retry as ${r.pattern}`);
});

test('LEGIT: the same command failing DIFFERENTLY each time is progress, not stuckness', () => {
  const r = detectStuck([
    round(1, [cmd('npm test', 1, 'SyntaxError: unexpected token }')]),
    round(2, [cmd('npm test', 1, 'ReferenceError: sum is not defined')]),
    round(3, [cmd('npm test', 1, 'AssertionError: expected 3 to equal 4')]),
  ]);
  assert.equal(r.stuck, false, `flagged a descending error chain as ${r.pattern}`);
});

/* ── further negatives that a naive implementation gets wrong ─────────────── */

test('LEGIT: identical content written to DIFFERENT paths is a template, not a loop', () => {
  const boiler = '{\n  "type": "module"\n}\n';
  const r = detectStuck([
    round(1, [write('a/package.json', boiler)]),
    round(2, [write('b/package.json', boiler)]),
    round(3, [write('c/package.json', boiler)]),
  ]);
  assert.equal(r.stuck, false, `flagged scaffolding as ${r.pattern}`);
});

test('LEGIT: a tool that fails, then succeeds, then fails again has not looped', () => {
  const why = 'lib/a.js: old_string not found in file';
  const r = detectStuck([
    round(1, [editFail('lib/a.js', 'x', why)]),
    round(2, [editOk('lib/a.js')]),
    round(3, [editFail('lib/a.js', 'y', why)]),
    round(4, [editOk('lib/a.js')]),
  ]);
  assert.equal(r.stuck, false, `flagged an intermittent tool error as ${r.pattern}`);
});

test('LEGIT: the same failing command with a different exit code is not the same failure', () => {
  const err = 'boom';
  const r = detectStuck([
    round(1, [cmd('npm test', 1, err)]),
    round(2, [cmd('npm test', 2, err)]),
    round(3, [cmd('npm test', 1, err)]),
  ]);
  assert.equal(r.stuck, false, `flagged differing exit codes as ${r.pattern}`);
});

test('LEGIT: two identical writes far apart are outside the window', () => {
  const body = 'const x = 1;\n';
  const r = detectStuck([
    round(1, [write('src/x.js', body)]),
    round(2, [write('src/b.js', 'b\n')]),
    round(3, [write('src/c.js', 'c\n')]),
    round(4, [write('src/d.js', 'd\n')]),
    round(5, [write('src/e.js', 'e\n')]),
    round(6, [write('src/x.js', body)]),
  ], { window: 3 });
  assert.equal(r.stuck, false, `flagged a revisit outside the window as ${r.pattern}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. SHAPE, ROBUSTNESS, AND THE WIRING CONTRACT
 * ══════════════════════════════════════════════════════════════════════════ */

test('a clean result is fully null, never partially populated', () => {
  const r = detectStuck([round(1, [write('a.js', 'a')])]);
  assert.deepEqual(r, { stuck: false, pattern: null, evidence: null, suggestion: null });
});

test('nothing, garbage and half-built records are survivable, never thrown on', () => {
  for (const input of [undefined, null, [], 'rounds', 42, [null], [{}], [{ executed: null }]]) {
    const r = detectStuck(input);
    assert.equal(r.stuck, false, `threw or flagged on ${JSON.stringify(input)}`);
  }
  // a record missing args / result entirely — a provider can emit a call with
  // unparseable arguments and tools.mjs returns `args: {}`
  const r = detectStuck([
    round(1, [{ name: 'write_file', args: {}, result: { ok: false, error: 'bad json' } }]),
    round(2, [{ name: 'write_file' }]),
    round(3, [{}]),
  ]);
  assert.equal(typeof r.stuck, 'boolean');
});

test('a non-string content or path is ignored rather than matched against itself', () => {
  const bad = (path, content) => ({
    id: 'z', name: 'write_file', args: { path, content },
    result: { ok: true, path: String(path), bytes: 0 }, mutated: true,
  });
  const r = detectStuck([
    round(1, [bad('a.js', undefined)]),
    round(2, [bad('a.js', undefined)]),
  ]);
  assert.equal(r.stuck, false, 'two undefined contents are not two identical writes');
});

test('backslash and ./ path spellings are the same file', () => {
  const body = 'x\n';
  const r = detectStuck([
    round(1, [write('src\\x.js', body)]),
    round(2, [write('./src/x.js', body)]),
  ]);
  assert.equal(r.stuck, true);
  assert.equal(r.pattern, 'repeated-identical-edit');
});

test('evidence carries a stable key so a caller nudges once per distinct loop', () => {
  const body = 'x\n';
  const rounds = [round(1, [write('a.js', body)]), round(2, [write('a.js', body)])];
  const first = detectStuck(rounds);
  const again = detectStuck([...rounds, round(3, [read('b.js')])]);
  assert.equal(first.evidence.key, again.evidence.key, 'the same loop must keep one identity');
  assert.match(first.evidence.key, /^repeated-identical-edit:/);

  const other = detectStuck([round(1, [write('b.js', body)]), round(2, [write('b.js', body)])]);
  assert.notEqual(other.evidence.key, first.evidence.key, 'a different file is a different loop');
});

test('nudgeMessage renders the hint for the model, and nothing for a clean run', () => {
  const body = 'x\n';
  const r = detectStuck([round(1, [write('a.js', body)]), round(2, [write('a.js', body)])]);
  const msg = nudgeMessage(r);
  assert.equal(typeof msg, 'string');
  assert.ok(msg.includes(r.suggestion), 'the suggestion is the message');
  assert.equal(nudgeMessage({ stuck: false, pattern: null, evidence: null, suggestion: null }), null);
  assert.equal(nudgeMessage(null), null);
});

test('the nudge reads as a hint, not a scolding or a verdict', () => {
  const body = 'x\n';
  const cases = [
    detectStuck([round(1, [write('a.js', body)]), round(2, [write('a.js', body)])]),
    detectStuck([round(1, [cmd('npm test', 1, 'e')]), round(2, [cmd('npm test', 1, 'e')]), round(3, [cmd('npm test', 1, 'e')])]),
  ];
  for (const r of cases) {
    const msg = nudgeMessage(r);
    // ⚠️ this text is fed to the MODEL. "you are stuck / you failed / stop" is a
    // scolding it cannot act on, and worse, reads as an instruction to give up —
    // which is the exact behaviour the unattended loop exists to prevent.
    assert.doesNotMatch(msg, /\byou (?:are|have) (?:stuck|failed)\b/i);
    assert.doesNotMatch(msg, /\b(?:give up|abort|stop now)\b/i);
    assert.match(msg, /\?|try|check|read|before/i, 'a hint proposes a next move');
  }
});

test('STUCK_PATTERNS names every pattern the detector can return', () => {
  assert.ok(Array.isArray(STUCK_PATTERNS));
  const seen = new Set();
  const body = 'x\n';
  seen.add(detectStuck([round(1, [write('a.js', body)]), round(2, [write('a.js', body)])]).pattern);
  seen.add(detectStuck([round(1, [write('a.js', 'A')]), round(2, [write('a.js', 'B')]), round(3, [write('a.js', 'A')])]).pattern);
  seen.add(detectStuck([round(1, [cmd('t', 1, 'e')]), round(2, [cmd('t', 1, 'e')]), round(3, [cmd('t', 1, 'e')])]).pattern);
  seen.add(detectStuck([round(1, [read('a')]), round(2, [read('a')]), round(3, [read('a')])]).pattern);
  seen.add(detectStuck([round(1, [editFail('a', 'x', 'no match')]), round(2, [editFail('a', 'y', 'no match')]), round(3, [editFail('a', 'z', 'no match')])]).pattern);
  for (const p of seen) assert.ok(STUCK_PATTERNS.includes(p), `${p} is missing from STUCK_PATTERNS`);
  assert.equal(seen.size, STUCK_PATTERNS.length, 'STUCK_PATTERNS lists a pattern nothing produces');
});

test('the window option is honoured and clamped to something sane', () => {
  const body = 'x\n';
  const rounds = [round(1, [write('a.js', body)]), round(2, [write('a.js', body)])];
  assert.equal(detectStuck(rounds, { window: 2 }).stuck, true);
  assert.equal(detectStuck(rounds, { window: 1 }).stuck, false, 'one round cannot contain two rounds of history');
  for (const bad of [0, -5, NaN, 'four', null]) {
    assert.equal(typeof detectStuck(rounds, { window: bad }).stuck, 'boolean', `window=${bad} threw`);
  }
});

test('run_program and evaluate count as runs, so a round containing one is not inert', () => {
  const prog = (argv, exitCode) => ({
    id: 'p', name: 'run_program', args: { argv },
    result: { ok: true, argv, exitCode, passed: exitCode === 0, stdout: '', stderr: '' },
    mutated: false,
  });
  const r = detectStuck([
    round(1, [read('a.js'), prog(['node', 'a.js'], 0)]),
    round(2, [read('a.js'), prog(['node', 'a.js'], 0)]),
    round(3, [read('a.js'), prog(['node', 'a.js'], 0)]),
  ]);
  assert.notEqual(r.pattern, 'no-progress', 'a round that ran a program observed something');
});
