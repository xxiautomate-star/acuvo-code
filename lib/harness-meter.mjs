/**
 * ── ⭐⭐⭐ THE METERING PROXY — WHY `--harness` IS ALLOWED TO EXIST ──────────
 *
 * Metering is the moat. An execution backend that spends money outside
 * `budget.mjs` is not a feature, it is a runaway bill with a nice flag on it —
 * so this module is the condition on shipping the rest, not an addition to it.
 *
 * ── ⭐⭐ THE SHAPE, AND WHY IT IS A PROXY AND NOT A LOG READER ──────────────
 *
 * Codex reports its own tokens on stdout (`turn.completed.usage`), and reading
 * that is ACCOUNTING: it tells you what you already spent. This is a proxy
 * because a proxy can also REFUSE. `gate()` runs BEFORE the request is
 * forwarded, so a run that has exhausted `--budget` is stopped at the wire with
 * nothing spent, exactly like `canContinue()` stops our own loop. Observing a
 * bill and being able to prevent one are different products.
 *
 * ⚠️⚠️ AND A LOG READER CANNOT SEE A CACHE. The `response.completed` event
 * carries `input_tokens_details.cached_tokens` from the provider itself. Roman's
 * FIRST MVP acceptance point is *"caching solid even when models switch"*; a
 * harness whose cache rate we cannot observe could not be evaluated against it.
 *
 * ── ⚠️ ZERO DEPENDENCIES, DELIBERATELY ─────────────────────────────────────
 *
 * `node:http` and global `fetch`. No proxy library, no SSE library, no native
 * build. `package.json` `dependencies` stays `{}` — see `lib/harness.mjs`.
 *
 * ── ⚠️⚠️ THE THREE SECURITY PROPERTIES, NONE OF THEM OPTIONAL ──────────────
 *
 * 1. **BINDS TO 127.0.0.1, PORT 0.** Never a fixed port, never a wildcard
 *    interface. An OpenAI-compatible endpoint holding a live key, reachable from
 *    the LAN, is a credential-sharing service.
 * 2. **THE UPSTREAM KEY NEVER REACHES THE CHILD.** Codex is given a random
 *    per-run secret in its `env_key` variable; the proxy swaps it for the real
 *    key on the way out. A child process that dumps its own environment — and
 *    an agent that runs `env` is not a hypothetical — leaks a throwaway.
 * 3. **THAT SECRET IS VERIFIED.** Any other process on the machine could
 *    otherwise POST to the port and spend our money. Compared with
 *    `timingSafeEqual` on equal-length buffers, because a plain `===` on a
 *    secret is the kind of detail that is only ever noticed in a review.
 */

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { normaliseUsage } from './harness.mjs';

/** Where an OpenAI-compatible Responses API lives, when nobody says otherwise. */
export const DEFAULT_UPSTREAM = 'https://api.openai.com/v1';

/**
 * ⚠️ THE PATHS WE ARE WILLING TO FORWARD. An open relay to an arbitrary
 * upstream path is a proxy for anything on that host, not a model gateway.
 * `resolveUpstreamUrl` refuses everything else.
 */
export const FORWARDABLE = Object.freeze(['/responses', '/chat/completions', '/models']);

/**
 * ⚠️ HEADERS WE REFUSE TO PASS UPSTREAM. `authorization` is replaced (property
 * 2); `host` must be the upstream's or TLS/vhost routing breaks; the hop-by-hop
 * headers are meaningless to a different connection and `content-length` is
 * recomputed by fetch from the body we hand it — forwarding a stale one is how
 * a proxy truncates a request body.
 */
const STRIP_HEADERS = new Set([
  'authorization', 'host', 'connection', 'content-length',
  'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authorization',
]);

/**
 * Compare two secrets without leaking their length or content through timing.
 *
 * ⚠️ `timingSafeEqual` THROWS ON UNEQUAL LENGTHS, so the length check has to
 * come first — and that check is itself a leak of length only, which is not
 * secret for a value we generated at a fixed size.
 */
export function secretMatches(expected, given) {
  const a = Buffer.from(String(expected ?? ''), 'utf8');
  const b = Buffer.from(String(given ?? ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Build the upstream URL for an inbound request, or null to refuse.
 *
 * ⚠️ THE PATH IS MATCHED AGAINST A LIST, NOT CONCATENATED. Joining an inbound
 * path onto a base URL is how `/v1/../../admin` becomes somebody else's
 * afternoon. Only a known suffix is honoured, and the query string is dropped —
 * nothing we forward needs one.
 */
export function resolveUpstreamUrl(rawPath, upstream = DEFAULT_UPSTREAM) {
  const path = String(rawPath ?? '').split('?')[0];
  const base = String(upstream).replace(/\/+$/, '');
  for (const suffix of FORWARDABLE) {
    if (path === suffix || path === `/v1${suffix}`) return `${base}${suffix}`;
  }
  return null;
}

/**
 * ── ⭐⭐ READ THE USAGE OUT OF AN SSE STREAM WITHOUT BUFFERING IT ───────────
 *
 * The proxy must not hold a whole response in memory before forwarding it — the
 * child is streaming, and buffering would turn a live harness into a long pause
 * followed by a wall of text. So bytes are passed through the instant they
 * arrive and a copy is fed here.
 *
 * ⚠️⚠️ AN SSE EVENT IS NOT A CHUNK AND IS NOT A LINE. It is everything up to a
 * BLANK LINE, its payload can be split across arbitrarily many `data:` lines,
 * and TCP will split it across chunks wherever it likes. Parsing per-chunk finds
 * the `response.completed` event only when the network happens to cooperate —
 * which in practice means metering works on a fast localhost test and silently
 * stops working against a real provider under load.
 *
 * ⭐ RETURNS EVERY COMPLETED EVENT'S USAGE, and the caller records each. A
 * `response.completed` is one paid round.
 */
export function createSseUsageReader() {
  let buffer = '';
  const drain = (final) => {
    const out = [];
    // Events are separated by a blank line; \r\n\r\n is equally legal.
    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + buffer.slice(idx).match(/^\r?\n\r?\n/)[0].length);
      const usage = usageFromBlock(block);
      if (usage) out.push(usage);
    }
    if (final && buffer.trim()) {
      const usage = usageFromBlock(buffer);
      buffer = '';
      if (usage) out.push(usage);
    }
    return out;
  };
  return {
    push(chunk) { buffer += String(chunk); return drain(false); },
    flush() { return drain(true); },
  };
}

function usageFromBlock(block) {
  /**
   * ⚠️ CONCATENATE EVERY `data:` LINE. The SSE spec joins multi-line payloads
   * with a newline, and JSON does not care about the newline — but taking only
   * the FIRST data line, which is the obvious implementation, produces invalid
   * JSON for any large payload and therefore no usage at all.
   */
  const data = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('');
  if (!data || data === '[DONE]') return null;
  let parsed;
  try { parsed = JSON.parse(data); } catch { return null; }
  // The Responses API nests it; chat/completions puts it at the top level.
  const raw = parsed?.response?.usage ?? parsed?.usage;
  return normaliseUsage(raw);
}

/**
 * Start the metering proxy.
 *
 * @param {object} opts
 * @param {string} opts.apiKey       the REAL upstream key. Never given to the child.
 * @param {string} [opts.upstream]   OpenAI-compatible base URL.
 * @param {(usage:object)=>void} [opts.onUsage]  called once per completed response.
 * @param {()=>({ok:boolean,message?:string})} [opts.gate]  consulted BEFORE forwarding.
 * @param {typeof fetch} [opts.fetchImpl]  injected in tests; never spawns a real call.
 * @returns {Promise<{baseUrl:string, secret:string, close:()=>Promise<void>, stats:()=>object}>}
 */
export async function startMeterProxy({
  apiKey,
  upstream = DEFAULT_UPSTREAM,
  onUsage = null,
  gate = null,
  /** Called with the number of Acuvo MCP verbs visible in each outbound request. */
  onRequest = null,
  fetchImpl = fetch,
} = {}) {
  /**
   * ⚠️ A 32-BYTE RANDOM SECRET, NOT A UUID AND NOT THE PORT. It is the only
   * thing standing between this port and every other process on the machine.
   */
  const secret = randomBytes(32).toString('hex');
  const stats = { requests: 0, refused: 0, forwarded: 0, failed: 0, usageEvents: 0 };

  const server = createServer((req, res) => {
    stats.requests += 1;
    handle(req, res).catch((err) => {
      stats.failed += 1;
      /**
       * ⚠️ THE CHILD MUST ALWAYS GET AN ANSWER. An exception that kills the
       * handler without responding leaves codex retrying a dead socket five
       * times (measured — it reconnects 5× then fails), turning one clear error
       * into a two-minute hang with a misleading message.
       */
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: { message: `acuvo harness proxy: ${err?.message ?? err}` } }));
    });
  });

  async function handle(req, res) {
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!secretMatches(secret, given)) {
      stats.refused += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'acuvo harness proxy: not authorised' } }));
      return;
    }

    const target = resolveUpstreamUrl(req.url, upstream);
    if (!target) {
      stats.refused += 1;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `acuvo harness proxy: refuses to forward ${req.url}` } }));
      return;
    }

    /**
     * ── ⭐⭐ THE GATE. This is the half a log reader cannot do. ────────────
     *
     * ⚠️ IT ANSWERS 402, AND THE MESSAGE IS THE BUDGET'S OWN. A generic error
     * would reach the user through codex's retry logic as "stream disconnected",
     * which is what our own budget stop looked like before this line existed.
     */
    if (typeof gate === 'function') {
      let verdict;
      try { verdict = gate(); } catch { verdict = { ok: true }; }
      if (verdict && verdict.ok === false) {
        stats.refused += 1;
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: verdict.message || 'acuvo: budget reached' } }));
        return;
      }
    }

    const body = await readBody(req);
    /**
     * ── ⭐⭐ COUNT OUR OWN VERBS ON THE WIRE, DO NOT ANNOUNCE THEM ───────────
     *
     * The outbound request carries the exact tool list the model will see, so
     * this is the only place that can answer "did our MCP verbs actually
     * arrive?" with a number instead of a hope. It exists because the first
     * version of this feature printed *"acuvo verbs offered to the harness over
     * MCP"* while offering **zero** — see the `--root` comment in
     * `harness-run.mjs`.
     */
    if (typeof onRequest === 'function') {
      try { onRequest(countAcuvoTools(body)); } catch { /* observation is never worth a failure */ }
    }
    const headers = { authorization: `Bearer ${apiKey}` };
    for (const [k, v] of Object.entries(req.headers)) {
      if (!STRIP_HEADERS.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
    }

    const upstreamRes = await fetchImpl(target, { method: req.method, headers, body: body.length ? body : undefined });
    stats.forwarded += 1;

    const outHeaders = {};
    upstreamRes.headers.forEach((v, k) => {
      if (!STRIP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
    });
    res.writeHead(upstreamRes.status, outHeaders);

    const reader = createSseUsageReader();
    const report = (list) => {
      for (const usage of list) {
        stats.usageEvents += 1;
        if (typeof onUsage === 'function') {
          /**
           * ⚠️ A THROW FROM THE METER MUST NOT KILL THE RESPONSE. The user's
           * work is in flight; an accounting bug is not a reason to drop it.
           */
          try { onUsage(usage); } catch { /* accounted best-effort */ }
        }
      }
    };

    if (!upstreamRes.body) {
      const text = await upstreamRes.text();
      report(reader.push(text));
      report(reader.flush());
      res.end(text);
      return;
    }

    /**
     * ⭐ TEE, DO NOT BUFFER. Every chunk goes to the child immediately and a
     * copy goes to the usage reader.
     */
    for await (const chunk of upstreamRes.body) {
      const buf = Buffer.from(chunk);
      res.write(buf);
      report(reader.push(buf.toString('utf8')));
    }
    report(reader.flush());
    res.end();
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    secret,
    stats: () => ({ ...stats }),
    close: () => new Promise((resolve) => {
      /**
       * ⚠️ `closeAllConnections` OR THIS HANGS. Codex holds the SSE socket open;
       * `server.close()` alone waits for it and the CLI never exits — a process
       * that will not exit is indistinguishable, to a user, from one that has
       * frozen.
       */
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/**
 * How many Acuvo verbs does this outbound request actually offer the model?
 *
 * ⚠️ CODEX NESTS MCP TOOLS IN A `namespace` ENTRY, so a flat count of
 * `tools[].name` finds ONE — the namespace — and reports 1 for both a working
 * server and a broken one serving nothing. Measured: the namespace
 * `mcp__acuvo__` holds ten verbs (`find_files`, `read_file`, `search_text`, …)
 * in its own `tools` array. Counting the outer entry is the mistake that would
 * make this number decorative.
 *
 * ⭐ EXPORTED SO A TEST CAN DRIVE IT WITH BOTH SHAPES rather than trusting a
 * regex over a 46KB body.
 */
export function countAcuvoTools(body) {
  let parsed;
  try { parsed = JSON.parse(String(body)); } catch { return 0; }
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  let n = 0;
  for (const t of tools) {
    const name = String(t?.name ?? '');
    if (!name.includes('acuvo')) continue;
    // A namespace contributes its members; a flat tool contributes itself.
    n += Array.isArray(t?.tools) ? t.tools.length : 1;
  }
  return n;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
