/**
 * ── ⭐ NOTHING THIS CLI BUILDS CAN BE SHOWN TO ANYONE ────────────────────────
 *
 * The agent writes an app, runs it, and the person watching is the only person
 * who can ever see it. "Send me the link" has no answer. That is the gap this
 * closes, and it is the smallest honest thing that closes it: a public URL for a
 * port that is already listening, for a bounded time, on purpose.
 *
 * ── ⚠️⚠️⚠️ THE MODEL CANNOT CALL THIS, AND THAT IS THE DESIGN ───────────────
 *
 * There is no tool schema in this file and there must never be one. Opening a
 * port on this machine to the entire internet is the same class of decision as
 * *"which program do we spawn"*, which `lsp.mjs` states is the one decision a
 * language model never gets to make. A tunnel started by an agent mid-task is
 * a tunnel nobody chose, protecting nothing, discovered later.
 *
 * ⭐ So this is a HUMAN subcommand — `acuvo tunnel 3000` — and every guard below
 * assumes the reader is a person who can be told something and asked a question.
 *
 * ── ⚠️ WHAT IS ACTUALLY EXPOSED, SAID PLAINLY BECAUSE IT MUST BE ────────────
 *
 * A Cloudflare quick tunnel publishes `http://127.0.0.1:<port>` at a random
 * `*.trycloudflare.com` hostname. There is **no authentication of any kind**.
 * Anyone with the URL reaches the app, and Cloudflare is in the path. If the
 * dev server has a debug route, an admin page, an unauthenticated API or a
 * `.env` served as a static file, all of it is public for the lifetime of the
 * tunnel. The banner says this before the URL appears, not after.
 *
 * ── ⚖️ WHY cloudflared AND NOT A LIBRARY ────────────────────────────────────
 *
 * `package.json` says `"dependencies": {}` and a test asserts it. A tunnel
 * client as an npm dependency would be a network-facing package pulled into
 * every install of this CLI, for a feature almost nobody uses in a given run.
 *
 * ⭐ `cloudflared` is a binary the USER installed, and that is the same argument
 * `pty.mjs` and `command.mjs` already make: a component that runs code at
 * install time, or that opens your machine to the internet, is one a HUMAN
 * should install deliberately. We detect it and drive it; we never fetch it.
 *
 * ⚠️ Quick tunnels need no Cloudflare account and no login, which is what makes
 * this usable at all — but they are a free service with no uptime promise, and
 * that is stated in the banner rather than discovered.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The binary. Not configurable — see the header on who chooses programs. */
export const TUNNEL_BINARY = 'cloudflared';

/**
 * ── ⚠️ A LIFETIME IS NOT A NICETY, IT IS THE MAIN CONTROL ──────────────────
 *
 * The realistic failure is not an attack, it is FORGETTING: a terminal left
 * open overnight with a dev database published to the internet. Every tunnel
 * therefore has a deadline it cannot be talked out of, and the deadline is
 * printed in the same breath as the URL.
 */
export const DEFAULT_MINUTES = 30;
/**
 * ⚠️ A CEILING, NOT A DEFAULT. `--for 10000` is somebody trying to make it
 * permanent; a permanent public tunnel wants a named Cloudflare tunnel with an
 * account and an access policy, not this.
 */
export const MAX_MINUTES = 480;

/** Cloudflare prints the hostname to stderr; this is the shape to look for. */
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** How long to wait for that line before calling it a failure. */
export const URL_TIMEOUT_MS = 45_000;

/**
 * ── ⚠️⚠️ THE URL EXISTS BEFORE IT WORKS, AND PRINTING IT THEN IS A BUG ──────
 *
 * MEASURED 2026-09-01, driving a real quick tunnel against a local server:
 *
 *     +4,533ms   cloudflared prints https://clearing-inquiry-orders-lace.trycloudflare.com
 *     +5,725ms   GET → fetch failed
 *     +9,769ms   GET → fetch failed
 *    +12,142ms   GET → HTTP 200 "OK-ACUVO"      ← actually serving
 *
 * An earlier run was worse: the URL answered **HTTP 530, Cloudflare error 1033**
 * ("Cloudflare is currently unable to resolve it") for the whole window.
 *
 * ⭐ SO THERE IS A ~7.6 SECOND GAP IN WHICH THE URL IS PUBLIC AND BROKEN, and
 * printing it during that gap is worse than printing nothing: the person copies
 * it, sends it to somebody, and the recipient gets a Cloudflare error page and
 * concludes the app is broken. The one thing this feature exists to do — let you
 * show someone your work — fails on its first use.
 *
 * The fix is to prove it before announcing it. Same rule the rest of this
 * package runs on: a render, a trace, a row. Not "cloudflared said a word".
 */
export const READY_TIMEOUT_MS = 40_000;
export const READY_POLL_MS = 1_000;

/** Ports nothing should ever be published from. */
const REFUSED_PORTS = new Map([
  [22, 'SSH'],
  [3306, 'MySQL'],
  [5432, 'PostgreSQL'],
  [6379, 'Redis'],
  [27017, 'MongoDB'],
  [9200, 'Elasticsearch'],
  [11211, 'memcached'],
]);

/**
 * @param {unknown} raw
 * @returns {{ ok: true, port: number } | { ok: false, error: string }}
 */
export function checkPort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, error: `"${String(raw)}" is not a port. Give the port your app is already listening on, e.g. acuvo tunnel 3000` };
  }
  /**
   * ⭐ THE DATABASE PORTS ARE REFUSED OUTRIGHT, and this is the one blocklist in
   * this file that earns its place. A tunnel is an HTTP proxy, so publishing
   * 5432 mostly does not even WORK — but "mostly" is doing far too much work in
   * that sentence, and the cost of being wrong is a public database. There is no
   * legitimate reason to reach for these here, so a refusal costs nothing.
   */
  if (REFUSED_PORTS.has(port)) {
    return { ok: false, error: `refusing to expose port ${port} — that is ${REFUSED_PORTS.get(port)}, not a web app. This publishes to the whole internet with no password.` };
  }
  return { ok: true, port };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, minutes: number } | { ok: false, error: string }}
 */
export function checkMinutes(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, minutes: DEFAULT_MINUTES };
  const m = Number(raw);
  if (!Number.isFinite(m) || m <= 0) {
    return { ok: false, error: `--for takes a number of minutes; got "${String(raw)}"` };
  }
  if (m > MAX_MINUTES) {
    return {
      ok: false,
      error: `--for ${m} is over the ${MAX_MINUTES}-minute ceiling. A tunnel meant to stay up is a named Cloudflare tunnel with an account and an access policy — not this, which has no authentication at all.`,
    };
  }
  return { ok: true, minutes: m };
}

/**
 * Is anything actually listening?
 *
 * ⭐ THIS IS A SAFETY CHECK, NOT A CONVENIENCE. Without it, `acuvo tunnel 3000`
 * when the dev server is on 3001 publishes a URL that 502s — and the person
 * reads the failure as "tunnels are broken" and retries on other numbers until
 * one sticks, which is how you end up publishing something you never looked at.
 * Refusing a dead port keeps "what am I exposing" answerable.
 *
 * @returns {Promise<boolean>}
 */
export function isListening(port, { host = '127.0.0.1', timeoutMs = 1_500 } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; socket.destroy(); resolve(v); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Find `cloudflared` without a shell.
 *
 * ⚠️ NO `shell: true` AND NO `which`. `command.mjs` documents why a shell is
 * not on the table anywhere in this package, and a `.cmd` shim cannot be
 * spawned directly on Windows since CVE-2024-27980 — so PATH is walked here and
 * the real executable is what gets spawned.
 */
export function findCloudflared(env = process.env) {
  const exts = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, `${TUNNEL_BINARY}${ext}`);
      try { if (existsSync(candidate)) return candidate; } catch { /* an unreadable PATH entry is not an error */ }
    }
  }
  return null;
}

/** What to print when it is not installed. Named, so the test can assert on it. */
export const INSTALL_HINT = [
  `${TUNNEL_BINARY} is not on your PATH, and this command drives it rather than bundling it —`,
  'a program that opens your machine to the internet is one you should install deliberately.',
  '',
  '  macOS    brew install cloudflared',
  '  Windows  winget install --id Cloudflare.cloudflared',
  '  Linux    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  '',
  'No Cloudflare account or login is needed for a quick tunnel.',
].join('\n');

/**
 * ── ⭐⭐ THE CONSENT BANNER — PRINTED BEFORE ANYTHING IS EXPOSED ────────────
 *
 * ⚠️ IT NAMES THE APP, THE AUDIENCE AND THE CLOCK. "Are you sure?" is not
 * informed consent; a person needs to know WHAT is going out, to WHOM, and for
 * HOW LONG, in the sentence they are answering.
 */
export function consentBanner(port, minutes) {
  return [
    '',
    '  ⚠️  PUBLIC TUNNEL — read this before answering',
    '',
    `     Exposing        http://127.0.0.1:${port}   (everything it serves)`,
    '     To              the public internet, through Cloudflare',
    '     Authentication  NONE. Anyone with the URL gets in.',
    `     Lifetime        ${minutes} minute${minutes === 1 ? '' : 's'}, then it closes on its own`,
    '',
    '     If that port serves an admin page, an unauthenticated API, a database',
    '     browser or your .env, all of it is public for those minutes.',
    '',
  ].join('\n');
}

/** What is printed once the URL exists. */
export function liveBanner(url, port, minutes, expiresAt) {
  return [
    '',
    `  🌐  ${url}`,
    '',
    `      serving   http://127.0.0.1:${port}`,
    `      closes    ${expiresAt.toLocaleTimeString()}  (${minutes} min)`,
    '      stop      Ctrl-C',
    '',
    '      No password. Treat the URL as the secret, and assume it will be scanned.',
    '',
  ].join('\n');
}

/**
 * Poll the public URL until it actually answers.
 *
 * ⚠️ "ANSWERS" MEANS ANY HTTP RESPONSE THAT IS NOT CLOUDFLARE'S OWN TUNNEL
 * ERROR. It deliberately does NOT require a 200: the app being tunnelled is
 * allowed to return 404, 401 or 500 on `/`, and demanding success here would
 * refuse to announce a working tunnel in front of a perfectly normal app. What
 * is being proven is that the EDGE reaches cloudflared — which 530/1033 says it
 * does not, and which a connection failure says it does not either.
 *
 * @returns {Promise<{ ready: boolean, status?: number, waitedMs: number }>}
 */
export async function waitUntilServing(url, { timeoutMs = READY_TIMEOUT_MS, pollMs = READY_POLL_MS, fetchImpl = fetch, now = Date.now } = {}) {
  const started = now();
  while (now() - started < timeoutMs) {
    try {
      const res = await fetchImpl(url, { redirect: 'manual', headers: { 'user-agent': 'acuvo-code tunnel readiness check' } });
      // 530 is Cloudflare saying it cannot reach the origin — i.e. not ready.
      if (res.status !== 530) return { ready: true, status: res.status, waitedMs: now() - started };
    } catch { /* DNS or TLS not propagated yet — that is the normal early state */ }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ready: false, waitedMs: now() - started };
}

/**
 * ── ⭐ START ONE. RESOLVES WHEN IT IS DOWN, NOT WHEN IT IS UP. ─────────────
 *
 * ⚠️ THE PROMISE DELIBERATELY OUTLIVES THE URL. A function that resolved on
 * "the tunnel is live" would hand the caller a running child and no obligation,
 * which is precisely how a process ends up outliving the command that made it.
 * The caller awaits this, so the tunnel's lifetime IS the command's lifetime and
 * there is no window where one exists without the other.
 *
 * @returns {Promise<{ ok: boolean, url?: string, error?: string, reason?: string }>}
 */
export async function runTunnel({
  port,
  minutes = DEFAULT_MINUTES,
  env = process.env,
  onEvent = () => {},
  spawnImpl = spawn,
  binary = null,
  readyFetch = fetch,
} = {}) {
  const exe = binary ?? findCloudflared(env);
  if (!exe) return { ok: false, error: INSTALL_HINT };

  let child;
  try {
    child = spawnImpl(exe, [
      'tunnel',
      '--no-autoupdate',
      '--url', `http://127.0.0.1:${port}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  } catch (err) {
    return { ok: false, error: `could not start ${TUNNEL_BINARY}: ${err?.message ?? err}` };
  }
  if (!child?.stderr) return { ok: false, error: `${TUNNEL_BINARY} started without stderr — cannot read the URL it prints there` };

  return new Promise((resolve) => {
    let url = null;
    let settled = false;
    let tail = '';
    /** @type {NodeJS.Timeout|null} */ let lifetimeTimer = null;
    /** @type {NodeJS.Timeout|null} */ let urlTimer = null;

    /**
     * ⚠️ EVERY EXIT PATH GOES THROUGH HERE, and it clears BOTH timers. A pending
     * `setTimeout` keeps the event loop alive: leaving one behind means the
     * command appears to hang for up to eight hours after the tunnel is gone —
     * the same class of defect that got the pty transport withdrawn, and the
     * reason it is a single function rather than three call sites.
     */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (lifetimeTimer) clearTimeout(lifetimeTimer);
      if (urlTimer) clearTimeout(urlTimer);
      lifetimeTimer = null;
      urlTimer = null;
      stopChild(child);
      process.off('SIGINT', onSigint);
      resolve(result);
    };

    const onSigint = () => { onEvent({ type: 'stopping', why: 'you pressed Ctrl-C' }); finish({ ok: true, url, reason: 'stopped by Ctrl-C' }); };
    process.once('SIGINT', onSigint);

    urlTimer = setTimeout(() => {
      finish({ ok: false, error: `${TUNNEL_BINARY} did not print a tunnel URL within ${Math.round(URL_TIMEOUT_MS / 1000)}s. Last output:\n${tail.trim() || '(nothing)'}` });
    }, URL_TIMEOUT_MS);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      tail = (tail + chunk).slice(-2_000);
      if (url) return;
      const match = URL_PATTERN.exec(chunk) ?? URL_PATTERN.exec(tail);
      if (!match) return;
      url = match[0];
      if (urlTimer) { clearTimeout(urlTimer); urlTimer = null; }
      onEvent({ type: 'registering', url });

      /**
       * ⭐⭐ PROVE IT SERVES, THEN ANNOUNCE IT. See READY_TIMEOUT_MS for the
       * measurement: there is a multi-second window where this hostname exists
       * and returns Cloudflare's own error page.
       */
      waitUntilServing(url, { fetchImpl: readyFetch }).then((ready) => {
        if (settled) return;
        /**
         * ⚠️ THE DEADLINE IS ARMED FROM THE MOMENT THE URL IS USABLE, not from
         * when the command started and not from when cloudflared first spoke.
         * Arming it earlier silently shortens every tunnel by the registration
         * time, so the number printed and the time delivered disagree.
         */
        const expiresAt = new Date(Date.now() + minutes * 60_000);
        onEvent({ type: 'live', url, expiresAt, ready: ready.ready, waitedMs: ready.waitedMs, status: ready.status });
        lifetimeTimer = setTimeout(() => {
          onEvent({ type: 'stopping', why: `the ${minutes}-minute lifetime is up` });
          finish({ ok: true, url, reason: 'lifetime reached' });
        }, minutes * 60_000);
      });
    });

    child.stdout?.resume();
    child.on('error', (err) => finish({ ok: false, error: `${TUNNEL_BINARY} failed to run: ${err?.message ?? err}` }));
    child.on('exit', (code) => {
      if (url) return finish({ ok: true, url, reason: `${TUNNEL_BINARY} exited (code ${code})` });
      finish({ ok: false, error: `${TUNNEL_BINARY} exited with code ${code} before publishing a URL. Output:\n${tail.trim() || '(nothing)'}` });
    });
  });
}

/**
 * ⚠️ TREE-KILL ON WINDOWS. `cloudflared` is a single process today, but
 * `lsp.mjs` records this package being overheated by a child that forked its own
 * child and outlived a plain `kill()`. A tunnel that survives its command is a
 * port left open, which is the worst possible thing for this file to leak.
 */
function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).unref();
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* it is already gone, which is the outcome we wanted */ }
}
