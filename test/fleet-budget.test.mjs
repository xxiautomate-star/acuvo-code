/**
 * The fleet ceiling: does "cheap" survive seven terminals?
 *
 * ⚠️ EVERY TEST HERE IS PURE. `readFleetSpend` takes an injected reader and
 * `fleetVerdict` takes three numbers, which is deliberate — a decision about
 * money should be provable without a temp directory, a clock, or a race. The
 * disk half is already covered by spend.mjs's own tests; what is new and
 * dangerous is the ARITHMETIC and the refusals, so that is what is pinned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fleetVerdict, readFleetSpend, startOfUtcDay, FLEET_REASONS } from '../lib/fleet-budget.mjs';
import { createBudget, BUDGET_REASONS, FLEET_STOP_REASONS } from '../lib/budget.mjs';
import { createFleetGate } from '../lib/fleet-budget.mjs';

/** A clean ledger reading, overridable per test. */
const spend = (over = {}) => ({ ok: true, totalUsd: 0, runs: 0, unknown: 0, damaged: 0, ...over });

test('with no fleet ceiling set, nothing is enforced and nothing is claimed', () => {
  const v = fleetVerdict({ fleetLimitUsd: null, fleetSpend: spend(), thisRunUsd: 5, projectedUsd: 5 });
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'no-fleet-budget');
  assert.equal(v.fleetRemainingUsd, Infinity);
});

test('under the ceiling it reports what is left, naming the ceiling', () => {
  const v = fleetVerdict({ fleetLimitUsd: 1, fleetSpend: spend({ totalUsd: 0.25, runs: 12 }), thisRunUsd: 0.05, projectedUsd: 0.01 });
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'ok');
  assert.ok(Math.abs(v.fleetSpentUsd - 0.30) < 1e-9, `expected 0.30, got ${v.fleetSpentUsd}`);
  assert.ok(Math.abs(v.fleetRemainingUsd - 0.70) < 1e-9);
});

test('⭐⭐ THIS RUN\'S OWN SPEND COUNTS — its audit record is not written until it ends', () => {
  /**
   * The whole reason `thisRunUsd` is a separate parameter. A run appends its
   * record when it FINISHES, so a single long run is invisible in the shared
   * ledger for its entire life. If that spend were left out, one terminal could
   * burn the fleet's whole ceiling while the ledger reported zero.
   */
  const ledgerOnly = fleetVerdict({ fleetLimitUsd: 1, fleetSpend: spend({ totalUsd: 0.4 }), thisRunUsd: 0, projectedUsd: 0.1 });
  assert.equal(ledgerOnly.ok, true, 'control: the fleet has room on the ledger alone');

  const withOwnSpend = fleetVerdict({ fleetLimitUsd: 1, fleetSpend: spend({ totalUsd: 0.4 }), thisRunUsd: 0.55, projectedUsd: 0.1 });
  assert.equal(withOwnSpend.ok, false, 'the same ledger plus this run\'s own spend must cross the line');
  assert.equal(withOwnSpend.reason, 'fleet-would-exceed');
});

test('a projected round that would cross the line stops BEFORE it is bought', () => {
  const v = fleetVerdict({ fleetLimitUsd: 0.10, fleetSpend: spend({ totalUsd: 0.09, runs: 4 }), thisRunUsd: 0, projectedUsd: 0.02 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'fleet-would-exceed');
  assert.match(v.message, /would cross the line/);
  assert.match(v.message, /--fleet-budget/, 'a refusal that does not name the flag is just an obstacle');
});

test('a ceiling already reached refuses, and says how much of it was this terminal', () => {
  const v = fleetVerdict({ fleetLimitUsd: 0.10, fleetSpend: spend({ totalUsd: 0.08, runs: 6 }), thisRunUsd: 0.03, projectedUsd: 0.001 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'fleet-limit-reached');
  assert.match(v.message, /6 runs/, 'the fleet total is meaningless without how many runs made it');
  assert.match(v.message, /This terminal has spent/);
});

test('⚠️ AN UNREADABLE LEDGER REFUSES — it must never read as a fresh, unspent day', () => {
  /**
   * The failure mode where the safety feature pays for the accident: if a
   * missing or unreadable ledger returned zero, every worker would be handed
   * the entire fleet ceiling again, and the harder the disk was failing the
   * more money the fleet would be allowed to spend.
   */
  const v = fleetVerdict({
    fleetLimitUsd: 1,
    fleetSpend: { ok: false, error: 'EACCES', totalUsd: 0, runs: 0, unknown: 0, damaged: 0 },
    thisRunUsd: 0,
    projectedUsd: 0.001,
  });
  assert.equal(v.ok, false);
  assert.equal(v.fleetRemainingUsd, 0, 'an unknown ledger must leave no room, not full room');
  assert.match(v.message, /cannot be enforced/);
  assert.match(v.message, /EACCES/, 'the underlying reason belongs in the message');
});

test('⚠️ an incomplete ledger is reported as a FLOOR, never as an exact total', () => {
  // A run with no reported price is never summed as zero, and an unparseable
  // line is money we cannot see. Either way the true total is HIGHER.
  const v = fleetVerdict({ fleetLimitUsd: 1, fleetSpend: spend({ totalUsd: 0.2, runs: 9, unknown: 2, damaged: 3 }), thisRunUsd: 0, projectedUsd: 0.01 });
  assert.equal(v.ok, true);
  assert.equal(v.incomplete, true);
  assert.match(v.message, /at least/, 'an undercounted total presented as exact is how a budget overspends');
  assert.match(v.message, /2 runs reported no price/);
  assert.match(v.message, /3 ledger lines could not be read/);
});

test('a complete ledger carries no floor marker — the caveat must not become noise', () => {
  const v = fleetVerdict({ fleetLimitUsd: 1, fleetSpend: spend({ totalUsd: 0.2, runs: 9 }), thisRunUsd: 0, projectedUsd: 0.01 });
  assert.equal(v.incomplete, false);
  assert.ok(!/at least/.test(v.message), `a clean ledger must read clean: ${v.message}`);
});

test('every reason it can return is a declared reason', () => {
  const cases = [
    { fleetLimitUsd: null, fleetSpend: spend() },
    { fleetLimitUsd: 1, fleetSpend: spend({ totalUsd: 0.1 }), projectedUsd: 0.01 },
    { fleetLimitUsd: 1, fleetSpend: spend({ totalUsd: 0.999 }), projectedUsd: 0.5 },
    { fleetLimitUsd: 1, fleetSpend: spend({ totalUsd: 2 }) },
    { fleetLimitUsd: 1, fleetSpend: { ok: false, error: 'x' } },
  ];
  for (const c of cases) {
    const v = fleetVerdict(c);
    assert.ok(FLEET_REASONS.includes(v.reason), `${v.reason} is not in FLEET_REASONS`);
  }
});

test('readFleetSpend surfaces a reader that throws instead of returning zero', () => {
  const r = readFleetSpend('/nowhere', {
    readImpl: () => { throw new Error('EACCES: permission denied'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.totalUsd, 0);
  assert.match(r.error, /EACCES/);
});

test('readFleetSpend sums real audit lines through the injected reader', () => {
  const line = (usd, at) => `${JSON.stringify({ at, run: { costUsd: usd, ok: true } })}\n`;
  const r = readFleetSpend('/ws', {
    readImpl: () => [{
      name: '2026-08-13.jsonl',
      text: line(0.01, '2026-08-13T01:00:00.000Z') + line(0.02, '2026-08-13T02:00:00.000Z') + 'not json\n',
    }],
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.totalUsd - 0.03) < 1e-9, `expected 0.03, got ${r.totalUsd}`);
  assert.equal(r.runs, 2);
  assert.equal(r.damaged, 1, 'seven processes appending can interleave — an unreadable line must be counted, not ignored');
});

test('⚠️ the window boundary is UTC, because the day FILES are UTC', () => {
  /**
   * A local-midnight window would ask for "today" and be handed two half-days
   * for anyone not on UTC, so the enforced total and the file it came from
   * would disagree. Being consistently wrong about which 24 hours beats being
   * inconsistently right.
   */
  const d = startOfUtcDay(new Date('2026-08-13T23:45:00.000Z'));
  assert.equal(d.toISOString(), '2026-08-13T00:00:00.000Z');
  const early = startOfUtcDay(new Date('2026-08-13T00:00:01.000Z'));
  assert.equal(early.toISOString(), '2026-08-13T00:00:00.000Z');
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SEAM — the gate is composed into createBudget, so every caller inherits it
// ═══════════════════════════════════════════════════════════════════════════

test('⭐ a fleet refusal stops a run the per-run budget would happily have allowed', () => {
  const budget = createBudget({
    limitUsd: 10,                       // per-run ceiling with plenty of room
    fleetGate: () => ({ ok: false, reason: 'fleet-limit-reached', message: 'the fleet is spent', fleetRemainingUsd: 0, fleetSpentUsd: 5 }),
  });
  const v = budget.canContinue();
  assert.equal(v.ok, false, 'the per-run ceiling had room; only the fleet should stop this');
  assert.equal(v.reason, 'fleet-limit-reached');
  assert.equal(v.remainingUsd, 0, 'escalate.mjs sizes its next rung from this number');
});

test('⚠️⚠️ the fleet gate binds even with NO per-run ceiling — that worker is the dangerous one', () => {
  /**
   * `--budget none` is the terminal with nothing bounding it at all, so it is
   * the one that can drain a fleet ceiling by itself. Checking the fleet after
   * the `unlimited` early-return would have left exactly that case ungated.
   */
  const budget = createBudget({
    limitUsd: null,
    fleetGate: () => ({ ok: false, reason: 'fleet-would-exceed', message: 'the fleet cannot cover the next round', fleetRemainingUsd: 0.01, fleetSpentUsd: 0.99 }),
  });
  const v = budget.canContinue();
  assert.equal(v.ok, false, 'an unbounded run must still answer to the fleet');
  assert.equal(v.reason, 'fleet-would-exceed');
});

test('a happy fleet changes nothing at all — the layer is a no-op for anyone not using it', () => {
  const gated = createBudget({ limitUsd: 1, fleetGate: () => ({ ok: true, reason: 'ok', message: '' }) });
  const plain = createBudget({ limitUsd: 1 });
  const a = gated.canContinue();
  const b = plain.canContinue();
  assert.equal(a.ok, b.ok);
  assert.equal(a.reason, b.reason);
  assert.equal(a.message, b.message, 'a satisfied fleet must not reword the ordinary verdict');
});

test('the gate is asked with THIS run\'s spend, which the shared ledger cannot know', () => {
  const seen = [];
  const budget = createBudget({
    limitUsd: 10,
    fleetGate: (args) => { seen.push(args); return { ok: true, reason: 'ok', message: '' }; },
  });
  budget.canContinue();                          // before any spend
  budget.record({ costUsd: 0.07, tokens: 100 });
  budget.canContinue();                          // after a round has been paid for

  assert.equal(seen.length, 2, 'construction must not ask; each canContinue must');
  assert.equal(seen[0].thisRunUsd, 0, 'a run that has spent nothing must say so');
  assert.ok(
    Math.abs(seen[1].thisRunUsd - 0.07) < 1e-9,
    `the gate must be told what this run has spent since the ledger cannot see it, got ${seen[1].thisRunUsd}`,
  );
  assert.ok(seen[1].projectedUsd > 0, 'and what the next round is projected to cost');
});

test('⚠️ every fleet stop is a declared BUDGET_REASON, or escalate.mjs will not route it', () => {
  /**
   * `escalate.mjs` builds its stop list as BUDGET_REASONS minus 'ok' and
   * 'no-budget-set'. A fleet stop missing from that list would be a budget stop
   * the escalation ladder does not recognise — the failure where a constant is
   * named in one place and never emitted from the other, with every test green.
   */
  for (const r of FLEET_STOP_REASONS) {
    assert.ok(BUDGET_REASONS.includes(r), `${r} is a fleet stop that BUDGET_REASONS does not declare`);
    assert.ok(FLEET_REASONS.includes(r), `${r} is missing from FLEET_REASONS`);
  }
  assert.ok(FLEET_STOP_REASONS.length > 0, 'an empty list would make this test vacuous');
});

test('createFleetGate returns null when the flag was never given — no disk read at all', () => {
  let reads = 0;
  const readImpl = () => { reads += 1; return []; };
  assert.equal(createFleetGate('/ws', { fleetLimitUsd: null, readImpl }), null);
  assert.equal(createFleetGate('/ws', { readImpl }), null);
  assert.equal(reads, 0, 'a fleet ceiling nobody asked for must not touch the disk');
});

test('⭐ createFleetGate wired into createBudget refuses a real over-spend end to end', () => {
  // The whole path: audit lines on "disk" -> summed -> compared -> canContinue.
  const line = (usd) => `${JSON.stringify({ at: '2026-08-13T04:00:00.000Z', run: { costUsd: usd, ok: true } })}\n`;
  const readImpl = () => [{ name: '2026-08-13.jsonl', text: line(0.04) + line(0.04) + line(0.03) }];
  const gate = createFleetGate('/ws', {
    fleetLimitUsd: 0.10,
    now: () => new Date('2026-08-13T12:00:00.000Z'),
    readImpl,
  });
  assert.notEqual(gate, null);

  const budget = createBudget({ limitUsd: 10, fleetGate: gate });
  const v = budget.canContinue();
  assert.equal(v.ok, false, '$0.11 of fleet spend against a $0.10 ceiling must stop, despite a $10 per-run ceiling');
  assert.equal(v.reason, 'fleet-limit-reached');
  assert.match(v.message, /0\.11|11\./, `the message must carry the real total: ${v.message}`);
});

test('⚠️ the gate reads the ledger AGAIN each round — other terminals spend while this one thinks', () => {
  let call = 0;
  const line = (usd) => `${JSON.stringify({ at: '2026-08-13T04:00:00.000Z', run: { costUsd: usd, ok: true } })}\n`;
  // The fleet is quiet on the first look and busy on the second.
  const readImpl = () => [{ name: '2026-08-13.jsonl', text: (call++ === 0 ? line(0.001) : line(0.5)) }];
  const gate = createFleetGate('/ws', { fleetLimitUsd: 0.10, now: () => new Date('2026-08-13T12:00:00.000Z'), readImpl });
  const budget = createBudget({ limitUsd: 10, fleetGate: gate });

  assert.equal(budget.canContinue().ok, true, 'first look: the fleet has room');
  assert.equal(budget.canContinue().ok, false, 'second look must SEE the other terminals — a cached total would say yes forever');
});
