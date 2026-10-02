# DECISION — the chain's first fallback is unpinned, and it cannot be cached

**Owner: Roman.** This is a supply decision, costed here and deliberately not taken.
Measured 2026-09-17. Nothing in this document has been shipped.

---

## The question

Roman's six-point definition of CLI-done opens with **"caching solid even when models
switch."** CLAUDE.md still lists it as the hard one and still open. This is what happens
today, measured on the real loop.

## What was already true, and is fine

Two guards cover the half everybody had looked at, and both are green:

| guard | what it holds |
|---|---|
| `test/cache-prefix-stability.test.mjs` | our bytes do not move between runs |
| `test/cache-survives-model-switch.test.mjs` | our bytes do not move across a model switch |

Re-measured end to end by `scripts/zz-cache-across-a-model-switch.mjs`, which drives the
actual `runSession` → `callChain` → `callModel` with only `fetch` scripted, and reads the
wire body of every round:

- **shared prefix across a mid-session model switch: 98.9%–100%.** Our half is clean.
- **the sticky `session_id` is one value for the whole run**, switches included — so
  OpenRouter's server-level stickiness is never thrown away by a fallback.
- **the warm lock is restored** the moment the primary answers again
  (`{"only":["Relace"]}` on every recovered round).

None of that is the problem.

## What is the problem

The same probe, same run, the `provider` block actually sent:

```
  #  model                            provider block
  1  deepseek/deepseek-v4-flash-0731  {"only":["Relace"]}                       ← locked
  2  deepseek/deepseek-v4-flash-0731  {"only":["Relace"]}                       ← locked
  3  deepseek/deepseek-chat           none                                      ← NOTHING
  7  z-ai/glm-4.6                     {"only":["Venice"]}                       ← locked
```

`buildChain` reaches three models. Two are pinned. **`deepseek/deepseek-chat` — the FIRST
fallback, the one reached the instant the primary has a bad minute — has no entry in
`PROVIDER_PIN_BY_MODEL`**, so `providerOrderFor` answers `{order:[],source:'none'}` and the
request goes out with no `provider` key at all: routed across the whole fleet, landing
wherever. That is the lottery `model.mjs` itself measured at **0% / 31% / 65% / 98%**.

### And the price is worse than the routing

Read off OpenRouter's own per-model endpoint feed, 2026-09-17. ⚠️ The `input_cache_read`
field is **absent** on both endpoints — checked explicitly rather than read as a number,
because a missing field deserialises to `0` and would have inverted the conclusion into
"cached input is free there".

| model | endpoint | in $/M | out $/M | cached input |
|---|---|---|---|---|
| `deepseek/deepseek-v4-flash-0731` *(primary)* | Relace | 0.060 | 0.120 | **0.012** |
| `deepseek/deepseek-chat` *(fallback 1)* | StreamLake | 0.2574 | 1.0287 | **not offered** |
| `deepseek/deepseek-chat` *(fallback 1)* | DeepInfra | 0.320 | 0.890 | **not offered** |
| `z-ai/glm-4.6` *(fallback 2, the floor)* | Venice | 0.430 | 1.750 | **0.080** |

The primary's warm blend at 99% cache is `0.99 × 0.012 + 0.01 × 0.060` = **$0.01248 per M
input tokens**. So the moment a round falls through to `deepseek/deepseek-chat`:

> **input costs 20.6× (StreamLake) to 25.6× (DeepInfra) what the same bytes cost on the
> primary — and no pin, no prefix discipline and no sticky key can reduce it, because
> neither endpoint sells a cached token at any price.**

### The second-order finding: the chain order is right cold and wrong warm

| leg | cold $/M in | warm (99%) $/M in | × primary warm |
|---|---|---|---|
| flash / Relace | 0.060 | 0.01248 | 1.0× |
| deepseek-chat / StreamLake | 0.2574 | **0.2574** (no cache) | **20.6×** |
| glm-4.6 / Venice | 0.430 | 0.0835 | 6.7× |

Cold, `deepseek-chat` is the cheaper fallback and the order is correct. **Warm — which is
every round after the first, i.e. almost all of them — the "floor" model `glm-4.6` is
3.1× cheaper per input token than the fallback sitting above it.** The chain was ordered
on list price, and list price is the wrong number for a product whose margin is the cache.

## The options

1. **Pin `deepseek/deepseek-chat`** to the cheaper of its two endpoints. Buys the routing
   half (one machine, stickiness preserved) and buys **nothing** on caching, because
   neither endpoint prices a cached read. Saves ~19% on that leg, not 20×.
2. **Reorder the chain** so `z-ai/glm-4.6` is the first fallback. On a warm session that is
   3.1× cheaper per input token; on a cold one it is 1.7× dearer. ⚠️ It also changes which
   model answers when the primary is down, which is a quality decision, not only a price one.
3. **Drop `deepseek/deepseek-chat` from the chain.** ⛔ This would leave two models, which
   still satisfies "never single", but `chain.mjs`'s header argues at length that GLM is
   the floor precisely so a DeepSeek outage is survivable — removing the middle rung makes
   the ladder shorter in the exact scenario it exists for.
4. **Leave it.** A fallback leg is rare by construction; 20× on a rare leg may simply be
   the correct price of staying up. This is the current state and it is defensible — it was
   just never *chosen*.

## What was shipped instead

- `scripts/zz-cache-across-a-model-switch.mjs` — the probe, $0.00, re-runnable.
- `test/the-chain-fallback-is-unpinned.test.mjs` — a guard that asserts the SHAPE: every
  model `buildChain` can reach is pinned **or** is a named exception carrying its measured
  cost and naming this document. `deepseek/deepseek-chat` is the one listed exception, so
  the guard is green today and goes red the moment a fourth unpinned model joins the chain,
  the exception outlives its model, or the primary itself loses its pin. All four
  assertions were mutation-tested.

## Why the pin was not just added

`PROVIDER_PIN_BY_MODEL`'s own header records this package pinning `StreamLake` from memory
at **7.3× the cheapest endpoint**, above a comment claiming "the three cheapest are within
3%" — wrong three ways. CLAUDE.md records the same class of mistake three more times. A
provider name typed by a terminal is exactly how that happens, and provider choice is
recorded in this repo as *"the largest single lever on this business's margin, larger than
caching."*

---

# ADDENDUM — 2026-09-18: the re-order measured, and a window nobody had checked

Re-measured through a new instrument, `scripts/zz-chain-order-warm-vs-cold.mjs`. It spends
nothing (a public GET on OpenRouter's endpoint feed — no key, no completion) and it exists
because this document carried live numbers, which CLAUDE.md warns against by name:
*"it should never have carried a live number at all… go read the instrument rather than
trusting a figure typed here."*

## 1. The numbers above have already moved

| | this doc (2026-09-17) | measured (2026-09-18) |
|---|---|---|
| where an unpinned `deepseek-chat` round lands, worst case | StreamLake $0.2574/M | **DeepInfra $0.3200/M** |
| fallback 1 vs fallback 2, warm | 3.1× | **3.83×** |
| fallback 1 vs fallback 2, cold | 0.60× | **0.74×** |

Direction unchanged, magnitude wrong within a day. Read the instrument.

## 2. ⭐ "3.1× cheaper warm" was comparing two warm legs, and a fallback leg does not start warm

This is the correction that changes the answer. `chain.mjs`'s own header says a prefix cache
**cannot cross a provider** — it is physically one host's KV store. The primary is pinned to
Relace; **both** fallbacks are a different host, so the FIRST round on either is cold,
whichever one it is. The comparison that decides the question is therefore over N
*consecutive* fallback rounds, not over two steady states:

```
  N   keep (deepseek-chat)   swap (glm-4.6)   cheaper
  1              $0.3200          $0.4300     keep
  2              $0.6400          $0.5135     swap
  4              $1.2800          $0.6805     swap
  8              $2.5600          $1.0145     swap
```

> **Break-even is 2 consecutive fallback rounds.** A one-round blip is cheaper on the
> current order; anything longer is cheaper swapped, and the gap widens without limit
> because `deepseek-chat` never sells a cached read at any price.

## 3. Is the re-order SAFE? — three checks, and the third is the answer

| check | verdict |
|---|---|
| does anything in the package depend on the chain's ORDER? | **No.** `buildChain` is consumed positionally only by `callChain`'s loop; no test asserts index 1, and `MAX_ATTEMPTS = 4` is unaffected. |
| does it break "never single"? | **No.** Same three models, same count. |
| does it break the context-window floor? | **No.** `deepseek/deepseek-chat` stays in the chain, so the smallest reachable window is unchanged by a swap. |

⛔ **But it is still not free, and the reason is not a number.** `chain.mjs` records Roman's
instruction — *"we aren't switching to Qwen at all dude… it's pure DeepSeek"* — and states
that `z-ai/glm-4.6` is kept as **the floor**: *"never preferred, only reached when DeepSeek
itself is down."* Promoting GLM above DeepSeek's own sibling means a single transient
DeepSeek 429 leaves the DeepSeek family entirely. That is a supply-and-quality decision
about which vendor answers for us, and it is Roman's, not a terminal's — the same rule that
stopped the pin.

**Recommendation to put to Roman, priced:** swap only if fallback legs in practice last more
than one round. That is measurable for $0 from the audit log's `modelsAnswered` chain once
enough real runs exist; today this workspace has too few to answer it, and saying so is the
honest state.

## 4. ⚠️ NEW FINDING — the compaction ceiling is sized against the wrong endpoint

`test/compaction-cache-economics.test.mjs` carried

```js
const SMALLEST_CHAIN_WINDOW = 163_840; // deepseek/deepseek-chat, read from the OpenRouter API
```

described as *"the smallest context window among the models `buildChain` actually falls back
to."* Read off the live feed, that model is served by **two** machines and they disagree:

| model | endpoint | context |
|---|---|---|
| `deepseek/deepseek-chat` | **StreamLake** | **128,000** ← the real smallest |
| `deepseek/deepseek-chat` | DeepInfra | 163,840 ← what the constant named |

And this is the one model in the chain with **no pin**, so nothing in this package chooses
which machine answers. At 128,000 the guard's own assertion fails:

```
  CONTEXT_BUDGET_TOKENS 96,000 × 1.5 + 12,000 reply = 156,000  >  128,000
                        96,000 × 1.3 + 12,000 reply = 136,800  >  128,000
```

so it is not a rounding argument — it fails across the whole density range the test itself
documents.

**What was NOT done, and why.** The constant was left at 163,840 and the tighter assertion
added as an explicit `todo` (printed on every run, does not redden the suite). Whether a
140k-token request can ever *reach* StreamLake is unmeasured: OpenRouter's router is
documented to exclude endpoints that cannot serve a request's context, and if that holds for
this account then 163,840 is the effective floor and the guard is correct — by luck rather
than by reasoning. Asserting 128,000 today would manufacture a red out of an assumption
about somebody else's router.

**The experiment that settles it:** one request to `deepseek/deepseek-chat`, unpinned, with a
prompt over 128k tokens; read `provider` off the response. Cost: one large-context
completion, roughly $0.04.

**If StreamLake can answer it, there are exactly two fixes and both are Roman's:**

1. **Pin `deepseek/deepseek-chat` to DeepInfra.** Costs **24% more per input token on that
   leg** ($0.3200 vs $0.2574) and nothing on the common path. Also buys the routing
   determinism this whole document is about.
2. **Lower `CONTEXT_BUDGET_TOKENS` from 96,000 to ~77,000.** Costs nothing in cash and
   *everything* in the wrong place: compaction fires sooner on every long run, on the
   COMMON path, to protect a RARE one — and each compaction moves the prefix, which is the
   margin.

Option 1 is better value on the numbers. It is still a pin, and pins are the thing this
document exists to leave alone.

---

# ADDENDUM — 2026-09-18 (later): the experiment was run, and §4's recommendation was backwards

§4 above wrote down one experiment, priced it at ~$0.04, and named two fixes — *"Option 1 is
better value on the numbers."* The experiment was run. **Option 1 was the worst available
move**, and the numbers it was chosen on were advertising.

Instruments, both re-runnable, both in this package:

    node scripts/zz-does-the-router-filter-by-context.mjs --spend
    node scripts/zz-what-can-the-fallback-actually-take.mjs --spend

## 1. The router DOES filter on context — and filtering picked the worse machine

A 145,000-estimate request, unpinned, was routed **away** from the 128,000 endpoint and onto the
163,840 one. The documented exclusion is real for this account. So §4's worry — *"a 140k request
might land on StreamLake"* — is answered: it cannot.

That is also the trap. The endpoint the router selects on the strength of the larger advertised
number is the one that can serve less.

## 2. 🚨 THE ADVERTISED WINDOW IS NOT THE SERVED WINDOW

| endpoint | advertises | actually serves |
|---|---|---|
| StreamLake | 128,000 | **90,950** real tokens, measured OK |
| DeepInfra | 163,840 | **32,768** — a hard cap named in its own error |

Verbatim, reproduced at four sizes (120k / 90k / 60k / 45k estimated), served at 30k:

```
Upstream error from DeepInfra: The sum of prompt length (90948.0),
query length (0) should not exceed max_num_tokens (32768)
```

**Five times less than it advertises.** Every number in this document, in the compaction guard,
and in OpenRouter's own admission check is derived from the advertised figure.

## 3. ⭐ OpenRouter admits on `chars / 4` — the same estimator this package uses

A 738,360-character prompt was refused as *"about 184601 tokens"*. 738,360 / 4 = 184,590. It does
not tokenize before it decides.

⭐ So `estimateMessagesTokens` and OpenRouter's gate compute the **same number**, and the
compaction guard's `× 1.5` "the estimator undercounts" margin was a guess applied across a unit
boundary. `CONTEXT_BUDGET_TOKENS` 96,000 + 12,000 reply = 108,000 < 128,000: **admitted, exactly,
by measurement rather than by fudge factor.**

## 4. ⛔ Both options in §4 were wrong

1. **Pin to DeepInfra** — this document's own recommendation — would make **32,768 the permanent
   ceiling of the entire fallback leg**, at 24% *more* per input token. It looked like the best
   move because it was chosen on a number the vendor publishes and does not honour.
2. **Lower `CONTEXT_BUDGET_TOKENS` to ~77,000** buys nothing: 77,000 estimated is still far above
   32,768 real. Dodging that cap needs a ceiling near ~25,000 — **below the 24,000 the two-water-mark
   fix exists to have escaped**, and it would compact more often on every long run to protect a rare
   leg. A ceiling cannot fix a cap five times under it.

## 5. ⭐ What actually shipped — the fix was in the error path all along

The refusal arrives as **HTTP 200 carrying an `error` and no `choices`**. `extractReply` replaced
the provider's sentence with *"the model returned no choices — nothing to act on"*, which matched
no rule in `isRetryable`, so **the chain stopped with `z-ai/glm-4.6` (200k window) untried** — on a
fallback leg, i.e. the run where the primary was already down. Nothing in the package had ever
matched on that string; it had no test.

⭐ This is the third costume of one defect. `chain.mjs` carries the argument for the empty-200
(*"the single most important line here"*) and `extractReply` carries it for the degenerate-200.
Both were written after the same hole cost a session.

- `lib/model.mjs` — `upstreamErrorMessage()`; the provider's sentence survives (name, size sent,
  size allowed).
- `lib/chain.mjs` — an upstream 200-error is retryable, so the chain steps to the next model.
- `test/upstream-200-error.test.mjs` — 7 tests, 3 mutations proven to bite, including an
  end-to-end `callChain` that recovers where it used to return `stoppedEarly`.

**How often this used to end a session:** unpinned routing measured at **1 DeepInfra in 12 rolls
(8%)**. ⚠️ Twelve rolls is a small sample and the honest range is wide; the finding that matters is
that it is *not zero*, which is all the mitigation needed.

## 6. ⛔ What is left, and it is the OPPOSITE of what §4 proposed

**Pin `deepseek/deepseek-chat` to `StreamLake`.** It is **24% cheaper** per input token ($0.2574 vs
$0.3200) **and** serves 2.8× more usable context (90,950 measured vs 32,768). Both halves of the
comparison favour it; §4 recommended the other one.

⛔ **Still not taken, and for the reason this document opens with** — a provider name typed by a
terminal is exactly how `StreamLake` got pinned at 7.3× the cheapest endpoint once before. It is
one line in `PROVIDER_PIN_BY_MODEL`, it is Roman's, and it is now the cheap option rather than the
expensive one.
