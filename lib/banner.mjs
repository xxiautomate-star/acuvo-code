/**
 * ── ⭐⭐⭐ WHAT YOU SEE WHEN YOU TYPE `acuvo` ────────────────────────────────
 *
 * ── ⚠️⚠️ REWRITTEN AGAINST A SCREENSHOT OF THE REFERENCE, NOT A DESCRIPTION ──
 *
 * Roman, 2026-08-22, having put the two side by side: *"look at the sizing of
 * logo and text near it, and what it says, the structure, the wording like
 * theirs, the model version, the repo folder."*
 *
 * The reference, read off the image rather than remembered:
 *
 *     [mark]  Claude Code v2.1.219
 *             Opus 5 (1M context) with high effort · Claude Max
 *             C:\Projects\claude-build
 *
 * Three things that were wrong here, each a decision made without looking:
 *
 *   1. **The mark was SEVEN rows.** Theirs is three. A logo taller than the
 *      information beside it turns the opening screen into a title card for
 *      something you run forty times a day.
 *   2. **The facts were a LABELLED TABLE** — `workspace / model / billing /
 *      can run` down a column. Theirs is three prose lines with no labels,
 *      because the values are self-describing: a version looks like a version,
 *      a path looks like a path. Labels are what you add when the reader cannot
 *      tell what they are looking at.
 *   3. **The model line said only the model.** Theirs carries model, effort AND
 *      plan on one line separated by `·` — everything about "what am I talking
 *      to and who is paying" in one glance.
 *
 * ── ⚠️ THE CONSTRAINTS, WHICH ARE NOT PREFERENCES ───────────────────────────
 *
 * · **Half-block glyphs only** (▀ ▄ █) for the art, and only when the terminal
 *   measures them at ONE cell — see `lib/glyph-width.mjs`. They are East Asian
 *   Ambiguous, so where they render double-width the padding spaces stay narrow
 *   and the mark tears.
 * · **No colour escapes here.** The caller owns colour and honours NO_COLOR; a
 *   module that hard-codes them emits garbage the moment output is piped.
 * · **Never wider than the terminal.** Not 80 — the actual width, which a split
 *   pane makes much smaller.
 */

/**
 * The Acuvo mark, in half-blocks. FOUR rows, down from seven.
 *
 * ⚠️ THE HEIGHT IS THE POINT. It has to sit beside three lines of text without
 * dominating them — the proportion the reference uses, and the reason their
 * opening screen reads as a status line rather than a splash.
 */
const MARK = [
  '   ▄█▄',
  '  ▄█▀█▄',
  ' ▄█▄▄▄█▄',
  '█▀     ▀█',
];

/**
 * The same mark in characters nothing can stretch.
 *
 * ⚠️ THIS IS NOT "NO LOGO" — the distinction matters. Roman asked for OUR mark
 * and asked again when he got letters spelling the name. A terminal that cannot
 * draw half-blocks must still get the angular A, drawn another way. A degraded
 * logo is a logo; a wordmark standing in for one is a missing logo.
 */
const MARK_ASCII = [
  '   /\\',
  '  /  \\',
  ' /----\\',
  '/      \\',
];

const GUTTER = 2;

/**
 * The widest the banner may be when the terminal will not say how wide it is.
 * 80, because that is the narrowest terminal in real use.
 */
export const MAX_BANNER_COLUMNS = 80;

/** Below this the two-column layout stops being a layout. */
const MIN_TEXT_COLUMNS = 30;

/** Visible length, ignoring ANSI escapes — they occupy no cells. */
function visibleLength(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Cut a possibly-coloured string to `width` visible cells, keeping escapes
 * balanced so a truncation cannot leak colour into the rest of the screen.
 */
function clampToWidth(s, width) {
  if (visibleLength(s) <= width) return s;
  let out = '';
  let seen = 0;
  const re = /(\x1b\[[0-9;]*m)|([\s\S])/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) { out += m[1]; continue; }
    if (seen >= width) break;
    out += m[2];
    seen += 1;
  }
  /**
   * ⚠️ ONLY RE-CLOSE A STRING THAT WAS ACTUALLY COLOURED. Appending a reset
   * unconditionally puts four bytes on the end of every truncated PLAIN line —
   * harmless on a terminal, garbage the moment output is piped to a file.
   */
  return out.includes('\x1b') ? `${out}\x1b[0m` : out;
}

/**
 * Elide in the MIDDLE, never the end.
 *
 * The informative parts of a path are the drive and the leaf; chopping the tail
 * leaves `C:\Users\somebody\Projects\a-`, which identifies nothing.
 */
function fit(value, room) {
  const s = String(value ?? '');
  if (s.length <= room) return s;
  const head = Math.ceil((room - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (room - 1 - head))}`;
}

/**
 * Build the opening screen.
 *
 * @param {object} o
 * @param {string} o.version
 * @param {string} o.workspace   already shortened by the caller
 * @param {string} o.model
 * @param {string} o.billing     who this run will charge
 * @param {string} o.canRun      what it may execute, or that it may not
 * @param {boolean} [o.interactive] whether a prompt follows
 * @param {'blocks'|'text'} [o.style] which mark to draw — see `lib/glyph-width.mjs`
 * @param {number} [o.columns]   the real terminal width, when it is known
 * @returns {string}
 */
export function openingScreen({
  version, workspace, model, billing, canRun,
  interactive = false, paint = null, style = 'blocks', columns = null,
}) {
  const brand = paint?.brand ?? ((s) => s);

  /**
   * ⚠️ THE WIDTH IS THE TERMINAL'S, NOT A CONSTANT. This built to a fixed 80 and
   * never asked; every line was under 80 and it looked immaculate — in an
   * 80-column terminal. In a split pane every row wrapped.
   */
  const width = Math.max(20, Math.min(MAX_BANNER_COLUMNS, (columns ?? MAX_BANNER_COLUMNS) - 1));

  const mark = style === 'text' ? MARK_ASCII : MARK;
  const markWidth = Math.max(...mark.map((l) => l.length));

  const sideBySide = width >= markWidth + GUTTER + MIN_TEXT_COLUMNS;
  const textColumns = sideBySide ? width - markWidth - GUTTER : width;
  const room = Math.max(12, textColumns);

  /**
   * ── ⭐ THREE LINES, NO LABELS, IN THE REFERENCE'S ORDER ────────────────────
   *
   * Name and version · what you are talking to and who pays · where you are.
   *
   * ⚠️ `billing` JOINS THE MODEL LINE rather than taking a row of its own, which
   * is how the reference does it ("… with high effort · Claude Max"). It matters
   * more here than it does for them: our billing line is the one that says
   * **"YOUR OWN OpenRouter key (not your Acuvo plan)"**, and somebody needs to
   * see that beside the model, not three rows away from it.
   */
  const right = [
    `Acuvo Code${version ? ` v${version}` : ''}`,
    fit([model, billing].filter(Boolean).join(' · '), room),
    fit(workspace, room),
  ];

  const lines = [''];

  if (sideBySide) {
    const rows = Math.max(mark.length, right.length);
    for (let i = 0; i < rows; i += 1) {
      const text = right[i] ?? '';
      /**
       * ⚠️ PADDED FIRST, PAINTED SECOND — escape codes have no width, so padding
       * a coloured string aligns text against invisible bytes and the whole
       * right-hand column drifts.
       *
       * ⚠️⚠️ AND PADDED ONLY WHEN SOMETHING FOLLOWS. On a mark-only row the
       * padding sits INSIDE the colour, before the reset, where `trimEnd` cannot
       * reach it — so the coloured banner carried trailing whitespace the plain
       * one did not, which means colour changed the layout.
       */
      const raw = mark[i] ?? '';
      const padded = text ? raw.padEnd(markWidth + GUTTER) : raw;
      lines.push(`${mark[i] ? brand(padded) : padded}${text}`.trimEnd());
    }
  } else {
    if (width >= markWidth) {
      for (const row of mark) lines.push(brand(row));
      lines.push('');
    }
    for (const text of right) lines.push(text.trimEnd());
  }

  /**
   * ── ⚠️ WHAT IT MAY RUN IS A SEPARATE, QUIETER LINE ─────────────────────────
   *
   * The reference puts this at the very bottom of the screen ("bypass
   * permissions on (shift+tab to cycle)"), away from the identity block, because
   * it is a MODE rather than a fact about the session. Keeping it out of the
   * three-line lockup is what stops that block growing back into the table it
   * used to be.
   */
  if (canRun) {
    lines.push('', clampToWidth(fit(canRun, width), width));
  }

  lines.push('');

  if (interactive) {
    /**
     * ⭐ SHORTENED IN STAGES, NEVER TRUNCATED. A clamp would cut "leave" to
     * "leav", and a hint with a word chopped in half reads as a rendering bug —
     * precisely the impression this screen keeps making.
     */
    const hints = [
      '  Type what you want done.   /help for commands  ·  exit to leave',
      '  /help for commands  ·  exit to leave',
      '  /help  ·  exit',
    ];
    lines.push(hints.find((h) => h.length <= width) ?? hints[hints.length - 1], '');
  }

  /**
   * ⚠️⚠️ THE LAST WORD ON WIDTH. Everything above reasons about `.length`, which
   * counts CODE UNITS, while a terminal counts CELLS — and the whole reason this
   * file was rewritten is that those two disagree. Measured on the painted
   * string with escapes discounted, so a mark wider than advertised is truncated
   * rather than allowed to wrap and tear the layout.
   */
  return lines.map((l) => clampToWidth(l, width)).join('\n');
}
