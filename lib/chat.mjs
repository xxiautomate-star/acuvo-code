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
import { readFileSync, statSync } from 'node:fs';
import { readBoxedLine, pinRegion } from './input-box.mjs';
import { createPainter, colourEnabled } from './colour.mjs';
import { EXIT_INTERRUPTED } from './interrupt.mjs';
import { parseSlash, runSlashCommand, SLASH_COMMANDS, userCommands } from './slash.mjs';
import { compactHistory, describeContext } from './session-commands.mjs';
import { estimateMessagesTokens } from './compact.mjs';
import { parseShellLine, runShellLine, shellContextBlock } from './prompt-shell.mjs';
/**
 * ⚠️ THE WORKSPACE'S OWN RULES, NOT A SECOND SET. `resolveInWorkspace` owns
 * `..`, absolute paths, symlinks that leave the tree, control characters and
 * path length — and its header spends sixty lines on why a lexical check is not
 * enough. An `@` in a typed message is a file read like any other; writing a
 * "quick" containment check here would be a second copy of a security boundary,
 * which this file's neighbours have already paid for twice.
 */
import { resolveInWorkspace, MAX_READ_BYTES, BINARY_NEXT_MOVE } from './workspace.mjs';

/**
 * What ends a session. `exit`/`quit` because both are muscle memory.
 *
 * ── ⚠️⭐ THE SLASHED FORMS, ADDED 2026-09-07 AFTER DRIVING THE PROMPT ───────
 *
 * Measured, not guessed: typing `/exit` at the prompt answered *"/exit is not a
 * command."* Every OTHER thing this prompt understands takes a slash —
 * `/help`, `/cost`, `/model`, `/skills`, `/mcp`, `/clear` — and the tool most of
 * our users arrive from ends its sessions with `/exit`. So the slash is the
 * obvious guess, the guess was refused, and the refusal was technically correct
 * and practically wrong.
 *
 * ⚠️ THE BARE WORDS STAY. They are what the banner and `/help` advertise, and
 * removing one to "tidy" the set would break the muscle memory this comment
 * exists to respect. This is additive.
 */
const QUIT = new Set([
  'exit', 'quit', ':q', 'bye',
  '/exit', '/quit', '/q', '/bye',
]);

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

/* ───────────────────────────── @file REFERENCES ──────────────────────────── */

/**
 * ── ⭐⭐⭐ `@path` — THE ONE CLAUDE CODE ERGONOMIC THIS CLI GENUINELY LACKED ──
 *
 * MEASURED 2026-08-26 against the feature list rather than against a memory of
 * it, which is why this is the item and not one of the obvious ones. The CLI
 * ALREADY has `--resume`, `--continue`, `--sessions`, a plan mode, hooks and
 * subagents — every headline thing people name when they compare the two. What
 * it had no answer for was the smallest and most-used gesture in the product:
 * naming a file inline while you are typing the sentence.
 *
 * ⚠️ AND THE WORKAROUND IS NOT FREE, WHICH IS WHY IT IS WORTH BUILDING. Without
 * this, "why does @src/auth.ts reject an expired token" costs a whole round: the
 * model has to guess the path, call `read_file`, and answer on the round after.
 * That is a full request — prompt, tool offer and history — bought to learn
 * something the person typing already knew.
 *
 * ── ⚠️ WHAT MUST NOT HAPPEN ─────────────────────────────────────────────────
 *
 *   · `roman@xxiautomate.com` is not a file. A reference must start at a word
 *     boundary, so an `@` with a character in front of it is never a reference.
 *   · An `@` that resolves to nothing STAYS AS TYPED. `@media`, `@decorator`,
 *     `@here` and a plain typo are all ordinary prose, and quietly deleting the
 *     token would be a message the user did not write.
 *   · No path may escape the workspace — `resolveInWorkspace` decides that, not
 *     a regex here.
 *   · The budget is stated when it bites. Silently sending half a file is the
 *     `--task-audio` truncation failure in a different costume: the user
 *     believes the whole thing was read.
 */

/**
 * ⚠️ THE SAME 200,000 BYTES `read_file` ALLOWS, SHARED ACROSS EVERY `@` IN ONE
 * MESSAGE — not per file. One `@big.ts` therefore behaves exactly as `read_file`
 * on the same path would, which is the rule that is easiest to explain and the
 * only one where the two halves of the product cannot disagree.
 */
export const MAX_REF_BYTES = MAX_READ_BYTES;

/**
 * ⚠️ THE PRECEDING BOUNDARY IS THE EMAIL GUARD AND IT IS THE FIRST ALTERNATIVE
 * FOR A REASON. `(^|\s)` is the whole defence against `roman@xxiautomate.com`,
 * `user@host:~$` in a pasted transcript, and every npm scope in a pasted command
 * (`npm i @scope/pkg` — that one has whitespace, and resolves to nothing, so it
 * survives as text by the second rule instead).
 *
 * ⭐ THE QUOTED FORM EXISTS FOR WINDOWS. `@"src/My Documents/notes.md"` is the
 * only way to name a path with a space, and this package runs on a machine where
 * those are normal.
 */
const REF_PATTERN = /(^|\s)@(?:"([^"\n]+)"|(\S+))/g;

/**
 * ⚠️ TRAILING PUNCTUATION IS PART OF THE SENTENCE, NOT OF THE PATH. "look at
 * @src/app.ts, then fix it" is how people type, and a reference that only works
 * at the end of a line is a feature with a hidden rule. Nothing legitimate ends
 * in these characters — a filename may CONTAIN a dot, but not finish on one.
 */
function trimSentencePunctuation(raw) {
  return raw.replace(/[.,;:!?)\]}'"]+$/, '');
}

/**
 * Resolve every `@path` in `text` and append what they contain.
 *
 * Pure apart from the two injected readers, so the whole policy is testable
 * without a terminal, a model or a network.
 *
 * ⚠️ THE TYPED TEXT IS NEVER REWRITTEN. The tokens stay exactly where the user
 * put them — "fix the bug in @src/app.ts" reads correctly to a model as it
 * stands — and the contents are APPENDED under a heading. Substituting a file
 * into the middle of a sentence destroys the sentence, and it also makes the
 * transcript stop matching what was typed.
 */
export function expandFileRefs(root, text, {
  readImpl = readFileSync,
  statImpl = statSync,
  maxBytes = MAX_REF_BYTES,
} = {}) {
  const empty = { text, attached: [], skipped: [], truncated: false, bytes: 0 };
  if (!root || typeof text !== 'string' || !text.includes('@')) return empty;

  const attached = [];
  const skipped = [];
  const seen = new Set();
  let budget = maxBytes;
  let truncated = false;

  for (const m of text.matchAll(REF_PATTERN)) {
    const quoted = m[2];
    const raw = quoted ?? trimSentencePunctuation(m[3] ?? '');
    if (!raw) continue;
    // ⚠️ Deduped by the TYPED token: `@src/app.ts` twice in one sentence is one
    // attachment, and paying for the second copy would be paying twice for the
    // same bytes in every round that follows.
    if (seen.has(raw)) continue;
    seen.add(raw);

    const target = resolveInWorkspace(root, raw, 'read');
    if (!target.ok) {
      // ⭐ LEFT AS TEXT. `@media`, `@decorator` and a typo are all prose, and the
      // reason is reported to the human rather than smuggled into the prompt.
      skipped.push({ token: raw, why: target.reason });
      continue;
    }

    let stat;
    try {
      stat = statImpl(target.absolute);
    } catch {
      skipped.push({ token: raw, why: `no such file in the workspace` });
      continue;
    }
    if (stat.isDirectory()) {
      /**
       * ⚠️ A DIRECTORY IS NOT A MISTAKE, SO SAY WHAT WOULD WORK. Inlining a tree
       * is how one `@src/` becomes the whole repository in a single message; the
       * model already has `list_dir` and can ask for exactly what it needs.
       */
      skipped.push({ token: raw, why: 'is a directory — name a file, or let the agent list it' });
      continue;
    }

    let content;
    try {
      content = readImpl(target.absolute, 'utf8');
    } catch (err) {
      skipped.push({ token: raw, why: `could not be read: ${err?.message ?? err}` });
      continue;
    }
    /**
     * ⚠️ THE SAME BINARY TEST `read_file` USES, AND THE SAME NEXT MOVE. A PNG
     * pasted in as text is thousands of tokens of mojibake that the model then
     * tries to interpret — expensive, useless, and it looks like the file is
     * corrupt rather than like it was the wrong kind of file.
     */
    if (content.includes('\u0000')) {
      skipped.push({ token: raw, why: `looks binary${BINARY_NEXT_MOVE}` });
      continue;
    }

    if (budget <= 0) {
      truncated = true;
      skipped.push({ token: raw, why: `not attached — the ${maxBytes.toLocaleString('en-US')}-byte limit for one message was already used up` });
      continue;
    }

    /**
     * ⚠️⚠️ THE BUDGET IS IN BYTES, SO THE CUT MUST BE IN BYTES. My first version
     * did `content.slice(0, budget)` — a CHARACTER slice measured against a BYTE
     * ceiling. On ASCII the two agree and every test passes; on a file of
     * Japanese or Cyrillic each character is 2-3 bytes, so a 200,000-byte budget
     * would have attached up to 600,000 bytes and the guard would have been
     * silently absent for exactly the files it is most needed on.
     *
     * ⭐ `subarray` can land mid-codepoint and produce one replacement
     * character at the join. That is a visible, harmless artefact at the exact
     * point the header already says the file was cut — strictly better than a
     * ceiling that does not hold.
     */
    const buf = Buffer.from(content, 'utf8');
    const full = buf.length;
    let body = content;
    let cut = 0;
    if (full > budget) {
      /**
       * ⚠️ TRUNCATED AND SAID SO, IN THE PROMPT AS WELL AS ON SCREEN. The model
       * has to know it is holding a fragment or it will answer about the end of
       * a file it never saw — and `read_lines` is the verb that gets the rest,
       * so the note names it.
       */
      body = buf.subarray(0, budget).toString('utf8');
      cut = full - budget;
      truncated = true;
    }
    const took = Math.min(full, budget);
    budget -= took;
    attached.push({ path: target.relative, bytes: took, of: full, cut, body });
  }

  if (attached.length === 0) return { ...empty, skipped };

  /**
   * ⚠️ A HEADER PER FILE, WITH THE PATH IN IT, BECAUSE THE MODEL HAS TO BE ABLE
   * TO EDIT WHAT IT IS SHOWN. Pasting three files as one undifferentiated blob
   * is how a model writes a correct patch against the wrong path — the same
   * failure `read_document` records for OCR'd tables: every character survives
   * and the thing that told you what it belonged to is gone.
   *
   * ⚠️ NOT A ``` FENCE. The attached file may itself contain fences (this
   * package is full of markdown), and a fence that closes early truncates the
   * attachment silently at exactly the point a reader would not notice.
   */
  const blocks = attached.map((a) => {
    const size = a.cut
      ? `${a.bytes.toLocaleString('en-US')} of ${a.of.toLocaleString('en-US')} bytes — TRUNCATED, read_lines gets the rest`
      : `${a.bytes.toLocaleString('en-US')} bytes`;
    return `===== ${a.path} (${size}) =====\n${a.body}\n===== end ${a.path} =====`;
  });

  /**
   * ⭐ APPENDED, AND THE TYPED SENTENCE IS UNTOUCHED. "fix the bug in
   * @src/app.ts" reads correctly to a model exactly as written; substituting the
   * file into the middle of it destroys the sentence AND makes the saved
   * transcript stop matching what the person typed.
   */
  const heading = `The files referenced with @ above, attached in full${truncated ? ' (some were truncated — see the headers)' : ''}:`;

  return {
    text: `${text}\n\n${heading}\n\n${blocks.join('\n\n')}`,
    attached: attached.map(({ body, ...rest }) => rest),
    skipped,
    truncated,
    bytes: attached.reduce((n, a) => n + a.bytes, 0),
  };
}

/**
 * The lines a human sees when their `@` did or did not land.
 *
 * ⚠️ FEEDBACK IS THE POINT, NOT DECORATION. A reference that silently failed to
 * attach is indistinguishable from one that worked until the model answers about
 * a file it never received — and by then a round has been paid for.
 */
export function refSummaryLines(refs) {
  const out = [];
  if (refs?.attached?.length) {
    const names = refs.attached.map((a) => a.path).join(', ');
    out.push(`attached ${refs.attached.length} file${refs.attached.length === 1 ? '' : 's'} (${refs.bytes.toLocaleString('en-US')} bytes): ${names}`);
    for (const a of refs.attached) {
      if (a.cut) out.push(`${a.path} was cut at ${a.bytes.toLocaleString('en-US')} of ${a.of.toLocaleString('en-US')} bytes — the rest was not sent`);
    }
  }
  for (const s of refs?.skipped ?? []) out.push(`@${s.token} — ${s.why}; left as text`);
  return out;
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
  /**
   * ── ⭐⭐⭐ THE WORKSPACE ROOT, AND IT IS ONLY HERE FOR `@path` ──────────────
   *
   * ⚠️ NULL DISABLES THE FEATURE RATHER THAN GUESSING `process.cwd()`. An
   * embedder that wires nothing must not have this loop start reading files out
   * of whatever directory the process happens to be in — `resolveInWorkspace`
   * is only a boundary if somebody named the boundary.
   */
  root = null,
  /** Injected so a test can exercise the whole loop without a real tree. */
  expandRefs = expandFileRefs,
  /**
   * ── ⭐⭐ `!command` — SHELL MODE (see `lib/prompt-shell.mjs`) ──────────────────
   *
   * Injected so a test can drive it without a real shell. Only live when `root`
   * is wired: with no workspace named there is no directory to run it in, and
   * the loop keeps its old behaviour of sending the line as a task.
   */
  runShell = runShellLine,
}) {
  const interactive = input.isTTY === true;

  // ⚠️ A pipe is drained up front — see readAllLines. Doing this lazily is what
  // silently lost every prompt after the first.
  const queued = interactive ? null : await readAllLines(input);
  let queueIndex = 0;

  /**
   * ── ⚠️⚠️ READLINE IS GONE FROM THE INTERACTIVE PATH, AND IT HAD TO GO ──────
   *
   * `input-box.mjs` now owns the keyboard. Leaving the readline interface
   * attached to the SAME stream was not merely redundant — both it and the box
   * saw every Ctrl-C, so `onInterrupt` fired TWICE for one keypress. Measured,
   * not theorised: a single `\x03` produced `['interrupt', 'interrupt']`.
   *
   * ⭐ A DOUBLE INTERRUPT IS NOT A COSMETIC BUG. The second Ctrl-C is the one
   * that QUITS — so one press would have armed and fired the escape hatch in the
   * same instant, ending a session the user meant only to nudge.
   *
   * The Node-internals note below about `question()` swallowing Ctrl-C is kept
   * because it is why the box reads raw keys itself rather than asking readline
   * for a line. It is history now, not a live constraint.
   */
  const rl = null;
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
  /**
   * ⚠️⚠️ THE BANNER IS DEFERRED UNTIL AFTER THE PIN, AND THE ORDER IS NOT
   * COSMETIC. `pinRegion` CLEARS the screen so the transcript starts at the top
   * of a clean one — printed before that, the banner is erased by the very
   * thing meant to sit beneath it, which is exactly what a screenshot showed:
   * a banner cut in half with the conversation crammed at the bottom.
   */
  const writeBanner = () => { if (banner) output.write(`${banner}\n`); };
  // ⚠️ `/help` IS ADVERTISED IN THE ONE LINE EVERY SESSION PRINTS. A command
  // surface nobody is told about is the same defect item 14 closed for `--help`:
  // the feature worked and nothing a stranger would read mentioned it.
  /**
   * ⚠️ A BLANK LINE BEFORE IT, not just after. Roman: *"move it one line down."*
   * Pressed against the banner it read as a fifth detail row rather than as an
   * instruction addressed to the person.
   */
  /**
   * ⚠️ `@file` IS ADVERTISED IN THE ONE LINE EVERY SESSION PRINTS, for the same
   * reason `/help` is: a gesture nobody is told about is the built-but-invisible
   * failure this package keeps paying for. It is mentioned only when a root was
   * wired, because promising a feature the embedder disabled is worse than
   * staying quiet about it.
   */
  const writeInvitation = () => output.write(
    `\nType what you want done. "/help" for commands${root ? ', "@file" to attach one, "!cmd" to run one yourself' : ''}, "exit" to leave.\n\n`,
  );

  let history = null;
  let turns = 0;
  /**
   * ⭐ SET BY `/skills <name>`, CONSUMED BY THE NEXT REAL TURN AND THEN CLEARED.
   * A skill that was printed to the terminal would look loaded and be invisible
   * to the model; this is the variable that makes the verb real.
   */
  let pendingInject = null;
  /** `!command` results held for the next real turn — see `lib/prompt-shell.mjs`. */
  let heldShell = [];
  /** Lines the user has submitted this session — the box's Up/Down history. */
  const typed = [];

  /**
   * ── ⭐⭐⭐ THE BOX IS PINNED TO THE BOTTOM OF THE SCREEN ────────────────────
   *
   * Roman: *"we need that prompt box stuck down the bottom, it is professional."*
   *
   * `pinRegion` reserves the last three rows, so output scrolls ABOVE the box
   * and the box itself never moves. Off a TTY, in CI, on a short terminal, or
   * with ACUVO_NO_PIN=1 it does nothing at all.
   *
   * ⚠️⚠️ RELEASED ON EVERY PATH OUT, INCLUDING THE ONES NOBODY PLANS FOR. A
   * process that exits with a scroll region still set leaves the user with a
   * terminal that scrolls inside a box until they type `reset` blind — the same
   * class of harm as leaving raw mode on. The `finally` covers a normal end and
   * a throw; the signal handlers cover Ctrl-C and `kill`.
   */
  /**
   * ── ⭐⭐⭐ THE PIN IS LAZY NOW, AND THAT IS THE WHOLE LAUNCH BUG ────────────
   *
   * Roman, 2026-08-24: *"you type acuvo then the stuff appears like all the way
   * at the bottom of page."* He is describing exactly what the old line did.
   *
   * `pinRegion` reserves the LAST `rows` lines of the PHYSICAL WINDOW —
   * `bottom = height - rows`. Called before the banner on a fresh 50-row
   * terminal, that puts the banner at the top, the input box at row 50, and
   * forty lines of nothing in between. Every word of the pin is working as
   * designed; it is just the wrong design for a screen with no content yet.
   *
   * ⭐ SO IT ENGAGES ON FIRST USE INSTEAD. Until then the box renders INLINE,
   * directly under the banner, right where the command was typed — which is
   * what a terminal user expects and what every non-TUI CLI does. Once there is
   * real output to scroll, pinning starts earning its keep and takes over.
   *
   * ⚠️ INLINE IS NOT A NEW UNTESTED MODE. It is exactly the path `ACUVO_NO_PIN=1`
   * has always taken (`atRow: 0` below), so the risky half of this change is a
   * path that already ships.
   */
  let pinned = null;
  const pin = {
    get enabled() { return pinned?.enabled === true; },
    get bottom() { return pinned?.bottom ?? 0; },
    /** Engage once, when there is finally something worth scrolling past. */
    engage() {
      if (pinned || !interactive) return;
      pinned = pinRegion(output);
      if (pinned.enabled) {
        process.once('exit', releasePin);
        process.once('SIGINT', releasePin);
        process.once('SIGTERM', releasePin);
      }
    },
    release() { pinned?.release(); },
  };
  /**
   * ⚠️ REGISTERED BY `engage()`, NOT HERE. The old block asked `if (pin.enabled)`
   * at a point where the pin is now always disabled, so it would have registered
   * NOTHING — and a scroll region that is never released leaves the user with a
   * terminal that scrolls inside a box until they type `reset` blind. The
   * handlers move to the moment the region is actually set.
   */
  const releasePin = () => pin.release();

  /**
   * ⭐ NOW the banner, at the top of a screen the pin has just cleared, with the
   * conversation free to grow downward beneath it — which is the direction every
   * scrollback in existence runs.
   */
  writeBanner();
  /**
   * ⚠️ AFTER THE BANNER, AND IT WAS PRINTING BEFORE IT. The invitation is
   * addressed to somebody who has just read the banner; printed above it, it is
   * an instruction for a screen they have not seen yet.
   */
  writeInvitation();

  try {
    for (;;) {
      /**
       * ── ⭐⭐ THE INPUT IS A BOX, BECAUSE A BARE `› ` IS NOT A PLACE TO TYPE ──
       *
       * Roman, comparing against a real Claude Code screenshot: *"you can see
       * the box where you type, acuvo doesn't have that."* He is right — the
       * prompt was two characters floating in the scrollback, which reads as
       * output rather than as somewhere input goes.
       *
       * ⚠️ THE BOX OPENS BEFORE THE LINE AND CLOSES AFTER IT, deliberately.
       * Drawing all four sides up front needs absolute cursor control, and
       * readline owns the cursor once `question()` starts — every version of
       * that fights the line editor the moment input wraps, a history entry is
       * recalled, or the window is resized. Opening on entry and closing on
       * submit needs no cursor math at all, survives all three, and leaves a
       * transcript where each turn is visibly a closed unit.
       *
       * ⚠️ WIDTH IS READ FRESH EACH TURN — a terminal resized mid-session would
       * otherwise draw rules at the old width for the rest of the run. Clamped,
       * because `columns` is `undefined` when stdout is not a TTY and enormous
       * when someone maximises on an ultrawide.
       */
      let line;
      if (interactive) {
        output.write('\n');
        const got = await readBoxedLine({
          /**
           * ⭐ 0 MEANS INLINE — the box draws wherever the cursor already is,
           * directly under the banner on the first prompt. After the first turn
           * `engage()` has run, so this becomes the pinned row and the box stops
           * moving while output streams above it.
           */
          atRow: pin.enabled ? pin.bottom + 1 : 0,
          /**
           * ⚠️ DERIVED FROM `SLASH_COMMANDS`, NEVER RETYPED. A hardcoded list
           * here would be right today and wrong the first time a command is
           * added — the menu would quietly omit it, which is the same
           * built-but-invisible failure the menu exists to fix.
           *
           * ⭐ AND THE PROJECT'S OWN COMMANDS ARE IN IT. A team that checks in
           * `.acuvo/commands/ship.md` and then cannot find `/ship` in the menu
           * has a feature that only the person who wrote the file knows exists,
           * which is the same failure one directory further out. Re-read each
           * turn on purpose: a file added mid-session appears without a restart.
           */
          commands: [
            ...SLASH_COMMANDS.map((c) => c.name),
            ...userCommands(slashContext).usable.map((c) => c.name),
          ],
          paintFn: createPainter(colourEnabled({ stream: output })).brand,
          input,
          output,
          history: typed,
          onInterrupt,
        });
        line = got.value;
      } else {
        line = queueIndex < queued.length ? queued[queueIndex++] : null;
      }
      // Echo a piped prompt so a scripted transcript reads like a session.
      if (!interactive && line !== null && line.trim()) output.write(`› ${line.trim()}
`);
      // ⚠️ EOF is not an error. A closed pipe or Ctrl-D ends the session the
      // same way "exit" does — treating it as a fault would print a stack trace
      // at the end of every scripted run.
      if (line === null) break;
      /**
       * ⚠️ WHAT THE USER TYPED, kept separate from what is eventually SENT. A
       * project command replaces the second and must never replace the first:
       * the history the Up arrow walks, and the `exit` check below, are both
       * about the keystrokes, not about the expansion.
       */
      const typedTask = line.trim();
      if (!typedTask) continue;
      /**
       * ⭐ THE PIN EARNS ITS KEEP FROM HERE. The user has asked for something, so
       * output is about to stream — which is the only situation a reserved
       * bottom region improves. Before this point it only added a gap between
       * the banner and the prompt.
       *
       * Idempotent: `engage()` returns immediately once the region is set, so
       * calling it every turn costs nothing.
       */
      pin.engage();
      // ⚠️ Deduped against the PREVIOUS entry only: pressing Up should walk
      // distinct instructions, not scroll through five copies of `npm test`.
      if (typed[typed.length - 1] !== typedTask) typed.push(typedTask);
      if (QUIT.has(typedTask.toLowerCase())) break;

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
      /**
       * ⭐ A PROJECT COMMAND IS THE ONLY `/` THAT COSTS MONEY, and it is the one
       * case that must NOT `continue`. `.acuvo/commands/<name>.md` expands into
       * the text of THIS turn (`effect: 'run'`), so the loop falls through to
       * the model with `task` replaced. Everything else — `/help`, `/cost`,
       * `/clear`, `/skills` — still answers locally and spends nothing.
       */
      let task = typedTask;
      // true only when the task text is ours (/review), never what a person typed
      let generatedTask = false;
      /**
       * ── ⭐⭐ `!command` — BEFORE THE `/` SURFACE, AND IT SPENDS NOTHING ───────
       *
       * The person runs it; the output is printed now and HELD for the next
       * message they send. See `lib/prompt-shell.mjs` for why it is not the
       * model's allowlist that applies, and why it does not call the model.
       */
      const shellLine = root ? parseShellLine(typedTask) : null;
      if (shellLine) {
        if (!shellLine.command) {
          output.write('  "!" runs a command yourself: !git status · !npm test\n  Its output goes along with your next message.\n\n');
          continue;
        }
        const ran = await runShell({ command: shellLine.command, cwd: root });
        if (ran.output) output.write(`${ran.output}\n`);
        const status = ran.error ? `could not run: ${ran.error}` : ran.timedOut ? 'killed after the timeout' : `exit ${ran.exitCode}`;
        heldShell.push({ command: shellLine.command, ...ran });
        output.write(`  (${status} — this output goes along with your next message)\n\n`);
        continue;
      }
      const command = parseSlash(line.trim());
      if (command) {
        const result = runSlashCommand(command, slashContext);
        for (const l of result.output ?? []) output.write(`${l}\n`);
        output.write('\n');
        if (result.effect === 'clear') { history = null; heldShell = []; }
        /**
         * ── ⭐⭐ `/resume <id>` — THE HISTORY IS SWAPPED HERE, NOT IN `slash.mjs` ─
         *
         * ⚠️ SAME SEAM AS `effect: 'clear'`, AND FOR THE SAME REASON: this loop
         * owns `history`, so it is the only place that may replace it. The
         * messages arrived as plain data from a provider that read them off
         * disk, so `slash.mjs` still touches no filesystem to make this work.
         *
         * ⚠️ TRIMMED ON THE WAY IN. A saved run can hold far more turns than
         * this session's ceiling; handing them straight to `runOne` would send
         * a prompt longer than any turn this session has ever built, on the
         * turn immediately after a command that printed "nothing was re-run".
         */
        if (result.effect === 'resume' && Array.isArray(result.messages) && result.messages.length > 0) {
          history = trimHistory(result.messages, maxHistory);
        }
        /**
         * ── ⭐⭐⭐ `/doctor` — THE ONE COMMAND THAT LEAVES THE MACHINE ───────
         *
         * ⚠️ THE AWAIT IS HERE BECAUSE THIS LOOP IS ALREADY ASYNC. `slash.mjs`
         * is pure by contract and `runSlashCommand` is synchronous; making it
         * return promises so one command could probe the network would have
         * changed all twelve, every caller and every test. The `effect` seam
         * already existed for exactly this, so `/doctor` cost one case here.
         *
         * ⚠️ IT CANNOT TAKE THE SESSION DOWN. `runDoctor` is bounded twice
         * internally, but a provider that throws on a machine with no network
         * must print a line, not a stack trace over somebody's conversation.
         */
        if (result.effect === 'doctor' && typeof slashContext.doctor === 'function') {
          try {
            const report = await slashContext.doctor();
            const text = Array.isArray(report) ? report.join('\n') : String(report ?? '');
            if (text.trim()) output.write(`${text}\n\n`);
            else output.write('  the doctor returned nothing to report.\n\n');
          } catch (err) {
            output.write(`  the check could not be completed: ${String(err?.message ?? err)}\n\n`);
          }
        }
        /**
         * ── ⭐⭐ `/compact` · `/context` · `/review` — THE PARITY EFFECTS ─────
         *
         * Same seam as `/doctor`: this loop owns `history` and is already
         * async, so the two that read or rewrite the history and the one that
         * awaits git live here. `/review` is the second `/` that may spend:
         * when the provider hands back a `task`, it becomes THIS turn, exactly
         * like a project command's `effect: 'run'`.
         */
        let reviewTask = null;
        if (result.effect === 'context') {
          for (const l of describeContext(history, { budgetTokens: slashContext.contextBudgetTokens ?? null })) output.write(`  ${l}\n`);
          output.write('\n');
        }
        if (result.effect === 'compact') {
          const before = Array.isArray(history) ? estimateMessagesTokens(history) : 0;
          if (Array.isArray(history) && history.length > 0 && typeof slashContext.onCompact === 'function') {
            try { await slashContext.onCompact('pre', { estimatedTokens: before, messages: history.length }); } catch { /* advisory */ }
          }
          const done = compactHistory(history, { targetTokens: result.targetTokens ?? null });
          if (done.changed) history = done.messages;
          for (const l of done.lines) output.write(`  ${l}\n`);
          output.write('\n');
          if (done.changed && typeof slashContext.onCompact === 'function') {
            try { await slashContext.onCompact('post', { beforeTokens: done.before, afterTokens: done.after, messages: history.length }); } catch { /* advisory */ }
          }
        }
        if (result.effect === 'review' && typeof slashContext.review === 'function') {
          try {
            const rev = await slashContext.review(result.args ?? '');
            for (const l of rev?.lines ?? []) output.write(`  ${l}\n`);
            output.write('\n');
            if (typeof rev?.task === 'string' && rev.task) reviewTask = rev.task;
          } catch (err) {
            output.write(`  the review could not be completed: ${String(err?.message ?? err)}\n\n`);
          }
        }
        if (typeof result.inject === 'string' && result.inject) pendingInject = result.inject;
        if (result.effect === 'run' && typeof result.task === 'string' && result.task) {
          task = result.task;
        } else if (reviewTask) {
          task = reviewTask;
          generatedTask = true;
        } else {
          continue;
        }
      }

      /**
       * ── ⭐⭐⭐ `@path` — RESOLVED HERE, AND DELIBERATELY NOT LATER ──────────
       *
       * ⚠️ IT RUNS ON WHAT THE PERSON TYPED (or on a project command's
       * expansion, which is text a human checked into the repo) AND NOT ON THE
       * INJECTED SKILL. A skill document is prose we ship: it can legitimately
       * contain `@media`, `@decorator` or an email, and scanning it would be
       * scanning thousands of words for references nobody wrote as references.
       *
       * ⭐ AND THE FEEDBACK IS PRINTED, ALWAYS. A reference that failed to
       * attach is indistinguishable from one that worked right up until the
       * model answers about a file it never received — by which point a whole
       * round has been paid for.
       */
      // ⚠️ NOT on a task WE generated: /review's diff is full of `@@ -1,3 +1,3 @@`
      // hunk headers, and each was announced as "@@ — no such file" (measured
      // 2026-10-01 driving the binary). Same reason the injected skill is exempt.
      if (root && !generatedTask) {
        const refs = expandRefs(root, task);
        task = refs.text;
        for (const l of refSummaryLines(refs)) output.write(`  ${l}\n`);
        if (refs.attached.length || refs.skipped.length) output.write('\n');
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
      /** ⚠️ Cleared BEFORE the call, like `pendingInject`, so a failed turn cannot re-send it forever. */
      if (heldShell.length > 0) {
        sendTask = `${sendTask}\n\n---\n\n${shellContextBlock(heldShell)}`;
        heldShell = [];
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
    pin.release();
    // ⚠️ The listeners come off too — a long-lived process that started several
    // sessions would otherwise accumulate them and warn about a leak.
    process.off('exit', releasePin);
    process.off('SIGINT', releasePin);
    process.off('SIGTERM', releasePin);
  }
  return { turns };
}
