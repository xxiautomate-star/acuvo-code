/**
 * ARGUMENT PARSING — pure, so the CLI's contract is testable without spawning a
 * process or spending a completion.
 *
 * Deliberately hand-rolled rather than `node:util.parseArgs`: the flag surface
 * is five entries and the errors need to be sentences, not `Unknown option`.
 */

import { DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, DEFAULT_MODEL } from './model.mjs';
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, ALLOWED_BINARIES } from './command.mjs';

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
 * ⚠️ 16, NOT 64, AND NOT UNBOUNDED. A ceiling is a blast radius, not a target:
 * it is the most an agent nobody is watching can spend before it must be asked
 * again. 16 rounds of a $0.0003 round is under a cent — a number a person can
 * lose to a typo without caring. The policy layer's MAX_ROUNDS_CEILING = 64
 * remains the separate, opt-in bound for a config file that states a number on
 * purpose, and it is deliberately still higher than this one.
 *
 * ⚠️ THE DEFAULT DOES NOT MOVE. A user who asks for nothing must not suddenly
 * spend more; raising the ceiling costs exactly zero until someone types a
 * bigger number.
 */
export const MAX_ROUNDS_LIMIT = 16;

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
export const DEFAULT_MAX_ROUNDS = 5;

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
  '',
  '  (from a clone, without installing:  node bin/acuvo.mjs "<task>")',
  '',
  'Options:',
  `  --dir <path>          Workspace root (default: the current directory).`,
  `  --model <id>          OpenRouter model id (default: $OPENROUTER_CODEGEN_MODEL, else ${DEFAULT_MODEL}).`,
  `  --max-rounds <n>      Write→run→fix rounds, 1-${MAX_ROUNDS_LIMIT} (default: ${DEFAULT_MAX_ROUNDS}). 1 = one completion, nothing executed.`,
  '  --no-run              Never execute anything. The model can still read and write files.',
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
  '  -h, --help            This.',
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
  '  OPENROUTER_API_KEY        required — the only one needed to write code.',
  '  OPENROUTER_CODEGEN_MODEL  optional — override the default model.',
  '',
  '  The media half. Each is dark, not broken, when unset:',
  '  RENDER_AUDIT_URL          see_page — render an HTML file and look at it.',
  '  MODAL_TTS_URL             speak / --say — turn text into a .wav.',
  '  MODAL_TRANSCRIBE_URL      transcribe / --task-audio — turn audio into text.',
  '  MODAL_PRESS_URL           make_document — render HTML to PDF.',
  '  MODAL_VIDEO_SECRET        the shared secret those four endpoints expect. A URL',
  '                            without it fails authorisation and reads like a broken',
  '                            service, which is why it is listed here and not implied.',
  '  PERCHANCE_IMAGE_URL       generate_image — optional; a default is built in.',
  '',
  '  Run `acuvo --doctor` to see which of these are live on this machine.',
  '',
  `What it may execute: ${ALLOWED_BINARIES.join(', ')} — and only as \`node <file>\`, \`npm test\`,`,
  '`npm run <script>`, `npx vitest run`, `tsc`. No shell, no pipes, no other program, nothing',
  'outside the workspace. Exit code 1 if the last command it ran still fails.',
].join('\n');

const FLAGS_WITH_VALUES = new Set(['--dir', '--model', '--max-tokens', '--timeout', '--max-rounds', '--command-timeout']);

/**
 * ⚠️ The union is DECLARED so the discriminant survives into TypeScript — see
 * the contracts note in `workspace.mjs` for why inference is not enough.
 *
 * @typedef {{ task: string, tasks: string[], parallel: boolean, issue: number | null, json: boolean, concurrency: number, dir: string | null, model: string | null, maxTokens: number, timeoutMs: number, maxRounds: number, allowRun: boolean, commandTimeoutMs: number, dryRun: boolean, help: boolean }} CliOptions
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
    commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    dryRun: false,
    help: false,
  };
  const prompts = [];

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
    if (arg === '--no-run') { out.allowRun = false; continue; }
    if (FLAGS_WITH_VALUES.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `${arg} needs a value.` };
      }
      i += 1;
      if (arg === '--dir') out.dir = value;
      if (arg === '--model') out.model = value;
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
      if (arg === '--max-rounds') {
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
