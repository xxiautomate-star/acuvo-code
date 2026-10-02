/**
 * ── ⚠️⚠️ THE ONLY DETECTOR THAT ENDS A RUN AND TOUCHES THE DISK ─────────────
 *
 * Every other pattern in `stuck.mjs` sends a hint. This one stops the session
 * and puts files back, so its false-positive cost is the highest in the package
 * — and the shapes it must NOT fire on are the ordinary rhythm of fixing a bug:
 * edit, run, different error, edit, run, pass.
 *
 * ⭐ AND THE ROLLBACK IS TESTED AGAINST THE ONE THING IT MUST NEVER DO: write
 * over a file the USER changed after the agent did. `checkpoint.mjs` refuses
 * that for the manual `acuvo rewind`; the automatic path must inherit it, and
 * inheriting it is the whole reason `planFutileRollback` produces `applyRewind`
 * ops rather than restoring files itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectStuck, stuckAction, FUTILE_EDIT_LIMIT, BREAKING_PATTERNS } from '../lib/stuck.mjs';
import { openJournal, readJournal, planFutileRollback, applyRewind } from '../lib/checkpoint.mjs';
/** ⭐ The REACH tests below drive the shipped loop — only the model is faked. */
import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

/* ── the same builders stuck.test.mjs uses, copied from the source shape ──── */

let seq = 0;
const round = (n, executed) => ({ round: n, note: '', executed, usage: null, finishReason: 'tool_calls', model: 'test' });
const write = (path, content) => ({
  id: `c${seq++}`, name: 'write_file', args: { path, content },
  result: { ok: true, path, bytes: content.length, previousBytes: 0, created: false }, mutated: true,
});
const cmd = (command, exitCode, stderr = '') => ({
  id: `c${seq++}`, name: 'run_command', args: { command },
  result: { ok: true, command, exitCode, passed: exitCode === 0, stdout: '', stderr, timedOut: false, argv: [], durationMs: 5 },
  mutated: false,
});

const TS_ERROR = "src/other.ts(4,1): error TS2345: Argument of type 'string'\n  is not assignable to parameter of type 'number'.\n  at line 4";

/** n edit→run pairs against one file, with the SAME failure every time. */
function futileRounds(n, { path = 'src/a.ts', error = TS_ERROR, command = 'tsc' } = {}) {
  const rounds = [];
  for (let i = 0; i < n; i += 1) {
    rounds.push(round(i * 2 + 1, [write(path, `attempt-${i}-${'x'.repeat(i)}`)]));
    rounds.push(round(i * 2 + 2, [cmd(command, 2, error)]));
  }
  return rounds;
}

/* ══════════════════════════════════════════════════════════════════════════
 * the detector
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐ three real edits to one file with an unchanged error is a futile-edit-loop', () => {
  const hit = detectStuck(futileRounds(4));
  assert.equal(hit.pattern, 'futile-edit-loop', hit.pattern ?? 'nothing fired');
  assert.deepEqual(hit.evidence.paths, ['src/a.ts']);
  assert.equal(hit.evidence.edits, FUTILE_EDIT_LIMIT);
  assert.match(hit.suggestion, /not the file the error is about/);
});

test('⚠️ TWO edits is not enough — the third is where the evidence stops being ambiguous', () => {
  assert.notEqual(detectStuck(futileRounds(3)).pattern, 'futile-edit-loop');
});

test('⚠️⚠️ THE ERROR CHANGING IS PROGRESS, and progress must never be flagged', () => {
  const rounds = [];
  for (let i = 0; i < 5; i += 1) {
    rounds.push(round(i * 2 + 1, [write('src/a.ts', `attempt-${i}`)]));
    // ⭐ A DIFFERENT ERROR EACH TIME: the model peeling them off one at a time.
    rounds.push(round(i * 2 + 2, [cmd('tsc', 2, `src/a.ts(${i},1): error TS234${i}: thing ${i}`)]));
  }
  assert.notEqual(detectStuck(rounds).pattern, 'futile-edit-loop');
});

test('⚠️ ONE GREEN RUN CLEARS EVERYTHING, however bad the rounds before it looked', () => {
  const rounds = [...futileRounds(4)];
  rounds.push(round(99, [cmd('tsc', 0, '')]));
  rounds.push(round(100, [write('src/a.ts', 'more')]));
  rounds.push(round(101, [cmd('tsc', 2, TS_ERROR)]));
  assert.notEqual(detectStuck(rounds).pattern, 'futile-edit-loop');
});

test('⚠️ editing DIFFERENT files while one error persists is a wide fix, not a loop', () => {
  const rounds = [];
  for (let i = 0; i < 5; i += 1) {
    rounds.push(round(i * 2 + 1, [write(`src/file-${i}.ts`, `body-${i}`)]));
    rounds.push(round(i * 2 + 2, [cmd('tsc', 2, TS_ERROR)]));
  }
  assert.notEqual(detectStuck(rounds).pattern, 'futile-edit-loop');
});

test('⚠️ re-running a failing command with NO edit between is not this pattern', () => {
  const rounds = [];
  for (let i = 0; i < 5; i += 1) rounds.push(round(i + 1, [cmd('tsc', 2, TS_ERROR)]));
  const hit = detectStuck(rounds);
  assert.notEqual(hit.pattern, 'futile-edit-loop', 'it claimed edits that never happened');
});

test('⭐ …and looking at the output again does not BREAK the chain either', () => {
  /**
   * ⚠️⚠️ THIS TEST EXISTS BECAUSE A MUTATION SURVIVED, and it pins the direction
   * nobody would think to check. Deleting `if (pending.size === 0) continue;`
   * left the suite green — because without it a no-edit failure pushes an EMPTY
   * path set into the gaps, the intersection with it is empty, and the pattern
   * then NEVER FIRES AT ALL. The guard's real job is not to suppress a false
   * positive; it is to stop an innocent extra `tsc` run from making a genuine
   * futile loop invisible.
   *
   * ⚠️ THE POSITION OF THE NO-EDIT FAILURE IS THE WHOLE TEST. It sits INSIDE
   * the three-gap window that is about to close, so without the guard the empty
   * set poisons that window and the loop is never reported at all. Put it
   * anywhere else and the sliding window recovers a round later, which is a
   * delay rather than a miss — and a delay is invisible to an assertion.
   *
   * (The first failure only ESTABLISHES the chain, so four edits produce three
   * gaps. That is not an off-by-one; a first failure has nothing to compare to.)
   */
  const rounds = [
    round(1, [write('src/a.ts', 'attempt-0')]),
    round(2, [cmd('tsc', 2, TS_ERROR)]),          // establishes the chain
    round(3, [write('src/a.ts', 'attempt-1')]),
    round(4, [cmd('tsc', 2, TS_ERROR)]),          // gap 1
    round(5, [cmd('tsc', 2, TS_ERROR)]),          // ← re-read the failure. No edit.
    round(6, [write('src/a.ts', 'attempt-2')]),
    round(7, [cmd('tsc', 2, TS_ERROR)]),          // gap 2
    round(8, [write('src/a.ts', 'attempt-3')]),
    round(9, [cmd('tsc', 2, TS_ERROR)]),          // gap 3 — this must fire
  ];
  assert.equal(detectStuck(rounds).pattern, 'futile-edit-loop');
});

test('⚠️ a DIFFERENT command failing is a different fact', () => {
  const rounds = [];
  for (let i = 0; i < 5; i += 1) {
    rounds.push(round(i * 2 + 1, [write('src/a.ts', `attempt-${i}`)]));
    rounds.push(round(i * 2 + 2, [cmd(i % 2 ? 'tsc' : 'npm test', 2, TS_ERROR)]));
  }
  assert.notEqual(detectStuck(rounds).pattern, 'futile-edit-loop');
});

test('⚠️ only the FIRST THREE LINES are compared, so a changing timing line still counts', () => {
  /**
   * ⭐ THE OTHER DIRECTION OF THE SAME DECISION. Comparing whole output would
   * make two identical failures look different because a test runner prints a
   * duration, and the pattern would never fire at all.
   */
  const rounds = [];
  for (let i = 0; i < 4; i += 1) {
    rounds.push(round(i * 2 + 1, [write('src/a.ts', `attempt-${i}`)]));
    rounds.push(round(i * 2 + 2, [cmd('tsc', 2, `${TS_ERROR}\nDone in ${i * 137}ms`)]));
  }
  assert.equal(detectStuck(rounds).pattern, 'futile-edit-loop');
});

/* ══════════════════════════════════════════════════════════════════════════
 * the action
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐ this pattern BREAKS on first sighting — its threshold already is the patience', () => {
  const v = stuckAction({ firstSighting: true, pattern: 'futile-edit-loop' });
  assert.equal(v.do, 'break');
});

test('⚠️ every other pattern still gets its hint first, unchanged', () => {
  for (const p of ['thrashing', 'repeated-identical-edit', 'no-progress', 'long-cycle', null]) {
    assert.equal(stuckAction({ firstSighting: true, pattern: p }).do, 'nudge', String(p));
  }
});

test('⚠️ allowBreak:false turns it back into an ordinary pattern', () => {
  const v = stuckAction({ firstSighting: true, pattern: 'futile-edit-loop', allowBreak: false });
  assert.equal(v.do, 'nudge');
  assert.ok(BREAKING_PATTERNS.includes('futile-edit-loop'));
});

/* ══════════════════════════════════════════════════════════════════════════
 * the rollback
 * ══════════════════════════════════════════════════════════════════════════ */

function workspaceWithHistory() {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-breaker-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  const file = join(dir, 'src', 'a.ts');
  const journal = openJournal(dir, { runId: 'run-1' });

  // The last WORKING state, then three edits that changed nothing.
  writeFileSync(file, 'GOOD');
  for (const body of ['bad-1', 'bad-2', 'bad-3']) {
    journal.record({ verb: 'write', path: 'src/a.ts', absolute: file, after: body });
    writeFileSync(file, body);
  }
  return { dir, file };
}

test('⭐⭐ the rollback puts back the state before the three futile edits, and nothing else', () => {
  const { dir, file } = workspaceWithHistory();
  try {
    /**
     * ⚠️⚠️ THE SECOND FILE IS **JOURNALLED**, AND THAT DETAIL IS THE TEST.
     * It used to be a bare `writeFileSync`, so it never entered the journal —
     * and a mutation replacing the path filter with "every entry" therefore
     * still passed, because there was only ever one path in there to find.
     * Correct agent work that IS recorded is the only thing that proves the
     * rollback is narrow.
     */
    const other = join(dir, 'src', 'untouched.ts');
    const journal2 = openJournal(dir, { runId: 'run-1b' });
    journal2.record({ verb: 'write', path: 'src/untouched.ts', absolute: other, after: 'KEEP ME' });
    writeFileSync(other, 'KEEP ME');

    const { entries } = readJournal(dir);
    const plan = planFutileRollback(entries, { paths: ['src/a.ts'], edits: 3 });
    assert.ok(plan.ok, plan.error);
    const result = applyRewind(dir, plan);

    assert.equal(readFileSync(file, 'utf8'), 'GOOD', 'it did not go back to the last working state');
    assert.equal(readFileSync(join(dir, 'src', 'untouched.ts'), 'utf8'), 'KEEP ME', 'it reverted a file it was not asked about');
    assert.deepEqual(result.restored.map((r) => r.path), ['src/a.ts']);
    assert.deepEqual(result.skipped, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️⚠️ IT REFUSES TO OVERWRITE A FILE THE USER CHANGED — the inherited guarantee', () => {
  const { dir, file } = workspaceWithHistory();
  try {
    // The person read what the agent wrote and fixed a line themselves.
    writeFileSync(file, 'the human fixed it');

    const { entries } = readJournal(dir);
    const plan = planFutileRollback(entries, { paths: ['src/a.ts'], edits: 3 });
    const result = applyRewind(dir, plan);

    assert.equal(readFileSync(file, 'utf8'), 'the human fixed it', 'AN AUTOMATIC ROLLBACK DESTROYED A HUMAN EDIT');
    assert.deepEqual(result.restored, []);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /changed after the agent wrote it/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ a file the agent CREATED is deleted rather than restored to nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-breaker-new-'));
  try {
    const file = join(dir, 'new.ts');
    const journal = openJournal(dir, { runId: 'run-2' });
    journal.record({ verb: 'write', path: 'new.ts', absolute: file, after: 'first' });
    writeFileSync(file, 'first');
    journal.record({ verb: 'write', path: 'new.ts', absolute: file, after: 'second' });
    writeFileSync(file, 'second');
    journal.record({ verb: 'write', path: 'new.ts', absolute: file, after: 'third' });
    writeFileSync(file, 'third');

    const { entries } = readJournal(dir);
    const result = applyRewind(dir, planFutileRollback(entries, { paths: ['new.ts'], edits: 3 }));
    assert.deepEqual(result.removed.map((r) => r.path), ['new.ts']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️ a path with no journal history is reported, not silently treated as done', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-breaker-none-'));
  try {
    const plan = planFutileRollback([], { paths: ['src/a.ts'] });
    assert.equal(plan.ok, false);
    assert.match(plan.error, /nothing recorded to put back/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ══════════════════════════════════════════════════════════════════════════
 * REACH — the shipped loop, not the pieces
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐⭐⭐ REACH: a real runSession breaks the loop, notifies, and puts the file back', async () => {
  /**
   * ⚠️ THE ONLY THING FAKED IS THE MODEL. Everything else is the shipped path —
   * the real dispatcher, the real executor, the real checkpoint journal, the
   * real `applyRewind`. This package's most-shipped defect is "built but
   * unreached", and every unit test above would still pass with the ten lines in
   * `turn.mjs` deleted.
   *
   * ⭐ THE SCRIPT IS THE DEFECT ITSELF: the model edits `src/a.ts` over and over
   * while the failing command's output never changes, because the error is
   * about a file it is not touching.
   */
  const root = mkdtempSync(join(tmpdir(), 'acuvo-breaker-reach-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'THE LAST WORKING STATE');
    // A command that always fails identically, whatever the agent does.
    writeFileSync(join(root, 'always-fails.mjs'), 'console.error("src/b.ts(4,1): error TS2345: nope"); process.exit(2);');

    const journal = openJournal(root, { runId: 'reach-run' });
    const executor = createLocalExecutor(root, { journal });

    let n = 0;
    const model = async () => {
      n += 1;
      const calls = n % 2 === 1
        ? [{ id: `w${n}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/a.ts', content: `attempt number ${n}` }) } }]
        : [{ id: `r${n}`, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node always-fails.mjs' }) } }];
      return { ok: true, content: 'working', usage: { cost: 0.0001, total_tokens: 100 }, finishReason: 'tool_calls', toolCalls: calls };
    };

    const events = [];
    const outcome = await runSession({
      task: 'fix the type error',
      executor,
      config: { apiKey: 'k', model: 'm' },
      maxRounds: 20,
      budgetUsd: 1,
      callModelImpl: model,
      onEvent: (e) => events.push(e),
    });

    const broke = events.filter((e) => e.type === 'circuit-break');
    assert.equal(broke.length, 1, `the breaker fired ${broke.length} times after ${outcome.roundsUsed} rounds — the wiring in turn.mjs is not on the path`);
    assert.equal(broke[0].pattern, 'futile-edit-loop');
    assert.deepEqual(broke[0].evidence.paths, ['src/a.ts']);
    assert.equal(outcome.stoppedBecause, 'stuck');
    assert.ok(outcome.roundsUsed < 20, 'it ran to the round cap instead of breaking');

    /**
     * ⭐⚠️ AND THE FILE IS BACK — TO THE STATE BEFORE THE THREE **PROVEN**
     * FUTILE EDITS, WHICH IS NOT THE SAME AS "BEFORE THE RUN".
     *
     * The model edited at rounds 1, 3, 5 and 7. Only the last three are futile:
     * the round-1 edit came BEFORE the first failure, so there was no earlier
     * identical failure to compare it to and no evidence it changed nothing.
     * Undoing it as well would be undoing an edit this detector never judged.
     *
     * ⚠️ THIS IS ALSO WHERE ROMAN'S PHRASE "the last working state" HAS TO BE
     * SAID MORE PRECISELY: in this fixture the command NEVER passed, so no
     * recorded state is known-good and there is no working state to return to.
     * What the rollback guarantees is "before the edits proven futile". When a
     * green run DID happen it clears the chain (see the test above), so the
     * futile window begins after it — and there the two phrasings coincide.
     */
    assert.equal(readFileSync(join(root, 'src', 'a.ts'), 'utf8'), 'attempt number 1',
      'the loop broke but the three futile edits were not the ones put back');
    assert.deepEqual(broke[0].rollback.restored.map((r) => r.path), ['src/a.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⭐ REACH: with no checkpoint journal it still BREAKS, and says nothing could be put back', async () => {
  /**
   * ⚠️ THE HALF THAT MUST NOT DEPEND ON THE OTHER. `--no-checkpoint` and a dry
   * run both leave no journal. Breaking the loop is worth doing on its own;
   * continuing because the undo is unavailable would keep the expensive half of
   * the failure and drop the cheap half.
   */
  const root = mkdtempSync(join(tmpdir(), 'acuvo-breaker-nojournal-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'original');
    writeFileSync(join(root, 'always-fails.mjs'), 'console.error("src/b.ts(4,1): error TS2345: nope"); process.exit(2);');

    // ⚠️ NO `journal` — exactly what `--no-checkpoint` produces.
    const executor = createLocalExecutor(root);
    let n = 0;
    const model = async () => {
      n += 1;
      const calls = n % 2 === 1
        ? [{ id: `w${n}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/a.ts', content: `attempt ${n}` }) } }]
        : [{ id: `r${n}`, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node always-fails.mjs' }) } }];
      return { ok: true, content: 'working', usage: { cost: 0.0001, total_tokens: 100 }, finishReason: 'tool_calls', toolCalls: calls };
    };

    const events = [];
    await runSession({
      task: 'fix it', executor, config: { apiKey: 'k', model: 'm' },
      maxRounds: 20, budgetUsd: 1, callModelImpl: model, onEvent: (e) => events.push(e),
    });

    const broke = events.filter((e) => e.type === 'circuit-break');
    assert.equal(broke.length, 1, 'no journal meant no break — the two halves are coupled and must not be');
    assert.ok(broke[0].rollback.unavailable, 'it claimed a rollback it could not have done');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ fewer recorded edits than the detector counted rolls back as far as the journal goes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-breaker-short-'));
  try {
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'ORIGINAL');
    const journal = openJournal(dir, { runId: 'run-3' });
    journal.record({ verb: 'write', path: 'a.ts', absolute: file, after: 'once' });
    writeFileSync(file, 'once');

    const { entries } = readJournal(dir);
    const plan = planFutileRollback(entries, { paths: ['a.ts'], edits: 3 });
    assert.ok(plan.ok);
    assert.equal(plan.ops[0].undoing, 1);
    applyRewind(dir, plan);
    assert.equal(readFileSync(file, 'utf8'), 'ORIGINAL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
