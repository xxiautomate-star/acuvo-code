/**
 * ── ⭐⭐ A REFUSAL THAT NAMES NO ALTERNATIVE READS AS A CEILING ──────────────
 *
 * `tokenizeCommand`'s quote refusal explained the model of the world — no shell,
 * one plain command — and stopped there. MEASURED 2026-08-14 in a dogfood run:
 * the agent asked for `node -e "…"`, the commonest zero-dependency check there
 * is, hit the wall, and ended the run having done nothing. The reviewing agent
 * nearly filed it as a MISSING CAPABILITY — which would have been wrong twice
 * over, because `run_program` takes a real argv array and `evaluate` runs
 * JavaScript, both ship, and both take the same allowlist.
 *
 * ⭐ THE RULE THIS PINS: where a refusal exists because a SAFER PATH exists, the
 * refusal must name that path. An agent that believes something is impossible
 * stops trying, and that is the most expensive way to be wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { tokenizeCommand } from '../lib/command.mjs';

test('⚠️⚠️ the quote refusal names run_program AND evaluate', () => {
  const r = tokenizeCommand('node -e "console.log(1)"');
  assert.equal(r.ok, false);
  assert.match(r.error, /run_program/, 'the argv escape hatch must be named');
  assert.match(r.error, /evaluate/, 'the JavaScript path must be named — `node -e` is what triggered this');
});

test('⭐ it still explains WHY, not only where to go instead', () => {
  // The original sentence was good and is load-bearing: it teaches that there is
  // no shell at all, which prevents the next five attempts as well as this one.
  const r = tokenizeCommand('cat a.txt | grep x');
  assert.equal(r.ok, false);
  assert.match(r.error, /no shell here/i);
  assert.match(r.error, /run_program/);
});

test('⚠️ the refusal still FIRES — naming an alternative is not permission', () => {
  // The whole point is that these remain refused. A fix that made the message
  // friendlier by letting the command through would be catastrophic, and this is
  // the assertion that would catch it.
  for (const bad of ['echo hi > out.txt', 'a && b', 'a; b', 'echo `whoami`', 'echo $(pwd)']) {
    assert.equal(tokenizeCommand(bad).ok, false, `${bad} must still be refused`);
  }
});

test('⭐ an ordinary command is unaffected — no advice bolted onto a success', () => {
  const r = tokenizeCommand('npm test');
  assert.equal(r.ok, true);
  assert.deepEqual(r.tokens, ['npm', 'test']);
  assert.equal(r.error, undefined);
});

test('⚠️ the OTHER refusals are untouched — this changed one branch, not the family', () => {
  // A control character is a different failure with a different remedy, and
  // pointing it at run_program would be wrong advice.
  const nl = tokenizeCommand('npm test\nrm -rf /');
  assert.equal(nl.ok, false);
  assert.match(nl.error, /control character/);
  assert.doesNotMatch(nl.error, /run_program/);

  const empty = tokenizeCommand('   ');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty command/);
});
