/**
 * ── ⭐⭐⭐ THE MARGIN IS THE INPUT AND THE TOKENS ARE THE OUTPUT ──────────────
 *
 * Roman: *"the economics and pricing shit has fucked us and the real ones need
 * to be unforgettable."*
 *
 * Six different "worst cases" were quoted before this — 58%, 2.5%, 68.1%, 47.5%,
 * 5.6%, 85% — and `ECONOMICS-SETTLED.md` §1 records why: every one of them
 * PICKED A TOKEN COUNT AND ASKED WHAT MARGIN IT PRODUCED. Under a raw-token
 * allowance the answer depends on a mix nobody controls, so the question has no
 * single answer and each attempt produced a different one.
 *
 * ⭐ THE INVERSION IS THE FIX. Fix the margin; the token count is a consequence
 * you can publish. These tests exist to keep that direction, because the moment
 * a number is typed rather than derived it can go stale — which is exactly how a
 * routing defect got recorded as a list price and cost us 7x for eleven days.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  unitsForPlan, allowanceForPlan, netRevenueUsd, costPerUnitUsd,
  TARGET_MARGIN, FREE_PLAN_UNITS, SUPPLY_CAP_USD,
} from '../lib/plan-allowance.mjs';
import { PLANS, AUD_USD } from '../lib/plan.mjs';
import { RATE_CARD, FLASH } from '../lib/rate-card.mjs';
import { typicalTokensFrom } from '../lib/cost-units.mjs';

const OPTS = { audUsd: AUD_USD };

test('MUTATION PROOF — the real plans and a real unit cost are in play', () => {
  assert.ok(Object.keys(PLANS).length >= 4);
  assert.ok(costPerUnitUsd() > 0 && costPerUnitUsd() < 1e-6, 'a unit should be a tiny fraction of a dollar');
});

test('⭐⭐ EVERY PAID PLAN keeps a POSITIVE margin at its full grant, priced on the dearest pinned provider', () => {
  /* ⭐⭐⭐ RE-PINNED 2026-09-28 to the owner's ruling: advertised tokens are FIXED and
   * every plan delivers exactly them, cut off at their dollar value. The 85%-margin
   * derivation this used to pin no longer decides a grant; margin at the cap is now an
   * OUTPUT that must stay positive (plan-economics.test.mjs prices it). */
  for (const [id, plan] of Object.entries(PLANS)) {
    const units = allowanceForPlan(id, OPTS);
    if (units === null) continue;
    const net = netRevenueUsd(plan, AUD_USD);
    if (net <= 0) continue;
    const margin = (net - units * costPerUnitUsd()) / net;
    assert.ok(margin > 0.5, `${id}: margin at its full grant is ${(margin * 100).toFixed(1)}% — the promise now costs more than half of what we keep`);
  }
});
test('⭐ Starter delivers EXACTLY the 95M its page advertises — the token count is the input now', () => {
  /* ⭐⭐⭐ RE-PINNED 2026-09-28 to the owner's ruling: advertised tokens are FIXED and
   * every plan delivers exactly them, cut off at their dollar value. The 85%-margin
   * derivation this used to pin no longer decides a grant; margin at the cap is now an
   * OUTPUT that must stay positive (plan-economics.test.mjs prices it). */
  const units = allowanceForPlan('starter', OPTS);
  const delivered = typicalTokensFrom(units);
  const promised = PLANS.starter.tokens[FLASH];
  assert.ok(delivered >= promised, `starter delivers ${(delivered / 1e6).toFixed(1)}M of ${promised / 1e6}M`);
  assert.ok(delivered < promised * 1.01, `starter over-delivers ${(delivered / 1e6).toFixed(1)}M — the grant is no longer tied to the promise`);
});
test('⚠️ the allowance is NET of fees and FX, not the sticker price', () => {
  // A$29 is not $29. Granting against the sticker overstates every allowance by
  // roughly a third and quietly eats the margin this module protects.
  const net = netRevenueUsd(PLANS.starter, AUD_USD);
  assert.ok(net < 29 * AUD_USD, 'fees were not deducted');
  assert.ok(net > 29 * AUD_USD * 0.9, 'too much was deducted — check the fee model');
});

test('⚠️ a cheaper provider RAISES the allowance, it does not raise the margin', () => {
  /**
   * The direction that matters commercially. If a rate falls, the customer gets
   * more tokens for the same 85% — the efficiency work becomes THEIR benefit,
   * which is the standing doctrine ("efficiency is the win-win"). A version that
   * banked the saving as extra margin would be a different product.
   */
  /**
   * ── ⚠️⚠️ THE FIXTURE WAS THE BUG, NOT THE CODE (found 2026-09-20) ──────────
   *
   * `cheapModel` was typed as `{ 0.04 / 0.008 / 0.09 }` and the comment called it
   * "half the price". It was half of the DeepInfra card — $0.016 cache read — so
   * the moment the ceiling moved to Makora's $0.0196 the fixture was 0.41x, not
   * 0.5x, and the assertion that a HALVING doubles the allowance failed on a
   * fixture that no longer halved anything. `feedback_a_global_assertion_on_an_
   * unchecked_fixture` is this exact shape: three red tests, all fixtures.
   *
   * ⚠️⚠️ AND THE OBVIOUS REPAIR — derive the cheap card as `perUnitDear / 2` —
   * IS A GUARD THAT CHECKS NOTHING. `expected` then reduces to `floor(dear * 2)`
   * and the assertion compares it to `dear * 2`: arithmetic agreeing with itself,
   * green forever, `unitsForPlan` never called with a cheaper card at all. (The
   * original had a weaker version of the same flaw — it only ever asserted that
   * its own fixture was half, never that the allowance moved.) I wrote that
   * version first and it passed; it is recorded here because it is the shape
   * `feedback_a_guards_universe_matters_as_much_as_its_assertion` warns about.
   *
   * ⭐ SO IT EXERCISES THE FUNCTION ACROSS REAL CARD ROWS INSTEAD. Every row in
   * `RATE_CARD` is a real provider at a real price; the claim is that a cheaper
   * one buys MORE units at the SAME margin, and that is what is asserted.
   */
  const rows = Object.keys(RATE_CARD)
    .map((model) => ({ model, perUnit: costPerUnitUsd(model), units: unitsForPlan(PLANS.starter, { ...OPTS, model }) }))
    .filter((r) => r.perUnit > 0 && r.units > 0)
    .sort((a, b) => a.perUnit - b.perUnit);
  assert.ok(rows.length >= 2, 'the card must hold at least two priced models for this to say anything');

  const net = netRevenueUsd(PLANS.starter, AUD_USD);
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i].units < rows[i - 1].units,
      `${rows[i].model} costs more per unit than ${rows[i - 1].model} but did not grant fewer units`);
  }
  // Halving the unit cost doubles the units — checked between the real extremes.
  const [cheapest] = rows;
  const dearest = rows[rows.length - 1];
  const ratio = (cheapest.units / dearest.units) / (dearest.perUnit / cheapest.perUnit);
  assert.ok(Math.abs(ratio - 1) < 0.01,
    `units should scale exactly inversely with unit price — got ${ratio.toFixed(4)}x of that`);
  // ⭐ AND THE MARGIN DOES NOT MOVE. That is the half that makes it the customer's win.
  for (const r of rows) {
    const margin = (net - r.units * r.perUnit) / net;
    assert.ok(Math.abs(margin - TARGET_MARGIN) < 0.001,
      `${r.model} realised ${(margin * 100).toFixed(2)}% margin — a cheaper provider must not raise it`);
  }
});

test('⚠️ null, never zero, for the cases with no ceiling to compute', () => {
  // Zero would refuse every round — a guardrail becoming an outage, the rule
  // `allowanceFrom` and `fal-spend-cap` already both follow.
  assert.strictEqual(unitsForPlan(null, OPTS), null);
  assert.strictEqual(unitsForPlan(PLANS.starter, { audUsd: 0 }), null);
  assert.strictEqual(unitsForPlan(PLANS.starter, { ...OPTS, targetMargin: 1 }), null);
  assert.strictEqual(unitsForPlan(PLANS.starter, { ...OPTS, targetMargin: 0 }), null);
  assert.strictEqual(allowanceForPlan('does-not-exist', OPTS), null);
});

test('⭐ the FREE plan delivers its advertised 4M, and costs at most its cap on the dearest provider (+15%)', () => {
  /* ⭐⭐⭐ RE-PINNED 2026-09-28 to the owner's ruling: advertised tokens are FIXED and
   * every plan delivers exactly them, cut off at their dollar value. The 85%-margin
   * derivation this used to pin no longer decides a grant; margin at the cap is now an
   * OUTPUT that must stay positive (plan-economics.test.mjs prices it). */
  const units = allowanceForPlan('free', OPTS);
  assert.ok(typicalTokensFrom(units) >= PLANS.free.tokens[FLASH], 'free no longer delivers its advertised tokens');
  const worst = units * costPerUnitUsd();
  assert.ok(worst <= SUPPLY_CAP_USD.free * 1.15,
    `a free account can cost us $${worst.toFixed(4)} on the dearest provider, >15% over its $${SUPPLY_CAP_USD.free} cap`);
});
test('⚠️ the ladder is monotonic — a dearer plan never buys less', () => {
  const paid = ['starter', 'growth', 'scale'].map((id) => allowanceForPlan(id, OPTS));
  for (let i = 1; i < paid.length; i += 1) {
    assert.ok(paid[i] > paid[i - 1], 'a more expensive plan grants fewer units');
  }
});

/**
 * ── ⭐⭐ AND THE METER MUST ACTUALLY TAKE IT ─────────────────────────────────
 *
 * `unitsForPlan` being correct proves nothing about the gate using it. That gap
 * is where this repo's most expensive defects live: `unitAllowance` was READ
 * once and SET nowhere while forty unit tests stayed green, and the R2 spend
 * ceiling was mutation-proven and called by nothing.
 */
test('⭐⭐ the plan REACHES allowanceFrom, ahead of the env var', async () => {
  const { allowanceFrom } = await import('../lib/cost-units.mjs');
  const { allowanceForPlan: forPlan } = await import('../lib/plan-allowance.mjs');
  const { AUD_USD } = await import('../lib/plan.mjs');

  const granted = allowanceFrom(
    { ACUVO_UNIT_ALLOWANCE: '7' },
    { planId: 'starter', audUsd: AUD_USD, allowanceForPlan: forPlan },
  );
  // ⚡ Was `> 100e6`, a size proxy for "the plan won". On v4.1's card (2026-09-28, every plan) a
  // unit costs more, so Starter derives 89.8M units and the proxy fired on a correct path. The
  // property itself is asserted instead: the value IS the plan's derived allowance, not the env's 7.
  assert.strictEqual(granted, forPlan('starter', { audUsd: AUD_USD }), `the plan did not win over the env var — got ${granted}`);
  assert.ok(granted > 1e6);

  // ⚠️ And with no plan the env var still works: it is how a support session or
  // a test pins a tiny allowance without inventing a plan.
  assert.strictEqual(allowanceFrom({ ACUVO_UNIT_ALLOWANCE: '7' }, {}), 7);
});

test('⚠️ an explicit override still beats the plan', () => {
  // The escape hatch has to stay ahead of everything, or an incident cannot be
  // handled without a deploy.
  return import('../lib/cost-units.mjs').then(async ({ allowanceFrom }) => {
    const { allowanceForPlan: forPlan } = await import('../lib/plan-allowance.mjs');
    const { AUD_USD } = await import('../lib/plan.mjs');
    const granted = allowanceFrom({}, {
      unitAllowance: 42, planId: 'scale', audUsd: AUD_USD, allowanceForPlan: forPlan,
    });
    assert.strictEqual(granted, 42);
  });
});

test('⚠️ an unknown plan falls through rather than refusing everything', async () => {
  const { allowanceFrom } = await import('../lib/cost-units.mjs');
  const { allowanceForPlan: forPlan } = await import('../lib/plan-allowance.mjs');
  // A typo in a plan id must not resolve to 0 and refuse every round — the same
  // rule the unparseable-env-var branch already follows.
  assert.strictEqual(allowanceFrom({}, { planId: 'nonsense', allowanceForPlan: forPlan }), null);
});

/**
 * ── ⚠️⚠️⭐ THE REACH TESTS. I SHIPPED THIS DARK ONCE ALREADY ─────────────────
 *
 * `allowanceFrom` learned to take a plan and its only caller, `processMeter()`,
 * passed nothing — so the derived ladder was correct, tested, mutation-proven
 * and reached by nobody, committed within an hour of my describing that exact
 * defect in someone else's code. These assert the PATH, not the arithmetic.
 */
test('⭐⭐ processMeter resolves a plan into a real ceiling', async () => {
  const cu = await import('../lib/cost-units.mjs');
  const { allowanceForPlan: forPlan } = await import('../lib/plan-allowance.mjs');
  const { AUD_USD: rate } = await import('../lib/plan.mjs');

  // ⚠️ processMeter memoises one instance per process, so the reach is asserted
  // through the function it delegates to rather than by calling it twice.
  const granted = cu.allowanceFrom(
    { ACUVO_PLAN: 'starter' },
    { planId: 'starter', audUsd: rate, allowanceForPlan: forPlan },
  );
  // ⚡ same restatement as above (v4.1 card, 2026-09-28): the plan's own derived ceiling, exactly.
  assert.strictEqual(granted, forPlan('starter', { audUsd: rate }), `a starter plan produced no ceiling (${granted})`);
  assert.ok(granted > 1e6);
});

test('⚠️ the CLI entry PASSES the deps — without them the plan cannot resolve', () => {
  const src = readFileSync(new URL('../bin/acuvo.mjs', import.meta.url), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
  const call = /processMeter\([^)]*\)/.exec(code)?.[0] ?? '';
  assert.ok(call.includes('readAccount'), `processMeter is called without readAccount: ${call}`);
  assert.ok(call.includes('allowanceForPlan'), `processMeter is called without allowanceForPlan: ${call}`);
  // ⚠️ A bare `processMeter()` is the exact shape that shipped dark.
  assert.notStrictEqual(call, 'processMeter()');
});

test('⚠️ planFromAccount never throws, whatever the credentials file holds', async () => {
  const { planFromAccount } = await import('../lib/cost-units.mjs');
  // A malformed or missing account must not stop a build — the meter is
  // bookkeeping, and bookkeeping may never fail the customer's work.
  assert.strictEqual(planFromAccount({}, {}), '');
  assert.strictEqual(planFromAccount({}, { readAccount: () => { throw new Error('bad json'); } }), '');
  assert.strictEqual(planFromAccount({}, { readAccount: () => null }), '');
  assert.strictEqual(planFromAccount({}, { readAccount: () => ({ plan: 'starter' }) }), 'starter');
});

test('⭐ ACUVO_PLAN beats the stored account, so a ceiling can be pinned in support', async () => {
  const { planFromAccount } = await import('../lib/cost-units.mjs');
  // processMeter checks the env FIRST; this pins the account half of that pair.
  assert.strictEqual(planFromAccount({}, { readAccount: () => ({ plan: 'scale' }) }), 'scale');
});
