/**
 * THE TOOL REGISTRY — one declaration, read by the model and by the dispatcher.
 *
 * ── WHY A REGISTRY FOR THREE TOOLS ──────────────────────────────────────────
 * Because the architecture is ONE capability registry, TWO clients. The web
 * console already has 160-odd tools whose executor is a cloud sandbox; this CLI
 * is the same idea with a LOCAL executor. Three tools is the first slice, not
 * the design — and the whole point of the slice is to establish the seam where
 * more get added, rather than to hardcode three `if` branches that the second
 * client would have to fork.
 *
 * ⚠️ THE SCHEMA AND THE DISPATCH LIVE IN ONE FILE ON PURPOSE. The recurring bug
 * in tool-calling systems is a model that has been TOLD about a tool the
 * dispatcher does not implement (or that takes a differently-named argument) —
 * a silent capability hole, because the model dutifully calls it and the turn
 * quietly reports "unknown tool". Keeping the JSON Schema next to the code that
 * reads the arguments means the drift has to be committed deliberately, and
 * `console/lib/acuvo-code-workspace.test.ts` asserts every declared tool has a
 * handler and vice versa.
 */

// ⚠️ The ONLY direct filesystem use in this file, and it is for the OFFER, not
// for a tool: `languagesPresent` below has to look at the workspace to decide
// whether a language server could ever answer here. Every tool still reads and
// writes through the executor.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { executeRunCommand } from './command.mjs';
import { generateImage, imageToolSchema, imageConfig } from './imagegen.mjs';
import { findFiles, searchText, searchToolSchemas } from './search.mjs';
import { editThroughExecutor, editToolSchema } from './edit.mjs';
import { deleteToolSchema } from './delete.mjs';
import { evaluateSnippet, evaluateToolSchema } from './evaluate.mjs';
import { gitStatus, gitDiff, gitLog, gitCommit, gitToolSchemas, refusedCommitPath } from './git.mjs';
import { speak, transcribe, makeDocument, readDocument, readTable, mediaToolSchemas, mediaToolNames } from './media.mjs';
import { editImage, expandImage, imageEditToolSchemas, imageEditToolNames } from './image-edit.mjs';
/**
 * ⭐ `designPass` IS A STRICT SUPERSET OF `seePage`, deliberately, so wiring it
 * is a SWAP rather than a migration: `ok`, `path`, `screenshot`,
 * `screenshotBytes`, `viewport`, `findings` and `looked` are untouched, and
 * every existing consumer (report.mjs, parallel.mjs, turn.mjs) keeps working.
 * What it adds is the ~89-token `verdict` the model actually acts on, plus a
 * `trustworthy` flag so a render that cannot be believed is never phrased as
 * an all-clear.
 *
 * ⚠️ `seePage` IS NO LONGER IMPORTED HERE, AND THAT IS THE POINT. Leaving both
 * in scope is exactly how this package ended up with a hardened `editFile()`
 * while the dispatcher called the unhardened one — two paths to one capability,
 * and the wrong one wired. design-loop.mjs calls media.mjs's `seePage` itself;
 * it wraps the transport, it does not fork it.
 */
import { designPass } from './design-loop.mjs';
import { planStart, planStep, planStatus, planToolSchemas, planFileFor } from './plan-ledger.mjs';
import { discoverSkills, loadSkill, skillsToolSchemas } from './skills.mjs';
import { remember, forget, learnedToolSchemas } from './learned.mjs';
import { lspToolSchemas, runLspTool, discoverLanguageServer, LANGUAGE_SERVERS, LSP_TOOL_NAMES } from './lsp.mjs';
import { backgroundToolSchemas, runBackgroundTool, BACKGROUND_TOOL_NAMES } from './background.mjs';
import { tsserverAvailable, runTsserverTool, handlesFile as tsHandlesFile } from './tsserver.mjs';
import { replToolSchemas, runReplTool, REPL_TOOL_NAMES } from './repl.mjs';
import { listSessions, sessionToolSchemas } from './session.mjs';
import { askUserToolSchemas } from './ask-user.mjs';
import { declareAcceptance, checkAcceptance, acceptanceToolSchemas } from './acceptance.mjs';
import { fetchText, fetchToolSchemas } from './fetch-text.mjs';
import { webSearch, formatResults, webSearchToolSchemas } from './websearch.mjs';
import { readImage, visionToolSchemas } from './vision.mjs';
import { readWindow, readWindowToolSchemas } from './read-window.mjs';
import { runProgram, spawnArgvToolSchemas } from './spawn-argv.mjs';
import { runSubagent, subagentToolSchemas } from './subagent.mjs';

/**
 * The sentinel `workspace.mjs` gives an executor with no disk (the browser
 * builder's Map-backed one). Spelled once here because SIX of the tools below
 * have to refuse on it, and six copies of a magic string is how one of them
 * ends up spelled `"(memory)"` with different brackets.
 */
const MEMORY_ROOT = '(memory)';

/** OpenAI-shaped tool definitions. OpenRouter, Groq, Cerebras and Gemini's
 *  compatibility endpoint all speak this, which is why the console's transport
 *  uses the same shape. */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file from the workspace. Paths are relative to the workspace root; anything outside it is refused.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path, e.g. "src/index.js".' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a UTF-8 text file in the workspace, creating parent directories as needed. Write the COMPLETE file contents — there is no patch or append mode, so anything you omit is deleted.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path, e.g. "src/index.js".' },
          content: { type: 'string', description: 'The complete new contents of the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the entries of a directory in the workspace. Use "." for the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory, or "." for the root.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: [
        'Run ONE allowlisted command in the workspace and get its exit code, stdout and stderr back.',
        'This is how you VERIFY what you wrote — a non-zero exit code is the fact you fix in the next round.',
        'Allowed: `node <file>`, `node --test <file-or-dir>`, `npm test`, `npm run <script>`,',
        '`npx vitest run [paths]`, `tsc --noEmit`.',
        'There is NO SHELL: pipes, &&, ;, quotes, redirection, backticks, $() and every other program',
        '(rm, curl, git, python, …) are refused. Run one plain command per call.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'One command, e.g. "node --test src/math.test.js" or "npm test".',
          },
        },
        required: ['command'],
      },
    },
  },
];

// ⚠️ The image tool is appended to the registry rather than declared inline, so
// its schema and its `imageConfig` gate live together in imagegen.mjs — one file
// owns whether the capability exists and what it looks like.
TOOL_SCHEMAS.push(editToolSchema());
TOOL_SCHEMAS.push(deleteToolSchema());
// ⭐ Kills the `node -e` round tax structurally — see evaluate.mjs.
TOOL_SCHEMAS.push(evaluateToolSchema());
TOOL_SCHEMAS.push(...searchToolSchemas());      // find_files · search_code
TOOL_SCHEMAS.push(...gitToolSchemas());
TOOL_SCHEMAS.push(imageToolSchema());
/**
 * ⭐ THE NATIVE MEDIA HALF. Declared always (so the drift guard can see them) but
 * OFFERED only where the endpoint is configured — see toolNamesForRounds.
 *
 * ⚠️ WHAT `see_page` IS NOT. This comment used to claim it was "the one no other
 * terminal agent has: every competitor writes a page and is blind to what it
 * looks like". That is FALSE and was struck from README.md on 2026-08-10 for the
 * same reason: Playwright MCP and Chrome DevTools MCP are free, one install
 * away, and give any MCP-speaking agent a browser.
 *
 * ⭐ THE DEFENSIBLE CLAIM IS THE RETURN VALUE, NOT THE BROWSER. Handing a model
 * the screenshot costs ~3,072 image tokens per look; `see_page` renders the page
 * and returns an ~89-token verdict — 34x less for the thing the next round
 * actually acts on. Anyone can take the photograph; the compression is the
 * product.
 */
TOOL_SCHEMAS.push(...mediaToolSchemas({
  // Declaration is unconditional; the per-turn OFFER is what gates on config.
  RENDER_AUDIT_URL: 'declared', MODAL_TTS_URL: 'declared',
  MODAL_TRANSCRIBE_URL: 'declared', MODAL_PRESS_URL: 'declared',
  // ⭐ The INPUT half — read_document · read_table. Same unconditional
  // declaration for the same reason: the drift guard must not be able to see a
  // different tool list on a machine that happens to have different env.
  MODAL_DOC_READ_URL: 'declared', MODAL_TABLE_READ_URL: 'declared',
}));
/**
 * ⭐ CHANGING a picture rather than re-rolling it — edit_image · expand_image.
 * Declared unconditionally like the rest of the media half; the offer gates on
 * config, and edit_image needs BOTH acuvo-select and acuvo-flux-studio.
 */
TOOL_SCHEMAS.push(...imageEditToolSchemas({
  MODAL_SELECT_URL: 'declared', MODAL_FLUX_URL: 'declared',
}));

/**
 * ── ⭐ THE MODULES THAT WERE BUILT FOR THIS SEAM AND NEVER PLUGGED INTO IT ──
 *
 * Each of these shipped finished, documented and tested, exporting a
 * `*ToolSchemas()` written against this exact registration point — and each was
 * imported by nothing on the runtime path. A capability that no user can reach
 * is not a capability; it is 7,397 lines of very well-commented dead weight.
 *
 * ⚠️ DECLARED UNCONDITIONALLY, EXACTLY LIKE MEDIA, AND FOR THE SAME REASON: the
 * drift guard compares this list against the dispatcher's cases, and a schema
 * that only exists on some machines makes that guard machine-dependent. What
 * varies per machine is the OFFER, decided in `toolNamesForRounds` below.
 */
TOOL_SCHEMAS.push(...planToolSchemas());        // plan_start · plan_step · plan_status
TOOL_SCHEMAS.push(...skillsToolSchemas());      // read_skill
TOOL_SCHEMAS.push(...learnedToolSchemas());     // remember · forget
TOOL_SCHEMAS.push(...subagentToolSchemas());    // delegate
TOOL_SCHEMAS.push(...lspToolSchemas());         // find_definition · find_references · check_types · list_symbols
TOOL_SCHEMAS.push(...sessionToolSchemas());     // list_sessions
TOOL_SCHEMAS.push(...askUserToolSchemas());     // ask_user
TOOL_SCHEMAS.push(...acceptanceToolSchemas());  // declare_acceptance · check_acceptance
TOOL_SCHEMAS.push(...fetchToolSchemas());       // fetch_url
TOOL_SCHEMAS.push(...webSearchToolSchemas());      // web_search
TOOL_SCHEMAS.push(...visionToolSchemas());         // read_image
TOOL_SCHEMAS.push(...readWindowToolSchemas());  // read_lines · read_around
TOOL_SCHEMAS.push(...backgroundToolSchemas());  // start_process · check_process · stop_process
TOOL_SCHEMAS.push(...replToolSchemas());        // repl · repl_reset

/**
 * ── ⚠️⭐ AND THE TENTH ONE, WHICH WAS LEFT OUT AS "A PRODUCT DECISION" ──────
 *
 * `spawn-argv.mjs` (801 lines) was the one tool-shaped orphan that the wiring
 * pass deliberately skipped, on the grounds that `run_program` is a SECOND verb
 * onto process spawning and someone had to decide whether this CLI should have
 * two. Deciding it is this pass's job, and the decision is yes, for two reasons
 * that are measurements rather than preferences.
 *
 * ⭐ IT IS NOT A SECOND DOOR — IT IS THE SAME DOOR WITH THE PARSER REMOVED.
 * `run_command` takes a STRING and must guess, from the string alone, whether a
 * quote is the model composing a second command or the model passing a value.
 * It cannot tell, so it refuses the character — correctly, and that is exactly
 * why the string is the wrong input. `runProgram` takes `program` + `args[]`,
 * spawns with `shell: false`, and asks `command.mjs` about every pre-boundary
 * flag rather than keeping a second copy of the flag lists. Same
 * `ALLOWED_BINARIES` (node · npm · npx · tsc), same `buildInvocation`, same
 * `spawnBounded`, same `scrubEnvironment` — plus it additionally deletes
 * `NODE_OPTIONS` and `NODE_TEST_CONTEXT`, which `run_command` does not.
 *
 * ⚠️ AND IT IS A STRICT SUBSET OF THE ALLOWLIST, NEVER A WIDENING.
 * `.acuvo/commands.json` may only ADD presets (`parseCommandsConfig` refuses
 * anything else), so the four fixed binaries here can never exceed what
 * `run_command` would have permitted on the same machine. The one real
 * asymmetry is the other way: a user who enabled the `python` preset reaches it
 * through `run_command` only, and that is stated in the README.
 *
 * ⚠️ WHAT ITS ABSENCE COST, from spawn-argv.mjs's own measured header: three
 * probe runs hit the string wall and two SHIPPED A WRONG ARTIFACT because of
 * it — `node bin/todo.js add "buy milk"`, `node bin/todo.js list --all` and
 * `node --test test/*.test.mjs` were all refused, so the agent could never
 * execute the code paths it had just written and documented what it imagined
 * the output was instead. That is the single most expensive failure this
 * package has, and the fix was sitting in the tree unimported.
 */
TOOL_SCHEMAS.push(...spawnArgvToolSchemas());   // run_program

export const TOOL_NAMES = TOOL_SCHEMAS.map((t) => t.function.name);

/**
 * ── ⚠️ WHAT A SINGLE-SHOT TURN IS ALLOWED TO OFFER THE MODEL ───────────────
 *
 * MEASURED, three live runs against `deepseek/deepseek-v3.2`, 2026-08-09, all
 * three tools declared and the system prompt explicitly saying reads cannot
 * reach it this turn:
 *
 *   run 1  "let me check the version.js file"        → 1 read_file, 0 writes
 *   run 2  (contents now pre-loaded)                  → 1 write_file  ✓
 *   run 3  "let me check the directory structure"     → 1 list_dir, 0 writes
 *
 * Two of three turns were spent fetching context the CLI had ALREADY put in the
 * prompt. That is not a prompt-wording problem — coder models are trained on
 * agentic loops and reach for the tools they can see, and no amount of shouting
 * in a system prompt outranks a tool definition sitting in the payload.
 *
 * ⭐ AND THE DEEPER POINT IS THIS REPO'S OWN RULE: a control that presents
 * itself and does nothing is worse than one that is absent. In a turn with no
 * second round, a `read_file` result has nowhere to go — so declaring it is a
 * DEAD BUTTON, and the model pressing it is the predictable consequence rather
 * than a surprise.
 *
 * ⚠️ THE CAPABILITY IS NOT REMOVED, ONLY THE OFFER. `read_file` and `list_dir`
 * are implemented, dispatched, tested, and used every single run — the CLI's own
 * `gatherWorkspaceContext` reads the tree and the small files THROUGH THIS SAME
 * EXECUTOR before the model is asked anything. What changes here is who gets to
 * call them: the deterministic gather, not the model. When the multi-round turn
 * lands, it passes `TOOL_SCHEMAS` instead of this and the reads become live in
 * one line.
 */
export const SINGLE_SHOT_TOOL_NAMES = ['write_file'];

/**
 * ── ⭐ AND WHAT A MULTI-ROUND SESSION OFFERS — THE SAME RULE, INVERTED ──────
 *
 * The note above says a read tool is a DEAD BUTTON when its result has nowhere
 * to go. The corollary is that the moment a second round exists, the button is
 * live and withholding it is the defect: the loop's whole premise is that the
 * model sees what happened and reacts, and "what happened" includes the file it
 * needed that was too large for the deterministic gather.
 *
 * So the offer is not a fixed list, it is a FUNCTION OF THE ROUND BUDGET. One
 * round → write only. More than one → everything, because everything can now
 * come back. `run_command` is the reason the loop exists at all and is the one
 * entry here that can execute code; `--no-run` withholds it without collapsing
 * the loop, which is the honest middle setting for a task you have not read yet.
 */
/**
 * ── ⚠️ GATE ON AVAILABILITY, NOT ON PRESENCE ────────────────────────────────
 *
 * `imageConfig(env).configured` is the precedent and it is a good one: the file
 * that owns a capability owns the question "does it exist here", and the offer
 * asks it rather than assuming. These two do the same for the two capabilities
 * whose dependency lives OUTSIDE this package — a directory the user wrote, and
 * a language server someone installed.
 *
 * ⚠️ NEVER THROWS, BY CONSTRUCTION AND THEN AGAIN BY CATCH. Both callees
 * document that they never throw ("not installed" is the expected answer). The
 * try/catch is not distrust of them, it is the rule that computing the OFFER can
 * never be what kills a run: an unreadable directory on a locked-down machine
 * must cost the user one tool, not the whole session.
 */
export function skillsAvailable(root) {
  if (typeof root !== 'string' || root === '' || root === MEMORY_ROOT) return false;
  try {
    const found = discoverSkills(root);
    return found.ok === true && found.skills.length > 0;
  } catch {
    return false;
  }
}

/**
 * ── ⚠️⚠️ AN INSTALLED SERVER IS NOT ENOUGH. THE PROJECT HAS TO SPEAK IT. ─────
 *
 * The first version of this gate asked one question — is ANY language server
 * installed — and it shipped the exact dead button it was written to prevent.
 * MEASURED ON THIS MACHINE, 2026-08-11, integrating the four lanes: this
 * package is zero-dependency JavaScript, `typescript-language-server` is not
 * installed, and `find_definition` / `find_references` / `check_types` /
 * `list_symbols` were all offered anyway — because `rust-analyzer` happens to
 * sit in `~/.cargo/bin` from unrelated work. Every one of those tools, called
 * on any file in this repo, can only answer "typescript-language-server is not
 * installed". Four buttons, none of them wired to anything reachable.
 *
 * ⭐ THE GATE IS THE INTERSECTION: a server that is installed AND a language
 * this workspace actually contains. Both halves are necessary and neither is
 * sufficient — a Rust repo on a machine with only pyright is the same dead
 * button seen from the other side.
 *
 * ⚠️ AND IT IS STILL "ANY MATCH", NOT "EVERY MATCH". A polyglot repo with Go
 * and TypeScript and only `gopls` installed keeps the four tools, because they
 * are per-FILE and `.go` files are genuinely served. Withholding a working
 * capability because a SECOND language is unserved would be the opposite error,
 * and the not-installed path returns lsp.mjs's own install instruction, which
 * is a good answer to get for the one file that cannot be served.
 *
 * Pure `existsSync` / PATH probing plus at most two shallow `readdir`s. No
 * process is spawned, and nothing recurses into the tree.
 */
export function lspAvailable(root, env = process.env) {
  if (typeof root !== 'string' || root === '' || root === MEMORY_ROOT) return false;
  try {
    const present = languagesPresent(root);
    if (present.size === 0) return false;
    for (const language of Object.keys(LANGUAGE_SERVERS)) {
      if (!present.has(language)) continue;
      if (discoverLanguageServer(root, language, { env }).ok === true) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Which of the four languages this workspace visibly contains.
 *
 * ⚠️ CHEAP BY CONSTRUCTION, because it runs on the offer path of every
 * multi-round session. One `readdir` of the root, plus one of each of up to
 * `LANG_PROBE_DIRS` first-level directories. It never recurses, never reads a
 * file, and never spawns anything — a project whose only Python lives four
 * levels down is a MISS, and a miss costs four tools rather than correctness.
 *
 * ⭐ TWO SIGNALS, BOTH CHEAP AND EITHER SUFFICES. A manifest (`Cargo.toml`,
 * `go.mod`, `package.json`, `pyproject.toml`) is the strong one and catches the
 * monorepo whose source is all in `crates/` or `src/`. An extension seen in the
 * shallow walk is the weak one and catches the script folder with no manifest
 * at all. Requiring both would fail the common cases in opposite directions.
 */
const LANG_PROBE_DIRS = 12;
const LANG_PROBE_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.next', 'coverage', '__pycache__']);
const LANG_MANIFESTS = {
  typescript: ['package.json', 'tsconfig.json', 'jsconfig.json', 'deno.json'],
  python: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'],
  rust: ['Cargo.toml'],
  go: ['go.mod', 'go.work'],
};
/** extension → language, built from the registry so the two can never disagree. */
const LANG_BY_EXTENSION = (() => {
  const map = new Map();
  for (const [language, spec] of Object.entries(LANGUAGE_SERVERS)) {
    for (const ext of Object.keys(spec.extensions ?? {})) map.set(ext.toLowerCase(), language);
  }
  return map;
})();

export function languagesPresent(root) {
  const found = new Set();
  const note = (name) => {
    for (const [language, manifests] of Object.entries(LANG_MANIFESTS)) {
      if (manifests.includes(name)) found.add(language);
    }
    const dot = name.lastIndexOf('.');
    if (dot > 0) {
      const language = LANG_BY_EXTENSION.get(name.slice(dot).toLowerCase());
      if (language) found.add(language);
    }
  };

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  const dirs = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && !LANG_PROBE_SKIP.has(e.name) && dirs.length < LANG_PROBE_DIRS) dirs.push(e.name);
      continue;
    }
    note(e.name);
  }
  for (const dir of dirs) {
    // A manifest one level down counts too: `packages/api/package.json` and
    // `crates/core/Cargo.toml` are how real repositories are shaped.
    let children;
    try {
      children = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const c of children) {
      if (!c.isDirectory()) note(c.name);
    }
  }
  return found;
}

/**
 * @param {number} maxRounds
 * @param {{ allowRun?: boolean, env?: Record<string, any>, root?: string }} [opts]
 *
 * ⚠️ `root` DEFAULTS TO `process.cwd()` AND THAT IS A KNOWN SEAM, not a
 * preference. `bin/acuvo.mjs` computes `resolve(opts.dir ?? process.cwd())`, so
 * for every run without `--dir` the default is exactly right; with `--dir` it
 * probes the wrong tree until `turn.mjs` passes `root: executor.root` (one word,
 * another lane's file). The failure it can produce is small and one-directional
 * — `read_skill` offered in a `--dir` run because the CURRENT directory has
 * skills — and it is stated here rather than left to be discovered.
 */
export function toolNamesForRounds(maxRounds, { allowRun = true, env = process.env, root = process.cwd(), subagent = false, interactive = false } = {}) {
  /**
   * ── ⭐ `generate_image` IS OFFERED IN BOTH SHAPES, AND ONLY WHEN IT EXISTS ──
   * It is available even in a single-shot run — "build me a landing page with a
   * hero image" is a complete, one-round request and withholding the image would
   * make the answer worse for no reason. It writes a file, so unlike a read tool
   * its result has somewhere to go even with no second round.
   *
   * ⚠️ IT IS NOT "the one capability no other coding agent has" — that claim
   * stood here until 2026-08-11 and it was never true. An MCP-speaking agent is
   * one `npx` away from an image server, the same way it is one away from a
   * browser. What is ours is that it needs NO key, NO account and NO config
   * (see the default below), and that the result lands as a file in the
   * workspace rather than as a URL the model has to describe.
   *
   * ⚠️ GATED ON THE SERVICE BEING CONFIGURED — but read what "configured" means
   * before trusting this comment, because its previous version was FALSE and the
   * README repeated the falsehood.
   *
   * `imageConfig` defaults to an XXIautomate-hosted endpoint when the variable is
   * UNSET, so on a bare machine `configured` is TRUE and the tool IS offered.
   * That is deliberate — a capability you must discover and configure is one most
   * people never see — but it means every installed copy can send a prompt to our
   * infrastructure, which is a disclosure obligation and not an implementation
   * detail. It is now stated outright in README.md under "generate_image is
   * different".
   *
   * ⭐ The gate that still bites: `PERCHANCE_IMAGE_URL=` (explicitly empty) means
   * OFF, and then the model is never told the capability exists — because
   * offering a tool that can only return "no image service is set up" teaches it
   * to try, wait, and apologise, which is a dead button by another name.
   */
  const withImage = (names) => (imageConfig(env).configured ? [...names, 'generate_image'] : names);

  if (maxRounds <= 1) return withImage([...SINGLE_SHOT_TOOL_NAMES]);
  /**
   * ⭐ SEARCH IS IN THE MULTI-ROUND OFFER AND NOT THE SINGLE-SHOT ONE, for the
   * same reason the read tools are not: a search result has nowhere to go when
   * the turn ends immediately after it. With a second round it becomes the most
   * valuable tool here — it is what turns "writes files" into "works in your
   * codebase", because a model that cannot find a function will invent a
   * plausible file and write over the wrong one.
   */
  /**
   * ⭐ `edit_file` sits beside write_file, and the ORDER here is a hint the model
   * reads: edit before write, because for a file that already exists write_file
   * is a destructive operation wearing the costume of an edit.
   */
  /**
   * ⭐ `delete_file` IS HERE BECAUSE ITS ABSENCE CAPTURED A WHOLE SESSION.
   * Measured 2026-08-09: with no delete verb the model wrote 0 bytes over its
   * scratch file, then spent every remaining round trying to remove it and
   * never reached the commit it had been asked for. See delete.mjs.
   */
  const names = ['read_file', 'write_file', 'edit_file', 'delete_file', 'list_dir', 'find_files', 'search_text'];
  /**
   * ⭐ `run_program` SITS IMMEDIATELY AFTER `run_command`, AND THE ORDER IS THE
   * HINT — the same reason `edit_file` sits before `write_file`. A model reading
   * the offer top-down meets the string runner first (right for `npm test`) and
   * the argv runner second (right the moment an argument has a space, a quote or
   * a leading dash). Both are gated on `allowRun`: it spawns a process, so
   * `--no-run` must withhold it or the flag is a lie by a side door.
   */
  if (allowRun) names.push('run_command', 'run_program', 'evaluate');
  /**
   * ── ⭐⭐ BACKGROUND — MULTI-ROUND ONLY, AND GATED ON `allowRun` ────────────
   *
   * Multi-round because the whole shape is "start it now, look at it later": in
   * a single-shot turn there is no later, and a server started in the last
   * round of a run is killed by the teardown before anything can use it — the
   * dead button this file refuses to ship, in its most expensive form.
   *
   * ⚠️ And it spawns a process, so `--no-run` must withhold it or the flag is a
   * lie by a side door — the same rule `run_program` and `evaluate` obey.
   */
  if (allowRun) names.push(...BACKGROUND_TOOL_NAMES);
  /**
   * ── ⭐⭐ THE REPL — MULTI-ROUND ONLY, AND OBVIOUSLY SO ─────────────────────
   *
   * Its whole value is that call N+1 sees what call N defined. In a single-shot
   * turn there is no call N+1, so it is the dead button this file refuses to
   * ship — and worse than most, because it would spend the only round starting a
   * process instead of doing the task.
   *
   * ⚠️ `allowRun` because it executes the user's JavaScript for real.
   */
  if (allowRun) names.push(...REPL_TOOL_NAMES);
  /**
   * ── ⭐ GIT IS MULTI-ROUND ONLY, AND `git_commit` IS GATED ON `allowRun` ─────
   *
   * `git_status` and `git_diff` are reads: their result has nowhere to go in a
   * single-shot turn, so offering them there would be the dead button this file
   * already refuses to ship. With a second round they are the most valuable
   * reads here — a diff is how the model checks its own edit landed, which is
   * the one verification it currently cannot perform without running code.
   *
   * ⚠️ AND COMMIT RIDES WITH `--no-run`, WHICH IS NOT AN OBVIOUS PAIRING. The
   * flag reads as "do not execute anything", and a user who passes it is saying
   * they have not read the task yet. A commit is not code execution, but it IS
   * the one irreversible-looking thing in the package — a wrong commit is
   * recoverable and does not feel it. So the cautious flag withholds the
   * cautious verb, and reading the repo stays available either way.
   */
  // ⭐ Media joins the multi-round offer, gated on real configuration. A tool
  // whose service is absent is never mentioned — the model must not spend a
  // round discovering what the schema could have told it for free.
  names.push(...mediaToolNames(env));
  // ⚠️ MULTI-ROUND ONLY, and not for the usual "a read has nowhere to go"
  // reason: an edit is a 3-second-to-6-minute GPU job whose whole point is that
  // the model then LOOKS at the result. Offering it on a single-shot turn buys
  // the render and throws away the check.
  names.push(...imageEditToolNames(env));
  names.push('git_status', 'git_diff', 'git_log');
  if (allowRun) names.push('git_commit');

  /**
   * ── ⭐ THE WINDOWED READS — MULTI-ROUND ONLY, LIKE EVERY OTHER READ ────────
   * `read_lines` and `read_around` are `read_file` with an honest truncation
   * story: read_file cuts the MIDDLE out of a large file and says nothing the
   * model can act on, these cut the END and hand back `nextOffset`. Same
   * dead-button rule as read_file, so the same placement — a window of a file
   * has nowhere to go when the turn ends immediately after it.
   */
  names.push('read_lines', 'read_around');

  /**
   * ── ⭐ THE PLAN LEDGER — MULTI-ROUND ONLY, AND OBVIOUSLY SO ────────────────
   * Its entire value is the banner on every LATER tool result: "2/5 done, 3
   * rounds left". With one round there is no later, so `plan_start` in a
   * single-shot turn is a file written for a reader who never arrives — the
   * dead button in its purest form.
   */
  names.push('plan_start', 'plan_step', 'plan_status');

  /**
   * ── ⭐ SESSIONS — READ-ONLY, MULTI-ROUND ONLY ─────────────────────────────
   * `list_sessions` cannot resume anything (resume is an operator action, from
   * the command line, between runs — see session.mjs's header on replayed side
   * effects). It is a read, and reads need a next round.
   */
  names.push('list_sessions');

  /**
   * ── ⭐ FETCH — MULTI-ROUND ONLY ───────────────────────────────────────────
   * A page of documentation is context for the NEXT decision. Fetched in a turn
   * with no next decision it is a paid round that changes nothing.
   * Not gated on configuration because there is none: GET only, no headers,
   * private and loopback addresses refused, 10 fetches per run. It either
   * reaches the internet or returns a sentence saying it could not.
   */
  names.push('fetch_url');

  /**
   * ── ⭐⭐ SEARCH — MULTI-ROUND ONLY, FOR THE SAME REASON ────────────────────
   *
   * `fetch_url` could read a page it was TOLD about; it could not FIND one. A
   * search result is not an answer, it is a pointer to the round that reads it,
   * so in a single-round turn it is a paid call that changes nothing.
   *
   * ⭐ AND IT IS THE HALF THAT STOPS THE GUESSING. A model that cannot look up
   * an option name invents one, confidently, and the invention compiles.
   * Keyless: DuckDuckGo plus the StackOverflow API, capped per run.
   */
  names.push('web_search');

  /**
   * ── ⭐⭐ EYES — MULTI-ROUND ONLY, AND FOR A SHARPER REASON THAN THE OTHERS ──
   *
   * Looking is only worth paying for if there is a round left to ACT on what
   * was seen. A single-round turn that renders something, looks at it, and then
   * stops has bought a description nobody can use.
   */
  names.push('read_image');

  /**
   * ── ⚠️ ACCEPTANCE RIDES WITH `allowRun`, AND BOTH VERBS TOGETHER ──────────
   *
   * `check_acceptance` EXECUTES COMMANDS — it takes a runner and runs every
   * declared criterion. Offering it under `--no-run` would make that flag a lie
   * by a side door, exactly as `evaluate` would (see the test that pins it).
   *
   * ⭐ And `declare_acceptance` goes with it rather than staying behind. Alone
   * it is a promise nothing can keep: the model records "npm test must pass",
   * no round can ever run it, and the run ends having declared a criterion it
   * never checked — which reads as verification and is not. Two halves of one
   * capability; neither is worth offering without the other.
   */
  if (allowRun) names.push('declare_acceptance', 'check_acceptance');

  /**
   * ── ⭐ SKILLS — GATED ON THE DIRECTORY EXISTING AND HAVING SOMETHING IN IT ─
   * skills.mjs states the rule itself: "a read_skill in a project with no skills
   * is a dead button". Most projects have none, so this is the common case and
   * the tool is usually absent — correctly. There is no `list_skills` because
   * the catalogue belongs in the system prompt (turn.mjs's job, not this file's).
   */
  if (skillsAvailable(root)) names.push('read_skill');

  /**
   * ── ⭐⭐ ASK_USER — OFFERED ONLY WHEN THERE IS SOMEBODY TO ASK ─────────────
   *
   * ⚠️ ABSENCE, NOT REFUSAL. `prompt.mjs`'s `createAsker` returns null unless
   * stdin and stdout are BOTH terminals, and that null arrives here as
   * `interactive: false`. In CI, a pipe or a task runner the tool is simply not
   * in the list — which is stronger than a tool that is offered and always
   * refuses, because a schema costs tokens every single round and invites the
   * model to spend one discovering the button is dead. Same rule the file
   * already applies to `read_skill` in a project with no skills.
   *
   * ⚠️ MULTI-ROUND ONLY, for this file's standing reason: in a single-shot turn
   * the answer arrives as a tool result with nowhere to go, and the round it
   * costs would be the only round there was. An agent that spends its one round
   * asking a question it can no longer act on is strictly worse than one that
   * guessed.
   */
  if (interactive) names.push('ask_user');

  /**
   * ── ⭐ REMEMBER / FORGET — ALWAYS OFFERED IN A MULTI-ROUND TURN ────────────
   *
   * Unlike `read_skill` there is nothing to gate on: an empty memory is the
   * NORMAL starting state and the whole point is that the agent fills it. A
   * project with no learned facts is exactly where remembering the first one
   * matters most.
   *
   * ⚠️ MULTI-ROUND ONLY, for this file's standing reason. In a single-shot turn
   * the run ends before anything could act on what was recorded, so `remember`
   * would be a button whose result has nowhere to go — and worse, it would spend
   * the one round on bookkeeping instead of the task.
   *
   * ⚠️ `forget` RIDES WITH IT and is not optional. A wrong memory is worse than
   * no memory, and shipping the write verb without the correction verb means the
   * only way to fix a bad fact is to edit a file by hand.
   */
  names.push('remember', 'forget');

  /**
   * ── ⭐ DELEGATE — MULTI-ROUND ONLY, AND NEVER TO A SUBAGENT ────────────────
   *
   * ⚠️ A helper's answer arrives as a tool result, so in a single-round turn it
   * has nowhere to go — the dead button this file refuses to ship. And the
   * round it costs would be the only round there was.
   *
   * ⚠️ `subagent: true` REMOVES IT ENTIRELY. `SUBAGENT_TOOL_NAMES` already omits
   * it, so this is the second lock rather than the only one: the offer a
   * subagent computes and the list it is handed must agree, or a future refactor
   * that starts calling this function for helpers quietly reopens recursion.
   */
  if (!subagent) names.push('delegate');

  /**
   * ── ⭐ LSP — GATED ON A LANGUAGE SERVER BEING INSTALLED ───────────────────
   * On a machine with no server these four tools can only ever return "install
   * it with npm i -D …", which teaches the model to try, wait and apologise.
   * `lspAvailable` probes PATH and node_modules; it spawns nothing.
   */
  /**
   * ── ⭐⭐ TWO WAYS TO SERVE THE SAME FOUR TOOLS ──────────────────────────────
   *
   * `lspAvailable` needs `typescript-language-server`, a package almost nobody
   * installs — measured false on a real Next.js app AND a real API server, so
   * these four shipped dark on every machine including the author's.
   *
   * ⭐ `tsserverAvailable` needs only `typescript`, which every TypeScript
   * project already has because it is what compiles the project. It answers for
   * TS and JS; a real language server still wins when present because it also
   * covers Python, Rust and Go. Either way the model sees the same four tools
   * returning the same shapes and never learns which one answered.
   */
  if (lspAvailable(root, env) || tsserverAvailable(root)) names.push(...LSP_TOOL_NAMES);

  return withImage(names);
}

/** The subset of the registry to put in a request payload. */
/**
 * ⚠️⭐ THE DESCRIPTION HAS TO TELL THE TRUTH ABOUT THE MODE IT IS RUNNING IN.
 * `run_command`'s static text says "There is NO SHELL: pipes, &&, ; … are
 * refused". Left unchanged under `--shell` that is a LIE THAT DISABLES THE
 * FEATURE: the model reads it, believes pipes are impossible, and never tries —
 * so the flag the operator deliberately turned on does nothing, and the failure
 * is invisible because nothing errors. A capability the model is told it does
 * not have is a capability it does not have.
 */
const SHELL_RUN_DESCRIPTION = [
  'Run a command in the workspace through a real shell and get its exit code, stdout and stderr back.',
  'This is how you VERIFY what you wrote — a non-zero exit code is the fact you fix in the next round.',
  'A SHELL IS AVAILABLE in this run: pipes, &&, ||, ;, quoting, redirection and $(...) all work,',
  'and you may run any program installed on this machine (python, go, cargo, git, curl, make, …).',
  'The working directory is the workspace root.',
  'Prefer one command per call so a failure names itself; chain only when the steps are genuinely one step.',
].join(' ');

export function toolSchemasFor(names, { shell = false } = {}) {
  const wanted = new Set(names);
  const picked = TOOL_SCHEMAS.filter((t) => wanted.has(t.function.name));
  if (!shell) return picked;
  return picked.map((t) => (t.function.name === 'run_command'
    ? { ...t, function: { ...t.function, description: SHELL_RUN_DESCRIPTION } }
    : t));
}

/**
 * Tool arguments arrive as a STRING of JSON that a model wrote, so malformed
 * JSON is a normal Tuesday rather than an exceptional condition. Parsing it in
 * one guarded place means no handler has to think about it.
 *
 * Pure, and separately tested — this is the function that decides whether a
 * fumbled argument blob crashes the CLI or produces a sentence the model could
 * have acted on if there were a next round.
 */
export function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, args: {} };
  if (typeof raw === 'object') return { ok: true, args: raw };
  if (typeof raw !== 'string') return { ok: false, error: 'tool arguments were neither a string nor an object' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `tool arguments were not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'tool arguments must be a JSON object' };
  }
  return { ok: true, args: parsed };
}

/**
 * Run one tool call against a local executor.
 *
 * Returns `{ id, name, args, result, mutated }`. `mutated` is what the summary
 * counts — it is set by the DISPATCHER rather than inferred from the tool name
 * downstream, so a future tool that also touches disk cannot be missed by a
 * summary that only knows the string 'write_file'.
 *
 * ⚠️ ASYNC AS OF `run_command`, AND ALL OF IT RATHER THAN HALF. Three of these
 * handlers are synchronous and one cannot be, and the tempting shape — a sync
 * dispatcher plus a separate async path for the one tool — is how a registry
 * grows two front doors and then two sets of rules. One dispatcher, one
 * contract, `await` at the single call site.
 *
 * ⚠️ `round` IS OPTIONAL AND ITS ABSENCE IS SAFE. The plan ledger prints a
 * countdown ("· round 3 of 8") when it is told where in the budget it is, and
 * omits the clause entirely when it is not — plan-ledger.mjs says outright that
 * a WRONG countdown is worse than no countdown, so the degradation is the
 * designed one. `turn.mjs` passing `{ round: { roundIndex: round, maxRounds } }`
 * turns it on; nothing breaks until it does.
 *
 * ⚠️ `allowRun` DEFAULTS TO TRUE so today's callers are byte-identical. Passing
 * `false` refuses `check_acceptance` at the DISPATCHER, not just at the offer —
 * a model can emit a call for a tool it was never shown, and that one executes
 * commands.
 *
 * ⚠️ AND `id` IS CARRIED THROUGH, which is not bookkeeping: a multi-round turn
 * has to send each result back as a `tool` message keyed by the id the model
 * gave the call, and a mismatched or missing id makes the whole conversation
 * rejected by the provider rather than merely confused.
 */
export async function executeToolCall(call, executor, {
  commandTimeoutMs,
  round = null,
  allowRun = true,
  /**
   * ⚠️ `delegate` IS THE FIRST TOOL THAT NEEDS TO CALL A MODEL ITSELF, so the
   * dispatcher needs the credentials the turn loop already holds. Optional and
   * defaulted, so every existing call site is byte-identical in behaviour — the
   * tool simply refuses when nobody passed it, which is the honest failure.
   *
   * `depth` is how a subagent knows it is one: the turn loop passes 0, and a
   * subagent's own dispatcher is handed 1, which `runSubagent` refuses.
   */
  config = null,
  depth = 0,
  /**
   * ⚠️ DEFAULTS TO FALSE, so every existing call site keeps the locked
   * allowlist unchanged. A capability this large must be reachable only by a
   * caller that NAMES it — never by one that merely forgot to pass a flag.
   */
  shell = false,
  /**
   * ⚠️ THE BUDGETED ASKER, OR NULL. The per-run allowance lives in
   * `ask-user.mjs`'s closure and is created ONCE by the turn loop, because this
   * dispatcher is a pure switch over a single call and has no memory of the
   * round before it. Threading a counter through every tool in this file for
   * the sake of one would be the wrong trade; the turn loop already owns
   * per-run state.
   */
  ask = null,
} = {}) {
  const name = call?.function?.name;
  const id = call?.id ?? null;
  const parsed = parseToolArguments(call?.function?.arguments);
  if (!parsed.ok) return { id, name, args: {}, result: { ok: false, error: parsed.error }, mutated: false };
  const args = parsed.args;

  switch (name) {
    case 'read_file': {
      /**
       * ── ⚠️⚠️ THE FOURTH PATH TO THIS FILE, AND THE ONLY UNHARDENED ONE ────
       *
       * `turn.mjs`'s automatic pre-load, `search.mjs`, `repo-map.mjs` and
       * `session.mjs` all refuse credential files using this same shared list.
       * The model-driven read used none of it. Probed 2026-08-13: `.env`,
       * `.env.local`, `id_rsa`, `server.pem`, `.npmrc`, `credentials.yml` and
       * `secrets.json` all came back in full, while `search_text` for the same
       * canary correctly matched only the source file — so search had been
       * fixed and read had not.
       *
       * ⚠️ A TOOL RESULT GOES STRAIGHT INTO THE PROMPT, which goes to a
       * third-party provider. `turn.mjs:112` calls this class "THE WORST BUG
       * THIS PACKAGE HAS HAD" — and fixed it in exactly one of the four places
       * it lives.
       *
       * ⭐ THE GUARD IS HERE, ON THE MODEL'S DOOR, NOT IN THE EXECUTOR. Learned
       * an hour earlier on the `.acuvo/` guard: a model-facing refusal pushed
       * down into shared plumbing broke seven tests of legitimate internal work.
       * `--doctor` still needs to see whether a `.env` exists.
       */
      const credential = refusedCommitPath(String(args.path ?? ''));
      if (credential) {
        return {
          id,
          name,
          args,
          result: {
            ok: false,
            error: `${args.path} looks like a credential file, so it is not read into the conversation — `
              + 'anything returned here becomes part of the prompt sent to the model provider. If you need a '
              + 'value from it, ask the owner to paste just that value, or tell them which key you need and why.',
          },
          mutated: false,
        };
      }
      return { id, name, args, result: executor.readFile(args.path), mutated: false };
    }
    case 'write_file': {
      const result = executor.writeFile(args.path, args.content);
      return { id, name, args, result, mutated: result.ok === true };
    }
    case 'list_dir':
      return { id, name, args, result: executor.listDir(args.path ?? '.'), mutated: false };
    case 'edit_file': {
      // ⭐ Through the EXECUTOR, not through fs — this is the line that lets the
      // browser builder run the same loop the CLI does.
      const result = editThroughExecutor(executor, args.path, args.old_string, args.new_string);
      return { id, name, args, result, mutated: result.ok === true };
    }
    case 'delete_file': {
      const result = executor.deleteFile(args.path);
      return { id, name, args, result, mutated: result.ok === true };
    }
    case 'find_files':
      return { id, name, args, result: findFiles(executor.root, args.pattern, { offset: args.offset }), mutated: false };
    case 'search_text':
      return { id, name, args, result: searchText(executor.root, args.pattern, { glob: args.glob, offset: args.offset }), mutated: false };
    case 'see_page': {
      const result = await designPass(executor.root, args.path, { dryRun: executor.dryRun });
      /**
       * ⚠️ mutated: it writes a screenshot into .acuvo/ — the summary must own up
       * to every file that appears on disk, including ones the user did not ask for.
       *
       * ⚠️⚠️ BUT `result.path` IS THE PAGE IT READ, NOT THE FILE IT WROTE, and
       * every consumer of a mutating record reads `result.path`. Observed live:
       * looking at `index.html` printed `replaced index.html (0 bytes)` — a
       * report that the agent had BLANKED the user's file, when all it did was
       * take a photograph of it. `parallel.mjs` reads the same field, so two
       * tasks that merely looked at one page would be reported as colliding
       * over it.
       *
       * ⭐ So the written path is stated explicitly. This is the same lesson
       * `delete_file` taught: a new tool whose result shape differs from
       * `write_file`'s breaks every downstream reader that assumed one shape.
       */
      return {
        id, name, args, result,
        mutated: result.ok === true && Boolean(result.screenshot),
        mutatedPath: result.screenshot ?? null,
      };
    }
    case 'speak': {
      const result = await speak(executor.root, args.text, args.path, { dryRun: executor.dryRun });
      return { id, name, args, result, mutated: result.ok === true };
    }
    case 'transcribe': {
      const result = await transcribe(executor.root, args.path, { dryRun: executor.dryRun });
      return { id, name, args, result, mutated: false };
    }
    case 'make_document': {
      const result = await makeDocument(executor.root, args.path, args.out, args.format, { dryRun: executor.dryRun });
      return { id, name, args, result, mutated: result.ok === true };
    }
    /**
     * ⚠️ BOTH READERS ARE `mutated: false`. They write nothing — and the "N files
     * written" line is the one honest number in the summary, so a read that
     * inflates it turns the summary into an estimate. Same rule `evaluate`
     * already follows for its temp file.
     */
    case 'read_document': {
      const result = await readDocument(executor.root, args.path, {
        ocr: args.ocr, fromPage: args.from_page, maxPages: args.max_pages,
      });
      return { id, name, args, result, mutated: false };
    }
    case 'read_table': {
      const result = await readTable(executor.root, args.path, { page: args.page });
      return { id, name, args, result, mutated: false };
    }
    /**
     * ⚠️ `mutated: true`, and `mutatedPath` is the NEW file. Both of these write
     * an image the run must account for — and neither touches its source, so
     * reporting `args.path` here would say the original changed when it did not.
     * That is the exact bug `see_page` shipped: "replaced index.html (0 bytes)"
     * for a tool that only took a photograph of it.
     */
    case 'edit_image': {
      const result = await editImage(executor.root, args.path, args.target, args.replacement, {
        dryRun: executor.dryRun, out: args.out,
      });
      return { id, name, args, result, mutated: result.ok === true, mutatedPath: result.path ?? null };
    }
    case 'expand_image': {
      const result = await expandImage(executor.root, args.path, args.aspect, {
        dryRun: executor.dryRun, out: args.out, prompt: args.prompt,
      });
      return { id, name, args, result, mutated: result.ok === true, mutatedPath: result.path ?? null };
    }
    case 'generate_image': {
      /**
       * ⚠️ `mutated: true` — this DOES write a file into the workspace, unlike
       * run_command. The summary's "N files written" must count it, or a user
       * gets an image on disk that the run never mentioned.
       */
      const result = await generateImage({
        prompt: args.prompt, width: args.width, height: args.height, executor,
      });
      return { id, name, args, result, mutated: result.ok === true };
    }
    case 'evaluate': {
      const result = await evaluateSnippet({ executor, source: args.source, timeoutMs: commandTimeoutMs });
      /**
       * ⚠️ `mutated: false`. It writes a temp file and deletes it again, so no
       * file the user cares about changed — counting it would put a phantom
       * entry in the "files written" line, which is the one honest number in
       * the summary.
       */
      return { id, name, args, result, mutated: false };
    }
    case 'run_command': {
      /**
        * ⭐ AN EXECUTOR MAY OWN ITS OWN RUNNER. The CLI does not — it uses the
        * allowlisted local spawner below, which is the thing `command.mjs`
        * exists to keep safe. The browser builder DOES: its files never touch a
        * server disk, so "run" means shipping the map to the Modal sandbox.
        * Same tool, same loop, two very different executions.
        */
      const result = typeof executor.runCommand === 'function'
        ? await executor.runCommand(args.command)
        : await executeRunCommand({ command: args.command, executor, timeoutMs: commandTimeoutMs, shell });
      /**
       * ⚠️ `mutated: false` EVEN THOUGH A COMMAND CAN WRITE FILES. `mutated`
       * feeds the "N files written" line, and that line names paths the
       * EXECUTOR wrote — a build's output is real but unattributable, and
       * inventing a count for it would make the one honest number in the
       * summary an estimate. What the command did is reported separately, in
       * full, as its own output.
       */
      return { id, name, args, result, mutated: false };
    }

    /**
     * ── ⭐⭐ `run_program` — THE SAME SPAWN, WITH A REAL ARGV ─────────────────
     *
     * Three guards before anything is spawned, and each one exists because the
     * module cannot check it itself: `runProgram` takes a `root` string, not an
     * executor, so `dryRun`, the memory sentinel and `allowRun` are facts only
     * this dispatcher holds.
     *
     * ⚠️ THE DRY-RUN SENTENCE IS `executeRunCommand`'s, deliberately reworded
     * only where it must be. `--dry-run` promises the disk is untouched and a
     * program is free to write to it; the promise can only be kept by refusing
     * here, and refusing with a DIFFERENT explanation for the same flag would
     * teach the model that the two runners have two policies.
     *
     * ⚠️ `allowRun` IS ENFORCED AT THE DISPATCHER as well as at the offer — the
     * `check_acceptance` argument, one tool over: a model can emit a call for a
     * tool it was never shown (a resumed session, a stale conversation, a
     * provider echoing an old tool list), and the flag has to hold at the point
     * the process would actually start.
     *
     * ⚠️ THE MEMORY EXECUTOR IS REFUSED RATHER THAN ROUTED TO ITS OWN RUNNER.
     * `run_command` hands a STRING to `executor.runCommand`, and that is the
     * whole contract the browser builder's Modal sandbox implements — there is
     * no argv-shaped entry point on the other side. Silently joining the array
     * back into a string here would re-introduce the exact quoting ambiguity
     * this tool exists to remove, and it would do it invisibly. So the refusal
     * names the alternative, like every other memory guard in this file.
     */
    case 'run_program': {
      if (allowRun === false) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this run was started with --no-run, so no program is executed. Report what you changed and say plainly that nothing was verified.' },
        };
      }
      if (executor.dryRun) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this is a --dry-run, so no program is executed (a program could write to disk, which a dry run promises not to do)' },
        };
      }
      if (executor.root === MEMORY_ROOT) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is held in memory rather than on disk, so run_program is unavailable here — use run_command, which this executor runs in its own sandbox.' },
        };
      }
      const result = await runProgram({
        root: executor.root, program: args.program, args: args.args, timeoutMs: args.timeoutMs ?? commandTimeoutMs,
      });
      /**
       * ⚠️ `mutated: false`, the `run_command` precedent exactly: a program can
       * write files, and those writes are real but unattributable. `mutated`
       * feeds the "N files written" line, which names paths the EXECUTOR wrote,
       * and inventing a count for a build's output would make the one honest
       * number in the summary an estimate.
       */
      return { id, name, args, result, mutated: false };
    }

    /**
     * ── ⭐ THE PLAN LEDGER ────────────────────────────────────────────────────
     *
     * ⚠️ `mutated: false`, AND THIS IS THE `evaluate` PRECEDENT RATHER THAN THE
     * `see_page` ONE. `mutated` feeds the "N files written" line — the one
     * honest number in the summary — and that line names files the USER cares
     * about. `.acuvo/plan.json` is the agent's own bookkeeping; counting it
     * would put a phantom entry in every multi-step run's report.
     *
     * ⭐ And `parallel.mjs` is the second, sharper reason. It reads mutated
     * records to detect two tasks colliding over a file. Every parallel task in
     * one workspace writes the SAME `.acuvo/plan.json`, so counting it would
     * report a conflict on literally every parallel pair — a guard that fires
     * always is a guard that gets ignored.
     *
     * `round` is forwarded verbatim: plan-ledger decides what to do with a
     * missing budget, not this dispatcher.
     */
    case 'plan_start':
      return { id, name, args, result: planStart(executor.root, args, { ...(round ?? {}), planFile: planFileFor(executor.holder) }), mutated: false };
    case 'plan_step':
      return { id, name, args, result: planStep(executor.root, args, { ...(round ?? {}), planFile: planFileFor(executor.holder) }), mutated: false };
    case 'plan_status':
      // ⚠️ Takes the ROUND options as its second argument, not model arguments —
      // there is nothing here a model could pass. See planStatus's own note.
      return { id, name, args, result: planStatus(executor.root, { ...(round ?? {}), planFile: planFileFor(executor.holder) }), mutated: false };

    /**
     * ── ⭐ SKILLS — the project's own written procedure ───────────────────────
     * There is no path argument and no way to reach a file that is not a skill;
     * `loadSkill` resolves the NAME against the discovered catalogue rather than
     * joining it onto a directory, which is why `../../.ssh/id_rsa` is simply a
     * name that matches nothing.
     */
    case 'read_skill':
      return { id, name, args, result: loadSkill(executor.root, args.name), mutated: false };

    /**
     * ── ⭐⭐ DELEGATE — A HELPER WITH ITS OWN HEAD ────────────────────────────
     *
     * ⚠️ `mutated: false` is a FACT here, not a convention: a subagent is
     * offered no verb that can change anything, and `allowRun: false` locks the
     * dispatcher behind the offer.
     *
     * ⚠️ IT REFUSES WITHOUT CREDENTIALS RATHER THAN GUESSING. A caller that did
     * not thread `config` gets a sentence naming the cause; inventing a model
     * config here would spend the owner's money on a shape nobody chose.
     */
    case 'delegate': {
      if (!config?.apiKey) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'delegation is unavailable in this run — no model credentials reached the dispatcher' },
        };
      }
      /**
       * ⚠️ `depth` IS THE CALLER'S DEPTH, NOT THE CALLEE'S — and passing
       * `depth + 1` here made the top-level `delegate` refuse ITSELF with
       * "a helper cannot delegate again (depth 1)". Every unit test passed,
       * because all thirteen called `runSubagent` directly and none came
       * through this dispatcher. ⭐ The real run found it in one command.
       */
      const result = await runSubagent({
        task: args.task,
        executor,
        config,
        depth,
        maxRounds: args.maxRounds,
        commandTimeoutMs,
      });
      return { id, name, args, result, mutated: false };
    }

    /**
     * ── ⭐ WHAT THIS RUN LEARNED, KEPT FOR THE NEXT ONE ───────────────────────
     *
     * ⚠️ `mutated: false` DELIBERATELY, following `plan_start`'s precedent. These
     * write `.acuvo/memory/*.md`, but `mutated` feeds the "N files written" line,
     * which names files the USER cares about — and it is what `parallel.mjs`
     * reads to detect two tasks colliding over a path. Every parallel task in one
     * workspace writes into the same memory directory, so counting it would
     * report a conflict on literally every parallel pair. A guard that fires
     * always is a guard that gets ignored.
     *
     * ⚠️ The memory executor has no disk. `learned.mjs` reaches for `fs`
     * directly, so it is refused there by name rather than half-working.
     */
    case 'remember':
    case 'forget': {
      if (executor.root === MEMORY_ROOT) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: `${name} needs a real workspace on disk — this run has none` },
        };
      }
      const result = name === 'remember'
        ? remember(executor.root, args)
        : forget(executor.root, args.name);
      return { id, name, args, result, mutated: false };
    }

    /**
     * ── ⭐ SESSIONS — read-only, and deliberately the only session verb ───────
     * No resume tool exists and none may be added here: a model that can rewrite
     * its own message history mid-run replays side effects. Resume is an
     * operator action taken between runs.
     */
    case 'list_sessions':
      return { id, name, args, result: listSessions(executor.root, { limit: args.limit }), mutated: false };

    /**
     * ── ⭐⭐ ASK_USER — THE ONLY TOOL WHOSE RESULT COMES FROM A PERSON ────────
     *
     * ⚠️ `mutated: false`. It writes nothing. The flag feeds the "N files
     * written" line and `parallel.mjs`'s collision detector, and a question is
     * neither a file nor a conflict.
     *
     * ⚠️ THE REFUSAL WHEN `ask` IS MISSING IS A REAL PATH, not defensive
     * padding. The offer is gated on `interactive` in `toolNamesForRounds`, but
     * a model can name any tool in the schema list, and a library caller may
     * dispatch without one. Saying so plainly — rather than throwing — keeps
     * the run alive and tells the model exactly what to do instead.
     */
    case 'ask_user': {
      if (typeof ask !== 'function') {
        return {
          id,
          name,
          args,
          mutated: false,
          result: {
            ok: true,
            answer: '(nobody is available to ask — this run has no terminal attached). '
              + 'Make the most reasonable choice, continue, and state the assumption you took in your final message.',
            answered: false,
          },
        };
      }
      return { id, name, args, result: await ask(args.question), mutated: false };
    }

    /**
     * ── ⭐ ACCEPTANCE — make the verdict be about the command the USER named ──
     *
     * ⚠️ `check_acceptance` IS THE ONE NEW TOOL THAT EXECUTES CODE, so it is
     * refused when the caller says `allowRun: false`. The offer already withholds
     * it under `--no-run`; this closes the door a model could still knock on.
     *
     * ⚠️ THE RUNNER IS INJECTED, NEVER IMPORTED BY acceptance.mjs — that module
     * starts no process by itself, which is what keeps ONE audited gate
     * (`executeRunCommand`: allowlist, no shell, scrubbed env) rather than two.
     * The executor's own runner wins where it has one, exactly as `run_command`
     * does above, so the browser builder checks criteria in its sandbox.
     *
     * `mutated: false` on both: `declare_acceptance` writes `.acuvo/acceptance.json`
     * (bookkeeping, same reasoning as the plan ledger) and `check_acceptance`
     * writes nothing at all.
     */
    case 'declare_acceptance':
      return { id, name, args, result: declareAcceptance(executor.root, { commands: args.commands }), mutated: false };
    case 'check_acceptance': {
      if (allowRun === false) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this run was started with --no-run, so acceptance criteria cannot be executed. Report what you changed and say plainly that nothing was verified.' },
        };
      }
      const runner = (command) => (typeof executor.runCommand === 'function'
        ? executor.runCommand(command)
        : executeRunCommand({ command, executor, timeoutMs: commandTimeoutMs }));
      const result = await checkAcceptance({ root: executor.root, runner });
      return { id, name, args, result, mutated: false };
    }

    /**
     * ── ⭐ FETCH — a public GET, rendered as text ─────────────────────────────
     *
     * ⚠️ THE MODEL'S ARGUMENTS ARE SPREAD IN WHOLE, ON PURPOSE. `fetchText`
     * refuses unknown keys BY NAME ("fetch_url does not accept \"headers\"") and
     * that refusal only works if it can see what was passed. Picking out url,
     * offset and limit here would silently drop a `headers` the model believed
     * it had sent — the worse of the two failures, and it is documented as such
     * in fetch-text.mjs.
     *
     * `root` is added for the on-disk cache; a memory workspace gets no cache
     * and the module already handles that.
     */
    case 'fetch_url':
      return { id, name, args, result: await fetchText({ ...args, root: executor.root }), mutated: false };

    /**
     * ── ⭐⭐ SEARCH — find the page, then read it ─────────────────────────────
     *
     * ⚠️ THE RENDERED TEXT RIDES ALONGSIDE THE STRUCTURE, not instead of it.
     * `formatResults` is what makes a fallback announce itself ("duckduckgo
     * failed (served a bot check) — coverage is narrower than usual"), and that
     * sentence is the whole reason a degraded search does not read like a
     * confident one. The raw `results` stay on the object for anything that
     * wants to program against them.
     */
    /**
     * ── ⭐⭐ EYES ────────────────────────────────────────────────────────────
     *
     * ⚠️ THIS DOES NOT ATTACH THE IMAGE TO THE CODER MODEL. The default model
     * is text-only; handed an image it does not fail loudly, it answers anyway
     * from the filename and the surrounding conversation. A confident sentence
     * about a picture nobody looked at is worse than silence, because it ENDS
     * the investigation. vision.mjs makes its own call to a model that can see.
     */
    case 'read_image':
      return { id, name, args, result: await readImage({ ...args, root: executor.root }), mutated: false };

    case 'web_search': {
      const result = await webSearch(args);
      return {
        id,
        name,
        args,
        result: result.ok ? { ...result, text: formatResults(result) } : result,
        mutated: false,
      };
    }

    /**
     * ── ⭐ WINDOWED READS ────────────────────────────────────────────────────
     *
     * ⚠️ THE TOOL NAME IS PASSED EXPLICITLY rather than inferred. `readWindow`
     * can guess from the presence of `pattern`, but the guess exists for direct
     * callers and tests — a dispatcher that knows which tool was called and
     * declines to say so is choosing to be wrong occasionally for no gain.
     *
     * ⚠️ Refused on a memory workspace with a sentence that says why, exactly as
     * git is below: `resolveInWorkspace('(memory)', …)` would resolve a real
     * relative directory named "(memory)" under the process's cwd and fail with
     * an ENOENT about a path that does not describe anything the model did.
     */
    case 'read_lines':
    case 'read_around': {
      if (executor.root === MEMORY_ROOT) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is held in memory rather than on disk, so windowed reads are unavailable here — use read_file, which reads through the executor.' },
        };
      }
      return { id, name, args, result: readWindow(executor.root, args, name), mutated: false };
    }

    /**
     * ── ⭐ THE LANGUAGE SERVER ───────────────────────────────────────────────
     *
     * One entry point for all four verbs, so the registration cannot drift from
     * the schemas — `runLspTool` owns the name→function mapping and lives beside
     * them. `opts` is left empty: timeouts, server lifetime and the shutdown
     * grace are lsp.mjs's decisions, and a dispatcher that started overriding
     * them would become a second place those numbers live.
     *
     * ⚠️ `mutated: false` on all four. A language server opens documents in its
     * own memory; nothing on disk changes.
     */
    /**
     * ── ⚠️ BACKGROUND PROCESSES RIDE WITH `allowRun`, AND MUTATE THE DISK ────
     *
     * ⚠️ `mutated: false` ON ALL THREE, AND THE FIRST VERSION GOT THIS WRONG.
     * The reasoning for `true` was sound — a dev server writes `.next/`, logs and
     * caches within a second — but `turn.mjs` reads `mutated` to mean "this
     * record NAMES A FILE", and a process names none. It crashed a real run with
     * `Cannot read properties of undefined` after the agent had already finished
     * the task. `turn.mjs` is now hardened against a pathless record too, but the
     * honest value here is `false`: the AGENT wrote no file, and what a process
     * it started did to `.next/` is not something this summary can enumerate.
     */
    case 'repl':
    case 'repl_reset': {
      if (executor.root === MEMORY_ROOT) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is held in memory rather than on disk, so there is no directory for a REPL to run in.' },
        };
      }
      /**
       * ⚠️ `mutated: false` — the REPL can of course write files if the user's
       * code does, but the RECORD names no path, and `turn.mjs` reads `mutated`
       * to mean "this record names a file". Claiming otherwise crashed a real
       * run when `start_process` did it this morning.
       */
      return { id, name, args, result: await runReplTool(name, args, { executor }), mutated: false };
    }

    case 'start_process':
    case 'check_process':
    case 'stop_process': {
      if (executor.root === MEMORY_ROOT) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is held in memory rather than on disk, so there is no directory for a process to run in.' },
        };
      }
      return {
        id, name, args,
        result: await runBackgroundTool(name, args, { executor, shell }),
        mutated: false,
      };
    }

    case 'find_definition':
    case 'find_references':
    case 'check_types':
    case 'list_symbols': {
      if (executor.root === MEMORY_ROOT) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is held in memory rather than on disk, and a language server can only read real files — use search_text and read_file instead.' },
        };
      }
      /**
       * ⚠️ THE REAL LANGUAGE SERVER WINS WHEN IT EXISTS — it covers four
       * languages, tsserver covers two. But `lspAvailable` being false is the
       * common case, and falling through to tsserver is what makes these tools
       * reachable at all. ⚠️ And tsserver is only tried for files it can
       * actually answer about: handing it a `.py` would produce a confident
       * refusal from the wrong component.
       */
      if (!lspAvailable(executor.root) && tsHandlesFile(args.file)) {
        return { id, name, args, result: await runTsserverTool(executor.root, name, args), mutated: false };
      }
      return { id, name, args, result: await runLspTool(executor.root, name, args), mutated: false };
    }

    /**
     * ⚠️ GIT NEEDS A REAL REPOSITORY ON A REAL DISK. A memory workspace has
     * neither, and `git -C "(memory)"` would fail with something incoherent.
     * Refused by capability, with a sentence that says why — the model gets
     * another round and must not spend it retrying.
     */
    case 'git_status':
    case 'git_diff':
    case 'git_log':
    case 'git_commit':
      if (executor.root === '(memory)') {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is not backed by a git repository, so git commands are unavailable here' },
        };
      }
      return dispatchGit(name, id, args, executor);
    default:
      return {
        id,
        name: name ?? '(unnamed)',
        args,
        result: { ok: false, error: `unknown tool "${name}" — this CLI implements ${TOOL_NAMES.join(', ')}` },
        mutated: false,
      };
  }
}

/** The git verbs, split out so the capability guard above reads in one glance. */
async function dispatchGit(name, id, args, executor) {
  switch (name) {
    case 'git_status':
      return { id, name, args, result: await gitStatus(executor.root), mutated: false };
    case 'git_diff':
      return { id, name, args, result: await gitDiff(executor.root, { path: args.path, staged: args.staged === true }), mutated: false };
    case 'git_log':
      return { id, name, args, result: await gitLog(executor.root, { count: args.count, path: args.path }), mutated: false };
    case 'git_commit': {
      const result = await gitCommit(executor.root, {
        message: args.message, paths: args.paths, dryRun: executor.dryRun,
      });
      /**
       * ⚠️ `mutated: false` AND THAT IS DELIBERATE. `mutated` feeds the
       * "N files written" line, which names files this run CHANGED ON DISK.
       * A commit changes no file contents — counting it would inflate the one
       * honest number in the summary with files that were already written and
       * already counted, reporting each of them twice.
       */
      return { id, name, args, result, mutated: false };
    }
    default:
      return {
        id,
        name: name ?? '(unnamed)',
        args,
        result: { ok: false, error: `unknown tool "${name}" — this CLI implements ${TOOL_NAMES.join(', ')}` },
        mutated: false,
      };
  }
}
