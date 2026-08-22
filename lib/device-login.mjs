/**
 * ── ⭐⭐⭐ `acuvo` LOGS ITSELF IN ────────────────────────────────────────────
 *
 * Roman, 2026-08-22: *"paying users should be able to type acuvo into a terminal
 * and then it works... like how I pay and I can type claude and it works, but it
 * probably works for anyone, but they have to log in."*
 *
 * RFC 8628 device-authorization grant, client half. Replaces the five-step
 * manual path (sign in → find Settings → create key → copy → `acuvo --login
 * xxi_live_…`) with: run `acuvo`, approve in the browser, done.
 *
 * ⚠️ EVERY PIECE OF IO IS INJECTED — `fetchImpl`, `openBrowser`, `sleep`, `now`.
 * Not for purity's sake: this module's whole job is a timing loop against a
 * remote service, and a version that can only be tested by actually waiting two
 * seconds a tick against production is a version nobody tests. The CLI's success
 * path had zero coverage once before, for exactly this reason.
 */

import { DEFAULT_GATEWAY_URL } from './account.mjs';

/**
 * The gateway constant points at the completions endpoint; the device endpoints
 * are siblings of it. Derived rather than duplicated so a self-hosted or staging
 * gateway moves all three together.
 */
export function deviceEndpoints(gatewayUrl = DEFAULT_GATEWAY_URL) {
  const base = String(gatewayUrl).replace(/\/api\/cli\/v1\/chat\/completions\/?$/, '');
  return {
    code: `${base}/api/cli/v1/device/code`,
    token: `${base}/api/cli/v1/device/token`,
  };
}

/** Ask for a device code. Returns the server's payload, or throws a readable error. */
export async function requestDeviceCode(gatewayUrl = DEFAULT_GATEWAY_URL, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const { code } = deviceEndpoints(gatewayUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(code, { method: 'POST', signal: controller.signal });
  } catch (e) {
    throw new Error(`could not reach Acuvo to start a login (${e?.message ?? e}). Check your connection.`);
  } finally {
    clearTimeout(timer);
  }

  /**
   * ⚠️ A NON-JSON BODY IS THE SYMPTOM THAT MATTERS HERE. If the middleware ever
   * stops exempting this path, the response is a 307 to an HTML login page —
   * and "unexpected token < in JSON" tells the user nothing they can act on.
   * That exact failure has shipped on this path before.
   */
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Acuvo returned a ${res.status} that was not JSON — the login endpoint is not reachable. ` +
      `This is a server-side problem, not something you can fix locally.`,
    );
  }
  if (!res.ok) throw new Error(json?.error ? `login could not start: ${json.error}` : `login could not start (HTTP ${res.status})`);
  if (!json?.device_code || !json?.user_code) throw new Error('Acuvo did not return a login code.');
  return json;
}

/** RFC 8628 statuses that mean "keep waiting" rather than "stop". */
const PENDING = new Set(['authorization_pending', 'slow_down']);

/**
 * Poll until the human approves, denies, or the code expires.
 *
 * @returns {Promise<{api_key: string, tenant_id: string|null}>}
 */
export async function pollForKey(
  gatewayUrl,
  deviceCode,
  {
    intervalMs = 2000,
    expiresInMs = 600000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    onTick = () => {},
  } = {},
) {
  const { token } = deviceEndpoints(gatewayUrl);
  const deadline = now() + expiresInMs;
  let wait = intervalMs;

  while (now() < deadline) {
    await sleep(wait);
    onTick();

    let res;
    let json = {};
    try {
      res = await fetchImpl(token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode }),
      });
      json = await res.json().catch(() => ({}));
    } catch {
      /**
       * ⚠️ A DROPPED POLL IS NOT A FAILED LOGIN. Wifi blips mid-approval are
       * ordinary; aborting here would throw away an approval the user already
       * gave. Keep waiting until the code itself expires.
       */
      continue;
    }

    if (res.ok && json.api_key) return { api_key: json.api_key, tenant_id: json.tenant_id ?? null };

    const err = String(json.error ?? '');
    if (err === 'access_denied') throw new Error('login was denied in the browser.');
    if (err === 'expired_token') throw new Error('the login code expired. Run `acuvo --login` again.');
    if (err === 'already_claimed') throw new Error('that login code was already used. Run `acuvo --login` again.');
    if (err === 'invalid_grant') throw new Error('that login code is not recognised. Run `acuvo --login` again.');

    // `slow_down` is the server asking for room; honouring it is the difference
    // between a polite client and one that gets rate-limited mid-login.
    if (err === 'slow_down') wait = Math.min(wait * 2, 10000);
    else if (!PENDING.has(err) && !res.ok && res.status >= 500) wait = Math.min(wait * 2, 10000);
  }

  throw new Error('the login code expired before it was approved. Run `acuvo --login` again.');
}

/**
 * Best-effort browser open. NEVER throws and never blocks the flow.
 *
 * ⚠️ THE URL IS ALWAYS PRINTED TOO, and that is not redundancy — this runs over
 * SSH, in containers, and in terminals with no desktop session, where opening a
 * browser is impossible by definition. A flow that depends on the open
 * succeeding is a flow that strands every remote user.
 */
export function openBrowser(url, { platform = process.platform, spawn } = {}) {
  if (!spawn) return false;
  const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * ── ⭐⭐⭐ ONE LOGIN FLOW, TWO DOORS ─────────────────────────────────────────
 *
 * Drives the whole grant: ask for a code, show it, open a browser, wait, save.
 * Reached from `acuvo --login` AND from a bare `acuvo` that finds no
 * credential — the second of which is what makes typing `acuvo` enough, the
 * way typing `claude` is.
 *
 * ⚠️ IT LIVES HERE, NOT IN `bin/`. The first version was written inline inside
 * the `--login` branch and was needed by a second caller within the hour. A fix
 * that lives inside one caller is a fix for one caller — this codebase has paid
 * for that three times today alone. Extracted before the second copy existed
 * rather than after.
 *
 * ⚠️ IT THROWS RATHER THAN EXITING. `bin/` owns exit codes and phrasing; a
 * library that calls `process.exit` cannot be tested and cannot be reused.
 *
 * @returns {Promise<{token: string, restricted: boolean|null, userCode: string}>}
 */
export async function runDeviceLogin({
  gatewayUrl,
  write = (s) => process.stderr.write(s),
  spawn,
  requestCode = requestDeviceCode,
  poll = pollForKey,
  open = openBrowser,
  saveAccount,
} = {}) {
  const start = await requestCode(gatewayUrl);
  const url = start.verification_uri_complete || start.verification_uri;

  /**
   * ⚠️ THE URL AND CODE ARE PRINTED WHETHER OR NOT THE BROWSER OPENS. This runs
   * over SSH, in containers, and in terminals with no desktop session, where
   * opening a browser is impossible by definition — a flow that assumes the
   * open worked strands every remote user.
   */
  write(`\nYour code:  ${start.user_code}\n\n`);
  const opened = open(url, { spawn });
  write(opened
    ? `Opened your browser to approve it. If nothing appeared:\n  ${url}\n\n`
    : `Open this to approve it:\n  ${url}\n\n`);
  write('Waiting for approval… (Ctrl-C to cancel)\n');

  const granted = await poll(gatewayUrl, start.device_code, {
    intervalMs: (start.interval ?? 2) * 1000,
    expiresInMs: (start.expires_in ?? 600) * 1000,
  });

  const saved = saveAccount ? saveAccount(granted.api_key) : null;
  return {
    token: granted.api_key,
    restricted: saved && typeof saved.restricted === 'boolean' ? saved.restricted : null,
    userCode: start.user_code,
  };
}
