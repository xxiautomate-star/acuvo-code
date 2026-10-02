/**
 * ── ⭐⭐ THE NATIVE HALF — WHAT MAKES THIS NOT ANOTHER TERMINAL CODER ─────────
 *
 * Roman: *"whether it's builder or Acuvo Code, we need to provide an exceptional
 * product... it also natively has image/video gen and other stuff."*
 *
 * The strategic argument for this file, stated honestly because it has a real
 * counter-argument: a critique we took seriously says media in a coding CLI is
 * feature bloat, and for a backend engineer refactoring a service **it is**.
 *
 * ⭐ THE DISCRIMINATOR IS NOT "IS MEDIA USEFUL" BUT "DOES THE THING YOU ARE
 * BUILDING NEED ASSETS." A landing page, a product site, an app with a hero and
 * empty states needs images every single time — and today that is a context
 * switch to another tool, another tab, another subscription, a download and a
 * file move. Claude Code cannot put an image on a page. Measured, not asserted.
 *
 * ── ⭐ AND THE ONE THAT IS ACTUALLY UNIQUE: `see_page` ───────────────────────
 * Every other terminal agent is BLIND. It writes a page and has no idea what it
 * looks like — no other coding CLI can render its own output and read the
 * result back. We already own that engine (`acuvo-render-audit` on Modal,
 * verified live 2026-08-10), and it is the difference between "I wrote some
 * HTML" and "I looked at it and the footer heading is invisible".
 *
 * ⚠️ IF ONLY ONE THING IN THIS FILE SURVIVES, IT SHOULD BE THAT ONE. Image
 * generation is a convenience others could copy in a week. Sight is a loop.
 *
 * ── ⚠️⚠️ BUT DO NOT SAY "NOBODY ELSE CAN SEE". IT IS FALSE, AND IT WAS IN THE
 * README (corrected 2026-08-10) ──────────────────────────────────────────────
 * Screenshot tooling is not scarce. Playwright MCP and Chrome DevTools MCP are
 * free, first-party and one install away; some agents ship a browser natively.
 * A pitch built on "we can see and they cannot" dies the first time a customer
 * types `claude mcp add playwright`, and it makes everything else we claim
 * suspect.
 *
 * ⭐ THE DEFENSIBLE CLAIM IS THE RETURN VALUE, NOT THE BROWSER. They hand the
 * model a PNG — 15k-25k tokens — and ask it to interpret its own screenshot,
 * which is the thing models are worst at. This measures in code and returns
 * ~200 tokens of ordered, specific defects, and `findingsFrom` ABSTAINS rather
 * than guessing. That is a software edge, it is real, and it is reproducible by
 * a competent developer in a weekend — so it buys a head start, never a moat.
 * Price and pitch accordingly.
 *
 * ── ⚠️ THE DEPENDENCY RULE THIS FILE MUST NOT BREAK ─────────────────────────
 * `acuvo-code/` is zero-dependency and must never import from `console/`. These
 * are plain HTTPS calls to endpoints whose URLs come from the environment. The
 * moment this file imports upward, the CLI stops being installable on its own —
 * which is the whole point of it being a separate package.
 *
 * ── ⚠️ AND THE HONESTY RULE, WHICH THIS REPO KEEPS RELEARNING ───────────────
 * A tool is OFFERED only when its endpoint is configured. `console/lib/
 * capabilities.ts` decides "live" by checking that an env var is non-empty, and
 * on 2026-08-10 that had the product advertising image generation while every
 * image path was dead. Presence answers "is it configured"; only a request
 * answers "does it work". So: absent config → the tool is never mentioned;
 * present config → the tool exists and its FAILURES ARE REPORTED VERBATIM
 * rather than smoothed into "something went wrong".
 */

// ⚠️ readFileSync IMPORTED, NOT require()'d. This is an .mjs module — my first
// draft called require('node:fs') inline, which throws "require is not defined"
// in ESM. It would have failed at RUNTIME, in the one branch a unit test with a
// stubbed fetch never reaches.
import { writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { splitSlides } from './document-pages.mjs';
import { resolveInWorkspace } from './workspace.mjs';
// ⭐ Engine choice for `speak`. Ids and names only — no prices live in this
// package; see creative-engines.mjs's header for why that is load-bearing.
import {
  checkEngine, runEngineFor,
  renderEndpoint, speakEndpoint, transcribeEndpoint,
  documentEndpoint, docReadEndpoint, tableReadEndpoint,
} from './creative-engines.mjs';
import { readAccount } from './account.mjs';

/**
 * ⚠️ A CAP AND AN ALLOWED SET FOR `transcribe`, because its sibling `speak` had
 * both and this had neither (ENTERPRISE §3.6). 25MB is roughly a 25-minute
 * recording — past that the right move is to split the file, not to pay for a
 * 200MB upload the model asked for by mistake.
 */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
export const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.webm', '.mp4', '.mov']);
import { throughBreaker, deadReason, skipMessage } from './breaker.mjs';
/**
 * ⭐ THE ONLY IMPORT THIS FILE NEEDED TO STOP BEING FREE. Every media verb goes
 * through `postJson` below, so one charge at that choke point meters all six —
 * see_page, speak, transcribe, make_document, read_document, read_table. Wiring
 * them one by one is how five get done and the sixth is found months later.
 */
import { chargeGpu } from './budget.mjs';

/** Long enough for a cold Modal container; short enough to not hang a session. */
const DEFAULT_TIMEOUT_MS = 180_000;
/** A render is a screenshot round trip — slower than the rest. */
const RENDER_TIMEOUT_MS = 240_000;

/**
 * Which media endpoints this install can actually reach.
 *
 * ⚠️ READ FROM `env` AT CALL TIME, never captured at import. A test must be able
 * to hand in a different environment, and a long-running session must see a
 * variable that changed — the module-level snapshot version of this is how a
 * capability silently stays dark after it was fixed.
 */
/**
 * ── ⭐⭐ THE MULTIMODAL HALF, REACHABLE BY DEFAULT ──────────────────────────
 *
 * MEASURED 2026-08-12, all eight endpoints probed concurrently: every one is
 * LIVE. A `405 Method Not Allowed` on a GET is the healthy answer from a
 * POST-only service, and reading it as a failure is how a working stack gets
 * reported as broken.
 *
 *   tts 405 · transcribe 405 · document-press 405 · video-render 405
 *   voice-clone 405 · avatar 405 · face-gateway 404 · image-engine 404
 *
 * ⚠️⚠️ AND YET `--doctor` SAID DARK. Not because anything was down — because a
 * fresh install has no `MODAL_*_URL` set, so the capability existed, worked,
 * and was unreachable by anyone who had not been told the URLs. That is the
 * same failure this repo has now hit five times: BUILT IS NOT WIRED, and a
 * capability only the author can reach has not shipped.
 *
 * ⭐ So the URLs are baked in, exactly as `DEFAULT_ENGINE_URL` is for images.
 * One secret turns on speech, transcription and documents together — an agent
 * that can SEE (read_image), HEAR, SPEAK and PRINT, out of the box.
 *
 * ⚠️ IT STILL FAILS SHUT. These are PAID GPU services: with no secret the
 * config is dark, because a missing credential must never mean "open to
 * everyone" on something that bills per second. An explicit empty string still
 * means OFF — someone who sets `MODAL_TTS_URL=` on an air-gapped machine made a
 * decision, and silently reinstating our endpoint would override it.
 */
export const DEFAULT_TTS_URL = 'https://xxiautomate-star--acuvo-tts-tts.modal.run';
export const DEFAULT_TRANSCRIBE_URL = 'https://xxiautomate-star--acuvo-transcribe-transcribe.modal.run';
export const DEFAULT_PRESS_URL = 'https://xxiautomate-star--acuvo-document-press-press.modal.run';
/**
 * ── ⭐⭐ THE INPUT HALF. EVERYTHING ABOVE IS AN OUTPUT ───────────────────────
 *
 * Measured 2026-08-12 against the live Modal account: 24 apps deployed, 13
 * wired, **11 unreachable** — deployed, healthy, paid for, and named by nothing
 * any client reads. `acuvo-doc-read` and `acuvo-table-read` were two of them.
 *
 * ⭐ AND THEY ARE THE TWO THAT CHANGE WHAT THIS AGENT *IS*. Read the list of
 * what it already had: speak, transcribe, make_document, see_page, generate
 * image. Every one is something it EMITS. Nothing anywhere took an artefact a
 * person hands over and turned it into something the model can reason about.
 * "Build me the quote form from this PDF" was not a task this CLI could accept.
 *
 * ⚠️ TWO SERVICES, NOT ONE, AND THE SECOND IS NOT AN UPGRADE OF THE FIRST.
 * `read_document` gets text out of anything (pdf · docx · xlsx · pptx · csv ·
 * html · png/jpg, OCR'd when there is no text layer). `read_table` recovers the
 * GRID from a picture of a table, which OCR destroys — see the note on
 * `TABLE_ADVICE` below, which is the whole reason both exist.
 */
export const DEFAULT_DOC_READ_URL = 'https://xxiautomate-star--acuvo-doc-read-read.modal.run';
export const DEFAULT_TABLE_READ_URL = 'https://xxiautomate-star--acuvo-table-read-extract.modal.run';

/**
 * ⭐ THE NAMES THIS MODULE ACCEPTS FOR THE SHARED SECRET, EXPORTED so nothing
 * else has to guess them. `doctor.mjs` hard-coded `ACUVO_MEDIA_SECRET`, went
 * looking for it in a neighbouring env file, found nothing, and reported the
 * capability as unfixable — while the credential sat in the same file under the
 * other accepted name. Fourth time in one day that a constant naming another
 * module's strings was a guess until something compared them.
 */
export const MEDIA_SECRET_ENV_NAMES = Object.freeze(['ACUVO_MEDIA_SECRET', 'MODAL_VIDEO_SECRET']);

export function mediaConfig(env = process.env) {
  const url = (k) => env[k]?.trim() || null;
  const secret = env.ACUVO_MEDIA_SECRET?.trim() || env.MODAL_VIDEO_SECRET?.trim() || null;

  /**
   * ⚠️ `k in env` DISTINGUISHES "UNSET" FROM "DELIBERATELY EMPTY". Unset means
   * "use ours"; an explicit empty string means "off". Collapsing the two is how
   * a deliberate opt-out becomes a surprise network call.
   */
  const withDefault = (k, fallback) => {
    if (k in env && (env[k] ?? '').trim() === '') return null;
    return url(k) || (secret ? fallback : null);
  };

  return {
    render: url('RENDER_AUDIT_URL') || url('MODAL_RENDER_AUDIT_URL'),
    speak: withDefault('MODAL_TTS_URL', DEFAULT_TTS_URL),
    transcribe: withDefault('MODAL_TRANSCRIBE_URL', DEFAULT_TRANSCRIBE_URL),
    document: withDefault('MODAL_PRESS_URL', DEFAULT_PRESS_URL),
    docRead: withDefault('MODAL_DOC_READ_URL', DEFAULT_DOC_READ_URL),
    tableRead: withDefault('MODAL_TABLE_READ_URL', DEFAULT_TABLE_READ_URL),
    secret,
  };
}

/**
 * ── 🚪⭐⭐ WHERE A RENDER ACTUALLY GOES ──────────────────────────────────────
 *
 * Two ways in, in this order:
 *   1. `RENDER_AUDIT_URL` — that is US, or somebody running their own renderer.
 *      It keeps working exactly as before and never touches the gateway.
 *   2. the signed-in Acuvo account — `<gateway>/render`, bearer token, and the
 *      shared Modal secret stays on the server where it belongs.
 *
 * ⚠️ RETURNS null WHEN NEITHER EXISTS, so the caller can say something useful
 * instead of attempting a request it cannot authenticate.
 */
/**
 * The second way in, for any of the media doors. Null when nobody is signed in.
 *
 * ⚠️ `home` IS THREADED, NOT DEFAULTED TO `homedir()` HERE. `readAccount`'s own
 * default is the real home, and passing it explicitly would be identical — but
 * an explicit `undefined` must NOT become an explicit `homedir()` at this layer,
 * because a test that hands in a throwaway HOME has to be able to reach
 * `readAccount`'s signature untouched. A sibling test printed a live
 * `xxi_live_…` token into its own failure output before this was threaded.
 */
function accountRoute(endpointFor, env, home) {
  const account = readAccount(env, ...(home === undefined ? [] : [home]));
  const token = account?.token?.trim?.() || null;
  const url = token ? endpointFor(account.gatewayUrl) : null;
  return url ? { direct: false, url, token } : null;
}

export function renderVia(cfg, env = process.env, home = undefined) {
  if (cfg?.render) return { direct: true, url: cfg.render };
  return accountRoute(renderEndpoint, env, home);
}

/**
 * ── 🚪⭐⭐⭐ THE SAME TWO WAYS IN, FOR SPEECH AND FOR HEARING ────────────────
 *
 * ⚠️ MEASURED 2026-08-26, and it is `--design`'s bug repeating twice. Both flags
 * looked configured — `mediaConfig()` hands out `DEFAULT_TTS_URL` and
 * `DEFAULT_TRANSCRIBE_URL` without anyone setting a variable — and then gated
 * them on `secret`, which resolves ONLY from `ACUVO_MEDIA_SECRET` /
 * `MODAL_VIDEO_SECRET`. Those are our internal Modal credentials. A customer who
 * has paid for a plan cannot obtain them, so `voiceConfig()` answered
 * `canSpeak: false, canListen: false` for every one of them and both flags
 * printed a message naming a variable they could never usefully set.
 *
 * ⭐ SO THE ACCOUNT IS THE SECOND WAY IN, in this order:
 *   1. a local URL + secret — that is US, or somebody running their own worker.
 *      It keeps working byte-identically and never touches the gateway.
 *   2. the signed-in Acuvo account — `<gateway>/speak`, `<gateway>/transcribe`,
 *      bearer token, and the shared Modal secret stays on the server.
 */
export function speakVia(cfg, env = process.env, home = undefined) {
  if (cfg?.speak) return { direct: true, url: cfg.speak };
  return accountRoute(speakEndpoint, env, home);
}

export function transcribeVia(cfg, env = process.env, home = undefined) {
  if (cfg?.transcribe) return { direct: true, url: cfg.transcribe };
  return accountRoute(transcribeEndpoint, env, home);
}

/**
 * ── 🚪⭐⭐⭐ AND THE SAME TWO WAYS IN FOR THE THREE MODEL-FACING VERBS ───────
 *
 * ⚠️ THESE ARE THE ONES A HUMAN NEVER TYPES, WHICH IS WHY THEY WERE LAST. The
 * previous pass fixed `--design`, `--say` and `--task-audio` and left these
 * three, and it was right to: `mediaToolSchemas` withholds a tool whose service
 * is absent, so opening that gate without a route would have OFFERED THREE VERBS
 * THAT COULD ONLY FAIL — the exact anti-pattern this file's header forbids, and
 * the reason a per-tool gate needed six routes rather than three.
 *
 * ⭐ Same order as their siblings: a local worker wins and never touches the
 * gateway; otherwise the signed-in account, with the shared Modal secret staying
 * on the server. Null when neither exists, so the caller can say something
 * useful instead of attempting a request it cannot authenticate.
 */
export function documentVia(cfg, env = process.env, home = undefined) {
  if (cfg?.document) return { direct: true, url: cfg.document };
  return accountRoute(documentEndpoint, env, home);
}

export function docReadVia(cfg, env = process.env, home = undefined) {
  if (cfg?.docRead) return { direct: true, url: cfg.docRead };
  return accountRoute(docReadEndpoint, env, home);
}

export function tableReadVia(cfg, env = process.env, home = undefined) {
  if (cfg?.tableRead) return { direct: true, url: cfg.tableRead };
  return accountRoute(tableReadEndpoint, env, home);
}

/**
 * ── 🚪⭐⭐⭐ ALL SIX DOORS, ONE ACCOUNT READ ─────────────────────────────────
 *
 * ⚠️ THIS EXISTS BECAUSE THE OFFER IS COMPUTED PER TURN, NOT PER RUN.
 * `mediaToolSchemas` asks all six questions every time the tool list is
 * assembled, and calling the six `*Via` helpers would open and parse
 * `~/.acuvo/credentials.json` six times per turn to learn the same fact. The
 * read is LAZY as well as shared: a machine with all six local workers
 * configured never touches the credential file at all.
 *
 * ⭐ AND IT IS WHAT MAKES THE GATE PER-TOOL RATHER THAN GLOBAL. The previous
 * pass could not open this gate because three of the six had no gateway route —
 * one boolean would have made `make_document`, `read_document` and `read_table`
 * *offered and broken*, which costs a round to discover what a schema could have
 * said for free. Six independent answers means a machine with, say, only
 * `RENDER_AUDIT_URL` and no account offers exactly `see_page` and nothing else.
 */
export function mediaRoutes(cfg, env = process.env, home = undefined) {
  let account;
  let read = false;
  const acct = () => {
    if (!read) {
      read = true;
      account = readAccount(env, ...(home === undefined ? [] : [home]));
    }
    return account;
  };
  const gate = (local, endpointFor) => {
    if (local) return { direct: true, url: local };
    const a = acct();
    const token = a?.token?.trim?.() || null;
    const url = token ? endpointFor(a.gatewayUrl) : null;
    return url ? { direct: false, url, token } : null;
  };
  return {
    render: gate(cfg?.render, renderEndpoint),
    speak: gate(cfg?.speak, speakEndpoint),
    transcribe: gate(cfg?.transcribe, transcribeEndpoint),
    document: gate(cfg?.document, documentEndpoint),
    docRead: gate(cfg?.docRead, docReadEndpoint),
    tableRead: gate(cfg?.tableRead, tableReadEndpoint),
  };
}

/**
 * ── ⚠️⚠️ A CEILING THAT ONLY EXISTS ON THE GATEWAY LEG ──────────────────────
 *
 * `MAX_TRANSCRIBE_BYTES` (25 MB) is right for the DIRECT path: the file goes
 * straight to a Modal worker whose own limit is far higher. It is wrong for the
 * gateway, which rides a serverless request body capped near 4.5 MB — and
 * base64 inflates by a third, so ~3 MB of audio is the real ceiling.
 *
 * ⚠️ REFUSED HERE, WITH THE NUMBER, RATHER THAN DISCOVERED AS A PLATFORM 413.
 * That failure arrives with no body at all: the customer sees a bare error, we
 * log nothing, and the obvious conclusion ("transcription is broken") is wrong.
 * A voice memo — the actual use case for `--task-audio` — is a couple of minutes
 * and lands comfortably inside this.
 */
export const MAX_GATEWAY_TRANSCRIBE_BYTES = 3 * 1024 * 1024;

/**
 * ⚠️ THE SAME CEILING, FOR A DOCUMENT OR A PHOTOGRAPH OF ONE, and it is nearly
 * SEVEN TIMES SMALLER than the direct-path limit beside it. `MAX_DOC_UPLOAD_BYTES`
 * is 20 MB, which is right when the file goes straight to a Modal worker whose
 * own ceiling is 100 MB, and badly wrong for a serverless request body.
 *
 * ⭐ ONE NUMBER, NOT THREE. The constraint is the PLATFORM'S body limit, so it is
 * identical for a WAV, a PDF and a phone photo of an invoice — three separately
 * chosen constants would drift the first time one was tuned, and the thing they
 * describe cannot drift. `console/lib/cli-media-gateway.ts` states the same
 * number on the other side, and both refusals name it.
 */
export const MAX_GATEWAY_UPLOAD_BYTES = MAX_GATEWAY_TRANSCRIBE_BYTES;

/**
 * POST JSON with a bound timeout. Never throws — a failure is data.
 *
 * ── ⭐⭐ AND IT IS WHERE THE MONEY IS COUNTED ────────────────────────────────
 *
 * Every one of these endpoints is a metered Modal container, and until this
 * change not one of them charged anything: `grep -n costUsd lib/media.mjs`
 * returned NOTHING. `--budget`, `--fleet-budget` and `acuvo spend` all priced a
 * run off model tokens alone, so a task that rendered four pages and printed a
 * PDF reported the cost of the sentences describing it.
 *
 * ⚠️ THE CHARGE LANDS AFTER A RESPONSE, NOT AFTER A REQUEST, and the difference
 * is a real dollar. A container that answered — even with `HTTP 500`, even with
 * `{ok:false,"unauthorised"}` — booted, ran and billed. A connection that never
 * got a reply (DNS failure, the endpoint is gone) started nothing, and charging
 * it $0.04 of cold-start for a request that never arrived would be a guard that
 * bills correct work. So: response ⇒ charge, no response ⇒ nothing, breaker
 * skip ⇒ nothing (there was no call at all).
 */
async function postJson(url, body, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, label = 'the service', verb = null, headers = null } = {}) {
  /**
   * ⚠️ THE BREAKER IS CHECKED BEFORE THE REQUEST, for the reason set out in
   * breaker.mjs: these timeouts are 180-240s, and a session budget is measured
   * in minutes. Two waits on a dead endpoint is the whole run.
   */
  const already = deadReason(url);
  if (already) return { ok: false, error: skipMessage(label, url) };
  /**
   * ⚠️ WALL CLOCK, NOT A TABLE OF DURATIONS. The seconds are the one part of a
   * GPU price we can actually measure from here, so they are measured; only the
   * $/second and the cold-start allowance come from a table. A table of guessed
   * durations on top of a table of guessed rates would be a number with nothing
   * real in it at all.
   *
   * ⚠️ AND A MISSING `verb` FALLS BACK TO THE LABEL RATHER THAN TO FREE. A
   * future call site that forgets the option is then merely priced coarsely
   * (unknown verbs default to the expensive GPU class), instead of silently
   * reopening the exact hole this closes.
   */
  const startedAt = Date.now();
  try {
    const res = await throughBreaker(url, label, () => fetchImpl(url, {
      method: 'POST',
      // ⚠️ Caller headers go LAST so an authorization header cannot be
      // silently dropped by the default block, and content-type cannot be
      // overridden into something the services do not parse.
      headers: { ...(headers ?? {}), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }));
    chargeGpu({ verb: verb || label, seconds: (Date.now() - startedAt) / 1000, endpoint: url });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON — keep the text */ }
    if (!res.ok) {
      /**
       * ⚠️ THE BODY IS INCLUDED, NOT JUST THE STATUS. "HTTP 502" sent a whole
       * afternoon guessing; the body said `Executable doesn't exist at
       * /ms-playwright/chromium-1234` and named the bug outright. A model given
       * another round can act on the second and can do nothing with the first.
       */
      /**
       * ── ⚠️⚠️ AND `error` IS NOT ALWAYS A STRING. MEASURED 2026-08-26 ────────
       *
       * A Modal worker answers `{ "error": "no html supplied" }`. THE ACUVO
       * GATEWAY answers `{ "error": { "message": …, "code": … } }` — the shape
       * every route in `app/api/cli/v1/` uses, and the same shape
       * `chat/completions` has always used. `.toString()` on that object
       * produces the literal text **"[object Object]"**, so from the day the
       * gateway routes shipped, EVERY server-side failure a paying customer hit
       * arrived as `HTTP 503: [object Object]`.
       *
       * ⭐ FOUND BY DRIVING THE REAL ROUTE, NOT BY READING IT. Both packages'
       * unit tests stub the WORKER, so both saw the flat string and neither
       * could see this; `console/lib/media-tools-reach-the-cli.test.ts` calls the
       * actual handler and it failed on the first run. It is the same lesson the
       * routes themselves record about verbatim payloads, arriving from the other
       * direction: the shape you did not write is the one that breaks you.
       *
       * ⚠️ THIS FIXES `--design`, `--say` AND `--task-audio` TOO. They shipped
       * their gateway legs before this file did and inherited the same reader.
       */
      const detail = json?.error;
      const said = typeof detail === 'string'
        ? detail
        : (typeof detail?.message === 'string' ? detail.message : null);
      return { ok: false, error: `HTTP ${res.status}: ${(said ?? text ?? '').toString().slice(0, 400)}` };
    }
    /**
     * ── ⚠️⚠️ A 200 THAT MEANS FAILURE ──────────────────────────────────────
     *
     * `res.ok` answers a question about the HTTP conversation, never about
     * whether the work happened. These services answer 200 and put the verdict
     * in the BODY: `{ ok: false, error: "unauthorised" }`. Without this branch
     * the caller got `{ ok: true }`, looked for its payload key, did not find
     * one, and INVENTED a message of its own.
     *
     * MEASURED 2026-08-11 against the live TTS endpoint:
     *   POST {text}          -> 200 {"ok":false,"error":"unauthorised"}
     *   POST {text, secret}  -> 200 {"ok":true,"audio":"UklGRlRW…"}  (116 KB WAV)
     *
     * The service named the problem exactly — one missing credential — and the
     * agent was told "the speech service returned no audio". It then retried
     * FOUR times and spent six rounds on a call that could never succeed.
     *
     * ⭐ AN ERROR STRING IS AN INSTRUCTION. "returned no audio" reads transient,
     * so retrying is the rational response; "unauthorised" reads like
     * configuration, and nothing retries that. The wrong string did not merely
     * fail to inform — it BOUGHT the retries.
     *
     * ⚠️ Only an EXPLICIT `ok: false` counts. Several of these services answer
     * success with no `ok` field at all, so treating "absent" as failure would
     * take every media tool down at once.
     */
    if (json && json.ok === false) {
      const detail = String(json.error ?? 'the service reported a failure with no reason').slice(0, 400);
      const auth = /unauthoris|unauthoriz|forbidden|invalid secret|401|403/i.test(detail)
        ? ' — set MODAL_VIDEO_SECRET to the value this endpoint expects (retrying will not help)'
        : '';
      return { ok: false, error: `${label} refused the request: ${detail}${auth}` };
    }

    return { ok: true, json: json ?? {}, text };
  } catch (err) {
    const code = err?.cause?.code || err?.name || 'unknown';
    const hint = code === 'TimeoutError'
      ? ' (the endpoint may be cold-starting — try once more)'
      : '';
    return { ok: false, error: `could not reach the service: ${code}${hint}` };
  }
}

/** Write text into the workspace, through the workspace's own rules. */
function writeText(root, rawPath, text) {
  const target = resolveInWorkspace(root, rawPath, 'write');
  if (!target.ok) return { ok: false, error: target.reason };
  mkdirSync(dirname(target.absolute), { recursive: true });
  writeFileSync(target.absolute, String(text ?? ''), 'utf8');
  return { ok: true, path: target.relative, bytes: Buffer.byteLength(String(text ?? '')) };
}

/**
 * ── ⭐⭐ FETCH A RUNNING PAGE AND EVERYTHING IT NEEDS TO LOOK RIGHT ──────────
 *
 * The render service takes HTML, not a URL — measured, it answers
 * `{"ok":false,"error":"no html supplied"}` — so the page and its assets are
 * fetched here and inlined exactly as a file's would be.
 *
 * ⭐ TWO PASSES, SO THE TRAVERSAL IS NOT DUPLICATED. `inlineLocalAssets` already
 * knows which tags matter, what the size caps are, and how to report what it
 * could not resolve. Its resolver is synchronous and fetching is not, so pass
 * one runs with a RECORDING resolver that returns null and notes every URL
 * asked for; the assets are fetched; pass two runs with a Map. Re-implementing
 * those regexes for the URL case is exactly how the two paths would drift.
 *
 * ⚠️ AN ASSET THAT WILL NOT LOAD IS REPORTED, NOT HIDDEN. A stylesheet that
 * 404s is the single most valuable finding this tool produces — without it the
 * page has no design and every visual check silently passes.
 */
export async function fetchServedPage(url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const get = async (target) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(String(target), { signal: ac.signal, redirect: 'follow' });
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, buf: Buffer.from(await r.arrayBuffer()) };
    } catch (err) {
      return { ok: false, error: err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err?.message ?? String(err)) };
    } finally {
      clearTimeout(timer);
    }
  };

  const page = await get(url);
  if (!page.ok) {
    return {
      ok: false,
      error: page.status
        ? `the server at ${url.href} answered HTTP ${page.status} — nothing was rendered`
        : `could not reach ${url.href}: ${page.error}. Is the server still running? check_process will say.`,
    };
  }
  const html = page.buf.toString('utf8');

  // Pass 1 — record what the page asks for, without fetching anything.
  const wanted = [];
  inlineLocalAssets('', '', html, { absolute: true, resolveImpl: (u) => { wanted.push(u); return null; } });

  // Fetch each one against the page's own origin.
  const got = new Map();
  const unreachable = [];
  for (const raw of [...new Set(wanted)].slice(0, 40)) {
    let assetUrl;
    try { assetUrl = new URL(raw, url); } catch { unreachable.push(`${raw} is not a resolvable url`); continue; }
    const a = await get(assetUrl);
    if (a.ok) got.set(raw, a.buf);
    else unreachable.push(`"${raw}" could not be fetched from the server${a.status ? ` (HTTP ${a.status})` : ''}`);
  }

  // Pass 2 — the same traversal, now able to answer.
  const bundled = inlineLocalAssets('', '', html, {
    absolute: true,
    resolveImpl: (u) => (got.has(u) ? { buf: got.get(u), rel: u } : null),
  });

  return { ok: true, html: bundled.html, missing: [...unreachable, ...bundled.missing] };
}

/** Write a base64 payload into the workspace, through the workspace's own rules. */
function writeBinary(root, rawPath, base64, dryRun) {
  const target = resolveInWorkspace(root, rawPath, 'write');
  if (!target.ok) return { ok: false, error: target.reason };
  const buf = Buffer.from(base64, 'base64');
  if (!dryRun) {
    mkdirSync(dirname(target.absolute), { recursive: true });
    writeFileSync(target.absolute, buf);
  }
  return { ok: true, path: target.relative, bytes: buf.length, dryRun };
}

/**
 * ── ⚠️⚠️ INLINE THE PAGE'S OWN FILES BEFORE SENDING IT ──────────────────────
 *
 * The render service is given HTML **text**, not a directory. So
 * `<link rel="stylesheet" href="styles.css">` resolves to nothing, and a page
 * that is perfect on disk arrives at the browser completely naked.
 *
 * ⚠️ THIS WAS CAUGHT BY LOOKING, NOT BY TESTING, AND IT HAD ALREADY FOOLED THE
 * AUDIT. A generated four-page site rendered with bulleted navigation, blue
 * underlined links and broken image icons — 1994 — and `see_page` reported
 * "no measured problems" on all four pages, because every check it runs
 * (contrast, painted ratio, console errors) is genuinely fine on an unstyled
 * page. Black text on white has excellent contrast. That is a false all-clear
 * of exactly the kind this file was fixed for once already today, one layer up.
 *
 * ⭐ We hold the workspace root and the page's own path, so the siblings are
 * ours to resolve. Every asset goes through `resolveInWorkspace`, so inlining
 * can never read a file `read_file` could not.
 *
 * ⚠️ AND A REFERENCE WE CANNOT RESOLVE BECOMES A FINDING. Silently rendering
 * without the stylesheet is how the original bug stayed invisible; saying "the
 * page asked for styles.css and it is not there" is usually the actual defect.
 */
export function inlineLocalAssets(root, pageRelPath, html, { readImpl = readFileSync, resolveImpl = null, absolute = false } = {}) {
  const missing = [];
  const dir = pageRelPath.includes('/') ? pageRelPath.slice(0, pageRelPath.lastIndexOf('/')) : '';
  /**
   * Only same-workspace, non-absolute, non-remote references are ours to inline.
   *
   * ⚠️ `absolute` WIDENS THIS FOR A SERVED PAGE, and only for one. A page on
   * disk cannot resolve `/styles.css` — there is no document root, so treating
   * it as local would mean reading from the filesystem root. A page fetched over
   * HTTP resolves it perfectly well against its own origin, and root-relative
   * hrefs are what real servers emit. Same string, two meanings, decided by
   * where the page came from rather than by a guess.
   */
  const isLocal = (u) => u
    && !/^(https?:|data:|\/\/|#|mailto:|tel:)/i.test(u)
    && (absolute || !u.startsWith('/'));
  /**
   * ⭐ THE RESOLVER IS INJECTABLE so a page fetched from a running server can
   * supply its assets over HTTP instead of from the workspace. The traversal —
   * which tags count, what gets inlined, the size caps, the `missing` reporting
   * — is identical either way, and duplicating those regexes for the URL case
   * is exactly how the two paths would drift.
   */
  const resolveAsset = resolveImpl ?? ((url) => {
    const clean = url.split('?')[0].split('#')[0];
    const rel = dir ? `${dir}/${clean}` : clean;
    const t = resolveInWorkspace(root, rel, 'read');
    if (!t.ok) return null;
    try { return { buf: readImpl(t.absolute), rel: t.relative }; } catch { return null; }
  });

  let out = html;

  // 1. Stylesheets → <style>. The single most important one: without it the
  //    page has no design at all, and every visual check silently passes.
  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
    const m = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!m || !isLocal(m[1])) return tag;
    const got = resolveAsset(m[1]);
    if (!got) { missing.push(`stylesheet "${m[1]}" is linked but was not found — the page renders unstyled`); return tag; }
    return `<style>\n${got.buf.toString('utf8')}\n</style>`;
  });

  /**
   * 2. Scripts → inline. ⚠️ A module's own relative imports CANNOT survive this:
   * inlining changes the script's base URL, so `import './x.mjs'` inside it
   * still fails. Inlining the entry point is strictly better than dropping it —
   * most page scripts are self-contained — and the console error from a nested
   * import is reported rather than hidden, which is the honest outcome.
   */
  out = out.replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, pre, url, post) => {
    if (!isLocal(url)) return tag;
    const got = resolveAsset(url);
    if (!got) { missing.push(`script "${url}" is referenced but was not found`); return tag; }
    const isModule = /type\s*=\s*["']module["']/i.test(pre + post);
    return `<script${isModule ? ' type="module"' : ''}>\n${got.buf.toString('utf8')}\n</script>`;
  });

  // 3. Images → data: URIs, so "broken image" means broken and not "not sent".
  out = out.replace(/(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'])/gi, (tag, head, url, tail) => {
    if (!isLocal(url)) return tag;
    const got = resolveAsset(url);
    if (!got) { missing.push(`image "${url}" is referenced but was not found`); return tag; }
    // A megabyte of base64 per image would blow the request up for no gain.
    if (got.buf.length > 400_000) { missing.push(`image "${url}" is ${Math.round(got.buf.length / 1024)}KB — too large to preview, skipped`); return tag; }
    const ext = url.split('.').pop().toLowerCase().split(/[?#]/)[0];
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
    return `${head}data:${mime};base64,${got.buf.toString('base64')}${tail}`;
  });

  return { html: out, missing };
}

/**
 * ── ⭐ SEE A PAGE — the capability no other coding CLI has ──────────────────
 *
 * Renders local HTML in a real browser and returns what was MEASURED: the
 * screenshot, plus geometry and contrast findings. This is the thing that turns
 * "I wrote some HTML" into "I looked at it".
 */
/**
 * ── ⭐⭐ IS THIS A PAGE ON DISK, OR A SERVER THAT IS RUNNING? ────────────────
 *
 * `start_process` can start a dev server, `check_process` can prove it answers,
 * and `see_page` could only ever open a FILE — three finished halves of one
 * loop that had never been joined. A developer's normal shape is "run it and
 * look at it", and the agent could do everything except the looking.
 *
 * ⚠️⚠️ LOOPBACK ONLY, AND THIS IS THE WHOLE SECURITY ARGUMENT. `see_page` is
 * reachable by a model reading a repository we do not control, so an arbitrary
 * URL here is a request-forgery primitive: a hostile ACUVO.md could ask it to
 * fetch an internal metadata endpoint or a private host and — because the page
 * body is inlined and sent onward — read the answer back out.
 *
 * ⭐ `resolveApiUrl` in model.mjs already decided this exact question the same
 * way and for the same reason. Loopback is where the agent's OWN server lives,
 * which is the entire use case; the public web already has `fetch_url`, whose
 * output is text the model reads rather than bytes we render and store.
 *
 * ⚠️ Hostname, not substring. `http://127.0.0.1.evil.com/` contains "127.0.0.1"
 * and is not loopback; parsing and comparing the host is the only version of
 * this check that cannot be talked around.
 */
export function loopbackTarget(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return { isUrl: false };
  let u;
  try { u = new URL(s); } catch { return { isUrl: true, ok: false, reason: `not a valid URL: ${s.slice(0, 120)}` }; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) {
    return {
      isUrl: true,
      ok: false,
      reason: `see_page only opens files in the workspace or a LOOPBACK url (localhost / 127.x). `
        + `"${u.hostname}" is neither — it would let a page choose what this machine fetches. `
        + `Use fetch_url to read a public page as text.`,
    };
  }
  return { isUrl: true, ok: true, url: u };
}

/**
 * ⚠️ `home` IS THREADED FOR TESTABILITY, NOT DECORATION. `renderVia` reads the
 * account from `~/.acuvo/credentials.json`, so without an override a test's
 * result depends on whether the person running it happens to be signed in —
 * and a sibling test printed a live `xxi_live_…` token into its failure output
 * before this existed.
 */
export async function seePage(root, htmlPath, { env = process.env, fetchImpl = fetch, dryRun = false, home = undefined } = {}) {
  const cfg = mediaConfig(env);
  /**
   * ── 🚪⭐⭐⭐ A CUSTOMER HAS NO `RENDER_AUDIT_URL`, AND NEVER WILL ───────────
   *
   * ⚠️ MEASURED 2026-08-26. `--design` works and is good — on a deliberately
   * weak page it reported *"unreadable text (contrast 1.14:1, needs 4.5)"* —
   * but only after OUR internal Modal URL and secret were exported. Every
   * paying customer got "no render service is configured" and stopped.
   *
   * ⭐ SO THE ACCOUNT IS THE SECOND WAY IN. `renderVia` resolves the local
   * renderer first (that is us, and it stays free of the gateway) and otherwise
   * falls back to `<gateway>/render`, authenticated with the customer's own
   * Acuvo token. They send HTML and get a measurement; they never learn where
   * the renderer lives, and the shared Modal secret never leaves the server.
   */
  const via = renderVia(cfg, env, home);
  if (!via) {
    return {
      ok: false,
      error: 'no render service is available — sign in with `acuvo --login` so this runs on your plan, '
        + 'or set RENDER_AUDIT_URL to point at your own renderer',
    };
  }

  /**
   * ⭐ A LOOPBACK URL IS RENDERED FROM THE SERVER, NOT FROM DISK. The render
   * service will not do it for us — measured 2026-08-15, it answers
   * `{"ok":false,"error":"no html supplied"}` to a `url` field — so the CLI
   * fetches the page and its assets itself and sends the same inlined HTML it
   * would send for a file.
   */
  const asUrl = loopbackTarget(htmlPath);
  if (asUrl.isUrl) {
    if (!asUrl.ok) return { ok: false, error: asUrl.reason };
    const fetched = await fetchServedPage(asUrl.url, { fetchImpl });
    if (!fetched.ok) return fetched;

    /**
     * ⭐ THE SERVED PAGE BECOMES A FILE, AND THEN TAKES THE ORDINARY PATH.
     *
     * Everything after this point — post to the renderer, check the measurement
     * shape, write the screenshot, assemble the findings — is identical for a
     * file and for a URL. Writing the fetched bundle to disk and falling through
     * means there is exactly ONE renderer, by construction, rather than two that
     * agree today. I tried extracting a shared helper first; this is smaller,
     * has no second code path to keep in step, and leaves the exact bytes that
     * were rendered on disk where the agent can read them.
     *
     * ⚠️ `dryRun` MUST NOT WRITE. The flag promises "touch nothing", and this is
     * a real file in the user's workspace — so a dry run reports what it would
     * have looked at and stops, rather than leaving a snapshot behind.
     */
    if (dryRun) {
      return { ok: false, error: `this is a --dry-run, so ${asUrl.url.href} was not fetched or rendered` };
    }
    const snapshot = `.acuvo/served-${Date.now()}.html`;
    const written = writeText(root, snapshot, fetched.html);
    if (!written.ok) return written;

    /**
     * ⚠️ `home` RIDES INTO THE RECURSION, AND IT DID NOT BEFORE. This call
     * re-resolves the route from scratch, so a caller that named a throwaway home
     * — every test, for the reason `renderVia`'s header records — silently got the
     * REAL `~/.acuvo/credentials.json` back on the loopback-URL branch only. One
     * of two code paths obeying an isolation argument is the shape of leak that
     * printed a live `xxi_live_…` token into failure output once already.
     */
    const looked = await seePage(root, written.path, { env, fetchImpl, dryRun, home });
    if (!looked.ok) return looked;
    return {
      ...looked,
      // ⚠️ The URL is what the user asked about; the snapshot is an artefact.
      // Reporting the temp filename as "the page" would be true and useless.
      path: asUrl.url.href,
      snapshot: written.path,
      findings: [...fetched.missing, ...(looked.findings ?? [])].slice(0, 20),
    };
  }

  const target = resolveInWorkspace(root, htmlPath, 'read');
  if (!target.ok) return { ok: false, error: target.reason };

  let html;
  try {
    html = readFileSync(target.absolute, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not read ${target.relative}: ${err?.message ?? err}` };
  }

  /**
   * ⚠️ THE PAGE IS SENT WITH ITS OWN FILES IN IT. Sending the bare source
   * renders a page nobody wrote — see `inlineLocalAssets` for the four-page
   * site that passed this audit while looking like 1994.
   */
  const bundled = inlineLocalAssets(root, target.relative, html);

  /**
   * ⚠️ THE BODY AND THE HEADERS DIFFER BY ROUTE, THE ENVELOPE DOES NOT. Direct,
   * the secret rides in the JSON exactly as before. Through the gateway it is a
   * bearer token and NO secret is sent at all — putting one there would ship a
   * shared credential the customer does not have and must never receive.
   */
  const res = via.direct
    ? await postJson(via.url, { html: bundled.html, secret: cfg.secret ?? undefined },
      { timeoutMs: RENDER_TIMEOUT_MS, fetchImpl, label: 'The render service', verb: 'see_page' })
    : await postJson(via.url, { html: bundled.html },
      { timeoutMs: RENDER_TIMEOUT_MS, fetchImpl, label: 'The render service', verb: 'see_page', headers: { authorization: `Bearer ${via.token}` } });
  if (!res.ok) return res;

  /**
   * ── ⚠️⚠️ THE ENVELOPE. THIS WAS THE WORST BUG IN THE PRODUCT ───────────────
   *
   * The service replies `{ ok, measurement: { … } }`. This function used to read
   * `res.json.findings`, `res.json.viewport` and `res.json.screenshotPngB64` —
   * three keys that DO NOT EXIST at that level. So every call returned
   * `{ findings: [], viewport: null, screenshot: null, looked: true }`.
   *
   * ⚠️ AND IT FAILED IN THE CONFIDENT DIRECTION. `looked: true` with an empty
   * findings list reads as "I looked and it was fine" — so the one capability we
   * sell as our differentiator was issuing all-clears for pages it never saw.
   * Measured against the live endpoint on a deliberately broken page: the
   * service returned `lowContrastText: [{text:'invisible', ratio:1.05}]` and
   * `paintedRatio: 0.0198`, and every byte of it was discarded here.
   *
   * ⭐ SO: unwrap, and REFUSE rather than reassure when the shape is unfamiliar.
   * A service that changed its contract must break loudly. An empty findings
   * list is now only ever produced by a measurement we actually parsed.
   */
  const m = res.json?.measurement ?? res.json?.measurements ?? null;
  if (!m || typeof m !== 'object') {
    return {
      ok: false,
      error: `the render service returned a shape this version does not understand (keys: ${Object.keys(res.json ?? {}).slice(0, 8).join(', ') || 'none'})`,
    };
  }

  /**
   * ⭐ THE SCREENSHOT IS SAVED TO DISK, not just described. A path the user can
   * open is worth more than any summary, and it is also the only way THEY can
   * check whether the agent's description of its own work is true.
   */
  let shot = null;
  // Reported so the change summary can state a real size. A screenshot listed
  // as "0 bytes" reads as a failed write.
  let shotBytes = 0;
  if (m.screenshotPngB64 && !dryRun) {
    const w = writeBinary(root, `.acuvo/render-${Date.now()}.png`, m.screenshotPngB64, dryRun);
    if (w.ok) { shot = w.path; shotBytes = w.bytes; }
  }

  return {
    ok: true,
    path: target.relative,
    screenshot: shot,
    screenshotBytes: shotBytes,
    viewport: m.viewport ?? null,
    // ⚠️ Unresolvable references come FIRST: "the page asked for styles.css and
    // it is not there" explains every layout complaint underneath it, exactly
    // like a console error does.
    findings: [...bundled.missing, ...findingsFrom(m)].slice(0, 20),
    // Present even when empty, so "I looked and it was fine" is distinguishable
    // from "I could not look" — the render audit made that mistake once already.
    looked: true,
  };
}

/**
 * ── ⭐ TURN A MEASUREMENT INTO SENTENCES A MODEL CAN ACT ON ──────────────────
 *
 * The service measures; it does not judge. Judging here keeps the thresholds in
 * one reviewable place instead of inside a prompt.
 *
 * ⚠️ ORDERED BY WHAT ACTUALLY BREAKS A PAGE. A console error that stopped the
 * app booting has to be the first line the model reads — it explains every other
 * finding underneath it, and a model that fixes the contrast of a page that never
 * rendered has wasted the round.
 */
export function findingsFrom(m) {
  const out = [];

  // 1. The page did not run. Everything below is a consequence of this.
  for (const e of (m.consoleErrors ?? []).slice(0, 5)) {
    out.push(`console error: ${String(e).slice(0, 200)}`);
  }

  /**
   * 2. The page is blank. ⚠️ `paintedRatio` is the share of pixels differing
   * from the backdrop, so a legitimately minimal page scores low too — which is
   * why this reads as "almost nothing rendered" and names the number rather than
   * asserting a bug. The model has the source; it can tell which it is.
   */
  if (typeof m.paintedRatio === 'number' && m.paintedRatio < 0.05) {
    out.push(`almost nothing rendered — ${(m.paintedRatio * 100).toFixed(1)}% of the viewport differs from the backdrop`);
  }

  // 3. Text nobody can read. 4.5:1 is WCAG AA for body copy.
  for (const t of (m.lowContrastText ?? []).slice(0, 5)) {
    const ratio = typeof t?.ratio === 'number' ? t.ratio.toFixed(2) : '?';
    out.push(`unreadable text (contrast ${ratio}:1, needs 4.5): ${String(t?.text ?? '').slice(0, 80)}`);
  }

  for (const t of (m.clippedText ?? []).slice(0, 5)) {
    out.push(`text is cut off: ${String(t?.text ?? JSON.stringify(t)).slice(0, 80)}`);
  }
  for (const o of (m.overlaps ?? []).slice(0, 5)) {
    out.push(`elements overlap: ${String(o?.a ?? '?')} over ${String(o?.b ?? '?')}`.slice(0, 120));
  }
  for (const b of (m.brokenImages ?? []).slice(0, 5)) {
    out.push(`image failed to load: ${String(b?.src ?? b).slice(0, 120)}`);
  }

  // 4. Horizontal scroll — the classic responsive failure, and invisible in a
  // screenshot cropped to the viewport.
  if (typeof m.scrollWidth === 'number' && m.viewport?.width && m.scrollWidth > m.viewport.width + 1) {
    out.push(`the page scrolls sideways: content is ${m.scrollWidth}px wide in a ${m.viewport.width}px viewport`);
  }

  return out.slice(0, 20);
}

/**
 * Speak text aloud into a workspace audio file. Modal TTS (Kokoro, Apache-2.0).
 *
 * ── ⚠️⚠️ THIS IS NOT "ACUVO VOICE", AND THE OBVIOUS WIRING WOULD MISPRICE IT ─
 *
 * The catalogue's **Acuvo Voice** is `chatterbox-tts`: clone a voice from a few
 * seconds of audio and then speak in it, measured at $0.00167 a line. What this
 * function calls is `MODAL_TTS_URL` running **Kokoro**, a FIXED-voice reader
 * that clones nothing. Mapping one onto the other — which is what "speak → the
 * voice engine" looks like from a distance — would have quoted a cloning price
 * for a capability that cannot clone, and put a branded name on a different
 * model.
 *
 * ⭐ So `engine` is accepted here in order to REFUSE clearly: naming
 * `acuvo-voice` says why it is not this, and no engine name silently changes
 * which model reads your text. When the CLI can reach the cloning engine, that
 * is the day this comment changes.
 */
export async function speak(root, text, outPath, { env = process.env, fetchImpl = fetch, dryRun = false, engine = null, home = undefined } = {}) {
  /**
   * ⚠️ THE ENGINE CHECK IS FIRST, ABOVE THE CONFIG CHECK, because "you asked
   * for an engine that does not run here" is true whether or not a TTS endpoint
   * happens to be configured — and the config message would send the reader to
   * an environment variable that was never the problem.
   */
  const requested = engine ?? runEngineFor('voice');
  if (requested) {
    const choice = checkEngine('voice', requested, { env, verb: 'speak' });
    if (!choice.ok) return { ok: false, error: choice.error, code: choice.code };
  }
  const cfg = mediaConfig(env);
  /**
   * ⚠️ THE OLD LINE WAS `if (!cfg.speak) return 'no speech service is configured
   * (MODAL_TTS_URL)'`, AND IT WAS THE ONLY THING A CUSTOMER EVER SAW. See
   * `speakVia` for the measurement: the default URL is baked in, so what
   * actually fails is the SECRET — and the message named a URL variable instead.
   */
  const via = speakVia(cfg, env, home);
  if (!via) {
    return {
      ok: false,
      error: 'no speech service is available — sign in with `acuvo --login` so this runs on your plan, '
        + 'or set MODAL_TTS_URL to point at your own speech worker',
    };
  }
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'nothing to say — text is required' };
  if (text.length > 5_000) return { ok: false, error: `text is ${text.length} characters, over the 5,000 limit` };

  /**
   * ⚠️ THE BODY AND HEADERS DIFFER BY ROUTE, THE ENVELOPE DOES NOT. Direct, the
   * secret rides in the JSON exactly as before. Through the gateway it is a
   * bearer token and NO secret is sent — putting one there would ship a shared
   * credential the customer does not have and must never receive.
   */
  const res = via.direct
    ? await postJson(via.url, { text, secret: cfg.secret ?? undefined }, { fetchImpl, verb: 'speak' })
    : await postJson(via.url, { text }, { fetchImpl, verb: 'speak', headers: { authorization: `Bearer ${via.token}` } });
  if (!res.ok) return res;
  const b64 = res.json?.audioB64 ?? res.json?.audio_b64 ?? res.json?.audio;
  if (!b64) return { ok: false, error: 'the speech service returned no audio' };
  return writeBinary(root, outPath || `.acuvo/speech-${Date.now()}.wav`, b64, dryRun);
}

/** Transcribe an audio file already in the workspace. faster-whisper, MIT. */
export async function transcribe(root, audioPath, { env = process.env, fetchImpl = fetch, dryRun = false, home = undefined } = {}) {
  const cfg = mediaConfig(env);
  // ⚠️ Same correction as `speak`'s: the URL is baked in, so what a customer is
  // actually missing is the SECRET — and the old message named the URL.
  const via = transcribeVia(cfg, env, home);
  if (!via) {
    return {
      ok: false,
      error: 'no transcription service is available — sign in with `acuvo --login` so this runs on your plan, '
        + 'or set MODAL_TRANSCRIBE_URL to point at your own transcription worker',
    };
  }

  /**
   * ⚠️ A DRY RUN MUST NOT POST. `--dry-run` promises "touch nothing, run
   * nothing", and this is a base64 upload to a metered GPU service: it costs
   * egress, it costs GPU seconds, and it hands a file to a remote host. The
   * other three verbs gated only the WRITE and sent the request anyway
   * (ENTERPRISE §3.6), which made the flag a false guarantee rather than a weak
   * one — exactly the finding that closed §3.1's first half.
   */
  if (dryRun) return { ok: false, error: 'this is a --dry-run, so nothing is uploaded (transcription sends the file to a metered service)' };

  const target = resolveInWorkspace(root, audioPath, 'read');
  if (!target.ok) return { ok: false, error: target.reason };

  /**
   * ⚠️ A CAP WAS WRITTEN FOR `speak` AND OMITTED HERE. Its sibling refuses text
   * over 5,000 characters; this base64'd and POSTed ANY file in the workspace at
   * ANY size, so "transcribe node_modules/.cache/something.bin" was a 200MB
   * upload the model could ask for by accident.
   */
  let bytes;
  try {
    bytes = statSync(target.absolute).size;
  } catch (err) {
    return { ok: false, error: `could not read ${target.relative}: ${err?.message ?? err}` };
  }
  if (bytes > MAX_TRANSCRIBE_BYTES) {
    return {
      ok: false,
      error: `${target.relative} is ${(bytes / 1024 / 1024).toFixed(1)}MB, over the ${Math.round(MAX_TRANSCRIBE_BYTES / 1024 / 1024)}MB limit for transcription. `
        + 'Trim or split the audio first.',
    };
  }
  /**
   * ⚠️ AND A SECOND, SMALLER CEILING ON THE GATEWAY LEG ONLY — see
   * `MAX_GATEWAY_TRANSCRIBE_BYTES`. Checked here rather than left to the server
   * because the platform's own refusal comes back as a bare unparseable
   * response: no size, no reason, and no way for the user to know that 4 MB is
   * the line. Naming the alternative matters too — somebody who genuinely needs
   * a 20-minute recording can point at their own worker and keep the 25 MB cap.
   */
  if (!via.direct && bytes > MAX_GATEWAY_TRANSCRIBE_BYTES) {
    return {
      ok: false,
      error: `${target.relative} is ${(bytes / 1024 / 1024).toFixed(1)}MB, over the `
        + `${Math.round(MAX_GATEWAY_TRANSCRIBE_BYTES / 1024 / 1024)}MB limit for transcription through your Acuvo plan `
        + '(the upload rides in one request). Trim or split the audio, or set MODAL_TRANSCRIBE_URL to your own worker '
        + `for files up to ${Math.round(MAX_TRANSCRIBE_BYTES / 1024 / 1024)}MB.`,
    };
  }

  /**
   * ⚠️ AND AN EXTENSION CHECK, because the useful half of this refusal is
   * telling the model it pointed at the wrong FILE. Without it, a `.zip` is a
   * paid round trip that comes back "could not decode" — which reads like the
   * service is broken rather than like the argument was wrong.
   */
  if (!AUDIO_EXTENSIONS.has(extname(target.absolute).toLowerCase())) {
    return {
      ok: false,
      error: `${target.relative} is not an audio or video file (${[...AUDIO_EXTENSIONS].join(' ')}). `
        + 'Transcription needs a recording, not an arbitrary file.',
    };
  }

  let b64;
  try {
    b64 = readFileSync(target.absolute).toString('base64');
  } catch (err) {
    return { ok: false, error: `could not read ${target.relative}: ${err?.message ?? err}` };
  }

  /**
   * ── ⚠️ ONE UNDERSCORE COST THE ENTIRE VOICE LOOP ───────────────────────────
   *
   * This posted `audioB64`. The service reads `audio_b64` and says so outright:
   * `supply audio_url or audio_b64`. So the CLI could SPEAK — a real 211 KB WAV
   * — and could never hear its own output back.
   *
   * MEASURED 2026-08-11, same file both times:
   *   { audioB64 }  -> 200 {"ok":false,"error":"supply audio_url or audio_b64"}
   *   { audio_b64 } -> 200 {"ok":true,"text":"The quick brown fox jumps over the
   *                          lazy dog near the riverbank.", segments:[…]}
   *
   * ⚠️ BOTH KEYS GO, deliberately. An ignored extra key costs nothing; guessing
   * wrong costs the capability, and this endpoint has been redeployed more than
   * once. `test/transcribe-payload-contract.test.mjs` pins that they carry
   * identical bytes, so they can never drift into disagreeing about the audio.
   */
  /**
   * ⚠️ THE GATEWAY LEG SENDS ONE COPY, NOT TWO, AND THAT IS NOT A WEAKENING OF
   * THE RULE ABOVE. Sending both keys doubles a body that is already the largest
   * thing this CLI ever posts, against a request limit that is the binding
   * constraint on the whole path. `console/app/api/cli/v1/transcribe/route.ts`
   * puts BOTH keys back on the upstream request, where the bytes are already in
   * memory and the duplication is free — so the belt-and-braces survives exactly
   * where it is cheap and is dropped exactly where it costs the feature.
   */
  const res = via.direct
    ? await postJson(
      via.url,
      { audio_b64: b64, audioB64: b64, secret: cfg.secret ?? undefined },
      { fetchImpl, verb: 'transcribe' },
    )
    : await postJson(
      via.url,
      { audio_b64: b64 },
      { fetchImpl, verb: 'transcribe', headers: { authorization: `Bearer ${via.token}` } },
    );
  if (!res.ok) return res;
  return {
    ok: true,
    path: target.relative,
    text: res.json?.text ?? '',
    // ⭐ Segments, not just the blob. "What was said at 4:12" is the question
    // people actually have, and a wall of text cannot answer it.
    segments: Array.isArray(res.json?.segments) ? res.json.segments.slice(0, 200) : [],
  };
}

/** Turn HTML into a real document — PDF, PNG or PPTX. */
export async function makeDocument(root, htmlPath, outPath, format, { env = process.env, fetchImpl = fetch, dryRun = false, home = undefined } = {}) {
  const cfg = mediaConfig(env);
  /**
   * ⚠️ THE OLD LINE WAS `if (!cfg.document) return 'no document service is
   * configured (MODAL_PRESS_URL)'` — and no customer could ever act on it. The
   * URL is baked in; what actually gates it is `MODAL_VIDEO_SECRET`, OUR Modal
   * credential, so the message named a variable that would never help and the
   * tool was withheld from their model entirely.
   */
  const via = documentVia(cfg, env, home);
  if (!via) {
    return {
      ok: false,
      error: 'no document service is available — sign in with `acuvo --login` so this runs on your plan, '
        + 'or set MODAL_PRESS_URL to point at your own document worker',
    };
  }
  const fmt = String(format || 'pdf').toLowerCase();
  if (!['pdf', 'png', 'pptx'].includes(fmt)) {
    return { ok: false, error: `format must be pdf, png or pptx — got "${format}"` };
  }
  const target = resolveInWorkspace(root, htmlPath, 'read');
  if (!target.ok) return { ok: false, error: target.reason };
  let html;
  try { html = readFileSync(target.absolute, 'utf8'); }
  catch (err) { return { ok: false, error: `could not read ${target.relative}: ${err?.message ?? err}` }; }

  /**
   * ⚠️ THE BODY AND HEADERS DIFFER BY ROUTE, THE ENVELOPE DOES NOT. Direct, the
   * secret rides in the JSON exactly as before. Through the gateway it is a
   * bearer token and NO secret is sent — putting one there would ship a shared
   * credential the customer does not have and must never receive.
   */
  // ⭐ One slide section → one page. See lib/document-pages.mjs. `html` still
  // travels, so a server that predates `pages` behaves exactly as before.
  const pages = fmt === 'png' ? null : splitSlides(html);
  const payload = { html, format: fmt, ...(pages ? { pages } : {}) };
  const res = via.direct
    ? await postJson(via.url, { ...payload, secret: cfg.secret ?? undefined }, { fetchImpl, verb: 'make_document' })
    : await postJson(via.url, payload, { fetchImpl, verb: 'make_document', headers: { authorization: `Bearer ${via.token}` } });
  if (!res.ok) return res;
  const b64 = res.json?.fileB64 ?? res.json?.file_b64 ?? res.json?.data;
  if (!b64) return { ok: false, error: 'the document service returned no file' };
  const written = await writeBinary(root, outPath || `.acuvo/document-${Date.now()}.${fmt}`, b64, dryRun);
  /**
   * ⭐ SAY HOW MANY PAGES CAME BACK. A deck of 6 that returns as 1 must be
   * visible in the result, not discovered by a second tool three rounds later.
   */
  const got = Number(res.json?.pages);
  if (written && typeof written === 'object' && written.ok !== false && Number.isFinite(got)) {
    written.pages = got;
    if (pages && got !== pages.length) {
      written.warning = `sent ${pages.length} slides but the document service made ${got} page(s) — this Acuvo server does not split pages yet, so the file holds the whole page as one`;
    }
  }
  return written;
}

/* ────────────────────────────────────────────────────────────────────────────
 * READING WHAT SOMEONE HANDS YOU
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ 20 MB, WELL UNDER THE WORKER'S OWN 100 MB. The worker's ceiling is for a
 * file it FETCHES; this path sends bytes in a JSON body, where base64 inflates
 * by a third and a serverless request limit arrives long before 100 MB does.
 * Refusing at a stated number beats a 413 nobody can act on.
 */
const MAX_DOC_UPLOAD_MB = 20;
const MAX_DOC_UPLOAD_BYTES = MAX_DOC_UPLOAD_MB * 1024 * 1024;
/**
 * ⚠️ THE LIMIT IS PRINTED FROM THE MB FIGURE, NOT DERIVED FROM THE BYTES. The
 * first version divided the byte ceiling by 1e6 and told the user their file was
 * "over the 20.97152 MB limit" — a number no human wrote and nobody can act on
 * cleanly. Caught by a test asserting the sentence, not the behaviour.
 */

/**
 * ── ⚠️⚠️ THE RETURN VALUE IS THE EXPENSIVE PART, NOT THE CALL ───────────────
 *
 * The service will happily return 400,000 characters. Handing that back becomes
 * a tool result inside a transcript that is re-sent on EVERY subsequent round —
 * so one careless read of a long PDF is not a one-off cost, it is a tax on the
 * rest of the session. At ~4 chars/token that is ~100k tokens, multiplied by
 * however many rounds follow.
 *
 * ⭐ So a call returns a WINDOW and says where the next one starts, exactly as
 * `read_lines` does for a large file. The model is not being protected from the
 * document; it is being handed it a page-range at a time, with the range stated.
 */
const DOC_TEXT_BUDGET = 12_000;
/** Cells are dense; a 40-row cap keeps a real invoice whole and a dump bounded. */
const MAX_TABLE_ROWS = 40;
const MAX_TABLES_RETURNED = 8;

/**
 * ── ⭐⭐ THE SENTENCE THAT MAKES THE TWO SERVICES ONE CAPABILITY ─────────────
 *
 * `doc_read` extracts tables from a PDF's VECTOR layer — the ruling lines. A
 * scan has no vector layer, so on exactly the documents that matter most (a
 * photographed invoice, a signed quote) it truthfully returns `tables: []` while
 * OCR flattens the grid into a paragraph of words in reading order.
 *
 * ⚠️⚠️ A FLATTENED TABLE IS WORSE THAN A MISSING ONE. Every number survives, so
 * the text looks complete and a model will answer from it confidently — but the
 * row-column relationship is gone, so "what did we charge for labour" moves from
 * *unanswerable* to *wrong*. Nothing in the response marks the difference.
 *
 * ⭐ WHICH IS WHY THIS IS A NOTE ON THE RESULT AND NOT A LINE IN THE README.
 * This package has already proven the principle twice: an error that said
 * "returned no audio" bought four useless retries, and a plan banner that said
 * "0/3 done" bought eight rounds, because neither NAMED THE VERB. A caller that
 * is told the grid may be lost, and told which tool recovers it, can act in the
 * same round.
 */
const TABLE_ADVICE = 'this page was OCR\'d, and OCR flattens tables into '
  + 'sentences — the rows and columns are gone from the text above. If the page '
  + 'has a table you need, call read_table on the same path to recover the grid.';

/**
 * Read a document a human handed over. PDF · DOCX · XLSX · PPTX · CSV · TXT ·
 * MD · HTML · PNG/JPG/WEBP/TIFF, with OCR for pages that carry no text layer.
 */
export async function readDocument(root, path, {
  env = process.env, fetchImpl = fetch, ocr = 'auto', fromPage = 1, maxPages, home = undefined,
} = {}) {
  const cfg = mediaConfig(env);
  // ⚠️ Same correction as its four siblings: the URL is baked in, so what a
  // customer is actually missing is the SECRET — and the old message named the
  // URL, which is the one thing they could set and the one thing that would not
  // have helped.
  const via = docReadVia(cfg, env, home);
  if (!via) {
    return {
      ok: false,
      error: 'no document reader is available — sign in with `acuvo --login` so this runs on your plan, '
        + 'or set MODAL_DOC_READ_URL to point at your own reader',
    };
  }

  const mode = String(ocr || 'auto').toLowerCase();
  if (!['auto', 'always', 'never'].includes(mode)) {
    return { ok: false, error: `ocr must be auto, always or never — got "${ocr}"` };
  }

  const target = resolveInWorkspace(root, path, 'read');
  if (!target.ok) return { ok: false, error: target.reason };

  let buf;
  try {
    buf = readFileSync(target.absolute);
  } catch (err) {
    return { ok: false, error: `could not read ${target.relative}: ${err?.message ?? err}` };
  }
  if (buf.length > MAX_DOC_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `${target.relative} is ${(buf.length / 1e6).toFixed(1)} MB, over the `
        + `${MAX_DOC_UPLOAD_MB} MB limit for a document read`,
    };
  }
  /**
   * ⚠️ AND A SECOND, SMALLER CEILING ON THE GATEWAY LEG ONLY — the same one
   * `transcribe` carries, for the same measured reason: the platform refuses an
   * oversized body BEFORE any of our code runs, with no body of its own, so the
   * customer sees a bare error and we log nothing. Saying the number in advance
   * costs one comparison; discovering it costs the round trip and the diagnosis.
   */
  if (!via.direct && buf.length > MAX_GATEWAY_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `${target.relative} is ${(buf.length / 1024 / 1024).toFixed(1)}MB, over the `
        + `${Math.round(MAX_GATEWAY_UPLOAD_BYTES / 1024 / 1024)}MB limit for a document read through your Acuvo plan `
        + '(the upload rides in one request). Split the file, or set MODAL_DOC_READ_URL to your own worker '
        + `for files up to ${MAX_DOC_UPLOAD_MB}MB.`,
    };
  }

  /**
   * ⚠️⚠️ THE FILENAME IS NOT COSMETIC AND MUST BE SENT. The worker classifies by
   * MAGIC BYTES precisely because a caller's filename lies — but DOCX, XLSX and
   * PPTX are all a ZIP with identical magic, and the extension is the only thing
   * that separates them. Omit it and every Office document this agent is handed
   * comes back "unsupported file type (zip-unknown)".
   */
  const filename = target.relative.split(/[\\/]/).pop() || 'document';

  const payload = {
    file_b64: buf.toString('base64'),
    filename,
    ocr: mode,
    ...(Number.isFinite(maxPages) && maxPages > 0 ? { max_pages: Math.floor(maxPages) } : {}),
  };
  // ⚠️ The secret on the direct leg only; the gateway leg carries a bearer token
  // and never the shared credential. See `speak` for the security argument.
  const res = await postJson(
    via.url,
    via.direct ? { ...payload, secret: cfg.secret ?? undefined } : payload,
    {
      fetchImpl,
      label: 'the document reader',
      verb: 'read_document',
      ...(via.direct ? {} : { headers: { authorization: `Bearer ${via.token}` } }),
    },
  );
  if (!res.ok) return res;

  const body = res.json ?? {};
  const allPages = Array.isArray(body.pages) ? body.pages : [];

  // ── The window. 1-based and clamped, because an out-of-range page is a typo,
  //    not a reason to return nothing and let the model conclude the file is
  //    empty — the failure this whole file exists to refuse.
  const start = Math.max(1, Math.floor(Number(fromPage) || 1));
  const windowed = [];
  let used = 0;
  let nextPage = null;
  for (const p of allPages) {
    const num = Number(p?.page ?? 0);
    if (num < start) continue;
    const text = String(p?.text ?? '');
    if (used && used + text.length > DOC_TEXT_BUDGET) { nextPage = num; break; }
    windowed.push({ page: num, text: text.slice(0, DOC_TEXT_BUDGET), ocr: p?.ocr === true, ...(p?.sheet ? { sheet: p.sheet } : {}) });
    used += text.length;
  }

  const tables = [];
  let tablesTruncated = false;
  for (const p of allPages) {
    if (tables.length >= MAX_TABLES_RETURNED) { tablesTruncated = true; break; }
    for (const grid of Array.isArray(p?.tables) ? p.tables : []) {
      if (!Array.isArray(grid) || !grid.length) continue;
      if (tables.length >= MAX_TABLES_RETURNED) { tablesTruncated = true; break; }
      tables.push({
        page: Number(p?.page ?? 0),
        rows: grid.slice(0, MAX_TABLE_ROWS).map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : [])),
        rowsTotal: grid.length,
      });
      if (grid.length > MAX_TABLE_ROWS) tablesTruncated = true;
    }
  }

  const ocrPages = Array.isArray(body.ocr_pages) ? body.ocr_pages : [];
  const notes = [...(Array.isArray(body.notes) ? body.notes : [])];
  // ⭐ The cross-service instruction — see TABLE_ADVICE. Only when it can matter:
  //    a page was OCR'd AND no grid was recovered from anywhere in the document.
  if (ocrPages.length && !tables.length) notes.push(`page${ocrPages.length > 1 ? 's' : ''} ${ocrPages.join(', ')}: ${TABLE_ADVICE}`);

  return {
    ok: true,
    path: target.relative,
    kind: body.kind ?? 'unknown',
    pageCount: Number(body.page_count ?? allPages.length),
    pages: windowed,
    text: windowed.map((p) => p.text).filter(Boolean).join('\n\n').trim(),
    tables,
    tablesTruncated,
    ocrPages,
    notes,
    // ⚠️ Two different truncations, named separately. `truncated` is the
    // WORKER's (the document exceeded its own character ceiling); `nextPage` is
    // OURS (more pages exist and here is where to resume). Collapsing them would
    // tell a model to retry a window it already holds.
    truncated: body.truncated === true,
    nextPage,
  };
}

/**
 * Is this buffer plain TEXT (a CSV, JSON, a .txt)? Valid UTF-8 in its first 4 KB and no control
 * bytes other than tab / CR / LF / FF. Deliberately NOT "is it an image": scanned tables arrive as
 * TIFF and BMP as well as PNG/JPEG, and the table reader is the judge of those. This only has to
 * be sure a file is text, which is the case that can never be a picture of a table.
 */
export function looksLikeText(buf) {
  if (!buf || buf.length === 0) return false;
  const sample = buf.subarray(0, 4096);
  for (const b of sample) {
    if (b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) return false;
  }
  // A multi-byte character may be cut at the 4 KB edge; allow up to 3 trailing bytes.
  for (let cut = 0; cut <= 3 && cut < sample.length; cut += 1) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - cut)); return true; } catch { /* try shorter */ }
  }
  return false;
}

/**
 * Recover the ROWS AND COLUMNS from a picture of a table — a scanned invoice, a
 * photographed price list, a table inside a PDF that has no vector ruling lines.
 * Table Transformer (MIT, code and weights both checked).
 */
export async function readTable(root, path, { env = process.env, fetchImpl = fetch, page = 1, ocr = true, home = undefined } = {}) {
  const cfg = mediaConfig(env);
  // ⚠️ Same correction as its five siblings — the secret, not the URL, is what a
  // customer was missing, and the old message pointed at the URL.
  const via = tableReadVia(cfg, env, home);
  if (!via) {
    return {
      ok: false,
      error: 'no table reader is available — sign in with `acuvo --login` so this runs on your plan, '
        + 'or set MODAL_TABLE_READ_URL to point at your own reader',
    };
  }

  const target = resolveInWorkspace(root, path, 'read');
  if (!target.ok) return { ok: false, error: target.reason };

  let buf;
  try {
    buf = readFileSync(target.absolute);
  } catch (err) {
    return { ok: false, error: `could not read ${target.relative}: ${err?.message ?? err}` };
  }
  if (buf.length > MAX_DOC_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `${target.relative} is ${(buf.length / 1e6).toFixed(1)} MB, over the `
        + `${MAX_DOC_UPLOAD_MB} MB limit for a table read`,
    };
  }
  // ⚠️ And the smaller gateway ceiling — see `readDocument` for why it is said
  // here rather than discovered as a platform 413 with no body.
  if (!via.direct && buf.length > MAX_GATEWAY_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `${target.relative} is ${(buf.length / 1024 / 1024).toFixed(1)}MB, over the `
        + `${Math.round(MAX_GATEWAY_UPLOAD_BYTES / 1024 / 1024)}MB limit for a table read through your Acuvo plan `
        + '(the upload rides in one request). Split the file, or set MODAL_TABLE_READ_URL to your own worker '
        + `for files up to ${MAX_DOC_UPLOAD_MB}MB.`,
    };
  }

  /**
   * ⚠️ SNIFFED, NOT TRUSTED — and for once the filename is the wrong signal even
   * though we control it, because `read_table` is most often pointed at whatever
   * `read_document` just complained about. `%PDF-` is five bytes and settles it.
   */
  const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
  /**
   * ⚠️ NEITHER A PDF NOR A PICTURE: REFUSED HERE, FOR FREE (2026-09-26). Found by using it —
   * asked to report on `sales.csv`, the model's first call was `read_table sales.csv`. The CSV went
   * to the GPU table reader, came back `UnidentifiedImageError`, and the ESTIMATED GPU cost was
   * $0.038 — six times the whole run's model spend — for an answer that could never exist.
   */
  if (!isPdf && looksLikeText(buf)) {
    return {
      ok: false,
      error: `${target.relative} is plain text, not a PDF or an image — there is no picture of a table to read — `
        + 'it is already text: open it with read_file (a CSV or TSV is rows as written), or with the language you are working in.',
    };
  }
  const b64 = buf.toString('base64');

  const payload = {
    ...(isPdf ? { pdf_b64: b64, page: Math.max(1, Math.floor(Number(page) || 1)) } : { image_b64: b64 }),
    ocr: ocr !== false,
  };
  const res = await postJson(
    via.url,
    via.direct ? { ...payload, secret: cfg.secret ?? undefined } : payload,
    {
      fetchImpl,
      label: 'the table reader',
      verb: 'read_table',
      ...(via.direct ? {} : { headers: { authorization: `Bearer ${via.token}` } }),
    },
  );
  if (!res.ok) return res;

  const found = Array.isArray(res.json?.tables) ? res.json.tables : [];

  /**
   * ⚠️ NO TABLE FOUND IS AN ANSWER, NOT A FAILURE. It genuinely means "there is
   * no table on this page", which is a useful thing to learn — but returning
   * `{ ok: true, tables: [] }` invites the model to retry the same call. So it
   * succeeds, and says what it looked at, so the next move is obvious.
   */
  const tables = found.slice(0, MAX_TABLES_RETURNED).map((t) => ({
    rows: Number(t?.rows ?? 0),
    cols: Number(t?.cols ?? 0),
    confidence: Number(t?.score ?? 0),
    grid: (Array.isArray(t?.grid) ? t.grid : []).slice(0, MAX_TABLE_ROWS)
      .map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : [])),
    rowsReturned: Math.min(Number(t?.rows ?? 0), MAX_TABLE_ROWS),
  }));

  return {
    ok: true,
    path: target.relative,
    ...(isPdf ? { page: Math.max(1, Math.floor(Number(page) || 1)) } : {}),
    count: found.length,
    tables,
    ...(found.length ? {} : { note: `no table was detected on ${isPdf ? `page ${page} of ` : ''}${target.relative} — the page may have no table, or the image may be too low-resolution to find one` }),
  };
}

/**
 * Only the tools whose service is configured.
 *
 * ⚠️ A TOOL THAT CANNOT WORK IS NEVER OFFERED. This package already learned it
 * the expensive way: a control that presents itself and does nothing is worse
 * than one that is absent, because the model presses it, waits, and apologises —
 * spending a round to discover what the schema could have said for free.
 */
export function mediaToolSchemas(env = process.env, home = undefined) {
  const cfg = mediaConfig(env);
  /**
   * ── 🚪⭐⭐⭐ "CONFIGURED" WAS NEVER THE QUESTION. "REACHABLE" IS ────────────
   *
   * ⚠️ MEASURED 2026-08-26, and it is the same finding that produced `/render`,
   * `/speak` and `/transcribe`, arriving one layer later. These six gates asked
   * `mediaConfig()` whether a URL existed — and for a paying customer the answer
   * is always NO, because the URLs are baked in and gated on `MODAL_VIDEO_SECRET`,
   * our own Modal credential. So a signed-in customer's AGENT was never told it
   * could look at the page it had just built, speak, listen, print a PDF, or read
   * a document its user had handed over. Only the human-typed flags worked, and
   * only after the previous pass fixed three of them.
   *
   * ⭐ PER TOOL, NOT ONE BOOLEAN, AND THAT IS THE WHOLE DESIGN. The previous pass
   * stopped here on purpose: three of the six had no gateway route, so a single
   * account-aware flag would have offered three verbs that could only fail. Six
   * routes now exist, and each tool asks its OWN question — so a half-configured
   * machine offers exactly the half that works, which is the honest answer and
   * the one this file's header demands.
   */
  const via = mediaRoutes(cfg, env, home);
  const out = [];

  if (via.render) {
    out.push({
      type: 'function',
      function: {
        name: 'see_page',
        description: [
          'LOOK at an HTML file you wrote — renders it in a real browser and returns a screenshot',
          'plus measured problems (invisible text, overflow, cramped sections).',
          'Use it after building any page: you cannot judge a layout by reading its source, and this',
          'is how you find the heading that is white on white. Saves the screenshot into the workspace.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Workspace-relative path to an .html file.' } },
          required: ['path'],
        },
      },
    });
  }

  if (via.speak) {
    out.push({
      type: 'function',
      function: {
        name: 'speak',
        description: [
          'Turn text into speech and save it as an audio file in the workspace.',
          'It reads in a FIXED voice — it cannot clone one, so do not offer to make it sound like anybody.',
          'Leave `engine` unset; there is only one speech engine here and naming another is refused.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to say. Up to 5,000 characters.' },
            path: { type: 'string', description: 'Optional output path, e.g. "audio/intro.wav".' },
            engine: {
              type: 'string',
              description: 'Only if the user named an engine. Voice cloning ("acuvo-voice") is not reachable from the CLI and will be refused with an explanation.',
            },
          },
          required: ['text'],
        },
      },
    });
  }

  if (via.transcribe) {
    out.push({
      type: 'function',
      function: {
        name: 'transcribe',
        description: 'Transcribe an audio or video file in the workspace, with timestamped segments.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Workspace-relative path to the media file.' } },
          required: ['path'],
        },
      },
    });
  }

  if (via.document) {
    out.push({
      type: 'function',
      function: {
        name: 'make_document',
        description: [
          'Turn an HTML file into a real PDF, PNG or PPTX saved in the workspace.',
          'Use it when the user asks for a document, a deck or an export — not for a web page.',
          'For a deck, put each slide in its own top-level <section class="slide"> — each becomes one 16:9 slide, so size it 100vw x 100vh with no page margin (PPTX slides are images, so read the HTML, not the .pptx, to check wording).',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative .html file to convert.' },
            format: { type: 'string', enum: ['pdf', 'png', 'pptx'], description: 'Output format.' },
            out: { type: 'string', description: 'Optional output path.' },
          },
          required: ['path', 'format'],
        },
      },
    });
  }

  if (via.docRead) {
    out.push({
      type: 'function',
      function: {
        name: 'read_document',
        description: [
          'READ a document the user gave you — PDF, Word, Excel, PowerPoint, CSV, HTML or a photo of a page.',
          'Returns the text, any tables, and which pages had to be OCR\'d.',
          'Use it before building anything from a supplied file: a spec, an invoice, a price list, a brief.',
          'A scanned PDF works — pages with no text layer are OCR\'d automatically.',
          'Long documents come back one page-window at a time; the result says which page to resume from.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative path to the document.' },
            from_page: { type: 'number', description: 'First page to return. Default 1. Use the nextPage from a previous call to continue.' },
            max_pages: { type: 'number', description: 'How many pages the reader should process at all. Default 60, maximum 200.' },
            ocr: {
              type: 'string',
              enum: ['auto', 'always', 'never'],
              description: 'auto (default) OCRs only pages with no text layer; always forces it when a PDF\'s text layer is a bad prior OCR; never disables it.',
            },
          },
          required: ['path'],
        },
      },
    });
  }

  /**
   * ⚠️⚠️ THE "PREFER read_document" LINE IS MEASURED, NOT POLITE. Proven live
   * 2026-08-12 on the same one-page quote — a digital PDF with a real text layer:
   *
   *   read_document  TOTAL … 1000   Amount   (from the vector layer, exact)
   *   read_table     TOTAL … 1001   Am       (5x4 grid found at conf 0.999,
   *                                           cells OCR'd off a 200-DPI render)
   *
   * ⭐ The GEOMETRY was perfect and the CHARACTERS were not, which is exactly
   * right for what it is: this service reads a PICTURE of a page. On a scan that
   * is the only thing that can work; on a digital PDF it is a strictly worse
   * answer that looks equally confident. A tool that is better in one direction
   * and worse in the other must say which, or it gets used as an upgrade.
   */
  if (via.tableRead) {
    out.push({
      type: 'function',
      function: {
        name: 'read_table',
        description: [
          'Recover the ROWS AND COLUMNS from a picture of a table — a scanned invoice, a photographed',
          'price list, or a PDF page whose table read_document could not see.',
          'Use it whenever you need cell-level accuracy: OCR text keeps every number but destroys which',
          'number belongs to which line item, so answering from flattened text is how you get it wrong.',
          'Takes a PDF (with a page number) or an image file.',
          'PREFER the tables read_document already returned when it returned any — this reads the page as a',
          'PICTURE, so on a document that has a real text layer it is a downgrade, not a second opinion.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative path to a PDF or an image.' },
            page: { type: 'number', description: 'Which page of a PDF, 1-based. Ignored for images. Default 1.' },
          },
          required: ['path'],
        },
      },
    });
  }

  return out;
}

/**
 * Names only — the offer list needs these without building the schemas twice.
 *
 * ⚠️ `home` IS THREADED FOR TESTABILITY, NOT DECORATION, and this is the layer
 * where it matters most. Without it, WHICH TOOLS A RUN OFFERS depends on whether
 * the person executing it happens to be signed in — so a test asserting a tool
 * list would pass on one laptop and fail on another, and the failure output would
 * be the honest one printing what it found. A sibling test printed a live
 * `xxi_live_…` token into node's own failure output the last time an account read
 * was left to chance.
 */
export function mediaToolNames(env = process.env, home = undefined) {
  return mediaToolSchemas(env, home).map((t) => t.function.name);
}
