/**
 * `read_table` sends a PDF or an image to the GPU table reader. A CSV is neither — found by
 * using it (2026-09-26): the model's first call on `sales.csv` was read_table, the GPU answered
 * UnidentifiedImageError, and the estimate was six times the run's model spend. Refused locally now.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTable } from '../lib/media.mjs';

function root(t) {
  const d = mkdtempSync(join(tmpdir(), 'acuvo-read-table-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const env = { MODAL_TABLE_READ_URL: 'https://reader.example/read', MODAL_VIDEO_SECRET: 's' };

test('a CSV is refused before anything is sent, and the model is pointed at read_file', async (t) => {
  const d = root(t);
  writeFileSync(join(d, 'sales.csv'), 'date,region,amount\n2026-01-10,NSW,12.50\n', 'utf8');
  let sent = 0;
  const out = await readTable(d, 'sales.csv', { env, fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; } });
  assert.equal(out.ok, false);
  assert.match(out.error, /plain text, not a PDF or an image/);
  assert.match(out.error, /read_file/);
  assert.equal(sent, 0, 'a text file reached the GPU');
});

test('a PNG still goes to the reader', async (t) => {
  const d = root(t);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(32)]);
  writeFileSync(join(d, 'table.png'), png);
  let sent = 0;
  await readTable(d, 'table.png', { env, fetchImpl: async () => { sent += 1; return { ok: false, status: 500, text: async () => 'x', json: async () => ({}) }; } });
  assert.equal(sent, 1);
});
