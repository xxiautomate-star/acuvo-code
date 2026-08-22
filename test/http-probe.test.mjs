/**
 * ── CALLING THE API — TESTED AGAINST REAL SERVERS ON REAL LOOPBACK ─────────
 *
 * ⚠️ A STUBBED TRANSPORT CANNOT TEST THE THING THAT MATTERS HERE. The point of
 * this verb is that a request leaves the process, a real handler runs, and a
 * real status comes back — so the core tests bind a real `node:http` server on
 * 127.0.0.1, let `call_endpoint` open a real socket to it, and assert on what
 * the SERVER saw as well as on what the tool returned. `see_page` shipped blind
 * once and 3,621 green tests never noticed; only the end-to-end run proves reach.
 *
 * ⭐ It costs $0.00 and needs no key or network: the subject is `node:http`,
 * which is already running this test.
 *
 * ⚠️ THE REGISTRY IS INJECTED, THE GUARD IS NOT. `listProcesses` is stubbed
 * because a test cannot start a real dev server for every case — but the RULE
 * (the port must belong to a running process from this run) still executes on
 * the stubbed list, and the refusal tests below drive it. A seam that let the
 * test skip the check would be a guard switched off exactly where it is claimed
 * to work.
 *
 * ⚠️⚠️ AND THE RULE ITSELF WAS WRONG UNTIL 2026-08-15. "Belongs to a running
 * process from this run" was decided by `p.port === wantPort`, and `p.port` is
 * read from the child's own STDOUT — so the thing being kept out chose the
 * number. Every test in this file passed while that was true, because they all
 * asked *does the guard compare the port*, and never *is the port a fact*. The
 * rule now requires `portVerified === true`, which `background.mjs` sets only
 * after asking the OS which pid is listening. ⭐ A test of the comparison is not
 * a test of the claim the comparison is used to make.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

import {
  httpProbe, resolveTarget, validateHeaders, resetHttpProbeState,
  httpProbeToolSchemas, runHttpProbeTool,
  HTTP_PROBE_TOOL_NAMES, ALLOWED_METHODS, REFUSED_HEADERS,
  MAX_BODY_CHARS, MAX_BODY_BYTES, MAX_CALLS_PER_RUN, MAX_TIMEOUT_MS,
} from '../lib/http-probe.mjs';

/* ────────────────────────────────────────────────────────────────────────────
 * HARNESS
 * ──────────────────────────────────────────────────────────────────────────── */

const servers = [];
after(async () => {
  for (const s of servers) {
    try { s.closeAllConnections?.(); } catch { /* older node */ }
    await new Promise((r) => s.close(r));
  }
});

/** Start a real server on a free loopback port. Returns its port + a request log. */
async function serve(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen[seen.length - 1].body = body;
      handler(req, res, body);
    });
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, server };
}

/**
 * The registry `start_process` would have produced for that server.
 *
 * ⚠️⚠️ `portVerified` IS NOT DECORATION, AND ITS ABSENCE HERE WAS THE HOLE.
 * `port` is parsed out of the child's own STDOUT, so a cloned repository decides
 * it — and until 2026-08-15 this tool matched on that number alone. Proven end
 * to end: a decoy bound one port while printing "Docker daemon on port 2375",
 * and the probe went to the real 2375. `background.mjs` now asks the OS who
 * holds the port and publishes the verdict; a fixture that omitted it would be
 * *tidier than reality in the one field that matters*, so it is set explicitly
 * here and driven both ways below.
 */
const running = (port, id = 'bg1') => () => [{ id, command: 'node server.mjs', running: true, port, exitCode: null, portVerified: true }];

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐ THE THING THE AGENT COULD NOT DO
 * ──────────────────────────────────────────────────────────────────────────── */

test('POST /users really returns 201 — the whole reason this exists', async () => {
  const { port, seen } = await serve((req, res, body) => {
    if (req.method === 'POST' && req.url === '/users') {
      const parsed = JSON.parse(body);
      res.writeHead(201, { 'content-type': 'application/json', location: '/users/7' });
      res.end(JSON.stringify({ id: 7, name: parsed.name }));
      return;
    }
    res.writeHead(404); res.end('no');
  });

  const r = await httpProbe({
    url: `http://localhost:${port}/users`,
    method: 'POST',
    json: { name: 'ada' },
    listProcesses: running(port),
  });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 201);
  assert.equal(r.class, 'success');
  assert.equal(r.headers.location, '/users/7', 'the response headers come back, not just the body');
  // ⭐ Pretty-printed, so a minified payload is readable rather than one long line.
  assert.equal(r.body, '{\n  "id": 7,\n  "name": "ada"\n}');
  assert.match(r.note, /201/);

  // ⚠️ AND THE SERVER'S SIDE. Asserting only on the return value would pass even
  // if the body never left this process.
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/users');
  assert.equal(seen[0].body, '{"name":"ada"}');
  assert.equal(seen[0].headers['content-type'], 'application/json', 'json sets the content type for you');
  assert.equal(seen[0].headers['content-length'], '14', 'and we frame the request ourselves');
});

test('port + path is the other way in, and the query survives', async () => {
  const { port, seen } = await serve((_q, res) => { res.writeHead(200); res.end('ok'); });
  const r = await httpProbe({ port, path: '/users?limit=10&q=a%20b', listProcesses: running(port) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 200);
  assert.equal(r.body, 'ok');
  assert.equal(seen[0].url, '/users?limit=10&q=a%20b');
  assert.equal(seen[0].method, 'GET', 'GET is the default');
});

test('every allowed method reaches the server as itself', async () => {
  const { port, seen } = await serve((_q, res) => { res.writeHead(204); res.end(); });
  for (const method of ALLOWED_METHODS) {
    const r = await httpProbe({ port, path: '/x', method, listProcesses: running(port) });
    assert.equal(r.ok, true, `${method}: ${r.error}`);
    assert.equal(r.status, 204);
  }
  assert.deepEqual(seen.map((s) => s.method), [...ALLOWED_METHODS]);
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ THREE FAILURES, THREE SENTENCES
 * ──────────────────────────────────────────────────────────────────────────── */

test('a 500 is a SUCCESSFUL call with a broken handler — not a tool failure', async () => {
  const { port } = await serve((_q, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('TypeError: Cannot read properties of undefined');
  });
  const r = await httpProbe({ port, path: '/users', listProcesses: running(port) });

  // ⚠️ THE LOAD-BEARING ASSERTION. If a 500 came back as `ok:false`, the model
  // would read its own bug as a broken tool and start rewriting the request.
  assert.equal(r.ok, true, 'the request succeeded; the endpoint is what failed');
  assert.equal(r.status, 500);
  assert.equal(r.class, 'server-error');
  assert.match(r.note, /HANDLER failed/);
  assert.match(r.note, /check_process/, 'because the stack trace is on the process stdout, not here');
  assert.match(r.body, /TypeError/, 'and the error text is carried, not summarised away');
});

test('a 404 blames the request, and says so differently from a 500', async () => {
  const { port } = await serve((_q, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"no such route"}');
  });
  const r = await httpProbe({ port, path: '/nope', listProcesses: running(port) });
  assert.equal(r.ok, true);
  assert.equal(r.class, 'client-error');
  assert.match(r.note, /REJECTED/);
  assert.equal(/HANDLER failed/.test(r.note), false, 'a 4xx must not read like a 5xx');
  assert.match(r.body, /no such route/);
});

test('connection refused says NOTHING IS LISTENING and points at check_process', async () => {
  // A real free port: bind one, learn its number, then let it go.
  const { port, server } = await serve((_q, res) => { res.end('x'); });
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });

  const r = await httpProbe({ port, path: '/users', listProcesses: running(port, 'bg3'), timeoutMs: 2_000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /NOTHING is listening/);
  assert.match(r.error, /bg3/, 'it names the process whose port this is');
  assert.match(r.error, /check_process/);
  assert.match(r.error, /not a bad request/i, 'so the model does not go and rewrite a correct call');
});

test('a timeout is a HANGING HANDLER, and says the opposite of "nothing is listening"', async () => {
  // Accepts the connection and never answers — the missing res.end().
  const { port } = await serve(() => { /* deliberately no response, ever */ });
  const r = await httpProbe({ port, path: '/slow', listProcesses: running(port), timeoutMs: 400 });

  assert.equal(r.ok, false);
  assert.match(r.error, /did not ANSWER within 400ms/);
  assert.match(r.error, /not down/, 'something IS listening — that is the whole distinction');
  assert.match(r.error, /hanging/);
  assert.equal(/NOTHING is listening/.test(r.error), false, 'a timeout must never read as a refusal');
});

test('a server that hangs up mid-request is a third, different sentence', async () => {
  const { port } = await serve((req, res) => { res.socket.destroy(); });
  const r = await httpProbe({ port, path: '/crash', listProcesses: running(port), timeoutMs: 2_000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /closed the connection WITHOUT answering/);
  assert.match(r.error, /check_process/);
  assert.equal(/hanging/.test(r.error), false);
  assert.equal(/NOTHING is listening/.test(r.error), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️⚠️ THE SECURITY BOUNDARY
 * ──────────────────────────────────────────────────────────────────────────── */

test('a loopback port we did NOT start is refused, and the refusal names the way out', async () => {
  // The scenario that matters: a real server is listening (this could be a
  // Docker daemon, a database admin panel, an Ollama) and nothing we started
  // announced it.
  const { port, seen } = await serve((_q, res) => { res.writeHead(200); res.end('secret'); });
  const r = await httpProbe({ port, path: '/', listProcesses: () => [] });

  assert.equal(r.ok, false);
  assert.match(r.error, /only reach a port announced by a process THIS run started/);
  assert.match(r.error, /start_process/);
  assert.match(r.error, /check_process/);
  assert.match(r.error, /Docker/, 'the reason is stated, not just the rule');
  assert.deepEqual(seen, [], 'and NO request was made — the guard runs before the socket');
});

test('⚠️⚠️ THE REFUTED CASE: a process that PRINTED a port it does not hold is refused, and nothing is sent', async () => {
  /**
   * THE ATTACK, DRIVEN END TO END. A real server is listening on `port` — stand
   * in for a Docker daemon on 2375 — and a background process this run started
   * is claiming that same port because its stdout said so. Before 2026-08-15 the
   * registry match was `p.port === wantPort`, so this POST landed on the victim.
   */
  const { port, seen } = await serve((_q, res) => { res.writeHead(200); res.end('secret'); });

  const r = await httpProbe({
    port,
    path: '/containers/create',
    method: 'POST',
    json: { Image: 'alpine', HostConfig: { Binds: ['/:/host'] } },
    listProcesses: () => [{ id: 'bg1', command: 'npm run dev', running: true, port, exitCode: null, portVerified: false }],
  });

  assert.equal(r.ok, false);
  assert.deepEqual(seen, [], '⚠️ THE VICTIM MUST NOT BE TOUCHED — the guard runs before the socket');
  assert.match(r.error, /has not confirmed/);
  assert.match(r.error, /a claim, not a fact/);
  assert.match(r.error, /check_process/, 'a booting server is the common case, so the way out is named');
  assert.match(r.error, /bg1/);
  // ⭐ And NOT the generic "not one of them" refusal — a model told to start a
  // server it has already started will start a SECOND one on another port.
  assert.doesNotMatch(r.error, /only reach a port announced by a process THIS run started/);
});

test('⚠️ a MISSING portVerified is a refusal, not a pass — undefined must never mean yes', async () => {
  /**
   * An older record, a hand-built stub, or a future field rename all yield
   * `undefined`. A truthiness check would let every one of them through, and
   * this is precisely the shape of the bug being fixed: a permissive default
   * on a field the attacker influences.
   */
  const { port, seen } = await serve((_q, res) => { res.writeHead(200); res.end('secret'); });
  const r = await httpProbe({
    port,
    path: '/',
    listProcesses: () => [{ id: 'bg1', command: 'npm run dev', running: true, port, exitCode: null }],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(seen, []);
  assert.match(r.error, /has not confirmed/);
});

test('a port belonging to a process that has DIED is its own answer', async () => {
  const r = await httpProbe({
    port: 3000,
    listProcesses: () => [{ id: 'bg2', command: 'node api.mjs', running: false, port: 3000, exitCode: 1 }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /NOT running any more/);
  assert.match(r.error, /exited with code 1/);
  assert.match(r.error, /bg2/);
  // ⚠️ The port is genuinely no longer ours: anything on the machine may have
  // taken it, so this is a refusal and not a "try again".
  assert.match(r.error, /Anything on this machine could hold that port/);
});

test('the refusal lists what IS running, so the model can aim at a real port', async () => {
  const r = await httpProbe({
    port: 9999,
    listProcesses: () => [
      { id: 'bg1', command: 'npm run dev', running: true, port: 3000, exitCode: null },
      { id: 'bg2', command: 'node w.mjs', running: true, port: null, exitCode: null },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /bg1 on port 3000/);
  assert.match(r.error, /bg2 \(running, no port announced yet\)/);
});

test('a public host is refused and handed to fetch_url', async () => {
  for (const url of ['http://example.com:3000/x', 'http://169.254.169.254:80/latest/meta-data/', 'http://10.0.0.5:8080/admin']) {
    const r = await httpProbe({ url, listProcesses: running(3000) });
    assert.equal(r.ok, false, url);
    assert.match(r.error, /only calls a local server that you started/);
    assert.match(r.error, /fetch_url/, 'and names the tool that does do public URLs');
  }
});

test('the scheme, the credentials and the missing port are each refused by name', async () => {
  const cases = [
    ['https://localhost:3000/x', /http only|plain http/],
    ['file:///etc/passwd', /http only/],
    ['ftp://localhost:21/x', /http only/],
    ['http://user:pass@localhost:3000/x', /embeds credentials/],
    ['http://localhost/x', /has no port/],
    ['not a url', /is not a full URL/],
  ];
  for (const [url, pattern] of cases) {
    const r = await httpProbe({ url, listProcesses: running(3000) });
    assert.equal(r.ok, false, url);
    assert.match(r.error, pattern, url);
  }
});

test('a path that could split the request is refused rather than escaped', async () => {
  const bad = await httpProbe({ port: 3000, path: '/x\r\nX-Injected: 1', listProcesses: running(3000) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /split the request/);

  const relative = await httpProbe({ port: 3000, path: 'users', listProcesses: running(3000) });
  assert.equal(relative.ok, false);
  assert.match(relative.error, /write "\/users"/, 'the refusal contains the fixed value, not just a rule');
});

test('url and port together is a refusal, not a silent precedence rule', async () => {
  const r = await httpProbe({ url: 'http://localhost:3000/a', port: 3000, listProcesses: running(3000) });
  assert.equal(r.ok, false);
  assert.match(r.error, /not both/);
});

test('no target at all explains both ways in', async () => {
  const r = await httpProbe({ listProcesses: running(3000) });
  assert.equal(r.ok, false);
  assert.match(r.error, /url/);
  assert.match(r.error, /port/);
  assert.match(r.error, /check_process/);
});

test('resolveTarget approves the happy path — a guard that only refuses is useless', () => {
  const ok = resolveTarget({ url: 'http://127.0.0.1:4321/a/b?c=1', listProcesses: running(4321, 'bg7') });
  assert.deepEqual(ok, { ok: true, port: 4321, path: '/a/b?c=1', owner: 'bg7' });

  assert.deepEqual(
    resolveTarget({ port: 4321, listProcesses: running(4321) }),
    { ok: true, port: 4321, path: '/', owner: 'bg1' },
    'path defaults to /',
  );
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const r = resolveTarget({ url: `http://${host}:4321/`, listProcesses: running(4321) });
    assert.equal(r.ok, true, `${host} is loopback and must be allowed`);
  }
});

test('a registry that throws fails CLOSED', () => {
  const r = resolveTarget({ port: 3000, listProcesses: () => { throw new Error('registry exploded'); } });
  assert.equal(r.ok, false, '"I could not check" must not mean "it is fine"');
  assert.match(r.error, /THIS run started/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️ HEADERS — WHERE A CREDENTIAL TRAVELS
 * ──────────────────────────────────────────────────────────────────────────── */

test('authorization is ALLOWED, arrives at the server, and is never echoed back', async () => {
  const { port, seen } = await serve((req, res) => {
    if (req.headers.authorization === 'Bearer s3cr3t-token') { res.writeHead(200); res.end('in'); return; }
    res.writeHead(401); res.end('out');
  });

  const r = await httpProbe({
    port, path: '/me',
    headers: { Authorization: 'Bearer s3cr3t-token', 'X-Api-Key': 'k' },
    listProcesses: running(port),
  });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 200, 'testing the auth middleware you just wrote must be possible');
  assert.equal(seen[0].headers.authorization, 'Bearer s3cr3t-token', 'it really travelled');

  // ⭐ THE RECEIPT IS NAMES, NEVER VALUES. The model needs to know the header was
  // sent (to interpret a 401); it does not need the secret written into the
  // transcript a second time by the tool that sent it.
  assert.ok(r.sentHeaders.includes('authorization'));
  assert.ok(r.sentHeaders.includes('x-api-key'));
  assert.equal(JSON.stringify(r).includes('s3cr3t-token'), false, 'the value must not come back');
});

test('the framing headers are refused BY NAME, with the reason and the exception', async () => {
  /**
   * ⚠️⚠️ THE LIST IS PINNED LITERALLY, AND A MUTATION RUN IS WHY. This test used
   * to loop over `REFUSED_HEADERS` and nothing else — so deleting `host` from
   * the constant deleted the case that tested it, and the mutant survived with a
   * full green suite. A test written in terms of the value it is testing agrees
   * with any value. Bind the number to its noun: name the headers here.
   */
  assert.deepEqual([...REFUSED_HEADERS], [
    'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
    'upgrade', 'te', 'trailer', 'expect',
  ]);

  for (const name of ['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect']) {
    const r = await httpProbe({ port: 3000, headers: { [name]: 'x' }, listProcesses: running(3000) });
    assert.equal(r.ok, false, name);
    assert.match(r.error, new RegExp(`sets "${name}" itself`), name);
    assert.match(r.error, /authorization and cookie, you may set/, 'the refusal names what IS allowed');
  }
});

test('the Host header is OURS — a caller cannot aim the request at another app', async () => {
  const { port, seen } = await serve((_q, res) => { res.writeHead(200); res.end('ok'); });

  // ⚠️ Host routing is how one local proxy fronts several apps. If a caller
  // could set it, the port check would approve one destination and the request
  // would arrive at another.
  const refused = await httpProbe({ port, headers: { Host: 'admin.internal' }, listProcesses: running(port) });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /sets "host" itself/);

  const ok = await httpProbe({ port, listProcesses: running(port) });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(seen[0].headers.host, `127.0.0.1:${port}`, 'and the one we send names the port we were approved for');
});

test('a header value with a newline is refused, not stripped', () => {
  const r = validateHeaders({ 'x-a': 'ok\r\nX-Evil: 1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /inject extra headers/);

  // ⚠️ And the happy path: a normal value survives untouched and lands lowercased.
  const good = validateHeaders({ 'Content-Type': 'application/json', Accept: 'text/plain' });
  assert.deepEqual(good, { ok: true, headers: { 'content-type': 'application/json', accept: 'text/plain' } });
  assert.deepEqual(validateHeaders(undefined), { ok: true, headers: {} });
});

test('a caller content-type wins over the one json implies', async () => {
  const { port, seen } = await serve((_q, res) => { res.writeHead(200); res.end('k'); });
  const r = await httpProbe({
    port, method: 'POST', json: { a: 1 },
    headers: { 'content-type': 'application/vnd.api+json' },
    listProcesses: running(port),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(seen[0].headers['content-type'], 'application/vnd.api+json');
  assert.equal(seen[0].body, '{"a":1}');
});

/* ────────────────────────────────────────────────────────────────────────────
 * BODIES
 * ──────────────────────────────────────────────────────────────────────────── */

test('body and json together is a refusal', async () => {
  const r = await httpProbe({ port: 3000, method: 'POST', body: 'a', json: { a: 1 }, listProcesses: running(3000) });
  assert.equal(r.ok, false);
  assert.match(r.error, /not both/);
});

test('a raw string body goes through untouched', async () => {
  const { port, seen } = await serve((_q, res) => { res.writeHead(200); res.end('ok'); });
  const r = await httpProbe({
    port, method: 'POST', body: 'name=ada&role=eng',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    listProcesses: running(port),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(seen[0].body, 'name=ada&role=eng');
});

test('an object passed as body says to use json instead', async () => {
  const r = await httpProbe({ port: 3000, method: 'POST', body: { a: 1 }, listProcesses: running(3000) });
  assert.equal(r.ok, false);
  assert.match(r.error, /use "json"/);
});

test('a long response is cut, and SAYS which cut happened', async () => {
  const big = 'x'.repeat(MAX_BODY_CHARS + 5_000);
  const { port } = await serve((_q, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(big); });
  const r = await httpProbe({ port, listProcesses: running(port) });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.truncated, true);
  assert.match(r.body, new RegExp(`first ${MAX_BODY_CHARS} of ${big.length} characters`));
  assert.equal(r.bytes, big.length, 'the real size is still reported');
  assert.equal(r.body.startsWith('x'.repeat(100)), true);
});

test('a response bigger than the wire cap says BOTH things', async () => {
  // ⚠️⚠️ THE BUG THIS PINS: the wire sentence was appended first and then sliced
  // away by the character cap, so the one case the 256KB cap exists for could
  // never report itself. Anything over 256KB trips both cuts, always.
  const huge = 'y'.repeat(MAX_BODY_BYTES + 50_000);
  const { port } = await serve((_q, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(huge); });
  const r = await httpProbe({ port, listProcesses: running(port), timeoutMs: 10_000 });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.truncated, true);
  assert.match(r.body, /stopped reading at 256KB/, 'the wire cut must survive the display cut');
  assert.match(r.body, /showed the first 8000/);
});

test('a binary response reports its status and refuses to render the body', async () => {
  /**
   * ⚠️⚠️ NOT ONE NUL BYTE IN THIS FIXTURE, AND A MUTATION RUN IS WHY. The first
   * version used `[0x89,0x50,0x4e,0x47,0x00,…]`, so deleting the CONTENT-TYPE
   * check entirely left the test green — the NUL check downstream caught it and
   * produced a message that still matched. The test claimed to cover the type
   * rule and covered the byte rule. These bytes decode as (garbage) text, so
   * only the content-type check can refuse them.
   */
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8]);
  const { port } = await serve((_q, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); });
  const r = await httpProbe({ port, path: '/logo.png', listProcesses: running(port) });

  // ⚠️ NOT A FAILURE. "It is a PNG and it is 200" is exactly the fact the model
  // asked for; only the rendering is refused.
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 200);
  assert.equal(r.body, null);
  assert.match(r.bodyOmitted, /image\/png/, 'the type is named, which ends the line of enquiry');
  assert.match(r.bodyOmitted, /does not render as text/, 'refused for its TYPE, not for containing a NUL');
});

test('a body that CLAIMS to be text but is binary is caught too', async () => {
  const { port } = await serve((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(Buffer.from([0x61, 0x00, 0x62]));
  });
  const r = await httpProbe({ port, listProcesses: running(port) });
  assert.equal(r.ok, true);
  assert.equal(r.body, null);
  assert.match(r.bodyOmitted, /binary/);
});

test('a gzipped response is decompressed, not shown as a smear', async () => {
  const payload = JSON.stringify({ hello: 'world' });
  const { port } = await serve((_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(gzipSync(Buffer.from(payload)));
  });
  const r = await httpProbe({ port, listProcesses: running(port) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.body, '{\n  "hello": "world"\n}');
});

test('an empty body is an empty string, not a crash', async () => {
  const { port } = await serve((_q, res) => { res.writeHead(204); res.end(); });
  const r = await httpProbe({ port, listProcesses: running(port) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.body, '');
  assert.equal(r.bytes, 0);
});

/* ────────────────────────────────────────────────────────────────────────────
 * REDIRECTS, METHODS, ARGUMENTS
 * ──────────────────────────────────────────────────────────────────────────── */

test('a redirect is REPORTED and never followed', async () => {
  let hits = 0;
  const { port } = await serve((req, res) => {
    hits += 1;
    if (req.url === '/old') { res.writeHead(302, { location: '/new' }); res.end(); return; }
    res.writeHead(200); res.end('landed');
  });
  const r = await httpProbe({ port, path: '/old', listProcesses: running(port) });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 302);
  assert.equal(r.class, 'redirect');
  assert.match(r.note, /does NOT follow redirects/);
  assert.match(r.note, /\/new/, 'it hands over the Location so the next call is one step away');
  assert.equal(hits, 1, 'exactly one request — following one would be a hop the guard never approved');
});

test('CONNECT and TRACE are refused with the reason', async () => {
  const connect = await httpProbe({ port: 3000, method: 'CONNECT', listProcesses: running(3000) });
  assert.equal(connect.ok, false);
  assert.match(connect.error, /tunnel/);
  assert.match(connect.error, /GET, HEAD, POST/, 'and the refusal lists what IS allowed');

  const trace = await httpProbe({ port: 3000, method: 'TRACE', listProcesses: running(3000) });
  assert.equal(trace.ok, false);
  assert.match(trace.error, /reflects/);
});

test('an unknown argument is refused by name, with the right key suggested', async () => {
  const r = await httpProbe({ port: 3000, data: { a: 1 }, listProcesses: running(3000) });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not accept "data"/);
  assert.match(r.error, /Use "json"/, 'silently dropping it would teach the model the body was sent');
});

test('a seam supplied as data rather than a function is refused', async () => {
  const r = await httpProbe({ port: 3000, requestImpl: 'http://evil', listProcesses: running(3000) });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not accept "requestImpl"/);
});

test('timeoutMs is clamped rather than refused, and nonsense is refused', async () => {
  const { port } = await serve((_q, res) => { res.writeHead(200); res.end('ok'); });
  let sawTimeout = null;
  const r = await httpProbe({
    port, timeoutMs: 10 * 60_000, listProcesses: running(port),
    requestImpl: async (opts) => { sawTimeout = opts.timeoutMs; return { status: 200, statusText: 'OK', headers: {}, body: Buffer.from('ok'), bytes: 2, truncated: false }; },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(sawTimeout, MAX_TIMEOUT_MS, 'clamped: refusing would cost a round to learn a number');

  const bad = await httpProbe({ port, timeoutMs: -1, listProcesses: running(port) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /positive number of milliseconds/);
});

test('a dry run calls nothing', async () => {
  const { port, seen } = await serve((_q, res) => { res.writeHead(200); res.end('ok'); });
  const r = await httpProbe({ port, method: 'POST', json: {}, executor: { dryRun: true }, listProcesses: running(port) });
  assert.equal(r.ok, false);
  assert.match(r.error, /dry-run/);
  assert.deepEqual(seen, [], 'and no request was made');
});

test('the run budget refuses with a way out, and only after real work', async () => {
  resetHttpProbeState();
  const { port } = await serve((_q, res) => { res.writeHead(200); res.end('ok'); });
  for (let i = 0; i < MAX_CALLS_PER_RUN; i += 1) {
    const r = await httpProbe({ port, listProcesses: running(port) });
    assert.equal(r.ok, true, `call ${i + 1} must succeed: ${r.error}`);
  }
  const over = await httpProbe({ port, listProcesses: running(port) });
  assert.equal(over.ok, false);
  assert.match(over.error, /that is a loop, not a test/);
  assert.match(over.error, /run_command/);
  resetHttpProbeState();
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE ::1 FALLBACK — stubbed, because a v6-only server is not portable
 * ──────────────────────────────────────────────────────────────────────────── */

test('a server bound only to ::1 is reached, not reported as dead', async () => {
  const tried = [];
  const requestImpl = async ({ host }) => {
    tried.push(host);
    if (host === '127.0.0.1') { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }
    return { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: Buffer.from('v6'), bytes: 2, truncated: false };
  };
  const r = await httpProbe({ port: 3000, listProcesses: running(3000), requestImpl });

  assert.equal(r.ok, true, r.error);
  assert.deepEqual(tried, ['127.0.0.1', '::1'], 'v4 first, then the v6 loopback — still the same approved port');
  assert.equal(r.url, 'http://[::1]:3000/');

  // ⚠️ And when neither answers, it is still the refusal sentence, not a v6 story.
  const dead = await httpProbe({
    port: 3000, listProcesses: running(3000),
    requestImpl: async () => { const e = new Error('nope'); e.code = 'ECONNREFUSED'; throw e; },
  });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /NOTHING is listening/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE SCHEMA
 * ──────────────────────────────────────────────────────────────────────────── */

test('the schema names the boundary out loud', () => {
  const schemas = httpProbeToolSchemas();
  assert.deepEqual(schemas.map((s) => s.function.name), HTTP_PROBE_TOOL_NAMES);

  const d = schemas[0].function.description;
  // ⚠️ A model that does not know the rule spends one round discovering it and a
  // second arguing with the refusal. The schema is the cheapest documentation.
  assert.match(d, /start_process/);
  assert.match(d, /check_process/);
  assert.match(d, /fetch_url/, 'and it hands public URLs to the tool that does them');
  assert.match(d, /authorization/, 'headers policy is stated where the model reads it');
  assert.match(d, /never followed/);

  const p = schemas[0].function.parameters.properties;
  assert.deepEqual(Object.keys(p).sort(), ['body', 'headers', 'json', 'method', 'path', 'port', 'timeoutMs', 'url']);
  assert.deepEqual(p.method.enum, [...ALLOWED_METHODS]);
});

test('the dispatcher passes arguments through and refuses an unknown name', async () => {
  const { port } = await serve((_q, res) => { res.writeHead(200); res.end('via dispatch'); });
  // ⚠️ The dispatcher cannot inject the registry, so this proves the REAL default
  // path: `listBackground()` is consulted, nothing was started, and it refuses.
  const real = await runHttpProbeTool('call_endpoint', { port, path: '/' }, {});
  assert.equal(real.ok, false);
  assert.match(real.error, /THIS run started/, 'the live registry is the default, not a test stub');

  const unknown = await runHttpProbeTool('call_anything', {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown http tool/);
});
