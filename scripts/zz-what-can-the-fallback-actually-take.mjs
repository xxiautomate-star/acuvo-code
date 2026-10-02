/**
 * ── 🚨⭐⭐⭐ THE DECLARED WINDOW IS NOT THE SERVED WINDOW ────────────────────
 *
 * `zz-does-the-router-filter-by-context.mjs` set out to ask which of
 * `deepseek/deepseek-chat`'s two machines answers an oversized request. It got
 * its answer — the router DOES filter, it skipped the 128,000 endpoint and
 * chose the 163,840 one — and then the 163,840 one said this:
 *
 *     Upstream error from DeepInfra: The sum of prompt length (109897.0),
 *     query length (0) should not exceed max_num_tokens (32768)
 *
 * ⚠️⚠️ **32,768.** The endpoint feed advertises 163,840 for that endpoint and
 * the deployment behind it serves a fifth of that. Every number in
 * `DECISION-the-first-fallback-is-unpinned.md`, in the compaction guard, and in
 * OpenRouter's own admission check is derived from the advertised figure.
 *
 * ⭐ THE WHOLE POINT OF THIS SCRIPT IS THAT ONE UPSTREAM ERROR IS AN ANECDOTE.
 * `max_num_tokens` could be a transient deployment, a per-key tier, or an
 * artefact of the max_tokens=1 we sent. So it measures a LADDER against each
 * endpoint by name and reports where each one actually stops.
 *
 *     node scripts/zz-what-can-the-fallback-actually-take.mjs           (dry)
 *     node scripts/zz-what-can-the-fallback-actually-take.mjs --spend
 *
 * ── 💰 WHY THIS IS CHEAPER THAN IT LOOKS ───────────────────────────────────
 *
 * A rejected request bills nothing, so every probe that FAILS is free and only
 * the ones that succeed cost. The ladder therefore walks DOWN from a size that
 * is expected to fail, and stops at the first success — which is the one probe
 * near the boundary and the only one anybody pays for. Spend is read off
 * OpenRouter's own `/api/v1/key` before and after, not estimated.
 */

import { readFileSync } from 'node:fs';

const SPEND = process.argv.includes('--spend');
const MODEL = 'deepseek/deepseek-chat';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** ⭐ OpenRouter admits on chars/4 — measured, see the sibling script. So a
 *  "size" here is in ITS currency; the real tokenizer runs ~27% lower on this
 *  filler, which is the direction that saves money. */
const LADDER_EST_TOKENS = [120_000, 90_000, 60_000, 45_000, 30_000, 20_000];

function key() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
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

async function usage(k) {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: 'Bearer ' + k } });
    const j = await r.json();
    return j && j.data && typeof j.data.usage === 'number' ? j.data.usage : null;
  } catch { return null; }
}

function filler(chars) {
  const unit = 'The compaction ceiling has to survive the smallest endpoint in the chain, not the largest one. ';
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

/**
 * ⭐ AN ERROR CAN ARRIVE INSIDE AN HTTP 200. The upstream refusal that started
 * this investigation came back as `200` with an `error` object — the same class
 * `chain.mjs` warns about under "an empty 200 is a failure". A probe that reads
 * only the status code would have recorded that refusal as a success and
 * concluded the endpoint serves 110k tokens.
 */
function outcome(r) {
  const err = r.json && r.json.error ? r.json.error : null;
  const message = String((err && err.message) || (r.status >= 400 ? r.text : '') || '').replace(/\s+/g, ' ');
  const served = r.status === 200 && !err && r.json && r.json.choices;
  const cap = /max_num_tokens \((\d+)\)/.exec(message);
  return {
    ok: Boolean(served),
    provider: (r.json && r.json.provider) || null,
    promptTokens: (r.json && r.json.usage && r.json.usage.prompt_tokens) || null,
    realPrompt: /prompt length \(([\d.]+)\)/.exec(message),
    declaredCap: cap ? Number(cap[1]) : null,
    message: message.slice(0, 220),
  };
}

const feed = await fetch('https://openrouter.ai/api/v1/models/' + MODEL + '/endpoints').then((r) => r.json());
const endpoints = (feed && feed.data && feed.data.endpoints ? feed.data.endpoints : [])
  .map((e) => ({ name: e.provider_name, context: e.context_length }))
  .sort((a, b) => a.context - b.context);

console.log('\n' + MODEL + ' — declared vs served\n');
for (const e of endpoints) console.log('  ' + e.name.padEnd(12) + ' declares ' + e.context.toLocaleString());

if (!SPEND) {
  console.log('\n  (dry run — pass --spend to walk the ladder)\n');
  process.exit(0);
}

const k = key();
if (!k) { console.error('\n  no OPENROUTER_API_KEY in the environment\n'); process.exit(1); }

const before = await usage(k);
const results = [];

for (const e of endpoints) {
  console.log('\n  ── ' + e.name + ' (declares ' + e.context.toLocaleString() + ') ' + '─'.repeat(30));
  let largestOk = null;
  let smallestFail = null;
  for (const est of LADDER_EST_TOKENS) {
    if (est > e.context) {
      console.log('    ' + String(est).padStart(7) + '  skipped — above its own declared window');
      continue;
    }
    const r = await post({
      model: MODEL,
      messages: [{ role: 'user', content: filler(est * 4) }],
      max_tokens: 1,
      provider: { only: [e.name], allow_fallbacks: false },
    }, k);
    const o = outcome(r);
    const tag = o.ok ? 'SERVED' : 'refused';
    console.log('    ' + String(est).padStart(7) + '  ' + tag.padEnd(8)
      + (o.promptTokens ? 'prompt_tokens ' + o.promptTokens : '')
      + (o.declaredCap ? '  cap says ' + o.declaredCap.toLocaleString() : ''));
    if (!o.ok && o.message) console.log('             ' + o.message);
    if (o.ok) { largestOk = { est, real: o.promptTokens }; break; }
    smallestFail = { est, cap: o.declaredCap, real: o.realPrompt ? Number(o.realPrompt[1]) : null };
  }
  results.push({ endpoint: e, largestOk, smallestFail });
}

const after = await usage(k);

console.log('\n  ── what each endpoint ACTUALLY serves ──────────────────────────────\n');
for (const r of results) {
  const d = r.endpoint.context;
  if (r.largestOk) {
    console.log('  ' + r.endpoint.name.padEnd(12) + ' declares ' + String(d.toLocaleString()).padStart(9)
      + ' · served ' + String(r.largestOk.real || r.largestOk.est).padStart(9) + ' real tokens'
      + (r.smallestFail ? '  · refused at ' + r.smallestFail.est.toLocaleString() + ' est' : ''));
  } else {
    console.log('  ' + r.endpoint.name.padEnd(12) + ' declares ' + String(d.toLocaleString()).padStart(9)
      + ' · served NOTHING on this ladder');
  }
  if (r.smallestFail && r.smallestFail.cap) {
    console.log('               ⚠️ its own error names a hard cap of ' + r.smallestFail.cap.toLocaleString()
      + ' — ' + (d / r.smallestFail.cap).toFixed(1) + '× less than it advertises');
  }
}

if (before !== null && after !== null) {
  console.log('\n  spend for this run: $' + (after - before).toFixed(4)
    + '  (OpenRouter /api/v1/key, before ' + before.toFixed(4) + ' → after ' + after.toFixed(4) + ')');
}
console.log('');
