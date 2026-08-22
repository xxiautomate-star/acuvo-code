/**
 * ── ⭐⭐ THE AGENT COULD BUILD AN API AND NEVER ONCE CALL IT ─────────────────
 *
 * MEASURED GAP, 2026-08-15. This CLI can already do two of the three things a
 * backend task needs:
 *
 *   · `start_process` (background.mjs) starts a dev server and tells you the
 *     port it announced, and even probes that the port is accepting HTTP.
 *   · `see_page` (media.mjs) renders a page in a browser and looks at it.
 *
 * What it could NOT do is make ONE request to an endpoint and read the answer.
 * So an agent could write `POST /users`, start the server, watch the port come
 * up — and have no way on earth to find out whether the route returns 201, 500
 * or a stack trace. The only evidence available was unit tests it also wrote,
 * which is a closed loop: the same misunderstanding writes the code and the
 * test, and both agree. `check_process`'s probe is not a substitute either — it
 * reports REACHABILITY on `/` and deliberately never returns a body.
 *
 * ── ⚠️⚠️ THE SECURITY ARGUMENT IS THE WHOLE DESIGN ──────────────────────────
 *
 * There are two precedents in this package and they point in opposite
 * directions. Both are right, and this module has to inherit both.
 *
 *   1. `fetch-text.mjs` REFUSES loopback and every private range, on resolved
 *      addresses, re-checked on every redirect hop, with the socket pinned. That
 *      guard exists because a page the model was told to read can talk it into
 *      fetching `169.254.169.254` or an internal admin panel. Its own comment
 *      states the cost out loud: "this tool CANNOT talk to a server the agent
 *      just started on localhost… merging the two is how the guard gets a bypass
 *      flag that eventually defaults to on."
 *
 *   2. `background.mjs` DOES touch loopback, and says exactly why it is allowed
 *      to: "it only ever connects to a port this module started itself, on
 *      loopback, discovered from that process's own output. Not 'loopback is
 *      allowed now' — 'this specific port, because we launched the thing
 *      listening on it'."
 *
 * ⭐ SO THE CHOICE HERE WAS BETWEEN "ANY LOOPBACK PORT" AND "A PORT WE STARTED",
 * AND THIS MODULE IMPLEMENTS THE SECOND. The argument, honestly:
 *
 *   · "Any loopback port" is not a small widening. A developer laptop routinely
 *     has an unauthenticated Docker daemon on 2375, a Kubelet on 10250, an
 *     Elasticsearch on 9200, an Ollama on 11434, a Redis/DB admin UI, a
 *     `kubectl proxy` that fronts a whole cluster, and this CLI's own MCP
 *     servers. Every one of those trusts localhost as its entire auth model.
 *   · And unlike `fetch_url` — GET only, no headers, no body — THIS verb takes a
 *     method, headers and a JSON body, because that is what testing an API
 *     means. A read primitive pointed at 2375 lists your containers; a WRITE
 *     primitive pointed at 2375 starts one with the host filesystem mounted.
 *     The blast radius of the same widening is categorically larger here.
 *   · The port is chosen by a language model that reads files, and a repo can
 *     contain text that suggests a port. "Only a port a process from THIS run
 *     announced" is a fact the model cannot author: it requires having actually
 *     spawned the listener through the allowlisted `start_process` door.
 *
 * ⚠️ THE COST IS REAL AND IS NOT HIDDEN: you cannot call a server you started by
 * hand in another terminal, or one running in Docker. The refusal says so and
 * names the way out — start it with `start_process` and it becomes reachable.
 * That is a worse tool for one workflow and a much smaller hole, and the
 * asymmetry is deliberate: the thing that is easy to add later is reach.
 *
 * ── ⚠️ WHERE A CREDENTIAL TRAVELS ──────────────────────────────────────────
 *
 * Headers are the credential path, so the rule is stated rather than assumed:
 *
 *   · The caller MAY set `authorization`, `cookie`, `x-api-key`, `content-type`,
 *     `accept` and any other well-formed header. That is allowed HERE and
 *     refused in `fetch_url` for one reason that actually holds: the destination
 *     is a port a process from this run announced, on loopback, and this tool
 *     NEVER follows a redirect — so there is no hop at which a header can leave
 *     the machine or reach a third party. Refusing `Authorization` would make it
 *     impossible to test the auth middleware you just wrote, which is one of the
 *     most common things a backend agent must check.
 *   · The caller MAY NOT set the framing headers — `host`, `content-length`,
 *     `transfer-encoding`, `connection`, `te`, `trailer`, `upgrade`,
 *     `keep-alive`, `expect`. Those are request-smuggling primitives (or, for
 *     `expect: 100-continue`, a guaranteed hang), and we compute them.
 *   · The CLI ITSELF attaches NOTHING. No env var is ever read into a header, no
 *     cookie jar exists, no auth is remembered between calls, and nothing is
 *     carried from one call to the next.
 *   · ⭐ The result reports header NAMES and never header VALUES. A secret the
 *     model pasted into `authorization` should not be re-serialised back into
 *     the transcript a second time by the tool that sent it.
 *
 * ── ⚠️ THREE FAILURES, THREE SENTENCES ─────────────────────────────────────
 *
 * `ECONNREFUSED`, a timeout and an HTTP 500 are three different facts and the
 * model must act differently on each:
 *   · refused  → nothing is listening. It is still booting, or it died. That is
 *                a `check_process` question, not a code question.
 *   · timeout  → something IS listening and did not answer. The handler hangs —
 *                an await that never settles, a missing `res.end()`.
 *   · 500      → the request SUCCEEDED. The endpoint is broken. This returns
 *                `ok: true`, because the tool did its job; a refusal here would
 *                teach the model that its own bug is a tool failure.
 */

import http from 'node:http';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

import { listBackground } from './background.mjs';

/** Whole-request budget. A loopback call that takes 10s is a hang, not slowness. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** A deliberate slow-endpoint test is legitimate; a 5-minute one is a stuck run. */
export const MAX_TIMEOUT_MS = 60_000;
/** Hard ceiling on what comes off the wire, decompressed. */
export const MAX_BODY_BYTES = 256 * 1024;
/** How much of it is rendered into the transcript. The rest is counted, not shown. */
export const MAX_BODY_CHARS = 8_000;
/** A request body bigger than this is a fixture, not a test case. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * ⚠️ A RUNAWAY-LOOP STOP, NOT A CRAWL STOP — and set high enough that real work
 * never meets it. `fetch_url` has a tight budget because a fetch is a crawl
 * waiting to happen and each one costs the user's bandwidth. This one is
 * loopback, free, and can only reach a process we started, so the only failure
 * it guards is a model retrying the same broken endpoint forever. A cap that
 * refuses correct work is worse than no cap.
 */
export const MAX_CALLS_PER_RUN = 100;

/** ⚠️ CONNECT tunnels and TRACE reflects. Neither is a thing you test an API with. */
export const ALLOWED_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Framing and hop headers. We compute these; a caller setting them breaks the request. */
export const REFUSED_HEADERS = Object.freeze([
  'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'upgrade', 'te', 'trailer', 'expect',
]);

/** The only hostnames that may appear in a `url`. Everything else is fetch_url's job. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** At most this many caller headers, each value at most this long. */
const MAX_HEADERS = 25;
const MAX_HEADER_VALUE_CHARS = 4_096;

/** RFC 7230 token. Anything outside it cannot be a header name. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** Content types worth rendering as text. Everything else is refused BY NAME. */
const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|x-www-form-urlencoded)$|application\/[a-z0-9.+-]*\+json$|application\/[a-z0-9.+-]*\+xml$)/i;

/**
 * @typedef {{ ok: false, error: string }} CallRefused
 * @typedef {{
 *   ok: true, url: string, method: string, status: number, statusText: string,
 *   class: 'success'|'redirect'|'client-error'|'server-error'|'informational',
 *   headers: Record<string, string>, contentType: string,
 *   body: string|null, bytes: number, truncated: boolean,
 *   sentHeaders: string[], durationMs: number, note: string,
 *   bodyOmitted?: string
 * }} CallOk
 */

/* ────────────────────────────────────────────────────────────────────────────
 * PER-PROCESS STATE
 * ──────────────────────────────────────────────────────────────────────────── */

let callsMade = 0;

/** Reset between tests. Never called in normal operation — a run is short. */
export function resetHttpProbeState() {
  callsMade = 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE TARGET GUARD — the part that is security, not convenience
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Describe the background registry in one line, so every refusal can name the
 * way out with real ids instead of telling the model to go and look.
 */
function describeProcesses(procs) {
  if (procs.length === 0) return 'nothing is running in the background right now';
  return procs
    .map((p) => {
      if (!p.running) return `${p.id} (exited${p.exitCode === null || p.exitCode === undefined ? '' : ` with code ${p.exitCode}`})`;
      return p.port === null || p.port === undefined
        ? `${p.id} (running, no port announced yet)`
        : `${p.id} on port ${p.port}`;
    })
    .join(', ');
}

/**
 * Turn the caller's arguments into a port + path this tool is allowed to open.
 *
 * ⚠️ THIS IS THE WHOLE SECURITY BOUNDARY AND IT IS EXPORTED SO IT CAN BE TESTED
 * DIRECTLY. The registry is injectable (the tests need a port they control) but
 * the RULE is not: the injected value is the list of processes, and the check
 * that the port is in it still runs. A seam that let a test skip the check would
 * be a guard that is switched off exactly where it is claimed to work.
 *
 * @returns {{ok: true, port: number, path: string, owner: string}|CallRefused}
 */
export function resolveTarget({ url, port, path, listProcesses = listBackground } = {}) {
  const hasUrl = typeof url === 'string' && url.trim() !== '';
  const hasPort = port !== undefined && port !== null && port !== '';

  /**
   * ⚠️ BOTH IS A REFUSAL, NOT A PRECEDENCE RULE — the rule `start_process` learned.
   * If one silently won, the model would read a `url` back in the result while a
   * different port was actually called, and that reads as the tool lying.
   */
  if (hasUrl && hasPort) {
    return { ok: false, error: 'give either "url" (e.g. "http://localhost:3000/users") or "port" + "path", not both.' };
  }
  if (!hasUrl && !hasPort) {
    return {
      ok: false,
      error: 'call_endpoint needs a target: "url" (e.g. "http://localhost:3000/users"), or "port" and "path" '
        + '(e.g. port 3000, path "/users"). check_process prints the url of the server you started.',
    };
  }

  let wantPort;
  let wantPath;

  if (hasUrl) {
    let u;
    try {
      u = new URL(url.trim());
    } catch {
      return { ok: false, error: `"${String(url).slice(0, 120)}" is not a full URL. Include the scheme and the port, e.g. "http://localhost:3000/users".` };
    }
    if (u.protocol === 'https:') {
      return {
        ok: false,
        error: 'call_endpoint speaks plain http only. A local dev server with TLS would need its certificate trusted, '
          + 'and a self-signed one is not worth that door — start the server on http and call that.',
      };
    }
    if (u.protocol !== 'http:') {
      return { ok: false, error: `call_endpoint speaks http only — "${u.protocol}" is refused.` };
    }
    if (u.username || u.password) {
      return {
        ok: false,
        error: 'this URL embeds credentials (user:pass@host) and is refused — they would be silently turned into an '
          + 'Authorization header. Put the header in "headers" yourself if the endpoint needs one.',
      };
    }
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!LOOPBACK_HOSTS.has(host)) {
      return {
        ok: false,
        // ⚠️ NAMES THE OTHER TOOL. A model told only "refused" tries the same
        // call three more ways; told "fetch_url does public hosts" it moves on.
        error: `call_endpoint only calls a local server that you started with start_process — "${host}" is not one. `
          + 'Use fetch_url for a public http/https address.',
      };
    }
    if (!u.port) {
      return { ok: false, error: `"${url.trim()}" has no port. A dev server always has one — check_process prints it, e.g. "http://localhost:3000/".` };
    }
    wantPort = Number(u.port);
    wantPath = `${u.pathname || '/'}${u.search || ''}`;
  } else {
    wantPort = typeof port === 'number' ? port : Number(String(port).trim());
    if (!Number.isInteger(wantPort) || wantPort < 1 || wantPort > 65535) {
      return { ok: false, error: `port must be a whole number between 1 and 65535, not ${JSON.stringify(port)}` };
    }
    if (path === undefined || path === null || path === '') {
      wantPath = '/';
    } else if (typeof path !== 'string') {
      return { ok: false, error: `path must be a string like "/users" or "/users?limit=10", not ${JSON.stringify(path)}` };
    } else {
      wantPath = path;
    }
  }

  if (!wantPath.startsWith('/')) {
    return { ok: false, error: `path must start with "/" — write "/${wantPath}" rather than "${wantPath}".` };
  }
  /**
   * ⚠️ A CR OR LF IN THE PATH IS REQUEST SPLITTING. It ends the request line and
   * starts a second request the caller never wrote — the header-injection bug in
   * its oldest form. A space is refused with it because the fix is the same one.
   */
  if (/[\x00-\x20\x7f]/.test(wantPath)) {
    return {
      ok: false,
      error: 'path contains a space or a control character. Percent-encode it (a space is %20) — a newline in a path '
        + 'would split the request in two, so it is refused rather than escaped.',
    };
  }

  /* ── THE REGISTRY CHECK ─────────────────────────────────────────────────── */
  let procs;
  try {
    procs = listProcesses() ?? [];
  } catch {
    // ⚠️ FAILS CLOSED. "I could not read the registry" and "the port is fine"
    // are different answers, and only one of them is honest.
    procs = [];
  }
  if (!Array.isArray(procs)) procs = [];

  /**
   * ── ⚠️⚠️ MATCHING ON THE NUMBER WAS THE HOLE. THE VERDICT IS THE CHECK ─────
   *
   * This used to be `p.port === wantPort`. `p.port` is parsed out of the child's
   * own STDOUT, so a repository somebody cloned decided it — and the refusal
   * message a few lines below, *"must not be able to poke arbitrary localhost
   * services such as a Docker daemon"*, described exactly what that let through.
   * Proven end to end 2026-08-15: a decoy bound one port while printing
   * `"Docker daemon on port 2375"`, and the probe went to the real 2375.
   *
   * `background.mjs` now asks the OS who holds the port (`verifyPortOwner`) and
   * publishes the answer as `portVerified`. ⭐ REQUIRING `=== true` IS THE POINT:
   * an older record, a hand-built stub, or a future field rename all yield
   * `undefined`, and `undefined` must refuse rather than pass.
   */
  const owner = procs.find((p) => p && p.running === true && p.port === wantPort && p.portVerified === true);
  if (owner) return { ok: true, port: wantPort, path: wantPath, owner: owner.id };

  /**
   * ⭐ A CLAIMED-BUT-UNVERIFIED PORT GETS ITS OWN ANSWER. Lumping it in with
   * "that port is not one of ours" would tell a model whose dev server is simply
   * still booting to go and start a server it has already started — so it would
   * start a second one, take a different port, and be further from working.
   */
  const unverified = procs.find((p) => p && p.running === true && p.port === wantPort);
  if (unverified) {
    return {
      ok: false,
      error: `${unverified.id} printed port ${wantPort}, but this machine has not confirmed that ${unverified.id} `
        + 'actually holds it — that number came out of the process\'s own output, so it is a claim, not a fact. '
        + `Call check_process {"id":"${unverified.id}"} — if the server is still starting, the port becomes usable `
        + 'once it is really listening; if it stays unconfirmed, something else owns that port and calling it would '
        + 'be reaching a service this run did not start.',
    };
  }

  /**
   * ⭐ A PORT WHOSE PROCESS HAS DIED IS ITS OWN ANSWER, not a generic refusal.
   * The model is about to conclude "my request tool is broken" when the truth is
   * "your server crashed", and those lead to opposite next moves. The port is
   * also genuinely no longer ours — anything on the machine may have taken it.
   */
  const dead = procs.find((p) => p && p.running !== true && p.port === wantPort);
  if (dead) {
    return {
      ok: false,
      error: `${dead.id} announced port ${wantPort}, but it is NOT running any more`
        + `${dead.exitCode === null || dead.exitCode === undefined ? '' : ` (it exited with code ${dead.exitCode})`}. `
        + `Anything on this machine could hold that port now, so call_endpoint will not connect to it. `
        + `Read check_process {"id":"${dead.id}"} for why it died, fix that, and start it again.`,
    };
  }

  return {
    ok: false,
    error: `call_endpoint can only reach a port announced by a process THIS run started with start_process — `
      + `port ${wantPort} is not one of them. Right now: ${describeProcesses(procs)}. `
      + 'Start the server with start_process, call check_process to see the port it announced, then call that port. '
      + '(A server you started by hand in another terminal, or one in Docker, is deliberately out of reach: this tool '
      + 'must not be able to poke arbitrary localhost services such as a Docker daemon or a database admin panel.)',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * HEADERS
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Validate the caller's headers. Returns them lowercased, or a refusal that
 * names the offending header — never a silent drop, which would teach the model
 * that a header it needs was sent when it was not.
 */
export function validateHeaders(headers) {
  if (headers === undefined || headers === null) return { ok: true, headers: {} };
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    return { ok: false, error: 'headers must be an object like {"content-type":"application/json"}' };
  }
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADERS) {
    return { ok: false, error: `that is ${entries.length} headers; at most ${MAX_HEADERS} may be set.` };
  }
  /** @type {Record<string,string>} */
  const out = {};
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName).toLowerCase();
    if (!HEADER_NAME.test(rawName)) {
      return { ok: false, error: `"${String(rawName).slice(0, 60)}" is not a valid header name — letters, digits and -_.~ only.` };
    }
    if (REFUSED_HEADERS.includes(name)) {
      return {
        ok: false,
        error: `call_endpoint sets "${name}" itself and will not take one from you. `
          + `Framing headers (${REFUSED_HEADERS.join(', ')}) decide where one request ends and the next begins; `
          + 'a caller-supplied one either breaks the request or smuggles a second one. Everything else, including '
          + 'authorization and cookie, you may set.',
      };
    }
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      out[name] = String(rawValue);
      continue;
    }
    if (typeof rawValue !== 'string') {
      return { ok: false, error: `the value of "${name}" must be a string, not ${JSON.stringify(rawValue)}` };
    }
    if (/[\r\n]/.test(rawValue)) {
      // ⚠️ Header injection, the classic. Refused rather than stripped: a value
      // that silently changes is a value the model will trust wrongly.
      return { ok: false, error: `the value of "${name}" contains a newline. That would inject extra headers into the request, so it is refused.` };
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(rawValue)) {
      return { ok: false, error: `the value of "${name}" contains a control character and is refused.` };
    }
    if (rawValue.length > MAX_HEADER_VALUE_CHARS) {
      return { ok: false, error: `the value of "${name}" is ${rawValue.length} characters; the limit is ${MAX_HEADER_VALUE_CHARS}.` };
    }
    out[name] = rawValue;
  }
  return { ok: true, headers: out };
}

/* ────────────────────────────────────────────────────────────────────────────
 * TRANSPORT
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One request, one answer, no redirect following.
 *
 * ⚠️⚠️ THE HOST IS AN IP LITERAL AND THERE IS NO DNS LOOKUP AT ALL. Even when
 * the caller wrote `http://localhost:3000`, the socket goes to `127.0.0.1`.
 * `fetch-text.mjs` had to pin resolved addresses to a socket to stop DNS
 * rebinding; here the same property comes for free by never asking a resolver,
 * so a `hosts` file that redefines `localhost` cannot move this request.
 *
 * ⚠️ AND IT DOES NOT FOLLOW REDIRECTS, BY DESIGN. A 302 is reported as a fact
 * with its Location header. Following one would be the hop at which a caller's
 * `Authorization` header could be replayed somewhere it was never meant to go,
 * and it would be a way to reach a port the guard above never approved.
 */
export function nodeHttpRequest({ host, port, path, method, headers, body, timeoutMs, maxBytes = MAX_BODY_BYTES }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path,
      method,
      headers,
      family: host.includes(':') ? 6 : 4,
      timeout: timeoutMs,
    }, (res) => {
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      // We never ask for compression, but a server that always compresses would
      // otherwise hand the model a binary smear and get refused as "binary".
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
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          body: Buffer.concat(chunks),
          bytes: total,
          truncated,
        });
      };

      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          // ⚠️ The socket is destroyed rather than drained: reading a 4GB
          // response to completion and discarding it is a denial of service the
          // agent performs on its own user's machine.
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
        // A decompression failure on a body we deliberately cut short is the
        // expected consequence of cutting it short, not an error.
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
    if (body !== null && body !== undefined && body.length > 0) req.write(body);
    req.end();
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * RENDERING THE ANSWER
 * ──────────────────────────────────────────────────────────────────────────── */

function classOf(status) {
  if (status >= 500) return 'server-error';
  if (status >= 400) return 'client-error';
  if (status >= 300) return 'redirect';
  if (status >= 200) return 'success';
  return 'informational';
}

/**
 * ⭐ THE FOUR SENTENCES. A status number alone makes a model guess whose fault it
 * is, and it guesses "mine" for a 500 (spending rounds rewriting a correct
 * request) and "the server's" for a 400 (spending rounds restarting a healthy
 * one). Naming the owner of the bug is the whole value of this line.
 */
function noteFor({ status, statusText, method, path, port, durationMs, headers }) {
  const line = `${method} ${path} on port ${port} → HTTP ${status}${statusText ? ` ${statusText}` : ''} in ${durationMs}ms.`;
  const kind = classOf(status);
  if (kind === 'success') return `${line} The endpoint answered.`;
  if (kind === 'redirect') {
    const loc = headers?.location;
    return `${line} call_endpoint does NOT follow redirects — ${loc ? `it points at "${loc}"` : 'no Location header was sent'}. `
      + 'Call that path yourself if you want to see where it lands.';
  }
  if (kind === 'client-error') {
    return `${line} The server understood the request and REJECTED it — that is normally the request's fault `
      + '(wrong path, missing field, missing or wrong auth), not a crash. The body below usually says which.';
  }
  if (kind === 'server-error') {
    return `${line} The request itself worked — your HANDLER failed. This is a bug in the server code, not in the call. `
      + 'The stack trace is usually on the process stdout, so read check_process, not just this body.';
  }
  return line;
}

/** Pretty-print JSON so a minified payload is readable and diffable. */
function renderBody(buf, contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  // A server that states no type is almost always serving text (a bare res.end(),
  // a small hand-written API). Guessing text is safe because the WRONG guess is
  // caught two lines down by the same NUL check `read_file` uses.
  const effective = mime || 'text/plain';
  if (!TEXTUAL.test(effective)) {
    return { text: null, omitted: `the response is ${effective}, which call_endpoint does not render as text — its status and headers above are the fact you asked for. Save it with a script if you need the bytes.` };
  }
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType || '')?.[1]?.toLowerCase();
  const text = charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252'
    ? buf.toString('latin1')
    : buf.toString('utf8');
  if (text.includes('\u0000')) {
    return { text: null, omitted: `the response claims to be ${effective} but the body is binary. Refusing to render it as text.` };
  }
  // Detected by PARSING, not only by believing the header — the same trick
  // fetch-text.mjs needed, and it cannot false-positive: the test is that
  // JSON.parse succeeds on the whole body.
  const looksJson = /json/.test(effective) || /^\s*[[{]/.test(text);
  if (looksJson) {
    try { return { text: JSON.stringify(JSON.parse(text), null, 2) }; } catch { /* not JSON after all */ }
  }
  return { text };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE TOOL
 * ──────────────────────────────────────────────────────────────────────────── */

const KNOWN_ARGS = new Set([
  'url', 'port', 'path', 'method', 'headers', 'body', 'json', 'timeoutMs',
  'requestImpl', 'listProcesses', 'now', 'executor',
]);
const SEAMS = ['requestImpl', 'listProcesses', 'now'];

/**
 * Make ONE HTTP request to a server this run started, and return what came back.
 *
 * @param {object} params
 * @returns {Promise<CallOk | CallRefused>}
 */
export async function httpProbe(params = {}) {
  /**
   * ⚠️ UNKNOWN KEYS ARE REFUSED BY NAME, the rule `fetch_url` states: the
   * dispatcher spreads the model's arguments straight in, so this is the only
   * place that sees them, and silently dropping `data` teaches the model that
   * its body was sent when it was not.
   */
  const unknown = Object.keys(params).filter((k) => !KNOWN_ARGS.has(k));
  if (unknown.length) {
    return {
      ok: false,
      error: `call_endpoint does not accept "${unknown[0]}". It takes url (or port + path), method, headers, body, json and timeoutMs.`
        + (unknown[0] === 'data' ? ' Use "json" for a JSON body, or "body" for a raw string.' : ''),
    };
  }
  for (const seam of SEAMS) {
    if (params[seam] !== undefined && typeof params[seam] !== 'function') {
      return { ok: false, error: `call_endpoint does not accept "${seam}". It takes url (or port + path), method, headers, body, json and timeoutMs.` };
    }
  }

  const {
    executor,
    requestImpl = nodeHttpRequest,
    listProcesses = listBackground,
    now = Date.now,
  } = params;

  /**
   * ⚠️ A DRY RUN CALLS NOTHING. `POST /users` creates a user; `DELETE /users/1`
   * deletes one. A dry run promises not to change anything, and "it is only a
   * local dev database" is exactly the reasoning that makes the promise false.
   */
  if (executor?.dryRun) {
    return { ok: false, error: 'this is a --dry-run, so no request is made (POST /users changes something, and a dry run promises not to).' };
  }

  /* ── METHOD ────────────────────────────────────────────────────────────── */
  const method = params.method === undefined || params.method === null || params.method === ''
    ? 'GET'
    : String(params.method).trim().toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) {
    const why = method === 'CONNECT'
      ? ' CONNECT opens a tunnel to somewhere else, which would walk straight around the port check.'
      : method === 'TRACE'
        ? ' TRACE only reflects your own request back at you.'
        : '';
    return { ok: false, error: `"${method}" is not a method call_endpoint sends. Allowed: ${ALLOWED_METHODS.join(', ')}.${why}` };
  }

  /* ── BODY ──────────────────────────────────────────────────────────────── */
  if (params.body !== undefined && params.json !== undefined) {
    // Ambiguous, and the model would never see which one won.
    return { ok: false, error: 'give either "body" (a raw string) or "json" (an object serialised for you), not both.' };
  }
  let bodyText = null;
  let impliedContentType = null;
  if (params.json !== undefined) {
    try {
      bodyText = JSON.stringify(params.json);
    } catch {
      return { ok: false, error: 'json could not be serialised (it is probably circular). Pass a plain object or array.' };
    }
    if (bodyText === undefined) return { ok: false, error: 'json serialised to nothing. Pass a plain object or array.' };
    impliedContentType = 'application/json';
  } else if (params.body !== undefined && params.body !== null) {
    if (typeof params.body !== 'string') {
      return { ok: false, error: `body must be a string — use "json" if you want an object serialised for you, not ${JSON.stringify(params.body).slice(0, 80)}` };
    }
    bodyText = params.body;
  }
  const bodyBuf = bodyText === null ? null : Buffer.from(bodyText, 'utf8');
  if (bodyBuf && bodyBuf.length > MAX_REQUEST_BODY_BYTES) {
    return {
      ok: false,
      error: `that request body is ${bodyBuf.length} bytes; the limit is ${MAX_REQUEST_BODY_BYTES}. `
        + 'Write the payload to a file and have a script post it if it really needs to be that big.',
    };
  }

  /* ── HEADERS ───────────────────────────────────────────────────────────── */
  const hv = validateHeaders(params.headers);
  if (!hv.ok) return hv;

  /* ── TIMEOUT ───────────────────────────────────────────────────────────── */
  let timeoutMs = params.timeoutMs === undefined || params.timeoutMs === null
    ? DEFAULT_TIMEOUT_MS
    : Number(params.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { ok: false, error: `timeoutMs must be a positive number of milliseconds, not ${JSON.stringify(params.timeoutMs)}` };
  }
  // Clamped rather than refused: a model asking for 10 minutes wants "wait a
  // while", and 60s answers that. Refusing costs a round to learn a number.
  if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS;
  timeoutMs = Math.round(timeoutMs);

  /* ── THE GUARD ─────────────────────────────────────────────────────────── */
  const target = resolveTarget({ url: params.url, port: params.port, path: params.path, listProcesses });
  if (!target.ok) return target;

  /* ── BUDGET ────────────────────────────────────────────────────────────── */
  if (callsMade >= MAX_CALLS_PER_RUN) {
    return {
      ok: false,
      error: `call_endpoint has already made ${MAX_CALLS_PER_RUN} requests this run, which is the limit — that is a loop, not a test. `
        + 'Write the remaining checks into a script and run it once with run_command.',
    };
  }
  callsMade += 1;

  /* ── SEND ──────────────────────────────────────────────────────────────── */
  const sendHeaders = {
    // ⚠️ The Host header is ours: it names the port so a vhost-routing server
    // behaves, and a caller cannot use it to reach a different app behind a
    // local proxy.
    host: `127.0.0.1:${target.port}`,
    accept: '*/*',
    'user-agent': 'acuvo-code (call_endpoint)',
    ...(impliedContentType ? { 'content-type': impliedContentType } : {}),
    // Caller headers land last so an explicit content-type wins over the implied
    // one — but never over the framing headers, which validateHeaders refuses.
    ...hv.headers,
    connection: 'close',
    ...(bodyBuf ? { 'content-length': String(bodyBuf.length) } : {}),
  };

  const started = now();
  let res;
  let usedHost = '127.0.0.1';
  try {
    res = await requestImpl({
      host: usedHost, port: target.port, path: target.path, method,
      headers: sendHeaders, body: bodyBuf, timeoutMs, maxBytes: MAX_BODY_BYTES,
    });
  } catch (err) {
    const code = err?.code || err?.cause?.code || err?.name || 'unknown';
    /**
     * ⭐ ONE RETRY, ON ::1 ONLY, AND ONLY FOR A REFUSAL. A server that binds the
     * IPv6 loopback exclusively (`server.listen(port, '::1')`, and some
     * frameworks do it when told "localhost") refuses 127.0.0.1 while being
     * perfectly healthy. Reporting "nothing is listening" there would send the
     * model to debug a working server. Still loopback, still the same approved
     * port — this widens nothing.
     */
    if (code === 'ECONNREFUSED') {
      try {
        usedHost = '::1';
        res = await requestImpl({
          host: usedHost, port: target.port, path: target.path, method,
          headers: { ...sendHeaders, host: `[::1]:${target.port}` }, body: bodyBuf, timeoutMs, maxBytes: MAX_BODY_BYTES,
        });
      } catch {
        return { ok: false, error: refusedMessage(target, method) };
      }
    } else if (code === 'ETIMEDOUT' || code === 'ERR_SOCKET_TIMEOUT' || err?.name === 'AbortError') {
      /**
       * ⚠️ A DIFFERENT FACT FROM A REFUSAL, AND THE OPPOSITE NEXT MOVE. Something
       * accepted the connection and never answered: the route hangs. Restarting
       * the server will not help; finding the await that never settles will.
       */
      return {
        ok: false,
        error: `${method} ${target.path} connected to port ${target.port} (${target.owner} is listening) but the server did not ANSWER within ${timeoutMs}ms. `
          + 'It is not down — the handler is hanging: an await that never settles, a missing res.end(), or an infinite loop. '
          + 'Read check_process for what it printed while you waited, and raise timeoutMs only if the work really is slow.',
      };
    } else if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/i.test(String(err?.message))) {
      return {
        ok: false,
        error: `${method} ${target.path} reached port ${target.port}, and the server then closed the connection WITHOUT answering (${code}). `
          + `That is usually the process crashing mid-request — check_process {"id":"${target.owner}"} will have the stack trace, `
          + 'which is the actual bug, not this call.',
      };
    } else {
      return { ok: false, error: `${method} ${target.path} on port ${target.port} failed: ${code}${err?.message ? ` (${err.message})` : ''}` };
    }
  }

  const durationMs = Math.max(0, Math.round(now() - started));

  /* ── ANSWER ────────────────────────────────────────────────────────────── */
  const rawHeaders = res?.headers ?? {};
  /** @type {Record<string,string>} */
  const headers = {};
  for (const [k, v] of Object.entries(rawHeaders)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  const contentType = headers['content-type'] ?? '';
  const buf = Buffer.isBuffer(res?.body) ? res.body : Buffer.from(String(res?.body ?? ''), 'utf8');
  const status = Number(res?.status ?? 0);

  const rendered = method === 'HEAD'
    ? { text: '', omitted: undefined }
    : renderBody(buf, contentType);

  /**
   * ⚠️⚠️ TWO DIFFERENT CUTS, AND THE FIRST DRAFT LOST ONE OF THEM. The wire cut
   * (the server had more than 256KB) and the display cut (more than 8,000
   * characters reached the transcript) are different facts, and anything over
   * 256KB triggers BOTH. Appending the wire sentence first and then slicing to
   * 8,000 characters deleted it every single time — so the one case the wire cap
   * exists for could never say so. Both sentences are composed after the slice.
   */
  let body = rendered.text;
  let truncated = Boolean(res?.truncated);
  if (body !== null) {
    const tail = [];
    if (body.length > MAX_BODY_CHARS) {
      tail.push(`[call_endpoint showed the first ${MAX_BODY_CHARS} of ${body.length} characters. Ask for a narrower endpoint, or save the response with a script if you need all of it]`);
      body = body.slice(0, MAX_BODY_CHARS);
      truncated = true;
    }
    if (res?.truncated) {
      tail.push(`[call_endpoint stopped reading at ${MAX_BODY_BYTES / 1024}KB — the response was longer than that and the rest was never downloaded]`);
    }
    if (tail.length) body += `\n\n${tail.join('\n')}`;
  }

  return {
    ok: true,
    url: `http://${usedHost.includes(':') ? `[${usedHost}]` : usedHost}:${target.port}${target.path}`,
    method,
    status,
    statusText: String(res?.statusText ?? ''),
    class: classOf(status),
    headers,
    contentType,
    body,
    bytes: Number.isFinite(res?.bytes) ? res.bytes : buf.length,
    truncated,
    /**
     * ⭐ NAMES ONLY, NEVER VALUES. This is the receipt that an Authorization
     * header really was sent — the fact the model needs to interpret a 401 —
     * without writing the secret it pasted into the transcript a second time.
     */
    sentHeaders: Object.keys(sendHeaders).sort(),
    durationMs,
    ...(rendered.omitted ? { bodyOmitted: rendered.omitted } : {}),
    note: noteFor({ status, statusText: res?.statusText ?? '', method, path: target.path, port: target.port, durationMs, headers }),
  };
}

/** The refusal for "nothing accepted the connection". Its own function so both
 *  the v4 and the ::1 attempt end in exactly the same sentence. */
function refusedMessage(target, method) {
  return `${method} ${target.path} could not connect: NOTHING is listening on port ${target.port} right now. `
    + `${target.owner} announced that port, so it has either not finished booting or it has crashed since. `
    + `This is not a bad request — call check_process {"id":"${target.owner}"} to see whether it is still alive and what it printed, `
    + 'then call again once it is up.';
}

/* ────────────────────────────────────────────────────────────────────────────
 * SCHEMA
 * ──────────────────────────────────────────────────────────────────────────── */

export const HTTP_PROBE_TOOL_NAMES = ['call_endpoint'];

/**
 * ⚠️ THE DESCRIPTION STATES THE BOUNDARY OUT LOUD, for the reason `fetch_url`'s
 * does: a model that does not know the rule spends one round discovering it and
 * a second arguing with the refusal. What the schema says is the cheapest
 * documentation in the system.
 */
export function httpProbeToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'call_endpoint',
        description: [
          'Make ONE HTTP request to a server YOU started with start_process, and read the real response —',
          'status, headers and body. This is how you prove that POST /users returns 201 instead of only running',
          'unit tests you also wrote. A 4xx or 5xx still comes back as a normal result, with a note saying whether',
          'the request or the handler is at fault.',
          'IT CAN ONLY REACH A PORT ANNOUNCED BY A PROCESS THIS RUN STARTED: run start_process, then check_process',
          'to see the port, then call that port. A server you started by hand in another terminal, anything in Docker,',
          'and every other localhost service is deliberately out of reach — use fetch_url for public URLs.',
          'You may set any headers except the framing ones (host, content-length, transfer-encoding, connection…);',
          'authorization and cookie ARE allowed, and nothing is attached for you. Redirects are reported, never followed.',
          `The body is returned as text (JSON pretty-printed) up to ${MAX_BODY_CHARS} characters; a binary response`,
          'reports its status and headers with the body omitted.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The full local URL, e.g. "http://localhost:3000/users?limit=10". Use this OR port+path, not both.' },
            port: { type: 'integer', description: 'The port check_process reported, e.g. 3000. Use with path.' },
            path: { type: 'string', description: 'The path and query, starting with "/", e.g. "/users" or "/users?limit=10". Defaults to "/".' },
            method: { type: 'string', enum: [...ALLOWED_METHODS], description: 'HTTP method. Defaults to GET.' },
            headers: {
              type: 'object',
              description: 'Request headers, e.g. {"authorization":"Bearer test-token"}. content-type is set for you when you use "json".',
              additionalProperties: { type: 'string' },
            },
            json: { description: 'An object or array to send as a JSON body. Sets content-type: application/json. Use this OR body.' },
            body: { type: 'string', description: 'A raw request body, e.g. form-encoded text. Set content-type yourself. Use this OR json.' },
            timeoutMs: { type: 'integer', description: `How long to wait for an answer, default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.` },
          },
        },
      },
    },
  ];
}

/** Dispatch. Mirrors the shape every other tool module in this package uses. */
export async function runHttpProbeTool(name, args = {}, { executor } = {}) {
  if (name !== 'call_endpoint') return { ok: false, error: `unknown http tool "${name}"` };
  /**
   * ⚠️ The model's arguments are passed through AS THEY ARE, not coerced and not
   * filtered: `httpProbe` refuses an unknown key by name, and it can only do
   * that if the key reaches it. The seams are not readable from JSON, so a model
   * cannot supply one — and if it somehow did, the type check above refuses it.
   */
  return httpProbe({ ...args, executor });
}
