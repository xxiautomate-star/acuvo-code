/**
 * ── ⭐⭐ THE LOOP CAN NOW BE STOPPED FROM OUTSIDE IT ─────────────────────────
 *
 * `bin/acuvo.mjs` stated the gap itself, at the lease-renewal callback:
 * *"IT CANNOT ABORT THE ROUND, AND THAT LIMIT IS STATED RATHER THAN HIDDEN.
 * runSession takes no abort signal, so the honest thing this callback can do is
 * record the loss… Aborting mid-round is a real improvement and it needs a
 * signal parameter on runSession, which is a change to the loop's contract."*
 *
 * ⚠️⚠️ AN ABORT IS A CLEAN RETURN, NOT A THROW, AND THAT IS THE WHOLE POINT. A
 * KILLED run loses its session and its audit line — so the run a user most wants
 * to resume is the one that leaves nothing behind. Stopping cleanly means the
 * transcript saves, the cost is recorded, the changes are reported, and
 * `--resume` works.
 *
 * ⚠️ CHECKED AT ROUND BOUNDARIES, not mid-round. A round owns a model call, its
 * tool results and its ledger entry; tearing one in half would record spend
 * against discarded work.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { abortReasonOf } from '../lib/turn.mjs';

test('⭐ a caller-supplied reason survives to the summary', () => {
  const c = new AbortController();
  c.abort('another terminal took the lease on src/app.ts');
  assert.equal(abortReasonOf(c.signal), 'another terminal took the lease on src/app.ts');
});

test('⚠️⚠️ three different causes must not collapse into one word', () => {
  /**
   * A lease lost to another terminal, a user pressing Ctrl-C, and a fleet
   * ceiling reached are three different events with three different next
   * actions. A summary that called them all "aborted" would throw away the only
   * thing that tells the user what to do.
   */
  const reasons = [
    'another terminal took the lease on src/app.ts',
    'you pressed Ctrl-C',
    'the fleet ceiling for today was reached',
  ];
  const seen = reasons.map((r) => { const c = new AbortController(); c.abort(r); return abortReasonOf(c.signal); });
  assert.deepEqual(seen, reasons);
  assert.equal(new Set(seen).size, 3, 'the three causes must stay distinguishable');
});

test('⚠️ a bare abort() does not surface Node\'s generic AbortError', () => {
  // `abort()` with no argument makes Node supply an AbortError whose message is
  // "This operation was aborted" — true, useless, and not in our voice.
  const c = new AbortController();
  c.abort();
  assert.equal(abortReasonOf(c.signal), 'the run was cancelled');
});

test('⚠️ a real Error reason keeps its message', () => {
  const c = new AbortController();
  c.abort(new Error('the workspace was deleted underneath the run'));
  assert.equal(abortReasonOf(c.signal), 'the workspace was deleted underneath the run');
});

test('⚠️ junk reasons degrade to the plain sentence, never to "[object Object]"', () => {
  for (const junk of [{}, [], 0, false, '   ']) {
    const c = new AbortController();
    c.abort(junk);
    const r = abortReasonOf(c.signal);
    assert.ok(typeof r === 'string' && r.length > 0, `${JSON.stringify(junk)} produced ${r}`);
    assert.doesNotMatch(r, /\[object Object\]/);
    /**
     * ⚠️ `length > 0` WAS NOT ENOUGH, AND A MUTATION PROVED IT. A whitespace-only
     * reason satisfies it — so deleting the `.trim()` guard let `'   '` through
     * as the run's stated reason, and the test stayed green. The user would have
     * been told the run stopped because of three spaces.
     */
    assert.ok(r.trim().length > 0, `${JSON.stringify(junk)} produced whitespace, which reads as a blank reason`);
  }
});

test('⭐ no signal at all is the ordinary case and says so', () => {
  assert.equal(abortReasonOf(null), 'the run was cancelled');
  assert.equal(abortReasonOf(undefined), 'the run was cancelled');
  assert.equal(abortReasonOf({}), 'the run was cancelled');
});

test('⭐⭐ an un-aborted signal never reads as aborted', () => {
  // The guard in the loop is `signal?.aborted`, so a live controller must be
  // falsy there — otherwise every run with a signal attached would stop at
  // round one, which is the failure mode that would be caught in production
  // rather than here.
  const c = new AbortController();
  assert.equal(c.signal.aborted, false);
  c.abort('now');
  assert.equal(c.signal.aborted, true);
});

/* ── the LOOP, which the unit tests above cannot see ──────────────────────── */

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ws = () => createLocalExecutor(mkdtempSync(join(tmpdir(), 'acuvo-abort-')));

test('⭐⭐ an already-aborted signal stops the loop BEFORE any model call', async () => {
  /**
   * The reach test. Everything above drives `abortReasonOf`; this drives the
   * real loop and proves the guard is actually consulted — and consulted FIRST,
   * above the money check, so a cancelled run is never told it stopped for
   * budget.
   */
  let called = 0;
  const c = new AbortController();
  c.abort('another terminal took the lease');

  const out = await runSession({
    task: 'do something',
    executor: ws(),
    config: { apiKey: 'k', model: 'm' },
    signal: c.signal,
    maxRounds: 5,
    callModelImpl: async () => { called += 1; return { ok: true, content: 'hi', toolCalls: [], usage: {}, finishReason: 'stop' }; },
    onEvent: () => {},
  });

  assert.equal(called, 0, 'not one token may be spent after the caller withdrew permission');
  assert.equal(out.stoppedBecause, 'aborted');
});

test('⚠️⚠️ an abort RETURNS CLEANLY — the run is not lost', async () => {
  /**
   * The whole reason to have this rather than a kill. A killed run loses its
   * session AND its audit line, so the run a user most wants to resume is the
   * one that leaves nothing behind.
   */
  const c = new AbortController();
  c.abort('you pressed Ctrl-C');
  const out = await runSession({
    task: 'do something',
    executor: ws(),
    config: { apiKey: 'k', model: 'm' },
    signal: c.signal,
    maxRounds: 5,
    callModelImpl: async () => ({ ok: true, content: 'hi', toolCalls: [], usage: {}, finishReason: 'stop' }),
    onEvent: () => {},
  });
  assert.equal(out.ok, true, 'an abort is a clean outcome, not a thrown error');
  assert.ok(Array.isArray(out.rounds), 'the round record must still be there');
  assert.ok('verification' in out, 'the summary machinery must still have run');
});

test('⭐ the abort EVENT is emitted, with the caller\'s reason', async () => {
  const seen = [];
  const c = new AbortController();
  c.abort('the fleet ceiling for today was reached');
  await runSession({
    task: 'do something',
    executor: ws(),
    config: { apiKey: 'k', model: 'm' },
    signal: c.signal,
    maxRounds: 3,
    callModelImpl: async () => ({ ok: true, content: 'hi', toolCalls: [], usage: {}, finishReason: 'stop' }),
    onEvent: (e) => seen.push(e),
  });
  const ev = seen.find((e) => e.type === 'aborted');
  assert.ok(ev, 'an abort with no event is an abort nobody can see');
  assert.match(ev.reason, /fleet ceiling/);
});

test('⭐⭐ NO signal behaves exactly as before — every existing caller is unchanged', async () => {
  let called = 0;
  const out = await runSession({
    task: 'do something',
    executor: ws(),
    config: { apiKey: 'k', model: 'm' },
    maxRounds: 1,
    callModelImpl: async () => { called += 1; return { ok: true, content: 'done', toolCalls: [], usage: {}, finishReason: 'stop' }; },
    onEvent: () => {},
  });
  assert.equal(called, 1, 'a run with no signal must still call the model');
  assert.notEqual(out.stoppedBecause, 'aborted');
});
