/**
 * ── WHAT THE PERSON WATCHING ACTUALLY SEES A TOOL CALL DO ───────────────────
 *
 * Three defects, all measured on real `acuvo` runs against this package, all of
 * them in one function:
 *
 *   1. `edit_file` — the verb every prompt in this repo tells the model to
 *      PREFER — fell through to the `default` arm and printed `· edit_file`.
 *      No path, no size, no diff. `diff-preview.mjs` had a 1,051-line unified
 *      diff renderer whose only production caller was the TTY approval prompt,
 *      which fails open with no TTY and in `auto` mode asks about almost
 *      nothing — so on the ordinary path nobody ever saw a changed line.
 *
 *   2. That same `default` arm serves **75 of this package's 82 verbs** and
 *      printed the verb alone: `· search_text` with no query and no match
 *      count, `· read_skill` with no skill name.
 *
 *   3. `plan_start` printed `· plan_start` — one word for the moment the model
 *      decomposes the task into named deliverables.
 *
 * ⚠️ ASSERTED ON `renderEvent`, THE REAL ENTRY POINT, not on the private helper
 * underneath it. `renderToolRecord` is not exported, and a test that reached
 * around the switch could pass while the `case` that dispatches to it was
 * missing — which is this repository's most-recorded failure shape.
 *
 * ⚠️ AND WITH COLOUR OFF. `node --test` is never a TTY so `createPainter` is
 * already identity, but the assertions strip anyway: a suite that only passes
 * when it happens not to be watched is not a suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderEvent, toolSubject, toolOutcome } from '../lib/turn.mjs';
import { stripColour } from '../lib/colour.mjs';
import { applyEdit, firstChangedLine } from '../lib/edit.mjs';
import { MARK } from '../lib/plan-ledger.mjs';

/** Every assertion below reads the rendered TEXT, never the escape codes. */
const draw = (event) => renderEvent(event).map((l) => stripColour(l));
const drawn = (event) => draw(event).join('\n');

const toolEvent = (name, args, result) => ({ type: 'tool', record: { name, args, result } });

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE EDIT SHOWS ITS FILE AND ITS CHANGED LINES
 * ══════════════════════════════════════════════════════════════════════════ */

test('edit_file names the file it changed', () => {
  const out = drawn(toolEvent(
    'edit_file',
    { path: 'src/util.mjs', old_string: 'const a = 1;', new_string: 'const a = 2;' },
    { ok: true, path: 'src/util.mjs', bytes: 120, previousBytes: 120, firstLine: 12 },
  ));
  /**
   * ⚠️ MUTATION THAT TURNS THIS RED: delete the `case 'edit_file'` arm in
   * `renderToolRecord` so the verb falls back to `default`. Proved 2026-09-02 —
   * the output becomes `· edit_file src/util.mjs` with no `✎` and no diff, and
   * both assertions below fail.
   */
  assert.match(out, /✎/, 'an edit is a WRITE and must carry the same mark every other writing verb uses');
  assert.match(out, /src\/util\.mjs/, 'the bare `· edit_file` this replaces named no file at all');
});

test('edit_file renders the actual changed lines, not just a byte count', () => {
  const out = drawn(toolEvent(
    'edit_file',
    { path: 'src/util.mjs', old_string: 'const a = 1;', new_string: 'const a = 2;' },
    { ok: true, path: 'src/util.mjs', bytes: 120, previousBytes: 120, firstLine: 12 },
  ));
  assert.match(out, /^\s*-const a = 1;$/m, 'the removed line must be shown');
  assert.match(out, /^\s*\+const a = 2;$/m, 'the added line must be shown');
});

test('the diff header carries the FILE line, not the span line', () => {
  const out = drawn(toolEvent(
    'edit_file',
    { path: 'src/util.mjs', old_string: 'const a = 1;', new_string: 'const a = 2;' },
    { ok: true, path: 'src/util.mjs', bytes: 120, previousBytes: 120, firstLine: 212 },
  ));
  /**
   * ⭐ THE POINT OF `firstLine`. Diffing `old_string` against `new_string`
   * alone can only ever produce `@@ -1 +1 @@`, which renders, looks
   * authoritative, and is false for every edit below line 1.
   *
   * ⚠️ MUTATION THAT TURNS THIS RED: drop the `offset` map in `renderEditDiff`
   * and pass `diff` through unchanged. Proved 2026-09-02 — the header comes
   * back as `@@ -1 +1 @@` and this fails while the two tests above still pass,
   * which is exactly why the header needs its own assertion.
   */
  assert.match(out, /@@ -212[ ,]/, 'the hunk must be offset to where the edit actually landed');
  assert.doesNotMatch(out, /@@ -1[ ,]/, 'a span-relative line number is a number nobody can trust');
});

test('the header points at the FIRST LINE OF THE HUNK, not at the first changed line', () => {
  /**
   * ── ⚠️⚠️ THE OFF-BY-ONE THE OTHER TESTS COULD NOT SEE ────────────────────
   *
   * Found 2026-09-02 by reading a REAL `acuvo` run against the real file, with
   * every test in this file green. Every one of them used a single-line
   * `old_string`, where "the line the span starts on" and "the line the first
   * change is on" are the same number — so `firstLine - 1` passed them all and
   * was wrong for the shape a model actually produces.
   *
   * A model quotes context. Here `old_string` begins at file line 6 with the
   * signature and changes the `return` on line 7; `firstLine` is therefore 7,
   * and the header must still say 6, because line 6 is the first line printed.
   *
   * ⚠️ MUTATION THAT TURNS THIS RED: change the offset back to
   * `result.firstLine - 1`. Proved 2026-09-02 — the header returns to
   * `@@ -7,3` and this fails while the single-line tests above stay green,
   * which is the whole reason this case is written separately.
   */
  const out = drawn(toolEvent(
    'edit_file',
    {
      path: 'src/util.mjs',
      old_string: 'export function titleCase(s) {\n  return old();\n}',
      new_string: 'export function titleCase(s) {\n  return fixed();\n}',
    },
    { ok: true, path: 'src/util.mjs', bytes: 200, previousBytes: 190, firstLine: 7 },
  ));
  assert.match(out, /@@ -6,3 \+6,3 @@/, 'the hunk opens on line 6, so the header must say 6');
  assert.match(out, /^\s+export function titleCase\(s\) \{$/m, 'and line 6 is the context line it prints first');
});

test('an unknown firstLine drops the header rather than printing a false one', () => {
  const out = drawn(toolEvent(
    'edit_file',
    { path: 'a.mjs', old_string: 'x', new_string: 'y' },
    { ok: true, path: 'a.mjs', bytes: 1, previousBytes: 1 },   // no firstLine
  ));
  assert.doesNotMatch(out, /@@/, 'with no offset the header would be a guess, so there must be none');
  assert.match(out, /^\s*\+y$/m, 'the +/- lines are true either way and must survive');
});

test('a dry-run edit never claims the file changed', () => {
  const out = drawn(toolEvent(
    'edit_file',
    { path: 'a.mjs', old_string: 'x', new_string: 'y' },
    { ok: true, path: 'a.mjs', bytes: 1, previousBytes: 1, firstLine: 1, dryRun: true },
  ));
  assert.match(out, /would edit/, 'a model or a human told "edited" will build on a change that does not exist');
  assert.doesNotMatch(out, /edited\s+a\.mjs/, 'the past tense must not appear for a write that never landed');
});

test('a failed edit still names its target and its reason', () => {
  const out = drawn(toolEvent(
    'edit_file',
    { path: 'src/util.mjs', old_string: 'nope', new_string: 'y' },
    { ok: false, error: 'old_string was not found.' },
  ));
  assert.match(out, /✖/);
  assert.match(out, /src\/util\.mjs/, 'the failure arm reads args.path and must keep doing so');
  assert.doesNotMatch(out, /@@/, 'nothing changed, so there is nothing to draw a diff of');
});

test('apply_patch is rendered from the shape apply-patch.mjs actually returns', () => {
  /**
   * ── ⚠️⚠️ THE FIRST DRAFT OF THIS ARM GUESSED, AND THE GUESS WAS DANGEROUS ─
   *
   * It read `result.applied ?? result.files`. `applied` does not exist on this
   * result, and `files` is the whole post-patch FILE MAP — so the terminal
   * would have listed the contents of the repository as if they were the files
   * the patch touched. Caught by reading `formatApplyPatch`, the model-facing
   * renderer that already owns this shape, instead of inferring it.
   *
   * ⭐ THE ASSERTION IS THE NEGATIVE ONE. That a patched path is shown is easy;
   * that an unrelated key on the same object is NOT shown is the bug.
   */
  const out = drawn(toolEvent('apply_patch', {}, {
    ok: true,
    written: [{ path: 'src/a.mjs', bytes: 400, created: false }],
    files: { 'src/a.mjs': 'contents', 'src/b.mjs': 'more', 'src/c.mjs': 'more' },
    looseMatches: [{ path: 'src/a.mjs', pass: 'whitespace' }],
  }));
  assert.match(out, /✎ patched\s+src\/a\.mjs/);
  assert.doesNotMatch(out, /src\/b\.mjs/, '`files` is the file MAP and must never be read as a list of touched paths');
  assert.match(out, /matched only after whitespace normalisation/, 'a loose match is the most important thing in a patch and only ever reached the model');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. EVERY OTHER VERB NAMES ITS SUBJECT AND ITS OUTCOME
 * ══════════════════════════════════════════════════════════════════════════ */

test('search_text shows the query and how many matches came back', () => {
  const out = drawn(toolEvent(
    'search_text',
    { pattern: 'slugify' },
    { ok: true, matches: [{}, {}, {}], truncated: false, scanned: 12 },
  ));
  /**
   * ⚠️ MUTATION THAT TURNS THIS RED: restore the old `default` arm,
   * `return ['  · ' + name]`. Proved 2026-09-02 — the line becomes a bare
   * `· search_text` and both assertions fail. That bare line is what a real
   * run of this package printed.
   */
  assert.match(out, /slugify/, 'a search that does not say what it searched for is not a trace');
  assert.match(out, /3 matches/, 'found-nothing and found-forty are the fact that decides what happens next');
});

test('read_skill names the skill it loaded', () => {
  const out = drawn(toolEvent('read_skill', { name: 'writing-tests' }, { ok: true }));
  assert.match(out, /writing-tests/);
});

test('the subject is read even when the arguments arrive as a JSON string', () => {
  /**
   * ⭐ THE SHAPE THAT ALREADY BROKE THIS ONCE. `turn.mjs` carries a comment
   * recording that reading tool arguments as an object printed a bare
   * `… run_command` with no command — "a spinner pretending to be a progress
   * line". `toolSubject` is the single copy of that parse now, so the bug
   * cannot come back in only one of the two places.
   */
  assert.equal(toolSubject('{"pattern":"slugify"}'), 'slugify');
  assert.equal(toolSubject('{not json'), null, 'a half-streamed fragment must not throw or render as garbage');
});

test('a subject that is an object renders as nothing, never as [object Object]', () => {
  /**
   * ⚠️ MUTATION THAT TURNS THIS RED: delete the `typeof raw === 'object'`
   * guard in `toolSubject`. Proved 2026-09-02 — it returns the string
   * `[object Object]`, which looks like a value and is worse than the bare
   * verb it replaced, because a reader cannot tell it from a real one.
   */
  assert.equal(toolSubject({ path: { nested: true } }), null);
  assert.equal(toolSubject({ query: 'ok' }), 'ok', 'the guard must not swallow real values');
});

test('a snippet verb shows its snippet, collapsed onto one line', () => {
  /**
   * ⚠️ FOUND BY RUNNING THE BINARY AFTER THE FIRST VERSION OF THIS SHIPPED.
   * `evaluate`'s only argument is `source`, which was not in the list, so it
   * still rendered as a bare `· evaluate` while every other verb had been
   * fixed. The tests were green; the terminal was not.
   *
   * ⚠️ MUTATION THAT TURNS THIS RED: drop `?? a.source ?? a.code` from
   * `toolSubject`. Proved 2026-09-02 — it returns null and the line goes back
   * to the bare verb.
   */
  const out = drawn(toolEvent('evaluate', { source: 'const x = 1;\nconsole.log(x);' }, { ok: true, exitCode: 0 }));
  assert.match(out, /const x = 1; console\.log\(x\);/, 'a newline in the subject would break the one-line-per-call layout');
});

test('a long subject is cut with a marker rather than silently', () => {
  const long = 'a'.repeat(200);
  const s = toolSubject({ command: long });
  assert.ok(s.length < 200, 'an unbounded subject would wrap and bury the lines under it');
  assert.match(s, /…$/, 'without the marker a cut reads as the tool having stopped mid-word');
});

test('the outcome is suppressed when it would only repeat the subject', () => {
  const out = drawn(toolEvent('read_lines', { path: 'src/app.ts' }, { ok: true, path: 'src/app.ts' }));
  const hits = stripColour(out).split('src/app.ts').length - 1;
  assert.equal(hits, 1, 'printing the same path twice on one line reads as a bug in the renderer');
});

test('a verb whose result matches no known shape still degrades to the old line', () => {
  const out = drawn(toolEvent('some_future_verb', {}, { ok: true }));
  assert.equal(out.trim(), '· some_future_verb', 'the change may only ever ADD; a new verb must not render worse');
});

test('toolOutcome counts the shapes the registry actually produces', () => {
  assert.equal(toolOutcome({ matches: [1] }), '1 match', 'singular, because "1 matches" is the tell of a generated string');
  assert.equal(toolOutcome({ files: [1, 2] }), '2 files');
  assert.equal(toolOutcome({ entries: [] }), '0 entries');
  assert.equal(toolOutcome({ path: 'a.ts', line: 9 }), 'a.ts:9');
  assert.equal(toolOutcome(null), null);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. THE PLAN IS A CHECKLIST
 * ══════════════════════════════════════════════════════════════════════════ */

test('plan_start draws every step, not one bare word', () => {
  const out = drawn(toolEvent('plan_start', { task: 't' }, {
    ok: true,
    task: 't',
    steps: [
      { id: 's1', text: 'read the module', state: 'done' },
      { id: 's2', text: 'write the test', state: 'doing' },
      { id: 's3', text: 'fix the bug', state: 'todo' },
    ],
  }));
  /**
   * ⚠️ MUTATION THAT TURNS THIS RED: delete the `case 'plan_start'` arm.
   * Proved 2026-09-02 — the whole checklist collapses to
   * `· plan_start t · 3 steps` and every text assertion below fails.
   */
  assert.match(out, /read the module/);
  assert.match(out, /write the test/);
  assert.match(out, /fix the bug/);
  assert.match(out, /3 steps/);
});

test('the checklist marks come from the ledger, not from a second copy', () => {
  const out = drawn(toolEvent('plan_start', {}, {
    ok: true,
    steps: [{ id: 's1', text: 'done one', state: 'done' }, { id: 's2', text: 'todo one', state: 'todo' }],
  }));
  /**
   * ⭐ ASSERTED THROUGH THE IMPORTED TABLE. Hard-coding `✓` here would create
   * the very second copy this exists to prevent: change `plan-ledger.mjs` and
   * the test would keep passing against a glyph the summary no longer uses.
   */
  assert.ok(out.includes(`${MARK.done} s1 `), 'a done step must carry the ledger\'s own done mark');
  assert.ok(out.includes(`${MARK.todo} s2 `), 'a todo step must carry the ledger\'s own todo mark');
});

test('plan_step reports the transition and what is left', () => {
  const out = drawn(toolEvent('plan_step', { id: 's2' }, {
    ok: true, id: 's2', from: 'todo', state: 'done', outstanding: [{ id: 's3' }],
  }));
  assert.match(out, /s2/);
  assert.match(out, /todo → done/, 'the transition is the fact; a bare state cannot be told from a no-op');
  assert.match(out, /1 step left/);
});

test('a long plan is capped and says that it was', () => {
  const steps = Array.from({ length: 20 }, (_, i) => ({ id: `s${i + 1}`, text: `step ${i + 1}`, state: 'todo' }));
  const out = drawn(toolEvent('plan_start', {}, { ok: true, steps }));
  assert.match(out, /and 8 more steps/, 'a 20-line checklist on every mark would bury the work under it');
  assert.doesNotMatch(out, /step 20/, 'the cap must actually cap');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. THE LINE NUMBER THE DIFF DEPENDS ON
 * ══════════════════════════════════════════════════════════════════════════ */

test('firstChangedLine finds the line an edit landed on', () => {
  const before = 'one\ntwo\nthree\nfour\n';
  const after = 'one\ntwo\nTHREE\nfour\n';
  assert.equal(firstChangedLine(before, after), 3);
  assert.equal(firstChangedLine('a', 'b'), 1, 'the first line is line 1, never line 0');
  assert.equal(firstChangedLine('same', 'same'), 1, 'identical input has nothing to point at and must not return 0');
});

test('firstChangedLine is derived from the two contents, not from indexOf', () => {
  /**
   * ⭐ THE CRLF CASE, WHICH IS WHY IT IS NOT `indexOf(oldString)`. `applyEdit`
   * has a tolerant path that matches across line-ending styles, so the span it
   * replaced is NOT present in the original bytes — a search for `old_string`
   * returns -1 there and would report line 1 for every CRLF file on the planet.
   *
   * ⚠️ MUTATION THAT TURNS THIS RED: reimplement `firstChangedLine` as
   * `before.slice(0, before.indexOf(oldString)).split('\n').length`. Proved
   * 2026-09-02 — it returns 1 instead of 3 for the CRLF file below.
   */
  const before = 'one\r\ntwo\r\nthree\r\nfour\r\n';
  const applied = applyEdit(before, 'three\n', 'THREE\n');
  assert.equal(applied.ok, true, 'the tolerant path is the whole premise of this test');
  assert.equal(firstChangedLine(before, applied.content), 3);
});

test('an edit at the very end of a file is not reported as line 1', () => {
  const before = 'a\nb\nc\nd\ne\n';
  const after = 'a\nb\nc\nd\nE\n';
  assert.equal(firstChangedLine(before, after), 5);
});
