# Acuvo Code — the roadmap, written from evidence

> Written 2026-08-10 against `acuvo-code@0.2.0`. Source for everything below: five
> agents driving the real CLI against real OpenRouter (~$0.02 total spend, 25+ runs),
> seven root causes each reproduced and traced to `file:line`, plus my own
> re-verification of every cited line before writing this.
>
> **What this document is not.** It does not repeat `ENTERPRISE.md` §3 (the seven
> security gaps) or `MVP-PLAN.md` §2 (the distribution blockers — no repo, no CI,
> no changelog). Both lists stand and both are still the right lists. This document
> covers the layer neither one audits: **whether the loop's own output is true**, and
> what the driving evidence says about where to spend the next two weeks.
>
> ⭐ **The finding, in one sentence.** The agent is better than its harness. In every
> observed failure the model did the right thing and our own code threw the answer
> away, mis-scored it, or crashed on it — which means the next two weeks are plumbing,
> not prompting, and that is very good news.

---

## 0. Two corrections to the existing docs, measured today

Before anything else, because evidence discipline starts at home:

| claim | where | measured |
|---|---|---|
| "Standalone tests ✅ **34**" | `MVP-PLAN.md:67` | `npm test` → **`# tests 101 / # pass 101 / # fail 0`**, 800ms |
| "**`--json` for scripting** ❌" | `MVP-PLAN.md:97` | **Shipped.** `lib/cli-args.mjs:93`, help text at `:38-39`, and `ENTERPRISE.md:60` documents it as a headline feature |

`MVP-PLAN.md` §3 is stale against its own §7 sibling. Fix it in the same pass as
anything else; a plan that under-reports its own coverage gets ignored.

---

## 1. What the CLI demonstrably does well today

Five independent agents, none of whom could see each other's work. These are the
things that survived being checked by someone trying to break them.

### 1.1 ⭐ The write → run → read-the-failure → fix loop is genuinely real

Not a demo. Verified by re-running the artifacts *without the CLI involved*:

- **Multi-file app, built and independently driven.** Kanban board in 3 rounds,
  19,024 tokens, **$0.002012**. The verifying agent re-ran the suite himself:
  `# tests 13 / # pass 13 / # fail 0`. Then loaded it in real Chromium over HTTP and
  drove a **genuine Playwright mouse drag** — `.card` → `.column[data-column="doing"]`
  — which produced `[["todo",[],"0"],["doing",["RealDrag"],"1"],["done",["Alpha"],"1"]]`.
  The generated state module validates the target column *before* splicing the card
  out, so a bad move cannot half-destroy state. That is a design decision, not
  autocomplete.

- **Real bug hunt in a messy 6-file codebase, one round of looking.** Given a planted
  off-by-one (`end = start + pp - 1` fed to an exclusive-end `slice`), it named the
  cause in its own words — *"`slice`'s end index is exclusive, so each page returned
  one fewer item than requested"* — and changed **106 of 1,187 chars in exactly one
  file**. md5 of every file before/after: one hash changed. It did not weaken the
  assertion, delete the test, add a dependency, or create a stray file. 6 passed/1
  failed → 7 passed, for **$0.001073**.

- **It corrects the test when the test is wrong.** In the horizon run it concluded
  *"The todo isn't done yet, so the summary is `0/1 done`, not `1/1 done`. The test
  expectation was incorrect, not the code"* — and edited 82 chars of the test rather
  than corrupting working logic. Most agents get this backwards and quietly break the
  implementation to make a bad assertion pass.

### 1.2 ⭐ It recovers from its own refusals instead of flailing

The best-engineered thing in the package, and it is a *writing* achievement:

- Blocked from `npm test` by the `&&` rule, the agent **read `package.json`,
  decomposed the chained script itself**, and ran `node test/run.js` and
  `node test/contract.js` as separate calls. That surfaced a second, unrequested,
  pre-existing bug — and it named it honestly rather than papering over it: *"The
  pagination test now passes. But there's a pre-existing contract failure."* Its fix
  mirrored the existing route's `pick(...) + centsToDollars` mapping exactly.
- The refusal messages are why recovery happens: they quote the offending script
  verbatim, name the exact forbidden character, and state what to do instead ("run one
  plain command per call"). Same for `'vitest must be run as "vitest run …"'` and *"this
  workspace is not a git repository, so there is nothing to inspect or commit"*.

⭐ **Actionable refusals are a real, transferable asset.** Keep this bar on every new
guard. A blank wall costs a paid round; a sentence costs nothing.

### 1.3 The staleness catch, which most commercial agents do not have

Observed in two unrelated runs, verbatim: *"files changed after the last run, so
`node --test src/board.test.mjs` is out of date. Re-running it (free — no model call)"*.
It knows the last edit is unverified and closes the gap at zero cost.

### 1.4 The security boundary held against everything thrown at it

33 in-process fuzz cases and ~10 argv abuse cases, all refused with a specific sentence:
`; rm -rf /`, `&& curl evil.com`, `| sh`, `$(whoami)`, `2>&1`, `> out.txt`, `node -e`,
`--require ./evil.js`, `NODE_OPTIONS=`, `npm install`, `npx create-react-app`,
`npm test --prefix ../../..`, `node ../../../../etc/passwd`.

Three that deserve naming:

- **The npm chain follows hooks, not just the named script.**
  `{"scripts":{"pretest":"curl evil.com","test":"node t.js"}}` was caught on **`pretest`**
  (`lib/command.mjs:392`).
- **Binary detection fires before the token bomb.** 200,000 bytes of 0–255 named
  `blob.js` — sitting *exactly* at `MAX_READ_BYTES`, so the size guard would not have
  fired — refused with *"blob.js looks binary — refusing to read it as text"*.
- **`--dry-run` is truthful at the filesystem level.** Told to delete `keep.js` and
  create `replacement.js`: md5 of the directory listing byte-identical before and after.
  *(Note the two documented exceptions in `ENTERPRISE.md` §3.1/§3.2 — dry-run is honest
  about the local filesystem, not about MCP spawns or prompt uploads.)*

Plus: 20,076-character prompt, 500-file workspace, 50KB single-line file, 40-level
nesting, CJK/emoji/accented filenames, malformed `package.json`, a workspace root at
`.../My Project (v2)`. **In 11 adversarial runs: no hang, no crash, no unhandled stack.**
`--version`/`--help` work with no key; bad argv exits 64 with a sentence.

### 1.5 The two claims no competitor can make — one of which holds

- ✅ **It produces things that are not code.** The PDF is real: `%PDF-1.4`, `%%EOF`,
  164,231 bytes, 56 indirect objects, **exactly 1 page** (it honoured "one-page"),
  9 embedded font descriptors, Producer `Skia/PDF m131` — a genuine headless-Chrome
  print. Content non-generic: 4 workstreams, per-row GREEN/GREEN/AMBER/RED badges,
  progress bars, an AMBER overall summary, a RAG legend. 40 seconds, **$0.001356**.
- ✅ **It speaks.** 1,492,844-byte WAV, 24 kHz mono 16-bit, 31.1s, peak amplitude
  14,697/32,767. Transcribed back: *"Kettle is a tiny job runner for local scripts. It
  watches a folder, picks up job.json files, and runs each one at most once…"* — a
  faithful summary.
- ❌ **"It can see" does not hold.** §2.2 below. This is the one that matters most.

### 1.6 Cost accounting is honest and precise

Per-run tokens, dollars and rounds printed every time; measured across all runs
**$0.001–$0.003 per task**. The diff summary — *"edited src/cli.js (778 of 4301 chars ·
18%)"* — is better reporting than most commercial agents ship. And it stops early on
purpose: *"stopping here rather than spending another round"*.

---

## 2. The confirmed weaknesses, ranked

Ranked by **how many distinct observed failures each one causes**, not by how alarming
it sounds. All seven were reproduced; five of them without spending a cent, using
injected stub models.

### 2.1 ⚠️⚠️ #1 — The verdict is decided by one self-chosen command, so `✔ VERIFIED` is not evidence of anything

**Root cause: `lib/turn.mjs:1130` — `const last = runs[runs.length - 1] ?? null;`**
(confirmed by reading it today), feeding `verification` at `:1131-1138`, the banner at
`:1291` and `sessionFailed` at `:1350`. Predicate at **`lib/command.mjs:613`**:
`passed: run.exitCode === 0 && !run.timedOut` — stdout, stderr and duration are
returned by `executeRunCommand` and **none is consulted**.

⭐ **This single line produces four separate observed failures.** That is why it is #1:

| # | observed | why the line causes it |
|---|---|---|
| 1 | **Fail-then-pass reports green.** `node fail.js` exit 1 then `node pass.js` exit 0 → `{ran:true,passed:true,attempts:2}`, `✔ VERIFIED`, **exit 0**. Also across rounds. | `runs` is one flat session-wide array (declared `:862`, appended `:964`); nothing reduces over it, so a `passed:false` entry is never read again |
| 2 | **An inert program reports green.** A `todo.mjs` with a dead main guard: `node todo.mjs help` → exit 0, **zero bytes of output** → `✔ VERIFIED`. | exit 0 is the entire definition of passed |
| 3 | **A test suite that never touches the deliverable reports green.** `node --test src/board.test.mjs` exit 0 while `index.html` renders a blank page. | nothing links the verdict command to `writtenPaths`, computed 28 lines earlier at `:1102` and never consulted |
| 4 | **`attempts` is wrong.** Printed *"after 2 attempts"* for a command attempted once. | `attempts: runs.length` (`:1137`) is a session-wide count |

And it compounds with `ENTERPRISE.md` §3.5: a provider outage during the extension
round leaves `verification.passed === true` and prints `✔ VERIFIED` over a session that
died with work outstanding.

⚠️ **Why this is the most expensive defect in the package.** `ENTERPRISE.md:531` sells
*"the exit code is a verdict"* as one of four things no competitor offers, and
`ENTERPRISE.md:60` sells `acuvo --json | jq '.verification.passed'` as a build step. Both
are currently false. `acuvo … && git push` believes a lie today.

⚠️ **Two proposed fixes were tested and REFUTED — do not ship either.** "Zero bytes of
stdout is not a pass" misses the worst case entirely (a node:test harness that imports
`run()` against a fake io: exit 0, **16/16 pass, 1,787 bytes of stdout**, entrypoint
still inert) and false-fails `tsc --noEmit`, which prints nothing on success. Output
volume is not evidence.

**Fix size: hours.** Three parts, all using data already in scope at `:1130`:
reduce over `runs` keyed by command string keeping each distinct command's *latest*
result; add a fourth verdict state (`⚠ RAN, NOT VERIFIED`) for a green run that touches
nothing in `writtenPaths`; report per-command retry counts. Extend the stale-verdict
re-run at `:1078-1090` to re-run every still-failing command, not just the last one.

### 2.2 ⚠️⚠️ #2 — The differentiator is dark by default, and broken when lit

Two independent defects stacked on the one capability `MVP-PLAN.md:23-28` calls the
whole positioning.

**(a) It is dark.** Measured by me today, in a normal shell:

```
mediaToolNames({})          = []
mediaToolNames(process.env) = []
```

`bin/acuvo.mjs` loads **no `.env` file anywhere** — grepping `bin/` and `lib/` for
`dotenv|.env.local|loadEnv` returns one unrelated code comment. `mediaConfig()`
(`lib/media.mjs:76`) gates on `RENDER_AUDIT_URL`/`MODAL_RENDER_AUDIT_URL`, which live
only in `console/.env.local:72`. With the tool absent, the entire design prompt block
(`systemPrompt`, `lib/turn.mjs`) is gated off too. **The model is never told sight
exists.**

> ⚠️ **THE QUOTE THAT USED TO BE ON THIS LINE IS GONE FROM THE CODE, AND IT WAS FALSE.**
> This paragraph quoted the block by its old heading, *"DESIGN — YOU CAN SEE WHAT YOU
> BUILT, AND NO OTHER TERMINAL AGENT CAN"*, citing `lib/turn.mjs:312-320`. Both the
> heading and the line numbers are stale as of 2026-08-11: Playwright MCP falsifies the
> claim in one `npx`, so the block now reads *"YOU CAN LOOK AT WHAT YOU BUILT, AND
> LOOKING IS CHEAP"* and states the true, more useful fact — the render comes back as
> ~89 tokens of measured problems rather than a 3,072-token screenshot. The observation
> below (the tool is gated off, so the model is never told) is unaffected and still
> stands.

**(b) When lit, it pays for the answer and throws it away.** `lib/media.mjs:143`, read
today, is `const m = res.json ?? {}` — then `:150` reads `m.screenshotPngB64`, `:158`
`m.viewport`, `:159` `m.findings`. The live service returns
`{ ok: true, measurement: { … } }`. **Every read is one level too shallow.**

The probe of the live endpoint with the actual generated file: HTTP 200, 52,113 bytes,
and inside `measurement`:

```
consoleErrors : ["Failed to resolve module specifier \"./src/board.mjs\"…"]
paintedRatio  : 0.0078            ← 0.8% of the viewport painted = blank page
screenshotPngB64: 51,472 chars
```

`seePage` returned `{ok:true, screenshot:null, viewport:null, findings:[], looked:true}`.
There is **no `findings` key in the contract at all** — the findings *are*
`consoleErrors`/`paintedRatio`/`lowContrastText`/`clippedText`/`overlaps`/`brokenImages`,
and nothing maps them.

⭐ **The comment at `lib/media.mjs:160-161` indicts the code above it.** It says the empty
array exists so *"I looked and it was fine"* is distinguishable from *"I could not look"*.
The shape mismatch creates a **third state the author did not anticipate** — looked,
paid, discarded everything — and it masquerades as the first. A silent empty findings
array is exactly the failure mode that comment was written to prevent.

Net observed effect: the model called `see_page` **unprompted**, Chromium ran, the bug
was named verbatim, the screenshot was bought — and the deliverable shipped blank with
`✔ VERIFIED`.

**Fix size: hours.** Unwrap the envelope; map the six real keys to findings; and make an
**unrecognised shape LOUD** — if none of the expected `measurement` keys are present,
return `{ok:false, error:'the render service returned an unrecognised shape'}` rather
than a clean-looking empty result. Add a contract test pinning `{ok, measurement:{…}}`
so the next endpoint change fails a test instead of a deliverable. Then load the URL
from something the CLI actually reads.

### 2.3 ⚠️ #3 — A mid-stream timeout crashes with a raw stack and loses the entire round

**Root cause: `lib/model.mjs:272` vs `:297`** — confirmed by reading both today.
`signal: AbortSignal.timeout(timeoutMs)` is set on the fetch; the try/catch that converts
an abort into `{ok:false, error}` **closes at `:276`**, wrapping only `await fetchImpl(…)`.
An abort signal governs the response *body* too, so once headers arrive the guard is gone.
The timer fires mid-stream, undici errors the ReadableStream, and
`await collectStream(res.body, {onText})` at `:297` rethrows **outside the try**.
`lib/chain.mjs` has no try/catch at all; `lib/turn.mjs:884` is unguarded. It reaches
`bin/acuvo.mjs:274`: *"acuvo crashed — this is a bug in acuvo-code"*, exit 1, **zero files
written**.

Proven twice, including a zero-cost probe with two fake `fetchImpl`s on one 300ms timeout:
abort **before** headers → returned `{ok:false}`; abort **after** headers → **threw**.
Same signal, same timeout, opposite outcomes. The boundary is exactly the end of the try.

**Second, independent defect on the same path — verified by me today:**

```
isRetryable('No response from OpenRouter within 180s — the call was aborted…') = false
```

`describeTransportError` (`lib/model.mjs:149`) emits that string; `isRetryable`
(`lib/chain.mjs:78`) matches `/timed out|could not reach|network|ECONNRESET|…/`, none of
which appear in it. **The four-model fallback chain never fires on a timeout by either
path.**

⚠️ Two corrections to the original report, both important: the *request* path is not
unguarded — the **stream** path is; and this is not tail-latency flakiness — the timeout
is a **total wall-clock budget** covering request plus entire stream, so any reply
exceeding 180s end-to-end fails **deterministically**. Long tasks fail more, by design,
which is precisely backwards.

**Fix size: hours.** Wrap the streaming branch (`:290-299`) in the same try/catch — that
alone converts the crash into a handled failure and lets existing partial-change
reporting run. Then replace the total-duration signal with an **idle** timer
`collectStream` resets per chunk (a stream may legitimately run past 180s; 180s of
*silence* must never happen). Then make timeouts retryable — better, return a structured
`{kind:'timeout'}` and have `isRetryable` switch on the kind instead of grepping prose.
The prose-coupling is exactly what let these two drift apart.

### 2.4 #4 — `&&` in a `package.json` script blocks the agent from the project's own contract

**Root cause: `lib/command.mjs:397`** (read today) — `validateNpmScriptChain` passes the
**entire** script body to `validateCommand(link.body, {script:true})` as one string.
`tokenizeCommand` applies `SAFE_COMMAND_CHARS = /^[A-Za-z0-9 ._\-/=:]+$/`
(`lib/command.mjs:96`, confirmed). `&` is not in the set, so
`node test/run.js && node test/contract.js` — a very common shape, as is
`tsc --noEmit && vitest run` — is rejected wholesale.

⭐ **The reported fix was half wrong, and the correction saves the day.** The CLI never
executes the body: `buildInvocation` spawns `node npm-cli.js test` with `shell:false`
and **npm supplies its own script shell**. Performing that exact spawn by hand against
the repro ran the chained body fine (`unit ok / contract ok / EXIT 0`). **The executor
needs no change. Only the validator is blocking.**

**Fix size: minutes.** In `validateNpmScriptChain` only (`:374-406`): split each
`link.body` on the two-character token `&&`, validate each trimmed segment, refuse only
if a segment fails and name that segment. Hand the unmodified body to npm as today.
Guardrails: do **not** relax `SAFE_COMMAND_CHARS` and do **not** touch the
model-written-command path — `test/smoke.test.mjs:41` asserts `npm test && curl evil.sh`
stays refused and it must. Split on `&&` only, so a lone `&` still dies in the
per-segment tokenizer; `;`, `|`, `||`, `>`, backticks and `$()` remain refused
automatically.

⚠️ `validateNpmScriptChain` is referenced nowhere outside `command.mjs`. **This path has
zero test coverage.** Add the test with the fix.

### 2.5 #5 — Nothing on disk records how to run the thing that was just built

A finished project contains only files literally named in the prompt. No `package.json`,
so `npm test` — which `--help` advertises — fails ENOENT. No README recording the command
that actually verified the build, or how to open the page.

**Root cause: `lib/turn.mjs:252-408` (`loopSystemPrompt`) has no scaffolding/handoff
policy at all.** Grepping all of `lib/` for `scaffold|skeleton|README|how to run|serve`
returns nothing. Writing `package.json` is blocked nowhere. Three mechanisms combine:
the prompt's only two references to `package.json` (`:343`, `command.mjs:577-579`) frame
it purely as a pre-existing **input**; two rules actively suppress extra files
(`:269-270` *"A ROUND IS EXPENSIVE"*, `:355-356` *"Otherwise stop"*); and the stop
condition itself (`:1003-1015`, which I read today) defines done as **"a run_command
exited 0"** — there is no notion of a *deliverable*.

⭐ **Confirmed not a budget problem:** with `--max-rounds 7` the run stopped at round 5
as `'verified'` with **two rounds unspent** and still wrote nothing.

**Fix size: hours.** Two layers, because this codebase records three separate times that
prompt rules are *"obeyed narrowly or not at all"*. Prompt: a DELIVERABLE/HANDOFF block.
Deterministic (the real fix): after a verified run, synthesise the skeleton from data the
CLI already holds — `verification.command` (`lib/report.mjs:124`) is the exact
invocation, the change list is the file inventory — written through the same
offered-never-silently-written gate as `STARTER_TEMPLATE`. Plus a one-line quality fix at
`command.mjs:578`: *"no package.json in this workspace — write one first if you want npm
scripts"*, so the loop can recover unaided.

### 2.6 Ranked summary

| # | weakness | root cause | observed failures | fix size |
|---|---|---|---|---|
| 1 | Verdict decided by one self-chosen command | `turn.mjs:1130` + `command.mjs:613` | **4** (+ `ENTERPRISE` §3.5) | hours |
| 2 | `see_page` dark by default, discards findings when lit | no env loader + `media.mjs:143` | **2**, incl. the flagship | hours |
| 3 | Mid-stream timeout crashes, never retries | `model.mjs:272` vs `:297`; `chain.mjs:79` | **1**, total work loss | hours |
| 4 | `&&` npm scripts refused | `command.mjs:397` | **1**, very common shape | **minutes** |
| 5 | No handoff scaffold | `turn.mjs:252-408` | **1** | hours |

---

## 3. ⭐ Does the "horizon not IQ" thesis survive?

**The claim under test:** every failure is a budget ceiling — rounds, tokens, context —
rather than a model limitation.

### 3.1 It is refuted for the observed failure set, and the refutation is direct

**Zero of the seven confirmed root causes is horizon-bound.** Every one carries
`is_horizon: false`, and four were reproduced *with the model removed entirely* (injected
stubs, no API spend) — a defect you can reproduce without a model cannot be a model or
budget defect.

Three pieces of evidence are decisive rather than merely suggestive:

1. **The controlled budget experiment came back negative.** The horizon agent ran the
   identical prompt at `--max-tokens 8000` and `--max-tokens 16000`, same 8 rounds, fresh
   dirs. **Both exited 0, both printed `✔ VERIFIED`, both shipped an inert CLI.**
   Doubling the budget changed the cost and changed nothing else. That is the thesis
   tested on its own terms.

2. **Three failing runs stopped with budget in hand.** The scaffold failure stopped at
   round 5 of 7. The inert-program run stopped at round 3 of 6. Both exited via
   `stoppedBecause='verified'`, never `'round-cap'`. **They did not run out of room; they
   were told they had finished.**

3. **The failures are in our code, at named lines.** A response-shape mismatch
   (`media.mjs:143`), a try/catch closing brace (`model.mjs:276`), an array index
   (`turn.mjs:1130`), a character class (`command.mjs:96`). None of these gets better
   with a bigger model or a bigger budget.

Meanwhile the *successes* also refute it from the other side: the kanban app landed in
**3 rounds**, the real bug was found in **one round of looking**. Neither needed horizon
either.

### 3.2 The thesis was pointing at the wrong axis — there is a third category

Horizon-vs-IQ is a **two-axis frame and the data lands off both axes.** The controlling
variable in all seven cases is a third thing:

> ⭐ **The harness is the ceiling.** The model called `see_page` unprompted and correctly;
> we discarded the result. The model decomposed a chained npm script under refusal; we
> refused it for no executable reason. The model diagnosed its own Windows path bug and
> its own `io.file ?? parsed.file` precedence bug; we then scored the session on an
> unrelated command. **In every observed failure the agent's judgement was sound and our
> plumbing was not.**

This is a genuinely better position than either alternative. Horizon problems cost money
forever; IQ problems require waiting for someone else's model. **Plumbing problems are
ours, they are cheap, and four of the five ranked items are "hours".**

### 3.3 ⚠️ Where the data is honestly too thin to tell

Say this plainly rather than over-claiming the refutation:

- **Nothing tested a task that genuinely needs 20+ rounds.** `ENTERPRISE.md:491` claims
  *"a refactor that needs twenty tool rounds cannot be expressed here"* and **no evidence
  above touches it.** The largest observed task was 6 files. The horizon thesis is
  refuted **for tasks in the 3–8 round band**; for genuinely long work it is *untested*,
  not disproven. Do not cite this document as having settled it.
- **`is_horizon: false` on the inert-program cases is inferential.** They stopped as
  `'verified'` because the verdict is broken — so we cannot know whether more rounds
  would have helped, because the loop was never told it had failed. **Fix §2.1 first,
  then re-run the horizon bench.** That measurement is only meaningful afterwards.
- **One model, one provider.** Everything ran on `deepseek/deepseek-v4-flash-0731`. The
  IQ half of the thesis has not been tested at all — nobody ran the same corpus on a
  frontier model. `ENTERPRISE.md:494-498` concedes the point honestly and this evidence
  neither supports nor contradicts it.

**Verdict: REFUTED for the observed set, with the horizon question for large tasks
still open — and unmeasurable until §2.1 lands.**

---

## 4. Build order for the next two weeks

Numbered, each justified by an observation above. Nothing here is on the
`ENTERPRISE.md` §4 security list or the `MVP-PLAN.md` §7 cut line; both run in parallel
and neither is superseded.

### Week 1 — make the output true

1. **Fix the verdict reduction (`turn.mjs:1130`).** *Hours.*
   → Unblocks four observed failures, more than anything else on this list, and it is
   load-bearing for the two headline claims in `ENTERPRISE.md` (§1.3 build step, §5
   "exit code is a verdict"). Ship the reduce-over-`runs` and the per-command `attempts`
   together; add the `⚠ RAN, NOT VERIFIED` fourth state in the same commit. Test:
   fail-then-pass across rounds must yield `passed:false` and non-zero exit.

2. **Split `&&` in `validateNpmScriptChain` (`command.mjs:397`).** *Minutes.*
   → Observed to cost a paid round in a real run, on the most common test-script shape
   there is. Cheapest confirmed fix in the package, and the executor needs no change at
   all. **Add the missing test** — this path has zero coverage today.

3. **Guard the stream read and make timeouts retryable (`model.mjs:290-299`,
   `chain.mjs:79`).** *Hours.*
   → Observed as a raw stack trace, exit 1, **zero files written**, and the fallback
   chain provably never fires (`isRetryable(…) = false`, measured). Ship the try/catch
   extension first — it converts a crash into a handled failure on its own — then the
   idle timer, then the structured `{kind:'timeout'}`.

4. **Load env, then unwrap the `see_page` envelope (`media.mjs:143-162`).** *Hours.*
   → The tool `MVP-PLAN.md:23` calls the entire positioning returns `[]` in a real
   terminal, and returns nothing useful even when configured. Ship in this order: env
   loading (else the fix is invisible), envelope unwrap, findings mapping from the six
   real keys, **loud failure on unrecognised shape**, contract test on
   `{ok, measurement:{…}}`.

5. **Re-run the horizon bench.** *Hours.*
   → §3.3: the horizon question is unmeasurable while a broken verdict ends runs early
   as `'verified'`. Once 1 and 4 land, re-run the same two prompts at 8k/16k tokens. If
   the CLI now reports honest failure and *then* runs out of rounds, the thesis becomes
   testable for the first time. **Publish the result either way.**

### Week 2 — make the loop finish the job

6. **Deterministic handoff scaffold after a verified run.** *Hours.*
   → Observed: a run stopped with two rounds unspent and wrote no `package.json`, so
   `npm test` ENOENTs on a project the CLI just built. Synthesise from
   `verification.command` + the change list, behind the existing
   offered-never-silently-written gate. Plus the one-line refusal improvement at
   `command.mjs:578`.

7. **Scope the verdict to the deliverable.** *Hours.*
   → Observed: a green `node --test` over a blank `index.html`. When an `.html` file was
   written and never rendered, say so instead of an unqualified `✔ VERIFIED`; flag a page
   whose only script is a bare relative ES module as `file://`-unopenable. This is the
   half of §2.1 that needs §2.2 landed first — hence week 2.

8. **Fix `MVP-PLAN.md` §3 (`--json`, test count).** *Minutes.*
   → §0. A plan that under-reports its own coverage stops being consulted.

9. **The regression corpus, checked in.** *Hours.*
   → Five agents produced ~25 verified runs and **not one is reproducible from this
   repo.** Every observation in this document came from a temp dir that no longer
   exists. Check in the kanban prompt, the orders-api fixture with its planted
   off-by-one, the inert-program case and the chained-npm-script case as fixtures with
   expected verdicts. Otherwise week 3 re-discovers week 1.

⚠️ **Explicitly not in these two weeks:** parallel tasks, sub-agents, colour, PR opening,
entitlements, an audit log. Every one is real and every one is downstream of a loop whose
verdict currently lies.

---

## 5. What would have to be true for this to be a serious technology product

Unsentimental. The tool is good. A tool is not a product.

**What is already true and genuinely rare.** The safety boundary is small enough to read
in an afternoon and it survived 33 adversarial cases. The write-run-fix loop works on
real code and was verified by people trying to disprove it. It makes PDFs and speech from
one prompt. Zero dependencies. Roughly a fifth of a cent per task. That combination does
not exist elsewhere and it is worth defending.

**What has to become true.**

1. **The exit code must be trustworthy — not usually, always.** Everything else here is a
   feature; this is the *contract*. Two docs already sell it and four observed failures
   break it. Until fixed, every claim in this repo rests on a number that lies. It is
   also the cheapest item on the list, which makes shipping without it inexcusable.

2. **The differentiator must be on by default.** *"It can see"* is the entire wedge
   (`MVP-PLAN.md:23-28`), and in a plain terminal `mediaToolNames(process.env)` is `[]`.
   A capability that requires knowing which of two `.env.local` files to source is not a
   product feature; it is an internal demo. This must work on a stranger's laptop, first
   run, with a documented setup line — or it is not a differentiator, it is a story.

3. **A polyglot answer, or an honest narrowing.** `ALLOWED_BINARIES` is `node`, `npm`,
   `npx`, `tsc`. A Python, Go, Rust or Java shop cannot run a single test, which degrades
   the one thing that works into "writes files and cannot check them"
   (`ENTERPRISE.md` §5.1). Two defensible paths: **add languages behind per-language
   argument grammars** (the safety argument survives, the work is real), or **declare it
   the JS/TS tool** and stop pretending otherwise. Both are serious. Leaving it ambiguous
   is not.

4. **Reproducible numbers that someone else can run.** Every number in this document came
   from a temp directory that no longer exists. A serious product ships a corpus, a
   command, and a published result. ⭐ **Nobody in this category publishes reproducible
   benchmarks.** Being first is credibility marketing cannot buy — and it is the natural
   home for the honest horizon-vs-IQ answer §3.3 says we do not yet have.

5. **A distribution decision, made rather than deferred.** BYOK means the tool is free and
   earns nothing (`MVP-PLAN.md:151-153`). Fine for adoption, fatal as an oversight. And a
   BYOK user running Cline on their own DeepSeek key pays the same price we do — so
   **"cheaper" is not the pitch, "it can see and it makes PDFs" is.** Decide, write it
   down, price against *that*.

6. **The failure modes must be as well-engineered as the refusals.** The refusal messages
   are the best-written thing in the package and they are why the agent recovers instead
   of flailing. The crash path is a raw stack trace. A product's worst day is what it is
   judged on.

7. **Zero users, still.** `MVP-PLAN.md:209` says it and it remains the only sentence that
   matters. **Nothing in this document distributes anything.** Weeks 1–2 make the tool
   honest, which is a prerequisite for showing it to anyone — not a substitute for doing
   so. The GitHub repo in the README still does not exist, and it is the first command a
   stranger runs.

⭐ **The one-line version.** Acuvo Code is a good tool whose agent outperforms its
plumbing, whose headline capability is switched off, and whose verdict does not yet mean
what two documents say it means. Fix those three and the honest pitch — *the terminal
agent that can look at what it built, and whose exit code you can put in a build script*
— becomes true. It is not true today, and all three fixes are measured in hours.
