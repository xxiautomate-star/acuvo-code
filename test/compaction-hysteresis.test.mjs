/**
 * ── ⚠️⚠️ THE HYSTERESIS WAS FIXED, THEN SILENTLY UNDONE THE NEXT DAY ────────
 *
 * `COMPACT_TARGET_TOKENS` exists because compacting DOWN TO the trigger meant
 * the next round crossed it again and compacted again — "once it starts, it
 * never stops, so from that round on EVERY round is a cache miss, forever".
 * That comment is still in turn.mjs and it was still true.
 *
 * On 2026-08-13 the TRIGGER learned to count the tool offer, which is correct —
 * the offer really is sent. The TARGET was left counting messages alone. The gap
 * between them IS the hysteresis, and a gap only exists when both are measured
 * in the same units, so the real gap became `36,000 − offer` and went NEGATIVE
 * past a 36,000-token offer.
 *
 * ⭐ A bare machine offers ~9,000-13,000 tokens of schema and never notices.
 * Attaching MCP servers is what walks a user into it, and nothing anywhere would
 * have told them why their bill tripled.
 *
 * ⚠️ THIS IS A REGRESSION TEST FOR A CLASS, NOT A NUMBER. It asserts the
 * relationship (post-compaction total is under the trigger, by a margin that
 * does not shrink as the offer grows), so it keeps holding if either constant is
 * retuned — which is exactly what the previous version failed to do.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { compactionBudget } from '../lib/turn.mjs';

const TRIGGER = 96_000;

test('⭐ the gap does not shrink as the tool offer grows', () => {
  // The defect in one assertion: with a flat message budget the post-compaction
  // total was `60,000 + offer`, so the gap fell linearly and hit zero at 36,000.
  const gaps = [0, 10_000, 20_000, 35_000].map((offer) => compactionBudget(offer).gap);
  for (const g of gaps) assert.equal(g, 36_000, `every gap should be the full 36,000, got ${gaps.join(', ')}`);
});

test('⚠️⚠️ past a 36,000-token offer compaction still leaves room — it used to fire every round', () => {
  for (const offer of [36_000, 40_000, 50_000]) {
    const { messageBudget, canHelp, gap } = compactionBudget(offer);
    assert.ok(
      messageBudget + offer < TRIGGER,
      `offer ${offer}: post-compaction total ${messageBudget + offer} must be under the ${TRIGGER} trigger, or the next round compacts again`,
    );
    assert.equal(canHelp, true);
    assert.ok(gap > 0);
  }
});

test('⚠️ the message budget is FLOORED — a big offer must never ask for a negative transcript', () => {
  // 60,000 − 90,000 is −30,000, which would tell the compactor to delete the
  // whole conversation and then some.
  const { messageBudget } = compactionBudget(90_000);
  assert.ok(messageBudget > 0, 'a negative or zero budget deletes the conversation');
  assert.equal(messageBudget, 8_000);
});

test('⭐ when the OFFER ITSELF blows the budget, it says so instead of grinding', () => {
  // Rewriting messages cannot bring the request under the ceiling; it only
  // destroys the cached prefix once per round to achieve nothing. `canHelp` is
  // what turns that into a sentence the user can act on.
  const { canHelp } = compactionBudget(95_000);
  assert.equal(canHelp, false);
  // And the ordinary case must NOT trip the warning.
  assert.equal(compactionBudget(11_000).canHelp, true);
});

test('⚠️ a missing or nonsense offer is treated as zero, never as NaN', () => {
  // estimateToolOfferTokens returning undefined must not poison the budget —
  // `NaN` comparisons are all false, so the trigger would silently stop firing.
  for (const bad of [undefined, null, NaN, -5, 'lots']) {
    const { messageBudget } = compactionBudget(bad);
    assert.ok(Number.isFinite(messageBudget), `offer ${String(bad)} produced ${messageBudget}`);
    assert.equal(messageBudget, 60_000);
  }
});
