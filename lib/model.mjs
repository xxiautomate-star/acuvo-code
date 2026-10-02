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
import { resolveCredential } from './account.mjs';
/**
 * ⚠️ FOR ONE NUMBER IN ONE USER-FACING SENTENCE, and it is worth the import:
 * that sentence hardcoded `$0.02` for two weeks after the default became $0.05,
 * so the message shown to someone with no key understated what the tool may
 * spend on their behalf by 2.5x. `budget.mjs` imports only `rate-card.mjs`, so
 * this adds no cycle.
 */
import { DEFAULT_BUDGET_USD } from './budget.mjs';
import { PROVIDER_PIN_BY_MODEL, DEFAULT_PROVIDER_ORDER, REFUSED_PROVIDERS, costOrderedFallback } from './provider-pin.mjs';
/**
 * ⭐ THE PRICE, FROM THE ONE PLACE PRICES LIVE. `rate-card.mjs` has no imports
 * of its own, so this cannot cycle; and routing that carried its own idea of a
 * rate would be a second opinion about money, which is the defect that file's
 * header is a post-mortem of.
 */
import { providerRateFor, blendedPerMillion, OUTPUT_TOKEN_SHARE } from './rate-card.mjs';


/**
 * ⭐ v4-flash, measured 2026-08-09 against v3.2-exp on an identical brief:
 * 1.7x cheaper, 1.9x faster (50s vs 95s), and it emitted a correctly SIZED svg
 * icon where v3.2-exp emitted none. Reasoning must be off — see the request
 * body below.
 */
/**
 * ⚡ V4.1 FLASH SINCE 2026-09-28, EVERY PLAN — owner decision: *"speed is a moat and deepseek
 * v4.1 flash is notoriously fast"*. Pin and measurements: `provider-pin.mjs` / console
 * `provider-pin.ts`. ⚠️ Reasoning: v4.1 is NOT in `REASONING_ON_MODELS`, so the field is absent and
 * the vendor default applies — measured 2026-09-28 that default THINKS (2,589 of 3,000 output
 * tokens were reasoning on one builder-sized call). That is the retest trigger the note below names.
 */
export const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * ── ⭐⭐⭐ DIRECT TO DEEPSEEK — THE ONLY WAY THE CACHE IS RELIABLE ─────────
 *
 * Roman, 2026-08-19: *"the caching still isn't 90 percent … if it's not 90 our
 * product is gone."* He is right, and this is why it was not.
 *
 * ⚠⚠ MEASURED, and it is not prefix drift. **99.9% of the prompt is
 * byte-identical across two completely different tasks** — the tools JSON alone
 * is 60,799 chars, 92% of the payload, and never changes. The ceiling is 99.9%.
 *
 * What actually happens on OpenRouter, measured over four consecutive real runs:
 *
 *     run 1  cache 65%   round 1  0%
 *     run 2  cache 98%   round 1 98%
 *     run 3  cache 31%   round 1  0%
 *     run 4  cache 98%   round 1 98%
 *
 * and on the SAME task three times: 0% → 79% → 99%.
 *
 * ⭐ THAT IS A ROUTING LOTTERY, NOT A CACHE PROBLEM. A prompt cache lives on ONE
 * SERVER. An aggregator's `provider` field pins the COMPANY, and a company is a
 * fleet of machines. Pinning the provider does not pin the machine, so each run
 * rolls the dice and warms whichever server it landed on. No amount of prefix
 * discipline can fix that from our side.
 *
 * ⚠️ Going direct removes the lottery entirely: one vendor, one endpoint, their
 * own automatic context caching, and no aggregator choosing a server for us.
 *
 * ⚠️ OFF UNLESS `DEEPSEEK_API_KEY` IS SET. No key, no behaviour change — this
 * cannot silently re-route anyone's traffic or spend on an account they did not
 * choose.
 */
export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

/**
 * DeepSeek's own model ids differ from the aggregator's slugs. Mapping only what
 * we actually pin; an unmapped model falls through to OpenRouter rather than
 * being guessed at, because a wrong id is a 404 that reads like an outage.
 */
export const DEEPSEEK_DIRECT_MODELS = Object.freeze({
  'deepseek/deepseek-v4-flash-0731': 'deepseek-chat',
  'deepseek/deepseek-v4-pro-0813': 'deepseek-reasoner',
});

/**
 * Can this call go direct? Requires a key AND a model we can name on their API.
 * @returns {{ url: string, apiKey: string, model: string } | null}
 */
export function directDeepSeek(model, env = process.env) {
  /**
   * ── ⭐⭐⭐ OFF UNLESS EXPLICITLY ASKED FOR (Roman, 2026-08-22) ──────────────
   *
   * *"no direct deepseek api, we can just use the rest of it for testing."*
   *
   * ⚠️ A KEY BEING PRESENT IS NOT A REQUEST TO USE IT. Before this line, merely
   * exporting `DEEPSEEK_API_KEY` silently re-routed every build onto the direct
   * endpoint — which is several times dearer on OUTPUT, and dearer again for
   * hours a day inside that vendor's peak-rate window (`deepseek-hours.mjs`
   * models the window; nothing here has to know the clock). Silently changing
   * which vendor serves a build, and therefore what it costs, is not a decision
   * an environment variable should be able to make on its own.
   *
   * ⭐ THE TRAP IS THE CACHE-READ COLUMN. Direct's cached input really is the
   * cheaper of the two, and that is why this route once led by default. It
   * cannot pay for the cache MISSES or the OUTPUT, and output is the majority of
   * a coding run's bill and is never cached. Never rank two routes on one price
   * column — rank them on the blend you actually send.
   *
   * Mirrors `deepSeekDirectEnabled()` in `console/lib/llm.ts` — the builder and
   * the CLI must not disagree about which vendor serves a build.
   */
  if (String(env?.ACUVO_DEEPSEEK_DIRECT ?? '') !== '1') return null;
  const key = String(env?.DEEPSEEK_API_KEY ?? '').trim();
  if (!key) return null;
  const mapped = DEEPSEEK_DIRECT_MODELS[String(model ?? '')];
  if (!mapped) return null;
  return { url: DEEPSEEK_URL, apiKey: key, model: mapped };
}

/**
 * ── ⚠️⭐ A TEST SEAM THAT CANNOT BECOME AN EXFILTRATION CHANNEL ─────────────
 *
 * The whole SUCCESS path of this CLI — the report, the change list, the inline
 * image rendering — was untestable, because every test drives `bin` with a dead
 * key and stops at the refusal. A `ReferenceError` on that path shipped and
 * 1,413 green tests said nothing; only a live run found it.
 *
 * ⚠️ THE OBVIOUS FIX IS DANGEROUS. A plain `ACUVO_API_URL` override redirects
 * where `Authorization: Bearer <the user's key>` is SENT. Anything that can set
 * an environment variable could then quietly harvest the key, and "env access
 * already implies code execution" is a bad excuse for handing it a ready-made
 * exfiltration primitive with a documented name.
 *
 * ⭐ SO IT IS ACCEPTED ONLY FOR LOOPBACK. A test can point it at a server it
 * just started on 127.0.0.1; nobody can point it anywhere the key would leave
 * this machine. Non-loopback values are not silently ignored either — being
 * ignored is how a misconfiguration turns into a mystery — they THROW.
 */
/**
 * ── ⭐⭐⭐ THINKING IS ON FOR THE CODING MODEL, AND IT IS A MEASURED TRADE ────
 *
 * ⚠️ THE RULE THIS REPLACES WAS AN UNDATED WILDCARD. `deepseek-v4-*` +
 * `qwen3.7-*` were switched off together on 2026-08-09 because they returned
 * `content: null` with no tool calls, and the note carried no model version —
 * exactly what the comment 30 lines below it forbids: *"Version the claim or do
 * not make it."* It then went unretested for three and a half weeks while the
 * ladder was repointed and the client's own empty-reply handling was rewritten.
 *
 * ── WHAT WAS MEASURED, 2026-09-02, `deepseek/deepseek-v4-flash-0731` ────────
 *
 * **1. "Returns nothing at all" does not reproduce.** 12 sampled completions on
 * the largest round a coding run has — the one that emits two whole files as
 * tool-call arguments — produced **0 empty replies** in either setting. Every
 * one came back `finish_reason: tool_calls`.
 *
 * **2. It changes the code, on the task where judgement is the work.** A
 * multi-file refactor (rename an exported symbol across 3 files; move a
 * parameter in a signature), run both ways through the real CLI:
 *
 *     OFF   7 rounds   50s   $0.00425   9x edit_file, never rename_symbol
 *           → shipped `(code, name, currency: Currency = 'AUD', kind: AccountKind)`
 *             and stated it "preserves the existing default behavior".
 *             ⚠️ IT DOES NOT. tsc rejects the 3-argument call that default is
 *             for: `error TS2554: Expected 4 arguments, but got 3`. Green tests,
 *             dead default, false justification. A reviewer sends this back.
 *     ON   14 rounds  3m30s  $0.00996   3x rename_symbol + 3x edit_file
 *           → removed the unreachable default, named the TypeScript rule as the
 *             reason, and re-read its own diff before stopping. Accepted.
 *
 * ⭐ AND THAT IS ALSO HOW `rename_symbol` FINALLY GOT USED. It was offered in
 * BOTH runs — `shortlistTools` puts it in `intel` and the brief says "rename" —
 * and only the thinking run reached for it. A semantic verb nobody calls is a
 * verb we did not ship; this setting is what called it.
 *
 * **3. On a localised bug it buys nothing.** A failing test with one root cause
 * produced the byte-identical patch both ways, in the same 4 rounds:
 * OFF $0.00195 / 27s, ON $0.00217 / 67s.
 *
 * **4. The price, from the same runs — NOT the 4.4x a single small call shows.**
 * A one-shot completion is nearly all thinking; an agentic round is nearly all
 * cached prompt. Real end-to-end runs came in at **1.11x (bug fix) to 2.34x
 * (refactor)**, and the refactor is dearer partly because it did more: it used
 * the compiler and reviewed its diff. Latency is the honest cost: **2.5x-4x**.
 *
 * ⚠️⚠️ **5. IT IS BIMODAL, AND THAT IS THE REAL RISK.** Of 6 sampled write
 * rounds with thinking on, 4 spent 0 reasoning tokens and wrote the files; 2
 * spent 5,497 and 6,501 reasoning tokens and then issued `read_file` twice
 * instead of writing anything. That stall is where the extra rounds and the
 * extra wall-clock come from, and it is why this is a flag and not a constant.
 *
 * ── WHAT IS AND IS NOT CHANGED ─────────────────────────────────────────────
 *
 * ⭐ ON for `deepseek-v4-flash-0731` ONLY — the id that was measured.
 * ⚠️ OFF for `qwen3.7-*`: never retested, and the original note names it the
 *    worse offender. Flipping it on this evidence would be the same undated
 *    wildcard in the other direction.
 * ⚠️ OFF for `deepseek-v4-pro`: never retested, and the ladder is repointed off
 *    pro anyway (flash benchmarks 82.7 and pro is worse).
 * ⚠️ `image-director.mjs` and `vision.mjs` also disable reasoning and are
 *    DELIBERATELY LEFT ALONE — those are image and vision calls, not coding, and
 *    nothing here measured them.
 *
 * ⭐ `ACUVO_REASONING=off` puts every model back to the old behaviour in one
 * line, with no deploy. That matters because this is a real cost increase and
 * Roman is pre-revenue. `on` forces it for a model the table would refuse,
 * which is the only way anyone can retest qwen or pro later.
 *
 * ⚠️ WHAT WOULD MAKE SOMEONE RETEST THIS: a change of pinned coding model, or
 * `deepseek-v4-flash` moving off `-0731`. The claim is about THAT id on THAT
 * date and nothing wider.
 *
 * ⚠️ AN UNRECOGNISED VALUE IS THE DEFAULT, NOT AN ERROR. A typo in a shell
 * profile must not stop a coding run — and must not silently mean "on" either,
 * which is why only the listed words count.
 *
 * @returns {{ reasoning: { enabled: boolean } } | {}} spread into the payload.
 */
/**
 * The one id thinking was measured on. ⚠️ Deliberately NOT a `deepseek-v4-*`
 * wildcard — a wildcard is what made the previous rule outlive its evidence.
 */
export const REASONING_ON_MODELS = Object.freeze([/deepseek-v4-flash-0731/i]);

/** Models still measured as needing it off. See the note above for each. */
export const REASONING_OFF_MODELS = Object.freeze([/qwen3\.7/i, /deepseek-v4-pro/i]);

export function reasoningField(model, env = process.env) {
  const raw = String(env?.ACUVO_REASONING ?? '').trim().toLowerCase();
  if (raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes') return { reasoning: { enabled: true } };
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return { reasoning: { enabled: false } };

  const id = String(model ?? '');
  /**
   * ⚠️ OFF IS CHECKED FIRST. If an id ever matches both lists that is a mistake
   * in the tables, and the safe reading of a mistake is the old behaviour.
   */
  if (REASONING_OFF_MODELS.some((re) => re.test(id))) return { reasoning: { enabled: false } };
  if (REASONING_ON_MODELS.some((re) => re.test(id))) return { reasoning: { enabled: true } };
  /**
   * ⚠️ EVERY OTHER MODEL KEEPS THE FIELD ABSENT, exactly as before. A model we
   * have not measured gets the vendor's own default, not our guess about it.
   */
  return {};
}

export function resolveApiUrl(env = process.env) {
  /**
   * ── ⭐⭐ AN ACUVO ACCOUNT ROUTES THROUGH OUR GATEWAY, AND ONLY AN ACCOUNT ──
   *
   * This is the line that makes "buy Acuvo credits, never see a provider key"
   * true rather than aspirational, and it is deliberately HERE rather than in
   * `callModel`'s signature: every caller — the chain, the refuter, the
   * subagent, best-of, the vision leg — reaches the provider through this one
   * function, so putting it here means there is no call site that can be
   * forgotten. That is the defect class this package loses to most often.
   *
   * ⚠️ THE ORDER MATTERS AND IT IS NOT ALPHABETICAL. The account is consulted
   * BEFORE `ACUVO_API_URL`, because `ACUVO_API_URL` is a loopback-only TEST
   * SEAM whose whole justification is that it cannot send a credential off this
   * machine. Letting it override a signed-in account would let anything that
   * can set an environment variable redirect an authenticated session — the
   * exact primitive that restriction exists to deny.
   *
   * ⚠️ AND BYOK IS NEVER ROUTED HERE. `resolveCredential` returns a null URL
   * for a provider key, so a key the user brought is posted to the provider and
   * to nobody else. A user's own credential arriving at our servers would be a
   * betrayal of the plainest kind, and it is prevented by construction rather
   * than by remembering.
   */
  const credential = resolveCredential(env);
  if (credential.mode === 'account' && credential.url) return credential.url;

  const raw = String(env?.ACUVO_API_URL ?? '').trim();
  if (!raw) return OPENROUTER_URL;

  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`ACUVO_API_URL is not a URL: ${JSON.stringify(raw)}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^127\./.test(host);
  if (!loopback) {
    throw new Error(
      `ACUVO_API_URL may only point at loopback (localhost / 127.0.0.1 / ::1); refusing ${u.hostname}. `
      + 'This override exists so tests can drive the CLI against a local stub — it is not a way to route your '
      + 'API key through another host.',
    );
  }
  return u.toString();
}
/** One round-trip, generous: a coder model writing several whole files is slow,
 *  and a premature abort looks exactly like a hang to the person waiting. */
export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * ── ⭐⭐⭐ A LIVE STREAM IS BOUNDED BY SILENCE, NOT BY LENGTH (2026-09-27) ──────
 *
 * FOUND BY USING IT, with a fetch tracer on a real run ("build me a Breakout
 * clone"). The round that writes the 9 KB game file was aborted with
 * *"No response from OpenRouter within 180s"* — and the trace says it was
 * RESPONDING THE WHOLE TIME: headers at 2.4s, then **2,104 data frames** with no
 * gap over 10s, cut off mid-sentence at 180.0s by `AbortSignal.timeout`, which
 * covers the BODY as well as the headers. The retry was cut the same way, and
 * the chain fell to `deepseek-chat` (older model, cold cache) — 6 of the first
 * 15 minutes of that run were two healthy streams being killed. The previous
 * run of the same brief spent 9 of its 15 minutes the same way and never
 * finished.
 *
 * ⭐ So once headers arrive and the body is an event stream, the clock that
 * matters is TIME SINCE THE LAST DATA FRAME:
 *   · `STREAM_IDLE_MS` with no `data:` frame → abort (retryable, kind `timeout`).
 *     ⚠️ OpenRouter's `: OPENROUTER PROCESSING` keep-alive comments do NOT
 *     reset it — they keep arriving while an upstream is stalled, so counting
 *     them would make a dead stream immortal.
 *   · `STREAM_CAP_MS` total → abort, so nothing runs for ever.
 *   · before headers, and for a whole-JSON reply, `timeoutMs` exactly as before.
 * The message says which one fired, because "no response" about a stream that
 * sent 2,104 frames sends the reader looking for an outage that did not happen.
 * Guard: `test/stream-watchdog.test.mjs`.
 */
export const STREAM_IDLE_MS = 90_000;
export const STREAM_CAP_MS = 600_000;
/**
 * ⚠️⚠️ AND THE OLD 180s WAS SECRETLY A THINKING BUDGET — so it is kept, as one.
 * The four killed streams in that trace (1,265–2,104 frames each) were followed
 * every time by a retry with reasoning OFF that answered in seconds (41 frames
 * for the same plan). `reasoningField` already records why: flash-0731 with
 * thinking on is BIMODAL — some write rounds spend 5,000–6,500 reasoning
 * tokens and then write nothing. Removing the 180s cut without replacing it
 * would let that stall run to the 600s cap. So: a stream that has sent no
 * CONTENT and no TOOL CALL (reasoning deltas only) by `STREAM_THINK_MS` is
 * aborted as `timeout`, which the chain already answers by retrying with
 * reasoning off — the same escape, reached in half the time. OpenRouter's own
 * `reasoning.max_tokens` budget would be the integration answer, but its docs
 * list it only for Gemini, Anthropic and some Qwen models, not DeepSeek
 * (openrouter.ai/docs/use-cases/reasoning-tokens, read 2026-09-27).
 * Once content or a tool call is flowing, only silence or the cap stop it.
 */
export const STREAM_THINK_MS = 90_000;

function timeoutError(message) {
  const err = new Error(message);
  err.name = 'TimeoutError';
  return err;
}

export function streamWatchdog({ timeoutMs = DEFAULT_TIMEOUT_MS, idleMs = STREAM_IDLE_MS, capMs = STREAM_CAP_MS, thinkMs = STREAM_THINK_MS } = {}) {
  const ac = new AbortController();
  let why = null;
  const timers = new Set();
  const arm = (ms, reason, message) => {
    const t = setTimeout(() => { why = reason; ac.abort(timeoutError(message)); }, ms);
    t.unref?.();
    timers.add(t);
    return t;
  };
  const clearAll = () => { for (const t of timers) clearTimeout(t); timers.clear(); };
  arm(timeoutMs, 'headers', 'no response');
  let idle = null;
  const secs = (ms) => Math.round(ms / 1000);
  return {
    signal: ac.signal,
    /** Switch to stream mode and pass the body through, resetting on data frames only. */
    watch(body) {
      clearAll();
      arm(Math.max(capMs, timeoutMs), 'cap', 'stream cap');
      // A body that is not a web stream (an injected async iterable) cannot be
      // watched for silence; it keeps the cap and passes through untouched.
      if (typeof body?.pipeThrough !== 'function') return body;
      idle = arm(idleMs, 'idle', 'stream idle');
      let thinking = arm(thinkMs, 'thinking', 'thinking budget');
      const decoder = new TextDecoder();
      let partial = '';
      return body.pipeThrough(new TransformStream({
        transform(chunk, ctl) {
          // Whole lines only: a `data:` line split across two chunks is judged once,
          // when its last byte arrives.
          const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n');
          partial = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue; // keep-alive comments never count
            clearTimeout(idle);
            timers.delete(idle);
            idle = arm(idleMs, 'idle', 'stream idle');
            if (thinking && (line.includes('"tool_calls"') || /"content":"[^"]/.test(line))) {
              clearTimeout(thinking);
              timers.delete(thinking);
              thinking = null;
            }
          }
          ctl.enqueue(chunk);
        },
      }));
    },
    stop: clearAll,
    describe(err) {
      if (why === 'idle') {
        return `The model stream went silent for ${secs(idleMs)}s (no tokens, only keep-alives) — the call was aborted rather than left hanging.`;
      }
      if (why === 'thinking') {
        return `The model was still only thinking after ${secs(thinkMs)}s (no content, no tool call yet) — aborted so it can be retried without reasoning.`;
      }
      if (why === 'cap') {
        return `The model was still streaming after ${secs(Math.max(capMs, timeoutMs))}s — the call was aborted at the hard cap.`;
      }
      return describeTransportError(err, timeoutMs);
    },
  };
}
/**
 * ── ⭐ RAISED 8,000 → 12,000 (2026-08-10), AND EVERY DIGIT IS MEASURED ───────
 *
 * ⚠️ THE OLD CEILING DID NOT PRODUCE A SHORT FILE — IT PRODUCED NO FILE. Asked
 * for one large module at `max_tokens: 8000`, the completion was cut off INSIDE
 * the `write_file` tool-call JSON and the run died on
 * `tool arguments were not valid JSON: Unterminated string at position 27784`.
 * Zero bytes written, a whole round billed, nothing to show for it. Note this is
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
 * is FREE on ordinary work — verified: two real fix-and-verify runs spent
 * 11,746 and 16,258 tokens across 3-4 rounds TOTAL (prompt included) and never
 * came near 8,000 in a single completion. The only spend that changes is the
 * pathological one, where the worst case per round scales with the ceiling —
 * 8,000 → 12,000 output tokens is +50% on a round that fills it.
 *
 * ⚠️ AND THAT COST IS REAL, WHICH IS THE ARGUMENT AGAINST GOING HIGHER. The 16k
 * probe above ALSO truncated — an unbounded request fills whatever ceiling you
 * give it, so raising this does not "fix" such a task, it just doubles the bill
 * for the same nothing (measured: 8k → 16k roughly doubled the spend and
 * produced zero bytes both times). Raise to cover real files; do not raise to
 * chase a request no ceiling satisfies.
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
/**
 * ── ⭐⭐ AN ACUVO ACCOUNT COMES FIRST; A PROVIDER KEY STILL WORKS ────────────
 *
 * Acuvo Code is meant to work the way Claude Code does — you buy Acuvo credits
 * and never see a provider key. This function used to read
 * `OPENROUTER_API_KEY` out of the user's environment and nothing else, which is
 * BYOK and was never the plan.
 *
 * ⚠️ BYOK IS KEPT, DELIBERATELY. Everyone using this today has that variable
 * set; breaking them the day the gateway ships would be the worst possible
 * introduction to it. So: an account is PREFERRED, a provider key still WORKS,
 * and `mode` says which — because those are two different people's money and
 * confusing them is unforgivable.
 *
 * ⭐ `gatewayUrl` IS NULL FOR BYOK, AND THAT IS THE SECURITY LINE. A provider
 * key must never be posted anywhere except the provider. Only an ACUVO token —
 * ours, scoped to one account, revocable by us — is ever sent to our gateway.
 *
 * ⚠️ With only `OPENROUTER_API_KEY` set, every field below is what it was
 * before this change, so an existing setup is byte-identical.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ apiKey: string, model: string, configured: boolean,
 *             mode: 'account' | 'byok' | 'unconfigured', gatewayUrl: string | null,
 *             email: string | null }}
 */
export function readModelConfig(env = process.env) {
  const credential = resolveCredential(env);
  const model = (env.OPENROUTER_CODEGEN_MODEL || '').trim() || DEFAULT_MODEL;
  return {
    apiKey: credential.token,
    model,
    configured: credential.token.length > 0,
    mode: credential.mode,
    gatewayUrl: credential.url,
    email: credential.email,
  };
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
/**
 * ── ⚠️⚠️ IT OPENED BY ASKING FOR SOMEBODY ELSE'S PRODUCT ────────────────────
 *
 * The previous first line was "Acuvo Code needs an OpenRouter key to reach a
 * model." A stranger's entire first impression was a demand for a competitor's
 * credential, before a single word about what this thing is or why they should
 * bother. A dogfood review put it plainly: the storefront sells someone else.
 *
 * ⭐ SO IT LEADS WITH THE ONE SENTENCE THAT IS ACTUALLY DIFFERENT. Every coding
 * agent writes files. This is the only one that quotes the price first and stops
 * at the number you gave it, and that is the fact worth spending line one on.
 *
 * ⭐ AND THE COST IS THE HOOK, NOT A FOOTNOTE. "Is this going to charge me" is
 * the real unspoken question, and our honest answer happens to be excellent —
 * so it is stated in dollars, with the default ceiling, which turns "how much
 * might this cost me" into "two cents, worst case, and I chose it".
 *
 * ⚠️ IT DOES NOT PROMISE A PLAN. Acuvo Code is intended to be unlocked by an
 * Acuvo plan, and that gateway does not exist yet. Writing marketing for a
 * product that does not ship is how a first impression becomes a broken
 * promise — so this describes exactly what is true today and nothing more.
 * When the gateway ships, this message changes with it.
 *
 * ⚠️ `--doctor` IS NAMED, because it is the best thing we have for someone who
 * is stuck: it needs no key, runs offline, and every line it prints names the
 * variable that fixes it.
 */
/**
 * ── ⭐⭐⭐ THE GATEWAY SHIPPED, SO THIS MESSAGE CHANGED WITH IT (2026-08-22) ──
 *
 * The note above promised exactly that: *"When the gateway ships, this message
 * changes with it."* It shipped — `acuvo --login` lands an Acuvo key, and the
 * metered path recorded its first real usage row today after never once having
 * worked.
 *
 * ⚠️⚠️ AND UNTIL THIS EDIT THE FRONT DOOR SOLD THE COMPETITION. The first thing
 * a brand-new user saw was "create your own OpenRouter key" — BYOK, which Roman
 * has ruled out twice, printed as step 1 of onboarding on a package anyone can
 * now `npm i -g`. `--help` did list `--login`; the message people actually hit
 * did not. Every stranger who installed this brought their own key, so we
 * metered nothing and earned nothing.
 *
 * ⭐ BOTH PATHS STAY, ORDER REVERSED. BYOK is not removed — it is honest, it
 * works, and hiding it would make the tool look locked. It is simply no longer
 * the default answer to "how do I start".
 *
 * ⚠️ IT STILL PROMISES NOTHING THAT DOES NOT EXIST. No pricing, no "sign up
 * free", no plan names — self-serve signup has never been walked end to end
 * (every tenant today is operated · unmetered). It names the two commands that
 * are real and stops there.
 */
export const MISSING_KEY_MESSAGE = [
  'Acuvo Code — a terminal coding agent that tells you the price before it runs,',
  'stops at the number you set, and can re-check every claim it ever made.',
  '',
  'It needs a key. Two ways — then run the same command again:',
  '',
  /**
   * ── ⚠️⚠️⭐ OUR DOOR HAD NO ADDRESS AND THE COMPETITOR'S DID ────────────────
   *
   * These two lines read *"acuvo --login (paste the key from Settings → API
   * keys)"* while option B, eight lines down, carried a full
   * `https://openrouter.ai/keys`. So the FIRST screen a stranger ever sees told
   * them exactly where to buy someone else's key and left ours as an unlocated
   * "Settings" — and `doctor.mjs` already records what that costs: *"sent a
   * customer who had already paid us off to buy a competitor's key."*
   *
   * ⚠️⚠️ AND THE GUARD ENFORCED THE ASYMMETRY. `first-impression.test.mjs`
   * asserts `/https:\/\/openrouter\.ai\/keys/` with the reason *"WHERE to get a
   * key"* — and had no equivalent assertion for the Acuvo path. The test was
   * requiring an address for their door and not for ours.
   *
   * ⭐ THE PARENTHETICAL WAS ALSO WRONG ABOUT OUR OWN PRODUCT. On a terminal
   * `--login` takes no argument and asks for no paste: it runs the RFC 8628
   * device flow (`device-login.mjs`, verified answering 200 on 2026-09-18),
   * whose own header names *"sign in → find Settings → create key → copy"* as
   * the five-step path it exists to replace. We were advertising the path we
   * had already replaced, in the one place it costs a first impression.
   */
  '  A) Your Acuvo account, billed to your Acuvo credits — https://acuvo.xxiautomate.com',
  '       acuvo --login        (opens your browser to approve this terminal)',
  '',
  /**
   * ⚠️⚠️ THE OPT-IN IS PART OF THE INSTRUCTION, NOT A FOOTNOTE. As of
   * 2026-08-23 a bare `OPENROUTER_API_KEY` is no longer picked up on its own —
   * a stray key in a shell profile used to silently take over billing, which
   * on Roman's own machine meant every run he had ever made was charged to his
   * personal balance and never metered. Printing the old two lines here would
   * hand somebody a recipe that quietly does nothing.
   */
  '  B) Your own key, billed to YOU, not your Acuvo plan — https://openrouter.ai/keys',
  '       export OPENROUTER_API_KEY=sk-or-v1-...        (bash / zsh)',
  '       $env:OPENROUTER_API_KEY = "sk-or-v1-..."      (PowerShell)',
  '       add ACUVO_BYOK=1 to silence the reminder that this is not your plan',
  '',
  `A typical task costs $0.001-$0.003. The ceiling is $${DEFAULT_BUDGET_USD} a run unless you`,
  'raise it, so a mistake is cheap to find.',
  '',
  /**
   * ⚠️ THE REMEDY MUST RUN ON THE PLATFORM IT IS PRINTED ON. This line was
   * `node --env-file=.env "$(which acuvo)" "<prompt>"` for everybody — and
   * `$(which acuvo)` is bash. A Windows user, who is exactly the person most
   * likely to be reading a "no key" message, pastes it into PowerShell and gets
   * a second error on top of the first. ⭐ A remedy that fails is worse than no
   * remedy: it converts "I need to set a key" into "this tool is broken".
   *
   * ⭐ And the simple form is offered first, because `acuvo` loads a `.env`
   * beside the project on its own — the explicit invocation is only needed when
   * the file lives somewhere else.
   */
  'Keep keys in a file?     put OPENROUTER_API_KEY=... in a .env beside your project',
  '                         (acuvo loads it automatically — no extra flags)',
  'Want to check the setup?  acuvo --doctor       (no key needed, works offline)',
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
 * 402 is what an exhausted balance returns, and it is one of the likeliest
 * failures a key ever hits — an authenticating key with nothing left on it.
 *
 * ⚠️ THE THIRD ARGUMENT IS OPTIONAL AND EVERY EXISTING CALLER STAYS CORRECT.
 * `pin` is the provider preference that was SENT with the failed request, and it
 * exists because of a measured misdiagnosis: an `ACUVO_PROVIDER_ORDER` naming a
 * provider this key cannot reach returns HTTP 404, and the 404 branch below told
 * the reader to check `OPENROUTER_CODEGEN_MODEL` against the model catalogue.
 * The model was fine.
 * Every word of the advice pointed away from the one variable that caused it —
 * and because the message matches `isModelSpecific`, `chain.mjs` then spent all
 * four attempts re-sending the SAME bad pin against four different model ids.
 */
export function classifyHttpFailure(status, bodyText, { pin = null } = {}) {
  /**
   * Rendered once, used only by the branches where a pin can plausibly be the
   * cause. An empty or absent pin adds nothing, so an unpinned run's messages
   * are byte-identical to what they were before this argument existed.
   */
  const pinClause = Array.isArray(pin) && pin.length > 0
    ? `\n\n⚠️ ACUVO_PROVIDER_ORDER=${pin.join(',')} was sent with this request. A provider that does not `
      + 'serve this model — or one excluded by your OpenRouter data policy — makes the request a 404 even '
      + 'though the model id is fine. Unset it to rule the pin out before you change the model.'
    : '';
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
    return `OpenRouter does not serve that model (HTTP 404). Check OPENROUTER_CODEGEN_MODEL against https://openrouter.ai/models.\n  ${detail}${pinClause}`;
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
/**
 * ── ⭐⭐ THE KIND, SO RETRYABILITY STOPS DEPENDING ON A SENTENCE ─────────────
 *
 * The header above says the phrase 'Could not reach OpenRouter' is an API
 * because `chain.mjs` matches error TEXT. That warning was right and it was
 * also incomplete: the TIMEOUT branch never matched anything `isRetryable`
 * looked for. Measured 2026-08-12:
 *
 *   isRetryable(describeTransportError({name:'TimeoutError'}, 180000)) === false
 *
 * So the four-model chain never fired on a timeout — the commonest failure of a
 * LONG job, with three healthy fallbacks sitting right there. Long tasks failed
 * more, by design, which is exactly backwards. And the suite stayed green
 * because its test asserted `isRetryable('timed out')`, a literal this function
 * has never produced.
 *
 * ⭐ A WIDER REGEX WOULD ONLY MOVE THE NEXT DRIFT. The classifier should not be
 * reading English at all. This returns the fact; `isRetryable` switches on it,
 * and the sentence becomes free to reword.
 *
 * @param {any} err
 * @returns {'timeout' | 'network' | null}
 */
export function transportErrorKind(err) {
  const name = err?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const code = err?.cause?.code || err?.code || '';
  if (code && TRANSPORT_CAUSES[code]) return 'network';
  // ⚠️ An uncatalogued code is still a transport fault — that is what a `cause`
  // code MEANS. Treating only known codes as network is how ECONNRESET's
  // less-famous siblings quietly stopped failing over.
  if (code) return 'network';
  return null;
}

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
 * ── ⭐ THE ERROR THAT RODE IN ON A 200 ──────────────────────────────────────
 *
 * Pull the upstream provider's own sentence out of a body that carries an
 * `error` instead of a `choice`, and prefix it with a phrase the chain's
 * classifier is taught to recognise.
 *
 * ⚠️ THE PREFIX IS LOAD-BEARING, NOT DECORATION. `chain.mjs` decides
 * retryability by matching text, so the wording here IS the wiring — the same
 * arrangement, and the same fragility, as the `empty reply` message. It is
 * pinned from both sides by `test/upstream-200-error.test.mjs`.
 *
 * ⚠️ RETURNS `null`, NOT A SENTENCE, WHEN THERE IS NO MESSAGE. An `error` key
 * holding `{}` or `''` carries no information, and manufacturing "upstream
 * provider error — " out of it would make an unexplained 200 retryable on the
 * strength of an empty object. The caller falls back to the old wording, which
 * is the honest description of a body with nothing in it.
 *
 * @param {any} body
 * @returns {string | null}
 */
export function upstreamErrorMessage(body) {
  const err = body?.error;
  if (!err) return null;
  const raw = typeof err === 'string' ? err : (typeof err?.message === 'string' ? err.message : '');
  const message = raw.trim();
  if (!message) return null;
  return `upstream provider error — ${message}`;
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
  if (!choice) {
    /**
     * ── 🚨⭐⭐ THE THIRD SHAPE OF "A 200 THAT IS A FAILURE", AND THE ONE THAT
     *    THREW THE REASON AWAY (measured 2026-09-18) ──────────────────────────
     *
     * OpenRouter answers **HTTP 200 with an `error` object and no `choices`**
     * when the upstream provider refuses mid-flight. Measured against the real
     * API by `scripts/zz-what-can-the-fallback-actually-take.mjs`:
     *
     *     HTTP 200
     *     {"error":{"message":"Upstream error from DeepInfra: The sum of prompt
     *      length (90948.0), query length (0) should not exceed
     *      max_num_tokens (32768)","code":400}}
     *
     * ⚠️ TWO THINGS WENT WRONG HERE AND BOTH WERE INVISIBLE.
     *
     * 1. **The reason was discarded.** This line replaced a sentence naming the
     *    provider, the size sent and the size allowed with *"the model returned
     *    no choices"* — a string that tells a user nothing and a maintainer
     *    less. Nothing in the package matched on it; it had no test.
     * 2. **It stopped the chain.** `chain.mjs`'s `isRetryable` classifies by
     *    TEXT, and "returned no choices" matches none of its rules, so a
     *    capacity refusal from ONE endpoint ended the session with two healthy
     *    fallback models untried — on a fallback leg, i.e. on the run where the
     *    primary was already down.
     *
     * ⭐ THAT IS THE EXACT DEFECT THE `empty reply` BLOCK BELOW WAS WRITTEN FOR,
     * arriving in a third costume. The comment there says the classifier "has
     * three healthy fallback models it could never reach"; this shape had the
     * same hole and the same cause — an error string nobody taught the chain to
     * read. `test/upstream-200-error.test.mjs` now pins that these two agree, so
     * rewording this fails a test instead of silently re-opening it.
     */
    const upstream = upstreamErrorMessage(body);
    if (upstream) {
      return {
        ok: false,
        error: upstream,
        // ⚠️ Same forwarding as the empty-200 below. A refusal is usually not
        // billed, but "usually" is not a reason to drop the one object that
        // would prove it either way.
        usage: body?.usage ?? null,
        provider: typeof body?.provider === 'string' && body.provider ? body.provider : null,
      };
    }
    return { ok: false, error: 'the model returned no choices — nothing to act on' };
  }
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
      /**
       * ── 💰⭐⭐⭐ THE HEADER ABOVE SAYS "THE TOKENS WERE BILLED" AND WE THREW
       *    THE BILL AWAY ──────────────────────────────────────────────────────
       *
       * ⚠️ Read the paragraph two comments up: *"The call happened, the tokens
       * were billed, and there is nothing to act on."* True — and this return
       * then dropped `body.usage`, the object holding `prompt_tokens`,
       * `completion_tokens` and `prompt_tokens_details.cached_tokens` for that
       * exact billed call. The file DOCUMENTED the cost and discarded the
       * measurement of it in the same six lines.
       *
       * ⚠️ AND THE SUITE PROVED NOBODY LOOKED: `test/transport-empty-reply.test.mjs`
       * ends with a case named *"usage and finishReason survive on the success
       * path"*. The success path was the only one anybody checked.
       *
       * ⭐ SAME KEYS AS THE SUCCESS RETURN BELOW, SO NOTHING DOWNSTREAM BRANCHES
       * ON `ok`. `budget.record`, `readCacheUsage` and `unitsFromUsage` all take
       * the raw provider object; handing them a differently-shaped failure would
       * just move the hole.
       */
      usage: body?.usage ?? null,
      provider: typeof body?.provider === 'string' && body.provider ? body.provider : null,
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
    /**
     * ⭐ THE UPSTREAM THAT ACTUALLY SERVED IT. OpenRouter puts the serving
     * provider's name on the response body next to `model`, and this function
     * discarded every top-level field it did not name — so the one fact that
     * distinguishes "our prefix regressed" from "we were routed to a cold
     * instance" arrived on every call and was thrown away. Absent stays null:
     * a provider that does not report it is unknown, not "unpinned".
     */
    provider: typeof body?.provider === 'string' && body.provider ? body.provider : null,
    /**
     * ── ⭐ THE MODEL ID THE PROVIDER SAYS IT SERVED ─────────────────────────
     *
     * ⚠️ NOT THE SAME FACT AS `model` ON THE RETURN BELOW, which is the id we
     * ASKED FOR. The comment two above says this function *"discarded every
     * top-level field it did not name"* and then named `provider` and not
     * `model` — so the response carried the served id on every call and the one
     * consumer that could have checked it never had it.
     *
     * ⚠️⚠️ AND IT IS CAPTURED, NOT ACTED ON, DELIBERATELY. Across 16 sampled
     * live calls on 2026-09-02 the served id matched the requested id EVERY
     * time. Building a warning for a disagreement nobody has observed would be
     * a guard with no evidence behind it — this repo's own rule is that a check
     * which fires on correct work is worse than no check. It is reported so the
     * next person arguing about a silent variant swap has the measurement
     * instead of the argument.
     */
    servedModel: typeof body?.model === 'string' && body.model ? body.model : null,
  };
}

/**
 * ── ⭐⭐ DID THE PIN TAKE? ────────────────────────────────────────────────────
 *
 * ⚠️ THE DEFECT THIS ANSWERS, MEASURED 2026-08-14: an unreachable provider name
 * returns HTTP 404 "No endpoints found" when it is sent alone — and with
 * `allow_fallbacks: true` (which stays true, see the payload) OpenRouter does not
 * error on an `order` list it cannot honour. It treats it as an empty preference
 * and routes at random. So a pin has THREE outcomes, not two: honoured, rejected
 * loudly, and **accepted, ignored, billed** — and the third was indistinguishable
 * from the first at every layer of this CLI. The measured cost of not knowing:
 * 46.7% hit rate instead of 95.8%, i.e. roughly 2.4× the bill, with no symptom.
 *
 * ⚠️ THE COMPARISON IS CASE-INSENSITIVE ON PURPOSE. The catalogue capitalises
 * provider names; people type them in lower case. A pin that "did not take"
 * because of a capital letter would be a false alarm, and one false alarm is all
 * it takes for the real one to be ignored.
 *
 * ── ⚠️⚠️ A LIST IS NOT ONE CACHE, AND "took" USED TO PRETEND IT WAS ─────────
 *
 * This function used to answer `took` for ANY name in the list, on the reasoning
 * that a preference list is honoured if any of its names served the round. That
 * is the right test for AVAILABILITY and the wrong one for the thing the pin
 * exists to buy. **A prompt cache lives on ONE upstream instance.** Landing on
 * the second name in the list is a live provider and a stone-cold cache, and it
 * was scored identically to landing on the first.
 *
 * ⭐ MEASURED 2026-08-16, replaying ONE byte-identical 46,171-byte payload
 * against a three-name preference list:
 *
 *     served by the FIRST name    11,520 of 11,714 cached  98.3%
 *     served by the SECOND name         0 of 11,714 cached   0.0%
 *
 * **4.6× on one round, for the same bytes**, and every layer of this CLI called
 * it `pinTook: 1, pinMissed: 0` — a healthy reading. Over 40 pinned calls the
 * scatter was roughly 19:1 in the first name's favour, so this is a ~5% event
 * that nothing could see and nothing could name.
 *
 * ⚠️ THE FALLBACK IS STILL NOT THE BUG. `allow_fallbacks` stays true — "never
 * single", and a cheaper request that does not happen is not cheaper. What
 * changes here is only that a fallback stops being invisible, which is the same
 * argument that put `missed` here in the first place.
 *
 * @param {{ pin?: string[] | null, served?: string | null }} x
 * @returns {'none' | 'unknown' | 'took' | 'fell-back' | 'missed'}
 *   `none` — nothing was pinned. `unknown` — pinned, but the provider never said
 *   who served it, so we refuse to guess either way. `took` — the FIRST name
 *   served it, which is the only outcome that reuses the cache we have been
 *   accumulating. `fell-back` — a later name in the list served it: available,
 *   billed, and cold. `missed` — nobody in the list served it.
 */
export function pinOutcome({ pin = null, served = null } = {}) {
  if (!Array.isArray(pin) || pin.length === 0) return 'none';
  if (typeof served !== 'string' || !served) return 'unknown';
  const want = pin.map((p) => String(p).trim().toLowerCase());
  const got = served.trim().toLowerCase();
  if (want[0] === got) return 'took';
  return want.includes(got) ? 'fell-back' : 'missed';
}

/**
 * ── ⭐⭐⭐ THE PIN MOVED TO `provider-pin.mjs`. IT IS NOT DUPLICATED HERE ────
 *
 * `PROVIDER_PIN_BY_MODEL`, `DEFAULT_PROVIDER_ORDER` and every paragraph of
 * measurement behind them now live in `lib/provider-pin.mjs`, because the same
 * table was hand-typed in four files and three of them went stale. The whole
 * post-mortem is that file's header.
 *
 * ⚠️ IMPORTED AND RE-EXPORTED, NOT RE-EXPORTED DIRECTLY. `export { X } from
 * './m'` creates NO LOCAL BINDING, and this file READS both of these several
 * hundred lines below (`PROVIDER_LANES.legacy`, `providerOrderFor`). A bare
 * re-export would compile, ship, and throw a `ReferenceError` at the first call
 * — the exact defect `feedback_export_from_is_not_an_import` records, which
 * 500'd the builder while 48 tests stayed green.
 */
export { PROVIDER_PIN_BY_MODEL, DEFAULT_PROVIDER_ORDER, REFUSED_PROVIDERS, costOrderedFallback };

/**
 * ══════════════════════════════════════════════════════════════════════════
 * ── ⭐⭐⭐ THE SUPPLY LADDER — ONE PIN WAS ONLY RIGHT FOR ONE PLAN ──────────
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Re-read against the live per-model endpoint board on 2026-08-26 (29
 * endpoints; free metadata, no inference call), the pin above is the **dearest
 * viable endpoint on the board** and the **only discounted one**. Its
 * cache-miss input went `0.2024 -> 0.2470` overnight — a 22.0% rise nothing
 * reported — because its published discount narrowed from 54.0% to 43.9%.
 * Strip that discount entirely and it prices at the model vendor's list
 * exactly: it is a list-priced mirror running a sale.
 *
 * ⭐ THE BOARD CARRIES A `quantization` FIELD, so precision can be sold rather
 * than averaged away. Cheapest healthy fp4 supply is ~8x cheaper than the
 * current pin on cache misses; full-precision fp8 is ~3x cheaper.
 *
 *   economy    fp4, 2 names, no discount anywhere   lead 0.030/M in
 *   precision  fp8, 3 names, no discount anywhere   lead 0.080/M in
 *   resident   the enterprise SEAM — see below
 *   legacy     today's pin, kept because it is what we still ask for
 *
 * ⚠️⚠️ NO LANE MEMBER CARRIES A PROMOTION EXCEPT THE LEGACY ONE. That is the
 * selection criterion, not a coincidence: a margin that only holds while
 * somebody else runs a sale is not a margin, and we just watched one narrow.
 *
 * ⚠️ RANK ON EVERY COLUMN, NOT ON INPUT. Two mid-table fp8 endpoints price
 * cache READS at 0.0700/M — 2.5x this lane's envelope on the one token type
 * the whole cache strategy exists to maximise — while looking competitive on
 * input. Both are excluded.
 *
 * ⚠️ RESIDENT IS A SEAM, NOT A TIER. Enterprise is meant to buy Western-hosted
 * supply, and **the board publishes no region, jurisdiction or operator
 * country** — only price, quantization, context, uptime and discount. Deriving
 * residency from a provider's name would be an assumption wearing a
 * measurement's clothes, so `resident` is the precision lane's names at the
 * precision lane's price, and the residency claim stays unmade until a
 * procurement source (contract / DPA / published region list) backs it.
 *
 * ⚠️⚠️⚠️ THE DEFAULT IS DELIBERATELY STILL `legacy`, AND THAT IS NOT TIMIDITY.
 * Flipping it is a COORDINATED change, because this package welds the pin name
 * into its cost table and its routing tests on purpose:
 *
 *   lib/plan.mjs                MODEL_PRICES[flash].provider
 *   test/provider-pin-per-model.test.mjs   asserts pin[0] === that provider
 *   test/defaults-pin-and-tiers.test.mjs   asserts only[0] === DEFAULT_PROVIDER_ORDER
 *   test/cache-prefix-stability.test.mjs   asserts the exact warm-lock name
 *   test/direct-deepseek.test.mjs          asserts it twice
 *   console/lib/rate-card.ts    FLASH_RATE, and the four copies pinned to it
 *
 * ⭐ That weld is the guard that stopped "the price we quote is not the
 * endpoint we ask for" — the defect that made pro look 11.2x flash when it was
 * really the routing. Breaking it quietly to move a default would be trading a
 * working guard for a saving. The lane is therefore REACHABLE TODAY via
 * `ACUVO_SUPPLY_LANE`, and the default flips in the change that moves
 * `MODEL_PRICES` and the card together.
 */
export const SUPPLY_LANE_IDS = Object.freeze(['economy', 'precision', 'resident', 'legacy']);

/** The rung -> lane ladder. Mirrors `console/lib/rate-card.ts` `LANE_BY_RUNG`. */
export const LANE_BY_PLAN = Object.freeze({
  free: 'economy',
  starter: 'economy',
  growth: 'precision',
  scale: 'precision',
  enterprise: 'resident',
});

/**
 * ⚠️ ONLY FLASH HAS LANES, AND THAT IS A MEASUREMENT. Pro's board is 8
 * endpoints with no cheap fp4 tier, qwen's is one endpoint, and glm's is two —
 * inventing lanes for them would be four tiers of nothing. A model with no
 * lane table falls through to `PROVIDER_PIN_BY_MODEL`, which is the honest
 * answer rather than a fabricated ladder.
 *
 * ⚠️ EVERY LANE IS >= 2 NAMES. "Never single" is this package's standing rule
 * and a single name plus `allow_fallbacks` degrades to *anything* — and
 * *anything* on this board is 0.44/M, i.e. the vendor list.
 */
export const PROVIDER_LANES = Object.freeze({
  'deepseek/deepseek-v4-flash-0731': Object.freeze({
    // fp4. lead 0.030/0.0070/0.0750 @99.99% up; second 0.060/0.0120/0.1200 @98.46%.
    // ⚠️ A third cheap fp4 name exists at 0.080 and is EXCLUDED: 63% uptime, negative status.
    economy: Object.freeze(['OpenInference', 'Relace']),
    // fp8. lead 0.080/0.0160/0.1800 @99.18%; then 0.130 @100.00%; then 0.140 @99.99%.
    precision: Object.freeze(['DeepInfra', 'BaseTen', 'SiliconFlow']),
    // ⚠️ SEAM ONLY — residency UNVERIFIED. Same supply as `precision` until a
    // procurement source says otherwise; never quoted as a residency guarantee.
    resident: Object.freeze(['DeepInfra', 'BaseTen']),
    /**
     * ⚠️ DERIVED, NOT RETYPED. Today's pin, so the default keeps behaving byte
     * for byte — and a second copy of a provider list is precisely how the pin
     * table and the price table drifted apart last time.
     */
    legacy: PROVIDER_PIN_BY_MODEL['deepseek/deepseek-v4-flash-0731'],
  }),
});

/** ⚠️ Until `MODEL_PRICES` and the rate card move with it, this stays `legacy`. */
export const DEFAULT_SUPPLY_LANE = 'legacy';

/**
 * Which lane this process is on.
 *
 * ⚠️ `ACUVO_SUPPLY_LANE` WINS OVER `ACUVO_PLAN`, because an operator naming a
 * lane is stating an intent and a plan id is only implying one. An
 * unrecognised value in either falls back to the default rather than throwing
 * — a routing hint may never be the reason a run does not happen.
 */
export function supplyLaneFrom(env = process.env) {
  const explicit = String(env?.ACUVO_SUPPLY_LANE ?? '').trim().toLowerCase();
  if (SUPPLY_LANE_IDS.includes(explicit)) return { lane: explicit, source: 'env' };
  const plan = String(env?.ACUVO_PLAN ?? '').trim().toLowerCase();
  const byPlan = LANE_BY_PLAN[plan];
  if (byPlan) return { lane: byPlan, source: 'plan' };
  return { lane: DEFAULT_SUPPLY_LANE, source: 'default' };
}

/**
 * ── ⭐⭐⭐ EVERY NAME WE MIGHT DELIBERATELY LAND ON, PER MODEL ───────────────
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE OF A TRAP THAT WOULD HAVE SILENTLY UNDONE THE WHOLE
 * LADDER. `warm-provider.mjs` refuses to learn a provider that is "not in the
 * configured pin" — a guard written after a stray upstream locked itself in
 * with `allow_fallbacks:false` and charged a multiple on cache reads. That
 * guard reads `PROVIDER_PIN_BY_MODEL`. The moment a session runs on the
 * ECONOMY lane, the endpoint that legitimately serves it is not in that table,
 * so warmth would be **refused every round** — and the symptom is not an
 * error, it is a permanently cold prefix cache at up to 4.6x the bill.
 *
 * ⭐ So the membership question and the routing question stop sharing a table.
 * `PROVIDER_PIN_BY_MODEL` keeps answering "what do we ASK FOR by default";
 * this answers "what are we willing to be SERVED BY", which is the union of
 * every lane. Novita — the actual stray that started this — is in neither, so
 * the guard it was written for still fires.
 */
/**
 * ── 💰⭐⭐⭐ TWO OF THE THREE PINNED ENDPOINTS DO NOT CACHE AT ALL ───────────
 *
 * MEASURED 2026-09-01, live, byte-identical 31,341-byte payloads sent twice to
 * each endpoint 90 seconds apart on the same `session_id`, one round each:
 *
 *     provider     1st send   2nd send   cost per send
 *     DeepInfra      0%         96.1%    $0.000640 cold -> $0.000148 warm
 *     Ambient        0%          0.0%    $0.000640 -> $0.000640   (no change)
 *     Relace         0%          0.0%    $0.000529 -> $0.000529   (no change)
 *
 * 🚨 THE `Relace` READING ABOVE IS SUPERSEDED — RE-PROBED 2026-09-18 IT CACHES
 * 98.7% AND BILLS 4.75x LESS WARM. The 2026-09-01 table is kept here because
 * the paragraphs below reason from it and because a superseded measurement is
 * evidence about a DATE, not a lie; the live numbers and what changed are in
 * the block immediately above `CACHE_MEASURED`. ⚠️ Every "3.6x" and "no cache"
 * claim in the next three paragraphs is about that older reading and no longer
 * describes Relace.
 *
 * ⚠️⚠️ THE COST IS THE PROOF, NOT THE TOKEN COUNT. A provider that cached but
 * declined to report `cached_tokens` would still bill less on the second send.
 * Ambient and Relace billed the SAME to the cent. They deliver no cache and no
 * cache discount, so a round served by either pays full input price — forever,
 * not merely once.
 *
 * ⭐ THIS CHANGES WHAT A FALLBACK COSTS. This file elsewhere prices landing on a
 * later pin name at "4.6x for one round", which assumes the second endpoint
 * caches and merely started cold. For flash it does not: DeepInfra WARM is
 * $0.000148 against Relace's permanent $0.000529 — 3.6x, every round, with no
 * recovery — and Ambient is 4.3x. Relace's cheaper list price ($0.06/$0.12
 * against $0.08/$0.18) is a real saving only on traffic that would never cache.
 *
 * ⚠️ IT IS NOT A LICENCE TO REPIN. This file records provider choice as the
 * largest single lever on margin AND as the owner's decision, and a two-name pin
 * is one outage away from being single. So this is DATA: the only thing the code
 * does with it is SAY SO when a run lands on a non-caching endpoint. Repinning
 * is Roman's call and wants a wider sample than two sends per endpoint.
 *
 * ⚠️ ABSENCE MEANS UNMEASURED, NEVER "caches fine". Only names probed live
 * belong here, which is why this table is short.
 */
/**
 * ── 🚨⭐⭐⭐ RE-PROBED 2026-09-18 — THE `Relace` ROW WAS WRONG AND IT WAS THE
 *          MOST EXPENSIVE ROW TO GET WRONG ─────────────────────────────────
 *
 * Relace is the PINNED PRIMARY (Roman's precision call, 2026-09-11), so it
 * serves nearly every round of nearly every run — and this table said it
 * returns no cache, which made `turn.mjs` print *"returned NO prompt cache …
 * full input price every round"* on almost every summary. A real run on
 * 2026-09-18 printed that sentence directly beneath its own
 * `cache 46% (24576 of 53447 prompt tokens)`.
 *
 * Re-probed by this table's own standard — two byte-identical 32,000-char
 * sends, one session id, cost AND token count
 * (`scripts/zz-does-the-pinned-endpoint-still-cache.mjs`):
 *
 *     provider     2nd send cached   cost 1st -> 2nd            verdict
 *     Relace           98.7%         $0.000390 -> $0.000082     CACHES (4.75x)
 *     Makora           95.9%         $0.000577 -> $0.000145     CACHES (3.98x)
 *     DeepInfra        95.9%         $0.000385 -> $0.000109     caches, as before
 *
 * ⭐⭐ AND IT INVERTS THE ADVICE THE OLD ROW CARRIED. The warning told readers
 * *"DeepInfra warm measured 3.6x cheaper than Relace ever is."* Warm today,
 * Relace is $0.000082 against DeepInfra's $0.000109 — **Relace is the cheaper
 * one**, and on `deepseek/deepseek-chat` the DeepInfra deployment enforces an
 * undeclared 32,768-token cap. The stale row was steering users off the best
 * endpoint onto a worse one.
 *
 * ⚠️ `Ambient` AND `OpenInference` COULD NOT BE RE-PROBED: neither serves
 * `deepseek/deepseek-v4-flash-0731` any more ("No allowed providers are
 * available for the selected model"). Ambient's row is LEFT AT ITS ORIGINAL
 * DATE rather than refreshed, because an unreachable endpoint is unmeasured
 * today and this table's rule is *"absence means unmeasured, never caches
 * fine"* — the same rule forbids pretending a 2026-09-01 reading is current.
 * ⚠️ OpenInference is still in `PROVIDER_PIN_BY_MODEL` and cannot be reached;
 * that is a PIN question and it is Roman's.
 *
 * ⭐ THE STRUCTURAL LESSON, now enforced in `turn.mjs`: a frozen fact may not
 * contradict a fact the current run observed. Correcting these numbers fixes
 * today; the precedence rule fixes the next time they go stale.
 */
export const CACHE_MEASURED = Object.freeze({
  DeepInfra: Object.freeze({ caches: true, at: '2026-09-18', secondSendHitRate: 0.959 }),
  Relace: Object.freeze({ caches: true, at: '2026-09-18', secondSendHitRate: 0.987 }),
  Makora: Object.freeze({ caches: true, at: '2026-09-18', secondSendHitRate: 0.959 }),
  /**
   * ⚡ Probed 2026-09-28 on `deepseek/deepseek-v4.1-flash` (the new default): a 25.5k-token identical
   * prefix, four sends — Together 0% → 99.9% x3 (warm send $0.000165); Makora re-read 96.4% x3.
   * Modal from the speed probe's second send: 9,728 of 9,924 = 98.0%.
   */
  Together: Object.freeze({ caches: true, at: '2026-09-28', secondSendHitRate: 0.999 }),
  Modal: Object.freeze({ caches: true, at: '2026-09-28', secondSendHitRate: 0.980 }),
  /** ⚠️ Not re-probed on 2026-09-18 — it no longer serves this model. See above. */
  Ambient: Object.freeze({ caches: false, at: '2026-09-01', secondSendHitRate: 0 }),
});

/**
 * Did a live probe show this endpoint returning a prompt cache?
 * `null` means nobody has measured it — which is not the same as "yes".
 */
export function providerCaches(name) {
  const row = CACHE_MEASURED[String(name ?? '').trim()];
  return row ? row.caches : null;
}


export const KNOWN_PROVIDERS_BY_MODEL = Object.freeze(
  Object.fromEntries(
    [...new Set([...Object.keys(PROVIDER_PIN_BY_MODEL), ...Object.keys(PROVIDER_LANES)])].map((model) => [
      model,
      Object.freeze([...new Set([
        ...(PROVIDER_PIN_BY_MODEL[model] ?? []),
        ...Object.values(PROVIDER_LANES[model] ?? {}).flat(),
      ])]),
    ]),
  ),
);

/**
 * The provider order to ask for, given the model about to be called.
 *
 * @param {string} model
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ order: string[], source: 'env' | 'lane' | 'model' | 'default' | 'none' }}
 */
export function providerOrderFor(model, env = process.env) {
  const raw = env?.ACUVO_PROVIDER_ORDER;
  /**
   * ⚠️ UNSET vs EXPLICITLY EMPTY, and the difference is the off switch. An
   * explicit '' means "do not pin at all" and must not fall through to a
   * default — a `??` here was a real bug once, where the documented way to
   * unpin quietly did nothing.
   */
  if (raw !== undefined && raw !== null) {
    const order = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    return { order, source: order.length ? 'env' : 'none' };
  }
  /**
   * ── ⭐ THE LANE, IF ONE IS SELECTED AND THIS MODEL HAS LANES ──────────────
   *
   * ⚠️ `source` IS `'lane'`, NOT `'env'`, AND THE DIFFERENCE IS A HARD LOCK.
   * `callModel` reads `source === 'env'` as "a human named this provider" and
   * that is the ONLY case `ACUVO_PROVIDER_STRICT` is allowed to harden into
   * `allow_fallbacks:false`. A lane names a class of supply, not a machine
   * somebody vouched for, so it must never become a single point of failure —
   * the same reasoning that stops the default pin being strict.
   */
  const lanes = PROVIDER_LANES[String(model ?? '')];
  if (lanes) {
    const { lane, source } = supplyLaneFrom(env);
    /**
     * ⚠️ THE UNSELECTED CASE FALLS THROUGH ON PURPOSE. With no lane named, the
     * default lane IS `PROVIDER_PIN_BY_MODEL`, so both branches return the same
     * list — but only the fall-through reports `source: 'model'`, and that is
     * the string every existing caller and test has been reading for weeks.
     * Re-labelling an unchanged route is the kind of "harmless" difference that
     * makes a later bisect lie about when behaviour moved.
     */
    const order = source === 'default' ? null : lanes[lane];
    if (order && order.length) return { order: [...order], source: 'lane' };
  }
  const byModel = PROVIDER_PIN_BY_MODEL[String(model ?? '')];
  if (byModel && byModel.length) return { order: [...byModel], source: 'model' };
  /**
   * ⚠️ AN UNKNOWN MODEL IS LEFT UNPINNED RATHER THAN GIVEN FLASH'S PIN. Asking
   * for a provider that does not serve the model is exactly the bug above: it
   * looks pinned, matches nothing, and routes freely to whatever is dearest.
   * No pin at least tells the truth, and `pinOutcome` reports it.
   */
  return { order: [], source: 'none' };
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
  // A live stream is bounded by silence, not by length — see `streamWatchdog`.
  streamIdleMs = STREAM_IDLE_MS, streamCapMs = STREAM_CAP_MS, streamThinkMs = STREAM_THINK_MS,
  /**
   * ⚠️ Off only for a test that asserts the single-attempt payload. Production
   * never sets it — the warm-first attempt IS the cache floor, and a flag that
   * quietly disables it would be the defect this change exists to remove.
   */
  retryOnPinFailure = true,
  // ⚠️ Injected so the provider preference below is testable without touching
  // the real environment — and so a library caller can set it explicitly.
  env = process.env,
  /**
   * ── ⭐ AN OBSERVED ROUTE, NOT A CONFIGURED ONE ────────────────────────────
   *
   * `warm-provider.mjs` watches who ACTUALLY served earlier rounds and asks for
   * that one name with fallbacks off, because a prompt cache lives on a single
   * upstream and `provider.order` is only a preference. Measured live: a round
   * that landed on the pin's second name was 0% cached and 4.6× the price for
   * byte-identical input.
   *
   * ⚠️ STRICT IS SAFE HERE ONLY BECAUSE THE NAME WAS SEEN TO SERVE. Strictness
   * on a CONFIGURED name is a single point of failure — that is why
   * `ACUVO_PROVIDER_STRICT` is opt-in, and this deliberately does not reuse it.
   * `null` leaves every existing caller byte-identical.
   */
  routeOverride = null,
  /**
   * ── ⭐⭐⭐ THE STICKY KEY — AND THE FEATURE OUR OWN FIX WAS SWITCHING OFF ───
   *
   * Everything this file says about the routing lottery is correct: a prompt
   * cache lives on ONE upstream, `provider.order` is only a preference over
   * PROVIDERS, and a provider is a fleet of machines — so pinning the provider
   * never pinned the machine, and successive cold processes measured
   * 65 / 98 / 31 / 98.
   *
   * ⚠️⚠️ WHAT NONE OF THAT NOTICED IS THAT OPENROUTER SOLVES THIS, AND WE WERE
   * DISABLING IT. Their prompt-caching documentation, verbatim:
   *
   *   "Sticky routing is not used when you specify a manual provider order via
   *    `provider.order` — in that case, your explicit ordering takes priority."
   *
   *   "When `session_id` is set, sticky routing activates on any successful
   *    request — even before cache usage is observed — so that subsequent
   *    requests in the same session benefit from prompt caching from the start."
   *
   * ⭐ So the warm-first pin — the change written specifically to win the cache
   * back — is the one thing that turns off the mechanism that pins the actual
   * SERVER. We diagnosed "pinning the provider does not pin the machine" and
   * then concluded the machine could not be pinned; in fact it can, and our pin
   * was what stopped it. That is why round 1 was always 0% and why the same
   * task warmed 0 → 79 → 99 instead of starting warm.
   *
   * ⚠️ UNPROVEN UNTIL MEASURED, AND SAID PLAINLY. This is read from their docs,
   * not from our own numbers — the honest test is four cold runs sharing a
   * session id, which needs credits. It is defensible before that measurement
   * only because it cannot be worse: `session_id` is inert if stickiness never
   * engages, and `only` restricts exactly what `order` restricted for a
   * one-element list. `null` leaves every existing caller byte-identical.
   */
  sessionId = null,
}) {
  const streaming = typeof onText === 'function';
  /**
   * ── ⭐⭐ CACHE STICKINESS: THE PREFIX IS PERFECT AND THE ROUTING IS NOT ─────
   *
   * Measured 2026-08-12 with a scripted model, so the numbers are about the
   * bytes WE send: **97.0% and 97.9% of rounds 2 and 3 were a byte-identical
   * re-send** of the previous round, and the `tools` array was identical every
   * round. Our side of the cache contract is essentially optimal.
   *
   * ⚠️ AND REAL RUNS THE SAME DAY REPORTED 0%, 32%, 33% HIT RATES. The gap is
   * not ours: a prompt cache lives on ONE upstream instance, and OpenRouter is
   * free to route each round to a different provider behind the same model id —
   * this file already documents that variation. Round 2 landing elsewhere is a
   * cold cache no prefix discipline can fix.
   *
   * ⭐ `ACUVO_PROVIDER_ORDER` (comma-separated) pins the preference so successive
   * rounds tend to reach the same instance.
   *
   * ⚠️ `allow_fallbacks` STAYS TRUE, and that is not a detail. "Never single"
   * is this package's standing rule: pinning hard would trade an outage for a
   * discount, and a cheaper request that does not happen is not cheaper. This
   * expresses a PREFERENCE and keeps the chain underneath it.
   *
   * ⚠️ OFF UNLESS SET. Provider names are an OpenRouter catalogue detail that
   * changes without notice, and inventing one would route every request at a
   * provider that may not serve this model — so the default sends no `provider`
   * field at all and behaves exactly as before. `DEFAULT_PROVIDER_ORDER` is the
   * one-line switch that changes that, and it is deliberately empty.
   *
   * ⚠️⚠️ AND A PIN THAT DOES NOT TAKE IS SILENT — measured, 2026-08-14. See
   * `pinOutcome` above for the three outcomes and what the silence costs. The
   * fallback is NOT the bug and is not being removed; the silence is, and the
   * pin now travels back on the reply so the round record can name it.
   */
  /**
   * ⚠️⚠️ WHETHER THE PIN WAS CHOSEN BY A HUMAN OR INHERITED FROM OUR DEFAULT,
   * AND THE DIFFERENCE IS LOAD-BEARING FOR `ACUVO_PROVIDER_STRICT`.
   *
   * Strict turns a pin into `allow_fallbacks:false` — an outage becomes a 404
   * instead of a re-route. That is correct for a benchmark and catastrophic as
   * an inherited default: the day the preferred endpoint has a bad ten minutes,
   * every run dies at once, which is precisely the "never single" failure this
   * package refuses to accept.
   *
   * ⭐ So strict applies ONLY to a pin somebody named. Our default is a
   * PREFERENCE and can never be promoted to a lock by a second flag. A test
   * caught this the moment the default was switched on — `ACUVO_PROVIDER_STRICT`
   * alone used to be inert, and without this it would silently have become a
   * hard lock on a provider the user never chose.
   */
  /**
   * ⚠️ UNSET AND EXPLICITLY-EMPTY ARE DIFFERENT, AND CONFLATING THEM COSTS THE
   * OFF SWITCH. `ACUVO_PROVIDER_ORDER=''` is how somebody says "no pin, give me
   * the lottery back" — for a routing experiment, or because a provider is
   * having a bad day. A first version of this used `??`, so an explicit empty
   * string fell through to the default and the variable could not turn the
   * feature off at all.
   *
   * ⚠️ AND MY OWN TEST ASSERTED THAT PROPERTY AND MISSED IT, because it
   * reimplemented this expression locally instead of calling `callModel`. A test
   * that copies the logic it is checking verifies the copy.
   */
  /**
   * ⚠️ RESOLVED PER MODEL. A single global name was only ever correct for the
   * model it was measured on: flash's preferred endpoint does not serve pro at
   * all, so every pro run asked for a provider that could not answer, matched
   * nothing, and routed freely to the dearest endpoint — 2.8x the tokens and 28x
   * the cache reads, on 13 of 13 bench runs. See `PROVIDER_PIN_BY_MODEL`.
   */
  const explicitRaw = env?.ACUVO_PROVIDER_ORDER;
  const hasExplicit = explicitRaw !== undefined && explicitRaw !== null;
  const resolvedPin = providerOrderFor(model, env);
  const providerOrder = resolvedPin.order;
  const pinWasChosen = resolvedPin.source === 'env';

  /**
   * ── ⚠️ THE HARD PIN, FOR PEOPLE WHO GENUINELY WANT ONE ─────────────────────
   * `allow_fallbacks:false` turns an unhonourable pin into an HTTP 404 instead
   * of a silent re-route. That is the RIGHT answer for a benchmark or a cache
   * experiment and the WRONG default for a tool people work in: "never single"
   * is this package's standing rule, and a cheaper request that does not happen
   * is not cheaper. Opt-in, off unless `ACUVO_PROVIDER_STRICT` is truthy, and
   * meaningless without a pin to be strict about.
   */
  /**
   * ⚠️ `pinWasChosen`, NOT `providerOrder.length` — see the note above. Since the
   * default pin arrived, the length test would let `ACUVO_PROVIDER_STRICT=1`
   * alone harden a provider the user never named into a single point of failure.
   * Strict is only ever strict about a pin a human typed.
   */
  const strictPin = pinWasChosen
    && /^(1|true|yes|on)$/i.test(String(env?.ACUVO_PROVIDER_STRICT ?? '').trim());

  /**
   * ── ⭐⭐ WHAT WE ASKED FOR TRAVELS BACK WITH WHAT WE GOT ────────────────────
   *
   * ⚠️ WITHOUT THIS THE COMPARISON IS IMPOSSIBLE ANYWHERE ELSE. `turn.mjs` sees
   * a reply, not an environment: it can be told which upstream served the round
   * (`provider`, off the response) but it has no way to know which one was
   * REQUESTED, and "served by X" is only a finding next to "we asked for Y".
   * Reading `process.env` again in the loop would be the wrong fix —
   * `env` is injected here precisely so a library caller can set it per call,
   * and a second reader would disagree with this one the first time anybody did.
   *
   * `null`, never `[]`, when nothing was pinned: an empty array reads as "a pin
   * that matched nothing", which is the opposite of "no pin".
   */
  /**
   * ⚠️ THE OVERRIDE WINS, AND ONLY IT MAY BE STRICT WITHOUT `ACUVO_PROVIDER_STRICT`.
   * It carries a provider we watched serve this session, so it is known-reachable
   * — the property a configured name cannot promise (pro's pin starts with
   * `DeepSeek`, which 404s for this account).
   */
  const overrideOrder = Array.isArray(routeOverride?.order) ? routeOverride.order.filter(Boolean) : [];
  const useOverride = overrideOrder.length > 0;
  const effectiveOrder = useOverride ? overrideOrder : providerOrder;
  const effectiveStrict = useOverride ? Boolean(routeOverride.strict) : strictPin;

  const providerPin = effectiveOrder.length > 0 ? [...effectiveOrder] : null;

  /**
   * ── ⚠⚠⚠ WARM FIRST, THEN FALL BACK — THE 90% CACHE FLOOR ─────────────
   *
   * Roman, 2026-08-19: *"that caching needs to be 90 … you've said it
   * permanently is, yet it isn't."* He is right, and this is the cause.
   *
   * ⚠️ MEASURED ACROSS 90 REAL RUNS from our own audit ledger: token-weighted
   * hit rate **51.2%**, only 18 of 90 runs at or above 90%, and round 1
   * non-zero on just 3 of 16. The prompt is NOT the problem — the system
   * message is byte-identical across processes (3,671 chars, shared prefix
   * 3,671/3,671). **The routing is.**
   *
   * `provider.order` is a PREFERENCE over several upstreams and
   * `allow_fallbacks: true` lets OpenRouter pick freely. A prompt cache lives on
   * exactly ONE upstream, so a fresh process lands wherever and starts cold.
   * With round 1 cold, an N-round run cannot exceed (n−1)/n — a 3-round task is
   * capped at 67% however perfect the prompt is. That is why "90% always" was
   * arithmetically impossible, not merely unmet.
   *
   * ⭐ THE FIX IS NOT THE TRADE IT LOOKS LIKE. "Never single" rightly refuses a
   * bare `allow_fallbacks: false`, because one provider having a bad ten minutes
   * would be an outage for every user at once. So we do BOTH, in order:
   *
   *   attempt 1  one provider, `allow_fallbacks: false`  → lands on the warm cache
   *   attempt 2  the full order, fallbacks on            → only if attempt 1 fails
   *
   * The lock is what buys the cache; the retry is what keeps "never single"
   * true. **Neither half is optional** — shipping the lock alone would be a real
   * availability regression, and shipping the retry alone changes nothing.
   *
   * ⚠️ AND IT RETRIES ONLY ON AVAILABILITY FAILURES. A 401, 402 or 404 is not
   * the provider being busy — it is the key, the balance, or the model id, and
   * every one of those fails identically on the second attempt. Retrying them
   * would double the latency of the most common real errors and spend money to
   * learn nothing.
   */
  /**
   * ── ⭐⭐⭐ THE WARM ATTEMPT USES `only`, NOT `order` — AND THAT IS THE FIX ──
   *
   * Both restrict the request to one provider. Only one of them switches off
   * OpenRouter's sticky routing, which is the feature that pins the SERVER
   * rather than the company:
   *
   *   order: ['<one name>'], allow_fallbacks: false
   *       -> "your explicit ordering takes priority", sticky routing OFF,
   *          every cold process rolls the dice inside that company's fleet.
   *          Measured: 65 / 98 / 31 / 98.
   *   only: ['<one name>']
   *       -> the same one-provider restriction, expressed as a WHITELIST. There
   *          is no ordering to take priority over, so nothing documented turns
   *          stickiness off.
   *
   * ⚠️ HOW SURE I AM, EXACTLY: that `order` disables sticky routing is quoted
   * verbatim from their docs and confirmed by a second source. That `only`
   * PRESERVES it is an inference — their docs do not discuss `only` at all, and
   * I will not write that they do. It is the right change anyway because it is
   * weakly dominant: identical restriction, and either stickiness survives (a
   * large win) or it does not (exactly today's behaviour).
   *
   * ⚠️ THE SECOND ATTEMPT KEEPS `order`, deliberately. It exists to survive the
   * first provider being unavailable, and there ORDERING IS THE POINT — try
   * these, in this sequence. Losing stickiness on a leg that only runs when the
   * warm machine already failed costs nothing that was not already lost.
   */
  /**
   * ── ⚠️ AND THE ONE-NAME CASE, WHICH THE FIRST VERSION OF THIS FIX MISSED ──
   *
   * `warmFirst` required `effectiveOrder.length > 1`, so a pin of a SINGLE
   * provider — including any one-name `ACUVO_PROVIDER_ORDER`, and
   * `provider-routing-visibility.test.mjs` asserts the default is deliberately
   * *"one preferred provider, not a list pretending to be a policy"* — fell to
   * the bottom branch and shipped `order` + `allow_fallbacks: true`.
   *
   * ⭐ THAT IS THE WORST OF BOTH. A manual order disables sticky routing, and
   * `allow_fallbacks: true` means the request can land anywhere anyway. So the
   * configuration that has ALREADY DECIDED which provider it wants was the one
   * getting neither the pin nor the stickiness. One name now takes the same
   * warm-then-fall-back path as several.
   */
  /**
   * ── 💰⭐⭐⭐ THE FALLBACK LEG GOES TO THE CHEAPEST NAME WE TRUST ──
   *
   * Roman, 2026-09-18: *"these switches when a provider fucks up, we need to
   * have a process where the cheapest next one at that current moment goes
   * through, smoothly."*
   *
   * ⚠️⚠️ ATTEMPT 2 IS THE ONLY THING THAT MOVES. Attempt 1 is the warm lock on
   * the pinned primary and it is byte-identical to before — so a healthy round,
   * which is almost every round, sends exactly what it sent yesterday. This is a
   * change to the FAILURE path, which is the path Roman was describing.
   *
   * ⭐ AND IT IS A PERMUTATION, NEVER AN ADDITION. `costOrderedFallback` can only
   * reorder names already in the pin, so no cheaper-but-unapproved provider can
   * be reached this way — `supply-watch.ts` surfaces those for a human and that
   * stays a human's call. Measured 2026-09-18, flash's pin runs
   * `Relace — Makora — OpenInference — DeepInfra` while the blended cost runs
   * `Relace $0.0150 < DeepInfra $0.0184 < Makora $0.0241` per million: the first
   * fallback was 24% dearer than the last one.
   *
   * ⚠️ `CACHE_MEASURED` IS THE PROOF, NOT THE PIN. A name is only re-ranked if we
   * have OBSERVED it returning a prompt cache. That is deliberately stricter than
   * pin membership: `OpenInference` is pinned and unreachable, so it keeps its
   * hand-typed position instead of being sorted onto a price we cannot verify.
   *
   * ⚠️⚠️ A DEAD PRICE LOOKUP CHANGES NOTHING. `providerRateFor` returns `null`
   * for anything unpriced and `costOrderedFallback` then hands back the static
   * order byte for byte. No network call happens here at all — the card is
   * committed data — so routing cannot degrade when the internet does.
   */
  const trustedByCacheProbe = Object.keys(CACHE_MEASURED).filter((n) => CACHE_MEASURED[n].caches === true);
  const costOfProvider = (name) => {
    const rate = providerRateFor(model, name);
    if (!rate) return null;
    /**
     * ⚠️ THE CACHE RATE IS OUR MEASURED ONE, NOT AN OPTIMISTIC ONE — 77.5% of our
     * input tokens are cache reads (`supply-watch.ts`). ⭐ The ORDER it produces
     * is stable from 0% to 95.8%, checked in
     * `the-fallback-order-is-price-aware.test.mjs`, so this constant decides the
     * numbers printed in a decision doc and not which provider gets the call.
     */
    return blendedPerMillion(rate, 0.775, OUTPUT_TOKEN_SHARE);
  };
  const fallbackLeg = costOrderedFallback(effectiveOrder, { costOf: costOfProvider, proven: trustedByCacheProbe });

  const warmFirst = effectiveOrder.length > 0 && !effectiveStrict && retryOnPinFailure !== false;
  const attempts = warmFirst
    ? [
      { only: [effectiveOrder[0]] },
      // ⭐ Cheapest-first among the names we have proven. See `fallbackLeg` above.
      { order: fallbackLeg.order, allowFallbacks: true },
    ]
    /**
     * ⭐ STRICT IS `only` TOO, and it is the truest expression of it: a
     * whitelist cannot be left, so an unavailable upstream is a 404 rather than
     * a silent re-route — exactly what strict was always asking for, now said
     * in the vocabulary that keeps stickiness.
     *
     * ⚠️ ONE REAL TRADE, STATED: with several names, `only` drops the
     * PREFERENCE between them. Strict callers pin one name in practice, and the
     * alternative is keeping an ordering that switches off the server pinning
     * this whole change exists for.
     */
    : effectiveStrict && effectiveOrder.length > 0
      ? [{ only: effectiveOrder }]
      : [{ order: effectiveOrder, allowFallbacks: !effectiveStrict }];

  const payload = {
    model,
    messages,
    tools,
    ...(effectiveOrder.length > 0
      ? { provider: { order: effectiveOrder, allow_fallbacks: !effectiveStrict } }
      : {}),
    ...(streaming ? { stream: true } : {}),
    /**
     * The sticky key. See `sessionId` above for why this is the whole caching
     * story and not a nicety. Omitted entirely when absent so no existing
     * caller's wire body changes by one byte.
     *
     * WARNING: it is also OpenRouter's grouping key on the Logs page, so the
     * value must identify a CONVERSATION, never a user or a tenant — a shared
     * value would pin unrelated traffic to one machine and pool the logs of
     * people who have nothing to do with each other.
     */
    ...(sessionId ? { session_id: String(sessionId).slice(0, 256) } : {}),
    tool_choice: 'auto',
    /**
     * ⚠️ THE FIELD THAT DECIDES WHETHER A MULTI-FILE TASK IS POSSIBLE AT ALL.
     * In a one-round turn, "one tool call per response" means one FILE per
     * command — measured 2026-08-09: asked for a module plus its test, the model
     * wrote the module, said it was writing both, and there was no second round
     * to finish in. A direct probe of the same model DID return two calls, so
     * the capability is there and OpenRouter's upstream routing — two different
     * companies serving the same model id — is what varies.
     *
     * ⭐ CORRECTED 2026-08-09 — AND THE ORIGINAL NOTE WAS BLAMING THE WRONG
     * THING. It read: "this model writes ONE file per response regardless of how
     * many it promises… parallel_tool_calls did not fix it." That was measured on
     * `deepseek-v3.2`, and it is NOT true of `deepseek-v4-flash-0731`.
     *
     * Re-measured on v4 with reasoning disabled: asked for three files
     * (src/add.js, src/sub.js, src/index.js re-exporting both) it wrote **all
     * three in one turn**, correctly, in a single round — and the result runs:
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
     *
     * ── ⚠️⚠️⭐ RETESTED 2026-09-02, AND HALF OF THE PARAGRAPH ABOVE IS STALE ──
     *
     * The rule is a WILDCARD over `deepseek-v4-*` measured on ONE day, and the
     * comment 30 lines above this one ends *"Version the claim or do not make
     * it."* So it was versioned: four probes at the pinned id
     * `deepseek/deepseek-v4-flash-0731`, real tool schemas, one coding brief.
     *
     *     reasoning=false max_tokens=12000  finish=tool_calls  reasoning_tokens=0
     *     reasoning=true  max_tokens=12000  finish=tool_calls  reasoning_tokens=24
     *     reasoning=true  max_tokens=32000  finish=tool_calls  reasoning_tokens=4
     *     field omitted   max_tokens=12000  finish=tool_calls  reasoning_tokens=24
     *
     * ⭐ **"RETURNS NOTHING AT ALL" NO LONGER REPRODUCES.** Every arm returned
     * tool calls. It does not spend the completion allowance thinking — it spent
     * 24 tokens of 12,000 — and it was not 1.7x dearer: 0.0000890 vs 0.0000841,
     * a 5.8% difference, on this id.
     *
     * ⚠️⚠️ AND THE ORIGINAL SYMPTOM MAY NEVER HAVE BEEN THE MODEL. The recorded
     * evidence is `content: null`, and `extractReply` above documents at length
     * that *"`content: null` WITH TOOL CALLS IS THE NORMAL SHAPE"*. A reply with
     * reasoning on is far likelier to carry null content than one with it off —
     * so a client that read null content as "wrote nothing" would blame the
     * setting for its own bug. That client bug is fixed; the wildcard it
     * justified was not revisited until now.
     *
     * ⭐ SO THE DEFAULT IS UNCHANGED AND THE CLAIM IS NOW OVERRIDABLE. Default
     * off keeps every existing run byte-identical — a measurement is not a
     * mandate, and the quality comparison belongs to whoever runs it. Set
     * `ACUVO_REASONING=on` to send `enabled: true`, `off` to force it off for a
     * model the wildcard does not name. See `reasoningField`.
     */
    ...reasoningField(model, env),
    max_tokens: maxTokens,
    temperature: 0.2,
    // Asking for usage accounting is free and is the only way the cost line
    // below is a measurement rather than an estimate.
    usage: { include: true },
  };

  /**
   * ⚠️ 401/402/404 ARE NOT AVAILABILITY. A bad key, an empty balance or a wrong
   * model id fails identically on every provider, so a second attempt costs
   * latency and teaches nothing. Everything else — transport, 5xx, 429 — is the
   * pinned upstream being unreachable or busy, which is what the fallback is for.
   */
  const worthFallingBackFrom = (status) => status !== 401 && status !== 402 && status !== 404;

  /**
   * ⭐ DIRECT BEATS THE LOTTERY. When a DeepSeek key is present and the model is
   * one we can name on their API, the whole provider-order dance is skipped:
   * one vendor, one endpoint, their own context cache, no aggregator picking a
   * server. `attempts` is collapsed to a single unpinned call because there is
   * nothing left to pin — and no fallback, because falling back to OpenRouter
   * mid-run would land on a cold machine and undo the reason we came here.
   */
  /**
   * ── ⚠️⚠️⚠️ AND THE TRAP THAT MEASURING THE KEY EXPOSED, 2026-08-19 ────────
   *
   * The paragraph above ended *"and no fallback, because falling back to
   * OpenRouter mid-run would land on a cold machine and undo the reason we came
   * here."* That is correct about the CACHE and catastrophic about AVAILABILITY,
   * and a live probe is what showed it: the direct endpoint answered
   * **402, insufficient balance** — an authenticating key on an account with
   * nothing left on it, which is a perfectly ordinary state for any second
   * vendor to be in. Combined with
   * `worthFallingBackFrom` — which excludes 401/402/404 on the stated grounds
   * that *"a bad key, an empty balance or a wrong model id fails identically on
   * every provider"* — that made every single call fail hard with no second
   * attempt, the moment anyone exported the key.
   *
   * ⭐ THAT PREMISE IS TRUE FOR ONE ACCOUNT AND FALSE FOR TWO. It was written
   * when every attempt was a different PROVIDER ORDER on one OpenRouter key, so
   * an empty balance really was the same fact each time. A direct vendor call
   * uses a DIFFERENT VENDOR, a DIFFERENT KEY and a DIFFERENT BALANCE, and
   * DeepSeek being out of credit says precisely nothing about OpenRouter. The
   * rule did not change; the world it described did.
   *
   * ⚠️ VERIFIED NOT LIVE WHEN IT WAS FOUND: no `DEEPSEEK_API_KEY` was set
   * anywhere the tool runs, so nothing was broken at the time. It was a loaded
   * trap, not a fire — and the fix belongs BEFORE the day someone sets that key,
   * not after.
   *
   * ⭐ So the routes are now heterogeneous: the direct vendor FIRST (for the
   * cache), then the OpenRouter ladder behind it (for availability). A cold
   * answer beats no answer. The cache argument only ever applied to a call that
   * SUCCEEDED, and this fallback fires only when one did not.
   */
  const direct = directDeepSeek(model, env);
  const openRouterRoutes = attempts.map((a) => ({
    /**
     * ⚠️⚠️ `resolveApiUrl(env)`, NOT `resolveApiUrl()`. This called it with no
     * argument, so it read `process.env` and IGNORED the `env` this function was
     * handed — every other routing decision on this path (`directDeepSeek(model,
     * env)` one line up) honours it.
     *
     * ⭐ IT SURFACED AS A TEST FAILURE AND IT IS NOT A TEST PROBLEM. The moment
     * Roman signed in, `~/.acuvo/credentials.json` existed, and a scoped
     * `env: {}` still resolved to the production gateway — because the endpoint
     * was never scoped at all. Any caller that builds a per-tenant or per-user
     * env would silently get the machine's account instead of the one it asked
     * for, which on a multi-tenant path is somebody else's bill.
     */
    endpoint: resolveApiUrl(env), key: apiKey, model,
    order: a.order ?? null, only: a.only ?? null, allowFallbacks: a.allowFallbacks, direct: false,
  }));
  const routes = direct
    ? [{ endpoint: direct.url, key: direct.apiKey, model: direct.model, order: null, only: null, allowFallbacks: true, direct: true }, ...openRouterRoutes]
    : openRouterRoutes;

  let res = null;
  let transportFail = null;
  let watchdog = null;

  for (let i = 0; i < routes.length; i += 1) {
    const attempt = routes[i];
    const isLast = i === routes.length - 1;
    const endpoint = attempt.endpoint;
    const authKey = attempt.key;
    const wireModel = attempt.model;
    /**
     * The three shapes this can take, and they are not interchangeable:
     *   only  -> one provider, whitelist, sticky routing left alone (the warm leg)
     *   order -> a sequence to try, sticky routing off by OpenRouter's rule
     *   none  -> a direct vendor call, which has no provider concept at all
     */
    const body = {
      ...payload,
      model: wireModel,
      ...(attempt.only
        ? { provider: { only: attempt.only } }
        : (attempt.order && attempt.order.length > 0
          ? { provider: { order: attempt.order, allow_fallbacks: attempt.allowFallbacks } }
          : {})),
    };
    /**
     * ⚠⚠ `provider` IS AN OPENROUTER FIELD AND MUST NOT REACH DEEPSEEK.
     * The base payload carries it, and the per-attempt spread only OVERRIDES it
     * — it cannot remove it. So a direct call was shipping the aggregator's
     * `provider: { order: [...] }` block to an API that has no provider concept
     * and has never heard of those names. Caught by printing the wire body
     * rather than trusting the
     * branch, and it is the kind of thing that 400s in production and reads as
     * "DeepSeek is down".
     *
     * ⚠️ `attempt.direct`, NOT `direct`. Once the routes became heterogeneous
     * this had to become per-route: `direct` is now true for the whole CALL
     * whenever a DeepSeek key exists, so testing it here would strip the
     * `provider` pin off every OpenRouter fallback — silently unpinning the
     * ladder and handing us back the routing lottery we went direct to escape.
     * The same mistake in the opposite direction as the bug this comment is
     * about, made by the fix for it.
     */
    if (attempt.direct) delete body.provider;

    let attemptRes = null;
    // ⭐ One watchdog per attempt — see `streamWatchdog`. A whole response is
    // bounded exactly as before; a live stream is bounded by SILENCE instead.
    watchdog?.stop();
    watchdog = streamWatchdog({ timeoutMs, idleMs: streamIdleMs, capMs: streamCapMs, thinkMs: streamThinkMs });
    try {
      attemptRes = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authKey}`,
          'Content-Type': 'application/json',
          // OpenRouter uses these for attribution; harmless and polite.
          'HTTP-Referer': 'https://acuvo.xxiautomate.com',
          'X-Title': 'Acuvo Code',
        },
        body: JSON.stringify(body),
        signal: watchdog.signal,
      });
    } catch (err) {
      transportFail = { ok: false, error: watchdog.describe(err), kind: transportErrorKind(err) };
      watchdog.stop();
      if (isLast) return transportFail;
      continue;
    }

    /**
     * ⭐ A non-ok status falls through to the existing handler below on the LAST
     * attempt, or on any status a second provider could not fix.
     *
     * ⚠️ EXCEPT FROM THE DIRECT ROUTE, WHERE EVERY FAILURE IS WORTH LEAVING.
     * `worthFallingBackFrom` excludes 401/402/404 because on one account those
     * fail identically however many times you ask. Leaving the DIRECT vendor is
     * not asking again — it is asking a DIFFERENT COMPANY with a different key
     * and a different balance. `Insufficient Balance` at DeepSeek is the single
     * most likely failure here (it is what the live probe returned) and it is
     * exactly the one the shared predicate would refuse to escape.
     */
    const canLeave = attempt.direct ? true : worthFallingBackFrom(attemptRes.status);
    if (attemptRes.ok || isLast || !canLeave) { res = attemptRes; break; }
  }

  if (!res) return transportFail ?? { ok: false, error: 'the model call produced no response' };

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    watchdog?.stop();
    /**
     * ── ⚠️⚠️ `providerPin` TRAVELS ON THE FAILURE PATH TOO, AND THAT IS THE POINT ─
     *
     * It was returned on all three SUCCESS returns and none of the failures, so
     * the one caller that needs it most could never see it: `callChain` decides
     * whether a failure is about THIS MODEL or about the REQUEST, and a 404
     * caused by a bad PIN reads exactly like a 404 caused by a dead model id —
     * "No endpoints found for <model>", naming the model that was never the
     * problem.
     *
     * ⭐ Measured 2026-08-14: with the pin invisible here, `isModelSpecific`
     * matched, and the chain spent all four candidates re-sending the identical
     * bad pin — four round trips and four times the wait to learn one fact
     * about an environment variable. The chain cannot reason about a cause it
     * is never told.
     */
    return { ok: false, error: classifyHttpFailure(res.status, text, { pin: providerPin }), providerPin };
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
        return { ok: false, error: describeTransportError(err, timeoutMs), kind: transportErrorKind(err) };
      }
      if (!whole) return { ok: false, error: 'the provider returned neither a stream nor JSON.' };
      const r = extractReply(whole);
      // ⚠️ `usage`/`provider` FORWARDED ON THE FAILURE LEG TOO. `extractReply`
      // now reports the bill for a billed-but-empty 200; dropping it here would
      // re-open the hole one function further out. See the block in
      // `extractReply` and `lib/stream.mjs`.
      return r.ok
        ? { ok: true, ...r, model, providerPin }
        : { ok: false, error: r.error, usage: r.usage ?? null, provider: r.provider ?? null, providerPin };
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
      collected = await collectStream(watchdog ? watchdog.watch(res.body) : res.body, { onText });
    } catch (err) {
      return { ok: false, error: watchdog ? watchdog.describe(err) : describeTransportError(err, timeoutMs), kind: transportErrorKind(err) };
    } finally {
      watchdog?.stop();
    }
    /**
     * ⚠️⚠️ THIS IS THE LINE THE WHOLE CLI GOES THROUGH. `turn.mjs` passes
     * `onText` on every round, so streaming is the CLI's ONLY branch (stated in
     * `stream.mjs`'s own header) — which made this the single most expensive
     * place in the package to drop a usage object, and it dropped every one.
     * `collectStream` parses the final usage frame BEFORE it decides the reply
     * is empty; carrying it out is the difference between a metered failure and
     * an invisible one.
     */
    if (!collected.ok) {
      return {
        ok: false,
        error: collected.error,
        usage: collected.usage ?? null,
        provider: collected.provider ?? null,
        providerPin,
      };
    }
    return { ok: true, ...collected, model, providerPin };
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    // ⚠️ Same trap as the streaming branch above, and it was here too: a body
    // that aborted mid-read is a TRANSPORT fault, and calling it "not JSON"
    // told the chain not to bother with the next provider.
    if (err?.name !== 'SyntaxError') return { ok: false, error: describeTransportError(err, timeoutMs), kind: transportErrorKind(err) };
    return { ok: false, error: 'OpenRouter returned a 200 with a body that is not JSON.' };
  } finally {
    watchdog?.stop();
  }
  const reply = extractReply(body);
  // ⚠️ Same forwarding as the two streaming legs above: a billed empty 200 must
  // arrive at the meter with its token counts attached, whichever leg produced it.
  if (!reply.ok) {
    return {
      ok: false,
      error: reply.error,
      usage: reply.usage ?? null,
      provider: reply.provider ?? null,
      providerPin,
    };
  }
  /**
   * ── 💰⭐⭐⭐ WHO ACTUALLY SERVED IT — THE MISSING HALF OF THE CACHE STORY ────
   *
   * Roman has asked repeatedly how anyone could KNOW the cache will not revert.
   * The honest answer was that nobody could, because a miss had no explanation:
   * we recorded the hit RATE and never recorded WHICH UPSTREAM produced it.
   *
   * ⭐ AND THE CAUSE IS ROUTING, MEASURED 2026-08-22 AGAINST THE LIVE API. Each
   * provider keeps its OWN prompt cache, and OpenRouter treats a provider
   * `order` as a PREFERENCE:
   *
   *     order:[A,B,C]  allow_fallbacks:true
   *       -> A, B, A          (rotates; every switch is a guaranteed miss)
   *     order:[A]      allow_fallbacks:true
   *       -> D x4, A x1       (a one-name ORDER still leaves the pin entirely)
   *     only:[A]
   *       -> A x5             (sticky)
   *
   * The warm leg already sends `only`, so the routing is right. What was absent
   * was the EVIDENCE — `pinOutcome` was written for exactly this comparison and
   * had no caller anywhere in the package, because nothing captured `served`.
   *
   * ⚠️ OPENROUTER RETURNS IT AND WE WERE THROWING IT AWAY. `json.provider` is
   * on every response; a direct vendor call has no such concept and yields null,
   * which `pinOutcome` reports as 'none' rather than pretending.
   */
  const servedBy = typeof body?.provider === 'string' && body.provider ? body.provider : null;
  return {
    ok: true,
    ...reply,
    model,
    providerPin,
    servedBy,
    pinOutcome: pinOutcome({ pin: providerPin, served: servedBy }),
  };
}
