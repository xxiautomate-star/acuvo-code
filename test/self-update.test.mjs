import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVersions,
  checkForUpdate,
  applyUpdate,
  updatesEnabled,
  updateNotice,
} from '../lib/self-update.mjs';

const cache = () => join(mkdtempSync(join(tmpdir(), 'acuvo-upd-')), 'update-check.json');
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
  assert.equal(applyUpdate({ spawn }), true);
  assert.equal(opts.detached, true, 'rewriting lib/ under a running session is how an update becomes a crash');
  assert.equal(opts.stdio, 'ignore');
});

test('⚠️ a failing global install is silent, not fatal', () => {
  assert.equal(applyUpdate({ spawn: () => { throw new Error('EACCES'); } }), false);
  assert.equal(applyUpdate({}), false, 'no spawn available must be false, not a crash');
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
