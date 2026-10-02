# DECISION — the provider pins, costed 2026-09-18. Roman's call, not a terminal's.

> Roman: *"these switches when a provider fucks up, we need to have a process where the cheapest
> next one at that current moment goes through, smoothly."*
> And: *"we should always know what deepseek provider is the cheapest and gives the most usage, and
> we should always know when it's changing, and Acuvo be on the most efficient one, and switch to
> next efficient one if down."*
>
> Also: *"we were on StreamLake then switched off for some reason."*

**Three of the four requirements are BUILT and shipped in this change. The fourth — actually moving
a pin — is below, costed, and left to you.** Nothing in this branch changes which provider serves a
healthy round.

---

## What was built (no decision needed, nothing repinned)

| # | Requirement | Status |
|---|---|---|
| 1 | Know who is cheapest and gives the most usage | `console/scripts/zz-what-do-the-providers-cost-right-now.mts` — live, reads price + cache-read + context + quantisation per provider |
| 2 | Know when it CHANGES | `--snapshot` writes `provider-prices.snapshot.json` and diffs the next reading against it. **Nothing did this before, at all.** |
| 3 | Be on the most efficient one | the pin is now ONE definition (`acuvo-code/lib/provider-pin.mjs`); five hand-typed copies collapsed to one + one guarded mirror |
| 4 | Fail over to the next best when one is down | the CLI's second attempt is ordered by measured blended cost among providers we have PROVEN, falling back to the static order when unpriced |

---

## ⚠️ Why there is no "X% cheaper" anywhere below

It is the claim this repo keeps having to retract, because it hides which half moved. On
`deepseek/deepseek-chat`, StreamLake is **19.6% cheaper on input and 15.6% DEARER on output** — a
blended average would call that a win or a loss depending entirely on a traffic shape that moves.
Every comparison here names the column, and gives the crossover where there is a genuine trade.

⚠️ And **a two-column crossover is not enough either.** 77.5% of our input tokens are cache reads, so
the `input_cache_read` column decides most of our bill and appears on no comparison page. The first
live run of the new ranking printed *"StreamLake is cheaper than Inceptron on BOTH halves"* while
StreamLake's input was dearer — it won on the third column. That is fixed, and it is the reason the
ranking now names every column it compares.

---

## ⛔ DECISION 1 — flash: leave `Relace` as the primary, or move to `StreamLake`?

`deepseek/deepseek-v4-flash-0731` is the model nearly every build runs on. Live feed, 2026-09-18:

| provider | input /M | **cache read /M** | output /M | quant | notes |
|---|---|---|---|---|---|
| **Relace** (pinned 1st) | $0.0600 | $0.0120 | $0.1200 | fp4 | caches 98.7% (measured 2026-09-18) |
| **StreamLake** (not pinned) | $0.0596 | **$0.0019** | $0.1787 | **fp8** | **86% promotional discount** · caching UNMEASURED |
| DeepInfra (pinned 4th) | $0.0600 | $0.0150 | $0.1800 | fp8 | caches 95.9% |
| Makora (pinned 2nd) | $0.0900 | $0.0196 | $0.1950 | — | caches 95.9% |
| OpenInference (pinned 3rd) | — | — | — | — | **DOES NOT SERVE THIS MODEL** |

**Which column decides it:** the cache read. StreamLake is level with Relace on input, **dearer on
output**, and **6.3x cheaper on cache reads**. On our measured shape (77.5% cache reads, 0.9% output)
that is $0.0164/M against $0.0237/M.

**Three reasons this is not a terminal's call:**

1. ⚠️ **The 86% discount is a sale, not a rate.** `model.mjs` already wrote the rule after watching one
   narrow: *"a margin that only holds while somebody else runs a sale is not a margin."* Strip the
   discount and StreamLake prices at roughly $0.43/M input — the vendor list, and the dearest thing on
   the board.
2. ⚠️ **We have never measured StreamLake's cache.** The entire advantage above is its published
   cache-read rate. `CACHE_MEASURED` has no row for it, and this repo has been wrong about exactly
   this twice: OpenInference publishes competitively and caches a fixed 17%; Sail Research priced fine
   and buffered a whole tool call for 49 seconds. **Nothing routes to an unproven provider**, which is
   why the code does not and cannot take this decision.
3. ⭐ **It would be a precision UPGRADE, not a downgrade.** StreamLake serves fp8; Relace serves fp4.
   The fp8-first argument you overrode on 2026-09-10 was about a quality floor on a coding model — this
   candidate is on the right side of it.

**Recommended next step, if you want it:** route a slice to StreamLake and measure the cache with
`scripts/zz-does-the-pinned-endpoint-still-cache.mjs` (two byte-identical sends, one session id). That
is one command and it is the only missing fact.

---

## ⛔ DECISION 2 — flash's pin has a DEAD NAME in it

`OpenInference` sits third in the pin and **does not serve the model** — it is absent from the
endpoint feed, and `model.mjs` already records *"No allowed providers are available for the selected
model"*. So the pin is effectively three names, not four.

Removing it is a membership change, and `rate-card.mjs` records that a membership change moves the
card's `peak`/`offPeak` rows with it. **Left in place**; the new fallback ordering already puts it
last, because an unpriced name is never ranked.

---

## ⛔ DECISION 3 — pro's pin is in EXACT REVERSE cost order

`deepseek/deepseek-v4-pro-0813`, pinned `DeepSeek → StreamLake → GMICloud`:

| provider | input /M | cache read /M | output /M | pin position |
|---|---|---|---|---|
| StreamLake | $0.9834 | $0.03278 | $2.9502 | 2nd |
| GMICloud | $1.0560 | $0.03520 | $3.1680 | 3rd |
| **DeepSeek** | **$1.3200** | **$0.04400** | **$3.9600** | **1st** |

DeepSeek is now **dearest on all three columns** — no crossover, no trade-off. It was $0.66 and
cheapest by a wide margin on 2026-08-28; it has doubled since and nothing noticed, which is the exact
blindness requirement 2 exists to end.

⭐ **Low urgency, high embarrassment.** Your standing instruction is *"no Pro should ever be used"*, so
this costs nothing today — but every budget forecast quotes it.

---

## 🚨 DECISION 4 — `RATE_CARD` is wrong on three of its four rows, and budgets read it

The card's own rule is *peak = the dearest provider in our pin, offPeak = the cheapest*. Against the
live feed:

| row | card says | reality | effect |
|---|---|---|---|
| flash `offPeak` | $0.050 / $0.013 / $0.16 (OpenInference) | $0.060 / $0.012 / $0.120 (Relace) | names a provider that no longer exists |
| pro `peak` | $1.056 (GMICloud) | $1.320 (DeepSeek) | **the GOVERNING ceiling is 20% under the true worst case** |
| pro `offPeak` | $0.660 (DeepSeek) | $0.9834 (StreamLake) | forecasts understate pro by 49% |

⚠️ **Not corrected in this branch.** `budget.mjs` governs off `peak` and `plan.mjs` derives
`MODEL_PRICES` from both, so moving these rows moves every margin figure the product quotes — a
pricing decision. `PROVIDER_RATES` in the same file now carries the true per-provider column, and the
divergence is written into the card's own comments so the next reader cannot miss it.

---

## 🚨 DECISION 5 — the shipped agent bundle is eleven days stale, and it RUNS

`console/vendor-agent/acuvo.mjs` is a generated bundle of this package, staged into the builder's
sandbox by `agent-on-machine.ts` and traced into eight API routes. Last regenerated **2026-09-07**:

    bundle    DEFAULT_PROVIDER_ORDER 'DeepInfra'   flash ['DeepInfra', 'Ambient', 'Relace']
    source    DEFAULT_PROVIDER_ORDER 'Relace'      flash ['Relace', 'Makora', 'OpenInference', 'DeepInfra']

`Ambient` is **delisted** — it serves nothing. So every sandbox build asks for a dead endpoint as its
second choice and leads with the one that 429'd every build on 2026-09-09.

⛔ **Not regenerated here.** `npm run bundle` is one command and works offline, but it ships eleven days
of unrelated CLI change into the customer-facing builder, and this machine cannot open a build to
verify it (the OpenRouter catalogue hangs behind the firewall). It wants a lane that can drive the
product afterwards. `provider-pin-is-single-source.test.mjs` pins the bundle to *either* current *or*
the exact stale artefact, so a hand-edit or a half-regeneration fails.

---

## What runs every time you want to know

```bash
# who is cheapest right now, and what decided it — price, usable context, or precision
npx tsx console/scripts/zz-what-do-the-providers-cost-right-now.mts --snapshot

# ...and record this reading as the new baseline, once you have read the delta
npx tsx console/scripts/zz-what-do-the-providers-cost-right-now.mts --snapshot --write
```

⚠️ **"Most usage" is not the advertised context.** DeepInfra advertises 163,840 for `deepseek-chat`
and was measured **enforcing 32,768**. The ranking uses measured windows where we have them, stars
them, and disqualifies anything under 64,000 — because ranking on cost alone picks the crippled
endpoint, and that is how a long transcript on a fallback leg died with two healthy fallbacks untried.

---

## Why `console/lib/supply-watch.ts` was NOT wired into the CLI, and stays on the dark-modules allowlist

The brief asked: if wiring it is the clean way to make the fallback price-aware, wire it and delete
its allowlist entry. It is not, for two structural reasons and one conceptual one.

1. **`acuvo-code` ships with ZERO runtime dependencies and is published to npm.** A `.ts` module that
   lives inside a Next app cannot be a runtime dependency of a published CLI; there is no build step
   in that package and adding one to import one function would trade the headline property of the
   package for a sort.
2. **The console cannot import the CLI's `.mjs` at runtime either** — a Next app pulling a sibling
   package's `.mjs` breaks its Vercel build trace, the constraint `rate-card.mjs` documents and the
   reason `console/lib/provider-pin.ts` is a guarded mirror rather than an import.
3. ⭐ **And they answer different questions, so this is not duplicated logic.** `supply-watch.ts`
   asks *"should we CHANGE the pin?"* — it ranks every quote including unproven ones and surfaces
   candidates for a human. `costOrderedFallback` asks *"within the pin we already have, which leg do
   I try next?"* — it is a permutation and can never reach a name nobody approved. One exists to
   propose names, the other is forbidden from introducing them.

⚠️ **What WAS made single-source is the FACT, not the algorithm.** `REFUSED_PROVIDERS` in
`provider-pin.mjs` mirrors `supply-watch.ts`'s `REFUSED` — a provider that has burned us must not be
re-recommended by a future price drop, and that list is evidence, not logic. Both modules also price
against the same shape (77.5% cache reads, 0.9% output) taken from the same two sources.

⛔ **Its allowlist entry stays because it is still unwired**, and the entry's own reason is still
true: its surface is XXI HQ, which Roman deferred. Deleting the entry without wiring it is how a
module goes quiet.
