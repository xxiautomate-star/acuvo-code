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

import { callModel } from './model.mjs';

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
  const defaults = [
    'deepseek/deepseek-chat',
    'z-ai/glm-4.6',
    'qwen/qwen3.7-flash',
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
export function isModelSpecific(error) {
  const e = String(error ?? '');
  if (/HTTP 40[13]|invalid api key|unauthoris|unauthoriz|forbidden/i.test(e)) return false;
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

    const res = await callImpl({ apiKey, model: candidate, messages, tools, timeoutMs, maxTokens, onText });
    if (res.ok) {
      return {
        ...res,
        attempts: tried.length,
        // ⭐ True whenever the answer did NOT come from what was asked for.
        usedFallback: candidate !== model,
        chainTried: tried,
      };
    }

    last = res;

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
    if (isModelSpecific(res.error)) continue;

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
      return { ...res, attempts: tried.length, usedFallback: false, chainTried: tried, stoppedEarly: true };
    }
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
  };
}
