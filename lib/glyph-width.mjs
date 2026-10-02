/**
 * ── ⭐⭐⭐ ASK THE TERMINAL HOW WIDE A GLYPH ACTUALLY IS ─────────────────────
 *
 * Roman, 2026-08-22, third report on the same screen: *"acuvo cli still is
 * structured wrong, I can't even see our logo, and the words etc, like it
 * doesn't fit."*
 *
 * ── ⚠️ WHY THE BANNER CAN BE CORRECT AND STILL SHATTER ──────────────────────
 *
 * The mark is built from half-block glyphs (▀ ▄ █, U+2580–U+2588). Unicode
 * classifies them as **East Asian Ambiguous**, which means their width is not a
 * property of the character — it is a property of the terminal and the font. A
 * terminal that renders them at TWO cells turns a 14-column mark into 28
 * columns, while the SPACES padding each row stay at one. The art does not get
 * uniformly wider; it tears, every row by a different amount, and the right-hand
 * column is shoved off the screen. That is exactly "I can't even see our logo,
 * and the words don't fit", and it is invisible from any machine where the font
 * happens to render them narrow — including mine, where the banner measures a
 * tidy 72 columns and looks perfect.
 *
 * ⭐ SO STOP GUESSING AND MEASURE. Print the glyph, ask the terminal where the
 * cursor ended up (`ESC[6n`, the DSR cursor-position report from ECMA-48), and
 * subtract. The answer is not an inference about fonts or platforms; it is the
 * terminal reporting its own behaviour. This is what every serious TUI does for
 * emoji and CJK, and it is the only instrument that works from here — three
 * previous attempts at this screen were reasoned from byte sequences and all
 * three were wrong on the one machine that mattered.
 *
 * ── ⚠️ AND IT MUST FAIL SAFE, BECAUSE IT TOUCHES THE SCREEN ─────────────────
 *
 * The probe writes a character and reads a reply. If the terminal never answers
 * — a dumb TERM, a pipe, a CI log, an editor's embedded console that swallows
 * DSR — it must give up quickly, erase what it wrote, restore raw mode exactly
 * as it found it, and return `null` for "unknown". A diagnostic that hangs the
 * program it is diagnosing, or that leaves the terminal in raw mode after a
 * failure, is worse than the bug.
 */

/** The DSR request: "report the cursor position". */
const CURSOR_QUERY = '\x1b[6n';

/**
 * Parse a cursor-position report, `ESC [ row ; col R`.
 *
 * ⚠️ SCANS FOR THE PATTERN RATHER THAN ANCHORING AT THE START. The reply can
 * arrive glued to whatever else the user typed — a keystroke that landed during
 * the round trip sits in the same chunk — and an anchored match would discard a
 * perfectly good measurement because somebody pressed a key.
 *
 * @param {string} buf
 * @returns {{ row: number, col: number } | null}
 */
export function parseCursorReport(buf) {
  const m = /\x1b\[(\d+);(\d+)R/.exec(String(buf ?? ''));
  if (!m) return null;
  const row = Number(m[1]);
  const col = Number(m[2]);
  if (!Number.isFinite(row) || !Number.isFinite(col) || col < 1) return null;
  return { row, col };
}

/**
 * Anything left over once the report is removed — the user's keystrokes.
 *
 * ⚠️ THEY MUST BE HANDED BACK, NOT DROPPED. A character typed while the probe
 * was in flight belongs to the program, and eating it makes the very first
 * keystroke of a session vanish at random.
 *
 * @param {string} buf
 * @returns {string}
 */
export function residualInput(buf) {
  return String(buf ?? '').replace(/\x1b\[\d+;\d+R/, '');
}

/**
 * How many cells the terminal gives `glyph`.
 *
 * @param {object} o
 * @param {string} [o.glyph]        the character to measure
 * @param {NodeJS.ReadStream} o.input
 * @param {NodeJS.WriteStream} o.output
 * @param {number} [o.timeoutMs]
 * @returns {Promise<number|null>} 1, 2, … or null when the terminal did not say
 */
export async function measureCellWidth({ glyph = '█', input, output, timeoutMs = 200 } = {}) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== 'function') return null;

  const wasRaw = input.isRaw === true;
  let done = false;
  let buffered = '';

  return new Promise((resolve) => {
    /**
     * ⚠️ ONE EXIT PATH, AND IT ALWAYS CLEANS UP. Every way out of this — a
     * reply, a timeout, a stream error — goes through here, because a probe
     * that returns early on the happy path and leaks a listener on the sad one
     * is how a CLI ends up with a terminal stuck in raw mode after a hiccup.
     */
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      try {
        // Erase the probe glyph and put the cursor back at the start of the line.
        output.write('\r\x1b[2K');
      } catch { /* the stream went away; nothing to clean */ }
      try {
        if (!wasRaw) input.setRawMode(false);
      } catch { /* likewise */ }
      // Give any keystrokes that arrived during the probe back to the program.
      const rest = residualInput(buffered);
      if (rest) input.unshift?.(rest);
      resolve(value);
    };

    const onData = (chunk) => {
      buffered += String(chunk);
      const report = parseCursorReport(buffered);
      if (!report) return;
      /**
       * The cursor started at column 1, so the glyph consumed `col - 1` cells.
       * Guarded because a terminal that answers nonsense should read as unknown
       * rather than as a plausible-looking wrong number.
       */
      const cells = report.col - 1;
      finish(cells >= 1 && cells <= 4 ? cells : null);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      if (!wasRaw) input.setRawMode(true);
      input.on('data', onData);
      // `\r` first: measure from a known column, not from wherever we happened to be.
      output.write(`\r${glyph}${CURSOR_QUERY}`);
    } catch {
      finish(null);
    }
  });
}

/**
 * The decision the banner actually needs, with every override that matters.
 *
 * ⚠️ AN EXPLICIT SETTING OUTRANKS THE MEASUREMENT, ALWAYS. Detection is very
 * good and will still be wrong somewhere, and when it is, the user must have a
 * way to say so that does not require them to file a bug and wait for a
 * release. `ACUVO_BANNER=text` (or `blocks`) is that way.
 *
 * ⚠️ AND UNKNOWN FALLS BACK TO **TEXT**, not to blocks. The two errors are not
 * symmetric: choosing text on a terminal that could have drawn the mark costs a
 * little beauty, while choosing blocks on a terminal that cannot costs the user
 * a screen of torn garbage as their first impression of the product. This is
 * the mistake that has now been reported three times, so the default leans away
 * from it.
 *
 * @param {object} o
 * @param {number|null} o.cellWidth  measured, or null
 * @param {Record<string,string|undefined>} [o.env]
 * @returns {'blocks'|'text'}
 */
export function bannerStyle({ cellWidth, env = {} }) {
  const forced = String(env.ACUVO_BANNER ?? '').toLowerCase();
  if (forced === 'text' || forced === 'ascii') return 'text';
  if (forced === 'blocks' || forced === 'art') return 'blocks';
  return cellWidth === 1 ? 'blocks' : 'text';
}
