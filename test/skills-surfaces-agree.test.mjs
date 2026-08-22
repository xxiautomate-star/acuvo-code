/**
 * ── ⚠️⚠️ THE MODEL AND THE HUMAN MUST SEE THE SAME SHELF ────────────────────
 *
 * Measured 2026-08-20, on a CLI that ships 24 skills:
 *
 *     what /skills showed          0
 *     what the model saw          24
 *     /skills nextjs-app-router   "this project defines no skills … there is
 *                                  nothing to read until someone writes one"
 *
 * ⭐ THE WRONG ANSWER WAS THE ONE A HUMAN READS. `lib/tools.mjs` and
 * `lib/turn.mjs` both called `discoverAllSkills`, so the model had the bundle;
 * only `bin/acuvo.mjs`'s slash providers still called the project-only
 * `discoverSkills`/`loadSkill`. A user typing `/skills` was told, in a full
 * sentence, that the feature they had just bought did not exist.
 *
 * ⚠️ AND IT SAT DIRECTLY UNDER A COMMENT WARNING ABOUT THIS EXACT DEFECT —
 * *"without these providers … the surface would be built-but-unreachable — the
 * defect this repo has shipped four times in one day, inside the commits fixing
 * it."* The warning was right and the line below it was wrong. That is why this
 * is a test and not a code comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { discoverSkills } from '../lib/skills.mjs';
import { discoverAllSkills, loadAnySkill } from '../lib/builtin-skills.mjs';
import { parseSlash, runSlashCommand } from '../lib/slash.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The providers `bin/acuvo.mjs` installs, reproduced exactly. */
function slashContext(root) {
  return {
    skills: () => (discoverAllSkills(root)?.skills ?? []).map((s) => ({ name: s.name, description: s.description })),
    loadSkill: (name) => loadAnySkill(root, name),
  };
}
const run = (line, root = PKG) => runSlashCommand(parseSlash(line), slashContext(root));

test('⭐⭐ the shelf is not empty — otherwise every assertion below passes vacuously', () => {
  const all = discoverAllSkills(PKG)?.skills ?? [];
  assert.ok(all.length >= 20, `only ${all.length} bundled skills; this test is measuring a stub`);
});

test('⭐⭐ /skills shows every skill the MODEL can read', () => {
  const model = new Set((discoverAllSkills(PKG)?.skills ?? []).map((s) => s.name));
  const human = new Set((run('/skills').output ?? []).join('\n').match(/^\s{4}(\S+)/gm)?.map((l) => l.trim()) ?? []);
  const hidden = [...model].filter((n) => !human.has(n));
  assert.deepEqual(
    hidden, [],
    `the model can read these and /skills does not list them: ${hidden.join(', ')}`,
  );
});

test('⚠️⚠️ a bundled skill LOADS from the slash command, not just from the tool', () => {
  const name = (discoverAllSkills(PKG)?.skills ?? [])[0]?.name;
  assert.ok(name, 'no bundled skill to test with');
  const out = (run(`/skills ${name}`).output ?? []).join(' ');
  assert.match(out, /Loaded skill/, `"/skills ${name}" did not load it: ${out}`);
  /**
   * ⚠️ THE EXACT SENTENCE THE BUG PRODUCED. Asserting on the failure text pins
   * the regression rather than the mechanism — whatever the cause next time,
   * this is the lie a user would be told.
   */
  assert.doesNotMatch(out, /defines no skills/, 'the CLI told a user it ships no skills while shipping 24');
});

test('⚠️ /skills attaches to the NEXT turn — a load that injects nothing is decoration', () => {
  const name = (discoverAllSkills(PKG)?.skills ?? [])[0]?.name;
  assert.ok(run(`/skills ${name}`).inject, 'the skill loaded and was never attached to anything');
});

/**
 * ⚠️ THE STATIC HALF. The two behavioural tests above use the providers this
 * file DEFINES, so they would keep passing if `bin/acuvo.mjs` went back to the
 * project-only pair. This reads the binary.
 */
test('⚠️⚠️ bin/acuvo.mjs installs the full-shelf providers, not the project-only ones', () => {
  const src = readFileSync(join(PKG, 'bin', 'acuvo.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const ctx = src.slice(src.indexOf('slashContext: {'), src.indexOf('slashContext: {') + 600);
  assert.match(ctx, /skills:\s*\(\)\s*=>\s*\(discoverAllSkills\(/, '/skills is wired to the project-only catalogue');
  assert.match(ctx, /loadSkill:\s*\(name\)\s*=>\s*loadAnySkill\(/, '/skills <name> is wired to the project-only loader');
});

test('⭐ the two discoveries really are different — the fix is not a rename', () => {
  /**
   * If `discoverSkills` and `discoverAllSkills` returned the same thing, none
   * of this would matter and the test above would be theatre. On this package
   * they differ by the entire bundle.
   */
  const project = (discoverSkills(PKG)?.skills ?? []).length;
  const all = (discoverAllSkills(PKG)?.skills ?? []).length;
  assert.ok(all > project, `discoverAllSkills (${all}) must exceed project-only (${project})`);
});

test('⚠️ the listing does not send a user to a directory the skills are not in', () => {
  const header = (run('/skills').output ?? [])[0] ?? '';
  assert.doesNotMatch(
    header, /skills? in \.acuvo\/skills/,
    'the header names .acuvo/skills, but most of these ship inside the package — '
    + 'a curious user goes looking in an empty folder',
  );
  assert.match(header, /\d+ skills? available/);
});

/**
 * ── ⚠️ `/model` MUST BE FED THE ROUTE, NOT JUST THE NAME ────────────────────
 *
 * `routingNote` is pure and tested in `warm-provider.test.mjs`. That proves the
 * WORDING and nothing about whether anyone calls it — the exact gap that let
 * `/skills` sit wrong under a comment warning about it. This reads the binary.
 */
test('⚠️⚠️ bin/acuvo.mjs feeds /model the provider that actually served', () => {
  const src = readFileSync(join(PKG, 'bin', 'acuvo.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  assert.match(src, /import \{ routingNote \}/, 'routingNote is not imported by the binary');
  const at = src.indexOf('model: () => ({');
  assert.ok(at > 0, 'the /model provider is gone');
  const block = src.slice(at, at + 300);
  assert.match(block, /note:\s*routingNote\(/, '/model still reports only the configured name');

  /**
   * ⚠️ AND SOMETHING MUST ACTUALLY FILL IT. `routingNote(lastProviders)` where
   * `lastProviders` is never assigned would pass the check above and always
   * render nothing — a wire to a source that is permanently empty.
   */
  assert.match(src, /lastProviders\s*=\s*result\.providers/,
    'nothing ever assigns lastProviders, so /model would silently never show a route');
});
