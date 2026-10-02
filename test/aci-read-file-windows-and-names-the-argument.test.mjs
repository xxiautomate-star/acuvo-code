/**
 * ── ⭐⭐⭐ SWE-agent's ACI FINDINGS, AUDITED AGAINST THIS REGISTRY ────────────
 *
 * The Agent-Computer Interface paper's measured claim is that agent ERGONOMICS
 * beat model quality: a windowed file viewer, a linter that runs BEFORE an edit
 * is accepted, and terse errors that name the next move each moved solve rate
 * more than swapping models did (their ablation puts linter-on-edits at +3.0
 * points — larger than removing ALL search, −2.3).
 *
 * ⭐ TWO OF THE THREE WERE ALREADY BUILT HERE AND ARE NOT RE-TESTED IN THIS FILE.
 *   · The windowed viewer is `lib/read-window.mjs` — `read_lines` / `read_around`,
 *     truncating at the END with `totalLines` and `nextOffset`.
 *   · Edit-time validation is `lib/edit-diagnostics.mjs`'s `checkEditBeforeCommit`,
 *     wired on all four writing verbs and covered by
 *     `test/tool-render-and-precommit.test.mjs`.
 *
 * ⚠️ WHAT THIS FILE PINS IS THE HOLE BETWEEN THEM: the windowed viewer existed
 * and the verb the model actually reaches for first — `read_file`, tool #1 in the
 * wire order — silently threw the window arguments away. MEASURED through this
 * dispatcher 2026-08-26 on a 600-line, 32,400-byte file (under `MAX_READ_BYTES`,
 * so the too-big refusal that DOES name `read_lines` never fires):
 *
 *     read_file {path, offset:300, limit:20}  → ok:true, bytes 32400, line 0001…
 *     read_file {path}                        → ok:true, bytes 32400, line 0001…
 *     IDENTICAL RESULT? true
 *     read_file {path, view_range:[300,320], banana:true} → ok:true, bytes 32400
 *
 * That is verbatim the four-round failure `read-window.mjs`'s own header records
 * ("the model could see the file was truncated, could not see that its paging was
 * a no-op, and burned four rounds proving it"), still live two months after the
 * fix was written into the OTHER verb.
 *
 * ⚠️ AND THE THIRD FINDING, MEASURED THE SAME DAY:
 *
 *     move_file {"from":"a.mjs"}  →  ok:false  "path must be a string"
 *
 * `move_file` declares `from`, `to` and `overwrite`. It has no `path`. The model
 * is told to fix an argument it was never given.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeToolCall } from '../lib/tools.mjs';
import { toolResultText } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

/** 600 distinct lines, ~54 bytes each — 32,400 bytes, the size the probe used. */
function sixHundredLines() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-aci-'));
  const lines = [];
  for (let i = 1; i <= 600; i += 1) lines.push(`line ${String(i).padStart(4, '0')} :: ${'x'.repeat(40)}`);
  writeFileSync(join(root, 'big.mjs'), `${lines.join('\n')}\n`);
  return root;
}

const call = (name, args) => ({ id: 't', function: { name, arguments: JSON.stringify(args) } });

async function run(root, name, args) {
  return executeToolCall(call(name, args), createLocalExecutor(root), { allowRun: false });
}

/* ── (1) WINDOWED VIEWING, THROUGH THE VERB THE MODEL ACTUALLY CALLS ───────── */

test('⭐ read_file HONOURS offset/limit instead of silently returning the whole file', async () => {
  const root = sixHundredLines();
  try {
    const rec = await run(root, 'read_file', { path: 'big.mjs', offset: 300, limit: 20 });
    assert.equal(rec.result.ok, true);
    assert.equal(rec.result.windowed, true, 'the window arguments were thrown away again');
    assert.equal(rec.result.startLine, 300);
    assert.equal(rec.result.endLine, 319);
    assert.equal(rec.result.totalLines, 600);
    assert.equal(rec.result.nextOffset, 320, 'without nextOffset paging is a guess, which is what caused the re-read loop');
    assert.match(rec.result.content, /line 0300/, 'the window does not contain the line that was asked for');
    assert.equal(/line 0001 /.test(rec.result.content), false, 'the head of the file came back — the offset was ignored');
    assert.equal(/line 0320 /.test(rec.result.content), false, 'the window overran its limit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ THE REGRESSION THIS REPLACED: a windowed read is NOT byte-identical to the whole-file read', async () => {
  const root = sixHundredLines();
  try {
    const windowed = await run(root, 'read_file', { path: 'big.mjs', offset: 300, limit: 20 });
    const whole = await run(root, 'read_file', { path: 'big.mjs' });
    assert.notEqual(
      windowed.result.content,
      whole.result.content,
      'measured 2026-08-26: these were IDENTICAL, so four consecutive paging calls all returned the same blob',
    );
    assert.equal(whole.result.bytes, 32_400, 'the plain read must be untouched');
    assert.ok(windowed.result.bytes < 2_000, 'a 20-line window came back the size of the file');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ the text is BYTE-EXACT beneath the header, so it can be pasted into edit_file', async () => {
  const root = sixHundredLines();
  try {
    const rec = await run(root, 'read_file', { path: 'big.mjs', offset: 300, limit: 3 });
    // The header is exactly one line; everything after it is the file, verbatim.
    const body = rec.result.content.slice(rec.result.content.indexOf('\n') + 1);
    assert.equal(body, rec.result.exact, 'the decorated copy and the exact copy disagree');
    assert.equal(
      body,
      'line 0300 :: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n'
      + 'line 0301 :: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n'
      + 'line 0302 :: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n',
      'a gutter, an ellipsis or a rewritten indent would make this useless as an edit_file old_string',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ the model is told the literal next call, not just that it was truncated', async () => {
  const root = sixHundredLines();
  try {
    const rec = await run(root, 'read_file', { path: 'big.mjs', offset: 1, limit: 10 });
    const seen = toolResultText(rec);
    assert.match(seen, /lines 1-10 of 600/, 'paging without totalLines is arithmetic the model cannot do');
    assert.match(seen, /offset":11/, 'the continuation call is not spelled out, so "truncated" is a dead end');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a window that reaches EOF says so rather than advertising a next page that does not exist', async () => {
  const root = sixHundredLines();
  try {
    const rec = await run(root, 'read_file', { path: 'big.mjs', offset: 595, limit: 50 });
    assert.equal(rec.result.nextOffset, null);
    assert.match(rec.result.content, /lines 595-600 of 600 \(end of file\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ the window + its header stay inside the 8,000-char clamp, or turn.mjs re-cuts the middle out', async () => {
  const root = sixHundredLines();
  try {
    const rec = await run(root, 'read_file', { path: 'big.mjs', offset: 1, limit: 400 });
    const seen = toolResultText(rec);
    assert.ok(rec.result.content.length <= 8_000, `content was ${rec.result.content.length} chars`);
    assert.equal(
      /omitted/i.test(seen),
      false,
      'the window overflowed the tool-result budget, so the head+tail clamp cut the middle out of the very '
      + 'window that exists to stop the middle being cut out',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a plain read_file {path} is completely unchanged — no header, no window fields', async () => {
  const root = sixHundredLines();
  try {
    const rec = await run(root, 'read_file', { path: 'big.mjs' });
    assert.equal(rec.result.ok, true);
    assert.equal(rec.result.windowed, undefined, 'a plain read grew a field it never had');
    assert.equal(rec.result.bytes, 32_400);
    assert.ok(rec.result.content.startsWith('line 0001 ::'), 'a header was prepended to an unwindowed read');
    assert.ok(rec.result.content.includes('line 0600 ::'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ read_file still refuses a credential file when window arguments are present', async () => {
  const root = sixHundredLines();
  try {
    writeFileSync(join(root, '.env.local'), 'OPENAI_KEY=sk-real\nMORE=1\n');
    for (const args of [{ path: '.env.local' }, { path: '.env.local', offset: 1, limit: 1 }]) {
      const rec = await run(root, 'read_file', args);
      assert.equal(rec.result.ok, false, `${JSON.stringify(args)} read a credential file`);
      assert.equal(/sk-real/.test(JSON.stringify(rec.result)), false, 'the secret reached the prompt');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── (2) TERSE STRUCTURED ERRORS — a refusal names what to do instead ──────── */

test("⚠️ an argument read_file cannot honour is REFUSED, not answered ok:true", async () => {
  const root = sixHundredLines();
  try {
    // `view_range` is another agent's spelling for the same intent, and `banana`
    // is nobody's. MEASURED 2026-08-26: both came back ok:true with the file.
    const rec = await run(root, 'read_file', { path: 'big.mjs', view_range: [300, 320], banana: true });
    assert.equal(rec.result.ok, false, 'a silent success on an argument we do not implement is invisible to the model');
    assert.match(rec.result.error, /view_range/, 'the refusal does not name the argument that caused it');
    assert.match(rec.result.error, /offset/, 'the refusal does not name the arguments that WOULD work');
    assert.match(rec.result.error, /read_around|search_text/, 'the refusal is a dead end');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ an out-of-range offset is refused in the caller\'s own vocabulary', async () => {
  const root = sixHundredLines();
  try {
    const rec = await run(root, 'read_file', { path: 'big.mjs', offset: 9_000 });
    assert.equal(rec.result.ok, false);
    assert.match(rec.result.error, /600 lines/, 'the model is not told how far the file actually goes');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️⚠️ move_file no longer tells the model to fix a "path" argument it does not have', async () => {
  const root = sixHundredLines();
  try {
    const rec = await run(root, 'move_file', { from: 'big.mjs' });
    assert.equal(rec.result.ok, false);
    assert.equal(
      rec.result.error,
      'move_file needs both "from" and "to" as workspace-relative path strings, and to is missing. '
      + 'It has no "path" argument: "from" is the file that exists now, "to" is where it should end up — '
      + 'e.g. {"from":"src/old.ts","to":"src/lib/new.ts"}.',
      'measured 2026-08-26: this said "path must be a string", naming an argument move_file does not declare',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ …and it names BOTH missing arguments rather than one at a time', async () => {
  const root = sixHundredLines();
  try {
    const rec = await run(root, 'move_file', {});
    assert.equal(rec.result.ok, false);
    assert.match(rec.result.error, /from and to are missing/, 'reporting one of two problems costs a second paid round');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a well-formed move_file is untouched', async () => {
  const root = sixHundredLines();
  try {
    const rec = await run(root, 'move_file', { from: 'big.mjs', to: 'moved/big.mjs' });
    assert.equal(rec.result.ok, true, JSON.stringify(rec.result));
    assert.equal(rec.mutated, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── (3) NO SCHEMA BYTES WERE SPENT ───────────────────────────────────────── */

test('⚠️ the window arguments cost ZERO head bytes — every schema byte rides every round', async () => {
  const { TOOL_SCHEMAS } = await import('../lib/tools.mjs');
  const readFile = TOOL_SCHEMAS.find((t) => t.function.name === 'read_file');
  assert.deepEqual(
    Object.keys(readFile.function.parameters.properties),
    ['path'],
    'declaring offset/limit here duplicates read_lines and spends head budget on every single round, against '
    + '3,133 bytes of remaining headroom — the capability is reached by instinct, not by invitation',
  );
});
