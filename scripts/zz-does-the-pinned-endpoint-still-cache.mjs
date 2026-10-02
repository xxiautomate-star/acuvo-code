/**
 * ── 💰⭐⭐⭐ RE-RUN THE PROBE `CACHE_MEASURED` IS FROZEN FROM ─────────────────
 *
 * `model.mjs` carries a hardcoded table dated **2026-09-01** saying Relace and
 * Ambient return no prompt cache, and `turn.mjs` prints a standing warning off
 * it on every run that lands there:
 *
 *   *"4 rounds served by Relace x4, which returned NO prompt cache when
 *   measured — byte-identical re-sends billed the same… DeepInfra warm measured
 *   3.6x cheaper than Relace ever is."*
 *
 * ⚠️ A REAL RUN ON 2026-09-18 PRINTED THAT WARNING AND, THREE WORDS EARLIER,
 * `cache 46% (24576 of 53447 prompt tokens)` — served by Relace on all four
 * rounds. The product held a live measurement and a frozen one, and believed
 * the frozen one.
 *
 * ⭐ THE TABLE'S OWN HEADER SAYS HOW TO SETTLE IT, so this script does exactly
 * that and nothing cleverer: *"THE COST IS THE PROOF, NOT THE TOKEN COUNT. A
 * provider that cached but declined to report `cached_tokens` would still bill
 * less on the second send."* Two byte-identical sends on one `session_id`;
 * report `cached_tokens` AND `usage.cost` for each.
 *
 *     node scripts/zz-does-the-pinned-endpoint-still-cache.mjs          (dry)
 *     node scripts/zz-does-the-pinned-endpoint-still-cache.mjs --spend  (~$0.002)
 *
 * ⚠️ TWO SENDS PER ENDPOINT IS A SMALL SAMPLE and the table says so about
 * itself. This can show a table row is WRONG; it cannot license a repin, which
 * `model.mjs` records as Roman's decision and wants a wider sample for.
 */

import { readFileSync } from 'node:fs';
import { CACHE_MEASURED, DEFAULT_MODEL, PROVIDER_PIN_BY_MODEL } from '../lib/model.mjs';

const SPEND = process.argv.includes('--spend');
const URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Big enough to clear any minimum-prefix threshold a cache may have. */
const PAYLOAD_CHARS = 32_000;

function key() {
  return process.env.OPENROUTER_API_KEY || null;
}

function filler(chars) {
  const unit = 'A prompt cache lives on one upstream, so the endpoint that answers decides the bill. ';
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

async function send(model, provider, body, k, sessionId) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + k,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://acuvo.xxiautomate.com',
      'X-Title': 'Acuvo Code',
      /** ⭐ The sticky key the CLI sends, so this probes the route production uses. */
      'X-OpenRouter-Session-Id': sessionId,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: body }],
      max_tokens: 4,
      provider: { only: [provider], allow_fallbacks: false },
      usage: { include: true },
    }),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* keep text */ }
  if (!j || j.error) return { ok: false, why: String(j?.error?.message ?? text).slice(0, 180) };
  const u = j.usage ?? {};
  return {
    ok: true,
    provider: j.provider ?? null,
    prompt: u.prompt_tokens ?? null,
    cached: u.prompt_tokens_details?.cached_tokens ?? 0,
    cost: typeof u.cost === 'number' ? u.cost : null,
  };
}

const model = DEFAULT_MODEL;
const pinned = PROVIDER_PIN_BY_MODEL[model] ?? [];
const measured = Object.keys(CACHE_MEASURED);
const targets = [...new Set([...pinned, ...measured])];

console.log('\nmodel: ' + model);
console.log('pinned order: ' + (pinned.join(', ') || '(none)'));
console.log('\nwhat CACHE_MEASURED claims today:');
for (const name of measured) {
  const row = CACHE_MEASURED[name];
  console.log('  ' + name.padEnd(12) + (row.caches ? 'caches' : 'DOES NOT CACHE').padEnd(16) + 'measured ' + row.at);
}

if (!SPEND) {
  console.log('\n  (dry run — pass --spend to re-probe each endpoint with two byte-identical sends)\n');
  process.exit(0);
}

const k = key();
if (!k) { console.error('\n  no OPENROUTER_API_KEY in the environment\n'); process.exit(1); }

const body = filler(PAYLOAD_CHARS);
const sessionId = 'acuvo-cache-probe-' + Date.now();

console.log('\n  two byte-identical sends per endpoint, same session id, ' + PAYLOAD_CHARS.toLocaleString() + ' chars\n');
console.log('  endpoint      send  prompt   cached     hit%     cost        table says   verdict');

const rows = [];
for (const name of targets) {
  const first = await send(model, name, body, k, sessionId);
  if (!first.ok) { console.log('  ' + name.padEnd(13) + ' unreachable — ' + first.why); continue; }
  const second = await send(model, name, body, k, sessionId);
  if (!second.ok) { console.log('  ' + name.padEnd(13) + ' second send failed — ' + second.why); continue; }

  const claim = CACHE_MEASURED[name]?.caches;
  const hit = second.prompt ? second.cached / second.prompt : 0;
  /**
   * ⭐ EITHER PROOF COUNTS, and the table's header explains why: a provider may
   * cache and not report `cached_tokens`, so a cheaper second send is evidence
   * on its own. Requiring both would miss exactly the case the header warns of.
   */
  const cheaper = first.cost !== null && second.cost !== null && second.cost < first.cost * 0.95;
  const caches = hit > 0.05 || cheaper;
  const verdict = claim === undefined ? 'unmeasured before'
    : (caches === claim ? 'agrees' : '🚨 TABLE IS WRONG');

  for (const [label, r] of [['1st', first], ['2nd', second]]) {
    console.log(
      '  ' + name.padEnd(13) + label.padEnd(6)
      + String(r.prompt ?? '?').padStart(6) + String(r.cached).padStart(9)
      + (r.prompt ? ((100 * r.cached) / r.prompt).toFixed(1) + '%' : '   —').padStart(9)
      + (r.cost === null ? '     —' : '$' + r.cost.toFixed(6)).padStart(12)
      + (label === '2nd' ? '   ' + (claim === undefined ? 'unmeasured' : claim ? 'caches' : 'no cache').padEnd(12) + verdict : ''),
    );
  }
  rows.push({ name, claim, caches, verdict, hit, first: first.cost, second: second.cost });
}

const wrong = rows.filter((r) => r.verdict.startsWith('🚨'));
console.log('\n  ── verdict ────────────────────────────────────────────────────────');
if (wrong.length === 0) {
  console.log('  CACHE_MEASURED agrees with the wire on every endpoint probed.');
} else {
  for (const r of wrong) {
    console.log('  🚨 ' + r.name + ': the table says ' + (r.claim ? 'it caches' : 'it does NOT cache')
      + ', the wire says ' + (r.caches ? 'it DOES' : 'it does not')
      + ' (second send ' + (100 * r.hit).toFixed(1) + '% cached'
      + (r.first !== null && r.second !== null ? ', $' + r.first.toFixed(6) + ' → $' + r.second.toFixed(6) : '') + ')');
  }
  console.log('\n  ⚠️ turn.mjs prints a standing warning off this table on every run that lands');
  console.log('     on a "does not cache" endpoint. A wrong row is a wrong sentence on screen.');
}
console.log('');
