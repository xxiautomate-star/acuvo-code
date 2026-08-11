/**
 * THE MODEL CALL — one provider, one round-trip, and a failure that says what
 * to do about it.
 *
 * ── WHY THIS IS NOT `console/lib/llm.ts` ────────────────────────────────────
 * The console's transport is the right thing for the console: a four-provider
 * chain with rate-limit-aware reordering, prompt-cache annotation, tier gates
 * and a meter. It is also TypeScript that imports `@/lib/codegen-cost` →
 * `@/lib/plan-catalog` → the Next path alias, and pulling it in here would drag
 * a Next/TS build into a package whose entire point is `node acuvo.mjs` with
 * zero install. Re-implementing 700 lines of chain logic would be the fork this
 * architecture forbids; calling ONE endpoint with the same message shape is not
 * a fork, it is the second client.
 *
 * ⚠️ SO THE DEBT IS NAMED RATHER THAN HIDDEN: this client is SINGLE-PROVIDER,
 * which breaks the house rule "never single". That is acceptable for a local
 * developer tool where the failure mode is "the command exits with a message
 * you can read" — and unacceptable the moment this path serves a customer. The
 * fix when it matters is to extract the console's chain into a dependency-free
 * `.mjs` both clients import, not to grow a second chain here.
 *
 * ── THE FAILURE MESSAGE IS THE FEATURE ──────────────────────────────────────
 * A coding agent that hangs, or dies on `Cannot read properties of undefined`,
 * is worse than one that does not exist — you cannot tell a broken key from a
 * broken tool from a broken network. Every exit from here is a sentence naming
 * the cause and the next action, and `classifyHttpFailure` is pure so the whole
 * table is testable without spending a cent.
 */

import { TOOL_SCHEMAS } from './tools.mjs';
import { collectStream } from './stream.mjs';


/**
 * ⭐ v4-flash, measured 2026-08-09 against v3.2-exp on an identical brief:
 * $0.000842 vs $0.001465 (1.7x cheaper), 50s vs 95s (1.9x faster), and it
 * emitted a correctly SIZED svg icon where v3.2-exp emitted none. Reasoning must
 * be off — see the request body below.
 */
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** One round-trip, generous: a coder model writing several whole files is slow,
 *  and a premature abort looks exactly like a hang to the person waiting. */
export const DEFAULT_TIMEOUT_MS = 180_000;
/**
 * ── ⭐ RAISED 8,000 → 12,000 (2026-08-10), AND EVERY DIGIT IS MEASURED ───────
 *
 * ⚠️ THE OLD CEILING DID NOT PRODUCE A SHORT FILE — IT PRODUCED NO FILE. Asked
 * for one large module at `max_tokens: 8000`, the completion was cut off INSIDE
 * the `write_file` tool-call JSON and the run died on
 * `tool arguments were not valid JSON: Unterminated string at position 27784`.
 * Zero bytes written, $0.001522 billed, nothing to show for it. Note this is
 * worse than the failure `report.mjs` warns about: the truncation lands in the
 * arguments, so it surfaces as a REFUSAL, and the `finishReason === 'length'`
 * hint ("re-run with --max-tokens higher") never gets to fire. The user is told
 * the model emitted bad JSON, which sounds like a model defect rather than a
 * budget they can raise.
 *
 * ── WHY 12,000 AND NOT A ROUNDER, BIGGER NUMBER ─────────────────────────────
 * Measured completion density, twice, on the identical prompt: 27,784 chars of
 * tool-argument at 8k and 54,086 at 16k — 3.47 and 3.38 chars/token, 3.29
 * marginal. So the cost of re-emitting a whole file is `bytes / 3.29` tokens,
 * and this package's OWN lib/ says what that has to cover:
 *
 *     lib/git.mjs      24,110 B →  ~7,328 tok   fits 8k with 8% to spare
 *     lib/command.mjs  28,869 B →  ~8,775 tok   ✖ DID NOT FIT
 *     lib/policy.mjs   34,635 B → ~10,527 tok   ✖ DID NOT FIT
 *     lib/turn.mjs     80,015 B → ~24,320 tok   fits nothing sane
 *
 * At 8,000 this tool could not rewrite two of its own source files, and cleared
 * a third by 8% — one added comment from failing. 12,000 covers policy.mjs (the
 * largest plausible single rewrite) with ~14% headroom for the prose note and a
 * second tool call in the same response. turn.mjs is deliberately NOT covered:
 * sizing the default to re-emit 80KB would be sizing for exactly the case
 * `edit_file` exists to prevent.
 *
 * ── ⚠️ THE UPPER BOUND IS THE TIMEOUT, NOT THE PRICE ────────────────────────
 * Measured: a 16,000-token completion took 112s wall-clock. Against
 * DEFAULT_TIMEOUT_MS = 180s that puts the real delivery limit near ~25,000
 * tokens — above which the default would be advertising a ceiling the default
 * timeout cannot pay for. 12,000 lands at ~85s, under half the budget.
 *
 * ── 💸 COST IMPACT ──────────────────────────────────────────────────────────
 * `max_tokens` is a CEILING, billed only on tokens actually generated, so this
 * is $0.00 on ordinary work — verified: two real fix-and-verify runs spent
 * 11,746 and 16,258 tokens across 3-4 rounds TOTAL (prompt included) and never
 * came near 8,000 in a single completion. The only spend that changes is the
 * pathological one, where the worst case per round goes
 * 8,000 × $0.18/M = $0.00144  →  12,000 × $0.18/M = $0.00216  (+$0.00072).
 *
 * ⚠️ AND THAT COST IS REAL, WHICH IS THE ARGUMENT AGAINST GOING HIGHER. The 16k
 * probe above ALSO truncated — an unbounded request fills whatever ceiling you
 * give it, so raising this does not "fix" such a task, it just doubles the bill
 * for the same nothing ($0.001522 → $0.002917, measured). Raise to cover real
 * files; do not raise to chase a request no ceiling satisfies.
 */
export const DEFAULT_MAX_TOKENS = 12_000;

/**
 * Read the model configuration out of the environment.
 *
 * ⚠️ THE DEFAULT MODEL IS THE CHEAP CODER, DELIBERATELY, and for the reason
 * `console/lib/llm.ts` spells out at length: an unset env var must cost little
 * and be slightly worse, never cost a lot and be slightly better. The first
 * failure mode is visible in the output; the second is visible only on an
 * invoice.
 *
 * ⚠️ AND NOTE THE DRIFT THAT IS REAL: the console defaults to
 * `deepseek/deepseek-v3.2-exp` and prices that id in `codegen-cost.ts`. This
 * defaults to `deepseek/deepseek-v3.2` (both exist on OpenRouter; the non-exp
 * one is the stable release). They are two clients of one capability and they
 * should eventually agree — recorded here rather than silently unified, because
 * changing the console's priced default is a money decision, not a CLI one.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ apiKey: string, model: string, configured: boolean }}
 */
export function readModelConfig(env = process.env) {
  const apiKey = (env.OPENROUTER_API_KEY || '').trim();
  const model = (env.OPENROUTER_CODEGEN_MODEL || '').trim() || DEFAULT_MODEL;
  return { apiKey, model, configured: apiKey.length > 0 };
}

/**
 * ── ⚠️ THIS IS THE FIRST THING A NEW USER EVER SEES ─────────────────────────
 *
 * They installed it thirty seconds ago and typed a prompt. Whatever this says is
 * their entire first impression, and it decides whether they go and get a key or
 * close the terminal.
 *
 * ⚠️ THE PREVIOUS VERSION FAILED TWO WAYS, BOTH INVISIBLE FROM INSIDE THE
 * MONOREPO:
 *   1. It never said WHERE TO GET A KEY — it explained how to set a variable
 *      they do not have, answering the second question and skipping the first.
 *   2. It suggested `node --env-file=console/.env.local …`, a path that exists
 *      only in OUR repository. To anyone else that is noise from a tool that has
 *      clearly never been installed anywhere.
 *
 * ⭐ Short, one link, one command that works, and the cost stated — because
 * "is this going to charge me" is the real unspoken question, and the honest
 * answer happens to be excellent.
 */
export const MISSING_KEY_MESSAGE = [
  'Acuvo Code needs an OpenRouter key to reach a model.',
  '',
  '  1. Get one (free to create):  https://openrouter.ai/keys',
  '  2. Set it:',
  '       export OPENROUTER_API_KEY=sk-or-v1-...        (bash / zsh)',
  '       $env:OPENROUTER_API_KEY = "sk-or-v1-..."      (PowerShell)',
  '  3. Run the same command again.',
  '',
  `Typical cost is well under a cent per task. Default model: ${DEFAULT_MODEL}.`,
  'Already keep keys in a file?  node --env-file=.env "$(which acuvo)" "<prompt>"',
].join('\n');

/**
 * ── ⚠️⚠️ THE RESPONSE BODY IS NOT TRUSTED TEXT — IT CAN CONTAIN THE KEY ──────
 *
 * Corporate proxies and API gateways routinely echo the offending REQUEST back
 * inside their error page, headers and all. We then printed that body verbatim
 * as `detail`, so the key went to terminal scrollback, to CI job logs, and into
 * whatever the user pastes into a bug report — three places a secret is very
 * hard to recall from. Reproduced 2026-08-10: HTTP 407 with a body of
 * `authorization: Bearer sk-or-v1-…` printed the key in full.
 *
 * ⚠️ THIS RUNS BEFORE THE 400-CHAR SLICE, DELIBERATELY. Truncating first and
 * redacting second is worse than not redacting at all: the cut removes the tail
 * that made the pattern matchable, so a key straddling char 400 survives as a
 * twenty-character prefix that no regex will ever catch again. Measured on the
 * unfixed code — `sk-or-v1-STRADDLECAN` made it to the screen.
 *
 * Whole HEADER LINES go, not just the token: a value we failed to pattern-match
 * is still a credential if it sat after `authorization:`.
 */
function redact(text) {
  return String(text ?? '')
    // The credential-bearing header, value and all, whatever shape the value is.
    .replace(/^[ \t]*(authorization|proxy-authorization|x-api-key|api-key)[ \t]*:.*$/gim, '<header redacted>')
    // OpenRouter's own key format — hyphens included, so it must run before the
    // generic rule below, which would otherwise stop at the first hyphen.
    .replace(/sk-or-v1-[A-Za-z0-9._-]+/g, 'sk-…redacted')
    // Every other provider's `sk-…` key, loose on purpose: a false positive
    // costs a reader nothing, a false negative costs them a key.
    .replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-…redacted');
}

/**
 * Turn an HTTP status + response body into something a human can act on.
 *
 * Pure. Every branch here is a real OpenRouter behaviour rather than a guess:
 * 402 is what an exhausted balance returns, and it is the single most likely
 * failure for this account — measured 2026-08-09, the key authenticates and the
 * credits endpoint reports `total_credits: 0` against `total_usage: 0.028`.
 */
export function classifyHttpFailure(status, bodyText) {
  const snippet = redact(bodyText || '').slice(0, 400).trim();
  let apiMessage = '';
  try {
    // ⚠️ Parsed from the ORIGINAL body (redaction would not break JSON here, but
    // relying on that is a trap), then redacted on the way out — the provider's
    // own message is just as capable of quoting the key back at us.
    apiMessage = redact(JSON.parse(bodyText)?.error?.message || '');
  } catch {
    /* a non-JSON body is itself information; the snippet carries it */
  }
  const detail = apiMessage || snippet || '(no response body)';

  if (status === 401 || status === 403) {
    return `OpenRouter rejected the API key (HTTP ${status}). Check OPENROUTER_API_KEY is current and not revoked.\n  ${detail}`;
  }
  if (status === 402) {
    return `OpenRouter says this account cannot pay for the call (HTTP 402) — the balance is exhausted.\n  ${detail}\n\nTop up at https://openrouter.ai/credits, or set OPENROUTER_CODEGEN_MODEL to a ":free" model id.`;
  }
  if (status === 404) {
    return `OpenRouter does not serve that model (HTTP 404). Check OPENROUTER_CODEGEN_MODEL against https://openrouter.ai/models.\n  ${detail}`;
  }
  if (status === 429) {
    return `Rate limited by OpenRouter (HTTP 429). Wait and re-run, or switch OPENROUTER_CODEGEN_MODEL.\n  ${detail}`;
  }
  if (status >= 500) {
    return `OpenRouter or the upstream provider failed (HTTP ${status}). This is usually transient — re-run.\n  ${detail}`;
  }
  return `The model call failed (HTTP ${status}).\n  ${detail}`;
}

/**
 * ── ⚠️ `err.message` IS ALWAYS THE LITERAL STRING 'fetch failed' ─────────────
 *
 * Node's fetch wraps every transport fault in one TypeError with that exact
 * message and hangs the real cause off `err.cause.code`. Reading only `.message`
 * therefore printed IDENTICAL text for a DNS failure, a refused connection, a
 * corporate TLS MITM and a captive portal — four different problems with four
 * different fixes, all reported as "Could not reach OpenRouter: fetch failed".
 * `lib/github.mjs:107` already reads the cause code; this is that shape, with
 * the fix attached.
 */
const TRANSPORT_CAUSES = {
  ENOTFOUND: 'the hostname did not resolve — check DNS or your network',
  EAI_AGAIN: 'DNS lookup timed out — the resolver is unreachable or overloaded',
  ECONNREFUSED: 'the connection was refused — a proxy or firewall closed it',
  ECONNRESET: 'the connection was reset mid-request',
  ETIMEDOUT: 'the connection timed out before the server answered',
  UND_ERR_SOCKET: 'the socket closed before the response finished',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'a TLS certificate could not be verified — if you are behind a corporate proxy, set NODE_EXTRA_CA_CERTS=/path/to/ca.pem',
  SELF_SIGNED_CERT_IN_CHAIN: 'a TLS certificate could not be verified — if you are behind a corporate proxy, set NODE_EXTRA_CA_CERTS=/path/to/ca.pem',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'a TLS certificate could not be verified — if you are behind a corporate proxy, set NODE_EXTRA_CA_CERTS=/path/to/ca.pem',
};

/**
 * Everything that can go wrong before a reply exists, as one sentence.
 * Separated from the fetch so the table above is testable, and so a transport
 * exception is never re-thrown as a raw stack.
 *
 * ⚠️⚠️ THE PHRASE 'Could not reach OpenRouter' IS AN API, NOT PROSE.
 * `lib/chain.mjs:81` decides retryability by matching error TEXT, and connection
 * failures only fall back to a second provider because they happen to match
 * `/could not reach/i`. Reword this prefix and you silently switch fallback off
 * for the entire class of faults fallback exists for. Change the sentence after
 * it as much as you like; leave those four words alone.
 */
export function describeTransportError(err, timeoutMs) {
  const name = err?.name || '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `No response from OpenRouter within ${Math.round(timeoutMs / 1000)}s — the call was aborted rather than left hanging.`;
  }
  const code = err?.cause?.code || err?.code || '';
  const known = TRANSPORT_CAUSES[code];
  if (known) return `Could not reach OpenRouter: ${known} (${code}).`;
  // Unknown cause: say the code anyway if there is one. A code we have not
  // catalogued is still searchable; 'fetch failed' on its own is not.
  if (code) return `Could not reach OpenRouter: ${message} (${code}). Check the network, DNS, and any proxy.`;
  return `Could not reach OpenRouter: ${message}\nCheck the network, DNS, and any proxy between you and openrouter.ai.`;
}

/**
 * The assistant message out of an OpenAI-shaped body, or a reason it is absent.
 *
 * @typedef {{ function?: { name?: string, arguments?: string } }} RawToolCall
 * @typedef {{ ok: true, content: string | null, toolCalls: RawToolCall[], finishReason: string | null, usage: { cost?: number, total_tokens?: number } | null }} ReplyOk
 * @param {any} body
 * @returns {ReplyOk | { ok: false, error: string }}
 */
export function extractReply(body) {
  const choice = body?.choices?.[0];
  if (!choice) return { ok: false, error: 'the model returned no choices — nothing to act on' };
  const message = choice.message;
  if (!message) return { ok: false, error: 'the model returned a choice with no message' };
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  /**
   * ── ⚠️⚠️ THE DEGENERATE 200: BILLED, AND WITH NOTHING IN IT ────────────────
   *
   * A provider can answer 200 with a message carrying neither content nor a
   * tool call. The call happened, the tokens were billed, and there is nothing
   * to act on. This used to return `ok: true` with `content: null`, and that
   * travelled all the way out as a FINISHED SESSION — exit 0, zero files
   * changed, no error printed, and no fallback ever attempted.
   *
   * ⭐ AND IT MADE chain.mjs's OWN GUARD DEAD CODE. That file carries
   * `if (/empty reply|no content|returned nothing/i.test(e)) return true;` and
   * calls it "the single most important line here" — but it classifies an ERROR
   * STRING, and this function never produced one for this case. So the chain
   * had three healthy fallback models it could never reach on the one failure
   * that costs a whole call. The wording below is chosen to match that pattern;
   * `test/transport-empty-reply.test.mjs` asserts the two agree, so renaming
   * this message without updating the classifier fails a test rather than
   * silently re-opening the hole.
   *
   * ⚠️ `content: null` WITH TOOL CALLS IS THE NORMAL SHAPE — it is what every
   * tool-calling turn looks like, and some providers send `''` rather than
   * null. Only the case with NEITHER is degenerate. Widening this check to
   * "content is empty" would refuse every tool call in the product.
   */
  const hasText = typeof message.content === 'string' && message.content.trim() !== '';
  if (!hasText && toolCalls.length === 0) {
    return {
      ok: false,
      error: 'the model returned an empty reply — no content and no tool calls, so there is nothing to act on',
    };
  }

  return {
    ok: true,
    content: typeof message.content === 'string' ? message.content : null,
    toolCalls,
    finishReason: choice.finish_reason ?? null,
    // ⚠️ OpenRouter reports the REAL cost of the call in `usage.cost`. Printing
    // it is not decoration: this repo's standing rule is that pre-revenue every
    // infra dollar is burn, and a local tool that spends silently is exactly how
    // a binge happens without anyone noticing.
    usage: body?.usage ?? null,
  };
}

/**
 * One completion. Never throws — returns `{ ok }` either way, because the
 * caller's job is to print a summary, not to catch.
 *
 * @returns {Promise<(ReplyOk & { model: string }) | { ok: false, error: string }>}
 */
/**
 * ── ⭐ STREAMING IS OPT-IN PER CALL, NOT A MODE ─────────────────────────────
 * `onText` present = stream. Absent = the exact previous behaviour, byte for
 * byte. That keeps every existing test, the bench, and any caller that wants a
 * whole answer unchanged — a global switch would have made "did streaming break
 * this?" a question on every future bug.
 */
export async function callModel({
  apiKey, model, messages, onText = null,
  // ⚠️ THE CALLER CHOOSES WHAT TO OFFER. Defaulting to the whole registry keeps
  // this honest for a future multi-round client; the single-shot turn narrows
  // it deliberately (see SINGLE_SHOT_TOOL_NAMES and the measurement behind it).
  tools = TOOL_SCHEMAS,
  timeoutMs = DEFAULT_TIMEOUT_MS, maxTokens = DEFAULT_MAX_TOKENS, fetchImpl = fetch,
}) {
  const streaming = typeof onText === 'function';
  const payload = {
    model,
    messages,
    tools,
    ...(streaming ? { stream: true } : {}),
    tool_choice: 'auto',
    /**
     * ⚠️ THE FIELD THAT DECIDES WHETHER A MULTI-FILE TASK IS POSSIBLE AT ALL.
     * In a one-round turn, "one tool call per response" means one FILE per
     * command — measured 2026-08-09: asked for a module plus its test, the model
     * wrote the module, said it was writing both, and there was no second round
     * to finish in. A direct probe of the same model DID return two calls, so
     * the capability is there and OpenRouter's upstream routing (Baidu vs
     * StreamLake on the same model id) is what varies.
     *
     * ⭐ CORRECTED 2026-08-09 — AND THE ORIGINAL NOTE WAS BLAMING THE WRONG
     * THING. It read: "this model writes ONE file per response regardless of how
     * many it promises… parallel_tool_calls did not fix it." That was measured on
     * `deepseek-v3.2`, and it is NOT true of `deepseek-v4-flash-0731`.
     *
     * Re-measured on v4 with reasoning disabled: asked for three files
     * (src/add.js, src/sub.js, src/index.js re-exporting both) it wrote **all
     * three in one turn**, correctly, for $0.000110 — and the result runs:
     * add(2,3)=5, sub(9,4)=5.
     *
     * ⚠️ THE LESSON IS ABOUT THE NOTE, NOT THE MODEL. A limitation was recorded
     * against "this model" when it belonged to one specific version, and it then
     * read as a permanent ceiling — the kind of stale pessimism that stops people
     * retrying something that already works. Version the claim or do not make it.
     */
    parallel_tool_calls: true,
    /**
     * ── ⚠️⚠️ WITHOUT THIS, v4 AND qwen3.7 RETURN NOTHING AT ALL ──────────────
     * Measured 2026-08-09 across three models in one day. `deepseek-v4-*` and
     * `qwen3.7-*` ship a native reasoning budget ON BY DEFAULT and will spend
     * the whole completion allowance thinking, returning
     * `choices[0].message.content: null` — a billed HTTP 200 with no answer and
     * no tool calls, which this CLI would report as "the model wrote nothing".
     *
     * ⚠️ It is NOT a small-budget problem: the codegen bake-off gave v4 9,000
     * tokens and still got 0 bytes back. Capping reasoning EFFORT does not help;
     * only switching it off does.
     *
     * On identical input, off measured 1.7x cheaper AND 1.9x faster AND the only
     * setting that produces output. The console applies the same rule in
     * `lib/llm.ts` (REASONING_ON_BY_DEFAULT) — ⚠️ two copies of one fact, which
     * is a real debt: the shared transport this package still lacks is where it
     * belongs.
     */
    ...(/(qwen3\.7|deepseek-v4)/i.test(model) ? { reasoning: { enabled: false } } : {}),
    max_tokens: maxTokens,
    temperature: 0.2,
    // Asking for usage accounting is free and is the only way the cost line
    // below is a measurement rather than an estimate.
    usage: { include: true },
  };

  let res;
  try {
    res = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter uses these for attribution; harmless and polite.
        'HTTP-Referer': 'https://acuvo.xxiautomate.com',
        'X-Title': 'Acuvo Code',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: describeTransportError(err, timeoutMs) };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: classifyHttpFailure(res.status, text) };
  }

  /**
   * ⚠️ STREAMED AND WHOLE RESPONSES DIVERGE HERE AND NOWHERE ELSE. Both paths
   * produce the identical reply shape, so the loop, the summary and the chain
   * never learn which one ran.
   */
  if (streaming) {
    /**
     * ── ⚠️ `!res.body` WAS A GATE THAT COULD NEVER OPEN ────────────────────────
     * undici populates `res.body` on EVERY body-bearing response, so the
     * whole-body fallback below was dead code for as long as it existed — and
     * the comment above it confidently described behaviour that never ran.
     * Measured 2026-08-10: a textbook 200 carrying
     * `{"choices":[{"message":{"content":"ok"}}]}` was fed to the SSE parser,
     * which found no `data:` lines and reported "the stream closed without
     * sending anything". That phrase is not in `isRetryable`'s vocabulary, so the
     * chain STOPPED — on a completion that was correct and already billed.
     *
     * ⚠️ THE `ct &&` GUARD IS NOT DEFENSIVE PADDING. A stub or a proxy that sends
     * no content-type tells us nothing, and inferring "then it must be JSON"
     * would break real streaming on the strength of a missing header. No header
     * = today's behaviour, unchanged.
     */
    const ct = (typeof res.headers?.get === 'function' ? res.headers.get('content-type') : '') || '';
    if (!res.body || (ct && !/text\/event-stream/i.test(ct))) {
      // ⚠️ Not an error — a provider that ignored `stream:true` and sent JSON.
      // Falling through to the whole-body path is more useful than failing.
      let whole;
      try {
        whole = await res.json();
      } catch (err) {
        /**
         * ⚠️ THE OLD `.catch(() => null)` FLATTENED TWO DIFFERENT WORLDS. A body
         * that is not JSON is the provider's fault and retrying will produce the
         * same thing; a body that ABORTED halfway is the network's fault and the
         * next provider will very likely work. Reporting both as "neither a
         * stream nor JSON" made the second one non-retryable.
         */
        if (err?.name === 'SyntaxError') {
          return { ok: false, error: 'the provider returned a 200 whose body is neither an event stream nor JSON.' };
        }
        return { ok: false, error: describeTransportError(err, timeoutMs) };
      }
      if (!whole) return { ok: false, error: 'the provider returned neither a stream nor JSON.' };
      const r = extractReply(whole);
      return r.ok ? { ok: true, ...r, model } : { ok: false, error: r.error };
    }
    /**
     * ── ⚠️⚠️ THIS AWAIT USED TO BE THE ONE THAT ENDED THE SESSION ─────────────
     * A dropped socket mid-stream surfaces from undici as `TypeError:
     * terminated`. Uncaught here it escaped past turn.mjs's deliberate "a
     * mid-loop model failure is not a whole-session failure" handling, out of
     * main(), and printed "acuvo crashed — this is a bug in acuvo-code". Exit 1,
     * and under `--json` stdout was EMPTY — so the whole summary went with it,
     * including the file round 1 had already written to disk, and no fallback in
     * the chain was ever tried. `callModel`'s contract is that it never throws;
     * only the fetch honoured it.
     */
    let collected;
    try {
      collected = await collectStream(res.body, { onText });
    } catch (err) {
      return { ok: false, error: describeTransportError(err, timeoutMs) };
    }
    if (!collected.ok) return { ok: false, error: collected.error };
    return { ok: true, ...collected, model };
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    // ⚠️ Same trap as the streaming branch above, and it was here too: a body
    // that aborted mid-read is a TRANSPORT fault, and calling it "not JSON"
    // told the chain not to bother with the next provider.
    if (err?.name !== 'SyntaxError') return { ok: false, error: describeTransportError(err, timeoutMs) };
    return { ok: false, error: 'OpenRouter returned a 200 with a body that is not JSON.' };
  }
  const reply = extractReply(body);
  if (!reply.ok) return { ok: false, error: reply.error };
  return { ok: true, ...reply, model };
}
