/**
 * ── ⭐⭐⭐ THE ALLOWANCE IS DENOMINATED IN COST, NOT IN TOKENS ───────────────
 *
 * Roman, 2026-08-27: *"so we are confident we can never lose more than 47.5% if
 * someone does something completely dysfunctional."*
 *
 * With a RAW TOKEN allowance, 47.5% is the floor and it is a floor by *hope* —
 * it holds only while users behave roughly as measured. Change the mix and it
 * moves: 95M tokens costs $1.52 all-cached and $17.10 all-output, an **11.25x
 * swing on the identical token count**.
 *
 * ⭐⭐ THIS FIXES THAT STRUCTURALLY. Meter in COST-EQUIVALENT UNITS, where one
 * unit is defined as the cheapest token we can buy (a cache hit). Then:
 *
 *     N units costs AT MOST N x (cache-hit price), whatever the user does.
 *
 * The ceiling stops depending on behaviour and becomes arithmetic. **A user who
 * does the most expensive possible thing costs exactly the same as one who does
 * the cheapest — because that is what the unit MEANS.**
 *
 * ── THE WEIGHTS ARE DERIVED, NEVER TYPED ────────────────────────────────────
 *
 * Gemini proposed "1 output token = 4 input tokens". ⚠️ That number is wrong for
 * our card and, more importantly, wrong to hard-code at all: the ratios move
 * every time the pin moves. They are computed from `rate-card.mjs`, so the day
 * the provider changes the meter changes with it.
 *
 * At the pinned ceiling (DeepInfra fp8: cached $0.016, miss $0.08, out $0.18):
 *
 *     cache hit        1.00 unit   ← the definition
 *     cache-miss input 5.00 units
 *     output          11.25 units
 *
 * ⚠️ NOT 4. Output is **11x** a cache hit, and metering it at 4 would leave 64%
 * of the exposure uncovered.
 *
 * ── ⚠️ WHAT THIS COSTS THE USER, SAID PLAINLY ──────────────────────────────
 *
 * A pathological all-output user gets ~15M output tokens rather than 95M raw
 * tokens. That is a real reduction and it is the point — they are the case that
 * breaks the plan. **A normal user never touches the difference:** at our
 * measured shape (0.8% output, 82% cache) 95M raw tokens spends ~170M units, so
 * granting 170M units hands a typical customer their full advertised volume and
 * only bites the 1-in-1000 run.
 *
 * ⚠️ IT MUST BE DISCLOSED. A meter that debits differently from what the label
 * says is the kind of thing that reads as dishonest even when the maths is
 * generous. `describeUnitCost` exists so the product can show its working.
 */
import { RATE_CARD, FLASH, ratesFor } from './rate-card.mjs';

/**
 * The weights, computed from whichever rate row governs budgets.
 *
 * ⚠️ `ratesFor` defaults to the GOVERNING window, which is the DEAREST provider
 * in our pin. Deriving the weights from the cheap row would understate output
 * and reopen the exposure this module exists to close.
 */
export function unitWeights(model = FLASH) {
  const r = ratesFor(model);
  const base = r.cachedInPerM;
  if (!(base > 0)) {
    /**
     * ⚠️ A ZERO CACHE-READ PRICE WOULD MAKE EVERY WEIGHT INFINITE. Some
     * providers list cache reads as free; that is a real row in the feed. Fall
     * back to weighting against cache-miss input, which is never zero, and say
     * so in the shape so a caller can tell the two regimes apart.
     */
    return Object.freeze({ cachedIn: 0, missIn: 1, output: r.outPerM / r.inPerM, basis: 'missIn' });
  }
  return Object.freeze({
    cachedIn: 1,
    missIn: r.inPerM / base,
    output: r.outPerM / base,
    basis: 'cachedIn',
  });
}

/**
 * Turn one usage record into cost-equivalent units.
 *
 * @param {{cachedInputTokens?:number, inputTokens?:number, outputTokens?:number}} usage
 *   `inputTokens` is the TOTAL prompt; the cached portion is subtracted from it.
 *   ⚠️ That matches what every provider actually returns — `prompt_tokens`
 *   INCLUDES the cached ones — and getting it backwards double-counts the
 *   cheapest tokens as the dearest, which is the expensive direction.
 */
export function unitsFor(usage, model = FLASH) {
  const w = unitWeights(model);
  const input = Math.max(0, Number(usage?.inputTokens) || 0);
  const cached = Math.min(input, Math.max(0, Number(usage?.cachedInputTokens) || 0));
  const miss = input - cached;
  const output = Math.max(0, Number(usage?.outputTokens) || 0);
  return Math.round(cached * w.cachedIn + miss * w.missIn + output * w.output);
}

/**
 * ⭐ THE GUARANTEE, AS A FUNCTION. What is the MOST an allowance of `units` can
 * cost us, in USD? By construction this is exact and does not depend on the mix.
 */
export function maxCostUsd(units, model = FLASH) {
  const r = ratesFor(model);
  const w = unitWeights(model);
  const perUnitPerM = w.basis === 'cachedIn' ? r.cachedInPerM : r.inPerM;
  return (units * perUnitPerM) / 1_000_000;
}

/**
 * ⭐ And the inverse, which is how a plan is actually SIZED: how many units may
 * we grant and still clear a margin floor?
 *
 * @param {number} netRevenueUsd  after payment fees and FX
 * @param {number} floorMargin    e.g. 0.85
 */
export function unitsAffordable(netRevenueUsd, floorMargin, model = FLASH) {
  const r = ratesFor(model);
  const w = unitWeights(model);
  const perUnitPerM = w.basis === 'cachedIn' ? r.cachedInPerM : r.inPerM;
  const budget = netRevenueUsd * (1 - floorMargin);
  return Math.floor((budget / perUnitPerM) * 1_000_000);
}

/**
 * How many RAW tokens a typical customer gets from a unit grant — the number
 * that decides whether the meter is generous or stingy in practice.
 *
 * ⚠️ THIS IS THE HALF THAT MUST BE CHECKED BEFORE SHIPPING A UNIT COUNT. A
 * mathematically safe allowance that hands a normal user a third of what the
 * page promised is a support queue, not a guardrail.
 */
export function typicalTokensFrom(units, { outputShare = 0.008, cacheRate = 0.82 } = {}, model = FLASH) {
  const w = unitWeights(model);
  const perToken =
    outputShare * w.output
    + (1 - outputShare) * (cacheRate * w.cachedIn + (1 - cacheRate) * w.missIn);
  return perToken > 0 ? Math.floor(units / perToken) : 0;
}

/**
 * ⭐ SHOW THE WORKING. Roman's finishing-layer point: the gating has to be REAL
 * and it has to be legible. A meter nobody can explain is a meter people assume
 * is rigged.
 */
export function describeUnitCost(model = FLASH) {
  const w = unitWeights(model);
  return [
    'How your allowance is spent (1 unit = the cheapest token we can buy):',
    `  cached input   1 unit      — re-reading context you have already sent`,
    `  fresh input    ${w.missIn.toFixed(2)} units   — code the model has not seen yet`,
    `  output         ${w.output.toFixed(2)} units  — every token the model writes`,
    '',
    'Output is the expensive half and no cache ever discounts it, which is why a',
    'long session on one project goes much further than many cold one-off builds.',
  ].join('\n');
}

/** The card these weights were derived from, for a receipt. */
export function unitBasis(model = FLASH) {
  return Object.freeze({ model, asOf: RATE_CARD[model]?.asOf ?? null, weights: unitWeights(model) });
}

/**
 * ── ⭐⭐⭐ THE BRIDGE FROM A PROVIDER RESPONSE TO A DEBIT ────────────────────
 *
 * Everything above is arithmetic. This is the part that makes it ENFORCEMENT:
 * a real `usage` block off a completion, turned into units to subtract.
 *
 * ⚠️ THE FIELD NAMES ARE A MINEFIELD AND `budget.mjs` ALREADY MAPPED IT. Four
 * different upstreams report the cached count under four different keys —
 * `cachedTokens`, `cached_tokens`, `prompt_tokens_details.cached_tokens`,
 * `prompt_cache_hit_tokens`. Missing one does not throw; it silently reports
 * **zero cache**, which bills the cheapest tokens at the dearest rate and would
 * make a warm session look 5x more expensive than it was.
 *
 * ⚠️ AND `prompt_tokens` INCLUDES THE CACHED ONES on every provider we use, so
 * the cached count is SUBTRACTED, never added. Getting that backwards
 * double-counts in the expensive direction.
 *
 * ⭐ RETURNS `null`, NOT 0, WHEN THE COUNTS ARE ABSENT. A round we cannot price
 * is not a free round — it is an unknown one, and the caller must decide
 * (`usageByModel` in `plan.mjs` makes the same distinction for the same reason,
 * after a bug where `Number(null) === 0` counted unpriceable runs as free).
 */
export function unitsFromUsage(usage, model = FLASH) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

  const prompt = n(usage.promptTokens) ?? n(usage.prompt_tokens);
  const completion = n(usage.completionTokens) ?? n(usage.completion_tokens);
  if (prompt === null || completion === null) return null;

  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details
    : {};
  const cached = n(usage.cachedTokens)
    ?? n(usage.cached_tokens)
    ?? n(details.cached_tokens)
    ?? n(usage.prompt_cache_hit_tokens)
    ?? 0;

  return unitsFor(
    { inputTokens: prompt, cachedInputTokens: Math.min(cached, prompt), outputTokens: completion },
    model,
  );
}

/**
 * ── ⭐⭐ THE GATE ITSELF ─────────────────────────────────────────────────────
 *
 * @param {{granted:number|null, spent:number, projected?:number}} state
 * @returns {{allowed:boolean, reason:string, remaining:number|null, message:string|null}}
 *
 * ⚠️ `granted: null` MEANS UNMETERED and must stay allowed — every tenant we
 * have today is `operated · unmetered`, and a gate that starts refusing them is
 * an outage, not a guardrail.
 *
 * ⭐ IT REFUSES ON THE PROJECTION, NOT ON THE OVERDRAFT. Checking after the fact
 * means the expensive round has already been paid for; the whole value of a
 * ceiling is that it is reached BEFORE the money leaves.
 */
export function unitGate({ granted, spent = 0, projected = 0 } = {}) {
  if (granted === null || granted === undefined) {
    return { allowed: true, reason: 'unmetered', remaining: null, message: null };
  }
  const total = Math.max(0, Number(granted) || 0);
  const used = Math.max(0, Number(spent) || 0);
  const want = Math.max(0, Number(projected) || 0);
  const remaining = Math.max(0, total - used);

  if (used >= total) {
    return {
      allowed: false,
      reason: 'allowance-spent',
      remaining: 0,
      message: 'This month\'s allowance is spent. Top up, or it resets on your renewal date.',
    };
  }
  if (want > remaining) {
    return {
      allowed: false,
      reason: 'would-exceed',
      remaining,
      /**
       * ⭐ NAMES THE CHEAPEST WAY OUT, because the commonest cause is a cold
       * context rather than genuine exhaustion — and continuing an existing
       * session is both cheaper for us and free for them.
       */
      message: `This round needs about ${Math.round(want).toLocaleString()} units and `
        + `${Math.round(remaining).toLocaleString()} remain. Continuing an existing session costs `
        + 'far less than starting a cold one — output is the expensive part.',
    };
  }
  return { allowed: true, reason: 'ok', remaining, message: null };
}

/**
 * ── ⭐⭐ VELOCITY — AND ITS JOB IS NOT WHAT IT LOOKS LIKE ────────────────────
 *
 * ⚠️ THE OBVIOUS FRAMING IS WRONG. A velocity cap sounds like margin
 * protection, and with cost-unit metering **the margin is already safe** — the
 * ceiling is arithmetic and no rate of spending can breach it. Rationing a
 * heavy user to protect a margin that cannot move would be pure loss:
 * [[project_acuvo_margin_is_a_function_of_cache]] measured that a grinder is
 * our CHEAPEST customer per token, because a long session caches at 90%+.
 *
 * ⭐ SO THIS PROTECTS THE **USER**, NOT US. What it catches is a runaway loop, a
 * misconfigured script or a stolen key quietly eating somebody's whole month in
 * an afternoon. The failure it prevents is a person opening the CLI on Tuesday
 * to find Monday's infinite loop spent everything.
 *
 * ⚠️ THAT CHANGES THE DEFAULT BEHAVIOUR. It WARNS loudly and long before it
 * throttles, and the throttle is a pause with a way through — never a silent
 * refusal. A guard that stops legitimate work is worse than the bug it prevents.
 */

/** A month, for turning a monthly grant into a sustainable hourly rate. */
const HOURS_PER_MONTH = 730;

/**
 * ⭐ HOW FAR ABOVE LINEAR IS STILL OBVIOUSLY FINE. A month's allowance burned
 * evenly is 1x. Real people work in bursts — a weekend sprint is easily 10x the
 * linear rate and is exactly the customer we want. The alarm is set where the
 * rate stops looking like a person and starts looking like a `while (true)`.
 */
export const VELOCITY_WARN_MULTIPLE = 12;
export const VELOCITY_THROTTLE_MULTIPLE = 40;

/**
 * @param {{granted:number|null, spentInWindow:number, windowHours:number}} state
 * @returns {{level:'ok'|'warn'|'throttle', multiple:number, message:string|null}}
 */
export function velocityVerdict({ granted, spentInWindow = 0, windowHours = 1 } = {}) {
  const total = Number(granted);
  const hours = Math.max(1 / 60, Number(windowHours) || 0);
  const spent = Math.max(0, Number(spentInWindow) || 0);

  // ⚠️ Unmetered accounts have no linear rate to compare against, so there is
  // no ratio to compute and nothing honest to say. Silence, not a false OK.
  if (!Number.isFinite(total) || total <= 0) {
    return { level: 'ok', multiple: 0, message: null };
  }

  const sustainablePerHour = total / HOURS_PER_MONTH;
  const actualPerHour = spent / hours;
  const multiple = actualPerHour / sustainablePerHour;

  if (multiple >= VELOCITY_THROTTLE_MULTIPLE) {
    /**
     * ⚠️ THE MESSAGE NAMES THE LIKELY CAUSE, because at 40x the linear rate the
     * overwhelming majority of cases are a loop rather than a person typing.
     * "You are going too fast" is useless; "something may be looping" is
     * actionable in the ten seconds before real money is gone.
     */
    return {
      level: 'throttle',
      multiple,
      message: `Paused: this account is spending about ${Math.round(multiple)}x faster than a full `
        + 'month\'s allowance would allow. That is almost always a loop or a script rather than a '
        + 'person. Nothing is lost — check what is running, then continue.',
    };
  }
  if (multiple >= VELOCITY_WARN_MULTIPLE) {
    const hoursLeft = sustainablePerHour > 0 ? (total - spent) / Math.max(actualPerHour, 1e-9) : 0;
    return {
      level: 'warn',
      multiple,
      message: `At this rate the month's allowance lasts about ${Math.max(1, Math.round(hoursLeft))} more hours.`,
    };
  }
  return { level: 'ok', multiple, message: null };
}

/**
 * ── ⭐⭐⭐ CREATIVE SPENDS THE SAME POOL ─────────────────────────────────────
 *
 * ⚠️⚠️ THE LAST HOLE IN THE GUARANTEE, AND IT IS A REAL ONE. Tokens are metered;
 * GPU is not. A customer sitting comfortably inside their unit allowance can
 * still run image, video, voice and face generation without limit, because that
 * spend lives in a different ledger. **The 85% floor covers tokens and nothing
 * else** until this is used.
 *
 * ⭐ THE FIX IS ARITHMETIC, NOT A SECOND SYSTEM. A unit is a fixed amount of
 * MONEY (one cache-hit token). So any dollar cost converts: a GPU second and a
 * cached token are the same currency once you divide.
 *
 *     parallax clip (own GPU)  $0.0005  →        31,250 units
 *     one voice minute         $0.006   →       375,000 units
 *     rented video clip        $0.229   →    14,312,500 units
 *
 * ⚠️⚠️ READ THE LAST ROW AGAINST A 170M-UNIT MONTH: **ONE rented video clip is
 * 8.4% of a customer's entire monthly allowance.** Twelve of them is the whole
 * month. That is not a pricing opinion, it is the arithmetic — and it was
 * completely invisible while creative lived in its own ledger.
 *
 * ⭐ THIS IS THE HONEST ARGUMENT FOR THE ENGINE LADDER, in a currency the
 * customer already has. Own-GPU parallax is 458x cheaper than the rented clip;
 * the product can now SAY that in units instead of silently absorbing it.
 *
 * ⚠️ I FIRST WROTE THESE AS "31 units" AND "14,312 units" — WRONG BY 1000x,
 * because I divided by the per-MILLION rate without dividing by the million. A
 * unit is $0.000000016, not $0.000016. The error made creative look free.
 */
export function unitsForUsd(usd, model = FLASH) {
  const cost = Number(usd);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  const r = ratesFor(model);
  const w = unitWeights(model);
  const perUnitPerM = w.basis === 'cachedIn' ? r.cachedInPerM : r.inPerM;
  // perUnitPerM is $/million-units, so a unit costs perUnitPerM / 1e6.
  return Math.round(cost / (perUnitPerM / 1_000_000));
}

/** The inverse, for showing a person what a unit balance is worth in real money. */
export function usdForUnits(units, model = FLASH) {
  return maxCostUsd(units, model);
}

/**
 * ── ⭐⭐⭐ THE LEDGER `budget.record` DEBITS AGAINST ─────────────────────────
 *
 * `createBudget({ meter })` calls `debit(usage, pricedRound)` once per round,
 * at the single place every round already passes through. This is the object
 * that receives it.
 *
 * ⚠️ IT NEVER THROWS AND IT NEVER BLOCKS. By the time `record` runs the money is
 * already spent — refusing to count it would only make the loss invisible. The
 * REFUSAL belongs before the call (`unitGate`, on the projection); this is the
 * bookkeeping half.
 *
 * ⚠️ AND AN UNPRICEABLE ROUND IS COUNTED AS *UNKNOWN*, NEVER AS FREE. `plan.mjs`
 * records the bug this avoids: `Number(null) === 0` once made every unpriced run
 * look like zero usage, which is the exact shape of silently free usage.
 */
/**
 * ── ⚠️⚠️⭐ THE ALLOWANCE HAD NO SOURCE AT ALL, AND THAT MADE ALL OF THIS INERT
 *
 * `bin/acuvo.mjs` passes `granted: opts.unitAllowance ?? null`, and its comment
 * says that is *"null for everybody today — all 17 tenants are `operated ·
 * unmetered`"*, which reads as a deliberate rollout state. **It was not.**
 * Grepped 2026-08-28: `unitAllowance` appears in the whole package exactly
 * ONCE — at that read. No flag sets it, no env var, no plan lookup.
 *
 * ⭐ So `granted` was permanently `null`, `unitGate` returns `allowed` for
 * null, and the debit, the pre-round refusal, the creative debit and the
 * velocity verdict were **structurally unreachable for every user, forever** —
 * a large body of machinery that could never fire, with a comment explaining
 * why it was quiet. That is this repo's signature defect and it nearly took
 * two more features built on top of it.
 *
 * ⚠️ THE REAL SOURCE IS THE PLAN, AND IT IS NOT WIRED YET. `account.mjs`
 * returns `{ mode, token, url, email }` and carries no plan or allowance, so
 * reading it from the account needs a gateway change. This gives the machinery
 * a source it can actually be driven from in the meantime — and, critically,
 * makes it TESTABLE end to end instead of only in unit tests.
 *
 * ⚠️ AN UNPARSEABLE VALUE IS `null` (UNMETERED), NEVER `0`. `fal-spend-cap.mjs`
 * records the same rule for the same reason: a typo like
 * `ACUVO_UNIT_ALLOWANCE=lots` resolving to zero would refuse every round on the
 * machine — an outage caused by a guardrail, which is worse than the leak.
 */
export function allowanceFrom(env = process.env, opts = {}) {
  const explicit = opts?.unitAllowance;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit;

  /**
   * ── ⭐⭐⭐ THE PLAN IS A SOURCE NOW, AND IT IS THE REAL ONE ─────────────────
   *
   * ⚠️⚠️ Until 2026-08-28 the ONLY source was `ACUVO_UNIT_ALLOWANCE`, an env
   * var set by nothing — so `granted` was permanently null, every gate returned
   * `allowed`, and the 85% guarantee had no enforcement anywhere. Meanwhile
   * `PLANS` granted RAW TOKENS on the pricing page. **Two ladders, neither
   * wired, and they disagreed**: 95M raw tokens at our measured shape is ~244M
   * units — $3.91 worst case against the $2.72 the guarantee claims.
   *
   * ⭐ `plan-allowance.mjs` derives the ceiling from PRICE and MARGIN, so the
   * pricing page and the guarantee are now the same arithmetic rather than two
   * numbers that have to be remembered together.
   *
   * ⚠️ ORDER MATTERS AND THIS ORDER IS DELIBERATE: an explicit override beats
   * the plan, and the plan beats the env var. The env var stays because it is
   * how a test or a support session pins a tiny allowance without inventing a
   * plan; the plan wins over it because a customer's ceiling must not depend on
   * a machine's environment.
   */
  const planId = opts?.planId ?? env?.ACUVO_PLAN;
  if (planId) {
    // ⚠️ Imported lazily: `plan-allowance` imports the rate card, and a static
    // cycle here would be paid by every consumer of this module.
    const fromPlan = opts?.allowanceForPlan?.(planId, opts);
    if (typeof fromPlan === 'number' && Number.isFinite(fromPlan) && fromPlan > 0) return fromPlan;
  }

  const raw = String(env?.ACUVO_UNIT_ALLOWANCE ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * ── ⭐⭐ ONE METER PER PROCESS, SO THERE IS ONE SEAM AND NOT THREE ──────────
 *
 * `runSession` is called from three places in `bin/acuvo.mjs` (the interactive
 * turn, the one-shot run, and each `--best-of` attempt). Passing a meter at
 * each is three chances to forget, and forgetting is exactly how the meter came
 * to be attached to the escalation ladder's budget and to no other — the defect
 * this function exists to stop recurring.
 *
 * ⚠️ `null` WHEN THERE IS NO ALLOWANCE, deliberately, so an unconfigured run is
 * byte-identical to before rather than merely equivalent. Every tenant today is
 * `operated · unmetered`.
 *
 * ⚠️ ONE PER PROCESS, NOT PER ROUND OR PER SESSION — the allowance is monthly
 * and the velocity reading needs something to accumulate against. A meter
 * rebuilt each round would report every burst as its first.
 */
let processMeterInstance;

export function processMeter(env = process.env, deps = {}) {
  if (processMeterInstance !== undefined) return processMeterInstance;

  /**
   * ── ⚠️⚠️ I SHIPPED THE PLAN SOURCE AND LEFT IT UNREACHED ──────────────────
   *
   * `allowanceFrom` learned to take a plan, and this — the ONLY caller — passed
   * nothing. So the derived ladder was correct, tested, mutation-proven, and
   * dark: exactly the defect this session found five times in other people's
   * code, committed by me an hour after describing it.
   *
   * ⭐ The plan is resolved HERE, at the one seam every session passes through,
   * for the same reason the meter itself is: three call sites are three chances
   * to forget, and forgetting is how the meter ended up attached to the
   * escalation ladder's budget and nothing else.
   *
   * ⚠️ RESOLUTION ORDER: `ACUVO_PLAN` beats the stored account, because an
   * operator debugging a customer's ceiling must be able to pin it without
   * editing their credentials file.
   */
  const planId = String(env?.ACUVO_PLAN ?? '').trim() || planFromAccount(env, deps);

  const granted = allowanceFrom(env, {
    planId: planId || undefined,
    audUsd: deps.audUsd,
    allowanceForPlan: deps.allowanceForPlan,
  });
  processMeterInstance = granted === null ? null : createUnitMeter({ granted });
  return processMeterInstance;
}

/**
  * The plan the signed-in account is on, or `''` when we do not know.
  *
  * ⚠️⚠️ **TODAY THIS ALWAYS RETURNS `''`, AND THAT IS THE REMAINING HALF.**
  * `readAccount` returns `{ token, email, gatewayUrl }` — the credential file
  * has never carried a plan, because the gateway does not send one at login.
  * So a real customer's ceiling still is not enforced locally.
  *
  * ⭐ IT IS WRITTEN THIS WAY ON PURPOSE. The moment the login response carries
  * `plan`, this function starts returning it and the gate begins firing with no
  * other change — and `plan-allowance-is-derived.test.mjs` already proves the
  * path from a plan id to a refusal. The missing piece is one field in one
  * server response, and it is named here rather than left as a comment in a
  * register nobody reads.
  *
  * ⚠️ Never throws. A malformed credentials file must not stop a build.
  */
export function planFromAccount(env = process.env, deps = {}) {
  try {
    const read = deps.readAccount;
    if (typeof read !== 'function') return '';
    const acct = read(env);
    const plan = acct && typeof acct.plan === 'string' ? acct.plan.trim() : '';
    return plan;
  } catch {
    return '';
  }
}

/** Test seam — the singleton must not leak between test files. */
export function resetProcessMeter() {
  processMeterInstance = undefined;
}

export function createUnitMeter({ granted = null, spent = 0, model = FLASH, onVerdict = null } = {}) {
  let used = Math.max(0, Number(spent) || 0);
  let unknownRounds = 0;
  const startedAt = Date.now();

  return {
    /** @param {unknown} usage @param {unknown} pricedRound */
    debit(usage) {
      const units = unitsFromUsage(usage, model);
      if (units === null) { unknownRounds += 1; return null; }
      used += units;
      /**
       * ⭐ THE VELOCITY READING RIDES ALONG, because the only moment we reliably
       * know both the spend and the elapsed time is right here. Computing it on
       * a timer would need a second clock and a second place to forget.
       */
      if (typeof onVerdict === 'function') {
        const hours = Math.max(1 / 3600, (Date.now() - startedAt) / 3_600_000);
        try {
          onVerdict({
            gate: unitGate({ granted, spent: used }),
            velocity: velocityVerdict({ granted, spentInWindow: used, windowHours: hours }),
            used,
            unknownRounds,
          });
        } catch { /* a reporting failure must not cost the round either */ }
      }
      return units;
    },

    /**
     * ── ⭐⭐⭐ CREATIVE SPEND, IN THE SAME POOL ───────────────────────────────
     *
     * ⚠️⚠️ THE LAST HOLE IN THE 85% GUARANTEE, AND IT WAS SHAPED LIKE THIS: the
     * allowance is denominated in cost units so that no usage pattern can move
     * the floor — but a GPU render, a voice clone or an image generation costs
     * real dollars and debited **nothing**. `debit()` above reads a token usage
     * object, and creative work has no tokens. So the one category of spend
     * with no natural ceiling was the one category the ceiling could not see.
     *
     * ⭐ `unitsForUsd` existed and was tested for exactly this and had no
     * caller. A unit IS the cheapest token we can buy, so dollars convert into
     * it directly — the pool stays one currency, which is what makes the
     * arithmetic hold. A top-up is more units, never a second currency.
     *
     * ⚠️ AN UNPRICEABLE CHARGE IS *UNKNOWN*, NEVER FREE — the same contract as
     * `debit`. `Number(null) === 0` once made every unpriced run look like zero
     * usage (`plan.mjs`), which is the exact shape of silently free spend, and
     * creative is where that would hurt most.
     */
    debitUsd(usd) {
      /**
       * ⚠️⚠️ `null` IS CHECKED BEFORE `Number()`, AND MY FIRST VERSION WAS NOT.
       * `Number(null) === 0`, so a charge nobody could price returned 0 —
       * "priced, and free" — instead of "unknown". That is the precise bug
       * `plan.mjs` records, reproduced in the function written to avoid it, and
       * the test above caught it. `typeof usd !== 'number'` first, always.
       */
      if (typeof usd !== 'number') { unknownRounds += 1; return null; }
      const n = usd;
      if (!Number.isFinite(n) || n < 0) { unknownRounds += 1; return null; }
      if (n === 0) return 0;
      const units = unitsForUsd(n, model);
      if (!Number.isFinite(units)) { unknownRounds += 1; return null; }
      used += units;
      return units;
    },

    /** ⭐ Asked BEFORE a round, which is the only place a refusal is worth anything. */
    check(projectedUnits = 0) {
      return unitGate({ granted, spent: used, projected: projectedUnits });
    },

    /**
     * ── ⭐⭐⭐ THE SAME GATE, ASKED IN THE CURRENCY THE CALLER ALREADY HAS ─────
     *
     * `budget.mjs`'s `projectNext()` returns DOLLARS and no token breakdown, so
     * `check()` — which wants units — could not be reached from the one place
     * that already asks "can I afford the next round?". That is the entire
     * reason `unitGate` sat written, tested and **called by nothing outside
     * this file** while the debit half was wired: the refusal had no seam it
     * could reach.
     *
     * ⭐ THE CONVERSION LIVES HERE, NOT IN THE CALLER. `unitsForUsd` needs the
     * model to know what a unit costs, and the model is the meter's business.
     * Handing `budget.mjs` a price table would be a second place for the two to
     * drift — the defect that produced six different margin figures.
     *
     * ⚠️ A NON-FINITE PROJECTION IS NOT ZERO. An unpriceable round projected as
     * `0` would sail through the gate as free, which is the exact
     * `Number(null) === 0` shape `plan.mjs` records. It is treated as "no
     * projection available", so the gate falls back to the spent-vs-granted
     * question it can still answer honestly.
     */
    checkUsd(projectedUsd) {
      const usd = Number(projectedUsd);
      const projected = Number.isFinite(usd) && usd > 0 ? unitsForUsd(usd, model) : 0;
      return unitGate({ granted, spent: used, projected });
    },

    /** What the meter would tell a person, for the banner and the audit record. */
    state() {
      return Object.freeze({
        granted,
        used,
        remaining: granted === null ? null : Math.max(0, granted - used),
        unknownRounds,
        maxCostUsd: maxCostUsd(used, model),
      });
    },
  };
}
