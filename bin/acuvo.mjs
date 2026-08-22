#!/usr/bin/env node
/**
 * ACUVO CODE — the terminal client.
 *
 * `node acuvo-code/bin/acuvo.mjs "add a healthcheck route"` in any directory.
 *
 * ── WHAT THIS FILE IS AND IS NOT ────────────────────────────────────────────
 * It is the CLIENT: argv in, exit code out, everything in between delegated.
 * The capability (the tools), the executor (the filesystem), the transport (the
 * model) and the report (the summary) each live in their own module, because
 * the second client — the web console — already exists and the whole
 * architecture is "one registry, two clients". A CLI that grew its own copy of
 * any of those would be the fork this was built to avoid.
 *
 * ⚠️ EXIT CODES ARE PART OF THE CONTRACT. A coding agent gets piped, chained and
 * put in a Makefile; `&&` has to mean something. 0 succeeded · 1 the model or
 * the tools failed · 2 not configured · 64 bad usage (the sysexits convention).
 *
 * ⚠️ AND SINCE THE LOOP LANDED, 1 ALSO MEANS "THE CODE IT WROTE STILL DOES NOT
 * PASS". That is the point of running anything: an agent that writes a failing
 * test suite and exits 0 has told the shell it succeeded, and `acuvo … && git
 * push` would believe it. See `sessionFailed`.
 */

import { resolve, join } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

/**
 * ⚠️ `planPhaseExecutor` IS THE SECOND LOCK ON `--plan`, and it comes from the
 * module that PRINTS the promise (`USAGE`) so the sentence and its enforcement
 * cannot drift apart — which is exactly what had happened. Measured 2026-08-20
 * through the real `runSession` with this file's own plan-phase options: a
 * `write_file` the model was never offered wrote a file to disk, an `edit_file`
 * changed a source file and a `delete_file` removed one, all during a phase
 * nobody had approved. See the block at the foot of lib/cli-args.mjs.
 */
import { parseArgv, USAGE, planPhaseExecutor } from '../lib/cli-args.mjs';
import { runChat } from '../lib/chat.mjs';
// ⭐ The providers behind `/skills` and `/mcp`. Both modules already existed and
// already worked; nothing at the interactive prompt could reach either.
/**
 * ⚠️⚠️ `discoverAllSkills`/`loadAnySkill`, NOT the project-only pair. Measured:
 * `/skills` reported **0** while the model saw **24**, and `/skills
 * nextjs-app-router` answered *"this project defines no skills … there is
 * nothing to read until someone writes one"* — a sentence that is simply false
 * about a CLI that ships 24 of them. Same product, two answers, and the wrong
 * one was the answer a human reads.
 */
import { discoverAllSkills, loadAnySkill } from '../lib/builtin-skills.mjs';
import { routingNote } from '../lib/warm-provider.mjs';
import { readMcpConfig } from '../lib/mcp.mjs';
import { readModelConfig, MISSING_KEY_MESSAGE } from '../lib/model.mjs';
import { executeRunCommand } from '../lib/command.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { runSession, formatSummary, renderEvent, sessionFailed } from '../lib/turn.mjs';
import { runPool, detectConflicts, formatParallelSummary, shortLabel } from '../lib/parallel.mjs';
import { detectRepo, findToken, fetchIssue, branchNameFor, issueToTask, createBranch, nextSteps } from '../lib/github.mjs';
// ⚠️ `formatChanges` is deliberately NOT imported: rendering the change list is
// `formatSummary`'s job, and importing it here is how the second copy came back.
import { describeChanges, shortenRoot, toJson } from '../lib/report.mjs';
import { renderImage } from '../lib/terminal-graphics.mjs';
import { saveSession, listSessions, resumeMessages, loadSession } from '../lib/session.mjs';
import { recordRun, parseAuditLog } from '../lib/audit.mjs';
import { runBestOf, formatBestOf } from '../lib/best-of.mjs';
import { escalate, formatEscalation, outOfRoad } from '../lib/escalate.mjs';
import { homedir } from 'node:os';
import { loadEnvFiles as envLoad } from '../lib/env-file.mjs';
import {
  loadPolicy, invocationDecision, roundBudget, costBudget, filterToolNames, mcpDecision,
  USER_POLICY_FILE, USER_POLICY_ENV, WORKSPACE_POLICY_FILE,
} from '../lib/policy.mjs';
/**
 * ⚠️ `bestOfAttemptBudget` LIVES IN lib/, NOT HERE, AND THAT IS NOT TIDINESS.
 * Importing this file EXECUTES the CLI — it has a top-level main that then waits
 * on stdin — so a test that imports a decision function declared here HANGS
 * FOREVER rather than failing. Measured: the first version of this change put it
 * in this file and the test never returned. Pure decisions belong where they can
 * be tested; that is what lib/ is for.
 */
import { createBudget, remainingForTurn, DEFAULT_BUDGET_USD, bestOfAttemptBudget } from '../lib/budget.mjs';
import { createFleetGate } from '../lib/fleet-budget.mjs';
import { FLEET_STOP_REASONS } from '../lib/budget.mjs';
import { refuteClaim, formatRefutation, refutationField } from '../lib/refute.mjs';
import { createAsker } from '../lib/prompt.mjs';
/**
 * ── ⭐⭐ THE PLAN GATE, AND THE TWO VERDICTS THAT WERE COMPUTED AND NEVER SHOWN
 *
 * `lib/plan-coherence.mjs` is wired into `lib/turn.mjs`, and that wiring reaches
 * the MODEL: the drift nudge is appended to the conversation and the
 * reconciliation is put in the result object. Measured 2026-08-20, it reached
 * nobody else — `renderEvent` has no case for the `plan-drift` event turn.mjs
 * emits, and `formatReconciliation` is imported by turn.mjs on line 64 and
 * called from nowhere. Two correct verdicts, invisible to the person paying.
 *
 * ⚠️ `toolNamesForRounds` IS IMPORTED HERE FOR ONE REASON ONLY: `--plan`'s
 * read-only offer is an INTERSECTION with what this machine actually offers,
 * never a fixed list. A hard-coded read list would offer `read_skill` in a
 * project with no skills and the four LSP verbs on a machine with no language
 * server — the dead buttons tools.mjs spends four hundred lines refusing.
 */
import { toolNamesForRounds } from '../lib/tools.mjs';
import {
  runPlanGate, planModeToolNames, planModeRounds, planPhaseTask,
  driftBannerLine, formatReconciliation,
} from '../lib/plan-coherence.mjs';
import { summariseSpend, readAuditFiles, formatSpend, parseSince } from '../lib/spend.mjs';
import { PLANS, formatPlan, allowanceRemaining, usageByModel } from '../lib/plan.mjs';
import { labelForModelId } from '../lib/acuvo-models.mjs';
/**
 * ⭐ CREATIVE ENGINE CHOICE. `listEngines` asks the gateway what this ACCOUNT
 * may reach and what each engine costs — this package holds no prices, on
 * purpose. `setRunEngine` records the engine the user named on the command
 * line so a render verb can read it later.
 */
import { listEngines, setRunEngine } from '../lib/creative-engines.mjs';

/**
 * ⭐ Decided once, at the top, because it is a property of how this process was
 * INVOKED and cannot change while it runs. `null` means stdin and stdout are
 * not both terminals — a pipe, a CI job, a task runner — in which case there is
 * nobody to ask and every consent gate must keep refusing exactly as it does
 * today. `createAsker` only reads `isTTY`, so this costs nothing at load.
 */
const asker = createAsker();

/**
 * ── ⭐⭐ THE FIVE CAPABILITIES THAT WERE BUILT AND REACHED BY NOTHING ────────
 *
 * Each of the modules below shipped finished, documented and tested — and
 * imported by no runtime path, which in this package is the same as not
 * shipping at all. 7,397 lines (39% of the package) were once in that state.
 *
 * ⚠️ AN IMPORT IS NOT THE DELIVERABLE EITHER. The deliverable is a command a
 * user can type: `--doctor`, `--replay`, `--design`, `--task-audio`, `--say`.
 * Every one of them is in `--help` for the same reason — a capability only the
 * changelog knows about is the identical orphan under a different name.
 *
 * ⚠️ COMPACTION IS DELIBERATELY ABSENT FROM THIS LIST. It is not a flag: it
 * belongs inside the loop, applied automatically as the history approaches the
 * budget, and it is wired in lib/turn.mjs. A user should not have to know the
 * word "compaction" to stop paying for a transcript they cannot see.
 */
import { runDoctor, formatDoctor } from '../lib/doctor.mjs';
/**
 * ── ⭐ SHELL COMPLETION — built, tested, and reachable from nothing until now ──
 * `lib/completion.mjs` is 509 lines that generate bash, zsh and fish scripts
 * from the real flag list, so the completions cannot drift from the CLI. It had
 * no entry point, which made it a capability nobody could use.
 */
import { completionScript, SUPPORTED_SHELLS } from '../lib/completion.mjs';
import {
  resolveConfig, explicitKeysFromArgv, applyConfigToOptions,
  WORKSPACE_CONFIG_FILE, HOME_CONFIG_FILE, ACUVO_HOME_ENV,
} from '../lib/rcfile.mjs';
import { replaySession, formatTimeline, diffRuns, formatDiff } from '../lib/replay.mjs';
import { designPass, formatDesignPass } from '../lib/design-loop.mjs';
import {
  extractVoiceFlags, taskFromAudio, confirmationLines, decideTranscript, speakSummary, VOICE_USAGE,
} from '../lib/voice-task.mjs';
import { createPainter, colourEnabled } from '../lib/colour.mjs';
/**
 * ── ⭐⭐ FILE LEASES — THE SIXTH CAPABILITY THAT WAS BUILT AND REACHED BY
 *        NOTHING ─────────────────────────────────────────────────────────────
 *
 * `lib/lease.mjs` (868 lines) shipped finished and was imported by its own test
 * and nothing else. The owner runs seven terminals against one checkout; without
 * this, two of them writing the same file is silent data loss that shows up as
 * "the agent undid my change".
 *
 * ⚠️ AND THE HONEST LIMIT, STATED HERE RATHER THAN IN A CHANGELOG: a coding
 * agent does not know which files it will write until it writes them, so
 * `--lease a.ts --lease b.ts` is a DECLARATION, not a guarantee. It protects
 * exactly the paths named. The complete fix is one `acquire()` call inside the
 * executor's write path (lib/workspace.mjs) — a different lane, and the module
 * is shaped for it (single-path acquire is cheap and re-entrant).
 */
import { acquireAll, renewAll, releaseAll, inspect, formatLeaseSummary, DEFAULT_TTL_MS } from '../lib/lease.mjs';
import { createPathClaimer } from '../lib/auto-lease.mjs';
import { boardAdd, boardList, boardClaim, boardDone, formatBoard } from '../lib/board.mjs';
import { loadRuns, pickRun, recheckClaim, formatRecheck, recheckAll, formatRecheckAll } from '../lib/verify-claim.mjs';
/**
 * ── ⭐⭐ CHECKPOINT / REWIND — THE UNDO THIS TOOL DID NOT HAVE ───────────────
 *
 * Measured 2026-08-14: nothing in lib/ or bin/ restored a file. The agent could
 * rewrite twelve files across five rounds and the only way back was git, and
 * only if the tree happened to be clean beforehand. `openJournal` is handed to
 * the executor so the previous bytes are copied at the two doors every mutation
 * already goes through; `acuvo rewind` reads them back.
 */
import {
  openJournal, readJournal, groupRuns, planRewind, applyRewind, checkpointSize,
  formatCheckpoints, formatRewind,
} from '../lib/checkpoint.mjs';
/**
 * ── ⭐⭐ CTRL-C, AND THE HALF OF IT THAT LIVES HERE ─────────────────────────
 *
 * `lib/interrupt.mjs` shipped INERT — the policy and all five signal handlers
 * were wired to consult it, and nothing ever registered a handler, so the first
 * Ctrl-C still killed the run and lost its transcript. This import is the wire
 * that was missing. See `armInterrupt` for what one press does and why the
 * second one is not negotiable.
 */
import { armInterrupt, wasAbortedByInterrupt, EXIT_INTERRUPTED } from '../lib/interrupt.mjs';
/**
 * ── ⭐⭐ AND THE OTHER HALF: SAYING SOMETHING WITHOUT STOPPING ──────────────
 * Ctrl-C is "stop". Steering is "no, do it this way instead" — the thing you
 * actually want at round three of eight. See `lib/steer.mjs` for why it is a
 * file and not a keystroke (short version: a keystroke works in exactly one of
 * this tool's two input modes, and not the one that needs it).
 */
import { takeSteer, planSteer, formatSteer, formatUnapplied, STEER_ABORT_REASON, STEER_FILE } from '../lib/steer.mjs';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_UNCONFIGURED = 2;
const EXIT_USAGE = 64;
/**
 * ⭐ "I CHOSE NOT TO RUN" IS NOT "I RAN AND FAILED", and under `--unattended`
 * they need opposite reactions: one is a schedule behaving exactly as
 * instructed, the other is something to look at. They had one exit code, so a
 * cron log could not tell them apart — and the first one is far more common,
 * which is how a person learns to ignore the alert that matters.
 */
const EXIT_SKIPPED = 3;

function die(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/**
 * ── ⭐⭐ SESSION LIFECYCLE + THE RUN LOG — THE FLAGS, AND WHY THEY ARE PARSED
 *        HERE RATHER THAN IN `cli-args.mjs` ───────────────────────────────────
 *
 * `parseArgv` refuses any `--flag` it does not know, which is the right default
 * and is exactly why these are lifted out of argv BEFORE it runs. This file owns
 * the operator surface (`--sessions`, `--resume`, `--continue`); the parser owns
 * the model's budget. Folding them into `parseArgv` is the tidier long-term
 * shape and is listed as the follow-up — it is not done here because that file
 * is being edited concurrently and a lane that reaches into someone else's file
 * destroys both pieces of work.
 *
 * ⚠️ THE STRIPPER IS TOTAL, NOT PERMISSIVE. Anything it does not recognise is
 * passed through untouched so `parseArgv` still produces its own sentence for a
 * typo — two parsers both guessing is how `--jsonn` ends up silently ignored.
 */
const LIFECYCLE_USAGE = [
  /**
   * ── ⚠️⚠️⭐ THE ONLY ROUTE OFF BYOK WAS INVISIBLE ───────────────────────────
   *
   * Measured against the real `node bin/acuvo.mjs --help` output on 2026-08-19,
   * on a clean tree: "login" 0, "logout" 0, "whoami" 0. All three flags WORK —
   * `--whoami` printed "Using OPENROUTER_API_KEY from your environment (BYOK)
   * … Run `acuvo --login` with an Acuvo key to use your credits instead."
   *
   * ⚠️ SO `--whoami` INSTRUCTED THE USER TO RUN A COMMAND `--help` DID NOT
   * LIST, while the Environment section called OPENROUTER_API_KEY "required —
   * the only one needed to write code". A stranger reading the front door end
   * to end concluded BYOK is the only mode this tool has. The doctrine is the
   * opposite, and an unreachable capability has not shipped.
   *
   * ⚠️ THEY LIVE HERE AND NOT IN `USAGE` FOR A MECHANICAL REASON. Every flag
   * `extractLifecycleFlags` strips is invisible to `parseArgv`, and
   * `test/cli-flags-parse.test.mjs` asserts that everything documented in
   * `USAGE` survives `parseArgv`. I put this block in `USAGE` first and that
   * test went red naming all three — correctly. `LIFECYCLE_USAGE` is where the
   * pre-stripped flags are documented; that is the convention, not a workaround.
   *
   * ⭐ AND IT IS FIRST IN THIS ARRAY, above the session flags, because it is the
   * first decision a new user makes: whose money this spends.
   */
  '',
  'Your account (an Acuvo key spends YOUR Acuvo credits — this is the way in):',
  '  --login [key]         Sign in. With no value it reads the key on stdin, which is the',
  '                        spelling to prefer: a credential typed as an argument lands in',
  '                        shell history, in `ps`, and in any terminal recording.',
  '                          acuvo --login < key.txt',
  '  --whoami              Which account this machine is using, and whose money it spends.',
  '                        Needs no key and spends nothing.',
  '  --logout              Forget the stored key. Falls back to OPENROUTER_API_KEY if one',
  '                        is set, which bills your provider account instead of your credits.',
  '',
  'Session lifecycle (a run is saved when it ends, so you never re-pay for the gather):',
  '  --sessions            List the runs saved in this workspace, newest first, and exit.',
  '                        Needs no API key. With --json, one object: {"sessions":[…]}.',
  '  --resume <id>         Carry on from a saved run. The conversation is REBUILT, never',
  '                        replayed — no file is rewritten and no command is re-run.',
  '                        Add a new instruction to steer it: --resume <id> "now add tests".',
  '  --continue            Same, on the most recent resumable run.',
  '  --strict              Exit 1 when the run wrote nothing and ran nothing. Off by',
  '                        default, because a question can be answered correctly without',
  '                        touching anything. ON AUTOMATICALLY when CI is set.',
  '  --no-session          Do not save this run.',
  '  --no-audit            Do not append this run to the audit log.',
  '',
  'Every run also appends one redacted JSON line to .acuvo/audit/<date>.jsonl — what was',
  'asked, what changed, what verified, what it cost. Never file contents, command output or',
  'model prose. --dry-run writes neither file, because a dry run touches nothing.',
  '',
  'Look at what happened, and at what is working (none of these spend a completion):',
  /**
   * ⚠️ `completion <shell>` USED TO SIT ON THE LINE AFTER `--doctor`, i.e. IN
   * THE MIDDLE OF --doctor's OWN DESCRIPTION. Rendered, a reader was told that
   * `completion <shell>` prints "endpoints, which tools would be offered, git.
   * Every dark or broken line names the exact variable that fixes it." — six
   * continuation lines belonging to the entry above it. Pure array ordering; no
   * sentence changed.
   */
  '  --doctor              Say what is actually working here: key, model chain, media',
  '                        endpoints, which tools would be offered, git. Every dark or',
  '                        broken line names the exact variable that fixes it. Exits 0',
  '                        when nothing is broken. ⚠️ It VERIFIES over the network: your',
  '                        key is sent to openrouter.ai to check it authenticates, and',
  '                        each configured endpoint is pinged. Add --offline to skip all',
  '                        of it — nothing leaves the machine, and no key is sent.',
  `  completion <shell>    Print a completion script (${SUPPORTED_SHELLS.join(' · ')}) — append it to your shell profile`,
  '  --replay <id>         Step through a saved run: every round, call, result and refusal.',
  '                        Runs NOTHING and writes NOTHING. Add --json for the raw steps.',
  '  --replay <id> --only <what>',
  '                        Narrow it: refusals | writes | runs | effects | reasoning.',
  '  --replay <a> --diff <b>',
  '                        Compare two runs of the same task and name where they split.',
  '  --design <file.html>  Render the page, look at it, and print a verdict — plus the',
  '                        actual pixels if your terminal speaks kitty or iTerm2. Writes',
  '                        a screenshot into .acuvo/ and nothing else. Needs RENDER_AUDIT_URL.',
].join('\n');

/**
 * @param {readonly string[]} argv
 * @returns {{ ok: true, flags: { sessions: boolean, resume: string | null, continueLatest: boolean, save: boolean, audit: boolean }, argv: string[] } | { ok: false, error: string }}
 */
const RESUME_NEEDS_VALUE = '--resume needs the id of a saved run, e.g. --resume 20260811-0915-a1b2. Run `acuvo --sessions` to see the ids, or use --continue for the most recent.';

/**
 * ⚠️ THE VALUED OPERATOR FLAGS SHARE ONE GUARD, and it is not tidiness. Each of
 * these can eat the flag that follows it — `--replay --json` naming a session
 * called "--json" is a confusing failure two steps later, and refusing here is
 * one step. Writing the guard five times is how one of the five ends up without
 * it, which is the shape of half the defects in this file's history.
 */
const VALUED_LIFECYCLE_FLAGS = new Map([
  ['--resume', { key: 'resume', need: RESUME_NEEDS_VALUE }],
  ['--replay', { key: 'replay', need: '--replay needs the id of a saved run, e.g. --replay 20260811-023539-bg12. Run `acuvo --sessions` to see the ids.' }],
  ['--diff', { key: 'diff', need: '--diff needs the id of a second saved run to compare against, e.g. --replay <a> --diff <b>. Run `acuvo --sessions` to see the ids.' }],
  ['--only', { key: 'only', need: '--only needs one of: refusals, writes, runs, effects, reasoning.' }],
  ['--design', { key: 'design', need: '--design needs the path to an HTML file in the workspace, e.g. --design index.html.' }],
]);

function extractLifecycleFlags(argv) {
  const flags = {
    sessions: false, resume: null, continueLatest: false, save: true, audit: true,
    doctor: false, replay: null, diff: null, only: null, design: null,
    login: false, loginToken: null, logout: false, whoami: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sessions') { flags.sessions = true; continue; }
    if (arg === '--doctor') { flags.doctor = true; continue; }
    if (arg === '--logout') { flags.logout = true; continue; }
    if (arg === '--whoami') { flags.whoami = true; continue; }
    /**
     * ⭐ `--login` TAKES ITS TOKEN OPTIONALLY. With a value it is convenient;
     * with none it reads stdin, which is the spelling the docs should show —
     * a live credential on the command line lands in shell history, in `ps`,
     * and in any terminal recording. `gh auth login --with-token` reads stdin
     * for exactly this reason.
     */
    if (arg === '--login') {
      flags.login = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags.loginToken = next; i += 1; }
      continue;
    }
    if (arg.startsWith('--login=')) { flags.login = true; flags.loginToken = arg.slice(8); continue; }
    if (arg === '--continue') { flags.continueLatest = true; continue; }
    if (arg === '--no-session') { flags.save = false; continue; }
    if (arg === '--no-audit') { flags.audit = false; continue; }
    const valued = VALUED_LIFECYCLE_FLAGS.get(arg);
    if (valued) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: valued.need };
      flags[valued.key] = value;
      i += 1;
      continue;
    }
    // The `--flag=value` spelling, for every one of them rather than for
    // `--resume` alone — an inconsistency here reads as a bug in the parser.
    let matched = false;
    for (const [name, spec] of VALUED_LIFECYCLE_FLAGS) {
      if (!arg.startsWith(`${name}=`)) continue;
      const value = arg.slice(name.length + 1);
      if (value === '') return { ok: false, error: spec.need };
      flags[spec.key] = value;
      matched = true;
      break;
    }
    if (matched) continue;
    rest.push(arg);
  }
  return { ok: true, flags, argv: rest };
}

/**
 * ── ⭐⭐ THE ONLY THING `bin` OWNS ABOUT LOGGING IN ──────────────────────────
 *
 * The FLOW lives in `lib/device-login.mjs` so both doors share one copy —
 * `acuvo --login`, and a bare `acuvo` that finds no credential. This adapter
 * owns only what `bin` legitimately owns: exit codes, and how a failure reads.
 *
 * ⚠️ The first version of this flow was written inline inside the `--login`
 * branch and a second caller needed it within the hour. A fix that lives inside
 * one caller is a fix for one caller — three separate instances of exactly that
 * were found and fixed in this codebase today. Extracted before the second copy
 * could exist rather than after it caused a divergence.
 */
async function deviceLoginOrDie() {
  const { runDeviceLogin } = await import('../lib/device-login.mjs');
  const { writeAccount, DEFAULT_GATEWAY_URL } = await import('../lib/account.mjs');
  const { maskToken } = await import('../lib/login.mjs');
  const { spawn } = await import('node:child_process');
  const gateway = process.env.ACUVO_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  try {
    const out = await runDeviceLogin({
      gatewayUrl: gateway,
      spawn,
      saveAccount: (token) => writeAccount({ token, gatewayUrl: gateway }),
    });
    process.stderr.write(`\nSigned in. Key ${maskToken(out.token)} saved.\n`);
    if (out.restricted === false) {
      process.stderr.write('WARNING: could not restrict permissions on the credentials file — check it yourself.\n');
    }
  } catch (e) {
    die(e?.message ?? 'login failed.', EXIT_USAGE);
  }
}

async function main() {
  /**
   * ── ⭐ `acuvo completion <shell>` ──────────────────────────────────────────
   *
   * ⚠️ FIRST, BEFORE ANY FLAG PARSING. `completion` is a SUBCOMMAND, not a flag,
   * and `parseArgv` refuses anything it does not recognise — so checking later
   * means the refusal fires before the feature does. It also needs no key, no
   * model and no network: printing a completion script is a `cat` of generated
   * text, and making someone authenticate to install tab-completion teaches
   * them the tool is heavier than it is.
   *
   * ⚠️ STDOUT CARRIES THE SCRIPT AND NOTHING ELSE, because the documented
   * install is `acuvo completion zsh >> ~/.zshrc`. A banner, a hint or a colour
   * code on stdout lands inside the user's shell profile and breaks their next
   * login. Errors go to stderr for exactly that reason.
   */
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'completion') {
    const result = completionScript(rawArgs[1], { command: 'acuvo' });
    if (!result.ok) {
      process.stderr.write(`${result.error}
`);
      return EXIT_USAGE;
    }
    process.stdout.write(`${result.script}
`);
    return EXIT_OK;
  }

  const lifted = extractLifecycleFlags(rawArgs);
  if (!lifted.ok) die(`${lifted.error}\n\n${USAGE}${LIFECYCLE_USAGE}\n`, EXIT_USAGE);
  const life = lifted.flags;
  /**
   * ⚠️ LIFTED BEFORE `parseArgv`, WHICH REFUSES ANY `--flag` IT DOES NOT KNOW.
   * That refusal is the right default and is precisely why the voice flags come
   * out of argv first, exactly like the lifecycle ones above.
   */
  const voiced = extractVoiceFlags(lifted.argv);
  if (!voiced.ok) die(`${voiced.error}\n\n${USAGE}${LIFECYCLE_USAGE}${VOICE_USAGE}\n`, EXIT_USAGE);
  const voice = voiced.flags;
  const parsed = parseArgv(voiced.argv);
  if (!parsed.ok) die(`${parsed.error}\n\n${USAGE}`, EXIT_USAGE);
  const opts = parsed.options;
  /**
   * ── ⭐ THE ENGINE THE USER NAMED, RECORDED ONCE FOR THE WHOLE RUN ──────────
   *
   * The parser only VALIDATED the id (it is pure, and a parser with a side
   * effect on module state cannot be called twice in a test file without the
   * second call inheriting the first one's choice). This is the one place that
   * commits it, and it is a no-op when nobody passed `--engine`.
   *
   * ⚠️ IT IS PER MEDIUM. `--engine acuvo-image-ultra` changes what an image
   * costs and cannot change what `speak` does — a flag whose blast radius is
   * wider than its name is how somebody gets billed for a decision they think
   * they scoped.
   */
  if (opts.engine) setRunEngine(opts.engine);
  if (opts.help) {
    // ⚠️ THE NEW FLAGS ARE DOCUMENTED WHERE PEOPLE LOOK. A capability that only
    // the changelog knows about is the "built but unreachable" failure this
    // whole exercise exists to end — `--help` is the front door.
    process.stdout.write(`${USAGE}\n${LIFECYCLE_USAGE}\n${VOICE_USAGE}\n`);
    return EXIT_OK;
  }
  /**
   * ⚠️ BEFORE THE KEY CHECK, AND THAT ORDER IS THE WHOLE POINT. My first version
   * sat below it, so `acuvo --version` demanded an OPENROUTER_API_KEY — the very
   * first command anyone runs after installing, refusing to answer until they
   * configure an account. `--version` and `--help` must work on a machine with
   * nothing set up; they are how you check the install SUCCEEDED.
   *
   * The version is READ FROM package.json, never hardcoded: a string typed into
   * source is wrong the first time someone bumps the manifest, and a CLI that
   * misreports its own version makes every bug report start from a false premise.
   */
  if (opts.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`acuvo-code ${pkg.version}\n`);
    return EXIT_OK;
  }

  /**
   * ── ⚠️⭐ REFUSE THE COMBINATIONS THAT CANNOT HONOUR `--json` ────────────────
   *
   * `--help` promises "One JSON object on stdout, nothing else". Measured: that
   * was true on ONE of the four paths through this file. `--parallel` writes
   * "running 2 tasks" and a summary table to stdout; interactive mode writes a
   * whole conversation there. Both return BEFORE the `if (opts.json)` block near
   * the bottom, so the flag was accepted, ignored, and `| jq` died on prose.
   *
   * ⚠️ THE HONEST ANSWER IS A REFUSAL, NOT A REROUTE. Pushing those lines to
   * stderr would leave stdout holding nothing at all, because neither mode HAS a
   * one-object answer: there is no single verdict for N parallel tasks, and a
   * conversation has one per turn. Emitting an empty document, or an array the
   * help text never promised, would be a second lie on top of the first.
   *
   * ⚠️ AND IT FIRES HERE — above the workspace resolve, above the `.env` load,
   * above the key check, above the banner. Refusing later would print the very
   * prose this exists to prevent. The message names the invocation that DOES
   * work; "try again" would be worse than saying nothing, because nothing about
   * retrying this command can change the answer.
   */
  /**
   * ⚠️ TWO NEW EXEMPTIONS, AND BOTH ARE EXEMPT BECAUSE THEY DO HAVE ONE OBJECT.
   * `--sessions --json` emits `{"sessions":[…],"unreadable":n}` — one document,
   * nothing else on stdout. `--resume` (and `--continue`) run exactly one task
   * and therefore reach the same one-object path a fresh run does; the only
   * difference is where the first message came from. Refusing them would be the
   * flag declining a shape it can honour perfectly.
   */
  /**
   * ⚠️⚠️ FOUR MORE EXEMPTIONS, AND EVERY ONE OF THEM DOES HAVE ONE OBJECT.
   * `--doctor` emits the report, `--replay` the timeline (or the diff), and
   * `--design` the pass. `--task-audio` is the subtle one: the task comes from
   * the AUDIO, so `opts.task` is empty at this point and without naming it here
   * `acuvo --task-audio note.wav --json --yes` dies at "run one task per
   * invocation" before it ever transcribes a byte — the flag refusing the exact
   * shape it can honour, which is the defect this guard was written to end.
   */
  const resumeRequested = life.resume !== null || life.continueLatest;
  /**
   * ⚠️ `leases` BELONGS IN THIS LIST FOR THE SAME REASON `--doctor` DOES: it
   * emits ONE object and nothing else, so refusing `--json` on it would be the
   * flag declining a shape it can honour perfectly. Leaving it out is also what
   * would make `acuvo leases --json` die at "run one task per invocation" —
   * `opts.task` is empty for a command, which is exactly the trap `--task-audio`
   * fell into.
   */
  const emitsOwnObject = life.sessions || life.doctor || life.login || life.logout || life.whoami
    || life.replay !== null || life.design !== null
    || opts.command !== null;
  if (opts.json && !emitsOwnObject && (opts.parallel || (!opts.task && opts.issue === null && !resumeRequested && !voice.taskAudio))) {
    die('--json emits one object for one task. --parallel and interactive mode print a running report instead, so run one task per invocation (acuvo --json "<task>"), or drop --json.', EXIT_USAGE);
  }

  /**
   * ⚠️ `??` BELOW DOES NOT CATCH AN EMPTY STRING, and the gap points a
   * FILE-WRITING agent at a directory nobody chose: `acuvo --dir "$PROJECT"`
   * with PROJECT unset expands to `--dir ""`, which fell through to
   * `process.cwd()` in silence. `--dir "   "` already errored with "Not a
   * directory", so the empty case was an inconsistency as well as a hazard —
   * the more dangerous of the two spellings was the one that was accepted.
   *
   * ⚠️ ABOVE THE KEY CHECK ON PURPOSE. On an unconfigured machine the old order
   * answered "no API key" — a true statement about the wrong problem.
   */
  if (opts.dir !== undefined && String(opts.dir).trim() === '') {
    die('--dir was given an empty value. Pass a directory, or omit --dir to use the current directory.', EXIT_USAGE);
  }

  const root = resolve(opts.dir ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    die(`Not a directory: ${root}`, EXIT_USAGE);
  }

  /**
   * ⚠️⚠️ THE `.acuvo/` SELF-IGNORE IS DELIBERATELY *NOT* CALLED HERE, and it was
   * on the first attempt. Running it at startup created the directory on every
   * invocation — including `--dry-run`, whose `--help` promises it "touches
   * nothing", and `--no-audit --no-session`, which promises to leave the
   * workspace alone. The suite caught it immediately
   * (`lifecycle-wiring.test.mjs`), and the test was right: creating a directory
   * and a file IS touching something.
   *
   * ⭐ So the ignore belongs with whoever actually CREATES the directory —
   * `appendAudit` and the session writer — because those already respect every
   * opt-out. A convenience placed one layer too high broke a promise two flags
   * had made.
   */

  /**
   * ── ⚠️⭐ LOAD `.env` FROM THE WORKSPACE. THE MEDIA HALF WAS DARK WITHOUT IT ──
   *
   * Measured today: `mediaToolNames(process.env)` returned `[]` in an ordinary
   * terminal, on a machine where every one of those services is configured and
   * working. Nothing here read a `.env` file, so `see_page` — the capability
   * this CLI is sold on — was never even OFFERED to the model unless you
   * happened to know to `export` four variables by hand first.
   *
   * ⭐ It also removes the `--env-file` dance the README documents for the API
   * key: the shape everyone already has (a `.env` next to the code) now works.
   *
   * ⚠️ A REAL ENVIRONMENT VARIABLE ALWAYS WINS. Node's loader does not overwrite
   * what is already set, which is the behaviour you want: an explicit `export`
   * in this shell must beat a stale file someone forgot about, or debugging
   * becomes guesswork about which value is live.
   *
   * ⚠️ And it is best-effort by design. No `.env` is the normal case, and a
   * malformed one must not stop a coding session that never needed it.
   */
  /**
   * ⚠️⚠️ THIS LOOKED FOR `.env` AND THERE IS NO PLAIN `.env` ON THIS MACHINE —
   * every file is `.env.local`, the name Next.js/Vite/CRA use for the one that
   * holds secrets and is git-ignored. So the loader above never fired once and
   * the media half it was written to rescue stayed dark. It now walks up for
   * `.env.local` then `.env`, and lives in `lib/env-file.mjs` where a test can
   * read the filename list — being inline here is why nobody caught it.
   */
  envLoad([root, process.cwd()]);

  /**
   * ── ⚠️⚠️ POLICY: 736 LINES OF ADMIN CONTROL THAT NOTHING EVER CALLED ───────
   *
   * `lib/policy.mjs` lets an organisation forbid verbs, cap rounds, cap dollars,
   * force `--dry-run`, restrict models and ban MCP — and its design is the good
   * kind: every merge takes the STRICTER value, so the merge is a meet on a
   * lattice and a policy file the agent itself rewrites can only ever restrict
   * it further. There is no value it can write that grants it anything.
   *
   * Measured 2026-08-12 by walking the import graph from both entry points:
   * **it was reachable from nothing but its own test.** 736 lines, fully
   * documented, fully tested, and every `--doctor` and every run behaved as if
   * an admin had never been able to say no to anything. That is this package's
   * signature failure — not writing bad code, writing good code and never
   * connecting it — and the enterprise checklist item most likely to be asked
   * about was the one sitting dark.
   *
   * ⚠️ TWO LAYERS, AND THE USER'S IS THE TRUSTED ONE. `~/.acuvo/policy.json` is
   * the admin layer (outside the workspace, so the agent cannot reach it); the
   * workspace file can only narrow it further.
   */
  const readIfPresent = (file) => {
    try { return existsSync(file) ? readFileSync(file, 'utf8') : null; } catch { return null; }
  };
  /**
   * ── ⭐⭐ THE CONFIG FILE — 825 built lines that nothing had ever called ─────
   *
   * Deliberately here, beside the POLICY load, because they are the same shape
   * and the same trust argument: `~/.acuvo/config.json` is yours, the
   * workspace's `.acuvo/config.json` came with a repo you cloned, and the second
   * may only make things STRICTER. A cloned repo that could RAISE your budget or
   * switch running back on would be a config file with a security hole in it.
   * `rcfile.mjs` enforces that direction; this is only the door.
   *
   * ⚠️⚠️ A KEY THE USER TYPED IS NEVER OVERWRITTEN, and that is enforced HERE
   * rather than trusted to the resolver. `resolveConfig` is told WHICH keys were
   * explicit but never sees their VALUES, so its `values` still carry the file's
   * number for a key the flag also set. Applying that blindly would let a config
   * file silently beat a flag the person just typed — the one behaviour a config
   * system must never have.
   *
   * ⚠️ AND A MALFORMED CONFIG STOPS THE RUN, matching the policy loader directly
   * below: absent means "no config", but present-and-broken is a broken control,
   * and quietly falling back is how someone discovers their settings never
   * applied — from a surprise bill.
   */
  const homeConfigDir = process.env[ACUVO_HOME_ENV]?.trim() || join(homedir(), '.acuvo');
  const configLoad = resolveConfig({
    argv: voiced.argv,
    env: process.env,
    homeText: readIfPresent(join(homeConfigDir, HOME_CONFIG_FILE)),
    workspaceText: readIfPresent(join(root, WORKSPACE_CONFIG_FILE)),
  });
  if (!configLoad.ok) die(`config: ${configLoad.error}`, EXIT_USAGE);
  // ⭐ The precedence rule lives in rcfile.mjs so it is testable without running
  // the whole CLI — inline here it was reachable only by end-to-end invocation,
  // which is how a rule this important ends up unverified.
  applyConfigToOptions(opts, configLoad.values, explicitKeysFromArgv(voiced.argv));

  const adminPolicyFile = process.env[USER_POLICY_ENV]?.trim() || join(homedir(), USER_POLICY_FILE);
  const policyLoad = loadPolicy({
    adminText: readIfPresent(adminPolicyFile),
    adminLabel: adminPolicyFile,
    workspaceText: readIfPresent(join(root, WORKSPACE_POLICY_FILE)),
  });
  if (!policyLoad.ok) {
    /**
     * ⚠️ A MALFORMED POLICY STOPS THE RUN. `command.mjs` already makes this call
     * for `.acuvo/commands.json`: absent means "no policy", but present-and-
     * broken is a broken CONTROL, and quietly falling back to permissive is how
     * an org discovers its restrictions never applied.
     */
    die(`policy: ${policyLoad.error}`, EXIT_USAGE);
  }
  const policy = policyLoad.policy;

  const verdict = invocationDecision(policy, {
    dryRun: opts.dryRun, model: opts.model ?? undefined, maxRounds: opts.maxRounds, allowRun: opts.allowRun,
  });
  if (!verdict.ok) {
    // ⚠️ Before the key check and before any spend: a run policy forbids must
    // cost nothing to discover.
    die(`refused by policy:\n  ${verdict.violations.join('\n  ')}`, EXIT_USAGE);
  }
  for (const note of verdict.notes) process.stderr.write(`  · ${note}\n`);

  /**
   * ⚠️ THE ROUND CEILING IS APPLIED, NOT JUST REPORTED. `invocationDecision`
   * returns the cap as a NOTE; if nothing then lowers `maxRounds`, the note is
   * an announcement of a limit that is not enforced.
   */
  const capped = roundBudget(policy, opts.maxRounds);
  if (capped.capped) opts.maxRounds = capped.rounds;

  /**
   * ⚠️⚠️ AND SO IS THE COST CEILING — IT WAS ENFORCED BY NOTHING AT ALL.
   * `costDecision` in policy.mjs is complete and had ZERO runtime callers.
   * Measured: a workspace policy of `{"maxCostUsd": 0}` parsed fine, the
   * decision function returned STOP when asked, and the run spent money over
   * three rounds because nobody asked it. Exactly the disease the comment above
   * describes for rounds, in the sibling control.
   *
   * ⭐ Folded into the ceiling the governor already reads, rather than added as
   * a second check in the round loop — one mechanism cannot drift from itself,
   * and a future call site cannot forget it.
   */
  const costCap = costBudget(policy, opts.budgetUsd);
  if (costCap.capped) {
    opts.budgetUsd = costCap.usd;
    /**
     * ⚠️ MARKED AS CHOSEN, NOT DEFAULT. `budgetExplicit` is what tells the
     * governor a human picked this number — it changes the refusal wording and
     * gates `--until-done`. An admin writing a policy file IS a human choosing,
     * so a policy-set ceiling that still read as "the default" would announce
     * itself as an accident.
     */
    opts.budgetExplicit = true;
    opts.budgetSource = 'policy';
    process.stderr.write(`  · ${costCap.reason}\n`);
  }

  /**
   * ── ⭐ `--sessions` — WHAT IS SAVED, AND ABOVE THE KEY CHECK ON PURPOSE ────
   *
   * Same reasoning as `--version`: reading a directory this tool wrote needs no
   * account. A machine whose key expired is precisely the machine whose operator
   * wants to know what the last run got through before it died, and answering
   * "no API key" there is a true statement about the wrong problem.
   *
   * ⚠️ IT RESUMES NOTHING AND RUNS NOTHING. Listing is the one operation in this
   * file that cannot spend money or write a byte, and it stays that way.
   */
  if (life.sessions) {
    const listed = listSessions(root, { limit: 20 });
    if (!listed.ok) die(listed.error, EXIT_FAILED);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ sessions: listed.sessions, unreadable: listed.unreadable }, null, 2)}\n`);
      return EXIT_OK;
    }
    if (listed.sessions.length === 0) {
      // ⚠️ An empty state that only says "none" leaves the reader wondering
      // whether the feature is off or simply unused. Say which.
      process.stdout.write('\n  no runs saved in this workspace yet — one is written each time a task finishes.\n\n');
      return EXIT_OK;
    }
    process.stdout.write('\n');
    for (const s of listed.sessions) process.stdout.write(`  ${s.summary}\n`);
    if (listed.unreadable > 0) {
      process.stderr.write(`  (${listed.unreadable} unreadable session file${listed.unreadable === 1 ? '' : 's'} skipped)\n`);
    }
    process.stdout.write('\n  carry one on:  acuvo --resume <id> ["what to do next"]\n\n');
    return EXIT_OK;
  }

  /**
   * ── ⭐⭐ `acuvo leases` — WHO IS HOLDING WHAT, AND SINCE WHEN ──────────────
   *
   * ⚠️ ABOVE THE KEY CHECK, like `--version`, `--sessions`, `--doctor` and
   * `--replay`, and for the identical reason: reading a directory this tool
   * wrote needs no account. The person typing this is usually the person whose
   * SEVENTH terminal just refused to start, and answering "no API key" there is
   * a true statement about the wrong problem.
   *
   * ⚠️ IT RUNS NOTHING, WRITES NOTHING AND RECLAIMS NOTHING. `inspect` reports a
   * stale lease as `expired`/`reclaimable` and leaves it exactly where it is —
   * a diagnostic that quietly breaks other people's locks would be the worst
   * possible reading of "show me what is going on".
   */
  /**
   * ── ⭐ `acuvo spend` — READING BACK WHAT EVERY RUN ALREADY WROTE DOWN ──────
   *
   * `parseAuditLog` shipped finished, exported and tested with ZERO runtime
   * callers, so the tool recorded `costUsd` on every run and nobody could ask
   * for it. For a product sold on telling you the price before it runs, being
   * unable to answer "what have I spent" afterwards is the pitch with its last
   * sentence removed.
   *
   * ⚠️ Reads only. No key, no completion, no network — same class as `--doctor
   * --offline` and `leases`.
   */
  /**
   * ── ⭐⭐ `acuvo engines` — "WHAT WILL THIS COST ME", ASKED BEFORE SPENDING ──
   *
   * Roman, 2026-08-16: *"as long as users have the choice to switch between
   * premium and basic for video and image then we should be good"* — and a
   * choice you cannot price is not a choice. This is the surface where a person
   * finds out that an Ultra clip is 585 credits and the core one is 117, before
   * either of them has run.
   *
   * ⚠️ ABOVE THE KEY CHECK, with `leases` and `spend`: it needs no OpenRouter
   * key, because it asks the ACUVO GATEWAY about an ACUVO ACCOUNT. Refusing it
   * for a missing model key would be a true statement about the wrong problem.
   *
   * ⚠️⚠️ AND IT PRINTS "PRICES UNAVAILABLE" RATHER THAN A NUMBER WHEN NOBODY
   * ANSWERS — which today is everybody, because the gateway has no `/engines`
   * route yet (measured 2026-08-16: `acuvo-gateway/lib/handler.mjs` proxies chat
   * completions and routes nothing, and `console/app/api/cli/v1/` holds only
   * `chat/`). Shipping the numbers inside the package to make this look finished
   * is the one thing that must not happen: an npm package pins the price it was
   * published with, and the customer can edit the file. Prices are account facts
   * and they stay on the server.
   */
  if (opts.command === 'engines') {
    const result = await listEngines({});
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
      return EXIT_OK;
    }
    process.stdout.write(`
${result.text}

`);
    return EXIT_OK;
  }

  if (opts.command === 'spend') {
    const since = parseSince(opts.since);
    if (since && since.error) die(since.error, EXIT_USAGE);
    const summary = summariseSpend(readAuditFiles(root), { since });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return EXIT_OK;
    }
    process.stdout.write(`\n${formatSpend(summary, { since }).map((l) => `  ${l}`).join('\n')}\n\n`);

    /**
     * ── ⭐ WHAT THAT SPEND IS AGAINST ────────────────────────────────────
     *
     * A dollar figure alone cannot answer the question people actually ask,
     * which is "how much have I got left". The plan is the denominator, and
     * `lib/plan.mjs` holds it with prices measured from the endpoint each
     * model is PINNED to — not from a model page, which is how pro looked
     * 3.1x flash while we were being charged 11.2x.
     *
     * ⚠️ THE CACHE RATE IS PASSED IN, NOT ASSUMED. This plan clears an 80%
     * margin only at or above 77% cache, so a margin quoted without the rate
     * that produced it is a number somebody chose. It comes from this
     * workspace's own audit log, computed above.
     */
    const observedCache = Number.isFinite(summary?.cacheHitRate) ? summary.cacheHitRate : 0.95;
    /**
     * ── ⭐ WHERE THIS WORKSPACE ACTUALLY STANDS AGAINST THE ALLOWANCE ────
     *
     * ⚠️ `allowanceRemaining` shipped and was called by nobody — an
     * allowance nothing reads is a number on a pricing page. The usage is
     * aggregated from this workspace's own audit log, per model that
     * ANSWERED (not the one requested: a run that fell back spent tokens on
     * whichever model actually served it).
     *
     * ⚠️ ENFORCEMENT AT RUN TIME NEEDS THE ACCOUNT. This is one workspace on
     * one machine; the real limit is per TENANT and lives behind the
     * gateway. What is honest to show today is where this workspace stands,
     * and to say plainly that it is not the whole picture.
     */
    /**
     * ⚠️ `readAuditFiles` returns `{name, text}` — RAW TEXT, not records. My
     * first version assumed `.records` and silently produced 0.0M used,
     * which is the worst possible wrong answer: an allowance reading zero
     * looks healthy. Caught by running it against a workspace that had a
     * real 93,743-token run in the log.
     */
    const auditRecords = readAuditFiles(root).flatMap((f) => parseAuditLog(f.text).records);
    const { byModel, unknown } = usageByModel(auditRecords);
    const left = allowanceRemaining(PLANS.starter, byModel);
    const usageLines = Object.entries(left)
      .filter(([, v]) => v.available)
      .map(([id, v]) => `  ${labelForModelId(id).padEnd(12)} ${(v.used / 1e6).toFixed(1)}M of ${(v.granted / 1e6).toFixed(0)}M used${v.exhausted ? '  — EXHAUSTED' : ''}`);
    if (unknown > 0) usageLines.push(`  ⚠ ${unknown} run(s) recorded no model or token count, so this is a floor`);
    usageLines.push('  (this workspace only — a plan limit is per account, and that lives behind the gateway)');

    const planLines = [...usageLines, '', ...formatPlan(PLANS.starter, observedCache)].map((l) => `  ${l}`);
    process.stdout.write(`${planLines.join('\n')}\n\n`);
    return EXIT_OK;
  }

  /**
   * ── ⭐⭐ `acuvo board` — THE LAST PIECE OF "SEVEN TERMINALS, SEVEN WORKERS" ──
   *
   * Everything else was already measured working: seven terminals run, leases
   * stop them writing one file, the fleet ceiling caps the day, the plan ledger
   * is per worker. What was missing is that nothing said what the WORK was, so
   * seven terminals meant a person typing seven prompts and nothing stopping
   * two of them being the same.
   *
   * ⚠️ READ-ONLY BY DEFAULT and above the key check, like `leases` and `spend`:
   * looking at the board must work on a machine with no credentials at all.
   */
  /**
   * ── ⭐⭐ `acuvo verify` — RE-CHECKING A PAST CLAIM FOR NOTHING ─────────────
   *
   * Every run already writes the exact command this process observed exiting 0.
   * So a claim made yesterday can be tested today by RUNNING it again — no model
   * call, no cost. Above the key check with the other read-only commands,
   * because it needs no credentials at all: there is nothing to ask a model.
   */
  if (opts.command === 'verify') {
    const loaded = loadRuns(root);
    if (!loaded.ok) die(loaded.error, EXIT_FAILED);
    const runner = (command, o) => executeRunCommand({
      command,
      executor: createLocalExecutor(root),
      timeoutMs: o?.timeoutMs ?? opts.commandTimeoutMs,
      shell: opts.shell,
    });

    /**
     * ⭐ `--all` answers the question a fleet actually leaves behind. Seven
     * terminals working a board overnight produce fifty claims, and nobody wants
     * to read fifty receipts — they want to know which are still true.
     */
    if (opts.verifyAll) {
      const all = await recheckAll(loaded.runs, { runner });
      if (opts.json) process.stdout.write(`${JSON.stringify(all, null, 2)}
`);
      else process.stdout.write(['', formatRecheckAll(all).split(String.fromCharCode(10)).map((l) => `  ${l}`).join(String.fromCharCode(10)), ''].join(String.fromCharCode(10)));
      if (all.checked === 0) return EXIT_SKIPPED;
      return all.ok ? EXIT_OK : EXIT_FAILED;
    }

    const picked = pickRun(loaded.runs, opts.verifyId);
    if (!picked.ok) die(picked.error, EXIT_USAGE);

    const outcome = await recheckClaim(picked.run, { runner });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}
`);
    } else {
      process.stdout.write(['', `  ${formatRecheck(outcome).split(String.fromCharCode(10)).join(String.fromCharCode(10) + '  ')}`, ''].join(String.fromCharCode(10)));
    }
    /**
     * ⚠️ THREE OUTCOMES, THREE CODES. `holds` is 0. `broken` is 1 — that is the
     * one a deploy gate cares about. "No checkable claim" is EXIT_SKIPPED, not
     * 0: a run that executed nothing proved nothing, and reporting that as
     * success is the quiet dishonesty every verdict here exists to prevent.
     */
    if (outcome.status === 'holds') return EXIT_OK;
    if (outcome.status === 'unclaimed') return EXIT_SKIPPED;
    return EXIT_FAILED;
  }

  if (opts.command === 'board') {
    const [verb, ...rest] = opts.boardArgs ?? [];
    if (!verb) {
      const listed = boardList(root);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(listed, null, 2)}
`);
        return listed.ok ? EXIT_OK : EXIT_FAILED;
      }
      process.stdout.write(`
${formatBoard(listed)}

`);
      return listed.ok ? EXIT_OK : EXIT_FAILED;
    }
    if (verb === 'add') {
      const text = rest.join(' ').trim();
      const added = boardAdd(root, text);
      if (!added.ok) die(added.error, EXIT_USAGE);
      process.stdout.write(`  added ${added.id} — ${added.task}
`);
      return EXIT_OK;
    }
    if (verb === 'done') {
      const done = boardDone(root, rest[0]);
      if (!done.ok) die(done.error, EXIT_USAGE);
      process.stdout.write(`  done ${done.id} — ${done.task}
`);
      return EXIT_OK;
    }
    die(`unknown board command "${verb}". Try: acuvo board · acuvo board add "…" · acuvo board done <id>`, EXIT_USAGE);
  }

  /**
   * ── ⭐⭐ `acuvo rewind` — THE UNDO, AND WHY IT SITS UP HERE ─────────────────
   *
   * Above the key check with `leases`, `spend`, `board` and `verify`: putting
   * files back needs no credentials, no network and no completion. The moment
   * you most want an undo is the moment something went wrong, and "configure an
   * API key first" would be the worst possible answer to it.
   *
   * ⚠️ THE DEFAULT IS TO LIST, NOT TO ACT. A bare `acuvo rewind` restores
   * nothing — it prints the checkpoints and the exact command to use. A verb
   * that guesses which state you meant is a verb that overwrites the wrong one.
   */
  if (opts.command === 'rewind') {
    const journal = readJournal(root);
    if (!journal.ok) die(journal.error, EXIT_FAILED);
    const runs = groupRuns(journal.entries);
    const wanted = (opts.rewindArgs ?? [])[0] ?? null;

    if (!wanted) {
      // ⚠️ THE DISK COST IS PART OF THE ANSWER. Nothing prunes this store yet,
      // so a listing that never mentions its size is the one place a user would
      // have found out before it mattered.
      const size = checkpointSize(root);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ checkpoints: runs, unreadable: journal.unreadable, size }, null, 2)}\n`);
        return EXIT_OK;
      }
      process.stdout.write(`\n${formatCheckpoints(runs, size).map((l) => `  ${l}`).join('\n')}\n\n`);
      /**
       * ⚠️ EXIT 3, NOT 0, WITH NOTHING TO SHOW. "There is no undo here" is not
       * success, and a script asking "can I roll this back" must be able to
       * tell it apart from "yes, here are four". Same reasoning as
       * `acuvo verify` returning EXIT_SKIPPED for an unclaimed run.
       */
      return runs.length === 0 ? EXIT_SKIPPED : EXIT_OK;
    }

    const plan = planRewind(journal.entries, wanted);
    if (!plan.ok) die(plan.error, EXIT_USAGE);
    const result = applyRewind(root, plan, { dryRun: opts.dryRun, force: opts.force });
    /**
     * ⚠️⚠️ "I REFUSED EVERY FILE" IS NOT "I PUT THEM BACK", and a script must be
     * able to tell them apart: `acuvo rewind <id> && npm test` would otherwise
     * test the tree it was asked to undo. Three outcomes, three codes — the
     * same rule `acuvo verify` follows for a run with no checkable claim.
     * 0 something was restored · 3 nothing was, because it all conflicted ·
     * 1 something actually failed.
     */
    const touched = result.restored.length + result.removed.length;
    const code = !result.ok ? EXIT_FAILED : (touched === 0 && result.skipped.length > 0 ? EXIT_SKIPPED : EXIT_OK);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return code;
    }
    process.stdout.write(`\n${formatRewind(result).map((l) => `  ${l}`).join('\n')}\n\n`);
    return code;
  }

  if (opts.command === 'leases') {
    const view = inspect(root);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
      return view.ok ? EXIT_OK : EXIT_FAILED;
    }
    process.stdout.write(`\n${formatLeaseSummary(view).map((l) => `  ${l}`).join('\n')}\n\n`);
    if (view.ok === false) return EXIT_FAILED;
    return EXIT_OK;
  }

  /**
   * ── ⭐⭐ `--doctor` — ONE COMMAND THAT SAYS WHAT IS ACTUALLY WORKING ────────
   *
   * ⚠️ ABOVE THE KEY CHECK, for the same reason `--version` and `--sessions`
   * are. The doctor's whole job is to say WHY nothing is configured; demanding
   * configuration before it will answer would make it useless at exactly the
   * moment it is needed — the first command anyone runs after an install that
   * did not work.
   *
   * ⚠️ `opts.maxRounds` AND `opts.allowRun` ARE PASSED, NOT DROPPED. The tool
   * offer is a snapshot for the flags you actually gave; without them the
   * withheld-tool reasons would be right about the doctor's assumption and
   * wrong about your next run.
   */
  /**
   * ── ⭐⭐ `--login` / `--logout` / `--whoami` — THE STEP THAT WAS MISSING ───
   *
   * `writeAccount` has been exported, documented and reachable in code for
   * weeks while being called by NOTHING but its own tests. So `resolveCredential`
   * never found an account, fell through to `OPENROUTER_API_KEY`, and every user
   * was on BYOK — which `account.mjs` itself calls "never the plan" and which
   * makes the storefront an advertisement for somebody else.
   *
   * ⚠️ ABOVE THE CREDENTIAL CHECK, deliberately: the command that FIXES a
   * missing credential cannot be gated on having one. Same reason `--replay`
   * sits above it.
   */
  if (life.whoami) {
    const { describeAuth } = await import('../lib/login.mjs');
    const { resolveCredential } = await import('../lib/account.mjs');
    const d = describeAuth(resolveCredential());
    process.stdout.write(`${d.line}
`);
    return d.ok ? EXIT_OK : EXIT_FAILED;
  }

  if (life.logout) {
    const { clearAccount } = await import('../lib/account.mjs');
    const cleared = clearAccount();
    if (cleared.ok === false) die(cleared.error, EXIT_FAILED);
    /**
     * ⚠️ `.existed`, NOT the returned object. `clearAccount` returns
     * `{ ok, existed, path }`, so testing the object itself is always truthy and
     * would tell someone who was never logged in that their credential had just
     * been removed — a lie that sends them looking for a problem that is not there.
     */
    process.stdout.write(cleared.existed
      ? 'Logged out. The stored credential has been removed.\n'
      : 'You were not logged in — nothing to remove.\n');
    return EXIT_OK;
  }

  if (life.login) {
    const { validateTokenShape, verifyToken, maskToken } = await import('../lib/login.mjs');
    const { writeAccount, DEFAULT_GATEWAY_URL } = await import('../lib/account.mjs');

    /**
     * ⚠️ STDIN WHEN NO VALUE WAS GIVEN. A credential passed as an argument is
     * in shell history and in `ps` output the moment it is typed.
     */
    let raw = life.loginToken;
    if (raw === null) {
      if (process.stdin.isTTY) {
        await deviceLoginOrDie();
        process.stderr.write('Run `acuvo` to start.\n');
        process.exit(0);
      }
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      raw = Buffer.concat(chunks).toString('utf8');
    }

    const shape = validateTokenShape(raw);
    if (!shape.ok) die(shape.reason, EXIT_USAGE);

    const gateway = process.env.ACUVO_GATEWAY_URL || DEFAULT_GATEWAY_URL;
    process.stderr.write(`Checking that key against ${gateway} …
`);
    const check = await verifyToken(shape.token, gateway);
    /**
     * ⚠️ VERIFY BEFORE WRITE. A saved-but-invalid token fails at the model call
     * on some later run, far from the mistake, with an error about chat
     * completions rather than about login.
     */
    if (!check.ok) die(check.reason, EXIT_FAILED);

    const wrote = writeAccount({ token: shape.token, gatewayUrl: gateway });
    if (!wrote || wrote.ok === false) {
      die(`could not save the credential${wrote && wrote.error ? `: ${wrote.error}` : ''}`, EXIT_FAILED);
    }
    // Never echo the credential itself.
    process.stdout.write(`Logged in (${maskToken(shape.token)}). Your runs now bill Acuvo credits.\n`);
    /**
     * ⚠️ SAY SO IF THE FILE COULD NOT BE LOCKED DOWN. `writeAccount` reports
     * whether it managed to restrict permissions; on a filesystem that cannot
     * (a Windows share, some mounts) the credential is readable by other users
     * of the machine. Staying silent would be us deciding on the user's behalf
     * that it did not matter to them.
     */
    if (wrote.restricted === false) {
      process.stderr.write(`⚠️ ${wrote.note ?? `could not restrict permissions on ${wrote.path} — other users of this machine may be able to read it.`}\n`);
    }
    return EXIT_OK;
  }

  if (life.doctor) {
    const report = await runDoctor({ root, allowRun: opts.allowRun, maxRounds: opts.maxRounds, skipNetwork: opts.offline === true });
    if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${formatDoctor(report, { paint: createPainter(colourEnabled()) })}\n`);
    return report.ok ? EXIT_OK : EXIT_FAILED;
  }

  /**
   * ── ⭐⭐ `--replay` / `--diff` — MAKE A RUN DEBUGGABLE ─────────────────────
   *
   * ⚠️ IT EXECUTES NOTHING AND WRITES NOTHING, and the document says so in a
   * field (`executed: false`) rather than only in prose. A "replay" that
   * re-ran the tool calls would be a command run twice by someone who typed it
   * once — the same invariant `--resume` protects, and for the same reason.
   *
   * ⚠️ Above the key check: reading a directory this tool wrote needs no
   * account, and a machine whose key expired is precisely the machine whose
   * operator wants to know what the last run got through before it died.
   */
  if (life.replay !== null) {
    const loaded = loadSession(root, life.replay);
    if (!loaded.ok) die(loaded.error, EXIT_USAGE);
    const paint = createPainter(colourEnabled());
    if (life.diff !== null) {
      const other = loadSession(root, life.diff);
      if (!other.ok) die(other.error, EXIT_USAGE);
      const d = diffRuns(loaded.session, other.session);
      if (!d.ok) die(d.error, EXIT_FAILED);
      process.stdout.write(opts.json ? `${JSON.stringify(d, null, 2)}\n` : formatDiff(d, { paint }));
      return EXIT_OK;
    }
    const replayed = replaySession(loaded.session);
    if (!replayed.ok) die(replayed.error, EXIT_FAILED);
    if (opts.json) process.stdout.write(`${JSON.stringify(replayed, null, 2)}\n`);
    else {
      /**
       * ⚠️ AN UNKNOWN `--only` THROWS OUT OF `filterSteps`, BY DESIGN — it
       * names the specs that exist rather than silently showing everything.
       * Caught here so a typo is a usage error with a sentence, not a stack
       * trace that reads like a bug in acuvo.
       */
      let text;
      try {
        text = formatTimeline(replayed, { paint, filter: life.only ?? undefined });
      } catch (e) {
        die(`${e?.message ?? e}`, EXIT_USAGE);
      }
      process.stdout.write(text);
    }
    return EXIT_OK;
  }
  if (life.diff !== null) {
    die('--diff compares two runs, so it needs both: acuvo --replay <a> --diff <b>.', EXIT_USAGE);
  }
  if (life.only !== null) {
    die('--only narrows a replay, so it needs one: acuvo --replay <id> --only refusals.', EXIT_USAGE);
  }

  /**
   * ── ⭐⭐ `--design <file.html>` — RENDER IT, LOOK AT IT, SAY WHAT IS WRONG ──
   *
   * The design loop without the agent: one pass, no model call, no completion
   * spent. It is above the key check because it never talks to a model — this
   * is the browser and the judgement, not the writer.
   *
   * ⚠️ AN EXIT CODE THAT MEANS SOMETHING. 0 = the page was looked at and
   * nothing was found. 1 = either the look failed or the page has findings.
   * "Could not look" is never reported as "the page is fine": `trustworthy`
   * carries that distinction into the JSON, and the verdict carries it into the
   * prose.
   */
  if (life.design !== null) {
    const pass = await designPass(root, life.design, { dryRun: opts.dryRun });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(pass, null, 2)}\n`);
      return pass.ok && (pass.findings?.length ?? 0) === 0 ? EXIT_OK : EXIT_FAILED;
    }
    const lines = formatDesignPass(pass, { root });
    process.stdout.write(`${lines.join('\n')}\n`);
    if (!pass.ok && pass.error) process.stderr.write(`  ${pass.error}\n`);
    return pass.ok && (pass.findings?.length ?? 0) === 0 ? EXIT_OK : EXIT_FAILED;
  }

  /**
   * ── ⭐⭐ `--lease <path>` — CLAIM THE FILES BEFORE ANYTHING IS SPENT ───────
   *
   * ⚠️ ABOVE THE KEY CHECK, AND THAT IS NOT AN ACCIDENT. "Somebody else has
   * that file" is the answer the user needs FIRST — before a model is chosen,
   * before a banner is printed, and certainly before a completion is bought.
   * A run that discovers the contention after writing three files has already
   * done the damage the lease exists to prevent.
   *
   * ⚠️ BELOW THE READ-ONLY COMMANDS, equally deliberately: `--doctor`,
   * `--replay`, `--design` and `acuvo leases` write nothing to the workspace, so
   * taking a write lease for them would block a colleague for no reason.
   *
   * ⚠️ RELEASED ON `exit`, WHICH COVERS EVERY PATH OUT OF THIS PROCESS —
   * `die()`, the ordinary return, and a throw caught by the handler at the
   * bottom. Releasing only at the end of the happy path is how a crashed
   * terminal leaves a file locked and the person at the next desk concludes the
   * feature is broken.
   *
   * ⚠️ AND THE ALL-OR-NOTHING IS `acquireAll`'s, not ours: it takes every path
   * in a fixed global order or gives back the ones it took. A terminal holding
   * three of five files and waiting on the fourth is a stall nobody can
   * diagnose.
   */
  let held = { ok: true, leases: [], warnings: [] };
  /** Set by the heartbeat below. Non-null means another terminal took a file. */
  let leaseLost = null;
  if (opts.lease.length > 0) {
    const holder = opts.holder ?? `pid-${process.pid}`;
    held = acquireAll(root, { paths: opts.lease, holder, ttlMs: DEFAULT_TTL_MS });
    if (!held.ok) {
      const who = held.heldBy ? ` — held by ${held.heldBy}` : '';
      die(`${held.error}${who}\n\nRun \`acuvo leases\` to see who holds what.`, EXIT_FAILED);
    }
    for (const w of held.warnings) process.stderr.write(`  ! ${w}\n`);
    process.on('exit', () => { try { releaseAll(held.leases); } catch { /* exiting anyway */ } });
    (opts.json ? process.stderr : process.stdout).write(
      `  · leased ${held.leases.length} path${held.leases.length === 1 ? '' : 's'} as ${holder}\n`,
    );
  }

  // ⚠️ THE KEY IS CHECKED BEFORE THE WORKSPACE IS TOUCHED. Discovering the
  // configuration is missing AFTER walking a large tree is a slower way to
  // deliver the same message, and on a big repo it reads as a hang.
  const config = readModelConfig(process.env);
  if (!config.configured) {
    /**
     * ── ⭐⭐⭐ TYPING `acuvo` IS ENOUGH, THE WAY TYPING `claude` IS ───────────
     *
     * Roman, 2026-08-22: *"all they should have to type is acuvo and boom
     * they're in."*
     *
     * This used to print instructions and exit — so a new user's first
     * interaction was homework. A real person at a real terminal now gets the
     * login itself, not a description of where to find one.
     *
     * ⚠️ ONLY WHEN A HUMAN IS THERE. Without a TTY this is a script, a CI job
     * or a pipe, and opening a browser and blocking for ten minutes on an
     * approval nobody is present to give would convert a clean "not configured"
     * exit into a hang. Those callers keep the message and the exit code.
     */
    if (!process.stdin.isTTY) die(MISSING_KEY_MESSAGE, EXIT_UNCONFIGURED);
    process.stderr.write('No credentials yet — signing you in.\n');
    await deviceLoginOrDie();
    process.stderr.write('\nRun the same command again to start.\n');
    return EXIT_OK;
  }
  if (opts.model) config.model = opts.model;

  /**
   * ── ⭐⭐ AUTOMATIC LEASING — WHAT MAKES `--lease` A GUARANTEE ──────────────
   *
   * The import comment above states the limit this closes: an agent does not
   * know which files it will write until it writes them, so a DECLARED lease
   * protects only what the user correctly predicted. This claims each path at
   * the moment it is written.
   *
   * ⚠️ ON BY DEFAULT, and that is a considered call rather than an oversight.
   * It refuses ONLY when another live terminal provably holds the exact path;
   * with one terminal open there is no conflict to find, so it is invisible.
   * The alternative — off unless asked — protects nobody, because the people
   * who most need it are the ones who did not think about it. `--no-auto-lease`
   * turns it off, and an infrastructure failure degrades to the old behaviour
   * rather than blocking work (see lib/auto-lease.mjs).
   */
  /**
   * ⚠️ A WINDOW WITH NO CEILING MEASURES NOTHING. `--budget-window 7d` on its
   * own reads like a spend limit and is not one — the kind of flag that makes
   * somebody believe they are protected. Refused rather than ignored.
   */
  if (opts.budgetWindow && opts.fleetBudgetUsd === null) {
    die('--budget-window sets the period --fleet-budget is measured over, so it needs one. Try: --fleet-budget 5.00 --budget-window 7d', EXIT_USAGE);
  }

  const claimer = opts.autoLease
    ? createPathClaimer(root, { holder: opts.holder ?? `pid-${process.pid}` })
    : null;
  if (claimer) process.on('exit', () => { try { claimer.releaseAll(); } catch { /* exiting anyway */ } });

  /**
   * ── ⭐⭐ THE CHECKPOINT JOURNAL FOR THIS RUN ────────────────────────────────
   *
   * ⚠️ `null` UNDER `--dry-run`, and that is not an optimisation. `--help`
   * promises a dry run "touches nothing"; a preview that created
   * `.acuvo/checkpoints/` and copied files into it would have broken that
   * promise to save an undo for a run that never happened. `writeFile` also
   * returns before recording in dry-run mode — belt and braces, because the two
   * halves of that promise live in two files.
   *
   * ⚠️ AND NOTHING IS CREATED UNTIL THE FIRST MUTATION. Opening it is free; a
   * run that answers a question leaves no directory behind.
   */
  const journal = (opts.checkpoint && !opts.dryRun)
    ? openJournal(root, { task: opts.task || null })
    : null;

  const executor = createLocalExecutor(root, {
    dryRun: opts.dryRun,
    claimPath: claimer ? (p) => claimer.claim(p) : null,
    journal,
    /**
     * ⭐ WHO THIS TERMINAL IS — and the plan ledger keys on it. Measured with
     * two terminals in one checkout: terminal 2 could not plan at all (the
     * workspace already had terminal 1's plan), was invited by the refusal to
     * DESTROY it with `replace:true`, and had every round prefixed with a
     * banner describing terminal 1's task. `plan_step` from terminal 2 marked
     * "port auth" done — work it never did.
     *
     * ⚠️ `opts.holder` is null unless the user typed `--holder`, and that is the
     * whole compatibility story: a single terminal keeps `.acuvo/plan.json` and
     * keeps `--resume`, while the seven-terminal case is exactly the case where
     * a holder is already being named for the leases.
     */
    holder: opts.holder ?? null,
  });

  /**
   * ⚠️ THE BANNER SAYS WHETHER IT CAN EXECUTE, BEFORE IT DOES. A tool that may
   * run commands on your machine has to say so on the line above the first one
   * it runs — not in a README, and not after the fact. `--dry-run` and
   * `--no-run` are the two ways to see the same line say it cannot.
   */
  // Interactive mode needs no task; the loop supplies each one.
  const canRun = opts.allowRun && !opts.dryRun && opts.maxRounds > 1;
  /**
   * ⚠️⭐ `--shell` SAYS ITSELF BACK, EVERY RUN, IN THE FIRST LINE ON SCREEN.
   * The default banner's "may run: node, npm test, …" is a promise; under
   * `--shell` that promise is void, and a banner still reciting the old list
   * would be actively misleading — the operator would read the safe sentence
   * while the unsafe thing happened. A mode that removes a guarantee has to be
   * impossible to have forgotten you enabled.
   */
  const mode = opts.dryRun
    ? 'DRY RUN (nothing written, nothing run)'
    : canRun
      ? (opts.shell
        ? `${opts.maxRounds} rounds · ⚠ SHELL MODE — may run ANY program, with your privileges`
        : `${opts.maxRounds} rounds · may run: node, npm test, npm run, npx vitest, tsc`)
      : `${opts.maxRounds === 1 ? 'single round' : `${opts.maxRounds} rounds`} · will NOT run anything`;
  /**
   * ⚠️ THE BANNER GOES TO STDERR UNDER `--json` TOO, and forgetting it is what
   * broke the first test of this flag: one friendly line at the top made the
   * whole document unparseable. "Everything human goes to stderr" has to mean
   * EVERYTHING — including the parts written before anyone thought about JSON.
   */
  /**
   * ⚠️ THE ROOT IS SHORTENED, NOT DROPPED. It printed as a 100+ character
   * absolute path and wrapped the one line whose whole job is to orient you
   * before anything happens — but WHICH directory this run will write to is
   * exactly the fact a banner exists to state, so it stays, shortened and with
   * any elision marked. See `shortenRoot`.
   */
  const banner = `acuvo · ${config.model} · ${shortenRoot(executor.root)}\n       · ${mode}\n`;
  if (opts.json) process.stderr.write(banner);
  else process.stdout.write(banner);

  /**
   * ── ⭐⭐ `--resume` / `--continue` — THE RECOVERY THE ROUND CAP NEEDS ───────
   *
   * `stoppedBecause: 'round-cap'` is the commonest way a real task ends, and
   * until now the only recovery was to retype the prompt and pay for the entire
   * gather a second time. Resume rebuilds the conversation from the saved record
   * and hands it to `runSession` as `priorMessages` — the exact path interactive
   * chat already uses, so nothing new happens inside the loop.
   *
   * ⚠️⚠️ IT RE-RUNS NOTHING, AND THAT IS THE INVARIANT TO PROTECT. The record
   * holds the OUTPUT of the commands the earlier process ran; `resumeMessages`
   * appends a note saying so in plain words. Nothing here replays a tool call,
   * and nothing here may ever start doing so — a resume that re-executes is a
   * command run twice by a user who typed it once.
   *
   * ⚠️ A RESUME WITH NO NEW INSTRUCTION IS A VALID REQUEST ("carry on"), so the
   * original task is reused when none is given. That is why `task` becomes a
   * local rather than staying `opts.task`.
   */
  /**
   * ── ⭐⭐ `--task-audio` — TALK TO YOUR TERMINAL, BUT CONFIRM FIRST ─────────
   *
   * ⚠️⚠️ IT NEVER ACTS ON WHAT IT HEARD WITHOUT SHOWING YOU. `taskFromAudio`
   * returns `needsConfirmation: true` unconditionally, and that is the right
   * unconditional: the dangerous case is not the transcript the service flagged
   * as uncertain, it is the one it got confidently wrong. Enter cancels. That
   * keystroke is the whole thing standing between a mis-heard word and a
   * file-writing agent.
   *
   * ⚠️ BELOW THE WORKSPACE `.env` LOAD, DELIBERATELY. Above it,
   * MODAL_TRANSCRIBE_URL from the workspace `.env` is invisible and the
   * capability reports itself absent on a machine where it works — the exact
   * bug that loader was added to fix.
   *
   * ⚠️ AND EVERY HUMAN LINE, INCLUDING THE PROMPT, GOES TO STDERR UNDER
   * `--json`. readline's `output` is stderr here for precisely that reason.
   */
  let voiceTask = null;
  if (voice.taskAudio) {
    const say = (t) => (opts.json ? process.stderr : process.stdout).write(t);
    const heard = await taskFromAudio(root, voice.taskAudio);
    if (!heard.ok) die(heard.error, EXIT_UNCONFIGURED);
    say(`${confirmationLines(heard).join('\n')}\n`);
    const tty = process.stdin.isTTY === true;
    let answer = null;
    if (tty && !voice.yes && !opts.json) {
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      answer = await new Promise((r) => rl.question('  > ', (l) => { rl.close(); r(l); }));
    }
    const decided = decideTranscript({ task: heard.task, answer, tty, json: opts.json, assumeYes: voice.yes });
    if (!decided.run) die(`  ${decided.why}\n`, EXIT_USAGE);
    voiceTask = decided.task;
  }

  let task = voiceTask ?? opts.task;

  /**
   * ── ⭐⭐ `--claim` — SEVEN TERMINALS, ONE LIST, NOBODY DOING THE SAME JOB ────
   *
   * The instruction comes off the shared board instead of being typed. Seven
   * windows each running `acuvo --holder tN --claim` split one list of work
   * with nobody duplicating anyone — which is the whole "seven workers" idea,
   * and the last piece of it that did not exist.
   *
   * ⚠️ THE CLAIM IS A LEASE, so it is released on exit exactly like every other
   * lease — a worker that crashes returns its task to the board after the TTL
   * rather than parking it forever.
   *
   * ⚠️ AN EMPTY BOARD IS EXIT 0, NOT AN ERROR. Seven terminals finishing a list
   * means six of them find nothing left, and a fleet that reports six failures
   * every time it completes its work would train its owner to ignore the exit
   * code — which is the one signal this package asks people to gate on.
   */
  let claimed = null;
  if (opts.claim) {
    if (task) die('--claim takes the task from the board, so do not also type one. Use one or the other.', EXIT_USAGE);
    if (!opts.holder) die('--claim needs --holder, so the board can say which terminal is doing what. Try: acuvo --holder t1 --claim', EXIT_USAGE);
    claimed = boardClaim(root, { holder: opts.holder });
    if (!claimed.ok) {
      const out = claimed.empty ? process.stdout : process.stderr;
      out.write(`  ${claimed.error}
`);
      return claimed.empty ? EXIT_OK : EXIT_FAILED;
    }
    task = claimed.task;
    (opts.json ? process.stderr : process.stdout).write(`  claimed ${claimed.id} as ${opts.holder} — ${claimed.task}
`);
    process.on('exit', () => { try { if (claimed?.lease) releaseAll([claimed.lease]); } catch { /* exiting anyway */ } });
  }

  let priorMessages = null;
  /**
   * ── ⭐⭐⭐ ONE STICKY KEY FOR THIS WHOLE CONVERSATION, ACROSS PROCESSES ────
   *
   * OpenRouter routes every request carrying the same `session_id` back to the
   * same upstream SERVER. That is the half of the prompt-cache story our own
   * prefix work could never reach: the prefix was already 99.9% byte-identical,
   * and the misses were the ROUTING — a cache lives on one machine and a
   * provider is a fleet.
   *
   * ⚠️ AND THE MEASURED FAILURE WAS BETWEEN PROCESSES, NOT WITHIN THEM: four
   * consecutive cold runs went 65 / 98 / 31 / 98, because each new process
   * rolled the dice again. So a RESUMED run must reuse the SAVED id — a fresh
   * key here would land on a fresh machine and throw away the warm cache that
   * the conversation being resumed had already paid to build.
   */
  let stickyKey = `acuvo-${randomUUID()}`;
  if (resumeRequested) {
    if (life.resume !== null && life.continueLatest) {
      die('--resume <id> and --continue both name a run to carry on, and they disagree. Pass one: --continue takes the most recent, --resume takes the id you name.', EXIT_USAGE);
    }
    if (opts.parallel) {
      die('--resume carries on ONE conversation; --parallel starts several fresh ones. Run the resume by itself.', EXIT_USAGE);
    }
    if (opts.issue !== null) {
      die('--issue starts a fresh branch and a fresh conversation, so there is nothing to resume. Drop one of --issue / --resume.', EXIT_USAGE);
    }

    let id = life.resume;
    if (life.continueLatest) {
      const listed = listSessions(root, { limit: 50 });
      if (!listed.ok) die(listed.error, EXIT_FAILED);
      /**
       * ⚠️ THE MOST RECENT *RESUMABLE* ONE, NOT THE MOST RECENT ONE. A run that
       * died before round 1 is saved and listable but holds no conversation;
       * picking it would answer "carry on" with "there is nothing to carry",
       * naming a session the user never chose.
       */
      const latest = listed.sessions.find((s) => s.resumable);
      if (!latest) {
        die('nothing to continue — no run in this workspace saved a conversation. Run `acuvo --sessions` to see what is there, or start a fresh task.', EXIT_USAGE);
      }
      id = latest.id;
    }

    const resumed = resumeMessages(root, id);
    if (!resumed.ok) die(resumed.error, EXIT_USAGE);
    priorMessages = resumed.messages;
    // ⭐ The saved id IS the conversation, so it is the routing key too. This
    // line is what makes stickiness survive closing the terminal.
    stickyKey = `acuvo-${resumed.id ?? id}`;
    if (!task) task = resumed.task;
    if (!task) {
      die(`run ${resumed.id} recorded no task text, so "carry on" has nothing to carry. Say what to do next: acuvo --resume ${resumed.id} "<the next step>"`, EXIT_USAGE);
    }
    // ⚠️ STDERR UNDER --json, like every other human line in this file.
    const warn = resumed.rootChanged ? ' ⚠️ it was recorded in a DIFFERENT workspace' : '';
    (opts.json ? process.stderr : process.stdout).write(
      `  · resuming ${resumed.id} — ${priorMessages.length} messages restored, nothing re-run${warn}\n`,
    );

    /**
     * ── ⚠️⚠️ A RESUMED RUN USED TO GET A WHOLE FRESH BUDGET ──────────────────
     *
     * `createBudget` starts at `spentUsd = 0` every time, so
     * `acuvo --budget 0.50 …` followed by `acuvo --resume <id> --budget 0.50`
     * spent a DOLLAR while the person believed they had capped it at fifty
     * cents. `budget.mjs` flagged this against itself; nothing had closed it.
     *
     * ⭐ THE FIX IS SUBTRACTION, NOT A NEW PARAMETER. The limit is lowered by
     * what the earlier run already spent, so `budget.mjs` stays pure (data in,
     * data out, no disk) and `turn.mjs` is untouched. One task, one ceiling,
     * however many processes it takes.
     *
     * ⚠️ "$0.50" IS AMBIGUOUS ON A RESUME — is it fifty cents MORE, or fifty
     * cents TOTAL? Total is the reading that cannot silently overspend, so it
     * is the one taken, and it is SAID OUT LOUD rather than assumed. A person
     * who meant "more" can pass a bigger number; a person who meant "total" and
     * got "more" has no way to find out until the bill.
     */
    if (opts.budgetUsd) {
      /**
       * ⚠️ `loadSession` returns `{ ok, session }` — the cost lives at
       * `session.usage.cost`. My first draft read `.record.usage.cost` and
       * silently found `undefined`, which coerces to 0 and would have made this
       * whole guard a no-op that LOOKED like it worked. Verified against a real
       * record: `{"cost":0.000250116,"total_tokens":10218}`.
       */
      const prior = loadSession(root, id);
      const spent = Number(prior?.session?.usage?.cost ?? 0);
      if (Number.isFinite(spent) && spent > 0) {
        const left = opts.budgetUsd - spent;
        const money = (n) => (n < 0.01 ? `${(n * 100).toFixed(2)}c` : `$${n.toFixed(4)}`);
        if (left <= 0) {
          die(
            `that run already spent ${money(spent)}, which is at or over the ${money(opts.budgetUsd)} budget. `
            + `Raise it (--budget ${money(spent * 2)}) if you want it to carry on.`,
            EXIT_USAGE,
          );
        }
        opts.budgetUsd = left;
        (opts.json ? process.stderr : process.stdout).write(
          `  · budget ${money(opts.budgetUsd + spent)} total — ${money(spent)} already spent, ${money(left)} left for this run\n`,
        );
      }
    }
  }

  /**
   * One turn, shared by the one-shot path, `--issue` and the interactive loop.
   *
   * ⭐ THE PERSISTENCE HANGS OFF THIS ONE FUNCTION ON PURPOSE. Every path that
   * completes a turn goes through here, so "a run is saved and logged" is true
   * by construction rather than by remembering to repeat two calls at four
   * return sites — which is exactly how one of them would end up unlogged.
   */
  /**
   * ⚠️ `over` EXISTS SO THE ESCALATION LADDER CAN REUSE THIS FUNNEL RATHER THAN
   * GROW A SECOND ONE. Every durable record — the session, the audit log, the
   * spoken verdict — hangs off `oneTurn`, and the `--best-of` branch above
   * already proves what a parallel call site costs: it re-implements the
   * `runSession` arguments and is the one path that persists nothing. A rung of
   * the ladder needs a different workspace and a smaller budget, and nothing
   * else, so those are the only two things overridable.
   */
  /**
   * ── ⚠️⚠️ THE CEILING WAS PER TURN AND IS SOLD AS PER RUN ──────────────────
   *
   * `runChat` loops calling `oneTurn`, and `oneTurn` handed out
   * `opts.budgetUsd` FRESH EVERY TIME. A forty-turn conversation therefore
   * permitted forty times the number the user agreed to — $0.80 against a
   * stated $0.02 — while `--help` and the README both call it the run's ceiling.
   *
   * ⭐ The one-shot path was always right (one turn, nothing to accumulate) and
   * the RESUME path already subtracts prior spend. This is the same subtraction
   * for the turn loop, using the same pure helper, so the two cannot drift.
   */
  let sessionSpentUsd = 0;
  /**
   * ── ⭐ WHAT ACTUALLY SERVED, FOR `/model` ─────────────────────────────────
   *
   * `aggregateProviders` already computes this per turn and `formatSummary`
   * already prints it once, at the end. But routing is the question people ask
   * in the MIDDLE of a session — "why is this costing more than it did" — and
   * `/model` answered with the configured name only.
   *
   * ⚠️ THE EXPENSIVE CASE IS SILENT BY CONSTRUCTION. `pinFellBack` means a
   * later name in the pin served the round: a cold prefix cache billed at up to
   * 4.6x, measured, with no error anywhere. A user cannot ask about a number
   * they were never shown.
   */
  let lastProviders = null;

  /**
   * ⚠️ SESSION-SCOPED, NOT TURN-SCOPED, because the EXIT CODE is a property of
   * the process and `verdictExit` runs long after the arming has been disposed.
   * Interactive mode never reads it (a conversation always exits 0 — see the
   * banner comment below), which is correct: there, Ctrl-C returns you to the
   * prompt and the session carries on.
   */
  let interruptedRun = false;

  /**
   * ⚠️ SET BY THE ROUND-BOUNDARY HOOK INSIDE `oneTurn`, READ BY `steerable`
   * AFTER IT RETURNS. It is a variable rather than a return field because
   * `oneTurn`'s return value is the session outcome — a shape `--json`,
   * `formatSummary`, the audit log and `sessionFailed` all consume — and
   * smuggling a CLI-local flag into it would put a field in the machine
   * contract for the convenience of two lines of control flow.
   */
  let pendingSteer = null;
  /**
   * ⚠️⚠️ WHEN THIS TURN STARTED, SO A LEFTOVER STEER CANNOT HIJACK IT. Found by
   * running it: a steer written just after the LAST round boundary is never
   * picked up and the file survives the run — so the next `acuvo` in that
   * workspace would consume it at round one and apply an instruction about
   * yesterday's task to today's. See `takeSteer`'s `newerThan`.
   *
   * ⭐ THE TURN, NOT THE SEGMENT. A steer written during segment 1 that arrived
   * too late for it is still about this turn and must reach segment 2; keying
   * off the segment start would throw exactly that case away.
   */
  let turnStartedAt = 0;

  const oneTurn = async (turnTask, priorTurnMessages, over = {}) => {
    /**
     * ⚠️ ONLY WHEN THIS IS A REAL TURN, NOT A LADDER RUNG. `over.budgetUsd` is a
     * slice `escalate.allocate()` already carved out of the session total, so
     * subtracting session spend from it would charge the same dollars twice and
     * starve rung three of a budget it was correctly allocated.
     */
    if (over.budgetUsd === undefined) {
      const room = remainingForTurn(opts.budgetUsd, sessionSpentUsd, { limitIsDefault: opts.budgetExplicit !== true, limitSource: opts.budgetSource ?? null });
      if (!room.ok) {
        const sentence = room.message;
        (opts.json ? process.stderr : process.stdout).write(`\n  ⛔ ${sentence}\n`);
        // ⚠️ `error` AND `message`, because formatSummary prints `error` for a
        // failed run and printing "✖ undefined" is worse than the refusal.
        return { ok: false, stage: 'budget', stoppedBecause: 'limit-reached', error: sentence, message: sentence };
      }
      if (room.remainingUsd !== null) over = { ...over, budgetUsd: room.remainingUsd };
    }

    /**
     * ── ⭐⭐ ARMED PER TURN, DISPOSED IN A `finally` ─────────────────────────
     *
     * ⚠️ PER TURN IS THE WHOLE POINT. `runChat` calls this function once per
     * turn for the life of a conversation; a handler left registered by turn 3
     * would swallow the Ctrl-C pressed during turn 9 — the user would press,
     * see the notice, and watch turn 9 keep going, because the signal that was
     * aborted belongs to a controller nobody is reading any more. Hence the
     * `finally` below, and hence the ownership guard in `onFirstInterrupt`.
     *
     * ⚠️ The notice goes to STDERR under `--json`, like every other human line
     * on this path: stdout carries exactly one object and one friendly sentence
     * there breaks `| jq` for everybody.
     */
    /**
     * ⚠️ ONE CONTROLLER, TWO REASONS TO ABORT. `runSession` takes a single
     * signal, so Ctrl-C and steering necessarily share it — and they are told
     * apart by `gate.wasInterrupted()`, NOT by the abort reason. That matters
     * for the exit code: a steered run must exit on its verdict, and only a
     * genuine keypress may produce 130.
     */
    const controller = new AbortController();
    const gate = armInterrupt({
      controller,
      notify: (notice) => {
        interruptedRun = true;
        (opts.json ? process.stderr : process.stdout).write(`\n  ⏹ ${notice}\n`);
      },
    });

    let result;
    try {
      result = await runSession({
      sessionId: stickyKey,
      task: turnTask,
      priorMessages: priorTurnMessages,
      executor: over.executor ?? executor,
      config,
      /**
       * ⭐ THE WIRE. `runSession` has taken a `signal` since it landed and
       * NOTHING supplied one — the built-but-unreached defect this package
       * ships most often. This is the supplier.
       */
      signal: gate.signal,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
      /**
       * ⚠️⚠️ THE THIRD OVERRIDE, AND IT EXISTS TO STOP `--max-rounds` BECOMING
       * A LIE. A steered turn runs as several segments; if each one were handed
       * the full `opts.maxRounds`, `--max-rounds 8` plus three steers would
       * quietly mean 32 rounds. `steerable` passes what is LEFT. Every other
       * caller omits it and is byte-identical.
       */
      maxRounds: over.maxRounds ?? opts.maxRounds,
      /**
       * ── ⭐⭐ THE TWO OVERRIDES `--plan`'s PROPOSAL PHASE NEEDS ─────────────
       *
       * ⚠️ `allowRun` IS AN OVERRIDE AND NOT A REPLACEMENT — `??`, so a run
       * that names neither is byte-identical to yesterday's. The proposal phase
       * passes `false`, and it has to: `toolNames` below decides what the model
       * is OFFERED, while `allowRun` is also read by the DISPATCHER. A model can
       * call a tool it was never shown (this package's own two-lock rule), so a
       * read-only phase that only narrowed the offer would still execute a
       * `run_command` the model guessed at.
       *
       * ⚠️ `toolNames` IS OMITTED UNLESS ASKED FOR, not passed as null. Passing
       * null is the same as omitting it today, but `runSession` documents null
       * as "compute the offer from the round budget" and pinning that
       * equivalence here would make a future change to the default silently
       * bypass every caller.
       */
      allowRun: over.allowRun ?? (opts.allowRun && !opts.dryRun),
      ...(Array.isArray(over.toolNames) ? { toolNames: over.toolNames } : {}),
      shell: opts.shell,
      commandTimeoutMs: opts.commandTimeoutMs,
      /**
       * ── ⭐⭐ THE TWO OPTIONS THAT MOVE THE WALL FROM A COUNTER TO MONEY ────
       * `null` / `false` are what a caller who typed neither flag gets, and both
       * are no-ops inside the loop — see the option docs in `runSession`.
       */
      /**
       * ⚠️ THE RUNG'S SLICE WINS OVER THE WHOLE `--budget`, and that override is
       * the entire reason the ladder can escalate at all: handed the full
       * ceiling, rung one is entitled to spend it and there is nothing left to
       * try harder with. `escalate.allocate()` computes the slice.
       */
      budgetUsd: over.budgetUsd ?? opts.budgetUsd,
      /**
       * ⚠️ A ceiling the user never chose has to say so when it stops, and name
       * the flag that raises it. See DEFAULT_BUDGET_USD in budget.mjs.
       */
      budgetIsDefault: opts.budgetExplicit !== true,
      /**
       * ⭐ THE FLEET CEILING. `null` unless `--fleet-budget` was given, and
       * `createFleetGate` returns `null` for that case, so this is inert for
       * everyone who has not asked for it — no gate, no disk read.
       *
       * ⚠️ Built from `root`, not the process cwd: the ledger being summed has
       * to be the one every OTHER terminal on this workspace is appending to,
       * and `--dir` is exactly how a terminal ends up somewhere else.
       */
      fleetGate: createFleetGate(root, { fleetLimitUsd: opts.fleetBudgetUsd, since: opts.budgetWindow }),
      /**
       * ── ⚠️⚠️ THE CONSENT QUESTION NOBODY WAS EVER ASKED ────────────────────
       *
       * `turn.mjs` has taken `mcpAsk` and `mcpInteractive` since MCP consent
       * shipped, and until now NOTHING in this package supplied either — three
       * references in the whole codebase, all three inside `turn.mjs` itself.
       *
       * ⭐ It failed CLOSED, so nothing was ever silently approved. But
       * `checkMcpConsent` refuses whenever it cannot ask, so a committed
       * `.mcp.json` could not be approved from a terminal AT ALL: the only way
       * through was `ACUVO_TRUST_MCP=1`. Being able to drive every MCP server
       * is half the two-way story, and it was gated behind an environment
       * variable on a question the user was standing right there to answer.
       *
       * ⚠️ `createAsker` returns null when stdin/stdout are not both TTYs, and
       * that null is deliberate — see `lib/prompt.mjs`. A CI run keeps exactly
       * the behaviour it has today: refused, with "there is no terminal here".
       */
      mcpAsk: asker,
      mcpInteractive: asker !== null,
      /**
       * ⚠️ THE RUNG'S MODEL WINS, and `over.model` is undefined unless
       * `ACUVO_MODEL_TIERS` is configured — so a run without tiers is
       * byte-identical to one from before this existed. See `model-tier.mjs`
       * for why a feature that can multiply a bill has to default to inert.
       */
      ...(over.model && over.model !== config.model ? { config: { ...config, model: over.model } } : {}),
      untilDone: opts.untilDone,
      // ⭐ The admin layer reaches the loop. OPEN_POLICY when no file exists.
      policy,
      // ⚠️ STREAMED, NOT BUFFERED. A bounded loop that prints only at the end is
      // indistinguishable from a hang for however long it takes, and the whole
      // value of watching a fix land is watching it land.
      /**
       * ⚠️ HUMAN OUTPUT GOES TO STDERR UNDER `--json`. A script piping to `jq`
       * must receive ONE object and nothing else; interleaving progress lines
       * into stdout makes the flag useless while appearing to work.
       */
      onEvent: (event) => {
        /**
         * ── ⭐⭐ THE ROUND BOUNDARY IS WHERE A STEER IS PICKED UP ───────────
         *
         * ⚠️ ABOVE the `over.quiet` return, and gated on an EXPLICIT opt-in
         * rather than on `!quiet`. `--best-of` attempts and escalation-ladder
         * rungs are quiet, and they are also automated retries of a decision
         * the user already made — one steer file consumed by whichever of
         * three parallel attempts reached a boundary first is a race with no
         * right answer. `steerable` is the only caller that sets the flag.
         *
         * ⚠️ ONCE PER SEGMENT (`pendingSteer === null`). The abort takes effect
         * at the NEXT boundary, so this hook fires again before the loop
         * breaks; without the guard the second read would consume a steer the
         * user wrote for the continuation and apply it to a run that is already
         * stopping.
         *
         * ⭐ `controller.abort` rather than a mid-round injection: the loop
         * returns cleanly with its transcript, and `steerable` restarts it with
         * the instruction as a real user message. That is what makes the steer
         * arrive at a boundary by construction instead of by care.
         */
        if (event.type === 'round-start' && over.steerable === true && pendingSteer === null) {
          const steer = takeSteer(root, { newerThan: turnStartedAt });
          if (steer) {
            pendingSteer = steer;
            /**
             * ⚠️⚠️ A STALE STEER MUST NOT COST A ROUND, AND THE FIRST VERSION
             * OF THIS CHARGED ONE. Measured on a live run: a leftover file
             * aborted the loop at round 1, the task was never attempted, and
             * the summary said "No files changed" — the run was destroyed by a
             * sentence about a different task. It is still consumed and still
             * reported (`steerable` prints it at the end, with the words), it
             * just does not touch the run it does not belong to.
             */
            if (!steer.stale) controller.abort(STEER_ABORT_REASON);
          }
        }
        /**
         * ⚠️ SILENT WHEN THE CALLER ASKS. Three best-of attempts share one
         * terminal, and the `--best-of` branch below learned this first:
         * "three interleaved round-by-round streams are unreadable". The
         * escalation ladder reuses this funnel, so the same rule has to be
         * reachable from here or its top rung reprints that mess.
         */
        if (over.quiet) return;
        /**
         * ── ⭐ THE HEARTBEAT, DRIVEN OFF THE ROUND BOUNDARY ─────────────────
         *
         * A lease has a TTL, and a model round can take a minute. Without this,
         * a working terminal starts looking stale to the others and its files
         * become reclaimable while it is still writing them.
         *
         * ⚠️ IT STILL DOES NOT ABORT THE ROUND, AND THAT IS NOW A CHOICE
         * RATHER THAN A LIMIT. This comment used to say `runSession` takes no
         * abort signal; it does now, and `gate.signal` above is one. What has
         * not been decided is whether a lost lease SHOULD stop the run — it is
         * a different event from a keypress with a different exit code (1, the
         * verdict, not 130 — the distinction `wasAbortedByInterrupt` draws),
         * and changing it here would quietly repurpose a mechanism the user
         * asked for a different reason. So the callback still records the loss,
         * says so immediately, and fails the PROCESS — see `leaseLost` at the
         * exit.
         *
         * ⚠️ Only when leases are held. `renewAll([])` is harmless but running
         * it on every round of every run would put filesystem work in the hot
         * path of the 99% of runs that never asked for a lease.
         */
        if (event.type === 'round-start' && held.leases.length > 0 && !leaseLost) {
          const beat = renewAll(held.leases);
          if (!beat.ok) {
            leaseLost = beat.lost;
            process.stderr.write(
              `  ✖ lost a file lease mid-run: ${beat.lost.map((l) => `${l.path} (${l.reason})`).join(', ')}\n`
              + '    another terminal may be writing these files. This run will exit non-zero.\n',
            );
          }
        }
        /**
         * ── ⭐⭐ DRIFT, ON THE ROUND IT HAPPENED, TO THE PERSON PAYING ───────
         *
         * `turn.mjs` emits `{ type: 'plan-drift' }` the round a distinct drift
         * is detected and appends the nudge to the conversation. `renderEvent`
         * has no case for that type and returns `[]`, so until now the whole
         * chain ended at the model: it was told, and the user was not.
         *
         * ⚠️ IT IS NOT `event.text`. That string is written FOR A MODEL — 400-odd
         * characters offering both exits and naming the verbs — and printing it
         * at a terminal is a paragraph per drift that a person has to parse to
         * find the three filenames that matter. `driftBannerLine` rebuilds one
         * line from the same evidence object, which is why it takes the verdict
         * rather than the rendered nudge.
         *
         * ⚠️ ONCE PER DISTINCT DRIFT, because the event is: `turn.mjs`'s
         * `nudged` set already keys on `drift.evidence.key`. A per-round repeat
         * would be the plan-banner mistake — a true sentence that becomes noise.
         *
         * ⚠️ AND IT NEVER STOPS ANYTHING. Nothing here changes the exit code or
         * the run. The verdict leans towards "on plan" by construction (see
         * plan-coherence.mjs on why every threshold resolves that way), so the
         * honest action is to say it out loud and let the human decide.
         */
        if (event.type === 'plan-drift') {
          const line = driftBannerLine(event.verdict ?? event.drift ?? null);
          if (line) (opts.json ? process.stderr : process.stdout).write(`  ${line}\n`);
          return;
        }
        const lines = renderEvent(event);
        if (lines.length === 0) return;
        const text = `${lines.join('\n')}\n`;
        if (opts.json) process.stderr.write(text);
        else process.stdout.write(text);
      },
      });
    } finally {
      /**
       * ⚠️⚠️ THE ONE LINE THIS FEATURE CANNOT SURVIVE WITHOUT. Unregistering
       * here is what makes the SECOND Ctrl-C fatal (with nobody listening,
       * `exitIsDeferred` returns false and `turn.mjs`'s handler exits 130) and
       * what makes turn 9's Ctrl-C reach turn 9. In a `finally` because a
       * thrown provider error must not leave the process holding a disarmed
       * Ctrl-C — that is the state where the key does nothing at all.
       */
      gate.dispose();
    }
    persistRun(turnTask, result);
    /**
     * ── ⭐ `--say` — NARRATE THE VERDICT ──────────────────────────────────────
     *
     * ONE site covers one-shot, `--issue`, `--resume`/`--continue` AND the
     * interactive loop, because every one of them goes through `oneTurn`. Four
     * call sites is how one of them ends up silent.
     *
     * ⚠️ IT CAN NEVER FAIL THE RUN. `speakSummary` returns a reason; it does not
     * throw and it does not touch the exit code. The work is already on disk and
     * the exit code is a verification verdict, not a narration one — the same
     * rule the two durable records above obey.
     *
     * ⚠️ AND WE WRITE A .wav, WE DO NOT PLAY IT. Playing it means spawning an OS
     * binary past the command allowlist; the hint line is the command for your
     * platform, and the choice stays the user's.
     */
    if (voice.say) {
      const said = await speakSummary(root, result, { task: turnTask, enabled: true, dryRun: opts.dryRun });
      const out = opts.json ? process.stderr : process.stdout;
      if (said.spoken) out.write(`  · verdict spoken → ${said.path}\n    ${said.hint}\n`);
      else if (!said.ok) out.write(`  · the verdict was not spoken: ${said.reason}\n`);
    }

    /**
     * ⚠️ CHARGE THE SESSION, NOT JUST THE TURN. Without this the subtraction
     * above always subtracts zero and the ceiling stays per-turn — the whole
     * defect. Counted on EVERY turn including a ladder rung, because the dollars
     * left the account either way; what `over.budgetUsd` changes is which
     * allowance the turn draws from, never whether it was spent.
     */
    // ⚠️ Only when the turn named one. A transport that reports no routing
    // must not erase what the previous turn honestly measured.
    if (result?.providers) lastProviders = result.providers;
    const turnCost = Number(result?.usage?.cost ?? 0);
    if (Number.isFinite(turnCost) && turnCost > 0) sessionSpentUsd += turnCost;

    return result;
  };

  /**
   * ── ⭐⭐ ONE TURN, POSSIBLY IN SEVERAL SEGMENTS ────────────────────────────
   *
   * `oneTurn` is unchanged for everyone: it runs the loop once, saves the
   * session, writes the audit line, charges the session budget and speaks the
   * verdict. This wraps it so a user can redirect it mid-flight — write a line
   * into `.acuvo/steer.txt` and the run stops at the next round boundary,
   * appends what you said as a real user message, and carries on from the same
   * transcript.
   *
   * ⚠️ THE LOOP IS OUTSIDE `oneTurn`, NOT INSIDE IT, AND THAT IS THE WHOLE
   * SAFETY ARGUMENT. Every segment therefore goes through the one funnel that
   * already gets money right — `sessionSpentUsd` is charged per segment and
   * `remainingForTurn` subtracts it before the next one, so the `--budget`
   * ceiling covers the WHOLE turn and not each piece of it. Merging segments
   * inside `oneTurn` would have meant re-implementing that arithmetic, which is
   * exactly how this file once handed out its ceiling forty times over.
   *
   * ⚠️ WHAT THE FINAL SUMMARY PRICES IS THE LAST SEGMENT, because that is the
   * run it describes. The dollars from the earlier ones are printed on the
   * steering line as they happen — see `formatSteer`. Nothing is hidden; it is
   * reported where it occurs rather than summed into a number that would then
   * disagree with the session record it came from.
   *
   * ⚠️ AND IT IS NOT USED BY `--best-of` OR THE ESCALATION LADDER. Those run
   * several attempts of a decision the user already made, quietly and in
   * parallel; one steer file consumed by whichever attempt reaches a boundary
   * first is a race with no right answer.
   */
  const steerable = async (turnTask, priorTurnMessages, over = {}) => {
    let task = turnTask;
    let prior = priorTurnMessages;
    let rounds = over.maxRounds ?? opts.maxRounds;
    let steersUsed = 0;
    // ⭐ Stamped ONCE per turn, before the first segment — see `turnStartedAt`.
    turnStartedAt = Date.now();
    const out = () => (opts.json ? process.stderr : process.stdout);

    for (;;) {
      // ⚠️ Cleared per segment: a steer belongs to the segment that read it.
      pendingSteer = null;
      const result = await oneTurn(task, prior, { ...over, steerable: true, maxRounds: rounds });
      const taken = pendingSteer;
      const plan = planSteer({ steer: taken, outcome: result, maxRounds: rounds, steersUsed });

      if (!plan.go) {
        /**
         * ⚠️ A STEER THAT WAS NOT APPLIED IS ANNOUNCED. It has already been
         * DELETED from disk by `takeSteer` — silently dropping it would mean
         * the user typed an instruction, watched it vanish, and got no hint
         * that the run never saw it.
         */
        if (plan.reason) out().write(`${formatUnapplied({ text: taken?.text, reason: plan.reason })}\n`);
        return result;
      }

      steersUsed += 1;
      out().write(`${formatSteer({ ...taken, roundsLeft: plan.roundsLeft, spentUsd: sessionSpentUsd })}\n`);
      task = plan.task;
      prior = plan.priorMessages;
      rounds = plan.maxRounds;
    }
  };

  /** What this run actually wrote. Shared, because both reports need it. */
  // ⚠️ flatMap, not map: `write_files` and a delegated build each name many
  // files in ONE record, and `.map` collapsed them into a single entry whose
  // `path` was undefined. This feeds the JSON report and the audit log.
  const changesOf = (result) => (result?.executed ?? []).filter((e) => e.mutated).flatMap(describeChanges);

  /**
   * ── ⭐⭐ THE TWO DURABLE RECORDS, AND THE FOUR RULES THEY OBEY ──────────────
   *
   * A session (so the next run can carry on) and an audit line (so a buyer can
   * answer "show me what it did on the fourteenth" after the terminal closed —
   * ENTERPRISE.md:162 lists the absence of the second as an adoption blocker).
   *
   * 1. ⚠️⚠️ NOT ONE BYTE ON STDOUT. Under `--json` stdout carries exactly one
   *    object; a friendly "saved as …" line there breaks `| jq` for everyone.
   *    Both records are silent on success, on every path, json or not — which is
   *    also what keeps a run with no new flags byte-identical to yesterday's.
   *
   * 2. ⚠️ A FAILED WRITE IS ANNOUNCED, NEVER SWALLOWED. `audit.mjs`'s header is
   *    emphatic: an audit log that quietly failed is worse than none, because
   *    the operator believes they have evidence and finds out on the day they
   *    need it. So a failure prints one line — to STDERR.
   *
   * 3. ⚠️ AND IT CAN NEVER FAIL THE RUN. The work is already on disk and the
   *    exit code is a verification verdict, not a bookkeeping one. Both calls
   *    are wrapped: a read-only `.acuvo/`, a full disk or a locked file costs
   *    the record, never the result.
   *
   * 4. ⚠️ `--dry-run` WRITES NEITHER. `--help` promises "touch nothing", and a
   *    dry run that creates two files in the workspace has broken that promise
   *    to save a record of a run that did not happen.
   */
  const persistRun = (turnTask, result) => {
    if (opts.dryRun) return;
    if (life.save) {
      try {
        const saved = saveSession(root, result, { task: turnTask });
        if (!saved.ok) process.stderr.write(`  · the run was not saved: ${saved.error}\n`);
      } catch (e) {
        process.stderr.write(`  · the run was not saved: ${e?.message ?? e}\n`);
      }
    }
    if (life.audit) {
      try {
        const logged = recordRun({ root, outcome: result, changes: changesOf(result), task: turnTask });
        if (!logged.ok) process.stderr.write(`  · ${logged.error}\n`);
      } catch (e) {
        process.stderr.write(`  · could not write the audit record: ${e?.message ?? e}\n`);
      }
    }
    announceCheckpoint();
  };

  /**
   * ── ⭐⭐ THE ONE LINE THAT MAKES THE UNDO EXIST ─────────────────────────────
   *
   * ⚠️ A CAPABILITY NOBODY IS TOLD ABOUT IS THE "BUILT BUT UNREACHABLE" DEFECT
   * THIS PACKAGE KEEPS SHIPPING — six modules once sat finished and imported by
   * nothing. A journal written silently would be the same failure wearing a
   * disk: the person who needs it is the person who does not yet know it exists,
   * and they will be looking at this scrollback when they need it.
   *
   * ⚠️ STDERR UNDER `--json`, like the banner and the lease line. Under `--json`
   * stdout carries exactly one object, and one friendly sentence there breaks
   * `| jq` for everybody.
   *
   * ⚠️ AND IT ANNOUNCES CHANGES, NOT RUNS. Interactive mode calls `persistRun`
   * every turn; reprinting the same id after a turn that wrote nothing is noise
   * that teaches people to stop reading the line.
   */
  let announcedFiles = 0;
  let announcedErrors = 0;
  const announceCheckpoint = () => {
    if (!journal) return;
    const out = opts.json ? process.stderr : process.stdout;
    if (journal.files > announcedFiles) {
      announcedFiles = journal.files;
      out.write(`  · checkpoint ${journal.runId} — ${announcedFiles} file${announcedFiles === 1 ? '' : 's'} can be put back: acuvo rewind ${journal.runId}\n`);
    }
    /**
     * ⚠️ A CHECKPOINT THAT FAILED TO RECORD IS WORSE THAN NONE — the operator
     * believes they can undo. Same rule `audit.mjs` states for a log that
     * quietly failed to write, and the reason `errors` exists at all.
     */
    for (const err of journal.errors.slice(announcedErrors)) out.write(`  ! ${err}\n`);
    announcedErrors = journal.errors.length;
  };

  /**
   * ── ⭐ ONE JSON SHAPE, BUILT ONCE, USED BY EVERY PATH THAT EMITS ONE ────────
   *
   * `--issue` and the one-shot path owe the caller the same document. Two object
   * literals would have drifted the first time either grew a field, and a
   * machine contract that varies by which flag you passed is not a contract.
   *
   * ⚠️⭐ `failed` EXISTS BECAUSE `ok` IS NOT THE PROCESS VERDICT — measured, and
   * this is the dangerous half of the defect. `toJson` sets `ok: outcome?.ok
   * !== false`, which means THE SESSION COMPLETED; a run whose `npm test` exits
   * 1 emits `ok: true` next to process exit code 1. To recover the verdict a
   * consumer had to reimplement `sessionFailed` — `j.ok && !(j.verification.ran
   * && !j.verification.passed)` — and nothing in the document told them so. So
   * `acuvo --json … | jq -e .ok && git push` pushed code whose suite fails.
   *
   * ⚠️ `ok` IS NOT REDEFINED. Scripts already read it and it answers a real
   * question ("did the agent finish, or did the provider die"). `failed` answers
   * the other one, and `exitCode` states the number this process is about to
   * exit with, so the document and the shell can never disagree — the callers
   * below return `doc.exitCode` rather than calling `sessionFailed` a second
   * time, which is what would let them drift.
   *
   * ⚠️ `dryRun` BECAUSE THE ONLY OTHER SIGNAL GOES TO STDERR. A dry run reports
   * its writes as `kind:"created"`, byte-identically to a real one; the 'DRY
   * RUN' banner that distinguishes them is deliberately sent to stderr under
   * `--json` — precisely where a machine consumer is told not to look. So
   * `… --dry-run --json | jq -r '.changes[].path' | xargs git add` believed
   * files existed that were never written.
   */
  /**
   * ⚠️⭐ `leaseLost` IS PART OF THE VERDICT, NOT A WARNING. A run whose file was
   * taken by another terminal mid-flight may have written over someone else's
   * work; `acuvo … && git push` must not believe that succeeded. Same reasoning
   * as `sessionFailed` itself — the exit code is the machine-readable version of
   * the verdict, and it has to agree with it.
   *
   * ⚠️ AND `budget` IS CARRIED INTO THE DOCUMENT because the one question a
   * script asks about an unattended run is what it cost. It is absent — not
   * zero — when no `--budget` was given, so the shape only grows for a caller
   * who asked for it.
   */
  /**
   * ── ⚠️ STRICT: A RUN THAT DID NOTHING IS NOT A SUCCESS ──────────────────────
   *
   * Measured from a real bench artifact: two rounds, nothing written, nothing
   * run, `exitCode: 0`. Every other clause of `sessionFailed` describes
   * something that happened, so none of them fire when nothing did.
   *
   * ⚠️ OPT-IN, because "what does this file do?" correctly writes nothing and a
   * check that fails correct work is worse than no check. ⭐ BUT ARMED
   * AUTOMATICALLY UNDER CI, because there the default is backwards: a build
   * step that reports success for doing nothing is the whole failure mode the
   * exit code exists to prevent, and nobody types a flag they have not read
   * about. `CI` is the one variable every runner sets.
   */
  /**
   * ⚠️ `Boolean(process.env.CI)` IS TRUE FOR THE STRING "false". Several CI
   * setups export `CI=false` deliberately, and Create React App made
   * `CI=false npm run build` a widely-copied incantation — so the naive check
   * would arm strict for people explicitly saying they are NOT in CI, and hand
   * them a false exit 1. That is the check-that-fails-correct-work failure,
   * inside the flag added to prevent its opposite.
   */
  const inCI = !['', '0', 'false', 'no', 'off'].includes(String(process.env.CI ?? '').trim().toLowerCase());
  const verdictOptions = { strict: opts.strict === true || inCI };

  const jsonDoc = (result, { task = null, fields = null } = {}) => {
    /**
     * ⚠️ THE DOCUMENT AND THE SHELL MUST NEVER DISAGREE — that is the whole
     * reason `exitCode` is in here. So the interrupt has to be visible on BOTH:
     * `verdictExit` returns 130 and this said 1, which is exactly the drift the
     * field was added to prevent, and a `| jq .exitCode` consumer would have
     * been told a cancelled run was a failed one.
     */
    const stoppedByCtrlC = wasAbortedByInterrupt({ interrupted: interruptedRun, outcome: result });
    const failed = sessionFailed(result, verdictOptions) || leaseLost !== null || stoppedByCtrlC;
    return {
      ...toJson(result, { changes: changesOf(result), task }),
      failed,
      exitCode: stoppedByCtrlC ? EXIT_INTERRUPTED : (failed ? EXIT_FAILED : EXIT_OK),
      ...(stoppedByCtrlC ? { interrupted: true } : {}),
      dryRun: opts.dryRun === true,
      ...(result?.budget ? { budget: result.budget } : {}),
      ...(leaseLost ? { leaseLost } : {}),
      ...(fields ?? {}),
    };
  };

  /**
   * The process verdict. One helper so the four return sites cannot drift —
   * which is exactly how one of them would end up ignoring a lost lease.
   */
  /**
   * ── ⭐⭐ THE SECOND OPINION, AND WHY IT RUNS ONLY ON A CLAIMED SUCCESS ──────
   *
   * Refuting a run that already failed buys nothing — the first verdict is
   * already the honest one, and a second paid run to agree with it is money for
   * a sentence nobody needed. The claim worth testing is `✔ VERIFIED`, because
   * that is the one somebody is about to act on.
   *
   * ⚠️ ONLY A CONCRETE REFUTATION FLIPS THE EXIT CODE. An opinion, an
   * uncertainty, or a refuter that crashed leaves the verdict exactly as it was:
   * failing correct work is the worse error, and an adversarial reviewer is
   * precisely the mechanism most likely to commit it.
   */
  const secondOpinion = async (outcome, alreadyFailed) => {
    if (!opts.refute || alreadyFailed) return null;
    /**
     * ⚠️ THE SECOND OPINION SPENDS WHAT IS LEFT OF THE NUMBER YOU TYPED, not a
     * fresh copy of it. A refuter with its own full ceiling would quietly turn
     * `--budget 0.02` into four cents — the exact "a limit that is really a
     * rate" defect fixed for schedules an hour ago, reintroduced by the feature
     * meant to increase trust.
     *
     * `null` (a `--budget none` run) passes through unbounded, as that run asked.
     */
    const spent = Number.isFinite(outcome?.usage?.cost) ? outcome.usage.cost : 0;
    const left = opts.budgetUsd === null ? null : Math.max(0, opts.budgetUsd - spent);
    if (left !== null && left <= 0) {
      (opts.json ? process.stderr : process.stdout).write(
        '\n  · no second opinion: the run used its whole budget, and refuting costs a run. Raise --budget to check it.\n',
      );
      return null;
    }
    const r = await refuteClaim({
      task,
      claim: outcome?.note ?? outcome?.content ?? '',
      executor,
      config,
      budgetUsd: left,
      fleetGate: createFleetGate(root, { fleetLimitUsd: opts.fleetBudgetUsd, since: opts.budgetWindow }),
      commandTimeoutMs: opts.commandTimeoutMs,
    });
    (opts.json ? process.stderr : process.stdout).write(`${['', `  ${formatRefutation(r)}`, ''].join(String.fromCharCode(10))}`);
    return r;
  };

  const verdictExit = (outcome) => {
    /**
     * ── ⭐⭐ AN INTERRUPT IS NOT A VERDICT ───────────────────────────────────
     *
     * ⚠️ Counted as `failed` for the BOARD's purposes — a run the user stopped
     * did not finish its task, so the claim goes back on the board rather than
     * being marked done — and reported as **130** rather than 1 to the shell,
     * because exit 1 here means "the code it wrote still does not pass" and a
     * script that cannot tell those apart retries the wrong one.
     *
     * ⚠️ `wasAbortedByInterrupt` needs BOTH halves: a press that lands during
     * the final round leaves a completed, verified run, and reporting 130 for
     * that would tell a caller to retry a job that succeeded.
     */
    const stoppedByCtrlC = wasAbortedByInterrupt({ interrupted: interruptedRun, outcome });
    const failed = sessionFailed(outcome, verdictOptions) || leaseLost !== null || stoppedByCtrlC;

    /**
     * ── ⭐ "I CHOSE NOT TO RUN" IS NOT "I RAN AND FAILED" ────────────────────
     *
     * Under `--unattended` these need opposite reactions: a fleet ceiling
     * declining a run is the schedule behaving exactly as instructed, and a run
     * that started and broke is something to look at. They shared exit 1, and
     * the harmless one is far more common — which is precisely how somebody
     * learns to ignore the alert that mattered.
     *
     * ⚠️ ONLY WHEN IT DECLINED, not when it was cut off mid-way. A run that did
     * some work and then hit the ceiling has left the job half-finished, and
     * half-finished IS something to look at. `executed.length === 0` is the
     * difference between the two, and it is the whole distinction.
     *
     * ⚠️ The reason list is `FLEET_STOP_REASONS` from budget.mjs rather than two
     * retyped strings — the same anti-drift rule that put them there.
     */
    if (opts.unattended
      && FLEET_STOP_REASONS.includes(outcome?.stoppedBecause)
      && (outcome?.executed?.length ?? 0) === 0) {
      (opts.json ? process.stderr : process.stdout).write(
        `  declined: the fleet ceiling is spent, so nothing was started. Exit ${EXIT_SKIPPED} — this is the schedule working, not a failure.
`,
      );
      return EXIT_SKIPPED;
    }
    /**
     * ── ⭐⭐ A CLAIMED TASK IS CLOSED BY THE VERDICT, NOT BY FINISHING ────────
     *
     * Found by RUNNING a real three-terminal fleet rather than by testing it:
     * t1, t2 and t3 each claimed a different task, each fixed its bug correctly,
     * all three exited 0 — and `acuvo board` still said **3 open, 0 done**. The
     * code was fixed and the board was lying about the state of the world,
     * which is the one thing a board must never do.
     *
     * ⚠️ MARKED DONE ON THE HONEST VERDICT, NOT ON EXIT 0. `sessionFailed` is
     * this package's whole argument about verification — a run that wrote
     * nothing, or ran nothing, or was cut off by the budget, is not a finished
     * task however cleanly the process ended. Closing on "the process returned"
     * would turn the board into a list of things that were ATTEMPTED, and a
     * fleet owner reading ✔ would have to re-check every one.
     *
     * ⭐ A failed attempt RELEASES instead, so the task returns to the board and
     * the next terminal — or the same one, later — can pick it up. That is the
     * behaviour that makes an overnight fleet safe to leave alone: work that did
     * not land is still on the list in the morning.
     */
    if (claimed?.ok) {
      if (!failed) {
        const done = boardDone(root, claimed.id, { lease: claimed.lease });
        if (done.ok) (opts.json ? process.stderr : process.stdout).write(`  board: ${claimed.id} done
`);
      } else {
        try { releaseAll([claimed.lease]); } catch { /* the TTL will clear it */ }
        (opts.json ? process.stderr : process.stdout).write(`  board: ${claimed.id} left OPEN — this run did not verify, so the task goes back on the board
`);
      }
      claimed = null;   // the exit hook must not release a lease already handed back
    }
    if (stoppedByCtrlC) {
      (opts.json ? process.stderr : process.stdout).write(
        `  ⏹ stopped by Ctrl-C. The transcript, the cost and the changes were all saved — \`acuvo --resume\` carries on from here. Exit ${EXIT_INTERRUPTED}.\n`,
      );
      return EXIT_INTERRUPTED;
    }
    return failed ? EXIT_FAILED : EXIT_OK;
  };

  /**
   * ── ⭐ NO TASK ⇒ INTERACTIVE SESSION ──────────────────────────────────────
   * `acuvo "do a thing"` behaves exactly as before. `acuvo` on its own opens a
   * conversation, because the second instruction should not cost what the first
   * did — measured, an unchanged prefix caches at 97.2% and the call is 4.3x
   * cheaper, so appending turns is nearly free while rebuilding them is not.
   *
   * ⚠️ INTERACTIVE MODE ALWAYS EXITS 0. The one-shot exit code is a verification
   * verdict a script can branch on; a conversation has many verdicts and the
   * last one is not the session's. Reporting the final turn as the process
   * result would make `acuvo` unusable in a shell that checks `$?`.
   */
  /**
   * ── ⭐ PARALLEL: SEVERAL TASKS, ONE WORKSPACE ─────────────────────────────
   * Bounded concurrency, and a conflict report if two tasks wrote the same file.
   *
   * ⚠️ EACH TASK GETS ITS OWN EXECUTOR but they share the DIRECTORY, so the
   * collision is real and the honest answer is to detect it rather than pretend
   * to merge. Two model-authored versions of one file cannot be reconciled
   * without a human, and the last writer silently winning is the failure this
   * whole path is designed around.
   *
   * ⚠️ Per-task output is SUPPRESSED. Four interleaved streams are unreadable —
   * you cannot tell which round belongs to which task — so the live view is one
   * line per task as it finishes, and the detail lands in the summary.
   */
  /**
   * ── ⭐⭐ `--issue 42` — READ IT, BRANCH, FIX IT ────────────────────────────
   * The whole job in one command. Everything after this point is the ordinary
   * loop; the only new thing is where the task came from.
   *
   * ⚠️ IT STOPS AT A LOCAL BRANCH. No push, no pull request — both are outward
   * -facing acts on the user's account that their colleagues can see, and an
   * agent that opens a PR because it believed it was finished embarrasses
   * someone in front of their team. It prints the exact commands instead.
   */
  if (opts.issue !== null) {
    /**
     * ⚠️ EVERY HUMAN LINE IN THIS BRANCH GOES TO STDERR UNDER `--json`. It used
     * to write four of them to stdout unconditionally, so
     * `acuvo --json --issue 42 | jq` died on "· reading acme/widgets#42" long
     * before any document appeared — and then the branch returned without
     * emitting one at all. Same rule as the banner and `onEvent`: everything
     * human goes to stderr, EVERYTHING. It is still printed, not suppressed:
     * a person watching a `--json` run in a terminal still wants to see which
     * issue was read and which branch was made.
     */
    const say = (text) => (opts.json ? process.stderr : process.stdout).write(text);
    const repo = detectRepo(root);
    if (!repo.ok) die(repo.error, EXIT_USAGE);
    const auth = findToken();
    if (!auth.ok) die(auth.error, EXIT_UNCONFIGURED);

    say(`  · reading ${repo.owner}/${repo.repo}#${opts.issue} (via ${auth.source})\n`);
    const issue = await fetchIssue({ owner: repo.owner, repo: repo.repo, number: opts.issue, token: auth.token });
    if (!issue.ok) die(issue.error, EXIT_FAILED);
    say(`  · #${issue.number} ${issue.title}\n`);

    const branch = branchNameFor(issue);
    const made = createBranch(root, branch);
    if (!made.ok) die(made.error, EXIT_FAILED);
    say(`  · ${made.reused ? 'reusing' : 'created'} branch ${made.branch}\n\n`);

    // Named, because the JSON must report the task that was actually sent —
    // `opts.task` is empty here, and reporting null would hide the framing the
    // issue body was wrapped in.
    const task = issueToTask(issue);
    const outcome = await steerable(task, null);
    say(`${formatSummary(outcome).join(String.fromCharCode(10))}\n`);
    say(`${nextSteps({ owner: repo.owner, repo: repo.repo, branch: made.branch, issue }).join(String.fromCharCode(10))}\n`);
    if (opts.json) {
      // ⭐ `issue` and `branch` are the two facts this path knows and the
      // one-shot path cannot: without them a script has to parse the branch
      // name out of the prose it was just told not to read.
      const doc = jsonDoc(outcome, { task, fields: { issue: opts.issue, branch: made.branch } });
      process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
      return doc.exitCode;
    }
    return verdictExit(outcome);
  }

  if (opts.parallel) {
    process.stdout.write(`\n  running ${opts.tasks.length} tasks, ${opts.concurrency} at a time\n\n`);
    const started = Date.now();
    const results = await runPool(
      opts.tasks,
      async (task, i) => {
        const outcome = await runSession({
          task,
          executor: createLocalExecutor(root, { dryRun: opts.dryRun }),
          config,
          maxTokens: opts.maxTokens,
          timeoutMs: opts.timeoutMs,
          maxRounds: opts.maxRounds,
          allowRun: opts.allowRun && !opts.dryRun,
          shell: opts.shell,
          commandTimeoutMs: opts.commandTimeoutMs,
          /**
           * ── ⚠️⚠️ THE PROMISE WAS MADE IN THE REFUSAL AND KEPT NOWHERE ─────
           *
           * `cli-args.mjs` REFUSES `--budget` with `--parallel`, and its stated
           * reason is that the default already applies: *"the default has no
           * surprise to prevent: it is a per-run blast radius by construction,
           * so N conversations getting N × $0.02 is what it means."*
           *
           * That was false. This call passed no `budgetUsd`, `runSession`
           * defaults it to null, and null is UNLIMITED — so the N × $0.02 the
           * refusal message promises was N × unbounded. Measured: a `--parallel`
           * run printed no budget line for either session, while a single run in
           * the same session printed one.
           *
           * ⭐ Now each conversation really does get the default ceiling, which
           * is what the refusal already told the user they were getting. The
           * message needed no change; the code had to catch up to it.
           */
          budgetUsd: DEFAULT_BUDGET_USD,
          onEvent: () => {},
        });
        /**
         * ⚠️ THE FAN-OUT PATH BUILDS ITS OWN SESSION rather than going through
         * `oneTurn` (different executor, silenced events), so the record has to
         * be taken here too. Leaving it out is precisely how "every invocation
         * persists" becomes "every invocation except the one that ran four" —
         * and the parallel path is the one whose scrollback is least readable,
         * so it is the one most in need of a durable record.
         */
        persistRun(task, outcome);
        const wrote = (outcome?.executed ?? []).filter((e) => e.mutated).length;
        process.stdout.write(`  ${outcome?.ok === false ? '✖' : '✔'} ${shortLabel(task, i)}  (${wrote} file${wrote === 1 ? '' : 's'})\n`);
        return outcome;
      },
      { concurrency: opts.concurrency },
    );

    const analysis = detectConflicts(results);
    process.stdout.write(`${formatParallelSummary(results, analysis).join('\n')}\n`);
    process.stdout.write(`  ${((Date.now() - started) / 1000).toFixed(0)}s\n\n`);
    /**
     * ⚠️ A CONFLICT IS A NON-ZERO EXIT. A script that fans out work must be able
     * to notice that one task's output was overwritten by another — reporting
     * success there would be the same silent-success failure the verifier had.
     */
    /**
     * ⚠️ `sessionFailed`, NOT `outcome.ok === false` — the parallel path had the
     * SAME hole as the single one (ENTERPRISE §3.5): a session killed by a
     * provider outage is never `ok:false`, so a fan-out where three of four
     * tasks died on a 429 reported success. One verdict function, used
     * everywhere, is the only way these cannot drift apart again.
     */
    return analysis.conflicts.length > 0 || results.some((r) => !r?.ok || sessionFailed(r.outcome))
      ? EXIT_FAILED
      : EXIT_OK;
  }

  /**
   * ⚠️ `task`, NOT `opts.task` — A RESUME WITH NO NEW INSTRUCTION IS A TASK.
   * `acuvo --continue` supplies the previous run's task above, so testing
   * `opts.task` here would drop a resumed conversation into interactive mode and
   * throw away the messages that were just rebuilt. With no lifecycle flag,
   * `task === opts.task` and this branch is byte-identical to before.
   */
  if (!task) {
    await runChat({
      // ⭐ STEERABLE, not oneTurn: a conversation turn is exactly as long as a
      // one-shot run and just as worth redirecting. Ctrl-C returns you to the
      // prompt; a steer keeps the turn going with new instructions.
      runOne: steerable,
      render: (result, out) => out.write(formatSummary(result).join(String.fromCharCode(10)) + String.fromCharCode(10)),
      /**
       * ── ⭐ WHAT THE `/` COMMANDS REPORT ON ────────────────────────────────
       *
       * ⚠️ THIS OBJECT IS THE WHOLE FEATURE. `lib/slash.mjs` is pure and knows
       * nothing about disk or spend; without these providers every command
       * would honestly answer "not available in this session" and the surface
       * would be built-but-unreachable — the defect this repo has shipped four
       * times in one day, inside the commits fixing it.
       *
       * ⚠️ EVERY PROVIDER IS CALLED AT THE MOMENT THE COMMAND IS TYPED, never
       * captured up front. `/skills` after dropping a new file into
       * `.acuvo/skills/` must see it, and `/cost` read once at startup would
       * report $0.000000 for the whole session.
       */
      slashContext: {
        skills: () => (discoverAllSkills(root)?.skills ?? []).map((s) => ({ name: s.name, description: s.description })),
        loadSkill: (name) => loadAnySkill(root, name),
        mcp: () => {
          const cfg = readMcpConfig(root);
          // ⚠️ A BROKEN CONFIG IS REPORTED AS ITSELF. `{ servers: [] }` here
          // would say "you have no MCP servers" to someone whose mcp.json has a
          // syntax error — the wrong problem, and they would go looking for it
          // in the wrong file.
          if (!cfg?.ok) return { source: cfg?.error ? `a config error: ${cfg.error}` : null, servers: [] };
          return {
            /**
             * ⚠️ `cfg.file`, AND NULL WHEN THERE IS NO FILE — not a default
             * path string. `slash.mjs` reads a `source` on an empty list as
             * "there is a reason these are unusable", so defaulting it here
             * would tell every workspace WITHOUT an mcp.json that its
             * non-existent config was broken.
             */
            source: cfg.file ?? null,
            servers: (cfg.servers ?? []).map((s) => ({
              name: s.name,
              transport: s.transport,
              // ⚠️ NOT "connected". Servers are connected per RUN, and nothing
              // is held open between turns, so the only honest thing this can
              // report is that it is configured. Claiming a live connection we
              // have not made is exactly the lie `imagegen`'s honesty tests exist for.
              status: 'configured',
            })),
          };
        },
        cost: () => ({
          spentUsd: sessionSpentUsd,
          limitUsd: opts.budgetUsd,
          limitIsDefault: opts.budgetExplicit !== true,
        }),
        model: () => ({
          name: config.model,
          /**
           * ⚠️ THE ROUTE IS PART OF THE ANSWER. Two sessions on the same model
           * id can differ ~4.6x in cost depending on which upstream served
           * them, and nothing errors when the expensive one does. `null` until
           * a turn has actually run — `renderModel` omits an absent note, so an
           * unknown route says nothing rather than something reassuring.
           */
          note: routingNote(lastProviders),
          source: opts.model ? '--model' : 'the configured default',
        }),
      },
    });
    return EXIT_OK;
  }

  /**
   * ── ⭐⭐ BEST-OF-N — THE CAPABILITY OUR PRICE BUYS ────────────────────────
   *
   * Do the task several times in isolated copies, keep the one that actually
   * PASSED. At ~$0.001 a run, three attempts cost a third of a cent; an agent
   * billing a hundred times that cannot offer this at all — not for lack of the
   * idea, but because the arithmetic forbids it.
   *
   * ⚠️ IT SITS AFTER THE RESUME BRANCH ON PURPOSE. Resuming rebuilds ONE
   * conversation; forking it into three divergent continuations and keeping one
   * would silently discard two histories the user believed they were carrying.
   */
  /**
   * ⚠️ `!opts.untilDone` — THE TWO FEATURES COLLIDED ON THE SAME FLAG. Both use
   * `--best-of n`, and this branch sits first, so `--until-done --budget 2
   * --best-of 4` would have run ONE round of parallel attempts and exited,
   * silently discarding the escalation the user asked for. Under `--until-done`
   * the flag means "how wide the ladder's top rung is" and the ladder owns it.
   */
  if (opts.bestOf >= 2 && !opts.untilDone) {
    if (resumeRequested) {
      die('--best-of starts several independent attempts; --resume carries one conversation forward. Pick one.', EXIT_USAGE);
    }
    const best = await runBestOf({
      root,
      attempts: opts.bestOf,
      /**
       * ⚠️ AN ADAPTER, NOT `runPool` DIRECTLY — and passing it directly is
       * exactly what failed first. `runPool(tasks, runOne, opts)` takes THREE
       * arguments and wraps each result as `{ok, index, task, outcome}`, so
       * handing it `(jobs, {concurrency})` bound the options object to `runOne`
       * and then double-wrapped every attempt. The symptom was quiet: the
       * best-of report printed perfectly and the winning file was never applied,
       * because `winner.outcome.executed` was `undefined` two levels down.
       *
       * ⭐ A shape mismatch between two of our own modules produced a plausible
       * report and no work — which is worse than a crash, and is why the
       * end-to-end test that caught it exists.
       */
      pool: async (jobs, { concurrency }) => {
        const results = await runPool(jobs, (job) => job(), { concurrency });
        return results.map((r) => (r.ok ? r.outcome : { error: r.error }));
      },
      concurrency: Math.min(2, opts.bestOf),
      failed: sessionFailed,
      runOne: async ({ root: attemptRoot, label }) => {
        /**
         * ⚠️ NOT `say()`. Both `say` helpers in this file are declared INSIDE
         * other branches, so neither is in scope here — using one would be a
         * ReferenceError at the moment the feature is first exercised, which is
         * precisely the `changes is not defined` bug that shipped this morning
         * on a path no test entered. Checked rather than assumed this time.
         */
        (opts.json ? process.stderr : process.stdout).write(`  ${label} …\n`);
        return runSession({
          task,
          executor: createLocalExecutor(attemptRoot, { dryRun: opts.dryRun }),
          config,
          maxTokens: opts.maxTokens,
          timeoutMs: opts.timeoutMs,
          maxRounds: opts.maxRounds,
          allowRun: opts.allowRun && !opts.dryRun,
          shell: opts.shell,
          commandTimeoutMs: opts.commandTimeoutMs,
          /**
           * ── ⚠️⚠️ THE CEILING WAS MISSING ON THE MODE THAT SPENDS THE MOST ──
           *
           * `runSession` defaults `budgetUsd = null`, which means UNLIMITED. So
           * `--best-of N` ran N full sessions with no wall at all, bounded only
           * by the round cap — on the one mode whose entire purpose is to spend
           * several times over.
           *
           * ⚠️ AND WORSE THAN ABSENT: an explicit `--budget` was ACCEPTED
           * without complaint and silently discarded. Measured — `--best-of 2
           * --budget 0.005` ran both attempts and printed no budget line at
           * all. Taking a user's instruction about money and dropping it is a
           * different and worse failure than never offering the feature.
           *
           * ⭐ AN EXPLICIT BUDGET IS A TOTAL, NOT A PER-ATTEMPT ALLOWANCE.
           * Someone typing `--best-of 5 --budget 0.05` means "spend at most five
           * cents", not "spend up to twenty-five". Dividing is the reading that
           * cannot surprise them; the alternative multiplies their number by N
           * and would be indefensible on an invoice.
           */
          budgetUsd: bestOfAttemptBudget(opts),
          // ⚠️ Silent per attempt. Three interleaved round-by-round streams are
          // unreadable, and the report below is what the user acts on.
          onEvent: () => {},
        });
      },
    });
    process.stdout.write(`${formatBestOf(best)}\n`);
    if (!best.ok) return EXIT_FAILED;
    /**
     * ⚠️ THE EXIT CODE FOLLOWS THE WINNER, not the fact that a run happened. If
     * nothing verified, `acuvo --best-of 3 … && git push` must NOT push.
     */
    return best.winner ? verdictExit(best.winner) : EXIT_FAILED;
  }

  /**
   * ── ⭐⭐ THE UNATTENDED RUN CLIMBS THE LADDER ──────────────────────────────
   *
   * `--until-done --budget X` is the only mode that runs for hours with nobody
   * watching, and until now it was also the only mode that could not use the
   * one capability nobody can copy us on. `runBestOf` had a single caller — the
   * `--best-of` branch above — which refuses to combine with `--resume` and
   * runs exactly once. So the mode that most needed "try harder" was the mode
   * structurally forbidden from it.
   *
   * ⚠️ GATED ON `--budget`, NOT ON `--until-done` ALONE. Escalation spends real
   * money on someone's behalf while they are asleep; doing that without a
   * ceiling is the single most dangerous thing in this package, which is why
   * `cli-args.mjs:483` already refuses `--until-done` without one. This branch
   * inherits that refusal rather than restating it.
   *
   * ⚠️ AND NOT WITH `--resume`. Same reason the `--best-of` branch refuses it:
   * the fresh rung deliberately DISCARDS the conversation, so carrying one
   * forward and then throwing it away would silently do the opposite of what
   * `--resume` promises.
   */
  if (opts.untilDone && opts.budgetUsd !== null && !resumeRequested) {
    const say = (line) => (opts.json ? process.stderr : process.stdout).write(line);
    const ladder = await escalate({
      root,
      task,
      budget: createBudget({ limitUsd: opts.budgetUsd, limitIsDefault: opts.budgetExplicit !== true, limitSource: opts.budgetSource ?? null, fleetGate: createFleetGate(root, { fleetLimitUsd: opts.fleetBudgetUsd, since: opts.budgetWindow }) }),
      // ⭐ Tier 0, and the only tier unless ACUVO_MODEL_TIERS is configured.
      baseModel: config.model,
      /**
       * ⭐ `--best-of n` DOUBLES AS THE LADDER'S TOP-RUNG WIDTH. One flag, one
       * meaning — "how many independent attempts" — rather than a second
       * `--attempts` that would differ from it by nothing.
       */
      attempts: opts.bestOf >= 2 ? opts.bestOf : undefined,
      maxTier: opts.maxTier,
      /**
       * ⚠️ THE EXIT-CODE VERDICT **PLUS** "WAS IT CUT OFF" — and the second half
       * is not optional. `sessionFailed` alone was the first wiring here and it
       * silently disabled the whole feature: it does not fail a run that
       * verified nothing, so a session that ran out of budget mid-task read as
       * a success and the ladder never climbed once. Measured, not reasoned —
       * see `outOfRoad`'s header for the run that caught it.
       */
      verified: (o) => !sessionFailed(o) && !outOfRoad(o),
      pool: async (jobs, { concurrency }) => {
        const results = await runPool(jobs, (job) => job(), { concurrency });
        return results.map((r) => (r.ok ? r.outcome : { error: r.error }));
      },
      onEvent: (ev) => {
        /**
         * ⚠️ ONLY THE CLIMB IS ANNOUNCED LIVE, and the omission is deliberate.
         * `escalate-up` is worth interrupting for — a long unattended run should
         * say out loud that it is now spending more. `escalate-skipped` fires
         * immediately before the ladder returns, so printing it here AND in the
         * report below is the same sentence twice, which `formatSummary` already
         * has a comment about: a repeat reads as a malfunction, not a report.
         */
        /**
         * ⚠️ A MODEL SWITCH IS SAID OUT LOUD, ALWAYS. A run that quietly moves to
         * a pricier model has changed what it costs without telling the person
         * paying, and "why was this bill different" must never be unanswerable.
         */
        if (ev.type === 'escalate-model') {
          say(`
  ↑ ${ev.note}
`);
        } else if (ev.type === 'escalate-up') {
          say(`\n  ↑ ${ev.from} did not verify — escalating to ${ev.to} (~${ev.projectedUsd.toFixed(4)} projected, ${ev.remainingUsd.toFixed(4)} left)\n`);
        }
      },
      runOne: async ({ root: dir, task: rungTask, tier, budgetUsd, model }) => {
        if (tier === 'best-of') {
          say(`  · attempt running in ${shortenRoot(dir)}\n`);
          return oneTurn(rungTask, null, {
            executor: createLocalExecutor(dir, { dryRun: opts.dryRun }),
            budgetUsd,
            quiet: true,
            model,
          });
        }
        return oneTurn(rungTask, null, { budgetUsd, model });
      },
    });

    const final = ladder.outcome;
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(jsonDoc(final, { task, fields: { escalation: { stopped: ladder.stopped, tier: ladder.tier, rungs: ladder.rungs, skipped: ladder.skipped, spentUsd: ladder.spentUsd } } }), null, 2)}\n`);
      return final ? verdictExit(final) : EXIT_FAILED;
    }

    for (const line of formatSummary(final ?? { ok: false, error: ladder.error ?? 'nothing ran' })) {
      process.stdout.write(`${line}\n`);
    }

    /**
     * ── ⚠️⚠️ THE LADDER'S TOTAL IS PRINTED **LAST**, AND THAT IS A HONESTY FIX
     *
     * MEASURED, real run: the report was printed BEFORE the summary, so the
     * final line on screen was the last rung's own ledger — `$0.0012` — while
     * the run had actually spent `$0.0083`. Every number was individually true
     * and the one a human reads last understated the bill by 7x. `formatSummary`
     * describes ONE session and cannot know about the other four; the only
     * place that knows the total is here, so the total goes last.
     *
     * ⚠️ AND ONLY WHEN THE LADDER WAS ACTUALLY USED. A run that verified on the
     * first rung is byte-identical to yesterday's output — a new flag that
     * changes the look of every existing run is a regression dressed as a
     * feature.
     */
    const climbed = (ladder.rungs?.length ?? 0) > 1 || (ladder.skipped?.length ?? 0) > 0;
    if (climbed) process.stdout.write(`\n${formatEscalation(ladder)}\n`);

    return final ? verdictExit(final) : EXIT_FAILED;
  }

  /**
   * ── ⭐⭐⭐ `--plan` — SAY WHAT YOU INTEND, AND DO NOTHING UNTIL I AGREE ─────
   *
   * ⚠️⚠️ THE TWO FLAGS PEOPLE ALREADY REACH FOR ARE NOT THIS, and the whole
   * reason this gate had to be built is that both of them look like it.
   * `--dry-run` prints the writes it WOULD have made — after the model has
   * already decided what they are, which is the decision you wanted to see.
   * `--no-run` withholds the process spawners and leaves writing untouched.
   * Both are about the ACT; neither is about the INTENT, and neither has a
   * place to say no.
   *
   * ⭐ EVERY PART OF IT ALREADY EXISTED. `ORIENT_TOOLS` (plan-coherence.mjs) is
   * the read-only subset; `createAsker` (prompt.mjs) is the question, and it is
   * already the thing that decides whether `ask_user` is offered at all;
   * `toolNamesForRounds` (tools.mjs) already varies the offer by round budget.
   * Nothing joined them. This is the join, and `runPlanGate` holds the parts
   * that can be tested without a terminal.
   *
   * ⚠️ THE OFFER IS AN INTERSECTION, COMPUTED FROM THIS MACHINE. `root` and
   * `env` decide whether `read_skill` and the four LSP verbs exist here at all,
   * so the read-only list is `toolNamesForRounds(...) ∩ ORIENT_TOOLS` rather
   * than a constant — a constant would ship the dead buttons tools.mjs spends
   * four hundred lines refusing to ship.
   *
   * ⚠️ AND THE ROUND BUDGET IS THE PROPOSAL'S, NOT THE RUN'S. `planModeRounds`
   * clamps to 2..5: below two, `toolNamesForRounds` collapses to the write-only
   * single-shot list and the intersection is EMPTY (a model handed no tools and
   * asked to plan); above five the proposal starts eating the budget the user
   * typed for the work. The dollar ceiling is untouched — the proposal draws
   * from the same `--budget` through `oneTurn`'s existing subtraction, so
   * `--plan` cannot double what the user agreed to spend.
   *
   * ⚠️ IT SITS ON THE ORDINARY SINGLE-RUN PATH ONLY, deliberately. `--parallel`,
   * `--best-of`, `--issue` and the escalation ladder each run several attempts
   * of a decision already made; an approval prompt per attempt is an interview,
   * and one shared approval across attempts approves a plan three of them never
   * proposed. Those paths return above this line and are byte-identical.
   */
  if (opts.plan) {
    const out = () => (opts.json ? process.stderr : process.stdout);
    const planRounds = planModeRounds(opts.maxRounds);
    const readOnly = planModeToolNames(toolNamesForRounds(planRounds, {
      allowRun: false,
      root: executor.root,
      interactive: asker !== null,
    }));
    if (!readOnly.ok) die(`  ${readOnly.error}\n`, EXIT_USAGE);

    const gate = await runPlanGate({
      task,
      ask: asker,
      print: (text) => out().write(text),
      propose: () => {
        out().write(`  · planning first — read-only, ${planRounds} round${planRounds === 1 ? '' : 's'}, `
          + `${readOnly.names.length} reading tools; writes are refused at the executor, not just withheld\n`);
        return oneTurn(planPhaseTask(task), null, {
          maxRounds: planRounds,
          allowRun: false,
          toolNames: readOnly.names,
          /**
           * ── ⚠️⚠️ THE THIRD OVERRIDE, AND IT IS THE ONE THAT MAKES THE
           *        HEADLINE PROMISE TRUE ───────────────────────────────────
           *
           * `toolNames` narrows what the model is SHOWN and `allowRun: false`
           * stops the dispatcher spawning a process. Neither stops a WRITE:
           * `executeToolCall` is a switch on the tool name, `case 'write_file'`
           * calls `executor.writeFile` with nothing in between, and `allowRun`
           * is (correctly) not consulted because a write starts no process.
           *
           * ⚠️ MEASURED THROUGH THIS EXACT OPTION SET, 2026-08-20: a scripted
           * `write_file` for a tool absent from the 13-name offer returned
           * `ok:true, mutated:true` and left the file on disk; `edit_file`
           * rewrote a source file; `delete_file` removed one. Three mutations
           * during the phase whose whole promise is that there are none.
           *
           * ⭐ `over.executor` was ALREADY a supported override (`oneTurn` does
           * `over.executor ?? executor`) and nothing had ever used it. This is
           * the join, and it is structural rather than name-based: every write
           * verb in the dispatcher reaches disk through writeFile/deleteFile/
           * moveFile, including the ones a `delegate` helper would use, so a
           * tool added next year is covered without a list being updated.
           */
          executor: planPhaseExecutor(executor),
        });
      },
    });

    if (!gate.proceed) {
      /**
       * ⚠️ EXIT 0 ON `declined`, AND NON-ZERO ON EVERYTHING ELSE. A person
       * reading a plan and saying no is the feature working; failing the process
       * for it would make `--plan` unusable in any script that checks a status.
       * A refusal for want of a terminal or want of a plan IS a failure — the
       * run was asked for and did not happen — and `--unattended` already
       * exists for callers that need to tell "chose not to" from "could not".
       */
      out().write(`\n  ${gate.reason === 'declined' ? '✖ plan declined' : '✖ --plan could not run'} — ${gate.why}\n`);
      return gate.reason === 'declined' ? EXIT_OK : EXIT_USAGE;
    }
    out().write(`  ✔ plan approved${gate.decision === 'amend' ? ' with an amendment' : ''} — starting work\n\n`);
    /**
     * ⭐ THE APPROVED PLAN BECOMES THE TASK, and it carries an instruction to
     * record itself with `plan_start` and mark it with `plan_step`. That is the
     * line that makes the approval BIND rather than merely happen: without a
     * ledger there is nothing for `detectDrift` to compare the run against and
     * nothing for the reconciliation block below to reconcile.
     */
    task = gate.task;
  }

  const outcome = await steerable(task, priorMessages);

  /**
   * ── ⚠️⚠️ THE SECOND OPINION USED TO BE SKIPPED IN THE MODE THAT NEEDS IT ───
   *
   * `secondOpinion` was called THIRTY LINES BELOW the `if (opts.json)` early
   * return, so `--json --refute` accepted the flag, charged nothing, ran no
   * refutation, and left NO field in the document to say it had been skipped.
   * Found independently by three dogfood agents, and confirmed by source read.
   *
   * ⚠️ AND IT IS THE EXACT COMBINATION CI USES — `--json` to parse, `--refute`
   * for the trust gate. So the one mode where nobody is watching the terminal
   * was the one that silently dropped the check. This file's own comment says
   * the refuter exists because "the claim worth testing is ✔ VERIFIED, because
   * that is the one somebody is about to act on"; under `--json` that claim was
   * never tested, and a script acted on it.
   *
   * ⭐ It moves ABOVE the return rather than being duplicated inside it: two
   * call sites for one decision is how the human and machine paths drift, which
   * is the defect this whole cluster is made of. `secondOpinion` already routes
   * its own prose to stderr when `opts.json` is set, so the one-object-on-stdout
   * contract holds without any change to it.
   */
  /**
   * ⚠️ A CANCELLED RUN IS NOT REFUTED, IT IS UNFINISHED — and refuting costs a
   * whole extra model run. Paying an adversarial reviewer to disprove work the
   * user just stopped mid-way is spending money to be told what the user
   * already knows. `alreadyFailed` is the existing gate for exactly this
   * ("don't buy a second opinion on a run we already call failed"), so the
   * interrupt joins it rather than growing a second skip condition.
   */
  const alreadyFailed = sessionFailed(outcome, verdictOptions) || leaseLost !== null
    || wasAbortedByInterrupt({ interrupted: interruptedRun, outcome });
  const opinion = await secondOpinion(outcome, alreadyFailed);

  if (opts.json) {
    /**
     * ⚠️ ONE OBJECT ON STDOUT AND NOTHING ELSE. Every human line already went
     * to stderr (see onEvent), so `acuvo --json … | jq .verification.passed`
     * works with no flags and no grepping of prose that we keep improving.
     *
     * ⚠️ AND THE EXIT CODE IS READ BACK OUT OF THE DOCUMENT, not recomputed.
     * `doc.exitCode` is the same `sessionFailed` result the object reports, so
     * a run can never tell the shell one thing and `jq` another.
     */
    /**
     * ⭐ THREE DISTINGUISHABLE STATES, because collapsing any two of them would
     * let a script read a skipped check as a passed one — which is the whole
     * defect this fixes, moved one layer down:
     *
     *   asked: false          you never passed --refute
     *   ran: false            you did, but the run had already failed, so
     *                         refuting it would buy nothing (see secondOpinion)
     *   ran: true, refuted:_  it ran, and this is what it found
     *
     * ⚠️ `refuted` is only meaningful when `ok` is true. A refuter that crashed
     * must not read as "could not refute it", so its own `ok` travels with it
     * rather than being flattened into a boolean.
     */
    // ⭐ The shape lives in lib/refute.mjs so it can be TESTED — importing
    // bin/acuvo.mjs executes the CLI, which then waits on stdin, so a decision
    // declared here is a decision no test can reach without hanging.
    const refutation = refutationField(opts.refute === true, opinion, alreadyFailed);

    const doc = jsonDoc(outcome, { task, fields: { refutation } });
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    /**
     * ⚠️ A REFUTED RUN MUST FAIL UNDER --json TOO. The human path returns
     * EXIT_FAILED when the second opinion refutes the claim; without this the
     * document could report `refutation.refuted: true` beside `exitCode: 0`,
     * and a CI gate reading the exit code would pass a run our own adversarial
     * check had just disproved. `doc.exitCode` is otherwise authoritative, so
     * this is the one place allowed to override it — and the document carries
     * the reason, so the two can still be reconciled by anyone reading both.
     */
    if (opinion?.ok && opinion.refuted) return EXIT_FAILED;
    return doc.exitCode;
  }

  /**
   * ⚠️ THE CHANGE LIST IS **NOT** PRINTED AGAIN HERE, and that absence is the
   * fix. `formatSummary` already emits it under its "N files written:" header
   * (lib/turn.mjs) — this file printed a second, unlabelled copy below the cost
   * line, so every run that touched a file listed it twice.
   *
   * ⭐ WHEN A FACT APPEARS TWICE, DELETE THE COPY WITHOUT THE CONTEXT. The
   * summary's copy has a header explaining what the list is; this one was bare
   * paths after a price. Deleting the other one would have been "fixing" the
   * duplicate by keeping the worse half.
   */
  const lines = formatSummary(outcome);
  process.stdout.write(`${lines.join('\n')}\n`);

  /**
   * ── ⭐⭐ WHAT THE MODEL'S OWN `done` WAS WORTH — PRINTED, AT LAST ───────────
   *
   * `runSession` has returned `reconciliation` since plan-coherence was wired
   * in, and `formatReconciliation` exists to print it. Measured 2026-08-20:
   * turn.mjs imported that formatter on line 64 and called it NOWHERE, so the
   * block existed only inside `--json`. The one number nobody has ever been
   * shown — how many steps marked done have any evidence behind them — was
   * computed on every planned run and thrown away on the human path.
   *
   * ⚠️ ONLY WHEN THERE WAS A PLAN FOR THIS TASK. `turn.mjs` omits the field
   * entirely otherwise (`planForTask` returns null for a plan left behind by a
   * different task), so this is silent on the overwhelming majority of runs
   * rather than printing "nothing to reconcile" at everybody.
   *
   * ⚠️ BELOW `formatSummary`, NOT ABOVE IT. The escalation ladder learned this
   * the expensive way twenty lines up: the last thing on screen is the thing a
   * person reads, and a step marked done with nothing behind it is worth more
   * of that position than the cost line.
   *
   * ⚠️ AND IT SAYS NOTHING ABOUT CORRECTNESS. `formatReconciliation`'s own last
   * line states that; it is left in rather than trimmed for width, because this
   * block appearing to be a verification verdict is exactly the `✔ VERIFIED`
   * over an untouched deliverable that produced plan-coherence.mjs.
   */
  if (outcome?.reconciliation?.ok) {
    process.stdout.write(`\n${formatReconciliation(outcome.reconciliation).join('\n')}\n`);
  }

  /**
   * ── ⭐ SHOW THE PICTURE, DO NOT DESCRIBE IT ────────────────────────────────
   *
   * `see_page` already renders a real screenshot and then prints a FILE PATH —
   * a coding agent calling a painting over the radio. Terminals that speak the
   * kitty or iTerm2 protocol can simply be handed the pixels.
   *
   * ⚠️ SILENT AND OPTIONAL BY CONSTRUCTION. `renderImage` returns nothing at all
   * on a terminal we do not positively recognise, and nothing when stdout is not
   * a TTY, so `acuvo --json | jq` is untouched. The path line above stays either
   * way — the image is an addition to the report, never a replacement for it.
   */
  /**
   * ⚠️⚠️ THIS BINDING CRASHED THE CLI FOR ONE COMMIT, and the way it got past
   * me is the part worth keeping. Removing the duplicate change-list PRINT also
   * removed `const changes`, and I checked for other uses with
   * `awk '/\bchanges\b/'` — which matched nothing, so I concluded there were
   * none. **In POSIX awk `\b` is a BACKSPACE, not a word boundary.** The check
   * could not have matched anything, ever.
   *
   * ⭐ A CHECK THAT CANNOT FAIL IS WORSE THAN NO CHECK. It reads as evidence.
   * And 1,413 green tests said nothing, because this line runs only AFTER a
   * real completion — the crash surfaced on the first live run, on the report
   * path, after the work had already succeeded.
   */
  const changes = changesOf(outcome);
  for (const c of changes) {
    if (!/\.png$/i.test(c.path ?? '')) continue;
    const shot = renderImage(resolve(root, c.path));
    if (shot.text) process.stdout.write(shot.text);
  }

  /**
   * ── ⭐⭐ THE SECOND OPINION, ON THE ONE PATH THAT MATTERS ──────────────────
   *
   * Wired here — the ordinary single-run exit — and deliberately not onto
   * `--parallel`, `--best-of` or the escalation ladder. Each of those already
   * spends several runs and has its own verdict machinery; bolting a refuter
   * onto all five call sites would multiply cost in exactly the modes that are
   * already expensive, for a claim that is already cross-checked.
   *
   * ⚠️ AND THE VERDICT ONLY MOVES ONE WAY. A concrete refutation turns a pass
   * into a failure; nothing here can turn a failure into a pass. An adversarial
   * reviewer that could clear a red run would be a way to launder a bad result,
   * which is the opposite of the reason it exists.
   */
  // ⚠️ `alreadyFailed` and `opinion` are computed ABOVE the --json return now,
  // so both paths act on the same single evaluation. Re-running the refuter
  // here would charge for a second adversarial pass and could disagree with the
  // document already printed.
  if (opinion?.ok && opinion.refuted) return EXIT_FAILED;

  return verdictExit(outcome);
}

/**
 * ── ⭐⭐⭐ THE UPDATE CHECK RUNS AT EXIT, NEVER AT STARTUP ────────────────────
 *
 * Roman, 2026-08-22: *"how do we do self updates so all users get updates as
 * soon as we do it… like Claude."*
 *
 * ⚠️ AT EXIT BECAUSE STARTUP LATENCY IS THE ONE THING A CLI CANNOT SPEND. The
 * user has their answer by the time this runs, so the worst case — a 3-second
 * timeout against an unreachable registry — costs them nothing they were
 * waiting on. At startup the same code would delay the first token of every
 * single run to serve a check that matters once a day.
 *
 * ⚠️ AND IT CANNOT FAIL THE RUN. Every path is caught and the exit code is the
 * one `main()` decided. An update mechanism that can turn a successful task into
 * a failure has inverted its own purpose.
 */
async function noticeUpdateQuietly() {
  try {
    const { updatesEnabled, checkForUpdate, applyUpdate, updateNotice } = await import('../lib/self-update.mjs');
    if (!updatesEnabled()) return;
    // A machine-readable run must stay machine-readable — a friendly line on
    // stderr is still a surprise to something parsing this.
    if (process.env.ACUVO_JSON === '1') return;

    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const { latest, isNewer } = await checkForUpdate({ current: pkg.version });
    if (!isNewer) return;

    const { spawn } = await import('node:child_process');
    const started = applyUpdate({ spawn });
    process.stderr.write(updateNotice(pkg.version, latest, started));
  } catch {
    // Deliberately total. Nothing about staying current is worth a stack trace.
  }
}

main().then(
  async (code) => {
    await noticeUpdateQuietly();
    process.exit(code);
  },
  (err) => {
    // Nothing should reach here — every expected failure is a returned value.
    // A stack trace escaping to the user is therefore a BUG in this package,
    // and it says so rather than looking like the user's fault.
    process.stderr.write(`acuvo crashed — this is a bug in acuvo-code, not in your project:\n${err?.stack || err}\n`);
    process.exit(EXIT_FAILED);
  },
);
