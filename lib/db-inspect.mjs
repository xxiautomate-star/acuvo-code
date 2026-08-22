/**
 * ── ⭐ DB-INSPECT — THE AGENT CAN FINALLY SEE THE DATA MODEL ─────────────────
 *
 * App development is mostly data, and until now this CLI had no idea what a
 * `users` row contains. It could read `api/users/route.ts` and infer, which is
 * exactly the failure mode: the model writes `user.emailAddress` because that
 * is what it would have called the column, and nothing on disk contradicts it
 * until runtime.
 *
 * ── ⚠️ WHAT ZERO DEPENDENCIES ACTUALLY ALLOWS, ARGUED RATHER THAN ASSUMED ───
 * `pg`, `mysql2` and `sqlite3` are all out — the package has an empty
 * `dependencies` and that is the product, not an accident. So the four honest
 * options were weighed, and this file ships three of them:
 *
 *   1. **SCHEMA FROM THE WORKSPACE — no database at all.** Migrations, plain
 *      `*.sql`, `prisma/schema.prisma`, `supabase/schema.sql`, drizzle table
 *      builders. ⭐ THIS IS THE VALUABLE HALF AND IT IS ALSO THE ONE THAT
 *      ALWAYS WORKS: no server, no credential, no network, no binary on PATH,
 *      and it answers the question the agent actually has ("what are the
 *      columns of `orders`?") while it is writing the code. It is also the only
 *      half that works on the machine of a developer who has never run the app.
 *      Everything else here is a bonus on top of it.
 *   2. **SQLITE, LIVE, VIA `node:sqlite`** — Node's OWN built-in (>= 22.5).
 *      Zero dependencies is preserved because it is not a dependency: it ships
 *      inside the runtime. ⚠️ BUT `package.json` says `engines: node >= 20`,
 *      and on Node 20 the module DOES NOT EXIST. So it is imported lazily,
 *      behind a try, and its absence is a NAMED refusal ("your Node is 20.x,
 *      node:sqlite arrived in 22.5 — upgrade, or install the sqlite3 CLI") and
 *      never a crash. Relying on it unconditionally would have made a Node 20
 *      install throw `ERR_MODULE_NOT_FOUND` on a tool call, which is the worst
 *      possible way to learn about an engine field.
 *      ⚠️ It also prints ONE `ExperimentalWarning` to stderr on first import.
 *      That is not suppressed here: suppression means swapping the process-wide
 *      `warning` listeners, and `process.emitWarning` defers to the next tick,
 *      so the swap either misses the warning (measured — it still printed) or
 *      has to stay installed and swallow unrelated warnings from other lanes.
 *      A one-line notice on stderr is cheaper than that. Silence it for a whole
 *      run with `NODE_OPTIONS=--no-warnings=ExperimentalWarning`.
 *   3. **SQLITE VIA THE `sqlite3` CLI** — spawn, not a driver, and only as the
 *      Node 20 fallback. It asks for `.schema` and hands the DDL to the SAME
 *      parser option 1 uses, so there is one schema parser in this file and not
 *      two that can disagree.
 *      ⚠️ HONESTY: `sqlite3` is NOT on this machine's PATH, so this path is
 *      proven against an injected `spawnImpl` and has never met a real binary.
 *      The argv is deliberately boring for that reason.
 *   4. **POSTGRES VIA `psql`** — shipped, same caveat: `psql` is not on this
 *      machine either, so it is spawn-tested only. It is worth shipping because
 *      Postgres is where the app data actually lives, and because the offline
 *      half already covers the case where it is missing.
 *
 * ⚠️ NOT SHIPPED, NAMED SO NOBODY LOOKS FOR IT: MySQL/MariaDB live. There is no
 * built-in client and the `mysql` CLI's output format is a moving target; the
 * file half already parses MySQL `CREATE TABLE` DDL, which is where a MySQL
 * project's schema lives anyway.
 *
 * ── ⭐ READ-ONLY IS INEXPRESSIBLE, NOT REFUSED (the `git.mjs` shape) ─────────
 * There is NO parameter anywhere in this file that carries SQL. `DROP TABLE`,
 * `DELETE`, `UPDATE` and `ALTER` are not blocked by a regex over a model-authored
 * string — a regex over SQL is a promise nobody can keep, because `DELETE/**\/`
 * and `dElEtE` and a unicode homoglyph all exist. Instead:
 *
 *   · every statement this file can run is a CONSTANT written here;
 *   · the only model-supplied values that reach a query are a TABLE NAME and
 *     COLUMN NAMES, and both are checked against the live catalogue first, so
 *     they are strings the database itself just handed us;
 *   · and on top of that the connection is opened READ-ONLY at the engine
 *     (`node:sqlite` `{ readOnly: true }` — measured: `attempt to write a
 *     readonly database`; `sqlite3 -readonly`; and `SET default_transaction_
 *     read_only = on` for psql). Belt and braces, because layer three is the
 *     one that survives a mistake in layers one and two.
 *
 * ── ⚠️ A CONNECTION STRING IS A CREDENTIAL ──────────────────────────────────
 * WHERE IT MAY COME FROM: `process.env` ONLY, named by the caller (default
 * `DATABASE_URL`). The tool parameter is the NAME OF A VARIABLE, never a URL —
 * so a model cannot paste a production DSN into a transcript, and cannot invent
 * one pointing at a host we have never heard of without a human having put it
 * in the environment first.
 * WHERE IT MAY NEVER GO: any return value, any error message, any log line, and
 * `argv`. `argv` matters and is not paranoia — every user on the box can read
 * another process's command line (`ps`, Task Manager). So the DSN is decomposed
 * into `PGHOST`/`PGUSER`/`PGPASSWORD`/… and passed through the child's
 * ENVIRONMENT, which is libpq's own intended mechanism and is not world-readable.
 * `redactConnectionString` exists for the one place a human needs to see WHICH
 * database was reached, and it keeps the host and drops the password.
 *
 * ── WHAT IS CAPPED, AND SAYING SO ───────────────────────────────────────────
 * Tables, columns per table, sample rows, cell size, files scanned and bytes
 * per file are all bounded — the model pays per token, and a 400-table schema
 * dumped whole is both expensive and unreadable. Every cap that BITES is
 * reported in the result (`capped`, `columnsTruncated`, `totalExact`), because
 * "12 tables" and "the first 12 of many" are different answers and a model told
 * the first one stops looking.
 */

import { readFileSync, statSync } from 'node:fs';

import { clampOutput, scrubEnvironment, spawnBounded } from './command.mjs';
import { findFiles } from './search.mjs';
import { resolveInWorkspace } from './workspace.mjs';

/* ── caps ─────────────────────────────────────────────────────────────────── */

/** More than this and the answer is "ask about one table". */
export const MAX_TABLES = 120;
/** Wide tables exist; 80 columns is already a page of output. */
export const MAX_COLUMNS = 80;
/** Rows are for shape-checking, never for reading the data out of a database. */
export const MAX_SAMPLE_ROWS = 20;
export const DEFAULT_SAMPLE_ROWS = 5;
/** A single TEXT cell can hold a megabyte of JSON. */
export const MAX_CELL_CHARS = 200;
/** Schema files to read per source kind. */
export const MAX_SCHEMA_FILES = 60;
/** A 4MB seed dump is not a schema file; read the head of it and say so. */
export const MAX_SCHEMA_FILE_BYTES = 512 * 1024;
/** Both external binaries are fast or wedged. */
export const DB_TIMEOUT_MS = 20_000;
/** Seconds, for libpq. Kept below DB_TIMEOUT_MS so psql gives up before we do. */
export const PG_CONNECT_TIMEOUT_S = 10;

/**
 * ⚠️ COLUMNS WHOSE NAME SAYS "SECRET" ARE WITHHELD FROM `sample_db_rows`.
 *
 * The threat is mundane and likely: the agent samples `users` to check the
 * shape, and `password_hash` plus `api_key` land in a transcript that is
 * stored, replayed, and sent to a model provider. Nobody asked for that and
 * nobody would notice.
 *
 * ⭐ AND THE WAY OUT IS NAMED, because a guard that fails correct work is worse
 * than none: naming the column EXPLICITLY in `columns` returns it. Debugging a
 * bad hash is legitimate; doing it by accident is not.
 */
/**
 * ⚠️ `hash` ON ITS OWN WAS IN THIS LIST AND CAME OUT. It looked prudent and it
 * is the exact shape of "a guard that fails correct work": `file_hash`,
 * `content_hash` and `commit_hash` are ordinary data in half the schemas that
 * exist, and withholding them teaches the agent the column is empty. The case
 * it was there for — `password_hash` — is already covered by `pass(word|wd)?`,
 * so nothing was lost by narrowing it.
 */
export const SECRET_COLUMN = /(pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential|ssn|cvv|salt|session)/i;

/* ── small shared helpers ─────────────────────────────────────────────────── */

/**
 * ⚠️ `workspace.mjs` refuses with `{ ok:false, reason }` and `git.mjs` with
 * `{ ok:false, error }`. Two shapes reaching one caller is how a refusal gets
 * rendered as `undefined`. Everything leaving this file uses `error`.
 */
function refuse(reason) {
  return { ok: false, error: String(reason) };
}

/** Strip `"x"`, `` `x` ``, `[x]`, and split `public.users` into its parts. */
export function unquoteIdentifier(raw) {
  let s = String(raw ?? '').trim();
  const parts = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < s.length) {
        if (s[i] === q) {
          if (s[i + 1] === q) { cur += q; i += 2; continue; }
          i += 1;
          break;
        }
        cur += s[i];
        i += 1;
      }
      continue;
    }
    if (c === '[') {
      i += 1;
      while (i < s.length && s[i] !== ']') { cur += s[i]; i += 1; }
      i += 1;
      continue;
    }
    if (c === '.') { parts.push(cur); cur = ''; i += 1; continue; }
    cur += c;
    i += 1;
  }
  parts.push(cur);
  const name = parts.pop() ?? '';
  const schema = parts.length > 0 ? parts[parts.length - 1] : null;
  return { schema: schema || null, name: name.trim() };
}

/**
 * ⭐ THE ONLY WAY A NAME REACHES SQL. Doubling `"` is the SQL-standard escape
 * and works in SQLite and Postgres alike; combined with "the name came out of
 * the catalogue we just read", an injection would have to survive the database
 * having reported it as an existing object.
 */
function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** The key two files must agree on to be the same table. Unquoted SQL
 *  identifiers are case-insensitive; the display name keeps its original case. */
function tableKey(schema, name) {
  return `${(schema || '').toLowerCase()}|${String(name).toLowerCase()}`;
}

function clampCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `<blob ${value.length} bytes>`;
  if (typeof value === 'object') {
    const s = JSON.stringify(value);
    return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}… (${s.length} chars)` : s;
  }
  const s = String(value);
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}… (${s.length} chars)` : s;
}

/* ── 1. the SQL parser (used by the file half AND by `sqlite3 .schema`) ───── */

/**
 * Split a SQL script into top-level statements.
 *
 * ⚠️ NOT `sql.split(';')`. A default of `';'`, a `COMMENT ON … IS 'a; b'`, and
 * every Postgres function body (`$$ … ; … $$`) contain semicolons, and splitting
 * on them shreds the statement that follows into garbage that then parses as a
 * table with one nonsense column. Quotes, both comment forms and dollar-quoting
 * are tracked instead.
 */
export function splitStatements(sql) {
  const text = String(sql ?? '');
  const out = [];
  let cur = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i += 1;
      cur += ' ';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      cur += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      cur += c;
      i += 1;
      while (i < text.length) {
        if (text[i] === q) {
          if (text[i + 1] === q) { cur += q + q; i += 2; continue; }
          cur += q;
          i += 1;
          break;
        }
        cur += text[i];
        i += 1;
      }
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        if (end === -1) { cur += text.slice(i); i = text.length; continue; }
        cur += text.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }
    if (c === ';') { out.push(cur); cur = ''; i += 1; continue; }
    cur += c;
    i += 1;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * The balanced `( … )` (or `{ … }`) starting at or after `from`, or null.
 * Quote-aware, because a `DEFAULT ')'` inside a column list is legal SQL and a
 * naive depth counter closes the table there and loses every column after it.
 */
function balanced(text, from, openCh = '(', closeCh = ')') {
  const open = text.indexOf(openCh, from);
  if (open === -1) return null;
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < text.length) {
        if (text[i] === q) {
          if (text[i + 1] === q) { i += 2; continue; }
          break;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === openCh) depth += 1;
    else if (c === closeCh) {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i };
    }
    i += 1;
  }
  return null;
}

function parenBody(text, from) {
  return balanced(text, from, '(', ')');
}

/** Split on commas at paren depth 0, ignoring commas inside quotes. */
export function splitTopLevelCommas(body) {
  const text = String(body ?? '');
  const parts = [];
  let cur = '';
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      cur += c;
      i += 1;
      while (i < text.length) {
        if (text[i] === q) {
          if (text[i + 1] === q) { cur += q + q; i += 2; continue; }
          cur += q;
          i += 1;
          break;
        }
        cur += text[i];
        i += 1;
      }
      continue;
    }
    // ⚠️ Braces and brackets count too. Only SQL uses this on a column list,
    // but the drizzle parser uses it on a JS object literal, where a nested
    // `{ onDelete: 'cascade' }` split at its comma turns one column into two.
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; i += 1; continue; }
    cur += c;
    i += 1;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Tokens, where a balanced `( … )` counts as ONE token — so `numeric(10,2)`
 *  and `varchar(255)` stay attached to the type instead of ending it. */
function tokenizeDefinition(def) {
  const text = String(def ?? '');
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '(') {
      const grp = parenBody(text, i);
      if (!grp) { tokens.push(text.slice(i)); break; }
      tokens.push(text.slice(i, grp.end + 1));
      i = grp.end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      let tok = c;
      i += 1;
      while (i < text.length) {
        tok += text[i];
        if (text[i] === q) {
          if (text[i + 1] === q) { tok += q; i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push(tok);
      continue;
    }
    let tok = '';
    while (i < text.length && !/[\s(]/.test(text[i])) { tok += text[i]; i += 1; }
    if (text[i] === '(') {
      const grp = parenBody(text, i);
      if (grp) { tok += text.slice(i, grp.end + 1); i = grp.end + 1; }
    }
    tokens.push(tok);
  }
  return tokens.filter(Boolean);
}

/** Where a type stops and the constraints begin. */
const TYPE_STOP = new Set([
  'NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'DEFAULT', 'REFERENCES', 'CHECK', 'COLLATE',
  'GENERATED', 'CONSTRAINT', 'COMMENT', 'AUTO_INCREMENT', 'AUTOINCREMENT',
  'IDENTITY', 'ON', 'AS', 'STORED', 'KEY',
]);

const CREATE_TABLE_HEAD = /^create\s+(?:or\s+replace\s+)?(?:(?:global|local|temp|temporary|unlogged|virtual)\s+)*table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)/i;
const CREATE_INDEX_HEAD = /^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([^\s(]+)\s+on\s+([^\s(]+)/i;
const ALTER_ADD_COLUMN = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([^\s]+)\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\s\S]+)$/i;
const DESTRUCTIVE_HEAD = /^(drop\s+table|drop\s+column|alter\s+table\s+\S+\s+(drop|rename)|alter\s+table\s+\S+\s+alter)/i;

function emptyTable(schema, name, file) {
  return {
    schema: schema || null,
    name,
    file: file || null,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    indexes: [],
    columnsTruncated: false,
    columnsTotal: 0,
  };
}

function addColumn(table, col) {
  const existing = table.columns.find((c) => c.name.toLowerCase() === col.name.toLowerCase());
  if (existing) { Object.assign(existing, col); return; }
  table.columns.push(col);
}

/** One `name TYPE constraints…` fragment → a column record. */
export function parseColumnDefinition(fragment) {
  const tokens = tokenizeDefinition(fragment);
  if (tokens.length === 0) return null;
  const { name } = unquoteIdentifier(tokens[0]);
  if (!name) return null;

  const typeTokens = [];
  let i = 1;
  while (i < tokens.length) {
    const word = tokens[i].replace(/\(.*$/s, '').toUpperCase();
    if (TYPE_STOP.has(word)) break;
    typeTokens.push(tokens[i]);
    i += 1;
  }
  const rest = tokens.slice(i).join(' ');
  const flat = `${rest}`;

  const col = {
    name,
    type: typeTokens.join(' ') || 'unknown',
    notNull: /\bnot\s+null\b/i.test(flat),
    primaryKey: /\bprimary\s+key\b/i.test(flat),
    unique: /\bunique\b/i.test(flat),
    default: null,
    references: null,
  };
  const def = /\bdefault\s+(\([\s\S]*?\)|'(?:[^']|'')*'|[^\s,]+)/i.exec(flat);
  if (def) col.default = def[1];
  const ref = /\breferences\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i.exec(flat);
  if (ref) {
    const target = unquoteIdentifier(ref[1]);
    col.references = {
      table: target.name,
      schema: target.schema,
      column: ref[2] ? unquoteIdentifier(splitTopLevelCommas(ref[2])[0] ?? '').name : null,
    };
  }
  return col;
}

/**
 * Fold a SQL script into a table map.
 *
 * ⚠️ MIGRATIONS ARE FOLDED, NOT EXECUTED, and the difference is reported.
 * `CREATE TABLE` and `ALTER TABLE … ADD COLUMN` are applied in file order, so a
 * column added by migration 0007 shows up — that is the whole reason to read a
 * migrations directory rather than only `schema.sql`. But `DROP COLUMN`,
 * `RENAME` and `ALTER COLUMN TYPE` are NOT applied: replaying them properly
 * means implementing a dialect, and getting it half right would show the agent
 * a column that no longer exists while claiming to be authoritative. They are
 * collected in `unapplied[]` and set `approximate: true`, so the answer says
 * "here is the shape, and N statements I could not fold" instead of lying.
 */
export function foldSqlIntoTables(sql, { file = null, tables = new Map(), unapplied = [] } = {}) {
  for (const stmt of splitStatements(sql)) {
    /**
     * ⚠️ THE REGEXES RUN AGAINST `stmt`, NOT AGAINST `head`. `head` collapses
     * whitespace, so an index taken from a match on it does not address the
     * same character in `stmt` — and every body here is located by OFFSET.
     * `head` is used only where nothing is measured from it.
     */
    const head = stmt.replace(/\s+/g, ' ').trim();

    const create = CREATE_TABLE_HEAD.exec(stmt);
    if (create) {
      const grp = parenBody(stmt, create[0].length);
      const ident = unquoteIdentifier(create[1]);
      if (!ident.name) continue;
      const key = tableKey(ident.schema, ident.name);
      const table = tables.get(key) ?? emptyTable(ident.schema, ident.name, file);
      tables.set(key, table);
      if (!grp) continue;
      for (const part of splitTopLevelCommas(grp.body)) {
        // ⭐ The constraint NAME is kept, not thrown away with the keyword —
        // `uq_users_email` is what a migration has to reference to drop it.
        const named = /^constraint\s+("[^"]*"|`[^`]*`|\[[^\]]*\]|\S+)\s+/i.exec(part);
        const constraintName = named ? unquoteIdentifier(named[1]).name : null;
        const stripped = named ? part.slice(named[0].length) : part;
        if (/^primary\s+key\s*\(/i.test(stripped)) {
          const cols = parenBody(stripped, 0);
          if (cols) {
            for (const c of splitTopLevelCommas(cols.body)) {
              const n = unquoteIdentifier(c.replace(/\s+(asc|desc)$/i, '')).name;
              if (n && !table.primaryKey.includes(n)) table.primaryKey.push(n);
            }
          }
          continue;
        }
        if (/^foreign\s+key\s*\(/i.test(stripped)) {
          const cols = parenBody(stripped, 0);
          const ref = /\breferences\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i.exec(stripped);
          if (cols && ref) {
            const target = unquoteIdentifier(ref[1]);
            table.foreignKeys.push({
              columns: splitTopLevelCommas(cols.body).map((c) => unquoteIdentifier(c).name),
              table: target.name,
              schema: target.schema,
              columnsReferenced: ref[2] ? splitTopLevelCommas(ref[2]).map((c) => unquoteIdentifier(c).name) : [],
            });
          }
          continue;
        }
        if (/^unique\s*\(/i.test(stripped)) {
          const cols = parenBody(stripped, 0);
          if (cols) {
            table.indexes.push({
              name: constraintName,
              unique: true,
              columns: splitTopLevelCommas(cols.body).map((c) => unquoteIdentifier(c).name),
            });
          }
          continue;
        }
        // ⚠️ MySQL writes `KEY idx_a (a)` and `INDEX idx_a (a)` as TABLE
        // constraints — but `key TEXT` is a perfectly ordinary column, and an
        // over-eager match here deletes it from the schema. So these two only
        // count as constraints when a `(` follows the (optional) index name.
        if (/^(?:index|key)\s+(?:\S+\s*)?\(/i.test(stripped)) {
          const cols = parenBody(stripped, 0);
          if (cols) {
            table.indexes.push({
              name: (/^(?:index|key)\s+(\S+)\s*\(/i.exec(stripped)?.[1] ?? null),
              unique: false,
              columns: splitTopLevelCommas(cols.body).map((c) => unquoteIdentifier(c).name),
            });
          }
          continue;
        }
        if (/^(check|exclude|like|primary\s+key|foreign\s+key|unique)\b/i.test(stripped)) continue;

        const col = parseColumnDefinition(part);
        if (col) {
          addColumn(table, col);
          if (col.primaryKey && !table.primaryKey.includes(col.name)) table.primaryKey.push(col.name);
          if (col.references) {
            table.foreignKeys.push({
              columns: [col.name],
              table: col.references.table,
              schema: col.references.schema,
              columnsReferenced: col.references.column ? [col.references.column] : [],
            });
          }
        }
      }
      continue;
    }

    const alter = ALTER_ADD_COLUMN.exec(stmt);
    if (alter && !/^alter\s+table\s+\S+\s+add\s+(constraint|primary|foreign|unique|check)\b/i.test(head)) {
      const ident = unquoteIdentifier(alter[1]);
      const key = tableKey(ident.schema, ident.name);
      const table = tables.get(key) ?? emptyTable(ident.schema, ident.name, file);
      tables.set(key, table);
      const col = parseColumnDefinition(alter[2]);
      if (col) addColumn(table, col);
      continue;
    }

    const index = CREATE_INDEX_HEAD.exec(stmt);
    if (index) {
      const grp = parenBody(stmt, index[0].length);
      const target = unquoteIdentifier(index[3]);
      const key = tableKey(target.schema, target.name);
      const table = tables.get(key) ?? emptyTable(target.schema, target.name, file);
      tables.set(key, table);
      table.indexes.push({
        name: unquoteIdentifier(index[2]).name,
        unique: Boolean(index[1]),
        columns: grp ? splitTopLevelCommas(grp.body).map((c) => unquoteIdentifier(c.replace(/\s+(asc|desc)$/i, '')).name) : [],
      });
      continue;
    }

    if (DESTRUCTIVE_HEAD.test(head)) {
      unapplied.push({ file, statement: head.slice(0, 120) });
    }
  }
  return { tables, unapplied };
}

/* ── 2. prisma ────────────────────────────────────────────────────────────── */

/**
 * `prisma/schema.prisma` → tables.
 *
 * ⚠️ A PRISMA MODEL IS NOT A TABLE, QUITE. `@@map("users")` renames it,
 * `@map("created_at")` renames a column, and a field whose type is another
 * MODEL is a relation that has no column of its own. Emitting those as columns
 * is the failure that matters here: the agent then writes `SELECT posts FROM
 * users`. So model names are collected first, and a field typed as a known
 * model with no `@relation(fields:)` is recorded as a relation, not a column.
 */
export function parsePrismaSchema(text, { file = null } = {}) {
  const src = String(text ?? '');
  const modelNames = new Set();
  for (const m of src.matchAll(/^\s*model\s+([A-Za-z_]\w*)\s*\{/gm)) modelNames.add(m[1]);

  const tables = new Map();
  const re = /^\s*model\s+([A-Za-z_]\w*)\s*\{/gm;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    let depth = 0;
    let i = open;
    let close = -1;
    while (i < src.length) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) { close = i; break; } }
      i += 1;
    }
    if (close === -1) break;
    const body = src.slice(open + 1, close);
    re.lastIndex = close;

    const modelName = m[1];
    let tableName = modelName;
    const mapped = /@@map\(\s*"([^"]+)"\s*\)/.exec(body);
    if (mapped) tableName = mapped[1];

    const table = emptyTable(null, tableName, file);
    table.model = modelName;
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (!line || line.startsWith('@@')) continue;
      const parts = line.match(/^([A-Za-z_]\w*)\s+(\S+)\s*(.*)$/);
      if (!parts) continue;
      const [, field, rawType, attrs] = parts;
      const optional = rawType.endsWith('?');
      const list = rawType.endsWith('[]');
      const baseType = rawType.replace(/[?\[\]]+$/g, '');
      /**
       * ⚠️ A FIELD TYPED AS ANOTHER MODEL IS *NEVER* A COLUMN — including the
       * one carrying `@relation(fields: [orgId])`. The first version excluded
       * that case, reasoning that a relation with fields "has" a column, and
       * emitted `org Org?` as a column of type `Org`. It does not: `orgId` is
       * the column, and it is declared separately on its own line. An agent
       * shown a column called `org` writes `SELECT org FROM users` and gets a
       * 42703. The `fields:` list is still read, below, as a FOREIGN KEY.
       */
      const isRelation = modelNames.has(baseType);
      if (isRelation) {
        table.relations = table.relations ?? [];
        table.relations.push({ field, model: baseType, list });
        continue;
      }
      const colName = /@map\(\s*"([^"]+)"\s*\)/.exec(attrs)?.[1] ?? field;
      const col = {
        name: colName,
        type: baseType + (list ? '[]' : ''),
        notNull: !optional,
        primaryKey: /@id\b/.test(attrs),
        unique: /@unique\b/.test(attrs),
        default: /@default\(([^)]*)\)/.exec(attrs)?.[1] ?? null,
        references: null,
      };
      if (col.primaryKey) table.primaryKey.push(colName);
      addColumn(table, col);
    }
    const compound = /@@id\(\s*\[([^\]]*)\]/.exec(body);
    if (compound) {
      for (const c of compound[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!table.primaryKey.includes(c)) table.primaryKey.push(c);
      }
    }
    for (const idx of body.matchAll(/@@(unique|index)\(\s*\[([^\]]*)\]/g)) {
      table.indexes.push({
        name: null,
        unique: idx[1] === 'unique',
        columns: idx[2].split(',').map((s) => s.trim()).filter(Boolean),
      });
    }
    // Relations declared WITH fields carry the foreign key, and that is the
    // one thing a coding agent most needs from a prisma file.
    for (const rel of body.matchAll(/@relation\(([^)]*)\)/g)) {
      const fields = /fields\s*:\s*\[([^\]]*)\]/.exec(rel[1]);
      const references = /references\s*:\s*\[([^\]]*)\]/.exec(rel[1]);
      if (fields) {
        table.foreignKeys.push({
          columns: fields[1].split(',').map((s) => s.trim()).filter(Boolean),
          table: null,
          schema: null,
          columnsReferenced: references ? references[1].split(',').map((s) => s.trim()).filter(Boolean) : [],
        });
      }
    }
    tables.set(tableKey(null, tableName), table);
  }
  return tables;
}

/* ── 3. drizzle ───────────────────────────────────────────────────────────── */

const DRIZZLE_TABLE = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(pgTable|sqliteTable|mysqlTable)\s*\(\s*(['"`])([^'"`]+)\3\s*,/g;

/**
 * Drizzle schema files → tables.
 *
 * ⚠️ THIS IS A TEXT PARSE OF TYPESCRIPT, and it is honest about being one: no
 * `import`s are followed, and a table built by a helper function or spread from
 * a shared object will come back with fewer columns than it really has. The
 * result is marked `approximate` for that reason. The alternative — importing
 * the user's TS at runtime — needs a TypeScript compiler we do not have and
 * would execute workspace code, which the whole package refuses to do casually.
 */
export function parseDrizzleSchema(text, { file = null } = {}) {
  const src = String(text ?? '');
  const tables = new Map();
  DRIZZLE_TABLE.lastIndex = 0;
  let m;
  while ((m = DRIZZLE_TABLE.exec(src))) {
    /**
     * ⚠️ THE COLUMNS LIVE IN A `{ … }`, NOT A `( … )`. The first version asked
     * `parenBody` for the body and it dutifully returned the argument list of
     * `serial('id')` — the first paren after the brace — so every table came
     * back with one nonsense column. `balanced` takes the delimiters now.
     */
    const grp = balanced(src, m.index + m[0].length, '{', '}');
    if (!grp) continue;
    const table = emptyTable(null, m[4], file);
    table.builder = m[2];
    table.model = m[1];
    for (const entry of splitTopLevelCommas(grp.body)) {
      const head = /^([A-Za-z_$][\w$]*|['"`][^'"`]+['"`])\s*:\s*([A-Za-z_$][\w$]*)\s*\(\s*(?:(['"`])([^'"`]*)\3)?/.exec(entry.trim());
      if (!head) continue;
      const key = unquoteIdentifier(head[1]).name;
      // ⭐ `id: serial('user_id')` names the DB column; `id: serial()` does not,
      // and then the JS key IS the column name.
      const colName = head[4] || key;
      const col = {
        name: colName,
        type: head[2],
        notNull: /\.notNull\s*\(/.test(entry),
        primaryKey: /\.primaryKey\s*\(/.test(entry),
        unique: /\.unique\s*\(/.test(entry),
        default: /\.default(?:Now|Random)?\s*\(([^)]*)\)/.exec(entry)?.[1] ?? null,
        references: null,
      };
      if (col.primaryKey) table.primaryKey.push(colName);
      const ref = /\.references\s*\(\s*\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/.exec(entry);
      if (ref) {
        table.foreignKeys.push({ columns: [colName], table: ref[1], schema: null, columnsReferenced: [ref[2]] });
      }
      addColumn(table, col);
    }
    tables.set(tableKey(null, table.name), table);
  }
  return tables;
}

/* ── 4. the file half: schema with no database at all ─────────────────────── */

/** ⚠️ Drizzle files can be called anything. These globs find the conventional
 *  names; anything else is reachable by naming it in `paths`, which the tool
 *  description says out loud so "not found" is never mistaken for "not there". */
const SQL_GLOBS = ['**/*.sql'];
const PRISMA_GLOBS = ['**/*.prisma'];
const DRIZZLE_GLOBS = ['**/schema.ts', '**/schema.js', '**/schema.mjs', '**/*.schema.ts', '**/schema/*.ts'];

function kindOf(path) {
  if (path.endsWith('.prisma')) return 'prisma';
  if (path.endsWith('.sql')) return 'sql';
  return 'drizzle';
}

function readCapped(absolute) {
  let size = 0;
  try { size = statSync(absolute).size; } catch { return null; }
  const text = readFileSync(absolute, 'utf8');
  if (size > MAX_SCHEMA_FILE_BYTES) {
    return { text: text.slice(0, MAX_SCHEMA_FILE_BYTES), truncated: true, bytes: size };
  }
  return { text, truncated: false, bytes: size };
}

/**
 * Read every schema source in the workspace and fold it into one answer.
 *
 * ⭐ FILE ORDER IS SORTED, AND THAT IS LOAD-BEARING. Migration filenames are
 * timestamp- or serial-prefixed by every tool that generates them
 * (`0007_add_column.sql`, `20260814120000_x.sql`), so a lexical sort IS
 * chronological order, and folding them out of order would apply an ADD COLUMN
 * before its CREATE TABLE and invent a table.
 */
export function readSchemaFromWorkspace(root, { paths = null, table = null } = {}) {
  /** @type {{path:string,kind:string,tables:number,truncated:boolean}[]} */
  const sources = [];
  const notes = [];
  const unapplied = [];
  const tables = new Map();
  /**
   * ⚠️⭐ ALWAYS TRUE FOR THE FILE HALF, AND THAT IS NOT PESSIMISM.
   *
   * The first version set this only when something went wrong (a truncated
   * file, an unfolded DROP), which made the ordinary answer claim to be exact.
   * It is not: a schema read from source describes what the next migration run
   * WILL make true, not what the database currently holds. A migration that has
   * not been applied, a column added by hand in a console, a table created by
   * an extension — all of them make this answer differ from reality, and none
   * of them leave a trace in the repository. The flag says "reconstructed";
   * `notes` says what specifically was lossy on top of that.
   */
  const approximate = true;
  let filesCapped = false;

  let candidates = [];
  if (Array.isArray(paths) && paths.length > 0) {
    for (const p of paths.slice(0, MAX_SCHEMA_FILES)) {
      const resolved = resolveInWorkspace(root, p, 'read');
      if (!resolved.ok) return refuse(`${p}: ${resolved.reason}`);
      candidates.push({ rel: resolved.relative, absolute: resolved.absolute });
    }
  } else {
    const seen = new Set();
    for (const glob of [...SQL_GLOBS, ...PRISMA_GLOBS, ...DRIZZLE_GLOBS]) {
      const found = findFiles(root, glob);
      if (!found.ok) continue;
      if (found.truncated) filesCapped = true;
      for (const rel of found.files) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const resolved = resolveInWorkspace(root, rel, 'read');
        if (!resolved.ok) continue;
        candidates.push({ rel, absolute: resolved.absolute });
      }
    }
    candidates.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    if (candidates.length > MAX_SCHEMA_FILES) {
      filesCapped = true;
      candidates = candidates.slice(0, MAX_SCHEMA_FILES);
    }
  }

  for (const { rel, absolute } of candidates) {
    const kind = kindOf(rel);
    const read = readCapped(absolute);
    if (!read) continue;
    if (read.truncated) {
      notes.push(`${rel} is ${read.bytes} bytes — only the first ${MAX_SCHEMA_FILE_BYTES} were parsed`);
    }
    const before = tables.size;
    if (kind === 'sql') {
      foldSqlIntoTables(read.text, { file: rel, tables, unapplied });
    } else if (kind === 'prisma') {
      for (const [key, t] of parsePrismaSchema(read.text, { file: rel })) tables.set(key, t);
    } else {
      const found = parseDrizzleSchema(read.text, { file: rel });
      // ⚠️ Only a file that actually declared a table counts as a drizzle
      // source. `**/schema.ts` matches plenty of zod schemas.
      if (found.size > 0) {
        notes.push(`${rel} was read as a drizzle schema by text-matching — imports are not followed, so a table built by a helper may be missing columns`);
        for (const [key, t] of found) tables.set(key, t);
      } else {
        continue;
      }
    }
    sources.push({ path: rel, kind, tables: tables.size - before, truncated: read.truncated });
  }

  if (unapplied.length > 0) {
    notes.push(`${unapplied.length} DROP/RENAME/ALTER-COLUMN statement(s) were NOT folded in — the shape below may include columns a later migration removed`);
  }

  return finishSchema({
    ok: true,
    source: 'files',
    sources,
    tables,
    approximate,
    unapplied,
    notes,
    filesCapped,
    table,
  });
}

/** Shared tail: filter, cap, sort, and report every cap that bit. */
function finishSchema({ ok, source, sources = [], tables, approximate = false, unapplied = [], notes = [], filesCapped = false, table = null, via = null, database = null }) {
  let list = [...tables.values()];
  const totalTables = list.length;
  if (table) {
    const want = String(table).toLowerCase();
    list = list.filter((t) => t.name.toLowerCase() === want || `${t.schema ?? ''}.${t.name}`.toLowerCase() === want);
    if (list.length === 0) {
      return {
        ok: true,
        source,
        via,
        database,
        sources,
        tables: [],
        tableCount: 0,
        totalTables,
        tablesCapped: false,
        filesCapped,
        approximate,
        unapplied,
        notes: [...notes, `no table named "${table}" — ${totalTables} table(s) were found; ask without a table name to list them`],
      };
    }
  }
  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tablesCapped = list.length > MAX_TABLES;
  if (tablesCapped) list = list.slice(0, MAX_TABLES);

  for (const t of list) {
    t.columnsTotal = t.columns.length;
    if (t.columns.length > MAX_COLUMNS) {
      t.columns = t.columns.slice(0, MAX_COLUMNS);
      t.columnsTruncated = true;
    }
  }

  return {
    ok,
    source,
    via,
    database,
    sources,
    tables: list,
    tableCount: list.length,
    /** ⚠️ Every table found BEFORE the cap and the filter — so "3 tables"
     *  never gets read as "this database has 3 tables". */
    totalTables,
    tablesCapped,
    filesCapped,
    approximate,
    unapplied,
    notes,
  };
}

/* ── 5. sqlite, live ──────────────────────────────────────────────────────── */

let nodeSqlitePromise = null;

/**
 * ⚠️ LAZY, CACHED, AND ALLOWED TO FAIL. `engines` says node >= 20 and
 * `node:sqlite` landed in 22.5, so a top-level import would turn a Node 20
 * install into a crash on an unrelated tool call. The promise is cached because
 * the ExperimentalWarning is printed once per import and there is no reason to
 * pay for it twice.
 */
export async function loadNodeSqlite(importImpl = (spec) => import(spec)) {
  if (!nodeSqlitePromise) {
    nodeSqlitePromise = (async () => {
      try {
        const mod = await importImpl('node:sqlite');
        if (!mod?.DatabaseSync) return { ok: false, error: 'node:sqlite loaded but has no DatabaseSync' };
        return { ok: true, DatabaseSync: mod.DatabaseSync };
      } catch (err) {
        return {
          ok: false,
          error: `node:sqlite is not available in this runtime (node ${process.version}); it arrived in Node 22.5. `
            + `Upgrade Node, or install the sqlite3 CLI and this will use that instead: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    })();
  }
  return nodeSqlitePromise;
}

/** Tests only — the cache is per process and a test that injects an importImpl
 *  must not inherit the previous test's answer. */
export function resetSqliteCache() {
  nodeSqlitePromise = null;
}

function plain(row) {
  return row ? { ...row } : row;
}

/**
 * Live SQLite schema through Node's own built-in.
 *
 * ⭐ READ-ONLY AT THE ENGINE. `{ readOnly: true }` was measured, not assumed:
 * a `DELETE` through such a handle fails with `attempt to write a readonly
 * database` (ERR_SQLITE_ERROR). It also refuses to CREATE a missing file, which
 * is the second nice property — pointing this at a typo'd path errors instead
 * of leaving an empty database behind for someone to find later.
 */
export async function inspectSqlite(root, path, { importImpl, openImpl, table = null } = {}) {
  const resolved = resolveInWorkspace(root, path, 'read');
  if (!resolved.ok) return refuse(resolved.reason);

  let open = openImpl;
  if (!open) {
    const loaded = await loadNodeSqlite(importImpl);
    if (!loaded.ok) return refuse(loaded.error);
    open = (file) => new loaded.DatabaseSync(file, { readOnly: true });
  }

  let db;
  try {
    db = open(resolved.absolute);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse(`could not open ${resolved.relative} read-only: ${message}`
      + (/unable to open/i.test(message) ? ' — the file must already exist; a read-only handle never creates one' : ''));
  }

  try {
    const objects = db.prepare(
      "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map(plain);

    const tables = new Map();
    for (const obj of objects) {
      const t = emptyTable(null, obj.name, resolved.relative);
      t.kind = obj.type;
      // ⭐ The ONLY model-supplied value that could reach here is `table`, and
      // it is used to FILTER this list — never to build it. `obj.name` came
      // out of the database a microsecond ago.
      for (const info of db.prepare('SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)').all(obj.name).map(plain)) {
        t.columns.push({
          name: info.name,
          type: info.type || 'unknown',
          notNull: Number(info.notnull) === 1,
          primaryKey: Number(info.pk) > 0,
          unique: false,
          default: info.dflt_value ?? null,
          references: null,
        });
        if (Number(info.pk) > 0) t.primaryKey.push(info.name);
      }
      for (const fk of db.prepare('SELECT "table", "from", "to" FROM pragma_foreign_key_list(?)').all(obj.name).map(plain)) {
        t.foreignKeys.push({
          columns: [fk.from],
          table: fk.table,
          schema: null,
          columnsReferenced: fk.to ? [fk.to] : [],
        });
      }
      for (const idx of db.prepare('SELECT name, "unique", origin FROM pragma_index_list(?)').all(obj.name).map(plain)) {
        const cols = db.prepare('SELECT name FROM pragma_index_info(?)').all(idx.name).map((r) => plain(r).name);
        t.indexes.push({ name: idx.name, unique: Number(idx.unique) === 1, columns: cols, implicit: idx.origin !== 'c' });
      }
      tables.set(tableKey(null, obj.name), t);
    }

    return finishSchema({
      ok: true,
      source: 'sqlite',
      via: 'node:sqlite',
      database: resolved.relative,
      sources: [{ path: resolved.relative, kind: 'sqlite', tables: tables.size, truncated: false }],
      tables,
      table,
      notes: [],
    });
  } catch (err) {
    return refuse(`sqlite read failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try { db.close(); } catch { /* already closed, or never opened cleanly */ }
  }
}

/**
 * Sample rows — the ONE verb here that returns data rather than shape.
 *
 * ⚠️ IT IS DELIBERATELY THE SMALLEST SURFACE IN THE FILE. No WHERE, no ORDER
 * BY, no JOIN, no expression — because every one of those needs a model-authored
 * SQL fragment, and the moment one exists "read-only" becomes a claim about a
 * parser rather than a property of the connection. `LIMIT n` off the top of a
 * table is enough to answer "what does a row of this actually look like", which
 * is the question worth paying for.
 */
export async function sampleSqliteRows(root, path, { table, columns = null, limit = DEFAULT_SAMPLE_ROWS, importImpl, openImpl } = {}) {
  if (!table || typeof table !== 'string') return refuse('a table name is required');
  const resolved = resolveInWorkspace(root, path, 'read');
  if (!resolved.ok) return refuse(resolved.reason);

  const n = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(MAX_SAMPLE_ROWS, Math.floor(Number(limit)))) : DEFAULT_SAMPLE_ROWS;
  const limitCapped = Number(limit) > MAX_SAMPLE_ROWS;

  let open = openImpl;
  if (!open) {
    const loaded = await loadNodeSqlite(importImpl);
    if (!loaded.ok) return refuse(loaded.error);
    open = (file) => new loaded.DatabaseSync(file, { readOnly: true });
  }

  let db;
  try {
    db = open(resolved.absolute);
  } catch (err) {
    return refuse(`could not open ${resolved.relative} read-only: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    // ⭐ THE NAME IS CHECKED AGAINST THE CATALOGUE, NOT AGAINST A REGEX. What
    // goes into the query is the row the database returned, so the identifier
    // is one SQLite itself just spelled for us.
    const known = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
    ).all().map((r) => plain(r).name);
    const actual = known.find((name) => name.toLowerCase() === table.toLowerCase());
    if (!actual) {
      return refuse(`no table or view named "${table}" in ${resolved.relative} — it has: ${known.slice(0, 30).join(', ') || '(none)'}`);
    }

    const info = db.prepare('SELECT name FROM pragma_table_info(?)').all(actual).map((r) => plain(r).name);
    const withheld = [];
    let chosen;
    if (Array.isArray(columns) && columns.length > 0) {
      chosen = [];
      for (const want of columns) {
        const hit = info.find((c) => c.toLowerCase() === String(want).toLowerCase());
        if (!hit) return refuse(`"${want}" is not a column of ${actual} — it has: ${info.join(', ')}`);
        chosen.push(hit);
      }
    } else {
      chosen = info.filter((c) => {
        if (SECRET_COLUMN.test(c)) { withheld.push(c); return false; }
        return true;
      });
      if (chosen.length === 0) {
        return refuse(`every column of ${actual} looks like a credential (${withheld.join(', ')}) — name the ones you need in "columns" if you really want them`);
      }
    }
    const columnsCapped = chosen.length > MAX_COLUMNS;
    if (columnsCapped) chosen = chosen.slice(0, MAX_COLUMNS);

    const sql = `SELECT ${chosen.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(actual)} LIMIT ${n}`;
    const rows = db.prepare(sql).all().map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(plain(row))) out[k] = clampCell(v);
      return out;
    });

    return {
      ok: true,
      database: resolved.relative,
      table: actual,
      columns: chosen,
      rows,
      rowCount: rows.length,
      limit: n,
      limitCapped,
      columnsCapped,
      /** ⭐ Named, not silently dropped — a model that cannot see the column
       *  would otherwise conclude the table does not have one. */
      withheld,
      note: withheld.length > 0
        ? `${withheld.length} credential-looking column(s) withheld: ${withheld.join(', ')} — name them in "columns" to include them`
        : null,
    };
  } catch (err) {
    return refuse(`sqlite read failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try { db.close(); } catch { /* nothing to close */ }
  }
}

/**
 * The Node 20 fallback: `sqlite3 -readonly file .schema`.
 *
 * ⚠️ SPAWN-TESTED ONLY. `sqlite3` is not on the machine this was written on, so
 * the argv is deliberately the most boring form that every version since 3.7
 * accepts, and the DDL it prints is handed to `foldSqlIntoTables` — the same
 * parser the file half uses — rather than to a second, unproven one.
 */
export async function inspectSqliteViaCli(root, path, { spawnImpl, table = null } = {}) {
  const resolved = resolveInWorkspace(root, path, 'read');
  if (!resolved.ok) return refuse(resolved.reason);

  const run = await spawnBounded({
    file: 'sqlite3',
    args: ['-readonly', '-batch', '-noheader', resolved.absolute, '.schema'],
    cwd: root,
    timeoutMs: DB_TIMEOUT_MS,
    spawnImpl,
    env: scrubEnvironment(process.env),
  });
  if (!run.ok) {
    return refuse(`the sqlite3 CLI could not be started — install it, or run on Node 22.5+ where node:sqlite is built in (${run.error})`);
  }
  if (run.timedOut) return refuse(`sqlite3 did not finish within ${DB_TIMEOUT_MS}ms`);
  if (run.exitCode !== 0) return refuse(clampOutput(run.stderr || 'sqlite3 failed').text.trim());

  const { tables, unapplied } = foldSqlIntoTables(run.stdout, { file: resolved.relative });
  return finishSchema({
    ok: true,
    source: 'sqlite',
    via: 'sqlite3-cli',
    database: resolved.relative,
    sources: [{ path: resolved.relative, kind: 'sqlite', tables: tables.size, truncated: false }],
    tables,
    unapplied,
    table,
    notes: ['read through the sqlite3 CLI in -readonly mode'],
  });
}

/* ── 6. postgres, live, through psql ──────────────────────────────────────── */

/** ⚠️ Field/record separators that cannot occur in an identifier or a type, so
 *  a DEFAULT containing a comma or a newline does not shred the row. */
export const PG_FS = '\x1f'; // ASCII UNIT SEPARATOR
export const PG_RS = '\x1e'; // ASCII RECORD SEPARATOR

/** Only a NAME may be supplied, and only a plausible one. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `postgres://u:p@h:5432/db` → `postgres://u:***@h:5432/db`.
 * ⚠️ The ONLY function in this file allowed to touch a DSN for display, and it
 * drops the password rather than masking part of it — a partially masked secret
 * is still a secret with a hint attached.
 */
export function redactConnectionString(raw) {
  const s = String(raw ?? '');
  if (!s) return '';
  try {
    const u = new URL(s);
    const user = u.username ? `${u.username}:***@` : '';
    return `${u.protocol}//${user}${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    // Not a URL — a libpq keyword string, or nonsense. Never echo it.
    return '<connection string, not shown>';
  }
}

/**
 * DSN → libpq environment variables.
 *
 * ⭐ WHY NOT JUST PASS THE URL AS AN ARGUMENT: argv is world-readable. `ps -ef`
 * on Linux and Task Manager's command-line column on Windows show every user on
 * the box the full DSN, password included, for as long as psql runs. The
 * environment of another user's process is not readable the same way, and these
 * variables are libpq's documented mechanism, so this is the boring path rather
 * than a clever one.
 */
export function pgEnvFromUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { ok: false, error: 'not a URL' };
  }
  if (!/^postgres(ql)?:$/i.test(u.protocol)) return { ok: false, error: `not a postgres URL (scheme "${u.protocol.replace(':', '')}")` };
  /** @type {Record<string,string>} */
  const env = {};
  if (u.hostname) env.PGHOST = decodeURIComponent(u.hostname);
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, '');
  if (db) env.PGDATABASE = decodeURIComponent(db);
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env.PGSSLMODE = ssl;
  env.PGCONNECT_TIMEOUT = String(PG_CONNECT_TIMEOUT_S);
  return { ok: true, env };
}

/** ⭐ CONSTANTS. There is no parameter anywhere that can change one character
 *  of these, which is what "read-only is inexpressible" means in practice. */
const PG_READ_ONLY = 'SET default_transaction_read_only = on';
const PG_COLUMNS_SQL = `
SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default, c.ordinal_position
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema NOT IN ('pg_catalog','information_schema')
  AND t.table_type IN ('BASE TABLE','VIEW')
ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
const PG_KEYS_SQL = `
SELECT tc.table_schema, tc.table_name, tc.constraint_type, kcu.column_name,
       COALESCE(ccu.table_name, ''), COALESCE(ccu.column_name, '')
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
LEFT JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
WHERE tc.table_schema NOT IN ('pg_catalog','information_schema')
  AND tc.constraint_type IN ('PRIMARY KEY','FOREIGN KEY','UNIQUE')
ORDER BY tc.table_schema, tc.table_name`;
const PG_INDEXES_SQL = `
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname NOT IN ('pg_catalog','information_schema')
ORDER BY schemaname, tablename, indexname`;

function parsePsqlRows(stdout) {
  return String(stdout ?? '')
    .split(PG_RS)
    .map((r) => r.replace(/^\r?\n/, '').trim())
    .filter(Boolean)
    .map((r) => r.split(PG_FS));
}

/**
 * Live Postgres schema through `psql`.
 *
 * ⚠️ SPAWN-TESTED ONLY — `psql` is not on the machine this was written on. The
 * flags are chosen so nothing is interactive and nothing is inherited:
 *   -X  ignore ~/.psqlrc, which can `\set` anything including an output format
 *   -w  NEVER prompt for a password; a missing one is an error, not a hang
 *   -A -t -F -R  unaligned, tuples only, our own separators
 *   -v ON_ERROR_STOP=1  a failed statement is a non-zero exit, not a silent skip
 */
export async function inspectPostgres({ connectionEnv = 'DATABASE_URL', env = process.env, spawnImpl, cwd = process.cwd(), table = null } = {}) {
  const name = String(connectionEnv || 'DATABASE_URL');
  if (!ENV_NAME.test(name)) return refuse(`"${name}" is not a usable environment variable name`);
  const dsn = env?.[name];
  if (!dsn) {
    return refuse(`$${name} is not set. A connection string is a credential: it is read from the environment only, never passed as a tool argument. `
      + `Set it in your shell (or .env) and try again, or read the schema from the workspace instead (source: "files").`);
  }
  const pg = pgEnvFromUrl(dsn);
  // ⚠️ The VALUE is never echoed — only the variable name and what was wrong
  // with its shape. A malformed DSN in an error message is still a DSN.
  if (!pg.ok) return refuse(`$${name} is ${pg.error} — expected postgres://user:password@host:5432/database`);

  const childEnv = { ...scrubEnvironment(env), ...pg.env };
  const run = await spawnBounded({
    file: 'psql',
    args: ['-X', '-w', '-A', '-t', '-F', PG_FS, '-R', PG_RS, '-v', 'ON_ERROR_STOP=1',
      '-c', PG_READ_ONLY, '-c', PG_COLUMNS_SQL, '-c', PG_KEYS_SQL, '-c', PG_INDEXES_SQL],
    cwd,
    timeoutMs: DB_TIMEOUT_MS,
    spawnImpl,
    env: childEnv,
  });
  if (!run.ok) {
    return refuse('psql could not be started — install the postgres client, or read the schema from the workspace instead (source: "files"). '
      + `Nothing about $${name} was printed.`);
  }
  if (run.timedOut) return refuse(`psql did not finish within ${DB_TIMEOUT_MS}ms against ${redactConnectionString(dsn)}`);
  if (run.exitCode !== 0) {
    // ⚠️ psql's own stderr can contain the host and the user; it cannot contain
    // the password, because the password never entered psql's argv.
    return refuse(`psql failed (${redactConnectionString(dsn)}): ${clampOutput(run.stderr || '', 600).text.trim() || `exit ${run.exitCode}`}`);
  }

  // Each -c writes its own result block; the SET produces none, so three blocks
  // arrive concatenated and are told apart by their column count.
  const rows = parsePsqlRows(run.stdout);
  const tables = new Map();
  const ensure = (schema, name2) => {
    const key = tableKey(schema, name2);
    if (!tables.has(key)) tables.set(key, emptyTable(schema, name2, null));
    return tables.get(key);
  };

  for (const r of rows) {
    if (r.length === 7) {
      const [schema, tbl, column, type, nullable, dflt] = r;
      const t = ensure(schema, tbl);
      addColumn(t, {
        name: column,
        type,
        notNull: nullable === 'NO',
        primaryKey: false,
        unique: false,
        default: dflt || null,
        references: null,
      });
    } else if (r.length === 6) {
      const [schema, tbl, kind, column, refTable, refColumn] = r;
      const t = ensure(schema, tbl);
      if (kind === 'PRIMARY KEY') {
        if (!t.primaryKey.includes(column)) t.primaryKey.push(column);
        const col = t.columns.find((c) => c.name === column);
        if (col) col.primaryKey = true;
      } else if (kind === 'FOREIGN KEY') {
        t.foreignKeys.push({ columns: [column], table: refTable || null, schema: null, columnsReferenced: refColumn ? [refColumn] : [] });
      } else if (kind === 'UNIQUE') {
        const col = t.columns.find((c) => c.name === column);
        if (col) col.unique = true;
      }
    } else if (r.length === 4) {
      const [schema, tbl, indexName, def] = r;
      const t = ensure(schema, tbl);
      const cols = parenBody(def, 0);
      t.indexes.push({
        name: indexName,
        unique: /\bCREATE\s+UNIQUE\b/i.test(def),
        columns: cols ? splitTopLevelCommas(cols.body).map((c) => unquoteIdentifier(c.replace(/\s+(asc|desc)$/i, '')).name) : [],
      });
    }
  }

  return finishSchema({
    ok: true,
    source: 'postgres',
    via: 'psql',
    database: redactConnectionString(dsn),
    sources: [{ path: redactConnectionString(dsn), kind: 'postgres', tables: tables.size, truncated: false }],
    tables,
    table,
    notes: [`session was set ${PG_READ_ONLY}; no statement in this tool can write`],
  });
}

/* ── 7. the dispatcher the lead wires ─────────────────────────────────────── */

/**
 * `source: 'auto'` is the interesting case: it reads the WORKSPACE, because
 * that is the path that works with no credential, no binary and no server, and
 * because during code-writing the migrations ARE the truth — they are what the
 * next deploy will make true. Live inspection is asked for by name.
 */
export async function inspectDatabase(root, args = {}, opts = {}) {
  const source = String(args.source ?? 'auto');
  const table = args.table ?? null;

  if (source === 'files' || source === 'auto') {
    const out = readSchemaFromWorkspace(root, { paths: args.paths ?? null, table });
    if (!out.ok) return out;
    if (source === 'auto' && out.tableCount === 0 && out.totalTables === 0) {
      out.notes = [
        ...out.notes,
        'no schema files found in the workspace (looked for *.sql, *.prisma and conventional drizzle files). '
        + 'If the schema lives elsewhere, pass "paths"; for a live database pass source "sqlite" with a path, or "postgres".',
      ];
    }
    return out;
  }

  if (source === 'sqlite') {
    if (!args.path) return refuse('source "sqlite" needs "path" — the workspace-relative path of the .db/.sqlite file');
    const native = await inspectSqlite(root, args.path, { ...opts, table });
    if (native.ok) return native;
    // ⭐ ONE FALLBACK, AND IT SAYS SO. A Node 20 runtime has no node:sqlite; the
    // CLI is the only remaining way in, and if it is missing too the refusal
    // from THIS call names both ways out rather than only the second.
    if (!/node:sqlite is not available/.test(native.error)) return native;
    const viaCli = await inspectSqliteViaCli(root, args.path, { ...opts, table });
    if (viaCli.ok) return viaCli;
    return refuse(`${native.error}\nand the CLI fallback also failed: ${viaCli.error}`);
  }

  if (source === 'postgres') {
    return inspectPostgres({ ...opts, connectionEnv: args.connection_env ?? args.connectionEnv ?? 'DATABASE_URL', cwd: root, table });
  }

  return refuse(`unknown source "${source}" — use "auto", "files", "sqlite" or "postgres"`);
}

/* ── 8. rendering ─────────────────────────────────────────────────────────── */

function renderColumn(c) {
  const bits = [c.name, c.type];
  if (c.primaryKey) bits.push('PK');
  if (c.notNull) bits.push('NOT NULL');
  if (c.unique) bits.push('UNIQUE');
  if (c.default !== null && c.default !== undefined && c.default !== '') bits.push(`default ${c.default}`);
  return `    ${bits.join('  ')}`;
}

export function formatSchema(out) {
  if (!out?.ok) return String(out?.error ?? 'schema inspection failed');
  const lines = [];
  const where = out.database ? ` — ${out.database}` : '';
  lines.push(`schema from ${out.source}${out.via ? ` (${out.via})` : ''}${where}: ${out.tableCount} table(s) shown of ${out.totalTables} found`);
  if (out.tablesCapped) lines.push(`⚠️ capped at ${MAX_TABLES} tables — ask for one by name to see the rest`);
  if (out.filesCapped) lines.push('⚠️ the file scan was capped, so there may be schema files this did not read');
  if (out.approximate) lines.push('⚠️ APPROXIMATE — reconstructed from source files, not read from a running database');
  for (const s of out.sources ?? []) lines.push(`  · ${s.path} (${s.kind})`);

  for (const t of out.tables) {
    const name = t.schema ? `${t.schema}.${t.name}` : t.name;
    lines.push(`\n  ${name}${t.kind === 'view' ? ' (view)' : ''}${t.file ? `  [${t.file}]` : ''}`);
    for (const c of t.columns) lines.push(renderColumn(c));
    if (t.columnsTruncated) lines.push(`    … ${t.columnsTotal - t.columns.length} more column(s) not shown`);
    if (t.primaryKey.length > 0) lines.push(`    primary key: ${t.primaryKey.join(', ')}`);
    for (const fk of t.foreignKeys) {
      lines.push(`    ${fk.columns.join(', ')} → ${fk.table ?? '?'}${fk.columnsReferenced.length ? `(${fk.columnsReferenced.join(', ')})` : ''}`);
    }
    for (const idx of t.indexes) {
      if (idx.implicit) continue;
      lines.push(`    index ${idx.name ?? '(unnamed)'}${idx.unique ? ' UNIQUE' : ''} on (${idx.columns.join(', ')})`);
    }
    if (t.relations?.length) lines.push(`    relations: ${t.relations.map((r) => `${r.field}→${r.model}${r.list ? '[]' : ''}`).join(', ')}`);
  }
  for (const note of out.notes ?? []) lines.push(`\nnote: ${note}`);
  for (const u of (out.unapplied ?? []).slice(0, 10)) lines.push(`  not folded: ${u.file ? `${u.file}: ` : ''}${u.statement}`);
  return lines.join('\n');
}

export function formatRows(out) {
  if (!out?.ok) return String(out?.error ?? 'sample failed');
  const lines = [`${out.rowCount} row(s) from ${out.table} (limit ${out.limit})`];
  if (out.limitCapped) lines.push(`⚠️ limit capped at ${MAX_SAMPLE_ROWS}`);
  if (out.columnsCapped) lines.push(`⚠️ columns capped at ${MAX_COLUMNS}`);
  if (out.note) lines.push(`⚠️ ${out.note}`);
  lines.push(out.columns.join(' | '));
  for (const row of out.rows) lines.push(out.columns.map((c) => (row[c] === null ? 'NULL' : row[c])).join(' | '));
  if (out.rowCount === 0) lines.push('(the table is empty — that is data, not an error)');
  return lines.join('\n');
}

/* ── 9. tool schemas for the lead to register ─────────────────────────────── */

export function dbToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'inspect_db',
        description: [
          'Understand the DATABASE behind this project: tables, columns, types, primary keys, foreign keys, indexes.',
          'Call it BEFORE writing any code that reads or writes data — guessing a column name is the single most common',
          'way generated app code fails at runtime.',
          'Default source "auto" reads the schema out of the WORKSPACE — migrations, *.sql, prisma/schema.prisma,',
          'supabase/schema.sql, drizzle table builders — so it needs no server, no credential and no network, and it works',
          'before the app has ever been run. Migrations are folded in filename order; DROP/RENAME statements are NOT folded',
          'and are listed, so treat a "files" answer as the intended shape rather than a census of a live database.',
          'source "sqlite" reads a real .db file READ-ONLY (needs Node 22.5+ for node:sqlite, or the sqlite3 CLI).',
          'source "postgres" reads a live database through psql, using a connection string taken from the ENVIRONMENT.',
          'This tool can only READ. There is no parameter that carries SQL, so DROP/DELETE/UPDATE are not refused — they',
          'are not expressible.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              enum: ['auto', 'files', 'sqlite', 'postgres'],
              description: 'Where to read the schema from. Leave it out for "auto" (the workspace files), which always works.',
            },
            path: {
              type: 'string',
              description: 'source "sqlite" only: the workspace-relative path of the .db / .sqlite file, e.g. "prisma/dev.db".',
            },
            connection_env: {
              type: 'string',
              description: 'source "postgres" only: the NAME of the environment variable holding the connection string, default DATABASE_URL. '
                + 'A connection string is a credential — pass the variable name, never the URL itself; a URL passed here is not read.',
            },
            table: {
              type: 'string',
              description: 'Show only this table. Use it when a schema is large — the full listing is capped and a named table never is.',
            },
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'source "files" only: read exactly these files instead of scanning. The way to reach a drizzle schema '
                + 'whose filename is not one of the conventional ones.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'sample_db_rows',
        description: [
          `Read at most ${MAX_SAMPLE_ROWS} rows off the top of one SQLite table, to see what real values look like`,
          '(are timestamps ISO strings or epoch integers? is `status` an enum or free text?).',
          'The connection is opened read-only at the engine, and there is no WHERE, ORDER BY or JOIN — this verb takes a',
          'table name and a row count, not SQL.',
          'Columns whose NAME looks like a credential (password, token, api_key, secret, hash, …) are withheld and listed;',
          'name one explicitly in "columns" if you genuinely need it.',
          'Prefer inspect_db: the SHAPE answers most questions and costs far fewer tokens than rows do.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative path of the .db / .sqlite file.' },
            table: { type: 'string', description: 'The table or view to sample. Must already exist; the name is checked against the database.' },
            columns: {
              type: 'array',
              items: { type: 'string' },
              description: 'Only these columns. Also the way to include a credential-looking column that would otherwise be withheld.',
            },
            limit: { type: 'integer', description: `Rows, default ${DEFAULT_SAMPLE_ROWS}, max ${MAX_SAMPLE_ROWS}.` },
          },
          required: ['path', 'table'],
        },
      },
    },
  ];
}

/** For the doctor: what this capability needs, and what it costs. */
export function dbChecks() {
  return {
    id: 'db.inspect',
    label: 'database inspection',
    needsKey: false,
    note: 'schema from workspace files needs nothing at all. Live SQLite needs Node >= 22.5 (node:sqlite, built in) '
      + 'or the sqlite3 CLI. Live Postgres needs psql on PATH and a DSN in the environment. Read-only throughout; '
      + 'no connection string is ever printed or passed in argv.',
  };
}
