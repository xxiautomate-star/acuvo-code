/**
 * ── ⭐⭐ SEVEN TERMINALS, ONE CHECKOUT — THE TEST THAT HAS TO BE REAL ────────
 *
 * `lib/parallel.mjs` coordinates tasks inside ONE process. Seven `acuvo`
 * processes on one machine share nothing at all, so the only honest proof that
 * a lease works is to **run several processes and watch them fight**. Every
 * other assertion in this file is pure and microsecond-fast on an injected
 * clock; the two race tests spawn real children, because a mutual-exclusion
 * primitive proven only by single-process unit tests is a primitive that has
 * never been asked the one question it exists to answer.
 *
 * ⚠️ NO MODEL, NO NETWORK, NO SLEEP. Every TTL here is travelled by moving an
 * injected clock, not by waiting. The only real time spent is the ~250ms the
 * racing children spend aligning on a start instant, which is the price of a
 * genuine race and is paid twice in the whole file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as leaseModule from '../lib/lease.mjs';
const exportNames = Object.keys(leaseModule);

import {
  acquire,
  acquireAll,
  renew,
  renewAll,
  release,
  releaseAll,
  inspect,
  formatLeaseSummary,
  reclaimableAfter,
  leaseFilePath,
  LEASE_DIR,
  LEASE_VERSION,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  RECLAIM_GRACE_MS,
  MAX_TAKEOVERS,
  REGISTRATION_SNIPPET,
} from '../lib/lease.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEASE_URL = pathToFileURL(join(ROOT, 'lib/lease.mjs')).href;

/** A workspace that looks like a checkout: a real directory with a real file. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-lease-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 1;\n', 'utf8');
  return dir;
}

/** A clock you can wind forward by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => { t += ms; return t; };
  clock.set = (ms) => { t = ms; return t; };
  return clock;
}

const leaseDirOf = (root) => join(root, ...LEASE_DIR.split('/'));
const leaseFiles = (root) => (existsSync(leaseDirOf(root)) ? readdirSync(leaseDirOf(root)).sort() : []);

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE PRIMITIVE
// ═══════════════════════════════════════════════════════════════════════════

test('acquire on a free path succeeds and writes one lease file', () => {
  const root = workspace();
  const clock = fakeClock();
  const got = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, ttlMs: 60_000, clock });

  assert.equal(got.ok, true, got.error);
  assert.equal(got.lease.path, 'src/app.ts');
  assert.equal(got.lease.holder, 't1');
  assert.equal(got.lease.ttlMs, 60_000);
  assert.equal(got.lease.acquiredAt, 1_000_000, 'the record must use the INJECTED clock, not Date.now()');
  assert.ok(got.lease.token, 'a lease needs a token — holder names are not unique enough to prove ownership');

  const files = leaseFiles(root);
  assert.equal(files.length, 1, `expected exactly one lease file, got ${files.join(', ')}`);
  const record = JSON.parse(readFileSync(join(leaseDirOf(root), files[0]), 'utf8'));
  assert.equal(record.version, LEASE_VERSION);
  assert.equal(record.path, 'src/app.ts');
  assert.equal(record.holder, 't1');
  assert.equal(record.pid, 111);
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ a second holder is refused, and told WHO holds it and SINCE when', () => {
  const root = workspace();
  const clock = fakeClock();
  assert.equal(acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock }).ok, true);

  clock.advance(5_000);
  const denied = acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock });
  assert.equal(denied.ok, false);
  assert.equal(denied.heldBy, 't1');
  assert.equal(denied.since, 1_000_000, 'since = when the holder first took it, not when it was last renewed');
  assert.ok(/t1/.test(denied.error), `the refusal must name the holder: ${denied.error}`);
  assert.equal(leaseFiles(root).length, 1, 'a refused acquire must not leave a second lease file');
  rmSync(root, { recursive: true, force: true });
});

test('⭐ THE POINT OF THE WHOLE FILE: leases are per PATH, not per repo', () => {
  const root = workspace();
  const clock = fakeClock();
  writeFileSync(join(root, 'src', 'other.ts'), 'x\n', 'utf8');

  const a = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock });
  const b = acquire(root, { path: 'src/other.ts', holder: 't2', pid: 222, clock });

  assert.equal(a.ok, true);
  assert.equal(b.ok, true, 'a repo-wide lock idles six of seven terminals — that defeats the feature');
  assert.equal(leaseFiles(root).length, 2);
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ the same path spelled differently is the SAME lease', () => {
  const root = workspace();
  const clock = fakeClock();
  assert.equal(acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock }).ok, true);

  /**
   * ⚠️ THE BACKSLASH IS NOT AN ALIAS EVERYWHERE, AND CI IS WHERE THAT SURFACED.
   *
   * This ran green on Windows for weeks and failed the moment it first executed
   * on Linux, asserting that `src\app.ts` bypasses the lease on `src/app.ts`.
   * It does — correctly. On POSIX a backslash is a LEGAL FILENAME CHARACTER, so
   * `src\app.ts` is a single file named `src\app.ts`, a genuinely different file
   * that a second worker is entitled to hold. `normalizePath` splits on
   * `path.sep`, which is exactly right on both platforms; the TEST was the thing
   * encoding a Windows habit as a universal rule.
   *
   * ⭐ So the backslash case is not skipped on Linux — it is asserted the other
   * way round, below. A platform-conditional test that only ever asserts on one
   * platform is coverage you have quietly deleted.
   */
  const alwaysAliases = ['./src/app.ts', 'src/./app.ts'];
  const aliases = process.platform === 'win32' ? [...alwaysAliases, 'src\\app.ts'] : alwaysAliases;

  for (const alias of aliases) {
    const denied = acquire(root, { path: alias, holder: 't2', pid: 222, clock });
    assert.equal(denied.ok, false, `"${alias}" bypassed the lease on src/app.ts`);
    assert.equal(denied.heldBy, 't1');
  }
  assert.equal(leaseFiles(root).length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ on POSIX a backslash is a FILENAME, so it is a different file and a separate lease', { skip: process.platform === 'win32' ? 'backslash is a separator here' : false }, () => {
  /**
   * The other half of the test above. Over-locking is a refusal you can read,
   * but refusing a file a worker legitimately owns idles a terminal for a reason
   * nobody can explain — and on Linux `src\app.ts` really is its own file.
   */
  const root = workspace();
  const clock = fakeClock();
  assert.equal(acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock }).ok, true);

  const other = acquire(root, { path: 'src\\app.ts', holder: 't2', pid: 222, clock });
  assert.equal(other.ok, true, 'a file whose NAME contains a backslash is not the file at src/app.ts');
  assert.equal(leaseFiles(root).length, 2);
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ names differing only in CASE share one lease (deliberately conservative)', () => {
  /**
   * On Windows — the machine this runs on — `src/App.ts` and `src/app.ts` are
   * ONE file, so keying the lease on the exact spelling would hand two live
   * agents the same file. On Linux they are two files and this over-locks by
   * one. Over-locking is a refusal you can read; under-locking is corruption
   * you cannot see. The refusal says so out loud.
   */
  const root = workspace();
  const clock = fakeClock();
  assert.equal(acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock }).ok, true);
  const denied = acquire(root, { path: 'src/APP.ts', holder: 't2', pid: 222, clock });
  assert.equal(denied.ok, false);
  assert.ok(/case/i.test(denied.error), `the refusal must explain the case rule: ${denied.error}`);
  rmSync(root, { recursive: true, force: true });
});

test('a lease outside the workspace is refused, not written', () => {
  const root = workspace();
  const clock = fakeClock();
  for (const bad of ['../escape.ts', '/etc/passwd', 'C:/Windows/x.ini', '', null, 42]) {
    const got = acquire(root, { path: bad, holder: 't1', pid: 111, clock });
    assert.equal(got.ok, false, `${JSON.stringify(bad)} was leased`);
    assert.ok(got.error, 'a refusal must carry a reason');
  }
  assert.deepEqual(leaseFiles(root), []);
  rmSync(root, { recursive: true, force: true });
});

test('a lease with no holder is refused — an anonymous lock cannot be released or blamed', () => {
  const root = workspace();
  const clock = fakeClock();
  for (const holder of [undefined, '', '   ', 7]) {
    const got = acquire(root, { path: 'src/app.ts', holder, pid: 111, clock });
    assert.equal(got.ok, false, `holder ${JSON.stringify(holder)} was accepted`);
  }
  assert.deepEqual(leaseFiles(root), []);
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ a broken clock is an honest error, never a poisoned record', () => {
  const root = workspace();
  for (const clock of [() => NaN, () => 'later', () => undefined, 'not a function']) {
    const got = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock });
    assert.equal(got.ok, false, `clock ${String(clock)} produced a lease`);
    assert.ok(/clock/i.test(got.error), got.error);
  }
  assert.deepEqual(leaseFiles(root), [], 'a bad clock must not leave a lease with a NaN timestamp on disk');
  rmSync(root, { recursive: true, force: true });
});

test('ttlMs is clamped into a sane band, and the lease reports what it actually got', () => {
  const root = workspace();
  const clock = fakeClock();
  const tiny = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, ttlMs: 1, clock });
  assert.equal(tiny.lease.ttlMs, MIN_TTL_MS);
  release(tiny.lease);

  const huge = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, ttlMs: 99 * 3_600_000, clock });
  assert.equal(huge.lease.ttlMs, MAX_TTL_MS);
  release(huge.lease);

  const junk = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, ttlMs: 'soon', clock });
  assert.equal(junk.lease.ttlMs, DEFAULT_TTL_MS);
  rmSync(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. RE-ENTRANCY — the legitimate shapes a naive check would fail
// ═══════════════════════════════════════════════════════════════════════════

test('⭐ the SAME process re-acquiring its own lease succeeds (it is not a conflict)', () => {
  const root = workspace();
  const clock = fakeClock();
  const first = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock });
  clock.advance(3_000);
  const again = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock });

  assert.equal(again.ok, true, 'a terminal declaring the same file twice must not deadlock against itself');
  assert.equal(again.reacquired, true);
  assert.equal(again.lease.token, first.lease.token, 'a re-acquire keeps the token, so the first handle still works');
  assert.equal(again.lease.renewedAt, 1_003_000, 're-acquiring is also a heartbeat');
  assert.equal(leaseFiles(root).length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ the same holder NAME from a different pid is refused — that is two terminals', () => {
  const root = workspace();
  const clock = fakeClock();
  acquire(root, { path: 'src/app.ts', holder: 'acuvo', pid: 111, clock });
  const denied = acquire(root, { path: 'src/app.ts', holder: 'acuvo', pid: 222, clock });
  assert.equal(denied.ok, false, 'two terminals that defaulted to the same holder name must not share a lease');
  assert.equal(denied.heldBy, 'acuvo');
  assert.ok(/pid/i.test(denied.error), `the refusal should point at the duplicate name: ${denied.error}`);
  rmSync(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. TTL, HEARTBEAT AND THE CONSERVATIVE TAKEOVER
// ═══════════════════════════════════════════════════════════════════════════

test('renew is a heartbeat: a renewed lease never becomes reclaimable', () => {
  const root = workspace();
  const clock = fakeClock();
  const held = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, ttlMs: 10_000, clock }).lease;

  for (let i = 0; i < 20; i++) {
    clock.advance(5_000);
    const beat = renew(held, { clock });
    assert.equal(beat.ok, true, `heartbeat ${i} failed: ${beat.error}`);
    assert.equal(beat.lease.renewedAt, clock());
  }
  // 100 seconds later, ten times the TTL — and still nobody can take it.
  const denied = acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock });
  assert.equal(denied.ok, false, 'a live, heartbeating terminal lost its lease');
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ an EXPIRED lease is still refused until it is WELL past — eager reclaim corrupts work', () => {
  const root = workspace();
  const clock = fakeClock();
  acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, ttlMs: 10_000, clock });

  clock.advance(10_001); // past the TTL, but only just
  const early = acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock });
  assert.equal(early.ok, false, 'reclaiming at TTL hands two live agents the same file');
  assert.equal(early.expired, true, 'it should still SAY the lease is expired');
  assert.ok(early.reclaimableInMs > 0, 'and say how long until it can be taken');

  clock.advance(reclaimableAfter(10_000) - 10_001); // exactly at the boundary
  assert.equal(acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock }).ok, false, 'the boundary itself is still held');

  clock.advance(1);
  const taken = acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock });
  assert.equal(taken.ok, true, 'a crashed terminal must not block the repo for ever');
  rmSync(root, { recursive: true, force: true });
});

test('reclaimableAfter is never shorter than the grace period, whatever the TTL', () => {
  assert.equal(reclaimableAfter(1_000), 1_000 + RECLAIM_GRACE_MS);
  assert.equal(reclaimableAfter(600_000), 1_200_000, 'a long TTL doubles rather than adding a fixed grace');
  assert.ok(reclaimableAfter(MIN_TTL_MS) > MIN_TTL_MS);
});

test('⭐ a takeover is RECORDED, so it is visible afterwards', () => {
  const root = workspace();
  const clock = fakeClock();
  acquire(root, { path: 'src/app.ts', holder: 'crashed-t1', pid: 111, ttlMs: 10_000, clock });
  clock.advance(reclaimableAfter(10_000) + 1);

  const taken = acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, ttlMs: 10_000, clock });
  assert.equal(taken.ok, true);
  assert.equal(taken.takeover.from, 'crashed-t1');
  assert.equal(taken.takeover.pid, 111);
  assert.equal(taken.takeover.silentForMs, reclaimableAfter(10_000) + 1);

  const record = JSON.parse(readFileSync(join(leaseDirOf(root), leaseFiles(root)[0]), 'utf8'));
  assert.equal(record.takeovers.length, 1);
  assert.equal(record.takeovers[0].from, 'crashed-t1');
  assert.equal(record.holder, 't2');
  assert.equal(leaseFiles(root).length, 1, 'the takeover must not leave the stale file behind as litter');
  rmSync(root, { recursive: true, force: true });
});

test('the takeover history is capped — a long-lived path must not grow an unbounded file', () => {
  const root = workspace();
  const clock = fakeClock();
  for (let i = 0; i < MAX_TAKEOVERS + 4; i++) {
    acquire(root, { path: 'src/app.ts', holder: `t${i}`, pid: 100 + i, ttlMs: 10_000, clock });
    clock.advance(reclaimableAfter(10_000) + 1);
  }
  const record = JSON.parse(readFileSync(join(leaseDirOf(root), leaseFiles(root)[0]), 'utf8'));
  assert.equal(record.takeovers.length, MAX_TAKEOVERS);
  assert.equal(record.takeovers.at(-1).from, `t${MAX_TAKEOVERS + 2}`, 'the cap must drop the OLDEST, not the newest');
  rmSync(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. LOSING A LEASE — the part that must never be silent
// ═══════════════════════════════════════════════════════════════════════════

test('⚠️⚠️ renew after a takeover FAILS — an agent must never keep writing under a lost lease', () => {
  const root = workspace();
  const clock = fakeClock();
  const mine = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, ttlMs: 10_000, clock }).lease;

  clock.advance(reclaimableAfter(10_000) + 1);
  assert.equal(acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock }).ok, true);

  const beat = renew(mine, { clock });
  assert.equal(beat.ok, false, 'renewing a lease that was taken from us must not silently succeed');
  assert.equal(beat.reason, 'lost');
  assert.equal(beat.heldBy, 't2');

  const record = JSON.parse(readFileSync(join(leaseDirOf(root), leaseFiles(root)[0]), 'utf8'));
  assert.equal(record.holder, 't2', 'the failed renew must not have clobbered the new holder');
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ renew refuses once our OWN lease is past its TTL — re-acquire is the honest path', () => {
  const root = workspace();
  const clock = fakeClock();
  const mine = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, ttlMs: 10_000, clock }).lease;

  clock.advance(10_001);
  const late = renew(mine, { clock });
  assert.equal(late.ok, false, 'a blind write past the TTL races whoever is mid-takeover');
  assert.equal(late.reason, 'expired');

  // …and the recovery is one call, because the lease on disk is still ours.
  const back = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, ttlMs: 10_000, clock });
  assert.equal(back.ok, true, 'a late heartbeat must not cost a terminal its own lease');
  assert.equal(back.reacquired, true);
  rmSync(root, { recursive: true, force: true });
});

test('renew of a deleted lease reports it gone rather than re-creating it behind our back', () => {
  const root = workspace();
  const clock = fakeClock();
  const mine = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock }).lease;
  release(mine);

  const beat = renew(mine, { clock });
  assert.equal(beat.ok, false);
  assert.equal(beat.reason, 'gone');
  assert.deepEqual(leaseFiles(root), [], 'renew must not resurrect a released lease');
  rmSync(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. RELEASE IS ALWAYS SAFE
// ═══════════════════════════════════════════════════════════════════════════

test('release deletes our own lease and is idempotent', () => {
  const root = workspace();
  const clock = fakeClock();
  const mine = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock }).lease;

  const first = release(mine);
  assert.equal(first.ok, true);
  assert.equal(first.released, true);
  assert.deepEqual(leaseFiles(root), []);

  const second = release(mine);
  assert.equal(second.ok, true, 'releasing twice must never throw or fail');
  assert.equal(second.released, false);
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ release NEVER deletes a lease that is no longer ours', () => {
  const root = workspace();
  const clock = fakeClock();
  const mine = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, ttlMs: 10_000, clock }).lease;
  clock.advance(reclaimableAfter(10_000) + 1);
  acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock });

  const late = release(mine);
  assert.equal(late.ok, true, 'release must never throw');
  assert.equal(late.released, false);
  assert.ok(/t2/.test(late.reason), `it should say who has it now: ${late.reason}`);
  assert.equal(leaseFiles(root).length, 1, 'a late release must not unlock the file under the new holder');
  rmSync(root, { recursive: true, force: true });
});

test('release survives nonsense handles and a vanished workspace', () => {
  const root = workspace();
  const clock = fakeClock();
  const mine = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock }).lease;
  for (const junk of [null, undefined, {}, { file: 42 }, 'lease']) {
    const got = release(junk);
    assert.equal(got.ok, true, `release(${JSON.stringify(junk)}) threw or failed`);
    assert.equal(got.released, false);
  }
  rmSync(root, { recursive: true, force: true });
  assert.equal(release(mine).ok, true, 'releasing into a deleted workspace must not throw');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. CRASH SAFETY: CORRUPT AND PARTIAL FILES
// ═══════════════════════════════════════════════════════════════════════════

test('⚠️ a corrupt lease file is treated as ABSENT with a warning — never a fatal, never a lock', () => {
  const root = workspace();
  const clock = fakeClock();
  const file = leaseFilePath(root, 'src/app.ts');
  assert.equal(file.ok, true, file.error);
  mkdirSync(dirname(file.absolute), { recursive: true });

  for (const body of ['{"version"', '', 'null', '[]', '{"version":999,"holder":"x"}', '{"version":1,"holder":""}']) {
    writeFileSync(file.absolute, body, 'utf8');
    const got = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock });
    assert.equal(got.ok, true, `a corrupt lease (${JSON.stringify(body)}) blocked the repo: ${got.error}`);
    assert.ok(got.warnings.some((w) => /corrupt/i.test(w)), `the takeover of a corrupt file must be announced: ${got.warnings}`);
    release(got.lease);
  }
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ a lease file half-written by a killed process never publishes a partial record', () => {
  /**
   * The publish is a temp file plus an atomic link/rename, so the only two
   * states a reader can ever see are "no file" and "the whole file". This
   * asserts the invariant the implementation buys: after any acquire/renew,
   * every byte on disk parses.
   */
  const root = workspace();
  const clock = fakeClock();
  const mine = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock }).lease;
  for (let i = 0; i < 5; i++) { clock.advance(1_000); renew(mine, { clock }); }

  for (const name of leaseFiles(root)) {
    const raw = readFileSync(join(leaseDirOf(root), name), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), `${name} is not valid JSON: ${raw.slice(0, 60)}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ no .tmp litter survives an acquire, a renew, a takeover or a release', () => {
  const root = workspace();
  const clock = fakeClock();
  const a = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, ttlMs: 10_000, clock }).lease;
  renew(a, { clock });
  clock.advance(reclaimableAfter(10_000) + 1);
  const b = acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock }).lease;
  release(b);

  assert.deepEqual(leaseFiles(root), [], `left behind: ${leaseFiles(root).join(', ')}`);
  rmSync(root, { recursive: true, force: true });
});

test('⭐ a filesystem without hard links still leases (link is an optimisation, not a requirement)', () => {
  const root = workspace();
  const clock = fakeClock();
  const noLinks = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };

  const first = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock, linkImpl: noLinks });
  assert.equal(first.ok, true, `the fallback path must work: ${first.error}`);
  const denied = acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock, linkImpl: noLinks });
  assert.equal(denied.ok, false, 'the fallback must still be exclusive');
  assert.equal(leaseFiles(root).length, 1, `no litter from the fallback: ${leaseFiles(root).join(', ')}`);
  rmSync(root, { recursive: true, force: true });
});

test('⚠️⚠️ the DEFAULT publish really is the link — the fallback test above cannot see this', () => {
  /**
   * ⚠️ THE TEST ABOVE PASSES AGAINST BROKEN CODE, and this one exists because
   * of it. Measured: replacing the link call with an unconditional "this
   * filesystem cannot link" still passed all 39 tests, because proving the
   * FALLBACK works says nothing about whether the primary path is ever taken.
   * An implementation that quietly used O_EXCL always would look identical.
   *
   * ⭐ It matters which one runs. `link()` publishes a file that is COMPLETE at
   * the instant it becomes visible — the bytes are written under the temp name
   * first — whereas O_EXCL creates the file and then fills it, so a racing
   * reader can observe an empty lease and mistake it for debris. The link is
   * the correctness path; O_EXCL is the compromise for filesystems that refuse.
   */
  const root = workspace();
  const clock = fakeClock();
  const calls = [];
  const spy = (from, to) => { calls.push({ from, to }); return linkSync(from, to); };

  const got = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock, linkImpl: spy });
  assert.equal(got.ok, true, got.error);
  assert.equal(calls.length, 1, 'the default publish did not go through linkImpl at all');
  assert.ok(calls[0].to.endsWith('.json'), `the link must publish the record itself: ${calls[0].to}`);
  assert.ok(calls[0].from.startsWith(calls[0].to), `the source must be a sibling temp, not the record: ${calls[0].from}`);

  // …and the bytes were complete BEFORE the link, which is the property we buy.
  const raw = readFileSync(calls[0].to, 'utf8');
  assert.equal(JSON.parse(raw).holder, 't1', 'the published file was not whole at link time');
  rmSync(root, { recursive: true, force: true });
});

test('⭐ a path whose FILE DOES NOT EXIST YET is leasable — you lease intent, not inodes', () => {
  /**
   * ⚠️ A CHECK THAT FAILS CORRECT WORK IS WORSE THAN NO CHECK. The obvious
   * "validate the path" reflex is to stat it, which would refuse to lease every
   * file an agent is about to CREATE — and creating files is most of what these
   * terminals do. Two agents racing to create the same new module is precisely
   * the collision this module exists to stop, so it must be leasable.
   */
  const root = workspace();
  const clock = fakeClock();
  const got = acquire(root, { path: 'src/does/not/exist/yet.ts', holder: 't1', pid: 111, clock });
  assert.equal(got.ok, true, `a not-yet-created file must be leasable: ${got.error}`);
  assert.equal(existsSync(join(root, 'src/does/not/exist/yet.ts')), false, 'leasing must not create the file');

  const denied = acquire(root, { path: 'src/does/not/exist/yet.ts', holder: 't2', pid: 222, clock });
  assert.equal(denied.ok, false, 'and it must be exclusive like any other path');
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ inspect ignores the gate and staging files — they are activity, not debris', () => {
  /**
   * A `.claim` gate or a `.tmp-` staging file means another terminal is mid
   * write. Counting either as a corrupt lease would make `acuvo leases` scream
   * at the exact moment the system is working correctly.
   */
  const root = workspace();
  const clock = fakeClock();
  acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock });
  const dir = leaseDirOf(root);
  writeFileSync(join(dir, 'abc123.json.claim'), '4242\n', 'utf8');
  writeFileSync(join(dir, 'abc123.json.tmp-4242'), '{}', 'utf8');

  const view = inspect(root, { clock });
  assert.equal(view.ok, true);
  assert.equal(view.leases.length, 1);
  assert.equal(view.corrupt, 0, `gate and temp files were miscounted as corrupt: ${view.warnings.join('|')}`);
  assert.deepEqual(view.warnings, []);
  rmSync(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. MANY PATHS AT ONCE — all or nothing
// ═══════════════════════════════════════════════════════════════════════════

test('acquireAll takes every path or none of them', () => {
  const root = workspace();
  const clock = fakeClock();
  writeFileSync(join(root, 'src', 'b.ts'), 'x\n', 'utf8');
  assert.equal(acquire(root, { path: 'src/b.ts', holder: 'other', pid: 999, clock }).ok, true);

  const got = acquireAll(root, { paths: ['src/app.ts', 'src/b.ts'], holder: 't1', pid: 111, clock });
  assert.equal(got.ok, false, 'a partial hold is a deadlock waiting to happen');
  assert.equal(got.heldBy, 'other');
  assert.equal(got.path, 'src/b.ts');
  assert.deepEqual(got.leases, [], 'the rollback must hand back nothing');
  assert.equal(leaseFiles(root).length, 1, 'src/app.ts must have been rolled back, not left held');
  rmSync(root, { recursive: true, force: true });
});

test('acquireAll dedupes and orders paths, so two terminals cannot deadlock on each other', () => {
  const root = workspace();
  const clock = fakeClock();
  writeFileSync(join(root, 'src', 'b.ts'), 'x\n', 'utf8');

  const got = acquireAll(root, { paths: ['src/b.ts', 'src/app.ts', './src/b.ts'], holder: 't1', pid: 111, clock });
  assert.equal(got.ok, true, got.error);
  assert.deepEqual(got.leases.map((l) => l.path), ['src/app.ts', 'src/b.ts'], 'a fixed global order is what makes lock-ordering deadlock impossible');
  assert.equal(leaseFiles(root).length, 2);

  const beats = renewAll(got.leases, { clock });
  assert.equal(beats.ok, true);
  assert.equal(beats.renewed, 2);

  const freed = releaseAll(got.leases);
  assert.equal(freed.released, 2);
  assert.deepEqual(leaseFiles(root), []);
  rmSync(root, { recursive: true, force: true });
});

test('acquireAll with an unleasable path refuses before writing anything', () => {
  const root = workspace();
  const clock = fakeClock();
  const got = acquireAll(root, { paths: ['src/app.ts', '../escape.ts'], holder: 't1', pid: 111, clock });
  assert.equal(got.ok, false);
  assert.deepEqual(leaseFiles(root), [], 'a bad path in the list must not leave the good ones held');
  rmSync(root, { recursive: true, force: true });
});

test('renewAll reports the ones it lost rather than an all-or-nothing lie', () => {
  const root = workspace();
  const clock = fakeClock();
  writeFileSync(join(root, 'src', 'b.ts'), 'x\n', 'utf8');
  const got = acquireAll(root, { paths: ['src/app.ts', 'src/b.ts'], holder: 't1', pid: 111, ttlMs: 10_000, clock });

  release(got.leases[0]); // something else cleaned one up
  const beats = renewAll(got.leases, { clock });
  assert.equal(beats.ok, false);
  assert.equal(beats.renewed, 1);
  assert.equal(beats.lost.length, 1);
  assert.equal(beats.lost[0].path, 'src/app.ts');
  rmSync(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. INSPECT — who holds what, and is it stale
// ═══════════════════════════════════════════════════════════════════════════

test('inspect on a fresh workspace is empty and ok, not an error', () => {
  const root = workspace();
  const view = inspect(root, { clock: fakeClock() });
  assert.equal(view.ok, true);
  assert.deepEqual(view.leases, []);
  assert.deepEqual(view.warnings, []);
  rmSync(root, { recursive: true, force: true });
});

test('inspect classifies live, expired and reclaimable, sorted by path', () => {
  const root = workspace();
  const clock = fakeClock();
  writeFileSync(join(root, 'src', 'b.ts'), 'x\n', 'utf8');
  writeFileSync(join(root, 'zz.ts'), 'x\n', 'utf8');

  acquire(root, { path: 'zz.ts', holder: 'live', pid: 111, ttlMs: 600_000, clock });
  acquire(root, { path: 'src/app.ts', holder: 'quiet', pid: 222, ttlMs: 10_000, clock });
  acquire(root, { path: 'src/b.ts', holder: 'dead', pid: 333, ttlMs: 1_000, clock });

  // 35s of silence: past the 10s TTL (expired, not yet takeable) and past the
  // 1s TTL + its 30s grace (takeable), while the 10-minute lease is untouched.
  clock.advance(35_000);
  const view = inspect(root, { clock });
  assert.equal(view.ok, true);
  assert.deepEqual(view.leases.map((l) => l.path), ['src/app.ts', 'src/b.ts', 'zz.ts']);

  const by = Object.fromEntries(view.leases.map((l) => [l.holder, l]));
  assert.equal(by.live.state, 'live');
  assert.equal(by.quiet.state, 'expired', '10s TTL, 35s of silence — expired but not yet takeable');
  assert.equal(by.dead.state, 'reclaimable');
  assert.equal(by.live.ageMs, 35_000);
  assert.ok(by.quiet.reclaimableInMs > 0);
  assert.equal(by.dead.reclaimableInMs, 0);
  rmSync(root, { recursive: true, force: true });
});

test('inspect reports a corrupt lease file instead of throwing over it', () => {
  const root = workspace();
  const clock = fakeClock();
  acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock });
  writeFileSync(join(leaseDirOf(root), 'deadbeefdeadbeefdead.json'), '{ not json', 'utf8');

  const view = inspect(root, { clock });
  assert.equal(view.ok, true);
  assert.equal(view.leases.length, 1, 'the readable lease must still be listed');
  assert.equal(view.corrupt, 1);
  assert.ok(view.warnings.some((w) => /corrupt/i.test(w)), view.warnings.join('|'));
  rmSync(root, { recursive: true, force: true });
});

test('formatLeaseSummary renders holders, states and the takeover, and never throws on empty', () => {
  const root = workspace();
  const clock = fakeClock();
  acquire(root, { path: 'src/app.ts', holder: 'crashed', pid: 111, ttlMs: 10_000, clock });
  clock.advance(reclaimableAfter(10_000) + 1);
  acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, ttlMs: 10_000, clock });

  const text = formatLeaseSummary(inspect(root, { clock })).join('\n');
  assert.ok(text.includes('src/app.ts'), text);
  assert.ok(text.includes('t2'), text);
  assert.ok(/took over|takeover/i.test(text), `a takeover must be visible in the summary: ${text}`);

  const empty = formatLeaseSummary(inspect(mkdtempSync(join(tmpdir(), 'acuvo-lease-empty-')), { clock })).join('\n');
  assert.ok(/no (file )?leases|nothing/i.test(empty), empty);
  rmSync(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. THE DISCIPLINE TESTS
// ═══════════════════════════════════════════════════════════════════════════

test('⚠️ the module has no ambient clock and no randomness in its logic', () => {
  const src = readFileSync(join(ROOT, 'lib/lease.mjs'), 'utf8');
  const nows = src.match(/Date\.now\(/g) ?? [];
  assert.equal(nows.length, 1, `Date.now() may appear ONCE, as the default clock. Found ${nows.length}.`);
  assert.ok(/const wallClock = \(\) => Date\.now\(\);/.test(src), 'the single Date.now must be the named default clock');
  assert.deepEqual(src.match(/Math\.random\(/g) ?? [], [], 'randomness makes a lease untestable and a token unreproducible');
});

test('a token is derived, not random — same clock and pid, reproducible lease', () => {
  const a = workspace();
  const b = workspace();
  const one = acquire(a, { path: 'src/app.ts', holder: 't1', pid: 111, clock: fakeClock() });
  const two = acquire(b, { path: 'src/app.ts', holder: 't1', pid: 111, clock: fakeClock() });
  assert.equal(one.lease.token, two.lease.token, 'a token must be a pure function of holder, pid, clock and a counter');
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test('REGISTRATION_SNIPPET names the real exports, so wiring is copy-paste', () => {
  for (const needle of ['lib/lease.mjs', 'acquireAll', 'releaseAll', 'renewAll', 'inspect']) {
    assert.ok(REGISTRATION_SNIPPET.includes(needle), `the snippet never mentions ${needle}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. ⭐⭐ THE ONLY HONEST PROOF: REAL PROCESSES, REALLY RACING
// ═══════════════════════════════════════════════════════════════════════════

const RACERS = 8;

const WORKER = `
const [, , root, path, holder, pid, barrierDir, racers, fixedNow, noLink] = process.argv;
const { writeFileSync, readdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { acquire } = await import(${JSON.stringify(LEASE_URL)});

/**
 * ⚠️⚠️ A REAL BARRIER, NOT A GUESSED DEADLINE.
 *
 * The original alignment was "spin until an agreed wall-clock instant 400ms
 * from now". MEASURED on this machine: all 24 sampled children reached that
 * instant AFTER it had already passed — every one of them late, at windows of
 * 400ms, 800ms and 1200ms. Eight node processes do not start within any fixed
 * budget, so the children ran essentially sequentially: the first took the
 * lease, the rest read a held record, and the test PASSED without a race ever
 * happening. It proved nothing, and mutation testing caught it — breaking the
 * exclusive create survived the suite about half the time.
 *
 * ⭐ The fix is to synchronise on a fact instead of a forecast. Each child
 * announces itself and then spins until every sibling has announced, so the
 * last one to boot releases them all. By then every process is hot, the module
 * is imported, and they enter acquire() within microseconds of each other.
 */
writeFileSync(join(barrierDir, holder), 'ready');
while (readdirSync(barrierDir).length < Number(racers)) { /* every sibling must be hot */ }

const clock = fixedNow ? () => Number(fixedNow) : undefined;
// ⭐ A filesystem that refuses hard links, simulated in a REAL child process —
// the only way to race the O_EXCL fallback, since a function cannot be spawned.
const linkImpl = noLink ? () => { const e = new Error('no links here'); e.code = 'EPERM'; throw e; } : undefined;
const got = acquire(root, {
  path, holder, pid: Number(pid), ttlMs: 60000,
  ...(clock ? { clock } : {}),
  ...(linkImpl ? { linkImpl } : {}),
});
process.stdout.write(JSON.stringify({
  holder,
  ok: got.ok === true,
  heldBy: got.heldBy ?? null,
  error: got.error ?? null,
  takeover: got.takeover ? got.takeover.from : null,
}));
`;

function raceForLease(root, { fixedNow = '', noLink = '' } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'acuvo-lease-worker-'));
  const worker = join(scratch, 'racer.mjs');
  writeFileSync(worker, WORKER, 'utf8');
  // ⚠️ The barrier lives OUTSIDE the workspace, or its files would show up in
  // every `leaseFiles(root)` assertion as litter that is not litter.
  const barrierDir = join(scratch, 'barrier');
  mkdirSync(barrierDir, { recursive: true });

  const runs = Array.from({ length: RACERS }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, root, 'src/app.ts', `t${i}`, String(9000 + i), barrierDir, String(RACERS), fixedNow, noLink], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      try { resolve(JSON.parse(out)); } catch { resolve({ holder: `t${i}`, ok: false, crashed: `${err || out}`.slice(0, 400) }); }
    });
  }));

  return Promise.all(runs).finally(() => rmSync(scratch, { recursive: true, force: true }));
}

test(`⭐⭐ ${RACERS} real processes race for one file — exactly one wins`, async () => {
  const root = workspace();
  const results = await raceForLease(root);

  const crashed = results.filter((r) => r.crashed);
  assert.deepEqual(crashed, [], `a racer crashed instead of being refused: ${JSON.stringify(crashed)}`);

  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, `expected 1 winner, got ${winners.length}: ${JSON.stringify(results)}`);
  assert.equal(leaseFiles(root).length, 1, 'one file, one lease record');

  for (const loser of results.filter((r) => !r.ok)) {
    assert.equal(loser.heldBy, winners[0].holder, `a loser was told the wrong holder: ${JSON.stringify(loser)}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test(`⭐⭐ ${RACERS} real processes race to RECLAIM one stale lease — exactly one takes it`, async () => {
  const root = workspace();
  const clock = fakeClock(1_000);
  acquire(root, { path: 'src/app.ts', holder: 'crashed-terminal', pid: 4242, ttlMs: 10_000, clock });

  // Every child sees the same "now", far past the reclaim boundary.
  const results = await raceForLease(root, { fixedNow: String(1_000 + reclaimableAfter(10_000) + 5_000) });

  const crashed = results.filter((r) => r.crashed);
  assert.deepEqual(crashed, [], `a racer crashed during takeover: ${JSON.stringify(crashed)}`);

  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, `two agents took over the same stale lease: ${JSON.stringify(results)}`);
  assert.equal(winners[0].takeover, 'crashed-terminal', 'the winner must record who it took the lease from');
  assert.equal(leaseFiles(root).length, 1, `takeover litter: ${leaseFiles(root).join(', ')}`);
  rmSync(root, { recursive: true, force: true });
});

test(`⭐⭐ ${RACERS} real processes race WITHOUT hard links — the O_EXCL fallback must be exclusive too`, async () => {
  /**
   * ⚠️ ADDED AFTER MUTATION TESTING. Downgrading the fallback's `wx` flag to a
   * plain overwrite — which lets every process "win" — survived the whole
   * suite, because the only test touching the fallback was single-process and
   * sequential, where the refusal comes from the READ and never reaches the
   * write at all. The fallback's exclusivity was asserted nowhere.
   *
   * ⭐ The child processes are real, so `linkImpl` cannot be a function passed
   * in — each child builds its own throwing one from argv. That is the only way
   * to race a code path that a single process can never race.
   */
  const root = workspace();
  const results = await raceForLease(root, { noLink: '1' });

  const crashed = results.filter((r) => r.crashed);
  assert.deepEqual(crashed, [], `a racer crashed on the fallback path: ${JSON.stringify(crashed)}`);

  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, `the O_EXCL fallback let ${winners.length} processes hold one file: ${JSON.stringify(results)}`);
  assert.equal(leaseFiles(root).length, 1, `fallback litter: ${leaseFiles(root).join(', ')}`);

  const record = JSON.parse(readFileSync(join(leaseDirOf(root), leaseFiles(root)[0]), 'utf8'));
  assert.equal(record.holder, winners[0].holder, 'the file on disk must belong to the process that was told it won');
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ a takeover refuses while another terminal holds the gate — the gate is not decoration', () => {
  /**
   * ⚠️ ADDED AFTER MUTATION TESTING. Every replacement of an existing record is
   * serialised behind an exclusively-created `.claim` gate, and nothing proved
   * the gate was ever consulted. Here the gate is held by hand, so a takeover
   * that ignored it would sail through and hand out a second copy of the file.
   */
  const root = workspace();
  const clock = fakeClock();
  acquire(root, { path: 'src/app.ts', holder: 'crashed', pid: 111, ttlMs: 10_000, clock });
  clock.advance(reclaimableAfter(10_000) + 1);

  const gate = `${leaseFilePath(root, 'src/app.ts').absolute}.claim`;
  writeFileSync(gate, '4242\n', 'utf8');

  const blocked = acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock });
  assert.equal(blocked.ok, false, 'a takeover ran straight through a held gate');
  assert.equal(blocked.heldBy, 'crashed', 'and it should still say who is on the record');

  const record = JSON.parse(readFileSync(join(leaseDirOf(root), leaseFiles(root)[0]), 'utf8'));
  assert.equal(record.holder, 'crashed', 'the blocked takeover must not have written anything');

  // …and once the gate clears, the same call succeeds. A gate that never opens
  // is a deadlock, which is the failure mode this whole module is avoiding.
  rmSync(gate, { force: true });
  const taken = acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock });
  assert.equal(taken.ok, true, `the gate never opened: ${taken.error}`);
  assert.equal(taken.takeover.from, 'crashed');
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ a record that parses but is missing a field is corrupt, not a lock', () => {
  /**
   * ⚠️ ADDED AFTER MUTATION TESTING. The corrupt-file cases above are all caught
   * by earlier guards (bad JSON, wrong version, empty holder), so deleting the
   * later field checks changed nothing and survived. A crash mid-format is the
   * realistic way a record loses one field while still parsing.
   */
  const root = workspace();
  const clock = fakeClock();
  const file = leaseFilePath(root, 'src/app.ts');
  mkdirSync(dirname(file.absolute), { recursive: true });

  const whole = {
    version: LEASE_VERSION, path: 'src/app.ts', key: 'src/app.ts', holder: 'ghost',
    pid: 111, token: 'abc', ttlMs: 10_000, acquiredAt: 1, renewedAt: 1, takeovers: [],
  };
  for (const missing of ['takeovers', 'pid', 'token', 'key', 'ttlMs', 'renewedAt', 'acquiredAt']) {
    const partial = { ...whole };
    delete partial[missing];
    writeFileSync(file.absolute, JSON.stringify(partial), 'utf8');

    const got = acquire(root, { path: 'src/app.ts', holder: 't1', pid: 111, clock });
    assert.equal(got.ok, true, `a record missing "${missing}" blocked the path: ${got.error}`);
    assert.ok(got.warnings.some((w) => /corrupt/i.test(w)), `missing "${missing}" was taken silently: ${got.warnings}`);
    release(got.lease);
  }
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ a lease whose timestamps are in the FUTURE is not silently immortal', () => {
  /**
   * A clock skew between two machines sharing a checkout, or a record written
   * before the system clock was set, makes `now - renewedAt` negative. That is
   * "live" under any naive comparison — for ever. It should read as live (we
   * cannot prove the holder is gone) but it must never read as reclaimable,
   * and inspect must not report a nonsense negative age as an error.
   */
  const root = workspace();
  const clock = fakeClock(1_000_000);
  acquire(root, { path: 'src/app.ts', holder: 'future', pid: 111, ttlMs: 10_000, clock });

  clock.set(500_000); // the clock went backwards
  const denied = acquire(root, { path: 'src/app.ts', holder: 't2', pid: 222, clock });
  assert.equal(denied.ok, false, 'a future-dated lease was reclaimed — clock skew must not unlock files');
  assert.equal(denied.heldBy, 'future');

  const view = inspect(root, { clock });
  assert.equal(view.ok, true);
  assert.equal(view.leases[0].state, 'live');
  assert.ok(Number.isFinite(view.leases[0].silentForMs), 'the summary must still be renderable');
  assert.doesNotThrow(() => formatLeaseSummary(view));
  rmSync(root, { recursive: true, force: true });
});

test('⚠️ the module source is plain text — a raw NUL byte makes the file "binary" to every tool', () => {
  /**
   * ⚠️ CAUGHT BY MUTATION TESTING, not by any assertion. The token separator
   * below is a NUL, which is correct, but writing it as a raw byte instead of
   * an escape made `lib/lease.mjs` grep as "Binary file matches" — so every
   * search, diff and review of this file silently stopped showing content.
   * The behaviour was right and the file was unreadable.
   */
  const src = readFileSync(join(ROOT, 'lib/lease.mjs'), 'utf8');
  assert.equal(src.split(String.fromCharCode(0)).length - 1, 0, 'a raw NUL byte is in the source — write it as an escape');
  const escaped = String.fromCharCode(92) + 'u0000';
  assert.ok(src.includes(escaped), 'the token separator should still be a NUL, written as an escape');
});

test('⭐ the token separator prevents an ambiguity two different leases could share', () => {
  /**
   * Joining the token inputs with a SPACE looks harmless until the inputs
   * contain one. path "a" + holder "b c" and path "a b" + holder "c" both
   * flatten to the same string, so two genuinely different leases would claim
   * the same proof of ownership — and a token is the only thing `renew` and
   * `release` trust. NUL cannot occur in a path or a holder name, so it is the
   * one separator that cannot be smuggled through.
   */
  const one = workspace();
  const two = workspace();
  writeFileSync(join(one, 'a'), 'x\n', 'utf8');
  writeFileSync(join(two, 'a b'), 'x\n', 'utf8');

  const left = acquire(one, { path: 'a', holder: 'b c', pid: 111, clock: fakeClock() });
  const right = acquire(two, { path: 'a b', holder: 'c', pid: 111, clock: fakeClock() });

  assert.equal(left.ok, true, left.error);
  assert.equal(right.ok, true, right.error);
  assert.notEqual(left.lease.token, right.lease.token, 'two different leases derived the same ownership token');
  rmSync(one, { recursive: true, force: true });
  rmSync(two, { recursive: true, force: true });
});

test('⚠️ REGISTRATION_SNIPPET is COPY-PASTEABLE code, not prose that looks like code', () => {
  /**
   * ⚠️ THIS CAUGHT A REAL BUG IN ITSELF. The snippet is built inside a template
   * literal, so an escape written once instead of twice turned every '\n' in
   * the sample code into an actual line break — splitting string literals
   * across lines and making the whole snippet a syntax error the moment anyone
   * pasted it. It still LOOKED like working code in every review.
   *
   * ⭐ The wiring instructions are this module's real deliverable (a module
   * nobody imports is not a feature), so they get a test like everything else.
   */
  const lines = REGISTRATION_SNIPPET.split('\n');
  for (const [i, line] of lines.entries()) {
    // ⚠️ COMMENTS ARE EXEMPT, and finding that out is the point of rule 5 in
    // this package: the first version of this check failed on "the executor's
    // write path", which is correct English in a comment. A check that fails
    // correct work would have been quietly deleted by whoever hit it next.
    if (line.trim().startsWith('//')) continue;
    const quotes = (line.match(/'/g) ?? []).length;
    assert.equal(quotes % 2, 0, `line ${i + 1} has an unterminated string literal: ${line}`);
  }

  // The code half must parse. Comments, the import and the top-level returns
  // are stripped so the remainder can be checked as a function body.
  const body = lines
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('import '))
    .join('\n')
    .replace(/return EXIT_(OK|FAILED);/g, 'return 0;');
  assert.doesNotThrow(
    () => new Function('opts', 'root', 'EXIT_OK', 'EXIT_FAILED', 'acquireAll', 'renewAll', 'releaseAll', 'inspect', 'formatLeaseSummary', body),
    'the wiring snippet is not valid JavaScript',
  );

  /**
   * ⚠️ AND THE IMPORT LINE MUST BE COMPLETE. Checking that the snippet merely
   * MENTIONS a name somewhere passes even when that name was dropped from the
   * import — which is a ReferenceError the instant anyone pastes it, and the
   * single most likely way this wiring gets shipped broken.
   */
  const importLine = lines.find((l) => l.trim().startsWith('import '));
  assert.ok(importLine, 'the snippet must show the import');
  const imported = importLine.slice(importLine.indexOf('{') + 1, importLine.indexOf('}')).split(',').map((s) => s.trim());

  for (const name of imported) {
    assert.ok(exportNames.includes(name), `the snippet imports "${name}", which lib/lease.mjs does not export`);
  }
  for (const name of exportNames) {
    if (typeof leaseModule[name] !== 'function') continue;
    if (!new RegExp(`\\b${name}\\(`).test(body)) continue;
    assert.ok(imported.includes(name), `the snippet calls ${name}() but never imports it — pasting this throws ReferenceError`);
  }
});
