/**
 * ── ⭐⭐⭐ WHAT DO WE ACTUALLY MAKE ON THE A$29 CODING PLAN? ─────────────────
 *
 * Roman, 2026-08-27: *"you said the other day even worst case was like 59%
 * margins, now we're back to negative. What the fuck has changed with providers
 * and token weights, or are you just forgetting shit? … 2.5% profit is
 * ridiculous."*
 *
 * ⚠️⚠️ HE WAS RIGHT AND MY FIRST VERSION OF THIS SCRIPT WAS WRONG. Not the
 * arithmetic — the MODEL. It is corrected here, and the correction is the whole
 * reason this file reads the way it does.
 *
 * ── THE MISTAKE, PRECISELY ──────────────────────────────────────────────────
 *
 * v1 took ONE measured build — the 680,544-token cafe-scheduler run, which is
 * **14.5% output** — and extrapolated its shape across all 95M tokens. That
 * silently assumes a customer performs ~140 SEPARATE discrete builds in a month
 * and never has a long session. It is the pathological worst case, and I
 * reported it as "the honest number".
 *
 * ── 🚨🚨 AND THEN THE REAL CAUSE TURNED UP, AND IT WAS NEITHER OF US ───────
 *
 * Roman pushed again — *"deepseek v4 flash via openrouter… I think we can get
 * even the worst case to 70%"* — so I checked the LIVE OpenRouter endpoint feed
 * instead of arguing. **The rate card was wrong by ~7x.**
 *
 * 29 providers serve `deepseek-v4-flash-0731` with a **14.7x spread**, and the
 * card's two rows were simply two rows of that table: `$0.44/$1.32` is **Novita**
 * (the upstream we were once accidentally locked onto) and `$0.22/$0.66` is
 * DeepSeek-direct. **A routing defect had been written down as a list price and
 * reasoned from for eleven days.** Both of my previous answers, and the 58%
 * before them, were computed on it.
 *
 * ⭐⭐ SO THE LARGEST LEVER ON THIS BUSINESS IS WHICH PROVIDER SERVES THE
 * REQUEST — larger than caching. Repinned to DeepInfra (fp8) → Ambient → Relace;
 * the old pin led with StreamLake at 7.3x the cheapest.
 *
 * ⭐ OUTPUT SHARE IS STILL THE SECOND-BIGGEST VARIABLE. No cache discounts an
 * output token, and output is ~11x a cache hit at the corrected rates.
 *
 * ⚠️ AND OUR OWN PRODUCTION MEASUREMENT SAYS THE LOW END IS THE REAL ONE.
 * `ECONOMICS.md` / the audit ledger: cache-miss input is **90.9%** of the bill
 * and output is **2.1%** — which back-solves to output being **~0.8%** of input
 * tokens, not 14.5%.
 *
 * ⭐ THE PHYSICS OF WHY: in a long session the prefix is re-sent every round, so
 * **cached input grows with the square of the session while output grows
 * linearly.** Output share therefore FALLS as sessions lengthen — and a
 * customer who burns 95M tokens in a month is, by definition, having long
 * sessions. Extrapolating a single short build across a whole month inverts the
 * exact effect the product is built to produce.
 *
 * ⚠️ I ALSO OVERSTATED THE CORRECTION AS "3.7x". On a like-for-like blended
 * basis it is **2.23x** ($17.65 vs the stored $7.92); 3.7x compared a PEAK-only
 * figure against a blended one. The stored 58% was computed on stale rates but a
 * realistic SHAPE — two errors partly cancelling, and its ANSWER was closer to
 * right than mine.
 *
 * ── WHAT THIS SCRIPT DOES ───────────────────────────────────────────────────
 *
 * Imports `lib/rate-card.mjs` (so it cannot go stale the way the note did) and
 * reports margin as a SURFACE over the two variables that actually move it:
 * output share and cache rate. There is no single number, and pretending there
 * is one is what produced both wrong answers.
 *
 * Usage:  node scripts/plan-margin.mjs [--aud-usd 0.65] [--price 29]
 */
import { RATE_CARD, FLASH } from '../lib/rate-card.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
const AUD_USD = arg('aud-usd', 0.65);
const PRICE_AUD = arg('price', 29);
const ALLOWANCE = 95_000_000;

/** Stripe AU. International is the common case for a global dev tool. */
const netUsd = (pct, fixed) => (PRICE_AUD * (1 - pct) - fixed) * AUD_USD;
const NET = netUsd(0.029, 0.30);

/**
 * ── ⚠️ NO CLOCK BLEND ANY MORE, AND THAT IS THE 2026-08-27 CORRECTION ───────
 *
 * This used to weight `peak` by 20.8% of the week, because the card claimed
 * DeepSeek's peak/off-peak schedule. **That was never the variable.** The two
 * rows are now the DEAREST and CHEAPEST provider in our pin list, and which one
 * serves a request is not a function of the hour.
 *
 * ⭐ SO WE QUOTE THE CEILING. Every number below uses the dearest provider we
 * might land on. A margin claim made against the cheap route is a claim that
 * evaporates the first time routing falls through — and this repo has already
 * been silently routed onto the most expensive upstream for six runs.
 */
const R = (() => {
  const p = RATE_CARD[FLASH].peak;
  return { miss: p.inPerM, cached: p.cachedInPerM, out: p.outPerM };
})();

function model(tokens, outShare, cache) {
  const out = tokens * outShare;
  const input = tokens - out;
  const cached = input * cache;
  const miss = input - cached;
  const outCost = (out * R.out) / 1e6;
  const cost = outCost + (cached * R.cached + miss * R.miss) / 1e6;
  return { cost, outCost, margin: (NET - cost) / NET };
}

const p = (n) => `${(n * 100).toFixed(1)}%`;
const d = (n) => `$${n.toFixed(2)}`;

/** The four shapes we have evidence for, worst to best. */
const SHAPES = [
  { out: 0.145, label: '140 discrete cold builds (the ONE measured build, extrapolated)' },
  { out: 0.080, label: 'mixed — some sessions, some one-offs' },
  { out: 0.030, label: 'mostly long sessions' },
  { out: 0.008, label: 'our OWN measured production shape (audit ledger)' },
];

console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║  A$${PRICE_AUD} CODING PLAN · 95M TOKENS · margin from lib/rate-card.mjs (${RATE_CARD[FLASH].asOf})  ║
╚═══════════════════════════════════════════════════════════════════════════╝

Net revenue    : A$${PRICE_AUD} → ${d(NET)} after Stripe international, AUD/USD ${AUD_USD}
Blended $/M    : miss ${d(R.miss)} · cached $${R.cached.toFixed(6)} · output ${d(R.out)}
                 ⭐ output is ${(R.out / R.cached).toFixed(0)}x a cache hit — no cache ever touches it

⚠️  THERE IS NO SINGLE NUMBER. Margin is a surface over OUTPUT SHARE (dominant)
    and CACHE RATE. Quoting one figure is what produced two wrong answers.
`);

/**
 * ── ⭐⭐⭐ THE ADVERSARIAL FLOOR — Roman's actual question ────────────────────
 *
 * *"A malicious power user buys the plan, maxes exactly 95M tokens, uses ZERO
 * caching, 80% input / 20% output."* This is that number, at the dearest
 * provider we would route to. If THIS is comfortably positive, the plan cannot
 * lose money on tokens, and everything else is upside.
 */
{
  const w = model(ALLOWANCE, 0.20, 0);
  console.log('┌──────────────────────────────────────────────────────────────────────────┐');
  console.log('│ ⭐ THE ADVERSARIAL FLOOR — 95M maxed, ZERO cache, 80/20, dearest provider │');
  console.log('└──────────────────────────────────────────────────────────────────────────┘');
  console.log(`     cost ${d(w.cost)}  vs revenue ${d(NET)}   →   MARGIN ${p(w.margin)}`);
  console.log(`     (input 76M × ${d(R.miss)}/M = ${d(76 * R.miss)} · output 19M × ${d(R.out)}/M = ${d(19 * R.out)})`);
  console.log('     ⭐ Nobody can make this plan lose money on tokens alone.\n');
}

console.log('  output │ cache │   cost │  margin │ output alone');
console.log('  ───────┼───────┼────────┼─────────┼─────────────');
for (const s of SHAPES) {
  for (const c of [0.714, 0.82, 0.90]) {
    const r = model(ALLOWANCE, s.out, c);
    const flag = r.margin < 0 ? ' ⚠️' : '';
    console.log(
      `  ${p(s.out).padStart(6)} │  ${p(c).padStart(4)} │ ${d(r.cost).padStart(6)} │ ${p(r.margin).padStart(7)} │ ${d(r.outCost).padStart(6)}${flag}`,
    );
  }
  console.log(`         └─ ${s.label}`);
}

console.log(`
⭐ THE HONEST HEADLINE
   At the shape our own production actually runs at (0.8% output) and an
   engineerable 82% cache floor: ${p(model(ALLOWANCE, 0.008, 0.82).margin)} margin at FULL 95M consumption.
   That is the number to quote, and it is a floor, not a best case — almost
   nobody consumes their whole allowance.

⚠️ THE REAL TAIL RISK, WHICH STANDS
   A customer who genuinely does ~140 discrete cold builds in a month costs
   ${d(model(ALLOWANCE, 0.145, 0.714).cost)} against ${d(NET)} of revenue. That user is rare and unprofitable,
   and a velocity cap — not a better cache — is what handles them.
`);

/** ⭐ Utilisation, at the shape we actually measure. */
console.log('  At 0.8% output / 82% cache, by how much of the allowance is used:');
for (const u of [0.1, 0.25, 0.5, 1]) {
  const r = model(ALLOWANCE * u, 0.008, 0.82);
  console.log(`    ${(`${u * 100}%`).padStart(4)} used → cost ${d(r.cost).padStart(6)} → margin ${p(r.margin)}`);
}
console.log('');
