/**
 * ── ⭐⭐⭐ USERS GET UPDATES WITHOUT BEING ASKED TO ──────────────────────────
 *
 * Roman, 2026-08-22: *"how do we do self updates so all users get updates as
 * soon as we do it, and we just advertise the new npm version instead of having
 * users constantly download new versions, like Claude."*
 *
 * npm is IMMUTABLE — a published version can never be changed — so shipping a
 * fix means publishing a new version, and without this module every user sits on
 * whatever they first installed, forever. A bug we fixed in an hour would live
 * on their machine for months.
 *
 * ── ⚠️⚠️ WHAT THIS MUST NEVER DO, WHICH IS MOST OF THE DESIGN ───────────────
 *
 * It must never block a run, never throw, never slow the first token, and never
 * swap files underneath a session that is already executing. An update mechanism
 * that can break the tool is worse than no update mechanism: the failure lands
 * on someone who was in the middle of real work and did not ask for any of it.
 *
 * So: the check is THROTTLED to once a day against a cache, the install runs
 * DETACHED after the decision, and the new version applies on the NEXT run —
 * never the current one.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { accountDir } from './account.mjs';

export const PACKAGE_NAME = 'acuvo-code';

/** How long between registry checks. A day is plenty and keeps npm quiet. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Compare two semver-ish strings.
 *
 * ⚠️ NUMERIC PER SEGMENT, NOT LEXICOGRAPHIC. `'0.10.0' > '0.9.0'` is TRUE
 * numerically and FALSE as strings — so a string compare stops offering updates
 * exactly when the minor version reaches 10, and does it silently.
 *
 * @returns 1 if a > b, -1 if a < b, 0 if equal
 */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v ?? '')
      .trim()
      .replace(/^v/, '')
      // A prerelease suffix (`1.0.0-beta.1`) is dropped rather than ranked. We
      // do not publish them, and inventing an ordering for something that does
      // not exist is how you offer people a "newer" version that is older.
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function updateCachePath(env = process.env) {
  return join(accountDir(env), 'update-check.json');
}

function readCache(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), 'utf8');
  } catch {
    // A read-only home is not a reason to fail a run. Worst case we check again
    // next time, which costs one HTTP request.
  }
}

/**
 * Is there a newer published version?
 *
 * @returns {Promise<{latest: string, isNewer: boolean, checked: boolean}>}
 */
export async function checkForUpdate({
  current,
  fetchImpl = fetch,
  now = () => Date.now(),
  cachePath = updateCachePath(),
  intervalMs = CHECK_INTERVAL_MS,
  timeoutMs = 3000,
  force = false,
} = {}) {
  const cached = readCache(cachePath);
  if (!force && cached && now() - (cached.at ?? 0) < intervalMs) {
    return { latest: cached.latest ?? current, isNewer: compareVersions(cached.latest, current) > 0, checked: false };
  }

  let latest = current;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    /**
     * ⚠️ THE `latest` ENDPOINT, NOT THE FULL PACKUMENT. The full document for
     * this package is megabytes of version history; this one is a few hundred
     * bytes. On a slow connection that difference is the whole reason the check
     * finishes inside its timeout instead of being abandoned every run.
     */
    const res = await fetchImpl(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    clearTimeout(timer);
    const json = await res.json();
    if (typeof json?.version === 'string') latest = json.version;
  } catch {
    // Offline, DNS down, npm having a moment. None of these are the user's
    // problem and none should surface.
    return { latest: current, isNewer: false, checked: false };
  }

  writeCache(cachePath, { at: now(), latest });
  return { latest, isNewer: compareVersions(latest, current) > 0, checked: true };
}

/**
 * Install the newer version, DETACHED, so it applies to the next run.
 *
 * ⚠️⚠️ NEVER IN-PROCESS AND NEVER AWAITED. Rewriting `lib/*.mjs` underneath a
 * session that is mid-task is how an update becomes a crash in someone else's
 * work — and the person it lands on never asked for the update at all.
 *
 * @returns {boolean} whether the install was successfully STARTED (not finished)
 */
export function applyUpdate({ spawn, version = 'latest' } = {}) {
  if (!spawn) return false;
  try {
    const child = spawn(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '-g', `${PACKAGE_NAME}@${version}`],
      { stdio: 'ignore', detached: true },
    );
    child.unref?.();
    return true;
  } catch {
    // A global install can fail on permissions (a root-owned prefix is common).
    // Silently — the notice below still tells them the command to run.
    return false;
  }
}

/** The one line a user sees. Deliberately small; nobody wants a changelog here. */
export function updateNotice(current, latest, applied) {
  return applied
    ? `\nacuvo ${latest} is available (you have ${current}) — installing in the background, it will apply next run.\n`
    : `\nacuvo ${latest} is available (you have ${current}) — update with:  npm i -g ${PACKAGE_NAME}@latest\n`;
}

/**
 * Whether we should look at all.
 *
 * ⚠️ OFF FOR CI AND FOR ANYONE WHO SAYS SO. A build machine that silently
 * upgrades its own toolchain mid-pipeline produces results nobody can reproduce,
 * which is precisely the thing CI exists to prevent.
 */
export function updatesEnabled(env = process.env) {
  if (String(env.ACUVO_NO_UPDATE ?? '') === '1') return false;
  if (String(env.CI ?? '').toLowerCase() === 'true' || env.CI === '1') return false;
  return true;
}
