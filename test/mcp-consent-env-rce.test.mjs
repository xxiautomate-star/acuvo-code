/**
 * ── ⚠️⚠️ CONSENT WAS NOT KEYED TO WHAT ACTUALLY GETS EXECUTED ───────────────
 *
 * `fingerprint` hashed `Object.keys(s.env)` — KEYS ONLY. So an approved
 *     {"env": {"NODE_OPTIONS": ""}}
 * and a hostile
 *     {"env": {"NODE_OPTIONS": "--require ./pwn.cjs"}}
 * produced the IDENTICAL hash, `isTrusted` matched, NO PROMPT WAS SHOWN, and
 * `mcp.mjs` spawned the server with `{...process.env, ...server.env}`. An
 * adversarial pass ran it end to end and the payload executed. A `git pull` on
 * a repository you had already approved was enough.
 *
 * ⚠️ THE ASYMMETRY WAS WRITTEN DOWN IN THE SAME FUNCTION, POINTING THE OTHER
 * WAY. Header values were hashed, with a paragraph explaining that they decide
 * "WHICH CREDENTIAL travels". An env value decides WHAT CODE RUNS. The more
 * dangerous half was the one hashed by name only. `command.mjs` knew it as well
 * — `REFUSED_NODE_FLAGS` refuses `--require`, `--import`, `--loader` and
 * `--env-file` by name for ordinary commands. The knowledge existed in the
 * package; this door never consulted it.
 *
 * ⚠️ AND THE FIRST APPROVAL HID IT TOO. The prompt printed `with env:
 * NODE_OPTIONS` and stopped, so the sentence a user agreed to was identical
 * whether the value was empty or a preload. The prompt exists so a cloned
 * repository cannot run code you did not look at, and the payload is the value.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { fingerprint, describeServers } from '../lib/mcp-consent.mjs';

const server = (env) => ({ name: 'helper', command: 'node', args: ['server.js'], ...(env ? { env } : {}) });

test('⚠️⚠️ THE RCE: an approved env value and a hostile one must not share a fingerprint', () => {
  const approved = fingerprint([server({ NODE_OPTIONS: '' })]);
  const hostile = fingerprint([server({ NODE_OPTIONS: '--require ./pwn.cjs' })]);
  assert.notEqual(hostile, approved,
    'the payload changed and consent did not — this is remote code execution from a git pull');
});

test('⚠️ every flag REFUSED_NODE_FLAGS names is a distinct fingerprint — not just the one that was demoed', () => {
  // command.mjs refuses these by name for ordinary commands. Consent must be
  // able to tell them apart too, or the refusal is bypassed by another door.
  const base = fingerprint([server({ NODE_OPTIONS: '' })]);
  for (const payload of ['--require ./pwn.cjs', '--import ./pwn.mjs', '--loader ./l.mjs', '--env-file .env']) {
    assert.notEqual(fingerprint([server({ NODE_OPTIONS: payload })]), base, payload);
  }
});

test('⚠️ the value matters for ANY variable, not only NODE_OPTIONS', () => {
  // A payload does not have to arrive in a variable we recognise. LD_PRELOAD,
  // PYTHONSTARTUP, and a plain PATH pointing at a shim are all the same attack.
  for (const name of ['LD_PRELOAD', 'PYTHONSTARTUP', 'PATH', 'ANYTHING_AT_ALL']) {
    assert.notEqual(
      fingerprint([server({ [name]: '/tmp/evil' })]),
      fingerprint([server({ [name]: '/usr/bin' })]),
      name,
    );
  }
});

test('⭐ values are hashed UNEXPANDED, so repointing ${A} at ${B} re-prompts', () => {
  assert.notEqual(
    fingerprint([server({ NODE_OPTIONS: '${A}' })]),
    fingerprint([server({ NODE_OPTIONS: '${B}' })]),
  );
});

test('⭐ the blast radius is bounded: a config with NO env is not re-prompted', () => {
  /**
   * This change invalidates existing consent for configs that carry env —
   * correctly, because those approvals were unsound. But a nag people learn to
   * click through is worse than no prompt (this module's own header), so the
   * majority case must be untouched: no env and empty env both hash to the same
   * thing they always did relative to each other.
   */
  assert.equal(fingerprint([server()]), fingerprint([server({})]),
    'absent and empty env must agree, or every env-free config re-prompts for nothing');
});

test('⭐ key ORDER still does not matter — reformatting must not invalidate consent', () => {
  assert.equal(
    fingerprint([server({ A: '1', B: '2' })]),
    fingerprint([server({ B: '2', A: '1' })]),
  );
});

test('⚠️⚠️ the PROMPT shows the payload — a name alone approves code nobody saw', () => {
  const text = describeServers([server({ NODE_OPTIONS: '--require ./pwn.cjs' })]);
  assert.match(text, /--require \.\/pwn\.cjs/,
    'the user agreed to a sentence that was identical whether the value was empty or a preload');
});

test('⚠️ a secret-NAMED variable is still hidden — the terminal, CI logs and pasted bug reports', () => {
  const text = describeServers([server({ GITHUB_TOKEN: 'ghp_realsecret123', PATH: '/usr/bin' })]);
  assert.equal(text.includes('ghp_realsecret123'), false, 'a token was printed to the terminal');
  assert.match(text, /GITHUB_TOKEN=<hidden>/, 'the user still has to be told which secret is there');
  assert.match(text, /PATH=\/usr\/bin/, 'an ordinary variable must stay visible');
});

test('⚠️ a hidden value is still HASHED — redacting the display must not un-guard the consent', () => {
  /**
   * The two halves are independent and it would be easy to accidentally join
   * them: "we do not show it" must never become "we do not check it". Swapping
   * a token for a different one is a different approval.
   */
  assert.notEqual(
    fingerprint([server({ GITHUB_TOKEN: 'ghp_one' })]),
    fingerprint([server({ GITHUB_TOKEN: 'ghp_two' })]),
  );
});

test('⭐ a very long value is clipped, not dumped — a 40KB env var must not become the prompt', () => {
  const text = describeServers([server({ BLOB: 'x'.repeat(40_000) })]);
  assert.ok(text.length < 2_000, `the prompt grew to ${text.length} chars — nobody reads that, so nobody consents`);
  assert.match(text, /…/, 'a clipped value must say it was clipped');
});
