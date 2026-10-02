# WHAT NEEDS TO HAPPEN — the one running list

Written 2026-08-16. Consolidates `NEXT.md`, `BACKLOG.md`, `ROADMAP.md`, `MVP-PLAN.md` and
`SHAKEDOWN.md`, which had drifted into five competing views. **Those files keep the
detail; this file keeps the order.** Tick items here.

> ⚠️⚠️ **THE RULE THAT OVERRIDES EVERY DOCUMENT IN THIS REPO.** Roman, 2026-08-14 and
> again 2026-08-16: **BYOK = never — "it defeats the product completely."**
>
> > *"It's like Claude saying it's BYOK. You pay a subscription, not bring in a key."*
>
> **Nothing except a subscription or an Acuvo API key gives access to the model.**
> `BACKLOG.md` still contained a written pricing page whose FREE tier was BYOK-forever and
> whose ENTERPRISE tier was BYOK in a suit; both are struck there now. If you find another
> document proposing BYOK, it is stale — fix it, do not follow it.

---

## A — Makes it a business. Nothing ships without these.

- [ ] **1. The gateway.** A service holding OUR provider key: authenticate the user, meter
      tokens against their plan, refuse at zero, proxy to the provider. Auth + meter +
      proxy — small. Coolify box, not Vercel (cost discipline).
      ⭐ The client half is ALREADY BUILT: `writeAccount`/`readAccount`/`gatewayUrl` in
      `lib/account.mjs`, routing in `lib/model.mjs`, which already states *"BYOK is never
      routed here"*.
- [ ] **2. `acuvo login`.** Device-code flow that writes the account file the CLI already
      reads. ⚠️ Measured 2026-08-16: **no login command exists**, so `mode: 'account'` is
      unreachable and `'byok'` is the ONLY working mode today. That is the whole reason
      BYOK cannot simply be deleted first.
- [x] **3. Off MIT. ✅ DONE — and this line was STALE, which cost something.**
      Verified 2026-08-18: `acuvo-code/LICENSE` is the **Functional Source License 1.1
      (Apache 2.0 Future License)**, `package.json` says `"license": "SEE LICENSE IN
      LICENSE"`, and `npm view acuvo-code` is a **404 — nothing has ever been published**.
      So the deadline this item was guarding ("decide before the first `npm publish`")
      has not passed and the decision was already taken correctly.
      ⚠️⚠️ **AN UNTICKED BOX IS A CLAIM, AND THIS ONE WAS FALSE.** I read it, believed it,
      and told Roman "get off MIT before the first publish" — he replied *"wdym get off
      MIT, what does that mean, i never put us on there."* He was right; I had quoted a
      to-do instead of checking the file next to it. **Verify a checklist item against the
      artefact before repeating it as work outstanding.**
      ⭐ FSL is the right shape and the LICENSE says why: *you may read, audit, run,
      self-host, modify and build a business on top; you may not run a commercial service
      that substitutes for Acuvo Code* — and every version converts to Apache 2.0 after
      two years automatically. That keeps the ENTERPRISE.md "audit all 66,041 lines"
      invitation real, which proprietary would not.
- [ ] **4. Enforce the rule in code** once 1–2 exist: `'byok'` becomes internal/dev only.
      ⚠️ Until then **nobody improves BYOK** — no nicer key prompts, no BYOK onboarding, no
      docs presenting it as a way to use the product.
- [ ] **5. The repo 404 + publish.** `package.json` points at a GitHub repo that does not
      exist (`SHAKEDOWN.md` §1.1), and `npm publish` has never run.
      ✅ `private: true` is NOT set — that earlier claim was wrong; publishing is a smaller
      job than previously written down. ✅ `deepseek` removed from the npm keywords.
- [ ] **6. Replace the free tier** with a trial metered on OUR key — N tasks, expires, no
      provider account. Keeps the usage signal and the customer relationship.

## B — Trust. A stranger's first hour.

- [x] **7. `generate_image` → XXI endpoint.** ✅ **ALREADY FIXED — `SHAKEDOWN.md` §1.5 IS
      STALE.** Verified 2026-08-16 by reading the path rather than the comment:
      `generateThroughProviders` sets `useOwnServer = Boolean(env.PERCHANCE_IMAGE_URL)`, so
      UNSET goes direct to perchance.org via `generateViaNativePerchance`. The XXI Modal URL
      is reached only when someone points at it explicitly. ⚠️ `imageConfig().base` still
      DEFAULTS to that URL, which reads alarmingly on its own — but it is consumed only by
      `generateViaService`, which the default branch never calls.
- [x] **8. Wire `diff-preview.mjs`. ✅ DONE — verified 2026-08-18, and the entry was STALE.**
      The hand-off landed. Traced end to end rather than assumed:
      · `lib/write-approval.mjs` exists and implements BOTH pieces of per-run memory the
        entry said were outstanding — `createdThisRun` (a `Set`, line 56) and
        `sessionApproved` (line 57, set by an `approve-all` verdict at line 105).
      · `turn.mjs:2058` builds it per run with the real `askUser`, and passes
        `approveWrite` + `approveBatch` at `:2908`.
      · `tools.mjs` gates `write_file` (`:1118`) and `edit_file` (`:1173`) through
        `gateWrite`, and the bulk `write_files` batch through `approveBatch` (`:1143`).
      · The other two `executeToolCall` sites (`turn.mjs:1761`, `:3385`) deliberately do NOT
        pass an approver — both run `run_command` only (acceptance + final check) and can
        never write. Not a gap; checked because "threaded through one call site" is the
        defect shape this repo keeps shipping.
      ⚠️ **`evaluate` IS UNGATED ON PURPOSE, and the original "4 of 5" was a design sketch
      rather than a requirement.** It writes `.acuvo-eval-<pid>-<ts>.mjs` at the workspace
      root — a uniquely named file that cannot overwrite anything, registered in
      `pendingSnippets` BEFORE the write and removed by an exit hook. It is a new file at
      `none`/`low` risk, and `auto` only asks at `medium` and above, so gating it would add
      an await to a hot path and change no outcome.
      ⭐ **Recorded because a stale open item has a measured cost:** item 3 ("off MIT") sat
      unticked after it was done, was repeated to Roman as outstanding work, and he had to
      correct it — *"wdym get off MIT, i never put us on there."* Verify against the artefact
      before repeating a checklist item.

  <details><summary>The 2026-08-16 investigation that produced the design (kept — it is
  the reasoning, not a to-do)</summary>

  Built, unreachable. ⚠️⚠️ **THE STATED BLOCKER IS THE
      WRONG BLOCKER — investigated 2026-08-16 and it dissolves.** The entry read: *"it cannot
      hook `workspace.writeFile` while that is synchronous with six sync callers."* Every
      clause is true and the conclusion does not follow, because **nothing needs to hook
      `writeFile` at all.** Measured:
      · There are **5** `executor.writeFile` call sites, not six (`checkpoint.mjs:66` is a
        comment about one). They live in `edit.mjs:412`, `evaluate.mjs:202`, `handoff.mjs:238`,
        `tools.mjs:1022`, `write-many.mjs:127`.
      · **4 of the 5 are reached from `executeToolCall`** (`write_file` direct, `write_files`
        → `writeMany`, `edit_file` → `editThroughExecutor`, `evaluate` → `evaluateSnippet`).
        The fifth, `applyHandoff`, has **no live caller outside its own module**.
      · **`executeToolCall` is already `async`** (`lib/tools.mjs:929`) and is `await`ed at all
        three of its call sites (`turn.mjs:1759`, `:2851`, `:3358`).
      ⭐ So the gate belongs on **the model's door, not in the executor** — which is the rule
      `tools.mjs` already states for the credential guard: *"THE GUARD IS HERE, ON THE MODEL'S
      DOOR, NOT IN THE EXECUTOR … a model-facing refusal pushed down into shared plumbing broke
      seven tests of legitimate internal work."* Approval is a model-facing refusal. Putting it
      in `writeFile` would gate `--doctor`, checkpoint restores and the acceptance harness too.
      ⭐ **And the asking machinery already reaches there.** `bin/acuvo.mjs:79` builds
      `createAsker()`, the turn loop threads it down, and `executeToolCall` already takes an
      `ask` seam — with three consumers on the same `{ ask, isInteractive }` shape
      (`mcp-consent`, `acceptance-consent`, `ask-user`). `diff-preview.mjs` imports only
      `secret-paths.mjs`, so `tools.mjs → diff-preview.mjs` is **not** a cycle.
      ⬜ **WHAT IS ACTUALLY LEFT, and it is one thing:** per-run memory. `executeToolCall`'s own
      comment says it is *"a pure switch over a single call and has no memory of the round
      before it"*, and `approvalDecision` needs two facts that span rounds — `createdThisRun`
      (so the agent revising its own draft is never queried) and `sessionApproved` (the
      `[a]ll remaining` answer). Both are per-run state, so they go where `ask-user.mjs`'s
      allowance already goes: a closure owned by the turn loop, passed in as one more seam.
      Estimate: one new seam on `executeToolCall`, one call before the four write cases, no
      change to `workspace.mjs`, **no async cascade**.
      ⚠️ **NOT LANDED because `lib/tools.mjs` is owned by another terminal right now** (2 of the
      5 baseline test failures are its mid-edit state). Editing it from a second terminal in a
      shared worktree is the exact collision `feedback_two_terminals_one_worktree` records.
      This is a hand-off, not a discovery problem — the design above is complete.
  </details>

- [x] **9. `gh.mjs` sent the token to an attacker-named host.** ✅ 2026-08-16. **The file's
      own comment WAS the vulnerability:** *"GH_HOST and GH_CONFIG_DIR are deliberately NOT
      in the keep-list … the scrub never removed them."* Every clause true, conclusion
      backwards — not being re-added never meant absent, it meant **passed straight through
      from the parent**, while this file hands the child `GH_ENTERPRISE_TOKEN` on purpose.
      ⭐ The directionality defence (*"these tokens already travel to GitHub by design"*)
      holds only while something guarantees which host GitHub IS. Fixed with a DROP-list
      (`GH_ENV_DROP`) plus `ACUVO_GH_HOST`: gh reads `GH_HOST`, which a repo can set, so it
      is always dropped; we read a name `env-file.mjs` forbids a workspace `.env` from
      introducing. Same capability, different trust root. ⚠️ An existing test PINNED the
      hole with a `github.com` fixture, so it could never have noticed. 9 new tests.
- [x] **10. `--json` silently ignored.** ✅ **ALREADY FIXED — `SHAKEDOWN.md` §2.1 IS STALE.**
      `bin/acuvo.mjs:372` now REFUSES with a usage error naming the way out
      (`acuvo --json "<task>"`), rather than accepting the flag and printing a running
      report. ⭐ Refusing is the right resolution, not a lesser one: there is no single
      verdict object for N parallel tasks, so inventing one would be the lie.
- [x] **11. `npm test` was a silent false green in an installed copy.** ✅ 2026-08-16 —
      `scripts/test.mjs`. The old script globbed `test/*.test.mjs` in the SHELL; cmd.exe
      does not expand it, so node matched nothing, ran nothing and exited 0.
      ⚠️ `node --test test/` is NOT the fix — measured on Node 22.17 it resolves `test/` as
      a MODULE and dies. Files are now enumerated with `readdirSync`, and the run FAILS if
      fewer than 500 tests are collected. ⭐ **The total is the only thing that can catch
      this** — a file that fails to COMPILE also contributes zero tests and still reports
      passed. ⚠️ `scripts/` added to the published `files` allowlist; without it an
      installed copy has no runner, a worse regression than the bug.
      📊 **The suite is now measurable: 3,032 tests.**
- [x] **12. The no-key remedy on Windows.** ✅ 2026-08-16, and mostly stale — PowerShell
      *was* already covered (`$env:OPENROUTER_API_KEY = "..."`). The real wart: the
      "keep keys in a file" line was `node --env-file=.env "$(which acuvo)"`, which is bash,
      printed to everyone. ⭐ A remedy that fails on the reader's platform converts "I need
      to set a key" into "this tool is broken" — worse than printing nothing. Replaced with
      the `.env`-beside-your-project form, which acuvo loads on its own.

## C — Capability. All free, all in the CLI lane.

- [ ] **13. ⚠️⚠️ RESPECIFIED 2026-08-16 — THE ORIGINAL ENTRY WAS BUILT ON A FALSE NUMBER.**
      It read: *"pro for planning while the cache is warm (~1.2× flash) … biggest single
      capability lever, and it costs nothing."* **Wrong.** Measured on our own 13-task bench
      2026-08-15: **pro is 6.5–21.8× flash even at 98% cache.** ⭐ Why the cheap cache-read
      does not rescue it: at high cache rates the input is nearly free for BOTH models, so
      the bill is dominated by OUTPUT — where pro is 3.1× dearer and output is **never
      cached**. Always compute the blended per-task ratio; never quote one price column.
      ✅ The related defect is CLOSED: `projectTierCost` now applies
      `modelCostRatio(fromModel, toModel)`, so the ladder no longer projects a pro rung at
      flash prices (it was wrong by ~8×, which made model-escalation structurally dead).
      ⬜ **What is actually open, and it needs Roman:** pro's real ability is UNKNOWN. The
      5/13 bench result was a BUDGET ARTIFACT — every pro failure was 1 round at 0% cache,
      because `DEFAULT_BUDGET_USD = 0.02` affords exactly one cold pro round ($0.0134).
      Re-measuring properly costs **~$0.16**. Until that runs, any phase-routing design is
      guesswork. **← ROMAN'S CALL (money).**
- [x] **14. Make extensibility visible.** ✅ 2026-08-16 — `--help` now documents
      `.acuvo/skills/*.md`, `.acuvo/mcp.json` (naming the five servers it ships knowing
      about) and dropped files. ⚠️ It really was `grep -c -i skill lib/cli-args.mjs` → **0**:
      the whole feature worked and nothing a stranger would read mentioned it.
      ✅ **The second half is now closed too — 2026-08-16.** `lib/slash.mjs` + wiring in
      `chat.mjs` and `bin/acuvo.mjs`. It really was `grep -c "'/'" lib/chat.mjs` → **0**:
      the session understood four words (`exit`/`quit`/`:q`/`bye`) and nothing else, while
      `skills.mjs`, `mcp.mjs` and the budget ledger all worked and were unreachable from the
      prompt. Ships `/help` `/skills` `/mcp` `/cost` `/model` `/clear`, 26 tests.
      ⭐ **`/help` IS GENERATED FROM THE REGISTRY**, because a hand-written command list is a
      second copy and the second copy is the one that goes stale — which is the exact defect
      this item opened with.
      ⭐ **`/skills <name` LOADS, it does not print.** Printing the skill to the terminal would
      look identical from the outside and do nothing, because the model never sees the
      terminal. It is queued and prepended to the NEXT task, used once, and a REACH test
      through the real `runChat` asserts the text arrived at `runOne`.
      ⚠️⚠️ **A LEADING SLASH IS NOT ALWAYS A COMMAND.** `/etc/hosts is wrong, fix it` is a
      task, and a naive `startsWith('/')` would answer "unknown command /etc" and eat the
      user's instruction — a check that fails correct work. The discriminator: one token, no
      second `/`, no `.`. Proven by driving the real binary.
      ⚠️ Discoverability is the point, so an unknown `/skil` names `/skills` (prefix match at
      any length + scaled edit distance), and `/xyzzy` gets **no** suggestion rather than a
      padded list — noise teaches people to ignore the suggestion line.
- [ ] **15. Round ceiling 16 → 64.** `MAX_ROUNDS_LIMIT` in `lib/cli-args.mjs` caps at 16
      while `lib/policy.mjs` already permits 64. ⚠️ **ROMAN'S CALL — a product decision, not
      a benchmark knob.** Measured cost of the current value: Terminal-Bench
      `torch-tensor-parallelism` quit at round 11 of 16 holding a FAILING test.
- [x] **16. `delegate` gets a context channel** and may verify its own work. ✅ 2026-08-16.
      ⭐ **BOTH HALVES WERE ONE OMISSION.** `subagent.mjs` rule 3 governs what comes BACK
      ("distilled, never forwarded") and is right; nobody ever wrote the rule for what goes
      IN, so a helper on a 4-round allowance spent two of them rediscovering what the parent
      had just worked out. `context` is now a schema parameter, folded in by `briefFor`
      (capped at 4,000 chars, trim announced), and it is threaded through the DISPATCHER —
      the step that gets missed, exactly as `depth + 1` was.
      ⚠️ **The old `allowRun: false` reasoning was CORRECT and is kept verbatim in the code:**
      *"the isolated copy has no `node_modules` … a verification run in there would fail for a
      reason that has nothing to do with the code, and the parent would act on that answer."*
      ⭐ That is an argument about the COPY, so the copy changed —
      `runInIsolatedCopy({ linkNodeModules: true })` links the real dependency tree in
      (a junction on Windows, no elevation). ⚠️⚠️ **MEASURED BEFORE WRITING THE CODE:** the
      `finally` block's recursive delete does NOT follow the link — the real `node_modules`
      survives — and a test asserts it, because the alternative was destroying a user's
      dependency tree. `verify` is opt-in, write-only, adds one verb (`run_command`), defaults
      to the full 6 rounds (write→run→read→fix), and an UNLINKED run is reported as
      inconclusive rather than as a red verdict about the code. 20 new tests.
- [x] **17. Compaction's fifth pass.** ✅ 2026-08-16. ⚠️ Tightening (08-13) fixed the FIXED
      clamp plateau and left the floor's SHAPE alone: it is still N × a constant, and the
      constant is **~714 chars** (400 clamp + ~310 marker) — so 200 results floor at ~35,700
      estimated tokens whatever the budget says. A stale result now drops to a one-line
      receipt naming the tool and subject that fetch it back.
      ⚠️⚠️ **It only runs if it would WORK.** The first version ran on any over-budget
      transcript and reddened four existing tests, every one an unreachable budget — there the
      receipt destroyed the last copy of a body AND still reported `underBudget: false`,
      losing twice. The precondition simulates receipting everything eligible and takes the
      pass only if that clears the budget. ⭐ Measured on a 60-read fixture: clamping alone
      floors at **11,871 tokens**; an 8,000-token budget is now reached. 12 new tests, and the
      one that matters is a POSTCONDITION swept over 196 budgets — a mutation that survived
      every fixture broke it at 11 of them.
- [x] **18. Budget projected at round 1**, not discovered at round 6. ✅ 2026-08-16.
      `budget.canContinue()` only ever speaks when REFUSING, which on the default $0.02 lands
      around round 6 — five rounds paid for, work half-done, and the remedy it names costs the
      whole run to take. `forecastRun` + `budget.forecast(maxRounds)` say it after ONE priced
      round, using the same `DEFAULT_BUDGET_USD` and the same `budgetWayOut` sentence.
      ⚠️⚠️ **IT FORECASTS, IT DOES NOT REFUSE.** Hoisting the `would-exceed` stop to round 1
      would be a check that fails correct work: `maxRounds` is a ceiling, not a plan, and most
      runs stop themselves long before it. ⭐ The projected total is also a FLOOR (rounds get
      dearer), which is the safe direction for a caution and the unsafe one for a stop — the
      message says so. 11 new tests incl. a REACH test through the real loop.
- [x] **19. Repo map past 27%** of a real repo, and stop hiding `npm test`. ✅ 2026-08-16.
      ⚠️⚠️ **THE 27% WAS A SYMPTOM AND THE BUDGET WAS NOT THE CAUSE.** Measured on `console/`
      (2,406 files, 360 directories): 659 files listed — **drawn from 7 directories, with ZERO
      files below depth 1.**

          depth 0:   6/  39 · depth 1: 653/1281 · depth 2: 0/482 ← the cliff
          depth 3:   0/ 285 · depth 4+:  0/ 319

      1,610 of the 1,747 omitted files were SOURCE (1,017 `.ts`, 386 `.tsx`).
      ⭐ **The cause was the ORDERING, and its fix is free.** `priority()` sorted strictly by
      depth inside a category, which is a breadth-first cut, which is a depth cliff: the budget
      ran out inside one depth band and everything below it vanished together. **This module's
      header opens by indicting the old pre-read for walking "TWO directory levels" — and then
      threw everything past two levels away at render time, for 6,000 tokens instead of 12 file
      bodies.** The walk was fixed and the ordering quietly undid it.
      ⭐ Replaced with a **breadth sample** (`orderForBudget`): one file per directory per pass,
      within a category. Depth still ranks *within* a pass, so the original comment's intent
      ("the SHAPE of the project survives") is delivered without the cliff. At the **unchanged**
      6,000 tokens: **347/347 source directories, depth 7.**
      ⭐ Budget 6,000 → 9,000 as a second, smaller lever: **28.8% of files, 96% of directories.**
      Defensible on the ground the original number was picked on — still below what the pre-read
      it replaced spent on both trees (9,627 / 10,889) — and it is a **CEILING, not a spend**:
      this repo's 344 files render in 5,656 tokens and cost exactly the same as before.
      ⚠️ **File count stopped tracking the product**, so `stats.dirsListed`/`dirsTotal` were
      added and the regression tests bind to REACH. "659 files" reads as 27% coverage and was
      really 1.9% of the directories; a test pinning a file count would have passed throughout.
      ⚠️⚠️ **`npm test` was hidden by `.slice(0, 6)` on an ALPHABETICAL sort.** On `console/` the
      first six scripts are `bench · bench:all · bench:apps · bench:creative · bench:creative:all
      · bench:creative:selftest` — six spellings of one verb, and `test`, `build`, `lint`, `dev`,
      `start`, `type-check` were **all** cut. A model that cannot see the project's own test
      command cannot verify its work. ⚠️ **We survived by one slot**: this repo has exactly six
      scripts and `test` was the sixth, by luck. Now ranked by verb (`rankScripts`), one entry
      per `:` family, cap 8, and the remainder is **stated** rather than silently dropped.
      📊 10 new tests (repo-map 76 → 86); 8 mutations applied, every one RED — and three of
      them SURVIVED the first draft of the tests, which is how the assertions got fixed:
      "source beats assets" was really measuring DEPTH (the fixture's source file was shallow,
      so deleting the category rule changed nothing), the determinism test could not reach the
      code at all because the walk pre-sorts, and `dirsListed` was asserted on an UNTRUNCATED
      tree where it equals `dirsTotal` whatever the code does.
- [x] **20. ⭐ DROP FILES AND IMAGES INTO THE TERMINAL.** ✅ 2026-08-16 — `lib/dropped.mjs`,
      wired into `userPrompt`, 15 tests. Roman: with Qwen for interpretation, *"people
      should be able to drop images, files, etc into a terminal — that's another feature you
      don't have."* ⭐ The capability was never missing (`read_image`, `read_document`,
      `read_table` all shipped); dropping a file onto a terminal pastes a **path string**
      and nothing looked at it, so a screenshot arrived as an ordinary sentence and the
      model answered about a filename. Handles all four shapes a terminal pastes (Windows
      `"quoted"`, PowerShell `'quoted'`, macOS `backslash\ escaped`, bare), and **existence
      on disk is the entire false-positive filter** — no keyword list, so "update README.md"
      attaches nothing while a dropped path does. Media only: attach what the model CANNOT
      reach itself; it has `read_file` for source. Ceilings on count and bytes, both
      reported out loud. The prompt names the exact tool per file.
      ⬜ **Not yet proven end to end with a real screenshot through a live model.**

## D — Evidence. The viral asset.

- [ ] **21. Re-smoke the 2 benchmark tasks** against the truncation fix. Cents. The first
      real before/after measurement of a harness change we would ever have.
- [ ] **22. The scoring run + a Terminus 2 control.** ⭐ **The DELTA is the product.** A lone
      score is a DeepSeek advertisement with our name on it; the same model through the
      reference harness versus through ours is the only number that is about US.
- [ ] **23. Publish with cost per task**, and disclose `--shell` and the 600s timeout up
      front. Consider publishing BOTH the default-safe and `--shell` numbers — "our safety
      default costs us N points" is a claim nobody else makes and cannot be attacked.

---

## ✅ Closed 2026-08-16

- **The benchmark pipeline runs at all.** Install, model, rounds, file writes, verification
  and checkpoints all worked for the first time — every prior attempt died in setup with an
  empty denominator. 2 trials, $0.0064 total.
- **Truncation is no longer treated as completion.** `finishReason: 'length'` now triggers a
  bounded continuation; if exhausted the run stops as `'truncated'`, and `OUT_OF_ROAD`,
  `sessionFailed` and the bare-literal assignment convention were all updated with it.
  ⚠️ Missing any one would have silently disabled something — the escalation ladder has now
  been disabled three separate times by a stop reason it did not know about.
- **The cost column works.** The adapter read `usage.cost`; the CLI emits `costUsd` +
  `cache.promptTokens`. Every trial had reported cost UNKNOWN while the data sat in the file.
- Items **7, 9, 11, 14, 20** above.
- `README.md` tool count 52 → 53; `ENTERPRISE.md` 100 → 101 files, 66,041 lines, 184 tests.

## ⚠️ Known red, NOT ours (another terminal has `lib/tools.mjs` + `lib/lsp.mjs` open)

`wiring-reach` reports 9 modules reachable from no entry point — `code-review`, `completion`,
`db-inspect`, `diff-preview`, `gh`, `log-tail`, `plan-coherence`, `python`, `rcfile` — plus
4 tool/doctor/LSP failures. ⭐ `lib/dropped.mjs` is ABSENT from that list, which is how its
wiring was confirmed. Do not "fix" these blind; they are mid-edit somewhere else.

---

## STATUS - 2026-08-23 (append here; never rewrite history above)

### Shipped today, verified live
- **acuvo-code 0.6.16** - auto-update had NEVER worked on Windows. `spawn('npm.cmd')`
  throws EINVAL on Node 22 (CVE-2024-27980 fix); the throw was caught and the user was
  silently told to type the command instead. So the fallback WAS the behaviour.
  WARNING: everyone on <=0.6.15 carries the broken updater and must update ONCE by hand.
- **acuvo-code 0.6.17** - the four creative verbs had NEVER worked. FIVE stacked breaks,
  each fatal alone: (1) secret sent as an `authorization` header, endpoints read the BODY
  (2) `reference_b64` vs `reference_audio_b64` (3) 30s timeout shorter than a 75s cold
  start (4) voice services are SYNCHRONOUS and we assumed async, so a finished render was
  discarded for having no callId (5) artifact key is `audio`, not `audio_b64`.
  Verified end-to-end against the live GPU.
- **Face/voice/character-lock priced from MEASURED GPU cost** - face 14cr/video-second,
  clone 22cr/min, design 80cr/min (3.7x clone, measured not assumed), lock 2cr. All at
  >=90% margin. The free tier could reach all four ($0.17 exposure); gated, back to $0.
- **The Modal fleet connected** - 24 apps deployed, only 12 had a URL. Added 13 env vars
  to Vercel + local. LIVE 10 -> 19, UNSET 9 -> 0.
- **lib/creative-charge.ts** - one priced choke point plus an EXACT-match coverage guard.

### NOT DONE - the honest list
1. **Five GPU paths still spend for FREE** (named in creative-charge.test.ts PENDING):
   studio-poll-provider, studio-run-generic, videogen, app-speak/[token],
   integrations/[tenantId]/face/animate.
2. **character_lock has NO CLI verb** - live on Modal, credit-priced, unreachable.
3. **GPU_GATEWAY_URL is SET in production and returns 404** - a pointer to something never
   deployed. Deploy it or remove the variable.
4. **Top-ups grant ZERO coding tokens.** Agreed rate: A$1 = 3M coding tokens / 60 credits.
5. **Pay-as-you-go** - not built.
6. **"Build tokens" rename** - Roman prefers it to "code tokens", because the pool is
   anything that spends DeepSeek: CLI *and* builder. Not done.
7. **The clean publish repo** - public repo sits at 0.3.1 while npm ships 0.6.17, with
   0 stars / 0 forks / 0 issues. Nothing to preserve. Blocked ONLY on Roman's go, because
   force-replacing public history is irreversible.
8. **Free research provider (SearXNG / DuckDuckGo)** - not built. Perplexity has NO free
   API tier; a self-hosted SearXNG gives the same grounded corpus at $0.
9. **Builder verb parity** - the builder has ~31 verbs against the CLI's 68.

### Benchmark - a lesson, not a score
WARNING: the 3.5h / 60-task run was INVALID. `dist/acuvo.mjs` was dated Aug 20 and
contained ZERO occurrences of `looksLikeVerification`. The bench runs a PREBUILT BUNDLE, so
it measured three-day-old code and scored 0/60 - failing with exactly the early-stop bug
that had been fixed hours earlier.

PROOF THE FIX WORKS: rebuilt, and adaptive-rejection-sampler went from 4 rounds ->
"verified" to 32 rounds -> round-cap. It stopped lying about being finished.

WARNING: MAX_ROUNDS was 16 because that WAS the CLI's ceiling; it is now 64. The bench was
running the agent at a QUARTER of its available horizon - contradicting its own comment
that a round cap "is a BUDGET, not a difficulty setting". Raised to 32, not 64, because the
DeepSeek balance is $1.25 and a run that dies at task 70 produces no score at all.

RULE, ADD TO THE PRE-FLIGHT: rebuild `dist/acuvo.mjs` and grep it for the fix you are
testing BEFORE starting any scored run.

### CORRECTION 2026-08-23 — GPU_GATEWAY_URL is NOT dark

Item 3 above said "GPU_GATEWAY_URL is SET in production and returns 404 - deploy it
or remove the variable." **That was wrong, and acting on it would have broken the
working face path.**

`gpu/modal/face_gateway.py` uses `@modal.asgi_app()`, not `@modal.fastapi_endpoint`.
An ASGI app mints ONE URL with ROUTES underneath, so its root legitimately 404s.
The real doors — `/health`, `/synthesize`, `/animate` — all answer **401
unauthorised**, which in this fleet means a live service refusing an
unauthenticated request. The creative bench confirms it independently:
`talking-head PASS 116.3s, 154259 bytes, 5.3s via gpu-gateway`.

RULE: a 404 at the ROOT proves nothing. Probe a service's declared routes.

---

## STATUS — 2026-09-01 · MVP item 1, the ROUTING half of "caching even when models switch"

### The defect, measured before it was fixed

`turn.mjs` learned a round's warm upstream against **`config.model`** — the model
the user CONFIGURED — while `chain.mjs` is free to answer from a different one.
Driven through the real `runSession` with a scripted chain, $0.00:

    configured  deepseek/deepseek-v4-flash-0731   pin: DeepInfra, Ambient, Relace
    answered    z-ai/glm-4.6                      pin: Venice, DeepInfra
    served by   DeepInfra
    ~/.acuvo/warm-providers.json -> {"deepseek/deepseek-v4-flash-0731":"DeepInfra"}
    routeFor(configured)         -> {order:["DeepInfra"], strict:true}

⚠️ **`DeepInfra` is in BOTH models' pin lists, which is why the existing guard
could not see it.** `rememberWarm`'s membership check asks "is this an endpoint we
chose and priced for this model" — it is — not "has it ever served this model's
prefix", which it had not. The next round therefore asked for it with
`allow_fallbacks: false`, against a cold cache, with the fallback removed. And
`saveWarmth` writes under `$HOME`, so one stray fallback round governed every
workspace on the machine until something FAILED.

⚠️ **The loss was double.** The model that actually answered — the one the rest of
the session keeps using — learned nothing, so every later round re-routed on the
preference list.

⚠️⚠️ **A GUARD WAS PINNING IT.** `warm-provider.test.mjs`'s reach test asserted
`rememberWarm(warmth, config.model, reply.provider)` **verbatim**, i.e. it
required the defect. Rewritten to pin the rule instead.

### What landed

- [x] **Warmth is keyed on the model that ANSWERED.** New pure `learnFromRound`
      in `warm-provider.mjs`; `turn.mjs` calls it. On a switch the configured
      model's pin is FORGOTTEN (it was asked and did not reply) and the answering
      model learns its own.
- [x] **The persisted warmth now EXPIRES — the third property, finally closed.**
      That file's own header lists three things that made the Novita incident
      permanent and only two were fixed; the third, quoted, was *"There is no TTL,
      so it outlives the reason it was learned."* `seenAt` + `pruneStale` +
      `WARMTH_TTL_MS = 6h`, because the same header says a prefix cache lives
      upstream "minutes to hours" — past that the entry is evidence of
      REACHABILITY, which does not justify `allow_fallbacks:false`. An UNSTAMPED
      entry (every file written before this) is dropped: unknown age must resolve
      the safe way. Cost of the migration: one cold round, once, per machine.
- [x] **The silent model downgrade is no longer silent.** `chain.mjs` has returned
      `usedFallback` since it was written and `grep -rn usedFallback lib/ bin/`
      had **zero consumers** — the promise in its header (*"a silent downgrade …
      is the dishonest version of this feature"*) was kept in a field nobody read.
      Now: a gold `model-switch` line on screen (once per model, not per round), a
      `modelsAnswered` array in `--json`, and a summary warning. ⚠️ `model` still
      means "requested" — redefining an existing key is worse than the omission.
- [x] **The provider counters account for every round.** Found on a LIVE run, not
      by the suite: `rounds 4`, `served {DeepInfra:3, StreamLake:1}`,
      `pinTook 3 / pinFellBack 0 / pinMissed 0 / roundsUnknown 0`. Three of four.
      The missing round was a chain fallback to a model with no pin table, so it
      carried no pin, `pinOutcome` said `'none'`, and no counter existed.
      `roundsUnpinned` is that round — and it is a COLD one. The five counters now
      sum to `rounds` and a test asserts it. ⚠️ `toJson` hand-lists the provider
      fields, so the counter had to be added TWICE; the second copy is the one
      that goes stale, and the README guard caught exactly that.

### ⬜ The biggest remaining cache gap — and it is NOT ours

Five consecutive live runs in one workspace, same model, same pinned upstream,
same deterministic sticky key:

    run  round-1 cached / prompt   round-1 rate   session cache   cost
     1        0 / 12,208               0%            47.6%       $0.00506
     2        0 / 10,143               0%            73.2%       $0.00149
     3    5,632 / 10,139            55.5%            82.1%       $0.00098
     4        0 / 10,230               0%            64.5%       $0.00129
     5        0 / 10,136               0%            63.8%       $0.00140

⭐ Run 3 proves the cross-run mechanism REACHES THE WIRE: it opened with
`pin: ["DeepInfra"]` (the strict warm pin, learned from run 2) and read 5,632
cached tokens on round one — the first time round one has ever been warm.
⚠️ And it is INTERMITTENT: 1 of 5. Our half is pinned — the bytes are asserted
byte-identical across models, the upstream is pinned strict, the sticky key is a
hash of the cwd and therefore stable across processes. The eviction is
DeepInfra's. `warm-provider.mjs` says round one "only has to be cold ONCE, ever";
measured, it is cold about 80% of the time. **That is the ceiling on Roman's
"high 90s", and no change in this repo moves it — it needs a provider
conversation or a second measured endpoint.**

---

## STATUS — 2026-09-01 (later) · "the caching staying", measured rather than inferred

### ⚠️⚠️ I RETRACT THE EARLIER CONCLUSION ON THIS PAGE

The block above says the round-one gap is *"provider-side … nothing in this repo
moves it — it needs a provider conversation."* **That was wrong, and it was
inference dressed as a finding.** Pushed on it with a fixed-byte probe against
the live API and the eviction story collapsed:

    fixed payload, one session_id, DeepInfra, cached / prompt tokens
      prime      0 / 7,991     0.0%
      +10s   7,680 / 7,991    96.1%
      +60s   7,680 / 7,991    96.1%
      +120s  7,680 / 7,991    96.1%
      +240s  7,680 / 7,991    96.1%
      +300s  7,680 / 7,991    96.1%
      +600s    256 / 7,991     3.2%   <- NOT eviction: see +1200s
      +1200s 7,680 / 7,991    96.1%

**The prefix survives at least 20 minutes.** The single low reading at +600s came
back to 96.1% ten minutes later on the same key, so it was a FLEET ROUTING MISS —
a request landing on a machine that did not hold the prefix — not a TTL. Roughly
1 probe in 7 missed that way.

### ⭐⭐⭐ THE REAL CAUSE OF A COLD ROUND ONE, AND IT IS OURS

Captured the exact wire body for two different tasks in one workspace ($0, fetch
stubbed):

    task 1  -> 25 tools   system 17,283 B   headSha 7372bc…
    task 2  -> 34 tools   system 17,317 B   headSha da203c…

**The tool shortlist changes with the brief, and the system prompt NAMES the
offered tools inline.** The two system messages diverge at **byte 1,171 of
17,283 — 6.8% in** — on one conditional example clause:

    task 1: "…batch every read that does not depend on another: several read_file
             calls together, search_text AND find_files together."
    task 2: "…batch every read that does not depend on another: git_status AND
             git_diff together, several read_file calls together, …"

Rendered head (system + tools) shared prefix: **1,171 of 48,194 = 2.4%.**
That is why five consecutive real runs read round-one cache 0 / 0 / 55.5 / 0 / 0%.

⭐ **The tools ARRAY is already cache-friendly** — task 1's 25 schemas are a byte
prefix of task 2's 34 (22,890 of 22,891 bytes shared). Only the prose is out of
order.

⬜ **THE FIX IS AN ORDERING CHANGE AND NOTHING ELSE**, which is this repo's own
doctrine. Simulated at $0 by rebuilding both prompts with the shortlist-dependent
lines moved out of the system message and into the user turn (already the varying
tail — proven safe: a probe with a CHANGED tail still read 7,680 cached):

    today                                   3.4% of the head shared
    conditional prose moved to the tail    41.6%   (+13,163 bytes per round one)

⚠️ **NOT LANDED, DELIBERATELY.** It touches `loopSystemPrompt`, 8 test files and
15 assertions, it changes what the model reads, and 0.6.19 shipped hours ago. It
is a behaviour change, not a reliability fix, so it wants its own pass with the
`offered ⟺ named-in-prompt` invariant re-proven. Worth doing next; the number is
measured, not guessed.

### 💰⭐⭐⭐ TWO OF THE THREE PINNED ENDPOINTS RETURN NO CACHE AT ALL

Byte-identical 31,341-byte payloads, sent twice 90 s apart, same `session_id`:

    provider     1st     2nd      cost per send
    DeepInfra    0%    96.1%    $0.000640 -> $0.000148
    Ambient      0%     0.0%    $0.000640 -> $0.000640
    Relace       0%     0.0%    $0.000529 -> $0.000529

⚠️ **The COST is the proof.** A provider that cached but did not report
`cached_tokens` would still bill less on the second send. These billed the same to
the cent. So flash's pin `['DeepInfra','Ambient','Relace']` has one endpoint that
caches and two that never will — and a fallback there is not "one cold round at
4.6x", it is **full input price for the rest of the run**: DeepInfra warm
($0.000148) is **3.6x cheaper than Relace ever is** and 4.3x cheaper than Ambient.

Recorded as data in `model.mjs` (`CACHE_MEASURED` / `providerCaches`), and the run
now SAYS SO when it lands on one. **Repinning is Roman's call** — provider choice
is recorded here as the largest single margin lever and his decision, and a
two-name pin is one outage away from being single. It wants a wider sample than
two sends per endpoint.

### ✅ Our half of the contract is clean — verified at the request level

    round 1  session_id=acuvo-f6ee…  provider={"only":["DeepInfra"]}  toolsHash=eaf3db048c
    round 2  session_id=acuvo-f6ee…  provider={"only":["DeepInfra"]}  toolsHash=eaf3db048c
    round 3  session_id=acuvo-f6ee…  provider={"only":["DeepInfra"]}  toolsHash=eaf3db048c
    round 4  session_id=acuvo-f6ee…  provider={"only":["DeepInfra"]}  toolsHash=eaf3db048c
    rounds missing session_id: 0 · clause shapes used: only

`only`, never `order` — the sticky-preserving form. And the round-one body is
byte-identical across two separate processes (same sha256).

---

## STATUS — 2026-09-01 (later) · the suite that failed a different test every run

**It was never "Windows load flakiness". That was my inference and it was wrong.**
Two separate bugs, both named, both fixed, and the suite is now GREEN:
**5,532 tests, 0 failures** — the first clean full run in five attempts.

1. **`bundled-skills-are-reachable` was asserting on the machine's health.** It
   ran `--doctor` through `execFileSync`, which THROWS on a non-zero exit, and
   `bin/acuvo.mjs` returns `EXIT_FAILED` from `--doctor` whenever
   `summary.broken > 0`. So a test about **what is inside the bundle** failed
   because of a media endpoint answering HTTP 400 or a probe timing out.
   Reproduced DETERMINISTICALLY — `env -u ACUVO_HOME node --test <file>` fails
   every time (6 broken media checks against the real home). It looked random only
   because `scripts/test.mjs` hands the run a throwaway `ACUVO_HOME`, which turns
   the credential-dependent checks `dark`, leaving the transient network ones to
   flip it. It now reads stdout regardless of exit status and asserts on the
   tool-count line, which is the actual claim. Both mutants red.

2. **`repo-index`'s real-filesystem test was asserting a timestamp coincidence.**
   Its premise, in its own sibling comment, is that *"`utimesSync` rounds to whole
   milliseconds while NTFS keeps 100ns ticks"* — a property of the CLOCK. When the
   original `mtimeMs` lands exactly on a millisecond boundary the restore
   round-trips exactly, and because the two bodies are deliberately the same 22
   bytes the fast path is then CORRECTLY reporting a hit — the documented
   same-tick hole — and the test called it a failure. Measured 500 samples at idle
   and under CPU load: 0 exact round-trips, so the window is narrow, which is
   precisely what made it a rare random red. It now reads the precondition and
   makes a real claim in BOTH branches, including that `verifyIndex` still catches
   the stale entry.

⚠️ **Neither was order-dependence, a shared temp path, or a port collision.** Both
were tests asserting on the wrong signal.

### 💾 And a real production bug found while looking

`saveWarmth` used a plain `writeFileSync`, which truncates then fills.
`~/.acuvo/warm-providers.json` is machine-global and every `acuvo` writes it;
CLAUDE.md's documented working shape is 2–3 terminals at once. Measured — six
writers, one reader:

    before:  17,775 reads · 5,343 UNPARSEABLE · 30.06%
    after:   20,827 reads · 0 torn

⚠️ **The symptom is silence.** `loadWarmth` catches the parse error by design, so a
torn read is not an error — it is **cross-run warmth switched off**, which costs
the entire round-one cache (96.1% -> 0%). Now write-then-rename. Mutating it back
reproduces 29.3%.

### 🔁 The second-copy class, closed

`toJson` hand-listed the provider fields, so `roundsUnpinned` reached the outcome,
the summary and the audit record while `--json` silently dropped it. The fields
are now declared ONCE (`PROVIDER_REPORT_FIELDS`) and projected in a loop, and a
test asserts that the published set and what `aggregateProviders` produces are the
same set. Adding a counter to the producer alone now turns the suite red.

### 🔎 The wrong-subject sweep

Swept `lib/` and `bin/` for the shape that started all this — a REQUESTED value
used where an OBSERVED one was meant. Landed the smallest: `saveSession` wrote
only `model` (the requested id), which also made `replay.mjs`'s
`auditInfo?.model?.answered` fallback DEAD CODE, so every replay header named the
model that was asked for. The record now carries `answeredModel` + `modelsAnswered`
and replay prefers them. Remaining candidates are listed in the session report —
the ones touching money are `escalate.mjs`'s tier projection and `refute.mjs`'s
independence check.
