/**
 * ── ⭐⭐⭐ THE GUARD THAT WOULD HAVE CAUGHT AN ELEVEN-DAY ERROR IN ONE DAY ────
 *
 * `lib/rate-card.mjs` carried Novita's price as if it were DeepSeek's published
 * "peak" rate — **wrong by ~7x** — and every margin figure this repo produced
 * for eleven days was computed on it. Six different answers were given to one
 * question before anybody pulled the live feed.
 *
 * ⚠️ NOTHING IN THE REPO COULD HAVE NOTICED. Every test asserted the card
 * against itself, or asserted relationships BETWEEN its rows. A card that is
 * internally consistent and externally wrong passes all of them.
 *
 * ⭐ SO THIS ASKS THE ONLY QUESTION THAT MATTERS: **does the pinned provider
 * still charge what the card says?** It fetches the live OpenRouter endpoint
 * feed, finds the providers we actually pin, and compares.
 *
 * ── ⚠️ WHY IT IS A SCRIPT AND NOT A UNIT TEST ───────────────────────────────
 *
 * It needs the network. A test that fails when the wifi drops is a test people
 * learn to ignore, and an ignored guard is worse than none — this repo has the
 * scar tissue to prove it. Run it in CI, on a schedule, or by hand before
 * quoting a margin to anybody.
 *
 * Usage:  node scripts/verify-rate-card.mjs [--tolerance 0.02]
 * Exits 1 when the card and the market disagree, so CI can fail on it.
 */
import { RATE_CARD, FLASH, PRO, ratesFor } from '../lib/rate-card.mjs';
import { PROVIDER_PIN_BY_MODEL } from '../lib/model.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
/** ⭐ A little slack: providers round, and a 1% drift is not a defect. */
const TOLERANCE = arg('tolerance', 0.02);

async function endpointsFor(model) {
  const url = `https://openrouter.ai/api/v1/models/${model}/endpoints`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const json = await res.json();
  return (json?.data?.endpoints ?? []).map((e) => ({
    provider: String(e.provider_name ?? ''),
    inPerM: Number(e.pricing?.prompt) * 1e6,
    outPerM: Number(e.pricing?.completion) * 1e6,
    cachedInPerM: e.pricing?.input_cache_read == null ? null : Number(e.pricing.input_cache_read) * 1e6,
    quant: e.quantization ?? null,
    status: e.status ?? 0,
  }));
}

const problems = [];
const notes = [];

for (const model of [FLASH, PRO]) {
  const pins = PROVIDER_PIN_BY_MODEL[model] ?? [];
  if (!pins.length) { notes.push(`${model}: no pin — routing is whatever OpenRouter chooses`); continue; }

  let live;
  try { live = await endpointsFor(model); } catch (err) {
    problems.push(`${model}: could not read the live feed (${err.message})`);
    continue;
  }
  if (!live.length) { problems.push(`${model}: the feed returned no endpoints`); continue; }

  /**
   * ⚠️⚠️ THE PIN IS CHECKED FOR EXISTENCE FIRST. A pinned provider that has
   * VANISHED from the feed is the most dangerous state there is: with
   * `allow_fallbacks:false` the request fails, and with fallbacks on it silently
   * routes somewhere unpriced. Either way the card describes nothing.
   */
  const byName = new Map(live.map((e) => [e.provider, e]));
  for (const name of pins) {
    if (!byName.has(name)) problems.push(`${model}: pinned provider "${name}" is GONE from the feed`);
    else if (byName.get(name).status < 0) notes.push(`${model}: pinned "${name}" reports status ${byName.get(name).status} (degraded)`);
  }

  const present = pins.map((n) => byName.get(n)).filter(Boolean);
  if (!present.length) { problems.push(`${model}: NONE of the pinned providers exist any more`); continue; }

  /**
   * ⭐ THE CARD'S TWO ROWS ARE DEFINED AS THE DEAREST AND CHEAPEST OF THE PIN.
   * That is stated in `rate-card.mjs`, so it is the thing to verify — not some
   * independent notion of "the right price".
   */
  /**
   * ⚠️ PER COLUMN, NOT PER PROVIDER (2026-09-28). "The dearest provider" is ill-defined the moment
   * two members tie on input — v4.1's whole pin lists $0.30 in and differs only on the cache read
   * (Together $0.006, Modal $0.030) — and a reduce on `inPerM` then silently picks the first name
   * and verifies the ceiling against the CHEAPEST cache read. The envelope is what a ceiling means.
   */
  const envelope = (pick) => {
    const col = (f) => {
      const vals = present.map((e) => e[f]).filter((v) => v != null && Number.isFinite(v));
      return vals.length ? pick(...vals) : null;
    };
    const names = present.map((e) => e.provider).join('/');
    return { provider: `${pick === Math.max ? 'max' : 'min'} over ${names}`, inPerM: col('inPerM'), outPerM: col('outPerM'), cachedInPerM: col('cachedInPerM') };
  };
  const dearest = envelope(Math.max);
  const cheapest = envelope(Math.min);

  for (const [label, want, got] of [
    ['peak (dearest pinned)', ratesFor(model, 'peak'), dearest],
    ['offPeak (cheapest pinned)', ratesFor(model, 'offPeak'), cheapest],
  ]) {
    for (const field of ['inPerM', 'outPerM', 'cachedInPerM']) {
      const w = want[field];
      const g = got[field];
      if (g == null) { notes.push(`${model} ${label}: provider does not publish ${field}`); continue; }
      const drift = Math.abs(g - w) / Math.max(w, 1e-9);
      if (drift > TOLERANCE) {
        problems.push(
          `${model} ${label} ${field}: card says $${w} but ${got.provider} charges $${g.toFixed(4)} `
          + `(${(drift * 100).toFixed(0)}% out) — EVERY margin figure is computed on this`,
        );
      }
    }
  }

  /**
   * ⭐ AND THE QUESTION NOBODY THOUGHT TO ASK: is there something much cheaper
   * we are not pinned to? That is not automatically a defect — the pin leads
   * with fp8 on purpose, because 4-bit weights on a coding model is a real
   * quality risk — so it is a NOTE, not a failure. But it should be SEEN.
   */
  const marketCheapest = live.filter((e) => e.status >= 0).reduce((a, b) => (b.inPerM < a.inPerM ? b : a));
  if (marketCheapest.inPerM < cheapest.inPerM * 0.8) {
    notes.push(
      `${model}: ${marketCheapest.provider} is $${marketCheapest.inPerM.toFixed(4)}/M in `
      + `(${(cheapest.inPerM / marketCheapest.inPerM).toFixed(1)}x cheaper than our cheapest pin, quant ${marketCheapest.quant}) `
      + '— deliberate if it is fp4, worth a look if it is not',
    );
  }
}

console.log(`\nRate card ${RATE_CARD[FLASH].asOf} vs the live OpenRouter feed\n`);
for (const n of notes) console.log(`  · ${n}`);
if (!problems.length) {
  console.log(`\n✓ The card matches what our pinned providers actually charge (±${(TOLERANCE * 100).toFixed(0)}%).\n`);
  process.exit(0);
}
console.log('\n🚨 THE CARD AND THE MARKET DISAGREE:\n');
for (const p of problems) console.log(`  ✗ ${p}`);
console.log(
  '\n⚠️ Fix `lib/rate-card.mjs` (and `PROVIDER_PIN_BY_MODEL` if the pin moved) before quoting\n'
  + '   any margin. The last time this drifted it went unnoticed for eleven days and produced\n'
  + '   six different answers to one question.\n',
);
process.exit(1);
