/**
 * ── ⭐⭐ SAYING SOMETHING WHILE IT WORKS ─────────────────────────────────────
 *
 * `--help` documents steering BETWEEN turns (`--resume <id> "now add tests"`).
 * This is the during-run version: an eight-round build takes minutes, and the
 * moment you want to say "stop writing tests, just fix the import" is round
 * three, not after round eight.
 *
 * ⚠️ THE INPUT CHANNEL WAS THE DECISION, AND A KEYSTROKE LOSES IT. Interactive
 * mode's stdin is owned by `readline`; one-shot mode — the long case, the case
 * that needs steering most — has no readline and usually no stdin at all. A
 * file works in both, in an editor in another pane, and from a second terminal.
 *
 * ⚠️ THE RULES UNDER TEST, EACH ONE A REAL FAILURE OTHERWISE:
 *   · consumed, not watched — or one instruction repeats forever
 *   · announced — a steer nobody was told about makes "why did it do that?"
 *     unanswerable, which is the rule `turn.mjs` already states for the memory
 *     file
 *   · a USER message at a ROUND BOUNDARY, never mid-round
 *   · the rounds are NOT refilled — otherwise `--max-rounds 8` plus three
 *     steers silently means 32
 *   · bounded, so a script that rewrites the file is not an infinite spend
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  takeSteer, steerPath, steerTask, planSteer, formatSteer, formatUnapplied,
  STEER_FILE, MAX_STEERS, MAX_STEER_CHARS, STEER_ABORT_REASON,
} from '../lib/steer.mjs';

function ws(contents = null) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-steer-'));
  if (contents !== null) {
    mkdirSync(join(root, '.acuvo'), { recursive: true });
    writeFileSync(steerPath(root), contents, 'utf8');
  }
  return root;
}

/* ── reading it ─────────────────────────────────────────────────────────── */

test('⭐ nothing to say is the ordinary case and costs nothing', () => {
  assert.equal(takeSteer(ws()), null, 'no file, no steer — every run that never uses this');
});

test('⭐⭐ a steer is READ AND DELETED — consumed, never watched', () => {
  /**
   * Left on disk it would be re-applied at every round boundary for the rest of
   * the run: one instruction becoming one the user cannot stop giving.
   */
  const root = ws('now add tests');
  const first = takeSteer(root);
  assert.deepEqual(first, { text: 'now add tests', truncated: false, stale: false });
  assert.equal(existsSync(steerPath(root)), false, 'the file must be gone');
  assert.equal(takeSteer(root), null, 'and a second read must find nothing');
});

test('⚠️ an EMPTY or whitespace file is not an instruction', () => {
  for (const junk of ['', '   ', '\n\n\t\n']) {
    const root = ws(junk);
    assert.equal(takeSteer(root), null, `${JSON.stringify(junk)} must not cost a round`);
    /**
     * ⚠️ AND IT IS STILL DELETED. A blank file that stayed would be re-read at
     * every single round boundary for the rest of the run.
     */
    assert.equal(existsSync(steerPath(root)), false, 'the useless file must still be consumed');
  }
});

test('⚠️ an enormous paste is capped rather than blowing the context', () => {
  const root = ws('x'.repeat(MAX_STEER_CHARS + 5000));
  const s = takeSteer(root);
  assert.equal(s.text.length, MAX_STEER_CHARS);
  assert.equal(s.truncated, true, 'and it must SAY it was cut, or the user never learns why');
});

test('⚠️ a read that throws costs the steer, never the run', () => {
  const root = ws('do the other thing');
  const s = takeSteer(root, {
    exists: () => true,
    read: () => { throw new Error('EBUSY: file locked by another process'); },
    remove: () => {},
  });
  assert.equal(s, null, 'this runs on the round-boundary hot path of every run');
});

test('⭐⭐ THE AGENT CANNOT WRITE ITS OWN STEER FILE', async () => {
  assert.match(STEER_FILE, /^\.acuvo[\\/]steer\.txt$/,
    'anywhere else and the tool would dirty the user\'s git tree — the defect acuvo-dir.mjs exists for');
  /**
   * ⚠️⚠️ AND THAT IS NOT A TIDINESS POINT. `.acuvo/` is the one directory the
   * agent is hard-refused write access to, by `policy.mjs` and by
   * `workspace.mjs` independently. A steering channel the MODEL could write to
   * is a model that hands itself new instructions mid-run and has them
   * announced to the user as *their own words*. Put the file anywhere else in
   * the workspace and that is exactly what it becomes — so this assertion is
   * bound to the real guard, not to a path string.
   */
  const { isPolicyProtectedPath } = await import('../lib/policy.mjs');
  const relative = STEER_FILE.split('\\').join('/');
  assert.equal(isPolicyProtectedPath(relative), true,
    'the steer file must sit behind the same refusal that protects policy.json and mcp.json');
});

test('⚠️⚠️ a steer written BEFORE the run started cannot hijack it', () => {
  /**
   * FOUND BY RUNNING IT. A steer written 200ms after the last round boundary is
   * never picked up and the file simply survives the run — measured on a live
   * `acuvo`. The NEXT run in that workspace would then consume it at round one
   * and apply "actually make it a haiku", written about yesterday's task, to
   * whatever is being asked today.
   *
   * ⭐ A steer must be newer than the turn it steers. It is still consumed
   * exactly once and its words are still handed back, so nothing is silently
   * obeyed and nothing is silently destroyed.
   */
  const root = ws('actually make it a haiku');
  const turnStartedAt = Date.now() + 60_000;      // the file is an hour "old"
  const s = takeSteer(root, { newerThan: turnStartedAt });
  assert.equal(s.stale, true);
  assert.equal(existsSync(steerPath(root)), false, 'consumed, so it cannot hijack a THIRD run either');

  const plan = planSteer({ steer: s, outcome: aborted(), maxRounds: 8, steersUsed: 0 });
  assert.equal(plan.go, false, 'a stale steer must never reach the model');
  assert.match(plan.reason, /BEFORE this run started/);
  /**
   * ⚠️⚠️ AND THE STALE CHECK MUST COME BEFORE THE `aborted` ONE. A stale steer
   * does NOT abort the run — measured: the first version did, and a leftover
   * file destroyed a run at round 1 with "No files changed". So the outcome
   * reaching `planSteer` is a NORMAL completion, and if the aborted check ran
   * first the user would be told "the run had already finished", which is true,
   * useless, and hides the actual reason.
   */
  const finished = { stoppedBecause: 'no-tool-calls', roundsUsed: 2, messages: [{ role: 'user', content: 'x' }] };
  const onFinished = planSteer({ steer: s, outcome: finished, maxRounds: 8, steersUsed: 0 });
  assert.equal(onFinished.go, false);
  assert.match(onFinished.reason, /BEFORE this run started/, 'the stale reason must win over "already finished"');
  assert.match(formatUnapplied({ text: s.text, reason: plan.reason }), /actually make it a haiku/,
    'and the user still gets their sentence back');
});

test('⭐ a steer written DURING the run is not stale', () => {
  const root = ws('now add tests');
  const s = takeSteer(root, { newerThan: Date.now() - 60_000 });
  assert.equal(s.stale, false, 'the ordinary case — the file is newer than the turn');
  assert.equal(planSteer({ steer: s, outcome: aborted(), maxRounds: 8, steersUsed: 0 }).go, true);
});

test('⚠️ a stat that throws must not make a LIVE steer look stale', () => {
  // The conservative failure is to apply it: the user did write it.
  const root = ws('use fetch, not axios');
  const s = takeSteer(root, { newerThan: Date.now(), modified: () => { throw new Error('EPERM'); } });
  assert.equal(s.stale, false);
});

/* ── what the model receives ────────────────────────────────────────────── */

test('⭐⭐ the instruction is labelled as coming from the USER, not the runner', () => {
  const t = steerTask('stop writing tests, just fix the import');
  assert.match(t, /stop writing tests, just fix the import/);
  /**
   * ⚠️ `turn.mjs` injects its own automated user messages prefixed
   * `[runner — automatic, not from the user]` precisely so the model can tell
   * an instruction from a nudge. An unlabelled steer would be weighted like
   * automation.
   */
  assert.match(t, /from YOU, the user/);
  assert.doesNotMatch(t, /runner — automatic/);
  assert.ok(t.includes(STEER_FILE), 'and it names the file, so "why did it do that?" is answerable');
});

test('⭐ it asks the agent to say what it is changing — rule: announced', () => {
  const t = steerTask('use fetch, not axios');
  assert.match(t, /Say in one short line what you are changing/);
  assert.match(t, /carry on from here rather than starting over/,
    'a steer must not throw away the work the user was watching');
});

test('⭐ the terminal line shows the instruction, the rounds left and the spend so far', () => {
  const line = formatSteer({ text: 'now add tests', roundsLeft: 5, spentUsd: 0.0021 });
  assert.match(line, /steering/);
  assert.match(line, /now add tests/);
  assert.match(line, /5 rounds left/);
  /**
   * ⚠️ THE MONEY IS ON THIS LINE ON PURPOSE. The final summary prices the LAST
   * segment; without this the dollars spent before the steer appear nowhere a
   * person reads.
   */
  assert.match(line, /\$0\.002100 spent so far/);
  assert.match(formatSteer({ text: 'x', roundsLeft: 1 }), /1 round left/, 'singular, not "1 rounds"');
});

test('⚠️⚠️ a steer that could NOT be applied hands the words back', () => {
  /**
   * `takeSteer` deletes on read — it must, or one instruction repeats forever.
   * The consequence: when the steer cannot be used, the only copy of what the
   * user typed is in memory. Printing the reason alone would mean they watched
   * their sentence be consumed and discarded and had to retype it.
   */
  const line = formatUnapplied({ text: 'stop and just fix the import', reason: 'no rounds left (--max-rounds 8 is spent)' });
  assert.match(line, /steer NOT applied/);
  assert.match(line, /no rounds left/);
  assert.match(line, /stop and just fix the import/, 'the user must get their own words back');
  assert.match(line, /"stop and just fix the import"/, 'quoted, so it can be pasted straight back');
});

/* ── the decision ───────────────────────────────────────────────────────── */

const aborted = (over = {}) => ({ stoppedBecause: 'aborted', roundsUsed: 3, messages: [{ role: 'user', content: 'hi' }], ...over });

test('⭐⭐ a steer after an aborted round continues the SAME transcript', () => {
  const outcome = aborted();
  const plan = planSteer({ steer: { text: 'now add tests' }, outcome, maxRounds: 8, steersUsed: 0 });
  assert.equal(plan.go, true);
  /**
   * ⚠️ THE SAME ARRAY, not a copy and not a rebuild. `runSession` re-gathers the
   * whole workspace when `priorMessages` is absent, which both costs tokens and
   * — the part that matters — CHANGES THE PREFIX and throws away the cache.
   */
  assert.equal(plan.priorMessages, outcome.messages);
  assert.ok(Array.isArray(plan.priorMessages) && plan.priorMessages.length === 1,
    'continuing means appending to the conversation, not starting a new one — that is also what keeps the 96% cache hit');
  assert.match(plan.task, /now add tests/);
});

test('⚠️⚠️ the rounds are NOT refilled — 8 minus 3 used is 5, not 8', () => {
  /**
   * Otherwise `--max-rounds 8` plus three steers quietly means 32 rounds and
   * the flag is a lie.
   */
  const plan = planSteer({ steer: { text: 'go' }, outcome: aborted({ roundsUsed: 3 }), maxRounds: 8, steersUsed: 0 });
  assert.equal(plan.maxRounds, 5);
  assert.equal(plan.roundsLeft, 5);
});

test('⚠️ with no rounds left the steer is REFUSED, with a reason and a way out', () => {
  const plan = planSteer({ steer: { text: 'go' }, outcome: aborted({ roundsUsed: 8 }), maxRounds: 8, steersUsed: 0 });
  assert.equal(plan.go, false);
  assert.match(plan.reason, /no rounds left/);
  assert.match(plan.reason, /--max-rounds|--continue/, 'a refusal that does not say what to do next is half a refusal');
});

test('⚠️⚠️ a run that FINISHED is not steered — the steer would buy rounds nobody asked for', () => {
  for (const because of ['verified', 'no-tool-calls', 'limit-reached', 'model-error']) {
    const plan = planSteer({
      steer: { text: 'go' },
      outcome: { stoppedBecause: because, roundsUsed: 2, messages: [{ role: 'user', content: 'x' }] },
      maxRounds: 8, steersUsed: 0,
    });
    assert.equal(plan.go, false, `${because} must not start a new segment`);
    assert.match(plan.reason, /already finished/);
    assert.match(plan.reason, new RegExp(because.replace('-', '.')));
  }
});

test('⚠️ without a transcript a "continuation" would be a new run wearing its name', () => {
  for (const messages of [undefined, null, []]) {
    const plan = planSteer({ steer: { text: 'go' }, outcome: aborted({ messages }), maxRounds: 8, steersUsed: 0 });
    assert.equal(plan.go, false);
    assert.match(plan.reason, /no transcript/);
  }
});

test('⚠️⚠️ steering is BOUNDED at THREE — a script that rewrites the file is not an infinite spend', () => {
  /**
   * ── ⚠️⚠️ EVERY TERM HERE USED TO COME FROM THE CONSTANT ───────────────────
   *
   * `steersUsed: MAX_STEERS` refused, `MAX_STEERS - 1` went, and the regex was
   * built from `MAX_STEERS` too. So `MAX_STEERS = 10000` left the suite green —
   * the bound on how much money one hijacked file can spend was satisfied by
   * any number at all. Found by an adversarial pass mutating the VALUE; four
   * earlier passes had each mutated the COMPARISON (`if (false && …)`), which
   * goes red and therefore made the blind spot look covered.
   *
   * ⭐ Bound to its noun now. The constant's paragraph argues for three
   * specifically: enough for "no, the other file" → "now add a test" → "run
   * it", few enough that a loop rewriting the file stops on its own.
   */
  assert.equal(MAX_STEERS, 3,
    'three is a judgement with a paragraph behind it, and it caps what one hijacked file can spend. Changing it is a decision, not a refactor.');

  // Literals, so the assertion says what it means without asking the code.
  const plan = planSteer({ steer: { text: 'go' }, outcome: aborted(), maxRounds: 20, steersUsed: 3 });
  assert.equal(plan.go, false, 'a fourth steer must be refused');
  assert.match(plan.reason, /cap is 3/);
  assert.equal(planSteer({ steer: { text: 'go' }, outcome: aborted(), maxRounds: 20, steersUsed: 2 }).go, true,
    'a third steer must still go — the cap must not bite one early');
});

test('⭐ no steer means no decision at all, and nothing printed', () => {
  const plan = planSteer({ steer: null, outcome: aborted(), maxRounds: 8, steersUsed: 0 });
  assert.equal(plan.go, false);
  assert.equal(plan.reason, null, 'the 99.9% of rounds with no steer must print nothing');
});

/* ── REACH: the real loop, steered at a real round boundary ─────────────── */

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

test('⭐⭐ REACH — the file stops the REAL loop, and the text lands as a USER message', async () => {
  /**
   * This is the whole feature joined up, with only the model faked: a steer
   * appears on disk mid-run, the round-boundary hook consumes it and aborts,
   * `runSession` returns cleanly WITH its transcript, and a second `runSession`
   * carries that transcript plus the instruction — which is exactly what
   * `bin/acuvo.mjs`'s `steerable` does with a real model.
   */
  const root = mkdtempSync(join(tmpdir(), 'acuvo-steer-reach-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  const executor = createLocalExecutor(root);
  const controller = new AbortController();

  let steer = null;
  let round = 0;
  const onEvent = (event) => {
    if (event.type !== 'round-start') return;
    round += 1;
    // The user writes the file while round 2 is being set up.
    if (round === 2) writeFileSync(steerPath(root), '  stop writing tests, just fix the import\n', 'utf8');
    if (steer === null) {
      const taken = takeSteer(root);
      if (taken) { steer = taken; controller.abort(STEER_ABORT_REASON); }
    }
  };

  const model = async () => ({
    ok: true, content: 'working', usage: {}, finishReason: 'tool_calls',
    toolCalls: [{ id: `r${round}`, name: 'read_file', arguments: { path: 'nope.txt' } }],
  });

  const first = await runSession({
    task: 'build the thing', executor, config: { apiKey: 'k', model: 'm' },
    signal: controller.signal, maxRounds: 8, callModelImpl: model, onEvent,
  });

  assert.equal(first.stoppedBecause, 'aborted', 'the steer must stop the loop');
  assert.ok(steer && steer.text === 'stop writing tests, just fix the import',
    'and the file must have been read and trimmed');
  assert.equal(existsSync(steerPath(root)), false, 'and consumed');
  assert.ok(first.roundsUsed >= 1 && first.roundsUsed < 8, `stopped mid-run, used ${first.roundsUsed}`);

  const plan = planSteer({ steer, outcome: first, maxRounds: 8, steersUsed: 0 });
  assert.equal(plan.go, true);

  let sent = null;
  const second = await runSession({
    task: plan.task,
    priorMessages: plan.priorMessages,
    executor, config: { apiKey: 'k', model: 'm' },
    maxRounds: plan.maxRounds,
    callModelImpl: async ({ messages }) => {
      sent = messages;
      return { ok: true, content: 'ok, fixing the import instead', toolCalls: [], usage: {}, finishReason: 'stop' };
    },
    onEvent: () => {},
  });

  assert.equal(second.ok, true);
  /**
   * ⭐⭐ THE CLAIM THIS WHOLE FILE IS ABOUT: the instruction reached the model
   * as a USER message, at a boundary, on top of the conversation so far.
   */
  const last = sent[sent.length - 1];
  assert.equal(last.role, 'user', 'a steer is something the USER said');
  assert.match(last.content, /stop writing tests, just fix the import/);
  assert.match(last.content, /from YOU, the user/, 'and it is announced, per turn.mjs\'s own rule');
  assert.ok(sent.length > 2, 'the earlier conversation must still be underneath it');
  assert.equal(sent[0].role, 'system', 'the cacheable prefix must be untouched — that is the 96% hit');
  assert.equal(plan.maxRounds, 8 - first.roundsUsed, 'and the continuation runs on what was left');
});

test('⭐⭐ REACH — a run with NO steer file is byte-identical to one from before this existed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-steer-none-'));
  let calls = 0;
  const controller = new AbortController();
  const out = await runSession({
    task: 'do the thing',
    executor: createLocalExecutor(root),
    config: { apiKey: 'k', model: 'm' },
    signal: controller.signal,
    maxRounds: 3,
    callModelImpl: async () => { calls += 1; return { ok: true, content: 'done', toolCalls: [], usage: {}, finishReason: 'stop' }; },
    onEvent: (e) => { if (e.type === 'round-start' && takeSteer(root)) controller.abort(STEER_ABORT_REASON); },
  });
  assert.equal(calls, 1);
  assert.notEqual(out.stoppedBecause, 'aborted');
  assert.equal(existsSync(join(root, '.acuvo', 'steer.txt')), false);
});

/* ── the CLI really calls it ────────────────────────────────────────────── */

test('⭐⭐ bin/acuvo.mjs WIRES it — the defect this package ships most is the unreached feature', () => {
  /**
   * ⚠️ `lib/interrupt.mjs` shipped with every part built, every caller ready,
   * and nothing registering a handler. A grep is a weak test, but the failure
   * it guards is the one that actually happens here: a lib nothing imports.
   * The real end-to-end proof is a live `acuvo` run, recorded in the commit.
   */
  const src = readFileSync(new URL('../bin/acuvo.mjs', import.meta.url), 'utf8');
  assert.match(src, /from '\.\.\/lib\/steer\.mjs'/, 'bin must import it');
  assert.match(src, /takeSteer\(root, \{ newerThan: turnStartedAt \}\)/,
    'it must read a steer at the round boundary, AND pass the turn clock — without that a leftover file hijacks the next run');
  assert.match(src, /if \(!steer\.stale\) controller\.abort\(STEER_ABORT_REASON\)/,
    'and a stale steer must not abort the run it does not belong to');
  assert.match(src, /steerable\(task, null\)/, 'the --issue path must be steerable');
  assert.match(src, /steerable\(task, priorMessages\)/, 'the one-shot path must be steerable');
  assert.match(src, /runOne: steerable/, 'and the interactive loop must be too');
});
