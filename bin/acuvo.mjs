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

import { parseArgv, USAGE } from '../lib/cli-args.mjs';
import { runChat } from '../lib/chat.mjs';
import { readModelConfig, MISSING_KEY_MESSAGE } from '../lib/model.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { runSession, formatSummary, renderEvent, sessionFailed } from '../lib/turn.mjs';
import { runPool, detectConflicts, formatParallelSummary, shortLabel } from '../lib/parallel.mjs';
import { detectRepo, findToken, fetchIssue, branchNameFor, issueToTask, createBranch, nextSteps } from '../lib/github.mjs';
// ⚠️ `formatChanges` is deliberately NOT imported: rendering the change list is
// `formatSummary`'s job, and importing it here is how the second copy came back.
import { describeChange, shortenRoot, toJson } from '../lib/report.mjs';
import { renderImage } from '../lib/terminal-graphics.mjs';
import { saveSession, listSessions, resumeMessages, loadSession } from '../lib/session.mjs';
import { recordRun } from '../lib/audit.mjs';
import { runBestOf, formatBestOf } from '../lib/best-of.mjs';
import { escalate, formatEscalation, outOfRoad } from '../lib/escalate.mjs';
import { homedir } from 'node:os';
import { loadEnvFiles as envLoad } from '../lib/env-file.mjs';
import {
  loadPolicy, invocationDecision, roundBudget, filterToolNames, mcpDecision,
  USER_POLICY_FILE, USER_POLICY_ENV, WORKSPACE_POLICY_FILE,
} from '../lib/policy.mjs';
import { createBudget, remainingForTurn } from '../lib/budget.mjs';
import { createFleetGate } from '../lib/fleet-budget.mjs';
import { createAsker } from '../lib/prompt.mjs';
import { summariseSpend, readAuditFiles, formatSpend, parseSince } from '../lib/spend.mjs';

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

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_UNCONFIGURED = 2;
const EXIT_USAGE = 64;

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
  '  --doctor              Say what is actually working here: key, model chain, media',
  '                        endpoints, which tools would be offered, git. Every dark or',
  '                        broken line names the exact variable that fixes it. Exits 0',
  '                        when nothing is broken. ⚠️ It VERIFIES over the network: your',
  '                        key is sent to openrouter.ai to check it authenticates, and',
  '                        each configured endpoint is pinged. Add --offline to skip all',
  '                        of it — nothing leaves the machine, and no key is sent.',
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
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sessions') { flags.sessions = true; continue; }
    if (arg === '--doctor') { flags.doctor = true; continue; }
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

async function main() {
  const lifted = extractLifecycleFlags(process.argv.slice(2));
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
  const emitsOwnObject = life.sessions || life.doctor || life.replay !== null || life.design !== null
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
  if (opts.command === 'spend') {
    const since = parseSince(opts.since);
    if (since && since.error) die(since.error, EXIT_USAGE);
    const summary = summariseSpend(readAuditFiles(root), { since });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return EXIT_OK;
    }
    process.stdout.write(`\n${formatSpend(summary, { since }).map((l) => `  ${l}`).join('\n')}\n\n`);
    return EXIT_OK;
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
  if (!config.configured) die(MISSING_KEY_MESSAGE, EXIT_UNCONFIGURED);
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
  const claimer = opts.autoLease
    ? createPathClaimer(root, { holder: opts.holder ?? `pid-${process.pid}` })
    : null;
  if (claimer) process.on('exit', () => { try { claimer.releaseAll(); } catch { /* exiting anyway */ } });

  const executor = createLocalExecutor(root, {
    dryRun: opts.dryRun,
    claimPath: claimer ? (p) => claimer.claim(p) : null,
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
  let priorMessages = null;
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

  const oneTurn = async (turnTask, priorTurnMessages, over = {}) => {
    /**
     * ⚠️ ONLY WHEN THIS IS A REAL TURN, NOT A LADDER RUNG. `over.budgetUsd` is a
     * slice `escalate.allocate()` already carved out of the session total, so
     * subtracting session spend from it would charge the same dollars twice and
     * starve rung three of a budget it was correctly allocated.
     */
    if (over.budgetUsd === undefined) {
      const room = remainingForTurn(opts.budgetUsd, sessionSpentUsd);
      if (!room.ok) {
        const sentence = room.message;
        (opts.json ? process.stderr : process.stdout).write(`\n  ⛔ ${sentence}\n`);
        // ⚠️ `error` AND `message`, because formatSummary prints `error` for a
        // failed run and printing "✖ undefined" is worse than the refusal.
        return { ok: false, stage: 'budget', stoppedBecause: 'limit-reached', error: sentence, message: sentence };
      }
      if (room.remainingUsd !== null) over = { ...over, budgetUsd: room.remainingUsd };
    }

    const result = await runSession({
      task: turnTask,
      priorMessages: priorTurnMessages,
      executor: over.executor ?? executor,
      config,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
      maxRounds: opts.maxRounds,
      allowRun: opts.allowRun && !opts.dryRun,
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
      fleetGate: createFleetGate(root, { fleetLimitUsd: opts.fleetBudgetUsd }),
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
         * ⚠️ IT CANNOT ABORT THE ROUND, AND THAT LIMIT IS STATED RATHER THAN
         * HIDDEN. `runSession` takes no abort signal, so the honest thing this
         * callback can do is record the loss, say so immediately, and make the
         * PROCESS fail — see `leaseLost` at the exit. Aborting mid-round is a
         * real improvement and it needs a signal parameter on `runSession`,
         * which is a change to the loop's contract, not to this callback.
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
        const lines = renderEvent(event);
        if (lines.length === 0) return;
        const text = `${lines.join('\n')}\n`;
        if (opts.json) process.stderr.write(text);
        else process.stdout.write(text);
      },
    });
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
    const turnCost = Number(result?.usage?.cost ?? 0);
    if (Number.isFinite(turnCost) && turnCost > 0) sessionSpentUsd += turnCost;

    return result;
  };

  /** What this run actually wrote. Shared, because both reports need it. */
  const changesOf = (result) => (result?.executed ?? []).filter((e) => e.mutated).map(describeChange);

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
    const failed = sessionFailed(result, verdictOptions) || leaseLost !== null;
    return {
      ...toJson(result, { changes: changesOf(result), task }),
      failed,
      exitCode: failed ? EXIT_FAILED : EXIT_OK,
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
  const verdictExit = (outcome) => ((sessionFailed(outcome, verdictOptions) || leaseLost !== null) ? EXIT_FAILED : EXIT_OK);

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
    const outcome = await oneTurn(task, null);
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
      runOne: oneTurn,
      render: (result, out) => out.write(formatSummary(result).join(String.fromCharCode(10)) + String.fromCharCode(10)),
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
      budget: createBudget({ limitUsd: opts.budgetUsd, limitIsDefault: opts.budgetExplicit !== true, fleetGate: createFleetGate(root, { fleetLimitUsd: opts.fleetBudgetUsd }) }),
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

  const outcome = await oneTurn(task, priorMessages);

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
    const doc = jsonDoc(outcome, { task });
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
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
  return verdictExit(outcome);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Nothing should reach here — every expected failure is a returned value.
    // A stack trace escaping to the user is therefore a BUG in this package,
    // and it says so rather than looking like the user's fault.
    process.stderr.write(`acuvo crashed — this is a bug in acuvo-code, not in your project:\n${err?.stack || err}\n`);
    process.exit(EXIT_FAILED);
  },
);
