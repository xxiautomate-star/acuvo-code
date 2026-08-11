/**
 * ── THE BUDGET GOVERNOR'S TESTS — the refusals, not the getters ─────────────
 *
 * This module's whole job is to say NO at the right moment, so almost every
 * test here is about a refusal, a projection, or a number that must not be
 * silently zero. The three that matter most:
 *
 *   · NEVER OVERSHOOT. `stopsBeforeCrossing` runs the loop the way the wiring
 *     will run it — `while (canContinue().ok) record(...)` — against flat,
 *     linear and geometric cost curves, and asserts the final spend never
 *     crosses the limit. A budget flag that overshoots is a flag nobody uses
 *     twice, so this is the property the module exists for.
 *   · UNKNOWN IS NEVER FREE. OpenRouter does not always return `usage.cost`.
 *     A governor that treats a missing cost as $0 runs forever and bills the
 *     user for the privilege — the single worst failure available here. Two
 *     tests pin it: tokens-only rounds are priced from tokens, and rounds with
 *     NOTHING are charged the current projection.
 *   · A CHECK THAT FAILS CORRECT WORK IS WORSE THAN NO CHECK. A free model
 *     legitimately reports `cost: 0`. That must be recorded as zero, not
 *     "helpfully" inflated into an estimate — `honoursAnExplicitZero` pins it.
 *
 * ⚠️ THE EXACT-FIT BOUNDARY IS TESTED WITH `safetyFactor: 1` ON PURPOSE. The
 * shipped default carries a 10% margin, so with it on there is no arithmetic
 * boundary to sit on — the margin IS the boundary. Turning it off is the only
 * way to prove the comparison itself uses `>` and not `>=`, and a separate test
 * proves the default margin is really applied.
 *
 * ⚠️ AND THE OVERSHOOT BOUND IS TESTED HONESTLY. A cost curve that grows ~1.5x
 * every round CAN still cross the line, because a linear extrapolation cannot
 * see an exponent coming. The test does not pretend otherwise: it asserts the
 * damage is bounded by ONE round rather than asserting a guarantee the maths
 * does not give.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createBudget,
  parseBudgetUsd,
  formatUsd,
  DEFAULT_FIRST_ROUND_USD,
  DEFAULT_USD_PER_MILLION_TOKENS,
  DEFAULT_TREND_WINDOW,
  DEFAULT_SAFETY_FACTOR,
  USD_EPSILON,
  BUDGET_REASONS,
} from '../lib/budget.mjs';

/** A clock you drive by hand. Nothing in this module may reach for the wall. */
function fakeClock(start = 0) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => { now += ms; return now; };
  clock.set = (ms) => { now = ms; return now; };
  return clock;
}

// ── construction: bad input dies before anything is spent ───────────────────

test('a malformed limit is rejected at construction, not at round 1', () => {
  const bad = [-1, 0, NaN, Infinity, -Infinity, '0.5', {}, [], true];
  for (const limitUsd of bad) {
    assert.throws(
      () => createBudget({ limitUsd }),
      (err) => err instanceof RangeError && /budget/i.test(err.message),
      `limitUsd=${String(limitUsd)} should have thrown`,
    );
  }
});

test('a reserve that eats the whole limit is rejected', () => {
  assert.throws(() => createBudget({ limitUsd: 0.05, reserveUsd: 0.05 }), RangeError);
  assert.throws(() => createBudget({ limitUsd: 0.05, reserveUsd: 0.06 }), RangeError);
  assert.throws(() => createBudget({ limitUsd: 0.05, reserveUsd: -0.01 }), RangeError);
  assert.throws(() => createBudget({ limitUsd: 0.05, reserveUsd: 'x' }), RangeError);
  // a reserve strictly below the limit is fine
  assert.equal(createBudget({ limitUsd: 0.05, reserveUsd: 0.04 }).canContinue().ok, true);
});

test('the estimation rate can never be zero — unknown must never price as free', () => {
  assert.throws(() => createBudget({ limitUsd: 1, usdPerMillionTokens: 0 }), RangeError);
  assert.throws(() => createBudget({ limitUsd: 1, usdPerMillionTokens: -1 }), RangeError);
});

test('the other knobs are validated too', () => {
  assert.throws(() => createBudget({ limitUsd: 1, firstRoundUsd: 0 }), RangeError);
  assert.throws(() => createBudget({ limitUsd: 1, firstRoundUsd: -1 }), RangeError);
  assert.throws(() => createBudget({ limitUsd: 1, trendWindow: 0 }), RangeError);
  assert.throws(() => createBudget({ limitUsd: 1, trendWindow: 2.5 }), RangeError);
  assert.throws(() => createBudget({ limitUsd: 1, safetyFactor: 0.9 }), RangeError);
  assert.throws(() => createBudget({ limitUsd: 1, clock: 123 }), RangeError);
});

// ── the floor: a budget too small to fit one round never starts ─────────────

test('a budget too small for even the first round refuses before spending anything', () => {
  const b = createBudget({ limitUsd: 0.00001 });
  const verdict = b.canContinue();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'too-small');
  assert.equal(verdict.spentUsd, 0);
  assert.equal(b.stats().rounds, 0);
  // the message must name BOTH numbers, or the user cannot pick a better one
  assert.match(verdict.message, /0\.00001|0\.0000/);
  assert.match(verdict.message, /projected|project/i);
  assert.match(verdict.message, /nothing was started/i);
});

test('too-small is distinguished from exhausted — it is a different mistake', () => {
  const tiny = createBudget({ limitUsd: 0.00001 }).canContinue();
  const spent = createBudget({ limitUsd: 0.01 });
  spent.record({ costUsd: 0.01 });
  assert.equal(tiny.reason, 'too-small');
  assert.equal(spent.canContinue().reason, 'limit-reached');
  assert.notEqual(tiny.reason, spent.canContinue().reason);
});

test('a budget that fits exactly one projected round DOES start', () => {
  const b = createBudget({ limitUsd: DEFAULT_FIRST_ROUND_USD * DEFAULT_SAFETY_FACTOR, safetyFactor: DEFAULT_SAFETY_FACTOR });
  assert.equal(b.canContinue().ok, true);
});

// ── projection ──────────────────────────────────────────────────────────────

test('with no history the projection is the seed, and says so', () => {
  const b = createBudget({ limitUsd: 1, firstRoundUsd: 0.0004, safetyFactor: 1 });
  const p = b.projectNext();
  assert.equal(p.basis, 'seed');
  assert.equal(p.raw, 0.0004);
  assert.equal(p.usd, 0.0004);
  assert.equal(p.window, 0);
});

test('one round observed projects that round', () => {
  const b = createBudget({ limitUsd: 1, safetyFactor: 1 });
  b.record({ costUsd: 0.002 });
  const p = b.projectNext();
  assert.equal(p.basis, 'last');
  assert.equal(p.raw, 0.002);
  assert.equal(p.window, 1);
});

test('a rising cost curve is extrapolated, not averaged — this is the headline', () => {
  const b = createBudget({ limitUsd: 1, safetyFactor: 1, trendWindow: 3 });
  b.record({ costUsd: 0.001 });
  b.record({ costUsd: 0.002 });
  b.record({ costUsd: 0.003 });
  const p = b.projectNext();
  // a flat average would say 0.002 and under-project by 2x. The trend says 0.004.
  assert.equal(p.basis, 'trend');
  assert.equal(Number(p.raw.toFixed(10)), 0.004);
  assert.equal(Number(p.slope.toFixed(10)), 0.001);
});

test('a falling curve never projects below the recent peak', () => {
  const b = createBudget({ limitUsd: 1, safetyFactor: 1, trendWindow: 3 });
  b.record({ costUsd: 0.003 });
  b.record({ costUsd: 0.001 });
  b.record({ costUsd: 0.001 });
  // last+slope would be 0.001; the peak in the window is 0.003 and wins.
  assert.equal(b.projectNext().raw, 0.003);
  assert.equal(b.projectNext().basis, 'peak');
});

/**
 * ⚠️ THIS TEST EXISTS BECAUSE MUTATION TESTING KILLED A CLAMP.
 * `trend = last + Math.max(0, slope)` used to sit in `projectNext`, under a
 * comment about never extrapolating downward. Removing the `Math.max(0, …)`
 * broke nothing, because `slope < 0` implies `peak > trend` and the peak clamp
 * had already won. The clamp is gone; the PROPERTY it claimed is pinned here,
 * against curves steep enough that a raw extrapolation would go negative.
 */
test('a collapsing cost curve never projects downward, and never projects a negative', () => {
  for (const costs of [
    [0.05, 0.0001],
    [0.05, 0.001, 0.0001],
    [0.05, 0.05, 0.0000001],
    [1, 0.5, 0.25],
  ]) {
    const b = createBudget({ limitUsd: 100, safetyFactor: 1, trendWindow: 3 });
    for (const costUsd of costs) b.record({ costUsd });
    const p = b.projectNext();
    assert.ok(p.raw > 0, `projection must stay positive for ${JSON.stringify(costs)}, got ${p.raw}`);
    assert.ok(
      p.raw >= Math.max(...costs.slice(-3)) - USD_EPSILON,
      `projection ${p.raw} fell below the recent peak for ${JSON.stringify(costs)}`,
    );
  }
});

test('a flat curve projects flat', () => {
  const b = createBudget({ limitUsd: 1, safetyFactor: 1 });
  for (let i = 0; i < 5; i += 1) b.record({ costUsd: 0.0012 });
  assert.equal(Number(b.projectNext().raw.toFixed(10)), 0.0012);
});

test('the window slides — an old expensive round stops haunting the projection', () => {
  const b = createBudget({ limitUsd: 10, safetyFactor: 1, trendWindow: 3 });
  b.record({ costUsd: 0.05 });
  b.record({ costUsd: 0.001 });
  b.record({ costUsd: 0.001 });
  assert.equal(b.projectNext().raw, 0.05, 'still inside the window');
  b.record({ costUsd: 0.001 });
  assert.equal(Number(b.projectNext().raw.toFixed(10)), 0.001, 'the $0.05 round has fallen out');
});

test('the safety margin is applied to the decision figure but raw stays honest', () => {
  const b = createBudget({ limitUsd: 1 });
  b.record({ costUsd: 0.001 });
  const p = b.projectNext();
  assert.equal(p.raw, 0.001);
  assert.equal(Number(p.usd.toFixed(10)), Number((0.001 * DEFAULT_SAFETY_FACTOR).toFixed(10)));
  assert.equal(p.safetyFactor, DEFAULT_SAFETY_FACTOR);
  assert.ok(p.usd > p.raw, 'the decision figure must be the conservative one');
});

// ── the property the module exists for: never cross the line ────────────────

for (const [name, next] of [
  ['flat', () => 0.0012],
  ['linear growth', (i) => 0.0004 * (i + 1)],
  ['mild geometric growth', (i) => 0.0004 * (1.1 ** i)],
  ['noisy', (i) => 0.0008 * (1 + ((i * 7) % 5) / 10)],
]) {
  test(`never starts a round it cannot finish — ${name}`, () => {
    const limitUsd = 0.05;
    const b = createBudget({ limitUsd });
    let i = 0;
    let guard = 0;
    while (b.canContinue().ok) {
      b.record({ costUsd: next(i) });
      i += 1;
      if (++guard > 10000) break;
    }
    assert.ok(guard <= 10000, 'the loop must terminate on money, not on the guard');
    assert.ok(i > 3, `expected several rounds, got ${i}`);
    assert.ok(
      b.stats().spentUsd <= limitUsd + USD_EPSILON,
      `overshot: spent ${b.stats().spentUsd} of ${limitUsd}`,
    );
    const final = b.canContinue();
    assert.equal(final.ok, false);
    assert.ok(['would-exceed', 'limit-reached'].includes(final.reason), final.reason);
  });
}

test('violent 1.5x-per-round growth can still cross — but by at most ONE round', () => {
  const limitUsd = 0.05;
  const b = createBudget({ limitUsd });
  let i = 0;
  let last = 0;
  while (b.canContinue().ok) {
    last = 0.0004 * (1.5 ** i);
    b.record({ costUsd: last });
    i += 1;
    if (i > 200) break;
  }
  const spent = b.stats().spentUsd;
  assert.ok(spent <= limitUsd + last, `overshoot must be bounded by one round: ${spent} vs ${limitUsd}+${last}`);
});

test('the reserve is real headroom, not decoration', () => {
  const withReserve = createBudget({ limitUsd: 0.05, reserveUsd: 0.02 });
  let n = 0;
  while (withReserve.canContinue().ok) { withReserve.record({ costUsd: 0.001 }); if (++n > 1000) break; }
  assert.ok(withReserve.stats().spentUsd <= 0.03 + USD_EPSILON, `spent ${withReserve.stats().spentUsd}`);

  const without = createBudget({ limitUsd: 0.05 });
  let m = 0;
  while (without.canContinue().ok) { without.record({ costUsd: 0.001 }); if (++m > 1000) break; }
  assert.ok(m > n, 'no reserve must buy strictly more rounds');
});

test('the exact-fit boundary is inclusive — a round that exactly fits is allowed', () => {
  const b = createBudget({ limitUsd: 0.003, safetyFactor: 1 });
  b.record({ costUsd: 0.001 });
  b.record({ costUsd: 0.001 });
  const v = b.canContinue();
  assert.equal(Number(v.projectedUsd.toFixed(10)), 0.001);
  assert.equal(v.ok, true, 'spent 0.002 + projected 0.001 === the 0.003 limit, so it fits');
  b.record({ costUsd: 0.001 });
  const after = b.canContinue();
  assert.equal(after.ok, false);
  assert.equal(after.reason, 'limit-reached');
});

test('one cent short of exact fit refuses', () => {
  const b = createBudget({ limitUsd: 0.0029, safetyFactor: 1 });
  b.record({ costUsd: 0.001 });
  b.record({ costUsd: 0.001 });
  const v = b.canContinue();
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'would-exceed');
});

// ── missing cost data ───────────────────────────────────────────────────────

test('a round with tokens but no cost is priced from tokens and marked estimated', () => {
  const b = createBudget({ limitUsd: 1, usdPerMillionTokens: 0.3 });
  const rec = b.record({ tokens: 16000 });
  assert.equal(rec.source, 'tokens');
  assert.equal(rec.estimated, true);
  assert.equal(Number(rec.costUsd.toFixed(10)), 0.0048);
  assert.equal(b.stats().estimated, true);
  assert.equal(b.stats().estimatedRounds, 1);
  assert.match(b.report(), /estimate/i);
});

test('a round with NOTHING is charged the projection — unknown is never free', () => {
  const b = createBudget({ limitUsd: 1, firstRoundUsd: 0.0005, safetyFactor: 1 });
  const rec = b.record({});
  assert.equal(rec.source, 'projected');
  assert.equal(rec.estimated, true);
  assert.equal(rec.costUsd, 0.0005);
  assert.ok(b.stats().spentUsd > 0, 'a round we know nothing about must still move the meter');
});

test('a null usage object is the same unknown, not a free round', () => {
  const b = createBudget({ limitUsd: 1, firstRoundUsd: 0.0005, safetyFactor: 1 });
  b.record(null);
  b.record(undefined);
  assert.equal(b.stats().rounds, 2);
  assert.ok(b.stats().spentUsd >= 0.001, `spent ${b.stats().spentUsd}`);
});

test('unknown rounds cannot run forever — the budget still exhausts', () => {
  const b = createBudget({ limitUsd: 0.01 });
  let n = 0;
  while (b.canContinue().ok) { b.record({}); if (++n > 100000) break; }
  assert.ok(n < 100000, 'a run of totally unpriced rounds must still terminate');
  assert.ok(b.stats().spentUsd <= 0.01 + USD_EPSILON);
});

test('honours an explicit zero — a free model is free, not an estimate', () => {
  const b = createBudget({ limitUsd: 1 });
  const rec = b.record({ costUsd: 0, tokens: 900 });
  assert.equal(rec.costUsd, 0);
  assert.equal(rec.source, 'reported');
  assert.equal(rec.estimated, false);
  assert.equal(b.stats().spentUsd, 0);
  assert.equal(b.stats().estimated, false);
  assert.doesNotMatch(b.report(), /estimate/i);
});

test('a nonsense cost is not trusted, and never reduces the spend', () => {
  for (const costUsd of [-1, NaN, Infinity, '0.5', null]) {
    const b = createBudget({ limitUsd: 1, usdPerMillionTokens: 0.3 });
    b.record({ costUsd: 0.01 });
    const before = b.stats().spentUsd;
    const rec = b.record({ costUsd, tokens: 1000 });
    assert.notEqual(rec.source, 'reported', `costUsd=${String(costUsd)} must not be believed`);
    assert.ok(b.stats().spentUsd >= before, 'spend must be monotonic');
  }
});

test('the OpenRouter usage shape is accepted verbatim — wiring must be one line', () => {
  const b = createBudget({ limitUsd: 1 });
  const rec = b.record({ cost: 0.00231, total_tokens: 1036 });
  assert.equal(rec.source, 'reported');
  assert.equal(rec.costUsd, 0.00231);
  assert.equal(rec.tokens, 1036);
  assert.equal(b.stats().totalTokens, 1036);
});

test('costUsd/tokens win over cost/total_tokens when both are present', () => {
  const b = createBudget({ limitUsd: 1 });
  const rec = b.record({ costUsd: 0.002, cost: 0.009, tokens: 10, total_tokens: 99 });
  assert.equal(rec.costUsd, 0.002);
  assert.equal(rec.tokens, 10);
});

// ── the unlimited case (no flag given) ──────────────────────────────────────

test('no limit means no limit — but the meter still runs', () => {
  const b = createBudget({});
  assert.equal(b.canContinue().ok, true);
  assert.equal(b.canContinue().reason, 'no-budget-set');
  assert.equal(b.canContinue().remainingUsd, Infinity);
  b.record({ costUsd: 5 });
  assert.equal(b.canContinue().ok, true);
  assert.equal(b.stats().spentUsd, 5);
  assert.match(b.report(), /no limit set/);
  assert.doesNotMatch(b.report(), /left/);
});

test('an explicit null limit is the same as none', () => {
  assert.equal(createBudget({ limitUsd: null }).canContinue().reason, 'no-budget-set');
  assert.equal(createBudget({ limitUsd: undefined }).canContinue().reason, 'no-budget-set');
});

// ── huge / absurd but valid ─────────────────────────────────────────────────

test('a huge budget behaves like a budget, not like infinity', () => {
  const b = createBudget({ limitUsd: 1e6 });
  const v = b.canContinue();
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'ok');
  assert.ok(Number.isFinite(v.remainingUsd));
  assert.equal(v.remainingUsd, 1e6);
  b.record({ costUsd: 400000 });
  assert.equal(b.canContinue().ok, true, '$400k spent of $1M still affords another such round');
  b.record({ costUsd: 400000 });
  const after = b.canContinue();
  assert.equal(after.ok, false, 'a third $400k round would cross $1M, so it is refused');
  assert.equal(after.reason, 'would-exceed');
  assert.equal(after.remainingUsd, 200000);
});

test('a huge limit still stops eventually rather than becoming unlimited', () => {
  const b = createBudget({ limitUsd: 1e6 });
  let n = 0;
  while (b.canContinue().ok) { b.record({ costUsd: 1000 }); if (++n > 5000) break; }
  assert.ok(n < 5000, 'must terminate on money');
  assert.ok(b.stats().spentUsd <= 1e6 + USD_EPSILON);
  assert.ok(b.stats().spentUsd > 9e5, `should have used most of the budget, used ${b.stats().spentUsd}`);
});

// ── the clock ───────────────────────────────────────────────────────────────

test('time comes from the injected clock and nowhere else', () => {
  const clock = fakeClock(1_000);
  const b = createBudget({ limitUsd: 1, clock });
  clock.set(1_250);
  const rec = b.record({ costUsd: 0.001 });
  assert.equal(rec.at, 1_250);
  clock.set(4_000);
  assert.equal(b.canContinue().elapsedMs, 3_000);
  assert.equal(b.stats().startedAt, 1_000);
  assert.equal(b.stats().elapsedMs, 3_000);
});

test('the source itself contains no ambient time or randomness', () => {
  const src = readFileSync(new URL('../lib/budget.mjs', import.meta.url), 'utf8');
  assert.equal(/Math\.random/.test(src), false, 'no randomness anywhere');
  assert.equal(/Date\.now\(/.test(src), false, 'Date.now must never be CALLED inside the logic');
  assert.match(src, /clock = Date\.now/, 'only as the injectable default');
});

// ── reporting ───────────────────────────────────────────────────────────────

test('report() is one honest line', () => {
  const b = createBudget({ limitUsd: 0.05 });
  for (let i = 0; i < 4; i += 1) b.record({ costUsd: 0.0012 });
  assert.equal(
    b.report(),
    'budget: $0.0048 of $0.0500 spent · 4 rounds · next ~$0.0013 · $0.0452 left',
  );
});

test('report() flags an estimated total and counts the blind rounds', () => {
  const b = createBudget({ limitUsd: 0.05 });
  b.record({ costUsd: 0.0012 });
  b.record({ tokens: 1000 });
  b.record({ costUsd: 0.0012 });
  const line = b.report();
  assert.match(line, /^budget: /);
  assert.match(line, /1 of 3 rounds reported no cost/);
  assert.match(line, /estimate/);
});

test('report() says "round" for exactly one', () => {
  const b = createBudget({ limitUsd: 0.05 });
  b.record({ costUsd: 0.0012 });
  assert.match(b.report(), /· 1 round ·/);
});

test('the refusal messages name the numbers a user needs to act on', () => {
  const b = createBudget({ limitUsd: 0.005 });
  while (b.canContinue().ok) b.record({ costUsd: 0.001 });
  const v = b.canContinue();
  assert.match(v.message, /\$0\.00/);
  assert.match(v.message, /budget/i);
  assert.ok(BUDGET_REASONS.includes(v.reason));
});

test('toJSON is plain data a --json flag can print', () => {
  const clock = fakeClock(0);
  const b = createBudget({ limitUsd: 0.05, reserveUsd: 0.01, clock });
  b.record({ costUsd: 0.002, tokens: 500 });
  clock.set(120);
  const j = b.toJSON();
  assert.deepEqual(Object.keys(j).sort(), [
    'elapsedMs', 'estimated', 'estimatedRounds', 'limitUsd', 'projectedUsd',
    'remainingUsd', 'reserveUsd', 'rounds', 'spentUsd', 'totalTokens',
  ]);
  assert.equal(j.limitUsd, 0.05);
  assert.equal(j.reserveUsd, 0.01);
  assert.equal(j.rounds, 1);
  assert.equal(j.totalTokens, 500);
  assert.equal(j.elapsedMs, 120);
  assert.equal(JSON.parse(JSON.stringify(j)).spentUsd, 0.002);
});

test('history() hands back a copy — a caller cannot rewrite the ledger', () => {
  const b = createBudget({ limitUsd: 1 });
  b.record({ costUsd: 0.002 });
  const h = b.history();
  h[0].costUsd = 999;
  h.push({ costUsd: 999 });
  assert.equal(b.stats().spentUsd, 0.002);
  assert.equal(b.history().length, 1);
  assert.equal(b.history()[0].costUsd, 0.002);
});

// ── formatting ──────────────────────────────────────────────────────────────

test('formatUsd never prints a confident zero for a nonzero amount', () => {
  assert.equal(formatUsd(0), '$0.0000');
  assert.equal(formatUsd(0.05), '$0.0500');
  assert.equal(formatUsd(0.0048), '$0.0048');
  assert.equal(formatUsd(0.00005), '$0.000050');
  assert.equal(formatUsd(0.0000001), '$0.00000010');
  assert.equal(formatUsd(1e-15), '<$0.00000001');
  assert.equal(formatUsd(NaN), '$?');
  assert.equal(formatUsd('x'), '$?');
});

// ── the CLI flag parser (so wiring stays ten lines) ─────────────────────────

test('parseBudgetUsd reads the shapes a human types', () => {
  assert.deepEqual(parseBudgetUsd('0.50'), { ok: true, usd: 0.5 });
  assert.deepEqual(parseBudgetUsd('$0.50'), { ok: true, usd: 0.5 });
  assert.deepEqual(parseBudgetUsd(' .5 '), { ok: true, usd: 0.5 });
  assert.deepEqual(parseBudgetUsd('25c'), { ok: true, usd: 0.25 });
  assert.deepEqual(parseBudgetUsd('25C'), { ok: true, usd: 0.25 });
  assert.deepEqual(parseBudgetUsd('1'), { ok: true, usd: 1 });
  assert.deepEqual(parseBudgetUsd('1,000'), { ok: true, usd: 1000 });
  assert.deepEqual(parseBudgetUsd('2usd'), { ok: true, usd: 2 });
});

test('parseBudgetUsd refuses what it cannot read, with a usable message', () => {
  for (const raw of ['', 'lots', '0', '-1', '$', 'abc0.5', '0.5.5', null, undefined, 5, {}]) {
    const r = parseBudgetUsd(raw);
    assert.equal(r.ok, false, `"${String(raw)}" must not parse`);
    assert.match(r.message, /budget/i);
  }
});

test('a parsed budget drives createBudget directly', () => {
  const parsed = parseBudgetUsd('25c');
  assert.equal(parsed.ok, true);
  const b = createBudget({ limitUsd: parsed.usd });
  assert.equal(b.canContinue().remainingUsd, 0.25);
});

// ── the constants are the measured ones ─────────────────────────────────────

test('the defaults are the measured numbers, not vibes', () => {
  assert.equal(typeof DEFAULT_FIRST_ROUND_USD, 'number');
  assert.ok(DEFAULT_FIRST_ROUND_USD > 0.000231, 'must sit ABOVE the measured $0.000231 round');
  assert.ok(DEFAULT_USD_PER_MILLION_TOKENS > 0.223, 'must sit ABOVE the measured $0.223/M');
  assert.equal(DEFAULT_TREND_WINDOW, 3);
  assert.ok(DEFAULT_SAFETY_FACTOR >= 1);
  assert.ok(USD_EPSILON > 0 && USD_EPSILON < 1e-9);
});
