import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_NAMES, toolNamesForRounds, toolSchemasFor } from '../lib/tools.mjs';
import { shortlistTools, shouldWiden, groupsForTask, CORE_TOOLS } from '../lib/tool-shortlist.mjs';

/**
 * ── ⭐⭐ THE POINT IS TOKENS THE CACHE CANNOT REFUND ─────────────────────────
 *
 * We measured a 100% steady-state prompt cache today, which makes the 14,213-token
 * tool block CHEAP. It does not make it FREE: a cached read is still billed at
 * roughly a tenth, and it still occupies context window — the one resource no
 * cache gives back.
 *
 * And `toolNamesForRounds` was measured to vary the offer by round budget ONLY:
 * 47 tools at every budget above one. "Fix this typo" and "refactor the auth
 * system" get an identical surface.
 *
 * ⚠️ THE DANGEROUS FAILURE IS WITHHOLDING, NOT OVER-OFFERING. This repo already
 * measured that tool search fails on PARAPHRASE rather than ranking, so any
 * keyword scheme will miss intents. Every test below is therefore about the
 * escape hatch as much as the saving.
 */

const AVAILABLE = toolNamesForRounds(24, {});

test('a focused brief offers materially fewer tools', () => {
  const list = shortlistTools('fix the failing type error in src/auth.ts', AVAILABLE);
  assert.ok(list.length < AVAILABLE.length, 'nothing was trimmed at all');
  // the spine survives
  for (const t of ['read_file', 'edit_file', 'search_text', 'run_command']) {
    assert.ok(list.includes(t), `${t} is core and must always be offered`);
  }
});

test('⭐ the brief pulls in the group it is actually about', () => {
  assert.ok(shortlistTools('commit this and open a pull request', AVAILABLE).includes('git_commit'));
  assert.ok(shortlistTools('start the dev server and check it responds', AVAILABLE).includes('start_process'));
  assert.ok(shortlistTools('generate a logo for the header', AVAILABLE).includes('generate_image'));
  /**
   * ⚠️ CONDITIONAL, AND MY FIRST VERSION WAS WRONG BECAUSE OF IT. `inspect_db`
   * is only offered when a schema file or DATABASE_URL exists, and it does not
   * here — so the shortlist correctly could not produce it and my assertion
   * was asking the code to violate its own first rule (a shortlist may only
   * ever SUBTRACT from what the environment allows). Asserted only when the
   * environment actually offers it.
   */
  if (AVAILABLE.includes('inspect_db')) {
    assert.ok(shortlistTools('inspect the database schema', AVAILABLE).includes('inspect_db'));
  }
});

test('and leaves out the groups it is plainly not about', () => {
  const list = shortlistTools('fix the failing type error in src/auth.ts', AVAILABLE);
  assert.ok(!list.includes('generate_image'), 'a type error needs no image generator');
  assert.ok(!list.includes('transcribe'));
});

/**
 * ⚠️⚠️ THE ESCAPE HATCH IS THE WHOLE SAFETY STORY. A shortlist you cannot get
 * out of is a capability ceiling. The moment the model reaches for something it
 * was not given, the next round gets EVERYTHING — so the worst case of a wrong
 * shortlist is one wasted round, never a task that cannot be finished.
 */
test('⚠️⚠️ reaching for an unoffered tool widens the offer to everything, permanently', () => {
  const narrow = shortlistTools('fix the failing type error in src/auth.ts', AVAILABLE);
  assert.equal(shouldWiden(['generate_image'], narrow), true, 'the miss must be detected');
  assert.equal(shouldWiden(['read_file'], narrow), false, 'an offered tool is not a miss');

  const widened = shortlistTools('fix the failing type error in src/auth.ts', AVAILABLE, { widened: true });
  assert.deepEqual(new Set(widened), new Set(AVAILABLE), 'widening must restore the FULL surface');
});

/**
 * ⚠️ A SHORTLIST MAY ONLY EVER SUBTRACT FROM WHAT THE ENVIRONMENT ALLOWS.
 * Withdrawal — no shell, no browser, no key — is decided upstream for safety
 * reasons. Re-offering a withdrawn tool would be worse than not shortlisting at
 * all: it burns a round on a refusal every time the model believes the promise.
 */
test('⚠️ never offers a tool the environment withheld', () => {
  const restricted = AVAILABLE.filter((t) => t !== 'run_command' && t !== 'git_commit');
  const list = shortlistTools('commit this and run the tests', restricted);
  assert.ok(!list.includes('run_command'));
  assert.ok(!list.includes('git_commit'));
  for (const t of list) assert.ok(restricted.includes(t), `${t} was never available`);
});

/**
 * ⚠️ NO SIGNAL MEANS NO SHORTLIST. "fix it" carries nothing to reason from, and
 * a shortlist built from no evidence is a guess with consequences.
 */
test('⚠️ a brief too short to carry signal gets the full surface', () => {
  for (const vague of ['', '   ', 'fix it', 'go']) {
    assert.deepEqual(new Set(shortlistTools(vague, AVAILABLE)), new Set(AVAILABLE), `"${vague}" must not be trimmed`);
  }
});

/**
 * ⚠️ AN UNCLASSIFIED TOOL IS ONE WE DO NOT UNDERSTAND, and dropping what you do
 * not understand is how capability disappears quietly. A tool added tomorrow and
 * put in no group must keep being offered.
 */
test('⚠️ a tool in no group is kept, not silently dropped', () => {
  const withNew = [...AVAILABLE, 'brand_new_verb'];
  assert.ok(shortlistTools('fix the failing type error in src/auth.ts', withNew).includes('brand_new_verb'));
});

test('groupsForTask is honest about an unsignalled brief', () => {
  assert.ok(groupsForTask('').length > 0, 'no words means every group is possible');
  assert.deepEqual(groupsForTask('commit this to git'), ['vcs']);
});

/**
 * ⭐ THE MEASUREMENT, because "fewer tools" is worthless without a number. This
 * prints the real token saving on the real schemas so the trade is visible
 * rather than assumed.
 */
test('⭐ the saving is measured, not asserted', () => {
  const size = (names) => JSON.stringify(toolSchemasFor(names)).length;
  const full = size(AVAILABLE);
  const cases = [
    ['fix the failing type error in src/auth.ts', 'a typo-class task'],
    ['commit this and open a pull request', 'a version-control task'],
    ['start the dev server and check the api responds', 'a runtime task'],
  ];
  let anySaving = false;
  for (const [brief, label] of cases) {
    const short = size(shortlistTools(brief, AVAILABLE));
    const pct = ((1 - short / full) * 100).toFixed(1);
    console.log(`   ${label.padEnd(24)} ${full} → ${short} chars  (−${pct}%, ~${Math.round((full - short) / 4)} tokens/round)`);
    if (short < full) anySaving = true;
  }
  assert.ok(anySaving, 'shortlisting saved nothing on any brief — it is not earning its complexity');
  assert.ok(CORE_TOOLS.length < TOOL_NAMES.length, 'the core cannot be everything or there is no saving to make');
});
