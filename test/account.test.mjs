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
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
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
  const home = fakeHome();
  const r = writeAccount({ token: 't' }, {}, home);
  assert.equal(r.ok, true);
  if (platform() === 'win32') {
    assert.equal(r.restricted, false, 'win32 must not claim restricted permissions');
    assert.match(r.note, /not restricted on Windows/i, 'and it must SAY so');
  } else {
    assert.equal(r.restricted, true);
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
