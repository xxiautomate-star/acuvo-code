/**
 * ── ⭐⭐ DOES THE SPEND CEILING ACTUALLY STOP A RUNAWAY? MEASURED. ────────────
 *
 * "NOTHING STOPS A RUNAWAY BILL TODAY" is on record as a finding, and the only
 * honest way to answer it is to build a runaway and watch. Every scenario here
 * drives the REAL `runSession` loop with a fake model — no network, no money —
 * and asserts where the run stopped and what it had spent when it did.
 *
 * ⚠️ THE POINT IS NOT THAT THE CEILING EXISTS. `createBudget` and `canContinue`
 * are extensively unit-tested elsewhere and a unit test of a decision function
 * proves nothing about whether anybody asks it — `policy.mjs` records exactly
 * that failure for `costDecision`, which was complete, careful, and had zero
 * runtime callers while a run spent money next to it. So every assertion below
 * goes through `runSession`.
 *
 * ── ⭐⭐ ONE SCENARIO USED TO PIN A HOLE. IT NOW PINS THE FIX. ────────────────
 *
 * A provider that reports `cost: 0` made the DOLLAR ceiling inert — measured
 * here, pinned here as a LIMIT with its own reason rather than quietly left out
 * because it was inconvenient, and closed on 2026-08-29. Both halves of the
 * remedy are asserted below: the silent zero is now priced and stopped, and a
 * DECLARED free leg is still free. A test suite that only asserts the cases
 * that pass is a suite that reports the product is finished.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { parseArgv, UNTIL_DONE_MAX_ROUNDS } from '../lib/cli-args.mjs';

/**
 * A model that never finishes: every round asks for another tool call, so the
 * loop only ever ends because something STOPPED it. That is the whole fixture —
 * a run that would go forever if nothing were watching.
 */
async function runaway({ usageFor, budgetUsd = 0.05, maxRounds = 40 }) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-runaway-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  try {
    let round = 0;
    const events = [];
    const out = await runSession({
      task: 'loop forever',
      executor: createLocalExecutor(root),
      config: { apiKey: 'k', model: 'm' },
      maxRounds,
      budgetUsd,
      budgetIsDefault: true,
      callModelImpl: async () => {
        round += 1;
        return {
          ok: true,
          content: 'still working',
          usage: usageFor(round),
          finishReason: 'tool_calls',
          toolCalls: [{ id: `r${round}`, name: 'read_file', arguments: { path: 'nope.txt' } }],
        };
      },
      onEvent: (e) => events.push(e),
    });
    return { out, events, stops: events.filter((e) => e.type === 'budget-stop') };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/* ── ⭐ THE GUARANTEE: it stops, and it stops BEFORE it breaches ──────────── */

test('⭐⭐ a run that would never end is STOPPED by the dollar ceiling, under budget', async () => {
  const { out, stops } = await runaway({ usageFor: () => ({ cost: 0.01, total_tokens: 2_000 }), maxRounds: 40 });

  assert.equal(out.stoppedBecause, 'would-exceed', `stopped on ${out.stoppedBecause}, not on money`);
  assert.equal(stops.length, 1, 'exactly one budget-stop, or the loop is refusing more than once');
  assert.ok(out.roundsUsed < 40, `the round cap was the wall, not the ceiling (${out.roundsUsed} rounds)`);

  /**
   * ⭐⭐ THE NUMBER IS THE EVIDENCE. `would-exceed` means the round that WOULD
   * have crossed the line was declined before it was bought — not "we noticed
   * afterwards". At $0.01 a round against $0.05 that is four rounds and $0.04,
   * and $0.05 is never reached.
   */
  assert.ok(out.budget.spentUsd <= 0.05, `spent $${out.budget.spentUsd} against a $0.05 ceiling`);
  assert.ok(out.budget.spentUsd >= 0.03, `spent only $${out.budget.spentUsd} — it stopped far too early to be a ceiling`);
});

test('⚠️ THE REAL GUARANTEE IS "cap + ONE round", because a round is bought before it is priced', async () => {
  /**
   * ⚠️ MEASURED, NOT ARGUED: one round that costs 100x the projection spends
   * $0.90 against a $0.05 ceiling and the run stops immediately AFTER it. No
   * projection can prevent that — the cost of a round is not knowable until it
   * has been bought — so the honest statement of the control is **"at most the
   * ceiling plus one round"**, and one round is unbounded from above.
   *
   * ⭐ THIS IS WHY IT IS PINNED. Anyone who reads "$0.05 ceiling" as a hard
   * maximum is wrong, and the number here is how they find that out.
   */
  const { out, stops } = await runaway({
    usageFor: (r) => ({ cost: r === 3 ? 0.9 : 0.0005, total_tokens: 2_000 }),
    maxRounds: 40,
  });
  assert.equal(stops.length, 1);
  assert.equal(out.stoppedBecause, 'limit-reached');
  assert.ok(out.budget.spentUsd > 0.05, 'the fixture did not actually breach — it proves nothing');
  assert.ok(out.roundsUsed <= 4, `it kept going for ${out.roundsUsed} rounds after blowing the ceiling`);
});

/* ── ⭐⭐⭐ THE HOLE, CLOSED — AND THE FREE CASE THAT MUST NOT BREAK ───────── */

/**
 * ── ⚠️⚠️ WHAT USED TO BE HERE, AND WHY IT IS GONE ───────────────────────────
 *
 * Until 2026-08-29 this slot held a test called *"KNOWN LIMIT: a provider that
 * reports `cost: 0` makes the dollar ceiling INERT"*, which ASSERTED THE DEFECT
 * deliberately: twelve rounds of `{cost: 0, total_tokens: 2000}`, `$0.00`
 * metered, zero budget-stops, the round cap the only wall. Its own comment said
 * *"if the behaviour is fixed, this test must fail — read this comment, delete
 * the test, and pin the new guarantee instead"*, and named the reason it was
 * escalated rather than fixed: `record()` is the one place a round is priced,
 * it feeds the unit meter, the cache ledger and the settled margin figures, so
 * disbelieving a zero NAIVELY would charge genuinely-free rounds at card rate.
 *
 * ⭐ THE REMEDY HONOURS BOTH HALVES: a zero is disbelieved only when tokens
 * demonstrably moved AND nothing declares the leg free. The two tests below are
 * the two halves, and the second one is the one that would catch an
 * over-correction — a fix that closed the hole by charging every zero would
 * pass the first test and fail the second.
 */
test('⭐⭐⭐ CLOSED: a provider that reports `cost: 0` beside real tokens is STOPPED on money', async () => {
  /**
   * ⚠️ 30,000 TOKENS A ROUND, NOT THE 2,000 THE OLD TEST USED. `turn.mjs`
   * measures a real round at 10k–30k tokens against `console.cli_usage`, and at
   * 2,000 tokens a round the honest priced cost is ~$0.0002 — so twelve rounds
   * fit inside $0.05 legitimately and the ceiling SHOULD not fire. Pinning the
   * fix on a fixture that cannot afford to breach would be a guard that passes
   * while checking nothing.
   */
  const { out, stops } = await runaway({
    usageFor: () => ({ cost: 0, total_tokens: 30_000 }),
    maxRounds: 40,
  });

  assert.equal(stops.length, 1, 'the dollar ceiling did not fire — the hole is OPEN again');
  assert.equal(out.stoppedBecause, 'would-exceed',
    `stopped on ${out.stoppedBecause} — the round cap must not be what saved it`);
  assert.ok(out.roundsUsed < 40, `ran all ${out.roundsUsed} rounds, so the round cap was still the only wall`);
  assert.ok(out.budget.spentUsd > 0, 'the meter read $0.00 for rounds of real tokens');
  assert.ok(out.budget.spentUsd <= 0.05, `spent $${out.budget.spentUsd} against a $0.05 ceiling`);

  /**
   * ⭐ THE MONEY IS AN ESTIMATE AND THE RUN SAYS SO — including the way out for
   * the one user this could be unfair to: somebody whose model really is free.
   */
  assert.equal(out.budget.estimated, true, 'a repriced zero is a guess and must be flagged as one');
  assert.equal(out.budget.repricedZeroRounds, out.roundsUsed);
  const stop = stops[0];
  assert.match(JSON.stringify(stop), /priced from those tokens/, 'the stop must say why it charged');
  assert.match(JSON.stringify(stop), /--budget none/, 'and name the flag that gets past it');
});

test('⭐⭐ …and a DECLARED free leg is still free — the fix must not charge lever 3', async () => {
  /**
   * ⚠️ THE OVER-CORRECTION THIS CATCHES. `doctor.mjs` and `model.mjs` both tell
   * a user with no credit to *"set OPENROUTER_CODEGEN_MODEL to a `:free` model
   * id"*. If taking that advice then billed them at the DeepSeek card rate, the
   * ceiling would stop a run that spent nothing — a guard that fails correct
   * work, which this package has paid for four times in one day.
   */
  const { out, stops } = await runaway({
    usageFor: () => ({ cost: 0, total_tokens: 2_000, model: 'z-ai/glm-4.5-air:free' }),
    maxRounds: 12,
  });

  assert.equal(stops.length, 0, 'a free run was stopped on money it never spent');
  assert.equal(out.stoppedBecause, 'round-cap', `stopped on ${out.stoppedBecause}`);
  assert.equal(out.roundsUsed, 12, 'the round cap is the right wall for a genuinely free run');
  assert.equal(out.budget.spentUsd, 0, 'a declared free leg cost $0.00 and must be recorded as $0.00');
  assert.equal(out.budget.estimated, false, 'a stated fact is not an estimate');
});

test('⭐ …and THAT is why --until-done refuses to start without an explicit --budget', () => {
  /**
   * ⭐ THE MITIGATION THAT ALREADY EXISTS, ASSERTED HERE SO THE TWO FACTS SIT
   * TOGETHER. The round cap is what actually bounds a zero-reporting provider,
   * and `--until-done` is the one mode that raises it to 200 — so it is also the
   * one mode where the hole above is worth 200 rounds instead of 24. The flag
   * refuses to run at all without a number a human typed.
   */
  const refused = parseArgv(['--until-done', 'do the thing']);
  assert.equal(refused.ok, false, '--until-done started with no ceiling at all');
  assert.match(refused.error, /--budget/, 'the refusal must name the flag that fixes it');

  const accepted = parseArgv(['--until-done', '--budget', '0.50', 'do the thing']);
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.options.maxRounds, UNTIL_DONE_MAX_ROUNDS,
    'the round cap is the backstop for a provider that reports no cost — it must still be finite');
});
