/**
 * ── ⭐⭐⭐ A PERSON'S OWN PROCEDURES ARE NOT A PROPERTY OF ONE REPOSITORY ─────
 *
 * Verified 2026-09-19 against the real discovery before changing anything:
 * PROJECT-LOCAL AUTHORING ALREADY WORKED — a `.acuvo/skills/house-style.md` in
 * a scratch project was found and merged (67 bundled + 1 project = 68). What
 * did not exist was a shelf that survives the project, so "how I like commit
 * messages" had to be re-typed per repo, went into somebody else's git tree,
 * and could not exist at all in a repository the user only cloned.
 *
 * Three shelves now, most specific first: project → user → bundled. Proven end
 * to end with the real binary:
 *
 *   ~/.acuvo/skills/acuvo-code-proof.md, project shelf empty
 *     acuvo skills            "yours (1)"
 *     acuvo "read the skill acuvo-code-proof …"
 *       · read_skill acuvo-code-proof · 66 bytes
 *       → THE-USER-SHELF-IS-REACHABLE-8675309
 *
 *   …then the same name added to .acuvo/skills/
 *     acuvo skills            "yours (0 + 1 shadowed by this project)"
 *                             "⚠ this project is standing in front of 1 of YOUR skills"
 *     acuvo "read the skill acuvo-code-proof …"
 *       → THE-PROJECT-SHELF-WINS-1123581
 *
 * This file guards the four decisions behind that, because three of them are
 * silent when wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverAllSkills, loadAnySkill, skillShelves, userSkillsPath } from '../lib/builtin-skills.mjs';

function dir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  return { path: d, cleanup: () => { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

function skill(root, rel, name, body) {
  const abs = join(root, ...rel.split('/'), `${name}.md`);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`);
}

/** A HOME whose `~/.acuvo/skills` holds the given names. */
function userHome(names) {
  const h = dir('acuvo-skill-home-');
  const env = { ACUVO_HOME: join(h.path, '.acuvo') };
  for (const n of names) skill(env.ACUVO_HOME, 'skills', n, `the USER version of ${n}`);
  return { ...h, env, home: h.path };
}

test('⭐⭐⭐ a skill under the user home is available in a project that has none', () => {
  const ws = dir('acuvo-skill-ws-');
  const me = userHome(['my-review-checklist']);
  try {
    const d = discoverAllSkills(ws.path, { env: me.env, home: me.home });
    const found = d.skills.find((s) => s.name === 'my-review-checklist');
    assert.ok(found, 'the user shelf was not discovered');
    assert.equal(d.userCount, 1);

    /**
     * ⚠️ AND THE LOADER HAS TO AGREE WITH DISCOVERY. A shelf the catalogue can
     * advertise and `read_skill` cannot open is a menu entry that 404s — the
     * drift `builtin-skills.mjs` already warns about for the project tier, and
     * it is invisible in every log because the catalogue still looks right.
     */
    const loaded = loadAnySkill(ws.path, 'my-review-checklist', { env: me.env, home: me.home });
    assert.equal(loaded.ok, true, loaded.error);
    assert.match(loaded.body ?? loaded.text ?? JSON.stringify(loaded), /USER version/);
  } finally {
    ws.cleanup(); me.cleanup();
  }
});

test('⭐⭐ project beats user beats bundled, in discovery AND in the loader', () => {
  const ws = dir('acuvo-skill-ws-');
  const me = userHome(['shared-name']);
  try {
    skill(ws.path, '.acuvo/skills', 'shared-name', 'the PROJECT version of shared-name');
    const d = discoverAllSkills(ws.path, { env: me.env, home: me.home });

    const entries = d.skills.filter((s) => s.name === 'shared-name');
    assert.equal(entries.length, 1, 'a shadowed skill must not appear twice in the catalogue');
    assert.match(entries[0].description, /PROJECT version/);

    const loaded = loadAnySkill(ws.path, 'shared-name', { env: me.env, home: me.home });
    assert.match(loaded.body ?? loaded.text ?? JSON.stringify(loaded), /PROJECT version/);
  } finally {
    ws.cleanup(); me.cleanup();
  }
});

test('⚠️⚠️ an override of a PERSONAL skill must be reported by name, never silently', () => {
  /**
   * This is the stated cost of "most specific wins": a repository you cloned
   * can stand in front of a skill you wrote, by naming a file the same thing.
   * A cloned repo could already shadow OURS, so the mechanism is not new — but
   * it is now shadowing something personal, and a shadowed skill nobody is told
   * about is the silent failure `project-memory.mjs` refuses: the user believes
   * a procedure is in force and the model was shown a different one.
   */
  const ws = dir('acuvo-skill-ws-');
  const me = userHome(['shared-name', 'mine-only']);
  try {
    skill(ws.path, '.acuvo/skills', 'shared-name', 'the PROJECT version');
    const d = discoverAllSkills(ws.path, { env: me.env, home: me.home });
    assert.deepEqual(d.projectOverrodeUser, ['shared-name']);

    const shelves = skillShelves(ws.path, { env: me.env, home: me.home });
    assert.deepEqual(shelves.bySource.project.map((s) => s.name), ['shared-name']);
    assert.deepEqual(shelves.bySource.user.map((s) => s.name), ['mine-only']);
    assert.ok(shelves.bySource.bundled.length > 0, 'the bundled shelf must still be there');
  } finally {
    ws.cleanup(); me.cleanup();
  }
});

test('⚠️ running acuvo in your own home must not count a skill twice', () => {
  /**
   * `~` is an ordinary place to run a one-off task, and there the project shelf
   * and the user shelf are THE SAME DIRECTORY. Without the same-path check
   * every name collides with itself, the catalogue carries duplicates, and the
   * override report announces that the user has overridden themselves.
   */
  const h = dir('acuvo-skill-home-');
  const env = { ACUVO_HOME: join(h.path, '.acuvo') };
  try {
    skill(env.ACUVO_HOME, 'skills', 'only-once', 'once');
    const d = discoverAllSkills(h.path, { env, home: h.path });
    assert.equal(d.skills.filter((s) => s.name === 'only-once').length, 1);
    assert.deepEqual(d.projectOverrodeUser, []);
  } finally {
    h.cleanup();
  }
});

test('⭐ the bundled shelf survives all of it — 67 skills must not disappear behind a user shelf', () => {
  /**
   * `builtin-skills.mjs` records a version of this going wrong before: setting
   * `ok` from the project's discovery suppressed the entire bundled catalogue
   * for every project without a skills directory, which is every project. A
   * third tier is a third chance to make that mistake.
   */
  const ws = dir('acuvo-skill-ws-');
  const me = userHome(['mine']);
  try {
    const d = discoverAllSkills(ws.path, { env: me.env, home: me.home });
    assert.ok(d.builtinCount >= 60, `only ${d.builtinCount} bundled skills were found`);
    assert.equal(d.found, d.builtinCount + 1);
    assert.equal(d.ok, true);
    assert.ok(String(userSkillsPath(me.env, me.home)).endsWith('skills'));
  } finally {
    ws.cleanup(); me.cleanup();
  }
});
