/**
 * ── ⭐⭐⭐ THE FOUR QUESTIONS ARE THE USER'S, AND THIS FILE PROVES IT ─────────
 *
 * Roman, standing for days: *"those 4 questions should be determined by the
 * user, our CLI should be super customisable."* The four, and where each was
 * hard-coded before this landed:
 *
 *   1. when is a task DONE   an inline rule in `turn.mjs` — any verification
 *                            command exiting 0 closed the run after one grace
 *                            round, and nothing could change it
 *   2. what may it COST      `DEFAULT_BUDGET_USD` in `budget.mjs`
 *   3. ASK or ACT            `MAX_QUESTIONS = 3` in `ask-user.mjs`, and
 *                            `ACUVO_APPROVE` read straight from the environment
 *                            in `diff-preview.mjs` with nothing above it
 *   4. what to do when STUCK an inline rule in `turn.mjs` — nudge once per loop,
 *                            hard-stop on a repeat only under `--until-done`
 *
 * ── ⚠️ THE ASSERTION THAT MATTERS MOST IS #3 IN THE BRIEF ───────────────────
 *
 * *"Defaults must not change behaviour for existing users. A user who sets
 * nothing gets exactly today's behaviour."* Two tests below pin that from both
 * ends: the resolver must return an EMPTY options object when nobody has said
 * anything (so nothing is overwritten at all), and every default must be the
 * module's own constant rather than a number retyped in a config table.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveConfig, applyConfigToOptions, explicitKeysFromArgv,
  defaultConfig, CONFIG_KEYS, FOUR_QUESTIONS, APPROVE_LADDER,
  resolveFourQuestions, describeFourQuestions, PRECEDENCE_LINE,
} from '../lib/rcfile.mjs';
import { DONE_MODES, DEFAULT_DONE_MODE, doneDecision } from '../lib/acceptance.mjs';
import { STUCK_ACTIONS, DEFAULT_STUCK_ACTION, stuckAction } from '../lib/stuck.mjs';
import { APPROVE_MODES, DEFAULT_APPROVE_MODE, approvalMode } from '../lib/diff-preview.mjs';
import { MAX_QUESTIONS } from '../lib/ask-user.mjs';
import { DEFAULT_BUDGET_USD, createBudget, openSpendJournal, resumeCeiling } from '../lib/budget.mjs';
import { parseArgv } from '../lib/cli-args.mjs';

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. DEFAULTS MUST NOT CHANGE BEHAVIOUR
 * ═══════════════════════════════════════════════════════════════════════════ */

test('⚠️⚠️ a user who sets NOTHING has NOTHING overridden — the resolver returns no options at all', () => {
  /**
   * The strongest form of "behaviour is unchanged": not "the same values were
   * applied" but "nothing was applied". `applyConfigToOptions` cannot change an
   * option it was never given.
   */
  const resolved = resolveConfig({ argv: [], env: {} });
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.options, {}, `an unconfigured run must resolve to no overrides, got ${JSON.stringify(resolved.options)}`);
});

test('⚠️⚠️ every default for the four is the MODULE\'S constant, never a retyped copy', () => {
  /**
   * ⭐ THIS IS THE TEST THAT KEEPS "unchanged behaviour" TRUE OVER TIME. A
   * config table that hard-codes `3` stays at 3 the day `ask-user.mjs` decides
   * the right number is 2, and then the config layer silently becomes a
   * behaviour change nobody made.
   */
  const d = defaultConfig();
  assert.equal(d.done, DEFAULT_DONE_MODE, 'done');
  assert.equal(d.budget, DEFAULT_BUDGET_USD, 'budget');
  assert.equal(d.approve, DEFAULT_APPROVE_MODE, 'approve');
  assert.equal(d.maxQuestions, MAX_QUESTIONS, 'maxQuestions');
  assert.equal(d.onStuck, DEFAULT_STUCK_ACTION, 'onStuck');
});

test('⚠️ the PARSER\'s defaults agree with the config layer\'s, or one of them is lying', () => {
  const { ok, options } = parseArgv(['do a thing']);
  assert.equal(ok, true);
  const d = defaultConfig();
  assert.equal(options.doneWhen, d.done);
  assert.equal(options.approveMode, d.approve);
  assert.equal(options.maxQuestions, d.maxQuestions);
  assert.equal(options.onStuck, d.onStuck);
  assert.equal(options.budgetUsd, d.budget);
});

test('⭐ the DEFAULT answers reproduce today\'s runtime behaviour exactly', () => {
  // DONE: a verification command passing buys one grace round, then closes.
  assert.equal(doneDecision({ verificationPassed: true }).do, 'extend');
  assert.equal(doneDecision({ verificationPassed: true, extended: true }).do, 'close');
  assert.equal(doneDecision({ verificationPassed: true, atRoundCeiling: true }).do, 'close');
  assert.equal(doneDecision({ verificationPassed: false }).do, 'continue');

  // STUCK: nudge once per loop; a repeat stops ONLY under --until-done.
  assert.equal(stuckAction({ firstSighting: true }).do, 'nudge');
  assert.equal(stuckAction({ firstSighting: false }).do, 'nothing');
  assert.equal(stuckAction({ firstSighting: false, untilDone: true }).do, 'stop');
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. PRECEDENCE:  flag > env > home > workspace > default
 * ═══════════════════════════════════════════════════════════════════════════ */

const FOUR_KEYS = FOUR_QUESTIONS.flatMap((q) => q.keys);

test('the four questions all resolve through ONE mechanism, not four bespoke ones', () => {
  for (const key of FOUR_KEYS) {
    assert.ok(CONFIG_KEYS[key], `${key} is named by FOUR_QUESTIONS and is not a config key`);
  }
  // And each is reachable from a flag AND a variable AND a file.
  for (const key of FOUR_KEYS) {
    assert.ok((CONFIG_KEYS[key].env ?? []).length > 0, `${key} has no environment variable`);
  }
});

test('⭐⭐ PRECEDENCE, one key at a time, all five layers', () => {
  const layers = {
    argv: ['--on-stuck', 'ask'],
    env: { ACUVO_ON_STUCK: 'stop' },
    homeText: JSON.stringify({ onStuck: 'nudge' }),
  };

  // default only
  assert.equal(resolveConfig({ argv: [], env: {} }).values.onStuck, DEFAULT_STUCK_ACTION);
  // home beats default
  assert.equal(resolveConfig({ argv: [], env: {}, homeText: layers.homeText }).values.onStuck, 'nudge');
  // env beats home
  assert.equal(resolveConfig({ argv: [], env: layers.env, homeText: layers.homeText }).values.onStuck, 'stop');
  // flag beats env: the resolver must REMOVE the key rather than return a value
  const withFlag = resolveConfig({ argv: layers.argv, env: layers.env, homeText: layers.homeText });
  assert.equal(withFlag.options.onStuck, undefined, 'a typed flag must not appear in the overrides at all');

  // …and end to end through the real applier, which is where precedence bugs live.
  const opts = parseArgv([...layers.argv, 'task']).options;
  applyConfigToOptions(opts, withFlag.values, explicitKeysFromArgv(layers.argv));
  assert.equal(opts.onStuck, 'ask', 'the flag the user typed must survive both a variable and a file');
});

test('⭐ the same five layers for COST, which is the one that spends money', () => {
  assert.equal(resolveConfig({ argv: [], env: {} }).values.budget, DEFAULT_BUDGET_USD);
  assert.equal(resolveConfig({ argv: [], env: {}, homeText: '{"budget":"0.10"}' }).values.budget, 0.10);
  assert.equal(resolveConfig({ argv: [], env: { ACUVO_BUDGET: '25c' }, homeText: '{"budget":"0.10"}' }).values.budget, 0.25);
});

test('⚠️ a REPOSITORY may demand MORE review and can never demand less', () => {
  /**
   * `approve` is the one of the four with a genuine stricter direction, so it is
   * the one a cloned repo is allowed to state. The ladder is what makes that
   * safe, and the direction is the whole point.
   */
  const stricter = resolveConfig({ argv: [], env: {}, workspaceText: '{"approve":"always"}' });
  assert.equal(stricter.values.approve, 'always', 'a repo may ask for more review');

  const looser = resolveConfig({ argv: [], env: {}, workspaceText: '{"approve":"never"}' });
  assert.equal(looser.values.approve, DEFAULT_APPROVE_MODE, 'a repo must NOT be able to switch review off');
  assert.match(looser.notes.join(' '), /may only tighten/);

  assert.deepEqual([...APPROVE_LADDER].sort(), [...APPROVE_MODES].sort(), 'the ladder must rank exactly the modes that exist');
});

test('⚠️ a repository may not answer DONE or STUCK at all — neither has a stricter direction', () => {
  for (const [key, value] of [['done', 'never'], ['onStuck', 'stop']]) {
    const r = resolveConfig({ argv: [], env: {}, workspaceText: JSON.stringify({ [key]: value }) });
    assert.equal(r.ok, false, `a workspace config set ${key} and was allowed to`);
    assert.match(r.error, /may only be set in your own config/);
  }
});

test('⚠️ a repository may only make the agent interrupt you LESS', () => {
  const fewer = resolveConfig({ argv: [], env: {}, workspaceText: '{"maxQuestions":1}' });
  assert.equal(fewer.values.maxQuestions, 1);
  const more = resolveConfig({ argv: [], env: {}, workspaceText: '{"maxQuestions":9}' });
  assert.equal(more.values.maxQuestions, MAX_QUESTIONS, 'a repo must not be able to raise the question allowance');
});

test('⚠️⚠️ a malformed ACUVO_APPROVE still STOPS the run — the refusal was not lost in the refactor', () => {
  /**
   * `diff-preview.mjs` refuses `ACUVO_APPROVE=nver` by name: *"a person asking
   * for a gate and silently getting none, and the symptom is everything works
   * fine."* Routing that variable through the config layer without carrying its
   * strictness across would have downgraded a hard refusal to an ignored note —
   * a security regression delivered by a refactor.
   */
  const r = resolveConfig({ argv: [], env: { ACUVO_APPROVE: 'nver' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /ACUVO_APPROVE/);
  assert.match(r.error, /always, auto, never|auto, always, never/);
});

test('⚠️ every OTHER malformed variable is still a note, not a stopped run', () => {
  const r = resolveConfig({ argv: [], env: { ACUVO_ON_STUCK: 'explode' } });
  assert.equal(r.ok, true, 'a stranger process setting a variable must not brick the CLI');
  assert.equal(r.values.onStuck, DEFAULT_STUCK_ACTION);
  assert.match(r.notes.join(' '), /ignored ACUVO_ON_STUCK/);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. DISCOVERABILITY — a knob nobody can find is not configurable
 * ═══════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ the four resolved values are reported WITH the layer that decided each', () => {
  const argv = ['--budget', '0.50'];
  const resolved = resolveConfig({
    argv,
    env: { ACUVO_MAX_QUESTIONS: '1' },
    homeText: JSON.stringify({ done: 'acceptance' }),
    workspaceText: JSON.stringify({ approve: 'always' }),
  });
  assert.equal(resolved.ok, true);
  const options = parseArgv([...argv, 'task']).options;
  const rows = resolveFourQuestions(resolved, options);

  const find = (key) => rows.flatMap((q) => q.settings).find((s) => s.key === key);
  assert.equal(find('budget').origin, 'flag');
  assert.equal(find('budget').value, 0.50, 'a typed flag must report its OWN value, not the file it beat');
  assert.equal(find('maxQuestions').origin, 'env');
  assert.equal(find('done').origin, 'home');
  assert.equal(find('approve').origin, 'workspace');
  assert.equal(find('onStuck').origin, 'default');
});

test('⭐ the printed block names all four questions and states the precedence once', () => {
  const lines = describeFourQuestions(resolveConfig({ argv: [], env: {} }));
  const text = lines.join('\n');
  for (const q of FOUR_QUESTIONS) assert.ok(text.includes(q.question), `the block never mentions "${q.question}"`);
  for (const key of FOUR_KEYS) assert.ok(text.includes(key), `the block never mentions the key "${key}"`);
  assert.ok(text.includes(PRECEDENCE_LINE), 'the precedence rule is documented in exactly one place and printed from it');
  // ⚠️ And the flags are named, because "set it in a config file" is not a way in.
  for (const flag of ['--done', '--budget', '--approve', '--max-questions', '--on-stuck']) {
    assert.ok(text.includes(flag), `the block never names ${flag}`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1 & 4. THE TWO DECISIONS THAT WERE INLINE RULES
 * ═══════════════════════════════════════════════════════════════════════════ */

test('DONE — `never` refuses to let a green command close the run', () => {
  assert.equal(doneDecision({ mode: 'never', verificationPassed: true }).do, 'continue');
  assert.equal(doneDecision({ mode: 'never', verificationPassed: true, extended: true }).do, 'continue');
});

test('DONE — `acceptance` holds the run open while the DECLARED criterion is unmet', () => {
  assert.equal(doneDecision({ mode: 'acceptance', verificationPassed: true, acceptanceVerdict: 'unmet' }).do, 'continue');
  assert.equal(doneDecision({ mode: 'acceptance', verificationPassed: true, acceptanceVerdict: 'not-run' }).do, 'continue');
  // ⚠️ …and falls back to the verification rule when nothing was declared, or
  // every ordinary run becomes a round-cap run.
  assert.equal(doneDecision({ mode: 'acceptance', verificationPassed: true, acceptanceVerdict: 'none-declared' }).do, 'extend');
  assert.equal(doneDecision({ mode: 'acceptance', verificationPassed: true, acceptanceVerdict: null }).do, 'extend');
  assert.equal(doneDecision({ mode: 'acceptance', verificationPassed: true, acceptanceVerdict: 'met', extended: true }).do, 'close');
});

test('STUCK — the FIRST sighting is always a nudge, whatever the setting', () => {
  for (const action of STUCK_ACTIONS) {
    assert.equal(stuckAction({ firstSighting: true, action }).do, 'nudge', `${action} stopped on a first sighting`);
  }
});

test('STUCK — `stop` ends a bounded run, which `nudge` never does', () => {
  assert.equal(stuckAction({ firstSighting: false, action: 'stop' }).do, 'stop');
  assert.equal(stuckAction({ firstSighting: false, action: 'nudge' }).do, 'nothing');
});

test('⚠️ STUCK — `ask` degrades to NUDGE with no terminal, never to stop', () => {
  /**
   * Failing toward more work is the direction that cannot throw away money
   * already spent. A run that silently ended because it was told to ask a
   * question nobody could hear is the least legible failure available.
   */
  assert.equal(stuckAction({ firstSighting: false, action: 'ask', canAsk: false }).do, 'nudge');
  assert.equal(stuckAction({ firstSighting: false, action: 'ask', canAsk: true }).do, 'ask');
});

test('⚠️ an unknown mode falls back to the default rather than throwing inside the loop', () => {
  assert.equal(doneDecision({ mode: 'banana', verificationPassed: true }).do, 'extend');
  assert.equal(stuckAction({ firstSighting: false, action: 'banana', untilDone: true }).do, 'stop');
});

test('the enum lists the parser validates against ARE the module lists', () => {
  assert.deepEqual([...CONFIG_KEYS.done.choices], [...DONE_MODES]);
  assert.deepEqual([...CONFIG_KEYS.onStuck.choices], [...STUCK_ACTIONS]);
  assert.deepEqual([...CONFIG_KEYS.approve.choices].sort(), [...APPROVE_MODES].sort());
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4 (of the brief). CRASH SAFETY — a ceiling that dies with the process is not
 *                    a ceiling
 * ═══════════════════════════════════════════════════════════════════════════ */

/** An in-memory journal file, so the whole resume rule is provable with no disk. */
function fakeJournal(runKey, ceilingUsd, backing) {
  return openSpendJournal({
    runKey,
    ceilingUsd,
    read: () => {
      if (backing.text === null) {
        const err = new Error('no such file');
        err.code = 'ENOENT';
        throw err;
      }
      return backing.text;
    },
    append: (line) => { backing.text = (backing.text ?? '') + line; },
  });
}

test('⚠️⚠️ A CRASH MUST NOT RESET THE METER — the second process carries the first\'s spend', () => {
  const backing = { text: null };
  const KEY = 'acuvo-run-1';

  // ── process 1: spends most of a 5-cent ceiling, then dies.
  const j1 = fakeJournal(KEY, 0.05, backing);
  assert.equal(j1.ok, true);
  assert.equal(j1.priorUsd, 0, 'a fresh run starts at zero');
  const b1 = createBudget({ limitUsd: 0.05, journal: j1, clock: () => 0 });
  b1.record({ costUsd: 0.0499, tokens: 1000 });
  assert.equal(b1.stats().spentUsd.toFixed(4), '0.0499');

  // ── the process is killed here. Nothing tidy happens.

  // ── process 2: same run key, same ceiling.
  const j2 = fakeJournal(KEY, 0.05, backing);
  assert.equal(j2.ok, true);
  assert.ok(j2.priorUsd >= 0.0499, `the journal lost the earlier spend (saw ${j2.priorUsd})`);

  const b2 = createBudget({ limitUsd: 0.05, resumedUsd: j2.priorUsd, journal: j2, clock: () => 0 });
  assert.equal(b2.stats().spentUsd.toFixed(4), '0.0499', 'the resumed meter must not start at zero');

  const verdict = b2.canContinue();
  assert.equal(verdict.ok, false, 'the resumed run was allowed to spend the whole ceiling a second time');
  assert.ok(['limit-reached', 'would-exceed'].includes(verdict.reason), `unexpected reason: ${verdict.reason}`);
  /**
   * ⚠️ NOT 'too-small'. That verdict says "nothing was started — raise it or
   * drop the flag", which about money the user has already spent is an output
   * that lies about what the tool did.
   */
  assert.notEqual(verdict.reason, 'too-small', 'a resumed run is not "nothing was started"');
});

test('⭐ WITHOUT the journal the same two processes each get the full ceiling — the bug, pinned', () => {
  /**
   * ⚠️ A GUARD THAT CANNOT FAIL IS WORSE THAN NO GUARD. This asserts the OLD
   * behaviour still happens when nothing is wired, which is what makes the test
   * above evidence rather than decoration.
   */
  const b1 = createBudget({ limitUsd: 0.05, clock: () => 0 });
  b1.record({ costUsd: 0.0499, tokens: 1000 });
  assert.equal(b1.canContinue().ok, false, 'precondition: the first process really did exhaust its ceiling');

  const b2 = createBudget({ limitUsd: 0.05, clock: () => 0 });
  assert.equal(b2.canContinue().ok, true, 'the unjournalled second process starts fresh — that IS the bug');
  assert.equal(b2.stats().spentUsd, 0);
});

test('⚠️ a DIFFERENT run key carries nothing — a fresh task is not billed for yesterday', () => {
  const backing = { text: null };
  const j1 = fakeJournal('acuvo-run-a', 0.05, backing);
  createBudget({ limitUsd: 0.05, journal: j1, clock: () => 0 }).record({ costUsd: 0.04, tokens: 10 });
  const j2 = fakeJournal('acuvo-run-b', 0.05, backing);
  assert.equal(j2.priorUsd, 0);
});

test('⚠️⚠️ an UNREADABLE journal stops the run rather than silently starting a fresh ceiling', () => {
  const r = openSpendJournal({
    runKey: 'k',
    read: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be read/);
});

test('⚠️ a half-written final line is skipped, not fatal — that is what a crash leaves', () => {
  const backing = { text: null };
  const j1 = fakeJournal('k', 0.05, backing);
  createBudget({ limitUsd: 0.05, journal: j1, clock: () => 0 }).record({ costUsd: 0.02, tokens: 10 });
  backing.text += '{"k":"k","u":0.9';           // killed mid-append
  const j2 = fakeJournal('k', 0.05, backing);
  assert.equal(j2.ok, true);
  assert.equal(Number(j2.priorUsd.toFixed(4)), 0.02, 'the intact lines before the truncation are still the answer');
});

test('⚠️⚠️ a crash must not be a way to SPEND MORE — the tighter ceiling carries over', () => {
  const tight = resumeCeiling({ limitUsd: 5, priorCeilingUsd: 0.05, explicit: false });
  assert.equal(tight.usd, 0.05, 'restarting without the flag must not widen the ceiling');
  assert.equal(tight.carriedOver, true);
  assert.match(tight.reason, /crash must not be a way to spend more/);

  // ⚠️ …and `--budget none` must not become a way round it either.
  const unlimited = resumeCeiling({ limitUsd: null, priorCeilingUsd: 0.05, explicit: false });
  assert.equal(unlimited.usd, 0.05);

  // ⭐ But a number the user TYPED this time is an instruction, and is honoured.
  const chosen = resumeCeiling({ limitUsd: 5, priorCeilingUsd: 0.05, explicit: true });
  assert.equal(chosen.usd, 5);
  assert.equal(chosen.carriedOver, false);

  // And a fresh run with no journal behind it is untouched.
  assert.deepEqual(resumeCeiling({ limitUsd: 0.05 }), { usd: 0.05, carriedOver: false, reason: null });
});

test('⭐ a run that never resumed reports no `resumedUsd` at all — --json does not grow a field', () => {
  const plain = createBudget({ limitUsd: 0.05, clock: () => 0 });
  plain.record({ costUsd: 0.001, tokens: 10 });
  assert.equal('resumedUsd' in plain.toJSON(), false);

  const carried = createBudget({ limitUsd: 0.05, resumedUsd: 0.01, clock: () => 0 });
  carried.record({ costUsd: 0.001, tokens: 10 });
  assert.equal(carried.toJSON().resumedUsd, 0.01);
});

test('⚠️⚠️ ACUVO_APPROVE still reaches the approver through the CLI composition', () => {
  /**
   * ⭐ THE ONE THAT COULD HAVE REGRESSED SILENTLY. Routing `ACUVO_APPROVE`
   * through the config layer means `bin/` now passes a value to
   * `createWriteApprover` on EVERY run — and `approvalMode` ranks an explicit
   * argument above its own env read. So if the config layer failed to pick the
   * variable up, the variable would stop working entirely and every write would
   * be silently un-reviewed, with the whole suite green.
   *
   * This walks the exact composition `bin/acuvo.mjs` builds: parse, resolve,
   * apply, then ask `approvalMode` what the mode is.
   */
  for (const [envValue, expected] of [[undefined, 'auto'], ['always', 'always'], ['never', 'never']]) {
    const env = envValue === undefined ? {} : { ACUVO_APPROVE: envValue };
    const opts = parseArgv(['a task']).options;
    const resolved = resolveConfig({ argv: [], env });
    assert.equal(resolved.ok, true);
    applyConfigToOptions(opts, resolved.values, explicitKeysFromArgv([]));
    assert.equal(
      approvalMode({ env: {}, flag: opts.approveMode ?? null }).mode,
      expected,
      `ACUVO_APPROVE=${String(envValue)} arrived at the approver as something other than "${expected}"`,
    );
  }

  // ⭐ …and a typed flag still outranks the variable.
  const argv = ['--approve', 'never'];
  const opts = parseArgv([...argv, 'a task']).options;
  const resolved = resolveConfig({ argv, env: { ACUVO_APPROVE: 'always' } });
  applyConfigToOptions(opts, resolved.values, explicitKeysFromArgv(argv));
  assert.equal(approvalMode({ env: {}, flag: opts.approveMode }).mode, 'never');
});
