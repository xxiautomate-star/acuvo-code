/**
 * ── ⭐⭐ WHOSE MONEY IS THIS RUN SPENDING? ───────────────────────────────────
 *
 * Acuvo Code is meant to work like Claude Code — you buy Acuvo credits and never
 * see a provider key. Today it reads `OPENROUTER_API_KEY` from the user's
 * environment, which is BYOK and was never the plan.
 *
 * These pin the CLI half of the fix, and the properties that matter are the ones
 * about MONEY and CONTAINMENT rather than about file formats:
 *   · an account is preferred, but a provider key still works (nobody breaks)
 *   · the credential lives under HOME, where no tool in this package can read it
 *   · a corrupt file degrades to "not signed in", it never crashes a run
 *   · we never claim a file permission we did not actually get
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import {
  credentialsPath, accountDir, readAccount, writeAccount, clearAccount,
  resolveCredential, DEFAULT_GATEWAY_URL,
} from '../lib/account.mjs';

/** A throwaway HOME, so no test can touch the developer's real credentials. */
const fakeHome = () => mkdtempSync(join(tmpdir(), 'acuvo-home-'));

test('⭐⭐ the credential lives under HOME, never under a workspace', () => {
  /**
   * ⚠️ THIS IS THE ONE THAT MATTERS. `WRITE_FORBIDDEN_ROOTS` in workspace.mjs
   * does not contain `.acuvo`, so an agent CAN write `.acuvo/...` inside a
   * workspace. A credential stored there would be writable by the very agent it
   * exists to bound — and readable by it, which is exfiltration.
   */
  const home = fakeHome();
  const p = credentialsPath({}, home);
  assert.ok(p.startsWith(home), `credential must live under HOME, got ${p}`);
  assert.match(p, /\.acuvo[\\/]credentials\.json$/);
  assert.ok(!p.includes(process.cwd()), 'must not resolve into the current workspace');
});

test('⭐ an account is PREFERRED over a provider key', () => {
  const home = fakeHome();
  writeAccount({ token: 'acuvo_live_abc', email: 'roman@example.com' }, {}, home);
  const c = resolveCredential({ OPENROUTER_API_KEY: 'sk-or-v1-theirs' }, home);
  assert.equal(c.mode, 'account');
  assert.equal(c.token, 'acuvo_live_abc');
  assert.equal(c.url, DEFAULT_GATEWAY_URL, 'an account run must go through OUR gateway');
});

test('⚠️ BYOK still works — nobody using it today gets broken', () => {
  const home = fakeHome();
  const c = resolveCredential({ OPENROUTER_API_KEY: 'sk-or-v1-theirs' }, home);
  assert.equal(c.mode, 'byok');
  assert.equal(c.token, 'sk-or-v1-theirs');
  assert.equal(c.url, null, 'BYOK must NOT be routed through our gateway — it is their key and their balance');
});

test('⭐ neither configured is its own state, not an error', () => {
  const c = resolveCredential({}, fakeHome());
  assert.equal(c.mode, 'unconfigured');
  assert.equal(c.token, '');
});

test('⚠️⚠️ a corrupt credentials file degrades to signed-out, it does not throw', () => {
  // A crash at startup because a JSON file has a stray byte is a worse failure
  // than an unauthenticated run, and it is the one a user cannot diagnose.
  const home = fakeHome();
  mkdirSync(accountDir({}, home), { recursive: true });
  writeFileSync(credentialsPath({}, home), '{ this is not json', 'utf8');
  assert.equal(readAccount({}, home), null);
  assert.equal(resolveCredential({}, home).mode, 'unconfigured');

  // Valid JSON with no token is the same thing.
  writeFileSync(credentialsPath({}, home), '{"email":"a@b.c"}', 'utf8');
  assert.equal(readAccount({}, home), null);
});

test('⭐ ACUVO_TOKEN in the environment wins, so CI never writes a credential to disk', () => {
  const home = fakeHome();
  writeAccount({ token: 'from-file' }, {}, home);
  const c = resolveCredential({ ACUVO_TOKEN: 'from-env' }, home);
  assert.equal(c.mode, 'account');
  assert.equal(c.token, 'from-env');
});

test('⚠️ we never claim a file permission we did not get', () => {
  /**
   * MEASURED: `chmod 600` is accepted and does nothing on win32, and this
   * project is developed on Windows. A security control that reports a success
   * it did not achieve is worse than one that is absent — it stops the reader
   * looking any further.
   */
  /**
   * ── ⭐ UPDATED 2026-08-23: WINDOWS NOW GENUINELY RESTRICTS THE FILE ─────────
   *
   * This asserted `restricted === false` on win32, which was correct while the
   * only tool being used was `chmod` — a documented no-op there. It encoded a
   * LIMITATION as if it were the rule.
   *
   * `icacls /inheritance:r /grant:r USER:F` drops the inherited ACEs and leaves
   * exactly one principal, which is what `chmod 600` means on NTFS. Verified on
   * this machine: the file resolves to `DOMAIN\user:(F)` and nothing else.
   *
   * ⚠️ THE INVARIANT IS UNCHANGED AND IS WHAT IS ASSERTED NOW: `restricted` and
   * `note` must agree with each other, and with reality. A control that claims a
   * success it did not achieve is worse than one that is absent, whichever
   * platform it is lying on.
   */
  const home = fakeHome();
  const r = writeAccount({ token: 't' }, {}, home);
  assert.equal(r.ok, true);
  assert.equal(typeof r.restricted, 'boolean');
  if (r.restricted) {
    assert.equal(r.note, null, 'a restricted file must not also carry a warning');
  } else {
    assert.ok(r.note && /permission/i.test(r.note), 'an unrestricted file must SAY so');
  }
});

test('⭐ the gateway URL is overridable for staging, environment first', () => {
  const home = fakeHome();
  writeAccount({ token: 't', gatewayUrl: 'https://stored.example/v1' }, {}, home);
  assert.equal(readAccount({}, home).gatewayUrl, 'https://stored.example/v1');
  assert.equal(
    readAccount({ ACUVO_GATEWAY_URL: 'http://127.0.0.1:8787/v1' }, home).gatewayUrl,
    'http://127.0.0.1:8787/v1',
    'the environment must win, so a local build can be pointed at a stub',
  );
});

test('⭐ sign out removes it, and signing out twice is not an error', () => {
  const home = fakeHome();
  writeAccount({ token: 't' }, {}, home);
  assert.ok(existsSync(credentialsPath({}, home)));

  const first = clearAccount({}, home);
  assert.equal(first.ok, true);
  assert.equal(first.existed, true);
  assert.ok(!existsSync(credentialsPath({}, home)));

  const second = clearAccount({}, home);
  assert.equal(second.ok, true);
  assert.equal(second.existed, false);
});

test('⚠️ the stored file contains the token and no provider key ever', () => {
  const home = fakeHome();
  writeAccount({ token: 'acuvo_live_xyz', email: 'a@b.c' }, {}, home);
  const body = JSON.parse(readFileSync(credentialsPath({}, home), 'utf8'));
  assert.equal(body.token, 'acuvo_live_xyz');
  assert.equal(body.email, 'a@b.c');
  assert.ok(!('apiKey' in body) && !('OPENROUTER_API_KEY' in body), 'a provider key must never be persisted here');
});

test('⚠️⚠️ a BYOK fallback nobody opted into is marked `unspoken`', async () => {
  /**
   * Measured on Roman's machine 2026-08-23: no account file, so every run fell
   * through to OPENROUTER_API_KEY and was billed to his personal balance — and
   * because BYOK never touches our gateway, none of it was metered. The harm is
   * the SILENCE, not the fallback, so the fallback stays and the caller gets a
   * flag it can speak with.
   */
  const { resolveCredential } = await import('../lib/account.mjs');
  const home = mkdtempSync(join(tmpdir(), 'acuvo-home-'));

  const stray = resolveCredential({ OPENROUTER_API_KEY: 'sk-or-v1-x', ACUVO_HOME: home }, home);
  assert.equal(stray.mode, 'byok', 'the fallback must keep working — nobody gets bricked');
  assert.equal(stray.unspoken, true, 'a key nobody opted into must be announced');

  const chosen = resolveCredential({ OPENROUTER_API_KEY: 'sk-or-v1-x', ACUVO_BYOK: '1', ACUVO_HOME: home }, home);
  assert.equal(chosen.mode, 'byok');
  assert.equal(chosen.unspoken, false, 'somebody who opted in should not be nagged');

  rmSync(home, { recursive: true, force: true });
});

test('⭐⭐ the credentials file is ACTUALLY restricted, on this platform', async () => {
  /**
   * Roman's first successful login printed "WARNING: could not restrict
   * permissions on the credentials file — check it yourself." Honest, and a bad
   * first thirty seconds: it hands a security problem back to the user with no
   * way to act on it. Windows can restrict the file; it just cannot do it with
   * chmod. `icacls /inheritance:r /grant:r USER:F` is the same idea spelled the
   * way NTFS spells it.
   *
   * ⚠️ ASSERTS THE OUTCOME, NOT THE ATTEMPT. `restricted` must mean the
   * permissions were narrowed — a security control that reports a success it
   * did not achieve is worse than one that is absent, because it stops people
   * looking.
   */
  const { writeAccount } = await import('../lib/account.mjs');
  const home = mkdtempSync(join(tmpdir(), 'acuvo-perm-'));
  const r = writeAccount({ token: 'xxi_live_test' }, { ACUVO_HOME: home }, home);

  assert.equal(r.ok, true);
  assert.equal(r.restricted, true, `permissions were not narrowed: ${r.note}`);
  assert.equal(r.note, null, 'a restricted file should carry no warning');

  rmSync(home, { recursive: true, force: true });
});
