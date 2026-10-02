/**
 * ── ⭐⭐⭐ WHICH END OF THE TRANSCRIPT GETS CUT IS A MONEY DECISION ───────────
 *
 * A prompt cache pays for a byte-identical run from offset 0, so the ONLY thing
 * that decides what a compaction costs is the LOWEST message index it rewrote.
 * The saving is the same wherever the cut lands; the bill is not.
 *
 * ⚠️ MEASURED ON THIS FILE'S OWN FIXTURE, before the ordering change. The three
 * "provably dead" passes iterated OLDEST FIRST, so a compaction that needed to
 * rewrite ONE result rewrote the very first one and voided everything behind it:
 *
 *     budget    tokens          rewrote   firstIndex   prefix still cacheable
 *     46,000    47,066→45,641      1        3 of 62            2.2%
 *     44,000    47,066→42,792      3        3 of 62            2.2%
 *     42,000    47,066→41,368      4        3 of 62            2.2%
 *     40,000    47,066→39,944      5        3 of 62            2.2%
 *
 * ⭐ AFTER — identical savings (they differ by one token of rounding), and the
 * cut moved to the far end of the transcript:
 *
 *     46,000    47,066→45,642      1       57 of 62           90.3%
 *     44,000    47,066→42,793      3       45 of 62           70.7%
 *     42,000    47,066→41,369      4       39 of 62           60.9%
 *     40,000    47,066→39,945      5       33 of 62           51.1%
 *
 * ⚠️ AND IT COSTS NO CONTEXT, WHICH IS THE RULE THAT OUTRANKS THE CACHE. These
 * three passes target content that is dead AS A MATTER OF FACT — an identical
 * later read exists, the identical command was re-run, the files a search found
 * were subsequently opened. Choosing between two provably dead results is not a
 * quality judgement, so age is not a tie-break worth paying a cache miss for.
 * `giant-results` is deliberately NOT reversed and is asserted below, because
 * that one cuts into the only copy of live information.
 *
 * ⚠️ THE FAILURE MODE THIS PINS IS A TIDY-UP. Reinstating transcript order would
 * look like a simplification, break no test that existed before today, and cost
 * money forever with nothing reporting it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { compactMessages, structuralFingerprint, verifyToolPairing } from '../lib/compact.mjs';

/** Deterministic filler — no clock, no randomness, so two runs are identical. */
function filler(seed, chars) {
  const unit = `line ${seed} :: ${'x'.repeat(40)}\n`;
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

/**
 * A long agentic transcript in which every third round RE-READS a file it read
 * two rounds earlier — so `superseded-reads` has candidates spread across the
 * whole history rather than bunched at one end.
 */
function transcript({ rounds = 30, chars = 6_000 } = {}) {
  const messages = [
    { role: 'system', content: filler('sys', 4_000) },
    { role: 'user', content: 'Task: do the work' },
  ];
  for (let i = 1; i <= rounds; i += 1) {
    const path = i % 3 === 0 ? `src/f${i - 2}.ts` : `src/f${i}.ts`;
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `c${i}`, function: { name: 'read_file', arguments: JSON.stringify({ path }) } }],
    });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, name: 'read_file', content: filler(path, chars) });
  }
  return messages;
}

test('a partial compaction cuts the NEWEST dead result, not the oldest', () => {
  const messages = transcript();
  const { report } = compactMessages(messages, { budgetTokens: 46_000, keepLastRounds: 2 });

  assert.equal(report.actions.length, 1, 'this budget needs exactly one rewrite');
  assert.equal(report.passes.find((p) => p.pass === 'superseded-reads').applied, 1);

  /**
   * ⚠️ THE ASSERTION IS ABOUT POSITION, NOT ABOUT A CONSTANT. Pinning
   * `firstRewrittenIndex === 57` would break the day the fixture changes shape
   * and would teach nothing; "it is in the back half" is the property.
   */
  assert.ok(
    report.firstRewrittenIndex > messages.length / 2,
    `expected the cut in the back half of ${messages.length} messages, got index ${report.firstRewrittenIndex}`,
  );
});

test('the surviving prompt-cache prefix is REPORTED, so the trade stops being invisible', () => {
  const messages = transcript();
  const { report } = compactMessages(messages, { budgetTokens: 44_000, keepLastRounds: 2 });

  assert.equal(typeof report.prefixKeptFraction, 'number');
  assert.ok(report.prefixKeptFraction > 0 && report.prefixKeptFraction <= 1);
  /**
   * ⚠️ Oldest-first scored 2.2% here. Anything above half is only reachable by
   * cutting from the far end, so this number is the ordering, expressed as the
   * thing that actually bills.
   */
  assert.ok(
    report.prefixKeptFraction > 0.5,
    `expected over half the payload to stay cacheable, got ${report.prefixKeptFraction}`,
  );
  assert.ok(report.lines.some((l) => l.includes('valid') && l.includes('prompt-cache prefix')));
});

test('nothing was traded for it — the saving and the shape are unchanged', () => {
  const messages = transcript();
  const { messages: out, report } = compactMessages(messages, { budgetTokens: 40_000, keepLastRounds: 2 });

  // The budget is reached, which is the job.
  assert.equal(report.underBudget, true);
  assert.ok(report.afterTokens <= 40_000);
  // ⚠️ The invariant the whole module exists for: the conversation is the same
  // conversation, or an OpenAI-shaped provider 400s on every round after this.
  assert.equal(structuralFingerprint(out), structuralFingerprint(messages));
  assert.equal(verifyToolPairing(out).ok, true);
  assert.equal(report.refused, false);
});

test('`giant-results` stays oldest-first — it is the pass that cuts LIVE content', () => {
  /**
   * ⚠️ THIS IS NOT AN OVERSIGHT BEING PINNED, IT IS A DECISION. The three dead
   * passes lose nothing by cutting from the new end. This one clamps the middle
   * out of the only copy of a result, and the model's working set skews recent,
   * so age remains a real signal. A transcript with NO repeats gives the dead
   * passes nothing to do, and every rewrite is this pass.
   */
  const messages = [
    { role: 'system', content: filler('sys', 4_000) },
    { role: 'user', content: 'Task: do the work' },
  ];
  for (let i = 1; i <= 20; i += 1) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `c${i}`, function: { name: 'read_file', arguments: JSON.stringify({ path: `src/u${i}.ts` }) } }],
    });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, name: 'read_file', content: filler(`u${i}`, 6_000) });
  }

  const { report } = compactMessages(messages, { budgetTokens: 29_000, keepLastRounds: 2 });
  assert.ok(report.actions.length > 0);
  assert.equal(report.passes.find((p) => p.pass === 'superseded-reads').applied, 0);
  assert.ok(report.passes.find((p) => p.pass === 'giant-results').applied > 0);
  // The oldest compactable result is message index 3.
  assert.equal(report.firstRewrittenIndex, 3);
});

test('a transcript that already fits reports no cache cost at all', () => {
  const { report, dropped } = compactMessages(transcript({ rounds: 3, chars: 500 }), { budgetTokens: 24_000 });
  assert.equal(dropped, 0);
  assert.equal(report.firstRewrittenIndex, null);
  assert.equal(report.prefixKeptFraction, null);
});
