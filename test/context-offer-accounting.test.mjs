/**
 * ── ⚠️⚠️ THE CONTEXT BUDGET WAS BLIND TO 6.8% OF THE PAYLOAD ────────────────
 *
 * A chat completion sends messages AND the `tools` array; the provider counts
 * both. `estimateMessagesTokens` measures messages, and until 2026-08-13 that
 * was the only thing the compaction trigger looked at.
 *
 * Measured on a bare machine: 34 tools, 26,287 characters of schema, ~6,572
 * tokens against a 96,000-token budget — invisible. With MCP servers attached
 * it is far larger, because those schemas are written by somebody else and
 * nobody here trims them.
 *
 * ⭐ The failure it produces is the worst-shaped one available: the compactor
 * reports headroom while the provider returns a context-length error. It reads
 * as a provider bug, it is not reproducible from the transcript we kept, and
 * compaction can NEVER rescue it — compaction rewrites messages, and the offer
 * is not a message.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateToolOfferTokens, estimateMessagesTokens } from '../lib/compact.mjs';
import { toolSchemasFor, toolNamesForRounds } from '../lib/tools.mjs';

test('⚠️⚠️ the real tool offer is thousands of tokens, not zero', () => {
  const offered = toolSchemasFor(toolNamesForRounds(5, { root: process.cwd(), env: {} }));
  assert.ok(offered.length > 20, `only ${offered.length} tools offered — the fixture is wrong, not the code`);

  const tokens = estimateToolOfferTokens(offered);
  assert.ok(tokens > 3_000, `the offer measured ${tokens} tokens — it used to be counted as 0, and it is not small`);
});

test('an empty or absent offer is genuinely zero', () => {
  assert.equal(estimateToolOfferTokens([]), 0);
  assert.equal(estimateToolOfferTokens(null), 0);
  assert.equal(estimateToolOfferTokens(undefined), 0);
});

test('⭐ the offer is measured on the same scale as the messages it is added to', () => {
  /**
   * The two numbers are summed and compared against one budget, so they have to
   * use the same crude chars/4 estimate. An accurate tokeniser for one half and
   * a guess for the other would make the total meaningless.
   */
  const text = 'x'.repeat(4_000);
  const asMessage = estimateMessagesTokens([{ role: 'user', content: text }]);
  const asOffer = estimateToolOfferTokens([text]);        // JSON.stringify adds the quotes
  assert.ok(Math.abs(asMessage - asOffer) < 20, `${asMessage} vs ${asOffer} — the halves are on different scales`);
});

test('⚠️ a circular schema does not crash a run', () => {
  const circular = { name: 'x' };
  circular.self = circular;
  assert.doesNotThrow(() => estimateToolOfferTokens([circular]));
  assert.equal(estimateToolOfferTokens([circular]), 0, 'unmeasurable is 0 — but it must not take the session down');
});

test('⭐ MCP schemas count too — they are the ones nobody here trims', () => {
  const fakeMcp = Array.from({ length: 30 }, (_, i) => ({
    type: 'function',
    function: {
      name: `mcp__server__tool_${i}`,
      description: 'a description written by somebody else, at whatever length they chose. '.repeat(6),
      parameters: { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(200) } } },
    },
  }));
  const tokens = estimateToolOfferTokens(fakeMcp);
  assert.ok(tokens > 2_000, `30 MCP tools measured ${tokens} tokens — this is the half that grows without us`);
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SEAM — and the reason this section exists
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ⚠️⚠️ THE TESTS ABOVE DO NOT PROVE THE FIX IS WIRED IN, and I checked rather
 * than assumed: deleting `+ estimateToolOfferTokens(tools)` from `turn.mjs`
 * left all five of them GREEN. A perfect estimator that nothing calls is the
 * defect this package finds more often than any other, and it was about to be
 * shipped by the change that documents it.
 *
 * So this drives the REAL loop with a transcript sized so that the messages
 * alone sit UNDER the budget while messages + offer sit over it. Compaction
 * firing is the only observable proof that the trigger counts the offer.
 */

import { runSession } from '../lib/turn.mjs';
import { createMemoryExecutor } from '../lib/memory-workspace.mjs';

test('⭐⭐ THE TRIGGER COUNTS THE OFFER — proven by the loop, not by the estimator', async () => {
  const events = [];

  /**
   * ⚠️ MANY MIDDLE ROUNDS, NOT ONE BIG MESSAGE. The first attempt at this test
   * put the whole transcript in a single assistant message and it did NOT
   * compact — correctly: the compactor keeps the head and the last two rounds,
   * so there was nothing it was ALLOWED to drop. The arithmetic had been right
   * all along (97,205 against a 96,000 budget); the fixture gave it no room to
   * act. A test that cannot observe the behaviour proves nothing about it.
   */
  /**
   * ⚠️ TOOL ROUNDS, NOT PROSE. Two earlier fixtures failed here and both were
   * the fixture's fault: one giant message sits inside the "keep the last two
   * rounds" window and cannot be dropped, and a transcript of plain
   * assistant/user prose is not compactable at all — `compactMessages` only
   * sheds rounds that CONTAIN TOOL RESULTS, which is the right design because
   * tool results are the half that actually grows in a coding session.
   *
   * ⭐ So the fixture has to look like a real session: an assistant turn asking
   * for a file, and a fat `role: 'tool'` result coming back.
   */
  const chunk = 'y'.repeat(9_400);            // ~2,350 tokens per result
  const middle = [];
  for (let i = 0; i < 40; i += 1) {
    middle.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/mod${i}.js` }) } }],
    });
    middle.push({ role: 'tool', tool_call_id: `c${i}`, content: `src/mod${i}.js:
${chunk}` });
  }
  const priorMessages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'the workspace context' },
    ...middle,
  ];

  // Sanity: the messages ALONE must sit under the budget, or this test would
  // pass without the offer being counted at all.
  const msgTokens = estimateMessagesTokens(priorMessages);
  assert.ok(msgTokens < 96_000, `the fixture is ${msgTokens} tokens on its own — it would compact without the offer`);
  assert.ok(msgTokens > 80_000, `the fixture is only ${msgTokens} tokens — the offer could never tip it over`);

  await runSession({
    task: 'do something small',
    executor: createMemoryExecutor({ 'a.js': 'export const x = 1;' }),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: 2,
    allowRun: false,
    priorMessages,
    onEvent: (e) => events.push(e),
    callModelImpl: async () => ({ ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' }),
  });

  assert.ok(
    events.some((e) => e.type === 'compact'),
    `messages alone are ${msgTokens} tokens (under budget) and nothing compacted — `
    + 'the trigger is measuring messages only, so the tool offer is invisible again',
  );
});
