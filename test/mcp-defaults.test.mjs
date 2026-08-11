/**
 * ── MCP DEFAULTS — THE TESTS ARE THE HONESTY RULES ──────────────────────────
 *
 * This module's risk is not that it computes something wrong. It is that it
 * grows: someone adds eight servers off a README, marks them enabled because
 * they "obviously work", and every user pays a 20-second timeout per entry at
 * session start for capabilities that were never once run.
 *
 * So most of what follows are INVARIANTS over the catalogue rather than tests
 * of a function. They fail when the DATA becomes dishonest, which is the only
 * way this file can actually hurt anyone.
 *
 * ⚠️ AND THE LAST TEST SPAWNS A REAL SERVER. The catalogue's whole claim is
 * "this works out of the box"; an assertion about a JSON shape cannot check
 * that. It renders the config, reads it back through the real `readMcpConfig`,
 * and connects through the real `connectServer`. No network, no model, no key.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CATALOGUE,
  PACKAGE_ROOT,
  PACKAGE_ROOT_TOKEN,
  MAX_SERVERS,
  DARK_ENTRY_COST_MS,
  STARTER_CONFIG_FILE,
  catalogueEntry,
  resolveArgs,
  toServerSpec,
  requiredCredentials,
  packageOf,
  assessEntry,
  assessCatalogue,
  defaultServerSpecs,
  renderStarterConfig,
  renderStarterConfigJson,
  formatAvailability,
  doctorChecks,
} from '../lib/mcp-defaults.mjs';

import { readMcpConfig, connectServer, closeConnections, mcpToolSchemas } from '../lib/mcp.mjs';
import { DOCTOR_STATES } from '../lib/doctor.mjs';
import { rmDirWithRetry } from './_teardown.mjs';

/* ─────────────────────────── THE HONESTY INVARIANTS ─────────────────────── */

test('⭐⭐ nothing unverified, downloadable or credentialed is ever a default', () => {
  /**
   * The one rule the whole module exists to keep. Each clause was measured:
   * a download-needing entry CANNOT install (npx gets `--no`), and a
   * credential-needing entry cannot start — and both cost the full 20s
   * handshake before saying so.
   */
  for (const e of CATALOGUE) {
    if (!e.enabledByDefault) continue;
    assert.equal(e.verified, true, `"${e.name}" is enabled by default but nobody ran it`);
    assert.equal(e.needsDownload, false, `"${e.name}" is enabled by default but needs a download this client cannot perform`);
    assert.deepEqual(
      requiredCredentials(e).map((c) => c.env),
      [],
      `"${e.name}" is enabled by default but cannot start without credentials`,
    );
  }
});

test('every entry that needs a download carries the exact install command', () => {
  for (const e of CATALOGUE) {
    if (!e.needsDownload) {
      assert.equal(e.install, null, `"${e.name}" needs no download but names an install command`);
      continue;
    }
    assert.equal(typeof e.install, 'string', `"${e.name}" needs a download but has no install command`);
    assert.ok(e.install.trim().length > 0, `"${e.name}" has an empty install command`);
    assert.ok(packageOf(e), `"${e.name}" needs a download but names no package`);
  }
});

test('every entry states what it is, what it needs, and whether we ran it', () => {
  assert.ok(CATALOGUE.length > 0, 'an empty catalogue is not a feature');
  for (const e of CATALOGUE) {
    assert.ok(e.purpose && e.purpose.length > 20, `"${e.name}" has no honest purpose line`);
    assert.ok(e.note && e.note.length > 20, `"${e.name}" does not say what happened when it was (or was not) run`);
    assert.equal(typeof e.verified, 'boolean', `"${e.name}" is ambiguous about verification`);
    assert.equal(typeof e.command, 'string');
    assert.ok(Array.isArray(e.args));
    for (const c of e.credentials) {
      assert.ok(c.env && /^[A-Z0-9_]+$/.test(c.env), `"${e.name}" has a credential with no usable env var name`);
      assert.equal(typeof c.required, 'boolean', `"${e.name}" credential ${c.env} does not say if it is required`);
      assert.ok(c.why && c.why.length > 5, `"${e.name}" credential ${c.env} does not say why it matters`);
    }
  }
});

test('an unverified entry says so in its note — it cannot look measured', () => {
  for (const e of CATALOGUE) {
    if (e.verified) continue;
    assert.match(
      e.note,
      /NOT RUN/,
      `"${e.name}" is unverified but its note does not say so — that reads as a measurement`,
    );
  }
});

/* ─────────────────────────── ARG RESOLUTION ─────────────────────────────── */

test('the package-root token is substituted, and never survives into output', () => {
  const acuvo = catalogueEntry('acuvo');
  assert.ok(acuvo, 'the one entry we ship went missing');
  assert.ok(acuvo.args.some((a) => a.includes(PACKAGE_ROOT_TOKEN)), 'fixture drift: acuvo no longer uses the token');

  const resolved = resolveArgs(acuvo, { packageRoot: '/opt/acuvo' });
  assert.deepEqual(resolved, ['/opt/acuvo/bin/acuvo-mcp.mjs']);

  const rendered = JSON.stringify(renderStarterConfig({ env: {} }));
  assert.ok(!rendered.includes(PACKAGE_ROOT_TOKEN), 'an unsubstituted token reached the rendered config');
});

test('a Windows path is normalised to forward slashes, so the JSON stays readable', () => {
  const acuvo = catalogueEntry('acuvo');
  const resolved = resolveArgs(acuvo, { packageRoot: 'C:\\Projects\\acuvo-code' });
  assert.deepEqual(resolved, ['C:/Projects/acuvo-code/bin/acuvo-mcp.mjs']);
  assert.ok(!resolved[0].includes(String.fromCharCode(92)), 'a backslash would need escaping in JSON a human edits');
});

test('toServerSpec produces exactly the shape connectServer consumes', () => {
  const spec = toServerSpec(catalogueEntry('acuvo'), { packageRoot: '/opt/acuvo' });
  assert.deepEqual(Object.keys(spec).sort(), ['args', 'command', 'env', 'name']);
  assert.equal(spec.command, 'node');
  assert.deepEqual(spec.args, ['/opt/acuvo/bin/acuvo-mcp.mjs']);
});

/* ─────────────────────────── THE PRECHECK ──────────────────────────────── */

test('a missing required credential is dark, and the reason names the variable', () => {
  const firecrawl = catalogueEntry('firecrawl');
  const a = assessEntry(firecrawl, { env: {}, installed: new Set([packageOf(firecrawl)]) });
  assert.equal(a.state, 'dark');
  assert.match(a.detail, /FIRECRAWL_API_KEY/);
  assert.match(a.fix, /FIRECRAWL_API_KEY/);
});

test('⭐ the dark reason quotes the 20s cost — the number that justifies the rule', () => {
  const a = assessEntry(catalogueEntry('firecrawl'), {
    env: {},
    installed: new Set([packageOf(catalogueEntry('firecrawl'))]),
  });
  assert.match(a.fix, new RegExp(`${Math.round(DARK_ENTRY_COST_MS / 1000)}s`));
  assert.equal(a.costMs, DARK_ENTRY_COST_MS);
});

test('a needed download outranks a missing key — you cannot configure a package that is absent', () => {
  /**
   * firecrawl needs BOTH. With nothing installed the report must talk about the
   * install, because telling the user to set a key for a package that is not
   * there sends them to fix the second problem first.
   */
  const a = assessEntry(catalogueEntry('firecrawl'), { env: {}, installed: new Set() });
  assert.equal(a.state, 'dark');
  assert.match(a.detail, /not installed/);
  assert.ok(!/FIRECRAWL_API_KEY is not set/.test(a.detail), 'led with the key while the package is missing');
});

test('an unknown install state is reported as unknown, not as installed', () => {
  // ⚠️ The dangerous default would be assuming presence: it turns a 20s stall
  // into a surprise. With no Set injected the answer must stay hedged.
  const a = assessEntry(catalogueEntry('filesystem'), { env: {}, installed: null });
  assert.equal(a.state, 'dark');
  assert.match(a.detail, /was not checked/);
});

test('an installed, credential-free entry is live', () => {
  const fs = catalogueEntry('filesystem');
  const a = assessEntry(fs, { env: {}, installed: new Set([packageOf(fs)]) });
  assert.equal(a.state, 'live');
  assert.equal(a.costMs, 0);
});

test('optional credentials do not darken an entry, but are named as a smaller surface', () => {
  const a = assessEntry(catalogueEntry('acuvo'), { env: {} });
  assert.equal(a.state, 'live', 'acuvo starts fine with no endpoints — it serves an empty tool list');
  assert.match(a.detail, /fewer tools/);
  assert.match(a.fix, /RENDER_AUDIT_URL/);
});

test('with the optional endpoints set, nothing is left to mention', () => {
  const a = assessEntry(catalogueEntry('acuvo'), {
    env: { RENDER_AUDIT_URL: 'https://r', MODAL_PRESS_URL: 'https://p', MODAL_VIDEO_SECRET: 's' },
  });
  assert.equal(a.state, 'live');
  assert.equal(a.fix, null);
  assert.match(a.detail, /nothing checkable rules it out/);
});

test('whitespace is not a credential', () => {
  // ⚠️ `FIRECRAWL_API_KEY=` in a .env file yields '' and `=" "` yields a space.
  // Treating either as set would produce a confident 20s failure.
  const fc = catalogueEntry('firecrawl');
  const installed = new Set([packageOf(fc)]);
  for (const value of ['', '   ']) {
    assert.equal(assessEntry(fc, { env: { FIRECRAWL_API_KEY: value }, installed }).state, 'dark', `"${value}" was accepted as a key`);
  }
  assert.equal(assessEntry(fc, { env: { FIRECRAWL_API_KEY: 'fc-real' }, installed }).state, 'live');
});

/* ─────────────────────────── THE RENDERED CONFIG ───────────────────────── */

test('only entries that are both a default and live are rendered active', () => {
  const cfg = renderStarterConfig({ env: {} });
  const active = Object.keys(cfg.mcpServers);
  assert.deepEqual(active, ['acuvo'], 'the active set changed — was a new default proven, or just assumed?');
  for (const name of active) {
    const e = catalogueEntry(name);
    assert.equal(e.verified, true);
    assert.equal(e.needsDownload, false);
  }
});

test('⭐ an unverified entry can never reach mcpServers, whatever the environment', () => {
  /**
   * The catalogue's unverified entries all need downloads today, so this could
   * pass by accident. Force the issue: mark every package installed and set
   * every credential, then assert they are STILL inactive.
   */
  const env = {};
  const installed = new Set();
  for (const e of CATALOGUE) {
    const pkg = packageOf(e);
    if (pkg) installed.add(pkg);
    for (const c of e.credentials) env[c.env] = 'set-for-this-test';
  }
  const cfg = renderStarterConfig({ env, installed });
  for (const name of Object.keys(cfg.mcpServers)) {
    assert.equal(catalogueEntry(name).verified, true, `unverified "${name}" was rendered active`);
  }
});

test('every inactive entry is documented with why it is off and how to turn it on', () => {
  const cfg = renderStarterConfig({ env: {} });
  const active = new Set(Object.keys(cfg.mcpServers));
  for (const e of CATALOGUE) {
    if (active.has(e.name)) continue;
    const d = cfg._disabled[e.name];
    assert.ok(d, `"${e.name}" is off and unexplained`);
    assert.ok(d.why_off && d.why_off.length > 5, `"${e.name}" does not say why it is off`);
    assert.ok(d.to_enable, `"${e.name}" does not say how to turn it on`);
    assert.equal(d.verified_by_us, e.verified);
  }
});

test('the config warns that a stalled server costs real seconds', () => {
  const cfg = renderStarterConfig({ env: {} });
  assert.match(cfg._readme, new RegExp(`${Math.round(DARK_ENTRY_COST_MS / 1000)}s`));
  assert.match(cfg._readme, new RegExp(String(MAX_SERVERS)));
});

test('the rendered JSON is valid, parses back, and ends with a newline', () => {
  const text = renderStarterConfigJson({ env: {} });
  assert.ok(text.endsWith('\n'));
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed.mcpServers), ['acuvo']);
});

test('the active set never exceeds what readMcpConfig will actually read', () => {
  // readMcpConfig `break`s past MAX_SERVERS with no error at all, so an
  // over-long render would be silently truncated.
  const cfg = renderStarterConfig({ env: {} });
  assert.ok(Object.keys(cfg.mcpServers).length <= MAX_SERVERS);
});

test('defaultServerSpecs drops a default that is dark right now', () => {
  /**
   * ⚠️ THE TWO CONDITIONS ARE DIFFERENT THINGS and this is the test that keeps
   * them apart: `enabledByDefault` is about the catalogue, `live` is about this
   * machine. Pretend acuvo needs an install it does not have.
   */
  const specs = defaultServerSpecs({ env: {} });
  assert.deepEqual(specs.map((s) => s.name), ['acuvo']);

  const acuvo = catalogueEntry('acuvo');
  const pretendDark = assessEntry(
    { ...acuvo, needsDownload: true, install: 'npm i -g nope' },
    { env: {}, installed: new Set() },
  );
  assert.equal(pretendDark.state, 'dark', 'the precheck cannot detect a dark default');
});

/* ─────────────────────────── REPORTING SEAMS ───────────────────────────── */

test('doctorChecks speak the doctor\'s own vocabulary', () => {
  const checks = doctorChecks({ env: {} });
  assert.ok(checks.length >= 2);
  for (const c of checks) {
    assert.ok(DOCTOR_STATES.includes(c.state), `"${c.state}" is not a doctor state`);
    assert.equal(typeof c.id, 'string');
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.detail, 'string');
    assert.ok(c.fix === null || typeof c.fix === 'string');
  }
  assert.equal(checks[0].id, 'mcp.defaults');
  assert.match(checks[0].detail, /usable here/);
});

test('the doctor summary counts what is usable, and names it', () => {
  const [summary] = doctorChecks({ env: {} });
  assert.equal(summary.state, 'live');
  assert.match(summary.detail, /acuvo/);
});

test('formatAvailability shows every entry with a reason', () => {
  const text = formatAvailability({ env: {} });
  for (const e of CATALOGUE) assert.ok(text.includes(e.name), `"${e.name}" is missing from the report`);
  assert.match(text, /usable here/);
  assert.match(text, /unverified — never enabled/);
});

test('assessCatalogue is stable in order, so output does not churn', () => {
  const a = assessCatalogue({ env: {} }).map((r) => r.entry);
  const b = assessCatalogue({ env: {} }).map((r) => r.entry);
  assert.deepEqual(a, b);
  assert.deepEqual(a, CATALOGUE.map((e) => e.name));
});

/* ────────────────── ⭐⭐ THE ONE THAT ACTUALLY PROVES THE CLAIM ─────────── */

test('⭐⭐ the rendered default config round-trips through readMcpConfig and CONNECTS', async (t) => {
  /**
   * Everything above checks a shape. This checks the promise: write the file we
   * tell users to write, read it with the real reader, spawn it with the real
   * client, and get a live session back. Offline, free, no model.
   */
  if (!existsSync(join(PACKAGE_ROOT, 'bin', 'acuvo-mcp.mjs'))) {
    t.skip('the shipped MCP server is not on disk in this checkout');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'acuvo-mcpdef-'));
  const conns = [];
  try {
    mkdirSync(join(dir, '.acuvo'), { recursive: true });
    writeFileSync(join(dir, STARTER_CONFIG_FILE), renderStarterConfigJson({ env: {} }));

    // 1. the real reader accepts it, and every server name survives validation
    const cfg = readMcpConfig(dir);
    assert.equal(cfg.ok, true, `the config we generate is rejected by our own reader: ${cfg.error}`);
    assert.equal(cfg.file, STARTER_CONFIG_FILE);
    assert.deepEqual(cfg.servers.map((s) => s.name), ['acuvo'], 'the reader saw a different set than we rendered');

    // 2. `_disabled` is inert — documentation must never become a spawned process
    assert.equal(cfg.servers.length, Object.keys(renderStarterConfig({ env: {} }).mcpServers).length);

    // 3. the real client connects to it
    for (const s of cfg.servers) {
      const conn = await connectServer(s, { root: dir });
      assert.equal(conn.ok, true, `the default server "${s.name}" did not start: ${conn.error}`);
      conns.push(conn);
    }

    // 4. and the tool surface it exposes is namespaced, so it can never shadow ours
    for (const schema of mcpToolSchemas(conns)) {
      const name = schema.function?.name ?? schema.name;
      assert.match(name, /^mcp__acuvo__/, `"${name}" escaped the namespace`);
    }
  } finally {
    closeConnections(conns);
    await rmDirWithRetry(dir);
  }
});
