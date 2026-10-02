/**
 * ── ⭐⭐⭐ AN MCP CALL IS NOT EVIDENCE OF A WRONG SHORTLIST ──────────────────
 *
 * MEASURED 2026-08-29 against the real `mcp.deepwiki.com`, twice, on two
 * different briefs:
 *
 *     · offered every tool (33 → 53) — the model reached for mcp__deepwiki__ask_question
 *     · offered every tool (39 → 53) — the model reached for mcp__deepwiki__read_wiki_structure
 *
 * Both are FALSE. The model reached for a tool it already had. `turn.mjs` builds
 * the block as `[...toolSchemasFor(offered), ...mcpSchemas]` — MCP schemas are
 * appended in full and are never narrowed — so `offered` does not contain them
 * by construction, and `shouldWiden` read their absence as a wrong shortlist.
 *
 * The price, measured through `runSession` with a fake model:
 *
 *     round 1   35 tools   33,384 bytes
 *     round 2   62 tools   63,577 bytes    +30,193 B (+90.4%)
 *
 * and the widen is PERMANENT for the session, so that is paid on every remaining
 * round of a run that may go to 24. Attaching any MCP server therefore cancelled
 * the shortlist the first time the model used the server.
 *
 * ⚠️ THIS FILE'S JOB IS THE PREFIX, NOT JUST THE BEHAVIOUR. `tool-shortlist.mjs`
 * cannot import `mcp.mjs` (that would pull `child_process` into a hot path), so
 * it carries its own pattern. The one thing that makes that safe is that the
 * names below are CONSTRUCTED with `namespacedName()` — the real function — and
 * never typed out as `mcp__…`. Change the separator in `mcp.mjs` and this goes
 * red, instead of the 30KB quietly coming back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldWiden } from '../lib/tool-shortlist.mjs';
import { namespacedName } from '../lib/mcp.mjs';

test('⭐⭐⭐ calling an MCP tool does NOT widen — it was already offered', () => {
  const called = namespacedName('deepwiki', 'ask_question');
  assert.equal(
    shouldWiden([called], ['read_file', 'write_file']),
    false,
    `${called} is appended to the tool block in full and is never in \`offered\`; `
    + 'treating it as a missing tool widens the offer by ~30KB a round for nothing',
  );
});

test('⚠️ a hallucinated MCP name must not widen either — widening cannot conjure a server', () => {
  /**
   * Widening adds REGISTRY schemas. There is no round in which it produces an
   * MCP server that was never connected, so paying 30KB a round for the attempt
   * is strictly worse than declining the call.
   */
  assert.equal(shouldWiden([namespacedName('nosuchserver', 'x')], ['read_file']), false);
});

test('⭐ THE ESCAPE HATCH STILL WORKS — a real registry tool the model was not given widens', () => {
  /**
   * ⚠️ THE MUTATION THIS GUARD EXISTS TO CATCH. "Ignore MCP names" one character
   * too wide becomes "ignore everything", and the shortlist's own safety
   * property — a wrong shortlist costs ONE round, not the session — disappears
   * with nothing going red. This is the half that must stay true.
   */
  assert.equal(shouldWiden(['generate_image'], ['read_file', 'write_file']), true);
  assert.equal(shouldWiden(['read_file', 'speak'], ['read_file']), true);
});

test('⚠️ a name that merely STARTS with the prefix is not namespaced and still widens', () => {
  /**
   * `mcp__x` has no tool half, so `parseNamespaced` rejects it and it can never
   * have come from a connected server. A loose `startsWith('mcp__')` would let a
   * model disable the escape hatch for any tool by prefixing its name.
   */
  assert.equal(shouldWiden(['mcp__x'], ['read_file']), true);
  assert.equal(shouldWiden(['mcp__'], ['read_file']), true);
});

test('the existing contract is untouched: offered tools never widen, junk input never throws', () => {
  assert.equal(shouldWiden(['read_file'], ['read_file']), false);
  assert.equal(shouldWiden([], ['read_file']), false);
  assert.equal(shouldWiden(null, null), false);
  assert.equal(shouldWiden([undefined, '', null], ['read_file']), false);
});
