/**
 * ── ⚠️⚠️ THE HONESTY WAS COMPUTED, THEN THROWN AWAY ONE LAYER UP ────────────
 *
 * `lib/search.mjs` already does the hard half. It caps the walk at
 * `MAX_FILES_SCANNED` (4,000), notices, and reports it — `scanCapped`,
 * `totalExact`. `test/search-completeness-honesty.test.mjs` pins that.
 *
 * **`toolResultText` in lib/turn.mjs read neither field.** The miss branch was:
 *
 *     if (matches.length === 0) return `no matches for ${pattern} (scanned ${n} files)`;
 *
 * So on this repository's own console tree — 9,518 files — the model was handed
 * *"no matches for X (scanned 4000 files)"*. That sentence has exactly one
 * reading: **it is not there.** The agent then writes the file itself, or
 * "fixes" a caller it invented, because it was told the thing does not exist.
 *
 * ⭐ THE FIX IS A SENTENCE, NOT A BIGGER SCAN. Raising the cap makes every
 * search slower in order to be wrong less often. Saying *"I stopped looking"*
 * costs nothing and turns a wrong answer into a next step — narrow the path.
 *
 * ⭐ AND IT MATTERS ON HITS TOO. "12 matches in 4000 files" reads as the
 * complete set. A model that believes it has seen every caller will rename one
 * it never saw. Truncation is disclosed on both branches or neither.
 *
 * ⚠️ This is the same defect class as the search layer's own — a flag whose
 * whole value is that it CHANGES BEHAVIOUR, dropped in transit. Getting it
 * wrong does not degrade the answer; it ends the search.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { toolResultText } from '../lib/turn.mjs';
import { MAX_FILES_SCANNED } from '../lib/search.mjs';

/** What `searchText` returns when the walk ran out of budget before matching. */
const cappedMiss = {
  name: 'search_text',
  result: {
    ok: true,
    pattern: 'recordBuilderUsage',
    matches: [],
    scanned: MAX_FILES_SCANNED,
    scanCapped: true,
    totalExact: false,
    total: 0,
  },
};

/** The same search on a small tree, where "no matches" really does mean absent. */
const honestMiss = {
  name: 'search_text',
  result: {
    ok: true,
    pattern: 'recordBuilderUsage',
    matches: [],
    scanned: 214,
    scanCapped: false,
    totalExact: true,
    total: 0,
  },
};

test('⚠️⚠️ a capped walk is NOT reported to the model as "no matches"', () => {
  const text = toolResultText(cappedMiss);

  /**
   * The precise failure: the model must not be able to read this as absence.
   * Asserting on the warning alone would pass against a reply that ALSO still
   * said the flat "no matches" and nothing else, so pin the disambiguation.
   */
  assert.match(text, /cut short|stopped/i, 'the reply never says the walk was truncated');
  assert.match(
    text,
    /not.{0,40}exist|part I looked at/i,
    'the reply does not tell the model that "no matches" here is not absence',
  );
  assert.match(text, /narrower|`path`|`glob`/i, 'the reply gives the model no way forward');
});

test('⭐ and an HONEST miss stays short — the warning is not boilerplate', () => {
  /**
   * A warning printed on every miss is noise, and noise is ignored. On a tree
   * the walk actually finished, "no matches" is the truth and must read that
   * way. This is the find-nothing half: it fails if the fix warns unconditionally.
   */
  const text = toolResultText(honestMiss);
  assert.match(text, /no matches for recordBuilderUsage/);
  assert.doesNotMatch(text, /cut short|narrower/i, 'a completed walk is being reported as truncated');
  assert.ok(text.length < 90, `an honest miss grew to ${text.length} chars: ${text}`);
});

test('⚠️ truncation is disclosed on HITS as well, or the set looks complete', () => {
  const text = toolResultText({
    name: 'search_text',
    result: {
      ok: true,
      pattern: 'toolResultText',
      matches: [{ path: 'lib/turn.mjs', line: 912, text: 'export function toolResultText(record) {' }],
      scanned: MAX_FILES_SCANNED,
      scanCapped: true,
      totalExact: false,
      total: 1,
      countCapped: false,
      nextOffset: null,
    },
  });

  assert.match(text, /lib\/turn\.mjs:912/, 'the match itself was lost');
  assert.match(
    text,
    /not every match|bigger|stopped there/i,
    'a partial result is presented as the complete set',
  );
});

test('⭐ an uncapped hit is not decorated with a caveat it has not earned', () => {
  const text = toolResultText({
    name: 'search_text',
    result: {
      ok: true,
      pattern: 'toolResultText',
      matches: [{ path: 'lib/turn.mjs', line: 912, text: 'export function toolResultText(record) {' }],
      scanned: 214,
      scanCapped: false,
      totalExact: true,
      total: 1,
      countCapped: false,
      nextOffset: null,
    },
  });
  assert.doesNotMatch(text, /stopped there|not every match/i);
});

/**
 * ── ⚠️ `find_files` HAD NO CASE AT ALL, SO IT FELL TO JSON.stringify ────────
 *
 * `findFiles` reports `scanCapped` correctly — the search layer was fixed. But
 * `toolResultText` had no `find_files` branch, so the whole object was
 * serialised at the model. Two consequences, both measured on real trees:
 *
 * 1. **Cost.** 21% and 40% of the reply was quoting and field names.
 * 2. ⚠️ **Clamped JSON is UNPARSEABLE JSON.** `clampOutput` splices in
 *    `… N characters omitted …` between a head and a tail. On prose that reads
 *    fine. On a serialised object it produces something that is no longer JSON
 *    at all — measured: `JSON.parse` fails on the 8,030-char reply an ordinary
 *    monorepo tree produces. The model is then reading a broken object and
 *    guessing at its fields.
 *
 * ⚠️⚠️ CORRECTION, recorded because the wrong reason nearly got pinned here.
 * A first pass justified this as "the honesty is POSITIONAL — `scanCapped` is
 * second-to-last, so the clamp eats it first". **That is false.** `clampOutput`
 * keeps 35% head and 65% TAIL (lib/command.mjs:2239), so trailing fields
 * survive, and the omission is announced rather than silent. Leading with a
 * head line is still right — it reads better and cannot be split — but not for
 * that reason, and a guard that pins a false rationale teaches the next reader
 * something untrue about the clamp.
 */

const cappedFind = (over) => ({
  name: 'find_files',
  result: {
    ok: true,
    pattern: '**/*.mjs',
    files: ['lib/turn.mjs', 'lib/search.mjs'],
    total: 368,
    truncated: true,
    totalExact: false,
    scanned: MAX_FILES_SCANNED,
    scanCapped: true,
    skipped: [{ path: '.github', reason: 'hidden' }],
    skippedCount: 80,
    nextOffset: 60,
    ...over,
  },
});

test('⚠️⚠️ find_files discloses a capped walk BEFORE the file list, not after it', () => {
  const text = toolResultText(cappedFind());
  const head = text.split('\n')[0];

  // Leading, so it is read before the list it qualifies and cannot be split
  // across the clamp's head/tail splice.
  assert.match(head, /stopped there|not every file/i, `the warning is not in the head line: ${head}`);
  assert.ok(
    text.indexOf('lib/turn.mjs') > text.indexOf('stopped there'),
    'the file list is presented before the caveat that qualifies it',
  );
});

test('⭐ it still carries what the walk REFUSED — that is the unfindable class', () => {
  /**
   * `.github`, `.vscode` and `.husky` are ordinary source that the walk skips.
   * A model that is not told they were skipped cannot answer "fix the CI
   * workflow" and has no way to discover why.
   */
  const text = toolResultText(cappedFind());
  assert.match(text, /80 hidden or unreadable/);
  assert.match(text, /\.github/, 'the skipped examples were dropped');
});

test('⭐ and a complete walk earns no caveat', () => {
  const text = toolResultText(cappedFind({ scanCapped: false, scanned: 214, truncated: false, total: 2, nextOffset: null }));
  assert.doesNotMatch(text, /stopped there|not every file/i);
  assert.match(text, /2 files matching/);
  assert.doesNotMatch(text, /\(more files/, 'a complete list is offering a next page it does not have');
});

test('⚠️ an empty find on a capped walk is not reported as "no such file"', () => {
  const text = toolResultText(cappedFind({ files: [], total: 0, nextOffset: null }));
  assert.match(text, /cut short/i);
  assert.match(text, /NOT that no such file exists/);
});

test('⭐ the reply is smaller than the JSON it replaced', () => {
  // The whole point of a formatter: the model pays for paths, not for quoting.
  const rec = cappedFind();
  assert.ok(
    toolResultText(rec).length < JSON.stringify(rec.result).length,
    'the formatter is not cheaper than JSON.stringify, so it is only churn',
  );
});

test('⭐ an honest empty find stays short — the find_files warning is not boilerplate either', () => {
  /**
   * The missing half of the pair. Without this, a fix that warns on EVERY empty
   * find passes every other test in this file — and a warning printed always is
   * a warning read never.
   */
  const text = toolResultText(cappedFind({
    files: [], total: 0, nextOffset: null, scanCapped: false, scanned: 214, skippedCount: 0, skipped: [],
  }));
  assert.match(text, /no files match \*\*\/\*\.mjs/);
  assert.doesNotMatch(text, /cut short|Narrow the pattern/i, 'a completed walk is being reported as truncated');
  assert.ok(text.length < 90, `an honest empty find grew to ${text.length} chars: ${text}`);
});
