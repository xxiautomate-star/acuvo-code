/**
 * Showing a change before it lands.
 *
 * Two halves, and the second is the one with the arguments in it:
 *
 *   · the DIFF has to be correct on the five shapes that break naive
 *     implementations — a creation, a deletion, CRLF against LF, a missing
 *     trailing newline, and something it must refuse to draw at all;
 *   · the POLICY has to ask about the writes a person would veto and about
 *     nothing else, and — the thing this repo has been bitten by twice — it has
 *     to reach an answer when there is no terminal instead of waiting for one.
 *
 * ⚠️ EVERY TEST HERE RUNS WITH NO TTY, because `node --test` is never a TTY.
 * That is not a limitation of the suite, it IS the hostile environment: if any
 * code path below tried to block on input, this file would hang rather than
 * fail, which is exactly the failure `prompt.mjs`'s header spends a paragraph
 * refusing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
  diffUnified, renderUnified, renderDiff, renderApproval, approvalPrompt,
  approvalDecision, approvalMode, writeRisk, interpretAnswer,
  planApprovals, summariseApprovals, splitLines, eolStyle, refuseToRender,
  isScratchPath, isProtectedConfigPath, previewLineCap,
  MAX_DIFF_BYTES, MAX_DIFF_LINE_CHARS, DIFF_LINES_ENV, APPROVE_ENV,
} from '../lib/diff-preview.mjs';
import { createAsker, askOnce } from '../lib/prompt.mjs';

const NUL = String.fromCharCode(0);

// ── the diff ───────────────────────────────────────────────────────────────

test('a new file diffs against /dev/null and is all additions', () => {
  const d = diffUnified(null, 'one\ntwo\n', 'src/new.js');
  assert.equal(d.ok, true);
  assert.equal(d.kind, 'created');
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
  assert.match(d.text, /^--- \/dev\/null\n\+\+\+ b\/src\/new\.js\n/);
  assert.match(d.text, /@@ -0,0 \+1,2 @@/);
  assert.match(d.text, /^\+one$/m);
});

test('a deletion diffs to /dev/null and is all removals', () => {
  const d = diffUnified('one\ntwo\n', null, 'src/gone.js');
  assert.equal(d.kind, 'deleted');
  assert.equal(d.removed, 2);
  assert.equal(d.added, 0);
  assert.match(d.text, /^--- a\/src\/gone\.js\n\+\+\+ \/dev\/null\n/);
  assert.match(d.text, /@@ -1,2 \+0,0 @@/);
});

test('an ordinary one-line edit produces a git-shaped hunk with context', () => {
  const before = 'a\nb\nc\nd\ne\n';
  const after = 'a\nb\nC\nd\ne\n';
  const d = diffUnified(before, after, 'x.txt');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.hunks.length, 1);
  assert.match(d.text, /@@ -1,5 \+1,5 @@/);
  assert.match(d.text, /^-c$/m);
  assert.match(d.text, /^\+C$/m);
  assert.match(d.text, /^ b$/m, 'context lines carry a leading space, or the output is not a unified diff');
});

test('⚠️ an empty existing file is NOT a creation — "" and null are different facts', () => {
  /**
   * Conflating them reports "created" for a write that blanked a file, which is
   * the wording `tools.mjs` records as having frightened a reader once already.
   */
  assert.equal(diffUnified('', 'x\n', 'f.txt').kind, 'replaced');
  assert.equal(diffUnified(null, 'x\n', 'f.txt').kind, 'created');
  assert.equal(diffUnified('x\n', '', 'f.txt').kind, 'replaced');
  assert.equal(diffUnified('x\n', null, 'f.txt').kind, 'deleted');
});

test('identical contents are "unchanged" with no hunks at all', () => {
  const d = diffUnified('a\nb\n', 'a\nb\n', 'f.txt');
  assert.equal(d.kind, 'unchanged');
  assert.equal(d.hunks.length, 0);
  assert.equal(d.added + d.removed, 0);
});

test('⚠️⚠️ CRLF → LF does not redraw the whole file, and does not read as "nothing changed"', () => {
  /**
   * Diffing lines with their terminators attached marks every line changed and
   * prints hundreds of `-foo` / `+foo` pairs that look identical on screen. The
   * opposite mistake — ignoring the endings — reports a byte-level rewrite as a
   * no-op. Both are previews that lie, so: zero phantom line changes AND an
   * explicit statement that the endings moved.
   */
  const crlf = 'alpha\r\nbeta\r\ngamma\r\n';
  const lf = 'alpha\nbeta\ngamma\n';
  const d = diffUnified(crlf, lf, 'f.txt');
  assert.equal(d.kind, 'replaced', 'the bytes differ, so this is a real change');
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.equal(d.eol.before, 'crlf');
  assert.equal(d.eol.after, 'lf');
  assert.equal(d.eol.changed, true);
  assert.equal(d.invisible, true, 'the renderer needs to know there is nothing to show but something to say');

  const { body } = renderApproval(d, { risk: 'medium', reason: 'r' });
  assert.match(body, /line endings change CRLF → LF/);
});

test('a real edit inside a CRLF file changes exactly one line', () => {
  const before = 'a\r\nb\r\nc\r\n';
  const after = 'a\r\nB\r\nc\r\n';
  const d = diffUnified(before, after, 'f.txt');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.eol.changed, false);
  assert.ok(!d.text.includes('\r'), 'a carriage return left inside a diff line corrupts every terminal that prints it');
});

test('⚠️ a vanishing trailing newline is a real change, not an invisible one', () => {
  const d = diffUnified('a\nb\n', 'a\nb', 'f.txt');
  assert.equal(d.noNewlineAfter, true);
  assert.equal(d.noNewlineBefore, false);
  assert.equal(d.added, 1, 'the last line must be forced into a ±pair or the change renders as nothing');
  assert.equal(d.removed, 1);
  assert.match(d.text, /\\ No newline at end of file/);
});

test('a file that never had a trailing newline is marked on the OLD side', () => {
  const d = diffUnified('a\nb', 'a\nb\n', 'f.txt');
  assert.equal(d.noNewlineBefore, true);
  assert.equal(d.noNewlineAfter, false);
  const marker = d.text.split('\n').findIndex((l) => l === '\\ No newline at end of file');
  assert.ok(marker > 0);
  assert.equal(d.text.split('\n')[marker - 1], '-b', 'the marker belongs to the line it describes');
});

test('two distant changes make two hunks; two near ones make one', () => {
  const lines = (n, f = (i) => `l${i}`) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n';
  const before = lines(20);
  const far = before.replace('l1\n', 'X1\n').replace('l18\n', 'X18\n');
  assert.equal(diffUnified(before, far, 'f').hunks.length, 2);
  const near = before.replace('l1\n', 'X1\n').replace('l3\n', 'X3\n');
  assert.equal(diffUnified(before, near, 'f').hunks.length, 1);
});

test('a wholly different file is shown as a wholesale replacement rather than hanging', () => {
  const a = Array.from({ length: 400 }, (_, i) => `alpha ${i}`).join('\n') + '\n';
  const b = Array.from({ length: 400 }, (_, i) => `beta ${i}`).join('\n') + '\n';
  const d = diffUnified(a, b, 'f.txt', { maxEdits: 10 });
  assert.equal(d.ok, true);
  assert.equal(d.truncatedByDistance, true);
  assert.equal(d.removed, 400);
  assert.equal(d.added, 400);
});

test('⚠️ "too different to align" must never come back as "no changes"', () => {
  const d = diffUnified('a\n', 'z\n', 'f.txt', { maxEdits: 0 });
  assert.equal(d.truncatedByDistance, true);
  assert.ok(d.added > 0 && d.removed > 0, 'an empty diff for a total rewrite is the worst output this module could produce');
});

// ── refusing to render ─────────────────────────────────────────────────────

test('binary content is refused, and the refusal names the way out', () => {
  const d = diffUnified('ok\n', `png${NUL}bytes`, 'logo.png');
  assert.equal(d.ok, false);
  assert.equal(d.renderable, false);
  assert.match(d.reason, /NUL byte/);
  assert.match(d.reason, /git diff/, 'a refusal with no way out is an obstacle, not a decision');
  assert.equal(d.afterBytes > 0, true, 'the counts survive a refusal — otherwise the reviewer has less than they started with');
});

test('an oversized file is refused with its cap stated', () => {
  const big = 'x\n'.repeat(60);
  const d = diffUnified(big, `${big}y\n`, 'big.txt', { maxBytes: 50 });
  assert.equal(d.ok, false);
  assert.match(d.reason, /over the 50-byte preview limit/);
  assert.equal(refuseToRender('a', 'b', { maxBytes: MAX_DIFF_BYTES }), null, 'ordinary files are never refused');
});

test('a minified single line is refused — a diff of it is one changed line', () => {
  const min = `${'a'.repeat(MAX_DIFF_LINE_CHARS + 1)}\n`;
  const d = diffUnified(min, `${min}\n`, 'dist/app.js');
  assert.equal(d.ok, false);
  assert.match(d.reason, /minified or generated/);
});

test('too many lines is refused before Myers is asked to align them', () => {
  const tall = 'x\n'.repeat(30);
  const d = diffUnified(tall, 'y\n', 'f.txt', { maxLines: 10 });
  assert.equal(d.ok, false);
  assert.match(d.reason, /over the 10-line preview limit/);
});

// ── line splitting, which everything above rests on ────────────────────────

test('splitLines keeps terminators separate and knows a lone CR', () => {
  assert.deepEqual(splitLines('a\nb\r\nc\rd').lines, ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitLines('a\nb\r\nc\rd').eols, ['\n', '\r\n', '\r', '']);
  assert.equal(splitLines('a\n').finalNewline, true);
  assert.equal(splitLines('a').finalNewline, false);
  assert.deepEqual(splitLines('').lines, [], 'an empty file has no lines, not one empty line');
  assert.equal(eolStyle(['\n', '\r\n']), 'mixed');
  assert.equal(eolStyle([]), 'none');
});

// ── the policy: granularity ────────────────────────────────────────────────

const ctx = { interactive: true, mode: 'auto' };

test('⭐ creating a new file is never queried — nothing is destroyed', () => {
  const d = approvalDecision({ path: 'src/new.js', before: null, after: 'hi\n' }, ctx);
  assert.equal(d.required, false);
  assert.equal(d.risk, 'low');
  assert.match(d.reason, /new file/);
});

test('⭐ overwriting content that existed before the run IS queried', () => {
  const d = approvalDecision({ path: 'src/index.js', before: 'old\n', after: 'new\n' }, ctx);
  assert.equal(d.required, true);
  assert.equal(d.satisfiable, true);
  assert.equal(d.risk, 'high', 'replacing the only line of a file is a rewrite, not a tweak');
});

test('⭐ rewriting a file THIS RUN created is not queried — it is a draft, not your work', () => {
  const created = new Set(['src/gen.js']);
  const d = approvalDecision(
    { path: 'src/gen.js', before: 'v1\n', after: 'v2\n' },
    { ...ctx, createdThisRun: created },
  );
  assert.equal(d.required, false);
  assert.match(d.reason, /revising its own draft/);
});

test('⚠️ a write with identical contents is never queried, even in --approve mode', () => {
  /**
   * A no-op is not a decision. Asking about one is precisely the nag that
   * `mcp-consent.mjs` calls worse than no prompt, because it trains the reflex
   * that answers the question that mattered.
   */
  for (const mode of ['auto', 'always']) {
    const d = approvalDecision({ path: 'a.txt', before: 'same\n', after: 'same\n' }, { ...ctx, mode });
    assert.equal(d.required, false, mode);
    assert.equal(d.risk, 'none');
  }
});

test('deleting a pre-existing file is the highest risk there is', () => {
  const d = approvalDecision({ path: 'src/index.js', before: 'x\n', after: null }, ctx);
  assert.equal(d.required, true);
  assert.equal(d.risk, 'high');
  assert.match(d.reason, /DELETED/);
});

test('deleting a file this run created is not queried', () => {
  const d = approvalDecision(
    { path: 'tmpfile.js', before: 'x\n', after: null },
    { ...ctx, createdThisRun: new Set(['tmpfile.js']) },
  );
  assert.equal(d.required, false);
});

test('a build directory is downgraded; a source file next to it is not', () => {
  assert.equal(isScratchPath('dist/app.js'), true);
  assert.equal(isScratchPath('src/dist-helper.js'), false, 'a prefix match must not eat a file that merely starts with the same letters');
  const scratch = approvalDecision({ path: 'dist/app.js', before: 'a\n', after: 'b\n' }, ctx);
  assert.equal(scratch.required, false);
  const source = approvalDecision({ path: 'src/app.js', before: 'a\n', after: 'b\n' }, ctx);
  assert.equal(source.required, true);
});

test('⚠️ a credential path is high risk whatever else is true about it', () => {
  const inScratch = approvalDecision(
    { path: 'dist/.env', before: 'A=1\n', after: 'A=2\n' },
    { ...ctx, createdThisRun: new Set(['dist/.env']) },
  );
  assert.equal(inScratch.risk, 'high');
  assert.equal(inScratch.required, true, 'neither "I made it" nor "it is in dist/" makes a credential file safe');
});

test('⚠️ .acuvo/ is high risk — it decides what the NEXT run may do', () => {
  assert.equal(isProtectedConfigPath('.acuvo/mcp.json'), true);
  assert.equal(isProtectedConfigPath('src/.acuvo-notes.md'), false);
  const d = approvalDecision({ path: '.acuvo/mcp.json', before: null, after: '{}\n' }, ctx);
  assert.equal(d.risk, 'high');
  assert.equal(d.required, true, 'a NEW mcp.json names a binary to spawn — creating one is the attack, not overwriting one');
});

test('a large rewrite is labelled differently from a small edit, and says the numbers', () => {
  const before = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const small = before.replace('line 4\n', 'line four\n');
  const gutted = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\n';

  assert.equal(writeRisk({ path: 'a.js', before, after: small, existedBefore: true, existsAfter: true, madeByThisRun: false }).level, 'medium');
  const big = writeRisk({ path: 'a.js', before, after: gutted, existedBefore: true, existsAfter: true, madeByThisRun: false });
  assert.equal(big.level, 'high');
  assert.match(big.why, /90 of its 100 pre-existing lines/);
});

test('⚠️ "it exists but we could not read it" is the riskiest case, not a missing one', () => {
  const d = approvalDecision({ path: 'big.bin', before: undefined, exists: true, after: 'x' }, ctx);
  assert.equal(d.risk, 'high');
  assert.match(d.reason, /could not be read/);
  assert.doesNotMatch(d.reason, /1 of its 1/, 'a fabricated line count reads like a measurement');
});

// ── the policy: no terminal ────────────────────────────────────────────────

test('⚠️⚠️ no terminal, default mode: the write lands, is marked unreviewed, and SAYS SO', () => {
  /**
   * The alternative — refusing — breaks every CI run, every `--parallel` job
   * and the whole fleet on the day it merges. The workaround people reach for
   * is `ACUVO_APPROVE=never` in a shell profile, which switches review off on
   * their laptop too. A gate that breaks unattended runs gets globally
   * disabled, and then it protects nobody.
   */
  const d = approvalDecision({ path: 'src/index.js', before: 'old\n', after: 'new\n' }, { mode: 'auto', interactive: false });
  assert.equal(d.required, false);
  assert.equal(d.satisfiable, false);
  assert.equal(d.blocked, false);
  assert.equal(d.reviewed, false, 'the run summary has to be able to count these honestly');
  assert.match(d.reason, /WITHOUT review/);
  assert.match(d.reason, new RegExp(`${APPROVE_ENV}=always`), 'the fail-open branch must name the way to make it fail closed');
});

test('⚠️⚠️ no terminal, --approve: it refuses, because somebody stated an intent we cannot honour', () => {
  const d = approvalDecision({ path: 'src/index.js', before: 'old\n', after: 'new\n' }, { mode: 'always', interactive: false });
  assert.equal(d.required, true);
  assert.equal(d.satisfiable, false);
  assert.equal(d.blocked, true);
  assert.match(d.reason, /nobody here to ask/);
  assert.match(d.reason, /hang this run/);
  // ⭐ Three ways out, not one. A refusal naming a single escape gets that
  // escape adopted permanently, which is how a gate quietly disappears.
  assert.match(d.reason, /terminal/);
  assert.match(d.reason, /--yes/);
  assert.match(d.reason, new RegExp(`${APPROVE_ENV}=auto`));
});

test('--yes switches review off, and that is a recorded choice rather than a silent one', () => {
  const d = approvalDecision({ path: 'src/index.js', before: 'x\n', after: null }, { mode: 'never', interactive: true });
  assert.equal(d.required, false);
  assert.match(d.reason, /review is switched off/);
});

test('"all remaining" from an earlier answer suppresses later questions', () => {
  const d = approvalDecision({ path: 'src/index.js', before: 'a\n', after: 'b\n' }, { ...ctx, sessionApproved: true });
  assert.equal(d.required, false);
  assert.match(d.reason, /all remaining/);
});

test('--approve asks about writes auto would wave through, but never about the no-ops', () => {
  const newFile = approvalDecision({ path: 'src/new.js', before: null, after: 'hi\n' }, { mode: 'always', interactive: true });
  assert.equal(newFile.required, true);
  assert.equal(newFile.satisfiable, true);
});

test('⚠️ an unknown ACUVO_APPROVE value is an error, not a quiet fallback to the default', () => {
  assert.deepEqual(approvalMode({ env: {} }), { ok: true, mode: 'auto', from: 'default' });
  assert.equal(approvalMode({ env: { [APPROVE_ENV]: 'ALWAYS' } }).mode, 'always');
  const bad = approvalMode({ env: { [APPROVE_ENV]: 'nver' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /auto, always, never/, 'a misspelled gate that silently means "no gate" is the exact accident policy.mjs refuses by name');
  assert.equal(approvalMode({ flag: 'never' }).mode, 'never');
  assert.equal(approvalMode({ flag: 'sometimes' }).ok, false);
});

// ── the answer ─────────────────────────────────────────────────────────────

test('⚠️⚠️ everything that is not a yes is not a yes', () => {
  assert.equal(interpretAnswer('y').decision, 'approve');
  assert.equal(interpretAnswer(' YES ').decision, 'approve');
  assert.equal(interpretAnswer('a').decision, 'approve-all');
  assert.equal(interpretAnswer('n').decision, 'reject');
  assert.equal(interpretAnswer('').decision, 'reject', 'return-by-accident must never apply a change');
  assert.equal(interpretAnswer('q').decision, 'abort');
  assert.equal(interpretAnswer('sure why not').decision, 'reject');
  assert.match(interpretAnswer('sure why not').reason, /y \/ n \/ a \/ q/, 'a refusal has to say which letters work');
});

test('⚠️⚠️ a stream that dies mid-question is an ABORT, never consent', () => {
  const r = interpretAnswer(null);
  assert.equal(r.decision, 'abort');
  assert.match(r.reason, /silence is not consent/);
  assert.equal(interpretAnswer(undefined).decision, 'abort');
});

// ── the terminal view ──────────────────────────────────────────────────────

test('the view carries the counts, the diff and the exact prompt', () => {
  const d = diffUnified('a\nb\nc\n', 'a\nB\nc\nd\n', 'src/x.js');
  const decision = approvalDecision({ path: 'src/x.js', before: 'a\nb\nc\n', after: 'a\nB\nc\nd\n' }, ctx);
  const { body, prompt } = renderApproval(d, decision);
  assert.match(body, /src\/x\.js/);
  assert.match(body, /\+2/);
  assert.match(body, /−1/);
  assert.match(body, /^\s+-b$/m);
  assert.match(body, /^\s+\+B$/m);
  assert.equal(prompt, approvalPrompt('src/x.js', 'replaced'));
  assert.match(prompt, /\[y\]es \/ \[n\]o \/ \[a\]ll remaining \/ \[q\]uit/);
  assert.ok(!body.includes(prompt), 'the prompt is returned separately — a body containing it prints the question twice');
});

test('the prompt names the ACT: a deletion does not ask you to "apply a change"', () => {
  assert.match(approvalPrompt('a.js', 'deleted'), /^\s+Delete a\.js\?/);
  assert.match(approvalPrompt('a.js', 'created'), /^\s+Create a\.js\?/);
  assert.match(approvalPrompt('a.js', 'replaced'), /^\s+Apply this change to a\.js\?/);
});

test('⚠️ the truncation STATES the cap and how to lift it', () => {
  const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n') + '\n';
  const after = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\n') + '\n';
  const lines = renderDiff(diffUnified(before, after, 'f.txt'), { cap: 5 });
  assert.equal(lines.length, 6, '5 diff lines plus the line that explains the cap');
  const last = lines[lines.length - 1];
  assert.match(last, /more diff lines hidden/);
  assert.match(last, /the cap is 5/);
  assert.match(last, new RegExp(DIFF_LINES_ENV), '"and more" with no way to see the rest is the same as saying nothing');
});

test('an uncapped diff has no truncation line at all', () => {
  const lines = renderDiff(diffUnified('a\n', 'b\n', 'f.txt'), { cap: 100 });
  assert.ok(!lines.some((l) => /hidden/.test(l)), 'a guard that fires on ordinary work is worse than no guard');
});

test('previewLineCap honours the override and ignores nonsense rather than crashing', () => {
  assert.equal(previewLineCap({ env: {}, fallback: 60 }), 60);
  assert.equal(previewLineCap({ env: { [DIFF_LINES_ENV]: '200' } }), 200);
  assert.equal(previewLineCap({ env: { [DIFF_LINES_ENV]: 'lots' }, fallback: 60 }), 60);
  assert.equal(previewLineCap({ env: { [DIFF_LINES_ENV]: '0' }, fallback: 60 }), 60);
});

test('⚠️ a whitespace-only change is annotated, because nobody spots it by looking', () => {
  const lines = renderDiff(diffUnified('const a = 1;\n', 'const a = 1; \n', 'f.js'), { cap: 20 });
  assert.ok(lines.some((l) => /trailing whitespace only/.test(l)),
    '-const a = 1; over +const a = 1;  are the same pixels in every terminal ever made');
});

test('a change that cannot be drawn still shows sizes and the reason', () => {
  const d = diffUnified('ok\n', `x${NUL}y`, 'logo.png');
  const { body } = renderApproval(d, { risk: 'high', reason: 'high risk' });
  assert.match(body, /bytes → \d+ bytes/);
  assert.match(body, /cannot be shown/);
  assert.match(body, /NUL byte/);
});

test('renderUnified output is a diff, not a description of one', () => {
  const d = diffUnified('a\n', 'b\n', 'f.txt');
  assert.equal(renderUnified(d), '--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n+b',
    'single-line ranges omit the count, exactly like git, so the output pastes into git apply');
});

// ── the whole thing, composed, with no TTY ─────────────────────────────────

/**
 * ⭐ THE GATE, ASSEMBLED FROM THE EXPORTED PIECES.
 *
 * The lead wires the real one into `workspace.mjs`; this is the same loop
 * written out here so the test proves the parts COMPOSE, not merely that each
 * part returns the right object in isolation. `only the end-to-end run proves
 * reach` — four separately-correct functions that nobody can assemble is the
 * defect this repo has shipped repeatedly.
 */
async function runGate(writes, { ask, interactive, mode = 'auto', createdThisRun = new Set() }) {
  const applied = [];
  const skipped = [];
  const asked = [];
  let sessionApproved = false;

  for (const w of writes) {
    const decision = approvalDecision(w, { mode, interactive, createdThisRun, sessionApproved });
    if (decision.blocked) { skipped.push({ path: w.path, why: decision.reason }); continue; }
    if (!decision.required) { applied.push(w.path); continue; }

    const diff = diffUnified(w.before, w.after, w.path);
    const view = renderApproval(diff, decision);
    asked.push(view.prompt);
    const answer = await ask(view.prompt);
    const { decision: verdict } = interpretAnswer(answer);
    if (verdict === 'approve') applied.push(w.path);
    else if (verdict === 'approve-all') { sessionApproved = true; applied.push(w.path); } else if (verdict === 'abort') { skipped.push({ path: w.path, why: 'aborted' }); break; } else skipped.push({ path: w.path, why: 'declined' });
  }
  return { applied, skipped, asked };
}

const FORTY = Array.from({ length: 40 }, (_, i) => ({ path: `src/gen${i}.js`, before: null, after: `export const n = ${i};\n` }));

test('⭐⭐ a 40-file build asks ZERO questions when all 40 are new files', async () => {
  /**
   * This is the granularity claim, measured. Forty prompts is a reflex trainer;
   * the run that matters is the one where question number one is a real one.
   */
  const r = await runGate(FORTY, { ask: async () => { throw new Error('must not ask'); }, interactive: true });
  assert.equal(r.asked.length, 0);
  assert.equal(r.applied.length, 40);
});

test('⭐ the same build asks exactly once when one write overwrites your work', async () => {
  const writes = [...FORTY.slice(0, 5), { path: 'src/index.js', before: 'yours\n', after: 'mine\n' }];
  const r = await runGate(writes, { ask: async () => 'y', interactive: true });
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0], /src\/index\.js/);
  assert.deepEqual(r.applied.slice(-1), ['src/index.js']);
});

test('"all remaining" stops the questioning for the rest of the run', async () => {
  const writes = Array.from({ length: 4 }, (_, i) => ({ path: `src/f${i}.js`, before: 'old\n', after: 'new\n' }));
  const r = await runGate(writes, { ask: async () => 'a', interactive: true });
  assert.equal(r.asked.length, 1, 'disengagement recorded once beats disengagement simulated four times');
  assert.equal(r.applied.length, 4);
});

test('a "no" leaves the file alone and the run continues', async () => {
  const writes = [
    { path: 'src/a.js', before: 'old\n', after: 'new\n' },
    { path: 'src/b.js', before: null, after: 'new\n' },
  ];
  const r = await runGate(writes, { ask: async () => 'n', interactive: true });
  assert.deepEqual(r.applied, ['src/b.js']);
  assert.deepEqual(r.skipped.map((s) => s.path), ['src/a.js']);
});

test('⚠️⚠️ the gate REACHES AN END with a non-TTY stdin instead of waiting for input', async () => {
  /**
   * The whole point. `node --test` is not a TTY, so this test running at all is
   * half the proof; the other half is that `createAsker` really does return null
   * for the stream we hand it, and that the gate then completes rather than
   * calling an asker that does not exist.
   *
   * ⚠️ If any code path here blocked on input, this file would HANG rather than
   * fail — the least legible failure there is, and the one `prompt.mjs` refuses.
   */
  const piped = Readable.from(['y\n']);
  assert.notEqual(piped.isTTY, true, 'a piped stream is the hostile case');
  const asker = createAsker({ input: piped, output: process.stdout });
  assert.equal(asker, null, 'no asker exists here, so the gate must not try to use one');

  const writes = [{ path: 'src/index.js', before: 'yours\n', after: 'mine\n' }];
  const r = await runGate(writes, {
    ask: async () => { throw new Error('the gate asked a question with nobody to answer it'); },
    interactive: asker !== null,
  });
  assert.deepEqual(r.applied, ['src/index.js']);
  assert.equal(r.asked.length, 0);
});

test('⚠️ --approve with a non-TTY stdin refuses the write instead of hanging or writing', async () => {
  const writes = [{ path: 'src/index.js', before: 'yours\n', after: 'mine\n' }];
  const r = await runGate(writes, {
    ask: async () => { throw new Error('must not ask'); },
    interactive: false,
    mode: 'always',
  });
  assert.deepEqual(r.applied, []);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].why, /nobody here to ask/);
});

test('⚠️⚠️ a pipe that runs dry mid-question resolves to an abort, never to a yes', async () => {
  /**
   * The real `askOnce` against a real stream that ends without an answer. This
   * is the exact shape that once left a promise pending forever, and the reason
   * `interpretAnswer(null)` is an abort rather than a default.
   */
  const empty = Readable.from([]);
  const answer = await askOnce('go? ', { input: empty, output: { write() {} } });
  assert.equal(answer, null);
  assert.equal(interpretAnswer(answer).decision, 'abort');
});

// ── planning a batch ───────────────────────────────────────────────────────

test('planApprovals splits a batch into the short list a person is actually asked', () => {
  const writes = [
    { path: 'src/new.js', before: null, after: 'a\n' },
    { path: 'src/index.js', before: 'old\n', after: 'new\n' },
    { path: 'README.md', before: 'x\n', after: 'x\n' },
    { path: 'src/gone.js', before: 'x\n', after: null },
  ];
  const plan = planApprovals(writes, ctx);
  assert.equal(plan.decisions.length, 4);
  assert.deepEqual(plan.ask.map((d) => d.path), ['src/index.js', 'src/gone.js']);
  assert.equal(plan.auto.length, 2);
  const line = summariseApprovals(plan);
  assert.match(line, /4 files to write/);
  assert.match(line, /2 need your approval/);
});

test('planApprovals reports the blocked ones separately from the unreviewed ones', () => {
  const writes = [{ path: 'src/index.js', before: 'old\n', after: 'new\n' }];
  const blocked = planApprovals(writes, { mode: 'always', interactive: false });
  assert.equal(blocked.blocked.length, 1);
  assert.equal(blocked.unreviewed.length, 0);
  const open = planApprovals(writes, { mode: 'auto', interactive: false });
  assert.equal(open.blocked.length, 0);
  assert.equal(open.unreviewed.length, 1);
  assert.match(summariseApprovals(open), /1 will land without review/);
});
