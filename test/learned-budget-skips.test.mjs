/**
 * ── ⚠️⚠️ ONE OVERSIZED FACT USED TO DELETE EVERY FACT BEHIND IT ─────────────
 *
 * `learnedPromptBlock` walked the entries and `break`ed at the first one that
 * did not fit the byte budget. Everything after it was discarded — and the block
 * still rendered, still looked healthy, and was simply missing what the project
 * had learned.
 *
 * ⚠️ IT IS ATTACKER-REACHABLE, WHICH IS WHY IT IS NOT MERELY A BUDGET BUG. The
 * entries are files in the repository and `recall` sorts by NAME, so whoever
 * writes the repo controls both the sort key and the size. A single oversized
 * entry named to sort first blanked the whole learned memory on every run.
 * Found by an adversarial pass over the untrusted-content fence, not by a test.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { learnedPromptBlock, MAX_LEARNED_BYTES } from '../lib/learned.mjs';

/** An entry whose rendered line is comfortably larger than the whole budget. */
const huge = { name: 'aaa-first', fact: 'X'.repeat(MAX_LEARNED_BYTES + 500) };
const small = (n) => ({ name: `zzz-${n}`, fact: `small fact number ${n}` });

test('⭐ an oversized entry is SKIPPED, and the ones behind it survive', () => {
  // Sorted first, exactly as an attacker-chosen filename would place it.
  const block = learnedPromptBlock({ entries: [huge, small(1), small(2), small(3)] });

  assert.match(block, /small fact number 1/);
  assert.match(block, /small fact number 2/);
  assert.match(block, /small fact number 3/);
  assert.doesNotMatch(block, /XXXXXXXXXX/, 'the oversized entry itself must not be rendered');
});

test('⚠️ the omission is DISCLOSED, so a skip never becomes silent', () => {
  const block = learnedPromptBlock({ entries: [huge, small(1)] });
  assert.match(block, /1 more not shown/);
});

test('⚠️ the byte budget still holds — skipping is not a licence to overflow', () => {
  // Many entries, total far past the cap: the block must still be bounded.
  const many = Array.from({ length: 400 }, (_, i) => small(i));
  const block = learnedPromptBlock({ entries: many });
  assert.ok(
    block.length < MAX_LEARNED_BYTES * 2,
    `block was ${block.length} bytes against a ${MAX_LEARNED_BYTES} budget — skipping must not disable the cap`,
  );
  assert.match(block, /more not shown/);
});

test('⭐ the ordinary case is unchanged: everything fits, nothing is announced', () => {
  const block = learnedPromptBlock({ entries: [small(1), small(2)] });
  assert.match(block, /small fact number 1/);
  assert.match(block, /small fact number 2/);
  assert.doesNotMatch(block, /not shown/);
});

test('no entries still renders nothing at all', () => {
  assert.equal(learnedPromptBlock({ entries: [] }), '');
  assert.equal(learnedPromptBlock(null), '');
});
