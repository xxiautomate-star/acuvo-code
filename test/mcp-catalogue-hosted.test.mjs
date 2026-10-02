/**
 * ── ⭐⭐⭐ THE HOSTED HALF OF THE CATALOGUE, AND THE TWO LISTS THAT DRIFTED ───
 *
 * Two things happened on 2026-08-25 and this file holds both of them still.
 *
 * **1. The catalogue grew a transport it already had.** `lib/mcp.mjs` learned
 * Streamable HTTP on 2026-08-15. `lib/mcp-defaults.mjs` — whose every rule is
 * arithmetic about SPAWNING A PROCESS — did not notice for ten days, and stayed
 * a list of eight programs of which exactly ONE was usable on a plain machine.
 * Seven hosted servers were then connected AND called with an empty environment,
 * each in under two seconds, needing no download and no account. The doctor's
 * own line moved from "1 of 6 servers we have run ourselves are usable here" to
 * seven of twelve on a bare workspace.
 *
 * ⚠️ THE RULES DID NOT GET LOOSER, THEY GOT MEASURED. Nothing here is enabled by
 * default, because a hosted server sees the query text and that is an egress
 * decision belonging to the user. What changed is the COST SENTENCE: an
 * unconfigured stdio server holds the session for 20,052ms, an unconfigured
 * hosted one answers 401 in 118–741ms. Quoting the stdio number at a hosted
 * entry is the pessimistic kind of stale claim that keeps a catalogue small.
 *
 * **2. `acuvo mcp add browser` installed a stranger's package.** There were TWO
 * curated nickname lists — `KNOWN_SERVERS` in `mcp-add.mjs` and `CATALOGUE` in
 * `mcp-defaults.mjs` — and `add` consulted only the first. Four catalogue names
 * existed in neither, so they fell through to the bare-package branch and were
 * handed to npx AS PACKAGE NAMES. Measured against the real registry the same
 * day: `browser` is a real npm package (0.2.6) that is not an MCP server,
 * `firecrawl` is the Firecrawl SDK rather than `firecrawl-mcp`, and `acuvo`
 * 404s. The command named after our best-verified entry configured something
 * else entirely and printed "added".
 *
 * ⭐ EVERY ASSERTION BELOW IS ABOUT DATA OR ABOUT A REAL ROUND TRIP. No network
 * is required to run this file — the live probe at the end is opt-in and skips
 * by default — because a test that needs the internet to be green is a test that
 * eventually goes red for a reason nobody caused.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CATALOGUE,
  DARK_ENTRY_COST_MS,
  HOSTED_DARK_COST_MS,
  assessEntry,
  assessCatalogue,
  catalogueEntry,
  darkCostMs,
  isHosted,
  packageOf,
  renderStarterConfig,
  toServerSpec,
} from '../lib/mcp-defaults.mjs';
import { resolveServer, mergeServer, KNOWN_SERVERS } from '../lib/mcp-add.mjs';
import { readMcpConfig, checkRemoteUrl } from '../lib/mcp.mjs';
import { rmDirWithRetry } from './_teardown.mjs';

const hosted = CATALOGUE.filter(isHosted);
const spawned = CATALOGUE.filter((e) => !isHosted(e));

/* ───────────────────────── LICENCE — NOW A FIELD, NOT A HOPE ─────────────── */

/**
 * ⚠️ THE STANDING RULE IS "MIT/Apache-2.0/BSD FINE, AGPL NEVER", and until today
 * nothing in this repo could tell you which of those a catalogue entry was. The
 * licences were checked by hand with `npm view <pkg> license` and then lived in
 * the checker's head. A field nobody can read is the same as no check.
 *
 * ⭐ THE ASSERTION IS DELIBERATELY WEAK ON FORM AND STRONG ON PRESENCE: it does
 * not try to parse SPDX, because "SEE LICENSE IN LICENSE" is a real npm value
 * (`@modelcontextprotocol/server-filesystem` ships it) and a parser that
 * rejected it would fail correct work. What it refuses is an entry with NO
 * answer, and an entry whose answer is one we have said we will not accept.
 */
test('⭐⭐ every catalogue entry states its licence, and none of them is one we refuse', () => {
  for (const e of CATALOGUE) {
    assert.equal(
      typeof e.licence,
      'string',
      `"${e.name}" has no licence field. We tell strangers to install these — "probably MIT" is not a licence check, `
      + 'and an absent field is how `exa-mcp-server` (no licence at all on npm) nearly got recommended.',
    );
    assert.ok(e.licence.trim().length > 3, `"${e.name}" has an empty licence field`);
    /**
     * ⚠️ AGPL IS THE ONE HARD NO. It is not a quality judgement — it is that a
     * copyleft-over-the-network licence attaching to a server we recommend to a
     * paying customer is a question for a lawyer, and a curated set exists so
     * nobody has to ask one.
     */
    assert.equal(
      /\bagpl\b/i.test(e.licence),
      false,
      `"${e.name}" names an AGPL licence (${e.licence}). The standing rule is MIT/Apache-2.0/BSD yes, AGPL never.`,
    );
    // ⚠️ And "unknown" is not an answer either — that is the exa case restated.
    assert.equal(
      /\bunknown\b|\bunlicensed\b|\bnone\b/i.test(e.licence),
      false,
      `"${e.name}" records its licence as "${e.licence}". An absent licence means all rights reserved, not "probably fine".`,
    );
  }
});

/**
 * ⭐ A LICENCE CLAIM IS A CLAIM ABOUT A DATE. Registry facts move — a package
 * gets deprecated, relicensed, or unpublished — so an entry that says "MIT" with
 * no date is a fact with no expiry, which is how the install-block sentence in
 * this module's header stayed wrong for a day and the GitHub sentence for ten.
 */
test('⭐ a licence taken from the registry says WHEN it was checked', () => {
  for (const e of spawned) {
    if (!e.needsDownload) continue; // ours; there is no registry entry to date
    assert.match(
      e.licence,
      /\b20\d\d-\d\d-\d\d\b/,
      `"${e.name}" states a licence (${e.licence}) with no date. npm's answer can change under us; `
      + 'a dated claim can be re-checked, an undated one can only be believed.',
    );
  }
});

/* ─────────────── THE HOSTED ENTRIES — SHAPE, TRUST AND TRANSPORT ─────────── */

test('⭐⭐ the hosted expansion is actually present, and it is what changed the numbers', () => {
  /**
   * ⚠️ NAMED, NOT COUNTED. `assert.equal(hosted.length, 7)` would fail the next
   * correct addition — this repo has paid four times for a guard that goes red
   * on somebody else's good work. These seven each cost a connect AND a real
   * tool call to earn their entry; a later edit may add more, but silently
   * DELETING one should be loud.
   */
  for (const name of ['deepwiki', 'grep', 'mslearn', 'awsdocs', 'cloudflare', 'huggingface', 'github_remote']) {
    const e = catalogueEntry(name);
    assert.ok(e, `the hosted entry "${name}" is gone — it was measured, not assumed`);
    assert.equal(isHosted(e), true, `"${name}" lost its url and is no longer hosted`);
  }
});

test('a hosted entry needs no download, names no install, and spawns nothing', () => {
  for (const e of hosted) {
    assert.equal(e.needsDownload, false, `"${e.name}" is hosted; there is nothing to download`);
    assert.equal(e.install, null, `"${e.name}" is hosted but names an install command`);
    assert.equal(packageOf(e), null, `"${e.name}" is hosted but resolves to an npm package`);
    // ⚠️ Both fields still exist — the shape invariants in mcp-defaults.test.mjs
    // require them on EVERY entry — and both must be inert.
    assert.equal(e.command, '', `"${e.name}" carries a command; a hosted entry must never be spawnable`);
    assert.deepEqual(e.args, [], `"${e.name}" carries args`);
    assert.ok(['http', 'sse'].includes(e.transport), `"${e.name}" declares transport "${e.transport}", which mcp.mjs does not speak`);
  }
});

/**
 * ── ⭐⭐ THE RULE THAT REPLACES `npm view` FOR A SERVER WITH NO PACKAGE ──────
 *
 * The registry check that caught `mcp-server-git` (a dependency-confusion canary
 * this catalogue once recommended) cannot run on a URL. The substitute is the
 * only trust signal a URL carries: WHO ANSWERS ON IT. A hosted entry must live
 * on the apex domain of the vendor whose data it serves — Microsoft's docs on
 * microsoft.com, AWS's on aws, GitHub's on GitHub's own API host.
 *
 * ⚠️ THIS IS THE ONE THAT STOPS THE WHOLE IDEA GOING WRONG. There are dozens of
 * helpful third-party proxies in front of these same docs, and every one of them
 * is a stranger reading the user's query on the way past. "It works" is not the
 * bar; "the vendor answers" is.
 */
test('⭐⭐ every hosted entry answers on its own vendor\'s domain, over https', () => {
  const EXPECTED_HOST_SUFFIX = {
    deepwiki: 'deepwiki.com',
    grep: 'grep.app',
    mslearn: 'learn.microsoft.com',
    awsdocs: 'api.aws',
    cloudflare: 'cloudflare.com',
    huggingface: 'huggingface.co',
    github_remote: 'githubcopilot.com',
    // ── the 2026-08-26 framework pass. Each is the framework's OWN apex domain,
    // which is the only provenance a hosted server has. ⚠️ Astro's is NOT
    // `mcp.astro.build` — it answers on `mcp.docs.astro.build`, still under
    // astro.build, which is what this suffix rule is for.
    svelte: 'svelte.dev',
    astro: 'astro.build',
    /**
     * ⭐ `docs` JOINED THIS BLOCK ON 2026-08-26, having been an npx entry since
     * it was curated. Context7 ships a hosted endpoint, which removed the only
     * stated reason the highest-value knowledge server could not be reached —
     * `needsDownload: true` meant that under this client's `npx --no` it could
     * not start at all on a machine without a global install.
     *
     * ⚠️ THE PROVENANCE STILL HAS TO HOLD, and it does: `mcp.context7.com` is
     * Context7's own apex domain, and Context7 is the vendor whose index this
     * serves. It is not a third party proxying somebody else's documentation,
     * which is the case this rule exists to refuse.
     */
    docs: 'context7.com',
    /**
     * ── the 2026-08-29 sweep. Both answer on the vendor's OWN apex domain,
     * which is the whole test: `mcp.convex.dev` is Convex serving guidance about
     * Convex, `mcp.clerk.com` is Clerk serving Clerk's own SDK snippets. Neither
     * is a third party proxying somebody else's documentation.
     *
     * ⚠️ THE SWEEP'S BEST-LOOKING CANDIDATE FAILED EXACTLY THIS RULE AND IS NOT
     * HERE. `gitmcp.io` serves documentation for arbitrary GitHub repositories
     * and is NOT GitHub — a stranger reading the user's query on the way past,
     * which is the case this map exists to refuse. It also returned nothing
     * useful on 6 of 6 real calls, so provenance was not even the binding
     * constraint; see the rejection block in `mcp-defaults.mjs`.
     */
    convex: 'convex.dev',
    clerk: 'clerk.com',
  };
  for (const e of hosted) {
    const checked = checkRemoteUrl(e.url, { name: e.name });
    assert.equal(checked.ok, true, `"${e.name}" has a url our own loader rejects: ${checked.error}`);
    const host = new URL(e.url).hostname;
    assert.equal(new URL(e.url).protocol, 'https:', `"${e.name}" is not https — a query, and possibly a token, would cross in cleartext`);
    const suffix = EXPECTED_HOST_SUFFIX[e.name];
    assert.ok(
      suffix,
      `"${e.name}" is a hosted entry with no recorded vendor domain. Add it here with the reason it is the vendor's, `
      + 'or do not curate it — the hostname is the only provenance a hosted server has.',
    );
    assert.ok(
      host === suffix || host.endsWith(`.${suffix}`),
      `"${e.name}" answers on ${host}, which is not ${suffix}. A third party proxying somebody else's `
      + 'documentation reads every query on the way past, and gets no entry here however good it is.',
    );
  }
});

/**
 * ⚠️ A CREDENTIAL IN A CONFIG FILE IS A CREDENTIAL IN A GIT REPOSITORY. `mcp.mjs`
 * refuses to connect rather than send an unexpanded `${VAR}`, which turns "you
 * forgot to set the token" into a sentence naming the variable instead of a 401
 * from a stranger. That guarantee only holds if what we write is a REFERENCE.
 */
test('⭐ a hosted entry\'s headers are ${VAR} references, never literal secrets', () => {
  for (const e of hosted) {
    for (const [key, value] of Object.entries(e.headers ?? {})) {
      assert.match(
        value,
        /\$\{[A-Za-z_][A-Za-z0-9_]*\}/,
        `"${e.name}" header ${key} is the literal string "${value}". Write \${VAR} — resolveHeaders expands it at `
        + 'connect time and refuses to connect when it is unset, and nothing secret ever reaches the file.',
      );
      // ⚠️ Every variable a header references must also be declared as a
      // credential, or `assessEntry` reports the entry live and it 401s anyway.
      const referenced = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
      const declared = new Set((e.credentials ?? []).map((c) => c.env));
      for (const name of referenced) {
        assert.ok(
          declared.has(name),
          `"${e.name}" references \${${name}} in a header but does not list it in credentials — the precheck would `
          + 'call this entry live on a machine where it cannot possibly authenticate.',
        );
      }
    }
  }
});

test('⚠️ no hosted entry is enabled by default — being cheap is not consent', () => {
  for (const e of hosted) {
    assert.equal(
      e.enabledByDefault,
      false,
      `"${e.name}" is enabled by default. It needs no install and no key, so the module's own rules would allow it — `
      + 'and it still must not, because the query text is usually the user\'s actual problem statement and it leaves '
      + 'the machine. The only server we start uninvited is the one we ship, which talks to nobody.',
    );
  }
});

/* ───────────────── THE PAYOFF: THESE ARE LIVE WITH NOTHING INSTALLED ─────── */

/**
 * ⭐⭐ THE MEASUREMENT THIS WHOLE EXPANSION IS FOR. A brand-new user, empty
 * environment, nothing installed, no account anywhere. Before 2026-08-25 exactly
 * one catalogue entry was usable in that state.
 */
test('⭐⭐ with an empty env and nothing installed, six hosted servers are live', () => {
  const rows = assessCatalogue({ env: {}, installed: new Set() });
  const live = rows.filter((r) => r.state === 'live').map((r) => r.entry);

  for (const name of ['deepwiki', 'grep', 'mslearn', 'awsdocs', 'cloudflare', 'huggingface']) {
    assert.ok(
      live.includes(name),
      `"${name}" is not live on a bare machine. It needs no download and no credential, so the only way it can be `
      + 'dark is a shape mistake in the entry — check `url`, `needsDownload` and `credentials`.',
    );
  }
  assert.ok(
    live.length >= 7,
    `only ${live.length} entries are usable on a bare machine (${live.join(', ')}). This was 1 before the hosted pass; `
    + 'a drop back towards it means the transport-aware branch in assessEntry has been undone.',
  );
});

/**
 * ⚠️ THE NUMBER THE USER IS TOLD MUST BE THE NUMBER THAT WAS MEASURED. Seven
 * vendor-hosted servers were probed anonymously and answered 401 in 118, 134,
 * 144, 332, 468, 605 and 741ms — none of them within a factor of twenty of the
 * stdio handshake timeout this file used to quote at everybody.
 */
test('⭐⭐ an unconfigured HOSTED server is costed at ~1s, not at the 20s a spawned one costs', () => {
  const gh = catalogueEntry('github_remote');
  const a = assessEntry(gh, { env: {} });

  assert.equal(a.state, 'dark', 'a required token that is unset must still darken the entry');
  assert.equal(a.costMs, HOSTED_DARK_COST_MS, 'a hosted entry was costed with the stdio constant');
  assert.equal(darkCostMs(gh), HOSTED_DARK_COST_MS);
  assert.ok(HOSTED_DARK_COST_MS < DARK_ENTRY_COST_MS / 10, 'the two costs have converged — one of them is now wrong');

  assert.equal(
    /\b20s\b/.test(a.fix),
    false,
    `the fix line for a hosted entry says "20s": ${a.fix}\n`
    + 'That is the spawned-server measurement. Telling someone their unset token costs twenty seconds, when it costs '
    + 'under one, is the sentence that talks them out of configuring a server worth having.',
  );
  assert.match(a.fix, /401/, 'the fix should say what actually happens — the server answers 401 and lets go');

  // ⚠️ And the stdio side must NOT have been softened on the way past: rule 2
  // is built on 20,052ms and that measurement still stands.
  const fc = assessEntry(catalogueEntry('firecrawl'), { env: {}, installed: new Set([packageOf(catalogueEntry('firecrawl'))]) });
  assert.equal(fc.costMs, DARK_ENTRY_COST_MS);
  assert.match(fc.fix, /20s/);
});

/**
 * ── ⭐⭐ "THE SHORTEST PATH HAS TO BE NAMED OR IT IS NOT TAKEN" ─────────────
 *
 * The repo's own rule, and the hosted entries broke it on arrival. Six servers
 * reported `live` with nothing missing and were switched off on purpose — so
 * their `--doctor` row and their `--mcp` line said "this works" and stopped
 * there. An offered capability the user is never told how to reach is the exact
 * defect this catalogue exists to stop being, and `fix: null` was it.
 */
test('⭐⭐ a live entry that is switched off names the one command that turns it on', () => {
  for (const r of assessCatalogue({ env: {}, installed: new Set() })) {
    if (r.state !== 'live' || r.enabledByDefault) continue;
    assert.ok(
      r.fix,
      `"${r.entry}" is usable right now and switched off, and says nothing about how to turn it on. `
      + 'That is a capability nobody reaches.',
    );
    assert.match(
      r.fix,
      new RegExp(`acuvo mcp add ${r.entry}`),
      `"${r.entry}" does not name the command. "Configure it" is not a path; \`acuvo mcp add ${r.entry}\` is.`,
    );
  }
  // ⚠️ And a DEFAULT must not be told to add itself — it is already running.
  const acuvo = assessEntry(catalogueEntry('acuvo'), {
    env: { RENDER_AUDIT_URL: 'https://r', MODAL_PRESS_URL: 'https://p', MODAL_VIDEO_SECRET: 's' },
  });
  assert.equal(acuvo.fix, null, 'a fully-configured default has nothing left to do and must say so with silence');
});

/* ─────────── THE RENDERED CONFIG: TWO SHAPES, BOTH READ BY OUR READER ────── */

/**
 * ⭐⭐ `_disabled` EXISTS SO A USER CAN MOVE A BLOCK INTO `mcpServers`. If the
 * block we render is not the shape the loader reads, the failure lands AFTER
 * they followed our own instructions — the worst possible place for it.
 *
 * ⚠️ THIS IS THE TEST THAT WOULD HAVE CAUGHT `{"command":"","args":[]}`: a
 * hosted entry rendered in the stdio shape parses fine as JSON, looks right in a
 * diff, and is rejected by `readMcpConfig` with `has no "command"`.
 */
test('⭐⭐ a disabled hosted entry renders the shape readMcpConfig accepts, and round-trips', async () => {
  const cfg = renderStarterConfig({ env: {} });

  const dw = cfg._disabled.deepwiki;
  assert.ok(dw, 'deepwiki is not documented in the starter config');
  assert.equal(dw.type, 'http');
  assert.equal(dw.url, 'https://mcp.deepwiki.com/mcp');
  assert.equal('command' in dw, false, 'a hosted block carries a command — the loader would try to spawn it');
  assert.ok(dw.licence, 'the licence does not travel with the entry into the file a reviewer reads');

  const fsEntry = cfg._disabled.filesystem;
  assert.equal(fsEntry.command, 'npx', 'the stdio shape regressed while the hosted one was added');
  assert.ok(Array.isArray(fsEntry.args));
  assert.equal('url' in fsEntry, false);

  // Now do what the file tells the user to do, with the real reader.
  const root = mkdtempSync(join(tmpdir(), 'acuvo-hosted-'));
  try {
    mkdirSync(join(root, '.acuvo'), { recursive: true });
    writeFileSync(
      join(root, '.acuvo', 'mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: dw, filesystem: fsEntry } }, null, 2),
      'utf8',
    );
    const loaded = readMcpConfig(root);
    assert.equal(loaded.ok, true, `moving our own _disabled blocks into mcpServers is rejected by our own reader: ${loaded.error}`);

    const remote = loaded.servers.find((s) => s.name === 'deepwiki');
    assert.equal(remote.transport, 'http');
    assert.equal(remote.url, 'https://mcp.deepwiki.com/mcp');
    /**
     * ⚠️ `command` MIRRORING THE URL IS NOT COSMETIC — `turn.mjs` prints it as
     * the only notice before a connection, `mcp-consent.mjs` puts it in the
     * approval text, and the consent fingerprint HASHES it. If it were empty,
     * every remote server would hash alike and approving one host would approve
     * any other.
     */
    assert.equal(remote.command, remote.url, 'a remote server whose command does not name its destination breaks consent');

    const local = loaded.servers.find((s) => s.name === 'filesystem');
    assert.equal(local.transport, 'stdio');
    assert.equal(local.command, 'npx');
  } finally {
    await rmDirWithRetry(root);
  }
});

test('toServerSpec hands connectServer the same remote shape readMcpConfig builds', () => {
  const spec = toServerSpec(catalogueEntry('mslearn'));
  assert.deepEqual(
    Object.keys(spec).sort(),
    ['args', 'command', 'env', 'headers', 'name', 'transport', 'url'],
    'the remote spec drifted from the loader\'s — connectServer branches on transport and reads url, and three other '
    + 'modules read command',
  );
  assert.equal(spec.transport, 'http');
  assert.equal(spec.command, spec.url);
  assert.deepEqual(spec.args, []);

  // ⚠️ The stdio spec is pinned to four keys by test/mcp-defaults.test.mjs.
  // Restated here so the two halves are visibly different on purpose.
  const stdio = toServerSpec(catalogueEntry('acuvo'), { packageRoot: '/opt/acuvo' });
  assert.deepEqual(Object.keys(stdio).sort(), ['args', 'command', 'env', 'name']);
});

/* ──────────── `mcp add <catalogue name>` — THE DRIFT THAT SHIPPED ────────── */

/**
 * ── ⚠️⚠️ THE REGRESSION TEST FOR THE WORST BUG IN THIS AREA ────────────────
 *
 * `acuvo mcp add browser` used to write `npx -y browser` — a real, unrelated npm
 * package (0.2.6, checked against the registry 2026-08-25) — and print "added".
 * `firecrawl` resolved to the Firecrawl SDK instead of `firecrawl-mcp`, and
 * `acuvo` to a name that 404s.
 *
 * ⭐ THE ASSERTION IS ABOUT THE PACKAGE ACTUALLY WRITTEN, not about whether the
 * call succeeded. `ok: true` was exactly the problem — every surface agreed it
 * had worked.
 */
test('⭐⭐⭐ a catalogue name resolves to the catalogue entry, never to a same-named npm package', () => {
  /**
   * ⚠️ `docs` LEFT THIS LIST ON 2026-08-26, and it is not a weakening. It became
   * a HOSTED entry, so there is no npm package for a same-named one to be
   * confused with — the whole attack this test describes needs an `npx` in the
   * resolution. Its provenance is now guarded by the vendor-domain rule above,
   * which is the substitute this file's own header names for exactly that case:
   * *"the registry check … cannot run on a URL. The substitute is the only trust
   * signal a URL carries: WHO ANSWERS ON IT."* The assertion below pins that it
   * really did move, so the coverage cannot be lost by accident.
   */
  const hostedNow = resolveServer('docs', { workspace: '/w' });
  assert.equal(hostedNow.ok, true, `docs: ${hostedNow.error}`);
  assert.equal(hostedNow.entry.type, 'http');
  assert.equal(hostedNow.entry.url, 'https://mcp.context7.com/mcp');
  assert.equal(hostedNow.entry.command, undefined, 'a written hosted entry carries a url, never a command to spawn');
  /**
   * ⭐⭐ THE WHOLE POINT OF THE CHANGE, IN ONE ASSERTION. `acuvo mcp add docs`
   * used to hand the user a config that could not start until they ran
   * `npm i -g @upstash/context7-mcp` — and this client injects `npx --no`, so
   * without that install it did not fail loudly, it just refused. There is now
   * nothing to install, so the command works on a bare machine.
   */
  assert.equal(hostedNow.install, null, '`acuvo mcp add docs` must not hand a stranger a prerequisite');

  const cases = [
    ['browser', 'chrome-devtools-mcp'],
    ['firecrawl', 'firecrawl-mcp'],
  ];
  for (const [nickname, expected] of cases) {
    const r = resolveServer(nickname, { workspace: '/w' });
    assert.equal(r.ok, true, `${nickname}: ${r.error}`);
    assert.equal(r.entry.command, 'npx');
    assert.ok(
      r.entry.args.includes(expected),
      `\`acuvo mcp add ${nickname}\` writes ${JSON.stringify(r.entry.args)} — it must name ${expected}. `
      + `npm really does publish a package called "${nickname}", so the old fall-through wrote a working config `
      + 'for entirely the wrong program.',
    );
    assert.ok(r.note.includes(expected), 'the note must name the package the user is being told to install');
  }
});

test('⭐ `mcp add acuvo` configures the server we ship, not a package that 404s', () => {
  const r = resolveServer('acuvo', { workspace: '/w', packageRoot: '/opt/acuvo' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.entry.command, 'node');
  assert.deepEqual(r.entry.args, ['/opt/acuvo/bin/acuvo-mcp.mjs']);
  assert.equal(r.install, null, 'there is nothing to install — it ships inside this package');
  // ⚠️ `npm view acuvo` → E404 on 2026-08-25. The old path wrote `npx -y acuvo`,
  // which cannot resolve and costs the full 20s handshake to find that out.
  assert.equal(r.entry.args.some((a) => a === 'acuvo'), false);
});

test('⭐⭐ `mcp add <hosted>` writes a url block, and the real loader reads it back', async () => {
  const r = resolveServer('deepwiki', { workspace: '/w' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.entry.type, 'http');
  assert.equal(r.entry.url, 'https://mcp.deepwiki.com/mcp');
  assert.equal('command' in r.entry, false, 'a hosted add wrote a command — the loader would spawn it');
  assert.equal(r.install, null);
  assert.match(r.note, /hosted/i, 'the user must be told their query text leaves the machine');
  assert.match(r.note, /mcp\.deepwiki\.com/, 'the note must name the destination, not just the fact of one');

  const merged = mergeServer({}, r.name, r.entry);
  assert.equal(merged.ok, true, merged.error);

  const root = mkdtempSync(join(tmpdir(), 'acuvo-add-hosted-'));
  try {
    mkdirSync(join(root, '.acuvo'), { recursive: true });
    writeFileSync(join(root, '.acuvo', 'mcp.json'), JSON.stringify(merged.config, null, 2), 'utf8');
    const loaded = readMcpConfig(root);
    assert.equal(loaded.ok, true, `the loader rejected what \`mcp add deepwiki\` writes: ${loaded.error}`);
    assert.equal(loaded.servers.length, 1);
    assert.equal(loaded.servers[0].transport, 'http');
    assert.equal(loaded.servers[0].url, 'https://mcp.deepwiki.com/mcp');
  } finally {
    await rmDirWithRetry(root);
  }
});

test('⭐ a credentialed hosted add writes the ${VAR} reference, not a blank', () => {
  const r = resolveServer('github_remote', { workspace: '/w' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.entry.headers.Authorization, 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}');
  assert.match(r.note, /GITHUB_PERSONAL_ACCESS_TOKEN/, 'the note must name the variable the user has to set');
  assert.match(r.note, /have not run this one/i, 'an unverified entry must say so at the moment it is added');
});

/**
 * ⚠️ THE ORDER MATTERS AND IS EASY TO GET WRONG. `KNOWN_SERVERS` is consulted
 * FIRST because its entries carry argument quirks the catalogue does not model —
 * `filesystem` needs a path appended, `postgres` needs a connection string. A
 * catalogue lookup that ran first would silently drop `needsPathArg` and produce
 * a filesystem server serving nothing.
 */
test('⚠️ a nickname in BOTH lists still resolves through KNOWN_SERVERS, which carries the argument quirks', () => {
  const overlap = Object.keys(KNOWN_SERVERS).filter((n) => catalogueEntry(n));
  assert.ok(overlap.length > 0, 'fixture drift: the two lists no longer overlap, so this ordering rule is untested');

  const fs = resolveServer('filesystem', { workspace: '/my/workspace' });
  assert.equal(fs.ok, true, fs.error);
  assert.ok(
    fs.entry.args.includes('/my/workspace'),
    `filesystem lost its path argument (${JSON.stringify(fs.entry.args)}) — it would serve nothing. `
    + 'The catalogue entry hardcodes "." and does not know about the workspace; KNOWN_SERVERS does.',
  );
});

/**
 * ⭐ THE ADVISORY STILL FIRES THROUGH THE NEW PATH. `mcp-server-git` is a
 * dependency-confusion canary this catalogue once recommended; a second
 * resolution route that skipped `packageAdvisory` would quietly reopen that.
 */
test('⭐ the refusal survives the new resolution path', () => {
  const r = resolveServer('mcp-server-git');
  assert.equal(r.ok, false, 'the canary package was accepted');
  assert.match(r.error, /Security research canary/);
});

/* ────────────────── OPT-IN: THE MEASUREMENT ITSELF, RE-RUN ──────────────── */

/**
 * ── ⚠️ THIS TEST TOUCHES THE NETWORK, SO IT SKIPS UNLESS ASKED ─────────────
 *
 * Every claim in the seven hosted `note` fields is a measurement — connect time,
 * tool count, tool names, and a real call with a real answer. This re-runs the
 * connect half so the claims can be re-checked on demand rather than believed
 * forever.
 *
 * ⚠️ IT IS OPT-IN BECAUSE A NETWORK TEST IN A DEFAULT SUITE IS A FLAKE FACTORY.
 * A vendor's rate limit, a corporate proxy, or a laptop on a train would turn
 * somebody's unrelated change red, and this repo has written down four separate
 * times that a check which fails correct work is worse than no check.
 *
 *   ACUVO_LIVE_MCP=1 node --test test/mcp-catalogue-hosted.test.mjs
 */
test('⭐ (opt-in) every hosted entry we marked verified still answers', { concurrency: false }, async (t) => {
  if (process.env.ACUVO_LIVE_MCP !== '1') {
    return t.skip('set ACUVO_LIVE_MCP=1 to re-run the hosted measurements against the live services');
  }
  const { connectRemoteServer } = await import('../lib/mcp.mjs');
  for (const e of hosted) {
    if (!e.verified) continue; // github_remote 401s without a token, by design
    const started = Date.now();
    const conn = await connectRemoteServer(toServerSpec(e), { env: {} });
    const ms = Date.now() - started;
    assert.equal(conn.ok, true, `"${e.name}" (${e.url}) did not answer: ${conn.error}`);
    assert.ok(conn.tools.length > 0, `"${e.name}" connected but offered no tools — the note claims otherwise`);
    // eslint-disable-next-line no-console
    console.log(`    ${e.name.padEnd(14)} ${String(ms).padStart(6)}ms  ${conn.tools.length} tools`);
    try { conn.close(); } catch { /* already gone */ }
  }
});
