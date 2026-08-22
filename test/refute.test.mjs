/**
 * ── ⭐⭐ THE SECOND OPINION ──────────────────────────────────────────────────
 *
 * Every coding agent grades its own homework, and this package's own history
 * has four probes that printed `✔ VERIFIED` over work that was wrong,
 * incomplete or never run. A second agent with a FRESH context is asked to
 * refute the claim — not review it, not improve it.
 *
 * ⚠️ The dangerous half is not missing a bug. It is an adversarial reviewer that
 * defaults to suspicion and fails correct work, which this package treats as
 * the worse error. Most of this file is about the burden of proof.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { refuteClaim, parseRefuteVerdict, refutePrompt, formatRefutation } from '../lib/refute.mjs';
import { REFUTER_TOOL_NAMES } from '../lib/refute-tools.mjs';

/**
 * ⚠️ The recorder hangs off the RETURNED function, not off the factory. Written
 * the other way round first (`session.lastOpts = opts`), which stored it on the
 * factory every test shares — so `impl.lastOpts` was always undefined and two
 * tests failed for a reason that had nothing to do with the refuter.
 */
const session = (content, { cost = 0.001 } = {}) => {
  const impl = async (opts) => {
    impl.lastOpts = opts;
    return { ok: true, content, roundsUsed: 2, executed: [], usage: { cost, total_tokens: 900 } };
  };
  return impl;
};

/**
 * ── ⚠️ EVERY `refuteClaim` TEST BELOW NOW HAS TO SUPPLY ONE OF THESE ────────
 *
 * The refuter refuses to run without an external signal — a compiler exit code,
 * a test result or a linter result — because critiquing blind is MEASURED to
 * make answers worse (down or flat in 6 settings of 6, −37.7 points on one
 * benchmark in a single round). See `refute-needs-external-signal.test.mjs` for
 * the gate itself; here it is just the precondition, handed over as the
 * builder's own run so no command is executed by a unit test.
 */
const SIGNAL_IN_HAND = [
  { name: 'run_command', args: { command: 'npm test' }, result: { ok: true, command: 'npm test', exitCode: 0 } },
];

test('⭐⭐ a concrete refutation flips the verdict', () => {
  const v = parseRefuteVerdict('I ran the suite.\nREFUTED: npm test still exits 1 — invoice.test.mjs fails on line 14');
  assert.equal(v.refuted, true);
  assert.match(v.reason, /invoice\.test\.mjs/);
});

test('⚠️⚠️ UNCERTAINTY IS NOT A REFUTATION — this is the half that could ruin the tool', () => {
  /**
   * A reviewer that defaults to "something is probably wrong" fails correct
   * work, and failing correct work is worse than the bug it was hunting.
   */
  const v = parseRefuteVerdict('This looks fragile and there may be edge cases.\nNOT REFUTED: ran npm test, it passes; checked all four call sites');
  assert.equal(v.refuted, false);
  assert.match(v.reason, /four call sites/);
});

test('⚠️ the verdict is the LAST LINE — a model discussing the word must not flip it', () => {
  const v = parseRefuteVerdict('I could not see anything that would be REFUTED: by the tests here.\nNOT REFUTED: everything checks out');
  assert.equal(v.refuted, false, 'the word appearing mid-answer must not decide anything');
});

test('⚠️ a bare "REFUTED:" with no reason proves nothing', () => {
  const v = parseRefuteVerdict('REFUTED: bad');
  assert.equal(v.refuted, false, 'an assertion is not evidence — a refutation must carry a checkable reason');
  assert.equal(v.unclear, true);
});

test('⚠️ an unparseable reply changes NOTHING — the burden is on the refuter', () => {
  const v = parseRefuteVerdict('I had a look and it seems fine to me, roughly.');
  assert.equal(v.refuted, false);
  assert.equal(v.unclear, true);
  assert.match(v.note, /decides nothing/);
});

test('⚠️⚠️ THE REFUTER CANNOT WRITE — a reviewer that fixes things is not reviewing', async () => {
  const impl = session('NOT REFUTED: checked it');
  await refuteClaim({ task: 'fix the bug', claim: 'fixed it', executor: {}, config: { apiKey: 'k' }, executed: SIGNAL_IN_HAND, sessionImpl: impl });

  const offered = impl.lastOpts?.toolNames ?? [];
  for (const w of ['write_file', 'write_files', 'edit_file', 'delete_file', 'git_commit', 'evaluate']) {
    assert.ok(!offered.includes(w), `the refuter was offered ${w} — its unreviewed "fix" would land on work somebody was about to inspect`);
  }
  assert.ok(offered.includes('run_command'), 'it MUST be able to run — the strongest refutation is a command that fails');
});

test('⭐ it runs with a FRESH context — inheriting the reasoning inherits the blind spot', async () => {
  const impl = session('NOT REFUTED: fine');
  await refuteClaim({ task: 'fix the bug', claim: 'fixed it', executor: {}, config: { apiKey: 'k' }, executed: SIGNAL_IN_HAND, sessionImpl: impl });
  assert.equal(impl.lastOpts?.priorMessages, undefined,
    'the second opinion must not see how the first one thought, or it is not a second opinion');
  assert.match(impl.lastOpts.task, /REFUTE THAT CLAIM/i);
  assert.match(impl.lastOpts.task, /fix the bug/, 'it has to know what was actually asked');
});

test('⭐ its cost comes back so the parent can charge it', async () => {
  const r = await refuteClaim({
    task: 't', claim: 'c', executor: {}, config: { apiKey: 'k' }, executed: SIGNAL_IN_HAND,
    sessionImpl: session('NOT REFUTED: ok', { cost: 0.0022 }),
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.costUsd - 0.0022) < 1e-9);
});

test('⚠️ a crashed refuter does NOT fail work that may be perfectly good', async () => {
  const r = await refuteClaim({
    task: 't', claim: 'c', executor: {}, config: { apiKey: 'k' }, executed: SIGNAL_IN_HAND,
    sessionImpl: async () => { throw new Error('the model died'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /the model died/);
  assert.equal(r.refuted, undefined, 'a dead refuter must never read as a refutation');
});

test('the prompt refuses opinion in as many words', () => {
  const p = refutePrompt({ task: 'do a thing', claim: 'did it' });
  assert.match(p, /UNCERTAINTY IS NOT A REFUTATION/);
  assert.match(p, /MAY NOT WRITE/);
  assert.match(p, /REFUTED:/);
});

test('the one-line report does not overclaim in either direction', () => {
  assert.match(formatRefutation({ ok: true, refuted: true, reason: 'npm test exits 1' }), /REFUTES IT/);
  assert.match(formatRefutation({ ok: true, refuted: false, reason: 'ran the suite' }), /could not refute/);
  assert.match(formatRefutation({ ok: true, refuted: false, unclear: true, note: 'no verdict line' }), /stands unchanged/);
  assert.match(formatRefutation({ ok: false, error: 'boom' }), /unavailable/);
});

test('every tool the refuter is given actually exists', async () => {
  const { TOOL_SCHEMAS } = await import('../lib/tools.mjs');
  const known = new Set(TOOL_SCHEMAS.map((t) => t.function.name));
  const missing = REFUTER_TOOL_NAMES.filter((n) => !known.has(n));
  assert.deepEqual(missing, [], `the refuter is offered tools that do not exist: ${missing.join(', ')}`);
});
