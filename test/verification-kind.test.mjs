/**
 * ── ⚠️⚠️ A GREEN CHECK FOR A COMMAND THAT DOES NOT EXIST ────────────────────
 *
 * `turn.mjs` records an HTTP probe as evidence when a background server answers
 * — real evidence, often better than a test exiting 0. But it stored it as:
 *
 *     command:  "GET http://localhost:4173/"     // nothing executed this
 *     exitCode: 0                                // there was no process
 *
 * and the summary rendered **"✔ VERIFIED — `GET http://localhost:4173/` exited
 * 0"**. A fabricated exit code, in a product whose entire pitch is that the
 * verdict comes from a recorded exit code rather than the model's prose.
 *
 * ⚠️⚠️ AND IT POISONED OUR OWN HONESTY FEATURE. `verify-claim.mjs`'s header
 * promises that `command` is "the exact command this process observed exiting
 * 0", so `acuvo verify` handed the URL to the command runner and got a refusal —
 * free re-verification reporting itself broken on a claim that was never a
 * command.
 *
 * ⭐ THE SIGNAL IS KEPT. Deleting the probe would make the tool weaker and
 * honest; labelling it makes it stronger and honest.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { recheckClaim, recheckAll, formatRecheck } from '../lib/verify-claim.mjs';

const runRecord = (verification, id = 'r1') => ({ id, run: { verification } });
const probe = {
  ran: true, passed: true, kind: 'http-probe',
  command: 'GET http://localhost:4173/', status: 200, exitCode: null, attempts: 0,
};
const realCommand = {
  ran: true, passed: true, kind: 'command',
  command: 'npm test', exitCode: 0, attempts: 1,
};

test('⭐⭐ a probe is never handed to the command runner', async () => {
  let ranWith = null;
  const r = await recheckClaim(runRecord(probe), {
    runner: async (cmd) => { ranWith = cmd; return { ok: true, exitCode: 0 }; },
  });
  assert.equal(ranWith, null, 'the runner must not be called with a URL');
  assert.equal(r.status, 'unverifiable');
  assert.equal(r.ok, true, 'unverifiable is not an error — nothing went wrong');
});

test('⚠️⚠️ unverifiable is NOT reported as a failure', () => {
  /**
   * `formatRecheck` falls through to "✖ THE CLAIM NO LONGER HOLDS" for any
   * status it does not know, so an unhandled `unverifiable` would render a
   * claim that was never re-tested as a FAILED one — the false-negative this
   * whole command exists to avoid.
   */
  const text = formatRecheck({ status: 'unverifiable', id: 'r1', command: 'GET http://x/', message: 'not a command this can execute.' });
  assert.doesNotMatch(text, /NO LONGER HOLDS/);
  assert.doesNotMatch(text, /✖/);
});

test('⚠️ unverifiable is NOT reported as still true either', () => {
  // A server that is not running now says nothing about whether it ran then.
  // Quietly returning "holds" would be the same lie in the other direction.
  const text = formatRecheck({ status: 'unverifiable', id: 'r1', command: 'GET http://x/', message: 'not a command this can execute.' });
  assert.doesNotMatch(text, /STILL HOLDS/);
});

test('⭐ a REAL command claim is still re-run exactly as before', async () => {
  let ranWith = null;
  const r = await recheckClaim(runRecord(realCommand), {
    runner: async (cmd) => { ranWith = cmd; return { ok: true, exitCode: 0 }; },
  });
  assert.equal(ranWith, 'npm test');
  assert.equal(r.status, 'holds');
});

test('⚠️⚠️ history written BEFORE `kind` existed stays re-checkable', async () => {
  /**
   * Every audit record on disk today has no `kind`. Treating absent as
   * "not a command" would silently stop checking the entire existing history —
   * a worse failure than the one being fixed, and an invisible one.
   */
  const legacy = { ran: true, passed: true, command: 'npm test', exitCode: 0, attempts: 1 };
  let ranWith = null;
  const r = await recheckClaim(runRecord(legacy), {
    runner: async (cmd) => { ranWith = cmd; return { ok: true, exitCode: 0 }; },
  });
  assert.equal(ranWith, 'npm test');
  assert.equal(r.status, 'holds');
});

test('⭐⭐ recheckAll skips probes and still checks real commands', async () => {
  const seen = [];
  const out = await recheckAll(
    [runRecord(probe, 'p1'), runRecord(realCommand, 'c1'), runRecord(probe, 'p2')],
    { runner: async (cmd) => { seen.push(cmd); return { ok: true, exitCode: 0 }; } },
  );
  assert.deepEqual(seen, ['npm test'], 'only the real command may be executed');
  assert.equal(out.checked, 1);
  assert.equal(out.ok, true);
});

test('⚠️⚠️ recheckAll still checks history written BEFORE `kind` existed', async () => {
  /**
   * ⚠️ I MISSED THIS FIRST TIME AND THE MUTATION FOUND IT. My legacy test
   * covered `recheckClaim`, while the `?? 'command'` default it was protecting
   * lives in `recheckAll` — so tightening that filter to a strict
   * `kind === 'command'` SURVIVED, and would have silently stopped re-checking
   * every audit record on disk today. A migration that quietly narrows what it
   * checks is worse than the bug it fixes, because nothing goes red.
   */
  const legacy = { ran: true, passed: true, command: 'npm run lint', exitCode: 0, attempts: 1 };
  const seen = [];
  const out = await recheckAll([runRecord(legacy, 'old1'), runRecord(probe, 'p1')], {
    runner: async (cmd) => { seen.push(cmd); return { ok: true, exitCode: 0 }; },
  });
  assert.deepEqual(seen, ['npm run lint'], 'a record with no `kind` is a command and must still be re-run');
  assert.equal(out.checked, 1);
});

test('⚠️ recheckAll on probes ALONE reports nothing checked, not everything fine', async () => {
  const seen = [];
  const out = await recheckAll([runRecord(probe, 'p1')], {
    runner: async (cmd) => { seen.push(cmd); return { ok: true, exitCode: 0 }; },
  });
  assert.deepEqual(seen, []);
  assert.equal(out.checked, 0);
  // ⭐ `unclaimed` counts what could not be re-checked, so "0 checked" never
  // reads as "0 problems".
  assert.ok(out.unclaimed >= 1, 'a skipped probe must be counted somewhere visible');
});
