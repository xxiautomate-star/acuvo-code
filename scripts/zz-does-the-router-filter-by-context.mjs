/**
 * ── ⭐⭐⭐ THE ONE EXPERIMENT `DECISION-the-first-fallback-is-unpinned.md` §4
 *          WROTE DOWN AND DID NOT RUN ────────────────────────────────────────
 *
 * `test/compaction-cache-economics.test.mjs` sizes the compaction ceiling
 * against `SMALLEST_CHAIN_WINDOW`. `deepseek/deepseek-chat` is served by two
 * machines that disagree — StreamLake 128,000, DeepInfra 163,840 — and it is
 * the ONE model in the chain with no entry in `PROVIDER_PIN_BY_MODEL`, so
 * nothing in this package chooses which answers.
 *
 * The guard is correct only if OpenRouter's router EXCLUDES an endpoint that
 * cannot serve the request's context. That is documented behaviour; it was
 * never measured for this account, which is the difference between "correct"
 * and "correct by luck".
 *
 *     node scripts/zz-does-the-router-filter-by-context.mjs          (dry: free)
 *     node scripts/zz-does-the-router-filter-by-context.mjs --spend  (the probe)
 *
 * ── ⚠️ WHY THE PROBE IS SHAPED AS A PIN, NOT AS AN UNPINNED ROLL ───────────
 *
 * An unpinned request landing on the large endpoint once proves nothing — an
 * unpinned request lands *somewhere*, and one sample is a coin toss. That is
 * exactly the 0%/31%/65%/98% lottery `model.mjs` already measured. Asking
 * OpenRouter for `{"only":[<the undersized endpoint>]}` at 140k tokens asks the
 * router the question directly, and it can only answer three ways:
 *
 *   404 "no endpoints"  the router filtered that endpoint OUT for this context.
 *                       → the exclusion is real, the guard is right by design,
 *                       and it costs $0 because no tokens were ever sent.
 *   400 context error   the router routed there anyway and the endpoint
 *                       refused. → the exposure is REAL. Also ~$0.
 *   200                 it served 140k. → its declared window is wrong and
 *                       there is no exposure. ~$0.036.
 *
 * ⚠️ AND A 404 ONLY MEANS SOMETHING IF THAT ENDPOINT IS REACHABLE AT ALL for
 * this account. So the same pin is sent first with a TINY prompt (~$0.0002). If
 * that also fails, the big failure is about ACCESS, not context, and the probe
 * says so instead of concluding. This is the step that makes it an instrument
 * rather than a story.
 */

import { readFileSync } from 'node:fs';

const SPEND = process.argv.includes('--spend');
const MODEL = 'deepseek/deepseek-chat';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Between the two declared windows, so exactly one endpoint can serve it.
 * Anything above BOTH fails for a second reason and distinguishes nothing.
 *
 * ── ⚠️⚠️ THE FIRST RUN OF THIS SCRIPT SIZED IT WITH THE WRONG RULER ────────
 *
 * It calibrated chars→tokens against `usage.prompt_tokens` (the REAL tokenizer,
 * 5.274 chars/token on this filler) and sent 738,360 chars expecting 140,000
 * tokens. OpenRouter answered:
 *
 *     "you requested about 184601 tokens (184600 of text input)"
 *
 * 738,360 / 184,600 = **3.9998**. ⭐ OpenRouter's admission check is
 * `chars / 4` — it does not tokenize before it decides. So the probe sailed
 * past BOTH windows and its 400 proved nothing.
 *
 * ⭐⭐ AND THAT IS THE MORE USEFUL FINDING, because `chars / 4` is exactly what
 * `lib/compact.mjs` computes. The number OpenRouter compares against 128,000 is
 * the SAME NUMBER our ceiling is expressed in — so the compaction guard's
 * "real tokens can be 1.3-1.5x the estimate" margin is the wrong model for the
 * ADMISSION decision, whatever it is worth for the provider's own count.
 */
const TARGET_EST_TOKENS = 145_000;
const OPENROUTER_CHARS_PER_TOKEN = 4;

function key() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const candidates = ['../../../../.env.local', '../../../.env.local', '../.env.local'];
  for (const p of candidates) {
    try {
      const m = /^OPENROUTER_API_KEY=(.+)$/m.exec(readFileSync(new URL(p, import.meta.url), 'utf8'));
      if (m && m[1].trim()) return m[1].trim();
    } catch { /* next */ }
  }
  return null;
}

async function post(body, k) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + k,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://acuvo.xxiautomate.com',
      'X-Title': 'Acuvo Code',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

/** Deterministic filler, real prose, so the chars/token ratio is a real one. */
function filler(chars) {
  const unit = 'The compaction ceiling has to survive the smallest endpoint in the chain, not the largest one. ';
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

const feed = await fetch('https://openrouter.ai/api/v1/models/' + MODEL + '/endpoints').then((r) => r.json());
const endpoints = (feed && feed.data && feed.data.endpoints ? feed.data.endpoints : []).map((e) => ({
  name: e.provider_name,
  context: e.context_length,
  in: e.pricing && e.pricing.prompt ? Number(e.pricing.prompt) * 1e6 : null,
}));

console.log('\n' + MODEL + ' — endpoints, live:\n');
for (const e of endpoints.slice().sort((a, b) => a.context - b.context)) {
  console.log('  ' + String(e.name).padEnd(14) + ' context ' + String(e.context).padStart(9)
    + '   in $' + (e.in === null ? '—' : e.in.toFixed(4)) + '/M');
}
const smallest = Math.min(...endpoints.map((e) => e.context));
const largest = Math.max(...endpoints.map((e) => e.context));
console.log('\n  smallest endpoint window: ' + smallest.toLocaleString());
console.log('  largest  endpoint window: ' + largest.toLocaleString());

if (!SPEND) {
  console.log('\n  (dry run — pass --spend to send the probes; budgeted ~$0.04)\n');
  process.exit(0);
}

const k = key();
if (!k) { console.error('\n  no OPENROUTER_API_KEY found\n'); process.exit(1); }

const under = endpoints.filter((e) => e.context < TARGET_EST_TOKENS);
if (under.length === 0) {
  console.log('\n  ⚠️ no endpoint is under ' + TARGET_EST_TOKENS.toLocaleString() + ' any more — the question has dissolved.\n');
  process.exit(0);
}
const victim = under[0];

/* ── step 1 · is the undersized endpoint reachable AT ALL for this account? ─ */
const reach = await post({
  model: MODEL,
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1,
  provider: { only: [victim.name] },
}, k);
console.log('\n  step 1 · is ' + victim.name + ' reachable at all?   HTTP ' + reach.status
  + ' · provider ' + ((reach.json && reach.json.provider) || '—'));
if (reach.status !== 200) {
  const why = (reach.json && reach.json.error && reach.json.error.message) || reach.text;
  console.log('    ' + String(why).slice(0, 300));
  console.log('\n  ⛔ INCONCLUSIVE — ' + victim.name + ' does not answer this account even at 2 tokens, so a');
  console.log('     refusal at 145k would be about ACCESS, not about context. Not spending the big probe.\n');
  process.exit(0);
}

/**
 * ── step 2 · THE QUESTION, ASKED UNPINNED ─────────────────────────────────
 *
 * ⚠️ NOT PINNED. Pinning to the undersized endpoint asks "will you serve more
 * than you declared", which has an obvious answer and is not the question.
 * The question is what the ROUTER does with a request only one of two
 * endpoints can take — which is exactly the situation `buildChain` creates,
 * because this model has no pin.
 *
 * ⭐ Sized in OPENROUTER'S currency (chars/4), because that is the number its
 * admission check compares against the window. This filler is repetitive, so
 * the REAL token count is ~27% lower — which is the cheap direction: we buy a
 * 145,000-estimate request for ~110,000 tokens of billing.
 */
const bigChars = TARGET_EST_TOKENS * OPENROUTER_CHARS_PER_TOKEN;
const big = await post({
  model: MODEL,
  messages: [{ role: 'user', content: filler(bigChars) }],
  max_tokens: 1,
}, k);
const msg = String((big.json && big.json.error && big.json.error.message) || big.text || '').slice(0, 500);
console.log('\n  step 2 · ~' + TARGET_EST_TOKENS.toLocaleString() + ' chars/4 tokens, UNPINNED');
console.log('    (fits ' + largest.toLocaleString() + ', does not fit ' + smallest.toLocaleString() + ')');
console.log('    HTTP ' + big.status + ' · provider ' + ((big.json && big.json.provider) || '—')
  + ' · prompt_tokens ' + ((big.json && big.json.usage && big.json.usage.prompt_tokens) || '—'));
if (msg) console.log('    ' + msg.replace(/\s+/g, ' '));

console.log('\n  ── verdict ────────────────────────────────────────────────────────');
if (big.status === 200 && big.json && big.json.provider && big.json.provider !== victim.name) {
  console.log('  ✅ THE ROUTER FILTERED. A request only one endpoint could take was routed to that');
  console.log('  endpoint (' + big.json.provider + '), not gambled across the fleet. The effective floor for an');
  console.log('  unpinned ' + MODEL + ' request is ' + largest.toLocaleString() + ', not ' + smallest.toLocaleString() + '.');
} else if (big.status === 200) {
  console.log('  ⚠️ IT WAS SERVED BY ' + big.json.provider + ', whose declared window is ' + victim.context.toLocaleString() + '.');
  console.log('  Admission is on chars/4 but the endpoint tokenized it lower, so it fit. The gate is');
  console.log('  therefore NOT a guarantee — a denser prompt of the same estimate would have failed.');
} else {
  console.log('  🚨 THE ROUTER DID NOT FILTER — an unpinned request that DeepInfra could have served');
  console.log('  was refused. A long transcript can be rejected mid-task on a fallback leg.');
}
console.log('');
