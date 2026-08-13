/**
 * Automatic leasing on the write path — the difference between `--lease` being
 * a DECLARATION and being a GUARANTEE.
 *
 * ⚠️ The dangerous half of this feature is not the refusal, it is the wrong
 * refusal: a guard here can stop the agent writing files at all, which is the
 * entire product. Most of this file is about NOT refusing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPathClaimer } from '../lib/auto-lease.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const made = [];
function ws() {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'acuvo-autolease-'));
  made.push(d);
  mkdirSync(join(d, 'src'), { recursive: true });
  return d;
}
const cleanup = () => { for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows */ } } };

// ─────────────────────────────────────────────────────────────────────────────
// THE POINT: a second terminal cannot silently overwrite the first
// ─────────────────────────────────────────────────────────────────────────────

test('⭐⭐ a write is REFUSED while another terminal holds that path', (t) => {
  t.after(cleanup);
  const root = ws();
  const first = createPathClaimer(root, { holder: 'terminal-1' });
  assert.equal(first.claim('src/app.ts').ok, true);

  const second = createPathClaimer(root, { holder: 'terminal-2' });
  const denied = second.claim('src/app.ts');

  assert.equal(denied.ok, false, 'the second terminal must not be allowed to write a file the first is writing');
  assert.equal(denied.heldBy, 'terminal-1');
  assert.match(denied.error, /terminal-1/, 'a refusal that does not name the holder cannot be acted on');
  assert.match(denied.error, /acuvo leases/, 'and it must say how to find out more');
  first.releaseAll();
});

test('⭐ a DIFFERENT file is allowed — a repo-wide lock would idle six of seven terminals', (t) => {
  t.after(cleanup);
  const root = ws();
  const first = createPathClaimer(root, { holder: 'terminal-1' });
  assert.equal(first.claim('src/app.ts').ok, true);

  const second = createPathClaimer(root, { holder: 'terminal-2' });
  assert.equal(second.claim('src/other.ts').ok, true, 'leases are per PATH; that is the whole design');
  first.releaseAll();
  second.releaseAll();
});

test('⭐ releasing hands the path over', (t) => {
  t.after(cleanup);
  const root = ws();
  const first = createPathClaimer(root, { holder: 'terminal-1' });
  first.claim('src/app.ts');
  first.releaseAll();

  const second = createPathClaimer(root, { holder: 'terminal-2' });
  assert.equal(second.claim('src/app.ts').ok, true, 'a released path must be immediately available');
  second.releaseAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// NOT REFUSING — the half that can destroy the product
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ writing the same file twice is fine — the agent must never be blocked BY ITSELF', (t) => {
  t.after(cleanup);
  const root = ws();
  const claimer = createPathClaimer(root, { holder: 'terminal-1' });

  // A write → run → fix loop rewrites one file three or four times.
  for (let i = 0; i < 4; i++) {
    assert.equal(claimer.claim('src/app.ts').ok, true, `rewrite ${i + 1} was refused by our own lease`);
  }
  assert.deepEqual(claimer.held(), ['src/app.ts'], 'four writes must be ONE lease, not four');
  claimer.releaseAll();
});

test('⚠️⚠️ an INFRASTRUCTURE failure lets the write through — refusing correct work is worse', () => {
  /**
   * Before this module existed there was no protection at all. A broken lease
   * directory that BLOCKED every write would therefore be a strictly worse
   * product than the one that shipped without leases. We refuse only what we
   * can prove, and an acquire that failed without naming a holder proves
   * nothing about who owns the file.
   */
  const claimer = createPathClaimer('/ws', {
    acquireImpl: () => ({ ok: false, error: 'EACCES: .acuvo/leases is not writable' }),
  });
  const r = claimer.claim('src/app.ts');
  assert.equal(r.ok, true, 'a disk problem must not stop the agent writing code');
  assert.equal(r.degraded, true);
  assert.deepEqual(claimer.unprotected(), ['src/app.ts'], 'but it must be reportable — degraded is not the same as fine');
});

test('⚠️ a THROW from the lease layer is infrastructure too, never a conflict', () => {
  const claimer = createPathClaimer('/ws', {
    acquireImpl: () => { throw new Error('disk on fire'); },
  });
  const r = claimer.claim('src/app.ts');
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.match(r.reason, /disk on fire/);
});

test('a repeat claim RENEWS rather than re-acquiring — a free keepalive on the live files', () => {
  const renewed = [];
  const claimer = createPathClaimer('/ws', {
    acquireImpl: () => ({ ok: true, lease: { file: '/ws/.acuvo/leases/x', token: 't', path: 'src/app.ts' } }),
    renewImpl: (h) => { renewed.push(h); return { ok: true }; },
  });
  claimer.claim('src/app.ts');
  claimer.claim('src/app.ts');
  claimer.claim('src/app.ts');
  assert.equal(renewed.length, 2, 'the first claim acquires; every repeat must renew, so a long run keeps what it is using');
});

test('a failing renew does not block the write', () => {
  const claimer = createPathClaimer('/ws', {
    acquireImpl: () => ({ ok: true, lease: { file: '/ws/.acuvo/leases/x', token: 't' } }),
    renewImpl: () => { throw new Error('renew exploded'); },
  });
  claimer.claim('a.ts');
  assert.equal(claimer.claim('a.ts').ok, true, 'a failed keepalive is not a reason to refuse work we already own');
});

test('releaseAll never throws, because it runs from an exit handler', () => {
  const claimer = createPathClaimer('/ws', {
    acquireImpl: () => ({ ok: true, lease: { file: '/ws/.acuvo/leases/x', token: 't' } }),
    releaseImpl: () => { throw new Error('release exploded'); },
  });
  claimer.claim('a.ts');
  assert.doesNotThrow(() => claimer.releaseAll(), 'a throw here is an ugly crash on the way out of a run that succeeded');
  assert.deepEqual(claimer.held(), [], 'and it must still forget what it held');
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM — through the real executor
// ─────────────────────────────────────────────────────────────────────────────

test('⭐⭐ END TO END: the executor refuses a write on a path another terminal holds', (t) => {
  t.after(cleanup);
  const root = ws();
  const other = createPathClaimer(root, { holder: 'terminal-1' });
  assert.equal(other.claim('src/app.ts').ok, true);

  const mine = createPathClaimer(root, { holder: 'terminal-2' });
  const executor = createLocalExecutor(root, { claimPath: (p) => mine.claim(p) });

  const w = executor.writeFile('src/app.ts', 'export const x = 2;\n');
  assert.equal(w.ok, false, 'the write must be refused, not merely reported afterwards');
  assert.match(w.error, /terminal-1/);
  assert.equal(existsSync(join(root, 'src', 'app.ts')), false, 'and nothing may have been written');

  // The control: a file nobody holds still writes.
  const ok = executor.writeFile('src/mine.ts', 'export const y = 1;\n');
  assert.equal(ok.ok, true, `an unheld path must still be writable: ${ok.ok === false ? ok.error : ''}`);
  assert.equal(readFileSync(join(root, 'src', 'mine.ts'), 'utf8'), 'export const y = 1;\n');
  other.releaseAll();
  mine.releaseAll();
});

test('⭐ END TO END: delete is refused on a held path too', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'src', 'doomed.ts'), 'x\n', 'utf8');
  const other = createPathClaimer(root, { holder: 'terminal-1' });
  other.claim('src/doomed.ts');

  const mine = createPathClaimer(root, { holder: 'terminal-2' });
  const executor = createLocalExecutor(root, { claimPath: (p) => mine.claim(p) });

  const d = executor.deleteFile('src/doomed.ts');
  assert.equal(d.ok, false);
  assert.equal(existsSync(join(root, 'src', 'doomed.ts')), true, 'a refused delete must leave the file alone');
  other.releaseAll();
});

test('⚠️ WITHOUT a claimer the executor behaves exactly as it always did', (t) => {
  t.after(cleanup);
  const root = ws();
  // Somebody else holds it — and with no claimPath, nothing consults that.
  const other = createPathClaimer(root, { holder: 'terminal-1' });
  other.claim('src/app.ts');

  const executor = createLocalExecutor(root);
  const w = executor.writeFile('src/app.ts', 'unchanged behaviour\n');
  assert.equal(w.ok, true, 'the default must be byte-identical for every existing caller and test');
  other.releaseAll();
});

test('⚠️ two spellings of one path are ONE claim, not two', (t) => {
  t.after(cleanup);
  const root = ws();
  const mine = createPathClaimer(root, { holder: 'terminal-1' });
  const executor = createLocalExecutor(root, { claimPath: (p) => mine.claim(p) });

  assert.equal(executor.writeFile('src/app.ts', 'a\n').ok, true);
  assert.equal(executor.writeFile('./src/app.ts', 'b\n').ok, true, 'the second spelling must not be blocked by the first claim');
  assert.equal(mine.held().length, 1, `claimed ${JSON.stringify(mine.held())} — the executor must claim the RESOLVED path`);
  mine.releaseAll();
});
