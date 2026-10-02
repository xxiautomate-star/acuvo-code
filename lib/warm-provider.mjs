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
 *     served by the FIRST name    11,520/11,714 cached  98.3%
 *     served by the SECOND name        0/11,714 cached   0.0%
 *
 * **4.6× the cost for byte-identical input.** Over 40 pinned calls the scatter
 * ran about 19:1 in the first name's favour — a ~5% event, and 5% of rounds
 * landing cold is what turns 98% into 59% on a short task.
 *
 * ── ⚠️ WHY REORDERING THE PIN CANNOT FIX THIS ───────────────────────────────
 *
 * The warm name was ALREADY first. `provider.order` is a preference, not a lock,
 * so OpenRouter may route past it whenever it likes. The only thing that forces
 * adherence is `allow_fallbacks: false`.
 *
 * ── ⚠️⚠️ AND WHY WE CANNOT SIMPLY SET THAT ON THE PIN ───────────────────────
 *
 * Two reasons, both measured and both in `model.mjs`:
 *
 *   1. **"Never single"** is this package's standing rule — a cheaper request
 *      that does not happen is not cheaper.
 *   2. A pinned name is **not proof it can be reached**. One model's pin begins
 *      with a name that answers *"No endpoints found"* for this account — an
 *      OpenRouter data-policy exclusion, not an outage. Forcing
 *      `allow_fallbacks:false` on the first name would cost EVERY round of that
 *      model an extra failed hop, forever.
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

/**
 * A fresh, empty memory of which upstream is warm for which model.
 *
 * ⭐ `seenAt` IS A SECOND MAP RATHER THAN A RICHER VALUE, and that is a
 * compatibility decision, not a style one. `byModel` holds a plain provider
 * STRING and half a dozen call sites — including tests that seed damage
 * directly with `state.byModel.set(...)` — read it that way. Widening the value
 * to `{ provider, at }` would have rewritten every one of them for a field only
 * two functions care about.
 */
export function freshWarmth() {
  return { byModel: new Map(), seenAt: new Map() };
}

/**
 * Record who actually served a round.
 *
 * ⚠️ ONLY EVER CALLED WITH A PROVIDER THE RESPONSE NAMED. Guessing here would
 * pin us to a provider that never served, which is the cold-cache bug with
 * extra steps.
 */
/**
 * ── ⚠️⚠️ IT MAY ONLY REMEMBER A PROVIDER WE DELIBERATELY CHOSE ──────────────
 *
 * This function used to accept ANY non-empty string, and the consequences were
 * measured on 2026-08-25 from our own audit ledger:
 *
 *   ~/.acuvo/warm-providers.json had learned, for one real model, an upstream
 *   that is **not in `PROVIDER_PIN_BY_MODEL` at all** — i.e. not one of the
 *   endpoints anybody had chosen or priced. It then served **6 of 6** recorded
 *   runs, and it charged a multiple of the configured endpoints on CACHE READS
 *   specifically: the exact token type the whole cache strategy exists to
 *   maximise. A second entry held the single character `"P"`, which is not a
 *   provider at all — a truncated value, written once and honoured forever.
 *
 * ⭐ THE SHAPE OF THE BUG, WHICH IS THE PART WORTH REMEMBERING: a cache
 * OPTIMISATION had quietly become a routing DECISION, and it was making that
 * decision out of whatever string happened to come back on a response.
 *
 * ⚠️ THREE PROPERTIES MADE IT PERMANENT rather than a bad afternoon:
 *   1. `routeFor` pins with `strict: true` (`allow_fallbacks: false`), so the
 *      lock only releases on a FAILURE — and being 2-4x over list price is not
 *      a failure, it is a successful, expensive response.
 *   2. It is written under `homedir()`, so one stray round governs EVERY
 *      workspace on the machine.
 *   3. There is no TTL, so it outlives the reason it was learned.
 *
 * ⭐ THE FIX IS THIS PREDICATE, NOT DELETING THE FILE. Deleting it is 10
 * seconds and undoes itself on the next stray round; refusing to learn an
 * unchosen provider is what makes the deletion stick.
 *
 * ⚠️ An unrecognised model is allowed to learn freely — we have no opinion
 * about endpoints for a model we never priced, and refusing there would break
 * warmth for anything new.
 */
export function rememberWarm(state, model, provider, { now = Date.now() } = {}) {
  const m = String(model ?? '').trim();
  const p = String(provider ?? '').trim();
  if (!state?.byModel || !m || !p) return state;

  /**
   * ⚠️ A PLAUSIBILITY FLOOR, NOT VALIDATION. The file held the single character
   * `P` for `deepseek/deepseek-chat` — a model with no configured pin, so the
   * membership check below has no opinion on it and would have kept honouring
   * it. No real OpenRouter provider name is one character, so a length floor
   * costs nothing and stops obvious garbage being locked in with
   * `allow_fallbacks: false` forever.
   *
   * ⚠️ It does NOT explain where `P` came from. Something truncated a provider
   * name to its first character and nothing noticed, because a bad pin looks
   * exactly like a good one from the outside. That root cause is unfound —
   * recorded in TASKS.md rather than quietly floored over here.
   */
  if (p.length < 2) return state;

  const chosen = chosenProvidersFor(m);
  if (chosen && !chosen.includes(p)) return state;

  state.byModel.set(m, p);
  /**
   * ⚠️ STAMPED HERE AND NOWHERE ELSE, so "learned" and "when" cannot drift
   * apart. A `seenAt` that is missing is treated as unknown age, and
   * `pruneStale` drops unknown-age entries — see the third property in the
   * block below `pruneUnchosen`.
   */
  if (state.seenAt instanceof Map) state.seenAt.set(m, Number(now) || Date.now());
  return state;
}

/**
 * ── ⭐⭐⭐ "CHOSEN" IS THE UNION OF THE LANES, NOT THE DEFAULT PIN ──────────
 *
 * ⚠️⚠️ THIS PREDICATE READ `PROVIDER_PIN_BY_MODEL` DIRECTLY, AND THAT WOULD
 * HAVE SILENTLY KILLED THE SUPPLY LADDER THE DAY IT WAS SWITCHED ON. The pin
 * table answers "what do we ASK FOR by default". Once a session can run on the
 * economy lane, the endpoint that legitimately serves it is not in that table —
 * so `rememberWarm` would refuse to learn the provider that just served us,
 * every round, forever.
 *
 * ⭐ AND THE SYMPTOM WOULD NOT HAVE BEEN AN ERROR. It is a permanently cold
 * prefix cache: `routeFor` never gets a warm name, round 1's routing repeats on
 * every round, and the same bytes cost up to **4.6x** with an identical
 * transcript. That is the exact failure this whole module exists to end, and it
 * would have been re-introduced by the guard that was added to prevent it.
 *
 * ⚠️ IT IS A WIDENING, AND IT IS BOUNDED. `KNOWN_PROVIDERS_BY_MODEL` is every
 * name in every lane plus the default pin — i.e. every endpoint somebody chose
 * AND priced. `Novita`, the stray that caused the original incident by charging
 * a multiple on cache reads, is in none of them, so the guard still refuses it.
 * A model with no table at all still learns freely: we have no opinion about
 * endpoints for a model we never priced.
 */
function chosenProvidersFor(model) {
  return KNOWN_PROVIDERS_BY_MODEL[model] ?? PROVIDER_PIN_BY_MODEL[model];
}

/**
 * Drop any remembered provider we would no longer be willing to learn.
 *
 * ⚠️ Called on LOAD, because the damage is already on disk: the predicate above
 * stops new bad entries, and this clears the ones written before it existed. A
 * guard that only protects the future leaves the actual leak running.
 */
export function pruneUnchosen(state) {
  if (!state?.byModel) return state;
  for (const [model, provider] of [...state.byModel.entries()]) {
    const chosen = chosenProvidersFor(model);
    if (String(provider ?? '').length < 2 || (chosen && !chosen.includes(provider))) forgetWarm(state, model);
  }
  return state;
}

/**
 * ── ⭐⭐⭐ THE THIRD PROPERTY, WHICH WAS NEVER FIXED ─────────────────────────
 *
 * The header above lists THREE properties that turned one stray round into a
 * permanent machine-wide routing lock, and only two of them were closed. The
 * plausibility floor and the membership check closed (1) and (2). This is (3),
 * quoted from that block verbatim:
 *
 *     "There is no TTL, so it outlives the reason it was learned."
 *
 * ⚠️ AND THE REASON IT WAS LEARNED HAS A KNOWN, SHORT LIFETIME. The same header
 * states it: *"a provider's prefix cache lives upstream for minutes to hours."*
 * Past that window the entry is no longer evidence of WARMTH; it is evidence of
 * REACHABILITY, and reachability does not justify `allow_fallbacks: false` —
 * `routeFor` is explicit that strict is only ever earned by having "SEEN SERVE a
 * round", and a round from last week is not that.
 *
 * ⭐ THE COST OF EXPIRING TOO EAGERLY IS ONE COLD ROUND, which is exactly what a
 * machine with no file at all pays today. The cost of never expiring is a
 * fallback-free pin on an upstream whose cache is gone and whose price may have
 * moved — the shape of the incident this module was written for. The asymmetry
 * is why the window is short rather than generous.
 *
 * ⚠️ AN UNSTAMPED ENTRY IS DROPPED, and that is the migration. Every file
 * written before this existed holds bare strings with no `seenAt`, so their age
 * is unknowable — and "unknown age" must resolve the safe way, because the
 * whole point is that an old entry is the dangerous one. The cost is one cold
 * round, once, on each machine that upgrades.
 */
export const WARMTH_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Drop entries older than the window the cache they describe can survive.
 *
 * ⚠️ SEPARATE FROM `pruneUnchosen` ON PURPOSE. That one answers "would we learn
 * this at all"; this one answers "is it still true". Folding them together would
 * make every direct `state.byModel.set(...)` in the suite look expired, which is
 * how a guard starts failing correct work.
 */
export function pruneStale(state, { now = Date.now(), ttlMs = WARMTH_TTL_MS } = {}) {
  if (!state?.byModel) return state;
  for (const model of [...state.byModel.keys()]) {
    const at = state.seenAt instanceof Map ? state.seenAt.get(model) : undefined;
    if (!Number.isFinite(at) || now - at > ttlMs || at > now) forgetWarm(state, model);
  }
  return state;
}

/** Forget the warm provider for a model — call this on any failed round. */
export function forgetWarm(state, model) {
  const m = String(model ?? '').trim();
  if (state?.byModel && m) state.byModel.delete(m);
  // ⚠️ The stamp goes with the entry, or a re-learned model would inherit the
  // age of the one it replaced and expire early for no reason.
  if (state?.seenAt instanceof Map && m) state.seenAt.delete(m);
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
   * round land on the SECOND name while the warm one sat first.
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

/**
 * ── ⭐⭐⭐ WARMTH BELONGS TO THE MODEL THAT ANSWERED, NOT THE ONE WE ASKED ───
 *
 * ⚠️⚠️ MEASURED 2026-09-01, AND IT IS ACCEPTANCE ITEM #1 ("caching works
 * solidly, EVEN WHEN MODELS SWITCH") FAILING AT THE ROUTING LAYER. `turn.mjs`
 * recorded the round's provider against `config.model` — the model the user
 * CONFIGURED — while `chain.mjs` may have answered from a completely different
 * one. Probe output, real `runSession`, scripted chain, `$0.00`:
 *
 *     configured  deepseek/deepseek-v4-flash-0731   (pin DeepInfra, Ambient, Relace)
 *     answered    z-ai/glm-4.6                      (pin Venice, DeepInfra)
 *     served by   DeepInfra
 *     ~/.acuvo/warm-providers.json  ->  {"deepseek/deepseek-v4-flash-0731":"DeepInfra"}
 *     next routeFor(configured)     ->  {order:["DeepInfra"], strict:true}
 *
 * ⭐ `DeepInfra` IS IN BOTH MODELS' PIN LISTS, which is exactly why the
 * membership guard in `rememberWarm` waves it through: the name really is one
 * we chose and priced — for this model — it simply has never served THIS
 * MODEL'S PREFIX. So the next round asks for it with `allow_fallbacks: false`,
 * against a cold cache, having also removed the fallback that would have
 * rescued it. A cache OPTIMISATION becoming a routing DECISION for the second
 * time, through a door the first fix did not cover.
 *
 * ⚠️ AND THE LOSS IS DOUBLE. The model that actually answered — the one the
 * rest of the session will keep using — learned NOTHING, so every later round
 * re-routes on the preference list and can land anywhere.
 *
 * ⭐ THE RULE: the configured model was asked and did not answer, so its warmth
 * is unproven and is forgotten; the model that DID answer learns its own. Both
 * halves are the module's existing doctrine ("learn on success, forget on
 * failure") applied to the right subject.
 *
 * @param {any} state
 * @param {{ asked: string, served?: string|null, provider?: string|null,
 *           ok?: boolean, expected?: string|null, now?: number }} round
 * @returns {{ switched: boolean, learnedFor: string|null, note: string|null }}
 */
export function learnFromRound(state, { asked, served = null, provider = null, ok = false, expected = null, now = Date.now() } = {}) {
  const askedModel = String(asked ?? '').trim();
  /**
   * ⚠️ FALLS BACK TO THE ASKED MODEL, NEVER TO NULL. Most transports name the
   * model; a few stubs and older adapters do not, and treating "unknown" as "a
   * different model" would forget a perfectly good pin on every round.
   */
  const servedModel = String(served ?? '').trim() || askedModel;
  const switched = Boolean(askedModel) && servedModel !== askedModel;

  if (!ok) {
    forgetWarm(state, askedModel);
    return { switched, learnedFor: null, note: null };
  }
  if (!String(provider ?? '').trim()) return { switched, learnedFor: null, note: null };

  if (switched) {
    forgetWarm(state, askedModel);
    rememberWarm(state, servedModel, provider, { now });
    return {
      switched: true,
      learnedFor: servedModel,
      note: `${servedModel} answered this round, not ${askedModel} — warmth was recorded against `
        + `${servedModel}. ${askedModel} keeps no pin, because it was asked and did not reply.`,
    };
  }

  const landing = describeRouting({ expected, served: provider });
  if (landing.warm === false) forgetWarm(state, askedModel);
  rememberWarm(state, askedModel, provider, { now });
  return { switched: false, learnedFor: askedModel, note: landing.note };
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

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import { PROVIDER_PIN_BY_MODEL, KNOWN_PROVIDERS_BY_MODEL } from './model.mjs';

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
    /**
     * ⚠️ READ SEPARATELY AND NEVER SYNTHESISED. A file written before `seenAt`
     * existed has no stamps, and inventing `now` for them would make every
     * legacy entry look brand new — which is the one thing `pruneStale` exists
     * to stop. Missing stays missing, and missing means dropped.
     */
    for (const [model, at] of Object.entries(raw?.seenAt ?? {})) {
      if (Number.isFinite(at) && state.byModel.has(model)) state.seenAt.set(model, at);
    }
  } catch { /* unknown is a valid answer */ }
  /**
   * ⚠️ AGE FIRST, then chosen-ness. Both drop entries and the order does not
   * change the result, but reading it in the order the header lists the three
   * properties is how the next person finds them.
   */
  pruneStale(state);
  /**
   * ⚠️ PRUNE ON THE WAY IN. The file on this machine held an unchosen upstream
   * for one model and a single-character string for another — both written
   * before `rememberWarm` had a predicate, both then honoured on every run, in
   * every workspace, forever. Filtering only new writes would have left those
   * two entries in charge.
   */
  return pruneUnchosen(state);
}

/**
 * ── ⚠️⚠️⚠️ A TEST RUN MAY NOT WRITE THE MACHINE'S ROUTING LOCK ─────────────
 *
 * `node --test` sets `NODE_TEST_CONTEXT` in every test process and nothing else
 * does — a real `acuvo` run never has it. That one variable separates "a session
 * learned which upstream served it" from "a scripted stub returned a name".
 *
 * ⚠️ THE CONTAINMENT ABOVE IS CORRECT AND IS NOT ENOUGH ON ITS OWN.
 * `scripts/test.mjs` gives the run a throwaway `ACUVO_HOME`, and
 * `the-suite-never-writes-the-real-home.test.mjs` holds it there — but that only
 * protects invocations that go THROUGH the harness. Measured on this laptop
 * 2026-08-25: `C:/Projects/acuvo-code-public/scripts/test.mjs` (the published
 * clone, same `saveWarmth`) sets no `ACUVO_HOME` at all, and the documented way
 * to run one file — `node --test test/x.test.mjs` — bypasses the harness
 * entirely. In both cases `turn.mjs`'s closing `saveWarmth(warmth)` resolves to
 * `$HOME/.acuvo` again. A guard that lives in one repo's harness is a guard one
 * `cd` away from being off.
 *
 * ⭐ SO THE REFUSAL LIVES WITH THE WRITE. Proven by probe, both suites, every
 * `rememberWarm` argument logged: the values a test run persists are the
 * scripted stub names its fixtures return, against a `fake/model` id — names
 * that `routeFor` would then send as `allow_fallbacks: false` for EVERY
 * workspace on the machine, releasing only on a failure. The plausibility floor
 * in `rememberWarm` stops a one-character value; it has no opinion about a
 * well-formed stub name, because nothing about the STRING is wrong. Where it
 * came from is the wrong thing.
 *
 * ⚠️ IT REFUSES THE DEFAULT PATH ONLY. A test that passes an explicit
 * `ACUVO_HOME` is aiming at a directory it prepared, and persistence there is
 * the behaviour under test — `the-suite-never-writes-the-real-home.test.mjs`
 * asserts a session's warmth really does land under it, and that stays true.
 */
export function persistenceRefusedByTestRunner(env = process.env) {
  const underTestRunner = Boolean(String(env?.NODE_TEST_CONTEXT ?? '').trim());
  const aimedSomewhereDeliberate = Boolean(String(env?.ACUVO_HOME ?? '').trim());
  return underTestRunner && !aimedSomewhereDeliberate;
}

/** Persist for the next run. Best-effort: never fail a completed run over a hint. */
export function saveWarmth(state, env = process.env, home = homedir()) {
  /**
   * ⚠️ `false`, NOT A THROW. The caller's contract is that a completed run never
   * fails over a cache hint, and "we declined to write" is the same outcome for
   * it as "the disk was full" — which is the case the try/catch below already
   * reports this way.
   */
  if (persistenceRefusedByTestRunner(env)) return false;
  try {
    const path = warmthPath(env, home);
    mkdirSync(dirname(path), { recursive: true });
    const text = `${JSON.stringify({
      byModel: Object.fromEntries(state?.byModel ?? []),
      /**
       * ⚠️ WRITTEN EVEN WHEN EMPTY, because a reader has to be able to tell
       * "this version does not record ages" from "nothing has been learned yet",
       * and an absent key cannot say which.
       */
      seenAt: Object.fromEntries(state?.seenAt ?? []),
    }, null, 2)}\n`;

    /**
     * ── ⚠️⚠️⚠️ WRITE-THEN-RENAME, BECAUSE A PLAIN WRITE IS READ HALF-DONE ────
     *
     * MEASURED 2026-09-01. Six `acuvo` processes persisting warmth to one home
     * while a seventh read it — the documented fleet shape, and exactly what
     * `scripts/test.mjs` does with 24 test files that drive `runSession`:
     *
     *     17,775 reads · 5,343 of them UNPARSEABLE · 30.06%
     *
     * `writeFileSync` truncates and then fills, so a concurrent reader sees the
     * file mid-fill. The sample was a JSON object cut off after `byModel`.
     *
     * ⚠️ AND THE SYMPTOM IS SILENCE, WHICH IS WHY IT SURVIVED. `loadWarmth`
     * catches the parse error by design — *"unknown is a valid answer"* — so a
     * torn read is not an error, it is **cross-run warmth switched off**. That
     * costs the whole round-one cache: measured on this provider, a warm head
     * reads 96.1% cached and a cold one 0%.
     *
     * ⭐ RENAME IS ATOMIC — a reader sees the old file or the new one, never
     * half of either. The temp name carries the pid so two writers cannot
     * collide on the temp file itself.
     *
     * ⚠️ IT CAN STILL FAIL, AND FAILING IS FINE. On Windows a rename over a file
     * another process holds open can raise EPERM/EACCES. The catch below already
     * returns `false`, so the worst case is a skipped hint — strictly better than
     * the corrupt file it replaces. The temp file is removed on that path so a
     * failed write cannot litter the home directory.
     *
     * ⚠️ LAST WRITER STILL WINS on the CONTENT, and that is deliberate. Merging
     * two processes' entries would need a lock; the entries are hints that are
     * re-learned on the next round, so losing one costs a single cold round.
     * Corruption was the part that cost everything.
     */
    const temp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, text);
      renameSync(temp, path);
    } catch (err) {
      try { rmSync(temp, { force: true }); } catch { /* nothing else to try */ }
      throw err;
    }
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
 * payload: 98.3% cached on the first name, 0.0% on the second — and it raises
 * no error anywhere. `pinTook` and `pinMissed` are both loud by comparison. So
 * the silent case gets the sentence.
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
