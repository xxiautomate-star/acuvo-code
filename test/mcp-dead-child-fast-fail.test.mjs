/**
 * ── ⭐⭐⭐ A SERVER THAT IS ALREADY DEAD COST 20 SECONDS, EVERY RUN ──────────
 *
 * `connectServer` said, in a comment above the listener: *"A server that dies on
 * startup must not leave the session waiting."* That was the intent. The
 * behaviour was the opposite: `died` was recorded by `child.on('error')` and
 * only ever READ from `diagnose()`, which `performHandshake` calls **after**
 * `initialize` has already timed out. So the process was known to be gone at
 * ~1ms and we waited `HANDSHAKE_TIMEOUT_MS` (20s) anyway.
 *
 * MEASURED 2026-08-29, before and after:
 *
 *     command                                     before      after
 *     definitely-not-a-real-binary-xyz (ENOENT)   20,056ms      43ms
 *     node -e '<stderr>; process.exit(3)'         20,084ms     383ms
 *     node -e 'process.exit(0)'                   20,121ms     317ms
 *
 * ⚠️ THE THIRD ROW IS THE WORSE HALF AND THE REASON THIS FILE EXISTS. A clean
 * exit emits no `error` event, so `died` stayed null and the user paid twenty
 * seconds to be told *"initialize timed out after 20s"* — a sentence that names
 * neither the cause nor a fix. A typo in one `command` taxed every single run.
 *
 * ⚠️ THE TESTS BELOW SPAWN REAL PROCESSES. That is deliberate: the bug lived in
 * which node EVENT is listened to and when, and a fake child that emits whatever
 * the test decides to emit would have passed against the broken code too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectServer, HANDSHAKE_TIMEOUT_MS } from '../lib/mcp.mjs';
import { tmpdir } from 'node:os';

/**
 * Well under the 20s timeout and well over any plausible spawn. The point of a
 * loose bound is that it can only fail one way: if the race is removed the
 * measurement snaps back to 20,000ms+, which is 2.5x this.
 */
const FAST = Math.min(8_000, HANDSHAKE_TIMEOUT_MS / 2);

async function timed(server) {
  const started = Date.now();
  const result = await connectServer(server, { root: tmpdir() });
  return { ms: Date.now() - started, result };
}

test('⭐⭐⭐ an unspawnable command fails in milliseconds, not after the handshake timeout', async () => {
  const { ms, result } = await timed({
    name: 'enoent',
    command: 'definitely-not-a-real-binary-xyz-acuvo',
    args: [],
  });
  assert.equal(result.ok, false);
  assert.ok(ms < FAST, `a child that never started took ${ms}ms; it used to take the full ${HANDSHAKE_TIMEOUT_MS}ms`);
  /**
   * ⚠️ THE LATENCY FIX MUST NOT COST THE DIAGNOSIS. `diagnose()` lives inside
   * `performHandshake` and never runs when the race is won by the child, so the
   * spawn error is folded in at the call site. Without that, "20s + ENOENT"
   * would have become "instant + nothing useful", which is not an improvement.
   */
  assert.match(String(result.error), /ENOENT/, 'the spawn failure must survive the fast path');
});

test('⭐⭐ a server that exits CLEANLY is diagnosed — it used to be a bare timeout', async () => {
  /**
   * Exit code 0 emits no `error` event at all, so the old code had nothing to
   * report and reported nothing. This is the case a real misconfigured server
   * hits (arg parsed, nothing to do, exit 0).
   */
  const { ms, result } = await timed({
    name: 'exit-zero',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
  });
  assert.equal(result.ok, false);
  assert.ok(ms < FAST, `a child that exited immediately took ${ms}ms`);
  assert.match(String(result.error), /exited before the handshake/i);
  assert.match(String(result.error), /code 0/, 'the exit code is the only fact there is; it must be printed');
  assert.doesNotMatch(String(result.error), /timed out/i, 'nothing timed out — saying so sends the user after the wrong problem');
});

test('⭐ THE SERVER\'S OWN COMPLAINT SURVIVES — `close` is used, not `exit`', async () => {
  /**
   * The fast path must not trade twenty seconds of waiting for an instant answer
   * with the useful line missing. This asserts the server's own stderr survives.
   *
   * ⚠️ AND THE HONEST LIMIT, SAID HERE RATHER THAN LEFT TO BE FOUND: this does
   * NOT prove `close` beats `exit`. Mutation N2 (2026-08-29) swapped
   * `child.once('close')` for `child.once('exit')` and all four tests stayed
   * green — on Windows/node 22 the stderr had already arrived. `close` is used
   * because it is the documented guarantee that stdio has drained; that choice
   * is unguarded, and a future platform where `exit` wins the race would break
   * this diagnosis without anything here going red.
   */
  const { result } = await timed({
    name: 'needs-key',
    command: process.execPath,
    args: ['-e', 'process.stderr.write("ACUVO_TEST_KEY is required"); process.exit(2)'],
  });
  assert.equal(result.ok, false);
  assert.match(
    String(result.error),
    /ACUVO_TEST_KEY is required/,
    'the server printed the reason on stderr and the connection error dropped it',
  );
});

test('⚠️ A HEALTHY SERVER IS UNAFFECTED — the race must never win against a real handshake', async () => {
  /**
   * ⭐ THE HALF THAT IS EASY TO BREAK SILENTLY. A `childGone` promise resolved
   * on any lifecycle event (or given a `finally`) would reject every working
   * stdio server the moment it exits normally at session end. A minimal but
   * REAL MCP server proves the happy path still completes.
   */
  const server = `
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'probe', version: '1' } } }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
        }
      }
    });
  `;
  const { ms, result } = await timed({ name: 'probe', command: process.execPath, args: ['-e', server] });
  assert.equal(result.ok, true, `a working stdio server was refused: ${result.error}`);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, 'ping');
  assert.ok(ms < FAST, `a working handshake took ${ms}ms`);
  try { result.close(); } catch { /* already gone */ }
});
