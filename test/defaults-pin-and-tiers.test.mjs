/**
 * ── ⭐⭐ CACHING MADE REAL, AND MODEL SWITCHING MADE REAL ────────────────────
 *
 * Two defaults that were built, correct, and switched off.
 *
 * THE PIN. 28 upstream endpoints serve our model and a prompt cache lives on ONE
 * instance, so unpinned we were re-routed across all of them. MEASURED, same
 * task, same day: unpinned 48.6% / 46.7% cache at $0.002217; pinned 73.7% /
 * 95.8% at $0.000910 — 2.4x cheaper. And 1 of the 28 endpoints publishes no
 * cache-read price at all, so unpinned a run can land where nothing caches and
 * nothing says so.
 *
 * THE TIERS. The ladder climbed solo → fresh → best-of with the SAME cheap model
 * on every rung, so the loop got more determined and never got smarter. 19 of 19
 * runs measured on flash with the stronger rungs off — every benchmark number
 * this package holds is a floor taken with one hand tied.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { DEFAULT_PROVIDER_ORDER, callModel } from '../lib/model.mjs';
import { parseTiers, modelForRung, DEFAULT_ESCALATION_MODEL } from '../lib/model-tier.mjs';

test('⭐⭐ a provider is pinned by default — caching is not left to luck', () => {
  assert.ok(DEFAULT_PROVIDER_ORDER.trim().length > 0, 'an empty default is the unpinned routing lottery');
});

test('⚠️⚠️ the pin is overridable, and an empty override really unpins — through the REAL callModel', async () => {
  /**
   * ⚠️ THE FIRST VERSION OF THIS TEST REIMPLEMENTED THE EXPRESSION LOCALLY and
   * therefore verified its own copy. It asserted that an explicit empty string
   * unpins, PASSED, while the real `callModel` had exactly that bug — a `??`
   * that let an explicit '' fall through to the default, so the off switch did
   * not switch anything off. A test that copies the logic it is checking is not
   * a test of the logic.
   */
  /**
   * ── ⚠️⚠️ THIS TEST'S PREMISE CHANGED, AND THE CHANGE WAS THE BUG ──────────
   *
   * It drove `callModel` with a model literally named `'m'` and asserted that
   * it inherited `DEFAULT_PROVIDER_ORDER` — i.e. that EVERY model gets flash's
   * pin. That is precisely the defect: `StreamLake` does not serve
   * `deepseek-v4-pro-0813` at all, so pro asked for a provider that could not
   * answer, matched nothing, and routed freely. Measured on the 13-task bench:
   * **pro was served by GMICloud 13 of 13 times**, at 2.8x DeepSeek's own
   * price on tokens and 28x on cache reads.
   *
   * ⭐ The pin is now PER MODEL, and an unknown model is left UNPINNED rather
   * than handed a pin that cannot be honoured. So the "unset" case is asserted
   * against a model we have actually measured. Everything this test really
   * cared about — that an override wins and that an explicit empty string
   * really unpins — is unchanged below.
   */
  const sent = [];
  const fake = async (_u, o) => { sent.push(JSON.parse(o.body)); return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }) }; };
  const call = (env, model = 'deepseek/deepseek-v4-flash-0731') => callModel({ apiKey: 'k', model, messages: [{ role: 'user', content: 'hi' }], tools: [], fetchImpl: fake, env });

  await call({});
  // The warm attempt is a whitelist, not an ordering — a manual `provider.order`
  // disables OpenRouter's sticky routing, which is what pins the actual server.
  assert.equal(sent[0].provider.only[0], DEFAULT_PROVIDER_ORDER, 'unset inherits the pin measured for THIS model');

  await call({ ACUVO_PROVIDER_ORDER: 'DeepInfra' });
  assert.deepEqual(sent[1].provider.only, ['DeepInfra'], 'an explicit name wins');

  await call({ ACUVO_PROVIDER_ORDER: '' });
  assert.equal('provider' in sent[2], false, 'an explicit empty string must send NO provider block at all');
});

test('⭐⭐ the ladder escalates the MODEL, not only the effort', () => {
  const tiers = parseTiers('deepseek/deepseek-v4-flash-0731', {});
  assert.equal(tiers.length, 2, 'a single-entry ladder is the old behaviour: more determined, never smarter');
  assert.equal(tiers[0], 'deepseek/deepseek-v4-flash-0731', 'rung zero stays whatever the user configured');
  assert.equal(tiers[1], DEFAULT_ESCALATION_MODEL);
});

test('⚠️ rung zero is NEVER replaced — the base model is the user\'s choice', () => {
  // This adds a rung above; it must not silently swap the model somebody set.
  for (const base of ['z-ai/glm-4.6', 'qwen/qwen3.7-flash', 'anything/at-all']) {
    assert.equal(modelForRung(0, parseTiers(base, {})), base, base);
  }
});

test('⚠️⚠️ a base that IS the escalation model does not list it twice', () => {
  /**
   * `modelForRung` reuses the LAST tier for rungs beyond the list, so a
   * duplicate would render as an escalation that is not happening — the summary
   * would announce a model switch from pro to pro.
   */
  const tiers = parseTiers(DEFAULT_ESCALATION_MODEL, {});
  assert.deepEqual(tiers, [DEFAULT_ESCALATION_MODEL]);
});

test('⭐ an explicit ACUVO_MODEL_TIERS still wins, including a single id to switch it off', () => {
  assert.deepEqual(parseTiers('base', { ACUVO_MODEL_TIERS: 'a,b,c' }), ['a', 'b', 'c']);
  // One id = every rung on that model = the pre-default behaviour, on purpose.
  assert.deepEqual(parseTiers('base', { ACUVO_MODEL_TIERS: 'only-this' }), ['only-this']);
});

test('⭐ the escalation model is the DATED snapshot, which is 2.7x cheaper', () => {
  /**
   * MEASURED from the live endpoint feed: `deepseek-v4-pro-0813` is $0.435/M and
   * the undated `deepseek-v4-pro` pointer is $1.168/M — same family, 2.7x the
   * price. Pinning the snapshot is cheaper AND reproducible: a moving pointer
   * under a benchmark is how a "regression" appears that nobody caused.
   */
  assert.match(DEFAULT_ESCALATION_MODEL, /-\d{4}$/, 'the escalation model must be a pinned snapshot, not a moving pointer');
  assert.match(DEFAULT_ESCALATION_MODEL, /pro/, 'escalating to another flash model would buy nothing');
});

test('⚠️ every rung above the list reuses the top model, never wraps', () => {
  const tiers = parseTiers('flash', {});
  assert.equal(modelForRung(1, tiers), DEFAULT_ESCALATION_MODEL);
  assert.equal(modelForRung(2, tiers), DEFAULT_ESCALATION_MODEL, 'rung 2 must not wrap back to flash');
  assert.equal(modelForRung(9, tiers), DEFAULT_ESCALATION_MODEL);
});
