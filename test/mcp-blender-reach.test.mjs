/**
 * ── ⭐⭐⭐ BLENDER: ADDED CORRECTLY, SPAWNED SAFELY, OFFERED WHEN IT MATTERS ──
 *
 * Owner, 2026-09-27: make the CLI build anything — apps, games, 3D, design —
 * through integrations. Four things had to be true for a 3D brief to reach
 * Blender, and before this commit none of them were:
 *
 *   1. `acuvo mcp add blender` wrote `npx -y blender` — npm `blender` is an
 *      unrelated SVG→PNG tool. It must resolve to the curated uv entry.
 *   2. A `uvx` server must never download at spawn — the npx `--no` rule.
 *   3. The shortlist lit Blender's 36-tool / ~42KB schema block for 6 of 10
 *      ordinary coding briefs (on `api`, `node`, `code`, `set`, `search`,
 *      `status`) and must now light it for 3D briefs only.
 *   4. The doctor must tell "server configured" from "Blender listening".
 *
 * The server end is `fixtures/blender-mcp-stub.mjs`: the REAL tool surface of
 * mcp-for-blender 2.1.1, with Blender's side simulated. It is not Blender.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveServer } from '../lib/mcp-add.mjs';
import { uvxArgs, isUvx, explainStartFailure, connectServer, callMcpTool, closeConnections, namespacedName } from '../lib/mcp.mjs';
import { catalogueEntry, assessEntry, packageOf } from '../lib/mcp-defaults.mjs';
import { shortlistMcpSchemas, useToolsetSchema } from '../lib/mcp-shortlist.mjs';
import { blenderAddonCheck, looksLikeBlenderServer, installedUvTools, mcpCatalogueChecks } from '../lib/doctor.mjs';
import { BLENDER_TOOLS } from './fixtures/blender-mcp-stub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'blender-mcp-stub.mjs');

const schemas = BLENDER_TOOLS.map((t) => ({
  type: 'function',
  function: { name: `mcp__blender__${t.name}`, description: t.description, parameters: t.inputSchema },
}));

test('⭐ `acuvo mcp add blender` resolves to the curated uv server, never npm `blender`', () => {
  const r = resolveServer('blender');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'blender');
  assert.equal(r.entry.command, 'uvx');
  assert.deepEqual(r.entry.args, ['mcp-for-blender']);
  assert.equal(r.install, 'uv tool install mcp-for-blender');
  assert.deepEqual(r.entry.env, { BLENDER_MCP_DISABLE_TELEMETRY: 'true' }, 'telemetry is off in every config we write');
  assert.ok(!JSON.stringify(r.entry).includes('npx'), 'a Blender config must not route through npx');
});

test('⚠️ npm `blender-mcp` is a different project and says so', () => {
  const r = resolveServer('blender-mcp');
  assert.equal(r.ok, true, 'a warn advisory does not block');
  assert.match(r.note, /react-frameui/);
  assert.match(r.note, /acuvo mcp add blender/);
});

test('⭐ uvx never downloads at spawn: `--offline` is injected, once, only for uvx', () => {
  assert.deepEqual(uvxArgs('uvx', ['mcp-for-blender']), ['--offline', 'mcp-for-blender']);
  assert.deepEqual(uvxArgs('C:\\Users\\x\\.local\\bin\\uvx.exe', ['blender-mcp']), ['--offline', 'blender-mcp']);
  assert.deepEqual(uvxArgs('uvx', ['--offline', 'x']), ['--offline', 'x']);
  assert.deepEqual(uvxArgs('python', ['-m', 'srv']), ['-m', 'srv']);
  assert.equal(isUvx('/usr/bin/uvx'), true);
  assert.equal(isUvx('uv'), false);
});

test('⭐ a uvx cache miss explains itself with the install line', () => {
  const msg = explainStartFailure({
    command: 'uvx',
    args: ['mcp-for-blender'],
    stderr: '× No solution found when resolving tool dependencies:\n  ╰─▶ Because mcp-for-blender was not found in the cache',
  });
  assert.match(msg, /uv tool install mcp-for-blender/);
  assert.equal(explainStartFailure({ command: 'uvx', args: ['x'], stderr: 'Traceback: boom' }), null);
});

test('⭐ the catalogue entry is honest: uv runner, not a default, install mentions its package', () => {
  const e = catalogueEntry('blender');
  assert.equal(e.runner, 'uv');
  assert.equal(e.enabledByDefault, false);
  assert.equal(packageOf(e), 'mcp-for-blender');
  const dark = assessEntry(e, { env: {}, installed: new Set() });
  assert.equal(dark.state, 'dark');
  assert.match(dark.detail, /uvx `--offline`/);
  assert.doesNotMatch(dark.detail, /npx/);
  assert.equal(assessEntry(e, { env: {}, installed: new Set(['mcp-for-blender']) }).state, 'live');
});

test('⭐⭐ the shortlist offers Blender for 3D briefs and charges ordinary coding briefs nothing', () => {
  const ordinary = [
    'fix the failing test in src/api/users.ts',
    'refactor the node server to use async/await',
    'write a python script that parses a CSV and prints the status of each row',
    'add a search box to the product list',
    'set up eslint and prettier',
    'rename getUser to fetchUser across the code',
    'build a snake game in the browser',
  ];
  for (const brief of ordinary) {
    const { schemas: kept, withheld } = shortlistMcpSchemas(brief, schemas);
    assert.equal(kept.length, 0, `"${brief}" paid for Blender's schemas`);
    assert.deepEqual(withheld, ['blender'], 'withheld, so the use_toolset door still names it');
  }
  const threeD = [
    'make a low-poly tree and export it as GLB into ./assets',
    'model a coffee mug in blender and render it',
    'create a 3d scene with a low poly house',
    'export the character as gltf for the game',
  ];
  for (const brief of threeD) {
    const { schemas: kept } = shortlistMcpSchemas(brief, schemas);
    assert.equal(kept.length, BLENDER_TOOLS.length, `"${brief}" was not offered Blender`);
  }
  assert.match(useToolsetSchema(['blender']).function.description, /blender/);
});

test('⭐ through the real client: the stub connects, lists the real surface, and an export lands on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-blender-'));
  const conn = await connectServer({ name: 'blender', command: process.execPath, args: [STUB], env: {} }, { root });
  try {
    assert.equal(conn.ok, true, conn.error);
    assert.equal(conn.tools.length, BLENDER_TOOLS.length);
    const out = join(root, 'assets', 'tree.glb');
    const r = await callMcpTool([conn], namespacedName('blender', 'export_scene'), { filepath: out });
    assert.equal(r.ok, true);
    assert.ok(existsSync(out));
    assert.equal(readFileSync(out).subarray(0, 4).toString('ascii'), 'glTF');
  } finally {
    closeConnections([conn]);
    try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* Windows holds the dead child cwd briefly */ }
  }
});

test('⭐ doctor: a declared Blender server gets an add-on port check that can say both things', async () => {
  const server = { name: 'blender', command: 'uvx', args: ['mcp-for-blender'], env: {} };
  assert.equal(looksLikeBlenderServer(server), true);
  assert.equal(looksLikeBlenderServer({ command: 'uvx', args: ['blender-mcp'] }), true);
  assert.equal(looksLikeBlenderServer({ command: 'npx', args: ['-y', 'tavily-mcp'] }), false);

  const down = await blenderAddonCheck(server, { probeImpl: async () => false });
  assert.equal(down.state, 'dark');
  assert.match(down.detail, /localhost:9876/);
  assert.match(down.fix, /install-addon/);

  let asked = null;
  const up = await blenderAddonCheck({ ...server, env: { BLENDER_PORT: '9999' } }, {
    probeImpl: async (h, p) => { asked = `${h}:${p}`; return true; },
  });
  assert.equal(up.state, 'live');
  assert.equal(asked, 'localhost:9999');
});

test('doctor: uv tool installs are found by receipt, and the catalogue row uses them', () => {
  const seen = [];
  const found = installedUvTools({
    env: { APPDATA: 'C:/AppData' },
    packages: ['mcp-for-blender'],
    platform: 'win32',
    existsImpl: (p) => { seen.push(p.replace(/\\/g, '/')); return p.replace(/\\/g, '/') === 'C:/AppData/uv/tools/mcp-for-blender/uv-receipt.toml'; },
  });
  assert.deepEqual([...found], ['mcp-for-blender']);

  const rows = mcpCatalogueChecks({
    env: {},
    installedImpl: () => new Set(),
    uvToolsImpl: () => new Set(['mcp-for-blender']),
  });
  assert.equal(rows.find((r) => r.id === 'mcp.catalogue.blender')?.state, 'live');
});
