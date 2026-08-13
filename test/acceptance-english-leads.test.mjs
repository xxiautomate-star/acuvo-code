/**
 * ── ⚠️⚠️ "make sure it passes" WAS INVENTING A BUILD ─────────────────────────
 *
 * `deriveAcceptance` reads the USER's words and fixes the criterion before the
 * work, which is the whole argument of `acceptance.mjs`. Measured 2026-08-13 on
 * sentences a person would actually type:
 *
 *   "run npm test and make sure it passes"         -> npm test, MAKE
 *   "make sure the build works"                    -> MAKE
 *   "please make certain the suite is green"       -> MAKE CERTAIN
 *   "go through the tests and make sure they pass" -> GO THROUGH, MAKE
 *
 * Each phantom then reported `✖ UNMET — you asked that make pass; it was never
 * run`, i.e. correct work reported as failed — this package's worst failure
 * class — triggered by the single most ordinary way of asking for verification.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveAcceptance } from '../lib/acceptance.mjs';

const commands = (s) => deriveAcceptance(s, { source: 'user' }).map((c) => c.command).filter(Boolean);

test('⚠️⚠️ "make sure" is a request for verification, never a build', () => {
  assert.deepEqual(commands('run npm test and make sure it passes'), ['npm test'],
    'the phantom `make` is back — and it fails a run whose work was correct');
  assert.deepEqual(commands('make sure the build works'), []);
  assert.deepEqual(commands('please make certain the suite is green'), []);
});

test('⚠️ "go through" and "go ahead" are English too', () => {
  assert.deepEqual(commands('go through the tests and make sure they pass'), [],
    'one ordinary sentence was producing TWO criteria nobody asked for');
  assert.deepEqual(commands('go ahead and verify it works'), []);
});

test('⭐⭐ AND THE REAL COMMANDS SURVIVE — refusing a criterion the user typed is the same bug backwards', () => {
  assert.deepEqual(commands('make test must pass'), ['make test']);
  assert.deepEqual(commands('go build must succeed'), ['go build']);
  /**
   * ⚠️ A STOPWORD LIST, NOT A TARGET WHITELIST. Whitelisting `test`/`build`
   * would refuse a project's own real target, and every repository has ones we
   * have never heard of.
   */
  assert.deepEqual(commands('make migrate should pass'), ['make migrate']);
  assert.deepEqual(commands('make e2e must pass'), ['make e2e']);
});

test('⚠️ a lead with nothing after it is prose — "just make it pass"', () => {
  assert.deepEqual(commands('just make it pass'), []);
  assert.deepEqual(commands('make'), []);
});

test('the other leads are untouched — only make and go are English verbs', () => {
  assert.deepEqual(commands('npm test must pass'), ['npm test']);
  assert.deepEqual(commands('pytest -q must pass'), ['pytest -q']);
  assert.deepEqual(commands('cargo test must pass'), ['cargo test']);
});
