/**
 * ── WHAT THIS SUITE IS ACTUALLY GUARDING ────────────────────────────────────
 *
 * Two measured failures, both of which cost whole sessions:
 *
 *   1. `read_file` truncated the MIDDLE. Four consecutive paged reads returned a
 *      byte-identical blob with `executeToolCall` sitting inside the hole. So
 *      the tests below assert PAGING WORKS — not that a window "returns an
 *      object", but that consecutive windows concatenate into the original file
 *      byte for byte, which is the only assertion the old bug would have failed.
 *
 *   2. `search_text` returns `line.trim()`. A model built an `edit_file`
 *      old_string from a hit at `lib/git.mjs:282`, guessed six leading spaces
 *      where the file has two, was refused, and shipped a half-migrated
 *      refactor. That exact line is a fixture here, byte for byte.
 *
 * Everything else is a refusal, because a refusal is the only part of a tool a
 * model cannot work around.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readWindow,
  readWindowToolSchemas,
  formatWindowForModel,
  nestedQuantifier,
  DEFAULT_MAX_CHARS,
  MAX_LIMIT,
} from '../lib/read-window.mjs';

/** A workspace that dies with the process. Real files — the whole module is a
 *  filesystem boundary, and a mocked fs would test the mock. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-readwindow-'));
  return dir;
}

/** 2,000 lines, each one identifiable, with deliberate indentation so a window
 *  that "helpfully" trims anything fails loudly. */
function fixture2000() {
  const lines = [];
  for (let i = 1; i <= 2000; i++) {
    const indent = ' '.repeat(i % 7);
    lines.push(`${indent}line ${i} :: ${'x'.repeat(i % 13)}`);
  }
  return lines.join('\n') + '\n';
}

// ── THE WINDOW ITSELF ───────────────────────────────────────────────────────

test('a middle window returns exactly those lines, indentation intact', () => {
  const root = workspace();
  const body = fixture2000();
  writeFileSync(join(root, 'big.txt'), body, 'utf8');

  const r = readWindow(root, { path: 'big.txt', offset: 1380, limit: 80 }, 'read_lines');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.startLine, 1380);
  assert.equal(r.endLine, 1459);
  assert.equal(r.totalLines, 2000);

  const all = body.split('\n');
  const expected = all.slice(1379, 1459).join('\n') + '\n';
  assert.equal(r.text, expected);
  // The indentation assertion, stated separately so a failure names the cause.
  assert.equal(r.text.split('\n')[0], all[1379]);
  assert.match(r.text, /\n {6}line 1385 /, 'six-space indentation must survive verbatim');
  rmSync(root, { recursive: true, force: true });
});

test('paging with nextOffset concatenates back byte-for-byte', () => {
  const root = workspace();
  const body = fixture2000();
  writeFileSync(join(root, 'big.txt'), body, 'utf8');

  let offset = 1;
  let rebuilt = '';
  let pages = 0;
  while (offset !== null) {
    const r = readWindow(root, { path: 'big.txt', offset, limit: 137 }, 'read_lines');
    assert.equal(r.ok, true, r.error);
    rebuilt += r.text;
    offset = r.nextOffset;
    pages += 1;
    assert.ok(pages < 100, 'paging did not terminate');
  }
  assert.ok(pages > 10, `expected many pages, got ${pages}`);
  assert.equal(rebuilt, body, 'the concatenated pages are not the original file');
  rmSync(root, { recursive: true, force: true });
});

test('CRLF and a missing final newline both survive a round trip', () => {
  const root = workspace();
  // No trailing newline on purpose: that is the case a naive split/join adds one to.
  const body = 'alpha\r\n  beta\r\ngamma';
  writeFileSync(join(root, 'crlf.txt'), body, 'utf8');

  const r = readWindow(root, { path: 'crlf.txt' }, 'read_lines');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.totalLines, 3);
  assert.equal(r.text, body);
  assert.equal(r.nextOffset, null);
  rmSync(root, { recursive: true, force: true });
});

test('an offset past EOF refuses AND reports totalLines, so the retry is informed', () => {
  const root = workspace();
  writeFileSync(join(root, 'small.txt'), fixture2000().split('\n').slice(0, 40).join('\n'), 'utf8');

  const r = readWindow(root, { path: 'small.txt', offset: 1560, limit: 80 }, 'read_lines');
  assert.equal(r.ok, false);
  assert.match(r.error, /1560 is past the end/);
  assert.match(r.error, /40 lines/, 'the error must carry totalLines or the model guesses again');
  rmSync(root, { recursive: true, force: true });
});

test('offset 0 is refused by naming the indexing, not by silently meaning line 1', () => {
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n', 'utf8');
  const r = readWindow(root, { path: 'a.txt', offset: 0 }, 'read_lines');
  assert.equal(r.ok, false);
  assert.match(r.error, /1-indexed LINE NUMBER/);
  rmSync(root, { recursive: true, force: true });
});

test('an empty file is a fact, not a refusal', () => {
  const root = workspace();
  writeFileSync(join(root, 'empty.txt'), '', 'utf8');
  const r = readWindow(root, { path: 'empty.txt' }, 'read_lines');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.totalLines, 0);
  assert.equal(r.text, '');
  assert.match(formatWindowForModel(r), /is empty/);
  rmSync(root, { recursive: true, force: true });
});

// ── THE CORE INVERSION: CUT AT THE END, NEVER THE MIDDLE ────────────────────

test('a 20KB single-line file truncates at the END, not the middle', () => {
  const root = workspace();
  // 20,000 characters, positionally identifiable: char i is (i % 10).
  const oneLine = Array.from({ length: 20_000 }, (_, i) => String(i % 10)).join('');
  writeFileSync(join(root, 'min.js'), oneLine, 'utf8');

  const r = readWindow(root, { path: 'min.js' }, 'read_lines');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.truncated, true);
  assert.equal(r.partialLine, 1);
  assert.equal(r.text.length, DEFAULT_MAX_CHARS);
  // ⭐ THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG: the returned text
  // is a PREFIX of the original. clampOutput's head+tail would fail this.
  assert.ok(oneLine.startsWith(r.text), 'the window is not a prefix — the middle was dropped');
  assert.equal(r.text.includes('…'), false, 'no ellipsis may appear inside returned text');
  assert.equal(r.nextOffset, null, 'a one-line file has no next line');
  rmSync(root, { recursive: true, force: true });
});

test('a multi-line window cut by the char budget stops on a line boundary and says where to resume', () => {
  const root = workspace();
  const body = fixture2000();
  writeFileSync(join(root, 'big.txt'), body, 'utf8');

  const r = readWindow(root, { path: 'big.txt', offset: 1, limit: MAX_LIMIT }, 'read_lines');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.truncated, true, '400 lines of this fixture exceed 8000 chars');
  assert.equal(r.partialLine, null);
  assert.ok(r.text.endsWith('\n'), 'a cut window must end on a line boundary');
  assert.ok(r.text.length <= DEFAULT_MAX_CHARS);
  assert.equal(r.nextOffset, r.endLine + 1);
  assert.ok(body.startsWith(r.text), 'the head of the file must come back unmodified');
  assert.match(formatWindowForModel(r), new RegExp(`continue with read_lines offset ${r.nextOffset}`));
  rmSync(root, { recursive: true, force: true });
});

// ── read_around: THE TOOL AN old_string IS COPIED FROM ──────────────────────

test('read_around returns the TWO leading spaces of the git.mjs:282 line — the exact regression', () => {
  const root = workspace();
  /**
   * Verbatim from lib/git.mjs, lines 280-284, captured with `cat -A`. The model
   * that lost a session here had `search_text`'s trimmed version and guessed six
   * spaces. The file has two.
   */
  const gitSlice = [
    "  if (run.exitCode !== 0) return { ok: false, error: run.stderr.trim() || 'git diff failed' };",
    '',
    '  const clamped = clampOutput(run.stdout, MAX_DIFF_CHARS);',
    '  return {',
    '    ok: true,',
  ].join('\n') + '\n';
  const pad = Array.from({ length: 279 }, (_, i) => `// filler ${i + 1}`).join('\n') + '\n';
  writeFileSync(join(root, 'git.mjs'), pad + gitSlice, 'utf8');

  const r = readWindow(root, { path: 'git.mjs', pattern: 'clampOutput', context: 2 }, 'read_around');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.matchCount, 1);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].startLine, 280);
  assert.equal(r.blocks[0].endLine, 284);

  const hit = r.blocks[0].text.split('\n').find((l) => l.includes('clampOutput'));
  assert.equal(hit, '  const clamped = clampOutput(run.stdout, MAX_DIFF_CHARS);');
  assert.equal(hit.startsWith('  const'), true, 'exactly two leading spaces');
  assert.equal(hit.startsWith('   '), false, 'not three, and certainly not six');
  rmSync(root, { recursive: true, force: true });
});

test('overlapping context windows merge into one block, distant ones get an omitted marker', () => {
  const root = workspace();
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
  lines[19] = 'TARGET a';   // line 20
  lines[23] = 'TARGET b';   // line 24 — within 2*context of line 20, must merge
  lines[149] = 'TARGET c';  // line 150 — far away, must be its own block
  writeFileSync(join(root, 'm.txt'), lines.join('\n') + '\n', 'utf8');

  const r = readWindow(root, { path: 'm.txt', pattern: '^TARGET', context: 5 }, 'read_around');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.matchCount, 3);
  assert.equal(r.blocks.length, 2, 'lines 20 and 24 must merge into one block');
  assert.equal(r.blocks[0].startLine, 15);
  assert.equal(r.blocks[0].endLine, 29);
  assert.equal(r.blocks[1].startLine, 145);

  const shown = formatWindowForModel(r);
  assert.match(shown, /··· lines 30-144 omitted ···/);
  assert.equal((shown.match(/omitted/g) || []).length, 1, 'exactly one marker between two blocks');
  rmSync(root, { recursive: true, force: true });
});

test('read_around with no match says so instead of returning an empty success the model reads as broken', () => {
  const root = workspace();
  writeFileSync(join(root, 'm.txt'), 'alpha\nbeta\n', 'utf8');
  const r = readWindow(root, { path: 'm.txt', pattern: 'zeta' }, 'read_around');
  assert.equal(r.ok, true);
  assert.equal(r.matchCount, 0);
  assert.match(formatWindowForModel(r), /no line matches/);
  rmSync(root, { recursive: true, force: true });
});

test('read_around is case-insensitive by default, matching search_text, and exact on request', () => {
  const root = workspace();
  writeFileSync(join(root, 'm.txt'), 'const ClampOutput = 1;\n', 'utf8');
  assert.equal(readWindow(root, { path: 'm.txt', pattern: 'clampoutput' }, 'read_around').matchCount, 1);
  assert.equal(readWindow(root, { path: 'm.txt', pattern: 'clampoutput', ignoreCase: false }, 'read_around').matchCount, 0);
  rmSync(root, { recursive: true, force: true });
});

test('maxBlocks caps the blocks and reports how many were dropped plus where to resume', () => {
  const root = workspace();
  const lines = Array.from({ length: 600 }, (_, i) => ((i + 1) % 50 === 0 ? 'HIT here' : `line ${i + 1}`));
  writeFileSync(join(root, 'many.txt'), lines.join('\n') + '\n', 'utf8');

  const r = readWindow(root, { path: 'many.txt', pattern: '^HIT', context: 1, maxBlocks: 3 }, 'read_around');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.matchCount, 12);
  assert.equal(r.blocks.length, 3);
  assert.equal(r.blocksOmitted, 9);
  assert.equal(r.truncated, true);
  assert.equal(r.nextOffset, 199, 'the 4th hit is line 200, its block starts at 199');
  rmSync(root, { recursive: true, force: true });
});

// ── REFUSALS ────────────────────────────────────────────────────────────────

test('an unknown argument key is refused, naming the ones that exist', () => {
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), 'x\n', 'utf8');

  const r = readWindow(root, { path: 'a.txt', depth: 2 }, 'read_lines');
  assert.equal(r.ok, false);
  assert.match(r.error, /^read_lines accepts only path, offset, limit/);
  assert.match(r.error, /does not accept "depth"/);

  const r2 = readWindow(root, { path: 'a.txt', pattern: 'x', recursive: true }, 'read_around');
  assert.equal(r2.ok, false);
  assert.match(r2.error, /^read_around accepts only path, pattern, context/);
  assert.match(r2.error, /does not accept "recursive"/);
  rmSync(root, { recursive: true, force: true });
});

test('inference does not launder an illegal argument — {path, pattern, offset} is refused', () => {
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), 'x\n', 'utf8');
  const r = readWindow(root, { path: 'a.txt', pattern: 'x', offset: 3 });
  assert.equal(r.ok, false);
  assert.match(r.error, /read_around accepts only/);
  rmSync(root, { recursive: true, force: true });
});

test('a binary file is refused by name and by reason', () => {
  const root = workspace();
  writeFileSync(join(root, 'blob.dat'), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47, 0x0a]));
  const r = readWindow(root, { path: 'blob.dat' }, 'read_lines');
  assert.equal(r.ok, false);
  assert.match(r.error, /NUL byte/);
  assert.match(r.error, /blob\.dat/);
  rmSync(root, { recursive: true, force: true });
});

test('traversal, absolute paths and a symlink out are all refused', () => {
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), 'x\n', 'utf8');

  for (const bad of ['../../../etc/passwd', '/etc/passwd', 'C:/Windows/win.ini', '..\\..\\secret.txt']) {
    const r = readWindow(root, { path: bad }, 'read_lines');
    assert.equal(r.ok, false, `${bad} was accepted`);
  }

  // A symlink whose realpath leaves the workspace. Skipped where the platform
  // will not create one without elevation — a skipped check is honest, a
  // silently-passing one is not.
  const outside = mkdtempSync(join(tmpdir(), 'acuvo-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET\n', 'utf8');
  let linked = false;
  try {
    symlinkSync(outside, join(root, 'link'), 'dir');
    linked = true;
  } catch { /* no symlink privilege on this machine */ }
  if (linked) {
    const r = readWindow(root, { path: 'link/secret.txt' }, 'read_lines');
    assert.equal(r.ok, false, 'a symlink out of the workspace must be refused');
    assert.match(r.error, /symlink/);
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('credential-shaped files are refused even though read_file would return them', () => {
  const root = workspace();
  mkdirSync(join(root, 'cfg'), { recursive: true });
  for (const name of ['.env', '.env.local', 'server.pem', 'private.key', 'id_rsa', 'cert.p12', '.npmrc', '.git-credentials']) {
    writeFileSync(join(root, 'cfg', name), 'SECRET=1\n', 'utf8');
    const r = readWindow(root, { path: `cfg/${name}` }, 'read_lines');
    assert.equal(r.ok, false, `${name} was returned`);
    assert.match(r.error, /credential files/);
  }
  // The control: an ordinary neighbour in the same directory still reads.
  writeFileSync(join(root, 'cfg', 'app.json'), '{"a":1}\n', 'utf8');
  assert.equal(readWindow(root, { path: 'cfg/app.json' }, 'read_lines').ok, true);
  rmSync(root, { recursive: true, force: true });
});

test('a directory and a missing file each get their own actionable sentence', () => {
  const root = workspace();
  mkdirSync(join(root, 'src'), { recursive: true });
  const d = readWindow(root, { path: 'src' }, 'read_lines');
  assert.equal(d.ok, false);
  assert.match(d.error, /use list_dir/);
  const m = readWindow(root, { path: 'nope.txt' }, 'read_lines');
  assert.equal(m.ok, false);
  assert.match(m.error, /use find_files/);
  rmSync(root, { recursive: true, force: true });
});

test('out-of-range limit and context are refused with the range, not with "try again"', () => {
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), 'x\n', 'utf8');
  for (const limit of [0, -5, 401, 12.5, '80']) {
    const r = readWindow(root, { path: 'a.txt', limit }, 'read_lines');
    assert.equal(r.ok, false, `limit ${JSON.stringify(limit)} was accepted`);
    assert.match(r.error, /between 1 and 400/);
    assert.equal(/try again/i.test(r.error), false, 'an error string is an instruction — never "try again"');
  }
  const c = readWindow(root, { path: 'a.txt', pattern: 'x', context: 100 }, 'read_around');
  assert.equal(c.ok, false);
  assert.match(c.error, /between 0 and 40/);
  rmSync(root, { recursive: true, force: true });
});

test('an over-long or uncompilable pattern is refused before a byte is read', () => {
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), 'x\n', 'utf8');
  const long = readWindow(root, { path: 'a.txt', pattern: 'a'.repeat(201) }, 'read_around');
  assert.equal(long.ok, false);
  assert.match(long.error, /over the 200-character limit/);

  const broken = readWindow(root, { path: 'a.txt', pattern: '([unclosed' }, 'read_around');
  assert.equal(broken.ok, false);
  assert.match(broken.error, /not a valid regular expression/);
  assert.match(broken.error, /escape the special characters/);
  rmSync(root, { recursive: true, force: true });
});

/**
 * ── ⚠️ THE HANG THAT A TIMEOUT COULD NOT HAVE CAUGHT ────────────────────────
 * Measured before this guard existed: `(z+z+)+Q` over a 7.5 MB fixture ran past
 * FIVE MINUTES and was killed. The wall-clock check between lines was useless,
 * because the line that never returns is a single `test()` call. These tests
 * assert the refusal happens BEFORE the scan, and — just as important — that the
 * guard has not been drawn so wide it refuses ordinary patterns.
 */
test('a catastrophic-backtracking pattern is refused before the scan, in milliseconds', () => {
  const root = workspace();
  // A line with a long run of one character: the fuel for exponential backtracking.
  writeFileSync(join(root, 'fuel.txt'), `${'z'.repeat(400)}\n`.repeat(200), 'utf8');

  for (const pattern of ['(z+z+)+Q', '(a*)*b', '(a?)+b', '(ab{2,})+c', '((z+))+Q']) {
    const t0 = Date.now();
    const r = readWindow(root, { path: 'fuel.txt', pattern }, 'read_around');
    const ms = Date.now() - t0;
    assert.equal(r.ok, false, `${pattern} was allowed to run`);
    assert.match(r.error, /nests a quantifier/);
    assert.ok(ms < 1000, `${pattern} took ${ms}ms — it was scanned rather than refused`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('the ReDoS guard does not refuse ordinary patterns', () => {
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), '  const clamped = clampOutput(run.stdout, MAX);\n', 'utf8');
  // Real patterns from this repo and its tests, plus the group forms that are fine.
  for (const pattern of [
    'clampOutput\\(run\\.stdout',
    '^export function \\w+',
    '(foo|bar)+',          // alternation of literals under a quantifier — linear
    '(?:const|let) \\w+',
    '\\s*const clamped',
    'a+b+c+',              // quantifiers in sequence, not nested
    '(a+)?',               // quantified group, but the OUTER quantifier is `?`
  ]) {
    const r = readWindow(root, { path: 'a.txt', pattern }, 'read_around');
    assert.equal(r.ok, true, `${pattern} was wrongly refused: ${r.error}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('an escaped paren or a character class is not mistaken for nesting', () => {
  assert.equal(nestedQuantifier('\\(a+\\)+'), false, 'escaped parens are literals, not a group');
  assert.equal(nestedQuantifier('[(+*)]+'), false, 'a character class is opaque');
  assert.equal(nestedQuantifier('(?:a+)+'), true, 'a non-capturing group is still a group');
  assert.equal(nestedQuantifier('(?<name>a+)+'), true, 'a named group is still a group');
  assert.equal(nestedQuantifier('(?=a+)b+'), false, 'a lookahead is not quantified');
});

// ── THE GUTTER, WHICH MUST NEVER BE THE ONLY COPY ───────────────────────────

test('numbered:true adds a gutter AND carries the ungutted text beside it', () => {
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), '  alpha\n    beta\ngamma\n', 'utf8');
  const plain = readWindow(root, { path: 'a.txt' }, 'read_lines');
  const gutted = readWindow(root, { path: 'a.txt', numbered: true }, 'read_lines');

  assert.equal(plain.text, '  alpha\n    beta\ngamma\n');
  assert.equal(plain.exact, undefined, 'exact is redundant when text is already exact');
  assert.equal(gutted.text, '1|   alpha\n2|     beta\n3| gamma\n');
  assert.equal(gutted.exact, plain.text, 'the ungutted copy must ride along');
  rmSync(root, { recursive: true, force: true });
});

test('the gutter is off by default — the default output is paste-safe for edit_file', () => {
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), '  const x = 1;\n', 'utf8');
  const r = readWindow(root, { path: 'a.txt' }, 'read_lines');
  assert.equal(/^\s*\d+\|/.test(r.text), false, 'a gutter must never appear unasked');
  rmSync(root, { recursive: true, force: true });
});

// ── THE MODEL-FACING SURFACE ────────────────────────────────────────────────

test('the header is exactly one line and states path, span, total and size', () => {
  const root = workspace();
  writeFileSync(join(root, 'big.txt'), fixture2000(), 'utf8');
  const r = readWindow(root, { path: 'big.txt', offset: 1380, limit: 120 }, 'read_lines');
  const out = formatWindowForModel(r);
  const header = out.split('\n')[0];
  assert.match(header, /^big\.txt lines 1380-1499 of 2000 \(\d+ bytes\)/);
  // The body under the header is the verbatim window, header line excluded.
  assert.equal(out.slice(header.length + 1), r.text.replace(/\n$/, ''));
  rmSync(root, { recursive: true, force: true });
});

test('a failed result formats as a sentence, not as [object Object]', () => {
  assert.equal(formatWindowForModel({ ok: false, error: 'nope' }), 'read failed: nope');
  assert.match(formatWindowForModel(undefined), /read failed/);
});

test('both schemas are OpenAI-shaped, and both teach the fact that got this built', () => {
  const s = readWindowToolSchemas();
  assert.equal(s.length, 2);
  const byName = Object.fromEntries(s.map((t) => [t.function.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['read_around', 'read_lines']);
  for (const t of s) {
    assert.equal(t.type, 'function');
    assert.equal(t.function.parameters.type, 'object');
    assert.ok(t.function.parameters.required.includes('path'));
    assert.ok(t.function.description.length > 80);
  }
  // The two sentences that stop the two measured failures recurring.
  assert.match(byName.read_lines.function.description, /1-indexed LINE NUMBER/);
  /**
   * ⚠️⚠️ THIS ASSERTION USED TO PIN A CLAIM THAT HAD BECOME FALSE.
   *
   * It required the description to say "search_text trims its results and will
   * lose the leading whitespace — never build an edit from it." That was true
   * when `searchText` returned `lines[i].trim()`. It stopped being true the
   * moment that became `trimEnd()`, and the sentence turned into a lie the
   * model READS EVERY RUN.
   *
   * ⭐ AND IT WAS NOT INERT. Measured in a live run: the model quoted the belief
   * straight back — "The tool strips leading whitespace... I need to include the
   * indentation... let me read the exact lines with read_around" — and spent a
   * whole round working around output that was already correct.
   *
   * ⚠️ A TEST THAT HOLDS A STALE CLAIM IN PLACE IS WORSE THAN NO TEST. It stops
   * defending the product and starts defending the past against the present, and
   * it is the reason the sentence survived the change that falsified it. So this
   * now asserts the CURRENT contract, and asserts the dead claim is GONE.
   */
  assert.match(byName.read_around.function.description, /byte-exact|indentation/i);
  assert.doesNotMatch(
    byName.read_around.function.description,
    /search_text trims/,
    'the description still tells the model search_text trims its results — it does not, and the model believes this',
  );
  /**
   * ⚠️ THE DRIFT GUARD. A schema that advertises a property the dispatcher then
   * refuses is the WORST version of the probe-2 bug — the model is not guessing,
   * it is doing exactly what it was told, and still gets a refusal. So every
   * declared property is fed in for real and must not trip the unknown-key rule.
   */
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), '  hit here\n', 'utf8');
  const sample = { path: 'a.txt', offset: 1, limit: 1, numbered: true, pattern: 'hit', context: 1, ignoreCase: true, maxBlocks: 1 };
  for (const t of s) {
    const args = {};
    for (const key of Object.keys(t.function.parameters.properties)) args[key] = sample[key];
    const r = readWindow(root, args, t.function.name);
    assert.equal(r.ok, true, `${t.function.name} refused its own advertised arguments: ${r.error}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('nothing here writes: the workspace is unchanged after every verb', () => {
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), 'alpha\nbeta\n', 'utf8');
  readWindow(root, { path: 'a.txt', offset: 1, limit: 2 }, 'read_lines');
  readWindow(root, { path: 'a.txt', pattern: 'alpha' }, 'read_around');
  readWindow(root, { path: 'a.txt', offset: 99 }, 'read_lines');
  const after = readWindow(root, { path: 'a.txt' }, 'read_lines');
  assert.equal(after.text, 'alpha\nbeta\n');
  rmSync(root, { recursive: true, force: true });
});
