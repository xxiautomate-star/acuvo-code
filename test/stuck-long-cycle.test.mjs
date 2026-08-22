import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStuck, findLongCycle, LONG_CYCLE_HISTORY, LONG_CYCLE_MAX_LEN, LONG_CYCLE_REPEATS } from '../lib/stuck.mjs';

/**
 * ── ⭐⭐ THE LOOP THE FOUR-ROUND WINDOW CANNOT SEE ───────────────────────────
 *
 * `detectStuck` already catches thrashing (A→B→A), byte-identical rewrites, tool
 * error loops, repeated command failures and inert rounds — it is not the coarse
 * detector it looked like. Its blind spot is arithmetic, not conceptual:
 * **`DEFAULT_WINDOW = 4`**, so a cycle of period 3 — read X, edit X, run tests,
 * read X, edit X, run tests — never has two full repetitions inside the window
 * and is invisible no matter how long it goes on.
 *
 * ⚠️ WHY IT IS WORTH THE CODE. MAST (1,600+ traces, κ=0.88) measured **step
 * repetition as the single largest multi-agent failure mode at 17.14%** — larger
 * than any other category. And our own budget makes the blind spot reachable:
 * default 24 rounds, ceiling 64, `--until-done` 200. A period-3 loop can burn
 * every one of them.
 *
 * ⭐ ZERO TOKENS. This is string comparison over a history we already hold. The
 * detector costs nothing per round and can only save whole rounds.
 *
 * ⚠️ AND IT MUST NOT FIRE ON HONEST WORK. read → edit → run repeated over
 * DIFFERENT files is exactly what a competent refactor looks like. The signature
 * therefore includes the arguments, so only a genuinely identical cycle counts.
 */

const call = (name, args = {}, ok = true) => ({ name, args, result: { ok }, mutated: false });
const round = (n, ...calls) => ({ round: n, executed: calls });

/** read A, edit A, run — three times over, never touching anything else. */
function periodThreeLoop() {
  const rounds = [];
  for (let i = 0; i < LONG_CYCLE_REPEATS; i += 1) {
    rounds.push(round(i * 3 + 1, call('read_file', { path: 'src/a.ts' })));
    rounds.push(round(i * 3 + 2, call('edit_file', { path: 'src/a.ts', old: 'x', new: 'y' })));
    rounds.push(round(i * 3 + 3, call('run_command', { entry: 'test.js' })));
  }
  return rounds;
}

test('⭐ a period-3 cycle is caught, which the 4-round window structurally cannot see', () => {
  const out = detectStuck(periodThreeLoop());
  assert.equal(out.stuck, true, 'a model repeating the same three steps forever must be interrupted');
  assert.equal(out.pattern, 'long-cycle');
  assert.ok(out.suggestion, 'the product is the nudge, not the flag');
});

/**
 * ⚠️ THE SUGGESTION MUST NAME THE CYCLE, not just announce a loop. "You seem
 * stuck" sends the model to re-read its own reasoning; naming the three verbs it
 * has been repeating tells it what to stop doing.
 */
test('⚠️ the nudge names what is being repeated', () => {
  const out = detectStuck(periodThreeLoop());
  assert.match(out.suggestion, /read_file|edit_file|run_command/);
});

test('the same three verbs over DIFFERENT files is honest work, not a loop', () => {
  const rounds = [];
  for (let i = 0; i < LONG_CYCLE_REPEATS; i += 1) {
    rounds.push(round(i * 3 + 1, call('read_file', { path: `src/file-${i}.ts` })));
    rounds.push(round(i * 3 + 2, call('edit_file', { path: `src/file-${i}.ts`, old: 'x', new: 'y' })));
    rounds.push(round(i * 3 + 3, call('run_command', { entry: 'test.js' })));
  }
  const out = detectStuck(rounds);
  assert.notEqual(out.pattern, 'long-cycle', 'a refactor across many files must not be called a loop');
});

test('two repetitions are not yet a pattern', () => {
  const rounds = [];
  for (let i = 0; i < 2; i += 1) {
    rounds.push(round(i * 3 + 1, call('read_file', { path: 'a.ts' })));
    rounds.push(round(i * 3 + 2, call('edit_file', { path: 'a.ts' })));
    rounds.push(round(i * 3 + 3, call('run_command', { entry: 't.js' })));
  }
  assert.notEqual(detectStuck(rounds).pattern, 'long-cycle');
});

/**
 * ⚠️ THE MORE SPECIFIC PATTERN STILL WINS. A period-1 cycle IS a repeated
 * identical edit, and reporting it as "you are in a long cycle" would be a
 * vaguer statement of a fact the existing detector already states precisely.
 */
test('⚠️ an existing, more specific pattern is not displaced', () => {
  const rounds = [
    round(1, call('write_file', { path: 'a.ts', content: 'same' })),
    round(2, call('write_file', { path: 'a.ts', content: 'same' })),
  ];
  const out = detectStuck(rounds);
  assert.equal(out.stuck, true);
  assert.notEqual(out.pattern, 'long-cycle', 'repeated-identical-edit is the sharper diagnosis');
});

test('a clean varied session is not stuck at all', () => {
  const out = detectStuck([
    round(1, call('read_file', { path: 'a.ts' })),
    round(2, call('write_file', { path: 'b.ts', content: 'new' })),
    round(3, call('run_command', { entry: 'b.js' })),
    round(4, call('git_status', {})),
  ]);
  assert.equal(out.stuck, false);
});

test('the constants are exported so the thresholds are visible, not buried', () => {
  assert.ok(LONG_CYCLE_HISTORY >= 12, 'must cover several repetitions of the longest cycle');
  assert.ok(LONG_CYCLE_MAX_LEN >= 3);
  assert.ok(LONG_CYCLE_REPEATS >= 3, 'two repetitions is a coincidence');
});

/**
 * ⚠️ THE GUARD MY OWN MUTATION TEST FAILED TO REACH. `new Set(cycle).size < 2`
 * exists so a cycle whose steps are all IDENTICAL is not reported as a
 * multi-step loop — reading the same file five times is one repeated step, not
 * a period-2 cycle, and calling it the latter names a bigger loop than exists.
 *
 * My first mutation removed that line and nothing went red, because every case
 * I had written was caught by a sharper detector first. A guard no test reaches
 * is indistinguishable from dead code, so here is the case that reaches it.
 */
test('⚠️ repeated identical READS are not dressed up as a multi-step cycle', () => {
  const rounds = [];
  for (let i = 0; i < 8; i += 1) rounds.push(round(i + 1, call('read_file', { path: 'same.ts' })));
  const out = detectStuck(rounds);
  assert.notEqual(out.pattern, 'long-cycle', 'one repeated step is not a cycle of two');
});

test('⚠️⚠️ and the guard is exercised DIRECTLY, because detectStuck cannot reach it', () => {
  const rounds = [];
  for (let i = 0; i < 8; i += 1) rounds.push(round(i + 1, call('read_file', { path: 'same.ts' })));
  // Through detectStuck this is `no-progress`. Straight at the detector, it is
  // the case the guard exists for: a "cycle" whose every step is the same step.
  assert.equal(findLongCycle(rounds), null, 'one repeated step must not be reported as a period-2 cycle');

  // and a genuine two-step cycle still is one
  const real = [];
  for (let i = 0; i < 4; i += 1) {
    real.push(round(i * 2 + 1, call('read_file', { path: 'a.ts' })));
    real.push(round(i * 2 + 2, call('run_command', { entry: 't.js' })));
  }
  assert.equal(findLongCycle(real)?.pattern, 'long-cycle');
});
