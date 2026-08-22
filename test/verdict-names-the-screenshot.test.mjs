/**
 * ── ⚠️⚠️ THE SCREENSHOT EXISTED AND NOBODY WAS TOLD WHERE ───────────────────
 *
 * `seePage` renders the page, writes the PNG, and returns its path. `designPass`
 * returned that path too. And `buildVerdict` — the ONLY thing the model ever
 * reads — never mentioned it. So the agent was told "I looked", handed a list of
 * MEASUREMENTS, and given no way to look itself.
 *
 * ⚠️ IT COULD NOT HAVE FOUND IT BY GUESSING EITHER. The file lands in `.acuvo/`
 * and `find_files` refuses to search hidden directories — measured, it returns
 * `skipped: [{path: ".acuvo", reason: "hidden directory, not searched"}]`. Two
 * tools disagreeing about whether that directory exists.
 *
 * ⭐ PROVEN END TO END after the fix: designPass → "SCREENSHOT: .acuvo/render-
 * 1786754031613.png" → `read_image` on that path → "the heading text is: Hello
 * from the design loop". Three finished halves became a loop.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { buildVerdict, designPass } from '../lib/design-loop.mjs';

const base = {
  path: 'page.html',
  viewport: { width: 1280, height: 900 },
  looked: true,
  coverage: { checked: ['console errors', 'text contrast'], undetermined: [] },
};

test('⭐⭐ the verdict NAMES the screenshot, and says what to do with it', () => {
  const v = buildVerdict({ ...base, screenshot: '.acuvo/render-123.png' });
  assert.match(v, /\.acuvo\/render-123\.png/);
  assert.match(v, /read_image/, 'naming a path without naming the verb is half a fix');
});

test('⚠️ it distinguishes MEASUREMENTS from a look', () => {
  /**
   * The findings are contrast ratios and overflow checks — genuinely useful and
   * genuinely not the same as seeing the page. A verdict that offers a
   * screenshot without saying why would invite the model to skip it.
   */
  const v = buildVerdict({ ...base, screenshot: '.acuvo/render-123.png' });
  assert.match(v, /measurements, not a look/i);
});

test('⭐ no screenshot means no line — never a dangling label', () => {
  for (const shot of [null, undefined, '', '   ']) {
    const v = buildVerdict({ ...base, screenshot: shot });
    assert.doesNotMatch(v, /SCREENSHOT/, `screenshot=${JSON.stringify(shot)} produced a label with nothing behind it`);
  }
});

test('⚠️⚠️ a FAILED look still names no screenshot and still forbids a claim', () => {
  // The most important sentence in this file: a page that was never rendered
  // must not acquire a screenshot line, and must still say so.
  const v = buildVerdict({ path: 'page.html', looked: false, error: 'render service down', screenshot: '.acuvo/stale.png' });
  assert.match(v, /COULD NOT LOOK/);
  assert.doesNotMatch(v, /SCREENSHOT/);
  assert.match(v, /do not report it as working/);
});

test('⭐ the existing verdict content is unchanged around it', () => {
  // The screenshot line is additive: every sentence the model already relied on
  // must still be there, in order.
  const v = buildVerdict({ ...base, screenshot: '.acuvo/render-123.png' });
  const lines = v.split('\n');
  assert.match(lines[0], /^LOOKED AT page\.html — 1280×900$/);
  assert.match(v, /No measured problems\. Checked: console errors, text contrast\./);
});

test('⚠️ an all-clear with a screenshot still names its checks', () => {
  // "Fine" and "not measured" must never read the same, screenshot or not.
  const v = buildVerdict({ ...base, screenshot: '.acuvo/x.png' });
  assert.match(v, /Checked:/);
});

/* ── the WIRING, which the unit tests above cannot see ────────────────────── */

test('⚠️⚠️ designPass PASSES the screenshot into the verdict', async () => {
  /**
   * ⭐ A MUTATION FOUND THIS GAP IN MY OWN TESTS. Every assertion above drives
   * `buildVerdict` directly, so replacing designPass's `screenshot:
   * seen_.screenshot` with `null` SURVIVED — the verdict would silently stop
   * naming the file and nothing would go red. That is precisely the
   * built-but-not-connected defect this package loses to most often, reproduced
   * inside the fix for one.
   *
   * `seeImpl` is the existing injection seam, so this costs no network and no
   * money and still exercises the real wiring.
   */
  const fakeSee = async () => ({
    ok: true,
    path: 'page.html',
    looked: true,
    viewport: { width: 1280, height: 900 },
    findings: [],
    screenshot: '.acuvo/render-wired.png',
    screenshotBytes: 4096,
  });

  const r = await designPass('/nowhere', 'page.html', { seeImpl: fakeSee, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.screenshot, '.acuvo/render-wired.png', 'the result must still carry the path');
  assert.match(r.verdict, /\.acuvo\/render-wired\.png/, 'and the MODEL-FACING verdict must name it');
});

test('⚠️ a look that failed still names no screenshot, through the real path', async () => {
  const fakeSee = async () => ({ ok: false, error: 'the render service is down' });
  const r = await designPass('/nowhere', 'page.html', { seeImpl: fakeSee, env: {} });
  assert.doesNotMatch(String(r.verdict ?? ''), /SCREENSHOT/);
});
