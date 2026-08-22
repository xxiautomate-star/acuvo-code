import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, parsePatch, locateHunk, normalisePunctuation, BEGIN, END } from '../lib/apply-patch.mjs';

/**
 * ── ⭐⭐⭐ THE MEASURED CASE FOR THIS FILE ────────────────────────────────────
 *
 * Removing flexible patch application caused a **9x increase in editing errors**
 * across harnesses. The failures are not comprehension — the model knew the
 * change — they are APPLICATION.
 *
 * `diff -u` is the cause: `@@ -14,7 +14,9 @@` carries four numbers an LLM cannot
 * compute after its own earlier edits, and one wrong number rejects the whole
 * patch. This format deletes them and finds the location by searching.
 */

const FILE = [
  'export function greet(name) {',
  '  const greeting = "hello";',
  '  return `${greeting}, ${name}`;',
  '}',
  '',
  'export const VERSION = 1;',
].join('\n');

const wrap = (body) => `${BEGIN}\n${body}\n${END}`;

test('updates a file by searching for context, with no line numbers anywhere', () => {
  const patch = wrap([
    '*** Update File: src/greet.js',
    '@@',
    ' export function greet(name) {',
    '-  const greeting = "hello";',
    '+  const greeting = "g\'day";',
  ].join('\n'));
  const out = applyPatch({ 'src/greet.js': FILE }, patch);
  assert.equal(out.ok, true, out.error);
  assert.match(out.files['src/greet.js'], /g'day/);
  assert.doesNotMatch(out.files['src/greet.js'], /"hello"/);
  assert.deepEqual(out.changed, [{ path: 'src/greet.js', kind: 'updated' }]);
});

test('add, update and delete are all first class in one atomic patch', () => {
  const patch = wrap([
    '*** Add File: src/new.js',
    '+export const NEW = true;',
    '*** Update File: src/greet.js',
    '@@',
    '-export const VERSION = 1;',
    '+export const VERSION = 2;',
    '*** Delete File: src/old.js',
  ].join('\n'));
  const out = applyPatch({ 'src/greet.js': FILE, 'src/old.js': 'gone' }, patch);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.files['src/new.js'], 'export const NEW = true;');
  assert.match(out.files['src/greet.js'], /VERSION = 2/);
  assert.equal('src/old.js' in out.files, false);
});

/**
 * ⚠️⚠️ ALL OR NOTHING. A patch that fails on file four must not leave files one
 * to three changed. A half-applied refactor is worse than a rejected one: the
 * repo ends in a state neither the model nor the user expects, and the model's
 * next read disagrees with its own plan.
 */
test('⚠️⚠️ a patch that fails anywhere changes NOTHING', () => {
  const before = { 'a.js': 'const a = 1;', 'b.js': 'const b = 2;' };
  const patch = wrap([
    '*** Update File: a.js',
    '@@',
    '-const a = 1;',
    '+const a = 99;',
    '*** Update File: b.js',
    '@@',
    '-this line is not in the file at all',
    '+something',
  ].join('\n'));
  const out = applyPatch(before, patch);
  assert.equal(out.ok, false);
  assert.equal(before['a.js'], 'const a = 1;', 'the input map must be untouched');
  assert.match(out.error, /b\.js/, 'the refusal must name the file that failed');
});

/**
 * ⚠️⚠️ PASS FOUR IS NOT A NICETY. Models emit typographic punctuation into source
 * they were shown with ASCII — U+2019 for an apostrophe, U+2014 for a dash. An
 * exact-match-only patcher rejects a semantically perfect edit because the model
 * smart-quoted a string, and the model has no way to see why.
 */
test('⚠️⚠️ a smart-quoted context line still matches ASCII source', () => {
  const src = "const msg = 'it\\'s fine';\nconst x = 1;";
  const patch = wrap([
    '*** Update File: a.js',
    '@@',
    // the model has "helpfully" curled the quotes and used an en dash
    " const msg = ‘it\\’s fine’;",
    '-const x = 1;',
    '+const x = 2;',
  ].join('\n'));
  const out = applyPatch({ 'a.js': src }, patch);
  assert.equal(out.ok, true, out.error);
  assert.match(out.files['a.js'], /const x = 2;/);
  assert.ok(out.looseMatches.length > 0, 'a non-exact match must be reported, not hidden');
  assert.equal(out.looseMatches[0].pass, 'punctuation');
});

test('normalisePunctuation folds the characters models actually substitute', () => {
  assert.equal(normalisePunctuation('‘a’ “b” – — …'), "'a' \"b\" - - ...");
});

test('indentation drift still matches, and is reported as a looser pass', () => {
  const patch = wrap([
    '*** Update File: src/greet.js',
    '@@',
    '-      const greeting = "hello";',   // model over-indented
    '+  const greeting = "hi";',
  ].join('\n'));
  const out = applyPatch({ 'src/greet.js': FILE }, patch);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.looseMatches[0].pass, 'trim');
});

/**
 * ⚠️⚠️ AMBIGUITY IS A REFUSAL, NEVER A COIN FLIP. Two identical regions mean we
 * do not know which the model meant, and silently picking one edits the wrong
 * place — the worst outcome available to a patcher, because it looks like
 * success and is found much later.
 */
test('⚠️⚠️ ambiguous context is refused and says how to fix it', () => {
  const dup = 'foo();\nbar();\nfoo();\nbar();';
  const patch = wrap(['*** Update File: a.js', '@@', '-foo();', '+baz();'].join('\n'));
  const out = applyPatch({ 'a.js': dup }, patch);
  assert.equal(out.ok, false);
  assert.match(out.error, /more than once/);
  assert.match(out.error, /unique/, 'the refusal must name the way out');
});

test('context that is simply not there says what it looked for', () => {
  const patch = wrap(['*** Update File: src/greet.js', '@@', '-const nope = 1;', '+const yes = 1;'].join('\n'));
  const out = applyPatch({ 'src/greet.js': FILE }, patch);
  assert.equal(out.ok, false);
  assert.match(out.error, /const nope = 1;/, 'a refusal without the missing line costs a round of guessing');
});

test('a move carries the content and leaves nothing behind', () => {
  const patch = wrap([
    '*** Update File: src/greet.js',
    '*** Move to: src/hello.js',
    '@@',
    '-export const VERSION = 1;',
    '+export const VERSION = 3;',
  ].join('\n'));
  const out = applyPatch({ 'src/greet.js': FILE }, patch);
  assert.equal(out.ok, true, out.error);
  assert.equal('src/greet.js' in out.files, false);
  assert.match(out.files['src/hello.js'], /VERSION = 3/);
});

/**
 * ⚠️ EVERY REFUSAL NAMES THE LINE, because this format is written BY the model:
 * the error message is part of the interface. "Invalid patch" costs a round.
 */
test('⚠️ malformed input is refused with a line number and a reason', () => {
  assert.match(parsePatch('nonsense').error, /must start with/);
  assert.match(parsePatch(`${BEGIN}\n*** Update File: a.js`).error, /finish with/);
  assert.match(parsePatch(wrap('*** Add File: a.js\nno plus sign')).error, /line \d+.*must start with "\+"/);
  assert.match(parsePatch(wrap(' orphan line')).error, /line \d+.*before any/);
  assert.match(parsePatch(wrap('*** Update File: a.js\n@@\n?bad')).error, /line \d+.*must begin with/);
});

test('adding a file that exists, or updating one that does not, is refused clearly', () => {
  assert.match(applyPatch({ 'a.js': 'x' }, wrap('*** Add File: a.js\n+y')).error, /already exists/);
  assert.match(applyPatch({}, wrap('*** Update File: a.js\n@@\n-x\n+y')).error, /does not exist/);
  assert.match(applyPatch({}, wrap('*** Delete File: a.js')).error, /does not exist/);
});

test('locateHunk reports which pass found it, so drift is visible', () => {
  const lines = FILE.split('\n');
  const exact = locateHunk(lines, { lines: [{ op: ' ', text: '  return `${greeting}, ${name}`;' }] });
  assert.equal(exact.ok, true);
  assert.equal(exact.pass, 'exact');
});

test('bounded: an enormous patch and a too-wide patch are both refused', () => {
  assert.match(parsePatch(BEGIN + '\n' + 'x'.repeat(500_000) + '\n' + END).error, /limit/);
  const many = Array.from({ length: 41 }, (_, i) => `*** Add File: f${i}.js\n+x`).join('\n');
  assert.match(parsePatch(wrap(many)).error, /limit is 40/);
});
