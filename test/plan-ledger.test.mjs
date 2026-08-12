/**
 * ── THE PLAN LEDGER'S TESTS — the decisions, not the getters ────────────────
 *
 * Three of these pin observed failures rather than hypotheticals:
 *
 *   · the RESUME case — probe 4 re-ran an identical command and burned 3 of 4
 *     rounds re-deriving a plan the previous process had held. `plan_start`
 *     refusing over an unfinished plan is the entire fix, so it is tested from
 *     both sides (refuse without `replace`, overwrite with it).
 *   · the BANNER — probe 4 diffed `body-08.json` against `body-01.json` and
 *     found them byte-identical: no countdown reaches the model anywhere. The
 *     exact string is asserted character for character, because the wiring will
 *     paste it into a payload and a "roughly right" banner is a banner nobody
 *     can rely on.
 *   · CORRUPTION — the file lives on a laptop next to `.git`. A plan we cannot
 *     parse must never be able to stop a run.
 *
 * The concurrency test forks two real processes. In-process "concurrency"
 * against synchronous fs calls proves nothing at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFile } from 'node:child_process';

import {
  planStart, planStep, planStatus, loadPlan, savePlan,
  outstanding, formatBanner, formatLedger, planToolSchemas,
  resolvePlanFile, looksLikeSecret, PLAN_FILE, MAX_STEPS,
} from '../lib/plan-ledger.mjs';

const ws = () => mkdtempSync(join(tmpdir(), 'planledger-'));

test('start → step → status round-trips through the file', () => {
  const root = ws();
  const started = planStart(root, { task: 'port the module and commit', steps: ['port utils.mjs', 'run the tests', 'git_commit'] });
  assert.equal(started.ok, true);
  assert.deepEqual(started.steps.map((s) => s.id), ['s1', 's2', 's3']);
  assert.equal(started.steps[0].state, 'todo');

  // It is on DISK, not in this process's memory — that is the whole premise.
  assert.ok(existsSync(join(root, PLAN_FILE)), 'the plan file was not written');

  const marked = planStep(root, { id: 's1', state: 'done' });
  assert.equal(marked.ok, true);
  assert.equal(marked.from, 'todo');
  assert.deepEqual(marked.outstanding.map((s) => s.id), ['s2', 's3']);

  const status = planStatus(root);
  assert.equal(status.exists, true);
  assert.equal(status.task, 'port the module and commit');
  assert.deepEqual(status.steps.map((s) => s.state), ['done', 'todo', 'todo']);

  // And a fresh read of the file agrees, so nothing lived only in a returned object.
  const reloaded = loadPlan(root);
  assert.equal(reloaded.plan.steps[0].state, 'done');
});

test('⭐ THE RESUME CASE — plan_start over an unfinished plan refuses and hands back the outstanding items', () => {
  const root = ws();
  planStart(root, { task: 'ten things', steps: Array.from({ length: 10 }, (_, i) => `step ${i + 1}`) });
  for (const id of ['s1', 's2', 's3', 's4']) planStep(root, { id, state: 'done' });

  const again = planStart(root, { task: 'ten things', steps: ['start over from scratch'] });
  assert.equal(again.ok, false);
  assert.equal(
    again.error,
    'a plan for this workspace already exists with 4 of 10 steps done — pass replace:true to discard it, or continue with plan_step',
  );
  // ⚠️ THE REFUSAL MUST CARRY THE WORK, not just decline. A refusal that says
  // "already exists" and nothing else costs the model another round to discover
  // what is left — which is the cost this whole module exists to remove.
  assert.equal(again.outstanding.length, 6);
  assert.deepEqual(again.outstanding.map((s) => s.id), ['s5', 's6', 's7', 's8', 's9', 's10']);
  assert.equal(again.existing.steps.length, 10);

  // And the plan on disk is untouched.
  assert.equal(loadPlan(root).plan.steps.length, 10);
});

test('replace:true overwrites, and says how much unfinished work it discarded', () => {
  const root = ws();
  planStart(root, { task: 'old task', steps: ['a', 'b', 'c'] });
  planStep(root, { id: 's1', state: 'done' });

  const replaced = planStart(root, { task: 'new task', steps: ['x', 'y'], replace: true });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.discardedOutstanding, 2);
  assert.deepEqual(loadPlan(root).plan.steps.map((s) => s.text), ['x', 'y']);
});

test('a COMPLETED plan is superseded without a flag — it is history, not work in progress', () => {
  const root = ws();
  planStart(root, { task: 'first', steps: ['a'] });
  planStep(root, { id: 's1', state: 'done' });
  const second = planStart(root, { task: 'second', steps: ['b'] });
  assert.equal(second.ok, true, 'a finished plan must not block the next task in the same workspace');
});

test('⭐ THE BANNER renders exactly, and omits the round clause when it is not supplied', () => {
  const root = ws();
  planStart(root, {
    task: 'seven things',
    steps: ['one', 'two', 'three', 'four', 'five', 'update README.md', 'git_commit'],
  });
  for (const id of ['s1', 's2', 's3', 's4', 's5']) planStep(root, { id, state: 'done' });
  const plan = loadPlan(root).plan;

  assert.equal(
    formatBanner(plan, { roundIndex: 6, maxRounds: 8 }),
    'plan: 5/7 done · 2 remaining: update README.md, git_commit · round 6 of 8',
  );
  // ⚠️ No numbers → no clause. A guessed countdown is worse than none.
  assert.equal(formatBanner(plan), 'plan: 5/7 done · 2 remaining: update README.md, git_commit');
  assert.equal(
    formatBanner(plan, { roundsRemaining: 1 }),
    'plan: 5/7 done · 2 remaining: update README.md, git_commit · 1 round left',
  );

  // The tools carry it too — that is how it reaches the model at all.
  assert.equal(
    planStatus(root, { roundIndex: 6, maxRounds: 8 }).banner,
    'plan: 5/7 done · 2 remaining: update README.md, git_commit · round 6 of 8',
  );
});

test('the banner is capped, marks blocked steps, and reports an all-done plan honestly', () => {
  const root = ws();
  planStart(root, { task: 't', steps: ['a', 'b', 'c', 'd', 'e'] });
  planStep(root, { id: 's2', state: 'blocked', note: 'no network' });
  /**
   * ⚠️ THE NUDGE IS PART OF THIS LINE NOW, and it belongs here. Measured on a
   * real run: the model called `plan_start`, worked for eight rounds, and never
   * called `plan_step` once — so the countdown printed "0/3 done" every round
   * and counted nothing. A status line that names no action produces no action.
   */
  assert.equal(
    formatBanner(loadPlan(root).plan),
    'plan: 0/5 done · 5 remaining: a, b (blocked), c, +2 more'
      + ' — mark one finished as you go: plan_step {"id":"s1","state":"done"}',
  );

  for (const id of ['s1', 's2', 's3', 's4', 's5']) planStep(root, { id, state: 'done' });
  assert.equal(formatBanner(loadPlan(root).plan, { roundIndex: 8, maxRounds: 8 }), 'plan: 5/5 done · all steps done · round 8 of 8');
  assert.equal(formatBanner(null, { roundIndex: 2, maxRounds: 4 }), 'plan: none recorded · round 2 of 4');
});

test('the OUTSTANDING block lists the unfinished work verbatim and refuses to imply a verdict', () => {
  const root = ws();
  planStart(root, { task: 'port and commit', steps: ['port utils.mjs', 'update README.md', 'git_commit'] });
  planStep(root, { id: 's1', state: 'done' });
  planStep(root, { id: 's3', state: 'blocked', note: 'git has no author identity' });

  const text = formatLedger(loadPlan(root).plan, { roundIndex: 8, maxRounds: 8 });
  assert.match(text, /OUTSTANDING — 2 of 3 steps asked for and not finished:/);
  assert.match(text, /\[todo\] s2 update README\.md/);
  assert.match(text, /\[blocked\] s3 git_commit — git has no author identity/);
  assert.match(text, /says nothing about whether the finished work is correct/);
  // The last line is the banner, wherever this text is surfaced.
  assert.equal(text.split('\n').pop(), 'plan: 1/3 done · 2 remaining: update README.md, git_commit (blocked) · round 8 of 8');

  const clean = formatLedger({ version: 1, task: 't', steps: [{ id: 's1', text: 'a', state: 'done' }] });
  assert.match(clean, /OUTSTANDING — none; every step was marked done\./);
});

test('⚠️ a corrupt plan file is quarantined and never blocks the run', () => {
  const root = ws();
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  writeFileSync(join(root, PLAN_FILE), '{"version":1,"task":"half a write');

  const loaded = loadPlan(root);
  assert.equal(loaded.ok, true, 'a corrupt file must never surface as an error');
  assert.equal(loaded.plan, null, 'corrupt is treated as absent');
  assert.match(loaded.quarantined, /^\.acuvo\/plan\.corrupt-.*\.json$/);
  assert.ok(readdirSync(join(root, '.acuvo')).some((f) => f.startsWith('plan.corrupt-')), 'the evidence was destroyed instead of moved aside');

  // …and a fresh start works immediately afterwards, which is the point.
  const started = planStart(root, { task: 'carry on', steps: ['a'] });
  assert.equal(started.ok, true);
  assert.equal(loadPlan(root).plan.task, 'carry on');
});

test('⚠️ JSON-shaped but wrong is corruption too', () => {
  for (const body of ['{"version":2,"task":"t","steps":[]}', '{"version":1,"task":"t","steps":"nope"}',
    '{"version":1,"task":"t","steps":[{"id":"nope","text":"a","state":"todo"}]}',
    '{"version":1,"task":"t","steps":[{"id":"s1","text":"a","state":"finished"}]}', '[]', 'null']) {
    const root = ws();
    mkdirSync(join(root, '.acuvo'), { recursive: true });
    writeFileSync(join(root, PLAN_FILE), body);
    assert.equal(loadPlan(root).plan, null, `${body} must not be accepted as a plan`);
  }
});

test('⚠️ nothing is written outside .acuvo/', () => {
  const root = ws();
  for (const bad of ['../outside.json', '/etc/passwd', 'C:/Windows/x.json', 'a/../../b.json']) {
    assert.equal(resolvePlanFile(root, bad).ok, false, `${bad} must be refused`);
  }
  // The prefix assertion is separate from the traversal rule — this path is
  // perfectly legal to `write_file` and still forbidden to this module.
  const sibling = resolvePlanFile(root, 'notes/plan.json');
  assert.equal(sibling.ok, false);
  assert.match(sibling.error, /only ever writes inside \.acuvo\//);
  assert.equal(resolvePlanFile(root).ok, true);
});

test('⚠️ a memory workspace is told it has no disk, not quietly humoured', () => {
  const r = planStart('(memory)', { task: 't', steps: ['a'] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'this workspace has no disk, so a plan cannot be persisted — track the remaining steps in your reply instead');
  assert.equal(planStep('(memory)', { id: 's1', state: 'done' }).ok, false);
  assert.equal(planStatus('(memory)').ok, false);
});

test('⚠️ a step that looks like a credential is refused, with the fix in the sentence', () => {
  const root = ws();
  const r = planStart(root, { task: 'wire the key', steps: ['set OPENROUTER_API_KEY=sk-or-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9', 'run it'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /^step 1 contains what looks like /);
  assert.match(r.error, /a plan is written to disk; do not put secrets in it/);
  assert.ok(!existsSync(join(root, PLAN_FILE)), 'a refused plan must not be written at all');

  // Notes go to the same disk, so they get the same rule.
  planStart(root, { task: 'ok', steps: ['a'] });
  assert.equal(planStep(root, { id: 's1', state: 'done', note: 'used ghp_abcdefghijklmnopqrstuvwxyz012345' }).ok, false);
  assert.equal(planStep(root, { id: 's1', state: 'done', note: 'used AKIAIOSFODNN7EXAMPLE' }).ok, false);
  assert.equal(loadPlan(root).plan.steps[0].state, 'todo', 'the refused call must not have changed state');

  // ⚠️ AND THE FALSE POSITIVE THAT WOULD MAKE THIS UNUSABLE. A long camelCase
  // identifier is the most ordinary thing a coding agent writes; refusing it
  // would train the model to stop planning.
  assert.equal(looksLikeSecret('implement authenticateUserWithCredentialsAndRefresh'), null);
  assert.equal(looksLikeSecret('rewrite lib/plan-ledger.mjs so the banner is deterministic'), null);
  assert.equal(planStart(ws(), { task: 't', steps: ['implement authenticateUserWithCredentialsAndRefreshToken'] }).ok, true);
});

test('⚠️ the step list is bounded', () => {
  const root = ws();
  const tooMany = planStart(root, { task: 't', steps: Array.from({ length: MAX_STEPS + 1 }, (_, i) => `s${i}`) });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /41 steps is more than the 40-step limit/);
  assert.equal(planStart(root, { task: 't', steps: Array.from({ length: MAX_STEPS }, (_, i) => `s${i}`) }).ok, true);

  const fresh = ws();
  assert.equal(planStart(fresh, { task: 't', steps: [] }).ok, false);
  assert.equal(planStart(fresh, { task: 't', steps: 'a, b, c' }).ok, false);
  assert.equal(planStart(fresh, { task: 't', steps: ['ok', 42] }).ok, false);
  assert.equal(planStart(fresh, { task: 't', steps: ['ok', '   '] }).ok, false);
  assert.equal(planStart(fresh, { task: 't', steps: ['x'.repeat(201)] }).ok, false);
  assert.equal(planStart(fresh, { task: '', steps: ['a'] }).ok, false);
  assert.ok(!existsSync(join(fresh, PLAN_FILE)));
});

test('⚠️ an unknown id or state is refused with what is actually valid', () => {
  const root = ws();
  planStart(root, { task: 't', steps: ['port utils.mjs', 'run the tests'] });

  const badId = planStep(root, { id: 's9', state: 'done' });
  assert.equal(badId.ok, false);
  assert.equal(badId.error, 'no step with id "s9" — the ids in this plan are: s1 port utils.mjs · s2 run the tests');

  const badState = planStep(root, { id: 's1', state: 'complete' });
  assert.equal(badState.ok, false);
  assert.match(badState.error, /state must be one of todo, doing, done, blocked/);

  // Marking against no plan at all points at plan_start rather than saying "try again".
  const empty = planStep(ws(), { id: 's1', state: 'done' });
  assert.match(empty.error, /call plan_start with the steps you intend to take/);
});

test('nothing is marked done on its own, and a done step can be reopened', () => {
  const root = ws();
  planStart(root, { task: 't', steps: ['write README.md'] });
  // The deliverable exists on disk. The ledger must not care — only an assertion
  // by the agent moves a step, because "a file with that name exists" is exactly
  // the inference that turns a ledger into a liar.
  writeFileSync(join(root, 'README.md'), '# hi');
  assert.equal(planStatus(root).steps[0].state, 'todo');
  assert.equal(outstanding(loadPlan(root).plan).length, 1);

  planStep(root, { id: 's1', state: 'done' });
  const reopened = planStep(root, { id: 's1', state: 'doing', note: 'the heading was wrong' });
  assert.equal(reopened.from, 'done');
  assert.equal(planStatus(root).outstanding.length, 1);
});

test('⚠️ two concurrent writers leave a parsable file, not an interleaving', async () => {
  const root = ws();
  planStart(root, { task: 'concurrency', steps: ['a', 'b'] });

  // Real processes. Synchronous fs calls cannot race inside one event loop, so
  // an in-process version of this test would pass without proving anything.
  // Resolved from THIS file, not from cwd — `node --test` can be run from
  // anywhere and a cwd-relative import would make the test pass or fail based
  // on where you typed it.
  const modUrl = new URL('../lib/plan-ledger.mjs', import.meta.url).href;
  const script = (tag) => `
    const m = await import(${JSON.stringify(modUrl)});
    const root = ${JSON.stringify(root)};
    for (let i = 0; i < 60; i++) {
      m.savePlan(root, { version: 1, task: ${JSON.stringify(tag)}, createdAt: new Date().toISOString(),
        steps: Array.from({ length: 30 }, (_, n) => ({ id: 's' + (n + 1), text: '${'x'.repeat(120)}', state: 'todo' })) });
    }
  `;
  const run = (tag) => new Promise((res, rej) =>
    execFile(process.execPath, ['--input-type=module', '-e', script(tag)], (e) => (e ? rej(e) : res())));
  await Promise.all([run('writer-A'), run('writer-B')]);

  const raw = readFileSync(join(root, PLAN_FILE), 'utf8');
  const parsed = JSON.parse(raw); // throws if the file was interleaved
  assert.ok(['writer-A', 'writer-B'].includes(parsed.task), `unexpected task ${parsed.task}`);
  assert.equal(parsed.steps.length, 30);
  assert.equal(loadPlan(root).plan.steps.length, 30);
  // No temp files survive a clean run — a stray .tmp would be quarantined as a
  // corrupt plan on the next load and confuse the evidence.
  assert.deepEqual(readdirSync(join(root, '.acuvo')).filter((f) => f.endsWith('.tmp')), []);
});

test('the three schemas match the three exported tools', () => {
  const schemas = planToolSchemas();
  assert.deepEqual(schemas.map((s) => s.function.name), ['plan_start', 'plan_step', 'plan_status']);
  for (const s of schemas) {
    assert.equal(s.type, 'function');
    assert.equal(typeof s.function.description, 'string');
    assert.equal(s.function.parameters.type, 'object');
  }
  assert.deepEqual(schemas[0].function.parameters.required, ['task', 'steps']);
  assert.deepEqual(schemas[1].function.parameters.required, ['id', 'state']);
  assert.deepEqual(schemas[2].function.parameters.required, []);
  // The description has to teach the behaviour the wiring cannot: done is asserted.
  assert.match(schemas[1].function.description, /Mark it done only when the deliverable actually exists/);
});

test('savePlan reports a failure as data rather than throwing', () => {
  const bad = savePlan('C:/definitely/not/a/real/workspace/xyzzy', { version: 1, task: 't', steps: [] });
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.error, 'string');
});

/**
 * ── ⚠️⚠️ A STATUS LINE THAT NAMES NO ACTION PRODUCES NO ACTION ──────────────
 *
 * MEASURED on a real 8-round run building a landing page: the model called
 * `plan_start`, did the work, and printed `plan: 0/3 done · 3 remaining` on
 * EVERY SINGLE ROUND. It never called `plan_step` once — eight rounds of a
 * countdown that never counted, costing tokens per round and telling the model
 * nothing it could act on.
 *
 * ⭐ Same fix as a good refusal: name the verb. A refusal that says only "not
 * allowed" costs a round because there is nothing to do differently; "0/3 done"
 * is that mistake wearing a friendlier face.
 */
test('⚠️⚠️ while NOTHING is marked, the banner names the verb and the real arguments', () => {
  const plan = { steps: [
    { id: 's1', text: 'Generate a hero image', state: 'todo' },
    { id: 's2', text: 'Write the HTML', state: 'todo' },
  ] };
  const line = formatBanner(plan, { round: 2, maxRounds: 8 });
  assert.match(line, /plan_step/, 'the model has to be told WHICH tool advances the plan');
  /**
   * ⚠️ THE ARGUMENT NAMES ARE ASSERTED AGAINST THE SCHEMA, not typed out. My
   * first draft suggested `{"step":1,...}` when the tool requires `{"id":"s1"}`
   * — an instruction that would have been REFUSED, which is worse than silence:
   * it spends a round AND teaches a shape that cannot work.
   */
  const schema = planToolSchemas().find((t) => t.function.name === 'plan_step');
  for (const required of schema.function.parameters.required) {
    assert.match(line, new RegExp(`"${required}"`), `the nudge omits the required argument "${required}"`);
  }
  assert.match(line, /"s1"/, 'quoting a REAL id beats a placeholder the model has to translate');
});

test('⭐ the nudge disappears the moment one step is marked', () => {
  const plan = { steps: [
    { id: 's1', text: 'Generate a hero image', state: 'done' },
    { id: 's2', text: 'Write the HTML', state: 'todo' },
  ] };
  const line = formatBanner(plan, { round: 3, maxRounds: 8 });
  assert.equal(/plan_step/.test(line), false, 'a reminder that keeps nagging after it was understood is noise');
  assert.match(line, /1\/2 done/);
});
