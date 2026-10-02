/**
 * ── ⭐⭐⭐ THE PLACEHOLDER OUR OWN `mcp add` WROTE WAS NEVER EXPANDED ─────────
 *
 * `acuvo mcp add github` writes
 *     {"env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"}}
 * and `connectServer` spread it over `process.env` LAST, so the child received
 * the literal 32 characters — and, worse, the placeholder CLOBBERED the real
 * token a user had correctly exported. Two of the eight curated nicknames
 * (`github`, `figma`) carry `env`; both were broken this way, and the failure
 * surfaced as a 401 twenty seconds later naming nothing the user wrote.
 *
 * ⚠️ THIS FILE PROVES REACH, NOT SHAPE. A unit test on the resolver would have
 * passed against the broken build too, because the resolver is new — the defect
 * lived in the seam between the config and the spawn. So the tests below run a
 * REAL stdio MCP server (`fixtures/echo-env-mcp.mjs`, zero dependencies, no
 * network, no model call) through the real `readMcpConfig` → `connectServer` →
 * `mcpToolSchemas` → `callMcpTool` chain, and assert the secret arrived intact
 * at the far end, in a tool the model could actually call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readMcpConfig,
  connectServer,
  mcpToolSchemas,
  callMcpTool,
  closeConnections,
  resolveServerEnv,
  explainStartFailure,
  namespacedName,
} from '../lib/mcp.mjs';
import { resolveServer } from '../lib/mcp-add.mjs';
import { fingerprint, checkMcpConsent } from '../lib/mcp-consent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'echo-env-mcp.mjs');

/** A workspace whose `.acuvo/mcp.json` holds exactly these servers. */
function workspaceWith(mcpServers) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-mcp-env-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'mcp.json'), JSON.stringify({ mcpServers }, null, 2));
  return root;
}

/** The fixture server, declared the way a real config declares one. */
function fixtureServer(env) {
  return { command: process.execPath, args: [FIXTURE], env };
}

/**
 * ⚠️ BEST-EFFORT, BECAUSE WINDOWS HOLDS A LIVE CHILD'S CWD.
 *
 * The spawned server's working directory IS this temp dir, and `child.kill()`
 * returns before the OS releases the handle — so `rmSync` threw EBUSY *after
 * every assertion in the test had already passed*. `maxRetries` does not cover
 * it; the handle is gone only once the process is fully reaped.
 *
 * ⭐ Deleting a directory under the OS temp dir is housekeeping, not an
 * assertion. A teardown that can fail a green test reports a flake as a defect,
 * which is worse than a stray temp directory the OS clears anyway.
 */
function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch { /* the OS still holds the child's cwd; it is a temp dir, let it go */ }
}

// ── ⭐⭐⭐ THE REACH TEST ─────────────────────────────────────────────────────

test('⭐⭐⭐ REACH: a `${VAR}` credential arrives intact at a tool the model can call', async () => {
  const root = workspaceWith({ secrets: fixtureServer({ MY_TOKEN: '${REAL_TOKEN_VAR}' }) });
  try {
    const cfg = readMcpConfig(root);
    assert.equal(cfg.ok, true, cfg.error);
    assert.equal(cfg.servers.length, 1);

    /**
     * ⚠️ THE CONFIG STILL HOLDS THE UNEXPANDED TEXT. Expansion is a spawn-time
     * concern; if it had leaked back into the loaded config it would also have
     * leaked into the consent fingerprint, which is the property the last test
     * in this file defends.
     */
    assert.equal(cfg.servers[0].env.MY_TOKEN, '${REAL_TOKEN_VAR}');

    const conn = await connectServer(cfg.servers[0], {
      root,
      env: { ...process.env, REAL_TOKEN_VAR: 'sk-the-real-secret' },
    });
    assert.equal(conn.ok, true, `server did not connect: ${conn.error}`);

    try {
      // ── the tool reaches the MODEL'S list, namespaced ────────────────────
      const schemas = mcpToolSchemas([conn]);
      const wanted = namespacedName('secrets', 'read_env');
      const tool = schemas.find((s) => s.function.name === wanted);
      assert.ok(tool, `the server's tool never reached the model list: ${schemas.map((s) => s.function.name).join(', ')}`);

      // ── and CALLING it returns what the child actually received ─────────
      const res = await callMcpTool([conn], wanted, { name: 'MY_TOKEN' });
      assert.equal(res.ok, true, `the call failed: ${res.error}`);
      assert.equal(
        res.text,
        'sk-the-real-secret',
        'the MCP server received the wrong value for MY_TOKEN — this is the exact defect: '
        + `it got ${JSON.stringify(res.text)}`,
      );
      assert.ok(!res.text.includes('${'), 'a literal placeholder reached the server');
    } finally {
      closeConnections([conn]);
    }
  } finally {
    cleanup(root);
  }
});

test('⚠️⚠️ REACH: the placeholder no longer CLOBBERS a correctly-exported real variable', async () => {
  /**
   * The nastiest half of the bug. `{ ...process.env, ...server.env }` puts the
   * config last, so a user who had genuinely exported the token had it
   * overwritten by the literal `${…}` our own `mcp add` wrote.
   */
  const root = workspaceWith({ secrets: fixtureServer({ GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' }) });
  try {
    const cfg = readMcpConfig(root);
    const conn = await connectServer(cfg.servers[0], {
      root,
      env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_exported_by_the_user' },
    });
    assert.equal(conn.ok, true, `server did not connect: ${conn.error}`);
    try {
      const res = await callMcpTool([conn], namespacedName('secrets', 'read_env'), { name: 'GITHUB_PERSONAL_ACCESS_TOKEN' });
      assert.equal(res.ok, true, res.error);
      assert.equal(res.text, 'ghp_exported_by_the_user');
    } finally {
      closeConnections([conn]);
    }
  } finally {
    cleanup(root);
  }
});

test('⚠️ an unset variable REFUSES to start, names itself, and spawns nothing', async () => {
  const root = workspaceWith({ secrets: fixtureServer({ MY_TOKEN: '${NEVER_SET_ANYWHERE}' }) });
  try {
    const cfg = readMcpConfig(root);
    let spawned = 0;
    const conn = await connectServer(cfg.servers[0], {
      root,
      env: { PATH: process.env.PATH ?? '' },
      spawnImpl: () => { spawned += 1; throw new Error('should never be reached'); },
    });
    assert.equal(conn.ok, false);
    assert.equal(spawned, 0, 'it spawned the server despite having no credential to give it');
    assert.match(conn.error, /NEVER_SET_ANYWHERE/);
    assert.deepEqual(conn.missing, ['NEVER_SET_ANYWHERE']);
    // ⭐ It must say the thing that fixes it, not merely refuse.
    assert.match(conn.error, /Export NEVER_SET_ANYWHERE/);
  } finally {
    cleanup(root);
  }
});

// ── the resolver's own edges, where a regression would be silent ────────────

test('⚠️ a LITERAL secret containing "$" is left alone — braced form only', () => {
  /**
   * `resolveHeaders` accepts the bare `$VAR` form. Env values are different:
   * `mcp-consent.mjs` notes that mcp.json is one of the few files people type a
   * raw token into, so reading `pa$sword` as a reference to `$sword` would
   * refuse a config that works today. This is the regression guard for that.
   */
  const out = resolveServerEnv({ env: { PASSWORD: 'pa$sword', OTHER: '$notAVar' } }, { env: {} });
  assert.equal(out.ok, true, 'a literal $ in a password was mistaken for a variable reference');
  assert.equal(out.env.PASSWORD, 'pa$sword');
  assert.equal(out.env.OTHER, '$notAVar');
});

test('a server with no env at all is untouched and cannot fail', () => {
  assert.deepEqual(resolveServerEnv({}, { env: {} }), { ok: true, env: {} });
  assert.deepEqual(resolveServerEnv({ env: { A: 'plain' } }, { env: {} }), { ok: true, env: { A: 'plain' } });
});

test('an empty-string variable counts as unset — an empty credential is not a credential', () => {
  const out = resolveServerEnv({ env: { T: '${BLANK}' } }, { env: { BLANK: '   ' } });
  assert.equal(out.ok, false);
  assert.deepEqual(out.missing, ['BLANK']);
});

// ── ⭐⭐ "added" vs "runnable" ───────────────────────────────────────────────

test('⭐⭐ npx\'s refusal becomes the one line that fixes it', () => {
  const advice = explainStartFailure({
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
    stderr: 'npx canceled due to missing packages and no YES option',
  });
  assert.match(advice, /npm i -g @playwright\/mcp/);
  assert.match(advice, /--no/, 'it should say WHY it cannot install for you');
});

test('a versioned spec is advised without its version tag', () => {
  const advice = explainStartFailure({
    command: 'npx',
    args: ['-y', 'firecrawl-mcp@1.2.3'],
    stderr: 'npx canceled due to missing packages and no YES option',
  });
  assert.match(advice, /npm i -g firecrawl-mcp$/);
});

test('⚠️ an UNRELATED failure is not dressed up as a missing package', () => {
  assert.equal(
    explainStartFailure({ command: 'npx', args: ['-y', 'x-mcp'], stderr: 'FIRECRAWL_API_KEY must be provided' }),
    null,
    'a credential failure must not be reported as an install problem',
  );
  assert.equal(explainStartFailure({ command: 'node', args: ['server.mjs'], stderr: 'canceled due to missing packages' }), null);
});

test('⭐ `mcp add` now hands over the install line it always owed the user', () => {
  const r = resolveServer('playwright', { workspace: '.' });
  assert.equal(r.ok, true);
  // The browser is a second download, matched to the server's own Playwright (2026-09-27).
  assert.equal(r.install, 'npm i -g @playwright/mcp && npx @playwright/mcp install-browser chrome-for-testing');
  assert.match(r.note, /npm i -g @playwright\/mcp/, 'the CLI prints `note`, so the line must be in it');
  // A bare npm package the user typed gets the same courtesy.
  assert.equal(resolveServer('@21st-dev/magic', { workspace: '.' }).install, 'npm i -g @21st-dev/magic');
  // A remote server downloads nothing, so it must NOT be told to install anything.
  const remote = resolveServer('https://mcp.example.com/sse', { workspace: '.' });
  assert.equal(remote.install, undefined);
  assert.equal(remote.note, null);
});

// ── ⚠️⚠️⚠️ THE TRUST GATE MUST NOT WEAKEN ──────────────────────────────────

test('⚠️⚠️⚠️ THE HOSTILE `.mcp.json` IS STILL REFUSED, AND STILL FAILS CLOSED', async () => {
  /**
   * The property this whole subsystem exists for: cloning a repo and typing
   * `acuvo` must not run a binary that repo chose. Env expansion happens at
   * SPAWN time, strictly after this gate — so nothing above can have moved it.
   */
  const hostile = [{ name: 'evil', transport: 'stdio', command: 'node', args: ['evil.mjs'], env: {} }];
  const decision = await checkMcpConsent(hostile, {
    root: '/tmp/cloned-repo',
    env: {},                 // no ACUVO_TRUST_MCP
    home: mkdtempSync(join(tmpdir(), 'acuvo-empty-home-')),
    isInteractive: false,    // CI, a pipe — nobody to ask
    ask: null,
    write: () => {},
  });
  assert.equal(decision.allowed, false, 'THE TRUST GATE OPENED — this is the RCE');
  assert.match(decision.reason, /has not been approved/);
});

test('⚠️⚠️ consent is still keyed to the UNEXPANDED env value — repointing re-prompts', () => {
  /**
   * ⚠️ THE FAILURE MODE I HAD TO AVOID. If expansion had been applied before
   * fingerprinting, then `${A}` and `${B}` would hash identically whenever both
   * variables happened to hold the same value — and an approved config could be
   * silently repointed at a different secret. It also would have meant the
   * fingerprint changed with the machine's environment, so consent granted on
   * one machine would not survive on another.
   */
  const a = fingerprint([{ name: 's', command: 'node', args: ['x.mjs'], env: { T: '${A}' } }]);
  const b = fingerprint([{ name: 's', command: 'node', args: ['x.mjs'], env: { T: '${B}' } }]);
  assert.notEqual(a, b, 'repointing a credential at a different variable did not re-prompt');

  // And the NODE_OPTIONS RCE that this fingerprint was hardened for stays caught.
  const benign = fingerprint([{ name: 's', command: 'node', args: ['x.mjs'], env: { NODE_OPTIONS: '' } }]);
  const armed = fingerprint([{ name: 's', command: 'node', args: ['x.mjs'], env: { NODE_OPTIONS: '--require ./pwn.cjs' } }]);
  assert.notEqual(benign, armed);
});

test('⚠️ expansion cannot be used to smuggle a value past the consent PROMPT', async () => {
  /**
   * The prompt shows the unexpanded text, which is what the user is agreeing
   * to. Asserted here because "the screen says `${X}` but the child gets
   * something else" would be consent to the wrong thing — the failure
   * `mcp-consent.mjs` calls "consent to nothing".
   */
  const { describeServers } = await import('../lib/mcp-consent.mjs');
  const text = describeServers([{ name: 's', command: 'node', args: ['x.mjs'], env: { NODE_OPTIONS: '${INJECTED}' } }]);
  assert.match(text, /NODE_OPTIONS=\$\{INJECTED\}/, 'the prompt must show the reference the user is approving');
});
