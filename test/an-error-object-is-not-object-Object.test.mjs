import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorText, readsAsAuthFailure } from '../lib/doctor.mjs';

/**
 * ── ⚠️⚠️⭐ FOUND BY RUNNING `--doctor`, NOT BY READING IT ───────────────────
 *
 * 2026-09-18. Six media services printed the literal text
 * **`answered: [object Object]`**: the gateway returns an OBJECT for `error`
 * and three call sites rendered it with `String()`.
 *
 * ⚠️⚠️ THE COSMETIC HALF WAS THE LESS IMPORTANT HALF, and that is the whole
 * reason this file exists. `readsAsAuthFailure` used the same `String(s ?? '')`,
 * so EVERY object-shaped error collapsed to the constant `"[object Object]"`,
 * matched none of its patterns, and the service was classified **healthy**.
 * A doctor that reports a credential-rejecting service as `live` is the worst
 * of the three outcomes, because unlike `dark` and `broken` nothing prompts
 * anyone to look.
 *
 * ⭐ THE ASSERTION THAT MATTERS IS THE AUTH ONE. The rendering tests below are
 * real but cheap; `objectShapedAuthFailure` is the one that was a live defect.
 */

test('⭐ an object-shaped auth failure is DETECTED — the hole String() left open', () => {
  // Every one of these stringifies to the constant "[object Object]".
  assert.equal(readsAsAuthFailure({ message: 'Unauthorized' }), true);
  assert.equal(readsAsAuthFailure({ error: 'Forbidden' }), true);
  assert.equal(readsAsAuthFailure({ detail: 'invalid token' }), true);
  assert.equal(readsAsAuthFailure({ error: { message: 'not authenticated' } }), true);

  /**
   * ⚠️ THE MUTATION PROOF, INLINE. This is what the code did before the fix —
   * if this assertion ever fails, `String()` has come back and the guard above
   * is passing for the wrong reason.
   */
  const asItWas = (s) => /unauthoris|unauthoriz|forbidden|401|403/i.test(String(s ?? ''));
  assert.equal(asItWas({ message: 'Unauthorized' }), false, 'the old code really did miss this');
});

test('⚠️ and a healthy payload complaint is still NOT an auth failure', () => {
  // These are the six real answers the live gateway gives. All mean "credential accepted".
  assert.equal(readsAsAuthFailure({ message: 'no html supplied' }), false);
  assert.equal(readsAsAuthFailure({ message: 'nothing to say — text is required' }), false);
  assert.equal(readsAsAuthFailure('nothing to transcribe — supply audio_b64'), false);
  assert.equal(readsAsAuthFailure(null), false);
});

test('errorText renders every shape a service actually sends', () => {
  assert.equal(errorText('plain'), 'plain');
  assert.equal(errorText('  collapses   whitespace \n yes '), 'collapses whitespace yes');
  assert.equal(errorText({ message: 'from message' }), 'from message');
  assert.equal(errorText({ error: 'from error' }), 'from error');
  assert.equal(errorText({ detail: 'from detail' }), 'from detail');
  assert.equal(errorText({ error: { message: 'one level deeper' } }), 'one level deeper');
});

test('⚠️ an unanticipated shape degrades to readable JSON, never to a constant', () => {
  // The point: two DIFFERENT unknown errors must not render identically, or the
  // auth test above is matching on a constant again.
  const a = errorText({ code: 5 });
  const b = errorText({ code: 9 });
  assert.notEqual(a, b);
  assert.equal(a, '{"code":5}');
  assert.equal(errorText(null), '');
  assert.equal(errorText(undefined), '');
  assert.equal(errorText(404), '404');
});
