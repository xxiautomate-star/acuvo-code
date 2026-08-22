/**
 * ── ⭐⭐⭐ THE CACHE LIVES ON ONE UPSTREAM, SO STAY ON IT ─────────────────────
 *
 * Roman, 2026-08-19: *"the 90 percent caching has to stay permanent always.
 * Anytime Acuvo software is wrapping DeepSeek the caching must be that high 90s
 * otherwise we're cooked."*
 *
 * ⚠️ MEASURED ON A LIVE RUN THE SAME DAY — a 5-round task came back at
 * **cache 59%**, because one round was served by the pin's SECOND name:
 *
 *     served by StreamLake (1st choice)  11,520/11,714 cached  98.3%  $0.000172
 *     served by Baidu      (2nd choice)       0/11,714 cached   0.0%  $0.000791
 *
 * **4.6× the cost for byte-identical input.** Over 40 pinned calls the scatter
 * measured StreamLake 38 / Baidu 2 — a ~5% event, and 5% of rounds landing cold
 * is what turns 98% into 59% on a short task.
 *
 * ── ⚠️ WHY REORDERING THE PIN CANNOT FIX THIS ───────────────────────────────
 *
 * StreamLake was ALREADY first. `provider.order` is a preference, not a lock, so
 * OpenRouter may route past it whenever it likes. The only thing that forces
 * adherence is `allow_fallbacks: false`.
 *
 * ── ⚠️⚠️ AND WHY WE CANNOT SIMPLY SET THAT ON THE PIN ───────────────────────
 *
 * Two reasons, both measured and both in `model.mjs`:
 *
 *   1. **"Never single"** is this package's standing rule — a cheaper request
 *      that does not happen is not cheaper.
 *   2. A pinned name is **not proof it can be reached**. `deepseek-v4-pro`'s pin
 *      begins with `DeepSeek`, which answers *"No endpoints found"* for this
 *      account — an OpenRouter data-policy exclusion, not an outage. Forcing
 *      `allow_fallbacks:false` on the first name would cost EVERY pro round an
 *      extra failed hop, forever.
 *
 * ── ⭐ SO: LEARN, THEN LOCK ─────────────────────────────────────────────────
 *
 * Round 1 routes exactly as it does today — full preference list, fallbacks on.
 * We then read who actually served it off the response. That provider is now
 * **known-reachable** (it just served us) and **warm** (it holds our prefix), so
 * every later round in the session asks for that one name with fallbacks off.
 *
 * On any failure the warm pin is forgotten and the next round routes normally,
 * so a provider going down costs one round, not the session. "Never single"
 * survives: we still fall back — the difference is that we fall back *after an
 * explicit failure* instead of silently, mid-session, onto a cold cache.
 *
 * Pure and dependency-free: the state is a plain object the caller owns, so a
 * test needs no network and two sessions cannot contaminate each other.
 */

/** A fresh, empty memory of which upstream is warm for which model. */
export function freshWarmth() {
  return { byModel: new Map() };
}

/**
 * Record who actually served a round.
 *
 * ⚠️ ONLY EVER CALLED WITH A PROVIDER THE RESPONSE NAMED. Guessing here would
 * pin us to a provider that never served, which is the cold-cache bug with
 * extra steps.
 */
export function rememberWarm(state, model, provider) {
  const m = String(model ?? '').trim();
  const p = String(provider ?? '').trim();
  if (!state?.byModel || !m || !p) return state;
  state.byModel.set(m, p);
  return state;
}

/** Forget the warm provider for a model — call this on any failed round. */
export function forgetWarm(state, model) {
  const m = String(model ?? '').trim();
  if (state?.byModel && m) state.byModel.delete(m);
  return state;
}

export function warmProviderFor(state, model) {
  const m = String(model ?? '').trim();
  return (state?.byModel && m && state.byModel.get(m)) || null;
}

/**
 * The provider preference for the NEXT call.
 *
 * @returns {{ order: string[], strict: boolean, reason: string }}
 *
 * ⚠️ `strict` is only ever true alongside a single name we have SEEN SERVE a
 * round. It is never true for a name read from configuration — that is the
 * distinction between "this endpoint answered us 20 seconds ago" and "somebody
 * typed this", and only the first justifies removing the fallback.
 */
export function routeFor(state, model, baseOrder = []) {
  const base = Array.isArray(baseOrder) ? baseOrder.filter(Boolean) : [];
  const warm = warmProviderFor(state, model);

  if (!warm) {
    return {
      order: base,
      strict: false,
      reason: base.length
        ? 'first round of the session — routing on the configured preference, fallbacks on'
        : 'no pin configured',
    };
  }

  /**
   * ⭐ THE WARM NAME ALONE. Sending `[warm, ...others]` would be pointless: that
   * is a preference list again, and a preference list is exactly what let a
   * round land on Baidu while StreamLake sat first.
   */
  return {
    order: [warm],
    strict: true,
    reason: `${warm} served an earlier round and holds this session's prompt cache`,
  };
}

/**
 * Did this round land where the cache is?
 *
 * ⭐ Reported rather than merely acted on, because the failure this whole module
 * exists to fix was **invisible**: every layer called a fallback `pinTook: 1`
 * and a 4.6× bill looked like a healthy reading.
 */
export function describeRouting({ expected = null, served = null } = {}) {
  const e = String(expected ?? '').trim();
  const s = String(served ?? '').trim();
  if (!e || !s) return { warm: null, note: null };
  if (e === s) return { warm: true, note: null };
  return {
    warm: false,
    note: `${s} served this round instead of ${e}, so the prompt cache did not apply — `
      + 'the same bytes cost roughly 4.6× more. The next round will route normally and re-learn.',
  };
}

// ── ⭐⭐⭐ ACROSS SESSIONS, WHICH IS WHERE THE LAST 8 POINTS LIVE ─────────────
//
// Roman, 2026-08-19: *"the caching is inconsistent with what we said it would
// be, and we can't have that, it needs to be 90."*
//
// ⚠️ MEASURED, THREE LIVE RUNS: 59% → 74% → 82%. The remaining gap is ROUND ONE,
// and within a single session it is unfixable — nothing is cached before the
// first request. But the system prompt and the tool schemas are **byte-identical
// on every run this CLI ever makes**, and a provider's prefix cache lives
// upstream for minutes to hours. So round one only has to be cold ONCE, ever.
//
// ⭐ WE WERE THROWING THAT AWAY. Round one routed on the configured preference
// list with fallbacks on, so it could land on a different upstream than the last
// run — walking past a warm cache that already held our exact prefix.
//
// Persisting the name under HOME (never the workspace — see `account.mjs`'s
// argument, and note `WRITE_FORBIDDEN_ROOTS` does not cover `.acuvo`) means the
// next run starts warm. On a machine that runs this tool twice, round one is
// cached too, and the session average moves from the low 80s into the 90s.
//
// ⚠️ IT IS A HINT, NEVER A LOCK ON A COLD START. If the remembered upstream has
// gone away the round fails once, `forgetWarm` clears it, and the next attempt
// uses the full list — the same failure path the in-session lock already uses.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** Beside the credential, for the same reason it lives there rather than in a repo. */
export function warmthPath(env = process.env, home = homedir()) {
  const override = String(env?.ACUVO_HOME ?? '').trim();
  return join(override || join(home, '.acuvo'), 'warm-providers.json');
}

/**
 * Load what served us last time.
 *
 * ⚠️ NEVER THROWS. A corrupt or absent file means "we do not know", which is
 * exactly the state a first run is in — and a cache hint that could break a run
 * would be a worse trade than the hit rate it buys.
 */
export function loadWarmth(env = process.env, home = homedir()) {
  const state = freshWarmth();
  try {
    const raw = JSON.parse(readFileSync(warmthPath(env, home), 'utf8'));
    for (const [model, provider] of Object.entries(raw?.byModel ?? {})) {
      if (typeof provider === 'string' && provider.trim()) state.byModel.set(model, provider.trim());
    }
  } catch { /* unknown is a valid answer */ }
  return state;
}

/** Persist for the next run. Best-effort: never fail a completed run over a hint. */
export function saveWarmth(state, env = process.env, home = homedir()) {
  try {
    const path = warmthPath(env, home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ byModel: Object.fromEntries(state?.byModel ?? []) }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * ── ⭐⭐ ONE LINE FOR `/model`: WHAT ACTUALLY SERVED, AND WHAT IT COST ───────
 *
 * `aggregateProviders` in `turn.mjs` already counts this per turn, and
 * `formatSummary` prints it once when the turn ends. This is the same facts
 * worded for someone asking mid-session — the moment people actually ask,
 * because the question is "why is this costing more than it did".
 *
 * ⚠️ `pinFellBack` IS THE WHOLE POINT. A later name in the pin serving a round
 * is a cold prefix cache billed at up to 4.6x — measured on one byte-identical
 * payload, 98.3% cached on StreamLake and 0.0% on Baidu — and it raises no
 * error anywhere. `pinTook` and `pinMissed` are both loud by comparison. So the
 * silent case gets the sentence.
 *
 * ⚠️ RETURNS `null`, NOT A REASSURING STRING, when nothing is known. A
 * transport that reports no routing is UNKNOWN, and telling someone their
 * cache is fine on no evidence is worse than saying nothing — the same rule
 * `parseReply` follows when it leaves `provider` null rather than "unpinned".
 *
 * @param {{ pin?: string[]|null, served?: Record<string, number>, pinTook?: number,
 *           pinFellBack?: number, pinMissed?: number, roundsUnknown?: number }|null} providers
 * @returns {string|null}
 */
export function routingNote(providers) {
  if (!providers) return null;
  const served = Object.entries(providers.served ?? {});
  if (served.length === 0) return null;

  // Busiest first — the one that served most rounds is the one that matters.
  const ranked = [...served].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = ranked.reduce((n, [, count]) => n + count, 0);
  const where = ranked.length === 1
    ? ranked[0][0]
    : `${ranked.map(([name, count]) => `${name} x${count}`).join(', ')}`;

  const fellBack = Number(providers.pinFellBack ?? 0);
  const missed = Number(providers.pinMissed ?? 0);
  const pin = Array.isArray(providers.pin) && providers.pin.length > 0 ? providers.pin : null;

  const head = `served by ${where} over ${total} round${total === 1 ? '' : 's'}`;
  if (!pin) return `${head} — no provider pin, so the prompt cache is wherever routing landed.`;

  if (missed > 0 && fellBack === 0 && missed === total) {
    return `${head} — the pin (${pin.join(', ')}) matched nothing. Usually a name typo; `
      + 'the prompt cache is cold every round until it is fixed.';
  }
  if (fellBack > 0 || missed > 0) {
    const cold = fellBack + missed;
    return `${head} — ${cold} of ${total} round${cold === 1 ? '' : 's'} did NOT land on `
      + `${pin[0]}, so those paid a cold prefix cache (up to 4.6x the same bytes).`;
  }
  return `${head} — pinned to ${pin[0]} and it held every round, so the prompt cache applied.`;
}
