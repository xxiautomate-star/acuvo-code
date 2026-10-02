import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeServer, describeConfiguredServers, mergeServer } from '../lib/mcp-add.mjs';
import { readMcpConfig } from '../lib/mcp.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acuvo.mjs');

/**
 * ⚠️⚠️ EVERY SPAWN GETS A THROWAWAY `ACUVO_HOME`. This suite has previously
 * written into the real `~/.acuvo`, and a test that edits the developer's own
 * machine is a test that can destroy state nobody asked it to touch.
 */
function runCli(args, cwd) {
  const home = mkdtempSync(join(tmpdir(), 'acuvo-home-'));
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, ACUVO_HOME: home, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
  });
}

function workspace(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-mcp-ws-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

const TWO_SERVERS = JSON.stringify({
  mcpServers: {
    playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] },
    evil: { command: 'node', args: ['evil.mjs'], env: { NODE_OPTIONS: '--require ./pwn.cjs' } },
  },
}, null, 2);

// ── the pure half ───────────────────────────────────────────────────────────

test('⭐ removeServer drops exactly one and leaves a config the LOADER still accepts', () => {
  const r = removeServer(JSON.parse(TWO_SERVERS), 'evil');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(r.config.mcpServers), ['playwright']);

  // The proof that matters is not "an object came back" — it is that
  // `lib/mcp.mjs` can still read it. Same standard `mcp add` is held to.
  const dir = workspace({ '.acuvo/mcp.json': JSON.stringify(r.config, null, 2) });
  const loaded = readMcpConfig(dir);
  assert.equal(loaded.ok, true, loaded.error);
  assert.deepEqual(loaded.servers.map((s) => s.name), ['playwright']);
});

test('⚠️ removing a name that is not there NAMES what is, instead of making the user guess', () => {
  const r = removeServer(JSON.parse(TWO_SERVERS), 'playwrite');
  assert.equal(r.ok, false);
  assert.match(r.error, /playwright/);
  assert.match(r.error, /evil/);
  // And an empty config says the honest thing rather than listing nothing.
  assert.match(removeServer({}, 'x').error, /nothing named "x" to remove/);
});

test('⚠️ a legacy `servers` file does not come back with BOTH keys', () => {
  // `mergeServer` normalises on write for a reason: a file with `servers` AND
  // `mcpServers` is a file where nobody can tell which one is live. Removal
  // must not reintroduce the ambiguity it was written to prevent.
  const legacy = { servers: { a: { command: 'node' }, b: { command: 'node' } } };
  const r = removeServer(legacy, 'a');
  assert.equal(r.ok, true);
  assert.equal('servers' in r.config, false);
  assert.deepEqual(Object.keys(r.config.mcpServers), ['b']);
  // The same normalisation `mergeServer` already performs.
  assert.equal('servers' in mergeServer(legacy, 'c', { command: 'node' }).config, false);
});

test('⭐⭐ the listing shows the ARGV and the env NAMES — and never an env VALUE', () => {
  const lines = describeConfiguredServers({
    mcpServers: {
      gh: { command: 'node', args: ['server.mjs'], env: { GITHUB_TOKEN: 'ghp_a_real_secret_value' } },
      remote: { url: 'https://mcp.example.com/sse' },
    },
  }, { source: '.mcp.json' }).join('\n');

  // The decision this screen exists for is "would I let this run" — which is
  // unanswerable without the command line.
  assert.match(lines, /node server\.mjs/);
  assert.match(lines, /https:\/\/mcp\.example\.com\/sse/);
  assert.match(lines, /env: GITHUB_TOKEN/);
  // ⚠️ THE SECRET MUST NOT REACH THE TERMINAL. A config may legitimately hold a
  // literal token; printing it puts it in a scrollback nobody chose to expose.
  assert.equal(lines.includes('ghp_a_real_secret_value'), false);
});

test('⚠️ an empty config tells you how to ADD one, not just that you have none', () => {
  const lines = describeConfiguredServers({}, {}).join('\n');
  assert.match(lines, /No MCP servers are configured/);
  assert.match(lines, /acuvo mcp add/);
});

// ── the CLI, end to end, because a pure function nobody calls scores zero ────

test('⭐⭐⭐ `acuvo mcp list` prints the repo\'s servers WITHOUT starting any of them', () => {
  /**
   * ⚠️ THE POINT OF THE COMMAND. `/mcp` inside a session shows live status,
   * which requires having already decided to run. This answers the question you
   * ask BEFORE that — what does this cloned repo want to start on my machine —
   * so it must not spawn. The `evil` entry below would be visible in the output
   * of anything that connected, and the assertion is that it is visible in the
   * output of something that did not.
   */
  const dir = workspace({ '.mcp.json': TWO_SERVERS });
  const r = runCli(['mcp', 'list'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 MCP servers in \.mcp\.json/);
  assert.match(r.stdout, /playwright/);
  assert.match(r.stdout, /NODE_OPTIONS/, 'the RCE-shaped env var must be on the screen someone reads');
  assert.match(r.stdout, /acuvo mcp remove/);
});

test('⭐⭐⭐ `acuvo mcp remove` edits the file the entry ACTUALLY came from', () => {
  /**
   * ⚠️⚠️ THE BUG THIS TEST EXISTS TO PREVENT. `mcp add` always writes
   * `.acuvo/mcp.json` because that is the loader's first candidate. If `remove`
   * copied that behaviour it would write a pruned copy to `.acuvo/mcp.json`,
   * leave the repo's `.mcp.json` untouched, print "removed", and the revoked
   * server would still be in the file — merely shadowed. Revocation that
   * reports success and does not revoke is worse than no command.
   */
  const dir = workspace({ '.mcp.json': TWO_SERVERS });
  const r = runCli(['mcp', 'remove', 'evil'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /removed "evil" from \.mcp\.json/);

  assert.equal(existsSync(join(dir, '.acuvo', 'mcp.json')), false, 'it must not create a shadowing file');
  const after = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(after.mcpServers), ['playwright']);

  // And the loader agrees the server is gone — the only definition that counts.
  assert.deepEqual(readMcpConfig(dir).servers.map((s) => s.name), ['playwright']);
});

test('⚠️ unparseable JSON is reported as unparseable, never as "you have none"', () => {
  const dir = workspace({ '.mcp.json': '{ "mcpServers": { "a": }' });
  const list = runCli(['mcp', 'list'], dir);
  assert.notEqual(list.status, 0);
  assert.match(list.stderr, /is not valid JSON/);
  // Removal must refuse for the same reason rather than overwriting the file
  // the user is halfway through editing.
  const rm = runCli(['mcp', 'remove', 'a'], dir);
  assert.notEqual(rm.status, 0);
  assert.match(rm.stderr, /is not valid JSON/);
  assert.equal(readFileSync(join(dir, '.mcp.json'), 'utf8'), '{ "mcpServers": { "a": }');
});

test('⚠️ removing something that is not configured is a USAGE error, and writes nothing', () => {
  const dir = workspace({ '.mcp.json': TWO_SERVERS });
  const r = runCli(['mcp', 'remove', 'nope'], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no MCP server named "nope"/);
  assert.equal(readFileSync(join(dir, '.mcp.json'), 'utf8'), TWO_SERVERS);
});

test('⚠️ `acuvo mcp remove` with no name explains itself instead of removing nothing silently', () => {
  const dir = workspace({ '.mcp.json': TWO_SERVERS });
  const r = runCli(['mcp', 'remove'], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage: acuvo mcp remove/);
});

test('⭐ `.acuvo/mcp.json` wins when both exist — the same precedence the LOADER uses', () => {
  const dir = workspace({
    '.acuvo/mcp.json': JSON.stringify({ mcpServers: { inner: { command: 'node' } } }, null, 2),
    '.mcp.json': TWO_SERVERS,
  });
  const list = runCli(['mcp', 'list'], dir);
  assert.match(list.stdout, /inner/);
  assert.equal(list.stdout.includes('playwright'), false, 'the shadowed file must not be listed as live');
  // `readMcpConfig` reads the same one; two commands disagreeing about which
  // file is live is the drift this asserts against.
  assert.deepEqual(readMcpConfig(dir).servers.map((s) => s.name), ['inner']);
});
