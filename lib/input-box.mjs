/**
 * ── ⭐⭐⭐ A PERSISTENT INPUT BOX, BECAUSE READLINE CANNOT DRAW ONE ──────────
 *
 * Roman, repeatedly: *"the box that I am typing in right now needs to be real."*
 *
 * ── ⚠️⚠️ WHY READLINE WAS NEVER GOING TO WORK, MEASURED ─────────────────────
 *
 * Pre-drawing a four-sided box and asking `readline.question()` to type inside
 * it produces this on the very first keystroke:
 *
 *     \x1b[1G\x1b[0J
 *
 * Column 1, then **clear to end of screen**. Readline owns everything from the
 * cursor down and erases it to redraw the line — so the bottom border and the
 * right edge are gone before the user has typed a second character. No amount of
 * re-drawing wins that fight; it repaints on every key.
 *
 * ⭐ SO THE ANSWER IS TO OWN THE RENDER. This is a small raw-mode line editor:
 * it reads keys, keeps the buffer, and paints three lines itself. That is what
 * every terminal app with a real input box does, and it is why they can have one.
 *
 * ── ⚠️ WHAT IT MUST NOT LOSE ────────────────────────────────────────────────
 *
 * A half-built line editor is WORSE than a plain prompt: backspace that does
 * nothing, or an arrow key that prints `^[[D`, makes the tool feel broken in a
 * way `› ` never did. So the keys people actually use are all handled —
 * backspace, delete, left/right, home/end, word-left/right, history up/down,
 * Ctrl-C, Ctrl-D, Ctrl-U/K/W — and each is tested.
 */

const ESC = '\x1b';
const CSI = `${ESC}[`;

/**
 * ── ⚠️⚠️ A CLOSED TERMINAL MUST NOT BECOME A STACK TRACE FROM THE RENDERER ──
 *
 * Every write in this file goes to somebody's terminal, and a terminal can be
 * closed at any point during a paint — a shell window shut mid-render, a `head`
 * that stopped reading, an ssh session dropped. `stream.write` on a destroyed
 * stream is not always asynchronous: `ERR_STREAM_DESTROYED` and
 * `ERR_STREAM_WRITE_AFTER_END` can arrive as a throw, straight out of `paint`,
 * from inside a keystroke handler where nothing is waiting to catch it.
 *
 * ⭐ The asynchronous half of the same class — `EPIPE` emitted on the stream —
 * is handled once, globally, in `lib/interrupt.mjs`. This is the synchronous
 * half, and it is here because it is this module's writes that are unwinding.
 * Neither covers the other.
 *
 * ⚠️ IT IS DELIBERATELY TOTAL. There is no useful failure mode for "I could not
 * draw the input box": the place we would report it to is the stream that just
 * failed.
 */
function safeWrite(output, text) {
  try { output?.write?.(text); return true; } catch { return false; }
}

/**
 * ── ⭐⭐⭐ PUT THE TERMINAL BACK. THE ONE THING A CLI MUST NEVER GET WRONG ────
 *
 * Raw mode off, cursor visible, colour reset — in that order, in one write.
 *
 * ⚠️ THE HARM IS ASYMMETRIC AND THAT IS WHY THIS EXISTS. Leaving raw mode on
 * hands somebody a shell with no echo and no line editing: their keystrokes go
 * nowhere visible, Ctrl-C does nothing, and the only way out is typing `reset`
 * blind. A hidden cursor is milder and just as confusing — the shell looks
 * frozen. Neither is recoverable by the user's own reflexes, and both are
 * invisible in every unit test, which is exactly why they survive.
 *
 * ⚠️ NODE'S OWN `ResetStdio` COVERS *SOME* OF THIS AND NONE OF THE REST. It
 * restores the termios/console mode it captured at startup, so raw mode is
 * usually put back on a clean `process.exit`. It knows nothing about the escape
 * sequences WE wrote — the hidden cursor, an open SGR — because those went out
 * as ordinary bytes. Only we can undo those, so we do, on the way out.
 *
 * @param {{ input?: any, output?: any }} io
 */
export function restoreTerminal({ input, output } = {}) {
  try { input?.setRawMode?.(false); } catch { /* not a TTY any more */ }
  // ESC[?25h — show cursor.  ESC[0m — reset every attribute we might have set.
  // ESC[?2004l — bracketed paste off (see `BRACKETED_PASTE_ON`). A terminal left
  // in that mode wraps every later paste in the SHELL with `200~`…`201~` junk.
  safeWrite(output, `${CSI}?25h${CSI}0m${CSI}?2004l`);
}

/** Keys that are not text. Kept as one table so the handler stays readable. */
const KEY = Object.freeze({
  ENTER: '\r',
  NEWLINE: '\n',
  BACKSPACE: '\x7f',
  BACKSPACE_ALT: '\b',
  CTRL_C: '\x03',
  CTRL_D: '\x04',
  CTRL_U: '\x15',
  CTRL_K: '\x0b',
  CTRL_W: '\x17',
  CTRL_A: '\x01',
  CTRL_E: '\x05',
  TAB: '\t',
});

/**
 * ── ⭐⭐ MULTI-LINE INPUT — A PASTE MUST NOT BE SENT ONE LINE AT A TIME ────────
 *
 * ⚠️ MEASURED 2026-09-26 (parity audit against Claude Code's interactive-mode
 * docs): pasting a three-line stack trace into the box submitted LINE ONE as
 * the whole task and threw lines two and three away — `onData` hit the first
 * `\r`, finished the read, and returned without looking at the rest of the
 * chunk. That is a paid turn spent on a third of what the person meant, and a
 * stack trace is the commonest thing anybody pastes into a coding agent.
 *
 * Three ways in, all of them ones Claude Code documents:
 *
 *   · BRACKETED PASTE — the terminal wraps a paste in `ESC[200~`…`ESC[201~`,
 *     so every newline inside it is TEXT, not Enter. Switched on while the box
 *     is reading, off again on every exit path (`restoreTerminal` too).
 *   · A CHUNK WITH A NEWLINE IN THE MIDDLE — the fallback for terminals that do
 *     not bracket (older conhost). A human pressing Enter produces a chunk that
 *     ENDS in `\r`; a paste has text after one. A paste's trailing newline is
 *     dropped rather than obeyed: pasting must never send.
 *   · `\` + Enter and Alt+Enter — a newline typed on purpose.
 *
 * ⚠️ THE NEWLINE IS DRAWN AS `⏎`. The box is one row by design (see
 * `renderBox`); a real line break inside it would push the rule down and the
 * box would stop being a box. One glyph for one character keeps every piece of
 * cursor arithmetic in this file exactly as it was.
 */
export const BRACKETED_PASTE_ON = `${CSI}?2004h`;
export const BRACKETED_PASTE_OFF = `${CSI}?2004l`;
export const PASTE_START = `${CSI}200~`;
export const PASTE_END = `${CSI}201~`;
/** Alt+Enter: ESC then CR, which `splitKeys` keeps together as one key. */
export const ALT_ENTER = `${ESC}\r`;
/** How a newline in the buffer is drawn. */
export const NEWLINE_GLYPH = '⏎';

/**
 * A chunk that is a paste the terminal did not bracket, re-shaped into one.
 *
 * ⚠️ ONLY WHEN A NEWLINE HAS TEXT AFTER IT. `hi\r` in one chunk is somebody
 * typing fast and pressing Enter — and it is exactly what the existing tests
 * (and every scripted driver of this box) write. Treating that as a paste would
 * turn Enter off for all of them.
 *
 * @param {string} chunk
 * @returns {string}
 */
export function bracketBarePaste(chunk) {
  const s = String(chunk ?? '');
  if (s.includes(PASTE_START)) return s;
  const body = s.replace(/(\r\n|\r|\n)$/, '');
  if (!/[\r\n]/.test(body) || !/[^\r\n]/.test(body)) return s;
  return `${PASTE_START}${body}${PASTE_END}`;
}

/**
 * Complete a half-typed `/command` against the list the menu already shows.
 *
 * ⭐ LONGEST COMMON PREFIX, AND A SPACE ONLY WHEN THE MATCH IS UNIQUE. `/co`
 * with `config` and `cost` has nothing to add (the menu row already lists
 * both); `/con` becomes `/config ` ready for arguments. That is shell
 * completion, and it is what Claude Code's Tab does at the prompt.
 *
 * @returns {string|null} the completed value, or null when Tab does nothing
 */
export function completeSlash(value, commands = []) {
  const m = /^\/(\S*)$/.exec(String(value ?? ''));
  if (!m) return null;
  const typed = m[1].toLowerCase();
  const matches = [...new Set(commands)].filter((c) => c.startsWith(typed)).sort();
  if (matches.length === 0) return null;
  if (matches.length === 1) return `/${matches[0]} `;
  let prefix = matches[0];
  for (const c of matches) {
    while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix.length > typed.length ? `/${prefix}` : null;
}

/**
 * Visible width of a string, ignoring ANSI. Deliberately simple: this package
 * has no dependencies and a full grapheme/east-asian-width implementation is a
 * library. It is correct for the ASCII and box characters we draw, and errs by
 * over-counting a wide glyph rather than under — which wraps early rather than
 * overflowing the border.
 */
export function visibleWidth(s) {
  return String(s ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').length;
}

/**
 * Render the three lines of the box for a given buffer.
 *
 * Exported so the layout can be asserted without a terminal — the render and
 * the key handling are separately testable, which is the only way a thing like
 * this stays correct.
 *
 * @returns {{lines: string[], cursorColumn: number}} 1-based cursor column
 */
/**
 * The names offered by the slash menu. Passed in rather than imported so this
 * module keeps no opinion about what commands exist — `slash.mjs` owns that
 * list, and a second copy here would drift the first time one is added.
 */
export const DEFAULT_COMMANDS = Object.freeze(['help', 'skills', 'mcp', 'cost', 'model', 'clear']);

export function renderBox({ value = '', cursor = 0, columns = 80, prompt = '› ', commands = DEFAULT_COMMANDS } = {}) {
  /**
   * ── ⚠️ FULL WIDTH. THE 100-COLUMN CAP WAS WRONG AND IT LOOKED WRONG ────────
   *
   * Roman, from a screenshot: *"ours isn't the entire width."* In a ~200-column
   * terminal a 100-column box reads as a half-finished element rather than as a
   * deliberate measure — it is the input, and the input should be as wide as the
   * place you are typing.
   *
   * ⚠️ `columns - 1`, NOT `columns`. A box drawn to the very last column makes
   * many terminals wrap to the next row the moment the final border character is
   * written, which pushes everything down by one and breaks the cursor
   * arithmetic for the rest of the session.
   */
  const width = Math.max(20, columns - 1);
  const inner = width - 2;
  const promptWidth = visibleWidth(prompt);

  /**
   * ⚠️ THE VIEW SCROLLS, THE BUFFER DOES NOT. A long line must not wrap — a
   * wrapped line pushes the bottom border down and the box stops being a box.
   * So the buffer is windowed around the cursor and the border stays put, which
   * is what every real input does.
   */
  const room = inner - promptWidth - 1;
  let start = 0;
  if (cursor > room) start = cursor - room;
  const shown = value.slice(start, start + room).replace(/\n/g, NEWLINE_GLYPH);

  const body = `${prompt}${shown}`;
  const pad = ' '.repeat(Math.max(0, width - visibleWidth(body)));

  /**
   * ── ⚠️⚠️ A RULE AND A PROMPT — NOT A BOX. THE SCREENSHOT SETTLED IT ─────────
   *
   * I built a four-sided box because Roman said "copy Claude's box exactly", and
   * a screenshot of the real thing shows there IS no box: a horizontal rule
   * across the full width, then `❯ ` beneath it. The submitted line gets a
   * subtle highlight bar rather than a border.
   *
   * ⭐ AND THE RULE IS WHY IT LOOKS SETTLED RATHER THAN DRAWN. Two borders and
   * two side walls make the input an object floating in the terminal; one rule
   * makes it the bottom of the page. Roman: *"ours is organised weirdly."*
   *
   * ⚠️ Two rows, not three — so the reserved region shrinks with it and the
   * transcript gets a row back.
   */
  /**
   * ── ⭐⭐⭐ THE SLASH MENU — WHAT YOU CAN DO, AT THE MOMENT YOU ASK ───────────
   *
   * Roman: *"when users do a special Acuvo command it changes the colour and
   * also shows you your options in a dropdown."*
   *
   * ⭐ THIS IS THE DISCOVERABILITY FIX, NOT DECORATION. 28 skills, 7 commands,
   * MCP in both directions — all built, and nothing on screen ever mentioned
   * any of it. A capability nobody is shown is worth zero, which is the same
   * defect as the toolbox and the whiteboard. Typing one character is the
   * cheapest possible moment to answer "what can this thing do".
   *
   * ⚠️ IT REPLACES THE RULE RATHER THAN ADDING A ROW. The input lives in a
   * reserved region of fixed height; growing it would mean resizing the scroll
   * region mid-keystroke, and a region that changes size while a transcript is
   * scrolling through it is how the display gets corrupted. The rule is already
   * a full-width line doing nothing — so it becomes the menu while a command is
   * being typed, and goes back to being a rule the moment it is not.
   */
  const slash = /^\/(\S*)$/.exec(value);
  let rule = '─'.repeat(width);
  if (slash) {
    const typed = slash[1].toLowerCase();
    const matches = commands.filter((c) => c.startsWith(typed));
    /**
     * ⚠️ NO MATCHES IS ITS OWN ANSWER. Falling back to the full list would tell
     * somebody who mistyped that everything is fine; saying so is what lets them
     * fix it.
     */
    const shown = matches.length ? matches.map((c) => `/${c}`).join('  ') : 'no command starts with that';
    const label = `  ${shown}  `;
    rule = visibleWidth(label) >= width
      ? label.slice(0, width)
      : `${label}${'─'.repeat(width - visibleWidth(label))}`;
  }

  return {
    lines: [rule, `${body}${pad}`],
    // 1-based, and there is no left border to skip any more.
    cursorColumn: 1 + promptWidth + (cursor - start),
    /** True while a slash command is being typed — the caller paints it. */
    isCommand: Boolean(slash),
  };
}

/**
 * Apply one keypress to the editor state.
 *
 * ⚠️ PURE, AND THAT IS THE WHOLE POINT. Every key can be tested without a TTY,
 * without timing, and without a terminal to inspect afterwards. The half of this
 * module that touches the terminal does nothing but paint what this returns.
 *
 * @returns {{value, cursor, historyIndex, done?: 'submit'|'cancel'|'eof'}}
 */
export function applyKey(state, key) {
  const { value, cursor, history = [], historyIndex = history.length } = state;
  /**
   * ⚠️ `history` IS CARRIED THROUGH, AND ITS ABSENCE WAS A REAL BUG. The first
   * version returned only `{value, cursor, historyIndex}` — so the history array
   * was dropped by the FIRST keystroke, and pressing Up afterwards silently did
   * nothing. It looked like the history feature was unimplemented rather than
   * like state was being lost, which is exactly the kind of bug a pure function
   * makes visible and a stateful one hides.
   */
  const keep = (over = {}) => ({
    value, cursor, history, historyIndex, draft: state.draft,
    pasting: state.pasting === true, commands: state.commands, ...over,
  });
  const insert = (text, over = {}) => keep({
    value: value.slice(0, cursor) + text + value.slice(cursor), cursor: cursor + text.length, ...over,
  });

  /** ⭐ MULTI-LINE — see `BRACKETED_PASTE_ON` for the measured defect. */
  if (key === PASTE_START) return keep({ pasting: true, lastPasteKey: null });
  if (key === PASTE_END) return keep({ pasting: false, lastPasteKey: null });
  if (state.pasting === true) {
    if (key === KEY.ENTER || key === KEY.NEWLINE) {
      /** A CRLF paste arrives as `\r` then `\n`: ONE line break, not two. */
      if (key === KEY.NEWLINE && state.lastPasteKey === KEY.ENTER) return keep({ lastPasteKey: null });
      return insert('\n', { lastPasteKey: key });
    }
    if (key === KEY.TAB) return insert('\t', { lastPasteKey: null });
  }
  if (key === ALT_ENTER) return insert('\n');
  if (key === KEY.ENTER || key === KEY.NEWLINE) {
    /**
     * ⭐ `\` + Enter CONTINUES THE LINE — the one multi-line method Claude Code
     * says works in every terminal. The backslash is consumed, not sent.
     */
    if (cursor > 0 && value[cursor - 1] === '\\') {
      return keep({ value: `${value.slice(0, cursor - 1)}\n${value.slice(cursor)}`, cursor });
    }
    return keep({ done: 'submit' });
  }
  if (key === KEY.TAB) {
    const done = completeSlash(value, state.commands ?? []);
    return done === null ? keep() : keep({ value: done, cursor: done.length });
  }
  if (key === KEY.CTRL_C) return keep({ done: 'cancel' });
  /**
   * ⚠️ Ctrl-D IS EOF ONLY ON AN EMPTY LINE. On a line with text it is
   * forward-delete — collapsing the two would exit the session when someone
   * meant to delete a character, which is a data-loss-shaped surprise.
   */
  if (key === KEY.CTRL_D) {
    if (value.length === 0) return keep({ done: 'eof' });
    return keep({ value: value.slice(0, cursor) + value.slice(cursor + 1) });
  }

  if (key === KEY.BACKSPACE || key === KEY.BACKSPACE_ALT) {
    if (cursor === 0) return keep();
    return keep({ value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 });
  }

  if (key === KEY.CTRL_U) return keep({ value: value.slice(cursor), cursor: 0 });
  if (key === KEY.CTRL_K) return keep({ value: value.slice(0, cursor) });
  if (key === KEY.CTRL_A) return keep({ cursor: 0 });
  if (key === KEY.CTRL_E) return keep({ cursor: value.length });

  if (key === KEY.CTRL_W) {
    const upto = value.slice(0, cursor);
    const cut = upto.replace(/\s*\S+$/, '');
    return keep({ value: cut + value.slice(cursor), cursor: cut.length });
  }

  // Arrows and Home/End arrive as escape sequences.
  if (key === `${CSI}D`) return keep({ cursor: Math.max(0, cursor - 1) });
  if (key === `${CSI}C`) return keep({ cursor: Math.min(value.length, cursor + 1) });
  if (key === `${CSI}H` || key === `${CSI}1~`) return keep({ cursor: 0 });
  if (key === `${CSI}F` || key === `${CSI}4~`) return keep({ cursor: value.length });
  if (key === `${CSI}3~`) return keep({ value: value.slice(0, cursor) + value.slice(cursor + 1) });

  /**
   * History. ⚠️ The index may sit one PAST the end — that position is "the line
   * I was typing", so walking up and back down returns what you had rather than
   * silently eating it.
   */
  if (key === `${CSI}A`) {
    if (historyIndex === 0 || history.length === 0) return keep();
    const i = historyIndex - 1;
    /**
     * ⚠️ THE DRAFT IS SAVED ON THE WAY UP. Leaving it behind means a half-typed
     * line is destroyed by a single Up press — the user glances at what they ran
     * before, comes back, and their sentence is gone. Losing typed input to a
     * navigation key is the least forgivable bug a line editor can have.
     */
    const draft = historyIndex === history.length ? value : state.draft;
    return keep({ value: history[i], cursor: history[i].length, historyIndex: i, draft });
  }
  if (key === `${CSI}B`) {
    if (historyIndex >= history.length) return keep({ draft: state.draft });
    const i = historyIndex + 1;
    const next = i === history.length ? (state.draft ?? '') : history[i];
    return keep({ value: next, cursor: next.length, historyIndex: i, draft: state.draft });
  }

  /**
   * ⚠️ EVERYTHING ELSE CONTROL-SHAPED IS DROPPED, NOT INSERTED. An unhandled
   * escape sequence typed into the buffer shows the user `^[[5~` and looks like
   * the tool is broken — the one impression a new line editor cannot afford.
   */
  if (key.startsWith(ESC)) return keep();
  if (key.length === 1 && key < ' ') return keep();

  return keep({ value: value.slice(0, cursor) + key + value.slice(cursor), cursor: cursor + key.length });
}

/**
 * Split a raw chunk into keys. A paste arrives as one chunk and an arrow key as
 * three bytes, so neither "one byte per key" nor "one chunk per key" is right.
 */
export function splitKeys(chunk) {
  const s = String(chunk);
  const keys = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === ESC) {
      const m = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(s.slice(i));
      if (m) { keys.push(m[0]); i += m[0].length - 1; continue; }
      /** Alt+Enter — kept whole, or the ESC is dropped and the CR submits. */
      if (s[i + 1] === '\r') { keys.push(ALT_ENTER); i += 1; continue; }
    }
    keys.push(s[i]);
  }
  return keys;
}

/**
 * Draw the box and park the cursor inside it.
 *
 * ⚠️ THE CURSOR IS HIDDEN WHILE PAINTING. Without it, the cursor visibly darts
 * to the end of each border as it is written — which reads as a flicker and is
 * the difference between a rendered box and a drawn one.
 */
export function paint(output, state, { first = false, atRow = 0, paintFn = null } = {}) {
  const r = renderBox(state);
  const { cursorColumn } = r;
  /**
   * ── ⭐ THE INPUT TURNS BRAND GREEN WHILE A COMMAND IS BEING TYPED ──────────
   *
   * Roman: *"it changes the colour and also shows you your options."* The colour
   * is the faster half of that — it says "you are in a different mode" before
   * anyone has read a single menu entry.
   *
   * ⚠️ THE PAINTER IS INJECTED and colour is applied AFTER layout, never before:
   * escape codes have no width, so colouring a string and then padding it aligns
   * the text against invisible bytes. `renderBox` stays pure and returns plain
   * text; this is the only place that knows about colour.
   */
  const brand = (paintFn && r.isCommand) ? paintFn : null;
  const lines = brand ? r.lines.map((l) => brand(l)) : r.lines;

  /**
   * ── ⭐⭐⭐ PINNED: DRAW AT AN ABSOLUTE ROW, NOT WHEREVER THE CURSOR IS ───────
   *
   * Roman, from a screenshot: *"the text is going underneath instead of above,
   * and it makes a new box."* Two boxes on screen, output between them.
   *
   * The cause: `pinRegion` reserved the bottom rows but this function still drew
   * RELATIVE to the cursor. So the box was painted inline, scrolled away with
   * the transcript, and the next turn painted a fresh one lower down — the
   * reserved rows sat empty while the box wandered.
   *
   * ⭐ When pinned, the box has a FIXED HOME. `ESC[{row};1H` puts it there every
   * time, so output scrolling above it cannot move it and no second box can
   * exist.
   */
  if (atRow > 0) {
    const rows = lines.map((l, i) => `${CSI}${atRow + i};1H${CSI}2K${l}`).join('');
    safeWrite(output, `${CSI}?25l${rows}${CSI}${atRow + 1};${cursorColumn}H${CSI}?25h`);
    return;
  }

  /**
   * ── ⚠️⚠️ THE CURSOR MATH, AND MY FIRST VERSION ATE THE SCREEN ──────────────
   *
   * Roman: *"it moves upwards every time you type a character then deletes the
   * design you did."* Exactly right, and the arithmetic says why.
   *
   * After a paint the cursor rests on the INPUT line — line 2 of 3, not below
   * the box. The first version began each repaint with `ESC[3A`, which is where
   * it would be if the cursor were below. From line 2, moving up 3 lands ONE
   * LINE ABOVE the top border — and the `ESC[0J` that follows clears from there
   * to the bottom of the screen. So every keystroke crept upward and erased
   * another line of the banner.
   *
   * ⭐ THE INVARIANT, WRITTEN DOWN BECAUSE IT IS THE WHOLE FUNCTION: this
   * routine ENTERS with the cursor on the input line and LEAVES it there. So a
   * repaint moves up exactly ONE line to reach the top border, and the final
   * reposition moves up exactly one from the last line written.
   *
   *   ╭────────╮   <- line 1   ESC[1A from the input line reaches here
   *   │› …      │   <- line 2   cursor lives here, in and out
   *   ╰────────╯   <- line 3   cursor is here after writing; ESC[1A returns
   *
   * ⚠️ NO TRAILING NEWLINE. Writing one after the last border scrolls the
   * viewport when the box is at the bottom of the screen, and every subsequent
   * `up` is then off by a row for the rest of the session.
   */
  /**
   * ⚠️ THE ROW MATH FOLLOWS THE ROW COUNT, and it changed when the box became a
   * rule. With TWO rows the cursor already ends on the prompt line after the
   * write, so there is no reposition to make — the old `ESC[1A` was correct for
   * three rows and would now land on the RULE, one row too high, which is the
   * same off-by-one that walked the box up the screen before.
   */
  const home = first ? '' : `\r${CSI}${lines.length - 1}A`;
  safeWrite(
    output,
    `${CSI}?25l${home}${CSI}0J${lines.join('\n')}` +
    `\r${CSI}${cursorColumn}G${CSI}?25h`,
  );
}

/**
 * ── ⭐⭐⭐ THE ONLY PART THAT TOUCHES A TERMINAL ─────────────────────────────
 *
 * Reads one line inside the box. Everything decision-shaped lives in `applyKey`
 * and `renderBox`, which are pure and fully tested; this function does nothing
 * but move bytes and paint what they return.
 *
 * @returns {Promise<{value: string|null, reason: 'submit'|'cancel'|'eof'}>}
 */
export function readBoxedLine({ input, output, history = [], onInterrupt = null, prompt = '› ', atRow = 0, commands = DEFAULT_COMMANDS, paintFn = null, lifecycle = process }) {
  return new Promise((resolve) => {
    let state = { value: '', cursor: 0, history, historyIndex: history.length, draft: '', commands };
    const columns = () => output.columns ?? process.stdout.columns ?? 80;

    /**
     * ── ⭐⭐⭐ THE WINDOW THIS CLOSES IS THE ONE THE USER SPENDS MOST TIME IN ──
     *
     * Between `setRawMode(true)` at the bottom of this function and `finish`,
     * the process is sitting in raw mode waiting for a human to type — which is
     * where an interactive session spends nearly all of its wall-clock life. A
     * `kill`, a supervisor's SIGTERM, an `exit()` from one of the five signal
     * handlers, or an uncaught throw from any other part of the program all end
     * the process from HERE, and `finish` never runs.
     *
     * ⚠️ AND `finish` IS THE ONLY PLACE THAT PUTS THE TERMINAL BACK. Every path
     * out of the read that is not a submitted line — which is every path that is
     * not the user's own doing — skipped it entirely.
     *
     * ⭐ `'exit'` is the right hook and it is not the obvious one. It fires on an
     * explicit `process.exit`, on an uncaught exception (measured: the handler
     * ran, then the stack printed), and on the loop emptying. It does NOT fire
     * on a signal that kills the process outright — but every signal this
     * package registers exits by calling `process.exit(128+n)`, so the hook runs
     * for those too. What it cannot cover is SIGKILL and a closed terminal, and
     * in both of those there is no terminal left to restore.
     *
     * ⚠️ REMOVED BY `finish`, not left behind. `chat.mjs` calls this once per
     * turn; a hook per turn would be a listener leak and Node would eventually
     * print a MaxListenersExceededWarning at the user, mid-conversation — the
     * exact defect `turn.mjs`'s registry header already records.
     */
    const restore = () => restoreTerminal({ input, output });
    try { lifecycle?.once?.('exit', restore); } catch { /* an injected stub without hooks */ }

    /**
     * ⚠️ RAW MODE IS RESTORED ON EVERY EXIT PATH, INCLUDING THE UNHAPPY ONES.
     * A process that leaves the terminal in raw mode hands the user a shell with
     * no echo and no line editing — they have to type `reset` blind. That is the
     * single worst thing a CLI can do to somebody's session.
     */
    let finished = false;
    const finish = (value, reason) => {
      if (finished) return;
      finished = true;
      input.off('data', onData);
      input.off('end', onEnd);
      if (input.isTTY === true) safeWrite(output, BRACKETED_PASTE_OFF);
      try { lifecycle?.off?.('exit', restore); } catch { /* an injected stub without hooks */ }
      try { input.setRawMode?.(false); } catch { /* not a TTY any more */ }
      if (atRow > 0) {
        /**
         * ── ⭐⭐⭐ PINNED: THE BOX STAYS, THE ANSWER GOES ABOVE IT ─────────────
         *
         * Roman, from a screenshot: *"the text is going underneath instead of
         * above, and it makes a new box."*
         *
         * With a reserved region the box has a permanent home in the bottom
         * rows. What the user typed belongs in the TRANSCRIPT, so it is echoed
         * into the scrolling area and the box is repainted empty — one box,
         * always in the same place, with history flowing upward past it.
         *
         * ⚠️ The cursor is left at the bottom of the SCROLL REGION, so whatever
         * prints next (the reply, an MCP warning, anything) lands above the box
         * instead of on top of it.
         */
        safeWrite(output, `${CSI}${atRow - 1};1H\n${prompt}${value ?? ''}\n`);
        paint(output, { value: '', cursor: 0, columns: output.columns ?? 80, commands }, { atRow, paintFn });
        safeWrite(output, `${CSI}${atRow - 1};1H`);
      } else {
        /**
         * ── ⚠️⚠️ UNPINNED: MOVE BELOW THE BOX BEFORE ANYTHING ELSE WRITES ────
         *
         * Seen in an earlier screenshot: an MCP warning printed straight ON TOP
         * of the bottom border. The cursor rests on the INPUT line — line 2 of 3
         * — so a bare `\n` lands it on the border row and the next write
         * destroys it. Down one FIRST, then a newline.
         */
        safeWrite(output, `${CSI}1B\n`);
      }
      resolve({ value, reason });
    };

    const onEnd = () => finish(null, 'eof');

    const onData = (chunk) => {
      for (const key of splitKeys(bracketBarePaste(chunk))) {
        const next = applyKey(state, key);
        if (next.done === 'submit') {
          state = next;
          // Repaint once so the committed line is what stays on screen.
          paint(output, { ...state, columns: columns(), commands }, { atRow, paintFn });
          return finish(state.value, 'submit');
        }
        if (next.done === 'cancel') {
          /**
           * ⚠️ Ctrl-C ON A NON-EMPTY LINE CLEARS IT; on an empty one it means
           * "stop". Anything else makes the first Ctrl-C — the one people press
           * to abandon a sentence — quit the whole session.
           */
          /**
           * ⚠️⚠️ Ctrl-C NEVER ENDS THE READ — it clears the line and hands the
           * event on. The first version finished with `cancel` on an empty line,
           * which ended the session on the FIRST press: there was then no prompt
           * for a second Ctrl-C to arrive at, so the "press again to quit"
           * escape hatch could never fire. `onInterrupt` owns that decision (see
           * `interrupt.mjs`), and it can only own it if it keeps being called.
           *
           * ⭐ It is also what every shell does: Ctrl-C gives you a fresh line.
           * Quitting is `exit`, or Ctrl-D on an empty one.
           */
          state = { ...state, value: '', cursor: 0, historyIndex: history.length, draft: '', pasting: false };
          onInterrupt?.();
          paint(output, { ...state, columns: columns(), commands }, { atRow, paintFn });
          continue;
        }
        if (next.done === 'eof') return finish(null, 'eof');
        state = next;
        paint(output, { ...state, columns: columns(), commands }, { atRow, paintFn });
      }
    };

    try { input.setRawMode?.(true); } catch { /* not a TTY */ }
    input.resume?.();
    /** Only on a real terminal: a pipe has no paste to bracket. */
    if (input.isTTY === true) safeWrite(output, BRACKETED_PASTE_ON);
    paint(output, { ...state, columns: columns(), commands }, { first: true, atRow, paintFn });
    input.on('data', onData);
    input.once('end', onEnd);
  });
}

/**
 * ── ⭐⭐⭐ PINNING THE BOX TO THE BOTTOM OF THE SCREEN ───────────────────────
 *
 * Roman: *"we need that prompt box stuck down the bottom, it is professional."*
 *
 * A terminal can be told to scroll only PART of itself. `ESC[{top};{bottom}r`
 * sets the scrolling region; everything printed scrolls inside it, and the rows
 * below are left alone. Reserve the last three and the box never moves while
 * output flows past above it.
 *
 * ── ⚠️⚠️ THE PART THAT MUST NEVER BE GOT WRONG ──────────────────────────────
 *
 * A process that exits WITHOUT releasing the region leaves the user with a
 * terminal that scrolls inside a box forever, fixable only by typing `reset`
 * blind. That is the same class of harm as leaving raw mode on, and it must be
 * released on every path out — normal exit, Ctrl-C, SIGTERM, and an uncaught
 * throw. `release()` is idempotent and safe to call from all of them.
 *
 * ⚠️ AND IT IS OPT-IN. A reserved region is a claim on somebody's whole screen;
 * off a TTY, in CI, under a pipe or with ACUVO_NO_PIN=1 it is never set.
 */
export function pinRegion(output, { rows = 2, env = process.env, lifecycle = process } = {}) {
  const height = output?.rows ?? process.stdout?.rows ?? 0;
  /**
   * ── ⚠️⚠️⚠️ OFF BY DEFAULT. THREE ATTEMPTS, THREE DIFFERENT WRONG RESULTS ────
   *
   * Roman, across three builds: "you have to scroll down to see the prompt" —
   * then, after the clear was fixed — "now it's just the box, everything else
   * is gone."
   *
   * The write ORDER is provably correct (traced: clear, region, banner at row 1,
   * input at the last two rows). It still renders wrong in his terminal, and a
   * scroll region is a claim on somebody's whole screen that behaves differently
   * in VS Code, Windows Terminal and cmd.exe. I cannot verify it in the terminal
   * that matters from here, and shipping a fourth guess at somebody's display is
   * worse than not having the feature.
   *
   * ⭐ AND THE SIMPLE VERSION GETS THE ACTUAL REQUIREMENT. Without a region the
   * input is simply the LAST THING WRITTEN each turn, and every terminal
   * auto-scrolls to its newest output — so it is always at the bottom of what
   * you are looking at, always visible, with the transcript above it. That is
   * what "stuck down the bottom" needs to mean; welding it to a physical screen
   * row was my addition, not the requirement.
   *
   * ⚠️ KEPT, NOT DELETED, and still fully tested — `ACUVO_PIN=1` turns it on.
   * The mechanism is correct and worth having once it can be verified in a real
   * VS Code terminal rather than inferred from a byte trace.
   */
  const enabled = Boolean(output?.isTTY)
    && height > rows + 4
    && String(env.ACUVO_NO_PIN ?? '') !== '1'
    && String(env.CI ?? '').toLowerCase() !== 'true';

  if (!enabled) return { enabled: false, release() {}, rows: 0, bottom: 0 };

  const bottom = height - rows;
  let released = false;

  /**
   * ── ⭐⭐⭐ RESERVE THE ROWS. DO NOT CLEAR THE SCREEN. ────────────────────────
   *
   * ⚠️⚠️ THE CLEAR WAS THE ENTIRE BUG, THROUGH FOUR ATTEMPTS. Every previous
   * version began `ESC[H ESC[2J ESC[3J` — home, erase screen, erase scrollback.
   * That is what `clear` emits, and it is completely wrong here for two reasons
   * that took far too long to separate:
   *
   *   1. It runs AFTER the banner has been printed, so it erases the thing the
   *      user just saw. Roman: "I see the green logo and text for a fraction of
   *      a second then I just see the prompt box, nothing else."
   *   2. `3J` deletes the SCROLLBACK — the user's shell history, and then their
   *      own session. "Can't scroll up or it's just not there." A CLI has no
   *      business destroying the buffer it was launched into.
   *
   * ⭐ AND THE REFERENCE NEVER DID THIS. Claude Code does not clear your screen
   * when it starts; your prompt, your previous commands and your scrollback are
   * all still there afterwards. I imported a clear because I was thinking of a
   * full-screen TUI, and then spent four builds fixing the ORDER of an operation
   * that should not have existed.
   *
   * ⚠️ THE ROOM IS MADE BY SCROLLING, NOT BY ERASING. Printing `rows` newlines
   * pushes existing content up exactly as any command would, leaving the cursor
   * on the last line with `rows` blank lines below the content. Stepping back up
   * to `bottom` and declaring the region there reserves those lines for the
   * input — and everything above is untouched, still scrollable, still theirs.
   *
   * ⚠️ THE CURSOR IS PLACED LAST, AND THAT IS NOT COSMETIC: DECSTBM homes the
   * cursor to (1,1) as a side effect. Without the final move, the first line of
   * output would land at the TOP of the screen and overwrite the banner — which
   * is a quieter version of the same defect this rewrite removes.
   */
  const makeRoom = '\n'.repeat(rows);
  /**
   * ── ⚠️⚠️ THE CURSOR GOES BACK WHERE THE CONTENT ENDED, NOT TO THE BOTTOM ──
   *
   * Roman, from a screenshot: the banner sat at the top, then forty blank
   * rows, then the invitation alone near the bottom — "the prompt box is too
   * low and you have to scroll down to see everything."
   *
   * The cause was the last move in the old sequence, `ESC[{bottom};1H`. It
   * parked the cursor on the LAST row of the scrolling region, so the first
   * thing printed after pinning landed at the bottom of the screen and the
   * whole gap opened up behind it. A terminal fills DOWNWARD: after reserving
   * rows, output has to carry on from exactly where the banner stopped.
   *
   * ⭐ DECSC/DECRC (`ESC7`/`ESC8`) rather than an absolute move, because the
   * right row is "wherever the content happens to end" and only the terminal
   * knows that. Setting a scroll region homes the cursor to (1,1) as a side
   * effect — that is the reason a restore is needed at all, and the reason the
   * old code moved the cursor somewhere explicit in the first place. It just
   * moved it to the wrong somewhere.
   *
   * ⚠️ The save happens AFTER the newlines and the step back up, so the
   * position being restored is already inside the region — a restore to a row
   * below the region would put the cursor outside it, which is undefined
   * across terminals.
   */
  safeWrite(output, `${makeRoom}${CSI}${rows}A\x1b7${CSI}1;${bottom}r\x1b8`);

  const release = () => {
    if (released) return;
    released = true;
    /**
     * ⚠️ THE HOOK COMES OFF FIRST. `chat.mjs` calls `release()` in a `finally`
     * on a normal end, and a long-lived process that opened several sessions
     * would otherwise accumulate one dead `'exit'` listener per session until
     * Node warns the user about a memory leak in the middle of their work.
     */
    try { lifecycle?.off?.('exit', release); } catch { /* an injected stub */ }
    /**
     * ⚠️ `ESC[r` WITH NO ARGUMENTS RESETS TO THE FULL SCREEN. Then the cursor
     * moves below the reserved rows so the shell prompt does not land on top of
     * our input — an exit that is technically correct and visually broken is
     * still a bad exit.
     *
     * ⭐ AND NOTHING IS ERASED ON THE WAY OUT EITHER. The session the user just
     * had stays on screen and in scrollback, which is the whole point of not
     * having taken over their terminal in the first place.
     */
    safeWrite(output, `${CSI}r${CSI}${height};1H\n`);
    /**
     * ⭐ AND THE CURSOR COMES BACK WITH IT. A scroll region and a hidden cursor
     * are set by the same feature and are undone in the same breath — releasing
     * one and not the other leaves the terminal looking frozen, which is the
     * failure this whole function is written to avoid.
     */
    restoreTerminal({ output });
  };

  /**
   * ── ⭐⭐⭐ THE REGION RELEASES ITSELF. A CALLER MUST NOT BE ABLE TO FORGET ───
   *
   * ⚠️ THIS FUNCTION'S OWN HEADER SAYS the region "must be released on every
   * path out — normal exit, Ctrl-C, SIGTERM, and an uncaught throw" — and then
   * left all four to the caller. `chat.mjs` does register three of them, at the
   * moment it engages the pin, and that is the *only* correct call site in the
   * package. Any second caller, or one refactor of that block, and the user is
   * left with a terminal that scrolls inside a box until they type `reset`
   * blind, with nothing on screen to explain it.
   *
   * ⭐ A guarantee belongs with the thing being guaranteed. `release` is
   * idempotent, so the caller's own hooks are now redundant rather than wrong,
   * and the failure mode changes from "somebody forgot" to "impossible".
   */
  try { lifecycle?.once?.('exit', release); } catch { /* an injected stub */ }

  return { enabled: true, release, rows, bottom };
}
