/**
 * ── ⭐⭐ NEVER SINGLE — THE PROVIDER CHAIN ───────────────────────────────────
 *
 * Acuvo Code called OpenRouter and only OpenRouter. If OpenRouter rate-limits or
 * has a bad ten minutes, **every user of this CLI is dead at once** — not
 * degraded, dead, mid-task, with whatever they were doing abandoned.
 *
 * The console has carried a "never single" doctrine for months and the CLI never
 * inherited it. An independent review of the product flagged the same thing as
 * "API redundancy" and it is the most legitimate technical point in it: a
 * one-provider agent is a one-provider outage.
 *
 * ── ⚠️ WHAT IS RETRYABLE, AND WHY THE DISTINCTION IS THE WHOLE FILE ─────────
 * Retrying the wrong failure is worse than not retrying at all. A 401 retried
 * three times is three times the wait before the user learns their key is bad,
 * and a 400 retried is us hammering a provider with a request we malformed.
 *
 *   RETRY  429 (rate limit) · 5xx (their fault) · timeout · connection error
 *   STOP   400 401 403 404 · and anything else 4xx
 *
 * ⭐ 402 IS DELIBERATELY NOT RETRYABLE ACROSS MODELS BUT IS ACROSS PROVIDERS.
 * "This account cannot pay" is permanent for that account this minute; trying a
 * cheaper model on the same exhausted balance just fails again more slowly.
 *
 * ── ⚠️⚠️ AN EMPTY 200 IS A FAILURE, AND IT IS THE ONE THAT ALMOST SHIPPED ───
 * `qwen3.7-flash`, `deepseek-v4-flash-0731` and `deepseek-v4-pro` all have a
 * native reasoning budget ON BY DEFAULT that can consume the entire output and
 * return `content: null` with HTTP 200. Measured earlier in this project: a
 * bake-off where BOTH v4 models returned 0 bytes and looked like a silent
 * success. A chain that treats 200 as success would fall through to nothing and
 * report "the model returned an empty reply" instead of trying the next one.
 *
 * ── ⚠️ THE PREFIX MUST NOT MOVE ─────────────────────────────────────────────
 * Every attempt sends the SAME messages, byte for byte. An identical prompt
 * prefix caches at a measured 97.2% and cuts call cost 4.3x; reordering,
 * re-summarising or "trimming for the fallback" would throw that away silently
 * and nobody would notice except the bill.
 */

import { callModel, reasoningField } from './model.mjs';

/** Total attempts across the whole chain. Bounded because a loop that retries
 *  forever is an outage that also costs money. */
export const MAX_ATTEMPTS = 4;

/**
 * The order is deliberate: the configured model first (it is what the user
 * asked for and what the cache is warm on), then progressively more available
 * fallbacks.
 *
 * ⚠️ FREE MODELS LAST, NOT FIRST. They are the most rate-limited things on
 * OpenRouter, so leading with one would make the common case slower and the
 * failure case no better. They are here as a floor — something that answers
 * when nothing else will — not as a cost optimisation.
 */
export function buildChain(primary, env = process.env) {
  const extra = (env.ACUVO_FALLBACK_MODELS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  /**
   * ── ⭐⭐⭐ NO QWEN IN THE CODING CHAIN (Roman, 2026-08-31) ─────────────────
   *
   * *"we aren't switching to Qwen at all dude, and it should be reflected in
   * the software — it's pure DeepSeek."*
   *
   * ⭐ AND THE CACHE IS THE REASON THE INSTRUCTION IS RIGHT, not just an
   * opinion. A prefix cache CANNOT cross a provider — it is physically a
   * property of one host's KV store. Measured: DeepSeek caches **99.4%**, Qwen
   * **at most 59.5% and intermittently**. So a silent fallback to Qwen did not
   * merely change the model, it **destroyed the shared prefix** and re-billed
   * the whole conversation at full input price. The fallback that was supposed
   * to make a bad moment survivable was the most expensive leg on the ladder.
   *
   * ⚠️ QWEN STAYS FOR VISION AND ONLY VISION — `lib/vision.mjs`,
   * `rate-card.mjs` VISION, `image-director.mjs`'s critic. That is not a
   * contradiction: DeepSeek has no vision model we can reach (`deepseek-vision`
   * 404s for this account), so the choice there is Qwen or no eyes at all.
   *
   * ⚠️ `z-ai/glm-4.6` IS LEFT IN PLACE DELIBERATELY AND IS ROMAN'S CALL, NOT
   * MINE. A chain of one model is one outage away from total outage, and the
   * console pins that rule with `llm-chain-is-never-single.test.ts`. GLM is the
   * floor that keeps this chain from being single — it is never preferred, only
   * reached when DeepSeek itself is down. Removing it too would satisfy the
   * word "pure" and delete the only thing standing between a DeepSeek outage
   * and a dead CLI.
   */
  const defaults = [
    'deepseek/deepseek-chat',
    'z-ai/glm-4.6',
  ];
  const seen = new Set();
  return [primary, ...extra, ...defaults].filter((m) => {
    if (!m || seen.has(m)) return false;
    seen.add(m);
    return true;
  });
}

/**
 * Decide what to do with a failed attempt.
 *
 * Pure, and separately tested — this is the function that decides whether a
 * user waits four times as long for a key error.
 */
/**
 * @param {any} error the message, for the cases that still have to be read
 * @param {'timeout' | 'network' | null} [kind] the structured fact from
 *   `transportErrorKind`, when the caller has it. ⭐ WHEN PRESENT IT DECIDES,
 *   because a fact beats a regex over English — see model.mjs's
 *   `transportErrorKind` for the timeout that never failed over.
 */
export function isRetryable(error, kind = null) {
  /**
   * ⚠️ ONLY EVER ADDS RETRYABILITY. A 401 or a malformed body fails identically
   * on every provider, so no kind may turn one of those into four attempts —
   * and none can, because this returns only `true` and the prose rules below
   * still get their say when the kind is absent.
   */
  if (kind === 'timeout' || kind === 'network') return true;

  const e = String(error ?? '');
  // Transport: no HTTP status ever arrived.
  if (/timed out|could not reach|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(e)) return true;
  // Their fault.
  if (/HTTP 5\d\d/.test(e)) return true;
  if (/HTTP 429|rate.?limit/i.test(e)) return true;
  /**
   * ⚠️ The empty-200 case arrives as a normal-looking error string from
   * extractReply, NOT as an HTTP failure. It must be caught by text, and it is
   * the single most important line here — see the header.
   */
  if (/empty reply|no content|returned nothing/i.test(e)) return true;
  /**
   * ── 🚨⭐⭐ THE SAME HOLE, THIRD COSTUME: A 200 CARRYING THE PROVIDER'S OWN
   *    REFUSAL (measured against the live API, 2026-09-18) ───────────────────
   *
   * OpenRouter answers HTTP 200 with an `error` object and no `choices` when
   * the upstream provider refuses mid-flight. `deepseek/deepseek-chat` — the
   * FIRST fallback, and the one model in this chain with no pin — is served by
   * a DeepInfra deployment that advertises a 163,840 window and enforces
   * **32,768**, so a long transcript on a fallback leg gets exactly this.
   *
   * ⚠️ IT IS "THEIR FAULT", WHICH IS THIS FUNCTION'S OWN DEFINITION OF
   * RETRYABLE. The header's rule is `RETRY … 5xx (their fault)`; a provider
   * that cannot take a request another provider can is the same fact wearing a
   * 200. And the next candidate sends a DIFFERENT model id to a DIFFERENT host
   * — `z-ai/glm-4.6` has a 200k window — so the retry is not a re-send of
   * something known to fail, which is the test the header sets.
   *
   * ⚠️ THE COST OF BEING WRONG IS BOUNDED AND SMALL. If the request really is
   * too large for everything, `MAX_ATTEMPTS = 4` spends at most three more
   * round trips and the user then reads the provider's real sentence — naming
   * the size sent and the size allowed — instead of "returned no choices".
   * Before this line the session simply ended there with two healthy fallbacks
   * untried, on the unlucky run where the primary was already down.
   */
  if (/upstream provider error/i.test(e)) return true;
  return false;
}

/**
 * ── ⭐ IS THIS FAILURE ABOUT THE REQUEST, OR ABOUT THIS ONE MODEL? ───────────
 *
 * `callChain` stops the moment a failure is not retryable, and the reasoning is
 * right for the case it was written against: a bad key or a malformed body
 * "will fail identically on every provider", so burning three more attempts
 * turns a two-second error into an eight-second one.
 *
 * ⚠️ THAT ARGUMENT DOES NOT HOLD FOR A FAILURE ABOUT THE MODEL ITSELF. Every
 * candidate in the chain sends a DIFFERENT model id, so "model not found",
 * a retired id, or "no endpoints found that support tool use" is a fact about
 * ONE candidate and says nothing about the next three.
 *
 * ⭐ WE PAID FOR THIS ONE ALREADY. The OpenCode integration sat broken because
 * its configured model was an IMAGE model with no tool support, and every
 * request returned `404 "No endpoints found that support tool use"`. Three
 * healthy fallbacks were sitting right there, each of which would have sent a
 * different id, and the chain refused to try a single one of them.
 *
 * ⚠️ DELIBERATELY NARROW. This must match only failures that name the MODEL. A
 * pattern loose enough to catch a bad key would restore the eight-second error
 * this whole branch exists to prevent, so 401/403 and body-shape 400s are
 * excluded explicitly and `test/chain-failover-policy.test.mjs` pins that.
 */
/**
 * ── ⚠️⚠️ A PROVIDER PIN MAKES "NO ENDPOINTS FOUND" MEAN SOMETHING ELSE ───────
 *
 * The whole point of this function is that every candidate sends a DIFFERENT
 * model id, so a failure naming the model says nothing about the next three.
 * **A provider pin breaks that reasoning, because the pin is the SAME on all
 * four.** `provider: { order: ['NotAProvider'] }` narrows the endpoint set to
 * nothing and OpenRouter answers "No endpoints found for <model>" — the model
 * id is merely what the sentence happens to name.
 *
 * ⭐ MEASURED 2026-08-14. With the pin invisible, the chain burned all four
 * candidates re-sending the identical bad pin, and the error a human finally
 * read led with "check OPENROUTER_CODEGEN_MODEL against the model catalogue"
 * about a model that was never wrong. Four round trips to misdiagnose one
 * environment variable.
 *
 * ⚠️ `pinned` DEFAULTS TO FALSE, so every existing caller behaves exactly as
 * before. This can only ever REMOVE retryability, and only for the one cause
 * that provably repeats — which keeps the OpenCode case intact: a genuinely
 * dead model id with no pin still advances through the chain, and that is the
 * failure this branch was written for in the first place.
 *
 * @param {any} error
 * @param {{ pinned?: boolean }} [opts] `pinned` — a provider pin was sent with
 *   this request, so an endpoint-shaped failure is at least as likely to be
 *   about the pin as about the model.
 */
export function isModelSpecific(error, { pinned = false } = {}) {
  const e = String(error ?? '');
  if (/HTTP 40[13]|invalid api key|unauthoris|unauthoriz|forbidden/i.test(e)) return false;
  /**
   * ⚠️ ONLY the endpoint-shaped failure is disclaimed, not the whole family. A
   * retired or misspelled model id still fails per-candidate under a pin, and
   * those messages ("model not found", "deprecated model") are unambiguous —
   * they cannot be produced by narrowing the provider set.
   */
  if (pinned && /no endpoints found/i.test(e)) return false;
  return /no endpoints found|model not found|does not exist|unknown model|no such model|not a valid model|unsupported model|decommission|deprecated model/i.test(e);
}

/**
 * Call the chain until something answers.
 *
 * Returns the same shape as `callModel`, plus `attempts` and `usedFallback`.
 *
 * ⚠️ THE RESULT SAYS WHICH MODEL ANSWERED. A silent downgrade that returns a
 * weaker model's output without saying so is the dishonest version of this
 * feature: the user compares two sessions, one is worse, and nothing on screen
 * explains why.
 */
export async function callChain({
  apiKey, model, messages, tools, timeoutMs, maxTokens, onText = null,
  env = process.env, callImpl = callModel, onAttempt = null,
  /**
   * ⭐ THE STICKY KEY, THREADED. OpenRouter uses it to route every request in a
   * conversation to the SAME upstream server, which is the half of the caching
   * story no amount of prefix discipline could reach — see `sessionId` in
   * model.mjs. It travels with the call rather than being derived here, because
   * a conversation outlives any one chain attempt.
   *
   * ⚠️ IT DELIBERATELY SURVIVES A MODEL DOWNGRADE. Stickiness is tracked per
   * account PER MODEL, so reusing the id on the fallback model costs nothing
   * and keeps the ladder's later rounds warm if it stays there.
   */
  sessionId = null,
  /** The observed-warm route, threaded straight through — see warm-provider.mjs. */
  routeOverride = null,
  /**
   * ⭐ INJECTED SO THE BACKOFF IS TESTABLE. A test that really sleeps is a test
   * nobody runs, and a backoff nobody tests is a backoff that quietly becomes
   * zero. Production passes the real timer; the suite passes a recorder.
   */
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const chain = buildChain(model, env);
  const tried = [];
  let last = null;
  /**
   * ── 💰⭐⭐⭐ THE ATTEMPTS THAT COST MONEY AND LEFT NO TRACE ─────────────────
   *
   * ⚠️ THE CHAIN IS A LOOP OVER PAID CALLS AND IT KEPT ONE OF THEM. `last = res`
   * is overwritten by the next candidate, so a chain that burned three
   * billed-but-empty 200s and succeeded on the fourth returned ONLY the fourth's
   * usage. At the measured CLI prompt sizes (10k–30k tokens per round, see
   * `console.cli_usage`) that is three real charges per recovery, priced at zero.
   *
   * ⭐ AN ARRAY, NOT A SUM. `budget.record` prices from the cached/fresh/output
   * SPLIT (`priceFromSplit`) and `unitsFromUsage` meters from the same object —
   * adding the totals here would throw away the split and hand both of them a
   * number they cannot re-derive. Each attempt stays its own raw provider object.
   *
   * ⚠️⚠️ AND IT MUST NEVER CONTAIN THE ATTEMPT THE CALLER CAN ALREADY SEE, or
   * the caller charges the same tokens twice. The rule, enforced by where the
   * pushes sit below: an attempt is recorded here ONLY when the chain moves past
   * it. The `stoppedEarly` return hands its own `res.usage` straight out, so
   * that attempt is deliberately NOT in this list. `test/chain-bills-every-attempt`
   * pins both halves — the recovery AND the no-double-count.
   */
  const billedFailures = [];
  const rememberBill = (res) => { if (res?.usage) billedFailures.push(res.usage); };
  /** Why each earlier candidate was abandoned. See the success return below. */
  const fellBackFrom = [];
  let retriedWithoutReasoning = false;
  /**
   * ⚠️ THE CHAIN HAD NO BACKOFF AT ALL. Every attempt fired immediately and
   * `Retry-After` was never read, so all four candidates were spent in
   * milliseconds against a rate limiter that would have served us a second
   * later — a chain that burns itself out faster than the limiter's window is a
   * chain only on paper. Waits grow, and an explicit Retry-After always wins
   * over our guess.
   */
  let waitBeforeNext = 0;

  for (const candidate of chain) {
    if (tried.length >= MAX_ATTEMPTS) break;
    if (waitBeforeNext > 0) await sleepImpl(waitBeforeNext);
    tried.push(candidate);
    if (onAttempt) onAttempt({ model: candidate, attempt: tried.length, of: Math.min(chain.length, MAX_ATTEMPTS) });

    /**
     * ⚠️ `env` IS FORWARDED, and it was not. It is destructured above precisely
     * so a library caller can configure a call without touching `process.env`
     * — the design comment next to the provider-pin code says exactly that —
     * but it reached only `buildChain`. So a caller that passed
     * `ACUVO_PROVIDER_ORDER` through `env` had its pin silently ignored while
     * `callModel` read the ambient environment instead. Production was
     * unaffected only because `callModel` defaults to `process.env` and the CLI
     * never passes anything else, which is what kept it invisible.
     */
    /**
     * ⚠️ THE OVERRIDE APPLIES ONLY TO THE MODEL IT WAS LEARNED FOR. A chain
     * falls back to a DIFFERENT model, whose cache lives somewhere else
     * entirely, so carrying the pin across would force a cold provider AND
     * remove its fallback — the exact failure this exists to prevent.
     */
    const route = candidate === model ? routeOverride : null;
    let res = await callImpl({ apiKey, model: candidate, messages, tools, timeoutMs, maxTokens, onText, env, routeOverride: route, sessionId });
    /**
     * ── ⭐ AN EMPTY REPLY FROM A THINKING MODEL IS RETRIED ONCE WITHOUT THINKING ─
     * Found by using it, 2026-09-26: in 2 of 3 real runs the configured model
     * (`deepseek-v4-flash-0731`, reasoning ON by `reasoningField`) returned an
     * empty reply on the first file-writing round — the bimodal stall recorded
     * above `reasoningField` — and the chain handed the round to `deepseek-chat`:
     * an older model, a different price, and a cold cache on a different
     * upstream. The same model with reasoning off answers that round (the note
     * above `reasoningField` measured 4 of 6 write rounds at 0 reasoning tokens).
     * ⚠️ SAME MESSAGES, SAME MODEL, SAME ROUTE — the prefix does not move, so the
     * cache it paid for is still warm. ONCE per call, counted against
     * MAX_ATTEMPTS, and only where reasoning was actually on.
     */
    /*
     * ⭐ A TIMEOUT TOO (same day): through a gateway with no function limit the same
     * thinking round ran past the CLI's own 180 s cap instead of coming back empty —
     * one cause, two symptoms. Production logs: 53 × 200, 0 × 504 on the chat route in 24 h,
     * so the empty reply there is the model's, not a platform kill.
     */
    if (!res.ok && !retriedWithoutReasoning && (/empty reply/i.test(String(res.error ?? '')) || res.kind === 'timeout')
      && reasoningField(candidate, env)?.reasoning?.enabled === true && tried.length < MAX_ATTEMPTS) {
      retriedWithoutReasoning = true;
      rememberBill(res);
      fellBackFrom.push({ model: candidate, error: `${String(res.error)} (retried once with reasoning off)` });
      tried.push(candidate);
      res = await callImpl({ apiKey, model: candidate, messages, tools, timeoutMs, maxTokens, onText, env: { ...env, ACUVO_REASONING: 'off' }, routeOverride: route, sessionId });
    }
    if (res.ok) {
      return {
        ...res,
        attempts: tried.length,
        // ⭐ True whenever the answer did NOT come from what was asked for.
        usedFallback: candidate !== model,
        chainTried: tried,
        /**
         * ⚠️ THE SUCCESS RETURN IS THE ONE THAT MATTERS MOST HERE. A chain that
         * RECOVERS looks like a clean run to everything downstream — exit 0, one
         * usage object, no error printed — which is exactly why the attempts it
         * paid for on the way had nowhere to be reported. `res.usage` is the
         * winner's; these are the losers', and they are disjoint by construction.
         */
        billedFailures,
        /**
         * ── ⭐⭐ WHY IT FELL BACK, AND UNTIL NOW NOTHING KNEW ─────────────────
         *
         * MEASURED 2026-09-02: two consecutive CLI runs downgraded off the
         * pinned coding model mid-task. The summary said so — *"deepseek-chat
         * answered round 3, not deepseek-v4-flash-0731 — a chain fallback"* —
         * and there was no way, anywhere in the product or the `--json`
         * document, to learn WHAT the pinned model had done wrong. A 429, a
         * dropped connection, an empty reply and a 402 all look identical from
         * outside: the run simply got quieter and worse.
         *
         * ⚠️ THE ERRORS WERE IN HAND THE WHOLE TIME. `last = res` two lines
         * below already holds each failed attempt; the success return listed
         * `chainTried` (the NAMES it tried) and `billedFailures` (what they
         * COST) and dropped the one field that says why — turning a diagnosable
         * downgrade into a mood.
         *
         * ⭐ MESSAGES ONLY, never the raw response: `classifyHttpFailure` has
         * already turned each one into a sentence naming the cause, and that is
         * the part a human needs. Empty on a clean first-attempt run, so no
         * existing consumer sees a new field with anything in it.
         */
        fellBackFrom,
      };
    }

    last = res;
    /**
     * ⚠️ PUSHED HERE, BESIDE `last`, so it can never disagree with it. A second
     * place that decides "this attempt failed" is a second place that can be
     * forgotten — the defect shape this package loses to most often.
     */
    fellBackFrom.push({ model: candidate, error: String(res?.error ?? 'unknown failure') });

    /**
     * ⭐ HOW LONG BEFORE THE NEXT CANDIDATE. An explicit `Retry-After` from the
     * provider always wins — guessing over an instruction is how a client gets
     * itself throttled harder. Otherwise 500ms, doubling, capped, so four
     * attempts span about three seconds rather than forty milliseconds.
     */
    waitBeforeNext = Number.isFinite(res.retryAfterMs) && res.retryAfterMs > 0
      ? Math.min(res.retryAfterMs, 30_000)
      : Math.min((waitBeforeNext || 250) * 2, 4_000);

    /**
     * ⭐ A FAILURE ABOUT THIS ONE MODEL IS NOT A FAILURE ABOUT THE CHAIN. The
     * next candidate sends a DIFFERENT model id, so a 404 here proves nothing
     * about it — see `isModelSpecific`. Advancing costs one more attempt;
     * stopping costs the whole capability, which is precisely what happened to
     * the OpenCode integration.
     */
    if (isModelSpecific(res.error, { pinned: Array.isArray(res.providerPin) && res.providerPin.length > 0 })) {
      // ⚠️ RECORDED BECAUSE WE ARE LEAVING IT BEHIND. A model-specific failure is
      // usually a 404 that cost nothing and carries no usage — `rememberBill`
      // ignores those — but "usually" is not "never", and this is the branch that
      // walks away from the attempt without returning it.
      rememberBill(res);
      continue;
    }

    /**
     * ⭐ `res.kind` is the structured transport fact when `callModel` had one
     * (model.mjs `transportErrorKind`). It is absent for HTTP failures, where
     * the message still decides — so this reads the fact first and the prose
     * second, which is the only ordering that stops the two drifting apart.
     */
    if (!isRetryable(res.error, res.kind ?? null)) {
      /**
       * ⚠️ STOP IMMEDIATELY, AND SAY THE CHAIN STOPPED EARLY. A bad key or a
       * malformed request will fail identically on every provider; burning the
       * remaining attempts turns a two-second error into an eight-second one and
       * teaches the user that the tool is slow rather than that their key is
       * wrong.
       */
      /**
       * ⚠️⚠️ `res.usage` IS SPREAD OUT BY `...res`, SO THIS ATTEMPT IS **NOT**
       * ADDED TO `billedFailures`. That asymmetry is the no-double-charge rule
       * from the declaration above, and it is the whole reason the pushes live
       * at the two "we are moving on" sites rather than next to `last = res`.
       */
      return { ...res, attempts: tried.length, usedFallback: false, chainTried: tried, stoppedEarly: true, billedFailures, fellBackFrom };
    }

    // ⭐ The bottom of the loop body — reached only when the chain is about to
    // try ANOTHER candidate, or has run out of them. Either way this attempt is
    // never handed to the caller as `res`, so its bill lives here or nowhere.
    rememberBill(res);
  }

  return {
    ok: false,
    error: [
      `every provider in the chain failed after ${tried.length} attempt${tried.length === 1 ? '' : 's'}.`,
      `tried: ${tried.join(' → ')}`,
      `last error: ${last?.error ?? 'unknown'}`,
    ].join('\n'),
    attempts: tried.length,
    chainTried: tried,
    /**
     * ⚠️ THIS RETURN HAS NO `usage` OF ITS OWN — it is a synthesised summary of
     * N failures, not one of them — so every attempt in the list is new
     * information and none of it is a duplicate.
     */
    billedFailures,
    // Why each candidate was abandoned, in order. See the success return above.
    fellBackFrom,
  };
}
