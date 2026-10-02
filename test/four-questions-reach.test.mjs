/**
 * ── ⭐⭐⭐ THE SETTINGS ARE REACHED, NOT MERELY DEFINED ───────────────────────
 *
 * `test/four-questions-config.test.mjs` proves the DECISIONS are right. This one
 * proves they are REACHED — that a real `runSession`, with a real executor and a
 * real loop, behaves differently because of them.
 *
 * ⚠️ THIS PACKAGE'S MOST COMMON DEFECT BY FAR is the feature whose parts all
 * exist and which nothing calls. `plan-ledger.mjs`, `acceptance.mjs` and
 * `costDecision` were each finished, documented and tested while imported by
 * nothing; `diff-preview.mjs`'s 1,044-line renderer had zero production callers
 * for weeks. A settings surface is exactly the shape that fails this way,
 * because the config layer can be perfect and the loop can still read a
 * constant.
 *
 * ⭐ NO MODEL IS CALLED. `callModelImpl` is injected, so the whole thing runs
 * for $0.00 and is deterministic — which is the only reason a loop test can be
 * in the suite at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-four-q-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A model that writes the SAME bytes to the SAME path every round, forever.
 *
 * ⭐ THE SIMPLEST PROVABLE LOOP. `stuck.mjs` calls two byte-identical writes to
 * one path a PROVEN no-op — a fact, not an inference — so `repeated-identical-
 * edit` fires at round 2 and keeps firing. Every other pattern needs more
 * scaffolding to reproduce and proves the same wiring.
 */
function loopingModel(counter) {
  return async () => {
    counter.rounds += 1;
    return {
      ok: true,
      content: 'writing it again',
      toolCalls: [{
        id: `c${counter.rounds}`,
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'stuck.txt', content: 'the same bytes' }) },
      }],
      usage: null,
      finishReason: 'tool_calls',
    };
  };
}

const base = (dir, callModelImpl) => ({
  task: 'go in a circle',
  executor: createLocalExecutor(dir),
  config: { apiKey: 'test', model: 'test/model' },
  callModelImpl,
  maxRounds: 6,
  // ⚠️ `--budget none`, so the ONLY thing that can stop these runs early is the
  // setting under test. A ceiling firing first would make the test pass for the
  // wrong reason.
  budgetUsd: null,
  onEvent: () => {},
});

test('⭐⭐ STUCK — the DEFAULT nudges and never stops a bounded run', async (t) => {
  const dir = workspace(t);
  const counter = { rounds: 0 };
  const outcome = await runSession(base(dir, loopingModel(counter)));

  assert.notEqual(outcome.stoppedBecause, 'stuck', 'the default must not hard-stop a bounded run on a loop');
  assert.equal(counter.rounds, 6, `the default ran ${counter.rounds} rounds; it must use its whole round ceiling`);

  // ⭐ …and it DID notice, which is what makes the next test's stop meaningful.
  const hints = outcome.messages.filter((m) => String(m.content ?? '').includes('[loop watcher'));
  assert.equal(hints.length, 1, `expected exactly one hint per distinct loop, got ${hints.length}`);
});

test('⭐⭐ STUCK — `--on-stuck stop` ENDS the same run', async (t) => {
  const dir = workspace(t);
  const counter = { rounds: 0 };
  const outcome = await runSession({ ...base(dir, loopingModel(counter)), onStuck: 'stop' });

  assert.equal(outcome.stoppedBecause, 'stuck', `the run did not stop; it ended because ${outcome.stoppedBecause}`);
  assert.ok(counter.rounds < 6, `it still ran all ${counter.rounds} rounds — the setting was not reached`);
});

test('⭐⭐ STUCK — `--on-stuck ask` stops when the human says no', async (t) => {
  const dir = workspace(t);
  const counter = { rounds: 0 };
  const asked = [];
  const outcome = await runSession({
    ...base(dir, loopingModel(counter)),
    onStuck: 'ask',
    mcpAsk: async (q) => { asked.push(q); return 'n'; },
  });

  assert.equal(asked.length, 1, `expected to be asked exactly once, was asked ${asked.length} times`);
  assert.match(asked[0], /Keep going\?/);
  assert.equal(outcome.stoppedBecause, 'stuck');
});

test('⚠️ STUCK — `ask` with a human who says YES keeps going, and re-hints', async (t) => {
  const dir = workspace(t);
  const counter = { rounds: 0 };
  const outcome = await runSession({
    ...base(dir, loopingModel(counter)),
    onStuck: 'ask',
    mcpAsk: async () => 'y',
  });

  assert.notEqual(outcome.stoppedBecause, 'stuck');
  assert.equal(counter.rounds, 6, 'a "yes" must not shorten the run');
});

test('⚠️⚠️ STUCK — `ask` with NO terminal degrades to nudge, never to stop', async (t) => {
  /**
   * A run that silently ended because it was configured to ask a question
   * nobody could hear is the least legible failure available, and it throws away
   * money already spent. Failing toward MORE work is the only safe direction.
   */
  const dir = workspace(t);
  const counter = { rounds: 0 };
  const outcome = await runSession({ ...base(dir, loopingModel(counter)), onStuck: 'ask', mcpAsk: null });

  assert.notEqual(outcome.stoppedBecause, 'stuck');
  assert.equal(counter.rounds, 6);
});

test('⭐⭐ ASK — `--max-questions` reaches the model-facing allowance', async (t) => {
  /**
   * `MAX_QUESTIONS = 3` was a constant with no way in. This drives the real
   * loop with an allowance of ONE and asserts the second question is refused by
   * the runner rather than put to the person.
   */
  const dir = workspace(t);
  const putToHuman = [];
  let round = 0;
  const model = async () => {
    round += 1;
    if (round > 3) return { ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' };
    return {
      ok: true,
      content: 'a question',
      toolCalls: [{ id: `q${round}`, function: { name: 'ask_user', arguments: JSON.stringify({ question: `question ${round}?` }) } }],
      usage: null,
      finishReason: 'tool_calls',
    };
  };

  const outcome = await runSession({
    ...base(dir, model),
    maxQuestions: 1,
    mcpAsk: async (q) => { putToHuman.push(q); return 'an answer'; },
  });

  assert.equal(outcome.ok, true);
  assert.equal(putToHuman.length, 1, `the allowance of 1 let ${putToHuman.length} questions reach the person`);

  // ⭐ And the model was TOLD, rather than being left to guess why it went quiet.
  const refusals = outcome.messages.filter((m) => String(m.content ?? '').includes('all 1 of your questions'));
  assert.ok(refusals.length >= 1, 'the model was not told its allowance was spent');
});

test('⚠️ ASK — `--max-questions 0` means the agent never asks at all', async (t) => {
  const dir = workspace(t);
  const putToHuman = [];
  let round = 0;
  const model = async () => {
    round += 1;
    if (round > 2) return { ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' };
    return {
      ok: true,
      content: 'a question',
      toolCalls: [{ id: `q${round}`, function: { name: 'ask_user', arguments: JSON.stringify({ question: 'which one?' }) } }],
      usage: null,
      finishReason: 'tool_calls',
    };
  };

  await runSession({
    ...base(dir, model),
    maxQuestions: 0,
    mcpAsk: async (q) => { putToHuman.push(q); return 'an answer'; },
  });

  assert.equal(putToHuman.length, 0, 'an allowance of 0 still interrupted the user');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * DONE — the rule that scored 0/6, now a setting
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A model that runs one REAL, passing verification EVERY round.
 *
 * ⚠️ `node --test` ON A REAL PASSING FILE, not a fake tool record.
 * `looksLikeVerification` reads the PROGRAM, and `doneDecision` reads
 * `result.passed`, which only a process that actually ran can set. A synthetic
 * record would test the assertion and not the wiring.
 *
 * ⭐ EVERY ROUND, because the default rule is "a pass buys one more round, and
 * a pass in THAT round closes it". A model that verifies once and then does
 * something else never reaches the close, so it could not tell the three modes
 * apart — it would hit the round cap under all of them.
 */
function alwaysVerifyModel(counter) {
  return async () => {
    counter.rounds += 1;
    return {
      ok: true,
      content: 'checking',
      toolCalls: [{ id: `v${counter.rounds}`, function: { name: 'run_command', arguments: JSON.stringify({ command: 'node --test ok.test.mjs' }) } }],
      usage: null,
      finishReason: 'tool_calls',
    };
  };
}

function withPassingTest(t) {
  const dir = workspace(t);
  writeFileSync(join(dir, 'ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n", 'utf8');
  return dir;
}

test('⭐⭐ DONE — the DEFAULT closes the run after a passing check plus one grace round', async (t) => {
  const dir = withPassingTest(t);
  const counter = { rounds: 0 };
  const outcome = await runSession(base(dir, alwaysVerifyModel(counter)));

  assert.equal(outcome.stoppedBecause, 'verified', `stopped because ${outcome.stoppedBecause}`);
  assert.equal(counter.rounds, 2, `the grace round is exactly one; the run took ${counter.rounds} rounds`);
});

test('⭐⭐ DONE — `--done never` refuses to let the same green check end it', async (t) => {
  const dir = withPassingTest(t);
  const counter = { rounds: 0 };
  const outcome = await runSession({ ...base(dir, alwaysVerifyModel(counter)), doneWhen: 'never' });

  assert.notEqual(outcome.stoppedBecause, 'verified', 'a passing command still closed the run under --done never');
  assert.equal(counter.rounds, 6, `it ran ${counter.rounds} rounds; it should have used its whole ceiling`);
});

test('⭐⭐ DONE — `--done acceptance` holds the run open while the DECLARED command is unrun', async (t) => {
  /**
   * The false tick `acceptance.mjs` exists to kill, reached through the loop:
   * `node --test ok.test.mjs` genuinely passes, and it is not what the user
   * declared. Under the default that closes the run; under `acceptance` it does
   * not.
   */
  const dir = withPassingTest(t);
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  writeFileSync(join(dir, '.acuvo', 'acceptance.json'), `${JSON.stringify({
    version: 1,
    declaredAt: new Date().toISOString(),
    criteria: [{ command: 'node --test other.test.mjs', runnable: true, reason: null }],
  })}\n`, 'utf8');

  const counter = { rounds: 0 };
  const outcome = await runSession({ ...base(dir, alwaysVerifyModel(counter)), doneWhen: 'acceptance' });

  assert.notEqual(outcome.stoppedBecause, 'verified', 'a command the user never declared closed the run');
  assert.ok(counter.rounds > 2, `the run closed after ${counter.rounds} rounds despite an unrun criterion`);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * COST — crash safety, wired
 * ═══════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ COST — a resumed spend really is subtracted by the LOOP, not just by the ledger', async (t) => {
  /**
   * `four-questions-config.test.mjs` proves `createBudget` honours `resumedUsd`.
   * This proves `runSession` passes it through — the half that is normally
   * missing when a capability ships built-but-unreached.
   */
  const dir = workspace(t);
  let calls = 0;
  const model = async () => {
    calls += 1;
    return { ok: true, content: 'hi', toolCalls: [], usage: null, finishReason: 'stop' };
  };

  const outcome = await runSession({
    ...base(dir, model),
    budgetUsd: 0.05,
    resumedUsd: 0.05,   // an earlier process of this run already spent the lot
  });

  assert.equal(outcome.ok, false, 'the resumed run started anyway');
  assert.equal(outcome.stage, 'budget');
  assert.equal(calls, 0, 'it called the model before discovering it had no money left');
});

test('⚠️ COST — with no resumed spend the identical run proceeds (the guard can fail)', async (t) => {
  const dir = workspace(t);
  let calls = 0;
  const model = async () => {
    calls += 1;
    return { ok: true, content: 'hi', toolCalls: [], usage: null, finishReason: 'stop' };
  };
  const outcome = await runSession({ ...base(dir, model), budgetUsd: 0.05 });
  assert.equal(outcome.ok, true);
  assert.equal(calls, 1);
});

test('⚠️⚠️ bin/acuvo.mjs actually OPENS the journal and hands it to the loop', () => {
  /**
   * ⭐ THE WIRING GUARD, in the idiom `write-approval-wiring.test.mjs`
   * established. A crash-safe ceiling that `bin/` never opens is a ceiling that
   * still dies with the process, and every unit test above would stay green.
   */
  const src = readFileSync(new URL('../bin/acuvo.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /openSpendJournal\(\{/, 'bin/ never opens a spend journal');
  assert.match(src, /runKey:\s*stickyKey/, 'the journal must be keyed on the id that survives a crash');
  assert.match(src, /resumedUsd:\s*spendJournal\.priorUsd/, 'the resumed spend never reaches runSession');
  assert.match(src, /budgetJournal:\s*spendJournal/, 'the appender never reaches runSession, so nothing is recorded');
  assert.match(src, /resumeCeiling\(\{/, 'the tighter-ceiling-wins rule is never applied');
});

test('⚠️⚠️ bin/acuvo.mjs hands all four answers to every runSession it starts', () => {
  const src = readFileSync(new URL('../bin/acuvo.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const [field, snippet, expected] of [
    ['doneWhen', 'doneWhen: opts.doneWhen,', 3],
    ['onStuck', 'onStuck: opts.onStuck,', 3],
    ['maxQuestions', 'maxQuestions: opts.maxQuestions,', 3],
    ['approveMode', 'approveMode: opts.approveMode ?? null,', 3],
  ]) {
    const n = src.split(snippet).length - 1;
    assert.equal(
      n, expected,
      `${field} is passed at ${n} of the ${expected} runSession call sites — one-shot, --parallel and --best-of must all get it, `
      + 'or the setting silently stops applying the moment you fan out.',
    );
  }
});
