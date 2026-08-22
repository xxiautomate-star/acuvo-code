---
name: supabase-multitenant
description: Supabase with real multi-tenant safety — RLS, service role, and the leaks that look like working code
when: Reading or writing any database table, or adding a migration
---

# Supabase, multi-tenant

## The two clients, and why mixing them leaks data

- **Anon / user client** — respects Row Level Security. Use for anything a user
  triggers about their own data.
- **Service role** — BYPASSES RLS entirely. Use only in operator/admin paths,
  and never where a tenant id came from the request.

⚠️⚠️ **The classic leak looks like working code:**
```ts
// WRONG — the client chose whose data to read
const { data } = await admin.from('invoices').select('*').eq('tenant_id', body.tenantId);
```
Derive the tenant from the session, never from the payload.

## RLS: a GRANT and a POLICY are different things

- `GRANT` missing → `42501 permission denied`
- `POLICY` missing → **zero rows, no error**

⚠️ The second is the dangerous one: it renders as an innocent empty state. If a
table "has no rows" and you are sure it should, check the policy before the code.

```sql
alter table app.invoices enable row level security;
grant select on app.invoices to authenticated;
create policy invoices_own on app.invoices
  for select to authenticated
  using (tenant_id in (select tenant_id from app.tenant_users where user_id = auth.uid()));
```

⚠️ **A VIEW does not inherit the underlying table's RLS** — it runs with the
definer's rights. A view over a tenant table is a leak unless it filters
explicitly or is operator-only.

## Reading honestly

A failed read and an empty result are DIFFERENT FACTS and must render
differently. Never `?? []`:

```ts
const { data, error } = await supabase.from('x').select('*');
if (error) return { rows: [], unreadable: error.message };  // "we could not read"
return { rows: data ?? [], unreadable: null };              // "there is nothing"
```

## Counting and caps

`.limit(n)` without a count silently turns a partial sample into a confident
total. Ask for the count and say when you hit the cap:
```ts
const { data, count } = await supabase.from('x').select('*', { count: 'exact' }).limit(5000);
const truncated = (count ?? 0) > (data?.length ?? 0);
```
⭐ The real fix at scale is aggregating in SQL (a view with `sum()`/`group by`)
so the row count stops mattering. Raising the limit only moves the cliff.

## Migrations

- Number them sequentially and **check the highest number on disk first** — two
  files claiming one number breaks whoever applies them next.
- Idempotent always: `add column if not exists`, `create index if not exists`.
- A `GENERATED` column cannot be written to. If code needs to insert it, it must
  be a plain column.
- Add the `GRANT` and the `POLICY` in the same migration as the table.
