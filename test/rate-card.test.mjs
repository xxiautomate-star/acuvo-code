import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  FLASH, FLASH_0731, PRO, RATE_CARD, ratesFor, blendedPerMillion,
  BILLED_OBSERVED_FLASH, OUTPUT_TOKEN_SHARE, PEAK_SHARE_OF_WEEK, PEAK_SCHEDULE,
} from '../lib/rate-card.mjs';
import { RATE_USD_PER_MILLION, DEFAULT_USD_PER_MILLION_TOKENS, priceFromSplit } from '../lib/budget.mjs';
import { MODEL_PRICES, OUTPUT_TOKEN_SHARE as PLAN_OUTPUT_SHARE, costPerMillion } from '../lib/plan.mjs';

/**
 * ── ⭐⭐⭐ THE TEST THAT EXISTS BECAUSE EIGHT COPIES OF ONE NUMBER WERE WRONG ─
 *
 * DeepSeek restructured on **2026-08-16**. Nine days later, `ECONOMICS.md` found
 * that **not one price constant in this repo had moved**: `RATE_USD_PER_MILLION`
 * 3.1x/4.7x low, `MODEL_PRICES[flash]` 6.5x/9.6x low, and the console's
 * `FLASH_COST_MICROS_PER_MILLION` 6.6x low behind a comment reading "measured
 * 2026-08-15" — one day before the change.
 *
 * ⭐ THEY WERE NOT EIGHT MISTAKES. They were one mistake copied eight times, and
 * a copy has no way to know it is stale. `lib/rate-card.mjs` is now the single
 * source inside this package; this file is the thing that makes "single" true
 * rather than aspirational, and it costs $0.00 to run.
 */

const flashPeak = ratesFor(FLASH);
const flashOff = ratesFor(FLASH, 'offPeak');

test('⭐⭐⭐ budget.mjs prices from the card and nowhere else', () => {
  assert.deepStrictEqual(
    { input: RATE_USD_PER_MILLION.input, output: RATE_USD_PER_MILLION.output, cachedInput: RATE_USD_PER_MILLION.cachedInput },
    { input: flashPeak.inPerM, output: flashPeak.outPerM, cachedInput: flashPeak.cachedInPerM },
    'the budget governor and the rate card disagree — one of them is being hand-typed again',
  );
});

test('⭐⭐⭐ plan.mjs prices the two DeepSeek models from the card and nowhere else', () => {
  for (const [id, card] of [[FLASH, flashPeak], [PRO, ratesFor(PRO)]]) {
    const p = MODEL_PRICES[id];
    assert.ok(p, `${id} vanished from MODEL_PRICES`);
    assert.deepStrictEqual(
      { in: p.in, out: p.out, cacheRead: p.cacheRead },
      { in: card.inPerM, out: card.outPerM, cacheRead: card.cachedInPerM },
      `${id}: the plan table and the rate card disagree`,
    );
  }
});

test('⚠️ one output share, not two — plan.mjs re-exports the card\'s', () => {
  assert.strictEqual(PLAN_OUTPUT_SHARE, OUTPUT_TOKEN_SHARE);
  // Measured 0.34%-0.56% in the ledger, 0.9% on a real 3-round run. If this ever
  // reads 0.12 again, somebody has re-introduced the invented 88/12 mix.
  assert.ok(OUTPUT_TOKEN_SHARE > 0 && OUTPUT_TOKEN_SHARE <= 0.02,
    `output share ${OUTPUT_TOKEN_SHARE} is outside every measurement we have`);
});

test('⚠️⚠️ NOTHING IN budget.mjs OR plan.mjs MAY HAND-TYPE A DEEPSEEK RATE', () => {
  /**
   * ── ⭐ THE REACH HALF. Equality above proves the values agree TODAY; this
   * proves they cannot drift apart TOMORROW, because there is no second place to
   * type them. Without it, somebody "fixes" a price by pasting a literal back in
   * and every assertion above still passes on the day they do it.
   *
   * Comments are stripped first — the history of these numbers is written down
   * on purpose and must stay writable.
   */
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const banned = [
    // today's card — must come from rate-card.mjs
    '0.44', '1.32', '0.014', '0.22', '0.66', '0.007', '3.96', '0.044',
    // the stale card that sat here for nine days
    '0.068', '0.137', '0.0137', '0.435', '0.870', '0.0036', '0.14', '0.28',
  ];
  for (const file of ['../lib/budget.mjs', '../lib/plan.mjs']) {
    const src = strip(readFileSync(new URL(file, import.meta.url), 'utf8'));
    assert.ok(src.includes("from './rate-card.mjs'"), `${file} does not import the rate card`);
    for (const lit of banned) {
      const hit = new RegExp(`(?<![\\d.])${lit.replace('.', '\\.')}(?![\\d])`).test(src);
      assert.ok(!hit, `${file} hand-types the literal ${lit} — prices come from rate-card.mjs, always`);
    }
  }
});

test('⚠️⚠️ REPLACED: the two rows are the DEAREST and CHEAPEST PINNED PROVIDER, not a clock', () => {
  /**
   * ── 🚨 THIS TEST USED TO ENSHRINE A FICTION ─────────────────────────────────
   *
   * It asserted `peak === offPeak * 2` on every token type, and it PASSED for
   * eleven days — because the card's two rows happened to be **Novita
   * ($0.44/$1.32) and DeepSeek-direct ($0.22/$0.66)**, two unrelated providers
   * that sit at a coincidental 2:1. The card called that a peak/off-peak
   * schedule. It never was one.
   *
   * ⭐ THE GREEN 2x WAS THE STRONGEST EVIDENCE THAT SOMETHING WAS WRONG, and it
   * read as the strongest evidence that everything was right. A relationship
   * that clean between two independently-set market prices is a coincidence, and
   * a coincidence asserted to twelve decimal places is a fact nobody checked.
   *
   * ── ⭐ WHAT IS ACTUALLY TRUE, AND IS WORTH PINNING ──────────────────────────
   *
   * The rows now mean *dearest* and *cheapest provider in our pin*. So the real
   * invariants are ORDERING and PROVENANCE, not a ratio:
   *   · peak ≥ offPeak on every token type (a ceiling cannot be under a floor)
   *   · both must come from a provider we actually pin — checked against the
   *     live feed by `scripts/verify-rate-card.mjs`, which is the only thing
   *     that can catch this class of error at all.
   */
  for (const model of [FLASH, PRO]) {
    const peak = ratesFor(model), off = ratesFor(model, 'offPeak');
    for (const k of ['inPerM', 'cachedInPerM', 'outPerM']) {
      assert.ok(peak[k] >= off[k],
        `${model}.${k}: the ceiling (${peak[k]}) is BELOW the floor (${off[k]}) — the rows are swapped`);
      assert.ok(peak[k] > 0 && off[k] > 0, `${model}.${k}: a zero rate prices something as free`);
    }
    /**
     * ⚠️ AND THE SPREAD MUST BE PLAUSIBLE FOR ONE PIN LIST. Our pins hold 2-3
     * providers of the same model; a 5x gap between the dearest and cheapest
     * means the pin has picked up an outlier, which is exactly the defect that
     * had Fireworks at 2x DeepSeek sitting in pro's fallback chain.
     */
    assert.ok(peak.inPerM <= off.inPerM * 5,
      `${model}: the pin spans ${(peak.inPerM / off.inPerM).toFixed(1)}x on input — an outlier is in the pin list`);
  }
});

test('⚠️⚠️ the GOVERNOR takes PEAK — under-braking is the only error that reaches a bill', () => {
  assert.strictEqual(RATE_USD_PER_MILLION.input, flashPeak.inPerM);
  /**
   * ⚡ RESTATED 2026-09-28. This asserted the governor's INPUT sat above off-peak. On v4.1's pin
   * (every plan, owner decision) all three members list $0.30 in / $1.20 out and differ only on the
   * cache read (Modal $0.030 vs $0.006), so the envelope's two rows are equal on input and output and
   * the "peak" column is only dearer on cache reads. The property — the governor takes the DEARER
   * row, never the cheaper — is asserted on every field, with the cache read strictly above.
   */
  assert.strictEqual(RATE_USD_PER_MILLION.output, flashPeak.outPerM);
  assert.strictEqual(RATE_USD_PER_MILLION.cachedInput, flashPeak.cachedInPerM);
  for (const k of ['inPerM', 'outPerM', 'cachedInPerM']) assert.ok(flashPeak[k] >= flashOff[k], `peak ${k} under off-peak`);
  assert.ok(RATE_USD_PER_MILLION.cachedInput > flashOff.cachedInPerM,
    'the governor is pricing at off-peak — a run that overruns at 09:00 UTC on a Tuesday pays double what it was told');
  // 35 of 168 hours. Peak is the minority of the week, which is exactly why the
  // temptation to price at off-peak exists and must be refused.
  assert.ok(Math.abs(PEAK_SHARE_OF_WEEK - 35 / 168) < 1e-12, `peak share ${PEAK_SHARE_OF_WEEK}`);
  assert.deepStrictEqual([...PEAK_SCHEDULE.days], [1, 2, 3, 4, 5], 'Mon-Fri — a weekend peak is a markup, not a schedule');
});

test('⭐⭐⭐ the card REPRODUCES the real bill, to eight decimal places', () => {
  /**
   * ── THE DERIVATION, RE-RUN. NO NETWORK, NO SPEND. ─────────────────────────
   *
   * `ECONOMICS.md` §2 solved for the rate card that reproduces the recorded
   * `costUsd` from the recorded token split in `.acuvo/audit/*.jsonl`. Five of
   * six records reconcile exactly. Those five are pinned here, so the claim
   * "this is not a model of the price, it IS the price" stays checkable after
   * the ledgers are gone — and they DO go: the audit log is per-workspace, and
   * the 173-run sample the earlier analysis used evaporated with its worktree.
   *
   * ⚠️ PRICED AT `BILLED_OBSERVED_FLASH`, NOT AT THE LIST CARD. What we were
   * CHARGED had a 4x markup on cache reads, because `warm-provider.mjs` had
   * locked onto Novita — a provider absent from our own preference list. Miss
   * and output are the peak LIST price exactly; only the cache read is marked
   * up. Asserting the difference is the point: it is how we would notice the pin
   * coming back.
   */
  const records = [
    { when: '2026-08-22T07:17Z', uncached: 25_721, cached: 0, output: 138, actual: 0.01149940 },
    { when: '2026-08-22T07:31Z', uncached: 121, cached: 25_600, output: 62, actual: 0.00085188 },
    { when: '2026-08-22T07:31Z', uncached: 124, cached: 25_600, output: 123, actual: 0.00093372 },
    { when: '2026-08-23T03:31Z', uncached: 25_707, cached: 0, output: 129, actual: 0.01148136 },
    { when: '2026-08-23T04:12Z', uncached: 10_987, cached: 14_720, output: 20, actual: 0.00527284 },
  ];
  const b = BILLED_OBSERVED_FLASH;
  for (const r of records) {
    const predicted = (r.uncached * b.inPerM + r.cached * b.cachedInPerM + r.output * b.outPerM) / 1e6;
    assert.ok(Math.abs(predicted - r.actual) < 5e-9,
      `${r.when}: predicted ${predicted.toFixed(8)} vs billed ${r.actual.toFixed(8)}`);
  }
});

test('⚠️⚠️ the reseller markup was on CACHE READS and only cache reads', () => {
  /**
   * ⭐ THE SHAPE OF THE OVERCHARGE IS THE DIAGNOSIS. A provider 2x on everything
   * would look like a peak window. A provider at list on miss and output but 4x
   * on cache reads is a markup aimed squarely at the token type we spend the
   * whole product optimising toward — the better our caching gets, the larger
   * the marked-up share of the bill becomes.
   */
  /**
   * ── 🚨 THE DIAGNOSIS ABOVE WAS RIGHT AND ITS BASELINE WAS WRONG ─────────────
   *
   * It compared what Novita billed against the CARD — and the card was carrying
   * **Novita's own price**. So "at list on miss and output, 4x on cache reads"
   * was really *"identical to itself on two of three fields."* The comparison
   * could only ever have come out that way.
   *
   * ⭐ AGAINST THE REAL PINNED CEILING (DeepInfra fp8) THE DAMAGE IS FAR WORSE
   * AND FAR SIMPLER — Novita was dearer on **everything**:
   *
   *     input       5.5x
   *     output      7.3x
   *     cache read  1.75x
   *
   * ⚠️ So the story is not "a clever markup aimed at cache reads". It is "we
   * were routed to one of the most expensive endpoints on the exchange and then
   * wrote its prices down as the market rate." The subtler reading was an
   * artifact of measuring the defect against itself.
   */
  /**
   * ── ⚠️ RE-ANCHORED 2026-09-20 — `> 5 / > 7 / > 1.5` WERE DEEPINFRA'S RATIOS ──
   *
   * The multiples were computed against the $0.08/$0.18/$0.016 card and typed in.
   * On Makora they are 4.9x / 6.8x / 6.7x, so `> 5` went red while the finding
   * itself got STRONGER — the cache-read overcharge is now 6.7x, not 1.75x. A
   * threshold that fails on a repin while the claim it encodes becomes more true
   * is measuring the wrong thing.
   *
   * ⭐ THE CLAIM IS "NOVITA WAS DEARER ON EVERYTHING", and that is what is
   * asserted. The multiples are reported in the message so the damage is still
   * legible without being pinned.
   */
  // ⚡ 2026-09-28: the Novita bill was a `-0731` event, so it is measured against THAT model's
  // pinned ceiling. Against v4.1's card (the default now) the cache read would read 0.93x — a
  // different model's price, not evidence the markup was smaller.
  const flash0731Peak = ratesFor(FLASH_0731);
  const ratio = (k) => BILLED_OBSERVED_FLASH[k] / flash0731Peak[k];
  for (const k of ['inPerM', 'outPerM', 'cachedInPerM']) {
    assert.ok(ratio(k) > 1,
      `Novita's ${k} was ${ratio(k).toFixed(2)}x our pinned ceiling — it must be dearer on every field, `
      + 'or the card has been overwritten with a bad route again');
  }
  // ⚠️ And the overcharge must stay LARGE, or this stops being evidence of anything.
  assert.ok(ratio('inPerM') > 3 && ratio('outPerM') > 3,
    `input ${ratio('inPerM').toFixed(1)}x and output ${ratio('outPerM').toFixed(1)}x — `
    + 'if a bad route is now within 3x of the pin, the pin is the thing that moved');
  /**
   * ⚠️ AND THE OBSERVATION IS KEPT AS HISTORY, NOT AS A CARD. It is evidence of
   * what a bad route costs — the reason `verify-rate-card.mjs` exists — and must
   * never be mistaken for a price again.
   */
  assert.ok(BILLED_OBSERVED_FLASH.inPerM > flashPeak.inPerM,
    'if this ever equals the card again, the card has been overwritten with a bad route');
});

test('⭐ the fallback price is the COLD blend, priced from the card', () => {
  // A silent provider is exactly the case where a session might genuinely be
  // uncached — round 1 is ALWAYS 0% cache, and a fresh session is all round ones.
  assert.strictEqual(DEFAULT_USD_PER_MILLION_TOKENS, blendedPerMillion(flashPeak, 0));
  /**
   * ⚠️ RE-ANCHORED 2026-08-27: the bound `0.40 < x < 0.46` was pinned to the
   * $0.44/M "miss rate" that turned out to be Novita's price recorded as
   * DeepSeek's list — see the reseller-markup test above. The corrected pin
   * (DeepInfra, $0.08/M miss) blends to $0.0809/M cold, roughly a FIFTH of
   * the old figure, because the reference it sits under got 5.5x cheaper.
   */
  /**
   * ── ⚠️ RE-DERIVED 2026-09-20 — THE BAND WAS THE MISS RATE, TYPED ────────────
   *
   * `0.079 < x < 0.083` is DeepInfra's $0.08/M with a 4% collar around it. The
   * pin moved to Makora ($0.09/M) and it went red at 0.090945 — the correct cold
   * blend of the current card. The SHAPE is what this asserts and the shape has
   * not changed: the cold blend sits just ABOVE the miss rate, because
   * `OUTPUT_TOKEN_SHARE` of the blend is output and output is dearer.
   */
  const miss = flashPeak.inPerM;
  assert.ok(DEFAULT_USD_PER_MILLION_TOKENS > miss && DEFAULT_USD_PER_MILLION_TOKENS < miss * 1.2,
    `the cold blend should sit just above the $${miss}/M miss rate — got ${DEFAULT_USD_PER_MILLION_TOKENS}`);
  // It must never fall below the warm rate, or the governor stops braking at all.
  assert.ok(DEFAULT_USD_PER_MILLION_TOKENS > blendedPerMillion(flashPeak, 0.85));
});

test('⚠️⚠️ INVERTED 2026-08-27 — pro is 14x flash cold, falling to ~4.7x warm: THE PREMIUM COLLAPSES AGAIN', () => {
  /**
   * ── 🚨 THE "FLAT ~3x" READING WAS THE SAME ASYMMETRY BUG ────────────────────
   *
   * This test used to assert the ratio held flat near 3x and even RISES
   * slightly with cache — "the rule is dead." `rate-card.mjs`'s own
   * 2026-08-28 history entry says that reading was itself a defect: PRO's
   * peak row had been left on GMICloud's model-level figure ($1.122/$3.366)
   * while FLASH's had already moved onto its real pinned endpoint. Pricing
   * pro off an unpinned figure and flash off a pinned one is not a
   * comparison, it is two different measurement methods wearing one ratio.
   *
   * ⭐ CORRECTED: pro's peak (GMICloud, the dearest name still in its pin —
   * DeepSeek leads it, cheaper) against flash's peak (DeepInfra). Both are
   * now read the SAME way — the dearest reachable name in each model's own
   * pin — and `rate-card.mjs` documents the result directly: *"pro is 8.25x
   * on fresh input but only 1.4x on a cache read… 'pro's premium collapses
   * as the cache warms' is TRUE again, and was only ever falsified by the bad
   * card."* MEASURED here through `costPerMillion`, which blends in the
   * output share too: 14.12x at 0% cache, falling to 4.74x at 98%.
   */
  /**
   * ── ⚠️ RE-DERIVED 2026-09-20 — 14.12 AND 4.74 WERE THE DEEPINFRA CARD'S ─────
   *
   * Both are PRO's card divided by FLASH's, so the flash repin moved them
   * (11.82x cold, 4.64x at 98%) without anything about the finding changing. The
   * finding is the COLLAPSE — a big cold premium that falls monotonically as
   * cache warms — and that is what the assertions now hold, with the magnitudes
   * reported rather than pinned.
   */
  const at = (c) => costPerMillion(PRO, c) / costPerMillion(FLASH, c);
  /**
   * ⚡ 2026-09-28: flash moved to v4.1 (owner, every plan) — a card 3-5x the `-0731` one — so the
   * cold premium fell to 3.49x and the collapse to 98% cache is 1.91x (was >2x). It is FLASH that
   * moved, not the pro pin. Floors restated to the measured values; the monotonic fall is unchanged.
   */
  assert.ok(at(0) > at(0.98) * 1.8,
    `the premium must COLLAPSE, not drift: cold ${at(0).toFixed(2)}x vs 98%-cached ${at(0.98).toFixed(2)}x`);
  assert.ok(at(0) > 3, `cold pro is only ${at(0).toFixed(2)}x flash — check the pro pin (3.49x on v4.1's card, 2026-09-28)`);
  const rates = [0, 0.5, 0.85, 0.95, 0.98];
  for (let i = 1; i < rates.length; i += 1) {
    assert.ok(at(rates[i]) < at(rates[i - 1]),
      `the premium must keep FALLING as cache rises — at(${rates[i]})=${at(rates[i]).toFixed(2)} vs `
      + `at(${rates[i - 1]})=${at(rates[i - 1]).toFixed(2)}`);
  }
});

test('⭐ priceFromSplit still reconciles a real round through the new card', () => {
  // Ledger record 5: 10,987 uncached + 14,720 cached + 20 output. At LIST rates
  // (not the marked-up cache read) this is what the same round should now cost.
  const usd = priceFromSplit({
    prompt_tokens: 25_707, completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 14_720 },
  });
  /**
   * ⚠️ RE-ANCHORED 2026-08-27: `0.44 / 0.014 / 1.32` was the OLD "list" row,
   * which is now known to be Novita's reseller-marked-up price rather than a
   * list price at all (see the reseller-markup test above). The genuinely
   * pinned card was then DeepInfra's `0.08 / 0.016 / 0.18`.
   *
   * ⚠️⚠️ AND RE-DERIVED 2026-09-20, BECAUSE RE-ANCHORING BY HAND IS THE DEFECT.
   * Those three literals were the card typed into a test — in the file whose
   * entire subject is that a copy cannot know it is stale. They went stale on
   * the 2026-09-12 Makora repin, exactly as the file's own header predicts.
   * The card is now read, and the assertion below — list stays far under what
   * a bad route billed — is the part that carries meaning.
   */
  const expected = (10_987 * flashPeak.inPerM + 14_720 * flashPeak.cachedInPerM + 20 * flashPeak.outPerM) / 1e6;
  assert.ok(Math.abs(usd - expected) < 1e-12, `priced ${usd}, expected ${expected}`);
  // And it is far CHEAPER than what we were actually billed, because the pin is gone —
  // more so than before, now that the reference card itself is the real cheap pin.
  assert.ok(usd < 0.00527284, 'list must be below the marked-up bill, or the pin is back');
});

test('⚠️ every model the card prices is one the CLI actually routes to', async () => {
  /**
   * ── ⭐ DERIVED 2026-08-28, AND THIS IS STRICTER THAN WHAT IT REPLACED ──────
   *
   * It read `deepStrictEqual(Object.keys(RATE_CARD), [FLASH, PRO])`. The INTENT
   * is exactly right and is kept verbatim below — a card that grows entries
   * nobody routes to becomes a second, unowned price table, which is how this
   * started. But the MECHANISM was a hardcoded pair, so it could only ever
   * express 'the card has these two models', not 'the card has no strangers'.
   *
   * ⚠️ It fired when `qwen/qwen3.7-flash` and `z-ai/glm-4.6` moved INTO the card
   * from `plan.mjs` — and both are genuinely routed: qwen is THE EYES (the only
   * leg that can receive an image) and glm is a `chain.mjs` fallback. The guard
   * was correct to stop me and wrong about the reason.
   *
   * ⭐ So it now derives the permitted set from `PROVIDER_PIN_BY_MODEL` — the
   * router's own list of models it knows how to reach. A card entry for a model
   * we cannot route still fails, which was the whole point; and a hand-typed
   * price can no longer hide in `plan.mjs`, because
   * `every-price-comes-from-the-card.test.mjs` requires the card to be the only
   * source. Two guards, one invariant, no gap between them.
   */
  const { PROVIDER_PIN_BY_MODEL } = await import('../lib/model.mjs');
  const routable = new Set(Object.keys(PROVIDER_PIN_BY_MODEL));

  // ⚠️ Anti-vacuity: an empty router list would make the loop below pass over
  // nothing. The two models the economics rest on must be present.
  assert.ok(routable.has(FLASH) && routable.has(PRO), 'the router does not know the models we price against');

  const strangers = Object.keys(RATE_CARD).filter((m) => !routable.has(m));
  assert.deepStrictEqual(
    strangers, [],
    `the card prices ${strangers.join(', ')} and the router cannot reach ${strangers.length === 1 ? 'it' : 'them'} — that is a second, unowned price table`,
  );
});

/**
 * ── ⭐⭐⭐ THE PROVIDER NAME LIVES IN THREE PLACES. THEY MUST AGREE. ─────────
 *
 * ⚠️ THIS GUARD EXISTS BECAUSE I BROKE IT ON THE DAY I FIXED THE OTHER TWO.
 * On 2026-08-27/28 the flash pin moved from StreamLake to DeepInfra and the rate
 * card was corrected to match — and `DEFAULT_PROVIDER_ORDER` in `model.mjs`
 * stayed saying `'StreamLake'`. StreamLake is $0.22/M input against DeepInfra's
 * $0.08 — **2.75x** — so one stale string was quietly overriding the cheaper
 * route the other two files had just been corrected to describe.
 *
 * ⭐ IT IS THE EXACT FAILURE `rate-card.mjs` OPENS BY DESCRIBING: *"one mistake
 * copied eight times, and a copy has no way to know it is stale."* Two
 * behavioural tests caught it by accident. This one catches it on purpose, and
 * names the third copy so the next person does not have to rediscover it.
 */
test('⭐⭐ the default pin, the per-model pin, and the card all name the SAME provider', async () => {
  const { DEFAULT_PROVIDER_ORDER, PROVIDER_PIN_BY_MODEL } = await import('../lib/model.mjs');
  const flashPin = PROVIDER_PIN_BY_MODEL[FLASH];

  assert.ok(Array.isArray(flashPin) && flashPin.length > 0, 'flash has no pin at all');
  assert.strictEqual(
    DEFAULT_PROVIDER_ORDER,
    flashPin[0],
    `DEFAULT_PROVIDER_ORDER is "${DEFAULT_PROVIDER_ORDER}" but flash is pinned to "${flashPin[0]}" first — `
    + 'a stale global default silently overrides the per-model pin, and the rate card describes neither',
  );

  /**
   * ⚠️ AND THE CARD MUST DESCRIBE THAT PIN, not some other endpoint. This is the
   * relationship `scripts/verify-rate-card.mjs` checks against the LIVE feed;
   * here it is only checked for internal coherence, because a unit test cannot
   * reach the network and a test that needs wifi is a test people delete.
   */
  assert.ok(ratesFor(FLASH).inPerM > 0, 'the card has no price for the pinned model');
  assert.ok(
    ratesFor(FLASH).inPerM >= ratesFor(FLASH, 'offPeak').inPerM,
    'the card ceiling is below its floor — the rows are swapped',
  );
});
