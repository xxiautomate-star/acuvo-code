/**
 * ── ⚠️⚠️ THE HARDENED EDIT EXISTS AND THE CLI DOES NOT CALL IT ──────────────
 *
 * `editFile()` in lib/edit.mjs carries a long, correct, well-argued defence
 * against exactly one bug: `readFileSync(path, 'utf8')` does not fail on invalid
 * input, it replaces every byte it cannot decode with U+FFFD, and the write-back
 * turns each one into `ef bf bd`. A latin-1 / cp1252 / Shift-JIS file comes back
 * permanently mangled with `ok: true` on top of it.
 *
 * ⚠️ THE CLI DOES NOT CALL `editFile()`. `tools.mjs` dispatches `edit_file` to
 * `editThroughExecutor()`, which reads through `executor.readFile` — and THAT is
 * still the lossy one-argument decode at lib/workspace.mjs:384. So the fix was
 * written, tested, documented at length, and routed around.
 *
 * ⭐ THIS IS THE SAME DISEASE AS THE TEN UNIMPORTED MODULES, in miniature: the
 * capability is present and the runtime path does not reach it. That is why the
 * fix belongs in the EXECUTOR and not in a second copy inside edit.mjs — every
 * caller (edit_file, read_file, and `gatherWorkspaceContext`'s pre-read of the
 * whole workspace before round 1) goes through this one door.
 *
 * ⚠️ AND THE PRE-READ IS WHY THIS IS WORSE THAN AN EDIT BUG. The gather reads
 * small files automatically, so a single cp1252 file in the workspace root feeds
 * the model mangled text it never asked for, before a token is spent — and the
 * model has no way to know the bytes it was shown are not the bytes on disk.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalExecutor } from '../lib/workspace.mjs';
import { editThroughExecutor } from '../lib/edit.mjs';

function ws() {
  return mkdtempSync(join(tmpdir(), 'acuvo-encoding-'));
}

/**
 * Real cp1252 text: "Hello <ff><fe><e9><e8>\nSECRET". `ff fe` and `e9 e8` are
 * legal cp1252 and illegal UTF-8 — the exact 17-byte fixture edit.mjs's own
 * header records as having lost four bytes forever on 2026-08-10.
 */
const CP1252 = Buffer.from('48656c6c6f20fffee9e80a534543524554', 'hex');

test('⚠️ read_file REFUSES a non-UTF-8 file instead of handing back mangled text', () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'legacy.txt'), CP1252);
    const ex = createLocalExecutor(root);
    const r = ex.readFile('legacy.txt');

    assert.equal(r.ok, false, 'a file that cannot be decoded must be refused, not silently replaced with U+FFFD');
    assert.match(
      String(r.error),
      /utf-?8|encoding|decode/i,
      'the refusal must say WHY, so the model can choose another approach rather than retrying the same read',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️⚠️ edit_file must not destroy bytes it was never asked to touch', () => {
  const root = ws();
  try {
    const file = join(root, 'legacy.txt');
    writeFileSync(file, CP1252);
    const ex = createLocalExecutor(root);

    const r = editThroughExecutor(ex, 'legacy.txt', 'SECRET', 'PUBLIC');

    assert.equal(r.ok, false, 'editing a file we cannot decode must fail loudly, never report ok:true over a mangled write');

    // ⭐ THE LOAD-BEARING ASSERTION. A refusal that still wrote is not a refusal.
    const after = readFileSync(file);
    assert.equal(
      after.equals(CP1252),
      true,
      `the file on disk was modified by a refused edit — before=${CP1252.toString('hex')} after=${after.toString('hex')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ⚠️ THE REGRESSION HALF. A guard that refuses valid work is worse than no
 * guard — this repo paid for that four times on 2026-08-10 — so every legitimate
 * shape a real repo contains has to keep working.
 */
test('valid UTF-8 still reads and edits exactly as before', () => {
  const root = ws();
  try {
    const ex = createLocalExecutor(root);

    const cases = {
      'plain.txt': 'hello SECRET world\n',
      'accents.txt': 'café — naïve — 日本語 SECRET\n',
      'emoji.txt': 'ship it 🚀 SECRET\n',
      'crlf.txt': 'line one\r\nSECRET\r\n',
      'no-trailing-newline.txt': 'SECRET',
    };
    for (const [name, body] of Object.entries(cases)) {
      writeFileSync(join(root, name), body, 'utf8');
      const read = ex.readFile(name);
      assert.equal(read.ok, true, `${name} must still be readable: ${read.error ?? ''}`);
      assert.equal(read.content, body, `${name} round-tripped wrong`);

      const edited = editThroughExecutor(ex, name, 'SECRET', 'PUBLIC');
      assert.equal(edited.ok, true, `${name} must still be editable: ${edited.error ?? ''}`);
      assert.equal(
        readFileSync(join(root, name), 'utf8'),
        body.replace('SECRET', 'PUBLIC'),
        `${name} was not edited correctly`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ⚠️ `ignoreBOM: true` IS NAMED BACKWARDS and edit.mjs says so at length: it
 * means "do NOT swallow a leading U+FEFF", i.e. keep it as an ordinary
 * character. The default strips it, which silently deletes three bytes from the
 * front of every BOM'd file on every edit — and BOM'd UTF-8 is the Windows
 * default for a great many editors.
 */
test('a UTF-8 BOM survives a read and an edit, byte for byte', () => {
  const root = ws();
  try {
    const file = join(root, 'bom.txt');
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const x = "SECRET";\n', 'utf8')]);
    writeFileSync(file, body);
    const ex = createLocalExecutor(root);

    const read = ex.readFile('bom.txt');
    assert.equal(read.ok, true, `a BOM'd UTF-8 file is valid text and must read: ${read.error ?? ''}`);

    const edited = editThroughExecutor(ex, 'bom.txt', 'SECRET', 'PUBLIC');
    assert.equal(edited.ok, true, `a BOM'd file must still be editable: ${edited.error ?? ''}`);

    const after = readFileSync(file);
    assert.equal(
      after.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
      true,
      `the BOM was eaten by the edit — file now starts ${after.subarray(0, 6).toString('hex')}`,
    );
    assert.equal(after.includes(Buffer.from('PUBLIC')), true, 'the edit did not apply');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a real binary is still refused, and by the clearer message', () => {
  const root = ws();
  try {
    // PNG magic + a NUL, i.e. both binary AND invalid UTF-8.
    writeFileSync(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
    const ex = createLocalExecutor(root);
    const r = ex.readFile('pic.png');
    assert.equal(r.ok, false);
    assert.match(String(r.error), /binary/i, '"looks binary" is the more useful sentence for a .png than "not valid UTF-8"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
