/**
 * ── ⭐⭐ WEB SEARCH — THE HALF OF THE WEB THE AGENT COULD NOT REACH ──────────
 *
 * `fetch_url` could read a page it was TOLD about. It could not FIND one. For a
 * coding agent that gap is the difference between checking an API and guessing
 * at it — and guessing at an option name is the single commonest way a model
 * writes confident, wrong code.
 *
 * ── WHAT WAS MEASURED, BEFORE ANY OF THIS WAS WRITTEN ───────────────────────
 *
 * Ten keyless backends were probed from a real machine. The byte counts alone
 * would have picked the wrong winner, which is exactly why parsing came second:
 *
 *   ddg-html      200 · 10 results · 10 snippets · real URLs, already unwrapped
 *   ddg-lite      200 · 10 results · parses fine once you accept SINGLE-quoted
 *                 class attributes (`class='result-link'`) — my first regex
 *                 assumed double quotes and reported zero
 *   stackexchange 200 · real JSON · NO KEY · 300 requests/day quota
 *   marginalia    200 · 162KB · 29 distinct hosts … and TWO parseable links,
 *                 both boilerplate (ip2location, creativecommons)
 *   searx.be      200 · JSON format disabled, serves a consent wall instead
 *   searxng.site  403 · priv.au 403 · mojeek walled
 *
 * ⚠️⭐ MARGINALIA IS THE LESSON. On the first probe it looked like the BEST
 * backend — 162KB and 29 hosts, more than anything else returned. Parsing it
 * showed 29 footer links and no results. **A byte-level proxy for "did this
 * work" ranks a boilerplate-heavy page above a correct one.** Never accept a
 * size or a status as evidence that a fetch produced usable content.
 *
 * ── ⚠️ THE HONEST LIMIT OF "NEVER SINGLE" HERE ──────────────────────────────
 *
 * `ddg-html` and `ddg-lite` are two endpoints of ONE operator. Listing them as
 * two providers would be false redundancy — if DuckDuckGo blocks this IP, both
 * die together. The genuinely independent leg is StackExchange, and it is a
 * DIFFERENT KIND of source (programming Q&A, not the open web), so it is used
 * as a specialist rather than a drop-in replacement. That is stated here rather
 * than papered over, because a fallback that cannot actually fall back is worse
 * than no fallback: it buys confidence it has not earned.
 */

import { htmlToText } from './fetch-text.mjs';

export const SEARCH_TIMEOUT_MS = 12_000;
export const MAX_SEARCHES_PER_PROCESS = 12;
export const DEFAULT_LIMIT = 6;
export const MAX_LIMIT = 12;
export const MAX_QUERY_CHARS = 400;
export const MAX_SNIPPET_CHARS = 320;

/**
 * ⚠️ A REAL BROWSER STRING, on purpose. These endpoints exist for browsers and
 * serve a consent page to anything that announces itself as a script — which
 * would arrive here as a 200 full of nothing, the failure that looks like
 * success. It is not a disguise: the request is a plain public GET, rate
 * limited below, and identifies no user.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15';

let searchesThisProcess = 0;

/** Test seam: the per-process cap must not leak between test files. */
export function resetSearchState() {
  searchesThisProcess = 0;
}

/**
 * ⚠️ SINGLE **AND** DOUBLE QUOTES. DuckDuckGo's two endpoints disagree with
 * each other — `/html/` writes `class="result__a"` and `/lite/` writes
 * `class='result-link'`. A parser that assumes one silently returns zero
 * results against the other, and "zero results" is indistinguishable from "no
 * matches for your query" unless you go looking. This cost a probe cycle.
 */
const attr = (name, value) => new RegExp(`${name}\\s*=\\s*["']${value}["']`);

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ⚠️ DDG SOMETIMES WRAPS RESULTS IN ITS OWN REDIRECTOR
 * (`//duckduckgo.com/l/?uddg=<encoded>`). Handing that to the model would send
 * the next `fetch_url` to duckduckgo.com instead of the page, and the model
 * would have no way to tell — the URL LOOKS like a result.
 */
export function unwrapRedirect(href) {
  const raw = String(href || '');
  const m = /[?&]uddg=([^&]+)/.exec(raw);
  let out = raw;
  if (m) {
    try { out = decodeURIComponent(m[1]); } catch { /* keep the raw form */ }
  }
  if (out.startsWith('//')) out = `https:${out}`;
  return out;
}

function usable(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // A result pointing back at the search engine is navigation, not an answer.
    return !/(^|\.)duckduckgo\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function clampSnippet(s) {
  const t = stripTags(s);
  return t.length > MAX_SNIPPET_CHARS ? `${t.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}…` : t;
}

/* ── the providers ────────────────────────────────────────────────────────── */

function parseDuckDuckGo(html, { linkClass, snippetClass }) {
  const out = [];
  const anchorRe = new RegExp(`<a\\b([^>]*)>([\\s\\S]*?)<\\/a>`, 'g');
  const linkIs = attr('class', linkClass);
  for (const m of String(html).matchAll(anchorRe)) {
    const attrs = m[1];
    if (!linkIs.test(attrs)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/.exec(attrs);
    if (!href) continue;
    const url = unwrapRedirect(href[1]);
    const title = stripTags(m[2]);
    if (title && usable(url)) out.push({ title, url, snippet: '' });
  }

  // Snippets are siblings, not children — matched positionally, in document
  // order, which is the order DuckDuckGo emits them in.
  const snipRe = new RegExp(`class\\s*=\\s*["']${snippetClass}["'][^>]*>([\\s\\S]*?)<\\/(?:td|a|div)>`, 'g');
  const snippets = [...String(html).matchAll(snipRe)].map((m) => clampSnippet(m[1]));
  for (let i = 0; i < out.length; i += 1) if (snippets[i]) out[i].snippet = snippets[i];
  return out;
}

const PROVIDERS = [
  {
    id: 'duckduckgo',
    kind: 'general',
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: (body) => parseDuckDuckGo(body, { linkClass: 'result__a', snippetClass: 'result__snippet' }),
  },
  {
    /**
     * ⚠️ NOT AN INDEPENDENT PROVIDER — the same operator behind a lighter
     * template. It is here because the two endpoints fail SEPARATELY (markup
     * changes, per-endpoint throttling), not because it survives a block.
     */
    id: 'duckduckgo-lite',
    kind: 'general',
    url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    parse: (body) => parseDuckDuckGo(body, { linkClass: 'result-link', snippetClass: 'result-snippet' }),
  },
  {
    /**
     * ⭐ THE GENUINELY INDEPENDENT LEG, and the one most likely to be RIGHT for
     * a coding agent: a real JSON API, no key, 300 requests/day.
     */
    id: 'stackoverflow',
    kind: 'code',
    url: (q) => 'https://api.stackexchange.com/2.3/search/advanced'
      + `?order=desc&sort=relevance&site=stackoverflow&pagesize=10&q=${encodeURIComponent(q)}`,
    parse: (body) => {
      const j = JSON.parse(body);
      if (j.error_message) throw new Error(String(j.error_message));
      return (j.items || [])
        .filter((it) => it && it.link)
        .map((it) => ({
          title: stripTags(it.title || it.link),
          url: it.link,
          snippet: clampSnippet(
            `${it.is_answered ? 'answered' : 'unanswered'} · score ${it.score ?? 0}`
            + `${Array.isArray(it.tags) && it.tags.length ? ` · ${it.tags.slice(0, 5).join(', ')}` : ''}`,
          ),
        }));
    },
  },
];

export const PROVIDER_IDS = Object.freeze(PROVIDERS.map((p) => p.id));

async function defaultFetchImpl(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ⚠️ A CONSENT WALL ARRIVES AS A 200. Detecting it by status is impossible;
 * detecting it by "did we parse any results" is the only reliable signal, so
 * an empty parse from a 200 is treated as a PROVIDER FAILURE and the chain
 * advances — not as "the web has nothing on this".
 */
function describeEmpty(body) {
  if (/captcha|unusual traffic|are you a robot/i.test(body)) return 'the endpoint served a bot check instead of results';
  if (/consent|cookie policy/i.test(body)) return 'the endpoint served a consent wall instead of results';
  if (/enable javascript/i.test(body)) return 'the endpoint requires JavaScript to render results';
  return 'the endpoint answered but no results could be parsed out of it';
}

/**
 * Search the public web. Returns results the model can then `fetch_url`.
 *
 * ⚠️ THE RETURN SHAPE DISTINGUISHES THREE OUTCOMES that a bare array cannot:
 * results found · a provider answered with genuinely nothing · every provider
 * failed. Collapsing the last two into `[]` teaches the model that its query
 * was bad when the truth is that the network was.
 */
export async function webSearch(params = {}) {
  const query = String(params.query ?? '').trim();
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(params.limit) || DEFAULT_LIMIT));
  const fetchImpl = params.fetchImpl || defaultFetchImpl;
  const timeoutMs = Number(params.timeoutMs) || SEARCH_TIMEOUT_MS;

  if (!query) return { ok: false, error: 'web_search needs a `query` — an empty search has no answer to give you.' };
  if (query.length > MAX_QUERY_CHARS) {
    return { ok: false, error: `that query is ${query.length} characters; keep it under ${MAX_QUERY_CHARS}. Search engines match keywords, not essays — cut it to the distinctive terms.` };
  }
  if (searchesThisProcess >= MAX_SEARCHES_PER_PROCESS) {
    return {
      ok: false,
      error: `this run has already made ${MAX_SEARCHES_PER_PROCESS} web searches, which is the cap. If the answer has not turned up, searching again with the same words will not find it — read one of the results with fetch_url instead.`,
    };
  }
  searchesThisProcess += 1;

  /**
   * ⭐ THE CODE PROVIDER GOES FIRST FOR CODE QUESTIONS. A StackOverflow answer
   * is more useful to a coding agent than a listicle, and it costs one request
   * from a 300/day quota rather than scraping HTML.
   */
  const wantCode = params.kind === 'code'
    || /\b(error|exception|typeerror|referenceerror|stack ?trace|undefined is not|cannot read|npm|pip|cargo|traceback|segfault|econnrefused|enoent)\b/i.test(query);
  const order = wantCode
    ? [...PROVIDERS].sort((a, b) => (a.kind === 'code' ? -1 : 0) - (b.kind === 'code' ? -1 : 0))
    : PROVIDERS;

  const chosen = Array.isArray(params.providers) && params.providers.length > 0
    ? order.filter((p) => params.providers.includes(p.id))
    : order;

  if (chosen.length === 0) {
    return { ok: false, error: `no known search provider matched ${JSON.stringify(params.providers)} — known providers are ${PROVIDER_IDS.join(', ')}.` };
  }

  const tried = [];
  for (const provider of chosen) {
    let res;
    try {
      res = await fetchImpl(provider.url(query), timeoutMs);
    } catch (e) {
      const why = e?.name === 'AbortError' ? `no answer within ${timeoutMs}ms` : String(e?.message || e);
      tried.push({ provider: provider.id, ok: false, why });
      continue;
    }

    const status = Number(res?.status ?? 0);
    const body = String(res?.body ?? '');
    if (status < 200 || status >= 300) {
      tried.push({ provider: provider.id, ok: false, why: `HTTP ${status}` });
      continue;
    }

    let parsed;
    try {
      parsed = provider.parse(body);
    } catch (e) {
      tried.push({ provider: provider.id, ok: false, why: `the response could not be read: ${String(e?.message || e)}` });
      continue;
    }

    if (!parsed || parsed.length === 0) {
      tried.push({ provider: provider.id, ok: false, why: describeEmpty(body) });
      continue;
    }

    // Same page from two providers is one result, not two.
    const seen = new Set();
    const results = [];
    for (const r of parsed) {
      const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ ...r, source: provider.id });
      if (results.length >= limit) break;
    }

    return { ok: true, query, provider: provider.id, results, tried };
  }

  /**
   * ⚠️ EVERY PROVIDER FAILED — and the reply says so IN THOSE WORDS, with each
   * reason. An empty result list here would read to the model as "there is
   * nothing about this on the web", which is a lie that sends it back to
   * guessing with more confidence than before.
   */
  return {
    ok: false,
    error: `no search provider could be reached, so this is NOT evidence that nothing exists — do not treat it as a negative result. ${tried.map((t) => `${t.provider}: ${t.why}`).join(' · ')}`,
    tried,
  };
}

/**
 * Render results for the model: compact, and every URL fetchable as-is.
 *
 * ⚠️ A FALLBACK MUST ANNOUNCE ITSELF. Caught by running this for real: the
 * primary was serving a bot check, the chain quietly fell through to
 * StackOverflow, and the output read exactly like a normal search — one thin
 * result presented as if it were the whole web's answer. A model reading that
 * concludes the topic is obscure. The degraded case has to LOOK degraded.
 */
export function formatResults(out) {
  if (!out?.ok) return String(out?.error ?? 'search failed');
  const lines = [];
  if (Array.isArray(out.tried) && out.tried.length > 0) {
    lines.push(
      `note: ${out.tried.map((t) => `${t.provider} failed (${t.why})`).join('; ')}`
      + ` — these results come from the fallback, so coverage is narrower than usual.`,
    );
  }
  lines.push(`${out.results.length} result${out.results.length === 1 ? '' : 's'} from ${out.provider}:`);
  out.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  lines.push('Read one with fetch_url before relying on it — a snippet is a hint, not a source.');
  return lines.join('\n');
}

export function webSearchToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: [
          'Search the public web and get back titles, URLs and snippets.',
          'Use it when you do not know WHICH page has the answer — an API you have not used, a library version,',
          'an error message you do not recognise. Then call fetch_url on the most promising result to read it.',
          'A snippet is a hint, not a source: never quote an API signature you have only seen in a snippet.',
          'Programming questions and error messages are routed to StackOverflow first, the open web otherwise.',
          `At most ${MAX_SEARCHES_PER_PROCESS} searches per run, so make each query specific.`,
          'If every provider fails it says so explicitly — that is a network failure, NOT evidence that nothing exists.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Distinctive keywords, not a sentence. e.g. "node fs.readFileSync encoding utf8 buffer" rather than "how do I read a file in node".',
            },
            limit: { type: 'integer', description: `How many results, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.` },
            kind: {
              type: 'string',
              enum: ['general', 'code'],
              description: 'Force the source: "code" searches StackOverflow first. Usually leave it out — error-shaped queries are detected.',
            },
          },
          required: ['query'],
        },
      },
    },
  ];
}

/** Kept for the doctor: what this capability needs, and what it costs. */
export function searchChecks() {
  return {
    id: 'web.search',
    label: 'web search',
    providers: PROVIDER_IDS,
    needsKey: false,
    note: 'keyless. StackOverflow allows 300 requests/day per IP; DuckDuckGo is unmetered but may serve a bot check.',
  };
}

export { htmlToText };
