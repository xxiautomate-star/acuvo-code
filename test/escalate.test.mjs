/**
 * ── THE LADDER'S TESTS ─────────────────────────────────────────────────────
 *
 * Every one of these asserts a RULE from `escalate.mjs`'s header, and every one
 * was checked by deleting the rule and watching it go red — the discipline this
 * package adopted after a suite of 1,420 green tests turned out to have zero
 * coverage of the CLI's success path.
 *
 * ⚠️ COSTS $0.00. No model, no network, no clock. `runOne` is a stub that
 * returns whatever the test needs, `bestOf` is injected, and the budget is a
 * real `createBudget()` because faking the one collaborator whose arithmetic
 * decides the spending would test nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  escalate,
  projectTierCost,
  nextTier,
  freshBriefing,
  defaultVerified,
  formatEscalation,
  allocate,
  blockedBy,
  outOfRoad,
  OUT_OF_ROAD,
  TIERS,
  FRESH_MULTIPLIER,
  MIN_PROJECTION_USD,
} from '../lib/escalate.mjs';
import { createBudget } from '../lib/budget.mjs';
import { sessionFailed } from '../lib/turn.mjs';
import { BUDGET_REASONS } from '../lib/budget.mjs';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';

const CLI = fileURLToPath(new URL('../bin/acuvo.mjs', import.meta.url));
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** An outcome shaped like the real `runSession` returns. */
function outcome({ verified = false, cost = 0.001, error = null } = {}) {
  return {
    ok: error === null,
    error,
    stoppedBecause: verified ? 'verified' : 'rounds',
    usage: { cost },
    executed: [],
  };
}

/** A budget with room for everything. */
function openBudget() { return createBudget({ limitUsd: 100 }); }

// ── rule: the cheap rung wins early and costs nothing extra ─────────────────

test('verifying at the first rung never escalates', async () => {
  const calls = [];
  const r = await escalate({
    root: '/tmp/x',
    task: 'make it green',
    budget: openBudget(),
    runOne: async ({ tier }) => { calls.push(tier); return outcome({ verified: true, cost: 0.002 }); },
    bestOf: async () => { throw new Error('best-of must not be reached when solo verified'); },
  });

  assert.equal(r.ok, true);
  assert.equal(r.stopped, 'verified');
  assert.equal(r.tier, 'solo');
  assert.deepEqual(calls, ['solo']);
  assert.equal(r.rungs.length, 1);
  assert.equal(r.spentUsd, 0.002);
});

// ── rule: fresh carries the FAILURE, not the transcript ────────────────────

test('the fresh rung is briefed with the failure and never the transcript', async () => {
  const seen = [];
  await escalate({
    root: '/tmp/x',
    task: 'fix the parser',
    budget: openBudget(),
    maxTier: 'fresh',
    runOne: async ({ task, tier }) => {
      seen.push({ tier, task });
      return {
        ...outcome({ verified: false, cost: 0.001 }),
        stoppedBecause: 'rounds',
        acceptance: { passed: false, failing: [{ command: 'npm test' }] },
      };
    },
  });

  assert.equal(seen.length, 2, 'solo then fresh');
  assert.equal(seen[0].task, 'fix the parser', 'the first rung gets the task verbatim');

  const briefing = seen[1].task;
  assert.match(briefing, /fix the parser/, 'the task survives into the fresh context');
  assert.match(briefing, /npm test/, 'the failing check is carried across');
  assert.match(briefing, /clean context/, 'and it is told that is what happened');
  assert.doesNotMatch(briefing, /assistant|tool_call|round 1/i, 'the transcript is NOT carried');
});

test('freshBriefing with nothing learned is exactly the task', () => {
  assert.equal(freshBriefing('do the thing', null), 'do the thing');
  assert.equal(freshBriefing('do the thing', {}), 'do the thing');
});

// ── rule 2: the projection is measured, not a constant ─────────────────────

test('best-of is projected at N times the last attempt, not a flat number', () => {
  const last = 0.004;
  assert.equal(projectTierCost('best-of', { lastAttemptUsd: last, attempts: 3 }), last * 3);
  assert.equal(projectTierCost('best-of', { lastAttemptUsd: last, attempts: 5 }), last * 5);
  assert.notEqual(
    projectTierCost('best-of', { lastAttemptUsd: last, attempts: 3 }),
    projectTierCost('best-of', { lastAttemptUsd: last, attempts: 5 }),
    'a projection that ignores the attempt count is the flat lie this rule exists to stop',
  );
  assert.equal(projectTierCost('fresh', { lastAttemptUsd: last }), last * FRESH_MULTIPLIER);
});

test('a free first attempt still projects above zero', () => {
  // A cache hit or an instant refusal can cost ~$0. Projecting $0 would wave
  // through a rung the budget cannot actually pay for.
  assert.equal(projectTierCost('solo', { lastAttemptUsd: 0 }), MIN_PROJECTION_USD);
  assert.ok(projectTierCost('best-of', { lastAttemptUsd: 0, attempts: 3 }) > 0);
});

test('projectTierCost refuses a tier it does not know', () => {
  assert.throws(() => projectTierCost('telepathy', {}), /unknown tier/);
});

// ── rules 1 + 3: never enter a rung you cannot finish, and SAY you skipped ──

test('an unaffordable rung is skipped, named, and never started', async () => {
  const calls = [];
  // $0.003 of headroom; one solo attempt eats $0.0025, so best-of at 3x cannot fit.
  const budget = createBudget({ limitUsd: 0.003 });
  const r = await escalate({
    root: '/tmp/x',
    task: 'hard thing',
    budget,
    maxTier: 'fresh',
    runOne: async ({ tier }) => {
      calls.push(tier);
      const o = outcome({ verified: false, cost: 0.0025 });
      budget.record({ cost: 0.0025 });
      return o;
    },
  });

  assert.equal(r.ok, false);
  assert.equal(r.stopped, 'budget', 'stopping for money is not the same verdict as failing');
  assert.deepEqual(calls, ['solo'], 'the unaffordable rung was never entered');
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].tier, 'fresh', 'the skipped rung is named');
  assert.ok(r.skipped[0].projectedUsd > r.skipped[0].remainingUsd, 'and both numbers are reported');
  assert.match(r.skipped[0].why, /budget is left/);
});

test('stopping on budget is distinguishable from exhausting the ladder', async () => {
  const budget = openBudget();
  const r = await escalate({
    root: '/tmp/x',
    task: 'hard thing',
    budget,
    maxTier: 'fresh',
    runOne: async () => outcome({ verified: false, cost: 0.001 }),
  });
  assert.equal(r.stopped, 'exhausted');
  assert.equal(r.skipped.length, 0, 'nothing was skipped — everything affordable was tried');
  assert.equal(r.rungs.length, 2);
});

// ── rule 4: a crash is not a rung ──────────────────────────────────────────

test('a thrown error ends the ladder without consuming an escalation', async () => {
  const calls = [];
  const r = await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: openBudget(),
    runOne: async ({ tier }) => { calls.push(tier); throw new Error('ECONNRESET'); },
  });

  assert.equal(r.ok, false);
  assert.equal(r.stopped, 'crashed');
  assert.match(r.error, /ECONNRESET/);
  assert.deepEqual(calls, ['solo'], 'a flaky connection must not buy the expensive rung');
  assert.equal(r.rungs.length, 0, 'a crash is not evidence the approach was wrong');
});

// ── the top rung actually reaches best-of.mjs ──────────────────────────────

test('the top rung calls best-of with the attempt count and applies its winner', async () => {
  const tiers = [];
  let bestOfArgs = null;
  const r = await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: openBudget(),
    attempts: 4,
    runOne: async ({ tier }) => { tiers.push(tier); return outcome({ verified: false, cost: 0.001 }); },
    bestOf: async (args) => {
      bestOfArgs = args;
      return {
        ok: true,
        attempts: args.attempts,
        winner: outcome({ verified: true, cost: 0.004 }),
        totalCost: 0.012,
        scored: [],
        applied: ['src/a.js'],
      };
    },
  });

  assert.equal(bestOfArgs.attempts, 4, 'the attempt count reaches best-of.mjs');
  assert.equal(typeof bestOfArgs.runOne, 'function');
  assert.equal(typeof bestOfArgs.failed, 'function');
  assert.equal(bestOfArgs.failed(outcome({ verified: true })), false, 'best-of scores by OUR verified()');
  assert.equal(bestOfArgs.failed(outcome({ verified: false })), true);

  assert.equal(r.ok, true);
  assert.equal(r.tier, 'best-of');
  assert.deepEqual(tiers, ['solo', 'fresh'], 'both cheap rungs ran first');
  assert.ok(r.spentUsd >= 0.012, 'the whole best-of spend is counted, not just the winner');
});

test("best-of refusing to start is a skip, never a failed attempt", async () => {
  const r = await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: openBudget(),
    runOne: async () => outcome({ verified: false, cost: 0.001 }),
    bestOf: async () => ({ ok: false, error: 'this workspace holds more than 256MB of files' }),
  });

  assert.equal(r.rungs.length, 2, 'solo and fresh ran; best-of never did');
  assert.ok(!r.rungs.some((x) => x.tier === 'best-of'), 'a rung that never started is not an attempt');
  assert.equal(r.skipped.at(-1).tier, 'best-of');
  assert.match(r.skipped.at(-1).why, /256MB/, 'the real reason survives to the caller');
});

// ── the allocation: without it the ladder is decorative ────────────────────

test('the budget is divided across rungs, never handed whole to the first', () => {
  const a = allocate(2.00, { maxTier: 'best-of', attempts: 3 });
  const total = a.solo + a.fresh + a['best-of'];

  assert.ok(Math.abs(total - 2.00) < 1e-9, 'the slices sum to the budget, never more');
  assert.ok(a.solo < 2.00, 'the first rung cannot be entitled to the whole budget');
  assert.ok(a.solo < a.fresh, 'and it gets less than the rung above it');
  assert.ok(a.fresh < a['best-of'], 'which gets less than the most expensive rung');
  // 1 : 1.4 : 3  →  solo is 1/5.4 ≈ 18.5%
  assert.ok(a.solo / 2.00 > 0.15 && a.solo / 2.00 < 0.22, `solo share was ${(a.solo / 2).toFixed(3)}`);
});

test('the allocation follows maxTier and the attempt count', () => {
  const capped = allocate(1.00, { maxTier: 'fresh', attempts: 3 });
  assert.equal(capped['best-of'], undefined, 'a rung above the ceiling gets no money');
  assert.ok(Math.abs(capped.solo + capped.fresh - 1.00) < 1e-9);
  assert.ok(capped.solo > allocate(1.00, { maxTier: 'best-of', attempts: 3 }).solo,
    'a shorter ladder leaves more for each rung');

  const five = allocate(1.00, { maxTier: 'best-of', attempts: 5 });
  const three = allocate(1.00, { maxTier: 'best-of', attempts: 3 });
  assert.ok(five.solo < three.solo, 'more parallel attempts reserves more away from the cheap rung');
});

test('no budget means no allocation and no cap', () => {
  assert.deepEqual(allocate(null), {});
  assert.deepEqual(allocate(0), {});
});

test('each rung is handed its own slice, and best-of splits its slice N ways', async () => {
  const handed = [];
  let bestOfInner = null;
  await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: createBudget({ limitUsd: 2.00 }),
    attempts: 3,
    runOne: async ({ tier, budgetUsd }) => {
      handed.push({ tier, budgetUsd });
      return outcome({ verified: false, cost: 0.001 });
    },
    bestOf: async (args) => {
      await args.runOne({ root: '/tmp/copy', label: 'attempt 1/3' });
      bestOfInner = handed.at(-1);
      return { ok: true, attempts: 3, winner: outcome({ verified: true }), totalCost: 0.01, scored: [] };
    },
  });

  const solo = handed.find((h) => h.tier === 'solo');
  const fresh = handed.find((h) => h.tier === 'fresh');
  assert.ok(solo.budgetUsd > 0 && solo.budgetUsd < 2.00, 'solo is capped below the total');
  assert.ok(fresh.budgetUsd > solo.budgetUsd);
  assert.ok(
    bestOfInner.budgetUsd < fresh.budgetUsd,
    'a single best-of attempt gets a THIRD of that rung, not the whole rung — otherwise $2 becomes $6',
  );
});

test('no --budget hands every rung undefined rather than inventing a cap', async () => {
  const handed = [];
  await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: createBudget({}),
    maxTier: 'fresh',
    runOne: async ({ tier, budgetUsd }) => {
      handed.push({ tier, budgetUsd });
      return outcome({ verified: false, cost: 0.001 });
    },
  });
  assert.equal(handed[0].budgetUsd, undefined, 'a user who set no ceiling gets no ceiling');
  assert.equal(handed[1].budgetUsd, undefined);
});

// ── the ceiling ────────────────────────────────────────────────────────────

test('maxTier caps the ladder', () => {
  assert.equal(nextTier('solo', { maxTier: 'best-of' }), 'fresh');
  assert.equal(nextTier('fresh', { maxTier: 'best-of' }), 'best-of');
  assert.equal(nextTier('best-of', { maxTier: 'best-of' }), null);
  assert.equal(nextTier('solo', { maxTier: 'solo' }), null, 'a ceiling of solo means no escalation at all');
  assert.throws(() => nextTier('solo', { maxTier: 'nonsense' }), /unknown maxTier/);
});

test('TIERS is ordered cheapest first and nextTier walks it', () => {
  assert.deepEqual([...TIERS], ['solo', 'fresh', 'best-of']);
});

// ── the strict definition of "it worked" ───────────────────────────────────

test('only a verified stop counts as verified', () => {
  assert.equal(defaultVerified(outcome({ verified: true })), true);
  assert.equal(defaultVerified(outcome({ verified: false })), false);
  assert.equal(defaultVerified({ ok: false, stoppedBecause: 'verified' }), false);
  assert.equal(defaultVerified(null), false);
  assert.equal(
    defaultVerified({ ok: true, stoppedBecause: 'verified', acceptance: { passed: false } }),
    false,
    'a declared criterion that did not pass outranks the loop saying it stopped happy',
  );
});

// ── rule 5: a failure that repeats identically must not be escalated ───────

test('an unusable key stops the ladder instead of failing three times', async () => {
  const calls = [];
  const r = await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: openBudget(),
    runOne: async ({ tier }) => {
      calls.push(tier);
      return { ok: false, error: 'no OPENROUTER_API_KEY is set', usage: { cost: 0 }, executed: [] };
    },
  });

  assert.equal(r.stopped, 'blocked');
  assert.match(r.why, /API key/);
  assert.deepEqual(calls, ['solo'], 'the identical failure was not bought twice more');
  assert.match(formatEscalation(r), /Every rung would fail the same way/);
});

test('blockedBy names the machine conditions and nothing else', () => {
  assert.match(blockedBy({ error: 'HTTP 401 invalid api key' }), /key/);
  assert.match(blockedBy({ error: 'the balance is exhausted' }), /cannot pay/);
  assert.match(blockedBy({ error: "OpenRouter does not serve that model (HTTP 404)" }), /model/);
  assert.match(blockedBy({ error: 'EACCES: permission denied' }), /written to/);

  // ⚠️ The important half: ordinary task failure MUST still escalate.
  assert.equal(blockedBy({ error: 'the tests did not pass' }), null);
  assert.equal(blockedBy({ error: 'ran out of rounds' }), null);
  assert.equal(blockedBy({ ok: true }), null);
  assert.equal(blockedBy(null), null);
});

// ── ⭐⭐ THE BUG THE UNIT TESTS MISSED, NOW PINNED ──────────────────────────

/**
 * ⚠️ THIS IS THE REGRESSION TEST FOR A REAL $0.0016 RUN. Every test above was
 * green while the feature was, in the binary, completely disabled: the wiring
 * used `!sessionFailed()` as its definition of success, and that function does
 * not fail a run which verified nothing — so a session cut off by its budget
 * read as a pass and the ladder never climbed. The unit tests could not see it
 * because they inject their own `verified`. This one asserts the PREDICATE.
 */
/**
 * ⚠️⚠️ THE TEST THAT WOULD HAVE SAVED THE SECOND $0.0018. `OUT_OF_ROAD` names
 * strings that live in ANOTHER module, and the first version invented three of
 * its four. So this reads what `turn.mjs` actually assigns and checks against
 * that — a constant naming another file's strings is a guess until something
 * compares them.
 */
test('every out-of-road value is one turn.mjs actually assigns', () => {
  const src = readFileSync(new URL('../lib/turn.mjs', import.meta.url), 'utf8');
  const assigned = new Set([...src.matchAll(/stoppedBecause = '([a-z-]+)'/g)].map((m) => m[1]));
  // `stoppedBecause = affordable.reason` routes budget.mjs's reasons through
  // the same field, so those are legitimate too.
  for (const r of BUDGET_REASONS) assigned.add(r);

  assert.ok(assigned.size >= 5, `only found ${assigned.size} assignments — the regex has rotted`);
  for (const value of OUT_OF_ROAD) {
    assert.ok(assigned.has(value), `OUT_OF_ROAD names "${value}", which turn.mjs never sets`);
  }
  // And the two verdicts that never stop anything must NOT be in the list.
  assert.equal(OUT_OF_ROAD.includes('ok'), false);
  assert.equal(OUT_OF_ROAD.includes('no-budget-set'), false);
  assert.equal(OUT_OF_ROAD.includes('verified'), false);
});

test('a run cut off by budget or rounds is out of road, not a success', () => {
  assert.equal(outOfRoad({ stoppedBecause: 'would-exceed' }), true, 'the real budget stop');
  assert.equal(outOfRoad({ stoppedBecause: 'limit-reached' }), true);
  assert.equal(outOfRoad({ stoppedBecause: 'too-small' }), true);
  assert.equal(outOfRoad({ stoppedBecause: 'round-cap' }), true, 'the real round wall');
  assert.equal(outOfRoad({ stoppedBecause: 'stuck' }), true);

  // ⚠️ The other half, and it is the more expensive mistake: a model that
  // finished on its own terms did correct work. Escalating it charges twice for
  // nothing and is the check-that-fails-correct-work failure.
  assert.equal(outOfRoad({ stoppedBecause: 'verified' }), false);
  assert.equal(outOfRoad({ stoppedBecause: 'no-tool-calls' }), false);
  assert.equal(outOfRoad({}), false);
  assert.equal(outOfRoad(null), false);
});

test('the wired predicate escalates a budget-stopped run, and BOTH halves now catch it', async () => {
  // The exact outcome shape the real run produced: ok, files written, nothing
  // verified, stopped on budget.
  const cutOff = {
    ok: true, stoppedBecause: 'would-exceed', verification: { ran: false }, usage: { cost: 0.0016 }, executed: [],
  };

  /**
   * ⚠️ THIS ASSERTION USED TO READ `sessionFailed(cutOff) === false`, with the
   * note "the process verdict tolerates it — that is why the bug hid". It was an
   * accurate description of a defect, and `outOfRoad` was built to work around
   * it here in the ladder while the PROCESS exit code went on returning 0 for a
   * run that stopped mid-job with a half-written repo.
   *
   * ⭐ Fixed 2026-08-13: a budget stop now fails `sessionFailed` outright, on the
   * same footing as a dead provider — a run cut off by a limit did not complete,
   * whatever it managed first. It became urgent the day before, when the $0.02
   * ceiling was turned on by default and this stopped being a path you had to
   * opt into.
   *
   * ⚠️ `outOfRoad` IS STILL LOAD-BEARING and is not now redundant: it also covers
   * 'round-cap' and 'stuck', which `sessionFailed` deliberately does not treat as
   * process failures. Two predicates, two questions — "did this attempt finish"
   * and "did this run succeed" — and the ladder needs the first one.
   */
  assert.equal(sessionFailed(cutOff), true, 'the process verdict catches it now too');
  assert.equal(outOfRoad(cutOff), true, 'and the ladder still sees a wall rather than a finish');

  const tiers = [];
  const r = await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: openBudget(),
    maxTier: 'fresh',
    verified: (o) => !sessionFailed(o) && !outOfRoad(o),
    runOne: async ({ tier }) => { tiers.push(tier); return cutOff; },
  });

  assert.deepEqual(tiers, ['solo', 'fresh'], 'the ladder climbs on a run that was merely cut off');
  assert.equal(r.stopped, 'exhausted');
});

// ── ⭐⭐ REACH: the CLI a user types must actually get here ─────────────────

/**
 * ⚠️ EVERY TEST ABOVE THIS LINE WOULD STAY GREEN FOREVER IF `bin/acuvo.mjs`
 * NEVER IMPORTED THIS MODULE. That is not hypothetical in this package —
 * `budget.mjs`, `lease.mjs`, `repo-map.mjs` and `stuck.mjs` all shipped
 * finished, documented, unit-tested and reachable by nothing, and `best-of.mjs`
 * was reachable from exactly one mode that could not be combined with the one
 * that needed it. So this test spawns the REAL binary and reads the ladder out
 * of the `--json` contract.
 *
 * ⚠️ AND IT NEEDS NO NETWORK AND NO KEY. The budget is set below the cost of a
 * single round, so `budget.mjs` refuses before any request is made — which also
 * makes this an end-to-end exercise of rules 1 and 3 (the unaffordable rung is
 * skipped, named, and reported) rather than only of the import.
 */
test('the real binary reaches the ladder and reports a skipped rung', () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-ladder-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"demo","version":"1.0.0"}\n');

  const env = { ...process.env, NO_COLOR: '1', OPENROUTER_API_KEY: 'x' };
  const r = spawnSync(
    process.execPath,
    [CLI, '--dir', root, '--until-done', '--budget', '0.0000001', '--json', 'make the tests pass'],
    { encoding: 'utf8', input: '', timeout: 60_000, windowsHide: true, env },
  );

  const doc = JSON.parse(r.stdout);
  assert.ok(doc.escalation, 'the --json contract carries the ladder, so the branch demonstrably ran');
  assert.equal(doc.escalation.stopped, 'budget');
  assert.equal(doc.escalation.rungs.length, 1, 'only the affordable rung was entered');
  assert.equal(doc.escalation.skipped[0].tier, 'fresh', 'the rung that could not be paid for is named');
  assert.ok(doc.escalation.skipped[0].projectedUsd > doc.escalation.skipped[0].remainingUsd);
  assert.equal(doc.failed, true);
  assert.equal(r.status, 1, 'and the shell agrees with the document');
});

test('a run that does not use the ladder is unchanged', () => {
  // ⚠️ A new flag that alters the output of every existing run is a regression
  // wearing a feature's clothes. No --until-done means no `escalation` key.
  const root = mkdtempSync(join(tmpdir(), 'acuvo-ladder-off-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"demo","version":"1.0.0"}\n');

  const env = { ...process.env, NO_COLOR: '1', OPENROUTER_API_KEY: 'x' };
  const r = spawnSync(
    process.execPath,
    [CLI, '--dir', root, '--budget', '0.0000001', '--json', 'make the tests pass'],
    { encoding: 'utf8', input: '', timeout: 60_000, windowsHide: true, env },
  );
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.escalation, undefined, 'the ordinary path is byte-identical to before');
});

// ── rule 3 again, at the render layer ──────────────────────────────────────

test('the report shows skipped rungs and names money as the reason', () => {
  const text = formatEscalation({
    stopped: 'budget',
    tier: 'solo',
    spentUsd: 0.0025,
    rungs: [{ tier: 'solo', verified: false, costUsd: 0.0025, why: 'rounds' }],
    skipped: [{ tier: 'fresh', why: 'not enough left', projectedUsd: 0.0035, remainingUsd: 0.0005 }],
  });

  assert.match(text, /solo/);
  assert.match(text, /fresh/, 'the rung that never ran is still on the report');
  assert.match(text, /skipped/);
  assert.match(text, /not on capability/, 'the operator is told this was a funding decision');
});

test('an exhausted ladder does not blame the budget', () => {
  const text = formatEscalation({
    stopped: 'exhausted',
    tier: 'best-of',
    spentUsd: 0.02,
    rungs: [{ tier: 'best-of', verified: false, costUsd: 0.02, why: 'rounds' }],
    skipped: [],
  });
  assert.match(text, /genuinely hard/);
  assert.doesNotMatch(text, /not on capability/);
});

// ── ⭐ THE FLAGS THAT MAKE THE LADDER REACHABLE ────────────────────────────

test('--max-tier is validated against the ladder\'s own tier list', async () => {
  const { parseArgv } = await import('../lib/cli-args.mjs');
  assert.equal(parseArgv(['t']).options.maxTier, 'best-of', 'the default is the full ladder');
  for (const tier of TIERS) {
    assert.equal(parseArgv(['--max-tier', tier, 't']).options.maxTier, tier);
  }
  const bad = parseArgv(['--max-tier', 'turbo', 't']);
  assert.equal(bad.ok, false);
  // ⚠️ The error must list the real tiers, derived — not a typed-out copy.
  for (const tier of TIERS) assert.match(bad.error, new RegExp(tier));
});

test('--max-tier solo turns escalation off without turning the run off', async () => {
  const calls = [];
  const r = await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: openBudget(),
    maxTier: 'solo',
    runOne: async ({ tier }) => { calls.push(tier); return outcome({ verified: false, cost: 0.001 }); },
  });
  assert.deepEqual(calls, ['solo'], 'one attempt, and no ladder');
  assert.equal(r.stopped, 'exhausted');
  assert.equal(r.skipped.length, 0, 'a ceiling the user chose is not a skipped rung to complain about');
});

test('⚠️ --until-done and --best-of collided on the same flag', () => {
  /**
   * BOTH FEATURES READ `--best-of n`, and the top-level best-of branch sits
   * FIRST in `main()`. So `--until-done --budget 2 --best-of 4` would have run a
   * single round of parallel attempts and exited — silently discarding the
   * escalation the user explicitly asked for, while appearing to honour a flag
   * they typed. Under `--until-done` the flag now means the ladder's top-rung
   * width, and the ladder owns it.
   *
   * ⚠️ ASSERTED THROUGH THE REAL BINARY, because the collision was an ORDERING
   * bug between two branches of `main()` — something no unit test of either
   * feature could see.
   */
  const root = mkdtempSync(join(tmpdir(), 'acuvo-collide-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"demo","version":"1.0.0"}\n');

  const env = { ...process.env, NO_COLOR: '1', OPENROUTER_API_KEY: 'x' };
  const r = spawnSync(
    process.execPath,
    [CLI, '--dir', root, '--until-done', '--budget', '0.0000001', '--best-of', '4', '--json', 'do the thing'],
    { encoding: 'utf8', input: '', timeout: 60_000, windowsHide: true, env },
  );

  const doc = JSON.parse(r.stdout);
  assert.ok(doc.escalation, 'the LADDER ran, not the one-shot best-of mode');
  assert.equal(doc.escalation.rungs[0].tier, 'solo', 'and it started at the cheap rung as always');
});

// ── ⭐ MODEL TIERS: the ladder can escalate the MODEL, not just the strategy ─

test('with no tiers configured, nothing about the run changes', async () => {
  /**
   * ⚠️ THE DEFAULT MUST BE INERT. This feature can multiply a bill, so a user
   * who configured nothing has to get byte-identical behaviour — every rung on
   * the model they already chose.
   */
  const seen = [];
  await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: openBudget(),
    baseModel: 'deepseek/deepseek-v4-flash-0731',
    env: {},
    maxTier: 'fresh',
    runOne: async ({ tier, model }) => { seen.push({ tier, model }); return outcome({ verified: false, cost: 0.001 }); },
  });
  assert.deepEqual(seen.map((s) => s.model), ['deepseek/deepseek-v4-flash-0731', 'deepseek/deepseek-v4-flash-0731']);
});

test('configured tiers give each rung a stronger model', async () => {
  const seen = [];
  await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: openBudget(),
    baseModel: 'cheap/model',
    env: { ACUVO_MODEL_TIERS: 'cheap/model, mid/model, strong/model' },
    runOne: async ({ tier, model }) => { seen.push({ tier, model }); return outcome({ verified: false, cost: 0.001 }); },
    bestOf: async (args) => {
      await args.runOne({ root: '/tmp/copy', label: 'attempt 1/3' });
      return { ok: true, attempts: 3, winner: outcome({ verified: false }), totalCost: 0.01, scored: [] };
    },
  });
  assert.equal(seen[0].model, 'cheap/model', 'solo stays cheap');
  assert.equal(seen[1].model, 'mid/model', 'fresh steps up');
  assert.equal(seen[2].model, 'strong/model', 'best-of gets the strongest');
});

test('fewer tiers than rungs reuses the STRONGEST, never wrapping to the weakest', async () => {
  /**
   * ⚠️ Wrapping would send the hardest attempt to the weakest model, which is
   * the exact inverse of the feature.
   */
  const seen = [];
  await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: openBudget(),
    baseModel: 'cheap/model',
    env: { ACUVO_MODEL_TIERS: 'cheap/model,strong/model' },
    runOne: async ({ model }) => { seen.push(model); return outcome({ verified: false, cost: 0.001 }); },
    bestOf: async (args) => {
      await args.runOne({ root: '/tmp/copy', label: 'a' });
      return { ok: true, attempts: 3, winner: outcome({ verified: false }), totalCost: 0.01, scored: [] };
    },
  });
  assert.deepEqual(seen, ['cheap/model', 'strong/model', 'strong/model']);
});

test('⚠️ a model switch is announced, and it invalidates the cost projection', async () => {
  /**
   * ⚠️⚠️ THE HAZARD THIS FEATURE CREATES. `projectTierCost` prices the next rung
   * from what the LAST one measurably cost — sound while the model is constant,
   * and wrong the moment it is not. A rung on a model costing 20x per token
   * would be projected at 3x a cheap attempt, waved through by the budget, and
   * the ceiling the user typed crossed by an order of magnitude.
   *
   * There is no price table here and a wrong one is worse than none, so the
   * measured basis is DISCARDED on a switch and the projection falls back to its
   * floor — conservative instead of confidently wrong.
   */
  const events = [];
  await escalate({
    root: '/tmp/x',
    task: 'thing',
    budget: openBudget(),
    baseModel: 'cheap/model',
    env: { ACUVO_MODEL_TIERS: 'cheap/model,strong/model' },
    maxTier: 'fresh',
    onEvent: (e) => events.push(e),
    // An expensive first rung: if its cost were carried across the switch, the
    // projection for the next rung would be built on the wrong model's price.
    runOne: async () => outcome({ verified: false, cost: 0.5 }),
  });

  const switched = events.find((e) => e.type === 'escalate-model');
  assert.ok(switched, 'the switch must be announced');
  assert.equal(switched.from, 'cheap/model');
  assert.equal(switched.to, 'strong/model');
  assert.match(switched.note, /not projected from the previous rung/);
});

test('model tiers: the parser is bounded and tolerant', async () => {
  const { parseTiers, modelForRung, MAX_TIERS, describeSwitch } = await import('../lib/model-tier.mjs');
  assert.deepEqual(parseTiers('base', {}), ['base'], 'unset means one tier');
  assert.deepEqual(parseTiers('base', { ACUVO_MODEL_TIERS: '   ' }), ['base'], 'blank is not a configuration');
  assert.deepEqual(parseTiers('base', { ACUVO_MODEL_TIERS: 'a, b ,a,' }), ['a', 'b'], 'trimmed and de-duplicated');
  assert.equal(parseTiers('base', { ACUVO_MODEL_TIERS: 'a,b,c,d,e,f' }).length, MAX_TIERS, 'bounded');
  assert.equal(modelForRung(99, ['a', 'b']), 'b', 'past the end reuses the strongest');
  assert.equal(describeSwitch('a', 'a'), null, 'no switch, no noise');
});
