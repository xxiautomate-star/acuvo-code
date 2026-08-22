/**
 * ── ⭐ THE INTERACTIVE SESSION ───────────────────────────────────────────────
 *
 * Every invocation of `acuvo "task"` started COLD: it re-gathered the workspace,
 * rebuilt the prompt, and knew nothing about the last thing you asked. So the
 * second instruction cost as much as the first, and "now do the same for the
 * other file" was not a sentence you could say.
 *
 * ⭐ AND THE ECONOMICS ARE THE ARGUMENT, NOT JUST THE ERGONOMICS. Measured
 * 2026-08-09: an identical prompt prefix cached at **97.2%**, dropping the call
 * cost **4.3x** ($0.000836 → $0.000195). A session that APPENDS keeps that
 * prefix intact, so every turn after the first is nearly free. A tool that
 * rebuilds its prompt each time throws that away and looks identical from the
 * outside — which is exactly why this is worth building rather than assuming.
 *
 * ── ⚠️ WHY NOT A FULL TUI ────────────────────────────────────────────────────
 * `readline` and plain writes, no alternate screen buffer, no cursor addressing.
 * A TUI that redraws breaks `>` redirection, breaks piping into a file, breaks
 * `tee`, and breaks every terminal that is not the one it was tested in. The
 * output here is append-only text, so a session transcript is a file you can
 * keep. That is a deliberate trade of polish for portability.
 */

import { createInterface } from 'node:readline';
import { EXIT_INTERRUPTED } from './interrupt.mjs';
import { parseSlash, runSlashCommand } from './slash.mjs';
import { estimateMessagesTokens } from './compact.mjs';

/** What ends a session. `exit`/`quit` because both are muscle memory. */
const QUIT = new Set(['exit', 'quit', ':q', 'bye']);

/**
 * ⚠️ CONTEXT GROWS UNBOUNDED AND A CODING SESSION IS THE WORST CASE — tool
 * results carry whole files. Left alone, turn 30 sends everything from turns
 * 1-29 and eventually 400s on a context-length error mid-thought.
 *
 * The trim keeps the SYSTEM message and the FIRST user message (the workspace
 * context — the cacheable prefix, dropping it would cost more than it saves) and
 * discards the oldest middle turns.
 */
export const MAX_HISTORY_MESSAGES = 40;

/**
 * ── 💰⭐⭐⭐ THE TRIM WAS A CONTINUOUS SLIDE, AND IT COST ~90% OF THE CACHE ──
 *
 * `messages.slice(-keep)` re-slices on EVERY turn once a session passes the
 * cap, so the third message of the prompt is different every time. Prefix
 * caching matches from the first token and stops at the first difference — so
 * everything after the 2-message head was re-bought at full price, every turn,
 * for the rest of the session.
 *
 * ⭐ MEASURED (no credits, no network — a simulated 60-turn session counting how
 * much of each prompt is byte-identical to the previous one):
 *
 *     CURRENT slice(-38)        cache  9.2%    history 38-40
 *     stepped high=48 low=40    cache 74.5%    history 38-48
 *     stepped high=56 low=40    cache 85.3%    history 38-56
 *     stepped high=64 low=40    cache 89.7%    history 38-64   <- shipped
 *     stepped high=72 low=40    cache 92.0%    history 38-72
 *
 * ⚠️ THE HEAD BEING STABLE IS NOT THE SAME AS THE PROMPT BEING CACHED, and
 * measuring position 0 alone would have said this code was fine. The 2-message
 * head never moved; the cacheable prefix was still 2 messages out of 40.
 *
 * ⭐ `LOW` IS TODAY'S CAP ON PURPOSE, so this can only ever keep MORE history
 * than the rule it replaces — never less. That makes it a pure win rather than
 * a trade of memory for money, and it is why HIGH was raised instead of LOW
 * being lowered (console shipped 16/8, halving its window; the CLI holds whole
 * files in tool results and cannot afford to forget more).
 *
 * ⚠️ RAISING `HIGH` COSTS TOKENS PER REQUEST, and the ceiling that matters is
 * not here: `turn.mjs` compacts above CONTEXT_BUDGET_TOKENS (96k), which
 * `compact.mjs` warns is the moment the cache discount dies for good. This is a
 * MESSAGE-COUNT backstop, not the token bound — 64 messages of ordinary turns
 * sit far under 96k, but a session whose tool results carry whole files can
 * approach it, and then compaction (with its own hysteresis) takes over. 72 and
 * 80 buy 2 more points of cache for materially more of that risk, which is why
 * 64 is the shipped number and not the best one in the table.
 */
export const HISTORY_HIGH_WATER = 64;
export const HISTORY_LOW_WATER = MAX_HISTORY_MESSAGES;

/**
 * ⚠️ WELL UNDER `turn.mjs`'s CONTEXT_BUDGET_TOKENS (96,000), not near it. The
 * request also carries the TOOL OFFER — measured at ~15,200 tokens for the
 * CLI's 63 verbs — plus the system prompt, so history must leave room for both
 * and still clear the line where compaction fires. 55k + ~15k offer + prompt
 * sits comfortably inside 96k.
 *
 * ⭐ This is a CEILING, not a target: an ordinary session (~551 tokens/message,
 * measured) reaches the 64-message cap at ~35k and never comes near it. It
 * exists for the file-heavy session, which is exactly the one that would
 * otherwise be pushed into permanent compaction by the higher message cap.
 */
export const HISTORY_TOKEN_CEILING = 55_000;

export function trimHistory(messages, max = HISTORY_HIGH_WATER) {
  if (!Array.isArray(messages)) return messages;
  /**
   * ⚠️⚠️ THE GATE MUST ASK BOTH QUESTIONS, AND MY FIRST VERSION ASKED ONLY ONE.
   * It read `messages.length <= max` and returned early — so the token ceiling
   * below was unreachable for exactly the session it was written for: 64 heavy
   * messages are under the COUNT cap and ~137,000 tokens, and the function
   * handed them straight back. The test reported 133,491 tokens and I had to
   * measure to find that the ceiling was never consulted at all rather than
   * being wrong.
   */
  const overBudget = estimateMessagesTokens(messages) > HISTORY_TOKEN_CEILING;
  if (messages.length <= max && !overBudget) return messages;
  const head = messages.slice(0, 2);          // system + the context-bearing user turn
  /**
   * ⭐ THE HEAD MOVES IN STEPS, NOT EVERY TURN. `dropped` is a multiple of STEP,
   * so it changes only when the conversation crosses the next boundary — and
   * between boundaries the prompt is byte-identical to the previous turn's.
   *
   * ⚠️ NOT `length > HIGH ? slice(-LOW)`. That is still a continuous slide past
   * the mark and is the exact mistake console's own guard records catching
   * before it shipped.
   */
  /**
   * ⚠️⚠️ THE LOW WATER MUST BE DERIVED FROM `max`, NOT PINNED TO A CONSTANT,
   * AND I ALMOST SHIPPED IT PINNED. My first version was
   * `Math.min(HISTORY_LOW_WATER, max)`. `runChat`'s default `maxHistory` was
   * MAX_HISTORY_MESSAGES (40), which equals HISTORY_LOW_WATER — so `step`
   * became `max(1, 0)` = 1, and one-message steps ARE the continuous slide this
   * whole change exists to remove. The fix would have measured 89.6% in a
   * simulation and done NOTHING on the only path that calls it.
   *
   * ⭐ 0.625 is 40/64 — the shipped ratio, so the default keeps exactly the
   * numbers that were measured, and any other `max` still steps properly
   * instead of silently degrading to a slide.
   */
  const low = Math.min(HISTORY_LOW_WATER, Math.floor(max * 0.625));
  const step = Math.max(1, max - low);
  const body = messages.slice(head.length);
  const overflow = Math.max(0, messages.length - max);
  let dropped = Math.ceil(overflow / step) * step;
  /**
   * ── ⚠️⚠️ AND A TOKEN CEILING, BECAUSE MESSAGE COUNT IS THE WRONG UNIT ──────
   *
   * MEASURED against the one real recorded session on disk (93,036 prompt
   * tokens, 18 messages, `.acuvo/sessions/20260814-095636-99d4.json`):
   *
   *     avg message  ~551 tokens        largest observed  ~2,145 tokens
   *
   *     at 40 msgs: typical ~22,000   worst case (all like the largest) ~85,800
   *     at 64 msgs: typical ~35,300   worst case                       ~137,300
   *
   * ⚠️ SO RAISING THE COUNT ALONE MOVES THE WORST CASE FROM JUST UNDER THE
   * 96k CONTEXT BUDGET TO WELL OVER IT. Past that line `turn.mjs` compacts, and
   * `compact.mjs` is explicit that compaction voids the cache discount and
   * "once it starts, it never stops" — so a change made ENTIRELY to protect the
   * cache would, in a file-heavy session, destroy it. A tool result carrying a
   * whole file is not the exception in a coding session; it is the normal case.
   *
   * ⭐ THE CEILING DROPS IN THE SAME `step` BLOCKS. Any multiple of `step`
   * keeps block alignment, so the prefix still changes only at boundaries and
   * the caching win is untouched — this bounds the worst case without
   * reintroducing a slide.
   */
  const budget = Math.max(1, HISTORY_TOKEN_CEILING - estimateMessagesTokens(head));
  while (dropped < body.length && estimateMessagesTokens(body.slice(dropped)) > budget) {
    dropped += step;
  }
  let tail = body.slice(dropped);
  /**
   * ⚠️ A `tool` MESSAGE WITHOUT ITS `assistant` TOOL CALL IS A HARD 400 from
   * every OpenAI-shaped provider — "tool_call_id did not have a preceding
   * message with tool_calls". Slicing mid-exchange produces exactly that, and it
   * would surface as a mysterious API error thirty turns into a session.
   */
  while (tail.length > 0 && tail[0].role === 'tool') tail = tail.slice(1);
  return [...head, ...tail];
}

/**
 * One prompt line. Returns null on EOF (Ctrl-D, or a pipe that ran out).
 *
 * ⚠️ THE CLOSED CHECK IS NOT DEFENSIVE, IT IS THE PIPED CASE. Found by piping a
 * list of prompts in: readline emits 'close' when the stream ends, and the NEXT
 * `rl.question()` throws ERR_USE_AFTER_CLOSE. The first turn had already
 * succeeded and written a real file, so the session crashed AFTER doing its job
 * — the worst shape of failure, because the work looks lost.
 *
 * Scripted input matters beyond tests: piping a prompt list is how anyone would
 * automate this.
 */
function ask(rl, prompt, state) {
  if (state.closed) return Promise.resolve(null);
  return new Promise((resolve) => {
    let answered = false;
    const onClose = () => { if (!answered) resolve(null); };
    rl.once('close', onClose);
    rl.question(prompt, (line) => {
      answered = true;
      rl.removeListener('close', onClose);
      resolve(line);
    });
  });
}

/**
 * Run an interactive session.
 *
 * `runOne(task, priorMessages)` performs one turn and returns the session
 * outcome — injected rather than imported so this loop is testable with a stub
 * and never needs a model or a terminal in a test.
 */
/**
 * ── ⚠️ PIPED INPUT IS A DIFFERENT PROBLEM AND NEEDED A DIFFERENT ANSWER ──────
 * `readline` on a non-TTY DRAINS the stream as fast as it can and emits 'close'
 * the moment it ends. The model call for turn 1 takes seconds, by which point
 * the interface is already closed and every later prompt is lost — measured:
 * a three-line pipe ran exactly ONE turn and exited quietly, which is worse than
 * crashing because it looks like it worked.
 *
 * So a pipe is read WHOLE and replayed from a queue. A TTY keeps the real
 * readline loop, where a human types the next line after seeing the last answer.
 * Two input shapes, two mechanisms — pretending they are the same is what broke.
 */
async function readAllLines(input) {
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c)))
    .toString('utf8')
    .split(String.fromCharCode(10))
    .map((l) => l.replace(String.fromCharCode(13), ''));
}

/**
 * ── ⚠️⚠️⭐ READLINE EATS CTRL-C. MEASURED IN NODE'S OWN SOURCE ──────────────
 *
 * This is the finding that made an interrupt handler in `bin/acuvo.mjs`
 * necessary-but-not-sufficient. Read out of `process.binding('natives')` on
 * node v22.17.0, `internal/readline/interface.js`, the ttyWrite ctrl-key
 * switch, verbatim:
 *
 *     case 'c':
 *       if (this.listenerCount('SIGINT') > 0) {
 *         this.emit('SIGINT');
 *       } else {
 *         // This readline instance is finished
 *         this.close();
 *         this[kQuestionReject]?.(new AbortError('Aborted with Ctrl+C'));
 *       }
 *
 * ⚠️ So with a TTY readline open and NO `'SIGINT'` listener on the interface,
 * Ctrl-C never reaches `process.on('SIGINT')` at all — readline just closes
 * itself. The run in flight would have carried on to completion, for minutes,
 * with the user's Ctrl-C having produced nothing on screen. That is strictly
 * worse than the bug we set out to fix, and no amount of correct handling in
 * `bin/acuvo.mjs` would have been reached.
 *
 * ⭐ So the interface takes a listener whose whole job is to hand the signal
 * back to the process, where the one policy in `interrupt.mjs` decides between
 * "stop after this round" and "quit now".
 *
 * ── ⚠️⚠️ AND A SYNTHETIC EMIT INTO AN EMPTY EMITTER DOES NOTHING ────────────
 *
 * `process.emit('SIGINT')` is plain `EventEmitter.emit` — it does NOT invoke
 * the OS default action. `turn.mjs` installs the process signal handlers inside
 * `runSession`, so before the first turn of a session there are ZERO listeners
 * and the emit would return `false` having done absolutely nothing. Ctrl-C at
 * the very first prompt would be inert.
 *
 * ⭐ Hence the count check and the explicit exit: **every path out of this
 * function either aborts a run or ends the process.** That is the rule this
 * whole feature is built on, and it is the one that is easy to break here.
 */
export function deliverInterrupt({
  emit = (sig) => process.emit(sig),
  listenerCount = (sig) => process.listenerCount(sig),
  exit = (code) => process.exit(code),
} = {}) {
  if (listenerCount('SIGINT') > 0) {
    emit('SIGINT');
    return 'delegated';
  }
  exit(EXIT_INTERRUPTED);
  return 'exited';
}

export async function runChat({
  runOne,
  render,
  input = process.stdin,
  output = process.stdout,
  banner = '',
  /**
   * ⚠️ THE HIGH WATER MARK, NOT THE OLD FLAT CAP. This default is what makes
   * the stepped trim REACH the live session — see the note in `trimHistory`
   * about the version of this fix that measured 89.6% and changed nothing.
   */
  maxHistory = HISTORY_HIGH_WATER,
  /**
   * ⚠️ INJECTED SO A TEST CAN SEE IT. The real one exits the process, and a
   * test that could not substitute it could only assert this feature by killing
   * its own runner. Default is production behaviour, so no caller changes.
   */
  onInterrupt = deliverInterrupt,
  /**
   * ── ⭐ THE `/` SURFACE'S ONE SEAM ─────────────────────────────────────────
   *
   * Providers for the things a command reports on — skills, MCP servers, spend,
   * the model. `bin/` owns where those facts come from; this loop only asks, for
   * the same reason `workspace.mjs` takes `claimPath` and `journal` injected
   * rather than importing them.
   *
   * ⚠️ `{}` BY DEFAULT, NOT `null`. Every command degrades to "not available in
   * this session" on a missing provider (see `slash.mjs`), so an embedder that
   * wires nothing still gets a working `/help` instead of a crash.
   */
  slashContext = {},
}) {
  const interactive = input.isTTY === true;

  // ⚠️ A pipe is drained up front — see readAllLines. Doing this lazily is what
  // silently lost every prompt after the first.
  const queued = interactive ? null : await readAllLines(input);
  let queueIndex = 0;

  const rl = interactive ? createInterface({ input, output, terminal: true }) : null;
  const state = { closed: false };
  /**
   * ⚠️ ATTACHED ONCE, NOT PER QUESTION — and the per-question version is why the
   * first fix did not work. The stream can end WHILE the model call is in
   * flight, when no question is pending and therefore no listener is attached;
   * `close` fires into nothing, the flag stays false, and the next question
   * throws anyway. A session-lifetime listener sees it whenever it happens.
   */
  if (rl) rl.once('close', () => { state.closed = true; });
  /**
   * ⭐ THE ONE LINE THAT MAKES CTRL-C REACH THE RUN — see `deliverInterrupt`
   * above for the Node source that proves it is needed. `on`, not `once`: an
   * interactive session runs many turns and the SECOND Ctrl-C (the one that
   * quits) has to arrive here too, or the escape hatch is a single-use one.
   */
  if (rl) rl.on('SIGINT', () => { onInterrupt(); });
  if (banner) output.write(`${banner}\n`);
  // ⚠️ `/help` IS ADVERTISED IN THE ONE LINE EVERY SESSION PRINTS. A command
  // surface nobody is told about is the same defect item 14 closed for `--help`:
  // the feature worked and nothing a stranger would read mentioned it.
  output.write('Type what you want done. "/help" for commands, "exit" to leave.\n\n');

  let history = null;
  let turns = 0;
  /**
   * ⭐ SET BY `/skills <name>`, CONSUMED BY THE NEXT REAL TURN AND THEN CLEARED.
   * A skill that was printed to the terminal would look loaded and be invisible
   * to the model; this is the variable that makes the verb real.
   */
  let pendingInject = null;

  try {
    for (;;) {
      const line = interactive
        ? await ask(rl, '› ', state)
        : (queueIndex < queued.length ? queued[queueIndex++] : null);
      // Echo a piped prompt so a scripted transcript reads like a session.
      if (!interactive && line !== null && line.trim()) output.write(`› ${line.trim()}
`);
      // ⚠️ EOF is not an error. A closed pipe or Ctrl-D ends the session the
      // same way "exit" does — treating it as a fault would print a stack trace
      // at the end of every scripted run.
      if (line === null) break;
      const task = line.trim();
      if (!task) continue;
      if (QUIT.has(task.toLowerCase())) break;

      /**
       * ── ⭐ THE `/` SURFACE, BEFORE ANYTHING IS SENT TO A MODEL ────────────
       *
       * ⚠️ IT COSTS NOTHING AND MUST NOT COUNT AS A TURN. `/cost` is asked
       * precisely by somebody watching their spend, and answering it by
       * incrementing the turn counter and appending to the history would make
       * the question change the answer.
       *
       * ⚠️ AN UNRECOGNISED COMMAND IS ANSWERED HERE AND NOT FORWARDED. Passing
       * `/skil` to the model gets a confident essay about a typo; the one thing
       * the person needed was the word `/skills`, which `slash.mjs` supplies.
       * See its header for why `/etc/hosts` is NOT treated as a command.
       */
      const command = parseSlash(line.trim());
      if (command) {
        const result = runSlashCommand(command, slashContext);
        for (const l of result.output ?? []) output.write(`${l}\n`);
        output.write('\n');
        if (result.effect === 'clear') history = null;
        if (typeof result.inject === 'string' && result.inject) pendingInject = result.inject;
        continue;
      }

      /**
       * ⚠️ THE SKILL IS PREPENDED TO THE TASK, NOT SUBSTITUTED FOR IT. The user
       * typed an instruction; the skill is context for it. And it is cleared
       * BEFORE the call rather than after, so a turn that throws cannot leave it
       * armed and silently attach it to an unrelated question later.
       */
      let sendTask = task;
      if (pendingInject) {
        sendTask = `${pendingInject}\n\n---\n\n${task}`;
        pendingInject = null;
      }

      let outcome;
      try {
        outcome = await runOne(sendTask, history);
      } catch (err) {
        /**
         * ⚠️ ONE BAD TURN MUST NOT END THE SESSION. A timeout or a provider blip
         * after twenty minutes of context is infuriating if it drops everything;
         * the history is still valid, so report and keep the prompt.
         */
        output.write(`\n  ✖ that turn failed: ${String(err?.message || err)}\n\n`);
        continue;
      }

      turns += 1;
      render(outcome, output);

      if (outcome?.ok && Array.isArray(outcome.messages)) {
        history = trimHistory(outcome.messages, maxHistory);
      } else if (!outcome?.ok) {
        // A failed turn leaves history UNTOUCHED. Appending a turn that produced
        // nothing would poison the next one with a dead exchange.
        output.write(`\n  (history unchanged — that turn did not complete)\n`);
      }
      output.write('\n');
    }
  } finally {
    if (rl) rl.close();
  }
  return { turns };
}
