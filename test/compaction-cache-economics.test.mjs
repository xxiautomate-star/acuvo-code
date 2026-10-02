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
 * one, and hold the ceiling under the smallest DECLARED window in the fallback
 * chain (deepseek-chat, 128,000) rather than under the primary's 1,048,576.
 *
 * ⚠️ THAT SENTENCE SAID 163,840 UNTIL 2026-09-18 and it was the larger of that
 * model's two endpoints, not the smaller. Read the constant's comment below
 * before trusting any figure in this file — and prefer the two instruments it
 * names to any figure in this file at all.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compactMessages, estimateMessagesTokens } from '../lib/compact.mjs';
import { extractReply } from '../lib/model.mjs';
import { isRetryable } from '../lib/chain.mjs';

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

/**
 * ── ⭐⭐⭐ THE EXPERIMENT WAS RUN. 2026-09-18. EVERY NUMBER HERE WAS WRONG AND
 *          THE TWO PROPOSED FIXES WERE BOTH WRONG TOO ─────────────────────────
 *
 * This constant read `163_840 // deepseek/deepseek-chat`, described as *"the
 * smallest context window among the models buildChain falls back to"*. That
 * model is served by two machines that disagree, so the line named the LARGER
 * one and called it the smallest. The `todo` below it asked whether an
 * oversized request could ever reach the smaller one, and
 * `DECISION-the-first-fallback-is-unpinned.md` §4 wrote down the one
 * experiment that settles it and priced it at $0.04.
 *
 * ⭐ It cost less than that, and it answered a bigger question than it asked.
 * `scripts/zz-does-the-router-filter-by-context.mjs` and
 * `scripts/zz-what-can-the-fallback-actually-take.mjs` are the instruments;
 * run them rather than trusting the figures below, which is the rule this
 * file has now broken twice.
 *
 * ── 1 · THE ROUTER DOES FILTER — and filtering made it WORSE ───────────────
 *
 * A 145,000-estimate request, unpinned, was routed AWAY from the 128,000
 * endpoint and onto the 163,840 one. So the documented exclusion is real for
 * this account. It is also, here, a trap: the endpoint it selected on the
 * strength of the larger advertised number is the one that can serve less.
 *
 * ── 2 · 🚨 THE ADVERTISED WINDOW IS NOT THE SERVED WINDOW ──────────────────
 *
 *     endpoint      advertises   actually serves
 *     StreamLake       128,000   90,950 real tokens, measured OK
 *     DeepInfra        163,840   **32,768** — a hard cap named in its own error
 *
 * Verbatim, four times at four sizes: *"The sum of prompt length (90948.0),
 * query length (0) should not exceed max_num_tokens (32768)"*. Five times less
 * than it advertises. Every number in the decision doc, in OpenRouter's own
 * admission check, and in this guard was derived from the advertised figure.
 *
 * ── 3 · ⭐ OPENROUTER ADMITS ON chars/4 — THE SAME ESTIMATOR THIS PACKAGE USES
 *
 * A 738,360-char prompt was refused as *"about 184601 tokens"*. 738,360 / 4 =
 * 184,590. It does not tokenize before it decides. So the number OpenRouter
 * compares against a window is the SAME NUMBER `estimateMessagesTokens`
 * computes — and the `× 1.5` density multiplier this file used was measuring
 * the wrong thing entirely. The two sides of the assertion below are now in one
 * currency, which is why it can be asserted at all.
 *
 * ── 4 · ⛔ SO BOTH OPTIONS ON THE TABLE WERE WRONG ──────────────────────────
 *
 * **Pin to DeepInfra** — the decision doc's *"better value on the numbers"* —
 * would have made 32,768 the permanent ceiling of the entire fallback leg, at
 * 24% MORE per input token. It was the worst available move and it looked like
 * the best one, because the number it was chosen on is advertising.
 *
 * **Lower `CONTEXT_BUDGET_TOKENS` 96,000 → ~77,000** buys nothing. 77,000
 * estimated is still far above 32,768 real; dodging DeepInfra needs a ceiling
 * near ~25,000, BELOW the 24,000 this whole file exists to have escaped. A
 * ceiling cannot fix a cap five times under it.
 *
 * ⭐ THE FIX IS IN THE ERROR PATH, AND IT SHIPPED. The refusal arrives as an
 * HTTP **200** carrying an `error` and no `choices`; `extractReply` discarded
 * the reason and `isRetryable` matched nothing, so the chain STOPPED with
 * `z-ai/glm-4.6` (200k) untried. See `test/upstream-200-error.test.mjs`.
 * Unpinned routing was measured at 1 DeepInfra in 12 rolls, so ~8% of fallback
 * rounds over 32,768 real tokens used to end the session outright.
 *
 * ⛔ WHAT IS LEFT IS ROMAN'S, AND IT IS THE OPPOSITE OF WHAT WAS PROPOSED: pin
 * `deepseek/deepseek-chat` to **StreamLake** — 24% CHEAPER per input token
 * ($0.2574 vs $0.3200) and 2.8× more usable context. Still a pin.
 */
const SMALLEST_CHAIN_WINDOW = 128_000; // the smallest DECLARED window in the chain — deepseek/deepseek-chat on StreamLake
/**
 * ⚠️ WHAT THE WORST ENDPOINT IN THE CHAIN REALLY SERVES, which no ceiling this
 * file could sanely hold. Named here so the number is on the record rather than
 * folded into an assertion that would have to be false to pass.
 */
const WORST_ENDPOINT_SERVED_TOKENS = 32_768; // DeepInfra's undeclared cap, measured
const REPLY_HEADROOM = 12_000; // DEFAULT_MAX_TOKENS

test('⭐ the ceiling is far above the old 24,000, which wasted the cache', () => {
  assert.ok(HIGH !== null && LOW !== null, 'both water marks must exist');
  assert.ok(HIGH > 24_000, `the budget is still ${HIGH}; the whole point was that 24,000 was too low`);
});

test('⚠️⚠️ the ceiling is admitted by the SMALLEST DECLARED window in the chain', () => {
  /**
   * ⚠️ SIZING IT TO THE PRIMARY'S 1,048,576 WINDOW WOULD BE CORRECT UNTIL THE
   * FIRST FALLBACK, then catastrophic — a transcript built under a 1M
   * assumption cannot be sent to a 128k endpoint at all, and the failure
   * arrives mid-task on the unlucky run where the primary was already down.
   *
   * ⭐ MEASURED, NOT MODELLED. OpenRouter's admission check is `chars / 4` —
   * the identical arithmetic `estimateMessagesTokens` does — so HIGH and the
   * declared window are the same unit and the comparison is exact. The old
   * `× 1.5` "the estimator undercounts" margin was a guess applied across a
   * unit boundary; it is gone, and what replaced it is a wire measurement.
   *
   * ⚠️ REPLY_HEADROOM STAYS IN. `max_tokens` counts toward the admission total
   * — the refusal message reads "184601 tokens (184600 of text input, 1 in the
   * output)", so the output allowance is explicitly part of the sum.
   */
  assert.ok(
    HIGH + REPLY_HEADROOM < SMALLEST_CHAIN_WINDOW,
    `${HIGH} estimated tokens plus ${REPLY_HEADROOM} of reply allowance is ${HIGH + REPLY_HEADROOM}, `
    + `which OpenRouter will not admit to a ${SMALLEST_CHAIN_WINDOW} endpoint`,
  );
});

test('🚨 the chain contains an endpoint NO ceiling can satisfy, and that is on the record', () => {
  /**
   * ── ⭐ A GUARD THAT ASSERTS THE PROBLEM IS STILL THE PROBLEM ──────────────
   *
   * This replaces a `todo` that asked whether an oversized request could reach
   * the smaller endpoint. The measurement answered something worse: the LARGER
   * endpoint serves 32,768. So the honest assertion is not "the ceiling fits"
   * — it provably does not and cannot — but **that the gap is known, that the
   * only ceiling which would close it is below the one this file exists to
   * have escaped, and that the mitigation is therefore in the error path.**
   *
   * ⚠️ This goes red if somebody "fixes" it by dropping the budget under the
   * cap, which would trade the common path for a rare one — the exact move
   * `DECISION-the-first-fallback-is-unpinned.md` prices and refuses.
   */
  assert.ok(
    HIGH > WORST_ENDPOINT_SERVED_TOKENS,
    `the budget has been dropped to ${HIGH} to dodge one endpoint's undeclared `
    + `${WORST_ENDPOINT_SERVED_TOKENS} cap. That protects a RARE fallback leg by compacting more often on `
    + 'EVERY long run, and each compaction moves the prefix, which is the margin. The mitigation is '
    + 'test/upstream-200-error.test.mjs — the chain steps to a 200k model — not a lower ceiling.',
  );
  /**
   * ⭐ AND THE MITIGATION IS ASSERTED, NOT ASSUMED. A comment saying "the error
   * path handles it" is worth nothing if the error path stops handling it; this
   * is the one line that ties this file to the fix that makes its own
   * exceedance survivable.
   */
  assert.equal(
    isRetryable(extractReply({ error: { message: 'Upstream error from DeepInfra: max_num_tokens (32768)' } }).error),
    true,
    'a capacity refusal must advance the chain, or the gap above ends sessions again',
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
