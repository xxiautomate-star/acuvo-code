/**
 * ── ⭐⭐⭐ `@path` — THE GAP MEASURED AGAINST THE COMPETITOR, NOT REMEMBERED ──
 *
 * MEASURED 2026-08-26 by listing what this CLI already has rather than by
 * assuming. It ships `--resume`, `--continue`, `--sessions`, a plan mode, hooks
 * and subagents — every headline item people name when comparing it to Claude
 * Code. The one genuinely missing ergonomic was the smallest gesture in the
 * product: naming a file inline while typing the sentence.
 *
 * ⚠️ AND IT IS NOT COSMETIC. Without it, "why does @src/auth.ts reject an
 * expired token" costs an entire extra round — the model has to guess the path,
 * call `read_file`, and answer on the round after. That is a full request,
 * prompt and tool offer included, bought to learn something the person typing
 * already knew.
 *
 * ── WHAT THIS FILE PINS ─────────────────────────────────────────────────────
 *
 *   1. an email is never a file reference;
 *   2. an `@` that resolves to nothing SURVIVES AS TEXT;
 *   3. nothing escapes the workspace, and the workspace's own resolver decides;
 *   4. the byte budget is stated when it bites;
 *   5. it is WIRED — `runChat` actually calls it, and prints what happened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandFileRefs, refSummaryLines, runChat, MAX_REF_BYTES } from '../lib/chat.mjs';

function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-atref-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

// ───────────────────────────────────────────────────────────────────────────
// THE HAPPY PATH
// ───────────────────────────────────────────────────────────────────────────

test('⭐ a referenced file is attached in full, and the typed sentence is untouched', () => {
  const root = workspace({ 'src/app.ts': 'export const answer = 42;\n' });
  try {
    const r = expandFileRefs(root, 'why does @src/app.ts return the wrong number?');
    assert.equal(r.attached.length, 1);
    assert.equal(r.attached[0].path, 'src/app.ts');
    assert.ok(r.text.includes('why does @src/app.ts return the wrong number?'),
      'the typed sentence must survive verbatim — substituting a file into the middle of it destroys the sentence');
    assert.ok(r.text.includes('export const answer = 42;'), 'the contents have to actually be there');
    assert.ok(r.text.includes('===== src/app.ts'), 'the path has to ride with the contents or a patch lands on the wrong file');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ several references in one message, deduped', () => {
  const root = workspace({ 'a.txt': 'AAA', 'b.txt': 'BBB' });
  try {
    const r = expandFileRefs(root, 'compare @a.txt with @b.txt and again @a.txt');
    assert.deepEqual(r.attached.map((a) => a.path), ['a.txt', 'b.txt'],
      'the same token twice is one attachment — the second copy is re-bought on every round that follows');
    assert.ok(r.text.includes('AAA') && r.text.includes('BBB'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ punctuation belongs to the sentence, not to the path', () => {
  const root = workspace({ 'src/app.ts': 'x', 'notes.md': 'y' });
  try {
    const r = expandFileRefs(root, 'look at @src/app.ts, then @notes.md.');
    assert.deepEqual(r.attached.map((a) => a.path), ['src/app.ts', 'notes.md'],
      'a reference that only works at the end of a line is a feature with a hidden rule');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ a quoted reference carries a path with spaces — the Windows case', () => {
  const root = workspace({ 'My Notes/plan v2.md': 'the plan' });
  try {
    const r = expandFileRefs(root, 'read @"My Notes/plan v2.md" please');
    assert.equal(r.attached.length, 1);
    assert.ok(r.text.includes('the plan'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// WHAT MUST NOT HAPPEN
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ an email address is not a file reference', () => {
  const root = workspace({ 'xxiautomate.com': 'should never be read' });
  try {
    const r = expandFileRefs(root, 'email roman@xxiautomate.com about the invoice');
    assert.deepEqual(r.attached, [], 'the `@` in an address has a character in front of it and is never a reference');
    assert.deepEqual(r.skipped, [], 'and it is not even a candidate, so there is nothing to report');
    assert.equal(r.text, 'email roman@xxiautomate.com about the invoice');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️⚠️ an `@` that resolves to nothing STAYS AS TYPED', () => {
  const root = workspace({ 'real.txt': 'x' });
  try {
    const r = expandFileRefs(root, 'the @media query and the @decorator both matter');
    assert.deepEqual(r.attached, []);
    assert.equal(r.text, 'the @media query and the @decorator both matter',
      'deleting the token would be a message the user did not write');
    assert.equal(r.skipped.length, 2, 'but the human is told why nothing attached');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️⚠️ nothing escapes the workspace, and the workspace decides', () => {
  const root = workspace({ 'inside.txt': 'x' });
  try {
    for (const attempt of ['@../../../etc/passwd', '@/etc/passwd', '@..\\..\\secrets.env']) {
      const r = expandFileRefs(root, `read ${attempt} now`);
      assert.deepEqual(r.attached, [], `${attempt} must not attach anything`);
      assert.ok(r.text.startsWith('read '), 'and the text is unchanged');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a directory is refused with the move that would work', () => {
  const root = workspace({ 'src/a.ts': 'x' });
  try {
    const r = expandFileRefs(root, 'read @src');
    assert.deepEqual(r.attached, []);
    assert.match(r.skipped[0].why, /directory/,
      'inlining a tree is how one @src/ becomes the whole repository in a single message');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a binary file is refused, with the same next move read_file gives', () => {
  const root = workspace({});
  writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  try {
    const r = expandFileRefs(root, 'look at @logo.png');
    assert.deepEqual(r.attached, []);
    assert.match(r.skipped[0].why, /binary/);
    assert.match(r.skipped[0].why, /read_image/, 'the refusal has to name the verb that would work');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// THE BUDGET
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ the budget is SHARED across one message and says so when it bites', () => {
  const root = workspace({ 'big.txt': 'x'.repeat(500), 'small.txt': 'y'.repeat(10) });
  try {
    const r = expandFileRefs(root, 'read @big.txt and @small.txt', { maxBytes: 300 });
    assert.equal(r.truncated, true);
    assert.equal(r.attached[0].bytes, 300);
    assert.equal(r.attached[0].of, 500);
    assert.ok(r.text.includes('TRUNCATED'),
      'the MODEL has to know it holds a fragment, or it answers about the end of a file it never saw');
    assert.ok(r.text.includes('read_lines'), 'and be told the verb that gets the rest');
    // ⭐ The budget is spent, so the second file is reported rather than
    // silently omitted — a missing attachment is invisible until the answer is wrong.
    assert.equal(r.attached.length, 1);
    assert.match(r.skipped[0].why, /limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the default budget matches what read_file allows, so the two halves cannot disagree', () => {
  assert.equal(MAX_REF_BYTES, 200_000);
});

// ───────────────────────────────────────────────────────────────────────────
// FEEDBACK
// ───────────────────────────────────────────────────────────────────────────

test('⭐ the human is told exactly what attached and what did not', () => {
  const root = workspace({ 'a.txt': 'hello' });
  try {
    const r = expandFileRefs(root, 'read @a.txt and @missing.txt');
    const lines = refSummaryLines(r).join('\n');
    assert.match(lines, /attached 1 file/);
    assert.match(lines, /a\.txt/);
    assert.match(lines, /@missing\.txt/);
    assert.match(lines, /left as text/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// ⭐⭐⭐ WIRED — the half this repo keeps forgetting
// ───────────────────────────────────────────────────────────────────────────

/** A non-TTY stdin the chat loop drains as a queue of prompts. */
function piped(lines) {
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() { yield Buffer.from(`${lines.join('\n')}\n`); },
  };
}

function sink() {
  const written = [];
  return { written, write: (s) => { written.push(s); return true; }, text: () => written.join('') };
}

test('⭐⭐⭐ runChat ACTUALLY expands @refs — built-and-unreached is the defect this repo pays for', async () => {
  const root = workspace({ 'src/app.ts': 'export const answer = 42;' });
  const out = sink();
  const seen = [];
  try {
    await runChat({
      root,
      runOne: async (task) => { seen.push(task); return { ok: true, messages: [] }; },
      render: () => {},
      input: piped(['fix @src/app.ts', 'exit']),
      output: out,
    });
    assert.equal(seen.length, 1);
    assert.ok(seen[0].includes('export const answer = 42;'),
      'the model must receive the file, not just the token — otherwise the whole feature is a comment');
    assert.match(out.text(), /attached 1 file/, 'and the person typing must see that it landed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ with no root the loop behaves exactly as it did before — no guessing at cwd', async () => {
  const out = sink();
  const seen = [];
  await runChat({
    runOne: async (task) => { seen.push(task); return { ok: true, messages: [] }; },
    render: () => {},
    input: piped(['fix @src/app.ts', 'exit']),
    output: out,
  });
  assert.equal(seen[0], 'fix @src/app.ts',
    'an embedder that wires nothing must not have this loop read files out of whatever directory the process is in');
});

test('⚠️⚠️ the byte budget holds on non-ASCII, where a character slice would not', () => {
  /**
   * `content.slice(0, budget)` is a CHARACTER slice measured against a BYTE
   * ceiling. On ASCII the two agree and every test above passes; on Japanese
   * each character is 3 bytes, so a 300-byte budget would have attached ~900
   * bytes — the guard silently absent on exactly the files that need it.
   */
  const root = workspace({ 'jp.txt': '日'.repeat(500) });   // 1,500 bytes
  try {
    const r = expandFileRefs(root, 'read @jp.txt', { maxBytes: 300 });
    assert.equal(r.attached[0].of, 1500, 'the real size is measured in bytes');
    assert.equal(r.attached[0].bytes, 300);
    assert.ok(Buffer.byteLength(r.text) < 1500,
      'the whole point: the message must not carry the bytes the budget refused');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
