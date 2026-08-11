/**
 * ── ⚠️⚠️ WHY THIS FILE EXISTS: A CRITIC THAT CANNOT SEE THE STYLES ───────────
 *
 * MEASURED AGAINST THE LIVE ENDPOINT ON 2026-08-11, twice, same page:
 *
 *   POST { html: '…<link rel="stylesheet" href="styles.css">…' }
 *     -> paintedRatio 0.0986 · lowContrastText [] · clippedText [] · overlaps []
 *        brokenImages [] · consoleErrors []            ⇒ findingsFrom() === []
 *
 *   POST { html: '…<style>body{background:#0b0d10;…}</style>…' }  (same page, styled)
 *     -> paintedRatio 0.1514 · lowContrastText [] · … ⇒ findingsFrom() === []
 *
 * Both are clean. The first one is a page rendered with NO DESIGN AT ALL —
 * black Times on white, bulleted navigation, 1994 — and every check we run
 * legitimately passes on it, because black on white has excellent contrast and
 * 9.8% of the viewport really is painted.
 *
 * ⭐ SO THE MEASUREMENT CANNOT DETECT THIS AND NEVER WILL. The only place the
 * truth is available is the REQUEST: did the HTML we handed the browser still
 * point at a stylesheet the browser could not fetch? That is a fact about bytes
 * we sent, not a judgement about pixels, and it is what this module checks.
 *
 * ── ⚠️ AND THE SECOND HALF: ABSENT IS NOT CLEAN ─────────────────────────────
 * `findingsFrom` reads `(m.lowContrastText ?? [])`. A service that stops
 * measuring contrast therefore reads as a page with perfect contrast. Every
 * check here must be able to say "I could not determine that" — the one
 * sentence a confident critic never says, and the one that keeps it honest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

import {
  designPass,
  buildVerdict,
  checkCoverage,
  stylingTrust,
  imageTokenCost,
  approxTokens,
  formatDesignPass,
  CHECKS,
} from '../lib/design-loop.mjs';

/**
 * ⭐ CAPTURED LIVE 2026-08-11 from the styled render above, not written from
 * memory of a contract. Being wrong about this shape IS the bug the see_page
 * regression was, one layer down.
 */
const REAL = {
  viewport: { width: 1280, height: 900 },
  oversizedIcons: [],
  scrollWidth: 1280,
  scrollHeight: 900,
  paintedRatio: 0.1514450954861111,
  lowContrastText: [],
  clippedText: [],
  overlaps: [],
  distinctFontSizes: [48, 16],
  sections: [{ tag: 'body', paddingTop: 64, paddingBottom: 64, height: 378, background: '11,13,16' }],
  icons: { groups: [], placeholderIcons: 0 },
  brokenImages: [],
  consoleErrors: [],
  primaryAction: null,
  contrastSource: 'pixels',
};

/** A 1×1 PNG — enough to prove a file was written and can be handed to a terminal. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * ⚠️ A UNIQUE URL PER TEST, ALWAYS. The circuit breaker in breaker.mjs is
 * per-process and per-URL: one test that simulates an unreachable endpoint would
 * otherwise make every later test on the same URL return "skipping it rather
 * than waiting again" — a green suite testing nothing.
 */
let endpoint = 0;
const nextUrl = () => `https://render-${++endpoint}.invalid/measure`;

/** A render service that answers with the live envelope, recording what it got. */
function service(measurement = REAL, { withScreenshot = false, sent = [] } = {}) {
  const body = withScreenshot ? { ...measurement, screenshotPngB64: PNG_B64 } : measurement;
  const impl = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, measurement: body }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  impl.sent = sent;
  return impl;
}

/** A workspace with a real multi-file page: index.html + its own stylesheet. */
function siteWithCss() {
  const root = mkdtempSync(join(tmpdir(), 'design-loop-'));
  writeFileSync(join(root, 'styles.css'), 'body{background:#0b0d10;color:#e8eaed;padding:64px}');
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head>'
    + '<body><h1>Hello</h1><p>Copy.</p></body></html>',
  );
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// checkCoverage — absent is NOT clean
// ─────────────────────────────────────────────────────────────────────────────

test('a full measurement reports every check as checked, and abstains on nothing', () => {
  const c = checkCoverage(REAL);
  assert.equal(c.known, true);
  assert.deepEqual(c.undetermined, []);
  assert.equal(c.checked.length, CHECKS.length, JSON.stringify(c));
  assert.ok(c.checked.includes('text contrast'));
});

test('⚠️ a measurement missing a key ABSTAINS on it — it does not read as clean', () => {
  const { lowContrastText, ...withoutContrast } = REAL;
  const c = checkCoverage(withoutContrast);
  assert.ok(c.undetermined.includes('text contrast'), JSON.stringify(c));
  assert.ok(!c.checked.includes('text contrast'));
  // Everything else must still be reported as genuinely checked — abstaining
  // about one thing must not poison the others.
  assert.ok(c.checked.includes('console errors'));
});

test('contrastSource:"none" means contrast was NOT measured, whatever the array says', () => {
  const c = checkCoverage({ ...REAL, lowContrastText: [], contrastSource: 'none' });
  assert.ok(c.undetermined.includes('text contrast'), JSON.stringify(c));
});

test('scrollWidth without a viewport width cannot answer horizontal overflow', () => {
  const c = checkCoverage({ ...REAL, viewport: null });
  assert.ok(c.undetermined.includes('horizontal overflow'), JSON.stringify(c));
});

test('no measurement at all abstains on everything and claims nothing', () => {
  for (const junk of [null, undefined, 'nope', 42]) {
    const c = checkCoverage(junk);
    assert.equal(c.known, false);
    assert.deepEqual(c.checked, []);
    assert.equal(c.undetermined.length, CHECKS.length);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// stylingTrust — the fact that lives in the REQUEST, not the pixels
// ─────────────────────────────────────────────────────────────────────────────

test('an inlined stylesheet is trustworthy — the page reached the browser styled', () => {
  const t = stylingTrust('<html><head><style>body{color:red}</style></head><body><h1>x</h1></body></html>');
  assert.equal(t.known, true);
  assert.equal(t.trustworthy, true);
  assert.equal(t.styled, true);
  assert.deepEqual(t.unresolved, []);
});

test('⚠️⚠️ a leftover local stylesheet link means the page was rendered NAKED', () => {
  const t = stylingTrust('<html><head><link rel="stylesheet" href="styles.css"></head><body>x</body></html>');
  assert.equal(t.trustworthy, false);
  assert.deepEqual(t.unresolved, ['styles.css']);
  assert.match(t.reason, /styles\.css/);
  assert.match(t.reason, /unstyled/i);
});

/**
 * ⚠️⚠️ THE HOLE `inlineLocalAssets` LEAVES OPEN, ON PURPOSE AND CORRECTLY.
 * A root-absolute href is server-rooted, so it is not the workspace's to
 * resolve — media.mjs leaves it alone and reports NOTHING. But the render
 * service is handed HTML text with no server behind it, so `/styles.css` fetches
 * nothing and the page still arrives naked, with no missing-asset finding to
 * explain why. Reading the request is the only thing that catches it.
 */
test('a ROOT-ABSOLUTE stylesheet is caught, though nothing upstream reports it', () => {
  const t = stylingTrust('<html><head><link rel="stylesheet" href="/styles.css"></head><body>x</body></html>');
  assert.equal(t.trustworthy, false);
  assert.deepEqual(t.unresolved, ['/styles.css']);
});

test('a remote stylesheet is fine — the browser really can fetch it', () => {
  const t = stylingTrust('<link rel="stylesheet" href="https://cdn.example.com/x.css"><body>x</body>');
  assert.equal(t.trustworthy, true);
  assert.equal(t.styled, true);
  assert.deepEqual(t.unresolved, []);
});

test('a style attribute counts as styling', () => {
  const t = stylingTrust('<body><h1 style="color:#fff">x</h1></body>');
  assert.equal(t.styled, true);
  assert.equal(t.noCss, false);
});

test('a page with no CSS at all is reported as such — that IS the defect', () => {
  const t = stylingTrust('<html><body><h1>Hello</h1><ul><li>a</li></ul></body></html>');
  assert.equal(t.trustworthy, true, 'the render is faithful — the page simply has no design');
  assert.equal(t.noCss, true);
  assert.equal(t.styled, false);
});

/**
 * ⚠️ A CHECK THAT FAILS CORRECT WORK IS WORSE THAN NO CHECK. Each of these is a
 * legitimate page that a naive regex would accuse.
 */
test('legitimate shapes are not accused', () => {
  // A commented-out link is not a link.
  assert.deepEqual(
    stylingTrust('<!-- <link rel="stylesheet" href="old.css"> --><style>p{color:red}</style>').unresolved,
    [],
  );
  // A page whose CSS is injected by script must ABSTAIN on "no CSS", not accuse.
  const scripted = stylingTrust('<html><body><script>document.head.append(document.createElement("style"))</script></body></html>');
  assert.equal(scripted.noCss, false, 'a script may inject the CSS — abstain rather than accuse');
  // An empty style block is not styling.
  assert.equal(stylingTrust('<style>   </style><body>x</body>').styled, false);
  // A preload/icon link is not a stylesheet.
  assert.deepEqual(stylingTrust('<link rel="icon" href="favicon.ico"><style>a{color:red}</style>').unresolved, []);
  // Empty, huge, non-ASCII and CRLF input must not throw.
  assert.equal(stylingTrust('').known, true);
  assert.equal(stylingTrust('<p>Ünïcodé — 日本語</p>\r\n<style>p{color:red}</style>\r\n').styled, true);
  assert.equal(stylingTrust(`<style>${'a{color:red}'.repeat(50_000)}</style>`).styled, true);
});

test('an unobserved request abstains rather than assuming the page was styled', () => {
  const t = stylingTrust(null);
  assert.equal(t.known, false);
  assert.equal(t.trustworthy, null);
  assert.deepEqual(t.unresolved, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// The token arithmetic — the actual defensible claim
// ─────────────────────────────────────────────────────────────────────────────

test('image token cost is computed from the real viewport, not quoted', () => {
  // 1280×900 fits under the 1568px long-edge limit: 1,152,000 / 750.
  assert.equal(imageTokenCost(1280, 900), 1536);
  // A 4K-tall page is scaled down first, exactly as the model host would.
  assert.ok(imageTokenCost(1280, 4000) < imageTokenCost(1280, 1568) * 1.1);
  for (const junk of [0, -1, NaN, Infinity, null, undefined, '1280']) {
    assert.equal(imageTokenCost(junk, junk), null, `${junk} must abstain, not guess`);
  }
});

test('token estimation survives empty, huge and non-ASCII text', () => {
  assert.equal(approxTokens(''), 0);
  assert.equal(approxTokens(null), 0);
  assert.equal(approxTokens('abcd'), 1);
  // Non-ASCII is not four-characters-per-token; counting it as one each is the
  // honest direction to be wrong in (it over-counts our own side).
  assert.ok(approxTokens('日本語') >= 3);
  assert.ok(approxTokens('a'.repeat(400_000)) === 100_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// buildVerdict — the 89-token return value, and what it must never say
// ─────────────────────────────────────────────────────────────────────────────

const cleanArgs = {
  path: 'index.html',
  viewport: { width: 1280, height: 900 },
  findings: [],
  coverage: checkCoverage(REAL),
  trust: stylingTrust('<style>body{color:red}</style><body>x</body>'),
  looked: true,
};

test('a clean verdict NAMES WHAT IT CHECKED, so "fine" cannot be confused with "unchecked"', () => {
  const v = buildVerdict(cleanArgs);
  assert.match(v, /LOOKED AT index\.html/);
  assert.match(v, /1280×900/);
  assert.match(v, /No measured problems/);
  assert.match(v, /text contrast/, 'an all-clear must list the checks it is an all-clear FOR');
});

test('⚠️⚠️ an untrustworthy render is NEVER phrased as an all-clear', () => {
  const trust = stylingTrust('<link rel="stylesheet" href="styles.css"><body>x</body>');
  const v = buildVerdict({
    ...cleanArgs,
    trust,
    findings: [trust.reason],
  });
  assert.doesNotMatch(v, /No measured problems/, 'this is the false all-clear that shipped four naked pages');
  assert.match(v, /not an all-clear/i);
  assert.match(v, /styles\.css/);
});

/**
 * ⚠️ THE DEFENSIVE BRANCH, TESTED SO IT IS NOT DEAD CODE. `designPass` always
 * folds the trust failure into `findings`, so a caller coming through it can
 * never reach this shape. But `buildVerdict` is exported and a future caller
 * may pass an untrustworthy trust with an empty findings list — and if that
 * printed "No measured problems", the naked-page bug would be back through a
 * side door. Mutation-tested: deleting the guard turns this red.
 */
test('⚠️ an untrustworthy render with NO findings still refuses to say "no problems"', () => {
  const trust = stylingTrust('<link rel="stylesheet" href="styles.css"><body>x</body>');
  const v = buildVerdict({ ...cleanArgs, trust, findings: [] });
  assert.doesNotMatch(v, /No measured problems/);
  assert.match(v, /not an all-clear/i);
});

test('the unstyled finding comes FIRST — it explains every finding under it', () => {
  const trust = stylingTrust('<link rel="stylesheet" href="a.css"><body>x</body>');
  const v = buildVerdict({
    ...cleanArgs,
    trust,
    findings: [trust.reason, 'unreadable text (contrast 1.05:1, needs 4.5): invisible'],
  });
  const lines = v.split('\n');
  assert.match(lines[1], /^1\. /);
  assert.match(lines[1], /a\.css/);
});

test('checks that were not measured are stated as NOT CHECKED, never omitted', () => {
  const { clippedText, ...partial } = REAL;
  const v = buildVerdict({ ...cleanArgs, coverage: checkCoverage(partial) });
  assert.match(v, /NOT CHECKED/);
  assert.match(v, /clipped text/);
});

test('⚠️ a failed look makes NO visual claim and forbids one', () => {
  const v = buildVerdict({ path: 'index.html', looked: false, error: 'HTTP 502: boom' });
  assert.match(v, /COULD NOT LOOK/);
  assert.match(v, /HTTP 502/);
  assert.doesNotMatch(v, /No measured problems/);
  assert.match(v, /do not report it as working/i);
});

test('the verdict is an order of magnitude cheaper than the screenshot it replaces', () => {
  const v = buildVerdict(cleanArgs);
  const verdictTokens = approxTokens(v);
  const shotTokens = imageTokenCost(1280, 900);
  assert.ok(verdictTokens < 150, `the verdict must stay compact, got ${verdictTokens} tokens:\n${v}`);
  assert.ok(shotTokens / verdictTokens > 8, `expected a large ratio, got ${shotTokens}/${verdictTokens}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// designPass — the loop, end to end
// ─────────────────────────────────────────────────────────────────────────────

test('⭐ A MULTI-FILE PAGE ARRIVES STYLED — the CSS text is physically in the request', async () => {
  const root = siteWithCss();
  const sent = [];
  const pass = await designPass(root, 'index.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(REAL, { sent }),
    dryRun: true,
  });
  assert.equal(pass.ok, true, pass.error);
  assert.equal(sent.length, 1, 'the render service must have been called exactly once');
  assert.match(sent[0].html, /background:#0b0d10/, 'the stylesheet must travel with the page');
  assert.doesNotMatch(sent[0].html, /<link/, 'the link must have been replaced, not merely accompanied');
  assert.equal(pass.trustworthy, true);
  assert.equal(pass.trust.styled, true);
  assert.match(pass.verdict, /No measured problems/);
});

test('⚠️⚠️ the same page with a MISSING stylesheet is not reported as fine', async () => {
  const root = mkdtempSync(join(tmpdir(), 'design-loop-naked-'));
  writeFileSync(join(root, 'index.html'), '<link rel="stylesheet" href="styles.css"><body><h1>Hello</h1></body>');
  const pass = await designPass(root, 'index.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(REAL),
    dryRun: true,
  });
  assert.equal(pass.ok, true);
  assert.equal(pass.trustworthy, false, 'the measurement is clean — that is exactly the trap');
  assert.ok(pass.findings.length > 0, 'a naked render must produce findings even when nothing is measurable');
  assert.match(pass.verdict, /not an all-clear/i);
  assert.doesNotMatch(pass.verdict, /No measured problems/);
});

test('⚠️ a root-absolute stylesheet is caught end to end, though media.mjs reports nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'design-loop-abs-'));
  writeFileSync(join(root, 'index.html'), '<link rel="stylesheet" href="/styles.css"><body><h1>Hi</h1></body>');
  const pass = await designPass(root, 'index.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(REAL),
    dryRun: true,
  });
  assert.equal(pass.trustworthy, false, JSON.stringify(pass.findings));
  assert.ok(pass.findings.some((f) => f.includes('/styles.css')), JSON.stringify(pass.findings));
});

test('a page with no CSS at all is told so, once, as a finding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'design-loop-nocss-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body><h1>Hello</h1><ul><li>a</li></ul></body></html>');
  const pass = await designPass(root, 'index.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(REAL),
    dryRun: true,
  });
  assert.equal(pass.trustworthy, true, 'the render is faithful; the page is just undesigned');
  assert.ok(pass.findings.some((f) => /no CSS/i.test(f)), JSON.stringify(pass.findings));
});

test('⭐ the screenshot comes back as an ABSOLUTE path a terminal can draw', async () => {
  const root = siteWithCss();
  const pass = await designPass(root, 'index.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(REAL, { withScreenshot: true }),
  });
  assert.ok(pass.screenshot, 'the workspace-relative path must survive for the summary');
  assert.ok(isAbsolute(pass.screenshotAbsolute), pass.screenshotAbsolute);
  assert.ok(pass.screenshotBytes > 0, 'a screenshot reported as 0 bytes reads as a failed write');
});

test('the cost accounting is computed, not asserted', async () => {
  const root = siteWithCss();
  const pass = await designPass(root, 'index.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(REAL),
    dryRun: true,
  });
  assert.equal(pass.cost.verdictChars, pass.verdict.length);
  assert.equal(pass.cost.screenshotTokens, imageTokenCost(1280, 900));
  assert.ok(pass.cost.ratio > 8, JSON.stringify(pass.cost));
});

test('⚠️ the raw findings from the measurement still arrive — this wraps, it does not replace', async () => {
  const root = siteWithCss();
  const broken = {
    ...REAL,
    paintedRatio: 0.0198,
    lowContrastText: [{ text: 'invisible', ratio: 1.0502 }],
    consoleErrors: ['Failed to resolve module specifier "./src/board.mjs"'],
  };
  const pass = await designPass(root, 'index.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(broken),
    dryRun: true,
  });
  assert.ok(pass.findings.some((f) => /board\.mjs/.test(f)), JSON.stringify(pass.findings));
  assert.ok(pass.findings.some((f) => /almost nothing rendered/.test(f)));
  assert.ok(pass.findings.some((f) => /1\.05/.test(f)));
  assert.match(pass.verdict, /^1\. console error/m, 'the console error must still lead');
});

test('⚠️ a service failure is a refusal, never a quiet all-clear', async () => {
  const root = siteWithCss();
  const pass = await designPass(root, 'index.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: async () => new Response('nope', { status: 502 }),
    dryRun: true,
  });
  assert.equal(pass.ok, false);
  assert.equal(pass.looked, false);
  assert.deepEqual(pass.findings, []);
  assert.match(pass.verdict, /COULD NOT LOOK/);
  assert.match(pass.error, /502/);
  // Every check must be listed as unanswered, so nothing downstream can read
  // "no findings" as "no problems".
  assert.equal(pass.undetermined.length, CHECKS.length);
});

test('⚠️ an envelope we do not understand is refused, not reassured about', async () => {
  const root = siteWithCss();
  const pass = await designPass(root, 'index.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, somethingElse: {} }), { status: 200 }),
    dryRun: true,
  });
  assert.equal(pass.ok, false);
  assert.match(pass.error, /shape this version does not understand/);
  assert.match(pass.verdict, /COULD NOT LOOK/);
});

test('no render service configured is said plainly, and looked is false', async () => {
  const pass = await designPass(siteWithCss(), 'index.html', { env: {}, dryRun: true });
  assert.equal(pass.ok, false);
  assert.equal(pass.looked, false);
  assert.match(pass.error, /RENDER_AUDIT_URL/);
});

test('a missing file fails honestly and does not pretend to have looked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'design-loop-gone-'));
  const pass = await designPass(root, 'nope.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(REAL),
    dryRun: true,
  });
  assert.equal(pass.ok, false);
  assert.equal(pass.looked, false);
  assert.match(pass.verdict, /COULD NOT LOOK/);
});

test('⚠️ designPass never throws, whatever the transport does', async () => {
  const root = siteWithCss();
  for (const impl of [
    async () => { throw new Error('socket exploded'); },
    async () => 'not a response at all',
    async () => new Response('', { status: 200 }),
  ]) {
    const pass = await designPass(root, 'index.html', {
      env: { RENDER_AUDIT_URL: nextUrl() },
      fetchImpl: impl,
      dryRun: true,
    });
    assert.equal(pass.ok, false, `impl should fail cleanly, got ${JSON.stringify(pass)}`);
    assert.equal(typeof pass.verdict, 'string');
  }
});

test('CRLF and non-ASCII pages survive the whole loop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'design-loop-crlf-'));
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'ünïcode.css'), 'body{color:#fff}\r\n');
  writeFileSync(
    join(root, 'pages', 'ünïcode.html'),
    '<!doctype html>\r\n<link rel="stylesheet" href="ünïcode.css">\r\n<body><h1>日本語 — Ünïcodé</h1></body>\r\n',
  );
  const sent = [];
  const pass = await designPass(root, 'pages/ünïcode.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(REAL, { sent }),
    dryRun: true,
  });
  assert.equal(pass.ok, true, pass.error);
  assert.match(sent[0].html, /日本語/, 'the page content must survive the round trip intact');
  assert.match(sent[0].html, /color:#fff/, 'a non-ASCII CRLF stylesheet must still be inlined');
  assert.equal(pass.trustworthy, true);
});

/**
 * ── ⚠️⚠️ A REAL HOLE, FOUND BY THIS TEST AND NOT FIXABLE FROM THIS LANE ──────
 *
 * `pages/about.html` linking `../styles.css` is the single most common shape a
 * multi-page site takes. `normalizeRelativePath` refuses ANY `..` segment —
 * structurally, deliberately, even when the result stays inside the workspace —
 * so `inlineLocalAssets` cannot resolve it and the page is POSTed with the link
 * intact. It renders naked, and every measured check passes on it.
 *
 * ⭐ The loop's job is not to fix that here; it is to make sure the pass can
 * never come back reading "fine". Verified below: the render is marked
 * UNRELIABLE and the offending href is named.
 */
test('⚠️ a ../ stylesheet cannot be inlined — the pass says UNRELIABLE, never "fine"', async () => {
  const root = mkdtempSync(join(tmpdir(), 'design-loop-dotdot-'));
  writeFileSync(join(root, 'styles.css'), 'body{color:#fff}');
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'about.html'), '<link rel="stylesheet" href="../styles.css"><body><h1>About</h1></body>');
  const sent = [];
  const pass = await designPass(root, 'pages/about.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(REAL, { sent }),
    dryRun: true,
  });
  assert.equal(pass.ok, true);
  assert.doesNotMatch(sent[0].html, /color:#fff/, 'documents the gap: the sibling CSS never travels');
  assert.equal(pass.trustworthy, false, 'the measurement is clean; the render is not believable');
  assert.ok(pass.findings.some((f) => f.includes('../styles.css')), JSON.stringify(pass.findings));
  assert.match(pass.verdict, /not an all-clear/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// formatDesignPass — the half that shows the human the actual page
// ─────────────────────────────────────────────────────────────────────────────

test('⭐ the picture is DRAWN on a terminal that speaks the protocol', async () => {
  const root = siteWithCss();
  const pass = await designPass(root, 'index.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(REAL, { withScreenshot: true }),
  });
  const lines = formatDesignPass(pass, { root, env: { KITTY_WINDOW_ID: '1' }, isTTY: true });
  const joined = lines.join('\n');
  assert.match(joined, /LOOKED AT index\.html/);
  assert.match(joined, /screenshot: /);
  assert.ok(joined.includes('\x1b_G'), 'kitty must receive actual pixels, not a description');
});

test('⚠️ a terminal we do not recognise gets the path and NOT a byte of escape garbage', async () => {
  const root = siteWithCss();
  const pass = await designPass(root, 'index.html', {
    env: { RENDER_AUDIT_URL: nextUrl() },
    fetchImpl: service(REAL, { withScreenshot: true }),
  });
  const joined = formatDesignPass(pass, { root, env: {}, isTTY: true }).join('\n');
  assert.match(joined, /screenshot: /);
  assert.ok(!joined.includes('\x1b'), 'an unrecognised terminal must never receive an escape sequence');
});

test('formatting a failed pass still prints the refusal and never an image', () => {
  const lines = formatDesignPass(
    { ok: false, looked: false, verdict: 'COULD NOT LOOK at x.html — boom.', screenshot: null },
    { root: '.', env: { KITTY_WINDOW_ID: '1' }, isTTY: true },
  );
  assert.match(lines.join('\n'), /COULD NOT LOOK/);
  assert.ok(!lines.join('\n').includes('\x1b_G'));
});

test('formatDesignPass tolerates junk instead of crashing a session over a picture', () => {
  for (const junk of [null, undefined, {}, { verdict: null, screenshot: 'x.png' }]) {
    assert.ok(Array.isArray(formatDesignPass(junk, { root: '.', env: {}, isTTY: false })));
  }
});
