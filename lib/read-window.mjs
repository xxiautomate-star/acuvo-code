/**
 * ── ⭐ WINDOWED READS — THE TRUNCATION THAT DROPS THE MIDDLE, INVERTED ───────
 *
 * `read_file` returns a whole file, and `turn.mjs` then hands it to
 * `clampOutput` with an 8,000-character budget. `clampOutput` is RIGHT for a
 * command's stdout — a test runner prints the assertion near the top and the
 * counts at the bottom, so both ends matter and the middle rarely does. Applied
 * to SOURCE CODE it is exactly backwards: the middle is where the function you
 * are looking for lives.
 *
 * ── WHAT THAT COST, MEASURED ────────────────────────────────────────────────
 * Probe 4 asked for `lib/tools.mjs`. The model — unprompted, without ever being
 * told the argument existed — sent `{path, offset:1560, limit:80}`, then 1380,
 * then 1395, then 1280. Every one came back `ok:true` with a BYTE-IDENTICAL
 * 8,063-character blob, because the offset was ignored and the clamp always cut
 * the same hole: 13,692 characters omitted, with `executeToolCall` at line 290
 * of 458 sitting inside it. The model could see the file was truncated, could
 * not see that its paging was a no-op, and burned four rounds proving it. Probes
 * 1 and 3 hit the same wall from other angles ("The output is being truncated in
 * the middle."). Three of five control runs ended `NOTHING WAS RUN` — all eight
 * rounds spent, ~480k tokens, zero output.
 *
 * ⭐ THE ONE PROBE THAT ADDED offset/limit — about fifteen lines — made every
 * repeated read vanish. That is a control, not a correlation, and it is why this
 * module exists.
 *
 * ── THE RULE THIS FILE ENFORCES ─────────────────────────────────────────────
 *   1. Truncate at the END, on a line boundary, and hand back `nextOffset`.
 *      Never the middle. A model that is told where it stopped pages forward;
 *      a model handed a hole re-reads the same blob until the budget dies.
 *   2. Always report `totalLines`, so paging is arithmetic instead of a guess.
 *
 * ── ⚠️ AND THE SECOND HALF, WHICH IS A DIFFERENT BUG ENTIRELY ───────────────
 * `search_text` returns `line.trim()`. Probe 3 took a hit at `lib/git.mjs:282`,
 * built an `edit_file` `old_string` from it, GUESSED six leading spaces where
 * the file has two, was refused, ran out of rounds, and shipped a half-migrated
 * refactor that all 124 tests still passed on. Probe 3's own sub-probe lost its
 * run to the identical guess.
 *
 * So `read_around` exists to be the place an `old_string` is COPIED from, and
 * the single most important property of everything below is that the text comes
 * back VERBATIM: original indentation, original trailing whitespace, no
 * line-number gutter, no ellipsis. Every convenience that rewrites a byte has
 * been left out on purpose. The gutter is available behind `numbered:true`, and
 * even then the result carries `exact` beside it — because the moment a model
 * has only the pretty version, it copies the pretty version.
 *
 * ── BYTE-EXACTNESS IS A CONCATENATION PROPERTY, NOT A VIBE ──────────────────
 * A window's `text` is the original substring from the first line's start to the
 * last line's end INCLUDING its terminator. So `\r\n` survives, a file with no
 * final newline survives, and pages read back-to-back concatenate into the
 * original file byte for byte with nothing added between them. The suite asserts
 * that against a 2,000-line fixture rather than trusting the sentence.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { resolveInWorkspace } from './workspace.mjs';
import { refusedCommitPath } from './secret-paths.mjs';

/**
 * ⚠️ 8 MB, AND IT IS NOT `MAX_READ_BYTES`. `workspace.mjs` caps a read at
 * 200,000 bytes because `read_file` returns the WHOLE file and anything larger
 * would displace the conversation. That reasoning does not transfer: a window is
 * bounded by `maxChars` no matter how big the file is, so the whole-file limit
 * would refuse exactly the files this tool was built for. The cap here is about
 * MEMORY — nothing below ever holds more than one 64 KB chunk plus the requested
 * window, so 8 MB is the largest file we are willing to walk twice.
 */
export const MAX_WINDOW_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_LIMIT = 120;
export const MAX_LIMIT = 400;
export const DEFAULT_CONTEXT = 8;
export const MAX_CONTEXT = 40;
export const DEFAULT_MAX_BLOCKS = 6;
export const MAX_BLOCKS = 10;
/** Matches turn.mjs's MAX_TOOL_RESULT_CHARS on purpose — this module's whole
 *  claim is that it is the same budget spent at the END instead of the middle. */
export const DEFAULT_MAX_CHARS = 8_000;
export const HARD_MAX_CHARS = 12_000;
export const MAX_PATTERN_CHARS = 200;
export const SCAN_BUDGET_MS = 2_000;
export const BINARY_SNIFF_BYTES = 8 * 1024;
/** Hits are line NUMBERS, four bytes of thought each, but a pattern like `.`
 *  matches every line of an 8 MB file and the array is what would blow up. */
export const MAX_HITS = 500;

const READ_LINES_KEYS = ['path', 'offset', 'limit', 'numbered', 'maxChars'];
const READ_AROUND_KEYS = ['path', 'pattern', 'context', 'ignoreCase', 'maxBlocks', 'maxChars'];

/**
 * ⚠️ THIS BLOCK USED TO SAY "STRICTER THAN `read_file`, DELIBERATELY" — and it
 * was honest at the time. It said `executor.readFile` would happily hand a model
 * `.env.local`, called the divergence intentional, and left narrowing the old
 * door as "a separate, deliberate decision, not something to slip in under a
 * different patch."
 *
 * ⭐ That decision was taken on 2026-08-13 and the divergence is GONE. `read_file`
 * now consults the same list through the tool dispatcher, so the two verbs cannot
 * give different answers about the same file. The old asymmetry was not defence in
 * depth: it meant which of a user's secrets were protected depended on which verb
 * the model happened to reach for.
 *
 * ⚠️ `.env*` INCLUDES `.env.example`, which is usually harmless. Refusing it is
 * the cost of a rule with no exceptions to argue about, and the alternative —
 * "harmless-looking .env variants are fine" — is how the rule dies.
 */
/**
 * ── ⚠️⚠️ THERE USED TO BE A SECOND LIST HERE, AND IT DISAGREED ──────────────
 *
 * `CREDENTIAL_BASENAME` lived in this file and guarded `read_lines` and
 * `read_around`, while `NEVER_COMMIT` in `git.mjs` guarded the pre-load,
 * `search_text`, `repo-map` and `session`. Written separately, they diverged.
 * Measured 2026-08-13 through the real dispatcher:
 *
 *   read_lines LEAKED : vault.pfx · keys.jks · secrets.json · credentials.yml
 *                       · service-account.json   (absent from this list)
 *   read_file  LEAKED : .git-credentials          (absent from that one)
 *
 * ⭐ So which of a user's secrets were protected depended on WHICH VERB the
 * model happened to pick. Two guards for one rule is not defence in depth, it is
 * two half-answers — and each per-tool test passed, about its own list.
 *
 * `refusedCommitPath` is now the only list; `.git-credentials`, which only this
 * file had, was folded into it. ⚠️ Do not reintroduce a local list here: add the
 * pattern in `git.mjs` and every consumer gains it at once.
 */
function credentialRefusal(base) {
  if (refusedCommitPath(base) === null) return null;
  return `this tool does not return credential files, and "${base}" is one — read the code that consumes the variable instead, or use search_text to confirm the NAME exists.`;
}

/**
 * ⚠️ THE UNKNOWN-KEY REFUSAL, WHICH IS THE SECOND-ORDER LESSON OF PROBE 2.
 *
 * `read_file` accepted `{path, offset, limit}` and silently ignored two of the
 * three. The model was not told it had been ignored, so it did the reasonable
 * thing: concluded the FILE was broken and spent four rounds working around a
 * problem that did not exist. A silent success on an argument you do not
 * implement is worse than any refusal, because the model cannot see it.
 *
 * So: an argument this module does not understand is a hard stop, naming the
 * ones it does. Pure.
 */
function unknownKeyRefusal(tool, args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      return `${tool} accepts only ${allowed.join(', ')} — it does not accept "${key}".`;
    }
  }
  return null;
}

/**
 * ── ⚠️⚠️ THE ONLY THING THAT ACTUALLY STOPS A HANG, AND IT WAS MEASURED ─────
 *
 * The first version of this file relied on a wall-clock check between lines. It
 * was WRONG, and a real run proved it inside a minute: `(z+z+)+Q` against a
 * 7.5 MB fixture ran for over FIVE MINUTES and had to be killed. A JavaScript
 * regex is uninterruptible once `test()` is entered, so a clock check between
 * lines cannot help when a SINGLE line is the thing that never returns — and one
 * 60-character run of `z` is enough for that pattern to go exponential.
 *
 * ⭐ So the budget is enforced BEFORE the scan, statically, by refusing the
 * shape: a quantified group whose body also contains a quantifier — `(a+)+`,
 * `(a*)*`, `(a?)+`, `(a{2,})+`. That is the catastrophic-backtracking family,
 * and it is the one class a timeout provably cannot rescue us from.
 *
 * ⚠️ IT IS A HEURISTIC AND IT REFUSES SOME HARMLESS PATTERNS. That trade is the
 * right way round: a refused pattern costs one round and says exactly what to
 * write instead, while the alternative was a terminal that sat there for five
 * minutes looking like the tool was broken. `search.mjs` has the same exposure
 * and does not check — worth flagging separately, not worth widening this patch.
 *
 * Pure. Escapes and character classes are honoured so `\(` and `[+*]` cannot be
 * mistaken for structure.
 */
export function nestedQuantifier(source) {
  const stack = [];
  const QUANT_BRACE = /^\{\d+(,\d*)?\}/;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { i += 1; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }

    if (c === '(') {
      stack.push({ quantifierInside: false });
      // `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>` — the `?` is a group
      // modifier here, and counting it as a quantifier would refuse every
      // non-capturing group in the world.
      if (source[i + 1] === '?') {
        i += 1;
        const n = source[i + 1];
        if (n === '<') {
          const close = source.indexOf('>', i + 1);
          if (close !== -1 && /^[A-Za-z_$]/.test(source[i + 2] ?? '')) i = close;
          else i += 1;
        } else if (n === ':' || n === '=' || n === '!') i += 1;
      }
      continue;
    }
    if (c === ')') {
      const group = stack.pop();
      if (!group) continue; // unbalanced — the RegExp constructor reports it
      const next = source[i + 1];
      const outerQuantified = next === '*' || next === '+' || (next === '{' && QUANT_BRACE.test(source.slice(i + 1)));
      if (outerQuantified && group.quantifierInside) return true;
      const parent = stack[stack.length - 1];
      // A quantifier anywhere in a child counts for the parent: `((a+))+ ` is
      // the same bomb with one more layer of parentheses around it.
      if (parent && (group.quantifierInside || outerQuantified)) parent.quantifierInside = true;
      continue;
    }
    if (c === '*' || c === '+' || c === '?' || (c === '{' && QUANT_BRACE.test(source.slice(i)))) {
      const top = stack[stack.length - 1];
      if (top) top.quantifierInside = true;
    }
  }
  return false;
}

/** An integer, or null. Rejects 12.5 and "12" rather than coercing — a coerced
 *  argument is the silent-acceptance failure above wearing a different hat. */
function asInteger(v) {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function clampMaxChars(raw) {
  if (raw === undefined) return { ok: true, value: DEFAULT_MAX_CHARS };
  const n = asInteger(raw);
  if (n === null || n < 200 || n > HARD_MAX_CHARS) {
    return { ok: false, error: `maxChars must be a whole number between 200 and ${HARD_MAX_CHARS} — omit it for the ${DEFAULT_MAX_CHARS} default and page with offset instead.` };
  }
  return { ok: true, value: n };
}

/** A NUL in the first block means binary, whatever the extension says. Same
 *  heuristic `readFile` and `searchText` use, so all three agree on what text is. */
function looksBinary(absolute, size) {
  if (size === 0) return false;
  const want = Math.min(size, BINARY_SNIFF_BYTES);
  const buf = Buffer.allocUnsafe(want);
  let fd;
  try {
    fd = openSync(absolute, 'r');
    const got = readSync(fd, buf, 0, want, 0);
    return buf.subarray(0, got).includes(0);
  } catch {
    return false; // unreadable is a different failure, reported by the caller
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Everything both tools must agree on before a byte is read: inside the
 * workspace, not a credential, not a directory, not enormous, not binary.
 *
 * Returns data, never throws.
 */
function prepare(root, rawPath) {
  const r = resolveInWorkspace(root, rawPath, 'read');
  if (!r.ok) return { ok: false, error: r.reason };

  const base = basename(r.relative);
  const cred = credentialRefusal(base);
  if (cred) return { ok: false, error: cred };

  let stat;
  try {
    stat = statSync(r.absolute);
  } catch {
    return { ok: false, error: `no such file: ${r.relative} — use find_files to locate it before reading it.` };
  }
  if (stat.isDirectory()) return { ok: false, error: `${r.relative} is a directory — use list_dir.` };
  if (stat.size > MAX_WINDOW_FILE_BYTES) {
    return {
      ok: false,
      error: `${r.relative} is ${stat.size} bytes, over the ${MAX_WINDOW_FILE_BYTES}-byte (8 MB) window limit — no tool here opens a file that large; if it is generated output, read the generator instead.`,
    };
  }
  if (looksBinary(r.absolute, stat.size)) {
    return { ok: false, error: `${r.relative} has a NUL byte in its first 8 KB, so it is not text — this tool returns text only.` };
  }
  return { ok: true, relative: r.relative, absolute: r.absolute, totalBytes: stat.size };
}

/**
 * Walk a file line by line, holding one 64 KB chunk plus the current line.
 *
 * ⚠️ EACH `raw` KEEPS ITS TERMINATOR. That is the whole byte-exactness story:
 * `\r\n` is preserved rather than normalised, a file with no final newline
 * yields a last line with none, and concatenating consecutive windows needs no
 * separator inserted — which is the only version of "byte-for-byte" that can
 * actually be asserted in a test.
 *
 * ⚠️ AND IT IS A GENERATOR, not `readFileSync().split('\n')`, because the split
 * version holds the file AND an array of every line — roughly 3× the file — at
 * the exact moment we are trying to prove we do not.
 */
function* iterateLines(absolute, size) {
  if (size === 0) return;
  const CHUNK = 64 * 1024;
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, size));
  const decoder = new StringDecoder('utf8');
  let fd;
  try {
    fd = openSync(absolute, 'r');
    let pos = 0;
    let pending = '';
    let lineNo = 0;
    while (pos < size) {
      const got = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (got <= 0) break;
      pos += got;
      pending += decoder.write(buf.subarray(0, got));
      /**
       * ⚠️ A CURSOR, NOT `pending = pending.slice(...)` PER LINE. The obvious
       * version re-allocates the remaining buffer once per line — measured on a
       * 7.5 MB / 100k-line fixture it churned 14.8 MB of garbage for a five-line
       * window. Compacting ONCE per 64 KB chunk instead keeps the retained set
       * at one chunk and drops the churn to the lines actually yielded.
       */
      let cursor = 0;
      let idx = pending.indexOf('\n', cursor);
      while (idx !== -1) {
        lineNo += 1;
        yield { number: lineNo, raw: pending.slice(cursor, idx + 1) };
        cursor = idx + 1;
        idx = pending.indexOf('\n', cursor);
      }
      if (cursor > 0) pending = pending.slice(cursor);
    }
    pending += decoder.end();
    if (pending.length > 0) yield { number: lineNo + 1, raw: pending };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The terminator is content for concatenation and noise for a regex test —
 *  `$` must anchor at the end of the LINE, not after an invisible `\r`. */
function withoutTerminator(raw) {
  return raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}

/** `NNN| ` gutter, right-aligned to the widest number in the window. Only ever
 *  applied beside an untouched `exact` copy. */
function addGutter(lines, startLine) {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((raw, i) => {
    const n = String(startLine + i).padStart(width);
    const term = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    return `${n}| ${withoutTerminator(raw)}${term}`;
  }).join('');
}

/**
 * ── TOOL: read_lines ────────────────────────────────────────────────────────
 * `offset` is a 1-INDEXED LINE NUMBER. Not a byte offset, not 0-indexed —
 * because that is what the model already sends unprompted, and a primitive that
 * disagrees with the caller's existing habit is a primitive nobody uses
 * correctly.
 */
function readLines(root, args) {
  const bad = unknownKeyRefusal('read_lines', args, READ_LINES_KEYS);
  if (bad) return { ok: false, error: bad };

  const offset = args.offset === undefined ? 1 : asInteger(args.offset);
  if (offset === null || offset < 1) {
    return { ok: false, error: `offset is a 1-indexed LINE NUMBER, so the first line is offset 1 — you sent ${JSON.stringify(args.offset)}.` };
  }
  const limit = args.limit === undefined ? DEFAULT_LIMIT : asInteger(args.limit);
  if (limit === null || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, error: `limit must be a whole number of lines between 1 and ${MAX_LIMIT} — you sent ${JSON.stringify(args.limit)}; page through a bigger span with repeated offsets.` };
  }
  if (args.numbered !== undefined && typeof args.numbered !== 'boolean') {
    return { ok: false, error: 'numbered must be true or false — leave it out to get the file exactly as written, which is what you want if you are about to copy an edit_file old_string.' };
  }
  const budget = clampMaxChars(args.maxChars);
  if (!budget.ok) return budget;

  const pre = prepare(root, args.path);
  if (!pre.ok) return pre;

  /**
   * ⚠️ THE SCAN RUNS TO EOF EVEN AFTER THE WINDOW IS FULL, and that is not
   * waste. `totalLines` is the number that turns paging from a guess into
   * arithmetic — without it the model cannot tell "the window ended" from "the
   * file ended", which is the ambiguity that made it re-read the same blob.
   */
  const wantFrom = offset;
  const wantTo = offset + limit - 1;
  const collected = [];
  let totalLines = 0;
  for (const line of iterateLines(pre.absolute, pre.totalBytes)) {
    totalLines = line.number;
    if (line.number >= wantFrom && line.number <= wantTo) collected.push(line.raw);
  }

  // An empty file is a fact, not a failure — refusing it would send the model
  // hunting for a file that is right there and simply has nothing in it.
  if (totalLines === 0) {
    return {
      ok: true, tool: 'read_lines', path: pre.relative,
      startLine: 0, endLine: 0, totalLines: 0, totalBytes: pre.totalBytes,
      text: '', bytes: 0, nextOffset: null, truncated: false, partialLine: null,
    };
  }
  if (offset > totalLines) {
    return { ok: false, error: `offset ${offset} is past the end of ${pre.relative} — it has ${totalLines} lines, so the last readable offset is ${totalLines}.` };
  }

  // ── THE TRUNCATION, AND THE ONLY DIRECTION IT IS ALLOWED TO CUT ───────────
  const kept = [];
  let chars = 0;
  let partialLine = null;
  let truncated = false;
  for (let i = 0; i < collected.length; i++) {
    const raw = collected[i];
    if (chars + raw.length <= budget.value) {
      kept.push(raw);
      chars += raw.length;
      continue;
    }
    /**
     * ⚠️ THE ONE CASE WHERE A PARTIAL LINE IS THE HONEST ANSWER. "Whole lines
     * only" has an obvious hole: a minified bundle is one line of 400 KB, and
     * the whole-line rule would return NOTHING for it. Returning nothing to a
     * model reads as "the file is empty", which is a lie; returning the head
     * with `partialLine` set is true and usable. Note it still cuts at the END.
     */
    if (kept.length === 0) {
      kept.push(raw.slice(0, budget.value));
      chars = budget.value;
      partialLine = offset;
    }
    truncated = true;
    break;
  }

  const endLine = partialLine !== null ? offset : offset + kept.length - 1;
  const exact = kept.join('');
  const text = args.numbered === true && partialLine === null ? addGutter(kept, offset) : exact;

  const result = {
    ok: true,
    tool: 'read_lines',
    path: pre.relative,
    startLine: offset,
    endLine,
    totalLines,
    totalBytes: pre.totalBytes,
    text,
    bytes: Buffer.byteLength(exact, 'utf8'),
    // The first line NOT returned. Null only when the file genuinely ended.
    nextOffset: endLine < totalLines ? endLine + 1 : null,
    truncated,
    partialLine,
  };
  // ⚠️ `exact` rides along whenever the gutter is on: a model handed only the
  // decorated version will paste the decorated version into an edit and be
  // refused, which is the exact failure this module was built to end.
  if (args.numbered === true) result.exact = exact;
  return result;
}

/**
 * ── TOOL: read_around ───────────────────────────────────────────────────────
 * The tool an `edit_file` `old_string` is copied from. `search_text` tells you
 * WHERE; this tells you what is actually there, to the byte.
 */
function readAround(root, args) {
  const bad = unknownKeyRefusal('read_around', args, READ_AROUND_KEYS);
  if (bad) return { ok: false, error: bad };

  if (typeof args.pattern !== 'string' || args.pattern === '') {
    return { ok: false, error: 'pattern must be a non-empty regular-expression string — pass the distinctive part of the line you are looking for.' };
  }
  if (args.pattern.length > MAX_PATTERN_CHARS) {
    return { ok: false, error: `pattern is ${args.pattern.length} characters, over the ${MAX_PATTERN_CHARS}-character limit — match a short distinctive substring and read the surrounding lines instead of matching the whole thing.` };
  }
  const context = args.context === undefined ? DEFAULT_CONTEXT : asInteger(args.context);
  if (context === null || context < 0 || context > MAX_CONTEXT) {
    return { ok: false, error: `context must be a whole number of lines between 0 and ${MAX_CONTEXT} — you sent ${JSON.stringify(args.context)}; for a bigger span use read_lines with an offset.` };
  }
  const maxBlocks = args.maxBlocks === undefined ? DEFAULT_MAX_BLOCKS : asInteger(args.maxBlocks);
  if (maxBlocks === null || maxBlocks < 1 || maxBlocks > MAX_BLOCKS) {
    return { ok: false, error: `maxBlocks must be a whole number between 1 and ${MAX_BLOCKS} — you sent ${JSON.stringify(args.maxBlocks)}; narrow the pattern rather than asking for more blocks.` };
  }
  if (args.ignoreCase !== undefined && typeof args.ignoreCase !== 'boolean') {
    return { ok: false, error: 'ignoreCase must be true or false — it defaults to true, matching search_text.' };
  }
  const budget = clampMaxChars(args.maxChars);
  if (!budget.ok) return budget;

  /**
   * ⚠️ CASE-INSENSITIVE BY DEFAULT, TO AGREE WITH `search_text`. That tool
   * hardcodes the `i` flag. If this one defaulted to exact matching, a hit the
   * model had just found with search_text could come back "0 matches" here —
   * and it would conclude the file had changed under it. Two tools in one loop
   * must not disagree about what a match is.
   */
  let rx;
  try {
    rx = new RegExp(args.pattern, args.ignoreCase === false ? '' : 'i');
  } catch (err) {
    return { ok: false, error: `not a valid regular expression: ${String(err?.message || err)} — escape the special characters if you meant a literal string.` };
  }
  // ⚠️ BEFORE A BYTE IS READ. See nestedQuantifier: this class of pattern cannot
  // be stopped by a timeout once it starts, so it has to be stopped by not
  // starting. Measured: the version without this check ran 5+ minutes.
  if (nestedQuantifier(args.pattern)) {
    return {
      ok: false,
      error: `"${args.pattern}" nests a quantifier inside a quantified group (like "(a+)+"), which can take exponential time on one long line and cannot be interrupted — rewrite it without the inner repetition, e.g. match a literal prefix and widen "context" instead.`,
    };
  }

  const pre = prepare(root, args.path);
  if (!pre.ok) return pre;

  // ── PASS 1: line NUMBERS only ─────────────────────────────────────────────
  // Two passes over the file rather than one pass holding every line, because
  // "never more than 8 MB in memory" has to survive an 8 MB file.
  const hits = [];
  let totalLines = 0;
  let hitsTruncated = false;
  const started = Date.now();
  for (const line of iterateLines(pre.absolute, pre.totalBytes)) {
    totalLines = line.number;
    /**
     * The clock is the SECOND line of defence, not the first — `nestedQuantifier`
     * above already refused the patterns a clock cannot save us from. What this
     * catches is the merely-slow case: a linear pattern over a very large file,
     * which would otherwise sit there looking like a hung terminal.
     *
     * Every 64 lines rather than every line: 1,500 `Date.now()` calls on a
     * 100k-line file is free, and per-line would be measurable.
     */
    if ((line.number & 0x3f) === 0 && Date.now() - started > SCAN_BUDGET_MS) {
      return {
        ok: false,
        error: `the pattern was still scanning ${pre.relative} after the ${SCAN_BUDGET_MS}ms budget — anchor it (drop a leading ".*", add a literal prefix) and run it again, or use read_lines if you already know roughly where to look.`,
      };
    }
    if (hits.length >= MAX_HITS) { hitsTruncated = true; continue; }
    if (rx.test(withoutTerminator(line.raw))) hits.push(line.number);
  }

  if (hits.length === 0) {
    return {
      ok: true, tool: 'read_around', path: pre.relative, pattern: args.pattern,
      totalLines, totalBytes: pre.totalBytes, matchCount: 0, blocks: [],
      truncated: false, blocksOmitted: 0, nextOffset: null,
    };
  }

  // Merge into ranges. Adjacent counts as overlapping: a one-line gap costs more
  // as a "··· 1 line omitted ···" marker than as the line itself.
  const ranges = [];
  for (const h of hits) {
    const start = Math.max(1, h - context);
    const end = Math.min(totalLines, h + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  const blocksOmitted = Math.max(0, ranges.length - maxBlocks);
  const wanted = ranges.slice(0, maxBlocks);

  // ── PASS 2: materialise only the wanted lines ─────────────────────────────
  const byRange = wanted.map(() => []);
  for (const line of iterateLines(pre.absolute, pre.totalBytes)) {
    for (let i = 0; i < wanted.length; i++) {
      if (line.number >= wanted[i].start && line.number <= wanted[i].end) byRange[i].push(line.raw);
    }
  }

  const blocks = [];
  let chars = 0;
  let truncated = blocksOmitted > 0;
  let nextOffset = blocksOmitted > 0 ? ranges[maxBlocks].start : null;
  for (let i = 0; i < wanted.length; i++) {
    const kept = [];
    let cut = false;
    for (const raw of byRange[i]) {
      if (chars + raw.length > budget.value) { cut = true; break; }
      kept.push(raw);
      chars += raw.length;
    }
    if (kept.length > 0) {
      blocks.push({ startLine: wanted[i].start, endLine: wanted[i].start + kept.length - 1, text: kept.join('') });
    }
    if (cut) {
      truncated = true;
      nextOffset = wanted[i].start + kept.length;
      break;
    }
  }

  return {
    ok: true,
    tool: 'read_around',
    path: pre.relative,
    pattern: args.pattern,
    totalLines,
    totalBytes: pre.totalBytes,
    matchCount: hits.length,
    matchesTruncated: hitsTruncated,
    blocks,
    truncated,
    blocksOmitted,
    nextOffset,
  };
}

/**
 * The one entry point. `tool` is passed explicitly by the dispatcher; the
 * inference fallback exists only so a direct caller (or a test) can hand over an
 * argument object and get the obvious thing.
 *
 * ⚠️ INFERENCE IS BY `pattern`, AND IT IS NOT A LOOSE MATCH — once inferred, the
 * unknown-key rule applies to THAT tool's keys, so `{path, pattern, offset}`
 * lands as a read_around with an illegal `offset` and is refused. Guessing which
 * tool the caller meant is acceptable; guessing which arguments they meant is
 * exactly the silent acceptance this module exists to stop.
 *
 * @param {string} root workspace root
 * @param {Record<string, unknown>} args
 * @param {'read_lines'|'read_around'} [tool]
 */
export function readWindow(root, args, tool = undefined) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'arguments must be a JSON object with at least a "path".' };
  }
  const chosen = tool ?? ('pattern' in args ? 'read_around' : 'read_lines');
  if (chosen === 'read_around') return readAround(root, args);
  if (chosen === 'read_lines') return readLines(root, args);
  return { ok: false, error: `unknown window tool "${chosen}" — this module implements read_lines and read_around.` };
}

/**
 * ⚠️ THE DESCRIPTIONS DO THE TEACHING, because a tool the model uses wrongly is
 * a tool that does not exist. Two facts have to survive into the payload: offset
 * is a LINE NUMBER, and the text comes back byte-exact so it can be pasted
 * straight into `edit_file`. Both are stated, in the tool the model reads.
 */
export function readWindowToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'read_lines',
        description: [
          'Read a WINDOW of a text file: whole lines, exactly as written, no line-number gutter and no ellipsis.',
          'offset is a 1-indexed LINE NUMBER (offset 1 is the first line); limit is how many lines.',
          'Use this instead of read_file for anything over ~200 lines: read_file truncates the MIDDLE, this truncates the END and tells you totalLines and the nextOffset to continue from.',
          'Reads files up to 8 MB. Never returns credential files.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative path, e.g. "lib/tools.mjs".' },
            offset: { type: 'integer', description: `1-indexed first line to return. Default 1.` },
            limit: { type: 'integer', description: `How many lines. Default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.` },
            numbered: { type: 'boolean', description: 'Prefix each line with "NNN| ". Default false — leave it off when you are about to copy text into edit_file.' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_around',
        description: [
          'Show the exact lines around every match of a pattern in one file, with context either side.',
          'This is where you copy an edit_file old_string from: the text is byte-exact, so the indentation is the real indentation.',
          'search_text returns each hit byte-exact, including its leading indentation, so its text can be '
          + 'used directly as an edit_file old_string. Use read_around when you need the SURROUNDING lines, '
          + 'not to recover the line itself.',
          'Overlapping windows merge; skipped spans are marked. Case-insensitive by default, like search_text.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative path, e.g. "lib/git.mjs".' },
            pattern: { type: 'string', description: `A JavaScript regular expression tested per line, at most ${MAX_PATTERN_CHARS} characters.` },
            context: { type: 'integer', description: `Lines of context either side. Default ${DEFAULT_CONTEXT}, maximum ${MAX_CONTEXT}.` },
            ignoreCase: { type: 'boolean', description: 'Default true. Set false for an exact-case match.' },
            maxBlocks: { type: 'integer', description: `How many separate blocks to return. Default ${DEFAULT_MAX_BLOCKS}, maximum ${MAX_BLOCKS}.` },
          },
          required: ['path', 'pattern'],
        },
      },
    },
  ];
}

/**
 * What the MODEL sees. Exactly one header line, then the verbatim text.
 *
 * ⚠️ THE CONTINUATION INSTRUCTION LIVES IN THE HEADER, NOT IN A TRAILER. A
 * trailer after the code is a line the model may copy into an edit; a header is
 * unambiguously commentary. And it says the literal next call to make, because
 * "truncated" alone is what a model reads as "this file is unreadable".
 */
export function formatWindowForModel(result) {
  if (!result || result.ok !== true) return `read failed: ${result?.error ?? 'unknown error'}`;

  if (result.tool === 'read_around') {
    const head = result.matchCount === 0
      ? `${result.path} — no line matches /${result.pattern}/ in ${result.totalLines} lines; try a shorter fragment or search_text across the repo`
      : `${result.path} — ${result.matchCount}${result.matchesTruncated ? '+' : ''} match${result.matchCount === 1 ? '' : 'es'} for /${result.pattern}/, ${result.totalLines} lines total${result.truncated ? `; stopped early, continue with read_lines offset ${result.nextOffset}` : ''}`;
    const body = [];
    let previousEnd = null;
    for (const b of result.blocks) {
      if (previousEnd !== null && b.startLine > previousEnd + 1) {
        body.push(`··· lines ${previousEnd + 1}-${b.startLine - 1} omitted ···`);
      }
      body.push(`lines ${b.startLine}-${b.endLine}:`);
      // ⚠️ trailing terminator stripped from the BLOCK, never from a line inside
      // it — otherwise the marker below would sit on the last line of code.
      body.push(b.text.replace(/\r?\n$/, ''));
      previousEnd = b.endLine;
    }
    return [head, ...body].join('\n');
  }

  if (result.totalLines === 0) return `${result.path} is empty (0 lines)`;
  const tail = result.partialLine !== null
    ? ` — line ${result.partialLine} is longer than the whole budget, so only its first ${result.bytes} bytes are shown and the REST OF THAT LINE is not retrievable through this tool${result.nextOffset === null ? '' : `; read_lines offset ${result.nextOffset} resumes at the next line`}`
    : result.truncated || result.nextOffset !== null
      ? ` — continue with read_lines offset ${result.nextOffset}`
      : '';
  const head = `${result.path} lines ${result.startLine}-${result.endLine} of ${result.totalLines} (${result.bytes} bytes)${tail}`;
  return `${head}\n${result.text.replace(/\r?\n$/, '')}`;
}
