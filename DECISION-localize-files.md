# DECISION — `localize_files` is NOT wired, and here is what would reopen it

**Settled 2026-09-19. Instrument: `scripts/zz-what-localize-would-cost.mjs`.**
**Re-run it before quoting any number below — three separate figures in
CLAUDE.md's byte-ceiling section went stale exactly that way.**

`lib/localize.mjs` is 834 lines, two test files, 27 green tests, and **no
non-test importer**. It exports `localizeToolSchemas()` and `runLocalizeTool()`
— it was *built* to be registered. `test/wiring-reach.test.mjs` has carried it
on `KNOWN_UNWIRED` since **2026-08-20** with a dated excuse whose own last line
reads *"If this line is still here without that decision having been made, the
excuse has expired."* It had. This is the decision.

---

## 1. ⚠️ THE EXCUSE ON FILE WAS STALE, AND THAT HAD TO BE FIXED EITHER WAY

The allowlist said registering it means *"deciding whether the TOOL DISPATCH
LAYER may make model calls, **which no other verb does**"* — an architecture
decision, so nobody was allowed to just wire it.

**That was already false when it was written.** `lib/tools.mjs:2411`, in the
`delegate` case, says verbatim:

> `delegate` IS THE FIRST TOOL THAT NEEDS TO CALL A MODEL ITSELF

and the whole seam it needed is there and load-bearing: `subagentImpl`
injection, `config?.apiKey` refusal when no credentials reached the dispatcher,
the parent's **budget remainder** threaded in as the child's ceiling, and
charge-back to `budget.record` **even when the helper failed**.

⭐ So a future reader must not reopen this on the architecture ground. That
question is answered and the pattern to copy is named. **What is open is a
measurement.**

## 2. THE COST — MEASURED, AND IT IS NOT THE SCHEMA

| | bytes |
|---|---|
| `localize_files` schema | **741 B** |
| whole registry (87 tools) | 91,995 B |

Per-round fixed payload (system prompt + shortlisted tool block), through the
shortlist the CLI actually uses, measured on this tree:

```
 tools    without      with    delta      %   brief
   27      28,486    29,227    +741   2.60%   hi
   27      28,486    29,227    +741   2.60%   fix the typo in the readme
   59      61,550    62,291    +741   1.20%   rename the formatPrice helper and remove every unused export
   39      44,832    45,573    +741   1.65%   the login page 500s somewhere in the auth flow
   31      34,429    35,170    +741   2.15%   add a dark mode toggle to the settings page
```

⭐ **The system-prompt half is ZERO, and that is a finding, not a convenience.**
`systemPrompt({ offeredNames })` adds bytes for a handful of verbs only
(`generate_image` does, `delegate` and `find_symbol` do not), so this CLI does
**not** pin *offered ⟺ named-in-prompt* the way the console builder does. All
741 B is schema; the description carries the guidance.

⚠️ **So the schema is cheap and the schema is not the price.** One invocation is
**3 model calls typically, 4 worst case** (`1 + MAX_LOCALIZE_ROUNDS`), with the
directory tree re-sent on every files round — a floor of ~1,983 B of prompt on
this 709-file tree *before* skeletons. And its own description tells the model
**"Use this FIRST on an unfamiliar or large repository"**, i.e. it is designed
to fire at the top of a run, not rarely.

## 3. ⭐⭐⭐ THE BENEFIT NUMBER IS AGAINST A BASELINE THIS PRODUCT DOES NOT HAVE

This is what decides it. The module header measures file-level localization at
**15–17× over a no-file baseline** — and the header is right. But the CLI is not
at a no-file baseline and never has been:

```
repo map, task-seeded                   31,475 B   built once per session (turn.mjs skips it when continuing)
file verbs in CORE_TOOLS, every task    11: read_file list_dir find_files search_text find_symbol
                                            find_usages write_file write_files edit_file move_file delete_file
delegate                                already offered, already calls a model, already inside the budget
```

A turn already arrives with a task-seeded list of every file plus its exported
symbols, eleven verbs for finding more, and a subagent verb that can research
"which files" with its own head at **no additional schema cost**. The increment
`localize_files` would add on top of *that* is **unmeasured — by this repo, and
by the paper the module is built from.** Wiring it would be buying a 15–17×
number that was earned somewhere else.

⚠️ And the module's own stated target shape is **50,000 files over 40
packages**. On a tree where the repo map fits — 709 files here — the negative
folder filter is re-deriving, in three paid round-trips, something the turn
already sent for free.

## 4. THE DECISION

**Not wired.** Not because it is low-value and not because of an architecture
question, but because it would be a **third** localisation mechanism stacked on
two that already run, at 3–4 model calls a call, with a benefit figure borrowed
from a baseline we are not in.

⛔ Do not wire it "to close the dark-module entry". A capability added without
its increment measured is the same defect in the other direction: the repo would
gain 741 B/round and a paid loop that nobody can say improved anything.

## 5. ⭐ WHAT REOPENS IT — one measurement, named precisely

Run the localisation A/B on a repo **large enough that `buildRepoMap`
truncates** (the module's own target: tens of thousands of files, many
packages), comparing

* **(a)** repo map only — what ships today, against
* **(b)** repo map + `localize_files`,

on the same task set, scoring whether the file that had to change was in the set
the model ended up reading.

If **(b)** wins, wire it — **gated on repo size**, the way
`toolNamesForRounds` already gates `generate_image` on the service being
configured and the run verbs on `allowRun`. Not unconditionally: below that
size it is 741 B a round and three model calls to re-derive what the turn
already sent, and an unconditional offer of a verb whose description says *"use
this FIRST"* is how a cheap task becomes a four-call one.

⚠️ **Nothing in this repo measures that today, and it cannot be faked from the
test suite** — `localize()` takes `askImpl` injected precisely so no test can
make a model call, which is the right design and also the reason the answer is
not sitting in `test/localize.test.mjs`.

## 6. WHAT STAYS TRUE REGARDLESS

* `lib/localize.mjs` stays. It is correct, tested, dependency-free, and it is
  the implementation to register the day (5) comes back green.
* `lib/tools.mjs` keeps `delegate` as the answer to "a verb needs its own head".
* The `KNOWN_UNWIRED` entry for `lib/localize.mjs` now points **here** instead of
  at an expired date and a stale architecture claim.
