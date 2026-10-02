/**
 * ── 💰⭐⭐⭐ WHICH UPSTREAM SERVED IT — THE MISSING HALF OF THE CACHE STORY ───
 *
 * Roman asked repeatedly how anyone could KNOW the cache will not revert. The
 * honest answer was that nobody could: we recorded the hit RATE and never
 * recorded WHICH UPSTREAM produced it, so a miss had no explanation and every
 * theory about one was a guess.
 *
 * ⭐ MEASURED AGAINST THE LIVE API, 2026-08-22 — each provider keeps its OWN
 * prompt cache, and an OpenRouter provider `order` is a PREFERENCE:
 *
 *     order:[StreamLake,Baidu,GMICloud] allow_fallbacks:true
 *       -> StreamLake, Baidu, StreamLake     (rotates; every switch is a miss)
 *     order:[StreamLake]                allow_fallbacks:true
 *       -> Sail Research x4, StreamLake x1   (still leaves the pin)
 *     only:[StreamLake]
 *       -> StreamLake x5                     (sticky)
 *
 * The warm leg already sends `only`, so the routing was right. What was absent
 * was the evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pinOutcome } from '../lib/model.mjs';

test('⭐⭐⭐ a pin that TOOK, one that FELL BACK, and one that MISSED are three answers', () => {
  /**
   * ⚠️ These are not shades of the same thing. "Took" is healthy. "Fell back"
   * means the preferred upstream was unavailable and the cache is cold but the
   * routing worked. "Missed" means we were routed somewhere we never named —
   * the pin did nothing at all. Collapsing them loses the only signal that
   * distinguishes a bad minute from a broken configuration.
   */
  const pin = ['StreamLake', 'Baidu'];
  assert.equal(pinOutcome({ pin, served: 'StreamLake' }), 'took');
  assert.equal(pinOutcome({ pin, served: 'Baidu' }), 'fell-back');
  assert.equal(pinOutcome({ pin, served: 'Sail Research' }), 'missed');
});

test('⚠️ no pin and no answer are DIFFERENT from a failure', () => {
  /**
   * A direct vendor call has no provider concept at all, so reporting "missed"
   * for one would invent a routing fault where none can exist.
   */
  assert.equal(pinOutcome({ pin: [], served: 'StreamLake' }), 'none');
  assert.equal(pinOutcome({ pin: null, served: 'StreamLake' }), 'none');
  assert.equal(pinOutcome({ pin: ['StreamLake'], served: null }), 'unknown');
});

test('⭐ the comparison is case- and whitespace-insensitive', () => {
  // Provider names come back from a third party; matching on exact bytes would
  // report a miss the first time someone capitalises differently.
  assert.equal(pinOutcome({ pin: ['streamlake'], served: '  StreamLake ' }), 'took');
});

test('⭐⭐ a POOR cache rate names the upstream; a good one does not', async () => {
  /**
   * On a healthy run the provider name is noise. On a bad one it is the entire
   * explanation — so it appears exactly when somebody needs it.
   */
  const { formatSummary } = await import('../lib/turn.mjs');
  const base = {
    ok: true,
    executed: [{ name: 'read_file', result: { ok: true }, mutated: false }],
    model: 'deepseek/deepseek-v4-flash-0731',
    roundsUsed: 1,
  };
  const cold = formatSummary({
    ...base,
    servedBy: 'Sail Research',
    usage: { cost: 0.001, total_tokens: 100, cache: { hitRate: 0, cachedTokens: 0, promptTokens: 900, roundsUnknown: 0 } },
  }).join('\n');
  assert.match(cold, /served by Sail Research/, 'a cold run must name who served it — that is the diagnosis');

  const warm = formatSummary({
    ...base,
    servedBy: 'StreamLake',
    usage: { cost: 0.001, total_tokens: 100, cache: { hitRate: 0.96, cachedTokens: 864, promptTokens: 900, roundsUnknown: 0 } },
  }).join('\n');
  assert.doesNotMatch(warm, /served by/, 'a warm run does not need to name the upstream');
});
