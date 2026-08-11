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

export function trimHistory(messages, max = MAX_HISTORY_MESSAGES) {
  if (!Array.isArray(messages) || messages.length <= max) return messages;
  const head = messages.slice(0, 2);          // system + the context-bearing user turn
  const keep = max - head.length;
  let tail = messages.slice(-keep);
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

export async function runChat({
  runOne,
  render,
  input = process.stdin,
  output = process.stdout,
  banner = '',
  maxHistory = MAX_HISTORY_MESSAGES,
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
  if (banner) output.write(`${banner}\n`);
  output.write('Type what you want done. "exit" to leave.\n\n');

  let history = null;
  let turns = 0;

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

      let outcome;
      try {
        outcome = await runOne(task, history);
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
