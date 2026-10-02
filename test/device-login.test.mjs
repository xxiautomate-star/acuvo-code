import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceEndpoints, requestDeviceCode, pollForKey, openBrowser, runDeviceLogin } from '../lib/device-login.mjs';

const GATEWAY = 'https://acuvo.xxiautomate.com/api/cli/v1/chat/completions';
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });
const bad = (status, body) => ({ ok: false, status, text: async () => JSON.stringify(body), json: async () => body });
const noSleep = async () => {};

test('⭐ the device endpoints are DERIVED from the gateway, not duplicated', () => {
  const e = deviceEndpoints(GATEWAY);
  assert.equal(e.code, 'https://acuvo.xxiautomate.com/api/cli/v1/device/code');
  assert.equal(e.token, 'https://acuvo.xxiautomate.com/api/cli/v1/device/token');
});

test('⭐ a self-hosted gateway moves all three endpoints together', () => {
  const e = deviceEndpoints('http://localhost:3002/api/cli/v1/chat/completions');
  assert.equal(e.code, 'http://localhost:3002/api/cli/v1/device/code');
});

test('⭐⭐ a code request returns the user code and the pre-filled URL', async () => {
  const payload = {
    device_code: 'dc-secret',
    user_code: 'BKQT-ZRMD',
    verification_uri_complete: 'https://acuvo.xxiautomate.com/cli-auth?code=BKQT-ZRMD',
    interval: 2,
    expires_in: 600,
  };
  const got = await requestDeviceCode(GATEWAY, { fetchImpl: async () => ok(payload) });
  assert.equal(got.user_code, 'BKQT-ZRMD');
  assert.equal(got.device_code, 'dc-secret');
});

test('⚠️⚠️ an HTML response is named as a SERVER problem, not a JSON parse error', async () => {
  /**
   * ── THE FAILURE THIS TEST EXISTS FOR ────────────────────────────────────────
   *
   * `/api/cli/v1/*` is exempted from the session gate only for requests carrying
   * a key-shaped bearer. Device login carries none — by definition — so if that
   * exemption is ever narrowed, these endpoints get a 307 to an HTML login page.
   *
   * ⭐ THAT IS NOT HYPOTHETICAL. The same middleware turned away the metered
   * gateway for the entire life of the product, and the exemption for THIS path
   * was written the same day this module was. "Unexpected token < in JSON" tells
   * a user nothing; naming it as a server-side problem at least stops them
   * reinstalling, rotating keys, and blaming their own machine.
   */
  const html = { ok: false, status: 307, text: async () => '<!DOCTYPE html><html>…', json: async () => { throw new Error('nope'); } };
  await assert.rejects(
    () => requestDeviceCode(GATEWAY, { fetchImpl: async () => html }),
    /not JSON|not reachable/i,
  );
});

test('⭐⭐⭐ it waits through `authorization_pending` and returns the key on approval', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call < 3) return bad(400, { error: 'authorization_pending' });
    return ok({ api_key: 'xxi_live_abc', tenant_id: 't-1' });
  };
  const got = await pollForKey(GATEWAY, 'dc', { fetchImpl, sleep: noSleep, intervalMs: 1 });
  assert.equal(got.api_key, 'xxi_live_abc');
  assert.equal(got.tenant_id, 't-1');
  assert.equal(call, 3, 'it must keep polling rather than give up on the first pending');
});

test('⚠️ a DROPPED poll does not abandon an approval the user already gave', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) throw new Error('ECONNRESET');
    return ok({ api_key: 'xxi_live_abc', tenant_id: null });
  };
  const got = await pollForKey(GATEWAY, 'dc', { fetchImpl, sleep: noSleep, intervalMs: 1 });
  assert.equal(got.api_key, 'xxi_live_abc', 'a wifi blip mid-approval must not fail the login');
});

for (const [error, pattern] of [
  ['access_denied', /denied/i],
  ['expired_token', /expired/i],
  ['already_claimed', /already used/i],
  ['invalid_grant', /not recognised/i],
]) {
  test(`⚠️ \`${error}\` stops immediately and says something actionable`, async () => {
    const fetchImpl = async () => bad(400, { error });
    await assert.rejects(
      () => pollForKey(GATEWAY, 'dc', { fetchImpl, sleep: noSleep, intervalMs: 1 }),
      pattern,
    );
  });
}

test('⚠️ `slow_down` is honoured — the client backs off instead of being throttled', async () => {
  const waits = [];
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call < 4) return bad(400, { error: 'slow_down' });
    return ok({ api_key: 'k', tenant_id: null });
  };
  await pollForKey(GATEWAY, 'dc', {
    fetchImpl,
    intervalMs: 100,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.ok(waits[1] > waits[0], `expected backoff, got ${waits.join(',')}`);
});

test('⚠️ it gives up when the code expires rather than polling forever', async () => {
  let t = 0;
  await assert.rejects(
    () => pollForKey(GATEWAY, 'dc', {
      fetchImpl: async () => bad(400, { error: 'authorization_pending' }),
      sleep: noSleep,
      intervalMs: 1,
      expiresInMs: 50,
      now: () => (t += 20),
    }),
    /expired/i,
  );
});

test('⚠️⚠️ openBrowser NEVER throws — SSH and containers have no browser to open', () => {
  assert.equal(openBrowser('https://x', { spawn: () => { throw new Error('no display'); } }), false);
  assert.equal(openBrowser('https://x', {}), false, 'no spawn available must be false, not a crash');
});

test('⭐ openBrowser uses the right opener per platform', () => {
  const seen = [];
  const spawn = (cmd, args) => { seen.push([cmd, args]); return { unref() {} }; };
  openBrowser('https://x', { platform: 'darwin', spawn });
  openBrowser('https://x', { platform: 'linux', spawn });
  openBrowser('https://x', { platform: 'win32', spawn });
  assert.equal(seen[0][0], 'open');
  assert.equal(seen[1][0], 'xdg-open');
  assert.equal(seen[2][0], 'cmd');
});

// ── ⭐⭐⭐ runDeviceLogin — the orchestrator that ties the whole flow together ─

const startPayload = {
  device_code: 'dc-secret',
  user_code: 'BKQT-ZRMD',
  verification_uri_complete: 'https://acuvo.xxiautomate.com/cli-auth?code=BKQT-ZRMD',
  interval: 2,
  expires_in: 600,
};

test('⭐⭐⭐ runDeviceLogin drives the whole grant and saves the account', async () => {
  const written = [];
  const calls = [];
  const granted = { api_key: 'xxi_live_abc', tenant_id: 't-1' };
  const flow = await runDeviceLogin({
    gatewayUrl: GATEWAY,
    write: (s) => written.push(s),
    spawn: () => ({ unref() {} }),
    requestCode: async () => startPayload,
    poll: async () => granted,
    open: () => true,
    saveAccount: (token) => { calls.push(token); return { ok: true, restricted: true, note: null }; },
  });

  assert.equal(flow.token, 'xxi_live_abc');
  assert.equal(flow.userCode, 'BKQT-ZRMD');
  assert.equal(flow.restricted, true, 'the save result must be surfaced so bin/ can warn');
  assert.deepEqual(calls, ['xxi_live_abc'], 'the granted key must be handed to saveAccount');
  assert.ok(written.some((s) => s.includes('BKQT-ZRMD')), 'the code must be printed');
  assert.ok(written.some((s) => s.includes('Opened your browser')), 'the browser-open message must be printed');
});

test('⚠️ when the browser cannot open, the URL is printed instead — never stranded', async () => {
  const written = [];
  const flow = await runDeviceLogin({
    gatewayUrl: GATEWAY,
    write: (s) => written.push(s),
    spawn: () => ({ unref() {} }),
    requestCode: async () => startPayload,
    poll: async () => ({ api_key: 'xxi_live_abc', tenant_id: null }),
    open: () => false,
  });
  assert.equal(flow.token, 'xxi_live_abc');
  assert.ok(written.some((s) => s.includes('Open this to approve it')), 'the URL must be printed when no browser opens');
  assert.ok(written.some((s) => s.includes('cli-auth?code=BKQT-ZRMD')), 'the full URL must be shown');
});

test('⚠️ a save that could not restrict permissions is surfaced, not swallowed', async () => {
  const flow = await runDeviceLogin({
    gatewayUrl: GATEWAY,
    write: () => {},
    spawn: () => ({ unref() {} }),
    requestCode: async () => startPayload,
    poll: async () => ({ api_key: 'xxi_live_abc', tenant_id: null }),
    open: () => true,
    saveAccount: () => ({ ok: true, restricted: false, note: 'could not restrict' }),
  });
  assert.equal(flow.restricted, false, 'bin/ must be able to warn the user about an unlocked file');
});

test('⚠️ runDeviceLogin throws when the flow is denied — it does not exit', async () => {
  await assert.rejects(
    () => runDeviceLogin({
      gatewayUrl: GATEWAY,
      write: () => {},
      spawn: () => ({ unref() {} }),
      requestCode: async () => startPayload,
      poll: async () => { throw new Error('login was denied in the browser.'); },
      open: () => true,
    }),
    /denied/i,
  );
});
