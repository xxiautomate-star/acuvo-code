/**
 * ── ⚠️⚠️ SELF-CRITIQUE WITH NO EXTERNAL SIGNAL MAKES ANSWERS WORSE ──────────
 *
 * `--refute` shipped as a pure self-critique pass: a second model reads the
 * claim and decides. The literature on that shape is one-directional — intrinsic
 * self-correction went DOWN or FLAT in six settings out of six, and one
 * benchmark dropped 37.7 points in a single round.
 *
 * ⭐ THE SAME MACHINERY WORKS WHEN THE FEEDBACK IS REAL. Replacing a model's own
 * feedback with an external signal moved repaired-and-passing from 33.3% to
 * 52.6%, and GPT-4's feedback handed to GPT-3.5 beat BOTH models' own
 * self-repair. So the fix is not to delete the flag — it is to refuse to run it
 * blind.
 *
 * ⚠️ THE GATE IS "AT LEAST ONE EXTERNAL SIGNAL": a compiler exit code, a test
 * result, or a linter result. Not a read, not a grep, not an opinion. If none is
 * in hand and none can be obtained, the first answer SHIPS — critiquing blind is
 * measured to be worse than not critiquing at all.
 *
 * ⭐ THE CROSS-MODEL HALF WAS ALREADY BUILT (`chooseRefuteModel`, and its own
 * test file). These tests are only about the signal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  refuteClaim, refutePrompt, refutationField, formatRefutation,
  classifySignal, signalsInHand, signalCandidates, acquireExternalSignal,
  recordRefutation, MAX_SIGNAL_CANDIDATES, SIGNAL_KINDS,
} from '../lib/refute.mjs';

/** A session that answers, and records the options it was handed. */
const session = (content, { cost = 0.001 } = {}) => {
  const impl = async (opts) => {
    impl.lastOpts = opts;
    impl.calls = (impl.calls ?? 0) + 1;
    return { ok: true, content, roundsUsed: 2, executed: [], usage: { cost, total_tokens: 900 } };
  };
  impl.calls = 0;
  return impl;
};

/** A runner with the `checkAcceptance` contract: command → {ok, exitCode, …}. */
const runner = (byCommand) => {
  const impl = async (command) => {
    impl.ran.push(command);
    // ⚠️ `undefined`, not falsy — exit code 0 IS the common case and `!hit`
    // turned every green check into a refusal, which made three tests pass for
    // the wrong reason before it made them fail for the right one.
    const hit = byCommand[command];
    if (hit === undefined) return { ok: false, error: `the runner refused \`${command}\`` };
    return { ok: true, command, exitCode: hit, stdout: '', stderr: '', timedOut: false };
  };
  impl.ran = [];
  return impl;
};

const EXEC = { root: null, dryRun: false };

/* ────────────────────────────────────────────────────────────────────────────
 * THE GATE
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ NO SIGNAL AND NONE OBTAINABLE — the refuter never runs and the first answer ships', async () => {
  /**
   * This is the whole point. A blind critique is measured to make results worse,
   * so the correct behaviour is to spend NOTHING and change NOTHING.
   */
  const impl = session('REFUTED: I feel like this is wrong somehow, honestly');
  const r = await refuteClaim({
    task: 'tidy up the readme',           // names no command
    claim: 'tidied it',
    executor: EXEC,
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    acceptance: [],                        // nothing declared
    executed: [],                          // the builder ran nothing
    runner: runner({}),
    sessionImpl: impl,
    env: {},
  });

  assert.equal(impl.calls, 0, 'the critic ran with no external signal — that is the defect');
  assert.equal(r.ok, true);
  assert.equal(r.ran, false);
  assert.equal(r.skipped, true);
  assert.equal(r.refuted, false, 'a skipped pass must never read as a refutation');
  assert.equal(r.hadSignal, false);
  assert.equal(r.costUsd, 0, 'a pass that did not run must not report a cost');
  assert.match(r.reason, /no test, typecheck or lint/i, 'the skip must say what was missing, or nobody can fix it');
});

test('⭐ a signal the BUILDER already produced is enough — and costs nothing new', async () => {
  const impl = session('NOT REFUTED: re-ran npm test, still exits 0');
  const run = runner({ 'npm test': 0 });
  const r = await refuteClaim({
    task: 'fix the parser',
    claim: 'fixed it',
    executor: EXEC,
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    executed: [
      { name: 'read_file', result: { ok: true } },
      { name: 'run_command', args: { command: 'npm test' }, result: { ok: true, command: 'npm test', exitCode: 0 } },
    ],
    runner: run,
    sessionImpl: impl,
    env: {},
  });

  assert.equal(impl.calls, 1, 'a signal was in hand and the critic still did not run');
  assert.equal(run.ran.length, 0, 'it paid to re-run a command it already had the answer to');
  assert.equal(r.hadSignal, true);
  assert.equal(r.signal.source, 'builder-run');
  assert.equal(r.signal.kind, 'test');
  assert.equal(r.signal.exitCode, 0);
});

test('⭐⭐ with no signal in hand it ACQUIRES one — the declared command is run before the critique', async () => {
  const impl = session('NOT REFUTED: npm test exits 0');
  const run = runner({ 'npm test': 0 });
  const r = await refuteClaim({
    task: 'fix the parser',
    claim: 'fixed it',
    executor: EXEC,
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    acceptance: [{ command: 'npm test', runnable: true }],
    executed: [],
    runner: run,
    sessionImpl: impl,
    env: {},
  });

  assert.deepEqual(run.ran, ['npm test'], 'the declared criterion was never run, so the critique was blind');
  assert.equal(impl.calls, 1);
  assert.equal(r.hadSignal, true);
  assert.equal(r.signal.source, 'refuter-acquired');
  assert.equal(r.signal.exitCode, 0);
});

test('⚠️ a RED signal is still a signal — exit 1 is ground truth, not a reason to skip', async () => {
  const impl = session('REFUTED: npm test exits 1 — parser.test.mjs line 14 still fails');
  const r = await refuteClaim({
    task: 'fix the parser',
    claim: 'fixed it, tests pass',
    executor: EXEC,
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    acceptance: [{ command: 'npm test', runnable: true }],
    runner: runner({ 'npm test': 1 }),
    sessionImpl: impl,
    env: {},
  });
  assert.equal(impl.calls, 1, 'a failing check is the single best reason to run a refutation');
  assert.equal(r.signal.exitCode, 1);
  assert.equal(r.signal.passed, false);
  assert.equal(r.refuted, true);
});

test('⚠️ a runner that REFUSES the command yields no signal — and the first answer ships', async () => {
  const impl = session('REFUTED: something smells wrong here about the whole approach');
  const run = runner({});  // refuses everything
  const r = await refuteClaim({
    task: 'fix the parser, `npm test` must pass',
    claim: 'fixed it',
    executor: EXEC,
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    runner: run,
    sessionImpl: impl,
    env: {},
  });
  assert.ok(run.ran.length > 0, 'it never even tried to obtain a signal');
  assert.equal(impl.calls, 0, 'a refused command is not a signal, and critiquing anyway is the defect');
  assert.equal(r.skipped, true);
  assert.equal(r.hadSignal, false);
});

test('⚠️ a --dry-run cannot obtain a signal, so it must not critique', async () => {
  const impl = session('NOT REFUTED: looks fine');
  const run = runner({ 'npm test': 0 });
  const r = await refuteClaim({
    task: 'fix it',
    claim: 'fixed',
    executor: { root: null, dryRun: true },
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    acceptance: [{ command: 'npm test', runnable: true }],
    runner: run,
    sessionImpl: impl,
    env: {},
  });
  assert.equal(run.ran.length, 0, 'a dry run promises the disk is untouched — a command can write');
  assert.equal(impl.calls, 0);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /dry.?run/i);
});

test('⚠️ it will not manufacture a signal by running the APP — that checks nothing', async () => {
  /**
   * `node server.mjs` exiting 0 is an external fact and still not a check of the
   * claim: it says the process started, not that the work is right. Accepting it
   * would let the gate be satisfied by anything the allowlist happens to permit.
   */
  const impl = session('NOT REFUTED: fine');
  const run = runner({ 'node server.mjs': 0 });
  const r = await refuteClaim({
    task: 'add a route, then run `node server.mjs` to check it boots',
    claim: 'added',
    executor: EXEC,
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    acceptance: [{ command: 'node server.mjs', runnable: true }],
    runner: run,
    sessionImpl: impl,
    env: {},
  });
  assert.equal(run.ran.length, 0, 'it ran the app to manufacture a signal');
  assert.equal(impl.calls, 0);
  assert.equal(r.skipped, true);
});

test('⚠️ it tries at most MAX_SIGNAL_CANDIDATES commands — obtaining a signal must not become a session', async () => {
  const impl = session('NOT REFUTED: fine');
  const run = runner({});
  await refuteClaim({
    task: 'x',
    claim: 'y',
    executor: EXEC,
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    acceptance: [
      { command: 'npm test', runnable: true },
      { command: 'npx tsc --noEmit', runnable: true },
      { command: 'npm run lint', runnable: true },
      { command: 'npm run build', runnable: true },
    ],
    runner: run,
    sessionImpl: impl,
    env: {},
  });
  assert.equal(run.ran.length, MAX_SIGNAL_CANDIDATES,
    `tried ${run.ran.length} commands — each one is real wall-clock time before the user sees anything`);
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE SIGNAL REACHES THE CRITIC
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ REACH: the signal is IN THE PROMPT — otherwise it was obtained for nothing', async () => {
  const impl = session('NOT REFUTED: checked');
  await refuteClaim({
    task: 'fix the parser',
    claim: 'fixed it',
    executor: EXEC,
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    acceptance: [{ command: 'npm test', runnable: true }],
    runner: runner({ 'npm test': 1 }),
    sessionImpl: impl,
    env: {},
  });
  const prompt = impl.lastOpts.task;
  assert.match(prompt, /npm test/, 'the critic was never told which command was run');
  assert.match(prompt, /exited 1/, 'the critic was never told the exit code — the one fact it must reason from');
});

test('⭐ the prompt names the signal as the thing a refutation must be grounded in', () => {
  const p = refutePrompt({
    task: 'do a thing', claim: 'did it',
    signal: { kind: 'test', command: 'npm test', exitCode: 0, passed: true, source: 'refuter-acquired' },
  });
  assert.match(p, /npm test/);
  assert.match(p, /exited 0/);
  assert.match(p, /UNCERTAINTY IS NOT A REFUTATION/, 'the original burden of proof must survive');
});

/* ────────────────────────────────────────────────────────────────────────────
 * INSTRUMENTATION — so the next person can MEASURE whether this helps
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ it records whether the refutation CHANGED THE ANSWER and whether it had a signal', async () => {
  const changed = await refuteClaim({
    task: 'fix it', claim: 'fixed',
    executor: EXEC, config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    acceptance: [{ command: 'npm test', runnable: true }],
    runner: runner({ 'npm test': 1 }),
    sessionImpl: session('REFUTED: npm test exits 1, invoice.test.mjs line 14 fails'),
    env: {},
  });
  assert.equal(changed.changedAnswer, true, 'a concrete refutation is the only outcome that flips the verdict');
  assert.equal(changed.hadSignal, true);

  const held = await refuteClaim({
    task: 'fix it', claim: 'fixed',
    executor: EXEC, config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    acceptance: [{ command: 'npm test', runnable: true }],
    runner: runner({ 'npm test': 0 }),
    sessionImpl: session('NOT REFUTED: npm test exits 0 and all four callers resolve'),
    env: {},
  });
  assert.equal(held.changedAnswer, false, 'a clearance changed nothing and must not be counted as a win');
});

test('⚠️ an UNCLEAR verdict changed nothing either — silence is not a result', async () => {
  const r = await refuteClaim({
    task: 'fix it', claim: 'fixed',
    executor: EXEC, config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    acceptance: [{ command: 'npm test', runnable: true }],
    runner: runner({ 'npm test': 0 }),
    sessionImpl: session('I had a look and it seems fine to me, roughly.'),
    env: {},
  });
  assert.equal(r.unclear, true);
  assert.equal(r.changedAnswer, false);
});

test('⭐⭐ the JSON document carries the signal, so a gate can weigh blind critique against grounded', () => {
  const doc = refutationField(true, {
    ok: true, ran: true, refuted: true, unclear: false, reason: 'npm test exits 1',
    costUsd: 0.0006, roundsUsed: 2, reviewerModel: 'qwen/qwen3.7-flash', independent: true,
    hadSignal: true, changedAnswer: true,
    signal: { kind: 'test', command: 'npm test', exitCode: 1, passed: false, source: 'refuter-acquired' },
  });
  assert.equal(doc.hadSignal, true);
  assert.equal(doc.changedAnswer, true);
  assert.equal(doc.signal.command, 'npm test');
  assert.equal(doc.signal.exitCode, 1);
  assert.equal(doc.signal.kind, 'test');
});

test('⚠️⚠️ a SKIPPED-for-no-signal pass is the {asked:true, ran:false} state, with no verdict', () => {
  /**
   * The three states in this file's doctrine must not gain a fourth that looks
   * like a pass. A consumer reading `refuted:false` on a pass that never ran has
   * the original `--json --refute` defect back, wearing a new hat.
   */
  const doc = refutationField(true, {
    ok: true, ran: false, skipped: true, refuted: false, hadSignal: false, costUsd: 0,
    reason: 'no test, typecheck or lint result could be obtained',
  });
  assert.equal(doc.asked, true);
  assert.equal(doc.ran, false);
  assert.equal(doc.hadSignal, false);
  assert.match(doc.reason, /no test, typecheck or lint/);
  assert.ok(!('refuted' in doc), 'a pass that never ran must not report a verdict');
});

test('⭐ the human line says the first answer ships, and why', () => {
  const line = formatRefutation({
    ok: true, ran: false, skipped: true, hadSignal: false,
    reason: 'no test, typecheck or lint result could be obtained, so there was nothing to check the claim against',
  });
  assert.match(line, /no second opinion/i);
  assert.match(line, /first answer/i);
  assert.match(line, /no test, typecheck or lint/);
  assert.doesNotMatch(line, /could not refute/i, 'a skip must never read as clearance');
});

test('⭐ the grounded clearance line names the command and its exit code', () => {
  const line = formatRefutation({
    ok: true, ran: true, refuted: false, independent: true, reason: 'all four callers resolve',
    signal: { kind: 'test', command: 'npm test', exitCode: 0, passed: true, source: 'refuter-acquired' },
  });
  assert.match(line, /could not refute/);
  assert.match(line, /npm test/);
  assert.match(line, /exited 0/);
});

test('⭐ the durable record is one JSON line per pass, so this can be measured later', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refute-log-'));
  try {
    const written = recordRefutation(dir, {
      hadSignal: true, changedAnswer: true, refuted: true, unclear: false,
      signalKind: 'test', signalSource: 'refuter-acquired', exitCode: 1,
      reviewerModel: 'qwen/qwen3.7-flash', independent: true, costUsd: 0.0006,
    });
    assert.equal(written.ok, true);
    assert.ok(existsSync(written.path));
    const lines = readFileSync(written.path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.hadSignal, true);
    assert.equal(row.changedAnswer, true);
    assert.equal(row.signalKind, 'test');
    assert.equal(typeof row.at, 'string', 'a record with no timestamp cannot be measured over time');

    recordRefutation(dir, { hadSignal: false, changedAnswer: false });
    assert.equal(readFileSync(written.path, 'utf8').trim().split('\n').length, 2, 'the second pass overwrote the first');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️⚠️ REACH: refuteClaim actually WRITES the log — a field computed and never stored is not instrumentation', async () => {
  /**
   * ⭐ THE ASSERTION THAT GUARDS THE MOST-REPEATED FAILURE IN THIS PACKAGE:
   * built, returned, and stopped one line before it became visible. Every other
   * test here drives `recordRefutation` or reads the returned object; this one
   * drives the whole function against a real directory and reads the file off
   * disk, because that is the only thing that proves the wiring exists.
   */
  const root = mkdtempSync(join(tmpdir(), 'refute-reach-'));
  try {
    const executor = { root, dryRun: false };

    // 1. A skipped pass — the row that says "we declined, and here is why".
    await refuteClaim({
      task: 'tidy the readme', claim: 'tidied', executor,
      config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
      acceptance: [], executed: [], runner: runner({}),
      sessionImpl: session('NOT REFUTED: fine'), env: {},
    });

    // 2. A grounded pass that changed the answer.
    await refuteClaim({
      task: 'fix it', claim: 'fixed', executor,
      config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
      executed: [{ name: 'run_command', args: { command: 'npm test' }, result: { ok: true, command: 'npm test', exitCode: 1 } }],
      sessionImpl: session('REFUTED: npm test exits 1 — parser.test.mjs line 14'), env: {},
    });

    const rows = readFileSync(join(root, '.acuvo', 'refute-log.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 2, 'refuteClaim computed the telemetry and never wrote it');
    assert.equal(rows[0].hadSignal, false);
    assert.equal(rows[0].ran, false);
    assert.match(rows[0].reason, /no test, typecheck or lint/);
    assert.equal(rows[1].hadSignal, true);
    assert.equal(rows[1].changedAnswer, true);
    assert.equal(rows[1].signalKind, 'test');
    assert.equal(rows[1].exitCode, 1);
    assert.equal(rows[1].reviewerModel, 'qwen/qwen3.7-flash');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ a CRASHED refuter is logged too — otherwise the measurement only ever sees the survivors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'refute-crash-'));
  try {
    await refuteClaim({
      task: 'fix it', claim: 'fixed', executor: { root, dryRun: false },
      config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
      executed: [{ name: 'run_command', args: { command: 'npm test' }, result: { ok: true, command: 'npm test', exitCode: 0 } }],
      sessionImpl: async () => { throw new Error('the model died'); }, env: {},
    });
    const row = JSON.parse(readFileSync(join(root, '.acuvo', 'refute-log.jsonl'), 'utf8').trim());
    assert.equal(row.hadSignal, true);
    assert.equal(row.changedAnswer, false, 'a pass that crashed changed nothing');
    assert.equal(row.refuted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE PURE PARTS
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ classifySignal knows a check from a program', () => {
  assert.equal(classifySignal('npm test'), 'test');
  assert.equal(classifySignal('node --test test/a.test.mjs'), 'test');
  assert.equal(classifySignal('npx vitest run'), 'test');
  assert.equal(classifySignal('npx tsc --noEmit'), 'typecheck');
  assert.equal(classifySignal('npm run typecheck'), 'typecheck');
  assert.equal(classifySignal('npm run lint'), 'lint');
  assert.equal(classifySignal('npx eslint .'), 'lint');
  assert.equal(classifySignal('npm run build'), 'build');
  assert.equal(classifySignal('node server.mjs'), 'program');
  assert.equal(classifySignal(''), null);
  for (const k of ['test', 'typecheck', 'lint', 'build']) assert.ok(SIGNAL_KINDS.includes(k));
  assert.ok(!SIGNAL_KINDS.includes('program'), 'running the app is not a check of the claim');
});

test('⭐ signalsInHand takes only REAL executions with a real exit code', () => {
  const got = signalsInHand([
    /**
     * ⚠️ THE REFUSAL CARRIES AN EXIT CODE ON PURPOSE. Written first with only
     * `{ok:false, error}`, the `ok !== true` guard was DECORATIVE — a mutation
     * deleting it stayed green, because `Number.isInteger(undefined)` filtered
     * the record anyway. A refusal that echoes a stale exit code is exactly the
     * shape that would slip through, and it is the one worth pinning.
     */
    { name: 'run_command', args: { command: 'npm test' }, result: { ok: false, command: 'npm test', exitCode: 0, error: 'refused by the allowlist' } },
    { name: 'evaluate', result: { ok: true, exitCode: 0 } },
    { name: 'read_file', result: { ok: true } },
    { name: 'run_command', args: { command: 'node server.mjs' }, result: { ok: true, command: 'node server.mjs', exitCode: 0 } },
    { name: 'run_command', args: { command: 'npx tsc --noEmit' }, result: { ok: true, command: 'npx tsc --noEmit', exitCode: 2 } },
  ]);
  assert.equal(got.length, 1, 'a refusal, an `evaluate`, a read, or the app booting are none of them a check');
  assert.equal(got[0].command, 'npx tsc --noEmit');
  assert.equal(got[0].exitCode, 2);
  assert.equal(got[0].kind, 'typecheck');
  assert.equal(got[0].source, 'builder-run');
});

test('⚠️ "ran, exit code unknown" is NOT a signal — a null exit code decides nothing', () => {
  /**
   * `checkAcceptance` writes `exitCode: result.exitCode ?? null`, so a null here
   * is a shape that really occurs. Admitting it would hand the critic a fact
   * with no content and let the gate be satisfied by a command whose outcome
   * nobody knows — which is the blind critique the gate exists to refuse.
   */
  assert.deepEqual(signalsInHand([
    { name: 'run_command', args: { command: 'npm test' }, result: { ok: true, command: 'npm test', exitCode: null } },
    { name: 'run_command', args: { command: 'npm run lint' }, result: { ok: true, command: 'npm run lint', exitCode: '0' } },
  ]), [], 'a null or stringly-typed exit code was treated as ground truth');
});

test('⚠️ a TIMED-OUT check did not pass, whatever exit code the killer left behind', () => {
  const [s] = signalsInHand([
    { name: 'run_command', args: { command: 'npm test' }, result: { ok: true, command: 'npm test', exitCode: 0, timedOut: true } },
  ]);
  assert.equal(s.passed, false, 'a suite that was killed mid-run would have been handed to the critic as green');
});

test('⭐ a RED signal in hand outranks a green one — the failing check is the informative one', () => {
  const got = signalsInHand([
    { name: 'run_command', args: { command: 'npm run lint' }, result: { ok: true, command: 'npm run lint', exitCode: 0 } },
    { name: 'run_command', args: { command: 'npm test' }, result: { ok: true, command: 'npm test', exitCode: 1 } },
  ]);
  assert.equal(got[0].command, 'npm test', 'a passing lint was handed to the critic while the tests were red');
});

test('⭐ candidates come from the declaration first, then the user\'s own words — never invented', () => {
  const declared = signalCandidates({ task: 'do a thing', acceptance: [{ command: 'npm test', runnable: true }] });
  assert.deepEqual(declared, ['npm test']);

  const fromTask = signalCandidates({ task: 'fix the parser. `npm test` must pass when you are done.', acceptance: [] });
  assert.deepEqual(fromTask, ['npm test']);

  const nothing = signalCandidates({ task: 'tidy up the readme a bit', acceptance: [] });
  assert.deepEqual(nothing, [], 'a command was invented from a task that named none');
});

test('⚠️ acquireExternalSignal reports WHY it came back empty — a silent skip is unmeasurable', async () => {
  const none = await acquireExternalSignal({
    task: 'tidy the readme', executor: EXEC, acceptance: [], executed: [], runner: runner({}),
  });
  assert.equal(none.signal, null);
  assert.match(none.reason, /no test, typecheck or lint/i);

  const dry = await acquireExternalSignal({
    task: 'x', executor: { dryRun: true }, acceptance: [{ command: 'npm test', runnable: true }], runner: runner({ 'npm test': 0 }),
  });
  assert.equal(dry.signal, null);
  assert.match(dry.reason, /dry.?run/i);
});
