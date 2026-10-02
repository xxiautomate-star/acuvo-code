import test from 'node:test';
import assert from 'node:assert';
import { priceFromSplit, RATE_USD_PER_MILLION, DEFAULT_USD_PER_MILLION_TOKENS } from '../lib/budget.mjs';
import { ratesFor, FLASH } from '../lib/rate-card.mjs';

/**
 * ── ⭐⭐⭐ TWO HONEST MEASUREMENTS THAT APPEARED TO DISAGREE ─────────────────
 *
 * budget.mjs measured $0.223/M (1,036 tokens for $0.000231, cold, output-heavy).
 * The console measured $0.117/M cold and $0.0357/M blended on real builds.
 * That looked like a 2x contradiction about the same model and it was not:
 * they are the SAME rates applied to DIFFERENT MIXES. A single $/M constant
 * cannot describe both, which is why one had to be wrong wherever it was used.
 */

test("⚠️ RE-ANCHORED AGAIN 2026-08-27: the routing PIN was the variable, not the vendor's clock", () => {
  /**
   * ── THE 2026-08-16 ANCHOR ($0.001048) WAS ITSELF A RESELLER MARKUP ─────────
   *
   * `turn.mjs` recorded 1,036 tokens (363 prompt, 673 completion) at
   * **$0.000231** on the ORIGINAL card, and the 2026-08-16 "restructure" moved
   * that to **$0.001048** — a figure this test used to defend as the new
   * truth. It was not. `lib/rate-card.mjs`'s own history (2026-08-27 entry)
   * traces that $0.44in/$1.32out "peak" row to **Novita** — the exact
   * upstream `warm-provider.mjs` had accidentally learned-and-locked onto,
   * and which `ECONOMICS.md` had already flagged as billing a 4x markup on
   * cache reads specifically. The card recorded a routing accident as
   * DeepSeek's published list price and reasoned from it for eleven days.
   *
   * ⭐ CHECKED AGAINST THE LIVE OPENROUTER ENDPOINT FEED: flash's actual pin
   * (`DeepInfra`, fp8, $0.08 in / $0.18 out) prices this exact round at
   * **$0.00015018** — cheaper than even the ORIGINAL pre-restructure anchor,
   * because that anchor was itself measured on an unpinned, scattershot
   * route rather than the endpoint we deliberately ask for today.
   *
   * ⚠️ RE-ANCHORED, NOT LOOSENED, AGAIN. Both historical figures stay in the
   * assertions as the record of how wrong the intermediate card was, and the
   * RATIOS are what is pinned, so this still fails the moment the table
   * drifts.
   */
  const usd = priceFromSplit({ prompt_tokens: 363, completion_tokens: 673 });
  assert.ok(usd !== null);
  const MEASURED_ON_THE_FIRST_CARD = 0.000231;
  const MEASURED_ON_THE_RESELLER_MARKUP_CARD = 0.001048; // Novita, wearing DeepSeek's list price — see rate-card.mjs
  /**
   * ── ⚠️⚠️ RE-DERIVED 2026-09-20 — `$0.00015018` WAS A FOURTH COPY OF THE CARD ─
   *
   * That literal is DeepInfra's `0.08 in / 0.18 out` applied to this round by
   * hand. The pin moved to Makora on 2026-09-12 and it went red at $0.000163905,
   * which is the correct price of the same round on the current card. The two
   * HISTORICAL anchors below are genuine measurements of what we were billed and
   * stay typed; today's price is a derived value and must come from the card, or
   * this file joins the eight copies `rate-card.mjs` opens by describing.
   */
  const onTodaysCard = (363 * RATE_USD_PER_MILLION.input + 673 * RATE_USD_PER_MILLION.output) / 1e6;
  assert.ok(Math.abs(usd - onTodaysCard) / onTodaysCard < 1e-9,
    `priced ${usd}; the card prices this round at ${onTodaysCard}`);
  /**
   * ⚡ RESTATED 2026-09-28. These two compared today's card with the two HISTORICAL anchors and
   * asserted we were far below both (6-8x under the reseller markup; under the first card). The owner
   * then moved every plan to v4.1 for speed, whose pin card is $0.30 / $1.20: this 363-in / 673-out
   * round now prices at $0.0009165 — 1.14x UNDER the reseller-markup anchor and 3.97x OVER the first.
   * Both anchors stay typed (they are what we were billed); the relationship is pinned as measured,
   * so the next card move is seen rather than absorbed.
   */
  assert.strictEqual((MEASURED_ON_THE_RESELLER_MARKUP_CARD / usd).toFixed(2), '1.14',
    `the reseller-markup card vs this round: ${(MEASURED_ON_THE_RESELLER_MARKUP_CARD / usd).toFixed(2)}x — re-read the card`);
  assert.ok(usd > MEASURED_ON_THE_FIRST_CARD,
    'v4.1 (every plan since 2026-09-28) prices this round ABOVE the very first anchor — by decision');
});

test('⭐⭐ a real cached session still costs a FRACTION of the flat constant', () => {
  // The actual run that surfaced this: 87,814 tokens at 80% cache.
  const real = priceFromSplit({
    prompt_tokens: 87_320, completion_tokens: 494,
    prompt_tokens_details: { cached_tokens: 69_504 },
  });
  const flat = (87_814 / 1e6) * DEFAULT_USD_PER_MILLION_TOKENS;
  /**
   * ── ⚠️⚠️ REPINNED 2026-08-27 — THE GAP SHRANK AGAIN, AND THAT IS CORRECT ────
   *
   * This ratio has moved twice now, both times because the REFERENCE (the flat
   * constant) got cheaper, not because caching got worse. It was `/5` when the
   * flat constant was an $0.30 hand-typed guess, `/4` once that constant became
   * the honestly-derived cold blend on the RESELLER-MARKUP card ($0.4479/M —
   * see the previous test). That card has since been traced to Novita's price
   * wearing DeepSeek's name (`rate-card.mjs`, 2026-08-27), and the corrected
   * card prices flash's real pin (`DeepInfra`) at $0.0809/M cold.
   *
   * ⭐ AND THE PINNED ENDPOINT'S OWN CACHE DISCOUNT IS SMALLER. DeepInfra's
   * `cachedInPerM` is only 1/5 of its `inPerM` (0.016 vs 0.08) — nowhere near
   * the ~1/30 the old reseller-inflated numbers implied. So the remaining gap
   * at this session's real ~79.6% cache rate is now genuinely smaller, around
   * 2.7x, and that number is a fact about THIS endpoint's discount, not a sign
   * the constant drifted again.
   */
  /**
   * ⚡ REPINNED 2026-09-28 — THE GAP GREW TO 3.37x, AND THAT IS CORRECT. v4.1's pin card discounts a
   * cache read 10x (0.30 → 0.030, envelope) where DeepInfra's discounted 5x, so the same 79.6%-cached
   * session sits further under the cold constant. The band moves with the discount, not with drift.
   */
  assert.ok(real < flat / 3,
    `the flat constant charged ${flat}, the mix costs ${real} — the gap IS the cache discount`);
  assert.ok(real > flat / 3.6, 'and if the gap grows past ~3.6x the flat constant has drifted off the cold rate again');
});

test('⚠️ both provider vocabularies price identically', () => {
  // OpenRouter nests the cache read; DeepSeek puts it at the top level. A reader
  // that knows one spelling silently prices the other at ZERO cache — the same
  // 8x error wearing a different hat.
  const openrouter = priceFromSplit({
    prompt_tokens: 1000, completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 800 },
  });
  const deepseek = priceFromSplit({
    prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800,
  });
  assert.strictEqual(openrouter, deepseek);
});

test('⚠️ a cached token really is cheaper than a fresh one', () => {
  const cold = priceFromSplit({ prompt_tokens: 1000, completion_tokens: 0 });
  const warm = priceFromSplit({ prompt_tokens: 1000, completion_tokens: 0, cached_tokens: 1000 });
  assert.ok(warm < cold, 'cached input must cost less than fresh input');
  /**
   * ⚠️ `cold / 5` WAS AN ACCIDENT OF THE DEEPINFRA CARD — $0.08 / $0.016 is
   * exactly 5, so the literal and the card agreed to the digit and nobody could
   * see which one was being asserted. Makora's is 4.59 and the line went red
   * while cached input was still, plainly, cheaper. The DISCOUNT is the card's
   * to state; what this test owns is that `priceFromSplit` applies it.
   */
  const cardDiscount = RATE_USD_PER_MILLION.input / RATE_USD_PER_MILLION.cachedInput;
  assert.ok(Math.abs(cold / warm - cardDiscount) < 1e-9,
    `priceFromSplit discounts a cache read ${(cold / warm).toFixed(2)}x, the card says ${cardDiscount.toFixed(2)}x`);
  // ⚠️ And the discount must stay material, or the whole cache strategy is noise.
  assert.ok(cardDiscount > 3, `a cache read is only ${cardDiscount.toFixed(2)}x cheaper — the pin has drifted somewhere dear`);
});

test('⚠️ output is dearer than input, because it is never cached', () => {
  const inOnly = priceFromSplit({ prompt_tokens: 1000, completion_tokens: 0 });
  const outOnly = priceFromSplit({ prompt_tokens: 0, completion_tokens: 1000 });
  assert.ok(outOnly > inOnly);
  /**
   * ── ⚠️⚠️ RE-DERIVED 2026-08-27 — THE `x3` RATIO WAS THE RESELLER MARKUP'S ───
   *
   * `$0.28 = $0.14 x 2` was DeepSeek's ratio pre-restructure; `$1.32 = $0.44 x
   * 3` was the number this assertion pinned on 2026-08-25. That `x3` came from
   * the SAME card `rate-card.mjs` has since traced to Novita's price recorded
   * as if it were DeepSeek's list price (see the RE-ANCHORED test above) — so
   * the ratio was measuring a reseller's markup shape, not the vendor's.
   *
   * ⭐ ON THE CORRECTED, PIN-TRUE CARD (`DeepInfra`, $0.08 in / $0.18 out) the
   * real ratio is **2.25**, not 3.
   *
   * ── 🚨 AND THE SENTENCE THAT FOLLOWED WAS WRONG, WHICH IS THE LESSON ────────
   *
   * It read: *"the multiplier is the part of a rate card that survives a
   * repricing"*, and pinned `output === input * 2.25` on that basis. It did not
   * survive. The pin moved to Makora on 2026-09-12 ($0.09 / $0.195) and the
   * multiplier went to **2.1667** — because a multiplier is not a property of
   * "a rate card", it is a property of ONE PROVIDER'S price sheet, and the
   * variable this whole file was re-anchored around on 2026-08-27 is precisely
   * WHICH PROVIDER SERVES. The 2.25 was the third literal in this file to
   * re-state a number the card already holds.
   *
   * ⭐ WHAT IS ACTUALLY WORTH GUARDING IS THAT `budget.mjs` STILL READS THE CARD
   * — the "eight copies" defect — plus the direction. Both below, neither able
   * to go stale.
   */
  assert.ok(RATE_USD_PER_MILLION.output > RATE_USD_PER_MILLION.input,
    'output must be dearer than fresh input — it is never cached');
  assert.strictEqual(RATE_USD_PER_MILLION.output, ratesFor(FLASH).outPerM,
    'budget.mjs has stopped reading the card for output — that is the eight-copies defect returning');
  assert.strictEqual(RATE_USD_PER_MILLION.input, ratesFor(FLASH).inPerM,
    'budget.mjs has stopped reading the card for input');
});

test('⚠️⚠️ more cached than prompt tokens cannot UNDER-bill', () => {
  // A bad payload would otherwise make the fresh-input term NEGATIVE.
  const usd = priceFromSplit({ prompt_tokens: 100, completion_tokens: 0, cached_tokens: 999_999 });
  assert.ok(usd !== null && usd > 0, `priced ${usd}`);
  const allCached = priceFromSplit({ prompt_tokens: 100, completion_tokens: 0, cached_tokens: 100 });
  assert.strictEqual(usd, allCached);
});

test('returns null without a split, so the caller falls back rather than guessing', () => {
  assert.strictEqual(priceFromSplit({ total_tokens: 1000 }), null);
  assert.strictEqual(priceFromSplit({ prompt_tokens: 10 }), null);   // no completion
  assert.strictEqual(priceFromSplit(null), null);
  assert.strictEqual(priceFromSplit('nonsense'), null);
});

test('⭐ REACH: record() actually uses it', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/budget.mjs', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('function record('));
  assert.ok(block.includes('priceFromSplit('), 'record() does not price the split');
  // And the fallback must survive — this may only ever be MORE accurate.
  assert.ok(block.includes('usdPerMillionTokens'), 'the flat fallback was removed');
});
