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
/**
 * ⭐ `selectableModels` IS IMPORTED SO THE HELP TEXT CAN NAME OUR MODELS RATHER
 * THAN OUR SUPPLIER'S. `acuvo-models.mjs` is the one mapping from an Acuvo name
 * to a vendor id, and its header states the rule this file now follows: *"Every
 * other module asks this file rather than embedding a vendor id."* The `--model`
 * row used to print both a provider's name and a raw vendor id to every user.
 */
import { resolveModelName, selectableModels, ACUVO_MODELS } from './acuvo-models.mjs';
import { TIERS as ESCALATION_TIERS } from './escalate.mjs';
/** The four questions — see the `doneWhen` block in the defaults below. */
import { DONE_MODES, DEFAULT_DONE_MODE } from './acceptance.mjs';
import { STUCK_ACTIONS, DEFAULT_STUCK_ACTION } from './stuck.mjs';
import { APPROVE_MODES, DEFAULT_APPROVE_MODE } from './diff-preview.mjs';
import { MAX_QUESTIONS } from './ask-user.mjs';
/**
 * ⚠️⚠️ THE LIST BELOW WAS TYPED OUT, AND IT WENT STALE THE DAY A COMMAND WAS
 * ADDED. On 2026-09-19 `--help` still read *"(/skills, /mcp, /cost, /model,
 * /clear)"* while `/config`, `/approve` and `/rewind` had just joined the
 * registry — a second copy of `SLASH_COMMANDS` in the one document a new user
 * reads, advertising five of eight. `/help` generates itself from the registry
 * for exactly this reason; this line now does too.
 */
import { SLASH_COMMANDS } from './slash.mjs';
import { DEFAULT_MAX_PARALLEL } from './round-schedule.mjs';
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

/** `--output-format` values. `stream-json` is NDJSON on stdout — see lib/stream-json.mjs. */
export const OUTPUT_FORMATS = Object.freeze(['text', 'json', 'stream-json']);

/**
 * ── ⭐⭐⭐ THE LONG-HORIZON CEILING, WHEN MONEY IS ALREADY BOUNDING ─────
 *
 * Roman, 2026-08-23: *"yes we need long horizon ceiling gone."*
 *
 * ⭐ THIS FILE ALREADY ARGUED HIS CASE: *"the round counter is an arbitrary stop
 * and always was ... the money runs out first, every time, and this only ever
 * catches the case where the governor itself is broken."* The ceiling was a
 * blast radius for SPEND, and spend has had its own governor since 2026-08-12.
 *
 * ⚠️⚠️ BUT `--budget none` EXISTS, AND IT IS WHY THIS IS TWO NUMBERS AND NOT
 * ONE. A user who types it has deliberately removed the money governor; if the
 * round ceiling rose at the same time, both safety nets would be gone together
 * and the result is a `while (true)` spending real money. Raising a single
 * constant would have done exactly that, silently.
 *
 * ⭐ SO THE CEILING FOLLOWS THE GOVERNOR:
 *   - budget in force (the default, and every ordinary run) -> this number. The
 *     round count stops being a product limit and becomes a runaway backstop.
 *   - `--budget none` -> `MAX_ROUNDS_LIMIT` (64), unchanged. Rounds are then the
 *     ONLY thing between a bug and an unbounded bill.
 *
 * ⚠️ WHAT 64 WAS COSTING, measured 2026-08-23 on Terminal-Bench 2.1: with a
 * correctly-built bundle, `adaptive-rejection-sampler` ran every round it was
 * given and stopped at `round-cap`. It did not fail the task; it ran out of
 * turns. A cap that is REACHED is a cap that is deciding the score.
 *
 * ⚠️ THE DEFAULT DOES NOT MOVE. `DEFAULT_MAX_ROUNDS` is still 24: a user who
 * asks for nothing must never spend more because a ceiling moved.
 */
export const MAX_ROUNDS_LIMIT_BUDGETED = 1000;

/** The ceiling that applies, given whether money is bounding this run. */
export function maxRoundsLimitFor(budgetUsd) {
  return budgetUsd === null || budgetUsd === undefined
    ? MAX_ROUNDS_LIMIT
    : MAX_ROUNDS_LIMIT_BUDGETED;
}

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

/**
 * The Acuvo NAME of whatever `DEFAULT_MODEL` currently points at.
 *
 * ⚠️ LOOKED UP, NEVER TYPED. If somebody re-points `DEFAULT_MODEL` at an id the
 * catalogue does not carry, this falls back to the first selectable name rather
 * than printing the vendor id — the help text is a shipped surface and must not
 * leak one even when the constants disagree.
 */
function defaultModelName() {
  const hit = Object.values(ACUVO_MODELS).find((m) => m.id === DEFAULT_MODEL && !m.internal);
  return hit?.name ?? selectableModels()[0]?.name ?? 'the default';
}

/**
 * Break one sentence into `--help`'s right-hand column.
 *
 * ⚠️ WORDS, NEVER CHARACTERS. A hard slice would cut `/approve` in half the
 * first time a name grew, which is a worse failure than a ragged line.
 *
 * @param {string} text  the sentence
 * @param {number} indent  how many spaces the column starts at
 * @param {number} width  how many characters the column is wide
 */
function wrapIndented(text, indent, width) {
  const pad = ' '.repeat(indent);
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line.length + 1 + word.length) > width) { out.push(pad + line); line = word; continue; }
    line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(pad + line);
  return out;
}

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
  /**
   * ⚠️ WRAPPED BY MEASUREMENT, NOT BY HAND. A hand-broken line is the other
   * half of the same staleness: it is correct for today's names and ragged for
   * tomorrow's.
   */
  ...wrapIndented(
    `for the commands it understands (${SLASH_COMMANDS.map((c) => `/${c.name}`).join(', ')}).`
    + ' Ctrl-C returns you to the prompt.',
    24,
    56,
  ),
  /**
   * ⚠️ MENTIONED HERE BECAUSE IT IS NOT A FLAG AND NOT A `/` COMMAND, so neither
   * the options table nor `/help` would ever have named it — exactly how the
   * interactive prompt itself went unmentioned until 2026-08-19.
   */
  '                        Write `@src/app.ts` in a message and that file is sent',
  '                        with it. An `@` that names nothing stays as plain text.',
  '                        Start a line with `!` to run a command yourself',
  '                        (`!git status`, `!npm test`) — no model call; its output',
  '                        goes along with your next message.',
  '                        Multi-line: paste freely (a paste never sends), or end a',
  '                        line with `\\` / press Alt+Enter. Tab completes a /command.',
  '',
  /**
   * ── ⚠️⚠️⭐ THIS LINE USED TO TEACH THE CLONE PATH, AND SOMEBODY BELIEVED IT ──
   *
   * It read: `(from a clone, without installing:  node bin/acuvo.mjs "<task>")`.
   * An outside reader took that route end to end and concluded they never had
   * to pay — the front door of a product whose entire business is "one account,
   * and it is the one you already have" was demonstrating how to skip the
   * account. A dev invocation belongs in a contributing guide, not in the help
   * text a paying user reads.
   *
   * ⭐ THE TWO LINES A NEW USER ACTUALLY NEEDS, in the order they need them.
   * `npm i -g acuvo-code` is real: `npm view acuvo-code version` answered
   * `0.6.17` on 2026-08-25, and this manifest is that version.
   */
  '  Install:  npm i -g acuvo-code',
  '  Sign in:  acuvo --login          (one account, and it covers the model calls)',
  '',
  'Options:',
  `  --dir <path>          Workspace root (default: the current directory).`,
  /**
   * ── ⚠️⚠️ NO SUPPLIER NAMES IN SHIPPED SURFACES ─────────────────────────────
   *
   * This row read: `OpenRouter model id (default: $OPENROUTER_CODEGEN_MODEL,
   * else deepseek/…)`. Three leaks in one line — who we buy from, an internal
   * environment variable, and a vendor model id — printed by `--help` on every
   * customer's machine. `lib/acuvo-models.mjs` exists precisely so that "every
   * other module asks this file rather than embedding a vendor id".
   *
   * ⭐ DERIVED, NOT TYPED. The names come from `selectableModels()` and the
   * default is found by matching `DEFAULT_MODEL` against the same catalogue, so
   * re-pointing a name stays the one-line change that file promises. A raw
   * vendor id still PARSES (see `resolveModelName`) — it is simply no longer
   * advertised.
   */
  `  --model <id>          Which model writes the code: ${selectableModels().map((m) => m.name).join(', ')}`
    + ` (default: ${defaultModelName()}).`,
  '                        Most runs should leave this alone — the default is what the budget',
  '                        projections are calibrated against.',
  `  --max-rounds <n>      Write→run→fix rounds, 1-${MAX_ROUNDS_LIMIT_BUDGETED} while a budget bounds the run (default: ${DEFAULT_MAX_ROUNDS}; ${MAX_ROUNDS_LIMIT} with --budget none).`,
  /**
   * ── ⭐⭐ THE TWO FLAGS THAT MOVE THE STOP CONDITION FROM A COUNTER TO MONEY ─
   * Documented here and not only in the changelog, because a capability nobody
   * can find is the same orphan as a module nobody imports.
   */
  '  --budget <usd>        Stop when the NEXT round would cross this much spend.',
  '                          --budget 0.50 · --budget 25c · --budget $2',
  '                        Refuses to start at all if it cannot afford one round,',
  '                        so it never spends money to discover it had none.',
  /**
   * ── ⚠️⚠️ THIS LINE SAID "$0.02" AND THE DEFAULT HAS BEEN $0.05 SINCE
   *    2026-08-19 ───────────────────────────────────────────────────────────
   *
   * The ceiling was deliberately raised $0.02 → $0.05 (`DEFAULT_BUDGET_USD`,
   * and its comment records the whole decision) and **the two strings a user
   * actually reads were not touched** — this one, and the no-key message in
   * `model.mjs`. So for two weeks the front door understated the money the tool
   * may spend on your behalf by 2.5x, to a pre-revenue owner paying out of
   * pocket. `docs-truth.test.mjs` exists and did not catch it, because it
   * checks numbers quoted about FILES, not numbers quoted about money.
   *
   * ⭐ INTERPOLATED, NOT CORRECTED. Typing `$0.05` here would be the same bug
   * with a fresher number and a shorter fuse; the constant is the only thing
   * that cannot drift from itself.
   */
  `                        ⭐ A $${DEFAULT_BUDGET_USD} ceiling is ALREADY ON. A measured task costs`,
  '                        $0.0008–$0.003, so it never fires on ordinary work — it',
  `                        is there so a runaway costs $${DEFAULT_BUDGET_USD} to find. Raise it`,
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
  /**
   * ── ⚠️⭐ FIVE OF SEVEN SUBCOMMANDS WERE INVISIBLE (added 2026-09-07) ────────
   *
   * MEASURED by reading the dispatch: `bin/acuvo.mjs` answers `config`,
   * `engines`, `spend`, `verify`, `board`, `rewind` and `leases`. This help
   * listed **two**. Every one of the other five works and prints something a
   * person would want — `acuvo spend` reported a night of real runs at 0.669
   * cents, `acuvo engines` prices every creative engine from the live account —
   * and none of them could be found without reading the source.
   *
   * ⚠️ THIS IS THE COMMAND-LEVEL HALF OF A DEFECT ALREADY MEASURED AT THE VERB
   * LEVEL: *"26 of 82 verbs are mentioned nowhere a user looks."* A capability
   * nobody can find is indistinguishable from one that does not exist, which is
   * this codebase's most repeated failure wearing its plainest form.
   */
  '',
  'Commands — run instead of a task. None of these call a model or cost anything.',
  '  engines               Every creative engine and what one run costs, priced from',
  '                        your account right now — image, video, voice, face.',
  '  spend                 What this workspace has actually spent, by model and by run.',
  '  config                The four questions: what this run will do, and who decided it.',
  '  board                 The shared task list several terminals can claim from.',
  '  leases                Which files are claimed right now, and by which terminal.',
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
  '  --no-parallel-tools   Run every tool call one at a time. By default, read-only calls that',
  '                        wait on the network or a subprocess (git_status, git_diff, fetch_url)',
  '                        may overlap within one round; writes and commands never do.',
  // ⚠️ THE HELP LINE NAMES THE BLAST RADIUS, NOT THE VERB. "enables git_push"
  // tells a reader nothing they can weigh; "other people will see it" does.
  '  --allow-push          Let this run push a branch to the remote. OFF by default: a push is',
  '                        visible to people who are not at this keyboard and cannot be undone.',
  '                        One run only — nothing is remembered. (Same as ACUVO_ALLOW_PUSH=1.)',
  '  --allow-deploy        Let this run deploy a Vercel PREVIEW. OFF by default: a deploy spends',
  '                        a paid build on your account. It still has to plan first and state the',
  '                        cost, and it can never deploy to production. (Same as ACUVO_ALLOW_DEPLOY=1.)',
  /**
   * ── ⚠️⚠️ THE FLAG THIS BLOCK WAS MISSING, AND WHAT IT IS *NOT* ─────────────
   *
   * `npm install` has been gated on `ACUVO_ALLOW_INSTALL` since it shipped, and
   * the variable is documented in `README.md` — so the fair charge is not that
   * it was undocumented, it is that `--help` never named it and there was no
   * flag. Somebody whose agent said "I cannot add a dependency" had to read the
   * whole refusal to find the way out.
   *
   * ⚠️ THE LINE STATES THE BLAST RADIUS, like its two neighbours. An install
   * runs code that arrived from a stranger thirty milliseconds ago; that is the
   * fact a reader weighs, not the name of a subcommand.
   *
   * ⭐ AND IT NAMES WHAT STAYS REFUSED IN THE SAME BREATH, because a flag
   * called `--allow-install` reads like "installs now work" and `npm exec`,
   * `npm publish` and every `pip`/`cargo`/`bundle` route still do not.
   */
  '  --allow-install       Let this run add a dependency: `npm install <pkg>` and `npm ci`. OFF by',
  '                        default, because an install downloads and runs code from the registry —',
  '                        the one thing a list of allowed program names cannot check. When on:',
  /**
   * ⚠️ "install scripts are never run", NOT the flag name that does it.
   * `mistyped-command-refuses.test.mjs` reads every `--word` out of the RENDERED
   * help and demands the refusal table know it — so naming npm\'s own
   * `--ignore-scripts` here made `--help` teach a flag acuvo does not have, and
   * the guard correctly went red. The behaviour is what a reader needs anyway.
   */
  '                        install scripts are never run, registry names only (no URL, git or file:),',
  '                        four packages max, and the package.json change shows up in the diff.',
  '                        Still refused with it: npm exec, npm publish, and installers for other',
  '                        ecosystems (pip, cargo, bundle, go get) — use --shell for those.',
  '                        One run only — nothing is remembered. (Same as ACUVO_ALLOW_INSTALL=1.)',
  /**
   * ── ⭐⭐ THE FOURTH OPERATOR SWITCH, AND IT HAD NO FLAG EITHER ─────────────
   *
   * `ACUVO_GH_WRITE` has gated `gh_pr create`, `gh_issue comment` and the rest
   * since they shipped, and it was tested (`gh-verbs`, `gh-write`) — but it
   * appeared in no `--help` line, no `--doctor` row, no completion, and
   * `docs/STATUS.md` did not name it. So the only ways to learn the escape were
   * to read `lib/gh.mjs` or to be refused first and read the whole refusal.
   *
   * ⚠️ THAT IS WORD FOR WORD THE DEFECT `--allow-install` WAS CREATED TO FIX,
   * three switches above, still live for the one gate that WRITES TO THE
   * INTERNET UNDER THE USER'S OWN GITHUB IDENTITY. A comment ten lines up in
   * this file already says "HAD NO FLAG, AND THAT IS THE SAME DEFECT"; it was
   * about npm, and nobody swept the others.
   *
   * ⭐ THE BOUNDARY DOES NOT MOVE, exactly as with `--allow-install`. The flag
   * buys what the variable already bought: the ADDITIVE writes. `pr merge`,
   * `issue close` and a re-run stay refused with it on, because they are
   * visible to everyone watching the repository and cannot be undone by trying
   * again — so the line says so rather than implying more than it buys.
   */
  '  --allow-gh-write      Let this run write to GitHub as you: open a pull request, comment on an',
  '                        issue, add a label. OFF by default, because these are public, carry your',
  '                        name, and notify people. Reads (list, view, checks) always work.',
  '                        Still refused with it: pr merge, issue close, run rerun — those end or',
  '                        change something others rely on and trying again cannot undo them.',
  '                        One run only — nothing is remembered. (Same as ACUVO_GH_WRITE=1.)',
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
  '',
  'The four questions (flag > env var > ~/.acuvo/config.json > .acuvo/config.json > default).',
  '`acuvo config` prints the answers in force and where each one came from:',
  '  --done <mode>         When is the task DONE? verified (default: a passing check ends it),',
  '                        acceptance (wait for the command you declared), never (run until the',
  '                        model has nothing left to do). Env: ACUVO_DONE.',
  '  --approve <mode>      ASK or ACT before a write? auto (default: ask only about writes that',
  '                        destroy something), always, never. Env: ACUVO_APPROVE.',
  '  --max-questions <n>   How many questions the agent may ask YOU in a run, 0-10 (default 3).',
  '                        0 means it never asks and states its assumptions instead.',
  '                        Env: ACUVO_MAX_QUESTIONS.',
  '  --on-stuck <action>   What to do when a loop survives its own hint: nudge (default),',
  '                        stop, ask. Env: ACUVO_ON_STUCK.',
  '                        (--budget is the fourth: what it may COST.)',
  '',
  '  --output-format <f>   text (default) | json (= --json) | stream-json: one JSON',
  '                        object per LINE on stdout as the run happens (init, every',
  '                        event, then the --json document as a "result" line).',
  '  --json                One JSON object on stdout, nothing else. Human output',
  '                        goes to stderr, so `acuvo --json ... | jq` just works.',
  /**
   * ── ⚠️⚠️⚠️ "run nothing" WAS FALSE, AND IT WAS THE EXPENSIVE KIND OF FALSE ─
   *
   * This line read: *"Print what WOULD be written, touch nothing, run nothing."*
   * Two of the three clauses are true. **`--dry-run` does not stop the model
   * running and does not stop the bill** — it sets `dryRun` on the EXECUTOR, so
   * the tool calls are refused after the model has already produced them. This
   * file says exactly that at `--plan`'s definition below: *"`--dry-run` prints
   * the writes it would have made — after the model has already decided what
   * they are."* The help contradicted the source comment sitting 800 lines away
   * in the same file.
   *
   * ⭐ AND "run nothing" IS THE PHRASE THAT DID THE DAMAGE, because the flag it
   * describes is the one a cautious user reaches for FIRST. `--best-of 3
   * --dry-run` was three full model runs, all discarded — the whole bill, no
   * result. `bin/acuvo.mjs` now refuses that combination outright; this line
   * stops the same expectation forming in the first place.
   *
   * ⚠️ "still billed" is stated in the flag list rather than buried in prose,
   * because a cost surprise the docs technically mention somewhere is still a
   * cost surprise.
   */
  '  --dry-run             Print what WOULD be written and touch nothing. ⚠️ The model still',
  '                        runs and you are STILL BILLED — this previews the writes, it does',
  '                        not preview the spend. Use --plan to approve before anything is spent.',
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
  '  acuvo document <page.html> <out.pdf|png|pptx>',
  '                        Render an HTML file to a real PDF, PNG or PPTX. No model',
  '                        turn and no agent session — it presses the file and exits.',
  '  acuvo leases          Who holds which file in this workspace, and since when.',
  /**
   * ⭐ REQUIREMENT 5 OF THE BRIEF, IN ONE COMMAND: *"a knob nobody can find is
   * not configurable."* It prints the four answers in force AND the layer that
   * decided each one — which is the question a person actually has when a run
   * does something they did not expect.
   */
  '  acuvo config          The four questions in force here, and where each answer came from.',
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
  /**
   * ── ⚠️⚠️ MOVED HERE, AND PREFIXED `acuvo `, BECAUSE THE OLD PLACEMENT BILLED ──
   *
   * These four rows used to sit in the middle of the OPTIONS block, spelled
   * `mcp add <server>` — bare words among flags. Rendered, the front door taught
   * "a word with no dashes is a command in this tool", which is true of nine
   * words and, for every other word, starts a paid agent run. `acuvo doctor`
   * cost $0.0066 to learn that (see `mistypedArgument` below).
   *
   * ⭐ The `acuvo ` prefix is what every other command row in this block already
   * uses. It is not decoration: it is the difference between a reader learning
   * "these are subcommands" and learning "dashes are optional here".
   *
   * ⚠️ THE HEADING SAYS "these read"; `mcp add` and `mcp remove` WRITE a config
   * file, so that is stated rather than glossed. They still spend no completion
   * and need no key, which is the property the heading is really about.
   */
  '  acuvo mcp list        Show the MCP servers this workspace declares — command line and',
  '                        env var NAMES, never values. Reads only; starts nothing, so it is',
  '                        safe to run on a repo you have just cloned.',
  '  acuvo mcp add <server>',
  '                        Add an MCP server to .acuvo/mcp.json — a nickname (playwright,',
  '                        github, filesystem, postgres, memory, thinking, figma,',
  '                        context7), any npm package, or a URL. --name to rename it,',
  '                        --replace to overwrite one that is already there. WRITES a file.',
  '  acuvo mcp remove <name>',
  '                        Delete one from whichever config file declares it. The undo for',
  '                        an approval; the rest are re-confirmed on the next run.',
  /**
   * ── ⭐⭐ THE CARRY-OVER FAMILY — AND LISTING THEM IS WHAT MAKES THEM REAL ───
   *
   * These three exist for the person arriving because a weekly limit stopped
   * them somewhere else. ⚠️ A command nobody can find is a command nobody runs,
   * which is this repo's own recurring defect wearing a different hat: the
   * capability shipped, the door was never drawn. `mcp search` was added for
   * exactly that reason ("you had to already know the package name"), and these
   * would have had the same problem within a week.
   *
   * ⚠️ ALL THREE READ ONLY. Stated in the rows themselves rather than in a
   * heading, because the reader's fair assumption on seeing "import" is that
   * something got copied.
   */
  '  acuvo mcp import      MCP servers another tool on this machine already declares —',
  '                        Cursor, VS Code, Claude Desktop, Windsurf. Shows the command each',
  '                        would run and the env var NAMES it wants. Starts nothing, writes',
  '                        nothing: copying one is your call.',
  '  acuvo import          Everything another coding tool left in this project — rules file,',
  '                        slash commands, skills, hooks, MCP. Reports only; it never copies',
  '                        or converts, because those carry the other tool\'s own semantics.',
  '  acuvo carry <file.jsonl>',
  '                        Distil an abandoned session from another tool into what is worth',
  '                        keeping: the goal, what FAILED, and where the user said no. A real',
  '                        62 MB transcript reduces to about 8 KB. Secrets are redacted.',
  /**
   * ⭐ THE ONLY VERB HERE THAT POINTS OUTWARD. Everything above makes Acuvo a
   * client of someone else's server; this one puts Acuvo INTO their editor.
   *
   * ⚠️ THE FLAGS ARE SPELLED OUT BECAUSE THE DEFAULT IS AN EMPTY SERVER.
   * Measured by running the binary: no flags serves ZERO tools, `--root` gets
   * 11, and the creative group needs all three flags at once — the middle one
   * being `--allow-write`, which nobody would guess is required to DRAW.
   */
  '  acuvo mcp install     Put Acuvo into Claude Code, Cursor, VS Code, Windsurf or Claude',
  '                        Desktop, so they can call it. Shows what it would change and',
  '                        writes nothing until you add --yes.',
  '                          --allow-write         let it edit files in the workspace',
  '                          --allow-spend <usd>   serve generate_image and speak, up to a',
  '                                                ceiling. Needs --allow-write as well:',
  '                                                the engines write into the workspace.',
  '                          --hosted              install the CLOUD server instead: every tool',
  '                                                your plan allows, over your account key.',
  '                                                Install both — the cloud one cannot see files.',
  // ⚠️ `<acuvo_sk_…>` UNTIL 2026-09-18 — a prefix that exists NOWHERE else in this
  // package. The one `--key` takes is the account key, whose shape `login.mjs`
  // enforces as `xxi_live_…`; the placeholder in the most-read text in the product
  // named a key the product would reject.
  '                          --key <xxi_live_…>    with --hosted, if you are not logged in',
  '                          --host <tool>         just one, and create its config if absent',
  '                          --yes                 actually write   --force  replace an entry',
  /**
   * ── ⭐⭐ 67 SKILLS SHIPPED AND NOTHING COULD LIST THEM ──────────────────────
   *
   * `read_skill` is offered to the MODEL and the catalogue rides in the prompt;
   * a PERSON had no way to see what was on the shelf, to confirm the skill they
   * wrote was found, or to notice that a repository they cloned had shadowed
   * one of theirs by reusing the name. This is the whole answer, and it writes
   * nothing.
   */
  '  acuvo skills          Every skill available here, and which of the three shelves it came',
  '                        from — this project, yours, ours. Most specific wins, and any',
  '                        override is named. Read-only. --json for the machine-readable list.',
  '                          .acuvo/skills/<name>.md     this repo, committed with it',
  '                          ~/.acuvo/skills/<name>.md   YOURS, in every project on this machine',
  '                        A skill is a markdown file with name/description frontmatter.',
  '                        ⚠ There is deliberately no `skills add <url>`: a skill is',
  '                        instructions that enter the model\'s context and get followed, so',
  '                        importing one from a stranger is prompt injection with a package',
  '                        manager in front of it. Copy the file in yourself — that is a review.',
  /**
   * ── ⭐⭐⭐ THE VERB THAT LIGHTS EIGHT SYMBOL TOOLS, ONCE PER MACHINE ────────
   *
   * ⚠️ IT IS DOCUMENTED HERE BECAUSE THE ALTERNATIVE WAS AN INSTRUCTION THAT NO
   * LONGER WORKS. `--doctor` printed `npm i -D typescript` under four dark rows,
   * and measured 2026-09-19 that command installs TypeScript 7 — the Go rewrite,
   * which ships no `tsserver.js` — so the user got 23MB and four still-dark
   * tools. See `lib/managed-language-server.mjs`.
   */
  '  acuvo lsp             Is semantic navigation working here? Prints where the managed',
  '                        TypeScript lives and whether this workspace carries its own.',
  '                        Writes nothing.',
  '  acuvo lsp install     Install Acuvo\'s own TypeScript 5 under ~/.acuvo, so',
  '                        find_definition, find_references, check_types, list_symbols,',
  '                        rename_symbol, insert_before_symbol, insert_after_symbol and',
  '                        replace_function_body answer in EVERY TS/JS project on this',
  '                        machine. It never touches your project — no node_modules, no',
  '                        package.json change. Shows what it will do and asks first;',
  '                        --yes skips the question. `acuvo lsp remove` undoes it.',
  '  acuvo mcp search <subject>',
  '                        Find MCP servers on the npm registry, live. `mcp search notion`,',
  '                        `mcp search stripe`, `mcp search blender`. Ones we have run',
  '                        ourselves are listed first; the rest are unvetted packages.',
  '',
  '  ⚠ These words are commands only as the FIRST thing you type. `acuvo doctor` (no dashes)',
  '  is not one — anything acuvo does not recognise as a command is the TASK, and a task',
  '  starts a paid run. Mistype one and acuvo refuses and names the flag you meant.',
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
  /**
   * ── ⚠️⚠️ THE BYOK ENTRY WAS REMOVED FROM `--help` (2026-08-25) ─────────────
   *
   * It read: "OPENROUTER_API_KEY — the BYOK FALLBACK … it bills YOUR provider
   * account, not your Acuvo credits", and the argument for keeping it was good:
   * it names the flag that gets you OFF the fallback, in the one place someone
   * about to export a provider key is actually looking.
   *
   * ⭐ IT LOSES TO A HARDER RULE. Roman, on shipped surfaces: *"we don't want to
   * sound unprofessional nor advertise our business mechanics — we might as well
   * say: don't pay for us, just pay directly to these guys!!!"* `--help` is read
   * by everyone evaluating whether to subscribe, and this line named our
   * supplier and told them a way to not pay us. An outside reader has already
   * drawn exactly that conclusion once, in writing, from the website's install
   * block.
   *
   * ⚠️ THE SUPPORT NEED IS REAL AND IS SERVED ELSEWHERE, WHICH IS WHY THIS IS A
   * MOVE AND NOT A DELETION. Someone who already has the variable exported still
   * needs to know it is in force — and `--doctor` and `--whoami` BOTH report the
   * credential actually being used, on a run they have already chosen to make.
   * The person who needs the answer gets it; the person deciding whether to buy
   * is not handed a workaround.
   *
   * ⚠️ BEHAVIOUR IS UNCHANGED — `lib/model.mjs` still reads the variable, so no
   * dev box or CI job breaks. Only the advertisement is gone.
   */
  /**
   * ⚠️⚠️ `OPENROUTER_CODEGEN_MODEL` WAS DOCUMENTED HERE AND IS NOT ANY MORE.
   * It named our supplier in a string printed on every customer's machine, for
   * a knob `--model` already exposes with OUR names (`acuvo-flash`,
   * `acuvo-pro`). The variable is still READ by `lib/model.mjs`, so nobody's
   * script breaks; it is simply no longer advertised, and `ACUVO_MODEL` is the
   * spelling to teach.
   *
   * ⚠️ THE ROW ABOVE STAYS. `test/help-names-every-flag.test.mjs` asserts the
   * BYOK fallback is documented and that its entry names `--login` — the fix for
   * the day the help text called it "the only one needed to write code". That
   * variable is a credential a user may already have exported; the model
   * override is not, so they are not the same call.
   */
  '  ACUVO_MODEL               optional — the model to use, by Acuvo name. Same as --model.',
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
  /**
   * ── ⚠️⚠️ IT SAID "ALL THREE" AND THERE ARE FOUR. MEASURED 2026-08-29 ───────
   *
   * `lib/hooks.mjs` is 700 lines, wired into `turn.mjs` (`loadHooks` +
   * `createHookRunner`), covered by two test files, and a `PreToolUse` hook that
   * exits non-zero really does BLOCK the tool call. And:
   *
   *     acuvo --help | grep -i hook   → nothing
   *     grep -i hook lib/doctor.mjs lib/slash.mjs lib/cli-args.mjs → nothing
   *     grep -i hook README.md        → two hits, both about npm install scripts
   *
   * ⭐ THIS IS ITEM 14'S DEFECT, EXACTLY, ON THE FOURTH SURFACE. That item was
   * opened because `grep -c -i skill lib/cli-args.mjs` returned 0 while skills
   * worked, and its own finding is the one that applies here: an extensibility
   * feature nobody can find is extensibility for US and nobody else. Hooks are
   * the concrete reason teams let an agent near a real repository — the agent
   * runs inside THEIR rules — and every word of that was invisible.
   */
  /**
   * ⚠️ THE COUNT IS IN THE SENTENCE AND IT WENT STALE THE MOMENT A FIFTH
   * SURFACE SHIPPED. It said "all four are real" while plugins were being added
   * three screens below it — the same defect as the header this list was written
   * to fix, one level up. Anyone adding a sixth updates this number.
   */
  '  Extending it — all five are real, and each names the file you create:',
  '  .acuvo/skills/*.md        A markdown file per skill (name + description in',
  '                            frontmatter). Discovered automatically; the model',
  '                            is shown the list and loads one on demand.',
  /**
   * ⚠️ THE DIFFERENCE FROM A SKILL IS THE WHOLE ENTRY, and it is the sentence
   * people get wrong: a skill is chosen by the MODEL mid-run, a command is
   * chosen by the PERSON at the prompt. Documenting the file shape without that
   * distinction produces two features that look like one and a user who writes
   * the wrong one.
   */
  '  .acuvo/commands/*.md      YOUR OWN /commands. A file `ship.md` becomes `/ship`',
  '                            at the interactive prompt, and its text is sent as',
  '                            your message. $ARGUMENTS is whatever you typed after',
  '                            it; $1-$9 take a word each. Unlike a skill — which the',
  '                            MODEL picks — a command is one YOU choose, deliberately.',
  '                            The six built-ins cannot be overridden; /help says so.',
  '  .acuvo/mcp.json           MCP servers to connect. `acuvo --doctor` says which',
  '                            are reachable on this machine. Ships knowing about',
  '                            playwright, browser, docs, filesystem and firecrawl.',
  /**
   * ⚠️ THE BLOCKING SENTENCE IS THE ENTRY, not a detail of it. A hook that can
   * watch but not refuse is a logger, and a logger is not a policy — somebody
   * evaluating whether to let this near their repository is asking exactly that
   * question, and the answer is the first thing they must read.
   */
  '  .acuvo/hooks.json         YOUR OWN RULES, ENFORCED — shell commands around the',
  '                            tool loop. Events: PreToolUse, PostToolUse,',
  '                            PostToolUseFailure, Stop, StopFailure, SessionStart,',
  '                            UserPromptSubmit, PreCompact, PostCompact.',
  '                            ⭐ A PreToolUse hook that exits NON-ZERO BLOCKS the',
  '                            tool call, and the model is handed the refusal;',
  '                            a UserPromptSubmit one refuses the prompt before any',
  '                            spend. SessionStart/UserPromptSubmit STDOUT is handed',
  '                            to the model as context ($ACUVO_PROMPT has the text). So',
  '                            "never touch infra/", "format everything it writes",',
  '                            "lint after each edit" are rules, not requests.',
  '                            Match on tool name; 30s each, 120s ceiling, max 32.',
  /**
   * ── ⭐⭐ THE FIFTH SURFACE, AND IT IS DOCUMENTED IN THE SAME COMMIT ────────
   *
   * `extensibility-surfaces-are-documented.test.mjs` exists because hooks
   * shipped working, wired and invisible: *"an extensibility feature nobody can
   * find is extensibility for us and nobody else."* Plugins are the surface
   * most likely to repeat that, because unlike the other four a plugin does
   * NOTHING until a second file grants it — so a user who drops one in and sees
   * no effect concludes the feature is broken rather than that they have not
   * answered yet.
   *
   * ⚠️ SO THE GRANT FILE IS THE ENTRY, not a footnote to it. The first two
   * lines have to say that installing is two steps, or the entry documents a
   * feature that appears not to work.
   */
  '  .acuvo/plugins/<name>/    A PLUGIN: one folder, one acuvo-plugin.json, shipping',
  '  acuvo-plugin.json         hooks as a named, versioned unit you can remove.',
  '                            ⭐ IT DOES NOTHING UNTIL YOU GRANT IT. The manifest',
  '                            DECLARES what it wants ("capabilities": ["hooks"]);',
  '                            .acuvo/plugins.json is where YOU answer:',
  '                            {"plugins":{"my-plugin":{"grant":["hooks"]}}}',
  '                            Declared-but-not-granted is REFUSED and listed, so a',
  '                            clone cannot arm one and nothing runs silently. A',
  '                            manifest carrying hooks it did not declare is refused',
  '                            whole. `acuvo --doctor` lists every plugin and why any',
  '                            of them is doing nothing. ACUVO_PLUGINS=off kills all.',
  '',
  /**
   * ⭐ And the thing a user does before they read any of this: they drag a file
   * onto the window. Documented beside the features rather than in a changelog,
   * for the same reason as above.
   */
  '  Drop a file on the terminal and it is read: images, PDFs, Word, Excel, CSV.',
  '  Your terminal pastes the path; acuvo notices it is a real file and looks at it.',
  '',
  /**
   * ⚠️ NO LINE HERE MAY BEGIN WITH TWO SPACES AND A `--`, AND MY FIRST DRAFT
   * DID. `cli-flags-parse.test.mjs` reads the flag list straight out of this
   * text (`/^\s{2}(--[a-z][a-z-]*)/gm`) and drives every match through the real
   * parser — which is the guard that caught `--no-auto-lease` shipping
   * documented and unreachable. A prose line wrapping onto `--task-audio`
   * therefore claimed a flag row for something `extractVoiceFlags` removes from
   * argv before `parseArgv` ever sees it, and the guard correctly failed.
   */
  '  The media half. Point these at your OWN workers; otherwise --design, --say',
  '  and --task-audio run on your Acuvo plan once you `acuvo --login`:',
  '  RENDER_AUDIT_URL          see_page / --design — render an HTML file and look at it.',
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
  /**
   * ⭐ THE FOUR QUESTIONS. Roman, standing: *"those 4 questions should be
   * determined by the user, our CLI should be super customisable."* Each of
   * these was a constant in a module until now; the flag is the top of the
   * precedence chain `rcfile.mjs` documents, and without it there IS no chain.
   */
  '--done', '--approve', '--on-stuck', '--max-questions',
  '--output-format',
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
const COMMANDS = new Set(['leases', 'spend', 'engines', 'config']);

/* ══════════════════════════════════════════════════════════════════════════
 * ── ⚠️⚠️⭐ THE TYPO THAT BILLS: `acuvo doctor` (MEASURED 2026-08-25) ────────
 *
 * `acuvo doctor` — no dashes, the natural thing to type — was not refused. It
 * fell through every clause above as a POSITIONAL, became `out.task = 'doctor'`,
 * and started a real agentic run at roughly $0.0045 a round. It cost **$0.0066**
 * before it was killed by hand. There was no "unknown command" path at all: the
 * only refusal in this parser is `arg.startsWith('--')`, so anything without two
 * leading dashes was, by construction, an instruction.
 *
 * ⚠️ AND THE HELP TEXT TAUGHT THE SHAPE. `--help` listed `mcp add`, `mcp list`
 * and `completion <shell>` as bare words in the middle of the OPTIONS block —
 * i.e. the front door demonstrated "a word with no dashes is a command here",
 * which is true for exactly five words and bills for every other one.
 *
 * ── ⭐⭐ THE RULE, AND WHY IT IS THIS NARROW ────────────────────────────────
 *
 * A false refusal is worse than this bug. Somebody whose real instruction is
 * rejected has to fight the tool; somebody who typoed loses half a cent. So the
 * refusal is the smallest thing that catches the measured failure:
 *
 *   RULE 1 — the first positional begins with a dash. `--doctro` was already
 *     refused ("Unknown option"); `-doctor` was NOT, because the existing test
 *     is `startsWith('--')`, and a single-dash typo silently became prose. No
 *     English instruction begins with a hyphen, so this one is unambiguous.
 *
 *   RULE 2 — there is EXACTLY ONE positional, it contains NO WHITESPACE, and
 *     the word (lowercased, dashes stripped) is the name of a flag or a
 *     top-level subcommand. `acuvo doctor` → refused. `acuvo "fix the login
 *     bug"` → four words, a task. `acuvo "doctor the config file"` → contains
 *     spaces, a task. `acuvo refactor` → not a name we know, so it is a task
 *     and stays one; we have nothing to suggest and guessing would be the
 *     false refusal this rule exists to avoid.
 *
 * ⚠️ DELIBERATELY NOT COVERED: a multi-word prompt whose first word is a
 * command name (`acuvo doctor now`). Two tokens is where "typo" and
 * "instruction" stop being distinguishable, and the brief for this rule is that
 * the boundary must be encoded rather than felt. Widening it later needs a
 * measurement, not an opinion.
 *
 * ── ⭐ IT ALSO CLOSES A MONEY BUG THIS FILE ALREADY KNEW ABOUT ──────────────
 *
 * The `rewind` comment above records: *"`board`, `verify`, `leases` and `spend`
 * STILL USE THE `argv[0]` ANCHOR and so `acuvo --dir <path> board` is still a
 * paid task run. That is a real defect … it is reported rather than fixed
 * here."* Rule 2 catches every one of them: with a flag in front, the command
 * word arrives as a lone positional, and a lone positional that names a command
 * is now a refusal instead of a completion.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ WRITTEN OUT, NOT SCRAPED — the same argument `lib/completion.mjs` makes
 * about its own flag table: *"A list derived from help-text formatting fails
 * SILENTLY and completely: one changed indent and the regex matches nothing …
 * An explicit table fails LOUDLY instead."* Here the silent-failure direction is
 * worse than cosmetic — a name missing from this list is a word that goes back
 * to costing money.
 *
 * ⚠️ AND IT SPANS BOTH PARSERS ON PURPOSE. `bin/acuvo.mjs` lifts seventeen of
 * its own flags out of argv before this file ever sees them (`--doctor`,
 * `--login`, `--replay`, …) and `lib/voice-task.mjs` lifts four more. This
 * module cannot import either one — `completion.mjs` already documents the ESM
 * cycle that creates — so the names are listed here and
 * `test/mistyped-command-refuses.test.mjs` drives the REAL `--help` output back
 * through this table. Add a flag anywhere and forget this list, and that test
 * names it.
 *
 * ⚠️ ALIASES INCLUDED (`-h`, `-v`, `-y`, `--render`). A suggestion engine that
 * does not know `-h` cannot tell somebody who typed `-hlep` what they meant.
 */
/**
 * ── ⚠️⚠️ THE FLAGS THIS FILE DOES *NOT* PARSE LIVE IN A TEMPLATE LITERAL ─────
 *
 * They are written in a backtick string and split, not as an array of
 * single-quoted names, and that is not a style choice — it is what keeps a
 * DOCUMENTATION table from being mistaken for a second PARSER.
 *
 * `test/integration-run-program-and-collisions.test.mjs` guards a real hazard:
 * two files now parse flags (`extractLifecycleFlags` in `bin/`, `parseArgv`
 * here), and a lane adding the same flag to both produces one parser silently
 * eating an argument before the other is asked. It detects that by grepping
 * `lib/cli-args.mjs` for `'--x'` — a single-quoted literal — and intersecting
 * with what `bin/` claims.
 *
 * ⚠️ MEASURED: writing these names as a plain array of single-quoted strings
 * turned that guard red on all twelve, accusing this file of claiming flags it
 * does not touch — and then red again on two more, because this very comment
 * had quoted a couple of them in the offending shape to explain the problem.
 * The guard is a source grep and cannot tell prose from code; the
 * names here are for SUGGESTING, and nothing in this module ever parses one. A
 * backtick literal says exactly that, to the guard and to the next reader.
 */
const LIFTED_ELSEWHERE = `
  --login --logout --whoami
  --sessions --resume --continue --no-session --no-audit
  --doctor --render-report --render
  --replay --diff --only --design
  --harness
  --name --replace
  --say --task-audio --yes -y
  --host --allow-write --allow-spend --hosted --key
`.trim().split(/\s+/);

export const KNOWN_FLAG_SPELLINGS = Object.freeze([
  // ── parsed here, in parseArgv ──
  '-h', '--help', '-v', '--version',
  '--dir', '--model', '--engine',
  '--max-rounds', '--max-tokens', '--timeout', '--command-timeout',
  '--budget', '--fleet-budget', '--budget-window', '--since',
  '--lease', '--holder', '--issue', '--concurrency', '--best-of', '--max-tier',
  '--done', '--approve', '--on-stuck', '--max-questions',
  '--parallel', '--until-done', '--json', '--output-format', '--dry-run', '--strict', '--offline',
  '--no-run', '--no-auto-lease', '--no-checkpoint', '--force', '--claim',
  '--no-parallel-tools',
  '--unattended', '--refute', '--all', '--shell', '--plan',
  '--allow-push', '--allow-deploy', '--allow-install', '--allow-gh-write',
  // ── lifted by bin/acuvo.mjs and lib/voice-task.mjs BEFORE this parser runs ──
  ...LIFTED_ELSEWHERE,
]);

/**
 * The words that are commands rather than tasks. Five of them dispatch inside
 * this file, `mcp` and `completion` are claimed by `bin/acuvo.mjs` before this
 * parser runs — and `mcp` is the one that most needed listing, because
 * `acuvo mcp` with no verb is the shape `--help` was teaching.
 *
 * ⚠️ SUB-VERBS (`add`, `list`, `remove`, `search`, `done`) ARE DELIBERATELY
 * ABSENT. They are ordinary English and they are never the first word of a
 * correct invocation, so listing them would only widen the false-refusal
 * surface for no measured gain.
 */
export const KNOWN_COMMAND_WORDS = Object.freeze([
  'leases', 'spend', 'engines', 'config', 'verify', 'board', 'rewind',
  'mcp', 'completion', 'document',
  // ⚠️ `lsp` is claimed by bin/acuvo.mjs (install · status · remove, 2026-09-19) and the
  // doctor tells people to type `acuvo lsp install` — it was the one bin word missing here.
  'lsp',
]);

/**
 * How a command word is actually spelled on the command line, for the one case
 * that matters: the user put a flag in FRONT of it, so it never dispatched.
 * A refusal that does not show the working invocation is just an obstacle.
 */
const COMMAND_SHAPES = Object.freeze({
  mcp: 'acuvo mcp list   (also: mcp add <server> · mcp remove <name> · mcp search <subject>)',
  completion: 'acuvo completion <bash|zsh|fish>',
  verify: 'acuvo verify [id]',
  board: 'acuvo board [add "<task>"]',
  document: 'acuvo document <page.html> <out.pdf|png|pptx>',
  rewind: 'acuvo rewind [checkpoint]',
});

/** Levenshtein, iterative, two rows. Small by design — the inputs are flag names. */
function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The closest flag spelling to what was typed, or null when nothing is close
 * enough to be worth naming.
 *
 * ⚠️ THE THRESHOLD SCALES WITH LENGTH, and 2 is the floor. A fixed distance of
 * 2 makes `-xy` "mean" `-y`, which is a confident wrong answer — the one thing a
 * suggestion must never be.
 *
 * ⚠️⚠️ `minLength` IS NOT TUNING, IT IS WHO PAYS FOR A WRONG GUESS, and the two
 * callers are not symmetrical:
 *   · a token that starts with a dash is REFUSED either way (rule 1), so a
 *     fuzzy match can only improve the message. `minLength: 3` there, so
 *     `-hlep` can be told about `--help`.
 *   · a BARE word is refused ONLY IF this function answers, so a loose match
 *     here creates a false refusal that blocks real work — the failure the
 *     whole rule is written to avoid. `minLength: 5` there, deliberately
 *     stricter, so `acuvo lint` and `acuvo docs` stay tasks.
 *
 * @param {string} token whatever the user typed, dashes and all
 * @param {number} [minLength] shortest word this will fuzzy-match at all
 * @returns {string | null}
 */
export function nearestKnownFlag(token, minLength = 5) {
  const typed = String(token ?? '').trim().toLowerCase();
  if (!typed) return null;
  const bare = typed.replace(/^-+/, '');
  if (!bare) return null;

  // An exact match once the dashes are normalised — `-doctor`, `doctor`, `DOCTOR`.
  const exact = KNOWN_FLAG_SPELLINGS.find((f) => f.replace(/^-+/, '') === bare);
  if (exact) return exact;

  if (bare.length < minLength) return null;
  const budget = bare.length >= 9 ? 3 : 2;

  let best = null;
  let bestDistance = Infinity;
  for (const flag of KNOWN_FLAG_SPELLINGS) {
    const candidate = flag.replace(/^-+/, '');
    // ⚠️ Never suggest a one- or two-letter alias for a long typo: every short
    // name is within the budget of everything, so `-h` would win by accident.
    if (candidate.length < 3) continue;
    const d = editDistance(bare, candidate);
    if (d < bestDistance) { bestDistance = d; best = flag; }
  }
  return bestDistance <= budget ? best : null;
}

/** The sentence every refusal in this block ends with. */
const HELP_POINTER = 'Run `acuvo --help` for every flag and command.';

/**
 * The message for a `--flag` this parser does not know. Kept as a function
 * because the suggestion is the whole point: "Unknown option --doctro" makes
 * the user re-read the help text; "did you mean --doctor?" ends it.
 *
 * ⚠️ THE WORDING "Unknown option" IS LOAD-BEARING. `test/cli-flags-parse.test.mjs`
 * and `test/terminal-ergonomics.test.mjs` both detect an unreachable flag by
 * matching `/Unknown option/` on this parser's error — a documented flag that
 * does not parse is found by that string. Rewording it silently disarms two
 * guards, so the suggestion is APPENDED rather than substituted.
 *
 * @param {string} arg
 * @returns {string}
 */
export function unknownOptionMessage(arg) {
  // ⚠️ `3`, not the default 5 — this path refuses whatever happens, so a loose
  // guess costs nothing and a short typo (`-hlep`) is the commonest one there is.
  const near = nearestKnownFlag(arg, 3);
  return near && near !== arg
    ? `Unknown option ${arg}. Did you mean \`${near}\`?\n${HELP_POINTER}`
    : `Unknown option ${arg}. ${HELP_POINTER}`;
}

/**
 * Rules 1 and 2 above, as a pure function so the boundary can be tested without
 * spawning a process or buying a completion — which is the whole reason this
 * module's header says it is pure.
 *
 * @param {readonly string[]} prompts the positionals left after flag parsing
 * @returns {string | null} the refusal, or null when this is a genuine task
 */
export function mistypedArgument(prompts) {
  const first = prompts[0];
  if (typeof first !== 'string' || first === '') return null;

  /* ── RULE 1 — it begins with a dash, so it was meant to be a flag ────────── */
  // `-` alone is the conventional stdin placeholder and is left to the caller.
  if (first.startsWith('-') && first !== '-') {
    return unknownOptionMessage(first);
  }

  /* ── RULE 2 — one bare word, no spaces, and it names something we have ───── */
  if (prompts.length !== 1 || /\s/.test(first)) return null;
  const word = first.toLowerCase();

  if (KNOWN_COMMAND_WORDS.includes(word)) {
    const shape = COMMAND_SHAPES[word] ?? `acuvo ${word}`;
    return `\`${word}\` is a command, but not on its own — and it has to be the FIRST word you type. `
      + `With a flag in front of it, or a verb missing after it, acuvo reads it as the TASK to work on `
      + `and starts a paid run.\n`
      + `Type:  ${shape}\n`
      + `${HELP_POINTER}`;
  }

  /**
   * ⚠️⚠️ EXACT, NOT FUZZY, AND THE FIRST VERSION OF THIS WAS FUZZY — MEASURED,
   * NOT ARGUED. Driven through this parser on 2026-08-25 with a length-scaled
   * edit-distance match (floor 5, budget 2), three ordinary one-word tasks were
   * refused:
   *
   *     acuvo clean   → "did you mean `acuvo --plan`?"      (distance 2)
   *     acuvo deploy  → "did you mean `acuvo --replay`?"    (distance 2)
   *     acuvo modal   → "did you mean `acuvo --model`?"     (distance 1)
   *
   * Every one of those is a plausible instruction, and a refusal is the ONE
   * failure worse than the bug this rule fixes: a typo costs half a cent, a
   * false refusal costs the user their afternoon arguing with the tool.
   *
   * ⭐ SO THE BARE-WORD RULE MATCHES BY NAME OR NOT AT ALL. `nearestKnownFlag`
   * is still fuzzy for the DASHED path above, where the argument is refused
   * whatever this returns — there, a guess can only improve the message. Here it
   * decides whether to refuse, so it may not guess.
   */
  const near = KNOWN_FLAG_SPELLINGS.find((f) => f.replace(/^-+/, '') === word && f.startsWith('--'));
  if (near) {
    return `\`${word}\` is not a command — did you mean \`acuvo ${near}\`?\n`
      + `Without the dashes, acuvo would take \`${word}\` as the TASK to work on and start a paid run, `
      + `so it is refused here instead.\n`
      + `If you did mean it as an instruction, write it as a sentence: acuvo "${word} …".\n`
      + `${HELP_POINTER}`;
  }

  return null;
}

/**
 * ⚠️ The union is DECLARED so the discriminant survives into TypeScript — see
 * the contracts note in `workspace.mjs` for why inference is not enough.
 *
 * @typedef {{ task: string, tasks: string[], parallel: boolean, issue: number | null, json: boolean, streamJson: boolean, concurrency: number, dir: string | null, model: string | null, maxTokens: number, timeoutMs: number, maxRounds: number, allowRun: boolean, shell: boolean, allowPush: boolean, allowDeploy: boolean, allowInstall: boolean, allowGhWrite: boolean, commandTimeoutMs: number, dryRun: boolean, strict: boolean, offline: boolean, since: string | null, help: boolean, version: boolean, budgetUsd: number | null, budgetExplicit: boolean, untilDone: boolean, maxTier: string, lease: string[], holder: string | null, command: string | null }} CliOptions
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
    streamJson: false,
    concurrency: 2,
    dir: null,
    model: null,
    maxTokens: DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRounds: DEFAULT_MAX_ROUNDS,
    allowRun: true,
    /**
     * ── ⭐ HOW MANY SLOW TOOL CALLS MAY OVERLAP IN ONE ROUND ─────────────────
     *
     * `round-schedule.mjs` decides WHICH calls may overlap; this is the ceiling
     * on how many. `--no-parallel-tools` sets it to 1, which restores the strict
     * one-at-a-time loop.
     *
     * ⚠️ NOT `--parallel`. That flag is already taken and means something else
     * entirely — several TASKS, each with its own agent session, through
     * `lib/parallel.mjs`. This is several TOOL CALLS inside one round of one
     * session. Two names for two things, because a reader who conflates them
     * would expect `--parallel 4` to speed up a single run and it does not.
     */
    parallelTools: DEFAULT_MAX_PARALLEL,
    shell: false,
    /**
     * ── ⭐⭐ THE TWO IRREVERSIBLE VERBS, AND WHY THEY GET A FLAG BUT NOT A
     *        DEFAULT ────────────────────────────────────────────────────────
     *
     * `git_push` and `vercel_preview` are built, tested and correct, and both
     * are withheld unless an operator names them (`ACUVO_ALLOW_PUSH=1`,
     * `ACUVO_ALLOW_DEPLOY=1`, each checked at the OFFER and again at the
     * DISPATCHER). Until now the only way to name them was an environment
     * variable that appears in no `--help`, so a capability we ship was
     * reachable only by someone who had read the source.
     *
     * ⚠️ ON BY DEFAULT WAS MEASURED AND REJECTED. Offering them to everyone
     * costs, on this machine, **+1,155 B for `git_push` and +1,629 B for
     * `vercel_preview` — 2,784 B, 4.3% of the 64,990-byte tool offer** — and
     * that block is re-sent on EVERY round of EVERY run. Against that: a push
     * is visible to people who are not at this keyboard and cannot be recalled,
     * and a deploy spends a paid build on the user's account the instant the
     * request lands. Across the 139-run bench corpus neither verb was called
     * once. Paying 4.3% of the prompt forever, on every run, to make two
     * irreversible verbs available by default is the wrong trade in both
     * directions.
     *
     * ⭐ SO THE GATE SHAPE IS PER-RUN AND TYPED BY A HUMAN. That is the
     * narrowest gate that still makes the capability discoverable: it lives in
     * `--help`, it costs nothing on the runs that do not pass it, and it cannot
     * be set by a repository — which is the whole point of
     * `workspace-env-cannot-widen.test.mjs`. A `.env.local` in a cloned repo is
     * refused; a person typing the flag is the operator saying it out loud.
     */
    allowPush: false,
    allowDeploy: false,
    /**
     * ── ⭐⭐ THE THIRD SWITCH, AND IT FOLLOWS THE TWO ABOVE EXACTLY ───────────
     *
     * ⚠️ `ACUVO_ALLOW_INSTALL` HAD NO FLAG, AND THAT IS THE SAME DEFECT THE
     * NOTE ABOVE RECORDS ABOUT PUSH AND DEPLOY. It IS documented — `README.md`
     * has a section on it and `validateNpm`'s refusal names it — so the honest
     * statement is "documented in the README, absent from `--help`", not
     * "undocumented". But `--help` is the surface a person reads before they
     * read a README, and the variable appeared in neither `--help` nor the
     * options table, so the fix for `npm install` was reachable only by someone
     * who had already been refused AND read the whole refusal.
     *
     * ⭐ AND IT IS A LAUNCHER FLAG, NOT A CONFIG KEY, DELIBERATELY. The whole
     * argument in `command.mjs` for why install is gated on an environment
     * variable rather than a `COMMAND_PRESETS` entry is that
     * `.acuvo/commands.json` is a file THIS AGENT CAN WRITE — a preset named
     * `npm-install` would be the agent granting itself a downloader in one
     * `write_file`. A flag typed at the keyboard has exactly the property the
     * variable has and the config file does not: the agent has no verb that
     * reaches it, and `env-file.mjs` strips the name out of a workspace
     * `.env.local` so a cloned repository still cannot set it
     * (`workspace-env-cannot-widen.test.mjs`).
     *
     * ⚠️ THE BOUNDARY DOES NOT MOVE. `--allow-install` buys exactly what
     * `ACUVO_ALLOW_INSTALL=1` already bought and not one byte more:
     * `--ignore-scripts` is still forced, registry names only, four packages
     * max, `npm exec` and `npm publish` still have no switch at all, and
     * `--shell` remains the only thing that removes the allowlist. This widens
     * the MENU of ways to say yes; it does not move the wall.
     */
    allowInstall: false,
    allowGhWrite: false,
    /**
     * ── ⭐⭐⭐ THE FOUR QUESTIONS, AND EVERY DEFAULT IS AN IMPORT ─────────────
     *
     * These four fields answer "when is it DONE", "what may it COST" (that one
     * is `budgetUsd`, below, and already existed), "ASK or ACT", and "what to do
     * when STUCK". All four were constants in modules, unreachable from a flag,
     * a variable or a file.
     *
     * ⚠️ NOT ONE OF THESE DEFAULTS IS TYPED OUT HERE. `DEFAULT_DONE_MODE`,
     * `DEFAULT_APPROVE_MODE`, `MAX_QUESTIONS` and `DEFAULT_STUCK_ACTION` are the
     * constants the runtime actually reads, so a user who passes nothing gets
     * byte-for-byte the run they got yesterday — and it stays true when one of
     * those modules changes its mind. A retyped default is the drift this
     * package has paid for repeatedly.
     */
    doneWhen: DEFAULT_DONE_MODE,
    approveMode: DEFAULT_APPROVE_MODE,
    maxQuestions: MAX_QUESTIONS,
    onStuck: DEFAULT_STUCK_ACTION,
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
    /**
     * `[htmlPath, outPath]` for `acuvo document` — the press, without a model
     * turn. Empty for every other invocation.
     */
    documentArgs: [],
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
    /**
     * ⭐ PARITY WITH `claude -p --output-format` AND `codex exec --json`
     * (both read 2026-09-27). `json` is exactly `--json`; `stream-json` is
     * the same stdout contract made LIVE: one JSON object per line as the run
     * happens, ending in the `--json` document as a `result` line — what an IDE,
     * a CI job or an SDK wrapper needs to show progress. Human lines still go
     * to stderr in both modes.
     */
    if (arg === '--output-format') {
      const raw = argv[++i];
      if (!OUTPUT_FORMATS.includes(raw)) {
        return { ok: false, error: `--output-format takes one of ${OUTPUT_FORMATS.join(', ')} (got ${JSON.stringify(raw ?? null)})` };
      }
      out.json = raw !== 'text';
      out.streamJson = raw === 'stream-json';
      continue;
    }
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
     * ⚠️ A BOOLEAN, SO IT BELONGS IN THIS BLOCK — see the warning below about
     * the two flags that shipped documented and unparseable because they were
     * written into the takes-a-value branch instead.
     */
    if (arg === '--no-parallel-tools') { out.parallelTools = 1; continue; }
    /**
     * ⚠️ BOOLEANS, SO THEY BELONG IN THIS BLOCK — see the warning directly
     * below about the two flags that shipped documented and unparseable
     * because they were written into the takes-a-value branch.
     */
    if (arg === '--allow-push') { out.allowPush = true; continue; }
    if (arg === '--allow-deploy') { out.allowDeploy = true; continue; }
    if (arg === '--allow-install') { out.allowInstall = true; continue; }
    if (arg === '--allow-gh-write') { out.allowGhWrite = true; continue; }
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
    /**
     * ── ⭐⭐⭐ THE FOUR QUESTIONS, ON THE COMMAND LINE ────────────────────────
     *
     * ⚠️ EACH VALIDATES AGAINST THE MODULE'S OWN LIST, never a copy. `--max-tier`
     * directly above records why: *"a completion offering a fourth tier would be
     * offering a value the parser refuses by name."* The same holds here in the
     * other direction — a parser accepting a mode `doneDecision` does not know
     * would silently fall back to the default halfway through a paid run.
     */
    if (arg === '--done') {
      const raw = argv[++i];
      if (!DONE_MODES.includes(raw)) {
        return {
          ok: false,
          error: `--done takes one of ${DONE_MODES.join(', ')} (got ${JSON.stringify(raw ?? null)}). `
            + 'It decides when a task counts as finished: "verified" stops when a check passes, '
            + '"acceptance" waits for the command you declared, "never" runs until the model has nothing left to do.',
        };
      }
      out.doneWhen = raw;
      continue;
    }
    if (arg === '--approve') {
      const raw = argv[++i];
      if (!APPROVE_MODES.includes(raw)) {
        return {
          ok: false,
          error: `--approve takes one of ${APPROVE_MODES.join(', ')} (got ${JSON.stringify(raw ?? null)}). `
            + '"auto" asks only about writes that destroy something, "always" asks about every write, "never" asks about none.',
        };
      }
      out.approveMode = raw;
      continue;
    }
    if (arg === '--on-stuck') {
      const raw = argv[++i];
      if (!STUCK_ACTIONS.includes(raw)) {
        return {
          ok: false,
          error: `--on-stuck takes one of ${STUCK_ACTIONS.join(', ')} (got ${JSON.stringify(raw ?? null)}). `
            + 'It decides what happens when a loop survives its own hint: "nudge" keeps going, "stop" ends the run, "ask" asks you.',
        };
      }
      out.onStuck = raw;
      continue;
    }
    if (arg === '--max-questions') {
      const raw = argv[++i];
      const n = Number(raw);
      /**
       * ⚠️ ZERO IS LEGAL AND MEANS "NEVER ASK ME", which is a real answer to
       * "ask or act" and not the same as absent. `ask-user.mjs` already tells a
       * model with no allowance left to state its assumption and act, so 0 is a
       * mode the runtime supports rather than a degenerate case.
       */
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        return { ok: false, error: `--max-questions takes a whole number from 0 to 10 (got ${JSON.stringify(raw ?? null)}). 0 means the agent never asks and states its assumptions instead; above 10 it is interviewing you.` };
      }
      out.maxQuestions = n;
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
        /**
         * ⚠️ CHECKED AGAINST THE HIGHER CEILING HERE, AND THE REAL ONE AFTER
         * PARSING. `--max-rounds 500 --budget none` and
         * `--budget none --max-rounds 500` must be refused identically, and at
         * this point we do not yet know whether `--budget none` appears later on
         * the line. Flag ORDER deciding whether a run is allowed is the kind of
         * bug nobody reproduces.
         */
        if (!Number.isInteger(n) || n < 1 || n > MAX_ROUNDS_LIMIT_BUDGETED) {
          return { ok: false, error: `--max-rounds must be a whole number between 1 and ${MAX_ROUNDS_LIMIT_BUDGETED} (got ${JSON.stringify(value)}). Each round is a paid completion.` };
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
    /**
     * ⚠️ NOW CARRIES A SUGGESTION, AND `terse` SUPPRESSES THE HELP DUMP.
     * `bin/acuvo.mjs` prints the whole of USAGE after a parse error, which is
     * right for "you combined two flags that cannot go together" and wrong for
     * "you typed --doctro": a hundred and fifty lines below the one sentence
     * that answers the question is the same as not answering it.
     */
    if (arg.startsWith('--')) return { ok: false, error: unknownOptionMessage(arg), terse: true };
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
   * ── ⭐⭐⭐ `acuvo document <page.html> <out.pdf>` — THE PRESS, FROM A SHELL ──
   *
   * ⚠️⚠️ WHY A COMMAND AND NOT A BUILDER TOOL. `make_document` as a tool in the
   * console builder costs 527 bytes of schema and a prompt line, against
   * sixteen characters of headroom in a ceiling that is DERIVED and cannot be
   * ratcheted. The build VM already has this binary on its PATH and a 45-minute
   * `cli.run` key in `ACUVO_TOKEN` (which `account.mjs` reads), so the model
   * reaches the press through `run_command` for **zero schema bytes**.
   *
   * ⚠️ ANCHORED ON `prompts[0]`, NEVER `argv[0]` — the defect this file already
   * records in the `rewind` block: `acuvo --dir <ws> board` does not dispatch,
   * falls through as a TASK, and spends a paid agent session doing nothing.
   * Twice, measured. A new command must not be born with that bug.
   *
   * ⚠️⚠️ AND THE SHAPE IS THE GUARD, because "document" is ordinary English.
   * `acuvo document the API` is an instruction and must stay one. So this
   * claims the word ONLY when it is followed by exactly two paths whose
   * extensions say what they are — the same move `verify` makes with
   * `looksLikeRunId` rather than a list of English words to maintain.
   */
  const isHtmlPath = (w) => typeof w === 'string' && /\.html?$/i.test(w);
  const isPressOut = (w) => typeof w === 'string' && /\.(pdf|png|pptx)$/i.test(w);
  if (prompts[0] === 'document' && isHtmlPath(prompts[1])) {
    /**
     * ⚠️⚠️ A NEAR MISS IS REFUSED, NOT RUN. `acuvo document page.html page.docx`
     * is unmistakably this command typed slightly wrong; letting it fall through
     * as a task starts a PAID agent session that renders nothing — the identical
     * failure the `rewind` block above records costing real money twice. The
     * refusal is free and shows the working invocation.
     *
     * ⭐ The `isHtmlPath` test is what makes this safe to refuse on: an HTML
     * path as the second word is not something an English instruction contains,
     * so `acuvo document the API` never reaches here and stays a task.
     */
    if (prompts.length !== 3 || !isPressOut(prompts[2])) {
      return {
        ok: false,
        error: `${COMMAND_SHAPES.document} — the output must end in .pdf, .png or .pptx`
          + `${prompts.length === 2 ? ' (you gave no output file)' : ''}.`,
      };
    }
    out.command = 'document';
    out.documentArgs = [prompts[1], prompts[2]];
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

  /**
   * ── ⚠️⚠️⭐ THE LAST GATE BEFORE A WORD BECOMES A PAID RUN ─────────────────
   *
   * See the block above `KNOWN_FLAG_SPELLINGS` for the incident (`acuvo doctor`
   * cost $0.0066 as a task prompt) and for why the rule is exactly two clauses
   * wide. This is the only place in the file where every command clause has
   * already had its chance to claim the positionals, so it is the only place
   * that can honestly say "nothing here is a command, and it is about to be
   * sent to a model".
   *
   * ⚠️ SKIPPED FOR `--help` AND `--version`. Both are answered before anything
   * is spent, and `acuvo --help doctor` refusing to print the help text would
   * be this guard breaking the one command that explains it.
   *
   * ⚠️ SKIPPED FOR `--parallel`, where each positional is its own task and a
   * lone word cannot occur (two are required, checked above).
   */
  if (!out.help && !out.version && !out.parallel && !out.command) {
    const refusal = mistypedArgument(prompts);
    if (refusal) return { ok: false, error: refusal, terse: true };
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
  /**
   * ⚠️ THE ONLY PLACE BOTH ANSWERS ARE KNOWN. The round ceiling depends on
   * whether money is bounding, and the flags can arrive in either order, so the
   * real check happens once the whole line has been read.
   */
  const roundLimit = maxRoundsLimitFor(out.budgetUsd);
  if (Number.isInteger(out.maxRounds) && out.maxRounds > roundLimit) {
    return {
      ok: false,
      error: `--max-rounds ${out.maxRounds} needs a budget to bound it. With --budget none the `
        + `ceiling is ${MAX_ROUNDS_LIMIT}, because rounds are then the only thing stopping a `
        + `runaway. Drop --budget none, or lower --max-rounds.`,
    };
  }

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
