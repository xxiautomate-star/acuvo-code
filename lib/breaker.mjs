/**
 * ── ⚠️⭐ ONE DEAD SERVICE MUST NOT EAT THE WHOLE SESSION ─────────────────────
 *
 * Measured 2026-08-10 on a real multi-page website build. `generate_image` was
 * unreachable. Each attempt waited the full 180-second timeout; the model tried
 * twice in one round, then — following our own error text, which said "try once
 * more" — retried in the next. Six minutes of a run spent on a service that was
 * never going to answer, and the user saw a session that appeared to hang and
 * produced nothing.
 *
 * ⭐ THE ASYMMETRY IS THE WHOLE ARGUMENT. Being wrong about a service being dead
 * costs one missing image. Being wrong about it being alive costs three minutes
 * PER ATTEMPT out of a budget measured in minutes. So: one unreachable answer,
 * and this endpoint is dead for the rest of the process.
 *
 * ⚠️ IT TRIPS ON UNREACHABLE, NEVER ON A REFUSAL. An HTTP 400 means the request
 * was wrong and the next one may well be right — tripping on that would disable
 * a working service because the model sent a bad prompt once. Only "no response"
 * counts: a timeout, a DNS failure, a refused connection.
 *
 * ⚠️ AND IT IS PER-PROCESS, DELIBERATELY. A CLI run is minutes long, so there is
 * no half-life worth modelling and no reason to make a dead service recoverable
 * mid-run — the next invocation gets a clean slate for free, which is exactly
 * the retry policy a human would apply.
 */

/** endpoint URL → the reason it was declared dead. */
const dead = new Map();

/** Reset between tests. Never called in normal operation — a run is short. */
export function resetBreakers() {
  dead.clear();
}

/**
 * Is this endpoint already known to be unreachable this run?
 * Returns the recorded reason, or null.
 */
export function deadReason(url) {
  return dead.get(String(url)) ?? null;
}

/**
 * Record that an endpoint did not answer.
 *
 * ⚠️ The CALLER decides whether the failure was "no response" or merely "no",
 * because only the caller can tell an AbortError apart from an HTTP 422. Passing
 * an application-level refusal here would be the bug this module exists to
 * avoid.
 */
export function markUnreachable(url, reason) {
  dead.set(String(url), String(reason ?? 'no response'));
}

/**
 * The message a later caller gets. It must NOT invite another attempt.
 *
 * ⚠️ THE ORIGINAL TEXT SAID "try once more" AND THE MODEL DID, twice. An error
 * string is an instruction to whatever reads it, and a model reads it literally.
 * This one closes the door and names the alternative, so the round is spent on
 * work instead of on waiting.
 */
export function skipMessage(label, url) {
  const why = deadReason(url);
  return `${label} is not responding this session (${why}). Skipping it rather than waiting again — `
    + 'earlier attempts already spent the full timeout. Carry on without it and say so in your summary; '
    + 'do not call this tool again in this run.';
}

/**
 * Wrap a fetch so the breaker is consulted first and tripped on a network-level
 * failure. Returns `{ ok: false, skipped: true, error }` when already dead.
 *
 * ⭐ Kept as a wrapper rather than a rule each call site reimplements: the two
 * existing callers already disagreed about what an unreachable service should
 * say, which is how "try once more" survived in one of them.
 */
export async function throughBreaker(url, label, run) {
  const already = deadReason(url);
  if (already) return { ok: false, skipped: true, error: skipMessage(label, url) };
  try {
    return await run();
  } catch (err) {
    const networkLevel = err?.name === 'TimeoutError'
      || err?.name === 'AbortError'
      || Boolean(err?.cause?.code);
    if (networkLevel) {
      const why = err?.name === 'TimeoutError' ? 'timed out' : (err?.cause?.code ?? err?.name ?? 'no response');
      markUnreachable(url, why);
    }
    throw err;
  }
}
