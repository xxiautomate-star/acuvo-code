/**
 * ── ⭐⭐ THE PIN MUST NOT ENGAGE BEFORE THERE IS ANYTHING TO SCROLL ──────────
 *
 * Roman, 2026-08-24: *"you type acuvo then the stuff appears like all the way at
 * the bottom of page."*
 *
 * `pinRegion` reserves the last rows of the PHYSICAL WINDOW (`height - rows`).
 * Called before the banner on a fresh 50-row terminal that puts the banner at
 * the top, the input box at row 50, and forty blank lines in between. Nothing is
 * broken — it is the right behaviour applied to a screen with no content yet.
 *
 * So it now engages on the first submitted task. This file exists because that
 * is a ONE-LINE thing to undo by accident: moving `pinRegion(output)` back to
 * the top of `runChat` restores the gap and no other test notices.
 *
 * ⚠️ IT IS A STRUCTURAL GUARD AND SAYS SO. Driving the real loop needs a TTY, a
 * model and a keyboard; this asserts the shape instead. That is weaker than a
 * behavioural test and stronger than the nothing that covered it before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'chat.mjs'),
  'utf8',
);

test('⭐⭐ pinRegion is called exactly once, and only from engage()', () => {
  const calls = [...source.matchAll(/\bpinRegion\(/g)];
  assert.equal(
    calls.length,
    1,
    `pinRegion is called ${calls.length} times — it must be called once, lazily, from engage()`,
  );

  /**
   * The call must sit inside `engage()`. If someone hoists it back to the top of
   * runChat the launch gap returns, which is the entire bug this guards.
   */
  const engageAt = source.indexOf('engage()');
  assert.ok(engageAt > 0, 'the lazy pin wrapper has an engage() method');
  const callAt = calls[0].index;
  assert.ok(
    callAt > engageAt,
    'pinRegion is called before engage() is even defined — it has been hoisted back to startup,'
      + ' which puts the input box at the bottom of an empty screen',
  );
});

test('⚠️ the pin is engaged once a task is submitted, not before', () => {
  /**
   * ⚠️ ANCHOR RE-AIMED 2026-08-25, NOT WEAKENED. It read
   * `const task = line.trim();`, which stopped existing when project commands
   * (`.acuvo/commands/*.md`) split what the user TYPED from what is eventually
   * SENT — the typed line became `typedTask` so a command expansion could
   * replace `task` without corrupting the Up-arrow history or the `exit` check.
   *
   * ⭐ THE CONTRACT UNDER TEST IS UNCHANGED and is still asserted below: the
   * pin must engage AFTER the submit site, never at startup. Only the string
   * this test uses to FIND the submit site moved. Matching either spelling
   * keeps the guard honest against a revert as well as against the rename.
   */
  const taskAt = Math.max(
    source.indexOf('const typedTask = line.trim();'),
    source.indexOf('const task = line.trim();'),
  );
  const engageCall = source.indexOf('pin.engage()');
  assert.ok(taskAt > 0, 'the submit site no longer reads `line.trim()` into a task — re-aim this anchor');
  assert.ok(engageCall > 0, 'nothing engages the pin — it would stay inline forever');
  assert.ok(
    engageCall > taskAt,
    'pin.engage() runs before a task is read; it must fire when output is about to stream',
  );
});

test('⚠️⚠️ the release handlers are registered where the region is SET', () => {
  /**
   * The old code asked `if (pin.enabled)` at startup. With a lazy pin that is
   * always false, so it would have registered NOTHING — and a scroll region that
   * is never released leaves the user typing `reset` blind.
   */
  const engageBody = source.slice(source.indexOf('engage()'), source.indexOf('release() {'));
  for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
    assert.ok(
      engageBody.includes(`'${signal}'`),
      `${signal} is not released from inside engage() — a set region could outlive the process`,
    );
  }
});
