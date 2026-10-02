import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveServer, mergeServer, normaliseServerName, KNOWN_SERVERS } from '../lib/mcp-add.mjs';
import { readMcpConfig } from '../lib/mcp.mjs';

test('⭐⭐⭐ a nickname becomes a config the LOADER accepts', () => {
  /**
   * The whole point of this command is that a user never hand-authors JSON. So
   * the test that matters is not "did it write a file" — it is "does the file
   * it wrote parse in `lib/mcp.mjs`". A config only this module understands is
   * the same defect as no command at all.
   */
  const r = resolveServer('playwright', { workspace: '/w' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.name, 'playwright');
  // Headless, in-memory profile, Playwright's own Chromium — never the user's Chrome.
  assert.deepEqual(r.entry, { command: 'npx', args: ['-y', '@playwright/mcp', '--', '--headless', '--isolated', '--browser', 'chromium'] });
});

test('⭐⭐ filesystem gets a ROOT, because without one it serves nothing', () => {
  const r = resolveServer('filesystem', { workspace: '/my/project' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry.args, ['-y', '@modelcontextprotocol/server-filesystem', '/my/project']);
});

test('⚠️ a server that needs a token SAYS SO, rather than failing at connect time', () => {
  const r = resolveServer('github');
  assert.equal(r.ok, true);
  assert.match(r.note, /GITHUB_PERSONAL_ACCESS_TOKEN/);
  assert.equal(r.entry.env.GITHUB_PERSONAL_ACCESS_TOKEN, '${GITHUB_PERSONAL_ACCESS_TOKEN}');
});

test('⭐ a bare npm package works — the list is a shortcut, not a whitelist', () => {
  /**
   * `@21st-dev/magic` is a real server this repo has hit before. The curated
   * list must never become the limit of what can be added, or the ecosystem
   * stops being the point.
   */
  const r = resolveServer('@21st-dev/magic');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.entry.args, ['-y', '@21st-dev/magic']);
  assert.equal(r.name, '21st-dev_magic', 'the @ and / are normalised exactly as the loader does');
});

test('⚠️⚠️ THE NAME MATCHES WHAT THE LOADER WILL DO WITH IT', () => {
  /**
   * `lib/mcp.mjs` normalises names on read, including collapsing `_{2,}` —
   * which is a SECURITY line there, since `__` is the namespace separator
   * between a server and its tool. If this module wrote a name the loader then
   * mangled, the user's config would silently stop matching what they typed.
   */
  for (const raw of ['@scope/pkg', 'weird!!name', '@a//b', '___lead']) {
    assert.equal(normaliseServerName(raw), normaliseServerName(normaliseServerName(raw)),
      `normalising twice must not change ${raw}`);
    assert.ok(!normaliseServerName(raw).includes('__'), `${raw} must not survive with a double underscore`);
  }
});

test('⚠️⚠️ a path is not a package — npx runs what it is given', () => {
  for (const evil of ['../../etc/passwd', './local/thing', '/abs/path', 'a b c']) {
    const r = resolveServer(evil);
    assert.equal(r.ok, false, `must refuse: ${evil}`);
  }
});

test('⭐ a URL becomes a remote server, named after its HOST', () => {
  const http = resolveServer('https://mcp.example.com/api');
  assert.equal(http.ok, true);
  assert.equal(http.name, 'mcp');
  assert.equal(http.entry.type, 'http');

  /**
   * ⚠️ `/sse` picks the sse transport. Getting this wrong is a connection that
   * hangs rather than one that fails, which is the harder kind to diagnose.
   */
  const sse = resolveServer('https://mcp.example.com/sse');
  assert.equal(sse.entry.type, 'sse');
});

test('⚠️ overwriting an existing server needs --replace', () => {
  const cfg = { mcpServers: { playwright: { command: 'npx', args: ['-y', 'custom-fork'] } } };
  const blocked = mergeServer(cfg, 'playwright', { command: 'npx', args: ['-y', '@playwright/mcp'] });
  assert.equal(blocked.ok, false);
  // ⚠️ `--replace`, NOT `--force`: a collision guard caught `--force` already
  // being claimed by `rewind`, and one flag meaning two things depending on the
  // subcommand is how a destructive option gets typed by accident.
  assert.match(blocked.error, /--replace/);

  const forced = mergeServer(cfg, 'playwright', { command: 'npx', args: ['-y', '@playwright/mcp'] }, { force: true });
  assert.equal(forced.ok, true);
  assert.deepEqual(forced.config.mcpServers.playwright.args, ['-y', '@playwright/mcp']);
});

test('⚠️ a legacy "servers" key is migrated, never left alongside "mcpServers"', () => {
  // Two keys in one file is a file where nobody can tell which one is live.
  const merged = mergeServer({ servers: { old: { command: 'x', args: [] } } }, 'new', { command: 'npx', args: ['-y', 'p'] });
  assert.equal(merged.ok, true);
  assert.ok(merged.config.mcpServers.old, 'the existing server survives the migration');
  assert.ok(merged.config.mcpServers.new);
  assert.equal(merged.config.servers, undefined, 'the legacy key is gone');
});

test('⭐⭐⭐ END TO END: what we write is what lib/mcp.mjs reads back', async (t) => {
  /**
   * The only test that proves the command works. Everything above checks a
   * shape; this one hands the real loader a real file.
   */
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = mkdtempSync(join(tmpdir(), 'acuvo-mcp-add-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });

  let config = {};
  for (const nickname of Object.keys(KNOWN_SERVERS)) {
    const r = resolveServer(nickname, { workspace: root });
    assert.equal(r.ok, true, `${nickname}: ${r.error}`);
    const merged = mergeServer(config, r.name, r.entry);
    assert.equal(merged.ok, true, `${nickname}: ${merged.error}`);
    config = merged.config;
  }
  writeFileSync(join(root, '.acuvo', 'mcp.json'), JSON.stringify(config, null, 2), 'utf8');

  const loaded = readMcpConfig(root);
  assert.equal(loaded.ok, true, `the loader rejected our own config: ${loaded.error}`);
  assert.equal(
    loaded.servers.length,
    Object.keys(KNOWN_SERVERS).length,
    'every server we wrote must survive the round trip',
  );
});
