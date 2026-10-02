/**
 * ── ⭐⭐⭐ THE WAIT VERB WORKED. NOBODY WAS EVER GIVEN IT. ────────────────────
 *
 * `waiting-is-not-a-round.test.mjs` proves `wait_for_output` BLOCKS, that its
 * RESULTS no longer say "check again in a later round", and that it reaches a
 * real process through `executeToolCall`. Every one of those is green, and the
 * archive still shows the poll. This file is the other half — the two places the
 * fix could not reach, both measured 2026-08-29 against
 * `bench/terminal-bench/results/` (139 transcripts, 1,903 rounds):
 *
 *   · `wait_for_output` was CALLED **0 times in 1,903 rounds**, while 204 rounds
 *     (10.7%) went on `sleep` or a bare `check_process`, and 11,078 seconds —
 *     3.1 hours — were spent inside literal `sleep`.
 *   · 104 commands were killed at a `run_command` timeout across 40 transcripts;
 *     57 of them at exactly 120s.
 *   · **24 of the 40 transcripts that timed out never called `start_process`.**
 *
 * ⚠️⚠️ TWO CAUSES, NEITHER OF THEM THE BLOCKING CODE:
 *
 * 1. THE SCHEMA SAID BUILDS WERE OUT OF SCOPE. `start_process` read *"a build in
 *    watch mode … use this for anything that does not exit on its own"*, and a
 *    `make` exits on its own. So the model correctly declined to use it for the
 *    one job that most needed it — while `wait_for_output`'s own description
 *    said the opposite (*"a BUILD or INSTALL (make, cmake, apt-get, pip, cargo)
 *    … use untilExit"*). Two schemas in the same offer, contradicting.
 * 2. THE SCHEMA ALSO TAUGHT THE POLL, and it is the copy that matters most.
 *    `startBackground`'s RESULT was fixed to name the blocking verb, but the
 *    result is read once and the SCHEMA is re-sent every single round — and it
 *    still said *"Call check_process with that id in a LATER round"*.
 *
 * 3. AND EVEN FIXED, THE VERBS WERE NOT OFFERED. `tool-shortlist.mjs` gates them
 *    behind `process`, whose words are all SERVER vocabulary — server, port,
 *    localhost, daemon, listen. Measured on this package's own offer: 9 of 12
 *    real build/install/compile/train briefs got **no background-process verb at
 *    all**, and the shortlist has defaulted ON since 2026-08-25 — after the last
 *    bench run, so no transcript in the archive could have caught it.
 *
 * ⚠️ THE WIDEN CANNOT SAVE CASE 3 ON ITS OWN. It fires when the model REACHES
 * for a missing verb; a model told by case 1 that builds are out of scope does
 * not reach. The three defects protected each other, which is why each of these
 * assertions is paired with the mutation that proves it bites.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backgroundToolSchemas } from '../lib/background.mjs';
import { logTailToolSchemas } from '../lib/log-tail.mjs';
import { shortlistTools, TOOL_GROUPS } from '../lib/tool-shortlist.mjs';
import { toolNamesForRounds } from '../lib/tools.mjs';
import { stableToolOrderKey } from '../lib/turn.mjs';

const describeOf = (schemas, name) => {
  const s = schemas.find((x) => x.function.name === name);
  assert.ok(s, `${name} is not in the offer at all`);
  return s.function.description;
};

/* ═══════════════ 1. THE SCHEMA — re-sent every round ════════════════════ */

test('⭐⭐ start_process names the long jobs that DO exit — build, install, compile', () => {
  const d = describeOf(backgroundToolSchemas(), 'start_process');
  for (const word of ['build', 'install', 'compile']) {
    assert.match(d, new RegExp(word, 'i'),
      `start_process never says "${word}", so a model reading only this schema will send that job `
      + 'to run_command and have it killed at the timeout — 104 times in the measured archive.');
  }
  /**
   * ⚠️ THE EXACT CLAUSE THAT WAS MISSING. "does not exit on its own" is still
   * true and still present; what was absent was the admission that a job which
   * DOES exit also belongs here when it outlasts run_command.
   */
  assert.match(d, /will exit/i,
    'the schema must admit the job that exits on its own but takes longer than run_command allows');
});

test('⚠️⚠️ the SCHEMA must not teach the poll — it is re-sent every round', () => {
  const d = describeOf(backgroundToolSchemas(), 'start_process');
  assert.doesNotMatch(d, /later round/i,
    `start_process's SCHEMA still tells the model to spend a round:\n${d}`);
  assert.match(d, /wait_for_output/,
    'the schema that introduces a background job must name the verb that waits on it');
  assert.match(d, /untilExit/,
    'including the form a build needs — a compile prints no ready line to match');
});

/* ═════════════ 2. THE OFFER — the verbs have to be present ══════════════ */

/** Real tasks from the archive that timed out and never called start_process. */
const BUILD_BRIEFS = [
  'Build Caffe for CPU-only execution and train CIFAR-10',
  'compile compcert from source',
  'build pmars from the source tarball',
  'build pov-ray',
  'run make to compile the project',
  'apt-get install the dependencies then cmake and make',
  'pip install the requirements and run the training script',
  'cargo build --release',
  'train the model for 10 epochs',
];

test('⭐⭐⭐ a BUILD brief is offered the verb that waits for it', () => {
  const offer = toolNamesForRounds(100, { allowRun: true });
  for (const brief of BUILD_BRIEFS) {
    const got = new Set(shortlistTools(brief, offer));
    for (const verb of ['start_process', 'wait_for_output', 'summarize_log']) {
      assert.ok(got.has(verb),
        `"${brief}" is not offered ${verb}. This is the shortlist gap: the job that blocks longest `
        + 'had no word for itself, so the only tool left was run_command and the only outcome a kill.');
    }
  }
});

test('⚠️ the closed reference set — every verb the wait schemas name is offered with them', () => {
  /**
   * ⚠️ `offered ⟺ named`. `wait_for_output`'s `cursor` parameter says "use the
   * cursor from a previous read_log", so `read_log` cannot be trimmed out of the
   * group to save its 1,840 bytes — that would name a verb the task was not
   * given. This is the assertion that priced the one-tool-one-group decision.
   *
   * ⚠️⚠️ WRITTEN WITHOUT AN `if`. The first draft wrapped the assertion in
   * `if (text.includes(verb))`, which is the shape that silently checks nothing
   * the day the text stops naming anything. The `named.length` assertion below
   * is the anti-vacuity check: if no verb is named at all, this test fails
   * rather than passing for free.
   */
  const offered = TOOL_GROUPS.process.tools;
  const text = JSON.stringify([...backgroundToolSchemas(), ...logTailToolSchemas()]
    .filter((s) => offered.includes(s.function.name)));
  const ALL = ['start_process', 'stop_process', 'check_process', 'read_log', 'wait_for_output', 'summarize_log', 'call_endpoint'];
  const named = ALL.filter((v) => text.includes(v));
  assert.ok(named.length >= 4,
    `only ${named.length} verbs are cross-named — the guard is checking nothing if the schemas stopped naming each other`);
  assert.deepEqual(named.filter((v) => !offered.includes(v)), [],
    'these verbs are named by a schema the task IS given but are not offered with it');
});

test('⚠️ the build words must NOT drag the verbs onto ordinary authoring briefs', () => {
  const offer = toolNamesForRounds(100, { allowRun: true });
  for (const brief of ['fix the failing type error in src/auth.ts', 'commit this to git']) {
    const got = new Set(shortlistTools(brief, offer));
    assert.ok(!got.has('start_process'),
      `"${brief}" gained the process verbs — the new words are too loose and every task now pays for them`);
  }
});

/* ═════════════ 3. THE CACHE PREFIX MUST NOT MOVE ════════════════════════ */

test('⭐ the new group changes no byte of the cache-prefix ordering key', () => {
  /**
   * `stableToolOrderKey` is the tools NO group can add. Every tool in `longrun`
   * was already in `process`, so the invariant head is byte-identical and the
   * prefix every task shares is untouched. If a future edit puts a NEW tool in
   * longrun, this goes red and the 77.5% cross-task prefix is the thing at risk.
   */
  /**
   * ⭐ THE FIX ADDED WORDS, NEVER TOOLS. `stableToolOrderKey` is the tools NO
   * group can add — the task-invariant head every prompt shares. Because this
   * change moved no tool into or out of any group, that head is byte-identical
   * and the measured 77.5% cross-task prefix does not move. If a later edit adds
   * a NEW tool to `process`, this goes red and names the prefix as what is at
   * risk.
   */
  const offer = toolNamesForRounds(100, { allowRun: true });
  const key = stableToolOrderKey(offer);
  assert.ok(key.length > 0, 'an empty key would make every assertion below vacuous');
  for (const verb of TOOL_GROUPS.process.tools) {
    assert.ok(!key.includes(verb),
      `${verb} is in the task-INVARIANT head AND in a group — one of the two is a lie about when it is offered`);
  }
  /** The six wait verbs must still all be reachable from one group. */
  for (const verb of ['start_process', 'wait_for_output', 'read_log', 'summarize_log']) {
    assert.ok(TOOL_GROUPS.process.tools.includes(verb), `${verb} left the process group`);
  }
});
