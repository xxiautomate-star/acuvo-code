/**
 * ── ⭐⭐ THE INSTRUMENT THAT MAKES THE MARGIN CHECKABLE ──────────────────────
 *
 * `lib/cache-floor.mjs` exists because `PRICING.md` sizes the whole ladder on
 * `sharedHead ÷ typicalPrompt` and neither term had ever been read off the wire.
 * These tests pin the one distinction the file is FOR: shared bytes and a shared
 * prefix are different quantities, and only the second one bills.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sharedPrefixBytes,
  sharedSuffixBytes,
  cacheFloor,
  describeDivergence,
  wireBytes,
} from '../lib/cache-floor.mjs';

test('the shared prefix stops at the first differing byte', () => {
  assert.equal(sharedPrefixBytes('abcdef', 'abcXef'), 3);
  assert.equal(sharedPrefixBytes('abc', 'abc'), 3);
  assert.equal(sharedPrefixBytes('', 'abc'), 0);
  assert.equal(sharedPrefixBytes('Xabc', 'abc'), 0);
  // A shorter string that is a prefix of the longer shares all of itself.
  assert.equal(sharedPrefixBytes('abc', 'abcdef'), 3);
});

test('⚠️⚠️ 98.9% SHARED AND 0% CACHEABLE IS A REAL SHAPE, AND IT IS THE TRAP', () => {
  /**
   * The live lead this file was written for: a probe measured 98.9% shared bytes
   * between consecutive requests and a 0% cache hit, and the two readings look
   * contradictory only if "shared" is mistaken for "cacheable". They are not the
   * same measurement, and a probe that reports one of them cannot diagnose the
   * other.
   */
  const body = 'x'.repeat(1000);
  const a = `A${body}`;
  const b = `B${body}`;
  const d = describeDivergence(a, b);

  assert.equal(d.sharedPrefix, 0, 'one differing byte at the front leaves NO cacheable prefix');
  assert.equal(d.floor, 0, 'and therefore a floor of zero');
  assert.ok(d.sharedFraction > 0.98, `these two are ${(d.sharedFraction * 100).toFixed(1)}% shared`);
  assert.equal(d.at, 0, 'and the report names the byte, so the finding is actionable');
});

test('⭐ the mirror case: one differing byte at the END costs almost nothing', () => {
  const body = 'x'.repeat(1000);
  const d = describeDivergence(`${body}A`, `${body}B`);
  assert.equal(d.sharedPrefix, 1000);
  assert.ok(d.floor > 0.99, `floor was ${d.floor}`);
  /**
   * ⚠️ THE SAME 99.9% SHARED FRACTION AS THE TEST ABOVE, and the opposite bill.
   * That is the entire argument for reporting both numbers rather than one.
   */
  assert.ok(Math.abs(d.sharedFraction - describeDivergence(`A${body}`, `B${body}`).sharedFraction) < 0.01);
});

test('the shared suffix cannot overlap the shared prefix and double-count', () => {
  /**
   * ⚠️ WITHOUT THE CLAMP two identical strings report their whole length TWICE,
   * and `sharedFraction` comes back at 200% — a measurement that cannot be wrong
   * because it is not a measurement.
   */
  const d = describeDivergence('abcdef', 'abcdef');
  assert.equal(d.sharedPrefix, 6);
  assert.equal(d.sharedSuffix, 0);
  assert.equal(d.sharedFraction, 1);
  assert.equal(d.identical, true);
  assert.equal(d.at, null, 'identical strings have no divergence to point at');
});

test('the suffix is measured where there IS one', () => {
  assert.equal(sharedSuffixBytes('abcXYZend', 'abcQQQend'), 3);
  assert.equal(sharedSuffixBytes('abc', 'xyz'), 0);
});

test('the floor divides by the LARGER prompt, because that is the one we are billed for', () => {
  assert.equal(cacheFloor({ sharedHead: 50, typicalPrompt: 100 }), 0.5);
  assert.equal(cacheFloor({ sharedHead: 0, typicalPrompt: 100 }), 0);
  // A head longer than the prompt is a caller error, not a floor above 100%.
  assert.equal(cacheFloor({ sharedHead: 200, typicalPrompt: 100 }), 1);
});

test('⚠️ a rate with an empty denominator is null, never 0 and never NaN', () => {
  /**
   * The same rule `aggregateCache` follows in turn.mjs. Reporting 0% for "we
   * measured nothing" is the lie that makes a healthy fleet look broken.
   */
  assert.equal(cacheFloor({ sharedHead: 10, typicalPrompt: 0 }), null);
  assert.equal(cacheFloor({}), null);
  assert.equal(cacheFloor({ sharedHead: 10, typicalPrompt: 'lots' }), null);
  assert.equal(describeDivergence('', '').sharedFraction, null);
});

test('the divergence window shows BOTH sides, so the cause can be read off it', () => {
  const a = `${'head'.repeat(50)}LEFT${'tail'.repeat(50)}`;
  const b = `${'head'.repeat(50)}RIGHT${'tail'.repeat(50)}`;
  const d = describeDivergence(a, b, { context: 10 });
  assert.ok(d.aroundA.includes('LEFT'), `A window was ${JSON.stringify(d.aroundA)}`);
  assert.ok(d.aroundB.includes('RIGHT'), `B window was ${JSON.stringify(d.aroundB)}`);
  assert.ok(d.aroundA.length <= 20, 'the window is bounded by `context` on each side');
});

test('⭐ the wire serialisation puts the TOOLS ahead of the messages', () => {
  /**
   * ⚠️ A PROBE THAT SERIALISES ONLY `messages` IS BLIND TO 94% OF THE SHARED
   * HEAD. Measured on this repo: 21,466 of the 22,889 bytes two tenants have in
   * common are tool schemas, and they are rendered into the prompt first.
   */
  const w = wireBytes({ tools: [{ function: { name: 'read_file' } }], messages: [{ role: 'system', content: 'rules' }] });
  assert.ok(w.indexOf('read_file') < w.indexOf('rules'), 'tools must serialise before messages');
  // Deterministic: two calls on equal input produce equal bytes.
  assert.equal(w, wireBytes({ tools: [{ function: { name: 'read_file' } }], messages: [{ role: 'system', content: 'rules' }] }));
});

test('an absent tools block is still a measurable request', () => {
  const w = wireBytes({ messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(w.includes('"tools":null'));
  assert.ok(w.includes('hi'));
});
