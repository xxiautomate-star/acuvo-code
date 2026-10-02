/**
 * ── ⭐⭐⭐ MCP TOOLS ACTUALLY REACH THE MODEL — PROVEN, NOT ASSUMED ──────────
 *
 * Roman, 2026-08-27: *"make sure it all works dude, mcps in cli and builder,
 * just test everything."*
 *
 * ⚠️⚠️ THREE SEPARATE GATES CAN EACH PRODUCE "NO MCP TOOLS", AND ALL THREE LOOK
 * EXACTLY LIKE A BUG. Measured by hitting every one of them in turn while trying
 * to prove reach:
 *
 *   1. **CONSENT.** A workspace `.mcp.json` is untrusted until a human approves
 *      it — a hostile config could spawn arbitrary commands. With no terminal
 *      the answer is a refusal: *"there is no terminal here to ask."*
 *      `ACUVO_TRUST_MCP=1` is the non-interactive escape.
 *   2. **`allowRun`.** `mcpAllowed = ... && allowRun && !dryRun`. `--no-run` and
 *      `--dry-run` promise to run nothing, and spawning an MCP server would make
 *      that promise false — *"worse than having no flag, because it is the
 *      advice a careful person follows."*
 *   3. **`maxRounds > 1`.** A one-round run gets a minimal offer (measured: TWO
 *      tools, `write_file` and `write_files`). Nothing is wrong; there is simply
 *      no round in which to use a lookup.
 *
 * ⭐ EACH OF THOSE IS CORRECT BEHAVIOUR. The value of this file is that the next
 * person who sees an empty MCP list can tell WHICH of the three it is instead of
 * going looking for a defect that is not there.
 *
 * ⚠️ IT TALKS TO A REAL SERVER. `mcp.deepwiki.com` is public, needs no key, and
 * returns documentation for GitHub repositories. If it is down this test fails
 * for a reason that is not ours — which is the honest trade for proving reach
 * rather than proving a mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { readMcpConfig } from '../lib/mcp.mjs';
import { checkMcpConsent } from '../lib/mcp-consent.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-mcp-'));
  made.push(root);
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'mcp.json'), JSON.stringify({
    mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } },
  }));
  writeFileSync(join(root, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  return root;
}

async function offeredTools(root, { allowRun = true, maxRounds = 8 } = {}) {
  let names = [];
  await runSession({
    task: 'ask deepwiki how the phaser repo works',
    executor: createLocalExecutor(root),
    config: { apiKey: 'x', model: 'fake/model' },
    maxRounds,
    allowRun,
    callModelImpl: async (opts) => {
      names = (opts.tools ?? []).map((t) => t.function?.name).filter(Boolean);
      return { ok: true, content: 'hi', toolCalls: [], usage: { cost: 0, total_tokens: 5 }, finishReason: 'stop', model: 'fake/model' };
    },
    onEvent: () => {},
  });
  return names;
}

test('⭐⭐⭐ a configured MCP server\'s tools are offered to the model', async () => {
  process.env.ACUVO_TRUST_MCP = '1';
  const names = await offeredTools(workspace());
  const mcp = names.filter((n) => n.startsWith('mcp__'));
  assert.ok(
    mcp.length > 0,
    `no MCP tools reached the model out of ${names.length} offered. Check the three gates in this `
    + 'file\'s header before looking for a bug: consent, allowRun, maxRounds.',
  );
  // Namespaced, so a server cannot shadow one of ours by naming a tool `read_file`.
  assert.ok(mcp.every((n) => n.startsWith('mcp__deepwiki__')), `a tool escaped its namespace: ${mcp.join(', ')}`);
});

test('⚠️ CONSENT is the first gate — an unapproved config is refused, not silently skipped', async () => {
  /**
   * ⚠️ EXPLICITLY UNSET, because a sibling test sets it and `process.env` is
   * shared for the life of the process. Without this line the test passed or
   * failed depending on FILE ORDER — a guard whose verdict depends on which
   * test ran first is not a guard.
   */
  delete process.env.ACUVO_TRUST_MCP;
  const root = workspace();
  const cfg = readMcpConfig(root);
  assert.equal(cfg.ok, true, 'the config file was not even read');
  const consent = await checkMcpConsent(cfg.servers, { root, ask: null });
  assert.equal(consent.allowed, false, 'an unapproved workspace config was accepted without a human');
  assert.match(
    String(consent.reason ?? ''),
    /no terminal here to ask/i,
    'the refusal must SAY it needs a human, or it reads as a broken feature',
  );
});

test('⚠️⚠️ `allowRun: false` withholds MCP — --no-run means run nothing', async () => {
  /**
   * ⭐ THE PROMISE IS THE POINT. `--dry-run` says "touch nothing, run nothing";
   * a flag that spawns a server from the repo anyway is not a weak guarantee,
   * it is a false one.
   */
  process.env.ACUVO_TRUST_MCP = '1';
  const names = await offeredTools(workspace(), { allowRun: false });
  assert.equal(names.filter((n) => n.startsWith('mcp__')).length, 0, '--no-run still connected an MCP server');
});

test('⚠️ a ONE-round run gets a minimal offer, and that is not a failure either', async () => {
  process.env.ACUVO_TRUST_MCP = '1';
  const names = await offeredTools(workspace(), { maxRounds: 1 });
  assert.ok(names.length < 5, `a one-round run offered ${names.length} tools; it used to offer two`);
  assert.equal(names.filter((n) => n.startsWith('mcp__')).length, 0);
});
