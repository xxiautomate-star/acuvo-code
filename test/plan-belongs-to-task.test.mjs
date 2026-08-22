/**
 * ── ⭐⭐ THE PLAN THAT OUTLIVED ITS TASK ─────────────────────────────────────
 *
 * MEASURED in a dogfood session, 2026-08-14. One `.acuvo/plan.json`:
 *
 *   · `createdAt` and `updatedAt` **6 milliseconds apart** — written once by
 *     `plan_start` and never touched again across 20 rounds and FOUR runs.
 *   · Six steps, all `"state":"todo"`, including *"Write lib/store.mjs"* for a
 *     file written, executed and verified in run 1.
 *   · Every round of every later run carried that banner — including a run
 *     whose entire task was **"add a package.json"**, which pushed back:
 *     *"the runner is showing a plan with steps about writing library files,
 *     but this session's actual task was only to add package.json."*
 *
 * Two defects, and this file pins the fixes for both:
 *
 *   (b) a plan from another task is no longer injected — `planTaskRelation`,
 *       `foreignPlanNotice`, and the `plan_start` archive.
 *   (a) a never-marked plan says so, in the banner and in the ledger, WITHOUT
 *       inferring anything from disk.
 *
 * ── ⚠️ THE HONESTY RULE THIS FILE DEFENDS ──────────────────────────────────
 * `plan-ledger.mjs` states that `done` is ASSERTED, never INFERRED. The
 * tempting fix for the stale steps — notice `lib/store.mjs` exists and mark it
 * done — would make the ledger lie in the OPTIMISTIC direction, which is the
 * failure the module was built to prevent. `nothing is ever marked from the
 * outside` below exists so that fix cannot be smuggled in later.
 *
 * ⚠️ EVERY TEST HERE WAS MUTATION-VERIFIED: the implementation was broken, the
 * test watched go RED, then restored. What was mutated is recorded in the
 * commit and the report.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  planStart, planStep, planStatus, loadPlan, formatBanner, formatLedger,
  planTaskRelation, foreignPlanNotice, taskKey, significantWords, outstanding,
} from '../lib/plan-ledger.mjs';

function ws(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-plan-task-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A plan on disk in the OLD format — no `runTaskKey`, which is every plan that
 *  exists today, including the one the dogfood session left behind. */
function writeLegacyPlan(dir, task, stepTexts) {
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  const iso = new Date().toISOString();
  writeFileSync(join(dir, '.acuvo', 'plan.json'), `${JSON.stringify({
    version: 1,
    task,
    createdAt: iso,
    updatedAt: iso,
    steps: stepTexts.map((text, i) => ({ id: `s${i + 1}`, text, state: 'todo' })),
  }, null, 2)}\n`, 'utf8');
}

/* ────────────────────────────────────────────────────────────────────────────
 * (1) THE PLAN NOW RECORDS WHICH TASK IT BELONGS TO
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ plan_start stamps the RUNNER\'s task, so a later run can tell whose plan this is', (t) => {
  const root = ws(t);
  const started = planStart(
    root,
    { task: 'build the store module', steps: ['write lib/store.mjs', 'write the tests'] },
    { task: 'write a small key-value store with a CLI' },
  );
  assert.equal(started.ok, true);

  const onDisk = JSON.parse(readFileSync(join(root, '.acuvo', 'plan.json'), 'utf8'));
  assert.match(onDisk.runTaskKey, /^[0-9a-f]{16}$/, 'the plan must carry a task key');

  /**
   * ⚠️ A HASH, NOT THE PROMPT. The user's words are not the model's, so they
   * must not become a file — and `looksLikeSecret` cannot be applied to them
   * without letting a pasted token refuse `plan_start` entirely.
   */
  assert.equal(
    JSON.stringify(onDisk).includes('key-value store with a CLI'),
    false,
    'the runner task must be hashed, never stored verbatim',
  );
});

test('⭐ the SAME prompt is the same task — resume keeps its countdown', (t) => {
  const root = ws(t);
  const prompt = 'write a small key-value store with a CLI';
  planStart(root, { task: 'build the store', steps: ['write lib/store.mjs'] }, { task: prompt });
  const plan = loadPlan(root).plan;
  assert.equal(planTaskRelation(plan, prompt), 'same');
  // Whitespace and case are not a different task.
  assert.equal(planTaskRelation(plan, '  Write a small   key-value STORE with a CLI '), 'same');
});

test('⚠️⚠️ THE BUG: a DIFFERENT prompt is a different task, exactly the dogfood pair', (t) => {
  const root = ws(t);
  planStart(
    root,
    { task: 'build the store', steps: ['Write lib/store.mjs', 'Write the tests'] },
    { task: 'write a small key-value store with a CLI' },
  );
  const plan = loadPlan(root).plan;
  assert.equal(planTaskRelation(plan, 'add a package.json'), 'different');
});

test('⚠️ a caller that names no task gets "unknown" — never a guess in either direction', (t) => {
  const root = ws(t);
  planStart(root, { task: 'build the store', steps: ['a'] }, { task: 'some task' });
  const plan = loadPlan(root).plan;
  assert.equal(planTaskRelation(plan, undefined), 'unknown');
  assert.equal(planTaskRelation(plan, ''), 'unknown');
  assert.equal(planTaskRelation(null, 'anything'), 'unknown');
  assert.equal(taskKey('   '), null);
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2) THE LEGACY FALLBACK — every plan on disk today has no key
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ a LEGACY plan (no key) is still caught when it shares not one significant word', (t) => {
  const root = ws(t);
  writeLegacyPlan(root, 'write a key-value store library with a CLI and tests', [
    'Write lib/store.mjs', 'Write lib/cli.mjs', 'Write test/store.test.mjs',
  ]);
  const plan = loadPlan(root).plan;
  assert.equal(plan.runTaskKey, undefined, 'the fixture must be in the old format');
  assert.equal(planTaskRelation(plan, 'add a package.json'), 'different');
});

test('⚠️ the legacy fallback stays SILENT when there is any overlap — a resume must not lose its banner', (t) => {
  const root = ws(t);
  writeLegacyPlan(root, 'port the callbacks and then commit', ['port index.js', 'git_commit']);
  const plan = loadPlan(root).plan;
  // One shared significant word is enough to refuse to call it a different task.
  assert.equal(planTaskRelation(plan, 'finish the callbacks port'), 'unknown');
  assert.equal(planTaskRelation(plan, 'port the callbacks and then commit'), 'unknown');
});

test('⚠️ stopwords and two-letter noise cannot create overlap by themselves', (t) => {
  const w = significantWords('Add the new files for you, and run it');
  for (const noise of ['add', 'the', 'new', 'files', 'for', 'you', 'and', 'run', 'it']) {
    assert.equal(w.has(noise), false, `"${noise}" must not count as a significant word`);
  }
  assert.ok(significantWords('refactor the auth module').has('auth'));
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) WHAT HAPPENS ON A MISMATCH — mentioned once, never deleted
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ the mismatch notice names the COUNT and the verb, and NOT the steps', (t) => {
  const root = ws(t);
  planStart(
    root,
    { task: 'build the store', steps: ['Write lib/store.mjs', 'Write lib/cli.mjs', 'Write the tests'] },
    { task: 'write a small key-value store with a CLI' },
  );
  const plan = loadPlan(root).plan;
  const notice = foreignPlanNotice(plan, { task: 'add a package.json' });

  assert.ok(notice, 'a plan for another task must be mentioned, not silently ignored');
  assert.match(notice, /3 of 3 steps unfinished/);
  assert.match(notice, /plan_status/);
  /**
   * ⚠️⚠️ THE STEPS ARE THE POLLUTION. The model reading "Write lib/store.mjs"
   * on every round is what made it argue with the runner about whose task it
   * was. The notice must say a plan EXISTS without restating its contents.
   */
  assert.equal(/store\.mjs|cli\.mjs/.test(notice), false, 'the notice must not restate another task\'s steps');
});

test('⚠️ a MATCHING task gets no notice, and a FINISHED old plan gets none either', (t) => {
  const root = ws(t);
  const prompt = 'write a small key-value store with a CLI';
  planStart(root, { task: 'build the store', steps: ['write lib/store.mjs'] }, { task: prompt });
  const plan = loadPlan(root).plan;
  assert.equal(foreignPlanNotice(plan, { task: prompt }), null);

  planStep(root, { id: 's1', state: 'done' });
  const finished = loadPlan(root).plan;
  assert.equal(
    foreignPlanNotice(finished, { task: 'add a package.json' }),
    null,
    'a plan with nothing outstanding is history, not an interruption',
  );
});

test('⭐ plan_start on a PROVABLY different task archives the old plan instead of refusing', (t) => {
  const root = ws(t);
  planStart(
    root,
    { task: 'build the store', steps: ['Write lib/store.mjs', 'Write the tests'] },
    { task: 'write a small key-value store with a CLI' },
  );

  const second = planStart(
    root,
    { task: 'add a package.json', steps: ['write package.json'] },
    { task: 'add a package.json' },
  );

  assert.equal(second.ok, true, 'the second task must be able to plan its own work');
  assert.equal(second.superseded.outstanding, 2);
  assert.ok(second.superseded.savedAs, 'the archived plan must be NAMED, or "set aside" means "deleted"');

  /**
   * ⚠️⚠️ NOT DELETED. An outstanding plan is how a resumed session remembers
   * what is left; destroying one silently is a worse failure than showing a
   * stale one, because the user cannot even see what was lost.
   */
  const archived = JSON.parse(readFileSync(join(root, second.superseded.savedAs), 'utf8'));
  assert.equal(archived.task, 'build the store');
  assert.equal(archived.steps.length, 2);

  // And the live plan is now this task's.
  assert.deepEqual(loadPlan(root).plan.steps.map((s) => s.text), ['write package.json']);
});

test('⚠️ an UNPROVEN conflict still REFUSES — the refusal is the resume primitive', (t) => {
  const root = ws(t);
  const prompt = 'port the module and commit';
  planStart(root, { task: 'port and commit', steps: ['port utils.mjs', 'git_commit'] }, { task: prompt });

  const same = planStart(root, { task: 'start over', steps: ['do it again'] }, { task: prompt });
  assert.equal(same.ok, false, 'the same task must still hand back the unfinished plan');
  assert.equal(same.outstanding.length, 2);

  // No task given at all (a direct call, or an older build) — also a refusal.
  const blind = planStart(root, { task: 'start over', steps: ['do it again'] });
  assert.equal(blind.ok, false);
  assert.equal(loadPlan(root).plan.steps.length, 2, 'neither refusal may have touched the plan');
});

/* ────────────────────────────────────────────────────────────────────────────
 * (4) DEFECT (a) — NEVER MARKED, SAID PLAINLY, NEVER INFERRED
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ from round 3 the banner names BOTH verbs — mark it, or replace a plan that is wrong', (t) => {
  const root = ws(t);
  planStart(root, { task: 't', steps: ['Write lib/store.mjs', 'Write the tests'] }, { task: 'x' });
  const plan = loadPlan(root).plan;

  const early = formatBanner(plan, { roundIndex: 2, maxRounds: 8 });
  assert.match(early, /mark one finished as you go/);
  assert.equal(/plan_start/.test(early), false, 'rounds 1–2 legitimately have nothing finished yet');

  const late = formatBanner(plan, { roundIndex: 4, maxRounds: 8 });
  assert.match(late, /nothing has been marked yet/);
  assert.match(late, /plan_start with the real steps/,
    'a model that cannot honestly mark anything needs the second verb, or it has no move at all');
});

test('⚠️ the escalation is about MARKING, not about the work — it disappears when one step is marked', (t) => {
  const root = ws(t);
  planStart(root, { task: 't', steps: ['a', 'b', 'c'] }, { task: 'x' });
  planStep(root, { id: 's1', state: 'done' });
  const late = formatBanner(loadPlan(root).plan, { roundIndex: 7, maxRounds: 8 });
  assert.equal(/nothing has been marked/.test(late), false);
  assert.equal(/plan_step \{/.test(late), false);
});

test('⚠️⚠️ the LEDGER says "never marked", not "not finished" — the dogfood plan\'s exact shape', (t) => {
  const root = ws(t);
  planStart(root, { task: 'build the store', steps: ['Write lib/store.mjs', 'Write the tests'] }, { task: 'x' });
  const text = formatLedger(loadPlan(root).plan, { roundIndex: 8, maxRounds: 8 });

  /**
   * "Write lib/store.mjs" named a file that WAS written, run and verified.
   * Reporting it under "asked for and not finished" is this module lying in
   * the pessimistic direction — a finding it never observed, from the same
   * absence of evidence that would let it claim success it never observed.
   */
  assert.match(text, /NO step was ever marked/);
  assert.equal(
    /asked for and not finished/.test(text),
    false,
    'with nothing ever marked, the ledger may not claim the work is undone',
  );
  // The steps are still listed — saying so honestly must not mean hiding them.
  assert.match(text, /Write lib\/store\.mjs/);

  // And once anything IS marked, the ordinary heading returns.
  planStep(root, { id: 's1', state: 'done' });
  assert.match(formatLedger(loadPlan(root).plan), /1 of 2 steps asked for and not finished/);
});

test('⚠️⚠️ NOTHING is ever marked from the outside — the file existing proves nothing', (t) => {
  const root = ws(t);
  planStart(root, { task: 'build the store', steps: ['Write lib/store.mjs'] }, { task: 'x' });

  // The file the step names now exists, is non-empty, and even runs.
  writeFileSync(join(root, 'store.mjs'), 'export const get = () => 1;\n', 'utf8');
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'store.mjs'), 'export const get = () => 1;\n', 'utf8');

  assert.equal(planStatus(root).steps[0].state, 'todo',
    'done is ASSERTED by the agent; inferring it from a filename is the failure this module exists to prevent');
  assert.equal(outstanding(loadPlan(root).plan).length, 1);
});

/* ────────────────────────────────────────────────────────────────────────────
 * (5) THE TAX, WITH A NUMBER ON IT
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ the notice is cheaper than one round of the banner, and it is paid ONCE', (t) => {
  const root = ws(t);
  planStart(root, {
    task: 'write a small key-value store library with a CLI and tests',
    steps: [
      'Write lib/store.mjs with get/set/delete',
      'Write lib/cli.mjs argument parsing',
      'Write bin/kv.mjs entry point',
      'Write test/store.test.mjs',
      'Run the tests and fix failures',
      'Write README.md usage section',
    ],
  }, { task: 'write a small key-value store library with a CLI and tests' });

  const plan = loadPlan(root).plan;
  const banner = formatBanner(plan, { roundIndex: 4, maxRounds: 8 });
  const notice = foreignPlanNotice(plan, { task: 'add a package.json' });

  // MEASURED: banner 336 chars + a 206-char wrapper ≈ 136 tokens EVERY round,
  // for 20 rounds across 4 runs. The notice is ~91 tokens, once.
  assert.ok(banner.length > 200, `banner shrank unexpectedly (${banner.length}) — re-measure the tax before trusting the comment`);
  assert.ok(notice.length < banner.length + 206, 'the once-only notice must not cost more than one round of the thing it replaces');
});

/* ────────────────────────────────────────────────────────────────────────────
 * (6) THE FILE FORMAT SURVIVES BOTH DIRECTIONS
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️ a garbage runTaskKey is treated as ABSENT, never as proof of a different task', (t) => {
  const root = ws(t);
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  const iso = new Date().toISOString();
  writeFileSync(join(root, '.acuvo', 'plan.json'), `${JSON.stringify({
    version: 1,
    task: 'port the callbacks and commit',
    runTaskKey: { not: 'a string' },
    createdAt: iso, updatedAt: iso,
    steps: [{ id: 's1', text: 'port index.js', state: 'todo' }],
  }, null, 2)}\n`, 'utf8');

  const plan = loadPlan(root).plan;
  assert.ok(plan, 'an unrecognised key must not make the whole plan unparseable');
  assert.equal(plan.runTaskKey, undefined);
  assert.equal(planTaskRelation(plan, 'finish the callbacks port'), 'unknown');
});

test('⚠️ plan_step keeps the key, so marking a step cannot orphan the plan from its task', (t) => {
  const root = ws(t);
  const prompt = 'write a small key-value store with a CLI';
  planStart(root, { task: 'build the store', steps: ['a', 'b'] }, { task: prompt });
  const before = loadPlan(root).plan.runTaskKey;
  planStep(root, { id: 's1', state: 'done' });
  assert.equal(loadPlan(root).plan.runTaskKey, before);
  assert.equal(planTaskRelation(loadPlan(root).plan, prompt), 'same');
});

test('⚠️ the archive lands inside .acuvo/ and nowhere else', (t) => {
  const root = ws(t);
  planStart(root, { task: 'build the store', steps: ['Write lib/store.mjs'] }, { task: 'build a key-value store' });
  const second = planStart(root, { task: 'add a package.json', steps: ['write it'] }, { task: 'add a package.json' });
  assert.ok(second.superseded.savedAs.startsWith('.acuvo/'), second.superseded.savedAs);
  assert.equal(existsSync(join(root, '.acuvo', 'plan.json')), true);
  assert.equal(
    readdirSync(root).filter((n) => n !== '.acuvo').length,
    0,
    'nothing may be written into the user\'s source tree',
  );
});
