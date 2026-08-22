/**
 * ── ⚠️⚠️ THE TEST THAT EXISTS BECAUSE THE FEATURE DID NOT ───────────────────
 *
 * `writeAccount` was exported, documented and called by nothing but its own
 * tests, so `resolveCredential` always fell through to BYOK. The account path
 * was built, tested and unreachable — this repo's signature defect, on the one
 * feature that makes the CLI a product rather than a wrapper.
 *
 * These tests pin the two properties that make login trustworthy: it VERIFIES
 * before it writes, and it never prints the credential.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateTokenShape, verifyToken, maskToken, describeAuth,
} from '../lib/login.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY = 'https://acuvo.xxiautomate.com/api/cli/v1/chat/completions';
const GOOD = `xxi_live_${'a'.repeat(64)}`;

// ── shape ───────────────────────────────────────────────────────────────────

test('accepts the shape the console actually mints', () => {
  const r = validateTokenShape(GOOD);
  assert.equal(r.ok, true);
  assert.equal(r.token, GOOD);
});

test('trims surrounding whitespace — pasting from a dialog brings a newline', () => {
  assert.equal(validateTokenShape(`  ${GOOD}\n`).ok, true);
});

test('⚠️ names the SPECIFIC mistake rather than saying "invalid"', () => {
  // Each of these is a real thing a person does, and each needs a different
  // next action. "Invalid token" would leave all four users equally stuck.
  const cases = [
    ['', /paste the key|pipe it/i],
    [`Bearer ${GOOD}`, /whole authorization header/i],
    ['sk-or-v1-abc123', /provider key|acuvo key/i],
    ['nope', /starts `xxi_live_`/i],
    ['xxi_live_abc', /truncated|prefix/i],
  ];
  for (const [input, expected] of cases) {
    const r = validateTokenShape(input);
    assert.equal(r.ok, false, `${input} should be refused`);
    assert.match(r.reason, expected);
  }
});

test('⭐ the truncated case points at the real cause — the UI shows a prefix', () => {
  // The console's table renders `key_prefix`, so half-copying it is the most
  // likely failure of all and the message has to name that, not just "short".
  assert.match(validateTokenShape('xxi_live_12345678').reason, /abbreviated PREFIX|shown when you created it/i);
});

// ── verification ────────────────────────────────────────────────────────────

const fakeFetch = (status) => async () => ({ status });

test('a rejected key is a rejected key', async () => {
  for (const status of [401, 403]) {
    const r = await verifyToken(GOOD, GATEWAY, { fetchImpl: fakeFetch(status) });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'rejected');
    assert.match(r.reason, /cli\.run/);
  }
});

test('⚠️ no credit is NOT the same as a bad key', async () => {
  // Telling someone their key is wrong when their balance is empty sends them
  // to regenerate a perfectly good credential.
  const r = await verifyToken(GOOD, GATEWAY, { fetchImpl: fakeFetch(402) });
  assert.equal(r.kind, 'no-credit');
  assert.match(r.reason, /top up/i);
});

test('⚠️⚠️ unreachable is NOT a rejection — and it says the key was not saved', async () => {
  const r = await verifyToken(GOOD, GATEWAY, {
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unreachable');
  assert.match(r.reason, /NOT saved/);
});

test('⭐ any status past auth counts as authenticated', async () => {
  // A 400 about the probe model, a 429, a 500 — all mean the gateway got past
  // auth to have an opinion. Demanding 200 would make login fail whenever the
  // upstream provider was briefly unhappy, which is exactly when a user still
  // needs to configure their machine.
  for (const status of [200, 400, 429, 500]) {
    const r = await verifyToken(GOOD, GATEWAY, { fetchImpl: fakeFetch(status) });
    assert.equal(r.ok, true, `status ${status} should count as authenticated`);
  }
});

test('a hung gateway aborts and does not save', async () => {
  const r = await verifyToken(GOOD, GATEWAY, {
    timeoutMs: 20,
    fetchImpl: (_u, opts) => new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
      });
    }),
  });
  assert.equal(r.kind, 'unreachable');
  assert.match(r.reason, /NOT saved/);
});

// ── never print the secret ──────────────────────────────────────────────────

test('⚠️ maskToken keeps only the prefix', () => {
  const masked = maskToken(GOOD);
  assert.equal(masked.length < GOOD.length, true);
  assert.equal(masked.startsWith('xxi_live_'), true);
  assert.equal(masked.includes('a'.repeat(64)), false);
});

test('⚠️⚠️ describeAuth never leaks the whole token', () => {
  const line = describeAuth({ mode: 'account', token: GOOD, url: GATEWAY, email: 'r@x.com' }).line;
  assert.equal(line.includes('a'.repeat(64)), false);
  assert.match(line, /Logged in as r@x\.com/);
});

test('⭐ BYOK is reported as a WARNING, not as success', () => {
  /**
   * It works, but it bills the user's own provider account instead of their
   * Acuvo credits and nothing is metered — so the state must be visible.
   * Reporting it as plain success is how a paying customer quietly pays twice.
   */
  const d = describeAuth({ mode: 'byok', token: 'sk-x', url: null, email: null });
  assert.equal(d.warn, true);
  assert.match(d.line, /bills YOUR provider account/i);
  assert.match(d.line, /not your Acuvo credits/i);
});

test('unconfigured tells you exactly what to do next', () => {
  const d = describeAuth({ mode: 'unconfigured' });
  assert.equal(d.ok, false);
  assert.match(d.line, /Settings → API keys/);
  assert.match(d.line, /cli\.run/);
  assert.match(d.line, /--login/);
});

// ── ⚠️⚠️ REACH: the module must be WIRED, not merely written ────────────────

test('⚠️⚠️ bin/acuvo.mjs actually offers --login / --logout / --whoami', () => {
  /**
   * This is the whole point. `writeAccount` was exported, documented and
   * reachable in code for weeks while being called by nothing — so a test that
   * only exercised this module would have passed just as happily then.
   *
   * ⭐ Strip comments first: a guard that greps source will otherwise match the
   * comment EXPLAINING the flag, so the better the work is documented the more
   * invisibly its removal passes (`no-orphan-routes` learned this the hard way).
   */
  const raw = readFileSync(join(HERE, '..', 'bin', 'acuvo.mjs'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.match(code, /--login/, 'bin/acuvo.mjs does not offer --login');
  assert.match(code, /--logout/, 'bin/acuvo.mjs does not offer --logout');
  assert.match(code, /--whoami/, 'bin/acuvo.mjs does not offer --whoami');
  assert.match(code, /writeAccount\(/, 'nothing calls writeAccount — the credential is still never stored');
  assert.match(code, /verifyToken\(/, 'login does not verify before writing');
});
