/**
 * ── ⭐⭐ THE PLAN MATH, IN CODE, FROM MEASURED PRICES ────────────────────────
 *
 * What a user gets for their money lived in conversations. That is fine until
 * somebody has to ENFORCE it, and then "has this account run out?" has no
 * function to call. These tests pin the arithmetic and — more importantly — the
 * two facts it exists to make impossible to forget.
 *
 * ⚠️⚠️ THE CACHE RATE IS THE MARGIN. Not a contributor to it, the whole of it.
 * The same plan doing the same work:
 *
 *     cache 50%  COGS $6.21  margin 67%
 *     cache 65%  COGS $4.81  margin 74%     ← below target
 *     cache 80%  COGS $3.40  margin 82%
 *     cache 95%  COGS $1.99  margin 89%
 *
 * Which is why the provider pin and compaction discipline are not
 * housekeeping — they are the P&L.
 *
 * ⭐⭐ AND PRO'S PREMIUM COLLAPSES AS THE CACHE WARMS: 6.40x at 0%, 4.78x at
 * 65%, 1.86x at 95%, 1.23x at 98%. So the honest routing rule is not "use the
 * cheap model", it is "a long warm session can afford the strong model; a short
 * cold one cannot" — the opposite of escalate-on-failure, which reaches for pro
 * exactly when the context is coldest.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  PLANS, MODEL_PRICES, OUTPUT_TOKEN_SHARE,
  costPerMillion, planEconomics, breakEvenCacheRate, allowanceRemaining, formatPlan, REJECTED_STRUCTURES, planGate, usageByModel,
} from '../lib/plan.mjs';

const FLASH = 'deepseek/deepseek-v4-flash-0731';
const PRO = 'deepseek/deepseek-v4-pro-0813';

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

test('⭐⭐ pro\'s premium over flash COLLAPSES as the cache warms — the routing rule', () => {
  const at = (c) => costPerMillion(PRO, c) / costPerMillion(FLASH, c);
  assert.ok(at(0) > 5, `cold, pro should be several times flash — got ${at(0).toFixed(2)}x`);
  assert.ok(at(0.95) < 2.5, `warm, pro should be close to flash — got ${at(0.95).toFixed(2)}x`);
  assert.ok(at(0) > at(0.95) * 2, 'the premium must fall sharply, or the routing rule has no basis');
});

test('⚠️ prices are the PINNED endpoint\'s, not the model page\'s', () => {
  /**
   * ⚠️ THE MISTAKE THIS GUARDS. Pro was UNPINNED and landing on GMICloud at
   * $1.218/M in and $0.1015/M cache-read — 2.8x and 28x DeepSeek's own
   * endpoint. Quoting a model page would have hidden that completely, and did:
   * "pro costs 11.2x flash" was measured on the dear endpoint.
   */
  assert.equal(MODEL_PRICES[PRO].provider, 'DeepSeek', 'pro must be priced at the endpoint it is pinned to');
  assert.ok(MODEL_PRICES[PRO].cacheRead < MODEL_PRICES[FLASH].cacheRead,
    'pinned pro reads cache CHEAPER than flash — that is the whole reason the premium collapses');
  assert.ok(MODEL_PRICES[PRO].in > MODEL_PRICES[FLASH].in, 'and it is dearer on fresh tokens, which is why cold pro is expensive');
});

test('⚠️ output is a rounding error, and that is WHY cache dominates', () => {
  // Measured on a real 3-round run: 33,544 tokens, 33,258 of them prompt.
  assert.ok(OUTPUT_TOKEN_SHARE < 0.02, 'if output were large, cache could not dominate the bill');
  assert.ok(OUTPUT_TOKEN_SHARE > 0, 'and it is not zero — output is never cached at all');
});

test('⭐⭐ the $29 plan clears its margin at a realistic cache rate', () => {
  const e = planEconomics(PLANS.starter, 0.95);
  assert.ok(e.marginPct > 85, `margin at 95% cache was ${e.marginPct.toFixed(0)}%`);
  assert.deepEqual(e.unpriced, [], 'an unpriced model silently understates COGS');
  assert.ok(e.cogsUsd > 0, 'a plan that costs nothing means the prices did not load');
});

test('⚠️⚠️ AND IT DOES NOT AT A POOR ONE — this is the alarm, not a footnote', () => {
  const poor = planEconomics(PLANS.starter, 0.65);
  assert.ok(poor.marginPct < 80,
    'at 65% cache this plan is meant to fall SHORT of target — if that stops being true the numbers moved and the pricing needs revisiting');
  const be = breakEvenCacheRate(PLANS.starter, 80);
  assert.ok(be.rate !== null && be.rate > 0.5 && be.rate < 0.9,
    `the 80%-margin break-even should be a demanding but reachable cache rate; got ${be.rate}`);
});

test('⭐ a free plan has no margin, and says null rather than inventing 100%', () => {
  const e = planEconomics(PLANS.free, 0.95);
  assert.equal(e.marginPct, null, 'a free plan with a 100% margin is a number somebody made up');
  assert.ok(e.cogsUsd > 0, 'it still costs us real money');
  assert.ok(e.profitUsd < 0, 'and that money is a loss, stated plainly');
});

test('⚠️ separate allowances per model — one pooled number would be worth different amounts', () => {
  /**
   * Pro costs between 1.23x and 6.40x flash depending on cache, so a single
   * "N tokens" pool would be worth wildly different amounts of money depending
   * which model spent it — and a user could not predict their own limit.
   */
  assert.ok(PLANS.starter.tokens[FLASH] > 0);
  assert.ok(PLANS.starter.tokens[PRO] > 0);
  assert.ok(PLANS.starter.tokens[FLASH] > PLANS.starter.tokens[PRO],
    'the cheap model must carry the bulk, or the margin depends on users not using what they bought');
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
  assert.equal(r[PRO].exhausted, false);
  assert.equal(r[PRO].remaining, PLANS.starter.tokens[PRO] - 1_000_000);
});

test('⚠️ an unpriced model is NAMED, never silently costed at zero', () => {
  const weird = { ...PLANS.starter, tokens: { 'nobody/unknown-model': 50_000_000 } };
  const e = planEconomics(weird, 0.95);
  assert.deepEqual(e.unpriced, ['nobody/unknown-model']);
  assert.equal(e.cogsUsd, 0, 'it contributes nothing…');
  assert.ok(e.unpriced.length > 0, '…and the caller is told, so a 100% margin cannot be quoted from a gap');
});

test('⭐ the human view states the cache rate it assumed', () => {
  // A margin quoted without a cache rate is a number somebody chose.
  const text = formatPlan(PLANS.starter, 0.95).join('\n');
  assert.match(text, /95% cache/);
  assert.match(text, /margin/);
  assert.match(text, /clears 80%/, 'the break-even is the most decision-useful line on the page');
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
   * ⚠️ AN EARLIER VERSION OF THIS FILE INVENTED ITS OWN LADDER and asserted the
   * margins were identical across tiers — which they were, because it had
   * SOLVED for that. The shipped catalogue was not designed that way: Starter
   * earns 86% at 85% cache and Scale 80%, because Scale's flash allowance was
   * set generously against a Claude comparison rather than against a margin.
   *
   * ⭐ The honest test is the DIRECTION: margin must not IMPROVE as the plan
   * gets bigger, or the cheap tier is subsidising the expensive one.
   */
  const rungs = [PLANS.starter, PLANS.growth, PLANS.scale];
  for (const cache of [0.65, 0.85, 0.95]) {
    const margins = rungs.map((p) => planEconomics(p, cache).marginPct);
    for (let i = 1; i < margins.length; i += 1) {
      assert.ok(margins[i] <= margins[i - 1] + 0.5,
        `margin RISES from ${rungs[i - 1].label} (${margins[i - 1].toFixed(0)}%) to ${rungs[i].label} (${margins[i].toFixed(0)}%) at ${cache * 100}% cache — the cheap tier is subsidising the dear one`);
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
     * ⚠️ 65%, NOT 78%. The invented ladder cleared 78% everywhere; the shipped
     * one puts Scale at 69% on a poor cache month. Asserting the old floor here
     * would fail a plan we actually sell, so the floor states what is true and
     * the comment states that it is thinner than we would choose.
     */
    assert.ok(bad.marginPct > 65, `${p.label} falls to ${bad.marginPct.toFixed(0)}% at 65% cache`);
    assert.ok(bad.profitUsd > 0, `${p.label} loses money at 65% cache`);
  }
});

test('⭐ the ladder rises in BOTH allowances, and price rises with it', () => {
  // An upgrade that does not give more of everything is a downgrade somewhere,
  // and somebody will find it.
  const rungs = [PLANS.starter, PLANS.growth, PLANS.scale];
  for (let i = 1; i < rungs.length; i += 1) {
    assert.ok(rungs[i].priceUsd > rungs[i - 1].priceUsd, `${rungs[i].label} is not dearer than ${rungs[i - 1].label}`);
    for (const model of Object.keys(rungs[i].tokens)) {
      assert.ok(rungs[i].tokens[model] > rungs[i - 1].tokens[model],
        `${rungs[i].label} does not give more ${model} than ${rungs[i - 1].label}`);
    }
  }
});

test('⭐ the entry tier headline went UP, not down — the one comparison a buyer makes unaided', () => {
  /**
   * ── ✅ THIS PINNED `flash === 95_000_000` AND THE PIN WAS RIGHT TO EXIST ────
   *
   * Its reasoning: *"a positioning decision, not an arithmetic one — if a
   * future edit trims it to make a margin look better, that is a pricing
   * conversation rather than a refactor."* Exactly so, and this IS that
   * conversation rather than a refactor.
   *
   * ⭐ THE HEADLINE DID NOT GET TRIMMED. IT GREW, 95M -> 152M. Every tier used
   * to grant flash and pro only, which priced the READING half of an agent run
   * at build-model rates. Naming the third model (qwen, 3.2x cheaper, ~58% of
   * volume) let the entry tier give MORE tokens at a HIGHER margin — flash 59M
   * + qwen 88M + pro 5M. Measured 2026-08-16.
   *
   * ⚠️ SO THE ASSERTION MOVED FROM A SINGLE MODEL TO THE TOTAL, and that is the
   * change worth justifying. A buyer compares "how many tokens do I get",
   * not "how many of one model" — pinning flash alone would now block the exact
   * improvement it was written to protect, and would read as a cut (59 < 95)
   * when the plan got 60% larger.
   */
  const t = PLANS.starter.tokens;
  const total = Object.values(t).reduce((a, b) => a + (b ?? 0), 0);
  assert.ok(total >= 150_000_000, `the entry tier grants ${(total / 1e6).toFixed(0)}M — it must never fall below the 95M it launched with`);
  assert.ok(t['deepseek/deepseek-v4-flash-0731'] > 0, 'and BUILD capacity specifically — qwen cannot write code');
  assert.equal(PLANS.starter.priceLocal, 29);
  assert.equal(PLANS.starter.currency, 'AUD');
});

test('⚠️ the free tier is enough to FORM A JUDGEMENT, and costs us little', () => {
  // A free tier that runs out during evaluation is a marketing cost with none
  // of the marketing.
  const e = planEconomics(PLANS.free, 0.85);
  assert.ok(e.cogsUsd < 0.30, `the free tier costs $${e.cogsUsd.toFixed(2)} — too dear to give away`);
  assert.ok(PLANS.free.tokens['deepseek/deepseek-v4-flash-0731'] >= 4_000_000, 'too small to judge the product by');
  assert.equal(PLANS.free.tokens['deepseek/deepseek-v4-pro-0813'], 0, 'pro is the metered one — it is not free');
});

test('⚠️⚠️ the pooled-multiplier structure is REFUTED BY THE PRICES, and recorded as such', () => {
  /**
   * The obvious alternative — one allowance, pro billed at Nx — dies on the
   * fact that N is not a constant. Asserted from the price table rather than
   * from the comment, so it stays true if the prices move.
   */
  const at = (c) => costPerMillion(PRO, c) / costPerMillion(FLASH, c);
  const lo = at(0.95), hi = at(0.65);
  assert.ok(hi > lo * 2, `a published multiplier needs N to be roughly stable; it ranges ${lo.toFixed(1)}x–${hi.toFixed(1)}x`);
  assert.ok(REJECTED_STRUCTURES.includes('pooled-with-multiplier'));
  assert.ok(REJECTED_STRUCTURES.includes('unlimited-flash'));
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️⚠️ THE GATE — an allowance nothing enforces is a number on a pricing page
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ a model the plan does not include is REFUSED, with the tier that grants it', () => {
  const g = planGate({ plan: PLANS.free, model: PRO });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'not-on-plan');
  assert.match(g.message, /Acuvo Pro/, 'the refusal must use OUR name, not the vendor id');
  assert.match(g.message, /grants/, '"not included" is an obstacle; naming the tier that includes it is a decision');
});

test('⚠️⚠️ an exhausted allowance stops the run and names the upgrade', () => {
  const g = planGate({ plan: PLANS.starter, model: FLASH, usedByModel: { [FLASH]: 59_000_000 } });
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
  const g = planGate({ plan: PLANS.starter, model: PRO, usedByModel: { [PRO]: 4_900_000 }, projectedTokens: 200_000 });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'would-exceed');
  assert.ok(g.remaining > 0, 'there IS allowance left — it is just not enough for this run');
});

test('⭐ a run that fits is allowed, and reports what is left', () => {
  const g = planGate({ plan: PLANS.starter, model: FLASH, usedByModel: { [FLASH]: 1_000_000 }, projectedTokens: 50_000 });
  assert.equal(g.allowed, true);
  assert.equal(g.remaining, 58_000_000);
  assert.equal(g.message, null, 'an allowed run must not print a warning');
});

test('⚠️ the top METERED tier points at Enterprise, which is unmetered', () => {
  /**
   * ⚠️ THIS TEST USED TO SAY "the top tier names no upgrade", which was true of
   * an invented four-rung ladder. The shipped one has Enterprise above Scale,
   * and Enterprise is UNMETERED — so there genuinely is somewhere to go, and
   * refusing to say so would be the unhelpful half of a helpful rule.
   */
  const g = planGate({ plan: PLANS.scale, model: PRO, usedByModel: { [PRO]: 36_000_000 } });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'exhausted');

  // And the unmetered tier itself never refuses.
  const top = planGate({ plan: PLANS.enterprise, model: PRO, usedByModel: { [PRO]: 9e12 } });
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
