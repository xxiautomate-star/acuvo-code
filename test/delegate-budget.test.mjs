/**
 * ── ⚠️⚠️ THE ONE DIFFERENTIATOR, AND `delegate` WALKED STRAIGHT PAST IT ──────
 *
 * The claim this package makes is: *tell me the price before it runs, and stop
 * at the number you gave me.* `runSubagent` passed no `budgetUsd` to
 * `runSession`, which defaults it to null — so the moment the model called
 * `delegate`, the parent stopped at its ceiling and the helper it had just
 * spawned had none at all.
 *
 * ⭐ The cost came back in `costUsd` and was reported. So the money was
 * MEASURED and simply not BOUNDED, which is the most misleading of the three
 * possible states: a number on screen that looks like control.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runSubagent } from '../lib/subagent.mjs';
import { executeToolCall } from '../lib/tools.mjs';
import { createBudget } from '../lib/budget.mjs';
import { createMemoryExecutor } from '../lib/memory-workspace.mjs';

/** A stub `runSession` that records what it was handed and reports a cost. */
function spySession({ costUsd = 0 } = {}) {
  const seen = [];
  const impl = async (opts) => {
    seen.push(opts);
    return {
      ok: true, roundsUsed: 1, executed: [], messages: [],
      content: 'the helper looked and reports back',
      usage: { cost: costUsd, total_tokens: 1_000 },
    };
  };
  impl.seen = seen;
  return impl;
}

test('⚠️⚠️ a delegated helper is given a CEILING, not a blank cheque', async () => {
  const run = spySession();
  await runSubagent(
    { task: 'what does lib/turn.mjs do?', executor: createMemoryExecutor({}), config: { apiKey: 'k' }, budgetUsd: 0.25 },
    { sessionImpl: run },
  );
  assert.equal(run.seen.length, 1);
  assert.equal(run.seen[0].budgetUsd, 0.25, 'the helper ran with no ceiling — the run\'s stated limit was a claim about the parent only');
});

test('⭐ a run with no ceiling passes none down — --budget none still means none', async () => {
  const run = spySession();
  await runSubagent(
    { task: 'look at something', executor: createMemoryExecutor({}), config: { apiKey: 'k' } },
    { sessionImpl: run },
  );
  assert.equal(run.seen[0].budgetUsd, null);
});

test('⭐ the FLEET ceiling travels to the helper too', async () => {
  const run = spySession();
  const gate = () => ({ ok: true, reason: 'ok', message: '' });
  await runSubagent(
    { task: 'x', executor: createMemoryExecutor({}), config: { apiKey: 'k' }, fleetGate: gate },
    { sessionImpl: run },
  );
  assert.equal(run.seen[0].fleetGate, gate, 'seven terminals could each delegate their way around the workspace cap');
});

test('⭐⭐ the helper inherits what the parent has LEFT, and its spend is charged back', async () => {
  const budget = createBudget({ limitUsd: 1 });
  budget.record({ costUsd: 0.60, tokens: 1_000 });          // parent has $0.40 left

  /**
   * ⚠️ THIS STUB RETURNS `runSubagent`'s SHAPE, not `runSession`'s. Written the
   * other way round first — `{usage:{cost}}` instead of `{costUsd}` — and the
   * charge-back silently found nothing to charge. A stub that does not match
   * the real return value tests the stub; the same mistake cost an hour on the
   * lease handle earlier today.
   */
  const helper = async (a) => {
    assert.ok(Math.abs(a.budgetUsd - 0.40) < 1e-9, `the helper was handed ${a.budgetUsd}, not the parent's $0.40 remainder`);
    return { ok: true, summary: 'looked and reported', costUsd: 0.30, tokens: 1_000, roundsUsed: 1, files: [] };
  };
  const call = { id: '1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'read the module and summarise' }) } };
  await executeToolCall(call, createMemoryExecutor({}), {
    config: { apiKey: 'k' }, budget, subagentImpl: helper,
  });

  const after = budget.canContinue();
  assert.ok(
    Math.abs(after.spentUsd - 0.90) < 1e-9,
    `the helper's $0.30 was not charged to the parent — spent reads ${after.spentUsd}, so the ceiling is not the total`,
  );
});

test('⚠️⚠️ a FAILED helper is still charged — three wasted rounds cost three rounds', async () => {
  /**
   * `runSubagent` returns `costUsd` on the failure path precisely because a
   * helper that crashed after three rounds still spent them. Recording only
   * successes would let a run of failing delegations cost an unbounded amount
   * while the parent's ledger insisted nothing had happened.
   */
  const budget = createBudget({ limitUsd: 1 });
  const failing = async () => ({ ok: false, error: 'the helper gave up', roundsUsed: 3, costUsd: 0.12, tokens: 900 });

  const call = { id: '1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'something hard' }) } };
  const rec = await executeToolCall(call, createMemoryExecutor({}), {
    config: { apiKey: 'k' }, budget, subagentImpl: failing,
  });

  assert.equal(rec.result.ok, false, 'the fixture must actually fail, or this proves nothing');
  assert.ok(
    Math.abs(budget.canContinue().spentUsd - 0.12) < 1e-9,
    `a failed delegation cost ${budget.canContinue().spentUsd} against the parent — expected 0.12`,
  );
});

test('a run with no budget object still delegates exactly as it did before', async () => {
  const helper = async () => ({ ok: true, summary: 'fine', costUsd: 0.05, tokens: 10, roundsUsed: 1, files: [] });
  const call = { id: '1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'look' }) } };
  const rec = await executeToolCall(call, createMemoryExecutor({}), {
    config: { apiKey: 'k' }, subagentImpl: helper,
  });
  assert.equal(rec.result.ok, true, 'a library caller that passes no budget must be unaffected');
});
