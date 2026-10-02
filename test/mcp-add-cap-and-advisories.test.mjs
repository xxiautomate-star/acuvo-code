/**
 * ── TWO DEFECTS ON THE ROAD FROM "I HEARD ABOUT AN MCP SERVER" TO "THE MODEL
 *    JUST USED IT" ─────────────────────────────────────────────────────────
 *
 * Both were measured through the real code on 2026-08-25 before being fixed,
 * and both are the same shape: this package already KNEW the fact, and the
 * command the user actually types had never been told.
 *
 *   1. THE NINTH SERVER. `readMcpConfig` stops at `MAX_SERVERS` with a bare
 *      `break` — `ok: true`, no error. `mergeServer` appends the new key last,
 *      so the entry dropped is always the one just added. `acuvo mcp add`
 *      printed "added" and the loader agreed everything was fine.
 *
 *   2. THE CANARY. `mcp-defaults.mjs` researched npm `mcp-server-git`, found a
 *      self-described dependency-confusion probe, and removed it from the
 *      catalogue — in a comment. `mcp search` listed it and `mcp add` wrote it.
 *
 * ⚠️ THE TESTS BELOW GO THROUGH `readMcpConfig`, NOT THROUGH AN ASSERTION ABOUT
 * A RETURN SHAPE. A cap enforced by this module and disagreed with by the loader
 * is the drift the whole fix exists to stop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveServer, mergeServer, KNOWN_SERVERS } from '../lib/mcp-add.mjs';
import { searchServers, formatResults } from '../lib/mcp-search.mjs';
import { packageAdvisory, PACKAGE_ADVISORIES } from '../lib/mcp-defaults.mjs';
import { readMcpConfig, MAX_SERVERS } from '../lib/mcp.mjs';

/** Fill a config to exactly the loader's cap, using the curated nicknames. */
function configAtCap() {
  let config = {};
  let n = 0;
  for (const nickname of Object.keys(KNOWN_SERVERS)) {
    if (n >= MAX_SERVERS) break;
    const r = resolveServer(nickname, { workspace: '/w' });
    if (!r.ok) continue; // an advisory may refuse one; the cap test does not need it
    const merged = mergeServer(config, r.name, r.entry);
    if (!merged.ok) break;
    config = merged.config;
    n += 1;
  }
  // Top up with synthetic entries if the curated list is shorter than the cap.
  while (Object.keys(config.mcpServers ?? {}).length < MAX_SERVERS) {
    const name = `filler${Object.keys(config.mcpServers ?? {}).length}`;
    const merged = mergeServer(config, name, { command: 'npx', args: ['-y', 'x-mcp'] });
    assert.equal(merged.ok, true, merged.error);
    config = merged.config;
  }
  return config;
}

test('⚠️⚠️ THE NINTH SERVER IS REFUSED, because the loader would drop it in silence', () => {
  const config = configAtCap();
  assert.equal(Object.keys(config.mcpServers).length, MAX_SERVERS);

  const extra = resolveServer('@21st-dev/magic');
  assert.equal(extra.ok, true, extra.error);

  const merged = mergeServer(config, extra.name, extra.entry);
  assert.equal(merged.ok, false, 'writing an entry that can never load must not report success');
  assert.equal(merged.atCap, true);
  assert.match(merged.error, new RegExp(String(MAX_SERVERS)), 'the message names the actual cap');
  assert.match(merged.error, /never loads/i);
  assert.match(merged.error, /Remove one/i, 'a refusal without a remedy is just a wall');
});

test('⚠️⚠️ REACH: the refusal matches what readMcpConfig actually does with a 9th entry', () => {
  /**
   * The proof that the cap is not an invented policy: bypass `mergeServer` and
   * hand the loader a config with MAX_SERVERS + 1 servers. If the loader ever
   * starts accepting them, THIS test fails and the refusal above becomes wrong —
   * which is the correct way round for a guard to break.
   */
  const config = configAtCap();
  const ninth = { ...config, mcpServers: { ...config.mcpServers, ninth_server: { command: 'npx', args: ['-y', 'x-mcp'] } } };

  const root = mkdtempSync(join(tmpdir(), 'acuvo-mcp-cap-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'mcp.json'), JSON.stringify(ninth, null, 2), 'utf8');

  const loaded = readMcpConfig(root);
  assert.equal(loaded.ok, true, 'the loader still reports success — that is the whole problem');
  assert.equal(loaded.servers.length, MAX_SERVERS);
  assert.equal(
    loaded.servers.some((s) => s.name === 'ninth_server'),
    false,
    'the 9th server is dropped with no error, which is why mergeServer must refuse it up front',
  );
});

test('⭐ replacing a server at the cap is still allowed — it does not grow the count', () => {
  const config = configAtCap();
  const existing = Object.keys(config.mcpServers)[0];
  const merged = mergeServer(config, existing, { command: 'npx', args: ['-y', 'replacement-mcp'] }, { force: true });
  assert.equal(merged.ok, true, merged.error);
  assert.equal(Object.keys(merged.config.mcpServers).length, MAX_SERVERS);
  assert.deepEqual(merged.config.mcpServers[existing].args, ['-y', 'replacement-mcp']);
});

test('⚠️⚠️ `mcp add mcp-server-git` IS REFUSED — our own research finally reaches the user', () => {
  const r = resolveServer('mcp-server-git');
  assert.equal(r.ok, false, 'a self-described security canary must never be written into a spawnable config');
  assert.match(r.error, /canary/i);
  assert.match(r.error, /npx-canary/, 'the message cites the repository, so the claim is checkable');
  assert.match(r.error, /git_status|git_diff|git_log|git_commit/, 'and says what to use instead');
});

test('⚠️ a DEPRECATED package is warned about, never refused — it still works today', () => {
  /**
   * The distinction is the point. Refusing `@modelcontextprotocol/server-github`
   * would break configs that are fine, so the advisory rides in the note that
   * the CLI already prints.
   */
  const r = resolveServer('github');
  assert.equal(r.ok, true, r.error);
  assert.match(r.note, /GITHUB_PERSONAL_ACCESS_TOKEN/, 'the existing env guidance is untouched');
  assert.match(r.note, /deprecated/i);
  assert.equal(r.advisory.severity, 'warn');

  const pg = resolveServer('postgres');
  assert.equal(pg.ok, true, pg.error);
  assert.match(pg.note, /deprecated/i);
});

test('⭐ the advisory matches on the EXACT package name, never on a prefix', () => {
  /**
   * `mcp-server-github` must not be caught on its way to matching
   * `mcp-server-git`. A false refusal carrying a security message is one the
   * user has no way to argue with.
   */
  assert.equal(packageAdvisory('mcp-server-git')?.severity, 'refuse');
  assert.equal(packageAdvisory('mcp-server-github'), null);
  assert.equal(packageAdvisory('mcp-server-gitlab'), null);
  assert.equal(packageAdvisory(''), null);
  assert.equal(packageAdvisory(undefined), null);

  // ⚠️ Not a blocklist. Three checked facts, and it must stay that size.
  assert.ok(Object.keys(PACKAGE_ADVISORIES).length <= 5, 'this is a checked-facts list, not a blocklist');
});

test('⚠️⚠️ `mcp search` NEVER OFFERS A REFUSED PACKAGE — and says why it withheld it', async () => {
  /**
   * The npm payload shape, injected. The canary really does rank here: its
   * basename is `mcp-server-git`, which is exactly the `mcp-server-<subject>`
   * form `scoreResult` gives a +20 bonus to.
   */
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      objects: [
        { package: { name: 'mcp-server-git', description: 'Security research canary', version: '0.0.2', score: 0.9 } },
        { package: { name: '@cyanheads/git-mcp-server', description: 'MCP server for git', version: '2.3.2', score: 0.1 } },
      ],
    }),
  });

  const out = await searchServers('git', { fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(
    out.results.some((r) => r.name === 'mcp-server-git'),
    false,
    'a package we refuse to add must not appear in the list we tell people to add from',
  );
  assert.equal(out.withheld.length, 1);
  assert.equal(out.withheld[0].name, 'mcp-server-git');

  const text = formatResults(out, 'git');
  assert.match(text, /Withheld: mcp-server-git/);
  assert.match(text, /canary/i);
  assert.doesNotMatch(
    text.split('Add one:')[1] ?? '',
    /mcp-server-git/,
    'the paste-this line can never name the withheld package',
  );
});

test('⚠️ a query whose ONLY hit is refused still explains itself', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      objects: [{ package: { name: 'mcp-server-git', description: 'canary', version: '0.0.2', score: 0.9 } }],
    }),
  });
  const out = await searchServers('git', { fetchImpl });
  assert.equal(out.results.length, 0);
  const text = formatResults(out, 'git');
  assert.match(text, /no MCP server found/i);
  assert.match(text, /Withheld: mcp-server-git/, 'without this the user searches npm directly and adds it by hand');
});

test('⭐ a deprecated package is LABELLED in search results, not hidden', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      objects: [{ package: { name: '@modelcontextprotocol/server-github', description: 'GitHub MCP', version: '2025.4.8', score: 0.9 } }],
    }),
  });
  const out = await searchServers('github', { fetchImpl });
  assert.equal(out.results[0].name, '@modelcontextprotocol/server-github');
  assert.match(out.results[0].advisory, /deprecated/i);
  assert.match(formatResults(out, 'github'), /deprecated/i);
});
