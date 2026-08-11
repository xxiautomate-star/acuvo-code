/**
 * ── ⭐⭐ THE TERMINAL IS A CANVAS, NOT A LOG ─────────────────────────────────
 *
 * Every coding CLI treats the terminal as append-only text. It is not. It is a
 * grid of cells with 24-bit colour, and several modern terminals accept ACTUAL
 * PIXELS through documented escape sequences — no dependency, no framework, no
 * permission. Just bytes on stdout.
 *
 * ⭐ WHY THIS IS OURS AND NOT ANYONE ELSE'S. A coding agent has nothing to show
 * you: it writes text, so it prints text. This one renders pages, generates
 * images and draws faces, and until now it has been describing them in prose
 * like a radio announcer calling a painting. `see_page` already produces a real
 * screenshot and then tells you a FILE PATH. Printing the picture instead is a
 * capability the competition structurally cannot copy, because they have no
 * picture to print.
 *
 * ── ⚠️ WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
 * **No sixel.** Sixel would cover Windows Terminal and xterm, and it is the one
 * I most wanted. It needs the image as RAW PIXELS, which means decoding PNG —
 * inflate, defilter, palette quantisation — and that is a decoder we would own,
 * test and be wrong in, in a package whose whole promise is zero dependencies.
 * Kitty and iTerm2 both accept a PNG byte-for-byte, so they cost nothing.
 *
 * ⚠️ SO ON WINDOWS TERMINAL THIS PRINTS A PATH, exactly as before. That is
 * stated here rather than discovered by a user, because a feature that silently
 * does nothing on the author's own machine is how "it works" becomes a lie.
 *
 * ⚠️ AND IT MUST NEVER CORRUPT A TERMINAL THAT CANNOT READ IT. An unrecognised
 * escape sequence does not render as nothing — it renders as garbage, and a few
 * kilobytes of base64 vomited into a pipe is worse than any missing feature. So
 * detection is ALLOWLIST-ONLY: a terminal we do not positively recognise gets
 * text, forever. Guessing costs more than abstaining.
 */

import { readFileSync } from 'node:fs';

/** Terminals whose support we have positively identified, and by which protocol. */
const KITTY_PROTOCOL = 'kitty';
const ITERM_PROTOCOL = 'iterm';

/**
 * Which inline-image protocol this terminal speaks, or null.
 *
 * ⚠️ ENV IS READ AT CALL TIME, never captured at import — the same rule the
 * media config follows, and for the same reason: a test must be able to hand in
 * a different environment without reloading the module.
 */
export function detectImageProtocol(env = process.env, { isTTY = process.stdout.isTTY } = {}) {
  /**
   * ⚠️ THE OVERRIDE IS CHECKED FIRST AND IN BOTH DIRECTIONS. Someone on a
   * terminal we have not heard of should be able to turn this on, and someone
   * piping our output somewhere should be able to turn it off — and `0` must
   * win over every piece of cleverness below it.
   */
  const forced = env.ACUVO_INLINE_IMAGES?.trim();
  if (forced === '0' || forced === 'false' || forced === 'off') return null;

  /**
   * ⚠️ NOT A TTY MEANS SOMETHING IS READING THIS, not someone. `acuvo --json |
   * jq` must never receive image bytes; it would not just look wrong, it would
   * break the parse. This check sits above the allowlist deliberately: being
   * ON kitty is irrelevant when stdout is a file.
   */
  if (!isTTY && forced !== '1') return null;

  const program = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();

  // Kitty itself, and the terminals that implement its protocol.
  if (env.KITTY_WINDOW_ID) return KITTY_PROTOCOL;
  if (term.includes('kitty')) return KITTY_PROTOCOL;
  if (program === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) return KITTY_PROTOCOL;
  if (program === 'wezterm' || env.WEZTERM_PANE !== undefined) return KITTY_PROTOCOL;
  if (env.KONSOLE_VERSION) return KITTY_PROTOCOL;

  if (program === 'iterm.app' || env.ITERM_SESSION_ID) return ITERM_PROTOCOL;

  // ⚠️ Everything else — Windows Terminal, VS Code, plain xterm, tmux, CI —
  // gets text. See the sixel note at the top for why Windows Terminal is on
  // this side of the line.
  if (forced === '1') return KITTY_PROTOCOL;
  return null;
}

/**
 * Kitty graphics protocol: transmit-and-display a PNG.
 *
 * ⚠️ CHUNKED AT 4096 BASE64 CHARACTERS, WHICH IS THE SPEC AND NOT A PREFERENCE.
 * Terminals drop escape sequences longer than their input buffer, and the
 * failure is silent — no image, no error, nothing to debug. `m=1` means another
 * chunk follows; the final chunk carries `m=0`.
 */
export function kittySequence(pngBytes) {
  const b64 = Buffer.from(pngBytes).toString('base64');
  const CHUNK = 4096;
  if (b64.length <= CHUNK) return `\x1b_Ga=T,f=100;${b64}\x1b\\`;

  const parts = [];
  for (let i = 0; i < b64.length; i += CHUNK) {
    const slice = b64.slice(i, i + CHUNK);
    const more = i + CHUNK < b64.length ? 1 : 0;
    // Control keys go on the FIRST chunk only; later chunks carry just `m`.
    parts.push(i === 0
      ? `\x1b_Ga=T,f=100,m=${more};${slice}\x1b\\`
      : `\x1b_Gm=${more};${slice}\x1b\\`);
  }
  return parts.join('');
}

/**
 * iTerm2 inline image protocol.
 *
 * `size` is the byte length of the DECODED image — iTerm uses it for a progress
 * indicator, and getting it wrong shows a stalled bar on a picture that already
 * arrived. `inline=1` displays rather than downloads.
 */
export function itermSequence(pngBytes, { name = 'acuvo.png' } = {}) {
  const buf = Buffer.from(pngBytes);
  const args = [
    'inline=1',
    `size=${buf.length}`,
    `name=${Buffer.from(name, 'utf8').toString('base64')}`,
    'width=60', // cells, not pixels — a full-width screenshot swamps the scrollback
    'preserveAspectRatio=1',
  ].join(';');
  return `\x1b]1337;File=${args}:${buf.toString('base64')}\x07`;
}

/**
 * ⚠️ THE CEILING EXISTS BECAUSE THE TERMINAL IS NOT A GALLERY. A 4K screenshot
 * is megabytes of base64 travelling through a pty one byte at a time; it stalls
 * the session and scrolls everything useful off the screen. Beyond this we say
 * so and print the path.
 */
const MAX_INLINE_BYTES = 1_500_000;

/**
 * Render an image file into the terminal if we can, and say what we did.
 *
 * Returns `{ shown, text }` — `text` is always safe to print, so the caller
 * never needs to know which branch it took. Never throws: a picture failing to
 * display must not end a coding session.
 */
export function renderImage(absolutePath, { env = process.env, isTTY = process.stdout.isTTY, readImpl = readFileSync } = {}) {
  const protocol = detectImageProtocol(env, { isTTY });
  if (!protocol) return { shown: false, text: null };

  let bytes;
  try {
    bytes = readImpl(absolutePath);
  } catch {
    // The path is printed by the caller regardless; a missing file here is not
    // this function's problem to report.
    return { shown: false, text: null };
  }

  if (bytes.length > MAX_INLINE_BYTES) {
    return {
      shown: false,
      text: `  (${Math.round(bytes.length / 1024)}KB — too large to show inline; open the file)`,
    };
  }

  const seq = protocol === KITTY_PROTOCOL
    ? kittySequence(bytes)
    : itermSequence(bytes, { name: absolutePath.split(/[\\/]/).pop() });

  // A newline after the sequence, or the next line of output lands on top of
  // the image — which looks exactly like a rendering bug and is not one.
  return { shown: true, text: `${seq}\n` };
}
