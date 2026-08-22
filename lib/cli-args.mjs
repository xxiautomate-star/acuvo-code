/**
 * ARGUMENT PARSING — pure, so the CLI's contract is testable without spawning a
 * process or spending a completion.
 *
 * Deliberately hand-rolled rather than `node:util.parseArgs`: the flag surface
 * is five entries and the errors need to be sentences, not `Unknown option`.
 */

import { DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, DEFAULT_MODEL } from './model.mjs';
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, ALLOWED_BINARIES, PRESET_NAMES } from './command.mjs';
/**
 * ⭐ THE PARSER FOR `--budget` LIVES IN `budget.mjs`, NOT HERE. The flag and the
 * governor that enforces it must read the same string the same way; two parsers
 * for one idea is how `25c` becomes $25 in one of them.
 */
import { parseBudgetUsd, formatUsd, DEFAULT_BUDGET_USD } from './budget.mjs';
import { parseSince } from './spend.mjs';
import { resolveModelName } from './acuvo-models.mjs';
import { TIERS as ESCALATION_TIERS } from './escalate.mjs';
/**
 * ⭐ ENGINE IDS ONLY — no prices reach the parser, because no prices reach this
 * PACKAGE. `--engine` is validated against the id list; what an engine costs is
 * an account fact the gateway answers. See creative-engines.mjs.
 */
import { CREATIVE_ENGINES, engineById } from './creative-engines.mjs';

/**
 * ── ⭐⭐ THE CEILING: RAISED 8 → 16 (2026-08-11), AND WHY IT COULD NOT MOVE
 *        BEFORE TODAY ────────────────────────────────────────────────────────
 *
 * ⚠️ THE OLD NOTE HERE SAID "LEFT AT 8 DELIBERATELY: nothing measured argues
 * against it", and it was right at the time — because the binding constraint
 * was never the round COUNT, it was the transcript. Every `read_file` result
 * stayed in the conversation forever, so round N re-sent everything rounds
 * 1..N-1 had read. Raising the ceiling raised the burst risk, not the horizon.
 *
 * ⭐ COMPACTION (lib/compact.mjs, wired into lib/turn.mjs's round loop today)
 * removes that coupling: the history is now held under a 24,000-token budget
 * before each call, so a 12-round session sends roughly what a 4-round one
 * does. The ceiling can move because the thing it was protecting against no
 * longer grows without bound.
 *
 * ── THE MEASUREMENT, NOT A GUESS ────────────────────────────────────────────
 * Driven live on deepseek-v4-flash today, in a workspace with a real file tree:
 *
 *   · the loop STOPS ITSELF. A verify-and-tidy task given --max-rounds 5 used
 *     3 and stopped ("no-tool-calls", verified, $0.000921). A second given 2
 *     used 2. Nothing in the shipped bench has ever consumed its budget.
 *   · the bench's own worst cases — git, refactor, crossfile, feature — are
 *     budgeted at 7. Doubling the observed worst case is the standard headroom
 *     rule, and 7 × 2 ≈ 16.
 *   · an over-budget transcript measured here compacted 61,000 → 21,000
 *     estimated tokens. That is the headroom the extra eight rounds spend.
 *
 * ── ⚠️⚠️ RAISED 16 → 64 ON 2026-08-16, AND THE OLD ARGUMENT IS KEPT ─────────
 *
 * It read: *"16, NOT 64, AND NOT UNBOUNDED. A ceiling is a blast radius, not a
 * target … 16 rounds of a $0.0003 round is under a cent — a number a person can
 * lose to a typo without caring. The policy layer's MAX_ROUNDS_CEILING = 64
 * remains the separate, opt-in bound for a config file that states a number on
 * purpose."*
 *
 * ⭐ EVERY WORD OF THAT IS STILL TRUE ABOUT MONEY, and money is no longer the
 * binding constraint — `DEFAULT_BUDGET_USD` has been ON by default since
 * 2026-08-12, and `turn.mjs` checks it **before** each round and refuses the one
 * it cannot afford. So a run given 64 rounds and a $0.02 ceiling still stops at
 * $0.02. Raising this cannot increase what anything spends; the two governors
 * are independent and the dollar one binds first, every time.
 *
 * ⚠️ WHAT 16 ACTUALLY COST US, measured. Terminal-Bench 2.1
 * `torch-tensor-parallelism`, 2026-08-16: the agent wrote `parallel_linear.py`
 * AND a test, ran verification, got **exit 1** — and stopped at round 11 of 16
 * with budget remaining. A failing test in hand and no room to iterate is the
 * exact shape of work this ceiling was silently truncating. Long-horizon tasks
 * average far more turns than 16; the blast-radius reasoning was calibrated on
 * a 13-task bench whose worst case was 7.
 *
 * ⚠️ THE DEFAULT STILL DOES NOT MOVE. A user who asks for nothing must not
 * suddenly spend more; raising the ceiling costs exactly zero until someone
 * types a bigger number. `DEFAULT_MAX_ROUNDS` is untouched.
 *
 * ⚠️ AND `UNTIL_DONE_MAX_ROUNDS = 200` IS STILL THE SEPARATE, HIGHER BOUND for
 * a run that has priced the job — see below. This change is only about the
 * number a human is allowed to type by hand.
 */
export const MAX_ROUNDS_LIMIT = 64;

/**
 * ── ⭐ THE CLI'S ROUND BUDGET: RAISED 3 → 5 (2026-08-10) ─────────────────────
 *
 * ⚠️ FIRST, THE DIVERGENCE, NAMED RATHER THAN HIDDEN: `turn.mjs` also exports a
 * `DEFAULT_MAX_ROUNDS = 3`, which this module used to import. That constant is
 * now only the fallback for a LIBRARY caller that omits `maxRounds`; the CLI
 * always passes `opts.maxRounds` (bin/acuvo.mjs:117 and :207), so this value is
 * what anyone typing `acuvo` actually gets. Two numbers for one idea is real
 * debt — the fix is to move the constant here (or have turn.mjs import it) and
 * delete the other, which needs an edit to turn.mjs.
 *
 * ── WHY 3 WAS NOT "CONSERVATIVE", IT WAS BROKEN ─────────────────────────────
 * Measured live on deepseek-v4-flash, a plain fix-and-verify task
 * ("run the failing test, work out why, fix the code, re-run, write NOTES.md"):
 *
 *     round 1  $ npm test        → diagnose the failure
 *     round 2  write the fix + NOTES.md
 *     round 3  $ npm test        → passes
 *
 * That is the COMMONEST SHAPE IN THIS TOOL and it consumes the entire default
 * budget with zero slack. It did not fail — it had no room to.
 *
 * ⚠️ AND THE REAL DAMAGE IS A FEATURE THAT CANNOT RUN. turn.mjs:1028 grants one
 * extra round after a command passes ("committing your work, cleaning up a
 * scratch file, another step that was asked for") — but ONLY when
 * `round < maxRounds`. Since the pass reliably lands ON round 3, the guard fires
 * every time and the grace round is STRUCTURALLY UNREACHABLE at the default.
 * Observed verbatim: "✔ a command passed — stopping here rather than spending
 * another round." The tidy-up round is dead code for every default user.
 * At maxRounds 4 the same task instead printed "one more round to finish
 * anything else that was asked" and used it to write the file it owed.
 *
 * Corroborating, from this package's own bench, where the author had to
 * override the budget per task: create 3 · edit 3 · refuse 3 · search 4 ·
 * fix 4 · multifile 4 · git 7 · refactor 7 · crossfile 7 · feature 7.
 * SIX OF NINE needed more than the default; the median need is 4. bench/tasks.mjs:173
 * already wrote the conclusion down — "DEFAULT_MAX_ROUNDS is 3, which cannot fit
 * any task that ends in cleanup and a commit."
 *
 * ── SO: 3 (the measured floor) + 1 (the grace round) + 1 (one failed fix) = 5 ─
 * The +1 for a failed fix is not padding: the bench budgets 4 for `fix` and
 * `search` assuming the FIRST fix works, so a single wrong guess needs a fifth.
 * 5 is the median-plus-recovery, not the maximum — the four 7-round tasks all
 * end in "tidy up AND commit", a shape the user has explicitly asked for and can
 * pay for with --max-rounds.
 *
 * ── 💸 COST IMPACT, FROM AN A/B ON THE IDENTICAL TASK ────────────────────────
 * Same prompt, same fresh workspace, only the budget differs:
 *
 *     --max-rounds 3 → 3 rounds · 11,746 tok · $0.000377972  (stopped: verified)
 *     --max-rounds 4 → 4 rounds · 16,258 tok · $0.000509272  (used the grace round)
 *
 * so the marginal round costs $0.000131 — +34.7% on a task that costs under a
 * twentieth of a cent. At 1,000 tasks/month that is $0.38 → $0.51.
 *
 * ⚠️ THEN THE SAME TASK WAS RUN ON THE SHIPPED DEFAULT AND COST MORE THAN THAT
 * ARITHMETIC PREDICTED — the honest number, not the flattering one:
 *
 *     default 5 → 5 rounds · $0.000784  (stopped: no-tool-calls, verified true)
 *
 * i.e. +$0.000406 / +107% against the old default's $0.000378, because the model
 * took the grace round AND a fifth round to re-verify, rather than the four the
 * A/B extrapolation assumed. Late rounds are dearer than early ones (the whole
 * conversation is re-sent as prompt), so per-round averages understate the tail.
 * Doubling the price of a task that costs $0.0008 is the right trade for a tool
 * that otherwise stops one step short of finishing — but it IS a doubling, and
 * anyone revisiting this should argue with that number, not the +34.7% one.
 *
 * ⭐ AND THE CAP IS NOT A SPEND COMMITMENT, WHICH IS THE WHOLE REASON THIS IS
 * SAFE. The loop stops on its own — `verified`, or `no-tool-calls`. Measured: a
 * six-instruction task (fix · add a test · re-run · delete a scratch file ·
 * write a CHANGELOG) given --max-rounds 8 used FOUR and stopped, for $0.000717.
 * Raising the ceiling buys headroom for the tasks that need it and costs nothing
 * on the tasks that don't. That is why this moves and MAX_ROUNDS_LIMIT does not.
 */
/**
 * ── ⭐⭐⭐ RAISED 5 → 24 ON 2026-08-19, AND THE ARGUMENT IS ABOVE ────────────
 *
 * Roman: *"it's not capable and it shouldn't take this long, there's no
 * reason."* He was right, and this number was a large part of why. Two live
 * runs the same day both produced correct, verified work and both stopped
 * because they ran out of ROOM, not because they were finished — one at 5 of 5,
 * one at 4 of 5. A harness that can only ever attempt three-file tasks looks
 * incapable while being nothing of the kind.
 *
 * ⭐ AND RAISING IT IS ALMOST FREE, which is the measurement directly above:
 * the loop stops on its own at `verified` or `no-tool-calls`, so a task that
 * needs four rounds still takes four. A ceiling is headroom for the work that
 * needs it and costs nothing on the work that does not.
 *
 * ⚠️ THE MONEY IS THE REAL WALL, NOT THIS. `--budget` governs spend and
 * `DEFAULT_BUDGET_USD` moved with it; this number exists so a bug in the
 * governor cannot produce a `while (true)`. 24 is deliberately far below
 * `MAX_ROUNDS_LIMIT` (64) so there is still a ceiling above the default.
 */
export const DEFAULT_MAX_ROUNDS = 24;

/**
 * ── ⭐⭐ THE BACKSTOP `--until-done` RUNS AGAINST, AND WHY IT IS NOT INFINITY ─
 *
 * ⚠️ THE ROUND COUNTER IS AN ARBITRARY STOP AND ALWAYS WAS. It stops a run that
 * is one round from finishing and it lets a run that is going nowhere spend its
 * whole allowance; the thing a user actually has an opinion about is MONEY.
 * `--budget` is the real wall, `lib/budget.mjs` is the governor, and this number
 * exists only so that a bug in the governor cannot produce a `while (true)`.
 *
 * ⚠️ IT IS UNREACHABLE WITHOUT A CEILING. `--until-done` REFUSES to run without
 * `--budget` (see `parseArgv`), so nothing can select this backstop without
 * first stating what it is willing to spend. 200 rounds of a measured $0.0008
 * round is about $0.16 — well below any budget anyone would type, which is the
 * point: the money runs out first, every time, and this only ever catches the
 * case where the governor itself is broken.
 *
 * ⭐ AND `MAX_ROUNDS_LIMIT` REMAINS SEPARATE AND LOWER. A number a human types by
 * hand is a blast radius (64 since 2026-08-16 — see the note there for why that
 * is still free). A number the machine reaches only after the human has priced
 * the job is a different decision, and stays higher.
 */
export const UNTIL_DONE_MAX_ROUNDS = 200;

export const USAGE = [
  'acuvo — a coding agent that writes code, RUNS it, and fixes what broke.',
  '',
  'Usage:',
  /**
   * ⚠️ THE COMMAND A USER ACTUALLY TYPES. This line used to read
   * `node acuvo-code/bin/acuvo.mjs "…"` — a DEV invocation from inside a clone,
   * which nobody who installed the package has ever typed. Help text that
   * teaches the wrong incantation makes the tool look broken to the one person
   * following it exactly.
   */
  '  acuvo "<what you want built or changed>"',
  /**
   * ⭐ THE BARE INVOCATION WAS UNDOCUMENTED, AND IT IS THE FIRST THING A PERSON
   * TYPES. `acuvo` with no task opens an interactive conversation (bin/acuvo.mjs
   * `if (!task) await runChat(...)`), where six `/` commands live — and item 14
   * built them, `/help` generates itself from `SLASH_COMMANDS`, and NOTHING a
   * new user reads said the prompt existed at all. Measured 2026-08-19 against
   * the real `--help` output: "chat" 0, "slash" 0, "/help" 0.
   */
  '  acuvo                 With no task: an interactive prompt. Type `/help` there',
  '                        for the commands it understands (/skills, /mcp, /cost,',
  '                        /model, /clear). Ctrl-C returns you to the prompt.',
  '',
  '  (from a clone, without installing:  node bin/acuvo.mjs "<task>")',
  '',
  'Options:',
  `  --dir <path>          Workspace root (default: the current directory).`,
  `  --model <id>          OpenRouter model id (default: $OPENROUTER_CODEGEN_MODEL, else ${DEFAULT_MODEL}).`,
  `  --max-rounds <n>      Write→run→fix rounds, 1-${MAX_ROUNDS_LIMIT} (default: ${DEFAULT_MAX_ROUNDS}). 1 = one completion, nothing executed.`,
  /**
   * ── ⭐⭐ THE TWO FLAGS THAT MOVE THE STOP CONDITION FROM A COUNTER TO MONEY ─
   * Documented here and not only in the changelog, because a capability nobody
   * can find is the same orphan as a module nobody imports.
   */
  '  --budget <usd>        Stop when the NEXT round would cross this much spend.',
  '                          --budget 0.50 · --budget 25c · --budget $2',
  '                        Refuses to start at all if it cannot afford one round,',
  '                        so it never spends money to discover it had none.',
  '                        ⭐ A $0.02 ceiling is ALREADY ON. A measured task costs',
  '                        $0.0008–$0.003, so it never fires on ordinary work — it',
  '                        is there so a runaway costs two cents to find. Raise it',
  '                        with --budget, or remove it with --budget none.',
  '  --fleet-budget <usd>  The ceiling across EVERY terminal working this workspace',
  '                        today, not just this one. --budget caps a run; seven',
  '                        terminals multiply that by seven, and this is the number',
  '                        that stays true when you open all seven. Summed from the',
  '                        audit log they all already write to, so there is no second',
  '                        ledger to drift. Off unless you ask for it.',
  '  --until-done          Keep going while the criterion you declared is unmet,',
  '                        the budget allows, and the loop is not going in circles.',
  '                        REQUIRES --budget. There is no unbounded mode.',
  '                        ESCALATES rather than just retrying: one attempt, then a',
  '                        fresh context carrying the failure, then several parallel',
  '                        attempts keeping whichever verifies. Each rung runs on its',
  '                        own slice of --budget, and a rung the remaining budget',
  '                        cannot cover is skipped and reported, never half-started.',
  '  --budget-window <p>   Measure --fleet-budget over this period instead of today.',
  '                        7d · 24h · 2026-08-01. A schedule that fires hourly gets a',
  '                        FRESH per-run ceiling every time, so the number you chose is',
  '                        a rate, not a total — this makes it a total again.',
  '  verify [id] [--all]   Re-check a past claim by RUNNING it again — no model call,',
  '                        no cost. --all checks every recorded claim at once,',
  '                        deduplicated by command: twelve runs that claimed `npm test`',
  '                        are twelve claims and one thing to run.',
  '  rewind [id]           UNDO WHAT THE AGENT DID TO YOUR FILES. Bare, it lists every',
  '                        checkpoint in this workspace; with an id it puts the files back',
  '                        the way they were before that run started. No model call, no cost.',
  '                        ⚠️ It REFUSES any file you changed yourself after the run — that',
  '                        edit is yours and a rewind that threw it away would be the',
  '                        accident, not the fix. --force overrides, and says it did.',
  '                        Add --dry-run to see exactly what it would touch.',
  '  --no-checkpoint       Do not record the previous contents of the files this run writes,',
  '                        so `acuvo rewind` will have nothing to put back. On by default:',
  '                        it costs one read of a file about to be overwritten anyway.',
  '  --force               Only with `acuvo rewind`. Restore even the files you edited after',
  '                        the run — every forced path is printed as FORCED.',
  '  --refute              Get a SECOND OPINION. When the run claims success, an',
  '                        independent agent with a fresh context — no sight of how the',
  '                        first one thought — tries to REFUTE the claim: runs the tests,',
  '                        checks the callers, looks for a requirement nothing addressed.',
  '                        It cannot write. A concrete refutation fails the run; an opinion',
  '                        changes nothing, because failing correct work is the worse error.',
  '                        Costs a second run — about what the first one cost.',
  '  --unattended          Nobody is watching. Declining on budget exits 3 instead of 1,',
  '                        so a cron log can tell "it chose not to run" from "it failed".',
  '  --claim               Take the next open task off the shared board and run it,',
  '                        instead of typing a prompt. Needs --holder. Seven terminals',
  '                        each running `acuvo --holder tN --claim` split one list of',
  '                        work with nobody doing the same task twice.',
  '                        See `acuvo board` and `acuvo board add "…"`.',
  '  --no-auto-lease       Stop claiming each file as it is written. Every write and',
  '                        delete normally takes a short lease on that exact path, so a',
  '                        second terminal writing the same file is REFUSED rather than',
  '                        silently overwriting your work. Only a proven conflict refuses;',
  '                        a lease system that cannot run degrades to the old behaviour.',
  '  --lease <path>        Claim a file before starting, so several terminals can',
  '                        share one checkout. Repeatable. Released on exit.',
  '  --holder <name>       Who to record as holding those leases (default: the pid).',
  '  --no-run              Never execute anything. The model can still read and write files.',
  // ⚠️ THE HELP LINE STATES THE RULE, NOT THE MENU. Somebody skimming this must
  // learn that the dear engine is opt-in; a bare list of ids would read as a
  // menu of equals and the expensive one is not an equal.
  '  --engine <id>         Which Acuvo creative engine this run may use, e.g. acuvo-image-ultra.',
  '                        The CORE engine is the default and an Ultra one runs ONLY when you',
  '                        name it here. `acuvo engines` lists them with what each one costs.',
  '  --max-tier <tier>     How hard --until-done may try: solo | fresh | best-of (default best-of).',
  '                        solo turns escalation off entirely; fresh allows one retry with a clean',
  '                        context; best-of allows the parallel attempts as well.',
  '  --best-of <n>         Do the task n times (2-5) in isolated copies and keep the one that',
  '                          actually passes. Costs n times as much — which at ~$0.001 a run is',
  '                          a third of a cent for three tries.',
  '  --shell               Let it run ANY program, with pipes and redirection, at your privileges.',
  '                          Off by default: without this it can only run node, npm, npx and tsc.',
  `  --command-timeout <s> Kill a command after this long (default: ${DEFAULT_COMMAND_TIMEOUT_MS / 1000}).`,
  // ⚠️ INTERPOLATED, NOT TYPED OUT. This line said "default: 8000" while the
  // constant said something else the moment DEFAULT_MAX_TOKENS moved — help text
  // that lies about the tool's own budget is how someone concludes a truncated
  // reply is a model defect rather than a flag they can raise.
  `  --max-tokens <n>      Ceiling on each reply (default: ${DEFAULT_MAX_TOKENS}).`,
  '  --timeout <seconds>   Give up on the model after this long (default: 180).',
  '  --issue <n>           Read a GitHub issue, branch, fix it, run the tests.',
  '                        Stops at a local branch — never pushes, never opens a PR.',
  '  --parallel            Run several quoted tasks at once:',
  '                          acuvo --parallel "add tests" "write the README"',
  '                        Names any file written by more than one task, and',
  '                        exits 1 if there was a collision.',
  '  --concurrency <n>     How many at a time, 1-4 (default 2).',
  '  --json                One JSON object on stdout, nothing else. Human output',
  '                        goes to stderr, so `acuvo --json ... | jq` just works.',
  '  --dry-run             Print what WOULD be written, touch nothing, run nothing.',
  /**
   * ⚠️ THE HELP LINE HAS TO SAY HOW THIS DIFFERS FROM THE TWO FLAGS PEOPLE
   * ALREADY REACH FOR. `--dry-run` and `--no-run` are about the ACT; `--plan`
   * is about the INTENT, and someone skimming a list of three will otherwise
   * assume the one they know already covers it.
   *
   * ⚠️⚠️ "TWO LOCKS" IS IN THE TEXT BECAUSE ONE OF THEM WAS MISSING (fixed
   * 2026-08-20). This line used to promise "offered READING TOOLS ONLY — it
   * cannot write", and only the first clause was enforced: narrowing the offer
   * does not stop a model emitting a name it was never shown, and
   * `executeToolCall` executed `write_file` when it arrived. Measured — the
   * proposal phase wrote a file, edited a source file and deleted a file. The
   * fix is `planPhaseExecutor` at the foot of this file, and the help now says
   * which lock does what so the promise can be checked rather than believed.
   */
  '  --plan                Say what it intends to do FIRST, and do nothing until you approve.',
  '                        TWO LOCKS: the planning phase is OFFERED reading tools only, and the',
  '                        executor REFUSES every write, delete and move underneath it — so a',
  '                        tool it was never shown still cannot change anything.',
  '                        You then get the plan, and',
  '                        [y/N]: Enter means no. Type a correction instead of y to approve',
  '                        with an amendment. Needs a terminal (it refuses in CI, before',
  '                        spending anything). Unlike --dry-run, the approved run is real.',
  '  -h, --help            This.',
  '  --version             Print the version and exit. Needs no key, spends nothing.',
  '',
  'Commands (these read; they never spend a completion and need no API key):',
  '  acuvo leases          Who holds which file in this workspace, and since when.',
  /**
   * ── ⚠️ TWO DEFECTS ON THESE FIVE LINES, AND BOTH SHIPPED ──────────────────
   *
   * 1. The separator was the literal bytes EF BF BD — U+FFFD REPLACEMENT
   *    CHARACTER — committed into SOURCE, not a terminal rendering artifact.
   *    `sed -n '332p' lib/cli-args.mjs | od -c` showed it, while the same `·`
   *    rendered correctly elsewhere in the same output.
   * 2. The two "Reads .acuvo/audit/" lines hung off `acuvo engines`, describing
   *    a cost ledger that belongs to `acuvo spend`. Rendered, a reader was told
   *    the ENGINE LIST omits runs with no recorded cost — which is not a thing
   *    engines does. Pure ordering; the sentences are unchanged.
   */
  '  acuvo spend           What runs in this workspace have cost. --since 7d · --json.',
  '                        Reads .acuvo/audit/ · runs that never recorded a cost are shown',
  '                        separately and are NEVER counted as zero.',
  '  acuvo engines         Which creative engines this account can reach, and the credit',
  '                        cost of each — asked BEFORE you spend any of them.',
  '',
  /**
   * ── ⚠️⭐ EVERY VARIABLE, INCLUDING THE SHARED SECRET ───────────────────────
   *
   * This section used to list two names. The media half of this tool reads five
   * more, and their absence from here is exactly what made four capabilities
   * look BROKEN rather than UNCONFIGURED — `see_page`, `speak`, `transcribe`
   * and `make_document` are simply never offered to the model when their URL is
   * unset, and nothing anywhere told the reader which variable to set.
   *
   * ⚠️ MODAL_VIDEO_SECRET IS THE ONE THAT COST THE MOST. It is not a URL, so it
   * never appeared in an error about a missing endpoint; a correctly-set URL
   * without it returns an authorisation failure that reads like a broken
   * service. It is one shared secret for all four Modal endpoints.
   *
   * ⭐ AND `--doctor` IS NAMED HERE ON PURPOSE: reading a list is guessing;
   * `acuvo --doctor` says which of these are actually working on THIS machine,
   * needs no key, and spends nothing.
   */
  'Environment (or put them in a .env beside your project — acuvo loads it):',
  /**
   * ── ⚠️⚠️⭐ THIS LINE SAID BYOK WAS THE ONLY WAY IN ─────────────────────────
   *
   * It read: "OPENROUTER_API_KEY  required — the only one needed to write
   * code." Measured 2026-08-19, `--help` mentioned "login" 0 times, "whoami" 0,
   * "logout" 0 — so a stranger who read the front door end to end concluded
   * BYOK is the only mode this tool has, while `--whoami` was simultaneously
   * telling them to run `acuvo --login`, a command `--help` did not list.
   *
   * ⭐ The doctrine is the opposite (memory `project_acuvo_cli_byok_never_and_licence`,
   * Roman, twice): an Acuvo account is the product, BYOK is the fallback. The
   * entry now names the flag that gets you off it, in the one place a person
   * who is about to export a provider key is actually looking.
   */
  '  OPENROUTER_API_KEY        the BYOK FALLBACK — used only when you have not run',
  '                            `acuvo --login`. It bills YOUR provider account, not',
  '                            your Acuvo credits. One of the two is needed to write',
  '                            code; `acuvo --whoami` says which one is in force, and',
  '                            `acuvo --login` switches to your Acuvo credits.',
  '  OPENROUTER_CODEGEN_MODEL  optional — override the default model.',
  '',
  /**
   * ── ⚠️⚠️ THESE TWO WERE INVISIBLE, AND INVISIBLE IS THE SAME AS ABSENT ────
   *
   * Measured 2026-08-16: `grep -c -i skill lib/cli-args.mjs` → **0**. The whole
   * feature works — `.acuvo/skills/*.md`, frontmatter, discovery, a `load_skill`
   * tool the model can call — and nothing in `--help`, no flag, no mention
   * anywhere a stranger would look. The same was true of MCP config.
   *
   * ⭐ THE POINT IS NOT DOCUMENTATION, IT IS REACH. An extensibility feature
   * nobody can find is extensibility for US and nobody else, which is precisely
   * the verdict an audit returned on this package. Two lines close it.
   */
  '  Extending it — both are real, and were previously undocumented:',
  '  .acuvo/skills/*.md        A markdown file per skill (name + description in',
  '                            frontmatter). Discovered automatically; the model',
  '                            is shown the list and loads one on demand.',
  '  .acuvo/mcp.json           MCP servers to connect. `acuvo --doctor` says which',
  '                            are reachable on this machine. Ships knowing about',
  '                            playwright, browser, docs, filesystem and firecrawl.',
  '',
  /**
   * ⭐ And the thing a user does before they read any of this: they drag a file
   * onto the window. Documented beside the features rather than in a changelog,
   * for the same reason as above.
   */
  '  Drop a file on the terminal and it is read: images, PDFs, Word, Excel, CSV.',
  '  Your terminal pastes the path; acuvo notices it is a real file and looks at it.',
  '',
  '  The media half. Each is dark, not broken, when unset:',
  '  RENDER_AUDIT_URL          see_page — render an HTML file and look at it.',
  '  MODAL_TTS_URL             speak / --say — turn text into a .wav.',
  '  MODAL_TRANSCRIBE_URL      transcribe / --task-audio — turn audio into text.',
  '  MODAL_PRESS_URL           make_document — render HTML to PDF.',
  '  MODAL_DOC_READ_URL        read_document — read a PDF/Word/Excel/scan you are given.',
  '  MODAL_TABLE_READ_URL      read_table — rows and columns out of a picture of a table.',
  '  MODAL_SELECT_URL          edit_image — name a thing in an image to replace it.',
  '  MODAL_FLUX_URL            edit_image / expand_image — the inpaint + outpaint studio.',
  '  MODAL_VIDEO_SECRET        the shared secret those endpoints expect. A URL',
  '                            without it fails authorisation and reads like a broken',
  '                            service, which is why it is listed here and not implied.',
  '  PERCHANCE_IMAGE_URL       generate_image — optional; a default is built in.',
  '',
  '  Run `acuvo --doctor` to see which of these are live on this machine.',
  '',
  `What it may execute out of the box: ${ALLOWED_BINARIES.join(', ')} — and only as \`node <file>\`,`,
  '`npm test`, `npm run <script>`, `npx vitest run`, `tsc`. No shell, no pipes, no other program,',
  'nothing outside the workspace. Exit code 1 if the last command it ran still fails.',
  '',
  /**
   * ⚠️⚠️ THIS PARAGRAPH IS THE FIX FOR THE LARGEST GAP IN THE PRODUCT, and the
   * gap was never capability. Six vetted presets — python, go, rust, ruby, make,
   * node-bin — ship in `lib/command.mjs` with per-language argument grammars and
   * their own test file. `grep -c preset` returned ZERO in this file and zero in
   * the system prompt, so neither the person reading the tour nor the model
   * driving the loop was ever told they exist. A Python user concluded, from our
   * own help text, that the run-and-fix loop could not touch their repo.
   */
  `Other ecosystems, OFF by default and one line away: ${PRESET_NAMES.join(', ')}.`,
  '  Enable per project:  .acuvo/commands.json  →  {"presets":["python"]}',
  '  Or per shell:        ACUVO_ALLOW_COMMANDS=python',
  'Then `pytest -q`, `go test ./...`, `cargo test`, `rspec`, `make test` run like `npm test` does.',
  'Each preset is a vetted argument grammar, not a shell — the boundary does not move, the menu does.',
].join('\n');

const FLAGS_WITH_VALUES = new Set([
  '--dir', '--model', '--max-tokens', '--timeout', '--max-rounds', '--command-timeout',
  '--budget', '--fleet-budget', '--budget-window', '--lease', '--holder', '--since',
  '--engine',
]);

/**
 * ⭐ A BARE `acuvo leases` IS A COMMAND; `acuvo leases are broken` IS A TASK.
 * The distinction is deliberately as narrow as it can be: the word must be the
 * FIRST argument and the ONLY positional. Anything looser would swallow a real
 * instruction, and a coding agent that silently answers a different question
 * than the one asked is the worst failure available to an argument parser.
 */
/**
 * ⭐ `verify` takes an OPTIONAL id, so it is handled beside `board` rather than
 * here — the bare-word rule below is "exactly one positional", and
 * `acuvo verify 2026-08-13T...` is two.
 */
const COMMANDS = new Set(['leases', 'spend', 'engines']);

/**
 * ⚠️ The union is DECLARED so the discriminant survives into TypeScript — see
 * the contracts note in `workspace.mjs` for why inference is not enough.
 *
 * @typedef {{ task: string, tasks: string[], parallel: boolean, issue: number | null, json: boolean, concurrency: number, dir: string | null, model: string | null, maxTokens: number, timeoutMs: number, maxRounds: number, allowRun: boolean, shell: boolean, commandTimeoutMs: number, dryRun: boolean, strict: boolean, offline: boolean, since: string | null, help: boolean, version: boolean, budgetUsd: number | null, budgetExplicit: boolean, untilDone: boolean, maxTier: string, lease: string[], holder: string | null, command: string | null }} CliOptions
 * @param {readonly string[]} argv
 * @returns {{ ok: true, options: CliOptions } | { ok: false, error: string }}
 */
export function parseArgv(argv) {
  const out = {
    task: '',
    tasks: [],
    parallel: false,
    issue: null,
    json: false,
    concurrency: 2,
    dir: null,
    model: null,
    maxTokens: DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRounds: DEFAULT_MAX_ROUNDS,
    allowRun: true,
    shell: false,
    bestOf: 0,
    maxTier: 'best-of',
    commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    dryRun: false,
    /**
     * ⭐⭐ `--plan`: THE READ-ONLY-UNTIL-APPROVED GATE THIS CLI DID NOT HAVE.
     *
     * ⚠️ `--dry-run` AND `--no-run` ARE NOT THIS, and the confusion is worth
     * naming here because both were offered as "the safe mode" for months.
     * `--dry-run` prints the writes it would have made — after the model has
     * already decided what they are. `--no-run` withholds the process spawners
     * and leaves writing untouched. Neither one ever shows you the INTENT
     * before the work, and neither one has a place to say no.
     *
     * ⚠️ OFF BY DEFAULT, like every flag that changes the shape of a run. It
     * also costs an extra model call, so defaulting it on would raise the price
     * of every run for a gate most scripted callers cannot even answer.
     */
    plan: false,
    /**
     * ⚠️ OFF BY DEFAULT, ON IN CI. Under `--strict` a run that wrote nothing and
     * ran nothing exits 1 instead of 0. It is opt-in because "what does this
     * file do?" legitimately produces neither, and a check that fails correct
     * work is worse than no check — but in a build script the opposite is true,
     * so `bin/acuvo.mjs` arms it automatically when CI is set.
     */
    strict: false,
    help: false,
    version: false,
    /**
     * ⭐ THE THREE NEW FIELDS, ALL INERT BY DEFAULT. `null` and `[]` and `false`
     * are what a caller who passed nothing gets, and every consumer treats those
     * as "the behaviour you had yesterday" — which is the only way a flag can be
     * added to a tool people already script against.
     */
    /**
     * ── ⭐⭐ ON BY DEFAULT AS OF 2026-08-12, AND THE NOTE ABOVE NO LONGER
     *        APPLIES TO THIS ONE ────────────────────────────────────────────
     * It was `null`, which made the one behaviour no competitor offers — a hard
     * cap enforced BEFORE the round rather than an alert after it — reachable
     * only by typing a flag nobody knew existed. See `DEFAULT_BUDGET_USD` in
     * budget.mjs for why $0.02, and why a ceiling is a blast radius rather than
     * a target. `--budget none` restores the unbounded behaviour exactly.
     */
    budgetUsd: DEFAULT_BUDGET_USD,
    /**
     * ⚠️ WHETHER THE USER CHOSE THE NUMBER. Two things depend on it and both
     * would be wrong without it: the stop message (a limit nobody set has to
     * admit where it came from and how to raise it), and `--until-done`, which
     * must keep DEMANDING an explicit ceiling — silently inheriting $0.02 would
     * make the unbounded mode stop almost at once and look broken.
     */
    budgetExplicit: false,
    /**
     * ⚠️ null AND OPT-IN, unlike `budgetUsd`. This ceiling spans every terminal
     * working this workspace today, so a default would change the meaning of a
     * plain `acuvo "…"` for someone running one terminal who never asked for a
     * fleet. `--budget` earned its default by being a per-run blast radius;
     * this one has to be chosen.
     */
    fleetBudgetUsd: null,
    /**
     * ⚠️ ON by default — see bin/acuvo.mjs. It refuses only a PROVEN conflict
     * with another live terminal, so a single-terminal run never meets it, and
     * the people who most need collision protection are exactly the ones who
     * would never have thought to switch it on.
     */
    autoLease: true,
    /**
     * ⭐ The window the fleet ceiling is measured over. `null` = today, which is
     * right for a person and wrong for a schedule — see lib/fleet-budget.mjs.
     */
    budgetWindow: null,
    /**
     * ⭐ `--unattended`: nobody is watching. Declining on budget then exits 3
     * rather than 1, so a cron log can tell "it chose not to run" from "it ran
     * and failed" — two facts that need opposite reactions and had one code.
     */
    unattended: false,
    /**
     * ⭐ `--refute`: after the run claims success, an INDEPENDENT agent with a
     * fresh context is asked to break the claim. Off by default because it is a
     * second paid run; on a $0.001 task that is a rounding error, which is
     * precisely why nobody priced at frontier rates can offer it as a default.
     */
    refute: false,
    /** The run id `acuvo verify <id>` names, or null for the most recent claim. */
    verifyId: null,
    /** `acuvo verify --all` — re-check every recorded claim, deduplicated by command. */
    verifyAll: false,
    /** Positional words after `acuvo board` — e.g. ['add', 'make the suite pass']. */
    boardArgs: [],
    /** Positional words after `acuvo rewind` — the checkpoint id, or nothing to list. */
    rewindArgs: [],
    /**
     * ⭐ CHECKPOINTS ARE ON BY DEFAULT, and that is the same argument
     * `--no-auto-lease` makes: the people who most need an undo are the ones
     * who did not think to ask for one. It costs one read of a file we are
     * about to overwrite anyway, and it creates nothing until a run writes.
     */
    checkpoint: true,
    /**
     * ⚠️ ONLY MEANINGFUL TO `acuvo rewind`. It overrides the single guard that
     * keeps a rewind from destroying your own edits, so it is never implied by
     * anything else and never on by default.
     */
    force: false,
    /**
     * ⭐ `--claim` takes the next open task off the shared board and runs it, so
     * seven terminals can be given one instruction each without a person typing
     * seven prompts. Requires `--holder`, because a claim nobody can attribute
     * tells the other six terminals nothing.
     */
    claim: false,
    /** ?? Only meaningful to `acuvo spend`. null = every record the log still holds. */
    since: null,
    untilDone: false,
    lease: [],
    holder: null,
    command: null,
    /** The creative engine the USER named for this run, per medium. null = the core engine. */
    engine: null,
  };
  const prompts = [];
  // Whether the user typed --max-rounds themselves. `--until-done` raises the
  // backstop only when they did not: an explicit number is an instruction.
  let sawMaxRounds = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { out.help = true; continue; }
    /**
     * ⚠️ `--version` IS NOT A NICETY once this is installable. It is the first
     * thing anyone types when reporting a bug, and the first thing you ask them
     * for. A CLI on someone else's machine with no way to state its own version
     * makes every bug report start with a guess.
     */
    if (arg === '-v' || arg === '--version') { out.version = true; continue; }
    if (arg === '--parallel') { out.parallel = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--issue') {
      const raw = String(argv[++i] ?? '').replace(/^#/, '');
      const n = Number(raw);
      // ⚠️ Refuse a non-number rather than coercing: `--issue main` silently
      // becoming issue 0 would fetch nothing and blame GitHub for it.
      if (!Number.isInteger(n) || n < 1) return { ok: false, error: '--issue needs an issue number, e.g. --issue 42' };
      out.issue = n;
      continue;
    }
    if (arg === '--concurrency') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1 || n > 4) return { ok: false, error: '--concurrency must be 1-4' };
      out.concurrency = Math.floor(n);
      continue;
    }
    if (arg === '--dry-run') { out.dryRun = true; continue; }
    /**
     * ⚠️ IN THE BOOLEAN BLOCK, NOT THE VALUED ONE. `--no-auto-lease` and
     * `--no-checkpoint` both shipped documented and unparseable by being written
     * into the branch that is only entered for names in `FLAGS_WITH_VALUES`;
     * `test/cli-flags-parse.test.mjs` exists because of it and drives every
     * documented boolean through this parser.
     */
    if (arg === '--plan') { out.plan = true; continue; }
    if (arg === '--strict') { out.strict = true; continue; }
    if (arg === '--offline') { out.offline = true; continue; }
    if (arg === '--no-run') { out.allowRun = false; continue; }
    /**
     * ⚠️⚠️ BOOLEAN FLAGS BELONG HERE, AND BOTH OF THESE WERE PUT IN THE WRONG
     * BLOCK FIRST. They were written into the branch that handles flags TAKING
     * A VALUE, which is only entered for names in `FLAGS_WITH_VALUES` — so
     * `--no-auto-lease` shipped documented in the README and the help text and
     * answered `Unknown option --no-auto-lease`.
     *
     * ⭐ Nothing caught it. The docs guard asserts that every flag the parser
     * mentions has a README row, and both did — it greps the SOURCE for the
     * flag string and never asks the parser to parse one. A flag can be
     * written, documented, and completely unreachable while a test that exists
     * precisely to prevent that reports green. `test/cli-flags-parse.test.mjs`
     * now drives every documented boolean flag through `parseArgv`.
     */
    if (arg === '--no-auto-lease') { out.autoLease = false; continue; }
    // ⚠️ BOOLEANS, SO THEY BELONG IN THIS BLOCK — the comment above records
    // that two flags shipped documented and unparseable by being written into
    // the valued-flag branch instead. `test/cli-flags-parse.test.mjs` drives
    // every documented boolean through the parser for that reason.
    if (arg === '--no-checkpoint') { out.checkpoint = false; continue; }
    if (arg === '--force') { out.force = true; continue; }
    if (arg === '--claim') { out.claim = true; continue; }
    if (arg === '--unattended') { out.unattended = true; continue; }
    if (arg === '--refute') { out.refute = true; continue; }
    if (arg === '--all') { out.verifyAll = true; continue; }
    /**
     * ⚠️⭐ THE ONE FLAG THAT REMOVES A SAFETY PROPERTY RATHER THAN ADDING ONE.
     * Everything else here narrows what the agent may do; this widens it to
     * every program on the machine. It is spelled out in --help, said back in
     * the banner, and recorded on every command it runs — because the operator
     * has to be able to tell, afterwards, which runs had it on.
     */
    if (arg === '--shell') { out.shell = true; continue; }
    /**
     * ⚠️ VALIDATED AGAINST `TIERS`, NOT A TYPED-OUT LIST. The ladder owns those
     * names; restating them here is how a flag ends up accepting a tier the
     * escalator has never heard of — the same defect that shipped this feature
     * disabled twice today.
     */
    if (arg === '--max-tier') {
      const raw = argv[++i];
      if (!ESCALATION_TIERS.includes(raw)) {
        return { ok: false, error: `--max-tier takes one of ${ESCALATION_TIERS.join(', ')} (got ${JSON.stringify(raw ?? null)}). It caps how hard --until-done is allowed to try.` };
      }
      out.maxTier = raw;
      continue;
    }
    if (arg === '--best-of') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 2 || n > 5) {
        return { ok: false, error: '--best-of takes a whole number from 2 to 5 (got ' + JSON.stringify(raw ?? null) + '). Below 2 it is just a run; above 5 you are paying for attempts that rarely change the answer.' };
      }
      out.bestOf = n;
      continue;
    }
    if (arg === '--until-done') { out.untilDone = true; continue; }
    if (FLAGS_WITH_VALUES.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `${arg} needs a value.` };
      }
      i += 1;
      if (arg === '--dir') out.dir = value;
      if (arg === '--model') {
        /**
         * ⭐ OUR NAMES, RESOLVED HERE. `--model acuvo-pro` is the shape a
         * user should be typing; a raw vendor id still passes through so no
         * existing script breaks. Resolved at PARSE time so a typo costs a
         * message rather than a round trip to a provider that answers "no
         * endpoints found" — and so an internal model (the reviewer) is
         * refused with the reason instead of silently becoming the builder.
         */
        const picked = resolveModelName(value);
        if (!picked.ok) return { ok: false, error: picked.error };
        out.model = picked.id;
      }
      /**
       * ── ⭐ `--engine` — THE CREATIVE ENGINE FOR THIS RUN, TYPED BY A HUMAN ──
       *
       * Roman, 2026-08-16: *"as long as users have the choice to switch between
       * premium and basic for video and image then we should be good"* — with
       * the constraint that a higher payer *"might not always want"* the dearer
       * one. So the choice is a thing you SAY, once, and it applies to the
       * medium it names; it never applies to a medium it does not.
       *
       * ⭐ VALIDATED AT PARSE TIME, exactly like `--model` two lines up and for
       * the same reason: a typo costs a message instead of a round trip and a
       * confused refusal from a render that had already started.
       *
       * ⚠️ THIS IS THE ONLY SANCTIONED WAY TO REACH AN ULTRA ENGINE FROM THE
       * COMMAND LINE, and that is the point rather than a limitation. A flag a
       * person typed is consent; software choosing the expensive engine is not.
       */
      /**
       * ⚠️ AND IT ONLY *VALIDATES* HERE — `setRunEngine` is called by
       * `bin/acuvo.mjs`, not by the parser. A parser with a side effect on
       * module state is one that cannot be called twice in a test file without
       * the second call inheriting the first one's choice, which is how a test
       * passes for the wrong reason.
       */
      if (arg === '--engine') {
        const picked = engineById(String(value).trim().toLowerCase());
        if (!picked) {
          return {
            ok: false,
            error: `--engine takes an Acuvo engine id (got ${JSON.stringify(value)}). `
              + `Choices: ${CREATIVE_ENGINES.map((e) => e.id).join(', ')}. Run \`acuvo engines\` to see what each one costs.`,
          };
        }
        out.engine = picked.id;
      }
      if (arg === '--max-tokens') {
        const n = Number(value);
        // ⚠️ A non-numeric --max-tokens must not become NaN and travel to the
        // API as `"max_tokens": null`, which reads as "no ceiling" — the one
        // parse failure here that costs money rather than producing an error.
        if (!Number.isInteger(n) || n < 256 || n > 64_000) {
          return { ok: false, error: `--max-tokens must be a whole number between 256 and 64000 (got ${JSON.stringify(value)}).` };
        }
        out.maxTokens = n;
      }
      if (arg === '--timeout') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 5 || n > 900) {
          return { ok: false, error: `--timeout must be between 5 and 900 seconds (got ${JSON.stringify(value)}).` };
        }
        out.timeoutMs = Math.round(n * 1000);
      }
      /**
       * ⚠️ THE VALUE IS PARSED BY `budget.mjs`, AND ITS REFUSAL IS RETURNED
       * VERBATIM. Re-wording it here would give the same mistake two different
       * explanations depending on which layer noticed it.
       */
      if (arg === '--since') { out.since = value; continue; }
      if (arg === '--budget') {
        /**
         * ⭐ `--budget none` IS THE WAY BACK OUT, and it exists because the
         * ceiling is now on by default. A default you cannot turn off is not a
         * default, it is a policy — and the stop message promises this escape
         * hatch by name, so it has to be real.
         */
        if (/^(none|off|unlimited)$/i.test(String(value ?? '').trim())) {
          out.budgetUsd = null;
          out.budgetExplicit = true;
        } else {
          const parsed = parseBudgetUsd(value);
          if (!parsed.ok) return { ok: false, error: parsed.message };
          out.budgetUsd = parsed.usd;
          out.budgetExplicit = true;
        }
      }
      /**
       * ── ⭐ `--fleet-budget` — THE CEILING ACROSS EVERY TERMINAL, NOT THIS ONE ──
       *
       * `--budget` caps a run. Seven terminals on one repository is the thing
       * this tool exists to make possible, and seven runs multiply that cap by
       * seven — so the number a person chose quietly becomes a different number
       * the moment they do what the product tells them to do.
       *
       * This is the spend cap for this WORKSPACE, for today, summed across
       * every terminal from the audit log they all already write to.
       *
       * ⚠️ OPT-IN, unlike `--budget`. A fleet is something you assemble
       * deliberately, and a default here would fire for people running one
       * terminal who never asked — the same trap that made the per-run default
       * silently disable `--parallel` before `budgetExplicit` existed.
       *
       * ⚠️ `none` is accepted for symmetry with `--budget`, and means the same
       * thing: no fleet ceiling. Parsing is `budget.mjs`'s, so `25c` and `$2`
       * work here exactly as they do there and a bad value gets ONE wording.
       */
      if (arg === '--budget-window') {
        /**
         * ⚠️ PARSED BY `spend.mjs`, whose `parseSince` already understands
         * `7d`, `24h` and a date — one reading of a period, so `--since` and
         * this cannot disagree about what `7d` means.
         */
        const parsed = parseSince(value);
        if (parsed?.error) return { ok: false, error: parsed.error };
        out.budgetWindow = parsed instanceof Date ? parsed : (parsed?.since ?? null);
        if (!out.budgetWindow) return { ok: false, error: `--budget-window did not understand ${JSON.stringify(value)}. Try 7d, 24h, or a date like 2026-08-01.` };
        continue;
      }
      if (arg === '--fleet-budget') {
        if (/^(none|off|unlimited)$/i.test(String(value ?? '').trim())) {
          out.fleetBudgetUsd = null;
        } else {
          const parsed = parseBudgetUsd(value);
          if (!parsed.ok) return { ok: false, error: parsed.message };
          out.fleetBudgetUsd = parsed.usd;
        }
        continue;
      }
      /**
       * ⭐ REPEATABLE, NOT LAST-WINS. `--lease a.ts --lease b.ts` means both
       * files; a last-wins flag would silently take one lease and leave the
       * other file unprotected, which is worse than not having the feature —
       * the user would believe they were covered.
       */
      if (arg === '--lease') {
        const path = value.trim();
        if (!path) return { ok: false, error: '--lease needs a path inside the workspace, e.g. --lease src/app.ts' };
        out.lease.push(path);
      }
      if (arg === '--holder') {
        const name = value.trim();
        if (!name) return { ok: false, error: '--holder needs a name, e.g. --holder terminal-3' };
        out.holder = name;
      }
      if (arg === '--max-rounds') {
        sawMaxRounds = true;
        const n = Number(value);
        // ⚠️ Same reasoning as --max-tokens, and with sharper teeth: a round IS
        // a paid completion, so a NaN reaching the loop as a comparison bound
        // would make `round <= NaN` false and silently produce a zero-round run,
        // or — with the comparison written the other way — an unbounded one.
        if (!Number.isInteger(n) || n < 1 || n > MAX_ROUNDS_LIMIT) {
          return { ok: false, error: `--max-rounds must be a whole number between 1 and ${MAX_ROUNDS_LIMIT} (got ${JSON.stringify(value)}). Each round is a paid completion.` };
        }
        out.maxRounds = n;
      }
      if (arg === '--command-timeout') {
        const n = Number(value);
        const maxSeconds = MAX_COMMAND_TIMEOUT_MS / 1000;
        if (!Number.isFinite(n) || n < 1 || n > maxSeconds) {
          return { ok: false, error: `--command-timeout must be between 1 and ${maxSeconds} seconds (got ${JSON.stringify(value)}).` };
        }
        out.commandTimeoutMs = Math.round(n * 1000);
      }
      continue;
    }
    if (arg.startsWith('--')) return { ok: false, error: `Unknown option ${arg}. Run with --help.` };
    prompts.push(arg);
  }

  // Joined rather than "first wins": an unquoted prompt arrives as many argv
  // entries, and silently using only the first word is the worst possible
  // reading of what the user meant.
  /**
   * ── ⭐ `--parallel` KEEPS THE PROMPTS SEPARATE ────────────────────────────
   * Without it, several quoted arguments are ONE task (an unquoted prompt
   * arrives as many argv entries, and taking only the first word is the worst
   * possible reading). With it, each quoted argument is its own task.
   *
   * ⚠️ SEQUENTIAL REMAINS THE DEFAULT AND MUST. Two agents in one workspace can
   * overwrite each other, so the safe behaviour has to be what happens when you
   * do not think about it. Parallelism is a thing you ask for.
   */
  if (out.parallel) {
    out.tasks = prompts.map((p) => p.trim()).filter(Boolean);
    if (out.tasks.length < 2) {
      return { ok: false, error: '--parallel needs at least two quoted tasks, e.g. acuvo --parallel "add tests" "write the README"' };
    }
  }
  /**
   * ⭐ THE COMMAND WORD, CLAIMED BEFORE THE PROMPT IS ASSEMBLED. Exactly one
   * positional, and it must be the one the user typed first — see COMMANDS.
   */
  if (prompts.length === 1 && COMMANDS.has(prompts[0]) && argv[0] === prompts[0]) {
    out.command = prompts[0];
    prompts.length = 0;
  }
  /**
   * ── ⭐ `board` IS THE ONE COMMAND THAT TAKES ARGUMENTS ──────────────────────
   *
   * `leases` and `spend` are bare words, so the rule above ("exactly one
   * positional, and it must be first") fits them exactly. `acuvo board add
   * "make the suite pass"` is three positionals, so it needs its own clause
   * rather than a loosening of that one — widening the shared rule to allow
   * trailing words would let `acuvo leases are broken` become a command instead
   * of the instruction it obviously is.
   *
   * ⚠️ STILL ANCHORED ON `argv[0]`. "board" is an ordinary English word and
   * `acuvo "the board is rendering wrong"` must remain a task.
   */
  /**
   * ⚠️ A RUN ID LOOKS LIKE ONE, OR THIS IS A TASK. `acuvo verify` and
   * `acuvo verify 2026-08-13T12:34:25.408Z-479f8318` are the command;
   * `acuvo verify the invoice bug is fixed` is an instruction, and reading its
   * second word as a run id would answer a question nobody asked — the exact
   * trap the bare-word rule above exists to avoid.
   *
   * Ids are ISO-dated, so "starts with a four-digit year" separates them from
   * English without a list of words to maintain.
   */
  const looksLikeRunId = (w) => typeof w === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(w);
  if (argv[0] === 'verify' && prompts[0] === 'verify'
    && (prompts.length === 1 || (prompts.length === 2 && looksLikeRunId(prompts[1])))) {
    out.command = 'verify';
    out.verifyId = prompts[1] ?? null;
    prompts.length = 0;
  }
  if (argv[0] === 'board' && prompts[0] === 'board') {
    out.command = 'board';
    out.boardArgs = prompts.slice(1);
    prompts.length = 0;
  }
  /**
   * ── ⭐ `acuvo rewind [id]` — THE FIRST POSITIONAL, *NOT* `argv[0]` ──────────
   *
   * ⚠️⚠️ MEASURED 2026-08-14, AND IT COST REAL MONEY. Written first with the
   * `argv[0] === 'rewind'` anchor the other commands use, `acuvo --dir <ws>
   * rewind` did not dispatch at all: argv[0] was `--dir`, so the word fell
   * through as a TASK and a paid agent session spent $0.0030 reading the
   * workspace and doing nothing. Twice. A command that silently becomes a paid
   * run when you put a flag before it is worse than one that refuses.
   *
   * ⭐ `prompts[0]` IS ALREADY THE SAFE TEST. Anything consumed as a flag's
   * VALUE never reaches `prompts` — `--model rewind` is a model id and is gone
   * by here — so the first positional being exactly `rewind` means the user
   * typed it as a word of their own.
   *
   * ⚠️ THE ENGLISH-WORD RISK IS STILL HANDLED, just differently: an actual
   * instruction is quoted, so `acuvo "rewind the migration to the previous
   * schema"` is ONE positional that is not equal to `rewind` and stays a task.
   * What is claimed here is the bare word, which as a task is not an
   * instruction anybody means — that is exactly what the two wasted runs above
   * proved.
   *
   * ⚠️ AND AT MOST ONE ARGUMENT. `acuvo rewind the last thing you did` reads its
   * second word as a checkpoint id and is refused by name, which costs nothing;
   * treating it as a task would have restored nothing and charged for it.
   *
   * ⚠️ `board`, `verify`, `leases` and `spend` STILL USE THE `argv[0]` ANCHOR
   * and so `acuvo --dir <path> board` is still a paid task run. That is a real
   * defect in a file another lane is editing today; it is reported rather than
   * fixed here.
   */
  if (prompts[0] === 'rewind' && prompts.length <= 2) {
    out.command = 'rewind';
    out.rewindArgs = prompts.slice(1);
    prompts.length = 0;
  }

  /**
   * ── ⚠️⚠️ THE ONE REFUSAL THIS PACKAGE IS NOT ALLOWED TO SOFTEN ────────────
   *
   * An unbounded loop against a paid endpoint, running unattended, on someone
   * else's money, is the single most dangerous thing here. `--until-done` is
   * exactly that loop, so it may not exist without a number the user typed
   * saying what it is allowed to cost.
   *
   * ⚠️ AND IT IS REFUSED, NOT DEFAULTED. Picking a default ceiling for someone
   * would be this tool deciding how much of their money it may spend while they
   * are asleep. The error names the flag and shows the whole invocation, because
   * a refusal that does not say what to type instead is just an obstacle.
   */
  if (out.untilDone) {
    /**
     * ⚠️ EXPLICIT, NOT MERELY PRESENT. Since 2026-08-12 `budgetUsd` carries a
     * $0.02 default, so `=== null` would no longer catch anything and this
     * refusal would quietly die — handing the unbounded mode a ceiling that
     * stops it almost immediately, which reads as a broken feature rather than
     * a missing flag. The question was always "did a human choose a number for
     * this run", and now it has to be asked that way.
     */
    if (!out.budgetExplicit) {
      return {
        ok: false,
        error: '--until-done keeps working until the job is done, so it MUST be given a spending ceiling.\n'
          + 'Add --budget:  acuvo --until-done --budget 0.50 "<task>"\n'
          + 'A typical task costs well under a cent, so 0.50 is a large allowance. An unbounded\n'
          + 'loop against a paid API is the one thing this CLI will not do.',
      };
    }
    // The counter stops being the wall; money becomes it. An explicit
    // --max-rounds is still honoured, because the user said a number.
    if (!sawMaxRounds) out.maxRounds = UNTIL_DONE_MAX_ROUNDS;
  }

  /**
   * ⚠️ A BUDGET IS PER CONVERSATION, AND `--parallel` RUNS SEVERAL. Accepting
   * the pair would silently multiply the ceiling by the number of tasks — the
   * user types 0.50, three tasks run, $1.50 is spent, and every layer involved
   * was individually honest. Dividing it instead would be worse: each share
   * could fall under the one-round floor and every task would refuse to start
   * for a reason nobody typed. So this is refused, and the message states the
   * real total so the number is never a surprise.
   */
  /**
   * ⚠️⚠️ `budgetExplicit`, NOT `budgetUsd !== null` — AND THE SUITE CAUGHT ME.
   *
   * This refusal is right when a human typed a number: they said "$0.20" and
   * `--parallel 2` would quietly permit $0.40, so surprising them is worse than
   * refusing. It became WRONG the moment a default ceiling existed, because it
   * then fired for everyone — `--parallel` was refused outright for a budget
   * nobody had asked for. A feature silently disabled by someone else's default
   * is the exact "don't break what works" failure this package keeps paying for.
   *
   * ⭐ And the default has no surprise to prevent: it is a per-run blast radius
   * by construction, so N conversations getting N × $0.02 is what it means
   * rather than a number anyone was misled about.
   */
  if (out.budgetExplicit && out.budgetUsd !== null && out.parallel) {
    const total = formatUsd(out.budgetUsd * Math.max(1, out.tasks.length));
    return {
      ok: false,
      error: `--budget is a ceiling for ONE conversation and --parallel starts ${out.tasks.length}, so together they would allow ${total}, not ${formatUsd(out.budgetUsd)}.\n`
        + 'Run the tasks one at a time with their own budgets, or drop --budget.',
    };
  }

  out.task = prompts.join(' ').trim();
  /**
   * ── ⭐ NO PROMPT IS NOW A VALID INVOCATION ────────────────────────────────
   * It used to be a usage error. `acuvo` with no argument opens an INTERACTIVE
   * session — the shape every coding agent people already know uses, and the one
   * that makes the prompt cache pay: an unchanged prefix caches at 97.2%, so the
   * second instruction in a conversation costs a fraction of the first.
   *
   * ⚠️ A bare `acuvo` must NOT be treated as an empty task and sent to the
   * model. An empty prompt is a paid round-trip that can only produce a
   * confused reply, which is why `task` stays empty here and the entry point
   * branches on it rather than defaulting it to something.
   */
  return { ok: true, options: out };
}

/* ══════════════════════════════════════════════════════════════════════════
 * ── ⚠️⚠️ THE SECOND LOCK ON `--plan`, AND THE ONE THAT WAS MISSING ─────────
 *
 * `--plan`'s headline promise is printed thirty lines above, in `USAGE`:
 * *read-only until you approve*. When the gate shipped it had exactly ONE
 * lock — `planModeToolNames` narrows the OFFER to `ORIENT_TOOLS`, so the model
 * is never SHOWN `write_file`.
 *
 * ⚠️ THAT IS A BELT WITH NO BRACES, AND THIS PACKAGE ALREADY SAID SO — in
 * `tools.mjs`, at `run_program`'s own dispatcher guard:
 *
 *   "a model can emit a call for a tool it was never shown (a stale
 *    conversation, a resumed session, a provider that echoes an old tool
 *    list), and the flag has to hold at the point the process would actually
 *    start."
 *
 * The RUN half of `--plan` obeyed that rule: the proposal phase passes
 * `allowRun: false`, and `executeToolCall` refuses the nine process-starting
 * verbs at the dispatcher whatever the offer said. The WRITE half had nothing.
 * `executeToolCall` is a `switch` on the tool NAME, and `case 'write_file'`
 * calls `executor.writeFile` with no gate between them — `allowRun` is not
 * consulted, correctly, because a write starts no process.
 *
 * ── ⭐ MEASURED, NOT ARGUED (2026-08-20) ────────────────────────────────────
 *
 * Driven through the REAL `runSession` with the exact options `bin/acuvo.mjs`
 * passes to the proposal phase — `toolNames` = the 13-name read-only
 * intersection, `allowRun: false`, `maxRounds: 5` — against a real
 * `createLocalExecutor` on a real temp directory, with a scripted model that
 * emitted three names it had never been offered:
 *
 *   offer size: 13 | write_file offered? false
 *   write_file  → ok=true mutated=true   pwned.txt on disk: "the proposal phase wrote this"
 *   edit_file   → ok=true mutated=true   app.js: "const a = 1;" → "const a = 2;"
 *   delete_file → ok=true mutated=true   doomed.js gone
 *
 * Three files changed during the phase whose entire promise is that nothing
 * changes. The headline safety property was refuted with one fixture.
 *
 * ── ⭐⭐ WHY THE FIX IS THE EXECUTOR AND NOT A LIST OF TOOL NAMES ───────────
 *
 * A deny-list keyed on tool NAMES goes stale the day a tool is added — this
 * repo has paid for that five times over (`turn.mjs`: "a guard keyed on the
 * NAME OF A TOOL goes stale every time a tool is added — this is the fifth").
 * The executor is the opposite: every mutating verb in the dispatcher, present
 * or future, reaches disk through exactly three methods —
 *
 *   write_file, write_files, edit_file → executor.writeFile
 *   delete_file                        → executor.deleteFile
 *   move_file                          → executor.moveFile
 *
 * — and `case 'delegate'` hands this same object to `runSubagent`, so a helper
 * spawned during a proposal inherits the refusal without a second rule being
 * written anywhere. Close those three and the phase is read-only by
 * construction rather than by the model's cooperation.
 *
 * ── ⚠️ WHY IT LIVES IN THE ARGUMENT PARSER ─────────────────────────────────
 *
 * Because this is the file that MAKES the promise. `USAGE` is where a user
 * reads "it cannot write while it is proposing", and a promise whose
 * enforcement lives three modules away is a promise that drifts — which is
 * precisely what happened: the sentence shipped and the lock did not. It
 * imports nothing and touches no disk, so this module stays what its header
 * says it is: pure, and testable without spawning a process.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ ONE SENTENCE, USED BY ALL THREE METHODS. The model reads this as a tool
 * result and decides what to do next; three different wordings for one rule
 * teaches it that some writes might work if it rephrases, which is the exact
 * "talk your way past the gate" behaviour the phase exists to prevent.
 *
 * ⭐ AND IT NAMES THE WAY THROUGH, which is a standing rule here: a refusal
 * that only says no makes the model spend the rest of the phase retrying. This
 * one says what unblocks it — a human approving the plan — so the correct next
 * move is to finish writing the plan.
 */
export const PLAN_PHASE_REFUSAL =
  'this is PLAN MODE — nothing may be written, deleted or moved until a human has read your plan and approved it. '
  + 'Do not retry: describe this change as a numbered step in the plan instead, naming the file, and it will be '
  + 'carried out for real once the plan is approved.';

/** The shape every refused method returns — the dispatcher's ordinary failure. */
const refusePlanPhaseWrite = () => ({ ok: false, error: PLAN_PHASE_REFUSAL });

/**
 * Wrap an executor so the `--plan` proposal phase cannot change anything.
 *
 * Reads (`readFile`, `listDir`), the workspace `root` and the lease `holder`
 * pass straight through — the phase exists in order to LOOK, and a guard that
 * broke reading would make `--plan` useless rather than safe.
 *
 * @param {{ root: string, dryRun?: boolean, holder?: string|null, readFile: Function, listDir: Function, writeFile?: Function, deleteFile?: Function, moveFile?: Function }} executor
 * @returns {object} a NEW executor; the one passed in is untouched
 */
export function planPhaseExecutor(executor) {
  if (!executor || typeof executor !== 'object') {
    throw new TypeError('planPhaseExecutor needs the executor the run was built with');
  }
  return {
    /**
     * ⚠️ SPREAD FIRST, OVERRIDE AFTER. An executor is not a fixed interface —
     * the browser builder implements the same verbs over a Map and may carry
     * fields this file has never heard of. Listing the survivors by hand would
     * silently drop them; spreading and then closing the three doors that
     * matter keeps the wrapper correct for an executor written next year.
     *
     * ⚠️ AND IT IS A NEW OBJECT, NEVER A MUTATION. The APPROVED run uses the
     * original executor and must be able to write the moment the human says
     * yes. Monkey-patching the live executor and restoring it afterwards would
     * put the whole guarantee on a `finally` block surviving an exception.
     */
    ...executor,
    /**
     * ⚠️ `dryRun` IS NOT DECORATION. Six verbs (`speak`, `transcribe`,
     * `make_document`, `see_page`, `edit_image`, `expand_image`) are handed
     * `executor.root` and `executor.dryRun` and write through `fs` directly
     * rather than through `executor.writeFile`, so the three overrides below
     * cannot see them. They all honour `dryRun`, so this is what stops a
     * name-guessed `speak` leaving a .wav in a workspace nobody has approved a
     * change to. It also makes `loadPlanQuietly` (turn.mjs) skip reading
     * `.acuvo/plan.json`, which is what the proposal phase wants anyway: there
     * is by construction no plan for this task yet, so the only one it could
     * load is somebody else's.
     *
     * ⚠️⚠️ ONE VERB IS STILL OUTSIDE THIS FUNCTION'S REACH, and it is named
     * here rather than left for someone to find: `generate_image` resolves
     * against `executor.root` and calls `writeFileSync` without consulting
     * `dryRun` at all (`lib/imagegen.mjs`). It is not offered during a
     * proposal and `allowRun` does not cover it (it starts no process), so
     * closing it needs a guard inside `executeToolCall` itself — `tools.mjs`.
     */
    dryRun: true,
    writeFile: refusePlanPhaseWrite,
    deleteFile: refusePlanPhaseWrite,
    moveFile: refusePlanPhaseWrite,
  };
}
