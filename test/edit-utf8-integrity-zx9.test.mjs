/**
 * ── ⚠️ AN EDIT MUST NEVER DESTROY BYTES IT DID NOT MEAN TO TOUCH ────────────
 *
 * `editFile` used to read with `readFileSync(path, 'utf8')` and write back with
 * `writeFileSync(path, ..., 'utf8')`. Any byte that is not valid UTF-8 decodes
 * to U+FFFD on the way in and is re-encoded as `ef bf bd` on the way out — so a
 * latin-1 / cp1252 / Shift-JIS source file came back mangled, permanently, and
 * the function returned `ok: true`.
 *
 * The old binary guard did not catch it: it only looks for a NUL byte, and
 * single-byte legacy encodings contain none.
 *
 * REPRODUCED 2026-08-10, twice, identically:
 *   before  48656c6c6f20fffee9e80a534543524554   (17 bytes)
 *   result  {"ok":true,"bytes":25,...,"previousBytes":25}
 *   after   48656c6c6f20efbfbdefbfbdefbfbdefbfbd0a5055424c4943
 * `ff fe e9 e8` are gone. There is no undo — the model asked to change one word
 * and got a silently corrupted file plus a success report to build on.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFile } from '../lib/edit.mjs';

function workspace() {
  return mkdtempSync(join(tmpdir(), 'acuvo-edit-utf8-'));
}

test('⚠️ a non-UTF-8 file is REFUSED, and its bytes survive untouched', () => {
  const root = workspace();
  try {
    // "Hello " + ff fe e9 e8 + "\nSECRET" — cp1252/latin-1 territory, no NUL.
    const original = Buffer.from([
      0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xff, 0xfe, 0xe9, 0xe8, 0x0a,
      0x53, 0x45, 0x43, 0x52, 0x45, 0x54,
    ]);
    writeFileSync(join(root, 'latin1.txt'), original);

    const r = editFile(root, 'latin1.txt', 'SECRET', 'PUBLIC');

    assert.strictEqual(r.ok, false, 'a lossy edit must not report success');
    assert.match(r.error, /latin1\.txt/);
    assert.match(r.error, /UTF-8/);

    const after = readFileSync(join(root, 'latin1.txt'));
    assert.ok(
      after.equals(original),
      `bytes changed: ${after.toString('hex')} !== ${original.toString('hex')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('...a lone surrogate half is caught too — the byte-count trick alone would miss it', () => {
  const root = workspace();
  try {
    // ed a0 80 is CESU-8 for an unpaired high surrogate: three bytes in, and a
    // naive `Buffer.byteLength(decoded)` round-trip check can be fooled by
    // replacement chars being three bytes as well. `fatal: true` is not.
    const original = Buffer.concat([
      Buffer.from('start '),
      Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.from(' SECRET'),
    ]);
    writeFileSync(join(root, 'surrogate.txt'), original);

    const r = editFile(root, 'surrogate.txt', 'SECRET', 'PUBLIC');

    assert.strictEqual(r.ok, false);
    assert.match(r.error, /UTF-8/);
    assert.ok(readFileSync(join(root, 'surrogate.txt')).equals(original));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('...and a dry run refuses just as loudly — the read is where the damage starts', () => {
  const root = workspace();
  try {
    const original = Buffer.from([0xe9, 0xe8, 0x20, 0x53, 0x45, 0x43, 0x52, 0x45, 0x54]);
    writeFileSync(join(root, 'dry.txt'), original);

    const r = editFile(root, 'dry.txt', 'SECRET', 'PUBLIC', { dryRun: true });

    assert.strictEqual(r.ok, false);
    assert.ok(readFileSync(join(root, 'dry.txt')).equals(original));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('previousBytes is the size that was ON DISK (a pin, not the red test)', () => {
  /**
   * ⚠️ HONEST LABEL: this one passed before the fix too, and I am leaving it in
   * as a pin rather than pretending it proved something.
   *
   * `previousBytes` used to be `Buffer.byteLength(before, 'utf8')` — a measure
   * of the decoded string, not of the file. For VALID UTF-8 those two numbers
   * can never disagree, so no passing input can separate them. The only input
   * that ever did was the lossy one (17 bytes reported as 25), and that input is
   * now refused outright — which means the wrong source is unobservable rather
   * than correct. It still moved to `raw.length`, because a field named
   * "previousBytes" should read the bytes.
   */
  const root = workspace();
  try {
    const original = Buffer.from('héllo SECRET\n', 'utf8');
    writeFileSync(join(root, 'valid.txt'), original);
    const onDisk = statSync(join(root, 'valid.txt')).size;

    const r = editFile(root, 'valid.txt', 'SECRET', 'PUBLIC');

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.previousBytes, onDisk);
    assert.strictEqual(readFileSync(join(root, 'valid.txt'), 'utf8'), 'héllo PUBLIC\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('...and ordinary UTF-8 files, BOM and emoji included, still edit normally', () => {
  const root = workspace();
  try {
    const original = Buffer.from('﻿const x = "🙂 SECRET";\n', 'utf8');
    writeFileSync(join(root, 'bom.js'), original);

    const r = editFile(root, 'bom.js', 'SECRET', 'PUBLIC');

    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(readFileSync(join(root, 'bom.js'), 'utf8'), '﻿const x = "🙂 PUBLIC";\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('...and the NUL/binary refusal is still the one that fires for real binaries', () => {
  const root = workspace();
  try {
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x53, 0x45, 0x43, 0x52, 0x45, 0x54]);
    writeFileSync(join(root, 'thing.png'), original);

    const r = editFile(root, 'thing.png', 'SECRET', 'PUBLIC');

    assert.strictEqual(r.ok, false);
    assert.match(r.error, /looks binary/);
    assert.ok(readFileSync(join(root, 'thing.png')).equals(original));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
