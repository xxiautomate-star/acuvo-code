---
name: debugging
description: Read the error literally, doubt the check before the code, and change one thing at a time
when: When something does not work, a test fails, or a fix did not take effect
---

# Debugging

## ⚠️⚠️ Read the error literally. It is usually telling the truth.

`x is not a function` means `x` is not a function. Not "the import is
circular", not "the bundler is confused" — **print `x` and look at it.** Most
time lost to debugging is spent on a theory formed before reading the message.

Ask, in this order:

1. What does the message actually say?
2. What is the value it is complaining about? Print it.
3. Which line? Read that line, not the one you assume it means.

## ⚠️⚠️ Doubt the check before you doubt the code

When a test fails on code you believe is correct, one of two things is true, and
the expensive mistake is assuming it is the first:

- the code is wrong, **or**
- **the check is wrong** — and a check that fails correct work is worse than no
  check, because it sends you to rewrite something that already worked.

Prove which: **break the code deliberately and see whether the check notices.**
A check that stays green when you break the thing it guards was never testing
it. See `verify-your-own-work`.

## The fix that "did not work"

Before concluding a fix is wrong, prove it ran:

- Are you editing the file that is actually loaded? (Two files with the same
  name in different directories is the classic.)
- Did the build/dev server pick it up? Stale cache?
- Is the branch you edited the branch you ran?
- Is something later overwriting it?

⭐ Put a deliberate marker in — `throw new Error('REACHED')` — and confirm you
see it. If you do not, the problem was never the logic.

## Change one thing at a time

Three changes then a test tells you nothing about which mattered — and if it
still fails you now have four suspects. One change, one observation.

Keep the last known-good state reachable so you can always get back.

## Bisect when you have no theory

If it worked before and does not now, the fastest route is not thinking harder,
it is **halving the search space**: `git bisect`, comment out half the file,
disable half the config. Two or three halvings usually beats an hour of staring.

## ⚠️ Reproduce it before you fix it

A bug you cannot reproduce is a bug you cannot confirm you fixed. If it happens
"sometimes", find the input that makes it happen every time first — that
usually IS the diagnosis.

## Say what you know and what you assume

"The request 404s" is an observation. "The route is not registered" is a theory.
Keeping the two apart is what stops you fixing a route that was fine while the
real fault — a typo in the URL — sits unexamined.

## When you are truly stuck

Explain the problem out loud from the beginning, including the parts you are
sure about. The wrong assumption is almost always in the part you did not think
was worth saying.
