/**
 * ── DB-INSPECT ──────────────────────────────────────────────────────────────
 *
 * Every test here runs with NO network, NO server, NO API key and NO installed
 * database client. That is not a constraint the tests work around — it is the
 * central claim of `lib/db-inspect.mjs` (the valuable half needs nothing), so
 * the suite proving it offline is the suite proving the feature.
 *
 * Three things are faked, and only three:
 *   · `spawnImpl` for the `sqlite3` and `psql` paths. ⚠️ NEITHER BINARY EXISTS
 *     ON THIS MACHINE, so those paths are proven against a recorded output
 *     shape and an asserted argv, and have never met a real binary. That is
 *     stated here rather than implied by green ticks.
 *   · `importImpl` for `node:sqlite`, so the Node-20 refusal is testable on a
 *     Node 22 machine — otherwise the branch that matters most to a user on the
 *     lowest supported engine would have zero coverage.
 *   · nothing else. The live SQLite tests use a REAL database file in a temp
 *     directory, because a fake `openImpl` cannot prove `{ readOnly: true }`
 *     actually refuses a write, and that refusal is the whole safety argument.
 *
 * ⚠️ THE LIVE SQLITE TESTS SKIP, LOUDLY, ON NODE < 22.5. `package.json` says
 * `engines: node >= 20`; `node:sqlite` arrived in 22.5. A suite that silently
 * passed there would be claiming coverage it does not have.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmDirWithRetry } from './_teardown.mjs';
import {
  splitStatements,
  splitTopLevelCommas,
  unquoteIdentifier,
  parseColumnDefinition,
  foldSqlIntoTables,
  parsePrismaSchema,
  parseDrizzleSchema,
  readSchemaFromWorkspace,
  inspectSqlite,
  inspectSqliteViaCli,
  sampleSqliteRows,
  inspectPostgres,
  inspectDatabase,
  loadNodeSqlite,
  resetSqliteCache,
  pgEnvFromUrl,
  redactConnectionString,
  formatSchema,
  formatRows,
  dbToolSchemas,
  dbChecks,
  MAX_TABLES,
  MAX_COLUMNS,
  MAX_SAMPLE_ROWS,
  PG_FS,
  PG_RS,
} from '../lib/db-inspect.mjs';

/* ── helpers ──────────────────────────────────────────────────────────────── */

function workspace() {
  return mkdtempSync(join(tmpdir(), 'acuvo-db-'));
}

function write(root, rel, text) {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

const tableNamed = (out, name) => out.tables.find((t) => t.name === name);
const columnNamed = (t, name) => t.columns.find((c) => c.name === name);

/** A spawn stand-in with the shape `spawnBounded` expects: an EventEmitter-ish
 *  child with two readable streams. Kept tiny on purpose — a fake that needed
 *  explaining would be a fake nobody could trust. */
function fakeSpawn({ stdout = '', stderr = '', code = 0, throws = null, record = null }) {
  return (file, args, opts) => {
    if (record) record.push({ file, args, opts });
    if (throws) throw new Error(throws);
    const listeners = { close: [], error: [] };
    const stream = (text) => ({
      setEncoding() {},
      on(event, fn) { if (event === 'data' && text) queueMicrotask(() => fn(text)); return this; },
    });
    return {
      stdout: stream(stdout),
      stderr: stream(stderr),
      killed: false,
      pid: 4242,
      kill() { this.killed = true; return true; },
      on(event, fn) {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(fn);
        if (event === 'close') setTimeout(() => fn(code, null), 1);
        return this;
      },
    };
  };
}

/* ══ 1. THE SQL PARSER ════════════════════════════════════════════════════ */

test('splitStatements does not split on a semicolon inside a string, a comment or a dollar-quote', () => {
  const sql = `
    CREATE TABLE a (note text DEFAULT 'x; y');
    -- a comment; with a semicolon
    /* block; comment */
    CREATE FUNCTION f() RETURNS void AS $$ BEGIN; END; $$ LANGUAGE plpgsql;
    CREATE TABLE b (id int);
  `;
  const stmts = splitStatements(sql);
  assert.equal(stmts.length, 3, `expected 3 statements, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.match(stmts[0], /CREATE TABLE a/);
  assert.match(stmts[1], /CREATE FUNCTION/);
  assert.match(stmts[2], /CREATE TABLE b/);
});

test('splitTopLevelCommas ignores commas inside parens, quotes and braces', () => {
  assert.deepEqual(splitTopLevelCommas('a numeric(10,2), b text'), ['a numeric(10,2)', 'b text']);
  assert.deepEqual(splitTopLevelCommas("a text default 'x,y', b int"), ["a text default 'x,y'", 'b int']);
  assert.deepEqual(splitTopLevelCommas("id: x('i', { a: 1, b: 2 }), n: y('n')"), ["id: x('i', { a: 1, b: 2 })", "n: y('n')"]);
});

test('unquoteIdentifier strips every dialect quote and splits the schema', () => {
  assert.deepEqual(unquoteIdentifier('public.users'), { schema: 'public', name: 'users' });
  assert.deepEqual(unquoteIdentifier('"Weird Name"'), { schema: null, name: 'Weird Name' });
  assert.deepEqual(unquoteIdentifier('`key`'), { schema: null, name: 'key' });
  assert.deepEqual(unquoteIdentifier('[dbo].[Users]'), { schema: 'dbo', name: 'Users' });
});

test('parseColumnDefinition keeps parenthesised types attached and reads every flag', () => {
  const c = parseColumnDefinition("plan varchar(32) NOT NULL DEFAULT 'free'");
  assert.equal(c.name, 'plan');
  assert.equal(c.type, 'varchar(32)');
  assert.equal(c.notNull, true);
  assert.equal(c.default, "'free'");

  const t = parseColumnDefinition('created_at timestamp with time zone NOT NULL DEFAULT now()');
  assert.equal(t.type, 'timestamp with time zone');
  assert.equal(t.default, 'now()');

  const fk = parseColumnDefinition('org_id uuid REFERENCES public.orgs(id)');
  assert.deepEqual(fk.references, { table: 'orgs', schema: 'public', column: 'id' });
});

test('CREATE TABLE folds into columns, keys and named constraints', () => {
  const { tables } = foldSqlIntoTables(`
    CREATE TABLE IF NOT EXISTS public.orgs (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE users (
      id serial PRIMARY KEY,
      email text NOT NULL,
      note text DEFAULT 'hi; there)',
      org_id uuid REFERENCES public.orgs(id),
      CONSTRAINT uq_users_email UNIQUE (email)
    );
    CREATE INDEX idx_users_org ON users (org_id, created_at DESC);
  `, { file: 's.sql' });

  const users = tables.get('|users');
  assert.ok(users, `users not parsed: ${[...tables.keys()]}`);
  assert.deepEqual(users.columns.map((c) => c.name), ['id', 'email', 'note', 'org_id']);
  // ⚠️ The `)` inside the default is the whole point of this fixture: a naive
  // depth counter closes the column list there and loses org_id.
  assert.equal(columnNamed(users, 'note').default, "'hi; there)'");
  assert.deepEqual(users.primaryKey, ['id']);
  assert.deepEqual(users.foreignKeys[0], { columns: ['org_id'], table: 'orgs', schema: 'public', columnsReferenced: ['id'] });
  const uq = users.indexes.find((i) => i.unique);
  assert.equal(uq.name, 'uq_users_email', 'the CONSTRAINT name must survive');
  const idx = users.indexes.find((i) => i.name === 'idx_users_org');
  assert.deepEqual(idx.columns, ['org_id', 'created_at']);

  const orgs = tables.get('public|orgs');
  assert.equal(orgs.schema, 'public');
});

test('a column literally named `key` survives MySQL `KEY idx (...)` table constraints', () => {
  const { tables } = foldSqlIntoTables('CREATE TABLE t (id INT UNSIGNED NOT NULL AUTO_INCREMENT, `key` VARCHAR(64) NOT NULL, PRIMARY KEY (id), KEY idx_key (`key`));');
  const t = tables.get('|t');
  assert.deepEqual(t.columns.map((c) => c.name), ['id', 'key'], 'the `key` COLUMN must not be eaten by the KEY constraint rule');
  assert.equal(columnNamed(t, 'id').type, 'INT UNSIGNED');
  assert.deepEqual(t.primaryKey, ['id']);
  assert.deepEqual(t.indexes.map((i) => i.name), ['idx_key']);
});

test('an UNQUOTED column named key or index is a column, not a constraint', () => {
  /**
   * ⚠️ THIS TEST EXISTS BECAUSE MUTATION TESTING FOUND THE ONE ABOVE TOOTHLESS.
   * Loosening the constraint rule to `/^(?:index|key)\b/i` left the suite fully
   * green — because that fixture spells the column `` `key` ``, and a backtick
   * is not the letter k. SQLite accepts both words unquoted and `kv(key, value)`
   * is one of the most common tables in existence, so the discriminating
   * fixture is the unquoted one.
   */
  const { tables } = foldSqlIntoTables('CREATE TABLE kv (key TEXT PRIMARY KEY, index INTEGER, value TEXT);');
  assert.deepEqual(tables.get('|kv').columns.map((c) => c.name), ['key', 'index', 'value']);
  assert.deepEqual(tables.get('|kv').primaryKey, ['key']);
});

test('migrations fold ADD COLUMN in order, and DROP COLUMN is reported rather than applied', () => {
  const { tables, unapplied } = foldSqlIntoTables(`
    CREATE TABLE users (id int);
    ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
    ALTER TABLE users DROP COLUMN id;
  `, { file: 'm.sql' });
  const users = tables.get('|users');
  assert.deepEqual(users.columns.map((c) => c.name), ['id', 'last_seen_at']);
  assert.equal(unapplied.length, 1);
  assert.match(unapplied[0].statement, /DROP COLUMN id/);
});

test('ALTER TABLE ADD CONSTRAINT is not mistaken for a column', () => {
  const { tables } = foldSqlIntoTables('CREATE TABLE t (id int); ALTER TABLE t ADD CONSTRAINT pk_t PRIMARY KEY (id);');
  assert.deepEqual(tables.get('|t').columns.map((c) => c.name), ['id']);
});

/* ══ 2. PRISMA ════════════════════════════════════════════════════════════ */

const PRISMA = `
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  createdAt DateTime @default(now()) @map("created_at")
  bio       String?
  posts     Post[]
  org       Org?     @relation(fields: [orgId], references: [id])
  orgId     Int?
  @@map("users")
  @@index([email])
}
model Post {
  id Int @id
}
model Org {
  id Int @id
}
`;

test('prisma: @@map renames the table, @map renames the column, `?` means nullable', () => {
  const tables = parsePrismaSchema(PRISMA, { file: 'schema.prisma' });
  const users = tables.get('|users');
  assert.ok(users, `models: ${[...tables.keys()]}`);
  assert.equal(users.model, 'User');
  assert.ok(columnNamed(users, 'created_at'), 'createdAt must be reported by its @map name');
  assert.equal(columnNamed(users, 'email').notNull, true);
  assert.equal(columnNamed(users, 'bio').notNull, false);
  assert.equal(columnNamed(users, 'id').primaryKey, true);
});

test('prisma: a field typed as another MODEL is a relation, never a column — including one with @relation(fields:)', () => {
  const users = parsePrismaSchema(PRISMA).get('|users');
  assert.equal(columnNamed(users, 'posts'), undefined, '`posts Post[]` is not a column');
  assert.equal(columnNamed(users, 'org'), undefined, '`org Org? @relation(fields:[orgId])` is not a column either — orgId is');
  assert.ok(columnNamed(users, 'orgId'), 'the scalar that carries the key IS a column');
  assert.deepEqual(users.foreignKeys[0].columns, ['orgId']);
  assert.ok(users.relations.some((r) => r.field === 'posts' && r.list));
});

/* ══ 3. DRIZZLE ═══════════════════════════════════════════════════════════ */

const DRIZZLE = `
import { pgTable, serial, text, integer, timestamp } from 'drizzle-orm/pg-core';
export const orgs = pgTable('orgs', { id: serial('id').primaryKey(), name: text('name') });
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  orgId: integer('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow(),
  bare: text(),
});
`;

test('drizzle: the column object is read as a BRACE body, not the first paren after it', () => {
  const tables = parseDrizzleSchema(DRIZZLE, { file: 'db/schema.ts' });
  const users = tables.get('|users');
  assert.ok(users, `tables: ${[...tables.keys()]}`);
  // ⚠️ The first version asked for a paren body and got `serial('id')`'s
  // argument list, so every table came back with exactly one bogus column.
  assert.deepEqual(users.columns.map((c) => c.name), ['id', 'email', 'org_id', 'created_at', 'bare']);
  assert.equal(columnNamed(users, 'org_id').type, 'integer');
  assert.equal(columnNamed(users, 'email').notNull, true);
  assert.equal(columnNamed(users, 'id').primaryKey, true);
});

test('drizzle: `.references(() => orgs.id, { onDelete })` is one column and one foreign key', () => {
  const users = parseDrizzleSchema(DRIZZLE).get('|users');
  assert.deepEqual(users.foreignKeys, [{ columns: ['org_id'], table: 'orgs', schema: null, columnsReferenced: ['id'] }]);
});

test('drizzle: a schema.ts that declares no table contributes nothing', () => {
  assert.equal(parseDrizzleSchema("export const loginSchema = z.object({ email: z.string() });").size, 0);
});

/* ══ 4. THE WORKSPACE HALF — schema with no database at all ═══════════════ */

test('readSchemaFromWorkspace folds a migrations directory in filename order', async () => {
  const root = workspace();
  try {
    write(root, 'supabase/migrations/0001_init.sql', 'CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL);');
    write(root, 'supabase/migrations/0002_add_plan.sql', "ALTER TABLE users ADD COLUMN plan text DEFAULT 'free';");
    const out = readSchemaFromWorkspace(root);
    assert.equal(out.ok, true, out.error);
    const users = tableNamed(out, 'users');
    assert.ok(users, `tables found: ${out.tables.map((t) => t.name)}`);
    // ⭐ The ordering claim: 0002 adds a column to a table 0001 created. Fold
    // them the other way round and `plan` lands on a table that does not exist
    // yet and `email` is missing from the answer.
    assert.deepEqual(users.columns.map((c) => c.name), ['id', 'email', 'plan']);
    assert.deepEqual(out.sources.map((s) => s.path), ['supabase/migrations/0001_init.sql', 'supabase/migrations/0002_add_plan.sql']);
  } finally {
    await rmDirWithRetry(root);
  }
});

test('a file-derived schema always says it is approximate, even when nothing went wrong', async () => {
  const root = workspace();
  try {
    write(root, 'schema.sql', 'CREATE TABLE t (id int);');
    const out = readSchemaFromWorkspace(root);
    // ⚠️ The honest claim is "this is what the next migration run WILL make
    // true", never "this is what the database holds".
    assert.equal(out.approximate, true);
    assert.match(formatSchema(out), /APPROXIMATE/);
  } finally {
    await rmDirWithRetry(root);
  }
});

test('an explicit path that escapes the workspace is refused, and the refusal names the path', async () => {
  const root = workspace();
  try {
    const out = readSchemaFromWorkspace(root, { paths: ['../outside.sql'] });
    assert.equal(out.ok, false);
    assert.match(out.error, /outside\.sql/);
    assert.equal(typeof out.error, 'string');
  } finally {
    await rmDirWithRetry(root);
  }
});

test('asking for a table that does not exist is an ANSWER, not a crash, and says how many there are', async () => {
  const root = workspace();
  try {
    write(root, 'schema.sql', 'CREATE TABLE users (id int); CREATE TABLE orgs (id int);');
    const out = readSchemaFromWorkspace(root, { table: 'invoices' });
    assert.equal(out.ok, true);
    assert.equal(out.tableCount, 0);
    assert.equal(out.totalTables, 2, 'totalTables must count what WAS found, not what was returned');
    assert.ok(out.notes.some((n) => /no table named "invoices"/.test(n)));
  } finally {
    await rmDirWithRetry(root);
  }
});

test('a table filter finds the one table and reports the total honestly', async () => {
  const root = workspace();
  try {
    write(root, 'schema.sql', 'CREATE TABLE users (id int); CREATE TABLE orgs (id int);');
    const out = readSchemaFromWorkspace(root, { table: 'users' });
    assert.equal(out.tableCount, 1);
    assert.equal(out.tables[0].name, 'users');
    assert.equal(out.totalTables, 2);
  } finally {
    await rmDirWithRetry(root);
  }
});

test('caps bite and are REPORTED: tables, columns, and the totals behind them', async () => {
  const root = workspace();
  try {
    const many = Array.from({ length: MAX_TABLES + 5 }, (_, i) => `CREATE TABLE t${String(i).padStart(4, '0')} (id int);`).join('\n');
    const wide = `CREATE TABLE wide (${Array.from({ length: MAX_COLUMNS + 7 }, (_, i) => `c${i} int`).join(', ')});`;
    write(root, 'schema.sql', `${many}\n${wide}`);
    const out = readSchemaFromWorkspace(root);
    assert.equal(out.tables.length, MAX_TABLES);
    assert.equal(out.tablesCapped, true);
    assert.equal(out.totalTables, MAX_TABLES + 6);
    assert.match(formatSchema(out), /capped at/);

    const one = readSchemaFromWorkspace(root, { table: 'wide' });
    assert.equal(one.tables[0].columns.length, MAX_COLUMNS);
    assert.equal(one.tables[0].columnsTruncated, true);
    assert.equal(one.tables[0].columnsTotal, MAX_COLUMNS + 7);
    assert.match(formatSchema(one), /more column\(s\) not shown/);
  } finally {
    await rmDirWithRetry(root);
  }
});

test('the empty workspace answers with a note naming every other way in — not with silence', async () => {
  const root = workspace();
  try {
    const out = await inspectDatabase(root, {});
    assert.equal(out.ok, true);
    assert.equal(out.tableCount, 0);
    const note = out.notes.join(' ');
    assert.match(note, /paths/);
    assert.match(note, /sqlite/);
    assert.match(note, /postgres/);
  } finally {
    await rmDirWithRetry(root);
  }
});

/* ══ 5. LIVE SQLITE — a real file, a real read-only handle ════════════════ */

const sqliteReady = await loadNodeSqlite();
/** ⚠️ Reported, not hidden: on Node 20 this whole block is skipped and the
 *  reason is printed, because a silent skip is a claim of coverage. */
const skipLive = sqliteReady.ok ? false : `node:sqlite unavailable (${process.version}) — live SQLite coverage SKIPPED`;
resetSqliteCache();

async function withDb(fn) {
  const root = workspace();
  const { DatabaseSync } = (await loadNodeSqlite());
  const db = new DatabaseSync(join(root, 'app.db'));
  db.exec(`
    CREATE TABLE orgs (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      api_key TEXT,
      avatar_hash TEXT,
      org_id INTEGER REFERENCES orgs(id)
    );
    CREATE INDEX idx_users_org ON users(org_id);
    INSERT INTO orgs (id, name) VALUES (1, 'acme');
    INSERT INTO users (email, password_hash, api_key, avatar_hash, org_id) VALUES ('a@b.c', 'scrypt$deadbeef', 'sk-live-111', 'aaa111', 1);
    INSERT INTO users (email, password_hash, api_key, avatar_hash, org_id) VALUES ('d@e.f', 'scrypt$c0ffee', 'sk-live-222', 'bbb222', 1);
  `);
  db.close();
  try {
    return await fn(root);
  } finally {
    await rmDirWithRetry(root);
  }
}

test('live sqlite: the schema comes back with columns, keys, foreign keys and indexes', { skip: skipLive }, async () => {
  await withDb(async (root) => {
    const out = await inspectSqlite(root, 'app.db');
    assert.equal(out.ok, true, out.error);
    assert.equal(out.via, 'node:sqlite');
    const users = tableNamed(out, 'users');
    assert.deepEqual(users.columns.map((c) => c.name), ['id', 'email', 'password_hash', 'api_key', 'avatar_hash', 'org_id']);
    assert.equal(columnNamed(users, 'email').notNull, true);
    assert.deepEqual(users.primaryKey, ['id']);
    assert.deepEqual(users.foreignKeys, [{ columns: ['org_id'], table: 'orgs', schema: null, columnsReferenced: ['id'] }]);
    assert.ok(users.indexes.some((i) => i.name === 'idx_users_org'));
  });
});

test('live sqlite: the handle is READ-ONLY at the engine — a write through it throws', { skip: skipLive }, async () => {
  await withDb(async (root) => {
    const { DatabaseSync } = await loadNodeSqlite();
    const ro = new DatabaseSync(join(root, 'app.db'), { readOnly: true });
    try {
      // ⭐ THE SAFETY ARGUMENT, MEASURED. `db-inspect` never builds a DELETE —
      // but this asserts that even if it did, SQLite would refuse. A guard that
      // only exists in a code path is a guard one refactor can delete.
      assert.throws(() => ro.exec('DELETE FROM users'), /readonly/i);
      assert.equal(ro.prepare('SELECT count(*) AS n FROM users').all()[0].n, 2, 'and the rows are still there');
    } finally {
      ro.close();
    }
  });
});

test('live sqlite: a missing file is refused, names the reason, and is NOT created', { skip: skipLive }, async () => {
  await withDb(async (root) => {
    const out = await inspectSqlite(root, 'nope.db');
    assert.equal(out.ok, false);
    assert.match(out.error, /read-only handle never creates one/);
    assert.equal(existsSync(join(root, 'nope.db')), false, 'inspecting a typo must not leave an empty database behind');
  });
});

test('live sqlite: sample_db_rows returns real rows and clamps the limit', { skip: skipLive }, async () => {
  await withDb(async (root) => {
    const out = await sampleSqliteRows(root, 'app.db', { table: 'users', limit: 999 });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.limit, MAX_SAMPLE_ROWS);
    assert.equal(out.limitCapped, true);
    assert.equal(out.rowCount, 2);
    assert.equal(out.rows[0].email, 'a@b.c');
  });
});

test('live sqlite: a credential-looking column is withheld by default, and NAMED so nobody thinks it is missing', { skip: skipLive }, async () => {
  await withDb(async (root) => {
    const out = await sampleSqliteRows(root, 'app.db', { table: 'users' });
    assert.deepEqual(out.withheld, ['password_hash', 'api_key']);
    assert.match(out.note, /password_hash/);
    assert.equal(JSON.stringify(out.rows).includes('deadbeef'), false, 'the hash must not reach the transcript by accident');
    assert.equal(JSON.stringify(out.rows).includes('sk-live-111'), false, 'nor the api key');
    assert.match(formatRows(out), /withheld/);
    // ⭐ AND THE OTHER HALF, WHICH MATTERS JUST AS MUCH: a guard that fails
    // correct work is worse than none. `avatar_hash` is ordinary data and must
    // come through — this is why bare `hash` is not in SECRET_COLUMN.
    assert.deepEqual(out.columns, ['id', 'email', 'avatar_hash', 'org_id']);
    assert.equal(out.rows[0].avatar_hash, 'aaa111');
  });
});

test('live sqlite: naming the credential column explicitly returns it — the way out is real', { skip: skipLive }, async () => {
  await withDb(async (root) => {
    const out = await sampleSqliteRows(root, 'app.db', { table: 'users', columns: ['email', 'password_hash'] });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(out.columns, ['email', 'password_hash']);
    assert.equal(out.rows[0].password_hash, 'scrypt$deadbeef');
    assert.deepEqual(out.withheld, []);
  });
});

test('live sqlite: an unknown table or column is refused and the refusal lists what DOES exist', { skip: skipLive }, async () => {
  await withDb(async (root) => {
    const bad = await sampleSqliteRows(root, 'app.db', { table: 'invoices' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /users/);
    assert.match(bad.error, /orgs/);

    const badCol = await sampleSqliteRows(root, 'app.db', { table: 'users', columns: ['emial'] });
    assert.equal(badCol.ok, false);
    assert.match(badCol.error, /is not a column of users/);
    assert.match(badCol.error, /email/);
  });
});

test('live sqlite: the table name is matched case-insensitively against the CATALOGUE, never interpolated raw', { skip: skipLive }, async () => {
  await withDb(async (root) => {
    const out = await sampleSqliteRows(root, 'app.db', { table: 'USERS', limit: 1 });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.table, 'users', 'the name used in the query is the one the database spelled');

    // ⭐ THE INJECTION ATTEMPT DIES AS A LOOKUP MISS, not as a parsed query.
    const inject = await sampleSqliteRows(root, 'app.db', { table: 'users"; DROP TABLE users; --' });
    assert.equal(inject.ok, false);
    assert.match(inject.error, /no table or view named/);
    const still = await inspectSqlite(root, 'app.db');
    assert.ok(tableNamed(still, 'users'), 'users must still exist');
  });
});

test('live sqlite: the happy path through the dispatcher works end to end', { skip: skipLive }, async () => {
  await withDb(async (root) => {
    const out = await inspectDatabase(root, { source: 'sqlite', path: 'app.db', table: 'orgs' });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.tableCount, 1);
    assert.equal(out.totalTables, 2);
    assert.match(formatSchema(out), /orgs/);
  });
});

/* ══ 6. THE NODE 20 STORY — refusal and CLI fallback ══════════════════════ */

test('node:sqlite missing is a NAMED refusal that points at both ways out, never a crash', async () => {
  resetSqliteCache();
  try {
    const root = workspace();
    try {
      const out = await inspectSqlite(root, 'app.db', {
        importImpl: async () => { throw new Error("Cannot find module 'node:sqlite'"); },
      });
      assert.equal(out.ok, false);
      assert.match(out.error, /22\.5/, 'the refusal must name the version that has it');
      assert.match(out.error, /sqlite3 CLI/, 'and the other way in');
    } finally {
      await rmDirWithRetry(root);
    }
  } finally {
    resetSqliteCache();
  }
});

test('the sqlite3 CLI fallback runs -readonly and parses .schema through the SAME parser', async () => {
  const root = workspace();
  try {
    write(root, 'app.db', 'not really a database, the fake spawn never reads it');
    const calls = [];
    const out = await inspectSqliteViaCli(root, 'app.db', {
      spawnImpl: fakeSpawn({
        record: calls,
        stdout: 'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);\nCREATE INDEX idx_email ON users(email);\n',
      }),
    });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.via, 'sqlite3-cli');
    assert.deepEqual(tableNamed(out, 'users').columns.map((c) => c.name), ['id', 'email']);
    assert.equal(calls[0].file, 'sqlite3');
    assert.ok(calls[0].args.includes('-readonly'), `argv must open read-only: ${calls[0].args.join(' ')}`);
    assert.ok(calls[0].args.includes('.schema'));
  } finally {
    await rmDirWithRetry(root);
  }
});

test('a missing sqlite3 binary refuses with both ways out named', async () => {
  const root = workspace();
  try {
    write(root, 'app.db', 'x');
    const out = await inspectSqliteViaCli(root, 'app.db', { spawnImpl: fakeSpawn({ throws: 'spawn sqlite3 ENOENT' }) });
    assert.equal(out.ok, false);
    assert.match(out.error, /install it/);
    assert.match(out.error, /22\.5/);
  } finally {
    await rmDirWithRetry(root);
  }
});

test('the dispatcher falls back to the CLI only when node:sqlite is the thing missing', async () => {
  const root = workspace();
  try {
    write(root, 'app.db', 'x');
    const calls = [];
    const out = await inspectDatabase(root, { source: 'sqlite', path: 'app.db' }, {
      importImpl: async () => { throw new Error('no such built-in'); },
      spawnImpl: fakeSpawn({ record: calls, stdout: 'CREATE TABLE t (id int);' }),
    });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.via, 'sqlite3-cli');
    assert.equal(calls.length, 1, 'exactly one fallback attempt');
  } finally {
    resetSqliteCache();
    await rmDirWithRetry(root);
  }
});

/* ══ 7. POSTGRES — the credential rules are the point ═════════════════════ */

const DSN = 'postgres://app_user:sup3r-s3cret@db.example.com:5432/appdb?sslmode=require';

test('redactConnectionString keeps the host and drops the password entirely', () => {
  const red = redactConnectionString(DSN);
  assert.equal(red, 'postgres://app_user:***@db.example.com:5432/appdb');
  assert.equal(red.includes('sup3r-s3cret'), false);
  // ⚠️ Not a URL at all → nothing is echoed. A libpq keyword string holds a
  // password too, and "unparseable" is not a reason to print it.
  assert.equal(redactConnectionString('host=x password=hunter2'), '<connection string, not shown>');
});

test('pgEnvFromUrl decomposes the DSN into libpq variables and refuses a non-postgres URL', () => {
  const { ok, env } = pgEnvFromUrl(DSN);
  assert.equal(ok, true);
  assert.equal(env.PGHOST, 'db.example.com');
  assert.equal(env.PGPORT, '5432');
  assert.equal(env.PGUSER, 'app_user');
  assert.equal(env.PGPASSWORD, 'sup3r-s3cret');
  assert.equal(env.PGDATABASE, 'appdb');
  assert.equal(env.PGSSLMODE, 'require');
  assert.equal(pgEnvFromUrl('mysql://x/y').ok, false);
  assert.equal(pgEnvFromUrl('not a url').ok, false);
});

test('the connection string NEVER reaches argv — it goes through the child environment', async () => {
  const calls = [];
  await inspectPostgres({
    connectionEnv: 'DATABASE_URL',
    env: { DATABASE_URL: DSN, PATH: '/usr/bin' },
    spawnImpl: fakeSpawn({ record: calls, stdout: '' }),
  });
  const argv = calls[0].args.join(' ');
  // ⭐ THE REASON THIS MATTERS: every user on the box can read another
  // process's command line. The environment is not readable the same way.
  assert.equal(argv.includes('sup3r-s3cret'), false, `password leaked into argv: ${argv}`);
  assert.equal(argv.includes('db.example.com'), false, 'the whole DSN stays out of argv');
  assert.equal(calls[0].opts.env.PGPASSWORD, 'sup3r-s3cret');
  assert.equal(calls[0].opts.env.PGHOST, 'db.example.com');
  assert.ok(calls[0].args.includes('-w'), 'psql must never prompt for a password');
  assert.ok(calls[0].args.includes('-X'), 'psql must ignore ~/.psqlrc');
  assert.ok(calls[0].args.some((a) => /default_transaction_read_only = on/.test(a)), 'the session is set read-only');
});

test('an unset connection variable refuses by naming WHERE it may come from, and prints no value', async () => {
  const out = await inspectPostgres({ connectionEnv: 'DATABASE_URL', env: {}, spawnImpl: fakeSpawn({}) });
  assert.equal(out.ok, false);
  assert.match(out.error, /\$DATABASE_URL is not set/);
  assert.match(out.error, /never passed as a tool argument/);
  assert.match(out.error, /source: "files"/, 'and the refusal names the way that always works');
});

test('a malformed DSN is refused without echoing one character of it', async () => {
  const out = await inspectPostgres({ connectionEnv: 'DATABASE_URL', env: { DATABASE_URL: 'mysql://root:hunter2@h/db' }, spawnImpl: fakeSpawn({}) });
  assert.equal(out.ok, false);
  assert.equal(out.error.includes('hunter2'), false, 'a malformed connection string is still a connection string');
  assert.match(out.error, /not a postgres URL/);
});

test('an implausible environment variable NAME is refused before anything is read', async () => {
  const out = await inspectPostgres({ connectionEnv: 'DB URL; rm -rf /', env: {}, spawnImpl: fakeSpawn({}) });
  assert.equal(out.ok, false);
  assert.match(out.error, /not a usable environment variable name/);
});

test('psql output parses into tables, keys and indexes', async () => {
  const rows = [
    ['public', 'users', 'id', 'integer', 'NO', "nextval('users_id_seq')", '1'],
    ['public', 'users', 'email', 'text', 'NO', '', '2'],
    ['public', 'users', 'org_id', 'integer', 'YES', '', '3'],
    ['public', 'users', 'PRIMARY KEY', 'id', 'users', 'id'],
    ['public', 'users', 'FOREIGN KEY', 'org_id', 'orgs', 'id'],
    ['public', 'users', 'UNIQUE', 'email', 'users', 'email'],
    ['public', 'users', 'idx_users_org', 'CREATE INDEX idx_users_org ON public.users USING btree (org_id)'],
  ];
  const stdout = rows.map((r) => r.join(PG_FS) + PG_RS).join('');
  const out = await inspectPostgres({
    env: { DATABASE_URL: DSN },
    spawnImpl: fakeSpawn({ stdout }),
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.via, 'psql');
  assert.equal(out.database, 'postgres://app_user:***@db.example.com:5432/appdb', 'even the success path shows a redacted DSN');
  const users = tableNamed(out, 'users');
  assert.deepEqual(users.columns.map((c) => c.name), ['id', 'email', 'org_id']);
  assert.equal(columnNamed(users, 'id').notNull, true);
  assert.equal(columnNamed(users, 'org_id').notNull, false);
  assert.equal(columnNamed(users, 'email').unique, true);
  assert.deepEqual(users.primaryKey, ['id']);
  assert.deepEqual(users.foreignKeys, [{ columns: ['org_id'], table: 'orgs', schema: null, columnsReferenced: ['id'] }]);
  assert.deepEqual(users.indexes[0].columns, ['org_id']);
});

test('a psql failure reports the REDACTED dsn and the stderr, never the password', async () => {
  const out = await inspectPostgres({
    env: { DATABASE_URL: DSN },
    spawnImpl: fakeSpawn({ code: 2, stderr: 'psql: error: connection to server at "db.example.com" failed' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.includes('sup3r-s3cret'), false);
  assert.match(out.error, /connection to server/);
  assert.match(out.error, /\*\*\*/);
});

test('a missing psql binary refuses and says nothing about the variable it did not use', async () => {
  const out = await inspectPostgres({
    env: { DATABASE_URL: DSN },
    spawnImpl: fakeSpawn({ throws: 'spawn psql ENOENT' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.includes('sup3r-s3cret'), false);
  assert.equal(out.error.includes('db.example.com'), false);
  assert.match(out.error, /source: "files"/);
});

/* ══ 8. THE TOOL SCHEMAS THE LEAD REGISTERS ═══════════════════════════════ */

test('the tool schemas are well formed and JSON-serialisable', () => {
  const schemas = dbToolSchemas();
  assert.equal(schemas.length, 2);
  assert.deepEqual(schemas.map((s) => s.function.name), ['inspect_db', 'sample_db_rows']);
  for (const s of schemas) {
    assert.equal(s.type, 'function');
    assert.equal(typeof s.function.description, 'string');
    assert.ok(s.function.description.length > 80, 'a one-line description is how a tool goes unused');
    assert.equal(s.function.parameters.type, 'object');
    assert.equal(JSON.parse(JSON.stringify(s)).function.name, s.function.name);
  }
  assert.deepEqual(schemas[1].function.parameters.required, ['path', 'table']);
});

test('NO tool parameter carries SQL — that is what makes DROP inexpressible rather than refused', () => {
  // ⭐ This is the doctrine assertion, and it is deliberately structural. A test
  // that fed `DROP TABLE` to the tools and watched them refuse would be testing
  // a denylist we do not have; this one fails the moment somebody ADDS a `sql`
  // or `query` parameter, which is the only way the property can be lost.
  const params = dbToolSchemas().flatMap((s) => Object.keys(s.function.parameters.properties));
  for (const bad of ['sql', 'query', 'statement', 'where', 'filter', 'order_by']) {
    assert.equal(params.includes(bad), false, `"${bad}" would let a model author SQL`);
  }
  // ⭐ The WHOLE parameter surface, pinned. `path` and `table` appear twice
  // because both tools take them. Adding a parameter fails this test on
  // purpose: the list is the claim.
  assert.deepEqual(params.sort(), ['columns', 'connection_env', 'limit', 'path', 'path', 'paths', 'source', 'table', 'table'].sort());
});

test('the connection_env parameter documents that it is a NAME, not a URL', () => {
  const desc = dbToolSchemas()[0].function.parameters.properties.connection_env.description;
  assert.match(desc, /NAME of the environment variable/);
  assert.match(desc, /never the URL itself/);
});

test('dbChecks tells the doctor what each path needs, including "nothing at all"', () => {
  const c = dbChecks();
  assert.equal(c.id, 'db.inspect');
  assert.equal(c.needsKey, false);
  assert.match(c.note, /nothing at all/);
  assert.match(c.note, /22\.5/);
});

/* ══ 9. RENDERING ═════════════════════════════════════════════════════════ */

test('formatSchema renders a refusal as its message rather than "[object Object]"', () => {
  assert.equal(formatSchema({ ok: false, error: 'nope' }), 'nope');
  assert.equal(formatRows({ ok: false, error: 'nope' }), 'nope');
});

test('an empty table renders as data, not as an error', () => {
  const text = formatRows({ ok: true, table: 't', columns: ['id'], rows: [], rowCount: 0, limit: 5, withheld: [], note: null });
  assert.match(text, /the table is empty — that is data, not an error/);
});

test('the dispatcher refuses an unknown source by listing the real ones', async () => {
  const out = await inspectDatabase(process.cwd(), { source: 'mongodb' });
  assert.equal(out.ok, false);
  assert.match(out.error, /"auto", "files", "sqlite" or "postgres"/);
});

test('source "sqlite" without a path refuses by naming the parameter', async () => {
  const out = await inspectDatabase(process.cwd(), { source: 'sqlite' });
  assert.equal(out.ok, false);
  assert.match(out.error, /needs "path"/);
});

/* ⚠️ Kept last and deliberately trivial: `readFileSync` is imported so a future
 * edit that needs it does not re-add it, and an unused import is a lint error
 * in some configs. Asserting the module file exists also proves the suite is
 * pointed at the file it claims to test — a test file that fails to LOAD
 * collects zero tests and the runner still prints a pass. */
test('the module under test is the one on disk', () => {
  const src = readFileSync(new URL('../lib/db-inspect.mjs', import.meta.url), 'utf8');
  assert.match(src, /export function dbToolSchemas/);
  assert.equal(src.includes('DELETE FROM'), false, 'this module must never contain a write statement');
});
