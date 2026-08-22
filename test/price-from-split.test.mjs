import test from 'node:test';
import assert from 'node:assert';
import { priceFromSplit, RATE_USD_PER_MILLION, DEFAULT_USD_PER_MILLION_TOKENS } from '../lib/budget.mjs';

/**
 * ── ⭐⭐⭐ TWO HONEST MEASUREMENTS THAT APPEARED TO DISAGREE ─────────────────
 *
 * budget.mjs measured $0.223/M (1,036 tokens for $0.000231, cold, output-heavy).
 * The console measured $0.117/M cold and $0.0357/M blended on real builds.
 * That looked like a 2x contradiction about the same model and it was not:
 * they are the SAME rates applied to DIFFERENT MIXES. A single $/M constant
 * cannot describe both, which is why one had to be wrong wherever it was used.
 */

test("⭐ reproduces this file's OWN cold measurement", () => {
  // 1,036 tokens for $0.000231. Output-heavy, no cache.
  const usd = priceFromSplit({ prompt_tokens: 363, completion_tokens: 673 });
  assert.ok(usd !== null);
  // Within 10% of the recorded measurement — the reconciliation, in one line.
  assert.ok(Math.abs(usd - 0.000231) / 0.000231 < 0.10,
    `priced ${usd}, the file measured 0.000231`);
});

test('⭐⭐ a real cached session costs a FRACTION of the flat constant', () => {
  // The actual run that surfaced this: 87,814 tokens at 80% cache.
  const real = priceFromSplit({
    prompt_tokens: 87_320, completion_tokens: 494,
    prompt_tokens_details: { cached_tokens: 69_504 },
  });
  const flat = (87_814 / 1e6) * DEFAULT_USD_PER_MILLION_TOKENS;
  assert.ok(real < flat / 5,
    `the flat constant charged ${flat}, the mix costs ${real} — the gap IS the cache discount`);
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
  // The discount IS the business model — roughly a tenth.
  assert.ok(warm < cold / 5, `cold ${cold} vs warm ${warm}`);
});

test('⚠️ output is dearer than input, because it is never cached', () => {
  const inOnly = priceFromSplit({ prompt_tokens: 1000, completion_tokens: 0 });
  const outOnly = priceFromSplit({ prompt_tokens: 0, completion_tokens: 1000 });
  assert.ok(outOnly > inOnly);
  assert.strictEqual(RATE_USD_PER_MILLION.output, RATE_USD_PER_MILLION.input * 2);
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
