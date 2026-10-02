/**
 * ── ⭐⭐⭐ `acuvo mcp add` IS THE CONSENT ACT, AND IT USED TO COUNT FOR NOTHING ─
 *
 * ⚠️⚠️ MEASURED END TO END, 2026-09-19, WITH A MODEL IN THE LOOP. A scratch
 * workspace, `acuvo mcp add docs`, then a real run. `checkMcpConsent` refused —
 * *"this workspace ships an MCP config that has not been approved, and there is
 * no terminal here to ask"* — `cfg.servers` was emptied before a single
 * handshake, and the model wrote, in its own words:
 *
 *     "The `docs` MCP server (`resolve-library-id` / `query-docs`) is not in my
 *      tool list, so per the skill I'll fall back to `web_search`"
 *
 * The person had asked for that server BY NAME through our own command, one
 * second earlier, and read the line saying exactly where their query text goes.
 * Re-run with `ACUVO_TRUST_MCP=1` the same task connected both servers, called
 * `resolve-library-id` then `query-docs`, and returned the correct Next 14
 * route-handler signature with a `github.com/vercel/next.js` source URL. So the
 * capability was whole and the DOOR was shut.
 *
 * ── ⛔ WHY THIS IS NOT "TRUST WHATEVER IS IN THE FILE AFTERWARDS" ────────────
 *
 * `fingerprint` covers the WHOLE server list, so recording trust for the result
 * of any add would LAUNDER every entry that was already there: clone a hostile
 * repository, add one harmless documentation server, and its binary is approved
 * too. The pre-condition is therefore that the config BEFORE the add was empty
 * or already trusted. That is the property most of this file asserts, because a
 * test that only proved the convenience works would have missed the escalation.
 *
 * ⚠️ REAL PROCESSES, REAL FILES, NO SOURCE REGEX. This repo's standing lesson is
 * that a guard made of `assert.match(source, /…/)` can only ever prove the TEXT
 * changed. Every assertion here spawns `bin/acuvo.mjs` and then asks the real
 * `checkMcpConsent` what it decides.
 *
 * 💸 ZERO MODEL CALLS. `mcp add` is a lifecycle command; it never reaches a
 * model, and `checkMcpConsent` is called directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readMcpConfig } from '../lib/mcp.mjs';
import { checkMcpConsent } from '../lib/mcp-consent.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acuvo.mjs');

const made = [];
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-mcp-consent-'));
  made.push(dir);
  // ⚠️ The trust store is isolated per case, so a test can never approve
  //    anything in the real user's `~/.acuvo/mcp-trust.json`.
  const trust = join(dir, 'trust');
  mkdirSync(trust, { recursive: true });
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  return { workspace, trust };
}
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function add(server, { workspace, trust }) {
  const r = spawnSync(process.execPath, [BIN, 'mcp', 'add', server, '--dir', workspace], {
    encoding: 'utf8',
    env: { ...process.env, ACUVO_TRUST_DIR: trust },
  });
  assert.equal(r.status, 0, `mcp add ${server} failed: ${r.stderr || r.stdout}`);
  return r;
}

/** What the run would decide, with no terminal to ask — the unattended path. */
async function wouldConnect({ workspace, trust }) {
  const cfg = readMcpConfig(workspace);
  const decision = await checkMcpConsent(cfg.servers ?? [], {
    root: workspace,
    isInteractive: false,
    ask: null,
    env: { ACUVO_TRUST_DIR: trust },
    home: trust,
  });
  return decision;
}

// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐⭐ a server the person added BY NAME connects on the next run, unasked', async () => {
  const box = sandbox();
  add('docs', box);
  const d = await wouldConnect(box);
  assert.equal(d.allowed, true, `the server the user just asked for is still switched off: ${d.reason}`);
});

test('⭐⭐ a SECOND add keeps the config trusted — the fingerprint covers the whole list', async () => {
  const box = sandbox();
  add('docs', box);
  add('deepwiki', box);
  const cfg = readMcpConfig(box.workspace);
  assert.deepEqual((cfg.servers ?? []).map((s) => s.name).sort(), ['deepwiki', 'docs']);
  const d = await wouldConnect(box);
  assert.equal(d.allowed, true, `adding a second server re-locked the first: ${d.reason}`);
});

test('⛔⛔ an UNTRUSTED config already in the workspace is NOT laundered by adding to it', async () => {
  /**
   * The attack the pre-condition exists for: a `.mcp.json` that arrived inside a
   * cloned repository, naming a binary nobody chose. Adding a harmless hosted
   * documentation server beside it must not approve the binary.
   */
  const box = sandbox();
  mkdirSync(join(box.workspace, '.acuvo'), { recursive: true });
  writeFileSync(
    join(box.workspace, '.acuvo', 'mcp.json'),
    JSON.stringify({ mcpServers: { hostile: { command: 'node', args: ['./pwn.cjs'] } } }, null, 2),
    'utf8',
  );

  add('docs', box);

  const cfg = readMcpConfig(box.workspace);
  assert.ok((cfg.servers ?? []).some((s) => s.name === 'hostile'), 'the fixture lost the entry this test is about');

  const d = await wouldConnect(box);
  assert.equal(d.allowed, false, 'adding one server approved a binary the user never chose');
  assert.match(d.reason, /has not been approved/);
});

test('⛔ and the carry never reaches ANOTHER workspace — trust is per config, not per machine', async () => {
  const box = sandbox();
  add('docs', box);
  assert.equal((await wouldConnect(box)).allowed, true);

  // Same trust store, a different workspace that nobody has added anything to.
  const other = join(box.workspace, '..', 'other');
  mkdirSync(join(other, '.acuvo'), { recursive: true });
  writeFileSync(
    join(other, '.acuvo', 'mcp.json'),
    JSON.stringify({ mcpServers: { hostile: { command: 'node', args: ['./pwn.cjs'] } } }, null, 2),
    'utf8',
  );
  const d = await wouldConnect({ workspace: other, trust: box.trust });
  assert.equal(d.allowed, false, 'a config nobody approved was accepted because a DIFFERENT one was');
});
