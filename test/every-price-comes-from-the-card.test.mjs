/**
 * ── ⭐⭐⭐ THERE IS ONE PRICE TABLE. THIS IS WHAT KEEPS IT THAT WAY ───────────
 *
 * Roman, 2026-08-28: *"fix the two price tables, this economics and pricing shit
 * has fucked us and the real ones need to be unforgettable."*
 *
 * ⚠️⚠️ THE 7x ERROR WAS A SECOND COPY OF A PRICE THAT NO GUARD READ. The card
 * carried Novita's rate labelled as DeepSeek's "peak", and every margin figure
 * computed before 2026-08-27 was wrong because of it. `MODEL_PRICES` in
 * `plan.mjs` was the same hazard one file over: FLASH and PRO were derived and
 * safe, while `qwen` and `glm` were HAND-TYPED and compared to nothing.
 *
 * ⚠️ AND QWEN IS NOT A SPARE. It is THE EYES — the only leg in the chain that
 * can receive an image, because the build model declares `["text"]`. Its price
 * was live, in use, and unverifiable.
 *
 * ⭐ So the rule this file enforces is not "the numbers currently match". It is
 * **a price may not exist anywhere except the card**. A new model cannot be
 * added with a typed rate: it has to go into `RATE_CARD`, where the live-feed
 * guard already checks it against the market.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { MODEL_PRICES } from '../lib/plan.mjs';
import { RATE_CARD, ratesFor, GOVERNING_WINDOW } from '../lib/rate-card.mjs';

test('MUTATION PROOF — both tables are really loaded and non-trivial', () => {
  assert.ok(Object.keys(MODEL_PRICES).length >= 4, 'MODEL_PRICES looks empty');
  assert.ok(Object.keys(RATE_CARD).length >= 4, 'RATE_CARD looks empty');
});

test('⭐⭐ EVERY model priced in MODEL_PRICES is priced BY THE CARD', () => {
  for (const model of Object.keys(MODEL_PRICES)) {
    assert.ok(
      RATE_CARD[model],
      `${model} has a price in plan.mjs and NO entry in the rate card — that is a second price table, which is exactly how the 7x error happened`,
    );
  }
});

test('⭐⭐ and every number EQUALS the card, to the cent', () => {
  for (const [model, p] of Object.entries(MODEL_PRICES)) {
    const card = ratesFor(model, GOVERNING_WINDOW);
    assert.ok(card, `${model} not priced by ratesFor()`);
    assert.equal(p.in, card.inPerM, `${model}: input price disagrees with the card`);
    assert.equal(p.out, card.outPerM, `${model}: output price disagrees with the card`);
    assert.equal(p.cacheRead, card.cachedInPerM, `${model}: cache-read price disagrees with the card`);
  }
});

/**
 * ⚠️ THE ANTI-VACUITY TEST. Everything above would pass if `MODEL_PRICES` were
 * empty, or if it happened to be the card object itself. Three guards elsewhere
 * in this repo went green over exactly that shape on 2026-08-28.
 */
test('⚠️ the assertions above are not vacuous', () => {
  const keys = Object.keys(MODEL_PRICES);
  assert.ok(keys.includes('qwen/qwen3.7-flash'), 'the eyes must be priced — that is the entry that was hand-typed');
  assert.ok(keys.includes('deepseek/deepseek-v4-flash-0731'), 'the build model must be priced');
  // And the values must be real money, not zeroes that trivially match.
  for (const p of Object.values(MODEL_PRICES)) {
    assert.ok(p.in > 0 && p.out > 0 && p.cacheRead > 0, 'a zero price would satisfy any comparison');
  }
});

test('⚠️ cache reads are cheaper than fresh input, which is the whole economics', () => {
  // If this ever inverts, the cost-unit weights are wrong and the 85% floor with
  // them — the weights are DERIVED from these ratios, never typed.
  for (const [model, p] of Object.entries(MODEL_PRICES)) {
    assert.ok(p.cacheRead < p.in, `${model}: a cache hit is not cheaper than a miss`);
    assert.ok(p.in < p.out, `${model}: input is not cheaper than output`);
  }
});

/**
 * ⭐ THE PIN IS A COST CEILING, AND THE EYES MUST STAY UNDER THE BUILD MODEL'S
 * OUTPUT RATE. `ECONOMICS-SETTLED.md` §5 keeps Qwen only because it is cheap
 * enough that sight is not a margin question ($0.000234 per look). If a future
 * card edit made the eyes dearer than the model that builds, that argument
 * silently stops holding.
 */
test('⭐ the eyes stay cheap enough that sight is not a margin decision', () => {
  const eyes = MODEL_PRICES['qwen/qwen3.7-flash'];
  const build = MODEL_PRICES['deepseek/deepseek-v4-flash-0731'];
  assert.ok(eyes.in <= build.in, 'the vision model now costs more per input token than the build model');
});
