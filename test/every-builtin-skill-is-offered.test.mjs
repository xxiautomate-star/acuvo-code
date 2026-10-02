/**
 * ── ⭐⭐⭐ A SKILL ON THE SHELF THAT IS NOT IN THE CATALOGUE DOES NOT EXIST ───
 *
 * There are THREE limits between a file in `skills/` and a model that can use
 * it, and they are not the same number:
 *
 *   MAX_BUILTIN_SKILLS   how many are discovered
 *   MAX_CATALOGUE_CHARS  how many fit the prompt block
 *   MAX_SKILL_BYTES      how much of one body is pasted on demand
 *
 * ⚠️ THE MIDDLE ONE SILENTLY DECIDED WHICH SKILLS EXIST, AND IT CUT FROM THE
 * ALPHABETICAL TAIL. Measured the day seven vendored skills landed: 36
 * discovered, `capped: 0`, and only 29 in the catalogue. `typography`,
 * `verify-your-own-work`, `web-app-quality` and `working-in-the-background` had
 * been offered for weeks and stopped being offered — not because anything about
 * them changed, but because new files sorted ahead of them.
 *
 * ⭐ A COUNT OF ZERO CAPPED IS NOT PROOF THE SHELF IS REACHABLE. That field
 * reports the COUNT cap only. This file asserts the thing that actually matters:
 * every skill we ship is named in the block the model reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { skillsPromptBlock, MAX_CATALOGUE_CHARS, MAX_BUILTIN_SKILLS } from '../lib/skills.mjs';
import { discoverAllSkills, builtinSkillsRoot } from '../lib/builtin-skills.mjs';

const shelf = () => readdirSync(join(builtinSkillsRoot(), 'skills'))
  .filter((f) => f.endsWith('.md'))
  // `applies-to: builder` skills are the builder's alone — never in the CLI's catalogue.
  .filter((f) => !/^applies-to:\s*builder\s*$/m.test(readFileSync(join(builtinSkillsRoot(), 'skills', f), 'utf8').slice(0, 2000)))
  .map((f) => f.replace(/\.md$/, ''));

test('⭐⭐ EVERY skill we ship is named in the catalogue the model reads', () => {
  const discovered = discoverAllSkills(process.cwd());
  const block = String(skillsPromptBlock(discovered) ?? '');

  const missing = shelf().filter((name) => !block.includes(name));
  assert.deepEqual(
    missing,
    [],
    `on the shelf but not offered: ${missing.join(', ')} — a skill the model is never told about cannot be read`,
  );
});

test('⚠️ the shelf fits under the count cap, with the real margin stated', () => {
  const names = shelf();
  assert.ok(
    names.length <= MAX_BUILTIN_SKILLS,
    `${names.length} skills on a shelf capped at ${MAX_BUILTIN_SKILLS} — raise MAX_BUILTIN_SKILLS or the tail is dropped`,
  );
});

test('⚠️⚠️ the char backstop must not bite before the count cap does', () => {
  /**
   * The design intent, stated in skills.mjs: `MAX_CATALOGUE_CHARS` is a
   * BACKSTOP, and the count is the limit that bites. That property broke once
   * already — the backstop was derived from MAX_SKILLS(20) while the shipped
   * shelf is bounded by MAX_BUILTIN_SKILLS. Derived from the wrong bound, it
   * quietly became the real limit.
   *
   * 289 = 2 + name(48) + 3 + description(120) + ' · use it when: '(16) + when(100)
   */
  const WORST_CASE_ENTRY = 289;
  assert.ok(
    MAX_CATALOGUE_CHARS >= WORST_CASE_ENTRY * MAX_BUILTIN_SKILLS,
    `MAX_CATALOGUE_CHARS (${MAX_CATALOGUE_CHARS}) is below ${WORST_CASE_ENTRY} × ${MAX_BUILTIN_SKILLS}`
      + ' — a full shelf of maximum-length entries would be truncated, and the cut falls on'
      + ' whichever skills sort last rather than on whichever matter least',
  );
});

test('⭐ the vendored engineering skills are on the shelf and offered', () => {
  const block = String(skillsPromptBlock(discoverAllSkills(process.cwd())) ?? '');
  // The bench is largely "make the tests pass", so this one earning its place is
  // the whole reason the shelf grew.
  for (const name of ['test-driven-development', 'incremental-implementation', 'context-engineering']) {
    assert.ok(block.includes(name), `${name} is not offered to the model`);
  }
});
