/**
 * ── ⭐⭐ SAYING SOMETHING WHILE IT WORKS ─────────────────────────────────────
 *
 * `--help` already documents steering BETWEEN turns —
 * `acuvo --resume <id> "now add tests"`. The gap is the during-run version: an
 * eight-round build takes minutes, and the moment you most want to say "stop
 * writing tests, just fix the import" is round three, not after round eight.
 * Today the only lever is Ctrl-C, which throws away the round in flight.
 *
 * ── ⚠️⚠️ WHY A FILE AND NOT THE TERMINAL. THIS WAS THE REAL DECISION ────────
 *
 * A TTY mechanism works in exactly ONE of the two modes this tool runs in, and
 * it is the wrong one:
 *
 *   · **Interactive** (`acuvo` with no task) — stdin is owned by `readline`.
 *     Anything typed mid-run is already buffered by the interface, and stealing
 *     it back means reaching into readline's internals or racing it.
 *   · **One-shot** (`acuvo "task"`) — the common case, the LONG case, and the
 *     one that most needs steering — has no readline at all, and its stdin is
 *     usually a pipe or nothing. There is no keystroke to read.
 *
 * ⭐ A FILE WORKS IN BOTH, and in several places a keyboard cannot reach: an
 * editor in another pane, `echo "now add tests" > .acuvo/steer.txt` from a
 * second terminal, a CI supervisor, another agent in the fleet. It is testable
 * without a terminal, it survives the run reading it, and it is inspectable
 * afterwards. It is unglamorous and it is right.
 *
 * ── ⚠️ THE FIVE RULES, EACH ONE A FAILURE THAT WOULD OTHERWISE BE SHIPPED ───
 *
 *   1. **CONSUMED, NOT WATCHED.** The file is deleted the instant it is read.
 *      Left in place it would be re-applied at every round boundary forever —
 *      an instruction given once becoming one the user cannot stop giving.
 *   2. **ANNOUNCED, ALWAYS.** `turn.mjs` states the rule for the memory file:
 *      *"the agent is being steered by a file the user may have forgotten they
 *      wrote — silently obeying it is how 'why did it do that?' becomes
 *      unanswerable."* A steer is exactly that file, so it is printed to the
 *      terminal AND labelled inside the conversation.
 *   3. **A USER MESSAGE AT A ROUND BOUNDARY, NEVER MID-ROUND.** A round owns a
 *      model call, its tool results and its ledger entry; injecting into the
 *      middle of one would record spend against a conversation that no longer
 *      matches what was sent.
 *   4. **THE ROUNDS ARE NOT REFILLED.** The continuation gets what was LEFT of
 *      `--max-rounds`, never a fresh allowance. Otherwise `--max-rounds 8` plus
 *      three steers quietly means 32 rounds and the flag is a lie.
 *   5. **BOUNDED.** `MAX_STEERS` caps how many times one turn can be redirected,
 *      because a script that rewrites the file after every read is an infinite
 *      loop that spends money.
 *
 * Zero dependencies. The only I/O is one `readFileSync` + one `unlinkSync` of a
 * path inside `.acuvo/`, and neither may ever throw into a run.
 */

import { readFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACUVO_DIR } from './acuvo-dir.mjs';

/**
 * Where the user writes.
 *
 * ⭐⭐ INSIDE `.acuvo/` FOR TWO REASONS, AND THE SECOND ONE IS THE IMPORTANT
 * ONE. First, that directory ignores itself in git (`acuvo-dir.mjs`), so the
 * steer never dirties the tree — the exact defect that made our own bench fail
 * its `git` task. Second, and load-bearing: `workspace.mjs`'s
 * `AGENT_CONFIG_DIR` and `policy.mjs`'s `isPolicyProtectedPath` both HARD-REFUSE
 * agent writes anywhere under `.acuvo/`. **So the agent cannot write its own
 * steer file.** A steering channel the model could write to is a model that can
 * hand itself new instructions mid-run and report them as the user's — put it
 * anywhere else in the workspace and that is exactly what it becomes.
 */
export const STEER_FILE = join(ACUVO_DIR, 'steer.txt');

/**
 * ⚠️ HOW MANY TIMES ONE TURN MAY BE REDIRECTED. Three is a judgement, not a
 * measurement: enough for "no, the other file" → "now add a test" → "run it",
 * few enough that a loop which keeps rewriting the file stops on its own. The
 * cap is REPORTED when it bites, because a steer that was silently ignored is
 * the worst outcome of the three.
 */
export const MAX_STEERS = 3;

/**
 * ⚠️ A CAP, BECAUSE THE FILE IS WRITTEN BY A HUMAN IN A HURRY. A stray `cat
 * bigfile > steer.txt` would otherwise put a megabyte into the prompt — which
 * fails as a context-length 400 several rounds later, nowhere near the cause.
 * 4,000 characters is longer than any instruction anyone types on purpose.
 */
export const MAX_STEER_CHARS = 4000;

/** What the abort reason says, so the summary names the cause honestly. */
export const STEER_ABORT_REASON = 'you steered the run mid-flight';

/** Absolute path of the steer file for a workspace. */
export function steerPath(root) {
  return join(String(root ?? ''), STEER_FILE);
}

/**
 * Read the pending steer and REMOVE it, so it applies exactly once.
 *
 * ⚠️ IT NEVER THROWS. This runs on the round-boundary hot path of every run.
 * A read-only `.acuvo/`, a file deleted between the `existsSync` and the read,
 * or a locked handle on Windows must cost the steer, never the run — the same
 * rule the audit log and the session save already obey.
 *
 * ⚠️ AND THE DELETE HAPPENS EVEN IF THE CONTENT IS UNUSABLE. An empty or
 * over-long file that stayed on disk would be re-read at every single round
 * boundary for the rest of the run.
 *
 * @param {string} root workspace root
 * @param {{ read?: Function, remove?: Function, exists?: Function }} [io] test seam
 * @returns {{ text: string, truncated: boolean } | null} null when there is nothing to say
 */
export function takeSteer(root, io = {}) {
  const exists = io.exists ?? existsSync;
  const read = io.read ?? ((p) => readFileSync(p, 'utf8'));
  const remove = io.remove ?? unlinkSync;
  const modified = io.modified ?? ((p) => statSync(p).mtimeMs);
  /**
   * ── ⚠️⚠️ THE HIJACK THIS CLOSES, FOUND BY RUNNING IT NOT BY THINKING ──────
   *
   * Measured on a live run: a steer written 200ms AFTER the last round boundary
   * is never picked up, and the file simply survives the run. The next `acuvo`
   * in that workspace would then consume it at ROUND ONE and apply *"actually
   * make it a haiku"* — written about yesterday's task — to whatever is being
   * asked today. It is announced, so it is not silent, but "why did it do
   * that?" would take a while to answer.
   *
   * ⭐ A steer must be NEWER than the turn it steers. Anything older predates
   * the run and therefore cannot be about it, so it is consumed once and
   * reported as stale (the caller hands the words back — `formatUnapplied`)
   * rather than obeyed or silently deleted.
   *
   * ⚠️ `newerThan = 0` keeps the old behaviour for any caller that does not
   * supply a clock, which is every test that does not care about this.
   */
  const newerThan = Number(io.newerThan ?? 0);
  const path = steerPath(root);

  let raw = null;
  let stale = false;
  try {
    if (!exists(path)) return null;
    if (newerThan > 0) {
      // ⚠️ A stat that throws must NOT make a live steer look stale — the
      // conservative failure here is to apply it, because the user did write it.
      try { stale = Number(modified(path)) < newerThan; } catch { stale = false; }
    }
    raw = String(read(path));
  } catch {
    return null;
  } finally {
    // Consume unconditionally — see the header rule 1.
    try { if (raw !== null || exists(path)) remove(path); } catch { /* nothing to do */ }
  }

  const trimmed = raw.trim();
  /**
   * ⚠️ AN EMPTY FILE IS NOT A STEER. `touch .acuvo/steer.txt`, an editor that
   * saved before anything was typed, or a `>` that truncated — none of those
   * are an instruction, and treating them as one would cost a round and inject
   * a blank user message the model has to invent a meaning for.
   */
  if (!trimmed) return null;

  const truncated = trimmed.length > MAX_STEER_CHARS;
  return { text: truncated ? trimmed.slice(0, MAX_STEER_CHARS) : trimmed, truncated, stale };
}

/**
 * ── ⭐⭐ THE SENTENCE THE MODEL ACTUALLY RECEIVES ───────────────────────────
 *
 * ⚠️ IT IS LABELLED AS COMING FROM THE USER, AND `turn.mjs` IS WHY. That file
 * injects its own automated user messages prefixed
 * `[runner — automatic, not from the user]` precisely so the model can tell an
 * instruction from a nudge. An unlabelled steer would be indistinguishable from
 * the runner's own automation and would be weighted like one.
 *
 * ⚠️ AND IT ASKS FOR AN ACKNOWLEDGEMENT. The steer arrives after a round the
 * user watched go the wrong way; a model that silently changes course leaves
 * them unable to tell whether the file was read at all.
 */
export function steerTask(text) {
  return `[steering — this came from YOU, the user, written to ${STEER_FILE} while the run was working. `
    + 'It is not from the runner and it is not automation.] '
    + `${String(text ?? '').trim()}\n\n`
    + 'Say in one short line what you are changing because of this, then do it. '
    + 'What you have already done stays done — carry on from here rather than starting over.';
}

/**
 * The line the TERMINAL shows. Rule 2: never silent.
 *
 * @param {{ text: string, truncated?: boolean, roundsLeft: number, spentUsd?: number|null }} p
 */
export function formatSteer({ text, truncated = false, roundsLeft, spentUsd = null }) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  const shown = one.length > 90 ? `${one.slice(0, 87)}…` : one;
  /**
   * ⚠️ THE COST SO FAR IS ON THIS LINE ON PURPOSE. The final summary prices the
   * CONTINUATION, because that is the run it describes; without this line the
   * dollars spent before the steer would appear nowhere a person reads, and a
   * number that quietly omits part of the bill is the one thing this package
   * refuses to print.
   */
  const money = typeof spentUsd === 'number' && spentUsd > 0 ? ` · $${spentUsd.toFixed(6)} spent so far` : '';
  return `  ⤳ steering: "${shown}"${truncated ? ' (truncated)' : ''} — applied now, ${roundsLeft} round${roundsLeft === 1 ? '' : 's'} left${money}`;
}

/**
 * ── ⚠️⚠️ THE WORDS ARE HANDED BACK, BECAUSE THE FILE IS ALREADY GONE ────────
 *
 * `takeSteer` deletes on read — it has to, or one instruction repeats at every
 * boundary forever. The consequence is that when a steer CANNOT be applied
 * (the run had already finished, the rounds ran out, the cap was hit) the only
 * remaining copy of what the user typed is in this process's memory. Printing
 * the reason alone would mean they watched their sentence be consumed and
 * discarded, and had to retype it from memory.
 *
 * ⭐ So the text comes back, on its own line, in a shape that can be copied
 * straight into the suggested command. This is the same rule the refusal
 * messages obey elsewhere in the package: a refusal that does not say what to
 * do next is half a refusal.
 */
export function formatUnapplied({ text, reason }) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return [
    `  ⤳ steer NOT applied: ${reason}`,
    `     what you wrote is not lost — it was: ${JSON.stringify(one)}`,
  ].join('\n');
}

/**
 * ── ⭐ SHOULD THIS TURN CONTINUE, AND WITH WHAT? ────────────────────────────
 *
 * The whole decision, pure, so it is testable without a model, a terminal or a
 * filesystem — and so the CLI can be three lines that cannot get it wrong.
 *
 * ⚠️ IT REFUSES UNLESS THE RUN REALLY STOPPED FOR THE STEER. `stoppedBecause`
 * has to be `'aborted'`: if the loop ended on `verified`, `no-tool-calls` or a
 * budget stop in the same instant the steer was picked up, the work is over and
 * starting a fresh segment would be buying rounds nobody asked for. The steer is
 * reported as unapplied rather than silently dropped — see rule 2.
 *
 * @param {{ steer: {text:string,truncated?:boolean}|null, outcome: any, maxRounds: number, steersUsed: number, maxSteers?: number }} p
 * @returns {{ go: false, reason: string|null } | { go: true, task: string, priorMessages: any[], maxRounds: number, roundsLeft: number }}
 */
export function planSteer({ steer, outcome, maxRounds, steersUsed, maxSteers = MAX_STEERS }) {
  if (!steer || !steer.text) return { go: false, reason: null };
  if (steer.stale === true) {
    return { go: false, reason: 'it was written BEFORE this run started, so it is not about this task — a leftover from an earlier run. It has been cleared.' };
  }
  if (outcome?.stoppedBecause !== 'aborted') {
    return { go: false, reason: `the run had already finished (${outcome?.stoppedBecause ?? 'unknown'}) — nothing was steered. Re-run with it as the task, or \`acuvo --continue "…"\`.` };
  }
  if (!Array.isArray(outcome?.messages) || outcome.messages.length === 0) {
    /**
     * ⚠️ WITHOUT THE TRANSCRIPT A CONTINUATION IS A NEW RUN WEARING ITS NAME —
     * it would re-gather the workspace, lose the 96%-cached prefix, and lose
     * every fact the first segment learned. Refusing is the honest answer.
     */
    return { go: false, reason: 'the run returned no transcript, so there is nothing to carry on from' };
  }
  if (steersUsed >= maxSteers) {
    return { go: false, reason: `already steered ${steersUsed} time${steersUsed === 1 ? '' : 's'} this turn (the cap is ${maxSteers}) — this one was not applied` };
  }

  const used = Number(outcome?.roundsUsed ?? 0);
  const left = Math.max(0, Number(maxRounds ?? 0) - (Number.isFinite(used) ? used : 0));
  if (left < 1) {
    return { go: false, reason: `no rounds left (--max-rounds ${maxRounds} is spent) — this steer was not applied. Raise --max-rounds, or \`acuvo --continue\` with it.` };
  }

  return {
    go: true,
    task: steerTask(steer.text),
    priorMessages: outcome.messages,
    maxRounds: left,
    roundsLeft: left,
  };
}
