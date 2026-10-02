/**
 * ── ⭐⭐⭐ `profile_table` — THE FILE THE AGENT WAS TOLD NO TOOL COULD OPEN ───
 *
 * MEASURED ACROSS OUR OWN 139 BENCH RUNS (`bench/terminal-bench/results/`,
 * 2026-08-29), by tallying every `error` string in every `acuvo-result.json`.
 * Second only to `absolute path` — which already has its next-move clause in
 * `workspace.mjs` — is the read ceiling, and every single hit is DATA:
 *
 *     8 ×  read_file  "bn_sample_10k.csv"          844,949 B  over 200,000
 *     2 ×  read_file  "doomgeneric_mips.map"       207,742 B  over 200,000
 *     1 ×  read_file  "text.gcode"               1,661,422 B  over 200,000
 *     1 ×  read_lines "input.csv"               51,066,691 B  over 8 MB
 *     1 ×  read_lines "expected.csv"            38,066,688 B  over 8 MB
 *
 * ⚠️⚠️ THE 8 MB ONE IS THE WHOLE ARGUMENT, because of what the refusal SAYS:
 * *"no tool here opens a file that large"*. That is this package telling a model,
 * in its own words, that it has a hole — and the model answered it verbatim in
 * the next round of `large-scale-text-editing__WBWFzjz`:
 *
 *     The files are too large to read directly. Let me use the shell to
 *     examine them.                                             — round 4/16
 *     $ head -c 2000 /app/input.csv
 *
 * ⭐ ON THE SURFACE A STRANGER ACTUALLY INSTALLS THERE IS NO SHELL, so that
 * recovery does not exist and the run is simply dead. This is `check_tools`'s
 * argument applied to the other half of the same wall: the shell is not the
 * answer to a missing verb, it is the thing most users do not have.
 *
 * ── ⭐⭐ AND EVEN WITH A SHELL IT COSTS THE TWO ROUNDS THAT MATTER MOST ──────
 *
 * All four `bn-fit-modify` runs open identically, and all four scored 0:
 *
 *     round 1  "I'll start by examining the data file."
 *              ✖ read_file: bn_sample_10k.csv is 844949 bytes, over the limit
 *     round 2  · read_lines            (or:  $ head -5 … && wc -l …)
 *     round 3  "The data has 5 columns: U, Y, R, D, M."
 *
 * Two rounds of a sixteen-round budget, every time, to learn five column names —
 * and `head -5` cannot answer the question the task actually had, which was what
 * the columns CONTAIN (they are binary; the task is to recover a DAG over them).
 * `profile_table` returns the names, the types, the cardinality, the ranges and
 * the first rows in round 1.
 *
 * ── ⚠️ WHY IT IS NOT `read_lines` WITH A BIGGER CEILING ─────────────────────
 *
 * `read_lines` returns TEXT and its cost grows with the file. This returns a
 * SUMMARY whose size is bounded by the COLUMN COUNT, not the row count — a
 * 51 MB file and a 51 KB file with the same schema produce nearly the same
 * ~400-token answer. That is the same trade `see_page` makes and `tools.mjs`
 * argues for it there: anyone can take the photograph; the compression is the
 * product.
 *
 * ── ⚠️⚠️ THE PARSER IS VENDORED, NOT WRITTEN — see `vendor/csv-parser.mjs` ──
 *
 * Splitting on the delimiter is four lines and wrong. RFC 4180 lets a field
 * contain the delimiter, a doubled quote and A NEWLINE, so a line-oriented
 * reader mis-frames every row after the first quoted newline and then reports a
 * confident, wrong column count — which is the one thing a verb whose entire
 * output is "here is what is in your data" must never do. PapaParse's core
 * (MIT, zero dependencies, the most-exercised CSV state machine in JavaScript)
 * is copied in under this package's assembler rule, and its own 63
 * `CORE_PARSER_TESTS` run against our cut in `test/table-profile.test.mjs`.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { resolveInWorkspace } from './workspace.mjs';
import { refusedCommitPath } from './secret-paths.mjs';
import { Parser } from './vendor/csv-parser.mjs';

/**
 * ⚠️ A CEILING ON WORK, NOT ON FILE SIZE, and the difference is the point of
 * this verb. Nothing below ever holds more than one 256 KB chunk plus the
 * per-column accumulators, so an arbitrarily large file is walkable; what has to
 * be bounded is how long we are willing to walk. 256 MB at ~150 MB/s of pure
 * scanning is a couple of seconds, and past it the answer is reported as a
 * SAMPLE rather than silently presented as the whole file.
 */
export const MAX_SCAN_BYTES = 256 * 1024 * 1024;

/** One chunk of the file in memory at a time. */
export const CHUNK_BYTES = 256 * 1024;

/**
 * ⚠️ A CARDINALITY CEILING PER COLUMN, because a 10-million-row id column would
 * otherwise put a 10-million-entry Set in memory to answer "how many distinct
 * values" — the exact unbounded growth this module exists to avoid. Past the
 * cap we stop counting and SAY so (`distinctAtLeast`), rather than reporting a
 * number that is quietly the cap.
 */
export const MAX_DISTINCT_TRACKED = 1000;

/** How many example values a categorical column shows. */
export const TOP_VALUES = 5;

/** How many whole rows come back as a sample. */
export const DEFAULT_HEAD_ROWS = 5;
export const MAX_HEAD_ROWS = 20;

/** Columns beyond this are counted, not profiled — a 3,000-column matrix would
 *  otherwise return more text than the file's first page. */
export const MAX_COLUMNS_PROFILED = 60;

/** Values longer than this are truncated in the sample; a free-text column can
 *  hold a whole document per cell. */
const MAX_SAMPLE_CHARS = 60;

/** A NUL in the first block means binary, whatever the extension says — the same
 *  heuristic `read_file`, `read_lines` and `search_text` use, so all four agree
 *  on what text is. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * ⚠️ ANCHORED, AND `Number()` IS NOT ENOUGH ON ITS OWN. `Number('')` is 0,
 * `Number(' ')` is 0 and `Number('0x1f')` is 31 — so a column of empty cells
 * would profile as "integer, min 0, max 0" and a column of hex ids would become
 * numeric. The shapes below are what a spreadsheet, a database export and R all
 * agree is a number, and nothing else is treated as one.
 */
const INTEGER_SHAPE = /^[+-]?\d+$/;
const NUMBER_SHAPE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const BOOLEAN_SHAPE = /^(?:true|false|t|f|yes|no|y|n)$/i;

/** The strings every ecosystem writes for "no value here". Counted as missing
 *  rather than as a category, which is what makes a null count useful. */
const MISSING_SHAPE = /^(?:|na|n\/a|nan|null|nil|none|-)$/i;

/**
 * ── ⭐⭐ THE EXTENSIONS THAT MEAN "DELIMITED", AND THE ONE PLACE THEY LIVE ────
 *
 * Used by the OFFER gate below and quoted by `workspace.mjs`'s read-ceiling
 * refusal, which names this verb only for a file shaped like a table. Two of the
 * recorded over-limit hits were a linker `.map` and a `.gcode`, and pointing a
 * model at a table reader for those is the "documents the wrong thing" failure
 * this package keeps a whole comment block about.
 */
export const TABULAR_EXTENSIONS = Object.freeze(['.csv', '.tsv', '.tab', '.psv', '.dat']);

/** ⚠️ ONE LEVEL, AND A CEILING ON DIRECTORIES. Same shape as `languagesPresent`
 *  directly across the registry — real repositories keep data in `data/`,
 *  `fixtures/` or the root, and a full walk on every turn is not a gate, it is a
 *  tax. */
const EVIDENCE_PROBE_DIRS = 12;
const EVIDENCE_SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', 'coverage', '.git']);

const evidenceCache = new Map();

/**
 * Does this workspace contain a delimited data file at all?
 *
 * ⭐ WHY THE OFFER IS GATED AT ALL, when the shortlist already narrows by brief.
 * The schema is 962 bytes and `declared-tools-are-named.test.mjs` holds the raw
 * 16-round offer under 60,000 — it was at 59,672 with 328 bytes of headroom, so
 * an unconditional offer would have crossed a deliberate ceiling that belongs to
 * nobody's feature in particular. Gating on evidence is not a way around that
 * ceiling; it is the honest description of the tool. A repository with no
 * delimited file cannot use this verb, exactly as a repository with no schema
 * cannot use `inspect_db` — and `tools.mjs` already says of that pair that they
 * are *"offered on evidence, and only on evidence"*.
 *
 * ⚠️ AND THE TWO GATES DO NOT OVERLAP. The offer asks "is there data HERE"; the
 * shortlist asks "is this brief ABOUT data". A model on a data repo doing a
 * typing task pays nothing, and a model on a code repo cannot be offered a verb
 * with nothing to point it at.
 */
export function tableEvidence(root) {
  if (typeof root !== 'string' || root === '' || root.startsWith('(')) return false;
  const cached = evidenceCache.get(root);
  if (cached !== undefined) return cached;

  const isTabular = (name) => {
    const dot = name.lastIndexOf('.');
    return dot > 0 && TABULAR_EXTENSIONS.includes(name.slice(dot).toLowerCase());
  };

  let found = false;
  const dirs = [];
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !EVIDENCE_SKIP.has(e.name) && dirs.length < EVIDENCE_PROBE_DIRS) dirs.push(e.name);
      } else if (isTabular(e.name)) { found = true; break; }
    }
    if (!found) {
      for (const dir of dirs) {
        let children;
        try { children = readdirSync(join(root, dir), { withFileTypes: true }); } catch { continue; }
        if (children.some((c) => !c.isDirectory() && isTabular(c.name))) { found = true; break; }
      }
    }
  } catch {
    // An unreadable root is not evidence, and must not be an exception either.
  }
  evidenceCache.set(root, found);
  return found;
}

/** Test seam — the cache is keyed by root and a test creates and deletes roots. */
export function resetTableEvidenceCache() { evidenceCache.clear(); }

/**
 * The names to OFFER this turn.
 *
 * ⚠️ MULTI-ROUND ONLY, like every other read: it describes a file so the NEXT
 * round can act on it, and a description with no round after it has nowhere to
 * go. NOT gated on `allowRun` — it spawns nothing, and withholding it under
 * `--no-run` would remove the only large-data reader from exactly the shell-less
 * surface that has no `head -5` to fall back to.
 */
export function tableProfileToolNames(root, { maxRounds = 2 } = {}) {
  if (maxRounds <= 1) return [];
  return tableEvidence(root) ? ['profile_table'] : [];
}

function credentialRefusal(base) {
  if (refusedCommitPath(base) === null) return null;
  return `this tool does not return credential files, and "${base}" is one — profile the code that consumes the variable instead.`;
}

/** A NUL in the first block means binary. Returns data, never throws. */
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
 * Walk the file, handing every parsed ROW to `onRow`, holding one chunk plus the
 * partially-parsed tail.
 *
 * ⭐ THE `ignoreLastRow` FLAG IS WHY THE VENDORED CUT IS THE RIGHT CUT. A 256 KB
 * chunk boundary lands mid-row roughly always, and — because a quoted field may
 * contain a newline — you cannot tell where a row ends without parsing. Upstream
 * solves it by parsing the buffer with the last row held back and reporting how
 * far it got (`getCharIndex`); we keep the unconsumed tail and prepend it to the
 * next chunk. That is upstream's own `ChunkStreamer` strategy, with the browser
 * and Node-stream transports left behind.
 *
 * ⚠️ IT DOES NOT COUNT ROWS, AND THAT IS DELIBERATE. The first version counted
 * here and reported 10,001 rows for a 10,000-row file, then hung
 * `absentInSomeRows: 1` off every column to explain the phantom — because a file
 * ending in a newline makes the parser emit one final `['']`. Only the caller
 * knows which rows are RECORDS (a blank line is not one, and the header is not
 * one either), so only the caller may count them.
 *
 * @returns {{ scannedBytes: number, truncated: boolean }}
 */
function walkRows(absolute, size, { delimiter, onRow, maxBytes }) {
  const limit = Math.min(size, maxBytes);
  const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(limit, 1)));
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let pos = 0;
  let fd;
  try {
    fd = openSync(absolute, 'r');
    while (pos < limit) {
      const got = readSync(fd, buf, 0, Math.min(buf.length, limit - pos), pos);
      if (got <= 0) break;
      pos += got;
      pending += decoder.write(buf.subarray(0, got));
      const atEnd = pos >= limit;
      const parser = new Parser({ delimiter });
      /**
       * ⚠️ `ignoreLastRow` IS TRUE FOR EVERY CHUNK BUT THE LAST. Passing false
       * mid-file emits a row that is half of a real one; passing true at the end
       * silently DROPS the final row of any file without a trailing newline —
       * both are off-by-one errors in the row count this verb reports as fact.
       */
      const out = parser.parse(pending, 0, !atEnd);
      for (const row of out.data) onRow(row);
      /**
       * ⚠️⚠️ `meta.cursor`, NOT `getCharIndex()` — AND THE OBVIOUS ONE IS
       * WRONG. `getCharIndex()` returns the raw scan position, which under
       * `ignoreLastRow` has already run to the END of the buffer past the row
       * being held back; `meta.cursor` is `lastCursor`, the end of the last row
       * actually EMITTED. Resuming from the scan position re-frames the held-back
       * row as a fresh record, and it is the resume upstream's own
       * `ChunkStreamer` uses (`papaparse.js:468`) for exactly this reason.
       *
       * ⚠️ MEASURED, because the wrong one does not throw — it lies quietly. On
       * a 44.9 MB / 700,000-row fixture with a quoted newline in every row,
       * `getCharIndex()` reported **700,095 rows** (one phantom per chunk
       * boundary it mis-framed) and shifted the columns, so the `name` column
       * came back with a numeric min and max. `meta.cursor` reports 700,000.
       */
      pending = atEnd ? '' : pending.slice(out.meta.cursor);
    }
    pending += decoder.end();
    if (pending.length > 0) {
      const out = new Parser({ delimiter }).parse(pending, 0, false);
      for (const row of out.data) onRow(row);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { scannedBytes: pos, truncated: pos < size };
}

/**
 * Guess the delimiter from the first block, the way upstream's `guessDelimiter`
 * does: parse a preview with each candidate and keep the one whose row lengths
 * are most CONSISTENT, breaking ties on field count.
 *
 * ⚠️ CONSISTENCY, NOT FREQUENCY. Counting commas picks `,` for a semicolon file
 * whose free-text column happens to contain commas — which is the European CSV
 * everybody's naive sniffer gets wrong.
 */
export function guessDelimiter(sample, candidates = [',', '\t', ';', '|']) {
  let best = null;
  let bestDelta = Infinity;
  let bestFields = 0;
  for (const delim of candidates) {
    const preview = new Parser({ delimiter: delim, preview: 10 }).parse(sample, 0, true);
    let delta = 0;
    let total = 0;
    let counted = 0;
    let prev;
    for (const row of preview.data) {
      if (row.length === 1 && row[0] === '') continue;
      total += row.length;
      counted += 1;
      if (prev !== undefined && row.length > 0) delta += Math.abs(row.length - prev);
      prev = row.length;
    }
    const avg = counted > 0 ? total / counted : 0;
    if (avg > 1.99 && (delta < bestDelta || (delta === bestDelta && avg > bestFields))) {
      best = delim; bestDelta = delta; bestFields = avg;
    }
  }
  return best;
}

/** Read the first `n` bytes as text, for delimiter sniffing. */
function head(absolute, size, n) {
  const want = Math.min(size, n);
  if (want === 0) return '';
  const buf = Buffer.allocUnsafe(want);
  let fd;
  try {
    fd = openSync(absolute, 'r');
    const got = readSync(fd, buf, 0, want, 0);
    return new StringDecoder('utf8').write(buf.subarray(0, got));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One column's running aggregate. Fixed size regardless of row count, apart
 *  from the distinct Set, which is capped. */
function newColumn(name, index) {
  return {
    name, index,
    filled: 0, missing: 0,
    ints: 0, nums: 0, bools: 0,
    min: null, max: null, sum: 0,
    distinct: new Set(), distinctCapped: false,
    longest: 0,
  };
}

function observe(col, raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (MISSING_SHAPE.test(v)) { col.missing += 1; return; }
  col.filled += 1;
  if (v.length > col.longest) col.longest = v.length;
  if (!col.distinctCapped) {
    col.distinct.add(v);
    if (col.distinct.size > MAX_DISTINCT_TRACKED) { col.distinctCapped = true; col.distinct.clear(); }
  }
  if (NUMBER_SHAPE.test(v)) {
    col.nums += 1;
    if (INTEGER_SHAPE.test(v)) col.ints += 1;
    const n = Number(v);
    col.sum += n;
    if (col.min === null || n < col.min) col.min = n;
    if (col.max === null || n > col.max) col.max = n;
  } else if (BOOLEAN_SHAPE.test(v)) {
    col.bools += 1;
  }
}

const clip = (s) => (s.length > MAX_SAMPLE_CHARS ? `${s.slice(0, MAX_SAMPLE_CHARS - 1)}…` : s);

/** Round to 4 significant-ish decimals without dragging in a formatter. An
 *  integer stays an integer, so a count column does not report "10.0000". */
function tidy(n) {
  if (n === null || !Number.isFinite(n)) return null;
  return Number.isInteger(n) ? n : Number(n.toFixed(4));
}

function summarise(col, rows) {
  const out = { name: col.name };
  const seen = col.filled + col.missing;
  /**
   * ⚠️ THE TYPE IS A MAJORITY OF THE NON-MISSING CELLS, NOT OF ALL OF THEM. A
   * column that is 90% empty and 10% integers is an integer column with a lot of
   * gaps, and calling it "text" because the blanks outnumber the numbers is how
   * a profiler talks a model out of doing arithmetic on real data.
   */
  if (col.filled === 0) out.type = 'empty';
  else if (col.ints === col.filled) out.type = 'integer';
  else if (col.nums === col.filled) out.type = 'number';
  else if (col.bools === col.filled) out.type = 'boolean';
  else if (col.nums > col.filled / 2) out.type = 'number (mixed)';
  else out.type = 'text';

  if (col.missing > 0) out.missing = col.missing;
  if (col.distinctCapped) out.distinctAtLeast = MAX_DISTINCT_TRACKED;
  else out.distinct = col.distinct.size;

  if (col.nums > 0) {
    out.min = tidy(col.min);
    out.max = tidy(col.max);
    out.mean = tidy(col.sum / col.nums);
  }
  /**
   * ⭐ THE VALUE LIST IS WHAT MAKES A CATEGORICAL COLUMN ACTIONABLE, and it is
   * the fact the bench runs spent two rounds getting: `bn_sample_10k.csv`'s five
   * columns are BINARY, which `head -5` shows only by luck and this states.
   */
  if (!col.distinctCapped && col.distinct.size > 0 && col.distinct.size <= TOP_VALUES) {
    out.values = [...col.distinct].map(clip);
  } else if (col.longest > MAX_SAMPLE_CHARS) {
    out.longestValue = col.longest;
  }
  if (seen < rows) out.absentInSomeRows = rows - seen;
  return out;
}

/**
 * The verb.
 *
 * @param {string} root the workspace root
 * @param {{ path?: unknown, delimiter?: unknown, header?: unknown, head_rows?: unknown }} args
 */
export function profileTable(root, args = {}) {
  const rawPath = typeof args?.path === 'string' ? args.path.trim() : '';
  if (!rawPath) return { ok: false, error: 'name a path — profile_table takes one workspace-relative file, e.g. {"path":"data/sales.csv"}' };

  const r = resolveInWorkspace(root, rawPath, 'read');
  if (!r.ok) return { ok: false, error: r.reason };

  const cred = credentialRefusal(basename(r.relative));
  if (cred) return { ok: false, error: cred };

  let stat;
  try { stat = statSync(r.absolute); } catch {
    return { ok: false, error: `no such file: ${r.relative} — use find_files to locate it before profiling it.` };
  }
  if (stat.isDirectory()) return { ok: false, error: `${r.relative} is a directory — use list_dir.` };
  if (stat.size === 0) return { ok: false, error: `${r.relative} is empty — there is nothing to profile.` };
  if (looksBinary(r.absolute, stat.size)) {
    return { ok: false, error: `${r.relative} has a NUL byte in its first 8 KB, so it is not delimited text. If it is a spreadsheet or a picture of a table, read_table reads those; there is no text form of a binary file.` };
  }

  let headRows = Number.isInteger(args?.head_rows) ? args.head_rows : DEFAULT_HEAD_ROWS;
  if (headRows < 0) headRows = 0;
  if (headRows > MAX_HEAD_ROWS) headRows = MAX_HEAD_ROWS;

  const sniff = head(r.absolute, stat.size, 64 * 1024);
  let delimiter = typeof args?.delimiter === 'string' && args.delimiter.length > 0 ? args.delimiter : null;
  let delimiterGuessed = false;
  if (delimiter === null) {
    delimiter = guessDelimiter(sniff);
    delimiterGuessed = true;
    if (delimiter === null) {
      return {
        ok: false,
        error: `no delimiter could be detected in ${r.relative} — every candidate (comma, tab, semicolon, pipe) produced one column. If it is not delimited data, read_lines reads it as text; if it uses something else, pass delimiter explicitly.`,
      };
    }
  }

  const hasHeader = args?.header !== false;
  const columns = [];
  const sample = [];
  let headerNames = null;
  let widestRow = 0;
  let raggedRows = 0;
  let dataRows = 0;

  const onRow = (row) => {
    if (row.length === 1 && row[0] === '') return; // a blank line is not a record
    if (hasHeader && headerNames === null) {
      headerNames = row.map((c, i) => (String(c ?? '').trim() || `column_${i + 1}`));
      return;
    }
    dataRows += 1;
    if (row.length > widestRow) widestRow = row.length;
    if (headerNames && row.length !== headerNames.length) raggedRows += 1;
    for (let i = 0; i < row.length && i < MAX_COLUMNS_PROFILED; i++) {
      if (!columns[i]) columns[i] = newColumn(headerNames?.[i] ?? `column_${i + 1}`, i);
      observe(columns[i], row[i]);
    }
    if (sample.length < headRows) sample.push(row.map((c) => clip(String(c ?? ''))));
  };

  const walked = walkRows(r.absolute, stat.size, { delimiter, onRow, maxBytes: MAX_SCAN_BYTES });

  const profiled = columns.filter(Boolean).map((c) => summarise(c, dataRows));
  const totalColumns = headerNames ? headerNames.length : widestRow;

  return {
    ok: true,
    path: r.relative,
    bytes: stat.size,
    delimiter,
    ...(delimiterGuessed ? { delimiterDetected: true } : {}),
    rows: dataRows,
    columnCount: totalColumns,
    columns: profiled,
    ...(totalColumns > MAX_COLUMNS_PROFILED
      ? { columnsNotProfiled: totalColumns - MAX_COLUMNS_PROFILED, columnLimit: MAX_COLUMNS_PROFILED }
      : {}),
    ...(headerNames ? {} : { header: false }),
    ...(raggedRows > 0 ? { raggedRows } : {}),
    ...(sample.length > 0 ? { head: sample } : {}),
    /**
     * ⚠️ REPORTED, NEVER SILENT. A profile drawn from the first 256 MB of a
     * 4 GB file is a SAMPLE, and a row count presented as a total when it is not
     * is the failure mode this package treats as the worst it can ship.
     */
    ...(walked.truncated
      ? {
        sampled: true,
        note: `only the first ${walked.scannedBytes} of ${stat.size} bytes were scanned (the ${MAX_SCAN_BYTES}-byte work limit), so rows and statistics describe that prefix, not the whole file.`,
      }
      : {}),
  };
}

/**
 * ⚠️ THE DESCRIPTION IS THE FEATURE, and this one has a specific job: the model
 * does not reach for this verb, it reaches for `read_file` and is refused. So
 * the first clause names the REFUSAL, which is the state it will be in when it
 * needs this.
 *
 * ⚠️ AND IT MUST DISTINGUISH ITSELF FROM `read_table`, which is in the same
 * shortlist group and whose name is the nearer miss: that one OCRs a picture of
 * a table, this one reads a delimited file off disk.
 */
export function tableProfileToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'profile_table',
        description: [
          'Describe a CSV/TSV data file that is too big to read: row count, every column with its inferred',
          'type, missing count, distinct values and numeric range, plus the first few rows.',
          'Use it INSTEAD of read_file on any data file, and whenever a read was refused for size —',
          'it streams, so there is no size limit, and the answer is the same length for 50 MB as for 50 KB.',
          '(read_table is different: that one reads a PICTURE of a table.)',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative path, e.g. "data/sales.csv".' },
            delimiter: { type: 'string', description: 'Optional. Detected automatically; pass one to override.' },
            header: { type: 'boolean', description: 'Optional. False if the first row is data, not column names.' },
            head_rows: { type: 'number', description: `Optional. Sample rows to return, 0-${MAX_HEAD_ROWS}. Defaults to ${DEFAULT_HEAD_ROWS}.` },
          },
          required: ['path'],
        },
      },
    },
  ];
}
