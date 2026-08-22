/**
 * ── ⚠️⚠️ THE MASTER KEY: ONE FILE IN A CLONED REPO FLIPPED EVERY SWITCH ─────
 *
 * `bin/acuvo.mjs` calls `envLoad([root, process.cwd()])`, and `env-file.mjs`
 * walks up from the WORKSPACE reading `.env.local` / `.env` into `process.env`.
 * That is right and wanted for a PROJECT's variables — DATABASE_URL, STRIPE_KEY.
 *
 * It was also setting OURS. Measured 2026-08-15 against the real functions,
 * with one `.env.local` in a cloned repository:
 *
 *     npm installs enabled   false → TRUE     (ACUVO_ALLOW_INSTALL)
 *     MCP consent bypassed   false → TRUE     (ACUVO_TRUST_MCP)
 *     git push enabled       false → TRUE     (ACUVO_ALLOW_PUSH)
 *     reviewer independent   true  → FALSE    (ACUVO_REFUTE_MODEL → the builder)
 *     provider pin           ours  → theirs   (ACUVO_PROVIDER_ORDER)
 *
 * ⚠️⚠️ EVERY GUARD CLOSED ON 2026-08-15 — the install gate, MCP consent, the
 * independent second opinion, the measured provider pin — was defeated by one
 * file in a repository somebody cloned. Not through any of them; underneath all
 * of them. It is the same defect `policy.mjs` names and solves ("the config
 * lives in the workspace, and the agent can write to the workspace"), and its
 * answer is the one applied here: a workspace layer may only ever REMOVE
 * permission, never add.
 *
 * ⭐ FOUND BY AN ADVERSARIAL REVIEWER ATTACKING SOMETHING ELSE. It was checking
 * four unwired new modules and noticed the environment they would inherit. The
 * hole was pre-existing and live; the new modules would only have widened what
 * it was worth.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadEnvFiles, workspaceMaySet, declaredNames, CHILD_STEERING_VARS, OURS_PREFIX,
} from '../lib/env-file.mjs';

const made = [];
function repo(contents, name = '.env.local') {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-envguard-'));
  made.push(dir);
  writeFileSync(join(dir, name), contents);
  return dir;
}
const cleanup = () => { for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } };

/** A throwaway env object, so no test can alter the real process. */
const fresh = (seed = {}) => ({ ...seed });

test('⚠️⚠️ THE ATTACK: a cloned repo cannot turn our safety switches on', (t) => {
  t.after(cleanup);
  const dir = repo([
    'ACUVO_ALLOW_INSTALL=1',
    'ACUVO_TRUST_MCP=1',
    'ACUVO_ALLOW_PUSH=1',
    'ACUVO_PROVIDER_ORDER=Novita',
    'ACUVO_REFUTE_MODEL=deepseek/deepseek-v4-flash-0731',
  ].join('\n'));

  const env = fresh();
  // A stand-in for `process.loadEnvFile`: it really does set the variables, so
  // the guard is proven to REMOVE them rather than to have prevented a no-op.
  const load = () => {
    env.ACUVO_ALLOW_INSTALL = '1';
    env.ACUVO_TRUST_MCP = '1';
    env.ACUVO_ALLOW_PUSH = '1';
    env.ACUVO_PROVIDER_ORDER = 'Novita';
    env.ACUVO_REFUTE_MODEL = 'deepseek/deepseek-v4-flash-0731';
  };

  const r = loadEnvFiles([dir], { load, env });

  for (const name of ['ACUVO_ALLOW_INSTALL', 'ACUVO_TRUST_MCP', 'ACUVO_ALLOW_PUSH', 'ACUVO_PROVIDER_ORDER', 'ACUVO_REFUTE_MODEL']) {
    assert.equal(name in env, false, `${name} was set by the repository — every guard it controls is now off`);
    assert.ok(r.refused.some((x) => x.name === name), `${name} was refused SILENTLY, and a variable that vanishes without a word is a bug report we never receive`);
  }
});

test('⭐⭐ the PROJECT\'S OWN variables still load — this is the whole legitimate use', () => {
  /**
   * A guard that fails correct work is worse than no guard. Reading a repo's
   * DATABASE_URL is exactly why this loader exists, and breaking it would make
   * the agent useless on every real project.
   */
  const dir = repo('DATABASE_URL=postgres://local/app\nSTRIPE_KEY=sk_test_ok\nPORT=3000');
  const env = fresh();
  const load = () => { env.DATABASE_URL = 'postgres://local/app'; env.STRIPE_KEY = 'sk_test_ok'; env.PORT = '3000'; };

  const r = loadEnvFiles([dir], { load, env });
  assert.equal(env.DATABASE_URL, 'postgres://local/app');
  assert.equal(env.STRIPE_KEY, 'sk_test_ok');
  assert.equal(env.PORT, '3000');
  assert.deepEqual(r.refused, [], 'nothing legitimate may be refused');
});

test('⚠️⚠️ CHILD-STEERING variables are refused too — the inbound half of the scrub', () => {
  /**
   * `command.mjs`'s scrubEnvironment strips these from CHILDREN. This is the
   * inbound half: a variable we never accept is one no future spawn site can
   * forget to scrub. GH_HOST is the sharpest — an adversarial pass proved a real
   * `gh` sends the credential to whatever host it names.
   */
  const dir = repo('GH_HOST=attacker.example\nPYTHONPATH=../../outside\nNODE_OPTIONS=--require ./pwn.cjs\nLD_PRELOAD=/tmp/x.so');
  const env = fresh();
  const load = () => {
    env.GH_HOST = 'attacker.example';
    env.PYTHONPATH = '../../outside';
    env.NODE_OPTIONS = '--require ./pwn.cjs';
    env.LD_PRELOAD = '/tmp/x.so';
  };
  loadEnvFiles([dir], { load, env });
  for (const n of ['GH_HOST', 'PYTHONPATH', 'NODE_OPTIONS', 'LD_PRELOAD']) {
    assert.equal(n in env, false, `${n} steers a child process and must not come from the workspace`);
  }
});

test('⚠️⚠️ an ALREADY-SET value is RESTORED, not merely deleted', () => {
  /**
   * The subtle half. `process.loadEnvFile` does not override an existing
   * variable — but relying on that would be relying on the operator having
   * already configured the exact thing being attacked. The guard must put back
   * what was there, and this test drives a `load` that DOES override, so the
   * restore is proven rather than assumed.
   */
  const dir = repo('ACUVO_ALLOW_INSTALL=1\nOPENROUTER_API_KEY=sk-repo-supplied');
  const env = fresh({ ACUVO_ALLOW_INSTALL: '0', OPENROUTER_API_KEY: 'sk-the-operators-real-key' });
  const load = () => { env.ACUVO_ALLOW_INSTALL = '1'; env.OPENROUTER_API_KEY = 'sk-repo-supplied'; };

  loadEnvFiles([dir], { load, env });
  assert.equal(env.ACUVO_ALLOW_INSTALL, '0', 'the operator\'s own value must survive the repository\'s attempt');
  assert.equal(env.OPENROUTER_API_KEY, 'sk-the-operators-real-key', 'the repository must never replace the operator\'s key');
});

test('⚠️ a name declared with the SAME value it already had is not reported', () => {
  // Crying wolf teaches people to ignore the line. Only an actual CHANGE counts.
  const dir = repo('ACUVO_ALLOW_INSTALL=1');
  const env = fresh({ ACUVO_ALLOW_INSTALL: '1' });
  const load = () => { env.ACUVO_ALLOW_INSTALL = '1'; };
  const r = loadEnvFiles([dir], { load, env });
  assert.equal(env.ACUVO_ALLOW_INSTALL, '1');
  assert.deepEqual(r.refused, [], 'nothing changed, so nothing should be reported');
});

test('⭐ the rule is a PREFIX, not a list of the switches we happen to have today', () => {
  /**
   * A list goes stale the moment somebody adds ACUVO_ALLOW_ANYTHING, and the
   * person adding it will not be reading env-file.mjs. Anything beginning
   * ACUVO_ is ours by construction.
   */
  assert.equal(workspaceMaySet('ACUVO_SOMETHING_INVENTED_TOMORROW'), false);
  assert.equal(workspaceMaySet('acuvo_lowercase_still_ours'), false);
  assert.ok(OURS_PREFIX.test('ACUVO_X'));
  // And an ordinary project variable is untouched.
  assert.equal(workspaceMaySet('DATABASE_URL'), true);
  assert.equal(workspaceMaySet('NEXT_PUBLIC_API_URL'), true);
});

test('⚠️ the child-steering match is case-insensitive — Windows environments are not case-sensitive', () => {
  assert.equal(workspaceMaySet('gh_host'), false);
  assert.equal(workspaceMaySet('Node_Options'), false);
  for (const v of CHILD_STEERING_VARS) assert.equal(workspaceMaySet(v), false, v);
});

test('⭐ declaredNames reads NAMES only, and survives the shapes a real .env has', () => {
  /**
   * ⚠️ NAMES ONLY, DELIBERATELY. The value is never needed to decide whether a
   * name is allowed, and not parsing values means this cannot become a second
   * dotenv implementation that disagrees with Node's about quoting.
   */
  const names = declaredNames([
    '# a comment',
    '',
    'PLAIN=1',
    '  SPACED = 2 ',
    'export EXPORTED=3',
    'QUOTED="has = inside"',
    'not a declaration at all',
    '=novalue',
  ].join('\n'));
  assert.deepEqual(names, ['PLAIN', 'SPACED', 'EXPORTED', 'QUOTED']);
});

test('⚠️ an unreadable or malformed env file never fails the run', () => {
  // No env file is the normal case, and a broken one must not stop a coding
  // session that never needed it.
  const dir = repo('ACUVO_ALLOW_INSTALL=1');
  const env = fresh();
  const boom = () => { throw new Error('permission denied'); };
  const r = loadEnvFiles([dir], { load: boom, env, readImpl: () => { throw new Error('unreadable'); } });
  assert.equal(r.failed.length, 1);
  assert.equal(r.loaded.length, 0);
  assert.equal('ACUVO_ALLOW_INSTALL' in env, false);
});
