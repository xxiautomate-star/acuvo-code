/**
 * ── ⭐⭐⭐ ONE RATE CARD. EIGHT COPIES OF A NUMBER IS WHY ALL EIGHT WERE WRONG ─
 *
 * **DeepSeek restructured its pricing on 2026-08-16 and not one constant in this
 * repo moved.** `ECONOMICS.md` measured the damage from our own audit ledger:
 * `RATE_USD_PER_MILLION` was 3.1x/4.7x low, `MODEL_PRICES[flash]` 6.5x/9.6x low,
 * and the console's `FLASH_COST_MICROS_PER_MILLION` 6.6x low behind a comment
 * that said *"measured 2026-08-15"* — one day before the change.
 *
 * They were not eight independent mistakes. They were ONE mistake copied eight
 * times, and a copy has no way to know it is stale. This module is the copy that
 * the rest of `acuvo-code` reads, so the CLI now has exactly one place to be
 * wrong instead of two.
 *
 * ⚠️ IT CANNOT BE THE ONLY COPY IN THE REPO, AND THAT IS A REAL CONSTRAINT.
 * `acuvo-code` ships with **zero runtime dependencies** and `console/` is a Next
 * app that cannot import a sibling package's `.mjs` without breaking its Vercel
 * build trace. Worse, `console/lib/price-map.ts` — which already holds this exact
 * card, correctly — imports `codegen-cost.ts`, which imports `plan-catalog.ts`,
 * so the console constants importing it directly would be an import CYCLE.
 *
 * ⭐ SO THE ANSWER IS: one source per package, plus a GUARD THAT FAILS WHEN THEY
 * DISAGREE. `test/rate-card.test.mjs` pins this file against `lib/budget.mjs` and
 * `lib/plan.mjs`; `console/lib/rate-card-one-source.test.ts` pins all four copies
 * (this one, `console/lib/rate-card.ts`, `console/lib/price-map.ts`'s
 * `TIME_VARYING`, and `plan.mjs`'s `MODEL_PRICES`) against each other. That is
 * the `pricing-two-systems-ratchet.test.ts` pattern, applied to cost instead of
 * revenue.
 *
 * ── ⚠️⚠️ PEAK vs OFF-PEAK. THEY DIFFER BY EXACTLY 2x, AND IT MATTERS ────────
 *
 * DeepSeek bills a peak window Mon–Fri 01:00–04:00 and 06:00–10:00 UTC, and
 * charges HALF outside it. That is 35 of 168 hours — **peak is 20.8% of the
 * week, off-peak 79.2%** — so a single number is wrong four fifths of the time
 * in one direction and one fifth in the other.
 *
 * ⭐ EVERY GOVERNING NUMBER BELOW IS THE **PEAK** CARD. Two reasons, both
 * measured rather than assumed:
 *
 *   1. Over-pricing an unknown stops a run slightly early; under-pricing lets it
 *      overshoot, and only one of those shows up on a bill. `budget.mjs` already
 *      argues this for `DEFAULT_USD_PER_MILLION_TOKENS`.
 *   2. **We have actually been billed the peak card on a Saturday and a Sunday.**
 *      All six post-restructure ledger records reconcile to the peak column, and
 *      four of them are weekend runs — a reseller charging peak at the weekend is
 *      not passing through a peak, it is a flat markup. Assuming the off-peak
 *      column because the clock says so would have under-braked every one of them.
 *
 * The off-peak column is published here anyway, because a cost FORECAST (what
 * will a month cost?) is a different question from a governor ceiling (what must
 * I refuse to spend?), and only the second one should be pessimistic.
 *
 * ⚠️ OFF-PEAK IS WRITTEN OUT IN FULL, NOT COMPUTED AS `peak / 2`. The halving is
 * a fact about today's price sheet, not a law. The day DeepSeek makes off-peak
 * 40% instead of 50%, a `/2` keeps quietly agreeing with itself while being
 * wrong. (`console/lib/price-map.ts` made the same call for the same reason.)
 */

/**
 * The model the CLI actually routes to — `model.mjs` `DEFAULT_MODEL`.
 *
 * ⚡ V4.1 FLASH SINCE 2026-09-28, EVERY PLAN — owner decision (*"speed is a moat"*). The
 * previous id keeps its own rows below as `FLASH_0731`, so anyone who names it is still priced.
 */
export const FLASH = 'deepseek/deepseek-v4.1-flash';
/** The previous Acuvo Flash. Not routed by default; kept priced so a named run is never unpriced. */
export const FLASH_0731 = 'deepseek/deepseek-v4-flash-0731';
/** Escalation only. Roman, 2026-08-21: *"no Pro should ever be used"*. */
export const PRO = 'deepseek/deepseek-v4-pro-0813';

/**
 * The peak schedule, verified against api-docs.deepseek.com rather than inferred
 * from a price map — a published map carries the peak COLUMN and no clock, so
 * deriving the schedule from it would be deriving a clock from a photograph.
 *
 * ⚠️ WEEKDAYS ARE PART OF THE SCHEDULE. `lib/deepseek-hours.mjs` models the two
 * hour windows and has **no weekday check**, so it reports a peak on Saturday.
 * Recorded here so the two can be reconciled; fixing that file is not this
 * change (`ECONOMICS.md` action #8).
 */
export const PEAK_SCHEDULE = Object.freeze({
  id: 'deepseek-2026-08-16',
  /** `Date#getUTCDay()` convention, 0 = Sunday. Mon–Fri. */
  days: Object.freeze([1, 2, 3, 4, 5]),
  /** Half-open [start, end) in UTC hours. */
  hours: Object.freeze([
    Object.freeze({ start: 1, end: 4 }),
    Object.freeze({ start: 6, end: 10 }),
  ]),
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  asOf: '2026-08-16',
});

/** 35 of 168 hours. The "2x for a fifth of the week" number, computed not typed. */
export const PEAK_SHARE_OF_WEEK =
  (PEAK_SCHEDULE.hours.reduce((n, w) => n + (w.end - w.start), 0) * PEAK_SCHEDULE.days.length)
  / (24 * 7);

/**
 * USD per 1,000,000 tokens — the same unit every provider pricing page uses.
 *
 * ⚠️ `cachedInPerM` is the CACHE-HIT input rate. Pricing a cache hit at the miss
 * rate is what made a warm session look 8x dearer than it was; pricing a miss at
 * the hit rate is how a budget ceiling stops meaning anything. Both halves are
 * required and neither is optional.
 */
/**
 * ── 🚨🚨 CORRECTED 2026-08-27. THE OLD NUMBERS WERE A ROUTING DEFECT ────────
 *
 * This card previously read `peak: 0.44/1.32` and `offPeak: 0.22/0.66` and
 * claimed DeepSeek's published peak schedule as its source. **Both rows were a
 * misreading, and every margin figure this repo has produced was built on them.**
 *
 * ⚠️ Checked against the LIVE OpenRouter endpoint feed for this exact model id:
 * **29 providers serve it, with a 14.7x spread**, and the two old rows are
 * simply two rows of that table —
 *
 *     Novita / NextBit / AtlasCloud / Cloudflare  $0.44 in · $1.32 out  ← old "peak"
 *     DeepSeek / StreamLake / Fireworks / Reka    $0.22 in · $0.66 out  ← old "offPeak"
 *     DeepInfra / Ambient (fp8/fp4)               $0.08 in · $0.18 out
 *     Relace (fp4)                                $0.06 in · $0.12 out
 *     OpenInference (fp4)                         $0.03 in · $0.10 out  ← cheapest
 *
 * ⭐⭐ SO "PEAK VS OFF-PEAK" WAS NEVER THE VARIABLE. **Which provider serves the
 * request is.** The old card had enshrined the price of Novita — the very
 * upstream `warm-provider.mjs` had accidentally locked us onto, and which this
 * repo already recorded as a 4x cache-read markup — as if it were a list price.
 * A defect was written down as a rate and then reasoned from for eleven days.
 *
 * ⚠️ The 2026-08-16 note even SPOTTED the anomaly: *"we have actually been
 * billed the peak card on a Saturday and a Sunday… a reseller charging peak at
 * the weekend is not passing through a peak, it is a flat markup."* It drew the
 * right conclusion and then kept the numbers anyway.
 *
 * ── ⭐ WHAT THE TWO ROWS MEAN NOW ───────────────────────────────────────────
 *
 * The names are kept because `budget.mjs` and `plan.mjs` read them, but they no
 * longer mean clock windows:
 *
 *   · `peak`    = the DEAREST provider in our pin list — the conservative
 *                 ceiling a budget should assume. `GOVERNING_WINDOW` is 'peak',
 *                 so every budget quotes the ceiling. That is deliberate.
 *   · `offPeak` = the CHEAPEST in the pin list — what we pay on a good route.
 *
 * ⚠️ THE PIN LIST IS THE THING THAT MAKES THESE TRUE. See
 * `PROVIDER_PIN_BY_MODEL` in `lib/model.mjs`. If the pin changes, THESE NUMBERS
 * MUST CHANGE WITH IT — they are two rows of the same table, not independent
 * facts.
 *
 * ⚠️ AND CHEAPEST IS NOT AUTOMATICALLY RIGHT. OpenInference and Relace serve
 * **fp4**; DeepInfra and BaseTen serve **fp8**. Aggressive quantisation is a
 * real quality risk on a CODING model, and the parity mandate ("95M on A$29
 * must GENUINELY equal Claude Max usage") is a quality promise, not just a
 * volume one. The pin leads with fp8 for that reason and falls to fp4.
 */
export const VISION = 'qwen/qwen3.7-flash';
export const GLM = 'z-ai/glm-4.6';

export const RATE_CARD = Object.freeze({
  /**
   * ── ⚡ V4.1 FLASH — read from the live endpoint feed 2026-09-28 ─────────────
   *
   * Pin (`provider-pin.mjs`): Together → Makora → Modal, chosen on measured SPEED (owner's ruling)
   * with price as the tiebreak. All three list $0.30 in / $1.20 out; they differ only on the cache
   * read — Together and Makora $0.006, Modal $0.030. The two rows are the per-column envelope of
   * the pin (`verify-rate-card.mjs` checks exactly that): `peak` takes the dearest value in each
   * column, `offPeak` the cheapest.
   *
   * ⚠️ 3-5x THE `-0731` CARD PER TOKEN. That is the price of the speed, chosen knowingly; it is
   * written here rather than hidden behind the model-level list ($0.03483 / $0.60), which is the
   * cheapest endpoint on the board and not one we route to.
   */
  [FLASH]: Object.freeze({
    peak: Object.freeze({ inPerM: 0.30, cachedInPerM: 0.030, outPerM: 1.20 }),
    offPeak: Object.freeze({ inPerM: 0.30, cachedInPerM: 0.006, outPerM: 1.20 }),
    schedule: PEAK_SCHEDULE,
    source: 'https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints',
    asOf: '2026-09-28',
  }),
  [FLASH_0731]: Object.freeze({
    /**
     * ── ⚠️⚠️⭐⭐⭐ RE-READ FROM THE LIVE FEED 2026-09-10 ────────────────────────
     *
     * `scripts/verify-rate-card.mjs` found the card 19–33% out on five of six
     * flash figures. It read `DeepInfra $0.08/$0.016/$0.18` and `Relace
     * $0.06/$0.012/$0.12` — and `provider-pin.ts` had already recorded, in its own
     * prose, that the Relace numbers *"no longer exist"*. The card kept quoting
     * them anyway, and **every margin figure in the product is computed on this**.
     *
     * ⭐⭐ THE CACHE-READ RATE IS THE ONE THAT MATTERS AND IT MOVED THE WRONG WAY.
     * Sail Research charges **$0.020 per cached million against DeepInfra's
     * $0.016 — 25% MORE**. I had assumed the card's 20%-of-miss ratio carried
     * across providers and quoted Roman a +8% token gain from the repin on that
     * basis. It does not carry, and the arithmetic inverts once a cache is warm:
     *
     *     cold (0% cache)    Sail $0.088/M   vs DeepInfra $0.100/M   Sail 12% CHEAPER
     *     warm (78% cache)   Sail $0.0599/M  vs DeepInfra $0.0601/M  level
     *     hot  (99.98%)      Sail $0.0520/M  vs DeepInfra $0.0488/M  Sail 6.6% DEARER
     *
     * ⚠️ So the repin is NOT a price win at the cache rates we actually achieve.
     * It is an AVAILABILITY and LATENCY win — DeepInfra 429'd every build on
     * 2026-09-09 and a build that dies bills tokens and ships nothing — and Sail
     * reaches 99.98% cache where OpenInference reaches a fixed 17%. Judged at each
     * endpoint's MEASURED cache behaviour Sail still wins on blended cost
     * ($0.052/M against OpenInference's $0.067/M), but for that reason and not
     * because its sticker price is lower. Quote it that way.
     *
     * The two rows are the DEAREST and CHEAPEST PINNED PROVIDER (see
     * `rate-card.test.mjs`), never a clock and never "the primary" — the old
     * comment here said "the pin's primary" and sent me looking for a drift that
     * a reorder cannot cause.
     */
    /**
     * ── 🚨⭐ 2026-09-12: THE DEAREST MEMBER IS NOW MAKORA, AND THE OLD ROW WAS STALE ──
     *
     * This row read `Sail Research 0.065 / 0.020 / 0.18` and Sail had since moved to **$0.30/M
     * output** — so the ceiling we budget against was 67% under the real worst case, and
     * `verify-rate-card.mjs` did not flag it (it checks the card against itself, not the feed).
     * Roman dropped Sail for Makora on the speed evidence; this row follows the list.
     *
     * Makora, live feed 2026-09-12: in $0.09 · cached $0.0196 · out $0.195 (quantisation
     * unpublished — it is the fallback, never the primary). Relace, the primary, is cheaper on all
     * three ($0.065 / $0.016 / $0.18), so a normal build is unchanged; this is the ceiling only.
     */
    /** Makora — the dearest we now route to. The ceiling we budget against. */
    peak: Object.freeze({ inPerM: 0.09, cachedInPerM: 0.0196, outPerM: 0.195 }),
    /** OpenInference — fp8, cheapest on all three token types. */
    offPeak: Object.freeze({ inPerM: 0.050, cachedInPerM: 0.013, outPerM: 0.16 }),
    schedule: PEAK_SCHEDULE,
    source: 'https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash-0731/endpoints',
    asOf: '2026-09-10',
  }),
  [PRO]: Object.freeze({
    /**
     * ── ⚠️ CORRECTED 2026-08-28 — PRO WAS LEFT ON MODEL-LEVEL LIST ───────────
     *
     * On 2026-08-27 I corrected FLASH to its pinned endpoint's real price and
     * left PRO at the model-level figure ($1.122/$3.366). **That asymmetry was
     * itself a defect**: it made pro look 14x flash, and `plan-economics`
     * correctly went red on a ratio that no longer described anything.
     *
     * Pulled PRO's own endpoint feed — 14 providers, and **DeepSeek's own
     * endpoint is the cheapest by a wide margin**, which is exactly where
     * `PROVIDER_PIN_BY_MODEL` already points pro:
     *
     *     DeepSeek    $0.66 / $1.98 / $0.022   ← pinned first
     *     StreamLake  $1.115 / $3.346 / $0.037
     *     GMICloud    $1.122 / $3.366 / $0.037  ← what the card wrongly carried
     *     Novita      $1.32 / $3.96 / $0.132
     *
     * ⭐ AND THE CORRECTION RESTORES A RULE THE WRONG CARD HAD KILLED. Against
     * flash, pro is **8.25x on fresh input but only 1.4x on a cache read**. So
     * *"pro's premium collapses as the cache warms"* — struck as false on
     * 2026-08-25 — is TRUE again, and was only ever falsified by the bad card.
     */
    /**
     * ⚠️⚠️ AND THEN THE NEW GUARD CAUGHT ME ON ITS FIRST RUN. I set BOTH rows to
     * DeepSeek's $0.66 — but this card's own rule is *peak = the DEAREST
     * provider in the pin*, and pro's pin still contained **Fireworks and
     * Cloudflare at $1.32/$3.96, exactly 2x DeepSeek**. Every budget would have
     * quoted half the real ceiling.
     *
     * ⭐ `scripts/verify-rate-card.mjs` found that in one run, which is the
     * entire argument for it existing: eleven days of wrong numbers happened
     * because every test checked the card against ITSELF.
     *
     * The pin is narrowed to DeepSeek → StreamLake → GMICloud, so:
     */
    /**
     * GMICloud — the dearest we will now route to.
     * ⚠️ Re-read from the live feed 2026-09-10: it had drifted 6% on all three
     * (card 1.122/0.0374/3.366 against a real 1.056/0.0352/3.168). Small, and
     * still the wrong direction — an overstated ceiling makes pro look dearer
     * than it is and pushes escalation decisions the wrong way.
     */
    peak: Object.freeze({ inPerM: 1.056, cachedInPerM: 0.0352, outPerM: 3.168 }),
    /** DeepSeek's own endpoint — cheapest, pinned first. */
    offPeak: Object.freeze({ inPerM: 0.66, cachedInPerM: 0.022, outPerM: 1.98 }),
    schedule: PEAK_SCHEDULE,
    source: 'https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-pro-0813/endpoints',
    asOf: '2026-09-10',
  }),
  /**
   * ── ⚠️⚠️ MOVED HERE FROM `plan.mjs` ON 2026-08-28 — IT WAS A SECOND TABLE ──
   *
   * Roman: *"fix the two price tables, this economics and pricing shit has
   * fucked us and the real ones need to be unforgettable."*
   *
   * `MODEL_PRICES` derived FLASH and PRO from this card, so those two could not
   * drift — but it HAND-TYPED qwen and glm, and nothing compared them to
   * anything. That is the shape of the 7x error: a second copy of a price that
   * no guard reads. ⚠️ And qwen is not a spare — **it is THE EYES**, the only
   * leg that can receive an image, so its price was live and unverifiable.
   *
   * ⚠️ NO PEAK/OFF-PEAK SPLIT FOR THESE. That variable does not exist — it was
   * the routing defect this file already documents. Both windows carry the same
   * rate rather than inventing a schedule nobody publishes.
   */
  [VISION]: Object.freeze({
    peak: Object.freeze({ inPerM: 0.030, cachedInPerM: 0.0060, outPerM: 0.130 }),
    offPeak: Object.freeze({ inPerM: 0.030, cachedInPerM: 0.0060, outPerM: 0.130 }),
    schedule: PEAK_SCHEDULE,
    source: 'https://openrouter.ai/api/v1/models/qwen/qwen3.7-flash/endpoints',
    asOf: '2026-09-10',
  }),
  [GLM]: Object.freeze({
    peak: Object.freeze({ inPerM: 0.430, cachedInPerM: 0.0800, outPerM: 1.750 }),
    offPeak: Object.freeze({ inPerM: 0.430, cachedInPerM: 0.0800, outPerM: 1.750 }),
    schedule: PEAK_SCHEDULE,
    source: 'https://openrouter.ai/api/v1/models/z-ai/glm-4.6/endpoints',
    asOf: '2026-09-10',
  }),
});

/**
 * ── ⚠️⭐ WHAT WE WERE ACTUALLY CHARGED, WHICH IS NOT THE LIST PRICE ─────────
 *
 * Not a card to price against — EVIDENCE, kept so the derivation above can be
 * re-checked against real money instead of re-argued. `ECONOMICS.md` solved for
 * the card that reproduces the recorded `costUsd` from the recorded token split
 * across six audit records; **five of six reconcile to eight decimal places**:
 *
 *     cache-miss $0.44/M   ·   cache-HIT $0.028/M   ·   output $1.32/M
 *
 * ⭐ MISS AND OUTPUT ARE THE PEAK LIST PRICE EXACTLY. The cache read is **4x**
 * list, and only the cache read. That is the signature of a reseller markup, not
 * of a peak window: `warm-provider.mjs` had learned-and-locked onto **Novita**, a
 * provider that appears nowhere in our configured preference
 * (`['StreamLake','Baidu','GMICloud']`), and wrote the pin to `$HOME` with no TTL
 * so it governed every workspace.
 *
 * ⚠️ AND THE MARKUP LANDED ON EXACTLY THE TOKEN WE ARE TRYING TO MAXIMISE. The
 * better our caching gets, the larger the marked-up share of the bill becomes.
 *
 * The pin is fixed as of commit 09d238601, so the LIST card above is the right
 * thing to price against going forward. This constant exists so that the day the
 * ledger stops matching list, a test can say which of the two moved.
 */
export const BILLED_OBSERVED_FLASH = Object.freeze({
  inPerM: 0.44,
  cachedInPerM: 0.028,
  outPerM: 1.32,
  window: 'peak',
  basis: 'ECONOMICS.md §2 — 6 audit records 22–23 Aug 2026, 5 reconcile exactly',
});

/**
 * ── ⚠️⚠️ THE OUTPUT SHARE, MEASURED THREE TIMES, AND NOW LOAD-BEARING ───────
 *
 * Output is **0.9% of the tokens** on a real 3-round run (33,258 prompt of
 * 33,544 total), and `ECONOMICS.md` re-measured **0.34%–0.56%** across the
 * surviving ledger. 0.9% is kept as the pessimistic end of the observed band.
 *
 * ⭐ THIS STOPPED BEING A ROUNDING DETAIL ON 2026-08-16. Under the old card
 * output was 2x input, so assuming a wrong output share cost you a few percent.
 * Under the new card output is **3x** input, so the console's undocumented
 * "88% input / 12% output" assumption — 13x the measured share — inflates the
 * modelled cost of a million flash tokens by **2.7x** all by itself. Half of
 * what looked like a margin collapse was that assumption, not the price rise.
 *
 * ⚠️ Kept in sync with `plan.mjs`'s `OUTPUT_TOKEN_SHARE` by
 * `test/rate-card.test.mjs`; two numbers for one fact is the disease this module
 * exists to treat.
 */
export const OUTPUT_TOKEN_SHARE = 0.009;

/**
 * ── 💵⭐⭐⭐ REAL US$ PER MILLION TOTAL TOKENS ON THE ROUTE — EVERY PLAN CAP'S ONE INPUT ──
 *
 * Owner ruling 2026-09-28: advertised allowances are FIXED, and each plan's dollar cap is
 * exactly what those tokens cost — `advertised millions × THIS` (`plan-allowance.mjs`
 * `SUPPLY_CAP_USD`, console `plan-catalog.ts` `tierSpendCapUsdMicros`).
 *
 * Measured from production `console.cli_usage`, 2026-09-28: `deepseek/deepseek-v4.1-flash`,
 * upstream Together (the pinned primary), last 7 days — 146 calls, 4,262,795 total tokens
 * (94.7% of prompt cached), US$0.3256544 → US$0.076395/M, rounded UP to 0.0764.
 *
 * ⚠️ A COPY OF `console/lib/rate-card.ts` `MEASURED_BLENDED_USD_PER_M` — that file's docblock
 * carries the full measurement and the SQL to re-measure it; `rate-card-one-source.test.ts`
 * fails when the two disagree. Re-measure it; never re-type it.
 */
export const MEASURED_BLENDED_USD_PER_M = 0.0764;

/** The window every governing constant is priced at. See the header. */
export const GOVERNING_WINDOW = 'peak';

/**
 * ── 💰⭐⭐⭐ PER-PROVIDER RATES — THE COLUMN THE CARD ABOVE COLLAPSES ──
 *
 * Roman, 2026-09-18: *"these switches when a provider fucks up, we need to have
 * a process where the cheapest next one at that current moment goes through,
 * smoothly."*
 *
 * ⚠️⚠️ `RATE_CARD` ABOVE CANNOT ANSWER THAT. It keeps two rows per model —
 * the DEAREST and CHEAPEST pinned provider — which is exactly right for a budget
 * ceiling and useless for choosing a fallback, because it does not say WHICH
 * provider either row is. Ranking a fallback leg needs the whole column.
 *
 * 🚨🚨 AND READING THE WHOLE COLUMN IS HOW WE FOUND THAT `RATE_CARD` ABOVE IS
 * WRONG ON THREE OF ITS FOUR ROWS. The card's own rule is *peak = the DEAREST
 * provider in our pin, offPeak = the CHEAPEST*. Against this table:
 *
 *     flash offPeak  card $0.050/$0.013/$0.16   names OpenInference, which is GONE
 *                    real $0.060/$0.012/$0.120  (Relace, the pinned primary)
 *     pro   peak     card $1.056 (GMICloud)     real $1.320 (DeepSeek) — the
 *                    GOVERNING ceiling is 20% under the true worst case
 *     pro   offPeak  card $0.660 (DeepSeek)     real $0.9834 (StreamLake) — 49% under
 *
 * ⚠️⚠️ NOT CORRECTED HERE. `budget.mjs` governs off `peak` and `plan.mjs`
 * derives `MODEL_PRICES` from both, so moving these rows moves every margin
 * figure the product quotes. That is a pricing decision and it is Roman's;
 * `DECISION-provider-pins-2026-09-18.md` costs it. `PROVIDER_RATES` is what an
 * instrument should read until then, and `scripts/verify-rate-card.mjs` is the
 * one that checks the card against the market.
 *
 * ⚠️⚠️ REFRESHED BY `npx tsx console/scripts/zz-what-do-the-providers-cost-right-now.mts --rate-card`,
 * NOT BY HAND. That script is the one fetcher in the repo for this question; a
 * second one would be the defect this file's own header opens by describing.
 * ⚠️ `scripts/gen-price-map.mjs` cannot help — it reads the 4,000-entry
 * catalogue, which hangs behind this machine's TLS-inspecting firewall, while
 * the per-model endpoint route returns ~2 KB and passes.
 *
 * 🚨 WHAT THE 2026-09-18 READ FOUND, AND IT IS THE ANSWER TO ROMAN'S QUESTION:
 *
 *   flash  pinned Relace — Makora — OpenInference — DeepInfra
 *          blended on our shape:  Relace $0.0150 < DeepInfra $0.0184 < Makora $0.0241
 *          ⭐ position 2 is 24% DEARER than position 4, and
 *          ⚠️ **OpenInference does not serve this model at all** (absent from the
 *            feed; `model.mjs` CACHE_MEASURED already records it as unreachable).
 *   pro    pinned DeepSeek — StreamLake — GMICloud, and the costs run in the
 *          EXACT REVERSE: DeepSeek $1.32/M in is now the dearest of the three,
 *          against StreamLake $0.9834. It was $0.66 and cheapest on 2026-08-28.
 *   glm    Venice is cheaper than DeepInfra on all three columns. Pin correct.
 *
 * ⚠️⚠️ NOTHING HERE REPINS ANYTHING. A pin's PRIMARY is Roman's decision and
 * has been taken three times on evidence that was not price. `costOrderedFallback`
 * reorders the FALLBACK legs only, and `DECISION-provider-pins-2026-09-18.md`
 * costs the primaries for him.
 *
 * ⚠️ A PROVIDER ABSENT FROM A ROW IS UNPRICED, NEVER FREE. `costOrderedFallback`
 * leaves an unpriced name exactly where the pin put it.
 */
export const PROVIDER_RATES = Object.freeze({
  /** ⚡ V4.1 — live feed 2026-09-28, the pin in order. */
  [FLASH]: Object.freeze({
    Together: Object.freeze({ inPerM: 0.30, cachedInPerM: 0.006, outPerM: 1.20, quant: null }),
    Makora: Object.freeze({ inPerM: 0.30, cachedInPerM: 0.006, outPerM: 1.20, quant: 'fp8' }),
    Modal: Object.freeze({ inPerM: 0.30, cachedInPerM: 0.030, outPerM: 1.20, quant: null }),
  }),
  [FLASH_0731]: Object.freeze({
    /** fp4. The pinned primary. */
    Relace: Object.freeze({ inPerM: 0.060, cachedInPerM: 0.012, outPerM: 0.120, quant: 'fp4' }),
    /** fp8, and cheaper than Makora on all three columns. */
    DeepInfra: Object.freeze({ inPerM: 0.060, cachedInPerM: 0.015, outPerM: 0.180, quant: 'fp8' }),
    /** Quantisation unpublished — it is a fallback, never the primary. */
    Makora: Object.freeze({ inPerM: 0.090, cachedInPerM: 0.0196, outPerM: 0.195, quant: null }),
    /**
     * ⚠️⚠️ NOT PINNED, AND LISTED ANYWAY. StreamLake is the name Roman remembers
     * being on, and on 2026-09-18 it is the cheapest fp8 endpoint on the board —
     * **$0.0019/M on cache reads, 6.3x under Relace**, which on our 95.8% cache
     * rate is a 61% blended saving. ⚠️ It carries an **86% promotional discount**,
     * and `model.mjs` states the rule for that in its own words: *"a margin that
     * only holds while somebody else runs a sale is not a margin, and we just
     * watched one narrow."* It is also UNPROVEN here — no row in `CACHE_MEASURED` —
     * so nothing routes to it. Costed for Roman, never switched to.
     */
    StreamLake: Object.freeze({ inPerM: 0.059576, cachedInPerM: 0.001896, outPerM: 0.178728, quant: 'fp8' }),
  }),
  [PRO]: Object.freeze({
    DeepSeek: Object.freeze({ inPerM: 1.320, cachedInPerM: 0.044, outPerM: 3.960, quant: null }),
    StreamLake: Object.freeze({ inPerM: 0.9834, cachedInPerM: 0.03278, outPerM: 2.9502, quant: null }),
    GMICloud: Object.freeze({ inPerM: 1.056, cachedInPerM: 0.0352, outPerM: 3.168, quant: 'fp8' }),
  }),
  [VISION]: Object.freeze({
    Alibaba: Object.freeze({ inPerM: 0.030, cachedInPerM: 0.006, outPerM: 0.130, quant: null }),
  }),
  [GLM]: Object.freeze({
    Venice: Object.freeze({ inPerM: 0.430, cachedInPerM: 0.080, outPerM: 1.750, quant: 'fp4' }),
    DeepInfra: Object.freeze({ inPerM: 0.500, cachedInPerM: 0.100, outPerM: 2.000, quant: 'fp4' }),
  }),
});

/** When `PROVIDER_RATES` was last read from the live endpoint feed. */
export const PROVIDER_RATES_AS_OF = '2026-09-18';

/**
 * What one provider charges for one model, or `null` when we have not priced it.
 *
 * ⚠️ `null` IS A REFUSAL, NOT A ZERO. Every caller must treat an unpriced
 * provider as un-rankable and leave it where it was; guessing a price is how a
 * fallback lands somewhere nobody measured.
 *
 * @param {string} model
 * @param {string} provider
 * @returns {{inPerM:number, cachedInPerM:number, outPerM:number, quant:string|null}|null}
 */
export function providerRateFor(model, provider) {
  const row = PROVIDER_RATES[String(model ?? '')];
  if (!row) return null;
  return row[String(provider ?? '').trim()] ?? null;
}

/**
 * The rates for a model in a window.
 *
 * @param {string} model
 * @param {'peak'|'offPeak'} [window]
 * @returns {{inPerM: number, cachedInPerM: number, outPerM: number}|null}
 *   null for a model this card does not price — the caller must then refuse or
 *   fall back explicitly, never guess.
 */
export function ratesFor(model, window = GOVERNING_WINDOW) {
  const row = RATE_CARD[String(model ?? '')];
  if (!row) return null;
  return window === 'offPeak' ? row.offPeak : row.peak;
}

/**
 * Blended USD per million tokens at a given cache hit rate.
 *
 * ⚠️ TWO MIXES, NOT ONE, AND THEY ARE DIFFERENT QUESTIONS. `cacheRate` splits
 * INPUT between hit and miss; `outputShare` splits ALL tokens between input and
 * output. Collapsing them into a single "blended rate" is precisely how a
 * cached session came to be priced at 8x what it cost.
 *
 * @param {{inPerM: number, cachedInPerM: number, outPerM: number}} rate
 * @param {number} cacheRate 0..1
 * @param {number} [outputShare] 0..1
 * @returns {number} USD per million tokens
 */
export function blendedPerMillion(rate, cacheRate, outputShare = OUTPUT_TOKEN_SHARE) {
  const c = Math.min(1, Math.max(0, Number(cacheRate) || 0));
  const o = Math.min(1, Math.max(0, Number(outputShare) || 0));
  const input = c * rate.cachedInPerM + (1 - c) * rate.inPerM;
  return (1 - o) * input + o * rate.outPerM;
}
