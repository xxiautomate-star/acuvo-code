/**
 * ── ⚠️⚠️ THE GUARD REASONED ABOUT THE TOKEN AND NEVER ABOUT THE DESTINATION ──
 *
 * `gh.mjs` hands a gh child `GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN` on
 * purpose, and justified it with DIRECTIONALITY:
 *
 *   *"these tokens already, by design, travel to GitHub — handing the same
 *    token to a gh child sends it to the same destination."*
 *
 * ⭐ THAT IS ONLY TRUE WHILE SOMETHING GUARANTEES WHICH HOST GITHUB IS, and
 * `GH_HOST` is that something. The file's own comment said `GH_HOST` was
 * "deliberately NOT in the keep-list" because "the scrub never removed them" —
 * every clause true, the conclusion backwards. Not being re-added is not the
 * same as being absent: it **passed straight through from the parent**.
 *
 * ⚠️ AND THE PARENT IS NOT TRUSTED. A cloned repository's `.env` is loaded into
 * the environment, so a repo could name the host its own token was posted to.
 *
 * The fix is a DROP-list rather than a longer keep-list — the same rule the
 * workspace-env guard applies: a layer below the operator may only ever REMOVE
 * permission, never add it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ghEnvironment, GH_ENV_KEEP, GH_ENV_DROP, GH_HOST_OPT_IN } from '../lib/gh.mjs';

/** A parent environment as a malicious repo could arrange it. */
const hostile = (extra = {}) => ({
  PATH: '/usr/bin',
  GH_TOKEN: 'ght_real_secret',
  GITHUB_TOKEN: 'ghp_real_secret',
  GH_ENTERPRISE_TOKEN: 'ghe_real_secret',
  GITHUB_ENTERPRISE_TOKEN: 'ghe2_real_secret',
  GH_HOST: 'attacker.example',
  GH_CONFIG_DIR: '/tmp/evil-gh-config',
  ...extra,
});

test('⚠️⚠️ THE REFUTED CASE: a repo cannot choose the host our token is sent to', () => {
  const out = ghEnvironment(hostile());
  assert.equal(out.GH_HOST, undefined,
    'GH_HOST passed through from the parent — this is the hole, and it is the whole finding');
});

test('⚠️⚠️ and the enterprise token does NOT travel by default', () => {
  const out = ghEnvironment(hostile());
  assert.equal(out.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(out.GITHUB_ENTERPRISE_TOKEN, undefined);
  // An enterprise credential with no enterprise host is a secret with no
  // destination; forwarding it to github.com is worse than not forwarding it.
});

test('⚠️ GH_CONFIG_DIR goes too — it names a config that can name a host', () => {
  assert.equal(ghEnvironment(hostile()).GH_CONFIG_DIR, undefined,
    'closing GH_HOST alone would reopen the same hole through the config file');
});

test('⭐ the ordinary tokens still reach gh, or CI breaks for everyone', () => {
  /**
   * The regression a naive scrub ships. GitHub Actions injects `GITHUB_TOKEN`
   * and nothing else; dropping it would fail every verb on the one machine
   * where the user did everything right.
   */
  const out = ghEnvironment(hostile());
  assert.equal(out.GH_TOKEN, 'ght_real_secret');
  assert.equal(out.GITHUB_TOKEN, 'ghp_real_secret');
});

test('⭐⭐ GitHub Enterprise still works — through a name a repo cannot set', () => {
  /**
   * ⭐ The indirection IS the security property. gh reads `GH_HOST`, which a
   * repo can set, so that is always dropped. We read `ACUVO_GH_HOST`, which
   * `env-file.mjs` forbids a workspace `.env` from introducing at all. Same
   * capability, different trust root.
   */
  const out = ghEnvironment(hostile({ [GH_HOST_OPT_IN]: 'github.mycorp.com' }));
  assert.equal(out.GH_HOST, 'github.mycorp.com');
  assert.equal(out.GH_ENTERPRISE_TOKEN, 'ghe_real_secret');
});

test('⚠️⚠️ the opt-in WINS over the repo, it does not merge with it', () => {
  /**
   * The dangerous near-miss: honouring the operator while still letting the
   * hostile value through under some other name, or letting the parent's
   * GH_HOST survive because the opt-in was checked first.
   */
  const out = ghEnvironment(hostile({ [GH_HOST_OPT_IN]: 'github.mycorp.com' }));
  assert.equal(out.GH_HOST, 'github.mycorp.com');
  assert.notEqual(out.GH_HOST, 'attacker.example');
});

test('⚠️ an EMPTY opt-in is not an opt-in', () => {
  for (const blank of ['', '   ']) {
    const out = ghEnvironment(hostile({ [GH_HOST_OPT_IN]: blank }));
    assert.equal(out.GH_HOST, undefined, `${JSON.stringify(blank)} must not enable the enterprise path`);
    assert.equal(out.GH_ENTERPRISE_TOKEN, undefined);
  }
});

test('⚠️ model-provider keys never reach a gh child at all', () => {
  const out = ghEnvironment(hostile({ OPENROUTER_API_KEY: 'sk-or-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret' }));
  assert.equal(out.OPENROUTER_API_KEY, undefined);
  assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
});

test('the two lists do not overlap — a name cannot be both kept and dropped', () => {
  /**
   * ⚠️ A name in both lists would resolve by whichever loop ran last, which is
   * a security decision made by source order. Asserted so it can never become
   * one silently.
   */
  const both = GH_ENV_KEEP.filter((n) => GH_ENV_DROP.includes(n));
  assert.deepEqual(both, [], `${both.join(', ')} is in both GH_ENV_KEEP and GH_ENV_DROP`);
});
