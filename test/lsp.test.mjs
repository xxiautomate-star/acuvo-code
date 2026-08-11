/**
 * ── THE LANGUAGE-SERVER TESTS — the traps, not the getters ──────────────────
 *
 * `lsp.mjs` is 90% plumbing that either works invisibly or fails invisibly, so
 * every test here pins a specific way it could be quietly wrong rather than
 * asserting that a function returns an object.
 *
 * ⚠️ MOST OF IT RUNS AGAINST A FAKE SERVER, AND THAT IS THE POINT, NOT A
 * COMPROMISE. `typescript-language-server` is not installed on most machines
 * (it is not installed on this one — it lives in a scratch directory used for
 * the manual demo), so a suite that required it would be a suite that is skipped
 * everywhere and therefore proves nothing. A fake also lets us produce the
 * failures a real server never produces on demand: dying at startup, going
 * silent, refusing to shut down, dribbling one byte at a time, answering in the
 * flat symbol shape half the ecosystem uses.
 *
 * ⭐ AND ONE TEST IS AGAINST THE REAL THING, skipped when it is absent. It costs
 * nothing when the server is missing and catches the class of bug a fake can
 * never catch: our understanding of the protocol being wrong in the same way
 * twice.
 *
 * ⚠️ EVERY TEST THAT SPAWNS STOPS WHAT IT SPAWNED, in `t.after`, unconditionally.
 * A leaked language server on the owner's laptop is precisely the failure this
 * module was written to avoid, and a test suite that leaked them would be
 * indefensible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  encodeMessage, decodeMessages,
  languageForFile, languageIdForFile,
  discoverLanguageServer, resolveOnPath,
  startLanguageServer, stopLanguageServer, stopAllLanguageServers,
  definition, references, diagnostics, documentSymbols,
  lspToolSchemas, runLspTool, formatLspForModel,
  LSP_TOOL_NAMES, MAX_LOCATIONS, MAX_MESSAGE_BYTES, EXCERPT_MAX_CHARS,
} from '../lib/lsp.mjs';

const ws = () => mkdtempSync(join(tmpdir(), 'acuvo-lsp-'));

/**
 * ── THE FAKE SERVER ─────────────────────────────────────────────────────────
 * A real LSP peer in ~120 lines: correct Content-Length framing, a real
 * handshake, and one switch per mode that produces a specific pathology.
 *
 * It is written to disk by the test rather than committed as a fixture because
 * this task may only create two files — and, usefully, it means the framing on
 * the SERVER side is written independently of `lsp.mjs`'s, so the round-trip
 * test is not just the same bug agreeing with itself.
 */
const FAKE_SERVER = String.raw`
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODE = (process.argv.find((a) => a.startsWith('--mode=')) ?? '--mode=normal').slice(7);
const REFS = Number((process.argv.find((a) => a.startsWith('--refs=')) ?? '--refs=3').slice(7));

if (MODE === 'die') {
  process.stderr.write('boom: Cannot find module "typescript"\n');
  process.exit(1);
}

let grandchild = null;
if (MODE === 'hang-shutdown') {
  // The orphan hazard, made concrete: a child of the child, exactly like
  // tsserver under typescript-language-server.
  grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  process.stderr.write('grandchild=' + grandchild.pid + '\n');
  setInterval(() => {}, 1e9); // never exit on our own
}

const docs = new Map();
let buffer = Buffer.alloc(0);

// ⚠️ The dribble queue is SHARED, and the first version of this fake was not —
// each send dribbled its own bytes on its own timer, so a diagnostics publish
// interleaved with a response and produced a stream no client could ever parse.
// That is a bug in the fake, not in the client, and it cost a confusing 20s
// timeout to find. A real server writes one message at a time.
let outQueue = Buffer.alloc(0);
let draining = false;

function drain() {
  if (outQueue.length === 0) { draining = false; return; }
  process.stdout.write(outQueue.subarray(0, 1));
  outQueue = outQueue.subarray(1);
  setImmediate(drain);
}

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii');
  const whole = Buffer.concat([head, body]);
  if (MODE === 'dribble') {
    // One byte per tick. Splits headers, bodies and multi-byte characters.
    outQueue = Buffer.concat([outQueue, whole]);
    if (!draining) { draining = true; drain(); }
    return;
  }
  process.stdout.write(whole);
}

function diagnosticsFor(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes('BAD')) {
      out.push({
        range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
        severity: 1, code: 'TS9999', message: 'this line is BAD',
      });
    }
  });
  return out;
}

function publish(uri) {
  const text = docs.get(uri) ?? '';
  // ⚠️ The empty-then-real sequence tsserver really does. If the client takes
  // the first publish it reports a broken file as clean.
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
  setTimeout(() => {
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: diagnosticsFor(text) } });
  }, 30);
}

function handle(msg) {
  if (msg.method === 'initialize') {
    if (MODE === 'silent') return; // never answers
    if (MODE === 'needs-registration') {
      // ⚠️ A request FROM the server, sent BEFORE the initialize result. A
      // client that does not answer it never gets initialized.
      send({ jsonrpc: '2.0', id: 9001, method: 'client/registerCapability', params: { registrations: [] } });
      pendingInit = msg.id;
      return;
    }
    return send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { referencesProvider: true } } });
  }
  if (msg.method === 'shutdown') {
    if (MODE === 'hang-shutdown') return; // deliberately ignores it
    return send({ jsonrpc: '2.0', id: msg.id, result: null });
  }
  if (msg.method === 'exit') {
    if (MODE === 'hang-shutdown') return;
    return process.exit(0);
  }
  if (msg.method === 'textDocument/didOpen') {
    docs.set(msg.params.textDocument.uri, msg.params.textDocument.text);
    if (MODE !== 'no-diagnostics') publish(msg.params.textDocument.uri);
    return;
  }
  if (msg.method === 'textDocument/didChange') {
    docs.set(msg.params.textDocument.uri, msg.params.contentChanges[0].text);
    if (MODE !== 'no-diagnostics') publish(msg.params.textDocument.uri);
    return;
  }
  if (msg.method === 'textDocument/definition') {
    const uri = msg.params.textDocument.uri;
    const text = docs.get(uri) ?? '';
    const line = text.split(/\r?\n/).findIndex((l) => l.includes('// DEF'));
    if (line === -1) return send({ jsonrpc: '2.0', id: msg.id, result: null });
    // A LocationLink, not a Location — the shape a linkSupport client gets.
    return send({ jsonrpc: '2.0', id: msg.id, result: [{
      targetUri: uri,
      targetRange: { start: { line, character: 0 }, end: { line, character: 5 } },
      targetSelectionRange: { start: { line, character: 6 }, end: { line, character: 9 } },
    }] });
  }
  if (msg.method === 'textDocument/references') {
    const uri = msg.params.textDocument.uri;
    const out = [];
    for (let i = 0; i < REFS; i += 1) {
      out.push({ uri, range: { start: { line: i, character: 2 }, end: { line: i, character: 8 } } });
    }
    return send({ jsonrpc: '2.0', id: msg.id, result: out });
  }
  if (msg.method === 'textDocument/documentSymbol') {
    const uri = msg.params.textDocument.uri;
    if (MODE === 'flat-symbols') {
      return send({ jsonrpc: '2.0', id: msg.id, result: [
        { name: 'Widget', kind: 5, location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } } } },
        { name: 'render', kind: 6, location: { uri, range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } } } },
      ] });
    }
    return send({ jsonrpc: '2.0', id: msg.id, result: [
      {
        name: 'Widget', kind: 5, detail: 'class',
        range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
        children: [
          {
            name: 'render', kind: 6,
            range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
            selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
          },
        ],
      },
    ] });
  }
  if (msg.id !== undefined && msg.method) {
    return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
  }
}

let pendingInit = null;

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const at = buffer.indexOf('\r\n\r\n');
    if (at === -1) return;
    const len = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, at).toString('ascii'))[1]);
    if (buffer.length < at + 4 + len) return;
    const msg = JSON.parse(buffer.subarray(at + 4, at + 4 + len).toString('utf8'));
    buffer = buffer.subarray(at + 4 + len);
    // The client's ANSWER to our registerCapability request unblocks initialize.
    if (pendingInit !== null && msg.id === 9001) {
      const id = pendingInit; pendingInit = null;
      send({ jsonrpc: '2.0', id, result: { capabilities: {} } });
      continue;
    }
    handle(msg);
  }
});
`;

function fakeServerIn(root, mode = 'normal', extra = []) {
  const file = join(root, 'fake-lsp.mjs');
  writeFileSync(file, FAKE_SERVER, 'utf8');
  return { ok: true, label: `fake-lsp(${mode})`, file: process.execPath, argv: [file, `--mode=${mode}`, ...extra], via: file };
}

/** Wait for a child to actually be gone — a kill is asynchronous, and asserting
 *  straight after issuing one is how a leak test passes while leaking. */
function waitForExit(child, ms = 8_000) {
  return new Promise((res) => {
    if (child.exitCode !== null || child.signalCode !== null) return res(true);
    const t = setTimeout(() => res(false), ms);
    child.once('exit', () => { clearTimeout(t); res(true); });
  });
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// ───────────────────────────────────────────────────────────────────────────
// THE WIRE
// ───────────────────────────────────────────────────────────────────────────

test('framing survives being delivered one byte at a time, multi-byte characters included', () => {
  // ⚠️ THE BUG THIS EXISTS FOR: buffering a decoded STRING instead of Buffers.
  // 'é' and '—' are two and three bytes; split across chunks they decode to
  // replacement characters and every byte offset after them is wrong. A string
  // buffer passes a happy-path test and corrupts under load.
  const a = encodeMessage({ jsonrpc: '2.0', id: 1, result: { text: 'café — naïve — 日本語 — 🚀' } });
  const b = encodeMessage({ jsonrpc: '2.0', method: 'ping', params: {} });
  const stream = Buffer.concat([a, b]);

  let acc = Buffer.alloc(0);
  const got = [];
  for (const byte of stream) {
    acc = Buffer.concat([acc, Buffer.from([byte])]);
    const { messages, rest, error } = decodeMessages(acc);
    assert.equal(error, undefined);
    acc = rest;
    got.push(...messages);
  }
  assert.equal(got.length, 2);
  assert.equal(got[0].result.text, 'café — naïve — 日本語 — 🚀');
  assert.equal(got[1].method, 'ping');
  assert.equal(acc.length, 0, 'the buffer should be empty once both messages are consumed');
});

test('Content-Length counts BYTES, not characters', () => {
  const encoded = encodeMessage({ s: '日本語' }).toString('ascii');
  // 3 chars, 9 bytes. A char-counting implementation would truncate the JSON.
  const declared = Number(/Content-Length: (\d+)/.exec(encoded)[1]);
  assert.equal(declared, Buffer.byteLength(JSON.stringify({ s: '日本語' }), 'utf8'));
  const { messages } = decodeMessages(encodeMessage({ s: '日本語' }));
  assert.equal(messages[0].s, '日本語');
});

test('a header with no Content-Length, and an absurd one, are refused rather than buffered', () => {
  const noLength = decodeMessages(Buffer.from('X-Whatever: 1\r\n\r\n{}', 'utf8'));
  assert.match(noLength.error, /no Content-Length/);

  const absurd = decodeMessages(Buffer.from(`Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`, 'utf8'));
  assert.match(absurd.error, /refusing a \d+-byte message/);

  // And a header that never terminates must not grow forever.
  const runaway = decodeMessages(Buffer.alloc(9_000, 0x41));
  assert.match(runaway.error, /no message header in the first 8KB/);
});

test('one unparseable body does not desynchronise the stream', () => {
  // The framing said exactly where the bad body ended, so the next message is
  // still findable — losing the whole connection over one bad message would be
  // an over-reaction with a real cost.
  const bad = Buffer.concat([Buffer.from('Content-Length: 3\r\n\r\n', 'ascii'), Buffer.from('{"{', 'utf8')]);
  const good = encodeMessage({ jsonrpc: '2.0', id: 7, result: 'fine' });
  const { messages, error } = decodeMessages(Buffer.concat([bad, good]));
  assert.equal(error, undefined);
  assert.equal(messages.length, 2);
  assert.ok(messages[0].__parseError, 'the bad body should be reported, not thrown');
  assert.equal(messages[1].result, 'fine');
});

// ───────────────────────────────────────────────────────────────────────────
// DISCOVERY AND REFUSALS
// ───────────────────────────────────────────────────────────────────────────

test('language and languageId are not the same thing (.tsx is typescriptreact)', () => {
  assert.equal(languageForFile('app/page.tsx'), 'typescript');
  assert.equal(languageIdForFile('app/page.tsx'), 'typescriptreact');
  assert.equal(languageIdForFile('lib/x.mts'), 'typescript');
  assert.equal(languageForFile('main.rs'), 'rust');
  assert.equal(languageForFile('README.md'), null);
  assert.equal(languageForFile(''), null);
});

test('an unconfigured language refuses by naming what IS configured', () => {
  const r = discoverLanguageServer(ws(), 'cobol');
  assert.equal(r.ok, false);
  assert.match(r.error, /typescript/);
  assert.match(r.error, /search_text/, 'the refusal must name the fallback, or the model just retries');
});

test('a missing server says "not installed", how to install it, and what to do instead — and never throws', () => {
  const root = ws();
  // Nothing is installed under a fresh temp dir. If the machine happens to have
  // a global pyright this becomes a pass-through, so the assertion is guarded
  // rather than skipped silently.
  const r = discoverLanguageServer(root, 'python');
  if (r.ok) {
    assert.ok(r.file, 'a discovered server must name a file to spawn');
    return;
  }
  assert.equal(r.missing, true);
  assert.match(r.error, /npm i -D pyright/);
  assert.match(r.error, /search_text/);
  assert.match(r.error, /do not call this tool again/i);
});

test('resolveOnPath never throws on a junk PATH', () => {
  const r = resolveOnPath('definitely-not-a-real-binary-xyz', { PATH: `${join(tmpdir(), 'nope')}${process.platform === 'win32' ? ';' : ':'}` });
  assert.equal(r, null);
});

/** A session object with no child process behind it: enough to drive the pure
 *  half of every query and count what would have gone on the wire. */
function stubSession(root, reply = () => ({ result: null })) {
  const sent = [];
  return {
    ok: true, label: 'stub', root, stopped: false,
    docs: new Map(), published: new Map(), waiters: new Map(), seq: 0,
    capabilities: {},
    rpc: {
      request: async (method, params) => { sent.push({ method, params }); return reply(method, params); },
      notify: (method, params) => { sent.push({ method, params }); },
    },
    sent,
  };
}

test('a path outside the workspace is refused BEFORE anything reaches the server', async () => {
  const root = ws();
  const session = stubSession(root);
  const r = await definition(root, '../../evil.ts', 3, 1, { session });
  assert.equal(r.ok, false);
  assert.match(r.error, /escapes the workspace/);
  assert.equal(session.sent.length, 0, 'nothing may be sent for a path we refused');
});

test('an absolute path and a UNC path are refused too', async () => {
  const root = ws();
  for (const bad of ['C:/Windows/win.ini', '/etc/passwd', '//server/share/x.ts']) {
    const session = stubSession(root);
    const r = await documentSymbols(root, bad, { session });
    assert.equal(r.ok, false, `${bad} should be refused`);
    assert.equal(session.sent.length, 0);
  }
});

test('positions are 1-based and a 0 is refused, not silently accepted', async () => {
  // ⚠️ THE OFF-BY-ONE THAT LOOKS LIKE SUCCESS. Passing a 0-based line through
  // usually still resolves to *something*, so the wrong answer arrives looking
  // right. Refusing the impossible value is the only place it can be caught.
  const root = ws();
  writeFileSync(join(root, 'a.ts'), 'const x = 1;\n', 'utf8');
  for (const bad of [0, -1, 1.5, 'three', null]) {
    const session = stubSession(root);
    const r = await definition(root, 'a.ts', bad, 1, { session });
    assert.equal(r.ok, false, `line ${JSON.stringify(bad)} should be refused`);
    assert.match(r.error, /1-based/);
    assert.equal(session.sent.length, 0);
  }
  const session = stubSession(root);
  const bad = await references(root, 'a.ts', 2, 0, { session });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /column must be/);
});

test('line 1 column 1 becomes LSP 0,0 — the conversion happens exactly once', async () => {
  const root = ws();
  writeFileSync(join(root, 'a.ts'), 'const x = 1;\n', 'utf8');
  const session = stubSession(root);
  await definition(root, 'a.ts', 12, 5, { session });
  const req = session.sent.find((s) => s.method === 'textDocument/definition');
  assert.deepEqual(req.params.position, { line: 11, character: 4 });
});

// ───────────────────────────────────────────────────────────────────────────
// TOKEN COST — the caps, and saying so
// ───────────────────────────────────────────────────────────────────────────

test('references are capped, and the note says the real total and forbids treating it as complete', async () => {
  const root = ws();
  const lines = Array.from({ length: 200 }, (_, i) => `  useThing(${i});`).join('\n');
  writeFileSync(join(root, 'big.ts'), lines, 'utf8');
  const uri = pathToFileURL(join(root, 'big.ts')).href;
  const session = stubSession(root, (method) => {
    if (method !== 'textDocument/references') return { result: null };
    return {
      result: Array.from({ length: 118 }, (_, i) => ({
        uri, range: { start: { line: i, character: 2 }, end: { line: i, character: 10 } },
      })),
    };
  });

  const r = await references(root, 'big.ts', 1, 3, { session });
  assert.equal(r.ok, true);
  assert.equal(r.count, 118, 'the TRUE total must survive truncation');
  assert.equal(r.shown, MAX_LOCATIONS);
  assert.equal(r.locations.length, MAX_LOCATIONS);
  assert.equal(r.truncated, true);
  assert.match(r.note, /showing 25 of 118/);
  assert.match(r.note, /not treat this list as exhaustive/i);

  // And the rendered form a model actually reads must carry the warning too —
  // the note is worthless if the formatter drops it.
  assert.match(formatLspForModel(r), /showing 25 of 118/);
});

test('an excerpt is one trimmed line from the real file, clamped', async () => {
  const root = ws();
  const long = `const ${'a'.repeat(400)} = 1;`;
  writeFileSync(join(root, 'x.ts'), `import y from './y';\n   const spaced = 1;\n${long}\n`, 'utf8');
  const uri = pathToFileURL(join(root, 'x.ts')).href;
  const session = stubSession(root, () => ({
    result: [
      { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
      { uri, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } },
    ],
  }));
  const r = await references(root, 'x.ts', 1, 1, { session });
  assert.equal(r.locations[0].line, 2, 'LSP line 1 is our line 2');
  assert.equal(r.locations[0].excerpt, 'const spaced = 1;', 'leading whitespace is pure cost');
  assert.ok(r.locations[1].excerpt.length <= EXCERPT_MAX_CHARS + 1);
  assert.ok(r.locations[1].excerpt.endsWith('…'), 'a clamped excerpt must say so');
  assert.equal(r.locations[0].path, 'x.ts');
  assert.equal(r.locations[0].inWorkspace, true);
});

test('a definition outside the workspace is reported, not hidden — but marked', async () => {
  // Jumping into node_modules or lib.dom.d.ts is the CORRECT answer; refusing it
  // would make the tool useless for exactly the questions grep cannot answer.
  const root = ws();
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
  const outside = join(tmpdir(), 'elsewhere-lib.d.ts');
  writeFileSync(outside, 'declare const a: number;\n', 'utf8');
  const session = stubSession(root, () => ({
    result: { uri: pathToFileURL(outside).href, range: { start: { line: 0, character: 14 }, end: { line: 0, character: 15 } } },
  }));
  const r = await definition(root, 'a.ts', 1, 14, { session });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.locations[0].inWorkspace, false);
  assert.ok(r.locations[0].path.includes('elsewhere-lib.d.ts'));
  rmSync(outside, { force: true });
});

test('an empty definition result explains the likely cause instead of just saying none', async () => {
  const root = ws();
  writeFileSync(join(root, 'a.ts'), 'const x = 1;\n', 'utf8');
  const session = stubSession(root, () => ({ result: null }));
  const r = await definition(root, 'a.ts', 1, 1, { session });
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.match(r.note, /Check the position is on the symbol itself/);
});

test('both symbol response shapes are understood — flat SymbolInformation and hierarchical', async () => {
  const root = ws();
  writeFileSync(join(root, 's.ts'), 'class Widget {\n  render() {\n    return 1;\n  }\n}\n', 'utf8');
  const uri = pathToFileURL(join(root, 's.ts')).href;

  const hierarchical = stubSession(root, () => ({
    result: [{
      name: 'Widget', kind: 5,
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
      children: [{ name: 'render', kind: 6, range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } } }],
    }],
  }));
  const a = await documentSymbols(root, 's.ts', { session: hierarchical });
  assert.deepEqual(a.symbols.map((s) => [s.name, s.kind, s.line, s.depth]), [['Widget', 'class', 1, 0], ['render', 'method', 2, 1]]);

  const flat = stubSession(root, () => ({
    result: [
      { name: 'Widget', kind: 5, location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } } } },
      { name: 'render', kind: 6, location: { uri, range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } } } },
    ],
  }));
  const b = await documentSymbols(root, 's.ts', { session: flat });
  assert.deepEqual(b.symbols.map((s) => s.name), ['Widget', 'render'], 'the flat shape must not produce an empty outline');
});

test('the tool schemas match the dispatcher, and every one is required-complete', () => {
  const schemas = lspToolSchemas();
  assert.deepEqual(schemas.map((s) => s.function.name), LSP_TOOL_NAMES);
  for (const s of schemas) {
    assert.equal(s.type, 'function');
    assert.ok(s.function.description.length > 80, `${s.function.name} needs a description a router can choose on`);
    for (const req of s.function.parameters.required) {
      assert.ok(s.function.parameters.properties[req], `${s.function.name}.${req} is required but not declared`);
    }
  }
});

test('runLspTool refuses a name it does not own instead of doing something plausible', async () => {
  const r = await runLspTool(ws(), 'rename_symbol', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /not an lsp tool/);
});

// ───────────────────────────────────────────────────────────────────────────
// REAL CHILD PROCESSES
// ───────────────────────────────────────────────────────────────────────────

test('end to end against a real child: handshake, definition, references, symbols', async (t) => {
  const root = ws();
  const src = [
    'export function target() {',   // line 1
    '  return 1;',                  // 2
    '}',                            // 3
    'const a = target(); // DEF',    // 4
    'const b = target();',          // 5
  ].join('\n');
  writeFileSync(join(root, 'main.ts'), `${src}\n`, 'utf8');

  const session = await startLanguageServer(root, { language: 'typescript', server: fakeServerIn(root, 'normal') });
  t.after(() => stopLanguageServer(session));
  assert.equal(session.ok, true, session.error);

  const def = await definition(root, 'main.ts', 5, 11, { session });
  assert.equal(def.ok, true);
  assert.equal(def.count, 1);
  assert.equal(def.locations[0].line, 4);
  assert.equal(def.locations[0].excerpt, 'const a = target(); // DEF', 'a LocationLink must be unwrapped like a Location');

  const refs = await references(root, 'main.ts', 1, 17, { session });
  assert.equal(refs.count, 3);
  assert.equal(refs.truncated, false);
  assert.equal(refs.note, null);

  const syms = await documentSymbols(root, 'main.ts', { session });
  assert.deepEqual(syms.symbols.map((s) => s.name), ['Widget', 'render']);
});

test('a server that BLOCKS on a client request still initializes — because we answer it', async (t) => {
  // ⚠️ The hang that looks exactly like a slow project scan. Without the
  // server-request responder this test times out after 30 seconds.
  const root = ws();
  writeFileSync(join(root, 'a.ts'), 'const x = 1;\n', 'utf8');
  const session = await startLanguageServer(root, {
    language: 'typescript',
    server: fakeServerIn(root, 'needs-registration'),
    handshakeTimeoutMs: 8_000,
  });
  t.after(() => stopLanguageServer(session));
  assert.equal(session.ok, true, session.error);
});

test('a dribbling server — one byte per tick, multi-byte payload — is decoded correctly', async (t) => {
  const root = ws();
  writeFileSync(join(root, 'café.ts'), 'const naïve = 1; // DEF\nconst y = 2;\n', 'utf8');
  const session = await startLanguageServer(root, {
    language: 'typescript',
    server: fakeServerIn(root, 'dribble'),
    handshakeTimeoutMs: 15_000,
  });
  t.after(() => stopLanguageServer(session));
  assert.equal(session.ok, true, session.error);

  const def = await definition(root, 'café.ts', 1, 7, { session });
  assert.equal(def.ok, true);
  assert.equal(def.locations[0].excerpt, 'const naïve = 1; // DEF');
});

test('a server that dies at startup is data, not an exception — and its stderr is quoted', async () => {
  const root = ws();
  const session = await startLanguageServer(root, { language: 'typescript', server: fakeServerIn(root, 'die'), handshakeTimeoutMs: 6_000 });
  assert.equal(session.ok, false);
  assert.match(session.error, /Cannot find module/, 'the real complaint arrives on stderr and nowhere else');
});

test('a silent server times out AND leaves no process behind', async () => {
  const root = ws();
  const spawned = [];
  const session = await startLanguageServer(root, {
    language: 'typescript',
    server: fakeServerIn(root, 'silent'),
    handshakeTimeoutMs: 1_200,
    spawnImpl: (...args) => {
      const child = realSpawn(...args);
      spawned.push(child);
      return child;
    },
  });
  assert.equal(session.ok, false);
  assert.match(session.error, /did not initialize/);
  assert.equal(spawned.length, 1);
  assert.equal(await waitForExit(spawned[0]), true, 'a server that never answered must still be dead');
});

test('⚠️ a server that refuses to shut down is killed — WITH ITS GRANDCHILD', async () => {
  // The whole reason this module has a tree kill. `child.kill()` reaches the
  // wrapper and orphans the expensive process, which is what has been cooking
  // this laptop.
  const root = ws();
  writeFileSync(join(root, 'a.ts'), 'const x = 1;\n', 'utf8');

  let grandPid = null;
  const session = await startLanguageServer(root, { language: 'typescript', server: fakeServerIn(root, 'hang-shutdown'), handshakeTimeoutMs: 8_000 });
  assert.equal(session.ok, true, session.error);
  for (let i = 0; i < 60 && grandPid === null; i += 1) {
    const m = /grandchild=(\d+)/.exec(session.stderr ?? '');
    if (m) grandPid = Number(m[1]);
    else await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(grandPid, 'the fake server should have reported its grandchild pid');
  assert.equal(alive(grandPid), true, 'the grandchild should be running before we stop anything');

  const stopped = await stopLanguageServer(session, { graceMs: 600 });
  assert.equal(stopped.graceful, false, 'this server ignores shutdown by design');
  assert.equal(await waitForExit(session.child), true, 'the server itself must die');

  // taskkill is asynchronous; poll rather than asserting on the instant.
  let gone = false;
  for (let i = 0; i < 100 && !gone; i += 1) {
    gone = !alive(grandPid);
    if (!gone) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(gone, true, `grandchild ${grandPid} survived the shutdown — that is the orphan this module exists to prevent`);
});

test('stopping twice is safe, and stopAllLanguageServers reports what it closed', async () => {
  const root = ws();
  const session = await startLanguageServer(root, { language: 'typescript', server: fakeServerIn(root, 'normal'), handshakeTimeoutMs: 8_000 });
  assert.equal(session.ok, true, session.error);
  const first = await stopLanguageServer(session);
  assert.equal(first.ok, true);
  const second = await stopLanguageServer(session);
  assert.equal(second.alreadyStopped, true);
  assert.equal(await stopAllLanguageServers(), 0);
});

// ───────────────────────────────────────────────────────────────────────────
// DIAGNOSTICS — the honesty tests
// ───────────────────────────────────────────────────────────────────────────

test('diagnostics wait past the empty first publish, and re-reading a CHANGED file re-measures it', async (t) => {
  const root = ws();
  const file = join(root, 'code.ts');
  writeFileSync(file, 'const ok = 1;\nconst BAD = 2;\n', 'utf8');

  const session = await startLanguageServer(root, { language: 'typescript', server: fakeServerIn(root, 'normal'), handshakeTimeoutMs: 8_000 });
  t.after(() => stopLanguageServer(session));
  assert.equal(session.ok, true, session.error);

  const first = await diagnostics(root, 'code.ts', { session, diagnosticsTimeoutMs: 5_000 });
  assert.equal(first.ok, true);
  // ⚠️ If this is 0, the client took the empty publish tsserver sends on open.
  assert.equal(first.counts.error, 1, 'the empty first publish must not be mistaken for a clean file');
  assert.equal(first.items[0].line, 2);
  assert.equal(first.items[0].excerpt, 'const BAD = 2;');
  assert.equal(first.items[0].code, 'TS9999');

  // ⭐ THE STALE-DOCUMENT TEST. The agent rewrites the file between calls; a
  // client that does not send didChange answers from the previous version and
  // is confidently wrong.
  writeFileSync(file, 'const ok = 1;\nconst BAD = 2;\nconst ALSO_BAD = 3;\n', 'utf8');
  const second = await diagnostics(root, 'code.ts', { session, diagnosticsTimeoutMs: 5_000 });
  assert.equal(second.counts.error, 2, 'the second answer described the file before the edit');
  assert.deepEqual(second.items.map((d) => d.line), [2, 3]);
});

test('⚠️ a server that never publishes is an ERROR, never "no problems"', async (t) => {
  // The most dangerous lie available to this module: a model told the file is
  // clean stops looking. "Nothing was measured" is a different fact and has to
  // read like one.
  const root = ws();
  writeFileSync(join(root, 'q.ts'), 'const BAD = 1;\n', 'utf8');
  const session = await startLanguageServer(root, { language: 'typescript', server: fakeServerIn(root, 'no-diagnostics'), handshakeTimeoutMs: 8_000 });
  t.after(() => stopLanguageServer(session));
  assert.equal(session.ok, true, session.error);

  const r = await diagnostics(root, 'q.ts', { session, diagnosticsTimeoutMs: 700, quietMs: 50 });
  assert.equal(r.ok, false);
  assert.match(r.error, /NOT the same as "no problems"/);
  assert.match(r.error, /run_command/, 'a refusal has to name what to do instead');
});

test('a directory, a missing file and a binary file are refused with the reason, not a crash', async () => {
  const root = ws();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'bin.ts'), Buffer.from([0x66, 0x00, 0x6f]));
  const session = stubSession(root);

  const dir = await documentSymbols(root, 'src', { session });
  assert.equal(dir.ok, false);
  assert.match(dir.error, /no language server handles/);

  const missing = await documentSymbols(root, 'nope.ts', { session });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no such file/);

  const binary = await documentSymbols(root, 'bin.ts', { session });
  assert.equal(binary.ok, false);
  assert.match(binary.error, /looks binary/);
  assert.equal(session.sent.length, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// THE REAL SERVER — skipped when it is not installed, which is the normal case
// ───────────────────────────────────────────────────────────────────────────

const realTs = discoverLanguageServer(process.cwd(), 'typescript');

test('the real typescript-language-server answers definition, references and diagnostics', {
  skip: realTs.ok ? false : `typescript-language-server is not installed here (${realTs.error.slice(0, 60)}…)`,
  timeout: 120_000,
}, async (t) => {
  const root = ws();
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }), 'utf8');
  writeFileSync(join(root, 'lib.ts'), 'export function greet(name: string) {\n  return `hi ${name}`;\n}\n', 'utf8');
  writeFileSync(join(root, 'app.ts'), "import { greet } from './lib';\n\nconst a = greet('x');\nconst b = greet(42);\n", 'utf8');

  const session = await startLanguageServer(root, { language: 'typescript' });
  t.after(() => stopLanguageServer(session));
  assert.equal(session.ok, true, session.error);

  const def = await definition(root, 'app.ts', 3, 11, { session });
  assert.equal(def.ok, true);
  assert.ok(def.locations.some((l) => l.path === 'lib.ts'), JSON.stringify(def));

  const bad = await diagnostics(root, 'app.ts', { session });
  assert.equal(bad.ok, true);
  assert.ok(bad.counts.error >= 1, `expected the number-passed-as-string error, got ${JSON.stringify(bad)}`);
});
