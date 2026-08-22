/**
 * ── ⭐⭐ DRAG A FILE INTO THE TERMINAL AND HAVE IT MEAN SOMETHING ────────────
 *
 * Roman, 2026-08-16: *"since our CLI will have Qwen for interpretation, people
 * should be able to drop images, files, etc into a terminal — that's another
 * feature you don't have."*
 *
 * ⭐ THE CAPABILITY WAS NEVER THE MISSING PART. `read_image` (vision.mjs),
 * `read_document` and `read_table` all ship. What was missing is the ONE STEP
 * a user actually performs: dragging a file onto a terminal window does not
 * attach anything — it pastes a **path string** into the command line. Nothing
 * in this program looked at that string and noticed it named a real file, so a
 * dropped screenshot arrived as an unremarkable sentence and the model, which
 * cannot see, answered about a filename.
 *
 * ⚠️ SO THIS IS A PARSER, NOT A FEATURE. It turns "what a terminal does when
 * you drop a file" into "what the model is told it has".
 *
 * ── ⚠️ THE FOUR SHAPES A TERMINAL ACTUALLY PASTES ────────────────────────────
 *
 * Measured against the conventions, not guessed at from one of them:
 *
 *   · Windows Terminal / cmd  →  "C:\Users\me\shot.png"     (double-quoted)
 *   · PowerShell              →  'C:\Users\me\my shot.png'  (single-quoted)
 *   · macOS Terminal / iTerm  →  /Users/me/my\ shot.png     (backslash-escaped)
 *   · everything, no spaces   →  /home/me/shot.png          (bare)
 *
 * A parser that handles only the bare case works on every path without a space
 * in it, which is most paths a developer tests with and almost no path a user
 * drops from a Downloads folder.
 *
 * ── ⚠️⚠️ EXISTENCE ON DISK IS THE WHOLE FILTER ──────────────────────────────
 *
 * The hard problem is not finding path-shaped text, it is NOT finding it
 * everywhere. "fix the bug in the login flow" contains no file; "update
 * README.md" contains a word that looks like one. ⭐ The rule that separates a
 * dropped file from prose about a file is that **a dropped file is on the
 * disk**, so nothing is attached unless it can be stat'd. That single check
 * removes the entire class of false positives without a vocabulary to maintain.
 *
 * ── ⚠️ AND ONLY *MEDIA* IS ATTACHED. Deliberately. ──────────────────────────
 *
 * The agent can already open a `.ts` file whenever it decides to — `read_file`
 * exists and it has the repo map. Auto-attaching source would spend tokens on a
 * decision the model is better placed to make, and would fire on any sentence
 * naming a tracked file. But it CANNOT open a PNG by deciding to: reading an
 * image costs a vision call the model must be told is worth making. ⭐ So the
 * split is capability-based, not preference-based — attach what the model
 * cannot reach on its own, mention what it can.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve, extname, basename } from 'node:path';

/**
 * ⚠️ LOWERCASE, AND COMPARED AGAINST A LOWERCASED EXTENSION. A file dropped
 * from a phone is routinely `IMG_0421.JPG`, and a case-sensitive table would
 * classify the single commonest real-world drop as `unknown`.
 */
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif']);
const DOCUMENT = new Set(['.pdf', '.docx', '.doc', '.odt', '.rtf', '.pptx']);
const TABLE = new Set(['.csv', '.tsv', '.xlsx', '.xls', '.ods']);

/**
 * ⚠️ A CEILING, BECAUSE A FOLDER DROP IS ONE GESTURE AND FORTY PATHS. Selecting
 * a directory's contents and dragging them in is normal behaviour, and forty
 * vision calls is real money spent on one careless flick of the wrist. The
 * overflow is REPORTED rather than silently dropped — see `describeDropped`.
 */
export const MAX_DROPPED = 8;

/**
 * ⚠️ 64MB. Large enough for any screenshot or scanned PDF, small enough that a
 * dropped video or disk image is refused rather than read into memory. Reported,
 * not skipped in silence: "I ignored your file" must never be something the user
 * has to infer from a wrong answer.
 */
export const MAX_DROPPED_BYTES = 64 * 1024 * 1024;

/** What the model can do with a given extension, or null if we should not care. */
export function classifyDropped(path) {
  const ext = extname(String(path ?? '')).toLowerCase();
  if (IMAGE.has(ext)) return { kind: 'image', tool: 'read_image' };
  if (DOCUMENT.has(ext)) return { kind: 'document', tool: 'read_document' };
  if (TABLE.has(ext)) return { kind: 'table', tool: 'read_table' };
  return null;
}

/**
 * Every path-shaped token in a line, in the four shapes a terminal pastes.
 *
 * ⚠️ QUOTED FORMS ARE TAKEN FIRST AND THEIR SPAN REMOVED, because a bare scan
 * run first would split `"my shot.png"` at the space and find neither half.
 * Order is load-bearing here, not stylistic.
 *
 * @param {string} text
 * @returns {string[]} raw candidates, still unresolved and unverified
 */
export function candidatePaths(text) {
  let rest = String(text ?? '');
  const found = [];

  // 1 + 2. "double quoted" and 'single quoted'.
  for (const re of [/"([^"]+)"/g, /'([^']+)'/g]) {
    rest = rest.replace(re, (_all, inner) => {
      found.push(inner);
      // ⚠️ Replaced with spaces, NOT removed: deleting the span would join the
      // words either side into one token that never existed.
      return ' '.repeat(String(_all).length);
    });
  }

  // 3 + 4. Backslash-escaped spaces, and bare runs.
  //   `/Users/me/my\ shot.png` must survive as ONE token, so an escaped space is
  //   part of the run. On Windows a backslash is a separator rather than an
  //   escape, but `\ ` (backslash-space) is not a legal Windows path fragment,
  //   so accepting it costs nothing there.
  for (const m of rest.matchAll(/(?:[^\s\\]|\\ |\\(?![\s]))+/g)) {
    const token = m[0];
    if (!/[\\/]/.test(token) && !extname(token)) continue; // not path-shaped at all
    found.push(token.replace(/\\ /g, ' '));
  }

  return found;
}

/**
 * ⭐ THE FILES A USER DROPPED INTO THIS COMMAND, resolved and verified.
 *
 * @param {string} text the task as typed
 * @param {{ root?: string, max?: number, maxBytes?: number }} [options]
 * @returns {{ attached: Array<{path: string, name: string, kind: string, tool: string, bytes: number}>,
 *             skipped: Array<{path: string, why: string}>, overflow: number }}
 */
export function findDropped(text, { root = process.cwd(), max = MAX_DROPPED, maxBytes = MAX_DROPPED_BYTES } = {}) {
  const attached = [];
  const skipped = [];
  const seen = new Set();
  let overflow = 0;

  for (const raw of candidatePaths(text)) {
    const cleaned = raw.trim().replace(/[),.;:]+$/, ''); // trailing sentence punctuation
    if (!cleaned) continue;

    const kind = classifyDropped(cleaned);
    if (!kind) continue; // source files are the model's business, not ours

    const full = isAbsolute(cleaned) ? cleaned : resolve(root, cleaned);
    if (seen.has(full)) continue;

    /**
     * ⚠️⚠️ EXISTENCE IS CHECKED BEFORE ANYTHING ELSE IS BELIEVED. This is the
     * line that separates a dropped file from a sentence mentioning one, and
     * it is why no keyword list is needed.
     */
    if (!existsSync(full)) continue;

    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    // ⚠️ A directory matches every check above and is not a file.
    if (!stat.isFile()) continue;

    seen.add(full);

    if (stat.size > maxBytes) {
      skipped.push({ path: full, why: `${(stat.size / 1e6).toFixed(1)}MB is over the ${(maxBytes / 1e6).toFixed(0)}MB limit` });
      continue;
    }
    if (attached.length >= max) {
      overflow += 1;
      continue;
    }

    attached.push({ path: full, name: basename(full), kind: kind.kind, tool: kind.tool, bytes: stat.size });
  }

  return { attached, skipped, overflow };
}

/**
 * The sentence the model is told, or null when nothing was dropped.
 *
 * ⚠️ IT NAMES THE TOOL FOR EACH FILE. Telling a model "there is an image at
 * /tmp/a.png" and leaving it to work out that `read_image` is how one looks at
 * an image wastes a round on rediscovering our own API — and a model that never
 * makes the connection answers about the filename, which is the exact failure
 * this module exists to remove.
 *
 * ⚠️ AND THE SKIPS ARE SAID OUT LOUD. A file the user watched themselves drop,
 * silently ignored, is indistinguishable from a broken program.
 */
export function describeDropped(result) {
  if (!result || (result.attached.length === 0 && result.skipped.length === 0 && !result.overflow)) return null;

  const lines = [];
  if (result.attached.length > 0) {
    lines.push(
      result.attached.length === 1
        ? 'The user dropped a file into this command. Look at it before answering:'
        : `The user dropped ${result.attached.length} files into this command. Look at them before answering:`,
    );
    for (const f of result.attached) {
      lines.push(`  · ${f.path} — a ${f.kind}. Call ${f.tool} with that exact path.`);
    }
    lines.push('Do not describe these from their filenames; you cannot see them until you call the tool.');
  }
  for (const s of result.skipped) lines.push(`  ⚠ ${s.path} was NOT attached: ${s.why}.`);
  if (result.overflow > 0) {
    lines.push(`  ⚠ ${result.overflow} further dropped file(s) were not attached — the limit is ${MAX_DROPPED} per command. Ask for the rest by path if you need them.`);
  }
  return lines.join('\n');
}
