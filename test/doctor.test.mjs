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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  summarise,
  withTimeout,
  DOCTOR_STATES,
  SECRET_ENV_VARS,
} from '../lib/doctor.mjs';

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

test('⭐⭐ a withheld MEDIA tool names the EXACT env var — "TTS: unavailable" ends no investigation', () => {
  const o = toolOffer({ root: REPO, env: {}, allowRun: true, maxRounds: 8 });
  const byName = Object.fromEntries(o.withheld.map((w) => [w.name, w]));
  assert.match(byName.speak.why, /MODAL_TTS_URL/);
  assert.match(byName.see_page.why, /RENDER_AUDIT_URL/);
  assert.match(byName.transcribe.why, /MODAL_TRANSCRIBE_URL/);
  assert.match(byName.make_document.why, /MODAL_PRESS_URL/);
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

test('read_skill and the LSP tools name the missing directory / the install command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-offer-'));
  try {
    writeFileSync(join(dir, 'index.ts'), 'export const a = 1;\n');
    const o = toolOffer({ root: dir, env: FULL_ENV, allowRun: true, maxRounds: 8 });
    const byName = Object.fromEntries(o.withheld.map((w) => [w.name, w]));
    assert.match(byName.read_skill.why, /\.acuvo[/\\]skills/);
    if (byName.check_types) {
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

test('an unset endpoint is DARK and the line ends the investigation', async () => {
  const env = { ...FULL_ENV };
  delete env.MODAL_TTS_URL;
  const report = await runDoctor({ ...BASE, env, fetchImpl: makeFetch() });
  const c = find(report, 'media.speak');
  assert.equal(c.state, 'dark');
  assert.match(c.detail + ' ' + c.fix, /MODAL_TTS_URL/);
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
  const env = { ...FULL_ENV };
  delete env.MODAL_TTS_URL;
  const report = await runDoctor({ ...BASE, env, fetchImpl: makeFetch() });
  const out = formatDoctor(report);
  assert.match(out, /\blive\b/);
  assert.match(out, /\bdark\b/);
  assert.match(out, /MODAL_TTS_URL/, 'the dark line must name the variable, not say "unavailable"');
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

test('⚠️ probes run CONCURRENTLY — seven sequential 200ms probes would be 1.4s', async () => {
  const t0 = Date.now();
  await runDoctor({
    ...BASE,
    timeoutMs: 3_000,
    env: FULL_ENV,
    fetchImpl: async (url, init) => {
      await new Promise((r) => setTimeout(r, 200));
      return makeFetch()(url, init);
    },
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 900, `probes appear sequential: ${elapsed}ms`);
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
