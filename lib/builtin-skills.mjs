/**
 * ── ⭐⭐⭐ THE SKILLS THAT SHIP WITH ACUVO ───────────────────────────────────
 *
 * Roman, 2026-08-17: *"all the Modal integrations, all free opensource tools,
 * design elements and capabilities, skills, frameworks — it all needs to be in
 * Acuvo dude. Make it real."*
 *
 * ⚠️⚠️ MEASURED THE SAME DAY, AND HE WAS RIGHT: `skills.mjs` is 28,968 bytes of
 * complete infrastructure — a catalogue, frontmatter parsing, size caps, a
 * prompt block, tool schemas, tests — and **ZERO SKILLS SHIPPED**. There was no
 * `.acuvo/skills` directory anywhere in the repo and nothing seeded one. A user
 * installing the CLI got the loader and an empty shelf.
 *
 * That is the house defect at its most expensive: the extensibility system that
 * makes the product feel deep was finished, and there was nothing in it.
 *
 * ── ⭐ BUNDLED, NOT SEEDED ──────────────────────────────────────────────────
 *
 * The obvious fix — copy skill files into the user's project on first run — is
 * the wrong one. It writes into a repo we do not own, it goes stale the moment
 * we improve a skill, and it turns `git status` noisy in someone else's project.
 *
 * Instead these live INSIDE the package and are discovered as a second root.
 * Upgrading the CLI upgrades the skills, and the user's project stays clean.
 *
 * ⚠️ THE PROJECT ALWAYS WINS ON A NAME COLLISION. A user who writes their own
 * `nextjs-app-router` skill means it — ours is a default, not a policy. Losing
 * that argument silently would make the product feel like it is fighting them.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { discoverSkills, MAX_BUILTIN_SKILLS, loadSkill, SKILLS_DIR } from './skills.mjs';

/** Where the bundled skills live, relative to the package root. */
export const BUILTIN_SKILLS_DIR = 'skills';

/**
 * The package root — the directory containing `lib/` and `skills/`.
 *
 * ⚠️ DERIVED FROM `import.meta.url`, NOT `process.cwd()`. The CLI runs inside
 * whatever project the user is in, so cwd is THEIR repo; resolving the bundle
 * against it would look for our skills inside their tree and silently find
 * nothing — the exact failure this file exists to end.
 */
export function builtinSkillsRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Every skill available this run: the ones we ship, plus the ones the project
 * defines, with the project taking precedence by name.
 *
 * ⚠️ SHAPE-COMPATIBLE WITH `discoverSkills` ON PURPOSE, so `skillsPromptBlock`
 * and every existing test keep working against it unchanged.
 *
 * ⚠️ NEVER THROWS — the same rule `discoverSkills` follows. Assembling the
 * prompt may never be the thing that kills a run, so a broken bundle degrades
 * to "the project's skills only" rather than taking the session with it.
 */
export function discoverAllSkills(projectRoot, opts = {}) {
  let builtin = { ok: true, skills: [] };
  try {
    // ⚠️ `maxSkills` LAST, so a caller's project-shelf limit cannot silently
    // truncate the builtin shelf — which is exactly how three shipped skills
    // vanished. See MAX_BUILTIN_SKILLS in skills.mjs.
    builtin = discoverSkills(builtinSkillsRoot(), { ...opts, dir: BUILTIN_SKILLS_DIR, maxSkills: MAX_BUILTIN_SKILLS });
  } catch {
    builtin = { ok: true, skills: [] };
  }

  let project = { ok: true, skills: [] };
  try {
    project = discoverSkills(projectRoot, opts);
  } catch {
    project = { ok: true, skills: [] };
  }

  const builtinList = Array.isArray(builtin?.skills) ? builtin.skills : [];
  const projectList = Array.isArray(project?.skills) ? project.skills : [];

  const overridden = new Set(projectList.map((s) => s?.name).filter(Boolean));
  const merged = [
    ...projectList,
    ...builtinList.filter((s) => s?.name && !overridden.has(s.name)),
  ];

  return {
    /**
     * ⚠️⚠️ `ok` IS TRUE WHENEVER WE HAVE SKILLS TO OFFER, and my first version
     * got this wrong in a way only a test caught. I set it to the PROJECT's
     * `ok`, reasoning that a user's malformed `.acuvo/skills` should be heard
     * about. But `skillsPromptBlock` returns NULL on `ok === false` — so any
     * project without a readable skills directory (which is every project, by
     * default) suppressed the entire BUNDLED catalogue too. The skills shipped,
     * were discovered, and never reached the model.
     *
     * ⭐ The project's problem is still reported — it rides in `error` — but it
     * no longer takes our shelf down with it.
     */
    ok: merged.length > 0 || project?.ok !== false,
    dir: project?.dir ?? SKILLS_DIR,
    skills: merged,
    skipped: [...(project?.skipped ?? []), ...(builtin?.skipped ?? [])],
    found: merged.length,
    capped: (project?.capped ?? 0) + (builtin?.capped ?? 0),
    scanTruncated: Boolean(project?.scanTruncated || builtin?.scanTruncated),
    error: project?.error,
    builtinCount: builtinList.length,
    overrodeBuiltin: [...overridden].filter((n) => builtinList.some((b) => b.name === n)),
  };
}

/**
 * Load one skill by name, project first then bundled.
 *
 * ⚠️ THE ORDER MATCHES DISCOVERY. If the catalogue advertised the project's
 * version and the loader returned ours, the model would be shown one thing and
 * handed another — a drift that is invisible in every log.
 */
export function loadAnySkill(projectRoot, rawName, opts = {}) {
  let fromProject = null;
  try {
    fromProject = loadSkill(projectRoot, rawName, opts);
  } catch {
    fromProject = null;
  }
  if (fromProject && fromProject.ok) return fromProject;

  try {
    return loadSkill(builtinSkillsRoot(), rawName, { ...opts, dir: BUILTIN_SKILLS_DIR });
  } catch {
    // Fall back to the project's own refusal so the caller still gets a reason.
    return fromProject ?? { ok: false, error: 'skill not found' };
  }
}
