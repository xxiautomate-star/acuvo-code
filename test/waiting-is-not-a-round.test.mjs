/**
 * ── ⚠️⚠️⭐ 240 OF 1,903 ROUNDS IN OUR OWN ARCHIVE WERE SPENT ASKING "DONE YET?"
 *
 * RE-DERIVED from `bench/terminal-bench/results/` — every `acuvo-stderr.log` on
 * disk, split on its own `── round N/M ──` headers. A round counts as a POLL only
 * if it changed no file and did nothing but wait or peek (`sleep`, `ps`, a tail
 * of a `.log`, `check_process`, `read_log`) or said in prose that it was waiting:
 *
 *     139 logs · 1,903 rounds · 240 POLLS (12.6%)
 *     worst run:  84 polls of 100 rounds  (deep100/adaptive-rejection-sampler)
 *     next:       54 polls of  84 rounds  (deep100/caffe-cifar-10)
 *     18 of 27 · 16 of 51 · 15 of 32 · 13 of 26 · 11 of 32 …
 *
 * ⚠️ THE 111 RUNS WITH A PARSEABLE `acuvo-result.json` SHOW ONLY 38 OF THESE,
 * and the gap is not noise: a run that polls itself to death is exactly the run
 * that never writes a result, so 202 of the 240 sit in the 28 empty-result runs.
 * Measuring only the tidy runs undercounts this defect by six times.
 *
 * PRICED at `lib/rate-card.mjs` (flash, peak — cache-read $0.016/M, output
 * $0.18/M, an 11.25x ratio) on the archive's own mean poll round of 25,798
 * tokens at its measured 97% hit rate: **$0.111**, and 16% of it is OUTPUT,
 * which no cache ever touches.
 *
 * ── ⭐⭐ AND THE CAUSE IS OURS, IN WRITING, IN TWO PLACES ────────────────────
 *
 *   1. `start_process`'s own success note said *"Call check_process in a LATER
 *      ROUND"*, and `check_process`'s three still-running notes each ended
 *      *"check again in a later round."* Our tool results instructed the model
 *      to burn a model call. It obeyed: `check_process` appears 146 times.
 *   2. `wait_for_output` — the one verb that blocks — REFUSED any call without
 *      `contains`/`matches`. A `make`, an `apt-get` or an `R CMD INSTALL` prints
 *      no ready line, and those are precisely the four polling runs that died on
 *      the round cap. The model reached for the tool by name 14 times.
 *
 * ⭐ SO THE FIX WRAPS WHAT EXISTED. `waitFor`'s poll loop, its timeout clamp and
 * its process-exit branch were all already there — the exit branch was simply
 * only reachable as a FAILURE. `untilExit` names it as a success. No scheduler,
 * no new loop, and the sentences that taught the poll now name the verb instead.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitFor, logTailToolSchemas, runLogTailTool } from '../lib/log-tail.mjs';
import { startBackground, stopAllBackground, checkBackground, STILL_RUNNING_ADVICE } from '../lib/background.mjs';
import { executeToolCall } from '../lib/tools.mjs';

/** A clock that only moves when something sleeps — see `log-tail.test.mjs`. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

/* ══════════════════════ 1. `untilExit` — the wait a build needs ══════════ */

test('⭐⭐ untilExit blocks until the process STOPS and returns its exit code', async () => {
  const c = fakeClock();
  let polls = 0;
  const r = await waitFor({
    read: () => {
      polls += 1;
      // Three polls of a live build, then it finishes.
      if (polls < 4) return { text: `compiling ${polls}\n`, running: true };
      return { text: 'compiling 3\nBuild complete\n', running: false, exitCode: 0 };
    },
    untilExit: true,
    timeoutMs: 60_000,
    pollMs: 500,
    now: c.now,
    sleep: c.sleep,
  });

  assert.equal(r.ok, true, `waiting for a build to finish must SUCCEED, not fail:\n${r.error}`);
  assert.equal(r.reason, 'exited');
  assert.equal(r.exited, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.note, /do NOT check again/i, 'the reply must close the loop, not invite another round');
});

test('⭐ a FAILED build still counts as finished — `ok` is about the wait, not the exit code', () => {
  /**
   * ⚠️ CONFLATING THE TWO WOULD BE THE EXPENSIVE BUG. A red build that reported
   * `ok:false` would be indistinguishable from a wait that expired, and a model
   * that cannot tell them apart goes back to polling — the behaviour this whole
   * flag exists to end.
   */
  return waitFor({
    read: () => ({ text: 'make: *** [all] Error 2\n', running: false, exitCode: 2 }),
    untilExit: true,
    now: () => 0,
    sleep: async () => {},
  }).then((r) => {
    assert.equal(r.ok, true, 'the WAIT succeeded — the build is what failed');
    assert.equal(r.exitCode, 2);
    assert.match(r.note, /FAILED/, 'and it must say plainly that the build failed');
  });
});

test('⚠️⚠️ untilExit with NO filter must not match the first line of output', async () => {
  /**
   * ⚠️ THE TRAP THIS PINS: `compileFilter().test()` returns TRUE for every line
   * when no filter was given — correct for `read_log` ("show me everything"),
   * catastrophic here. Without the `filter.active` guard a bare `untilExit` wait
   * returns on the process's first line claiming it had finished: the round is
   * spent AND the report is false.
   */
  const c = fakeClock();
  let polls = 0;
  const r = await waitFor({
    read: () => {
      polls += 1;
      if (polls < 3) return { text: 'gcc -c a.c\ngcc -c b.c\n', running: true };
      return { text: 'gcc -c a.c\ngcc -c b.c\ndone\n', running: false, exitCode: 0 };
    },
    untilExit: true,
    timeoutMs: 60_000,
    pollMs: 100,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.reason, 'exited', 'it must have waited for the EXIT, not matched a line');
  assert.equal(r.matched, undefined, 'nothing was being matched');
  assert.ok(polls >= 3, `it returned after ${polls} polls — it did not wait`);
});

test('⭐ a filter still WINS over untilExit — a line is the earlier, sharper signal', async () => {
  const c = fakeClock();
  const r = await waitFor({
    read: () => ({ text: 'boot\nReady in 40ms\n', running: true }),
    contains: 'Ready in',
    untilExit: true,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.ok, true);
  assert.equal(r.matched, 'Ready in 40ms');
  assert.equal(r.reason, undefined, 'a match is a match, not an exit');
});

test('⚠️ an untilExit TIMEOUT says it is still running and says to wait AGAIN, not to poll', async () => {
  const c = fakeClock();
  const r = await waitFor({
    read: () => ({ text: 'still linking\n', running: true }),
    untilExit: true,
    timeoutMs: 5_000,
    pollMs: 1_000,
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.running, true, 'the caller must be able to tell a timeout from a finish without guessing');
  assert.match(r.error, /the process to exit/, 'it must say what it was waiting for');
  assert.match(r.error, /wait_for_output with untilExit again/, 'the way out must be another WAIT');
  assert.match(r.error, /Do NOT switch to check_process/, 'and must name the expensive alternative to refuse');
});

/* ══════════════════════ 2. nothing existing moved ═══════════════════════ */

test('⚠️ WITHOUT untilExit every old behaviour is byte-for-byte what it was', async () => {
  // No filter, no untilExit → still refused.
  const refused = await waitFor({ read: () => 'x\n' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'bad-filter');
  assert.match(refused.error, /contains/);
  assert.match(refused.error, /matches/);
  // ⭐ and the refusal now names the third option, which is the whole point.
  assert.match(refused.error, /untilExit/, 'the refusal must name the way out it used to hide');

  // A filter that never matches on a process that dies → still a FAILURE.
  const died = await waitFor({
    read: () => ({ text: 'crash\n', running: false, exitCode: 1 }),
    contains: 'Ready in',
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(died.ok, false, 'an exit is still a failure when a LINE was what was wanted');
  assert.equal(died.reason, 'exited');
  assert.equal(died.exitCode, 1);
});

/* ══════════════════════ 3. the model is actually offered it ══════════════ */

test('⭐ the schema declares untilExit and tells the model when to use it', () => {
  const s = logTailToolSchemas().find((t) => t.function.name === 'wait_for_output');
  assert.ok(s, 'wait_for_output must still be declared');
  assert.ok(s.function.parameters.properties.untilExit, 'untilExit must be a declared parameter — a flag the model cannot see is not a capability');
  assert.match(s.function.description, /untilExit/, 'the description must name it');
  assert.match(s.function.description, /BUILD or INSTALL/i, 'and must say WHEN — a schema says what a tool does, never when');
  assert.match(s.function.description, /costs no\s+model round/i, 'the price comparison is the argument that changes behaviour');
});

test('⚠️ the dispatcher passes untilExit through, and only for a real boolean', async () => {
  const readLog = () => ({ text: 'x\n', running: false, exitCode: 0 });
  const passed = await runLogTailTool('wait_for_output', { id: 'bg1', untilExit: true }, { readLog, now: () => 0, sleep: async () => {} });
  assert.equal(passed.ok, true, 'the flag never reached waitFor');
  assert.equal(passed.reason, 'exited');

  /**
   * ⚠️ `=== true`, NEVER TRUTHINESS. These arguments are JSON the MODEL wrote,
   * and the STRING "false" is truthy — which would silently turn "wait for this
   * line" into "wait for the process to die".
   */
  const stringy = await runLogTailTool('wait_for_output', { id: 'bg1', untilExit: 'false' }, { readLog, now: () => 0, sleep: async () => {} });
  assert.equal(stringy.ok, false, '"false" must not enable the flag');
  assert.equal(stringy.reason, 'bad-filter');
});

/* ══════════════════════ 4. we stopped teaching the poll ══════════════════ */

const made = [];
after(() => {
  stopAllBackground();
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* windows handle lag */ } }
});

function workspace(script) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-wait-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"w","version":"1.0.0"}\n');
  writeFileSync(join(root, 'job.mjs'), script);
  return { root, dryRun: false, readFile: () => null };
}

test('⭐⭐ our own tool results no longer say "check again in a later round"', async () => {
  const ex = workspace([
    "console.log('working');",
    'setTimeout(() => {}, 10_000);',
  ].join('\n'));
  const started = startBackground({ command: 'node job.mjs', executor: ex });
  assert.equal(started.ok, true, started.error);

  /**
   * ⚠️⚠️ THIS IS THE SENTENCE THAT COST 240 ROUNDS. Both of these notes told the
   * model, in our own words, to spend a model call finding out whether something
   * had finished. If either ever says it again, this test is the only thing that
   * will notice.
   */
  assert.doesNotMatch(started.note, /later round/i, `start_process still teaches the poll:\n${started.note}`);
  assert.match(started.note, /wait_for_output/, 'the first thing said about a background job must name the blocking verb');
  assert.match(started.note, /untilExit/, 'including the form a build needs');

  const checked = await checkBackground(started.id);
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.running, true);
  assert.doesNotMatch(checked.note, /later round/i, `check_process still teaches the poll:\n${checked.note}`);
  assert.match(checked.note, /wait_for_output/, 'a still-running check must redirect to the wait');
});

test('⚠️ the redirect is one sentence in one place, not a copy per branch', () => {
  /**
   * Three branches print it. A literal in each is how three copies drift and two
   * of them keep saying "check again in a later round" forever — the exact shape
   * `rate-card.mjs` exists to prevent for prices.
   */
  assert.match(STILL_RUNNING_ADVICE, /wait_for_output/);
  assert.match(STILL_RUNNING_ADVICE, /untilExit/);
  assert.doesNotMatch(STILL_RUNNING_ADVICE, /later round/i);
});

/* ══════════════════════ 5. REACH — through the real dispatch ═════════════ */

/**
 * ⚠️ EVERY TEST ABOVE INJECTS ITS OWN `readLog` OR CALLS `waitFor` DIRECTLY, and
 * `log-tools-are-wired.test.mjs` records what that is worth: the unit tests were
 * green for months while the production call site dropped `readLog` and the tool
 * refused 100% of real calls. So this one starts a REAL process and goes through
 * `executeToolCall` — the same entry the model's tool calls take.
 */
test('⭐⭐ REACH: untilExit blocks on a REAL process through executeToolCall', async () => {
  const ex = workspace([
    "console.log('step 1');",
    "setTimeout(() => { console.log('step 2'); process.exit(3); }, 400);",
  ].join('\n'));
  const started = startBackground({ command: 'node job.mjs', executor: ex });
  assert.equal(started.ok, true, started.error);

  const t0 = Date.now();
  const rec = await executeToolCall(
    { id: 'c_1', function: { name: 'wait_for_output', arguments: JSON.stringify({ id: started.id, untilExit: true, timeoutMs: 8000 }) } },
    ex,
  );
  const waited = Date.now() - t0;

  assert.equal(rec.result.ok, true, `the real dispatch refused it:\n${rec.result.error}`);
  assert.equal(rec.result.reason, 'exited');
  assert.equal(rec.result.exitCode, 3, 'the exit code is the whole reason to wait for an exit');
  assert.ok(waited >= 200, `it returned in ${waited}ms without waiting — it did not block`);
});
