/**
 * `playtest` with no local browser MCP server drives the page through the signed-in account's
 * hosted browser (`<gateway>/render`, `mode: 'playtest'`), the way `see_page` already works.
 * Found by using it, 2026-09-26: asked to "check it actually starts and moves", the CLI had to
 * say "I don't have a browser-driving tool in this environment".
 * Proven live the same day against the local gateway: a working snake reported `moved: true`
 * in 10 s; a canvas that never redraws reported "never changed". These tests pin the wiring.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playtest, playtestToolNames, hostedDriveRoute } from '../lib/playtest.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-hosted-drive-'));
  const home = mkdtempSync(join(tmpdir(), 'acuvo-hosted-home-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(join(root, 'index.html'), '<canvas id="c"></canvas><script src="game.js"></script>', 'utf8');
  writeFileSync(join(root, 'game.js'), 'window.GAME = 1;', 'utf8');
  return { root, home };
}

function signIn(home) {
  mkdirSync(join(home, '.acuvo'), { recursive: true });
  writeFileSync(join(home, '.acuvo', 'credentials.json'), JSON.stringify({ token: 'acuvo_test_token', gatewayUrl: 'https://gw.example/api/cli/v1/chat/completions' }), 'utf8');
}

const NO_BROWSER = () => ({ ok: true, servers: [] });

function fakeGateway(report, seen) {
  return async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, report }) };
  };
}

test('signed in, no local browser: it drives through the account and reports what moved', async (t) => {
  const { root, home } = setup(t);
  signIn(home);
  const seen = [];
  const report = { drove: true, problems: [], measured: ['1 scripted step(s)'], unmeasured: [], steps: [{ do: 'press', ok: true }], frame: { canvas: true, webgl: false, responded: false, moved: true } };
  const out = await playtest(root, { url: 'index.html', steps: [{ do: 'press', text: 'ArrowUp' }] },
    { env: { ACUVO_HOME: join(home, '.acuvo') }, home, configImpl: NO_BROWSER, fetchImpl: fakeGateway(report, seen) });
  assert.equal(out.ok, true);
  assert.equal(out.driver, 'hosted');
  assert.equal(out.actions, 1);
  assert.ok(out.measured.includes('the picture changed after the input'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.mode, 'playtest');
  assert.match(seen[0].url, /\/render$/);
  assert.equal(seen[0].headers.authorization, 'Bearer acuvo_test_token');
  assert.match(seen[0].body.html, /window\.GAME = 1/, 'the page was not bundled with its local script');
});

test('a canvas that never changed is a problem, in words the model can act on', async (t) => {
  const { root, home } = setup(t);
  signIn(home);
  const report = { drove: true, problems: [], measured: [], unmeasured: [], steps: [{ do: 'press', ok: true }], frame: { canvas: true, webgl: false, responded: false, moved: false } };
  const out = await playtest(root, { url: 'index.html', steps: [{ do: 'press', text: 'ArrowUp' }] },
    { env: { ACUVO_HOME: join(home, '.acuvo') }, home, configImpl: NO_BROWSER, fetchImpl: fakeGateway(report, []) });
  assert.ok(out.problems.some((p) => /never changed after the steps/.test(p)));
});

test('not signed in and no local browser: the old honest refusal, nothing fetched', async (t) => {
  const { root, home } = setup(t);
  const seen = [];
  const out = await playtest(root, { url: 'index.html' },
    { env: { ACUVO_HOME: join(home, '.acuvo') }, home, configImpl: NO_BROWSER, fetchImpl: fakeGateway({}, seen) });
  assert.equal(out.ok, false);
  assert.match(out.error, /no browser is configured/);
  assert.equal(seen.length, 0);
});

test('the tool is OFFERED to a signed-in user with no local browser, and not otherwise', (t) => {
  const { root, home } = setup(t);
  const env = { ACUVO_HOME: join(home, '.acuvo') };
  assert.deepEqual(playtestToolNames(root, env, { configImpl: NO_BROWSER, home }), []);
  signIn(home);
  assert.deepEqual(playtestToolNames(root, env, { configImpl: NO_BROWSER, home }), ['playtest']);
  assert.equal(hostedDriveRoute({ ...env, ACUVO_HOSTED_PLAYTEST: 'off' }, home), null);
});

test('a gateway that predates the drive (renders instead) is named, not reported as HTTP 200', async (t) => {
  const { root, home } = setup(t);
  signIn(home);
  const old = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, measurement: { viewport: { width: 1280 } } }) });
  const out = await playtest(root, { url: 'index.html' }, { env: { ACUVO_HOME: join(home, '.acuvo') }, home, configImpl: NO_BROWSER, fetchImpl: old });
  assert.equal(out.ok, false);
  assert.match(out.error, /does not drive pages yet/);
});
