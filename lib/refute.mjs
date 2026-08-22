/**
 * ── ⭐⭐ THE SECOND OPINION — VERIFICATION THAT COSTS WHAT THE WORK COSTS ─────
 *
 * Every coding agent grades its own homework. It writes the code, decides the
 * code is good, and reports success — and the failure mode this package has
 * documented more than any other is not bad code, it is a TRUE-LOOKING CLAIM
 * about code. Four separate probes in this repository's own history printed
 * `✔ VERIFIED` over work that was wrong, incomplete, or never run.
 *
 * `acceptance.mjs` fixed half of that: the criterion is now the USER's command,
 * decided before the work, and only that command exiting 0 satisfies it. What it
 * cannot see is everything the criterion does not cover — a fix that passes the
 * named test and breaks the caller, a function renamed in four places and used
 * in five, a test quietly weakened to make itself pass.
 *
 * ⭐ SO A SECOND AGENT IS ASKED TO BREAK THE CLAIM. Not to review it, not to
 * summarise it — to REFUTE it, with a fresh context and no sight of the first
 * agent's reasoning, because inheriting the reasoning inherits the blind spot
 * that produced it.
 *
 * ── ⭐⭐ AND THIS IS ONLY AFFORDABLE HERE ────────────────────────────────────
 *
 * A measured task on this stack costs $0.001–0.003. Doubling that to check the
 * answer is a rounding error. An agent priced at frontier rates cannot make
 * "verify everything, always" a default — it would double a bill somebody is
 * already unhappy about — so this is a capability that follows from the cost
 * base rather than from cleverness, and it is not one a competitor can simply
 * decide to copy.
 *
 * ── ⚠️ THE BURDEN OF PROOF IS ON THE REFUTER, DELIBERATELY ──────────────────
 *
 * An adversarial reviewer that defaults to "something is probably wrong" fails
 * correct work, which this package treats as worse than the bug it was hunting.
 * So uncertainty is NOT a refutation: the refuter must produce a concrete,
 * checkable reason — a command that fails, a caller that no longer resolves, a
 * requirement in the task that nothing addresses. Anything softer is recorded
 * as a doubt and changes no verdict.
 *
 * ⚠️ IT CANNOT WRITE. A refuter that fixes what it finds is no longer refuting,
 * and its "fix" would land unreviewed on top of work somebody was about to
 * inspect. Read and RUN only — running is essential, because the strongest
 * refutation is a command that fails.
 *
 * ── ⚠️⚠️ AND IT MAY NOT RUN BLIND. THE SIGNAL GATE (added after measurement) ─
 *
 * The version of this file that shipped first was a PURE self-critique pass: a
 * second model read the claim and decided, with no ground truth in front of it.
 * That shape is measured to make results WORSE — intrinsic self-correction went
 * down or flat in SIX settings out of six, and one benchmark lost 37.7 points in
 * a single round. Paying for a second agent to degrade the first one's answer is
 * the worst possible trade.
 *
 * ⭐ THE SAME MACHINERY WINS WHEN THE FEEDBACK IS REAL. Swapping a model's own
 * feedback for an external signal moved repaired-and-passing from 33.3% to
 * 52.6%, and one model's feedback handed to a weaker one beat BOTH models'
 * self-repair. Cross-model was already solved here (`chooseRefuteModel`); the
 * missing half was the signal.
 *
 * ⭐ SO THE RULE IS: AT LEAST ONE EXTERNAL SIGNAL, OR THE FIRST ANSWER SHIPS.
 * A compiler exit code, a test result, or a linter result — obtained either from
 * the builder's own run (free) or by running a DECLARED command before the
 * critique starts. No signal and none obtainable means no critique, no spend and
 * no change. Skipping is not a degradation here; it is the measured optimum.
 */

import { existsSync, appendFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { REFUTER_TOOL_NAMES } from './refute-tools.mjs';
import { deriveAcceptance, loadAcceptance } from './acceptance.mjs';

/** Enough to look, run something, and look again. Not enough to go exploring. */
export const DEFAULT_REFUTE_ROUNDS = 4;
export const MAX_REFUTE_ROUNDS = 8;

/**
 * ── ⚠️⚠️ THE SECOND OPINION WAS THE SAME BRAIN ─────────────────────────────
 *
 * `refuteClaim` passed the caller's `config` straight through, so the reviewer
 * ran on THE SAME MODEL that produced the claim. That is not a second opinion;
 * it is the same opinion asked twice. A model's mistakes are not random noise —
 * they come from its training, and a second sample from the same distribution
 * reproduces them. The one case a reviewer exists for, a blind spot, is exactly
 * the case where an identical reviewer is guaranteed to share it.
 *
 * ⭐ SO THE RULE IS FAMILY DIVERSITY, NOT A HARDCODED ID. Hardcoding one model
 * would be wrong the moment somebody sets `--model` to that same one — the
 * check would silently become self-review again, which is the defect wearing a
 * constant. The rule is "not the family that wrote the claim", so it stays true
 * whatever the builder is set to.
 *
 * ⚠️ AND WHEN NO INDEPENDENT MODEL IS AVAILABLE IT SAYS SO RATHER THAN
 * PRETENDING. A same-family refutation is still worth something — a fresh
 * context with an adversarial prompt catches real mistakes — but it is WEAKER
 * EVIDENCE, and a summary that presents both as "✔ could not refute it" is
 * exactly the kind of quiet overclaim this package keeps finding in itself.
 *
 * ⭐ THE CANDIDATES ARE THE ONES THIS PACKAGE ALREADY TRUSTS: `buildChain`'s
 * default fallbacks are `deepseek-chat`, `z-ai/glm-4.6` and `qwen3.7-flash`, so
 * every id here is one the CLI already falls back to in production. Nothing new
 * is being adopted on a hunch.
 */
export const REFUTE_MODEL_ENV = 'ACUVO_REFUTE_MODEL';

/**
 * ── ⭐⭐ THIS ORDER IS MEASURED, AND MY REASONING WAS WRONG ──────────────────
 *
 * I first put `z-ai/glm-4.6` at the front, arguing it is the strongest coder of
 * the three and the reviewer's job is the harder half. That was a guess, and an
 * A/B on identical correct work overturned it — all three asked to refute the
 * same true claim, so the right answer was NOT REFUTED:
 *
 *   z-ai/glm-4.6        no verdict (3 of 3 runs)   $0.004348
 *   deepseek-v4-flash   NOT REFUTED ✔              $0.000909   ← same brain
 *   qwen/qwen3.7-flash  NOT REFUTED ✔              $0.000486
 *
 * ⚠️ GLM NEVER PRODUCED A PARSEABLE VERDICT. `parseRefuteVerdict` needs the last
 * line to be `REFUTED:` or `NOT REFUTED:`; GLM ended three of three runs some
 * other way, so its answer decided nothing while costing nine times the winner.
 * A reviewer that cannot deliver a verdict is not a reviewer, however good its
 * reading is — and "strongest coder" was never the relevant question.
 *
 * ⭐ SO QWEN LEADS: it is INDEPENDENT of the DeepSeek builder, it obeys the
 * format, and at $0.000486 it is 47% CHEAPER than the same-brain reviewer it
 * replaces. Independence stopped being a cost and became a discount.
 *
 * ⚠️ GLM IS KEPT, NOT DELETED. Three runs on one task is not grounds to retire
 * a model — only to stop making it the default. It stays as the fallback for a
 * qwen-family builder, where something must review it.
 */
export const REFUTE_CANDIDATES = Object.freeze(['qwen/qwen3.7-flash', 'z-ai/glm-4.6', 'deepseek/deepseek-chat']);

/**
 * The vendor prefix — `deepseek/deepseek-v4-pro-0813` → `deepseek`.
 *
 * ⚠️ FAMILY, NOT MODEL ID. `deepseek-v4-flash` and `deepseek-v4-pro` are
 * different models that share a lineage, so pro reviewing flash is a weaker
 * check than it looks. Comparing ids would have called that independent.
 */
export function familyOf(modelId) {
  const text = String(modelId ?? '').trim().toLowerCase();
  if (!text) return '';
  const slash = text.indexOf('/');
  return slash === -1 ? text : text.slice(0, slash);
}

/**
 * Choose the model that reviews a claim.
 *
 * @param {string} builderModel the model that produced the claim
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ model: string, independent: boolean, why: string }}
 */
export function chooseRefuteModel(builderModel, env = process.env) {
  const builder = String(builderModel ?? '').trim();
  const builderFamily = familyOf(builder);

  /**
   * ⚠️ AN EXPLICIT OVERRIDE WINS, INCLUDING A DELIBERATELY SAME-FAMILY ONE —
   * but it is still reported honestly. Someone pinning both to one model has a
   * reason; they should not also get a stronger-sounding verdict for it.
   */
  const chosen = String(env?.[REFUTE_MODEL_ENV] ?? '').trim();
  if (chosen) {
    const independent = familyOf(chosen) !== builderFamily;
    return {
      model: chosen,
      independent,
      why: independent
        ? `${REFUTE_MODEL_ENV} names ${chosen}, a different family from the builder's ${builderFamily || 'model'}`
        : `${REFUTE_MODEL_ENV} names ${chosen}, which is the same family as the builder — the review is not independent`,
    };
  }

  const other = REFUTE_CANDIDATES.find((m) => familyOf(m) !== builderFamily && m !== builder);
  if (other) {
    return { model: other, independent: true, why: `reviewed by ${other}, a different family from the builder's ${builderFamily}` };
  }
  return {
    model: builder,
    independent: false,
    why: `no reviewer from a family other than ${builderFamily} is configured, so the claim is being checked by its own author — a weaker check`,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE EXTERNAL SIGNAL — the thing that decides whether a critique may happen
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⭐ THE FOUR KINDS THAT COUNT, AND WHY `program` IS NOT ONE OF THEM.
 *
 * The gate is "a compiler exit code, a test result, or a linter result" — a
 * build is admitted alongside them because it IS a compiler exit code wearing an
 * npm script's name. `node server.mjs` exiting 0 is an external fact and still
 * not a check: it says a process started, not that the work is right. Admitting
 * it would let the gate be satisfied by anything the command allowlist happens
 * to permit, which is the gate not existing.
 */
export const SIGNAL_KINDS = Object.freeze(['test', 'typecheck', 'lint', 'build']);

/**
 * ⚠️ TWO, NOT "ALL OF THEM". Every candidate is a real process with real
 * wall-clock time, spent BEFORE the user sees any second opinion at all. A gate
 * that quietly turns into a four-command build is a gate people switch off.
 */
export const MAX_SIGNAL_CANDIDATES = 2;

/** Where the durable record of every pass goes. One line, appended. */
export const REFUTE_LOG_FILE = join('.acuvo', 'refute-log.jsonl');

/** ⚠️ Bounded, because a log nobody rotates is a disk leak wearing a feature's
 *  name. 512KB is ~4,000 passes, far more than anyone will measure at once. */
export const REFUTE_LOG_MAX_BYTES = 512 * 1024;

/**
 * What kind of check is this command, if any?
 *
 * ⚠️ ORDER MATTERS AND IS NOT ALPHABETICAL. `npm run test:types` is a test run
 * whatever else its name contains, and `npx tsc --noEmit` is a typecheck even
 * though `tsc` also builds — so the more specific intent is matched first and
 * `build` is the residual. Getting this backwards would file the project's whole
 * test suite under "build" and change nothing visible until someone read a
 * measurement that was wrong.
 */
export function classifySignal(command) {
  const c = String(command ?? '').trim().toLowerCase();
  if (!c) return null;
  if (/(^|\s)(node\s+--test|jest|vitest|mocha|ava|tap)(\s|$)/.test(c)) return 'test';
  if (/(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(c)) return 'test';
  if (/\btest\b/.test(c) && /(^|\s)(npm|pnpm|yarn|bun|npx)\b/.test(c)) return 'test';
  if (/(^|\s)tsc(\s|$)|--noemit|\btypecheck\b|\btype-check\b/.test(c)) return 'typecheck';
  if (/\beslint\b|\bbiome\b|\bruff\b|\blint\b/.test(c)) return 'lint';
  if (/\bbuild\b|\bcompile\b/.test(c)) return 'build';
  return 'program';
}

/** The command a tool record actually ran, mirroring `acceptance.mjs` so the two
 *  can never disagree about what "the command" was. */
function commandOfRecord(record) {
  const fromResult = record?.result?.command;
  if (typeof fromResult === 'string' && fromResult.trim()) return fromResult.trim();
  const fromArgs = record?.args?.command;
  if (typeof fromArgs === 'string' && fromArgs.trim()) return fromArgs.trim();
  return null;
}

/**
 * Signals the BUILDER already paid for. Free evidence — the run is over, the
 * exit codes are recorded, and re-running them would buy nothing but latency.
 *
 * ⚠️ ONLY REAL EXECUTIONS. `result.ok !== true` is a REFUSAL, not a run, and an
 * `evaluate` record is the model's own sandbox — three of the four false-✔
 * probes in this package's history "passed" on exactly that. Counting either
 * would let the gate be satisfied by something that never checked anything.
 *
 * ⭐ RED SORTS FIRST. A failing check is the informative one: handing the critic
 * a green lint while the tests are red is how a grounded review still misses the
 * only fact that mattered.
 *
 * PURE.
 */
export function signalsInHand(executed) {
  const records = Array.isArray(executed) ? executed : [];
  const out = [];
  for (const r of records) {
    if (r?.name !== 'run_command' && r?.name !== 'run_program') continue;
    if (r?.result?.ok !== true) continue;
    const exitCode = r.result.exitCode;
    if (!Number.isInteger(exitCode)) continue;
    const command = commandOfRecord(r);
    if (!command) continue;
    const kind = classifySignal(command);
    if (!SIGNAL_KINDS.includes(kind)) continue;
    // ⚠️ A TIMED-OUT COMMAND DID NOT PASS whatever exit code the killer left
    // behind — the same rule `checkAcceptance` applies, so the two cannot drift.
    out.push({ kind, command, exitCode, passed: exitCode === 0 && r.result.timedOut !== true, source: 'builder-run' });
  }
  // Stable: reds keep their relative order, then greens keep theirs.
  return [...out.filter((s) => !s.passed), ...out.filter((s) => s.passed)];
}

/**
 * The commands we are willing to RUN to obtain a signal.
 *
 * ⚠️ IT NEVER INVENTS ONE. Either the run declared a criterion, or the user's
 * own task text named a command — `deriveAcceptance` is the same pure extractor
 * acceptance uses, and it is documented to return nothing rather than guess
 * `npm test` from "run the tests". An invented command runs somebody else's
 * script on their machine to satisfy a gate they did not ask for.
 *
 * PURE.
 */
export function signalCandidates({ task, acceptance = null } = {}) {
  const seen = new Set();
  const out = [];
  const take = (command) => {
    const c = String(command ?? '').trim();
    if (!c || seen.has(c)) return;
    if (!SIGNAL_KINDS.includes(classifySignal(c))) return;
    seen.add(c);
    out.push(c);
  };

  for (const c of Array.isArray(acceptance) ? acceptance : []) {
    if (typeof c === 'string') { take(c); continue; }
    if (c && typeof c === 'object' && c.runnable !== false) take(c.command);
  }
  for (const c of deriveAcceptance(task, { source: 'user' })) take(c.command);
  return out;
}

/**
 * Get one external signal, or say why there is none.
 *
 * @param {object} args
 * @param {string} args.task
 * @param {object} args.executor       needs `.root` and `.dryRun`
 * @param {any[]} [args.executed]      the builder's own tool records
 * @param {unknown[]|null} [args.acceptance] declared criteria; read from disk when absent
 * @param {(command:string)=>Promise<any>} [args.runner] the `checkAcceptance` runner contract
 * @param {number} [args.commandTimeoutMs]
 * @returns {Promise<{signal: object|null, reason: string|null, tried: string[]}>}
 */
export async function acquireExternalSignal({
  task, executor, executed = [], acceptance = null, runner = null, commandTimeoutMs,
} = {}) {
  const inHand = signalsInHand(executed);
  if (inHand.length > 0) return { signal: inHand[0], reason: null, tried: [] };

  let declared = acceptance;
  if (!Array.isArray(declared)) {
    // ⚠️ A corrupt acceptance file is NOT "nothing was declared" — but it is
    // also not worth failing a run over here, so it degrades to no candidates
    // and the honest "no signal" message rather than to a blind critique.
    const loaded = executor?.root ? loadAcceptance(executor.root) : { ok: true, criteria: [] };
    declared = loaded.ok ? (loaded.criteria ?? []) : [];
  }

  const candidates = signalCandidates({ task, acceptance: declared });
  if (candidates.length === 0) {
    return {
      signal: null,
      tried: [],
      reason: 'no test, typecheck or lint command is declared for this run or named in the task, so there is nothing to check the claim against',
    };
  }

  /**
   * ⚠️ A DRY RUN CANNOT OBTAIN ONE, and must not pretend otherwise. `--dry-run`
   * promises the disk is untouched and a command is free to write, so the
   * refusal belongs here rather than deep inside the runner where the reason
   * would arrive as an opaque error.
   */
  if (executor?.dryRun === true) {
    return { signal: null, tried: [], reason: 'this is a --dry-run, so no command can be executed and no external signal can be obtained' };
  }

  /**
   * ⭐ THE SAME GATE `run_command` GOES THROUGH — allowlist, no shell, scrubbed
   * environment, bounded timeout. This module does not spawn anything itself,
   * for the same reason `checkAcceptance` does not: two spawners means two sets
   * of rules and only one of them gets audited. The runner is injectable so the
   * unit tests never start a process.
   */
  const run = runner ?? (async (command) => {
    const { executeRunCommand } = await import('./command.mjs');
    return executeRunCommand({ command, executor, ...(Number.isFinite(commandTimeoutMs) ? { timeoutMs: commandTimeoutMs } : {}) });
  });

  const tried = [];
  for (const command of candidates.slice(0, MAX_SIGNAL_CANDIDATES)) {
    tried.push(command);
    let result;
    try {
      result = await run(command);
    } catch (err) {
      // A runner that throws is a wiring fault, not a failing check — blaming
      // the user's code for it would be the "check that fails correct work" trap.
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result?.ok !== true || !Number.isInteger(result.exitCode)) continue;
    return {
      signal: {
        kind: classifySignal(command),
        command,
        exitCode: result.exitCode,
        passed: result.exitCode === 0 && result.timedOut !== true,
        source: 'refuter-acquired',
      },
      reason: null,
      tried,
    };
  }

  return {
    signal: null,
    tried,
    reason: `no external signal could be obtained — ${tried.map((c) => `\`${c}\``).join(', ')} could not be run here`,
  };
}

/** The one sentence the critic and the human both read. */
export function formatSignal(signal) {
  if (!signal) return 'none';
  const who = signal.source === 'builder-run' ? 'run by the agent during the work' : 'run again just now, on the workspace as it stands';
  return `\`${signal.command}\` exited ${signal.exitCode} (${signal.kind}, ${who})`;
}

/**
 * The whole prompt. Written out rather than assembled, because the exact framing
 * is the mechanism: "find what is wrong" produces invented findings, and "check
 * the work" produces agreement.
 *
 * ⭐ AND THE SIGNAL IS IN IT. That is the difference between the measured-worse
 * shape (a model critiquing from its own reading) and the measured-better one
 * (a model reasoning from real feedback). Obtaining the signal and not showing
 * it to the critic would be paying for both halves and using neither.
 */
export function refutePrompt({ task, claim, signal = null }) {
  return [
    'You are the SECOND opinion on work another agent has just finished. You did not do it and you have not seen how it was done.',
    '',
    'THE TASK IT WAS GIVEN:',
    task,
    '',
    'WHAT IT CLAIMS IT DID:',
    claim || '(it made no claim)',
    '',
    ...(signal ? [
      'THE EXTERNAL SIGNAL THAT HAS ALREADY BEEN OBTAINED — this is ground truth, not an opinion:',
      `  ${formatSignal(signal)}`,
      '',
      'START FROM THAT FACT. It is the only thing in this prompt that was not written by a model.',
      signal.passed
        ? 'It passed, so a refutation has to explain what that command does not cover — not merely doubt it.'
        : 'It did NOT pass, so begin by finding out whether that failure is what the task asked to be fixed.',
      '',
    ] : []),
    'YOUR JOB IS TO REFUTE THAT CLAIM, not to review it and not to improve it.',
    'Look at the workspace as it is now. Run the tests. Run the thing. Grep for the callers.',
    'You are trying to find a SPECIFIC, CHECKABLE reason the claim is false — for example:',
    '  · a command that fails when the claim says it passes',
    '  · a caller, import or reference that no longer resolves',
    '  · a requirement stated in the task that nothing in the workspace addresses',
    '  · a test that was changed to make itself pass rather than the code fixed',
    '',
    '⚠️ YOU MAY NOT WRITE, EDIT OR DELETE ANYTHING. You have no tools that can.',
    '',
    '⚠️ UNCERTAINTY IS NOT A REFUTATION. "This could be fragile", "there may be edge cases",',
    '"I would have done it differently" — none of those are refutations, and reporting them as',
    'though they were will fail work that is correct, which is worse than missing a bug.',
    'If you cannot find a concrete reason the claim is false, say so plainly.',
    '',
    'Finish with exactly one of these two lines, on its own line, as the last line of your reply:',
    '  REFUTED: <the specific reason, and the evidence you got it from>',
    '  NOT REFUTED: <what you checked>',
  ].join('\n');
}

/**
 * ⚠️ PARSED FROM THE LAST LINE, AND ONLY THE LAST LINE. A model discussing the
 * word "REFUTED" mid-answer ("I could not find anything that would be REFUTED
 * by the tests") must not flip a verdict. Anchoring to the final line makes the
 * verdict a thing it has to DECIDE rather than a word it happens to use.
 *
 * ⚠️ AND AN UNPARSEABLE REPLY IS **NOT REFUTED**, not an error. The burden is on
 * the refuter; a second opinion that could not express itself has not made a
 * case, and failing the run on that would be the "check that fails correct
 * work" trap wearing a new hat.
 */
export function parseRefuteVerdict(text) {
  const lines = String(text ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (/^REFUTED\s*:/i.test(last)) {
    const reason = last.replace(/^REFUTED\s*:\s*/i, '').trim();
    // A refutation with no reason is an assertion, and an assertion is not evidence.
    if (reason.length < 12) return { refuted: false, reason: '', unclear: true, note: `the refuter answered "${last}" with no reason, so nothing was proven` };
    return { refuted: true, reason };
  }
  if (/^NOT\s+REFUTED\s*:/i.test(last)) {
    return { refuted: false, reason: last.replace(/^NOT\s+REFUTED\s*:\s*/i, '').trim() };
  }
  return { refuted: false, reason: '', unclear: true, note: 'the refuter did not end with a verdict line, so its answer decides nothing' };
}

/**
 * Run the second opinion.
 *
 * @param {object} args
 * @param {string} args.task     what the first agent was asked to do
 * @param {string} args.claim    what it says it did
 * @param {object} args.executor
 * @param {object} args.config
 * @param {number} [args.budgetUsd]  the refuter's ceiling — normally the parent's remainder
 * @param {any[]} [args.executed] the BUILDER's tool records — free external signal
 * @param {unknown[]|null} [args.acceptance] declared criteria; read from disk when absent
 * @param {Function} [args.runner] command runner, `checkAcceptance`'s contract
 * @param {Function} [args.sessionImpl] injected for tests
 */
export async function refuteClaim({
  task, claim, executor, config, budgetUsd = null, fleetGate = null,
  maxRounds = DEFAULT_REFUTE_ROUNDS, commandTimeoutMs, onEvent, sessionImpl = null,
  executed = [], acceptance = null, runner = null,
  env = process.env,
} = {}) {
  if (!task || !String(task).trim()) {
    return { ok: false, error: 'a second opinion needs the original task — without it there is no claim to test' };
  }

  /**
   * ── ⚠️⚠️ THE GATE, AND IT COMES FIRST — BEFORE ANY SPEND ──────────────────
   *
   * A critique with no external signal is measured to make answers WORSE (down
   * or flat in six settings of six; −37.7 points on one benchmark in a single
   * round). So the order is: get ground truth, THEN critique. If ground truth is
   * not obtainable, the first answer ships untouched and this costs nothing —
   * which is strictly better than paying a second model to guess.
   */
  const acquired = await acquireExternalSignal({ task, executor, executed, acceptance, runner, commandTimeoutMs });
  const signal = acquired.signal;
  if (!signal) {
    const record = {
      ok: true, ran: false, skipped: true, refuted: false, unclear: false,
      hadSignal: false, changedAnswer: false, signal: null,
      reason: acquired.reason ?? 'no external signal could be obtained',
      costUsd: 0, roundsUsed: 0,
      reviewerModel: null, independent: null,
    };
    logRefutation(executor, record);
    return record;
  }

  const run = sessionImpl ?? (await import('./turn.mjs')).runSession;
  /**
   * ⭐ THE REVIEWER'S OWN MODEL. `config` used to go through untouched, which
   * made the second opinion the same brain as the first — see
   * `chooseRefuteModel`. The builder's config is spread so every other
   * setting (key, gateway url, timeouts) is unchanged; only the model moves.
   */
  const reviewer = chooseRefuteModel(config?.model, env);
  const reviewerConfig = { ...config, model: reviewer.model };
  const rounds = Math.min(Math.max(1, Math.floor(maxRounds) || DEFAULT_REFUTE_ROUNDS), MAX_REFUTE_ROUNDS);

  let outcome;
  try {
    outcome = await run({
      task: refutePrompt({ task, claim, signal }),
      executor,
      config: reviewerConfig,
      maxRounds: rounds,
      /**
       * ⚠️ `allowRun` TRUE, and it is the point. The strongest refutation
       * available is a command that fails, and a reviewer that can only read is
       * reduced to opinion — which this prompt explicitly refuses to accept.
       */
      allowRun: true,
      toolNames: [...REFUTER_TOOL_NAMES],
      budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : null,
      fleetGate,
      commandTimeoutMs,
      onEvent,
    });
  } catch (err) {
    // ⚠️ A dead refuter must not fail work that may be perfectly good.
    const dead = { ok: false, ran: true, error: `the second opinion crashed: ${err?.message ?? String(err)}`, costUsd: 0, reviewerModel: reviewer.model, independent: reviewer.independent, hadSignal: true, signal, changedAnswer: false };
    // ⚠️ A CRASH IS A DATA POINT TOO. Left unlogged, the measurement would read
    // "grounded passes always produce a verdict" because the ones that did not
    // were the only rows missing — the survivorship error, in our own numbers.
    logRefutation(executor, dead);
    return dead;
  }

  const usage = outcome?.usage ?? null;
  const costUsd = Number.isFinite(usage?.cost) ? usage.cost : 0;
  if (!outcome || outcome.ok !== true) {
    const empty = { ok: false, ran: true, error: outcome?.error ?? 'the second opinion returned nothing', costUsd, reviewerModel: reviewer.model, independent: reviewer.independent, hadSignal: true, signal, changedAnswer: false };
    logRefutation(executor, empty);
    return empty;
  }

  const verdict = parseRefuteVerdict(outcome.content ?? outcome.note ?? '');
  /**
   * ── ⭐⭐ THE INSTRUMENTATION, AND WHAT `changedAnswer` ACTUALLY MEANS ───────
   *
   * The CLI flips the exit code on ONE outcome and one only: a concrete
   * refutation. A clearance and an unparseable reply both leave the first
   * verdict exactly as it was — so those cost money and changed nothing, and a
   * measurement that counted them as "the refuter did something" would make a
   * useless pass look busy. `changedAnswer` is therefore literally "did this
   * pass alter what the user is about to act on".
   *
   * ⭐ Paired with `hadSignal` it answers the question this feature has to earn
   * its keep on: does a grounded refutation change answers more often than a
   * blind one? Today `hadSignal` is always true when `ran` is true — the gate
   * guarantees it — so the comparison the log supports is grounded-vs-skipped,
   * and the skipped rows carry the reason they were skipped.
   */
  const result = {
    ok: true, ran: true, ...verdict, costUsd, roundsUsed: outcome.roundsUsed ?? 0,
    reviewerModel: reviewer.model, independent: reviewer.independent, reviewerWhy: reviewer.why,
    hadSignal: true, signal, changedAnswer: verdict.refuted === true,
  };
  logRefutation(executor, result);
  return result;
}

/**
 * ── ⭐ ONE JSON LINE PER PASS, SO SOMEBODY CAN ACTUALLY MEASURE THIS ─────────
 *
 * The whole reason this gate exists is a measurement somebody else took. The
 * next person deserves one of ours: how often a pass had a signal, how often it
 * changed the answer, what kind of check it was grounded in, and what it cost.
 *
 * ⚠️ IT MUST NEVER BREAK A RUN. A log that can fail the work it observes is a
 * worse defect than the one it was added to study, so every failure here is
 * swallowed and reported in the return value rather than thrown.
 *
 * @returns {{ok: boolean, path: string|null, reason?: string}}
 */
export function recordRefutation(root, record, { file = REFUTE_LOG_FILE, maxBytes = REFUTE_LOG_MAX_BYTES } = {}) {
  if (typeof root !== 'string' || !root.trim()) return { ok: false, path: null, reason: 'no workspace root' };
  const path = join(root, file);
  try {
    if (existsSync(path) && statSync(path).size >= maxBytes) {
      return { ok: false, path, reason: `${file} has reached ${maxBytes} bytes — delete it to keep recording` };
    }
    mkdirSync(join(root, '.acuvo'), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { encoding: 'utf8', flag: 'a' });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, path, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Kept separate so the import stays static at the top and this file has one
 *  place that knows the record's shape. */
function logRefutation(executor, result) {
  const root = executor?.root;
  if (typeof root !== 'string' || !root.trim() || !existsSync(root)) return;
  recordRefutation(root, {
    hadSignal: result.hadSignal === true,
    changedAnswer: result.changedAnswer === true,
    ran: result.ran === true,
    refuted: result.refuted === true,
    unclear: result.unclear === true,
    signalKind: result.signal?.kind ?? null,
    signalSource: result.signal?.source ?? null,
    exitCode: result.signal?.exitCode ?? null,
    reviewerModel: result.reviewerModel ?? null,
    independent: result.independent ?? null,
    costUsd: typeof result.costUsd === 'number' ? result.costUsd : null,
    reason: result.reason ?? result.note ?? null,
  });
}

/** One line for the person watching, and it must not overclaim either way. */
export function formatRefutation(result) {
  if (!result?.ok) return `second opinion unavailable: ${result?.error ?? 'unknown'}`;
  /**
   * ── ⭐ THE SKIP LINE, AND IT IS DELIBERATELY NOT A ✔ ───────────────────────
   *
   * "No second opinion" is what the user gets when no external signal was
   * obtainable, and it must read as an absence rather than a pass — a blind
   * critique is measured to make answers worse, so declining is the right
   * outcome and still not clearance. The reason is printed in full because it is
   * also the instruction: declare a command and the check becomes available.
   */
  if (result.skipped === true || result.ran === false) {
    return `· no second opinion: ${result.reason ?? 'no external signal could be obtained'}. The first answer ships unchanged.`;
  }
  if (result.refuted) return `✖ SECOND OPINION REFUTES IT — ${result.reason}`;
  if (result.unclear) return `· second opinion reached no verdict — ${result.note}. The first verdict stands unchanged.`;
  /**
   * ⚠️ THE ONE LINE THAT COULD OVERCLAIM. `✔ could not refute it` reads as
   * clearance; from the model that wrote the claim it is barely a check at
   * all. The weaker case says so in the same breath.
   *
   * ⭐ AND IT NAMES THE SIGNAL. "Could not refute it" is worth what the evidence
   * under it is worth; a reader who cannot see whether that was `npm test` or
   * nothing at all is being asked to trust a number they cannot check.
   */
  const who = result.independent === false ? ' (same model as the builder — a weaker check)' : '';
  const grounded = result.signal ? ` — grounded in ${formatSignal(result.signal)}` : '';
  return `✔ second opinion could not refute it${who}${grounded}${result.reason ? ` — checked: ${result.reason}` : ''}`;
}

/**
 * ── ⭐⭐ WHAT THE MACHINE-READABLE DOCUMENT SAYS ABOUT THE SECOND OPINION ────
 *
 * `--json --refute` used to accept the flag, charge nothing, run no refutation,
 * and leave NO field to say it had been skipped — because `secondOpinion` was
 * called thirty lines below the `--json` early return. That is the exact
 * combination CI uses: `--json` to parse, `--refute` for the trust gate. The one
 * mode where nobody watches the terminal was the one that silently dropped the
 * check, and a script acted on the unchecked claim.
 *
 * ⭐ THREE STATES, KEPT APART. Collapsing any two lets a consumer read a SKIPPED
 * check as a PASSED one, which is the original defect moved one layer down:
 *
 *   {asked:false, ran:false}   `--refute` was never passed
 *   {asked:true,  ran:false}   passed, but the run had already failed, so there
 *                              was no success to refute — with the reason
 *   {asked:true,  ran:true}    it ran, and this is what it found
 *
 * ⚠️ `unclear` IS ITS OWN STATE AND MUST NOT BE FLATTENED. The refuter answered
 * without a parseable verdict — measured at roughly one run in three — which is
 * NOT "could not refute it". A gate that treats silence as clearance is the
 * failure this whole feature exists to prevent.
 *
 * ⚠️ `refuted` IS ONLY MEANINGFUL WHEN `ok` IS TRUE. A crashed refuter carries
 * its own `ok:false` rather than being flattened into a boolean that reads as a
 * clean bill of health.
 *
 * ⭐ `costUsd` TRAVELS because the refuter is a SECOND full agent run whose
 * spend is not in the audit ledger — so a run's true cost is `costUsd +
 * refutation.costUsd`. Emitting it does not close that gap; it makes it visible.
 *
 * @param {boolean} asked did the user pass --refute
 * @param {object|null} opinion the result of `refuteClaim`, or null if it did not run
 * @param {boolean} alreadyFailed was the run already failing before the refuter
 * @returns {object} the `refutation` field of the --json document
 */
export function refutationField(asked, opinion, alreadyFailed = false) {
  if (!asked) return { asked: false, ran: false };
  if (!opinion) {
    return {
      asked: true,
      ran: false,
      reason: alreadyFailed
        ? 'the run had already failed, so there was no success to refute'
        : 'the refuter did not run',
    };
  }
  /**
   * ── ⚠️⚠️ THE FOURTH REASON IT DID NOT RUN, AND IT IS STILL `ran: false` ────
   *
   * The signal gate declines a pass that had no compiler, test or lint result to
   * reason from. That is `{asked:true, ran:false}` — the SAME state as "the run
   * had already failed", because from a consumer's point of view they are the
   * same fact: nothing checked this claim. Emitting `refuted:false` here instead
   * would be the original `--json --refute` defect exactly, one door along: a
   * gate reading a check that never happened as a check that passed.
   *
   * ⭐ `hadSignal` TRAVELS ON BOTH STATES so a CI gate can tell "declined for
   * want of evidence" from "declined because the run was already red", and can
   * decide for itself whether to insist on a grounded check.
   */
  if (opinion.skipped === true) {
    return {
      asked: true,
      ran: false,
      hadSignal: false,
      reason: opinion.reason ?? 'no external signal could be obtained, so the claim was not critiqued blind',
    };
  }
  return {
    asked: true,
    ran: true,
    ok: opinion.ok === true,
    refuted: opinion.refuted === true,
    unclear: opinion.unclear === true,
    reason: opinion.reason || opinion.note || opinion.error || null,
    costUsd: typeof opinion.costUsd === 'number' ? opinion.costUsd : null,
    roundsUsed: typeof opinion.roundsUsed === 'number' ? opinion.roundsUsed : null,
    /**
     * ── ⚠️⚠️ WHO CHECKED IT, AND WAS IT ACTUALLY A SECOND OPINION ────────────
     *
     * `refuteClaim` computed both of these and this function dropped them, so
     * the machine-readable document said a check had happened and never said by
     * whom. That is the same defect the header of this file is about, one layer
     * down: `--json --refute` is the CI shape, and a gate cannot weigh evidence
     * whose independence it cannot see.
     *
     * ⚠️ CAUGHT BY RUNNING IT, not by reading it. The fields existed, were
     * returned, and stopped at the last line before they became visible — which
     * is this package's most-repeated failure and I reproduced it inside the
     * commit that adds the feature.
     */
    reviewerModel: typeof opinion.reviewerModel === 'string' ? opinion.reviewerModel : null,
    independent: typeof opinion.independent === 'boolean' ? opinion.independent : null,
    /**
     * ── ⭐⭐ WHAT THE CRITIQUE WAS GROUNDED IN, AND WHETHER IT MATTERED ───────
     *
     * A refutation reasoned from a real exit code and one reasoned from a
     * model's own reading are different quality of evidence, and the measured
     * gap between them is the reason the gate exists (33.3% → 52.6% when the
     * feedback became real). A CI gate that cannot see which it got is being
     * asked to weigh evidence blind.
     *
     * `changedAnswer` is the number that makes this feature auditable: a pass
     * that never changes an answer is a pass to switch off.
     */
    hadSignal: typeof opinion.hadSignal === 'boolean' ? opinion.hadSignal : null,
    changedAnswer: typeof opinion.changedAnswer === 'boolean' ? opinion.changedAnswer : null,
    signal: opinion.signal
      ? {
        kind: opinion.signal.kind ?? null,
        command: opinion.signal.command ?? null,
        exitCode: Number.isInteger(opinion.signal.exitCode) ? opinion.signal.exitCode : null,
        passed: opinion.signal.passed === true,
        source: opinion.signal.source ?? null,
      }
      : null,
  };
}
