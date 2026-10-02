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
/**
 * ── ⭐⭐⭐ A USER COULD NOT KEEP A SKILL OF THEIR OWN ─────────────────────────
 *
 * Verified 2026-09-19 by running the real discovery against a scratch project:
 * `.acuvo/skills/house-style.md` was found and merged (67 bundled + 1 project
 * = 68), so PROJECT-LOCAL AUTHORING ALREADY WORKED and the header below is
 * right about it. What did not exist is a shelf that survives the project.
 *
 * ⚠️ A PERSON'S OWN PROCEDURES ARE NOT A PROPERTY OF ONE REPOSITORY. "How I
 * like commit messages", "the review checklist I use", "the way I name
 * branches" are true of the PERSON, and the only place to put them was inside
 * whichever repo they happened to be in — so they had to be re-typed per
 * project, they went into somebody else's git tree, and a repo the user only
 * cloned could not have them at all. Replit ships a public skill directory and
 * Manus imports from GitHub; the smallest honest answer to both is that a user's
 * own skills live somewhere that is theirs.
 *
 * ⭐ THREE SHELVES, MOST SPECIFIC WINS: project → user → bundled.
 *
 *     .acuvo/skills/        this repository  (committed, shared with the team)
 *     ~/.acuvo/skills/      this person      (every project on this machine)
 *     <package>/skills/     ours             (67, upgraded by npm)
 *
 * ⚠️ THE ORDER IS AN ARGUMENT, NOT A DEFAULT. A project skill beats a user
 * skill because a repository's conventions are the ones in force while you are
 * working in it — the same reasoning that already makes a project skill beat
 * ours. ⚠️ AND IT HAS A STATED COST: a repository you cloned can shadow a skill
 * you wrote, by naming a file the same thing. That is not new — a cloned repo
 * could already shadow OURS, and a skill is read-only instructions that a model
 * chooses to consult — but it is now shadowing something PERSONAL, so
 * `describeSkillShelves` reports every override by name rather than leaving it
 * to be discovered. A silent override would be the worse half of this trade.
 *
 * ── ⛔ WHAT THIS DELIBERATELY DOES NOT DO: IMPORT FROM A URL ────────────────
 *
 * The obvious next feature is `acuvo skills add <github-url>`, and it is not
 * here on purpose. A skill is INSTRUCTIONS THAT ENTER THE MODEL'S CONTEXT and
 * are followed; fetching one from a stranger is prompt injection with a package
 * manager in front of it, and the fetched text would be the one thing in this
 * package nobody reviewed. `mcp-consent.mjs` already carries the shape such a
 * feature would need — a fingerprint of the exact contents, a trust store
 * OUTSIDE the workspace, a prompt naming what is about to happen, and failing
 * closed where there is nobody to ask — and building it correctly is a bigger
 * job than this one. Until then the honest surface is: a user writes a file, or
 * copies one in themselves, which is a review they performed.
 *
 * ⚠️ AND `read_skill` STILL TAKES A NAME, NEVER A PATH. The model can only ask
 * for something discovery already found on disk, so a third root widens what a
 * PERSON can put on the shelf and widens nothing the model can reach for.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { discoverSkills, MAX_BUILTIN_SKILLS, loadSkill, SKILLS_DIR } from './skills.mjs';
import { searchSkills } from './skill-search.mjs';
import { accountDir } from './account.mjs';

/** Where the bundled skills live, relative to the package root. */
export const BUILTIN_SKILLS_DIR = 'skills';

/**
 * The package root — the directory containing `lib/` and `skills/`.
 *
 * ⚠️ DERIVED FROM `import.meta.url`, NOT `process.cwd()`. The CLI runs inside
 * whatever project the user is in, so cwd is THEIR repo; resolving the bundle
 * against it would look for our skills inside their tree and silently find
 * nothing — the exact failure this file exists to end.
 *
 * ── ⚠️⚠️ AND IT FOUND NOTHING IN THE BUNDLE, WHICH IS WHERE IT MATTERS MOST ──
 *
 * This used to read `join(dirname(fileURLToPath(import.meta.url)), '..')`, and
 * on the npm install that is exactly right: `lib/builtin-skills.mjs` → `lib/` →
 * `..` → the package root, which holds `skills/`.
 *
 * ⚠️ IN `dist/acuvo.mjs` IT IS WRONG BY ONE DIRECTORY, AND SILENTLY. The bundler
 * rewrites a bare `import.meta.url` to a URL under the BUNDLE's own directory
 * (`__acuvo_meta('lib/builtin-skills.mjs')` → `<dist>/lib/builtin-skills.mjs`),
 * so the arithmetic above yields `<dist>` and the shelf is looked for at
 * `dist/skills/` — a directory that has never existed. MEASURED 2026-08-29,
 * end to end, with `--doctor` and nothing else:
 *
 *     node bin/acuvo.mjs  --doctor     read_skill: offered  (58 of 77 tools)
 *     node dist/acuvo.mjs --doctor     read_skill: DARK — "the bundled shelf is empty"
 *
 * ✅ RE-VERIFIED 2026-09-06, EIGHT DAYS AND ONE REBUILD LATER — the fix still
 * holds, and the two now agree exactly:
 *
 *     node bin/acuvo.mjs  --doctor     tools offered here  70 of 82
 *     node dist/acuvo.mjs --doctor     tools offered here  70 of 82
 *     37 live · 20 dark · 0 broken, identical on both
 *
 * ⚠️ The rebuild mattered: `dist/` had gone FOUR DAYS stale (caught by
 * `test/bundle-is-not-stale.test.mjs`, which is why that test exists), so the
 * bundle everything benches was scoring old code — including, this week, the
 * twelve skills whose bodies were being truncated on read. A parity check
 * against a stale bundle proves nothing; rebuild first, then compare.
 *
 * ⚠️⚠️ AND THE BUNDLE IS WHAT THE BENCHMARK SCORES. `bench/terminal-bench`
 * uploads `dist/acuvo.mjs` to `/opt/acuvo.mjs` and nothing else — *"the agent is
 * ONE FILE"* — so `/opt/skills/` does not exist either. `skillsAvailable()` in
 * `tools.mjs` gates `read_skill` on the shelf being non-empty, which means that
 * in every containerised trial the verb was never offered and the SKILLS
 * catalogue was never in the prompt. `read_skill` was called ZERO times in 1,379
 * recorded rounds, and this is the whole reason: 44 authored skills, 341KB of
 * capability, structurally unreachable in the distribution being measured.
 *
 * ⭐ NAMING THE DIRECTORY AS A `new URL(…, import.meta.url)` ASSET IS THE FIX,
 * and it is one expression rather than a special case: the bundler already
 * inlines assets referenced that way and materialises them on first use. The
 * TRAILING SLASH is what marks it as a whole directory — see `assetDirPrelude`
 * in `scripts/bundle.mjs`. On the source tree this is byte-for-byte the same
 * path the old line produced; in the bundle it is a temp directory holding the
 * real shelf.
 *
 * ⚠️ `dirname` OF A DIRECTORY URL IS ITS PARENT, which is what this must return —
 * `discoverAllSkills` passes it to `discoverSkills(root, { dir: 'skills' })`, so
 * the root is the package, not the shelf.
 */
export function builtinSkillsRoot() {
  return dirname(fileURLToPath(new URL('../skills/', import.meta.url)));
}

/**
 * Where a person's own skills live: `<ACUVO_HOME or ~/.acuvo>/skills`.
 *
 * ⚠️ IT RETURNS THE ROOT, NOT THE SHELF, because that is what `discoverSkills`
 * takes — root plus a `dir`, exactly as the bundled shelf is passed. The pair
 * is `(accountDir, 'skills')`, so `resolveInWorkspace` still guards the join
 * and the user directory gets the identical treatment as every other path in
 * this package.
 */
export function userSkillsRoot(env = process.env, home = homedir()) {
  return accountDir(env, home);
}

/** The directory a person creates to author their own. Named in every message. */
export const USER_SKILLS_DIR = 'skills';

/** Absolute path to the user's shelf — for the doctor, `acuvo skills`, and errors. */
export function userSkillsPath(env = process.env, home = homedir()) {
  return join(userSkillsRoot(env, home), USER_SKILLS_DIR);
}

/**
 * ⚠️ RUNNING ACUVO IN YOUR HOME DIRECTORY MUST NOT COUNT A SKILL TWICE.
 *
 * `~` is a perfectly ordinary place to run a one-off task, and there the
 * project root IS the user root's parent — so `.acuvo/skills` and
 * `~/.acuvo/skills` are the same directory, every name collides with itself,
 * and the override report would announce that the user had overridden
 * themselves. Same-path detection, not same-string: a symlinked or
 * differently-cased home is the case a string compare gets wrong on exactly the
 * platform this is developed on.
 */
function samePlace(a, b) {
  try {
    return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Every skill available this run, from all three shelves: the ones the project
 * defines, the ones this person keeps under their own home, and the ones we
 * ship — in that order of precedence, by name.
 *
 * ⚠️ SHAPE-COMPATIBLE WITH `discoverSkills` ON PURPOSE, so `skillsPromptBlock`
 * and every existing test keep working against it unchanged.
 *
 * ⚠️ NEVER THROWS — the same rule `discoverSkills` follows. Assembling the
 * prompt may never be the thing that kills a run, so a broken bundle degrades
 * to "the project's skills only" rather than taking the session with it.
 */
export function discoverAllSkills(projectRoot, opts = {}) {
  const { env = process.env, home = homedir(), ...rest } = opts;
  let builtin = { ok: true, skills: [] };
  try {
    // ⚠️ `maxSkills` LAST, so a caller's project-shelf limit cannot silently
    // truncate the builtin shelf — which is exactly how three shipped skills
    // vanished. See MAX_BUILTIN_SKILLS in skills.mjs.
    builtin = discoverSkills(builtinSkillsRoot(), { ...rest, dir: BUILTIN_SKILLS_DIR, maxSkills: MAX_BUILTIN_SKILLS });
  } catch {
    builtin = { ok: true, skills: [] };
  }

  let project = { ok: true, skills: [] };
  try {
    project = discoverSkills(projectRoot, rest);
  } catch {
    project = { ok: true, skills: [] };
  }

  /**
   * ⚠️ THE USER SHELF IS CAPPED LIKE THE PROJECT'S, NOT LIKE OURS. The reason
   * `MAX_BUILTIN_SKILLS` is bigger is that OUR shelf is curated and reviewed;
   * the argument for `MAX_SKILLS` is the per-round token bill of the catalogue,
   * and that bill is identical whoever wrote the file. Over the cap is reported
   * as `capped`, never dropped in silence.
   *
   * ⚠️ AND IT IS SKIPPED ENTIRELY WHEN IT WOULD BE THE PROJECT SHELF AGAIN.
   */
  let user = { ok: true, skills: [] };
  const userRoot = userSkillsRoot(env, home);
  const duplicated = typeof projectRoot === 'string' && projectRoot !== ''
    && samePlace(join(projectRoot, SKILLS_DIR), join(userRoot, USER_SKILLS_DIR));
  if (!duplicated) {
    try {
      user = discoverSkills(userRoot, { ...rest, dir: USER_SKILLS_DIR });
    } catch {
      user = { ok: true, skills: [] };
    }
  }

  // ⭐ `applies-to: builder` skills (the builder's runtime globals and verbs) are
  // not on the CLI's shelf — the same rule the builder applies to `cli`. Filtered
  // HERE so `builtinCount` and the catalogue count the same shelf.
  const builtinList = Array.isArray(builtin?.skills) ? builtin.skills.filter((s) => s?.appliesTo !== 'builder') : [];
  const projectList = Array.isArray(project?.skills) ? project.skills : [];
  const userList = Array.isArray(user?.skills) ? user.skills : [];

  /**
   * ⭐ MOST SPECIFIC WINS, AND EVERY OVERRIDE IS RECORDED BY NAME. A shadowed
   * skill that nobody is told about is the same silent failure
   * `project-memory.mjs` refuses: the user believes a procedure is in force and
   * the model was shown a different one.
   */
  const fromProject = new Set(projectList.map((s) => s?.name).filter(Boolean));
  const userKept = userList.filter((s) => s?.name && !fromProject.has(s.name));
  const shadowed = new Set([...fromProject, ...userKept.map((s) => s.name)]);
  const merged = [
    ...projectList,
    ...userKept,
    ...builtinList.filter((s) => s?.name && !shadowed.has(s.name)),
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
    skipped: [...(project?.skipped ?? []), ...(user?.skipped ?? []), ...(builtin?.skipped ?? [])],
    found: merged.length,
    capped: (project?.capped ?? 0) + (user?.capped ?? 0) + (builtin?.capped ?? 0),
    scanTruncated: Boolean(project?.scanTruncated || user?.scanTruncated || builtin?.scanTruncated),
    error: project?.error ?? user?.error,
    builtinCount: builtinList.length,
    userCount: userList.length,
    projectCount: projectList.length,
    /** ⚠️ NAMES, not counts — `skillShelves` has to say WHICH shelf each entry
     *  came from, and a count cannot answer that. */
    projectNames: [...fromProject],
    userNames: userKept.map((s) => s.name),
    userDir: userSkillsPath(env, home),
    /** ⚠️ Kept as the name it has always had, because callers and tests read it. */
    overrodeBuiltin: [...shadowed].filter((n) => builtinList.some((b) => b.name === n)),
    /** ⭐ The new one: a project skill standing in front of a PERSONAL skill. */
    projectOverrodeUser: [...fromProject].filter((n) => userList.some((u) => u.name === n)),
  };
}

/**
 * Load one skill by name: project, then the user's own, then bundled.
 *
 * ⚠️ THE ORDER MATCHES DISCOVERY. If the catalogue advertised the project's
 * version and the loader returned ours, the model would be shown one thing and
 * handed another — a drift that is invisible in every log. The user tier was
 * added to BOTH in the same commit for that reason: a shelf that discovery can
 * see and the loader cannot is a catalogue entry that 404s.
 */
export function loadAnySkill(projectRoot, rawName, opts = {}) {
  const { env = process.env, home = homedir(), ...rest } = opts;
  let fromProject = null;
  try {
    fromProject = loadSkill(projectRoot, rawName, rest);
  } catch {
    fromProject = null;
  }
  if (fromProject && fromProject.ok) return fromProject;

  try {
    const fromUser = loadSkill(userSkillsRoot(env, home), rawName, { ...rest, dir: USER_SKILLS_DIR });
    if (fromUser && fromUser.ok) return fromUser;
  } catch { /* no user shelf is the common case */ }

  let result;
  try {
    result = loadSkill(builtinSkillsRoot(), rawName, { ...rest, dir: BUILTIN_SKILLS_DIR });
  } catch {
    // Fall back to the project's own refusal so the caller still gets a reason.
    result = fromProject ?? { ok: false, error: 'skill not found' };
  }
  return result?.ok ? result : withSkillSuggestions(result, projectRoot, rawName, opts);
}

/**
 * ⭐ A MISSED NAME IS A SEARCH. When `read_skill` / `/skills <name>` names no
 * skill, the argument is treated as a NEED and the closest skills ride the
 * refusal — paid per occurrence, never in the standing prompt. The model can
 * pass "take a card payment" and be told `payments` in the same round.
 */
export function withSkillSuggestions(result, projectRoot, rawName, opts = {}) {
  let hits = [];
  try {
    hits = searchSkills(rawName, discoverAllSkills(projectRoot, opts).skills, { limit: 3, surface: 'cli' });
  } catch { hits = []; }
  if (!hits.length) return result;
  return {
    ...(result ?? { ok: false }),
    ok: false,
    error: `${result?.error ?? 'skill not found'} — closest by need: ${hits.map((h) => h.name).join(', ')}`,
    suggestions: hits,
  };
}

/**
 * Which shelf each name came from, and what is standing in front of what.
 *
 * ⭐ IT EXISTS BECAUSE A SHELF YOU CANNOT SEE IS A SHELF YOU DO NOT TRUST. 67
 * skills ship and the only way to learn what was on them was to read the
 * package directory; a user who wrote their own had no way to confirm it was
 * found, and no way to discover that a repository they cloned had quietly
 * shadowed it. `acuvo skills` is the whole answer, and this is its data.
 *
 * ⚠️ IT RETURNS A SEPARATE MAP RATHER THAN TAGGING THE SKILL OBJECTS. Those
 * objects go into `skillsPromptBlock` and `buildSkillIndex`; adding a field to
 * them to serve a listing command would put a byte of presentation into the
 * cached prompt prefix, which is the trade `skills.mjs` already refuses when it
 * sorts the catalogue by code point.
 */
export function skillShelves(projectRoot, opts = {}) {
  const d = discoverAllSkills(projectRoot, opts);
  const bySource = { project: [], user: [], bundled: [] };
  for (const s of d.skills) {
    if (!s?.name) continue;
    if (d.projectNames.includes(s.name)) bySource.project.push(s);
    else if (d.userNames.includes(s.name)) bySource.user.push(s);
    else bySource.bundled.push(s);
  }
  return { ...d, bySource };
}
