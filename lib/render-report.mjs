/**
 * ── ⭐⭐⭐ STOP GUESSING AT SOMEBODY ELSE'S SCREEN ───────────────────────────
 *
 * Roman has now reported this screen wrong five times: "not opening as a
 * typable terminal", "you have to scroll down", "now it's just the box,
 * everything else is gone", "I can't even see our logo, it doesn't fit", and
 * "CLI structure is still cooked, it's not loading like our Claude reference."
 *
 * ⚠️ FIVE REPORTS, FOUR FIXES, AND I HAVE NEVER ONCE SEEN THE THING I AM
 * FIXING. Every attempt was reasoned from byte sequences that render perfectly
 * here, and the only instrument that has ever caught a defect was him opening a
 * terminal and describing it in words. That is a slow, lossy channel, and after
 * four rounds it is plainly not converging.
 *
 * ⭐ SO THIS IS THE INSTRUMENT. One command prints every fact that determines
 * how the opening screen draws — the emulator's identity, its real size, the
 * MEASURED cell width of the glyphs the logo is built from, which layout that
 * selects, and then the banner itself under a column ruler. Paste it back and
 * the diagnosis is arithmetic instead of inference.
 *
 * ⚠️ IT PRINTS FACTS, NOT A VERDICT. A report that says "looks fine to me" when
 * the user is staring at a broken screen is worse than no report — it argues
 * with them. Every line here is something observed, and where nothing could be
 * observed it says so.
 */

import { openingScreen } from './banner.mjs';
import { measureCellWidth, bannerStyle } from './glyph-width.mjs';

/** The environment variables that actually change how this draws. */
const RELEVANT_ENV = [
  'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM',
  'WT_SESSION', 'ConEmuANSI', 'SESSIONNAME',
  'NO_COLOR', 'FORCE_COLOR', 'CI',
  'ACUVO_BANNER', 'ACUVO_PIN', 'LANG', 'LC_ALL',
];

/**
 * Gather everything, measuring what can be measured.
 *
 * @param {object} o
 * @param {NodeJS.ReadStream} o.input
 * @param {NodeJS.WriteStream} o.output
 * @param {Record<string,string|undefined>} [o.env]
 * @param {string} [o.version]
 */
export async function renderReport({ input, output, env = process.env, version = '' }) {
  /**
   * ⚠️ MEASURED, NOT ASSUMED — and the ASCII fallback glyphs are measured too.
   * If a terminal renders `/` or `\` at anything other than one cell we would
   * want to know, because the "safe" fallback would not be safe either and the
   * whole strategy needs rethinking rather than another patch.
   */
  const block = await measureCellWidth({ glyph: '█', input, output });
  const slash = await measureCellWidth({ glyph: '/', input, output });

  const style = bannerStyle({ cellWidth: block, env });

  return {
    columns: output?.columns ?? null,
    rows: output?.rows ?? null,
    isTTY: Boolean(output?.isTTY),
    stdinIsTTY: Boolean(input?.isTTY),
    blockCellWidth: block,
    asciiCellWidth: slash,
    style,
    env: Object.fromEntries(RELEVANT_ENV.map((k) => [k, env[k] ?? null])),
    version,
  };
}

/** A ruler that makes an off-by-N obvious at a glance. */
export function ruler(width) {
  const w = Math.max(1, Math.min(400, Number(width) || 80));
  let out = '';
  for (let i = 1; i <= w; i += 1) {
    out += i % 10 === 0 ? String((i / 10) % 10) : i % 5 === 0 ? '+' : '.';
  }
  return out;
}

/**
 * Render the report as text safe to paste into a chat.
 *
 * ⚠️ NO COLOUR ANYWHERE IN THIS OUTPUT. It exists to be copied into a message,
 * and escape codes pasted into a chat window arrive as visual noise that hides
 * the very alignment the report is about.
 */
export function formatRenderReport(r) {
  const say = (v) => (v === null || v === undefined ? 'unknown' : String(v));
  const lines = [];

  lines.push('ACUVO RENDER REPORT' + (r.version ? `  ${r.version}` : ''));
  lines.push('');
  lines.push(`terminal size      ${say(r.columns)} x ${say(r.rows)}`);
  lines.push(`stdout is a TTY    ${r.isTTY}`);
  lines.push(`stdin is a TTY     ${r.stdinIsTTY}`);
  lines.push('');

  /**
   * ⭐ THE TWO LINES THE WHOLE INVESTIGATION TURNS ON. A block width of 2 means
   * the half-block logo CANNOT be drawn correctly here, and no amount of layout
   * work will fix it — the answer is the ASCII mark. A width of 1 rules that
   * out entirely and points the search somewhere else.
   */
  lines.push(`block glyph width  ${say(r.blockCellWidth)} cell(s)   <- 1 = safe, 2 = the logo tears`);
  lines.push(`ascii glyph width  ${say(r.asciiCellWidth)} cell(s)   <- must be 1, or the fallback is unsafe too`);
  lines.push(`chosen mark        ${r.style}`);
  lines.push('');

  const envLines = Object.entries(r.env).filter(([, v]) => v !== null);
  lines.push(envLines.length ? 'environment' : 'environment        (none of the relevant variables are set)');
  for (const [k, v] of envLines) lines.push(`  ${k.padEnd(20)} ${v}`);
  lines.push('');

  const width = r.columns ?? 80;
  lines.push(`ruler (${width} columns) — the banner below must never reach the end of this line:`);
  lines.push(ruler(width));
  lines.push('');
  lines.push(openingScreen({
    version: r.version || '0.0.0',
    workspace: 'C:/example/workspace',
    model: 'Acuvo Flash 1',
    billing: 'Acuvo account',
    canRun: 'read + write + shell',
    interactive: true,
    style: r.style,
    columns: r.columns,
  }));
  lines.push(ruler(width));
  lines.push('');
  lines.push('If the mark above looks torn or the rows do not line up, paste this whole');
  lines.push('report back. Every number needed to diagnose it is in here.');

  return lines.join('\n');
}
