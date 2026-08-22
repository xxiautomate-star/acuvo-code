/**
 * ⚠️ WRITTEN BECAUSE A MUTATION SURVIVED. Swapping the merge order so BUNDLED
 * skills beat the PROJECT's passed 51 of 51 tests — the precedence rule that
 * decides whose instructions a user's agent follows had no coverage at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAllSkills, loadAnySkill, builtinSkillsRoot } from '../lib/builtin-skills.mjs';

function projectWith(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-skills-'));
  const dir = join(root, '.acuvo', 'skills');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return root;
}

const skillFile = (name, description, body) =>
  `---\nname: ${name}\ndescription: ${description}\nwhen: always\n---\n\n${body}\n`;

test('⭐ Acuvo ships skills, and they are found with no project at all', () => {
  const d = discoverAllSkills(join(tmpdir(), 'definitely-not-a-project-' + Date.now()));
  assert.ok(d.builtinCount >= 6, `expected bundled skills, got ${d.builtinCount}`);
  const names = d.skills.map((s) => s.name);
  for (const expected of ['acuvo-design-system', 'nextjs-app-router', 'supabase-multitenant']) {
    assert.ok(names.includes(expected), `${expected} must ship`);
  }
});

/**
 * ⚠️⚠️ THE MUTATION THAT SURVIVED. A user who writes their own
 * `nextjs-app-router` MEANS it — ours is a default, not a policy. If the bundle
 * silently won, the product would be quietly overriding its user's explicit
 * instruction, which is the worst possible way to lose that argument.
 */
test('⚠️⚠️ the PROJECT wins on a name collision — ours is a default, not a policy', () => {
  const root = projectWith({
    'nextjs-app-router.md': skillFile('nextjs-app-router', 'THE PROJECT VERSION', 'Use the pages router here, we have not migrated.'),
  });
  try {
    const d = discoverAllSkills(root);
    const hits = d.skills.filter((s) => s.name === 'nextjs-app-router');
    assert.strictEqual(hits.length, 1, 'the same skill must not appear twice');
    assert.strictEqual(hits[0].description, 'THE PROJECT VERSION', 'the project must win');
    assert.ok(d.overrodeBuiltin.includes('nextjs-app-router'), 'the override is reported, not silent');

    // And loading must agree with the catalogue, or the model is shown one
    // thing and handed another — drift invisible in every log.
    const loaded = loadAnySkill(root, 'nextjs-app-router');
    assert.strictEqual(loaded.ok, true);
    assert.match(loaded.body, /pages router/, 'loadAnySkill must return the PROJECT body');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐ a project skill ADDS to the shelf rather than replacing it', () => {
  const root = projectWith({
    'deploy.md': skillFile('deploy', 'How we deploy here', 'Run the migration, then flip the flag.'),
  });
  try {
    const d = discoverAllSkills(root);
    const names = d.skills.map((s) => s.name);
    assert.ok(names.includes('deploy'), 'the project skill is present');
    assert.ok(names.includes('acuvo-design-system'), 'and ours are not displaced by it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ⚠️ MY OWN BUG, CAUGHT BY A TEST AND PINNED HERE. The first version set `ok`
 * from the PROJECT's read — and `skillsPromptBlock` returns null on
 * `ok === false`, so any project without a readable skills directory (which is
 * every project by default) suppressed the entire BUNDLED catalogue too. The
 * skills shipped, were discovered, and never reached the model.
 */
test('⚠️⚠️ an unreadable project must NEVER suppress the bundled shelf', () => {
  const d = discoverAllSkills('/definitely/not/a/real/path/anywhere');
  assert.strictEqual(d.ok, true, 'ok must stay true while we have skills to offer');
  assert.ok(d.skills.length > 0, 'the bundle survives a broken project root');
});

/**
 * ⚠️ THE CLI RUNS INSIDE THE USER'S PROJECT, so a cwd-relative bundle path
 * looks for our skills inside THEIR tree and silently finds nothing.
 *
 * ⭐ Asserting `root !== process.cwd()` does not test this — under `node --test`
 * the cwd IS the package, so that assertion fails on correct code (it did).
 * The real property is that the answer does not MOVE when the cwd does.
 */
test('⚠️ the bundle root follows the module, and does not move with the cwd', () => {
  const before = builtinSkillsRoot();
  const skillsBefore = discoverAllSkills('/none').builtinCount;
  const cwd = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.strictEqual(builtinSkillsRoot(), before, 'the bundle root moved with the cwd');
    assert.strictEqual(discoverAllSkills('/none').builtinCount, skillsBefore,
      'the skills became undiscoverable from a different working directory');
  } finally {
    process.chdir(cwd);
  }
});

test('⚠️ an unknown skill refuses and names what does exist', () => {
  const r = loadAnySkill(join(tmpdir(), 'nope-' + Date.now()), 'not-a-real-skill');
  assert.strictEqual(r.ok, false);
  assert.match(String(r.error ?? ''), /acuvo-design-system/, 'the refusal must list real options');
});

test('⭐ every shipped skill parses — no broken frontmatter reaches a user', () => {
  const d = discoverAllSkills(join(tmpdir(), 'none-' + Date.now()));
  assert.strictEqual(d.skipped.length, 0, `a shipped skill failed to parse: ${JSON.stringify(d.skipped)}`);
  for (const s of d.skills) {
    assert.ok(s.name && s.name.length > 2, 'every skill needs a name');
    assert.ok(s.description && s.description.length > 10, `${s.name} needs a real description`);
    // The catalogue is capped at 1,800 chars; a rambling description eats the
    // budget that lets OTHER skills be discoverable at all.
    assert.ok(s.description.length <= 120, `${s.name}: description too long for the catalogue`);
  }
});
