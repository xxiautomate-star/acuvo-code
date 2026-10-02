/**
 * ── ⭐⭐⭐ ROMAN'S FIRST MVP POINT WAS UNMEASURABLE ──────────────────────────
 *
 * `CLAUDE.md` §3, his six-point definition of CLI-done-as-MVP, opens with
 * *"caching solid **even when models switch**"* — and it is flagged as the hard
 * one that is still open.
 *
 * ⚠️⚠️ MEASURED 2026-08-29 ACROSS ALL 139 ARCHIVED BENCH RUNS: **not one carries
 * a cache figure.** The `budget` block records ten fields — `spentUsd`,
 * `totalTokens`, `rounds`, `limitUsd`, `projectedUsd`, `remainingUsd`,
 * `reserveUsd`, `elapsedMs`, `estimated`, `estimatedRounds` — and nothing about
 * caching. So the point could not be evaluated from 139 runs, and every claim
 * about our cache rate has come from a hand-run probe.
 *
 * ⭐ AND THE NUMBER WAS ALREADY IN OUR HANDS. `priceFromSplit` has read
 * `cached_tokens` on every round since it was written: it computes cached and
 * fresh, prices them at different rates, and returns a dollar figure — dropping
 * the two quantities the whole margin story rests on.
 *
 * So this is plumbing, not arithmetic: one reader (`splitFromUsage`), one
 * accumulation point (`record`, which is already the one place that means "a
 * round happened"), and the number on the line a human reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBudget, splitFromUsage, priceFromSplit } from '../lib/budget.mjs';

/** A round as a real OpenAI-compatible provider reports it. */
const round = (prompt, cached, completion = 400) => ({
  total_tokens: prompt + completion,
  prompt_tokens: prompt,
  completion_tokens: completion,
  prompt_tokens_details: { cached_tokens: cached },
});

test('⭐ the split is read, and BOTH vocabularies are accepted', () => {
  /**
   * The file's own warning: "a reader that knows one spelling silently prices
   * the other at zero cache — the same ~8x error wearing a different hat."
   */
  assert.deepEqual(splitFromUsage(round(1000, 900)), { prompt: 1000, cached: 900, fresh: 100, completion: 400 });
  assert.deepEqual(
    splitFromUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60 }),
    { prompt: 100, cached: 60, fresh: 40, completion: 5 },
  );
  assert.deepEqual(
    splitFromUsage({ promptTokens: 100, completionTokens: 5, cachedTokens: 60 }),
    { prompt: 100, cached: 60, fresh: 40, completion: 5 },
  );
});

test('⚠️ a provider over-reporting cache is CLAMPED, not believed', () => {
  // Otherwise the fresh term goes negative (under-billing) and the rate exceeds
  // 100% — a bad payload must not become a good-looking number.
  const s = splitFromUsage({ prompt_tokens: 100, completion_tokens: 5, cached_tokens: 999 });
  assert.equal(s.cached, 100);
  assert.equal(s.fresh, 0);
});

test('⚠️ unreadable usage is NULL, and null is not zero', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { prompt_tokens: 10 }, { completion_tokens: 10 }]) {
    assert.equal(splitFromUsage(bad), null, `${JSON.stringify(bad)} should be unreadable`);
  }
});

test('⭐⭐ the price still comes from the same split — one reader, not two', () => {
  /**
   * ⚠️ THIS IS THE POINT OF EXTRACTING IT. Two readers of the same payload is
   * how the reported cache rate and the price come to disagree without either
   * looking wrong, and this file already records that exact class of bug.
   */
  const usage = round(10_000, 9_800);
  const s = splitFromUsage(usage);
  const priced = priceFromSplit(usage);
  assert.ok(priced > 0);
  // Re-derive the price from the split alone; it must agree exactly.
  const again = priceFromSplit({
    prompt_tokens: s.prompt, completion_tokens: s.completion, cached_tokens: s.cached,
  });
  assert.equal(priced, again);
});

test('⭐⭐⭐ a run now reports its cache rate', () => {
  const b = createBudget({ limitUsd: 1 });
  b.record(round(10_000, 9_800));   // warm
  b.record(round(10_000, 0));       // cold — a model switch looks exactly like this
  const s = b.stats();
  assert.equal(s.cachedInTokens, 9_800);
  assert.equal(s.freshInTokens, 10_200);
  assert.equal(s.outTokens, 800);
  assert.ok(Math.abs(s.cacheRate - 0.49) < 1e-9, `expected 49%, got ${s.cacheRate}`);
  assert.match(b.report(), /cache 49\.0%/);
});

test('⚠️⚠️ AN UNMEASURED ROUND IS NOT A CACHE MISS', () => {
  /**
   * The distinction the whole ledger exists for. Folding an unreadable round in
   * as 0% would understate every rate and make a REPORTING gap look like a
   * CACHING failure — and this repo has already mistaken one for the other:
   * a stale bundle made a fixed defect look live for a full investigation.
   */
  const b = createBudget({ limitUsd: 1 });
  b.record(round(1000, 900));
  b.record(null);
  const s = b.stats();
  assert.ok(Math.abs(s.cacheRate - 0.9) < 1e-9, 'the unmeasured round dragged the rate down');
  assert.equal(s.cacheKnownRounds, 1);
  assert.equal(s.cacheUnknownRounds, 1);
  // ⭐ And it SAYS so, because "90%" of a two-round run would be a lie.
  assert.match(b.report(), /1 unmeasured/);
});

test('⚠️ the ledger adds up — known + unknown === rounds, on every path', () => {
  /**
   * A round with no usage at all takes a THIRD branch in `record` and was
   * initially counted in neither, so `known + unknown < rounds` and nobody could
   * tell whether the gap was un-cached or un-measured.
   */
  const b = createBudget({ limitUsd: 1 });
  b.record(round(1000, 900));                       // split readable
  b.record({ total_tokens: 500 });                  // tokens but no split
  b.record(null);                                   // nothing at all
  b.record({ costUsd: 0.01 });                      // a reported cost, no usage
  const s = b.stats();
  assert.equal(s.cacheKnownRounds + s.cacheUnknownRounds, s.rounds, 'the ledger does not balance');
  assert.equal(s.rounds, 4);
});

test('⭐ a run that measured NOTHING says nothing, rather than 0%', () => {
  const b = createBudget({ limitUsd: 1 });
  b.record(null);
  const s = b.stats();
  assert.equal(s.cacheRate, null, '0% would claim we cached nothing; null says we do not know');
  assert.doesNotMatch(b.report(), /cache /);
});

test('⚠️ toJSON does not grow a field for a run that measured nothing', () => {
  /**
   * The rule the GPU and `resumedUsd` keys already follow, stated at their own
   * call site: a consumer's schema must not move because a capability it never
   * used exists.
   */
  const cold = createBudget({ limitUsd: 1 });
  cold.record(null);
  // ⚠️ `toJSON`, NOT `canContinue` — the first version of this test asserted on
  // the VERDICT, which is a different object, and failed for the right reason.
  // `toJSON` is what the bench serialises into `acuvo-result.json`.
  const v = cold.toJSON();
  assert.equal('cachedInTokens' in v, false);
  assert.equal('cacheRate' in v, false);

  const warm = createBudget({ limitUsd: 1 });
  warm.record(round(1000, 900));
  const w = warm.toJSON();
  assert.equal(w.cachedInTokens, 900);
  assert.ok(Math.abs(w.cacheRate - 0.9) < 1e-9);
  // `cacheUnknownRounds` is itself absent when there are none — same rule again.
  assert.equal('cacheUnknownRounds' in w, false);
});

test('⚠️⚠️ THE BENCH WILL CARRY IT — the field reaches the result document', () => {
  /**
   * ⭐ THE REACH TEST, and the reason this file exists at all. The arithmetic
   * being right proves nothing if the number stops before the artefact somebody
   * reads: that is precisely how 139 runs came to carry no cache figure while
   * every one of them computed it.
   */
  const src = readFileSync(new URL('../lib/budget.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The accumulation sits inside `record`, not at a call site.
  assert.match(code, /cachedInTokens \+= split\.cached/);
  assert.match(code, /const split = splitFromUsage\(e\)/);
  // And it is projected into the verdict `--json` serialises.
  assert.match(code, /\.\.\.\(s\.cacheKnownRounds > 0 \? \{/);
});
