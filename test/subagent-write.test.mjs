/**
 * ── ⭐⭐ A HELPER THAT *BUILDS* — AND THE FOUR THINGS THAT MUST STAY TRUE ────
 *
 * `subagent.mjs` shipped read-only and said why: *"A subagent that writes can
 * collide with the parent editing the same file, and whoever finishes second
 * wins silently. `parallel.mjs` exists to catch exactly that between processes
 * and is blind to it here."* That is an unfinished capability, not a boundary —
 * the blindness is what `handoff.mjs` removes.
 *
 * What these tests pin, in order of what would hurt most if it broke:
 *
 *  1. ⚠️⚠️ A COLLISION IS REFUSED BY NAME. If a file changed in the real
 *     workspace while the helper worked, the helper's version must NOT land.
 *     This is the entire reason the feature was allowed to exist.
 *  2. ⚠️ `--dry-run` STILL HOLDS. The apply path goes through the parent's
 *     executor, so a dry run previews. A raw `cpSync` would have made the flag
 *     a lie the moment the model delegated.
 *  3. ⚠️ THE PARENT'S RECORD SAYS FILES MOVED. `mutated: false` on a delegate
 *     that wrote is the half-connected defect: the summary prints "nothing was
 *     written" and `--parallel` cannot see the collision.
 *  4. ⚠️ READ-ONLY IS STILL THE DEFAULT. A helper asked a question gets no
 *     write verb, and no isolated copy is even made.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runSubagent,
  summariseForParent,
  subagentToolSchemas,
  SUBAGENT_TOOL_NAMES,
  SUBAGENT_WRITE_TOOL_NAMES,
} from '../lib/subagent.mjs';
import {
  changedPaths,
} from '../lib/changed-paths.mjs';
import {
  applyHandoff,
  describeHandoff,
  fileHash,
  hashTree,
  runInIsolatedCopy,
} from '../lib/handoff.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { executeToolCall } from '../lib/tools.mjs';
import { detectConflicts } from '../lib/parallel.mjs';

/** A throwaway workspace with the given files. */
function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-hw-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

/** A fake session that performs writes in whatever root it is handed. */
function sessionThatWrites(writes, { note = 'did the thing', ok = true } = {}) {
  return async ({ executor, toolNames }) => {
    const executed = [];
    for (const [rel, content] of Object.entries(writes)) {
      const result = content === null ? executor.deleteFile(rel) : executor.writeFile(rel, content);
      executed.push({ name: content === null ? 'delete_file' : 'write_file', args: { path: rel }, result, mutated: result.ok === true });
    }
    return { ok, note, executed, roundsUsed: 1, usage: { cost: 0.0004, total_tokens: 900 }, offeredToolNames: toolNames };
  };
}

// ── 1. THE COLLISION CHECK ──────────────────────────────────────────────────

test('⚠️⚠️ a file that changed in the workspace while the helper worked is REFUSED, not overwritten', async () => {
  const root = workspace({ 'a.txt': 'original\n', 'b.txt': 'untouched\n' });
  try {
    const executor = createLocalExecutor(root);
    const result = await runSubagent(
      { task: 'rewrite a.txt and b.txt', executor, config: { apiKey: 'x' }, write: true },
      {
        sessionImpl: async ({ executor: copyExec }) => {
          /**
           * ⭐ THE RACE, STAGED EXACTLY. While the helper is mid-session, a
           * DIFFERENT terminal edits a.txt in the real workspace. The helper
           * knows nothing about it — it is working in a copy.
           */
          writeFileSync(join(root, 'a.txt'), 'somebody else got here first\n', 'utf8');
          const w1 = copyExec.writeFile('a.txt', 'helper version\n');
          const w2 = copyExec.writeFile('b.txt', 'helper version\n');
          return {
            ok: true,
            note: 'rewrote both',
            executed: [
              { name: 'write_file', args: { path: 'a.txt' }, result: w1, mutated: true },
              { name: 'write_file', args: { path: 'b.txt' }, result: w2, mutated: true },
            ],
            roundsUsed: 2,
            usage: { cost: 0.0005, total_tokens: 1200 },
          };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.written.map((w) => w.path), ['b.txt'], 'the uncontested file must land');
    assert.equal(result.refused.length, 1, 'the contested file must be refused');
    assert.equal(result.refused[0].path, 'a.txt');

    assert.equal(
      readFileSync(join(root, 'a.txt'), 'utf8'),
      'somebody else got here first\n',
      "the other terminal's work must survive — silently overwriting it is the whole failure this feature was blocked on",
    );
    assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'helper version\n');

    assert.match(result.summary, /NOT applied/, 'the parent must be TOLD, or it reports the helper\'s intention as fact');
    assert.match(result.summary, /a\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file the helper CREATED lands, and one it DELETED is deleted for real', async () => {
  const root = workspace({ 'old.txt': 'goodbye\n' });
  try {
    const executor = createLocalExecutor(root);
    const result = await runSubagent(
      { task: 'swap the files', executor, config: { apiKey: 'x' }, write: true },
      { sessionImpl: sessionThatWrites({ 'new/deep.txt': 'hello\n', 'old.txt': null }) },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.written.map((w) => w.path).sort(), ['new/deep.txt', 'old.txt']);
    assert.equal(readFileSync(join(root, 'new', 'deep.txt'), 'utf8'), 'hello\n');
    assert.equal(existsSync(join(root, 'old.txt')), false, 'apply must mean apply, including a deletion');

    /**
     * ── ⚠️⚠️ THE DETAIL, FROM THE REAL APPLY PATH ────────────────────────────
     *
     * A mutation that hardcoded `created: false` SURVIVED the first version of
     * this suite, because the only test that looked at `created` used a fake
     * `subagentImpl` and never exercised `applyHandoff`. So the plumbing from
     * `executor.writeFile`'s return value into `written[]` was untested, and it
     * is exactly the plumbing whose absence printed "replaced … (0 bytes)" for
     * a 510-byte creation on a real run.
     */
    const made = result.written.find((w) => w.path === 'new/deep.txt');
    assert.equal(made.created, true, 'a new file is CREATED — reporting it as a replacement is the defect a real run caught');
    assert.equal(made.bytes, 6, 'the byte count comes from the executor, not from a zero');
    assert.equal(made.previousBytes, 0);

    const gone = result.written.find((w) => w.path === 'old.txt');
    assert.equal(gone.deleted, true, 'a deletion reported as "replaced with 0 bytes" reads as the agent BLANKING the file');
    assert.equal(gone.previousBytes, 8, 'and it remembers how big the file was before it went');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 2. `--dry-run` SURVIVES DELEGATION ──────────────────────────────────────

/**
 * ── ⚠️⚠️ THIS TEST CAUGHT A REAL DEFECT, BY SURVIVING A MUTATION ────────────
 *
 * The first version asserted only "the file on disk is unchanged". A mutation
 * that removed the dry-run inheritance from the helper's executor left it
 * GREEN — a check that cannot fail. The probe that followed showed the
 * inheritance was itself wrong: a `--dry-run` write is a no-op, so a file the
 * helper CREATED never appeared in the copy, and the apply step correctly
 * inferred "the helper deleted this" and reported `no such file — nothing was
 * deleted` for a brand-new file.
 *
 * ⭐ So the test now pins BOTH halves, and each half fails to a different
 * mutation: the user's disk is untouched (apply goes through the parent's
 * executor), AND the preview describes the work the helper actually did.
 */
test('⚠️ a --dry-run parent changes NOTHING on disk, and still previews the REAL work', async () => {
  const root = workspace({ 'a.txt': 'original\n' });
  try {
    const executor = createLocalExecutor(root, { dryRun: true });
    const result = await runSubagent(
      { task: 'rewrite a.txt and add one', executor, config: { apiKey: 'x' }, write: true },
      { sessionImpl: sessionThatWrites({ 'a.txt': 'helper version\n', 'brand-new.txt': 'hello\n' }) },
    );
    assert.equal(result.ok, true);

    // Half one: the promise.
    assert.equal(
      readFileSync(join(root, 'a.txt'), 'utf8'),
      'original\n',
      'the apply path goes through the parent executor precisely so --dry-run cannot be walked around',
    );
    assert.equal(existsSync(join(root, 'brand-new.txt')), false);

    // Half two: the preview has to be a preview of the real thing.
    assert.deepEqual(
      result.written.map((w) => w.path).sort(),
      ['a.txt', 'brand-new.txt'],
      'a created file must be previewed as a WRITE — inheriting dryRun into the copy made it a failed DELETE',
    );
    assert.equal(result.summary.includes('nothing was deleted'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ the helper cannot write into .acuvo/ — the leash lives on the executor and the apply path uses it", async () => {
  const root = workspace({ 'a.txt': 'x\n' });
  try {
    const executor = createLocalExecutor(root);
    // The helper's OWN executor refuses first; this pins that the refusal is
    // real rather than an artefact of the copy not containing .acuvo/.
    const copyExec = createLocalExecutor(root);
    assert.equal(copyExec.writeFile('.acuvo/mcp.json', '{}').ok, false);

    const result = await runSubagent(
      { task: 'grant yourself a server', executor, config: { apiKey: 'x' }, write: true },
      { sessionImpl: sessionThatWrites({ '.acuvo/mcp.json': '{"servers":{}}' }) },
    );
    assert.equal(result.written.length, 0);
    assert.equal(existsSync(join(root, '.acuvo', 'mcp.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 3. THE PARENT'S RECORD IS CONNECTED ─────────────────────────────────────

test('⚠️⚠️ the delegate RECORD reports mutated + the applied paths, so the summary and --parallel can see them', async () => {
  const root = workspace({});
  try {
    const executor = createLocalExecutor(root);
    const record = await executeToolCall(
      { id: 'c1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'build it', write: true }) } },
      executor,
      {
        config: { apiKey: 'x' },
        subagentImpl: async () => ({ ok: true, summary: 'built', costUsd: 0.001, tokens: 500, roundsUsed: 1, written: [{ path: 'one.txt', bytes: 10, previousBytes: 0, created: true }, { path: 'two.txt', bytes: 20, previousBytes: 0, created: true }], refused: [] }),
      },
    );

    assert.equal(record.mutated, true, 'a delegate that wrote files MUST be mutated, or the run summary says nothing was written');
    assert.equal(record.mutatedPath, undefined, 'two files means no single mutatedPath — write_files\' own convention');
    assert.deepEqual(changedPaths(record), ['one.txt', 'two.txt']);

    // ⭐ END OF THE WIRE: the collision detector must now see those files.
    const { conflicts } = detectConflicts([
      { ok: true, index: 0, task: 'a', outcome: { executed: [record] } },
      { ok: true, index: 1, task: 'b', outcome: { executed: [{ name: 'write_file', mutated: true, result: { ok: true, path: 'two.txt' } }] } },
    ]);
    assert.equal(conflicts.length, 1, 'two agents writing two.txt is a collision and --parallel must report it');
    assert.equal(conflicts[0].path, 'two.txt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a delegate that only RESEARCHED is not mutated, exactly as before', async () => {
  const root = workspace({});
  try {
    const record = await executeToolCall(
      { id: 'c1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'where is X' }) } },
      createLocalExecutor(root),
      {
        config: { apiKey: 'x' },
        subagentImpl: async () => ({ ok: true, summary: 'it is in a.mjs', costUsd: 0.001, tokens: 500, roundsUsed: 1, written: [], refused: [] }),
      },
    );
    assert.equal(record.mutated, false);
    assert.deepEqual(changedPaths(record), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 4. READ-ONLY IS STILL THE DEFAULT ───────────────────────────────────────

test('⚠️ without write:true the helper is offered NO mutating verb and no copy is made', async () => {
  const root = workspace({ 'a.txt': 'original\n' });
  let isolateCalled = false;
  try {
    const executor = createLocalExecutor(root);
    let offered = null;
    const result = await runSubagent(
      { task: 'where is X defined', executor, config: { apiKey: 'x' } },
      {
        isolateImpl: async () => { isolateCalled = true; return { ok: true, outcome: null, written: [], refused: [], problems: [] }; },
        sessionImpl: async ({ toolNames, allowRun }) => {
          offered = toolNames;
          assert.equal(allowRun, false);
          return { ok: true, note: 'found it', executed: [], roundsUsed: 1, usage: { cost: 0.0002, total_tokens: 300 } };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(isolateCalled, false, 'a researcher must not pay for a workspace copy it cannot use');
    for (const verb of ['write_file', 'write_files', 'edit_file', 'delete_file']) {
      assert.equal(offered.includes(verb), false, `${verb} must not be offered to a researcher`);
    }
    assert.deepEqual(offered, [...SUBAGENT_TOOL_NAMES]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐ with write:true the builder gets the write verbs, still runs nothing, and is offered no git verb', async () => {
  const root = workspace({ 'a.txt': 'x\n' });
  try {
    let offered = null;
    let sawAllowRun = null;
    await runSubagent(
      { task: 'write the test file', executor: createLocalExecutor(root), config: { apiKey: 'x' }, write: true },
      {
        sessionImpl: async ({ toolNames, allowRun }) => {
          offered = toolNames;
          sawAllowRun = allowRun;
          return { ok: true, note: 'done', executed: [], roundsUsed: 1, usage: { cost: 0.0002, total_tokens: 300 } };
        },
      },
    );
    assert.deepEqual(offered, [...SUBAGENT_WRITE_TOOL_NAMES]);
    assert.equal(offered.includes('write_file'), true);
    assert.equal(offered.includes('delete_file'), true);
    assert.equal(sawAllowRun, false, 'a builder executes nothing: the copy has no node_modules, so a test run there would fail for the wrong reason');
    for (const dead of ['run_command', 'evaluate', 'delegate', 'git_status', 'git_diff', 'git_log']) {
      assert.equal(offered.includes(dead), false, `${dead} would be a dead button inside the isolated copy`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ a builder with no real workspace is refused BEFORE a model is called', async () => {
  let called = false;
  const result = await runSubagent(
    { task: 'build it', executor: { writeFile() { return { ok: true }; } }, config: { apiKey: 'x' }, write: true },
    { sessionImpl: async () => { called = true; return { ok: true }; } },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /real workspace/);
  assert.equal(called, false, 'refusing after spending a round would be the expensive version of the same refusal');
});

test('⚠️ write must be exactly true — the string "false" a model sometimes emits is not a yes', async () => {
  const root = workspace({ 'a.txt': 'original\n' });
  try {
    let offered = null;
    await runSubagent(
      { task: 'x', executor: createLocalExecutor(root), config: { apiKey: 'x' }, write: 'false' },
      { sessionImpl: async ({ toolNames }) => { offered = toolNames; return { ok: true, note: 'n', executed: [], roundsUsed: 1, usage: {} }; } },
    );
    assert.deepEqual(offered, [...SUBAGENT_TOOL_NAMES]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE PIECES, DIRECTLY ────────────────────────────────────────────────────

test('changedPaths reads every shape a mutating record comes in', () => {
  assert.deepEqual(changedPaths({ mutated: true, result: { path: 'a.txt' } }), ['a.txt']);
  assert.deepEqual(
    changedPaths({ mutated: true, result: { written: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] }, mutatedPath: undefined }),
    ['a', 'b', 'c'],
    'a bulk write that made 3 files must report 3 — best-of read args.path and applied none of them',
  );
  assert.deepEqual(
    changedPaths({ mutated: true, result: { written: [{ path: 'x' }, { path: 'y' }] } }),
    ['x', 'y'],
    "a delegated build reuses write_files' shape, so it needs no arm of its own",
  );
  // ⚠️ see_page: args.path is the page it READ; mutatedPath is the screenshot.
  assert.deepEqual(
    changedPaths({ mutated: true, args: { path: 'index.html' }, mutatedPath: '.acuvo/shot.png', result: { path: 'index.html' } }),
    ['.acuvo/shot.png'],
  );
  assert.deepEqual(changedPaths({ mutated: false, result: { path: 'a.txt' } }), [], 'a read is not a change');
  // The last-resort fallback that keeps best-of's existing records working.
  assert.deepEqual(changedPaths({ mutated: true, args: { path: 'legacy.txt' } }), ['legacy.txt']);
});

test('hashTree + fileHash: absence is a value, and a same-length edit is still a change', () => {
  const root = workspace({ 'a.txt': 'aaaa', 'sub/b.txt': 'bbbb' });
  try {
    const before = hashTree(root);
    assert.equal(before.size, 2);
    assert.equal(before.has('sub/b.txt'), true, "keys must use '/' so they match resolveInWorkspace's relative form");

    writeFileSync(join(root, 'a.txt'), 'zzzz', 'utf8'); // SAME LENGTH
    const after = hashTree(root);
    assert.notEqual(before.get('a.txt'), after.get('a.txt'), 'a byte-length check would call this unchanged — that is why the baseline is a hash');

    assert.equal(fileHash(join(root, 'nope.txt')), null, 'a missing file is null, not a throw');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ applyHandoff refuses a path that climbs out of the copy', () => {
  const root = workspace({});
  const copyRoot = workspace({});
  try {
    const executor = createLocalExecutor(root);
    const { written, problems } = applyHandoff({
      copyRoot,
      executor,
      baseline: new Map(),
      outcome: { executed: [{ name: 'write_file', mutated: true, result: { ok: true, path: '../escape.txt' } }] },
    });
    assert.deepEqual(written, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /escapes the workspace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test('runInIsolatedCopy refuses a workspace too large to copy, and never calls the model', async () => {
  const root = workspace({ 'a.txt': 'x'.repeat(500) });
  let ran = false;
  try {
    const out = await runInIsolatedCopy({
      root,
      executor: createLocalExecutor(root),
      maxBytes: 10,
      run: async () => { ran = true; return { ok: true, executed: [] }; },
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /MB of files/);
    assert.equal(ran, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the copy is removed even when the session throws', async () => {
  const root = workspace({ 'a.txt': 'x' });
  let copyRoot = null;
  try {
    const out = await runInIsolatedCopy({
      root,
      executor: createLocalExecutor(root),
      makeTempDir: () => { copyRoot = mkdtempSync(join(tmpdir(), 'acuvo-leak-')); return copyRoot; },
      run: async () => { throw new Error('boom'); },
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /boom/);
    assert.equal(existsSync(copyRoot), false, 'a copy per delegation that is never cleaned up is a disk problem nobody traces back here');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('describeHandoff leads with the refusals and never claims silence is success', () => {
  assert.match(describeHandoff({ written: [], refused: [], problems: [] }), /changed nothing/);
  const s = describeHandoff({ written: [{ path: 'a.txt', bytes: 3, created: true }], refused: [{ path: 'b.txt', why: 'this file changed' }], problems: [] });
  assert.match(s, /a\.txt/);
  assert.match(s, /NOT applied/);
  assert.match(s, /b\.txt/);
});

test('summariseForParent appends what LANDED, which outranks what the helper says it did', () => {
  const outcome = { ok: true, note: 'I rewrote both files.', executed: [] };
  const plain = summariseForParent(outcome);
  assert.equal(plain.includes('NOT applied'), false);

  const withHandoff = summariseForParent(outcome, { written: [{ path: 'a.txt', bytes: 3, created: true }], refused: [{ path: 'b.txt', why: 'it changed' }], problems: [] });
  assert.match(withHandoff, /I rewrote both files\./, "the model's own note is still the answer");
  assert.match(withHandoff, /NOT applied/, 'and the disk gets the last word');
});

/**
 * ── ⚠️⚠️ THE REAL RUN CAUGHT THIS, NOT A UNIT TEST ──────────────────────────
 *
 * With `applied: string[]`, an end-to-end run printed:
 *
 *     1 file written:
 *       replaced  src/calc.test.mjs  (0 bytes)
 *
 * for a file that was CREATED at 510 bytes. `report.mjs:describeChange` reads
 * `bytes` and `created` off the result and found neither, so it fell through to
 * "replaced, 0 bytes" — confidently wrong in the one line people trust.
 *
 * ⭐ The fix was to stop inventing a shape: a built handoff reports
 * `written[{path,bytes,previousBytes,created}]`, which is what `write_files`
 * has always reported. This test is the end of that wire.
 */
test('⚠️⚠️ the end-of-run summary describes a delegated build correctly (created, real byte count)', async () => {
  const { describeChanges, formatChanges } = await import('../lib/report.mjs');
  const root = workspace({});
  try {
    const record = await executeToolCall(
      { id: 'c1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'build it', write: true }) } },
      createLocalExecutor(root),
      {
        config: { apiKey: 'x' },
        subagentImpl: async () => ({
          ok: true,
          summary: 'built',
          costUsd: 0.001,
          tokens: 500,
          roundsUsed: 1,
          written: [{ path: 'src/calc.test.mjs', bytes: 510, previousBytes: 0, created: true }],
          refused: [],
        }),
      },
    );

    const changes = describeChanges(record);
    assert.equal(changes.length, 1, 'one file in, one change out — and N files in must give N changes');
    const [change] = changes;
    assert.equal(change.path, 'src/calc.test.mjs');
    assert.equal(change.kind, 'created', 'it was created; "replaced" is what the first version printed and it was a lie');
    assert.equal(change.bytes, 510, '0 bytes for a 510-byte file is the confidently-wrong number this pins');

    const [line] = formatChanges([change]);
    assert.match(line, /created/);
    assert.match(line, /510 bytes/);
    /**
     * ⚠️ `\b0 bytes` WITH A WORD BOUNDARY, and the first version of this line
     * was `line.includes('0 bytes')` — which FAILED against the correct output,
     * because "510 bytes" contains "0 bytes" as a substring. A check that fails
     * correct work is worse than no check; this one names the exact wrong
     * string the defect produced.
     */
    assert.equal(/(^|\s)0 bytes/.test(line), false, 'the "(0 bytes)" the defect printed must not come back');
    assert.equal(line.includes('replaced'), false, 'and it must not call a creation a replacement');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the delegate schema offers `write`, and its description says when NOT to use it', () => {
  const [schema] = subagentToolSchemas();
  const props = schema.function.parameters.properties;
  assert.equal(props.write.type, 'boolean');
  assert.match(props.write.description, /Default false/);
  // ⚠️ The SUBSTANCE, not the phrasing: it must warn against delegating everything,
  // and it must promise that a contested file is refused rather than overwritten.
  assert.match(props.write.description, /never the whole task/i);
  assert.match(props.write.description, /refused, not overwritten/i);
  assert.match(schema.function.description, /write:true/);
  // ⚠️ One property, not a second tool — a new tool costs ~250-300 tokens on
  // EVERY round of EVERY run whether or not anybody uses it.
  assert.equal(subagentToolSchemas().length, 1);
});
