/**
 * ── ⭐⭐ THE PLAN MATH, IN CODE ──────────────────────────────────────────────
 *
 * What a user gets for their money lived in conversations. That is fine until
 * somebody has to ENFORCE it, and then "has this account run out?" has no
 * function to call. These tests pin the arithmetic and — more importantly — the
 * facts it exists to make impossible to forget.
 *
 * ⚠️⚠️ THE CACHE RATE DOMINATES EVERYTHING ELSE COMBINED. The same plan doing
 * the same work swings by several times in cost across the cache range, which
 * is why the provider pin and compaction discipline are not housekeeping.
 *
 * ⚠️ THE FIGURES ARE ASSERTED, NOT WRITTEN OUT. This file used to carry a
 * cost-and-margin table in its header and a stale claim about the strong
 * model's premium collapsing (it no longer does — both models are priced off
 * the same shape now, so the premium is flat). A table in a comment is a
 * measurement with no expiry date, and this repo is public. The tests below
 * hold the same properties by asserting them, which is the form that cannot go
 * quietly stale and does not publish a business figure to read.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  PLANS, MODEL_PRICES, OUTPUT_TOKEN_SHARE, PLAN_ECONOMICS_ENV,
  costPerMillion, planEconomics, breakEvenCacheRate, allowanceRemaining, formatPlan, REJECTED_STRUCTURES, planGate, usageByModel,
} from '../lib/plan.mjs';
import { SUPPLY_CAP_USD } from '../lib/plan-allowance.mjs';

/**
 * ⭐ MARGIN AT THE CAP (owner, 2026-09-28): every paid plan's spend stops at
 * `SUPPLY_CAP_USD` = advertised tokens × the measured US$0.0764/M, so whatever
 * `planEconomics` says a month COULD cost on the card, it cannot cost more than
 * this. `planEconomics` stays UNCAPPED on purpose — it is the reason the cap exists.
 */
const marginAtCapPct = (p) => (1 - SUPPLY_CAP_USD[p.id] / p.priceUsd) * 100;

/** ⚡ The model every plan's allowance runs on — v4.1 since 2026-09-28 (owner decision, every plan). */
const FLASH = 'deepseek/deepseek-v4.1-flash';
const PRO = 'deepseek/deepseek-v4-pro-0813';
/**
 * ⚠️ STILL NAMED HERE THOUGH NO TIER GRANTS IT. The bucket must remain present
 * at 0 for `plan-drift.test.ts` to compare it against the console catalogue, so
 * the tests that hold it at 0 need the id as much as the ones that spent it did.
 */
const QWEN = 'qwen/qwen3.7-flash';

test('⚠️⚠️ THE CENTRAL FACT: cost per million falls with the cache rate, hard', () => {
  const cold = costPerMillion(FLASH, 0);
  const warm = costPerMillion(FLASH, 0.95);
  assert.ok(cold > warm * 3, `cache is meant to be transformative: $${cold.toFixed(4)} cold vs $${warm.toFixed(4)} warm`);
  // Monotonic — a higher cache rate can never cost more.
  let prev = Infinity;
  for (const c of [0, 0.25, 0.5, 0.75, 0.9, 0.95, 1]) {
    const v = costPerMillion(FLASH, c);
    assert.ok(v <= prev, `cost rose from ${prev} to ${v} as cache improved`);
    prev = v;
  }
});

test('⭐⭐ RE-INVERTED 2026-08-27/28: pro\'s premium COLLAPSES as the cache warms — the routing rule is BACK', () => {
  /**
   * ── THREE ANSWERS TO THE SAME QUESTION IN AS MANY WEEKS. HERE IS WHY ────────
   *
   * v1 (pre-2026-08-16): pro read cache at $0.0036 against flash's $0.0137 —
   * CHEAPER on the token a long session mostly spends. Required `at(0) > 5`,
   * `at(0.95) < 2.5`, `at(0) > at(0.95) * 2`. A real routing rule rested on it:
   * "a long warm session can afford the strong model; a short cold one can't."
   *
   * v2 (this test, 2026-08-25): DeepSeek's 2026-08-16 restructure APPEARED to
   * price both models off the same flat 3x shape at every cache rate, so v1
   * was inverted to "the premium no longer collapses; it is 3x, always."
   *
   * 🚨 v2 WAS NEVER TRUE. `lib/rate-card.mjs` had recorded a ROUTING DEFECT as
   * the list price: for eleven days the "peak" row was Novita's price for
   * FLASH ($0.44/$1.32) while PRO stayed on an unpinned $1.122/$3.366 endpoint
   * — two different upstreams, coincidentally close enough in ratio to look
   * like one flat shape. Neither number was DeepSeek's own price for either
   * model.
   *
   * ⭐ CORRECTED 2026-08-27/28 AGAINST THE LIVE OPENROUTER ENDPOINT FEED. Both
   * models are now priced at their PINNED endpoint (FLASH → DeepInfra fp8,
   * PRO → DeepSeek direct), and the two endpoints are NOT the same shape —
   * pro is **14.03x flash on fresh input, 18.7x on output, but only 2.34x on a
   * cache read**. That asymmetry is exactly what makes the ratio fall as cache
   * warms: input dominates the bill (`OUTPUT_TOKEN_SHARE` is ~1%), so a mostly-
   * cached session prices pro close to flash while a cold one prices it 8x
   * over. Measured:
   *
   *     cache   0% 14.12x      cache  85%  7.4x
   *     cache  50% 11.9x       cache  95%  5.87x      cache 98%  4.74x
   *
   * ⭐ SO v1's CONCLUSION WAS RIGHT AND v2's WAS AN ARTIFACT OF THE BAD CARD.
   * "A long warm session can afford the strong model; a short cold one cannot"
   * is true again — Roman's *"no Pro should ever be used"* is unaffected
   * (nothing routes to pro regardless), but the PRICE argument for why now
   * points the original direction.
   */
  /**
   * ── ⚠️ RE-ANCHORED 2026-09-20. `> 12` WAS THE THIRD SNAPSHOT IN THIS HISTORY ─
   *
   * The block above is a careful account of v1 and v2 both being artifacts of a
   * card, and then it pinned `at(0) > 12` — a number read off the DeepInfra card
   * on the day. Flash repinned to Makora 2026-09-12, `at(0)` fell to **11.82x**,
   * and the guard went red for a fourth time about the same ratio while the
   * CONCLUSION it defends ("the premium collapses as cache warms") was untouched:
   * cold 11.82x, 95% 5.87x, 98% 4.64x.
   *
   * ⭐ THE COLLAPSE IS THE FINDING AND THE MAGNITUDE IS THE CARD'S. `> 5` is kept
   * as a floor because a cold premium in the low single digits would mean the pro
   * pin itself had moved, which IS worth being told about.
   */
  const at = (c) => costPerMillion(PRO, c) / costPerMillion(FLASH, c);
  /**
   * ⚡ FLOOR 5 → 3 ON 2026-09-28, AND IT WAS FLASH THAT MOVED, NOT PRO. The owner put every plan on
   * v4.1 for speed; its pin card ($0.30 / $0.030 / $1.20) is 3-5x the `-0731` card, so the cold pro
   * premium fell to 3.49x — exactly the "worth being told about" event the note above anticipates,
   * told here. The collapse-with-cache assertions below are unchanged.
   */
  assert.ok(at(0) > 3, `cold pro should be far dearer than flash; measured ${at(0).toFixed(2)}x`);
  assert.ok(at(0.95) < at(0) / 1.5, `warm pro should be much closer to flash; measured ${at(0.95).toFixed(2)}x vs cold ${at(0).toFixed(2)}x`);
  // ⚡ 2026-09-28 (flash → v4.1's card): the collapse is 3.49x → 2.11x = 1.65x, down from >2x.
  // Pinned as the measured ratio, not a loosened floor; the monotonic check below is unchanged.
  assert.strictEqual((at(0) / at(0.95)).toFixed(2), '1.65',
    `the premium must FALL with cache — cold ${at(0).toFixed(2)}x vs warm ${at(0.95).toFixed(2)}x; re-read the card before re-pinning`);
  // Monotonic collapse — every additional point of cache must not make pro relatively dearer.
  let prev = Infinity;
  for (const c of [0, 0.25, 0.5, 0.65, 0.85, 0.95, 0.98, 1]) {
    const v = at(c);
    assert.ok(v <= prev + 1e-9, `pro/flash ratio rose from ${prev} to ${v} as cache improved from ${(c * 100).toFixed(0)}%`);
    prev = v;
  }
});

test('⚠️ prices are the PINNED endpoint\'s, not the model page\'s', () => {
  /**
   * ⚠️ THE MISTAKE THIS GUARDS. Pro was UNPINNED and landing on GMICloud at
   * $1.218/M in and $0.1015/M cache-read — 2.8x and 28x DeepSeek's own
   * endpoint. Quoting a model page would have hidden that completely, and did:
   * "pro costs 11.2x flash" was measured on the dear endpoint.
   */
  assert.equal(MODEL_PRICES[PRO].provider, 'DeepSeek', 'pro must be priced at the endpoint it is pinned to');
  /**
   * ── ⚠️⚠️ CORRECTED 2026-08-27/28: THE OLD NUMBERS WERE A ROUTING DEFECT ─────
   *
   * This assertion's history is two prior beliefs, both wrong for the same
   * underlying reason:
   *
   *   v1 (pre-2026-08-16): "pinned pro reads cache CHEAPER than flash — that is
   *   the whole reason the premium collapses" ($0.0036 vs $0.0137).
   *
   *   v2 (inverted 2026-08-25): "pro now reads cache DEARER than flash —
   *   $0.044 against flash's $0.014, 3.1x." Also wrong: FLASH's row at the time
   *   was Novita's price ($0.44/$1.32), a routing defect `warm-provider.mjs`
   *   had silently locked onto, not DeepSeek's own list. PRO was left on an
   *   unpinned $1.122/$3.366 endpoint. Two wrong numbers happened to disagree
   *   in a plausible-looking direction.
   *
   * ⭐ BOTH SIDES REPRICED 2026-08-27/28 against the live OpenRouter endpoint
   * feed, each at ITS OWN pinned endpoint: FLASH → DeepInfra fp8
   * ($0.08/$0.18/$0.016), PRO → DeepSeek direct ($0.66/$1.98/$0.022). Pro's
   * cache read is dearer than flash's again — **1.38x**, not v2's 3.1x — and
   * that smaller gap is exactly what lets the premium collapse on a warm
   * session (see the cache-warms test above): most of a session's tokens are
   * the one place pro and flash are nearly the same price.
   */
  assert.ok(MODEL_PRICES[PRO].cacheRead > MODEL_PRICES[FLASH].cacheRead,
    'pro still reads cache dearer than flash, just barely (1.38x) — if this flips, the pins moved and the routing question reopens');
  assert.ok(MODEL_PRICES[PRO].in > MODEL_PRICES[FLASH].in, 'and it is dearer on fresh tokens, which is why cold pro is expensive');
  /**
   * ⚠️ NOT "THE SAME PRICE SHEET AT TWO SCALES" ANY MORE. That was true only
   * because the routing-defect card had accidentally lined the two ratios up
   * (~3x each). The corrected, independently-pinned endpoints are ASYMMETRIC —
   * 14.03x on fresh input, 18.7x on output, 2.34x on a cache read — and the
   * asymmetry is the finding, not a defect to smooth over: it is WHY the
   * premium is cache-dependent again instead of flat.
   */
  /**
   * ── ⚠️⚠️ RE-DERIVED 2026-09-20 — AND THE OLD MESSAGES CONTRADICTED THEMSELVES ─
   *
   * The three multiples were typed off the DeepInfra card (14.03 / 18.7 / 2.337)
   * and went stale on the 2026-09-12 Makora repin (11.73 / 16.25 / 1.80). Two
   * things are worth recording beyond the staleness:
   *
   *   · the cache-read line ASSERTED 2.337 while its own failure message said
   *     "expected ~1.38x" — a leftover from the previous re-anchor. A message
   *     that disagrees with its assertion is a copy of a copy;
   *   · the ratios are PRO's card over FLASH's card, both from `RATE_CARD`, so
   *     pinning them is pinning the card to itself one indirection away.
   *
   * ⭐ THE FINDING IS THE ASYMMETRY — pro's premium is widest on fresh tokens and
   * NARROWEST on a cache read — because that ordering is the entire mechanism
   * behind "the premium collapses as cache warms". Ordering cannot go stale; the
   * magnitudes are reported in the messages.
   */
  const ratio = (k) => MODEL_PRICES[PRO][k] / MODEL_PRICES[FLASH][k];
  const shape = `in ${ratio('in').toFixed(2)}x · out ${ratio('out').toFixed(2)}x · cacheRead ${ratio('cacheRead').toFixed(2)}x`;
  assert.ok(ratio('cacheRead') < ratio('in'),
    `pro's premium must be NARROWEST on a cache read — that is why it collapses when cache warms (${shape})`);
  assert.ok(ratio('cacheRead') < ratio('out'), `output should carry a wider premium than a cache read (${shape})`);
  assert.ok(ratio('in') > 3, `cold pro is only ${ratio('in').toFixed(2)}x flash on fresh input (${shape}) — check the pro pin`);
});

test('⚠️ output is a rounding error, and that is WHY cache dominates', () => {
  // Measured on a real 3-round run: 33,544 tokens, 33,258 of them prompt.
  assert.ok(OUTPUT_TOKEN_SHARE < 0.02, 'if output were large, cache could not dominate the bill');
  assert.ok(OUTPUT_TOKEN_SHARE > 0, 'and it is not zero — output is never cached at all');
});

/**
 * ── 🚨🚨🚨 CORRECTED 2026-08-27/28: THE LADDER WAS PRICED AGAINST A ROUTING
 * DEFECT, NOT A PRICE SHEET ─────────────────────────────────────────────────
 *
 * The four tests below carried TWO price sheets in their history, and this is
 * the third pass:
 *
 *   v1 (pre-2026-08-16): Starter cleared 85% margin at 95% cache, 80% at a
 *   "poor" 65%. True on the pre-restructure card.
 *
 *   v2 (2026-08-16 → 08-27): asserted 76.2% at 95% cache and a catastrophic
 *   11.9% at 65% — the ladder "sized against a price sheet that no longer
 *   exists." **v2 was itself never a real price sheet.** `lib/rate-card.mjs`
 *   had recorded a ROUTING DEFECT — Novita's price ($0.44 in / $1.32 out),
 *   picked up when `warm-provider.mjs` silently locked onto a reseller
 *   charging a 4x markup on cache reads — as if it were DeepSeek's own peak
 *   list. Every figure in v2's arithmetic table inherited that markup.
 *
 * ⭐ CORRECTED against the live OpenRouter endpoint feed: 29 providers serve
 * this model with a **14.7x spread**, and the pin now leads with DeepInfra
 * fp8 — $0.08 in / $0.18 out / $0.016 cache-read, the cheapest fp8 endpoint
 * in the pin list, not the reseller we had drifted onto.
 *
 * ⚠️⚠️ THEY ARE PINNED, NOT RELAXED, AND THE DISTINCTION IS THE WHOLE POINT.
 * Rewriting a floor to make a bad number pass would be growing a baseline to
 * hide a real loss — the exact move this repo forbids. Each one asserts the
 * EXACT figure the corrected card produces, in whichever direction that
 * figure moved. Any further drift goes red and lands on a human; a green run
 * means "unchanged," not "healthy."
 *
 * ⭐ THE ARITHMETIC, so nobody has to re-derive it (US$ at AUD_USD = 0.645):
 *
 *   tier      revenue    margin @ 0% cache   break-even for 80% margin
 *   Starter   $18.705    **58.9%**           **66%**
 *   Growth    $50.955    74.4%               28%
 *   Scale     $128.36    74.4%               28%
 *
 * ⭐⭐ EVERY PAID TIER NOW PROFITS EVEN AT 0% CACHE. That is the headline
 * reversal from v2, where Starter needed 60% cache merely to break even and
 * LOST $3.31/mo at the measured 51.2%. The routing-defect card had priced a
 * cold Starter month at a loss; the corrected list price does not.
 *
 * ⚠️ STARTER'S 80%-MARGIN TARGET (66%) IS STILL ABOVE THE MEASURED 51.2%
 * (`CACHE-IS-51-PERCENT-NOT-90.md`, 90 real runs) — an 80% margin is not yet
 * the typical month, only PROFITABILITY is guaranteed regardless of cache.
 * Growth and Scale clear 80% at 28%, comfortably below what we measure.
 *
 * ⛔ RE-PRICING IS STILL ROMAN'S DECISION. No advertised number (A$29, 95M)
 * has been touched here — the correction is to what the CARD says a token
 * costs, not to what the plan sells.
 */
/**
 * ── ⚡ RE-PINNED 2026-09-28 ON THE v4.1 CARD (was 89.5% on the -0731 Relace card) ──
 *
 * The CLI card's `peak` row for v4.1 is the pin's per-column envelope — 0.30 in /
 * 0.030 cache read (Modal, the dearest member) / 1.20 out. Uncapped, 95M at 95% cache:
 *
 *     95 × (0.991 × (0.05 × 0.30 + 0.95 × 0.030) + 0.009 × 1.20) = US$5.121
 *     1 − 5.121 / 18.705 = 72.6%
 *
 * ⭐ AND THE CAP BOUNDS IT: at most US$7.258 (95 × 0.0764), so margin at cap is
 * 1 − 7.258 / 18.705 = 61.2% — positive at ANY cache rate.
 */
test('🚨 PINNED: the $29 plan at 95% cache — 72.6% on the v4.1 card, 61.2% at the cap', () => {
  const e = planEconomics(PLANS.starter, 0.95);
  assert.strictEqual(marginAtCapPct(PLANS.starter).toFixed(1), '61.2');
  assert.strictEqual(e.marginPct.toFixed(1), '72.6',
    `Starter@95% moved to ${e.marginPct.toFixed(1)}% — re-approve it, do not edit this number`);
  assert.deepEqual(e.unpriced, [], 'an unpriced model silently understates COGS');
  assert.ok(e.cogsUsd > 0, 'a plan that costs nothing means the prices did not load');
});

test('⭐⭐ AND NOW IT PROFITS COLD, NOT JUST AT A POOR CACHE RATE — the alarm was a defect', () => {
  /**
   * ── THREE GENERATIONS OF THIS TEST, EACH RIGHT ABOUT ITS OWN CARD ──────────
   *
   * v1 asserted `marginPct < 80` at 65% cache — true on the pre-restructure
   * card, and it said so itself: "if that stops being true the numbers moved
   * and the pricing needs revisiting."
   *
   * v2 (2026-08-16 → 08-27) said the numbers HAD moved: 95M flash at 65%
   * cache cost $16.48 against $18.705 revenue, an 11.9% margin, break-even for
   * 80% margin pushed to 97% (above the 97.2% identical-prefix lab ceiling),
   * and the plan merely "did not lose money" at 65%.
   *
   * 🚨 v2's NUMBERS WERE THE ROUTING DEFECT, NOT A REPRICE. Once
   * `lib/rate-card.mjs` is corrected to the pinned DeepInfra fp8 endpoint
   * ($0.08/$0.18/$0.016) instead of the Novita markup it had locked onto, the
   * SAME 95M grant at the SAME 65% cache costs $3.77, not $16.48 — a
   * **79.8%** margin, not 11.9%. Nothing about the plan changed; the input we
   * were costing it against was wrong.
   *
   * ⭐ AND STARTER NOW SURVIVES A TOTAL CACHE FAILURE, NOT JUST A "POOR" ONE.
   * `breakEvenCacheRate(starter, 0)` returns **0%** — the plan is profitable
   * from the very first cold token, 58.9% margin at 0% cache. v2's alarm ("60%
   * cache just to make a dollar") does not apply to the corrected card at all.
   */
  /**
   * ── ⚡ v4 (2026-09-28): ON THE v4.1 CARD THE UNCAPPED VIEW IS COLD AGAIN — AND THE CAP IS
   * WHAT HOLDS ──
   *
   * v4.1 is 3-5x the -0731 card per token (the price of the speed ruling). Uncapped at 65%:
   *     95 × (0.991 × (0.35 × 0.30 + 0.65 × 0.030) + 0.009 × 1.20) = US$12.747 → 31.9%
   * Uncapped, Starter never reaches an 80% margin at any cache rate (79.4% at 100%), and
   * breaks even only from 42% cache up; stone cold it would cost US$29.27, a −56.5% month.
   *
   * ⭐ NONE OF THAT CAN HAPPEN WITH THE CAP ON: spend stops at US$7.258, so the margin at the
   * cap is 61.2% at every cache rate. These uncapped figures are pinned because they are
   * the reason the cap exists, not because a customer can reach them.
   */
  const poor = planEconomics(PLANS.starter, 0.65);
  assert.strictEqual(poor.marginPct.toFixed(1), '31.9',
    `Starter@65% moved to ${poor.marginPct.toFixed(1)}% — re-approve it, do not edit this number`);
  assert.ok(poor.profitUsd > 0, 'a 65% cache month must at least not lose money');

  const target80 = breakEvenCacheRate(PLANS.starter, 80);
  assert.strictEqual(target80.rate, null,
    `uncapped Starter now reaches 80% at ${target80.rate} cache — the v4.1 card moved; re-derive`);

  const survives = breakEvenCacheRate(PLANS.starter, 0);
  assert.ok(survives.rate !== null && Math.abs(survives.rate - 0.42) < 0.005,
    `uncapped Starter breaks even at ${survives.rate} cache — pinned at 0.42 on the v4.1 card`);

  // ⭐ …and the cap makes every one of those months profitable.
  assert.ok(marginAtCapPct(PLANS.starter) > 0);
  assert.ok(SUPPLY_CAP_USD.starter < planEconomics(PLANS.starter, 0).cogsUsd,
    'the cap binds before a cold month can cost more than the plan earns');
});

test('⭐ a free plan has no margin, and says null rather than inventing 100%', () => {
  const e = planEconomics(PLANS.free, 0.95);
  assert.equal(e.marginPct, null, 'a free plan with a 100% margin is a number somebody made up');
  assert.ok(e.cogsUsd > 0, 'it still costs us real money');
  assert.ok(e.profitUsd < 0, 'and that money is a loss, stated plainly');
});

test('⚠️⚠️ ONE MODEL, ONE NUMBER — every paid tier sells flash and only flash', () => {
  /**
   * ── ⚠️ THIS TEST DEFENDED THE THREE-BUCKET LADDER AND HAD TO BE INVERTED ───
   *
   * It asserted `tokens[PRO] > 0` on the reasoning that separate allowances beat
   * one pooled number. The reasoning still holds — pro really does cost 1.9x–6.4x
   * flash depending on cache, so pooling them WOULD lie. What changed is that we
   * no longer sell pro at all, and an allowance for a model nothing routes to is
   * not a second honest number, it is a bigger number that means less.
   *
   * ⭐ A guard aimed at a superseded decision protects the mistake, not the
   * product — so this now guards the decision that replaced it. It goes red if
   * any tier starts selling a bucket the router does not use.
   */
  for (const plan of [PLANS.free, PLANS.starter, PLANS.growth, PLANS.scale]) {
    assert.ok(plan.tokens[FLASH] > 0, `${plan.label} must grant BUILD capacity — flash is what every turn runs on`);
    assert.equal(plan.tokens[PRO], 0, `${plan.label} sells pro, which the router never chooses and Roman removed`);
    assert.equal(plan.tokens[QWEN], 0, `${plan.label} sells qwen, which is internal-only and appears in no picker`);
  }
  /**
   * ⚠️ ZERO, NOT ABSENT. `plan-drift.test.ts` divides both by 1e6 to compare
   * against the console catalogue, and `undefined / 1e6` is NaN — dropping the
   * keys would break the guard rather than satisfy it.
   */
  assert.ok(PRO in PLANS.starter.tokens && QWEN in PLANS.starter.tokens,
    'the withdrawn buckets must stay present at 0 so the drift guard can still compare them');
});

test('⚠️ a plan granting ZERO of a model is "unavailable", not "exhausted"', () => {
  // Different words for different situations: one means upgrade, the other
  // means wait. Collapsing them tells a free user to come back next month for
  // something they were never going to get.
  const r = allowanceRemaining(PLANS.free, {});
  assert.equal(r[PRO].available, false, 'the free plan grants no pro');
  assert.equal(r[PRO].exhausted, true, 'zero granted with zero used is trivially exhausted…');
  assert.equal(r[FLASH].available, true, '…but flash is genuinely available');
  assert.equal(r[FLASH].remaining, PLANS.free.tokens[FLASH]);
});

test('⭐ allowance arithmetic never goes negative and reports exhaustion', () => {
  const used = { [FLASH]: PLANS.starter.tokens[FLASH] + 10_000_000, [PRO]: 1_000_000 };
  const r = allowanceRemaining(PLANS.starter, used);
  assert.equal(r[FLASH].remaining, 0, 'an overrun must clamp, not report a negative allowance');
  assert.equal(r[FLASH].exhausted, true);
  /**
   * ⚠️ THIS ASSERTED `r[PRO].exhausted === false` WHEN STARTER GRANTED 5M PRO.
   * Now it grants none, and 1M spent against a 0 grant is trivially past it —
   * which is why `available` is the field that carries the MEANING and
   * `exhausted` is only arithmetic. "Not on your plan" and "you used it all" are
   * different messages, and only one of them tells a user to wait for the reset.
   */
  assert.equal(r[PRO].available, false, 'pro is not on this plan at all — that is the fact worth reporting');
  assert.equal(r[PRO].remaining, 0);
});

test('⚠️ an unpriced model is NAMED, never silently costed at zero', () => {
  const weird = { ...PLANS.starter, tokens: { 'nobody/unknown-model': 50_000_000 } };
  const e = planEconomics(weird, 0.95);
  assert.deepEqual(e.unpriced, ['nobody/unknown-model']);
  assert.equal(e.cogsUsd, 0, 'it contributes nothing…');
  assert.ok(e.unpriced.length > 0, '…and the caller is told, so a 100% margin cannot be quoted from a gap');
});

/**
 * ── ⚠️⚠️ THIS ASSERTION WAS INVERTED ON 2026-08-25, AND WHY ─────────────────
 *
 * It used to require the OPPOSITE of what it now requires:
 *
 *     assert.match(text, /95% cache/);
 *     assert.match(text, /margin/);
 *     assert.match(text, /clears 80%/, 'the break-even is the most
 *                                       decision-useful line on the page');
 *
 * with the comment *"a margin quoted without a cache rate is a number somebody
 * chose"*. Every word of that reasoning is still correct — and it was answering
 * the wrong question. It asked whether the margin line was HONEST. Nobody asked
 * whether it should be on a CUSTOMER'S screen at all.
 *
 * ⚠️ `formatPlan` IS RENDERED BY `acuvo spend`, a documented no-flag command.
 * So "the most decision-useful line on the page" was decision-useful to US, and
 * printed to THEM: what a plan costs us to serve, and what we make on it. The
 * guard was holding the disclosure in place and calling it rigour.
 *
 * ⭐ The honest split: a user sees THEIR side — plan, price, allowance, and
 * (from `bin/acuvo.mjs`) how much of it they have spent. Our side renders only
 * under `ACUVO_PLAN_ECONOMICS=1`, and the test below proves the gate is shut by
 * default rather than merely present.
 */
test('⚠️⚠️ the customer view shows the ALLOWANCE and never what it costs us', () => {
  const text = formatPlan(PLANS.starter, 0.95).join('\n');

  // Their side of the deal — the whole reason the command exists.
  assert.match(text, /Starter/);
  assert.match(text, /\$29 AUD/, 'the price they pay');
  assert.match(text, /95M/, 'the allowance they get');

  // Ours. None of it.
  assert.doesNotMatch(text, /costs us/i);
  assert.doesNotMatch(text, /margin/i);
  assert.doesNotMatch(text, /COGS/i);
  assert.doesNotMatch(text, /clears 80%/, 'the break-even rate is a statement about our economics');
  assert.doesNotMatch(text, /% cache/, 'a cache rate on this screen only ever qualified a cost figure');

  /**
   * ⚠️ AND NOT THE UPSTREAM ID EITHER. It printed `deepseek/…` while the usage
   * lines four rows above it already said "Acuvo Flash" — the same fact in two
   * vocabularies, one of them somebody else's product name inside ours.
   */
  assert.doesNotMatch(text, /deepseek|qwen|z-ai/i, 'the model wears our name, per acuvo-models.mjs');
  assert.match(text, /Acuvo Flash/);
});

test('⭐ the economics view still exists, and only behind the env var', () => {
  const before = process.env[PLAN_ECONOMICS_ENV];
  try {
    process.env[PLAN_ECONOMICS_ENV] = '1';
    const text = formatPlan(PLANS.starter, 0.95).join('\n');
    // The reasoning of the original test, preserved where it belongs: an
    // internal cost figure is meaningless without the cache rate that produced it.
    assert.match(text, /95% cache/);
    assert.match(text, /internal/);
    // ⚡ 2026-09-28: on v4.1's card Starter never reaches 80% at any cache rate, and the view says so
    // in that line — which is the property: the break-even line is PRESENT, whichever way it reads.
    assert.match(text, /clears 80%|never reaches 80% margin/, 'the break-even is the most decision-useful line for PRICING');
  } finally {
    if (before === undefined) delete process.env[PLAN_ECONOMICS_ENV];
    else process.env[PLAN_ECONOMICS_ENV] = before;
  }
});

test('⚠️ the gate is shut for every value that is not exactly "1"', () => {
  const before = process.env[PLAN_ECONOMICS_ENV];
  try {
    // ⚠️ `0` AND `false` ARE THE ONES THAT MATTER. A truthiness check would have
    // treated both as ON — the classic way an off switch turns something on.
    for (const v of ['0', 'false', 'no', '', 'true', 'yes']) {
      process.env[PLAN_ECONOMICS_ENV] = v;
      assert.doesNotMatch(formatPlan(PLANS.starter, 0.95).join('\n'), /margin|costs us|% cache/i,
        `ACUVO_PLAN_ECONOMICS=${JSON.stringify(v)} must not open the gate`);
    }
  } finally {
    if (before === undefined) delete process.env[PLAN_ECONOMICS_ENV];
    else process.env[PLAN_ECONOMICS_ENV] = before;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ⭐⭐ THE LADDER — every allowance solved, never chosen
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ the shipped ladder does NOT earn a uniform margin, and that is recorded', () => {
  /**
   * A ladder whose margin drifts between tiers is one where somebody picked a
   * headline number and reverse-engineered the rest. Identical margins mean
   * every tier is the same business at a different size, so an upgrade never
   * costs us money — which is the property that lets us price the top tier
   * aggressively without modelling each one separately.
   */
  /**
   * ⚠️⚠️ THE DIRECTION REVERSED ON 2026-08-24 AND THE OLD ASSERTION IS NOW THE
   * WRONG WAY ROUND. It read `margins[i] <= margins[i-1]` — "margin must not
   * IMPROVE as the plan gets bigger, or the cheap tier is subsidising the
   * expensive one" — which was true of the three-bucket ladder. Under the
   * flash-only ladder the entry tier is the GENEROUS one:
   *
   *     tokens per revenue dollar   starter 5.08M · growth 3.16M · scale 3.16M
   *     margin @83% cache           starter 87.8% · growth 92.4% · scale 92.4%
   *
   * ⭐ AND THAT IS DELIBERATE RATHER THAN DRIFT. 95M is a POSITIONING number —
   * more coding tokens than $200 of Claude Max buys at list — while Growth and
   * Scale were sized against margin. Leaving the old assertion in place would
   * have failed a ladder that is correct, which is the failure mode a guard
   * pointed at a superseded decision always has.
   *
   * ⭐ SO THE GUARD MOVED TO WHAT IS ACTUALLY INTENDED: starter is the most
   * generous rung, and growth and scale hold the SAME shape as each other. It
   * goes red if someone quietly makes the entry tier stingy, or lets the two
   * upper rungs drift apart.
   */
  const perDollar = (p) => (p.tokens[FLASH] / 1e6) / p.priceUsd;
  assert.ok(perDollar(PLANS.starter) > perDollar(PLANS.growth),
    `starter (${perDollar(PLANS.starter).toFixed(2)}M/$) is meant to be the generous rung against growth (${perDollar(PLANS.growth).toFixed(2)}M/$)`);
  assert.ok(Math.abs(perDollar(PLANS.growth) - perDollar(PLANS.scale)) < 0.05,
    `growth (${perDollar(PLANS.growth).toFixed(2)}M/$) and scale (${perDollar(PLANS.scale).toFixed(2)}M/$) are sized against the same margin and must not drift apart`);

  /**
   * ⚠️ AND NO TIER MAY EARN MORE THAN THE ENTRY TIER *BY ACCIDENT*. The upper
   * rungs earning more is the recorded shape; the thing that must never happen
   * is a rung falling BELOW starter, which would mean the plan people upgrade
   * TO is the one we lose money on first.
   */
  const rungs = [PLANS.starter, PLANS.growth, PLANS.scale];
  for (const cache of [0.65, 0.85, 0.95]) {
    const margins = rungs.map((p) => planEconomics(p, cache).marginPct);
    for (let i = 1; i < margins.length; i += 1) {
      assert.ok(margins[i] >= margins[0] - 0.5,
        `${rungs[i].label} (${margins[i].toFixed(1)}%) earns LESS than ${rungs[0].label} (${margins[0].toFixed(1)}%) at ${cache * 100}% cache — an upgrade must not be the tier we lose on`);
    }
  }
});

test('⚠️⚠️ every paid tier survives a BAD cache month — sized at the conservative rate', () => {
  // The cache rate is the margin, so the plan is sized at a rate we can hold
  // and the good months are upside rather than the assumption.
  /**
   * ⚠️ UNMETERED PLANS ARE EXCLUDED, not assumed profitable. Enterprise has no
   * ceiling, so `marginPct` is null by design — an earlier version of this loop
   * crashed on it, which is a better outcome than the alternative: quietly
   * treating "unknowable" as "fine".
   */
  const metered = Object.values(PLANS)
    .filter((x) => x.priceUsd > 0 && planEconomics(x, 0.65).marginPct !== null);
  assert.ok(metered.length >= 3, 'the ladder should have at least three metered paid tiers');
  for (const p of metered) {
    const bad = planEconomics(p, 0.65);
    /**
     * ⚠️ 65%, NOT 78%. The invented three-bucket ladder cleared 78% everywhere;
     * this loop's job is only to prove every tier we actually sell stays above
     * water at a poor cache month, whatever the exact number turns out to be.
     */
    assert.ok(bad.profitUsd > 0, `${p.label} loses money at 65% cache`);
    assert.ok(bad.marginPct > 0, `${p.label} falls to ${bad.marginPct.toFixed(1)}% at 65% cache`);
  }
  /**
   * ── 🚨🚨 CORRECTED 2026-08-27/28: 11.9%/45.2%/45.1% WERE THE ROUTING DEFECT ─
   *
   * The figures this pinned since the 2026-08-16 restructure — Starter 11.9%,
   * Growth 45.2%, Scale 45.1% — were computed against `lib/rate-card.mjs`'s
   * "peak" row, which turned out to be Novita's price ($0.44 in / $1.32 out),
   * not DeepSeek's own list: `warm-provider.mjs` had silently locked onto a
   * reseller charging a 4x markup on cache reads. That is why 65% cache — the
   * DEFINITION of "a bad month" this test guards — used to look barely
   * survivable for Starter (11.9%) and merely adequate for the top two.
   *
   * ⭐ CORRECTED against the live OpenRouter endpoint feed, the pin now leads
   * with DeepInfra fp8 ($0.08/$0.18/$0.016) — the cheapest fp8 endpoint in the
   * pin list. The SAME 65% cache month now gives Starter **79.8%**, Growth
   * **87.5%** and Scale **87.5%**. Nothing about the plan or the cache rate
   * changed; the number we were costing it against was a defect.
   *
   * ⚠️ PINNED, NOT RELAXED. If these fall again, it means either the pin has
   * drifted onto a dearer provider or DeepSeek repriced — the same two things
   * that could always move this number — not that the floor was loosened.
   */
  /**
   * ⚡ RE-PINNED 2026-09-28 ON THE v4.1 CARD (was 79.8 / 87.5 / 87.5 on -0731). Uncapped at
   * 65% cache: Starter US$12.747 of $18.705 → 31.9%; Growth US$21.603 of $50.955 → 57.6%;
   * Scale US$54.477 of $128.355 → 57.6%. All still positive.
   *
   * ⭐ AND THE MARGIN AT THE CAP — what a month can actually cost — with the arithmetic:
   *     Starter 1 −  7.2580 /  18.705 = 61.2%
   *     Growth  1 − 12.3004 /  50.955 = 75.9%
   *     Scale   1 − 31.0184 / 128.355 = 75.8%
   */
  const pinned = { Starter: '31.9', Growth: '57.6', Scale: '57.6' };
  const atCap = { Starter: '61.2', Growth: '75.9', Scale: '75.8' };
  for (const p of metered) {
    const key = p.label.replace(/\s.*$/, '');
    const want = pinned[key] ?? pinned[p.label];
    if (!want) continue;
    assert.strictEqual(planEconomics(p, 0.65).marginPct.toFixed(1), want,
      `${p.label} at 65% cache moved — re-approve the allowance or the price, do not edit this number`);
    assert.ok(marginAtCapPct(p) > 0, `${p.label} margin at cap is not positive`);
    assert.strictEqual(marginAtCapPct(p).toFixed(1), atCap[key], `${p.label} margin at cap moved`);
  }
});

test('⭐ the ladder rises in the allowance THAT EXISTS, and price rises with it', () => {
  // An upgrade that does not give more is a downgrade somewhere, and somebody
  // will find it.
  /**
   * ⚠️ THIS LOOPED `Object.keys(tokens)` AND BROKE THE MOMENT TWO BUCKETS WENT
   * TO ZERO — it demanded `0 > 0` for pro and qwen on every rung. The intent was
   * "an upgrade gives you more", not "every key must climb", and a withdrawn
   * bucket is flat on purpose. The distinction matters: the test must still go
   * red if FLASH fails to climb, which is the case that would actually sell
   * somebody a worse plan for more money.
   */
  const rungs = [PLANS.starter, PLANS.growth, PLANS.scale];
  for (let i = 1; i < rungs.length; i += 1) {
    assert.ok(rungs[i].priceUsd > rungs[i - 1].priceUsd, `${rungs[i].label} is not dearer than ${rungs[i - 1].label}`);
    assert.ok(rungs[i].tokens[FLASH] > rungs[i - 1].tokens[FLASH],
      `${rungs[i].label} does not give more flash than ${rungs[i - 1].label} — the only bucket we sell`);
    for (const model of [PRO, QWEN]) {
      assert.equal(rungs[i].tokens[model], 0,
        `${rungs[i].label} grants ${model}, which no tier sells — a withdrawn bucket must stay withdrawn all the way up`);
    }
  }
});

test('⭐⭐ the entry tier headline is 95M BUILD tokens — back to the pin that was right', () => {
  /**
   * ── ⚠️⚠️ THE HEADLINE WENT DOWN, 152M → 95M, AND IT IS NOT A TRIM ──────────
   *
   * The original version of this test pinned `flash === 95_000_000` with the
   * reasoning: *"a positioning decision, not an arithmetic one — if a future
   * edit trims it to make a margin look better, that is a pricing conversation
   * rather than a refactor."* On 2026-08-16 it was loosened to `total >= 150M`
   * so the three-bucket ladder could pass. That loosening is what let a headline
   * grow by 60% on a routing assumption nobody had measured.
   *
   * ⭐ THE TOTAL WAS THE WRONG THING TO PIN. "How many tokens do I get" only
   * means something if the tokens are ones you can spend on what you came for.
   * 152M was 88M of an internal-only model (`internal: true`, in no picker,
   * reached in the CLI by `read_image` and `--refute` alone) plus 5M of a model
   * the router never selects. The number a buyer could actually spend building
   * was 59M — LESS than the 95M it had replaced.
   *
   * ⚠️ SO THIS IS THE PRICING CONVERSATION THE ORIGINAL PIN ASKED FOR, and the
   * conclusion is that the pin was right and the loosening was the mistake. The
   * assertion goes back to BUILD capacity, which is the only figure that cannot
   * be inflated by adding a bucket nothing routes to.
   */
  const t = PLANS.starter.tokens;
  assert.equal(t[FLASH], 95_000_000,
    'the entry tier headline is a positioning decision — moving it is a pricing conversation, not a refactor');
  assert.equal(t[FLASH], Object.values(t).reduce((a, b) => a + (b ?? 0), 0),
    'and every advertised token must be a BUILD token — a total larger than the flash grant means we are counting something the buyer cannot spend on code');
  assert.equal(PLANS.starter.priceLocal, 29);
  assert.equal(PLANS.starter.currency, 'AUD');
});

test('⚠️ the free tier is enough to FORM A JUDGEMENT, and costs us little', () => {
  // A free tier that runs out during evaluation is a marketing cost with none
  // of the marketing.
  /**
   * ── 🚨🚨 CORRECTED 2026-08-27/28: THE FREE TIER WAS NEVER 3.9x DEARER ───────
   *
   * v1 (pre-2026-08-16): 4M flash cost $0.09 at 85% cache.
   *
   * v2 (2026-08-16 → 08-27): re-priced to **$0.356** at the same 85%, and
   * cold (the honest rate for a first session) to **$1.79** — "1,000 free
   * users is $1,790/mo." That scare figure was `lib/rate-card.mjs`'s "peak"
   * row, which turned out to be Novita's price ($0.44 in / $1.32 out) rather
   * than DeepSeek's own list: `warm-provider.mjs` had silently locked onto a
   * reseller charging a 4x markup on cache reads.
   *
   * ⭐ CORRECTED against the live OpenRouter endpoint feed, the pin now leads
   * with DeepInfra fp8 ($0.08/$0.18/$0.016). The SAME 4M grant now costs
   * **$0.108** at 85% cache and **$0.32** stone cold — so **1,000 free users
   * cold is $320/mo**, not $1,790. Cheaper than even v1's pre-restructure
   * figure, because v1 also priced from a dearer, unpinned endpoint.
   *
   * ⚠️ 85% IS STILL THE WRONG RATE FOR THIS TIER. A free user's normal case is
   * a FIRST SESSION — 0% cache by construction — which is why both figures
   * stay pinned rather than only the cold one.
   *
   * ⛔ NOT RESIZED HERE. The grant (4M) is an advertised number and Roman's call.
   * Both figures are pinned so the bill is a test result rather than a surprise.
   */
  /**
   * ⚡ RE-PINNED 2026-09-28 ON THE v4.1 CARD (was $0.108 / $0.32 on -0731). Uncapped, 4M:
   *     85% cache  4 × (0.991 × (0.15 × 0.30 + 0.85 × 0.030) + 0.009 × 1.20) = US$0.323
   *     cold       4 × (0.991 × 0.30 + 0.009 × 1.20)                          = US$1.23
   * ⭐ BUT THE FREE CAP IS 4 × 0.0764 = US$0.3056, so a cold first session stops there —
   * 1,000 free users can cost at most US$305.60/mo, not US$1,232.
   */
  const e = planEconomics(PLANS.free, 0.85);
  assert.strictEqual(e.cogsUsd.toFixed(3), '0.323',
    `the free tier costs $${e.cogsUsd.toFixed(3)} at 85% cache — re-approve it, do not edit this number`);
  assert.strictEqual(SUPPLY_CAP_USD.free.toFixed(4), '0.3056');
  const cold = planEconomics(PLANS.free, 0);
  assert.strictEqual(cold.cogsUsd.toFixed(2), '1.23',
    `a free user's FIRST session is 0% cache and costs $${cold.cogsUsd.toFixed(2)} — 1,000 of them is $${(cold.cogsUsd * 1000).toFixed(0)}/mo`);
  assert.ok(PLANS.free.tokens[FLASH] >= 4_000_000, 'too small to judge the product by');
  assert.equal(PLANS.free.tokens['deepseek/deepseek-v4-pro-0813'], 0, 'pro is the metered one — it is not free');
});

test('⚠️⚠️ RE-INVERTED 2026-08-27/28: the pooled-multiplier structure is REFUTED BY THE PRICES AGAIN', () => {
  /**
   * The obvious alternative — one allowance, pro billed at Nx — dies on the
   * fact that N is not a constant. Asserted from the price table rather than
   * from the comment, so it stays true if the prices move.
   */
  /**
   * ── THREE GENERATIONS, AND THE FIRST ONE WAS RIGHT ─────────────────────────
   *
   * v1 (pre-2026-08-16): `hi > lo * 2` — N ranged 1.9x warm to 4.8x at a poor
   * cache, too wide to publish as one multiplier.
   *
   * v2 (2026-08-16 → 08-27): asserted the OPPOSITE — `hi < lo * 1.1` — because
   * the restructured card appeared to give pro and flash the same rate SHAPE,
   * "N stable at 3.00x–3.06x across every cache rate." 🚨 THAT STABILITY WAS
   * THE ROUTING DEFECT, NOT THE PRICE SHEET: `lib/rate-card.mjs`'s "peak" row
   * was Novita's price for FLASH while PRO sat on a different, unpinned
   * endpoint — two unrelated upstreams that happened to land close to a 3x
   * ratio of each other.
   *
   * ⭐ CORRECTED 2026-08-27/28, each model at its OWN pinned endpoint (FLASH →
   * DeepInfra fp8, PRO → DeepSeek direct), N is wide again — **8.31x cold
   * down to 3.45x at 95% cache**, wider than even v1's range — because the
   * two endpoints have genuinely different rate SHAPES: 8.25x on fresh input,
   * 11.0x on output, only 1.38x on a cache read. A single published
   * multiplier would be wrong at almost every cache rate, exactly v1's
   * original objection.
   *
   * ⭐⭐ AND THE TWO PRICE-INDEPENDENT REASONS NEVER MOVED:
   *   1. Roman, 2026-08-21: *"no Pro should ever be used"*, so there is nothing
   *      to pool it WITH. Every tier grants 0 pro tokens.
   *   2. `gateTokens` on the console reads exactly one field, so a pooled
   *      allowance with a multiplier is not enforceable by the code we have.
   *
   * So the conclusion never actually depended on which way the price argument
   * pointed — but a test that only carries the price argument the CURRENT card
   * happens to support is worth catching, which is why this is inverted for a
   * second time rather than left as v2.
   */
  const at = (c) => costPerMillion(PRO, c) / costPerMillion(FLASH, c);
  const lo = at(0.95), hi = at(0.65);
  /**
   * ⚡ 2026-09-28: flash moved to v4.1 (owner, every plan) and the band narrowed from >1.5x to
   * 2.11x–3.11x (1.47x). Still a 47% spread for one published multiplier, so the PRICE argument
   * stands, weaker; the two structural reasons below are what hold it regardless. Pinned as the
   * measured band rather than a loosened threshold, so the next card move is seen, not absorbed.
   */
  assert.strictEqual(`${lo.toFixed(2)}–${hi.toFixed(2)}`, '2.11–3.11',
    `N ranges ${lo.toFixed(2)}x–${hi.toFixed(2)}x across cache rates — re-read the card before re-pinning`);
  assert.ok(REJECTED_STRUCTURES.includes('pooled-with-multiplier'));
  assert.ok(REJECTED_STRUCTURES.includes('unlimited-flash'));
  // The two reasons that DO still hold regardless of price, pinned so the
  // rejection cannot be reopened on the strength of either argument alone.
  assert.strictEqual(PLANS.starter.tokens[PRO], 0, 'no tier grants pro — there is nothing to pool');
  assert.strictEqual(PLANS.scale.tokens[PRO], 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️⚠️ THE GATE — an allowance nothing enforces is a number on a pricing page
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ a model the plan does not include is REFUSED, with the tier that grants it', () => {
  /**
   * ⚠️ THE FIXTURE MOVED FROM PRO TO A MADE-UP MODEL, AND THE REASON MATTERS.
   * This used PRO on the free plan and asserted the message names an upgrade —
   * which worked while paid tiers granted pro. No tier grants it now, so PRO
   * exercises the "refused, and there is nowhere to go" path instead, and
   * asserting `/grants/` on it would be asserting that a tier we deleted exists.
   */
  const g = planGate({ plan: PLANS.free, model: FLASH, usedByModel: { [FLASH]: 4_000_000 } });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'exhausted');
  assert.match(g.message, /Acuvo Flash/, 'the refusal must use OUR name, not the vendor id');
  assert.match(g.message, /Starter grants 95M/, '"limit reached" is an obstacle; naming the tier that solves it is a decision');
});

test('⚠️⚠️ A WITHDRAWN MODEL IS REFUSED WITH NO UPGRADE INVENTED', () => {
  /**
   * ⭐ THE FAILURE THIS PREVENTS IS A HELPFUL LIE. `planGate` finds the upgrade
   * by searching the ladder for a tier granting MORE of this model; with pro
   * withdrawn everywhere the search correctly returns nothing, and the message
   * must simply stop rather than name a tier that would not help either.
   */
  const g = planGate({ plan: PLANS.starter, model: PRO });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'not-on-plan');
  assert.ok(!/grants/.test(g.message),
    `no tier sells pro, so no tier may be offered as the fix; got "${g.message}"`);
});

test('⚠️⚠️ an exhausted allowance stops the run and names the upgrade', () => {
  // ⚠️ 95M, not 59M — the fixture must be the SHIPPED grant, read from the plan
  // rather than typed, or this passes on a number we stopped selling.
  const g = planGate({ plan: PLANS.starter, model: FLASH, usedByModel: { [FLASH]: PLANS.starter.tokens[FLASH] } });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'exhausted');
  assert.equal(g.remaining, 0);
  /**
   * ⚠️ DERIVED, NOT PINNED. This read `/Growth grants 162M/` and the catalog
   * moved to 161M, so the guard failed correct code — the third stale-literal
   * fixture found in this file's neighbourhood. A number the catalog owns must
   * be read from the catalog, or the test is pinning last week's price list.
   */
  const grant = `${(PLANS.growth.tokens[FLASH] / 1e6).toFixed(0)}M`;
  assert.match(g.message, new RegExp(`Growth grants ${grant}`), 'the cheapest tier that actually helps');
});

test('⚠️⚠️ a run PROJECTED to cross the line is stopped BEFORE it spends', () => {
  /**
   * `budget.mjs` states the rule — "it never spends money to discover it had
   * none" — and it applies one layer up. Starting a run that cannot finish
   * spends the remainder and delivers nothing, the worst of both outcomes.
   */
  // ⚠️ Now expressed in FLASH, the only bucket sold. On PRO this would return
  // `not-on-plan` and never reach the projection logic at all.
  const g = planGate({
    plan: PLANS.starter,
    model: FLASH,
    usedByModel: { [FLASH]: PLANS.starter.tokens[FLASH] - 100_000 },
    projectedTokens: 200_000,
  });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'would-exceed');
  assert.ok(g.remaining > 0, 'there IS allowance left — it is just not enough for this run');
});

test('⭐ a run that fits is allowed, and reports what is left', () => {
  const g = planGate({ plan: PLANS.starter, model: FLASH, usedByModel: { [FLASH]: 1_000_000 }, projectedTokens: 50_000 });
  assert.equal(g.allowed, true);
  // Derived, not typed — 58_000_000 was the old 59M grant and would pin a
  // superseded ladder into a test that has nothing to do with pricing.
  assert.equal(g.remaining, PLANS.starter.tokens[FLASH] - 1_000_000);
  assert.equal(g.message, null, 'an allowed run must not print a warning');
});

test('⚠️ the top METERED tier points at Enterprise, which is unmetered', () => {
  /**
   * ⚠️ THIS TEST USED TO SAY "the top tier names no upgrade", which was true of
   * an invented four-rung ladder. The shipped one has Enterprise above Scale,
   * and Enterprise is UNMETERED — so there genuinely is somewhere to go, and
   * refusing to say so would be the unhelpful half of a helpful rule.
   */
  // ⚠️ In FLASH — the exhaustion path only exists for a bucket that is sold.
  const g = planGate({ plan: PLANS.scale, model: FLASH, usedByModel: { [FLASH]: PLANS.scale.tokens[FLASH] } });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'exhausted');
  assert.ok(!/grants/.test(g.message),
    'Enterprise is UNMETERED (null), not a bigger number, so it cannot be offered as "grants NM" — a null must never be formatted as an allowance');

  // And the unmetered tier itself never refuses.
  const top = planGate({ plan: PLANS.enterprise, model: FLASH, usedByModel: { [FLASH]: 9e12 } });
  assert.equal(top.allowed, true);
  assert.equal(top.reason, 'unmetered');
});

test('⚠️⚠️ usage counts the model that ANSWERED, and never treats a missing count as free', () => {
  /**
   * A run that fell back spent tokens on whichever model actually served it;
   * charging the requested one bills an allowance that was never touched. And a
   * record with no token count is UNKNOWN — silently free usage is how an
   * allowance stops meaning anything.
   */
  const { byModel, unknown } = usageByModel([
    { run: { model: { requested: PRO, answered: FLASH }, tokens: 1000 } },
    { run: { model: { requested: FLASH, answered: FLASH }, tokens: 500 } },
    { run: { model: { requested: FLASH, answered: null }, tokens: null } },
    { run: { tokens: 999 } },
  ]);
  assert.equal(byModel[FLASH], 1500, 'the answering model carries the cost');
  assert.equal(byModel[PRO], undefined, 'a model that answered nothing spent nothing');
  assert.equal(unknown, 2, 'records with no model or no count must be counted as unknown, not zero');
});
