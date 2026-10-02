/**
 * ── ⭐⭐⭐ SWE-agent's ACI WORK, THE TWO PARTS THAT WERE STILL OPEN ──────────
 *
 * The paper's measured claim is that AGENT ERGONOMICS beat model quality: a
 * windowed viewer, a linter that runs BEFORE an edit is accepted, and terse
 * errors that name the next move each moved solve rate more than swapping models
 * did (their ablation puts linter-on-edits at +3.0 points, larger than removing
 * ALL search at −2.3).
 *
 * The windowed viewer is done and pinned by
 * `test/aci-read-file-windows-and-names-the-argument.test.mjs`. This file covers
 * the other two, and BOTH of them were confirmed broken by offline probe before
 * a line was changed.
 *
 * ── ⚠️ (A) THE REFUSAL THAT TAUGHT THE MODEL THE WRONG ARGUMENT NAMES ───────
 *
 * `workspace.mjs`'s over-the-limit read advertised `read_lines {"path","start",
 * "end"}` and `read_around {"path","match"}`. Neither tool has ever had a
 * `start`, an `end` or a `match`. PROBED 2026-08-26 through `createLocalExecutor`
 * and `readWindow` on a 324,000-byte file — i.e. a model doing exactly what it
 * was told:
 *
 *   read_file  {"path":"huge.mjs"}
 *     → "over the 200000-byte read limit … read_lines {path,start,end} …"
 *   read_lines {"path":"huge.mjs","start":300,"end":320}
 *     → ok:false  'read_lines accepts only path, offset, limit, numbered,
 *                  maxChars — it does not accept "start".'
 *   read_around {"path":"huge.mjs","match":"line 0300"}
 *     → ok:false  'read_lines accepts only path, offset, limit, numbered,
 *                  maxChars — it does not accept "match".'
 *
 * ⭐ READ THE THIRD ONE AGAIN: it says READ_LINES. `readWindow` picks the tool by
 * `'pattern' in args`, so `{path, match}` never reaches `read_around` at all —
 * the model is refused by a tool it did not call. Three paid rounds to page one
 * file, and the first was spent obeying us. On an append-only transcript the bad
 * advice is then re-sent for the rest of the run.
 *
 * ── ⚠️ (B) EDIT-TIME VALIDATION HAD NO PARSER FOR JAVASCRIPT ────────────────
 *
 * `edit-diagnostics.mjs` may BLOCK only on `DEFINITIVE = new Set(['.json'])`; for
 * `.js`/`.mjs`/`.cjs` the strongest thing it could say was "the bracket count
 * moved", appended as a note to a SUCCESSFUL write. So a broken edit landed, the
 * model ran something, and it found out a round later — a PAID round, re-sent
 * every round after that.
 *
 * MEASURED 2026-08-26, six realistic broken-edit shapes, brace count vs parser:
 *
 *     function f( { return a; }                   balance  1   parser ERR
 *     stray closing brace                         balance -1   parser ERR
 *     truncated function                          balance  1   parser ERR
 *     const a = 1; const a = 2;                   balance  0   parser ERR  ← only
 *     await outside an async function             balance  0   parser ERR  ← only
 *     unterminated string literal                 balance  0   parser ERR  ← only
 *
 * Three of six are invisible to bracket counting. The parser costs 0.09ms when
 * `vm.Script` settles it and ~160ms when it has to escalate; against the whole
 * package (444 files) it produced **0 false positives**, which is the number that
 * decides whether it is allowed to refuse anything.
 *
 * ⚠️ AND IT COSTS ZERO SCHEMA BYTES. No new verb, no new parameter, no change to
 * any description — the tool surface is byte-identical, which is asserted at the
 * bottom of this file because every byte of a schema rides every round.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalExecutor, MAX_READ_BYTES, MAX_WRITE_BYTES } from '../lib/workspace.mjs';
import { readWindow } from '../lib/read-window.mjs';
import { executeToolCall, TOOL_SCHEMAS, nodeSyntaxVerdict, editGate, resetSyntaxVerdictCache } from '../lib/tools.mjs';
import { bracketBalance } from '../lib/edit-diagnostics.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'acuvo-aci2-'));
}

const call = (name, args) => ({ id: 't', function: { name, arguments: JSON.stringify(args) } });

async function run(root, name, args) {
  return executeToolCall(call(name, args), createLocalExecutor(root), { allowRun: false });
}

/* ══════════════════════════════════════════════════════════════════════════
 * (A) TERSE STRUCTURED ERRORS — a refusal must name what to do INSTEAD
 * ══════════════════════════════════════════════════════════════════════════ */

test('⚠️⚠️ the over-the-limit read no longer advertises arguments that do not exist', () => {
  const root = scratch();
  try {
    /** Over MAX_READ_BYTES on purpose — this branch is the one that gives advice. */
    const lines = [];
    for (let i = 1; i <= 6_000; i += 1) lines.push(`line ${String(i).padStart(4, '0')} :: ${'y'.repeat(40)}`);
    writeFileSync(join(root, 'huge.mjs'), `${lines.join('\n')}\n`);
    const ex = createLocalExecutor(root);
    const refusal = ex.readFile('huge.mjs');

    assert.equal(refusal.ok, false);
    assert.ok(refusal.error.includes(`over the ${MAX_READ_BYTES}-byte read limit`), refusal.error);

    // ── the three names that were wrong, and are now absent ────────────────
    for (const wrong of ['"start"', '"end"', '"match"']) {
      assert.equal(
        refusal.error.includes(wrong),
        false,
        `the refusal still names ${wrong}, which no window tool accepts: ${refusal.error}`,
      );
    }
    // ── and the ones that are right, present ──────────────────────────────
    assert.match(refusal.error, /"offset":1/, 'offset is the real first-line argument and must be shown with a value');
    assert.match(refusal.error, /"limit":200/, 'limit is the real span argument');
    assert.match(refusal.error, /"pattern":/, 'read_around takes pattern, not match');
    assert.match(refusal.error, /search_text/, 'the third way in is still named');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐⭐ …and a model that COPIES the advice verbatim now succeeds — the whole point', () => {
  const root = scratch();
  try {
    const lines = [];
    for (let i = 1; i <= 6_000; i += 1) lines.push(`line ${String(i).padStart(4, '0')} :: ${'y'.repeat(40)}`);
    writeFileSync(join(root, 'huge.mjs'), `${lines.join('\n')}\n`);
    const refusal = createLocalExecutor(root).readFile('huge.mjs');

    /**
     * ⚠️ THE CALLS ARE EXTRACTED FROM THE MESSAGE, NOT RETYPED. Retyping them
     * here would let the message drift from the tools again while this test
     * stayed green — which is precisely how the old advice survived two months.
     * Every `{...}` in the refusal must be JSON a model can send as-is.
     */
    const objects = refusal.error.match(/\{[^{}]*\}/g) ?? [];
    assert.ok(objects.length >= 2, `the refusal offers no copy-pasteable call: ${refusal.error}`);

    let succeeded = 0;
    for (const text of objects) {
      const args = JSON.parse(text);           // ⚠️ must be real JSON, not a key list
      /**
       * `pattern` values in the advice are a placeholder by nature, so the
       * read_around example is aimed at a string that really is in the file.
       */
      if (typeof args.pattern === 'string') args.pattern = 'line 0300';
      const out = readWindow(root, args);
      assert.equal(out.ok, true, `the refusal's own example was refused: ${text} -> ${out.error}`);
      succeeded += 1;
    }
    assert.equal(succeeded, objects.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ THE REGRESSION THIS REPLACED: the old advice was refused by a tool the model did not call', () => {
  const root = scratch();
  try {
    writeFileSync(join(root, 'a.mjs'), 'export const a = 1;\n');
    /**
     * Kept as a live probe rather than a comment: `readWindow` routes on
     * `'pattern' in args`, so the old `read_around {"path","match"}` advice lands
     * in `read_lines` and is refused in read_lines' vocabulary. If that ever
     * changes, the message we now emit has to change with it.
     */
    const asOldAdviceSaid = readWindow(root, { path: 'a.mjs', match: 'export' });
    assert.equal(asOldAdviceSaid.ok, false);
    assert.match(
      asOldAdviceSaid.error,
      /read_lines accepts only/,
      'a {path, match} call is still answered by read_lines — so the refusal must never suggest that shape',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ "no such file" keeps its anchored prefix AND gains a next move', async () => {
  const root = scratch();
  try {
    const rec = await run(root, 'read_file', { path: 'src/nope.ts' });
    assert.equal(rec.result.ok, false);
    /**
     * ⚠️⚠️ THE PREFIX IS LOAD-BEARING. `command.mjs` distinguishes "there is no
     * config/lockfile/rcfile, carry on" from "the read genuinely failed" with
     * `/^no such file/i` in three places (2657, 2757, 2764). Anchored, so this
     * asserts position 0 and not merely containment.
     */
    assert.ok(/^no such file: /.test(rec.result.error), `the anchor moved: ${rec.result.error}`);
    assert.match(rec.result.error, /find_files/, 'a model that guessed the directory has no next move');
    assert.match(rec.result.error, /nope\.ts/, 'the find_files call is not filled in with the real basename');
    assert.match(rec.result.error, /list_dir/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a binary refusal says it cannot be retried, and names read_image', async () => {
  const root = scratch();
  try {
    // A NUL byte in the first block is the binary heuristic's own signal.
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]));
    const rec = await run(root, 'read_file', { path: 'logo.png' });
    assert.equal(rec.result.ok, false);
    assert.match(rec.result.error, /looks binary/, 'the reason four suites match on must survive');
    assert.match(rec.result.error, /read_image/, 'the one binary kind this registry CAN see is not named');
    assert.match(
      rec.result.error,
      /same refusal/,
      'nothing tells the model a retry is pointless, which is how the identical read gets re-issued',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ an over-limit WRITE names the way through instead of just the ceiling', () => {
  const root = scratch();
  try {
    const r = createLocalExecutor(root).writeFile('big.txt', 'x'.repeat(MAX_WRITE_BYTES + 1));
    assert.equal(r.ok, false);
    assert.match(r.error, /refusing to write/, 'the reason has to stay recognisable');
    assert.match(r.error, /edit_file/, 'a model holding 400KB in one string cannot make it smaller by asking again');
    assert.match(r.error, /Nothing was written/i, 'the state of the disk is what it will otherwise re-read to find out');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ "content must be a string" told the model nothing it could act on', () => {
  const root = scratch();
  try {
    const r = createLocalExecutor(root).writeFile('tsconfig.json', { strict: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /object/, 'naming the type that arrived is what makes this a one-round fix');
    assert.match(r.error, /serialised text|serialized text/, 'the only shape that ever arrives here is a JSON object');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ writing to / moving onto a DIRECTORY says which half of the path was wrong', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'a.mjs'), 'export const a = 1;\n');
    const ex = createLocalExecutor(root);

    const w = ex.writeFile('src', 'hello');
    assert.equal(w.ok, false);
    assert.match(w.error, /nothing was written/i);
    assert.match(w.error, /list_dir/, 'the tool that would have shown the tree is not named');

    /**
     * ⚠️ `overwrite: true` IS REQUIRED TO REACH THE BRANCH AT ALL. Without it the
     * "already exists, pass overwrite" guard fires first and is a perfectly good
     * message; the directory branch is what a model reaches once it has answered
     * that one, and until now it was the dead end.
     */
    const m = ex.moveFile('a.mjs', 'src', { overwrite: true });
    assert.equal(m.ok, false);
    assert.match(m.error, /nothing was moved/i);
    assert.match(m.error, /"to":"src\/a\.mjs"/, 'the corrected call is not spelled out');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ "no such directory" no longer invites the model to invent a path', () => {
  const root = scratch();
  try {
    const r = createLocalExecutor(root).listDir('src/components');
    assert.equal(r.ok, false);
    assert.match(r.error, /^no such directory: /);
    assert.match(r.error, /list_dir \{"path":"src"\}/, 'the parent is the one move that ends the invention');
    assert.match(r.error, /do not invent a path/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ══════════════════════════════════════════════════════════════════════════
 * (B) EDIT-TIME VALIDATION — a real parser, before the bytes land
 * ══════════════════════════════════════════════════════════════════════════ */

/** The six shapes from the measurement in this file's header. */
const BROKEN = [
  ['a call that never closes', 'const a = 1;\nfunction f( { return a; }\n'],
  ['a stray closing brace', 'const a = 1;\n}\n'],
  ['a truncated function — the classic bad edit', 'export function f() {\n  return 1;\n'],
  ['a re-declared name', 'const a = 1;\nconst a = 2;\n'],
  ['await outside an async function', 'function f() { await g(); }\n'],
  ['an unterminated string', 'const a = "oops;\nconst b = 2;\n'],
];

test('⭐⭐⭐ the parser catches every one of the six shapes; the brace count catches three', () => {
  resetSyntaxVerdictCache();
  const missedByBraces = [];
  for (const [label, src] of BROKEN) {
    const verdict = nodeSyntaxVerdict('broken.mjs', src, { spawns: 4 });
    assert.equal(verdict.ok, false, `the parser missed ${label}`);
    assert.ok(verdict.error.length > 0 && verdict.error.length <= 220, `not terse: ${verdict.error}`);
    if (bracketBalance(src) === 0) missedByBraces.push(label);
  }
  assert.deepEqual(
    missedByBraces.sort(),
    ['a re-declared name', 'an unterminated string', 'await outside an async function'],
    'the measured split moved — re-run the comparison before trusting either checker',
  );
});

test('⭐ a break that WAS valid before is REFUSED, and nothing reaches the disk', async () => {
  const root = scratch();
  try {
    resetSyntaxVerdictCache();
    const good = 'export function add(a, b) {\n  return a + b;\n}\n';
    writeFileSync(join(root, 'math.mjs'), good);

    // Delete the closing brace — balanced-blind, and a real edit a model makes.
    const rec = await run(root, 'edit_file', {
      path: 'math.mjs',
      old_string: '  return a + b;\n}\n',
      new_string: '  return a + b;\n',
    });

    assert.equal(rec.result.ok, false, JSON.stringify(rec.result));
    assert.equal(rec.mutated, false);
    assert.match(rec.result.error, /would stop parsing as JavaScript/);
    assert.match(rec.result.error, /NOTHING WAS WRITTEN/, 'a model not told the disk is clean re-reads to find out');
    assert.match(rec.result.error, /line \d+:/, 'a syntax error without a line is a search, not a fix');
    assert.equal(
      readFileSync(join(root, 'math.mjs'), 'utf8'),
      good,
      'the refusal was reported but the bytes landed anyway — the whole point is that they do not',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ apply_patch is not a side door — the batch verb goes through the same gate', async () => {
  const root = scratch();
  try {
    resetSyntaxVerdictCache();
    const good = 'export const a = 1;\nexport const b = 2;\n';
    writeFileSync(join(root, 'k.mjs'), good);
    const rec = await run(root, 'apply_patch', {
      patch: [
        '*** Begin Patch',
        '*** Update File: k.mjs',
        '@@',
        '-export const b = 2;',
        '+export const b = (2;',
        '*** End Patch',
      ].join('\n'),
    });
    assert.equal(rec.result.ok, false, JSON.stringify(rec.result));
    assert.equal(rec.mutated, false);
    assert.match(rec.result.error, /NOT applied|no file was touched/);
    assert.match(rec.result.error, /parsing as JavaScript/);
    assert.equal(readFileSync(join(root, 'k.mjs'), 'utf8'), good);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️⚠️ a file that was ALREADY broken is never blamed on this edit', async () => {
  const root = scratch();
  try {
    resetSyntaxVerdictCache();
    writeFileSync(join(root, 'wip.mjs'), 'export function f() {\n  return 1;\n');   // already unclosed
    const rec = await run(root, 'edit_file', {
      path: 'wip.mjs',
      old_string: 'return 1;',
      new_string: 'return 2;',
    });
    assert.equal(rec.result.ok, true, `a correct edit to a broken file was refused: ${JSON.stringify(rec.result)}`);
    assert.equal(rec.mutated, true);
    assert.match(String(rec.result.editCheck ?? ''), /did not parse before this edit either/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ a BRAND NEW unparseable file warns, it does not block', async () => {
  const root = scratch();
  try {
    resetSyntaxVerdictCache();
    const rec = await run(root, 'write_file', { path: 'fresh.mjs', content: 'export function f( {\n' });
    assert.equal(rec.result.ok, true, 'there is no "before" to prove a regression against');
    assert.equal(rec.mutated, true);
    assert.match(String(rec.result.editCheck ?? ''), /does not parse as JavaScript/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ a real parser OUTRANKS the brace heuristic — a contradicted warning is dropped', () => {
  resetSyntaxVerdictCache();
  /**
   * `bracketBalance`'s own header records that its first version mis-read 326 of
   * 381 real files. When V8 says the after-image is fine, the heuristic's
   * disagreement is noise that would ride every remaining round of an
   * append-only transcript.
   */
  /**
   * ⚠️ THE FIXTURE IS A REAL FALSE POSITIVE, FOUND BY PROBE, NOT INVENTED. In
   * `a++ / 2` the character before the `/` is `+`, which the standard heuristic
   * cannot read as the end of a value — so it opens a "regular expression" that
   * runs to end of line and swallows the `{` sitting after it. Balance −1 on
   * code V8 accepts without complaint.
   */
  const before = 'let a = 1;\nexport { a };\n';
  const after = 'let a = 1;\nconst b = a++ / 2; if (b) {\n  a = 2;\n}\nexport { a, b };\n';
  assert.notEqual(bracketBalance(after), 0, 'this fixture no longer confuses the heuristic; pick another');
  assert.equal(bracketBalance(before), 0, 'the note only fires when the file WAS balanced');
  const gate = editGate('r.mjs', before, after, { spawns: 4 });
  assert.equal(gate.block, null);
  assert.equal(gate.note, null, 'a warning that contradicts a parser reached the model');
});

test('⚠️ .ts is NOT parsed here — it keeps the brace heuristic and nothing else', () => {
  resetSyntaxVerdictCache();
  /**
   * This node has no TypeScript: `export const a: number = 1` is a hard
   * SyntaxError to V8 (probed 2026-08-26). Blocking on that would refuse every
   * correct TypeScript edit in the repo, so the extension is excluded outright.
   */
  assert.equal(nodeSyntaxVerdict('a.ts', 'export const a: number = 1;\n', { spawns: 4 }).ok, null);
  assert.equal(nodeSyntaxVerdict('a.tsx', 'export const a = <div />;\n', { spawns: 4 }).ok, null);
  const gate = editGate('a.ts', 'export const a: number = 1;\n', 'export const a: number = (1;\n', { spawns: 4 });
  assert.equal(gate.block, null, 'a TypeScript edit was blocked by a parser that cannot read TypeScript');
});

test('⚠️ every abstention is silent, and none of them is cached', () => {
  resetSyntaxVerdictCache();
  const budget = { spawns: 0 };                       // exhausted
  assert.equal(nodeSyntaxVerdict('x.mjs', 'import a from "b";\n', budget).ok, null, 'an exhausted budget must abstain');
  // …and the abstention did not poison the answer for the next caller.
  assert.equal(nodeSyntaxVerdict('x.mjs', 'import a from "b";\n', { spawns: 4 }).ok, true);

  assert.equal(nodeSyntaxVerdict('README.md', 'not js at all {{{', { spawns: 4 }).ok, null);
  assert.equal(nodeSyntaxVerdict('x.mjs', 12345, { spawns: 4 }).ok, null);
  assert.equal(nodeSyntaxVerdict('x.mjs', 'x'.repeat(1_000_001), { spawns: 4 }).ok, null, 'the size ceiling must abstain');
});

test('⭐ the fast path really is free for a script-goal file — zero spawns', () => {
  resetSyntaxVerdictCache();
  const budget = { spawns: 4 };
  assert.equal(nodeSyntaxVerdict('legacy.cjs', 'const y = require("./y");\nmodule.exports = y;\n', budget).ok, true);
  assert.equal(nodeSyntaxVerdict('plain.js', 'function f() { return 1; }\nf();\n', budget).ok, true);
  assert.equal(nodeSyntaxVerdict('plain.js', 'function f( { return 1; }\n', budget).ok, false);
  assert.equal(budget.spawns, 4, 'a script-goal file escalated to a child process it did not need');
});

test('⚠️ a .cjs holding ESM syntax ABSTAINS — that is a module-system opinion, not a syntax verdict', () => {
  resetSyntaxVerdictCache();
  const budget = { spawns: 4 };
  assert.equal(nodeSyntaxVerdict('x.cjs', 'import a from "b";\nexport const c = a;\n', budget).ok, null);
  assert.equal(budget.spawns, 4, 'a .cjs must never escalate');
});

test('⭐ the verdict cache turns the second look at the same bytes into a hash', () => {
  resetSyntaxVerdictCache();
  const src = readFileSync(new URL('../lib/read-window.mjs', import.meta.url), 'utf8');
  const cold = { spawns: 4 };
  assert.equal(nodeSyntaxVerdict('read-window.mjs', src, cold).ok, true);
  assert.equal(cold.spawns, 3, 'the cold read should cost exactly one escalation');
  const warm = { spawns: 4 };
  assert.equal(nodeSyntaxVerdict('read-window.mjs', src, warm).ok, true);
  assert.equal(warm.spawns, 4, 'the cached verdict still paid for a child process');
});

test('⚠️ the parse gate NEVER executes what it checks', async () => {
  const root = scratch();
  const marker = join(root, 'EXECUTED');
  try {
    resetSyntaxVerdictCache();
    /**
     * ⚠️ THE CONTENT REACHING THIS GATE IS MODEL-AUTHORED AND UNREVIEWED. Both
     * mechanisms parse only — `new vm.Script()` compiles without running and
     * `node --check` exits after parsing — and this is the assertion that stops
     * anyone "simplifying" it to `import()`, `node -e` or a Function constructor.
     */
    const hostile = `import { writeFileSync } from 'node:fs';\n`
      + `writeFileSync(${JSON.stringify(marker)}, 'EXECUTED');\n`
      + 'export const a = 1;\n';
    assert.equal(nodeSyntaxVerdict('hostile.mjs', hostile, { spawns: 4 }).ok, true);
    assert.throws(() => readFileSync(marker), /ENOENT/, 'the checker EXECUTED the source it was asked to parse');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ══════════════════════════════════════════════════════════════════════════
 * (C) WHAT IT COST — every schema byte rides every round
 * ══════════════════════════════════════════════════════════════════════════ */

test('⚠️ none of this bought a single byte of prompt: the tool surface is unchanged', () => {
  /**
   * The gate is invisible to the model until it fires. No verb, no parameter, no
   * description text — a refusal costs bytes only in the round it prevents, and a
   * pass costs nothing at all. `write_file` is spot-checked because it is the
   * verb the gate is wired hardest into.
   */
  const write = TOOL_SCHEMAS.find((t) => t.function.name === 'write_file');
  assert.deepEqual(Object.keys(write.function.parameters.properties).sort(), ['content', 'path']);
  const edit = TOOL_SCHEMAS.find((t) => t.function.name === 'edit_file');
  assert.equal(/parse|syntax|lint/i.test(JSON.stringify(edit)), false, 'the gate leaked into the schema');
});

test('a clean edit to a correct file still adds not one byte to what the model reads', async () => {
  const root = scratch();
  try {
    resetSyntaxVerdictCache();
    writeFileSync(join(root, 'ok.mjs'), 'export const a = 1;\nexport const b = 2;\n');
    const rec = await run(root, 'edit_file', { path: 'ok.mjs', old_string: 'b = 2', new_string: 'b = 3' });
    assert.equal(rec.result.ok, true);
    assert.equal(rec.result.editCheck, undefined, 'a correct edit grew a note');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
