import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import {
  checkPort, checkMinutes, isListening, findCloudflared, waitUntilServing,
  consentBanner, liveBanner, runTunnel, INSTALL_HINT,
  DEFAULT_MINUTES, MAX_MINUTES, TUNNEL_BINARY,
} from '../lib/tunnel.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * ── ⭐⭐⭐ THE MOST IMPORTANT TEST IN THIS FILE ──────────────────────────────
 *
 * A tunnel publishes a port on this machine to the open internet with no
 * authentication. That is the decision `lsp.mjs` calls the one a language model
 * never gets to make. If a future change gives this a tool schema "for
 * convenience", an agent can expose a dev database mid-task and nobody chose it.
 */
test('⭐⭐⭐ the MODEL cannot open a tunnel — there is no verb for it', () => {
  for (const name of TOOL_NAMES) {
    assert.ok(!/tunnel|expose|publish_port|share_port/i.test(name), `${name} looks like a tunnel verb; a tunnel must never be model-callable`);
  }
  // And the module itself must not grow a schema factory.
  const source = readFileSync(join(HERE, '..', 'lib', 'tunnel.mjs'), 'utf8');
  assert.ok(!/type:\s*'function'/.test(source), 'lib/tunnel.mjs contains a tool schema — it must not');
  assert.ok(!/ToolSchema|toolSchemas/.test(source), 'lib/tunnel.mjs exports a tool schema factory — it must not');
});

test('⚠️ it is a HUMAN subcommand, wired in bin/ where it costs no model bytes', () => {
  const bin = readFileSync(join(HERE, '..', 'bin', 'acuvo.mjs'), 'utf8');
  assert.match(bin, /arg === 'tunnel'/, 'the tunnel subcommand is not lifted in bin/acuvo.mjs');
  assert.match(bin, /tunnelPort/, 'the lifted flag is not carried');
});

// ── the refusals, which are the whole safety story ─────────────────────────

test('⭐ a database port is refused outright', () => {
  for (const [port, name] of [[5432, /PostgreSQL/], [3306, /MySQL/], [6379, /Redis/], [27017, /MongoDB/], [22, /SSH/]]) {
    const r = checkPort(port);
    assert.equal(r.ok, false, `port ${port} must be refused`);
    assert.match(r.error, name);
    // ⚠️ The refusal must say WHY it matters, not just "no".
    assert.match(r.error, /no password|internet/);
  }
});

test('an ordinary web port is allowed', () => {
  for (const p of [80, 3000, 5173, 8080, 8811]) assert.equal(checkPort(p).ok, true, `port ${p}`);
});

test('a non-port is refused with the shape of the command it wanted', () => {
  for (const bad of ['', 'abc', -1, 0, 70000, 3.5]) {
    const r = checkPort(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  assert.match(checkPort('abc').error, /acuvo tunnel 3000/);
});

test('⭐ a lifetime is always set, and cannot be talked past the ceiling', () => {
  // ⚠️ THE DEFAULT IS THE MAIN CONTROL: the realistic failure is forgetting.
  assert.equal(checkMinutes(undefined).minutes, DEFAULT_MINUTES);
  assert.equal(checkMinutes('').minutes, DEFAULT_MINUTES);
  assert.equal(checkMinutes(5).minutes, 5);
  assert.equal(checkMinutes(MAX_MINUTES).ok, true);

  const over = checkMinutes(MAX_MINUTES + 1);
  assert.equal(over.ok, false);
  // The refusal must name the right tool for the job rather than just saying no.
  assert.match(over.error, /named Cloudflare tunnel|access policy/);
  assert.equal(checkMinutes(0).ok, false);
  assert.equal(checkMinutes(-3).ok, false);
  assert.equal(checkMinutes('soon').ok, false);
});

// ── the port probe ─────────────────────────────────────────────────────────

test('⭐ isListening tells a live port from a dead one', async () => {
  const server = createServer((_q, r) => r.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    assert.equal(await isListening(port), true, 'a listening port must read as live');
    server.close();
    await new Promise((r) => server.once('close', r));
    /**
     * ⚠️ THIS HALF IS THE SAFETY HALF. Without it `acuvo tunnel 3000` when the
     * server is on 3001 publishes a URL that 502s, and the person retries port
     * numbers until one sticks — publishing something they never looked at.
     */
    assert.equal(await isListening(port), false, 'a closed port must read as dead');
  } finally {
    try { server.close(); } catch { /* already closed */ }
  }
});

// ── the readiness gate ─────────────────────────────────────────────────────

test('⭐⭐ waitUntilServing treats Cloudflare 530 as NOT ready', async () => {
  /**
   * MEASURED: a quick tunnel's hostname exists ~7.6s before it serves, and
   * during that window it answers HTTP 530 (Cloudflare error 1033). Announcing
   * the URL then hands somebody a link that shows an error page.
   */
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { status: calls < 3 ? 530 : 200 };
  };
  const r = await waitUntilServing('https://x.trycloudflare.com', { fetchImpl, pollMs: 1, timeoutMs: 5_000 });
  assert.equal(r.ready, true);
  assert.equal(r.status, 200);
  assert.equal(calls, 3, '530 must not be accepted as ready');
});

test('⭐ but ANY non-530 answer is ready — the app may legitimately 404 on /', () => {
  // Demanding a 200 would refuse to announce a working tunnel in front of an
  // app whose root route is a 404 or a 401, which is most APIs.
  return Promise.all([404, 401, 500, 302].map(async (status) => {
    const r = await waitUntilServing('https://x.trycloudflare.com', { fetchImpl: async () => ({ status }), pollMs: 1, timeoutMs: 500 });
    assert.equal(r.ready, true, `HTTP ${status} means the edge reached us`);
    assert.equal(r.status, status);
  }));
});

test('a connection that never succeeds times out rather than hanging', async () => {
  const r = await waitUntilServing('https://x.trycloudflare.com', {
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
    pollMs: 1,
    timeoutMs: 60,
  });
  assert.equal(r.ready, false);
});

// ── what the person is told ────────────────────────────────────────────────

test('⭐⭐ the consent banner names WHAT, TO WHOM and FOR HOW LONG', () => {
  const b = consentBanner(3000, 30);
  assert.match(b, /127\.0\.0\.1:3000/, 'it must name the exact thing being exposed');
  assert.match(b, /public internet/, 'it must name the audience');
  assert.match(b, /NONE\. Anyone with the URL gets in\./, 'it must say there is no authentication');
  assert.match(b, /30 minutes/, 'it must name the lifetime');
  /**
   * ⚠️ "Are you sure?" is not informed consent. The banner has to say what
   * could leak, in the sentence the person is answering.
   */
  assert.match(b, /admin page|unauthenticated API|\.env/);
});

test('the live banner repeats the expiry and the fact there is no password', () => {
  const at = new Date(Date.now() + 60_000);
  const b = liveBanner('https://a-b-c.trycloudflare.com', 3000, 30, at);
  assert.match(b, /https:\/\/a-b-c\.trycloudflare\.com/);
  assert.match(b, /127\.0\.0\.1:3000/);
  assert.match(b, /No password/);
  assert.match(b, /Ctrl-C/);
});

test('⚠️ the install hint refuses to fetch the binary and says why', () => {
  assert.match(INSTALL_HINT, /brew install cloudflared/);
  assert.match(INSTALL_HINT, /winget/);
  // ⭐ The reason matters: this package will not download a program that opens
  // your machine to the internet. Same argument as --ignore-scripts.
  assert.match(INSTALL_HINT, /install deliberately/);
  assert.match(INSTALL_HINT, /No Cloudflare account/);
});

// ── the process contract ───────────────────────────────────────────────────

test('⭐ a missing cloudflared is reported, never guessed at', async () => {
  const r = await runTunnel({ port: 3000, env: { PATH: '' }, binary: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /brew install cloudflared/);
});

test('⭐⭐ runTunnel resolves when the tunnel is DOWN, and leaves no timer behind', async () => {
  /**
   * ⚠️ THE PROMISE OUTLIVING THE URL IS THE CONTRACT. A function that resolved
   * on "it is live" would hand back a running child and no obligation, which is
   * how a process outlives the command that made it — the defect that got the
   * pty transport withdrawn from this package.
   */
  const fake = () => {
    const { EventEmitter } = require('node:events');
    return null;
  };
  // Drive the failure path with a spawn that dies immediately.
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 999999;

  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const p = runTunnel({ port: 3000, binary: 'fake-cloudflared', spawnImpl: () => child });
  child.stderr.write('failed to connect\n');
  setImmediate(() => child.emit('exit', 1));
  const r = await p;

  assert.equal(r.ok, false, 'a cloudflared that exits without a URL is a failure');
  assert.match(r.error, /before publishing a URL/);
  const after = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  /**
   * ⚠️ A LEFTOVER setTimeout KEEPS THE EVENT LOOP ALIVE, so the command would
   * appear to hang for up to eight hours after the tunnel was gone. Every exit
   * path clears both timers; this is the assertion that says so.
   */
  assert.ok(after <= before, `runTunnel left ${after - before} timer(s) behind`);
});

test('⭐ a URL that appears is announced only after the readiness check', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.pid = 999998;

  const events = [];
  const p = runTunnel({
    port: 3000,
    minutes: MAX_MINUTES,           // long, so only the exit below ends it
    binary: 'fake-cloudflared',
    spawnImpl: () => child,
    readyFetch: async () => ({ status: 200 }),
    onEvent: (e) => events.push(e),
  });
  child.stderr.write('  |  https://alpha-beta-gamma.trycloudflare.com  |\n');
  // let the readiness promise settle, then end the process
  await new Promise((r) => setTimeout(r, 50));
  child.emit('exit', 0);
  await p;

  const kinds = events.map((e) => e.type);
  assert.deepEqual(kinds.slice(0, 2), ['registering', 'live'], `expected registering then live, got ${kinds.join(', ')}`);
  const live = events.find((e) => e.type === 'live');
  assert.equal(live.url, 'https://alpha-beta-gamma.trycloudflare.com');
  assert.equal(live.ready, true);
  assert.ok(live.expiresAt instanceof Date);
});

test('cloudflared is found on this machine, or the test says it is not', (t) => {
  const found = findCloudflared();
  if (!found) {
    t.diagnostic(`${TUNNEL_BINARY} is not installed here — the refusal path above is what runs`);
    return;
  }
  assert.match(found, /cloudflared/i);
});
