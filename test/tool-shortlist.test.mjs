import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_NAMES, toolNamesForRounds, toolSchemasFor } from '../lib/tools.mjs';
import { shortlistTools, shouldWiden, groupsForTask, CORE_TOOLS, TOOL_GROUPS } from '../lib/tool-shortlist.mjs';

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
 * ── ⚠️⚠️⭐ INVERTED 2026-08-25. THE OLD CONTRACT IS QUOTED, NOT DELETED ──────
 *
 * It read: *"⚠️ NO SIGNAL MEANS NO SHORTLIST. 'fix it' carries nothing to reason
 * from, and a shortlist built from no evidence is a guess with consequences."*
 * — and it asserted that `''`, `'   '`, `'fix it'` and `'go'` all received the
 * FULL surface.
 *
 * ⚠️ THAT IS THE RULE `ECONOMICS.md` PRICED, AND IT IS BACKWARDS. The recorded
 * run it decomposes had the task **"hi"**: 48 tool schemas, 53.3% of the whole
 * prompt, for a task that called no tool at all. Under the old rule the
 * shortlist could not fire on it — two characters is under the twelve-character
 * floor — so the one lever aimed at the largest line item was disabled on
 * exactly the cheapest tasks. Measured here: 49 of 49 tools, 50,075 bytes, zero
 * saved.
 *
 * ⭐ AND THE DOWNSIDE IS BOUNDED AT ONE ROUND, which the old rule never priced.
 * Reaching for an unoffered tool widens the offer to everything, permanently
 * (the test below this one). "No evidence" therefore argues for the offer that
 * needs no evidence — the CORE — not for the largest one available.
 *
 * ⚠️ `''` IS STILL DIFFERENT AND STILL GETS EVERYTHING, and that distinction is
 * the reason this is an inversion rather than a deletion. An empty task is not a
 * short brief, it is the ABSENCE of one — a continuing turn whose real
 * instruction is in the message history this function never sees. Guessing from
 * evidence that exists and was withheld from us is a different mistake from
 * guessing from evidence that does not exist.
 */
test('⚠️⚠️ a brief with no signal gets the CORE — and an ABSENT brief still gets everything', () => {
  for (const absent of ['', '   ']) {
    assert.deepEqual(new Set(shortlistTools(absent, AVAILABLE)), new Set(AVAILABLE),
      `"${absent}" is an absent brief, not an unsignalled one — it must not be trimmed`);
  }
  for (const vague of ['hi', 'fix it', 'go']) {
    const list = shortlistTools(vague, AVAILABLE);
    assert.ok(list.length < AVAILABLE.length, `"${vague}" was not trimmed at all — the 53.3% line item is untouched`);
    for (const t of ['read_file', 'edit_file', 'search_text', 'run_command']) {
      assert.ok(list.includes(t), `"${vague}" lost ${t}, which is core and must survive any brief`);
    }
    // and the escape hatch is what makes it safe
    assert.equal(shouldWiden(['generate_image'], list), true);
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

/**
 * ── ⭐⭐⭐ THE GUARD THAT WOULD HAVE CAUGHT ALL THREE LEAKS ───────────────────
 *
 * `shortlistTools` KEEPS anything it cannot classify — deliberately, because
 * *"dropping what you do not understand is how capability disappears quietly"*.
 * The cost of that correct rule is that an unclassified verb rides along on
 * "hi", on every request, of every task, for ever, and nothing said so out loud.
 * It has now been paid three times:
 *
 *     2026-08-2x  chart + syndicate                        2,852 B
 *     2026-08-29  find_symbol · apply_patch · pipe_to_asset 5,293 B
 *     2026-08-29  the five media identity verbs + playtest
 *                 + vercel_preview (latent — gated off on
 *                 the machine that measured it)            7,651 B
 *
 * ⚠️⚠️ AND THE THIRD IS WHY THIS SWEEPS `TOOL_NAMES` AND NOT THE OFFER. Seven of
 * those verbs need media configuration or a Vercel token, so a guard written
 * against `toolNamesForRounds(24, {})` on a developer laptop is GREEN while the
 * leak is live on every machine that has them — a check that cannot fail, which
 * is this repository's named worst failure mode.
 *
 * ⭐ THERE IS NO ESCAPE LIST ON PURPOSE. The correct response to a new verb is
 * to classify it in the commit that declares it; an exceptions array is where
 * that decision goes to rot. The failure message carries the byte price so the
 * choice is priced rather than argued.
 */
test('⭐⭐⭐ every verb is CORE or in a group — an unclassified one is billed on every task for ever', () => {
  const grouped = new Set();
  for (const [name, g] of Object.entries(TOOL_GROUPS)) {
    for (const t of g.tools) {
      assert.ok(!grouped.has(t), `${t} is in two groups — its offer would depend on which words matched`);
      assert.ok(!CORE_TOOLS.includes(t), `${t} is in CORE and in group "${name}" — one of the two is a lie about when it is offered`);
      grouped.add(t);
    }
  }

  const stray = TOOL_NAMES.filter((t) => !grouped.has(t) && !CORE_TOOLS.includes(t));
  if (stray.length) {
    const cost = stray.map((t) => `${t} ${JSON.stringify(toolSchemasFor([t])).length} B`).join(' · ');
    assert.fail(
      `${stray.length} verb(s) are in no TOOL_GROUP and not in CORE_TOOLS, so shortlistTools keeps them on `
      + `EVERY task including "hi": ${cost}. Put each one in the group whose words a user asking for it would `
      + `say — or in CORE_TOOLS if another always-offered tool's description names it, because this package `
      + `pins offered <=> named-in-prompt.`,
    );
  }
});

/**
 * ⚠️ AND THE OTHER DIRECTION, which is the failure a rename produces: a group
 * that lists a verb the registry does not have offers nothing and reads as
 * coverage. Silent, and it survives every test above.
 */
test('⚠️ no group and no core entry names a verb that does not exist', () => {
  const declared = [...CORE_TOOLS, ...Object.values(TOOL_GROUPS).flatMap((g) => g.tools)];
  const ghosts = [...new Set(declared.filter((t) => !TOOL_NAMES.includes(t)))];
  assert.deepEqual(ghosts, [], `these are classified and are not tools: ${ghosts.join(', ')}`);
});

/**
 * ⭐ THE VERB THE BENCH ASKED FOR 201 TIMES. `check_tools` must survive an
 * unsignalled brief: a model that is not offered it does not reach for it, so
 * there is no widen to rescue the miss — the wall is simply discovered a round
 * later, which is the round it exists to save.
 */
test('⭐ check_tools survives every brief, including one with no signal at all', () => {
  if (!AVAILABLE.includes('check_tools')) return; // withheld by --no-run upstream
  for (const brief of ['hi', 'fix it', 'run the tests', 'add a login page']) {
    assert.ok(shortlistTools(brief, AVAILABLE).includes('check_tools'),
      `"${brief}" lost check_tools — the refused-command round comes back`);
  }
});

/**
 * ⚠️ AND THE MEDIA VERBS MUST NOT. This is the assertion the old classification
 * was quietly contradicting: `pipe_to_asset` generates an image, and it was
 * being offered on a type-error task under a name the existing test did not
 * check for.
 */
test('⚠️ a type error is offered no image generator — under EITHER name', () => {
  const list = shortlistTools('fix the failing type error in src/auth.ts', AVAILABLE);
  for (const t of ['generate_image', 'pipe_to_asset', 'talking_head', 'generate_video', 'playtest', 'vercel_preview']) {
    assert.ok(!list.includes(t), `${t} was offered on a type-error task`);
  }
});
