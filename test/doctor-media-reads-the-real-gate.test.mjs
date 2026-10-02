/**
 * ── ⚠️⚠️⚠️ `--doctor` TOLD EVERY PAYING CUSTOMER THEIR MEDIA WAS DARK ────────
 *
 * The media section read `mediaConfig(env)`, which answers *"is a Modal URL and
 * secret configured in this shell?"*. The gate every media verb actually passes
 * through is `mediaRoutes(cfg, env, home)`, which ALSO opens each verb over the
 * gateway when the user has an account token.
 *
 * MEASURED 2026-08-31 with `ACUVO_TOKEN` set and no Modal variables — the
 * ordinary signed-in customer:
 *
 *     mediaConfig   all six null          → the doctor printed six DARK lines
 *     mediaRoutes   all six available     → the product offered and ran them
 *
 * ⭐ IT WAS REPORTED AS `see_page` AND `speak`. It was all six.
 *
 * ⚠️ AND THE `fix` LINE WAS THE HARMFUL HALF. A customer on a plan was told to
 * go and set Modal endpoint URLs they do not have and cannot guess. The MODEL
 * section in the same file carries a long correction for exactly this
 * (*"sent a customer who had already paid us off to buy a competitor's key"*);
 * the fix was applied to one section and not to this one.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../lib/doctor.mjs';
import { mediaConfig, mediaRoutes } from '../lib/media.mjs';

/**
 * ⚠️ AN EMPTY `ACUVO_HOME`, AND THIS IS NOT TIDINESS. `readAccount` falls back
 * to `~/.acuvo/credentials.json`, so a test that merely passes `{}` as the env
 * reads the DEVELOPER'S OWN login and every assertion below inverts. The first
 * run of this guard did exactly that and reported a bare machine as signed in.
 */
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'acuvo-doctor-nohome-'));
const MEDIA = ['see_page', 'speak', 'transcribe', 'make_document', 'read_document', 'read_table'];

const mediaChecks = async (env) => {
  const r = await runDoctor({ env, skipNetwork: true, fetchImpl: null });
  const s = r.sections.find((x) => x.id === 'media');
  assert.ok(s, 'the media section is gone — this guard is reading nothing');
  return new Map(s.checks.map((c) => [c.label, c]));
};

test('⭐⭐⭐ a signed-in customer is not told their media verbs are dark', async () => {
  const env = { ACUVO_TOKEN: 'tok_live_example', ACUVO_HOME: EMPTY_HOME };

  /**
   * ⚠️ THE CONTROL THAT MAKES THE REST MEAN ANYTHING: this is genuinely the
   * configuration the old code got wrong. `mediaConfig` must still say null —
   * if it ever starts returning URLs here, the bug is gone for a different
   * reason and this test is measuring nothing.
   */
  const cfg = mediaConfig(env);
  for (const k of ['render', 'speak', 'transcribe', 'document', 'docRead', 'tableRead']) {
    assert.equal(cfg[k], null, `control: mediaConfig.${k} should be null with no Modal vars`);
  }
  const routes = mediaRoutes(cfg, env);
  for (const k of ['render', 'speak', 'transcribe', 'document', 'docRead', 'tableRead']) {
    assert.ok(routes[k], `control: mediaRoutes.${k} should be OPEN via the gateway`);
    assert.equal(routes[k].direct, false, `control: ${k} should be the gateway leg here`);
  }

  const checks = await mediaChecks(env);
  for (const label of MEDIA) {
    const c = checks.get(label);
    assert.ok(c, `${label} is missing from the media section`);
    assert.notEqual(
      c.state, 'dark',
      `--doctor reports \`${label}\` as DARK for a signed-in customer while the gateway route is open. `
      + 'This is the `mediaConfig` vs `mediaRoutes` defect: the doctor is reading local configuration, '
      + 'not the gate the verb passes through.',
    );
  }
});

test('⚠️ and a signed-in customer is never told to go and configure Modal', async () => {
  const checks = await mediaChecks({ ACUVO_TOKEN: 'tok_live_example', ACUVO_HOME: EMPTY_HOME });
  for (const label of MEDIA) {
    const fix = checks.get(label)?.fix ?? '';
    assert.doesNotMatch(
      fix, /MODAL_|ACUVO_MEDIA_SECRET/,
      `\`${label}\` tells a paying customer to set a Modal variable. They do not have it, cannot guess it, `
      + 'and do not need it — the plan they already bought routes this through the gateway.',
    );
  }
});

test('⭐ a machine with no account is told to log in, not to go and find endpoint URLs', async () => {
  const checks = await mediaChecks({ ACUVO_HOME: EMPTY_HOME });
  for (const label of MEDIA) {
    const c = checks.get(label);
    // Control: with no account and no Modal vars these genuinely ARE dark.
    assert.equal(c.state, 'dark', `control: \`${label}\` should be dark on a machine with nothing set up`);
    /**
     * ── ⚠️⚠️ THIS ASSERTION PINNED THE DEFECT IT WAS WRITTEN TO PREVENT ──────
     *
     * It read `/acuvo login/` — the DASHLESS spelling, which `parseArgv`
     * refuses by name (*"`login` is not a command — did you mean `acuvo
     * --login`?"*). So the guard that exists to make sure the reader is sent
     * somewhere useful was holding all six media lines at a command the same
     * binary rejects, and would have gone RED if anyone had corrected it.
     *
     * ⭐ CLAUDE.md's rule, landing exactly: *"a guard that pins an unapproved
     * decision is worse than no guard."* The dashes are not a nit — they are
     * the difference between a cure and a refusal.
     */
    assert.match(
      c.fix ?? '', /acuvo --login/,
      `\`${label}\`'s advice does not mention signing in. One login opens all six; naming a Modal endpoint `
      + 'first sends the reader at the hardest possible path.',
    );
  }
});
