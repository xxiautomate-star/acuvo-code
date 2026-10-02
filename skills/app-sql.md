---
name: app-sql
description: A real Postgres database for a generated app — when the brief needs tables, relations, joins or counts across everyone's rows, write migrations/NNNN_name.sql and query it from a server function with ctx.sql.
---

# SQL tables — a database of the app's own

The shared notebook (`AcuvoData`) is a key/value store. When the brief needs
RELATIONS — orders that belong to customers, a join, a count across everyone's
rows, a unique constraint the page cannot enforce — the app gets its own
Postgres schema. Two files do the whole job.

## 1. The migration

```sql
-- migrations/0001_init.sql
create table customers (
  id serial primary key,
  email text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);
create table orders (
  id serial primary key,
  customer_id int not null references customers(id) on delete cascade,
  total_cents int not null check (total_cents >= 0),
  status text not null default 'open',
  created_at timestamptz not null default now()
);
create index on orders (customer_id);
```

Plain Postgres DDL, unqualified names. It is applied ONCE, in name order,
before the first server function runs. **Later changes are NEW numbered
files** — `migrations/0002_add_notes.sql` — never edits to an applied file
(an edited applied file is reported as a conflict and not re-run).

## 2. The function that queries it

```js
// functions/place-order.js
module.exports = async function (args, ctx) {
  const email = String(args.email || '').trim().toLowerCase();
  const total = Math.round(Number(args.totalCents) || 0);
  if (!email || total <= 0) throw new Error('email and a positive total are required');
  const c = await ctx.sql(
    'insert into customers (email, name) values ($1, $2) on conflict (email) do update set name = excluded.name returning id',
    [email, String(args.name || email)],
  );
  const o = await ctx.sql(
    'insert into orders (customer_id, total_cents) values ($1, $2) returning id, status, created_at',
    [c.rows[0].id, total],
  );
  return o.rows[0];
};
```

```js
// in the page
const order = await AcuvoFunctions.call('place-order', { email, name, totalCents });
```

`ctx.sql(text, params)` returns `{ rows, rowCount, truncated }`. A statement
with `RETURNING` or a `select` fills `rows` (at most 500; `truncated: true`
past that); an `update`/`delete` without `RETURNING` gives `rowCount`.

## What `$1` means here

Params are substituted as **quoted literals**, not bound. That is why `$1`
never needs quotes and why a number, a boolean or `null` coerce to the column
the way a literal does. At most 8 params, `$1`..`$8`. Never build SQL by
string concatenation with user input — put it in `params`.

## The rules the database enforces (not the prompt)

- The page never runs SQL. There is no browser client; only a function can.
- The runtime role can read and write rows in THIS app's schema and nothing
  else — no `create table`, no `drop`, no other schema, no `console.*`.
  Those are permission errors from Postgres, not advice.
- All rows are shared with every visitor of the app, exactly like the
  notebook. Per-user privacy is the function's job: check `args`/`ctx`
  before returning someone else's rows.
- A migration at most 32 KB; a statement at most 8 KB; a failed migration is
  named in the function door's error until the file is fixed (fix = a NEW
  file that repairs it, or correct the failed file itself — a failed file is
  retried).

## When NOT to use it

A todo list, a form that saves entries, a leaderboard: the notebook
(`AcuvoData`) is simpler and needs no migration. Reach for SQL when the data
has relations or the brief says so.
