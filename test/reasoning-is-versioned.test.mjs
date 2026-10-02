/**
 * ── ⭐⭐⭐ THINKING IS ON FOR THE CODING MODEL, AND THE CLAIM IS DATED ────────
 *
 * The rule this pins replaces an UNDATED WILDCARD. On 2026-08-09 `deepseek-v4-*`
 * and `qwen3.7-*` were switched off together because they returned
 * `content: null` with no tool calls; the note named no version, and the comment
 * 30 lines below it in the same file ends *"Version the claim or do not make
 * it."* It then went unretested for three and a half weeks.
 *
 * Retested 2026-09-02 on the pinned id, driving the real CLI:
 *
 *   · 12 sampled completions on the largest round a coding run has (two whole
 *     files as tool-call arguments) → 0 empty replies in either setting.
 *   · A multi-file refactor OFF shipped a required parameter after a defaulted
 *     one and called it "preserves the existing default behavior" — `tsc` says
 *     `TS2554: Expected 4 arguments, but got 3`. ON removed the dead default and
 *     named the rule. ON also used `rename_symbol`; OFF hand-edited 9 strings.
 *   · Cost 1.11x-2.34x end to end, latency 2.5x-4x.
 *
 * ⚠️ THIS FILE EXISTS SO THE NEXT WIDENING IS DELIBERATE. Every id in the tables
 * is here with the reason it is there, so adding one means editing a test that
 * states what was measured.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reasoningField, REASONING_ON_MODELS, REASONING_OFF_MODELS } from '../lib/model.mjs';

const enabled = (model, env = {}) => reasoningField(model, env).reasoning?.enabled;

test('⭐ thinking is ON for the one id it was measured on', () => {
  assert.equal(enabled('deepseek/deepseek-v4-flash-0731', {}), true);
});

test('⚠️ and OFF for the two that were never retested', () => {
  /**
   * qwen3.7 is named in the original note as the worse offender and was not in
   * any 2026-09-02 sample. deepseek-v4-pro was not sampled either, and the
   * ladder is repointed off pro anyway (flash benchmarks 82.7; pro is worse).
   * Turning either on from THIS evidence would be the same undated wildcard
   * pointing the other way.
   */
  assert.equal(enabled('qwen/qwen3.7-flash', {}), false);
  assert.equal(enabled('deepseek/deepseek-v4-pro-0813', {}), false);
});

test('⚠️⚠️ the ON list is NOT a deepseek-v4 wildcard — a wildcard is what went stale', () => {
  /**
   * The whole failure being corrected is a rule that outlived the version it was
   * measured on. If someone later replaces these with `/deepseek-v4/`, this
   * assertion is what stops it being silent.
   */
  assert.equal(REASONING_ON_MODELS.length, 1);
  assert.ok(REASONING_ON_MODELS[0].test('deepseek/deepseek-v4-flash-0731'));
  assert.ok(!REASONING_ON_MODELS[0].test('deepseek/deepseek-v4-flash-0901'), 'a NEWER flash build must not inherit the claim');
  assert.ok(!REASONING_ON_MODELS[0].test('deepseek/deepseek-v4-pro-0813'));
  assert.equal(REASONING_OFF_MODELS.length, 2);
});

test('an unmeasured model keeps the field ABSENT — we do not guess for vendors we did not test', () => {
  assert.deepEqual(reasoningField('openai/gpt-4o', {}), {});
  assert.deepEqual(reasoningField('z-ai/glm-4.6', {}), {});
  assert.deepEqual(reasoningField('deepseek/deepseek-chat', {}), {});
  assert.deepEqual(reasoningField(null, {}), {});
});

test('⭐ ACUVO_REASONING=off restores the old behaviour in one line, for every model', () => {
  /**
   * This is the escape hatch that makes the change safe to ship pre-revenue:
   * thinking is a real cost increase, and reverting it must not need a deploy.
   */
  for (const m of ['deepseek/deepseek-v4-flash-0731', 'openai/gpt-4o', 'z-ai/glm-4.6']) {
    assert.equal(enabled(m, { ACUVO_REASONING: 'off' }), false, m);
    assert.equal(enabled(m, { ACUVO_REASONING: '0' }), false, m);
    assert.equal(enabled(m, { ACUVO_REASONING: 'false' }), false, m);
  }
});

test('⚠️ and ON forces it even for a model the table refuses — or the table can never be retested', () => {
  assert.equal(enabled('qwen/qwen3.7-flash', { ACUVO_REASONING: 'on' }), true);
  assert.equal(enabled('deepseek/deepseek-v4-pro-0813', { ACUVO_REASONING: '1' }), true);
  assert.equal(enabled('openai/gpt-4o', { ACUVO_REASONING: 'YES' }), true, 'case-insensitive');
});

test('⚠️ an unrecognised value is the DEFAULT, never a silent "on"', () => {
  /**
   * A typo in a shell profile must not change what the model does. The failure
   * direction matters: falling back to "on" would make a typo spend money.
   */
  assert.equal(enabled('deepseek/deepseek-v4-flash-0731', { ACUVO_REASONING: 'banana' }), true, 'the default for this id');
  assert.equal(enabled('qwen/qwen3.7-flash', { ACUVO_REASONING: 'banana' }), false, 'the default for this id');
  assert.deepEqual(reasoningField('openai/gpt-4o', { ACUVO_REASONING: 'banana' }), {}, 'still absent');
  assert.deepEqual(reasoningField('openai/gpt-4o', { ACUVO_REASONING: '  ' }), {});
});

test('⚠️ OFF wins over ON if an id ever matches both tables', () => {
  /**
   * Two hand-maintained lists can disagree. The safe reading of a mistake is the
   * OLD behaviour, so the order in `reasoningField` is load-bearing rather than
   * incidental — this asserts it rather than trusting it.
   */
  const bothLists = 'deepseek-v4-flash-0731-qwen3.7';
  assert.equal(REASONING_ON_MODELS.some((r) => r.test(bothLists)), true, 'the fixture really does match both');
  assert.equal(REASONING_OFF_MODELS.some((r) => r.test(bothLists)), true, 'the fixture really does match both');
  assert.equal(enabled(bothLists, {}), false, 'a table conflict falls back to off');
});
