/**
 * ── ⚠️⚠️ THE REGRESSION THAT COST US THE WHOLE DIFFERENTIATOR ────────────────
 *
 * `see_page` is the one thing this CLI does that no other terminal coding agent
 * can. It was completely non-functional and nobody noticed, because it failed in
 * the reassuring direction: it read `json.findings` when the service replies
 * `{ ok, measurement: { … } }`, so every call returned an empty finding list
 * with `looked: true` — "I looked and it was fine" — for pages it never saw.
 *
 * ⭐ THE FIXTURE BELOW IS A REAL RESPONSE, not one I invented. It was captured
 * from the live endpoint on 2026-08-10 by POSTing a deliberately broken page
 * (empty `<main>`, near-white text on white, a module that does not exist). A
 * fixture written from memory of a contract is worth nothing here — being wrong
 * about the shape IS the bug this file exists to prevent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsFrom, seePage } from '../lib/media.mjs';

/** Captured live. Trimmed only of the 51KB base64 screenshot. */
const REAL_MEASUREMENT = {
  viewport: { width: 1280, height: 900 },
  oversizedIcons: [],
  scrollWidth: 1280,
  scrollHeight: 900,
  paintedRatio: 0.01975,
  lowContrastText: [{ text: 'invisible', ratio: 1.0502247938385316 }],
  clippedText: [],
  overlaps: [],
  distinctFontSizes: [16],
  sections: [{ tag: 'body', paddingTop: 0, paddingBottom: 0, height: 18, background: '255,255,255' }],
  icons: { groups: [], placeholderIcons: 0 },
  brokenImages: [],
  consoleErrors: [],
  primaryAction: null,
  contrastSource: 'pixels',
};

test('the real measurement produces findings, not silence', () => {
  const f = findingsFrom(REAL_MEASUREMENT);
  assert.ok(f.length >= 2, `expected findings from a broken page, got ${JSON.stringify(f)}`);
  assert.ok(f.some((s) => /almost nothing rendered/.test(s)), 'the blank page must be reported');
  assert.ok(f.some((s) => /unreadable text.*1\.05/.test(s)), 'the invisible text must be reported with its ratio');
});

test('a console error is the FIRST finding — it explains every other one', () => {
  const f = findingsFrom({
    ...REAL_MEASUREMENT,
    consoleErrors: ['Failed to resolve module specifier "./src/board.mjs"'],
  });
  assert.match(f[0], /console error/);
  assert.match(f[0], /board\.mjs/);
});

test('a genuinely fine page yields no findings', () => {
  const f = findingsFrom({
    viewport: { width: 1280, height: 900 },
    scrollWidth: 1280,
    paintedRatio: 0.42,
    lowContrastText: [], clippedText: [], overlaps: [], brokenImages: [], consoleErrors: [],
  });
  assert.deepEqual(f, []);
});

test('sideways scroll is caught — a screenshot cropped to the viewport cannot show it', () => {
  const f = findingsFrom({ viewport: { width: 375, height: 800 }, scrollWidth: 900, paintedRatio: 0.4 });
  assert.ok(f.some((s) => /scrolls sideways.*900px.*375px/.test(s)), JSON.stringify(f));
});

/**
 * ⚠️ THE ANTI-REGRESSION TEST. If the service ever moves the payload again, this
 * must go RED rather than quietly resume issuing all-clears. Reassurance from a
 * shape we do not understand is exactly the failure we are fixing.
 */
test('an unrecognised envelope is an error, never an all-clear', async () => {
  const root = process.cwd();
  const fetchImpl = async () => new Response(JSON.stringify({ ok: true, somethingElse: {} }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const r = await seePage(root, 'package.json', {
    env: { RENDER_AUDIT_URL: 'https://example.invalid/x' },
    fetchImpl,
    dryRun: true,
  });
  assert.equal(r.ok, false, 'a shape we cannot parse must not report looked:true');
  assert.match(r.error, /shape this version does not understand/);
  assert.match(r.error, /somethingElse/, 'the error must name what it did receive');
});

test('the old top-level shape no longer passes as a clean page', async () => {
  // The exact shape the code used to assume. It must now be refused, because
  // believing it is what produced silent all-clears for eighteen commits.
  const fetchImpl = async () => new Response(JSON.stringify({ ok: true, findings: [], viewport: null }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const r = await seePage(process.cwd(), 'package.json', {
    env: { RENDER_AUDIT_URL: 'https://example.invalid/x' },
    fetchImpl,
    dryRun: true,
  });
  assert.equal(r.ok, false);
});

/**
 * ── ⚠️ INLINING READS FILES OFF DISK, SO ITS PATH SAFETY IS THE RISK ─────────
 *
 * `inlineLocalAssets` was shipped on the strength of one live end-to-end render.
 * That proved it WORKS; it proved nothing about what it REFUSES. A function that
 * takes an attacker-influenceable string — and the HTML is written by a language
 * model — and turns it into a file read is exactly the shape that needs the
 * unfriendly tests, not the friendly one.
 */

import { inlineLocalAssets } from '../lib/media.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'inline-'));
  writeFileSync(join(root, 'styles.css'), 'body{background:#123456}');
  mkdirSync(join(root, 'js'), { recursive: true });
  writeFileSync(join(root, 'js', 'app.mjs'), 'console.log("hi")');
  return root;
}

test('a linked stylesheet is inlined, so the page is not rendered naked', () => {
  const root = workspace();
  const r = inlineLocalAssets(root, 'index.html', '<link rel="stylesheet" href="styles.css">');
  assert.match(r.html, /<style>[\s\S]*background:#123456[\s\S]*<\/style>/);
  assert.doesNotMatch(r.html, /<link/);
  assert.deepEqual(r.missing, []);
});

/**
 * ⚠️ THE FINDING IS THE POINT. Rendering silently without the stylesheet is how
 * the original bug hid for its whole life: every measurement passes on an
 * unstyled page, so "no problems" was true and useless.
 */
test('a stylesheet that does not exist becomes a finding, not silence', () => {
  const root = workspace();
  const r = inlineLocalAssets(root, 'index.html', '<link rel="stylesheet" href="nope.css">');
  assert.equal(r.missing.length, 1);
  assert.match(r.missing[0], /nope\.css/);
  assert.match(r.missing[0], /renders unstyled/);
});

test('remote and data references are left alone', () => {
  const root = workspace();
  const html = '<link rel="stylesheet" href="https://cdn.example.com/x.css">'
    + '<img src="data:image/png;base64,AAAA">'
    + '<img src="//example.com/y.png">';
  const r = inlineLocalAssets(root, 'index.html', html);
  assert.equal(r.html, html, 'nothing remote should be touched');
  assert.deepEqual(r.missing, []);
});

test('a preload/icon link is not mistaken for a stylesheet', () => {
  const root = workspace();
  const html = '<link rel="icon" href="styles.css">';
  const r = inlineLocalAssets(root, 'index.html', html);
  assert.equal(r.html, html);
});

/**
 * ⚠️⚠️ THE ONE THAT MATTERS. The HTML is model-authored, so a traversal here
 * would read an arbitrary file and POST it to a remote render service — an
 * exfiltration path dressed as a stylesheet. `resolveInWorkspace` is what stops
 * it, and this test exists so nobody "simplifies" that away.
 */
test('a path escaping the workspace is refused, never read', () => {
  const root = workspace();
  for (const evil of ['../../../etc/passwd', '../../secret.css', 'js/../../../outside.css']) {
    const r = inlineLocalAssets(root, 'index.html', `<link rel="stylesheet" href="${evil}">`);
    assert.doesNotMatch(r.html, /<style>/, `${evil} must not be inlined`);
    assert.equal(r.missing.length, 1, `${evil} must be reported`);
  }
});

test('an absolute path is refused too', () => {
  const root = workspace();
  const r = inlineLocalAssets(root, 'index.html', '<link rel="stylesheet" href="/etc/passwd">');
  assert.doesNotMatch(r.html, /<style>/);
  // Absolute URLs are server-rooted, not ours to resolve — left alone, not reported.
  assert.deepEqual(r.missing, []);
});

test('references resolve relative to the PAGE, not the workspace root', () => {
  const root = workspace();
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(join(root, 'pages', 'local.css'), 'p{color:red}');
  const r = inlineLocalAssets(root, 'pages/about.html', '<link rel="stylesheet" href="local.css">');
  assert.match(r.html, /color:red/);
});

test('a query string on the href still resolves', () => {
  const root = workspace();
  const r = inlineLocalAssets(root, 'index.html', '<link rel="stylesheet" href="styles.css?v=3">');
  assert.match(r.html, /background:#123456/);
});

test('a module script keeps its type when inlined', () => {
  const root = workspace();
  const r = inlineLocalAssets(root, 'index.html', '<script type="module" src="js/app.mjs"></script>');
  assert.match(r.html, /<script type="module">/);
  assert.match(r.html, /console\.log\("hi"\)/);
});

test('an oversized image is skipped and said to be skipped', () => {
  const root = workspace();
  writeFileSync(join(root, 'big.png'), Buffer.alloc(500_000, 1));
  const r = inlineLocalAssets(root, 'index.html', '<img src="big.png">');
  assert.doesNotMatch(r.html, /data:image/);
  assert.match(r.missing[0], /too large/);
});
