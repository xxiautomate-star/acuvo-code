/**
 * ── ⭐⭐ THE DESIGN LOOP — THE AGENT LOOKS AT WHAT IT BUILT ───────────────────
 *
 * Two finished capabilities already sit in this package and have never been
 * joined: `seePage` (lib/media.mjs) renders HTML in a real browser and returns
 * MEASURED layout facts, and `renderImage` (lib/terminal-graphics.mjs) draws a
 * PNG inline on kitty and iTerm2. Between them is the loop: build the page,
 * look at it, hand the model a verdict it can act on, and hand the HUMAN the
 * actual picture.
 *
 * ── ⚠️ THE CLAIM. THE OLD ONE WAS FALSE AND WAS STRUCK ON 2026-08-10 ─────────
 *
 * "No other terminal agent can see its own output" is WRONG. Playwright MCP and
 * Chrome DevTools MCP are free, first-party and one `claude mcp add` away; some
 * agents ship a browser. A pitch built on that claim dies at the first customer
 * who has heard of Playwright, and it makes everything else we say suspect.
 *
 * ⭐ THE DEFENSIBLE CLAIM IS THE RETURN VALUE, NOT THE BROWSER. The competing
 * shape is: take a screenshot, hand the PNG back to the model, ask it to
 * interpret its own work. That costs the image's full token price EVERY LOOK —
 * for the 1280×900 viewport this service uses, `imageTokenCost(1280, 900)` =
 * **1,536 tokens** (a taller full-page shot runs to ~3,072) — and it asks the
 * model to do the one thing models are measurably worst at: read fine layout
 * detail out of its own render.
 *
 * This module measures in CODE and returns an ordered, specific verdict that
 * runs about **89 tokens**. Same information, one to two orders of magnitude
 * cheaper, and no vision hop in the middle. `cost` on every pass reports both
 * numbers COMPUTED FROM THE ACTUAL VIEWPORT, so the ratio is never a quoted
 * marketing figure — if a page renders at a size that narrows the gap, the pass
 * says so itself.
 *
 * ⚠️ AND IT BUYS A HEAD START, NEVER A MOAT. A competent developer rebuilds this
 * in a weekend. Price and pitch accordingly.
 *
 * ── ⚠️⚠️ THE DEFECT THIS MODULE EXISTS TO CLOSE: THE NAKED PAGE ──────────────
 *
 * On 2026-08-10 `see_page` was fixed after reading `json.findings` from a
 * service that replies `{ ok, measurement: {…} }` — every call had been
 * returning "I looked and it was fine" for pages it never saw. Once fixed, it
 * PASSED FOUR NAKED PAGES: the render service takes HTML **text**, so
 * `<link rel="stylesheet" href="styles.css">` resolved to nothing and every
 * multi-file page arrived unstyled. `inlineLocalAssets` now bundles the page's
 * own siblings, which fixes the common case.
 *
 * ⚠️ BUT MEASUREMENT CAN NEVER DETECT THE REMAINING CASES, AND IT IS WORTH
 * BEING PRECISE ABOUT WHY. Measured live 2026-08-11, the same page twice:
 *
 *   naked  → paintedRatio 0.0986 · lowContrastText [] · consoleErrors []
 *   styled → paintedRatio 0.1514 · lowContrastText [] · consoleErrors []
 *
 * Both produce `findingsFrom() === []`. Black Times on white has *excellent*
 * contrast; 9.8% of the viewport really is painted. The unstyled page is not a
 * page that fails the checks — it is a page that passes them, which is why it
 * survived a full audit and shipped.
 *
 * ⚠️⚠️ AND IT IS WORSE THAN "THE CHECKS PASS" — THE UNSTYLED RENDER MASKS REAL
 * DEFECTS. Measured live 2026-08-11 on one page containing a deliberate
 * `.ghost { color: #0c0e11 }` footer note on a `#0b0d10` background:
 *
 *   styled render → `unreadable text (contrast 1.01:1, needs 4.5)`   ← caught
 *   naked  render → no findings at all                               ← MISSED
 *
 * The invisible text is present in both files. In the naked render the rule
 * never applies, so the text comes back as black on white and reads as
 * perfectly legible. So a missing stylesheet does not merely fail to find new
 * problems; it SUPPRESSES the true positives the audit exists to produce. That
 * is why an untrustworthy render is reported as a finding in its own right and
 * never allowed to reach the model as an all-clear.
 *
 * ⭐ SO THE TRUTH IS NOT IN THE PIXELS, IT IS IN THE REQUEST. Did the HTML we
 * handed the browser still point at a stylesheet the browser could not fetch?
 * That is a fact about bytes we sent. `stylingTrust` reads it off the payload,
 * and a pass that fails it is marked UNRELIABLE — because a clean measurement
 * of an undesigned page is worse than no measurement at all.
 *
 * ⚠️ IT CATCHES ONE CASE `inlineLocalAssets` CORRECTLY DOES NOT REPORT. A
 * root-absolute `/styles.css` is server-rooted, so it is not the workspace's to
 * resolve — media.mjs leaves it alone and says nothing. The render service has
 * no server behind it, so the page still arrives naked with no missing-asset
 * finding to explain it. Only the request tells you.
 *
 * ── ⚠️ ABSENT IS NOT CLEAN ──────────────────────────────────────────────────
 *
 * `findingsFrom` reads `(m.lowContrastText ?? [])`. A service that stops
 * measuring contrast therefore reads as a page with *perfect* contrast — the
 * identical failure mode as the envelope bug, one field down, and it would be
 * introduced by a change nobody in this repo made. `checkCoverage` separates
 * "measured and clean" from "not measured", and the verdict prints the second
 * as NOT CHECKED.
 *
 * ⭐ "I could not determine the contrast" is a useful sentence. A confident
 * wrong one is not. Every function here abstains rather than guesses.
 *
 * ── ⚠️ WHAT THIS FILE DOES NOT DO ───────────────────────────────────────────
 * It does not modify `media.mjs` and it does not re-implement the render call.
 * It wraps `seePage`, so the inlining, the path safety, the circuit breaker and
 * the envelope check all stay in exactly one place. It OBSERVES the request and
 * the reply by wrapping `fetchImpl` — which is why the styling fact and the
 * coverage fact are available here without a second network round trip.
 *
 * Zero dependencies. Node built-ins only.
 */

import { resolve } from 'node:path';
import { seePage } from './media.mjs';
import { renderImage } from './terminal-graphics.mjs';

/**
 * The checks the render service performs, and the plain-English name each one
 * gets in a verdict.
 *
 * ⚠️ THE LIST IS DATA, NOT PROSE IN A PROMPT. An all-clear has to be able to
 * say what it is an all-clear FOR, and that sentence must go stale the moment
 * the service stops returning a field — which it cannot do if the names live in
 * a system prompt somewhere.
 */
export const CHECKS = Object.freeze([
  { key: 'consoleErrors', label: 'console errors' },
  { key: 'paintedRatio', label: 'painted area' },
  { key: 'lowContrastText', label: 'text contrast' },
  { key: 'clippedText', label: 'clipped text' },
  { key: 'overlaps', label: 'overlapping elements' },
  { key: 'brokenImages', label: 'broken images' },
  { key: 'scrollWidth', label: 'horizontal overflow' },
]);

/** Contrast source values that mean "we did not actually measure it". */
const CONTRAST_NOT_MEASURED = new Set(['none', 'unavailable', 'skipped', 'error', 'failed']);

/**
 * Which checks the measurement can actually answer.
 *
 * ⚠️ PRESENCE IS NOT ENOUGH FOR TWO OF THEM. `lowContrastText: []` alongside
 * `contrastSource: "none"` means the service tried and could not — reporting
 * that as "contrast is fine" is precisely the confident-wrong sentence this
 * module is built to refuse. And `scrollWidth` cannot answer overflow without a
 * viewport width to compare it against.
 *
 * Pure: data in, data out. No clock, no network.
 */
export function checkCoverage(measurement) {
  const m = measurement && typeof measurement === 'object' && !Array.isArray(measurement) ? measurement : null;
  if (!m) return { known: false, checked: [], undetermined: CHECKS.map((c) => c.label) };

  const checked = [];
  const undetermined = [];
  for (const { key, label } of CHECKS) {
    let ok = m[key] !== undefined && m[key] !== null;
    if (ok && key === 'lowContrastText') {
      const src = typeof m.contrastSource === 'string' ? m.contrastSource.trim().toLowerCase() : null;
      if (src && CONTRAST_NOT_MEASURED.has(src)) ok = false;
    }
    if (ok && key === 'paintedRatio') ok = typeof m.paintedRatio === 'number' && Number.isFinite(m.paintedRatio);
    if (ok && key === 'scrollWidth') {
      ok = typeof m.scrollWidth === 'number' && typeof m.viewport?.width === 'number';
    }
    (ok ? checked : undetermined).push(label);
  }
  return { known: true, checked, undetermined };
}

/** References the browser can fetch on its own. Everything else is ours to have inlined. */
const FETCHABLE = /^(https?:|\/\/|data:)/i;

/**
 * Remove the parts of an HTML document that only LOOK like markup.
 *
 * ⚠️ A CHECK THAT FAILS CORRECT WORK IS WORSE THAN NO CHECK. A commented-out
 * `<link rel="stylesheet">` is not a stylesheet reference, and a `<style>` tag
 * quoted inside a script is not a style block. Accusing either would make this
 * module fire on pages that are perfectly fine — the exact failure this repo has
 * been bitten by four times in a day.
 */
function stripInert(html) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, ' ');
  let hadScript = false;
  const withoutScripts = withoutComments.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, () => {
    hadScript = true;
    return ' ';
  });
  if (/<script\b/i.test(withoutScripts)) hadScript = true;
  return { html: withoutScripts, hadScript };
}

/**
 * ── ⭐⭐ CAN THIS RENDER BE BELIEVED? ────────────────────────────────────────
 *
 * Reads the HTML that was actually POSTed to the render service and answers one
 * question the pixels cannot: did the page reach the browser with its design?
 *
 * Returns:
 *   · `known`       — false when we never observed the request; then every other
 *                     field is null, because guessing here is the whole bug.
 *   · `trustworthy` — false when a stylesheet reference survived into the
 *                     payload. The browser fetched nothing for it, so the page
 *                     rendered naked and every measurement below is meaningless.
 *   · `styled`      — the page carries SOME styling (inline block, remote sheet,
 *                     or style attributes).
 *   · `noCss`       — no styling of any kind AND no script that could inject it.
 *                     That is a real, common defect in model-written pages, and
 *                     it is stated as an observation, never as a verdict on
 *                     taste.
 *
 * Pure: a string in, a plain object out.
 */
export function stylingTrust(sentHtml) {
  if (typeof sentHtml !== 'string') {
    return {
      known: false,
      trustworthy: null,
      styled: null,
      noCss: null,
      unresolved: [],
      reason: null,
    };
  }

  const { html, hadScript } = stripInert(sentHtml);

  const unresolved = [];
  let remoteSheet = false;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = (/href\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '').trim();
    if (!href) { unresolved.push('(a stylesheet link with no href)'); continue; }
    if (FETCHABLE.test(href)) { remoteSheet = true; continue; }
    unresolved.push(href);
  }

  let hasStyleBlock = false;
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (m[1].trim()) { hasStyleBlock = true; break; }
  }
  const hasStyleAttr = /\sstyle\s*=\s*["'][^"']*\S[^"']*["']/i.test(html);

  const styled = hasStyleBlock || remoteSheet || hasStyleAttr;
  const trustworthy = unresolved.length === 0;
  /**
   * ⚠️ ABSTAIN WHEN A SCRIPT COULD BE DOING IT. Plenty of legitimate pages build
   * their stylesheet at runtime; accusing those of having "no CSS" would be a
   * confident wrong sentence about a page that is fine.
   */
  const noCss = !styled && unresolved.length === 0 && !hadScript;

  const reason = unresolved.length > 0
    ? `the page was rendered WITHOUT its stylesheet — the render service was handed HTML text that still links `
      + `${unresolved.map((u) => `"${u}"`).join(', ')}, which the browser could not fetch, so every check below `
      + `ran on an unstyled page and a clean result means nothing`
    : null;

  return { known: true, trustworthy, styled, noCss, unresolved, reason };
}

/**
 * What handing this screenshot to a model would cost instead.
 *
 * Uses the published image-token arithmetic: an image is scaled so its longest
 * edge is at most 1568px, then costs roughly `width × height / 750` tokens.
 *
 * ⚠️ COMPUTED, NEVER QUOTED. The README once carried "3,072 tokens" as a flat
 * figure; it is only true for one image size. A number that changes with the
 * viewport has to be derived from the viewport, or the first person who checks
 * it finds us wrong about our own headline claim.
 *
 * ⚠️ Junk in gets `null`, not a guess.
 */
export const IMAGE_MAX_EDGE = 1568;
export const IMAGE_PIXELS_PER_TOKEN = 750;

export function imageTokenCost(width, height) {
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  return Math.ceil((w * h) / IMAGE_PIXELS_PER_TOKEN);
}

/**
 * A token estimate for text, honest about being an estimate.
 *
 * ⚠️ ~4 ASCII CHARACTERS PER TOKEN, AND ONE TOKEN PER NON-ASCII CHARACTER. The
 * second half matters: CJK and emoji do not compress at four-to-one, and a
 * naive `length / 4` would UNDER-count our own side of the comparison — that is,
 * it would flatter the claim this module makes. Over-counting ourselves is the
 * honest direction to be wrong in.
 */
export function approxTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) < 128) ascii += 1; else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}

/**
 * ── ⭐ THE RETURN VALUE. THIS IS THE PRODUCT ────────────────────────────────
 *
 * An ordered, specific, ~89-token verdict. Every line is a thing the next round
 * can act on, and the things we could not determine are stated as such.
 *
 * ⚠️ THE THREE SENTENCES IT MUST NEVER GET WRONG:
 *   1. A failed look makes NO claim, and forbids the model from making one. The
 *      original bug shipped "I looked and it was fine" for pages never rendered.
 *   2. An untrustworthy render is never phrased as an all-clear, even when the
 *      findings list is genuinely empty — an unstyled page passes every check.
 *   3. An all-clear NAMES THE CHECKS it covers, so "fine" and "not measured" can
 *      never be read as the same thing.
 *
 * Pure: no clock, no network, no fs.
 */
export function buildVerdict({ path, viewport, findings = [], coverage = null, trust = null, looked = false, error = null, screenshot = null } = {}) {
  const where = path ? String(path) : 'the page';

  if (!looked) {
    return [
      `COULD NOT LOOK at ${where}${error ? ` — ${String(error).slice(0, 300)}` : ''}.`,
      'No visual claim about this page is available: do not report it as working and do not describe how it looks.',
    ].join('\n');
  }

  const dims = Number.isFinite(viewport?.width) && Number.isFinite(viewport?.height)
    ? ` — ${viewport.width}×${viewport.height}`
    : '';
  const lines = [`LOOKED AT ${where}${dims}`];

  const list = Array.isArray(findings) ? findings.filter((f) => typeof f === 'string' && f.trim()) : [];
  if (list.length > 0) {
    list.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  } else if (trust?.known && trust.trustworthy === false) {
    // Unreachable in practice — the trust failure is itself finding #1 — but a
    // formatter that could ever emit a bare all-clear for an unstyled page is
    // the exact bug, so it is closed here too.
    lines.push('Nothing else was measurable.');
  } else if (coverage?.checked?.length) {
    lines.push(`No measured problems. Checked: ${coverage.checked.join(', ')}.`);
  } else {
    lines.push('No problems were reported, and no check is known to have run — treat this as unverified.');
  }

  /**
   * ── ⚠️⚠️ THE SCREENSHOT EXISTED AND NOBODY WAS TOLD WHERE ──────────────────
   *
   * `seePage` writes the PNG and returns its path, and this verdict — the only
   * thing the model ever sees — never mentioned it. So the agent was told "I
   * looked" and handed a list of MEASUREMENTS, with no way to look itself.
   *
   * ⚠️ AND IT COULD NOT HAVE FOUND IT BY GUESSING. The file lands in `.acuvo/`,
   * and `find_files` refuses to search hidden directories — measured: it returns
   * `skipped: [{path: ".acuvo", reason: "hidden directory, not searched"}]`. Two
   * tools disagreeing about whether that directory exists.
   *
   * ⭐ Naming it turns three finished halves into a loop: render the page, read
   * the image with `read_image`, change the code. That is the design loop this
   * package is named for, and it was one sentence away the whole time.
   */
  if (typeof screenshot === 'string' && screenshot.trim()) {
    lines.push(`SCREENSHOT: ${screenshot} — open it with read_image to see the page yourself; the findings above are measurements, not a look.`);
  }
  if (coverage?.undetermined?.length) {
    lines.push(`NOT CHECKED (nothing was measured, so no claim either way): ${coverage.undetermined.join(', ')}.`);
  }
  if (trust?.known === false) {
    lines.push('NOT CHECKED: whether the page reached the browser with its own stylesheet.');
  }
  if (trust?.known && trust.trustworthy === false) {
    lines.push('⚠ This is not an all-clear: an unstyled page passes every check above. Inline the stylesheet or fix the reference, then look again.');
  }

  return lines.join('\n');
}

/**
 * Wrap a fetch so we can read the request we sent and the reply we got, without
 * consuming either from the caller's point of view.
 *
 * ⚠️ A REAL `Response` BODY CAN ONLY BE READ ONCE, and `seePage` reads it. So the
 * observed body is handed back through a duck-typed stand-in carrying exactly
 * the surface `postJson` uses (`ok`, `status`, `statusText`, `text()`). Building
 * a fresh `Response` would be prettier and would throw on null-body statuses —
 * this cannot.
 */
function observingFetch(fetchImpl) {
  const seen = { calls: 0, requestHtml: null, measurement: null };
  const wrapped = async (url, init) => {
    seen.calls += 1;
    try {
      const body = JSON.parse(init?.body ?? '{}');
      seen.requestHtml = typeof body?.html === 'string' ? body.html : null;
    } catch { seen.requestHtml = null; }

    const res = await fetchImpl(url, init);
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    try {
      const parsed = JSON.parse(text);
      seen.measurement = parsed?.measurement ?? parsed?.measurements ?? null;
    } catch { seen.measurement = null; }

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  return { wrapped, seen };
}

/**
 * ── ⭐⭐ THE PASS ────────────────────────────────────────────────────────────
 *
 * Render the page, read what came back, and return something the model can act
 * on plus something the human can look at.
 *
 * The return is a strict SUPERSET of `seePage`'s, deliberately: every existing
 * consumer (`tools.mjs`, `report.mjs`, `parallel.mjs`, `turn.mjs`) reads `ok`,
 * `path`, `screenshot`, `viewport`, `findings` and `looked`, and all six survive
 * unchanged. Wiring this in is a swap, not a migration.
 *
 * Added on top:
 *   · `verdict`            the ~89-token string to put in the tool result
 *   · `trustworthy`        false when the render cannot be believed
 *   · `trust`              why, in detail
 *   · `undetermined`       checks that abstained
 *   · `checked`            checks an all-clear actually covers
 *   · `screenshotAbsolute` the path `renderImage` needs to draw pixels
 *   · `cost`               the measured token comparison, computed per page
 *
 * ⚠️ NEVER THROWS. A picture failing to arrive must not end a coding session.
 */
export async function designPass(root, htmlPath, { env = process.env, fetchImpl = fetch, dryRun = false, seeImpl = seePage } = {}) {
  const { wrapped, seen } = observingFetch(fetchImpl);

  let seen_ = null;
  try {
    seen_ = await seeImpl(root, htmlPath, { env, fetchImpl: wrapped, dryRun });
  } catch (err) {
    seen_ = { ok: false, error: `the render step threw: ${err?.message ?? err}` };
  }
  const looked = seen_?.ok === true && seen_?.looked === true;

  const trust = stylingTrust(seen.requestHtml);
  const coverage = looked ? checkCoverage(seen.measurement) : { known: false, checked: [], undetermined: CHECKS.map((c) => c.label) };

  if (!looked) {
    const error = seen_?.error ?? 'the render step returned nothing usable';
    return {
      ok: false,
      error,
      path: typeof htmlPath === 'string' ? htmlPath : null,
      looked: false,
      trustworthy: false,
      trust,
      screenshot: null,
      screenshotAbsolute: null,
      screenshotBytes: 0,
      viewport: null,
      findings: [],
      checked: [],
      undetermined: coverage.undetermined,
      verdict: buildVerdict({ path: htmlPath, looked: false, error }),
      cost: null,
    };
  }

  /**
   * ⚠️ THE TRUST FINDING GOES FIRST, above the console error, because it
   * invalidates every line under it. Same rule `findingsFrom` applies to console
   * errors, one level up: the thing that explains the others leads.
   *
   * ⚠️ AND IT IS IN `findings`, NOT ONLY IN `verdict`. Downstream readers
   * (`turn.mjs` counts looked-at pages, `report.mjs` summarises) read the array.
   * A warning that exists only in the prose is a warning half the pipeline
   * cannot see — which is how this package keeps shipping dead capability.
   */
  const findings = [];
  if (trust.known && trust.trustworthy === false && trust.reason) findings.push(trust.reason);
  if (trust.known && trust.noCss === true) {
    findings.push('the page carries no CSS at all — no <style> block, no stylesheet link, no style attributes; '
      + 'the browser rendered its own defaults, so this is what the user will see');
  }
  for (const f of Array.isArray(seen_.findings) ? seen_.findings : []) {
    if (!findings.includes(f)) findings.push(f);
  }

  const verdict = buildVerdict({
    path: seen_.path ?? htmlPath,
    viewport: seen_.viewport,
    findings,
    coverage,
    trust,
    looked: true,
    // ⭐ The PNG is already on disk and already returned below as `screenshot`.
    // Until now it never reached the verdict, which is the only thing the model
    // reads — so the file existed and nobody was told where.
    screenshot: seen_.screenshot ?? null,
  });

  const screenshotTokens = imageTokenCost(seen_.viewport?.width, seen_.viewport?.height);
  const verdictTokens = approxTokens(verdict);

  return {
    ok: true,
    path: seen_.path ?? htmlPath,
    looked: true,
    trustworthy: trust.known ? trust.trustworthy : null,
    trust,
    screenshot: seen_.screenshot ?? null,
    /**
     * ⭐ THE HALF THAT SHOWS THE HUMAN. `renderImage` needs an absolute path;
     * `seePage` returns a workspace-relative one because that is what belongs in
     * a summary. Both are returned so neither consumer has to guess.
     */
    screenshotAbsolute: seen_.screenshot ? resolve(root, seen_.screenshot) : null,
    screenshotBytes: seen_.screenshotBytes ?? 0,
    viewport: seen_.viewport ?? null,
    findings: findings.slice(0, 20),
    checked: coverage.checked,
    undetermined: coverage.undetermined,
    verdict,
    cost: {
      verdictChars: verdict.length,
      verdictTokensApprox: verdictTokens,
      screenshotTokens,
      // Abstains rather than dividing by an unknown viewport.
      ratio: screenshotTokens && verdictTokens ? Number((screenshotTokens / verdictTokens).toFixed(1)) : null,
    },
  };
}

/**
 * ── ⭐ AND THEN SHOW THE PICTURE ────────────────────────────────────────────
 *
 * Turn a pass into terminal lines: the verdict, the screenshot path, and — on a
 * terminal that positively speaks kitty or iTerm2 — the actual pixels.
 *
 * ⚠️ THE PATH LINE STAYS EITHER WAY. The image is an ADDITION to the report,
 * never a replacement for it: on Windows Terminal, in CI, or through a pipe,
 * `renderImage` returns nothing at all and the human still gets a file to open.
 *
 * ⚠️ AND IT NEVER THROWS ON JUNK. Being handed a malformed pass must degrade to
 * fewer lines, not to a crashed session over a picture.
 */
export function formatDesignPass(pass, { root = '.', env = process.env, isTTY = process.stdout.isTTY, renderImpl = renderImage } = {}) {
  const out = [];
  if (!pass || typeof pass !== 'object') return out;

  if (typeof pass.verdict === 'string' && pass.verdict.trim()) out.push(pass.verdict);

  if (typeof pass.screenshot === 'string' && pass.screenshot) {
    const kb = Number.isFinite(pass.screenshotBytes) && pass.screenshotBytes > 0
      ? ` (${Math.max(1, Math.round(pass.screenshotBytes / 1024))}KB)`
      : '';
    out.push(`  screenshot: ${pass.screenshot}${kb}`);
    const absolute = typeof pass.screenshotAbsolute === 'string' && pass.screenshotAbsolute
      ? pass.screenshotAbsolute
      : resolve(root, pass.screenshot);
    let drawn = null;
    try { drawn = renderImpl(absolute, { env, isTTY }); } catch { drawn = null; }
    if (drawn?.text) out.push(String(drawn.text).replace(/\n+$/, ''));
  }

  return out;
}
