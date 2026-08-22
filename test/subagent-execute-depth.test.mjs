/**
 * ── ⚠️⚠️ THE DEPTH GUARD, ON THE *EXECUTING* VARIANT SPECIFICALLY ───────────
 *
 * `delegate` is three capabilities behind one boolean pair, not one:
 *
 *   (default)                → SUBAGENT_TOOL_NAMES,        allowRun: false
 *   write:true               → SUBAGENT_WRITE_TOOL_NAMES,  allowRun: false
 *   write:true + verify:true → SUBAGENT_VERIFY_TOOL_NAMES, allowRun: TRUE,
 *                              and `linkNodeModules: true` so `npm test` in the
 *                              isolated copy can resolve its imports at all.
 *
 * The third one is the one that starts a PROCESS. Recursion of a researcher is
 * a bill; recursion of an executor is a fork bomb with a credit card — each
 * level spawns a shell that can spawn the next.
 *
 * ⚠️ AND THE EXISTING COVERAGE DOES NOT REACH IT. `subagent.test.mjs:121`
 * ("depth is capped, and the refusal explains itself") passes NEITHER `write`
 * nor `verify`, so it exercises the researcher branch and nothing else.
 * `delegate-context-and-verify.test.mjs` covers the executing variant
 * thoroughly — the tool list, `allowRun`, `linkNodeModules`, the degraded
 * verdict when the link fails — and the string `depth` appears in it exactly
 * once, in a comment. So the single guard standing between an executing helper
 * and unbounded recursion had no test that could observe it firing on the
 * executing path. This file is that test.
 *
 * ⚠️ THE ORDER IS THE WHOLE POINT, NOT JUST THE RETURN VALUE. `runSubagent`
 * checks depth at the top, BEFORE it resolves `runSession`, before the
 * `executor.root` check, and before `runInIsolatedCopy` is called. That
 * ordering is what makes the refusal free: a guard that fired after the copy
 * would already have paid for a recursive `cpSync` of the workspace — and one
 * that fired after `run` would already have paid a model. So these tests assert
 * the collaborators were NEVER CALLED, which is a fact about the ordering; a
 * test that only read `r.ok === false` would still pass if the guard were moved
 * below the copy, which is the realistic way this regresses.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  runSubagent,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_TOOL_NAMES,
  SUBAGENT_VERIFY_TOOL_NAMES,
} from '../lib/subagent.mjs';

const config = { apiKey: 'k', model: 'test-model' };

/**
 * ⚠️ A REAL-LOOKING ROOT, AND THAT IS DELIBERATE. `runSubagent` refuses a
 * building helper whose executor has no `root` string. If this fixture had no
 * root, the refusal below would prove only that the WORKSPACE check fired and
 * would keep passing with the depth guard deleted entirely — a test that cannot
 * fail. Nothing touches the path: `isolateImpl` is injected in every case that
 * gets far enough to use one, so no directory is ever copied or created.
 */
const executor = { root: 'C:/fake/root', dryRun: false };

/** Records whether it was reached at all; returns a minimal finished session. */
function spySession() {
  const fn = async (opts) => {
    fn.calls.push(opts);
    return {
      ok: true,
      stage: 'done',
      note: 'did the thing',
      usage: { cost: 0.0002, total_tokens: 500 },
      executed: [],
      rounds: [{ round: 1 }],
      roundsUsed: 1,
      verification: { ran: true, passed: true, command: 'npm test', exitCode: 0 },
    };
  };
  fn.calls = [];
  return fn;
}

/** Records whether a copy was ever asked for; runs the session in place if so. */
function spyIsolate() {
  const fn = async (a) => {
    fn.calls.push(a);
    return {
      ok: true,
      outcome: await a.run(a.root),
      written: [],
      refused: [],
      problems: [],
      dependenciesLinked: true,
    };
  };
  fn.calls = [];
  return fn;
}

const stubExecutor = (root) => ({ root, dryRun: false });

test('⚠️⚠️ an EXECUTING helper (write+verify) is refused at the depth ceiling — no copy, no model', async () => {
  const sessionImpl = spySession();
  const isolateImpl = spyIsolate();

  const r = await runSubagent(
    { task: 'build it and prove it', write: true, verify: true, executor, config, depth: MAX_SUBAGENT_DEPTH },
    { sessionImpl, isolateImpl, makeExecutor: stubExecutor },
  );

  assert.equal(r.ok, false, 'an executing helper was allowed to delegate again');
  assert.match(String(r.error), /depth|deeper|narrower/i, 'the refusal must say WHY, or the parent retries it forever');

  /**
   * ⚠️ THESE TWO ARE THE ASSERTIONS WITH TEETH. A guard relocated below the
   * copy still returns ok:false, so only "the copier was never called" can tell
   * the difference between refusing cheaply and refusing after paying.
   */
  assert.equal(isolateImpl.calls.length, 0, 'the workspace was copied before the depth guard fired');
  assert.equal(sessionImpl.calls.length, 0, 'a model was called before the depth guard fired');
});

test('⚠️ and a plain BUILDER (write, no verify) is refused at the ceiling too', async () => {
  const sessionImpl = spySession();
  const isolateImpl = spyIsolate();

  const r = await runSubagent(
    { task: 'write the tests', write: true, executor, config, depth: MAX_SUBAGENT_DEPTH },
    { sessionImpl, isolateImpl, makeExecutor: stubExecutor },
  );

  assert.equal(r.ok, false);
  assert.equal(isolateImpl.calls.length, 0);
  assert.equal(sessionImpl.calls.length, 0);
});

/**
 * ── ⭐ THE POSITIVE CONTROL, AND IT IS NOT OPTIONAL ─────────────────────────
 *
 * Every assertion above is satisfied by an executing `delegate` that is simply
 * BROKEN — refuse unconditionally and all three files go green. This test is
 * what distinguishes "the guard fired" from "the capability does not work": at
 * depth 0 the identical call must reach the copier, ask for the dependencies,
 * unlock execution, and be handed the tool list containing `run_command`.
 */
test('⭐ at depth 0 the same executing call goes THROUGH — run_command, allowRun, linked deps', async () => {
  const sessionImpl = spySession();
  const isolateImpl = spyIsolate();

  const r = await runSubagent(
    { task: 'build it and prove it', write: true, verify: true, executor, config, depth: 0 },
    { sessionImpl, isolateImpl, makeExecutor: stubExecutor },
  );

  assert.equal(r.ok, true, 'the executing variant does not work at all, so the refusals above proved nothing');
  assert.equal(isolateImpl.calls.length, 1, 'an executing helper must work in an isolated copy, never the real workspace');
  assert.equal(isolateImpl.calls[0].linkNodeModules, true,
    'without the real dependency tree linked in, every command in the copy fails on "Cannot find module" — '
    + 'a red verdict about the environment wearing the costume of a red verdict about the code');

  assert.equal(sessionImpl.calls.length, 1);
  const opts = sessionImpl.calls[0];
  assert.equal(opts.allowRun, true, 'the executing variant must actually be allowed to execute');
  assert.ok(opts.toolNames.includes('run_command'), 'it cannot run a command it was never offered');
  assert.deepEqual(opts.toolNames, [...SUBAGENT_VERIFY_TOOL_NAMES]);

  /**
   * ⚠️ THE SECOND LOCK, MEASURED HERE RATHER THAN ASSUMED. The offer omits
   * `delegate`, but a model can emit a call for a tool it was never shown — so
   * the depth travels with the session and the helper's own dispatcher refuses
   * independently. If this were still 0, the guard tested above would never see
   * a value that trips it, and recursion would be unbounded in practice while
   * every test in this file stayed green.
   */
  assert.equal(opts.depth, 1, 'the helper was not told it is a helper, so its own dispatcher would allow delegate');
  assert.ok(opts.depth >= MAX_SUBAGENT_DEPTH, 'the depth handed down does not reach the ceiling, so the guard is unreachable');
});

/**
 * ⚠️ THE DEFAULT IS STILL THE READ-ONLY ONE, AND IT MUST BE ASSERTED FROM THE
 * SAME FIXTURES. An executing helper is a much larger blast radius — a process
 * in a copy of the user's repository — so it has to be ASKED for. Two booleans
 * that both have to be exactly `true` is the mechanism; this is the test that
 * the mechanism is still the default rather than a leftover.
 */
test('⚠️ with neither flag it is the RESEARCHER: no copy, no run, read-only offer', async () => {
  const sessionImpl = spySession();
  const isolateImpl = spyIsolate();

  const r = await runSubagent(
    { task: 'where is X defined', executor, config, depth: 0 },
    { sessionImpl, isolateImpl, makeExecutor: stubExecutor },
  );

  assert.equal(r.ok, true);
  assert.equal(isolateImpl.calls.length, 0, 'a researcher must not pay for a copy of the workspace');

  const opts = sessionImpl.calls[0];
  assert.equal(opts.allowRun, false);
  assert.deepEqual(opts.toolNames, [...SUBAGENT_TOOL_NAMES]);
  assert.equal(opts.toolNames.includes('run_command'), false, 'execution leaked into the default variant');
});

/**
 * ⚠️ `verify` ALONE IS NOT EXECUTION. A model that emits `verify: true` and
 * forgets `write` must get a researcher, not a process in the real workspace —
 * a researcher runs against the PARENT'S OWN EXECUTOR, so `allowRun` there
 * would put an unsupervised command in the user's actual repository to answer a
 * question. This is the pairing rule, tested from the outside.
 */
test('⚠️ verify WITHOUT write does not unlock execution', async () => {
  const sessionImpl = spySession();
  const isolateImpl = spyIsolate();

  await runSubagent(
    { task: 'check it', verify: true, executor, config, depth: 0 },
    { sessionImpl, isolateImpl, makeExecutor: stubExecutor },
  );

  assert.equal(isolateImpl.calls.length, 0);
  assert.equal(sessionImpl.calls[0].allowRun, false, 'verify alone put a live command in the user\'s real workspace');
  assert.equal(sessionImpl.calls[0].toolNames.includes('run_command'), false);
});
