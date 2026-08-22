/**
 * ── ⚠️⚠️ THE ADMIN COST CAP WAS ENFORCED BY NOTHING ─────────────────────────
 *
 * `costDecision` in policy.mjs is complete, careful, and had ZERO runtime
 * callers — imported only by its own test. PROVEN LIVE: a workspace
 * `.acuvo/policy.json` of `{"maxCostUsd": 0}` parsed correctly, and asked
 * directly the decision function returned `{stop: true, reason: "policy cost cap
 * reached"}` — while the actual run completed three rounds, wrote its file, and
 * spent money. The decision function said STOP into an empty room.
 *
 * ⭐ ITS SIBLING ALREADY LEARNED THIS. `roundBudget` exists because a round cap
 * returned as a NOTE and never applied is "an announcement of a limit that is
 * not enforced" — bin/acuvo.mjs says exactly that, three lines above where the
 * cost cap now gets applied. Same disease, same cure.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { costBudget } from '../lib/policy.mjs';
import { budgetWayOut, remainingForTurn } from '../lib/budget.mjs';

test('⭐⭐ a policy cap LOWERS the user ceiling', () => {
  const r = costBudget({ maxCostUsd: 0.05 }, 0.20);
  assert.equal(r.usd, 0.05);
  assert.equal(r.capped, true);
  assert.match(r.reason, /policy caps spend/);
});

test('⚠️⚠️ `0` MEANS ZERO, NOT ABSENT — the strictest policy must not read as no policy', () => {
  // `cap || requested` would turn the tightest possible cap into no cap at all,
  // silently. policy.test.mjs already pins that 0 means "spend nothing".
  const r = costBudget({ maxCostUsd: 0 }, 0.02);
  assert.equal(r.usd, 0);
  assert.equal(r.capped, true);
});

test('⭐ the admin cap NEVER raises a stricter user ceiling', () => {
  // An admin file spending more of the user's money than they asked for would be
  // as wrong as a user typing past the admin. It is a minimum in both directions.
  const r = costBudget({ maxCostUsd: 0.50 }, 0.01);
  assert.equal(r.usd, 0.01);
  assert.equal(r.capped, false);
  assert.equal(r.reason, null);
});

test('⚠️ a policy cap applies even when the user set no ceiling at all', () => {
  const r = costBudget({ maxCostUsd: 0.05 }, null);
  assert.equal(r.usd, 0.05);
  assert.equal(r.capped, true);
});

test('⭐ no policy leaves the request untouched, including null', () => {
  assert.deepEqual(costBudget({}, 0.02), { usd: 0.02, capped: false, reason: null });
  assert.deepEqual(costBudget({ maxCostUsd: null }, null), { usd: null, capped: false, reason: null });
});

/* ── the advice has to be TRUE ─────────────────────────────────────────────── */

test('⚠️⚠️ a POLICY ceiling must not tell the user to raise it with --budget', () => {
  /**
   * That advice cannot work: `costBudget` takes the MINIMUM, so --budget can
   * never exceed the policy. A refusal handing out a remedy guaranteed to fail
   * is worse than one with no advice — the user tries it, nothing changes, and
   * they conclude the tool is broken rather than governed.
   */
  const w = budgetWayOut({ limitUsd: 0, limitSource: 'policy' });
  assert.doesNotMatch(w, /raise it with --budget/i);
  assert.match(w, /policy\.json/);
});

test('⭐ the other two ceilings keep their existing wording', () => {
  assert.match(budgetWayOut({ limitUsd: 0.02, limitIsDefault: true }), /default ceiling/);
  assert.match(budgetWayOut({ limitUsd: 0.02, limitIsDefault: true }), /--budget none/);
  assert.match(budgetWayOut({ limitUsd: 0.5, limitIsDefault: false }), /Raise it with --budget/);
});

test('⚠️ the exhausted-session message carries the same true advice', () => {
  // Two refusal sites used to word this independently; a user meeting the policy
  // cap hits THIS one first, and it was the one giving impossible advice.
  const r = remainingForTurn(0, 0, { limitSource: 'policy' });
  assert.equal(r.ok, false);
  assert.match(r.message, /policy\.json/);
  assert.doesNotMatch(r.message, /Raise it with --budget,/);
});

test('⭐ an unbounded session is still unbounded', () => {
  assert.deepEqual(remainingForTurn(null, 5), { ok: true, remainingUsd: null });
});
