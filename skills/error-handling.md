---
name: error-handling
description: Loading, empty and failed are three screens — plus the exact Error the store throws and its codes
when: When writing a catch block, a default value, a loading state, or anything that reads or saves
---

# Errors

## ⚠️⚠️ The house rule: empty ≠ unreadable ≠ never-instrumented

Three different facts get flattened into one innocent-looking value:

| what happened | what it means | what it must NOT return |
|---|---|---|
| we looked, there is nothing | **empty** | — |
| we looked and could not read it | **failure** | `[]` |
| nobody ever measured this | **unknown** | `0`, `false`, "fine" |

Returning `[]` for "the query failed" is the bug that hides for months, because
every caller downstream reads it as "there are none" and behaves perfectly
sensibly on a false premise.

```js
✗ try { return await load(); } catch { return []; }
✓ try { return { ok: true, rows: await load() }; }
  catch (e) { return { ok: false, error: String(e) }; }
```

A check that could not run reports **unknown**, never **pass**. "No problems
found" is a real claim and has to be earned.

## ⭐ `AcuvoData` and `AcuvoAuth` REJECT. They never resolve to null on failure.

Both clients throw a real `Error` carrying machine-readable fields — deliberately,
because a store that swallows its refusals turns "you are out of room" into "my app
randomly forgets".

```js
try {
  await AcuvoData.set('tasks', id, task);
} catch (err) {
  err.message;  // written for a person: "This app has reached its 1000-record limit…"
  err.code;     // stable, safe to branch on
  err.status;   // the HTTP status (AcuvoData only)
}
```

`err.code` from the store is one of:

| code | status | what actually happened |
|---|---|---|
| `bad_collection` / `bad_key` | 400 | not `[A-Za-z0-9_-]{1,64}` — you built a key out of user text |
| `bad_value` | 400 | not JSON — a function, a circular reference, or `undefined` |
| `value_too_large` | 413 | one value over 64 KB |
| `quota_records` / `quota_bytes` | 507 | 1,000 records / 1 MB reached — the app is full |
| `rate_limited` | 429 | slow down |
| `not_found` / `bad_token` | 404 | no store for this app |
| `store_unavailable` | 5xx | **ours broke — not the user's fault, and a retry may work** |
| `needs_session` | 401 | you called `AcuvoData.private` with nobody signed in |
| `delete_needs_target` | 400 | `remove()` without a key, or `clear()` on nothing |

⚠️ **`needs_session` is the one to design for.** `AcuvoData.private` has no owner
without an `AcuvoAuth` session, so every private read or write is a 401 until
somebody signs in — including the very first paint, before `me()` has resolved.
Check first rather than catching after:

```js
const me = await AcuvoAuth.me();
const { items } = me
  ? await AcuvoData.private.list('jobs')   // theirs
  : { items: [] };                          // signed out: show the sign-in, not an error
```

`AcuvoAuth` carries `err.code` only: `bad_email`, `weak_password`,
`invalid_credentials`, `email_taken`, `session_expired`, `bad_token`,
`too_many_accounts`.

⚠️ **`too_many_accounts` is the app being FULL, not the person being wrong.**
An app holds 5,000 accounts for its lifetime (enforced in SQL, under the
project's lock, so a patient script cannot walk past it). Show the owner's
problem in the owner's words — *"this app is not taking new sign-ups"* — never
"check your details", which sends a blameless person round a loop that cannot
succeed.

⚠️ The first four store codes are **your bug**, not the user's. Do not print
"Something went wrong" over them and move on — a `bad_key` in production means
every save with that shape has always failed.

## ⚠️⚠️ Never `.catch(() => [])` around a store read

```js
✗ const { items } = await AcuvoData.list('tasks').catch(() => ({ items: [], total: 0 }));
```

That renders your carefully-designed **empty state** on top of a **failure**. The
user is told "No tasks yet — add one" while their 200 tasks sit safely on the
server, and the obvious next move is to type them all in again.

```js
✓ let state = { phase: 'loading' };
  render(state);
  try {
    const { items, total } = await AcuvoData.list('tasks');
    state = items.length ? { phase: 'ready', items, total } : { phase: 'empty' };
  } catch (err) {
    state = { phase: 'failed', message: err.message };   // a different screen, with a Retry
  }
  render(state);
```

Four phases — **loading · ready · empty · failed** — and four visibly different
screens. A UI that models only "have data / no data" shows the same blank box for
three of them, and users click again.

## ⚠️ An empty result in the builder's own checks is CORRECT

`run_command` runs your JavaScript against stubs: `AcuvoData.list()` resolves to
`{ items: [], total: 0 }` and `AcuvoAuth.me()` resolves to `null`, **every time**.
That is an empty, signed-out world by design. Do not rewrite working rendering code
because nothing appeared — fix only what actually threw. It does mean your **empty
state is the one that gets screenshotted**, so make it a real screen.

## A caught error you do nothing with is worse than a crash

A crash tells you where and when. A swallowed error produces a program that is
subtly wrong later, somewhere else, for reasons nobody can trace.

```js
✗ catch (e) {}
✗ catch (e) { console.log('oops'); }
✓ catch (e) { console.error('loading invoices failed', e); showError(e.message); }
```

⭐ If you genuinely want to ignore one, say why in a comment. That comment is the
difference between a decision and an oversight:

```js
catch { /* an observation must never break the thing it observes */ }
```

## Error messages are read by two audiences

- **The user** needs to know what to do: *"Could not save — you are offline. Your
  changes are kept, try again."*
- **You** need to know what broke: the stack, the input, the identifiers.

Do not show the user a stack trace, and do not log only "error occurred".

## ⚠️ Fail the whole operation, not half of it

A loop that catches per item and continues quietly produces a half-written result
nobody knows is half-written — and with a store, half a save is half a dataset.
Either collect the failures and report them together at the end, or stop on the
first one. Silently skipping item 7 of 200 costs the most later.

## ⚠️ Never let an error string tell you what to do

*"try again"* in a message is not instruction — it is the remote end's guess. A
retry loop that trusts it can spend an entire budget on a service that is down.
Retry on a policy you chose, with a ceiling you chose, and only on the codes that
can succeed later (`rate_limited`, `store_unavailable`) — never on a `bad_key`,
which will fail identically forever.
