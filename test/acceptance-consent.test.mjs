/**
 * ── ⚠️⚠️ A CLONED REPOSITORY COULD RUN CODE AND HAVE IT REPORTED AS A ✔ ──────
 *
 * Proven in a scratch workspace on 2026-08-13, then fixed:
 *
 *     .acuvo/acceptance.json  →  {"criteria":[{"command":"node payload.js"}]}
 *     $ acuvo "say hello, change nothing"
 *     ✔ MET — `node payload.js` exited 0
 *     $ cat PWNED.txt  →  a cloned repo executed this without being asked
 *
 * The allowlist did not help and could not: it bounds the BINARY, and
 * `node <a file in the repo>` is arbitrary code using nothing but `node`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

import {
  checkAcceptanceConsent, acceptanceFingerprint, describeCriteria, trustAuthoredCriteria, TRUST_ENV,
} from '../lib/acceptance-consent.mjs';

const made = [];
/** A throwaway HOME so the real trust store is never touched by a test. */
const isolatedHome = () => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'acuvo-trust-'));
  made.push(d);
  return d;
};
const cleanup = () => { for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* windows */ } } };

const PAYLOAD = [{ command: 'node payload.js', why: 'looks like a normal project check' }];

test('⚠️⚠️ criteria nobody approved are REFUSED, not run', async (t) => {
  t.after(cleanup);
  const v = await checkAcceptanceConsent(PAYLOAD, {
    root: '/cloned/repo', ask: async () => 'y', isInteractive: false, env: {}, home: isolatedHome(),
  });
  assert.equal(v.allowed, false, 'an unapproved command from a cloned repo must never execute');
  assert.match(v.reason, /no terminal here to ask/);
  assert.match(v.reason, new RegExp(TRUST_ENV), 'the refusal must name the way out, or it is just an obstacle');
});

test('⚠️ FAIL CLOSED — "nobody objected" is not consent', async (t) => {
  t.after(cleanup);
  // Interactive is claimed, but there is no asker: CI with a TTY-ish stdout.
  const v = await checkAcceptanceConsent(PAYLOAD, {
    root: '/r', ask: null, isInteractive: true, env: {}, home: isolatedHome(),
  });
  assert.equal(v.allowed, false);
});

test('a person who says no is obeyed, and a person who says yes is remembered', async (t) => {
  t.after(cleanup);
  const home = isolatedHome();
  const no = await checkAcceptanceConsent(PAYLOAD, { root: '/r', ask: async () => 'n', isInteractive: true, env: {}, home });
  assert.equal(no.allowed, false);
  assert.equal(no.remember, undefined, 'a refusal must never be recorded as consent');

  const yes = await checkAcceptanceConsent(PAYLOAD, { root: '/r', ask: async () => 'y', isInteractive: true, env: {}, home });
  assert.equal(yes.allowed, true);
  assert.equal(yes.remember, true);
});

test('⭐ CONSENT ON AUTHORSHIP — criteria this session wrote never prompt again', async (t) => {
  t.after(cleanup);
  const home = isolatedHome();
  const mine = [{ command: 'npm test' }];

  trustAuthoredCriteria(mine, { root: '/my/repo', env: {}, home });

  // A later run, with NO terminal at all, must still honour them.
  const v = await checkAcceptanceConsent(mine, { root: '/my/repo', ask: null, isInteractive: false, env: {}, home });
  assert.equal(v.allowed, true, 'the user\'s own declaration must not become a prompt they have to click through');
  assert.match(v.reason, /approved in this workspace before/);
});

test('⚠️ approving one command does NOT approve a different one', async (t) => {
  t.after(cleanup);
  const home = isolatedHome();
  trustAuthoredCriteria([{ command: 'npm test' }], { root: '/r', env: {}, home });

  const other = await checkAcceptanceConsent([{ command: 'node payload.js' }], {
    root: '/r', ask: null, isInteractive: false, env: {}, home,
  });
  assert.equal(other.allowed, false, 'trust is per set of COMMANDS — otherwise one yes approves everything forever');
});

test('⚠️ the fingerprint ignores cosmetics and notices the command', () => {
  const a = acceptanceFingerprint([{ command: 'npm test', why: 'because' }]);
  const b = acceptanceFingerprint([{ command: 'npm test', why: 'a totally different explanation' }]);
  const c = acceptanceFingerprint([{ command: 'npm run evil' }]);
  assert.equal(a, b, 'editing prose must not re-prompt — a nag people click through is worse than no prompt');
  assert.notEqual(a, c, 'changing the command absolutely must re-prompt');
});

test('⚠️ an acceptance fingerprint can never collide with an MCP one', () => {
  // The shared trust store holds both. A server approval must not silently
  // approve a criterion, or the two features become one hole.
  assert.match(acceptanceFingerprint([{ command: 'npm test' }]), /^acceptance:/);
});

test('nothing declared asks nothing — the common case must be silent', async (t) => {
  t.after(cleanup);
  let asked = 0;
  const v = await checkAcceptanceConsent([], {
    root: '/r', ask: async () => { asked += 1; return 'y'; }, isInteractive: true, env: {}, home: isolatedHome(),
  });
  assert.equal(v.allowed, true);
  assert.equal(asked, 0, 'a workspace with no acceptance file must never see a question');
});

test('the escape hatch works, for someone who has read their own repo', async (t) => {
  t.after(cleanup);
  const v = await checkAcceptanceConsent(PAYLOAD, {
    root: '/r', ask: null, isInteractive: false, env: { [TRUST_ENV]: '1' }, home: isolatedHome(),
  });
  assert.equal(v.allowed, true);
  assert.match(v.reason, new RegExp(TRUST_ENV));
});

test('the question names the actual command, because that is the decision', () => {
  const text = describeCriteria(PAYLOAD, { root: '/cloned/repo' });
  assert.match(text, /node payload\.js/, 'a consent prompt that hides the command is theatre');
  assert.match(text, /run on your machine/);
});
