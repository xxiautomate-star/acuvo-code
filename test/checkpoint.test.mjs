/**
 * CHECKPOINT / REWIND — the undo.
 *
 * ⚠️ THE DANGEROUS HALF OF THIS FEATURE IS NOT THE RESTORE, IT IS THE RESTORE
 * THAT SHOULD NOT HAVE HAPPENED. A rewind that overwrites the edit you made
 * after the run destroys your work while calling itself a safety feature — so
 * most of this file is about REFUSING, and the conflict rule is the assertion
 * that was mutated first to prove the test can fail.
 *
 * ⭐ EVERY TEST THAT MATTERS GOES THROUGH THE REAL EXECUTOR
 * (`createLocalExecutor`), not through a stub: the whole claim of this feature
 * is "the two doors every mutation already uses now copy the old bytes", and a
 * test that calls `journal.record` directly would pass with the doors unwired.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openJournal, readJournal, parseJournal, groupRuns, planRewind, applyRewind,
  formatCheckpoints, formatRewind, newCheckpointId, checkpointSize, CHECKPOINT_DIR,
} from '../lib/checkpoint.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { parseArgv } from '../lib/cli-args.mjs';

const made = [];
function ws() {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'acuvo-ckpt-'));
  made.push(d);
  return d;
}
const cleanup = () => {
  for (const d of made.splice(0)) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows */ }
  }
};
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// THE POINT: the agent's writes can be put back
// ─────────────────────────────────────────────────────────────────────────────

test('⭐⭐ a rewritten file goes back to what it said before the run', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'app.js'), 'ORIGINAL\n', 'utf8');

  const journal = openJournal(root, { runId: 'run-a' });
  const ex = createLocalExecutor(root, { journal });
  assert.equal(ex.writeFile('app.js', 'REWRITTEN\n').ok, true);
  assert.equal(read(root, 'app.js'), 'REWRITTEN\n');

  const j = readJournal(root);
  const plan = planRewind(j.entries, 'run-a');
  assert.equal(plan.ok, true);
  const result = applyRewind(root, plan);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(read(root, 'app.js'), 'ORIGINAL\n', 'the whole feature: the previous contents came back');
  assert.equal(result.restored.length, 1);
});

test('⭐⭐ a file the agent CREATED is deleted again — the case git cannot do, because it is untracked', (t) => {
  t.after(cleanup);
  const root = ws();
  const journal = openJournal(root, { runId: 'run-b' });
  const ex = createLocalExecutor(root, { journal });
  assert.equal(ex.writeFile('src/new.ts', 'export const x = 1;\n').ok, true);
  assert.equal(existsSync(join(root, 'src/new.ts')), true);

  const j = readJournal(root);
  const result = applyRewind(root, planRewind(j.entries, 'run-b'));

  assert.equal(existsSync(join(root, 'src/new.ts')), false, 'a created file must be removed, not left behind looking like yours');
  assert.equal(result.removed.length, 1);
  assert.equal(result.restored.length, 0);
});

test('⭐⭐ a DELETED file comes back with its bytes intact', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'notes.md'), '# keep me\n', 'utf8');

  const journal = openJournal(root, { runId: 'run-c' });
  const ex = createLocalExecutor(root, { journal });
  assert.equal(ex.deleteFile('notes.md').ok, true);
  assert.equal(existsSync(join(root, 'notes.md')), false);

  applyRewind(root, planRewind(readJournal(root).entries, 'run-c'));
  assert.equal(read(root, 'notes.md'), '# keep me\n', 'a delete is the mutation an undo matters most for');
});

test('⭐ several rounds rewriting one file rewind to the state before the FIRST of them', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'a.txt'), 'v0\n', 'utf8');

  const journal = openJournal(root, { runId: 'run-d' });
  const ex = createLocalExecutor(root, { journal });
  ex.writeFile('a.txt', 'v1\n');
  ex.writeFile('a.txt', 'v2\n');
  ex.writeFile('a.txt', 'v3\n');

  applyRewind(root, planRewind(readJournal(root).entries, 'run-d'));
  assert.equal(read(root, 'a.txt'), 'v0\n', 'the FIRST entry holds the state to go back to, not the last');
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️⚠️ THE REFUSAL — the assertion this feature stands on
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ a file YOU edited after the run is SKIPPED, with the reason, not silently overwritten', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'app.js'), 'ORIGINAL\n', 'utf8');

  const journal = openJournal(root, { runId: 'run-e' });
  createLocalExecutor(root, { journal }).writeFile('app.js', 'AGENT\n');
  // The user reads what it wrote and fixes a line — the normal case.
  writeFileSync(join(root, 'app.js'), 'AGENT\nmy own fix\n', 'utf8');

  const result = applyRewind(root, planRewind(readJournal(root).entries, 'run-e'));

  assert.equal(read(root, 'app.js'), 'AGENT\nmy own fix\n', 'MY edit must survive the undo');
  assert.equal(result.restored.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /changed after the agent wrote it/);
  assert.match(result.skipped[0].reason, /--force/, 'a refusal that does not say what to type instead is an obstacle');
});

test('⚠️ --force overrides that, and every forced path says FORCED', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'app.js'), 'ORIGINAL\n', 'utf8');
  const journal = openJournal(root, { runId: 'run-f' });
  createLocalExecutor(root, { journal }).writeFile('app.js', 'AGENT\n');
  writeFileSync(join(root, 'app.js'), 'AGENT\nmy own fix\n', 'utf8');

  const result = applyRewind(root, planRewind(readJournal(root).entries, 'run-f'), { force: true });

  assert.equal(read(root, 'app.js'), 'ORIGINAL\n');
  assert.equal(result.restored[0].forced, true);
  assert.match(formatRewind(result).join('\n'), /FORCED/, 'the operator has to be able to see which files it went over the top of');
});

test('⚠️ --dry-run reports the same decisions and touches nothing', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'app.js'), 'ORIGINAL\n', 'utf8');
  const journal = openJournal(root, { runId: 'run-g' });
  createLocalExecutor(root, { journal }).writeFile('app.js', 'AGENT\n');

  const result = applyRewind(root, planRewind(readJournal(root).entries, 'run-g'), { dryRun: true });

  assert.equal(read(root, 'app.js'), 'AGENT\n', 'a dry run that wrote would be a preview of a different command');
  assert.equal(result.restored.length, 1, 'and it must still SAY what it would do');
  assert.equal(result.dryRun, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE WINDOW: "rewind to before run X" includes everything after X
// ─────────────────────────────────────────────────────────────────────────────

test('⭐⭐ rewinding an OLD checkpoint also undoes the runs after it — a state that never existed is not a checkpoint', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'a.txt'), 'v0\n', 'utf8');

  createLocalExecutor(root, { journal: openJournal(root, { runId: 'first' }) }).writeFile('a.txt', 'v1\n');
  createLocalExecutor(root, { journal: openJournal(root, { runId: 'second' }) }).writeFile('a.txt', 'v2\n');

  const entries = readJournal(root).entries;
  assert.equal(groupRuns(entries).length, 2);
  assert.equal(groupRuns(entries)[0].runId, 'second', 'newest first');

  applyRewind(root, planRewind(entries, 'first'));
  assert.equal(read(root, 'a.txt'), 'v0\n');
});

test('⚠️ the sequence continues across runs — two journals both numbering from zero would interleave into nonsense', (t) => {
  t.after(cleanup);
  const root = ws();
  createLocalExecutor(root, { journal: openJournal(root, { runId: 'first' }) }).writeFile('a.txt', '1\n');
  createLocalExecutor(root, { journal: openJournal(root, { runId: 'second' }) }).writeFile('b.txt', '2\n');
  const seqs = readJournal(root).entries.map((e) => e.seq);
  assert.deepEqual(seqs, [0, 1]);
});

test('an unknown id is refused, and the refusal says how to find the real ones', () => {
  const out = planRewind([{ seq: 0, runId: 'x', path: 'a' }], 'nope');
  assert.equal(out.ok, false);
  assert.match(out.error, /acuvo rewind/);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ HONESTY: what cannot be restored says so
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ a file too large to copy is recorded as UNRESTORABLE, not skipped silently', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'big.bin'), 'x'.repeat(5000), 'utf8');

  const journal = openJournal(root, { runId: 'run-h', maxBytes: 100 });
  createLocalExecutor(root, { journal }).writeFile('big.bin', 'small\n');
  assert.equal(journal.unrestorable, 1);

  const result = applyRewind(root, planRewind(readJournal(root).entries, 'run-h'));
  assert.equal(result.restored.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /checkpoint limit/);
  assert.match(formatCheckpoints(groupRuns(readJournal(root).entries)).join('\n'), /not restorable/,
    'the listing has to show it too — an undo that looks complete and is not is the failure this feature would otherwise create');
});

test('⚠️ a torn line is counted, never thrown on — seven terminals append to one file', () => {
  const { entries, unreadable } = parseJournal('{"seq":0,"runId":"a","path":"x"}\n{"seq":1,"runI\n');
  assert.equal(entries.length, 1);
  assert.equal(unreadable, 1);
});

test('⚠️ a journal line pointing outside the workspace is refused — a rewind is not an arbitrary-write primitive', (t) => {
  t.after(cleanup);
  const root = ws();
  const plan = {
    ok: true,
    runId: 'evil',
    ops: [{ path: '../escaped.txt', action: 'restore', blob: 'deadbeef', restorable: true, expectExists: true, expectSha: null, beforeBytes: 1 }],
  };
  const result = applyRewind(root, plan);
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(root, '..', 'escaped.txt')), false);
  assert.match(result.failed[0].error, /not inside the workspace/);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ THE AGENT MAY NOT REWRITE ITS OWN UNDO HISTORY
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ the agent cannot write into .acuvo/checkpoints — an agent that can edit its undo log can hide what it did', (t) => {
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root, { journal: openJournal(root, { runId: 'run-i' }) });
  const denied = ex.writeFile(`${CHECKPOINT_DIR}/journal.jsonl`, '');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /\.acuvo\/ is refused/);
  const deleteDenied = ex.deleteFile(`${CHECKPOINT_DIR}/journal.jsonl`);
  assert.equal(deleteDenied.ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ COSTS NOTHING WHEN NOTHING HAPPENS
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️ a dry-run executor records NOTHING — --help promises a dry run touches nothing', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'app.js'), 'ORIGINAL\n', 'utf8');
  const journal = openJournal(root, { runId: 'run-j' });
  const ex = createLocalExecutor(root, { dryRun: true, journal });

  assert.equal(ex.writeFile('app.js', 'NEW\n').ok, true);
  assert.equal(ex.deleteFile('app.js').ok, true);

  assert.equal(journal.recorded, 0);
  assert.equal(existsSync(join(root, CHECKPOINT_DIR)), false, 'and it must not even create the directory');
});

test('⚠️ a run that mutates nothing leaves no directory behind', (t) => {
  t.after(cleanup);
  const root = ws();
  const journal = openJournal(root, { runId: 'run-k' });
  createLocalExecutor(root, { journal }).readFile('missing.txt');
  assert.equal(existsSync(join(root, CHECKPOINT_DIR)), false);
});

test('⚠️ no journal at all keeps the executor byte-identical, and rewind says so calmly', (t) => {
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root);
  assert.equal(ex.writeFile('a.txt', 'hi\n').ok, true);
  const j = readJournal(root);
  assert.equal(j.ok, true);
  assert.equal(j.entries.length, 0);
  assert.match(formatCheckpoints(groupRuns(j.entries)).join('\n'), /no checkpoints/);
});

test('⚠️ a recorder that THROWS costs the checkpoint, never the write', (t) => {
  t.after(cleanup);
  const root = ws();
  const broken = { errors: [], record() { throw new Error('disk on fire'); } };
  const ex = createLocalExecutor(root, { journal: broken });

  assert.equal(ex.writeFile('a.txt', 'hi\n').ok, true, 'the work is the point; the record is the service');
  assert.equal(read(root, 'a.txt'), 'hi\n');
  assert.equal(broken.errors.length, 1, 'and the failure is surfaced, because a silent one makes the undo a lie');
  assert.match(broken.errors[0], /disk on fire/);
});

test('⚠️⚠️ the tool\'s OWN scratch file is not counted — found by running the real CLI, not by a unit test', (t) => {
  t.after(cleanup);
  const root = ws();
  const journal = openJournal(root, { runId: 'run-m' });
  const ex = createLocalExecutor(root, { journal });

  /**
   * `evaluate` writes exactly this name through the executor and then removes
   * it with raw `unlinkSync`, which the journal never sees. The first real run
   * therefore announced "3 files can be put back" when the user had two, and a
   * rewind would have printed a skip line about a file they never wrote.
   */
  assert.equal(ex.writeFile('.acuvo-eval-1152-1786696659584.mjs', 'console.log(1)\n').ok, true);
  assert.equal(journal.recorded, 0, 'the snippet is ours, not theirs');
  assert.equal(existsSync(join(root, CHECKPOINT_DIR)), false, 'and a run whose only mutation was the snippet creates nothing');

  // ⚠️ THE OTHER HALF: a file that merely LOOKS temporary is still work.
  assert.equal(ex.writeFile('src/.acuvo-eval-notes.mjs', 'mine\n').ok, true);
  assert.equal(journal.recorded, 1, 'a filter that swallows real files loses work');
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️⚠️ THE DISPATCH — the half that was broken and cost money
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ `--dir <path> rewind` dispatches — with the argv[0] anchor it became a PAID task run, twice', () => {
  /**
   * Measured, not imagined: `acuvo --dir <ws> rewind` spent $0.0030 running the
   * agent with the task "rewind", listing the workspace and changing nothing.
   * A command word that silently becomes a paid run when a flag precedes it is
   * worse than one that refuses.
   */
  const withDir = parseArgv(['--dir', '/tmp/x', 'rewind']);
  assert.equal(withDir.ok, true);
  assert.equal(withDir.options.command, 'rewind');
  assert.equal(withDir.options.task, '', 'it must NOT fall through as a task');

  const withId = parseArgv(['--dir', '/tmp/x', 'rewind', '20260814-084043-j5pv']);
  assert.equal(withId.options.command, 'rewind');
  assert.deepEqual(withId.options.rewindArgs, ['20260814-084043-j5pv']);
});

test('⚠️ a real instruction that starts with the word "rewind" is still a task', () => {
  const asked = parseArgv(['rewind the migration to the previous schema']);
  assert.equal(asked.options.command, null);
  assert.equal(asked.options.task, 'rewind the migration to the previous schema');
  /**
   * And a flag VALUE never reaches the positional list, so it cannot be
   * mistaken for the verb.
   *
   * ⚠️ THIS USED TO PASS `--model rewind`, WHICH IS NOW REFUSED FOR A SECOND,
   * STRONGER REASON: `--model` resolves through the Acuvo model catalogue, so a
   * bare word that is neither one of our names nor a provider id is a typo and
   * costs a message rather than a round trip. Both outcomes are asserted —
   * a valid value must not become the command, and an invalid one must not
   * quietly become anything at all.
   */
  const valid = parseArgv(['--model', 'acuvo-pro', 'rewind the thing']);
  assert.equal(valid.ok, true, valid.error);
  assert.equal(valid.options.command, null, 'a flag value must never be read as the verb');
  assert.equal(valid.options.task, 'rewind the thing');

  const bogus = parseArgv(['--model', 'rewind', 'do the thing']);
  assert.equal(bogus.ok, false, '"rewind" is not a model, and saying so beats posting it to a provider');
});

test('⚠️ the listing says what the store costs on disk, because nothing prunes it yet', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'a.txt'), 'x'.repeat(4000), 'utf8');
  createLocalExecutor(root, { journal: openJournal(root, { runId: 'run-n' }) }).writeFile('a.txt', 'small\n');

  const size = checkpointSize(root);
  assert.ok(size.bytes > 4000, `expected the stored version to be counted, got ${size.bytes}`);
  assert.equal(size.blobs, 1);

  const withSize = formatCheckpoints(groupRuns(readJournal(root).entries), size).join('\n');
  assert.match(withSize, /\.acuvo\/checkpoints/);
  assert.match(withSize, /nothing prunes it yet/, 'a store that grows forever without saying so is the quiet kind of defect');

  // ⚠️ And it stays silent when there is nothing to report, rather than printing "0 KB".
  assert.equal(/nothing prunes it yet/.test(formatCheckpoints(groupRuns(readJournal(root).entries)).join('\n')), false);
});

test('a checkpoint id has the same shape as a session id', () => {
  assert.match(newCheckpointId(new Date('2026-08-14T09:15:00Z')), /^[0-9]{8}-[0-9]{6}-[a-z0-9]{2,8}$/);
});

test('blobs are content-addressed, so rewriting one file ten times stores one copy per distinct version', (t) => {
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'a.txt'), 'v0\n', 'utf8');
  const journal = openJournal(root, { runId: 'run-l' });
  const ex = createLocalExecutor(root, { journal });
  // Three writes, but only TWO distinct previous states: v0, then v1, then v1
  // again because the second write changed nothing.
  ex.writeFile('a.txt', 'v1\n');
  ex.writeFile('a.txt', 'v1\n');
  ex.writeFile('a.txt', 'v2\n');
  assert.equal(journal.recorded, 3, 'every mutation is still an entry');
  const blobs = readdirSync(join(root, CHECKPOINT_DIR, 'blobs'));
  assert.equal(blobs.length, 2, `three writes, two distinct previous versions, got ${blobs.length} blobs`);
});
