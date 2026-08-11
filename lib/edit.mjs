/**
 * ── ⭐ SURGICAL EDITS — REPLACE A SPAN, NOT THE WHOLE FILE ───────────────────
 *
 * `write_file` is the only way this CLI could change existing code, which means
 * changing one line of a 2,000-line file required the model to re-emit all 2,000.
 * That is bad three separate ways, and the third is the one that actually hurts:
 *
 *   1. **Cost.** ~8,000 output tokens instead of ~50. At scale that is the whole
 *      pricing advantage handed back.
 *   2. **Truncation.** Long rewrites hit `max_tokens` and arrive half-finished.
 *   3. ⚠️ **SILENT DELETION.** Anything the model does not think to re-emit is
 *      gone — a comment, an import, an unrelated function. The file still
 *      parses, the tests may still pass, and nobody notices until the thing that
 *      vanished was load-bearing. A whole-file rewrite is a destructive
 *      operation wearing the costume of an edit.
 *
 * So: `edit_file(path, old_string, new_string)`. The model quotes the span it
 * means and gets exactly that span replaced.
 *
 * ── ⚠️ UNIQUENESS IS THE SAFETY PROPERTY, NOT A CONVENIENCE ─────────────────
 * If `old_string` appears more than once the edit is REFUSED, not applied to the
 * first hit. "Replace the first `return null`" is almost never what anyone means
 * in a file with nine of them, and picking one silently is how an agent corrupts
 * code in a way that looks deliberate. The refusal tells the model how many
 * matches there were so it can quote more surrounding context — which is the
 * behaviour we want anyway.
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolveInWorkspace } from './workspace.mjs';

/** Same ceiling the read path uses — an edit target must be readable as text. */
const MAX_EDIT_BYTES = 512 * 1024;

/**
 * Count non-overlapping occurrences. `split().length - 1` rather than a regex,
 * because `old_string` is arbitrary code and must never be treated as a pattern.
 */
export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * ── ⚠️⚠️ CRLF: THE DEFECT THAT ROUTED THE AGENT INTO THE HAZARD ─────────────
 *
 * Everything below exists for one reason. A model writes multi-line `old_string`
 * with `\n`. A Windows file holds `\r\n`. The literal match count is 0, the edit
 * is refused, and the model's only remaining move is `write_file` — A WHOLE-FILE
 * REWRITE FROM MEMORY.
 *
 * ⭐ That is precisely the operation `edit_file` was built to prevent. So this
 * was not a blocked feature, it was a FUNNEL INTO THE HAZARD, and it fired on
 * essentially every multi-line edit on the platform the owner develops on. It
 * cost twice over: the file silently converts to LF (a diff touching every
 * line) AND anything the model did not think to re-emit is gone.
 *
 * ⚠️⚠️ AND THE OBVIOUS FIX IS THE SAME BUG WEARING A HAT. "Normalise the file to
 * \n, match, write it back" matches beautifully and rewrites every line ending
 * in the file — the identical damage, more quietly, with `ok: true` on top. So
 * the rule this code is written to satisfy is:
 *
 *   THE BYTES OUTSIDE THE REPLACED SPAN MUST BE IDENTICAL.
 *
 * Which means we may normalise only a THROWAWAY COPY, and must map the hit back
 * to an index in the ORIGINAL string. `content.slice(0, start)` and
 * `content.slice(end)` then carry the untouched bytes through verbatim, by
 * construction rather than by care.
 */

/** The three endings that exist in the wild. `\r\n` first — order matters. */
const EOL_RE = /\r\n|\r|\n/g;

/** Collapse every ending to `\n`. Used ONLY on throwaway copies. */
function toLf(text) {
  return text.replace(/\r\n|\r/g, '\n');
}

/**
 * Normalise, and remember where every surviving character CAME FROM.
 *
 * ⭐ `map[i]` is the index in `source` of the character at `out[i]`, and the
 * array carries one extra entry (`source.length`) so that an end-exclusive
 * index maps too — without that sentinel a span reaching EOF maps to
 * `undefined` and the slice silently becomes "to the end of the string", which
 * is right by accident until the day it is not.
 */
function normaliseWithIndexMap(source) {
  let out = '';
  const map = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    map.push(i);
    if (ch === '\r') {
      out += '\n';
      i += source[i + 1] === '\n' ? 2 : 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  map.push(source.length);
  return { out, map };
}

/** Every line ending in `text`, in order, as literal strings. */
function lineEndingsOf(text) {
  return text.match(EOL_RE) ?? [];
}

/** The ending a file mostly uses. Ties go to whichever appeared first. */
function prevailingEnding(text) {
  const found = lineEndingsOf(text);
  if (found.length === 0) return null;
  const counts = new Map();
  for (const e of found) counts.set(e, (counts.get(e) ?? 0) + 1);
  let best = found[0];
  for (const e of found) if ((counts.get(e) ?? 0) > (counts.get(best) ?? 0)) best = e;
  return best;
}

/**
 * Re-emit `text` using the endings the original span actually had.
 *
 * ⚠️ POSITIONALLY, not "the file's prevailing ending". A span can straddle a
 * CRLF line and an LF line — real repos are mixed, usually because someone's
 * editor disagreed with someone's git config — and flattening the span to one
 * ending rewrites a line nobody asked to touch. The k-th newline of the
 * replacement gets the k-th ending the span had; if the replacement adds lines,
 * the last observed ending continues; if the span had none, the file's
 * prevailing ending, and only then `\n`.
 */
function reflowToEndings(text, spanEndings, fallback) {
  const lines = toLf(text).split('\n');
  let out = lines[0];
  for (let i = 1; i < lines.length; i += 1) {
    const eol = spanEndings[i - 1] ?? spanEndings[spanEndings.length - 1] ?? fallback;
    out += eol + lines[i];
  }
  return out;
}

/** Non-overlapping match positions — the same left-to-right walk `split` does. */
function matchPositions(haystack, needle) {
  const at = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    at.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return at;
}

/**
 * The one retry: match `oldString` against `content` IGNORING line-ending style.
 *
 * Returns `null` when this path cannot possibly apply, so the caller falls
 * through to its ordinary not-found refusal and the message stays the one it
 * always was.
 */
function matchAcrossLineEndings(content, oldString, newString) {
  /**
   * ⚠️ TWO CHEAP EXITS, AND THEY ARE WHAT KEEPS THIS ADDITIVE.
   *
   * 1. A needle with no line break at all cannot gain a match by normalising —
   *    normalising only ever rewrites `\r`, and a needle containing no `\r` and
   *    no `\n` can only match a run of non-newline characters, which is
   *    byte-identical before and after. So SINGLE-LINE EDITS NEVER ENTER HERE,
   *    provably, not just in practice.
   * 2. If neither side contains a `\r`, normalising is the identity function on
   *    both, so the second search would repeat the first one's answer.
   */
  if (!/[\r\n]/.test(oldString)) return null;
  if (!content.includes('\r') && !oldString.includes('\r')) return null;

  const { out: haystack, map } = normaliseWithIndexMap(content);
  const needle = toLf(oldString);
  const at = matchPositions(haystack, needle);

  if (at.length === 0) return null;
  if (at.length > 1) {
    /**
     * ⚠️ AMBIGUITY IS A REFUSAL, NOT A GUESS. Uniqueness is a SAFETY property —
     * it is the rule that stops an agent corrupting code in a way that looks
     * deliberate — and a tolerant matcher is not allowed to relax it just
     * because it was the one that found the matches. The message names the
     * cause, because "it appears twice" is baffling to a model looking at a
     * file where, literally, it appears zero times.
     */
    return {
      ok: false,
      error:
        `old_string is not in the file literally, but ignoring line-ending style (CRLF vs LF) it ` +
        `matches ${at.length} times, so it is ambiguous and nothing was changed. Quote more ` +
        'surrounding context until the span is unique.',
    };
  }

  const start = map[at[0]];
  const end = map[at[0] + needle.length];
  const span = content.slice(start, end);
  const replacement = reflowToEndings(newString, lineEndingsOf(span), prevailingEnding(content) ?? '\n');
  const next = content.slice(0, start) + replacement + content.slice(end);

  if (next === content) {
    // ⚠️ old_string and new_string differed only in ending STYLE. Writing this
    // produces the same bytes, and a success report on a no-op is a lie the
    // model will build its next step on.
    return {
      ok: false,
      error:
        'old_string and new_string differ only in line-ending style, so there is nothing to do — ' +
        'the file already contains exactly what you asked for.',
    };
  }

  return { ok: true, content: next, newlineNormalised: true };
}

/**
 * Replace exactly one occurrence of `oldString` with `newString`.
 *
 * Pure so it is testable without a filesystem: the caller owns the I/O, this
 * owns the decision.
 */
export function applyEdit(content, oldString, newString) {
  if (typeof oldString !== 'string' || oldString.length === 0) {
    return { ok: false, error: 'old_string is required — quote the exact text to replace' };
  }
  if (typeof newString !== 'string') {
    return { ok: false, error: 'new_string is required (use "" to delete the span)' };
  }
  if (oldString === newString) {
    // ⚠️ A no-op edit reported as success is a lie the model will build on: it
    // moves to the next step believing something changed.
    return { ok: false, error: 'old_string and new_string are identical — nothing to do' };
  }

  const hits = countOccurrences(content, oldString);
  if (hits === 0) {
    // ⭐ ONE retry, ignoring line-ending style only. Returns null when the path
    // cannot apply, so the refusal below is still the refusal it always was.
    const tolerant = matchAcrossLineEndings(content, oldString, newString);
    if (tolerant) return tolerant;
    return {
      ok: false,
      error:
        'old_string was not found. It must match the file EXACTLY, including indentation and ' +
        'line breaks — read the file first and copy the span verbatim.',
    };
  }
  if (hits > 1) {
    return {
      ok: false,
      error:
        `old_string appears ${hits} times, so it is ambiguous. Quote more surrounding ` +
        'context until the span is unique. (Editing the first match silently is how an agent ' +
        'corrupts code in a way that looks deliberate.)',
    };
  }
  return { ok: true, content: content.replace(oldString, newString) };
}

/** Read, edit, write — with the workspace's own path safety. */
export function editFile(root, rawPath, oldString, newString, { dryRun = false } = {}) {
  const target = resolveInWorkspace(root, rawPath, 'write');
  if (!target.ok) return { ok: false, error: target.reason };

  let stat;
  try {
    stat = statSync(target.absolute);
  } catch {
    return { ok: false, error: `no such file: ${target.relative} — use write_file to create it` };
  }
  if (stat.isDirectory()) return { ok: false, error: `${target.relative} is a directory` };
  if (stat.size > MAX_EDIT_BYTES) {
    return { ok: false, error: `${target.relative} is ${stat.size} bytes, over the ${MAX_EDIT_BYTES}-byte edit limit` };
  }

  /**
   * ⚠️ READ THE BYTES, NOT A DECODED STRING — THE DECODE IS THE DESTRUCTION.
   *
   * This used to be `readFileSync(path, 'utf8')`, and that single argument was a
   * silent data-loss bug. `'utf8'` does not fail on invalid input: every byte it
   * cannot make sense of becomes U+FFFD, and the write-back turns each one into
   * `ef bf bd`. So a latin-1 / cp1252 / Shift-JIS file — legitimate text, just
   * not our encoding — came back permanently mangled while the function returned
   * `ok: true` and a plausible byte count.
   *
   * REPRODUCED 2026-08-10: 17 bytes `48656c6c6f20fffee9e80a534543524554`, one
   * `edit_file` replacing SECRET→PUBLIC, and `ff fe e9 e8` were gone forever —
   * four bytes the model never asked to touch, with a success report on top of
   * them. Nothing about the request was risky; the read was.
   */
  const raw = readFileSync(target.absolute);

  /**
   * ⚠️ NUL AS AN ESCAPE, NEVER A RAW BYTE — I WROTE THIS BUG TWICE TODAY.
   * A literal control character in source survives as a plain SPACE through some
   * tooling, which turns this into `includes(' ')` — refusing every file that
   * contains a space, i.e. all of them. Edit would have reported every file as
   * binary and refused to touch anything.
   *
   * The check itself matches readFile's, so read / search / edit all agree about
   * what counts as text; editing a binary as UTF-8 corrupts it silently.
   * It stays FIRST because "looks binary" is the more useful sentence for a .png
   * than "not valid UTF-8", and a real binary is almost always both.
   */
  if (raw.includes(0)) {
    return { ok: false, error: `${target.relative} looks binary — refusing to edit it as text` };
  }

  /**
   * ⭐ `fatal: true` is the whole fix — it THROWS on exactly the bytes that
   * `'utf8'` would have silently replaced.
   *
   * ⚠️ A round-trip comparison (`raw.equals(Buffer.from(str, 'utf8'))`) looks
   * equivalent and is weaker: a lone surrogate encodes to three bytes and U+FFFD
   * encodes to three bytes, so the lengths agree and only the strict decoder
   * notices. Use the decoder.
   *
   * ⚠️ `ignoreBOM: true` IS LOAD-BEARING, AND IT IS NAMED BACKWARDS. It means
   * "do not treat a leading U+FEFF as a marker to swallow" — i.e. KEEP the BOM
   * as an ordinary character. The default (`false`) strips it, which would have
   * quietly deleted three bytes from the front of every BOM'd file on every
   * edit: a new silent-data-loss bug shipped inside the fix for silent data
   * loss. My own regression test caught it, which is the only reason it is not
   * in this file right now.
   *
   * ⚠️ The refusal must not say "try again" — retrying is the one thing that
   * cannot help, because the file will still be in the same encoding next time.
   * Name the two moves that actually get the caller unstuck instead.
   */
  let before;
  try {
    before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return {
      ok: false,
      error:
        `${target.relative} is not valid UTF-8 — refusing to edit it as text. ` +
        'Editing it would replace every undecodable byte with U+FFFD and destroy them permanently. ' +
        'Convert the file to UTF-8 first, or change it with a tool that preserves its encoding.',
    };
  }

  const result = applyEdit(before, oldString, newString);
  if (!result.ok) return { ok: false, error: `${target.relative}: ${result.error}` };

  if (!dryRun) writeFileSync(target.absolute, result.content, 'utf8');

  return {
    ok: true,
    path: target.relative,
    bytes: Buffer.byteLength(result.content, 'utf8'),
    // ⭐ The saving, reported so it is visible rather than theoretical: how much
    // of the file we did NOT have to re-emit.
    replacedChars: oldString.length,
    fileChars: before.length,
    /**
     * ⚠️ `created: false` and `previousBytes` are shaped to match write_file's
     * result, because the summary renders both through one line. An edit that
     * omitted them printed "created undefined bytes, was undefined" — a result
     * object that is ALMOST the expected shape is worse than an obviously wrong
     * one, because it renders instead of throwing.
     *
     * ⚠️ `previousBytes` is `raw.length`, NOT `Buffer.byteLength(before)`. The
     * latter measures the string we decoded, which is a claim about our own
     * variable rather than about the file — and it lied the moment the decode
     * was lossy: a 17-byte file was reported as `previousBytes: 25`, because
     * four bad bytes had already become four 3-byte U+FFFDs. The strict decode
     * above closes that gap, but the honest source for "what was on disk" is
     * still the bytes we read off the disk.
     */
    created: false,
    previousBytes: raw.length,
    dryRun,
    /**
     * ⭐ Reported, not hidden: the span matched only after line-ending style was
     * ignored. A tolerance that is invisible is indistinguishable from a bug, and
     * the day this maps a hit to the wrong place, this flag is the thread to pull.
     */
    newlineNormalised: result.newlineNormalised === true,
  };
}

/**
 * ── ⭐ THE EXECUTOR-GENERIC EDIT — what makes ONE loop serve TWO clients ─────
 *
 * `editFile` above reaches straight for `fs` via a root path. That is correct
 * for the CLI and impossible for the browser builder, whose workspace is a Map
 * with no disk behind it.
 *
 * ⚠️ The tempting fix is a branch in the dispatcher — "if memory executor, do
 * this instead" — and that is how one loop quietly becomes two, which is the
 * exact failure this whole refactor exists to undo (measured: the CLI and
 * console registries had ZERO overlap while both claiming to share a design).
 *
 * ⭐ So the EDIT LOGIC never knew about the filesystem in the first place:
 * `applyEdit` is already pure. All this needs is read and write, which every
 * executor has. One implementation, both clients, no branch.
 */
export function editThroughExecutor(executor, rawPath, oldString, newString) {
  const before = executor.readFile(rawPath);
  if (!before.ok) {
    return { ok: false, error: `${before.error} — use write_file to create it` };
  }
  const result = applyEdit(before.content, oldString, newString);
  if (!result.ok) return { ok: false, error: `${before.path}: ${result.error}` };

  const written = executor.writeFile(before.path, result.content);
  if (!written.ok) return { ok: false, error: written.error };

  return {
    ok: true,
    path: before.path,
    bytes: written.bytes,
    replacedChars: oldString.length,
    fileChars: before.content.length,
    // Shaped to match write_file's result — the summary renders both through
    // one line, and an ALMOST-matching object renders "was undefined".
    created: false,
    previousBytes: before.bytes,
    dryRun: written.dryRun === true,
    // Same flag as editFile's — the two doors must not describe the same edit
    // differently, which is how a shared engine quietly becomes two.
    newlineNormalised: result.newlineNormalised === true,
  };
}

export function editToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'edit_file',
      description: [
        'Change PART of an existing file by replacing an exact span of text.',
        'Prefer this over write_file for any file that already exists — write_file replaces the',
        'WHOLE file, so anything you do not re-emit is deleted.',
        'old_string must match the file exactly, indentation included, and must be UNIQUE — if it',
        'appears more than once the edit is refused, so quote enough surrounding context to be',
        'unambiguous. Read the file first and copy the span verbatim.',
        'Line-ending style is the ONE thing you need not get right: plain \\n in old_string matches a',
        'CRLF (Windows) or CR file, and the file keeps its own endings. Never rewrite a whole file just',
        'to change its line breaks.',
        'Use an empty new_string to delete the span.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path to an EXISTING file.' },
          old_string: { type: 'string', description: 'The exact text to replace. Must be unique in the file.' },
          new_string: { type: 'string', description: 'What to replace it with. "" deletes the span.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  };
}
