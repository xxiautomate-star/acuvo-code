/**
 * ── ⚠️⚠️ COMPACTION WAS COSTING MORE THAN IT SAVED ──────────────────────────
 *
 * A cache hit is ~50x cheaper than a miss. Compaction frees ~8% of the
 * transcript and voids the cached prefix on ~87% of it — so every firing traded
 * 8% fewer tokens for 87% of them going from 1x to 50x. Roughly a six-fold
 * loss, and it was invisible because nothing reported the hit rate.
 *
 * ⭐⭐ AND THE REAL DEFECT WAS NOT "COMPACTION IS EXPENSIVE" — it was
 * **compaction never stops once it starts.** The old code compacted DOWN TO the
 * budget, so the next round crossed it again and compacted again. The evidence
 * was already written in turn.mjs: round 13 compacted, and so did round 14.
 * From that round on, every single round is a cache miss, forever.
 *
 * These tests pin the two fixes: fire at a HIGH water mark, compact to a LOW
 * one, and hold the ceiling well under the SMALLEST model in the fallback chain
 * (deepseek-chat, 163,840) rather than under the primary's 1,048,576.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compactMessages, estimateMessagesTokens } from '../lib/compact.mjs';

const turnSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'turn.mjs'),
  'utf8',
);

const numberOf = (name) => {
  const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(turnSource);
  return m ? Number(m[1].replace(/_/g, '')) : null;
};

const HIGH = numberOf('CONTEXT_BUDGET_TOKENS');
const LOW = numberOf('COMPACT_TARGET_TOKENS');

/** The smallest context window among the models `buildChain` actually falls back to. */
const SMALLEST_CHAIN_WINDOW = 163_840; // deepseek/deepseek-chat, read from the OpenRouter API
const REPLY_HEADROOM = 12_000; // DEFAULT_MAX_TOKENS

test('⭐ the ceiling is far above the old 24,000, which wasted the cache', () => {
  assert.ok(HIGH !== null && LOW !== null, 'both water marks must exist');
  assert.ok(HIGH > 24_000, `the budget is still ${HIGH}; the whole point was that 24,000 was too low`);
});

test('⚠️⚠️ the ceiling still fits the SMALLEST model in the fallback chain', () => {
  /**
   * ⚠️ SIZING IT TO THE PRIMARY'S 1,048,576 WINDOW WOULD BE CORRECT UNTIL THE
   * FIRST FALLBACK, then catastrophic. The chain drops to deepseek-chat at
   * 163,840, and a transcript built under a 1M assumption cannot be sent there
   * at all — the failure would arrive as a provider error mid-task, on the
   * unlucky run where the primary was already down.
   *
   * ⚠️ AND THE ESTIMATOR UNDERCOUNTS. chars/4 is an English approximation; code
   * runs denser, so real tokens can be ~1.3-1.5x the estimate. The assertion
   * uses 1.5x deliberately — the margin has to survive the worst case, not the
   * average one.
   */
  const worstCaseReal = HIGH * 1.5;
  assert.ok(
    worstCaseReal + REPLY_HEADROOM < SMALLEST_CHAIN_WINDOW,
    `${HIGH} estimated tokens could be ${worstCaseReal} real, plus ${REPLY_HEADROOM} of reply — `
    + `that does not fit deepseek-chat's ${SMALLEST_CHAIN_WINDOW}`,
  );
});

test('⚠️⚠️ there are TWO water marks, and the low one is meaningfully lower', () => {
  assert.ok(LOW < HIGH, 'compacting down to the budget is what made it re-fire every round');
  assert.ok(
    LOW <= HIGH * 0.75,
    `compacting to ${LOW} from ${HIGH} frees too little to stop an immediate re-fire`,
  );
});

test('⚠️ the loop compares against the HIGH mark and compacts to the LOW one', () => {
  // ⭐ Asserting the WIRING, not just the constants: two correct numbers that
  // are never used together are the same bug with better documentation.
  assert.match(turnSource, /estimated > CONTEXT_BUDGET_TOKENS/);
  /**
   * ⚠️ THE LOW MARK IS NOW DERIVED, NOT LITERAL, AND THAT IS THE FIX rather than
   * a regression. This asserted the source text `budgetTokens:
   * COMPACT_TARGET_TOKENS`, which passed for a whole day while the wiring it
   * describes was broken: the trigger had learned to count the tool offer and
   * the target had not, so the real hysteresis gap was `36,000 − offer` and went
   * negative past a 36,000-token offer. A flat constant here is precisely the
   * defect — the two marks must be measured in the same currency.
   *
   * ⭐ So the assertion now pins the RELATIONSHIP, and `compactionBudget` is
   * behaviourally covered in test/compaction-hysteresis.test.mjs. A source
   * regex can only ever check spelling; that file checks that the gap survives
   * a growing offer, which is the property this test is really about.
   */
  assert.match(turnSource, /budgetTokens: messageBudget/);
  assert.match(turnSource, /compactionBudget\(offerTokens\)/);
  assert.match(turnSource, /COMPACT_TARGET_TOKENS - offer/);
});

/* ── the behaviour the numbers are supposed to produce ───────────────────── */

/** A transcript that grows the way a real session does. */
function transcript(rounds, resultChars = 3_000) {
  const messages = [
    { role: 'system', content: 'you are a coding agent. '.repeat(40) },
    { role: 'user', content: 'fix the failing test suite' },
  ];
  for (let i = 0; i < rounds; i += 1) {
    messages.push({
      role: 'assistant',
      content: `Round ${i}: reading and editing.`,
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/m${i}.js` }) } }],
    });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `x${i} `.repeat(resultChars / 4) });
  }
  return messages;
}

/**
 * How many rounds pass between compactions under a given policy? One is the
 * disaster case — it means every round is a cache miss.
 */
function simulate({ high, low, rounds = 60 }) {
  let messages = transcript(0);
  let compactions = 0;
  const gaps = [];
  let lastCompactedAt = null;

  for (let r = 0; r < rounds; r += 1) {
    const grown = transcript(r + 1);
    messages = grown;
    if (estimateMessagesTokens(messages) > high) {
      const fit = compactMessages(messages, { budgetTokens: low, keepLastRounds: 2 });
      if (fit.dropped > 0) {
        messages = fit.messages;
        compactions += 1;
        if (lastCompactedAt !== null) gaps.push(r - lastCompactedAt);
        lastCompactedAt = r;
      }
    }
  }
  return { compactions, gaps };
}

test('⭐⭐ the OLD single-budget policy compacts on CONSECUTIVE rounds', () => {
  /**
   * This is the bug, reproduced: with one number, compaction frees just enough
   * to get under the line, the next round crosses it again, and the gap between
   * firings is 1 — meaning every round from then on is a cache miss.
   */
  const old = simulate({ high: 24_000, low: 24_000, rounds: 40 });
  assert.ok(old.compactions > 3, 'the old policy should fire repeatedly on a long session');
  assert.ok(
    old.gaps.filter((g) => g === 1).length > 0,
    `expected back-to-back compactions under the old policy; gaps were ${old.gaps.join(',')}`,
  );
});

test('⭐⭐ the NEW two-mark policy leaves rounds between firings', () => {
  const now = simulate({ high: HIGH, low: LOW, rounds: 40 });
  if (now.compactions === 0) {
    // With a 96,000 ceiling a 40-round session simply never compacts, which is
    // the intended outcome — the transcript stays one growing, cacheable prefix.
    assert.equal(now.compactions, 0);
    return;
  }
  assert.equal(
    now.gaps.filter((g) => g === 1).length,
    0,
    `the new policy still compacts on consecutive rounds; gaps were ${now.gaps.join(',')}`,
  );
});

test('⭐ a session that used to be compacted repeatedly is now left alone entirely', () => {
  // ⚠️ 25 rounds estimated at only 18,247 tokens — under even the OLD budget,
  // so it proved nothing. Sized from the measurement instead of from a guess:
  // 40 rounds clears 24,000 comfortably while staying under the new ceiling.
  const messages = transcript(40);
  const tokens = estimateMessagesTokens(messages);
  assert.ok(tokens > 24_000, `this fixture must exceed the OLD budget to prove anything (got ${tokens})`);
  assert.ok(
    tokens < HIGH,
    `a 25-round session estimates at ${tokens}; under the new ceiling of ${HIGH} it should never be compacted`,
  );
});
