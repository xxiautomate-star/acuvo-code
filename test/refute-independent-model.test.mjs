/**
 * ── ⚠️⚠️ THE SECOND OPINION WAS THE SAME BRAIN ─────────────────────────────
 *
 * `refuteClaim` passed the caller's `config` straight through, so the reviewer
 * ran on THE SAME MODEL that produced the claim. That is not a second opinion,
 * it is the same opinion asked twice. A model's mistakes are not random noise —
 * they come from its training — so a second sample from the same distribution
 * reproduces them. The one case a reviewer exists for, a blind spot, is exactly
 * the case where an identical reviewer is guaranteed to share it.
 *
 * ⭐⭐ AND THE MEASUREMENT OVERTURNED THE REASONING. I ordered the candidates
 * with `z-ai/glm-4.6` first, arguing it was the strongest coder and the
 * reviewer's job is the harder half. An A/B on identical correct work — all
 * three asked to refute the same TRUE claim, so the right answer was NOT
 * REFUTED — said otherwise:
 *
 *   z-ai/glm-4.6        no verdict (3 of 3)   $0.004348
 *   deepseek-v4-flash   NOT REFUTED ✔         $0.000909   ← the same brain
 *   qwen/qwen3.7-flash  NOT REFUTED ✔         $0.000486
 *
 * GLM never produced a parseable verdict, so its answer decided nothing while
 * costing nine times the winner. Qwen is independent, obeys the format, and is
 * 47% CHEAPER than the same-brain reviewer it replaces — independence stopped
 * being a cost and became a discount.
 *
 * End to end on the real CLI afterwards: reviewer `qwen/qwen3.7-flash`,
 * `independent: true`, verdict "could not refute", and **$0.001042 total** for
 * a task built AND independently reviewed.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  chooseRefuteModel, familyOf, REFUTE_CANDIDATES, REFUTE_MODEL_ENV,
  refuteClaim, refutationField, formatRefutation,
} from '../lib/refute.mjs';

const BUILDER = 'deepseek/deepseek-v4-flash-0731';

test('⚠️⚠️ the reviewer is NOT the builder — the whole point of a second opinion', () => {
  const r = chooseRefuteModel(BUILDER, {});
  assert.notEqual(r.model, BUILDER, 'the claim would be checked by its own author');
  assert.equal(r.independent, true);
});

test('⚠️⚠️ FAMILY, not model id — deepseek-pro reviewing deepseek-flash is not independent', () => {
  /**
   * ⭐ THE ASSERTION AN ID COMPARISON WOULD HAVE FAILED. `-pro` and `-flash`
   * are different ids that share a lineage and therefore share blind spots.
   * Comparing ids would have called that an independent review.
   */
  assert.equal(familyOf('deepseek/deepseek-v4-pro-0813'), familyOf('deepseek/deepseek-v4-flash-0731'));
  const r = chooseRefuteModel('deepseek/deepseek-v4-pro-0813', {});
  assert.equal(familyOf(r.model) === 'deepseek', false, 'the reviewer came from the builder\'s own family');
});

test('⭐⭐ qwen leads the list — MEASURED, not reasoned', () => {
  /**
   * Pinned deliberately. The order encodes an A/B result, so a future edit that
   * reorders it on a hunch — as my first version did — has to argue with a
   * measurement rather than with a comment.
   */
  assert.equal(REFUTE_CANDIDATES[0], 'qwen/qwen3.7-flash',
    'GLM produced no parseable verdict in 3 of 3 runs at 9x the cost; qwen won on verdict AND price');
  assert.equal(chooseRefuteModel(BUILDER, {}).model, 'qwen/qwen3.7-flash');
});

test('⚠️ every candidate is one this package ALREADY falls back to in production', () => {
  // buildChain's defaults are deepseek-chat, z-ai/glm-4.6, qwen3.7-flash.
  // Nothing here is adopted on a hunch, which is the bar for a new dependency
  // on somebody else's model.
  for (const m of REFUTE_CANDIDATES) {
    assert.match(m, /^(qwen|z-ai|deepseek)\//, `${m} is not a family this package already trusts`);
  }
});

test('⭐ the rule survives ANY builder — it is not a hardcoded pair', () => {
  // A constant would silently become self-review the moment somebody sets
  // --model to that same id. Every family must get a reviewer from another one.
  /**
   * ⚠️ THE IDS HERE MATTER. A first version listed only EXACT candidate ids
   * ('qwen/qwen3.7-flash'), and a mutation replacing the family check with an id
   * check SURVIVED — because skipping 'the same id' and skipping 'the same
   * family' agree when the builder IS the candidate. The entries below are
   * models in a candidate's family with a DIFFERENT id, which is the only shape
   * that tells the two rules apart, and the realistic one: nobody's builder is
   * pinned to our reviewer's exact id.
   */
  for (const builder of ['qwen/qwen3-max', 'z-ai/glm-5.2', 'deepseek/deepseek-v4-flash-0731', 'openai/gpt-5']) {
    const r = chooseRefuteModel(builder, {});
    assert.equal(r.independent, true, `${builder} was reviewed by its own family`);
    assert.notEqual(familyOf(r.model), familyOf(builder), builder);
  }
});

test('⚠️⚠️ an explicit override wins — but a same-family one is reported as NOT independent', () => {
  /**
   * Someone pinning both to one model has a reason; they must not also get a
   * stronger-sounding verdict for it. The lie would be silent, which is the
   * kind this package keeps finding in itself.
   */
  const same = chooseRefuteModel(BUILDER, { [REFUTE_MODEL_ENV]: 'deepseek/deepseek-chat' });
  assert.equal(same.model, 'deepseek/deepseek-chat', 'the override must be honoured');
  assert.equal(same.independent, false, 'same family reported as independent');
  assert.match(same.why, /not independent/i);

  const other = chooseRefuteModel(BUILDER, { [REFUTE_MODEL_ENV]: 'qwen/qwen3.7-flash' });
  assert.equal(other.independent, true);
});

test('⚠️ an unknown builder still gets a reviewer rather than crashing', () => {
  for (const weird of ['', null, undefined, 'no-slash-model']) {
    const r = chooseRefuteModel(weird, {});
    assert.equal(typeof r.model, 'string');
    assert.ok(r.model.length > 0, `no reviewer chosen for ${JSON.stringify(weird)}`);
  }
});

test('⚠️⚠️ REACH: refuteClaim actually HANDS the reviewer model to the session', async () => {
  /**
   * ⭐ THE TEST THAT GUARDS THE FIX. Every assertion above is about a pure
   * function; the defect was that `refuteClaim` never used it. This drives the
   * real function with an injected session and reads the config it was handed.
   */
  let seen = null;
  const outcome = { ok: true, content: 'NOT REFUTED: ran the tests and they pass', usage: { cost: 0.0004 }, roundsUsed: 2 };
  const r = await refuteClaim({
    task: 'build a thing',
    claim: 'I built the thing',
    executor: { root: null, dryRun: false },
    config: { apiKey: 'k', model: BUILDER, gatewayUrl: 'https://x/y' },
    /**
     * ⚠️ THE PRECONDITION THE SIGNAL GATE ADDED. A refutation may only run once
     * an external signal is in hand — critiquing blind is measured to make
     * answers worse — so this hands over the builder's own `npm test` record
     * rather than letting a unit test spawn a process.
     */
    executed: [{ name: 'run_command', args: { command: 'npm test' }, result: { ok: true, command: 'npm test', exitCode: 0 } }],
    sessionImpl: async (opts) => { seen = opts.config; return outcome; },
    env: {},
  });

  assert.notEqual(seen.model, BUILDER, 'the reviewer ran on the builder\'s own model');
  assert.equal(seen.model, 'qwen/qwen3.7-flash');
  assert.equal(seen.apiKey, 'k', 'every OTHER config value must survive — only the model moves');
  assert.equal(seen.gatewayUrl, 'https://x/y');
  assert.equal(r.reviewerModel, 'qwen/qwen3.7-flash');
  assert.equal(r.independent, true);
});

test('⚠️⚠️ the JSON document carries WHO checked it — a gate cannot weigh evidence it cannot see', () => {
  /**
   * ⚠️ CAUGHT BY RUNNING IT, NOT BY READING IT. `refuteClaim` computed both
   * fields and `refutationField` dropped them, so the machine-readable document
   * said a check had happened and never said by whom. `--json --refute` is the
   * CI shape — the one place nobody watches the terminal.
   */
  const doc = refutationField(true, {
    ok: true, refuted: false, unclear: false, reason: 'ran the tests',
    costUsd: 0.0005, roundsUsed: 2, reviewerModel: 'qwen/qwen3.7-flash', independent: true,
  });
  assert.equal(doc.reviewerModel, 'qwen/qwen3.7-flash');
  assert.equal(doc.independent, true);

  // And a same-brain review must be visibly different in the document.
  const weak = refutationField(true, { ok: true, refuted: false, reviewerModel: BUILDER, independent: false });
  assert.equal(weak.independent, false);
});

test('⚠️ the human line does not present a self-review as clearance', () => {
  const independent = formatRefutation({ ok: true, refuted: false, independent: true, reason: 'tests pass' });
  assert.doesNotMatch(independent, /weaker/i);

  const weak = formatRefutation({ ok: true, refuted: false, independent: false, reason: 'tests pass' });
  assert.match(weak, /same model/i, '"✔ could not refute it" from the author reads as clearance and is not');
  assert.match(weak, /weaker/i);
});

test('⭐ a REFUTED verdict is not softened by the independence wording', () => {
  // The weaker-check note belongs only on the clearance line. A refutation is a
  // refutation whoever found it.
  const r = formatRefutation({ ok: true, refuted: true, independent: false, reason: 'the test does not exist' });
  assert.match(r, /REFUTES IT/);
  assert.doesNotMatch(r, /weaker/i);
});
