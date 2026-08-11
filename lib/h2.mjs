/**
 * ── ⭐⭐ HTTP/2 WITH A BROWSER TLS FINGERPRINT, IN ZERO DEPENDENCIES ─────────
 *
 * Written because I was wrong, and the way I was wrong is worth recording.
 *
 * I tested `fetch()` against a Cloudflare-protected host once, got
 * "Just a moment...", and declared native access impossible without a native
 * dependency like curl_cffi. Roman pushed back. He was right: I had tested ONE
 * configuration and generalised from it — the exact assume-instead-of-measure
 * failure this codebase keeps catching in other people's work.
 *
 * ── THE MEASUREMENT (3 trials per cell, same host, same minute) ─────────────
 *
 *   HTTP/1.1 + Safari ciphers      403 — challenge
 *   HTTP/2   + default node ciphers 403 403 403
 *   HTTP/2   + Safari ciphers       200 200 200   ← and headers made no difference
 *
 * ⭐ SO IT IS BOTH, AND NEITHER ALONE. The protocol matters because a real
 * browser always negotiates h2 — a browser User-Agent arriving over HTTP/1.1 is
 * itself the tell, and `fetch()` in Node is HTTP/1.1. The cipher list matters
 * because its contents AND ORDER are most of what a JA3 fingerprint hashes, and
 * Node's default list is nothing like any browser's.
 *
 * ⚠️ Both are reachable from `node:http2`, which ships with Node. No dependency,
 * no native module, no headless browser. The thing I said was impossible costs
 * about eighty lines.
 *
 * ── ⚠️ WHAT THIS IS AND IS NOT ──────────────────────────────────────────────
 * It is a fingerprint that resembles a browser well enough for a bot-management
 * edge to pass it. It is NOT a JS engine: a host that serves an actual
 * interstitial requiring script execution will still defeat it, and this module
 * says so rather than retrying forever.
 *
 * ⚠️ AND IT IS FRAGILE BY NATURE. Fingerprinting is an arms race; this can stop
 * working on any given Tuesday with no warning and no error we can distinguish
 * from an outage. Anything built on it needs a fallback that does not depend on
 * it — which is why the image path has a second provider rather than treating
 * this as a solved problem.
 */

import http2 from 'node:http2';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';

/**
 * Safari 17 / macOS, in Safari's own order.
 *
 * ⚠️ THE ORDER IS THE POINT, so do not sort this list, deduplicate it, or
 * "tidy" it alphabetically. JA3 hashes the sequence; re-ordering it produces a
 * different fingerprint and the 200s become 403s with no other symptom.
 */
export const SAFARI_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES256-SHA384',
  'ECDHE-RSA-AES256-SHA384',
  'AES256-GCM-SHA384',
  'AES128-GCM-SHA256',
].join(':');

export const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15';

/** Curves in Safari's order, for the same reason as the ciphers. */
const CURVES = 'X25519:prime256v1:secp384r1';

const DEFAULT_TIMEOUT_MS = 60_000;
/** A response larger than this is not an API reply; stop reading it. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function decompress(buf, encoding) {
  try {
    if (encoding === 'gzip') return gunzipSync(buf);
    if (encoding === 'br') return brotliDecompressSync(buf);
    if (encoding === 'deflate') return inflateSync(buf);
  } catch {
    // A body that will not decompress is still evidence; hand back the raw bytes
    // rather than throwing away the only clue about what the server said.
  }
  return buf;
}

/**
 * One HTTP/2 request with a browser-shaped TLS handshake.
 *
 * ⚠️ NEVER THROWS. A transport failure is data, like everywhere else in this
 * package — a coding session must not die because a host was rude.
 *
 * @returns {Promise<{ok:boolean, status?:number, headers?:object, body?:Buffer, error?:string, challenged?:boolean}>}
 */
export function h2Request(url, {
  method = 'GET',
  headers = {},
  body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, error: `not a URL: ${String(url).slice(0, 80)}` });
  }
  if (target.protocol !== 'https:') {
    // h2 without TLS is a different protocol (h2c) and no CDN speaks it here.
    return Promise.resolve({ ok: false, error: 'h2Request is https-only' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let client;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      // ⚠️ The session is a socket. Leaving it open is a file descriptor and, at
      // scale, the orphaned-process problem this project has been bitten by.
      try { client?.close(); } catch { /* already gone */ }
      resolve(value);
    };

    try {
      client = http2.connect(target.origin, { ciphers: SAFARI_CIPHERS, ecdhCurve: CURVES });
    } catch (err) {
      return finish({ ok: false, error: `could not connect: ${err?.message ?? err}` });
    }
    client.on('error', (err) => finish({ ok: false, error: `h2 session failed: ${err?.code ?? err?.message ?? err}` }));

    const req = client.request({
      ':method': method,
      ':path': `${target.pathname}${target.search}`,
      ':authority': target.host,
      'user-agent': SAFARI_UA,
      accept: '*/*',
      'accept-language': 'en-AU,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      ...headers,
    });

    const chunks = [];
    let received = 0;
    let status = null;
    let responseHeaders = {};

    req.on('response', (h) => { status = h[':status']; responseHeaders = h; });
    req.on('data', (c) => {
      received += c.length;
      if (received > MAX_BODY_BYTES) { req.destroy(); return finish({ ok: false, status, error: `response exceeded ${MAX_BODY_BYTES} bytes` }); }
      chunks.push(c);
    });
    req.on('error', (err) => finish({ ok: false, error: `h2 request failed: ${err?.code ?? err?.message ?? err}` }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ ok: false, error: `no response in ${Math.round(timeoutMs / 1000)}s` });
    });
    req.on('end', () => {
      const decoded = decompress(Buffer.concat(chunks), responseHeaders['content-encoding']);
      /**
       * ⭐ A CHALLENGE IS NAMED, NOT REPORTED AS A GENERIC 403. The two need
       * different responses: a 403 may be a real authorisation failure worth
       * fixing, while a challenge means the fingerprint stopped working and no
       * amount of retrying or credential-fixing will help.
       */
      const head = decoded.subarray(0, 600).toString('utf8');
      const challenged = /Just a moment|cf-mitigated|challenge-platform|Attention Required/i.test(head);
      finish({
        ok: status >= 200 && status < 300,
        status,
        headers: responseHeaders,
        body: decoded,
        challenged,
        ...(challenged ? { error: 'the host served a bot challenge — the browser fingerprint is no longer passing, and retrying will not change that' } : {}),
      });
    });

    if (body) req.write(body);
    req.end();
  });
}

/** Convenience: parse a JSON body, without pretending a non-JSON body is empty. */
export async function h2Json(url, options) {
  const r = await h2Request(url, options);
  if (!r.ok) return r;
  const text = r.body.toString('utf8');
  try {
    return { ...r, json: JSON.parse(text) };
  } catch {
    return { ...r, ok: false, error: `expected JSON, got ${text.slice(0, 120).replace(/\s+/g, ' ')}` };
  }
}
