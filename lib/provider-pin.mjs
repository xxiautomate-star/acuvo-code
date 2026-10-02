/**
 * ── 🔀⭐⭐⭐ THE PROVIDER PIN — ONE DEFINITION, AND THE COPIES DERIVE ────────
 *
 * Roman, 2026-09-18: *"these switches when a provider fucks up, we need to have
 * a process where the cheapest next one at that current moment goes through,
 * smoothly."*
 *
 * ⚠️⚠️ THIS FILE EXISTS BECAUSE THE TABLE BELOW WAS HAND-TYPED IN FOUR PLACES
 * AND THREE OF THEM WENT STALE. `model.mjs` recorded the first instance in its
 * own words — *"this one stale string was quietly overriding the cheaper route
 * it was meant to describe"* — and `rate-card.mjs` opens by naming the class:
 * *"one mistake copied eight times, and a copy has no way to know it is
 * stale."* Measured 2026-09-18, the copies were:
 *
 *     acuvo-code/lib/model.mjs        the table + DEFAULT_PROVIDER_ORDER   current
 *     acuvo-code/lib/plan.mjs         MODEL_PRICES[*].provider, retyped    current
 *     acuvo-gateway/lib/handler.mjs   the table + PINNED_PROVIDERS         STALE — `pin-drift` RED
 *     console/lib/provider-pin.ts     the table                            current, guarded
 *     console/vendor-agent/acuvo.mjs  the shipped BUNDLE                   STALE — and it RUNS
 *
 * ⭐ THE FIX IS AN IMPORT WHERE ONE IS POSSIBLE AND A GUARD WHERE IT IS NOT.
 * `model.mjs`, `plan.mjs` and the gateway now import this file, so those three
 * cannot drift by construction. `console/lib/provider-pin.ts` cannot — a Next
 * app importing a sibling package's `.mjs` breaks its Vercel build trace, the
 * constraint `rate-card.mjs` already documents — so it stays a mirror and
 * `provider-pin-is-single-source.test.mjs` fails the moment a table appears
 * anywhere it is not expected.
 *
 * ⚠️ ZERO IMPORTS, DELIBERATELY. Anything this file pulls in becomes something
 * the gateway and the bundle must resolve too, and `acuvo-code` ships with zero
 * runtime dependencies. The cost arithmetic therefore arrives as a CALLBACK
 * (`costOf` below) rather than being computed here — the price lives in
 * `rate-card.mjs` and there must not be a second opinion about it.
 */


/**
 * The model the CLI routes to by default. Mirrors `rate-card.mjs` `FLASH`.
 * ⚡ V4.1 since 2026-09-28, every plan (owner: *"speed is a moat"*).
 */
export const PINNED_PRIMARY_MODEL = 'deepseek/deepseek-v4.1-flash';


/**
 * ── ⚠️⚠️ A SINGLE GLOBAL PIN IS ONLY EVER CORRECT FOR ONE MODEL ─────────────
 *
 * `DEFAULT_PROVIDER_ORDER` was chosen by measuring FLASH, and the name it holds
 * **does not serve pro at all** — it is not among pro's 7 endpoints. So every
 * pro run asked for a provider that could not answer, the pin matched nothing,
 * `allow_fallbacks` did its job, and OpenRouter routed freely.
 *
 * MEASURED on the 13-task bench, 2026-08-15: **pro was served by the SAME
 * endpoint on 13 of 13 runs, and it was the dearest one available** — 2.8x the
 * cheapest endpoint on tokens and **28x on cache reads**.
 *
 * ⚠️ SO THE "pro costs 11.2x flash" FIGURE THIS PACKAGE QUOTES IS AN ARTEFACT OF
 * THAT, not a property of the model: it was measured on the most expensive pro
 * endpoint available, because nobody had pinned a cheap one. Pinned properly,
 * pro's cached reads are several times CHEAPER than flash's. A price ratio
 * measured through an unpinned route is a measurement of the routing.
 *
 * ⭐ SO THE PIN IS PER-MODEL. A provider list is a fact about a MODEL, not
 * about this package, and pretending otherwise silently unpins every model
 * except the one that was measured.
 *
 * ⚠️ EACH ENTRY IS A LIST, NOT ONE NAME. A single name plus `allow_fallbacks`
 * degrades to *anything* when that provider is down — which is how a cheap run
 * becomes an expensive one with no symptom. Two or three cheap endpoints in
 * order degrade to another CHEAP one first. Still a preference, never a lock:
 * "never single" is the standing rule and a cheaper request that does not
 * happen is not cheaper.
 *
 * Ranked from OpenRouter's per-model endpoint feed on 2026-08-15; the ORDER is
 * what matters and it is cheapest-first on the blend we actually send.
 */
/**
 * ── ⚠️⚠️ AND A NAME IN THIS TABLE IS NOT PROOF IT CAN BE REACHED ────────────
 *
 * MEASURED 2026-08-16 against the live account, `allow_fallbacks:false`, one
 * name at a time: most names answered, and **the first name on pro's list did
 * not** — it returns "No endpoints found" on both models, with or without any
 * parameter, despite the public feed reporting it healthy. That is an OpenRouter
 * **data-policy exclusion** on the account, not a typo and not an outage, and it
 * is fixed in the account settings, not here.
 *
 * ⚠️ SO PRO'S PIN HAD ALWAYS RESOLVED TO ITS SECOND NAME ALONE, and every layer
 * called it `pinTook`. That is exactly the silence `pinFellBack` was added to
 * end: pro runs now say "the first name did not serve N rounds" instead of
 * nothing.
 *
 * ⭐ THE UNREACHABLE NAME STAYS ANYWAY, FIRST. It is the right endpoint the
 * moment the policy allows it — several times cheaper at our real cache rate —
 * and deleting it would quietly convert a fixable account setting into a
 * permanent overpayment nobody remembers to revisit. ⚠️ A pin entry is
 * therefore not always a claim about today; `pinOutcome` is what tells you
 * which entries are actually serving.
 *
 * ⚠️ WHAT WAS ACTUALLY WRONG WITH PRO'S LIST IS THAT IT WAS ONE REACHABLE NAME.
 * The rule two paragraphs up — "a single name plus `allow_fallbacks` degrades to
 * *anything*" — was being broken by a pin that had a second entry on paper only.
 * With that one endpoint down, pro degraded to whatever answered, which measured
 * more than twice the price. The trailing entries exist so the degradation is
 * cheap-first instead of arbitrary.
 *
 * Re-checked against the live endpoint feed 2026-08-16.
 */
export const PROVIDER_PIN_BY_MODEL = Object.freeze({
  /**
   * ── 🚨 REPINNED 2026-08-27. THE OLD LIST WAS NOT THE CHEAPEST, AND ITS OWN
   *      COMMENT WAS FALSE ────────────────────────────────────────────────────
   *
   * It read `['StreamLake', 'Baidu', 'GMICloud']` above a comment claiming *"the
   * three cheapest are within 3% of each other."* Checked against the live
   * endpoint feed, that is wrong three ways:
   *
   *     StreamLake  $0.22 in / $0.66 out   ← 7.3x the cheapest, and pinned FIRST
   *     Baidu       $0.14 / $0.28
   *     GMICloud    $0.112 / $0.224        ← and status -2 (degraded)
   *
   *     OpenInference $0.03 / $0.10   Relace $0.06 / $0.12   DeepInfra $0.08 / $0.18
   *
   * Not within 3% (they span 2x), not the cheapest (they are 7th, 12th, 8th),
   * and one is degraded. **On 95M tokens at 80/20 with no cache, StreamLake
   * costs $29.26 against $18.11 of revenue — a loss — while DeepInfra costs
   * $9.50 (47.5% margin) and Relace $6.84 (62.2%).** Same model, same tokens.
   *
   * ⭐⭐ PROVIDER CHOICE IS THE LARGEST SINGLE LEVER ON THIS BUSINESS'S MARGIN,
   * larger than caching, and it was set wrong.
   *
   * ⚠️ THE ORDER IS FP8-FIRST ON PURPOSE, NOT CHEAPEST-FIRST. OpenInference and
   * Relace serve **fp4**; DeepInfra and Ambient the first is **fp8**. Aggressive
   * quantisation is a real quality risk on a coding model, and the parity
   * mandate is a promise about QUALITY as well as volume. So the primary was the
   * cheapest fp8 endpoint and the fall was to fp4.
   *
   * ── ⭐⭐⭐ SUPERSEDED 2026-09-10 — ROMAN TOOK THE PRECISION CALL ────────────
   *
   * *"sail research can be utilised mainly, as long as we always have the best priced
   * ones being used"* · *"and sail research is the best"*, asked directly about the
   * fp8→fp4 drop this paragraph was defending. **The fp8-first reasoning above is
   * kept deliberately** — it was right on its own terms and it is why the question
   * had to be put to him rather than folded into a price decision.
   *
   * ⭐ What decided it was evidence, not price: DeepInfra 429'd every build on
   * 2026-09-09, so the six-brief corpus that went SIX OF SIX was served largely by
   * Sail Research. fp4 at this workload shipped the corpus.
   *
   * ⚠️ A PRICE SORT WOULD PICK THE WRONG ONE. OpenInference is cheaper per token and
   * dearer in practice — it caches a fixed 17% against Sail Research's 99.98%, and on
   * a builder round the cached prefix is nearly the whole payload. It sits SECOND so
   * the fp8 floor is one hop away, not gone.
   *
   * ⚠️ `rate-card.mjs` RECORDS THIS LIST'S DEAREST AND CHEAPEST as its two rows.
   * Change this pin and that card must change with it. ⭐ THIS EDIT IS A REORDER, NOT
   * A MEMBERSHIP CHANGE — the same four names, so dearest and cheapest are untouched
   * and the card still describes this list. Adding or removing a name would not be.
   */
  // mirrors console/lib/provider-pin.ts — REORDERED 2026-09-11 (same four names, so rate-card.mjs still describes it):
  // Sail Research holds back a whole tool call for 49 s and the loop's idle watch kills it at 25 s; Relace streams it.
  // ⚠️ 2026-09-12, Roman's call: Sail DROPPED for Makora — 23 tok/s median, $0.30/M out against the card's $0.18
  // (the dearest member, which is what the card prices worst-case margin from), uptime 97.93%. Mirrors console/lib/provider-pin.ts.
  'deepseek/deepseek-v4-flash-0731': Object.freeze(['Relace', 'Makora', 'OpenInference', 'DeepInfra']),
  /**
   * ── ⚡⭐⭐⭐ V4.1 FLASH, EVERY PLAN — owner decision 2026-09-28 ──────────────────
   * Mirrors console/lib/provider-pin.ts, which carries the full measurement. In short, same
   * builder-sized prompt, 3,000 output tokens, streaming, 3 runs each (median):
   *   Makora 463 tok/s 7.5 s · Together 395 tok/s 8.5 s, first byte 420 ms · Modal 370 tok/s 8.6 s
   *   Parasail 405 tok/s BUT holds a whole streamed write_file back for 10.7 s (the Sail defect) — out
   *   CoreWeave 316 tok/s, cached 0 on both warm sends — out
   *   Relace 194 · DeepInfra 144 · Morph 277 tok/s: cheaper, slower — out, speed is the ruling
   * Cache on a 25.5k-token prefix: Together 99.9% (only AND order), Makora 96.4%.
   * All three list $0.30 / $1.20; Modal's cache read $0.030 vs $0.006 — 1.2x per builder call,
   * inside the 2x-the-cheapest-member rule. `rate-card.mjs` carries the envelope.
   */
  'deepseek/deepseek-v4.1-flash': Object.freeze(['Together', 'Makora', 'Modal']),
  // 8 endpoints, and the spread is enormous — this is the one that was costing us.
  // ⚠️ The first name 404s for this account (see above), so the second is the
  // cheapest one actually reachable, and the two after it keep the fall cheap.
  /**
   * ── ⚠️ NARROWED 2026-08-28, BY THE NEW `verify-rate-card.mjs` GUARD ────────
   *
   * It was `['DeepSeek','GMICloud','Fireworks','Cloudflare']`, and the guard's
   * FIRST RUN failed on it: the card claimed pro's dearest pinned rate was
   * $0.66, while **Fireworks and Cloudflare both charge $1.32/$3.96 — exactly
   * 2x DeepSeek**. A fallback at double the price is not a fallback, it is an
   * unbudgeted route, and `GOVERNING_WINDOW='peak'` means every budget would
   * have been quoting half the real ceiling.
   *
   * ⭐ Live feed, 14 endpoints, cheapest four:
   *     DeepSeek   $0.66  / $1.98  / $0.022   ← cheapest, pinned first
   *     StreamLake $1.115 / $3.346 / $0.037
   *     GMICloud   $1.122 / $3.366 / $0.037   ← dearest we will accept
   *     Fireworks  $1.32  / $3.96  / $0.044   ← DROPPED, 2x the primary
   */
  'deepseek/deepseek-v4-pro-0813': Object.freeze(['DeepSeek', 'StreamLake', 'GMICloud']),
  // Exactly one endpoint; pinning it changes nothing today and states the fact.
  'qwen/qwen3.7-flash': Object.freeze(['Alibaba']),
  'z-ai/glm-4.6': Object.freeze(['Venice', 'DeepInfra']),
  /**
   * ── 🚨⭐⭐ THE CHAIN'S OWN FALLBACK WAS THE ONLY UNPINNED MODEL WE ROUTE TO ─
   *
   * Roman's CLI-done item 1 is *"caching solid EVEN WHEN MODELS SWITCH"*, and
   * this was the hole in it. `buildChain` (`lib/chain.mjs:87`) falls to
   * `deepseek/deepseek-chat` when DeepSeek's flash leg fails — and that model
   * had **no entry in this table**, so the fallback round carried no pin at all
   * and went wherever OpenRouter chose. `turn.mjs:7911` had already caught the
   * event and named it exactly — *"an unpinned round is a round routed wherever
   * OpenRouter liked, which is a cold prefix cache"* — and then counted it
   * instead of closing it.
   *
   * ⭐ OBSERVED AGAIN ON A LIVE RUN, 2026-09-18: a real 6-round CLI task fell
   * through to this model and finished at **cache 17%** against the high-90s
   * the margin is sized on. The instrument worked; the pin did not exist.
   *
   * ⚠️⚠️ THE ORDER IS A CORRECTNESS CALL, NOT A PRICE ONE, AND IT IS THE
   * OPPOSITE OF WHAT THE CACHE TABLE ALONE WOULD SAY. Both facts are already in
   * this repo:
   *
   *     StreamLake  $0.2574 in / $1.0287 out   quant unknown   cache UNMEASURED
   *     DeepInfra   $0.3200 in / $0.8900 out   fp4             caches 95.9%,
   *                 and `model.mjs:1197` records an **undeclared 32,768-token
   *                 cap on this model's DeepInfra deployment**
   *
   * `CACHE_MEASURED` would argue DeepInfra first. It is second anyway, because
   * a hidden context cap is a FAILED RUN and a cold cache is only an expensive
   * one — and this model is reached precisely when the primary is already down,
   * which is the worst moment to discover a 32k ceiling. StreamLake is also the
   * cheaper of the two on input, which is where a coding session's tokens are.
   *
   * ⚠️ STREAMLAKE'S CACHE BEHAVIOUR IS UNMEASURED AND IS NOT BEING CLAIMED.
   * `model.mjs`'s rule stands — *"absence means unmeasured, never caches fine"*.
   * What this pin buys for certain is DETERMINISM: the same upstream every
   * fallback round instead of a lottery, which is the precondition for a warm
   * prefix rather than the proof of one. Measuring it is the follow-up.
   *
   * ⚠️ Only these two endpoints serve the model (live feed, 2026-09-18), so the
   * pin is the complete set and "never single" is satisfied by both being here.
   */
  'deepseek/deepseek-chat': Object.freeze(['StreamLake', 'DeepInfra']),
});

/**
 * ── ⚠️⚠️ DERIVED, NOT RETYPED. THIS IS THE STRING THAT WENT STALE ───────────
 *
 * It read `'StreamLake'` for weeks after `PROVIDER_PIN_BY_MODEL` and
 * `rate-card.mjs` were both corrected on 2026-08-27/28, and `model.mjs` wrote
 * the post-mortem next to it: *"I corrected two copies of the provider name and
 * left the third, on the same day I wrote the guard for that class of bug."*
 * `supply-lane-routing.test.mjs` held it to flash's first entry by ASSERTION.
 *
 * ⭐ AN ASSERTION IS THE SECOND-BEST ANSWER. It reports the drift after someone
 * types it; a derivation makes the drift unrepresentable. The invariant the old
 * test defended — "the default order is flash's pinned primary" — is now the
 * definition, so that test can only ever pass, which is the point.
 */
export const DEFAULT_PROVIDER_ORDER = PROVIDER_PIN_BY_MODEL[PINNED_PRIMARY_MODEL][0];

/**
 * ── ⚠️ NAMED FAILURES, KEPT RATHER THAN DELETED ─────────────────────────────
 *
 * A provider that has burned us must not be re-recommended by a future price
 * drop. ⭐ MIRRORS `console/lib/supply-watch.ts` `REFUSED`, and that file is the
 * one that explains WHY the list has to exist: cheapest-on-paper has already
 * been wrong here twice, and neither time could the price sheet have told us.
 *
 * ⚠️ IT IS A FLOOR, NOT THE WHOLE TEST. Absence from this map is not evidence a
 * provider is good — see `proven` in `costOrderedFallback`, which requires
 * POSITIVE evidence before it will move a name up the order.
 */
export const REFUSED_PROVIDERS = Object.freeze({
  'Sail Research': 'buffers a whole tool call — 49s silent on a 10KB write (2026-09-11)',
});

/**
 * ── 💰⭐⭐⭐ WHEN A LEG FAILS, THE NEXT ONE SHOULD BE THE CHEAPEST WE TRUST ──
 *
 * Roman's ask, at the top of this file. The hand-typed order is a snapshot of
 * the day it was typed, and the ground moves: measured live on 2026-09-18,
 * flash's pin runs `Relace → Makora → OpenInference → DeepInfra` while the
 * blended cost on our own traffic shape runs `Relace $0.0150 → DeepInfra
 * $0.0184 → Makora $0.0241` per million, and **OpenInference no longer serves
 * the model at all**. Position 2 was 24% dearer than position 4.
 *
 * ── ⚠️⚠️ THE FOUR RULES, AND EVERY ONE OF THEM IS A REFUSAL ────────────────
 *
 *   1. **POSITION 0 NEVER MOVES.** The primary is Roman's explicit call
 *      (2026-09-10, 2026-09-11, 2026-09-12, each on measured evidence that was
 *      not price). Re-sorting it on a price column would silently overturn an
 *      owner decision, which is the exact thing `supply-watch.ts` was written
 *      to refuse. This reorders the FALLBACK legs only.
 *   2. **NO NAME IS EVER ADDED.** The output is a permutation of the input, so
 *      a cheaper-but-unapproved provider can never be routed to by this
 *      function. Surfacing one is `supply-watch.ts`'s job and a human's call.
 *   3. **NO EVIDENCE, NO MOVE.** A name is only re-ranked when we hold BOTH a
 *      price for it (`costOf` returns a finite number) and positive evidence it
 *      works (`proven`). Everything else keeps its hand-typed position, in
 *      order, behind the ranked names. Cheapest-on-paper has been wrong twice.
 *   4. **A DEAD NETWORK CHANGES NOTHING.** `costOf` absent, or returning null
 *      for everything, yields the static order byte for byte. This machine sits
 *      behind a TLS-inspecting firewall that hangs the OpenRouter catalogue; a
 *      routing function that degrades when a price lookup fails would be a
 *      worse outage than the one it is trying to survive.
 *      `the-fallback-order-is-price-aware.test.mjs` pins all four.
 *
 * @param {readonly string[]} order the static pin, as configured.
 * @param {{ costOf?: ((provider: string) => number|null)|null,
 *           proven?: readonly string[]|null }} [opts]
 * @returns {{ order: string[], source: 'static' | 'cost', moved: boolean }}
 */
export function costOrderedFallback(order, { costOf = null, proven = null } = {}) {
  const base = Array.isArray(order) ? order.map((s) => String(s)) : [];
  if (base.length < 3 || typeof costOf !== 'function') return { order: base, source: 'static', moved: false };

  /** ⚠️ Rule 1 — the head is untouchable, so the tail is what gets sorted. */
  const head = base[0];
  const tail = base.slice(1);
  const trust = proven ? new Set(proven.map((p) => String(p))) : null;

  const ranked = [];
  const unranked = [];
  for (const name of tail) {
    /** ⚠️ Rule 3, and the REFUSED map is the hard floor underneath it. */
    if (Object.prototype.hasOwnProperty.call(REFUSED_PROVIDERS, name)) { unranked.push(name); continue; }
    if (trust && !trust.has(name)) { unranked.push(name); continue; }
    const c = costOf(name);
    if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0) { unranked.push(name); continue; }
    ranked.push({ name, c });
  }
  /** ⚠️ Rule 4 — nothing priced is nothing learned, so nothing moves. */
  if (ranked.length < 2) return { order: base, source: 'static', moved: false };

  /**
   * ⭐ STABLE. Two endpoints at an identical blended rate keep their configured
   * sequence rather than swapping on a sort implementation detail — a fallback
   * order that changes without a price changing is a bisect that lies.
   */
  ranked.sort((a, b) => (a.c === b.c ? tail.indexOf(a.name) - tail.indexOf(b.name) : a.c - b.c));

  const next = [head, ...ranked.map((r) => r.name), ...unranked];
  return {
    order: next,
    source: 'cost',
    moved: next.some((n, i) => n !== base[i]),
  };
}
