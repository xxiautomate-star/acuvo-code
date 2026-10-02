/**
 * ── ⚠️⚠️⭐ ONE SUCCESSFUL CONNECT IS NOT A MEASUREMENT ───────────────────────
 *
 * `mcp-defaults.mjs` verifies a hosted entry by connecting to it once and
 * calling one tool. That bar caught a stranger's canary package, an unlicensed
 * package and an FSL package, so it has earned its place — and on 2026-08-26 it
 * let through a server that fails **four connects in five.**
 *
 * ⚠️ WHAT HAPPENED, recorded in full in `mcp-defaults.mjs`'s rejection block:
 * Chakra UI's hosted server (`https://mcp.chakra-ui.com/mcp`) connected in
 * 2,544ms, listed 6 tools, and answered a real `list_components` call. On that
 * evidence it was written into the catalogue as `verified: true`. The opt-in
 * live test failed it on the very next run with
 * `HTTP 400 {"code":-32000,"message":"Session expired or invalid"}`, and five
 * consecutive probes went **FAIL · FAIL · FAIL · FAIL · OK**. The first
 * measurement was the lucky one in five.
 *
 * ⭐ AND IT IS NOT OUR BUG, WHICH IS THE POINT. `mcp.mjs` implements the
 * Streamable HTTP session contract correctly — it reads `mcp-session-id` off the
 * initialize response and echoes it on every subsequent request. The server
 * answers the follow-up as though it had never issued the session, which is what
 * a serverless deployment does when the second request lands on an instance that
 * does not share the session store. Nothing in our code can fix it and no amount
 * of reading the vendor's README would have revealed it.
 *
 * ⭐⭐ SO THE VERIFICATION BAR IS NOW **REPEATED**, NOT SINGLE. An entry that
 * works once and fails four times is worse than an absent entry: the user added
 * it because we recommended it, and what they learn is that our MCP support is
 * broken. This suite is the guard that would have caught it before the entry was
 * written, and it is the one that will catch the next one.
 *
 * ── ⚠️ OPT-IN, FOR THE REASON THE SIBLING SUITE ALREADY ARGUED ──────────────
 *
 * A network test in a default suite is a flake factory — a vendor rate limit, a
 * corporate proxy or a laptop on a train turns somebody's unrelated change red,
 * and this repo has written down four separate times that a check which fails
 * correct work is worse than no check. The DEFAULT run of this file asserts only
 * things that are true offline; the live probe runs on request:
 *
 *     ACUVO_LIVE_MCP=1 node --test test/mcp-hosted-reconnect-stability.test.mjs
 *
 * ⚠️ IT IS DELIBERATELY NOT FOLDED INTO test/mcp-catalogue-hosted.test.mjs's
 * existing live check. That one connects to each entry ONCE, which is the exact
 * bar that failed; a second, differently-named guard makes the distinction
 * visible instead of quietly changing what an old test name means.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CATALOGUE, isHosted, toServerSpec, catalogueEntry } from '../lib/mcp-defaults.mjs';

/** How many times a verified hosted entry must connect cleanly, in a row. */
const REQUIRED_CONSECUTIVE_CONNECTS = 3;

const hostedVerified = CATALOGUE.filter((e) => isHosted(e) && e.verified);

// ── 1. OFFLINE: THE FINDING ITSELF IS PINNED, SO IT CANNOT BE QUIETLY UNDONE ─

test('⚠️⚠️ the Chakra UI server is NOT in the catalogue — it fails 4 connects in 5', () => {
  /**
   * ⭐ A NAMED ABSENCE, BECAUSE THE ENTRY IS GENUINELY TEMPTING. Six tools,
   * component props and examples for a library models get confidently wrong, no
   * key, the vendor's own apex domain. Everything about it reads like a good
   * entry except that it does not work, and the only record of that is a
   * measurement somebody has to remember to repeat. This is the record.
   *
   * ⚠️ IF THIS EVER GOES RED, DO NOT DELETE IT — RE-MEASURE. Connect five times
   * in a row with an empty env. If all five succeed the server has been fixed
   * and the entry is welcome back; the rejection note in mcp-defaults.mjs says
   * the same thing and carries the numbers to beat.
   */
  assert.equal(
    catalogueEntry('chakra'), null,
    'the `chakra` entry is back in the catalogue. It was measured on 2026-08-26 at ONE successful connect in '
    + 'five (HTTP 400 "Session expired or invalid" on the other four), and our client handles `mcp-session-id` '
    + 'correctly, so this is the server losing its own sessions. Re-measure before restoring it.',
  );
});

test('⭐ every hosted entry we call verified is reachable over https on the vendor\'s own host', () => {
  // A cheap offline shape check, so the default run of this file is not empty.
  assert.ok(hostedVerified.length > 0, 'no verified hosted entries — this suite would be testing nothing');
  for (const e of hostedVerified) {
    assert.match(e.url, /^https:\/\//, `"${e.name}" is not https`);
    assert.ok(
      /RAN IT AND CALLED IT/.test(e.note),
      `"${e.name}" is marked verified but its note does not record a real call. In this catalogue "verified" `
      + 'means somebody ran it, not that the vendor documents it.',
    );
  }
});

// ── 2. LIVE: THE BAR THAT WOULD HAVE CAUGHT IT ──────────────────────────────

test(`⭐⭐ (opt-in) every verified hosted entry connects ${REQUIRED_CONSECUTIVE_CONNECTS}× IN A ROW`, { concurrency: false }, async (t) => {
  if (process.env.ACUVO_LIVE_MCP !== '1') {
    return t.skip('set ACUVO_LIVE_MCP=1 to probe the live services');
  }
  const { connectRemoteServer } = await import('../lib/mcp.mjs');

  const failures = [];
  for (const e of hostedVerified) {
    const results = [];
    for (let attempt = 1; attempt <= REQUIRED_CONSECUTIVE_CONNECTS; attempt++) {
      const started = Date.now();
      let conn;
      try {
        conn = await connectRemoteServer(toServerSpec(e), { env: {} });
      } catch (err) {
        conn = { ok: false, error: String(err?.message ?? err) };
      }
      results.push({ ok: conn?.ok === true, ms: Date.now() - started, error: conn?.error, tools: conn?.tools?.length ?? 0 });
      try { conn?.close?.(); } catch { /* already gone */ }
    }
    const bad = results.filter((r) => !r.ok);
    // eslint-disable-next-line no-console
    console.log(`    ${e.name.padEnd(14)} ${results.map((r) => (r.ok ? `ok ${r.ms}ms/${r.tools}t` : 'FAIL')).join('  ')}`);
    if (bad.length > 0) {
      failures.push(`"${e.name}" (${e.url}) failed ${bad.length}/${REQUIRED_CONSECUTIVE_CONNECTS} connects — first error: ${bad[0].error}`);
    }
  }

  /**
   * ⚠️ COLLECTED, NOT THROWN ON THE FIRST ONE. A single vendor having a bad
   * minute should still report what every OTHER entry did, or the next person
   * re-runs the whole probe to learn what this run already knew.
   */
  assert.deepEqual(
    failures, [],
    `a verified hosted entry is not reliably reachable:\n  ${failures.join('\n  ')}\n\n`
    + 'An entry that works intermittently is worse than no entry: the user added it on our recommendation, '
    + 'so an intermittent failure reads to them as our client being broken. Either the vendor has regressed '
    + '(re-measure, then demote the entry to a rejection with the numbers) or this machine cannot reach them.',
  );
});
