/**
 * ── ⚠️⚠️ NO BROWSER IS LAUNCHED BY THIS FILE, AND THAT IS DELIBERATE ────────
 *
 * The suite runs on the owner's laptop; starting Chromium from a unit test is
 * not allowed here, and a test that only passes on a machine with a browser is
 * a test that quietly stops running. So the browser is simulated by
 * `test/fixtures/fake-browser-mcp.mjs`, which emits the exact reply shapes the
 * real `@playwright/mcp` and `chrome-devtools-mcp` servers produced when they
 * were measured (see `lib/mcp-defaults.mjs`) — derived from a real HTML file on
 * disk, `test/fixtures/playtest-page.html`.
 *
 * ⭐ WHAT THAT DOES AND DOES NOT PROVE. Everything this package owns — the
 * refusals, the loopback rule, the consent check, the driver detection, the
 * snapshot parsing, the click resolution, the inert-action digest, the ordering
 * and the bounding of the report — is exercised end to end against output
 * generated from a file. What it cannot prove is that a current Playwright
 * build still spells its tools this way; that is what the dated catalogue entry
 * is for, and this file never claims otherwise.
 *
 * ⚠️ THE ONE ASSERTION THAT MATTERS MOST is not about finding defects. It is
 * that a run which could NOT test always says so: `drove: false`, an error that
 * names what is missing, and never an empty problem list that reads as a pass.
 * `see_page` shipped the opposite for weeks — `{ looked: true, findings: [] }`
 * on pages it had never rendered — and issued all-clears the whole time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  playtest, playtestToolSchemas, playtestToolNames, runPlaytestTool,
  browserServerAvailable, chooseBrowserServer, BROWSER_SERVER_ENV, PLAYTEST_TOOL_NAMES,
  pageText, digestPage, parseSnapshotRefs, findTarget, classifyConsole, failedRequests,
  looksLikeBrowserMissing, buildReport, verdictLine, resolveTarget, normaliseSteps,
  MAX_PROBLEMS, MAX_PROBLEM_CHARS, MAX_STEPS, DRIVERS,
} from '../lib/playtest.mjs';
import { fingerprint, TRUST_ENV } from '../lib/mcp-consent.mjs';
import { TOOL_SCHEMAS, TOOL_NAMES, toolNamesForRounds, executeToolCall } from '../lib/tools.mjs';
import { adaptArgs, looksLikeFileProtocolBlocked } from '../lib/playtest.mjs';
import { fakeBrowser, FIXTURE_HTML, PLAYWRIGHT_TOOLS, PLAYWRIGHT_TOOLS_0_0_79 } from './fixtures/fake-browser-mcp.mjs';
// ⚠️ HERMETIC HOME (2026-09-26). A signed-in account now counts as a browser for `playtest` (the
// hosted drive — see `hostedDriveRoute`), so a developer's own ~/.acuvo/credentials.json changed
// what these tests saw and sent their "no browser" cases to the real gateway. Nothing here is about
// an account; `playtest-works-without-a-local-browser.test.mjs` is.
{
  const noAccount = mkdtempSync(join(tmpdir(), 'acuvo-no-account-'));
  process.env.HOME = noAccount;
  process.env.USERPROFILE = noAccount;
  delete process.env.ACUVO_HOME;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Scaffolding — a workspace with the fixture in it, and a fully wired harness
 * ──────────────────────────────────────────────────────────────────────────── */

const SERVER = Object.freeze({ name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'], env: {} });

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'playtest-'));
  copyFileSync(FIXTURE_HTML, join(root, 'index.html'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return root;
}

/** Every injectable seam, wired to the simulator and to a trusted config. */
function harness(root, { dialect = 'playwright', tools = null, servers = [SERVER], trusted = true, extraConsole = [], connect = null, strict = false } = {}) {
  const browser = fakeBrowser(join(root, 'index.html'), { dialect, tools, extraConsole, strict });
  const closed = [];
  return {
    browser,
    closed,
    opts: {
      env: {},
      configImpl: () => ({ ok: true, servers }),
      connectImpl: connect ?? (async () => browser.connection),
      callImpl: browser.callImpl,
      closeImpl: (conns) => closed.push(...conns),
      trustImpl: () => ({ trusted: trusted ? [{ fingerprint: fingerprint(servers) }] : [] }),
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE HEADLINE — it drives a real file and reports what is wrong with it
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ it opens the page, presses the primary action, and reports the defects in order', async (t) => {
  const root = workspace(t);
  const h = harness(root);

  const r = await playtest(root, {
    url: 'index.html',
    steps: [
      { do: 'type', target: 'Email', text: 'roman@example.com' },
      { do: 'click', target: 'Send' },
    ],
    expect: ['Thanks, we will be in touch'],
  }, h.opts);

  assert.equal(r.ok, true, r.error);
  assert.equal(r.drove, true, 'a run that drove the page must say so');
  assert.equal(r.loaded, true);
  assert.equal(r.actions, 2, 'both steps should have run');

  /**
   * ⚠️ THE ORDER IS THE PRODUCT, so it is asserted as an order and not as a
   * set. A model that spends its round on the fourth finding has wasted the
   * round; the console error is what explains everything under it.
   */
  assert.match(r.problems[0], /console error: .*ReferenceError: trackQuoteView is not defined/,
    `the console error is not first — got: ${JSON.stringify(r.problems, null, 2)}`);
  assert.ok(
    r.problems.some((p) => /request failed HTTP 404: .*styles\.css/.test(p)),
    `the missing stylesheet was not reported: ${JSON.stringify(r.problems)}`,
  );

  // The expected text DID appear, because the button that produces it works.
  assert.ok(!r.problems.some((p) => /never appeared/.test(p)), `a working control was reported broken: ${JSON.stringify(r.problems)}`);
  assert.match(r.summary, /problems? found/);
  assert.ok(r.measured.includes('the console') && r.measured.includes('network requests'));
  assert.deepEqual(r.unmeasured, [], 'everything was readable from this server');
});

test('⭐⭐ THE FINDING NO SCREENSHOT CATCHES: a button that is present, pressable and wired to nothing', async (t) => {
  const root = workspace(t);
  const h = harness(root);

  const r = await playtest(root, { url: 'index.html', steps: [{ do: 'click', target: 'Need help?' }] }, h.opts);

  assert.equal(r.drove, true);
  assert.equal(r.actions, 1, 'the click really was performed — this is not a click that failed');
  assert.ok(
    r.problems.some((p) => /step 1 \(click "Need help\?"\) changed nothing on the page/.test(p)),
    `the inert control was not reported: ${JSON.stringify(r.problems)}`,
  );
});

test('⭐ …and the control that DOES work is not accused of the same thing', async (t) => {
  const root = workspace(t);
  const h = harness(root);
  const r = await playtest(root, { url: 'index.html', steps: [{ do: 'click', target: 'Send' }] }, h.opts);
  assert.ok(!r.problems.some((p) => /changed nothing/.test(p)), `a working control was called inert: ${JSON.stringify(r.problems)}`);
});

test('⭐ text that never appears is reported as never having appeared, not as a pass', async (t) => {
  const root = workspace(t);
  const h = harness(root);
  // No click, so the confirmation is never produced.
  const r = await playtest(root, { url: 'index.html', expect: ['Thanks, we will be in touch'] }, h.opts);
  assert.ok(
    r.problems.some((p) => /never appeared on the page: "Thanks, we will be in touch"/.test(p)),
    `an absent expectation passed silently: ${JSON.stringify(r.problems)}`,
  );
});

test('⭐ a step whose target is not on the page is reported, and does not count as an action', async (t) => {
  const root = workspace(t);
  const h = harness(root);
  const r = await playtest(root, { url: 'index.html', steps: [{ do: 'click', target: 'Checkout' }] }, h.opts);
  assert.equal(r.actions, 0, 'a step that could not run must not be counted as driven');
  assert.ok(r.problems.some((p) => /never appeared on the page: "Checkout"/.test(p)));
  assert.ok(r.problems.some((p) => /step 1 \(click "Checkout"\) could not run/.test(p)));
});

test('⭐ phone width: content present at desktop and gone at 390px is a finding', async (t) => {
  const root = workspace(t);
  const h = harness(root);
  const r = await playtest(root, { url: 'index.html', expect: ['Need help?'], phone: true }, h.opts);
  assert.ok(r.measured.includes('390px phone width'));
  assert.ok(
    r.problems.some((p) => /present at desktop width but gone at 390px: "Need help\?"/.test(p)),
    `the responsive regression was missed: ${JSON.stringify(r.problems)}`,
  );
  assert.ok(h.browser.calls.some((c) => c.tool === 'browser_resize' && c.args.width === 390));
});

/* ────────────────────────────────────────────────────────────────────────────
 * 1a. THE SPELLING DRIFT THAT A LENIENT FIXTURE HID FOR TWO VERSIONS
 *
 * ⚠️ These run against `PLAYWRIGHT_TOOLS_0_0_79` — schemas copied off a live
 * server — with `strict: true`, so the fixture refuses exactly what the real one
 * refuses. Against the old `{element, ref}` driver every one of them fails, which
 * is the only reason they are worth their runtime.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ REGRESSION: a real 0.0.79 schema takes `target`, and the click still lands', async (t) => {
  const root = workspace(t);
  const h = harness(root, { tools: PLAYWRIGHT_TOOLS_0_0_79, strict: true });

  const r = await playtest(root, {
    url: 'index.html',
    steps: [
      { do: 'type', target: 'Email', text: 'roman@example.com' },
      { do: 'click', target: 'Send' },
    ],
  }, h.opts);

  assert.equal(r.drove, true);
  assert.equal(r.actions, 2, `steps did not land: ${JSON.stringify(r.problems)}`);
  assert.ok(
    !r.problems.some((p) => /Invalid (arguments|input)/i.test(p)),
    `the server refused our argument spelling: ${JSON.stringify(r.problems)}`,
  );

  // ⚠️ AND THE OBSOLETE KEY IS GONE, not merely tolerated. `additionalProperties:
  // false` means leaving `ref` in would have rejected the whole call.
  const click = h.browser.calls.find((c) => c.tool === 'browser_click');
  assert.ok(click, 'no click was ever attempted');
  assert.equal(click.args.target, 'e3', `the ref was not sent as \`target\`: ${JSON.stringify(click.args)}`);
  assert.ok(!('ref' in click.args), `an undeclared \`ref\` survived into the call: ${JSON.stringify(click.args)}`);
  assert.equal(click.args.element, 'button "Send"', 'the human label the server prompts with was dropped');
});

test('⭐⭐ REGRESSION: the console and the network are actually READ, not silently refused', async (t) => {
  const root = workspace(t);
  const h = harness(root, { tools: PLAYWRIGHT_TOOLS_0_0_79, strict: true });

  const r = await playtest(root, { url: 'index.html' }, h.opts);

  /**
   * Both grew a REQUIRED argument after this driver was written and both are
   * called with `{}`. Unfilled, they come back as errors, land in `unmeasured`,
   * and the page's real console error is never reported at all.
   */
  assert.ok(r.measured.includes('the console'), `the console was not read: ${JSON.stringify(r.unmeasured)}`);
  assert.ok(r.measured.includes('network requests'), `the network was not read: ${JSON.stringify(r.unmeasured)}`);
  assert.ok(
    r.problems.some((p) => /console error: .*not defined/i.test(p)),
    `the fixture's planted console error never surfaced: ${JSON.stringify(r.problems)}`,
  );

  const con = h.browser.calls.find((c) => c.tool === 'browser_console_messages');
  assert.equal(con.args.level, 'info', "the server's own default for a required argument was not used");
  const net = h.browser.calls.find((c) => c.tool === 'browser_network_requests');
  assert.equal(net.args.static, false, "the server's own default for a required argument was not used");
});

test('⚠️ adaptArgs drops what a server does not declare and fills what it requires', () => {
  const schema = {
    type: 'object',
    properties: { element: { type: 'string' }, target: { type: 'string' }, level: { type: 'string', default: 'info' } },
    required: ['target', 'level'],
    additionalProperties: false,
  };
  const out = adaptArgs({ element: 'button "Send"', ref: 'e3', target: 'e3' }, schema);
  assert.deepEqual(out, { element: 'button "Send"', target: 'e3', level: 'info' });

  // ⚠️ NO SCHEMA MEANS NO CHANGE — guessing an empty argument list would turn a
  // working call into a mystery failure on any server that publishes nothing.
  assert.deepEqual(adaptArgs({ ref: 'e3' }, undefined), { ref: 'e3' });
  assert.deepEqual(adaptArgs({ ref: 'e3' }, { type: 'object' }), { ref: 'e3' });

  // A required argument with no default falls back to the emptiest legal value.
  assert.deepEqual(
    adaptArgs({}, { type: 'object', properties: { static: { type: 'boolean' } }, required: ['static'] }),
    { static: false },
  );
});

test('⚠️⚠️ a blocked file:// protocol is reported as OUR config, never as a broken page', async (t) => {
  const root = workspace(t);
  assert.ok(looksLikeFileProtocolBlocked('### Error Error: Access to "file:" protocol is blocked. Attempted URL: "file:///x"'));
  assert.ok(!looksLikeFileProtocolBlocked('TypeError: x is not a function'));

  const h = harness(root, { tools: PLAYWRIGHT_TOOLS_0_0_79 });
  const r = await playtest(root, { url: 'index.html' }, {
    ...h.opts,
    callImpl: async () => ({ ok: false, error: 'Access to "file:" protocol is blocked. Attempted URL: "file:///x"' }),
  });

  assert.equal(r.drove, false, 'a blocked navigation must never claim to have driven');
  assert.match(r.error, /blocks file:\/\/ URLs/);
  assert.match(r.error, /acuvo mcp add browser/);
  assert.match(r.error, /--allow-unrestricted-file-access/);
  assert.ok(!/problem/i.test(r.error), 'the refusal reads as a defect in the page');
});

test('⭐ the second dialect really is driven, not merely listed', async (t) => {
  const root = workspace(t);
  const h = harness(root, { dialect: 'chrome-devtools' });
  const r = await playtest(root, { url: 'index.html', steps: [{ do: 'click', target: 'Send' }] }, h.opts);
  assert.equal(r.drove, true, r.error);
  assert.equal(r.driver, 'chrome-devtools');
  assert.equal(r.actions, 1);
  // The uid spelling, not the ref spelling — proof the table is what routed it.
  const click = h.browser.calls.find((c) => c.tool === 'click');
  assert.ok(click && click.args.uid, `chrome-devtools was called with the Playwright argument shape: ${JSON.stringify(click)}`);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. HONEST DEGRADATION — every path that could not test must SAY it did not
 * ──────────────────────────────────────────────────────────────────────────── */

const CANNOT_TEST = [
  {
    what: 'no browser server is configured at all',
    opts: (root) => ({ ...harness(root).opts, configImpl: () => ({ ok: true, servers: [] }) }),
    expect: /no browser is configured .* the page was NOT tested/s,
  },
  {
    what: 'servers exist but none of them is a browser',
    opts: (root) => ({ ...harness(root).opts, configImpl: () => ({ ok: true, servers: [{ name: 'docs', command: 'npx', args: [] }] }) }),
    expect: /no browser is configured/,
  },
  {
    what: 'the config itself is unreadable',
    opts: (root) => ({ ...harness(root).opts, configImpl: () => ({ ok: false, error: 'invalid json' }) }),
    expect: /no browser could be started: invalid json/,
  },
  {
    what: 'nobody has consented to starting the server',
    opts: (root) => harness(root, { trusted: false }).opts,
    expect: /nobody has approved starting it, so the page was NOT tested/,
  },
  {
    what: 'the server will not start',
    opts: (root) => harness(root, { connect: async () => ({ ok: false, name: 'playwright', error: 'npx canceled due to missing packages' }) }).opts,
    expect: /would not start, so the page was NOT tested: npx canceled/,
  },
  {
    what: 'the server is connected but speaks a protocol we do not understand',
    opts: (root) => harness(root, { tools: [{ name: 'do_a_thing' }] }).opts,
    expect: /does not speak a browser protocol this understands \(it offers: do_a_thing\), so the page was NOT tested/,
  },
  {
    what: 'the server is a browser server with no browser installed',
    opts: (root) => {
      const h = harness(root);
      return {
        ...h.opts,
        callImpl: async (conns, name, args) => (/browser_navigate|navigate_page/.test(name)
          ? { ok: false, error: "Executable doesn't exist at /ms-playwright/chromium-1234/chrome" }
          : h.opts.callImpl(conns, name, args)),
      };
    },
    expect: /has no browser to drive, so the page was NOT tested/,
  },
  {
    what: 'this is a --dry-run',
    opts: (root) => ({ ...harness(root).opts, dryRun: true }),
    expect: /--dry-run, so no browser was started and the page was NOT tested/,
  },
];

for (const c of CANNOT_TEST) {
  test(`⚠️⚠️ it refuses and says so: ${c.what}`, async (t) => {
    const root = workspace(t);
    const r = await playtest(root, { url: 'index.html', expect: ['anything'] }, c.opts(root));
    assert.equal(r.ok, false, 'a run that tested nothing must not return ok');
    assert.equal(r.drove, false, 'drove:true is a claim to have driven the page');
    assert.match(r.error, c.expect);
    /**
     * ⚠️ THE SHAPE THAT WOULD BE MISREAD. An empty `problems` array next to an
     * ok result is exactly how `see_page` issued all-clears for pages it never
     * rendered. A refusal must not carry one at all.
     */
    assert.equal(r.problems, undefined, 'a refusal must not carry a findings list');
    assert.equal(r.summary, undefined, 'a refusal must not carry a verdict');
  });
}

test('⚠️ the connection is closed on every path, including the ones that refuse', async (t) => {
  const root = workspace(t);
  const good = harness(root);
  await playtest(root, { url: 'index.html' }, good.opts);
  assert.equal(good.closed.length, 1, 'a successful drive left the browser running');

  const wrong = harness(root, { tools: [{ name: 'do_a_thing' }] });
  await playtest(root, { url: 'index.html' }, wrong.opts);
  assert.equal(wrong.closed.length, 1, 'a refusal after connecting left the browser running');
});

test('⚠️⚠️ it refuses a public URL — a model-chosen address is a request-forgery primitive', async (t) => {
  const root = workspace(t);
  const h = harness(root);
  for (const bad of ['https://example.com/', 'http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1.evil.com/']) {
    const r = await playtest(root, { url: bad }, h.opts);
    assert.equal(r.ok, false, `${bad} was accepted`);
    assert.equal(r.drove, false);
    assert.match(r.error, /LOOPBACK urls .* only/s);
  }
  assert.equal(h.browser.calls.length, 0, 'a refused URL still reached the browser');
});

test('⭐ …and it accepts the two shapes it exists for', (t) => {
  const root = workspace(t);
  const asFile = resolveTarget(root, 'index.html');
  assert.equal(asFile.ok, true, asFile.error);
  assert.match(asFile.url, /^file:\/\/\//);
  const asUrl = resolveTarget(root, 'http://localhost:3000/pricing');
  assert.deepEqual([asUrl.ok, asUrl.kind, asUrl.url], [true, 'url', 'http://localhost:3000/pricing']);
  assert.equal(resolveTarget(root, '').ok, false, 'an empty url must be refused, not navigated');
  assert.equal(resolveTarget(root, '../../../etc/passwd').ok, false, 'the workspace boundary must hold');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. TOKEN DISCIPLINE — the result is re-sent on every later round
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ a page that screams does not blow up the context', async (t) => {
  const root = workspace(t);
  const flood = Array.from({ length: 200 }, (_, i) => `[ERROR] TypeError: cannot read property x of undefined ${'y'.repeat(400)} #${i}`);
  const h = harness(root, { extraConsole: flood });

  const r = await playtest(root, { url: 'index.html' }, h.opts);
  assert.ok(r.problems.length <= MAX_PROBLEMS, `${r.problems.length} problems returned`);
  for (const p of r.problems) assert.ok(p.length <= MAX_PROBLEM_CHARS, `a finding is ${p.length} chars`);
  /**
   * The whole result, serialised, is what lands in the transcript. 4,000 bytes
   * is ~1,000 tokens — a ceiling, not a target, and here so that a future
   * addition which doubles it has to be a decision.
   */
  const bytes = JSON.stringify(r).length;
  assert.ok(bytes < 4_000, `the result is ${bytes} bytes; it is re-sent on every subsequent round`);
  // ⚠️ And it must not be a DOM dump by another name.
  assert.ok(!JSON.stringify(r).includes('```yaml'), 'the accessibility tree leaked into the result');
});

test('⚠️ the number of actions is bounded, so one call cannot become an unbounded session', () => {
  const asked = Array.from({ length: 50 }, () => ({ do: 'click', target: 'Send' }));
  assert.equal(normaliseSteps(asked).length, MAX_STEPS);
  // An action nobody implements is dropped rather than passed through to a server.
  assert.deepEqual(normaliseSteps([{ do: 'hack_the_planet' }, { do: 'CLICK', target: 'Send' }]), [{ do: 'click', target: 'Send', text: '' }]);
});

test('⚠️ the wall-clock budget stops a drive rather than hanging the run', async (t) => {
  const root = workspace(t);
  const h = harness(root);
  let clock = 0;
  const r = await playtest(root, {
    url: 'index.html',
    steps: [{ do: 'click', target: 'Send' }, { do: 'click', target: 'Send' }, { do: 'click', target: 'Send' }],
  }, { ...h.opts, maxRunMs: 10, now: () => (clock += 8) });
  assert.equal(r.ok, true);
  assert.ok(r.problems.some((p) => /budget ran out/.test(p)), `the budget was not reported: ${JSON.stringify(r.problems)}`);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE PARSERS — the parts most likely to be quietly wrong
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ a URL containing "404" is not a failed request', () => {
  const log = [
    '[GET] http://localhost:3000/ => [200] OK',
    '[GET] http://localhost:3000/api/404-handler => [200] OK',
    '[GET] http://localhost:3000/styles.css => [404] Not Found',
    '[POST] http://localhost:3000/api/quote => [500] Internal Server Error',
    '[GET] http://localhost:3000/slow.json',
  ].join('\n');
  const failed = failedRequests(log);
  assert.deepEqual(failed.map((f) => [f.url, f.status]), [
    ['http://localhost:3000/styles.css', 404],
    ['http://localhost:3000/api/quote', 500],
    ['http://localhost:3000/slow.json', null],
  ]);
});

test('⭐ an unhandled rejection is not filed as an ordinary console error', () => {
  const c = classifyConsole([
    '[ERROR] Uncaught TypeError: x is not a function',
    '[ERROR] Unhandled promise rejection: TypeError: failed to fetch',
    '[WARNING] deprecated api',
    '[LOG] hello',
    '[ERROR] Uncaught TypeError: x is not a function',
  ].join('\n'));
  assert.equal(c.errors.length, 1, 'identical errors must be deduped, not repeated at the model');
  assert.equal(c.rejections.length, 1);
  assert.equal(c.warnings, 1);
  assert.ok(!c.errors.some((e) => /rejection/i.test(e)), 'a rejection was double-counted as an error');
});

test('⭐ refs and labels come out of a snapshot, and an exact name beats a substring', () => {
  const snap = [
    '- heading "Get a quote" [ref=e1]',
    '- button "Save and close" [ref=e2]',
    '- button "Save" [ref=e3]',
  ].join('\n');
  const refs = parseSnapshotRefs(snap);
  assert.deepEqual(refs.map((r) => r.ref), ['e1', 'e2', 'e3']);
  assert.equal(refs[1].label, 'button "Save and close"');
  /**
   * ⚠️ THE ONE THAT WOULD SILENTLY PRESS THE WRONG BUTTON. "Save" appears
   * inside "Save and close", which is earlier in the tree — a substring-first
   * match clicks the wrong control and then reports success.
   */
  assert.equal(findTarget(refs, 'Save').ref, 'e3');
  assert.equal(findTarget(refs, 'and close').ref, 'e2', 'a substring must still work when nothing matches exactly');
  assert.equal(findTarget(refs, 'Checkout'), null);
  assert.equal(findTarget(refs, ''), null);
  // The chrome-devtools spelling of the same idea.
  assert.equal(parseSnapshotRefs('uid=1_4 button "Send"')[0].ref, '1_4');
});

test('⚠️⚠️ the "did anything change" digest ignores refs, or every click looks effective', () => {
  const a = ['- Page URL: http://x/', '- button "Send" [ref=e3]'].join('\n');
  const b = ['- Page URL: http://x/', '- button "Send" [ref=e9]'].join('\n');
  assert.equal(digestPage(a), digestPage(b), 'a re-numbered ref counted as a change');
  const c = ['- Page URL: http://x/', '- button "Send" [ref=e3]', '- text: Thanks'].join('\n');
  assert.notEqual(digestPage(a), digestPage(c), 'new content on the page did not count as a change');
  // And a navigation counts, because the URL is part of what the page shows.
  assert.notEqual(digestPage(a), digestPage(a.replace('http://x/', 'http://x/done')));
  // The echoed source code is not content — it changes on every single action.
  assert.equal(
    pageText('### Ran Playwright code\n```js\nawait page.click("#a")\n```\n### Page state\n- ok'),
    pageText('### Ran Playwright code\n```js\nawait page.click("#b")\n```\n### Page state\n- ok'),
  );
});

test('⚠️ "the browser is missing" is never reported as a defect in the page', () => {
  assert.equal(looksLikeBrowserMissing("Executable doesn't exist at /ms-playwright/chromium-1234/chrome"), true);
  assert.equal(looksLikeBrowserMissing('browserType.launch: Failed to launch'), true);
  assert.equal(looksLikeBrowserMissing('net::ERR_CONNECTION_REFUSED at http://localhost:3000'), false);
});

test('⭐ the verdict names what was measured AND what was not', () => {
  assert.match(
    verdictLine({ problems: [], measured: ['the console'], unmeasured: ['network requests'], actions: 0, loaded: true }),
    /no problems found in the console; NOT checked: network requests/,
  );
  assert.match(
    verdictLine({ problems: ['x'], measured: ['the console'], unmeasured: [], actions: 2, loaded: true }),
    /1 problem found; 2 actions driven/,
  );
  assert.match(
    verdictLine({ problems: ['x'], measured: [], unmeasured: [], actions: 0, loaded: false }),
    /the page never loaded/,
  );
});

test('⭐ the page failing to load is the first line, and nothing under it is invented', () => {
  const problems = buildReport({ loaded: false, navError: 'net::ERR_CONNECTION_REFUSED' });
  assert.deepEqual(problems, ['the page did not load: net::ERR_CONNECTION_REFUSED']);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE GATE, AND THE REGISTRATION — a verb nobody can reach costs nothing
 * ──────────────────────────────────────────────────────────────────────────── */

/** A workspace whose `.acuvo/mcp.json` declares a browser, as `mcp add` writes it. */
function rootWithBrowser(t, name = 'playwright') {
  const root = mkdtempSync(join(tmpdir(), 'playtest-gate-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'mcp.json'), JSON.stringify({
    mcpServers: { [name]: { command: 'npx', args: ['-y', '@playwright/mcp'] } },
  }), 'utf8');
  writeFileSync(join(root, 'index.js'), 'console.log(1);');
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return root;
}

test('⭐⭐ the gate reads the workspace: a browser in .acuvo/mcp.json turns the verb on', (t) => {
  const withBrowser = rootWithBrowser(t);
  const without = mkdtempSync(join(tmpdir(), 'playtest-nogate-'));
  t.after(() => { try { rmSync(without, { recursive: true, force: true }); } catch { /* windows */ } });
  writeFileSync(join(without, 'index.js'), 'console.log(1);');

  assert.equal(browserServerAvailable(withBrowser, {}), true, 'a configured browser was not seen');
  assert.equal(browserServerAvailable(without, {}), false, 'the verb is offered where there is nothing to drive');
  // The operator override, for a server under a name nobody could guess.
  assert.equal(browserServerAvailable(without, { [BROWSER_SERVER_ENV]: 'qa-browser' }), true);
});

test('⭐ chrome-devtools is recognised as a browser, and a docs server is not', () => {
  const pick = (names) => chooseBrowserServer(names.map((name) => ({ name })), {})?.name ?? null;
  assert.equal(pick(['docs', 'browser']), 'browser');
  assert.equal(pick(['docs', 'filesystem']), null);
  assert.equal(pick(['browser', 'playwright']), 'playwright', 'the preference order is not honoured');
  // The override names one exactly, and refuses to invent it when it is absent.
  assert.equal(chooseBrowserServer([{ name: 'qa' }], { [BROWSER_SERVER_ENV]: 'qa' })?.name, 'qa');
  assert.equal(chooseBrowserServer([{ name: 'playwright' }], { [BROWSER_SERVER_ENV]: 'qa' }), null);
});

test('⚠️ the gate is cheap enough to run on every single turn', (t) => {
  const root = rootWithBrowser(t);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) browserServerAvailable(root, {});
  const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 200;
  assert.ok(perCallMs < 1, `the gate costs ${perCallMs.toFixed(2)}ms per call — the database gate cost 478ms once and cancelled a test run`);
});

test('⭐⭐ REACH: declared, offered where there is a browser, silent everywhere else', (t) => {
  const root = rootWithBrowser(t);
  assert.ok(TOOL_NAMES.includes('playtest'), 'playtest is not in TOOL_SCHEMAS');
  assert.deepEqual(playtestToolSchemas().map((s) => s.function.name), [...PLAYTEST_TOOL_NAMES]);

  const offered = toolNamesForRounds(16, { root, env: {}, allowRun: true });
  assert.ok(offered.includes('playtest'), 'a configured browser did not put the verb in the offer');

  const noRun = toolNamesForRounds(16, { root, env: {}, allowRun: false });
  assert.equal(noRun.includes('playtest'), false, '--no-run must withhold a verb that starts a process');

  const single = toolNamesForRounds(1, { root, env: {}, allowRun: true });
  assert.equal(single.includes('playtest'), false, 'a report with no round left to act on it is a wasted round');

  const bare = mkdtempSync(join(tmpdir(), 'playtest-bare-'));
  t.after(() => { try { rmSync(bare, { recursive: true, force: true }); } catch { /* windows */ } });
  writeFileSync(join(bare, 'index.js'), 'console.log(1);');
  assert.equal(toolNamesForRounds(16, { root: bare, env: {}, allowRun: true }).includes('playtest'), false,
    'the verb is offered on a machine where it could only ever refuse');

  assert.deepEqual(playtestToolNames(root, {}, { allowRun: true, maxRounds: 16 }), ['playtest']);
});

test('⭐ the dispatcher runs it, and --no-run is refused there too', async (t) => {
  const root = workspace(t);
  const call = { id: 'c1', function: { name: 'playtest', arguments: JSON.stringify({ url: 'index.html' }) } };

  const refused = await executeToolCall(call, { root }, { allowRun: false });
  assert.equal(refused.result.ok, false);
  assert.equal(refused.result.drove, false);
  assert.match(refused.result.error, /--no-run/);
  assert.equal(refused.mutated, false);

  /**
   * ⚠️ AND THE ORDINARY PATH REACHES THE REAL FUNCTION. There is no browser
   * configured in this temp workspace, so the honest refusal is the proof the
   * wire is connected — an unwired case would answer "unknown tool" instead.
   */
  const wired = await executeToolCall(call, { root }, { allowRun: true });
  assert.equal(wired.result.drove, false);
  assert.match(wired.result.error, /no browser is configured/);
  assert.equal(wired.mutated, false, 'playtest writes nothing into the workspace');
});

test('⭐ runPlaytestTool honours --dry-run from the executor and refuses a name it does not own', async (t) => {
  const root = workspace(t);
  const dry = await runPlaytestTool('playtest', { url: 'index.html' }, { executor: { root, dryRun: true } });
  assert.equal(dry.drove, false);
  assert.match(dry.error, /--dry-run/);
  assert.match((await runPlaytestTool('something_else', {}, { executor: { root } })).error, /unknown playtest tool/);
});

test('⚠️ the schema stays small — it rides in the tool block on every round', () => {
  const bytes = JSON.stringify(playtestToolSchemas()).length;
  assert.ok(bytes < 2_600, `the playtest schema is ${bytes} bytes`);
  const schema = TOOL_SCHEMAS.find((s) => s.function.name === 'playtest');
  // The boundary has to be in the description: a model that does not know the
  // loopback rule spends one round discovering it and a second arguing with it.
  assert.match(schema.function.description, /LOOPBACK/);
  assert.match(schema.function.description, /never pretends/);
  assert.deepEqual(schema.function.parameters.required, ['url']);
});

test('⚠️ both drivers declare every verb the driving code calls', () => {
  const NEEDED = ['navigate', 'snapshot', 'consoleMessages', 'network', 'resize', 'click', 'type', 'press', 'waitFor'];
  for (const d of DRIVERS) {
    for (const verb of NEEDED) assert.equal(typeof d[verb], 'function', `${d.id} has no ${verb}`);
    // ⚠️ And `requires` must name tools the driver actually calls, or the
    // detection passes for a server that cannot do the work.
    for (const r of d.requires) {
      const emitted = NEEDED.map((v) => d[v]('x', 1)[0]);
      assert.ok(emitted.includes(r), `${d.id} requires "${r}" but never calls it`);
    }
  }
});
