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
import { resolveInWorkspace } from './workspace.mjs';

/**
 * ⚠️ A CAP AND AN ALLOWED SET FOR `transcribe`, because its sibling `speak` had
 * both and this had neither (ENTERPRISE §3.6). 25MB is roughly a 25-minute
 * recording — past that the right move is to split the file, not to pay for a
 * 200MB upload the model asked for by mistake.
 */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
export const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.webm', '.mp4', '.mov']);
import { throughBreaker, deadReason, skipMessage } from './breaker.mjs';

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

/** POST JSON with a bound timeout. Never throws — a failure is data. */
async function postJson(url, body, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, label = 'the service' } = {}) {
  /**
   * ⚠️ THE BREAKER IS CHECKED BEFORE THE REQUEST, for the reason set out in
   * breaker.mjs: these timeouts are 180-240s, and a session budget is measured
   * in minutes. Two waits on a dead endpoint is the whole run.
   */
  const already = deadReason(url);
  if (already) return { ok: false, error: skipMessage(label, url) };
  try {
    const res = await throughBreaker(url, label, () => fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }));
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
      return { ok: false, error: `HTTP ${res.status}: ${(json?.error ?? text ?? '').toString().slice(0, 400)}` };
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
export function inlineLocalAssets(root, pageRelPath, html, { readImpl = readFileSync } = {}) {
  const missing = [];
  const dir = pageRelPath.includes('/') ? pageRelPath.slice(0, pageRelPath.lastIndexOf('/')) : '';
  /** Only same-workspace, non-absolute, non-remote references are ours to inline. */
  const isLocal = (u) => u && !/^(https?:|data:|\/\/|#|mailto:|tel:)/i.test(u) && !u.startsWith('/');
  const resolveAsset = (url) => {
    const clean = url.split('?')[0].split('#')[0];
    const rel = dir ? `${dir}/${clean}` : clean;
    const t = resolveInWorkspace(root, rel, 'read');
    if (!t.ok) return null;
    try { return { buf: readImpl(t.absolute), rel: t.relative }; } catch { return null; }
  };

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
export async function seePage(root, htmlPath, { env = process.env, fetchImpl = fetch, dryRun = false } = {}) {
  const cfg = mediaConfig(env);
  if (!cfg.render) return { ok: false, error: 'no render service is configured (RENDER_AUDIT_URL)' };

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

  const res = await postJson(cfg.render, { html: bundled.html, secret: cfg.secret ?? undefined },
    { timeoutMs: RENDER_TIMEOUT_MS, fetchImpl, label: 'The render service' });
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

/** Speak text aloud into a workspace audio file. Modal TTS (Kokoro, Apache-2.0). */
export async function speak(root, text, outPath, { env = process.env, fetchImpl = fetch, dryRun = false } = {}) {
  const cfg = mediaConfig(env);
  if (!cfg.speak) return { ok: false, error: 'no speech service is configured (MODAL_TTS_URL)' };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'nothing to say — text is required' };
  if (text.length > 5_000) return { ok: false, error: `text is ${text.length} characters, over the 5,000 limit` };

  const res = await postJson(cfg.speak, { text, secret: cfg.secret ?? undefined }, { fetchImpl });
  if (!res.ok) return res;
  const b64 = res.json?.audioB64 ?? res.json?.audio_b64 ?? res.json?.audio;
  if (!b64) return { ok: false, error: 'the speech service returned no audio' };
  return writeBinary(root, outPath || `.acuvo/speech-${Date.now()}.wav`, b64, dryRun);
}

/** Transcribe an audio file already in the workspace. faster-whisper, MIT. */
export async function transcribe(root, audioPath, { env = process.env, fetchImpl = fetch, dryRun = false } = {}) {
  const cfg = mediaConfig(env);
  if (!cfg.transcribe) return { ok: false, error: 'no transcription service is configured (MODAL_TRANSCRIBE_URL)' };

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
  const res = await postJson(
    cfg.transcribe,
    { audio_b64: b64, audioB64: b64, secret: cfg.secret ?? undefined },
    { fetchImpl },
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
export async function makeDocument(root, htmlPath, outPath, format, { env = process.env, fetchImpl = fetch, dryRun = false } = {}) {
  const cfg = mediaConfig(env);
  if (!cfg.document) return { ok: false, error: 'no document service is configured (MODAL_PRESS_URL)' };
  const fmt = String(format || 'pdf').toLowerCase();
  if (!['pdf', 'png', 'pptx'].includes(fmt)) {
    return { ok: false, error: `format must be pdf, png or pptx — got "${format}"` };
  }
  const target = resolveInWorkspace(root, htmlPath, 'read');
  if (!target.ok) return { ok: false, error: target.reason };
  let html;
  try { html = readFileSync(target.absolute, 'utf8'); }
  catch (err) { return { ok: false, error: `could not read ${target.relative}: ${err?.message ?? err}` }; }

  const res = await postJson(cfg.document, { html, format: fmt, secret: cfg.secret ?? undefined }, { fetchImpl });
  if (!res.ok) return res;
  const b64 = res.json?.fileB64 ?? res.json?.file_b64 ?? res.json?.data;
  if (!b64) return { ok: false, error: 'the document service returned no file' };
  return writeBinary(root, outPath || `.acuvo/document-${Date.now()}.${fmt}`, b64, dryRun);
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
  env = process.env, fetchImpl = fetch, ocr = 'auto', fromPage = 1, maxPages,
} = {}) {
  const cfg = mediaConfig(env);
  if (!cfg.docRead) return { ok: false, error: 'no document reader is configured (MODAL_DOC_READ_URL)' };

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
   * ⚠️⚠️ THE FILENAME IS NOT COSMETIC AND MUST BE SENT. The worker classifies by
   * MAGIC BYTES precisely because a caller's filename lies — but DOCX, XLSX and
   * PPTX are all a ZIP with identical magic, and the extension is the only thing
   * that separates them. Omit it and every Office document this agent is handed
   * comes back "unsupported file type (zip-unknown)".
   */
  const filename = target.relative.split(/[\\/]/).pop() || 'document';

  const res = await postJson(
    cfg.docRead,
    {
      file_b64: buf.toString('base64'),
      filename,
      ocr: mode,
      ...(Number.isFinite(maxPages) && maxPages > 0 ? { max_pages: Math.floor(maxPages) } : {}),
      secret: cfg.secret ?? undefined,
    },
    { fetchImpl, label: 'the document reader' },
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
 * Recover the ROWS AND COLUMNS from a picture of a table — a scanned invoice, a
 * photographed price list, a table inside a PDF that has no vector ruling lines.
 * Table Transformer (MIT, code and weights both checked).
 */
export async function readTable(root, path, { env = process.env, fetchImpl = fetch, page = 1, ocr = true } = {}) {
  const cfg = mediaConfig(env);
  if (!cfg.tableRead) return { ok: false, error: 'no table reader is configured (MODAL_TABLE_READ_URL)' };

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

  /**
   * ⚠️ SNIFFED, NOT TRUSTED — and for once the filename is the wrong signal even
   * though we control it, because `read_table` is most often pointed at whatever
   * `read_document` just complained about. `%PDF-` is five bytes and settles it.
   */
  const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
  const b64 = buf.toString('base64');

  const res = await postJson(
    cfg.tableRead,
    {
      ...(isPdf ? { pdf_b64: b64, page: Math.max(1, Math.floor(Number(page) || 1)) } : { image_b64: b64 }),
      ocr: ocr !== false,
      secret: cfg.secret ?? undefined,
    },
    { fetchImpl, label: 'the table reader' },
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
export function mediaToolSchemas(env = process.env) {
  const cfg = mediaConfig(env);
  const out = [];

  if (cfg.render) {
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

  if (cfg.speak) {
    out.push({
      type: 'function',
      function: {
        name: 'speak',
        description: 'Turn text into speech and save it as an audio file in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to say. Up to 5,000 characters.' },
            path: { type: 'string', description: 'Optional output path, e.g. "audio/intro.wav".' },
          },
          required: ['text'],
        },
      },
    });
  }

  if (cfg.transcribe) {
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

  if (cfg.document) {
    out.push({
      type: 'function',
      function: {
        name: 'make_document',
        description: [
          'Turn an HTML file into a real PDF, PNG or PPTX saved in the workspace.',
          'Use it when the user asks for a document, a deck or an export — not for a web page.',
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

  if (cfg.docRead) {
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
  if (cfg.tableRead) {
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

/** Names only — the offer list needs these without building the schemas twice. */
export function mediaToolNames(env = process.env) {
  return mediaToolSchemas(env).map((t) => t.function.name);
}
