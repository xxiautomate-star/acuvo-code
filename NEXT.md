# NEXT — where this stands and what to pick up

> Written 2026-08-13. **Read this before BACKLOG.md** — the backlog is the full
> 84-item audit, this is what actually happened and what is next.
>
> ⚠️ Every `file:line` in either document drifts. Open the line before trusting it.

## State

- **1,757 tests · 1,755 passing · 0 failing.** 66 lib modules, 96 test files, zero
  runtime dependencies.
- Public repo is **current and green on a fresh Windows clone**, no install step.
- A full 13-task bench run costs **$0.0133** and takes 174s.

## ⚠️ FIRST JOB: CI has never been green

**All 17 GitHub Actions runs have failed.** Diagnosed, not guessed — it is **test
assumptions, not product breakage**:

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
