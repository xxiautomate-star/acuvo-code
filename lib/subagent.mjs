/**
 * ── ⭐⭐ SUBAGENTS — DELEGATION, AND THE CHEAPEST CONTEXT THERE IS ───────────
 *
 * The main loop can now say "go and find where this is defined across 400
 * files" and get back two hundred tokens instead of fifty thousand.
 *
 * ⚠️ THIS IS NOT `--parallel`. That runs N unrelated tasks a HUMAN typed, in
 * separate workspaces, with collision detection between them. This is one task
 * asking for help mid-thought, and the help happens in its own head.
 *
 * ── ⭐ WHY IT IS A MARGIN FEATURE AS WELL AS A CONTEXT ONE ──────────────────
 * Measured 2026-08-11: DeepSeek caches prompt prefixes automatically and a hit
 * costs up to 50x less — but ONLY while the prefix repeats byte-for-byte from
 * token 0. Every noisy search a parent performs itself lands in the parent's
 * message array and pushes the useful part further from the cached head. A
 * subagent's exploration never touches that array at all, so the expensive
 * cached prefix survives work that would otherwise pollute it.
 *
 * ⭐ Context hygiene and cost are the same lever, and almost nobody treats them
 * that way.
 *
 * ── ⚠️ THE FOUR RULES, AND THE FAILURE EACH ONE PREVENTS ───────────────────
 *
 * 1. ⚠️⚠️ READ-ONLY **BY DEFAULT**, AND LOCKED TWICE. A subagent that writes
 *    can collide with the parent editing the same file, and whoever finishes
 *    second wins silently. `parallel.mjs` exists to catch exactly that between
 *    processes and is blind to it here, because these run INSIDE one session.
 *    So the offer excludes every mutating verb AND `allowRun: false` is passed,
 *    because a model can emit a call for a tool it was never shown — the same
 *    belt-and-braces `check_acceptance` already uses.
 *
 *    ── ⭐⭐ AND THAT BLOCKER IS NOW SOLVED — `write: true` ───────────────────
 *    Read the rule again: the reason is TECHNICAL ("blind to it here"), not
 *    moral. `lib/handoff.mjs` removes the blindness — a writing helper works in
 *    an isolated COPY of the workspace (so it cannot race anybody), and its
 *    changes are re-applied THROUGH THE PARENT'S EXECUTOR with a per-file
 *    SHA-256 collision check, so a file that moved underneath us is refused BY
 *    NAME instead of silently overwritten. The parent's own guards — leases,
 *    `--dry-run`, the `.acuvo/` leash, path containment — all still apply,
 *    because the apply path is the same `executor.writeFile` every other tool
 *    uses. ⚠️ It is OPT-IN per call: a helper asked a question still cannot
 *    write a byte.
 *
 * 2. ⚠️ NO RECURSION. A subagent that can delegate is an unbounded fork bomb
 *    billed to the user. `delegate` is absent from `SUBAGENT_TOOL_NAMES`, and
 *    depth is checked before a model is called, so both the offer and the
 *    dispatcher refuse.
 *
 * 3. ⚠️ DISTILLED, NEVER FORWARDED. Returning the transcript would defeat the
 *    whole point: the parent would pay for precisely the context it delegated
 *    to avoid. The parent gets a sentence, a cost, and a list of files touched.
 *
 * 4. ⚠️ A FAILURE IS DATA. A dead subagent returns a reason the parent can act
 *    on. Throwing into the parent's loop would take down a session that was
 *    otherwise fine, to report that a helper was not.
 */

/**
 * ⚠️ STATIC, AND SAFE TO BE. `turn.mjs` is still imported LAZILY below because
 * it imports `tools.mjs`, which imports THIS file — a cycle. `handoff.mjs` and
 * `workspace.mjs` sit underneath both and import neither, so there is no cycle
 * to dodge here, and `summariseForParent` is synchronous and could not await
 * one anyway.
 */
import { describeHandoff, runInIsolatedCopy } from './handoff.mjs';
import { createLocalExecutor } from './workspace.mjs';

/**
 * What a researcher may hold. Read, search, navigate — nothing that changes
 * anything.
 *
 * ⚠️ SPELLED OUT RATHER THAN FILTERED FROM THE REGISTRY. A denylist would
 * silently hand a subagent every future tool anyone adds; this way a new
 * capability reaches subagents only when somebody decides it should.
 */
export const SUBAGENT_TOOL_NAMES = Object.freeze([
  'read_file',
  'read_lines',
  'read_around',
  'list_dir',
  'find_files',
  'search_text',
  'find_definition',
  'find_references',
  'list_symbols',
  'git_status',
  'git_diff',
  'git_log',
]);

/**
 * ── ⭐⭐ WHAT A *BUILDER* MAY HOLD — the read verbs plus three write verbs ────
 *
 * ⚠️ SPELLED OUT, LIKE THE LIST ABOVE, and for the same reason: a denylist
 * would hand every future tool to a writing helper the day it is registered.
 *
 * ⚠️⚠️ THE THREE GIT VERBS ARE DELIBERATELY ABSENT, AND THIS IS THE TRAP THAT
 * WOULD HAVE SHIPPED. A builder runs inside the isolated copy, and the copy
 * skips `.git` (`best-of.mjs:42 COPY_SKIP_DIRS` — copying a repo's object
 * store per delegation is enormous and the helper cannot commit anything
 * anyway). So `git_status`, `git_diff` and `git_log` could only ever return
 * "not a git repository" there. ⭐ That is precisely the dead button
 * `tools.mjs` refuses to ship everywhere else — a tool the model is offered,
 * tries, and learns to apologise for. Offering them would cost ~750 tokens a
 * round to teach the helper to fail.
 *
 * ⚠️ AND STILL NOTHING THAT EXECUTES. `allowRun: false` is passed for a builder
 * exactly as for a researcher — not from timidity, but because the copy has no
 * `node_modules` either (same skip set), so `npm test` inside it would fail for
 * a reason that has nothing to do with the code. A verification that fails for
 * the wrong reason is worse than no verification: the parent would act on it.
 * ⭐ The parent verifies, after the changes land in the real workspace where
 * the dependencies actually are.
 */
/**
 * ── ⭐⭐ AND WHAT A *VERIFYING* BUILDER MAY HOLD — the write verbs plus ONE ────
 *
 * ⚠️ THE COMMENT ON `SUBAGENT_WRITE_TOOL_NAMES` BELOW IS STILL TRUE AND IS
 * DELIBERATELY LEFT STANDING. It argues that a builder must execute nothing
 * because the isolated copy has no `node_modules`, so a verification run in
 * there would fail for a reason that has nothing to do with the code, and "a
 * verification that fails for the wrong reason is worse than no verification:
 * the parent would act on it." Every word of that was correct — and it is an
 * argument about the COPY, not about the helper.
 *
 * ⭐ SO THE COPY CHANGED. `runInIsolatedCopy({ linkNodeModules: true })` links
 * the real dependency tree into the copy (a junction on Windows, measured safe
 * under the recursive delete — see its comment). With the dependencies present,
 * `npm test` inside the copy means what it says, and the old objection no longer
 * applies to a run that asked for this.
 *
 * ⚠️ A SEPARATE LIST, NOT A MUTATION OF THE ONE BELOW. `run_command` must not
 * appear in the default builder's offer: `subagent-write.test.mjs` pins it as a
 * dead button there and it is RIGHT to, because a plain `write:true` helper
 * still gets an unlinked copy and `allowRun: false`. Two capabilities, two
 * lists, and neither can leak into the other by accident.
 *
 * ⚠️ ONE RUN VERB, NOT FIVE. `check_types`, `check_acceptance`, `evaluate` and
 * `run_program` would each cost tokens in the offer on every round of every
 * delegated build; `run_command` reaches all of them through the same
 * allowlist (`node`, `npm`, `npx`, `tsc`) that governs the parent. Breadth in
 * the offer is not breadth in capability here.
 */
/* Declared just below `SUBAGENT_WRITE_TOOL_NAMES`, because it is that list
 * plus one verb and retyping thirteen names would be two documents to keep in
 * agreement — the drift this file already records three times. */

export const SUBAGENT_WRITE_TOOL_NAMES = Object.freeze([
  'read_file',
  'read_lines',
  'read_around',
  'list_dir',
  'find_files',
  'search_text',
  'find_definition',
  'find_references',
  'list_symbols',
  /**
   * ⭐ `edit_file` BEFORE `write_file`, because the order in the offer is a
   * hint the model reads — `tools.mjs:520` makes the same point: for a file
   * that already exists, `write_file` is a destructive operation wearing the
   * costume of an edit.
   */
  'edit_file',
  'write_file',
  /**
   * ⭐ THE BULK WRITE EARNS ITS ~300 TOKENS HERE MORE THAN ANYWHERE. A builder
   * is capped at 6 rounds; "create these four files" as four rounds is a
   * helper that runs out of budget mid-feature, and `handoff.mjs:changedPaths`
   * already reads `result.written[]` so every one of them is applied.
   */
  'write_files',
  'delete_file',
]);

export const SUBAGENT_VERIFY_TOOL_NAMES = Object.freeze([...SUBAGENT_WRITE_TOOL_NAMES, 'run_command']);

/**
 * ⚠️ ONE LEVEL. A parent may delegate; a subagent may not. Two levels sounds
 * harmless and is how a five-round task becomes a hundred model calls nobody
 * authorised.
 */
export const MAX_SUBAGENT_DEPTH = 1;

/**
 * ⚠️ A SUBAGENT MUST NOT OUTSPEND ITS PARENT. A researcher that needs more than
 * a handful of rounds is being asked the wrong question, and the honest answer
 * is a worse summary rather than a bigger bill.
 */
export const MAX_SUBAGENT_ROUNDS = 6;
const DEFAULT_SUBAGENT_ROUNDS = 4;

const MAX_SUMMARY_CHARS = 900;
const MAX_FILES_LISTED = 12;

/**
 * ── ⭐⭐ THE CONTEXT CHANNEL — THE HELPER USED TO GET A TASK STRING AND NOTHING ─
 *
 * Rule 3 at the top of this file says the RESULT is distilled and never
 * forwarded, and it is right. Nobody ever wrote the rule for the other
 * direction, so the input was a single sentence by default rather than by
 * decision — and a helper that does not know what the parent has already
 * established re-derives it. Measured cost of that: a builder capped at 6 rounds
 * spending two of them opening files the parent read a minute earlier, and
 * arriving at a different opinion about them, which the parent then has to
 * reconcile against its own.
 *
 * ⭐ IT IS A BRIEF, NOT A TRANSCRIPT. Handing over the message array would
 * reproduce the exact cost the whole feature exists to avoid — the parent would
 * pay to send the context it delegated in order not to send. What travels is
 * what the PARENT chose to write down, which is also the only part it can
 * vouch for.
 *
 * ⚠️ AND IT IS CAPPED, OUT LOUD. Without a ceiling the cheapest way for a model
 * to "give context" is to paste a file, and delegation would quietly become the
 * most expensive tool in the package instead of the cheapest. 4,000 characters
 * is ~1,000 estimated tokens — about a quarter of `read_file`'s own budget, and
 * enough for a paragraph of findings and a list of constraints. Over that it is
 * TRIMMED and the trim is announced inside the prompt, so the helper knows it
 * was handed a truncated brief rather than a complete one.
 */
export const MAX_CONTEXT_CHARS = 4_000;

/**
 * Fold the parent's brief into the task the helper is given.
 *
 * ⚠️ PURE, AND SEPARATE FROM `runSubagent`, because it decides what a paid model
 * call is asked — reviewable on its own rather than buried in an options object.
 *
 * ⚠️ THE CONTEXT GOES AFTER THE TASK, NOT BEFORE IT. The first thing the helper
 * reads has to be the thing it was asked to do; a brief on top buries the
 * question under its own background, and `prompt.mjs` makes the same call for
 * the same reason.
 *
 * @param {string} task
 * @param {unknown} context
 * @returns {string}
 */
export function briefFor(task, context) {
  const extra = typeof context === 'string' ? context.trim() : '';
  if (!extra) return task;
  const trimmed = extra.length > MAX_CONTEXT_CHARS;
  const body = trimmed ? extra.slice(0, MAX_CONTEXT_CHARS) : extra;
  return `${task}\n\n`
    + '--- WHAT THE AGENT THAT ASKED YOU HAS ALREADY ESTABLISHED ---\n'
    + 'Treat this as known. Do not spend a round re-deriving it, and do not contradict it without saying so.\n'
    + `${body}\n`
    + (trimmed
      ? `[the brief was longer than ${MAX_CONTEXT_CHARS} characters and was cut here — ask for anything you are missing in your summary]\n`
      : '')
    + '--- end of brief ---';
}

/** Every path a set of tool records looked at, in first-seen order. */
function filesTouched(executed) {
  const seen = [];
  for (const rec of executed ?? []) {
    const p = rec?.args?.path ?? rec?.result?.path;
    if (typeof p === 'string' && p && !seen.includes(p)) seen.push(p);
  }
  return seen;
}

/**
 * Turn a finished session into the few hundred characters the parent actually
 * needs.
 *
 * ⭐ THE MODEL'S OWN CLOSING NOTE IS THE ANSWER. It is the one place the
 * subagent states what it concluded, in its own words, having seen everything.
 * Re-deriving that from tool results here would be a second, worse summariser.
 *
 * ⚠️ AND WHEN THERE IS NO NOTE, SAY SO OUT LOUD. An empty string tells the
 * parent nothing and reads as success; "found nothing" is a fact it can act on.
 */
/**
 * ── ⭐⭐ WHAT THE HELPER PROVED, AS A FACT RATHER THAN AS A CLAIM ─────────────
 *
 * ⚠️ IT IS APPENDED SEPARATELY AND NEVER FOLDED INTO THE NOTE, for the same
 * reason `describeHandoff` is: the note is what the helper MEANT, capped at
 * `MAX_SUMMARY_CHARS`, and a verdict squeezed out by a chatty model is a verdict
 * the parent never hears. `outcome.verification` is what a process actually did.
 *
 * ⚠️ AND SILENCE IS NOT SUCCESS. A helper that ran nothing says so in words,
 * because "the tests pass" and "no test was run" look identical to a parent
 * reading a summary that mentions neither — and the second one is the state the
 * parent must not report to the user as the first.
 *
 * @param {{ ran?: boolean, passed?: boolean|null, command?: string|null, exitCode?: number|null }|null} v
 */
export function describeVerification(v, { offered = false } = {}) {
  if (!offered) return '';
  if (!v || v.ran !== true) {
    return 'VERIFIED: nothing. It was allowed to run commands and did not — treat the change as unproven.';
  }
  const cmd = v.command ? `\`${v.command}\`` : 'a command';
  return v.passed === true
    ? `VERIFIED: it ran ${cmd} in its isolated copy and it passed (exit ${v.exitCode ?? 0}).`
    : `⚠ NOT VERIFIED: it ran ${cmd} in its isolated copy and it FAILED (exit ${v.exitCode ?? '?'}). `
      + 'The files below were still applied — re-run it yourself before saying the work is done.';
}

export function summariseForParent(outcome, handoff = null, { verifyOffered = false } = {}) {
  if (!outcome || outcome.ok !== true) {
    return `the helper did not finish: ${outcome?.error ?? 'no reason given'}`;
  }

  const note = typeof outcome.note === 'string' ? outcome.note.trim() : '';
  const files = filesTouched(outcome.executed);
  const proof = describeVerification(outcome.verification, { offered: verifyOffered });

  /**
   * ── ⚠️⚠️ WHAT LANDED IS A FACT, AND IT OUTRANKS THE MODEL'S OPINION ───────
   *
   * A builder's note says what it MEANT to do. `handoff` says what is on disk.
   * When those disagree — a collision refused one file, the leash refused
   * another — the parent must be told by the second, or it will report the
   * first to the user as if it were the second. So this paragraph is appended
   * unconditionally in write mode, including when the helper wrote nothing.
   */
  const landed = handoff ? describeHandoff(handoff) : '';

  /**
   * ⚠️ THE PROOF SITS WITH `landed`, ABOVE THE FILE LIST AND BELOW THE NOTE —
   * both are facts about what happened rather than about what was intended, and
   * keeping them adjacent is what stops a reader taking the note's confidence
   * and the handoff's file list as one statement with no verdict between them.
   */
  const tail = [landed, proof].filter(Boolean).join('\n');

  if (!note) {
    const nothing = files.length
      ? `Nothing conclusive. It looked at ${files.slice(0, MAX_FILES_LISTED).join(', ')} and did not report a finding.`
      : 'Nothing conclusive — it did not report a finding, and opened no files.';
    return tail ? `${nothing}\n${tail}` : nothing;
  }

  const body = note.length > MAX_SUMMARY_CHARS
    ? `${note.slice(0, MAX_SUMMARY_CHARS)}…`
    : note;

  const looked = files.length === 0
    ? ''
    : `\n(looked at: ${files.slice(0, MAX_FILES_LISTED).join(', ')}${files.length > MAX_FILES_LISTED ? ` +${files.length - MAX_FILES_LISTED} more` : ''})`;

  return tail ? `${body}${looked}\n${tail}` : `${body}${looked}`;
}

/**
 * Run one scoped helper and return what it concluded — and, when it was asked
 * to build, what it changed.
 *
 * @param {{ task: string, executor: any, config: any, depth?: number, maxRounds?: number,
 *           maxTokens?: number, timeoutMs?: number, write?: boolean, onEvent?: (e:any)=>void }} args
 * @param {{ sessionImpl?: Function, isolateImpl?: Function, makeExecutor?: Function }} [deps]
 */
export async function runSubagent(args = {}, {
  sessionImpl = null,
  /**
   * ⚠️ INJECTED, NOT IMPORTED AT THE CALL SITE, for the reason every outward
   * call in this package is injected: without it the ONLY way to exercise the
   * write path is a real model call against a real temp directory, which means
   * in practice it is exercised once by hand and never again. The two things
   * being pinned here — a collision is refused, and `--dry-run` still holds —
   * are the two that must never regress quietly.
   */
  isolateImpl = null,
  makeExecutor = null,
} = {}) {
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) {
    // ⚠️ Refused BEFORE a model is called. An empty task still costs a round.
    return { ok: false, error: 'a delegated task needs a specific question — an empty one would spend a round to learn nothing' };
  }

  const depth = Number.isFinite(args.depth) ? args.depth : 0;
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return {
      ok: false,
      error: `a helper cannot delegate again (depth ${depth}) — ask it a narrower question, or do the remaining step yourself`,
    };
  }

  const run = sessionImpl ?? (await import('./turn.mjs')).runSession;

  /**
   * ── ⭐⭐ RESEARCHER OR BUILDER — ONE FLAG, TWO OFFERS ──────────────────────
   *
   * ⚠️ `=== true` RATHER THAN TRUTHINESS. This decides whether a helper may
   * change files on someone's disk; the string "false", which is what a model
   * emits about once in fifty when a schema says boolean, is not a yes.
   */
  const wantsWrite = args.write === true;

  /**
   * ── ⭐⭐ AND MAY IT PROVE ITS OWN WORK? ────────────────────────────────────
   *
   * ⚠️ ONLY WITH `write`, AND THAT IS NOT TIDINESS. A RESEARCHER runs against
   * the PARENT'S OWN EXECUTOR — the real workspace, not a copy — so letting one
   * execute commands would put an unsupervised process in the user's actual
   * repository to answer a question. A builder already works in an isolated
   * copy, which is the only place a command can be both meaningful and contained.
   *
   * ⚠️ `=== true` again, for the reason above: this decides whether a process
   * starts, and the string "false" is not a yes.
   */
  const wantsVerify = wantsWrite && args.verify === true;

  /**
   * ⚠️ THE DEFAULT MOVES WITH THE JOB, AND THE CEILING DOES NOT. Four rounds is
   * right for "read these files and tell me X". A helper that must WRITE, RUN,
   * READ THE FAILURE and FIX IT has spent four before it has looked at anything,
   * so the default for a verifying build is the whole allowance —
   * `MAX_SUBAGENT_ROUNDS`, which is unchanged, so nothing about the worst case
   * moves. An explicit `maxRounds` from the model still wins, and is still
   * clamped by the same ceiling.
   */
  const maxRounds = Math.min(
    Math.max(1, Number.isFinite(args.maxRounds)
      ? Math.floor(args.maxRounds)
      : (wantsVerify ? MAX_SUBAGENT_ROUNDS : DEFAULT_SUBAGENT_ROUNDS)),
    MAX_SUBAGENT_ROUNDS,
  );

  /**
   * ⚠️ A BUILDER NEEDS A REAL WORKSPACE TO COPY. `runSession` is given an
   * executor by embedders that have no disk at all (`memory-workspace.mjs`
   * exists precisely so the browser builder can run this loop), and
   * `runInIsolatedCopy` would `cpSync` from `undefined`. Refusing here names
   * the cause; failing inside the copier would name a path that never existed.
   */
  if (wantsWrite && typeof args.executor?.root !== 'string') {
    return { ok: false, error: 'a building helper needs a real workspace on disk, and this run has none — do this part yourself' };
  }

  const build = wantsWrite ? (isolateImpl ?? runInIsolatedCopy) : null;
  const buildExecutor = wantsWrite ? (makeExecutor ?? createLocalExecutor) : null;

  /** Everything both modes pass, so the two call sites cannot drift apart. */
  const sessionArgs = {
      /**
       * ⭐ THE BRIEF, NOT THE BARE TASK. `briefFor` returns `task` unchanged
       * when no context was supplied, so a caller that never heard of the
       * channel sends byte-for-byte what it sent before — which matters more
       * than usual here, because the task text is the head of the helper's
       * cacheable prefix.
       */
      task: briefFor(task, args.context),
      executor: args.executor,
      config: args.config,
      maxRounds,
      maxTokens: args.maxTokens,
      timeoutMs: args.timeoutMs,
      /**
       * ── ⚠️⚠️ `allowRun` WAS false IN BOTH MODES, AND THE REASON WAS THE COPY ─
       *
       * The reasoning it shipped with, kept verbatim because it was CORRECT:
       * *"a builder still executes nothing: the isolated copy has no
       * `node_modules` and no `.git` (`COPY_SKIP_DIRS`), so a verification
       * command run in there would fail for a reason that has nothing to do with
       * the code, and the parent would act on that answer."*
       *
       * ⭐ THAT IS AN ARGUMENT ABOUT THE COPY. It said the helper cannot verify
       * because the copy cannot support a verification — not that a helper
       * should not. So the copy changed: with `verify: true`,
       * `runInIsolatedCopy` links the real `node_modules` in (see its comment,
       * and the measurement proving the recursive delete does not follow it),
       * and `npm test` in there means what it says.
       *
       * ⚠️ `.git` IS STILL ABSENT AND THE GIT VERBS ARE STILL NOT OFFERED. This
       * change buys exactly one thing — running the project's own checks — and
       * nothing about committing, which the helper still cannot do.
       *
       * ⚠️ AND IT IS STILL false BY DEFAULT. A `write: true` helper that did not
       * ask for this gets the unlinked copy and the old lock, so the sentence
       * above remains true of it word for word.
       */
      allowRun: wantsVerify,
      toolNames: wantsVerify
        ? [...SUBAGENT_VERIFY_TOOL_NAMES]
        : (wantsWrite ? [...SUBAGENT_WRITE_TOOL_NAMES] : [...SUBAGENT_TOOL_NAMES]),
      /**
       * ⚠️ THE HELPER'S OWN DISPATCHER MUST KNOW IT IS A HELPER. The offer
       * already omits `delegate`, but a model can emit a call for a tool it was
       * never shown — so the depth travels with the session and the dispatcher
       * refuses independently. Two locks, because one of them is a list.
       */
      depth: depth + 1,
      /**
       * ── ⚠️⚠️ THE HELPER USED TO SPEND OUTSIDE EVERY CEILING ────────────────
       *
       * `runSession` defaults `budgetUsd` to null, and nothing here passed one.
       * So the moment the model called `delegate`, the one differentiator this
       * package actually claims — *tell me the price before it runs and stop at
       * the number you gave me* — became false: the parent stopped at its
       * ceiling, and the helper it spawned had none at all. The cost came back
       * in `costUsd` and was reported, so the money was MEASURED and simply not
       * BOUNDED, which is the most misleading of the three possible states.
       *
       * ⭐ THE HELPER'S CEILING IS THE PARENT'S REMAINDER, not a fraction of it.
       * A fraction would be an invented constant to defend; the remainder makes
       * the arithmetic self-evident — the helper cannot spend money the run does
       * not have, so the TOTAL is still the number the user typed, which is the
       * only number that was ever promised. `null` (a run with `--budget none`)
       * passes through as unbounded, exactly as before.
       */
      budgetUsd: Number.isFinite(args.budgetUsd) ? args.budgetUsd : null,
      /**
       * ⭐ And the fleet ceiling travels too, or seven terminals could each
       * delegate their way around the workspace-wide cap.
       */
      fleetGate: args.fleetGate ?? null,
      onEvent: args.onEvent,
  };

  let outcome;
  /**
   * ⚠️ DECLARED OUT HERE, NOT INSIDE THE BRANCH. The parent's dispatcher needs
   * these to mark its own record `mutated` — and a record that is silent about
   * the files a helper changed is exactly the half-connected defect this
   * package keeps shipping: the run summary would say "0 files written" over
   * work that is on disk.
   */
  let handoff = null;
  /** ⚠️ Only ever true when `verify` was asked for AND the link actually took. */
  let dependenciesLinked = false;
  try {
    if (build) {
      const isolated = await build({
        root: args.executor.root,
        executor: args.executor,
        /**
         * ⭐ THE DEPENDENCIES TRAVEL ONLY WHEN THERE IS SOMETHING TO RUN. A
         * `write: true` helper that did not ask to verify gets exactly the copy
         * it always got, so the one thing this flag can change is the one thing
         * it is for.
         */
        linkNodeModules: wantsVerify,
        /**
         * ── ⭐⭐ THE HELPER'S EXECUTOR IS **NEVER** A DRY RUN, AND I HAD THIS
         * BACKWARDS ─────────────────────────────────────────────────────────
         *
         * My first version inherited `args.executor.dryRun` into the copy,
         * reasoning that a `--dry-run` parent should produce a previewing
         * helper. A mutation test SURVIVED, which is how I found out the test
         * was passing for the wrong reason, and the probe that followed showed
         * the inheritance was not merely untested but WRONG. Measured, with a
         * `--dry-run` parent and a helper that wrote two files:
         *
         *     applied : ["existing.txt"]        ← the ORIGINAL bytes, not the
         *                                          helper's — a preview of
         *                                          nothing
         *     ⚠ brand-new.txt: no such file — nothing was deleted
         *                                       ← a file the helper CREATED,
         *                                          reported as a failed DELETE
         *
         * ⭐ Because a dry-run write is a no-op, the file never appeared in the
         * copy, so `applyHandoff` saw an absent source and correctly concluded
         * "the helper deleted this" — the right inference from a lie.
         *
         * ⭐⭐ THE COPY IS SCRATCH SPACE. There is nothing in it to protect, and
         * the whole point of copying was that writes there are free. The
         * `--dry-run` PROMISE is about the USER'S files, and it is kept where
         * it belongs: at the apply boundary, by `executor.writeFile` on the
         * PARENT (`workspace.mjs:653`), which validates everything and then
         * declines to touch the disk. So a dry run now previews the real work
         * instead of previewing an empty directory.
         */
        run: (copyRoot) => run({
          ...sessionArgs,
          executor: buildExecutor(copyRoot),
        }),
      });
      if (!isolated.ok) return { ok: false, error: isolated.error, costUsd: 0, tokens: 0, roundsUsed: 0, files: [] };
      outcome = isolated.outcome;
      /**
       * ⚠️⚠️ A VERIFICATION THAT COULD NOT HAVE WORKED MUST NOT BE REPORTED AS
       * ONE. If the link failed — no `node_modules` to link, a filesystem that
       * refuses links — every command in the copy failed with "Cannot find
       * module", which is exactly the wrong-reason failure the old `allowRun:
       * false` existed to avoid. Carrying the flag out here is what lets the
       * summary say so instead of handing the parent a red verdict about the
       * environment dressed as a red verdict about the code.
       */
      dependenciesLinked = isolated.dependenciesLinked === true;
      handoff = { written: isolated.written, refused: isolated.refused, problems: isolated.problems };
    } else {
      outcome = await run(sessionArgs);
    }
  } catch (err) {
    // ⚠️ A helper's death must not take the parent's session with it.
    return { ok: false, error: `the helper crashed: ${err?.message ?? String(err)}` };
  }

  const usage = outcome?.usage ?? null;
  const shared = {
    costUsd: Number.isFinite(usage?.cost) ? usage.cost : 0,
    tokens: Number.isFinite(usage?.total_tokens) ? usage.total_tokens : 0,
    roundsUsed: Number.isFinite(outcome?.roundsUsed) ? outcome.roundsUsed : 0,
    files: filesTouched(outcome?.executed),
    /**
     * ⚠️⚠️ REPORTED ON THE FAILURE PATH TOO, and this is not tidiness. A
     * builder that wrote three files and then ran out of rounds has ALREADY
     * had those three files applied to the real workspace — the apply happens
     * the moment the session returns, whatever the session's verdict. A caller
     * told "it failed" and given an empty change list would leave real edits
     * unmentioned on someone's disk, which is the worst of the three states.
     */
    written: handoff?.written ?? [],
    refused: handoff?.refused ?? [],
  };

  if (!outcome || outcome.ok !== true) {
    return { ok: false, error: outcome?.error ?? 'the helper returned no result', ...shared };
  }

  /**
   * ⚠️ THE HONEST DEGRADATION, AND IT IS ONE SENTENCE. `verify: true` with no
   * dependencies to link is a helper that COULD run commands and whose every
   * import would have failed. Saying nothing would let the parent read a red
   * `npm test` as a broken change; saying this makes it a broken environment,
   * which is a completely different next move.
   */
  const degraded = wantsVerify && !dependenciesLinked
    ? '\n⚠ Its isolated copy had no dependencies linked, so anything it ran there could not resolve imports — '
      + 'treat any command result from it as inconclusive and verify in the real workspace yourself.'
    : '';

  return {
    ok: true,
    summary: `${summariseForParent(outcome, handoff, { verifyOffered: wantsVerify })}${degraded}`,
    verified: wantsVerify && dependenciesLinked ? (outcome?.verification ?? null) : null,
    ...shared,
  };
}

/**
 * ⭐ THE DESCRIPTION IS WHERE THE JUDGEMENT LIVES. A model that does not know it
 * gets a SUMMARY back will delegate and then ask for the same files anyway,
 * paying twice. So the contract is stated in the first sentence, and the good
 * use — a broad search whose answer is small — is named explicitly.
 */
export function subagentToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'delegate',
        description:
          'Hand a self-contained piece of work to a helper with its own fresh context; you get back a short '
          + 'SUMMARY, not everything it read. Default it only READS — best when answering would mean opening '
          + 'many files to produce a small answer ("where is X defined", "which files call Y"). With '
          + 'write:true it also BUILDS a piece you have already specified ("write the tests for parser.mjs"), and '
          + 'write+verify runs the project\'s own check inside its copy. Pass `context` with anything you have '
          + 'already worked out — it starts with a blank head. It cannot delegate further.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['task'],
          properties: {
            task: {
              type: 'string',
              description: 'One specific question, with enough detail to answer without asking you anything back.',
            },
            /**
             * ── ⭐⭐ THE INPUT HALF OF THE CONTRACT, WHICH NEVER EXISTED ───────
             *
             * Rule 3 of this file governs what comes BACK (distilled, never the
             * transcript). Nothing ever governed what goes IN, so the answer was
             * "one sentence" by default rather than by decision — and a helper
             * that does not know what the parent has established re-derives it,
             * out of an allowance of four rounds.
             *
             * ⚠️ THE DESCRIPTION HAS TO SAY WHAT *NOT* TO PUT HERE. The cheapest
             * way for a model to "give context" is to paste a file, which would
             * turn the cheapest tool in the package into the most expensive —
             * the exact cost `delegate` exists to avoid. So it names findings
             * and constraints, and rules out file contents explicitly.
             */
            context: {
              type: 'string',
              description:
                'What you already know that it would otherwise spend rounds rediscovering: findings so far, '
                + 'constraints, decisions already made, names of the files that matter. NOT file contents — it '
                + 'can read those itself, and pasting them here costs you the saving you delegated for. '
                + `Trimmed at ${MAX_CONTEXT_CHARS} characters.`,
            },
            /**
             * ── ⭐ A BOOLEAN ON AN EXISTING TOOL, NOT A SECOND TOOL ──────────
             *
             * ⚠️ AND HERE IS THE MEASURED PRICE, because my first version of
             * this comment guessed "roughly 60 tokens" and the guess was out by
             * more than 4x. MEASURED with `JSON.stringify` on the real schema
             * (~3.6 chars/token): the `delegate` schema was **771 chars / ~214
             * tokens** and is now **1,239 chars / ~344 tokens** — a delta of
             * **468 chars, ~130 tokens on every round of every run**. The first
             * draft of this text measured ~264 tokens; re-measuring it is what
             * prompted the trim, which is the entire argument for measuring
             * rather than asserting.
             *
             * ⭐ IT IS STILL THE CHEAPER SHAPE. A separate `delegate_build`
             * tool would cost ~250-300 tokens ON TOP of the 214 this one
             * already costs — call it ~500 against ~344 — and it would leave
             * two schemas sharing `task`, `maxRounds`, the depth rule and the
             * budget rule, which is two documents to keep in agreement. This
             * package has three recorded cases of exactly that drifting.
             *
             * ⭐ AND IT SITS IN THE CACHED PREFIX. Tool schemas are identical
             * byte-for-byte on every round, so the delta is paid at full price
             * once and at cache rates (up to 50x less) thereafter.
             *
             * ⚠️ THE DESCRIPTION MUST SAY WHEN *NOT* TO USE IT. A model that
             * delegates the whole task builds nothing itself and cannot verify
             * what came back, because the helper never ran a command.
             */
            write: {
              type: 'boolean',
              description:
                'Default false. True lets the helper CHANGE FILES — it works in an isolated copy and its '
                + 'changes are applied back for you. Only for a bounded, fully-specified piece: never the '
                + 'whole task, and never while you are still deciding what to build. A file that changed '
                + 'underneath it is refused, not overwritten, and the summary names it. Nothing is verified '
                + 'unless you also pass verify.',
            },
            /**
             * ⚠️ THE DESCRIPTION SAYS THE COPY IS WHERE IT RUNS, AND IT MUST.
             * A model told only "it can verify" would ask for a command whose
             * effects it expects to see in the real workspace — a server it
             * started, a file its script wrote outside the change set. Only the
             * change set comes back, and the sentence has to say so or the
             * capability quietly lies about its own scope.
             */
            verify: {
              type: 'boolean',
              description:
                'Default false, and only meaningful with write. True lets the helper RUN the project\'s own '
                + 'check (e.g. `npm test`) inside its isolated copy, with the real dependencies linked in, and '
                + 'fix what it broke before handing back. The verdict comes back in the summary. Only the files '
                + 'it changed are applied — anything else the command did happens in the copy and is discarded.',
            },
            maxRounds: {
              type: 'integer',
              description: `How many rounds it may spend, 1-${MAX_SUBAGENT_ROUNDS} (default ${DEFAULT_SUBAGENT_ROUNDS}, or ${MAX_SUBAGENT_ROUNDS} when verifying).`,
            },
          },
        },
      },
    },
  ];
}
