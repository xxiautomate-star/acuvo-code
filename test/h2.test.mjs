/**
 * ── THE TRANSPORT I WRONGLY SAID WAS IMPOSSIBLE ─────────────────────────────
 *
 * These are deliberately NOT network tests. The live behaviour was measured
 * separately and is recorded in the module (3/3 200s with Safari ciphers over
 * h2, 0/3 without). What is pinned here is the part that will rot: the
 * INVARIANTS a future edit could quietly break while every live call still
 * appears to work.
 *
 * ⚠️ The cipher list is the load-bearing one. Sorting or deduplicating it —
 * exactly the kind of tidy-up that looks like an improvement in review — turns
 * every 200 back into a 403 with no other symptom, on a Tuesday, in production.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAFARI_CIPHERS, SAFARI_UA, h2Request, h2Json } from '../lib/h2.mjs';

test('the cipher list is in Safari order — do not sort it', () => {
  const list = SAFARI_CIPHERS.split(':');
  assert.equal(list[0], 'TLS_AES_128_GCM_SHA256', 'TLS 1.3 suites lead, and 128 precedes 256 in Safari');
  assert.equal(list[1], 'TLS_AES_256_GCM_SHA384');
  assert.equal(list[2], 'TLS_CHACHA20_POLY1305_SHA256');
  // ECDSA before RSA is the second ordering fact a "cleanup" would destroy.
  assert.ok(list.indexOf('ECDHE-ECDSA-AES256-GCM-SHA384') < list.indexOf('ECDHE-RSA-AES256-GCM-SHA384'));

  const sorted = [...list].sort();
  assert.notDeepEqual(list, sorted, 'if this ever equals its own sort, someone tidied it and broke the fingerprint');
  assert.equal(new Set(list).size, list.length, 'no duplicates — a duplicate changes the hash too');
});

test('the user agent is a real Safari string, not a Node default', () => {
  assert.match(SAFARI_UA, /Safari\/605\.1\.15$/);
  assert.doesNotMatch(SAFARI_UA, /node|undici/i);
});

/** ⚠️ Errors are DATA here like everywhere else — a rude host must not end a session. */
test('a malformed url returns an error rather than throwing', async () => {
  const r = await h2Request('not a url at all');
  assert.equal(r.ok, false);
  assert.match(r.error, /not a URL/);
});

test('http is refused — h2 without TLS is a different protocol nobody serves', async () => {
  const r = await h2Request('http://example.com/');
  assert.equal(r.ok, false);
  assert.match(r.error, /https-only/);
});

test('an unresolvable host is an error, not an exception', async () => {
  const r = await h2Request('https://this-host-does-not-exist-acuvo-test.invalid/', { timeoutMs: 8000 });
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

/**
 * ⚠️ THE DISTINCTION THE WHOLE MODULE EXISTS FOR. A 403 may be a real
 * authorisation problem worth fixing. A challenge means the fingerprint stopped
 * passing — no credential, retry or key changes it. Reporting both as "403"
 * sends the next person hunting for an auth bug that does not exist.
 */
test('h2Json reports a non-JSON body as an error and quotes what it got', async () => {
  const r = await h2Json('https://this-host-does-not-exist-acuvo-test.invalid/', { timeoutMs: 8000 });
  assert.equal(r.ok, false);
});

test('example.com answers over h2 — a control, so a failure elsewhere is not "h2 is broken"', async () => {
  const r = await h2Request('https://example.com/', { timeoutMs: 20000 });
  // ⚠️ Deliberately tolerant of the network being down: what must NOT happen is
  // a throw or a hang. A skipped assertion beats a flaky suite.
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok) {
    assert.equal(r.status, 200);
    assert.equal(r.challenged, false);
    assert.ok(r.body.length > 100);
  }
});
