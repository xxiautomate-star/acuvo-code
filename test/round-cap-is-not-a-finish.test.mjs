/**
 * ── ⚠️⚠️⭐ A RUN THAT RAN OUT OF ROUNDS TOLD NOBODY ─────────────────────────
 *
 * THE EVIDENCE, harvested from this repo's own Terminal-Bench artefacts
 * (`bench/terminal-bench/results/`, 139 `acuvo-result.json` documents, 111 of
 * them non-empty and parseable):
 *
 *     stoppedBecause     n     failed the task
 *     verified          61     35
 *     no-tool-calls     28     11
 *     would-exceed      11     11
 *     round-cap          9      7
 *     model-error        1      1
 *     truncated          1      1
 *
 * All nine `round-cap` runs consumed EVERY round they were given (16/16 or
 * 32/32) and every one of their closing notes is a sentence about the next step
 * — "It's still compiling. Let me wait another couple of minutes.", "I'm at
 * round 32 of 32. Let me fix dpkg…", "…the carry propagates in the wrong
 * direction. Let me fix le32."
 *
 * ⚠️⚠️ TWO OF THE NINE SAID NOTHING AND EXITED 0. `circuit-fibsqrt` and
 * `configure-git-webserver` both ended with `verification.passed === true`, so
 * the summary printed `✔ VERIFIED` and stopped there. The cap appeared only as
 * a field in `--json`. The reason was structural: the single sentence naming the
 * cap lived inside the `else if (v.ran)` arm of the verification block, so it
 * could only be reached by a run whose command had RUN AND FAILED.
 *
 * ⭐ THESE TESTS PIN THE OBSERVABLE PROPERTY, not the sentence. The bar is: a
 * run that stopped on the counter says so, in every combination of verification
 * state, and a run that finished says nothing of the kind.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatSummary, roundCapWarning, sessionFailed } from '../lib/turn.mjs';
import { outOfRoad } from '../lib/escalate.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acuvo.mjs');

/**
 * ⚠️ SIGNED OUT, STATED EXPLICITLY — a machine where somebody has run
 * `acuvo --login` routes the spawned child through our gateway, which
 * deliberately outranks the loopback test seam. Seventeen tests went red the
 * first day the product was used; this is the fix for that shape.
 */
const SIGNED_OUT = { ACUVO_HOME: join(tmpdir(), `acuvo-signed-out-${process.pid}`) };

/** The shape `formatSummary` sees for a run that hit the wall. */
const capped = (over = {}) => ({
  ok: true,
  stage: 'done',
  model: 'stub/model',
  note: 'The carry propagates in the wrong direction. Let me fix le32 to iterate from 0 to 31.',
  noteAlreadyShown: false,
  finishReason: 'tool_calls',
  usage: { cost: 0.0168, total_tokens: 56_094 },
  compactions: 0,
  executed: [{ id: '1', name: 'write_file', args: { path: 'mult.py' }, result: { ok: true, path: 'mult.py', bytes: 900 }, mutated: true }],
  rounds: [{ round: 32, executed: [{ name: 'run_command' }] }],
  roundsUsed: 32,
  maxRounds: 32,
  allowRun: true,
  stoppedBecause: 'round-cap',
  acceptance: null,
  promisedButMissing: [],
  verification: { ran: false, passed: null, command: null, exitCode: null, timedOut: false, attempts: 0 },
  ...over,
});

/** The three verification states a capped run can be in. */
const VERIFICATIONS = {
  'passed — the measured circuit-fibsqrt shape': { ran: true, passed: true, command: 'python3 test_mult.py', exitCode: 0, timedOut: false, attempts: 5 },
  'never ran': { ran: false, passed: null, command: null, exitCode: null, timedOut: false, attempts: 0 },
  'ran and failed': { ran: true, passed: false, command: 'python3 test_mult.py', exitCode: 1, timedOut: false, attempts: 2 },
};

/* ────────────────────────────────────────────────────────────────────────────
 * (1) THE PROPERTY — it says so, whatever the verification did
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ a capped run says it ran out of rounds in EVERY verification state', () => {
  for (const [name, verification] of Object.entries(VERIFICATIONS)) {
    const text = formatSummary(capped({ verification }), { resumeCommand: 'acuvo --continue' }).join('\n');
    assert.match(text, /RAN OUT OF ROUNDS/, `verification ${name}: the cap was never mentioned:\n${text}`);
    assert.match(text, /all 32 were spent/, `verification ${name}: it did not say how many rounds went`);
  }
});

test('⚠️⚠️ the measured silent case: a PASSING command must not be the last word', () => {
  /**
   * This is `circuit-fibsqrt` verbatim — 32/32, `verification.passed: true`,
   * exit 0, and the model's closing sentence is a bug it had just found and was
   * about to fix. The tick is still printed, because it is still a fact about
   * that command; what may never happen again is the tick standing alone.
   */
  const text = formatSummary(
    capped({ verification: VERIFICATIONS['passed — the measured circuit-fibsqrt shape'] }),
    { resumeCommand: 'acuvo --continue' },
  ).join('\n');

  assert.match(text, /✔ VERIFIED/, 'the true statement about the command survives');
  assert.match(text, /RAN OUT OF ROUNDS/, 'and it is no longer the last thing said');
  assert.ok(
    text.indexOf('RAN OUT OF ROUNDS') > text.indexOf('✔ VERIFIED'),
    'the warning must come AFTER the tick — the last thing on screen is the thing a person reads',
  );
});

test('⚠️ a run that finished says nothing about rounds — the false-positive half', () => {
  for (const stoppedBecause of ['verified', 'no-tool-calls', 'stuck', 'truncated', 'aborted', 'would-exceed']) {
    const text = formatSummary(
      capped({ stoppedBecause, roundsUsed: 4, verification: VERIFICATIONS['ran and failed'] }),
      { resumeCommand: 'acuvo --continue' },
    ).join('\n');
    assert.doesNotMatch(text, /RAN OUT OF ROUNDS/, `"${stoppedBecause}" is not a round cap and must not claim to be`);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2) IT NEVER CLAIMS MORE THAN IT KNOWS
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ "the final round was still calling tools" is printed only when the record says so', () => {
  const withCalls = roundCapWarning(capped({ rounds: [{ round: 32, executed: [{ name: 'read_file' }] }] })).join('\n');
  assert.match(withCalls, /final round was still calling tools/);

  /**
   * ⚠️ THE PATH THAT MAKES THIS CONDITIONAL REAL: `pressOnForAcceptance` and
   * `pressOnAfterTruncation` both `continue` the loop after a round with NO tool
   * calls, and a continuation landing on the last round exits with
   * `stoppedBecause` still 'round-cap'. Claiming tool calls there would be a
   * precise-sounding wrong detail, which is how people learn to stop reading a
   * warning.
   */
  const noCalls = roundCapWarning(capped({ rounds: [{ round: 32, executed: [] }] })).join('\n');
  assert.match(noCalls, /RAN OUT OF ROUNDS/, 'the unconditional half is true on every path');
  assert.doesNotMatch(noCalls, /still calling tools/, 'it may not claim a fact the record does not carry');

  const noRecord = roundCapWarning(capped({ rounds: undefined })).join('\n');
  assert.match(noRecord, /RAN OUT OF ROUNDS/);
  assert.doesNotMatch(noRecord, /still calling tools/);
});

test('⚠️ the recovery is promised ONLY when there is a record to recover', () => {
  /**
   * ⚠️ A PROMISE THE NEXT COMMAND BREAKS IS WORSE THAN NO ADVICE. Under
   * `--no-session` / `--dry-run` nothing is saved, and `acuvo --continue` then
   * answers "nothing to continue — no run in this workspace saved a
   * conversation".
   */
  const promised = formatSummary(capped(), { resumeCommand: 'acuvo --continue' }).join('\n');
  assert.match(promised, /acuvo --continue/);

  const bare = formatSummary(capped()).join('\n');
  assert.match(bare, /RAN OUT OF ROUNDS/, 'the warning does not depend on persistence');
  assert.doesNotMatch(bare, /--continue/, 'a caller that saved nothing must not be told to continue');
});

test('⚠️ the cap is named ONCE, not twice, when the verification also failed', () => {
  /**
   * The verification block still names the wall in its own context ("the
   * N-round budget ran out with it still failing"), and the block below owns the
   * remedy. Two copies of "re-run with --max-rounds higher" is how a warning
   * becomes wallpaper.
   */
  const text = formatSummary(
    capped({ verification: VERIFICATIONS['ran and failed'] }),
    { resumeCommand: 'acuvo --continue' },
  ).join('\n');
  assert.equal((text.match(/--max-rounds/g) || []).length, 1, `--max-rounds advice appeared more than once:\n${text}`);
  assert.equal((text.match(/RAN OUT OF ROUNDS/g) || []).length, 1);
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2b) THE EXIT CODE — `acuvo … && git push` must not push a capped run that
 *      proved nothing, and must not refuse one that proved something
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ── ⚠️⚠️ THE UNCONDITIONAL RULE IS REFUTED BY THIS FILE'S OWN ARCHIVE ───────
 *
 * The obvious change — "a run that ran out of rounds has not succeeded, so fail
 * it" — was measured against all 139 result documents before being written, and
 * it loses:
 *
 *     round-cap runs in the archive                     9   (`stuck`: 0)
 *     …already exit 1 (command ran and failed)          7
 *     …exit 0 with verification RAN AND PASSED          2
 *     …of those two, one has a reward on disk       reward 1  ← a PASS
 *
 * Failing every capped run would have caught **zero** runs that lied and failed
 * **one** the benchmark scored as correct (`run-fixed/configure-git-webserver`,
 * 32/32 rounds, `verifier/reward.txt` = 1; the other, `circuit-fibsqrt`, has no
 * reward file — its verifier crashed — so it proves nothing either way).
 *
 * ⭐ SO THE PREDICATE IS "CAPPED WITH NOTHING PROVEN", the same conditional
 * shape `truncated` already uses. The two loud cases keep exit 0 and are
 * answered by `roundCapWarning` / `stuckWarning` above; the door this closes is
 * the one neither of them went through.
 */
test('⭐⭐ a capped run that verified NOTHING is a failed run — and one that verified is not', () => {
  assert.equal(
    sessionFailed(capped({ verification: VERIFICATIONS['never ran'] })), true,
    'four files written, the counter ended it, nothing checked — `&& git push` must not fire',
  );
  assert.equal(
    sessionFailed(capped({ verification: null })), true,
    '--no-run leaves verification null; "I cannot tell" is not "it passed"',
  );
  assert.equal(
    sessionFailed(capped({ verification: undefined })), true,
    'and an outcome missing the field entirely lands in the failing branch too',
  );

  // ⚠️ THE OTHER HALF, AND IT IS THE ONE THE ARCHIVE ARGUES FOR. Measured: this
  // exact shape scored reward 1. Failing it is the check-that-fails-correct-work
  // defect this repo has paid for five times.
  assert.equal(
    sessionFailed(capped({ verification: VERIFICATIONS['passed — the measured circuit-fibsqrt shape'] })), false,
    'a capped run whose command ran and passed stays a success — the archive says so',
  );

  // And ran-and-failed was already a failure, by the clause below this one.
  assert.equal(sessionFailed(capped({ verification: VERIFICATIONS['ran and failed'] })), true);
});

test('⭐ `stuck` is the identical case, and OUR loop detector ended that one', () => {
  /**
   * `stuck.mjs`'s own header prices the mistake: "CALLING A WORKING RUN STUCK
   * costs the user THE WORK AND THE MONEY." So the same asymmetry applies —
   * nothing proven is a failure, a passing command is not.
   */
  for (const [name, verification] of Object.entries(VERIFICATIONS)) {
    const run = capped({ stoppedBecause: 'stuck', verification });
    assert.equal(
      sessionFailed(run),
      name !== 'passed — the measured circuit-fibsqrt shape',
      `stuck + ${name} got the wrong verdict`,
    );
  }
  assert.equal(sessionFailed(capped({ stoppedBecause: 'stuck', verification: null })), true);
});

test('⚠️⚠️ the TWO-PREDICATE design survives — `outOfRoad` is not this function', () => {
  /**
   * `escalate.test.mjs` records the split deliberately: "did this attempt
   * finish" (the ladder's question) and "did this run succeed" (the exit
   * code's). Collapsing them is what this change must NOT do — the ladder has
   * to keep climbing on a capped run that verified, because a second attempt
   * may still do better, while the shell is told that run succeeded.
   */
  const cappedAndVerified = capped({ verification: VERIFICATIONS['passed — the measured circuit-fibsqrt shape'] });
  assert.equal(outOfRoad(cappedAndVerified), true, 'the ladder still sees a wall');
  assert.equal(sessionFailed(cappedAndVerified), false, 'and the shell still sees a success');

  const stuckAndVerified = capped({ stoppedBecause: 'stuck', verification: VERIFICATIONS['passed — the measured circuit-fibsqrt shape'] });
  assert.equal(outOfRoad(stuckAndVerified), true);
  assert.equal(sessionFailed(stuckAndVerified), false);

  // ⚠️ And the reasons that are NOT walls stay untouched by all of this.
  for (const stoppedBecause of ['verified', 'no-tool-calls']) {
    const finished = capped({ stoppedBecause, verification: VERIFICATIONS['never ran'] });
    assert.equal(outOfRoad(finished), false, `${stoppedBecause} is not a wall`);
    assert.equal(sessionFailed(finished), false, `${stoppedBecause} with no command run is the CLI's older, honest behaviour`);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) REACH — a person typing `acuvo` actually gets it
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ EVERY TEST ABOVE WOULD STAY GREEN IF `bin/acuvo.mjs` NEVER PASSED
 * `resumeCommand`. This package has shipped built-and-unreached six times; the
 * only answer is argv in, bytes out.
 */

/** A stub completions endpoint. The LAST turn repeats, so one turn loops forever. */
async function stubModel(turns) {
  let i = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `stub-${i}`,
        model: 'stub/model',
        choices: [{ message: turn, finish_reason: turn.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00001 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1/chat/completions`, close: () => new Promise((r) => server.close(r)) };
}

const call = (name, args) => ({ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/**
 * ⚠️ `spawn`, NEVER `spawnSync`: the stub server lives in this process, and a
 * synchronous child blocks the event loop that would have to accept its
 * connection. Both sides then wait until the timeout.
 */
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [CLI, ...args], {
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', OPENROUTER_API_KEY: 'sk-or-v1-stub', ...SIGNED_OUT, ...env },
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d) => { stdout += d; });
    cp.stderr.on('data', (d) => { stderr += d; });
    cp.stdin.end('');
    const timer = setTimeout(() => { cp.kill(); reject(new Error(`the CLI did not exit within 30s\n${stdout}\n${stderr}`)); }, 30_000);
    cp.on('error', (e) => { clearTimeout(timer); reject(e); });
    cp.on('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

test('⭐⭐ REACH: a real `acuvo` run that hits the cap says so and names the recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-roundcap-'));
  // One turn, repeated: the model never stops calling tools, so the counter is
  // the only thing that can end this run.
  const stub = await stubModel([
    { role: 'assistant', content: 'Still working on it.', tool_calls: [call('write_file', { path: 'work.txt', content: 'in progress\n' })] },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '2', '--no-run', 'do a long job'], { ACUVO_API_URL: stub.url });

    assert.equal(
      /ReferenceError|TypeError|acuvo crashed/.test(`${r.stdout}${r.stderr}`),
      false,
      `the CLI crashed:\n${r.stdout}\n${r.stderr}`,
    );
    assert.match(r.stdout, /RAN OUT OF ROUNDS/, `a capped run said nothing about the cap:\n${r.stdout}`);
    assert.match(r.stdout, /acuvo --continue/, `the recovery was never named:\n${r.stdout}`);

    /**
     * ⚠️⚠️ AND THE SHELL IS TOLD THE SAME THING THE SCREEN WAS. `--no-run`
     * means nothing was verified, so this is a capped run with nothing proven
     * and `acuvo … && git push` must not fire. This assertion is the whole
     * reason the clause was added: every unit test above it would stay green
     * if `bin/acuvo.mjs` computed its exit code some other way.
     */
    assert.equal(r.status, 1, `a capped run that proved nothing exited ${r.status}:\n${r.stdout}`);

    // ⭐ AND THE ADVICE IS TRUE: the record it points at is on disk.
    const saved = readdirSync(join(dir, '.acuvo', 'sessions'));
    assert.equal(saved.length, 1, `--continue was promised with ${saved.length} records saved`);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ REACH: under --no-session the warning stays and the promise is withdrawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-roundcap-nosave-'));
  const stub = await stubModel([
    { role: 'assistant', content: 'Still working on it.', tool_calls: [call('write_file', { path: 'work.txt', content: 'in progress\n' })] },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '2', '--no-run', '--no-session', 'do a long job'], { ACUVO_API_URL: stub.url });
    assert.match(r.stdout, /RAN OUT OF ROUNDS/, `the warning must not depend on persistence:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /--continue/, `nothing was saved, so --continue must not be offered:\n${r.stdout}`);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐⭐ REACH: the --json document and the exit code agree about a capped run', async () => {
  /**
   * ⚠️ `exitCode` is in the document precisely so the two can never drift, and
   * a consumer doing `| jq -e '.failed | not'` is the second shell that has to
   * be told. Both are read from the SAME spawned process here.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-roundcap-json-'));
  const stub = await stubModel([
    { role: 'assistant', content: 'Still working on it.', tool_calls: [call('write_file', { path: 'work.txt', content: 'in progress\n' })] },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '2', '--no-run', '--json', 'do a long job'], { ACUVO_API_URL: stub.url });
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.stoppedBecause, 'round-cap', `not the run this test needs:\n${r.stdout}`);
    assert.equal(doc.ok, true, '`ok` is not redefined — the session did complete its rounds');
    assert.equal(doc.failed, true, 'the verdict a script reads must say the run did not succeed');
    assert.equal(doc.exitCode, 1);
    assert.equal(r.status, doc.exitCode, 'the document and the shell disagreed');
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ REACH: a run that FINISHES gets none of this', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-roundcap-clean-'));
  const stub = await stubModel([
    { role: 'assistant', content: 'Writing.', tool_calls: [call('write_file', { path: 'done.txt', content: 'ok\n' })] },
    { role: 'assistant', content: 'Done — done.txt now exists.' },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '4', '--no-run', 'create done.txt'], { ACUVO_API_URL: stub.url });
    assert.doesNotMatch(r.stdout, /RAN OUT OF ROUNDS/, `a finished run was told it ran out of rounds:\n${r.stdout}`);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
