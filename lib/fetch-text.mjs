/**
 * ── ⭐ FETCH A DOC AND READ IT — THE PRIMITIVE WHOSE ABSENCE BURNED FOUR RUNS ─
 *
 * Measured on this package's own probes, 2026-08-10:
 *
 *   · Probe D was told to read https://nodejs.org/api/test.html. Round 1 refused
 *     (a `"` is not allowed in a command string). Rounds 2-6 hand-rolled a fetch
 *     plus HTML scraping inside `evaluate`: "I fetched the page successfully",
 *     then "The output was truncated", then "The output is being truncated in
 *     the middle". NOTES.md was never written — `ls -la wsD` shows only `.env` —
 *     and the run still printed ✔ VERIFIED.
 *   · Probe G repeated the shape, gave up on the URL, guessed empirically, and
 *     never wrote API.md.
 *   · Probe A died on `mock.timers.enable({ apis: ['setTimeout', …] })`, an enum
 *     member that does not exist. ERR_INVALID_ARG_VALUE ate the whole budget.
 *
 * ⭐ AND THE NUMBER THAT MAKES THE CASE. Across those runs: **0 invented
 * function names in 12 uses of Node built-ins, 3 wrong facts in ~19 uses of a
 * library API (~16%)** — an invented enum member, a wrong async shape (`glob`
 * from fs/promises spread as an array → "files is not iterable"), and a
 * wrong-version idiom (`z.string().email()` under an explicit "use the v4 APIs"
 * instruction, asserted as "The code itself is correct" in the one probe where
 * nothing could run to contradict it). Every single one was a doc lookup away.
 *
 * ── ⚠️ THIS ADDS ERGONOMICS AND RAILS, NOT REACH ────────────────────────────
 * The network was ALREADY reachable from inside `evaluate` — the model proved
 * that by fetching the page. What it did not have was: a converter that turns
 * HTML into something readable, a cache so window two is free, and a boundary
 * that stops "fetch a URL" from meaning "read the cloud metadata endpoint". So
 * do not sell this as new capability. It is the difference between having a
 * network and being able to look something up.
 *
 * ── ⚠️ THE PART THAT IS SECURITY, NOT CONVENIENCE ───────────────────────────
 * This runs on other people's machines, and the URL is chosen by a language
 * model that will happily follow a link out of a page it just read. A tool that
 * takes a model-supplied URL and performs a GET is an SSRF primitive unless
 * something stops it: `http://169.254.169.254/latest/meta-data/iam/…` hands out
 * cloud credentials, and `http://127.0.0.1:*` is every unauthenticated admin
 * panel a developer has ever run on a laptop.
 *
 * ⭐ So the guard is not a blocklist of strings, it is a check on the RESOLVED
 * ADDRESSES, re-run on every redirect hop, and the socket is then pinned to the
 * exact addresses that were checked — otherwise a hostname that resolves public
 * once and private a millisecond later (DNS rebinding) walks straight through a
 * check that already passed.
 *
 * ⚠️ THE CONSEQUENCE IS STATED IN THE TOOL DESCRIPTION, NOT HIDDEN: this tool
 * CANNOT talk to a server the agent just started on localhost. That is a real
 * loss and it is deliberate — "read my dev server" is a different primitive with
 * a different threat model, and merging the two is how the guard gets a bypass
 * flag that eventually defaults to on.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 * No POST. No model-supplied headers, cookies, auth or body. The schema exposes
 * `url`, `offset`, `limit` and refuses everything else BY NAME — a tool that can
 * be talked into sending an Authorization header is a credential exfiltration
 * path with a docs-lookup costume on.
 */

import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveInWorkspace } from './workspace.mjs';

/**
 * ⚠️ THE SHAPES ARE DECLARED, NOT INFERRED — same reason as workspace.mjs and
 * git.mjs. Inference widens `ok: false` to `ok: boolean` and the discriminated
 * union dies at the call site, where the console's TypeScript client reads it.
 *
 * @typedef {{ ok: false, error: string }} FetchRefused
 * @typedef {{
 *   ok: true, url: string, finalUrl: string, status: number, contentType: string,
 *   totalChars: number, cachePath: string | null, fromCache: boolean,
 *   text: string, nextOffset: number | null, truncated?: boolean
 * }} FetchOk
 * @typedef {{ address: string, family: number }} ResolvedAddress
 */

/** A doc lookup is fast or it is not happening. Whole-request budget, all hops. */
export const FETCH_TIMEOUT_MS = 20_000;
/** Three hops covers http→https→www→canonical. A fourth is a loop or a trap. */
export const MAX_REDIRECTS = 3;
/** Hard ceiling on what comes off the wire, decompressed. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** One window. Big enough to hold an API section, small enough to not eat a turn. */
export const DEFAULT_WINDOW = 6_000;
export const MAX_WINDOW = 12_000;
/**
 * ⚠️ PER-PROCESS BUDGETS, and they exist because of the loop this file is fixing.
 * An agent that can fetch can crawl, and a crawl inside an agent turn is a
 * budget fire nobody watches. Ten lookups settles any question a coding task
 * has; three per host stops one site becoming the whole session.
 */
export const MAX_FETCHES_PER_PROCESS = 10;
export const MAX_FETCHES_PER_HOST = 3;

/** Same `.acuvo/` the audit log, policy and mcp config already live in. */
export const CACHE_DIR = '.acuvo/fetch';

/** Content types worth converting to text. Everything else is refused BY NAME. */
const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml)$|application\/[a-z0-9.+-]*\+json$|application\/[a-z0-9.+-]*\+xml$)/i;

/* ────────────────────────────────────────────────────────────────────────────
 * PER-PROCESS STATE
 *
 * ⚠️ PER-PROCESS AND NOT PERSISTED, exactly like breaker.mjs and for the same
 * reason: a CLI run is minutes long, so there is no cache-expiry policy worth
 * modelling and the next invocation gets fresh docs for free. The disk file is
 * for PAGING within a session, not an HTTP cache — a stale answer that survives
 * a restart is how a model ends up quoting last month's API.
 * ──────────────────────────────────────────────────────────────────────────── */

/** url → { cachePath, text|null, finalUrl, status, contentType, totalChars, truncated } */
const session = new Map();
/** host → number of requests made this process. */
const perHost = new Map();
let fetchesMade = 0;

/** Reset between tests. Never called in normal operation — a run is short. */
export function resetFetchState() {
  session.clear();
  perHost.clear();
  fetchesMade = 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE ADDRESS GUARD
 * ──────────────────────────────────────────────────────────────────────────── */

function parseIPv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = [];
  for (const p of parts) {
    // ⚠️ No leading zeros, no `0x`, no shorthand. `0177.0.0.1` is 127.0.0.1 to
    // inet_aton and something else to a naive parser, and that gap has been a
    // real SSRF bypass more than once. Anything unusual is refused, not parsed.
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Returns 16 bytes, or null. Handles `::` compression and a trailing IPv4. */
function parseIPv6(s) {
  let text = s;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(':')) return null;

  let tail4 = null;
  const lastColon = text.lastIndexOf(':');
  const after = text.slice(lastColon + 1);
  if (after.includes('.')) {
    tail4 = parseIPv4(after);
    if (!tail4) return null;
    text = text.slice(0, lastColon + 1) + '0:0';
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part) => (part === '' ? [] : part.split(':').map((g) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return NaN;
    return parseInt(g, 16);
  }));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if ([...head, ...tail].some((n) => Number.isNaN(n))) return null;

  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  if (tail4) { bytes[12] = tail4[0]; bytes[13] = tail4[1]; bytes[14] = tail4[2]; bytes[15] = tail4[3]; }
  return bytes;
}

function blockedV4([a, b]) {
  if (a === 0) return true;              // 0.0.0.0/8 — "this network", and 0.0.0.0 IS localhost on Linux
  if (a === 10) return true;             // RFC1918
  if (a === 127) return true;            // loopback
  if (a === 169 && b === 254) return true; // link-local — INCLUDING 169.254.169.254, the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 168) return true;           // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — a real private range on cloud hosts
  if (a >= 224) return true;             // multicast, reserved, and 255.255.255.255
  return false;
}

/**
 * Is this resolved address one the tool must never open a socket to?
 *
 * ⚠️ FAILS CLOSED. An address string this cannot parse is refused, because the
 * alternative — "I did not understand it, so it is probably fine" — is the exact
 * reasoning that turns a parser gap into a bypass.
 *
 * @param {unknown} ip
 * @returns {boolean}
 */
export function isBlockedAddress(ip) {
  if (typeof ip !== 'string' || !ip.trim()) return true;
  const raw = ip.trim();

  const v4 = parseIPv4(raw);
  if (v4) return blockedV4(v4);

  const v6 = parseIPv6(raw);
  if (!v6) return true;

  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible (::127.0.0.1) both reach
  // v4 destinations, so they are checked as v4 rather than as "some IPv6 address
  // that is not on the list".
  const firstTenZero = v6.slice(0, 10).every((b) => b === 0);
  if (firstTenZero && v6[10] === 0xff && v6[11] === 0xff) return blockedV4(v6.slice(12));
  if (firstTenZero && v6[10] === 0 && v6[11] === 0) {
    const low = v6.slice(12);
    if (low.every((b) => b === 0)) return true;             // ::
    if (low[0] === 0 && low[1] === 0 && low[2] === 0 && low[3] === 1) return true; // ::1
    return blockedV4(low);                                  // ::a.b.c.d
  }
  if ((v6[0] & 0xfe) === 0xfc) return true;                 // fc00::/7 unique-local
  if (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (v6[0] === 0xff) return true;                          // ff00::/8 multicast
  return false;
}

const BLOCKED_MESSAGE = 'this tool cannot reach private or local addresses';

/**
 * Is this hostname an address rather than a name?
 *
 * ⚠️ DELIBERATELY GENEROUS. Anything made only of digits and dots, or holding a
 * colon, is treated as a literal and handed to `isBlockedAddress` — which fails
 * closed. So `0177.0.0.1` and `2130706433` are refused as unparseable addresses
 * rather than handed to a resolver that might make something of them. A real
 * hostname cannot be all digits and dots, so nothing legitimate is lost.
 */
function looksLikeIpLiteral(host) {
  return /^[0-9.]+$/.test(host) || host.includes(':');
}

/**
 * Validate one hop: scheme, credentials, and every address the hostname resolves
 * to. Returns the resolved addresses so the socket can be PINNED to them.
 *
 * ⚠️ Re-run on every redirect. A first hop that is public says nothing about the
 * second — "public host 302s to 127.0.0.1" is the standard SSRF filter bypass,
 * and it costs one function call to close.
 */
async function validateHop(urlString, lookupImpl) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return {
      ok: false,
      error: `"${String(urlString).slice(0, 120)}" is not a full URL. Include the scheme, e.g. https://nodejs.org/api/test.html`,
    };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // Named, not lumped into "invalid URL": the model must learn the boundary,
    // and for the common cases there is a better tool to point it at.
    const alt = u.protocol === 'file:'
      ? ' Use read_file for something on this machine.'
      : '';
    return { ok: false, error: `fetch_url speaks http and https only — "${u.protocol}" is refused.${alt}` };
  }
  if (u.username || u.password) {
    return {
      ok: false,
      error: 'this URL embeds credentials (user:pass@host) and is refused. fetch_url never sends authentication; fetch a public URL instead.',
    };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, error: 'that URL has no hostname' };

  /**
   * ⚠️⚠️ AN IP LITERAL IS CHECKED DIRECTLY AND NEVER SENT TO THE RESOLVER, and
   * this was a real hole found by its own test. `http://127.0.0.1:8080/admin`
   * has nothing to resolve — but routing it through `lookupImpl` anyway makes
   * the verdict depend on what the resolver says about the string "127.0.0.1",
   * and a resolver is a thing outside this process. The test that caught it
   * stubbed the resolver, the stub answered "public", and the guard cheerfully
   * approved loopback. In production the answer would have been right by luck;
   * here it is right by construction.
   */
  const literal = looksLikeIpLiteral(host);
  if (literal) {
    if (isBlockedAddress(host)) return { ok: false, error: `${BLOCKED_MESSAGE} — "${host}".` };
    return { ok: true, url: u, host: host.toLowerCase(), addresses: [{ address: host, family: host.includes(':') ? 6 : 4 }] };
  }

  /** @type {ResolvedAddress[]} */
  let addresses;
  try {
    addresses = await lookupImpl(host);
  } catch (err) {
    const code = err?.code || err?.errno || 'lookup failed';
    return {
      ok: false,
      error: `could not resolve "${host}" (${code}). Check the host name — fetch_url takes an exact URL and does not search.`,
    };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, error: `"${host}" resolved to no addresses` };
  }
  // ⚠️ ANY blocked address refuses the whole hop, not "the first one is fine".
  // A host with one public and one loopback record would otherwise be a coin
  // flip decided by resolver ordering.
  const bad = addresses.find((a) => isBlockedAddress(a?.address));
  if (bad) {
    return { ok: false, error: `${BLOCKED_MESSAGE} — "${host}" resolves to ${bad.address}.` };
  }
  return { ok: true, url: u, host: host.toLowerCase(), addresses };
}

/* ────────────────────────────────────────────────────────────────────────────
 * HTML → TEXT
 * ──────────────────────────────────────────────────────────────────────────── */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  // The four that actually show up in docs prose and would otherwise read as
  // literal `&mdash;` noise in the model's context.
  mdash: '—', ndash: '–', hellip: '…', copy: '©',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/**
 * Turn a documentation page into something a model can read.
 *
 * Pure and separately tested — which is the point. The transport can only be
 * exercised with a socket or a stub; THIS is where the actual quality of a doc
 * lookup lives, and it can be pinned down with a fixture.
 *
 * ⚠️ `<pre>` AND `<code>` ARE EXTRACTED FIRST AND PUT BACK LAST. Every other
 * step here collapses whitespace, and collapsing whitespace inside a code sample
 * turns the one part of the page the model came for into an unindented smear.
 * That is not a formatting nicety: `mock.timers.enable({ apis: [...] })` is
 * copied from a doc code block, and a mangled block is how you get a plausible
 * invented call instead.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (typeof html !== 'string') return '';
  let s = html;

  // 1. Contents that are not prose. Dropped WITH their tags — `<script>` text
  //    is code the page runs, and handing it to the model is pure token burn.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  /**
   * ⚠️⚠️ THE HEAD IS FOUND BY WHERE THE BODY STARTS, NOT BY MATCHING A TAG PAIR
   * — and it took the real page twice to get this right.
   *
   * Attempt 1 was `/<head\b[^>]*>[\s\S]*?<\/head>/`, which is the obvious rule
   * and does nothing at all on https://nodejs.org/api/test.html, the exact page
   * this module was written for. Measured on the live document (943,859 chars,
   * 2026-08-10): **it contains neither `<head>` nor `</head>`.** Both tags are
   * optional in HTML and the minifier drops them. My grep for `<head` matched
   * at 5750 and my grep for `</head` matched at 27418, which looked like proof
   * the pair existed — they were `<header class=header>` and `</header>`. Being
   * fooled by `<header>` is why attempt 2, cutting at `</head>`, also shipped
   * nothing.
   *
   * ⭐ THE FIXTURE HAD BOTH TAGS, SO THE TEST WAS GREEN ABOUT A RULE THAT DID
   * NOT WORK. A fixture written from what HTML is supposed to look like proves
   * nothing about what servers send; only the render caught it, which is the
   * same lesson `see_page` exists for one layer up.
   *
   * So the rule is now the browser's own: whatever precedes `<body>` is
   * preamble. The `<pre>/<code>` guard keeps a page that merely QUOTES a body
   * tag inside a code sample from being decapitated.
   */
  const bodyOpen = /<body\b[^>]*>/i.exec(s);
  const verbatimAt = s.search(/<(pre|code)\b/i);
  if (bodyOpen && (verbatimAt === -1 || bodyOpen.index < verbatimAt)) {
    s = s.slice(bodyOpen.index + bodyOpen[0].length);
  } else {
    const headEnd = /<\/head\s*>/i.exec(s);
    if (headEnd && (verbatimAt === -1 || headEnd.index < verbatimAt)) s = s.slice(headEnd.index + headEnd[0].length);
    else s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
  }
  s = s.replace(/<(script|style|svg|noscript|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // An unclosed <script> at the end of a truncated document would otherwise
  // survive the pass above and leak its whole body.
  s = s.replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*$/gi, '');

  // 2. Park the verbatim blocks behind sentinels. NUL is used because it cannot
  //    survive step 6 by accident and cannot appear in the source text — the
  //    transport refuses binary content types before we ever get here.
  /** @type {string[]} */
  const verbatim = [];
  const park = (_all, inner) => {
    const cleaned = decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\r\n?/g, '\n');
    verbatim.push(cleaned);
    return `\u0000V${verbatim.length - 1}\u0000`;
  };
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, park);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, park);

  // 3. The tags whose whole job is a line break.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|blockquote|ul|ol|table)>/gi, '\n\n');
  s = s.replace(/<\/(li|tr|dt|dd)>/gi, '\n');
  // A cell boundary that becomes nothing merges two columns into one word.
  s = s.replace(/<\/(td|th)>/gi, '\t');
  s = s.replace(/<h[1-6]\b[^>]*>/gi, '\n\n');
  s = s.replace(/<\/h[1-6]>/gi, '\n\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');

  // 4. Everything else that is markup is not content.
  s = s.replace(/<[^>]*>/g, '');

  // 5. Entities AFTER tag stripping, never before: decoding first would turn a
  //    literal `&lt;script&gt;` in the prose into a tag the next pass eats.
  s = decodeEntities(s);

  // 6. Whitespace. Horizontal runs collapse, trailing spaces go, 3+ blank lines
  //    become 2 — a doc page is mostly layout whitespace and the model pays for
  //    every space of it.
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[^\S\n]+/g, ' ');
  s = s.split('\n').map((line) => line.trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');

  // 7. Put the code back, indentation intact.
  s = s.replace(/\u0000V(\d+)\u0000/g, (_m, i) => verbatim[Number(i)] ?? '');
  // Any sentinel that survived a mangled document must not reach the model.
  s = s.replace(/\u0000/g, '');

  return s.trim();
}

/* ────────────────────────────────────────────────────────────────────────────
 * TRANSPORT
 * ──────────────────────────────────────────────────────────────────────────── */

let cachedVersion = null;
function userAgent() {
  if (cachedVersion === null) {
    try {
      cachedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
    } catch {
      // A CLI that cannot read its own manifest still has to be able to fetch.
      cachedVersion = '0.0.0';
    }
  }
  return `acuvo-code/${cachedVersion}`;
}

/**
 * ⚠️⚠️ DELIBERATELY DUMB, AND THAT IS THE CONTRACT. This opens a socket to
 * whatever it is given and validates NOTHING — the address guard lives in
 * `fetchText`, above it, so there is exactly one place that decides what is
 * reachable. Never call this with a model-supplied URL. It is exported so the
 * tests can drive a real `node:http` server on 127.0.0.1 THROUGH the injection
 * seam, which is how the SSRF guard stays under test instead of switched off
 * for the test suite (a guard with a test-only bypass is a guard with a bypass).
 *
 * Resolves to `{ status, headers, body, truncated }`. Rejects only on a real
 * transport failure, and the error carries `.code` so the caller can tell a
 * socket reset apart from a timeout.
 */
export async function rawHttpRequest({ url, headers = {}, timeoutMs = FETCH_TIMEOUT_MS, addresses = null, maxBytes = MAX_BODY_BYTES }) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;

  /**
   * ⚠️ THE SOCKET IS PINNED TO THE ADDRESSES THAT WERE CHECKED. Without this,
   * the guard resolves a hostname, approves it, and then Node resolves it AGAIN
   * for the connection — a second lookup that can return a different answer.
   * That is DNS rebinding, and it is the difference between a check and a
   * guarantee. SNI and the Host header still come from the URL, so pinning does
   * not break TLS or virtual hosting.
   */
  const lookup = addresses
    ? (hostname, options, cb) => {
      const callback = typeof options === 'function' ? options : cb;
      const list = addresses.map((a) => ({ address: a.address, family: a.family || (a.address.includes(':') ? 6 : 4) }));
      if (options && typeof options === 'object' && options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    }
    : undefined;

  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: 'GET', headers, lookup, timeout: timeoutMs }, (res) => {
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(createInflate());
      else if (encoding === 'br') stream = res.pipe(createBrotliDecompress());

      /** @type {Buffer[]} */
      const chunks = [];
      let total = 0;
      let truncated = false;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          truncated,
        });
      };

      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          // ⚠️ THE SOCKET IS DESTROYED, not just ignored. Reading a 4GB file to
          // completion and then throwing it away is a denial of service the
          // agent performs on its own user's connection.
          truncated = true;
          chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (total - maxBytes))));
          req.destroy();
          res.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', finish);
      stream.on('error', (err) => {
        // A decompression failure on a body we deliberately cut short is not an
        // error, it is the expected consequence of cutting it short.
        if (truncated) return finish();
        if (!settled) { settled = true; reject(err); }
      });
    });

    req.on('timeout', () => {
      const err = new Error('timed out');
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Decode a body buffer, honouring the one legacy charset still worth honouring. */
function decodeBody(buf, contentType) {
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType || '');
  const charset = (m?.[1] || 'utf-8').toLowerCase();
  if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252') return buf.toString('latin1');
  return buf.toString('utf8');
}

/** The default one-hop transport, in the shape `fetchText` injects. */
async function defaultFetchImpl({ url, headers, timeoutMs, addresses }) {
  return rawHttpRequest({ url, headers, timeoutMs, addresses });
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE TOOL
 * ──────────────────────────────────────────────────────────────────────────── */

const KNOWN_ARGS = new Set(['root', 'url', 'offset', 'limit', 'fetchImpl', 'lookupImpl']);

function cachePathFor(url) {
  return `${CACHE_DIR}/${createHash('sha1').update(url).digest('hex')}.txt`;
}

/** The window, plus the honest answer to "is there more". */
function windowOf(text, offset, limit) {
  const slice = text.slice(offset, offset + limit);
  const end = offset + slice.length;
  return { text: slice, nextOffset: end < text.length ? end : null };
}

/**
 * Fetch a URL and return a readable window of it.
 *
 * @param {{
 *   root?: string, url?: unknown, offset?: unknown, limit?: unknown,
 *   fetchImpl?: Function, lookupImpl?: Function
 * }} params
 * @returns {Promise<FetchOk | FetchRefused>}
 */
export async function fetchText(params = {}) {
  /**
   * ⚠️ UNKNOWN KEYS ARE REFUSED BY NAME, HERE RATHER THAN IN THE DISPATCHER.
   * The registration snippet spreads the model's arguments straight in, so this
   * is the only place that sees them. A model that tried `headers` or `method`
   * must be TOLD that this tool has no such control — silently dropping the key
   * teaches it that the header was sent, which is the worse of the two failures.
   */
  const unknown = Object.keys(params).filter((k) => !KNOWN_ARGS.has(k));
  if (unknown.length) {
    return {
      ok: false,
      error: `fetch_url does not accept "${unknown[0]}". It sends a fixed GET — no headers, cookies, auth, method or body are configurable — and takes only url, offset and limit.`,
    };
  }
  // The two injection seams are for tests and for the console's executor. A
  // model can only ever supply JSON, so a non-function here is a model reaching
  // for a control it does not have.
  for (const seam of ['fetchImpl', 'lookupImpl']) {
    if (params[seam] !== undefined && typeof params[seam] !== 'function') {
      return { ok: false, error: `fetch_url does not accept "${seam}". It takes only url, offset and limit.` };
    }
  }

  const { root, fetchImpl = defaultFetchImpl } = params;
  const lookupImpl = params.lookupImpl
    || ((host) => dns.lookup(host, { all: true, verbatim: true }));

  if (typeof params.url !== 'string' || !params.url.trim()) {
    return { ok: false, error: 'fetch_url needs a url, e.g. "https://nodejs.org/api/test.html"' };
  }
  const url = params.url.trim();

  const offset = params.offset === undefined ? 0 : Number(params.offset);
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, error: `offset must be a whole number of characters from the start of the document, not ${JSON.stringify(params.offset)}` };
  }
  let limit = params.limit === undefined ? DEFAULT_WINDOW : Number(params.limit);
  if (!Number.isInteger(limit) || limit <= 0) {
    return { ok: false, error: `limit must be a positive whole number of characters, not ${JSON.stringify(params.limit)}` };
  }
  // Clamped rather than refused: a model asking for 100k characters wants the
  // document, and giving it 12k plus a nextOffset answers that. Refusing would
  // cost a round to learn a number it could have been handed.
  if (limit > MAX_WINDOW) limit = MAX_WINDOW;

  /* ── ALREADY FETCHED THIS SESSION → NO REQUEST AT ALL ───────────────────── */
  const previous = session.get(url);
  if (previous) {
    const full = readCached(previous);
    if (full === null) {
      return { ok: false, error: `the cached copy of ${url} is gone from ${previous.cachePath}. Fetch a different URL, or re-read it with read_file if you still have the path.` };
    }
    return finishWindow({ ...previous, text: full, url, offset, limit, fromCache: true });
  }

  /* ── BUDGETS ───────────────────────────────────────────────────────────── */
  if (fetchesMade >= MAX_FETCHES_PER_PROCESS) {
    return {
      ok: false,
      error: `fetch_url has already made ${MAX_FETCHES_PER_PROCESS} requests this run, which is the limit. Re-read anything you already fetched (that is free and does not count), and work from what you have.`,
    };
  }

  /* ── HOP LOOP ──────────────────────────────────────────────────────────── */
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let current = url;
  let hops = 0;
  let response = null;
  let finalUrl = url;

  for (;;) {
    const hop = await validateHop(current, lookupImpl);
    if (!hop.ok) return hop;

    /**
     * ⚠️ THE BUDGET IS CHARGED ONCE PER LOOKUP, NOT ONCE PER HOP — and getting
     * that wrong made its own test fail in an instructive way. Billing each
     * redirect against the host meant `http → https → www → canonical`, which is
     * ONE document and a completely normal chain, spent the entire per-host
     * allowance before it arrived. The budgets exist to stop a CRAWL; a redirect
     * chain is not a crawl and is already bounded by MAX_REDIRECTS.
     */
    if (hops === 0) {
      const hostCount = perHost.get(hop.host) ?? 0;
      if (hostCount >= MAX_FETCHES_PER_HOST) {
        return {
          ok: false,
          error: `fetch_url has already requested ${MAX_FETCHES_PER_HOST} pages from ${hop.host} this run, which is the limit. Use what you fetched from it rather than crawling further.`,
        };
      }
      perHost.set(hop.host, hostCount + 1);
      fetchesMade += 1;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, error: `${url} did not finish within ${FETCH_TIMEOUT_MS / 1000}s. Try a more specific page — this tool is for one document, not a slow endpoint.` };
    }

    const request = () => fetchImpl({
      url: current,
      headers: {
        // ⚠️ FIXED, AND THE MODEL CANNOT ADD TO THEM. No cookie, no auth, no
        // referer — this request carries nothing about the machine it runs on.
        'user-agent': userAgent(),
        accept: 'text/html,text/plain,application/json',
        'accept-encoding': 'gzip, deflate, br',
        connection: 'close',
      },
      timeoutMs: Math.min(remaining, FETCH_TIMEOUT_MS),
      addresses: hop.addresses,
    });

    try {
      response = await request();
    } catch (err) {
      const code = err?.code || err?.cause?.code || err?.name || 'unknown';
      /**
       * ⚠️ ONE RETRY, AND ONLY FOR A RESET. A connection reset genuinely is
       * transient. A timeout is not — retrying it spends the timeout twice and
       * is precisely the mistake breaker.mjs was written after.
       */
      const retryable = code === 'ECONNRESET' || code === 'EPIPE';
      if (retryable && deadline - Date.now() > 2_000) {
        try {
          response = await request();
        } catch (err2) {
          return { ok: false, error: `could not fetch ${current}: ${err2?.code || err2?.message || 'connection failed'} (retried once)` };
        }
      } else {
        const hint = code === 'ETIMEDOUT' || code === 'ERR_SOCKET_TIMEOUT'
          ? ' — the server did not answer in time. Pick a lighter page rather than repeating this one.'
          : '';
        return { ok: false, error: `could not fetch ${current}: ${code}${hint}` };
      }
    }

    const status = response?.status ?? 0;
    const location = response?.headers?.location;
    if (status >= 300 && status < 400 && location) {
      hops += 1;
      if (hops > MAX_REDIRECTS) {
        return { ok: false, error: `${url} redirected more than ${MAX_REDIRECTS} times. Fetch the final URL directly.` };
      }
      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, error: `${current} redirected to something that is not a URL ("${String(location).slice(0, 80)}")` };
      }
      continue; // ⭐ and the guard runs again at the top — that is the whole point
    }

    finalUrl = current;
    break;
  }

  /* ── STATUS ────────────────────────────────────────────────────────────── */
  const rawHeaders = response.headers || {};
  const contentType = String(rawHeaders['content-type'] || '').trim();
  const bodyBuf = Buffer.isBuffer(response.body) ? response.body : Buffer.from(String(response.body ?? ''), 'utf8');

  if (response.status < 200 || response.status >= 300) {
    // ⚠️ THE BODY IS INCLUDED. "HTTP 404" tells a model nothing it can act on;
    // the body usually says "moved to /api/test.html" and names the fix.
    const snippet = decodeBody(bodyBuf, contentType).replace(/\s+/g, ' ').trim().slice(0, 500);
    return {
      ok: false,
      error: `${finalUrl} returned HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`,
    };
  }

  /* ── CONTENT TYPE ──────────────────────────────────────────────────────── */
  const mime = contentType.split(';')[0].trim().toLowerCase();
  // A server that states no type is almost always serving plain text (raw files,
  // small APIs). Guessing text here is safe because the WRONG guess is caught
  // below by the same binary check `read_file` uses.
  const effective = mime || 'text/plain';
  if (!TEXTUAL.test(effective)) {
    return {
      ok: false,
      // ⚠️ NAMES THE TYPE. "unsupported content" sends the model back to try the
      // same URL a different way; "it is image/png" ends the line of enquiry.
      error: `${finalUrl} is ${effective}, which fetch_url does not read — it converts text, HTML, JSON and XML only.`,
    };
  }

  let decoded = decodeBody(bodyBuf, contentType);
  if (decoded.includes('\u0000')) {
    return { ok: false, error: `${finalUrl} claims to be ${effective} but the body is binary. Refusing to read it as text.` };
  }

  /* ── CONVERT ───────────────────────────────────────────────────────────── */
  let text;
  /**
   * ⭐ JSON IS DETECTED BY PARSING IT, NOT ONLY BY BELIEVING THE HEADER — found
   * in the live demo: `https://registry.npmjs.org/zod/latest` came back declared
   * `text/plain`, so a 40KB single-line payload went to the model minified, and
   * every 6000-character window landed mid-token. Sniffing is normally a bad
   * idea, but this variant cannot produce a false positive: the test IS
   * `JSON.parse` succeeding on the whole body. If it parses, it is JSON.
   */
  const looksJson = /json/.test(effective)
    || (effective === 'text/plain' && /^[\s]*[[{]/.test(decoded));
  if (looksJson) {
    // Pretty-printed rather than HTML-converted: a minified JSON payload on one
    // line is unreadable and, worse, unpageable — every window lands mid-token.
    try { text = JSON.stringify(JSON.parse(decoded), null, 2); } catch { text = decoded; }
  } else if (effective === 'text/html' || effective === 'application/xhtml+xml') {
    text = htmlToText(decoded);
  } else {
    // text/plain, text/markdown, xml, css, whatever else is textual — pass
    // through. Converting markdown would destroy the structure it came with.
    text = decoded;
  }
  if (response.truncated) {
    text += `\n\n[fetch_url stopped at ${MAX_BODY_BYTES / (1024 * 1024)}MB — this document is longer than that and the rest was not downloaded]`;
  }

  /* ── CACHE ─────────────────────────────────────────────────────────────── */
  const record = {
    cachePath: null, absolute: null, text: null, finalUrl, status: response.status,
    contentType: effective, totalChars: text.length, truncated: Boolean(response.truncated),
  };
  const written = writeCache(root, url, text);
  if (written.path) {
    record.cachePath = written.path;
    // The absolute path is kept so a repeat call reads the file back without
    // re-deriving it from the URL hash — the derivation is the part that could
    // silently drift if the naming ever changes.
    record.absolute = written.absolute;
  } else {
    // ⚠️ A memory workspace (and a read-only disk) has nowhere to put it, so the
    // full text is held in the session map instead. It is NOT reported as
    // cached — claiming a cachePath that cannot be read is the reassuring lie
    // this codebase keeps having to delete.
    record.text = text;
  }
  session.set(url, record);

  return finishWindow({ ...record, text, url, offset, limit, fromCache: false });
}

/** Read the whole converted document back for a repeat call. */
function readCached(record) {
  if (record.text !== null && record.text !== undefined) return record.text;
  if (!record.absolute || !existsSync(record.absolute)) return null;
  try { return readFileSync(record.absolute, 'utf8'); } catch { return null; }
}

/**
 * Write the FULL converted text so later windows cost nothing.
 *
 * ⚠️ THROUGH `resolveInWorkspace`, like every other path in this package. The
 * filename is a sha1 of the URL, so it cannot contain anything interesting, but
 * routing it through the workspace rules anyway is what keeps "every path goes
 * through one function" true rather than nearly true.
 */
function writeCache(root, url, text) {
  if (!root || root === '(memory)') return { path: null };
  const rel = cachePathFor(url);
  const target = resolveInWorkspace(root, rel, 'write');
  if (!target.ok) return { path: null };
  try {
    mkdirSync(dirname(target.absolute), { recursive: true });
    writeFileSync(target.absolute, text, 'utf8');
  } catch {
    // A read-only or full disk must not fail the lookup — the window in hand is
    // still useful, and the only thing lost is the free second page.
    return { path: null };
  }
  return { path: target.relative, absolute: target.absolute };
}

/** Assemble the result. One place, so a cached hit and a fresh fetch cannot drift. */
function finishWindow(r) {
  if (r.offset > 0 && r.offset >= r.text.length) {
    return {
      ok: false,
      error: `offset ${r.offset} is past the end of ${r.url} (${r.text.length} characters). The last window starts at ${Math.max(0, r.text.length - DEFAULT_WINDOW)}.`,
    };
  }
  const w = windowOf(r.text, r.offset, r.limit);
  return {
    ok: true,
    url: r.url,
    finalUrl: r.finalUrl,
    status: r.status,
    contentType: r.contentType,
    totalChars: r.text.length,
    cachePath: r.cachePath ?? null,
    fromCache: Boolean(r.fromCache),
    text: w.text,
    nextOffset: w.nextOffset,
    ...(r.truncated ? { truncated: true } : {}),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * SCHEMA
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ THE DESCRIPTION STATES THE LOCALHOST LIMIT OUT LOUD. A model that does not
 * know it will spend a round discovering it, then a second round arguing with
 * the refusal — the two rounds probe D spent on truncation. What the schema says
 * is the cheapest documentation in the system.
 */
export function fetchToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'fetch_url',
        description: [
          'Fetch a public http/https page as readable TEXT — this is how you check an API before you use it,',
          'instead of guessing an option name or an import shape.',
          'HTML is converted to text with code blocks kept intact, JSON is pretty-printed, plain text passes through.',
          `Returns a window of ${DEFAULT_WINDOW} characters by default (max ${MAX_WINDOW});`,
          'the reply carries `nextOffset` — call again with that as `offset` for the next window, which is free',
          'because the whole document is cached on the first call. `cachePath` names that file if you would rather read it.',
          'GET only: no headers, cookies, authentication, method or body can be set, by design.',
          'It CANNOT reach private or local addresses, so it cannot talk to a server you just started on localhost',
          '— use run_command to test that instead.',
          `At most ${MAX_FETCHES_PER_PROCESS} fetches per run and ${MAX_FETCHES_PER_HOST} per host; re-reading a URL you already fetched is free.`,
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'A full http/https URL, e.g. "https://nodejs.org/api/test.html".' },
            offset: { type: 'integer', description: 'Character offset to start the window at. Use the `nextOffset` from the previous call.' },
            limit: { type: 'integer', description: `Characters to return, default ${DEFAULT_WINDOW}, max ${MAX_WINDOW}.` },
          },
          required: ['url'],
        },
      },
    },
  ];
}
