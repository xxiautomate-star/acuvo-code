/**
 * ── ⚠️⚠️ THE HOLE IN A GUARANTEE I SHIPPED THE SAME DAY ──────────────────────
 *
 * `auto-lease.mjs` refuses a `write_file` on a path another terminal holds.
 * Proven the same day, in the same workspace:
 *
 *     terminal-1 holds src/app.ts
 *     terminal-2  write_file  -> refused, "held by terminal-1"   ✅
 *     terminal-2  evaluate    -> src/app.ts is now "CLOBBERED"   ❌
 *
 * A process can write anything the user can, so no in-process guard can prevent
 * it without removing the ability to run code. Detection is what is available,
 * and it is cheap because the only files that matter are the ones somebody
 * else has claimed — the lease directory lists exactly those.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { sep } from 'node:path';

import { snapshotForeignLeases, detectForeignChanges, formatForeignChanges } from '../lib/lease-watch.mjs';

const leasesOf = (...entries) => () => ({ ok: true, leases: entries });
const statsOf = (map) => (abs) => {
  const norm = String(abs).split(sep).join('/');
  const key = Object.keys(map).find((k) => norm.endsWith(k));
  if (!key) { const e = new Error('ENOENT'); throw e; }
  return map[key];
};

test('⭐ only OTHER terminals\' leases are watched — our own writes are the point of holding one', () => {
  const snap = snapshotForeignLeases('/ws', 'terminal-2', {
    inspectImpl: leasesOf(
      { path: 'src/app.ts', holder: 'terminal-1' },
      { path: 'src/mine.ts', holder: 'terminal-2' },
    ),
    statImpl: statsOf({ 'src/app.ts': { mtimeMs: 100, size: 10 }, 'src/mine.ts': { mtimeMs: 100, size: 10 } }),
  });
  assert.deepEqual(snap.map((s) => s.path), ['src/app.ts'],
    'watching our own lease would warn us about our own work on every command');
});

test('⭐⭐ a file another terminal holds, modified by a command, is DETECTED', () => {
  const snap = [{ path: 'src/app.ts', holder: 'terminal-1', mtimeMs: 100, size: 10 }];
  const changed = detectForeignChanges(snap, '/ws', {
    statImpl: statsOf({ 'src/app.ts': { mtimeMs: 200, size: 10 } }),
  });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].what, 'modified');
  assert.equal(changed[0].holder, 'terminal-1');
});

test('⚠️ a SAME-LENGTH edit is caught — those are the ones worth catching', () => {
  /**
   * Flipping a digit or a flag leaves the byte count identical. A size-only
   * check would miss exactly the edits that are hardest to notice by eye.
   */
  const snap = [{ path: 'src/app.ts', holder: 't1', mtimeMs: 100, size: 42 }];
  const changed = detectForeignChanges(snap, '/ws', { statImpl: statsOf({ 'src/app.ts': { mtimeMs: 101, size: 42 } }) });
  assert.equal(changed.length, 1, 'same size, new mtime — still a change');
});

test('⚠️ and a same-MTIME edit is caught too, for coarse filesystems', () => {
  const snap = [{ path: 'src/app.ts', holder: 't1', mtimeMs: 100, size: 10 }];
  const changed = detectForeignChanges(snap, '/ws', { statImpl: statsOf({ 'src/app.ts': { mtimeMs: 100, size: 99 } }) });
  assert.equal(changed.length, 1, 'same mtime, new size — still a change');
});

test('creation and deletion are changes too', () => {
  const created = detectForeignChanges(
    [{ path: 'src/new.ts', holder: 't1', mtimeMs: null, size: null }], '/ws',
    { statImpl: statsOf({ 'src/new.ts': { mtimeMs: 5, size: 5 } }) },
  );
  assert.equal(created[0].what, 'created', 'a lease can be held on a file about to be created');

  const deleted = detectForeignChanges(
    [{ path: 'src/gone.ts', holder: 't1', mtimeMs: 5, size: 5 }], '/ws',
    { statImpl: () => { throw new Error('ENOENT'); } },
  );
  assert.equal(deleted[0].what, 'deleted');
});

test('⭐ an untouched file is silent — a warning that fires always is ignored always', () => {
  const snap = [{ path: 'src/app.ts', holder: 't1', mtimeMs: 100, size: 10 }];
  const changed = detectForeignChanges(snap, '/ws', { statImpl: statsOf({ 'src/app.ts': { mtimeMs: 100, size: 10 } }) });
  assert.deepEqual(changed, []);
  assert.equal(formatForeignChanges(changed), null);
});

test('⚠️ an unreadable lease directory does not stop the run', () => {
  const snap = snapshotForeignLeases('/ws', 't1', { inspectImpl: () => { throw new Error('EACCES'); } });
  assert.deepEqual(snap, [], 'a broken smoke alarm must not condemn the building');
});

test('the warning names the file, the holder, and the limit itself', () => {
  const text = formatForeignChanges([{ path: 'src/app.ts', holder: 'terminal-1', what: 'modified' }]);
  assert.match(text, /src\/app\.ts/);
  assert.match(text, /terminal-1/);
  assert.match(text, /cannot stop code the agent runs/,
    'the message has to state the limit, or the next person re-derives it from a clobbered file');
});
