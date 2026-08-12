/**
 * ── BACKGROUND PROCESSES — TESTED WITH REAL ONES ───────────────────────────
 *
 * ⚠️ A STUBBED `spawn` CANNOT TEST THE THING THAT MATTERS HERE. The whole
 * feature is about a process that OUTLIVES the call, binds a port, and must be
 * killed even when the run dies badly — none of which a fake child object
 * exercises. So the core tests start a real `node`, bind a real port, probe it
 * over real loopback, and then assert the port is FREE afterwards, which is the
 * only honest way to prove nothing was orphaned.
 *
 * ⭐ It still costs $0.00 and needs no key: the subject is `node`, which is
 * already running this test.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

import {
  startBackground, checkBackground, stopBackground, stopAllBackground,
  listBackground, detectPort, backgroundToolSchemas,
  MAX_BACKGROUND, BACKGROUND_TOOL_NAMES, PORT_PATTERNS,
} from '../lib/background.mjs';

const made = [];
after(() => {
  stopAllBackground();
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-bg-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"bg","version":"1.0.0"}\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  return { root, dryRun: false, readFile: () => null };
}

/** A server that announces its port the way real dev servers do. */
const SERVER = `
import { createServer } from 'node:http';
const s = createServer((_q, r) => { r.writeHead(200); r.end('hello'); });
s.listen(0, '127.0.0.1', () => {
  console.log('ready - local: http://localhost:' + s.address().port);
});
`;

/** Poll until a predicate holds or the deadline passes. No fixed sleeps. */
async function until(fn, { timeoutMs = 15_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Is anything accepting TCP on this port? Used to prove the kill worked. */
function portOpen(port, { timeoutMs = 700 } = {}) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    const done = (v) => { try { sock.destroy(); } catch { /* */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// ── the real thing ─────────────────────────────────────────────────────────

test('a real server starts, announces its port, and answers on loopback', async () => {
  const ex = workspace({ 'server.mjs': SERVER });
  const started = startBackground({ command: 'node server.mjs', executor: ex });
  assert.equal(started.ok, true, started.error);
  assert.match(started.id, /^bg\d+$/);
  assert.equal(typeof started.pid, 'number');
  // ⚠️ The note must tell the model the next move, or it waits for nothing.
  assert.match(started.note, /check_process/);

  const ready = await until(async () => {
    const s = await checkBackground(started.id);
    return s.port !== null && s.probe?.reachable ? s : null;
  });

  assert.ok(ready, 'the server never became reachable');
  assert.equal(ready.running, true);
  assert.equal(ready.probe.status, 200, 'it really served a request');
  assert.match(ready.url, /^http:\/\/localhost:\d+\/$/);
  assert.match(ready.note, /listening/);

  const port = ready.port;
  assert.equal(await portOpen(port), true, 'sanity: the port really is open');

  const stopped = stopBackground(started.id);
  assert.equal(stopped.ok, true);

  // ⚠️⚠️ THE ORPHAN ASSERTION. `command.mjs` records a pid that outlived its
  // parent and ran until reboot on the owner's laptop. A background process is
  // that exact shape, so "we called kill" is not the claim — "nothing is
  // listening any more" is.
  const closed = await until(async () => (await portOpen(port)) === false ? true : null, { timeoutMs: 10_000 });
  assert.ok(closed, `port ${port} is still open after stop_process — the tree was not killed`);
  assert.deepEqual(listBackground(), [], 'and the registry no longer holds it');
});

test('stopAllBackground kills everything — the teardown the exit hooks call', async () => {
  const ex = workspace({ 'server.mjs': SERVER });
  const a = startBackground({ command: 'node server.mjs', executor: ex });
  const b = startBackground({ command: 'node server.mjs', executor: ex });
  assert.equal(a.ok && b.ok, true);

  const up = await until(async () => {
    const sa = await checkBackground(a.id);
    const sb = await checkBackground(b.id);
    return sa.probe?.reachable && sb.probe?.reachable ? [sa.port, sb.port] : null;
  });
  assert.ok(up, 'both servers should have come up');

  stopAllBackground();

  for (const port of up) {
    const closed = await until(async () => (await portOpen(port)) === false ? true : null, { timeoutMs: 10_000 });
    assert.ok(closed, `port ${port} survived stopAllBackground`);
  }
  assert.deepEqual(listBackground(), []);
});

// ── ⚠️ the distinction that stops the model waiting forever ────────────────

test('a process that dies on startup says so, instead of looking like a slow boot', async () => {
  const ex = workspace({ 'boom.mjs': 'console.error("EADDRINUSE: port taken"); process.exit(1);\n' });
  const started = startBackground({ command: 'node boom.mjs', executor: ex });
  assert.equal(started.ok, true);

  const dead = await until(async () => {
    const s = await checkBackground(started.id);
    return s.running === false ? s : null;
  });

  assert.ok(dead, 'it should have exited');
  assert.equal(dead.exitCode, 1);
  assert.match(dead.note, /NOT running/, 'the verdict must be unambiguous');
  assert.match(dead.note, /not a slow start/, 'because waiting politely for a dead process is the failure');
  assert.match(dead.output, /EADDRINUSE/, 'and the reason is carried, not summarised away');
  stopBackground(started.id);
});

// ── bounds and refusals ────────────────────────────────────────────────────

test('the cap refuses and names what is already running', async () => {
  const ex = workspace({ 'idle.mjs': 'setInterval(()=>{},1e9);\n' });
  const ids = [];
  for (let i = 0; i < MAX_BACKGROUND; i += 1) {
    const r = startBackground({ command: 'node idle.mjs', executor: ex });
    assert.equal(r.ok, true, `start ${i + 1} should succeed`);
    ids.push(r.id);
  }
  const over = startBackground({ command: 'node idle.mjs', executor: ex });
  assert.equal(over.ok, false);
  assert.match(over.error, /already running/);
  assert.match(over.error, new RegExp(ids[0]), 'the refusal names an id you can actually stop');
  assert.match(over.error, /stop_process/, 'and names the way out');

  for (const id of ids) stopBackground(id);
});

test('a dry run starts nothing', () => {
  const ex = { ...workspace(), dryRun: true };
  const r = startBackground({ command: 'node server.mjs', executor: ex });
  assert.equal(r.ok, false);
  assert.match(r.error, /dry-run/);
  assert.deepEqual(listBackground(), []);
});

test('the allowlist applies — this is not a second door with weaker locks', () => {
  const ex = workspace();
  const r = startBackground({ command: 'curl http://example.com', executor: ex });
  assert.equal(r.ok, false, 'curl is not on the default allowlist for run_command either');
  assert.deepEqual(listBackground(), []);
});

test('checking or stopping an unknown id explains rather than throws', async () => {
  const missing = await checkBackground('bg999');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no background process/);
  const stop = stopBackground('bg999');
  assert.equal(stop.ok, false);
});

// ── port detection ─────────────────────────────────────────────────────────

test('a full URL wins over a bare number', () => {
  assert.equal(detectPort('ready - local: http://localhost:3001'), 3001);
  assert.equal(detectPort('▲ Next.js 16\n- Local: http://localhost:3000\n'), 3000);
  assert.equal(detectPort('Listening on port 8080'), 8080);
  assert.equal(detectPort('server started :4321'), 4321);
});

test('a version number is not a port', () => {
  // ⚠️ The reason for the >1024 floor: "Next.js 16" and "node v22.17.0" both
  // contain digits near words like "port" in real logs.
  assert.equal(detectPort('▲ Next.js 16'), null);
  assert.equal(detectPort('compiled in 234 ms'), null);
  assert.equal(detectPort(''), null);
  assert.equal(detectPort(null), null);
});

test('PORT_PATTERNS puts the URL form first', () => {
  // Order is load-bearing: a bare-number pattern running first would take the
  // wrong digits out of "http://localhost:3000".
  assert.ok(String(PORT_PATTERNS[0]).includes('localhost'));
});

// ── the schemas ────────────────────────────────────────────────────────────

test('the schemas exist for exactly the three names, and say when to use them', () => {
  const schemas = backgroundToolSchemas();
  assert.deepEqual(schemas.map((s) => s.function.name), BACKGROUND_TOOL_NAMES);

  const start = schemas.find((s) => s.function.name === 'start_process').function.description;
  // ⚠️ A model that does not know WHY this exists will keep using run_command
  // and keep timing out. The description has to name the failure it prevents.
  assert.match(start, /run_command/, 'it must contrast itself with the tool it replaces');
  assert.match(start, /time out/);
  assert.match(start, /killed automatically/, 'and promise the cleanup, so it is not afraid to start one');
});

// ── ⚠️⚠️ the crash this shipped with, pinned ───────────────────────────────

test('a tool that changes the world without naming a file does not crash the summary', async () => {
  /**
   * THE REAL CRASH, 2026-08-12: `start_process` was marked `mutated: true`
   * (defensible — a dev server writes `.next/` immediately), and `turn.mjs`
   * maps every mutated record to `e.mutatedPath ?? e.result.path` to build the
   * "files written" list. A process names no path, so that read was `undefined`
   * and `.split('/')` threw — AFTER the agent had completed the entire task.
   *
   * ⚠️ THIS TEST IS ABOUT `turn.mjs`, NOT ABOUT THIS MODULE. Setting
   * `mutated: false` here fixed the symptom; the landmine was general, and the
   * next tool that changes the world without producing one file — a migration,
   * a deploy — would have found it the same way.
   */
  const { runSession } = await import('../lib/turn.mjs');
  const { createLocalExecutor } = await import('../lib/workspace.mjs');

  const ex = workspace({ 'idle.mjs': 'setInterval(()=>{},1e9);\n' });

  /**
   * The exact shape of the crashing run: write a file, start a process, then a
   * closing note that names the file. The note is what drives the
   * `promisedButMissing` block where the throw happened.
   */
  let i = 0;
  const script = [
    { ok: true, content: 'writing it', toolCalls: [{ id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'idle.mjs', content: 'setInterval(()=>{},1e9);\n' }) } }], usage: { cost: 0.001, total_tokens: 100 }, finishReason: 'stop', model: 'fake/model' },
    { ok: true, content: 'starting it', toolCalls: [{ id: 'c2', function: { name: 'start_process', arguments: JSON.stringify({ command: 'node idle.mjs' }) } }], usage: { cost: 0.001, total_tokens: 100 }, finishReason: 'stop', model: 'fake/model' },
    { ok: true, content: 'Done — idle.mjs is running in the background.', toolCalls: [], usage: { cost: 0.001, total_tokens: 100 }, finishReason: 'stop', model: 'fake/model' },
  ];
  const model = async () => script[Math.min(i++, script.length - 1)];

  // ⚠️ `runSession` THREW here before the fix — it did not return a failure, it
  // crashed the process, after the agent had already done all the work.
  const out = await runSession({
    task: 'start it',
    executor: createLocalExecutor(ex.root),
    config: { apiKey: 'x', model: 'fake/model' },
    maxRounds: 5,
    allowRun: true,
    callModelImpl: model,
    onEvent: () => {},
  });

  assert.equal(out.ok, true, `the run should complete, not throw: ${out.error ?? ''}`);
  assert.ok(Array.isArray(out.executed));
  assert.ok(out.executed.some((e) => e.name === 'start_process'), 'the process tool really ran');
  stopAllBackground();
});

test('every background tool is reachable from the registry and the offer', async () => {
  const { TOOL_SCHEMAS, toolNamesForRounds } = await import('../lib/tools.mjs');
  const declared = new Set(TOOL_SCHEMAS.map((t) => t.function.name));
  for (const n of BACKGROUND_TOOL_NAMES) assert.ok(declared.has(n), `${n} is not in TOOL_SCHEMAS`);

  const offered = toolNamesForRounds(10, { allowRun: true, root: process.cwd() });
  for (const n of BACKGROUND_TOOL_NAMES) assert.ok(offered.includes(n), `${n} is never offered`);

  // ⚠️ `--no-run` must withhold all three, or the flag is a lie by a side door.
  const noRun = toolNamesForRounds(10, { allowRun: false, root: process.cwd() });
  for (const n of BACKGROUND_TOOL_NAMES) assert.equal(noRun.includes(n), false, `${n} survived --no-run`);

  // ⚠️ And single-shot must not offer them: a server started in the only round
  // is killed by teardown before anything can use it.
  const single = toolNamesForRounds(1, { allowRun: true, root: process.cwd() });
  for (const n of BACKGROUND_TOOL_NAMES) assert.equal(single.includes(n), false);
});
