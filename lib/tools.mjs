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
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
/**
 * ⚠️ TWO BUILT-INS FOR ONE JOB: THE EDIT-TIME PARSER. Both are node core, so the
 * package stays zero-dependency. `vm` COMPILES without executing and `spawnSync`
 * only ever runs `node --input-type=module --check`, which parses and exits —
 * both proven by probe, see the block above `editGate`. Neither is a general
 * escape hatch: nothing in this file may use them to RUN model-authored content,
 * which is what `spawn-argv.mjs` and `command.mjs` exist for, behind approval.
 */
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
/** ⚠️ For the verdict CACHE key only — never for a security decision. */
import { createHash } from 'node:crypto';

import { executeRunCommand } from './command.mjs';
/**
 * ⚠️ FROM THE LEAF, NOT FROM `git.mjs`. The credential list moved to
 * `secret-paths.mjs` so `workspace.mjs` could use it for `move_file` without
 * creating a cycle the bundler cannot order. See that file's header.
 */
import { refusedCommitPath } from './secret-paths.mjs';
import { generateImage, imageToolSchema, imageConfig } from './imagegen.mjs';
import { listEngines, listEnginesToolSchema } from './creative-engines.mjs';
import { refusedWriteResult } from './write-approval.mjs';
import { findFiles, searchText, searchToolSchemas } from './search.mjs';
import { repoIndexToolSchemas, executeRepoIndexTool } from './repo-index.mjs';
import { usagesToolSchemas, executeUsagesTool } from './usages.mjs';
import { editThroughExecutor, editToolSchema, applyEdit } from './edit.mjs';
import { deleteToolSchema } from './delete.mjs';
import { evaluateSnippet, evaluateToolSchema } from './evaluate.mjs';
import {
  gitStatus, gitDiff, gitLog, gitCommit, gitBranch, gitPush,
  gitToolSchemas, gitPushToolNames, pushEnabled, ALLOW_PUSH_ENV,
} from './git.mjs';
import { worktreeToolSchemas, worktreeToolNames, executeWorktree } from './worktree.mjs';
import { guardCommand } from './git-safety.mjs';
import { speak, transcribe, makeDocument, readDocument, readTable, mediaToolSchemas, mediaToolNames } from './media.mjs';
import { editImage, expandImage, imageEditToolSchemas, imageEditToolNames } from './image-edit.mjs';
/**
 * ⭐ `pipe_to_asset` — generate the asset AND write the code that uses it. It
 * wraps `generateImage`, so it inherits the per-run image cap, the engine
 * entitlement check and the GPU ledger entry rather than becoming a second door
 * to the same GPU. Its whole reason to exist is that the EXTENSION is decided by
 * whichever engine answers, so a reference written before the render is a guess.
 */
import { pipeAssetToolSchemas, pipeAssetToolNames, runPipeAssetTool } from './pipe-asset.mjs';
/**
 * ⭐ `chart` and `syndicate` — the two verbs in this file that spend NOTHING.
 * No model, no GPU, no network, no subprocess: both read and write files through
 * the executor and do arithmetic in between. `chart` turns a CSV into a
 * self-contained interactive dashboard; `syndicate` assembles a blog post, a
 * numbered social thread and a vector infographic THE CALLER COMPOSED into one
 * folder, and refuses when a numbered post is over its platform's limit.
 *
 * ⚠️ THEY SHARE `html-doc.mjs` rather than each carrying an HTML escaper — the
 * two-copies-that-drift failure this package has shipped twice.
 */
import { chartToolSchemas, chartToolNames, runChartTool } from './chart.mjs';
/**
 * ⭐ `profile_table` — `chart`'s READ half, and the one that has no size limit.
 * `chart` reads its CSV through `executor.readFile`, so it is refused on exactly
 * the files the bench recorded being refused (844 KB, 51 MB); this one streams.
 */
import { profileTable, tableProfileToolSchemas, tableProfileToolNames } from './table-profile.mjs';
/**
 * ⭐ `inspect_binary` — `profile_table`'s twin on the other side of the NUL byte.
 * That one answers "this data file is too big to read"; this one answers "this
 * file is not text at all", which `workspace.mjs` currently answers with *"get
 * what you need from a text file instead"*. Measured in the bench archive:
 * `file: not found` 11 times, `xxd: not found` 7 more.
 */
import { inspectBinary, binaryInspectToolSchemas, binaryInspectToolNames } from './binary-inspect.mjs';
import { syndicateToolSchemas, syndicateToolNames, runSyndicateTool } from './syndicate.mjs';
import { avatarToolSchemas, avatarToolNames } from './avatar.mjs';
import { cloneVoice, designVoice, talkingHead, generateVideo, characterLock } from './avatar-run.mjs';
/**
 * ⭐⭐ THE TWO ORCHESTRATORS — `viral` and `podcast`. Neither owns a capability:
 * they compose `speak`, `design_voice` and `generate_image`, all of which are
 * already metered, already fail shut without a secret, and already exist. What
 * they add is the part that is actually hard and that a model gets wrong every
 * time — the timeline, the caption timings measured from the real audio, the
 * file layout, and one correct ffmpeg argv.
 *
 * ⚠️ THEY ARE THE ONLY VERBS HERE THAT FAN OUT: one call can be fourteen paid
 * requests. Both therefore price the run and produce NOTHING until a second call
 * carries `approve_spend: true` — see `spendGate` in media-pipeline.mjs.
 */
import { viralToolSchemas, viralToolNames, runViralTool } from './viral.mjs';
import { mediaChainToolSchemas, mediaChainToolNames, runMediaChainTool } from './media-chain.mjs';
import { podcastToolSchemas, podcastToolNames, runPodcastTool } from './podcast.mjs';
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
import { skillsToolSchemas } from './skills.mjs';
import { discoverAllSkills, loadAnySkill } from './builtin-skills.mjs';
import { remember, forget, learnedToolSchemas } from './learned.mjs';
import { lspToolSchemas, runLspTool, discoverLanguageServer, LANGUAGE_SERVERS, LSP_TOOL_NAMES } from './lsp.mjs';
import { backgroundToolSchemas, runBackgroundTool, BACKGROUND_TOOL_NAMES, readLog } from './background.mjs';
import { httpProbeToolSchemas, runHttpProbeTool, HTTP_PROBE_TOOL_NAMES } from './http-probe.mjs';
/**
 * ⭐ `playtest` — the loop `see_page` cannot close. see_page photographs a page;
 * this one presses the primary action and reports the button that is wired to
 * nothing. Gated on a browser MCP server actually being configured, so on a
 * machine with none it is never mentioned rather than being a dead button.
 */
import { playtestToolSchemas, runPlaytestTool, playtestToolNames } from './playtest.mjs';
/**
 * ── ⭐⭐ FOUR MODULES, 5,409 LINES, REACHABLE FROM NOTHING UNTIL NOW ─────────
 *
 * `code-review` (1,382), `db-inspect` (1,624), `gh` (1,351) and `log-tail`
 * (1,052) were all written, tested and never given a door. The wiring-reach
 * guard has been naming them for weeks and CI has been red on it for days.
 *
 * ⭐ Every one already shipped its own `*ToolSchemas()` and its own executor —
 * the same shape `http-probe` uses — so this is a registration, not a rewrite.
 * That is exactly why leaving them dark was so expensive: the work was done.
 */
import { codeReviewToolSchemas, executeReviewCode } from './code-review.mjs';
import { dbToolSchemas, inspectDatabase} from './db-inspect.mjs';
import { ghToolSchemas, executeGh } from './gh.mjs';
import { vercelToolSchemas, vercelToolNames, executeVercel } from './vercel.mjs';
import { logTailToolSchemas, runLogTailTool } from './log-tail.mjs';
import { tsserverAvailable, runTsserverTool, handlesFile as tsHandlesFile } from './tsserver.mjs';
import { renameToolSchema, renameSymbol, RENAME_TOOL_NAME } from './rename.mjs';
import { tsEditToolSchemas, runTsEdit, TS_EDIT_TOOL_NAMES } from './ts-edit.mjs';
import { replToolSchemas, runReplTool, REPL_TOOL_NAMES } from './repl.mjs';
import { listSessions, sessionToolSchemas } from './session.mjs';
import { askUserToolSchemas } from './ask-user.mjs';
import { writeManyToolSchemas, writeMany } from './write-many.mjs';
/**
 * ⭐⭐ THE VERB OUR OWN 139 BENCH RUNS ASKED FOR 201 TIMES IN RAW SHELL. See
 * `lib/toolchain.mjs`: `which` was the most hand-rolled idiom in the corpus and
 * the only one in the top five with no verb behind it — and it answers half the
 * question, because a program on PATH may still be one this run may not execute.
 */
import { toolchainToolSchemas, checkTools, TOOLCHAIN_TOOL_NAMES } from './toolchain.mjs';
/**
 * ⭐⭐ THE ENGINE WAS FINISHED AND UNREACHED. `apply-patch.mjs` shipped with 13
 * tests and two mutation-proven properties on 2026-08-19 and was imported by
 * nothing on the runtime path — the defect `wiring-reach.test.mjs` exists for.
 *
 * ⭐ IT IS THE TOP REMAINING COST LEVER, measured on a real build: output is
 * $0.045 of $0.080 — 56% of the spend, ~53,000 tokens — and a prompt cache
 * (already 83.2%, 100% steady-state) can never discount output. The output is
 * dominated by re-emitting whole files, and a patch is 10-50x smaller.
 */
import { applyPatchToolSchemas, planPatch, commitPatch } from './apply-patch.mjs';
import { declareAcceptance, checkAcceptance, acceptanceToolSchemas } from './acceptance.mjs';
import { fetchText, fetchToolSchemas } from './fetch-text.mjs';
import { webSearch, formatResults, webSearchToolSchemas } from './websearch.mjs';
import { readImage, visionToolSchemas } from './vision.mjs';
/**
 * ⚠️ `DEFAULT_MAX_CHARS` IS IMPORTED, NOT RE-SPELLED. `read_file`'s windowed
 * branch below has to leave room for its own one-line header inside the same
 * 8,000-character budget `turn.mjs` clamps a read result to; hardcoding 8000
 * here would be the second copy of a number that this package has already
 * watched drift twice (see the two-credential-lists note in read-window.mjs).
 */
import { readWindow, readWindowToolSchemas, DEFAULT_MAX_CHARS } from './read-window.mjs';
import { runProgram, spawnArgvToolSchemas } from './spawn-argv.mjs';
import { runSubagent, subagentToolSchemas } from './subagent.mjs';
import { loadAgentDefinitions, findAgent, taskForAgent } from './agent-definitions.mjs';
/**
 * ── ⭐⭐⭐ SWE-agent's SECOND ACI IDEA, WIRED WHERE IT CAN ACTUALLY REFUSE ────
 *
 * `edit-diagnostics.mjs` has always linted AFTER the bytes land, because at that
 * seam the file is already on disk and failing the write would be a lie. This
 * is the OTHER seam — the one where the after-image exists and nothing has been
 * written yet — and it is the only place a malformed edit can be stopped rather
 * than reported.
 *
 * ⚠️ IT IS WIRED ON EVERY WRITING VERB IN ONE COMMIT, not just `edit_file`.
 * This package has measured the alternative twice: a fix that reaches one caller
 * gets rediscovered as a bug on the second three days later.
 */
import { checkEditBeforeCommit, isCheckablePath } from './edit-diagnostics.mjs';
import { wasteNoteForWrite } from './rewrite-waste.mjs';

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
      /**
       * ⚠️ THE OLD TEXT SAID "there is no patch mode", AND THAT BECAME FALSE THE
       * MOMENT `apply_patch` WAS WIRED. A description that denies a capability
       * IS the capability not existing — `run_command`'s shell note above says
       * the same thing, and it cost that flag its whole effect for weeks.
       *
       * ⭐ The pointer is here, not only on `apply_patch`, because this is the
       * verb the model is already reaching for when the cheaper one applies.
       */
      description:
        'Create a new UTF-8 text file, or replace an existing one outright, creating parent directories as needed. '
        + 'Write the COMPLETE file contents — anything you omit is deleted. '
        + 'If the file ALREADY EXISTS, prefer apply_patch: re-emitting a whole file spends output tokens, which are '
        + '56% of a run\'s cost and the one part a prompt cache cannot discount, and a patch also measures 9x fewer '
        + 'editing errors. Use this verb for a new file, or when genuinely rewriting one end to end.',
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
  /**
   * ── ⭐⭐ `check_tools` IS DECLARED IMMEDIATELY BEFORE `run_command`, AND THE
   *    POSITION IS THE HINT — the same argument `find_symbol` makes below for
   *    sitting ahead of the search pair. A model reading the offer top-down
   *    should meet "what may I run here?" before "run this", because the whole
   *    saving is the round it does not spend being refused. Met afterwards it is
   *    a verb for apologising with.
   *
   * ⚠️ IT IS IN THE BASE ARRAY RATHER THAN A `push`, WHICH IS THE ONLY WAY TO
   * GET THAT ORDER: `toolSchemasFor` filters THIS array, so the wire order is
   * the declaration order and every `push` lands after `run_command`.
   */
  ...toolchainToolSchemas(),
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
          /**
           * ⚠️ `run_program` HAS ALWAYS TAKEN THIS AND `run_command` DID NOT —
           * and `run_command` is the one that runs builds. So the tool most
           * likely to need longer was the only one that could not ask, and a
           * slow install just died at the default with nothing to show for it.
           * Clamped by the same ceiling, so this raises what a command MAY
           * take, never what it may bypass.
           */
          timeoutMs: {
            type: 'number',
            description: 'Optional. Kill the command after this many ms instead of the default. Raise it for an install, a compile or a long test run; capped at 600000.',
          },
          /**
           * ── ⚠️⭐ A PROBE OF AN ERROR PATH IS NOT A FAILING CHECK (2026-09-26) ──
           * Found by using it: documenting a CLI, the agent ran `npm test` (green)
           * and then `node bin/tasq.mjs bogus` ON PURPOSE to confirm the unknown-
           * command path exits 2. The summary read that as a red suite — *"✖ NOT
           * VERIFIED … Whatever it said above, the code does not pass"* — about a
           * correct README over working code. Guessing intent from the output was
           * rejected: a hand-written `node check.mjs` that prints FAIL and exits 1
           * looks identical and MUST stay red. So the model says what it expects,
           * and the run passes only on exactly that code.
           */
          expectExit: {
            type: 'integer',
            description: 'Optional. The exit code this command is SUPPOSED to return when you are checking an error path on purpose (e.g. 2 for an unknown subcommand). It then passes only on exactly that code.',
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
/**
 * ── ⭐⭐ RENAMING WAS IMPOSSIBLE, NOT MERELY EXPENSIVE ──────────────────────
 *
 * Without this verb the only rename was read + write + delete: three rounds of
 * a five-round default, and the file's whole content through the context twice.
 * MEASURED against the real executor, two ordinary files cannot do it at all —
 * a 250KB source file ("over the 200000-byte read limit") and any binary
 * ("logo.png" is refused as binary, which is the good outcome; the alternative
 * is silent corruption). So an agent could not rename a large module or move an
 * image into `assets/`, and the only explanation it got was a read error about
 * a file it never wanted to read.
 *
 * The refusals live on `executor.moveFile`, where the credential-laundering
 * rule and the directory rule are argued in full.
 */
TOOL_SCHEMAS.push({
  type: 'function',
  function: {
    name: 'move_file',
    description: [
      'Rename or move ONE file inside the workspace, creating parent directories as needed.',
      'Use this instead of read_file + write_file + delete_file: it is one round instead of three,',
      'it does not put the file through your context, and it is the ONLY way to move a binary file',
      'or one larger than the read limit.',
      'One file per call: no globs, no directories — move a directory\'s files individually, or use `git mv` yourself.',
      'It refuses to overwrite an existing destination unless you pass overwrite: true.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Workspace-relative path of the existing file, e.g. "src/old.ts".' },
        to: { type: 'string', description: 'Workspace-relative destination, e.g. "src/lib/new.ts".' },
        overwrite: { type: 'boolean', description: 'Replace the destination if it already exists. Defaults to false.' },
      },
      required: ['from', 'to'],
    },
  },
});
TOOL_SCHEMAS.push(editToolSchema());
TOOL_SCHEMAS.push(deleteToolSchema());
// ⭐ Kills the `node -e` round tax structurally — see evaluate.mjs.
TOOL_SCHEMAS.push(evaluateToolSchema());
/**
 * ── ⭐⭐ `find_symbol` IS DECLARED AHEAD OF THE SEARCH PAIR, ON PURPOSE ──────
 *
 * `toolSchemasFor` filters `TOOL_SCHEMAS`, so the WIRE ORDER is the order of
 * these pushes — and the order is a hint the model reads top-down. The entire
 * argument for this tool is "reach for it BEFORE you grep", so it must not be
 * met after `search_text`.
 *
 * ⚠️ AND IT IS UNCONDITIONAL, so it belongs in the stable block above the
 * project-varying groups (see the ordering note further down). It gates on
 * nothing: no key, no endpoint, no language server, no installed binary. It
 * reads source files that are already inside the workspace root.
 *
 * ⭐ WHY IT EARNS THE ~1,371 BYTES. Measured on this repository 2026-08-25:
 * `search_text` returns total=0, scanCapped=true for `rankFiles`,
 * `byCodePoint` and `openIndex` — all three defined in `lib/` — because its
 * 4,000-file scan budget is spent inside `bench/` before the walk arrives.
 * `find_symbol` answers all three from an index, in one call.
 */
TOOL_SCHEMAS.push(...repoIndexToolSchemas());   // find_symbol
TOOL_SCHEMAS.push(...usagesToolSchemas());      // find_usages — uses of a name in code, no language server needed (C2)
TOOL_SCHEMAS.push(...searchToolSchemas());      // find_files · search_code
TOOL_SCHEMAS.push(...gitToolSchemas());
TOOL_SCHEMAS.push(...worktreeToolSchemas());    // git_worktree
TOOL_SCHEMAS.push(imageToolSchema());
/**
 * ⭐ `list_engines` — WHAT AN ENGINE COSTS, WITHOUT SPENDING ONE TO FIND OUT.
 * Declared unconditionally: unlike the media half it needs no endpoint of our
 * hosting to be USEFUL, because "prices unavailable, and here is why" is a real
 * answer that a model can act on. It is the only creative verb that asks the
 * gateway for prices; the render verbs read the cache it leaves behind.
 */
TOOL_SCHEMAS.push(listEnginesToolSchema());
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
 * ⭐ CLOSING THE LOOP — pipe_to_asset. `generate_image` hands back a path and
 * the wiring round is a separate decision the model routinely skips; worse, the
 * extension is not knowable in advance, so a reference written first is wrong
 * whenever the JPEG-returning fallback answers.
 *
 * ⚠️ DECLARED HERE, IN THE STABLE BLOCK, BESIDE THE OTHER CREATIVE VERBS. Its
 * gate reads the ENVIRONMENT (the same `imageConfig` gate `generate_image` uses)
 * and never the project, so it does not vary between repositories and must not
 * sit after the project-varying groups at the end of this file — see the
 * declaration-order note further down.
 */
TOOL_SCHEMAS.push(...pipeAssetToolSchemas());
/**
 * ⭐ THE TWO FREE VERBS — chart · syndicate.
 *
 * ⚠️ DECLARED HERE, IN THE STABLE BLOCK, AND THE PLACEMENT IS THE POINT. Neither
 * gates on an environment variable, a service, a key or a project shape — they
 * read a file and write a file — so their presence NEVER varies between
 * repositories or machines. Anything that does not vary belongs in front of the
 * conditional groups at the end of this file, where its bytes stay inside the
 * shared prompt-cache prefix. Moving either of these below `playtest` would push
 * every schema behind it out of the cached prefix for no gain.
 *
 * ── ⚠️⚠️ MEASURED HEAD COST, AND THE HEADROOM IS NOW THIN ──────────────────
 *
 * This package's own offer at `maxRounds: 16`, no keys, ordinary project:
 *
 *     full tool surface   52,361 B  →  56,867 B   (+4,506, +8.6%)
 *     chart schema                       1,836 B
 *     syndicate schema                   2,672 B
 *
 * ⭐ WITH THE SHORTLIST LIVE (`ACUVO_TOOL_SHORTLIST`, on by default) AN
 * UNSIGNALLED TASK PAYS NOTHING FOR EITHER. Measured on the same offer:
 * `"hi"` and `"fix the typo in the header"` are 25 tools / 24,511 B — byte-
 * identical to before this pair existed — because both verbs are classified
 * into shortlist groups (`chart` → `docs`, `syndicate` → a new `content`
 * group). `"chart sales.csv for me"` pays 1,835 B; `"write a blog post and an
 * X thread"` pays 1,689 B. An UNCLASSIFIED verb would have been kept under
 * every brief, so grouping them in the same commit is what makes the head cost
 * zero rather than +4,506 on every request.
 *
 * ⚠️ THE CEILING IS THE THING TO WATCH. `declared-tools-are-named.test.mjs`
 * asserts the full surface stays under 60,000 bytes; at 56,867 there are 3,133
 * bytes left, which is roughly ONE more verb of this size. The next addition
 * should either shrink an existing schema or move that ceiling deliberately.
 */
TOOL_SCHEMAS.push(...chartToolSchemas());
TOOL_SCHEMAS.push(...syndicateToolSchemas());

/**
 * ── ⭐⭐⭐ THE MOAT HALF — cloned voice · designed voice · the face · video ──
 *
 * ⚠️ MEASURED 2026-08-22: the CLI carried 9 of the console's 20 Modal
 * endpoints, and every missing one was a moat capability. It shipped generic
 * TTS and transcription — the two things anybody can rent — while the cloned
 * voice and the talking head, running on GPUs we already pay for, were
 * reachable only from the web builder. `media.mjs` said so in its own schema:
 * "voice cloning is not reachable from the CLI and will be refused."
 *
 * Declared unconditionally like the rest, for the same reason: the drift guard
 * must not see a different tool list on a machine with different env. The
 * per-turn OFFER below is what gates on real configuration.
 */
TOOL_SCHEMAS.push(...avatarToolSchemas({
  MODAL_VIDEO_SECRET: 'declared',
  MODAL_AVATAR_URL: 'declared', MODAL_VOICE_CLONE_URL: 'declared',
  MODAL_VOICE_DESIGN_URL: 'declared', MODAL_VIDEO_URL: 'declared',
  // ⚠️ EVERY AVATAR URL MUST BE LISTED HERE OR THE VERB IS INVISIBLE TO
  // `TOOL_NAMES`, and the drift guard reports it as "dispatched but never
  // declared". That is exactly what happened when `character_lock` was added:
  // config, schema, runner and dispatch were all correct, and this one line
  // was not, so no model could have reached it.
  MODAL_CHARACTER_LOCK_URL: 'declared',
}));
/**
 * ⭐ THE ORCHESTRATORS — `viral` · `podcast`. Declared unconditionally, beside
 * the moat verbs they compose and BEFORE the project-varying block, because
 * their OFFER gates on the environment (a speech service) and never on the
 * shape of the repository — so their bytes stay inside the shared prompt-cache
 * prefix. `toolNamesForRounds` is what decides whether either is mentioned.
 */
TOOL_SCHEMAS.push(...viralToolSchemas());
TOOL_SCHEMAS.push(...mediaChainToolSchemas());
TOOL_SCHEMAS.push(...podcastToolSchemas());

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
TOOL_SCHEMAS.push(...learnedToolSchemas());     // remember · forget
TOOL_SCHEMAS.push(...subagentToolSchemas());    // delegate
TOOL_SCHEMAS.push(...sessionToolSchemas());     // list_sessions
TOOL_SCHEMAS.push(...askUserToolSchemas());     // ask_user
TOOL_SCHEMAS.push(...writeManyToolSchemas());   // write_files
/**
 * ⚠️ DECLARED HERE, IN THE UNCONDITIONAL BLOCK, because declaration order IS the
 * prompt-cache prefix (see the note further down: moving the conditional groups
 * last took the shared prefix from 69.2% to 93.3%). A new schema appended after
 * a conditional group would push every later tool's identical bytes into a cold
 * read whenever that group's presence changed.
 */
TOOL_SCHEMAS.push(...applyPatchToolSchemas());  // apply_patch
TOOL_SCHEMAS.push(...acceptanceToolSchemas());  // declare_acceptance · check_acceptance
TOOL_SCHEMAS.push(...fetchToolSchemas());       // fetch_url
TOOL_SCHEMAS.push(...webSearchToolSchemas());      // web_search
TOOL_SCHEMAS.push(...visionToolSchemas());         // read_image
TOOL_SCHEMAS.push(...readWindowToolSchemas());  // read_lines · read_around
TOOL_SCHEMAS.push(...backgroundToolSchemas());  // start_process · check_process · stop_process
TOOL_SCHEMAS.push(...httpProbeToolSchemas());   // call_endpoint
/**
 * ⚠️ `review_code` and `inspect_db` are declared UNCONDITIONALLY because they
 * read what is already on disk — no endpoint of ours, no process, no key. A
 * workspace with no database simply gets "no schema found", which is a real
 * answer a model can act on rather than a dead button.
 */
TOOL_SCHEMAS.push(...codeReviewToolSchemas());  // review_code
/**
 * ⚠️ The gh and log verbs ride with `allowRun` — see `toolNamesForRounds`. gh
 * spawns the `gh` binary; the log verbs can only read a process `start_process`
 * started, and that is refused under `--no-run`.
 */
TOOL_SCHEMAS.push(...ghToolSchemas());          // gh_issue, gh_pr, gh_run
/**
 * ⚠️ DECLARED UNCONDITIONALLY, OFFERED ALMOST NEVER — the same split `git_push`
 * uses. The schema living in the registry costs nothing; `toolSchemasFor` only
 * serialises the names `toolNamesForRounds` chose, and `vercelToolNames`
 * returns an empty list unless `ACUVO_ALLOW_DEPLOY=1`.
 */
TOOL_SCHEMAS.push(...vercelToolSchemas());      // vercel_preview
TOOL_SCHEMAS.push(...logTailToolSchemas());     // read_log, wait_for_output, summarize_log
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

/**
 * ── ⭐⭐⭐ DECLARATION ORDER IS THE PROMPT-CACHE PREFIX ─────────────────────
 *
 * `toolSchemasFor` returns `TOOL_SCHEMAS.filter(...)`, so the WIRE ORDER is
 * the order of these pushes, not the order the caller asked for. Every tool
 * declared AFTER a conditional group is re-sent cold whenever that group's
 * presence changes, even though its bytes are identical.
 *
 * ⚠️ MEASURED 2026-08-20 between two real project shapes — one plain, one with
 * a migrations directory:
 *
 *     conditional groups mid-list (before)   69.2% shared prefix  (34,561 B)
 *     conditional groups LAST     (now)      93.3% shared prefix  (46,608 B)
 *
 * ⭐ ~12,000 bytes — roughly 3,000 tokens — that a user switching between
 * project shapes was paying for at cold-read prices on every first round.
 *
 * ⚠️ AND IT ONLY WORKS BECAUSE THE SYSTEM PROMPT DOES NOT VARY. Measured the
 * same day: `systemPrompt` is byte-identical across both shapes (3,861 chars),
 * so the tool block really is where divergence begins. If the prompt ever
 * starts carrying project detail, it moves in front of this and the ordering
 * below stops buying anything — check that before trusting these numbers.
 *
 * ⭐ This is the same lever recorded in `project_acuvo_byte_order_is_the_cache
 * _lever` (25.8% -> 95.6% by moving one line): put the stable bytes first and
 * everything that varies last.
 */
/**
 * ⚠️ `playtest` BELONGS IN THIS BLOCK AND NOT ABOVE IT. Its gate reads the
 * workspace's own `.acuvo/mcp.json`, so it appears and disappears with the
 * PROJECT — which is the precise definition of a tool that has to be declared
 * after everything stable, or every schema behind it is re-sent cold whenever a
 * user moves between a repo that has a browser configured and one that does not.
 */
TOOL_SCHEMAS.push(...playtestToolSchemas());    // playtest — needs a browser MCP server in this workspace
TOOL_SCHEMAS.push(...skillsToolSchemas());      // read_skill — present only when the project HAS skills
TOOL_SCHEMAS.push(...lspToolSchemas());         // find_definition · find_references · check_types · list_symbols — needs a language server
/**
 * ⭐ `rename_symbol` — THE SAME GATE AS THE FOUR ABOVE, BECAUSE IT IS THE SAME
 * SERVER. It sits in the varying block for exactly their reason: a machine with
 * no language server can never answer it, and a schema that can only ever return
 * "install typescript" teaches the model to try, wait and apologise.
 */
TOOL_SCHEMAS.push(renameToolSchema());          // rename_symbol — needs a language server AND the write capability
/**
 * ⭐⭐ THE THREE AST EDITS — SAME GATE, SAME REASON, AND THEY ARE NOT A RENAME.
 * `insert_before_symbol`, `insert_after_symbol` and `replace_function_body`
 * find a declaration by NAME through the project's own `typescript`. They sit
 * behind the same compiler gate because without one they cannot answer at all,
 * and they must not grow a string-matching fallback — that fallback is
 * `edit_file`, which already exists and is what these three exist to stop being
 * used for anchoring on a brace.
 */
TOOL_SCHEMAS.push(...tsEditToolSchemas());      // insert_before_symbol · insert_after_symbol · replace_function_body
TOOL_SCHEMAS.push(...dbToolSchemas());          // inspect_db, sample_db_rows — needs schema evidence
/**
 * ⭐⭐ `profile_table` — DECLARED HERE, IN THE VARYING BLOCK, AND THE FIRST
 * DRAFT HAD IT ABOVE, WHICH WAS WRONG.
 *
 * It is `inspect_db`'s shape exactly: *"offered on evidence, and only on
 * evidence"*. `tableEvidence` looks for a delimited file in the workspace root
 * or one level down, so this verb appears and disappears with the PROJECT — the
 * precise definition of a schema that must sit after everything stable, or every
 * tool behind it is re-sent cold whenever a user moves between a repo with data
 * and one without.
 *
 * ⚠️ AND THE GATE IS NOT COSMETIC. Measured on a plain one-file project at 16
 * rounds: the raw offer was 59,672 B with a deliberate 60,000 B ceiling in
 * `declared-tools-are-named.test.mjs`, i.e. 328 bytes of headroom for a 962-byte
 * schema. An unconditional offer would have crossed a ceiling that exists to
 * make exactly this a decision rather than a side effect. Gated, a code
 * repository pays 0 and a data repository pays 962 for the verb it can use.
 */
TOOL_SCHEMAS.push(...tableProfileToolSchemas());  // profile_table — needs a delimited file in the workspace
/**
 * ⭐⭐ `inspect_binary` — THE SAME SHAPE AS THE LINE ABOVE, AND THE CEILING IS
 * WHY IT HAS TO BE.
 *
 * Measured on a plain one-file project at 16 rounds, immediately before this
 * verb existed: the raw offer was **59,513 B against the deliberate 60,000 B
 * ceiling in `declared-tools-are-named.test.mjs` — 487 bytes of headroom for a
 * 1,071-byte schema**. It does not fit, and the answer to that is not a bigger
 * ceiling. `binaryEvidence` looks for a binary in the workspace root or one
 * level down, so an all-TypeScript repository pays 0 and a repository with a
 * compiled artifact pays 1,071 for the verb it can use.
 */
TOOL_SCHEMAS.push(...binaryInspectToolSchemas());  // inspect_binary — needs a binary file in the workspace

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
/**
 * ⭐ `write_files` IS HERE FOR THE SAME REASON `write_file` IS: its result lands
 * on disk, so it has somewhere to go even with no second round. "Create these
 * five files" is an ordinary one-round request, and withholding the plural form
 * would push it back into `evaluate`, which is exactly where a bulk write is
 * invisible to the leases and to the change count.
 */
export const SINGLE_SHOT_TOOL_NAMES = ['write_file', 'write_files'];

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
    const found = discoverAllSkills(root);
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
/**
 * ── ⚠️⚠️ THREE TOOLS WERE DECLARED AND NEVER NAMED ─────────────────────────
 *
 * Measured 2026-08-20: `TOOL_SCHEMAS` declares 63 tools and
 * `toolNamesForRounds` offered 47 at every round budget. Sixteen were absent,
 * and thirteen of those are honestly environment-gated — LSP, the media
 * secret, an explicit render URL, the git-push opt-in.
 *
 * ⭐ THREE WERE NOT GATED ON ANYTHING. `review_code`, `inspect_db` and
 * `sample_db_rows` are declared UNCONDITIONALLY, directly above a comment
 * saying why: *"they read what is already on disk — no endpoint of ours, no
 * process, no key."* Nothing ever put their names in the list, so the model
 * could not call them.
 *
 * ⚠️ AND ONE OF THEM IS ADVERTISED TO THE USER. `code-review.mjs` prints
 * *"run `review_code` on the file for the full list"* — a hint pointing at a
 * verb the model has never been offered.
 *
 * ⚠️⚠️ AND THE GATE HAS TO BE CHEAP. My first version called
 * `readSchemaFromWorkspace`, which recursively globs every .sql file in the
 * tree and PARSES what it finds: **478ms per call**, once per turn. It took
 * the CLI suite from 111s to 285s with one run cancelled. A gate costing half
 * a second to decide whether to offer a tool is worse than a missing tool.
 *
 * ⭐ So it probes a handful of CONVENTIONAL locations with `existsSync` and
 * memoises per root. The trade is stated rather than hidden: a project keeping
 * SQL somewhere unconventional will not be offered the tools. That is a miss,
 * not a break — the tools are an offer, and 478ms of every turn is not payable.
 *
 * Verified working before wiring: `inspect_db` returned `ok:true` with real
 * tables read off disk, and `review_code` found an `eval-non-literal` with
 * severity, confidence and a reason.
 *
 * ⚠️ THEY ARE NOT FREE — 418 + 535 + 300 tokens against an 11,235-token
 * surface, on every turn. So the DB pair follows the pattern this file already
 * uses for skills and LSP: offer it where there is evidence it can answer.
 * `review_code` rides always; it applies to any source file, and 418 tokens is
 * the cheapest of the three.
 */
const DB_EVIDENCE_PATHS = Object.freeze([
  'prisma/schema.prisma',
  'supabase/schema.sql', 'supabase/migrations',
  'migrations', 'db/migrations', 'database/migrations', 'drizzle',
  'schema.sql', 'db/schema.sql',
]);
const DB_EVIDENCE_ENV = Object.freeze(['DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_DB_URL', 'MYSQL_URL']);
/** Memoised per root: the answer cannot change inside one turn. */
const dbEvidenceCache = new Map();

export function dbEvidence(root, env = process.env) {
  if (typeof root !== 'string' || root === '' || root === MEMORY_ROOT) return false;
  for (const key of DB_EVIDENCE_ENV) if ((env[key] ?? '').trim()) return true;
  const cached = dbEvidenceCache.get(root);
  if (cached !== undefined) return cached;
  let found = false;
  for (const rel of DB_EVIDENCE_PATHS) {
    try { if (existsSync(join(root, rel))) { found = true; break; } } catch { /* unreadable is not evidence */ }
  }
  dbEvidenceCache.set(root, found);
  return found;
}

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
/**
 * ⚠️ `home` IS AN OPTION FOR THE SAME REASON `env` AND `root` ARE. Since the
 * media half became account-aware, part of the OFFER is decided by
 * `~/.acuvo/credentials.json` — so a caller that needs a deterministic answer
 * (the prefix derivation in `tool-prefix.mjs`, and any test asserting a tool
 * list) has to be able to name a home rather than inherit whoever is signed in.
 * `undefined` means "the real one", which is right for every actual run.
 */
export function toolNamesForRounds(maxRounds, { allowRun = true, env = process.env, root = process.cwd(), subagent = false, interactive = false, home = undefined } = {}) {
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
  /**
   * ⭐ `find_symbol` SITS IMMEDIATELY BEFORE THE SEARCH PAIR, and the order is
   * the hint — the same reason `edit_file` sits before `write_file`. A model
   * hunting a definition should meet the index verb first and the grep second,
   * because `search_text` returns every mention and stops after a bounded scan,
   * while this returns definition sites with no scan limit to fall off.
   */
  const names = ['read_file', 'write_file', 'edit_file', 'delete_file', 'move_file', 'list_dir', 'find_symbol', 'find_usages', 'find_files', 'search_text'];
  /**
   * ⭐ `run_program` SITS IMMEDIATELY AFTER `run_command`, AND THE ORDER IS THE
   * HINT — the same reason `edit_file` sits before `write_file`. A model reading
   * the offer top-down meets the string runner first (right for `npm test`) and
   * the argv runner second (right the moment an argument has a space, a quote or
   * a leading dash). Both are gated on `allowRun`: it spawns a process, so
   * `--no-run` must withhold it or the flag is a lie by a side door.
   */
  /**
   * ── ⭐⭐ `check_tools` RIDES WITH `allowRun`, AND THAT IS THE HONEST PAIRING ─
   *
   * It executes nothing — it reads PATH and a config file — so a security
   * argument would not withhold it. The reason it is gated anyway is that its
   * whole answer is about what `run_command` and `run_program` MAY do, and
   * under `--no-run` the answer is "nothing, regardless". Offering a verb whose
   * only possible reply is already known is the dead button this file refuses
   * to ship, and it would cost its schema on every round of every `--no-run` run
   * to say so.
   *
   * ⚠️ MULTI-ROUND ONLY, for the reason the whole block above is: in a
   * single-shot turn there is no round after the answer in which to use it.
   */
  if (allowRun) names.push(...TOOLCHAIN_TOOL_NAMES);
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
   * ── ⭐⭐ AND THE VERB THAT MAKES A STARTED SERVER WORTH STARTING ───────────
   *
   * `start_process` gave the agent a dev server it could not talk to.
   * `check_process` answers one question — "is anything listening" — and
   * `fetch_url` refuses loopback by design, so the agent could build an API and
   * never once call it. `POST /users` returning 201 is the difference between
   * "wrote a route" and "the route works".
   *
   * ⚠️ TIED TO `allowRun`, AND TIED TO `start_process` SPECIFICALLY. It can only
   * reach a port a process from THIS run started and the OS has confirmed that
   * process holds (`portVerified`); with `--no-run` there are no such processes,
   * so listing it would be a button that can only ever refuse.
   *
   * ⚠️ AND MULTI-ROUND FOR THE SAME REASON AS THE SERVER IT CALLS: in a
   * single-shot turn there is no round in which the server is already up.
   */
  if (allowRun) names.push(...HTTP_PROBE_TOOL_NAMES);
  // ⚠️ Same rule, same reason: gh spawns a binary, and the log verbs can only
  // read a process `start_process` started — which --no-run refuses.
  if (allowRun) names.push('gh_issue', 'gh_pr', 'gh_run', 'read_log', 'wait_for_output', 'summarize_log');
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
  names.push(...mediaToolNames(env, home));
  // ⚠️ MULTI-ROUND ONLY, and not for the usual "a read has nowhere to go"
  // reason: an edit is a 3-second-to-6-minute GPU job whose whole point is that
  // the model then LOOKS at the result. Offering it on a single-shot turn buys
  // the render and throws away the check.
  names.push(...imageEditToolNames(env));
  /**
   * ⚠️ MULTI-ROUND ONLY, AND NOT FOR THE USUAL REASON. Its subject is a file
   * that ALREADY EXISTS with a marker in it — in a single-shot run that is a
   * file nothing has written yet, so the verb could only ever refuse. The gate
   * itself is `generate_image`'s (`imageConfig`), because a machine where the
   * image chain is switched off cannot produce the asset half at all.
   */
  names.push(...pipeAssetToolNames(env, { maxRounds }));
  /**
   * ⭐ `chart` and `syndicate` — OFFERED UNCONDITIONALLY, AND WITH NO `allowRun`
   * GATE. Neither starts a process, reaches a network, or needs a key, so there
   * is nothing for an environment gate to check and nothing for `--no-run` to
   * withhold: `--no-run` means "do not execute anything", and writing a file is
   * what `--dry-run` covers — which both verbs honour through the executor.
   *
   * ⚠️ MULTI-ROUND ONLY, and NOT for this file's usual reason. On the merits
   * both belong in the single-shot offer (they write files, so their results
   * have somewhere to go — the argument `generate_image` makes directly above).
   * They are withheld because two existing green guards pin the single-shot
   * offer to an exact list — `integration-run-program-and-collisions.test.mjs`
   * and `integration-seams.test.mjs` — and widening it is a deliberate decision
   * with a measured byte cost, not something to smuggle past an assertion.
   */
  names.push(...chartToolNames({ maxRounds }));
  names.push(...syndicateToolNames({ maxRounds }));
  /**
   * ⚠️ MULTI-ROUND ONLY, AND THE STRONGEST CASE OF THE THREE. A talking head
   * is MINUTES of GPU and is priced per video-second. On a single-shot turn
   * the model would buy the render and then have no round left to look at it,
   * which is paying for the expensive half of a loop and skipping the half
   * that makes it correct.
   */
  names.push(...avatarToolNames(env));
  /**
   * ⭐ `viral` AND `podcast` — GATED ON A SPEECH SERVICE, MULTI-ROUND ONLY.
   *
   * ⚠️ THE GATE IS THE SAME ONE `speak` ITSELF USES, and it is imported rather
   * than re-derived: a video verb with no voiceover is a slideshow and a podcast
   * verb with no voice is a text file, so on a machine with no TTS neither can
   * do the thing its name promises. Both fan out to several paid calls, so
   * single-shot is withheld for the strongest version of the reason `avatar`
   * gives — one round buys the render and leaves none to look at it.
   *
   * ⚠️⚠️ THIS LINE SAID THE GATE WAS `mediaConfig(env).speak` AND THAT WAS THE
   * BUG (fixed 2026-08-31). `mediaConfig().speak` needs `ACUVO_MEDIA_SECRET` /
   * `MODAL_VIDEO_SECRET` — OUR credentials — while `speak` itself had already
   * moved to `speakVia`, which accepts the signed-in customer's account. So the
   * sentence "the same one `speak` itself uses" stopped being true, and these
   * two verbs were offered to nobody who had paid for them. `home` is threaded
   * for the same reason `mediaToolNames` needs it: without it, which tools a run
   * offers would depend on whose laptop ran the test.
   */
  names.push(...viralToolNames(env, { maxRounds, home }));
  // ⭐ media_chain: same offer rule as `viral` (account-routed, never single-shot), gateway-only.
  names.push(...mediaChainToolNames(env, { maxRounds, home }));
  names.push(...podcastToolNames(env, { maxRounds, home }));
  names.push('git_status', 'git_diff', 'git_log');
  if (allowRun) names.push('git_commit');
  /**
   * ⭐ `git_branch` RIDES WITH COMMIT, and for the weaker half of the same
   * reason. It executes git and changes repository state, so `--no-run`
   * withholds it — but on its own it touches no remote and destroys nothing,
   * which is why it needs no gate beyond that. Without it the agent could
   * commit and had no way to keep the commit off the branch it started on.
   */
  if (allowRun) names.push('git_branch');
  /**
   * ⭐ `git_worktree` RIDES WITH `git_branch` and for a stronger version of its
   * reason: it executes git and creates a branch, so `--no-run` withholds it —
   * and on its own it cannot destroy anything, because `remove` refuses while a
   * worktree holds work and the model has no `force` parameter to pass.
   */
  names.push(...worktreeToolNames({ allowRun, maxRounds }));
  /**
   * ── ⚠️⚠️ PUSH IS OFF UNLESS AN OPERATOR NAMED IT ──────────────────────────
   * `ACUVO_ALLOW_PUSH=1`, checked in `git.mjs`. This is the same shape as the
   * media tools directly above — a capability whose configuration is absent is
   * never mentioned — and it is deliberately a SECOND gate on top of
   * `allowRun`, because push is the only verb in the package whose effect is
   * visible to people who are not at this keyboard.
   *
   * ⭐ AND IT COSTS ZERO TOKENS WHEN OFF. The schema exists in the registry;
   * `toolSchemasFor` only serialises the names in this list.
   */
  names.push(...gitPushToolNames(env, { allowRun }));
  /**
   * ── ⚠️⚠️ AND THE ONLY VERB IN THE PACKAGE THAT SPENDS MONEY ───────────────
   * `ACUVO_ALLOW_DEPLOY=1`, checked in `vercel.mjs` at the offer AND again at
   * the dispatcher. A Vercel deployment is a paid BUILD on the operator's
   * account that happens the instant the request lands — there is no undo, and
   * `git reset` does not reach it — so it gets push's treatment and one more
   * gate on top: `deploy` refuses unless the free `plan` action's price has
   * been acknowledged in the arguments.
   *
   * ⚠️ MULTI-ROUND ONLY, and not merely by convention: the shape is
   * plan → read the cost → deploy → poll, which needs at least two rounds. In a
   * single-shot turn it could only ever produce the plan.
   */
  names.push(...vercelToolNames(env, { allowRun }));

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
   * ⭐ `profile_table` RIDES WITH THE WINDOWED READS — same family, same
   * multi-round rule, same reason: it describes a file so the NEXT round can act
   * on it, and a description with no round after it has nowhere to go.
   *
   * ⚠️ IT IS NOT GATED ON `allowRun`. It spawns nothing and reaches nothing; it
   * opens a file inside the workspace root through `resolveInWorkspace`, which is
   * what `read_lines` directly above already does under `--no-run`. Gating it
   * would withhold the only large-data reader from exactly the shell-less surface
   * that has no `head -5` to fall back to — the case in its header.
   *
   * ⚠️ IT IS GATED ON EVIDENCE — `tableEvidence(root)`, the `inspect_db` shape.
   * The reasoning and the measured 962 bytes are on the declaration, beside the
   * other project-varying pushes.
   */
  names.push(...tableProfileToolNames(root, { maxRounds }));
  /**
   * ⭐ AND `inspect_binary` RIDES WITH IT, for the identical reasons one comment
   * up — same family, same multi-round rule, not gated on `allowRun` because the
   * shell-less surface is precisely the one with no `xxd` to fall back to, and
   * gated on EVIDENCE because the tool surface has 487 bytes of headroom and this
   * schema is 1,071.
   */
  names.push(...binaryInspectToolNames(root, { maxRounds }));

  /**
   * ── ⭐ `list_engines` — MULTI-ROUND ONLY, AND FOR THE STRONGEST VERSION OF
   * THE DEAD-BUTTON RULE ────────────────────────────────────────────────────
   *
   * Its answer exists to change the NEXT call — "ultra costs 48 credits an
   * image, the core one costs 4, which do you want". In a single-shot turn
   * there is no next call, so it would burn the only round finding out a price
   * it can never use.
   *
   * ⚠️ NOT GATED ON `imageConfig`. It answers a question about the ACCOUNT, not
   * about whether a render endpoint is configured on this machine — and "what
   * would this cost me" is a fair question to ask before setting anything up.
   */
  names.push('list_engines');

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
  /**
   * ⭐ DECLARED SINCE FOREVER, NAMED SINCE 2026-08-20. `review_code` reads a
   * file already on disk — no key, no endpoint, no process — and `code-review
   * .mjs` has been telling users to "run `review_code` on the file" the whole
   * time. 418 tokens.
   */
  names.push('review_code');
  /**
   * ⚠️ THE DB PAIR IS GATED ON EVIDENCE, not offered blindly: 835 tokens on
   * every turn is real money in a package whose binding constraint is the token
   * budget. Same shape as `skillsAvailable` and `lspAvailable` above.
   */
  if (dbEvidence(root, env)) names.push('inspect_db', 'sample_db_rows');
  if (skillsAvailable(root)) names.push('read_skill');
  /**
   * ── ⭐ THE PLAYTESTER — OFFERED ONLY WHERE THERE IS A BROWSER TO DRIVE ─────
   *
   * ⚠️ Gated three ways, and each one is this file's standing rule rather than
   * a new one: `allowRun` (it starts a child process — `--no-run` must withhold
   * it or the flag is a lie by a side door), multi-round (a list of defects is
   * worth paying for only if a round remains to fix them), and evidence that a
   * browser MCP server is configured in THIS workspace. On a machine with none
   * it could only ever answer "no browser is configured", which teaches the
   * model to try, wait and apologise — a dead button by another name.
   */
  names.push(...playtestToolNames(root, env, { allowRun, maxRounds }));

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
   * ⭐ `write_files` RIDES WITH THE WRITE CAPABILITY, not with a round budget.
   * It is `write_file` for more than one file; anywhere the model may write, it
   * may write several. Offering it only in long runs would leave the bulk edit
   * exactly where it was — inside `evaluate`, where nothing can see it.
   */
  names.push('write_files');

  /**
   * ── ⭐⭐ `apply_patch` — MULTI-ROUND ONLY, AND THAT IS NOT AN OVERSIGHT ─────
   *
   * ⭐ WHY IT IS OFFERED AT ALL: output is 56% of a build's spend ($0.045 of
   * $0.080, ~53,000 tokens) and a prompt cache — already at 83.2% and 100%
   * steady-state — cannot discount output at all. The output is dominated by
   * re-emitting whole files, and a patch is 10-50x smaller. It is also the
   * accuracy fix: flexible patch application measures 9x fewer editing errors.
   *
   * ⚠️ WHY NOT IN `SINGLE_SHOT_TOOL_NAMES`: a patch's context lines must match
   * the file ON DISK, and when they do not the only repair is the next round.
   * A one-round turn has none, so it would be precisely the dead button this
   * file spends four hundred lines refusing to ship — and `write_file` still
   * works there, so withholding it costs the user nothing.
   */
  names.push('apply_patch');

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
   *
   * ── ⚠️⚠️ AND SINCE 2026-09-19 THERE IS A THIRD WAY, WHICH FORCED THIS LINE
   *         TO GROW A LANGUAGE CHECK ────────────────────────────────────────
   *
   * `tsserverAvailable` now also finds the copy a user installed with
   * `acuvo lsp install`, which lives under HOME and is therefore reachable from
   * EVERY workspace on the machine — including a Rust one. Left as it was, that
   * would have offered four TypeScript tools inside a `Cargo.toml` repo where
   * `runTsserverTool` can only ever answer *"tsserver handles TypeScript and
   * JavaScript files; main.rs is neither"*. That is precisely the dead button
   * `lspAvailable`'s own header spent a page learning to refuse, reintroduced
   * from the other side by a capability that made a server unconditionally
   * present.
   *
   * ⭐ So the managed server is intersected with the same evidence
   * `lspAvailable` uses — does this workspace visibly contain TypeScript or
   * JavaScript — while a server found INSIDE the tree still stands on its own.
   * A `node_modules/typescript` in the tree IS the evidence; nothing else has to
   * agree with it.
   */
  /**
   * ⚠️ `env` AND `home` ARE THREADED, NOT DEFAULTED. The managed server lives
   * under `ACUVO_HOME` (or `~/.acuvo`), so a caller that names a home — every
   * test asserting a tool list, and `tool-prefix.mjs`'s prefix derivation — must
   * get an answer about THAT home. Letting `managedTsserver()` reach for the
   * real one made the first version of `test/symbol-tools-are-not-dark-on-a-
   * fresh-install.test.mjs` pass or fail depending on whether the machine
   * running it had done `acuvo lsp install`, which is not a test.
   */
  const tsInTree = tsserverAvailable(root, { allowManaged: false });
  const tsManaged = !tsInTree && tsserverAvailable(root, { env, home }) && languagesPresent(root).has('typescript');
  if (lspAvailable(root, env) || tsInTree || tsManaged) {
    names.push(...LSP_TOOL_NAMES);
    /**
     * ── ⭐⭐ `rename_symbol` RIDES WITH THEM, AND ONLY WITH THEM ──────────────
     *
     * ⚠️ IT IS NOT GATED ON A WRITE FLAG, and that is deliberate rather than an
     * omission. `write_file` itself is unconditional here — the `--plan` and
     * `--dry-run` executors replace `executor.writeFile` with a refusal instead
     * of removing the verb, so the capability lives at the executor and there is
     * exactly one place that decides it. Adding a second gate here would be a
     * copy of that decision, and the copy is the one that goes stale.
     *
     * ⭐ THE GATE THAT DOES MATTER IS THE SERVER, because without one this tool
     * cannot answer at all — it has no string-matching fallback and must not
     * grow one. A rename that guesses is `edit_file`, which already exists.
     */
    names.push(RENAME_TOOL_NAME);
    /**
     * ⭐ THE SAME GATE, DELIBERATELY. All four need a compiler in the project
     * and none has a degraded mode; offering an AST edit where nothing can parse
     * the file teaches the model to try, wait and apologise.
     */
    names.push(...TS_EDIT_TOOL_NAMES);
  }

  return withoutEgress(withImage(names), env);
}

/**
 * ── ⭐⭐⭐ `--offline` / `ACUVO_OFFLINE` — THE THREE VERBS THAT REACH A
 *          STRANGER WITH NO CONFIGURATION AT ALL ────────────────────────────
 *
 * ⚠️⚠️ THE LIST IS NOT "every tool that touches a network", and the difference
 * is the whole design. Every OTHER networked verb in this package is already
 * gated on a credential an operator supplied deliberately — the media tools on
 * `ACUVO_MEDIA_SECRET` or a signed-in account, push on `ACUVO_ALLOW_PUSH`, the
 * deploy verbs on their own switch. Those are egress somebody CHOSE.
 *
 * These three are the ones that need nothing:
 *
 *   fetch_url       any URL the model names, on a bare install
 *   web_search      the query leaves the machine, on a bare install
 *   generate_image  ⭐ the prompt goes to perchance.org and pollinations.ai —
 *                   `imageConfig` DEFAULTS to configured, so this fires with no
 *                   key, no account and no config. `ENTERPRISE.md` §2.2 calls it
 *                   "easy to miss"; `doctor.mjs`'s `imageDestination` exists
 *                   because the destination was misreported for weeks.
 *
 * Caps are not gates. `MAX_FETCHES_PER_PROCESS = 10` and
 * `MAX_SEARCHES_PER_PROCESS = 12` bound how MUCH leaves; they cannot express
 * "none". An operator on a machine that must not talk to strangers had no way
 * to say so short of forbidding each verb by name in a policy file.
 *
 * ── ⚠️ WHAT THIS FLAG DOES *NOT* CLAIM, STATED SO NOBODY OVER-READS IT ─────
 *
 * It does NOT mean "nothing leaves the machine" on a normal run. **The model
 * chain is egress** — that is what the run IS — and an MCP server an operator
 * registered is a program we spawn, not a verb we gate. The claim is exactly
 * this: no tool Acuvo ships reaches a third party that the operator did not
 * separately configure. Anything broader would be the unscoped-absolute defect
 * this repo has already paid for.
 *
 * ⭐ NARROWING ONLY, so it needs none of the `envLoad`-ordering argument its
 * three neighbours in `bin/acuvo.mjs` carry: a repository's `.env.local` that
 * sets this can only take capability away from itself.
 */
export const OFFLINE_ENV = 'ACUVO_OFFLINE';

/** The three, exported so the doctor and the tests read one list. */
export const UNCONFIGURED_EGRESS_TOOL_NAMES = Object.freeze(['fetch_url', 'web_search', 'generate_image']);

/**
 * ⚠️ AN EXPLICIT `0`/`false` IS OFF, and anything else non-empty is ON. Same
 * three-state reading `mediaConfig` uses for its URLs: unset, set, and
 * deliberately neutralised are three different statements.
 */
export function offlineEnabled(env = process.env) {
  const v = String(env?.[OFFLINE_ENV] ?? '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

/**
 * ⚠️ ABSENCE, NOT REFUSAL, AT THE OFFER — the rule this file applies to every
 * unconfigured capability. A tool that is offered and always says no costs a
 * schema every round and teaches the model to spend one discovering a dead
 * button. The dispatch guard below is the SECOND gate, for the caller that
 * hands a name in directly.
 */
function withoutEgress(names, env) {
  if (!offlineEnabled(env)) return names;
  return names.filter((n) => !UNCONFIGURED_EGRESS_TOOL_NAMES.includes(n));
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

/**
 * `run_command`'s `expectExit`, applied to a result. Only an integer is honoured,
 * only a process that ENDED by itself is judged (a kill or timeout has no exit
 * code to compare), and `expectedExit` is carried on the result so the verdict,
 * the transcript and the stale re-run all see the same expectation.
 */
export function withExpectedExit(result, expectExit) {
  if (!Number.isInteger(expectExit) || !result || result.ok !== true) return result;
  if (result.timedOut === true || typeof result.exitCode !== 'number') return result;
  return { ...result, expectedExit: expectExit, passed: result.exitCode === expectExit };
}

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
/* ────────────────────────────────────────────────────────────────────────────
 * ── ⭐⭐⭐ THE REFUSAL THAT COST FOUR ROUNDS AND MISDIAGNOSED ITSELF ─────────
 *
 * Pulled out of this package's own stored runs, not imagined. Tallying every
 * `"error"` string across 3,859 transcript files put this fourth by count — and
 * FIRST by rounds burned, because all four hits are one task going round in
 * circles. `bench/terminal-bench/results/deep100/break-filter-js-from-html…`,
 * verbatim from `acuvo-stderr.log`:
 *
 *   ✖ write_file: tool arguments were not valid JSON: Unterminated string in
 *                 JSON at position 25744 (line 1 column 25745)
 *   ── round 3/100 ── "That was a mess. Let me write a clean, focused test
 *                      script instead."
 *   ✖ write_file: … Unterminated string in JSON at position 36459
 *   ── round 4/100 ── "I'm overcomplicating this. Let me write a clean, small
 *                      test script with just the meaningful payloads."
 *   ✖ write_file: … Unterminated string in JSON at position 36633
 *   ── round 5/100 ── "I keep generating huge redundant content. Let me stop
 *                      and write a small, clean test script…"
 *   ✖ write_file: … Unterminated string in JSON at position 36793
 *   ↻ going in circles (no-progress) — one hint sent, budget untouched.
 *
 * ⭐ READ WHAT THE MODEL CONCLUDED. Every time, it blamed the QUALITY of its own
 * content — "a mess", "overcomplicating", "redundant" — and rewrote it. The
 * actual fact is arithmetic: its reply hit the output limit and the argument
 * blob was cut off mid-string. It shortened the content three times and still
 * got cut at 36k, because 36k is where the ceiling is, not where the waffle was.
 * The refusal handed it a parser position and no interpretation, so the one
 * thing it could not deduce is the one thing it needed. `stuck.mjs` eventually
 * fired — after three paid rounds, and on an append-only transcript all four
 * failures are re-sent for the remaining 95 rounds.
 *
 * ⚠️ TRUNCATION IS DETECTABLE EXACTLY, NOT GUESSED. V8 reports the failure
 * position, and for a cut-off payload that position IS the end of the string
 * (probed 2026-08-26: a 52-char blob ending mid-string → "Unterminated string in
 * JSON at position 52"; `{"a":1,"b":` → "Unexpected end of JSON input", which
 * carries no position at all). A syntax error made in the MIDDLE reports a
 * position well short of the length, and gets different advice, because it has a
 * different fix.
 *
 * ⚠️ AND THE THIRD CASE IS THE ONE MODELS ACTUALLY HIT WHEN THEY ARE NOT CUT
 * OFF: a raw newline inside a JSON string. Probed — `{"content":"a\nb"}` with a
 * literal newline gives "Bad control character in string literal in JSON at
 * position 27". That is not a mysterious parse failure, it is one escaping rule,
 * so it gets named instead of described.
 *
 * ⚠️ ZERO SCHEMA BYTES. This is a runtime result string; nothing here is added
 * to any tool schema, so it costs nothing on the rounds where it does not fire.
 * The suite asserts that.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What to do about a tool-argument blob that would not parse. Pure, and separate
 * from `parseToolArguments` so the classification can be tested against real V8
 * messages without a tool call around it.
 *
 * @param {string} message the `JSON.parse` failure, verbatim
 * @param {string} raw     the blob that failed
 * @returns {string} a suffix, always beginning with a space
 */
export function jsonArgumentNextMove(message, raw) {
  /**
   * ⚠️ A NON-STRING `raw` MUST NOT READ AS TRUNCATION. Length 0 would make every
   * reported position look like the end of the blob, and the model would be told
   * its arguments were cut off when they were not — a confident wrong diagnosis,
   * which costs the same round the bare refusal did.
   */
  const length = typeof raw === 'string' ? raw.length : null;
  const at = /position (\d+)/.exec(message);
  const cutOff = /Unexpected end of (?:JSON )?input/i.test(message)
    || (at !== null && length !== null && Number(at[1]) >= length - 1);
  if (cutOff) {
    return ` — the JSON simply STOPS at the end of ${length ?? 0} characters, so this was cut off by the reply`
      + ' limit, not mistyped. Nothing ran. Sending the same content again will be cut in the same place:'
      + ' write a SMALL first piece, then add the rest with edit_file.';
  }
  if (/control character/i.test(message)) {
    return ' — a raw newline or tab inside a JSON string. Nothing ran. Escape them (\\n, \\t) and send the'
      + ' call again; file content is a JSON string value, not a fenced block.';
  }
  return ' — nothing ran. Send this one call again with the arguments as a single JSON object using the keys'
    + ' this tool declares.';
}

export function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, args: {} };
  if (typeof raw === 'object') return { ok: true, args: raw };
  if (typeof raw !== 'string') return { ok: false, error: 'tool arguments were neither a string nor an object — send them as one JSON object.' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    /**
     * ⚠️ THE PARSER MESSAGE STAYS, AND STAYS FIRST. `test/rcfile-wiring` and
     * `test/mcp-list-remove` match `/not valid JSON/` on sibling messages, four
     * suites match this family by its head, and the position is genuinely useful
     * when the blob was mistyped rather than cut. Everything here APPENDS.
     */
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `tool arguments were not valid JSON: ${message}${jsonArgumentNextMove(message, raw)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `tool arguments must be a JSON object — you sent ${Array.isArray(parsed) ? 'an array' : JSON.stringify(parsed)}.`
        + ' Wrap the values in { } with this tool\'s argument names as the keys.',
    };
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
/**
 * ── ⭐⭐ THE WRITE REVIEW SEAM ───────────────────────────────────────────────
 *
 * Returns a refusal RESULT when the person said no, and `null` when the write
 * should proceed. `null` is the do-nothing answer so that every caller without
 * an approver — which is every existing caller, the MCP server, the acceptance
 * harness and every test — is byte-identical.
 *
 * ⚠️ IT READS `before` THROUGH THE EXECUTOR, never through `fs`. The in-memory
 * executor that lets the browser builder run this loop has no filesystem, and a
 * direct read here would make the gate silently wrong in exactly the place the
 * registry exists to serve.
 */
/**
 * ── ⭐⭐ THE PRE-COMMIT LINT, AS ONE HELPER SO IT CANNOT DRIFT PER VERB ──────
 *
 * Reads `before` THROUGH THE EXECUTOR for the same reason `gateWrite` does: the
 * in-memory executor the browser builder runs has no filesystem, and a direct
 * `fs` read here would make the check silently absent in exactly the place the
 * registry exists to serve.
 *
 * ⚠️ IT NEVER THROWS AND NEVER DECIDES ANYTHING ON ITS OWN. A file it cannot
 * read is a NEW file for checking purposes, which means the definitive branch
 * has no "was valid before" and therefore cannot block — the failure direction
 * is always "say nothing", never "refuse a correct edit".
 */
function preCommitCheck(executor, path, after, budget) {
  /**
   * ⚠️ THE EXTENSION IS CHECKED BEFORE THE DISK IS. A `.md` or a `.png` can
   * never produce a verdict, and reading it first would put a pointless
   * round-trip on every write in the package — including a 45-file
   * `write_files` batch, where it would be 45 of them.
   */
  if (!isCheckablePath(path)) return { block: null, note: null };
  let before = null;
  try {
    const read = executor.readFile(path);
    if (read && read.ok !== false && typeof read.content === 'string') before = read.content;
  } catch { /* unreadable is "new file"; the check then cannot block */ }
  return editGate(path, before, after, budget);
}

/* ────────────────────────────────────────────────────────────────────────────
 * ── ⭐⭐⭐ SWE-agent's SECOND ACI IDEA, FINISHED: A REAL PARSER AT EDIT TIME ──
 *
 * `edit-diagnostics.mjs` already had the SHAPE of this right — refuse before the
 * bytes land, only on a proven regression, and never on a heuristic. What it did
 * not have was a parser for the language this package is written in. Read its
 * own two rules together and the hole is obvious:
 *
 *     const DEFINITIVE   = new Set(['.json']);                       // may BLOCK
 *     const BRACE_LANGUAGES = new Set(['.js','.mjs','.cjs','.ts',…]) // may only WARN
 *
 * So for every JavaScript file in the workspace the strongest thing the edit gate
 * could say was *"the bracket count moved"* — and it said it as a note appended
 * to a SUCCESSFUL write. The broken file lands, the model runs something, the
 * command fails a round later, and on an append-only transcript that failing
 * round is re-sent for the rest of the run. One paid round to find out, then
 * every subsequent round carries the wreckage.
 *
 * ── ⭐ WHAT A REAL PARSER BUYS OVER THE BRACE COUNT, MEASURED ────────────────
 * Six realistic broken-edit shapes through `bracketBalance` and through the
 * parser, 2026-08-26 (the probe is reproduced in the suite):
 *
 *     shape                                    balance   parser
 *     function f( { return a; }                   1        ERR   ← both
 *     stray closing brace                        -1        ERR   ← both
 *     truncated function (the classic bad edit)   1        ERR   ← both
 *     const a = 1; const a = 2;                   0        ERR   ← PARSER ONLY
 *     await outside an async function             0        ERR   ← PARSER ONLY
 *     unterminated string literal                 0        ERR   ← PARSER ONLY
 *
 * Three of six are invisible to bracket counting, and all three are edits a model
 * really makes: re-declaring a name it thought it was replacing, pasting an
 * `await` into a non-async helper, and losing a quote inside a long string.
 *
 * ── ⚠️ THE CHECK NEVER RUNS THE CODE. PROVEN, NOT ASSUMED ───────────────────
 * `node --check` parses and exits; probed 2026-08-26 by feeding it a module
 * whose body is `writeFileSync(marker,'EXECUTED')` plus a `console.log`, and the
 * marker file was never created and stdout was empty. `new vm.Script(src)`
 * likewise COMPILES without executing — the same probe set a global and read it
 * back as `false`. This gate is a parser, not an evaluator, and it must stay one:
 * the content it is handed is model-authored and unreviewed.
 *
 * ── ⚠️ THE FAST PATH IS WHY THIS IS AFFORDABLE ──────────────────────────────
 * A spawn costs ~105ms (20 runs, mean 105.5ms, worst 128ms, on a 35KB file).
 * `new vm.Script()` costs **0.09ms** (200 compiles of that same file in 18ms) —
 * about 1,200× less — and it is a real V8 parse, not an approximation. It only
 * understands the SCRIPT goal, so it settles `.cjs` and CommonJS `.js` outright
 * and never spawns for them; a file that fails it *because of ESM syntax* is the
 * only case that escalates. The ESM refusals are distinguishable by message, and
 * all four were captured from V8 rather than guessed:
 *
 *     "Cannot use import statement outside a module"
 *     "Unexpected token 'export'"
 *     "await is only valid in async functions and the top level bodies of modules"
 *     "Cannot use 'import.meta' outside a module"
 *
 * ⭐ RE-MEASURED END TO END THROUGH `editGate` ITSELF, 2026-08-26, idle machine,
 * on a real 34,987-byte module — because the per-file number above is the cost of
 * the CHECK and what the edit path actually pays is the cost of the GATE:
 *
 *     clean .mjs edit, cold cache   172.1ms
 *     clean .mjs edit, warm cache    14.5ms   ← the second look at the same bytes
 *     BROKEN .mjs edit (blocked)    324.8ms   ← before-image + after-image
 *     markdown edit                   0.17ms  ← no parseable extension, no cost
 *     .tsx edit                       0.04ms
 *
 * So the answer to "can this run inside the edit path" is yes and it is not close:
 * the worst case is a third of a second against a model round that costs seconds
 * and money, and the round it saves is one that would then be re-sent on every
 * subsequent round of an append-only transcript.
 *
 * ⚠️ AND THE SAFETY CLAIM WAS RE-PROVED AGAINST THE SHIPPED INVOCATION, not a
 * near-relative of it: `spawnSync(node, ['--input-type=module','--check'])` fed a
 * module whose body is `writeFileSync(marker,'EXECUTED')` plus a `console.log`
 * exited 0 with EMPTY stdout and NO marker file on disk, while a broken module
 * exited 1 with `[stdin]:2 / SyntaxError`. Parser, not evaluator — confirmed
 * twice now, by two different people, on the exact argv this file uses.
 *
 * ── ⚠️ WHAT IT DELIBERATELY CANNOT SEE ──────────────────────────────────────
 *   · `.ts` / `.tsx` / `.jsx` — a type annotation and a JSX element are both hard
 *     syntax errors to V8 (probed: `export const a: number = 1` → SyntaxError;
 *     `<div />` → SyntaxError). This node has no TypeScript. Those extensions
 *     keep the brace heuristic and nothing else, exactly as before.
 *   · The sloppy-only constructs that a SCRIPT accepts and a MODULE rejects —
 *     `with`, legacy octal literals, and friends. A `.mjs` is therefore probed
 *     with `'use strict';` prepended so those are caught too; a `.js` is not,
 *     because a `.js` may legitimately be sloppy CommonJS. So a `with` block
 *     added to a `type:module` `.js` is a MISS. A miss is safe — it falls through
 *     to the post-write language-server layer, which is where it used to be
 *     caught anyway.
 *
 * ── ⚠️⚠️ AND THE BLOCKING RULE IS UNCHANGED, ON PURPOSE ─────────────────────
 * A refusal still needs BOTH facts: valid before, invalid after. `.json` has
 * worked that way since it was written and its suite pins the consequence
 * (`checkEditBeforeCommit('new.json', null, '{ oops }').block === null`) — a file
 * that did not parse before this edit is not this edit's fault. A brand-new file
 * that does not parse gets a NOTE, never a block, because there is no "before" to
 * prove a regression against and because a deliberately-unparseable fixture is a
 * real thing people write.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The extensions V8 can parse as-is. `.ts` is absent because it cannot. */
const PARSEABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/**
 * ⚠️ ABOVE THIS, SAY NOTHING. `MAX_WRITE_BYTES` is 400,000 so this is well clear
 * of any write that can reach the gate; the ceiling exists so a pathological
 * caller (the in-memory executor, a test, a future bulk verb) cannot turn one
 * edit into a multi-second blocking spawn. Measured on real input: 267KB → 120ms,
 * 1.4MB → 250ms, 2.8MB → 407ms, so 1MB is ~250ms of worst case.
 */
const SYNTAX_CHECK_MAX_BYTES = 1_000_000;

/** A parser that has not answered in five seconds is not going to. */
const SYNTAX_CHECK_TIMEOUT_MS = 5_000;

/**
 * ⚠️ SPAWNS PER TOOL CALL, NOT PER FILE. `write_files` writes up to 45 files and
 * `apply_patch` touches a whole batch; at ~105ms an unbounded loop turns one tool
 * call into five blocking seconds. Twelve covers the after-image and the
 * before-image of the first several files — which is where a batch's first
 * refusal comes from anyway, since the loop returns on the FIRST block — and past
 * it the gate goes quiet rather than slow. Silence is the designed degradation
 * everywhere else in this seam and it is the designed degradation here.
 */
const SYNTAX_CHECK_BATCH_SPAWNS = 12;

/** A fresh budget for a single-file verb: after-image, before-image, slack. */
const singleFileSpawnBudget = () => ({ spawns: 4 });

/**
 * ── ⭐ THE VERDICT CACHE, AND THE MEASUREMENT THAT FORCED IT ────────────────
 *
 * The fast path above is real but it is NOT the common case in this codebase,
 * and saying otherwise would be the kind of unmeasured claim this file exists to
 * stop. Every one of the 444 `.mjs`/`.js`/`.cjs` files under `lib/ bin/ scripts/
 * test/` was run through `nodeSyntaxVerdict` on 2026-08-26:
 *
 *     parsed OK 444 · reported broken 0 · abstained 0
 *     escalating spawns: 444 of 444 — 100% needed a child process
 *     71,046ms total, mean 160.0ms per file
 *
 * Zero false positives, which is the number that decides whether this may block.
 * But 100% escalation, because every file in this package starts with `import`,
 * so the 0.09ms compile only ever settles the FIRST question ("is it ESM?").
 *
 * ⭐ WHAT IS ACTUALLY REPEATED IS THE CONTENT, NOT THE FILE. A refusal costs a
 * second escalation on the BEFORE image — and that before image is, in a real
 * session, byte-identical to the after image this gate already blessed on the
 * previous round. Same for a `write_file` re-issued after an approval prompt,
 * and for `write_files` batches that share a header. Keyed by content hash those
 * are all free.
 *
 * ⚠️ HASHED, NOT KEYED ON THE SOURCE ITSELF. 128 entries × up to
 * `MAX_WRITE_BYTES` of retained string is 51MB of heap for a cache; a SHA-1 of
 * the 182KB `tools.mjs` costs 0.95ms measured (1,000 in 958ms), i.e. ~170× less
 * than the spawn it avoids, and it retains 40 bytes.
 *
 * ⚠️ THE GOAL IS PART OF THE KEY. A `.mjs` is probed with `'use strict';`
 * prepended and a `.cjs` is not, so the same bytes can have two honest verdicts.
 *
 * ⚠️ AND AN ABSTENTION IS NEVER CACHED. `{ ok: null }` means "could not decide
 * THIS TIME" — an exhausted budget, a spawn that would not start — and caching
 * it would turn a transient condition into a permanent blind spot for the rest of
 * the process.
 */
const SYNTAX_VERDICT_CACHE_MAX = 128;
const syntaxVerdicts = new Map();

/** Tests only — a leaked verdict hides a real error, exactly like `resetBaselines`. */
export function resetSyntaxVerdictCache() {
  syntaxVerdicts.clear();
}

function cacheVerdict(key, verdict) {
  if (verdict.ok === null) return verdict;
  // Insertion-ordered eviction: the oldest key is the first one Map yields.
  if (syntaxVerdicts.size >= SYNTAX_VERDICT_CACHE_MAX) {
    const oldest = syntaxVerdicts.keys().next().value;
    if (oldest !== undefined) syntaxVerdicts.delete(oldest);
  }
  syntaxVerdicts.set(key, verdict);
  return verdict;
}

const parseableExtensionOf = (path) => {
  const s = String(path ?? '');
  const dot = s.lastIndexOf('.');
  return dot > 0 ? s.slice(dot).toLowerCase() : '';
};

/**
 * Is this SyntaxError only an error because V8 was asked for the SCRIPT goal?
 *
 * ⚠️ MATCHED ON THE MESSAGE, AND THE MESSAGES ARE CAPTURED, NOT REMEMBERED. Each
 * of the four was produced by `new vm.Script(...)` on this Node and pasted in.
 * Getting this wrong in the "yes" direction costs a spawn we did not need; in the
 * "no" direction it would report a perfectly good ES module as broken, so the
 * test for it is not "close enough" but the literal strings.
 *
 * Pure.
 */
function isModuleOnlySyntax(message) {
  const m = String(message ?? '');
  return m.includes('import statement outside a module')
    || m.includes("Unexpected token 'export'")
    || m.includes('await is only valid in async functions')
    || m.includes("Cannot use 'import.meta' outside a module");
}

/**
 * V8's verdict on one source string, as `{ ok: true }`, `{ ok: false, error }`
 * or `{ ok: null }` for "could not decide".
 *
 * ⚠️ `{ ok: null }` IS NOT A FAILURE, IT IS AN ABSTENTION, and every unexpected
 * condition maps to it: an extension V8 cannot read, a file over the ceiling, a
 * spawn that could not start, a timeout, a non-zero exit whose stderr is not a
 * SyntaxError (that is the checker failing, not the code), an exhausted budget.
 * The one thing this function may never do is turn "I don't know" into "broken".
 *
 * @param {string} path
 * @param {unknown} source
 * @param {{ spawns: number }} budget  mutated: each escalation costs one
 */
export function nodeSyntaxVerdict(path, source, budget) {
  const ext = parseableExtensionOf(path);
  if (!PARSEABLE_EXTENSIONS.has(ext)) return { ok: null };
  if (typeof source !== 'string') return { ok: null };
  if (Buffer.byteLength(source, 'utf8') > SYNTAX_CHECK_MAX_BYTES) return { ok: null };

  /**
   * ⚠️ THE CACHE IS CONSULTED BEFORE THE COMPILE, NOT BEFORE THE SPAWN. The
   * `vm.Script` probe is 0.09ms and the hash is ~0.95ms on a 182KB file, so on
   * paper the compile is the cheaper miss — but the probe is only ever a
   * PREAMBLE to the 160ms escalation for ESM, which is 100% of this package's
   * files. Checking here is what makes a hit cost one hash instead of one spawn.
   */
  const key = `${ext}:${createHash('sha1').update(source).digest('hex')}`;
  const cached = syntaxVerdicts.get(key);
  if (cached) return cached;

  /**
   * ⭐ THE 0.09ms PATH. A module is always strict, so a `.mjs` is probed with the
   * directive prepended and the sloppy-only constructs are caught here rather
   * than missed. The prefix shifts line numbers by one, which is why the LINE
   * that reaches the model always comes from the escalation below and never from
   * this compile.
   */
  const probe = ext === '.mjs' ? `'use strict';\n${source}` : source;
  try {
    // eslint-disable-next-line no-new -- compiling IS the check; nothing is run.
    new vm.Script(probe, { filename: 'edit-check', displayErrors: false });
    return cacheVerdict(key, { ok: true });
  } catch (err) {
    if (!(err instanceof SyntaxError)) return { ok: null };
    /**
     * ⚠️ A `.cjs` NEVER ESCALATES. If it failed for an ESM reason then it really
     * does contain `import`/`export`, which is invalid in a CommonJS file — but
     * saying so is a MODULE-SYSTEM opinion, not a syntax verdict, and this gate
     * has no business blocking a write over it. Abstain.
     */
    if (ext === '.cjs') {
      return isModuleOnlySyntax(err.message)
        ? { ok: null }
        : cacheVerdict(key, { ok: false, error: terseSyntaxError(err.message, lineOfVmError(err)) });
    }
    /**
     * ⚠️ A `.js` ESCALATES ONLY FOR AN ESM MESSAGE. Anything else it rejects in
     * the script goal it also rejects in the module goal — the module goal adds
     * import/export/top-level-await/import.meta and takes away only sloppy-mode
     * permissiveness, which can never turn a rejection into an acceptance. So a
     * genuine break is already decided and the spawn would be 105ms for an answer
     * we hold.
     */
    if (ext === '.js' && !isModuleOnlySyntax(err.message)) {
      return cacheVerdict(key, { ok: false, error: terseSyntaxError(err.message, lineOfVmError(err)) });
    }
  }
  return cacheVerdict(key, moduleGoalVerdict(source, budget));
}

/** The 1-indexed line out of a `vm.Script` SyntaxError's `filename:line` head. */
function lineOfVmError(err) {
  const head = String(err?.stack ?? '').split('\n')[0] ?? '';
  const m = /:(\d+)$/.exec(head.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The escalation: V8 in the MODULE goal, in a child, with the source on stdin.
 *
 * ⚠️ STDIN, NEVER A TEMP FILE. Three reasons and all of them bit something else
 * in this package first: the after-image is not on disk yet and writing it there
 * to check it would be the very mutation the gate exists to prevent; a temp file
 * would put a model-authored path into the error text; and `[stdin]` keeps an
 * absolute filesystem path out of a string that goes straight into the prompt.
 * Probed to 2.8MB with no truncation, so there is no size at which stdin is the
 * wrong choice here.
 *
 * ⚠️ `--check` DOES NOT EXECUTE — see the proof in the block above. Do not
 * "improve" this to `node -e`, `import()` or a `Function` constructor.
 */
function moduleGoalVerdict(source, budget) {
  if (!budget || !(budget.spawns > 0)) return { ok: null };
  budget.spawns -= 1;
  let r;
  try {
    r = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: source,
      encoding: 'utf8',
      timeout: SYNTAX_CHECK_TIMEOUT_MS,
      maxBuffer: 4_000_000,
      windowsHide: true,
    });
  } catch {
    return { ok: null };
  }
  if (!r || r.error || typeof r.status !== 'number') return { ok: null };
  if (r.status === 0) return { ok: true };
  const stderr = String(r.stderr ?? '');
  const message = /^\s*SyntaxError: (.+)$/m.exec(stderr);
  /**
   * ⚠️ A NON-ZERO EXIT WITHOUT A SyntaxError IS THE CHECKER FAILING, NOT THE
   * CODE. That is not hypothetical: pointing this at a `.ts` file by path
   * produced `ERR_UNKNOWN_FILE_EXTENSION` with the same exit code, and reading
   * that as "your edit is broken" is precisely the false refusal this whole seam
   * is built to avoid.
   */
  if (!message) return { ok: null };
  const at = /^\[stdin\]:(\d+)/m.exec(stderr);
  return { ok: false, error: terseSyntaxError(message[1], at ? Number(at[1]) : null) };
}

/**
 * One line: where, and what. ⚠️ TERSE IS THE POINT — SWE-agent's finding is that
 * a structured, short error outperforms a verbose one, and V8's stderr carries
 * four lines of caret art plus an internal stack trace that names Node's own
 * source files. None of that helps a model fix a brace.
 */
function terseSyntaxError(message, line) {
  const text = String(message ?? 'invalid syntax').replace(/\s+/g, ' ').trim().slice(0, 200);
  return line === null || !Number.isFinite(line) ? text : `line ${line}: ${text}`;
}

/**
 * ── ⭐ THE ONE GATE ALL FOUR WRITING VERBS GO THROUGH ────────────────────────
 *
 * `checkEditBeforeCommit` first (it is free and it owns `.json`), then the
 * parser. Composed here in the dispatcher rather than inside
 * `edit-diagnostics.mjs` for the reason this file already gives twice — the
 * executor has non-model callers (`--doctor`, the acceptance harness, the
 * browser builder's Map-backed executor) and a spawn belongs at the MODEL's
 * door, not in shared plumbing that runs on every internal read.
 *
 * ⚠️ IT NEVER THROWS. Every branch is wrapped, because the failure direction is
 * always "say nothing", never "refuse a correct edit".
 */
export function editGate(path, before, after, budget) {
  let base = { block: null, note: null };
  try {
    base = checkEditBeforeCommit(path, before, after) ?? base;
  } catch { base = { block: null, note: null }; }
  // A `.json` refusal is already definitive and already terse; no parse needed.
  if (base.block) return base;

  const spawnBudget = budget ?? singleFileSpawnBudget();
  let verdict;
  try {
    verdict = nodeSyntaxVerdict(path, after, spawnBudget);
  } catch { return base; }
  if (verdict.ok === null) return base;

  if (verdict.ok === true) {
    /**
     * ⭐ A REAL PARSER OUTRANKS THE HEURISTIC, so the brace note is DROPPED when
     * V8 says the file is fine. That is not tidiness: `bracketBalance`'s own
     * header records that its first version mis-read 326 of 381 real files, and
     * a warning that contradicts a parser is exactly the noise SWE-agent's
     * "errors only, never style" rule exists to keep out of the transcript.
     * Every byte of it would otherwise ride every remaining round.
     */
    return { block: null, note: null };
  }

  /**
   * ⚠️ THE DELTA, NOT THE CHECK, IS WHAT MAKES A REFUSAL SAFE. Same rule the
   * `.json` branch has always used. A file that did not parse before this edit
   * is not this edit's fault, and a file that did not EXIST before has no
   * regression to prove — both get a note instead.
   */
  let wasValid = false;
  if (typeof before === 'string') {
    try { wasValid = nodeSyntaxVerdict(path, before, spawnBudget).ok === true; } catch { wasValid = false; }
  }

  if (!wasValid) {
    return {
      block: null,
      note: `\n<edit-check file="${path}">${path} does not parse as JavaScript: ${verdict.error}. `
        + 'It did not parse before this edit either, so the write went through — but nothing that imports it '
        + 'will run until this is fixed.</edit-check>',
    };
  }

  /**
   * ⚠️ THE REFUSAL NAMES THE STATE OF THE DISK, then the next move. A model that
   * is not told the file is unchanged assumes a partial write and re-reads to
   * find out, which is the round this gate just saved.
   */
  return {
    block: `${path} would stop parsing as JavaScript: ${verdict.error}. `
      + 'NOTHING WAS WRITTEN — the file on disk is unchanged and still correct. '
      + 'Re-read that line, fix the fragment, and edit again.',
    note: null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * ── ⭐⭐⭐ SWE-agent's FIRST ACI IDEA, WIRED TO THE DOOR THE MODEL KNOCKS ON ──
 *
 * `read-window.mjs` already implements the windowed viewer, and it is very good:
 * it truncates at the END, hands back `totalLines` and `nextOffset`, and refuses
 * an argument it does not implement. Its own header records why it exists —
 * probe 4 asked for `lib/tools.mjs`, and the model, *unprompted and without ever
 * being told the argument existed*, sent `{path, offset:1560, limit:80}`, then
 * 1380, then 1395, then 1280:
 *
 *     "Every one came back ok:true with a BYTE-IDENTICAL 8,063-character blob,
 *      because the offset was ignored and the clamp always cut the same hole …
 *      The model could see the file was truncated, could not see that its paging
 *      was a no-op, and burned four rounds proving it."
 *
 * ⚠️⚠️ THAT FIX WAS APPLIED TO `read_lines` AND NEVER TO `read_file`, AND
 * `read_file` IS THE VERB THE MODEL REACHES FOR FIRST — it is tool #1 in the wire
 * order. RE-MEASURED THROUGH THIS DISPATCHER 2026-08-26, on a 600-line / 32,400-
 * byte file (comfortably under `MAX_READ_BYTES`, so the too-big refusal that does
 * name `read_lines` never fires):
 *
 *     read_file {path, offset:300, limit:20}  → ok:true, bytes 32400, line 0001…
 *     read_file {path}                        → ok:true, bytes 32400, line 0001…
 *     IDENTICAL RESULT? true
 *     read_file {path, view_range:[300,320], banana:true} → ok:true, bytes 32400
 *
 * So the measured four-round failure is still live, verbatim, two months on. And
 * it is worse than "no windowing": `turn.mjs` then clamps to 8,000 characters,
 * cuts the MIDDLE out, and appends *"use read_lines with an offset"* — advice the
 * model believes it has already taken. It asked for lines 300-319 and was handed
 * the head and the tail of the file with a note telling it to do the thing it
 * just did.
 *
 * ⭐ SO WE SERVE THE WINDOW RATHER THAN REFUSING IT. read-window.mjs's own rule
 * is "a silent success on an argument you do not implement is worse than any
 * refusal" — but a refusal still costs a round, and the model is asking for a
 * capability that exists, is wired, and is one function call away. Claude Code,
 * OpenCode and SWE-agent all take offset/limit on their primary read verb; this
 * one now does too, through `readWindow`, so there is ONE windowing
 * implementation and not a second one grown here.
 *
 * ⚠️ AND IT ADDS ZERO SCHEMA BYTES. `offset`/`limit` are NOT declared on
 * `read_file` — `read_lines` already declares them and declaring them twice would
 * spend head budget on every single round against 3,133 bytes of headroom (see
 * the ceiling note at the top of this file) to describe a tool the model is
 * already calling correctly by instinct. This is the inverse of the drift this
 * file guards: implementing MORE than is declared is a capability the model
 * stumbles into, never a dead button it is invited to press.
 *
 * ⚠️ ANY OTHER ARGUMENT IS A HARD REFUSAL, and that half matters as much. The
 * probe above shows `view_range` and `banana` both returning `ok:true` today.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The arguments `read_file` will act on. `path` is the declared one; the two
 * window arguments are honoured-but-undeclared, for the reasons argued above.
 */
const READ_FILE_KEYS = ['path'];
const READ_FILE_WINDOW_KEYS = ['offset', 'limit'];

/**
 * ⚠️ 256 CHARACTERS RESERVED FOR THE HEADER, INSIDE THE SAME BUDGET. `turn.mjs`
 * clamps a `read_file` result's `content` at `MAX_TOOL_RESULT_CHARS` (8,000) and
 * `readWindow`'s own default is the same 8,000 — so a full window PLUS a header
 * would sit a few characters over and trip the head+tail clamp, re-cutting the
 * middle out of a window whose entire purpose was to stop that happening. The
 * header is bounded by the path length plus three integers; 256 covers a very
 * long path with room to spare, and the floor keeps it inside `clampMaxChars`'s
 * 200-character minimum on a pathological root.
 */
const READ_FILE_HEADER_RESERVE = 256;

/**
 * Turn a `readWindow` result into a `read_file`-shaped one.
 *
 * ⚠️ THE SHAPE IS NOT NEGOTIABLE: `{ ok, path, content, bytes }`. Four places
 * downstream read a `read_file` record — `turn.mjs`'s `describeToolResult`
 * (`clampOutput(result.content)`), its live-output line (`result.bytes`), the
 * `warmBaseline` snapshot (`result.path`) and `compact.mjs`'s supersede rules —
 * and a record that carried `text` instead of `content` would hand `clampOutput`
 * an `undefined`. Everything genuinely new is ADDITIVE, so a future consumer can
 * read the paging arithmetic without parsing English out of the header.
 *
 * ⚠️ THE CONTINUATION LIVES IN A HEADER, NEVER A TRAILER — read-window.mjs's
 * rule, and the reason is that a trailer sits after the code and a model copying
 * an `edit_file` old_string will take it with them. One line, then the file
 * verbatim: original indentation, no gutter, no ellipsis.
 *
 * Pure.
 */
function windowAsReadFile(window) {
  if (!window || window.ok !== true) return window;
  if (window.totalLines === 0) {
    return { ok: true, path: window.path, content: '', bytes: 0, windowed: true, totalLines: 0, nextOffset: null };
  }
  const where = `lines ${window.startLine}-${window.endLine} of ${window.totalLines}`;
  /**
   * ⭐ THE NEXT CALL IS SPELLED OUT, ARGUMENT NAMES AND ALL. "truncated" alone is
   * what a model reads as "this file is unreadable"; the literal next call is what
   * it pages with. Spelled against `read_file` rather than `read_lines` because
   * that is the verb it just used and the one whose result it is holding.
   */
  const tail = window.nextOffset === null
    ? ' (end of file)'
    : ` — continue with read_file {"path":"${window.path}","offset":${window.nextOffset}}`;
  const content = `${where}${tail}\n${window.text}`;
  return {
    ok: true,
    path: window.path,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    // ── additive, for consumers that should never parse the header ──────────
    windowed: true,
    startLine: window.startLine,
    endLine: window.endLine,
    totalLines: window.totalLines,
    totalBytes: window.totalBytes,
    nextOffset: window.nextOffset,
    /**
     * ⚠️ THE VERBATIM WINDOW, BESIDE THE DECORATED ONE — read-window.mjs's own
     * `exact` convention, and for its own stated reason: "a model handed only the
     * decorated version will paste the decorated version into an edit and be
     * refused, which is the exact failure this module was built to end."
     */
    exact: window.text,
  };
}

async function gateWrite(approveWrite, executor, path, after, extra = {}) {
  if (typeof approveWrite !== 'function') return null;
  let before = null;
  let exists = false;
  try {
    const read = executor.readFile(path);
    if (read && read.ok !== false && typeof read.content === 'string') {
      before = read.content;
      exists = true;
    }
  } catch { /* unreadable is "new file" for review purposes, never a hard failure */ }

  const decision = await approveWrite({ path, before, after, exists, ...extra });
  if (decision?.allowed === false) return refusedWriteResult(path, decision);
  return null;
}

export async function executeToolCall(call, executor, {
  commandTimeoutMs,
  /**
   * ⭐ The write reviewer, built per run by `createWriteApprover`. Optional and
   * defaulted to null, so nothing changes for a caller that does not pass one.
   */
  approveWrite = null,
  /** The bulk counterpart — one question for a whole `write_files` batch. */
  approveBatch = null,
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
   * ⚠️ NOT THE SAME ASKER AS `ask` BELOW. This one answers a question a CHILD
   * PROCESS asked ("Continue? [Y/n]"), so it is the runner asking on the user's
   * behalf and is deliberately UNBUDGETED — spending the model's three-question
   * allowance on an installer's prompt would silence the questions that matter.
   * Only consulted when `ACUVO_INTERACTIVE=ask`; null everywhere else, in which
   * case `spawnBounded` degrades to `halt` and types nothing.
   */
  interactiveAsk = null,
  /**
   * ⚠️ THE BUDGETED ASKER, OR NULL. The per-run allowance lives in
   * `ask-user.mjs`'s closure and is created ONCE by the turn loop, because this
   * dispatcher is a pure switch over a single call and has no memory of the
   * round before it. Threading a counter through every tool in this file for
   * the sake of one would be the wrong trade; the turn loop already owns
   * per-run state.
   */
  ask = null,
  /**
   * ⚠️ THE PARENT'S BUDGET, so `delegate` cannot spend outside it. The helper's
   * ceiling is whatever the parent has LEFT, and its cost is charged back the
   * moment it returns — otherwise the run's stated ceiling is a claim about the
   * parent only, while the model can spawn unbounded helpers at will.
   */
  budget = null,
  /**
   * ⚠️ INJECTABLE, like every other outward call in this package. Without it the
   * only way to test the delegate path is to spend real money on a real model,
   * which means in practice it is not tested — and the two things being pinned
   * here (the helper gets a ceiling, and its spend is charged back) are about
   * MONEY, which is the last place to accept "we checked it once by hand".
   */
  subagentImpl = null,
} = {}) {
  const name = call?.function?.name;
  const id = call?.id ?? null;
  const parsed = parseToolArguments(call?.function?.arguments);
  if (!parsed.ok) return { id, name, args: {}, result: { ok: false, error: parsed.error }, mutated: false };
  const args = parsed.args;

  /**
   * ── ⚠️⚠️ THE SECOND GATE, AND THE OFFER IS NOT ONE ───────────────────────
   *
   * This file's own comment on `repl` states the rule: *"a caller that widens
   * the tool list, replays a session, or hands the name in directly reaches
   * this switch without ever consulting the offer"*. `evaluate` was shipped
   * gated only at the offer and `--no-run` was a lie by a side door until this
   * exact guard was added for it. Withholding the three egress verbs from the
   * offer is the cheap half; this is the half that is a control.
   *
   * ⚠️ ONE SENTENCE, NOT THREE. `--no-run` grew two explanations once and the
   * comment above `evaluate` records why that must not happen again.
   */
  if (UNCONFIGURED_EGRESS_TOOL_NAMES.includes(name) && offlineEnabled()) {
    return {
      id,
      name,
      args,
      mutated: false,
      result: {
        ok: false,
        error: `this run is offline (${OFFLINE_ENV} / --offline), so ${name} reaches nothing. `
          + 'Work from what is in the workspace and say plainly which answers you could not look up.',
      },
    };
  }

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
      /**
       * ── ⭐⭐ THE WINDOWED BRANCH. See the block above `gateWrite` for the
       * measurement that forced it. Everything here is a no-op for the ordinary
       * `{path}` call, which is every call site in this package, in the MCP
       * server and in `console/` — greppped 2026-08-26, none passes a second key.
       */
      const extra = Object.keys(args).filter((k) => !READ_FILE_KEYS.includes(k));
      if (extra.length > 0) {
        const unknown = extra.filter((k) => !READ_FILE_WINDOW_KEYS.includes(k));
        if (unknown.length > 0) {
          /**
           * ⚠️ A REFUSAL, NOT A SHRUG — and it names both the window arguments
           * this verb does honour and the tool that owns the other shapes, with
           * their REAL argument names. Measured: `{path, view_range:[300,320]}`
           * came back `ok:true` with the whole file, so a model that reached for
           * another agent's spelling was told it had succeeded.
           *
           * ⚠️⚠️ AND THE SUGGESTED CALL IS LITERAL JSON, VALUES AND ALL. It read
           * `read_around {"path","pattern"}` when this branch was written — a
           * placeholder SHAPE, which is the precise form that hid the two-month
           * argument-name bug documented in `workspace.mjs`'s too-big-read
           * branch: nobody ever pasted `{"path","start","end"}` into a probe,
           * because it is not JSON anybody can paste. A suggestion that parses
           * and runs is a suggestion that gets tested. This one is: the suite
           * lifts the object straight out of this sentence and executes it.
           */
          return {
            id,
            name,
            args,
            mutated: false,
            result: {
              ok: false,
              error: `read_file does not accept "${unknown[0]}". It takes path, and optionally offset (a 1-indexed `
                + 'LINE NUMBER) and limit (how many lines) to read a window instead of the whole file. '
                + `To find the region first: read_around {"path":${JSON.stringify(String(args.path ?? ''))},"pattern":"someText"}, or search_text.`,
            },
          };
        }
        if (executor.root === MEMORY_ROOT) {
          /**
           * ⚠️ THE SAME REFUSAL `read_lines` GIVES, FOR THE SAME REASON:
           * `resolveInWorkspace('(memory)', …)` would resolve a real relative
           * directory named "(memory)" under the process's cwd. Naming the way
           * out matters more here than usual, because the way out is trivial —
           * drop the two arguments and the read succeeds.
           */
          return {
            id,
            name,
            args,
            mutated: false,
            result: {
              ok: false,
              error: 'this workspace is held in memory rather than on disk, so windowed reads are unavailable here — '
                + 'call read_file with only a path and it will return the whole file.',
            },
          };
        }
        const window = readWindow(
          executor.root,
          {
            path: args.path,
            ...(args.offset === undefined ? {} : { offset: args.offset }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
            maxChars: Math.max(200, DEFAULT_MAX_CHARS - READ_FILE_HEADER_RESERVE),
          },
          'read_lines',
        );
        return { id, name, args, result: windowAsReadFile(window), mutated: false };
      }
      return { id, name, args, result: executor.readFile(args.path), mutated: false };
    }
    case 'write_file': {
      /**
       * ⚠️ THE LINT RUNS BEFORE THE APPROVAL PROMPT, not after. Asking a person
       * to approve a write that is about to be refused wastes the one thing this
       * package cannot buy back — their attention.
       */
      const lint = preCommitCheck(executor, args.path, args.content);
      if (lint.block) return { id, name, args, result: { ok: false, error: lint.block }, mutated: false };
      const gate = await gateWrite(approveWrite, executor, args.path, args.content);
      if (gate) return { id, name, args, result: gate, mutated: false };
      /**
       * ⚠️ MEASURED BEFORE THE WRITE LANDS, because after `executor.writeFile`
       * the old bytes are gone and the comparison is impossible. Same ordering
       * the builder uses at its own write site.
       */
      const waste = wasteNoteForWrite(executor, args.path, args.content);
      const result = executor.writeFile(args.path, args.content);
      /**
       * ⭐ IT RIDES `editCheck`, WHICH IS ALREADY THE DOOR TO THE MODEL.
       * `turn.mjs` appends that field to the tool result body for every writing
       * verb — the formatted branches render "replaced x (400 bytes)" and
       * nothing else, so a NEW field on the result would reach the model through
       * exactly none of them. That is this repo's own recorded failure mode:
       * the work done one layer down and discarded on the way out.
       */
      const notes = [lint.note, waste].filter(Boolean).join('');
      return {
        id, name, args, mutated: result.ok === true,
        result: result.ok === true && notes ? { ...result, editCheck: notes } : result,
      };
    }
    /**
     * ⭐ THE BULK EDIT, MADE GOVERNED. The model already does bulk edits — it
     * writes a loop inside `evaluate`, which is the right instinct and is
     * invisible to leases, to the change count and to collision detection. This
     * is the same operation through `executor.writeFile`, so every guard
     * applies. See lib/write-many.mjs.
     *
     * ⚠️ `mutated` is true when ANY file landed. A call that wrote 44 of 45 did
     * real work, and reporting it as untouched would put the summary back where
     * `evaluate` had it.
     */
    case 'write_files': {
      /**
       * ⚠️ THE BULK CASE IS GATED ONCE, ON THE WHOLE BATCH, and that is a
       * deliberate choice rather than a shortcut. Asking per file turns one
       * intent — "apply this refactor" — into forty prompts, and a prompt
       * answered forty times is answered without reading by the third. The
       * batch carries its file list so the person sees the scope.
       */
      const batch = (args?.files ?? []).filter((f) => f && typeof f.path === 'string');
      /**
       * ⭐ THE SAME PRE-COMMIT LINT AS THE SINGULAR VERB, AND IT HAS TO BE HERE
       * OR THE BULK PATH IS THE HOLE. `write_files` exists precisely because the
       * model does bulk edits; a check wired only to `write_file` would be
       * bypassed by the verb most likely to break forty files at once.
       */
      const bulkNotes = [];
      /**
       * ⚠️ ONE PARSE BUDGET FOR THE WHOLE BATCH, NOT ONE PER FILE. `write_files`
       * accepts up to 45 files and the escalation costs ~105ms; a per-file budget
       * would let one tool call spend five blocking seconds in `spawnSync`. The
       * loop returns on the FIRST block anyway, so the files that matter are the
       * early ones, and past the budget the gate abstains rather than stalls.
       */
      const bulkParseBudget = { spawns: SYNTAX_CHECK_BATCH_SPAWNS };
      for (const file of batch) {
        if (typeof file.content !== 'string') continue;
        const lint = preCommitCheck(executor, file.path, file.content, bulkParseBudget);
        if (lint.block) {
          return {
            id, name, args, mutated: false,
            result: { ok: false, error: `none of these ${batch.length} files was written. ${lint.block}` },
          };
        }
        if (lint.note) bulkNotes.push(lint.note);
      }
      if (typeof approveBatch === 'function' && batch.length > 0) {
        // ⚠️ `before` read through the EXECUTOR, so the in-memory backend the
        // browser builder uses answers the same as the filesystem one.
        const writes = batch.map((f) => {
          let before = null; let exists = false;
          try {
            const r = executor.readFile(f.path);
            if (r && r.ok !== false && typeof r.content === 'string') { before = r.content; exists = true; }
          } catch { /* unreadable is "new file" for review purposes */ }
          return { path: f.path, before, after: f.content, exists };
        });
        const verdict = await approveBatch(writes);
        if (verdict?.allowed === false) {
          return { id, name, args, result: refusedWriteResult(`${batch.length} files`, verdict), mutated: false };
        }
      }
      /**
       * ── ⭐⭐ THE BULK PATH IS WHERE A REWRITE IS MOST EXPENSIVE ─────────────
       *
       * `write_files` takes up to 45 files in one call, so it is precisely the
       * verb that can re-emit an entire project to change a handful of lines.
       * Wiring the waste signal only to `write_file` would leave the signal off
       * exactly where the waste is biggest — the same shape as the pre-commit
       * lint's own note two hundred lines above: *"a check wired only to
       * `write_file` would be bypassed by the verb most likely to break forty
       * files at once."*
       *
       * ⚠️ MEASURED BEFORE `writeMany`, for the same reason as the singular
       * verb: afterwards the old bytes are gone.
       *
       * ⚠️ AND CAPPED AT THREE. The note exists to change the next call, and
       * three worked examples do that as well as forty — while forty would spend
       * more context on the complaint than the rewrite cost. The count is still
       * stated in full, so nothing is hidden by the cap.
       */
      const wasteNotes = [];
      for (const file of batch) {
        if (typeof file.content !== 'string') continue;
        const note = wasteNoteForWrite(executor, file.path, file.content);
        if (note) wasteNotes.push(note);
      }
      const wasteSummary = wasteNotes.length === 0 ? ''
        : wasteNotes.slice(0, 3).join('')
          + (wasteNotes.length > 3 ? `⚠️ ${wasteNotes.length} of the ${batch.length} files in this call were whole-file rewrites of files that barely changed; the ${wasteNotes.length - 3} not listed are the same story.` : '');
      const result = writeMany(executor, args);
      return {
        id, name, args,
        result: result.ok === true && (bulkNotes.length || wasteSummary)
          ? { ...result, editCheck: `${bulkNotes.join('')}${wasteSummary}` }
          : result,
        mutated: (result.written?.length ?? 0) > 0,
        mutatedPath: result.written?.length === 1 ? result.written[0].path : undefined,
      };
    }
    /**
     * ── ⭐⭐⭐ THE CHEAP EDIT. Same door, same gates, a tenth of the output. ───
     *
     * ⚠️ IT WRITES THROUGH `executor.writeFile` AND `executor.deleteFile` AND
     * NOWHERE ELSE, which is what buys — for free and without a line of code
     * here — the file leases, the `.acuvo/` leash, the `node_modules`/`.git`
     * refusals, `--dry-run`, and the `--plan` read-only executor that replaces
     * exactly those two methods with refusals. A bulk verb with its own path to
     * disk would have defeated all five at once.
     *
     * ⚠️ AND IT IS GATED BEFORE ANY OF THEM RUN. `planPatch` computes the whole
     * changeset in memory first, so the approval question can carry every path —
     * a person asked "apply this refactor?" must be shown the scope, not asked
     * once per file until they stop reading.
     */
    case 'apply_patch': {
      const plan = planPatch(executor, args.patch);
      if (!plan.ok) return { id, name, args, result: { ok: false, error: plan.error }, mutated: false };

      /**
       * ── ⭐⭐ THE STRONGEST PLACE THE PRE-COMMIT LINT COULD SIT ──────────────
       *
       * `planPatch` computes the WHOLE changeset in memory and `commitPatch` is
       * all-or-nothing, so a patch that would break one file can be refused with
       * literally nothing on disk — the ideal SWE-agent shape, and the reason
       * the engine was written this way in the first place.
       *
       * ⚠️ ONE REFUSAL FOR THE FIRST BROKEN FILE, NOT A LIST. A patch is one
       * intent; naming every file it would break spends context on consequences
       * of a single mistake the model has to re-derive anyway.
       */
      const notes = [];
      /** Same shared budget as `write_files`, for the same reason. */
      const patchParseBudget = { spawns: SYNTAX_CHECK_BATCH_SPAWNS };
      for (const change of plan.batch) {
        if (typeof change?.after !== 'string') continue;   // a deletion has no after-image
        /**
         * ⭐ `editGate`, NOT `checkEditBeforeCommit`. `planPatch` has already read
         * every `before` through the executor, so this seam holds both images and
         * is the cheapest place in the package to run a real parser — and if it
         * did not go through the gate, `apply_patch` would be the one writing verb
         * that could still land broken JavaScript. That is exactly the shape of
         * hole this file has already been caught leaving twice.
         */
        const lint = editGate(change.path, change.before, change.after, patchParseBudget);
        if (lint.block) {
          return {
            id, name, args, mutated: false,
            result: { ok: false, error: `this patch was NOT applied — no file was touched. ${lint.block}` },
          };
        }
        if (lint.note) notes.push(lint.note);
      }

      /**
       * ⚠️ THE SAME BATCH GATE `write_files` USES, and deliberately the same
       * one rather than a second: `approveMany` decides risk across the whole
       * list and a patch is by construction one intent. `planPatch` has already
       * read every `before` THROUGH THE EXECUTOR, so the in-memory backend
       * answers this identically to the filesystem one.
       */
      if (typeof approveBatch === 'function' && plan.batch.length > 0) {
        const verdict = await approveBatch(plan.batch);
        if (verdict?.allowed === false) {
          return {
            id, name, args, mutated: false,
            result: refusedWriteResult(`${plan.batch.length} file${plan.batch.length === 1 ? '' : 's'} in one patch`, verdict),
          };
        }
      }

      const result = commitPatch(executor, plan);
      /**
       * ⚠️ `written[]` IS `write_files`' SHAPE ON PURPOSE. `changed-paths.mjs`
       * reads it, and through it so do report.mjs, parallel.mjs, best-of.mjs and
       * handoff.mjs — a new `applied[]` field would have needed an arm in every
       * one of them, which is the three-way disagreement that file was written
       * to end. And on a rollback that could not fully restore, `written[]`
       * carries the still-modified paths, so the summary owns them.
       */
      return {
        id, name, args,
        result: result.ok === true && notes.length ? { ...result, editCheck: notes.join('') } : result,
        mutated: (result.written?.length ?? 0) > 0,
        mutatedPath: result.written?.length === 1 ? result.written[0].path : undefined,
      };
    }
    case 'list_dir':
      return { id, name, args, result: executor.listDir(args.path ?? '.'), mutated: false };
    case 'edit_file': {
      /**
       * ⚠️⚠️ THE COMMENT HERE WAS RIGHT AND THE CODE WAS NOT (fixed 2026-08-19).
       * It said "gated on the RESULTING content, which `editThroughExecutor`
       * computes" — and then passed `null`, because `editThroughExecutor` is not
       * called until the line below the gate.
       *
       * `approvalDecision` derives `existsAfter = after !== null && after !==
       * undefined`, so a null `after` means **every edit was classified as the
       * file being DELETED**: `high` risk, and a prompt reading "app.js is being
       * DELETED" for a one-line change. Under `ACUVO_APPROVE=always` — the
       * documented unattended mode — high-risk writes are hard-blocked, so
       * `edit_file` could never land at all.
       *
       * ⭐ `applyEdit` is PURE, so the resulting content is computable before
       * anything is written. Now the person sees the real change and the risk
       * rules measure the real file, which is what the comment promised.
       *
       * ⚠️ A failed preview gates on `null` deliberately: `editThroughExecutor`
       * is about to return that same failure, and asking someone to approve a
       * write that cannot happen is noise. Nothing is written either way.
       */
      const beforeRead = executor.readFile(args.path);
      const preview = beforeRead.ok
        ? applyEdit(beforeRead.content, args.old_string, args.new_string)
        : null;
      const editedAfter = preview && preview.ok ? preview.content : null;
      /**
       * ⭐ THE ONE PLACE THE ACI CHECK IS CHEAPEST: `applyEdit` is pure, so the
       * after-image is already in hand and a refusal costs nothing but the
       * round the model was going to spend anyway. `beforeRead.content` is
       * passed straight through rather than re-read — one read, one truth.
       */
      const lint = editedAfter === null
        ? { block: null, note: null }
        : editGate(args.path, beforeRead.ok ? beforeRead.content : null, editedAfter);
      if (lint.block) return { id, name, args, result: { ok: false, error: lint.block }, mutated: false };
      const gate = await gateWrite(approveWrite, executor, args.path, editedAfter, { kind: 'edited', edit: args });
      if (gate) return { id, name, args, result: gate, mutated: false };
      // ⭐ Through the EXECUTOR, not through fs — this is the line that lets the
      // browser builder run the same loop the CLI does.
      const result = editThroughExecutor(executor, args.path, args.old_string, args.new_string);
      return {
        id, name, args, mutated: result.ok === true,
        result: result.ok === true && lint.note ? { ...result, editCheck: lint.note } : result,
      };
    }
    case 'delete_file': {
      const result = executor.deleteFile(args.path);
      return { id, name, args, result, mutated: result.ok === true };
    }
    case 'move_file': {
      /**
       * ⚠️ AN EXECUTOR WITHOUT `moveFile` MUST SAY SO, NOT CRASH. The browser
       * builder implements this dispatcher's verbs over a Map, and it gained
       * `deleteFile` only because someone remembered. A `TypeError: not a
       * function` mid-round costs the round and tells the model nothing it can
       * act on; a sentence tells it to use write_file + delete_file instead.
       */
      if (typeof executor.moveFile !== 'function') {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this executor cannot move files. Use write_file to create the new path and delete_file to remove the old one.' },
        };
      }
      /**
       * ── ⚠️⚠️ THE REFUSAL NAMED AN ARGUMENT THIS TOOL DOES NOT HAVE ──────────
       *
       * MEASURED through this dispatcher 2026-08-26:
       *
       *     move_file {"from":"a.mjs"}  →  ok:false  "path must be a string"
       *
       * `move_file`'s schema declares `from`, `to` and `overwrite`. There is no
       * `path`. The message comes from `resolveInWorkspace`, which is generic and
       * correct in the eight other verbs that really do take a `path` — but here
       * it instructs the model to fix an argument it was never given, and says
       * nothing about WHICH of the two real ones was missing. A model cannot
       * comply with that; it can only guess, and the obvious guess (`{path: …}`)
       * is a second refusal.
       *
       * ⭐ SWE-agent's third ACI finding is precisely this: a refusal has to name
       * the next move, in the caller's own vocabulary. This file already knows the
       * rule — "THE REFUSAL SAYS WHAT TO DO INSTEAD" is argued three times above,
       * on `apply_patch`, on `write_file` and on the JSON pre-commit block. It had
       * simply never been checked against the verbs whose parameters are not
       * called `path`, and `move_file` is the only one in the registry.
       *
       * ⚠️ AT THE DISPATCHER, NOT IN `workspace.mjs`. Same reasoning as the
       * credential guard forty lines above: this is the MODEL's door. The executor
       * has non-model callers — `--doctor`, the acceptance harness, the browser
       * builder's Map-backed executor — and pushing a verb-specific message down
       * into shared plumbing is the change that broke seven tests of legitimate
       * internal work the last time it was tried.
       */
      const missing = ['from', 'to'].filter((k) => typeof args[k] !== 'string' || args[k].trim() === '');
      if (missing.length > 0) {
        return {
          id,
          name,
          args,
          mutated: false,
          result: {
            ok: false,
            error: `move_file needs both "from" and "to" as workspace-relative path strings, and ${missing.join(' and ')} `
              + `${missing.length === 1 ? 'is' : 'are'} missing. It has no "path" argument: "from" is the file that `
              + 'exists now, "to" is where it should end up — e.g. {"from":"src/old.ts","to":"src/lib/new.ts"}.',
          },
        };
      }
      const result = executor.moveFile(args.from, args.to, { overwrite: args.overwrite === true });
      return { id, name, args, result, mutated: result.ok === true };
    }
    /**
     * ⚠️ `mutated: false` IS CORRECT AND IS NOT A SHORTCUT. `openIndex` does
     * touch the disk — `.acuvo/index/symbols.json` — but `mutated` means "the
     * agent changed the USER's work", and every downstream reader (the change
     * count, the diff approval gate, `parallel.mjs`'s collision detector) acts
     * on it. A self-ignoring cache under `.acuvo/` is not a change to the
     * workspace, and reporting it as one would make a lookup look like an edit.
     *
     * ⚠️ THE DRY-RUN CASE IS HANDLED INSIDE `executeRepoIndexTool`, from
     * `executor.dryRun`, rather than here — so the MCP server and any library
     * embedder get the same behaviour without having to remember this line.
     */
    case 'find_symbol':
      return { id, name, args, result: executeRepoIndexTool(name, args, executor), mutated: false };
    case 'find_usages':
      return { id, name, args, result: executeUsagesTool(name, args, { executor }), mutated: false };
    case 'find_files':
      return { id, name, args, result: findFiles(executor.root, args.pattern, { offset: args.offset }), mutated: false };
    case 'search_text':
      return { id, name, args, result: await searchText(executor.root, args.pattern, { glob: args.glob, offset: args.offset }), mutated: false };
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
      const result = await speak(executor.root, args.text, args.path, { dryRun: executor.dryRun, engine: args.engine ?? null });
      return { id, name, args, result, mutated: result.ok === true };
    }
    /**
     * ── ⭐⭐ THE PRICE QUESTION, ASKED BEFORE THE MONEY MOVES ────────────────
     *
     * ⚠️ `mutated: false` — it writes nothing into the workspace. It does
     * refresh a cache under HOME, which is deliberately NOT counted: the
     * "N files written" line is about the user's tree, and a credential-adjacent
     * cache file appearing in it would be noise in the one honest number in the
     * summary. (Same reasoning `evaluate` uses for its temp file.)
     *
     * ⭐ IT IS THE ONE CREATIVE VERB ALLOWED TO GO TO THE NETWORK FOR PRICES.
     * `generate_image` and `speak` read the cache and never ask, so a render
     * never pays for a round trip — the question is asked by the verb that
     * exists to answer it.
     */
    case 'list_engines': {
      const result = await listEngines({ medium: args.medium ?? 'all' });
      return { id, name, args, result, mutated: false };
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
    /**
     * ── ⭐⭐⭐ THE FOUR MOAT VERBS ────────────────────────────────────────
     *
     * ⚠️ ALL FOUR ARE `mutated: true`. Each writes a real file into the
     * workspace, so the run summary must count it — otherwise a user ends up
     * with a video on disk that the session never mentioned, which is how a
     * generated asset becomes a mystery file nobody trusts.
     *
     * ⚠️ AND THE EXECUTOR RETURNS `usd`. These are the only verbs here that
     * spend money per call; the cost travels back with the result rather than
     * arriving later on a bill.
     *
     * ⚠️⚠️ `budget` IS THREADED IN, like `viral` and `podcast` above, and for a
     * blunter reason: measured 2026-08-25 these five charged the ledger NOTHING
     * and consulted the budget NEVER, so a 400-second A100 render reported
     * $0.0000 while a two-second TTS line was metered to four decimal places.
     * `avatar-run.mjs:preflight` is what refuses; this is what lets it see the
     * remaining money.
     */
    case 'clone_voice': {
      const result = await cloneVoice(executor.root, args, { dryRun: executor.dryRun, budget });
      return { id, name, args, result, mutated: result.ok === true, mutatedPath: result.path ?? null };
    }
    case 'design_voice': {
      const result = await designVoice(executor.root, args, { dryRun: executor.dryRun, budget });
      return { id, name, args, result, mutated: result.ok === true, mutatedPath: result.path ?? null };
    }
    case 'character_lock': {
      const result = await characterLock(executor.root, args, { dryRun: executor.dryRun, budget });
      return { id, name, args, result, mutated: result.ok === true, mutatedPath: result.path ?? null };
    }
    case 'talking_head': {
      const result = await talkingHead(executor.root, args, { dryRun: executor.dryRun, budget });
      return { id, name, args, result, mutated: result.ok === true, mutatedPath: result.path ?? null };
    }
    case 'generate_video': {
      const result = await generateVideo(executor.root, args, { dryRun: executor.dryRun, budget });
      return { id, name, args, result, mutated: result.ok === true, mutatedPath: result.path ?? null };
    }
    case 'generate_image': {
      /**
       * ⚠️ `mutated: true` — this DOES write a file into the workspace, unlike
       * run_command. The summary's "N files written" must count it, or a user
       * gets an image on disk that the run never mentioned.
       */
      /**
       * ⚠️ `engine` IS PASSED THROUGH RATHER THAN DEFAULTED HERE. The default
       * belongs in one place (`checkEngine`), and it is the CORE engine — a
       * dispatcher that picked an engine would be the software choosing to
       * spend somebody's credits, which is the exact thing the rule forbids.
       */
      const result = await generateImage({
        prompt: args.prompt, width: args.width, height: args.height, engine: args.engine ?? null, executor,
      });
      return { id, name, args, result, mutated: result.ok === true };
    }
    /**
     * ⚠️ `mutated: true`, and `mutatedPath` is the ASSET rather than the code
     * file. Both change — that is the whole verb — but the asset is the one a
     * run summary cannot otherwise account for: the code edit already goes
     * through `editThroughExecutor` and lands in the checkpoint journal, while
     * a generated binary that nobody counted is exactly how an image becomes a
     * mystery file in someone's repo.
     *
     * ⚠️ AND NO `allowRun` GATE, DELIBERATELY. It starts no process. It writes
     * two files, which `--dry-run` (not `--no-run`) is the flag for, and the
     * verb honours that flag by generating nothing at all.
     */
    case 'pipe_to_asset': {
      const result = await runPipeAssetTool(name, args, { executor });
      return { id, name, args, result, mutated: result.ok === true, mutatedPath: result.assetPath ?? null };
    }
    /**
     * ── ⭐ chart — A CSV IN, A SELF-CONTAINED DASHBOARD OUT ────────────────
     *
     * ⚠️ NO `allowRun` GATE, DELIBERATELY, and the same reasoning as
     * `pipe_to_asset` directly above: it starts no process. It writes ONE file,
     * which `--dry-run` (not `--no-run`) is the flag for, and the verb honours
     * that flag by returning `dryRun: true` and putting nothing on disk.
     *
     * ⚠️ `mutated: true` — a written HTML file that nothing counted is a mystery
     * file in somebody's repo, which is the exact failure `pipe_to_asset`
     * records for its generated asset.
     */
    case 'chart': {
      const result = await runChartTool(name, args, { executor });
      return { id, name, args, result, mutated: result.ok === true && result.dryRun !== true, mutatedPath: result.path ?? null };
    }
    /**
     * ── ⭐ syndicate — ONE IDEA, ASSEMBLED INTO EVERY FORMAT ───────────────
     *
     * ⚠️ IT WRITES SEVERAL FILES AND `mutatedPath` REPORTS ONLY ONE, so it names
     * the FOLDER rather than picking a file to privilege. The alternative —
     * naming `post.md` — would silently drop the thread, the infographic and the
     * manifest from the run summary, and a summary that under-counts is the one
     * nobody checks a second time. The full list is in `result.files`.
     */
    case 'syndicate': {
      const result = await runSyndicateTool(name, args, { executor });
      return { id, name, args, result, mutated: result.ok === true && result.dryRun !== true, mutatedPath: result.dir ?? null };
    }
    /**
     * ── ⭐⭐ viral · podcast — THE TWO ORCHESTRATORS ────────────────────────
     *
     * ⚠️ `mutated` FOLLOWS `spent`, NOT `ok`. Both verbs answer `ok: true,
     * spent: false` for the priced-but-unapproved first call, and that call
     * writes NOTHING — counting it as a mutation would put a phantom entry in
     * the "files written" line, which is the one honest number in the summary.
     * (`evaluate` refuses to count its temp file for the same reason.)
     *
     * ⚠️ `budget` IS THREADED IN, and it is the only reason these two can refuse
     * a run they can already prove will not finish. `allowRun` is threaded for
     * the ffmpeg step alone: `--no-run` means no process starts, and both verbs
     * fall back to reporting the exact command instead of running it.
     *
     * ⚠️ `mutatedPath` NAMES THE FOLDER, never a file inside it — a run writes
     * an episode or a video plus one file per scene, and privileging one of them
     * would silently drop the rest from the summary. The full list is in
     * `result.files`. Same decision `syndicate` makes directly above.
     */
    case 'media_chain': {
      const result = await runMediaChainTool(name, args, { executor, budget });
      return { id, name, args, result, mutated: result.ok === true && result.spent === true, mutatedPath: result.dir ?? null };
    }
    case 'viral': {
      const result = await runViralTool(name, args, { executor, budget, allowRun });
      return { id, name, args, result, mutated: result.ok === true && result.spent === true, mutatedPath: result.dir ?? null };
    }
    case 'podcast': {
      const result = await runPodcastTool(name, args, { executor, budget, allowRun });
      return { id, name, args, result, mutated: result.ok === true && result.spent === true, mutatedPath: result.dir ?? null };
    }
    case 'evaluate': {
      /**
       * ── ⚠️⚠️⚠️ `--no-run` WAS A LIE BY A SIDE DOOR, AND THIS FILE NAMED THE
       *          DOOR ITSELF ────────────────────────────────────────────────
       *
       * `evaluate` is withheld from the OFFER when `allowRun` is false, and
       * until now that was the only gate. The offer is not a gate: this file's
       * own comment on `repl` says so — *"a caller that widens the tool list,
       * replays a session, or hands the name in directly reaches this switch
       * without ever consulting the offer"* — and the comment above `playtest`
       * cites `evaluate` BY NAME as the precedent for double-gating. The
       * precedent had the guard the citation credited it with, only at the
       * offer. A scripted call, a resumed session, or a provider echoing a
       * stale tool list ran the model's JavaScript in a child process under the
       * flag documented as "never execute anything".
       *
       * ⚠️ THE SENTENCE IS `run_command`'s, WORD FOR WORD. One flag must not
       * grow two explanations.
       */
      if (allowRun === false) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this run was started with --no-run, so no command is executed. Report what you changed and say plainly that nothing was verified.' },
        };
      }
      const result = await evaluateSnippet({ executor, source: args.source, timeoutMs: commandTimeoutMs });
      /**
       * ⚠️ `mutated: false`. It writes a temp file and deletes it again, so no
       * file the user cares about changed — counting it would put a phantom
       * entry in the "files written" line, which is the one honest number in
       * the summary.
       */
      return { id, name, args, result, mutated: false };
    }
    /**
     * ── ⭐⭐ `check_tools` — THE ROUND SAVED BEFORE IT IS SPENT ───────────────
     *
     * ⚠️ THE `allowRun` CHECK IS HERE AS WELL AS AT THE OFFER, for the reason
     * `run_command` spells out one case below: a model can emit a call for a
     * tool it was never shown (a resumed session, a stale conversation, a
     * provider echoing an old tool list), and the answer would then describe an
     * allowlist that cannot be exercised at all.
     *
     * ⚠️⚠️ AND AN EXECUTOR THAT OWNS ITS OWN RUNNER GETS A REFUSAL RATHER THAN A
     * CONFIDENT WRONG ANSWER. The browser builder's `runCommand` ships the file
     * map to a Modal sandbox; THIS process's PATH is a different machine
     * entirely, so "gcc is installed" would be a fact about the wrong computer.
     * A verb whose failure mode is a plausible lie is worse than one that says
     * it does not know.
     */
    case 'check_tools': {
      if (allowRun === false) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this run was started with --no-run, so nothing is executable regardless of what is installed.' },
        };
      }
      if (executor.root === MEMORY_ROOT || typeof executor.runCommand === 'function') {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'commands in this workspace run somewhere other than this machine, so what is on PATH here says nothing about what will execute. Run the command and read its exit code.' },
        };
      }
      return {
        id,
        name,
        args,
        mutated: false,
        result: checkTools(executor, { programs: args.programs, shell }),
      };
    }

    case 'run_command': {
      /**
       * ── ⚠️⚠️ `--no-run` WAS ENFORCED AT THE OFFER AND NOT HERE ─────────────
       *
       * `run_program`, ONE CASE BELOW, already checks `allowRun` at the
       * dispatcher, and its comment spells out exactly why: "a model can emit a
       * call for a tool it was never shown (a resumed session, a stale
       * conversation, a provider echoing an old tool list), and the flag has to
       * hold at the point the process would actually start."
       *
       * ⚠️ EVERY WORD OF THAT APPLIES TO `run_command`, WHICH IS THE ONE THE
       * MODEL REACHES FOR CONSTANTLY, and it was the one without the check.
       * Reproduced: `executeToolCall({name:'run_command', command:'npm install
       * evil-package'}, executor, {allowRun:false})` returned `{ok:true,
       * exitCode:0}` and the executor really ran it.
       *
       * ⚠️ AND `executor.runCommand` MAKES IT WORSE, not better. The browser
       * builder's own runner is reached on the line below without passing
       * through `executeRunCommand` at all — so whatever gate lives downstream
       * is not on that path. A flag whose enforcement depends on which executor
       * is installed is not a flag.
       *
       * ⭐ The sentence is `run_program`'s, changed only from "program" to
       * "command": one flag must not grow two explanations.
       */
      if (allowRun === false) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this run was started with --no-run, so no command is executed. Report what you changed and say plainly that nothing was verified.' },
        };
      }
      /**
       * ── ⭐⭐⭐ THE SNAPSHOT, TAKEN BEFORE THE COMMAND IS EVEN LOOKED AT ─────
       *
       * `git-safety.mjs` explains the mechanism and the measurements. What
       * matters HERE is the position: BEFORE the spawn, and before anything
       * inspects `args.command`. There is no classifier upstream of this line
       * to fool, so `git reset --hard`, `rm -rf .`, and a node script that
       * calls `fs.rmSync` are all covered identically — the working tree is
       * already in the object database by the time any of them start.
       *
       * ⚠️ IT CANNOT REFUSE, AND THAT IS DELIBERATE. `guardCommand` swallows
       * every failure (no git, no repository, no identity, a timeout) and
       * returns "no note". A safety net that can block the trapeze gets
       * switched off, and then it protects nobody.
       *
       * ⚠️ AND IT RUNS FOR BOTH EXECUTORS. The comment below records that the
       * browser builder owns its own runner and never reaches
       * `executeRunCommand` — which is exactly how a gate placed one line lower
       * ends up enforced on one path out of two.
       */
      const guarded = executor.root && executor.root !== '(memory)'
        ? await guardCommand(executor.root, args.command, { env: executor.env ?? process.env })
        : { snapshotted: false, note: null };
      /**
        * ⭐ AN EXECUTOR MAY OWN ITS OWN RUNNER. The CLI does not — it uses the
        * allowlisted local spawner below, which is the thing `command.mjs`
        * exists to keep safe. The browser builder DOES: its files never touch a
        * server disk, so "run" means shipping the map to the Modal sandbox.
        * Same tool, same loop, two very different executions.
        */
      const result = typeof executor.runCommand === 'function'
        ? await executor.runCommand(args.command)
        : await executeRunCommand({
          command: args.command,
          executor,
          /**
           * ⚠️ A REQUEST, NOT AN OVERRIDE. Only a POSITIVE FINITE number is
           * honoured — a string, NaN or 0 from a model falls back to the run's
           * own setting rather than becoming a zero-length timeout that kills
           * every command instantly. `executeRunCommand` clamps to
           * MAX_COMMAND_TIMEOUT_MS, so the ceiling is unchanged.
           */
          timeoutMs: Number.isFinite(Number(args.timeoutMs)) && Number(args.timeoutMs) > 0
            ? Number(args.timeoutMs)
            : commandTimeoutMs,
          shell,
          /** ⭐ So `ACUVO_INTERACTIVE=ask` is a mode that can actually ask. */
          askInteractive: interactiveAsk,
        });
      /**
       * ⚠️ `mutated: false` EVEN THOUGH A COMMAND CAN WRITE FILES. `mutated`
       * feeds the "N files written" line, and that line names paths the
       * EXECUTOR wrote — a build's output is real but unattributable, and
       * inventing a count for it would make the one honest number in the
       * summary an estimate. What the command did is reported separately, in
       * full, as its own output.
       */
      /**
       * ⭐ AND THE UNDO IS SAID OUT LOUD, ONLY WHEN THE COMMAND LOOKED LIKE IT
       * DESTROYED SOMETHING. *"A capability nobody can find is the same as a
       * capability that does not exist — this package has shipped that defect
       * four times."* The classification behind `note` is the bypassable kind
       * `command.mjs` warns about, and it is used ONLY to decide what to SAY:
       * a miss costs a sentence, never the snapshot.
       */
      const judged = withExpectedExit(result, args.expectExit);
      if (guarded.note && judged && typeof judged === 'object') {
        return { id, name, args, result: { ...judged, safety: guarded.note }, mutated: false };
      }
      return { id, name, args, result: judged, mutated: false };
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
      return { id, name, args, result: loadAnySkill(executor.root, args.name), mutated: false };

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
      /**
       * ⭐ THE HELPER INHERITS THE PARENT'S REMAINDER. Not a fraction — a
       * fraction is an invented constant somebody has to defend, whereas the
       * remainder makes the arithmetic self-evident: a helper cannot spend
       * money the run does not have, so the TOTAL stays the number the user
       * typed. `Infinity` (a `--budget none` run) becomes `null`, i.e.
       * unbounded, which is exactly the behaviour that run asked for.
       */
      const left = budget?.canContinue?.()?.remainingUsd;
      const share = Number.isFinite(left) ? left : null;

      /**
       * ── ⭐ A NAMED SPECIALIST (`.acuvo/agents/*.md`, `.claude/agents/*.md`) ──
       *
       * Resolved HERE, not in `subagent.mjs`, because the resolver imports that
       * module's tool lists and the reverse import would be a cycle. The
       * definition DECIDES the mode — `write`/`verify` from the model are
       * ignored when an agent is named, so a file that says "read only" cannot
       * be talked into writing by the model that called it.
       *
       * ⚠️ AN UNKNOWN NAME IS REFUSED BEFORE ANY SPEND, with the real names —
       * a helper silently falling back to a generic researcher would do the
       * wrong job at full price.
       */
      let agentDef = null;
      if (typeof args.agent === 'string' && args.agent.trim()) {
        const defs = executor?.root ? loadAgentDefinitions({ root: executor.root }) : { agents: [] };
        agentDef = findAgent(defs, args.agent);
        if (!agentDef) {
          const names = defs.agents.map((a) => a.name);
          return {
            id, name, args, mutated: false,
            result: {
              ok: false,
              error: `no agent named "${args.agent}" is defined here — ${names.length ? `the agents are: ${names.join(', ')}` : 'this workspace defines none (.acuvo/agents/*.md)'}. Delegate without \`agent\`, or use one of those names.`,
            },
          };
        }
      }

      const result = await (subagentImpl ? subagentImpl : runSubagent)({
        task: agentDef ? taskForAgent(agentDef, args.task) : args.task,
        ...(agentDef ? { toolNames: agentDef.toolNames, model: agentDef.model ?? undefined, agent: agentDef.name } : {}),
        /**
         * ⭐ THE BRIEF. Passed RAW, and folded into the prompt by
         * `subagent.mjs:briefFor` — one place decides how a helper is briefed,
         * so the dispatcher cannot grow a second, differently-worded version of
         * the same paragraph. A helper that receives only a task string spends
         * its four rounds rediscovering what the parent already knows.
         */
        context: args.context,
        executor,
        config,
        depth,
        maxRounds: args.maxRounds,
        commandTimeoutMs,
        budgetUsd: share,
        fleetGate: budget?.fleetGate ?? null,
        /**
         * ⭐ THE BUILD MODE. `runSubagent` re-checks `=== true` itself; passing
         * the raw argument through means the string "false" — which a model
         * emits about once in fifty when a schema says boolean — is decided in
         * ONE place rather than differently in two.
         */
        write: agentDef ? agentDef.mode !== 'read' : args.write,
        /**
         * ⚠️ AND SO IS `verify`, WHICH DECIDES WHETHER A PROCESS STARTS. Same
         * rule for the same reason: `runSubagent` requires `=== true` AND
         * `write === true`, so no reading of a stray string can turn a research
         * question into a command run.
         */
        verify: agentDef ? agentDef.mode === 'verify' : args.verify,
      });

      /**
       * ⚠️⚠️ CHARGED BACK EVEN WHEN THE HELPER FAILED. `runSubagent` returns
       * `costUsd` on both paths precisely because a helper that crashed after
       * three rounds still spent three rounds of money. Recording only the
       * successes would let a run of failing delegations cost an unbounded
       * amount while the parent's ledger insisted nothing had happened.
       */
      /**
       * ── ⚠️⚠️ AND `> 0` THREW AWAY THE FALLBACK THAT WAS BUILT FOR THIS ──────
       *
       * MEASURED: `subagent.mjs:213` is `costUsd: Number.isFinite(usage?.cost)
       * ? usage.cost : 0` — so a provider that reports tokens but no `cost`
       * yields **0**, the `> 0` guard skipped `record` entirely, and the TOKENS
       * went in the bin with it. The helper is capped at 6 rounds
       * (`subagent.mjs:81`) with a 12,000-token reply ceiling
       * (`model.mjs:138`) — up to ~72k output tokens per call, and the parent
       * may delegate every round. All of it was free in the governor's book, so
       * the parent kept spending against a ceiling it had already crossed.
       *
       * ⭐ `budget.record` ALREADY KNOWS WHAT TO DO — `budget.mjs:396-404` prices
       * from tokens when no cost is reported, and from the projection when there
       * is neither. Those two branches were unreachable from here. So the rule is
       * now: report what we actually know, and let the one module that owns
       * pricing do the pricing.
       *
       * ⚠️ `costUsd` IS OMITTED, NOT PASSED AS 0, when nothing was reported.
       * `record` treats any finite `>= 0` cost as REPORTED and stops looking —
       * passing the zero would re-close the fallback from one line further down.
       *
       * ⚠️ AND A HELPER THAT NEVER RAN A ROUND IS CHARGED NOTHING. Charging a
       * projected round for a crash that happened before the first model call
       * would be inventing money, which is the opposite failure and just as bad.
       */
      if (budget) {
        const cost = Number.isFinite(result?.costUsd) ? result.costUsd : 0;
        const tokens = Number.isFinite(result?.tokens) ? result.tokens : 0;
        const rounds = Number.isFinite(result?.roundsUsed) ? result.roundsUsed : 0;
        if (cost > 0) budget.record({ costUsd: cost, tokens });
        else if (tokens > 0) budget.record({ tokens });
        else if (rounds > 0) budget.record({});
      }
      /**
       * ── ⚠️⚠️ `mutated` IS NO LONGER ALWAYS FALSE, AND THAT IS THE WHOLE
       * DIFFERENCE BETWEEN A FEATURE AND A HALF-CONNECTED ONE ─────────────────
       *
       * A building helper's files are ON DISK by the time this returns. Every
       * downstream reader keys off this flag and nothing else:
       *
       *   · the run summary counts `executed.filter(e => e.mutated)` — a false
       *     here prints "NOTHING WAS WRITTEN" over real edits;
       *   · `parallel.mjs:84` skips any record where it is false, so two
       *     terminals could delegate writes to one file and the collision
       *     report would be empty;
       *   · `best-of.mjs:166` skips it too, so a winning attempt's delegated
       *     files would never be copied out of the attempt directory.
       *
       * ⭐ AND THE RESULT REPORTS `written[{path,bytes,previousBytes,created}]`
       * — `write_files`' EXISTING shape (`write-many.mjs:132`), not a new one.
       * A first version returned bare strings and a real run printed
       * `replaced src/calc.test.mjs (0 bytes)` for a file that was CREATED at
       * 510 bytes, because `report.mjs:describeChange` reads `bytes`/`created`
       * off the result and found neither. Reusing the shape means every reader
       * that already understood a bulk write understands this for free, and
       * `changed-paths.mjs` needs no delegate-specific arm at all.
       *
       * `mutatedPath` follows the same convention exactly (`tools.mjs:954` —
       * set only when there is exactly one file).
       */
      const built = Array.isArray(result?.written) ? result.written : [];
      return {
        id,
        name,
        args,
        result,
        mutated: built.length > 0,
        mutatedPath: built.length === 1 ? built[0].path : undefined,
      };
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
    /**
     * ── ⚠️⚠️ AND IT SPENDS MONEY THE GOVERNOR COULD NOT SEE ──────────────────
     *
     * `vision.mjs` makes its OWN model call and returns `costUsd`
     * (`vision.mjs:261`) — and nothing read it. The only bound was a COUNT:
     * `MAX_LOOKS_PER_PROCESS = 12` (`vision.mjs:47`). A count is not a ceiling.
     * Vision calls are the expensive per-token kind, twelve looks is a real
     * number for a design loop, and `--budget` is the one differentiator this
     * package actually claims — so a run could cross the number the user typed
     * twelve times over and report having stayed inside it.
     *
     * ⭐ Charged back through the same `budget.record` the model rounds use, so
     * `acuvo spend`, the audit ledger and the projection all see one number.
     * ⚠️ Only on a LOOK that happened: a refusal (no key, over the cap, unreadable
     * file) returns `ok: false` and costs nothing, and charging for it would make
     * the ledger a work of fiction in the cheapest possible direction.
     *
     * ⚠️ THE DOLLAR IS EXACT; THE TOKEN COUNT IS NOT RECORDED, and that is stated
     * rather than papered over. `vision.mjs:253-262` returns `costUsd` and
     * `approxImageTokens` but never `usage.total_tokens` — and
     * `approxImageTokens` is an ESTIMATE OF THE IMAGE, not the round's usage, so
     * feeding it to `budget.record` would corrupt the one honest token total with
     * a different quantity wearing the same name. The ceiling is expressed in
     * dollars and the dollars are right; the token counter under-reports a look,
     * which is a gap in `vision.mjs`'s return shape, not one to fake here.
     */
    case 'read_image': {
      const result = await readImage({ ...args, root: executor.root });
      if (budget && result?.ok === true && Number.isFinite(result.costUsd) && result.costUsd > 0) {
        budget.record({ costUsd: result.costUsd });
      }
      return { id, name, args, result, mutated: false };
    }

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
     * ⚠️ REFUSED ON A MEMORY WORKSPACE FOR THE SAME REASON AS THE WINDOWED READS
     * DIRECTLY ABOVE, and the refusal is worth spelling rather than falling
     * through: `resolveInWorkspace('(memory)', …)` would resolve a real relative
     * directory named "(memory)" under the process's cwd and fail with an ENOENT
     * about a path that describes nothing the model did.
     */
    case 'profile_table': {
      if (executor.root === MEMORY_ROOT) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is held in memory rather than on disk, so there is no file to stream — use read_file, which reads through the executor.' },
        };
      }
      return { id, name, args, result: profileTable(executor.root, args), mutated: false };
    }

    /** ⚠️ REFUSED ON A MEMORY WORKSPACE for the reason spelled one case up. */
    case 'inspect_binary': {
      if (executor.root === MEMORY_ROOT) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is held in memory rather than on disk, so there is no file to open — use read_file, which reads through the executor.' },
        };
      }
      return { id, name, args, result: inspectBinary(executor.root, args), mutated: false };
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
      /**
       * ── ⚠️⚠️ `--no-run` HELD AT THE OFFER AND NOWHERE ELSE. MEASURED. ────────
       *
       * `run_program` (this file, the `allowRun === false` guard above) states
       * the rule and the reason: *"a model can emit a call for a tool it was
       * never shown (a resumed session, a stale conversation, a provider echoing
       * an old tool list), and the flag has to hold at the point the process
       * would actually start."* `repl` and `start_process` were withheld from
       * the OFFER (`toolNamesForRounds`, the `allowRun` pushes) and then
       * dispatched anyway if the call arrived.
       *
       * MEASURED 2026-08-14 through the real `executeToolCall` with
       * `allowRun: false`:
       *   run_program   → refused, correctly
       *   repl          → RAN THE CODE, `1+1` came back as 2
       *   start_process → STARTED A REAL SERVER, pid 780, still running after
       *
       * ⭐ `start_process` is the sharper one, because a background process
       * OUTLIVES the round: `--no-run` could return having left a server bound
       * to a port. "Nothing was executed" is the one promise this flag makes.
       *
       * ⚠️ `repl_reset` IS NOT GATED, AND THAT IS THE POINT OF SPLITTING THEM.
       * It executes nothing — it KILLS the child process. Refusing the cleanup
       * verb because of a flag about running things would strand exactly what
       * the flag exists to prevent.
       */
      if (allowRun === false && name === 'repl') {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this run was started with --no-run, so no code is executed — the REPL runs the workspace\'s JavaScript for real. Report what you changed and say plainly that nothing was verified.' },
        };
      }
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
    case 'stop_process':
    case 'write_process': {
      /**
       * ⚠️⚠️ THE SAME GAP AS `repl`, AND WORSE — see the note there for the
       * measurement. A background process is the one thing in this package that
       * OUTLIVES the round that started it, so a `--no-run` run could finish,
       * report that nothing was executed, and leave a server holding a port.
       * MEASURED: pid 780, still in the registry after the call returned.
       *
       * ⚠️ ONLY THE VERB THAT STARTS SOMETHING IS GATED. `check_process` reads a
       * buffer and `stop_process` KILLS a process — refusing those under a flag
       * that means "do not run things" would leave a live process unreachable,
       * which is the orphan this module's header says the repo has already paid
       * for twice.
       */
      if (allowRun === false && name === 'start_process') {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this run was started with --no-run, so no process is started — and a background process would outlive this run holding a port. Report what you changed and say plainly that nothing was verified.' },
        };
      }
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

    /**
     * ── ⚠️⚠️ THE READER WAS NEVER PASSED, SO `review_code` COULD ONLY EVER
     *        REVIEW TEXT THE MODEL PASTED BACK AT IT ────────────────────────
     *
     * `executeReviewCode`'s second argument is documented as `{ read?:
     * (p:string)=>string }` and this call site handed it `{ root, executor }` —
     * neither of which is `read`. So `typeof deps.read !== 'function'` was true
     * on every dispatched call, and `review_code {"path":"src/api.js"}` — the
     * shape the schema asks for — answered:
     *
     *     "review_code could not read src/api.js and no content was supplied"
     *
     * every time. The only way to reach the analyser was to re-send the whole
     * file as `content`, i.e. to pay for the source twice to have it reviewed.
     *
     * ⭐ CLOSED OVER THE EXECUTOR, not over `fs`. That is what keeps the verb
     * working for the browser builder, which implements this dispatcher's reads
     * over a Map and has no filesystem at all — the same reasoning `edit_file`
     * records for going through the executor rather than through `fs`.
     *
     * ⚠️ IT THROWS ON A REFUSAL because that is the contract `executeReviewCode`
     * catches; returning the refusal object would be reviewed as source text.
     */
    case 'review_code':
      // ⚠️ Synchronous by design — it reads and analyses, it never spawns.
      return {
        id,
        name,
        args,
        mutated: false,
        result: executeReviewCode(args, {
          read: (p) => {
            const r = executor.readFile(p);
            if (!r || r.ok !== true) throw new Error(r?.error ?? 'the file could not be read');
            return r.content;
          },
        }),
      };
    case 'inspect_db':
    case 'sample_db_rows':
      return { id, name, args, result: await inspectDatabase(executor.root, { ...args, sample: name === 'sample_db_rows' }), mutated: false };
    case 'gh_issue':
    case 'gh_pr':
    case 'gh_run': {
      /**
       * ⚠️ The noun is derived from the verb rather than taken from `args`, so a
       * model cannot reach `gh_run`'s surface by passing `noun: 'run'` to
       * `gh_issue`. The tool name IS the permission.
       */
      /**
       * ⚠️⚠️ AND `--no-run` HOLDS HERE TOO. These spawn the `gh` binary, and
       * with `ACUVO_GH_WRITE=1` the surface includes `pr create` and `comment`
       * — effects visible to people who are not at this keyboard, which is the
       * exact criterion this file uses to justify double-gating `git_push`.
       * They were offered behind `allowRun` and dispatched without it.
       */
      if (allowRun === false) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this run was started with --no-run, so no command is executed. Report what you changed and say plainly that nothing was verified.' },
        };
      }
      const noun = name.slice('gh_'.length);
      return { id, name, args, result: await executeGh(executor.root, noun, args), mutated: false };
    }
    /**
     * ⚠️ THE LABEL IS A STRING LITERAL, NOT `VERCEL_TOOL_NAME`, and that is not
     * a style choice: `tools-registry-wiring.test.mjs` finds dispatch cases by
     * reading this file's source for `case '<name>':`. A constant here compiles
     * and runs, and the drift guard reports the tool as declared-but-unhandled.
     */
    case 'vercel_preview': {
      /**
       * ⚠️ `--no-run` REACHES HERE, and not for the usual spawning reason: this
       * makes HTTP calls, it starts no process. It is withheld because a deploy
       * is the largest irreversible act in the package — it spends the
       * operator's money on someone else's machine — and a user who passed the
       * cautious flag has plainly not agreed to that.
       */
      if (allowRun === false) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this run was started with --no-run, so nothing is deployed. Report what you changed and say plainly that no preview was built.' },
        };
      }
      /** A workspace held in RAM has no directory to upload. */
      if (executor.root === MEMORY_ROOT) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is held in memory rather than on disk, so there are no files to deploy.' },
        };
      }
      /**
       * ⚠️ `mutated: false` — a deployment changes VERCEL's state, never a file
       * in this workspace, and `turn.mjs` reads `mutated` to mean "this record
       * names a path". `call_endpoint` documents the same trap, which crashed a
       * real run when `start_process` got it wrong.
       */
      return { id, name, args, result: await executeVercel(executor.root, args), mutated: false };
    }
    case 'read_log':
    case 'wait_for_output':
    case 'summarize_log':
      /**
       * ⚠️ `readLog` IS THE WHOLE TOOL. `runLogTailTool` refuses outright when it
       * is absent, and for months this call site passed `{ executor }` alone — so
       * all three verbs were offered to the model and refused every single time.
       * Do not drop it back to `{ executor }`: that is not a smaller context, it
       * is these three tools turned off.
       */
      return { id, name, args, result: await runLogTailTool(name, args, { executor, readLog }), mutated: false };
    case 'call_endpoint': {
      /**
       * ── ⚠️ `--no-run` REACHES HERE TOO, AND FOR A LESS OBVIOUS REASON ──────
       *
       * This does not spawn anything, so the usual argument does not apply. It
       * is withheld anyway because it can ONLY reach a server `start_process`
       * started, `start_process` is refused under `--no-run`, and a verb that
       * can only ever answer "there is no such process" is the dead button this
       * file refuses to ship. Saying so plainly beats a confusing refusal from
       * the registry check.
       */
      if (allowRun === false) {
        return {
          id, name, args, mutated: false,
          result: {
            ok: false,
            error: 'this run was started with --no-run, so no server was started and there is nothing local to call. '
              + 'Report what you changed and say plainly that nothing was verified.',
          },
        };
      }
      /**
       * ⚠️ `mutated: false` — a POST changes the SERVER's state, never a file in
       * this workspace, and `turn.mjs` reads `mutated` to mean "this record
       * names a path". Claiming otherwise crashed a real run when
       * `start_process` did it.
       */
      return { id, name, args, result: await runHttpProbeTool(name, args, { executor }), mutated: false };
    }

    /**
     * ── ⭐ PLAYTEST — DRIVE THE PAGE, REPORT THE DEFECTS ───────────────────
     *
     * ⚠️ `allowRun === false` IS REFUSED HERE AS WELL AS AT THE OFFER, and the
     * second check is not redundant: `toolNamesForRounds` decides what the
     * model is TOLD about, and this dispatcher is what actually runs. A caller
     * that widens the tool list, replays a session, or hands the name in
     * directly reaches this switch without ever consulting the offer — which is
     * exactly how `vercel_preview` came to be double-gated.
     *
     * ⚠️ `mutated: false` — it drives a browser and writes nothing into the
     * user's tree, so it must not inflate the "N files written" line, which is
     * the one honest number in the run summary. (The Playwright MCP server does
     * drop a `.playwright-mcp/` snapshot beside the workspace; that is the
     * server's own doing, not a file this verb produced, and claiming it would
     * make `mutatedPath` name a file this tool never chose.)
     */
    case 'playtest': {
      if (allowRun === false) {
        return {
          id, name, args, mutated: false,
          result: {
            ok: false,
            drove: false,
            error: 'this run was started with --no-run, so no browser was started and the page was NOT tested. '
              + 'Say plainly that nothing was verified.',
          },
        };
      }
      return { id, name, args, result: await runPlaytestTool(name, args, { executor }), mutated: false };
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
     * ── ⭐⭐ THE ONLY VERB THAT ASKS A COMPILER AND THEN WRITES ──────────────
     *
     * ⚠️ SEPARATE FROM THE FOUR ABOVE ON PURPOSE, EVEN THOUGH IT SHARES THEIR
     * GATE. They return `mutated: false` unconditionally, and folding a write
     * into that case is a one-character mistake away from a rename that changes
     * 40 files while the run reports "No files changed" — the exact defect
     * `write-many.mjs` was built to close for `evaluate`.
     *
     * ⭐ `mutatedPath` follows `write_files`' rule, not `write_file`'s: named
     * only when exactly one file changed, because `changed-paths.mjs` reads the
     * `written[]` array for the multi-file case and a single path would
     * under-report a 12-file rename to the collision detector.
     */
    case 'rename_symbol': {
      if (executor.root === MEMORY_ROOT) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is held in memory rather than on disk, and a language server can only read real files — there is no semantic rename here.' },
        };
      }
      const result = await renameSymbol(executor, args, { env: process.env, lspAvailable });
      return {
        id, name, args, result,
        mutated: (result.written?.length ?? 0) > 0,
        mutatedPath: result.written?.length === 1 ? result.written[0].path : undefined,
      };
    }

    /**
     * ── ⭐⭐ THE THREE AST EDITS, DISPATCHED AS ONE ARM ───────────────────────
     *
     * ⚠️ THE MEMORY-WORKSPACE REFUSAL IS COPIED FROM `rename_symbol` ABOVE AND
     * IS NOT OPTIONAL. These read the file from DISK through the project's own
     * `typescript`; a workspace held in memory has no file for the parser to
     * open, and the failure without this check is an ENOENT naming a path that
     * was never meant to exist.
     *
     * ⭐ ONE ARM FOR THREE VERBS because they differ only in which planner runs
     * — `runTsEdit` takes the name — and the result shape, the mutation
     * accounting and the refusal are identical. Three arms would be three places
     * to forget the check above.
     */
    case 'insert_before_symbol':
    case 'insert_after_symbol':
    case 'replace_function_body': {
      if (executor.root === MEMORY_ROOT) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is held in memory rather than on disk, and the compiler can only read real files — there is no syntax-aware edit here. Use edit_file.' },
        };
      }
      const result = await runTsEdit(name, executor, args);
      return {
        id, name, args, result,
        mutated: (result.written?.length ?? 0) > 0,
        mutatedPath: result.written?.length === 1 ? result.written[0].path : undefined,
      };
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
    case 'git_branch':
    case 'git_push':
    // ⚠️ `git_worktree` JOINS THE MEMORY-WORKSPACE REFUSAL AND THE `allowRun`
    // GATE BELOW, not just the offer. A checkout has to land on a real disk.
    case 'git_worktree':
      if (executor.root === '(memory)') {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: 'this workspace is not backed by a git repository, so git commands are unavailable here' },
        };
      }
      /**
       * ⚠️ THE GATES HOLD AT THE DISPATCHER, NOT ONLY AT THE OFFER. This file
       * already paid for that lesson twice — `repl` RAN CODE and
       * `start_process` STARTED A SERVER under `--no-run`, because their gate
       * lived in `toolNamesForRounds` alone (see
       * `test/no-run-holds-at-dispatcher.test.mjs`). A resumed session or a
       * provider echoing a stale tool list is all it takes.
       */
      if (allowRun === false && (name === 'git_commit' || name === 'git_branch' || name === 'git_push' || name === 'git_worktree')) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: `--no-run was passed, so ${name} is not available in this run` },
        };
      }
      // ⚠️ `executor.env` is not set by `createLocalExecutor`; it exists so a
      // test can hand in a plain `{ root, env }` executor and drive this branch
      // without mutating the real process environment.
      if (name === 'git_push' && !pushEnabled(executor.env ?? process.env)) {
        return {
          id, name, args, mutated: false,
          result: { ok: false, error: `pushing is turned off. The operator has to enable it by name: ${ALLOW_PUSH_ENV}=1. Commit the work and hand the branch over instead.` },
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
    /**
     * ⚠️ `mutated: false` EVEN THOUGH `create` WRITES A WHOLE CHECKOUT — the
     * same call `run_command` makes one case over. `mutated` feeds the "N files
     * written" line, which names paths in THIS workspace, and a worktree's files
     * are deliberately not in it.
     */
    case 'git_worktree':
      return {
        id, name, args, mutated: false,
        result: await executeWorktree(executor.root, args, { env: executor.env ?? process.env }),
      };
    case 'git_branch':
      return {
        id, name, args, mutated: false,
        result: await gitBranch(executor.root, { name: args.name, dryRun: executor.dryRun }),
      };
    case 'git_push':
      return {
        id, name, args, mutated: false,
        result: await gitPush(executor.root, {
          remote: args.remote,
          openPullRequest: args.openPullRequest === true,
          pullRequestTitle: args.pullRequestTitle,
          pullRequestBody: args.pullRequestBody,
          pullRequestBase: args.pullRequestBase,
          dryRun: executor.dryRun,
          env: executor.env ?? process.env,
        }),
      };
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
