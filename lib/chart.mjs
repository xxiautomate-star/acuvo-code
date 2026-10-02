/**
 * ── ⭐⭐ chart — A CSV IN, AN INTERACTIVE DASHBOARD OUT, IN ONE CALL ─────────
 *
 * Roman's backlog, verbatim: *"every developer has a CSV and no quick way to
 * look at it."* That is the whole verb. It is not a plotting API and it is not
 * a spreadsheet — it is the ten minutes between "there is a file" and "I can
 * see the shape of it", collapsed into one tool call.
 *
 * ── ⚠️ GENERIC. NO VERTICAL, NO DOMAIN, NO GAME ─────────────────────────────
 *
 * Roman's constraint on this wave: *"these are generic verbs; none may hardcode
 * for games."* This one knows about exactly four things: a delimiter, a column
 * of text, a column of numbers and a column of dates. There is no rule in here
 * that only makes sense for sales data, or telemetry, or a leaderboard, and
 * there must never be one. The nearest thing to a domain assumption is the
 * dd/mm-vs-mm/dd refusal below, and it refuses rather than guesses precisely
 * BECAUSE the answer depends on whose data it is.
 *
 * ── ⭐⭐ WHY THERE IS NO CHARTING LIBRARY, AND WHY THAT IS THE ASSEMBLED
 *    ANSWER RATHER THAN THE LAZY ONE ─────────────────────────────────────────
 *
 * The standing principle is ASSEMBLE, NEVER AUTHOR (`feedback_assemble_never_
 * build_from_scratch`), so the first move was to look for a cleared library
 * rather than to write a renderer. I read `INTEGRATIONS.md` — 23 licence-cleared
 * integrations, every one with its LICENSE file actually read — and there is no
 * charting entry in it. The two places charting appears at all are both
 * WARNINGS about this exact file's problem:
 *
 *   · the html-slides templates *"pull Mermaid and Chart.js, and our published-app
 *     CSP allows only Google Fonts with no external CSS/JS … or the decks render
 *     blank in exactly the place customers see them"*; and
 *   · `mermaid-to-excalidraw` is cleared but is a BROWSER-SIDE npm dependency
 *     tree, and this package declares `"dependencies": {}` with the description
 *     *"Zero dependencies, by design"*.
 *
 * ⭐ So the honest reading of the assembly doctrine here is: **assembling a
 * library I would then have to bundle, self-host and CSP-exempt costs more than
 * the arithmetic it saves.** An axis is `niceTicks`; a bar is a `<rect>`; a line
 * is a `<polyline>`. That is roughly 200 lines of maths, it adds nothing to the
 * supply chain, and the output opens from `file://` on a laptop with no network
 * — which a CDN-loading page does not.
 *
 * ⚠️ WHAT *IS* ASSEMBLED: the document shell, the escaping and the theme live
 * in `html-doc.mjs` and are shared with `syndicate`, because two copies of an
 * HTML escaper is precisely the failure this package has shipped twice
 * (`feedback_a_fix_that_cannot_be_imported`).
 *
 * ── ⚠️⚠️ THE PARSER IS THE PRODUCT. A NAIVE `split(',')` IS THE BUG ──────────
 *
 * Nothing here is exotic and all of it is common:
 *   · `"Smith, John"` — a comma inside quotes, which `split(',')` shears in two;
 *   · `"she said ""hi"""` — the doubled-quote escape;
 *   · a newline INSIDE a quoted field, which a line-by-line reader cannot see;
 *   · a UTF-8 BOM, which Excel writes by default and which turns the first
 *     column's name into `﻿id` — so `x: "id"` silently matches nothing;
 *   · CRLF, and lone CR from very old exports;
 *   · semicolons, because that is what Excel writes in most of Europe;
 *   · ragged rows, because real exports have them.
 *
 * Every one is handled by the state machine below and every one has a test.
 *
 * ── ⚠️ IT NEVER GUESSES A DATE FORMAT IT CANNOT KNOW ────────────────────────
 *
 * `03/04/2026` is the 3rd of April to most of the world and the 4th of March in
 * the United States, and NOTHING IN THE FILE SAYS WHICH. Guessing produces a
 * chart whose x-axis is wrong in a way no reader can detect. So ambiguous
 * day/month formats are treated as TEXT and the column is named in `warnings`
 * with the sentence that says why. ISO-8601 (`2026-04-03`) is unambiguous and is
 * parsed. This is the one place the verb chooses to be less useful on purpose.
 *
 * ── ⚠️ IT SPENDS NOTHING, STARTS NOTHING, AND REACHES NOTHING ───────────────
 *
 * No model call, no GPU, no network, no subprocess. It reads one file through
 * the workspace executor (so the root boundary, the encoding guard and the
 * binary refusal are the ones that already exist) and writes one file back
 * through the same executor (so `--dry-run`, the checkpoint journal, the write
 * lease and the credential-path leash all apply unchanged). That is what makes
 * its whole test suite free to run.
 */

/**
 * ⚠️ `jsonForScript` IS DELIBERATELY NOT IMPORTED HERE. This renderer emits the
 * marks as SVG at build time and carries every label in a `data-tip` ATTRIBUTE
 * (escaped by `escapeAttr`), so no CSV cell ever reaches the inside of a
 * `<script>` element. That is the reason a cell containing the literal text
 * `</script>` cannot break this page — not vigilance, structure. `syndicate`
 * does put data in a script and does import it.
 */
import { escapeHtml, escapeAttr, htmlDocument, seriesColour } from './html-doc.mjs';

export const CHART_TOOL_NAMES = Object.freeze(['chart']);

/** Delimiters worth sniffing, in the order preference breaks a tie. */
export const CANDIDATE_DELIMITERS = Object.freeze([',', ';', '\t', '|']);

/** A column with more distinct values than this is not a category anybody can read. */
export const MAX_CATEGORIES = 24;
/** Marks past this many stop being information and start being file size. */
export const MAX_POINTS = 2_000;
/** Rows rendered into the data table by default. */
export const DEFAULT_TABLE_ROWS = 200;
/** Panels past this many make a page nobody scrolls to the end of. */
export const MAX_PANELS = 6;
/**
 * ⚠️ UNDER `MAX_WRITE_BYTES` (400,000) ON PURPOSE, WITH ROOM TO SPARE. The
 * executor refuses an over-size write, and discovering that AFTER building the
 * whole document is a refusal the caller cannot act on. So the builder sheds
 * detail — table rows first, then points — until it fits, and SAYS SO.
 */
export const MAX_HTML_BYTES = 340_000;

/** Fraction of non-empty values that must parse for a column to take a type. */
const TYPE_THRESHOLD = 0.95;

const BOOL_TRUE = new Set(['true', 'yes', 'y', 't']);
const BOOL_FALSE = new Set(['false', 'no', 'n', 'f']);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. PARSING
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⭐ THE BOM IS STRIPPED HERE AND NOWHERE ELSE. `workspace.mjs`'s `readFile`
 * deliberately KEEPS it (`ignoreBOM: true`), and its comment explains why: a
 * read-then-write round trip that silently deletes three bytes corrupts files.
 * That is right for an editor and wrong for a parser — a header called
 * `﻿date` matches no `x` the caller could ever type. So the file keeps its
 * BOM on disk and this function ignores it.
 *
 * @param {string} text
 */
export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Which delimiter this file uses.
 *
 * ⚠️ IT PARSES RATHER THAN COUNTING. Counting commas in the first line reports
 * `,` for a semicolon-delimited file whose first row contains `"Smith, John"`.
 * Parsing the first few records with each candidate and preferring the one that
 * yields a CONSISTENT field count above one is the version that cannot be fooled
 * by punctuation inside quotes.
 *
 * @param {string} text
 * @returns {{ delimiter: string, confident: boolean }}
 */
export function sniffDelimiter(text) {
  let best = { delimiter: ',', fields: 1, consistent: false };
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const probe = parseRecords(text, delimiter, 6);
    if (probe.length === 0) continue;
    const widths = probe.map((r) => r.length);
    const fields = widths[0];
    if (fields < 2) continue;
    const consistent = widths.every((w) => w === fields);
    const better = consistent && !best.consistent ? true
      : consistent === best.consistent && fields > best.fields;
    if (better) best = { delimiter, fields, consistent };
  }
  return { delimiter: best.delimiter, confident: best.fields > 1 };
}

/**
 * ⭐⭐ THE STATE MACHINE. RFC 4180 plus the three things real files do that
 * RFC 4180 does not mention: lone CR line endings, a stray quote inside an
 * unquoted field, and a file that does not end in a newline.
 *
 * @param {string} text
 * @param {string} delimiter
 * @param {number} [limit] stop after this many records (0 = no limit)
 * @returns {string[][]}
 */
export function parseRecords(text, delimiter, limit = 0) {
  const out = [];
  let field = '';
  let record = [];
  let quoted = false;
  let started = false; // has anything at all been seen for the current record?

  const endField = () => { record.push(field); field = ''; started = true; };
  const endRecord = () => {
    endField();
    out.push(record);
    record = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // the doubled-quote escape
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; started = true; continue; }
    if (ch === delimiter) { endField(); continue; }
    if (ch === '\r') {
      // \r\n and a lone \r both end the record; the \n is consumed with it.
      if (text[i + 1] === '\n') i++;
      endRecord();
      if (limit && out.length >= limit) return out;
      continue;
    }
    if (ch === '\n') {
      endRecord();
      if (limit && out.length >= limit) return out;
      continue;
    }
    field += ch;
    started = true;
  }
  // ⚠️ THE LAST RECORD, WHEN THE FILE DOES NOT END IN A NEWLINE. Without this
  // the final row of a perfectly ordinary export is silently dropped — a bug
  // that shows up as an off-by-one nobody can find.
  if (started || field !== '' || record.length) endRecord();
  return out;
}

/**
 * Parse a whole CSV into a header and rows.
 *
 * @param {string} raw
 * @param {{ delimiter?: string|null, header?: boolean }} [opts]
 * @returns {{ ok: true, delimiter: string, header: string[], rows: string[][], warnings: string[] }
 *          | { ok: false, error: string }}
 */
export function parseCsv(raw, { delimiter = null, header = true } = {}) {
  if (typeof raw !== 'string') return { ok: false, error: 'the CSV content must be text' };
  const text = stripBom(raw);
  if (!text.trim()) return { ok: false, error: 'the file is empty — there is nothing to chart' };

  const warnings = [];
  let sep = delimiter;
  if (!sep) {
    const sniffed = sniffDelimiter(text);
    sep = sniffed.delimiter;
    if (!sniffed.confident) {
      warnings.push('every candidate delimiter produced a single column, so this may not be a delimited file; '
        + 'pass `delimiter` if it uses something unusual');
    }
  }
  if (sep === '\\t') sep = '\t'; // a caller typing the escape rather than the character

  const records = parseRecords(text, sep).filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (records.length === 0) return { ok: false, error: 'no rows were found in the file' };

  let head;
  let rows;
  if (header) {
    head = records[0].map((h, i) => (h.trim() === '' ? `column_${i + 1}` : h.trim()));
    rows = records.slice(1);
    /**
     * ⚠️ A HEADER THAT IS ENTIRELY NUMBERS IS NOT A HEADER. Plenty of exports
     * have no header row at all, and consuming the first data row as one both
     * loses a data point and labels every column with a number.
     */
    if (head.length > 1 && head.every((h) => parseNumber(h) !== null)) {
      warnings.push('the first row is entirely numeric, so it was treated as DATA rather than as a header; '
        + 'columns are named column_1, column_2, … — pass header: false to make that explicit, or add a header row');
      rows = records;
      head = records[0].map((_, i) => `column_${i + 1}`);
    }
  } else {
    head = records[0].map((_, i) => `column_${i + 1}`);
    rows = records;
  }
  if (rows.length === 0) return { ok: false, error: 'the file has a header row and no data rows' };

  // Duplicate header names make `x`/`y` ambiguous, so they are made unique and said out loud.
  const seen = new Map();
  head = head.map((name) => {
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n === 0) return name;
    warnings.push(`two columns are both called "${name}"; the later one was renamed "${name}_${n + 1}"`);
    return `${name}_${n + 1}`;
  });

  // Ragged rows: padded, never dropped. Dropping them changes the totals.
  let ragged = 0;
  rows = rows.map((r) => {
    if (r.length === head.length) return r;
    ragged++;
    if (r.length < head.length) return [...r, ...Array(head.length - r.length).fill('')];
    return r.slice(0, head.length);
  });
  if (ragged) {
    warnings.push(`${ragged} row${ragged === 1 ? '' : 's'} had a different number of fields to the header; `
      + 'short rows were padded with blanks and long ones truncated');
  }

  return { ok: true, delimiter: sep, header: head, rows, warnings };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. TYPES
 * ──────────────────────────────────────────────────────────────────────────── */

const PLAIN_NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * A number, or null.
 *
 * ⭐ Tolerant of the four things spreadsheets add and humans read straight past:
 * a currency symbol, thousands separators, a trailing `%`, and parentheses for
 * negatives. `(1,234.50)` is −1234.5 and `$1 200` is 1200. Everything else is
 * null — this never coerces `"12 apples"` to 12, because a column that half
 * parses is a column whose chart is half wrong.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw ?? '').trim();
  if (s === '') return null;
  let sign = 1;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) { sign = -1; s = paren[1].trim(); }
  s = s.replace(/^[-+]?\s*(?:[A-Za-z]{0,3})?[$£€¥₹]\s*/, (m) => (m.trim().startsWith('-') ? '-' : ''));
  let percent = false;
  if (s.endsWith('%')) { percent = true; s = s.slice(0, -1).trim(); }
  /**
   * Thousands separators BETWEEN digits: comma, plain space, no-break space,
   * narrow no-break space (what several European locales actually emit) and
   * underscore.
   * ⚠️ Written as \u escapes rather than literal characters — three of the
   * five are invisible in an editor, and this repo has already lost characters
   * exactly that way (`feedback_escaping_through_layers_eats_characters`).
   */
  s = s.replace(/(?<=\d)[,\u0020\u00a0\u202f_](?=\d{3}\b)/g, '');
  if (!PLAIN_NUMBER.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return sign * (percent ? n : n);
}

const ISO_DATE = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASH_ISO = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
/** The one this refuses. Kept as a pattern so the WARNING can be specific. */
export const AMBIGUOUS_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;

/**
 * An unambiguous date, as epoch milliseconds, or null.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseDate(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  const iso = ISO_DATE.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec, zone] = iso;
    const month = Number(mo);
    const day = d === undefined ? 1 : Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const ms = Date.UTC(Number(y), month - 1, day, Number(h ?? 0), Number(mi ?? 0), Number(sec ?? 0));
    if (!Number.isFinite(ms)) return null;
    if (zone && zone !== 'Z') {
      const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
      if (m) {
        const offset = (Number(m[2]) * 60 + Number(m[3])) * 60_000 * (m[1] === '-' ? -1 : 1);
        return ms - offset;
      }
    }
    return ms;
  }
  const slash = SLASH_ISO.exec(s);
  if (slash) {
    const month = Number(slash[2]);
    const day = Number(slash[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return Date.UTC(Number(slash[1]), month - 1, day);
  }
  return null;
}

/** @param {unknown} raw */
export function parseBool(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return null;
  if (BOOL_TRUE.has(s)) return true;
  if (BOOL_FALSE.has(s)) return false;
  return null;
}

/**
 * Describe every column: its type, how much of it is missing, and the summary
 * statistics a stat tile needs.
 *
 * @param {string[]} header
 * @param {string[][]} rows
 * @returns {{ columns: Array<Record<string, any>>, warnings: string[] }}
 */
export function inferColumns(header, rows) {
  const warnings = [];
  const columns = header.map((name, index) => {
    const raw = rows.map((r) => (r[index] ?? '').trim());
    const present = raw.filter((v) => v !== '');
    const nulls = raw.length - present.length;

    const nums = present.map(parseNumber);
    const numOk = nums.filter((v) => v !== null).length;
    const dates = present.map(parseDate);
    const dateOk = dates.filter((v) => v !== null).length;
    const bools = present.map(parseBool);
    const boolOk = bools.filter((v) => v !== null).length;

    const denom = present.length || 1;
    /** @type {'number'|'date'|'boolean'|'text'|'empty'} */
    let type = 'text';
    if (present.length === 0) type = 'empty';
    else if (boolOk / denom >= TYPE_THRESHOLD) type = 'boolean';
    else if (dateOk / denom >= TYPE_THRESHOLD) type = 'date';
    else if (numOk / denom >= TYPE_THRESHOLD) type = 'number';

    if (type === 'text' && present.length && present.filter((v) => AMBIGUOUS_DATE.test(v)).length / denom >= TYPE_THRESHOLD) {
      warnings.push(`"${name}" looks like dates written day/month/year or month/day/year, and nothing in the file says which — `
        + 'it was left as text rather than plotted on a wrong time axis. Rewrite it as YYYY-MM-DD to chart it.');
    }

    const col = {
      name, index, type, rows: raw.length, nulls,
      values: type === 'number' ? nums : type === 'date' ? dates : raw.map((v) => (v === '' ? null : v)),
    };

    if (type === 'number' || type === 'date') {
      const clean = /** @type {number[]} */ (col.values.filter((v) => v !== null));
      if (clean.length) {
        const sorted = [...clean].sort((a, b) => a - b);
        col.min = sorted[0];
        col.max = sorted[sorted.length - 1];
        col.sum = clean.reduce((a, b) => a + b, 0);
        col.mean = col.sum / clean.length;
        const mid = sorted.length >> 1;
        col.median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      }
    } else {
      const distinct = new Set(present);
      col.distinct = distinct.size;
      col.categories = distinct.size <= MAX_CATEGORIES ? [...distinct] : null;
    }
    return col;
  });
  return { columns, warnings };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. WHICH CHART
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ THE RATIO ABOVE WHICH TWO SERIES MUST NOT SHARE AN AXIS. Plotting revenue
 * in millions beside a conversion rate of 0.03 draws a flat line at zero and
 * calls it a chart. Fifty is generous and deliberately so — the cost of
 * splitting is one more panel, and the cost of not splitting is a lie.
 */
export const MAX_SERIES_RATIO = 50;

/** @param {Array<Record<string, any>>} columns */
const numeric = (columns) => columns.filter((c) => c.type === 'number');
/** @param {Array<Record<string, any>>} columns */
const temporal = (columns) => columns.filter((c) => c.type === 'date');
/**
 * ⚠️⚠️ A LOW DISTINCT COUNT IS NOT ENOUGH. MEASURED on this file's own fixture:
 * a free-text `notes` column with 3 filled cells and 3 distinct values passed a
 * `distinct <= 24` test and earned a whole "Rows by notes" panel — three bars of
 * height one, made of sentences. Useless, and it crowded out a real chart under
 * the `MAX_PANELS` cap.
 *
 * ⭐ THE MISSING CONDITION IS THAT THE VALUES *REPEAT*. A category is a thing
 * rows SHARE; if every filled cell is unique the column is an identifier or a
 * comment, not a grouping. Two conditions, and both are needed:
 *
 *   · `distinct < present` — at least one value occurs twice. This is what
 *     rejects the free-text column, and it is deliberately the weakest possible
 *     form, because a legitimate 5-row category can have 4 distinct values.
 *   · `distinct <= present * 0.8` — the same rule with teeth at the size where
 *     `MAX_CATEGORIES` stops helping (25 rows, 24 distinct passes both the
 *     cardinality cap and "one repeat" while being obviously an id column).
 *
 * @param {Array<Record<string, any>>} columns
 */
export const categorical = (columns) => columns.filter((c) => {
  if (c.type !== 'text' && c.type !== 'boolean') return false;
  if (!c.categories || c.categories.length < 2) return false;
  const present = c.rows - c.nulls;
  const distinct = c.categories.length;
  return distinct < present && distinct <= Math.max(2, present * 0.8);
});

/**
 * Decide what to draw.
 *
 * ⭐ EXPLICIT BEATS INFERRED, ALWAYS. When the caller names `x` and `y` this
 * function does what it is told and reports it; the inference below only runs
 * when nobody said.
 *
 * @param {Array<Record<string,any>>} columns
 * @param {{ x?: string|null, y?: string|string[]|null, type?: string|null }} [opts]
 * @returns {{ panels: Array<Record<string,any>>, warnings: string[] }}
 */
export function planPanels(columns, { x = null, y = null, type = null } = {}) {
  const warnings = [];
  const byName = new Map(columns.map((c) => [c.name, c]));
  const panels = [];

  const wantY = y === null || y === undefined ? [] : (Array.isArray(y) ? y : [y]);
  if (x || wantY.length) {
    const xc = x ? byName.get(x) : null;
    if (x && !xc) return { panels: [], warnings: [`there is no column called "${x}". The columns are: ${columns.map((c) => c.name).join(', ')}`] };
    const ys = wantY.map((n) => byName.get(n)).filter(Boolean);
    const missing = wantY.filter((n) => !byName.has(n));
    if (missing.length) {
      return { panels: [], warnings: [`there is no column called "${missing[0]}". The columns are: ${columns.map((c) => c.name).join(', ')}`] };
    }
    const kind = type && type !== 'auto' ? type
      : xc && xc.type === 'date' ? 'line'
        : xc && xc.type === 'number' ? 'scatter'
          : ys.length ? 'bar' : 'count';
    if (kind === 'histogram' && ys.length === 0 && xc && xc.type === 'number') {
      panels.push({ kind: 'histogram', x: xc, series: [], title: `Distribution of ${xc.name}` });
    } else if (kind === 'count' || ys.length === 0) {
      if (!xc) return { panels: [], warnings: ['`y` was given without `x` and no chart can be inferred from that alone — name `x` too.'] };
      panels.push(xc.type === 'number'
        ? { kind: 'histogram', x: xc, series: [], title: `Distribution of ${xc.name}` }
        : { kind: 'count', x: xc, series: [], title: `Rows by ${xc.name}` });
    } else {
      panels.push({ kind, x: xc, series: ys, title: `${ys.map((c) => c.name).join(', ')} by ${xc ? xc.name : 'row'}` });
    }
    return { panels, warnings };
  }

  const nums = numeric(columns);
  const dates = temporal(columns);
  const cats = categorical(columns);

  if (dates.length && nums.length) {
    const xc = dates[0];
    // Series that share an order of magnitude share a panel; the rest get their own.
    const groups = groupBySpan(nums.slice(0, 6));
    for (const g of groups) {
      panels.push({
        kind: 'line', x: xc, series: g,
        title: g.length === 1 ? `${g[0].name} over ${xc.name}` : `${g.map((c) => c.name).join(' · ')} over ${xc.name}`,
      });
    }
    if (nums.length > 6) warnings.push(`${nums.length} numeric columns were found; the first 6 were charted`);
  } else if (cats.length && nums.length) {
    const xc = cats[0];
    for (const n of nums.slice(0, 3)) {
      panels.push({ kind: 'bar', x: xc, series: [n], aggregate: 'sum', title: `${n.name} by ${xc.name}` });
    }
  } else if (nums.length >= 2) {
    panels.push({ kind: 'scatter', x: nums[0], series: [nums[1]], title: `${nums[1].name} against ${nums[0].name}` });
  } else if (nums.length === 1) {
    panels.push({ kind: 'histogram', x: nums[0], series: [], title: `Distribution of ${nums[0].name}` });
  }

  for (const c of cats.slice(0, 2)) {
    if (panels.length >= MAX_PANELS) break;
    if (panels.some((p) => p.x === c)) continue;
    panels.push({ kind: 'count', x: c, series: [], title: `Rows by ${c.name}` });
  }

  if (panels.length === 0) {
    warnings.push('no column could be charted — every column is text with too many distinct values to group by. '
      + 'Name `x` and `y` explicitly, or check the delimiter was read correctly.');
  }
  return { panels: panels.slice(0, MAX_PANELS), warnings };
}

/**
 * Split numeric columns into groups that can honestly share a y-axis.
 * @param {Array<Record<string,any>>} cols
 */
export function groupBySpan(cols) {
  /** @type {Array<Array<Record<string,any>>>} */
  const groups = [];
  for (const c of cols) {
    const scale = Math.max(Math.abs(c.max ?? 0), Math.abs(c.min ?? 0)) || 1;
    const home = groups.find((g) => {
      const gs = Math.max(...g.map((m) => Math.max(Math.abs(m.max ?? 0), Math.abs(m.min ?? 0)) || 1));
      const ratio = Math.max(gs, scale) / Math.min(gs, scale);
      return ratio <= MAX_SERIES_RATIO;
    });
    if (home) home.push(c); else groups.push([c]);
  }
  return groups;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. RENDERING
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ NOT `Intl.NumberFormat`. ICU data differs between Node builds and between
 * browsers, so the same CSV would produce byte-different files on two machines —
 * which makes "did the output change?" unanswerable in a test and in review.
 *
 * @param {number|null|undefined} n
 * @param {number} [places]
 */
export function fmtNum(n, places = 3) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-4)) return n.toExponential(2);
  let s = abs >= 1000 ? String(Math.round(n)) : String(Number(n.toFixed(places)));
  // group thousands in the integer part
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [int, frac] = s.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/**
 * A date label whose precision follows the span. A five-year range labelled to
 * the second is unreadable; a five-minute range labelled to the day is useless.
 *
 * @param {number} ms @param {number} spanMs
 */
export function fmtDate(ms, spanMs = 0) {
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, '0');
  const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  if (spanMs && spanMs < 2 * 86_400_000) return `${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  if (spanMs && spanMs > 5 * 365 * 86_400_000) return String(d.getUTCFullYear());
  return day;
}

/**
 * Axis ticks a human would have chosen: 1, 2, 2.5 or 5 times a power of ten.
 * @param {number} min @param {number} max @param {number} [count]
 */
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= pad; max += pad;
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2.5 ? 5 : norm >= 2 ? 2.5 : norm >= 1 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  // ⚠️ Accumulating `t += step` drifts on floats; multiplying from an integer index does not.
  for (let i = 0; lo + i * step <= hi + step * 1e-9; i++) ticks.push(Number((lo + i * step).toPrecision(12)));
  return { lo, hi, ticks };
}

/**
 * ── ⚠️⚠️ A TIME AXIS MUST NOT BE "NICED". FOUND BY LOOKING AT IT ────────────
 *
 * The first version ran `niceTicks` on BOTH axes, and the rendered page showed
 * what no unit test could: 90 days of data from 2026-05-01 sat on an axis that
 * began at **2026-04-12** and ran to 2026-08-06. `niceTicks` rounds outward to a
 * round multiple of its step, and a round number of MILLISECONDS SINCE 1970 is
 * not a round date — 1e12 ms lands mid-April for no reason a reader can see. The
 * chart was correct and it looked wrong, which for a chart is the same thing.
 *
 * ⭐ So a temporal axis uses the DATA'S OWN range and spaces its ticks evenly
 * inside it. The labels are then real dates from the data's span rather than
 * artefacts of epoch arithmetic. (`feedback_one_screenshot_beat_3621_tests` —
 * this is that lesson again, on a smaller scale: 46 green tests said the axis
 * was fine, and one look said otherwise.)
 *
 * @param {number} min @param {number} max @param {number} [count]
 */
export function spanTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (min === max) return { lo: min - 1, hi: max + 1, ticks: [min] };
  const ticks = [];
  for (let i = 0; i <= count; i++) ticks.push(min + ((max - min) * i) / count);
  return { lo: min, hi: max, ticks };
}

/** Evenly sample without ever dropping the first or last point. */
export function downsample(points, limit = MAX_POINTS) {
  if (points.length <= limit) return { points, sampled: false };
  const step = points.length / limit;
  const out = [];
  for (let i = 0; i < limit; i++) out.push(points[Math.min(points.length - 1, Math.floor(i * step))]);
  out[out.length - 1] = points[points.length - 1];
  return { points: out, sampled: true };
}

const W = 900;
const H = 320;
const PAD = { top: 14, right: 18, bottom: 40, left: 64 };

/** A `<title>`-free tooltip carrier: the JS reads `data-tip`. */
const tip = (text) => ` data-tip="${escapeAttr(text)}"`;

/**
 * Render one panel to SVG.
 *
 * @param {Record<string,any>} panel
 * @param {{ maxPoints?: number }} [opts]
 * @returns {{ svg: string, legend: Array<{name:string,colour:string}>, note: string, points: number }}
 */
export function renderPanel(panel, { maxPoints = MAX_POINTS } = {}) {
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const open = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeAttr(panel.title)}" preserveAspectRatio="xMidYMid meet">`;
  const notes = [];

  /** Shared y-axis furniture. */
  const yAxis = (lo, hi, ticks) => ticks.map((t) => {
    const yy = PAD.top + ih - ((t - lo) / (hi - lo || 1)) * ih;
    return `<g class="grid"><line x1="${PAD.left}" y1="${yy.toFixed(1)}" x2="${(PAD.left + iw).toFixed(1)}" y2="${yy.toFixed(1)}"/></g>`
      + `<text x="${PAD.left - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end">${escapeHtml(fmtNum(t))}</text>`;
  }).join('');

  if (panel.kind === 'bar' || panel.kind === 'count') {
    const cats = aggregate(panel);
    const values = cats.map((c) => c.value);
    const { lo, hi, ticks } = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
    const bw = iw / Math.max(1, cats.length);
    const bars = cats.map((c, i) => {
      const y0 = PAD.top + ih - ((0 - lo) / (hi - lo || 1)) * ih;
      const y1 = PAD.top + ih - ((c.value - lo) / (hi - lo || 1)) * ih;
      const top = Math.min(y0, y1);
      const height = Math.max(1, Math.abs(y1 - y0));
      const x0 = PAD.left + i * bw + bw * 0.14;
      const width = bw * 0.72;
      const label = `${c.label}: ${fmtNum(c.value)}`;
      return `<rect class="mark" x="${x0.toFixed(1)}" y="${top.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" rx="3" style="fill:${seriesColour(0)}"${tip(label)}/>`;
    }).join('');
    const labels = cats.map((c, i) => {
      const cx = PAD.left + i * bw + bw / 2;
      const show = cats.length <= 14 ? c.label : (i % Math.ceil(cats.length / 14) === 0 ? c.label : '');
      if (!show) return '';
      const clipped = show.length > 14 ? `${show.slice(0, 13)}…` : show;
      return `<text x="${cx.toFixed(1)}" y="${(PAD.top + ih + 16).toFixed(1)}" text-anchor="middle">${escapeHtml(clipped)}</text>`;
    }).join('');
    if (panel.truncatedCategories) notes.push(`showing the top ${cats.length} of ${panel.truncatedCategories} categories by value`);
    return {
      svg: `${open}${yAxis(lo, hi, ticks)}${bars}${labels}<g class="axis"><line x1="${PAD.left}" y1="${PAD.top + ih}" x2="${PAD.left + iw}" y2="${PAD.top + ih}"/></g></svg>`,
      legend: [], note: notes.join('; '), points: cats.length,
    };
  }

  if (panel.kind === 'histogram') {
    const bins = histogram(panel.x);
    const values = bins.map((b) => b.count);
    const { lo, hi, ticks } = niceTicks(0, Math.max(1, ...values));
    const bw = iw / Math.max(1, bins.length);
    const bars = bins.map((b, i) => {
      const height = ((b.count - 0) / (hi - lo || 1)) * ih;
      const x0 = PAD.left + i * bw + 1;
      return `<rect class="mark" x="${x0.toFixed(1)}" y="${(PAD.top + ih - height).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${Math.max(0, height).toFixed(1)}" style="fill:${seriesColour(0)}"${tip(`${fmtNum(b.from)} – ${fmtNum(b.to)}: ${b.count} row${b.count === 1 ? '' : 's'}`)}/>`;
    }).join('');
    const edge = (i) => PAD.left + i * bw;
    const labels = [0, Math.floor(bins.length / 2), bins.length].map((i) => {
      const v = i >= bins.length ? bins[bins.length - 1]?.to : bins[i]?.from;
      if (v === undefined) return '';
      return `<text x="${edge(i).toFixed(1)}" y="${(PAD.top + ih + 16).toFixed(1)}" text-anchor="middle">${escapeHtml(fmtNum(v))}</text>`;
    }).join('');
    return {
      svg: `${open}${yAxis(lo, hi, ticks)}${bars}${labels}<g class="axis"><line x1="${PAD.left}" y1="${PAD.top + ih}" x2="${PAD.left + iw}" y2="${PAD.top + ih}"/></g></svg>`,
      legend: [], note: `${bins.length} bins`, points: bins.length,
    };
  }

  // line and scatter share their x handling: a numeric or temporal axis.
  const xIsDate = panel.x.type === 'date';
  const pairsPerSeries = panel.series.map((s) => {
    const pts = [];
    for (let r = 0; r < panel.x.values.length; r++) {
      const xv = panel.x.values[r];
      const yv = s.values[r];
      if (xv === null || yv === null || typeof xv !== 'number' || typeof yv !== 'number') continue;
      pts.push([xv, yv]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    return downsample(pts, maxPoints);
  });
  const allX = pairsPerSeries.flatMap((p) => p.points.map((q) => q[0]));
  const allY = pairsPerSeries.flatMap((p) => p.points.map((q) => q[1]));
  if (allX.length === 0) {
    return { svg: `${open}<text x="${W / 2}" y="${H / 2}" text-anchor="middle">no rows have a value in both columns</text></svg>`, legend: [], note: 'nothing to plot', points: 0 };
  }
  // ⚠️ Dates use their own span (see `spanTicks`); numbers still get round ticks.
  const xs = xIsDate
    ? spanTicks(Math.min(...allX), Math.max(...allX), 5)
    : niceTicks(Math.min(...allX), Math.max(...allX), 6);
  const ys = niceTicks(Math.min(...allY), Math.max(...allY));
  const px = (v) => PAD.left + ((v - xs.lo) / (xs.hi - xs.lo || 1)) * iw;
  const py = (v) => PAD.top + ih - ((v - ys.lo) / (ys.hi - ys.lo || 1)) * ih;
  const span = Math.max(...allX) - Math.min(...allX);

  /**
   * ⚠️⚠️ THE ANCHOR IS NOT ALWAYS "middle", AND THE FIRST VERSION SAID IT WAS.
   * Rendered and looked at: the final label read **"2026-08-0"** — a centred
   * label on the last tick puts half its width past the right edge of the
   * viewBox, and SVG does not wrap, ellipsize or warn. It clips, silently, at
   * the one end of the axis a reader looks at to find "how recent is this".
   * ⭐ End-anchoring the last tick and start-anchoring the first is the whole
   * fix, and it costs nothing.
   */
  const xLabels = xs.ticks.map((t, i) => {
    const xx = px(t);
    if (xx < PAD.left - 1 || xx > PAD.left + iw + 1) return '';
    const anchor = i === 0 ? 'start' : i === xs.ticks.length - 1 ? 'end' : 'middle';
    return `<text x="${xx.toFixed(1)}" y="${(PAD.top + ih + 16).toFixed(1)}" text-anchor="${anchor}">${escapeHtml(xIsDate ? fmtDate(t, span) : fmtNum(t))}</text>`;
  }).join('');

  const legend = [];
  const body = pairsPerSeries.map((p, i) => {
    const colour = seriesColour(i);
    legend.push({ name: panel.series[i].name, colour });
    if (p.sampled) notes.push(`${panel.series[i].name} was sampled to ${p.points.length} points`);
    const label = (q) => `${xIsDate ? fmtDate(q[0], span) : `${panel.x.name} ${fmtNum(q[0])}`} · ${panel.series[i].name} ${fmtNum(q[1])}`;
    if (panel.kind === 'scatter') {
      return `<g data-series="${i}">${p.points.map((q) => `<circle class="mark" cx="${px(q[0]).toFixed(1)}" cy="${py(q[1]).toFixed(1)}" r="3.2" style="fill:${colour}" fill-opacity=".72"${tip(label(q))}/>`).join('')}</g>`;
    }
    const d = p.points.map((q) => `${px(q[0]).toFixed(1)},${py(q[1]).toFixed(1)}`).join(' ');
    const dots = p.points.length <= 160
      ? p.points.map((q) => `<circle class="mark" cx="${px(q[0]).toFixed(1)}" cy="${py(q[1]).toFixed(1)}" r="2.6" style="fill:${colour}"${tip(label(q))}/>`).join('')
      : '';
    return `<g data-series="${i}"><polyline points="${d}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" style="stroke:${colour}"/>${dots}</g>`;
  }).join('');

  return {
    svg: `${open}${yAxis(ys.lo, ys.hi, ys.ticks)}${xLabels}${body}`
      + `<g class="axis"><line x1="${PAD.left}" y1="${PAD.top + ih}" x2="${PAD.left + iw}" y2="${PAD.top + ih}"/>`
      + `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + ih}"/></g></svg>`,
    legend, note: notes.join('; '), points: allX.length,
  };
}

/** Sum (or count) a numeric column by a categorical one. */
export function aggregate(panel) {
  const x = panel.x;
  const s = panel.series[0] ?? null;
  const acc = new Map();
  for (let r = 0; r < x.values.length; r++) {
    const key = x.values[r];
    if (key === null) continue;
    const label = String(key);
    const v = s ? s.values[r] : 1;
    if (s && (v === null || typeof v !== 'number')) continue;
    acc.set(label, (acc.get(label) ?? 0) + (s ? /** @type {number} */ (v) : 1));
  }
  const all = [...acc.entries()].map(([label, value]) => ({ label, value }));
  all.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  if (all.length > MAX_CATEGORIES) {
    panel.truncatedCategories = all.length;
    return all.slice(0, MAX_CATEGORIES);
  }
  return all;
}

/** Freedman-ish binning, bounded so a pathological column cannot produce 10,000 bars. */
export function histogram(col, maxBins = 30) {
  const vals = /** @type {number[]} */ (col.values.filter((v) => v !== null && Number.isFinite(v)));
  if (vals.length === 0) return [];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const bins = Math.max(1, Math.min(maxBins, Math.ceil(Math.sqrt(vals.length))));
  const width = (max - min) / bins || 1;
  const out = Array.from({ length: bins }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width, count: 0 }));
  for (const v of vals) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((v - min) / width)));
    out[i].count++;
  }
  return out;
}

/** The inline behaviour: tooltips, series toggling, column sorting. Small on purpose. */
const CHART_JS = `
(function(){
  var tipEl=document.getElementById('tip');
  document.addEventListener('mouseover',function(e){
    var t=e.target.closest?e.target.closest('[data-tip]'):null;
    if(!t){return;}
    tipEl.textContent=t.getAttribute('data-tip');
    tipEl.style.opacity='1';
  });
  document.addEventListener('mousemove',function(e){
    if(tipEl.style.opacity!=='1'){return;}
    var x=e.clientX+14, y=e.clientY+16;
    var r=tipEl.getBoundingClientRect();
    if(x+r.width>window.innerWidth-8){x=e.clientX-r.width-14;}
    if(y+r.height>window.innerHeight-8){y=e.clientY-r.height-14;}
    tipEl.style.left=x+'px'; tipEl.style.top=y+'px';
  });
  document.addEventListener('mouseout',function(e){
    if(e.target.closest && e.target.closest('[data-tip]')){tipEl.style.opacity='0';}
  });
  Array.prototype.forEach.call(document.querySelectorAll('.legend button'),function(b){
    b.addEventListener('click',function(){
      var on=b.getAttribute('aria-pressed')!=='false';
      b.setAttribute('aria-pressed', on?'false':'true');
      var g=document.querySelector('#'+b.getAttribute('data-plot')+' [data-series="'+b.getAttribute('data-series')+'"]');
      if(g){g.style.display=on?'none':'';}
    });
  });
  var table=document.getElementById('data');
  if(table){
    var dir={};
    Array.prototype.forEach.call(table.querySelectorAll('th'),function(th,i){
      th.addEventListener('click',function(){
        var body=table.tBodies[0];
        var rows=Array.prototype.slice.call(body.rows);
        var num=th.getAttribute('data-num')==='1';
        dir[i]=!dir[i];
        rows.sort(function(a,b){
          var x=a.cells[i].getAttribute('data-v'), y=b.cells[i].getAttribute('data-v');
          var c = num ? (parseFloat(x)||0)-(parseFloat(y)||0) : String(x).localeCompare(String(y));
          return dir[i]? -c : c;
        });
        rows.forEach(function(r){body.appendChild(r);});
      });
    });
  }
})();
`.trim();

/**
 * Build the whole page.
 *
 * @param {{ title:string, source:string, columns:Array<Record<string,any>>, rows:string[][],
 *           panels:Array<Record<string,any>>, warnings:string[], delimiter:string,
 *           tableRows?:number, maxPoints?:number }} spec
 */
export function renderDashboard(spec) {
  const { title, source, columns, rows, panels, warnings, delimiter } = spec;
  const tableRows = spec.tableRows ?? DEFAULT_TABLE_ROWS;
  const maxPoints = spec.maxPoints ?? MAX_POINTS;

  const nums = columns.filter((c) => c.type === 'number');
  const dates = columns.filter((c) => c.type === 'date');
  const tiles = [
    { k: 'Rows', v: fmtNum(rows.length, 0) },
    { k: 'Columns', v: String(columns.length) },
  ];
  if (dates.length) {
    const d = dates[0];
    tiles.push({ k: `${d.name} range`, v: `${fmtDate(d.min, d.max - d.min)} → ${fmtDate(d.max, d.max - d.min)}` });
  }
  for (const c of nums.slice(0, 4)) tiles.push({ k: `${c.name} · mean`, v: fmtNum(c.mean) });

  const rendered = panels.map((p, i) => ({ id: `plot${i}`, panel: p, ...renderPanel(p, { maxPoints }) }));

  const panelHtml = rendered.map(({ id, panel, svg, legend, note }) => {
    const legendHtml = legend.length > 1
      ? `<div class="legend">${legend.map((l, i) => `<button type="button" aria-pressed="true" data-plot="${id}" data-series="${i}"><span class="sw" style="background:${l.colour}"></span>${escapeHtml(l.name)}</button>`).join('')}</div>`
      : '';
    const sub = [kindLabel(panel.kind), note].filter(Boolean).join(' · ');
    return `<section class="card">
<h2>${escapeHtml(panel.title)}</h2>
<p class="note">${escapeHtml(sub)}</p>
<div class="plot" id="${id}">${svg}</div>
${legendHtml}
</section>`;
  }).join('\n');

  const shown = rows.slice(0, tableRows);
  const tableHtml = tableRows > 0 ? `<section class="card">
<h2>Data</h2>
<p class="note">${escapeHtml(shown.length === rows.length ? `all ${fmtNum(rows.length, 0)} rows` : `first ${fmtNum(shown.length, 0)} of ${fmtNum(rows.length, 0)} rows`)} · click a column heading to sort</p>
<div class="tablewrap"><table id="data"><thead><tr>${columns.map((c) => `<th data-num="${c.type === 'number' || c.type === 'date' ? 1 : 0}" title="${escapeAttr(c.type)}">${escapeHtml(c.name)}</th>`).join('')}</tr></thead>
<tbody>${shown.map((r, ri) => `<tr>${columns.map((c) => {
    const raw = r[c.index] ?? '';
    /**
     * ⚠️ `rows.indexOf(r)` WAS THE FIRST VERSION AND IT IS TWO BUGS. It is
     * O(rows) inside an O(rows×cols) loop, and `indexOf` matches by identity
     * — fine — but the row index is already in hand from `map`, so looking it
     * up again is pure cost. The PARSED value is what sorts correctly ("1,200"
     * sorts before "9" as text), which is why the raw cell is shown and the
     * parsed one is carried in data-v.
     */
    const sortKey = c.type === 'number' || c.type === 'date' ? String(c.values[ri] ?? '') : raw;
    return `<td class="${c.type === 'number' ? 'num' : ''}" data-v="${escapeAttr(sortKey)}">${escapeHtml(raw)}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table></div>
</section>` : '';

  const warnHtml = warnings.length
    ? `<section class="card"><h2>What to know about this file</h2><ul class="note" style="margin:6px 0 2px 18px;padding:0">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></section>`
    : '';

  const schema = `<section class="card"><h2>Columns</h2><div class="tablewrap"><table><thead><tr><th>Column</th><th>Type</th><th>Missing</th><th>Summary</th></tr></thead><tbody>${
    columns.map((c) => `<tr><td data-v="${escapeAttr(c.name)}">${escapeHtml(c.name)}</td><td data-v="${escapeAttr(c.type)}">${escapeHtml(c.type)}</td><td class="num" data-v="${c.nulls}">${c.nulls}</td><td>${escapeHtml(summaryOf(c))}</td></tr>`).join('')
  }</tbody></table></div></section>`;

  const body = `<div class="wrap">
<header class="top">
<div><h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(source)} · ${escapeHtml(describeDelimiter(delimiter))} · generated by acuvo</p></div>
<div class="spacer"></div>
<button class="tgl" id="theme" type="button">Theme</button>
</header>
<div class="tiles">${tiles.map((t) => `<div class="tile"><p class="k">${escapeHtml(t.k)}</p><div class="v">${escapeHtml(t.v)}</div></div>`).join('')}</div>
${panelHtml}
${schema}
${warnHtml}
${tableHtml}
<footer class="foot">Self-contained: no scripts, styles, fonts or images are loaded from anywhere. It opens offline.</footer>
</div>`;

  return {
    html: htmlDocument({ title, body, js: CHART_JS, description: `${rows.length} rows from ${source}` }),
    panels: rendered.map(({ panel, points, note }) => ({
      kind: panel.kind, title: panel.title,
      x: panel.x?.name ?? null, y: panel.series.map((s) => s.name), points, note: note || null,
    })),
  };
}

const kindLabel = (k) => ({
  line: 'line chart', bar: 'bar chart', scatter: 'scatter plot',
  histogram: 'histogram', count: 'row counts', area: 'area chart',
}[k] ?? k);

const describeDelimiter = (d) => (d === '\t' ? 'tab-separated' : d === ';' ? 'semicolon-separated' : d === '|' ? 'pipe-separated' : 'comma-separated');

function summaryOf(c) {
  if (c.type === 'number') return `min ${fmtNum(c.min)} · median ${fmtNum(c.median)} · mean ${fmtNum(c.mean)} · max ${fmtNum(c.max)}`;
  if (c.type === 'date') {
    const span = (c.max ?? 0) - (c.min ?? 0);
    return `${fmtDate(c.min, span)} → ${fmtDate(c.max, span)}`;
  }
  if (c.type === 'empty') return 'every value is blank';
  return `${c.distinct} distinct${c.categories && c.categories.length <= 6 ? `: ${c.categories.join(', ')}` : ''}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE VERB
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * @param {{ readFile: Function, writeFile: Function, root?: string }} executor
 * @param {Record<string, any>} args
 */
export async function chart(executor, args = {}) {
  if (!executor || typeof executor.readFile !== 'function' || typeof executor.writeFile !== 'function') {
    return { ok: false, error: 'no workspace is available, so there is no file to read and nowhere to write' };
  }
  const csvPath = typeof args.csv_path === 'string' ? args.csv_path.trim() : '';
  const inline = typeof args.csv === 'string' ? args.csv : '';
  if (!csvPath && !inline) return { ok: false, error: 'name a csv_path (workspace-relative), or pass the data inline as `csv`' };
  if (csvPath && inline) return { ok: false, error: 'pass csv_path OR csv, not both — two sources of data is a bug waiting to happen' };

  let outPath = typeof args.out_path === 'string' ? args.out_path.trim() : '';
  if (!outPath) {
    const base = csvPath ? csvPath.replace(/\.[^./\\]+$/, '') : 'chart';
    outPath = `${base}.html`;
  }
  if (!/\.html?$/i.test(outPath)) {
    return { ok: false, error: `out_path must end in .html — "${outPath}" would produce a file no browser opens` };
  }

  let text = inline;
  let source = 'inline data';
  if (csvPath) {
    const read = executor.readFile(csvPath);
    // ⭐ The executor's sentence is returned verbatim: it already names the byte
    // limit, the encoding problem or the binary refusal, and a second wording
    // here is the copy that goes stale.
    if (!read.ok) return { ok: false, error: read.error };
    text = read.content;
    source = read.path;
  }

  const parsed = parseCsv(text, {
    delimiter: typeof args.delimiter === 'string' && args.delimiter ? args.delimiter : null,
    header: args.header !== false,
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const { columns, warnings: typeWarnings } = inferColumns(parsed.header, parsed.rows);
  const plan = planPanels(columns, {
    x: typeof args.x === 'string' ? args.x : null,
    y: Array.isArray(args.y) ? args.y.filter((v) => typeof v === 'string') : (typeof args.y === 'string' ? args.y : null),
    type: typeof args.type === 'string' ? args.type : null,
  });
  if (plan.panels.length === 0) {
    return {
      ok: false,
      error: plan.warnings[0] ?? 'nothing in this file could be charted',
      columns: columns.map((c) => ({ name: c.name, type: c.type })),
    };
  }

  const warnings = [...parsed.warnings, ...typeWarnings, ...plan.warnings];
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : `${source}`;

  /**
   * ⚠️⚠️ FIT BEFORE WRITING, NOT AFTER BEING REFUSED. `MAX_WRITE_BYTES` is
   * 400,000 and the executor refuses past it — a refusal the caller cannot act
   * on, because "your CSV was too interesting" is not a fixable instruction.
   * So detail is shed in the order it is least missed and the shedding is
   * REPORTED, because a table that silently shrank is a table that lies about
   * how much data there is.
   */
  const ladder = [
    { tableRows: DEFAULT_TABLE_ROWS, maxPoints: MAX_POINTS },
    { tableRows: 50, maxPoints: MAX_POINTS },
    { tableRows: 50, maxPoints: 600 },
    { tableRows: 0, maxPoints: 400 },
  ];
  let built = null;
  let shed = null;
  for (const rung of ladder) {
    built = renderDashboard({ title, source, columns, rows: parsed.rows, panels: plan.panels, warnings, delimiter: parsed.delimiter, ...rung });
    if (Buffer.byteLength(built.html, 'utf8') <= MAX_HTML_BYTES) { shed = rung; break; }
    shed = rung;
  }
  if (shed && shed !== ladder[0]) {
    warnings.push(shed.tableRows === 0
      ? 'the page was too large to hold the data table, so only the charts were written'
      : `the data table was trimmed to ${shed.tableRows} rows to keep the file under the write limit`);
    // rebuild once so the page itself carries the note it just earned
    built = renderDashboard({ title, source, columns, rows: parsed.rows, panels: plan.panels, warnings, delimiter: parsed.delimiter, ...shed });
  }

  const bytes = Buffer.byteLength(built.html, 'utf8');
  if (bytes > MAX_HTML_BYTES) {
    return { ok: false, error: `the dashboard came to ${bytes} bytes even after trimming, over the ${MAX_HTML_BYTES}-byte ceiling — chart fewer columns with \`y\`, or filter the file first` };
  }

  if (args.overwrite !== true) {
    // ⚠️ The check is a READ, not a stat: the executor is the only thing that
    // knows where the workspace root really is, and asking it keeps this verb
    // from ever forming an absolute path of its own.
    const probe = executor.readFile(outPath);
    if (probe.ok) {
      return { ok: false, error: `${probe.path} already exists. Pass overwrite: true if replacing it is what you mean.` };
    }
  }

  const written = executor.writeFile(outPath, built.html);
  if (!written.ok) return { ok: false, error: written.error };

  return {
    ok: true,
    path: written.path,
    bytes: written.bytes,
    dryRun: written.dryRun === true,
    source,
    rows: parsed.rows.length,
    delimiter: parsed.delimiter === '\t' ? '\\t' : parsed.delimiter,
    columns: columns.map((c) => ({ name: c.name, type: c.type, missing: c.nulls, ...(c.distinct !== undefined ? { distinct: c.distinct } : {}) })),
    panels: built.panels,
    warnings,
    open: `open ${written.path} in a browser — it is self-contained and works offline`,
  };
}

/**
 * ⭐ NO ENVIRONMENT GATE AND NO PROJECT GATE — deliberately, and it is why this
 * schema is declared in the STABLE block rather than at the end of the file.
 * It reads a file and writes a file. There is no key that could be missing, no
 * service that could be down and no project shape it depends on, so its
 * presence never varies and its bytes stay in the cached prompt prefix.
 *
 * ── ⚠️ MULTI-ROUND ONLY, AND *NOT* FOR THIS PACKAGE'S USUAL REASON ──────────
 *
 * On the merits it belongs in the single-shot offer. The rule `tools.mjs` states
 * for `generate_image` fits it exactly — *"It writes a file, so unlike a read
 * tool its result has somewhere to go even with no second round"* — and unlike
 * `pipe_to_asset`, whose subject is a file the same run must have written first,
 * a CSV somebody wants looked at already exists. One round is a complete job.
 *
 * ⚠️ IT IS WITHHELD ANYWAY BECAUSE TWO EXISTING GREEN GUARDS PIN THAT LIST TO AN
 * EXACT VALUE, and they are not this lane's files:
 *
 *   · `test/integration-run-program-and-collisions.test.mjs:143` asserts the
 *     single-shot offer deep-equals `[...SINGLE_SHOT_TOOL_NAMES]`;
 *   · `test/integration-seams.test.mjs:653` asserts it deep-equals
 *     `[...SINGLE_SHOT_TOOL_NAMES, 'generate_image']`, with the message
 *     *"something reached the single-shot offer that is not in
 *     SINGLE_SHOT_TOOL_NAMES"*.
 *
 * ⭐ THOSE GUARDS ARE DOING THEIR JOB. Widening the single-shot surface is a
 * deliberate decision with a measured cost, and quietly editing two assertions
 * to make room for a new verb is the exact move rule 8 forbids. So this returns
 * nothing at `maxRounds <= 1` and the widening is written down as a proposal
 * instead. The capability is not reduced: every real run has more than one round.
 *
 * ⭐ NO ENVIRONMENT GATE AND NO PROJECT GATE, though — which is why the schema is
 * declared in the STABLE block rather than at the end of the file. It reads a
 * file and writes a file: no key to be missing, no service to be down, no
 * project shape it depends on. Its presence never varies between repositories,
 * so its bytes stay inside the cached prompt prefix.
 *
 * @param {{ maxRounds?: number }} [opts]
 */
export function chartToolNames({ maxRounds = 2 } = {}) {
  if (maxRounds <= 1) return [];
  return [...CHART_TOOL_NAMES];
}

export function chartToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'chart',
        /**
         * ⚠️ Kept short on purpose: these bytes ride every task that selects the
         * `docs` shortlist group. See the note on `syndicate`'s schema for the
         * measured ceiling this is protecting.
         */
        description: [
          'Turn a CSV into a self-contained interactive HTML dashboard — charts, per-column stats and a sortable table,',
          'in one file that opens offline.',
          'USE THIS instead of reading a data file and describing it. Handles quoted fields, embedded commas and',
          'newlines, BOM, CRLF and non-comma delimiters, and infers each column type.',
          'It picks the charts itself (time series, bars, scatter, histogram) unless you name x and y.',
          'Costs nothing — no model, no GPU, no network.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            csv_path: { type: 'string', description: 'Workspace-relative path to the CSV/TSV. Either this or `csv`.' },
            csv: { type: 'string', description: 'The delimited data inline, instead of a path. Use for small data you already have.' },
            out_path: { type: 'string', description: 'Where to write the .html. Defaults to the CSV path with a .html extension.' },
            title: { type: 'string', description: 'Heading for the page. Defaults to the source filename.' },
            x: { type: 'string', description: 'Column for the x-axis. Leave unset to let it choose.' },
            y: {
              type: 'array', items: { type: 'string' },
              description: 'Column(s) to plot. Leave unset to let it choose. Series with wildly different ranges are split into separate panels.',
            },
            type: { type: 'string', enum: ['auto', 'line', 'bar', 'scatter', 'histogram', 'count'], description: 'Force a chart type. Only applies alongside x/y; with neither set the chart is inferred.' },
            delimiter: { type: 'string', description: 'Override the delimiter. It is normally detected — set this only if detection was wrong.' },
            header: { type: 'boolean', description: 'False if the first row is data rather than column names. Default true.' },
            overwrite: { type: 'boolean', description: 'Allow replacing an existing out_path. Default false.' },
          },
          required: [],
        },
      },
    },
  ];
}

/** Dispatch. Mirrors the shape every other tool module in this package uses. */
export async function runChartTool(name, args = {}, { executor } = {}) {
  if (name !== 'chart') return { ok: false, error: `unknown chart tool "${name}"` };
  return chart(executor, args);
}
