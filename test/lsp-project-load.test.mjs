/**
 * ── ⭐⭐ THE COLD LANGUAGE SERVER ANSWERED CONFIDENTLY AND WRONGLY ───────────
 *
 * Shipped in 0.6.19: `find_references` on a freshly-started
 * `typescript-language-server` returned **2 references in 1 file** when the
 * truth was 8 in 3, and `find_definition` for an imported symbol pointed at the
 * import line in the ASKING file instead of the file that declares it. No
 * truncation flag, no note, no error — the answers looked complete. A model told
 * "this symbol has 2 references" before changing it breaks a codebase.
 *
 * ⚠️ AND SAMPLING CANNOT FIX IT, WHICH IS WHY THE GATE HAD TO BE A SIGNAL.
 * Driven against the real server on a 4-file fixture, the SAME session answered
 * `2` and then `5` — the wrong answer is stable for seconds and then wrong in a
 * different way, so "ask twice and accept a match" returns the wrong one twice.
 *
 * ── WHAT THE TESTS BELOW ACTUALLY PIN ───────────────────────────────────────
 * The fake server here is not a stub that returns a fixed list. It reproduces
 * the PATHOLOGY: it answers `COLD_REFS` until it has sent `$/progress end` and
 * `WARM_REFS` afterwards, exactly like tsserver loading a project. So deleting
 * the gate does not make these tests fail on a technicality — it makes them
 * report the wrong number, which is the defect itself.
 *
 * ⭐ EVERY ONE OF THESE WAS MUTATION-CHECKED. Removing the `awaitProjectLoad`
 * call from `references` turns test 1 red with `2 !== 8`; flipping
 * `window.workDoneProgress` back to `false` turns tests 1, 2 and 9 red;
 * dropping the `created`-token check turns test 7 red; and making
 * `hasProjectConfig` return `false` unconditionally turns test 4's latency
 * assertion green but test 1 red, because the gate stops waiting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startLanguageServer, stopLanguageServer,
  definition, references, documentSymbols,
  awaitProjectLoad, hasProjectConfig,
  LANGUAGE_SERVERS, PROJECT_LOAD_SIGNAL_MS,
  discoverLanguageServer,
} from '../lib/lsp.mjs';

/** The counts the fake serves before and after it says the project is loaded.
 *  Chosen to match the real measurement so a failure reads like the bug. */
const COLD_REFS = 2;
const WARM_REFS = 8;

/**
 * ── THE FAKE SERVER ─────────────────────────────────────────────────────────
 * Written to disk rather than committed, matching `lsp.test.mjs`. Its framing is
 * implemented independently of `lsp.mjs`'s so a round trip is not one bug
 * agreeing with itself.
 *
 * Modes:
 *   `normal`      — create → begin → (load-ms) → end. The real sequence.
 *   `no-progress` — never mentions progress at all. tsserver's shape when there
 *                   is no configured project for the file: the answer is real,
 *                   permanently partial, and waiting changes nothing.
 *   `never-ends`  — begin, and no end, ever. The wedged load.
 *   `stray`       — sends a `$/progress begin`/`end` pair for a token it never
 *                   asked us to create. Must NOT satisfy the gate.
 */
const FAKE = String.raw`
import { readFileSync } from 'node:fs';
const arg = (n, d) => { const f = process.argv.find((a) => a.startsWith('--' + n + '=')); return f ? f.slice(n.length + 3) : d; };
const MODE = arg('mode', 'normal');
const LOAD_MS = Number(arg('load-ms', '300'));
const COLD = Number(arg('cold', '2'));
const WARM = Number(arg('warm', '8'));

let loaded = false;
let buffer = Buffer.alloc(0);
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]));
}

const TOKEN = 'tok-load-1';
function beginLoad() {
  if (MODE === 'no-progress') return;
  if (MODE === 'stray') {
    // No window/workDoneProgress/create — a token we invented. A client that
    // counts this has a gate that any unrelated progress can satisfy.
    send({ jsonrpc: '2.0', method: '$/progress', params: { token: 'stray-token', value: { kind: 'begin', title: 'something else' } } });
    setTimeout(() => send({ jsonrpc: '2.0', method: '$/progress', params: { token: 'stray-token', value: { kind: 'end' } } }), 20);
    return;
  }
  send({ jsonrpc: '2.0', id: 8001, method: 'window/workDoneProgress/create', params: { token: TOKEN } });
  send({ jsonrpc: '2.0', method: '$/progress', params: { token: TOKEN, value: { kind: 'begin', title: 'Initializing JS/TS language features…' } } });
  if (MODE === 'never-ends') return;
  setTimeout(() => {
    loaded = true;
    send({ jsonrpc: '2.0', method: '$/progress', params: { token: TOKEN, value: { kind: 'end' } } });
  }, LOAD_MS);
}

const docs = new Map();
let opened = false;

function handle(msg) {
  if (msg.method === 'initialize') {
    // ⭐ Echo the client's capabilities back so a test can assert what we
    // actually advertised — the one boolean that caused the whole defect.
    return send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { referencesProvider: true, __clientCaps: msg.params.capabilities } } });
  }
  if (msg.method === 'shutdown') return send({ jsonrpc: '2.0', id: msg.id, result: null });
  if (msg.method === 'exit') return process.exit(0);
  if (msg.method === 'textDocument/didOpen') {
    docs.set(msg.params.textDocument.uri, msg.params.textDocument.text);
    if (!opened) { opened = true; setTimeout(beginLoad, 10); }
    return;
  }
  if (msg.method === 'textDocument/didChange') { docs.set(msg.params.textDocument.uri, msg.params.contentChanges[0].text); return; }
  if (msg.method === 'textDocument/references') {
    const uri = msg.params.textDocument.uri;
    const n = loaded ? WARM : COLD;
    const out = [];
    for (let i = 0; i < n; i += 1) out.push({ uri, range: { start: { line: i % 4, character: 2 }, end: { line: i % 4, character: 8 } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: out });
  }
  if (msg.method === 'textDocument/definition') {
    const uri = msg.params.textDocument.uri;
    // Cold: the asking file. Warm: the file that really declares it.
    const target = loaded ? uri.replace(/asks\.ts$/, 'declares.ts') : uri;
    return send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: target, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } } }] });
  }
  if (msg.method === 'textDocument/documentSymbol') {
    return send({ jsonrpc: '2.0', id: msg.id, result: [
      { name: 'alpha', kind: 13, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } }, selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } } },
    ] });
  }
  if (msg.id !== undefined && msg.method) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const at = buffer.indexOf('\r\n\r\n');
    if (at === -1) return;
    const len = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, at).toString('ascii'))[1]);
    if (buffer.length < at + 4 + len) return;
    const msg = JSON.parse(buffer.subarray(at + 4, at + 4 + len).toString('utf8'));
    buffer = buffer.subarray(at + 4 + len);
    handle(msg);
  }
});
`;

/**
 * A workspace with two source files and, by default, a `tsconfig.json` — which
 * is not decoration: its presence is what tells the gate a configured project
 * exists and is therefore worth waiting for.
 */
function makeWs(t, { tsconfig = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-lspload-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'asks.ts'), "import { alpha } from './declares';\nexport const out = alpha + alpha;\n", 'utf8');
  writeFileSync(join(root, 'src', 'declares.ts'), "export const alpha = 'a';\n", 'utf8');
  if (tsconfig) writeFileSync(join(root, 'tsconfig.json'), '{"include":["src"]}', 'utf8');
  writeFileSync(join(root, 'fake-lsp.mjs'), FAKE, 'utf8');
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows lock */ } });
  return root;
}

function fakeServer(root, mode = 'normal', loadMs = 300) {
  return {
    ok: true,
    label: `fake-lsp(${mode})`,
    file: process.execPath,
    argv: [join(root, 'fake-lsp.mjs'), `--mode=${mode}`, `--load-ms=${loadMs}`, `--cold=${COLD_REFS}`, `--warm=${WARM_REFS}`],
    via: join(root, 'fake-lsp.mjs'),
  };
}

/** Start a session against the fake and guarantee it dies. */
async function session(t, root, mode = 'normal', loadMs = 300) {
  const s = await startLanguageServer(root, { language: 'typescript', server: fakeServer(root, mode, loadMs) });
  assert.equal(s.ok, true, s.error);
  t.after(() => stopLanguageServer(s));
  return s;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1–2. THE DEFECT ITSELF
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ find_references waits for the project and returns the REAL count, not the cold one', async (t) => {
  const root = makeWs(t);
  const s = await session(t, root, 'normal', 400);
  const r = await references(root, 'src/asks.ts', 2, 20, { session: s });
  assert.equal(r.ok, true, r.error);
  assert.equal(
    r.count, WARM_REFS,
    `this is the shipped defect: ${COLD_REFS} of ${WARM_REFS} references, reported with no warning. A model that believes it will change a symbol it has not checked.`,
  );
  assert.equal(r.note, null, 'a correct, complete answer must not be decorated with a scare note');
});

test('⭐ find_definition stops naming the asking file and names the declaring one', async (t) => {
  const root = makeWs(t);
  const s = await session(t, root, 'normal', 400);
  const d = await definition(root, 'src/asks.ts', 1, 10, { session: s });
  assert.equal(d.ok, true, d.error);
  assert.equal(
    d.locations[0].path, 'src/declares.ts',
    'cold, the server answers with the import line in the file you asked from — which reads as a perfectly good "go to definition" result',
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3–5. THE THREE STATES, AND THE TWO THAT ARE NOT "READY"
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ a load that never finishes is REFUSED, not answered', async (t) => {
  const root = makeWs(t);
  const s = await session(t, root, 'never-ends');
  const started = Date.now();
  const r = await references(root, 'src/asks.ts', 2, 20, { session: s, loadTimeoutMs: 600 });
  assert.equal(r.ok, false, `it answered ${r.count} instead of admitting it did not know`);
  assert.match(r.error, /still loading/i);
  // ⚠️ A refusal that does not say what to do instead is a refusal that gets
  // retried in a loop. Both escapes have to be named.
  assert.match(r.error, /search_text/, 'name the tool that still works');
  assert.match(r.error, /find_references again/, 'and say the retry is worth it, because the load happens once');
  assert.ok(Date.now() - started >= 500, 'it must actually have waited, not refused instantly');
});

test('⚠️ no configured project → the answer is given WITH the reason it may be short', async (t) => {
  const root = makeWs(t, { tsconfig: false });
  const s = await session(t, root, 'no-progress');
  const started = Date.now();
  const r = await references(root, 'src/asks.ts', 2, 20, { session: s });
  const elapsed = Date.now() - started;
  assert.equal(r.ok, true, 'this answer is real — it is just scoped, and refusing it would delete the feature for every repo without a tsconfig');
  assert.equal(r.count, COLD_REFS);
  assert.match(r.note, /INCOMPLETE/);
  assert.match(r.note, /tsconfig\.json/, 'name the thing whose absence caused it');
  assert.match(r.note, /search_text/);
  /**
   * ⭐ THE LATENCY HALF, AND IT IS THE REASON THE FILESYSTEM CHECK EXISTS.
   * Without it this case waits the full signal window on the first query of
   * every tsconfig-less repo, for a signal that provably never comes.
   */
  assert.ok(
    elapsed < PROJECT_LOAD_SIGNAL_MS / 2,
    `took ${elapsed}ms; with no config file above it there is nothing to wait FOR, so this must not pay the signal window (${PROJECT_LOAD_SIGNAL_MS}ms)`,
  );
});

test('⚠️ a tsconfig that never produces a load signal is warned about, not refused forever', async (t) => {
  const root = makeWs(t); // tsconfig present…
  const s = await session(t, root, 'no-progress'); // …but the server never reports one
  const r = await references(root, 'src/asks.ts', 2, 20, { session: s, loadSignalMs: 250 });
  assert.equal(r.ok, true, 'a file outside the tsconfig include has permanent inferred scope — refusing it would never clear');
  assert.match(r.note, /INCOMPLETE/);
  assert.match(r.note, /include/, 'and the reason differs from the no-config case, so the note must too');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6–8. THE PROPERTIES THAT KEEP IT CHEAP AND HONEST
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ once loaded, the gate costs nothing — every later call is a set-size test', async (t) => {
  const root = makeWs(t);
  const s = await session(t, root, 'normal', 400);
  await references(root, 'src/asks.ts', 2, 20, { session: s });   // pays the load
  const started = Date.now();
  for (let i = 0; i < 5; i += 1) {
    const r = await references(root, 'src/asks.ts', 2, 20, { session: s });
    assert.equal(r.count, WARM_REFS);
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `5 warm calls took ${elapsed}ms; a gate that re-waits per call would make semantic navigation slower than grep`);
});

test('⚠️ progress the server never asked us to create does NOT satisfy the gate', async (t) => {
  const root = makeWs(t);
  const s = await session(t, root, 'stray');
  /**
   * ⭐ `$/progress` is a general channel — a server can report progress on a
   * long request, an index refresh, anything. A gate armed by ANY progress is a
   * gate that means something different on the next server and silently stops
   * gating. Only a token introduced by `window/workDoneProgress/create` counts.
   */
  const r = await references(root, 'src/asks.ts', 2, 20, { session: s, loadSignalMs: 300 });
  assert.equal(r.ok, true);
  assert.match(
    String(r.note), /INCOMPLETE/,
    'the stray begin/end pair must have been ignored — if it counted, this would have been reported as a clean, complete answer',
  );
});

test('⭐ list_symbols is NOT gated — it is syntactic, and gating it would only add latency', async (t) => {
  const root = makeWs(t);
  const s = await session(t, root, 'never-ends'); // a load that never finishes
  const started = Date.now();
  const r = await documentSymbols(root, 'src/asks.ts', { session: s });
  assert.equal(r.ok, true, 'measured against the real server: documentSymbol returns the same answer before and after the project loads');
  assert.equal(r.count, 1);
  assert.ok(Date.now() - started < 500, 'it answered without waiting for a load it does not need');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 9. THE ROOT CAUSE — one boolean in our own handshake
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ the client MUST advertise window.workDoneProgress — that flag is the subscription', async (t) => {
  const root = makeWs(t);
  const s = await session(t, root, 'normal', 100);
  /**
   * ⚠️ THIS IS THE WHOLE BUG IN ONE ASSERTION. `vscode-languageserver` hands the
   * server a null progress reporter when the client says false, so the loading
   * indicator's begin/end is discarded before it reaches the wire. A previous
   * session measured that "the signal never arrives" and recorded it as a dead
   * end — while this file was the thing declining it.
   */
  assert.equal(
    s.capabilities.__clientCaps?.window?.workDoneProgress, true,
    'with this false the server sends no $/progress, the gate never fires, and find_references silently under-reports again',
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * 10. THE UNITS, AND THE SERVERS WE HAVE NOT MEASURED
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ only typescript is gated — an unmeasured signal must not become a stall', () => {
  assert.ok(LANGUAGE_SERVERS.typescript.projectLoad, 'typescript is the one that was driven on a real fixture');
  for (const language of ['python', 'rust', 'go']) {
    assert.equal(
      LANGUAGE_SERVERS[language].projectLoad, undefined,
      `${language}'s progress semantics have not been measured here; arming a correctness gate on a guess trades a known wrong answer for an unknown hang`,
    );
  }
});

test('⚠️ the gate never throws and never blocks a session it does not understand', async () => {
  // A test stub with no progress bookkeeping, and a language with no plan.
  assert.deepEqual(await awaitProjectLoad({ language: 'typescript' }, 'x.ts'), { state: 'unsupported', waitedMs: 0 });
  assert.deepEqual(await awaitProjectLoad({ language: 'rust', load: {} }, 'x.rs'), { state: 'unsupported', waitedMs: 0 });
  assert.deepEqual(await awaitProjectLoad(undefined, 'x.ts'), { state: 'unsupported', waitedMs: 0 });
});

test('⭐ hasProjectConfig is biased toward YES, because a wrong NO is the shipped bug', (t) => {
  const root = makeWs(t);
  assert.equal(hasProjectConfig(join(root, 'src', 'asks.ts'), ['tsconfig.json']), true, 'a config one level up counts — that is the normal layout');
  assert.equal(hasProjectConfig(join(root, 'src', 'asks.ts'), ['jsconfig.json']), false);
  assert.equal(hasProjectConfig(join(root, 'src', 'asks.ts'), ['tsconfig.json', 'jsconfig.json']), true, 'either one is enough');
  // ⚠️ Every degenerate input answers YES: the cost of a wrong yes is a wait
  // that ends when the server says so; the cost of a wrong no is a wrong answer.
  assert.equal(hasProjectConfig(undefined, ['tsconfig.json']), true);
  assert.equal(hasProjectConfig(join(root, 'src', 'asks.ts'), []), true);
  assert.equal(hasProjectConfig(join(root, 'src', 'asks.ts'), null), true);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 11. THE REAL SERVER — skipped when it is not installed, which is the norm.
 *
 * ⚠️ A fake proves the CLIENT does what we designed. Only this proves the
 * design matches the server, and getting that wrong is exactly how the defect
 * shipped in the first place.
 * ──────────────────────────────────────────────────────────────────────────── */

const REAL_FIXTURE = 'C:/Users/angus/AppData/Local/Temp/claude/C--Projects-claude-build/d1205aa2-96c9-48ef-baeb-c9ce934ef8ca/scratchpad/renamefix';
const realSkip = !existsSync(join(REAL_FIXTURE, 'src', 'model.ts'))
  ? 'the measured fixture is not on this machine'
  : (!discoverLanguageServer(REAL_FIXTURE, 'typescript').ok ? 'typescript-language-server cannot serve the fixture here' : false);

test('⭐⭐ REAL: a cold typescript-language-server now answers 8/3, not 2/1', { skip: realSkip }, async () => {
  const s = await startLanguageServer(REAL_FIXTURE, { language: 'typescript' });
  assert.equal(s.ok, true, s.error);
  try {
    const r = await references(REAL_FIXTURE, 'src/model.ts', 1, 14, { session: s });
    assert.equal(r.ok, true, r.error);
    const files = new Set(r.locations.map((l) => l.path));
    assert.equal(r.count, 8, 'measured truth for this fixture; 0.6.19 returned 2 here, then 5 on the next call in the same session');
    assert.equal(files.size, 3);
  } finally {
    await stopLanguageServer(s);
  }
});
