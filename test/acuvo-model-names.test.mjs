/**
 * ── ⭐⭐ OUR MODELS HAVE OUR NAMES ───────────────────────────────────────────
 *
 * Everywhere a user could see a model, they saw `deepseek/deepseek-v4-flash-0731`
 * — somebody else's product name in the middle of ours. It sells the wrong
 * thing (a buyer comparing "Sonnet vs Opus" to "deepseek-v4-flash-0731"
 * concludes we are a wrapper, and the harness that makes this good is invisible
 * in that name), and it leaks a decision we must stay free to change: the day a
 * better model appears, `--model deepseek/...` is already in scripts and CI.
 *
 * ⚠️ AND IT IS NOT A LIE. The provider id passes through unchanged, `--json`
 * carries it, and the audit log records it. Renaming is branding; hiding would
 * be dishonesty, and a package with a `refusedCommitPath` does not also get a
 * secret supplier.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  ACUVO_MODELS, selectableModels, resolveModelName, labelForModelId, formatModelMenu,
} from '../lib/acuvo-models.mjs';
import { parseArgv } from '../lib/cli-args.mjs';

test('⭐⭐ a user names OUR model and gets the provider id', () => {
  assert.equal(resolveModelName('acuvo-pro').id, 'deepseek/deepseek-v4-pro-0813');
  assert.equal(resolveModelName('acuvo-flash').id, 'deepseek/deepseek-v4-flash-0731');
});

test('⭐ the name is forgiving about case and spacing — people type what they read', () => {
  for (const spelling of ['Acuvo Pro', 'ACUVO-PRO', 'acuvo pro', '  acuvo-pro  ']) {
    assert.equal(resolveModelName(spelling).id, 'deepseek/deepseek-v4-pro-0813', spelling);
  }
});

test('⚠️⚠️ a RAW PROVIDER ID still works — renaming must not become a gate', () => {
  /**
   * Every existing script, CI file and test that names the vendor id keeps
   * working, and somebody wanting a model we have never heard of can still use
   * it. A rename that breaks the old way is a migration, not a rename.
   */
  const known = resolveModelName('deepseek/deepseek-v4-flash-0731');
  assert.equal(known.ok, true);
  assert.equal(known.id, 'deepseek/deepseek-v4-flash-0731');

  const stranger = resolveModelName('someone/model-we-never-shipped');
  assert.equal(stranger.ok, true, 'an unknown vendor id must pass through, not be refused');
  assert.equal(stranger.model, null, 'and it must not be given one of our labels');
});

test('⚠️⚠️ the REVIEWER cannot be chosen — that would turn an independent check into self-review', () => {
  /**
   * The whole value of the second opinion is that its blind spots differ from
   * the builder's. A user who could point it at their own builder would get a
   * reviewer that agrees with itself, and nothing on screen would say so.
   */
  const r = resolveModelName('acuvo-review');
  assert.equal(r.ok, false);
  assert.match(r.error, /self-review/i);
  assert.match(r.error, /acuvo-flash|acuvo-pro/, 'a refusal must name what CAN be chosen');
  assert.equal(selectableModels().some((m) => m.name === 'acuvo-review'), false, 'it must not appear in the menu');
});

test('⚠️ a typo is refused with the options, not posted to a provider', () => {
  // A bare word that is not a known name cannot be a vendor id (no slash), so
  // sending it costs a round trip to learn "no endpoints found for nonsense".
  const r = resolveModelName('acuvo-turbo');
  assert.equal(r.ok, false);
  assert.match(r.error, /acuvo-flash/);
  assert.match(r.error, /acuvo-pro/);
});

test('⚠️⚠️ REACH: `--model acuvo-pro` resolves through the REAL argv parser', () => {
  /**
   * ⭐ The assertion that guards the wiring. Every test above is about a pure
   * function; the defect this package ships most often is a correct function
   * nothing calls.
   */
  const ok = parseArgv(['--model', 'acuvo-pro', 'build a thing']);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.options.model, 'deepseek/deepseek-v4-pro-0813');

  const refused = parseArgv(['--model', 'acuvo-review', 'build a thing']);
  assert.equal(refused.ok, false, 'the internal model must be refused at parse time, before any spend');

  const typo = parseArgv(['--model', 'acuvo-turbo', 'build a thing']);
  assert.equal(typo.ok, false, 'a typo must cost a message, not a round trip');
});

test('⭐ labels never invent a name for a model we did not ship', () => {
  assert.equal(labelForModelId('deepseek/deepseek-v4-pro-0813'), 'Acuvo Pro');
  assert.equal(labelForModelId('someone/unknown'), 'someone/unknown',
    'printing "Acuvo Something" over a model we did not ship is a lie on the receipt');
});

test('⭐ every catalogue entry is complete, and the menu only lists choosable ones', () => {
  for (const [key, m] of Object.entries(ACUVO_MODELS)) {
    assert.equal(m.name, key, 'the key and the name must agree, or a menu and a lookup disagree');
    assert.ok(m.id.includes('/'), `${key} has no provider id`);
    assert.ok(m.label.startsWith('Acuvo'), `${key} is not branded`);
    assert.ok(m.blurb && m.blurb.length > 20, `${key} has nothing to help a user choose`);
  }
  const menu = formatModelMenu();
  assert.equal(menu.length, selectableModels().length);
  assert.equal(menu.some((l) => l.includes('acuvo-review')), false);
});
