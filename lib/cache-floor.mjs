/**
 * ── ⭐⭐ THE INSTRUMENT. THE CACHE RATE IS THE MARGIN, SO IT GETS MEASURED ───
 *
 * `lib/plan.mjs` sizes every tier on holding a cache floor, and
 * `acuvo-gateway/PRICING.md` §5 states the arithmetic behind it:
 *
 *     cache floor = sharedHead ÷ typicalPrompt
 *
 * ⚠️⚠️ AND UNTIL THIS FILE EXISTED, NEITHER TERM HAD EVER BEEN MEASURED.
 * PRICING.md tabulates 25k/40k and 40k/60k as illustrations and closes with the
 * open item *"measure the achieved cache floor"*. A margin that leans on a
 * number nobody has read off the wire is a margin nobody has.
 *
 * ── ⚠️⚠️ SHARED BYTES ARE NOT A SHARED PREFIX, AND THE GAP IS THE WHOLE TRAP ─
 *
 * A prompt cache reuses everything up to the FIRST DIFFERING BYTE and pays full
 * price for everything after it. So "these two requests are 98.9% identical" is
 * not a cache claim at all — two requests can share 98.9% of their bytes and
 * cache at exactly 0% if the 1.1% that differs sits at the front.
 *
 * ⭐ THAT IS WHY THIS FILE REPORTS BOTH. A probe that reports only the shared
 * fraction cannot tell "our prefix is perfect and the provider is routing us
 * somewhere cold" apart from "our prefix moved at byte 200" — and those two have
 * completely different fixes. `describeDivergence` names the byte, so the
 * question stops being a guess.
 *
 * ⚠️ EVERYTHING HERE IS PURE. It takes strings and returns numbers: no fetch, no
 * provider, no key. That is deliberate — the half of the cache contract we
 * control is the bytes we send, and it is the half that can be tested for $0.00
 * on every commit. What a provider then does with those bytes is measured with
 * `acuvo --json`'s `.cache` block against a real key, and this file's numbers are
 * what make that reading interpretable.
 *
 * ⚠️ BYTES, NOT TOKENS, AND THE DIFFERENCE IS STATED RATHER THAN HIDDEN. A
 * tokeniser is provider-specific and we do not ship one; bytes are exact, ours,
 * and monotone in the thing we care about. A floor computed in bytes is an
 * ESTIMATE of the floor in tokens — close, because the shared head and the tail
 * are the same kind of text, and never presented as anything else.
 */

/**
 * Length of the byte-identical run the two strings begin with.
 *
 * ⚠️ THIS IS THE ONLY QUANTITY A PREFIX CACHE PAYS FOR. Anything shared further
 * in is shared bytes, not cache.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function sharedPrefixBytes(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  const n = Math.min(x.length, y.length);
  let i = 0;
  while (i < n && x[i] === y[i]) i += 1;
  return i;
}

/**
 * Length of the byte-identical run the two strings END with.
 *
 * ⭐ WORTH NOTHING TO THE CACHE AND EVERYTHING TO THE DIAGNOSIS. A large shared
 * suffix beside a small shared prefix is the signature of one varying field near
 * the front — which is a fix we own. A small shared suffix beside a large shared
 * prefix is the ordinary, healthy shape: the task text differs and nothing else.
 *
 * ⚠️ Clamped so the two runs cannot overlap and double-count on near-identical
 * inputs — without the clamp two equal strings report `2 × length` shared.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function sharedSuffixBytes(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  const limit = Math.min(x.length, y.length) - sharedPrefixBytes(x, y);
  if (limit <= 0) return 0;
  let i = 0;
  while (i < limit && x[x.length - 1 - i] === y[y.length - 1 - i]) i += 1;
  return i;
}

/**
 * ── ⭐ THE FLOOR, AND WHY IT IS DIVIDED BY THE LARGER PROMPT ────────────────
 *
 * `sharedHead ÷ typicalPrompt`. When two prompts differ in length the honest
 * denominator is the LARGER of the two: the cache pays for the head once and we
 * are billed for every uncached byte of whichever request is bigger, so dividing
 * by the smaller would quote a floor no request actually achieves.
 *
 * ⚠️ null, never 0 and never NaN, when there is no prompt behind it. A rate with
 * an empty denominator is not a measurement — the same rule `aggregateCache` in
 * `turn.mjs` already follows for a session with no reported rounds.
 *
 * @param {{ sharedHead: number, typicalPrompt: number }} sizes
 * @returns {number | null} 0..1
 */
export function cacheFloor({ sharedHead, typicalPrompt } = {}) {
  const head = Number(sharedHead);
  const prompt = Number(typicalPrompt);
  if (!Number.isFinite(head) || !Number.isFinite(prompt) || prompt <= 0) return null;
  if (head <= 0) return 0;
  // ⚠️ A head longer than the prompt is a caller error, not a floor above 100%.
  return Math.min(1, head / prompt);
}

/**
 * ── ⭐⭐ THE ONE READING THAT ANSWERS "WHY DID THIS NOT CACHE" ──────────────
 *
 * Given two wire payloads, returns the shared prefix, the shared suffix, the
 * floor, and — the part that turns a number into an action — the byte where they
 * part company with a window of context from each side.
 *
 * ⚠️ THE WINDOW IS WHAT MAKES IT USABLE. "diverged at byte 10,693" is a fact
 * nobody can act on; "diverged at byte 10,693, where A has `git_push` and B does
 * not" is a fix. `context` bytes either side, clamped to the strings.
 *
 * @param {string} a
 * @param {string} b
 * @param {{ context?: number }} [opts]
 */
export function describeDivergence(a, b, { context = 120 } = {}) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  const prefix = sharedPrefixBytes(x, y);
  const suffix = sharedSuffixBytes(x, y);
  const larger = Math.max(x.length, y.length);
  const identical = x === y;
  const span = Math.max(0, Math.trunc(context));
  return {
    identical,
    bytesA: x.length,
    bytesB: y.length,
    sharedPrefix: prefix,
    sharedSuffix: suffix,
    /**
     * ⚠️ THE FIGURE THAT LOOKS LIKE A CACHE RATE AND IS NOT ONE. Reported so a
     * reader who has been handed "98.9% shared" can see it beside the number
     * that actually bills, rather than mistaking one for the other.
     */
    sharedFraction: larger > 0 ? (prefix + suffix) / larger : null,
    floor: cacheFloor({ sharedHead: prefix, typicalPrompt: larger }),
    /** null when the strings are identical — there is no divergence to point at. */
    at: identical ? null : prefix,
    aroundA: identical ? null : x.slice(Math.max(0, prefix - span), prefix + span),
    aroundB: identical ? null : y.slice(Math.max(0, prefix - span), prefix + span),
  };
}

/**
 * ── ⭐ WHAT A PROVIDER ACTUALLY HASHES, IN THE ORDER IT SEES IT ─────────────
 *
 * The tool schemas are a TOP-LEVEL field on the request and are rendered into
 * the prompt ahead of the messages, so a probe that serialises only
 * `opts.messages` is measuring the second half of the prefix and calling it the
 * whole thing. Measured on this repo 2026-08-16: the tools block is **21,466 of
 * the 22,889 shared bytes** between two tenants — 94% of the entire shared head.
 * A prefix probe that cannot see it is blind to the part that matters most.
 *
 * ⚠️ THIS IS A STABLE SERIALISATION FOR MEASUREMENT, NOT THE WIRE FORMAT.
 * `callModel` builds the real body with more fields on it; every one of those is
 * either constant across requests or irrelevant to the prefix. What matters is
 * that this function is deterministic and puts the same things in the same
 * order every time it is called, which is exactly what makes two readings
 * comparable.
 *
 * @param {{ tools?: any, messages?: any }} request
 * @returns {string}
 */
/**
 * ── ⭐⭐ THE SAME BYTES, SERIALISED SO THAT APPENDING EXTENDS THE STRING ─────
 *
 * `wireBytes` wraps everything in one JSON object, which is right for comparing
 * two DIFFERENT requests — the envelope is shared, so it cancels out.
 *
 * ⚠️ IT IS WRONG FOR COMPARING ROUND N TO ROUND N+1, and the error looks exactly
 * like a defect. A conversation is append-only, but `{"messages":[a,b]}` is NOT
 * a prefix of `{"messages":[a,b,c]}` — the closing `]}` sits between them. So a
 * perfectly stable loop measures 99.99% and reports drift on every single round.
 *
 * ⭐ MEASURED WHEN EXACTLY THAT HAPPENED: 32,272 of 32,274 bytes shared, and the
 * two missing ones were `]}`. A naive reading of that says "we void our own
 * cache every round", which is false, and would have sent somebody hunting a
 * bug that does not exist. **The instrument has to be right before its readings
 * mean anything.**
 *
 * Here each part is serialised separately and joined with a delimiter that
 * cannot occur in JSON text, so appending a message strictly EXTENDS the string
 * and an append-only round measures exactly 1.
 *
 * ⚠️ This is for round-over-round comparison ONLY. Across two different requests
 * use `wireBytes` — this one's delimiter is not what any provider receives.
 */
export function appendOnlyWireBytes({ tools = null, messages = [] } = {}) {
  const parts = [JSON.stringify(tools ?? null)];
  for (const m of messages) parts.push(JSON.stringify(m));
  return parts.join(' ');
}

export function wireBytes({ tools = null, messages = [] } = {}) {
  return JSON.stringify({ tools, messages });
}
