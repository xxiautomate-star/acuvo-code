/**
 * ── ⭐⭐⭐ IS THE CHAIN ORDERED ON THE WRONG NUMBER? ─────────────────────────
 *
 * `DECISION-the-first-fallback-is-unpinned.md` found that the chain is ordered
 * on LIST price, and that warm — which is every round after the first — the
 * "floor" model `z-ai/glm-4.6` is cheaper per input token than the fallback
 * sitting above it, because neither `deepseek/deepseek-chat` endpoint sells a
 * cached read at any price.
 *
 * ⚠️ THAT DOCUMENT CARRIES A LIVE NUMBER, WHICH CLAUDE.md WARNS AGAINST BY
 * NAME: *"it should never have carried a live number at all… go read the
 * instrument rather than trusting a figure typed here."* This is the
 * instrument. It spends nothing — the endpoint feed is a public GET, no key, no
 * completion.
 *
 *     node scripts/zz-chain-order-warm-vs-cold.mjs
 *     node scripts/zz-chain-order-warm-vs-cold.mjs --json
 *
 * ── ⚠️ THE ONE READING THAT MUST NOT BE GUESSED ────────────────────────────
 *
 * `input_cache_read` ABSENT and `input_cache_read: 0` are different facts, and
 * a missing field deserialises to `0` — which would invert the conclusion into
 * "cached input is free there". Every price below is read with `hasOwn` first
 * and reported as `null` when the field is not offered.
 */

import { buildChain } from '../lib/chain.mjs';
import { DEFAULT_MODEL, PROVIDER_PIN_BY_MODEL } from '../lib/model.mjs';

/** How much of a warm round's input is served from cache. Measured 98.9%-100%. */
const WARM_CACHE_RATE = 0.99;

const json = process.argv.includes('--json');

/** ⚠️ `null` means NOT OFFERED. Never 0 — see the header. */
function priceOf(pricing, key) {
  if (!pricing || !Object.hasOwn(pricing, key)) return null;
  const n = Number(pricing[key]);
  return Number.isFinite(n) ? n * 1_000_000 : null;
}

async function endpointsFor(model) {
  const res = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`);
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status}`);
  const body = await res.json();
  return (body?.data?.endpoints ?? []).map((e) => ({
    provider: e.provider_name ?? e.name ?? 'unknown',
    inUsdPerM: priceOf(e.pricing, 'prompt'),
    outUsdPerM: priceOf(e.pricing, 'completion'),
    /** ⚠️ null = this endpoint does not price a cached read at all. */
    cachedInUsdPerM: priceOf(e.pricing, 'input_cache_read'),
  }));
}

/**
 * The endpoint a round would actually land on.
 *
 * ⚠️ THE PIN DECIDES, WHEN THERE IS ONE. Reading the cheapest endpoint for a
 * pinned model would price a machine the request never reaches — the exact
 * "the registry names the wrong transport" defect this repo has recorded.
 */
function landsOn(model, endpoints) {
  const pin = PROVIDER_PIN_BY_MODEL[model] ?? null;
  if (pin && pin.length) {
    for (const name of pin) {
      const hit = endpoints.find((e) => e.provider === name);
      if (hit) return { ...hit, pinned: true, pin: [...pin] };
    }
  }
  /**
   * ⚠️ UNPINNED MEANS THE WHOLE FLEET, so there is no single answer. The
   * DEAREST is reported, because an unpinned leg is a lottery and the number a
   * payer needs is the worst ticket, not the average.
   */
  const worst = [...endpoints].sort((a, b) => (b.inUsdPerM ?? 0) - (a.inUsdPerM ?? 0))[0];
  return worst ? { ...worst, pinned: false, pin: null } : null;
}

const warmBlend = (e) => (e.cachedInUsdPerM === null
  ? e.inUsdPerM
  : WARM_CACHE_RATE * e.cachedInUsdPerM + (1 - WARM_CACHE_RATE) * e.inUsdPerM);

const chain = buildChain(DEFAULT_MODEL, {});
const rows = [];
for (const model of chain) {
  const endpoints = await endpointsFor(model);
  const at = landsOn(model, endpoints);
  rows.push({
    model,
    provider: at?.provider ?? null,
    pinned: at?.pinned ?? false,
    endpoints: endpoints.length,
    coldInUsdPerM: at?.inUsdPerM ?? null,
    cachedInUsdPerM: at?.cachedInUsdPerM ?? null,
    warmInUsdPerM: at ? warmBlend(at) : null,
    outUsdPerM: at?.outUsdPerM ?? null,
    /** ⭐ THE FINDING'S UNIT. Absent pricing is the point, not an error. */
    sellsACachedRead: at ? at.cachedInUsdPerM !== null : null,
  });
}

const primary = rows[0];
for (const r of rows) {
  r.coldVsPrimary = primary.coldInUsdPerM && r.coldInUsdPerM ? r.coldInUsdPerM / primary.coldInUsdPerM : null;
  r.warmVsPrimary = primary.warmInUsdPerM && r.warmInUsdPerM ? r.warmInUsdPerM / primary.warmInUsdPerM : null;
}

/**
 * ⭐ THE QUESTION THE WHOLE SCRIPT EXISTS FOR, answered as a boolean and a
 * ratio rather than prose: would swapping fallback 1 and fallback 2 be cheaper,
 * warm and cold?
 */
const verdict = (() => {
  if (rows.length < 3) return { comparable: false, why: 'the chain is shorter than three models here' };
  const [, f1, f2] = rows;
  /**
   * ── ⭐⭐⭐ THE NUMBER THAT ACTUALLY DECIDES IT, AND THE DECISION DOC DOES
   *          NOT HAVE IT ────────────────────────────────────────────────────
   *
   * ⚠️⚠️ "3.1× cheaper warm" COMPARES TWO WARM LEGS, AND A FALLBACK LEG DOES
   * NOT START WARM. `chain.mjs`'s own header is the reason: *"a prefix cache
   * CANNOT cross a provider — it is physically a property of one host's KV
   * store."* The primary is pinned to Relace; BOTH fallbacks are a different
   * host, so the FIRST round on either is cold, whichever one it is.
   *
   * ⭐ So the honest comparison is over N CONSECUTIVE fallback rounds:
   *
   *     deepseek-chat   N × cold                      (sells no cached read, ever)
   *     glm-4.6         cold + (N-1) × warm           (Venice prices a cached read)
   *
   * At N = 1 the current order is CHEAPER. The re-order only wins once the
   * primary stays down long enough to serve a second round — and this computes
   * exactly where that crossover is, instead of quoting a ratio that assumes
   * the answer.
   */
  const costOverRounds = (row, n) => {
    if (row.coldInUsdPerM === null) return null;
    return row.sellsACachedRead ? row.coldInUsdPerM + (n - 1) * row.warmInUsdPerM : n * row.coldInUsdPerM;
  };
  let breakEvenRounds = null;
  for (let n = 1; n <= 64; n += 1) {
    const keep = costOverRounds(f1, n);
    const swap = costOverRounds(f2, n);
    if (keep !== null && swap !== null && swap < keep) { breakEvenRounds = n; break; }
  }
  return {
    comparable: true,
    firstFallback: f1.model,
    secondFallback: f2.model,
    warmRatio: f1.warmInUsdPerM && f2.warmInUsdPerM ? f1.warmInUsdPerM / f2.warmInUsdPerM : null,
    coldRatio: f1.coldInUsdPerM && f2.coldInUsdPerM ? f1.coldInUsdPerM / f2.coldInUsdPerM : null,
    reorderIsCheaperWarm: f2.warmInUsdPerM !== null && f1.warmInUsdPerM !== null && f2.warmInUsdPerM < f1.warmInUsdPerM,
    reorderIsCheaperCold: f2.coldInUsdPerM !== null && f1.coldInUsdPerM !== null && f2.coldInUsdPerM < f1.coldInUsdPerM,
    /** ⭐ Consecutive fallback rounds at which swapping starts winning. */
    breakEvenRounds,
    costOverRounds: [1, 2, 4, 8].map((n) => ({ n, keep: costOverRounds(f1, n), swap: costOverRounds(f2, n) })),
  };
})();

if (json) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), warmCacheRate: WARM_CACHE_RATE, chain: rows, verdict }, null, 2)}\n`);
} else {
  const usd = (n) => (n === null ? '   —    ' : `$${n.toFixed(4)}`.padStart(8));
  console.log(`\nChain ordering, warm vs cold · warm = ${(WARM_CACHE_RATE * 100).toFixed(0)}% cached · prices per 1M input tokens\n`);
  console.log('  leg  model                            lands on        pinned  cold in   cached    warm in   ×primary warm');
  rows.forEach((r, i) => {
    console.log(
      `  ${String(i).padEnd(4)} ${r.model.padEnd(32)} ${String(r.provider).padEnd(15)} ${(r.pinned ? 'yes' : 'NO ').padEnd(6)}  `
      + `${usd(r.coldInUsdPerM)}  ${r.sellsACachedRead ? usd(r.cachedInUsdPerM) : ' none   '}  ${usd(r.warmInUsdPerM)}  `
      + `${r.warmVsPrimary === null ? '—' : `${r.warmVsPrimary.toFixed(1)}×`}`,
    );
  });
  if (verdict.comparable) {
    console.log(`\n  fallback 1 = ${verdict.firstFallback}`);
    console.log(`  fallback 2 = ${verdict.secondFallback}`);
    console.log(`  warm: fallback 1 costs ${verdict.warmRatio?.toFixed(2)}× fallback 2 per input token`);
    console.log(`  cold: fallback 1 costs ${verdict.coldRatio?.toFixed(2)}× fallback 2 per input token`);
    console.log(`\n  swapping them is cheaper WARM: ${verdict.reorderIsCheaperWarm}`);
    console.log(`  swapping them is cheaper COLD: ${verdict.reorderIsCheaperCold}`);
    console.log('\n  ⭐ But a fallback leg does not START warm — the cache cannot cross a provider,');
    console.log('     so round 1 on EITHER fallback is cold. Cost of N consecutive fallback rounds,');
    console.log('     per 1M input tokens:\n');
    console.log('        N   keep (deepseek-chat)   swap (glm-4.6)   cheaper');
    for (const row of verdict.costOverRounds) {
      const k = row.keep === null ? '—' : `$${row.keep.toFixed(4)}`;
      const s = row.swap === null ? '—' : `$${row.swap.toFixed(4)}`;
      console.log(`        ${String(row.n).padEnd(3)} ${k.padStart(18)} ${s.padStart(16)}   ${row.swap < row.keep ? 'swap' : 'keep'}`);
    }
    console.log(`\n     break-even: the swap starts winning at ${verdict.breakEvenRounds ?? 'never within 64'} consecutive fallback rounds.`);
    /**
     * ⚠️ PRICE IS NOT THE WHOLE DECISION AND THE SCRIPT SAYS SO ITSELF. Which
     * model answers when the primary is down is a QUALITY choice; this
     * instrument can only ever price it.
     */
    console.log('\n  ⚠️ This prices the legs. It does not judge which model should answer when');
    console.log('     the primary is down — that is a quality decision and it is Roman\'s.\n');
  }
}
