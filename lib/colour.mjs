/**
 * ── ⭐ COLOUR, AND THE THREE WAYS TOOLS GET IT WRONG ─────────────────────────
 *
 * The output is monochrome today, which makes a long run hard to scan: a
 * refusal, a written file and a passing command all look identical at a glance.
 * Colour is the cheapest legibility win available.
 *
 * ⚠️ IT IS ALSO THE EASIEST THING TO BREAK SOMEONE'S PIPELINE WITH, in three
 * specific ways this file exists to avoid:
 *
 *   1. **Escape codes in a redirected file.** `acuvo … > log.txt` must produce
 *      readable text, not `\\x1b[32m` everywhere. So: colour only when stdout is
 *      a TTY. This is also why the CLI never used colour before — getting it
 *      wrong is worse than going without.
 *   2. **Ignoring NO_COLOR.** It is a standard (no-color.org), it is one line,
 *      and a tool that ignores it is a tool that cannot be scripted around.
 *      `FORCE_COLOR` is honoured too, for CI logs that render ANSI.
 *   3. **Colour carrying meaning alone.** Roughly one in twelve men cannot
 *      distinguish red from green. Every glyph here is already distinct —
 *      `✎ ✂ · $ ✔ ✖` — so colour REINFORCES a signal that is legible without
 *      it. Nothing is only-colour, ever.
 *
 * ⭐ And the palette is deliberately small. Four colours used consistently reads
 * as designed; nine used freely reads as a toy.
 */

const CODES = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  gold: '\x1b[33m',    // the brand note: written files, headings
  green: '\x1b[32m',   // it worked
  red: '\x1b[31m',     // it failed or was refused
  cyan: '\x1b[36m',    // a remote thing: MCP, a service
};

/**
 * Decide once, at startup, whether this stream can take colour.
 *
 * ⚠️ THE ORDER MATTERS. `NO_COLOR` beats `FORCE_COLOR` beats TTY detection —
 * an explicit "off" from the user must never be overridden by our own
 * enthusiasm, and that is the only ordering where a person can always win.
 */
export function colourEnabled({ stream = process.stdout, env = process.env } = {}) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  // ⚠️ `TERM=dumb` is emacs' shell and a few CI runners. They render escapes
  // literally, which is the redirected-file problem wearing a terminal.
  if (env.TERM === 'dumb') return false;
  return Boolean(stream?.isTTY);
}

/**
 * Build a painter. When colour is off every function is identity — so call
 * sites never branch, and a missing `if` cannot leak an escape code into a file.
 */
export function createPainter(enabled = colourEnabled()) {
  const wrap = (code) => (enabled
    ? (text) => `${code}${text}${CODES.reset}`
    : (text) => text);
  return {
    enabled,
    dim: wrap(CODES.dim),
    bold: wrap(CODES.bold),
    gold: wrap(CODES.gold),
    green: wrap(CODES.green),
    red: wrap(CODES.red),
    cyan: wrap(CODES.cyan),
  };
}

/**
 * ⚠️ FOR TESTS AND FOR ANY OUTPUT WE PARSE. The bench scrapes numbers out of a
 * transcript, and an escape code sitting between `$` and a digit turns a
 * working regex into a silent zero — the exact class of bug that already
 * reported a $7.50 cost for a task that cost $0.0008.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export function stripColour(text) {
  return String(text ?? '').replace(ANSI, '');
}
