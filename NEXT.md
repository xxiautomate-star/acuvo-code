# NEXT — where this stands and what to pick up

> Written 2026-08-13. **Read this before BACKLOG.md** — the backlog is the full
> 84-item audit, this is what actually happened and what is next.
>
> ⚠️ Every `file:line` in either document drifts. Open the line before trusting it.

## State

- Zero runtime dependencies. Public repo is **current and green on a fresh
  Windows clone**, no install step.
- A full 13-task bench run costs **$0.0133** and takes 174s.
- Inventory (modules, test files, suite total) is **deliberately not written down
  here** — see below. Measure it:
  ```bash
  ls lib/*.mjs | wc -l      # lib modules
  ls test/*.test.mjs | wc -l # test files
  node --test test/*.test.mjs # the only honest suite total
  ```

> ── ⚠️⚠️ WHY THE COUNTS ARE GONE RATHER THAN CORRECTED ──────────────────────
>
> This section used to open **"1,757 tests · 1,755 passing · 0 failing. 66 lib
> modules, 96 test files."** Measured 2026-08-14: **78 and 121** — the file was
> understating its own codebase by 18% and 26%. Nothing breaks when a count goes
> stale, so nobody re-checks, and it drifted for a day unnoticed.
>
> ⚠️ **AND THE OBVIOUS FIX — write 78 and 121, then bind them to `readdirSync`
> with a test — WAS BUILT AND THEN DELETED, because it went red inside twenty
> minutes and was RIGHT to.** Three agents work this checkout concurrently; two
> of them added test files while this paragraph was being written, taking 121 to
> 124. The guard would have failed the *other lanes' correct work* and forced
> every agent to edit this document to land an unrelated test.
>
> ⭐ **A check that fails correct work is worse than no check** — this repo has
> paid for that four times — so the defect class is closed the other way: the
> number is not stated, so it cannot be wrong. `test/mcp-catalogue-claims.test.mjs`
> now asserts that nobody **re-adds** a hardcoded inventory count here.
>
> ⭐ **The distinction worth carrying:** bind a number to its noun when the noun
> has ONE owner and changes rarely (the README's tool count → `TOOL_NAMES.length`,
> which is bound and passing). When the noun is a shared, fast-drifting
> inventory, do not state it — publish the command instead.

## ~~⚠️ FIRST JOB: CI has never been green~~ — DONE, the same day this was written

> ⭐ **RESOLVED 2026-08-13 17:40 AEST**, hours after this section was written and
> never struck through. The build log records *"CI is green for the first time in
> the repo's history (1 of 20 runs)"*, then *"CI green 3 for 3 today"*, then
> *"CI green all day after the fix"* — the last two on the same date. So the
> loudest instruction in this document has been pointing the next session at a
> job that was already finished.
>
> ⚠️ **This is the pessimistic-drift failure again**, and it is the more
> expensive direction: a stale *warning* costs a session's attention and tells a
> reader we are broken in a way we are not. Struck rather than deleted, because
> the diagnosis below is the durable part and is worth keeping.
>
> ⚠️ **What I could NOT re-verify from here, said plainly:** this checkout's only
> remote is a local mirror (`127.0.0.1:8088`), so `gh run list` cannot reach
> GitHub and I could not query the Actions API. The evidence above is the build
> log, not a live run. **Re-check before quoting a streak.**

The original diagnosis — it was **test assumptions, not product breakage**:

| where | test | why |
|---|---|---|
| Linux | `lease.test.mjs` · "the same path spelled differently is the SAME lease" | asserts `src\app.ts` aliases `src/app.ts`. On Linux a backslash is a **legal filename character**, so they genuinely are different files |
| both | 7 × `git-commit-containment.test.mjs` | builds junctions/symlinks; CI runners behave differently |

The suite is green on Windows. It has **only ever been verified on Windows** — so
"green on a fresh clone" needs that qualifier until this is fixed.

⭐ A public repo covered in red X's costs more credibility than most of what was
fixed this week. It is the first thing anyone sees.

## Then, in order

**2. Fleet-wide budget.** `DEFAULT_BUDGET_USD` is per RUN. Seven parallel workers
multiply spend by seven. Doing this after the task board would recreate, at 7×,
exactly the per-turn-vs-per-run defect fixed on 2026-08-12.

**3. The shared task board.** The product direction is *seven terminals, seven
workers, one brain, cheap*. Measured — most of it already works:

- 7 terminals at once: works today
- they do not collide: **verified** — `lease.mjs` refused terminal-2 the file
  terminal-1 held, and allowed it a different one. Per path, not per repo.
- cheap: $0.001–0.003 a task
- shared brain: half — `ACUVO.md` and `learned.mjs` are read into every prompt
- **coordination: missing.** Nothing stops two workers taking the same task, and
  none knows what the others are doing.

`plan-ledger.mjs` (600 lines, tracks outstanding deliverables across runs) is most
of the machinery; it is simply not multi-worker. This is the **first genuinely new
capability** on the list rather than another wiring fix.

**4. Terminal-Bench.** No third-party number exists. A 15–20 task subset is ~$0.50;
a full run is $2–4, 3–8h and needs Docker — do that with a human present, not as a
background job.

## The pattern worth carrying forward

Nine defects were fixed on 2026-08-13. **Not one was a missing capability.** Every
single one was something already built and only partly connected:

- `isPolicyProtectedPath` — correct, zero callers, RCE-shaped gap
- `parseAuditLog` — correct, zero callers, so nobody could ask what a run cost
- the credential list existed **twice**, with different contents
- the budget subtraction existed in one path of three
- `gitignoreCoversAcuvo` detected litter nothing removed
- the bundle existed while the README apologised for its absence

⭐ **Reach is the ceiling here, not capability** — and that means estimates of what
this tool can do keep coming in *too low*.

## And the testing rule this week paid for

Four times in one day a check reported green about nothing: a mutation that did not
apply, a mutation that hit prose instead of the code, a probe that refused for the
wrong reason, and an assertion guarded out of existence by `if (x) { assert… }`.

⚠️ **A green test proves nothing until you have seen it go red — and confirm the
mutation LANDED, not merely that the command ran.**
