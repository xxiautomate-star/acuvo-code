/**
 * ── ⭐⭐⭐ ACCEPTANCE ITEM #1, THE HALF THAT WAS NEVER MEASURED ──────────────
 *
 * *"caching solid EVEN WHEN MODELS SWITCH."* Two files already hold the halves
 * anybody had looked at:
 *
 *   `cache-prefix-stability.test.mjs`     our bytes do not move between runs
 *   `cache-survives-model-switch.test.mjs` our bytes do not move across a switch
 *
 * ⭐ AND BOTH ARE GREEN, WHICH IS WHY THIS ONE MATTERS. The prefix is perfect
 * and the session is still cold after a fallback, because the question those
 * two ask is *"do we send the same bytes"* and the question that decides the
 * bill is *"do those bytes reach a machine that has seen them."*
 *
 * ── ⚠️⚠️ MEASURED 2026-09-17 ON THE REAL LOOP, $0.00 ───────────────────────
 *
 * `scripts/zz-cache-across-a-model-switch.mjs` drives the actual `runSession`
 * over the actual `callChain` over the actual `callModel`, with only `fetch`
 * scripted, and reads the `provider` block off every wire body:
 *
 *     deepseek/deepseek-v4-flash-0731   {"only":["Relace"]}              ← locked
 *     deepseek/deepseek-chat            none                             ← NOTHING
 *     z-ai/glm-4.6                      {"only":["Venice"]}              ← locked
 *
 * The middle row is the chain's FIRST fallback and it goes out with no
 * `provider` key at all, because `PROVIDER_PIN_BY_MODEL` has no entry for it and
 * `providerOrderFor` answers `{order:[],source:'none'}`. So the leg the CLI
 * reaches the instant the primary has a bad minute is routed across the whole
 * fleet — the routing lottery `model.mjs` measured at 0% / 31% / 65% / 98%.
 *
 * ⚠️ AND THE PRICE IS WORSE THAN THE ROUTING. Read off OpenRouter's own
 * endpoint feed the same day — both endpoints that serve `deepseek/deepseek-chat`
 * omit `input_cache_read` ENTIRELY (the field is absent, not zero; checked
 * explicitly, because a null read back as `0` would have inverted the
 * conclusion into "caching is free there"):
 *
 *     StreamLake   $0.2574 in / $1.0287 out   no cached-input price
 *     DeepInfra    $0.32    in / $0.89    out  no cached-input price
 *
 * against flash on its pin (Relace, $0.06 / $0.12 / $0.012 cached), whose warm
 * blend at 99% is ~$0.0125 per M input. **A round that falls through to
 * `deepseek-chat` pays 20.6x–25.6x per input token**, and no pin, no prefix and
 * no sticky key can change that, because the endpoint does not sell a cached
 * token at any price.
 *
 * ── ⛔ SO THE REPAIR IS A SUPPLY DECISION AND IT IS ROMAN'S ─────────────────
 *
 * Costed in `DECISION-the-first-fallback-is-unpinned.md`. It is deliberately NOT
 * taken here: `PROVIDER_PIN_BY_MODEL`'s own header records this package pinning
 * `StreamLake` from memory at 7.3x the cheapest and calling it *"the three
 * cheapest, within 3%"*, and CLAUDE.md records the same class of mistake three
 * more times. A provider name typed by a terminal is how that happens.
 *
 * ── ⭐ WHAT THIS FILE ASSERTS, THEN ─────────────────────────────────────────
 *
 * Not the fix. The SHAPE: every model `buildChain` can reach is either pinned,
 * or is a named exception carrying its measured cost. A red guard nobody can
 * close is worse than no guard (`feedback_a_red_guard_nobody_runs...`), so the
 * one open row is listed rather than failing — and the LIST is what bites: add
 * a fourth chain model with no pin and this goes red on the spot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChain } from '../lib/chain.mjs';
import { providerOrderFor, DEFAULT_MODEL } from '../lib/model.mjs';

/**
 * ⚠️ EVERY ENTRY IS A COST, NOT A TODO. The shape is copied from the console's
 * `KNOWN_EXCEEDANCES`: a row here says "we measured this, we priced it, and the
 * decision is somebody else's" — never "we did not get to it".
 */
const UNPINNED_BY_DECISION = Object.freeze({
  'deepseek/deepseek-chat': {
    why: 'both endpoints omit input_cache_read entirely; pinning cannot buy a cache that is not sold',
    costPerMInputVsWarmPrimary: '20.6x-25.6x',
    decision: 'DECISION-the-first-fallback-is-unpinned.md',
  },
});

test('⭐⭐⭐ every model the chain can reach is pinned, or is a costed exception', () => {
  const chain = buildChain(DEFAULT_MODEL, {});
  assert.ok(chain.length >= 2, `the chain collapsed to ${chain.length} model(s) — "never single" is the standing rule`);

  const unpinned = chain.filter((m) => providerOrderFor(m, {}).order.length === 0);
  const undeclared = unpinned.filter((m) => !UNPINNED_BY_DECISION[m]);

  assert.deepEqual(
    undeclared,
    [],
    `${undeclared.join(', ')} can be reached by the chain and has no provider pin, so every round it serves is `
    + 'routed across the whole fleet and lands wherever — the lottery model.mjs measured at 0/31/65/98%. Pin it '
    + 'from the LIVE endpoint feed (never from memory — that mistake is recorded three times in this repo), or '
    + 'add it to UNPINNED_BY_DECISION with the measurement that makes leaving it open the right call.',
  );
});

test('⚠️ and an exception cannot be a shrug — each one carries its price and its owner', () => {
  /**
   * ⭐ THIS IS THE HALF THAT KEEPS THE LIST HONEST. Without it, the escape above
   * is a way to silence the guard by typing a model name, which is the same
   * defect as deleting the assertion.
   */
  for (const [model, row] of Object.entries(UNPINNED_BY_DECISION)) {
    assert.ok(row.why && row.why.length > 20, `${model}: no reason recorded`);
    assert.match(String(row.costPerMInputVsWarmPrimary), /x/, `${model}: no measured cost recorded`);
    assert.match(String(row.decision), /^DECISION-.*\.md$/, `${model}: no decision document named`);
  }
});

test('⭐ and the exception list is not stale — every model on it is still in the chain', () => {
  /**
   * ⚠️ AN EXCEPTION THAT OUTLIVES ITS MODEL IS HOW A LIST BECOMES DECORATION.
   * `buildChain` changed twice this month; a name left here after it was dropped
   * would sit forever, and the next reader would take the whole list on trust.
   */
  const chain = new Set(buildChain(DEFAULT_MODEL, {}));
  for (const model of Object.keys(UNPINNED_BY_DECISION)) {
    assert.ok(chain.has(model), `${model} is excused here but the chain no longer reaches it — delete the row`);
  }
});

test('⚠️ the primary itself is never an exception — it is the one that must be pinned', () => {
  /**
   * The whole warm-lock design rests on round 1 landing on a known machine. An
   * unpinned PRIMARY would make every other guard in this package decorative,
   * and the escape hatch above must not be able to reach it.
   */
  assert.equal(UNPINNED_BY_DECISION[DEFAULT_MODEL], undefined,
    'the default model is excused from having a pin — that empties the entire caching story');
  assert.ok(providerOrderFor(DEFAULT_MODEL, {}).order.length > 0,
    'the default model has no provider pin, so round 1 of every session rolls the dice');
});
