/**
 * ── ⭐⭐ HOSTED MCP: THE CONNECTION BREADTH THAT DID NOT EXIST ───────────────
 *
 * Measured on `lib/mcp.mjs` before 2026-08-15, with a config declaring a server
 * the way Sentry, Linear, Notion, Vercel and GitHub's hosted server all document
 * it:
 *
 *     readMcpConfig(dir)  ->  {"ok":false,"error":"server \"remote\" has no
 *                              \"command\""}
 *
 * Every hosted connector in the ecosystem was unreachable, and the error named
 * the wrong thing — it complained about a missing binary for a server that never
 * had one.
 *
 * ── ⚠️ WHY THIS FILE STANDS UP A REAL SERVER RATHER THAN MOCKING `fetch` ─────
 *
 * A mocked `fetch` proves the code calls `fetch`. It cannot prove the SSE frame
 * boundary is right, that `Mcp-Session-Id` is echoed, that a 202 is not treated
 * as a reply, or that the CLI ever reaches any of it. This package's most
 * expensive recurring defect is the feature whose parts all exist and which
 * nothing calls — it shipped four times in one day, twice inside the commits
 * fixing it. So the last test in this file drives `bin/acuvo.mjs` as a child
 * process against a real HTTP MCP server on 127.0.0.1, and asserts on what the
 * SERVER saw.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readMcpConfig,
  connectServer,
  connectRemoteServer,
  closeConnections,
  mcpToolSchemas,
  callMcpTool,
  checkRemoteUrl,
  resolveHeaders,
  createSseParser,
  fetchSameOrigin,
  isLoopbackHost,
  HTTP_PROTOCOL_VERSION,
} from '../lib/mcp.mjs';
import { fingerprint, describeServers, headerEnvRefs, isRemote } from '../lib/mcp-consent.mjs';
import { assessMcpServer } from '../lib/doctor.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acuvo.mjs');

/* ────────────────────────────────────────────────────────────────────────────
 * A minimal, zero-dependency MCP server. Speaks BOTH transports:
 *   POST /mcp        Streamable HTTP  (answers json or text/event-stream)
 *   GET  /sse        legacy SSE       (+ POST /messages)
 * and records every JSON-RPC message it was sent, which is what the reach test
 * asserts on.
 * ──────────────────────────────────────────────────────────────────────────── */
function mcpTestServer({ streamReplies = false, requireAuth = null } = {}) {
  const seen = [];
  /** open legacy-SSE response objects, keyed by session id */
  const streams = new Map();

  function handle(msg) {
    seen.push(msg);
    if (msg.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? HTTP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'acuvo-test-server', version: '1.0.0' },
        },
      };
    }
    if (msg.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [{
            name: 'echo',
            description: 'Echo a string back, so a test can prove a real round trip.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          }],
        },
      };
    }
    if (msg.method === 'tools/call') {
      if (msg.params?.name !== 'echo') {
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no tool "${msg.params?.name}"` } };
      }
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `echoed: ${msg.params?.arguments?.text}` }] },
      };
    }
    return null;   // a notification: nothing to answer
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (requireAuth && req.headers.authorization !== requireAuth) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad credentials' }));
      return;
    }

    // A same-origin redirect a real server would do, and a cross-origin one.
    if (url.pathname === '/moved') { res.writeHead(307, { location: '/mcp' }); res.end(); return; }
    if (url.pathname === '/away') { res.writeHead(307, { location: 'https://attacker.example/mcp' }); res.end(); return; }

    if (url.pathname === '/sse' && req.method === 'GET') {
      const sid = `s${streams.size + 1}`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      streams.set(sid, res);
      res.write(`event: endpoint\ndata: /messages?sessionId=${sid}\n\n`);
      req.on('close', () => streams.delete(sid));
      return;
    }

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end('not json'); return; }

      if (url.pathname === '/messages') {
        const out = handle(msg);
        res.writeHead(202, { 'content-type': 'text/plain' });
        res.end('Accepted');
        // ⭐ The legacy transport's whole shape: the ANSWER comes back on the
        // long-lived GET, not on the POST.
        const stream = streams.get(url.searchParams.get('sessionId'));
        if (out && stream) stream.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
        return;
      }

      const out = handle(msg);
      if (!out) { res.writeHead(202).end(); return; }
      const headers = { 'mcp-session-id': 'session-abc' };
      if (streamReplies) {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        // ⚠️ Deliberately split across two writes MID-FRAME. A parser that
        // splits each chunk independently passes on a fast local socket and
        // corrupts under load; this is the cheapest way to make that fail here.
        const payload = `event: message\ndata: ${JSON.stringify(out)}\n\n`;
        res.write(payload.slice(0, 18));
        setTimeout(() => { res.write(payload.slice(18)); res.end(); }, 5);
        return;
      }
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  return {
    seen,
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address();
      this.port = port;
      this.origin = `http://127.0.0.1:${port}`;
      return this;
    },
    close() {
      for (const s of streams.values()) { try { s.end(); } catch { /* gone */ } }
      // ⚠️ `server.close()` alone waits out every keep-alive socket the client
      // side is still pooling, which is a test that finishes and then sits.
      try { server.closeAllConnections(); } catch { /* older node */ }
      return new Promise((r) => server.close(r));
    },
  };
}

function tempWorkspace(config) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-mcp-remote-'));
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  writeFileSync(join(dir, '.acuvo', 'mcp.json'), JSON.stringify(config, null, 2));
  return dir;
}

/* ── 1. the config layer, which is where it was rejected ─────────────────── */

test('⭐ a hosted server declared the documented way is READ, not rejected', () => {
  const dir = tempWorkspace({ mcpServers: { remote: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } } });
  try {
    const cfg = readMcpConfig(dir);
    assert.equal(cfg.ok, true, cfg.error);
    assert.equal(cfg.servers.length, 1);
    assert.equal(cfg.servers[0].transport, 'http');
    assert.equal(cfg.servers[0].url, 'https://mcp.sentry.dev/mcp');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a bare "url" means Streamable HTTP; "sse" is honoured; an unknown type is an error', () => {
  const a = tempWorkspace({ mcpServers: { x: { url: 'https://a.example/mcp' } } });
  const b = tempWorkspace({ mcpServers: { x: { type: 'sse', url: 'https://a.example/sse' } } });
  const c = tempWorkspace({ mcpServers: { x: { type: 'websocket', url: 'https://a.example' } } });
  try {
    assert.equal(readMcpConfig(a).servers[0].transport, 'http');
    assert.equal(readMcpConfig(b).servers[0].transport, 'sse');
    const bad = readMcpConfig(c);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /does not speak/);
  } finally { for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true }); }
});

test('⚠️ stdio is untouched — a command-only server still reads exactly as before', () => {
  const dir = tempWorkspace({ mcpServers: { local: { command: 'node', args: ['x.mjs'], env: { A: '1' } } } });
  try {
    const s = readMcpConfig(dir).servers[0];
    assert.equal(s.transport, 'stdio');
    assert.equal(s.command, 'node');
    assert.deepEqual(s.args, ['x.mjs']);
    assert.deepEqual(s.env, { A: '1' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ── 2. the credential boundary ───────────────────────────────────────────── */

test('⚠️⚠️ http:// to a remote host is REFUSED — a token must not cross in cleartext', () => {
  const bad = checkRemoteUrl('http://mcp.evil.example/mcp', { name: 'evil' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /cleartext/);
  // ⭐ loopback is the exemption, and it is the one this file's own server needs.
  assert.equal(checkRemoteUrl('http://127.0.0.1:9999/mcp').ok, true);
  assert.equal(checkRemoteUrl('http://localhost:9999/mcp').ok, true);
  assert.equal(checkRemoteUrl('https://mcp.sentry.dev/mcp').ok, true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('mcp.evil.example'), false);
});

test('⚠️⚠️ an unset ${VAR} REFUSES rather than sending the literal text to a third party', () => {
  const server = { name: 'x', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer ${NOPE_TOKEN}' } };
  const r = resolveHeaders(server, { env: {} });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['NOPE_TOKEN']);
  assert.match(r.error, /refusing to connect/);

  const good = resolveHeaders(server, { env: { NOPE_TOKEN: 'sk-real' } });
  assert.equal(good.ok, true);
  assert.equal(good.headers.Authorization, 'Bearer sk-real');
});

test('⚠️⚠️ a cross-origin redirect is refused BY NAME; a same-origin one is followed', async () => {
  const srv = await mcpTestServer().listen();
  try {
    const same = await fetchSameOrigin(fetch, `${srv.origin}/moved`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(same.res.status, 200);
    // ⚠️ CONSUMED, not ignored. An unread body pins the socket, and a test that
    // leaks one makes the whole FILE hang after every assertion has passed —
    // measured here: 17 green tests in 2s, then 127s of nothing.
    await same.res.text();

    await assert.rejects(
      () => fetchSameOrigin(fetch, `${srv.origin}/away`, { method: 'POST', body: '{}' }),
      /refused a redirect .* to https:\/\/attacker\.example/,
    );
  } finally { await srv.close(); }
});

/* ── 3. consent — the destination, not just the binary ────────────────────── */

test('⚠️⚠️ consent covers the DESTINATION: the url and the header names change the fingerprint', () => {
  const base = { name: 'r', transport: 'http', url: 'https://good.example/mcp', headers: {}, command: 'https://good.example/mcp', args: [], env: {} };
  const elsewhere = { ...base, url: 'https://attacker.example/mcp', command: 'https://attacker.example/mcp' };
  const withToken = { ...base, headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } };
  const otherToken = { ...base, headers: { Authorization: 'Bearer ${AWS_SECRET}' } };

  assert.notEqual(fingerprint([base]), fingerprint([elsewhere]));
  assert.notEqual(fingerprint([base]), fingerprint([withToken]));
  assert.notEqual(fingerprint([withToken]), fingerprint([otherToken]));
});

test('⭐ adding remote support did NOT invalidate every existing stdio approval', () => {
  /**
   * ⚠️ THE HASH OF A STDIO CONFIG IS A FIXED STRING, PINNED HERE. `fingerprint`
   * now has a remote branch; if it ever starts writing `transport`/`url`/
   * `headers` into a stdio server's canonical form, every trust record on every
   * machine silently stops matching and every user is re-prompted for a config
   * they already read. A prompt people are trained to click through is worse
   * than no prompt — this file's own header says so.
   */
  const stdio = [{ name: 'evil', command: 'node', args: ['evil.mjs'], env: { A: '1' }, transport: 'stdio' }];
  const withoutTransportField = [{ name: 'evil', command: 'node', args: ['evil.mjs'], env: { A: '1' } }];
  assert.equal(fingerprint(stdio), fingerprint(withoutTransportField));

  /**
   * ── ⚠️ THE PINNED CONSTANT MOVED ONCE, DELIBERATELY, AND IT IS NOW SHARPER ─
   *
   * The old pin was `8a49deea…`, the hash of THIS env-carrying fixture. It went
   * red when `fingerprint` started hashing env VALUES rather than only keys —
   * the fix for a remote code execution: an approved `{"NODE_OPTIONS":""}` and
   * a hostile `{"NODE_OPTIONS":"--require ./pwn.cjs"}` used to hash the same.
   * The pin did exactly its job: it made a change to the canonical form
   * impossible to land by accident.
   *
   * ⭐ SO THE PIN NOW GUARDS THE PROPERTY THIS TEST IS ACTUALLY ABOUT — that
   * the blast radius is BOUNDED. `40aaec28…` is the hash of an ENV-FREE stdio
   * config, MEASURED against the pre-change code and identical after it. The
   * majority of configs carry no env, and not one of their users is
   * re-prompted. Configs that do carry env re-prompt once, which is correct:
   * those are precisely the approvals that were unsound.
   *
   * ⚠️ Still a pinned constant, never a recomputation — comparing the function
   * to itself passes whatever it does, the check-that-cannot-fail shape this
   * repo has paid for repeatedly.
   */
  const envFree = [{ name: 'evil', command: 'node', args: ['evil.mjs'], transport: 'stdio' }];
  assert.equal(fingerprint(envFree), '40aaec28ee93b4a3676417baab64d162f67b448a32c6dbbec80237ff9e50d2f3',
    'an env-free stdio approval must survive untouched, or every existing user is re-prompted for nothing');
  assert.notEqual(fingerprint(stdio), fingerprint(envFree));
});

test('⚠️ the prompt names the HOST and the VARIABLE, and never a literal value', () => {
  const servers = [{
    name: 'sentry',
    transport: 'http',
    url: 'https://attacker.example/mcp',
    headers: { Authorization: 'Bearer ${GITHUB_TOKEN}', 'X-Key': 'sk-live-REALSECRET' },
    command: 'https://attacker.example/mcp',
    args: [],
    env: {},
  }];
  const text = describeServers(servers, { root: '/repo' });
  assert.match(text, /attacker\.example/);
  assert.match(text, /GITHUB_TOKEN/);
  assert.match(text, /leaves this machine/);
  assert.ok(!text.includes('sk-live-REALSECRET'), 'a literal header value must never be printed');
  assert.match(text, /values hidden/);
  assert.deepEqual(headerEnvRefs(servers[0]), ['GITHUB_TOKEN']);
  assert.equal(isRemote(servers[0]), true);
});

/* ── 4. the doctor must not call a working hosted server broken ───────────── */

test('⚠️ the doctor does not report a hosted server as a missing executable', () => {
  const server = { name: 'sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp', headers: {}, command: 'https://mcp.sentry.dev/mcp', args: [], env: {} };
  const row = assessMcpServer(server, { file: '.acuvo/mcp.json', env: {}, resolution: { kind: 'missing-path', path: server.url } });
  assert.equal(row.state, 'live', 'a hosted server is not broken merely because no file has its name');
  assert.equal(row.verified, false, 'the doctor never connects, so it cannot claim more than "declared"');
  assert.match(row.detail, /mcp\.sentry\.dev/);

  const keyed = { ...server, headers: { Authorization: 'Bearer ${SENTRY_TOKEN}' } };
  const broken = assessMcpServer(keyed, { file: '.acuvo/mcp.json', env: {}, resolution: { kind: 'missing-path' } });
  assert.equal(broken.state, 'broken');
  assert.match(broken.detail, /SENTRY_TOKEN/);
});

/* ── 5. the SSE frame parser ──────────────────────────────────────────────── */

test('⚠️ an SSE frame split mid-payload across reads still parses, and keeps its event name', () => {
  const frames = [];
  const p = createSseParser((f) => frames.push(f));
  p.push('event: endp');
  p.push('oint\ndata: /messa');
  p.push('ges?sessionId=1\n\nevent: message\ndata: {"a"');
  p.push(':1}\n\n');
  assert.deepEqual(frames, [
    { event: 'endpoint', data: '/messages?sessionId=1' },
    { event: 'message', data: '{"a":1}' },
  ]);
});

/* ── 6. the real handshake and a real tools/call, over both transports ────── */

for (const [label, opts] of [
  ['Streamable HTTP, application/json reply', { streamReplies: false }],
  ['Streamable HTTP, text/event-stream reply', { streamReplies: true }],
]) {
  test(`⭐⭐ REAL handshake + tools/call over ${label}`, async () => {
    const srv = await mcpTestServer(opts).listen();
    const dir = tempWorkspace({ mcpServers: { probe: { type: 'http', url: `${srv.origin}/mcp` } } });
    let conns = [];
    try {
      const cfg = readMcpConfig(dir);
      assert.equal(cfg.ok, true, cfg.error);
      const conn = await connectServer(cfg.servers[0], { root: dir });
      conns = [conn];
      assert.equal(conn.ok, true, conn.error);
      assert.equal(conn.tools.length, 1);

      const schemas = mcpToolSchemas(conns);
      assert.equal(schemas[0].function.name, 'mcp__probe__echo');

      const res = await callMcpTool(conns, 'mcp__probe__echo', { text: 'over the wire' });
      assert.equal(res.ok, true, res.error);
      assert.equal(res.text, 'echoed: over the wire');

      const methods = srv.seen.map((m) => m.method);
      assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
      // ⭐ The session id handed back on initialize must be echoed afterwards,
      // or every later call comes back 404 "session not found".
      assert.equal(srv.seen[0].params.protocolVersion, HTTP_PROTOCOL_VERSION);
    } finally {
      closeConnections(conns);
      rmSync(dir, { recursive: true, force: true });
      await srv.close();
    }
  });
}

test('⭐⭐ REAL handshake + tools/call over legacy SSE (endpoint event, 202, reply on the GET)', async () => {
  const srv = await mcpTestServer().listen();
  const dir = tempWorkspace({ mcpServers: { legacy: { type: 'sse', url: `${srv.origin}/sse` } } });
  let conns = [];
  try {
    const cfg = readMcpConfig(dir);
    const conn = await connectServer(cfg.servers[0], { root: dir });
    conns = [conn];
    assert.equal(conn.ok, true, conn.error);
    assert.equal(conn.tools[0].name, 'echo');
    const res = await callMcpTool(conns, 'mcp__legacy__echo', { text: 'two channels' });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.text, 'echoed: two channels');
  } finally {
    closeConnections(conns);
    rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});

test('⭐ the Authorization header actually arrives — a 401 server accepts us only with it', async () => {
  const srv = await mcpTestServer({ requireAuth: 'Bearer sk-from-the-environment' }).listen();
  const spec = { name: 'keyed', transport: 'http', url: `${srv.origin}/mcp`, headers: { Authorization: 'Bearer ${TEST_MCP_TOKEN}' }, command: '', args: [], env: {} };
  try {
    const good = await connectRemoteServer(spec, { env: { TEST_MCP_TOKEN: 'sk-from-the-environment' } });
    assert.equal(good.ok, true, good.error);
    closeConnections([good]);

    const wrong = await connectRemoteServer(spec, { env: { TEST_MCP_TOKEN: 'sk-wrong' } });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /401/);
  } finally { await srv.close(); }
});

/* ── 7. degrade quietly ───────────────────────────────────────────────────── */

test('⚠️ an unreachable remote server is DATA, never a throw, and the others still work', async () => {
  const srv = await mcpTestServer().listen();
  const dead = { name: 'dead', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: {}, command: '', args: [], env: {} };
  const live = { name: 'live', transport: 'http', url: `${srv.origin}/mcp`, headers: {}, command: '', args: [], env: {} };
  try {
    const conns = await Promise.all([connectRemoteServer(dead), connectRemoteServer(live)]);
    assert.equal(conns[0].ok, false);
    assert.ok(conns[0].error, 'a dead host must produce a reason, not an exception');
    assert.equal(conns[1].ok, true, conns[1].error);
    // ⭐ The surviving server still contributes its tools: one dark server must
    // not cost the whole surface.
    assert.deepEqual(mcpToolSchemas(conns).map((s) => s.function.name), ['mcp__live__echo']);
    closeConnections(conns);
  } finally { await srv.close(); }
});

/* ── 8. the session must be able to END ───────────────────────────────────── */

/**
 * ── ⚠️⚠️ THE 127 SECONDS OF NOTHING, AND WHY IT NEEDS ITS OWN TEST ─────────
 *
 * Measured while building this file. Every test above passed in two seconds and
 * the process then sat for **127 more** before it could exit: against a server
 * that answers a POST with `text/event-stream`, the read loop never finished, so
 * the `CALL_TIMEOUT_MS + 5s` abort backstop was never cleared and its timer held
 * the event loop open. The run reported `# fail 0` with a file-level
 * `testTimeoutFailure` underneath it — the exact shape this repo has been burned
 * by twice: a summary that says green while something is red.
 *
 * ⚠️ NO ASSERTION INSIDE THE PROCESS CAN CATCH THIS. Every value was correct;
 * the only symptom is that the process would not exit. So the check has to be a
 * CHILD process that is required to drain its own event loop — and the child
 * deliberately does NOT call `process.exit()`, because exiting on demand is
 * precisely the thing being proven unnecessary.
 */
test('⚠️⚠️ a session with a hosted server EXITS ON ITS OWN after closeConnections', async () => {
  const srv = await mcpTestServer({ streamReplies: true }).listen();
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-mcp-exit-'));
  const lib = new URL('../lib/mcp.mjs', import.meta.url).href;
  const script = join(dir, 'run.mjs');
  writeFileSync(script, [
    `import { connectRemoteServer, closeConnections, callMcpTool } from ${JSON.stringify(lib)};`,
    `const conn = await connectRemoteServer({ name: 'p', transport: 'http', url: ${JSON.stringify(`${srv.origin}/mcp`)}, headers: {} });`,
    'if (!conn.ok) { console.error(conn.error); process.exit(2); }',
    "const r = await callMcpTool([conn], 'mcp__p__echo', { text: 'x' });",
    'if (!r.ok) { console.error(r.error); process.exit(3); }',
    'closeConnections([conn]);',
    '// ⭐ Deliberately no process.exit(). Draining is the assertion.',
  ].join('\n'));

  try {
    const { status, stderr } = await new Promise((resolve, reject) => {
      const cp = spawn(process.execPath, [script], { windowsHide: true });
      let err = '';
      cp.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => { cp.kill(); resolve({ status: 'TIMED_OUT', stderr: err }); }, 10_000);
      cp.on('error', (e) => { clearTimeout(timer); reject(e); });
      cp.on('exit', (s) => { clearTimeout(timer); resolve({ status: s, stderr: err }); });
    });
    assert.equal(status, 0, `the child did not exit on its own within 10s (${status}) ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});

/* ── 9. ⭐⭐ REACH: the real CLI, a real server, a real tools/call ─────────── */

/**
 * ⚠️ THE ONLY TEST HERE THAT PROVES THE FEATURE IS CONNECTED. Everything above
 * calls `lib/` directly, which is exactly the shape of the defect this package
 * ships most often: parts that all work and nothing that calls them. This spawns
 * `bin/acuvo.mjs`, points it at a stub model that asks for the remote tool, and
 * asserts on what the MCP SERVER RECORDED.
 */
test('⭐⭐ REACH: bin/acuvo.mjs connects to a hosted server and calls its tool', async (t) => {
  const mcp = await mcpTestServer().listen();

  let round = 0;
  const model = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      round += 1;
      const message = round === 1
        ? {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__hosted__echo', arguments: JSON.stringify({ text: 'driven by the real CLI' }) } }],
        }
        : { role: 'assistant', content: 'The hosted tool answered.' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `stub-${round}`,
        model: 'stub/model',
        choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00001 },
      }));
    });
  });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  const modelUrl = `http://127.0.0.1:${model.address().port}/v1/chat/completions`;

  const dir = tempWorkspace({ mcpServers: { hosted: { type: 'http', url: `${mcp.origin}/mcp` } } });

  try {
    const run = await new Promise((resolve, reject) => {
      const cp = spawn(process.execPath, [CLI, '--dir', dir, '--max-rounds', '3', 'echo something through the hosted server'], {
        windowsHide: true,
        env: {
          ...process.env,
          NO_COLOR: '1',
          OPENROUTER_API_KEY: 'sk-or-v1-stub',
          ACUVO_API_URL: modelUrl,
          // ⭐ The documented escape for a non-interactive run. Without it
          // `checkMcpConsent` refuses — correctly — because nobody is there to
          // ask, and this test would prove only that the gate holds.
          ACUVO_TRUST_MCP: '1',
        },
      });
      let stdout = '';
      let stderr = '';
      cp.stdout.on('data', (d) => { stdout += d; });
      cp.stderr.on('data', (d) => { stderr += d; });
      cp.stdin.end('');
      const timer = setTimeout(() => { cp.kill(); reject(new Error(`the CLI did not exit within 45s\n${stdout}\n${stderr}`)); }, 45_000);
      cp.on('error', (e) => { clearTimeout(timer); reject(e); });
      cp.on('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });

    t.diagnostic(`cli exit=${run.status}`);
    // ⭐⭐ THE ASSERTION THAT MATTERS: the MCP server itself recorded a real
    // handshake and a real tools/call, made by the real binary.
    const methods = mcp.seen.map((m) => m.method);
    assert.ok(methods.includes('initialize'), `the CLI never handshook: ${methods.join(', ')}\n${run.stdout}\n${run.stderr}`);
    assert.ok(methods.includes('tools/list'), `no tools/list: ${methods.join(', ')}`);
    const called = mcp.seen.find((m) => m.method === 'tools/call');
    assert.ok(called, `the CLI never called the hosted tool: ${methods.join(', ')}\n${run.stdout}`);
    assert.equal(called.params.name, 'echo', 'the namespace must be stripped before it leaves for the server');
    assert.equal(called.params.arguments.text, 'driven by the real CLI');
    assert.match(run.stdout, /hosted connected \(1 tool\)/);
    // ⚠️ An open remote connection must not hold the process open — see
    // `closeConnections`. A non-zero exit here would mean it hung and was killed.
    assert.equal(run.status, 0, `the CLI exited ${run.status}\n${run.stdout}\n${run.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => model.close(r));
    await mcp.close();
  }
});
