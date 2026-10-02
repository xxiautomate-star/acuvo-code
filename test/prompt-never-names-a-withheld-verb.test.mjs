import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt } from '../lib/turn.mjs';
import { shortlistTools } from '../lib/tool-shortlist.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';

/**
 * ── ⚠️⚠️ `offered ⟺ named-in-prompt`, CHECKED IN THE RARE DIRECTION ────────
 *
 * The usual failure is a verb OFFERED and never named — it wastes its schema
 * and the model never reaches for it. This file checks the opposite and worse
 * case: a verb NAMED in the prompt that the shortlist withheld.
 *
 * Found 2026-08-29: the batching advice said "git_status AND git_diff together"
 * on every multi-round run, while the shortlist offers neither on a brief with
 * no vcs signal. The model was told to plan with tools it did not have.
 */

/**
 * Every bare verb name the prompt mentions.
 *
 * ⚠️⚠️ NO REGEX, AND THAT IS THE WHOLE POINT. The first version of this used
 * `new RegExp(`\b${name}\b`)` — a SINGLE backslash inside a template literal,
 * which JavaScript reads as the BACKSPACE character (U+0008), not a word
 * boundary. The pattern was `<BS>git_status<BS>`, it could never match, and the
 * guard passed against a prompt that plainly contained the verb. Proven by
 * mutation: the defect was restored and this file still went green.
 *
 * ⭐ Tokenising has no escape hazard to get wrong, so the guard cannot rot back
 * into the same hole. Same class as the CRLF anchor that matched at -1 — see
 * `feedback_a_guard_can_pass_while_checking_nothing`.
 */
function verbsNamedIn(prompt, universe) {
  const words = new Set(String(prompt).split(/[^A-Za-z0-9_]+/));
  return universe.filter((name) => words.has(name));
}

const NEUTRAL_BRIEFS = ['hi', 'fix the typo in the README heading', 'explain what this project does'];

for (const brief of NEUTRAL_BRIEFS) {
  test(`⚠️ the prompt names no verb the shortlist withheld — "${brief}"`, () => {
    const offeredNames = shortlistTools(brief, TOOL_NAMES) ?? [];
    assert.ok(offeredNames.length > 0, 'the shortlist returned nothing — this test would pass vacuously');

    const prompt = systemPrompt({ maxRounds: 8, allowRun: true, offeredNames });

    // Only judge verbs that CAN be withheld: anything the shortlist knows about.
    const named = verbsNamedIn(prompt, offeredNames.length ? ['git_status', 'git_diff', 'see_page', 'generate_image', 'make_document'] : []);
    const phantom = named.filter((n) => !offeredNames.includes(n));

    assert.deepEqual(
      phantom,
      [],
      `the prompt names ${phantom.join(', ')} but the shortlist did not offer ${phantom.length > 1 ? 'them' : 'it'} for this brief`,
    );
  });
}

test('⭐ and it DOES name them when they are offered — the advice is not simply deleted', () => {
  const prompt = systemPrompt({
    maxRounds: 8,
    allowRun: true,
    offeredNames: ['git_status', 'git_diff', 'read_file', 'search_text', 'find_files'],
  });
  assert.match(prompt, /git_status AND git_diff/, 'the batching example must survive when both verbs are present');
});
