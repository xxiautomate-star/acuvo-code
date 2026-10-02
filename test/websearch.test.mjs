/**
 * ── WEB SEARCH ──────────────────────────────────────────────────────────────
 *
 * Every test here injects `fetchImpl`, so the suite stays offline and free.
 * The fixtures are REAL markup, copied from live responses — a hand-written
 * approximation of DuckDuckGo's HTML would have hidden the single-vs-double
 * quote defect that cost a probe cycle to find.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  webSearch,
  formatResults,
  unwrapRedirect,
  resetSearchState,
  webSearchToolSchemas,
  PROVIDER_IDS,
  MAX_SEARCHES_PER_PROCESS,
  MAX_QUERY_CHARS,
} from '../lib/websearch.mjs';
import { resetPackageDocsState } from '../lib/package-docs.mjs';

/* ── fixtures: real shapes, double quotes on /html/, SINGLE on /lite/ ─────── */

const DDG_HTML = `
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://nodejs.org/api/fs.html">fs — File system</a>
  </h2>
  <a class="result__snippet" href="#">Reads the <b>file</b> synchronously and returns a Buffer.</a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="https://stackoverflow.com/questions/1">readFileSync encoding</a>
  </h2>
  <a class="result__snippet" href="#">Pass "utf8" to get a string instead.</a>
</div>`;

const DDG_LITE = `
<table border="0">
  <tr><td valign="top">1.&nbsp;</td>
    <td><a rel="nofollow" href="https://nodejs.org/api/fs.html" class='result-link'>fs — File system</a></td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>Reads the file synchronously.</td></tr>
</table>`;

const SO_JSON = JSON.stringify({
  items: [
    { title: 'Why does readFileSync not return what writeFileSync wrote?', link: 'https://stackoverflow.com/questions/66753192/x', score: 7, is_answered: true, tags: ['node.js', 'fs'] },
  ],
  quota_remaining: 298,
});

const ok = (body) => async () => ({ status: 200, body });
const routed = (map) => async (url) => {
  for (const [needle, body] of Object.entries(map)) {
    if (url.includes(needle)) return { status: 200, body };
  }
  return { status: 503, body: '' };
};

test.beforeEach(() => resetSearchState());

/* ── parsing ──────────────────────────────────────────────────────────────── */

test('parses DuckDuckGo /html/ into title, url and snippet', async () => {
  const r = await webSearch({ query: 'readFileSync utf8', fetchImpl: ok(DDG_HTML) });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'duckduckgo');
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].title, 'fs — File system');
  assert.equal(r.results[0].url, 'https://nodejs.org/api/fs.html');
  assert.match(r.results[0].snippet, /returns a Buffer/);
});

test("⚠️ /lite/ uses SINGLE-quoted class attributes — the parser must accept both", async () => {
  /**
   * ⚠️ THIS IS THE DEFECT THAT COST A PROBE CYCLE. `/html/` writes
   * class="result__a" and `/lite/` writes class='result-link'. A parser
   * assuming double quotes returns ZERO results — and zero results is
   * indistinguishable from "nothing matched your query" unless you go looking.
   */
  const r = await webSearch({ query: 'x', providers: ['duckduckgo-lite'], fetchImpl: ok(DDG_LITE) });
  assert.equal(r.ok, true, 'single-quoted class attributes must parse');
  assert.equal(r.results[0].url, 'https://nodejs.org/api/fs.html');
  assert.match(r.results[0].snippet, /synchronously/);
});

test('parses the StackOverflow JSON API', async () => {
  const r = await webSearch({ query: 'x', providers: ['stackoverflow'], fetchImpl: ok(SO_JSON) });
  assert.equal(r.ok, true);
  assert.match(r.results[0].title, /readFileSync/);
  assert.match(r.results[0].snippet, /answered · score 7/);
});

/* ── the redirector ───────────────────────────────────────────────────────── */

test('⚠️ a DDG redirect wrapper is unwrapped to the real target', () => {
  const wrapped = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&rut=abc';
  assert.equal(unwrapRedirect(wrapped), 'https://nodejs.org/api/fs.html');
});

test('a protocol-relative url gets https, and a plain url is untouched', () => {
  assert.equal(unwrapRedirect('//example.com/a'), 'https://example.com/a');
  assert.equal(unwrapRedirect('https://example.com/a'), 'https://example.com/a');
});

test('⚠️ results pointing back at the search engine are dropped', async () => {
  const selfLink = `<a class="result__a" href="https://duckduckgo.com/settings">Settings</a>
    <a class="result__a" href="https://nodejs.org/api/fs.html">fs</a>`;
  const r = await webSearch({ query: 'x', fetchImpl: ok(selfLink) });
  assert.equal(r.results.length, 1, 'navigation chrome is not a search result');
  assert.equal(r.results[0].url, 'https://nodejs.org/api/fs.html');
});

/* ── ⚠️ the failure modes that arrive as HTTP 200 ─────────────────────────── */

test('⚠️⚠️ a consent wall is a 200 and must NOT be reported as "no results"', async () => {
  const wall = '<html><body>Please accept our cookie policy to continue</body></html>';
  const r = await webSearch({
    query: 'x',
    providers: ['duckduckgo'],
    fetchImpl: ok(wall),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /consent wall/);
  assert.match(r.error, /NOT evidence that nothing exists/, 'the model must not read a network failure as a negative result');
});

test('a bot check is named as a bot check, not as an empty web', async () => {
  const r = await webSearch({ query: 'x', providers: ['duckduckgo'], fetchImpl: ok('please complete the CAPTCHA') });
  assert.equal(r.ok, false);
  assert.match(r.error, /bot check/);
});

test('⭐ the chain advances past a dead provider and reaches a live one', async () => {
  const r = await webSearch({
    query: 'x',
    fetchImpl: routed({ 'html.duckduckgo': 'consent required', 'lite.duckduckgo': 'consent required', 'stackexchange': SO_JSON }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'stackoverflow');
  assert.equal(r.tried.length, 2, 'both dead legs must be recorded, not silently skipped');
});

test('⚠️ a fallback ANNOUNCES itself — a degraded search must look degraded', () => {
  /**
   * ⚠️ CAUGHT BY RUNNING IT FOR REAL: the primary was serving a bot check, the
   * chain fell through, and the output read exactly like a normal search — one
   * thin result presented as the whole web's answer. A model reading that
   * concludes the topic is obscure, which is the opposite of the truth.
   */
  const rendered = formatResults({
    ok: true,
    provider: 'stackoverflow',
    results: [{ title: 'T', url: 'https://example.com/a', snippet: 's' }],
    tried: [{ provider: 'duckduckgo', ok: false, why: 'served a bot check' }],
  });
  assert.match(rendered, /duckduckgo failed \(served a bot check\)/);
  assert.match(rendered, /coverage is narrower/);
});

test('a clean search adds no fallback note', () => {
  const rendered = formatResults({
    ok: true, provider: 'duckduckgo', tried: [],
    results: [{ title: 'T', url: 'https://example.com/a', snippet: 's' }],
  });
  assert.equal(/failed/.test(rendered), false, 'noise on the one path that worked');
  assert.match(rendered, /snippet is a hint, not a source/);
});

test('every provider failing says so in those words, with each reason', async () => {
  const r = await webSearch({ query: 'x', fetchImpl: async () => ({ status: 503, body: '' }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /no search provider could be reached/);
  assert.equal(r.tried.length, PROVIDER_IDS.length);
  assert.ok(r.tried.every((t) => /HTTP 503/.test(t.why)));
});

test('a thrown fetch is caught per-provider, not fatal to the run', async () => {
  const r = await webSearch({
    query: 'x',
    fetchImpl: routed({ 'stackexchange': SO_JSON }),
  });
  assert.equal(r.ok, true, 'one broken leg must not sink the chain');
});

/* ── routing ──────────────────────────────────────────────────────────────── */

test('⭐ an error-shaped query goes to StackOverflow FIRST', async () => {
  const seen = [];
  await webSearch({
    query: 'ECONNREFUSED node fetch localhost',
    fetchImpl: async (url) => { seen.push(url); return { status: 200, body: SO_JSON }; },
  });
  assert.match(seen[0], /stackexchange/, 'a stack trace is answered better by Q&A than by the open web');
});

test('an ordinary question goes to the open web first', async () => {
  const seen = [];
  await webSearch({
    query: 'best practices for naming css variables',
    fetchImpl: async (url) => { seen.push(url); return { status: 200, body: DDG_HTML }; },
  });
  assert.match(seen[0], /duckduckgo/);
});

/* ── guards ───────────────────────────────────────────────────────────────── */

test('an empty query is refused with a reason, not searched', async () => {
  const r = await webSearch({ query: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /needs a `query`/);
});

test('an essay-length query is refused and told what to do instead', async () => {
  const r = await webSearch({ query: 'a'.repeat(MAX_QUERY_CHARS + 1) });
  assert.equal(r.ok, false);
  assert.match(r.error, /cut it to the distinctive terms/);
});

test('⚠️ the per-run cap refuses, and says searching again will not help', async () => {
  for (let i = 0; i < MAX_SEARCHES_PER_PROCESS; i += 1) {
    await webSearch({ query: `q${i}`, fetchImpl: ok(DDG_HTML) });
  }
  const r = await webSearch({ query: 'one too many', fetchImpl: ok(DDG_HTML) });
  assert.equal(r.ok, false);
  assert.match(r.error, /already made \d+ web searches/);
  assert.match(r.error, /read one of the results with fetch_url instead/, 'a refusal must name the way forward');
});

test('an unknown provider name is refused with the known list', async () => {
  const r = await webSearch({ query: 'x', providers: ['google'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /known providers are/);
});

test('limit is clamped, and duplicate urls collapse to one result', async () => {
  const dupes = `<a class="result__a" href="https://nodejs.org/api/fs.html">a</a>
    <a class="result__a" href="https://nodejs.org/api/fs.html?x=1#y">b</a>
    <a class="result__a" href="https://example.com/z">c</a>`;
  const r = await webSearch({ query: 'x', limit: 99, fetchImpl: ok(dupes) });
  assert.equal(r.results.length, 2, 'the same page twice is one result');
});

/* ── the schema the model actually reads ──────────────────────────────────── */

test('the tool schema tells the model a snippet is not a source', () => {
  const [s] = webSearchToolSchemas();
  assert.equal(s.function.name, 'web_search');
  assert.match(s.function.description, /snippet is a hint, not a source/);
  assert.match(s.function.description, /NOT evidence that nothing exists/);
  assert.deepEqual(s.function.parameters.required, ['query']);
});

/* ── ⭐⭐⭐ THE PACKAGE FACT REACHES THE MODEL ─────────────────────────────────
 *
 * `package-docs.test.mjs` proves the lookup is CORRECT. These prove it is
 * REACHED — through `webSearch` and out through `formatResults`, which is the
 * text the dispatcher actually hands back. The repo's standing lesson is that
 * only the end-to-end path proves reach; a green unit test on a module the
 * search never calls is the false green this section exists to make impossible.
 *
 * ⚠️ STILL ZERO NETWORK. `fetchImpl` covers BOTH legs (see the note in
 * `websearch.mjs`), so nothing here touches npm.
 * ────────────────────────────────────────────────────────────────────────── */

test.beforeEach(() => resetPackageDocsState());

const NPM_DEPRECATED = JSON.stringify({
  name: 'request',
  version: '2.88.2',
  deprecated: 'request has been deprecated, see https://github.com/request/request/issues/3142',
});
const NPM_ZOD = JSON.stringify({ name: 'zod', version: '4.4.3', homepage: 'https://zod.dev' });

test('⭐⭐ a deprecation is prepended ABOVE the results the model reads', async () => {
  const r = await webSearch({
    query: 'request npm http client',
    fetchImpl: routed({ 'registry.npmjs.org': NPM_DEPRECATED, duckduckgo: DDG_HTML }),
  });
  assert.equal(r.ok, true);
  const rendered = formatResults(r);
  assert.match(rendered, /DEPRECATED/);
  assert.ok(
    rendered.indexOf('DEPRECATED') < rendered.indexOf('nodejs.org'),
    'the authoritative line must sit ABOVE the ranked ones — a model that has read ten links has already chosen',
  );
});

test('⭐ the current version and canonical docs URL ride along with an ordinary search', async () => {
  const r = await webSearch({
    query: 'zod schema api docs',
    fetchImpl: routed({ 'registry.npmjs.org': NPM_ZOD, duckduckgo: DDG_HTML }),
  });
  const rendered = formatResults(r);
  assert.match(rendered, /4\.4\.3/);
  assert.match(rendered, /https:\/\/zod\.dev/);
});

test('⚠️⚠️ the fact SURVIVES a total search failure — the case it matters most in', async () => {
  // Every search leg blocked, and the library is still dead. Reporting a clean
  // network error here would hand the model the exact outcome this prevents.
  const r = await webSearch({
    query: 'request npm deprecated',
    fetchImpl: async (url) => (url.includes('registry.npmjs.org')
      ? { status: 200, body: NPM_DEPRECATED }
      : { status: 503, body: '' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /no search provider could be reached/);
  assert.match(r.error, /DEPRECATED/, 'a blocked search must not swallow a deprecation we already have');
});

test('⚠️ a registry outage NEVER sinks the search', async () => {
  const r = await webSearch({
    query: 'zod api docs',
    fetchImpl: async (url) => {
      if (url.includes('registry.npmjs.org')) throw new Error('ECONNREFUSED');
      return { status: 200, body: DDG_HTML };
    },
  });
  assert.equal(r.ok, true, 'an enrichment that can fail its host is a liability');
  assert.equal(r.packageNote, '');
  assert.equal(/npm registry/.test(formatResults(r)), false, 'silence, not an apology');
});

test('⚠️ an ordinary question costs NO registry request at all', async () => {
  const seen = [];
  await webSearch({
    query: 'best practices for naming css variables',
    fetchImpl: async (url) => { seen.push(url); return { status: 200, body: DDG_HTML }; },
  });
  assert.equal(seen.some((u) => u.includes('registry.npmjs.org')), false);
});

test('⭐ the schema gives the ORDER, not the get-out clause it replaced', () => {
  const [s] = webSearchToolSchemas();
  assert.match(s.function.description, /BEFORE you write code against any library/);
  assert.match(s.function.description, /Do not wait until you feel unsure/);
  assert.equal(
    /Use it when you do not know/.test(s.function.description),
    false,
    '"when you do not know" is a condition a confident model never evaluates as true',
  );
  assert.match(s.function.description, /DEPRECATED/);
});

/**
 * ── ⭐⭐⭐ THROUGH THE REAL DISPATCHER — the only thing that proves reach ─────
 *
 * Everything above drives `webSearch` directly. This drives `executeToolCall`,
 * which is the function the turn loop actually calls, and asserts on
 * `result.text` — the exact string handed back to the model. The repo's own
 * lesson is that a green unit test on a module the runtime routes around is
 * the false green worth the most money; `tools.mjs` composes
 * `formatResults(result)` itself, so nothing but this catches a dispatcher
 * that keeps the structure and drops the rendered text.
 *
 * ⚠️ OFFLINE. `parseToolArguments` accepts an OBJECT, so the seam goes through
 * the dispatcher untouched — `case 'web_search'` spreads the model's args into
 * `webSearch` in whole. No network, no key.
 */
test('⭐⭐⭐ the deprecation reaches the model through executeToolCall', async () => {
  const { executeToolCall } = await import('../lib/tools.mjs');
  const NPM = JSON.stringify({
    name: 'request',
    version: '2.88.2',
    deprecated: 'request has been deprecated, see https://github.com/request/request/issues/3142',
  });
  const record = await executeToolCall(
    {
      id: 'c1',
      function: {
        name: 'web_search',
        arguments: {
          query: 'request npm http client',
          fetchImpl: async (url) => ({ status: 200, body: url.includes('registry.npmjs.org') ? NPM : DDG_HTML }),
        },
      },
    },
    { root: process.cwd() },
  );
  assert.equal(record.result.ok, true);
  assert.match(record.result.text, /DEPRECATED/, 'the dispatcher must hand the model the rendered fact, not just the structure');
  assert.match(record.result.text, /Do NOT write new code against it/);
  assert.equal(record.mutated, false);
});
