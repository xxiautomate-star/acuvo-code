---
name: verify-your-own-work
description: How to prove a change works — mutation testing, and why "it builds" proves nothing
when: After writing code, adding a test, or before reporting something as done
---

# Proving it works

## "It builds" is not evidence

A clean build proves the code parses. It does not prove the feature is reachable,
that the test would catch a regression, or that a human can get to it.

The three claims, from weakest to strongest:
1. *It compiles.* — almost worthless.
2. *The tests pass.* — worth something, IF the tests can fail.
3. *I ran the real path end to end and observed the result.* — this is evidence.

## ⚠️⚠️ Mutation-test every guard you write

A test that cannot fail is worse than no test: it costs the same to maintain and
it actively certifies broken code.

**After writing a check, break the thing it guards and confirm the test goes
RED. Then restore and confirm GREEN.**

```
1. write the guard         → green
2. break the code it guards → MUST go red   ← if it stays green, the test is fake
3. restore                  → green again
```

Real examples of tests that passed while guarding nothing:
- a regex missing anchors, so `abc<valid>def` passed
- `toContain('<Widget')`, satisfied by `<WidgetX` — the component was renamed and
  the test never noticed
- a check whose verdict depended on the OS path separator: it passed on CI and
  failed only on the developer's machine

## Only the end-to-end run proves reach

The most expensive recurring defect is **built but unreachable**: the function
exists, the tests pass, and nothing can actually invoke it. A registered tool
that never fires, a page with no link to it, an export with no importer.

So before "done": run the real path. Open the page. Call the endpoint. Check the
row landed in the database.

## Say what you did not check

If you tested three of five cases, say which two you did not. An honest partial
result is useful; an implied "all good" that turns out to be a third is not.

## When a check fails, doubt the check first

A failing test means one of two things and they are not equally likely:
1. the code is broken
2. **the check is wrong**

Read the failure literally and verify each link in its chain before "fixing" the
code. Changing correct code to satisfy a broken test is a real and common way to
make software worse while feeling productive.
