/**
 * A live model stream is bounded by SILENCE, not by length. Found with a fetch
 * tracer on a real run: a round streaming 2,104 data frames was aborted at
 * exactly 180.0s as "No response". See `streamWatchdog` in lib/model.mjs.
 *
 * Real `fetch` against a loopback SSE server, because the property under test
 * is how undici propagates an abort into a body that is already streaming.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callModel } from '../lib/model.mjs';

// ⚠️ HERMETIC ABOUT THE SIGNED-IN ACCOUNT: this machine may hold
// ~/.acuvo/credentials.json, and a signed-in account outranks ACUVO_API_URL.
// An empty home means no credential is read, and fetchImpl pins every call to
// the loopback server regardless.
const emptyHome = mkdtempSync(join(tmpdir(), 'acuvo-wd-home-'));
process.env.HOME = emptyHome;
process.env.USERPROFILE = emptyHome;
delete process.env.ACUVO_TOKEN;

const frame = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

function sseServer(script) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      script(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function call(server, opts) {
  const { port } = server.address();
  return callModel({
    apiKey: 'test-key',
    model: 'test/model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    onText: () => {},
    env: { ACUVO_API_URL: `http://127.0.0.1:${port}/v1/chat/completions` },
    retryOnPinFailure: false,
    fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, init),
    ...opts,
  });
}

test('a stream still sending tokens is NOT cut at timeoutMs', async () => {
  const server = await sseServer((res) => {
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      if (n <= 12) res.write(frame(`w${n} `));
      else { clearInterval(t); res.write('data: [DONE]\n\n'); res.end(); }
    }, 50); // ~650ms of steady output
  });
  try {
    const r = await call(server, { timeoutMs: 250, streamIdleMs: 400, streamCapMs: 5_000 });
    assert.equal(r.ok, true, r.error);
    assert.match(r.content ?? r.text ?? '', /w12/);
  } finally { server.close(); }
});

test('a stream that only sends keep-alives is aborted for silence, and says so', async () => {
  const server = await sseServer((res) => {
    res.write(frame('start '));
    const t = setInterval(() => res.write(': OPENROUTER PROCESSING\n\n'), 50);
    res.on('close', () => clearInterval(t));
  });
  try {
    const started = Date.now();
    const r = await call(server, { timeoutMs: 5_000, streamIdleMs: 300, streamCapMs: 5_000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /went silent for/);
    assert.equal(r.kind, 'timeout', 'still retryable by the chain');
    assert.ok(Date.now() - started < 3_000, 'keep-alives did not keep it alive');
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('a stream that never ends is stopped at the hard cap', async () => {
  const server = await sseServer((res) => {
    const t = setInterval(() => res.write(frame('x')), 40);
    res.on('close', () => clearInterval(t));
  });
  try {
    const r = await call(server, { timeoutMs: 100, streamIdleMs: 300, streamCapMs: 600 });
    assert.equal(r.ok, false);
    assert.match(r.error, /still streaming after/);
  } finally { server.closeAllConnections?.(); server.close(); }
});

const thought = (r) => `data: ${JSON.stringify({ choices: [{ delta: { content: null, reasoning: r } }] })}\n\n`;

test('a stream that only THINKS is cut at the thinking budget, as a retryable timeout', async () => {
  const server = await sseServer((res) => {
    const t = setInterval(() => res.write(thought('hmm ')), 40);
    res.on('close', () => clearInterval(t));
  });
  try {
    const r = await call(server, { timeoutMs: 100, streamIdleMs: 400, streamThinkMs: 500, streamCapMs: 5_000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /still only thinking/);
    assert.equal(r.kind, 'timeout', 'the chain retries a timeout with reasoning off');
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('thinking that turns into content before the budget runs to the end, past the budget', async () => {
  const server = await sseServer((res) => {
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      if (n <= 3) res.write(thought('plan '));
      else if (n <= 20) res.write(frame(`w${n} `));
      else { clearInterval(t); res.write('data: [DONE]\n\n'); res.end(); }
    }, 50); // content from ~200ms, ends ~1s — past the 400ms thinking budget
  });
  try {
    const r = await call(server, { timeoutMs: 100, streamIdleMs: 400, streamThinkMs: 400, streamCapMs: 5_000 });
    assert.equal(r.ok, true, r.error);
    assert.match(r.content ?? '', /w20/);
  } finally { server.close(); }
});
