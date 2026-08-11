/**
 * ── ⚠️ WHAT THESE TESTS ARE FOR, AND WHAT THEY DELIBERATELY DO NOT DO ────────
 *
 * `fetch_url` takes a string chosen by a language model and opens a socket with
 * it. The interesting behaviour of this module is therefore not "does it return
 * a document" — it is everything it REFUSES: a scheme, a private address, a
 * redirect into one, a content type, a header the model tried to add, the
 * eleventh crawl of a session.
 *
 * ⚠️ THE SSRF GUARD IS NEVER DISABLED FOR THE TESTS. There is no test-only
 * bypass flag, because a guard with a bypass flag is a guard with a bypass. The
 * two seams used here are honest ones:
 *
 *   · `lookupImpl` — the DNS answer. Injecting it means the guard runs its real
 *     logic on a deterministic address instead of on whatever the network says
 *     today, so the "public host redirects to 127.0.0.1" case is testable at
 *     all. The GUARD is under test; only the resolver is stubbed.
 *   · `fetchImpl`  — one hop of transport. For most cases it is a stub, and for
 *     the real-socket test it is `rawHttpRequest` pointed at a `node:http`
 *     server on 127.0.0.1 — reachable ONLY because the test rewrote the URL
 *     inside the injection, which is exactly the arrangement the guard forbids
 *     the model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

import {
  fetchText, htmlToText, isBlockedAddress, fetchToolSchemas, rawHttpRequest,
  resetFetchState, DEFAULT_WINDOW, MAX_FETCHES_PER_PROCESS, MAX_FETCHES_PER_HOST,
} from '../lib/fetch-text.mjs';

const ws = () => mkdtempSync(join(tmpdir(), 'acuvo-fetch-'));

/** A resolver that says "this hostname is a normal public server". */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
/** A transport that fails the test loudly if anything opens a socket. */
const noSocket = () => { throw new Error('a socket was opened for a request that must have been refused'); };

/** Build a one-hop stub transport and a call counter. */
function stub(responses) {
  const calls = [];
  const impl = async ({ url, headers }) => {
    calls.push({ url, headers });
    const r = typeof responses === 'function' ? responses(url, calls.length) : responses;
    if (!r) throw new Error(`no stubbed response for ${url}`);
    return {
      status: r.status ?? 200,
      headers: r.headers ?? { 'content-type': 'text/plain' },
      body: Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body ?? '', 'utf8'),
      truncated: Boolean(r.truncated),
    };
  };
  return { impl, calls };
}

/* ────────────────────────────────────────────────────────────────────────────
 * htmlToText — the part a fixture can pin down exactly
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Shaped like a nodejs.org API page: a head full of scripts, a nav, a heading,
 * a signature list, and the thing the model actually came for — a `<pre><code>`
 * sample whose indentation carries the meaning.
 */
const NODE_DOC_FIXTURE = `<!DOCTYPE html>
<html><head>
  <title>Test runner | Node.js v22 Documentation</title>
  <link rel="stylesheet" href="/static/style.css">
  <script src="/static/js/api.js"></script>
</head>
<body>
<script>window.dataLayer = [{"tracking":"yes"}];</script>
<style>.api { color: red }</style>
<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>
<nav><ul><li><a href="#a">Test runner</a></li><li><a href="#b">Mocking</a></li></ul></nav>
<h2>mock.timers.enable([enableOptions])</h2>
<p>Enables timer mocking for the specified timers &amp; sets <code>Date</code> too.</p>



<ul>
  <li><code>enableOptions</code> &lt;Object&gt; Optional configuration.</li>
  <li>Default: <code>{ apis: [&#39;setInterval&#39;] }</code></li>
</ul>
<pre><code class="language-js">import { mock } from 'node:test';

mock.timers.enable({
  apis: ['setTimeout'],
  now: 0,
});
</code></pre>
<noscript>Enable JavaScript.</noscript>
</body></html>`;

test('htmlToText keeps <pre> newlines and indentation — the code block is why the page was fetched', () => {
  const text = htmlToText(NODE_DOC_FIXTURE);
  assert.match(text, /import \{ mock \} from 'node:test';\n\nmock\.timers\.enable\(\{\n {2}apis: \['setTimeout'\],\n {2}now: 0,\n\}\);/,
    `the code sample lost its shape:\n${text}`);
});

test('htmlToText drops script, style, svg, noscript and the whole head', () => {
  const text = htmlToText(NODE_DOC_FIXTURE);
  assert.ok(!text.includes('dataLayer'), 'inline script body leaked');
  assert.ok(!text.includes('color: red'), 'stylesheet body leaked');
  assert.ok(!text.includes('M0 0h24v24H0z'), 'svg path data leaked');
  assert.ok(!text.includes('Enable JavaScript'), 'noscript leaked');
  assert.ok(!text.includes('Node.js v22 Documentation'), 'head contents leaked');
});

test('htmlToText decodes entities, including the ones a code sample depends on', () => {
  const text = htmlToText(NODE_DOC_FIXTURE);
  assert.ok(text.includes('timers &'), `&amp; not decoded:\n${text}`);
  assert.ok(text.includes('<Object>'), '&lt;Object&gt; not decoded');
  assert.ok(text.includes("{ apis: ['setInterval'] }"), '&#39; not decoded');
  assert.ok(!text.includes('&amp;'), 'a raw entity survived');
});

test('htmlToText collapses 3+ blank lines to 2 and leaves no markup behind', () => {
  const text = htmlToText(NODE_DOC_FIXTURE);
  assert.ok(!/\n{3,}/.test(text), `blank-line runs survived:\n${JSON.stringify(text)}`);
  // ⚠️ Not `/</` — the page legitimately CONTAINS `<Object>` once `&lt;` is
  // decoded, and asserting "no angle brackets" would fail on correct output.
  // The check has to name tags, which is the thing that must not survive.
  assert.ok(!/<\/?(p|div|li|ul|nav|span|a|h[1-6]|pre|code|body|html)\b/i.test(text), `a tag survived:\n${text}`);
  assert.match(text, /mock\.timers\.enable\(\[enableOptions\]\)/, 'the heading is missing');
  assert.match(text, /- Test runner/, 'list items should read as a list');
});

/**
 * ── ⚠️ THE REGRESSION THE FIXTURE ABOVE COULD NOT CATCH ──────────────────────
 * Captured from https://nodejs.org/api/test.html on 2026-08-10: the document is
 * minified and has NO opening `<head>` tag at all (it is optional in HTML), just
 * a closing one. The paired-tag rule matched nothing and the entire head — title,
 * meta, the lot — went to the model. `<head` did appear at index 5750, inside
 * `<header class=header>`, which is how the bug read as "working" at a glance.
 */
test('an IMPLICIT head — NO head tags at all, which is what nodejs.org actually sends — is still dropped', () => {
  // ⚠️ Note what is NOT in this string: no `<head>`, no `</head>`. The live page
  // has neither. It does have `<header>`, which is what made both earlier rules
  // look like they were matching something.
  const real = '<!DOCTYPE html><html lang=en><meta charset=utf-8>'
    + '<title>Test runner | Node.js v26.7.0 Documentation</title>'
    + '<link rel=stylesheet href=/static/style.css>'
    + '<body><header class=header>Node.js</header><h2>Real content</h2><p>Body text.</p></body></html>';
  const text = htmlToText(real);
  assert.ok(!text.includes('Documentation'), `the implicit head survived:\n${text}`);
  assert.ok(!text.includes('style.css'), 'a head <link> survived');
  assert.match(text, /Real content/);
  assert.match(text, /Body text\./);
});

test('an explicit </head> with no opening tag is honoured too', () => {
  const text = htmlToText('<html><title>Gone</title></head><h2>Kept</h2>');
  assert.ok(!text.includes('Gone'));
  assert.match(text, /Kept/);
});

test('a page that merely QUOTES </head> in a code sample is not truncated at it', () => {
  const text = htmlToText('<html><body><h2>Docs</h2><pre>&lt;/head&gt;\n&lt;body&gt;</pre><p>after</p></body></html>');
  assert.match(text, /Docs/, 'content before the quoted tag must survive');
  assert.match(text, /after/);
});

test('htmlToText survives a document cut off mid-script rather than leaking the script', () => {
  const text = htmlToText('<p>hi</p><script>var secret = "' + 'x'.repeat(50) + '";');
  assert.equal(text, 'hi');
});

/* ────────────────────────────────────────────────────────────────────────────
 * isBlockedAddress — the decision the whole tool rests on
 * ──────────────────────────────────────────────────────────────────────────── */

test('isBlockedAddress refuses every private, loopback, link-local and unique-local form', () => {
  const blocked = [
    '127.0.0.1', '127.9.9.9', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255',
    '255.255.255.255', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::127.0.0.1',
    // Fails closed on anything it cannot parse — including the octal spelling of
    // loopback, which some resolvers still accept.
    '0177.0.0.1', '0x7f.1', 'not-an-ip', '', '   ', null, undefined, 12345,
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedAddress(ip), true, `${JSON.stringify(ip)} should be blocked`);
  }
});

test('isBlockedAddress allows ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.32.0.1', '172.15.0.1',
    '100.63.255.255', '100.128.0.1', '2606:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * REFUSALS
 * ──────────────────────────────────────────────────────────────────────────── */

test('file:// is refused by name, and points at the tool that can do it', async () => {
  resetFetchState();
  const r = await fetchText({
    root: ws(), url: 'file:///C:/Windows/win.ini', fetchImpl: noSocket, lookupImpl: noSocket,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /"file:" is refused/);
  assert.match(r.error, /read_file/, 'the refusal must name what to do instead');
});

test('every other scheme is refused by name too', async () => {
  resetFetchState();
  for (const url of ['data:text/html,<b>x</b>', 'ftp://example.com/x', 'ws://example.com/x']) {
    const r = await fetchText({ root: ws(), url, fetchImpl: noSocket, lookupImpl: noSocket });
    assert.equal(r.ok, false, `${url} should be refused`);
    assert.match(r.error, /http and https only/);
  }
});

test('the cloud metadata endpoint is refused before any socket opens', async () => {
  resetFetchState();
  // ⚠️ No lookupImpl — the REAL resolver runs. A literal IP resolves locally, so
  // this exercises the production path end to end and still opens nothing.
  const r = await fetchText({
    root: ws(), url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    fetchImpl: noSocket,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot reach private or local addresses/);
  assert.match(r.error, /169\.254\.169\.254/, 'the refusal must name the address it resolved to');
});

test('localhost and a RFC1918 host are refused the same way', async () => {
  resetFetchState();
  for (const url of ['http://127.0.0.1:3000/', 'http://[::1]:8080/', 'http://192.168.0.10/admin']) {
    const r = await fetchText({ root: ws(), url, fetchImpl: noSocket });
    assert.equal(r.ok, false, `${url} should be refused`);
    assert.match(r.error, /cannot reach private or local addresses/);
  }
});

test('a public host that resolves to loopback is refused — the guard checks the ADDRESS, not the name', async () => {
  resetFetchState();
  const r = await fetchText({
    root: ws(),
    url: 'https://totally-normal.example.com/x',
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    fetchImpl: noSocket,
  });
  assert.equal(r.ok, false, 'ONE blocked record must refuse the whole hop');
  assert.match(r.error, /127\.0\.0\.1/);
});

test('a redirect from a public host into 127.0.0.1 is refused at hop 2', async () => {
  resetFetchState();
  const t = stub({ status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } });
  const r = await fetchText({
    root: ws(), url: 'https://docs.example.com/start', lookupImpl: publicLookup, fetchImpl: t.impl,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot reach private or local addresses/);
  assert.equal(t.calls.length, 1, 'the second hop must never be requested');
});

test('credentials in the URL are refused', async () => {
  resetFetchState();
  const r = await fetchText({
    root: ws(), url: 'https://user:hunter2@docs.example.com/x', lookupImpl: publicLookup, fetchImpl: noSocket,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /embeds credentials/);
});

test('image/png is refused naming the type, not with a shrug', async () => {
  resetFetchState();
  const t = stub({ headers: { 'content-type': 'image/png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  const r = await fetchText({
    root: ws(), url: 'https://docs.example.com/logo.png', lookupImpl: publicLookup, fetchImpl: t.impl,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /is image\/png/);
});

test('an unknown argument key is refused BY NAME — the model must not think a header was sent', async () => {
  resetFetchState();
  const r = await fetchText({
    root: ws(), url: 'https://docs.example.com/x', headers: { authorization: 'Bearer sk-live-123' },
    lookupImpl: publicLookup, fetchImpl: noSocket,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not accept "headers"/);
  assert.match(r.error, /url, offset and limit/);
});

test('the injection seams cannot be reached from JSON arguments', async () => {
  resetFetchState();
  const r = await fetchText({ root: ws(), url: 'https://docs.example.com/x', fetchImpl: 'http://evil/' });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not accept "fetchImpl"/);
});

test('a non-2xx returns the status AND the body, capped at 500 characters', async () => {
  resetFetchState();
  const t = stub({ status: 404, headers: { 'content-type': 'text/plain' }, body: 'moved to /api/test.html ' + 'z'.repeat(2000) });
  const r = await fetchText({
    root: ws(), url: 'https://docs.example.com/gone', lookupImpl: publicLookup, fetchImpl: t.impl,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 404/);
  assert.match(r.error, /moved to \/api\/test\.html/, 'the body names the fix — it must survive');
  assert.ok(r.error.length < 700, `error was ${r.error.length} chars — the body cap did not apply`);
});

/* ────────────────────────────────────────────────────────────────────────────
 * WINDOWING AND CACHE — the direct fix for the re-fetch-and-re-slice loop
 * ──────────────────────────────────────────────────────────────────────────── */

const BIG = Array.from({ length: 300_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');

test('a 300KB document returns exactly 6000 chars with nextOffset 6000, and the cache holds all of it', async () => {
  resetFetchState();
  const root = ws();
  const t = stub({ headers: { 'content-type': 'text/plain' }, body: BIG });
  const r = await fetchText({ root, url: 'https://docs.example.com/big.txt', lookupImpl: publicLookup, fetchImpl: t.impl });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.text.length, DEFAULT_WINDOW);
  assert.equal(r.nextOffset, DEFAULT_WINDOW);
  assert.equal(r.totalChars, 300_000);
  assert.equal(r.fromCache, false);
  assert.ok(r.cachePath.startsWith('.acuvo/fetch/'), `cachePath was ${r.cachePath}`);
  assert.equal(readFileSync(join(root, r.cachePath), 'utf8').length, 300_000,
    'the WHOLE document must be on disk, or the later windows are not free');
  assert.equal(t.calls.length, 1);
});

test('paging by nextOffset reconstructs the document byte-for-byte, with ONE request', async () => {
  resetFetchState();
  const root = ws();
  const t = stub({ headers: { 'content-type': 'text/plain' }, body: BIG });
  const url = 'https://docs.example.com/big.txt';

  let out = '';
  let offset = 0;
  let windows = 0;
  for (;;) {
    const r = await fetchText({ root, url, offset, limit: 12_000, lookupImpl: publicLookup, fetchImpl: t.impl });
    assert.equal(r.ok, true, r.error);
    out += r.text;
    windows += 1;
    if (r.nextOffset === null) break;
    offset = r.nextOffset;
    assert.ok(windows < 40, 'paging did not terminate');
  }
  assert.equal(out, BIG, 'the reassembled document differs from the original');
  assert.equal(windows, 25);
  assert.equal(t.calls.length, 1, 'every window after the first must come from the cache');
});

test('a second fetch of the same URL is served fromCache with no request at all', async () => {
  resetFetchState();
  const root = ws();
  const t = stub({ headers: { 'content-type': 'text/plain' }, body: 'hello docs' });
  const url = 'https://docs.example.com/small.txt';

  const first = await fetchText({ root, url, lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(first.fromCache, false);

  const second = await fetchText({ root, url, lookupImpl: noSocket, fetchImpl: noSocket });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.fromCache, true, 'a repeat must say so rather than silently re-fetching');
  assert.equal(second.text, 'hello docs');
  assert.equal(t.calls.length, 1);
});

test('an offset past the end says where the last window starts instead of returning nothing', async () => {
  resetFetchState();
  const t = stub({ headers: { 'content-type': 'text/plain' }, body: 'short' });
  const r0 = await fetchText({ root: ws(), url: 'https://docs.example.com/s.txt', lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(r0.nextOffset, null);
  const r = await fetchText({ root: ws(), url: 'https://docs.example.com/s.txt', offset: 99_999, lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(r.ok, false);
  assert.match(r.error, /past the end/);
  assert.match(r.error, /last window starts at 0/);
});

test('JSON is pretty-printed rather than run through the HTML converter', async () => {
  resetFetchState();
  const t = stub({ headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"a":{"b":[1,2]}}' });
  const r = await fetchText({ root: ws(), url: 'https://api.example.com/thing', lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}');
});

test('JSON mislabelled text/plain is still pretty-printed — registry.npmjs.org does exactly this', async () => {
  resetFetchState();
  const t = stub({ headers: { 'content-type': 'text/plain' }, body: '{"name":"zod","version":"4.4.3"}' });
  const r = await fetchText({ root: ws(), url: 'https://registry.example.com/zod/latest', lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(r.text, '{\n  "name": "zod",\n  "version": "4.4.3"\n}');
});

test('text/plain that merely STARTS with a brace is left alone — the sniff is a parse, not a guess', async () => {
  resetFetchState();
  const body = '{ this is prose about JSON objects, not an object }';
  const t = stub({ headers: { 'content-type': 'text/plain' }, body });
  const r = await fetchText({ root: ws(), url: 'https://docs.example.com/notes.txt', lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(r.text, body);
});

test('text/markdown passes through untouched — converting it would destroy the structure', async () => {
  resetFetchState();
  const md = '# Title\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n';
  const t = stub({ headers: { 'content-type': 'text/markdown' }, body: md });
  const r = await fetchText({ root: ws(), url: 'https://docs.example.com/readme.md', lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(r.text, md);
});

test('a memory workspace reports cachePath:null and still pages, rather than pretending it cached', async () => {
  resetFetchState();
  const t = stub({ headers: { 'content-type': 'text/plain' }, body: BIG });
  const url = 'https://docs.example.com/mem.txt';
  const a = await fetchText({ root: '(memory)', url, lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(a.ok, true, a.error);
  assert.equal(a.cachePath, null);
  assert.equal(a.text.length, DEFAULT_WINDOW);

  const b = await fetchText({ root: '(memory)', url, offset: a.nextOffset, lookupImpl: noSocket, fetchImpl: noSocket });
  assert.equal(b.ok, true, b.error);
  assert.equal(b.fromCache, true);
  assert.equal(b.text, BIG.slice(6_000, 12_000));
  assert.equal(t.calls.length, 1);
});

test('nothing is written outside .acuvo/fetch', async () => {
  resetFetchState();
  const root = ws();
  const t = stub({ headers: { 'content-type': 'text/plain' }, body: 'x' });
  const r = await fetchText({ root, url: 'https://docs.example.com/x.txt', lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.match(r.cachePath, /^\.acuvo\/fetch\/[0-9a-f]{40}\.txt$/);
  assert.ok(existsSync(join(root, r.cachePath)));
});

/* ────────────────────────────────────────────────────────────────────────────
 * BUDGETS
 * ──────────────────────────────────────────────────────────────────────────── */

test(`the ${MAX_FETCHES_PER_PROCESS + 1}th fetch is refused with the limit named`, async () => {
  resetFetchState();
  const root = ws();
  const t = stub({ headers: { 'content-type': 'text/plain' }, body: 'ok' });
  // Four hosts, because the per-host cap of 3 would otherwise fire first.
  const hosts = ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com'];
  let made = 0;
  for (const host of hosts) {
    for (let i = 0; i < MAX_FETCHES_PER_HOST && made < MAX_FETCHES_PER_PROCESS; i += 1) {
      const r = await fetchText({ root, url: `https://${host}/p${i}`, lookupImpl: publicLookup, fetchImpl: t.impl });
      assert.equal(r.ok, true, `fetch ${made + 1} failed: ${r.error}`);
      made += 1;
    }
  }
  assert.equal(made, MAX_FETCHES_PER_PROCESS);

  const over = await fetchText({ root, url: 'https://e.example.com/one-too-many', lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(over.ok, false);
  assert.match(over.error, new RegExp(`already made ${MAX_FETCHES_PER_PROCESS} requests`));

  // ⭐ And the point of the cache: a URL already fetched is still free, so the
  // refusal does not strand the model with documents it can no longer read.
  const cached = await fetchText({ root, url: 'https://a.example.com/p0', lookupImpl: noSocket, fetchImpl: noSocket });
  assert.equal(cached.ok, true, cached.error);
  assert.equal(cached.fromCache, true);
});

test('the 4th page from one host is refused with the host named', async () => {
  resetFetchState();
  const root = ws();
  const t = stub({ headers: { 'content-type': 'text/plain' }, body: 'ok' });
  for (let i = 0; i < MAX_FETCHES_PER_HOST; i += 1) {
    const r = await fetchText({ root, url: `https://one.example.com/p${i}`, lookupImpl: publicLookup, fetchImpl: t.impl });
    assert.equal(r.ok, true, r.error);
  }
  const over = await fetchText({ root, url: 'https://one.example.com/p9', lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(over.ok, false);
  assert.match(over.error, /one\.example\.com/);
  assert.match(over.error, new RegExp(`${MAX_FETCHES_PER_HOST} pages`));
});

test('more than 3 redirects is refused rather than followed', async () => {
  resetFetchState();
  const t = stub((url) => ({ status: 301, headers: { location: `${url}/again` } }));
  const r = await fetchText({ root: ws(), url: 'https://docs.example.com/loop', lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(r.ok, false);
  assert.match(r.error, /redirected more than 3 times/);
  assert.equal(t.calls.length, 4, 'the original plus exactly three hops');
});

test('a redirect chain that stays public is followed, and finalUrl says where it landed', async () => {
  resetFetchState();
  const t = stub((url) => (url.endsWith('/final')
    ? { headers: { 'content-type': 'text/plain' }, body: 'arrived' }
    : { status: 301, headers: { location: 'https://docs.example.com/final' } }));
  const r = await fetchText({ root: ws(), url: 'https://docs.example.com/start', lookupImpl: publicLookup, fetchImpl: t.impl });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, 'arrived');
  assert.equal(r.url, 'https://docs.example.com/start');
  assert.equal(r.finalUrl, 'https://docs.example.com/final');
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE REAL TRANSPORT, over a real socket
 *
 * ⚠️ The server is on 127.0.0.1, which `fetchText` would refuse — and does, in
 * the tests above. It is reachable here ONLY because the injected transport
 * rewrites the URL after the guard has already run on the public one. That is
 * the seam being a seam, not the guard being off.
 * ──────────────────────────────────────────────────────────────────────────── */

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('the real transport decompresses gzip, converts HTML, and sends no credentials of any kind', async () => {
  resetFetchState();
  /** @type {import('node:http').IncomingHttpHeaders} */
  let seen = null;
  const { server, port } = await listen((req, res) => {
    seen = req.headers;
    const body = gzipSync(Buffer.from(NODE_DOC_FIXTURE, 'utf8'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
    res.end(body);
  });
  try {
    const r = await fetchText({
      root: ws(),
      url: 'https://nodejs.org.example.com/api/test.html',
      lookupImpl: publicLookup,
      // The rewrite is the whole trick: the guard saw a public URL, the socket
      // goes to the loopback server the test controls.
      fetchImpl: (req) => rawHttpRequest({ ...req, addresses: null, url: `http://127.0.0.1:${port}/api/test.html` }),
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.status, 200);
    assert.match(r.text, /mock\.timers\.enable\(\{\n {2}apis: \['setTimeout'\],/, 'gzip + HTML conversion');

    assert.match(String(seen['user-agent']), /^acuvo-code\/\d+\.\d+\.\d+$/);
    for (const banned of ['authorization', 'cookie', 'referer', 'x-api-key']) {
      assert.equal(seen[banned], undefined, `${banned} must never be sent`);
    }
    const leaked = Object.values(seen).join(' ');
    assert.ok(!/sk-|Bearer|OPENROUTER/i.test(leaked), `a credential-shaped value was sent: ${leaked}`);
  } finally {
    server.close();
  }
});

test('the real transport stops at the byte cap and DESTROYS the socket rather than draining the server', async () => {
  resetFetchState();
  let closedEarly = false;
  let sent = 0;
  const { server, port } = await listen((req, res) => {
    req.on('aborted', () => { closedEarly = true; });
    res.writeHead(200, { 'content-type': 'text/plain' });
    const chunk = 'x'.repeat(64 * 1024);
    // Keep offering data until the client goes away. If the cap did not destroy
    // the socket this test would never finish, which is the honest failure mode.
    const pump = () => {
      if (res.writableEnded || res.destroyed || sent > 40 * 1024 * 1024) return;
      sent += chunk.length;
      if (res.write(chunk)) setImmediate(pump); else res.once('drain', pump);
    };
    pump();
  });
  try {
    const r = await rawHttpRequest({ url: `http://127.0.0.1:${port}/huge`, maxBytes: 100_000, timeoutMs: 10_000 });
    assert.equal(r.truncated, true);
    assert.equal(r.body.length, 100_000, 'the cap must be exact, not "roughly"');
    assert.ok(sent < 40 * 1024 * 1024, `the server kept streaming (${sent} bytes) — the socket was not destroyed`);
    assert.ok(closedEarly || sent < 40 * 1024 * 1024);
  } finally {
    server.close();
  }
});

test('the real transport reports a refused connection as data, not as a crash', async () => {
  resetFetchState();
  // Port 1 on loopback: nothing listens there. Reached through the seam again.
  const r = await fetchText({
    root: ws(),
    url: 'https://docs.example.com/x',
    lookupImpl: publicLookup,
    fetchImpl: (req) => rawHttpRequest({ ...req, addresses: null, url: 'http://127.0.0.1:1/x', timeoutMs: 3_000 }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not fetch/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * SCHEMA
 * ──────────────────────────────────────────────────────────────────────────── */

test('the schema exposes exactly url, offset and limit — and says the localhost limit out loud', () => {
  const [schema] = fetchToolSchemas();
  assert.equal(schema.function.name, 'fetch_url');
  assert.deepEqual(Object.keys(schema.function.parameters.properties).sort(), ['limit', 'offset', 'url']);
  assert.deepEqual(schema.function.parameters.required, ['url']);
  assert.match(schema.function.description, /cannot reach private or local addresses/i);
  assert.match(schema.function.description, /localhost/);
  assert.match(schema.function.description, /nextOffset/);
});
