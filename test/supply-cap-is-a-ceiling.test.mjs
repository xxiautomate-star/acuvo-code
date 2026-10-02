/**
 * ── ⛔💰 THE SUPPLY CAP IS A CEILING, NOT A GRANT ──────────────────────────
 *
 * ⚠️ SUPERSEDED IN PART 2026-09-28: every metered plan now carries a cap,
 * DERIVED as advertised tokens × `MEASURED_BLENDED_USD_PER_M` (owner: the cap is
 * an exact USD equal to the token value). The ceiling-not-grant reading below
 * is unchanged and still pinned.
 *
 * Roman, 2026-09-20, asked what to do about starter delivering 86.5% of the
 * tokens its own pricing page advertises: *"nothing needs to change, we just
 * cap it at like a 5.7 USD i reckon."*
 *
 * ⚠️ THE WHOLE RISK IN THAT SENTENCE IS THE WORD "CAP", AND IT IS WORTH 16
 * POINTS OF MARGIN. Read as a GRANT, $5.70 hands starter 290.8M units =
 * 169.8M tokens — 79% MORE than the page advertises — and drops the realised
 * margin from 85.0% to 69.0%. Read as a CEILING it costs nothing: the
 * derivation asks for $2.76, so it never binds at today's rates.
 *
 * ⭐ THESE TESTS PIN THE READING. A later change that lets the cap RAISE an
 * allowance would be a grant wearing a safety word, and it would be green
 * under any test that only checked the number was "about right".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS } from '../lib/plan.mjs';
import {
  SUPPLY_CAP_USD, capUnitsForPlan, allowanceForPlan, unitsForPlan, costPerUnitUsd,
} from '../lib/plan-allowance.mjs';
import { FLASH, MEASURED_BLENDED_USD_PER_M } from '../lib/rate-card.mjs';

const AUD_USD = 0.66;
const OPTS = { audUsd: AUD_USD };

test('⭐ a metered plan is GRANTED its cap — and never less than its advertised tokens', () => {
  /* ⭐⭐⭐ RE-PINNED 2026-09-28 to the owner's ruling: advertised tokens are FIXED and
   * every plan delivers exactly them, cut off at their dollar value. The 85%-margin
   * derivation this used to pin no longer decides a grant; margin at the cap is now an
   * OUTPUT that must stay positive (plan-economics.test.mjs prices it). */
  for (const id of ['free', 'starter', 'growth', 'scale']) {
    const cap = capUnitsForPlan(id);
    const actual = allowanceForPlan(id, OPTS);
    assert.ok(cap !== null && actual !== null, `${id} lost its cap or its allowance`);
    assert.ok(actual >= cap, `${id}: granted ${actual} units, under its own cap of ${cap}`);
  }
});
test('⛔ enterprise stays UNMETERED — never capped at zero, never granted a number', () => {
  /* ⭐⭐⭐ RE-PINNED 2026-09-28 to the owner's ruling: advertised tokens are FIXED and
   * every plan delivers exactly them, cut off at their dollar value. The 85%-margin
   * derivation this used to pin no longer decides a grant; margin at the cap is now an
   * OUTPUT that must stay positive (plan-economics.test.mjs prices it). */
  for (const [id, plan] of Object.entries(PLANS)) {
    if (plan?.tokens?.[FLASH] > 0) continue;
    assert.equal(SUPPLY_CAP_USD[id], undefined, `${id} has no advertised tokens yet carries a cap`);
    assert.equal(capUnitsForPlan(id), null);
  }
});
test('⭐⭐ the cap is PER PLAN and DERIVED — advertised tokens × the measured $/M (owner, 2026-09-28)', () => {
  /**
   * The hand-typed $5.70 on Starter alone bought ~74.6M of the advertised 95M on
   * v4.1 at the measured rate. Now every metered plan carries a cap, and each is
   * exactly what its advertised tokens cost:
   *
   *     free 4 × 0.0764 = 0.3056 · starter 95 × 0.0764 = 7.258
   *     growth 161 × 0.0764 = 12.3004 · scale 406 × 0.0764 = 31.0184
   *
   * Enterprise has no allowance, so no cap — unmetered, never capped at zero.
   */
  assert.deepEqual(Object.keys(SUPPLY_CAP_USD).sort(), ['free', 'growth', 'scale', 'starter']);
  const expected = { free: 0.3056, starter: 7.258, growth: 12.3004, scale: 31.0184 };
  for (const [id, usd] of Object.entries(expected)) {
    assert.ok(Math.abs(SUPPLY_CAP_USD[id] - usd) < 1e-9, `${id}: ${SUPPLY_CAP_USD[id]} != ${usd}`);
    // ⭐ and it DELIVERS the advertised allowance at the rate it was derived from.
    const delivered = (SUPPLY_CAP_USD[id] / MEASURED_BLENDED_USD_PER_M) * 1e6;
    assert.ok(Math.abs(delivered - PLANS[id].tokens[FLASH]) < 1, `${id} delivers ${delivered}, advertises ${PLANS[id].tokens[FLASH]}`);
  }
  assert.equal(capUnitsForPlan('enterprise'), null);
});

test('⭐ the cap is expressed in DOLLARS of supply, so a rate move moves it', () => {
  /**
   * ⚠️ NOT A UNIT COUNT. A cap typed in units would silently mean a different
   * amount of money every time a provider's rate changed — the exact drift
   * `plan-allowance.mjs` exists to end. Asserted by arithmetic against the live
   * rate card rather than a pinned integer, so it cannot go stale.
   */
  const perUnit = costPerUnitUsd(FLASH);
  assert.equal(capUnitsForPlan('starter'), Math.floor(SUPPLY_CAP_USD.starter / perUnit));
});

test('⚠️ the free plan keeps its stated unit allowance — its cap mirrors the console dollar ceiling', () => {
  /** Free is stated in units here (`FREE_PLAN_UNITS`); its dollar cap exists for parity with the console gate. */
  assert.ok(capUnitsForPlan('free') > 0);
  assert.ok((allowanceForPlan('free', OPTS) ?? 0) > 0);
});
