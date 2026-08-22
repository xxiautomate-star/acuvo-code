---
name: refactoring
description: Changing code safely without a rewrite — small steps, a green check between each, no behaviour change
when: Before restructuring code, when tempted to rewrite, or when a change touches many files
---

# Refactoring

## ⚠️⚠️ Refactoring means behaviour does NOT change

If the output changes, it is not a refactor — it is a rewrite with a reassuring
name, and it will be reviewed as if nothing could have broken.

Do them one at a time:

- **Refactor**, verify it still behaves identically, commit.
- **Then** change the behaviour, in its own commit.

Mixing the two produces a diff where nobody — including you next month — can
tell which lines were meant to change anything.

## Small steps with a green check between each

The safety comes from the size of the step, not from care. Rename, run. Extract,
run. Move, run. If something breaks you know exactly what did it, because you
did exactly one thing.

⚠️ A refactor that cannot be verified between steps is a rewrite. **Get a check
in place FIRST** — if the code has no test, the first commit is a test that
pins current behaviour, before you touch anything.

⭐ And confirm that check can fail: break the code deliberately, see it go red,
restore. A green suite that would stay green through a mistake gives you
confidence you have not earned (`verify-your-own-work`).

## ⚠️ The rewrite trap

"This is a mess, I will just rewrite it" loses everything the mess encodes: the
edge cases, the bug fixes, the reason for the strange branch on line 40 that
turns out to be a customer's data. The ugly code has been in production; the
clean replacement has not.

Rewrite when the requirements genuinely changed. Refactor when the code is hard
to work with. They are different problems and only one is solved by starting
over.

## What to do first

1. **Rename** to what things actually are. Free, reversible, and often the
   whole problem — a lot of "confusing code" is code with lying names.
2. **Extract** a well-named function from a comment that says what the next ten
   lines do.
3. **Delete** what nothing calls. Dead code is read, maintained and believed by
   everyone who comes after.
4. **Split** only once the seams are obvious. Splitting early puts boundaries in
   the wrong places, and a wrong boundary is harder to remove than no boundary.

## Duplication is cheaper than the wrong abstraction

Two similar blocks that evolve differently are fine. One "shared" helper with
four boolean flags to serve four callers is worse than the duplication it
replaced. **Wait for the third occurrence** before generalising — by then you
can see what is genuinely common.

## Leave the campsite tidy, not rebuilt

Touching a file is a good moment to fix the name you had to squint at. It is not
a good moment to restructure the module — that lands in someone's review of an
unrelated change, and it is where "small fix" becomes a 400-line diff nobody can
approve with confidence.
