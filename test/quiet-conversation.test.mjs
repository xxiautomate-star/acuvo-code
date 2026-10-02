/**
 * ── ⭐⭐⭐ A CONVERSATION MUST NOT REPORT LIKE A BUILD ────────────────────────
 *
 * Roman asked "hi how are you" and got a round header, the answer twice, "No
 * files changed", "⚠ NOTHING WAS RUN, so nothing here is verified", a token
 * count, a cache percentage and a budget ledger. *"it shouldn't say that stuff."*
 *
 * ⚠️ EVERY ONE OF THOSE LINES IS CORRECT, which is why this is a design test
 * rather than a bug fix. They exist because a BUILD that silently changed
 * nothing, or claimed a test passed without running it, is an expensive lie.
 * Aimed at a greeting they are noise — and noise is how a user learns to stop
 * reading the warnings that matter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSummary, isConversationalTurn } from '../lib/turn.mjs';

const chat = () => ({
  ok: true,
  executed: [],
  model: 'deepseek/deepseek-v4-flash-0731',
  usage: { cost: 0.0036, total_tokens: 25785, cache: { cachedTokens: 0, promptTokens: 25725 } },
  budgetReport: 'budget: $0.0036 of $0.0500 spent',
  allowRun: true,
  maxRounds: 24,
  roundsUsed: 1,
});

test('⭐⭐⭐ a turn that wrote and ran nothing prints no accounting at all', () => {
  const out = formatSummary(chat()).join('\n');
  for (const noise of ['No files changed', 'NOTHING WAS RUN', 'tokens', 'cache', 'budget:']) {
    assert.ok(!out.includes(noise), `a greeting still printed "${noise}":\n${out}`);
  }
});

test('⭐⭐ writing ONE file brings every line back', () => {
  /**
   * The rule is "report what happened", not "be quiet". The instant a turn does
   * something, the honesty machinery returns — including on the very next turn
   * of the same session.
   */
  const out = formatSummary({
    ...chat(),
    executed: [{ name: 'write_file', mutated: true, result: { ok: true, path: 'a.js' } }],
  }).join('\n');
  assert.match(out, /tokens/, 'the cost line vanished on a turn that wrote a file');
  assert.match(out, /budget:/, 'the budget line vanished on a turn that wrote a file');
});

test('⭐⭐ running a COMMAND brings them back too, even with no file written', () => {
  const out = formatSummary({
    ...chat(),
    executed: [{ name: 'run_command', result: { ok: true } }],
  }).join('\n');
  assert.equal(isConversationalTurn({ ...chat(), executed: [{ name: 'run_command', result: { ok: true } }] }), false);
  assert.match(out, /tokens/);
});

test('⚠️⚠️ a FAILED turn is never quiet — it did something and must say so', () => {
  /**
   * Quiet applies only to the accounting of a turn that did nothing. Suppressing
   * anything on a failure would hide the one report the user actually needs.
   */
  const failed = { ...chat(), ok: false, error: 'the provider refused the key' };
  assert.equal(isConversationalTurn(failed), false);
  assert.match(formatSummary(failed).join('\n'), /provider refused/);
});

test('⚠️ a DRY RUN is not conversational — it was asked to do something', () => {
  const dry = {
    ...chat(),
    executed: [{ name: 'write_file', mutated: true, result: { ok: true, dryRun: true, path: 'a.js' } }],
  };
  assert.equal(isConversationalTurn(dry), false);
});
