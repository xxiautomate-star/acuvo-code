/**
 * ── ⭐⭐ THE AGENT COULD START A SERVER AND NOT LOOK AT IT ───────────────────
 *
 * `start_process` starts a dev server, `check_process` proves it answers, and
 * `see_page` could only ever open a FILE. Three finished halves of one loop that
 * had never been joined — and "run it and look at it" is the shape a web
 * developer actually works in.
 *
 * ⚠️ The render service will not do it for us: measured 2026-08-15, it answers
 * `{"ok":false,"error":"no html supplied"}` to a `url` field. So the CLI fetches
 * the page AND its assets and inlines them exactly as it would for a file.
 *
 * ⭐ PROVEN END TO END against a real server on 127.0.0.1:4711 — the stylesheet
 * was fetched separately, inlined, and `read_image` reported a GREEN heading.
 * Green only happens if `/style.css` arrived; an unstyled page renders black.
 * That is the whole point: without the stylesheet the page has no design and
 * every visual check silently passes.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { loopbackTarget, inlineLocalAssets } from '../lib/media.mjs';

test('⭐ a workspace path is not a url, and still takes the file path', () => {
  for (const p of ['page.html', 'src/index.html', './a.html', '.acuvo/x.html']) {
    assert.equal(loopbackTarget(p).isUrl, false, p);
  }
});

test('⭐⭐ loopback in every spelling is accepted', () => {
  for (const u of [
    'http://localhost:3000/',
    'http://127.0.0.1:4711/',
    'http://127.9.9.9:80/page',
    'http://[::1]:8080/',
    'https://localhost:5173/app',
  ]) {
    const t = loopbackTarget(u);
    assert.equal(t.isUrl, true, u);
    assert.equal(t.ok, true, `${u} should be accepted: ${t.reason ?? ''}`);
  }
});

test('⚠️⚠️ a NON-loopback host is refused — this is a request-forgery boundary', () => {
  /**
   * `see_page` is reachable by a model reading a repository we do not control,
   * so an arbitrary URL is an SSRF primitive: a hostile ACUVO.md could point it
   * at an internal metadata endpoint and read the answer back out, because the
   * page body is inlined and sent onward.
   */
  for (const u of [
    'http://169.254.169.254/latest/meta-data/',
    'http://example.com/',
    'https://10.0.0.5/admin',
    'http://[::ffff:169.254.169.254]/',
  ]) {
    const t = loopbackTarget(u);
    assert.equal(t.ok, false, `${u} must be refused`);
    assert.match(t.reason, /loopback/i);
  }
});

test('⚠️⚠️ a hostname that merely CONTAINS a loopback address is refused', () => {
  // The check that a substring match would fail. This is the classic bypass and
  // it is why the host is parsed and compared rather than searched.
  for (const u of ['http://127.0.0.1.evil.com/', 'http://localhost.attacker.net/', 'http://notlocalhost/']) {
    assert.equal(loopbackTarget(u).ok, false, `${u} must be refused`);
  }
});

test('⭐ the refusal names the tool that CAN read a public page', () => {
  // A refusal that does not say what to do instead reads as a ceiling. The
  // public web already has fetch_url, whose output is text the model reads
  // rather than bytes we render and store.
  assert.match(loopbackTarget('http://example.com/').reason, /fetch_url/);
});

/* ── the asset resolver seam that makes a served page renderable ──────────── */

test('⭐⭐ an injected resolver supplies assets, and the traversal is unchanged', () => {
  const html = '<link rel="stylesheet" href="/style.css"><h1>hi</h1>';
  const out = inlineLocalAssets('', '', html, {
    absolute: true,
    resolveImpl: (u) => (u === '/style.css' ? { buf: Buffer.from('h1{color:#0a5}'), rel: u } : null),
  });
  assert.match(out.html, /<style>[\s\S]*h1\{color:#0a5\}/);
  assert.doesNotMatch(out.html, /<link/, 'the link tag must be replaced, not left beside the style');
  assert.deepEqual(out.missing, []);
});

test('⚠️⚠️ a stylesheet that will not load is REPORTED, never hidden', () => {
  /**
   * The single most valuable finding this tool produces. Without the stylesheet
   * the page has no design at all and every visual check passes on an unstyled
   * page — which is why a silent failure here is worse than no check.
   */
  const out = inlineLocalAssets('', '', '<link rel="stylesheet" href="/style.css"><h1>hi</h1>', {
    absolute: true,
    resolveImpl: () => null,
  });
  assert.equal(out.missing.length, 1);
  assert.match(out.missing[0], /style\.css/);
});

test('⚠️ `absolute` decides whether /root-relative is ours to inline', () => {
  /**
   * Same string, two meanings, decided by where the page came from. A page on
   * DISK cannot resolve `/styles.css` — there is no document root, so treating
   * it as local would mean reading from the filesystem root. A page fetched over
   * HTTP resolves it perfectly well against its own origin.
   */
  const html = '<link rel="stylesheet" href="/style.css">';
  const asFile = inlineLocalAssets('', '', html, { resolveImpl: () => { throw new Error('must not be asked'); } });
  assert.match(asFile.html, /<link/, 'a file must leave a root-relative href alone');
  assert.deepEqual(asFile.missing, []);

  let asked = false;
  inlineLocalAssets('', '', html, { absolute: true, resolveImpl: () => { asked = true; return null; } });
  assert.equal(asked, true, 'a served page must try to resolve it');
});
