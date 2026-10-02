import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersions,
  checkForUpdate,
  applyUpdate,
  updatesEnabled,
  updateNotice,
  CHECK_INTERVAL_MS,
  MAX_INSTALL_ATTEMPTS,
} from '../lib/self-update.mjs';

const cache = () => join(mkdtempSync(join(tmpdir(), 'acuvo-upd-')), 'update-check.json');

/**
 * ── ⚠️⚠️ EVERY `applyUpdate` CALL GETS ITS OWN THROWAWAY CACHE ──────────────
 *
 * `applyUpdate` now counts its own failed attempts, and it counts them in the
 * same file `checkForUpdate` uses — which DEFAULTS to the real
 * `~/.acuvo/update-check.json`. Caught immediately when this was added: the
 * first run of this file wrote `install: {tries: 1}` into the developer's own
 * account directory, the second run pushed it to the cap, and from then on four
 * unrelated tests failed with `false !== true` because the subject under test
 * had correctly decided it had already tried twice.
 *
 * ⭐ THE FAILURE WAS THE FEATURE WORKING. That is worth writing down, because
 * the tempting reading is "the cap is flaky" — it is not; the tests were
 * sharing one persistent file with the machine they run on. A per-call temp
 * directory makes each assertion independent again AND keeps the suite out of
 * somebody's real home, which is the standing rule in this repo.
 */
const apply = (opts = {}) => applyUpdate({ cachePath: cache(), ...opts });
const reply = (version) => ({ ok: true, status: 200, json: async () => ({ version }) });

test('⚠️⚠️ versions compare NUMERICALLY — 0.10.0 is newer than 0.9.0', () => {
  /**
   * ── THE BUG THIS EXISTS TO PREVENT ──────────────────────────────────────────
   * As strings, '0.10.0' < '0.9.0' — because '1' sorts before '9'. A lexical
   * compare therefore stops offering updates the moment the minor version
   * reaches 10, and does it SILENTLY: no error, no warning, users simply stop
   * receiving releases and nobody finds out for months.
   */
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.2.1', '0.2.2'), -1);
  assert.equal(compareVersions('v0.3.0', '0.2.9'), 1, 'a leading v must not change the answer');
});

test('⭐⭐ a newer published version is detected', async () => {
  const got = await checkForUpdate({ current: '0.2.1', fetchImpl: async () => reply('0.3.0'), cachePath: cache() });
  assert.equal(got.isNewer, true);
  assert.equal(got.latest, '0.3.0');
});

test('⭐ the same version is not an update', async () => {
  const got = await checkForUpdate({ current: '0.2.1', fetchImpl: async () => reply('0.2.1'), cachePath: cache() });
  assert.equal(got.isNewer, false);
});

test('⚠️ an OLDER registry answer is never offered as an update', async () => {
  const got = await checkForUpdate({ current: '0.3.0', fetchImpl: async () => reply('0.2.1'), cachePath: cache() });
  assert.equal(got.isNewer, false, 'a stale mirror must not downgrade anybody');
});

test('⭐⭐ the check is THROTTLED — npm is hit once a day, not once a run', async () => {
  const path = cache();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return reply('0.3.0'); };
  await checkForUpdate({ current: '0.2.1', fetchImpl, cachePath: path });
  await checkForUpdate({ current: '0.2.1', fetchImpl, cachePath: path });
  await checkForUpdate({ current: '0.2.1', fetchImpl, cachePath: path });
  assert.equal(calls, 1, 'three runs must not mean three registry requests');
});

test('⭐ and the cached answer still reports the update', async () => {
  const path = cache();
  await checkForUpdate({ current: '0.2.1', fetchImpl: async () => reply('0.3.0'), cachePath: path });
  const second = await checkForUpdate({ current: '0.2.1', fetchImpl: async () => { throw new Error('must not be called'); }, cachePath: path });
  assert.equal(second.isNewer, true, 'throttling must not hide a known update');
  assert.equal(second.checked, false);
});

test('⚠️⚠️ being OFFLINE is silent and never an update', async () => {
  /**
   * The single most important property here. A user on a plane, behind a
   * corporate proxy, or on hotel wifi must see NOTHING — not a warning, not a
   * stack trace, and certainly not a failed run. The update check is the least
   * important thing happening in the process.
   */
  const got = await checkForUpdate({
    current: '0.2.1',
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
    cachePath: cache(),
  });
  assert.equal(got.isNewer, false);
  assert.equal(got.latest, '0.2.1');
});

test('⚠️ a garbage registry response does not crash or invent a version', async () => {
  const got = await checkForUpdate({
    current: '0.2.1',
    fetchImpl: async () => ({ ok: true, json: async () => ({ nope: true }) }),
    cachePath: cache(),
  });
  assert.equal(got.isNewer, false);
});

test('⚠️⚠️ the install is DETACHED — it must never run in-process', () => {
  let opts = null;
  const spawn = (_cmd, _args, o) => { opts = o; return { unref() {} }; };
  assert.equal(apply({ spawn }), true);
  assert.equal(opts.detached, true, 'rewriting lib/ under a running session is how an update becomes a crash');
  assert.equal(opts.stdio, 'ignore');
});

test('⚠️ a failing global install is silent, not fatal', () => {
  assert.equal(apply({ spawn: () => { throw new Error('EACCES'); } }), false);
  assert.equal(apply({}), false, 'no spawn available must be false, not a crash');
});

test('⚠️⚠️⚠️ THE REAL spawn ON THE REAL PLATFORM ACCEPTS THE REAL COMMAND', () => {
  /**
   * ── ⭐⭐⭐ THE TEST ABOVE PASSED WHILE THIS WAS BROKEN FOR EVERY WINDOWS USER
   *
   * Every other test here hands `applyUpdate` a FAKE spawn. That proves the
   * shape of the call — detached, stdio ignored — and cannot ever discover that
   * the operating system refuses the call, because the fake accepts everything.
   *
   * ⚠️ WHAT IT MISSED: `spawn('npm.cmd', …)` throws `EINVAL` synchronously on
   * Node 18.20.2+/20.12.2+/22 for Windows — spawning `.cmd`/`.bat` now requires
   * `shell: true` (CVE-2024-27980). So auto-update failed on 100% of Windows
   * installs, was caught, and quietly degraded to "please type this command".
   *
   * ⭐ SO THIS TEST USES THE REAL `child_process.spawn`, and only substitutes
   * the ARGUMENTS — `npm --version` instead of `npm install -g` — so it can
   * exercise the command name and the options for real without installing
   * anything into the machine running the suite. The command name and the
   * options are exactly what broke; the argument list never was.
   */
  let failure = null;
  const realSpawnHarmlessArgs = (cmd, _args, opts) => {
    const child = spawn(cmd, ['--version'], opts);
    child.on('error', (e) => { failure = e; });
    return child;
  };

  assert.equal(
    apply({ spawn: realSpawnHarmlessArgs }),
    true,
    'the platform rejected the command we use to update every user',
  );
  assert.equal(failure, null, `spawn reported ${failure?.code}`);
});

test('⚠️⚠️ A VERSION IS NEVER PASTED INTO A SHELL UNCHECKED', () => {
  /**
   * The Windows fix introduced `shell: true`, which means the command line is
   * re-parsed by cmd.exe. `latest & calc` would then run `calc`. The value comes
   * from the npm registry, but a self-updater runs unattended with the full
   * privileges of the user, so it validates rather than trusts.
   */
  const spawn = () => ({ unref() {} });
  assert.equal(apply({ spawn, version: 'latest' }), true);
  assert.equal(apply({ spawn, version: '0.6.15' }), true);
  for (const evil of ['latest & calc', 'x; rm -rf /', '$(id)', 'a|b', '`id`', '--registry=evil.tld', '']) {
    assert.equal(apply({ spawn, version: evil }), false, `must refuse: ${evil}`);
  }
});

test('⚠️ POSIX gets no shell — it does not need one and a shell is a surface', () => {
  let opts = null;
  const spawn = (_c, _a, o) => { opts = o; return { unref() {} }; };
  apply({ spawn, platform: 'linux' });
  assert.equal(opts.shell, false, 'npm is a real executable on POSIX');
  apply({ spawn, platform: 'win32' });
  assert.equal(opts.shell, true);
  assert.equal(opts.windowsHide, true, 'a console window flashing on exit is a visible surprise');
});

test('⚠️⚠️ CI never self-updates — a pipeline that upgrades its own toolchain is unreproducible', () => {
  assert.equal(updatesEnabled({ CI: 'true' }), false);
  assert.equal(updatesEnabled({ CI: '1' }), false);
  assert.equal(updatesEnabled({ ACUVO_NO_UPDATE: '1' }), false);
  assert.equal(updatesEnabled({}), true);
});

test('⭐ the notice names the version and how to act on it', () => {
  assert.match(updateNotice('0.2.1', '0.3.0', false), /0\.3\.0.*0\.2\.1/s);
  assert.match(updateNotice('0.2.1', '0.3.0', false), /npm i -g acuvo-code@latest/);
  assert.match(updateNotice('0.2.1', '0.3.0', true), /next run/);
});

/* ── the throttle bug that cost five rounds of a bug report ──────────────── */

test('⭐⭐⭐ a cache claiming an OLDER version is latest is treated as stale', async () => {
  /**
   * ⚠️ THE EXACT STATE MEASURED ON ROMAN'S MACHINE, 2026-08-22. The cache said
   * `{"at": 13:47, "latest": "0.2.1"}` while he was RUNNING 0.6.2. That entry
   * was correct when written and became self-contradicting the moment he
   * installed a newer build by hand — and it then suppressed every update check
   * for the rest of the day, hiding three consecutive fixes to the opening
   * screen. He reported the same defect five times; three of those reports were
   * against code that had already been fixed.
   *
   * A throttle that can pin somebody to an answer the running binary disproves
   * is not a throttle, it is a stuck valve.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-upd-'));
  const cachePath = join(dir, 'update-check.json');
  writeFileSync(cachePath, JSON.stringify({ at: Date.now(), latest: '0.2.1' }), 'utf8');

  let asked = false;
  const fetchImpl = async () => {
    asked = true;
    return { ok: true, json: async () => ({ version: '0.6.5' }) };
  };

  const r = await checkForUpdate({ current: '0.6.2', cachePath, fetchImpl });
  assert.equal(asked, true, 'the stale cache suppressed the check — the original bug');
  assert.equal(r.latest, '0.6.5');
  assert.equal(r.isNewer, true);
  rmSync(dir, { recursive: true, force: true });
});

test('⚠️ a cache that is merely FRESH is still honoured — the throttle still works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-upd-'));
  const cachePath = join(dir, 'update-check.json');
  writeFileSync(cachePath, JSON.stringify({ at: Date.now(), latest: '0.9.0' }), 'utf8');
  let asked = false;
  const fetchImpl = async () => { asked = true; return { ok: true, json: async () => ({ version: '0.9.0' }) }; };
  const r = await checkForUpdate({ current: '0.6.5', cachePath, fetchImpl });
  assert.equal(asked, false, 'it hit the network despite a valid fresh cache');
  assert.equal(r.isNewer, true);
  rmSync(dir, { recursive: true, force: true });
});

test('⚠️ the interval is short enough that a morning fix lands the same day', () => {
  assert.ok(CHECK_INTERVAL_MS <= 6 * 60 * 60 * 1000, 'a day-long throttle is what caused the incident');
});

test('⚠️⚠️ the install bypasses npm\'s OWN packument cache', () => {
  /**
   * Reproduced minutes after publishing 0.6.6: `npm view` reported 0.6.6 while
   * `npm i -g acuvo-code@latest` installed 0.6.5. Without `--prefer-online` the
   * updater would announce an update and then install the version the user
   * already had — a silent no-op, which is indistinguishable from the bug it
   * exists to fix.
   */
  const calls = [];
  const spawn = (cmd, args) => { calls.push({ cmd, args }); return { unref() {} }; };
  apply({ spawn });
  assert.ok(calls[0].args.includes('--prefer-online'), 'npm will happily install a cached, stale "latest"');
});

/**
 * ── ⭐⭐⭐ THE CRASH AT EXIT — MEASURED, NOT REASONED ABOUT ───────────────────
 *
 * On Node v22.17.0:
 *
 *     spawn('definitely-not-a-real-binary', ['install'],
 *           { stdio: 'ignore', detached: true })
 *     -> returns normally, no throw
 *     -> node:events:496  throw er;  // Unhandled 'error' event
 *        Error: spawn definitely-not-a-real-binary ENOENT      exit = 1
 *
 * A failed spawn does not throw; it emits `'error'` on the NEXT TICK. So the
 * try/catch inside `applyUpdate` and the total catch in `noticeUpdateQuietly`
 * both miss it — they are synchronous and the failure is not — and Node rethrows
 * it as an uncaught exception, AFTER we told the user the update was installing
 * and BEFORE `process.exit(code)` runs. The task succeeded and the user is shown
 * `acuvo crashed — this is a bug in acuvo-code, not in your project` with an npm
 * stack trace, and the exit code the run earned is replaced by 1.
 *
 * ⚠️ POSIX, NOT WINDOWS. Windows routes through `cmd.exe`, which always exists;
 * `spawn('npm')` on macOS/Linux resolves against PATH directly, so an nvm/volta
 * shell-function shim, a minimal launchd/systemd PATH, or a node image without
 * npm all reach the crash.
 */
test('⚠️⚠️⚠️ a spawn that fails AFTER returning must not crash the CLI at exit', () => {
  const child = new EventEmitter();
  child.unref = () => {};
  assert.equal(apply({ spawn: () => child }), true);

  /**
   * ⚠️ THIS IS THE ASSERTION, AND IT IS EXACT: on an EventEmitter with no
   * `'error'` listener, `emit('error', …)` THROWS. That is not a detail of the
   * test harness — it is the whole mechanism of the crash, verified directly
   * below so this test cannot pass by accident on a future Node.
   */
  const bare = new EventEmitter();
  assert.throws(() => bare.emit('error', new Error('ENOENT')), /ENOENT/,
    'an unlistened error must throw, or this test proves nothing');

  assert.doesNotThrow(
    () => child.emit('error', Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })),
    'a detached updater that cannot start must be silent, not a stack trace over a successful run',
  );
});

/**
 * ── ⭐⭐ AN UPDATE THAT CAN NEVER SUCCEED MUST STOP PROMISING ────────────────
 *
 * A root-owned npm prefix, a read-only global lib directory, a proxy that
 * refuses the registry: in all of them the SPAWN succeeds, so `applyUpdate`
 * returns true, and npm then fails on its own — detached, `stdio: 'ignore'`,
 * unobservable. The user is told *"installing in the background, it will apply
 * next run"* every six hours forever, and it never applies. The honest branch —
 * the command they can paste — is the one we stop taking the moment we claim
 * success.
 */
test('⭐⭐ after MAX_INSTALL_ATTEMPTS the updater hands over the command instead', () => {
  const cachePath = cache();
  const spawn = () => ({ unref() {}, on() {} });
  // What `checkForUpdate` would have written next door before we are called.
  writeFileSync(cachePath, JSON.stringify({ at: Date.now(), latest: '0.9.0' }), 'utf8');
  assert.equal(MAX_INSTALL_ATTEMPTS, 2, 'the two calls below are written against this number');

  assert.equal(applyUpdate({ spawn, cachePath }), true, 'the first attempt is always made');
  assert.equal(applyUpdate({ spawn, cachePath }), true, 'one retry covers a transient failure');
  assert.equal(applyUpdate({ spawn, cachePath }), false, 'a third identical attempt is a lie on a schedule');

  assert.match(updateNotice('0.6.0', '0.9.0', false), /npm i -g acuvo-code@latest/,
    'and what the user is shown instead has to be the thing that actually works');
});

test('⚠️ the attempt count is keyed to the TARGET, so a new release is always tried', () => {
  /**
   * ⚠️ EVERY CALL SITE PASSES THE LITERAL STRING `'latest'`, so counting against
   * `version` would count against a word that never changes — and the cap would
   * then swallow the FIRST attempt at every future release. The resolved number
   * lives in the cache `checkForUpdate` just wrote, which is what is keyed on.
   */
  const cachePath = cache();
  const spawn = () => ({ unref() {}, on() {} });
  writeFileSync(cachePath, JSON.stringify({ at: Date.now(), latest: '0.9.0' }), 'utf8');
  applyUpdate({ spawn, cachePath });
  applyUpdate({ spawn, cachePath });
  assert.equal(applyUpdate({ spawn, cachePath }), false, 'capped on 0.9.0');

  // 0.9.1 ships. Giving up on 0.9.0 is no reason to refuse a different release.
  const carried = JSON.parse(readFileSync(cachePath, 'utf8'));
  writeFileSync(cachePath, JSON.stringify({ ...carried, latest: '0.9.1' }), 'utf8');
  assert.equal(applyUpdate({ spawn, cachePath }), true, 'the machine may be fine and the release may not have been');
});

test('⚠️ counting attempts must not destroy what checkForUpdate wrote', () => {
  const cachePath = cache();
  const spawn = () => ({ unref() {}, on() {} });
  writeFileSync(cachePath, JSON.stringify({ at: 1234, latest: '0.9.0' }), 'utf8');
  applyUpdate({ spawn, cachePath });
  const after = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.equal(after.at, 1234, 'clobbering the throttle timestamp would re-open a registry request every run');
  assert.equal(after.latest, '0.9.0');
  assert.equal(after.install.tries, 1);
});
