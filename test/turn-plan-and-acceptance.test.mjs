/**
 * ── THE TWO THINGS THAT PLUG INTO THE LOOP ITSELF ───────────────────────────
 *
 * `plan-ledger.mjs` and `acceptance.mjs` were finished, documented and tested,
 * and imported by nothing. Their own suites prove the modules work. This one
 * proves they are REACHED — that a real `runSession` puts the countdown in front
 * of the model, and that a real verdict is about the command the user named.
 *
 * ⚠️ EVERY TEST HERE WAS MUTATED AND WATCHED GO RED before it was kept. The
 * repo's own rule, learned four times: a check that passes against broken code
 * is worse than no check, and the only way to know is to break the code.
 *
 * ── ⚠️⚠️ THE ONE INVARIANT THAT MATTERS MOST ────────────────────────────────
 * The acceptance layer may only ever make the verdict STRICTER. `never turns a
 * NOT-VERIFIED into a VERIFIED` below pins that direction explicitly, across
 * every verdict shape the module can produce — because the failure mode of a
 * "more honest verdict" feature is that it quietly becomes a way to pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runSession, planBannerFor, resolveAcceptance, formatSummary, sessionFailed, renderEvent, systemPrompt,
} from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { trustAuthoredCriteria } from '../lib/acceptance-consent.mjs';

/* ────────────────────────────────────────────────────────────────────────────
 * fixtures
 * ──────────────────────────────────────────────────────────────────────────── */

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-wire-turn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A plan on disk, exactly as `plan_start` writes it. */
function writePlan(dir, steps) {
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  writeFileSync(join(dir, '.acuvo', 'plan.json'), `${JSON.stringify({
    version: 1,
    task: 'port the callbacks and then commit',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps,
  }, null, 2)}\n`, 'utf8');
}

/**
 * A declaration on disk, exactly as `declare_acceptance` writes it — INCLUDING
 * the consent that verb records.
 *
 * ⚠️⚠️ THE TRUST HALF IS NOT SCAFFOLDING, IT IS THE THING BEING MODELLED. A
 * workspace acceptance file is now gated: a cloned repository shipping one was
 * proven able to run `node payload.js` and have it reported as `✔ MET` (see
 * lib/acceptance-consent.mjs). Criteria the user's own session AUTHORED are
 * trusted at the moment they are written, which is why the ordinary path never
 * prompts — so a helper that writes the bytes and skips the trust is modelling
 * a file that arrived from somewhere else, and these tests are not about that
 * case. The refusal itself is pinned in test/acceptance-consent.test.mjs.
 *
 * ⭐ `ACUVO_TRUST_DIR` points the store at the temp workspace: a test must never
 * write into the real user's home, and an isolated store also means one test
 * cannot silently approve criteria for another.
 */
function writeAcceptance(dir, criteria) {
  process.env.ACUVO_TRUST_DIR = dir;
  trustAuthoredCriteria(criteria, { root: dir });
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  writeFileSync(join(dir, '.acuvo', 'acceptance.json'), `${JSON.stringify({
    version: 1,
    declaredAt: new Date().toISOString(),
    criteria,
  }, null, 2)}\n`, 'utf8');
}

/** A model that answers instantly and asks for nothing. */
const SILENT_MODEL = async () => ({ ok: true, content: 'nothing to do', toolCalls: [], usage: null, finishReason: 'stop' });

/** A model that spends round 1 on a read and then stops — two real rounds. */
function twoRoundModel() {
  let round = 0;
  return async () => {
    round += 1;
    if (round === 1) {
      return {
        ok: true,
        content: 'looking first',
        toolCalls: [{ id: 'c1', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
        usage: null,
        finishReason: 'tool_calls',
      };
    }
    return { ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' };
  };
}

/** A tool record in the shape the loop pushes into `executed`. */
const ran = (command, exitCode) => ({
  id: null, name: 'run_command', args: { command },
  result: { ok: true, command, exitCode, passed: exitCode === 0, stdout: 'x', stderr: '', timedOut: false },
  mutated: false,
});

/* ────────────────────────────────────────────────────────────────────────────
 * (1) THE PLAN BANNER
 * ──────────────────────────────────────────────────────────────────────────── */

test('no plan on disk ⇒ no banner, so a run that never planned is unchanged', (t) => {
  const dir = workspace(t);
  assert.equal(planBannerFor(createLocalExecutor(dir), { roundIndex: 2, maxRounds: 3 }), null);
});

test('a recorded plan becomes one line with the countdown in it', (t) => {
  const dir = workspace(t);
  writePlan(dir, [
    { id: 's1', text: 'port index.js', state: 'done' },
    { id: 's2', text: 'update README.md', state: 'todo' },
    { id: 's3', text: 'git_commit', state: 'todo' },
  ]);
  const banner = planBannerFor(createLocalExecutor(dir), { roundIndex: 6, maxRounds: 8 });
  assert.match(banner, /^plan: 1\/3 done · 2 remaining: update README\.md, git_commit · round 6 of 8$/);
});

test('⚠️ a DRY RUN reads no plan — the flag promises to touch nothing, and loadPlan can rename', (t) => {
  const dir = workspace(t);
  writePlan(dir, [{ id: 's1', text: 'a step', state: 'todo' }]);
  const executor = createLocalExecutor(dir, { dryRun: true });
  assert.equal(planBannerFor(executor, { roundIndex: 1, maxRounds: 3 }), null);
});

test('the banner reaches the MODEL — one message per round, with that round\'s number', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'index.js'), 'export const x = 1;\n');
  writePlan(dir, [
    { id: 's1', text: 'port index.js', state: 'done' },
    { id: 's2', text: 'git_commit', state: 'todo' },
  ]);
  const events = [];
  const outcome = await runSession({
    task: 'finish the port',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: 2,
    allowRun: false,
    onEvent: (e) => events.push(e),
    callModelImpl: twoRoundModel(),
  });
  assert.equal(outcome.ok, true);

  const banners = outcome.messages.filter((m) => m.role === 'user' && String(m.content).startsWith('plan:'));
  assert.equal(banners.length, 2, 'one banner per round');
  assert.match(banners[0].content, /round 1 of 2/);
  assert.match(banners[1].content, /round 2 of 2/);
  assert.match(banners[1].content, /1 remaining: git_commit/);

  // ⚠️ APPENDED, NEVER INSERTED. The system message and the workspace context
  // are the cacheable prefix; a banner that landed before them would throw away
  // the 97.2% cache hit this loop is built around.
  assert.equal(outcome.messages[0].role, 'system');
  assert.equal(outcome.messages[1].role, 'user');
  assert.ok(!String(outcome.messages[1].content).startsWith('plan:'));

  // And the human watching the loop sees it too.
  const planEvents = events.filter((e) => e.type === 'plan');
  assert.equal(planEvents.length, 2);
  assert.match(renderEvent(planEvents[0]).join('\n'), /plan: 1\/2 done/);
});

test('⚠️ FAIL-SAFE: without a plan the conversation is exactly what it is today', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'index.js'), 'export const x = 1;\n');
  const outcome = await runSession({
    task: 'finish the port',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: 2,
    allowRun: false,
    callModelImpl: twoRoundModel(),
  });
  assert.equal(outcome.messages.filter((m) => String(m.content).startsWith('plan:')).length, 0);
  assert.equal(outcome.messages[0].role, 'system');
  assert.equal(outcome.messages[1].role, 'user');
  assert.equal(outcome.messages[2].role, 'assistant');
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2) THE ACCEPTANCE GATE
 * ──────────────────────────────────────────────────────────────────────────── */

test('a criterion in the user\'s own words is judged against the command they named', async (t) => {
  const dir = workspace(t);
  const got = await resolveAcceptance({
    task: 'Port the module. It MUST pass: npm test',
    executor: createLocalExecutor(dir),
    // probe 1 run 1, exactly: a different command, green, and not the one asked for.
    executed: [ran('node --test test/api.test.js', 0)],
    allowRun: false,
  });
  assert.equal(got.source, 'derived');
  assert.equal(got.gating, false, 'a criterion read out of prose must never fail the process');
  assert.equal(got.verdict.verdict, 'unmet');
  assert.deepEqual(got.verdict.unmet, [{ command: 'npm test', why: 'it was never run' }]);
  assert.ok(got.verdict.incidental.includes('node --test test/api.test.js'));
});

test('the same command, actually run and green, is MET — no false gate', async (t) => {
  const dir = workspace(t);
  const got = await resolveAcceptance({
    task: 'Refactor it. `npm test` must pass.',
    executor: createLocalExecutor(dir),
    executed: [ran('npm test', 0)],
    allowRun: false,
  });
  assert.equal(got.verdict.verdict, 'met');
  assert.equal(sessionFailed({ ok: true, verification: { ran: true, passed: true }, acceptance: got }), false);
});

test('a task that names no criterion produces none — most runs print nothing new', async (t) => {
  const dir = workspace(t);
  const got = await resolveAcceptance({
    task: 'add a health endpoint',
    executor: createLocalExecutor(dir),
    executed: [ran('node check.mjs', 0)],
    allowRun: false,
  });
  assert.equal(got, null);
});

test('⚠️ an `evaluate` snippet can never satisfy anything — three of four false ticks came from one', async (t) => {
  const dir = workspace(t);
  const got = await resolveAcceptance({
    task: 'Make sure `npm test` passes.',
    executor: createLocalExecutor(dir),
    executed: [{ id: null, name: 'evaluate', args: {}, result: { ok: true, exitCode: 0, passed: true }, mutated: false }],
    allowRun: false,
  });
  assert.equal(got.verdict.verdict, 'unmet');
  assert.ok(formatSummary({
    ok: true, executed: [], verification: { ran: false, passed: null }, acceptance: got, model: 'm', usage: null,
  }).join('\n').includes('scratch snippet'));
});

test('⭐ A DECLARED criterion GATES the exit code, and an undeclared one does not', async (t) => {
  const dir = workspace(t);
  writeAcceptance(dir, [{ command: 'npm test', runnable: true, reason: null }]);
  const declared = await resolveAcceptance({
    task: 'do the thing',
    executor: createLocalExecutor(dir),
    executed: [ran('node --test test/api.test.js', 0)],
    // ⚠️ allowRun false: this test is about the GATE, not about the free re-run.
    allowRun: false,
  });
  assert.equal(declared.source, 'declared');
  assert.equal(declared.gating, true);
  assert.equal(declared.verdict.verdict, 'unmet');

  // probe 4 run 2: exit 0 with verification.passed true, on a run that dropped
  // what was asked. `acuvo … && git push` would have pushed it.
  const outcome = { ok: true, verification: { ran: true, passed: true }, acceptance: declared };
  assert.equal(sessionFailed(outcome), true, 'a declared criterion that did not pass must fail the process');
  assert.equal(sessionFailed({ ...outcome, acceptance: { ...declared, gating: false } }), false);
});

test('⭐ a declared criterion nobody ran is RUN once, free, and its real exit code decides', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'red.mjs'), 'process.stdout.write("boom\\n"); process.exit(1);\n');
  writeAcceptance(dir, [{ command: 'node red.mjs', runnable: true, reason: null }]);

  const events = [];
  const got = await resolveAcceptance({
    task: 'do the thing',
    executor: createLocalExecutor(dir),
    executed: [],
    allowRun: true,
    commandTimeoutMs: 30_000,
    onEvent: (e) => events.push(e),
  });
  assert.equal(got.verdict.verdict, 'unmet');
  assert.deepEqual(got.verdict.unmet, [{ command: 'node red.mjs', why: 'it ran and exited 1' }]);
  assert.ok(events.some((e) => e.type === 'acceptance-check'), 'the extra run is announced, never silent');
});

test('⭐ …and a declared criterion that passes when run clears, rather than failing on a technicality', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'green.mjs'), 'process.stdout.write("ok\\n");\n');
  writeAcceptance(dir, [{ command: 'node green.mjs', runnable: true, reason: null }]);
  const got = await resolveAcceptance({
    task: 'do the thing',
    executor: createLocalExecutor(dir),
    executed: [],
    allowRun: true,
    commandTimeoutMs: 30_000,
  });
  assert.equal(got.verdict.verdict, 'met');
  assert.equal(sessionFailed({ ok: true, verification: { ran: false, passed: null }, acceptance: got }), false);
});

test('⚠️ a dry run declares a verdict but starts no process', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'red.mjs'), 'process.exit(1);\n');
  writeAcceptance(dir, [{ command: 'node red.mjs', runnable: true, reason: null }]);
  const events = [];
  const got = await resolveAcceptance({
    task: 'do the thing',
    executor: createLocalExecutor(dir, { dryRun: true }),
    executed: [],
    allowRun: true,
    onEvent: (e) => events.push(e),
  });
  assert.equal(got.verdict.verdict, 'not-run');
  assert.equal(events.length, 0, '--dry-run runs nothing, including our own criterion');
});

test('⚠️ a corrupt acceptance.json is NOT A VERDICT — and it does not fail the run either', async (t) => {
  const dir = workspace(t);
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  writeFileSync(join(dir, '.acuvo', 'acceptance.json'), '{ not json', 'utf8');
  const got = await resolveAcceptance({
    task: 'do the thing',
    executor: createLocalExecutor(dir),
    executed: [ran('node x.mjs', 0)],
    allowRun: false,
  });
  assert.equal(got.verdict.verdict, 'unrunnable');
  assert.equal(got.gating, false);
  assert.equal(sessionFailed({ ok: true, verification: { ran: true, passed: true }, acceptance: got }), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) THE DIRECTION — the invariant the whole change lives or dies on
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ acceptance NEVER turns a NOT-VERIFIED into a VERIFIED, whatever it says', () => {
  const verdicts = [
    null,
    { source: 'derived', gating: false, criteria: [], verdict: { verdict: 'met', criteria: [{ command: 'npm test', satisfied: true }], unmet: [], incidental: [] } },
    { source: 'declared', gating: true, criteria: [], verdict: { verdict: 'met', criteria: [{ command: 'npm test', satisfied: true }], unmet: [], incidental: [] } },
    { source: 'declared', gating: true, criteria: [], verdict: { verdict: 'none-declared', criteria: [], unmet: [], incidental: [] } },
    { source: 'declared', gating: true, criteria: [], verdict: { verdict: 'unrunnable', reason: 'no', criteria: [{}], unmet: [], incidental: [] } },
    { source: 'declared', gating: true, criteria: [], verdict: { verdict: 'unmet', criteria: [], unmet: [{ command: 'npm test', why: 'it was never run' }], incidental: [] } },
  ];
  const red = { ok: true, verification: { ran: true, passed: false, command: 'npm test', exitCode: 1, attempts: 1, failingCommands: ['npm test'] } };
  for (const acceptance of verdicts) {
    assert.equal(sessionFailed({ ...red, acceptance }), true, `a failing run stayed failing (${acceptance?.verdict?.verdict ?? 'none'})`);
    const text = formatSummary({ ...red, acceptance, executed: [], model: 'm', usage: null, stoppedBecause: 'round-cap', maxRounds: 3 }).join('\n');
    assert.ok(!text.includes('✔ VERIFIED'), 'nothing may print a tick over a failing run');
    assert.ok(text.includes('✖ NOT VERIFIED'), 'the existing verdict survives untouched');
  }

  // And a model failure stays a failure no matter what was declared.
  assert.equal(sessionFailed({ ok: false, stage: 'model', error: 'x', acceptance: verdicts[2] }), true);
});

test('⚠️ a green tick about the WRONG command is qualified in place, not deleted', async (t) => {
  const dir = workspace(t);
  const acceptance = await resolveAcceptance({
    task: 'Port it. It MUST pass: npm test',
    executor: createLocalExecutor(dir),
    executed: [ran('node --test test/api.test.js', 0)],
    allowRun: false,
  });
  const text = formatSummary({
    ok: true,
    executed: [],
    model: 'm',
    usage: null,
    verification: { ran: true, passed: true, command: 'node --test test/api.test.js', exitCode: 0, attempts: 1, silent: false },
    acceptance,
  }).join('\n');

  // The fact stays — it is true.
  assert.ok(text.includes('✔ VERIFIED — `node --test test/api.test.js` exited 0.'));
  // …and it can no longer be read as the answer to the question that was asked.
  assert.ok(text.includes('that is not what was asked for'));
  assert.ok(text.includes('✖ UNMET — you asked that `npm test` pass'));
  assert.ok(text.includes('does not change the exit code'));
});

/* ────────────────────────────────────────────────────────────────────────────
 * (4) THE FALSE CLAIM IN THE SYSTEM PROMPT
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️ the prompt no longer tells the model something untrue about its rivals', () => {
  const prompt = systemPrompt({ maxRounds: 4, allowRun: true, offeredNames: ['see_page', 'run_command'] });
  // Playwright MCP and Chrome DevTools MCP are one install away. The model
  // repeats a system-prompt claim to users as fact, so this one had to go.
  assert.ok(!/no other terminal agent/i.test(prompt), 'the false claim is gone');
  // Replaced with the true and more useful fact: looking is cheap.
  assert.match(prompt, /see_page/);
  assert.match(prompt, /89 tokens/);
  assert.match(prompt, /3,072-token/);
});
