/**
 * ── 🚨⭐⭐ THE HEADING COUNTED RECORDS AND THE LIST COUNTED FILES ────────────
 *
 * Seen on a real run, 2026-09-18, in the frame a user actually reads:
 *
 *     1 file written:
 *       replaced  slug.mjs       (150 bytes)
 *       created   slug.test.mjs  (737 bytes)
 *
 * `applied.length` counts mutating TOOL CALLS. The list is
 * `applied.flatMap(describeChanges)`, and `describeChanges` exists precisely
 * because **one record can name many files** — a bulk write, a delegated build.
 * Two places holding one opinion, three lines apart.
 *
 * ⚠️ THE SAME BLOCK HAS BEEN HERE TWICE BEFORE. Its own comments record "No
 * files changed" printing while `edit_file` had changed a file, and printing
 * again while `evaluate` had written 45. This is the third visit, and the fix
 * is the one that removes the class rather than the instance: the count is
 * taken from the array the list renders.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatSummary } from '../lib/turn.mjs';

/** The summary shape `formatSummary` consumes, with one mutating record. */
function summaryWith(executed) {
  return formatSummary({
    ok: true,
    model: 'm',
    roundsUsed: 1,
    rounds: [],
    executed,
    changed: [],
    note: 'done',
    stoppedBecause: 'stop',
    verification: { ran: false, passed: false },
  }).join('\n');
}

/** What the heading claims, as a number. */
function headingCount(lines) {
  const m = /^(\d+) files? (?:written|changed|WOULD be written)/m.exec(lines);
  return m ? Number(m[1]) : null;
}

/** How many file lines the list actually rendered. */
function listedFiles(lines) {
  return (lines.match(/^ {2}(?:created|replaced|deleted|edited) /gm) ?? []).length;
}

test('🚨 ONE record naming TWO files is counted as two', () => {
  /**
   * ⭐ THE EXACT SHAPE OF THE BUG. A single tool call whose result carries a
   * `written` array — what a bulk write or a delegated build produces.
   */
  const lines = summaryWith([{
    name: 'write_files',
    args: {},
    mutated: true,
    result: {
      ok: true,
      written: [
        { path: 'slug.mjs', bytes: 150, previousBytes: 120, created: false },
        { path: 'slug.test.mjs', bytes: 737, created: true },
      ],
    },
  }]);

  assert.equal(listedFiles(lines), 2, 'the list must show both files, or this test proves nothing');
  assert.equal(
    headingCount(lines),
    2,
    `the heading and the list disagree:\n${lines}`,
  );
});

test('⭐ and the ordinary one-call-one-file case is unchanged', () => {
  const lines = summaryWith([{
    name: 'write_file',
    args: { path: 'a.mjs' },
    mutated: true,
    result: { ok: true, path: 'a.mjs', bytes: 42, created: true },
  }]);
  assert.equal(listedFiles(lines), 1);
  assert.equal(headingCount(lines), 1);
  assert.match(lines, /^1 file written:/m, 'singular, and still "file" not "files"');
});

test('⚠️ a deletion inside a multi-file record makes it "changed", not "written"', () => {
  /**
   * The verb read `applied.some((w) => w.name === 'delete_file')` — a check on
   * the TOOL NAME, which cannot see a deletion made by a delegated build. That
   * is the same blindness as the count, one line down, and `describeChanges`
   * already marks those `kind: 'deleted'`.
   */
  const lines = summaryWith([{
    name: 'apply_build',
    args: {},
    mutated: true,
    result: {
      ok: true,
      written: [
        { path: 'kept.mjs', bytes: 10, created: true },
        { path: 'gone.mjs', bytes: 0, deleted: true },
      ],
    },
  }]);
  assert.equal(headingCount(lines), 2);
  assert.match(lines, /^2 files changed:/m, 'a run that removed a file did not only "write"');
});

test('⚠️ a dry run still says WOULD, and still counts files not calls', () => {
  // ⚠️ The one sentence a preview is not allowed to get wrong — this block's own
  // comment records "1 file written" printing while the disk was untouched.
  const lines = summaryWith([{
    name: 'write_files',
    args: {},
    mutated: true,
    result: {
      ok: true,
      dryRun: true,
      written: [
        { path: 'a.mjs', bytes: 1, created: true },
        { path: 'b.mjs', bytes: 2, created: true },
      ],
    },
  }]);
  assert.match(lines, /^2 files WOULD be written \(dry run — nothing was\):/m, lines);
});
