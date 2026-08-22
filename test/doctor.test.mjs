/**
 * ── THE DOCTOR — TESTS FOR THE ONE COMMAND THAT SAYS WHAT IS ACTUALLY WORKING ─
 *
 * ⚠️ THIS FILE EXISTS BECAUSE OF A MEASURED HOUR. Four media tools were dark
 * because ONE undocumented variable (`MODAL_VIDEO_SECRET`) was missing, and the
 * message said "the speech service returned no audio" — which reads transient,
 * so the agent retried four times and burned six rounds on a call that could
 * never succeed.
 *
 * ⭐ THE PROPERTY UNDER TEST IS NOT "runDoctor returns an object". It is:
 *   1. a 200 is never taken as proof of health (the endpoints answer
 *      `200 {ok:false,error:"unauthorised"}` — measured against all four, live,
 *      2026-08-11);
 *   2. every non-live line names the exact env var or action that fixes it;
 *   3. no secret ever reaches the output, in any shape, including the
 *      prefix-and-suffix label OpenRouter's own /key endpoint hands back;
 *   4. no API key and no network still produces an honest report, and it
 *      never hangs.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Temp dirs made by the credential-finder tests below. */
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/**
 * A workspace with NOTHING beside it, so advice that depends on neighbouring
 * projects is deterministic. `clearCredentialCache` because the lookup is
 * memoised per root and a stale answer from another test would leak in.
 */
function isolatedRoot() {
  /**
   * ⚠️⚠️ NESTED, AND A FLAT TEMP DIR WAS NOT ENOUGH. The lookup scans the
   * workspace's PARENT and its children — and the parent of a bare `mkdtemp` is
   * `%TEMP%`, which on this machine is full of `.env.local` files written by
   * other tests in this very suite. So "isolated" was quietly scanning several
   * hundred neighbours and finding whatever the last test left behind.
   *
   * A workspace inside its own private parent has exactly one sibling: itself.
   */
  const parent = mkdtempSync(join(tmpdir(), 'acuvo-bare-'));
  made.push(parent);
  const root = join(parent, 'workspace');
  mkdirSync(root, { recursive: true });
  clearCredentialCache();
  return root;
}

import { mediaConfig } from '../lib/media.mjs';
import {
  runDoctor,
  formatDoctor,
  parseEnginesRange,
  checkNodeVersion,
  assessProbe,
  isOffline,
  gitignoreCoversAcuvo,
  scrubSecrets,
  toolOffer,
  clearCredentialCache,
  summarise,
  withTimeout,
  DOCTOR_STATES,
  SECRET_ENV_VARS,
  resolveMcpCommand,
  mcpCredentialGaps,
  assessMcpServer,
  cachingSupport,
  redactConfigEcho,
} from '../lib/doctor.mjs';
/**
 * ⚠️ IMPORTED SO THE COUPLING IS PINNED, NOT RESTATED. doctor.mjs has to model
 * how `mcp.mjs` starts a server (it must never actually start one), and a model
 * of somebody else's behaviour is a copy that goes stale silently. Two tests
 * below assert the real functions still behave the way doctor assumes.
 */
import { readMcpConfig, connectServer, MCP_CONFIG_FILES } from '../lib/mcp.mjs';

/** The repo under test — a real workspace, so the tool offer is real. */
const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');

const FAKE_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';
const FAKE_SECRET = 'modal-shared-secret-9f3c';

const FULL_ENV = {
  OPENROUTER_API_KEY: FAKE_KEY,
  MODAL_VIDEO_SECRET: FAKE_SECRET,
  RENDER_AUDIT_URL: 'https://example--render.modal.run',
  MODAL_TTS_URL: 'https://example--tts.modal.run',
  MODAL_TRANSCRIBE_URL: 'https://example--transcribe.modal.run',
  MODAL_PRESS_URL: 'https://example--press.modal.run',
};

/**
 * A fetch stub shaped like the LIVE services, measured 2026-08-11:
 *   POST {}          -> 200 {"ok":false,"error":"unauthorised"}
 *   POST {secret}    -> 200 {"ok":false,"error":"empty text"}   (payload complaint = AUTH PASSED)
 *   GET  /api/v1/key -> 200 {"data":{"label":"sk-or-v1-48c...20f", ...}}
 */
function makeFetch(overrides = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const hit = Object.entries(overrides).find(([frag]) => u.includes(frag));
    if (hit) return hit[1](u, body);

    if (u.includes('/api/v1/key')) {
      // ⚠️ THE REAL BODY CARRIES A PARTIAL KEY. That is the trap this fixture pins.
      return json(200, { data: { label: 'sk-or-v1-012...abcd', usage: 0.7071, limit: null } });
    }
    if (u.includes('/api/v1/credits')) return json(200, { data: { total_credits: 10, total_usage: 0.7071 } });
    if (u.includes('/api/v1/models')) {
      return json(200, {
        data: [
          { id: 'deepseek/deepseek-v4-flash-0731' },
          { id: 'deepseek/deepseek-chat' },
          { id: 'z-ai/glm-4.6' },
          { id: 'qwen/qwen3.7-flash' },
          { id: 'deepseek/deepseek-v3.2' },
        ],
      });
    }
    // The image service has a real health route. Measured live 2026-08-11:
    //   GET /health -> 200 {"ok":true,"browser":"idle"}   (~1s)
    if (u.includes('/health')) return json(200, { ok: true, browser: 'idle' });
    // A media endpoint: auth passes only when the secret rides along.
    if (!body?.secret) return json(200, { ok: false, error: 'unauthorised' });
    return json(200, { ok: false, error: 'empty text' });
  };
}

function json(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(obj); },
  };
}

/** Every string anywhere in a structure. */
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); allStrings(v, out); }
  }
  return out;
}

const flat = (report) => report.sections.flatMap((s) => s.checks);
const find = (report, id) => flat(report).find((c) => c.id === id);

const BASE = { root: REPO, now: () => 1_700_000_000_000, spawnImpl: null, timeoutMs: 500 };

// ────────────────────────────────────────────────────────────────────────────
// PURE PARTS
// ────────────────────────────────────────────────────────────────────────────

test('parseEnginesRange reads the shapes a package.json actually carries', () => {
  assert.equal(parseEnginesRange('>=20'), 20);
  assert.equal(parseEnginesRange('>=20.0.0'), 20);
  assert.equal(parseEnginesRange('>= 22.1'), 22);
  assert.equal(parseEnginesRange('^22.0.0'), 22);
  assert.equal(parseEnginesRange('22.x'), 22);
  assert.equal(parseEnginesRange('>=18 <21'), 18);
});

test('⚠️ parseEnginesRange returns null rather than guessing — absent config is not a failure', () => {
  assert.equal(parseEnginesRange(''), null);
  assert.equal(parseEnginesRange(undefined), null);
  assert.equal(parseEnginesRange(null), null);
  assert.equal(parseEnginesRange('*'), null);
  assert.equal(parseEnginesRange('latest'), null);
  assert.equal(parseEnginesRange({}), null);
});

test('checkNodeVersion: satisfied is live, unsatisfied is broken AND names the action', () => {
  const good = checkNodeVersion('v22.17.0', '>=20');
  assert.equal(good.state, 'live');
  assert.match(good.detail, /22\.17\.0/);

  const bad = checkNodeVersion('v18.20.1', '>=20');
  assert.equal(bad.state, 'broken');
  assert.ok(bad.fix, 'a broken node line must carry a fix');
  assert.match(bad.fix, /20/, 'the fix must name the version to upgrade to');
});

test('⚠️ an unknown engines field must not fail correct work — it degrades to live + honest detail', () => {
  const c = checkNodeVersion('v22.17.0', null);
  assert.equal(c.state, 'live');
  assert.match(c.detail, /engines/i);
  // And a version string we cannot parse is still not a failure of the runtime.
  assert.equal(checkNodeVersion('weird', '>=20').state, 'live');
});

test('⭐⭐ assessProbe: a 200 that says "unauthorised" is BROKEN, and the fix names MODAL_VIDEO_SECRET', () => {
  const c = assessProbe(
    { kind: 'refused', detail: 'unauthorised' },
    { envVar: 'MODAL_TTS_URL', secretVar: 'MODAL_VIDEO_SECRET', offline: false },
  );
  assert.equal(c.state, 'broken');
  assert.equal(c.verified, true, 'we have proof: the service answered');
  assert.match(c.fix, /MODAL_VIDEO_SECRET/);
});

test('assessProbe: an authorised answer is live and verified', () => {
  const c = assessProbe({ kind: 'ok', detail: 'empty text' }, { envVar: 'MODAL_TTS_URL', secretVar: 'MODAL_VIDEO_SECRET', offline: false });
  assert.equal(c.state, 'live');
  assert.equal(c.verified, true);
});

test('assessProbe: a bad HTTP status is broken and the fix names the URL variable', () => {
  const c = assessProbe({ kind: 'http', detail: 'HTTP 404' }, { envVar: 'MODAL_PRESS_URL', secretVar: 'MODAL_VIDEO_SECRET', offline: false });
  assert.equal(c.state, 'broken');
  assert.match(c.fix, /MODAL_PRESS_URL/);
});

test('assessProbe: one host unreachable while others answer IS broken — the service is down', () => {
  const c = assessProbe({ kind: 'unreachable', detail: 'ENOTFOUND' }, { envVar: 'MODAL_TTS_URL', secretVar: 'MODAL_VIDEO_SECRET', offline: false });
  assert.equal(c.state, 'broken');
  assert.match(c.fix, /MODAL_TTS_URL/);
});

test('⚠️⚠️ assessProbe: OFFLINE must not be reported as broken — that is a check failing correct work', () => {
  const c = assessProbe({ kind: 'unreachable', detail: 'ENOTFOUND' }, { envVar: 'MODAL_TTS_URL', secretVar: 'MODAL_VIDEO_SECRET', offline: true });
  assert.equal(c.state, 'live', 'configured stays configured when the machine has no network at all');
  assert.equal(c.verified, false, 'but it must say plainly that it was NOT verified');
  assert.match(c.detail, /could not check/i);
  assert.ok(c.fix, 'and still name the action that would verify it');
});

test('isOffline is true only when EVERY network probe failed at the transport layer', () => {
  const un = { kind: 'unreachable' };
  assert.equal(isOffline([un, un, un]), true);
  assert.equal(isOffline([un, un, { kind: 'ok' }]), false);
  assert.equal(isOffline([un, un, { kind: 'refused' }]), false, 'a refusal proves the network works');
  assert.equal(isOffline([un, { kind: 'http' }]), false, 'an HTTP status proves the network works');
  assert.equal(isOffline([]), false, 'no probes is not evidence of anything');
  assert.equal(isOffline([null, undefined, un]), true);
});

test('gitignoreCoversAcuvo accepts the shapes people really write', () => {
  for (const body of ['.acuvo/', '.acuvo', '/.acuvo/', '.acuvo/**', '  .acuvo/  ', 'node_modules\n.acuvo/\ndist\n', '# comment\r\n.acuvo/\r\n']) {
    assert.equal(gitignoreCoversAcuvo(body), true, `expected covered: ${JSON.stringify(body)}`);
  }
});

test('⚠️ gitignoreCoversAcuvo says NO for the near-misses, including a re-inclusion', () => {
  for (const body of ['', '   ', 'node_modules\n', '#.acuvo/\n', '.acuvo.md\n', 'acuvo/\n', '.acuvo/skills\n', '.acuvo/\n!.acuvo/\n', null, undefined]) {
    assert.equal(gitignoreCoversAcuvo(body), false, `expected NOT covered: ${JSON.stringify(body)}`);
  }
});

test('summarise counts the three states and the unverified ones separately', () => {
  const s = summarise([
    { state: 'live', verified: true }, { state: 'live', verified: false },
    { state: 'dark', verified: true }, { state: 'broken', verified: true },
  ]);
  assert.deepEqual(s, { live: 2, dark: 1, broken: 1, unverified: 1 });
  assert.deepEqual(summarise([]), { live: 0, dark: 0, broken: 0, unverified: 0 });
});

// ────────────────────────────────────────────────────────────────────────────
// SECRETS
// ────────────────────────────────────────────────────────────────────────────

test('⭐⭐ scrubSecrets removes a secret VALUE from anywhere in a nested structure', () => {
  const env = { OPENROUTER_API_KEY: FAKE_KEY, MODAL_VIDEO_SECRET: FAKE_SECRET };
  const out = scrubSecrets({ a: `key is ${FAKE_KEY} ok`, b: [{ c: FAKE_SECRET }], n: 42, z: null }, env);
  const text = JSON.stringify(out);
  assert.ok(!text.includes(FAKE_KEY));
  assert.ok(!text.includes(FAKE_SECRET));
  assert.equal(out.n, 42);
  assert.equal(out.z, null);
  assert.match(out.a, /redacted/);
});

test('⚠️⚠️ scrubSecrets also kills the PREFIX…SUFFIX label OpenRouter hands back from /api/v1/key', () => {
  // A value-substring scrub cannot catch this: `sk-or-v1-012...abcd` is not a
  // substring of the key. It is still a prefix and a suffix of a live credential.
  const out = scrubSecrets({ label: 'sk-or-v1-012...abcd', other: 'sk-proj-ABCDEFGHIJKLMNOPQRST' }, {});
  assert.ok(!JSON.stringify(out).includes('sk-or-v1-012'));
  assert.ok(!JSON.stringify(out).includes('sk-proj-ABCDEFGHIJKLMNOPQRST'));
});

test('scrubSecrets survives the legitimate shapes: empty, huge, non-ASCII, CRLF, absent env', () => {
  assert.equal(scrubSecrets('', {}), '');
  assert.equal(scrubSecrets(null, {}), null);
  assert.equal(scrubSecrets(undefined, {}), undefined);
  assert.equal(scrubSecrets('héllo — ünïcode ✓\r\nsecond line', {}), 'héllo — ünïcode ✓\r\nsecond line');
  const huge = 'x'.repeat(1_000_000);
  assert.equal(scrubSecrets(huge, { OPENROUTER_API_KEY: FAKE_KEY }).length, 1_000_000);
  // An empty-string env value must NEVER become a scrub pattern — it would
  // redact every character of every string in the report.
  assert.equal(scrubSecrets('untouched', { OPENROUTER_API_KEY: '', MODAL_VIDEO_SECRET: '   ' }), 'untouched');
});

test('SECRET_ENV_VARS names the credentials this package actually reads', () => {
  assert.ok(SECRET_ENV_VARS.includes('OPENROUTER_API_KEY'));
  assert.ok(SECRET_ENV_VARS.includes('MODAL_VIDEO_SECRET'));
});

// ────────────────────────────────────────────────────────────────────────────
// THE TOOL OFFER
// ────────────────────────────────────────────────────────────────────────────

test('⭐ toolOffer reports what WOULD be offered here, and every withheld tool says why', () => {
  const o = toolOffer({ root: REPO, env: FULL_ENV, allowRun: true, maxRounds: 8 });
  assert.ok(o.offered.length > 20, `expected a real offer, got ${o.offered.length}`);
  assert.ok(o.offered.includes('write_file'));
  assert.ok(o.offered.includes('see_page'), 'RENDER_AUDIT_URL is set in this fixture');
  assert.equal(o.offered.length + o.withheld.length, o.total);
  for (const w of o.withheld) {
    assert.ok(w.name && w.why, `withheld entry must carry name and why: ${JSON.stringify(w)}`);
    assert.ok(w.fix, `withheld ${w.name} must name the action that would enable it`);
  }
});

test('⭐⭐ a withheld MEDIA tool names the EXACT variable — "TTS: unavailable" ends no investigation', () => {
  /**
   * ⚠️ THE PRINCIPLE IS UNCHANGED AND THE VARIABLE IT NAMES CHANGED, 2026-08-12.
   * This asserted `MODAL_TTS_URL` for the four services whose URL `media.mjs`
   * BAKES IN — so the advice sent the reader to find an endpoint they do not
   * have, when the only real blocker is one credential. Naming a specific
   * variable is still the rule; naming the WRONG one was the bug.
   *
   * `see_page` keeps its URL, because the renderer genuinely has no default.
   */
  /**
   * ⚠️⚠️ AN ISOLATED ROOT, BECAUSE THE ADVICE IS NOW CONTEXT-SENSITIVE. The
   * doctor looks for the credential in neighbouring projects, so run against the
   * real REPO this asserted one sentence on a machine where nothing is nearby
   * and a different one on this laptop, where `MODAL_VIDEO_SECRET` sits in a
   * sibling. A test whose result depends on what happens to be next to the
   * checkout is a test that gets deleted the first week it fires in CI.
   */
  const bare = isolatedRoot();
  const o = toolOffer({ root: bare, env: {}, allowRun: true, maxRounds: 8 });
  const byName = Object.fromEntries(o.withheld.map((w) => [w.name, w]));
  for (const name of ['speak', 'transcribe', 'make_document']) {
    assert.match(byName[name].fix, /ACUVO_MEDIA_SECRET/, `${name} must name the credential that actually unblocks it`);
    assert.doesNotMatch(byName[name].why, /unavailable/i);
  }
  assert.match(byName.see_page.why, /RENDER_AUDIT_URL/);
});

test('--no-run is named by name for every tool it withholds', () => {
  const o = toolOffer({ root: REPO, env: FULL_ENV, allowRun: false, maxRounds: 8 });
  const byName = Object.fromEntries(o.withheld.map((w) => [w.name, w]));
  for (const name of ['run_command', 'run_program', 'evaluate', 'git_commit', 'check_acceptance']) {
    assert.ok(byName[name], `${name} should be withheld under --no-run`);
    assert.match(byName[name].why, /--no-run/);
  }
});

test('a single-shot run explains the round budget rather than blaming configuration', () => {
  const o = toolOffer({ root: REPO, env: FULL_ENV, allowRun: true, maxRounds: 1 });
  const byName = Object.fromEntries(o.withheld.map((w) => [w.name, w]));
  assert.match(byName.read_file.why, /round/i);
  assert.match(byName.read_file.fix, /rounds/i);
});

/**
 * ── ⚠️ THIS TEST'S PREMISE WAS RETIRED BY BUNDLING THE SKILLS ───────────────
 *
 * It asserted that `read_skill` is WITHHELD in a workspace with no
 * `.acuvo/skills`, and that the reason names that directory. Skills ship with
 * the CLI now, so a bare workspace has a full shelf and `read_skill` is
 * OFFERED — `byName.read_skill` was simply undefined, and the test died on a
 * property of nothing rather than on the thing it was checking.
 *
 * ⭐ The half that is still live is the LSP half, and it is the more valuable
 * one: those tools genuinely are withheld until a language server is installed,
 * and a reason that does not name the install command is exactly the non-answer
 * this doctor exists to avoid.
 */
test('read_skill is now OFFERED everywhere, and the LSP tools still name the install command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-offer-'));
  try {
    writeFileSync(join(dir, 'index.ts'), 'export const a = 1;\n');
    const o = toolOffer({ root: dir, env: FULL_ENV, allowRun: true, maxRounds: 8 });
    const byName = Object.fromEntries(o.withheld.map((w) => [w.name, w]));
    assert.equal(
      byName.read_skill,
      undefined,
      'read_skill is withheld in a bare workspace — the bundled shelf is not reaching it',
    );
    if (byName.check_types) {
      assert.ok(byName.check_types.fix, 'a withheld LSP tool with no fix is the non-answer this doctor exists to avoid');
      assert.ok(/language server|typescript-language-server|manifest|source file/i.test(byName.check_types.why), byName.check_types.why);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ toolOffer never throws on a workspace it cannot read', () => {
  const o = toolOffer({ root: join(tmpdir(), 'doctor-does-not-exist-' + Date.now()), env: {}, allowRun: true, maxRounds: 8 });
  assert.ok(Array.isArray(o.offered));
  assert.ok(Array.isArray(o.withheld));
});

// ────────────────────────────────────────────────────────────────────────────
// THE REPORT
// ────────────────────────────────────────────────────────────────────────────

test('⭐ the healthy path: everything configured and authorised reads live, and ok is true', async () => {
  const report = await runDoctor({ ...BASE, env: FULL_ENV, fetchImpl: makeFetch() });
  assert.equal(report.ok, true, JSON.stringify(report.sections, null, 1));
  assert.equal(report.generatedAt, 1_700_000_000_000);
  assert.equal(find(report, 'model.key').state, 'live');
  assert.equal(find(report, 'media.speak').state, 'live');
  assert.equal(find(report, 'media.speak').verified, true, 'a payload complaint proves auth passed');
  assert.equal(find(report, 'media.see_page').state, 'live');
});

test('⭐⭐ THE HOUR THIS COMMAND EXISTS TO SAVE: secret missing → every media line is BROKEN and names it', async () => {
  const env = { ...FULL_ENV };
  delete env.MODAL_VIDEO_SECRET;
  const report = await runDoctor({ ...BASE, env, fetchImpl: makeFetch() });
  assert.equal(report.ok, false);
  for (const id of ['media.speak', 'media.transcribe', 'media.make_document', 'media.see_page']) {
    const c = find(report, id);
    assert.equal(c.state, 'broken', `${id} answered HTTP 200 — that is NOT proof of health`);
    assert.match(c.fix, /MODAL_VIDEO_SECRET/, `${id} must name the variable`);
  }
});

test('⭐⭐ a key that is PRESENT and REVOKED is broken — presence is what everything else checks', async () => {
  const report = await runDoctor({
    ...BASE,
    env: FULL_ENV,
    fetchImpl: makeFetch({
      '/api/v1/key': () => json(401, { error: { message: 'User not found.', code: 401 } }),
      '/api/v1/credits': () => json(401, { error: { message: 'User not found.' } }),
    }),
  });
  const c = find(report, 'model.key');
  assert.equal(c.state, 'broken');
  assert.match(c.detail + ' ' + c.fix, /OPENROUTER_API_KEY/);
  assert.equal(report.ok, false);
  /**
   * ⚠️ THE WORDING IS PART OF THE CONTRACT, and a mutation caught this test
   * passing for the wrong reason: with the 401 branch deleted the generic
   * ">=400" branch still returned `broken`, so the assertion above stayed green
   * while the diagnosis went from "your key is revoked" to "something went
   * wrong". Those send a reader to two different places.
   */
  assert.match(c.detail, /does NOT authenticate/);
  assert.match(c.fix, /replace/i);
  // And the credits line must NOT also go red — one cause, one red line.
  assert.equal(find(report, 'model.credits'), undefined);
});

test('⚠️ a 5xx from the key endpoint is broken but must NOT accuse the key — that is a different action', async () => {
  const report = await runDoctor({
    ...BASE,
    env: FULL_ENV,
    fetchImpl: makeFetch({ '/api/v1/key': () => json(503, { error: 'upstream unavailable' }) }),
  });
  const c = find(report, 'model.key');
  assert.equal(c.state, 'broken');
  assert.ok(!/does NOT authenticate/.test(c.detail), 'a 503 is not evidence about the credential');
  assert.match(c.detail, /503/);
  assert.match(c.fix, /retry/i);
});

test('an absent key is DARK, not broken, and points at where to get one', async () => {
  const env = { ...FULL_ENV };
  delete env.OPENROUTER_API_KEY;
  const report = await runDoctor({ ...BASE, env, fetchImpl: makeFetch() });
  const c = find(report, 'model.key');
  assert.equal(c.state, 'dark');
  assert.match(c.fix, /OPENROUTER_API_KEY/);
  assert.match(c.fix, /openrouter\.ai/);
});

test('⭐ a model id that is not in the catalogue is broken BY NAME — a 404 chain is a silent outage', async () => {
  const report = await runDoctor({
    ...BASE,
    env: { ...FULL_ENV, OPENROUTER_CODEGEN_MODEL: 'acme/retired-model-v1' },
    fetchImpl: makeFetch(),
  });
  const c = find(report, 'model.chain.acme/retired-model-v1');
  assert.ok(c, 'the configured model must appear as its own line');
  assert.equal(c.state, 'broken');
  assert.match(c.fix, /OPENROUTER_CODEGEN_MODEL/);
  // The healthy fallbacks are still reported as live — one bad id is not an outage.
  assert.equal(find(report, 'model.chain.deepseek/deepseek-chat').state, 'live');
});

test('⭐ zero credits is broken even though the key authenticates — every paid model will 402', async () => {
  const report = await runDoctor({
    ...BASE,
    env: FULL_ENV,
    fetchImpl: makeFetch({ '/api/v1/credits': () => json(200, { data: { total_credits: 0.5, total_usage: 0.5 } }) }),
  });
  const c = find(report, 'model.credits');
  assert.equal(c.state, 'broken');
  assert.match(c.fix, /openrouter\.ai\/credits|top up/i);
});

test('a malformed endpoint URL is caught before any request is made', async () => {
  const report = await runDoctor({
    ...BASE,
    env: { ...FULL_ENV, MODAL_TTS_URL: 'not a url' },
    fetchImpl: makeFetch(),
  });
  const c = find(report, 'media.speak');
  assert.equal(c.state, 'broken');
  assert.match(c.fix, /MODAL_TTS_URL/);
  assert.match(c.detail, /url/i);
});

test('⚠️ see_page names the PRIMARY variable when neither is set — caught in a live run', async () => {
  // Found by looking at real output: with both unset the line read
  // "MODAL_RENDER_AUDIT_URL is unset", sending the reader to the FALLBACK name.
  const report = await runDoctor({ ...BASE, env: {}, fetchImpl: null });
  const c = find(report, 'media.see_page');
  assert.equal(c.state, 'dark');
  assert.match(c.detail, /^RENDER_AUDIT_URL is unset/, c.detail);
  assert.match(c.fix, /RENDER_AUDIT_URL/);
});

test('⭐ but when the FALLBACK variable is the one carrying the value, the report says so', async () => {
  const report = await runDoctor({
    ...BASE,
    env: { MODAL_RENDER_AUDIT_URL: 'https://example--render.modal.run', MODAL_VIDEO_SECRET: FAKE_SECRET },
    fetchImpl: makeFetch(),
  });
  const c = find(report, 'media.see_page');
  assert.equal(c.state, 'live');
  // And when it breaks, the fix must name the variable actually in play.
  const broken = await runDoctor({
    ...BASE,
    env: { MODAL_RENDER_AUDIT_URL: 'https://example--render.modal.run' },
    fetchImpl: makeFetch(),
  });
  assert.equal(find(broken, 'media.see_page').state, 'broken');
});

test('an endpoint with NO SECRET is DARK and the line ends the investigation', async () => {
  /**
   * ⚠️⚠️ WHAT "DARK" MEANS CHANGED, AND THIS TEST HAD TO FOLLOW. It used to
   * delete `MODAL_TTS_URL` and expect dark — but the URLs are baked in now
   * (measured: all eight media endpoints are LIVE, and a fresh install could
   * not reach a single one because nobody had told it the addresses). With a
   * secret present, an unset URL is no longer dark; it falls back to ours.
   *
   * ⭐ So the dark path is the one that still matters on a PAID GPU: no
   * credential, no capability. Fail shut.
   */
  const env = { ...FULL_ENV };
  delete env.MODAL_TTS_URL;
  delete env.MODAL_VIDEO_SECRET;
  delete env.ACUVO_MEDIA_SECRET;
  const report = await runDoctor({ ...BASE, env, fetchImpl: makeFetch() });
  const c = find(report, 'media.speak');
  assert.equal(c.state, 'dark');
  /**
   * ⚠️ IT NAMES THE CREDENTIAL, NOT THE URL — corrected 2026-08-12. This asserted
   * `MODAL_TTS_URL`, which sent the reader to find an endpoint `media.mjs`
   * already knows. The rule was always "name the thing that unblocks it"; the
   * thing that unblocks it is the secret.
   */
  assert.match(c.detail + ' ' + c.fix, /ACUVO_MEDIA_SECRET/);
  assert.doesNotMatch(c.fix, /endpoint URL/);
});

test('⚠️ an EXPLICITLY EMPTY endpoint stays dark even with a secret', () => {
  /**
   * ⚠️ Somebody who writes `MODAL_TTS_URL=` on an air-gapped machine, or under
   * a policy that forbids the call, has made a DECISION. Treating that the same
   * as "unset" would silently reinstate our endpoint and turn an opt-out into a
   * surprise network call — the exact distinction `IMAGE_URL_ENV` already draws.
   */
  const cfg = mediaConfig({ MODAL_VIDEO_SECRET: 'shh', MODAL_TTS_URL: '' });
  assert.equal(cfg.speak, null);
  assert.ok(cfg.transcribe, 'switching one capability off must not switch off the others');
});

test('⚠️⚠️ NO KEY AND NO NETWORK: honest, complete, ok, and it does not throw', async () => {
  const report = await runDoctor({ ...BASE, env: {}, fetchImpl: null });
  assert.equal(report.probed, false);
  assert.equal(report.ok, true, 'an unconfigured machine is not a BROKEN machine');
  assert.ok(flat(report).length > 5);
  for (const c of flat(report)) {
    assert.ok(DOCTOR_STATES.includes(c.state), `bad state ${c.state} on ${c.id}`);
    if (c.state !== 'live') assert.ok(c.fix, `${c.id} is ${c.state} with no fix`);
  }
});

test('⚠️ OFFLINE: every probe transport-fails → unverified, not a wall of false alarms', async () => {
  const report = await runDoctor({
    ...BASE,
    env: FULL_ENV,
    fetchImpl: async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; },
  });
  assert.equal(report.offline, true);
  assert.equal(report.ok, true, 'no network is not the same as broken software');
  const speak = find(report, 'media.speak');
  assert.equal(speak.state, 'live');
  assert.equal(speak.verified, false);
  assert.match(speak.detail, /could not check/i);
  assert.ok(report.summary.unverified > 0);
});

test('⚠️ one host down while the rest answer IS reported as broken', async () => {
  const report = await runDoctor({
    ...BASE,
    env: FULL_ENV,
    fetchImpl: makeFetch({
      'tts.modal.run': async () => { const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; },
    }),
  });
  assert.equal(report.offline, false);
  assert.equal(find(report, 'media.speak').state, 'broken');
  assert.equal(find(report, 'media.transcribe').state, 'live');
});

test('every check in every scenario carries a legal state, and every non-live one carries a fix', async () => {
  const scenarios = [
    { env: FULL_ENV, fetchImpl: makeFetch() },
    { env: {}, fetchImpl: makeFetch() },
    { env: { MODAL_TTS_URL: 'https://x--tts.modal.run' }, fetchImpl: makeFetch() },
    { env: { PERCHANCE_IMAGE_URL: '' }, fetchImpl: null },
  ];
  for (const s of scenarios) {
    const report = await runDoctor({ ...BASE, ...s });
    assert.ok(report.sections.length >= 4);
    for (const c of flat(report)) {
      assert.ok(DOCTOR_STATES.includes(c.state), `${c.id}: ${c.state}`);
      assert.equal(typeof c.label, 'string');
      assert.ok(c.label.length > 0);
      if (c.state !== 'live') assert.ok(c.fix && c.fix.length > 3, `${c.id} (${c.state}) has no usable fix`);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// NEVER PRINT A SECRET
// ────────────────────────────────────────────────────────────────────────────

test('⭐⭐ the key value appears NOWHERE — not in the report, not in the rendering', async () => {
  const report = await runDoctor({ ...BASE, env: FULL_ENV, fetchImpl: makeFetch() });
  const text = JSON.stringify(report) + '\n' + formatDoctor(report);
  assert.ok(!text.includes(FAKE_KEY), 'the raw key leaked');
  assert.ok(!text.includes(FAKE_SECRET), 'the modal secret leaked');
});

test('⚠️ not a prefix, not a suffix, not a LENGTH', async () => {
  const report = await runDoctor({ ...BASE, env: FULL_ENV, fetchImpl: makeFetch() });
  const text = JSON.stringify(report) + '\n' + formatDoctor(report);
  assert.ok(!text.includes(FAKE_KEY.slice(0, 16)), 'a 16-char prefix of the key is still the key');
  assert.ok(!text.includes(FAKE_KEY.slice(-12)), 'a suffix is still the key');
  assert.ok(!/\b73 (characters|chars|bytes)\b/.test(text), 'the length identifies the key format');
  assert.ok(!/sk-or-v1-[A-Za-z0-9]/.test(text), 'no key-shaped token at all');
  // And it must still SAY something useful about the key.
  assert.match(text, /present/i);
});

test('⚠️ a hostile response body that echoes the key back cannot launder it into the report', async () => {
  const report = await runDoctor({
    ...BASE,
    env: FULL_ENV,
    fetchImpl: makeFetch({
      '/api/v1/key': () => json(407, { error: `proxy rejected\nauthorization: Bearer ${FAKE_KEY}` }),
    }),
  });
  const text = JSON.stringify(report) + '\n' + formatDoctor(report);
  assert.ok(!text.includes(FAKE_KEY), 'the proxy echo leaked the key');
});

test('⚠️ a URL is reported by HOST only — a path or query can carry a token', async () => {
  const report = await runDoctor({
    ...BASE,
    env: { ...FULL_ENV, MODAL_TTS_URL: 'https://user:pw@example--tts.modal.run/v1/say?token=SUPERSECRETTOKEN' },
    fetchImpl: makeFetch(),
  });
  const text = JSON.stringify(report) + '\n' + formatDoctor(report);
  assert.ok(!text.includes('SUPERSECRETTOKEN'));
  assert.ok(!text.includes('user:pw'));
  assert.match(text, /example--tts\.modal\.run/);
});

// ────────────────────────────────────────────────────────────────────────────
// THE OUTPUT IS THE PRODUCT
// ────────────────────────────────────────────────────────────────────────────

test('⭐⭐ every dark or broken line is followed by an arrow line naming the fix', async () => {
  const env = { ...FULL_ENV };
  delete env.MODAL_VIDEO_SECRET;
  delete env.MODAL_PRESS_URL;
  const report = await runDoctor({ ...BASE, env, fetchImpl: makeFetch() });
  const out = formatDoctor(report);
  const bad = flat(report).filter((c) => c.state !== 'live');
  assert.ok(bad.length > 0);
  for (const c of bad) assert.ok(out.includes(c.fix), `the rendering dropped the fix for ${c.id}: ${c.fix}`);
  assert.match(out, /→/, 'fixes are rendered as their own arrow line');
  assert.match(out, /MODAL_VIDEO_SECRET/);
});

test('formatDoctor emits no ANSI unless a painter is handed in', async () => {
  const report = await runDoctor({ ...BASE, env: FULL_ENV, fetchImpl: makeFetch() });
  // eslint-disable-next-line no-control-regex
  assert.ok(!/\x1b\[/.test(formatDoctor(report)), 'colour leaked into an unpainted render');
  const paint = { dim: (t) => `<d>${t}</d>`, gold: (t) => `<g>${t}</g>`, green: (t) => `<G>${t}</G>`, red: (t) => `<r>${t}</r>`, bold: (t) => t, cyan: (t) => t };
  assert.match(formatDoctor(report, { paint }), /<G>/);
});

test('formatDoctor states the three words and the totals, and never says "unavailable"', async () => {
  /**
   * ⚠️ THE SECRET IS DELETED TOO. With one present, an unset MODAL_TTS_URL now
   * falls back to our baked-in endpoint and the line is LIVE — so removing the
   * URL alone no longer produces a dark line to assert on. The media URLs became
   * defaults because all eight endpoints were measured LIVE while a fresh
   * install could not reach a single one.
   */
  const env = { ...FULL_ENV };
  delete env.MODAL_TTS_URL;
  delete env.MODAL_VIDEO_SECRET;
  delete env.ACUVO_MEDIA_SECRET;
  const report = await runDoctor({ ...BASE, env, fetchImpl: makeFetch() });
  const out = formatDoctor(report);
  assert.match(out, /\blive\b/);
  assert.match(out, /\bdark\b/);
  // ⚠️ The variable that ACTUALLY unblocks it — see the media.speak test above.
  assert.match(out, /ACUVO_MEDIA_SECRET/, 'the dark line must name the variable, not say "unavailable"');
  assert.ok(!/\bunavailable\b/i.test(out), 'a diagnostic that says "unavailable" has done nothing');
});

test('formatDoctor survives an empty and a malformed report without throwing', () => {
  assert.equal(typeof formatDoctor({ sections: [], summary: { live: 0, dark: 0, broken: 0, unverified: 0 } }), 'string');
  assert.equal(typeof formatDoctor({}), 'string');
  assert.equal(typeof formatDoctor(null), 'string');
});

// ────────────────────────────────────────────────────────────────────────────
// IT MUST NEVER HANG
// ────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ withTimeout bounds a promise that never settles, and clears its timer', async () => {
  const t0 = Date.now();
  const r = await withTimeout(new Promise(() => {}), 25, 'sentinel');
  assert.equal(r, 'sentinel');
  assert.ok(Date.now() - t0 < 2_000);
});

test('withTimeout passes a fast result straight through', async () => {
  assert.equal(await withTimeout(Promise.resolve('fast'), 5_000, 'nope'), 'fast');
});

test('⚠️⚠️ a fetch that never resolves cannot hang the doctor — probes are bounded, not trusted', async () => {
  const t0 = Date.now();
  const report = await runDoctor({
    ...BASE,
    timeoutMs: 40,
    env: FULL_ENV,
    fetchImpl: () => new Promise(() => {}),
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5_000, `doctor took ${elapsed}ms — probes are not bounded`);
  assert.equal(report.offline, true, 'nothing answered, so nothing is claimed as verified');
  assert.equal(report.ok, true);
});

test('⚠️ probes run CONCURRENTLY — measured by overlap, not by the clock', async () => {
  /**
   * ⚠️⚠️ THIS TEST USED TO ASSERT `elapsed < 900ms` AND IT WAS FLAKY. Under
   * `node --test` the whole suite's files run in parallel, so a wall-clock
   * budget measures how loaded the machine is at least as much as it measures
   * this code. It failed on correct code roughly one run in three, and a check
   * that fails correct work is worse than no check: it trains you to re-run
   * until green, which is how a real regression gets waved through.
   *
   * ⭐ THE PROPERTY WAS NEVER "IT IS FAST", IT WAS "THEY OVERLAP". Counting how
   * many probes are in flight at once measures exactly that, is immune to load,
   * and fails for the right reason — a sequential implementation can never get
   * `peak` above 1, however fast or slow the machine is.
   */
  let inFlight = 0;
  let peak = 0;
  await runDoctor({
    ...BASE,
    timeoutMs: 3_000,
    env: FULL_ENV,
    fetchImpl: async (url, init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 20));
        return makeFetch()(url, init);
      } finally {
        inFlight -= 1;
      }
    },
  });
  assert.ok(peak > 1, `probes ran one at a time — peak concurrency was ${peak}`);
});

test('⚠️ a fetchImpl that throws synchronously is data, not a crash', async () => {
  const report = await runDoctor({
    ...BASE,
    env: FULL_ENV,
    fetchImpl: () => { throw new TypeError('bad fetch impl'); },
  });
  assert.equal(typeof report.ok, 'boolean');
  assert.ok(flat(report).length > 0);
});

test('⚠️ a response whose body is not JSON is handled honestly', async () => {
  const report = await runDoctor({
    ...BASE,
    env: FULL_ENV,
    fetchImpl: makeFetch({
      'tts.modal.run': () => ({ ok: true, status: 200, async text() { return '<html>gateway</html>'; } }),
    }),
  });
  const c = find(report, 'media.speak');
  assert.equal(c.state, 'broken');
  assert.ok(c.fix);
});

// ────────────────────────────────────────────────────────────────────────────
// THE WORKSPACE
// ────────────────────────────────────────────────────────────────────────────

test('a workspace that is not a repo is dark and says git init', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-nogit-'));
  try {
    const report = await runDoctor({
      ...BASE, root: dir, env: {}, fetchImpl: null,
      gitStatusImpl: async () => ({ ok: false, error: 'this workspace is not a git repository, so there is nothing to inspect or commit' }),
    });
    const c = find(report, 'workspace.git');
    assert.equal(c.state, 'dark');
    assert.match(c.fix, /git init/);
    assert.equal(find(report, 'workspace.gitignore'), undefined, 'no repo means no gitignore question to answer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ a repo whose .gitignore does not cover .acuvo/ is dark and names the exact line to add', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-git-'));
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\ndist\n');
    const report = await runDoctor({
      ...BASE, root: dir, env: {}, fetchImpl: null,
      gitStatusImpl: async () => ({ ok: true, branch: 'main', files: [], clean: true }),
    });
    const g = find(report, 'workspace.gitignore');
    assert.equal(g.state, 'dark');
    assert.match(g.fix, /\.acuvo\//);
    assert.match(g.detail, /\.acuvo\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ a DIRTY repo is live, not broken — uncommitted work is information, not a fault', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-dirty-'));
  try {
    mkdirSync(join(dir, '.acuvo'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '.acuvo/\n');
    const report = await runDoctor({
      ...BASE, root: dir, env: {}, fetchImpl: null,
      gitStatusImpl: async () => ({ ok: true, branch: 'acuvo', files: [{ path: 'a.ts' }, { path: 'b.ts' }], clean: false }),
    });
    const c = find(report, 'workspace.git');
    assert.equal(c.state, 'live');
    assert.match(c.detail, /acuvo/);
    assert.match(c.detail, /2/);
    assert.equal(find(report, 'workspace.gitignore').state, 'live');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ a .gitignore that cannot be read does not take the doctor down', async () => {
  const report = await runDoctor({
    ...BASE, env: {}, fetchImpl: null,
    gitStatusImpl: async () => ({ ok: true, branch: 'main', files: [], clean: true }),
    readFileImpl: () => { throw new Error('EACCES'); },
  });
  const g = find(report, 'workspace.gitignore');
  assert.equal(g.state, 'dark');
  assert.ok(g.fix);
});

test('⚠️ a git probe that rejects is caught — the doctor reports, it does not crash', async () => {
  const report = await runDoctor({
    ...BASE, env: {}, fetchImpl: null,
    gitStatusImpl: async () => { throw new Error('git is not installed'); },
  });
  const c = find(report, 'workspace.git');
  assert.ok(['dark', 'broken'].includes(c.state));
  assert.ok(c.fix);
});

test('⚠️⚠️ a git that never answers cannot hang the doctor either — git.mjs owns a 20s timeout, we do not inherit it', async () => {
  const t0 = Date.now();
  const report = await runDoctor({
    ...BASE, env: {}, fetchImpl: null, gitTimeoutMs: 40,
    gitStatusImpl: () => new Promise(() => {}),
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5_000, `git probe was not bounded: ${elapsed}ms`);
  const c = find(report, 'workspace.git');
  assert.equal(c.state, 'dark');
  assert.ok(c.fix);
  assert.match(c.detail, /did not answer|timed out|stopped waiting/i);
});

test('the report names the workspace and the platform without leaking the environment', async () => {
  const report = await runDoctor({ ...BASE, env: FULL_ENV, fetchImpl: makeFetch() });
  assert.equal(report.root, REPO);
  assert.equal(typeof report.platform, 'string');
  assert.match(formatDoctor(report), /node/i);
});

// ────────────────────────────────────────────────────────────────────────────
// MCP — DECLARED, AND WHAT CAN BE KNOWN WITHOUT SPAWNING ANYTHING
//
// ⚠️ THE BOUND IS THE DESIGN. An MCP server is a program, most are `npx`, and on
// this network an npx server HANGS for minutes on a cold cache. A diagnostic
// that spawns eight of them to answer "is it configured" is a diagnostic nobody
// runs twice. So every test below asserts a verdict reached WITHOUT a spawn.
// ────────────────────────────────────────────────────────────────────────────

test('resolveMcpCommand: an absolute path that exists resolves; one that does not is missing', () => {
  assert.equal(resolveMcpCommand(process.execPath).kind, 'path');
  assert.equal(resolveMcpCommand(join(tmpdir(), 'no-such-server-zzz', 'server.js')).kind, 'missing-path');
});

test('⚠️ resolveMcpCommand walks PATH with PATHEXT, extensions BEFORE the bare name', () => {
  // The exact trap mcp.mjs documents: nodejs ships both `npx` (a bash script
  // Windows cannot spawn) and `npx.cmd`. Resolving the bare name first finds a
  // file that exists and still fails — the hardest kind to diagnose.
  const exists = (p) => /\.CMD$/i.test(p) || /server$/.test(p);
  const r = resolveMcpCommand('server', {
    platform: 'win32',
    env: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' },
    existsImpl: exists,
    statImpl: () => ({ isFile: () => true }),
  });
  assert.equal(r.kind, 'path');
  assert.match(r.path, /\.CMD$/i, `the bare name won the race: ${r.path}`);
});

test('resolveMcpCommand: a command on no PATH at all is missing, and an EMPTY PATH is not knowable', () => {
  assert.equal(resolveMcpCommand('definitely-not-installed-zzz', {
    platform: 'linux', env: { PATH: '/usr/bin:/bin' }, existsImpl: () => false,
  }).kind, 'missing');
  assert.equal(resolveMcpCommand('anything', { platform: 'linux', env: {} }).kind, 'unknown');
});

test('⭐ resolveMcpCommand routes npm/npx through node own entry point, exactly as mcp.mjs spawns them', () => {
  const r = resolveMcpCommand('npx', { execPath: process.execPath, existsImpl: (p) => /npx-cli\.js$/.test(p) });
  assert.equal(r.kind, 'node-entry');
  assert.match(r.path, /npx-cli\.js$/);
  assert.equal(resolveMcpCommand('npx', { existsImpl: () => false }).kind, 'missing-npm');
});

test('⚠️⚠️ COUPLING: readMcpConfig does NOT expand ${VAR} — if that ever changes, doctor lies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-mcp-cfg-'));
  try {
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { gh: { command: 'node', args: ['s.js'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } } },
    }));
    const cfg = readMcpConfig(dir);
    assert.equal(cfg.ok, true);
    assert.equal(cfg.servers[0].env.GITHUB_TOKEN, '${GITHUB_TOKEN}',
      'mcp.mjs now expands placeholders — update assessMcpServer, it reports this as broken');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️⚠️ COUPLING: a config env entry OVERRIDES the real variable — proven without spawning', async () => {
  let captured = null;
  // A spawnImpl that records and returns no stdio: connectServer gives up
  // immediately, so nothing is ever executed, and we still see the env it built.
  const res = await connectServer(
    { name: 'gh', command: 'node', args: [], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
    { root: process.cwd(), spawnImpl: (_f, _a, opts) => { captured = opts; return {}; } },
  );
  assert.equal(res.ok, false);
  assert.equal(captured.env.GITHUB_TOKEN, '${GITHUB_TOKEN}',
    'the literal placeholder must land in the child env, overriding any real token — this is what doctor reports');
});

test('mcpCredentialGaps: a ${VAR} placeholder and an empty value are gaps; a real value is not', () => {
  const gaps = mcpCredentialGaps({ A: '${A_TOKEN}', B: '', C: 'a-real-literal-value' }, { A_TOKEN: 'set-in-the-shell' });
  assert.deepEqual(gaps.map((g) => g.key).sort(), ['A', 'B']);
  assert.equal(gaps.find((g) => g.key === 'A').kind, 'placeholder');
  assert.equal(gaps.find((g) => g.key === 'B').kind, 'empty');
});

test('⭐ assessMcpServer: a healthy server is live-but-UNVERIFIED and says so in words', () => {
  const c = assessMcpServer(
    { name: 'files', command: 'node', args: [], env: {} },
    { file: '.mcp.json', env: {}, resolution: { kind: 'path', path: '/usr/bin/node' } },
  );
  assert.equal(c.state, 'live');
  assert.equal(c.verified, false, 'nothing was spawned, so nothing was proved');
  assert.match(c.detail, /not checked/i);
  assert.match(c.detail, /\.mcp\.json/);
});

test('⭐⭐ assessMcpServer: a command that cannot be found is BROKEN and names the command', () => {
  const c = assessMcpServer(
    { name: 'linear', command: 'linear-mcp', args: [], env: {} },
    { file: '.acuvo/mcp.json', env: {}, resolution: { kind: 'missing', path: null } },
  );
  assert.equal(c.state, 'broken');
  assert.match(c.detail, /linear-mcp/);
  assert.match(c.fix, /\.acuvo\/mcp\.json/);
});

test('⭐⭐ assessMcpServer: the placeholder that is never expanded is named — variable, file and remedy', () => {
  const c = assessMcpServer(
    { name: 'gh', command: 'node', args: [], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
    { file: '.mcp.json', env: { GITHUB_TOKEN: 'a-real-token-value' }, resolution: { kind: 'path', path: '/usr/bin/node' } },
  );
  // ⚠️ The variable IS set in the shell — and it is still broken, because the
  // config value overwrites it with the literal text. A "gap" check that only
  // looked for an absent variable would give this an all-clear.
  assert.equal(c.state, 'broken');
  assert.match(c.detail, /GITHUB_TOKEN/);
  assert.ok(!c.detail.includes('a-real-token-value'), 'a doctor never prints a credential');
  assert.ok(c.fix.length > 3);
});

test('the MCP section is dark and names BOTH config files when there is no config', async () => {
  const report = await runDoctor({ ...BASE, env: {}, fetchImpl: null });
  const c = find(report, 'mcp.config');
  assert.equal(c.state, 'dark');
  for (const f of MCP_CONFIG_FILES) assert.ok(`${c.detail} ${c.fix}`.includes(f), `${f} is not named`);
});

test('⭐ end to end: a real config is read, each server judged, and NOTHING is spawned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-mcp-'));
  try {
    mkdirSync(join(dir, '.acuvo'), { recursive: true });
    writeFileSync(join(dir, '.acuvo', 'mcp.json'), JSON.stringify({
      mcpServers: {
        good: { command: process.execPath, args: ['server.js'] },
        gone: { command: 'definitely-not-installed-zzz', args: [] },
        leaky: { command: process.execPath, args: [], env: { API_TOKEN: 'ghp_TESTTOKEN0123456789abcdefXYZ' } },
      },
    }));
    const t0 = Date.now();
    // ⚠️ A REAL PATH, DELIBERATELY: 'is this command installed' is a question
    // about PATH, and an empty one makes the answer 'not checked' rather than
    // 'missing' — which is the honest answer, and not the one under test here.
    const report = await runDoctor({ ...BASE, root: dir, env: { PATH: process.env.PATH }, fetchImpl: null, gitStatusImpl: async () => ({ ok: false, error: 'not a repo' }) });
    assert.ok(Date.now() - t0 < 5_000, 'the MCP section must not spawn or wait on anything');

    assert.equal(find(report, 'mcp.good').state, 'live');
    assert.equal(find(report, 'mcp.good').verified, false);
    assert.equal(find(report, 'mcp.gone').state, 'broken');
    assert.match(find(report, 'mcp.gone').detail, /definitely-not-installed-zzz/);

    /**
     * ⚠️ A LITERAL CREDENTIAL IN mcp.json IS STILL A CREDENTIAL, and it is not
     * an environment variable, so `SECRET_ENV_VARS` never knew about it.
     *
     * ⚠️⚠️ AND BE HONEST ABOUT WHAT THIS PROVES: today it passes for TWO
     * reasons — the MCP section never prints a config value in the first place,
     * and the final scrub covers it as a second line. Mutating either one alone
     * leaves this green, so read it as a boundary that must hold, not as proof
     * that the scrub is wired. The parse-echo test below is the falsifiable one.
     */
    const text = JSON.stringify(report) + '\n' + formatDoctor(report);
    assert.ok(!text.includes('ghp_TESTTOKEN0123456789abcdefXYZ'), 'a token written into mcp.json leaked into the report');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️ a malformed mcp.json is broken and points at the file, not at a server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-mcp-bad-'));
  try {
    writeFileSync(join(dir, '.mcp.json'), '{ this is not json');
    const report = await runDoctor({ ...BASE, root: dir, env: {}, fetchImpl: null, gitStatusImpl: async () => ({ ok: false, error: 'not a repo' }) });
    const c = find(report, 'mcp.config');
    assert.equal(c.state, 'broken');
    assert.match(`${c.detail} ${c.fix}`, /\.mcp\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️⚠️ a broken mcp.json must not print the file back — V8 quotes ~20 chars into the error', async () => {
  // Measured on node 22.17:
  //   Unexpected token 'g', ..."env":{"T":ghp_REALTO"... is not valid JSON
  // An mcp.json is one of the few files people type a raw API token into, so
  // that echo is a credential going to scrollback, CI logs and bug reports.
  const dir = mkdtempSync(join(tmpdir(), 'doctor-mcp-echo-'));
  const TOKEN = 'ghp_REALTOKEN0123456789abcdefXYZ';
  try {
    writeFileSync(join(dir, '.mcp.json'), `{"mcpServers":{"gh":{"command":"node","env":{"T":${TOKEN}}}}}`);
    const report = await runDoctor({ ...BASE, root: dir, env: {}, fetchImpl: null, gitStatusImpl: async () => ({ ok: false, error: 'not a repo' }) });
    const text = JSON.stringify(report) + '\n' + formatDoctor(report);
    for (let n = 8; n <= TOKEN.length; n += 4) {
      assert.ok(!text.includes(TOKEN.slice(0, n)), `${n} characters of the token reached the report — a prefix is still a credential`);
    }
    // …and the line must still be useful: it says what is wrong and which file.
    const c = find(report, 'mcp.config');
    assert.equal(c.state, 'broken');
    assert.match(`${c.detail} ${c.fix}`, /\.mcp\.json/);
    assert.match(c.detail, /json/i, 'dropping the echo must not drop the diagnosis');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('redactConfigEcho keeps the diagnosis and drops only the quoted file content', () => {
  assert.equal(
    redactConfigEcho(`Unexpected token 'g', ..."env":{"T":ghp_REALTO"... is not valid JSON`),
    `Unexpected token 'g', … is not valid JSON`,
  );
  assert.equal(
    redactConfigEcho(`Unexpected token 'g', "ghp_REALTO"... is not valid JSON`),
    `Unexpected token 'g', … is not valid JSON`,
  );
  // ⚠️ A MESSAGE THAT ECHOES NOTHING MUST SURVIVE INTACT — a redactor that eats
  // the position would be a check that damages correct work.
  const positional = 'Expected double-quoted property name in JSON at position 72 (line 1 column 73)';
  assert.equal(redactConfigEcho(positional), positional);
  assert.equal(redactConfigEcho('.mcp.json has no "mcpServers" object'), '.mcp.json has no "mcpServers" object');
  assert.equal(redactConfigEcho(undefined), '');
});

// ────────────────────────────────────────────────────────────────────────────
// PROMPT CACHE — WHETHER THE CONFIGURED MODEL CACHES AT ALL
// ────────────────────────────────────────────────────────────────────────────

test('cachingSupport knows DeepSeek caches automatically and Anthropic does not without cache_control', () => {
  assert.equal(cachingSupport('deepseek/deepseek-v4-flash-0731').kind, 'automatic');
  assert.equal(cachingSupport('deepseek/deepseek-chat:free').kind, 'automatic');
  assert.equal(cachingSupport('openai/gpt-4o-mini').kind, 'automatic');
  assert.equal(cachingSupport('anthropic/claude-sonnet-4.5').kind, 'explicit');
  // ⚠️ UNKNOWN IS THE DEFAULT AND IT IS A FEATURE. Inventing a caching claim for
  // a model nobody measured is how a cost estimate becomes fiction.
  assert.equal(cachingSupport('some-lab/brand-new-model').kind, 'unknown');
  assert.equal(cachingSupport(undefined).kind, 'unknown');
});

test('⭐ the default model reports automatic caching — and admits it is documented, not measured', async () => {
  const report = await runDoctor({ ...BASE, env: {}, fetchImpl: null, maxRounds: 8 });
  const c = find(report, 'cache.model');
  assert.equal(c.state, 'live');
  /**
   * ⚠️ THE ASSERTION IS RIGHT; ITS OLD MESSAGE WAS THE DEFECT. It used to read
   * "no cache-hit telemetry exists yet", which was the same stale fact the
   * doctor's own string carried — and BACKLOG.md then cited this line as PROOF
   * that telemetry did not exist, i.e. quoted the defect as evidence for itself.
   * Telemetry does exist (cache.hitRate in --json, on every run). What stays
   * true, and is what this pins, is that THIS check never looked at it.
   */
  assert.equal(c.verified, false, 'this check is a table lookup about the MODEL, not a measurement of your run — a green tick here would claim something it never looked at');
  assert.match(c.detail, /deepseek/i);
  assert.match(c.detail, /automatic/i);
});

test('⭐⭐ a model that only caches with cache_control is DARK and names OPENROUTER_CODEGEN_MODEL', async () => {
  const report = await runDoctor({
    ...BASE, env: { OPENROUTER_CODEGEN_MODEL: 'anthropic/claude-sonnet-4.5' }, fetchImpl: null, maxRounds: 8,
  });
  const c = find(report, 'cache.model');
  assert.equal(c.state, 'dark');
  assert.match(c.detail, /cache_control/);
  assert.match(c.fix, /OPENROUTER_CODEGEN_MODEL/);
});

test('an unmeasured model says so plainly rather than guessing either way', async () => {
  const report = await runDoctor({
    ...BASE, env: { OPENROUTER_CODEGEN_MODEL: 'some-lab/brand-new-model' }, fetchImpl: null, maxRounds: 8,
  });
  const c = find(report, 'cache.model');
  assert.equal(c.state, 'dark');
  assert.match(c.detail, /not known/i);
  assert.ok(c.fix);
});

test('⭐ a single-shot run says no cache hit is possible, whatever the model does', async () => {
  const one = await runDoctor({ ...BASE, env: {}, fetchImpl: null, maxRounds: 1 });
  const c = find(one, 'cache.rounds');
  assert.equal(c.state, 'dark');
  assert.match(c.detail, /single-shot|sent once/i);
  assert.ok(c.fix);
  // …and it is silent on a normal multi-round run rather than nagging.
  const many = await runDoctor({ ...BASE, env: {}, fetchImpl: null, maxRounds: 8 });
  assert.equal(find(many, 'cache.rounds'), undefined);
});

test('the two new sections obey every rule the old ones do', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-newsec-'));
  try {
    mkdirSync(join(dir, '.acuvo'), { recursive: true });
    writeFileSync(join(dir, '.acuvo', 'mcp.json'), JSON.stringify({
      mcpServers: { gone: { command: 'definitely-not-installed-zzz' }, gh: { command: process.execPath, env: { T: '' } } },
    }));
    const report = await runDoctor({
      ...BASE, root: dir, env: { OPENROUTER_CODEGEN_MODEL: 'anthropic/claude-sonnet-4.5', PATH: process.env.PATH },
      fetchImpl: null, maxRounds: 1, gitStatusImpl: async () => ({ ok: false, error: 'not a repo' }),
    });
    const mine = flat(report).filter((c) => c.id.startsWith('mcp.') || c.id.startsWith('cache.'));
    assert.ok(mine.length >= 4, `expected the new sections to have content, got ${mine.length}`);
    for (const c of mine) {
      assert.ok(DOCTOR_STATES.includes(c.state), `${c.id}: ${c.state}`);
      if (c.state !== 'live') assert.ok(c.fix && c.fix.length > 3, `${c.id} (${c.state}) has no usable fix`);
    }
    const out = formatDoctor(report);
    assert.ok(!/\bunavailable\b/i.test(out), 'the banned word is back');
    for (const c of mine.filter((x) => x.state !== 'live')) assert.ok(out.includes(c.fix), `the rendering dropped the fix for ${c.id}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── ⭐⭐ THE DOCTOR'S ADVICE HAS TO BE ADVICE SOMEBODY CAN FOLLOW ───────────

test('a built-in media URL is never presented as something the user must find', async () => {
  /**
   * ⚠️ MEASURED ON A BARE MACHINE, 2026-08-12: the doctor printed five lines
   * telling the reader to "set MODAL_TTS_URL to your endpoint URL" — and all
   * five of those URLs are already baked into `media.mjs`. Nobody needs to set
   * them; the single real blocker is one credential. The reader was being sent
   * to find five endpoints they do not have and cannot guess.
   *
   * ⭐ Wrong advice in a diagnostic is worse than none, because it is followed.
   */
  const { toolOffer } = await import('../lib/doctor.mjs');
  const { mediaConfig } = await import('../lib/media.mjs');
  const bare = { PATH: process.env.PATH };

  // ⚠️ Isolated for the same reason as above: the advice names a nearby
  // credential when there is one, and this asserts the no-credential wording.
  const withheld = new Map(toolOffer({ root: isolatedRoot(), env: bare, allowRun: true }).withheld.map((w) => [w.name, w]));

  for (const name of ['speak', 'transcribe', 'make_document', 'read_document', 'read_table']) {
    const w = withheld.get(name);
    assert.ok(w, `${name} should be withheld on a bare machine`);
    assert.match(w.fix, /ACUVO_MEDIA_SECRET/, `${name} must point at the credential, not a URL`);
    assert.doesNotMatch(w.fix, /endpoint URL/, `${name} must not ask for a URL that is built in`);
  }

  // ⚠️ And the claim must be TRUE: one secret really does light all five.
  const lit = mediaConfig({ ...bare, ACUVO_MEDIA_SECRET: 's' });
  for (const key of ['speak', 'transcribe', 'document', 'docRead', 'tableRead']) {
    assert.ok(lit[key], `${key} should be configured by the secret alone — the advice promises it`);
  }
});

test('see_page keeps the URL advice, because it genuinely has no default', async () => {
  const { toolOffer } = await import('../lib/doctor.mjs');
  const { mediaConfig } = await import('../lib/media.mjs');

  // The asymmetry is the point: a secret alone does NOT light the renderer.
  assert.equal(mediaConfig({ ACUVO_MEDIA_SECRET: 's' }).render, null);

  const withheld = new Map(toolOffer({ root: process.cwd(), env: { PATH: process.env.PATH }, allowRun: true }).withheld.map((w) => [w.name, w]));
  assert.match(withheld.get('see_page').fix, /RENDER_AUDIT_URL/);
});

test('⚠️⚠️ every tool --no-run withholds can be EXPLAINED by the doctor', async () => {
  /**
   * THE DRIFT GUARD. `RUN_GATED` is a hand-written list in `doctor.mjs` naming
   * tools whose gate lives in `tools.mjs`. It was already missing the three
   * background tools the hour they shipped — so the doctor listed them as dark
   * with no reason, which is the one thing it exists not to do.
   *
   * Derived from the real gating function rather than typed out, so the two
   * cannot drift again.
   */
  const { toolNamesForRounds } = await import('../lib/tools.mjs');
  const { toolOffer } = await import('../lib/doctor.mjs');
  const env = { PATH: process.env.PATH };
  const root = process.cwd();

  const withRun = toolNamesForRounds(8, { allowRun: true, root, env });
  const withoutRun = toolNamesForRounds(8, { allowRun: false, root, env });
  const lostToNoRun = withRun.filter((n) => !withoutRun.includes(n));
  assert.ok(lostToNoRun.length >= 6, `expected --no-run to withhold several tools, got ${lostToNoRun.length}`);

  const withheld = new Map(toolOffer({ root, env, allowRun: false }).withheld.map((w) => [w.name, w]));
  for (const name of lostToNoRun) {
    const w = withheld.get(name);
    assert.ok(w, `${name} is withheld by --no-run but the doctor never mentions it`);
    assert.match(w.why, /--no-run/, `${name} is reported dark for the wrong reason: ${w.why}`);
    assert.ok(w.fix, `${name} has no fix line`);
  }
});

test('no withheld tool is ever left without a reason and a fix', async () => {
  // The doctor's whole product is the REASON. A bare "withheld" is a bug.
  const { toolOffer } = await import('../lib/doctor.mjs');
  for (const allowRun of [true, false]) {
    const { withheld } = toolOffer({ root: process.cwd(), env: { PATH: process.env.PATH }, allowRun });
    for (const w of withheld) {
      assert.ok(typeof w.why === 'string' && w.why.length > 10, `${w.name} has no usable reason`);
      assert.ok(typeof w.fix === 'string' && w.fix.length > 5, `${w.name} has no usable fix`);
    }
  }
});

// ── ⭐⭐ "IT IS DARK" IS HALF AN ANSWER WHEN THE CREDENTIAL IS NEXT DOOR ────

test('the doctor finds a missing credential in a neighbouring project', async () => {
  /**
   * Measured 2026-08-12: all six media capabilities were dark, and every one
   * WORKED the moment the secret was loaded — `see_page` rendered a page and
   * caught a real 1.15:1 contrast failure in 5 seconds. The credential was in a
   * SIBLING project's `.env.local` the whole time.
   *
   * The env walk stops at the repository root on purpose and must keep doing so;
   * silently crossing into another checkout to find credentials is exactly what
   * a security reviewer would object to. So the doctor LOOKS AND ONLY TELLS.
   */
  const { findCredentialNearby } = await import('../lib/doctor.mjs');
  const root = mkdtempSync(join(tmpdir(), 'acuvo-cred-'));
  made.push(root);
  mkdirSync(join(root, 'app'), { recursive: true });
  mkdirSync(join(root, 'other'), { recursive: true });
  writeFileSync(join(root, 'other', '.env.local'), 'UNRELATED=1\nMODAL_VIDEO_SECRET=shh\n');

  const found = findCredentialNearby(['ACUVO_MEDIA_SECRET', 'MODAL_VIDEO_SECRET'], { root: join(root, 'app') });
  assert.ok(found, 'the sibling holding the credential should be found');
  assert.match(found.file, /other/);
  /**
   * ⚠️ IT NAMES THE VARIABLE IT ACTUALLY FOUND. The first version always said
   * "ACUVO_MEDIA_SECRET is already in <file>" about a file containing
   * `MODAL_VIDEO_SECRET` — advice that sends somebody looking for a line that is
   * not there. Both names are accepted by `mediaConfig`, so both are searched.
   */
  assert.equal(found.name, 'MODAL_VIDEO_SECRET');
});

test('⚠️ it never reports a value, and an empty assignment is not a credential', async () => {
  const { findCredentialNearby } = await import('../lib/doctor.mjs');
  const root = mkdtempSync(join(tmpdir(), 'acuvo-cred2-'));
  made.push(root);
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, '.env.local'), 'MODAL_VIDEO_SECRET=\n');

  // An explicitly empty value is a deliberate OFF, not something to go copy.
  assert.equal(findCredentialNearby(['MODAL_VIDEO_SECRET'], { root: join(root, 'app') }), null);

  writeFileSync(join(root, '.env.local'), 'MODAL_VIDEO_SECRET=super-secret-value\n');
  /**
   * ⚠️ THE ANSWER IS MEMOISED PER ROOT — deliberately, because re-walking sixty
   * sibling projects once per withheld tool cost **36 seconds** and tripped the
   * end-to-end assertion that the doctor must not WAIT on anything. A test that
   * changes the filesystem underneath the lookup has to say so.
   */
  clearCredentialCache();
  const found = findCredentialNearby(['MODAL_VIDEO_SECRET'], { root: join(root, 'app') });
  assert.ok(found);
  // ⚠️ A doctor that prints a secret is a worse problem than the one it was
  // diagnosing. Only the path and the NAME may leave this function.
  assert.equal(JSON.stringify(found).includes('super-secret-value'), false);
});

test('a variable that exists nowhere is reported as absent, not guessed at', async () => {
  const { findCredentialNearby } = await import('../lib/doctor.mjs');
  const root = mkdtempSync(join(tmpdir(), 'acuvo-cred3-'));
  made.push(root);
  assert.equal(findCredentialNearby(['NOT_A_REAL_VARIABLE_XYZ'], { root }), null);
});

test('the accepted secret names come from media.mjs, never a local copy', async () => {
  /**
   * ⚠️ FOURTH TIME IN ONE DAY that naming another module's strings was a guess.
   * This searched only `ACUVO_MEDIA_SECRET` and reported "not found anywhere"
   * about a file it had just read that held `MODAL_VIDEO_SECRET`.
   */
  const { MEDIA_SECRET_ENV_NAMES, mediaConfig } = await import('../lib/media.mjs');
  assert.ok(MEDIA_SECRET_ENV_NAMES.length >= 2);
  for (const name of MEDIA_SECRET_ENV_NAMES) {
    const cfg = mediaConfig({ [name]: 'x' });
    assert.ok(cfg.secret, `${name} must actually be accepted by mediaConfig, or the doctor searches for a name nothing reads`);
  }
});
