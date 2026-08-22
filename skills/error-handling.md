---
name: error-handling
description: Empty is not unreadable is not never-instrumented — and why a swallowed error is the expensive one
when: When writing a catch block, a default value, or anything that reports a result
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

The same rule for a check: a check that could not run reports **unknown**, never
**pass**. "No problems found" is a real claim and has to be earned.

## A caught error you do nothing with is worse than a crash

A crash tells you where and when. A swallowed error produces a program that is
subtly wrong later, somewhere else, for reasons nobody can trace.

```js
✗ catch (e) {}
✗ catch (e) { console.log('oops'); }
✓ catch (e) { console.error('loading invoices failed', e); showError(e); }
```

⭐ If you genuinely want to ignore one, say why in a comment. That comment is
the difference between a decision and an oversight:

```js
catch { /* an observation must never break the thing it observes */ }
```

## Error messages are read by two audiences

- **The user** needs to know what to do: *"Could not save — you are offline.
  Your changes are kept, try again."*
- **You** need to know what broke: the stack, the input, the identifiers.

Do not show the user a stack trace, and do not log only "error occurred".

## ⚠️ Fail the whole operation, not half of it

A loop that catches per item and continues quietly produces a half-written
result nobody knows is half-written. Either:

- collect the failures and report them together at the end, or
- stop on the first one.

Silently skipping item 7 of 200 is the option that costs the most later.

## Errors at the boundary

Every network call has three outcomes, not two: **success**, **failure**, and
**still going**. A UI that only models the first two shows nothing at all while
the request is in flight, and users click again.

## ⚠️ Never let an error string tell you what to do

*"try again"* in a message is not instruction — it is the remote end's guess. A
retry loop that trusts it can spend an entire budget on a service that is down.
Retry on a policy you chose, with a ceiling you chose.
