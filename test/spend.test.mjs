/**
 * ── ⭐⭐ `acuvo spend` — READING BACK WHAT WE ALREADY WROTE DOWN ─────────────
 *
 * Every run appends `costUsd` to `.acuvo/audit/<date>.jsonl`. `parseAuditLog`
 * was written, exported and tested, with ZERO runtime callers — so the tool
 * recorded the answer every time and nobody could ask for it. For a product
 * whose pitch is "it tells you the price before it runs", being unable to answer
 * "what have I spent" afterwards is the pitch with its last sentence removed.
 *
 * ⚠️⚠️ THE RULE THESE TESTS EXIST FOR: `costUsd` IS NULL ON REAL RECORDS. A run
 * that died on a 401 never billed and does not know what it cost. Summing null
 * as zero produces a total that is confidently TOO LOW, in the one report a user
 * opens precisely because they do not trust their memory. Unknown is counted and
 * shown separately, never folded in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summariseSpend, parseSince, formatSpend } from '../lib/spend.mjs';

const line = (o) => `${JSON.stringify(o)}\n`;
const rec = (at, costUsd, extra = {}) => line({
  v: 1, id: `${at}-x`, at, taskSha256: 'abc',
  run: { ok: true, task: 't', model: { requested: 'm', answered: 'm', chain: [] }, rounds: 1, costUsd, ...extra },
});

test('⭐⭐ a null cost is UNKNOWN, never zero — the whole point of this report', () => {
  const files = [{
    name: '2026-08-13.jsonl',
    text: rec('2026-08-13T01:00:00.000Z', 0.001)
        + rec('2026-08-13T02:00:00.000Z', null)
        + rec('2026-08-13T03:00:00.000Z', 0.002),
  }];
  const s = summariseSpend(files);

  assert.ok(Math.abs(s.totalUsd - 0.003) < 1e-9, `total was ${s.totalUsd}`);
  assert.equal(s.counted, 2, 'only the runs that know their cost are counted');
  assert.equal(s.unknown, 1, 'and the one that does not is reported, not absorbed');
  assert.equal(s.runs, 3, 'while the run count still includes it — it did happen');
});

test('⭐ a genuine $0.00 is a KNOWN zero and must stay counted', () => {
  /**
   * ⚠️ `if (run.costUsd)` would treat 0 as falsy and reclassify a real, free run
   * as unknown — making the "we don't know" number look worse than it is and
   * undermining the honesty this report is for. The check is on the TYPE.
   */
  const s = summariseSpend([{ name: 'a.jsonl', text: rec('2026-08-13T01:00:00.000Z', 0) }]);
  assert.equal(s.counted, 1);
  assert.equal(s.unknown, 0);
  assert.equal(s.totalUsd, 0);
});

test('⚠️ the unknown count is impossible to miss in the human report', () => {
  const s = summariseSpend([{ name: 'a.jsonl', text: rec('2026-08-13T01:00:00.000Z', null) + rec('2026-08-13T02:00:00.000Z', 0.5) }]);
  const text = formatSpend(s).join('\n');
  assert.match(text, /did not record a cost/, 'it needs its own line');
  assert.match(text, /not zero/, 'and it must say so explicitly, because that is the mistake being prevented');
});

test('a damaged line is skipped and REPORTED, never silently dropped', () => {
  const files = [{ name: 'a.jsonl', text: `${rec('2026-08-13T01:00:00.000Z', 0.001)}{not json\n` }];
  const s = summariseSpend(files);
  assert.equal(s.counted, 1);
  assert.equal(s.damaged, 1, 'a torn tail is evidence about the log, and hiding it hides that');
  assert.match(formatSpend(s).join('\n'), /damaged/);
});

test('--since filters by record time, and understands both shapes', () => {
  const now = new Date('2026-08-13T12:00:00.000Z');
  const files = [{
    name: 'a.jsonl',
    text: rec('2026-08-01T01:00:00.000Z', 1) + rec('2026-08-13T01:00:00.000Z', 2),
  }];

  const week = parseSince('7d', now);
  assert.ok(week instanceof Date);
  assert.equal(summariseSpend(files, { since: week }).totalUsd, 2, 'the older run is outside the window');

  const iso = parseSince('2026-08-01', now);
  assert.equal(summariseSpend(files, { since: iso }).totalUsd, 3, 'an explicit date includes it');

  assert.equal(parseSince('all', now), null, '"all" means no filter');
  assert.equal(parseSince('', now), null);
});

test('⚠️ a period we cannot parse is an ERROR, not a silent "everything"', () => {
  /**
   * Defaulting a typo to "all time" would answer a different question than the
   * one asked and look identical to having answered it — the silent-success
   * failure this package refuses everywhere else.
   */
  const bad = parseSince('lastweek');
  assert.ok(bad && bad.error, 'a nonsense period must say so');
  assert.match(bad.error, /7d/, 'and show a form that works');
  assert.ok(parseSince('0d')?.error, 'zero is not a period either');
});

test('the report says how far back the log actually reaches', () => {
  /**
   * `audit.mjs` prunes whole day-files, so "all time" is really "as far back as
   * the log still goes". A total that silently starts mid-history is the same
   * class of lie as counting null as zero.
   */
  const s = summariseSpend([{ name: 'a.jsonl', text: rec('2026-08-11T01:00:00.000Z', 0.001) + rec('2026-08-13T01:00:00.000Z', 0.002) }]);
  assert.equal(s.earliest.slice(0, 10), '2026-08-11');
  assert.match(formatSpend(s).join('\n'), /reaches back to 2026-08-11/);
  assert.match(formatSpend(s).join('\n'), /pruned/, 'and warns that older days may be gone');
});

test('⚠️ when NOTHING recorded a cost, it does not lead with a total of zero', () => {
  /**
   * Observed on this repo's own log: the headline read "0.000c across 0 runs"
   * beside "1 run did not record a cost". Both true, and together they read as
   * "nothing happened" — the precise impression this report exists to prevent.
   * A summary whose first line understates is not saved by an accurate second.
   */
  const s = summariseSpend([{ name: 'a.jsonl', text: rec('2026-08-13T01:00:00.000Z', null) }]);
  const first = formatSpend(s)[0];
  assert.doesNotMatch(first, /across 0 runs/, 'the headline must not imply nothing ran');
  assert.match(first, /none of which reported a cost/);
});

test('an empty or missing log is a plain answer, not an error', () => {
  const s = summariseSpend([]);
  assert.equal(s.runs, 0);
  const text = formatSpend(s).join('\n');
  assert.match(text, /No runs recorded/);
  assert.match(text, /--no-audit/, 'and names the flag that would explain an empty log');
});
