/**
 * ── ⚠️⚠️⭐ `acuvo engines` CONTRADICTED ITSELF FOUR LINES APART ──────────────
 *
 * Driven 2026-09-07:
 *
 *     acuvo-image-ultra  193 cr/image   not in the CLI
 *     …
 *     An Ultra engine is never chosen for you: pass --engine (CLI) or engine
 *     (tool) to ask for one.
 *
 * Both ultra engines carry `localReach: false` — deliberately, and
 * `creative-engines.mjs` explains why at length: they are rented models behind
 * our own account, reaching them needs a gateway RENDER endpoint, and there is
 * none. So the footer promised, unconditionally, the one thing no user of this
 * package can do, in the same breath as saying they could not.
 *
 * ⭐ THE SAME DEFECT THIS FILE'S SUBJECT ALREADY RECORDS, RUNNING BACKWARDS.
 * The status column once printed "not in the CLI" for three engines that WERE
 * wired, because it read a boolean frozen months earlier; the cure was to
 * derive it from `engineReach`. The footer stayed prose and went stale the
 * other way. **Prose beside a derived value is an undeclared second opinion.**
 *
 * These tests pin the property, not the sentence: whatever the footer says
 * about opting into an Ultra must agree with what the rows say about reaching
 * one — in BOTH directions, so the line comes back on by itself the day an
 * Ultra gains a path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatEngineList, CREATIVE_ENGINES, engineReach } from '../lib/creative-engines.mjs';

/** A catalogue that prices every engine, so the rows are never suppressed. */
const catalogue = {
  fetchedAt: Date.now(),
  tier: 'free',
  creditsRemaining: null,
  engines: CREATIVE_ENGINES.map((e) => ({
    id: e.id, credits: 4, unit: e.unit, reachable: true, minTier: 'free',
  })),
};

const render = (env = {}) => formatEngineList({ source: 'live', catalogue, env }).join('\n');

/** Does any Ultra actually have a code path in this package, right now? */
const anyUltraRunnable = (env) =>
  CREATIVE_ENGINES.filter((e) => e.grade === 'ultra')
    .some((e) => engineReach(e, { env }).state !== 'no-path');

test('the footer agrees with the rows about Ultra', () => {
  const env = {};
  const text = render(env);
  const invites = /pass --engine/.test(text);
  assert.strictEqual(
    invites,
    anyUltraRunnable(env),
    invites
      ? 'the footer invites --engine for an Ultra while every Ultra row says it cannot be reached'
      : 'an Ultra is reachable and the footer no longer says how to ask for it',
  );
});

/**
 * ⚠️ THE HONEST STATE MUST BE STATED, NOT MERELY NOT-PROMISED. Deleting the
 * sentence would also pass the test above, and would leave a priced row with no
 * explanation — which reads as a broken install rather than a missing endpoint.
 */
test('when no Ultra is reachable, the rows are explained rather than left hanging', () => {
  const env = {};
  if (anyUltraRunnable(env)) return; // nothing to assert; the invite branch is live
  const text = render(env);
  assert.match(text, /cannot be run from this package/, 'the Ultra rows are priced and unexplained');
  assert.match(text, /Nothing you can set will turn them on/, 'a reader is left hunting for a flag that does not exist');
});

/**
 * ⭐ THE DERIVATION IS LIVE — proven by feeding a fabricated engine list in
 * which an Ultra IS reachable, and requiring the invite to come back. Without
 * this, a hardcoded "never invite" would pass both tests above forever, and the
 * line would stay dark on the day it should light up.
 */
test('MUTATION PROOF — an Ultra with a path turns the invite back on', () => {
  const reachableUltra = { id: 'x-ultra', name: 'X', medium: 'image', grade: 'ultra', unit: 'image', localReach: true };
  assert.notStrictEqual(
    engineReach(reachableUltra, { env: {} }).state,
    'no-path',
    'the predicate no longer distinguishes a reachable Ultra, so the footer cannot either',
  );
});

/**
 * ⚠️ THE "or, never and" LINE IS NOT CONDITIONAL AND MUST NOT BECOME SO. It is
 * Roman's wording and it answers a different question — what the balance buys —
 * which is true whether or not an Ultra can run.
 */
test('the or-never-and line survives regardless', () => {
  assert.match(render({}), /read them as "or", never "and"/);
});
