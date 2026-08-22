/**
 * ── ⚠️⚠️ THE PROJECTION KNEW NOTHING ABOUT WHICH MODEL IT WAS PROJECTING ────
 *
 * `projectTierCost` scaled by TIER EFFORT alone — 1x solo, 1.4x fresh, 3x
 * best-of — and the ladder switches MODEL between rungs. So rung 1 measured
 * flash at $0.0015, rung 2 switched to pro, and the projection said $0.0021
 * when pro really costs ~$0.0134 for a single cold round. Wrong by ~8x, in
 * exactly the case the model switch exists for.
 *
 * The consequence is not a bad estimate, it is a WASTED ROUND: the ladder
 * entered a rung it could not afford, spent real money, and stopped with
 * nothing to show. Measured on our own 13-task bench, 2026-08-15:
 *
 *   flash  12/13  $0.0146   `stopping on budget` 0 times
 *   pro     5/13  $0.1639   `stopping on budget` 5 times
 *
 * Every pro FAILURE was 1 round at 0% cache; every pro PASS had a warm cache.
 * 5/13 is a budget artifact, not a capability result.
 *
 * ⚠️ AND THE RATIOS ARE MEASURED, NOT LIST PRICES. OpenRouter list makes pro
 * look 3.1x flash; the real ratio on our workload is 11.2x, because we PIN
 * StreamLake for flash (measured $0.080/M against a $0.140 headline) while pro
 * was served at list. A list-price table would understate the gap by ~3x — the
 * same class of error as no table at all, wearing a citation.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  projectTierCost, modelCostRatio, MODEL_COST_INDEX, UNKNOWN_MODEL_MULTIPLIER,
  FRESH_MULTIPLIER, MIN_PROJECTION_USD,
} from '../lib/escalate.mjs';

const FLASH = 'deepseek/deepseek-v4-flash-0731';
const PRO = 'deepseek/deepseek-v4-pro-0813';

test('⚠️⚠️ THE BUG: a rung that switches to pro must not be priced as if it were flash', () => {
  const blind = projectTierCost('fresh', { lastAttemptUsd: 0.0015 });
  const priced = projectTierCost('fresh', { lastAttemptUsd: 0.0015, fromModel: FLASH, toModel: PRO });

  assert.ok(priced > blind * 5, `the model term did nothing: blind $${blind.toFixed(4)} vs priced $${priced.toFixed(4)}`);
  /**
   * ⭐ THE NUMBER THAT DECIDES THE BEHAVIOUR. The default ceiling is $0.02.
   * The blind projection ($0.0021) waved the rung through and it died after one
   * round; the priced one must exceed the ceiling so the rung is SKIPPED with a
   * reason instead.
   */
  assert.ok(blind < 0.02, 'the old projection fitted under the default ceiling — that is how the rung got entered');
  assert.ok(priced > 0.02, 'the corrected projection must not fit under the default ceiling either');
});

test('⭐ a rung that does NOT switch model is unchanged — this is not a general price rise', () => {
  // Every existing caller and every existing test must see exactly what it saw.
  for (const tier of ['solo', 'fresh', 'best-of']) {
    const before = projectTierCost(tier, { lastAttemptUsd: 0.002 });
    const same = projectTierCost(tier, { lastAttemptUsd: 0.002, fromModel: FLASH, toModel: FLASH });
    const none = projectTierCost(tier, { lastAttemptUsd: 0.002, fromModel: FLASH, toModel: null });
    assert.equal(same, before, `${tier}: same model changed the projection`);
    assert.equal(none, before, `${tier}: a missing model changed the projection`);
  }
});

test('⭐ the tier multipliers still apply ON TOP of the model ratio', () => {
  const solo = projectTierCost('solo', { lastAttemptUsd: 0.001, fromModel: FLASH, toModel: PRO });
  const fresh = projectTierCost('fresh', { lastAttemptUsd: 0.001, fromModel: FLASH, toModel: PRO });
  const best = projectTierCost('best-of', { lastAttemptUsd: 0.001, attempts: 3, fromModel: FLASH, toModel: PRO });

  assert.ok(Math.abs(fresh / solo - FRESH_MULTIPLIER) < 1e-9, 'the fresh multiplier was lost');
  assert.ok(Math.abs(best / solo - 3) < 1e-9, 'the best-of attempt count was lost');
});

test('⚠️⚠️ an UNKNOWN model is assumed DEARER, never equal', () => {
  /**
   * Assuming parity is exactly what the old code did implicitly, and it is the
   * assumption that let a rung enter a budget it could not afford. Guessing
   * high costs a skipped rung and a printed reason; guessing low costs a wasted
   * round that produces nothing.
   */
  const r = modelCostRatio(FLASH, 'somebody/brand-new-model');
  assert.equal(r.known, false);
  assert.equal(r.ratio, UNKNOWN_MODEL_MULTIPLIER);
  assert.ok(r.ratio > 1, 'an unknown model priced at parity is the original bug');
});

test('⭐ a CHEAPER model is allowed to lower the projection — the ratio is not one-way', () => {
  // qwen is measured at 0.54x flash. A rung that moves DOWN in price must be
  // easier to afford, or the ladder would refuse the cheap direction too.
  const down = modelCostRatio(FLASH, 'qwen/qwen3.7-flash');
  assert.equal(down.known, true);
  assert.ok(down.ratio < 1, 'qwen measured cheaper than flash and the ratio says otherwise');
  assert.ok(
    projectTierCost('solo', { lastAttemptUsd: 0.001, fromModel: FLASH, toModel: 'qwen/qwen3.7-flash' })
    < projectTierCost('solo', { lastAttemptUsd: 0.001 }),
  );
});

test('⚠️ the index is MEASURED — flash is the unit, and pro carries the bench ratio', () => {
  /**
   * Pinned so a future edit has to argue with a measurement. 11.2 is
   * $0.1639/$0.0146 from the 13-task bench; 0.54 is $0.000490/$0.000909 from
   * the reviewer A/B on an identical claim.
   */
  assert.equal(MODEL_COST_INDEX[FLASH], 1, 'flash is the unit the others are expressed in');
  assert.equal(MODEL_COST_INDEX[PRO], 11.2, 'the bench measured $0.1639 vs $0.0146');
  assert.equal(MODEL_COST_INDEX['qwen/qwen3.7-flash'], 0.54);
  /**
   * ⚠️ AND IT MUST NOT BE THE LIST-PRICE RATIO. (0.435+0.870)/(0.140+0.280) is
   * 3.1x. If somebody "corrects" this table from a price page, this assertion
   * is what tells them the pinned provider makes the real number very different.
   */
  assert.ok(MODEL_COST_INDEX[PRO] > 5, 'this looks like the list-price ratio (3.1x), not the measured one');
});

test('⚠️ the floor still applies when the last attempt cost nothing', () => {
  // A first attempt can legitimately cost ~$0 on a cache hit; a projection of
  // zero would wave through a rung the budget cannot pay for.
  const p = projectTierCost('solo', { lastAttemptUsd: 0, fromModel: FLASH, toModel: PRO });
  assert.ok(p >= MIN_PROJECTION_USD, 'the floor was lost when the model term was added');
  assert.ok(p > 0);
});

test('⚠️ a same-model ratio is 1 exactly, including when the model is unknown to the index', () => {
  // Two runs on a model we have never benchmarked must not be inflated by 4x
  // just because it is absent from the table — nothing is changing.
  const r = modelCostRatio('mystery/model-x', 'mystery/model-x');
  assert.equal(r.ratio, 1);
  assert.equal(r.known, true);
});
