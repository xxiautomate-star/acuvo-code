/**
 * ── ⚠️⚠️⭐ npm EATS EVERY FLAG THIS CATALOGUE PUTS AFTER A PACKAGE NAME ───────
 *
 * `lib/mcp.mjs` spawns a stdio server as `npx --no <pkg> <args…>`. Under npm 11,
 * an argument beginning with `--` that FOLLOWS the package name is parsed as an
 * **npm config option**, not as an argument to the program. Measured on this
 * machine, 2026-08-26, verbatim:
 *
 *     $ npx --no tavily-mcp --headless --isolated
 *     npm warn Unknown cli config "--headless". This will stop working in the
 *              next major version of npm.
 *     npm warn Unknown cli config "--isolated". This will stop working in the
 *              next major version of npm.
 *
 * …and the server started with neither flag set. The same shape against
 * `@bytebase/dbhub --demo --transport stdio` swallowed both flags, left only the
 * bare word `stdio` as a positional, and the server exited with its usage text —
 * which `connectServer` reported at **20,060ms**, the full handshake timeout,
 * with no explanation a user could act on.
 *
 * ⭐ THE FIX IS ONE TOKEN — a bare `--` before the program's own flags — and it
 * was verified three ways (`pkg -- flags`, `-- pkg flags`,
 * `--package=pkg -- bin flags`). With the separator, `mongodb-mcp-server --
 * --readOnly` offered 18 tools where the same server without it offered 27, so
 * the flag demonstrably arrives.
 *
 * ⚠️ WHY THIS NEEDED A TEST RATHER THAN A COMMENT. The defect is INVISIBLE: the
 * config parses, `acuvo mcp add` prints "added", `readMcpConfig` accepts it, and
 * npm's warning goes to a stderr nobody reads. The only symptom is a server that
 * behaves as though you configured nothing — or, worse, a server that quietly
 * keeps the dangerous half of its tool surface because the `--readOnly` you
 * asked for never arrived. That last one is the reason this is a guard and not a
 * note: a swallowed safety flag fails OPEN.
 *
 * ⚠️ AND IT HAD ALREADY REACHED A USER-FACING STRING. `mcp-defaults.mjs`'s
 * `browser` note told people to "Add `--headless` and `--isolated` to args for
 * CI". Corrected in the same change as this file.
 *
 * ── THE REST OF THIS FILE: THE TWO ENTRIES ADDED ON 2026-08-26 ───────────────
 *
 * `tavily` (web search, and it answers with NO key) and `dbhub` (five database
 * engines behind one DSN). Both were connected AND called through the real
 * client, three consecutive times each, before being written down. The
 * assertions here pin the properties that made them acceptable — not that they
 * exist, but that they are still opt-in, still licence-clean, and still telling
 * the truth about their credentials.
 *
 * ⚠️ NOTHING HERE TOUCHES THE NETWORK. The live re-measurement is opt-in and
 * skips by default, for the reason the sibling suites already argued: a network
 * test in a default suite is a flake factory, and a check that fails correct
 * work is worse than no check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOGUE,
  assessEntry,
  catalogueEntry,
  isHosted,
  packageOf,
  requiredCredentials,
  renderStarterConfig,
  toServerSpec,
} from '../lib/mcp-defaults.mjs';
import { resolveServer } from '../lib/mcp-add.mjs';
import { readMcpConfig } from '../lib/mcp.mjs';

const spawned = CATALOGUE.filter((e) => !isHosted(e));

/* ─────────── 1. THE GUARD: A FLAG AFTER THE PACKAGE NEEDS A `--` ─────────── */

/**
 * ⭐⭐ THE ONE THAT WOULD HAVE CAUGHT IT. Walk each spawned entry's args, find
 * where the package name sits, and require that anything `--`-prefixed after it
 * is preceded by a bare `--` separator.
 *
 * ⚠️ ONLY FOR `npx`. A `node <abs path>` entry (the `acuvo` server we ship) has
 * no npm in the path at all, so its flags arrive intact and demanding a `--`
 * there would fail correct work.
 */
test('⚠️⚠️ no npx entry passes a --flag after the package name without a bare `--` separator', () => {
  for (const e of spawned) {
    if (e.command !== 'npx') continue;

    const args = e.args ?? [];
    const pkgIndex = args.findIndex((a) => !a.startsWith('-'));
    assert.ok(pkgIndex >= 0, `"${e.name}" has no package name in its args (${JSON.stringify(args)})`);

    const after = args.slice(pkgIndex + 1);
    const sepIndex = after.indexOf('--');
    for (let i = 0; i < after.length; i++) {
      if (after[i] === '--') continue;
      if (!after[i].startsWith('-')) continue; // a positional is passed through untouched
      assert.ok(
        sepIndex >= 0 && i > sepIndex,
        `"${e.name}" passes ${JSON.stringify(after[i])} to ${args[pkgIndex]} with no bare "--" before it.\n`
        + `  args: ${JSON.stringify(args)}\n`
        + '  connectServer runs `npx --no <pkg> …`, and npm 11 parses that as its OWN config — it prints\n'
        + '  "npm warn Unknown cli config" and the server never receives it. Measured 2026-08-26.\n'
        + `  Write ${JSON.stringify([...args.slice(0, pkgIndex + 1), '--', ...after])} instead.\n`
        + '  This fails OPEN when the swallowed flag is a safety flag: `mongodb-mcp-server --readOnly`\n'
        + '  without the separator offers all 27 tools including drop-database, instead of 18.',
      );
    }
  }
});

/**
 * ⭐ AND THE SEPARATOR MUST NOT BREAK THE TWO THINGS THAT READ THESE ARGS.
 * `packageOf` feeds the installed-package lookup and the dist-tag guard reads
 * the same array; both skip anything starting with `-`, so a bare `--` is
 * invisible to them. Asserted rather than assumed, because "it happens to be
 * skipped" is a property of two other functions that could change.
 */
test('⭐ a bare `--` separator is invisible to packageOf and to the install-line check', () => {
  const withSep = {
    name: 'fixture',
    needsDownload: true,
    args: ['-y', '@bytebase/dbhub', '--', '--transport', 'stdio', '--demo'],
  };
  assert.equal(packageOf(withSep), '@bytebase/dbhub');
});

/* ─────────────── 2. THE TWO ENTRIES, AND WHY THEY WERE ALLOWED ───────────── */

test('⭐⭐ the 2026-08-26 stdio pass is present: web search and a database that is not postgres', () => {
  /**
   * ⚠️ NAMED, NOT COUNTED — this repo has paid four times for a guard that goes
   * red on somebody else's good work. A later pass may add more entries;
   * silently DELETING one of these should be loud, because each cost a connect
   * and a real tool call three times over.
   */
  for (const [name, pkg] of [['tavily', 'tavily-mcp'], ['dbhub', '@bytebase/dbhub']]) {
    const e = catalogueEntry(name);
    assert.ok(e, `the "${name}" entry is gone — it was measured, not assumed`);
    assert.equal(e.verified, true, `"${name}" was demoted to unverified without a note explaining it`);
    assert.equal(packageOf(e), pkg, `"${name}" no longer resolves to ${pkg}`);
    assert.equal(isHosted(e), false, `"${name}" is a spawned entry`);
    /**
     * ⚠️ RULE 1 IS NOT BENT FOR THEM EITHER. Both need a download, and npx gets
     * `--no`, so enabling either by default buys a guaranteed 20s stall before
     * the user's first prompt — exactly what `browser` and `docs` are held to.
     */
    assert.equal(e.enabledByDefault, false, `"${name}" needs a download, so enabling it by default buys a 20s stall`);
    assert.equal(e.needsDownload, true);
    assert.match(
      e.licence,
      /\bMIT\b/,
      `"${name}" no longer records an MIT licence (${e.licence}) — we tell strangers to install these`,
    );
    assert.match(e.licence, /\b20\d\d-\d\d-\d\d\b/, `"${name}" states a licence with no date; npm's answer can change under us`);
    assert.match(
      e.note,
      /RAN IT AND CALLED IT/,
      `"${name}" is marked verified but its note does not record a real call. In this catalogue "verified" `
      + 'means somebody ran it, not that the vendor documents it.',
    );
  }
});

/**
 * ⭐⭐ THE MEASUREMENT THAT PUT `tavily` IN RATHER THAN DEFERRING IT BEHIND A
 * KEY, PINNED AS DATA. It connected and answered a real search with
 * TAVILY_API_KEY absent from the environment entirely. If somebody later marks
 * that credential required, the precheck starts reporting a working server as
 * dark and quoting a 20-second cost that was measured at 1.5–3.7 seconds — the
 * pessimistic stale claim this module has already been burned by twice.
 */
test('⭐⭐ tavily is LIVE with no API key, because that is what was measured', () => {
  const e = catalogueEntry('tavily');
  assert.deepEqual(
    requiredCredentials(e).map((c) => c.env),
    [],
    'TAVILY_API_KEY was marked required. Measured 2026-08-26: with no key at all the server connected in '
    + '1,467–3,676ms, listed all 5 tools, and tavily_search returned the real MCP specification page. '
    + 'A required credential here would darken an entry that provably works.',
  );
  const a = assessEntry(e, { env: {}, installed: new Set([packageOf(e)]) });
  assert.equal(a.state, 'live', 'an installed, keyless-capable server must not be reported dark');
  assert.equal(a.costMs, 0);
});

/**
 * ⚠️ AND THE SENTENCE IT PRINTS HAS TO BE TRUE. `assessEntry` used to hardcode
 * "so it will offer fewer tools" for every optional credential. That is exact
 * for `acuvo` and FALSE for `tavily`, which lists all five tools keyless and
 * makes three of them answer with a sign-up message. A status line that
 * describes a shrunken surface when the surface is the same size sends the user
 * hunting for a tool that is right in front of them.
 */
test('⭐ the "fewer tools" sentence is not printed for a server whose tool list does not shrink', () => {
  const tavily = catalogueEntry('tavily');
  const a = assessEntry(tavily, { env: {}, installed: new Set([packageOf(tavily)]) });
  assert.match(a.detail, /TAVILY_API_KEY/, 'the variable that changes behaviour must be named');
  assert.equal(
    /fewer tools/.test(a.detail),
    false,
    `tavily's live detail claims a smaller tool surface: ${a.detail}\n`
    + 'Measured: keyless it advertises all 5 tools and 3 of them reply with a sign-up message. '
    + 'Use the credential\'s `absentDetail` to say what actually happens.',
  );

  // ⚠️ And the default wording must be UNCHANGED for the entry it was written
  // for — an honesty fix that churns every other entry's output is one nobody
  // can review. acuvo really does withhold tools when its endpoints are unset.
  const acuvo = assessEntry(catalogueEntry('acuvo'), { env: {} });
  assert.match(acuvo.detail, /fewer tools/, 'the default optional-credential wording regressed');
});

/**
 * ⭐ `dbhub` IS THE OPPOSITE CASE, AND IT IS ALSO A MEASUREMENT. With no DSN the
 * server prints its usage text and exits, and connectServer reported the full
 * 20,011ms handshake timeout. That is rule 2 confirmed on a package nobody had
 * run, so the credential is genuinely required and the 20s cost sentence is the
 * honest one to print.
 */
test('⭐ dbhub without a DSN is dark, and the cost quoted is the spawned-server 20s', () => {
  const e = catalogueEntry('dbhub');
  assert.deepEqual(requiredCredentials(e).map((c) => c.env), ['DSN']);
  const a = assessEntry(e, { env: {}, installed: new Set([packageOf(e)]) });
  assert.equal(a.state, 'dark');
  assert.match(a.detail, /DSN/);
  assert.match(a.fix, /20s/, 'a spawned server that dies without its credential costs the full handshake');
});

/* ─────────────── 3. `acuvo mcp add` REACHES BOTH OF THEM ─────────────────── */

/**
 * ⚠️ THE REGRESSION THIS CATALOGUE ALREADY SHIPPED ONCE. `acuvo mcp add browser`
 * used to write `npx -y browser` — a real, unrelated npm package — because the
 * two curated lists were never joined. Any name added to the catalogue has to be
 * checked the same way, on the package actually written, not on `ok: true`.
 */
test('⭐⭐ `mcp add tavily` and `mcp add dbhub` write the curated package, and the loader reads it back', () => {
  for (const [nickname, pkg] of [['tavily', 'tavily-mcp'], ['dbhub', '@bytebase/dbhub']]) {
    const r = resolveServer(nickname, { workspace: '/w' });
    assert.equal(r.ok, true, `${nickname}: ${r.error}`);
    assert.equal(r.entry.command, 'npx');
    assert.ok(
      r.entry.args.includes(pkg),
      `\`acuvo mcp add ${nickname}\` writes ${JSON.stringify(r.entry.args)} — it must name ${pkg}.`,
    );
    assert.ok(r.note.includes(pkg), 'the note must name the package the user is being told to install');
    assert.match(r.install, new RegExp(`npm i -g ${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

/**
 * ⭐⭐ THE OPTIONAL CREDENTIAL HAS TO REACH THE USER AT THE MOMENT THEY ADD IT.
 * "Does this work without an account" is the live question when somebody types
 * `acuvo mcp add tavily`, and the answer was sitting in the catalogue unprinted.
 */
test('⭐ adding a server with an OPTIONAL credential says so, and writes no env block for it', () => {
  const r = resolveServer('tavily', { workspace: '/w' });
  assert.equal(r.ok, true, r.error);
  assert.match(r.note, /TAVILY_API_KEY/, 'the variable that unlocks the rest of the surface is never named');
  assert.match(r.note, /optional/i, 'an optional key must not read like a requirement');
  assert.equal(
    'env' in r.entry,
    false,
    'an env block was written for a variable the server does not need — `acuvo mcp list` would show a '
    + 'working server as though it were missing configuration.',
  );

  // ⚠️ A REQUIRED one still writes the ${VAR} reference, unchanged.
  const db = resolveServer('dbhub', { workspace: '/w' });
  assert.equal(db.entry.env.DSN, '${DSN}');
  assert.match(db.note, /DSN/);
});

test('the new entries are documented in the starter config with a reason and a way to turn them on', () => {
  const cfg = renderStarterConfig({ env: {} });
  for (const name of ['tavily', 'dbhub']) {
    const d = cfg._disabled[name];
    assert.ok(d, `"${name}" is off and unexplained in the starter config`);
    assert.ok(d.to_enable, `"${name}" does not say how to turn it on`);
    assert.ok(d.licence, 'the licence does not travel into the file a reviewer reads');
    assert.equal(d.command, 'npx');
  }
});

/* ─────────────── 4. THE REJECTIONS, AS NAMED ABSENCES ───────────────────── */

/**
 * ── ⭐ A REJECTION NOBODY CAN SEE GETS RE-PROPOSED ──────────────────────────
 *
 * The `chakra` guard in test/mcp-hosted-reconnect-stability.test.mjs proved the
 * pattern: an entry that is genuinely tempting and genuinely wrong needs its
 * absence asserted, or the next pass adds it on the same evidence that fooled
 * the last one. These three are the tempting ones from 2026-08-26.
 */
test('⚠️⚠️ the three tempting stdio rejections stay out of the catalogue', () => {
  const cases = [
    ['mongodb', 'mongodb-mcp-server',
      'Apache-2.0, MongoDB\'s own, and it WORKS — but through the `npx --no` line a config actually uses it '
      + 'connected 2 times in 6 (ok 11,483ms · ok 19,187ms · FAIL 20,131 · 20,278 · 20,798 · 22,792ms), and '
      + 'disabling its telemetry changed nothing. Its 308-package tree costs a quarter to two thirds of '
      + 'HANDSHAKE_TIMEOUT_MS before npx adds anything. Re-measure 3× in a row before restoring it.'],
    ['supabase', '@supabase/mcp-server-supabase',
      'the vendor no longer documents a stdio invocation at all — its npm README is a 28-byte stub and '
      + 'github.com/supabase/mcp publishes only {"type":"http","url":"https://mcp.supabase.com/mcp"} with '
      + 'OAuth 2.1, which this client (static Authorization header only) cannot speak.'],
    ['postgres_pro', '@henkey/postgres-mcp-server',
      'AGPL-3.0. The standing rule is MIT/Apache-2.0/BSD yes, AGPL never, and this one ranks highly in every '
      + 'search so it will be proposed again.'],
  ];
  for (const [name, pkg, why] of cases) {
    assert.equal(catalogueEntry(name), null, `the "${name}" entry is back in the catalogue. ${why}`);
    for (const e of CATALOGUE) {
      assert.notEqual(
        packageOf(e), pkg,
        `a catalogue entry ("${e.name}") now runs ${pkg}. ${why}`,
      );
    }
  }
});

/* ─────────────── 5. OPT-IN: RE-RUN THE MEASUREMENTS ─────────────────────── */

/**
 * ── ⚠️ THIS SPAWNS REAL PROCESSES AND NEEDS THE PACKAGES INSTALLED ─────────
 *
 * Every claim in the two new `note` fields is a measurement: connect time, tool
 * count, tool names, and a real call with a real answer. This re-runs the
 * connect half THREE TIMES IN A ROW, which is the bar
 * test/mcp-hosted-reconnect-stability.test.mjs argues for and the bar
 * `mongodb-mcp-server` failed.
 *
 * ⚠️ OPT-IN, and it skips rather than fails when the package is absent — a
 * reviewer running the published tarball has installed neither, and this repo
 * has already discredited itself once by handing somebody a red suite on a
 * healthy build.
 *
 *     ACUVO_LIVE_MCP=1 node --test test/mcp-catalogue-stdio-flags.test.mjs
 */
test('⭐ (opt-in) the two new stdio entries connect 3× in a row', { concurrency: false }, async (t) => {
  if (process.env.ACUVO_LIVE_MCP !== '1') {
    return t.skip('set ACUVO_LIVE_MCP=1 (and install tavily-mcp / @bytebase/dbhub) to re-run the measurements');
  }
  const { connectServer } = await import('../lib/mcp.mjs');

  /**
   * ⚠️ dbhub NEEDS A DSN OR IT DIES — that is its own recorded measurement, so
   * the probe supplies a throwaway in-memory SQLite one rather than re-proving
   * the failure we already documented.
   *
   * ⚠️⚠️ IT GOES ON THE SERVER SPEC, NOT IN connectServer's `env` OPTION, and
   * getting that wrong is how this test failed the first time it was run. The
   * `env` option is only the source `resolveServerEnv` expands `${VAR}`
   * placeholders FROM; what the child actually receives is
   * `{...process.env, ...resolvedEnv.env}`. A variable passed as the option and
   * absent from the spec reaches nobody, and the symptom is a 20s timeout that
   * reads exactly like the server being broken.
   */
  const envFor = { dbhub: { DSN: 'sqlite:///:memory:' }, tavily: {} };

  const failures = [];
  for (const name of ['tavily', 'dbhub']) {
    const e = catalogueEntry(name);
    const results = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const started = Date.now();
      let conn;
      try {
        conn = await connectServer({ ...toServerSpec(e), env: envFor[name] }, { root: process.cwd() });
      } catch (err) {
        conn = { ok: false, error: String(err?.message ?? err) };
      }
      results.push({ ok: conn?.ok === true, ms: Date.now() - started, error: conn?.error, tools: conn?.tools?.length ?? 0 });
      try { conn?.close?.(); } catch { /* already gone */ }
    }
    // eslint-disable-next-line no-console
    console.log(`    ${name.padEnd(10)} ${results.map((r) => (r.ok ? `ok ${r.ms}ms/${r.tools}t` : 'FAIL')).join('  ')}`);
    const bad = results.filter((r) => !r.ok);
    if (bad.length > 0) failures.push(`"${name}" failed ${bad.length}/3 connects — first error: ${bad[0].error}`);
  }

  assert.deepEqual(
    failures, [],
    `a verified stdio entry is not reliably startable:\n  ${failures.join('\n  ')}\n\n`
    + 'Either the package is not installed on this machine (install it and re-run), or the entry has gone the '
    + 'way of mongodb-mcp-server and should be demoted to a rejection WITH THE NUMBERS.',
  );
});

/**
 * ⭐ AND THE REGISTRY CLAIMS, RE-CHECKED AGAINST npm ITSELF. This module's
 * header states the rule — "an entry's package name must be checked against the
 * registry before it is written down" — and until now the only thing enforcing
 * it was somebody remembering. Registry facts move: a package gets deprecated,
 * relicensed or unpublished, and nothing breaks, so nobody looks. That is
 * exactly how `mcp-server-git` (a stranger's dependency-confusion canary) sat in
 * this catalogue being recommended.
 *
 * ⚠️ OPT-IN, and it reads registry.npmjs.org over HTTPS only — no install, no
 * spawn, no model.
 */
test('⭐ (opt-in) every catalogue package still exists, and its licence still says what we say', { concurrency: false }, async (t) => {
  if (process.env.ACUVO_LIVE_MCP !== '1') {
    return t.skip('set ACUVO_LIVE_MCP=1 to re-check the catalogue\'s package claims against registry.npmjs.org');
  }
  const problems = [];
  for (const e of spawned) {
    const pkg = packageOf(e);
    if (!pkg) continue;
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`);
    if (!res.ok) { problems.push(`"${e.name}": ${pkg} → HTTP ${res.status} from the registry`); continue; }
    const meta = await res.json();
    const licence = typeof meta.license === 'string' ? meta.license : '(none)';
    // eslint-disable-next-line no-console
    console.log(`    ${e.name.padEnd(12)} ${pkg.padEnd(42)} ${String(meta.version).padEnd(12)} ${licence}${meta.deprecated ? '  DEPRECATED' : ''}`);
    if (/agpl/i.test(licence)) problems.push(`"${e.name}": ${pkg} is now ${licence} — AGPL is never acceptable here`);
    /**
     * ⚠️ DEPRECATION IS A WARNING, NOT A FAILURE, AND THE CHECK IS THAT WE SAY
     * SO. Two entries are knowingly deprecated and still work; refusing them
     * would break configs that are fine today. What must never happen is a
     * package going deprecated while our note still reads as a recommendation.
     */
    if (meta.deprecated && !/deprecat/i.test(e.note ?? '')) {
      problems.push(`"${e.name}": npm now reports ${pkg} deprecated ("${String(meta.deprecated).slice(0, 60)}") and the entry's note does not mention it`);
    }
  }
  assert.deepEqual(problems, [], `the catalogue's package claims have drifted from the registry:\n  ${problems.join('\n  ')}`);
});

/* ─────────────── 6. THE RENDERED CONFIG STILL LOADS ─────────────────────── */

test('the catalogue still renders a config our own reader accepts', () => {
  const cfg = renderStarterConfig({ env: {} });
  // ⚠️ The disabled blocks are what a user MOVES into mcpServers, so each of the
  // new ones has to be a shape readMcpConfig will take.
  const servers = { tavily: cfg._disabled.tavily, dbhub: cfg._disabled.dbhub };
  for (const [name, block] of Object.entries(servers)) {
    const { what, why_off: _w, to_enable: _t, verified_by_us: _v, licence: _l, note: _n, ...invocation } = block;
    assert.ok(what, `"${name}" lost its description`);
    assert.equal(typeof invocation.command, 'string');
    assert.ok(Array.isArray(invocation.args));
  }
  // A round trip through the real reader is done in mcp-defaults.test.mjs for
  // the active set; here we only need the parse to be legal JSON-shaped data.
  assert.equal(typeof readMcpConfig, 'function');
});
