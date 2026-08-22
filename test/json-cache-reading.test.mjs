/**
 * ── ⭐ THE CACHE READING HAS TO LEAVE THE PROCESS ────────────────────────────
 *
 * `aggregateCache` in turn.mjs computes a hit rate on every session and
 * `toJson` dropped it, so the number that decides the bill was unreadable from
 * outside. Measured 2026-08-14 on a real 4-round run: `--json` emitted
 * `costUsd` and `tokens` and nothing whatsoever about caching, which made every
 * caching claim in this repository — including the ones written in its own
 * comments — unverifiable by the people we ask to believe them.
 *
 * ⚠️ THE HARD PART IS NOT PRESENCE, IT IS THE THREE-WAY DISTINCTION. "cached
 * nothing" (`hitRate: 0`), "said nothing" (`cache: null`) and "said something
 * about only some rounds" (`roundsUnknown > 0`) are three different facts, and
 * a shape that collapses any two of them reports a provider's silence as a
 * measurement. Each gets a test below, because the collapse is the failure that
 * would ship silently.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { toJson } from '../lib/report.mjs';

/** The smallest outcome `toJson` accepts, so each test varies only `usage`. */
const outcomeWith = (usage) => ({ ok: true, stage: 'done', usage, executed: [], rounds: [] });

test('⭐ the hit rate reaches the JSON document', () => {
  const doc = toJson(outcomeWith({
    cost: 0.0035,
    total_tokens: 42_642,
    cache: {
      promptTokens: 40_000,
      cachedTokens: 30_000,
      uncachedTokens: 10_000,
      hitRate: 0.75,
      roundsReported: 4,
      roundsUnknown: 0,
    },
  }));

  assert.ok(doc.cache, 'the cache reading must not be dropped');
  assert.equal(doc.cache.hitRate, 0.75);
  assert.equal(doc.cache.promptTokens, 40_000);
  assert.equal(doc.cache.cachedTokens, 30_000);
  assert.equal(doc.cache.roundsReported, 4);
});

test('⚠️ a provider that said NOTHING about caching reports null, not a zeroed object', () => {
  // `aggregateCache` returns null when no round reported — that null has to
  // survive, because a zeroed object reads as a measurement of zero caching.
  const doc = toJson(outcomeWith({ cost: 0.0035, total_tokens: 42_642, cache: null }));
  assert.equal(doc.cache, null);

  // And the same when the key was never there at all.
  assert.equal(toJson(outcomeWith({ cost: 0.0035 })).cache, null);
  assert.equal(toJson(outcomeWith(null)).cache, null);
});

test('⚠️⚠️ a genuine 0% hit rate is NOT silently turned into "no reading"', () => {
  /**
   * The trap this pins: `outcome.usage.cache ? … : null` is truthy-tested, so a
   * future refactor that returns a hit rate of `0` at the TOP level — or that
   * reaches for `usage.cache.hitRate ?? null` and short-circuits on the falsy
   * zero — would report a cold cache as an absent one. Cold is the finding.
   */
  const doc = toJson(outcomeWith({
    cost: 0.0035,
    cache: { promptTokens: 40_000, cachedTokens: 0, uncachedTokens: 40_000, hitRate: 0, roundsReported: 4, roundsUnknown: 0 },
  }));

  assert.ok(doc.cache, 'a measured 0% must still be a reading');
  assert.equal(doc.cache.hitRate, 0);
  assert.equal(doc.cache.cachedTokens, 0);
});

/**
 * ── ⭐⭐ THE SESSION RATE IS NOT THE FLOOR, AND ONLY THE FLOOR IS PRICED ──────
 *
 * `lib/plan.mjs` says the cache rate IS the margin and sizes the ladder on a 90%
 * floor. The floor is a claim about ROUND 1 of a fresh invocation — the part
 * prefix discipline actually buys. Rounds 2+ append tool results the provider
 * has by definition never seen, so their miss is arithmetic.
 *
 * ⚠️⚠️ MEASURED 2026-08-16, two live runs in one workspace: 72.0% over 4 rounds
 * and 49.2% over 2. Both are dominated by the round count and neither answers
 * "did this invocation inherit the last one's prefix?". A session whose round 1
 * hit 0% and whose rounds 2–4 hit 97% reports ~72% and looks healthy — which is
 * the exact shape of the repo-map defect fixed the same day, where creating one
 * file left 13 of 19,950 map bytes cacheable and no run said so.
 */
test('⭐⭐ the FLOOR — round 1 — travels separately from the session rate', () => {
  const doc = toJson(outcomeWith({
    cost: 0.0035,
    cache: {
      promptTokens: 41_585,
      cachedTokens: 29_952,
      uncachedTokens: 11_633,
      hitRate: 0.72,
      // Round 1 was stone cold while the session reads 72%.
      firstRound: { promptTokens: 7_300, cachedTokens: 0, hitRate: 0 },
      roundsReported: 4,
      roundsUnknown: 0,
    },
  }));

  assert.ok(doc.cache.firstRound, 'the floor was dropped — the session rate cannot show it');
  assert.equal(doc.cache.firstRound.hitRate, 0);
  assert.equal(doc.cache.firstRound.promptTokens, 7_300);
  // ⚠️ AND IT MUST NOT BE CONFLATED WITH THE SESSION RATE. Reporting the same
  // number twice would be worse than omitting it: it would look like evidence.
  assert.notEqual(doc.cache.firstRound.hitRate, doc.cache.hitRate);
});

test('⚠️ round 1 reporting nothing is null, never a zeroed floor', () => {
  /**
   * ⚠️ THE TEMPTING WRONG FIX IS "USE THE FIRST ROUND THAT REPORTED". If round 1
   * was silent, round 2 is warm FROM round 1, so promoting it publishes a number
   * that is not the floor at all — a wrong answer that looks right. Absence has
   * to stay absence, which is the rule `roundsUnknown` already follows.
   */
  const doc = toJson(outcomeWith({
    cost: 0.0035,
    cache: { promptTokens: 10_000, cachedTokens: 9_000, uncachedTokens: 1_000, hitRate: 0.9, firstRound: null, roundsReported: 1, roundsUnknown: 1 },
  }));
  assert.equal(doc.cache.firstRound, null);

  // And a cache block written before this field existed must not throw or
  // invent one — old audit logs are still read.
  const old = toJson(outcomeWith({
    cost: 0.0035,
    cache: { promptTokens: 10_000, cachedTokens: 9_000, uncachedTokens: 1_000, hitRate: 0.9, roundsReported: 2, roundsUnknown: 0 },
  }));
  assert.equal(old.cache.firstRound, null);
  assert.equal(old.cache.hitRate, 0.9);
});

test('⚠️ a PARTIAL reading discloses how many rounds it could not see', () => {
  // A rate over 2 of 6 rounds is not a rate over the session, and a consumer
  // that cannot see the gap will quote it as though it were.
  const doc = toJson(outcomeWith({
    cost: 0.0035,
    cache: { promptTokens: 20_000, cachedTokens: 19_000, uncachedTokens: 1_000, hitRate: 0.95, roundsReported: 2, roundsUnknown: 4 },
  }));

  assert.equal(doc.cache.roundsUnknown, 4);
  assert.equal(doc.cache.roundsReported, 2);
});
