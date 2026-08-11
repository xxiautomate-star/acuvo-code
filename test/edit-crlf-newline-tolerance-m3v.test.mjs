/**
 * ── ⚠️⚠️ A MULTI-LINE EDIT MUST WORK ON A WINDOWS FILE ──────────────────────
 *
 * `applyEdit` matched `oldString` LITERALLY. A model writes multi-line
 * `old_string` with `\n`; a Windows file on disk holds `\r\n`. So the match
 * count was 0, `edit_file` refused, and the model's only remaining move was
 * `write_file` — a WHOLE-FILE REWRITE from memory.
 *
 * ⭐ That is the exact hazard `edit_file` exists to prevent, so this defect did
 * not merely block a feature: it ROUTED THE AGENT INTO THE HAZARD. And the
 * rewrite does two silent kinds of damage at once — it re-emits the file from
 * the model's memory (anything it forgot is gone) and it converts the file to
 * LF (a diff touching every line). On Windows it fired on essentially every
 * multi-line edit.
 *
 * ── ⚠️ THE THING THAT MUST NOT BE TRADED AWAY: THE FILE'S LINE ENDINGS ──────
 * A "fix" that matches CRLF by normalising the file to LF has done the same
 * damage as the bug, more quietly. So every assertion here is on the BYTES
 * (`Buffer.equals`), never on a decoded string: the bytes outside the replaced
 * span must be IDENTICAL, and the replacement must adopt the endings already in
 * use around it.
 *
 * ── ⚠️ AMBIGUITY IS A REFUSAL, NOT A GUESS ─────────────────────────────────
 * Uniqueness is a SAFETY property, not a convenience. If normalising turns a
 * previously-unique span into two matches, the edit is refused — the tolerant
 * path is not allowed to relax the one rule that stops an agent corrupting code
 * in a way that looks deliberate.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEdit, editFile, editThroughExecutor } from '../lib/edit.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

function workspace() {
  return mkdtempSync(join(tmpdir(), 'acuvo-edit-crlf-'));
}

/** Assert on bytes, and print hex on failure — a decoded string hides exactly the bug. */
function assertBytes(actual, expected, why) {
  const a = Buffer.isBuffer(actual) ? actual : Buffer.from(actual, 'utf8');
  const e = Buffer.isBuffer(expected) ? expected : Buffer.from(expected, 'utf8');
  assert.ok(a.equals(e), `${why}\n  actual   ${a.toString('hex')}\n  expected ${e.toString('hex')}`);
}

// ───────────────────────────────────────────────────────────────────────────
// THE DEFECT ITSELF
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ THE DEFECT — an LF old_string finds its span in a CRLF file', () => {
  const file = 'function go() {\r\n  return 1;\r\n}\r\n';
  const r = applyEdit(file, 'function go() {\n  return 1;\n}', 'function go() {\n  return 2;\n}');

  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assertBytes(
    r.content,
    'function go() {\r\n  return 2;\r\n}\r\n',
    'the file was CRLF and must still be CRLF — every byte outside the change identical',
  );
});

test('⭐ THE WHOLE JOB — bytes outside the replaced span are byte-for-byte identical', () => {
  // Deliberately noisy: BOM, tabs, non-ASCII, a trailing region we never touch.
  const head = '﻿// héader ünicode\r\n\tconst a = 1;\r\n';
  const span = 'function go() {\r\n\t\treturn 1;\r\n}';
  const tail = '\r\n// tail — ünchanged 日本語\r\nconst z = 9;';
  const file = head + span + tail;

  const r = applyEdit(file, 'function go() {\n\t\treturn 1;\n}', 'function go() {\n\t\treturn 2;\n}');
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);

  const out = Buffer.from(r.content, 'utf8');
  const headBytes = Buffer.from(head, 'utf8');
  const tailBytes = Buffer.from(tail, 'utf8');
  assertBytes(out.subarray(0, headBytes.length), headBytes, 'bytes BEFORE the span changed');
  assertBytes(out.subarray(out.length - tailBytes.length), tailBytes, 'bytes AFTER the span changed');
  assertBytes(r.content, head + 'function go() {\r\n\t\treturn 2;\r\n}' + tail, 'full file');
});

test('⭐ the replacement ADOPTS the file\'s endings — a new line arrives as CRLF, not LF', () => {
  const file = 'a\r\nb\r\nc\r\n';
  const r = applyEdit(file, 'a\nb', 'a\nMIDDLE\nb');
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assertBytes(r.content, 'a\r\nMIDDLE\r\nb\r\nc\r\n', 'the inserted line must be CRLF like its neighbours');
  assert.strictEqual(/(?<!\r)\n/.test(r.content), false, 'no lone LF may be introduced into a CRLF file');
});

// ───────────────────────────────────────────────────────────────────────────
// THE LEGITIMATE SHAPES A REAL REPO CONTAINS — a guard that fails correct work
// is worse than no guard.
// ───────────────────────────────────────────────────────────────────────────

test('pure LF is untouched — the literal path still handles it, byte for byte', () => {
  const file = 'function go() {\n  return 1;\n}\n';
  const r = applyEdit(file, 'function go() {\n  return 1;\n}', 'function go() {\n  return 2;\n}');
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assertBytes(r.content, 'function go() {\n  return 2;\n}\n', 'an LF file must stay LF');
});

test('⚠️ MIXED endings, LF island — a literal hit, and it must stay a literal hit', () => {
  // CRLF header, an LF island (the span), CRLF footer. This one already matched
  // literally before the fix; it is the control that proves the new path did not
  // steal work from the old one.
  const file = 'x = 1;\r\ny = 2;\r\nfunction go() {\n  return 1;\n}\r\nz = 3;\r\n';
  const r = applyEdit(file, 'function go() {\n  return 1;\n}', 'function go() {\n  return 2;\n}');
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assert.notStrictEqual(r.newlineNormalised, true, 'a literal hit must not report a normalised match');
  assertBytes(
    r.content,
    'x = 1;\r\ny = 2;\r\nfunction go() {\n  return 2;\n}\r\nz = 3;\r\n',
    'the LF island must stay LF and the CRLF surroundings must stay CRLF',
  );
});

test('⚠️⚠️ MIXED endings INSIDE the span — each line keeps the ending it had', () => {
  // The span itself straddles a CRLF line and an LF line. Collapsing it to one
  // "prevailing" ending would rewrite a line nobody asked to touch, which is the
  // same damage as the bug. Endings are reused POSITIONALLY.
  const file = 'head\r\nfunction go() {\r\n  return 1;\n}\r\ntail\r\n';
  const r = applyEdit(file, 'function go() {\n  return 1;\n}', 'function go() {\n  return 2;\n}');
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assertBytes(
    r.content,
    'head\r\nfunction go() {\r\n  return 2;\n}\r\ntail\r\n',
    'line 1 of the span was CRLF and line 2 was LF — both must come back exactly as they were',
  );
});

test('CR-only (classic Mac) — the span matches and stays CR', () => {
  const file = 'function go() {\r  return 1;\r}\rtail\r';
  const r = applyEdit(file, 'function go() {\n  return 1;\n}', 'function go() {\n  return 2;\n}');
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assertBytes(r.content, 'function go() {\r  return 2;\r}\rtail\r', 'CR-only endings must survive');
  assert.strictEqual(r.content.includes('\n'), false, 'no LF may be introduced into a CR-only file');
});

test('a BOM\'d CRLF file keeps its BOM and its CRLF', () => {
  const file = '﻿function go() {\r\n  return 1;\r\n}\r\n';
  const r = applyEdit(file, 'function go() {\n  return 1;\n}', 'function go() {\n  return 2;\n}');
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assertBytes(r.content, '﻿function go() {\r\n  return 2;\r\n}\r\n', 'BOM + CRLF must both survive');
  assert.strictEqual(Buffer.from(r.content, 'utf8').subarray(0, 3).toString('hex'), 'efbbbf', 'BOM bytes');
});

test('tabs and deep indentation are matched, not trimmed', () => {
  const file = '\t\t\t\t\t\tif (x) {\r\n\t\t\t\t\t\t\treturn 1;\r\n\t\t\t\t\t\t}\r\n';
  const r = applyEdit(
    file,
    '\t\t\t\t\t\tif (x) {\n\t\t\t\t\t\t\treturn 1;\n\t\t\t\t\t\t}',
    '\t\t\t\t\t\tif (x) {\n\t\t\t\t\t\t\treturn 2;\n\t\t\t\t\t\t}',
  );
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assertBytes(r.content, '\t\t\t\t\t\tif (x) {\r\n\t\t\t\t\t\t\treturn 2;\r\n\t\t\t\t\t\t}\r\n', 'tabs + CRLF');
});

test('no trailing newline — a span that runs to EOF still matches', () => {
  const file = 'const a = 1;\r\nconst b = 2;';
  const r = applyEdit(file, 'const a = 1;\nconst b = 2;', 'const a = 1;\nconst b = 3;');
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assertBytes(r.content, 'const a = 1;\r\nconst b = 3;', 'must not gain a trailing newline');
});

test('non-ASCII around and inside the span survives', () => {
  const file = '// 日本語 ünicode ✅\r\nconst s = "héllo";\r\nconst t = "wörld";\r\n';
  const r = applyEdit(file, 'const s = "héllo";\nconst t = "wörld";', 'const s = "héllo";\nconst t = "wörld!";');
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assertBytes(r.content, '// 日本語 ünicode ✅\r\nconst s = "héllo";\r\nconst t = "wörld!";\r\n', 'unicode');
});

test('an EMPTY file is still an honest not-found, not a crash', () => {
  const r = applyEdit('', 'a\nb', 'c\nd');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not found/i);
});

test('⚠️ a SINGLE-LINE edit is untouched by this path — behaviour identical either way', () => {
  // Present: literal hit, no normalising involved.
  const hit = applyEdit('a\r\nSECRET\r\nb\r\n', 'SECRET', 'PUBLIC');
  assert.strictEqual(hit.ok, true, `refused: ${hit.error}`);
  assertBytes(hit.content, 'a\r\nPUBLIC\r\nb\r\n', 'single-line edit in a CRLF file');
  assert.notStrictEqual(hit.newlineNormalised, true, 'a single-line edit must NOT report a normalised match');

  // Absent: still the same not-found refusal it always gave.
  const miss = applyEdit('a\r\nb\r\n', 'NOPE', 'X');
  assert.strictEqual(miss.ok, false);
  assert.match(miss.error, /not found/i);
});

// ───────────────────────────────────────────────────────────────────────────
// THE SAFETY PROPERTIES THE TOLERANT PATH MUST NOT RELAX
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ AMBIGUITY IS A REFUSAL — normalising must not silently pick a match', () => {
  // Two copies of the span, one CRLF and one CR-only. Neither matches literally;
  // BOTH match once normalised. That is ambiguous and must be refused.
  const file = 'go() {\r\n  return 1;\r\n}\r\nMID\r\ngo() {\r  return 1;\r}\r';
  const r = applyEdit(file, 'go() {\n  return 1;\n}', 'go() {\n  return 2;\n}');
  assert.strictEqual(r.ok, false, 'two normalised matches must not be applied to the first');
  assert.match(r.error, /2 times|ambiguous/i);
  assert.match(r.error, /line[- ]ending|newline|CRLF/i, 'the message must explain WHY it suddenly matched twice');
});

test('the literal ambiguity refusal is unchanged', () => {
  const r = applyEdit('return null;\nreturn null;\n', 'return null;', 'return 0;');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /appears 2 times/);
});

test('⚠️ an edit that would change NOTHING is refused, not reported as success', () => {
  // Literally different strings, semantically the same span once endings are
  // normalised. Applying it writes identical bytes — reporting ok would be a
  // lie the model builds its next step on.
  const file = 'a\r\nb\r\n';
  const r = applyEdit(file, 'a\nb', 'a\r\nb');
  assert.strictEqual(r.ok, false, 'a no-op must not report success');
  assert.match(r.error, /nothing to do|identical|no change/i);
});

test('the REVERSE direction works too — a CRLF old_string against an LF file', () => {
  const file = 'function go() {\n  return 1;\n}\n';
  const r = applyEdit(file, 'function go() {\r\n  return 1;\r\n}', 'function go() {\r\n  return 2;\r\n}');
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assertBytes(r.content, 'function go() {\n  return 2;\n}\n', 'an LF file must NOT gain CRLF');
});

test('a genuinely absent multi-line span is still refused after normalising', () => {
  const r = applyEdit('a\r\nb\r\n', 'x\ny', 'p\nq');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not found/i);
});

// ───────────────────────────────────────────────────────────────────────────
// THROUGH THE REAL DOORS — the CLI dispatches edit_file to editThroughExecutor,
// so a fix proven only on the pure function is a fix the product may not get.
// ───────────────────────────────────────────────────────────────────────────

test('⭐ editFile on a real CRLF file on disk — bytes on disk keep their CRLF', () => {
  const root = workspace();
  try {
    const original = Buffer.from('﻿function go() {\r\n\treturn 1;\r\n}\r\n// tail ü\r\n', 'utf8');
    writeFileSync(join(root, 'win.js'), original);

    const r = editFile(root, 'win.js', 'function go() {\n\treturn 1;\n}', 'function go() {\n\treturn 2;\n}');
    assert.strictEqual(r.ok, true, `refused: ${r.error}`);

    const after = readFileSync(join(root, 'win.js'));
    assertBytes(after, Buffer.from('﻿function go() {\r\n\treturn 2;\r\n}\r\n// tail ü\r\n', 'utf8'),
      'the file on disk must keep its BOM and every CRLF');
    assert.strictEqual(/(?<!\r)\n/.test(after.toString('utf8')), false, 'no LONE LF may appear in the file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐⭐ editThroughExecutor — the door the CLI actually uses', () => {
  const root = workspace();
  try {
    const original = Buffer.from('const cfg = {\r\n  retries: 1,\r\n};\r\n', 'utf8');
    writeFileSync(join(root, 'cfg.mjs'), original);
    const ex = createLocalExecutor(root);

    const r = editThroughExecutor(ex, 'cfg.mjs', 'const cfg = {\n  retries: 1,\n};', 'const cfg = {\n  retries: 5,\n};');
    assert.strictEqual(r.ok, true, `refused: ${r.error}`);

    assertBytes(readFileSync(join(root, 'cfg.mjs')), Buffer.from('const cfg = {\r\n  retries: 5,\r\n};\r\n', 'utf8'),
      'the executor path must preserve CRLF too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dryRun still writes nothing on the tolerant path', () => {
  const root = workspace();
  try {
    const original = Buffer.from('a\r\nb\r\n', 'utf8');
    writeFileSync(join(root, 'd.txt'), original);
    const r = editFile(root, 'd.txt', 'a\nb', 'a\nB', { dryRun: true });
    assert.strictEqual(r.ok, true, `refused: ${r.error}`);
    assertBytes(readFileSync(join(root, 'd.txt')), original, 'dryRun must not touch the file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
