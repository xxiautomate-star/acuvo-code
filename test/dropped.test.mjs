/**
 * ── ⭐⭐ DROPPING A FILE INTO A TERMINAL PASTES A PATH, NOT A FILE ───────────
 *
 * `read_image`, `read_document` and `read_table` all shipped long before this,
 * so the capability was never missing. What was missing is the step the user
 * performs: dragging a screenshot onto a terminal window types a PATH STRING
 * into the command line, and nothing looked at that string. The model, which
 * cannot see, then answered about a filename.
 *
 * ⚠️ THE INTERESTING HALF OF THIS FILE IS THE NEGATIVE CASES. Finding
 * path-shaped text is easy; not finding it in ordinary prose is the job.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { candidatePaths, classifyDropped, findDropped, describeDropped, MAX_DROPPED } from '../lib/dropped.mjs';

/** A throwaway directory with real files, because existence IS the filter. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-drop-'));
  const write = (name, bytes = 32) => {
    const p = join(dir, name);
    writeFileSync(p, Buffer.alloc(bytes));
    return p;
  };
  return { dir, write };
}

/* ── the four shapes a terminal actually pastes ───────────────────────────── */

test('⭐ a bare path with no spaces — the case every naive parser gets right', () => {
  const { dir, write } = fixture();
  const p = write('shot.png');
  const r = findDropped(`what is wrong with this ${p}`, { root: dir });
  assert.deepEqual(r.attached.map((f) => f.name), ['shot.png']);
  assert.equal(r.attached[0].tool, 'read_image');
});

test('⭐⭐ "double quoted" — Windows Terminal, and it contains a SPACE', () => {
  const { dir, write } = fixture();
  const p = write('my shot.png');
  const r = findDropped(`fix this "${p}"`, { root: dir });
  assert.deepEqual(r.attached.map((f) => f.name), ['my shot.png'],
    'a parser that splits on whitespace finds neither half of this and silently attaches nothing');
});

test("⭐⭐ 'single quoted' — PowerShell", () => {
  const { dir, write } = fixture();
  const p = write('my shot.png');
  const r = findDropped(`fix this '${p}'`, { root: dir });
  assert.deepEqual(r.attached.map((f) => f.name), ['my shot.png']);
});

test('⭐⭐ backslash-escaped spaces — macOS Terminal and iTerm', () => {
  const { dir, write } = fixture();
  write('my shot.png');
  const escaped = join(dir, 'my shot.png').replace(/ /g, '\\ ');
  const r = findDropped(`look at ${escaped}`, { root: dir });
  assert.deepEqual(r.attached.map((f) => f.name), ['my shot.png']);
});

/* ── ⚠️ THE NEGATIVE CASES — not finding paths in prose ───────────────────── */

test('⚠️⚠️ ordinary prose attaches NOTHING, even when it names files', () => {
  const { dir, write } = fixture();
  write('README.md');
  write('shot.png');
  for (const task of [
    'fix the bug in the login flow',
    'update README.md with the new install steps',
    'the screenshot.png I mentioned yesterday was wrong',
    'rename shot.png to hero.png',            // ⚠️ names a REAL file — see below
  ]) {
    const r = findDropped(task, { root: dir });
    assert.deepEqual(
      r.attached.map((f) => f.name), task.includes('rename') ? ['shot.png'] : [],
      `"${task}" should not have pulled in a document`,
    );
  }
});

test('⚠️ a path that does NOT exist is never attached, however path-shaped', () => {
  const { dir } = fixture();
  const r = findDropped(`"${join(dir, 'ghost.png')}" and /nope/absent.pdf`, { root: dir });
  assert.deepEqual(r.attached, [],
    'existence on disk is the entire filter — without it every sentence becomes an attachment');
});

test('⚠️ a DIRECTORY passes every other check and is not a file', () => {
  const { dir } = fixture();
  const sub = join(dir, 'pics.png');   // a directory named like an image, deliberately
  mkdirSync(sub);
  const r = findDropped(`"${sub}"`, { root: dir });
  assert.deepEqual(r.attached, []);
});

test('⚠️ source files are NOT attached — the model can already open those itself', () => {
  const { dir, write } = fixture();
  write('index.ts');
  write('data.json');
  const r = findDropped(`"${join(dir, 'index.ts')}" "${join(dir, 'data.json')}"`, { root: dir });
  assert.deepEqual(r.attached, [],
    'attach what the model CANNOT reach on its own; it has read_file and the repo map for the rest');
});

/* ── ⚠️ ceilings, and saying so ───────────────────────────────────────────── */

test('⚠️ a folder drop is one gesture and many paths — the extras are REPORTED', () => {
  const { dir, write } = fixture();
  const paths = [];
  for (let i = 0; i < MAX_DROPPED + 3; i += 1) paths.push(write(`s${i}.png`));
  const r = findDropped(paths.map((p) => `"${p}"`).join(' '), { root: dir });
  assert.equal(r.attached.length, MAX_DROPPED);
  assert.equal(r.overflow, 3);
  assert.match(describeDropped(r), /further dropped file\(s\) were not attached/);
});

test('⚠️⚠️ an oversized file is SKIPPED OUT LOUD, never in silence', () => {
  const { dir, write } = fixture();
  const big = write('huge.png', 2048);
  const r = findDropped(`"${big}"`, { root: dir, maxBytes: 1024 });
  assert.deepEqual(r.attached, []);
  assert.equal(r.skipped.length, 1);
  assert.match(describeDropped(r), /was NOT attached/,
    'a file the user watched themselves drop, silently ignored, is indistinguishable from a broken program');
});

test('⚠️ the same file dropped twice is attached once', () => {
  const { dir, write } = fixture();
  const p = write('shot.png');
  const r = findDropped(`"${p}" and again "${p}"`, { root: dir });
  assert.equal(r.attached.length, 1);
});

/* ── ⭐ what the model is told ─────────────────────────────────────────────── */

test('⭐⭐ the prompt NAMES THE TOOL, so no round is spent rediscovering our own API', () => {
  const { dir, write } = fixture();
  const img = write('a.png');
  const pdf = write('b.pdf');
  const csv = write('c.csv');
  const text = describeDropped(findDropped(`"${img}" "${pdf}" "${csv}"`, { root: dir }));
  assert.match(text, /read_image/);
  assert.match(text, /read_document/);
  assert.match(text, /read_table/);
  assert.match(text, /cannot see them until you call the tool/,
    'the failure being prevented is a model answering confidently from the FILENAME');
});

test('nothing dropped means nothing is added to the prompt', () => {
  assert.equal(describeDropped(findDropped('just fix the tests', { root: tmpdir() })), null);
});

/* ── case, because the commonest real drop is a phone photo ───────────────── */

test('⚠️ IMG_0421.JPG — uppercase extensions are the common case, not the edge', () => {
  assert.equal(classifyDropped('IMG_0421.JPG')?.tool, 'read_image');
  assert.equal(classifyDropped('Scan.PDF')?.tool, 'read_document');
  assert.equal(classifyDropped('Book.XLSX')?.tool, 'read_table');
});

test('candidatePaths keeps a quoted token whole and does not eat its neighbours', () => {
  const got = candidatePaths('before "a b.png" after');
  assert.ok(got.includes('a b.png'));
  assert.ok(!got.includes('beforeafter'), 'the quoted span is blanked, not deleted');
});
