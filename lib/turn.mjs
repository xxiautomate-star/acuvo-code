/**
 * ONE AGENT TURN — gather, ask once, execute, report.
 *
 * ── ⚠️ WHY SINGLE-SHOT IS A DESIGN, NOT A STUB ──────────────────────────────
 * The obvious build is a `while (toolCalls.length) { … }` loop. It is also the
 * one that produces a tool-calling agent nobody can trust: unbounded rounds
 * against an unmetered paid endpoint, no ceiling on what one command spends,
 * and a failure mode where the model reads eleven files and writes none while
 * the user watches a spinner. The console already learned the ceiling lesson the
 * expensive way — `MAX_TOOL_ROUNDS = 5` exists there because of TPM 413s, not
 * because five was ever the right number.
 *
 * So this turn spends EXACTLY ONE completion and the cost of a command is
 * knowable before you run it. The obvious objection — "then the model must
 * write without reading" — is answered by GATHERING FIRST: the CLI walks the
 * workspace with the same executor and hands the model a tree before it asks
 * anything. That is the trade: deterministic context instead of an agentic
 * fetch, and it covers the common case (make a thing / change a named thing)
 * without a loop.
 *
 * ⚠️ AND WHERE IT DOES NOT COVER IT, THE TURN SAYS SO OUT LOUD. Two honest
 * limits, both found by RUNNING this rather than by reasoning about it:
 *
 *   1. A model offered a read tool will use it, even when told the result
 *      cannot return — so the single-shot turn offers only `write_file`
 *      (see SINGLE_SHOT_TOOL_NAMES). If a future turn widens that, a read-only
 *      response is reported rather than silently discarded.
 *   2. This model writes ONE file per response no matter how many it promises,
 *      so `promisedButMissing` names the files the prose claimed and the disk
 *      does not have.
 *
 * Neither is hidden behind an optimistic summary. A tool result that silently
 * goes nowhere is the dishonest version of this same design.
 */

import { executeToolCall, toolSchemasFor, SINGLE_SHOT_TOOL_NAMES, toolNamesForRounds } from './tools.mjs';
import { budgetedAsker } from './ask-user.mjs';
import { normalizeRelativePath } from './workspace.mjs';
import { callModel, DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS } from './model.mjs';
/**
 * ⭐ THE DEFAULT IS THE CHAIN, NOT THE SINGLE CALL. `callModel` is still
 * exported and still the unit under test elsewhere — this only changes what the
 * loop reaches for by default, so one provider having a bad ten minutes stops
 * being an outage for every user of the CLI at once.
 */
import { callChain } from './chain.mjs';
import { readProjectMemory, memoryPromptBlock } from './project-memory.mjs';
import { recall, learnedPromptBlock } from './learned.mjs';
import { createLivePrinter } from './stream.mjs';
import { createPainter } from './colour.mjs';
import { refusedCommitPath, formatStatusForModel } from './git.mjs';
import { checkAcceptanceConsent, trustAuthoredCriteria as recordAcceptanceTrust } from './acceptance-consent.mjs';
import { describeChange, formatChanges } from './report.mjs';
import { readMcpConfig, connectServer, mcpToolSchemas, callMcpTool, closeConnections, parseNamespaced } from './mcp.mjs';
import { checkMcpConsent, recordTrust } from './mcp-consent.mjs';
import { filterToolNames, mcpDecision, OPEN_POLICY } from './policy.mjs';
import { clampOutput, formatRunForModel, DEFAULT_COMMAND_TIMEOUT_MS, ALLOWED_BINARIES, PRESET_NAMES } from './command.mjs';
/**
 * ── ⭐ THE COUNTDOWN THE MODEL COULD NOT SEE ────────────────────────────────
 * `plan-ledger.mjs` measured it: round 8 of 8 was BYTE-IDENTICAL to round 1, so
 * the model spends its last round the way it spent its first and the last thing
 * it was asked for (a commit, a README) is the one that dies. The banner is
 * prompt text, injected once per round — it changes nothing about when the loop
 * stops. See `planBannerFor` for the two conditions that keep it fail-safe.
 */
import { loadPlan, formatBanner, planFileFor } from './plan-ledger.mjs';
/**
 * ── ⭐⭐ AND THE VERDICT ABOUT THE COMMAND THE USER NAMED ────────────────────
 * `acceptance.mjs` measured the other half: four probes, all exit 0, all green,
 * all about a command the user never asked for. `verification` below answers
 * "did something this process ran exit 0"; these answer "was it the thing you
 * asked for", and the two must never be allowed to stand in for each other.
 */
import {
  deriveAcceptance, loadAcceptance, evaluateAcceptance, checkAcceptance, formatVerdict,
} from './acceptance.mjs';
/**
 * ── ⭐ THE THREE FORMATTERS, AND WHY THEY ARE IMPORTED RATHER THAN WRITTEN ──
 * Each module owns how its own result should read to a model, because each
 * knows which field is the answer and which is bookkeeping. `toolResultText`
 * below is the ONLY thing the next round sees, so a result rendered through the
 * generic JSON default arrives escaped, truncated at a quarter of the read
 * budget, and — for a skill — stripped of the sentence that says a skill grants
 * no permissions.
 */
import { formatWindowForModel } from './read-window.mjs';
import { formatLspForModel } from './lsp.mjs';
import { formatProgramRunForModel } from './spawn-argv.mjs';
/**
 * ⭐ AND THE SKILLS CATALOGUE, WHICH IS A PROMPT CONCERN AND NOT A TOOL ONE.
 * `read_skill`'s own description tells the model to pass a name "exactly as it
 * appears in the SKILLS list". Until that list is in the system prompt there is
 * no such list, and the tool is reachable but undiscoverable — measured: given
 * a task that did not name the tool, the model reached for `list_dir` +
 * `read_file` on `.acuvo/skills/` instead of calling it.
 */
import { discoverSkills, skillsPromptBlock, formatSkillForModel } from './skills.mjs';

/**
 * ── ⭐⭐ THE HORIZON. COMPACTION IS NOT A FLAG — IT LIVES IN THE LOOP ────────
 *
 * A long session's history grows monotonically: every `read_file` result stays
 * in the transcript forever, and 57–63% of a real transcript measured here was
 * exactly that. The round cap existed largely because the context would burst.
 *
 * ⚠️ IT IS FREE WHEN THERE IS NOTHING TO DO. An under-budget transcript
 * short-circuits before any pass runs and is returned byte-identical, so this
 * is NOT gated on a round number — gating on `round > 1` is how it stops firing
 * on the one long session that needed it.
 */
import { compactMessages, estimateMessagesTokens } from './compact.mjs';

/**
 * ── ⭐⭐ THE THREE MODULES THAT MOVE THE STOP CONDITION OFF A COUNTER ────────
 *
 * ⚠️ EACH OF THESE SHIPPED FINISHED AND WAS IMPORTED BY NOTHING, which in this
 * package is the same as not shipping. These three import lines are the entire
 * difference between "1,900 lines of very well-commented dead weight" and a
 * command a user can type. That is not hyperbole: 7,397 lines were once in
 * exactly this state, every one of them with a green unit test.
 *
 * · `budget.mjs`   — the loop stops when the NEXT round would cross a dollar
 *                    figure. The round counter stays as a backstop only.
 * · `repo-map.mjs` — the pre-read the model gets. It replaces
 *                    `gatherWorkspaceContext` below: it reaches the whole tree
 *                    instead of two levels, it is bounded in TOKENS rather than
 *                    in file count, and — the part that is a defect and not an
 *                    improvement — it does not send the BODY of a gitignored
 *                    file to the provider.
 * · `stuck.mjs`    — a run going in circles gets one hint instead of burning
 *                    its remaining rounds proving it is stuck.
 */
import { createBudget } from './budget.mjs';
import { repoMapForExecutor } from './repo-map.mjs';
import { detectStuck, nudgeMessage } from './stuck.mjs';

/**
 * ── ⭐ THE ONE PLACE THE PAGE VERDICT REACHES THE MODEL ─────────────────────
 * `see_page` returns a render plus an ~89-token verdict. Without the
 * `case 'see_page'` in `toolResultText` below, the verdict is computed and then
 * buried: the record falls through to `JSON.stringify` and the model reads 205
 * tokens of escaped JSON with `findings` in it twice, instead of 26. That is
 * this package's signature bug in miniature — built, and reached by nothing.
 */

/** How much of the tree to show. Enough to orient in a real project, bounded so
 *  a node_modules-adjacent directory cannot eat the whole prompt. */
const CONTEXT_MAX_ENTRIES = 120;

/**
 * ── ⚠️ THE TREE ALONE WAS NOT ENOUGH — MEASURED, NOT PREDICTED ─────────────
 * First live run of this CLI, 2026-08-09, against a two-file fixture:
 *
 *   prompt: "add src/health.js reading the version from src/version.js"
 *   reply:  "First, let me check the version.js file to see how it's exported."
 *           → one read_file call, zero writes, 1,036 tokens, $0.000231, and a
 *             summary that correctly said nothing had changed.
 *
 * The design was working and the tool was useless. A model given a FILE TREE
 * still has to open a file before it can write code that agrees with it, and in
 * a one-round turn that read arrives too late to be worth anything.
 *
 * ⚠️ AND THE FIX IS NOT A STERNER PROMPT. Telling the model "do not read" would
 * make it write against a guess — a worse outcome than the honest empty one,
 * because a wrong file gets committed and an empty run does not. What it needed
 * was for the answer to already be in front of it, so the SMALL files come with
 * the tree. That is the whole bargain of single-shot: pay for the context up
 * front and deterministically, instead of paying for a round-trip to fetch it.
 *
 * The budgets are small on purpose. A real repo has more source than any
 * context window, so this is a head start, not a replacement for the loop that
 * a later slice will add.
 */
const CONTEXT_MAX_FILES = 12;
const CONTEXT_MAX_FILE_BYTES = 8_000;
const CONTEXT_MAX_TOTAL_BYTES = 40_000;

/**
 * Files that are text, are large, and teach the model nothing. A lockfile alone
 * would eat the entire content budget and displace every source file.
 */
const CONTEXT_SKIP = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.DS_Store)$|\.(min\.js|min\.css|map|lock|log|png|jpg|jpeg|gif|webp|ico|pdf|zip|woff2?|ttf|mp4|wasm)$/i;

/**
 * Walk the workspace with the SAME executor the model gets — two directory
 * walkers would be two ideas about what is inside the project, and the one the
 * model is shown must be the one the rules apply to.
 *
 * Two levels deep: the root plus one, which is where a project's shape lives
 * (`src/`, `app/`, `lib/`) without paying for a full recursive listing.
 */
export function gatherWorkspaceContext(executor, {
  maxEntries = CONTEXT_MAX_ENTRIES,
  maxFiles = CONTEXT_MAX_FILES,
  maxTotalBytes = CONTEXT_MAX_TOTAL_BYTES,
} = {}) {
  const lines = [];
  /** Candidates for content inclusion, in walk order. */
  const candidates = [];
  const root = executor.listDir('.');
  if (!root.ok) return { ok: false, error: root.error, text: '' };

  const consider = (path, bytes) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    /**
     * ── ⚠️⚠️ THE WORST BUG THIS PACKAGE HAS HAD ──────────────────────────────
     *
     * The pre-load reads every small file in the tree and puts its CONTENTS in
     * the prompt. `.env` is a small file. So was `id_rsa`. Verified 2026-08-10
     * on a fixture: `OPENROUTER_API_KEY=sk-or-v1-…`, a database password and a
     * private key all appeared verbatim in the text sent upstream.
     *
     * ⭐ AND IT NEEDED NO ATTACKER. Not a poisoned repo, not a crafted prompt —
     * an ordinary run in an ordinary project with an ordinary `.env`. `--dry-run`
     * did not stop it, because a dry run still builds the prompt. Worse, the
     * provider chain (chain.mjs) retries across up to FOUR upstreams, so one
     * rate limit fanned the same secrets to three more companies.
     *
     * ⚠️ THE IRONY IS THE LESSON. `command.mjs` scrubs the environment so a
     * spawned process cannot read a key, `git.mjs` refuses to COMMIT these exact
     * files, and `media.mjs` keeps tokens out of tool results — three separate
     * guards against leaking credentials, and the widest channel in the package
     * had none, because nobody thought of "the prompt" as an exfiltration path.
     *
     * ⭐ It reuses `refusedCommitPath` DELIBERATELY. That list already encodes
     * "files that must never leave this machine", it is already tested, and a
     * second copy would be the one that goes stale.
     */
    if (refusedCommitPath(path)) return;
    if (CONTEXT_SKIP.test(name)) return;
    if (typeof bytes === 'number' && bytes > CONTEXT_MAX_FILE_BYTES) return;
    candidates.push(path);
  };

  let budget = maxEntries;
  for (const entry of root.entries) {
    if (budget <= 0) break;
    budget -= 1;
    if (entry.skipped) {
      lines.push(`${entry.name}/  (not listed)`);
      continue;
    }
    if (entry.type !== 'dir') {
      lines.push(`${entry.name}  (${entry.bytes} bytes)`);
      consider(entry.name, entry.bytes);
      continue;
    }
    lines.push(`${entry.name}/`);
    const child = executor.listDir(entry.name);
    if (!child.ok) continue;
    for (const sub of child.entries) {
      if (budget <= 0) break;
      budget -= 1;
      const path = `${entry.name}/${sub.name}`;
      lines.push(`  ${path}${sub.type === 'dir' ? '/' : ''}`);
      if (sub.type === 'file') consider(path, sub.bytes);
    }
  }

  // ⚠️ READ THROUGH THE EXECUTOR, not through `fs`. It applies the same path
  // rules, the same size ceiling and the same binary refusal the model's own
  // read_file gets — so the pre-load can never see something the tool could not.
  const files = [];
  let spent = 0;
  for (const path of candidates) {
    if (files.length >= maxFiles || spent >= maxTotalBytes) break;
    const read = executor.readFile(path);
    if (!read.ok) continue;
    if (spent + read.bytes > maxTotalBytes) continue;
    spent += read.bytes;
    files.push({ path, content: read.content });
  }
  const omitted = candidates.length - files.length;

  const treeText = lines.length > 0 ? lines.join('\n') : '(the workspace is empty)';
  const parts = ['Workspace contents (two levels):', treeText];
  if (files.length > 0) {
    parts.push('', 'File contents (already read for you — do NOT call read_file on these):');
    for (const f of files) {
      parts.push('', `===== ${f.path} =====`, f.content.trimEnd());
    }
  }
  if (omitted > 0) {
    // Named honestly: a model that is told everything is present will write
    // against a file it never saw. Knowing what is MISSING is what lets it ask
    // for the right thing on a re-run.
    parts.push('', `(${omitted} other file${omitted === 1 ? ' was' : 's were'} too large or too numerous to include.)`);
  }

  return { ok: true, text: parts.join('\n'), files, truncated: budget <= 0 || omitted > 0 };
}

/**
 * ── ⚠️ TWO PROMPTS, BECAUSE THERE ARE TWO DIFFERENT CONTRACTS ──────────────
 * A single-shot turn has to tell the model "there is no next round, do not
 * explore". A looping session has to tell it the opposite, plus the thing that
 * makes the loop worth its cost: RUN WHAT YOU WROTE AND READ THE EXIT CODE.
 *
 * ⚠️ AND THE DEFAULT ARGUMENT IS SINGLE-SHOT ON PURPOSE. The single-round
 * contract is the one that breaks silently if it goes missing — a model told
 * nothing will explore, spend the turn, and write nothing. The looping contract
 * fails loudly instead.
 */
export function systemPrompt({ maxRounds = 1, allowRun = true, offeredNames = [], untilDone = false } = {}) {
  if (maxRounds > 1) return loopSystemPrompt(maxRounds, allowRun, offeredNames, untilDone);
  return [
    'You are Acuvo Code, a coding agent running in a terminal on the user\'s own machine.',
    '',
    'HOW THIS TURN WORKS — read it, because it is not the usual agent loop:',
    '- You get ONE response. There is no second round, so anything you plan to do must be done in this response.',
    '- The workspace listing AND the contents of its small files are already in the message below. You have',
    '  everything you are going to get. Do not spend the turn exploring.',
    '- To change the project you MUST emit write_file tool calls. Describing the change in prose does nothing —',
    '  no file is written unless a tool call writes it.',
    '- write_file replaces the whole file. Emit the COMPLETE contents, never a diff, a patch, or "... rest unchanged".',
    // ⚠️ MEASURED 2026-08-09, second live run: asked for two files, the model
    // said "I\'ll create the two required files" and emitted ONE tool call. With
    // no second round there is nowhere to finish, so the prose promised a file
    // that never existed. Models default to one call at a time unless told
    // otherwise; this line is cheaper than a loop and fixes the same symptom.
    '- Emit ONE write_file call PER FILE, all in this single response. Three files means three tool calls.',
    '  Do not describe a file you are not also writing in this response — there is no next turn to finish it in.',
    '- write_file is the ONLY tool you have this turn, deliberately: a read could not reach you before the turn',
    '  ends. If a file you need was too large to be included, write what you safely can and say in your reply',
    '  which file you still need to see.',
    '',
    'RULES ABOUT PATHS:',
    '- Every path is relative to the workspace root. Absolute paths, drive letters and ".." are refused by the executor.',
    '- Writes into .git/, node_modules/, .next/ and .vercel/ are refused.',
    '',
    'STYLE: write complete, runnable code. No placeholders, no TODO stubs, no truncation.',
    'Keep the prose short — a sentence or two on what you did and why. The files are the deliverable.',
  ].join('\n');
}

/**
 * The looping contract.
 *
 * ⚠️ THE LINE THAT MATTERS MOST IS "DO NOT SAY IT IS DONE UNTIL A COMMAND
 * EXITED 0". Everything else here is mechanics. A model that writes code, does
 * not run it, and reports success has produced the exact failure this whole
 * feature exists to remove — and unlike the CLI's own summary, which is
 * computed from exit codes and cannot lie, the model's prose is free to.
 */
function loopSystemPrompt(maxRounds, allowRun, offeredNames = [], untilDone = false) {
  return [
    'You are Acuvo Code, a coding agent running in a terminal on the user\'s own machine.',
    '',
    /**
     * ⚠️ TELL IT WHICH WALL IS REAL. Under `--until-done` the round count is a
     * backstop in the hundreds and the actual limit is a dollar figure; saying
     * "you get up to 200 rounds" would be true and would encourage the model to
     * pace itself against a number that will never be reached. It is the model's
     * sense of urgency that this line sets, so it has to name the binding
     * constraint and not the decorative one.
     */
    untilDone
      ? 'HOW THIS SESSION WORKS: the session runs until the work is actually done or the spending budget'
      : `HOW THIS SESSION WORKS: you get up to ${maxRounds} rounds. After each of your responses, the result of`,
    untilDone
      ? 'runs out — there is no small round budget to race. Do not stop early and do not pad; finish what was'
      : 'every tool call comes back to you, so you can read it and react. Use that.',
    ...(untilDone ? ['asked. After each of your responses, the result of every tool call comes back to you.'] : []),
    '',
    'CHANGING FILES:',
    '- To change the project you MUST emit write_file tool calls. Describing a change in prose does nothing.',
    '- write_file replaces the WHOLE file. Emit the complete contents, never a diff, a patch or "... unchanged".',
    '- Several tool calls in ONE response is fine and expected — three files means three write_file calls.',
    ...(allowRun ? [
      // ⚠️ MEASURED, live, 2026-08-09: given 3 rounds the model spent round 1 on a
      // bare write, round 2 on a bare run and round 3 on a bare fix — one action
      // per round, so a 3-round budget bought 3 actions and the fix was never
      // re-checked. It was not incapable of batching (it writes three files in
      // one response); it simply had not been told a round is a budget.
      '- ⚠️ A ROUND IS EXPENSIVE. In the SAME response, write the files AND then call run_command to check',
      '  them. Never spend a whole round on a write alone, and never finish on a write you have not run.',
      /**
       * ⚠️ FOUND BY THE BENCH ON ITS FIRST RUN — and only by the bench, because
       * it needs a whole transcript to see. The `git` task went: round 5 delete
       * + git_status, round 6 git_diff, budget exhausted, NO COMMIT. Every
       * check it failed ("nothing was committed", "left the tree dirty") was
       * downstream of one habit: serialising independent READS one per round.
       *
       * ⭐ git_status and git_diff do not depend on each other. Batched, that is
       * one round instead of two, and the commit fits. The write+run line above
       * already taught this for one specific pair; the model generalised it to
       * nothing else, which is the recurring lesson about prompt rules — they
       * are obeyed narrowly and literally.
       */
      '- ⚠️ THE SAME APPLIES TO READS. Tool calls in one response all run together, so batch every read that',
      '  does not depend on another: git_status AND git_diff together, several read_file calls together,',
      '  search_text AND find_files together. Spending a round on one lookup is how you run out before',
      '  finishing — the last step asked for (a commit, a cleanup) is the one that gets cut.',
    ] : []),
    '- The workspace listing and the contents of its small files are already in the message below. Only call',
    '  read_file for something that is not already there.',
    '- Paths are relative to the workspace root. Absolute paths, drive letters and ".." are refused, and so are',
    '  writes into .git/, node_modules/, .next/ and .vercel/.',
    ...(allowRun ? [
      '',
      /**
       * ── ⭐ THE CAPABILITIES THE MODEL WOULD NEVER REACH FOR, SAID OUT LOUD ──
       *
       * `see_page`, `speak`, `transcribe`, `make_document` and `generate_image`
       * all have good schemas, and a schema tells a model WHAT a tool does. It
       * does not tell it WHEN — and the measured behaviour of this model is that
       * it reaches for the familiar shape (write a file, run a test) and never
       * discovers that "looks wrong" is a thing it can now check.
       *
       * ⚠️⚠️ THIS BLOCK USED TO OPEN WITH "AND NO OTHER TERMINAL AGENT CAN",
       * AND THAT WAS FALSE. Playwright MCP and Chrome DevTools MCP are one
       * install away from any terminal agent; the claim was struck from the
       * README on 2026-08-10 and had no business surviving HERE, where it is
       * worse — a README line is read by a person who can check it, and a system
       * prompt line is repeated to users as fact by the model itself.
       *
       * ⭐ WHAT IS ACTUALLY TRUE IS BETTER MOTIVATION ANYWAY: looking is CHEAP.
       * The render comes back as a short list of measured problems (~89 tokens),
       * not a 3,072-token screenshot the model has to interpret — so "look at it
       * again" costs about a thousandth of a round, and there is no reason to
       * ship a page unseen.
       *
       * ⚠️ These lines are gated on the tools actually being offered, so an
       * install without the services never reads about capabilities it lacks —
       * the prompt equivalent of a dead button.
       */
      ...(offeredNames.includes('see_page') ? [
        '',
        'DESIGN — YOU CAN LOOK AT WHAT YOU BUILT, AND LOOKING IS CHEAP:',
        '- After writing ANY html, call `see_page` on it. You cannot judge a layout by reading its',
        '  source: it renders the page in a real browser and hands back the MEASURED problems',
        '  (invisible text, overflow, cramped sections) as a short list — about 89 tokens, not a',
        '  3,072-token screenshot you would have to squint at. Fix what it reports, then look again.',
        '- ⚠️ Do NOT declare a page finished without looking at it once. "It should look right" is',
        '  the sentence that ships a white heading on a white background.',
      ] : []),
      ...(offeredNames.includes('generate_image') ? [
        '- Need a hero, an avatar, an empty-state illustration? `generate_image` writes a real image',
        '  into the workspace and you reference it normally. Do not link a stock URL or leave a grey box.',
      ] : []),
      ...(offeredNames.includes('make_document') || offeredNames.includes('transcribe') || offeredNames.includes('speak') ? [
        '',
        'BEYOND CODE — combine these, they are why this tool exists:',
        ...(offeredNames.includes('make_document') ? [
          '- A report, invoice, deck or one-pager: write it as HTML, `see_page` it, then `make_document`',
          '  to pdf/pptx. That is a real deliverable, not a markdown file someone still has to format.',
        ] : []),
        ...(offeredNames.includes('transcribe') ? [
          '- An audio or video file in the workspace: `transcribe` it, then do the actual work on the',
          '  text — summarise it, turn it into tickets, extract the decisions.',
        ] : []),
        ...(offeredNames.includes('speak') ? [
          '- Asked for a voiceover, a narrated walkthrough or an audio summary: `speak` writes the file.',
        ] : []),
      ] : []),
      '',
      'VERIFYING — THIS IS THE POINT OF HAVING ROUNDS:',
      '- After you write code, RUN it with run_command and read the exit code.',
      '- `node --test <file>` for plain Node tests · `npm test` when package.json has that script ·',
      '  `npx vitest run` for a vitest project · `node <file>` to just execute something · `tsc --noEmit` to type-check.',
      /**
       * ── ⚠️⚠️ THE MODEL DID NOT KNOW THE OTHER LANGUAGES EXISTED ─────────────
       *
       * Six vetted presets — python, go, rust, ruby, make, node-bin — ship with
       * per-language argument grammars and their own test file, and `grep -c
       * preset lib/turn.mjs` returned ZERO. So on a Python repo the model read a
       * prompt that named only Node verbs, concluded it could not verify
       * anything, and either gave up or wrote files it never ran.
       *
       * ⭐ THE REFUSAL ALREADY NAMES THE WAY OUT — but only AFTER a wasted round
       * spent discovering the wall. Saying it here costs nothing and buys the
       * round back. It is deliberately phrased as "ask the user", because
       * enabling a preset is a permission decision and `.acuvo/commands.json` is
       * a file the agent can write: it must never grant itself the ecosystem.
       */
      `- OTHER LANGUAGES: this workspace may enable ${PRESET_NAMES.join(', ')}. If it has, \`pytest -q\`,`,
      '  `go test ./...`, `cargo test`, `rspec` and `make test` run exactly like `npm test` does — just call them.',
      '- If one is refused, the refusal tells you the one line that enables it. ⚠️ Do NOT enable it yourself by',
      '  writing .acuvo/commands.json — say what you need and why, and let the person decide. Meanwhile verify',
      '  whatever you CAN: a syntax check, an import, a smaller command that is already allowed.',
      '- A non-zero exit code is a fact, not an opinion. Read stderr, fix the file with write_file, run it again.',
      '- ⚠️ Do NOT claim the task is done until a command you ran exited 0. If you run out of rounds with it still',
      '  failing, say plainly what still fails and why — a false "done" is worse than an honest failure.',
      /**
       * ⚠️ THIS LINE USED TO SAY "when the command exits 0, STOP. Do not keep
       * making changes after it passes." It had to change with the closing
       * round, and it is the kind of coupling that gets missed: the loop would
       * have granted a final round for the commit while the prompt told the
       * model not to use it. Instruction and mechanism have to agree.
       */
      '- When the command exits 0 the CODE is done — but the TASK may not be. If anything else was asked',
      '  (commit it, delete a scratch file you made, a second file), do that now. Otherwise stop.',
      '',
      `run_command is deliberately narrow: ${ALLOWED_BINARIES.join(', ')} only, no shell, no pipes, no &&, no quotes.`,
      /**
       * ⚠️ MEASURED, AND IDENTICAL ACROSS TWO SEPARATE LIVE RUNS: the model
       * reaches for `node -e "import('./x.js').then(...)"` to check its work.
       * The double quotes are refused by the character whitelist, so the round
       * is spent, the refusal is read, and the next round writes a temp file
       * and runs that — which is what it should have done first.
       *
       * ⭐ That is a deterministic ~20% tax on a five-round budget, and it is
       * not a model quality problem: `node -e` is the correct instinct
       * EVERYWHERE ELSE, and nothing told it the rule here is different. One
       * line of prompt buys a whole round back, every session.
       */
      /**
       * ⭐ POINTS AT A TOOL NOW, NOT AT A RULE. The previous version of these
       * lines told the model to write a temp file instead of using `node -e`.
       * It still reached for `node -e` on the very next run — the third time a
       * prompt rule was obeyed narrowly or not at all. `evaluate` gives it the
       * thing it wants, so there is nothing left to disobey.
       */
      '⚠️ `node -e` is REFUSED (a command here cannot contain quotes). To check a value, call the',
      '`evaluate` tool with the JavaScript instead — relative imports work and the file is cleaned up.',
      'If a command is refused, the refusal says exactly why — fix the command rather than trying another spelling.',
    ] : [
      '',
      // ⚠️ DO NOT NAME THE FLAG. Two different settings land here (--no-run and
      // --dry-run) and the prompt cannot tell which. Measured on the first dry
      // run: the model told the user "the --no-run flag was passed" when they
      // had passed --dry-run — a small lie, invented only because this line
      // handed it a specific cause to repeat.
      'You have NO way to run anything this session, so you cannot verify your work.',
      'Say so plainly rather than implying the code was tested. Do not guess why — just state that you could not run it.',
    ]),
    '',
    'STYLE: write complete, runnable code. No placeholders, no TODO stubs, no truncation.',
    'Keep the prose short — a sentence or two per round on what you did and what you are about to check.',
  ].join('\n');
}

export function userPrompt({ task, contextText, root }) {
  return [
    `Workspace root: ${root}`,
    '',
    // `contextText` carries its own headings — the gather owns the shape of what
    // it produced, so this function cannot label a tree that now also has file
    // bodies underneath it.
    contextText,
    '',
    'Task:',
    task,
  ].join('\n');
}

/**
 * ── ⚠️ THE MODEL'S PROSE IS NOT EVIDENCE, AND THIS IS HOW WE CATCH IT ──────
 * Measured across four live runs, 2026-08-09: asked for a module AND its test,
 * `deepseek/deepseek-v3.2` replied *"I'll create the two required files"* and
 * emitted ONE write_file call — every time. Neither an explicit prompt rule nor
 * `parallel_tool_calls: true` changed it. With no second round, the second file
 * simply never exists.
 *
 * The dangerous part is not the shortfall, it is that the shortfall READS LIKE
 * SUCCESS: a confident sentence naming two files, a summary naming one, and a
 * user who skims. So the paths the model NAMED are extracted and checked
 * against the disk. A promise with no file behind it becomes a line in the
 * summary rather than something discovered at `npm test` an hour later.
 *
 * Pure, and deliberately conservative — it only reports a path that (a) looks
 * like a file, (b) was not written this turn, and (c) does not exist. All three
 * have to be true, so a passing mention of an existing file is never flagged.
 */
/**
 * Extensions a generated project actually contains. Deliberately a LIST rather
 * than a pattern: a pattern is what let `assert.ok` and `created.body.id` be
 * reported as unwritten files.
 *
 * ⚠️ Missing an extension here costs a MISSED warning; including a common
 * property name (`.data`, `.body`, `.id`, `.length`) costs a FALSE one. This
 * check exists only to be worth reading, so it fails toward silence.
 */
const KNOWN_FILE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'json', 'jsonc', 'md', 'mdx', 'txt', 'yml', 'yaml', 'toml', 'ini', 'env',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'php', 'sh', 'bash', 'ps1',
  'sql', 'graphql', 'gql', 'proto', 'lock', 'xml', 'csv',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'wav', 'mp3', 'mp4',
]);

export function mentionedPaths(text) {
  if (typeof text !== 'string' || !text) return [];
  /**
   * A path-ish token with an extension. Backticks and quotes are excluded by the
   * character class rather than parsed — models fence filenames inconsistently.
   *
   * ⚠️ THE EXTENSION MUST START WITH A LETTER, and the test that added this rule
   * is the reason: `\.[A-Za-z0-9]{1,5}` matched the "2.3" in "bumped to version
   * 1.2.3", so a release note would have been reported as an unwritten file. A
   * warning that fires on ordinary prose is a warning people learn to ignore,
   * which costs more than the check is worth.
   */
  const matches = text.match(/[A-Za-z0-9._\-/\\]+\.[A-Za-z][A-Za-z0-9]{0,4}\b/g) ?? [];
  const seen = new Set();
  for (const raw of matches) {
    const norm = normalizeRelativePath(raw);
    if (!norm.ok) continue;
    /**
     * ⚠️ "Node.js" IS NOT A FILE, AND THE FIRST LIVE RUN OF THIS CHECK SAID IT
     * WAS. The reply read *"using Node.js's built-in test runner"* and the
     * summary warned that `Node.js` had not been written — a false alarm on
     * ordinary prose, which is how a useful warning becomes one people scroll
     * past.
     *
     * The rule: a bare token (no directory) whose stem is Capitalised is a
     * product name, not a filename — Node.js, Next.js, Vue.js, Three.js. An
     * ALL-CAPS stem is kept, because README.md and LICENSE.md are real. The
     * known false negative is a root-level `App.tsx`, which is a missed warning
     * rather than a wrong one, and that is the correct direction to fail for a
     * check whose only job is to be worth reading.
     */
    const stem = norm.path.slice(0, norm.path.indexOf('.'));
    const bareProseName = !norm.path.includes('/') && /^[A-Z][a-z]/.test(stem);
    if (bareProseName) continue;
    /**
     * ⚠️⚠️ A DOTTED IDENTIFIER IS NOT A FILE, AND THIS FIRED ON REAL OUTPUT.
     * Building a task API, the summary warned:
     *
     *   "The reply named 4 files it did not write:
     *      assert.ok · created.body.id · assert.equal"
     *
     * Those are JavaScript expressions the model quoted while explaining a test.
     * The extension rule cannot tell `.ok` from `.md` — both are letters.
     *
     * ⭐ THE DISCRIMINATOR IS THE EXTENSION ITSELF, not its shape. A filename
     * ends in something from a small, knowable set; an identifier ends in
     * whatever the author called a property. Guessing from shape is how this
     * check keeps crying wolf, and a warning people scroll past protects
     * nothing — which is the whole reason two guards already sit above this one.
     */
    const ext = norm.path.slice(norm.path.lastIndexOf('.') + 1).toLowerCase();
    if (!KNOWN_FILE_EXTENSIONS.has(ext)) continue;
    seen.add(norm.path);
  }
  return [...seen];
}

/** How much of a read_file or list_dir result to hand back. The model pays for
 *  every character of it, and a 200KB file would displace the conversation. */
const MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * ── ⚠️⚠️ RAISED 24,000 → 96,000, AND THE OLD NUMBER WAS COSTING REAL MONEY ──
 *
 * MEASURED, from the models the chain actually uses:
 *
 *   deepseek-v4-flash-0731   1,048,576 tokens
 *   qwen3.7-flash            1,000,000
 *   glm-4.6                    204,800
 *   deepseek-chat              163,840   ← the smallest in the fallback chain
 *
 * We were compacting at **24,000 against a 1,048,576-token window** — 2.3%
 * utilisation — and paying for it every round. The comment above this constant
 * used to say 24,000 "leaves ample room under every provider", which was true
 * and beside the point: the binding cost was never the window, it was the CACHE.
 *
 * ⭐⭐ THE ARITHMETIC THAT DECIDES IT. A cache hit is ~50x cheaper than a miss.
 * Compaction frees ~8% of the transcript and voids the cached prefix on ~87% of
 * it. Trading 8% fewer tokens for 87% of them going from 1x to 50x is roughly a
 * SIX-FOLD LOSS, every time it fires. Growing the prompt instead is nearly free,
 * because the grown part is a stable prefix and prefixes are what get cached.
 *
 * ⚠️ 96,000 IS DELIBERATELY CONSERVATIVE, not the biggest number that fits.
 * The estimator is chars/4, which UNDERCOUNTS code — real tokens can run
 * ~1.3-1.5x an English estimate. 96,000 estimated is therefore ~125-145k real,
 * which still fits the 163,840 floor with room for a 12,000-token reply and the
 * tool schemas. Sizing it to the 1M window would be correct for the primary
 * model and catastrophic the moment the chain fell back.
 */
const CONTEXT_BUDGET_TOKENS = 96_000;

/**
 * ── ⚠️⚠️ HYSTERESIS — THE HALF THAT ACTUALLY BROKE THE CACHE ───────────────
 *
 * The old code compacted DOWN TO THE BUDGET, so the very next round crossed it
 * again and compacted again. The evidence was already sitting in this file:
 * round 13 compacted, and so did round 14. Once it starts, it never stops —
 * so from that round on, EVERY round is a cache miss, forever.
 *
 * ⭐ THAT IS THE REAL DEFECT. "Compaction is expensive" was the wrong diagnosis;
 * "compaction never stops once it starts" is the right one. Firing at a high
 * water mark and compacting to a LOW one means it fires rarely and the prefix
 * that follows stays stable long enough to be cached again.
 */
const COMPACT_TARGET_TOKENS = 60_000;

/**
 * A tool result as the MODEL sees it.
 *
 * ⚠️ THIS IS THE ONLY THING THE NEXT ROUND KNOWS. If a refusal is rendered as
 * "error", the model retries the same thing and the round is wasted; if a
 * failing test is rendered without its stderr, the model guesses at the fix.
 * So a refusal carries its full sentence and a run carries its exit code first.
 *
 * Pure.
 */
export function toolResultText(record) {
  const { name, result } = record;
  if (!result || result.ok !== true) return `${name} failed: ${result?.error ?? 'unknown error'}`;
  switch (name) {
    case 'write_file':
      return result.dryRun
        ? `DRY RUN: ${result.path} was NOT written (${result.bytes} bytes withheld)`
        : `${result.created ? 'created' : 'replaced'} ${result.path} (${result.bytes} bytes)`;
    case 'delete_file':
      return result.dryRun
        ? `DRY RUN: ${result.path} was NOT deleted`
        : `deleted ${result.path} (${result.bytes} bytes)`;
    case 'read_file': {
      const clamped = clampOutput(result.content, MAX_TOOL_RESULT_CHARS);
      /**
       * ── ⭐ A TRUNCATION THAT NAMES THE WAY OUT ────────────────────────────
       *
       * MEASURED: a 25,200-character file reaches the model as 8,055 — head
       * 35%, tail 65% — and the middle is gone. `clampOutput` is already honest
       * about it and writes "… 17200 characters omitted …" into the text, so
       * this was never silent data loss.
       *
       * ⚠️ BUT HEAD+TAIL IS THE WRONG SHAPE FOR A FILE. It is exactly right for
       * a command's output, where you want the start and the error at the end.
       * For source, the middle is usually the part that was wanted — and a model
       * told only that characters are missing has no stated next move, so it
       * re-reads the same file and receives the same clamp.
       *
       * ⭐ `read_lines` and `read_around` already exist and are wired. This is
       * this repo's own rule applied to a truncation notice: an error string is
       * an INSTRUCTION. One sentence turns a dead end into a next action.
       *
       * ⚠️ ONLY WHEN IT ACTUALLY TRUNCATED. Advice attached to a complete file
       * is noise in every prompt that reads a small file — which is most of them.
       */
      const body = `${result.path} (${result.bytes} bytes):\n${clamped.text}`;
      if (!clamped.truncated) return body;
      return `${body}\n\n[the middle was omitted — this is the head and the tail. `
        + `Use read_lines with an offset, or read_around a symbol, to see any part of `
        + `${result.path} in full.]`;
    }
    case 'list_dir': {
      const body = result.entries
        .map((e) => `${e.name}${e.type === 'dir' ? '/' : ''}${e.skipped ? '  (not listed)' : ''}`)
        .join('\n');
      return `${result.path}:\n${clampOutput(body, MAX_TOOL_RESULT_CHARS).text}`;
    }
    case 'run_command':
      return formatRunForModel(result);
    /**
     * ⭐ `run_program` HAS ITS OWN FORMATTER AND NEEDS IT. `formatRunForModel`
     * leads with `result.command`, which a run_program result does not have —
     * it has `argv`, and the argv IS the fact the string runner could never
     * show: it is how the model confirms `"buy milk"` survived as ONE token
     * rather than two. Rendering it through the JSON default would bury that
     * behind escaping, and rendering it through run_command's formatter would
     * print `$ undefined`.
     */
    case 'run_program':
      return formatProgramRunForModel(result);

    /**
     * ── ⚠️⚠️ THE NEW READ TOOLS NEEDED FORMATTERS, AND WITHOUT THEM THEY WERE
     *        WIRED BUT CRIPPLED ─────────────────────────────────────────────
     *
     * The `default` below renders a result as `JSON.stringify` clamped to 2,000
     * characters. For a write that is fine — the interesting part is a path and
     * a byte count. For a READ it is close to useless twice over: every newline
     * in the file becomes a literal `\n`, every quote becomes `\"`, and then the
     * whole thing is cut at a quarter of the 8,000 characters `read_file` gets.
     * A model handed 2,000 characters of escaped JSON cannot copy an
     * `old_string` out of it, so `edit_file` — the tool the window exists to
     * feed — fails on the very next round.
     *
     * ⭐ Each module ships the formatter for its own results, and they are used
     * here rather than reimplemented. `formatSkillForModel` in particular is a
     * SECURITY control, not cosmetics: skills.mjs's rule is that a skill body is
     * user prose entering the conversation, and the only safe way to hand it
     * over is wrapped in a restatement that it grants no tool, no permission and
     * no exception. Rendering a skill through the JSON default would strip that
     * wrapper off and paste the prose in naked.
     */
    case 'read_lines':
    case 'read_around':
      return clampOutput(formatWindowForModel(result), MAX_TOOL_RESULT_CHARS).text;
    case 'find_definition':
    case 'find_references':
    case 'check_types':
    case 'list_symbols':
      return clampOutput(formatLspForModel(result), MAX_TOOL_RESULT_CHARS).text;
    case 'read_skill':
      return clampOutput(formatSkillForModel(result), MAX_TOOL_RESULT_CHARS).text;

    /**
     * ⭐ THE LEDGER AND THE VERDICT CARRY ONE SENTENCE THAT IS THE WHOLE POINT.
     * `plan_*` returns a `banner` ("2/5 done · 3 remaining: … · round 4 of 6")
     * and `check_acceptance` returns a `verdict` object whose rendered form
     * names the command the USER asked about. Both would survive the JSON
     * default — they are short — but they would arrive escaped and buried in
     * field names, and the model would have to parse rather than read.
     */
    case 'plan_start':
    case 'plan_step':
    case 'plan_status':
      return result.banner ? String(result.banner) : clampOutput(JSON.stringify(result), 2_000).text;
    case 'check_acceptance':
      return result.verdict ? formatVerdict(result.verdict) : clampOutput(JSON.stringify(result), 2_000).text;
    /**
     * ── ⭐⭐ THE LOAD-BEARING ONE. MEASURED, ON A REAL RENDER ────────────────
     *
     *   through the JSON default: 812 chars → 205 tokens of escaped JSON,
     *                             with `findings` in the document TWICE
     *   this case:                 95 chars →  26 tokens
     *   the alternative nobody should take (hand the model the PNG): 1,536 tokens
     *
     * Without this line `designPass` computes the verdict and the model never
     * reads it — 7.9x worse than it needs to be, and the whole point of the
     * design loop lost to a missing switch case.
     *
     * ⚠️ THE FALLBACK IS NOT DEAD CODE. `see_page` is also reachable through a
     * library caller that injects its own implementation, and a result without
     * a verdict must still render as something the model can act on rather than
     * as an empty string it reads as silence.
     */
    case 'see_page':
      return result.verdict ? String(result.verdict) : clampOutput(JSON.stringify(result), 2_000).text;

    /**
     * ⚠️ `fetch_url` IS THE ONE NEW READ WITH NO FORMATTER OF ITS OWN, so the
     * rendering lives here. Through the JSON default a fetched page arrived
     * escaped and cut to 2,000 characters — a quarter of `read_file`'s budget
     * for the tool whose entire purpose is bringing in a document that is not on
     * disk, and the `nextOffset` that makes the next window free was buried in a
     * field the model had to notice among six others.
     *
     * ⭐ THE CONTINUATION IS STATED AS AN INSTRUCTION, not left as data. That is
     * the shape read-window.mjs proved works: a model told "continue with offset
     * 8000" continues, and a model handed `"nextOffset":8000` inside JSON
     * usually reports that the page was truncated and stops.
     */
    case 'fetch_url': {
      const head = `${result.finalUrl ?? result.url} — HTTP ${result.status}, ${result.totalChars} characters${result.fromCache ? ' (from this run\'s cache, free)' : ''}`;
      const more = result.nextOffset !== null && result.nextOffset !== undefined
        ? `\n\n(continue with fetch_url offset ${result.nextOffset} — the page is already downloaded, so it costs nothing)`
        : '';
      return `${clampOutput(`${head}\n\n${result.text ?? ''}`, MAX_TOOL_RESULT_CHARS).text}${more}`;
    }

    /**
     * ── ⭐⭐ SEARCH RESULTS WERE ARRIVING 19% COMPLETE, AS BROKEN JSON ────────
     *
     * Measured 2026-08-13 in this repository: `search_text` for
     * `export function` produced **10,281 characters of result and delivered
     * 2,000** — the model saw a fifth of its own search, cut in the middle of a
     * JSON structure so it did not even parse. `search_text` is the tool
     * `tools.mjs:503` calls "what turns writes-files into works-in-your-
     * codebase", and it had been running at a fifth strength on every install.
     *
     * ⭐ Formatted, not raw JSON, and that is most of the win. `{"path":…,
     * "line":…,"text":…}` per match spends roughly half its characters on
     * punctuation and key names the model already knows. `path:line: text` says
     * the same thing in a form a model reads natively, so the same budget
     * carries far more matches — and when it does run out it truncates between
     * two lines rather than mid-token.
     */
    case 'search_text': {
      const matches = Array.isArray(result.matches) ? result.matches : [];
      if (!result.ok) return `search_text: ${result.error}`;
      if (matches.length === 0) return `no matches for ${result.pattern} (scanned ${result.scanned} files)`;
      const body = matches.map((m) => `${m.path}:${m.line}: ${String(m.text ?? '').trim()}`).join('\n');
      const head = `${result.total}${result.countCapped ? '+' : ''} match${result.total === 1 ? '' : 'es'} for ${result.pattern} in ${result.scanned} files`;
      /**
       * ⚠️ THE "THERE IS MORE" HINT IS OUTSIDE THE CLAMP, deliberately. It is
       * the one line that must survive, because it is what stops the model
       * concluding it has seen everything — the same reasoning `fetch_url`
       * above already applies to its `nextOffset`.
       */
      const more = result.nextOffset !== null && result.nextOffset !== undefined
        ? `\n\n(more matches — call search_text again with offset ${result.nextOffset})`
        : '';
      return `${clampOutput(`${head}\n${body}`, MAX_TOOL_RESULT_CHARS).text}${more}`;
    }

    /**
     * ⭐ `formatStatusForModel` (lib/git.mjs:603) was written, exported, tested —
     * and had ZERO callers, so `git_status` reached the model as raw JSON. The
     * formatter is 298 characters where the JSON is 884, and the JSON spends
     * the difference on `"staged":false,"untracked":true` per file.
     */
    case 'git_status':
      return clampOutput(formatStatusForModel(result), MAX_TOOL_RESULT_CHARS).text;

    /**
     * ── ⚠️⚠️ THE DEFAULT WAS 2,000 WHILE EVERY FORMATTED TOOL GOT 8,000 ──────
     *
     * Not a considered ceiling — an inconsistency. **29 of the 48 tools in
     * `TOOL_SCHEMAS` fall through to here**, plus every MCP result (their names
     * are `mcp__<server>__<tool>`, so no case can match). `git_diff` allows
     * 12,000 characters at `git.mjs:82` and delivered 2,000. `read_document`
     * rendered one page of four and the surviving tail still said
     * `"nextPage":null`, telling the model there was nothing more to fetch.
     *
     * ⭐ Raised to the same `MAX_TOOL_RESULT_CHARS` the formatted branches use,
     * because there was never a reason for the unformatted ones to be poorer —
     * they are unformatted precisely because nobody has got to them yet, which
     * is an argument for MORE room, not less.
     *
     * ⚠️ The `/* c8 ignore *​/` that used to sit here hid the single hottest
     * rendering path in the binary from coverage. A line that renders 29 tools
     * is not a line to exclude from the report that tells you what is untested.
     */
    default:
      return clampOutput(JSON.stringify(result), MAX_TOOL_RESULT_CHARS).text;
  }
}

/** The last few non-empty lines of a stream. */
export function tailLines(text, count = 6) {
  if (typeof text !== 'string') return [];
  return text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '').slice(-count);
}

/**
 * ⚠️ THE TAIL OF A TEST RUN IS THE LEAST INFORMATIVE PART OF IT, AND THE FIRST
 * LIVE RUN OF THIS LOOP PROVED IT.
 *
 * The terminal printed, as its entire explanation of a failed round:
 *
 *     ✖ exit 1 · 0.8s
 *       # pass 0
 *       # fail 1
 *       # cancelled 0
 *       # skipped 0
 *       # todo 0
 *       # duration_ms 150.0874
 *
 * Six lines, all true, none of them the reason. `node --test` (and vitest, and
 * tsc) print the ASSERTION in the middle and the arithmetic at the end, so
 * `slice(-6)` reliably shows the one part of the output nobody needs. The
 * person watching a run-and-fix loop is watching it to see WHAT BROKE.
 *
 * ⚠️ IT FALLS BACK TO THE TAIL RATHER THAN TO NOTHING. A crash with no
 * recognisable marker still has to show something, and the tail is a poor
 * excerpt but never an empty one. Pure, and the markers are asserted in the
 * suite so a silent regression to counters-only cannot happen twice.
 */
const FAILURE_MARKER = /(^|\s)(not ok\b|AssertionError|Assertion failed|Error:|error TS\d+|Expected|expected\b|actual\b|FAIL\b|failed\b|✕|✗|×)/i;
/** Bookkeeping that is never the answer, even when it matches a marker. */
const COUNTER_LINE = /^#?\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms|Tests|Test Files|Duration|Start at)\b/;

export function failureExcerpt(text, count = 6) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  const first = lines.findIndex((l) => FAILURE_MARKER.test(l) && !COUNTER_LINE.test(l));
  if (first === -1) return tailLines(text, count);
  return lines.slice(first, first + count);
}

/**
 * ── ⚠️ THE LOOP MUST BE WATCHED, NOT SUMMARISED ────────────────────────────
 * A bounded agent loop that prints nothing until it finishes is indistinguishable
 * from a hang, and when it does print, the user has no way to tell a fix that
 * worked from a fix that changed nothing. So the session emits events and this
 * turns them into lines — pure, so what the terminal shows is testable without
 * spending a completion.
 */
/**
 * ⚠️ ONE PAINTER, DECIDED AT MODULE LOAD. Deciding per-call would re-read the
 * environment thousands of times, and worse, could disagree with itself midway
 * through a run if something touched `process.env`.
 */
const paint = createPainter();

export function renderEvent(event) {
  switch (event.type) {
    case 'round-start':
      return ['', paint.dim(`── round ${event.round}/${event.of} ─────────────────────────────`)];
    case 'note': {
      /**
       * ⚠️ SUPPRESSED WHEN THE STREAM ALREADY SHOWED IT. With streaming on, the
       * model's prose arrives live AND again as the round's note AND a third
       * time in the summary — measured on the first live run: the same sentence
       * three times, which reads like a bug in the tool rather than a feature.
       */
      if (event.streamed) return [];
      const text = (event.text ?? '').trim();
      if (!text) return [];
      // Two lines of the model's own reasoning is orientation; the whole essay
      // is noise the summary will repeat anyway.
      return text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 2).map((l) => `  ${l.trim()}`);
    }
    case 'tool':
      return renderToolRecord(event.record);
    case 'stream':
      /**
       * ⚠️ RETURNED RAW, WITHOUT A TRAILING NEWLINE OF ITS OWN. The printer
       * already decides where lines break; adding one here would double-space
       * every streamed line and make live output look broken next to the
       * non-streamed summary.
       */
      return [event.text.replace(/\n$/, '')];
    /**
     * ⚠️ PRINTED BEFORE THE PROCESS STARTS, AND IT NAMES THE BINARY. If the
     * spawn is what harms you, a line emitted after it returns is a line you
     * never see. This is the only place the command a repository chose is shown
     * to the person it will run as.
     */
    case 'mcp-start':
      return [paint.dim(`  · starting MCP server ${event.name}: ${event.command} ${(event.args ?? []).join(' ')}`.trimEnd())];
    case 'mcp':
      /**
       * ⚠️ THE CONSENT REFUSAL IS NOT TRUNCATED, AND THE 90-CHAR CAP IS WHY THIS
       * BRANCH EXISTS. Measured on the real reproduction: the refusal rendered as
       * "…and there is no terminal he" — cutting off the only sentence that says
       * how to proceed. A refusal that does not fit its own instructions is the
       * error-string-as-instruction failure this package has paid for before.
       * A server's connection error stays capped: that one is a stack trace.
       */
      if (event.name === 'consent') {
        return String(event.error).split('\n').map((l, i) => (i === 0 ? paint.red(`  ✖ ${l}`) : `    ${l}`));
      }
      return [event.ok
        ? `  · ${event.name} connected (${event.count} tool${event.count === 1 ? '' : 's'})`
        : paint.red(`  ✖ ${event.name} unavailable: ${String(event.error).slice(0, 90)}`)];
    case 'memory':
      // ⭐ SAID OUT LOUD. The agent is being steered by a file the user may have
      // forgotten they wrote — silently obeying it is how "why did it do that?"
      // becomes unanswerable.
      return [paint.dim(`  · reading ${event.file}${event.truncated ? ' (truncated)' : ''}`)];
    case 'stopped':
      if (event.reason === 'verified') return ['', '  ✔ a command passed — stopping here rather than spending another round.'];
      // ⭐ Printed rather than silent, because the user is watching a loop that
      // just succeeded and is about to spend one more round anyway. Unexplained,
      // that reads as the stop condition being broken.
      if (event.reason === 'verified-continuing') return ['', '  ✔ a command passed — one more round to finish anything else that was asked.'];
      return [];
    case 'final-check':
      return ['', `── final check ──────────────────────────────`,
        `  files changed after the last run, so \`${event.command}\` is out of date. Re-running it (free — no model call).`];
    /**
     * ⭐ THE PLAN IS SHOWN TO THE HUMAN TOO. The banner exists so the MODEL can
     * see the wall coming; printing it costs one dim line and answers the
     * question the person watching a loop actually has — "how much is left".
     * It only ever appears when a plan was recorded, so a run without one looks
     * exactly as it does today.
     */
    case 'plan':
      return [paint.dim(`  · ${event.text}`)];
    /**
     * ── ⚠️⭐ SAID OUT LOUD, ALWAYS ─────────────────────────────────────────
     * The loop just deleted part of what it knew. Unannounced, the next round
     * looks like the model forgetting — indistinguishable from amnesia, and
     * unfalsifiable from the outside. `report.lines` is a ready-to-print human
     * summary and already states that every token figure is an estimate.
     *
     * ⚠️ IT IS DIM, NOT LOUD. This is bookkeeping the user did not ask for and
     * cannot act on; it must be legible and then get out of the way.
     */
    case 'compact': {
      const lines = Array.isArray(event.report?.lines) ? event.report.lines : [];
      if (lines.length > 0) return lines.map((l) => paint.dim(`  · ${l}`));
      const r = event.report ?? {};
      return [paint.dim(`  · compacted the history: ${r.beforeTokens ?? '?'} → ${r.afterTokens ?? '?'} estimated tokens`)];
    }
    /**
     * ⚠️ ANNOUNCED, LIKE THE STALE RE-RUN ABOVE, because it spawns a process the
     * user did not watch the model ask for. A command that runs unannounced is
     * indistinguishable from a bug.
     */
    case 'acceptance-check':
      return ['', `── acceptance ───────────────────────────────`,
        `  \`${event.command}\` was declared as the criterion and nothing in this run satisfied it.`,
        '  Running it once (free — no model call).'];
    /**
     * ── ⚠️ STOPPING ON MONEY IS ANNOUNCED, ALWAYS ────────────────────────────
     * A loop that ends early is indistinguishable from a loop that crashed
     * unless it says which. The message from `budget.mjs` already names the
     * figures — it is printed verbatim rather than re-worded, so the terminal
     * and `--json` can never disagree about why the run ended.
     */
    case 'budget-stop':
      return ['', paint.gold(`  ⛔ ${event.message}`)];
    /**
     * ⭐ THE LOOP WATCHER, SAID OUT LOUD. The user is watching an agent repeat
     * itself; a silent intervention would leave them unable to tell a nudge
     * from the model happening to change its mind.
     */
    case 'stuck':
      return event.nudged
        ? ['', paint.dim(`  ↻ going in circles (${event.pattern}) — one hint sent, budget untouched.`)]
        : ['', paint.gold(`  ⛔ still going in circles (${event.pattern}) after the hint — stopping rather than spending more.`)];
    /**
     * ⭐ AND SO IS REFUSING TO STOP. `--until-done` overriding the model's own
     * "I am finished" is the single most surprising thing this flag does, so it
     * names the criterion that is keeping the session open.
     */
    case 'until-done': {
      const named = (event.commands ?? []).map((c) => `\`${c}\``).join(', ');
      return ['', `  ↺ not done yet — ${named || 'the declared criterion'} has not passed. `
        + `Carrying on (${event.attempt}/${event.of}).`];
    }
    default:
      /* c8 ignore next */
      return [];
  }
}

function renderToolRecord(record) {
  const { name, args, result } = record;
  if (!result || result.ok !== true) {
    const target = args?.path ?? args?.command;
    return [`  ✖ ${name}${target ? ` ${JSON.stringify(target)}` : ''}: ${result?.error ?? 'unknown error'}`];
  }
  switch (name) {
    case 'write_file':
      return [paint.gold(`  ✎ ${result.dryRun ? 'would write' : (result.created ? 'created ' : 'replaced')} ${result.path}`) + paint.dim(`  (${result.bytes} bytes)`)];
    case 'delete_file':
      return [paint.gold(`  ✂ ${result.dryRun ? 'would delete' : 'deleted '} ${result.path}`) + paint.dim(`  (${result.bytes} bytes)`)];
    case 'read_file':
      return [`  · read ${result.path}  (${result.bytes} bytes)`];
    case 'list_dir':
      return [`  · listed ${result.path}  (${result.entries.length} entries)`];
    case 'run_command': {
      const lines = [`  $ ${result.command}`];
      if (result.timedOut) {
        lines.push(`    ✖ TIMED OUT after ${Math.round(result.durationMs / 1000)}s — killed`);
      } else {
        // ⭐ Colour REINFORCES the glyph; it never carries the meaning alone.
        // ✔ and ✖ are already distinct for anyone who cannot tell red from green.
        const tone = result.passed ? paint.green : paint.red;
        lines.push(tone(`    ${result.passed ? '✔' : '✖'} exit ${result.exitCode}`) + paint.dim(` · ${(result.durationMs / 1000).toFixed(1)}s`));
      }
      // Only on failure: a passing run's output is noise, a failing run's output
      // is the entire reason the user is watching.
      if (!result.passed) {
        // ⚠️ Both streams, because a test runner puts the failure on stdout and
        // a crash puts it on stderr, and picking one loses half the failures.
        const combined = [result.stderr, result.stdout].filter((s) => s.trim()).join('\n');
        for (const line of failureExcerpt(combined)) lines.push(`      ${line}`);
      }
      return lines;
    }
    /* c8 ignore next 2 */
    default:
      return [`  · ${name}`];
  }
}

export const DEFAULT_MAX_ROUNDS = 3;

/**
 * ── ⚠️ THE OUTCOME IS DECLARED, NOT INFERRED ───────────────────────────────
 * Same reason as the contracts note in `workspace.mjs`, and it bites harder
 * here: left to inference, `ok` widens to `boolean` across the success and
 * failure returns, the discriminated union collapses, and every caller that
 * writes `outcome.ok && outcome.verification` becomes a type error at the CALL
 * SITE. The console's `tsc --noEmit` type-checks this package through the test
 * file's import, so "it is only JSDoc" is not true — it is the contract.
 *
 * @typedef {{ id: string | null, name: string, args: any, result: any, mutated: boolean }} ToolRecord
 * @typedef {{ ran: boolean, passed: boolean | null, command: string | null, exitCode: number | null, timedOut: boolean, attempts: number }} Verification
 * @typedef {{ promptTokens: number | null, cachedTokens: number | null }} CacheReading
 * @typedef {{ promptTokens: number, cachedTokens: number, uncachedTokens: number, hitRate: number | null, roundsReported: number, roundsUnknown: number }} CacheTotals
 * @typedef {{ round: number, note?: string | null, executed: ToolRecord[], usage: any, cache?: CacheReading, finishReason?: string | null, error?: string }} RoundRecord
 * @typedef {{ ok: false, stage: string, error: string }} SessionFailed
 * @typedef {{ source: 'declared' | 'derived', gating: boolean, criteria: any[], verdict: any }} Acceptance
 * @typedef {{ ok: true, stage: 'done', model: string, note: string | null, noteAlreadyShown: boolean, finishReason: string | null, usage: { cost?: number, total_tokens?: number, cache?: CacheTotals | null } | null, compactions: number, executed: ToolRecord[], rounds: RoundRecord[], roundsUsed: number, maxRounds: number, allowRun: boolean, stoppedBecause: string, verification: Verification, acceptance: Acceptance | null, promisedButMissing: string[] }} SessionDone
 * @typedef {SessionDone | SessionFailed} SessionOutcome
 */

/**
 * ── ⚠️⭐ THE PROCESS-LIFETIME MCP REGISTRY, AND WHY IT IS NOT PER SESSION ────
 *
 * The old code registered `process.once('exit', cleanup)` INSIDE `runSession`.
 * Two separate failures came out of that one line, and both were measured:
 *
 *   (a) **A listener per turn.** `bin/acuvo.mjs` calls `runSession` once per
 *       interactive turn, so fourteen turns left fourteen listeners and turn
 *       eleven printed Node's MaxListenersExceededWarning at the user — a
 *       memory-leak warning about acuvo, mid-conversation, that reads like a
 *       bug in THEIR project. A registry plus a one-time hook fixes that by
 *       construction; the alternative (remember to remove the listener on every
 *       return path) is the same bookkeeping that produced the bug.
 *
 *   (b) **'exit' does not fire on a signal.** Measured for SIGINT, SIGTERM and
 *       SIGKILL: the handler never ran. So the one line whose comment promised
 *       the CLI "cannot leave orphaned processes behind" was inert on the exact
 *       path it was written for. Two true orphans from acuvo-code runs were
 *       found on this machine and killed.
 *
 * ⚠️ A SIGINT LISTENER SUPPRESSES NODE'S DEFAULT TERMINATE-ON-CTRL-C, and
 * `chat.mjs` drives an interactive readline. So the handler MUST exit by itself
 * — otherwise Ctrl-C stops working entirely, which is a worse bug than the
 * orphans it was added to prevent.
 *
 * ⚠️ AND IT EXITS 128+n, NOT 1. `bin/acuvo.mjs` spends exit 1 on "the code it
 * wrote still does not pass"; an interrupt is a different answer to a different
 * question, and a script that cannot tell them apart retries the wrong one.
 * 128+n is the shell convention and collides with none of the documented
 * 0/1/2/64.
 *
 * ⚠️ WHAT THIS DOES NOT REACH: `run_command`'s spawned process tree.
 * `command.mjs` keeps no registry of live children, and its POSIX
 * `detached: true` (added so a timeout can kill the whole group) puts the
 * command in its own process group — so a terminal Ctrl-C no longer even
 * reaches it, and an interrupt during `npm test` orphans whatever that suite
 * started. Closing that needs a live-child registry in `command.mjs`. The
 * spawn-side half of this class is still open; this file only closes the MCP
 * half, and saying otherwise would be the dishonest version of a fix.
 */
const liveMcpConns = new Set();

function closeAllMcp() {
  for (const c of [...liveMcpConns]) {
    try { closeConnections([c]); } catch { /* exiting anyway */ }
    liveMcpConns.delete(c);
  }
}

let hooksInstalled = false;

function installLifecycleHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once('exit', closeAllMcp);
  // 128 + the signal number, so the caller can tell an interrupt from a
  // verdict. SIGBREAK is 21 and Windows-only — hence the try/catch, because
  // registering it elsewhere is what would throw.
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGBREAK', 149]]) {
    try {
      process.on(sig, () => { closeAllMcp(); process.exit(code); });
    } catch { /* signal not supported on this platform */ }
  }
}

/**
 * ── ⭐ THE PLAN BANNER — ONE LINE, ONCE A ROUND ─────────────────────────────
 *
 * `plan-ledger.mjs` did the measuring: every round's payload was byte-identical,
 * so the model could not tell round 8 of 8 from round 1 and spent its last round
 * on the most interesting remaining thing rather than the last unfinished
 * deliverable. This hands it the countdown.
 *
 * ⚠️ IT IS PROMPT TEXT AND NOTHING ELSE. It does not change when the loop stops,
 * it does not mark anything done, and it costs no completion. If it ever starts
 * deciding something, the honesty argument in plan-ledger's header (`done` is
 * ASSERTED, never inferred) is the one being broken.
 *
 * ⚠️ TWO CONDITIONS KEEP IT FAIL-SAFE, and both are about not changing a run
 * that never asked for this:
 *
 *   · NO PLAN FILE ⇒ NO BANNER. A run whose workspace has no `.acuvo/plan.json`
 *     gets the byte-identical prompt it gets today. `formatBanner(null)` would
 *     happily print "plan: none recorded · round 2 of 3", and that would be a
 *     silent prompt change for every user of the CLI to buy a countdown for the
 *     90% of tasks that are one file and one test.
 *   · A DRY RUN READS NOTHING. `loadPlan` QUARANTINES a corrupt plan by renaming
 *     it — a disk write. `--dry-run` promises "nothing written", and this file
 *     already documents (see the MCP gate) what happens when a flag that
 *     promises to touch nothing touches something: it is worse than no flag,
 *     because it is the advice a careful person follows.
 */
export function planBannerFor(executor, opts = {}) {
  if (!executor || executor.dryRun) return null;
  let loaded;
  try {
    loaded = loadPlan(executor.root, { planFile: planFileFor(executor.holder) });
  } catch {
    // A plan is scratch. Nothing about it may be able to end a run.
    return null;
  }
  if (!loaded?.ok || !loaded.plan) return null;
  return formatBanner(loaded.plan, opts);
}

/**
 * ── ⚠️⚠️ THE VERDICT MUST BE ABOUT THE COMMAND THE USER NAMED ───────────────
 *
 * `verification` (below) answers "did a command this process ran exit 0". That
 * is true and it is not the question. Four probes, 2026-08-10, every one exit 0
 * with a green banner: the thing that passed was `node --test test/api.test.js`
 * when the user said `npm test`, or an `evaluate` snippet written to look at
 * stdout. A criterion the subject picks after the fact is a summary.
 *
 * So the criterion is fixed from the USER's words, or from an explicit
 * declaration, and only that exact command exiting 0 satisfies it.
 *
 * ── ⭐ TWO SOURCES, AND ONLY ONE OF THEM IS ALLOWED TO COST ANYTHING ─────────
 *
 *   · `declared` — `.acuvo/acceptance.json`, written by `declare_acceptance` or
 *     inherited from an earlier session. An intentional act, so it GATES: it can
 *     make the process exit non-zero, and an unmet-because-never-run criterion
 *     is RUN once, free, exactly like the stale re-run above.
 *   · `derived` — read out of the task text by `deriveAcceptance`. A heuristic
 *     over prose, so it REPORTS and never gates and never spawns anything.
 *
 * ⚠️ THAT SPLIT IS DELIBERATE AND IT IS THE CONSERVATIVE ONE. This repo has been
 * bitten four times by a check that fails correct work, and a derived criterion
 * can be wrong in the one way that matters: the user writes "npm test must pass"
 * and the model correctly runs `npm run test`. Failing that run would teach
 * people to ignore the verdict, and a verdict nobody reads protects nothing.
 * A declared criterion cannot be wrong in that way — someone typed it.
 *
 * ⚠️⚠️ AND NOTHING HERE MAY EVER TURN A NOT-VERIFIED INTO A VERIFIED. It has no
 * way to: it never touches `verification`, and `sessionFailed` only ever ORs an
 * extra failure in. The only direction available to this function is stricter.
 *
 * @returns {Promise<{ source: 'declared' | 'derived', gating: boolean, criteria: any[], verdict: any } | null>}
 */
export async function resolveAcceptance({
  task, executor, executed = [], allowRun = true, commandTimeoutMs, onEvent = () => {},
  /**
   * ⚠️⚠️ THIS PARAMETER EXISTS BECAUSE A BULK EDIT PUT `shell` INTO THIS
   * FUNCTION'S DISPATCHER CALL WITHOUT PUTTING IT IN THE SIGNATURE. The
   * reference threw, the criterion never ran, and the failure surfaced as
   * `not-run` instead of `unmet` — a criterion silently skipped rather than an
   * error anyone would read as one.
   *
   * ⭐ THE LESSON IS ABOUT THE EDIT, NOT THE FLAG: a find-and-replace across a
   * 2,500-line file matched an identical call site in a DIFFERENT function.
   * Textual identity is not scope identity.
   */
  shell = false,
  /**
   * ⭐ The asker, so an unapproved acceptance file can be approved by the person
   * standing at the terminal. `null` (a pipe, CI, a task runner) means the
   * consent check fails closed and the criteria are simply not loaded.
   */
  acceptanceAsk = null,
} = {}) {
  let source = null;
  let criteria = [];

  const loaded = (() => {
    try { return loadAcceptance(executor?.root); } catch { return { ok: false }; }
  })();
  /**
   * ⚠️ A CORRUPT DECLARATION IS NOT "NOTHING WAS DECLARED". `acceptance.mjs`
   * refuses to read it as absent, and it is right: silently downgrading to no
   * criterion is the behaviour the module exists to remove. It is reported as
   * NOT A VERDICT and it does NOT gate — a scratch file somebody's editor
   * mangled must not be able to fail a run whose code is fine.
   */
  if (loaded && loaded.ok === false) {
    return {
      source: 'declared',
      gating: false,
      criteria: [],
      verdict: {
        verdict: 'unrunnable',
        reason: loaded.error,
        criteria: [{ command: null, phrase: 'the criteria you declared earlier', kind: 'phrase', runnable: false, reason: loaded.error, ran: false, exitCode: null, satisfied: false }],
        unmet: [],
        incidental: [],
        declaredCount: 0,
        satisfiedCount: 0,
      },
    };
  }
  if (loaded?.ok && loaded.found) {
    /**
     * ── ⚠️⚠️ CONSENT, BECAUSE THIS FILE COMES OUT OF THE WORKSPACE ───────────
     *
     * PROVEN on 2026-08-13: a `.acuvo/acceptance.json` carried by a cloned
     * repository ran `node payload.js`, wrote a file, and the CLI printed
     * `✔ MET — exited 0`. No prompt, no record, and the attack rendered as a
     * passing check. That is the same hole `mcp-consent.mjs` exists to close,
     * one file over; this one was missed.
     *
     * ⭐ Criteria this session AUTHORED are trusted at the moment
     * `declare_acceptance` writes them, so the ordinary path never asks. Only a
     * file that arrived from somewhere else reaches the question.
     *
     * ⚠️ UNTRUSTED IS TREATED AS ABSENT, NOT FATAL. The run continues exactly
     * as it would in a workspace with no acceptance file. Refusing outright
     * would let a stray file deny service and would teach people to disable the
     * guard — the failure mode that ends with the safety feature deleted.
     */
    const consent = await checkAcceptanceConsent(loaded.criteria, {
      root: executor?.root ?? '',
      ask: acceptanceAsk,
      isInteractive: typeof acceptanceAsk === 'function',
    });
    if (!consent.allowed) {
      onEvent?.({ type: 'acceptance', name: 'consent', ok: false, error: consent.reason });
      source = null;
      criteria = [];
    } else {
      source = 'declared';
      criteria = loaded.criteria;
      if (consent.remember) recordAcceptanceTrust(loaded.criteria, { root: executor?.root ?? '' });
    }
  }
  if (!source && !(loaded?.ok && loaded.found)) {
    const derived = deriveAcceptance(task, { source: 'user' });
    if (derived.length > 0) {
      source = 'derived';
      criteria = derived;
    }
  }
  if (!source) return null;

  let verdict = evaluateAcceptance({ declared: criteria, executed });

  const worthRunning = source === 'declared'
    && allowRun
    && executor?.dryRun !== true
    && (verdict.verdict === 'unmet' || verdict.verdict === 'not-run');
  if (worthRunning) {
    /**
     * ⚠️ ONLY THE ONES STILL UNSATISFIED. `checkAcceptance` runs every runnable
     * criterion it is handed, so passing the whole list would re-run a suite the
     * session already watched go green — minutes of somebody's laptop to learn
     * something we already knew.
     */
    const outstandingCommands = new Set(verdict.unmet.map((u) => u.command));
    const toRun = criteria.filter((c) => outstandingCommands.has(typeof c === 'string' ? c : c?.command));
    if (toRun.length > 0) {
      for (const c of toRun) onEvent({ type: 'acceptance-check', command: typeof c === 'string' ? c : c.command });
      /**
       * ⚠️ THE RUNNER IS INJECTED, AND `acceptance.mjs` IMPORTS NO SPAWNER ON
       * PURPOSE — so every process this package starts goes through the one
       * audited gate in `command.mjs` rather than a second one nobody reviewed.
       */
      const runner = async (command) => {
        const record = await executeToolCall(
          { id: 'acceptance', function: { name: 'run_command', arguments: JSON.stringify({ command }) } },
          executor,
          { commandTimeoutMs, shell },
        );
        onEvent({ type: 'tool', record });
        return record.result;
      };
      const checked = await checkAcceptance({ root: executor.root, runner, declared: toRun });
      if (checked?.ok) {
        /**
         * ⭐ RE-EVALUATED THROUGH THE SAME FUNCTION, not merged by hand. The
         * checker's rows become synthetic `run_command` records appended AFTER
         * the session's own, so "a later red overrides an earlier green" keeps
         * meaning what it means everywhere else, and there is exactly one
         * decider rather than two that can drift.
         */
        const synthetic = checked.criteria
          .filter((row) => row.ran === true)
          .map((row) => ({
            name: 'run_command',
            args: { command: row.command },
            result: { ok: true, command: row.command, exitCode: row.exitCode },
          }));
        verdict = evaluateAcceptance({ declared: criteria, executed: [...executed, ...synthetic] });
      }
    }
  }

  return { source, gating: source === 'declared', criteria, verdict };
}

/**
 * ── THE RUN-AND-FIX LOOP ───────────────────────────────────────────────────
 * write → run → read the exit code → fix → run again, bounded.
 *
 * ⚠️ WHY IT IS BOUNDED AT ALL, given every hosted agent runs unbounded: this
 * CLI's original design note argued that a `while (toolCalls.length)` loop
 * against a paid endpoint is a cost with no ceiling, and that argument did not
 * stop being true when the loop became necessary. What changed is that ONE
 * round cannot verify anything, and an agent that cannot verify is guessing. So
 * the ceiling moves from 1 to a small number the user sets, and every round is
 * printed as it happens and priced at the end.
 *
 * ⚠️ AND IT STOPS EARLY ON SUCCESS, which is not an optimisation — it is the
 * rule that keeps the model from "improving" working code with rounds it has
 * left over. A round that begins after a green test has no fact to react to.
 *
 * The three ways out, all reported by name: `verified` (a command exited 0),
 * `no-tool-calls` (the model had nothing more to do), `round-cap` (it ran out).
 *
 * @param {{ task: string, executor: any, config: { apiKey: string, model: string }, maxTokens?: number, timeoutMs?: number, maxRounds?: number, commandTimeoutMs?: number, allowRun?: boolean, toolNames?: string[] | null, onEvent?: (event: any) => void, callModelImpl?: (opts: any) => Promise<any> }} options
 * @returns {Promise<SessionOutcome>}
 */
export async function runSession({
  task, executor, config,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRounds = DEFAULT_MAX_ROUNDS,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  allowRun = true,
  /**
   * ⚠️ OPT-IN, DEFAULT FALSE. With it the agent may run any program on the
   * machine; without it, only the allowlist. It is threaded to BOTH the tool
   * schemas and the dispatcher on purpose — telling the model it has a shell
   * while the dispatcher refuses one, or the reverse, is a capability hole
   * that reports itself as a model failure.
   */
  shell = false,
  // Which tools the MODEL is offered. Not which tools exist — see
  // `toolNamesForRounds` in tools.mjs for why the offer tracks the budget.
  toolNames = null,
  onEvent = () => {},
  /**
   * ⚠️ HOW DEEP THIS SESSION ALREADY IS. 0 is a person's own run; 1 is a helper
   * spawned by `delegate`. It exists so the DISPATCHER can refuse a nested
   * delegation independently of the offer — a model can call a tool it was
   * never shown, and one of our two locks is a list.
   */
  depth = 0,
  callModelImpl = callChain,
  /**
   * ── ⭐ CONVERSATION SO FAR, FOR AN INTERACTIVE SESSION ─────────────────────
   * Absent = a fresh task, exactly as before. Present = continue, and the
   * workspace context is NOT re-gathered: the earlier messages already carry it,
   * and re-sending a second copy would both waste tokens and — the part that
   * matters — CHANGE THE PREFIX, which throws away the prompt cache.
   *
   * ⚠️ THAT IS THE WHOLE ECONOMIC POINT OF MULTI-TURN HERE. Measured 2026-08-09:
   * an identical prefix cached at 97.2% and the call cost fell 4.3x. A session
   * that appends is nearly free on every turn after the first; a session that
   * rebuilds its prompt pays full price every time and looks identical from the
   * outside.
   */
  priorMessages = null,
  /**
   * ── ⭐⭐ THE SPEND CEILING. `null` = the behaviour this function had before ─
   *
   * A number here makes MONEY the stop condition and leaves `maxRounds` as a
   * backstop. Nothing about a run that omits it changes: `createBudget({
   * limitUsd: null })` is unlimited, `canContinue()` always says yes, and the
   * ledger it keeps is never read.
   */
  budgetUsd = null,
  /** ?? True when the ceiling came from the default rather than the user � the
   *  stop message must admit that and name the flag that raises it. */
  budgetIsDefault = false,
  /**
   * ⭐ THE FLEET CEILING, AS A FUNCTION — see `lib/fleet-budget.mjs`.
   *
   * `budgetUsd` bounds THIS run. This bounds every terminal working the
   * workspace today, which is the number that stays true when somebody does the
   * thing this tool is for and opens seven of them. `null` (the default) is a
   * single falsy check inside `canContinue` and not one disk read, so a caller
   * that has never heard of it is completely unaffected.
   */
  fleetGate = null,
  /**
   * ⭐ Keep going while a DECLARED criterion is unmet, rather than accepting the
   * model's own "I am finished". Only meaningful with a budget — the CLI refuses
   * the pair, and this function stops on the budget regardless.
   */
  untilDone = false,
  /**
   * ── ⚠️ MCP CONSENT, INJECTED SO IT IS TESTABLE WITHOUT A TERMINAL ─────────
   *
   * `mcpAsk` is the question-asker; `mcpInteractive` says whether there is
   * anybody to ask. Both default to the honest values for a library caller —
   * nobody, so nothing is spawned. `bin/acuvo.mjs` supplies the real terminal.
   *
   * ⚠️ DEFAULTING TO NON-INTERACTIVE IS DELIBERATE. A library embedding this
   * loop inside a server has no terminal, and the safe answer there is to
   * refuse, not to guess that silence means yes.
   */
  mcpAsk = null,
  mcpInteractive = false,
  /**
   * ── ⚠️ THE ADMIN LAYER, APPLIED WHERE THE OFFER IS BUILT ──────────────────
   *
   * Filtering here rather than in `bin/` is deliberate: a caller that computes
   * its own `toolNames` must not be able to route around a forbid-list. The
   * default is `OPEN_POLICY`, so a run with no policy file is unchanged.
   */
  policy = OPEN_POLICY,
}) {
  const continuing = Array.isArray(priorMessages) && priorMessages.length > 0;
  /**
   * ── ⭐⭐ THE PRE-READ IS NOW THE REPO MAP ────────────────────────────────
   *
   * ⚠️ THIS IS A FIX, NOT A PREFERENCE, AND THE MEASUREMENT IS IN
   * `repo-map.mjs`'s header. `gatherWorkspaceContext` walked TWO levels and
   * read every small file it found into the prompt. Two consequences:
   *
   *   · a file four levels down, referenced by nothing, was INVISIBLE — so the
   *     model invented a plausible module and wrote over the wrong one;
   *   · the CONTENTS of a gitignored file went to the provider. Measured on a
   *     fixture: the old path sent the body of an ignored file, the map does
   *     not. That half is a leak, and it is why this is not optional.
   *
   * ⚠️ AND IT CAN NEVER TAKE THE TURN DOWN. `repoMapForExecutor` returns a
   * STRING and swallows every failure, because a pre-read is an optimisation
   * and not a precondition: an unreadable workspace must degrade to "no map"
   * and let the session proceed. The `context.ok` guard below therefore cannot
   * fire on this path any more; it is kept because the shape is still the
   * contract, and because deleting a guard to celebrate making it unreachable
   * is how it comes back without one.
   *
   * ⚠️ `gatherWorkspaceContext` IS NOT DELETED. It is exported, other callers
   * and three test files use it, and removing an exported function is a
   * separate decision from changing which one this loop calls.
   */
  const context = continuing
    ? { ok: true, text: '' }
    : { ok: true, text: repoMapForExecutor(executor) };
  if (!context.ok) {
    return { ok: false, stage: 'gather', error: `could not read the workspace: ${context.error}` };
  }

  /**
   * ── ⚠️⚠️ THE PREFLIGHT, AND IT IS ABOVE EVERYTHING THAT COSTS ANYTHING ────
   *
   * Higher than the wiring note in `budget.mjs` suggests, on purpose. Below the
   * MCP block it would already have spawned every server a repository's
   * `.mcp.json` names before discovering the run could never afford a round —
   * seconds of startup, and processes started, for a session that is about to
   * refuse itself. Here it costs one object allocation.
   *
   * ⚠️ `error` AND `message` BOTH CARRY THE SENTENCE. `formatSummary` prints
   * `outcome.error` for a failed run, so returning only `message` would print
   * "✖ undefined" — a refusal that cannot say why is indistinguishable from a
   * crash, and this is the one refusal a user most needs to understand.
   */
  const budget = createBudget({ limitUsd: budgetUsd, limitIsDefault: budgetIsDefault === true, fleetGate });

  /**
   * ── ⭐⭐ ONE ASKER PER RUN, BECAUSE THE ALLOWANCE IS PER RUN ────────────────
   *
   * `budgetedAsker` holds the question count in a closure. Building it here —
   * once, beside the money budget it is modelled on — is what makes "at most
   * three questions in a whole run" true. Building it per round, or per tool
   * call, would reset the count and turn the limit into decoration.
   *
   * ⚠️ `null` propagates twice and both matter: `toolNamesForRounds` then omits
   * `ask_user` from the offer entirely (a schema costs tokens every round), and
   * the dispatcher's own guard refuses with an instruction to proceed. Reused
   * from `mcpAsk` deliberately — "is there a human at this terminal" is one
   * fact, and asking it twice is how two answers to one question drift apart.
   */
  const askUser = budgetedAsker(mcpAsk);
  const preflight = budget.canContinue();
  if (!preflight.ok) {
    return {
      ok: false,
      stage: 'budget',
      stoppedBecause: preflight.reason,
      error: preflight.message,
      message: preflight.message,
      budget: budget.toJSON(),
    };
  }

  /**
   * ⚠️ `root` IS PASSED, AND LEAVING IT OUT WAS A REAL (IF SMALL) DEFECT.
   * `toolNamesForRounds` probes the workspace to decide two offers — is there a
   * `.acuvo/skills` directory with something in it, and is a language server
   * installed for a language this project actually contains. Its parameter
   * defaults to `process.cwd()`, which is right for every run WITHOUT `--dir`
   * and wrong for every run with one: the probe would answer for the directory
   * the operator happened to be standing in rather than the one the model is
   * working in. `executor.root` is the single fact that settles it, and it is
   * the same value every other tool resolves paths against.
   */
  /**
   * ⚠️ THE FILTER WRAPS **BOTH** BRANCHES, including a caller-supplied
   * `toolNames`. Applying it only to the computed offer would mean any embedder
   * passing its own list silently escapes the organisation's forbid-list — a
   * control with a documented bypass is not a control.
   */
  const offered = filterToolNames(
    policy,
    toolNames ?? toolNamesForRounds(maxRounds, { allowRun, root: executor.root, subagent: depth > 0, interactive: askUser !== null }),
  );
  /**
   * ── ⭐ MCP SERVERS, CONNECTED ONCE PER SESSION ────────────────────────────
   * Spawned before the loop and killed in the `finally` below, so a session
   * cannot leave orphaned processes behind — the failure that had 38 node
   * processes on this machine today.
   *
   * ⚠️ ONLY FOR A MULTI-ROUND TURN. A remote tool's result has nowhere to go in
   * a single-shot run, and spawning a server to offer a dead button would cost
   * seconds of startup for nothing.
   */
  let mcpConns = [];
  let mcpSchemas = [];
  /**
   * ⚠️ THE EARLY RETURNS ARE THE DANGEROUS ONES. `runSession` bails out on a
   * round-1 model failure without reaching the bottom, so a `finally` around the
   * loop is not enough — the process-level hooks catch the paths a reader (and
   * I) would miss, and they are installed ONCE for the whole process rather than
   * once per turn. See the registry above for why that distinction is the bug.
   */
  installLifecycleHooks();
  /**
   * End of session: kill this turn's servers now and forget them, so the
   * process-lifetime registry only ever holds connections that are still alive.
   * A set that grows for the life of an interactive session is the same leak
   * wearing different clothes.
   */
  const releaseMcp = () => {
    try { closeConnections(mcpConns); } catch { /* exiting anyway */ }
    for (const c of mcpConns) liveMcpConns.delete(c);
  };
  /**
   * ── ⚠️⚠️ `--dry-run` AND `--no-run` MUST STOP THIS, AND THEY DID NOT ────────
   *
   * An MCP server is a program we spawn with the FULL UNSCRUBBED environment
   * (mcp.mjs deliberately passes credentials, because a server needs them). The
   * gate was `maxRounds > 1` and nothing else — so cloning a repository that
   * happens to contain a committed `.mcp.json` and running `acuvo --dry-run`
   * executed an attacker-chosen binary before a single file was read.
   *
   * ⭐ AND THE README RECOMMENDS `--dry-run` FOR EXACTLY THAT SITUATION:
   * "use --dry-run for a task you do not trust yet." A flag that promises
   * "touch nothing, run nothing" while spawning a process from the repo is not
   * a weak guarantee, it is a false one — and it is worse than having no flag,
   * because it is the advice a careful person follows.
   *
   * `--no-run` is included for the same reason: the user said run nothing.
   */
  /**
   * ⚠️ `allowMcp:false` IS THE STRONGEST FORM OF THIS GATE and it comes first:
   * an organisation that has banned MCP must not even be ASKED for consent, or
   * the prompt itself becomes a way to talk somebody into it.
   */
  const mcpPolicy = mcpDecision(policy);
  const mcpAllowed = mcpPolicy.allowed && maxRounds > 1 && allowRun && !executor.dryRun;
  if (mcpAllowed) {
    const cfg = readMcpConfig(executor.root);
    if (!cfg.ok) {
      onEvent({ type: 'tool', record: { name: 'mcp', args: {}, result: { ok: false, error: cfg.error } } });
    } else if (cfg.servers.length > 0) {
      /**
       * ── ⚠️⚠️ CONSENT BEFORE THE FIRST SPAWN (ENTERPRISE §3.1) ──────────────
       *
       * Cloning an untrusted repository and typing `acuvo` used to execute a
       * binary that repository chose — no prompt, no record, full environment.
       * The flag half was already shut (`--dry-run`/`--no-run` above); this is
       * the ordinary run, which is every run, because the default is 5 rounds.
       *
       * ⭐ Consent, not a blocklist: a committed `.mcp.json` is a legitimate
       * thing to want. What was missing is that nobody ever agreed to it.
       */
      const consent = await checkMcpConsent(cfg.servers, {
        root: executor.root,
        ask: mcpAsk,
        isInteractive: mcpInteractive,
      });
      if (!consent.allowed) {
        onEvent({ type: 'mcp', name: 'consent', ok: false, count: 0, error: consent.reason });
        cfg.servers = [];
      } else if (consent.remember) {
        recordTrust(consent.fingerprint, { root: executor.root, servers: cfg.servers });
      }
      for (const srv of cfg.servers) {
        /**
         * ⚠️ ANNOUNCED **BEFORE** THE SPAWN, NAMING THE BINARY. The audit record
         * is written when the RUN ends, and the `mcp` event was emitted after
         * `connectServer` returned — so if the spawn is the thing that harms
         * you, every record of it arrived after the harm, and none of them named
         * what was executed. A record that only survives the benign case is not
         * a record.
         */
        onEvent({
          type: 'mcp-start',
          name: srv.name,
          command: srv.command,
          args: srv.args ?? [],
          env: Object.keys(srv.env ?? {}),
        });
        const conn = await connectServer(srv, { root: executor.root });
        mcpConns.push(conn);
        // Registered the moment it exists, not after the loop: a Ctrl-C while
        // the SECOND server is still handshaking must still kill the first.
        liveMcpConns.add(conn);
        onEvent({ type: 'mcp', name: srv.name, ok: conn.ok, count: conn.ok ? conn.tools.length : 0, error: conn.error });
      }
      mcpSchemas = mcpToolSchemas(mcpConns);
    }
  }

  const tools = [...toolSchemasFor(offered, { shell }), ...mcpSchemas];
  /**
   * ⚠️ APPEND, NEVER REBUILD. The system prompt and the workspace context are the
   * cacheable prefix; a continuing turn adds one user message to the end and
   * touches nothing before it.
   */
  /**
   * ⭐ THE PROJECT'S OWN NOTES, IF IT HAS ANY. Read once per session and placed
   * in the SYSTEM message so it joins the cacheable prefix — a per-turn user
   * message would re-send it every round and pay for it every round.
   *
   * ⚠️ PLACED BEFORE THE SAFETY RULES, DELIBERATELY. The file lives in the repo,
   * so a hostile repository is a hostile paragraph in this prompt. Putting it
   * first means every rule that follows overrides it: "ignore previous
   * instructions" has already been answered by the time the model reaches the
   * tool contract.
   */
  const memory = continuing ? null : readProjectMemory(executor.root);
  const memoryBlock = memoryPromptBlock(memory);
  /**
   * ── ⭐⭐ THE SKILLS CATALOGUE — A TOOL WITHOUT A LIST IS UNDISCOVERABLE ─────
   *
   * `read_skill` takes a NAME, and its schema tells the model to use the one
   * "exactly as it appears in the SKILLS list". That list is this. Without it
   * the tool is reachable and useless: measured, a model asked to do a job a
   * skill covers went `list_dir .acuvo/skills` → `read_file` instead of calling
   * the tool built for it, spending two rounds to reach a worse copy of the
   * same text (no size bound, no frontmatter parse, no safety wrapper).
   *
   * ⚠️ ONLY WHEN THE TOOL IS ACTUALLY OFFERED. `offered` already encodes the
   * availability gate, so keying off it means the prompt and the schema list can
   * never disagree — a catalogue naming skills the model has no verb to open is
   * the dead button with extra steps, and it would burn prompt tokens describing
   * a capability that is not there.
   *
   * ⚠️ PLACED WITH THE MEMORY BLOCK, BEFORE THE SAFETY RULES, for the same
   * reason and it matters MORE here: skill files are prose written into the
   * repository, so a hostile repo is a hostile paragraph in this prompt. Every
   * rule below overrides it, and `skillsPromptBlock` additionally states in the
   * catalogue itself that a skill grants no tool and lifts no restriction.
   *
   * ⚠️ NEVER THROWS. `discoverSkills` documents that it returns `{ok:false}`
   * rather than throwing, `skillsPromptBlock(null)` is null, and the try/catch
   * is the rule that assembling the PROMPT can never be what kills a run.
   */
  let skillsBlock = null;
  if (!continuing && offered.includes('read_skill')) {
    try {
      skillsBlock = skillsPromptBlock(discoverSkills(executor.root));
    } catch {
      skillsBlock = null;
    }
  }
  /**
   * ── ⭐⭐ WHAT PAST RUNS LEARNED ─────────────────────────────────────────────
   *
   * `project-memory.mjs` opens by naming the prize exactly right — *"the
   * accumulated context, the thing that makes session forty better than session
   * one"* — and then delivers ACUVO.md, a file a HUMAN writes. Nothing the agent
   * DISCOVERED ever survived the process exiting, so session forty re-derived
   * what session one already knew and got it wrong the same way.
   *
   * ⚠️ IT SITS IN THE STABLE PREFIX, WITH THE MEMORY BLOCK, AND THAT IS NOT
   * COSMETIC. Measured 2026-08-11: DeepSeek caches automatically and a hit costs
   * up to 50x less, but ONLY when the prompt prefix repeats byte-for-byte from
   * token 0. `learnedPromptBlock` renders its entries sorted and without
   * timestamps precisely so this block is identical on every round of a session.
   * Anything placed here that reshuffled would silently cost three to fifty
   * times the money with nothing reporting it.
   *
   * ⚠️ AND IT IS READ ONCE, LIKE THE MEMORY BLOCK — `continuing` skips it,
   * because a resumed run already carries the prefix it was built with.
   */
  const learned = continuing ? null : recall(executor.root);
  const learnedBlock = learnedPromptBlock(learned);

  const preamble = [memoryBlock, learnedBlock, skillsBlock].filter(Boolean).join('\n\n');
  const systemText = preamble
    ? `${preamble}

${systemPrompt({ maxRounds, allowRun, offeredNames: offered, untilDone })}`
    : systemPrompt({ maxRounds, allowRun, offeredNames: offered, untilDone });
  if (memory?.found) onEvent({ type: 'memory', file: memory.file, truncated: memory.truncated });

  const messages = continuing
    ? [...priorMessages, { role: 'user', content: task }]
    : [
        { role: 'system', content: systemText },
        { role: 'user', content: userPrompt({ task, contextText: context.text, root: executor.root }) },
      ];

  const rounds = [];
  const executed = [];
  const runs = [];
  let lastNote = null;
  /**
   * ⚠️ TRACKS `lastNote`, NOT THE LOOP. It answers one question — "did the
   * terminal already show the exact text the summary is about to print?" — so it
   * may only ever change on a round that changes `lastNote`, and it resets to
   * `false` the moment it cannot be proved. Defaulting to `true` anywhere would
   * make the summary silently drop the model's answer.
   */
  let lastNoteAlreadyShown = false;
  let lastFinishReason = null;
  /** How many times the transcript was rewritten — see the compaction block. */
  let compactions = 0;
  let stoppedBecause = 'round-cap';
  // See the verification block below: a passing command extends the loop once,
  // never twice. Declared here so the ceiling is one per SESSION, not per round.
  let verificationExtended = false;
  /**
   * ⚠️ ONE NUDGE PER LOOP, AND THE SET IS NOT OPTIONAL. Without it the same
   * detection fires every round, which changes the prompt prefix every round and
   * throws away the byte-identical cache hit worth 3.05x on DeepSeek. A loop
   * detector that triples the bill is not a saving. `evidence.key` is stable for
   * as long as one loop persists and differs between distinct loops.
   */
  const nudged = new Set();
  /**
   * How many times `--until-done` has refused to accept "I am finished" while a
   * declared criterion was still unmet. Bounded: the budget is the real wall,
   * but a model that says "done" to every prompt would otherwise spend the whole
   * allowance three words at a time, and the honest answer after a few attempts
   * is to stop and say the criterion was never met.
   */
  let pressedOn = 0;
  const MAX_PRESS_ON = 3;

  /**
   * ── ⭐⭐ `--until-done`: DO NOT ACCEPT "I AM FINISHED" WHILE THE THING THE
   *        USER ASKED FOR HAS NOT HAPPENED ────────────────────────────────────
   *
   * Returns true when the loop should carry on instead of stopping.
   *
   * ⚠️ ONLY A **DECLARED** CRITERION COUNTS, never a derived one. A derived
   * criterion is this runner's reading of somebody's prose; making the loop
   * spend more money because a heuristic misread a sentence is the
   * check-that-fails-correct-work failure with a bill attached. Someone typed a
   * declared one, so refusing to stop short of it is honouring an instruction.
   *
   * ⚠️ AND IT IS BOUNDED THREE WAYS: the flag must be on, the budget must still
   * allow a round, and it may not happen more than MAX_PRESS_ON times. The
   * budget alone would technically be enough, but a model that answers every
   * prompt with "done!" would then burn the whole allowance one sentence at a
   * time, and "your criterion was never met" is a better outcome than an empty
   * wallet and the same sentence.
   */
  const pressOnForAcceptance = (round) => {
    if (!untilDone || pressedOn >= MAX_PRESS_ON) return false;
    if (!budget.canContinue().ok) return false;

    const loaded = (() => { try { return loadAcceptance(executor?.root); } catch { return null; } })();
    if (!loaded?.ok || !loaded.found) return false;
    const verdict = evaluateAcceptance({ declared: loaded.criteria, executed });
    if (verdict.verdict !== 'unmet' && verdict.verdict !== 'not-run') return false;

    const outstanding = (verdict.unmet ?? []).map((u) => u.command).filter(Boolean);
    const named = outstanding.length > 0
      ? outstanding.map((c) => `\`${c}\``).join(', ')
      : 'the criterion you declared';
    pressedOn += 1;
    onEvent({
      type: 'until-done', round, attempt: pressedOn, of: MAX_PRESS_ON,
      verdict: verdict.verdict, commands: outstanding,
    });
    messages.push({
      role: 'user',
      content: `[runner — automatic, not from the user] --until-done is set, and ${named} has not been `
        + 'satisfied yet: no run in this session executed it successfully. Do not stop here. Either make the '
        + 'change that fixes it and run it, or — if it genuinely cannot pass — say in one sentence exactly '
        + `what is blocking it. This is attempt ${pressedOn} of ${MAX_PRESS_ON}; after that the session ends `
        + 'with the criterion recorded as unmet.',
    });
    return true;
  };

  for (let round = 1; round <= maxRounds; round += 1) {
    /**
     * ── ⚠️⚠️ MONEY IS CHECKED BEFORE THE ROUND, NOT AFTER IT ────────────────
     * The FIRST statement in the body, above the round banner, because a round
     * that has been announced and then refused reads as a bug, and because the
     * only useful moment to decline a purchase is before making it.
     *
     * With no budget this is `{ ok: true, reason: 'no-budget-set' }` every time
     * and nothing below it ever runs.
     */
    const affordable = budget.canContinue();
    if (!affordable.ok) {
      stoppedBecause = affordable.reason;
      onEvent({ type: 'budget-stop', ...affordable });
      break;
    }
    onEvent({ type: 'round-start', round, of: maxRounds });

    /**
     * ── ⭐ THE COUNTDOWN, INJECTED HERE AND NOWHERE ELSE ────────────────────
     *
     * APPENDED, never inserted. The system message and the workspace context are
     * the cacheable prefix; a line added to the END leaves that prefix byte-
     * identical, so the 97.2% cache hit this loop was built around survives.
     * Editing the system prompt with the round number instead would throw the
     * whole cache away on every round to say one sentence.
     *
     * ⚠️ READ FRESH EVERY ROUND, because `plan_step` writes to that same file
     * mid-round: a cached plan would show work as outstanding after the model
     * marked it done, which is the banner lying — and a banner that lies is
     * worse than no banner, since the model has no other view of the wall.
     */
    const banner = planBannerFor(executor, { roundIndex: round, maxRounds });
    if (banner) {
      onEvent({ type: 'plan', round, text: banner });
      messages.push({
        role: 'user',
        content: `${banner}\n(that line is from the runner, not from you — it is the plan you recorded, and the round budget left. Finish what was asked before the rounds run out; the LAST thing on the list is the one that gets lost.)`,
      });
    }

    /**
     * ⭐ THE LIVE PRINTER. Streams the model's reasoning as it arrives so a
     * 20-second call stops being 20 seconds of silence. Bounded to a few lines:
     * the reasoning is orientation, the WORK is the deliverable, and a wall of
     * think-aloud would bury the tool lines that actually matter.
     *
     * ⚠️ Only when someone is watching. `onEvent` is a no-op in tests and in
     * scripted runs, and streaming into nothing would spend the complexity for
     * no one — so the printer is created per round and disposed with it.
     */
    /**
     * ── ⭐ ONE RENDER PATH FOR THE MODEL'S PROSE ────────────────────────────
     *
     * ⚠️ MEASURED DEFECT, from a real run (stdout only, stderr empty): the
     * closing note printed TWICE — once live mid-round, once again in the
     * summary — and the live copy was cut mid-word with no marker, so the
     * duplicate also read as broken output. Two copies of one fact is exactly
     * the seam this file kills everywhere else (`formatChanges`, the budget
     * line), and it survived here because the two copies are produced by
     * different code at different times.
     *
     * ⭐ `emitted` IS WHAT THE TERMINAL ACTUALLY RECEIVED — not what the model
     * sent. The difference is the whole safety of the suppression below: a
     * caller with a discarding `onEvent` (`--json`, the parallel fan-out, every
     * test) is indistinguishable from one that printed, so the flag must be
     * derived from bytes that went THROUGH `onEvent`, and a run nobody watched
     * must keep its note.
     */
    let emitted = '';
    const live = createLivePrinter({
      write: (t) => { emitted += t; onEvent({ type: 'stream', text: t }); },
    });

    /**
     * ── ⭐⭐ COMPACT BEFORE THE CALL, NEVER AFTER IT ────────────────────────
     *
     * ⚠️ THE PLACEMENT IS THE WHOLE POINT. Compacting after the reply has
     * already been paid for saves nothing on the round that burst — it saves
     * something on the NEXT one, by which time the expensive round happened.
     *
     * ⚠️ `messages.length = 0; push(...)` — REASSIGNED IN PLACE, DELIBERATELY.
     * The round loop closes over this exact binding and pushes to it directly
     * further down. `messages = fit.messages` would leave those pushes writing
     * into the old array on some paths, and the symptom would be tool results
     * vanishing at random — a bug that looks like the model forgetting.
     *
     * ⚠️ AND IT IS ANNOUNCED. Silent compaction is indistinguishable from
     * amnesia: the user watches the agent stop knowing something it read two
     * rounds ago and has no way to tell that from a model defect.
     * `report.lines` is written to be printed verbatim and already carries the
     * "these figures are estimates" disclaimer.
     */
    /**
     * ── ⚠️⚠️ AND IT IS THE ONE THING THAT VOIDS THE PROMPT-PREFIX CACHE ──────
     *
     * MEASURED, 16-round probe with fat tool results, before this counter
     * existed:
     *
     *   r11(22 msgs) → r12(24): stable prefix 22/22 = 100%
     *   r12(24 msgs) → r13(26): stable prefix  3/24 = 12.5%   ← first compaction
     *   r13(26 msgs) → r14(28): stable prefix  3/26 = 11.5%
     *
     *   round 13: 25943 → 23951 estimated tokens — freed 7.7%
     *   round 14: 26037 → 23046 estimated tokens — freed 11.5%
     *
     * ⭐ Each pass frees ~8% of the transcript and voids the cache on ~87% of
     * it, and a miss costs ~50× a hit. That trade was completely invisible.
     * COUNTED, not prevented: the compactor exists because an unbounded
     * transcript eventually cannot be sent at all, and trading a real ceiling
     * for a cheaper bill is not this loop's call to make silently. What it CAN
     * do is make the cost attributable — see the summary's cache line.
     */
    /**
     * ⚠️ TWO NUMBERS, NOT ONE. The transcript is only compacted once it crosses
     * the HIGH water mark, and then it is compacted down to the LOW one — so the
     * next round does not immediately cross again and re-void the cache. Passing
     * a single budget is what made rounds 13 and 14 both compact.
     */
    const estimated = estimateMessagesTokens(messages);
    const fit = estimated > CONTEXT_BUDGET_TOKENS
      ? compactMessages(messages, { budgetTokens: COMPACT_TARGET_TOKENS, keepLastRounds: 2 })
      : { dropped: 0, messages, report: null };
    if (fit.dropped > 0) {
      messages.length = 0;
      messages.push(...fit.messages);
      compactions += 1;
      onEvent({ type: 'compact', round, report: fit.report });
    }

    const reply = await callModelImpl({
      onText: (t) => live.onText(t),
      apiKey: config.apiKey,
      model: config.model,
      messages,
      tools,
      maxTokens,
      timeoutMs,
    });
    /**
     * ── ⚠️ THE PRINTER WAS NEVER FLUSHED ───────────────────────────────────
     * Measured: prose that arrives without a trailing newline — which is most
     * closing sentences — sat in the printer's buffer and was DISCARDED, so the
     * live copy stopped mid-sentence and the summary then repeated the whole
     * thing. Flushing is what lets a short note be finished on screen, which is
     * what makes printing it once possible at all.
     */
    live.flush();
    if (!reply.ok) {
      /**
       * ⚠️ A MID-LOOP MODEL FAILURE IS NOT A WHOLE-SESSION FAILURE. Round 1 may
       * have written three correct files before round 2 got a 429; throwing that
       * away and printing only "rate limited" would hide work that is already on
       * disk. So the first round aborts, and a later one degrades: the session
       * ends, keeps what happened, and names the error.
       */
      if (round === 1) {
        // ⚠️ THIS RETURN USED TO LEAVE THE SERVERS RUNNING until the process
        // itself died — which, in an interactive chat, is not for another hour.
        // The session is over here; the children should be too.
        releaseMcp();
        return { ok: false, stage: 'model', error: reply.error };
      }
      stoppedBecause = 'model-error';
      lastNote = lastNote ?? null;
      rounds.push({ round, error: reply.error, executed: [], usage: null });
      /**
       * ⚠️⚠️ THE `null` IS PASSED ON PURPOSE AND MUST NOT BE GUARDED. A
       * provider that errors AFTER billing is the commonest expensive failure
       * there is, and skipping this call would make it look free — the exact
       * "unknown priced as zero" trap. The governor charges a null the current
       * projection, which is neither free nor invented.
       */
      budget.record(reply.usage);
      onEvent({ type: 'tool', record: { name: 'model', args: {}, result: { ok: false, error: reply.error } } });
      break;
    }

    /**
     * ── ⭐ WAS IT ALREADY SHOWN, IN FULL? ───────────────────────────────────
     *
     * ⚠️ COMPARED ON THE TEXT, NOT ON A LINE COUNT. `linesPrinted() > 0` — the
     * signal already used for the `note` event — is true for a note whose first
     * two lines were shown and whose remaining eight were dropped, so basing
     * suppression on it would delete eight lines of the model's answer.
     * Whitespace is normalised because the printer indents, wraps and trims; the
     * CHARACTERS are what must match, and every one of them must be there.
     */
    const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const shownInFull = flat(emitted).length > 0 && flat(emitted) === flat(reply.content);
    /**
     * ⚠️ AND IF IT WAS CUT, SAY SO. A preview that stops mid-word with no marker
     * reads as broken output rather than as a preview — measured on a real run,
     * and it is the reason the duplicate below looked like a bug instead of a
     * report. One character fixes the reading.
     */
    if (!shownInFull && flat(emitted).length > 0) onEvent({ type: 'stream', text: '  …\n' });

    if (reply.content != null) lastNoteAlreadyShown = shownInFull;
    lastNote = reply.content ?? lastNote;
    lastFinishReason = reply.finishReason;
    /**
     * ⚠️⚠️ `streamed` IS THE EMITTED TEXT, NOT `live.linesPrinted()` — MEASURED.
     * `flush()` writes the buffered tail WITHOUT incrementing the printer's line
     * counter, so a one-line note (the commonest closing sentence there is)
     * reached the terminal and then reported `linesPrinted() === 0`. `renderEvent`
     * suppresses this event only when `streamed` is true, so the note printed
     * live and IMMEDIATELY AGAIN one line below it — the duplicate in the
     * measured run, and it survived deleting the summary's copy because it is a
     * third copy from a third place.
     */
    onEvent({ type: 'note', round, text: reply.content, streamed: flat(emitted).length > 0 });

    if (reply.toolCalls.length === 0) {
      rounds.push({ round, note: reply.content, executed: [], usage: reply.usage, finishReason: reply.finishReason, model: reply.model ?? null });
      budget.record(reply.usage);
      /**
       * ⚠️ THE MODEL'S OWN WORDS GO INTO THE CONVERSATION FIRST. Pushing the
       * continuation without them would leave two `user` messages back to back
       * with the assistant's "I am finished" missing — the model would be
       * answering a question it has no record of having already answered.
       */
      if (pressOnForAcceptance(round)) {
        messages.splice(messages.length - 1, 0, { role: 'assistant', content: reply.content ?? '' });
        continue;
      }
      stoppedBecause = 'no-tool-calls';
      break;
    }

    /**
     * ⚠️ IDS ARE SYNTHESISED IF THE PROVIDER OMITS THEM, and the SAME object is
     * echoed back in the assistant message. An OpenAI-shaped conversation is
     * rejected outright when a `tool` message references an id no `tool_call`
     * declared, so a provider that leaves `id` off would break round 2 with an
     * HTTP 400 that reads like a bug in the prompt.
     */
    const calls = reply.toolCalls.map((call, i) => (call.id ? call : { ...call, id: `call_${round}_${i}` }));
    messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: calls });

    const roundExecuted = [];
    for (const call of calls) {
      /**
       * ⚠️ MCP CALLS ARE ROUTED BEFORE THE LOCAL DISPATCHER, because the local
       * one would answer `unknown tool` for a name it has never heard of — and
       * the model would read that as "this capability does not exist" rather
       * than "you asked the wrong dispatcher".
       */
      const ns = parseNamespaced(call?.function?.name);
      const record = ns
        ? await (async () => {
            let args = {};
            try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* reported below */ }
            const result = await callMcpTool(mcpConns, call.function.name, args);
            // ⚠️ mutated: false — a remote tool may well change something, but
            // not a file in THIS workspace, and the "files written" line names
            // only paths our executor wrote.
            return { id: call.id, name: call.function.name, args, result, mutated: false };
          })()
        /**
         * ⭐ `round` AND `allowRun` ARE BOTH PASSED, AND BOTH WERE OPTIONS THAT
         * NOTHING SUPPLIED UNTIL NOW.
         *
         * `round` is what puts the countdown INSIDE a tool result rather than
         * only in the terminal's own event line: `plan_status` can say "· round
         * 4 of 4" instead of dropping the clause, and plan-ledger.mjs's rule is
         * that a missing clause is the correct degradation while a wrong one is
         * not — so the fix is to hand it the number, never to guess.
         *
         * ⚠️ `allowRun` closes a door the OFFER alone cannot. `--no-run`
         * withholds `check_acceptance` from the schemas, but a model can emit a
         * call for a tool it was never shown (a stale conversation, a resumed
         * session, a provider that echoes an old tool list). The flag must be
         * enforced where the command would actually be spawned, which is the
         * dispatcher — the same argument that put `evaluate` behind it.
         */
        : await executeToolCall(call, executor, {
            commandTimeoutMs,
            shell,
            round: { roundIndex: round, maxRounds },
            allowRun,
            /**
             * ⚠️ `delegate` IS THE FIRST TOOL THAT CALLS A MODEL ITSELF, so the
             * dispatcher needs the credentials this loop already holds. Passing
             * `depth: 0` is what makes a helper's own dispatcher receive 1 —
             * which `runSubagent` refuses, so recursion is closed at the
             * dispatcher as well as at the offer.
             */
            config,
            depth,
            /**
             * ⭐ ONE asker for the whole run, created above — the per-run
             * question allowance lives in its closure. Creating it per call
             * would reset the budget every round and make the limit
             * meaningless.
             */
            ask: askUser,
          });
      roundExecuted.push(record);
      executed.push(record);
      /**
       * ⚠️⚠️ `evaluate` COUNTS AS A RUN, AND IT DID NOT UNTIL NOW. Measured on
       * the first streaming run: the model wrote the module, verified it with
       * `evaluate` (exit 0), and the summary still said "NOTHING WAS RUN, so
       * nothing here is verified". The one line in the summary whose whole job
       * is honesty was lying in the pessimistic direction — which trains people
       * to ignore it, and then it cannot warn them when it matters.
       *
       * Both tools execute code and both return {passed, exitCode}. The
       * verification verdict is about whether the CODE WAS PROVEN TO RUN, not
       * about which tool proved it.
       */
      /**
       * ⚠️⚠️ AND `run_program` COUNTS — THE SAME BUG A THIRD TIME IF IT DID NOT.
       *
       * This list has now been wrong twice for the identical reason: it was
       * keyed on the NAME OF THE TOOL rather than on whether a process ran.
       * `evaluate` was missing (the summary said "NOTHING WAS RUN" after the
       * model had verified its module), then `check_acceptance` was missing (the
       * suite ran, exited 0, and was re-run by the sweep that had just been told
       * it had not happened). `run_program` spawns through the same
       * `spawnBounded`, with the same allowlist, and returns the same
       * `{passed, exitCode, timedOut}` — so it is a run.
       *
       * ⚠️ ITS `command` IS SYNTHESISED FROM `argv`, because a run_program
       * result has no `command` field at all and the branch below would have
       * labelled it the literal string "evaluate". Every consumer of `runs`
       * treats `command` as a string: `latestRunPerCommand` keys on it,
       * `attemptsOf` counts it, `unopenedPages` asks whether it `.includes()` a
       * filename. The joined argv answers all three honestly — it is what ran,
       * in the order it ran — and `formatProgramRunForModel` is what shows the
       * model the precise slot boundaries, which is the fact a join would lose.
       *
       * ⚠️ `tool: 'run_program'` IS WHAT KEEPS IT OUT OF THE STALE RE-RUN. Only
       * records whose `tool` is `run_command` are eligible to be re-executed
       * when a later write invalidates them, and re-running a joined argv AS A
       * STRING would hand it straight back to the parser this tool exists to
       * avoid — `node bin/todo.js add buy milk` is not the command that ran.
       */
      if (record.name === 'run_program' && record.result?.ok === true) {
        runs.push({
          ...record.result,
          command: Array.isArray(record.result.argv) ? record.result.argv.join(' ') : 'run_program',
          tool: 'run_program',
          at: executed.length - 1,
        });
      }
      if ((record.name === 'run_command' || record.name === 'evaluate') && record.result?.ok === true) {
        /**
         * ⚠️ `tool` AND `at` ARE CARRIED, and both are load-bearing below.
         * `tool` because an `evaluate` snippet is DELETED the moment it
         * finishes — re-running its synthesised command name `evaluate` as a
         * shell command is nonsense, so only real `run_command`s are eligible
         * for the stale re-run. `at` because "was this result invalidated by a
         * later write?" is a question about POSITION, and the old code answered
         * it for the last run only.
         */
        runs.push({
          ...record.result,
          command: record.result.command ?? 'evaluate',
          tool: record.name,
          at: executed.length - 1,
        });
      }
      /**
       * ── ⚠️⚠️ AND `check_acceptance` COUNTS TOO — THE SAME BUG, ONE TOOL LATER
       *
       * FOUND BY RUNNING IT, 2026-08-11, the day acceptance was wired. The model
       * declared `npm test` as the criterion and called `check_acceptance`; the
       * suite ran and exited 0. The end-of-run sweep then printed "`npm test`
       * was declared as the criterion and nothing in this run satisfied it" and
       * RAN THE WHOLE SUITE AGAIN, and the summary still said "⚠ NOTHING WAS
       * RUN, so nothing here is verified".
       *
       * Every word of that was wrong, and it is exactly the defect the comment
       * above describes for `evaluate` — a bookkeeping list keyed on the NAME OF
       * THE TOOL rather than on whether a process ran. `check_acceptance` spawns
       * through the same `executeRunCommand` gate `run_command` does; a command
       * does not become less run because a different verb asked for it.
       *
       * ⭐ ITS ROWS ARE FLATTENED INTO `runs` AS `run_command`-SHAPED ENTRIES,
       * because that is the currency every consumer below already counts:
       * `verification`, the stale re-run map, `attemptsOf`, and
       * `evaluateAcceptance`'s `SATISFYING_TOOLS`. Inventing a fourth shape here
       * would mean teaching four readers about it.
       *
       * ⚠️ `tool: 'check_acceptance'` IS CARRIED SO THE STALE RE-RUN LEAVES IT
       * ALONE. Only records whose `tool` is `run_command` are eligible to be
       * re-run when a later write invalidates them (see the re-run block below),
       * and re-running a criterion is the acceptance sweep's job, not this one's
       * — doing both is how one `npm test` becomes three.
       *
       * ⚠️ NOT PUSHED ONTO `executed`. That array is the record of what the
       * MODEL called, and it feeds `--json .refusals` and the "N files written"
       * count; synthesising calls into it would report tool calls that never
       * happened.
       */
      if (record.name === 'check_acceptance' && record.result?.ok === true && Array.isArray(record.result.criteria)) {
        for (const row of record.result.criteria) {
          if (row?.ran !== true || typeof row.command !== 'string') continue;
          runs.push({
            ok: true,
            command: row.command,
            exitCode: row.exitCode ?? null,
            passed: row.passed === true,
            stdout: '',
            stderr: typeof row.output === 'string' ? row.output : '',
            tool: 'check_acceptance',
            at: executed.length - 1,
          });
        }
      }
      /**
       * ── ⚠️⚠️ AND A SERVER THAT ANSWERED IS A RUN — THE SAME BUG, A FOURTH TOOL
       *
       * FOUND BY RUNNING IT, 2026-08-12, the hour background processes shipped.
       * The model wrote a server, started it, probed it, got **HTTP 200**, and
       * stopped it — and the summary said "⚠ NOTHING WAS RUN, so nothing here is
       * verified". `node server.mjs` had run, and the strongest evidence a web
       * server can produce had been collected.
       *
       * The comment above predicted this exactly: a bookkeeping list keyed on
       * the NAME OF THE TOOL rather than on whether a process ran. This is the
       * same argument `see_page` already won further down — SEEING IS EVIDENCE —
       * and a served request is a stronger version of it.
       *
       * ⚠️⚠️ ONLY A SUCCESSFUL PROBE IS RECORDED, AND THE ASYMMETRY IS THE WHOLE
       * SAFETY ARGUMENT. A server two seconds into booting is legitimately not
       * answering yet; pushing `passed:false` for that would fail a run that is
       * doing exactly the right thing — the check-that-fails-correct-work defect
       * this repo has paid for four times. An unreachable probe is silence here,
       * never a negative verdict.
       */
      if (record.name === 'check_process' && record.result?.ok === true
          && record.result.probe?.reachable === true
          && Number.isInteger(record.result.probe.status)
          && record.result.probe.status < 400) {
        runs.push({
          ok: true,
          command: `GET ${record.result.url ?? `http://localhost:${record.result.port}/`}`,
          exitCode: 0,
          passed: true,
          stdout: `HTTP ${record.result.probe.status}`,
          stderr: '',
          tool: 'check_process',
          at: executed.length - 1,
        });
      }
      onEvent({ type: 'tool', round, record });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: record.name,
        content: toolResultText(record),
      });
    }
    rounds.push({ round, note: reply.content, executed: roundExecuted, usage: reply.usage, finishReason: reply.finishReason, model: reply.model ?? null });
    budget.record(reply.usage);

    /**
     * ── ⭐⭐ IS THIS RUN GOING IN CIRCLES? ───────────────────────────────────
     *
     * `stuck.mjs` reads the history this loop already keeps and answers with an
     * artifact and a next move, or with nothing at all. Its clean result is
     * fully null by construction, so there is no half-populated verdict to
     * misread here.
     *
     * ⭐ NUDGING IS THE ACTION, NOT STOPPING. The model keeps its budget and
     * gets one specific hint ("you have written the identical bytes to
     * lib/mode.js twice"); ending the run automatically is the expensive
     * mistake. The `nudged` set makes it once per distinct loop — see its
     * declaration for why re-nudging would cost 3.05x.
     *
     * ⚠️ THE HARD STOP IS `--until-done` ONLY, and that asymmetry is deliberate.
     * A bounded run already has a wall (`maxRounds`), so taking rounds away from
     * it on a heuristic risks killing correct work. An unattended run has no
     * wall but money, and a proven loop that survives its own hint is exactly
     * the shape that would spend a whole budget learning nothing.
     */
    const circling = detectStuck(rounds);
    if (circling.stuck && circling.evidence?.key) {
      if (!nudged.has(circling.evidence.key)) {
        nudged.add(circling.evidence.key);
        messages.push({ role: 'user', content: nudgeMessage(circling) });
        onEvent({ type: 'stuck', round, pattern: circling.pattern, evidence: circling.evidence, nudged: true });
      } else if (untilDone) {
        stoppedBecause = 'stuck';
        onEvent({ type: 'stuck', round, pattern: circling.pattern, evidence: circling.evidence, nudged: false });
        break;
      }
    }

    /**
     * ── ⚠️⭐ A PASSING COMMAND ENDS THE VERIFYING, NOT THE TASK ──────────────
     *
     * FOUND BY RUNNING IT, 2026-08-09, the day git landed. The task was "fix
     * slugify, THEN commit it". The model fixed it, wrote a check, ran the
     * check, it exited 0 — and the loop stopped dead. The fix was correct, the
     * verification was real, and the second half of the instruction never
     * happened. The summary said "✔ VERIFIED", so from outside it looked like
     * a complete success.
     *
     * ⚠️ That is the worst class of bug in this package: the stop condition was
     * a proxy for "done" that stopped being one the moment the CLI grew a verb
     * that comes AFTER verification. Committing is the obvious one; there will
     * be others.
     *
     * ⭐ So a pass no longer ends the turn — it buys ONE more round, with the
     * model told plainly that the loop is closing. If it has nothing left it
     * makes no tool calls and the loop ends immediately on the existing path;
     * if it has a commit to make, it makes it.
     *
     * ⚠️ ONCE, AND THE COUNTER IS WHY THIS IS SAFE. Without it a model that
     * keeps running passing commands extends forever and spends the whole
     * budget confirming its own success. The second clean round stops.
     *
     * The cost of being right: one extra round whose prompt prefix is unchanged
     * and therefore ~97% cached — measured at a fifth of a cent. The cost of
     * being wrong was silently doing half the job.
     */
    const roundRuns = roundExecuted.filter((r) => r.name === 'run_command' && r.result?.ok === true);
    if (roundRuns.length > 0 && roundRuns.every((r) => r.result.passed)) {
      /**
       * ⚠️ NEVER PROMISE A ROUND THE BUDGET CANNOT PAY FOR. Found in the second
       * live run: the pass landed on the last round, the loop announced "one
       * more round to finish anything else that was asked", and then hit the
       * cap immediately. The user was told about a round that never happened —
       * an output that lies about what the tool did, which is the one thing
       * this package is built not to do.
       */
      if (verificationExtended || round >= maxRounds) {
        /**
         * ⚠️ "A COMMAND PASSED" IS NOT "THE THING YOU ASKED FOR PASSED". Under
         * `--until-done` a green run of some other command must not close a
         * session whose declared criterion has never been executed — that is
         * precisely the false tick `acceptance.mjs` exists to kill, and here it
         * would also be the reason the loop handed back a half-finished job.
         */
        if (pressOnForAcceptance(round)) continue;
        stoppedBecause = 'verified';
        onEvent({ type: 'stopped', reason: 'verified' });
        break;
      }
      verificationExtended = true;
      onEvent({ type: 'stopped', reason: 'verified-continuing' });
      messages.push({
        role: 'user',
        content:
          'That command passed, so the code is verified. If every part of the original task is now '
          + 'complete, reply with a one-line summary and NO tool calls — that ends the session. If '
          + 'anything remains (committing your work, cleaning up a scratch file you created, another '
          + 'step that was asked for), do it now: this is the last round you get for it.',
      });
    }
  }

  /**
   * ── ⚠️⚠️ THE STALE VERDICT, AND WHY THE FIX IS A FREE RE-RUN ─────────────
   * FOUND BY RUNNING IT, 2026-08-09. The session went: round 2 ran the test and
   * it failed; round 3 wrote the corrected file and the budget ran out. The
   * summary then reported "✖ NOT VERIFIED — still exits 1" using round 2's exit
   * code — an exit code measured against a file that no longer existed.
   *
   * ⚠️ THAT IS NOT PESSIMISM, IT IS A WRONG ANSWER, and it fails in the more
   * dangerous direction too: the same staleness would report a PASS from before
   * a later edit broke everything.
   *
   * So when a write lands after the last run, the last command is run once more.
   * It costs no completion, it is the command the model already chose, it only
   * happens when the recorded exit code is provably out of date, and it is
   * announced. The alternative — printing "unverified, files changed since" —
   * knows the answer is stale and declines to go and get it.
   */
  /**
   * ── ⚠️⚠️ THE RE-RUN MUST NOT RESURRECT A FILE THE MODEL DELETED ────────────
   *
   * FOUND BY RUNNING IT, 2026-08-09, minutes after `delete_file` shipped — and
   * it is the exact "connected, not islands" failure: a new verb landed and two
   * downstream consumers did not know about it.
   *
   * The session went perfectly. Model fixed slug.js, wrote check.mjs, ran it
   * (exit 0), then tidied up by DELETING check.mjs — precisely what it was
   * asked to do. The delete counted as a mutation, so the stale-verdict guard
   * dutifully re-ran `node check.mjs`, which no longer existed:
   *
   *     ✖ NOT VERIFIED — `node check.mjs` still exits 1 after 2 attempts.
   *
   * ⭐ A CORRECT SESSION REPORTED AS A FAILURE, and the "failure" was the agent
   * doing its job. Worse than a missing feature: it actively punishes cleanup.
   *
   * So a deleted path disqualifies the re-run rather than triggering it. The
   * earlier verdict — measured when the file existed — stands, which is the
   * honest answer: that run really did pass, and nothing since has invalidated
   * it except the removal of the scaffolding itself.
   */
  const deletedPaths = executed
    .filter((e) => e.name === 'delete_file' && e.result?.ok === true)
    .map((e) => e.result.path);
  // Basename too: the command says `node check.mjs`, the delete records
  // `check.mjs` — but a nested scratch file would be `tmp/check.mjs` in one
  // and `tmp/check.mjs` in the other, so both forms are checked.
  const targetDeleted = (command) => deletedPaths.some(
    (p) => command.includes(p) || command.includes(p.split('/').pop()),
  );

  /**
   * ── ⭐ THE RE-RUN NOW COVERS EVERY STILL-FAILING COMMAND, NOT JUST THE LAST ─
   *
   * It had to, the moment the verdict below stopped ignoring earlier failures.
   * The old shape re-ran `runs[last].command` only — the command that had just
   * PASSED — so a red run from round 1 could never be re-measured. Now that a
   * red run keeps the verdict red, leaving it un-re-run would report a failure
   * against a file the model has since rewritten: the same staleness this block
   * exists to kill, pointed the other way.
   *
   * The eligibility rule is unchanged in spirit — a recorded exit code is only
   * re-measured when a WRITE landed after it, which is what makes it provably
   * out of date — and it now asks that question per run (`at`) instead of once
   * for the tail of `executed`.
   */
  const latestRunPerCommand = new Map();
  for (const r of runs) latestRunPerCommand.set(r.command, r);
  const lastRun = runs[runs.length - 1] ?? null;
  const staleCommands = [];
  if (allowRun && !executor.dryRun) {
    for (const r of latestRunPerCommand.values()) {
      // ⚠️ `evaluate` is NOT re-runnable: its snippet is deleted the instant it
      // finishes, and its recorded "command" is the literal word `evaluate`.
      if (r.tool !== 'run_command') continue;
      if (typeof r.at !== 'number' || !executed.slice(r.at + 1).some((e) => e.mutated)) continue;
      const isLast = lastRun !== null && r.command === lastRun.command;
      if (!isLast && r.passed === true) continue;
      if (targetDeleted(r.command)) continue;
      staleCommands.push(r.command);
    }
  }
  for (const command of staleCommands) {
    onEvent({ type: 'final-check', command });
    const record = await executeToolCall(
      { id: 'final_check', function: { name: 'run_command', arguments: JSON.stringify({ command }) } },
      executor,
      { commandTimeoutMs, shell },
    );
    executed.push(record);
    if (record.result?.ok === true) {
      runs.push({ ...record.result, tool: 'run_command', at: executed.length - 1 });
    }
    onEvent({ type: 'tool', record });
  }

  // A path the reply NAMED, that this session did not write, and that is not on
  // disk. All three conditions, so an incidental mention of a real file is never
  // reported — see `mentionedPaths` for why this check exists at all.
  // `mutatedPath` first, for the same reason as report.mjs and parallel.mjs: a
  // tool can write a file that is not the one it was pointed at.
  /**
   * ── ⚠️⚠️ `mutated: true` CARRIES AN IMPLICIT CONTRACT: NAME A PATH ─────────
   *
   * CRASHED A REAL RUN, 2026-08-12, the hour `start_process` shipped:
   * `TypeError: Cannot read properties of undefined (reading 'split')` two lines
   * below. That tool sets `mutated: true` — correctly, a dev server writes
   * `.next/` and logs within a second — but its result names no single file,
   * because there is no single file. The agent had already done the whole task;
   * the crash landed on the victory lap.
   *
   * ⭐ THE FILTER IS THE FIX, NOT THE ONE CALLER. Every future tool that changes
   * the world without producing one path — a migration, a deploy, a process —
   * would rediscover this the same way. A record with no path simply is not a
   * WRITTEN PATH, and the summary below is about written paths.
   */
  const writtenPaths = executed
    .filter((e) => e.mutated)
    .map((e) => e.mutatedPath ?? e.result?.path)
    .filter((p) => typeof p === 'string' && p !== '');
  const written = new Set(writtenPaths);
  /**
   * ── ⚠️ MATCHED ON BASENAME TOO, BECAUSE PROSE DROPS DIRECTORIES ────────────
   * Observed live: the agent wrote `src/checkout.js` and its own sentence called
   * it "checkout.js". The exact-path lookup missed, the file was not at the repo
   * root either, and the run ended with **"The reply named 1 file it did not
   * write: checkout.js"** — a warning about a file sitting on disk, correctly
   * updated, two lines above in the same output.
   *
   * ⭐ A FALSE WARNING IS WORSE THAN NO WARNING. This check exists so a shortfall
   * cannot read as success; the moment it cries wolf on a correct run, people
   * learn to skim past it and it stops protecting anything. Basename matching
   * can in principle mask a genuine miss (two `index.js` in different folders,
   * one written and one promised) — accepted deliberately: that is a rare miss
   * of a warning, against a common false alarm that disarms the warning itself.
   */
  const writtenNames = new Set(writtenPaths.map((p) => p.split('/').pop()));
  const promisedButMissing = mentionedPaths(lastNote)
    .filter((p) => !written.has(p) && !writtenNames.has(p.split('/').pop()) && !executor.readFile(p).ok);

  /**
   * ── ⚠️⭐ A PAGE NOBODY LOOKED AT IS NOT A VERIFIED PAGE ────────────────────
   *
   * FOUND IN A REAL RUN (the kanban repro): the deliverable `index.html` opened
   * from disk as a header above a completely EMPTY <main>, and the CLI printed
   * `✔ VERIFIED` — truthfully, about `node --test test/board.test.mjs`, which
   * never touched the HTML. The verdict was correct and about the wrong thing,
   * and the summary said nothing to reveal the gap.
   *
   * Two facts are recorded here, both cheap and both about the DELIVERABLE
   * rather than the command:
   *
   *   · `page`      — an .html this session wrote
   *   · `looked`    — whether anything actually rendered it (`see_page`) or a
   *                   command named it
   *   · `fileUnsafe`— its scripts cannot run from `file://` at all: a module
   *                   script with a relative URL is blocked by CORS from an
   *                   `origin: null` document, which is precisely why that page
   *                   was blank. That is not a style opinion, it is the reason
   *                   the deliverable does nothing when double-clicked.
   */
  const seenPages = new Set(
    executed
      .filter((e) => e.name === 'see_page' && e.result?.ok === true)
      .map((e) => String(e.args?.path ?? e.args?.file ?? '')),
  );
  const unopenedPages = writtenPaths
    .filter((p) => /\.html?$/i.test(p))
    .filter((p) => !seenPages.has(p) && ![...seenPages].some((s) => s.endsWith(p.split('/').pop())))
    .filter((p) => !runs.some((r) => r.command.includes(p.split('/').pop())))
    .map((p) => {
      const body = executor.readFile(p);
      const html = body.ok ? String(body.content ?? body.text ?? '') : '';
      const moduleScript = /<script[^>]*type\s*=\s*["']module["']/i.test(html);
      const relativeRef = /<script[^>]*\bsrc\s*=\s*["'](?!https?:|\/\/|data:)/i.test(html)
        || /\bfrom\s*["']\.{1,2}\//.test(html)
        || /\bimport\s*["']\.{1,2}\//.test(html);
      return { path: p, fileUnsafe: moduleScript && relativeRef };
    });

  /**
   * ── ⭐⭐ SEEING IS EVIDENCE. THE VERDICT ONLY KNEW ABOUT COMMANDS ───────────
   *
   * Observed live: a session rendered `index.html`, read a real 1.05:1 contrast
   * failure, fixed it, re-rendered clean — and the summary said
   * `⚠ NOTHING WAS RUN, so nothing here is verified`. Every word of that was
   * true and the conclusion was wrong.
   *
   * ⚠️ AND IT IS WRONG IN THE DIRECTION THAT MATTERS MOST TO US. There is often
   * no sensible `run_command` for a static page — the deliverable this CLI is
   * best at — so the verdict was structurally incapable of verifying the one
   * capability no competitor has. A tool that cannot report its own best work
   * teaches the user that its best work is unreliable.
   *
   * ⭐ LAST LOOK PER PAGE WINS, for the same reason `latestPerCommand` exists:
   * the point of the loop is that an earlier bad render is SUPPOSED to be
   * superseded. Holding a fixed page against its first photograph would make
   * the fix invisible.
   */
  const lastLookPerPage = new Map();
  for (const e of executed) {
    if (e.name !== 'see_page' || e.result?.ok !== true) continue;
    const p = e.result.path ?? String(e.args?.path ?? '');
    if (!p) continue;
    lastLookPerPage.set(p, {
      path: p,
      findings: Array.isArray(e.result.findings) ? e.result.findings : [],
      screenshot: e.result.screenshot ?? null,
    });
  }
  const observedPages = [...lastLookPerPage.values()];

  /**
   * ⚠️ THE ONE FACT THE SUMMARY IS NOT ALLOWED TO GET WRONG. `passed` comes from
   * an exit code this process observed, never from the model's prose and never
   * from "no errors were reported". `ran: false` is a THIRD state — not success
   * — because nothing having been checked is different from something having
   * been checked and worked.
   */
  /**
   * ── ⚠️⚠️ A LATER GREEN RUN NO LONGER ERASES AN EARLIER RED ONE ─────────────
   *
   * FOUND BY RUNNING IT, 2026-08-10, with a stubbed model so it is deterministic
   * (scratchpad repro A and B). `runs` is ONE FLAT SESSION-WIDE ARRAY, and the
   * verdict sampled exactly one element of it — the last. So:
   *
   *     $ node fail.js   → exit 1
   *     $ node pass.js   → exit 0
   *     ✔ VERIFIED — `node pass.js` exited 0 (after 2 attempts).
   *
   * The failing suite was not deprioritised, it was never read again — and the
   * process exited 0, so `acuvo … && git push` would push it. Across rounds it
   * is worse, because the two commands can be the test suite and a throwaway
   * one-liner the model wrote to reassure itself.
   *
   * ⭐ SO THE VERDICT REDUCES, KEYED BY COMMAND. Each distinct command keeps its
   * LATEST result — a genuine red → fix → green on the SAME command still clears,
   * which is the normal fix loop and must not be punished — and the session
   * passes only when every distinct command's latest result passed.
   *
   * ⚠️ AND THE BANNER NAMES WHAT IS BROKEN, NOT WHAT WAS TRIED LAST. The subject
   * of a failing verdict is the FIRST still-failing command; the last run is the
   * subject only when nothing is failing. Reporting `node pass.js` as the thing
   * that "still exits 1" would be a third wrong answer.
   *
   * `attempts` counts THAT command's own runs. It used to be `runs.length`, the
   * session-wide total, which printed "after 2 attempts" for a command attempted
   * once — a small lie in the same sentence as the verdict.
   */
  const attemptsOf = (command) => runs.filter((r) => r.command === command).length;
  /**
   * ⚠️ REBUILT, NOT REUSED. The map above was built to decide WHAT to re-run;
   * the re-runs then appended to `runs`. Reading the pre-re-run map here made a
   * command that had just been re-measured GREEN still report its old exit 1 —
   * caught in repro G, which is the exact staleness the re-run exists to fix.
   */
  const latestPerCommand = new Map();
  for (const r of runs) latestPerCommand.set(r.command, r);
  const latest = [...latestPerCommand.values()];
  const stillFailing = latest.filter((r) => r.passed !== true);
  const last = runs[runs.length - 1] ?? null;
  const subject = stillFailing[0] ?? last;

  /**
   * ── ⚠️⭐ EXIT 0 IS NOT EVIDENCE THAT ANYTHING HAPPENED ─────────────────────
   *
   * An inert program exits 0 too. Measured (repro C): a module with no
   * entrypoint, `node todo.mjs help` → exit 0, zero bytes of output, and the CLI
   * printed `✔ VERIFIED`. Nothing in the chain checks that the run OBSERVED
   * anything; `passed` means "exit 0 and not killed" and nothing more.
   *
   * ⭐ SO A FOURTH STATE, NOT A FLIPPED PASS. `silent` is true only when the
   * WHOLE SESSION printed nothing — not merely the winning run — and no command
   * was one of the checkers that pass silently BY DESIGN (`tsc --noEmit`,
   * `node --check`, a linter). Failing those runs would be lying in the
   * pessimistic direction, which this file already documents as its own class of
   * bug; and a zero-bytes heuristic applied per-run would false-fail every one
   * of them. The narrow rule catches the inert case and nothing else.
   *
   * ⚠️ `sessionFailed` deliberately stays FALSE for it: nothing failed. What
   * changes is that the summary stops claiming verification it does not have.
   */
  const spoke = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().length > 0;
  const silentByDesign = /(^|\s)(tsc|eslint|prettier|biome|stylelint|ruff|mypy|gofmt)(\s|$)|--noEmit|--check(\s|$)/;
  const silent = runs.length > 0
    && stillFailing.length === 0
    && !runs.some(spoke)
    && !runs.some((r) => silentByDesign.test(r.command));

  const verification = {
    ran: runs.length > 0,
    passed: runs.length > 0 ? stillFailing.length === 0 : null,
    command: subject?.command ?? null,
    exitCode: subject?.exitCode ?? null,
    timedOut: subject?.timedOut ?? false,
    attempts: subject ? attemptsOf(subject.command) : 0,
    // How many DISTINCT commands are still red, so the summary can say "and 2
    // others" instead of naming one and hiding the rest.
    failingCommands: stillFailing.map((r) => r.command),
    silent,
  };

  /**
   * ── ⭐ THE CACHE READING, ATTACHED ONCE ─────────────────────────────────────
   *
   * ⚠️ ANNOTATED HERE RATHER THAN AT THE THREE `rounds.push` SITES. Three copies
   * of one derivation is precisely how this file's summary came to print the
   * truth once and a lie once, and the third push site (the mid-loop model
   * error) is the one that would have been forgotten — it is also the one where
   * a provider that billed and then failed is most worth accounting for.
   */
  for (const r of rounds) r.cache = readCacheUsage(r.usage);

  const usage = aggregateUsage(rounds);

  /**
   * ── ⚠️⚠️ AND NOW THE OTHER QUESTION: WAS IT THE THING YOU ASKED FOR? ───────
   *
   * `verification` above is complete and it is not the verdict a user wants. It
   * is computed from whatever the model happened to run last; this is computed
   * from what the USER named, before the work. See `resolveAcceptance` for why
   * only an explicitly declared criterion is allowed to change the exit code.
   *
   * ⚠️ `verification` IS NOT TOUCHED HERE, deliberately. Two verdicts about two
   * different questions, side by side, is the honest shape; folding one into the
   * other is how `✔ VERIFIED` came to mean two things at once in the first place.
   */
  /**
   * ⚠️ THE SWEEP IS SHOWN THE COMMANDS `check_acceptance` RAN, and without this
   * line it declared them unrun and ran them a second time. `evaluateAcceptance`
   * counts `run_command` and `run_program` records — deliberately, so a model
   * cannot satisfy a criterion by asserting one — and a `check_acceptance`
   * record is neither. The commands INSIDE it were real spawns through the one
   * audited gate, so they are handed over in the shape that function counts.
   *
   * ⭐ SYNTHESISED HERE, NOT IN `executed`. `executed` is what the model called;
   * this list is what was run. Keeping them separate is what stops `--json
   * .refusals` and the "N files written" line from reporting phantom tool calls,
   * and it is the same split `resolveAcceptance` already uses internally for the
   * criteria it runs itself.
   */
  /**
   * ── ⚠️⚠️ A NAME COLLISION FOUND AT INTEGRATION, AND IT IS WHY `run_program`
   *        RECORDS ARE TRANSLATED RATHER THAN PASSED THROUGH ─────────────────
   *
   * `acceptance.mjs` already lists `run_program` in `SATISFYING_TOOLS`, and its
   * own comment says why: *"the browser client names its executor's verb that"*.
   * Its test builds one as `{name:'run_program', result:{command:'npm test'}}`.
   * The CLI's `run_program` — `spawn-argv.mjs`, wired here — is a DIFFERENT verb
   * that happens to share the name: it returns `argv: ['npm','test']` and has no
   * `command` field at all, because having no string to re-parse is the entire
   * reason it exists.
   *
   * `recordCommand` therefore returns null for our records and skips them. That
   * fails in the SAFE direction — a criterion the agent really did satisfy gets
   * re-run once by the sweep rather than being falsely called met — but it is
   * still wrong, and the visible symptom is `npm test` running twice.
   *
   * ⭐ FIXED ON THIS SIDE, NOT IN `acceptance.mjs`. That module is finished and
   * tested against the browser shape, and teaching it a second one would make it
   * responsible for a translation it cannot see the other half of. The pattern
   * is already here for exactly this reason (`checkedRecords`, below): what
   * really ran is handed over in the shape the judge counts, and it is kept out
   * of `executed` so no phantom tool call reaches `--json` or the file count.
   */
  const programRecords = runs
    .filter((r) => r.tool === 'run_program')
    .map((r) => ({ name: 'run_command', args: { command: r.command }, result: { ok: true, command: r.command, exitCode: r.exitCode } }));
  const checkedRecords = runs
    .filter((r) => r.tool === 'check_acceptance')
    .map((r) => ({ name: 'run_command', args: { command: r.command }, result: { ok: true, command: r.command, exitCode: r.exitCode } }))
    .concat(programRecords);
  const acceptance = await resolveAcceptance({
    acceptanceAsk: mcpAsk,
    task,
    executor,
    executed: checkedRecords.length > 0 ? [...executed, ...checkedRecords] : executed,
    allowRun,
    commandTimeoutMs,
    // An acceptance criterion is a COMMAND the user declared. If this run has a
    // shell, the criterion has to be able to use it, or `npm test | tee log`
    // would be declarable and permanently unrunnable.
    shell,
    onEvent,
  });

  /**
   * ⚠️ SERVERS KILLED BEFORE WE RETURN, ON EVERY PATH THAT REACHES HERE. An MCP
   * server is a child process; leaving them running is how a machine ends up
   * with dozens of orphans and a hot fan — which happened on this laptop today
   * from exactly this class of mistake (background servers nobody shut down).
   *
   * ⭐ Also covered by the process-lifetime hooks (exit AND the signals), because
   * the early-return paths above do not pass through here — and because a
   * Ctrl-C mid-round never reaches any return statement at all.
   */
  releaseMcp();

  return {
    ok: true,
    stage: 'done',
    /**
     * ⚠️ `model` IS THE REQUESTED ONE AND STAYS THAT WAY. Scripts read it, and
     * "which model did I ask for" is a real question. What was missing is the
     * OTHER one, and its absence was a compliance defect rather than a cosmetic
     * gap: `chain.mjs` fails over across up to four providers, so the run that
     * answered is routinely not the run that was asked for, and every audit
     * record this package wrote shipped `"model":{"answered":null}` — a buyer
     * asking "which model saw our source code on the fourteenth" got no answer.
     *
     * ⭐ `answeredModel` IS THE LAST CANDIDATE THAT ACTUALLY REPLIED. Each round
     * also carries its own `model`, so a session that failed over mid-way keeps
     * the full chain rather than flattening to one name — `audit.mjs`'s
     * `answeringModels` reads the per-round field first and this one as the
     * fallback, which is exactly the shape it documented and waited for.
     *
     * ⚠️ NEVER GUESSED. If no round reports one it stays null, because a script
     * can test for null and cannot test for "this name is our best assumption".
     */
    model: config.model,
    answeredModel: [...rounds].reverse().find((r) => typeof r?.model === 'string' && r.model)?.model ?? null,
    note: lastNote,
    /**
     * ⭐ ONE RENDER PATH. True only when every character of `note` was already
     * emitted as `stream` events, so the summary can leave it out instead of
     * printing the same paragraph the terminal finished four lines ago. False
     * whenever that cannot be proved — including every run with a discarding
     * `onEvent` — because a dropped note is a worse failure than a repeated one.
     */
    noteAlreadyShown: lastNoteAlreadyShown,
    finishReason: lastFinishReason,
    usage,
    /**
     * ⭐ The number that explains a collapsed cache hit rate. Always present and
     * `0` on the overwhelming majority of runs — unlike `budget`, this is a
     * count of something that either happened or did not, and a script reading
     * `compactions === 0` is reading a fact, not a default.
     */
    compactions,
    executed,
    rounds,
    roundsUsed: rounds.length,
    maxRounds,
    allowRun,
    stoppedBecause,
    /**
     * ── ⭐ THE LEDGER, AND ONLY WHEN A CEILING WAS ASKED FOR ─────────────────
     *
     * ⚠️ ABSENT, NOT ZERO, ON A RUN WITH NO `--budget`. `report()` would happily
     * print "no limit set" for every run this tool has ever done, which is a new
     * line of noise in every summary to say nothing. And a `budget` key that is
     * always present teaches a script to read a ceiling that was never set.
     *
     * ⚠️ `spentUsd` HERE IS THE GOVERNOR'S FIGURE, NOT `usage.cost`. They agree
     * when every round reported a price and they deliberately DIVERGE when one
     * did not: `usage` sums what the provider stated, the governor additionally
     * charges the rounds that stated nothing. `estimated` says which happened.
     */
    ...(budgetUsd === null ? {} : { budget: budget.toJSON(), budgetReport: budget.report() }),
    verification,
    /**
     * ⭐ null WHEN NOBODY NAMED A CRITERION, which is most runs. An always-
     * present object with `verdict: 'none-declared'` would put a line in the
     * summary for every run that never asked for one, and a verdict printed
     * where there is no criterion is exactly the noise that trains people to
     * skim the block that matters.
     */
    acceptance,
    promisedButMissing,
    unopenedPages,
    observedPages,
    /**
     * ⭐ The conversation, so an interactive session can hand it straight back
     * as `priorMessages`. Returned rather than held in module state: the caller
     * owns the session, which keeps `runSession` a pure-ish function of its
     * inputs and makes a multi-turn conversation testable without a terminal.
     */
    messages,
  };
}

/**
 * ── ⭐⭐ THE CACHE READING — THE ONE NUMBER THAT DECIDES THE MARGIN ──────────
 *
 * MEASURED against the live API: DeepSeek caches prompt prefixes automatically
 * and a HIT costs about 50× less than a miss ($0.014/M vs the normal rate).
 * Three identical calls, same prompt:
 *
 *   call 1  prompt=3616 cached=0     $0.000512
 *   call 2  prompt=3616 cached=0     $0.000508
 *   call 3  prompt=3616 cached=3072  $0.000168   ← 3.05× cheaper
 *
 * ⚠️ THE DEFECT THIS FIXES: the provider returns that per call and `runSession`
 * already stored the whole `usage` object on every round — and `aggregateUsage`
 * read exactly two keys off it. WE RECEIVED THE NUMBER AND THREW IT AWAY, which
 * is why nobody could tell a 10% hit rate from a 90% one.
 *
 * ⚠️⚠️ ABSENT IS UNKNOWN, NEVER ZERO. Not every provider reports this, and
 * rendering silence as "0% cached" is a wrong answer that looks right — it would
 * send someone hunting a cache problem that does not exist, or worse, hide a
 * real one behind a number they learned to ignore. `null` means unknown; a
 * reported `0` means a genuine miss and is shown as such.
 *
 * ⚠️ THE ANTHROPIC SHAPE IS NOT THE OPENAI SHAPE, and getting it wrong produces
 * a hit rate over 100%. OpenAI/OpenRouter/DeepSeek report `prompt_tokens` as the
 * TOTAL and break the cached part out underneath it; Anthropic reports
 * `input_tokens` as the UNCACHED REMAINDER, with the cache read and cache write
 * as separate siblings that must be added back to get the total.
 *
 * @param {any} usage
 * @returns {{ promptTokens: number | null, cachedTokens: number | null }}
 */
export function readCacheUsage(usage) {
  const unknown = { promptTokens: null, cachedTokens: null };
  if (!usage || typeof usage !== 'object') return unknown;

  /** A count is only a count if it is a finite, non-negative number. */
  const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

  const details = usage.prompt_tokens_details ?? usage.promptTokensDetails ?? null;
  const cacheRead = count(usage.cache_read_input_tokens);

  let cachedTokens = null;
  for (const candidate of [
    details && typeof details === 'object' ? (details.cached_tokens ?? details.cachedTokens) : undefined,
    usage.cached_tokens,
    usage.cachedTokens,
    usage.cache_read_input_tokens,
  ]) {
    if (candidate === undefined || candidate === null) continue;
    cachedTokens = count(candidate);
    // ⚠️ A PRESENT-BUT-NONSENSE FIELD IS NOT A REASON TO LOOK AT THE NEXT ONE.
    // A provider that sent `-5` is telling us its accounting is broken; falling
    // through to another key would paper over that with a plausible number.
    break;
  }

  let promptTokens = count(usage.prompt_tokens ?? usage.promptTokens);
  if (promptTokens === null) {
    /**
     * The Anthropic reconstruction. Only reached when there is no `prompt_tokens`
     * at all, so it can never override a provider that stated the total itself.
     */
    const input = count(usage.input_tokens ?? usage.inputTokens);
    if (input !== null) {
      const created = count(usage.cache_creation_input_tokens) ?? 0;
      promptTokens = input + (cacheRead ?? 0) + created;
    }
  }

  if (promptTokens === null && cachedTokens === null) return unknown;
  return { promptTokens, cachedTokens };
}

/**
 * ── ⭐ THE SESSION'S CACHE LEDGER ───────────────────────────────────────────
 *
 * ⚠️ A ROUND COUNTS ONLY WHEN BOTH HALVES ARE KNOWN. A round that reports its
 * prompt size but not its cached size is UNKNOWN, not "0 cached" — folding its
 * prompt tokens into the denominator would manufacture a low hit rate out of a
 * provider's silence, which is the same lie as printing "0% cached" for a
 * provider that says nothing at all. Those rounds are counted and disclosed
 * instead, so the reader can see the figure is partial.
 *
 * Returns null when NO round reported, so the summary stays quiet.
 */
function aggregateCache(rounds) {
  let promptTokens = 0;
  let cachedTokens = 0;
  let roundsReported = 0;
  let roundsUnknown = 0;
  for (const r of rounds) {
    const c = r.cache ?? readCacheUsage(r.usage);
    if (c.promptTokens === null || c.cachedTokens === null) { roundsUnknown += 1; continue; }
    roundsReported += 1;
    promptTokens += c.promptTokens;
    cachedTokens += c.cachedTokens;
  }
  if (roundsReported === 0) return null;
  return {
    promptTokens,
    cachedTokens,
    uncachedTokens: promptTokens - cachedTokens,
    // ⚠️ null rather than NaN or 0 when the denominator is zero — a rate with no
    // prompt behind it is not a measurement.
    hitRate: promptTokens > 0 ? cachedTokens / promptTokens : null,
    roundsReported,
    roundsUnknown,
  };
}

/** Sum what the rounds cost. Returns null when the provider reported nothing,
 *  so the summary prints no cost line rather than a confident `$0.000000`. */
function aggregateUsage(rounds) {
  let cost = 0;
  let tokens = 0;
  let seen = false;
  for (const r of rounds) {
    if (!r.usage) continue;
    seen = true;
    if (typeof r.usage.cost === 'number') cost += r.usage.cost;
    if (typeof r.usage.total_tokens === 'number') tokens += r.usage.total_tokens;
  }
  /**
   * ⚠️ ADDITIVE, AND `null` WHEN UNKNOWN. `cache` sits alongside the two figures
   * that were already here rather than replacing them, so `report.mjs`'s
   * `costUsd`/`tokens` and every audit record keep reading exactly what they
   * read yesterday. When no round reported a cached-token count this is `null`,
   * never a zeroed object — see `aggregateCache`.
   */
  return seen ? { cost, total_tokens: tokens, cache: aggregateCache(rounds) } : null;
}

/**
 * The original single-shot turn, unchanged in behaviour and now expressed as
 * the one-round case of the session.
 *
 * ⚠️ KEPT AS A NAME, NOT AS A SECOND IMPLEMENTATION. `--max-rounds 1` is a real
 * setting people will want (one completion, knowable cost, nothing executed),
 * and it must be the same code path as the loop or it becomes the untested one.
 */
export async function runTurn({ toolNames = SINGLE_SHOT_TOOL_NAMES, ...rest }) {
  return runSession({ ...rest, maxRounds: 1, allowRun: false, toolNames });
}

/**
 * ── ⭐⭐ THE MARGIN, ON THE LINE NEXT TO THE PRICE ──────────────────────────
 *
 * A cache HIT costs about 50× less than a miss — measured, three identical
 * calls, $0.000512 → $0.000168 once the prefix cached. The provider tells us the
 * split on every single call and this tool used to discard it, so the one number
 * that decides whether the product is profitable was invisible to everyone
 * including its authors.
 *
 * ⚠️ SILENT WHEN UNKNOWN. `cache` is null unless a round actually reported, and
 * "0% cached" for a provider that never mentioned caching is a wrong answer that
 * looks right. A reported zero, by contrast, IS printed — that is the expensive
 * case and the one worth seeing.
 */
function cacheClause(cache) {
  if (!cache || cache.hitRate === null) return '';
  const pct = Math.round(cache.hitRate * 100);
  // ⚠️ Disclosed, not averaged away: a partial figure that does not say it is
  // partial is how a 30%-sampled hit rate gets quoted as the real one.
  const partial = cache.roundsUnknown > 0
    ? `; ${cache.roundsUnknown} round${cache.roundsUnknown === 1 ? '' : 's'} unreported`
    : '';
  return ` · cache ${pct}% (${cache.cachedTokens} of ${cache.promptTokens} prompt tokens${partial})`;
}

/**
 * ⭐ AND WHEN THE RATE HAS COLLAPSED, NAME THE CAUSE WE MEASURED.
 *
 * ⚠️ ONLY WHEN COMPACTION ACTUALLY RAN THIS SESSION. A low hit rate on a short
 * run is normal — nothing has been sent twice yet — and warning about it would
 * teach people to skim the line. The pairing of "the transcript was rewritten"
 * with "almost nothing hit the cache" is the one that is actionable, because it
 * is a trade the runner made on the user's behalf.
 */
function cacheWarning(outcome) {
  const cache = outcome.usage?.cache;
  const n = outcome.compactions ?? 0;
  if (!cache || cache.hitRate === null || n === 0 || cache.hitRate >= 0.25) return [];
  return [
    `  ⚠ the transcript was compacted ${n}×, which rewrites earlier messages and voids the prompt-prefix`,
    '    cache from the first rewritten message onward. A miss costs roughly 50× a hit — a smaller task,',
    '    or fewer rounds, keeps the prefix intact.',
  ];
}

/**
 * The summary. Pure — takes the outcome, returns the lines to print.
 *
 * ⚠️ IT REPORTS WHAT HAPPENED TO DISK, NOT WHAT THE MODEL SAID IT DID. Those are
 * different facts, and only the first one is true: a refused path, an oversized
 * write and a `..` in a filename all produce a confident sentence from the model
 * and no file on disk. The counted lines below come from the executor's return
 * values, which is the only place that knows.
 */
export function formatSummary(outcome) {
  const lines = [];

  if (!outcome.ok) {
    lines.push('');
    lines.push(`✖ ${outcome.error}`);
    return lines;
  }

  /**
   * ── ⭐ PRINTED ONCE, NOT TWICE ──────────────────────────────────────────────
   *
   * ⚠️ MEASURED, real run, stdout only: this paragraph appeared TWICE — once
   * streamed live mid-round, once here — and the live copy was cut mid-word, so
   * the repeat read as a malfunction rather than as a report. `noteAlreadyShown`
   * is set only when the terminal received every character; anything less (a
   * truncated preview, a discarding `onEvent`, a non-streaming provider) leaves
   * it false and the note prints here exactly as it always has.
   */
  if (outcome.note && outcome.noteAlreadyShown !== true) {
    lines.push('');
    lines.push(outcome.note.trim());
  }

  /**
   * ⚠️ FILTERED ON `mutated`, NOT ON THE TOOL NAME. This read
   * `e.name === 'write_file'`, so the moment a SECOND writing tool existed the
   * summary went blind to it: `edit_file` changed a real file on disk and the
   * run printed **"No files changed."** — the exact class of quiet dishonesty
   * this summary exists to prevent, and it appeared the same hour the tool did.
   * `generate_image` had the same hole.
   *
   * `mutated` is the flag every tool already sets to mean "this touched the
   * disk", so filtering on it covers whatever gets added next without anyone
   * remembering to come back here.
   */
  const writes = outcome.executed.filter((e) => e.mutated === true || e.name === 'write_file');
  const reads = outcome.executed.filter((e) => e.name === 'read_file' || e.name === 'list_dir');
  const failures = outcome.executed.filter((e) => e.result?.ok !== true);
  const applied = writes.filter((e) => e.result?.ok === true);

  // ⚠️ A DRY RUN MUST NOT SAY "WRITTEN". Measured on the first dry run: the
  // summary read "1 file written" while the disk was untouched — which is the
  // one sentence a preview is not allowed to print, because it is the sentence
  // someone acts on.
  const dry = applied.some((e) => e.result.dryRun === true);
  lines.push('');
  if (applied.length === 0) {
    lines.push('No files changed.');
  } else {
    lines.push(dry
      ? `${applied.length} file${applied.length === 1 ? '' : 's'} WOULD be written (dry run — nothing was):`
      : `${applied.length} file${applied.length === 1 ? '' : 's'} ${applied.some((w) => w.name === 'delete_file') ? 'changed' : 'written'}:`);
    /**
     * ⚠️⚠️ ONE RENDERER, NOT TWO. This block used to hand-roll the same lines
     * `report.mjs` produces, and it drifted every single time a new mutating
     * tool arrived: `delete_file` printed "replaced check.mjs (75 bytes, was
     * undefined)" — the opposite of what happened — and then `see_page` printed
     * "replaced index.html (undefined bytes, was undefined)", claiming the agent
     * had blanked a file it had only photographed. Both were fixed in
     * `describeChange`, and both survived HERE, because a second copy of a fact
     * does not get fixed when the first one does.
     *
     * ⭐ The bottom-of-run summary already used `formatChanges`, so the same run
     * printed the truth once and a lie once. Delegating removes the class.
     */
    lines.push(...formatChanges(applied.map(describeChange)));
  }

  if (failures.length > 0) {
    lines.push('');
    lines.push(`${failures.length} tool call${failures.length === 1 ? '' : 's'} refused:`);
    for (const f of failures) {
      const target = f.args?.path ? ` ${JSON.stringify(f.args.path)}` : '';
      lines.push(`  ${f.name}${target}: ${f.result?.error}`);
    }
  }

  /**
   * ── ⚠️ THE VERDICT. THE ONE BLOCK THAT IS NOT ALLOWED TO FLATTER ──────────
   * Three states, and the middle one is the whole reason this feature is worth
   * having: ran-and-passed, ran-and-failed, and NEVER RAN. Collapsing the third
   * into the first is what makes an agent that "ships working code" a liar, and
   * it is the easiest mistake in the file to make by accident.
   */
  /**
   * ── ⚠️⚠️ THE TICK IS NOT ALLOWED TO STAND ALONE WHEN IT IS ABOUT THE WRONG
   * COMMAND ─────────────────────────────────────────────────────────────────
   * Probe 1 run 1: `✔ VERIFIED — node --test test/api.test.js exited 0`, every
   * word true, and the user had said "It MUST pass: npm test" — whose script ran
   * ZERO tests. The tick is still printed, because it is still a fact; what
   * changes is that it can no longer be read as an answer to the question the
   * user asked.
   */
  const acceptanceMissed = outcome.acceptance
    && (outcome.acceptance.verdict?.verdict === 'unmet' || outcome.acceptance.verdict?.verdict === 'not-run');

  const v = outcome.verification;
  if (v) {
    lines.push('');
    if (v.passed === true && v.silent === true) {
      /**
       * ⚠️ THE FOURTH STATE. Every command exited 0 and NOTHING PRINTED A BYTE,
       * which is exactly what an inert program does — a module with no
       * entrypoint, a test file that asserts a function is a function. Claiming
       * verification here is the failure mode `acuvo && git push` acts on.
       * Silent-by-design checkers (`tsc --noEmit`, `node --check`, linters) are
       * excluded upstream, so this line only appears when nothing was observed.
       */
      lines.push(`⚠ RAN, BUT PROVED NOTHING — \`${v.command}\` exited 0 and printed nothing.`);
      lines.push('  An inert program does that too. Nothing this session ran produced any output,');
      lines.push('  so no behaviour was observed — run it the way a user would before trusting it.');
    } else if (v.passed === true) {
      lines.push(`✔ VERIFIED — \`${v.command}\` exited 0${v.attempts > 1 ? ` (after ${v.attempts} attempts)` : ''}.`);
      if (acceptanceMissed) {
        lines.push('  ⚠ …but that is not what was asked for. See the acceptance line below —');
        lines.push('    a command that exits 0 is only evidence about that command.');
      }
    } else if (v.ran) {
      lines.push(v.timedOut
        ? `✖ NOT VERIFIED — \`${v.command}\` timed out and was killed.`
        : `✖ NOT VERIFIED — \`${v.command}\` still exits ${v.exitCode} after ${v.attempts} attempt${v.attempts === 1 ? '' : 's'}.`);
      /**
       * ⚠️ A LATER GREEN RUN DOES NOT CLEAR AN EARLIER RED ONE, and the summary
       * has to say so out loud — otherwise someone reads "still exits 1" next to
       * a command they watched pass and assumes the CLI is confused.
       */
      const others = (v.failingCommands ?? []).filter((c) => c !== v.command);
      if (others.length > 0) {
        lines.push(`  ${others.length} other command${others.length === 1 ? '' : 's'} also still failing: ${others.map((c) => `\`${c}\``).join(', ')}`);
      }
      if (outcome.stoppedBecause === 'round-cap') {
        lines.push(`  The ${outcome.maxRounds}-round budget ran out with it still failing. Re-run with --max-rounds higher, or fix it yourself.`);
      } else if (BUDGET_STOP_REASONS.has(outcome.stoppedBecause)) {
        /**
         * ⚠️ NAME THE WALL THAT WAS ACTUALLY HIT. Falling through to "the model
         * stopped before it got a passing run" would blame the model for a
         * decision this runner made about the user's money, and would send them
         * to raise --max-rounds, which is not the flag that would help.
         */
        lines.push(`  The spending ceiling stopped it with the code still failing. Re-run with --budget higher, or fix it yourself.`);
      } else if (outcome.stoppedBecause === 'stuck') {
        lines.push('  It was repeating itself and stopped rather than spend more on the same loop. Read the last failure and steer it.');
      } else {
        lines.push('  The model stopped before it got a passing run. Whatever it said above, the code does not pass.');
      }
    } else if ((outcome.observedPages ?? []).length > 0) {
      /**
       * ⚠️ A SEPARATE VERB, NOT A SECOND MEANING FOR `VERIFIED`. Looking at a
       * page proves it renders and that its text is legible; it proves nothing
       * about whether the code is correct. Reusing `✔ VERIFIED` here would make
       * the strongest word in the output mean two different things, and the
       * whole value of that word is that it means exactly one.
       */
      const dirty = outcome.observedPages.filter((p) => p.findings.length > 0);
      if (dirty.length === 0) {
        const names = outcome.observedPages.map((p) => `\`${p.path}\``).join(', ');
        lines.push(`👁 OBSERVED — ${names} rendered in a real browser with no problems measured.`);
        lines.push('  No command was run, so this says nothing about whether the code is correct.');
      } else {
        // ⚠️ Never suppressed by a clean sibling: one good page does not excuse a
        // broken one, and the model has already had its chance to fix this.
        for (const p of dirty) {
          lines.push(`✖ STILL BROKEN ON SCREEN — \`${p.path}\` renders with ${p.findings.length} measured problem${p.findings.length === 1 ? '' : 's'}:`);
          for (const f of p.findings.slice(0, 4)) lines.push(`    ${f}`);
        }
      }
    } else if (outcome.allowRun && (outcome.maxRounds ?? 1) > 1) {
      /**
       * ⚠️ IT NAMES THE CATEGORY, NOT ONE TOOL. This line used to end "the model
       * never called run_command", and by the time three separate verbs could
       * spawn a process (`run_command`, `evaluate`, `check_acceptance`) that was
       * a specific, checkable claim that could be false while the sentence
       * around it was true. A precise-sounding wrong detail is what teaches
       * people to stop reading the warning.
       */
      /**
       * ── ⚠️⚠️ AND THE SAME SENTENCE WAS STILL FALSE, ONE PATH LATER — FOUND
       *        BY RUNNING IT AT INTEGRATION, 2026-08-11 ─────────────────────
       *
       * MEASURED, verbatim, from a real run against a workspace with a declared
       * `npm test` criterion and no model tool calls:
       *
       *   ── acceptance ──
       *   `npm test` was declared as the criterion and nothing in this run
       *   satisfied it. Running it once (free — no model call).
       *   $ npm test        ✖ exit 1 · 2.2s
       *   …
       *   ⚠ NOTHING WAS RUN, so nothing here is verified — no command was
       *     executed this session.
       *   ✖ UNMET — you asked that `npm test` pass; it ran and exited 1
       *
       * Two lines apart, in the same block, the output says a command was not
       * executed and that it ran and exited 1. The comment above was written
       * because the sentence named ONE TOOL when three could spawn; the same
       * defect survived in the other half of it — the claim that nothing was
       * executed AT ALL, when the acceptance sweep spawns through the same
       * audited gate at the very end of the session.
       *
       * ⭐ THE VERDICT IS NOT TOUCHED, ONLY THE SENTENCE. Folding the sweep's
       * run into `verification` is the tempting fix and it is the wrong one: the
       * acceptance layer's pinned invariant is that it may only ever make the
       * verdict STRICTER, and a sweep-run that exits 0 would turn a
       * NOT-VERIFIED into a VERIFIED — a way to pass, dressed as honesty. So
       * `verification.ran` stays false (the MODEL proved nothing, which is true
       * and is the thing this line exists to say) and the sentence stops making
       * a claim about the process that is not.
       */
      const sweepRan = (outcome.acceptance?.verdict?.criteria ?? [])
        .some((c) => c?.ran === true);
      lines.push(sweepRan
        ? '⚠ NOTHING THE MODEL DID WAS VERIFIED — it ran no command itself. The only thing executed this session was the acceptance criterion below.'
        : '⚠ NOTHING WAS RUN, so nothing here is verified — no command was executed this session.');
    }
  }

  /**
   * ── ⭐⭐ THE ACCEPTANCE LINE — WHAT THE USER ACTUALLY ASKED FOR ────────────
   *
   * Printed only when a criterion exists, and it says WHERE the criterion came
   * from, because the two sources carry different weight and hiding that would
   * make the strict one look arbitrary and the loose one look binding.
   *
   * ⚠️ THE "does not change the exit code" NOTE IS NOT AN APOLOGY. A derived
   * criterion is this runner's reading of the user's prose; saying so is what
   * lets someone dismiss a false one without learning to dismiss all of them.
   */
  const a = outcome.acceptance;
  if (a?.verdict && a.verdict.verdict !== 'none-declared') {
    lines.push('');
    lines.push(formatVerdict(a.verdict));
    if (a.source === 'declared') {
      lines.push('  (declared with declare_acceptance — this decides the exit code.)');
    } else {
      lines.push('  (read from your own words. It does not change the exit code — declare it with');
      lines.push('   declare_acceptance if you want a failing criterion to fail the process.)');
    }
  }

  /**
   * ── ⚠️ THE VERDICT IS ABOUT A COMMAND. THE DELIVERABLE MAY BE A PAGE ──────
   * A green test suite says nothing about the index.html sitting next to it, and
   * a run that reports only the suite reads as a verdict on the whole session.
   * Naming the page keeps `✔ VERIFIED` honest about its own scope.
   */
  for (const page of outcome.unopenedPages ?? []) {
    lines.push('');
    if (page.fileUnsafe) {
      lines.push(`⚠ ${page.path} was never opened, and it CANNOT run from the filesystem:`);
      lines.push('  its module script loads a relative URL, which the browser blocks from a file:// page');
      lines.push('  (origin null). Double-clicked it renders blank. Serve it — e.g. `npx serve .` — to see it.');
    } else {
      lines.push(`⚠ ${page.path} was written but never rendered, so nothing here proves it displays anything.`);
    }
  }

  // The honest note about the single-shot design. Only worth saying when it
  // actually bit — a turn that read AND wrote used the reads for nothing, but a
  // turn that wrote is still a turn that worked.
  if ((outcome.maxRounds ?? 1) === 1 && applied.length === 0 && reads.some((r) => r.result?.ok === true)) {
    lines.push('');
    lines.push('The model spent the turn reading instead of writing. This CLI runs ONE round, so what it read');
    lines.push('cannot reach it — re-run with a more specific instruction, or name the file you want changed.');
  }

  if (outcome.promisedButMissing?.length > 0) {
    lines.push('');
    lines.push(`⚠ The reply named ${outcome.promisedButMissing.length} file${outcome.promisedButMissing.length === 1 ? '' : 's'} it did not write:`);
    for (const p of outcome.promisedButMissing) lines.push(`  ${p}`);
    lines.push('This model emits one write per response. Ask for them one at a time.');
  }

  /**
   * ⚠️ IT USED TO MISATTRIBUTE THIS. With the provider dead, the summary printed
   * "⚠ NOTHING WAS RUN, so nothing here is verified" — true, and it blames the
   * MODEL for not calling run_command when the truth is that nothing could be
   * called at all. A diagnosis that points at the wrong component costs the
   * reader the whole investigation.
   */
  if (outcome.stoppedBecause === 'model-error') {
    lines.push('');
    lines.push('✖ THE RUN DID NOT FINISH — the model provider stopped answering mid-run (every');
    lines.push('  provider in the chain was tried). Anything above was written before that');
    lines.push('  happened and may be half-done. This exits non-zero: do not chain a commit');
    lines.push('  or a push onto it. Re-run when the provider is back.');
  }

  if (outcome.finishReason === 'length') {
    lines.push('');
    lines.push('⚠ The reply hit the token ceiling and was cut off — a file may be incomplete. Re-run with --max-tokens higher.');
  }

  const cost = outcome.usage?.cost;
  if (typeof cost === 'number') {
    const tokens = outcome.usage?.total_tokens;
    const roundsPart = outcome.roundsUsed > 1 ? ` · ${outcome.roundsUsed} rounds` : '';
    lines.push('');
    lines.push(`${outcome.model}${roundsPart} · ${tokens ?? '?'} tokens · $${cost.toFixed(6)}${cacheClause(outcome.usage?.cache)}`);
    lines.push(...cacheWarning(outcome));
  }

  /**
   * ── ⭐ THE BUDGET LINE — THE THIRD SEAM, AND THE ONLY ONE THE USER SEES ────
   *
   * ⚠️ ONLY WHEN A CEILING WAS SET. `budgetReport` is absent otherwise (see the
   * return value), so a run with no `--budget` prints exactly what it printed
   * yesterday. The line is taken verbatim from `budget.mjs` rather than
   * re-assembled here — it already carries the "⚠ N of M rounds reported no
   * cost, so the total is an estimate" clause, and a second copy of that
   * arithmetic is how the two would disagree.
   */
  if (typeof outcome.budgetReport === 'string' && outcome.budgetReport) {
    lines.push('');
    lines.push(outcome.budgetReport);
  }

  return lines;
}

/**
 * The `stoppedBecause` values that mean "money", so the summary can say so
 * instead of blaming the model. Kept as a set rather than imported wholesale
 * from `BUDGET_REASONS`, because two of those five ('ok', 'no-budget-set') are
 * verdicts that never stop anything and would make the branch fire on a
 * perfectly healthy run.
 */
const BUDGET_STOP_REASONS = new Set(['too-small', 'would-exceed', 'limit-reached']);

/**
 * ⚠️ THE EXIT CODE IS THE MACHINE-READABLE VERSION OF THE VERDICT, and it has
 * to agree with it. A CLI that prints "✖ NOT VERIFIED" and exits 0 is worse
 * than one that prints nothing, because `acuvo … && git commit` would commit.
 *
 * Never-ran exits 0 deliberately: writing files without being asked to verify
 * them is the CLI's older, honest behaviour, and it is reported as unverified
 * rather than punished as a failure.
 */
/**
 * ── ⚠️⚠️ DID ANYTHING ACTUALLY HAPPEN? ──────────────────────────────────────
 *
 * Measured 2026-08-12, from a real Terminal-Bench artifact on disk:
 *
 *   {"ok":true, "rounds":2, "stoppedBecause":"no-tool-calls",
 *    "verification":{"ran":false}, "changes":[], "costUsd":0.003,
 *    "failed":false, "exitCode":0}          …and reward.txt = 0
 *
 * The agent quit after 2 of 16 rounds, wrote nothing, ran nothing, spent 3% of
 * its budget and **exited 0**. Every clause in `sessionFailed` below is a
 * statement about something that HAPPENED — a dead provider, a failing command,
 * an unmet criterion — and not one of them fires when nothing happened at all.
 * `acuvo … && git push` would have pushed nothing and called it success.
 *
 * ⭐ THE TEST IS EFFECT, NOT EFFORT. Rounds burned and dollars spent are not
 * evidence; a file written or a command run is. `mutated` is already set per
 * tool record by the dispatcher, so this needs no new bookkeeping.
 *
 * @param {any} outcome
 * @returns {boolean} true when the run produced no file change and ran nothing
 */
export function nothingHappened(outcome) {
  if (!outcome?.ok) return false;             // a failed run is already a failure
  const ranSomething = outcome.verification?.ran === true;
  const changedSomething = Array.isArray(outcome.executed)
    && outcome.executed.some((r) => r?.mutated === true);
  return !ranSomething && !changedSomething;
}

/**
 * @param {any} outcome
 * @param {{ strict?: boolean }} [options] `strict` opts into the nothing-happened
 *   verdict. ⚠️ OFF BY DEFAULT AND IT MUST STAY THAT WAY: "what does this file
 *   do?" legitimately writes nothing and runs nothing, and this repo has spent
 *   four days on checks that failed correct work. `best-of.mjs` and
 *   `escalate.mjs` call this as their definition of success and pass nothing,
 *   so their behaviour is unchanged by construction.
 */
export function sessionFailed(outcome, options = {}) {
  if (!outcome?.ok) return true;

  /**
   * ⚠️ FIRST, because it is the only clause about the run as a whole rather
   * than about something inside it — and because when it fires, every clause
   * below is vacuously fine and would otherwise report success.
   */
  if (options.strict === true && nothingHappened(outcome)) return true;

  /**
   * ── ⚠️⚠️ A PROVIDER OUTAGE IS A FAILED RUN, AND IT EXITED 0 FOR MONTHS ────
   *
   * `runSession`'s success path returns a LITERAL `ok: true`, and a model
   * failure after round 1 sets `stoppedBecause = 'model-error'` and breaks into
   * it. An outage is a returned value, not a throw — `model.mjs` returns
   * `{ok:false}` for any non-2xx, `chain.mjs` returns `{ok:false}` after
   * exhausting four providers — so the run lands here looking healthy.
   *
   * Measured (ENTERPRISE §3.5): a stub that writes a file in round 1 and returns
   * a chain-exhausted 429 in round 2 produced `ok:true`, `sessionFailed:false`,
   * **exit code 0**, a half-written file on disk, and `--json` reporting
   * `"error": null`. So `acuvo … && git commit && git push` PUSHED IT.
   *
   * ⚠️⚠️ AND THE WORSE CASE IS AN ACTIVE FALSE POSITIVE: if round 1 ran a
   * command that passed and the outage hit the extension round,
   * `verification.passed` is still `true` and the summary prints `✔ VERIFIED`
   * over a session that died with work outstanding. The verdict was true about
   * a command and wrong about the run.
   *
   * ⭐ THE EXIT CODE IS A VERDICT ON WHETHER THE TASK COMPLETED, not on whether
   * some command inside it passed. A run that stopped because the provider died
   * did not complete, whatever it managed first.
   */
  if (outcome.stoppedBecause === 'model-error') return true;

  /**
   * ── ⚠️⚠️ AND A RUN THAT RAN OUT OF MONEY DID NOT COMPLETE EITHER ───────────
   *
   * Exactly the sentence above with a different noun. A budget stop lands in the
   * SUCCESS path — `ok: true`, files on disk, nothing verified — so
   * `acuvo … && git push` pushed a half-written repo and called it a success.
   *
   * ⭐ THE CODEBASE ALREADY KNEW. `outOfRoad()` classifies these as hitting a
   * wall and the escalation ladder consumes it; only the PROCESS verdict was
   * left behind, and `escalate.test.mjs` said so out loud — "the process verdict
   * tolerates it — that is why the bug hid".
   *
   * ⚠️ IT BECAME EVERYONE'S PROBLEM ON 2026-08-12, when the $0.02 ceiling was
   * turned on by default. Before that you had to type `--budget` to reach it.
   * Turning a governor on without teaching the exit code about it is how a
   * safety feature becomes a silent-failure feature.
   *
   * ⚠️ NOT GATED BEHIND `--strict`. Strict is for the judgement call "nothing
   * happened, is that ok?". Being cut off mid-job by a limit is not a judgement
   * call — it is the same standing as a dead provider.
   *
   * ⚠️ `'too-small'` is deliberately absent: that is a PREFLIGHT refusal which
   * already returns `ok: false`, and listing it here would be dead code
   * pretending to be a guard.
   */
  if (outcome.stoppedBecause === 'would-exceed' || outcome.stoppedBecause === 'limit-reached') return true;
  const v = outcome.verification;
  if (v?.ran && v.passed !== true) return true;
  /**
   * ── ⚠️⚠️ A DECLARED CRITERION THAT DID NOT PASS FAILS THE PROCESS ─────────
   *
   * Measured, probe 4 run 2: the run exited 0 with `--json
   * {"verification":{"passed":true}}` having silently dropped the commit it was
   * asked for — so `acuvo … && git push` would have pushed it. `verification`
   * cannot catch that, because it is a true statement about a different command.
   *
   * ⚠️ ONLY `gating` CRITERIA, i.e. only ones somebody explicitly declared. A
   * criterion this runner guessed out of prose must never be able to fail a run
   * that did the right thing under a different name — that is the check-that-
   * fails-correct-work failure, and it has cost this repo four days.
   *
   * ⚠️ AND IT ONLY EVER ADDS A FAILURE. There is no branch here that can turn a
   * failing verdict into a passing one; the clause above returns first, and this
   * one only ever returns `true`.
   */
  const a = outcome.acceptance;
  if (a?.gating && (a.verdict?.verdict === 'unmet' || a.verdict?.verdict === 'not-run')) return true;
  return false;
}
