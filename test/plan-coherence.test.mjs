/**
 * ── ⚠️⚠️ THE FALSE POSITIVE IS THE EXPENSIVE DIRECTION, AGAIN ───────────────
 *
 * `stuck.test.mjs` is lopsided on purpose and this file is lopsided the same
 * way, because the failure modes are the same shape:
 *
 *   · MISSING drift costs a few rounds of a budget the user set anyway.
 *   · TELLING A WORKING RUN IT HAS DRIFTED costs the work. The model believes
 *     the runner — `plan-ledger.mjs` recorded a real session where it argued
 *     with a banner — so a false verdict makes it abandon correct work and
 *     re-plan around a lie.
 *
 * The same asymmetry governs completion evidence: a refusal that fires on a
 * genuinely-finished step is a guard failing correct work, which this package
 * has shipped four times in one day and written a memory about. So the
 * NEGATIVES below (exploration, tests written beside a named source file, a
 * ledger being maintained, an unobservable research step) are the tests that
 * matter, and a threshold change will be caught by them rather than by the
 * positives.
 *
 * ⚠️ EVERY TEST RUNS WITH NO NETWORK, NO DISK AND NO API KEY. `plan-coherence`
 * is pure by construction; the round records below are copied from the shape
 * `turn.mjs` pushes, not invented, because getting that shape wrong is how a
 * detector passes its unit tests and sees nothing in production.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectDrift, driftNudge, staleSteps, attributePath, stepTargets, classifyStep,
  acceptCompletion, reanchorDecision, anchorText, wasAppendOnly,
  reconcile, formatReconciliation, flattenRounds,
  DRIFT_MIN_UNATTRIBUTED, REANCHOR_MAX_PER_RUN, REANCHOR_MIN_GAP, REANCHOR_FIRST_ROUND,
  REANCHOR_PLACEMENT, ATTRIBUTION_STRENGTHS, STEP_KINDS, DRIFT_VERDICTS,
} from '../lib/plan-coherence.mjs';

/* ── builders in the exact shape lib/turn.mjs pushes onto `rounds` ───────────
 * `{ round, note, executed: [record], usage, finishReason, model }` where a
 * record is `{ id, name, args, result, mutated }` from tools.mjs's dispatcher. */

let seq = 0;
const round = (n, executed) => ({
  round: n, note: '', executed, usage: null, finishReason: 'tool_calls', model: 'test',
});

const write = (path, content = 'x') => ({
  id: `c${seq++}`, name: 'write_file', args: { path, content },
  result: { ok: true, path, bytes: content.length, created: true }, mutated: true,
});

const edit = (path) => ({
  id: `c${seq++}`, name: 'edit_file', args: { path, old_string: 'a', new_string: 'b' },
  result: { ok: true, path, bytes: 42 }, mutated: true,
});

const read = (path) => ({
  id: `c${seq++}`, name: 'read_file', args: { path },
  result: { ok: true, path, content: `contents of ${path}`, bytes: 12 }, mutated: false,
});

const search = (pattern) => ({
  id: `c${seq++}`, name: 'search_text', args: { pattern },
  result: { ok: true, matches: [] }, mutated: false,
});

const cmd = (command, exitCode = 0, stderr = '') => ({
  id: `c${seq++}`, name: 'run_command', args: { command },
  result: {
    ok: true, command, exitCode, passed: exitCode === 0,
    stdout: '', stderr, timedOut: false, argv: [], durationMs: 5,
  },
  mutated: false,
});

const gitCommit = (ok = true) => ({
  id: `c${seq++}`, name: 'git_commit', args: { message: 'wip' },
  result: ok ? { ok: true, sha: 'abc1234' } : { ok: false, error: 'nothing to commit' },
  mutated: false,
});

const planStepCall = (id, state = 'done') => ({
  id: `c${seq++}`, name: 'plan_step', args: { id, state },
  result: { ok: true, id, from: 'todo', state }, mutated: false,
});

/** A plan in the shape `loadPlan` returns. */
const plan = (steps, task = 'port the store module, add tests, then git_commit') => ({
  version: 1,
  task,
  createdAt: '2026-08-15T00:00:00.000Z',
  updatedAt: '2026-08-15T00:00:00.000Z',
  steps: steps.map((s, i) => (typeof s === 'string'
    ? { id: `s${i + 1}`, text: s, state: 'todo' }
    : { id: `s${i + 1}`, ...s })),
});

const THREE_STEPS = () => plan([
  'write lib/store.mjs with the load and save functions',
  'add tests for the store',
  'git_commit the result',
]);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. DRIFT — the positives
 * ══════════════════════════════════════════════════════════════════════════ */

test('sustained writes to files no step names, with the ledger untouched, is drift', () => {
  const r = detectDrift({
    plan: THREE_STEPS(),
    rounds: [
      round(1, [read('README.md')]),
      round(2, [write('marketing/landing.html')]),
      round(3, [write('marketing/styles.css')]),
      round(4, [write('marketing/app.js')]),
      round(5, [edit('marketing/landing.html')]),
    ],
  });

  assert.equal(r.verdict, 'drifting');
  assert.equal(r.drifting, true);
  assert.deepEqual(
    r.evidence.unattributed.map((u) => u.path).sort(),
    ['marketing/app.js', 'marketing/landing.html', 'marketing/styles.css'],
  );
  assert.deepEqual(r.evidence.attributed, []);
  // The evidence must name which steps have had no activity — that is the
  // "which steps have had no activity" half of the brief, and it is what a
  // human reads to decide whether the plan or the run is wrong.
  assert.deepEqual(r.evidence.staleSteps.map((s) => s.id), ['s1', 's2', 's3']);
  assert.match(r.suggestion, /marketing\/landing\.html/);
  // ⭐ BOTH EXITS, ALWAYS. A nudge offering only "get back on plan" is wrong
  // half the time — the commonest cause of drift is a plan that stopped
  // describing the work.
  assert.match(r.suggestion, /plan_start/);
});

test('the nudge announces itself as machinery, and is null when there is no drift', () => {
  const drifting = detectDrift({
    plan: THREE_STEPS(),
    rounds: [
      round(1, [write('a/one.txt')]),
      round(2, [write('a/two.txt')]),
      round(3, [write('a/three.txt')]),
      round(4, [write('a/four.txt')]),
    ],
  });
  const text = driftNudge(drifting);
  assert.match(text, /^\[plan coherence — automatic, not from the user\]/);
  assert.equal(driftNudge({ drifting: false, suggestion: 'stale' }), null);
  assert.equal(driftNudge(null), null);
});

test('the evidence key is stable for one drift and differs between two', () => {
  const rounds = (dir) => [
    round(1, [write(`${dir}/one.txt`)]),
    round(2, [write(`${dir}/two.txt`)]),
    round(3, [write(`${dir}/three.txt`)]),
    round(4, [read('x.md')]),
  ];
  const a = detectDrift({ plan: THREE_STEPS(), rounds: rounds('alpha') });
  const b = detectDrift({ plan: THREE_STEPS(), rounds: rounds('alpha') });
  const c = detectDrift({ plan: THREE_STEPS(), rounds: rounds('beta') });
  assert.equal(a.evidence.key, b.evidence.key);
  assert.notEqual(a.evidence.key, c.evidence.key);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. DRIFT — THE NEGATIVES. These are the tests that matter.
 * ══════════════════════════════════════════════════════════════════════════ */

test('READING IS NEVER DRIFT — a long research phase over unrelated files is `exploring`', () => {
  /**
   * The line the brief asks about, pinned. Eight rounds, forty files read, not
   * one of them named by any step, nothing written. A good agent cannot know
   * which files matter until it has looked, and the files it looks at are
   * chosen by the CODE's structure rather than by the plan's wording — so this
   * is not weak evidence of drift, it is none.
   */
  const rounds = [];
  for (let i = 1; i <= 8; i += 1) {
    rounds.push(round(i, [
      read(`vendor/unrelated-${i}.js`),
      search(`symbol-${i}`),
      read(`docs/notes-${i}.md`),
    ]));
  }
  const r = detectDrift({ plan: THREE_STEPS(), rounds });
  assert.equal(r.verdict, 'exploring');
  assert.equal(r.drifting, false);
  assert.equal(r.suggestion, null);
});

test('a run that is marking its ledger is on plan whatever it is writing', () => {
  /**
   * ⭐ THE CONDITION THAT MAKES THIS SAFE TO SHIP. A model calling `plan_step`
   * is tracking its plan by definition. The well-behaved run — the one this
   * package spent four probes failing to produce — can never trip the drift
   * check, however unusual its file layout is.
   */
  const r = detectDrift({
    plan: THREE_STEPS(),
    rounds: [
      round(1, [write('weird/one.txt')]),
      round(2, [write('weird/two.txt')]),
      round(3, [write('weird/three.txt')]),
      round(4, [write('weird/four.txt'), planStepCall('s1', 'done')]),
    ],
  });
  assert.equal(r.verdict, 'on-plan');
  assert.deepEqual(r.evidence.markedInWindow, [4]);
});

test('one or two unplanned files is a helper, not a different piece of work', () => {
  const r = detectDrift({
    plan: THREE_STEPS(),
    rounds: [
      round(1, [read('x.md')]),
      round(2, [write('package.json')]),
      round(3, [write('.gitignore')]),
      round(4, [read('y.md')]),
    ],
  });
  assert.equal(r.verdict, 'on-plan');
  assert.equal(r.evidence.unattributed.length, 2);
  assert.ok(r.evidence.unattributed.length < DRIFT_MIN_UNATTRIBUTED);
});

test('a test file written beside the source file a step names is attributed, not drift', () => {
  /**
   * ⚠️ THE REGRESSION THIS PINS IS A REAL ONE FROM THIS FILE'S OWN FIRST DRAFT.
   * Stemming on the LAST dot made `store.test.mjs` stem to `store.test`, which
   * matched nothing — so writing tests beside the file you promised looked like
   * drift. Three such pairs would have flagged a model doing exactly what it
   * said plus tests.
   */
  const r = detectDrift({
    plan: THREE_STEPS(),
    rounds: [
      round(1, [read('README.md')]),
      round(2, [write('lib/store.mjs')]),
      round(3, [write('test/store.test.mjs')]),
      round(4, [write('test/store.integration.test.mjs')]),
    ],
  });
  assert.equal(r.verdict, 'on-plan');
  assert.deepEqual(r.evidence.unattributed, []);
  assert.equal(r.evidence.attributed.length, 3);
});

test('planned work plus incidental files is not drift, however many the incidentals', () => {
  /**
   * ⚠️ THIS TEST EXISTS BECAUSE MUTATION TESTING FOUND IT MISSING. Disabling
   * the `attributed.length > 0` branch entirely left all 38 other tests GREEN:
   * every case that reached it was also caught one line later by the
   * three-unattributed-paths threshold, so a whole condition was uncovered and
   * looked covered. The shape it guards is the ordinary one — do the promised
   * work, and touch a lockfile, a config and a vendor shim on the way — and
   * without it a productive run would be told it had drifted.
   */
  const r = detectDrift({
    plan: THREE_STEPS(),
    rounds: [
      round(1, [write('lib/store.mjs')]),
      round(2, [write('package.json'), write('.eslintrc.json')]),
      round(3, [write('vendor/shim.js')]),
      round(4, [read('x.md')]),
    ],
  });
  assert.equal(r.verdict, 'on-plan');
  assert.equal(r.evidence.attributed.length, 1);
  assert.ok(r.evidence.unattributed.length >= DRIFT_MIN_UNATTRIBUTED,
    'the incidental files must be over the threshold, or this test proves nothing');
});

test('a short run is `insufficient-history`, never a verdict', () => {
  const r = detectDrift({
    plan: THREE_STEPS(),
    rounds: [round(1, [write('a.txt')]), round(2, [write('b.txt')]), round(3, [write('c.txt')])],
  });
  assert.equal(r.verdict, 'insufficient-history');
  assert.equal(r.drifting, false);
});

test('no plan means no verdict, and a fully-null result', () => {
  const r = detectDrift({ plan: null, rounds: [round(1, [write('a.txt')])] });
  assert.equal(r.verdict, 'no-plan');
  assert.equal(r.drifting, false);
  assert.equal(r.evidence, null);
  assert.equal(r.suggestion, null);
  assert.ok(DRIFT_VERDICTS.includes(r.verdict));
});

test('a finished plan is `plan-complete`, not drift, however far the run wanders', () => {
  const done = plan([
    { text: 'write lib/store.mjs', state: 'done' },
    { text: 'git_commit', state: 'done' },
  ]);
  const r = detectDrift({
    plan: done,
    rounds: [
      round(1, [write('x/one.txt')]), round(2, [write('x/two.txt')]),
      round(3, [write('x/three.txt')]), round(4, [write('x/four.txt')]),
    ],
  });
  assert.equal(r.verdict, 'plan-complete');
  assert.equal(r.drifting, false);
});

test('stale steps are reported even when the verdict is on-plan', () => {
  const r = detectDrift({
    plan: THREE_STEPS(),
    rounds: [
      round(1, [read('a')]), round(2, [write('lib/store.mjs')]),
      round(3, [read('b')]), round(4, [read('c')]),
    ],
  });
  assert.equal(r.drifting, false);
  // s1 was touched; s2 and s3 have had no observable activity at all.
  assert.deepEqual(r.evidence.staleSteps.map((s) => s.id), ['s2', 's3']);
});

test('staleSteps says "no activity observed", not "not done" — done steps are excluded', () => {
  const p = plan([
    { text: 'write lib/store.mjs', state: 'done' },
    { text: 'update README.md', state: 'todo' },
  ]);
  const stale = staleSteps(p, [round(1, [read('anything.md')])]);
  assert.deepEqual(stale.map((s) => s.id), ['s2']);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. ATTRIBUTION
 * ══════════════════════════════════════════════════════════════════════════ */

test('attribution is strength-ordered, not plan-ordered', () => {
  const steps = [
    { id: 's1', text: 'add store tests', state: 'todo' },
    { id: 's2', text: 'write lib/store.mjs', state: 'todo' },
  ];
  // s1 comes first and matches by stem; s2 matches exactly and must win.
  assert.deepEqual(attributePath('lib/store.mjs', steps), { id: 's2', strength: 'exact' });
  assert.equal(ATTRIBUTION_STRENGTHS[0], 'exact');
});

test('a generic directory segment never attributes on its own', () => {
  const steps = [{ id: 's1', text: 'clean up the lib directory', state: 'todo' }];
  // "lib" is in the step text, but attributing every file under lib/ to it
  // would be a check that can never report anything.
  assert.equal(attributePath('lib/totally-unrelated.mjs', steps), null);
  // A non-generic segment does attribute.
  const auth = [{ id: 's1', text: 'port the auth module', state: 'todo' }];
  assert.deepEqual(attributePath('src/auth/session.mjs', auth), { id: 's1', strength: 'segment' });
});

test('stepTargets reads paths, basenames and stems out of prose', () => {
  const t = stepTargets('write lib/store.mjs and update README.md');
  assert.deepEqual(t.paths, ['lib/store.mjs', 'README.md']);
  assert.deepEqual(t.basenames, ['store.mjs', 'README.md']);
  assert.ok(t.stems.has('store'));
  assert.ok(t.stems.has('readme'));
});

test('flattenRounds survives malformed history rather than throwing inside the loop', () => {
  const events = flattenRounds([
    null,
    { round: 1 },
    { round: 2, executed: 'not an array' },
    { round: 3, executed: [null, { name: '' }, { name: 'read_file' }] },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'read_file');
  assert.deepEqual(events[0].args, {});
  assert.deepEqual(flattenRounds(undefined), []);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. COMPLETION EVIDENCE
 * ══════════════════════════════════════════════════════════════════════════ */

test('classifyStep puts deliver above write, because the commit is what dies', () => {
  const c = classifyStep('port every file and then git_commit');
  assert.equal(c.kind, 'deliver');
  assert.deepEqual(c.kinds.slice(0, 2), ['deliver', 'write']);
  // ⚠️ `git_commit` has no word boundary before "commit" — the underscore is a
  // word character. Classifying it `unknown` would wave through the exact step
  // this module exists to catch.
  assert.equal(classifyStep('git_commit').kind, 'deliver');
  for (const k of [classifyStep('write lib/x.mjs').kind, classifyStep('run npm test').kind]) {
    assert.ok(STEP_KINDS.includes(k));
  }
});

test('a write step whose file was written is accepted, with the path as evidence', () => {
  const p = THREE_STEPS();
  const v = acceptCompletion({
    step: p.steps[0], plan: p,
    rounds: [round(1, [write('lib/store.mjs', 'export const load = 1;')])],
  });
  assert.equal(v.accepted, true);
  assert.equal(v.evidence, 'file-written');
  assert.deepEqual(v.paths, ['lib/store.mjs']);
  assert.deepEqual(v.rounds, [1]);
});

test('a write step whose named file was never written is REFUSED, and the refusal names the way out', () => {
  const p = THREE_STEPS();
  const v = acceptCompletion({
    step: p.steps[0], plan: p,
    rounds: [round(1, [read('lib/store.mjs')]), round(2, [write('notes.md')])],
  });
  assert.equal(v.accepted, false);
  assert.equal(v.evidence, 'none');
  assert.match(v.why, /lib\/store\.mjs/);
  // Every refusal names the way out — including the honest one, `blocked`.
  assert.match(v.remedy, /blocked/);
});

test('a write step naming no file still fails a run that wrote nothing at all', () => {
  /**
   * Probe 3, tasks D and G: six rounds researching, the answer found, the file
   * never written. The step named no path, so nothing could be attributed —
   * but "a write step in a run that mutated nothing" is still provably
   * unfinished, and it is the weakest TRUE statement available.
   */
  const p = plan(['implement the retry logic']);
  const none = acceptCompletion({ step: p.steps[0], plan: p, rounds: [round(1, [read('a')]), round(2, [search('b')])] });
  assert.equal(none.accepted, false);
  assert.match(none.why, /no file was written or edited in this session at all/);

  // …and any mutation anywhere satisfies it, so it costs no false refusals.
  const some = acceptCompletion({ step: p.steps[0], plan: p, rounds: [round(1, [write('src/anything.mjs')])] });
  assert.equal(some.accepted, true);
  assert.equal(some.evidence, 'run-wide-mutation');
});

test('a deliver step is refused without a commit and accepted with one — tool or shell', () => {
  const p = THREE_STEPS();
  const step = p.steps[2];

  const nothing = acceptCompletion({ step, plan: p, rounds: [round(1, [write('lib/store.mjs')])] });
  assert.equal(nothing.accepted, false);
  assert.match(nothing.remedy, /before anything more interesting/);

  const viaTool = acceptCompletion({ step, plan: p, rounds: [round(1, [gitCommit()])] });
  assert.equal(viaTool.accepted, true);
  assert.equal(viaTool.evidence, 'delivered');

  // ⚠️ A run that shells out instead must count. Keying on the famous tool name
  // alone is how `stuck.mjs` got bitten three times.
  const viaShell = acceptCompletion({ step, plan: p, rounds: [round(1, [cmd('git commit -m "wip"', 0)])] });
  assert.equal(viaShell.accepted, true);
});

test('a command step over a RED command is refused as contradicted, not merely unevidenced', () => {
  const p = plan(['run npm test and make the suite pass']);
  const red = acceptCompletion({
    step: p.steps[0], plan: p,
    rounds: [round(1, [cmd('npm test', 1, 'AssertionError')])],
  });
  assert.equal(red.accepted, false);
  assert.equal(red.evidence, 'contradicted');
  assert.equal(red.contradicted, true);
  assert.match(red.remedy, /blocked/);

  const green = acceptCompletion({ step: p.steps[0], plan: p, rounds: [round(1, [cmd('npm test', 0)])] });
  assert.equal(green.accepted, true);
  assert.equal(green.evidence, 'command-ran');
  assert.equal(green.contradicted, false);
});

test('a command step in a session that ran nothing is refused', () => {
  const p = plan(['run the acceptance suite']);
  const v = acceptCompletion({ step: p.steps[0], plan: p, rounds: [round(1, [write('x.mjs')])] });
  assert.equal(v.accepted, false);
  assert.match(v.why, /no command, program or evaluation ran/);
});

test('⭐ AN UNOBSERVABLE STEP IS ACCEPTED, AND SAYS SO — a guard that fails correct work is worse than none', () => {
  /**
   * "Decide which library to use" has a deliverable made of knowledge, and it
   * lives in the model's reply where this module cannot see it. Refusing it
   * would be the fifth guard in this package to fail correct work. It is
   * accepted, and the result labels itself `assertion` so the boundary is
   * documented rather than hidden.
   */
  const p = plan(['decide which JSON parser to use and why']);
  const v = acceptCompletion({ step: p.steps[0], plan: p, rounds: [] });
  assert.equal(v.accepted, true);
  assert.equal(v.evidence, 'assertion');
  assert.equal(v.kind, 'research');
  assert.match(v.why, /not observable/);
  assert.equal(v.remedy, null);
});

test('a verify step needs a run or a read-back, and a read-back counts', () => {
  const p = plan(['confirm lib/store.mjs exports load and save']);
  const nothing = acceptCompletion({ step: p.steps[0], plan: p, rounds: [round(1, [write('other.mjs')])] });
  assert.equal(nothing.accepted, false);
  assert.match(nothing.why, /nothing it names was read back/);

  const looked = acceptCompletion({ step: p.steps[0], plan: p, rounds: [round(1, [read('lib/store.mjs')])] });
  assert.equal(looked.accepted, true);
  assert.equal(looked.evidence, 'read-back');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. RE-ANCHORING — and the cache constraint that shapes it
 * ══════════════════════════════════════════════════════════════════════════ */

test('no anchor in the opening rounds — the task is still in immediate context', () => {
  for (const r of [1, 2, 3, 4, 5]) {
    const d = reanchorDecision({ plan: THREE_STEPS(), roundIndex: r, maxRounds: 40 });
    assert.equal(d.reanchor, false, `round ${r} should not anchor`);
    assert.match(d.why, /first \d+/);
  }
  assert.ok(REANCHOR_FIRST_ROUND >= 3);
});

test('an interval anchor fires once the goal has gone stale, and only at the end of the prompt', () => {
  const d = reanchorDecision({ plan: THREE_STEPS(), roundIndex: 8, maxRounds: 40 });
  assert.equal(d.reanchor, true);
  assert.equal(d.reason, 'interval');
  assert.equal(d.placement, REANCHOR_PLACEMENT);
  assert.equal(REANCHOR_PLACEMENT, 'append-end');
  assert.equal(d.state.count, 1);
  assert.equal(d.state.lastAnchorRound, 8);
  assert.ok(d.approxTokens > 0);
});

test('the minimum gap and the per-run cap both hold — every anchor is re-sent every later round', () => {
  const p = THREE_STEPS();
  const soon = reanchorDecision({ plan: p, roundIndex: 10, maxRounds: 40, state: { lastAnchorRound: 8, count: 1 } });
  assert.equal(soon.reanchor, false);
  assert.match(soon.why, new RegExp(`${REANCHOR_MIN_GAP}-round minimum gap`));
  // ⚠️ the refused decision must hand back the state UNCHANGED, or a caller
  // that always assigns `d.state` would silently reset the budget.
  assert.deepEqual(soon.state, { lastAnchorRound: 8, count: 1, finalDone: false });

  const capped = reanchorDecision({
    plan: p, roundIndex: 30, maxRounds: 100, state: { lastAnchorRound: 20, count: REANCHOR_MAX_PER_RUN },
  });
  assert.equal(capped.reanchor, false);
  assert.match(capped.why, /cap/);
});

test('compaction overrides both the gap and the cap — it is the only event that removes the goal', () => {
  const d = reanchorDecision({
    plan: THREE_STEPS(), roundIndex: 9, maxRounds: 40,
    state: { lastAnchorRound: 8, count: REANCHOR_MAX_PER_RUN },
    compactedSinceAnchor: true,
  });
  assert.equal(d.reanchor, true);
  assert.equal(d.reason, 'compaction');
  assert.match(d.text, /compacted/);
});

test('drift earns an anchor, but only once the interval rules allow one', () => {
  const drift = { drifting: true };
  const early = reanchorDecision({ plan: THREE_STEPS(), roundIndex: 3, maxRounds: 40, drift });
  assert.equal(early.reanchor, false);

  const later = reanchorDecision({ plan: THREE_STEPS(), roundIndex: 9, maxRounds: 40, drift });
  assert.equal(later.reanchor, true);
  assert.equal(later.reason, 'drift');
});

test('⭐ the final anchor fires at the wall, ignores the cap, and fires only once', () => {
  /**
   * Probe 4: 4 of 4 runs consumed the whole budget, none finished early, and
   * the LAST-listed deliverable died every time. If there is one place worth
   * spending tokens on a reminder, it is the round before the wall.
   */
  const p = THREE_STEPS();
  const state = { lastAnchorRound: 38, count: REANCHOR_MAX_PER_RUN };
  const d = reanchorDecision({ plan: p, roundIndex: 39, maxRounds: 40, state });
  assert.equal(d.reanchor, true);
  assert.equal(d.reason, 'final');
  assert.equal(d.state.finalDone, true);
  assert.match(d.text, /blocked/);

  const again = reanchorDecision({ plan: p, roundIndex: 40, maxRounds: 40, state: d.state });
  assert.notEqual(again.reason, 'final');
});

test('anchorText restates the TASK and the outstanding steps, deterministically', () => {
  const p = plan([
    { text: 'write lib/store.mjs', state: 'done' },
    { text: 'add tests for the store', state: 'todo' },
    { text: 'git_commit the result', state: 'blocked' },
  ], 'port the store module and commit');

  const a = anchorText(p, { reason: 'interval', roundIndex: 12, maxRounds: 40 });
  const b = anchorText(p, { reason: 'interval', roundIndex: 12, maxRounds: 40 });
  // ⚠️ Byte-identical on repeat: no clock, no randomness. A prompt injection
  // that varied between two identical calls could not be reasoned about at all.
  assert.equal(a, b);
  assert.match(a, /TASK: port the store module and commit/);
  assert.match(a, /STILL OUTSTANDING \(2 of 3\)/);
  assert.match(a, /s3 \[blocked\] git_commit the result/);
  // The done step is not restated — the anchor is a reminder, not a transcript.
  assert.ok(!a.includes('s1 '));
  assert.match(a, /^\[plan anchor — automatic, not from the user\]/);

  assert.equal(anchorText(plan([{ text: 'x', state: 'done' }])), null);
  assert.equal(anchorText(null), null);
});

test('wasAppendOnly proves the claim the whole design rests on', () => {
  const before = [
    { role: 'system', content: 'you are acuvo' },
    { role: 'user', content: 'do the thing' },
  ];
  const appended = [...before, { role: 'user', content: 'anchor' }];
  assert.equal(wasAppendOnly(before, appended), true);
  assert.equal(wasAppendOnly(before, before), true);

  // ⚠️⚠️ THE 2.4x MISTAKE, CAUGHT: editing the system message to "keep the goal
  // fresh" changes byte 0 of the cached prefix, so every round pays full price
  // for the whole conversation. Nothing else in this package would go red.
  const edited = [{ role: 'system', content: 'you are acuvo. GOAL: do the thing' }, before[1]];
  assert.equal(wasAppendOnly(before, edited), false);

  const spliced = [before[0], { role: 'user', content: 'reminder' }, before[1]];
  assert.equal(wasAppendOnly(before, spliced), false);

  const truncated = [before[0]];
  assert.equal(wasAppendOnly(before, truncated), false);

  // Rebuilt-but-equal objects are NOT a cache break, and identity comparison
  // would have reported that the wrong way round.
  assert.equal(wasAppendOnly(before, before.map((m) => ({ ...m }))), true);
});

test('⭐ a simulated 40-round run stays append-only and spends a bounded anchor budget', () => {
  const p = THREE_STEPS();
  let messages = [{ role: 'system', content: 'preamble' }, { role: 'user', content: p.task }];
  let state = {};
  const anchors = [];

  for (let r = 1; r <= 40; r += 1) {
    const before = messages;
    const d = reanchorDecision({ plan: p, roundIndex: r, maxRounds: 40, state });
    if (d.reanchor) {
      anchors.push({ round: r, reason: d.reason, tokens: d.approxTokens });
      messages = [...messages, { role: 'user', content: d.text }];
      state = d.state;
    }
    // Every round, without exception. This is the property that costs 2.4x.
    assert.equal(wasAppendOnly(before, messages), true, `round ${r} was not append-only`);
  }

  // 3 budgeted + 1 exempt final. Not "roughly a few" — an exact bound, so a
  // threshold change is visible here rather than on a bill.
  assert.equal(anchors.length, REANCHOR_MAX_PER_RUN + 1);
  assert.deepEqual(anchors.map((a) => a.reason), ['interval', 'interval', 'interval', 'final']);
  assert.deepEqual(anchors.map((a) => a.round), [6, 14, 22, 38]);

  /**
   * ⭐ THE COST OF THE WHOLE FEATURE, MEASURED RATHER THAN ASSUMED. My first
   * draft asserted "< 500" from taste and the test went red at 536 — so the
   * number is now the one the code actually produces, and the bound is what it
   * is compared AGAINST that matters:
   *
   *   this design (4 anchors)                 536 approx tokens
   *   the obvious design (one every round)  5,440 approx tokens  = 10.1x
   *
   * and neither of those is the 2.4x cache figure, which is a SEPARATE and
   * larger cost that only the third design — editing the system prompt — pays.
   * Appending costs tokens; editing costs tokens AND the prefix.
   */
  const spent = anchors.reduce((n, a) => n + a.tokens, 0);
  assert.equal(spent, 536);
  const perRound = anchors[0].tokens * 40;
  assert.ok(perRound / spent > 10, `per-round anchoring would cost ${perRound}, this costs ${spent}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. RECONCILIATION
 * ══════════════════════════════════════════════════════════════════════════ */

test('reconcile counts promised, marked done, and — the number nobody has been shown — evidenced', () => {
  const p = plan([
    { text: 'write lib/store.mjs', state: 'done' },
    { text: 'add tests for the store', state: 'done' },
    { text: 'git_commit the result', state: 'done' },
    { text: 'update README.md', state: 'todo' },
  ]);
  const rec = reconcile({
    plan: p,
    rounds: [
      round(1, [write('lib/store.mjs')]),
      round(2, [write('test/store.test.mjs'), cmd('npm test', 0)]),
      round(3, [write('scratch/scratch.json')]),
    ],
  });

  assert.equal(rec.ok, true);
  assert.equal(rec.promised, 4);
  assert.equal(rec.markedDone, 3);
  // s1 and s2 have files; s3 claims a commit that never happened.
  assert.equal(rec.evidenced, 2);
  assert.deepEqual(rec.claimed.map((s) => s.id), ['s3']);
  assert.deepEqual(rec.unpromised, ['scratch/scratch.json']);
  assert.deepEqual(rec.outstandingSteps.map((s) => s.id), ['s4']);
});

test('the printed block marks a claim as a claim, and keeps finished apart from correct', () => {
  const p = plan([
    { text: 'write lib/store.mjs', state: 'done' },
    { text: 'git_commit the result', state: 'done' },
  ]);
  const lines = formatReconciliation(reconcile({ plan: p, rounds: [round(1, [write('lib/store.mjs')])] }));
  const text = lines.join('\n');

  assert.match(text, /promised 2 · marked done 2 · evidenced 1 · asserted without evidence 1/);
  assert.match(text, /! s2 {2}\[deliver\] git_commit the result — MARKED DONE, but/);
  // ⚠️ The same wall `formatLedger` keeps. The moment this block appears to
  // have judged correctness it becomes the ✔ VERIFIED over an untouched
  // deliverable that started all of this.
  assert.match(text, /says nothing about whether the finished work is correct/);
});

test('reconcile with no plan says so instead of inventing a clean bill', () => {
  const rec = reconcile({ plan: null, rounds: [round(1, [write('a.txt')])] });
  assert.equal(rec.ok, false);
  assert.match(rec.note, /no plan was recorded/);
  assert.match(formatReconciliation(rec).join('\n'), /no plan was recorded/);
});

test('reconcile survives a run with no rounds at all', () => {
  const rec = reconcile({ plan: THREE_STEPS(), rounds: undefined });
  assert.equal(rec.ok, true);
  assert.equal(rec.markedDone, 0);
  assert.deepEqual(rec.changed, []);
  assert.deepEqual(rec.unpromised, []);
});
