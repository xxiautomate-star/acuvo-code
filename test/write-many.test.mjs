/**
 * ── ⭐⭐ THE BULK EDIT WAS ALREADY HAPPENING, JUST NOT WHERE ANYTHING SAW IT ──
 *
 * Measured 2026-08-13: told to add a parameter to 45 modules, the agent did NOT
 * call `write_file` 45 times. It wrote a loop inside `evaluate` and did all 45
 * in one call, correctly, in six rounds. That is the right instinct — and every
 * accounting mechanism here was blind to it: no `mutated` flag (the run said
 * "No files changed"), no lease claim, no collision detection, no credential
 * gate.
 *
 * `write_files` is that operation through `executor.writeFile`, so the
 * effective technique and the governed technique become the same technique.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeMany, formatWriteMany, MAX_FILES } from '../lib/write-many.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { createPathClaimer } from '../lib/auto-lease.mjs';
import { executeToolCall } from '../lib/tools.mjs';

const made = [];
const ws = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), 'acuvo-wm-')); made.push(d); return d; };
const cleanup = () => { for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows */ } } };

test('several files land in one call', (t) => {
  t.after(cleanup);
  const root = ws();
  const r = writeMany(createLocalExecutor(root), {
    files: [
      { path: 'src/a.js', content: 'export const a = 1;\n' },
      { path: 'src/b.js', content: 'export const b = 2;\n' },
      { path: 'src/c.js', content: 'export const c = 3;\n' },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.written.length, 3);
  assert.equal(readFileSync(join(root, 'src/b.js'), 'utf8'), 'export const b = 2;\n');
});

test('⭐⭐ THE WHOLE POINT: leases are enforced, because this IS the single-file path', (t) => {
  t.after(cleanup);
  const root = ws();
  const other = createPathClaimer(root, { holder: 'terminal-1' });
  other.claim('src/held.js');

  const mine = createPathClaimer(root, { holder: 'terminal-2' });
  const executor = createLocalExecutor(root, { claimPath: (p) => mine.claim(p) });

  const r = writeMany(executor, {
    files: [
      { path: 'src/free.js', content: 'ok\n' },
      { path: 'src/held.js', content: 'clobber\n' },
    ],
  });

  assert.equal(r.written.length, 1, 'the unheld file must still land');
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].error, /terminal-1/, 'a bulk write must be refused on a held path, exactly like a single one');
  assert.equal(existsSync(join(root, 'src/held.js')), false, 'and nothing may have been written to it');
  other.releaseAll(); mine.releaseAll();
});

test('⭐ partial success is REPORTED, not rolled back', (t) => {
  t.after(cleanup);
  const root = ws();
  const other = createPathClaimer(root, { holder: 't1' });
  other.claim('src/b.js');
  const mine = createPathClaimer(root, { holder: 't2' });

  const r = writeMany(createLocalExecutor(root, { claimPath: (p) => mine.claim(p) }), {
    files: [
      { path: 'src/a.js', content: 'a\n' },
      { path: 'src/b.js', content: 'b\n' },
      { path: 'src/c.js', content: 'c\n' },
    ],
  });
  /**
   * A rollback would need to restore files this call may have just created, in
   * a workspace another terminal may be writing to — a second, more dangerous
   * write path invented to tidy the failure of the first.
   */
  assert.equal(r.ok, true, 'two files really landed; saying otherwise would make the model redo them');
  assert.deepEqual(r.written.map((f) => f.path).sort(), ['src/a.js', 'src/c.js']);
  assert.match(formatWriteMany(r), /still need doing/, 'the model must be told exactly what to retry');
  other.releaseAll(); mine.releaseAll();
});

test('⚠️ nothing landing is ok:false — the model must react, not continue', (t) => {
  t.after(cleanup);
  const root = ws();
  const other = createPathClaimer(root, { holder: 't1' });
  other.claim('src/only.js');
  const mine = createPathClaimer(root, { holder: 't2' });

  const r = writeMany(createLocalExecutor(root, { claimPath: (p) => mine.claim(p) }), {
    files: [{ path: 'src/only.js', content: 'x\n' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /no file was written/);
  other.releaseAll(); mine.releaseAll();
});

test('⚠️ THE SAME PATH TWICE IS A MISTAKE — one content would silently win', (t) => {
  t.after(cleanup);
  const root = ws();
  const r = writeMany(createLocalExecutor(root), {
    files: [{ path: 'src/a.js', content: 'first\n' }, { path: 'src/a.js', content: 'second\n' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /appears twice/);
  assert.equal(existsSync(join(root, 'src/a.js')), false, 'and it must be caught BEFORE anything is written');
});

test('⚠️ a malformed entry is caught before ANY file is written', (t) => {
  t.after(cleanup);
  const root = ws();
  const r = writeMany(createLocalExecutor(root), {
    files: [{ path: 'src/good.js', content: 'ok\n' }, { path: 'src/bad.js' }],
  });
  assert.equal(r.ok, false);
  assert.equal(existsSync(join(root, 'src/good.js')), false,
    'half-applied plus an error saying nothing happened is the worst of both answers');
});

test('bounds are refused with the reason', (t) => {
  t.after(cleanup);
  const root = ws();
  const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `src/f${i}.js`, content: 'x' }));
  assert.match(writeMany(createLocalExecutor(root), { files: many }).error, new RegExp(`over the ${MAX_FILES} limit`));
  assert.match(writeMany(createLocalExecutor(root), { files: [] }).error, /non-empty/);
});

test('⭐⭐ END TO END: the dispatcher marks it mutated, so the change count sees it', async (t) => {
  t.after(cleanup);
  const root = ws();
  const call = {
    id: '1',
    function: {
      name: 'write_files',
      arguments: JSON.stringify({ files: [{ path: 'a.js', content: 'a\n' }, { path: 'b.js', content: 'b\n' }] }),
    },
  };
  const rec = await executeToolCall(call, createLocalExecutor(root), {});
  assert.equal(rec.result.ok, true);
  assert.equal(rec.mutated, true,
    'unmutated is exactly how `evaluate` made 45 writes invisible — the whole reason this tool exists');
});
