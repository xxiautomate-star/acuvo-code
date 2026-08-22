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
 * ⭐ v4-flash, measured 2026-08-09 against v3.2-exp on an identical brief:
 * $0.000842 vs $0.001465 (1.7x cheaper), 50s vs 95s (1.9x faster), and it
 * emitted a correctly SIZED svg icon where v3.2-exp emitted none. Reasoning must
 * be off — see the request body below.
 */
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash-0731';
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
 * SERVER. `provider: { order: ['StreamLake'], allow_fallbacks: false }` pins the
 * PROVIDER — and StreamLake is a fleet. Pinning the provider does not pin the
 * machine, so each run rolls the dice and warms whichever server it landed on.
 * No amount of prefix discipline can fix that from our side.
 *
 * ⚠️ Going direct removes the lottery entirely: one vendor, one endpoint, their
 * own automatic context caching, and no aggregator choosing a server for us. It
 * is also cheaper, because OpenRouter's margin disappears with it.
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
   * endpoint — which is 3.7x dearer on OUTPUT ($0.66/M vs OpenRouter's $0.18/M)
   * and doubles for 7 hours a day under DeepSeek's peak billing (01:00-04:00 and
   * 06:00-10:00 UTC = 11am-2pm / 4pm-8pm AEST). Measured over 95M tokens that is
   * 62.3% margin against 85.6%.
   *
   * ⭐ Direct's cache READ is genuinely cheaper ($0.007/M vs $0.0154/M) and that
   * is why it once led. It cannot pay for the cache MISSES (2.9x dearer) or the
   * output (3.7x dearer), and output is ~60% of the bill.
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
  '  A) Your Acuvo account, billed to your Acuvo credits:',
  '       acuvo --login        (paste the key from Settings → API keys)',
  '',
  '  B) Your own key, billed to you — https://openrouter.ai/keys',
  '       export OPENROUTER_API_KEY=sk-or-v1-...        (bash / zsh)',
  '       $env:OPENROUTER_API_KEY = "sk-or-v1-..."      (PowerShell)',
  '',
  'A typical task costs $0.001-$0.003. The ceiling is $0.02 a run unless you',
  'raise it, so a mistake costs two cents to find.',
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
 * 402 is what an exhausted balance returns, and it is the single most likely
 * failure for this account — measured 2026-08-09, the key authenticates and the
 * credits endpoint reports `total_credits: 0` against `total_usage: 0.028`.
 *
 * ⚠️ THE THIRD ARGUMENT IS OPTIONAL AND EVERY EXISTING CALLER STAYS CORRECT.
 * `pin` is the provider preference that was SENT with the failed request, and it
 * exists because of a measured misdiagnosis: `ACUVO_PROVIDER_ORDER=DeepSeek`
 * returns HTTP 404, and the 404 branch below told the reader to check
 * `OPENROUTER_CODEGEN_MODEL` against the model catalogue. The model was fine.
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
    /**
     * ⭐ THE UPSTREAM THAT ACTUALLY SERVED IT. OpenRouter puts the serving
     * provider's name on the response body next to `model`, and this function
     * discarded every top-level field it did not name — so the one fact that
     * distinguishes "our prefix regressed" from "we were routed to a cold
     * instance" arrived on every call and was thrown away. Absent stays null:
     * a provider that does not report it is unknown, not "unpinned".
     */
    provider: typeof body?.provider === 'string' && body.provider ? body.provider : null,
  };
}

/**
 * ── ⭐⭐ DID THE PIN TAKE? ────────────────────────────────────────────────────
 *
 * ⚠️ THE DEFECT THIS ANSWERS, MEASURED 2026-08-14: `ACUVO_PROVIDER_ORDER=DeepSeek`
 * returns HTTP 404 "No endpoints found" when it is sent alone — and with
 * `allow_fallbacks: true` (which stays true, see the payload) OpenRouter does not
 * error on an `order` list it cannot honour. It treats it as an empty preference
 * and routes at random. So a pin has THREE outcomes, not two: honoured, rejected
 * loudly, and **accepted, ignored, billed** — and the third was indistinguishable
 * from the first at every layer of this CLI. The measured cost of not knowing:
 * 46.7% hit rate instead of 95.8%, i.e. roughly 2.4× the bill, with no symptom.
 *
 * ⚠️ THE COMPARISON IS CASE-INSENSITIVE ON PURPOSE. The catalogue writes
 * `DeepInfra`; people type `deepinfra`. A pin that "did not take" because of a
 * capital letter would be a false alarm, and one false alarm is all it takes for
 * the real one to be ignored.
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
 * against `order: [StreamLake, Baidu, GMICloud]`:
 *
 *     served by StreamLake (first choice)   11,520 of 11,714 cached  98.3%  $0.000172
 *     served by Baidu      (second choice)        0 of 11,714 cached   0.0%  $0.000791
 *
 * **4.6× on one round, for the same bytes**, and every layer of this CLI called
 * it `pinTook: 1, pinMissed: 0` — a healthy reading. Over 40 pinned calls the
 * scatter measured StreamLake 38, Baidu 2, so this is a ~5% event that nothing
 * could see and nothing could name.
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
 * ── ⚠️ THE DEFAULT PIN IS THE OWNER'S DECISION, NOT THIS FILE'S ─────────────
 *
 * Empty = today's behaviour exactly: no `provider` field is sent and routing is
 * whatever OpenRouter chooses. Naming a provider here would make a specific third
 * party our default route for every request this package makes — a commercial
 * decision, not an engineering one, so it is left switched off with the switch in
 * plain sight.
 *
 * ⭐ TO TURN IT ON: set this string to a provider name (measured best on
 * 2026-08-14: `'DeepInfra'` — 73.7% and 95.8% hit rates against 46.7% and 48.6%
 * unpinned on the identical 4-round task). `ACUVO_PROVIDER_ORDER` still overrides
 * it per-run, and `pinOutcome` above now makes a pin that does not take visible
 * rather than silent, which is what makes flipping this safe to try.
 */
/**
 * ── ⭐⭐ THE PIN IS ON, AND IT IS THE WHOLE CACHING STORY ────────────────────
 *
 * 28 upstream endpoints serve this model. A prompt cache lives on ONE instance,
 * so unpinned we are re-routed across all of them and the cache is cold more
 * often than not. MEASURED 2026-08-14, same task, same day:
 *
 *     unpinned   48.6% and 46.7% cache hit   $0.002217/task
 *     pinned     73.7% and 95.8% cache hit   $0.000910/task    2.4x cheaper
 *
 * And an isolated probe of three identical calls: unpinned went Relace →
 * GMICloud → GMICloud and only hit 97.1% on the third BY LUCK; pinned, every
 * call after the first hit 97.1%.
 *
 * ── ⭐ WHY THIS PROVIDER, RANKED BY THE ONLY NUMBER THAT MATTERS ────────────
 *
 * Not the headline per-token price — the EFFECTIVE cost at our real cache rate
 * (95.8%) on our real blend (90% input). Measured live from the endpoint feed:
 *
 *     StreamLake   $0.0327/M      DeepInfra   $0.0348/M
 *     Baidu        $0.0327/M      DeepSeek    $0.0357/M
 *     Decart       $0.0332/M      GMICloud    $0.0373/M
 *
 * StreamLake is cheapest, and is what the bench already lands on — it hit 98%
 * cache on a real task this morning.
 *
 * ⚠️⚠️ AND THE HAZARD THE PIN CLOSES IS WORSE THAN THE PRICE SPREAD: **1 of the
 * 28 endpoints publishes no cache-read price at all.** Unpinned, a run can land
 * on the one provider that never caches anything, and nothing would say so —
 * the bill would simply be five times larger with an identical transcript.
 *
 * ⚠️ THIS IS A PREFERENCE, NOT A LOCK. `allow_fallbacks` stays true, so an
 * outage at StreamLake degrades to another endpoint rather than killing every
 * run at once. "Never single" is this package's standing rule and pinning hard
 * would trade an outage for a discount — a cheaper request that does not happen
 * is not cheaper.
 *
 * ⚠️ AND A PIN THAT DOES NOT TAKE IS REPORTED. `pinOutcome` compares what was
 * asked for against what actually served the round, because the failure mode of
 * a silent pin is a worse bill and no symptom — which is exactly how a bad pin
 * fooled a measurement here once already.
 *
 * ⭐ Override or disable with `ACUVO_PROVIDER_ORDER` (empty string = unpinned).
 */
export const DEFAULT_PROVIDER_ORDER = 'StreamLake';

/**
 * ── ⚠️⚠️ A SINGLE GLOBAL PIN IS ONLY EVER CORRECT FOR ONE MODEL ─────────────
 *
 * `DEFAULT_PROVIDER_ORDER = 'StreamLake'` was chosen by measuring FLASH, and
 * **StreamLake does not serve pro at all** — it is not among pro's 7 endpoints.
 * So every pro run asked for a provider that could not answer, the pin matched
 * nothing, `allow_fallbacks` did its job, and OpenRouter routed freely.
 *
 * MEASURED on the 13-task bench, 2026-08-15: **pro was served by GMICloud on
 * 13 of 13 runs.** Compare the two pro endpoints:
 *
 *   DeepSeek (the model's author)   in $0.435  out $0.870  cache-read $0.0036
 *   GMICloud (what we actually got) in $1.218  out $2.436  cache-read $0.1015
 *
 * ⚠️ 2.8x on tokens and **28x on cache reads**. The "pro costs 11.2x flash"
 * figure this package now quotes was measured on the most expensive pro
 * endpoint available, because nobody had pinned the cheap one. Pinned to
 * DeepSeek's own endpoint, pro's cached reads ($0.0036) are ~3.8x CHEAPER than
 * flash's ($0.0137).
 *
 * ⭐ SO THE PIN IS PER-MODEL. A provider list is a fact about a MODEL, not
 * about this package, and pretending otherwise silently unpins every model
 * except the one that was measured.
 *
 * ⚠️ EACH ENTRY IS A LIST, NOT ONE NAME. A single name plus `allow_fallbacks`
 * degrades to *anything* when that provider is down — which is how a cheap run
 * becomes an expensive one with no symptom. Two or three cheap endpoints in
 * order degrade to another CHEAP one first. Still a preference, never a lock:
 * "never single" is the standing rule and a cheaper request that does not
 * happen is not cheaper.
 *
 * Prices read from OpenRouter's per-model endpoint feed on 2026-08-15; the
 * ORDER is what matters and it is cheapest-first by in+out.
 */
/**
 * ── ⚠️⚠️ AND A NAME IN THIS TABLE IS NOT PROOF IT CAN BE REACHED ────────────
 *
 * MEASURED 2026-08-16 against the live account, `allow_fallbacks:false`, one
 * name at a time:
 *
 *     flash  StreamLake ✔   Baidu ✔   GMICloud ✔   Decart ✔   **DeepSeek ✘ 404**
 *     pro    GMICloud   ✔                          **DeepSeek ✘ 404**
 *
 * `DeepSeek` — the model's own author, the cheapest endpoint on both models,
 * `status: 0` and `uptime_last_30m: 100` in the public feed — answers **"No
 * endpoints found"** for this account on BOTH models, with or without any
 * parameter. That is an OpenRouter **data-policy exclusion**, not a typo and not
 * an outage, and it is fixed in the account settings, not here.
 *
 * ⚠️ SO PRO'S PIN HAS ALWAYS RESOLVED TO GMICloud ALONE, and every layer called
 * it `pinTook`. That is exactly the silence `pinFellBack` was added to end: pro
 * runs now say "DeepSeek did not serve N rounds" instead of nothing.
 *
 * ⭐ THE NAME STAYS ANYWAY, first. It is the right endpoint the moment the
 * policy allows it — **eff. $0.098/M against GMICloud's $0.355/M at a 98% cache
 * rate on a 90/10 blend, 3.6× cheaper** — and deleting it would quietly convert
 * a fixable account setting into a permanent 3.6× overpayment nobody remembers.
 *
 * ⚠️ WHAT WAS ACTUALLY WRONG WITH PRO'S LIST IS THAT IT WAS ONE REACHABLE NAME.
 * The rule two paragraphs up — "a single name plus `allow_fallbacks` degrades to
 * *anything*" — was being broken by the pin that had a second entry on paper.
 * With GMICloud down, pro degraded to whatever answered: SiliconFlow is
 * $0.808/M, 2.3× GMICloud. Fireworks and Cloudflare are the next-cheapest
 * REACHABLE endpoints ($0.459/M) and are named so the degradation is cheap-first.
 *
 * Prices re-read from the live endpoint feed 2026-08-16.
 */
export const PROVIDER_PIN_BY_MODEL = Object.freeze({
  // 28 endpoints. The three cheapest are within 3% of each other, and all three
  // are reachable (checked one at a time, 2026-08-16).
  'deepseek/deepseek-v4-flash-0731': Object.freeze(['StreamLake', 'Baidu', 'GMICloud']),
  // 8 endpoints, and the spread is enormous — this is the one that was costing us.
  // ⚠️ `DeepSeek` is 404 for this account (see above); GMICloud is the cheapest
  // endpoint we can actually reach, and the two after it keep the fall cheap.
  'deepseek/deepseek-v4-pro-0813': Object.freeze(['DeepSeek', 'GMICloud', 'Fireworks', 'Cloudflare']),
  // Exactly one endpoint; pinning it changes nothing today and states the fact.
  'qwen/qwen3.7-flash': Object.freeze(['Alibaba']),
  'z-ai/glm-4.6': Object.freeze(['Venice', 'DeepInfra']),
});

/**
 * The provider order to ask for, given the model about to be called.
 *
 * @param {string} model
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ order: string[], source: 'env' | 'model' | 'default' | 'none' }}
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
   * PROVIDERS, and StreamLake is a fleet — so pinning the provider never pinned
   * the machine, and successive cold processes measured 65 / 98 / 31 / 98.
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
   * this file already documents that varying ("Baidu vs StreamLake on the same
   * model id"). Round 2 landing elsewhere is a cold cache no prefix discipline
   * can fix.
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
   * an inherited default: the day StreamLake has a bad ten minutes, every run
   * dies at once, which is precisely the "never single" failure this package
   * refuses to accept.
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
   * model it was measured on: `StreamLake` does not serve pro at all, so every
   * pro run asked for a provider that could not answer, matched nothing, and
   * routed freely to GMICloud at 2.8x the tokens and 28x the cache reads.
   * Measured: pro was served by GMICloud on 13 of 13 bench runs. See
   * `PROVIDER_PIN_BY_MODEL`.
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
   * REQUESTED, and "served by Decart" is only a finding next to "we asked for
   * DeepInfra". Reading `process.env` again in the loop would be the wrong fix —
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
   *   order: ['StreamLake'], allow_fallbacks: false
   *       -> "your explicit ordering takes priority", sticky routing OFF,
   *          every cold process rolls the dice inside the fleet. Measured:
   *          65 / 98 / 31 / 98.
   *   only: ['StreamLake']
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
   * provider — including `ACUVO_PROVIDER_ORDER='Novita'`, and
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
  const warmFirst = effectiveOrder.length > 0 && !effectiveStrict && retryOnPinFailure !== false;
  const attempts = warmFirst
    ? [
      { only: [effectiveOrder[0]] },
      { order: effectiveOrder, allowFallbacks: true },
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
   * and the live probe is what showed it:
   *
   *     POST api.deepseek.com/chat/completions
   *     → 402 {"message":"Insufficient Balance"}
   *
   * The key in the repo is VALID and has NO MONEY. Combined with
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
   * ⚠️ VERIFIED NOT LIVE TODAY: `DEEPSEEK_API_KEY` is absent from the Vercel
   * environment and from the shell, so nothing is broken in production right
   * now. It is a loaded trap, not a fire — and the fix belongs in before the
   * top-up that arms it, not after.
   *
   * ⭐ So the routes are now heterogeneous: the direct vendor FIRST (for the
   * cache), then the OpenRouter ladder behind it (for availability). A cold
   * answer beats no answer. The cache argument only ever applied to a call that
   * SUCCEEDED, and this fallback fires only when one did not.
   */
  const direct = directDeepSeek(model, env);
  const openRouterRoutes = attempts.map((a) => ({
    endpoint: resolveApiUrl(), key: apiKey, model,
    order: a.order ?? null, only: a.only ?? null, allowFallbacks: a.allowFallbacks, direct: false,
  }));
  const routes = direct
    ? [{ endpoint: direct.url, key: direct.apiKey, model: direct.model, order: null, only: null, allowFallbacks: true, direct: true }, ...openRouterRoutes]
    : openRouterRoutes;

  let res = null;
  let transportFail = null;

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
     * — it cannot remove it. So a direct call was shipping
     * `provider: { order: ['StreamLake', ...] }` to an API that has never heard
     * of StreamLake. Caught by printing the wire body rather than trusting the
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
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      transportFail = { ok: false, error: describeTransportError(err, timeoutMs), kind: transportErrorKind(err) };
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
      return r.ok ? { ok: true, ...r, model, providerPin } : { ok: false, error: r.error, providerPin };
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
      return { ok: false, error: describeTransportError(err, timeoutMs), kind: transportErrorKind(err) };
    }
    if (!collected.ok) return { ok: false, error: collected.error };
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
  }
  const reply = extractReply(body);
  if (!reply.ok) return { ok: false, error: reply.error };
  return { ok: true, ...reply, model, providerPin };
}
