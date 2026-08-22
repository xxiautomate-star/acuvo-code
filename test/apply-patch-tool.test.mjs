/**
 * ── ⭐⭐⭐ THE PATCH ENGINE EXISTED AND NOTHING COULD CALL IT ─────────────────
 *
 * `lib/apply-patch.mjs` shipped finished on 2026-08-19: 13 tests, two properties
 * mutation-proven, four matching passes, all-or-nothing semantics. It was
 * imported by NOTHING on the runtime path — this package's signature defect,
 * and the reason `test/wiring-reach.test.mjs` exists.
 *
 * ⭐ WHY IT IS THE TOP LEVER, MEASURED TODAY ON A REAL BUILD (28 model calls,
 * 378,507 prompt tokens, ~4 cents):
 *
 *     OUTPUT      $0.045 of $0.080 — 56% of the spend, ~53,000 tokens
 *     prompt cache  83.2%, and 100% steady-state — near its ceiling
 *
 * A prompt cache CANNOT discount output. So the only lever left is emitting
 * FEWER output tokens, and the output is dominated by re-emitting whole files
 * through `write_file`. A patch is 10-50x smaller than the file it changes.
 *
 * ⭐ AND IT IS AN ACCURACY FIX AS WELL AS A COST ONE: removing flexible patch
 * application caused a measured **9x increase in editing errors** across
 * harnesses (lib/apply-patch.mjs's own header).
 *
 * ── ⚠️⚠️ WHICH IS WHY MOST OF THIS FILE IS ABOUT THE WRITE GATE ─────────────
 *
 * A patch writes N files at once. Every write in this CLI goes through
 * `executor.writeFile` — leases, the `.acuvo/` leash, `--dry-run`, the plan-mode
 * read-only executor and the approval prompt all live on that one door. A bulk
 * verb that opened a second door would be a safety regression far larger than
 * the cost win, so the assertions below are mostly about what must NOT happen.
 *
 * ⭐ $0.00 — every executor here is a stub or a temp directory, and no model is
 * called. Nothing touches the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TOOL_SCHEMAS, TOOL_NAMES, toolNamesForRounds, executeToolCall, toolSchemasFor,
} from '../lib/tools.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { changedPaths } from '../lib/changed-paths.mjs';
import { BEGIN, END, formatApplyPatch } from '../lib/apply-patch.mjs';
import { planPhaseExecutor } from '../lib/cli-args.mjs';

const wrap = (body) => `${BEGIN}\n${body}\n${END}`;
const call = (args) => ({ id: 'c_1', function: { name: 'apply_patch', arguments: JSON.stringify(args) } });

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-patch-tool-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return root;
}

const A_JS = 'export const a = 1;\nexport const b = 2;\n';
const B_JS = 'export const c = 3;\nexport const d = 4;\n';

/** The two-file patch used by most of the gate tests. */
const TWO_FILE_PATCH = wrap([
  '*** Update File: a.js',
  '@@',
  '-export const a = 1;',
  '+export const a = 99;',
  '*** Update File: b.js',
  '@@',
  '-export const c = 3;',
  '+export const c = 99;',
].join('\n'));

/* ════════════════════════════════════════════════════════════════════════════
 * 1. REACHABILITY — schema + dispatch + the sentence that says it exists
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ apply_patch is declared, dispatched and OFFERED — all three, or it is not a capability', async (t) => {
  assert.ok(TOOL_NAMES.includes('apply_patch'), 'apply_patch is not in TOOL_SCHEMAS');

  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  const executor = createLocalExecutor(root);
  const rec = await executeToolCall(call({ patch: wrap('*** Update File: a.js\n@@\n-export const a = 1;\n+export const a = 7;') }), executor);
  assert.notEqual(rec.result?.error, 'unknown tool: apply_patch', 'declared but not dispatched');
  assert.equal(rec.result.ok, true, rec.result.error);

  const multi = toolNamesForRounds(8, { root, env: {}, allowRun: true });
  assert.ok(multi.includes('apply_patch'), 'a multi-round run is never offered the patch verb');
});

/**
 * ⚠️ MULTI-ROUND ONLY, and this is the same rule `tools.mjs` applies to every
 * read verb. A patch's context lines have to match the file ON DISK; when they
 * do not, the only repair is the next round. A single-shot turn has none, so the
 * verb would be a button whose failure the model can never act on — and
 * `write_file` still works there, which is why withholding it costs nothing.
 */
test('⚠️ a single-shot turn is NOT offered apply_patch — a failed hunk needs a next round', () => {
  const single = toolNamesForRounds(1, { env: {}, allowRun: true, root: process.cwd() });
  assert.ok(!single.includes('apply_patch'), 'a one-round turn cannot repair a missed hunk, so the verb is a dead button there');
});

/**
 * ⚠️ THE THIRD PART OF REACHABILITY. A schema and a handler are two thirds; the
 * sentence telling the model WHEN to reach for it is the third, and it is the
 * one this repo forgets. Without it a coder model keeps re-emitting whole files,
 * which is the 56%-of-spend the verb exists to cut.
 */
test('⭐⭐ the model is TOLD to prefer a patch over re-emitting a file, and why', () => {
  const schema = TOOL_SCHEMAS.find((s) => s.function.name === 'apply_patch');
  const d = schema.function.description;
  assert.match(d, /existing file/i, 'the description never mentions the case it is for');
  assert.match(d, /instead of|rather than|prefer/i, 'it never tells the model to choose this over write_file');
  assert.match(d, /write_file/, 'it never names the verb it is replacing');
  // The WHY, both halves — cost and reliability. A rule with no reason is one a
  // model drops the moment the task gets hard.
  assert.match(d, /output|token|cheap|cost/i, 'the cost reason is missing');
  assert.match(d, /9x|error|reliab/i, 'the reliability reason is missing');

  // ⭐ AND THE POINTER GOES BOTH WAYS. A model reading write_file's description
  // must learn the cheaper verb exists at the moment it is about to overwrite.
  const w = TOOL_SCHEMAS.find((s) => s.function.name === 'write_file').function.description;
  assert.match(w, /apply_patch/, 'write_file never mentions the cheaper verb for an existing file');
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. IT ACTUALLY EDITS DISK, AND IT IS SMALL
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐ a patch changes real files on disk and reports them in `written[]`', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  writeFileSync(join(root, 'b.js'), B_JS);
  const executor = createLocalExecutor(root);

  const rec = await executeToolCall(call({ patch: TWO_FILE_PATCH }), executor);
  assert.equal(rec.result.ok, true, rec.result.error);
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), 'export const a = 99;\nexport const b = 2;\n');
  assert.equal(readFileSync(join(root, 'b.js'), 'utf8'), 'export const c = 99;\nexport const d = 4;\n');

  /**
   * ⭐ `written[]` IS `write_files`' SHAPE ON PURPOSE (write-many.mjs:128).
   * `changed-paths.mjs` reads it, and so do report.mjs, parallel.mjs,
   * best-of.mjs and handoff.mjs — reusing it means every one of them
   * understands a patch with no arm of its own. A new `applied[]` field would
   * have needed five.
   */
  assert.deepEqual(changedPaths(rec), ['a.js', 'b.js']);
  assert.equal(rec.mutated, true);
});

test('add and delete ride in the same changeset as an update', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  writeFileSync(join(root, 'old.js'), 'gone\n');
  const executor = createLocalExecutor(root);

  const rec = await executeToolCall(call({
    patch: wrap([
      '*** Add File: new.js',
      '+export const NEW = true;',
      '*** Update File: a.js',
      '@@',
      '-export const b = 2;',
      '+export const b = 22;',
      '*** Delete File: old.js',
    ].join('\n')),
  }), executor);

  assert.equal(rec.result.ok, true, rec.result.error);
  assert.equal(readFileSync(join(root, 'new.js'), 'utf8'), 'export const NEW = true;');
  assert.match(readFileSync(join(root, 'a.js'), 'utf8'), /b = 22/);
  assert.equal(existsSync(join(root, 'old.js')), false, 'the delete never happened');
  assert.deepEqual(changedPaths(rec).sort(), ['a.js', 'new.js', 'old.js']);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. ⚠️⚠️ THE WRITE GATE — the part that makes this safe to ship
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️⚠️ A LEASE CONFLICT ON FILE TWO MUST LEAVE FILE ONE UNTOUCHED.
 *
 * This is THE test. `write_files` deliberately reports partial success and does
 * not roll back — correct there, because it is N independent writes. A patch is
 * ONE changeset: half of a refactor on disk is a repo in a state neither the
 * model nor the user expects, and the model's next read disagrees with its own
 * plan. `applyPatch` already guarantees this for APPLICATION failures by
 * computing against a copy; the executor is the other half.
 *
 * ⭐ The claimer is injected exactly as `bin/acuvo.mjs` injects the real one, so
 * this exercises the production seam rather than a mock of it.
 */
test('⚠️⚠️ another terminal holding file two means file one is NOT written', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  writeFileSync(join(root, 'b.js'), B_JS);

  const executor = createLocalExecutor(root, {
    claimPath: (p) => (p === 'b.js'
      ? { ok: false, heldBy: 'terminal-2', error: 'b.js is being written by another terminal (terminal-2) right now' }
      : { ok: true }),
  });

  const rec = await executeToolCall(call({ patch: TWO_FILE_PATCH }), executor);

  assert.equal(rec.result.ok, false, 'a patch that could not land everywhere reported success');
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), A_JS, 'HALF-APPLIED: a.js changed while b.js was refused');
  assert.equal(readFileSync(join(root, 'b.js'), 'utf8'), B_JS);
  assert.equal(rec.mutated, false, 'a changeset that landed nowhere was counted as a mutation');
  assert.deepEqual(changedPaths(rec), [], 'the run summary would claim files that never changed');
  assert.match(rec.result.error, /b\.js/, 'the refusal must name the file that blocked it');
  assert.match(rec.result.error, /terminal-2/, 'and it must carry the holder through, or nobody can act on it');
});

/**
 * ⚠️⚠️ AND WHEN THE ROLLBACK ITSELF CANNOT FINISH, SAY SO — LOUDLY.
 *
 * This is the outcome that would be worse than the half-apply: a disk full or a
 * file that turned read-only mid-changeset leaves real modifications behind, and
 * a result reading "nothing was changed" sends the model on to the next step
 * with a false picture of its own repo. The still-modified paths must land in
 * `written[]` so the run summary counts them, and the error must name them.
 *
 * ⭐ A stub executor, because this state cannot be produced reliably on a real
 * filesystem — and a stub is honest here: the only thing under test is what THIS
 * module does with a refusal it is handed.
 */
test('⚠️⚠️ a rollback that cannot restore a file reports that file as still changed', async () => {
  const disk = { 'a.js': A_JS, 'b.js': B_JS };
  let writes = 0;
  const executor = {
    root: '/stub',
    readFile: (p) => (p in disk ? { ok: true, path: p, content: disk[p], bytes: disk[p].length } : { ok: false, error: `no such file: ${p}` }),
    writeFile: (p, c) => {
      writes += 1;
      // 1: a.js lands. 2: b.js refused. 3: the restore of a.js also refused.
      if (writes === 1) { disk[p] = c; return { ok: true, path: p, bytes: c.length, created: false }; }
      return { ok: false, error: writes === 2 ? 'held by another terminal' : 'the disk is full' };
    },
    deleteFile: () => ({ ok: false, error: 'not reachable in this fixture' }),
    listDir: () => ({ ok: true, path: '.', entries: [], truncated: false }),
  };

  const rec = await executeToolCall(call({ patch: TWO_FILE_PATCH }), executor);

  assert.equal(rec.result.ok, false);
  assert.deepEqual(rec.result.rollbackFailed.map((f) => f.path), ['a.js']);
  assert.match(rec.result.error, /a\.js/, 'the file left modified is not named in the error');
  assert.match(rec.result.error, /still|could NOT be restored/i, 'the error reads as a clean failure when it is not');
  assert.equal(rec.mutated, true, 'a file IS modified on disk and the summary must own it');
  assert.deepEqual(changedPaths(rec), ['a.js']);
});

/**
 * ⚠️ THE SAME PROPERTY FOR THE OTHER REFUSALS ON THAT DOOR. `.acuvo/` decides
 * which programs this agent may spawn (workspace.mjs's `agentWriteRefusal`), so
 * a patch is exactly the shape that would sneak a policy edit in beside four
 * legitimate ones.
 */
test('⚠️⚠️ a patch that touches .acuvo/ is refused WHOLE — the leash is not half-editable', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'policy.json'), '{"maxRounds":3}\n');
  const executor = createLocalExecutor(root);

  const rec = await executeToolCall(call({
    patch: wrap([
      '*** Update File: a.js',
      '@@',
      '-export const a = 1;',
      '+export const a = 99;',
      '*** Update File: .acuvo/policy.json',
      '@@',
      '-{"maxRounds":3}',
      '+{"maxRounds":999}',
    ].join('\n')),
  }), executor);

  assert.equal(rec.result.ok, false);
  assert.equal(readFileSync(join(root, '.acuvo', 'policy.json'), 'utf8'), '{"maxRounds":3}\n', 'the agent rewrote its own leash');
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), A_JS, 'the legitimate half landed anyway — that is a half-applied patch');
  assert.equal(rec.mutated, false);
});

/**
 * ⚠️ `--plan` PROMISES "IT CANNOT WRITE WHILE IT IS PROPOSING", and
 * `planPhaseExecutor` keeps that promise by replacing `writeFile`, `deleteFile`
 * and `moveFile` with refusals. A patch verb that reached disk any other way
 * would reopen the exact hole `plan-mode-is-read-only.test.mjs` was written for.
 */
test('⚠️⚠️ a --plan proposal cannot patch anything', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  const executor = planPhaseExecutor(createLocalExecutor(root));

  const rec = await executeToolCall(call({ patch: wrap('*** Update File: a.js\n@@\n-export const a = 1;\n+export const a = 99;') }), executor);
  assert.equal(rec.result.ok, false, 'a proposal phase patched a file');
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), A_JS);
  assert.equal(rec.mutated, false);
  assert.match(rec.result.error, /plan/i, 'the refusal has to name the phase or the model retries all four rounds');
});

/**
 * ⚠️ `--dry-run` MUST PREVIEW THE WHOLE CHANGESET AND WRITE NONE OF IT — and it
 * must run every safety check first, or it is a preview of a different command.
 * `executor.writeFile` already stops at exactly the right line; going through it
 * is what buys that for free.
 */
test('⚠️ --dry-run previews every file and writes none', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  writeFileSync(join(root, 'b.js'), B_JS);
  const executor = createLocalExecutor(root, { dryRun: true });

  const rec = await executeToolCall(call({ patch: TWO_FILE_PATCH }), executor);
  assert.equal(rec.result.ok, true, rec.result.error);
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), A_JS, 'a dry run wrote to disk');
  assert.equal(readFileSync(join(root, 'b.js'), 'utf8'), B_JS, 'a dry run wrote to disk');
  assert.equal(rec.result.written.length, 2, 'the preview must still name every file that WOULD change');
  assert.ok(rec.result.written.every((f) => f.dryRun === true), 'the result does not say it was a preview');
});

/**
 * ⚠️ ONE QUESTION FOR THE WHOLE CHANGESET, carrying every path — the shape
 * `write_files` uses (tools.mjs, `case 'write_files'`). Asking per file turns
 * one intent into forty prompts, and a prompt answered forty times is answered
 * without reading by the third.
 */
test('⭐⭐ the approval gate is asked ONCE, and is shown every path in the changeset', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  writeFileSync(join(root, 'b.js'), B_JS);
  writeFileSync(join(root, 'old.js'), 'gone\n');
  const executor = createLocalExecutor(root);

  const seen = [];
  await executeToolCall(call({
    patch: wrap([
      '*** Add File: new.js',
      '+x',
      '*** Update File: a.js',
      '@@',
      '-export const a = 1;',
      '+export const a = 99;',
      '*** Delete File: old.js',
    ].join('\n')),
  }), executor, {
    approveBatch: async (writes) => { seen.push(writes); return { allowed: true }; },
  });

  assert.equal(seen.length, 1, `the batch gate fired ${seen.length} times instead of once`);
  const batch = seen[0];
  assert.deepEqual(batch.map((w) => w.path).sort(), ['a.js', 'new.js', 'old.js']);

  // The shape `approvalDecision` reads: a create has no `before`, a delete has
  // no `after`, and `exists` says which file was already there.
  const add = batch.find((w) => w.path === 'new.js');
  assert.equal(add.exists, false);
  assert.equal(add.before, null);
  const del = batch.find((w) => w.path === 'old.js');
  assert.equal(del.exists, true);
  assert.equal(del.after, null, 'a deletion must reach the reviewer as a deletion, not as an empty file');
  const upd = batch.find((w) => w.path === 'a.js');
  assert.equal(upd.before, A_JS, 'the reviewer cannot draw a diff without the previous contents');
  assert.match(upd.after, /a = 99/);
});

test('⚠️ a declined changeset writes nothing at all', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  writeFileSync(join(root, 'b.js'), B_JS);
  const executor = createLocalExecutor(root);

  const rec = await executeToolCall(call({ patch: TWO_FILE_PATCH }), executor, {
    approveBatch: async () => ({ allowed: false }),
  });
  assert.equal(rec.result.ok, false);
  assert.equal(rec.result.refused, true, 'a human "no" must read as a decision, not as a tool failure');
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), A_JS);
  assert.equal(readFileSync(join(root, 'b.js'), 'utf8'), B_JS);
  assert.equal(rec.mutated, false);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. REFUSALS THAT NAME THE WAY OUT
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️⚠️ A RENAME INSIDE A PATCH WOULD BE A SECOND MOVE PATH THAT SKIPS THE
 * CREDENTIAL GUARD. `executor.moveFile` refuses `.env` → `notes/env.txt`
 * because `git_commit` checks by PATH, so a rename is how a secret becomes
 * committable under a name the agent chose. Implementing `*** Move to:` as a
 * write plus a delete would route around that guard entirely — two doors, one
 * hardened, which is the failure this package has already paid for twice.
 */
test('⚠️⚠️ "*** Move to:" is refused and points at move_file, which carries the credential guard', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  const executor = createLocalExecutor(root);

  const rec = await executeToolCall(call({
    patch: wrap('*** Update File: a.js\n*** Move to: b.js\n@@\n-export const a = 1;\n+export const a = 9;'),
  }), executor);

  assert.equal(rec.result.ok, false);
  assert.match(rec.result.error, /move_file/, 'the refusal must name the verb that does work');
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), A_JS);
  assert.equal(existsSync(join(root, 'b.js')), false);
});

/**
 * ⚠️ ONE PATH, TWO HEADERS — the shape that would write a file twice if the plan
 * were built from the operation LOG instead of the end state. The second write's
 * `before` would be a value no longer on disk, so a rollback would restore the
 * WRONG bytes: a repair that corrupts.
 */
test('⚠️ two hunks against one file land as ONE write, in final-state form', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  const executor = createLocalExecutor(root);

  const rec = await executeToolCall(call({
    patch: wrap([
      '*** Update File: a.js',
      '@@',
      '-export const a = 1;',
      '+export const a = 11;',
      '*** Update File: a.js',
      '@@',
      '-export const b = 2;',
      '+export const b = 22;',
    ].join('\n')),
  }), executor);

  assert.equal(rec.result.ok, true, rec.result.error);
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), 'export const a = 11;\nexport const b = 22;\n');
  assert.equal(rec.result.written.length, 1, `a.js was written ${rec.result.written.length} times for one patch`);
});

/**
 * ⚠️⚠️ A ZERO-EFFECT SUCCESS IS THE WORST ANSWER AVAILABLE. Every hunk matched,
 * so the file already says what the patch asks — and reporting "ok, 0 files"
 * lets an agent send the same patch again, or report the work as done.
 */
test('⚠️⚠️ a patch that changes nothing SAYS so instead of reporting a success', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  const executor = createLocalExecutor(root);

  const rec = await executeToolCall(call({
    // The removed line and the added line are identical.
    patch: wrap('*** Update File: a.js\n@@\n-export const a = 1;\n+export const a = 1;'),
  }), executor);

  assert.equal(rec.result.ok, false, 'a no-op patch reported success with zero files');
  assert.match(rec.result.error, /changes nothing|already contain/i);
  assert.equal(rec.mutated, false);
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), A_JS);
});

test('a hunk whose context is not in the file names what it looked for, and changes nothing', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.js'), A_JS);
  const executor = createLocalExecutor(root);

  const rec = await executeToolCall(call({
    patch: wrap('*** Update File: a.js\n@@\n-export const nope = 1;\n+export const yes = 1;'),
  }), executor);
  assert.equal(rec.result.ok, false);
  assert.match(rec.result.error, /nope/, 'a refusal without the missing line costs a round of guessing');
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), A_JS);
});

test('updating a file that is not there says so instead of creating it silently', async (t) => {
  const root = workspace(t);
  const executor = createLocalExecutor(root);
  const rec = await executeToolCall(call({
    patch: wrap('*** Update File: missing.js\n@@\n-x\n+y'),
  }), executor);
  assert.equal(rec.result.ok, false);
  assert.match(rec.result.error, /missing\.js/);
  assert.equal(existsSync(join(root, 'missing.js')), false);
});

test('a missing or malformed `patch` argument is a sentence, not a crash', async (t) => {
  const root = workspace(t);
  const executor = createLocalExecutor(root);
  for (const args of [{}, { patch: '' }, { patch: 42 }, { patch: 'nonsense' }]) {
    const rec = await executeToolCall(call(args), executor);
    assert.equal(rec.result.ok, false, `${JSON.stringify(args)} was accepted`);
    assert.ok(typeof rec.result.error === 'string' && rec.result.error.length > 10);
    assert.equal(rec.mutated, false);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. THE COST CASE, STATED AS A NUMBER
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⭐ THE WHOLE POINT, ASSERTED. Output is 56% of a build's spend and a prompt
 * cache cannot discount it, so the verb only earns its schema bytes if the
 * patch really is far smaller than the file it replaces.
 */
test('⭐ a patch is an order of magnitude smaller than re-emitting the file', () => {
  const file = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  const patch = wrap('*** Update File: big.js\n@@\n-export const v100 = 100;\n+export const v100 = 101;');
  assert.ok(patch.length * 10 < file.length, `patch ${patch.length} chars vs file ${file.length} — under 10x is not worth the schema`);
});

/**
 * ⚠️ THE LOOSE-MATCH WARNING HAS TO REACH THE MODEL AS AN INSTRUCTION.
 *
 * `locateHunk` computes which of the four passes found each hunk precisely so
 * somebody can say "your copy of this file disagrees with the real one". Through
 * the JSON default that arrives as `"looseMatches":[{"pass":"trim"}]`, which
 * models read past — the same failure `read-window.mjs` measured for
 * `nextOffset`. `formatApplyPatch` states it as a sentence instead.
 *
 * ⚠️ IT IS NOT YET WIRED: `turn.mjs`'s `toolResultText` needs one `case
 * 'apply_patch'` arm, and that file is not this lane's to edit. Until it lands
 * the model gets the JSON, which is legible but silent about this.
 */
test('the model-facing formatter names the files and warns when a hunk matched loosely', () => {
  const text = formatApplyPatch({
    ok: true,
    written: [
      { path: 'a.js', bytes: 40, created: false },
      { path: 'new.js', bytes: 12, created: true },
      { path: 'old.js', bytes: 0, deleted: true },
    ],
    looseMatches: [{ path: 'a.js', pass: 'trim' }],
  });
  assert.match(text, /3 files changed/);
  assert.match(text, /patched\s+a\.js/);
  assert.match(text, /created\s+new\.js/);
  assert.match(text, /deleted\s+old\.js/);
  assert.match(text, /trim/, 'a hunk that only matched loosely was reported as a clean apply');
  assert.match(text, /Re-read it/, 'the warning has to say what to DO, or the model reads past it');

  assert.match(formatApplyPatch({ ok: false, error: 'b.js: held by terminal-2' }), /held by terminal-2/);
  assert.match(
    formatApplyPatch({ ok: true, written: [{ path: 'a.js', bytes: 4, dryRun: true }] }),
    /dry run/i,
    'a preview that reads as a write is the only way a dry run can lie',
  );
});

/**
 * ⚠️ THE SURFACE HAS A BUDGET. `declared-tools-are-named.test.mjs` holds the
 * whole offer under 60,000 bytes; this pins what THIS verb costs, so a later
 * rewrite of the description cannot quietly spend a thousand tokens a round.
 */
test('⚠️ the schema pays for itself — its own byte cost is bounded', () => {
  const bytes = JSON.stringify(toolSchemasFor(['apply_patch'])).length;
  assert.ok(bytes > 400, 'the description is too short to have told the model anything');
  assert.ok(bytes < 2_400, `apply_patch's schema is ${bytes} bytes — that is a round-tax, not a hint`);
});
