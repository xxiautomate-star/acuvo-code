/**
 * ── ⭐⭐⭐ THE KNOWLEDGE LANE WAS BUILT, SWITCHED OFF, AND UNNAMEABLE ─────────
 *
 * `INTEGRATIONS.md` audited it end to end on 2026-08-25 and found two separate
 * walls in front of the single biggest quality lever on generated code:
 *
 *   1. **`docs` could not start.** It was an `npx` entry with
 *      `needsDownload: true`, and this client injects `npx --no` — so on a
 *      machine without a global install it did not fail loudly, it just refused.
 *      The register's own words: *"`docs` cannot be defaulted and that is
 *      correct … it needs `npm i -g @upstash/context7-mcp` first."*
 *   2. **Nothing ever told the model any of it existed.** Grepped across 40
 *      skills, `lib/tools.mjs` and every prompt assembler: *"zero occurrences of
 *      `context7`, `resolve-library-id`, `query-docs`, "current docs", "latest
 *      docs", or "version-specific". There is no skill named anything like
 *      look-up-the-docs-before-you-write-the-code."*
 *
 * ⭐ BOTH ARE CLOSED HERE, and they had to move together — this repo's own rule
 * is that **an option is not a default** and **the shortest path has to be named
 * or it is not taken**. A reachable server nobody mentions is the same dark
 * capability with a faster connect.
 *
 * ⚠️ WHAT IS *NOT* CLOSED, deliberately: `enabledByDefault` is still false.
 * The entry now satisfies the catalogue's own stated condition (verified &&
 * !needsDownload && no credentials), but that condition is necessary and not
 * sufficient — turning a server on for every session spends prefix bytes and a
 * connect on every run and sends the user's problem statement to a third party
 * by default. That is a product decision. This removes the technical reason it
 * could not be made.
 *
 * 💸 ZERO NETWORK IN THIS FILE. The endpoint was probed live once, by hand,
 * through the real `connectRemoteServer` with an empty env — 1,803ms to connect,
 * `resolve-library-id` 2,033ms, `query-docs` 1,736ms returning the current
 * `export async function GET(request: Request) {}` with a GitHub source URL. The
 * measurements live in the catalogue's `note`; these assertions are offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOGUE, isHosted } from '../lib/mcp-defaults.mjs';
import { resolveServer } from '../lib/mcp-add.mjs';
import { discoverAllSkills, loadAnySkill } from '../lib/builtin-skills.mjs';
import { skillsPromptBlock, rankSkillsForTask } from '../lib/skills.mjs';

const entry = () => CATALOGUE.find((e) => e.name === 'docs');

const made = [];
function bareWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-docs-skill-'));
  made.push(root);
  return root;
}
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// ───────────────────────────────────────────────────────────────────────────
// 1. THE SERVER CAN START ON A MACHINE THAT HAS INSTALLED NOTHING
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐⭐ `acuvo mcp add docs` hands a stranger a config with NO prerequisite', () => {
  const r = resolveServer('docs', { workspace: '/w' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.entry.type, 'http', 'a hosted entry is written as a url, never as a command to spawn');
  assert.equal(r.entry.url, 'https://mcp.context7.com/mcp');
  /**
   * ⚠️ THIS IS THE ONE THAT MATTERS. The old entry wrote `npx -y
   * @upstash/context7-mcp` and an `install` line — and because `mcp.mjs` strips
   * `-y` and injects `--no`, a user who skipped the install got a server that
   * silently would not start. Nothing to install means nothing to skip.
   */
  assert.equal(r.install, null, 'a prerequisite is a wall, and this one was never announced when it was hit');
});

test('⚠️ it is still OPT-IN, and the reason changed — so both halves are pinned', () => {
  const e = entry();
  assert.equal(isHosted(e), true);
  assert.equal(e.needsDownload, false, 'reverting this to npx re-blocks the highest-value knowledge server');
  assert.equal(e.credentials.length, 0, 'it earned its slot by needing no account — a credential changes the argument');
  assert.equal(e.verified, true);
  /**
   * ⭐ It now satisfies the catalogue's own condition for a default and is off
   * anyway. That is a DECISION (prefix bytes, a connect per run, egress by
   * default) and it belongs to Roman — recorded here so nobody reads the `false`
   * as the old technical constraint, which no longer exists.
   */
  assert.equal(e.enabledByDefault, false);
});

test('⚠️ the egress is still disclosed — a hosted lookup sends the query to a third party', () => {
  const r = resolveServer('docs', { workspace: '/w' });
  assert.match(
    r.note,
    /query text goes to/i,
    'the user\'s problem statement leaves the machine; an enterprise reviewer has to be told, exactly as for generate_image',
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 2. AND THE SHORTEST PATH IS NAMED — which is the half that gets skipped
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐⭐ the skill exists, ships, and is NAMED in the catalogue the model reads', () => {
  const root = bareWorkspace();
  const shelf = discoverAllSkills(root);
  assert.ok(shelf.skills.some((s) => s.name === 'look-up-the-docs'), 'the skill is not on the bundled shelf');

  /**
   * ⚠️ THE PROMPT BLOCK, NOT THE DIRECTORY LISTING. A file in `skills/` that the
   * model is never shown is a file. This repo has shipped built-but-unreached
   * four times in one day; the only thing that proves reach is the text that
   * actually goes into the prompt.
   */
  const block = String(skillsPromptBlock(shelf) ?? '');
  assert.match(block, /look-up-the-docs/, 'the model is never told the skill exists');
  assert.match(block, /version-specific/, 'and the description has to say what it is FOR, or it is never chosen');
});

test('⭐⭐ it ranks first for the question it exists to answer', () => {
  const shelf = discoverAllSkills(bareWorkspace());
  const ranked = rankSkillsForTask('what is the current api version for the supabase client library', shelf.skills)
    .map((r) => r.name);
  assert.equal(ranked[0], 'look-up-the-docs', `a skill that never ranks is never read. Got: ${ranked.join(', ')}`);
});

test('⭐ reading it returns the real workflow, in order, with the trap the server itself has', () => {
  const loaded = loadAnySkill(bareWorkspace(), 'look-up-the-docs');
  assert.equal(loaded.ok, true, loaded.error);
  const text = String(loaded.body ?? '');

  // ⭐ The order is the content. Workspace first (free, offline, exact), then the
  //   docs tools, then search, then the types on disk.
  assert.ok(text.indexOf('node_modules') < text.indexOf('web_search'),
    'the free, offline, exact source must be named before the network one');

  /**
   * ⚠️⚠️ THE MEASURED TRAP, CARRIED INTO THE SKILL. `resolve-library-id` requires
   * BOTH `libraryName` and `query`, and its error names only the one you DID
   * pass — measured, and it cost two calls to work out the first time. A model
   * that hits it without being warned burns the same two rounds.
   */
  assert.match(text, /resolve-library-id/);
  assert.match(text, /Both arguments are required/i);

  // ⚠️ And the egress, said in the skill as well as in the catalogue — the model
  //    is the thing that decides whether to send the user's problem out.
  assert.match(text, /leaves the machine|third party/i);
});

test('⚠️ it tells the model the PROSE loses to the installed version, which is our own live defect', () => {
  const text = String(loadAnySkill(bareWorkspace(), 'look-up-the-docs').body ?? '');
  /**
   * Not a hypothetical: a doctrine file in this repo describes the stack as
   * "Next 16, async params" while `node_modules/next` holds 14.2.35, where
   * `params` is a plain object. An agent that believes the prose writes
   * `params: Promise<{id:string}>` into a Next 14 app. `docs-context.mjs` ships
   * the same sentence into the system message; this keeps the two agreeing.
   */
  assert.match(text, /the list is right and the prose is stale/i);
});

// ──────────────────────────────────────────────────────────────────────
// 3. AND SO IS THE REST OF THE SHELF — `docs` WAS ONE OF ELEVEN
// ──────────────────────────────────────────────────────────────────────

/**
 * Every hosted entry a stranger can actually reach: verified by us, and no
 * credential they are REQUIRED to have. Derived from the catalogue rather than
 * listed here, so adding a twelfth server cannot quietly skip the naming step.
 */
const keylessKnowledge = () => CATALOGUE.filter((e) => isHosted(e)
  && e.verified === true
  && !(e.credentials ?? []).some((c) => c.required === true));

test('⭐⭐⭐ EVERY keyless knowledge server is NAMED in the skill — named ⇒ used, unnamed ⇒ never', () => {
  /**
   * ⚠️⚠️ THE GOVERNING MEASUREMENT OF THIS REPO, twice over: a library the
   * scaffold NAMES is used 29.8% of the time, one it merely SUPPLIES 2.2%, and
   * supplied-and-unnamed measured 0 of 6–13 per kind. A knowledge server that is
   * connected and unnamed is a dark capability with a latency cost and no
   * benefit. Before 2026-09-19 exactly ONE of the eleven appeared in any skill.
   */
  const text = String(loadAnySkill(bareWorkspace(), 'look-up-the-docs').body ?? '');
  const missing = keylessKnowledge().map((e) => e.name).filter((n) => !new RegExp(`\\b${n}\\b`).test(text));
  assert.deepEqual(missing, [], `these servers ship, connect keyless, and no skill names them: ${missing.join(', ')}`);
});

test('⚠️ and it names the DOOR, because a connected server with no schema in the list is unreachable', () => {
  const text = String(loadAnySkill(bareWorkspace(), 'look-up-the-docs').body ?? '');
  // The model's door when schemas are withheld by `mcp-shortlist.mjs`.
  assert.match(text, /use_toolset/, 'the model is never told how to load the tools of a withheld server');
  // The human's door — nothing connects until a person asks for it.
  assert.match(text, /acuvo mcp add/, 'the reader is never told the one line that turns a server on');
  // ⚠️ And the egress, per server class as well as for `docs`.
  assert.match(text, /leaks the name|PUBLIC repositories only/i);
});

test('⚠️⭐ naming the shelf costs ZERO bytes in the per-round prompt', () => {
  /**
   * ⭐ THE WHOLE REASON THIS WENT IN THE BODY. `skillsPromptBlock` sends
   * name + description + when, each capped (48/120/100 chars); a BODY is read
   * on demand through `read_skill`. The catalogue line for this skill is at its
   * cap either way, so eleven servers were named for nothing per round.
   *
   * ⚠️ MEASURED, NOT ASSUMED: 15,852 chars on 2026-09-19, before and after.
   */
  const shelf = discoverAllSkills(bareWorkspace());
  const block = String(skillsPromptBlock(shelf) ?? '');
  const line = block.split('\n').find((l) => l.startsWith('- look-up-the-docs')) ?? '';
  assert.ok(line.length <= 256, `the catalogue line must stay at its cap, got ${line.length}`);
  assert.ok(
    !/deepwiki|searchGitHub|mslearn|awsdocs/.test(block),
    'the shelf table belongs in the BODY — in the catalogue it would be re-sent every round',
  );
});
