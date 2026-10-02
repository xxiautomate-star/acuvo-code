/**
 * ── ⭐⭐ THE CONFIG FILE — AND WHY A "PREFERENCE" IS A SECURITY DECISION ──────
 *
 * Today every preference is retyped on every invocation. There is no way to say
 * "in this checkout, three rounds is plenty" or "on this machine, use acuvo-pro"
 * without a shell alias, and an alias is invisible to `--doctor`, invisible in
 * the audit log, and not shareable with a teammate.
 *
 * ⚠️⚠️ BUT A CONFIG FILE IN THE WORKSPACE IS WRITTEN BY THE REPOSITORY, AND THE
 * REPOSITORY MAY BE ONE THE USER CLONED THIS MINUTE. `lib/policy.mjs` states the
 * problem exactly — *"the policy file lives in the workspace, and the agent can
 * write to the workspace"* — and solves it by refusing to fight for
 * authenticity: every field is monotone downward, so a layer can only ever
 * REMOVE permission and a hostile write buys nothing.
 *
 * This file obeys the same rule, and had to sharpen it in three places.
 *
 * ── ⚠️ 1. "MONOTONE" IS NOT "LOOKS RESTRICTIVE" ─────────────────────────────
 *
 * `checkpoint: false` grants the agent nothing. It is a `false`. It reads, at a
 * glance, like the safe direction. What it actually does is delete your UNDO —
 * `acuvo rewind` has nothing to put back. `autoLease: false` is the same shape:
 * it removes the refusal that stops a second terminal overwriting your file.
 *
 * ⭐ So the test is not "does this value narrow the agent" but **"does this
 * value remove something the USER is relying on, or spend money they did not
 * agree to"**. Two rules, and every line of the table below falls out of them:
 *
 *     R1 — a workspace layer may never increase what a run COSTS.
 *     R2 — a workspace layer may never remove a PROTECTION the user relies on.
 *
 * R1 is why `refute` and `bestOf` are home-only despite both being "more
 * checking": each is n× the paid runs. R2 is why `checkpoint` and `autoLease`
 * are home-only despite both being `false`.
 *
 * ── ⚠️ 2. SOME KEYS HAVE NO STRICTER DIRECTION AT ALL ───────────────────────
 *
 * `model` is the one that matters. There is no ordering on model ids — you
 * cannot say `acuvo-pro` is stricter than `acuvo-flash` — so "may only narrow"
 * has nothing to mean, and a repository choosing the model is a repository
 * choosing what your key is spent on. Same for `holder` (it is the identity
 * leases are attributed to; a repo pinning one name lets two terminals share a
 * holder and step on each other's leases) and `json` (it changes the shape of
 * stdout, which is what somebody's script is parsing).
 *
 * ⭐ THE WAY OUT IS NAMED, NOT WITHHELD. A team that wants to constrain the
 * model already has the right tool: `.acuvo/policy.json`'s `allowModels`, which
 * INTERSECTS and therefore cannot widen. A repo can say "only DeepSeek here";
 * it cannot say "use this one".
 *
 * ── ⚠️⚠️ 3. PRECEDENCE IS NOT TRUST, AND CONFLATING THEM WOULD HAVE MADE THIS
 *            WHOLE FILE DECORATIVE ───────────────────────────────────────────
 *
 * The required order is  flag > env > home > workspace > default.  Read
 * carelessly that says "the environment is trusted above the home file". It is
 * not: `lib/env-file.mjs` loads `.env` and `.env.local` **from inside the
 * workspace** into `process.env`. Anything the env layer may set, a cloned
 * repository may set — with a precedence ABOVE the user's own config file.
 *
 * So the two axes are kept apart:
 *
 *     PRECEDENCE — who wins. env beats home, as specified.
 *     TRUST      — what may be stated at all. An env var whose NAME appears in
 *                  a `.env` file under the workspace root is treated exactly
 *                  like the workspace config file.
 *
 * ⚠️ AND IT IS IGNORE-WITH-A-NOTE THERE, NEVER AN ERROR. `loadEnvFile` does not
 * overwrite a real `export`, so a name present in the repo's `.env` may still be
 * carrying a value the human typed — we genuinely cannot tell. Erroring would
 * hand any repository a way to brick every run; taking the safe value and SAYING
 * SO is the only reading that is wrong in neither direction.
 *
 * ⚠️⚠️ AND IT ONLY WORKS IF THE CALLER PASSES `untrustedEnvNames`. The default
 * is `[]` — i.e. the whole environment is trusted — because the alternative
 * default (distrust everything) silently clamps a legitimate `export
 * ACUVO_MAX_ROUNDS=12` to 5 for everyone. `readWorkspaceEnvNames(root)` computes
 * the set in one line and `bin/` must pass it. Until it does, a workspace `.env`
 * is trusted as if the user had typed it. That is the one unwired edge in this
 * module and it is stated here rather than discovered later.
 *
 * ── WHERE THE FILES LIVE, AND WHY ───────────────────────────────────────────
 *
 *     workspace   .acuvo/config.json
 *     home        ~/.acuvo/config.json   (or $ACUVO_CONFIG_FILE, or $ACUVO_HOME)
 *
 * ⭐ `.acuvo/` RATHER THAN A NEW `.acuvorc` AT THE REPO ROOT, and the reason is
 * not consistency with `policy.json` / `commands.json` / `mcp.json` — though it
 * is that too. It is that **two independent guards already stand over that
 * directory**: `workspace.mjs`'s `AGENT_CONFIG_DIR` HARD-REFUSES every agent
 * write under `.acuvo/` (reads are untouched), and `isPolicyProtectedPath`
 * (`policy.mjs:675`) says the same thing from the other side, with
 * `test/agent-cannot-rewrite-its-own-leash.test.mjs` asserting the two agree.
 * A root-level `.acuvorc` would be an ordinary file the agent can rewrite
 * mid-run; putting the config where those guards already stand means the
 * agent's own `write_file` is refused before monotonicity is ever needed.
 *
 * ⚠️ MONOTONICITY IS STILL THE BOUNDARY, NOT THAT GUARD. It lives in the same
 * process as the agent and covers only the verbs that consult it — `npm run`
 * a script that writes the file and it never fires. The guard is the second
 * lock, and this module is written as though it were not there at all.
 *
 * ⚠️ AND `policy.mjs`'s OWN HEADER IS NOW STALE ABOUT THIS: it says `.acuvo/` is
 * not in `WRITE_FORBIDDEN_ROOTS` so `write_file(".acuvo/policy.json", "{}")`
 * "succeeds today", and recommends adding it. `AGENT_CONFIG_DIR` closed that,
 * separately. Reported, not edited — it is another lane's file.
 *
 * ⚠️ ONE HONEST COST OF THAT CHOICE, REPORTED NOT HIDDEN: `acuvo-dir.mjs` writes
 * `.acuvo/.gitignore` containing `*`, so a workspace config committed there
 * needs `git add -f`. The same is already true of `policy.json`, which
 * `policy.mjs:64` calls "committable, reviewable in a PR". Both cannot be right.
 * That is a real inconsistency in someone else's file and it is reported rather
 * than patched here.
 *
 * ⭐ PURE. Parsing and merging never touch a disk; the two functions at the
 * bottom that do take their reader as an argument, exactly as `policy.mjs` does.
 */

import { MAX_ROUNDS_LIMIT, DEFAULT_MAX_ROUNDS } from './cli-args.mjs';
import { DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS } from './model.mjs';
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from './command.mjs';
import { DEFAULT_BUDGET_USD, parseBudgetUsd, formatUsd } from './budget.mjs';
import { resolveModelName } from './acuvo-models.mjs';
import { TIERS } from './escalate.mjs';
/**
 * ── ⭐⭐⭐ THE FOUR QUESTIONS, AND WHY THEIR ANSWERS ARE IMPORTED ────────────
 *
 * Roman, standing: *"those 4 questions should be determined by the user, our CLI
 * should be super customisable."* The four are:
 *
 *   1. when is a task DONE      `acceptance.mjs`      DONE_MODES
 *   2. what may it COST         `budget.mjs`          DEFAULT_BUDGET_USD  ← already here
 *   3. ASK or ACT               `diff-preview.mjs`    APPROVE_MODES + `ask-user.mjs` MAX_QUESTIONS
 *   4. what to do when STUCK    `stuck.mjs`           STUCK_ACTIONS
 *
 * ⚠️⚠️ EVERY ONE OF THESE IS IMPORTED, NEVER RETYPED. A private copy of "which
 * values are legal" is the invented-constant bug this repo has paid for twice —
 * a config file that accepted a fourth mode would be offering a value the module
 * refuses, and the refusal would arrive halfway through a paid run. One table,
 * two consumers, in every case.
 *
 * ⭐ AND THE DEFAULT OF EACH IS IMPORTED TOO, so `defaultConfig()` cannot drift
 * from the behaviour a user with no config file actually gets. That is the whole
 * of requirement 3: a person who sets nothing must get exactly today's run.
 */
import { DONE_MODES, DEFAULT_DONE_MODE } from './acceptance.mjs';
import { STUCK_ACTIONS, DEFAULT_STUCK_ACTION } from './stuck.mjs';
import { APPROVE_MODES, APPROVE_ENV } from './diff-preview.mjs';
import { MAX_QUESTIONS } from './ask-user.mjs';
/**
 * ⭐ THE VALUE-TAKING FLAGS COME FROM THE COMPLETION TABLE, not a second list.
 * `explicitKeysFromArgv` has to skip a flag's VALUE while scanning (`--model
 * --json` is a model id, not two flags), and a private copy of "which flags take
 * values" is precisely the shape of the invented-constant bug this repo has paid
 * for twice. One table, two consumers, and the completion drift test already
 * pins that table to the parser.
 */
import { FLAGS } from './completion.mjs';

/** Where a project states its convention. See the header on why `.acuvo/`. */
export const WORKSPACE_CONFIG_FILE = '.acuvo/config.json';
/** Where a person states their own preferences, outside the agent's reach. */
export const HOME_CONFIG_FILE = 'config.json';
/** Relocates the home file wholesale, for CI and for testing. */
export const CONFIG_FILE_ENV = 'ACUVO_CONFIG_FILE';
/** The same variable `account.mjs` uses to move the whole `~/.acuvo` directory. */
export const ACUVO_HOME_ENV = 'ACUVO_HOME';

// ── the key table ──────────────────────────────────────────────────────────

/**
 * `trust`:
 *   'any'   — an untrusted layer may state it, but only to NARROW.
 *   'home'  — only a trusted layer may state it (see R1/R2 in the header).
 *   'never' — no file and no variable may state it, ever.
 *
 * `reduce` (only meaningful for `trust: 'any'`):
 *   'min'    smaller wins; `null` means "no ceiling" and loses to every number.
 *   'and'    `false` wins.
 *   'or'     `true` wins.
 *   'ladder' the earlier entry in `TIERS` wins.
 */
const key = (spec) => Object.freeze(spec);

/**
 * ── ⭐ THE REVIEW LADDER, STRICTEST FIRST ───────────────────────────────────
 *
 * `reduce: 'ladder'` keeps the EARLIER entry, so the order IS the direction an
 * untrusted layer may move. `always` (ask about every write) is strictest,
 * `never` (ask about none) is loosest — so a cloned repository can say "in this
 * checkout, ask me about everything" and cannot say "stop asking".
 *
 * ⚠️ THE SET COMES FROM `diff-preview.mjs`; only the ORDER is stated here, and
 * the assertion below is what stops the two drifting. A mode added there and not
 * ranked here would silently be un-settable, which is the quiet half of the
 * misspelled-cap failure `parseConfigDocument` refuses out loud.
 */
export const APPROVE_LADDER = Object.freeze(['always', 'auto', 'never']);
if (APPROVE_LADDER.length !== APPROVE_MODES.length || APPROVE_MODES.some((m) => !APPROVE_LADDER.includes(m))) {
  throw new Error(`rcfile: APPROVE_LADDER (${APPROVE_LADDER.join(', ')}) must rank exactly the modes diff-preview.mjs defines (${APPROVE_MODES.join(', ')})`);
}

export const CONFIG_KEYS = Object.freeze({
  /** ⚠️ home-only: model ids have no stricter direction. See header §2. */
  model: key({ option: 'model', kind: 'model', trust: 'home', env: ['ACUVO_MODEL', 'OPENROUTER_CODEGEN_MODEL'] }),

  maxRounds: key({ option: 'maxRounds', kind: 'int', min: 1, max: MAX_ROUNDS_LIMIT, trust: 'any', reduce: 'min', env: ['ACUVO_MAX_ROUNDS'] }),
  budget: key({ option: 'budgetUsd', kind: 'money', trust: 'any', reduce: 'min', env: ['ACUVO_BUDGET'] }),
  maxTokens: key({ option: 'maxTokens', kind: 'int', min: 256, max: 64_000, trust: 'any', reduce: 'min', env: ['ACUVO_MAX_TOKENS'] }),
  timeout: key({ option: 'timeoutMs', kind: 'seconds', min: 5, max: 900, trust: 'any', reduce: 'min', env: ['ACUVO_TIMEOUT'] }),
  commandTimeout: key({ option: 'commandTimeoutMs', kind: 'seconds', min: 1, max: MAX_COMMAND_TIMEOUT_MS / 1000, trust: 'any', reduce: 'min', env: ['ACUVO_COMMAND_TIMEOUT'] }),
  concurrency: key({ option: 'concurrency', kind: 'int', min: 1, max: 4, trust: 'any', reduce: 'min', env: ['ACUVO_CONCURRENCY'] }),
  maxTier: key({ option: 'maxTier', kind: 'enum', choices: TIERS, trust: 'any', reduce: 'ladder', env: ['ACUVO_MAX_TIER'] }),
  /** `false` is the strict side, and it is what `--no-run` sets. */
  allowRun: key({ option: 'allowRun', kind: 'bool', trust: 'any', reduce: 'and', env: ['ACUVO_ALLOW_RUN'] }),
  /** `true` is the strict side: nothing reaches disk. */
  dryRun: key({ option: 'dryRun', kind: 'bool', trust: 'any', reduce: 'or', env: ['ACUVO_DRY_RUN'] }),

  /* ── the four questions ─────────────────────────────────────────────────── */

  /**
   * ── ⭐ Q1: WHEN IS A TASK DONE ──────────────────────────────────────────────
   *
   * ⚠️ HOME-ONLY, and it is §2's argument rather than R1/R2's — there is no
   * stricter DIRECTION here at all. `never` costs more money (R1 says no to a
   * repository); `verified` stops sooner and can hand back a half-finished job
   * (R2 says no in the other direction). A key whose every value harms the user
   * in one direction or the other has no meet, and "may only narrow" has nothing
   * to mean. A project that wants to state a completion rule already has the
   * right tool: `.acuvo/acceptance.json`, which names the exact commands that
   * must pass and is consent-gated (`acceptance-consent.mjs`).
   */
  done: key({ option: 'doneWhen', kind: 'enum', choices: DONE_MODES, trust: 'home', env: ['ACUVO_DONE'] }),

  /**
   * ── ⭐ Q3a: ASK OR ACT, FOR WRITES ─────────────────────────────────────────
   *
   * ⚠️ THE ENV VAR IS `ACUVO_APPROVE`, WHICH `diff-preview.mjs` ALSO READS, and
   * that is deliberate rather than a duplication: routing it through here is the
   * only way the documented precedence (flag > env > home > workspace) applies
   * to it at all. Today the env beats a home config file because the home layer
   * does not exist for this key. `bin/` passes the resolved value down as the
   * `flag` argument, which `approvalMode` already ranks above its own env read —
   * so there is exactly one decision, made here.
   *
   * ⚠️ `strictEnv` — see `readEnvLayer`. A malformed value for this key STOPS
   * the run rather than being noted and ignored, because `diff-preview.mjs`
   * refuses `ACUVO_APPROVE=nver` today and turning that into a silent "auto"
   * would be the fail-open-on-a-typo the whole file is built against.
   */
  approve: key({ option: 'approveMode', kind: 'enum', choices: APPROVE_LADDER, trust: 'any', reduce: 'ladder', strictEnv: true, env: [APPROVE_ENV] }),

  /**
   * ── ⭐ Q3b: HOW MANY QUESTIONS THE MODEL MAY ASK YOU ───────────────────────
   *
   * `min` reduce and `trust: 'any'` — a repository may only make the agent
   * INTERRUPT YOU LESS, never more. `0` is legal and means "never ask, state
   * your assumption instead", which is what `ask-user.mjs` already tells the
   * model to do once the allowance is gone.
   */
  maxQuestions: key({ option: 'maxQuestions', kind: 'int', min: 0, max: 10, trust: 'any', reduce: 'min', env: ['ACUVO_MAX_QUESTIONS'] }),

  /**
   * ── ⭐ Q4: WHAT TO DO WHEN IT IS STUCK ─────────────────────────────────────
   *
   * ⚠️ HOME-ONLY, for §2's reason again. `stop` saves money and throws away
   * every round already paid for — `stuck.mjs`'s header opens on exactly that
   * asymmetry — while `nudge` spends more. Neither direction is monotone, so a
   * repository does not get to answer it.
   */
  onStuck: key({ option: 'onStuck', kind: 'enum', choices: STUCK_ACTIONS, trust: 'home', env: ['ACUVO_ON_STUCK'] }),

  /* ── everything else ────────────────────────────────────────────────────── */

  /** ⚠️ R1 — n paid runs instead of one. A repository does not spend your money. */
  bestOf: key({ option: 'bestOf', kind: 'int', min: 2, max: 5, trust: 'home', env: ['ACUVO_BEST_OF'] }),
  /** ⚠️ R1 — a second full run, every time. Same argument as `bestOf`. */
  refute: key({ option: 'refute', kind: 'bool', trust: 'home', env: ['ACUVO_REFUTE'] }),
  /** ⚠️ R2 — turning this off deletes `acuvo rewind`'s ability to undo. */
  checkpoint: key({ option: 'checkpoint', kind: 'bool', trust: 'home', env: ['ACUVO_CHECKPOINT'] }),
  /** ⚠️ R2 — turning this off removes the refusal that stops two terminals
   *  overwriting the same file. */
  autoLease: key({ option: 'autoLease', kind: 'bool', trust: 'home', env: ['ACUVO_AUTO_LEASE'] }),
  /** ⚠️ §2 — changes the shape of stdout, which is what a script is parsing. */
  json: key({ option: 'json', kind: 'bool', trust: 'home', env: ['ACUVO_JSON'] }),
  /** ⚠️ §2 — changes the exit code a cron job reads. Not a repo's call. */
  unattended: key({ option: 'unattended', kind: 'bool', trust: 'home', env: ['ACUVO_UNATTENDED'] }),
  /** ⚠️ §2 — lease attribution. Two terminals sharing a holder can take each
   *  other's leases, which is the exact collision leases exist to prevent. */
  holder: key({ option: 'holder', kind: 'string', trust: 'home', env: ['ACUVO_HOLDER'] }),

  /**
   * ── ⚠️⚠️ `shell` IS A KNOWN KEY THAT NOTHING MAY SET, AND THAT IS THE POINT ─
   *
   * `--shell` is the one flag that REMOVES a safety property rather than adding
   * one (`cli-args.mjs:551`): it lets the agent run any program on the machine
   * at the user's privileges. A config file that could turn it on would make
   * `acuvo "…"` mean something different depending on a file, and — because
   * `.env` reaches the environment — a cloned repository could mean it.
   *
   * ⭐ It is listed rather than simply unknown so the refusal can NAME THE WAY
   * OUT. "unknown setting shell" teaches nothing; the message below teaches the
   * alias, which keeps the decision on the command line where the audit log
   * records it per run.
   */
  shell: key({ option: 'shell', kind: 'bool', trust: 'never', env: [] }),

  /**
   * ⭐ THE ESCAPE HATCH, and the direct sibling of policy.mjs's
   * `allowWorkspacePolicy`. Because a workspace file that oversteps is a hard
   * error, a hostile — or merely wrong — repository could otherwise stop every
   * run in that checkout. This turns the workspace layer off entirely. Home
   * only, and it is not a lattice value: it decides which layers are READ.
   */
  workspaceConfig: key({ option: null, kind: 'bool', trust: 'home', env: [] }),
});

export const KEY_NAMES = Object.freeze(Object.keys(CONFIG_KEYS));

/**
 * Flag → config key, for working out what the user typed. Only flags that set
 * something a config file can also set appear here.
 *
 * ⚠️ `--no-run`, `--no-checkpoint` and `--no-auto-lease` are the NEGATIVE
 * spellings of positive keys. What matters is only that the key was DECIDED on
 * the command line, so the value is irrelevant here — this map answers "did the
 * user speak about this", not "what did they say".
 */
export const FLAG_KEYS = Object.freeze({
  '--model': 'model',
  '--max-rounds': 'maxRounds',
  '--budget': 'budget',
  '--max-tokens': 'maxTokens',
  '--timeout': 'timeout',
  '--command-timeout': 'commandTimeout',
  '--concurrency': 'concurrency',
  '--max-tier': 'maxTier',
  '--done': 'done',
  '--approve': 'approve',
  '--max-questions': 'maxQuestions',
  '--on-stuck': 'onStuck',
  '--best-of': 'bestOf',
  '--no-run': 'allowRun',
  '--dry-run': 'dryRun',
  '--refute': 'refute',
  '--json': 'json',
  // ⚠️ `--output-format` decides `json` too. Missing from this map, a config
  // file's `json:false` silently OVERRODE it — measured 2026-09-27: the
  // stream carried the banner and the human lines on stdout.
  '--output-format': 'json',
  '--no-checkpoint': 'checkpoint',
  '--no-auto-lease': 'autoLease',
  '--unattended': 'unattended',
  '--holder': 'holder',
  '--shell': 'shell',
});

/** Every flag that consumes the following argv entry — see the import note. */
const VALUE_FLAGS = new Set(FLAGS.filter((f) => f.value).map((f) => f.name));

/**
 * Which config keys the user decided on the command line.
 *
 * ⚠️ SCANS `argv`, NOT THE PARSED OPTIONS, and it has to. `parseArgv` returns
 * defaults for everything, so a parsed `maxRounds: 5` is indistinguishable from
 * a typed `--max-rounds 5` — and a config layer that cannot tell those apart
 * would silently override a number the user typed, which is the one thing
 * precedence exists to prevent.
 *
 * ⚠️ THE VALUE OF A VALUE-TAKING FLAG IS SKIPPED. `--holder --json` records a
 * holder called "--json"; without the skip we would also record that the user
 * asked for JSON output.
 *
 * ⚠️ `--flag=value` IS NOT SUPPORTED, because `parseArgv` does not support it
 * either (it answers "Unknown option --model=x"). Recognising a spelling the
 * parser refuses would make this the only layer that understood it.
 */
export function explicitKeysFromArgv(argv = []) {
  const out = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '');
    if (FLAG_KEYS[arg]) out.add(FLAG_KEYS[arg]);
    if (VALUE_FLAGS.has(arg)) i += 1;
  }
  return out;
}

// ── reading one value ──────────────────────────────────────────────────────

const ENV_TRUE = new Set(['1', 'true', 'yes', 'on']);
const ENV_FALSE = new Set(['0', 'false', 'no', 'off']);

/**
 * @param {object} spec
 * @param {unknown} raw
 * @param {{ source: 'file'|'env', label: string, name: string }} ctx
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function readValue(spec, raw, { source, label, name }) {
  const where = `${label}: "${name}"`;

  if (spec.kind === 'bool') {
    if (source === 'file') {
      /**
       * ⚠️ NOT TRUTHINESS — the same refusal `policy.mjs:237` makes. The string
       * `"false"` is truthy, and for `checkpoint`, `allowRun` and `dryRun` the
       * wrong reading is the unsafe one in every case.
       */
      if (typeof raw !== 'boolean') return { ok: false, error: `${where} must be true or false (got ${JSON.stringify(raw)})` };
      return { ok: true, value: raw };
    }
    const s = String(raw ?? '').trim().toLowerCase();
    if (ENV_TRUE.has(s)) return { ok: true, value: true };
    if (ENV_FALSE.has(s)) return { ok: true, value: false };
    return { ok: false, error: `${where} must be one of ${[...ENV_TRUE].join('/')} or ${[...ENV_FALSE].join('/')} (got ${JSON.stringify(String(raw))})` };
  }

  if (spec.kind === 'string') {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return { ok: false, error: `${where} must be a non-empty string (got ${JSON.stringify(raw)})` };
    return { ok: true, value: s };
  }

  if (spec.kind === 'model') {
    const picked = resolveModelName(typeof raw === 'string' ? raw : '');
    /**
     * ⭐ RESOLVED HERE FOR THE SAME REASON `cli-args.mjs:598` resolves it at
     * parse time: `acuvo-pro` must mean the same thing in a config file as on
     * the command line, and a typo must cost a message rather than a round trip
     * to a provider that answers "no endpoints found".
     */
    if (!picked.ok) return { ok: false, error: `${where} — ${picked.error}` };
    return { ok: true, value: picked.id };
  }

  if (spec.kind === 'enum') {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!spec.choices.includes(s)) {
      return { ok: false, error: `${where} must be one of ${spec.choices.join(', ')} (got ${JSON.stringify(raw)})` };
    }
    return { ok: true, value: s };
  }

  if (spec.kind === 'money') {
    const s = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim();
    if (/^(none|off|unlimited)$/i.test(s)) return { ok: true, value: null };
    /**
     * ⚠️ PARSED BY `budget.mjs`, and its refusal is returned verbatim — the same
     * discipline `cli-args.mjs:620` records. `25c` and `$2` must mean here what
     * they mean on the flag, and one mistake must not get two wordings.
     */
    const parsed = parseBudgetUsd(s);
    if (!parsed.ok) return { ok: false, error: `${where} — ${parsed.message}` };
    return { ok: true, value: parsed.usd };
  }

  // int and seconds
  const n = Number(typeof raw === 'string' ? raw.trim() : raw);
  if (!Number.isInteger(n)) {
    return { ok: false, error: `${where} must be a whole number between ${spec.min} and ${spec.max} (got ${JSON.stringify(raw)})` };
  }
  if (n < spec.min || n > spec.max) {
    return { ok: false, error: `${where} must be between ${spec.min} and ${spec.max} (got ${n})` };
  }
  return { ok: true, value: spec.kind === 'seconds' ? n * 1000 : n };
}

// ── the lattice, for the keys an untrusted layer may state ─────────────────

/**
 * ⭐⭐ THE MEET, per key. Same shape as `policy.mjs:mergePolicies` and for the
 * same reason: whatever an untrusted layer writes, the result can never permit
 * more, or cost more, than the value it is overriding.
 *
 * @returns {{ value: unknown, clamped: boolean }}
 */
export function narrow(spec, current, proposed) {
  let value = proposed;
  if (spec.reduce === 'min') {
    // `null` is "no ceiling", i.e. +∞, so it loses to every number.
    if (current === null || current === undefined) value = proposed;
    else if (proposed === null || proposed === undefined) value = current;
    else value = Math.min(current, proposed);
  } else if (spec.reduce === 'and') {
    value = Boolean(current) && Boolean(proposed);
  } else if (spec.reduce === 'or') {
    value = Boolean(current) || Boolean(proposed);
  } else if (spec.reduce === 'ladder') {
    const a = spec.choices.indexOf(current);
    const b = spec.choices.indexOf(proposed);
    value = spec.choices[Math.min(a === -1 ? b : a, b === -1 ? a : b)];
  } else {
    /**
     * ⚠️ FAIL CLOSED ON A KEY WITH NO REDUCER. A `default: return proposed` here
     * would mean that adding a `trust: 'any'` key and forgetting its `reduce`
     * silently hands an untrusted layer a free widening — a hole opened by an
     * omission rather than a decision, which is the kind nobody reviews.
     */
    value = current;
  }
  return { value, clamped: value !== proposed };
}

// ── parsing one document ───────────────────────────────────────────────────

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parse ONE config file's text into a partial config.
 *
 * Returns only the keys the document actually stated, so merging can tell
 * "said nothing" from "said the permissive thing" — the distinction
 * `policy.mjs:246` also depends on.
 *
 * @param {string} text
 * @param {{ label?: string, trusted?: boolean }} [opts]
 */
export function parseConfigDocument(text, { label = 'config', trusted = false } = {}) {
  if (typeof text !== 'string') return { ok: false, error: `${label}: expected the file's text` };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: `${label}: the file is empty. Write {} for a config that changes nothing.` };

  let doc;
  try {
    doc = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `${label}: not valid JSON — ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isPlainObject(doc)) return { ok: false, error: `${label}: the top level must be a JSON object` };

  const out = {};
  for (const name of Object.keys(doc)) {
    const spec = CONFIG_KEYS[name];
    /**
     * ⚠️ AN UNKNOWN KEY STOPS THE RUN, for policy.mjs's reason: `{"maxRoundz":
     * 2}` is valid JSON, sets nothing, and reads to a human as a cap. A typo
     * that silently means "the default" is the accident this file exists to
     * prevent.
     */
    if (!spec) {
      return { ok: false, error: `${label}: unknown setting "${name}". A misspelled preference sets nothing and reads like a preference. Known: ${KEY_NAMES.join(', ')}` };
    }
    if (spec.trust === 'never') {
      return {
        ok: false,
        error: `${label}: "${name}" cannot be set in a config file at all. `
          + '--shell lets the agent run any program on this machine at your privileges, so it stays on the command line where the audit log records which runs had it. '
          + "If you want it every time, alias it:  alias acuvo='acuvo --shell'",
      };
    }
    if (spec.trust === 'home' && !trusted) {
      return {
        ok: false,
        error: `${label}: "${name}" may only be set in your own config (${CONFIG_FILE_ENV}, or ~/.acuvo/${HOME_CONFIG_FILE}), not in a repository. `
          + reasonForHomeOnly(name)
          + ` If this checkout is not yours to change, switch the workspace layer off with {"workspaceConfig": false} in ~/.acuvo/${HOME_CONFIG_FILE}.`,
      };
    }
    const read = readValue(spec, doc[name], { source: 'file', label, name });
    if (!read.ok) return read;
    out[name] = read.value;
  }
  return { ok: true, config: out };
}

/** One sentence per home-only key, so the refusal teaches rather than blocks. */
function reasonForHomeOnly(name) {
  switch (name) {
    case 'model': return 'A model id has no stricter direction, so "may only narrow" cannot apply to it — use policy.json\'s allowModels to limit which models this repo may use.';
    case 'done': return 'It has no stricter direction: stopping sooner can hand back a half-finished job, and stopping later spends more of your money. To state a completion rule for this project, declare the commands in .acuvo/acceptance.json instead.';
    case 'onStuck': return 'It has no stricter direction: stopping throws away every round already paid for, and continuing spends more.';
    case 'bestOf': return 'It multiplies the number of paid runs.';
    case 'refute': return 'It adds a second paid run to every task.';
    case 'checkpoint': return 'Turning it off removes your ability to `acuvo rewind` this run.';
    case 'autoLease': return 'Turning it off removes the refusal that stops two terminals overwriting the same file.';
    case 'json': return 'It changes the shape of stdout, which is what your scripts parse.';
    case 'unattended': return 'It changes the exit code your scheduler reads.';
    case 'holder': return 'It is who leases are attributed to, and two terminals sharing a holder can take each other\'s leases.';
    case 'workspaceConfig': return 'It decides which layers are read at all, so a repository cannot be the one to answer it.';
    default: return '';
  }
}

// ── resolving all the layers ───────────────────────────────────────────────

/** The value each key has when nobody has said anything. */
export function defaultConfig() {
  return {
    /**
     * ⚠️⚠️ `null`, NOT `DEFAULT_MODEL`, AND THE SUITE CAUGHT ME PUTTING THE
     * CONSTANT HERE. `parseArgv` produces `model: null` meaning *"nobody chose;
     * resolve it later"* — the chain then reads `$OPENROUTER_CODEGEN_MODEL` and
     * falls back to `DEFAULT_MODEL` itself (`model.mjs:41`). Seeding this layer
     * with the constant makes the config layer look like it CHOSE the default,
     * and a layer that claims to have chosen is a layer that can override
     * something downstream that had a better answer.
     *
     * ⭐ The rule this is an instance of: a default in a merging layer must be
     * the same VALUE the layer it merges into produces, not the same MEANING.
     */
    model: null,
    /**
     * ⭐⭐ THE FOUR, AND EVERY ONE OF THEM IS AN IMPORT. Requirement 3 in one
     * line: a user who sets nothing gets exactly today's behaviour, and the only
     * way to keep that true as the modules change is to never restate their
     * defaults here. `test/four-questions-config.test.mjs` pins each of these
     * against the constant the runtime actually reads.
     */
    done: DEFAULT_DONE_MODE,
    approve: 'auto',
    maxQuestions: MAX_QUESTIONS,
    onStuck: DEFAULT_STUCK_ACTION,
    maxRounds: DEFAULT_MAX_ROUNDS,
    budget: DEFAULT_BUDGET_USD,
    maxTokens: DEFAULT_MAX_TOKENS,
    timeout: DEFAULT_TIMEOUT_MS,
    commandTimeout: DEFAULT_COMMAND_TIMEOUT_MS,
    concurrency: 2,
    maxTier: 'best-of',
    allowRun: true,
    dryRun: false,
    bestOf: 0,
    refute: false,
    checkpoint: true,
    autoLease: true,
    json: false,
    unattended: false,
    holder: null,
    shell: false,
    workspaceConfig: true,
  };
}

/**
 * Read the env layer into a partial config, tagging each key with whether the
 * variable that supplied it is trusted.
 *
 * @param {object} env
 * @param {ReadonlySet<string>|readonly string[]} untrustedEnvNames
 */
function readEnvLayer(env, untrustedEnvNames, notes) {
  const untrusted = untrustedEnvNames instanceof Set ? untrustedEnvNames : new Set(untrustedEnvNames ?? []);
  const stated = [];
  for (const [name, spec] of Object.entries(CONFIG_KEYS)) {
    for (const varName of spec.env ?? []) {
      const raw = env?.[varName];
      if (raw === undefined || String(raw).trim() === '') continue;
      const trusted = !untrusted.has(varName);
      const read = readValue(spec, raw, { source: 'env', label: varName, name });
      if (!read.ok) {
        /**
         * ⚠️⚠️ `strictEnv` IS THE EXCEPTION, AND IT EXISTS TO PRESERVE AN
         * EXISTING REFUSAL RATHER THAN TO ADD ONE. `diff-preview.mjs` already
         * stops the run on `ACUVO_APPROVE=nver` — "a person asking for a gate
         * and silently getting none, and the symptom is *everything works
         * fine*". Routing that variable through this layer without carrying its
         * strictness across would have quietly downgraded a hard refusal to a
         * note, i.e. a security regression delivered by a refactor.
         */
        if (spec.strictEnv) return { fatal: `${varName} — ${read.error}` };
        /**
         * ⚠️ OTHERWISE AN UNPARSEABLE ENVIRONMENT VARIABLE IS A NOTE, NOT A
         * STOPPED RUN — unlike a config file. A file is a thing someone wrote
         * for this tool; a variable may have been set by a parent process, a CI
         * runner, or a `.env` we do not own, and refusing to start because a
         * stranger's variable is malformed fails correct work.
         */
        notes.push(`ignored ${varName}: ${read.error}`);
        continue;
      }
      stated.push({ name, value: read.value, trusted, label: varName });
      break; // first variable in the list wins — see CONFIG_KEYS.model
    }
  }
  return { stated };
}

/**
 * Build the effective configuration.
 *
 * PURE — it takes TEXT, not paths, so the whole decision surface is testable
 * with no disk. `readConfigSources` below turns paths into text.
 *
 * ── PRECEDENCE:  flag > env > home > workspace > default ────────────────────
 * Applied lowest first. A TRUSTED layer installs its value outright. An
 * UNTRUSTED layer installs `narrow(current, proposed)` — so it can move a value
 * only toward less permission and less spend, whatever it writes.
 *
 * @param {{
 *   argv?: readonly string[],
 *   explicitKeys?: ReadonlySet<string>,
 *   env?: object,
 *   untrustedEnvNames?: ReadonlySet<string>|readonly string[],
 *   homeText?: string|null, homeLabel?: string,
 *   workspaceText?: string|null, workspaceLabel?: string,
 * }} input
 */
export function resolveConfig({
  argv = null,
  explicitKeys = null,
  env = {},
  untrustedEnvNames = [],
  homeText = null,
  homeLabel = `~/.acuvo/${HOME_CONFIG_FILE}`,
  workspaceText = null,
  workspaceLabel = WORKSPACE_CONFIG_FILE,
} = {}) {
  const typed = explicitKeys ?? explicitKeysFromArgv(argv ?? []);
  const values = defaultConfig();
  const notes = [];
  const sources = [];
  /** Which keys were last set by a layer we trust — see `budgetExplicit`. */
  const trustedlySet = new Set();
  /**
   * ⚠️⚠️ WHICH KEYS A LAYER ACTUALLY SPOKE ABOUT — *not* which ones differ from
   * the default, and the suite caught the difference. `ACUVO_MODEL=acuvo-flash`
   * resolves to exactly `DEFAULT_MODEL`, so a "did it change?" test dropped a
   * setting the user had explicitly made. It happened to be harmless for that
   * one key and would not have been for the next one; "equals the default" and
   * "nobody said anything" are different facts and must be stored separately.
   */
  const statedKeys = new Set();
  /**
   * ── ⭐⭐ WHERE EACH VALUE CAME FROM — REQUIREMENT 5, AND IT IS NOT COSMETIC ─
   *
   * *"A knob nobody can find is not configurable."* Until now this resolver
   * could tell you WHAT the effective value was and, in aggregate, which files
   * it had read — never which of five layers actually decided a given key. That
   * is the difference between `acuvo config` being an answer and being a list.
   *
   * ⚠️ SEEDED WITH 'default' FOR EVERY KEY, so a key nobody spoke about reports
   * `default` rather than `undefined`. "Nobody said anything" is a fact worth
   * printing, and it is the fact a confused user most needs.
   */
  const origins = {};
  for (const name of KEY_NAMES) origins[name] = { layer: 'default', label: 'built-in default' };
  const setOrigin = (name, layer, label) => { origins[name] = { layer, label }; };

  for (const name of typed) {
    /**
     * ⭐ A TYPED FLAG IS RECORDED AS THE ORIGIN EVEN THOUGH THE RESOLVER NEVER
     * SEES ITS VALUE. `resolveConfig` is told only WHICH keys were explicit; the
     * value lands on `options` from the parser. But the provenance question —
     * "why is this what it is?" — is answered here, and answering it with the
     * file that lost would be worse than not answering it at all.
     */
    setOrigin(name, 'flag', flagForKey(name) ?? 'command line');
  }

  let home = {};
  if (homeText !== null && homeText !== undefined) {
    const parsed = parseConfigDocument(homeText, { label: homeLabel, trusted: true });
    if (!parsed.ok) return parsed;
    home = parsed.config;
  }

  // ── workspace (untrusted, lowest precedence above the defaults) ──────────
  if (workspaceText !== null && workspaceText !== undefined) {
    if (home.workspaceConfig === false) {
      sources.push({ label: workspaceLabel, trusted: false, ignored: true });
      notes.push(`${workspaceLabel} ignored — your config sets {"workspaceConfig": false}`);
    } else {
      const parsed = parseConfigDocument(workspaceText, { label: workspaceLabel, trusted: false });
      if (!parsed.ok) return parsed;
      for (const [name, proposed] of Object.entries(parsed.config)) {
        const spec = CONFIG_KEYS[name];
        const { value, clamped } = narrow(spec, values[name], proposed);
        if (clamped) {
          notes.push(`${workspaceLabel}: ${name} ${describeValue(name, proposed)} would loosen the current ${describeValue(name, values[name])}, so it was ignored — a repository may only tighten.`);
        }
        values[name] = value;
        statedKeys.add(name);
        // ⚠️ A CLAMPED VALUE DID NOT COME FROM THE WORKSPACE — the workspace
        // asked and was refused, so the origin is still whatever set it before.
        if (!clamped && !typed.has(name)) setOrigin(name, 'workspace', workspaceLabel);
      }
      sources.push({ label: workspaceLabel, trusted: false });
    }
  }

  // ── home (trusted) ──────────────────────────────────────────────────────
  if (homeText !== null && homeText !== undefined) {
    for (const [name, value] of Object.entries(home)) {
      values[name] = value;
      trustedlySet.add(name);
      statedKeys.add(name);
      if (!typed.has(name)) setOrigin(name, 'home', homeLabel);
    }
    sources.push({ label: homeLabel, trusted: true });
  }

  // ── environment (mixed trust, higher precedence than home) ──────────────
  const envLayer = readEnvLayer(env, untrustedEnvNames, notes);
  /**
   * ⚠️ A `strictEnv` KEY WITH A MALFORMED VALUE STOPS THE RUN, and it stops it
   * HERE — before the workspace layer's clamps are reported, before anything is
   * returned. See the note in `readEnvLayer`: this preserves a refusal that
   * already existed in `diff-preview.mjs` rather than inventing one.
   */
  if (envLayer.fatal) return { ok: false, error: envLayer.fatal };
  for (const stated of envLayer.stated) {
    const spec = CONFIG_KEYS[stated.name];
    if (stated.trusted) {
      values[stated.name] = stated.value;
      trustedlySet.add(stated.name);
      statedKeys.add(stated.name);
      if (!typed.has(stated.name)) setOrigin(stated.name, 'env', stated.label);
      continue;
    }
    if (spec.trust !== 'any') {
      notes.push(`${stated.label} ignored: it came from a .env file inside this workspace, and ${stated.name} is not a repository's to set.`);
      continue;
    }
    const { value, clamped } = narrow(spec, values[stated.name], stated.value);
    if (clamped) notes.push(`${stated.label} came from a .env file inside this workspace, so it may only tighten — kept ${describeValue(stated.name, values[stated.name])}.`);
    statedKeys.add(stated.name);
    if (!clamped && !typed.has(stated.name)) setOrigin(stated.name, 'env', `${stated.label} (from a .env in this workspace)`);
    /**
     * ⭐ `trustedlySet` IS NOT CLEARED HERE, deliberately. An untrusted layer can
     * only ever TIGHTEN, so a ceiling the human chose and a repository then
     * lowered is still a ceiling the human chose — `--until-done` should keep
     * working. What must never happen is the opposite: an untrusted layer
     * INTRODUCING a budget and thereby unlocking the unbounded mode, and that
     * cannot happen because it never gets into `trustedlySet` in the first place.
     */
    values[stated.name] = value;
  }

  /**
   * ⭐ WHAT THE CALLER GETS BACK CANNOT CONTAIN A KEY THE USER TYPED. The
   * wiring is then `Object.assign(options, resolved.values)` and it is
   * impossible to get the precedence wrong at the call site — which is where
   * every layered-config bug actually lives.
   */
  const out = {};
  for (const [name, spec] of Object.entries(CONFIG_KEYS)) {
    if (!spec.option) continue;
    if (typed.has(name)) continue;
    if (!statedKeys.has(name)) continue;
    out[spec.option] = values[name];
  }

  /**
   * ⚠️⚠️ `budgetExplicit` IS A SECURITY FIELD, NOT BOOKKEEPING. `--until-done`
   * refuses to run without it (`cli-args.mjs:847`), because an unbounded loop
   * against a paid API must have a ceiling a HUMAN chose. A budget that arrived
   * from a workspace file therefore must NOT set it — otherwise a cloned
   * repository could unlock the unbounded mode by writing one number.
   */
  if (!typed.has('budget') && trustedlySet.has('budget')) out.budgetExplicit = true;

  return { ok: true, values, options: out, notes, sources, origins, typed: [...typed].sort() };
}

/** The flag that sets a key, for the provenance line. Null when there is none. */
function flagForKey(name) {
  for (const [flag, k] of Object.entries(FLAG_KEYS)) if (k === name) return flag;
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐⭐ THE FOUR QUESTIONS, MADE FINDABLE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ── ⭐ ONE TABLE, BECAUSE FOUR BESPOKE MECHANISMS IS THE FAILURE ────────────
 *
 * The brief asked for the smallest coherent config surface over four bespoke
 * ones, and this is the whole of it: four rows naming the key that answers each
 * question, the flag that types it, the variable that exports it, and — the part
 * that makes it a feature rather than a docstring — the CONSTANT it used to be,
 * so `acuvo config` can print "this is the built-in default" truthfully.
 *
 * ⚠️ THE `key` FIELDS ARE ASSERTED AGAINST `CONFIG_KEYS` BELOW. A question that
 * named a key nobody resolves would render a permanently-wrong row, which is
 * worse than not printing it: a settings screen that lies is how somebody
 * concludes the flag does nothing.
 */
export const FOUR_QUESTIONS = Object.freeze([
  Object.freeze({
    id: 'done',
    question: 'When is a task DONE?',
    keys: Object.freeze(['done']),
    was: 'a fixed rule in turn.mjs: any verification command exiting 0 closed the run after one grace round',
  }),
  Object.freeze({
    id: 'cost',
    question: 'What may it COST?',
    keys: Object.freeze(['budget']),
    was: `the constant DEFAULT_BUDGET_USD (${formatUsd(DEFAULT_BUDGET_USD)}) in budget.mjs`,
  }),
  Object.freeze({
    id: 'ask',
    question: 'ASK or ACT?',
    keys: Object.freeze(['approve', 'maxQuestions']),
    was: `APPROVE_MODES defaulting to auto in diff-preview.mjs, and MAX_QUESTIONS = ${MAX_QUESTIONS} in ask-user.mjs`,
  }),
  Object.freeze({
    id: 'stuck',
    question: 'What to do when STUCK?',
    keys: Object.freeze(['onStuck']),
    was: 'a fixed rule in turn.mjs: nudge once per loop, and hard-stop on a repeat only under --until-done',
  }),
]);

for (const q of FOUR_QUESTIONS) {
  for (const k of q.keys) {
    if (!CONFIG_KEYS[k]) throw new Error(`rcfile: FOUR_QUESTIONS names "${k}", which is not a config key`);
  }
}

/** ⭐ THE ONE SENTENCE, IN ONE PLACE. Printed by `acuvo config` and by nothing
 *  else that could disagree with it. */
export const PRECEDENCE_LINE = 'precedence: command-line flag  >  environment variable  >  ~/.acuvo/config.json  >  .acuvo/config.json (this repo)  >  built-in default';

/**
 * Resolve the four questions into printable rows: the value, and where it came
 * from. PURE — it reads only what `resolveConfig` already returned.
 *
 * @param {ReturnType<typeof resolveConfig>} resolved
 * @param {object} [options] the PARSED options, so a typed flag can show its VALUE
 * @returns {{ id: string, question: string, was: string, settings: Array }[]}
 */
export function resolveFourQuestions(resolved, options = null) {
  if (!resolved?.ok) return [];
  return FOUR_QUESTIONS.map((q) => ({
    id: q.id,
    question: q.question,
    was: q.was,
    settings: q.keys.map((name) => {
      const spec = CONFIG_KEYS[name];
      const origin = resolved.origins?.[name] ?? { layer: 'default', label: 'built-in default' };
      /**
       * ⚠️ THE FLAG'S VALUE COMES FROM `options`, NOT FROM `values` — and this
       * is the whole reason `options` is a parameter. `resolveConfig` is told
       * which keys were typed but never sees their values, so `values.budget`
       * still carries the FILE's number for a key the flag also set. Printing
       * that as the effective value would make the one command whose job is to
       * explain the precedence the one place it is stated wrongly.
       */
      const value = (origin.layer === 'flag' && options && spec.option && options[spec.option] !== undefined)
        ? options[spec.option]
        : resolved.values?.[name];
      return {
        key: name,
        flag: flagForKey(name),
        env: spec.env ?? [],
        value,
        display: describeValue(name, value),
        origin: origin.layer,
        source: origin.label,
        settableInRepo: spec.trust === 'any',
      };
    }),
  }));
}

/**
 * The block `acuvo config` prints. Returns lines, never writes — the caller
 * decides which stream, because stdout is the `--json` contract.
 */
export function describeFourQuestions(resolved, options = null) {
  const rows = resolveFourQuestions(resolved, options);
  if (!rows.length) return [];
  const lines = ['The four questions — what this run will do, and who decided it:', ''];
  for (const q of rows) {
    lines.push(`  ${q.question}`);
    for (const s of q.settings) {
      const how = [s.flag, ...s.env].filter(Boolean).join(' / ');
      lines.push(`    ${s.key.padEnd(13)} ${String(s.display).padEnd(12)} ← ${s.source}`);
      lines.push(`    ${''.padEnd(13)} ${''.padEnd(12)}   set with ${how}${s.settableInRepo ? '' : '  (your own config only — a repository may not set it)'}`);
    }
    lines.push('');
  }
  lines.push(PRECEDENCE_LINE);
  if (resolved.notes?.length) {
    lines.push('');
    for (const n of resolved.notes) lines.push(`  ⚠ ${n}`);
  }
  return lines;
}

/** Render a value the way its flag would be typed, for the notes. */
function describeValue(name, value) {
  if (value === null || value === undefined) return 'none';
  if (name === 'budget') return formatUsd(value);
  if (name === 'timeout' || name === 'commandTimeout') return `${value / 1000}s`;
  return String(value);
}

/**
 * Merge a resolved config into parsed CLI options. Never mutates its input, and
 * never touches a key the user typed — `resolveConfig` already removed those.
 */
export function applyConfig(options, resolved) {
  if (!resolved?.ok) return options;
  return { ...options, ...resolved.options };
}

/**
 * The lines to print when a config is in force.
 *
 * ⭐ Same argument as `describePolicy`: a setting nobody can see is
 * indistinguishable from a broken tool. Returns `[]` when nothing was
 * configured, so the ninety-nine users with no config file never see a line
 * about a feature they are not using.
 */
export function describeConfig(resolved) {
  if (!resolved?.ok) return [];
  const changed = Object.entries(resolved.options).filter(([k]) => k !== 'budgetExplicit');
  if (!changed.length && !resolved.notes.length) return [];
  const where = (resolved.sources ?? []).map((s) => `${s.label}${s.ignored ? ' (ignored)' : ''}`).join(' + ') || 'environment';
  return [
    `config from ${where}:`,
    ...changed.map(([k, v]) => `  · ${k} = ${v === null ? 'none' : v}`),
    ...resolved.notes.map((n) => `  ⚠ ${n}`),
  ];
}

// ── the disk ───────────────────────────────────────────────────────────────

/**
 * Turn a workspace root and an environment into the two texts `resolveConfig`
 * wants. The only function here that reads a file, and it takes its reader as an
 * argument so nothing above it needs one.
 *
 * ⚠️ ABSENT IS NOT MALFORMED — `policy.mjs:733`'s distinction, for the same
 * reason. A missing file is the common case and means "nothing said here"; an
 * unreadable-but-present file is a broken instruction and stops the run, because
 * a permissions error quietly meaning "no config" is how a ceiling disappears.
 *
 * @param {string} root
 * @param {{ env?: object, home?: string|null, readFileImpl?: (p:string)=>string, joinImpl?: (...p:string[])=>string }} deps
 */
export function readConfigSources(root, { env = {}, home = null, readFileImpl, joinImpl } = {}) {
  const join = joinImpl ?? ((...p) => p.join('/').replace(/\/+/g, '/'));
  const read = readFileImpl;
  if (typeof read !== 'function') return { ok: false, error: 'readConfigSources needs a reader' };

  const slurp = (abs) => {
    try {
      return { found: true, text: read(abs) };
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : null;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { found: false, text: null };
      return { found: true, text: null, error: `${abs}: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const override = String(env?.[CONFIG_FILE_ENV] ?? '').trim();
  const acuvoHome = String(env?.[ACUVO_HOME_ENV] ?? '').trim();
  const homeDir = acuvoHome || (home ? join(home, '.acuvo') : null);
  const homePath = override || (homeDir ? join(homeDir, HOME_CONFIG_FILE) : null);

  let homeText = null;
  if (homePath) {
    const r = slurp(homePath);
    if (r.error) return { ok: false, error: `your config could not be read — ${r.error}` };
    /**
     * ⚠️ AN EXPLICIT `ACUVO_CONFIG_FILE` POINTING AT NOTHING IS AN ERROR, while
     * an absent `~/.acuvo/config.json` is not — `policy.mjs:762`'s reasoning.
     * Somebody set that variable deliberately; a typo in it silently meaning
     * "no preferences" is the deployment accident worth refusing.
     */
    if (!r.found && override) return { ok: false, error: `${CONFIG_FILE_ENV} points at ${override}, which does not exist` };
    homeText = r.found ? r.text : null;
  }

  const wsPath = join(String(root ?? '.'), WORKSPACE_CONFIG_FILE);
  const w = slurp(wsPath);
  if (w.error) return { ok: false, error: `workspace config could not be read — ${w.error}` };

  return {
    ok: true,
    homeText,
    homeLabel: homePath ?? `~/.acuvo/${HOME_CONFIG_FILE}`,
    workspaceText: w.found ? w.text : null,
    workspaceLabel: WORKSPACE_CONFIG_FILE,
  };
}

/**
 * ── ⭐⭐ WHICH ENVIRONMENT VARIABLES CAME OUT OF THE REPOSITORY ──────────────
 *
 * The header's §3 in one function. `env-file.mjs` loads `.env.local` and `.env`
 * into `process.env` and WALKS UP past the workspace root, so only the files at
 * or under the root are the agent's to write — a `.env` two directories above a
 * monorepo package is outside its reach and stays trusted.
 *
 * ⚠️ NAMES ONLY. We never read a value here: the point is "could this variable
 * have been supplied by the repository", and reading secrets out of a `.env` to
 * answer that would be a worse cure than the disease.
 *
 * ⚠️ AND IT NEVER THROWS. An unreadable `.env` yields an empty set and the run
 * continues at full trust — the same trade `readAccount` makes. Refusing to
 * start because a file we do not own is unreadable fails correct work.
 *
 * @param {string} root
 * @param {{ candidatesImpl?: (from:string)=>string[], readImpl?: (p:string)=>string, resolveImpl?: (p:string)=>string }} deps
 * @returns {Set<string>}
 */
export function readWorkspaceEnvNames(root, { candidatesImpl, readImpl, resolveImpl = (p) => p } = {}) {
  const names = new Set();
  if (typeof candidatesImpl !== 'function' || typeof readImpl !== 'function') return names;

  let base;
  try { base = resolveImpl(String(root ?? '.')); } catch { return names; }

  let paths = [];
  try { paths = candidatesImpl(String(root ?? '.')) ?? []; } catch { return names; }

  for (const p of paths) {
    let abs;
    try { abs = resolveImpl(p); } catch { continue; }
    // Only files INSIDE the workspace are the agent's to write.
    if (!abs.startsWith(base)) continue;
    let text;
    try { text = readImpl(abs); } catch { continue; }
    for (const m of String(text).matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) {
      names.add(m[1]);
    }
  }
  return names;
}

/**
 * ── ⭐⭐ APPLY A RESOLVED CONFIG ONTO PARSED OPTIONS ─────────────────────────
 *
 * ⚠️⚠️ A KEY THE USER TYPED IS NEVER OVERWRITTEN, and that rule lives HERE
 * rather than in `resolveConfig`, because the resolver is told WHICH keys were
 * explicit but never sees their VALUES — so its `values` still carry the file's
 * number for a key the flag also set. Applying that blindly lets a config file
 * silently beat a flag the person just typed, which is the one behaviour a
 * config system must never have.
 *
 * ⭐ Extracted from `bin/acuvo.mjs` so the precedence rule is testable. Inline
 * in the binary it was reachable only by running the whole CLI, which is how a
 * rule this important ends up unverified.
 *
 * Mutates and returns `options` — the caller owns a freshly parsed object.
 */
export function applyConfigToOptions(options, values, typedKeys) {
  if (!options || !values) return options;
  const typed = typedKeys instanceof Set ? typedKeys : new Set(typedKeys ?? []);
  for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
    if (typed.has(key)) continue;
    const value = values[key];
    if (value === undefined || value === null) continue;
    options[spec.option] = value;
  }
  return options;
}
