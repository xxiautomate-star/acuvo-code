/**
 * ── ⚠️⚠️ THERE WAS NO READ-ONLY-UNTIL-APPROVED GATE, AND TWO FLAGS LOOKED LIKE
 *        ONE ────────────────────────────────────────────────────────────────
 *
 * `--dry-run` prints what WOULD be written and `--no-run` withholds the process
 * spawners. Both are about the ACT; neither is about the INTENT. Measured on
 * the real help text before this landed: the word "plan" appears in `--help`
 * only inside `plan_start`'s ledger story, and `grep -c "arg === '--plan'"`
 * over `lib/cli-args.mjs` returned **0**. So the one thing a person actually
 * wants before letting an agent loose on their repository — *tell me what you
 * are going to do, and let me say no* — could not be asked for.
 *
 * ⭐ EVERY PART ALREADY EXISTED, which is why this is a wiring test and not a
 * feature test. `ORIENT_TOOLS` in plan-coherence.mjs is the read-only subset.
 * `createAsker` in prompt.mjs is the question. `toolNamesForRounds` already
 * varies the offer by round budget. Nothing joined them.
 *
 * ── ⚠️ AND THE SECOND HALF: THE VERDICTS WERE COMPUTED AND NEVER SHOWN ──────
 *
 * `detectDrift` and `reconcile` are wired into `lib/turn.mjs` — the drift nudge
 * reaches the MODEL and the reconciliation reaches the RESULT OBJECT. Measured
 * 2026-08-20: `formatReconciliation` is imported by turn.mjs on line 64 and
 * called NOWHERE, and `renderEvent` has no case for the `plan-drift` event
 * turn.mjs emits — so a human watching the terminal saw neither. The verdicts
 * bound the model and were invisible to the person paying for the run.
 *
 * These tests are pure: no network, no disk, no API key, no clock.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ORIENT_TOOLS,
  PLAN_MODE_MIN_ROUNDS,
  PLAN_MODE_EXCLUDED,
  planModeToolNames,
  planModeRounds,
  planPhaseTask,
  planApproval,
  approvedTask,
  formatPlanForApproval,
  runPlanGate,
  driftBannerLine,
  detectDrift,
} from '../lib/plan-coherence.mjs';

import { parseArgv, USAGE } from '../lib/cli-args.mjs';

/* ══════════════════════════════════════════════════════════════════════════
 * the flag
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐ --plan parses, and is OFF for everyone who did not type it', () => {
  const on = parseArgv(['--plan', 'port the auth module']);
  assert.equal(on.ok, true, on.ok === false ? on.error : '');
  assert.equal(on.options.plan, true);
  assert.equal(on.options.task, 'port the auth module');

  const off = parseArgv(['port the auth module']);
  assert.equal(off.options.plan, false, 'a run nobody flagged must behave exactly as it did yesterday');
});

test('⭐ --plan is in the help text — a gate nobody can find has not shipped', () => {
  assert.match(String(USAGE), /^ {2}--plan\b/m, '`--plan` has no line in USAGE');
});

/* ══════════════════════════════════════════════════════════════════════════
 * the read-only offer
 * ══════════════════════════════════════════════════════════════════════════ */

const MULTI_ROUND_OFFER = [
  'read_file', 'write_file', 'edit_file', 'delete_file', 'move_file', 'list_dir',
  'find_files', 'search_text', 'run_command', 'run_program', 'evaluate',
  'git_status', 'git_diff', 'git_log', 'git_commit', 'plan_start', 'plan_step',
  'plan_status', 'fetch_url', 'web_search', 'remember', 'forget',
];

test('⚠️⚠️ the plan phase offers NO verb that can write, run, deliver or remember', () => {
  const got = planModeToolNames(MULTI_ROUND_OFFER);
  assert.equal(got.ok, true, got.ok === false ? got.error : '');

  for (const banned of ['write_file', 'edit_file', 'delete_file', 'move_file',
    'run_command', 'run_program', 'evaluate', 'git_commit', 'plan_start', 'plan_step',
    'remember', 'forget']) {
    assert.equal(got.names.includes(banned), false, `${banned} was offered during the approval phase`);
  }
  assert.ok(got.names.includes('read_file'), 'reading is the whole point of the phase');
  assert.ok(got.names.includes('search_text'));
  assert.ok(got.names.includes('git_diff'));
});

test('⭐ it is an INTERSECTION with what this machine actually offers, never a fixed list', () => {
  /**
   * `read_skill` is in ORIENT_TOOLS and is gated on the workspace having skills.
   * A plan phase that offered it anyway would ship the dead button tools.mjs
   * spends 400 lines refusing.
   */
  assert.equal(ORIENT_TOOLS.has('read_skill'), true, 'the premise of this test moved');
  const got = planModeToolNames(MULTI_ROUND_OFFER);
  assert.equal(got.names.includes('read_skill'), false, 'a tool this machine never offered was offered anyway');
});

test('⚠️ plan_status is excluded even though it reads — it can only return ANOTHER task\'s plan', () => {
  assert.ok(PLAN_MODE_EXCLUDED.has('plan_status'));
  const got = planModeToolNames(MULTI_ROUND_OFFER);
  assert.equal(got.names.includes('plan_status'), false);
});

test('⚠️⚠️ a SINGLE-SHOT offer collapses to nothing, and that must be an error not an empty list', () => {
  /**
   * `toolNamesForRounds(1)` returns `['write_file','write_files']`. Intersected
   * with the read-only set that is EMPTY — a model handed zero tools, asked to
   * plan, in a phase whose whole value is that it can look first. The refusal
   * has to happen before the model call, not after it.
   */
  const got = planModeToolNames(['write_file', 'write_files']);
  assert.equal(got.ok, false);
  assert.deepEqual(got.names, []);
  assert.match(got.error, /read/i);
});

test('⭐ the plan phase is forced multi-round, because reads are dead buttons at one round', () => {
  assert.ok(PLAN_MODE_MIN_ROUNDS >= 2);
  assert.equal(planModeRounds(1), PLAN_MODE_MIN_ROUNDS);
  assert.equal(planModeRounds(0), PLAN_MODE_MIN_ROUNDS);
  assert.equal(planModeRounds(undefined), PLAN_MODE_MIN_ROUNDS);
  assert.ok(planModeRounds(40) < 40, 'the proposal must not be allowed to eat the whole budget');
});

test('⭐ the phase prompt NAMES the constraint and NAMES the approval — reachability part three', () => {
  const p = planPhaseTask('port the auth module');
  assert.match(p, /port the auth module/, 'the task itself must survive into the phase prompt');
  assert.match(p, /cannot write|may not write|no write/i, 'the model is not told it is read-only');
  assert.match(p, /approv/i, 'the model is not told a human decides next');
});

/* ══════════════════════════════════════════════════════════════════════════
 * the answer
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐ an explicit yes approves', () => {
  for (const yes of ['y', 'Y', 'yes', ' YES ', 'ok', 'go', 'approve']) {
    assert.equal(planApproval(yes).decision, 'approve', `${JSON.stringify(yes)} should approve`);
  }
});

test('⚠️⚠️ SILENCE IS NOT CONSENT — a bare Enter and a closed stream both REFUSE', () => {
  /**
   * `ask_user` treats a bare Enter as "you decide", and that is right for a
   * question about which of two designs to use. It is wrong here: this keystroke
   * is the only thing between a proposal and a file-writing agent. Approving
   * unintended writes costs the user work; refusing costs one retype.
   */
  assert.equal(planApproval('').decision, 'reject');
  assert.equal(planApproval(null).decision, 'reject');
  assert.equal(planApproval(undefined).decision, 'reject');
});

test('⭐ an explicit no refuses, INCLUDING when the user keeps talking', () => {
  for (const no of ['n', 'no', 'No', 'no way', 'no, do it differently', 'abort', 'cancel', 'q']) {
    assert.equal(planApproval(no).decision, 'reject', `${JSON.stringify(no)} should refuse`);
  }
});

test('⭐ anything else is an AMENDMENT, carried through verbatim', () => {
  const v = planApproval('yes but do not touch the tests');
  assert.equal(v.decision, 'amend');
  assert.equal(v.amendment, 'yes but do not touch the tests');
});

/* ══════════════════════════════════════════════════════════════════════════
 * what the approved run is actually asked to do
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ the approved task carries the plan AND tells the model to bind it to the ledger', () => {
  const t = approvedTask({ task: 'port the auth module', plan: '1. read auth.ts\n2. port it\n3. commit' });
  assert.match(t, /port the auth module/);
  assert.match(t, /port it/, 'the approved plan text is missing from the task the model receives');
  assert.match(t, /plan_start/, 'nothing tells the model to record the approved plan, so nothing can bind it');
  assert.match(t, /plan_step/, 'nothing tells the model to mark the steps, which is the measured failure');
});

test('⭐ an amendment is carried, and said to OUTRANK the plan', () => {
  const t = approvedTask({ task: 'x', plan: '1. do a\n2. do b', amendment: 'skip b' });
  assert.match(t, /skip b/);
  assert.match(t, /overrid|outrank|instead of/i, 'an amendment that does not say it wins is just more prose');
});

test('⚠️ a runaway plan is clamped, and the clamp SAYS SO rather than truncating silently', () => {
  const huge = 'x'.repeat(50_000);
  const t = approvedTask({ task: 'x', plan: huge });
  assert.ok(t.length < 20_000, `the approved task was ${t.length} characters — a plan can void a whole context`);
  assert.match(t, /truncat|omitted|cut/i, 'the truncation is invisible, so the model reads a half plan as whole');
});

/* ══════════════════════════════════════════════════════════════════════════
 * the gate itself
 * ══════════════════════════════════════════════════════════════════════════ */

const PLAN_TEXT = '1. read lib/auth.ts\n2. port it to lib/auth.mjs\n3. run the tests';

function stubs({ answer = 'y', note = PLAN_TEXT, ok = true } = {}) {
  const printed = [];
  const asked = [];
  let proposed = 0;
  return {
    printed,
    asked,
    proposals: () => proposed,
    propose: async () => { proposed += 1; return { ok, note }; },
    ask: async (q) => { asked.push(q); return answer; },
    print: (t) => printed.push(t),
  };
}

test('⭐⭐ approve → the run proceeds, with the plan folded into the task', async () => {
  const s = stubs({ answer: 'y' });
  const gate = await runPlanGate({ task: 'port auth', propose: s.propose, ask: s.ask, print: s.print });

  assert.equal(gate.proceed, true, gate.reason);
  assert.equal(gate.decision, 'approve');
  assert.match(gate.task, /port it to lib\/auth\.mjs/, 'the approved plan did not reach the executing run');
  assert.equal(s.proposals(), 1, 'the proposal must be made exactly once');
  assert.equal(s.asked.length, 1, 'exactly one question — this is a gate, not an interview');
  assert.ok(s.printed.join('\n').includes('port it to lib/auth.mjs'), 'the user was asked to approve a plan they were never shown');
});

test('⚠️⚠️ decline → the run does NOT proceed, and the task is left untouched', async () => {
  const s = stubs({ answer: 'n' });
  const gate = await runPlanGate({ task: 'port auth', propose: s.propose, ask: s.ask, print: s.print });
  assert.equal(gate.proceed, false);
  assert.equal(gate.decision, 'reject');
  assert.equal(gate.task, 'port auth', 'a refused plan must not have edited the task');
});

test('⭐ amend → proceeds, carrying both the plan and the correction', async () => {
  const s = stubs({ answer: 'do not touch the tests' });
  const gate = await runPlanGate({ task: 'port auth', propose: s.propose, ask: s.ask, print: s.print });
  assert.equal(gate.proceed, true);
  assert.equal(gate.decision, 'amend');
  assert.match(gate.task, /do not touch the tests/);
  assert.match(gate.task, /port it to lib\/auth\.mjs/);
});

test('⚠️⚠️ NO TERMINAL → refuses BEFORE the model call, so nothing is spent on a plan nobody can approve', async () => {
  const s = stubs();
  const gate = await runPlanGate({ task: 'port auth', propose: s.propose, ask: null, print: s.print });
  assert.equal(gate.proceed, false);
  assert.equal(gate.reason, 'no-terminal');
  assert.equal(s.proposals(), 0, 'a model call was made for a plan that could never have been approved');
});

test('⚠️ a proposal phase that failed or said nothing refuses rather than approving an empty plan', async () => {
  const failed = stubs({ ok: false, note: null });
  const a = await runPlanGate({ task: 'x', propose: failed.propose, ask: failed.ask, print: failed.print });
  assert.equal(a.proceed, false);
  assert.equal(a.reason, 'no-plan');
  assert.equal(failed.asked.length, 0, 'the user was asked to approve nothing at all');

  const empty = stubs({ ok: true, note: '   ' });
  const b = await runPlanGate({ task: 'x', propose: empty.propose, ask: empty.ask, print: empty.print });
  assert.equal(b.proceed, false);
  assert.equal(b.reason, 'no-plan');
});

test('⭐ the plan is shown with a heading that says it is a PROPOSAL, not work already done', () => {
  const lines = formatPlanForApproval(PLAN_TEXT);
  assert.ok(Array.isArray(lines));
  const text = lines.join('\n');
  assert.match(text, /PLAN|PROPOS/i);
  assert.ok(text.includes('read lib/auth.ts'));
  assert.match(text, /nothing has been written|no file|not run/i,
    'the heading must say the workspace is still untouched, or the block reads as a report');
});

/* ══════════════════════════════════════════════════════════════════════════
 * making the verdict visible
 * ══════════════════════════════════════════════════════════════════════════ */

const DRIFTED = {
  plan: {
    task: 'port the auth module',
    steps: [
      { id: 's1', text: 'port lib/auth.ts to lib/auth.mjs', state: 'todo' },
      { id: 's2', text: 'commit the port', state: 'todo' },
    ],
  },
  rounds: [1, 2, 3, 4].map((n) => ({
    round: n,
    executed: [{
      name: 'write_file',
      args: { path: `notes/scratch${n}.md` },
      result: { ok: true, path: `notes/scratch${n}.md` },
      mutated: true,
    }],
  })),
};

test('⭐⭐ a drifting verdict produces ONE user-facing line naming the files and what is outstanding', () => {
  const verdict = detectDrift(DRIFTED);
  assert.equal(verdict.drifting, true, 'the fixture stopped drifting — fix the fixture, not the assertion');

  const line = driftBannerLine(verdict);
  assert.equal(typeof line, 'string');
  assert.equal(line.includes('\n'), false, 'the round banner is one line; a paragraph per round is noise');
  assert.match(line, /notes\/scratch/, 'the line does not name a single file that caused the verdict');
  assert.match(line, /plan/i);
});

/**
 * ⚠️⚠️ THE FIXTURE THIS TEST WAS MISSING, FOUND BY MUTATION TESTING.
 *
 * My first version of the clean-verdict test used only `no-plan`, `exploring`
 * and `insufficient-history`, and every one of those has an EMPTY (or absent)
 * `unattributed` list. So deleting the `drifting !== true` guard from
 * `driftBannerLine` left all 23 tests green — the second guard caught every
 * fixture, and the check that was supposed to be load-bearing could not fail.
 *
 * ⭐ THE DANGEROUS SHAPE IS `on-plan` WITH UNATTRIBUTED FILES, and it is the
 * COMMON one, not an edge case: a run that marks a step and writes a lockfile
 * beside the file it promised produces `verdict: 'on-plan'`, `drifting: false`,
 * and a populated `unattributed` array. `detectDrift` returns that evidence on
 * purpose — a caller is entitled to the list — and a banner that reads the list
 * without reading the verdict would accuse the best-behaved run in the suite.
 */
const ON_PLAN_WITH_STRAYS = {
  plan: DRIFTED.plan,
  rounds: [1, 2, 3, 4].map((n) => ({
    round: n,
    executed: [
      { name: 'write_file', args: { path: `vendor/stray${n}.lock` }, result: { ok: true, path: `vendor/stray${n}.lock` }, mutated: true },
      ...(n === 4 ? [{ name: 'plan_step', args: { id: 's1', state: 'done' }, result: { ok: true }, mutated: false }] : []),
    ],
  })),
};

test('⚠️⚠️ every CLEAN verdict prints NOTHING — a banner that fires on healthy runs trains people to skim', () => {
  const onPlan = detectDrift(ON_PLAN_WITH_STRAYS);
  assert.equal(onPlan.verdict, 'on-plan', 'the fixture stopped being the well-behaved case');
  assert.ok(onPlan.evidence.unattributed.length >= 3,
    'this fixture is only interesting because the CLEAN verdict carries unattributed files');

  for (const verdict of [
    onPlan,
    detectDrift({}),
    detectDrift({ plan: DRIFTED.plan, rounds: [] }),
    detectDrift({ plan: DRIFTED.plan, rounds: DRIFTED.rounds.slice(0, 2) }),
    detectDrift({
      plan: DRIFTED.plan,
      rounds: DRIFTED.rounds.map((r) => ({ ...r, executed: [{ name: 'read_file', args: {}, result: { ok: true }, mutated: false }] })),
    }),
  ]) {
    assert.equal(verdict.drifting, false, `fixture ${verdict.verdict} should be clean`);
    assert.equal(driftBannerLine(verdict), null, `${verdict.verdict} printed a drift line`);
  }
  assert.equal(driftBannerLine(null), null);
  assert.equal(driftBannerLine({ drifting: true }), null, 'a verdict with no evidence must not print half a sentence');
});
