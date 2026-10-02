/**
 * ── ⭐⭐⭐ DISCOVERY IS A QUERY, NOT A DATA FILE ─────────────────────────────
 *
 * `acuvo mcp add` has always accepted any npm package, so every MCP server on
 * the registry was ALREADY reachable. What was missing is that nobody could
 * find them — you had to already know the package name. A capability that
 * exists and cannot be found is this repo's oldest defect, in registry form.
 *
 * ⚠️ AND THE FIX IS NOT A HARDCODED LIST OF 120 SERVERS. That is stale the week
 * it ships and silently omits everything published afterwards. npm already
 * maintains this list and its search API needs no key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchServers, looksLikeServer, scoreResult, formatResults } from '../lib/mcp-search.mjs';

/** A fake npm, so every rule here is provable without a network. */
const npm = (packages) => async () => ({
  ok: true,
  json: async () => ({ objects: packages.map((p) => ({ package: p })) }),
});

test('⭐ a real subject returns servers, best first', async () => {
  const out = await searchServers('notion', {
    fetchImpl: npm([
      { name: 'random-helper', description: 'unrelated', version: '1.0.0', score: 0.9 },
      { name: '@notionhq/notion-mcp-server', description: 'Official MCP server for Notion API', version: '2.5.1', score: 0.5 },
      { name: 'notion-mcp-server', description: 'a fork', version: '2.13.0', score: 0.8 },
    ]),
  });
  assert.equal(out.ok, true);
  // The vendor's own scope beats a more-downloaded third-party fork.
  assert.equal(out.results[0].name, '@notionhq/notion-mcp-server');
});

test('⚠️⚠️ the SDK is never offered as a server', () => {
  /**
   * `@modelcontextprotocol/server` is the package you import to BUILD a server.
   * It matched every single query and outranked `@stripe/mcp` for "stripe"
   * until it was excluded outright.
   */
  assert.equal(scoreResult({ name: '@modelcontextprotocol/server', score: 1 }, 'stripe'), -1);
  assert.equal(scoreResult({ name: '@modelcontextprotocol/sdk', score: 1 }, 'stripe'), -1);
});

test('⭐ the reference implementation outranks any fork', () => {
  const official = scoreResult({ name: '@modelcontextprotocol/server-github', score: 0.1 }, 'github');
  const fork = scoreResult({ name: '@someone/github-mcp-server', score: 0.99 }, 'github');
  assert.ok(official > fork, `official ${official} should beat fork ${fork}`);
});

test('⚠️ a package that merely mentions MCP is not a server', () => {
  assert.equal(looksLikeServer({ name: 'my-mcp-server', description: '' }), true);
  assert.equal(looksLikeServer({ name: '@modelcontextprotocol/server-slack', description: '' }), true);
  assert.equal(looksLikeServer({ name: 'left-pad', description: 'pads strings' }), false);
});

test('⚠️⚠️ no results is OK:true — "nothing exists" is not "the search failed"', async () => {
  /**
   * A script that conflates these retries a query that can never succeed.
   */
  const out = await searchServers('zzzznotathing', { fetchImpl: npm([]) });
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 0);
  assert.match(out.error, /no MCP server found/);
  // It still names the way out: `mcp add <package>` works regardless.
  assert.match(out.error, /mcp add/);
});

test('⚠️ a dead registry reports a failure, not an empty shelf', async () => {
  const out = await searchServers('notion', { fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(out.ok, false);
  assert.match(out.error, /503/);
});

test('⚠️ an empty subject asks for one rather than searching for nothing', async () => {
  const out = await searchServers('   ', { fetchImpl: npm([]) });
  assert.equal(out.ok, false);
  assert.match(out.error, /what you are looking for/);
});

test('⚠️⚠️ the output ALWAYS says results are unvetted', async () => {
  /**
   * An MCP server runs on this machine with the user's privileges, and anyone
   * may publish a package called `slack-mcp`. The line that says so is the
   * difference between a tool and a supply-chain footgun.
   */
  const out = await searchServers('notion', {
    fetchImpl: npm([{ name: 'notion-mcp', description: 'x', version: '1.0.0', score: 0.5 }]),
  });
  const text = formatResults(out, 'notion');
  assert.match(text, /not vetted by us/);
  assert.match(text, /your privileges/);
});

test('⭐ a curated server we have actually run is marked and leads', async () => {
  const out = await searchServers('github', {
    fetchImpl: npm([{ name: 'someone-elses-github-mcp', description: 'a fork', version: '9.9.9', score: 0.99 }]),
  });
  assert.equal(out.results[0].curated, true);
  assert.match(out.results[0].description, /verified by us/);
});
