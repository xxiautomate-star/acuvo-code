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

/**
 * How long between registry checks.
 *
 * ⚠️ WAS 24 HOURS, AND THAT NUMBER COST US FIVE ROUNDS OF A BUG REPORT.
 * Measured on Roman's machine 2026-08-22: the cache read
 * `{"at":13:47,"latest":"0.2.1"}`. It was correct when written. Four hours
 * later 0.6.5 was out, and his install would not look again until the
 * following afternoon — so three consecutive fixes to the opening screen were
 * invisible to him and he kept reporting a defect that had already been fixed
 * twice. "Users get updates as soon as we ship" was false by up to a day.
 *
 * ⭐ Six hours, so a fix shipped in the morning lands the same working day.
 * The registry call is one HTTP request with a 3s timeout, at EXIT — four a
 * day is not rude, and being a day stale on a young product is expensive.
 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
  /**
   * ── ⭐⭐⭐ A CACHE THAT CLAIMS AN OLDER VERSION IS "LATEST" IS PROVABLY WRONG
   *
   * If we are RUNNING 0.6.2 and the cache says the newest published version is
   * 0.2.1, then the cache is stale — no reasoning about clocks required, it is
   * contradicted by the file we are executing from. This is exactly the state
   * Roman's machine was in: he had manually installed a newer build, which left
   * a throttle entry insisting on a version four minors behind it, and that
   * entry then suppressed every check for the rest of the day.
   *
   * ⭐ It costs one comparison and it converts the worst failure mode of a
   * throttle — silently pinning somebody to an answer that is already known to
   * be wrong — into a single extra HTTP request.
   */
  const cacheIsStale = cached && compareVersions(current, cached.latest) > 0;
  if (!force && !cacheIsStale && cached && now() - (cached.at ?? 0) < intervalMs) {
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
/**
 * Version strings we are willing to hand to a shell.
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE THE FIX BELOW INTRODUCED A SHELL. Before it, args
 * were passed as an array and could not be reinterpreted; with `shell: true` on
 * Windows the whole command line is re-parsed by `cmd.exe`, so a version of
 * `latest & calc` would run `calc`. The value comes from the npm registry today
 * — but "the input is trusted" is the assumption every injection starts from,
 * and a self-updater runs unattended with the user's full privileges.
 */
const SAFE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * ── ⭐⭐ HOW MANY TIMES WE WILL QUIETLY TRY THE SAME INSTALL ─────────────────
 *
 * ⚠️ THE FAILURE THIS BOUNDS IS THE *SILENT PERMANENT* ONE, and it is the
 * ordinary shape of a broken global install: a root-owned npm prefix, a
 * read-only `/usr/local/lib/node_modules`, a corporate proxy that refuses the
 * registry. In every one of those the spawn SUCCEEDS — we started npm, so
 * `applyUpdate` returns true — and npm then fails on its own, detached, with
 * `stdio: 'ignore'`. Nobody sees anything.
 *
 * The user's side of that: every six hours, forever, acuvo prints *"installing
 * in the background, it will apply next run"*, and it never applies. A promise
 * broken on a schedule is worse than no promise, because the honest fallback —
 * the one-line command they can paste — is the branch we stop taking the moment
 * we claim success.
 *
 * ⭐ TWO ATTEMPTS, THEN TELL THE TRUTH. One retry covers a genuinely transient
 * failure (a flaky network, a lock held by another npm). A third would just be
 * the first month of a lie. After the cap, `applyUpdate` returns false and
 * `updateNotice` hands over `npm i -g acuvo-code@latest`, which is exactly what
 * somebody with a root-owned prefix needs to see.
 *
 * ⚠️ THE COUNTER RESETS WHEN THE TARGET CHANGES, and it must. Giving up on
 * 0.7.0 is not a reason to stop trying 0.8.0 — the thing that failed may be the
 * release, not the machine.
 */
export const MAX_INSTALL_ATTEMPTS = 2;

export function applyUpdate({
  spawn,
  version = 'latest',
  platform = process.platform,
  cachePath = updateCachePath(),
  now = () => Date.now(),
  maxAttempts = MAX_INSTALL_ATTEMPTS,
} = {}) {
  if (!spawn) return false;
  if (!SAFE_VERSION.test(String(version))) return false;

  /**
   * ⚠️ THE TARGET IS READ FROM THE CACHE, NOT FROM `version`. Every call site
   * passes the literal string `'latest'` — so counting attempts against
   * `version` would count attempts against a word that never changes, and the
   * cap would then swallow the FIRST attempt at every future release. The
   * resolved number is whatever `checkForUpdate` just wrote next door.
   */
  const cached = readCache(cachePath) ?? {};
  const target = typeof cached.latest === 'string' && cached.latest ? cached.latest : String(version);
  const prior = cached.install && cached.install.for === target ? cached.install : null;
  if ((prior?.tries ?? 0) >= maxAttempts) return false;

  const isWindows = platform === 'win32';
  try {
    const child = spawn(
      /**
       * ── ⚠️⚠️⚠️ THIS THREW `EINVAL` ON EVERY WINDOWS MACHINE, SILENTLY ──────
       *
       * Measured 2026-08-23 on Node v22.17.0/win32: `spawn('npm.cmd', …)`
       * throws `EINVAL` synchronously. Node 18.20.2+/20.12.2+/22 REFUSE to
       * spawn `.cmd` and `.bat` without `shell: true` — the fix for
       * CVE-2024-27980, where Windows re-parses batch arguments.
       *
       * ⚠️ SO AUTO-UPDATE HAD NEVER WORKED ON WINDOWS. The throw was caught,
       * `applyUpdate` returned false, and the user was handed a command to type
       * instead. Roman ran 0.6.10 through FIVE published versions and kept
       * reporting a display bug that had been fixed three times, because the
       * only thing standing between him and the fix was a sentence asking him
       * to run npm himself.
       *
       * ⭐ Roman, 2026-08-23: *"users will never know to do all this — how will
       * everything always get updated for users?"* They will not, and they
       * should not have to. That is what this module is for, and it was failing
       * closed while reporting nothing.
       *
       * ⚠️ AND THE TEST PASSED THE WHOLE TIME. It called `applyUpdate` with a
       * fake `spawn` that returns an object, so it proved the SHAPE of the call
       * (detached, stdio ignored) and never that the call could execute. A test
       * that supplies its own subject cannot discover that the real one is
       * rejected by the operating system.
       */
      isWindows ? 'npm' : 'npm',
      /**
       * ⚠️⚠️ `--prefer-online`, AND IT IS NOT BELT-AND-BRACES. npm caches the
       * PACKUMENT — the document listing a package's versions and which one is
       * "latest" — and serves it without revalidating. Reproduced here
       * 2026-08-22, minutes after publishing 0.6.6:
       *
       *   npm view acuvo-code version       -> 0.6.6
       *   npm i -g acuvo-code@latest        -> installed 0.6.5
       *   npm i -g acuvo-code@latest --prefer-online -> installed 0.6.6
       *
       * So a SECOND staleness layer sits underneath the one that caused this
       * whole incident, and it would have made the updater report success
       * while installing the version the user already had. An update mechanism
       * that silently no-ops is indistinguishable from the bug it was written
       * to fix.
       */
      ['install', '-g', '--prefer-online', `${PACKAGE_NAME}@${version}`],
      {
        stdio: 'ignore',
        detached: true,
        /**
         * ⚠️ WINDOWS ONLY, AND NOT EVERYWHERE. On POSIX `npm` is a real
         * executable and a shell would only add a process and an injection
         * surface for nothing.
         */
        shell: isWindows,
        /**
         * ⚠️ WITHOUT THIS A BLACK CONSOLE WINDOW FLASHES ON SCREEN. `detached`
         * on Windows gives the child its own console; combined with a shell
         * that is a visible cmd.exe popping up as the user exits acuvo. An
         * update they never asked for must also be one they never SEE.
         */
        windowsHide: true,
      },
    );
    /**
     * ── ⚠️⚠️⚠️ WITHOUT THIS LINE, A MISSING `npm` CRASHES THE CLI AT EXIT ─────
     *
     * MEASURED on Node v22.17.0, not reasoned about:
     *
     *     spawn('definitely-not-a-real-binary', […], { stdio:'ignore',
     *            detached:true })
     *     -> spawn returns normally, no throw
     *     -> node:events:496  throw er;  // Unhandled 'error' event
     *        Error: spawn … ENOENT      exit=1
     *
     * A failed spawn does not throw. It emits `'error'` on the child on the
     * NEXT TICK, and a ChildProcess with no `'error'` listener is an
     * EventEmitter with no `'error'` listener — Node rethrows it as an uncaught
     * exception. So the try/catch around this block, and the total catch in
     * `noticeUpdateQuietly`, both miss it: they are synchronous and the error is
     * not.
     *
     * ⚠️ AND IT LANDS AT THE WORST POSSIBLE MOMENT — AFTER the answer, AFTER we
     * printed *"installing in the background, it will apply next run"*, and
     * BEFORE `process.exit(code)`. The user's task succeeded; what they see is
     * `acuvo crashed — this is a bug in acuvo-code, not in your project`,
     * followed by an npm stack trace, and the exit code `main()` decided is
     * replaced by 1. A script that checks the exit status is told the work
     * failed because the machine has no `npm` on PATH.
     *
     * ⚠️ THIS IS NOT HYPOTHETICAL AND IT IS NOT WINDOWS. On Windows the spawn
     * goes through `cmd.exe`, which exists, so cmd reports "'npm' is not
     * recognized" on a stream nobody reads and exits quietly. It is POSIX —
     * macOS and Linux, where `spawn('npm')` resolves against PATH directly —
     * that gets the crash: nvm/volta/fnm shims that are shell functions rather
     * than binaries, a launchd/systemd/CI environment with a minimal PATH, a
     * Docker image with node and no npm.
     *
     * ⭐ SWALLOWING IS THE WHOLE FIX, and it is the right one. There is nothing
     * to report to: the process is one tick from exiting, the install is
     * detached and unobservable by construction, and the repeated-failure case
     * is handled by the attempt cap above rather than by a message.
     */
    child.on?.('error', () => { /* see above — a detached updater cannot report */ });
    child.unref?.();
    /**
     * ⚠️ RECORDED AT SPAWN, NOT AT SUCCESS — because success is unobservable
     * from here by design (detached, `stdio: 'ignore'`, and we exit first). The
     * proof that an install WORKED is that the next run is on the new version
     * and never reaches this function at all; the proof that it did not is that
     * we are standing here again with the same target.
     */
    writeCache(cachePath, {
      ...cached,
      install: { for: target, tries: (prior?.tries ?? 0) + 1, at: now() },
    });
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
