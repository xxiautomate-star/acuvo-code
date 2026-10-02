/**
 * ── ⭐⭐⭐ THE SHELF'S TOKEN BILL, AND THE THREE CAPS BETWEEN A FILE AND A MODEL ─
 *
 * Every other skills test asks "does it work". This one asks **"what does it
 * cost, and how close is it to breaking"** — because the two ways this shelf
 * fails are both quiet:
 *
 *   1. A cap sits exactly at the shelf size and the NEXT file is dropped from
 *      the alphabetical tail. That has now happened at 20, at 32 and at 40 (see
 *      the constants in `lib/skills.mjs`). `capped: 0` is not proof of health —
 *      it is proof about ONE of the three caps.
 *   2. A skill is edited, the edit changes which skill wins a brief, and the
 *      accuracy guard's floor is slack enough to absorb it. That happened in
 *      this very working tree — see the negation case below.
 *
 * ⚠️ THE CATALOGUE IS THE PART PAID CONSTANTLY. Bodies cost only when
 * `read_skill` opens one; the catalogue rides the SYSTEM message on every single
 * run. So the two budgets are asserted separately and for different reasons.
 *
 * ⚠️ IT COSTS $0.00. Every number here is computed from files on disk and
 * strings assembled locally. No model call, no network, no agent run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildSkillIndex,
  discoverSkills,
  parseFrontmatter,
  rankSkillsForTask,
  skillsHintForTask,
  skillsPromptBlock,
  MAX_BUILTIN_SKILLS,
  MAX_CATALOGUE_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  MAX_SKILL_BYTES,
  MAX_WHEN_CHARS,
} from '../lib/skills.mjs';
import { builtinSkillsRoot, discoverAllSkills } from '../lib/builtin-skills.mjs';

/**
 * ⚠️ THE SAME LABELLED BRIEFS AS `skills-shortlist.test.mjs`, DUPLICATED ON
 * PURPOSE. That file measures RANK; this one measures what is actually EMITTED.
 * Importing a fixture across test files couples two suites that fail for
 * different reasons, and a shared table quietly edited to fix one of them
 * silently changes the other's meaning. Twenty-four short strings is a cheap
 * price for two independent measurements.
 */
const LABELLED = [
  ['build me a snake game in the browser with a score and game over screen', 'game-prototype'],
  ['make a playable arcade demo on a canvas', 'game-prototype'],
  ['scaffold a React app with Tailwind and run npm install', 'build-with-a-framework'],
  ['add a page under app/ in our Next.js project with a server component', 'nextjs-app-router'],
  ['the test fails and I have no idea why, the error says undefined', 'debugging'],
  ['add types to this module, it is full of any', 'typescript-strict'],
  ['two components disagree about the selected row, fix the state', 'state-management'],
  ['trim this mp4 and add a caption overlay with ffmpeg', 'video-production'],
  ['write tests first for the parser', 'test-driven-development'],
  ['the contrast on these buttons is unreadable for colour blind users', 'colour-and-contrast'],
  ['this login form needs validation and error messages', 'forms-and-validation'],
  ['review this file for security problems', 'security-review'],
  ['the page is slow, first paint takes 4 seconds', 'performance'],
  ['design a REST endpoint for creating invoices', 'api-design'],
  ['screen reader users cannot reach the modal', 'accessibility'],
  ['the layout breaks on mobile, the grid overflows', 'css-layout'],
  ['add row level security for a multi tenant supabase table', 'supabase-multitenant'],
  ['start the dev server and watch it while I keep working', 'working-in-the-background'],
  ['plan this out before we touch any code', 'plan-before-building'],
  ['refactor this 600 line function', 'refactoring'],
  ['add logging and metrics so we can see what production is doing', 'observability-and-instrumentation'],
  ['animate the card as it enters the viewport', 'animation'],
  ['commit this and tag a release', 'git-workflow-and-versioning'],
  ['draw a chart of monthly revenue', 'data-and-charts'],
];

const SHELF_DIR = join(builtinSkillsRoot(), 'skills');
const shelfFiles = () => readdirSync(SHELF_DIR).filter((f) => f.endsWith('.md')).sort();
/** The files the CLI OFFERS: `applies-to: builder` skills are the builder's alone (the one skill format, 2026-09-30). */
const cliShelfFiles = () => shelfFiles().filter((f) => !/^applies-to:\s*builder\s*$/m.test(readFileSync(join(SHELF_DIR, f), 'utf8').slice(0, 2000)));

/** Bodies as `loadSkill` would deliver them: frontmatter stripped, UTF-8 bytes. */
function bodies() {
  return shelfFiles().map((f) => {
    const parsed = parseFrontmatter(readFileSync(join(SHELF_DIR, f), 'utf8'));
    return {
      name: f.replace(/\.md$/, ''),
      bytes: Buffer.byteLength(parsed.body, 'utf8'),
      meta: parsed.meta,
    };
  });
}

/**
 * ── ⚠️⚠️ CAP #1: THE COUNT. IT MUST NEVER EQUAL THE SHELF SIZE. ─────────────
 *
 * `every-builtin-skill-is-offered.test.mjs` asserts `shelf <= cap`, which is the
 * correct invariant and goes red the moment a skill is actually lost. This
 * asserts the EARLIER thing: that there is room for the next one. Equality is
 * the state this repo has shipped three times, and each time the symptom was a
 * capability that existed, was catalogued, and could not be reached.
 */
test('⚠️⚠️ the count cap has room for the NEXT skill, not just for today\'s shelf', () => {
  const n = shelfFiles().length;
  assert.ok(
    n < MAX_BUILTIN_SKILLS,
    `${n} skills against MAX_BUILTIN_SKILLS=${MAX_BUILTIN_SKILLS}. A cap equal to the shelf means the`
    + ' next file written is discovered, counted, and dropped from the ALPHABETICAL TAIL — by letter,'
    + ' not by merit. Raise the cap in the same commit as the skill, with the catalogue measurement.',
  );
});


/**
 * ⚠⚠ EVERY MEASUREMENT IN THIS FILE NAMES A HOME, AND NONE OF THEM HAD TO
 * BEFORE 2026-09-19. There is now a THIRD skills shelf — `~/.acuvo/skills`,
 * where a person keeps their own — and this file counts catalogue entries and
 * characters against the BUNDLED shelf. Left unpinned, every assertion here
 * measures the LAPTOP rather than the shelf, and goes red on any machine whose
 * owner has written one skill of their own. Caught the day the shelf landed, by
 * exactly that: one file in the real home, `68 catalogue entries for 67 files`.
 *
 * ⭐ An `ACUVO_HOME` pointed at a directory that does not exist is the cheapest
 * honest way to say "the bundled shelf plus this project, and nothing else".
 */
const NO_USER_SHELF = { ACUVO_HOME: join(tmpdir(), `acuvo-no-user-shelf-${process.pid}`) };
const bundledAndProject = () => discoverAllSkills(process.cwd(), { env: NO_USER_SHELF });

/**
 * ── ⭐ CAP #2: THE CATALOGUE. THE ONLY BUDGET PAID ON EVERY RUN. ────────────
 *
 * This asserts the real block against the real cap AND prints the measurement,
 * so the number in `skills.mjs`'s header is never a claim nobody re-checked.
 */
test('⭐⭐ the catalogue fits, nothing is truncated, and the per-run cost is stated', () => {
  const discovered = bundledAndProject();
  const block = String(skillsPromptBlock(discovered) ?? '');
  const entries = block.split('\n').filter((l) => l.startsWith('- '));

  assert.equal(entries.length, cliShelfFiles().length,
    `${entries.length} catalogue entries for ${cliShelfFiles().length} CLI files on the shelf`);

  assert.ok(
    !block.includes('are not listed'),
    'the catalogue printed its truncation notice — some skill on the shelf is not being offered.'
    + ' The cut falls on whichever names sort last, not on whichever matter least.',
  );

  assert.ok(
    block.length < MAX_CATALOGUE_CHARS,
    `catalogue is ${block.length} chars against MAX_CATALOGUE_CHARS=${MAX_CATALOGUE_CHARS}`,
  );

  /**
   * ⭐ THE HEADROOM, EXPRESSED IN SKILLS RATHER THAN IN CHARACTERS, because
   * "8,976 chars spare" tells a reader nothing and "39 more skills would fit"
   * tells them everything. Measured against the WIDEST entry actually on the
   * shelf, not the average — an average is what mis-sized this constant twice.
   */
  const widest = entries.reduce((m, l) => Math.max(m, l.length + 1), 1);
  const roomFor = Math.floor((MAX_CATALOGUE_CHARS - block.length) / widest);
  console.log(
    `    [catalogue] ${entries.length} skills · ${block.length} chars ≈ ${Math.round(block.length / 4)} tokens`
    + ` · widest entry ${widest - 1} · ${(block.length / MAX_CATALOGUE_CHARS * 100).toFixed(0)}% of cap`
    + ` · room for ~${roomFor} more at the widest entry size`,
  );
  assert.ok(roomFor >= 1, 'the char backstop is within one entry of biting');
});

/**
 * ── ⚠️⚠️ CAP #3: THE BODY. THE ONE THE HEADER CALLS LOAD-BEARING. ──────────
 *
 * This one is NOT to be raised to make room — a body is pasted whole into the
 * task's own context window, so the cap is protecting the work, not the bill.
 * It is asserted here because it is the cap nearest to biting: the largest body
 * on the shelf sits within a few hundred bytes of it, and going over does not
 * fail — it TRUNCATES, announced, mid-runbook. Step 9 is simply never delivered.
 */
test('⚠️⚠️ no skill body is over MAX_SKILL_BYTES, and the tightest headroom is named', () => {
  const rows = bodies().sort((a, b) => b.bytes - a.bytes);
  const over = rows.filter((r) => r.bytes > MAX_SKILL_BYTES);
  assert.deepEqual(
    over.map((r) => `${r.name} (${r.bytes}B)`),
    [],
    'these bodies are truncated when read_skill opens them — the tail of the runbook is silently absent'
    + ` from the model's view even though the file on disk is complete. MAX_SKILL_BYTES=${MAX_SKILL_BYTES}.`
    + ' SPLIT the skill; do not raise the cap — it bounds a paste into the task\'s own context window.',
  );

  const tight = rows.filter((r) => r.bytes > MAX_SKILL_BYTES * 0.85);
  console.log(
    `    [bodies] ${rows.length} skills · total ${rows.reduce((s, r) => s + r.bytes, 0)}B`
    + ` · largest ${rows[0].name} ${rows[0].bytes}B (${MAX_SKILL_BYTES - rows[0].bytes}B headroom,`
    + ` ~${Math.round(rows[0].bytes / 4)} tokens per open)`
    + (tight.length ? ` · WITHIN 15% OF THE CAP: ${tight.map((r) => `${r.name}(${MAX_SKILL_BYTES - r.bytes}B left)`).join(', ')}` : ''),
  );
});

/**
 * ── ⭐ THE MATCHER READS THE RAW FILE, THE PROMPT READS THE TRUNCATED FIELD ──
 *
 * `discoverSkills` keeps an UNTRUNCATED `matchText` on purpose so the ranker
 * sees the whole `when:` while the prompt pays for only 100 chars of it. That
 * design means **shortening a `when:` line in the file deletes ranking signal
 * that cost nothing**, which is the opposite of what the editor intends.
 *
 * So this does not demand short fields. It records, at every run, how much
 * trigger text is being carried for free — and it fails only if a field is so
 * long it stops being a one-line trigger at all.
 */
test('⭐ frontmatter is within the widths the catalogue and the matcher assume', () => {
  const rows = bodies();
  const noFm = rows.filter((r) => !r.meta.name && !r.meta.description && !r.meta.when);
  assert.deepEqual(noFm.map((r) => r.name), [],
    'no frontmatter — the catalogue falls back to the first line of prose, which is rarely a trigger sentence');

  const absurd = rows.filter((r) => (r.meta.when ?? '').length > MAX_WHEN_CHARS * 4
    || (r.meta.description ?? '').length > MAX_DESCRIPTION_CHARS * 4
    || (r.meta.name ?? '').length > MAX_NAME_CHARS);
  assert.deepEqual(absurd.map((r) => r.name), [],
    'a frontmatter field this long is a paragraph, not a trigger line — the catalogue shows a fragment of it');

  const cutWhen = rows.filter((r) => (r.meta.when ?? '').length > MAX_WHEN_CHARS);
  const cutDesc = rows.filter((r) => (r.meta.description ?? '').length > MAX_DESCRIPTION_CHARS);
  console.log(
    `    [frontmatter] when: ${cutWhen.length}/${rows.length} exceed ${MAX_WHEN_CHARS} chars (shown cut, matched WHOLE)`
    + ` · description: ${cutDesc.length}/${rows.length} exceed ${MAX_DESCRIPTION_CHARS}`,
  );
});

/**
 * ── ⚠️⚠️⚠️ THE REGRESSION THAT A SLACK FLOOR ABSORBED ───────────────────────
 *
 * MEASURED IN THIS WORKING TREE, 2026-08-26. A lane reworded fourteen `when:`
 * lines to fit `MAX_WHEN_CHARS`. Nobody touched the ranker. The result:
 *
 *     shelf                                    top-1     pointers   noise
 *     committed HEAD (40 skills)               24/24      23/24      2/10
 *     HEAD + the new game-engines (41 skills)  24/24      23/24      2/10   ← growth costs NOTHING
 *     working tree, reworded when: (41)        23/24      22/24      3/10   ← the rewording did
 *
 * ⭐ SO THE SHELF GROWING IS NOT WHAT DEGRADES THE SHORTLIST. Adding a skill
 * changed nothing measurable. EDITING one changed a labelled answer. That is the
 * opposite of the intuition ("more skills, more competition") and it is why this
 * test pins BRIEFS BY NAME rather than an aggregate score: the aggregate guard's
 * floor was `>= 23 of 24`, the regression landed on exactly 23, and it passed.
 *
 * ⚠️ THE MECHANISM, for whoever edits a `when:` next. Two independent effects,
 * both invisible from the file you are editing:
 *
 *   1. A word you add is scored by RARITY. On a 41-skill shelf a word in exactly
 *      one skill earns normalised IDF **1.000 — the maximum a token can earn**.
 *      "cannot" was added to one `when:` and instantly scored as decisively as
 *      "modal" does, handing an accessibility brief to an observability skill.
 *   2. A `when:` you SHORTEN raises that skill's score on EVERY brief, because
 *      `lengthPenalty` divides by bag size relative to the shelf average.
 *      Measured: `ship-it` went from 24 tokens to 18 against an average of 17.9,
 *      and started placing top-3 on briefs about modals and messy functions.
 */
test('⭐⭐⭐ a negation cannot outrank a topic — the exact case a `when:` rewrite broke', () => {
  const discovered = bundledAndProject();
  const brief = 'screen reader users cannot reach the modal';
  const ranked = rankSkillsForTask(brief, discovered.skills, { limit: 5 });
  const shown = ranked.map((r) => `${r.name}(${r.score.toFixed(2)}, ${r.hits}/${r.of} tokens)`).join(', ');

  /**
   * ⚠️ THE ASSERTION IS ABOUT THE WORD, NOT ABOUT WHO WINS. Which UI skill takes
   * rank 1 here moves as the shelf changes underneath — five lanes edit these
   * files. What must never move is that an OBSERVABILITY skill answers a
   * SCREEN-READER brief, and the only reason it ever did was the word "cannot".
   */
  assert.notEqual(
    ranked[0]?.name,
    'observability-and-instrumentation',
    `got ${shown}. A word describing the SHAPE of a complaint ("cannot", "doesn't", "won't") must never`
    + ' identify its SUBJECT. If this is red after a skill edit, the new `when:` introduced a function'
    + ' word that is rare on the shelf — see MATCH_STOPWORDS in lib/skills.mjs.',
  );

  /**
   * ⭐ AND THE SHIPPED BEHAVIOUR, WHICH IS THE POINTER RATHER THAN THE RANK. The
   * thin-evidence gate means a one-word coincidence on a five-word brief says
   * nothing at all, so whatever the ranking does, the model is not sent a
   * confident wrong name.
   */
  const hint = skillsHintForTask(brief, discovered);
  if (hint) {
    assert.ok(
      /accessibility|css-layout|colour-and-contrast|page-composition|ui-components|web-app-quality|check-the-site/.test(hint),
      `the pointer for a screen-reader brief named a non-UI skill:\n${hint}`,
    );
  }
});

/**
 * ── ⭐⭐⭐ THE ONE THAT MATTERS MOST: NEVER BE CONFIDENTLY WRONG ─────────────
 *
 * Silence is free — the full catalogue is one line above the pointer in the same
 * prompt. A pointer naming the WRONG skill is not free: the model opens it, and
 * bodies on this shelf run to ~3,800 tokens.
 *
 * ⚠️ SO THIS DOES NOT MEASURE ACCURACY. `skills-shortlist.test.mjs` already
 * pins top-1 rank. This pins the thing rank cannot see: of the pointers actually
 * EMITTED, how many lead with the wrong skill. Measured on the live shelf the day
 * the thin-evidence gate landed: **22 emitted, 0 wrong-first, 2 silent.** Before
 * the gate it was 23 emitted and 1 wrong-first — `ship-it` answering *"screen
 * reader users cannot reach the modal"* on the single word "reach".
 */
test('⭐⭐⭐ every pointer we DO emit leads with the right skill — 0 confidently wrong', () => {
  const discovered = bundledAndProject();
  const wrong = [];
  let emitted = 0;
  for (const [brief, expected] of LABELLED) {
    const hint = skillsHintForTask(brief, discovered);
    if (!hint) continue;
    emitted += 1;
    const first = String(hint.split('— ')[1] ?? '').split('.')[0].split(', ')[0].trim();
    if (first !== expected) wrong.push(`"${brief}" → ${first} (wanted ${expected})`);
  }
  assert.ok(emitted >= LABELLED.length * 0.7,
    `only ${emitted}/${LABELLED.length} pointers emitted — the guards have gone from cautious to mute`);
  assert.deepEqual(wrong, [],
    'a pointer named the wrong skill FIRST. That is the one failure here that costs a round: the model'
    + ' opens a body it does not need. Prefer silence — see HINT_MIN_QUERY_FOR_SINGLE_TOKEN.');
  console.log(`    [pointers] ${emitted}/${LABELLED.length} emitted · 0 wrong-first · ${LABELLED.length - emitted} silent`);
});

/**
 * The general property behind that case, on a fixture rather than the shelf, so
 * it keeps meaning the same thing when the shelf changes underneath it.
 */
test('⭐ function words carry ZERO ranking weight, however rare they are', () => {
  const fixture = [
    { name: 'alpha', description: 'the data cannot say why it broke', when: null, file: 'a.md', bytes: 1 },
    { name: 'beta', description: 'unrelated prose about widgets', when: null, file: 'b.md', bytes: 1 },
  ];
  const index = buildSkillIndex(fixture);
  for (const word of ['cannot', 'doesn', 'say', 'have', 'they', 'wouldn']) {
    assert.deepEqual(
      rankSkillsForTask(word, index, { limit: 3 }),
      [],
      `"${word}" scored a skill. It appears in exactly one document, so it earns the MAXIMUM idf —`
      + ' a brief containing it would be answered by whichever skill happens to use it in passing.',
    );
  }
  // …and a real topic word in the same position still ranks, so the stop list did not eat signal.
  assert.equal(rankSkillsForTask('widgets', index, { limit: 3 })[0]?.name, 'beta');
});

/**
 * ⚠️ SILENCE IS A FEATURE AND IT HAS TO BE TESTED, because the failure it
 * prevents is expensive: a confident pointer at the wrong skill makes the model
 * spend a `read_skill` round on a body that can be ~3,500 tokens.
 */
test('⚠️ a brief with no topic gets NO pointer — a wrong one costs a whole body read', () => {
  const discovered = bundledAndProject();
  for (const brief of ['say hello', 'thanks, that is all', 'hello there']) {
    assert.equal(
      skillsHintForTask(brief, discovered),
      null,
      `"${brief}" produced a skill pointer. Nothing on this shelf is about greetings; the pointer is`
      + ' pointing at whichever skill used a conversational verb in its description.',
    );
  }
});

/**
 * ── ⭐ REACH: THE CONSTANTS AND THE RANKER ARE NOT DEAD CODE ────────────────
 *
 * This package's standing defect is a capability that is built, catalogued and
 * imported by nothing. `dark-modules` catches an unimported FILE; this catches
 * the finer version — an export inside a live file that no shipped path calls.
 */
test('⭐ the ranker and the catalogue are reached from the shipped prompt path', async () => {
  const turn = readFileSync(join(builtinSkillsRoot(), 'lib', 'turn.mjs'), 'utf8');
  for (const symbol of ['skillsHintForTask', 'skillsPromptBlock', 'discoverAllSkills']) {
    assert.ok(turn.includes(symbol), `${symbol} is not referenced by turn.mjs — the shortlist reaches no model`);
  }
  // And the project-shelf path still works with zero builtin skills in play.
  const project = discoverSkills(process.cwd());
  assert.equal(typeof project.ok, 'boolean');
});
