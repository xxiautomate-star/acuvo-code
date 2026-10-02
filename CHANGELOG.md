# Changelog

All notable changes to Acuvo Code. Dates are AEST.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Driving the binary end to end (#497, 2026-10-01).

### Fixed
- **`/review` (and every git verb) called a real repository "not a git repository"** in any shell that
  sets `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` (CI runners and egress proxies do).
  The env scrubber dropped the `KEY`s (they match the secret pattern) but kept `COUNT`, so git refused to
  start; the `VALUE`s — which can carry an `http.extraheader` credential — were the half passed on. The
  whole family is now dropped together.
- **`/review` announced `@@ — no such file in the workspace`** for every diff hunk header: the generated
  review task went through `@path` expansion. Only text a person typed is expanded now.


Harness parity pass 2026-09-27 (branch `terminal/slim-harness-parity`; map in `PARITY-CLAUDE-CODE-CODEX.md`).

### Added
- **Three hook events:** `SessionStart`, `UserPromptSubmit` (non-zero exit refuses the prompt before
  any spend; `$ACUVO_PROMPT` carries it) and `PreCompact`. STDOUT of the first two reaches the model
  as context, in the user message (never the system one, so the cache holds). Not fired in `delegate` helpers.
- **Named sub-agents:** `.acuvo/agents/<name>.md`, and Claude Code's `.claude/agents/*.md` read as-is.
  `delegate` takes `agent`; the FILE decides read/write/verify, and a definition can only narrow a
  helper's tools, never widen them. `/agents` lists them.
- **`--output-format text|json|stream-json`.** `stream-json` is one JSON object per line on stdout:
  `init`, every loop event, then the `--json` document as a `result` line.
- **`/hooks`**, **`GEMINI.md`** as project memory.

### Fixed
- A config file's `json` default could override `--output-format` (rcfile did not know the flag).

Claude Code parity work (branch `terminal/remote-cli-parity`; audit in `RESULTS.md` at the branch root).

### Added
- **`!command` at the interactive prompt.** `!git status` used to be sent to the model as a paid
  task — and was then refused, because `git` is not on `run_command`'s allowlist. It now runs in
  your own shell (bounded by the same timeout and process-tree kill as `run_command`, environment
  scrubbed of keys), prints, and its output is attached to your NEXT message, labelled as commands
  you ran. The `!` line itself calls no model and costs nothing. `/clear` drops anything held.
- **Tab completes a `/command`** at the prompt (longest common prefix; a trailing space when unique).
- **Multi-line input.** Backslash + Enter and Alt+Enter insert a newline; newlines show as `⏎` so the
  one-row box keeps its shape.

### Fixed
- **A healthy model stream was killed at 180s and reported as "No response".** Found with a fetch
  tracer on a real game build: four rounds were cut at exactly 180.0s while streaming 1,265–2,104
  data frames each, and the run never finished in 20 minutes. A stream is now bounded by SILENCE
  (90s with no data frame — OpenRouter keep-alives do not count), a 90s THINKING budget (reasoning
  only, no content or tool call yet → retried with reasoning off, as before but in half the time)
  and a 600s hard cap. Each abort says which one fired. (`streamWatchdog`, `lib/model.mjs`.)
- **A refused `npm test` now names the equivalent that IS allowed.** On a cloned repo
  (`"pretest": "npm run build"`, `"test": "tape test/*.js | tap-spec"`) the refusal named a rule
  and no way out, and the run spent 14 rounds hand-writing build output. The refusal now follows
  `npm run` links and prints `node node_modules/<pkg>/<bin> …` lines (each re-checked by the same
  gate), notes a dropped reporter pipe, or — with no node_modules — says the install switch is the
  user's. Nothing new is allowed. (`lib/npm-script-equivalent.mjs`.)
- **`ci` inside "dependencies" offered `git_commit`, and the agent committed unasked.** Shortlist
  words now have to start a word (the builder's 2026-09-02 fix, ported): over 66 recorded briefs,
  18 group hits lost, every one a false positive (`voice`/invoice, `row`/arrow, `port`/report,
  `try`/retry), 0 gained. `git_commit` now also says to commit only when the user asked.
- **`playtest` could not prove a local game runs.** Driven for real through `@playwright/mcp`
  on a Breakout build: (1) the catalogue entry launched the user's INSTALLED Chrome, headed, with
  a persistent profile — now `-- --headless --isolated --browser chromium` (the `--` is
  load-bearing: without it npm eats the flags and the handshake times out), and the install line
  names the browser download that matches the server; (2) a workspace file went as `file://`,
  which that server refuses — it is now served read-only over an ephemeral 127.0.0.1 port for the
  drive (`lib/serve-workspace.mjs`, same containment as `read_file`), which also fixes module
  scripts and `fetch()`; (3) every key press on a canvas game read "changed nothing", because
  its accessibility tree never changes — the local drive now hashes the canvas around each step
  and reports "the canvas picture never changed" when it is dead; (4) a new `hold` step keeps a
  key down ~0.4s, since held-key games ignore an instantaneous `press`. Live: the built game
  reports 0 problems over 4 actions; a static canvas reports the dead picture.
- **A 6-slide deck came back from `make_document` as ONE slide.** The press has always taken
  `pages[]`; the CLI sent only `html`. A document with 2+ top-level `<section class="slide">` (or
  `data-slide`) is now split into one self-contained page per slide, `html` still sent for older
  servers, and the result says how many pages came back (and warns when the server merged them).
  Live, direct to the press: the run's own deck.html → 6 slides, opened by python-pptx. ⚠️ Through
  the signed-in gateway it needs `console/app/api/cli/v1/document/route.ts` (now forwards
  `pages`) DEPLOYED first; until then the CLI says the pages were merged.
- **A tool call cut off by the reply limit killed the session.** Its broken arguments were echoed
  into history, and the provider rejected every later request ("function.arguments must be valid
  JSON"), ending the run `model-error`. The history copy now carries `{}`; the model still reads
  why the call failed. (`historySafeCall`, `lib/turn.mjs`.)
- **Pasting several lines sent only the first one.** A pasted stack trace submitted line one as the
  whole task and dropped the rest. The box now turns on bracketed paste while it reads (and off on
  every exit path, including `restoreTerminal`), and re-shapes an unbracketed paste — a chunk with
  text after a newline — so a paste never sends.

## [0.6.25] — 2026-09-25

⚠️ **STAGED, NOT PUBLISHED.** Everything below landed after 0.6.24 reached npm on
2026-09-20. Publishing is the owner's call; the version is bumped so `package.json` and npm
cannot read the same number while the code differs.

### Added
- **`playtest` works without a local browser.** It needed a browser MCP server, which a customer does
  not have, so asked to *"check it actually starts and moves"* the CLI had to say it could not press
  keys. Signed in, it now drives the page in our hosted browser through the account — the same door
  `see_page` uses — and reports whether a canvas game's picture MOVED after the input. Proven live:
  a working snake reported `moved: true` in 10 s; a canvas that never redraws reported "never
  changed". ⚠️ Needs the gateway's `mode: 'playtest'` (console) deployed before it works for users.
  `ACUVO_HOSTED_PLAYTEST=off` disables it. `acuvo doctor` now names why `playtest` is dark.

### Fixed
- **`edit_file` rewrote `$$` as `$`.** The replacement text went through `String.replace`, which reads
  `$$`, `$&`, `` $` `` and `$'` as patterns — so fixing a money formatter's `` `${sign}$${dollars}` ``
  wrote the `$` away while reporting success, and a bug-hunt run spent four rounds re-sending a correct
  edit before falling back to `write_file`. `new_string` is now spliced in byte-for-byte.
- **A `see_page` screenshot was reported as "GPU time".** The budget line hard-coded the hardware while the
  ledger entry beside it said *"at the published cpu rate"*. It now names what was charged: `GPU time`,
  `hosted CPU time`, or `hosted compute` for a mix.
- **A model recovery on the same model was silent.** The fallback warning speaks once per new model, so a
  retry with reasoning off (after a 180 s timeout or an empty thinking reply), or a fallback to a model
  already announced, printed nothing — a round that took minutes looked like the model thinking. Each is
  now one dim line naming the cause.
- **The headline cost left out attempts the model chain threw away.** A run printed `12 rounds · $0.011895`
  and, on the next line, `budget: $0.0161 … 13 rounds`: the budget and the account meter were charged for
  a discarded billed attempt, but the summary, `--json` and the audit record's `costUsd` summed only the
  rounds that answered (26% low on that run). They now include it, and the line says so —
  `(incl. $0.0043 for 1 discarded attempt)`.
- **A deliberate error-path probe turned a correct run into "NOT VERIFIED".** Documenting a CLI, the
  agent ran `npm test` (green) and `node bin/tasq.mjs bogus` on purpose to confirm it exits 2; the summary
  said *"the code does not pass"*. `run_command` now takes `expectExit`: the run passes only on exactly
  that code, the expectation survives the end-of-run re-check, and the banner names the real check rather
  than the probe. Without `expectExit` a non-zero exit is still red — output is never used to guess intent.
- **`tsc -p .` was refused** with the file tools' *"path resolves to the workspace root itself — this
  argument has to name a FILE"*. As a command argument `.` is the directory the child already runs in, so
  it is now accepted for every binary; `..` is still refused.
- **`node --test test/` failed on Node 22, and a passing run was reported NOT VERIFIED because of it.**
  Node 22 loads a directory operand as a module (`Cannot find module '…\test'`). A run hit it, switched to
  `node --test test/wc2.test.mjs` (19/19 green) — and the final check re-ran the original command and
  printed *"Whatever it said above, the code does not pass."* A directory after `--test` is now expanded
  to the test files Node's own discovery would pick; a directory with none is left alone so it still fails.
- **`node app.mjs --json` was refused as "not an allowed node flag" with no way out.** A flag after the
  script path belongs to the program, not to node. `run_command` still refuses it (one string, every
  token checked), but the refusal now says whose flag it is and hands over the exact `run_program`
  argv that passes it through — a run that had just written `--json`/`--help` spent a round
  hand-rolling `spawnSync` in `evaluate` to try them.
- **`read_table` sent a CSV to the GPU.** Asked to report on `sales.csv`, the model's first call was
  `read_table`; the image reader answered `UnidentifiedImageError` and the estimated GPU cost was six times
  the run's model spend. A plain-text file is now refused locally and pointed at `read_file`.
- **A run could close before reading the page it had just been asked to check.** Found by using it:
  *"open it in a browser and check that adding two items shows the right total before you finish"*
  — the grace round ran the tests and `see_page` together, the second green test ended the run, and
  the summary said VERIFIED without the model ever seeing the page. A look (`see_page`, `read_image`,
  `playtest`) in the closing round now buys exactly one more round to read it, once per session.
- **The first file-writing round was usually answered by the fallback model.** In 2 of 3 real runs
  `deepseek-v4-flash-0731` (reasoning on) returned an empty reply there, and the chain moved to
  `deepseek-chat` — older, a different price, a cold cache. An empty reply from a model with
  reasoning on is now retried once on the SAME model with reasoning off, same messages, before any
  fallback.
- **The summary counted the agent's own screenshots as files it wrote for you.** `see_page` saves
  `.acuvo/render-<ms>.png`; a run that built two files printed "4 files written". They are now
  named on one line of their own and left out of the count.
- **A model repeating itself in prose was invisible to the loop watcher.** It read tool calls
  only; a real run spent all 24 rounds and 1.38M tokens restating one sentence over unique
  file reads. `findRestatedPlan` now fires (measured: round 16, was 24).
- **A run that hit its round cap delivered nothing.** The last round is now held back — no
  tools, one instruction — and spent writing the report of what was found. Costs no extra
  call (it comes out of the budget); below 5 rounds behaviour is unchanged.
- **The project doctrine file (`CLAUDE.md`/`AGENTS.md`) was cut at a byte offset,** often
  mid-sentence; it is now cut at section boundaries, and the nearest scoped file wins.
- **Eight MCP servers reported sixteen lines of failure noise;** now one line each.
- **Three shipped skills (`vendor-shelf`, `data-and-charts`, `acuvo-design-system`) shut the
  npm door in prose** that the product offers on most builds; corrected to match.

## [0.6.24] — 2026-09-20

✅ **Published to npm 2026-09-20** (this note said STAGED; `npm view acuvo-code time` shows it live).

⚠️ **Was STAGED, NOT PUBLISHED at the time of writing.** Five commits landed after 0.6.23 went to npm, and for a
day `npm view acuvo-code version` and `package.json` both read **0.6.23** while the code
differed — the exact trap this file warned about one release ago. The version is bumped
here so the two numbers can no longer agree while the code disagrees. Publishing is a
separate, deliberate act.

### Fixed
- 🚨 **A skill shipped on every build told the model the proxy was impossible.**
  `skills/api-design.md` opened with an absolute saying a generated app *cannot* call a
  third-party API, and later said a live exchange rate and today's weather simply could
  not be fetched. Both false — `open-meteo` and `exchange-rates` are rows in our own
  connector catalogue, and the same file's deploy table lists `AcuvoProxy` working on all
  three surfaces four screens down. `skills/` ships inside this package, so every user's
  model read it. The absolute is now a scope: *"reach another host through `AcuvoProxy` —
  a direct `fetch` is refused by CSP"*, keeping the CSP claim, which is true and
  load-bearing. Shelf refusals **3 → 0**, pinned at zero across every skill.
- **`docs/STATUS.md` claimed a green suite while 23 tests were red.** The claim is gone and
  the number is now derived rather than asserted.
- **18 of those 22 red tests were the rate card, not the code** — the published prices had
  moved and the pins had not. Typed and corrected.

### Added
- **The knowledge servers are named.** The register said 15 servers / 7 knowledge / 1 on by
  default. Measured through the real connect path: **21 catalogue entries, 11 keyless
  knowledge servers, 11/11 connected in 239–1,723 ms, and ZERO are on** — `enabledByDefault`
  fed five functions with no production caller. `awsdocs` was uncallable and `mcp add`
  counted for nothing; both fixed, and the ten servers are now named to the model.
  ⛔ **The flag was deliberately NOT flipped.** Auto-connecting third-party HTTP servers
  with the user's problem statement in the query is the owner's decision, and flipping it
  would have been green while changing nothing on screen.
- **`use_toolset` is documented as what it already was.** A brief claimed nothing defers
  SCHEMAS, only instructions. Wrong about this CLI since 2026-08-31: `lib/mcp-shortlist.mjs`
  ships ONE 709-byte schema naming the withheld servers, 21 catalogue servers behind it, and
  the round loop rebuilds the tools array mid-round when the model asks for one.

### Known, and deliberately unfixed
- ⚠️ **Five pricing assertions are red because the rate card moved, and every one is an
  owner decision rather than a test to edit** — the suite says so itself: *"Raise the price,
  lower the published count, accept a lower margin, or repin the ceiling provider — this is
  a pricing decision, not a test to edit."*
  The starter page promises **95.0M** flash tokens; the derived 85%-margin allowance
  delivers **80.3M (84.5%)**. Margins moved about three points against us (89.5 → 87.5 at
  95% cache; 79.8 → 76.8 cold) and the free tier costs **0.127** where it was pinned at
  **0.108**. All still healthy; none is a functional defect.

## [0.6.23] — 2026-09-19

⚠️ **0.6.22 shipped with no entry in this file**, so this release covers everything since
0.6.21. That gap is the same defect this project has recorded before: npm and
`package.json` both read the same number while the CODE differed. Check
`npm view acuvo-code time` against the last commit date, never version-against-version.

### Added
- **`/doctor`, `/spend` and `/resume` answer at the prompt.** All three existed as flags and
  all three replied *"is not a command"* interactively. `/spend` and `/resume` are directory
  reads and took a provider like `/config`; `/doctor` does network probes and rides the
  `effect` seam the chat loop already owned — so `runSlashCommand` stays synchronous and
  `slash.mjs` stays pure, which a guard now asserts.
- **`/resume <id>`** restores a previous run's history. It warns that the session keeps its own
  routing key, so the next turn is billed like a cold one — the warm prefix is not restored.
- **Your own skills.** A user can keep personal skills alongside the bundled ones, and the
  shelf is finally visible.

### Fixed
- 🚨 **`--approve always` failed OPEN.** The mode that means *"ask me before every write"*
  computed a verdict and discarded it one line later; a model destroyed 90% of a file with
  the safest setting on. **117 tests stayed green** because each built its own collaborators,
  so none could see it. It now fails closed.
- 🚨 **`spawn EINVAL` killed every globally-installed MCP server on Windows.**
- 🚨 **`--doctor` called a service that had REJECTED our credentials "live".** An auth failure
  now reads as one.
- **`acuvo mcp install --hosted` printed "Claude Desktop: added"** while writing a remote
  entry into a config format that has no remote shape. It now names the Connectors path
  instead; the stdio install is untouched.
- **The eight symbol verbs were dark on a fresh install**, and the fix the CLI printed no
  longer worked.
- **The model chain's own fallback was the one model we routed to unpinned** — a provider swap
  there silently destroys the shared cache prefix.
- **Two skills were teaching the model something false.** `forms` said the fix for leaking a
  customer's data did not exist; `auth-and-sessions` said an app admin is *"a signed-in user
  whose email is listed"* — which was a fake gate, since the rules file ships with the app and
  sign-up verifies no address. An admin is now granted deliberately by the owner.

### Decided, not built
- **`localize_files`** — 834 tested lines imported by nothing. The excuse on file had been
  stale for a month in its load-bearing clause. Settled in `DECISION-localize-files.md`: the
  real price is 3–4 model calls from a verb whose own description says *"use this FIRST"*, and
  its headline gain is measured against a no-file baseline this product does not have.
- **`memory-workspace.mjs`** — its stated second client did not exist. Recorded.
- A guard now pins the shape: **every `*ToolSchemas` factory is registered, or a
  `DECISION-*.md` names it.** An allowlist entry was deliberately rejected as the escape,
  because a name in a `Set` is the shape of excuse that rotted twice already.
## [0.6.21] — 2026-09-11

### Added
- **`find_usages`** and **`write_process`** — see the notes under Unreleased above, both
  shipped in this release.

### Fixed
- **The AST-edit rule reached the model ZERO times.** `a3cff7ee9` deleted all three copies
  of *"use these instead of `edit_file`"* to reclaim 232 chars against lever 10 — correctly —
  but every surviving mention lived inside an **error result**, which only arrives after an
  AST verb has already been chosen. The rule is now stated once, 84 chars, and a guard
  asserts exactly-once so a fourth copy cannot creep back.
- **Four provider tests were hollow for the second time.** `warm-provider.test.mjs` records
  in its own header that the 2026-08-27 repin emptied three of them; the fix chosen then was
  another hand-written remap, which the Sail Research repin emptied again. All four now
  derive from `PROVIDER_PIN_BY_MODEL`, so a repin cannot silently un-test them.
- **Two documents carried a correction that never deleted what it corrected** — README read
  `**84 tools**` directly above `**85 tools**`, and ENTERPRISE.md carried two different
  "ships **N files**" sentences. That shape survives a correct number, so it has its own guard now.

### Changed
- **Provider pin: Sail Research leads.** Re-read from the live feed, where the previous card
  was 19–33% out. ⚠️ The model never changes — DeepSeek throughout; only the upstream moves.

### Known
- 21 tests remain red **by design**, pinning margin numbers that await the owner's
  re-approval. They are one decision, proved by reverting `lib/rate-card.mjs`: those five
  files then run 105/105 green.

## [Unreleased]

### Added
- **`/config`, `/approve` and `/rewind` at the interactive prompt.** Measured 2026-09-19
  by typing them: all three answered *"is not a command"*, while `acuvo config`,
  `acuvo rewind` and `--approve` had worked from the command line for weeks. So the four
  questions the product is built around were invisible from the one place a person sits;
  the ASK-or-ACT mode was fixed for the life of a session; and the undo — the thing you
  reach for at the exact moment something went wrong — cost you the conversation, because
  the only way to it was to leave. Nothing new was implemented: the providers hand through
  `describeFourQuestions`, `APPROVE_MODES` and `readJournal`/`planRewind`/`applyRewind`
  unchanged. `/approve <mode>` takes effect on the NEXT turn (the run loop already re-read
  the mode every turn; it simply had nothing that could change it), and `/config` then
  names the prompt as the source rather than still saying "built-in default".
  `--force` is deliberately not reachable from `/rewind`.
- **`--help` now derives its list of `/` commands** from `SLASH_COMMANDS` instead of a
  hand-typed copy, which had already gone stale.

### Fixed
- **⚠️⚠️⚠️ `--approve always` was documented to fail CLOSED and failed OPEN.**
  Measured in the product, not in a test: `acuvo --approve always "replace the entire
  contents of math.mjs …"` → `✎ replaced math.mjs (18 bytes · was 199)`. 90% of a file
  destroyed under the mode whose entire meaning is *"ask me about every write"*, with
  nothing asked and nothing refused. `diff-preview.mjs` had computed the right verdict —
  `{ required: true, satisfiable: false, blocked: true }`, under its own comment calling it
  *"THE ONE FAIL-CLOSED BRANCH"* — and `write-approval.mjs` discarded it one line later,
  because `!satisfiable` sat in the same condition as `!required` and both returned
  `allowed: true`. The batch door (`write_files`, `apply_patch`) had the same hole and is
  the worse one: it waved through a whole batch. 117 tests across five approval suites were
  green throughout, every one of them building its own collaborators.
  ⭐ The DEFAULT still fails open, deliberately and unchanged — a review gate that breaks
  CI gets globally disabled and then protects nobody. Only `always` with no terminal
  refuses, which is what its own reason string already told users it would do.
- **The model is no longer told a person declined** a write that was blocked for want of a
  terminal. `refusedWriteResult` hands through the real reason, which names all three ways
  forward; the old wording ended *"ask what they want different"* and there was nobody to ask.
- **`find_usages`** — every use of a NAME in code across the project with comments and
  string literals masked, whole identifiers only, and the files that define the name
  marked — with no language server. Measured on this repository: `killProcessTree` →
  12 uses in 4 files where `search_text` reports 20 mentions; 574 files in 651 ms. It
  sweeps source files only (an inline handler in HTML is not seen) and does not follow a
  renamed import; `find_references` still wins when TypeScript or a server is present.
- **`write_process`** — send a line to a running background process's stdin: a REPL
  expression, the answer to a `y/N` prompt, the key a dev server asks for. Background
  children now keep stdin open as a pipe (it was `ignore`, which handed a REPL an
  immediate EOF). The reply arrives in the same log `check_process` / `wait_for_output`
  read; what was sent is recorded as `[stdin] …`. It is a pipe, not a terminal — the
  node-pty transport stays withdrawn (README, `ACUVO_PTY_MODULE`). Tested against a real
  `node` echo process.

## [0.6.20] — 2026-09-06

⚠️ **AND THIS ENTRY COVERS 0.6.19 TOO, WHICH SHIPPED WITHOUT ONE.** There is no
`[0.6.19]` heading below: it was published on 2026-09-01 and nobody cut a
section for it. A changelog that silently skips a release is how "what is
actually in the thing I installed" becomes unanswerable — which is the same
question the version-vs-version trap makes unanswerable, one level up.

### Added
- **`acuvo tunnel <port>`** — a public URL for a local port, cloudflared-driven,
  no dependency added. Deliberately a HUMAN subcommand and not a model-callable
  tool: opening a port on this machine to the internet is the same class of
  decision as which program we spawn.
- **`rename_symbol`** — the 82nd tool. Semantic rename via the language server.

### Fixed
- ⭐ **Twelve skills were losing their tails on every read.** `read_skill` returns
  a body through a round-result budget that truncates at 11,800 characters, and
  12 of 54 skills were longer. `vendor-shelf` was losing its last 3,783
  characters — which contained *"a CDN is blocked, and that is the #1 way a
  generated app ships dead"*, the list of globals each vendored tag defines, and
  *"prove it actually loaded"*. All 54 now fit; a guard fails the build if any
  crosses the cap, and says **shorten the body, do not raise the budget**.
- **`find_references` answered 2 of 8** because we told the language server not to
  report progress (`workDoneProgress: false`) and then waited for the project to
  load.
- **The doctor claimed `.acuvo/` was NOT ignored in a repo where it is.** It read
  a single `.gitignore` at the package directory; git applies rules from every
  ancestor, and this repo states the rule at the root. It now walks up, and stops
  at the repository boundary.
- **A 1,051-line renderer nothing could reach**, and five verbs that were never
  named to the model.

### Changed
- Caching and provider routing (`model.mjs`, `warm-provider.mjs`, `chain.mjs`).
  ⚠️ **Unmeasured live since 2026-09-01** — the best recorded prefix hit rate is
  **88.2%**, against a stated bar of the high 90s, with 2 of 24 rounds escaping
  the warm pin.

### Known
- `print hello world` is pointed at `printing-and-pdf` by the skill-hint ranker.
  Listed on `KNOWN_WEAK_POINTER` rather than fixed: the obvious repair
  (tightening `HINT_MIN_QUERY_FOR_SINGLE_TOKEN`) was swept and rejected — it
  costs three true pointers to remove one wrong one.

### Added
- **A command that asks a question no longer spends the whole timeout returning
  nothing.** `lib/interactive.mjs` detects a prompt on a command's output and
  `spawnBounded` acts on it. Measured before, on Windows: `npm init` printed
  `package name: (x) ` and was **still running at 8,078ms** against a 120s
  timeout; a `readline` question took the opposite path and exited at 262ms with
  output that reads like a bug in the program. Measured after, on the DEFAULT
  surface: `npm init` comes back in **~1s** with the exact question quoted and
  `npm init -y` named as the next move.
  ⭐ **The default types nothing into a child process, ever.** `ACUVO_INTERACTIVE`
  is `halt` unless an operator says otherwise: `auto` answers a safe `[Y/n]` and a
  printed default, `ask` puts a person in the loop, `off` restores the previous
  behaviour byte for byte. It is an environment variable because the agent has no
  verb that reaches its own parent's environment.
  ⭐ **The safety property is structural, not a blocklist.** There are exactly two
  strings that can be sent to a child — `y` and a bare Enter — and no code path
  builds a third, so prompt text can never become stdin text. A hostile
  postinstall printing *"type DELETE to confirm"* gets a halt, not an answer.
  ⚠️ **No mode at all** answers a prompt asking for a credential, a licence or
  terms, or anything whose wording matches a destructive pattern; a credential
  prompt is **redacted** before it reaches the transcript or the model.
  ⚠️ The false-positive defence is two facts about what a prompt is: no trailing
  newline, and eight seconds of silence. Both must hold.
- **A deterministic circuit breaker for the loop that edits the wrong file.**
  `stuck.mjs` gains `futile-edit-loop`: three real edits to ONE file with a
  byte-identical failure each time. ⚠️ This is exactly the case
  `findCommandFailureLoop` was built to EXCLUDE — its own comment defends
  "iteration" — and the distinction is that the edits are landing and the
  compiler has not moved, which is proof they are not reaching what is failing.
  It **breaks** rather than hinting (the three-edit threshold already is the
  patience), says which file and which command, and **rolls back those edits**
  through `checkpoint.mjs`. ⚠️ Only those edits, and a file YOU changed after the
  agent did is **skipped with a reason** — `planFutileRollback` produces
  `applyRewind` ops precisely so the automatic path inherits the manual one's
  sha-verified refusal. `ACUVO_CIRCUIT_BREAKER=off` disables it.
- **`acuvo --doctor` now reports both**, because a capability nobody can find is
  the same as one that does not exist.

### Changed
- `spawnBounded` spawns with `stdio: ['pipe', …]` and closes stdin immediately
  unless a mode is in force that can answer. ⚠️ This is STRICTER than the old
  `'ignore'`, not looser: on POSIX both deliver EOF, and on Windows `'ignore'`
  demonstrably did not — that is the 8,078ms above.

### Not done, and why
- **A real pty transport was built, driven, and withdrawn.** `node-pty@1.1.0` is
  MIT (verified from the tarball, not the npm badge — three agreeing notices).
  Routing commands through it worked, and then: after a command that settled
  cleanly at exit 0 the CLI process still held `MessagePort, PipeWrap, PipeWrap,
  ProcessWrap, Timeout, Timeout` and **could not exit** (handles inside a worker
  thread of the library, not reachable by `detachChild`); its
  `conpty_console_list_agent` crashed every run with `AttachConsole failed`; and
  captured output arrived as terminal repaint the model would be billed for.
  Trading a timeout that ends for a hang that does not is not an upgrade, so
  `lib/pty.mjs` keeps only detection and `doctor` says plainly that a node-pty
  which IS installed is **not used**.
  ⚠️ It is also unfit as a dependency for a separate reason: `install` and
  `postinstall` lifecycle scripts, its own dependency, 63 MB unpacked — and this
  package forces `--ignore-scripts` on every install its agent performs.

- **Several slow tool calls in a round now run at once.** `lib/round-schedule.mjs`
  is a pure function that decides which of a round's calls provably cannot see
  each other's effects, and the loop starts those together. `--no-parallel-tools`
  restores the strict one-at-a-time loop.
  ⚠️ **The rule is not "reads are safe" — that is true and not sufficient.**
  Measured on this repo by counting event-loop ticks per verb: `read_file`,
  `list_dir`, `find_symbol`, `find_files` (153ms) and `search_text` (477ms) are
  all **synchronous** — `lib/search.mjs` is `readFileSync` on purpose — so
  overlapping them is not concurrency. Measured end to end:
  `git_status`+`git_log`+`git_diff` **584.8ms → 287.0ms (2.04x)**;
  `read_file` ×3 **1.01x**; and `search_text` beside `git_status` came out at
  **0.92x — slower than serial**, because a synchronous verb owns the event loop
  while the subprocess beside it waits. So only read-only AND genuinely
  asynchronous verbs are hoisted: the three `git` reads, `fetch_url`,
  `web_search`, `read_image`, `see_page`, `transcribe`, `read_document`,
  `read_table`, `list_engines` and the three `gh_*`.
  ⚠️ Never across a write, a command, `ask_user` or `wait_for_output`; never an
  MCP call (a third-party verb name proves nothing about whether it writes); and
  **never at all in a workspace with a `PreToolUse` hook** — a gate that can be
  pre-empted is not a gate.
  ⚠️ **The honest size of the win:** replayed against all 53 rounds recorded in
  `.acuvo/sessions/`, the schedule is non-empty for **2 of them**, saving ~464ms
  — **0.175% of session time**. The mechanism is right and the current traffic
  barely uses it. The reason is in the same measurement: **`search_text` alone is
  88.6% of all tool wall-clock** and is the one verb that cannot be overlapped.

### Fixed
- **⭐ "The single funnel every failure passes through" was four funnels, and
  only one had been fixed.** The `wait_for_output` fix landed with that sentence
  in a comment; an audit found the same logic written out four times.
  `renderToolRecord` — **the line a human watches in the terminal** — read
  `result.error` alone, so a `wait_for_output` timeout rendered as
  `✖ wait_for_output: unknown error` while the model's line correctly said
  `timeout after 30s`. `read-window.mjs` and `mcp-server.mjs` had the same gap.
  `failureReason()` in `lib/model-json.mjs` is now the only copy, and a guard
  fails any module that hand-rolls it again.
- **⚠️⚠️ Over MCP, a failed tool call could be reported as a success.**
  `mcp-server.mjs` asked `result.ok === false`, so a result with `ok` **missing**
  — the exact `review_code` shape — took the SUCCESS branch. That is the
  `review_code` defect inverted, and it is the dangerous direction: a success
  reported as a failure wastes a round; a failure reported as a success is built
  on. Now `ok !== true`, shared with every other surface.
- **⚠️⚠️ `--no-run` executed code.** `evaluate` and the three `gh_*` verbs were
  withheld from the OFFER when running is disabled and had **no guard at the
  dispatcher**, so a widened tool list, a resumed session or a provider echoing a
  stale list ran the model's JavaScript in a child process under the flag
  documented as "never execute anything". This file already argued the point for
  `repl` and cited `evaluate` by name as the precedent for the guard it did not
  have.
- **A tool formatter that threw took down the whole session.** Handing every verb
  a minimal `{ ok: true }` crashed **11 of 81** (`list_dir` on `result.entries`,
  `run_command` on `result.stdout`, the four LSP verbs on `result.locations`,
  and more). `toolResultText` has no `try` around it in the round loop, so an
  unexpected result shape ended the run after the tool had already done its work
  and the tokens were already paid for. It now degrades to the JSON envelope and
  says so, naming the verb.

### Changed
- **All 81 verbs now reach the model as prose.** The last 19 — `check_tools`,
  `evaluate`, `find_symbol`, `make_document`, `pipe_to_asset`, `syndicate`,
  `viral`, `podcast`, `remember`, `forget`, `list_sessions`, `ask_user`,
  `declare_acceptance`, `gh_issue`/`gh_pr`/`gh_run`, `vercel_preview`,
  `profile_table`, `inspect_binary` — plus `delegate`, the most expensive result
  in the package. The `default:` JSON branch survives for MCP results, which no
  `case` can ever match.
  ⭐ Two of these carried a trap rather than a formatting problem, and both are
  now pinned by name: `viral`/`podcast` answer a **declined spend gate** with
  `{ok: true, spent: false}` — a refusal wearing a success — and
  `vercel_preview` returns `ok: true` alongside a non-null `error` when the
  DEPLOYMENT failed but the call did not.
- **A run that ran out of rounds now says so.** Measured across this repo's own
  139 Terminal-Bench result documents (111 parseable): 9 runs stopped at
  `round-cap`, every one of them having consumed all 16 or 32 rounds, and every
  one of their closing notes is a sentence about the next step ("It's still
  compiling. Let me wait…", "I'm at round 32 of 32. Let me fix dpkg…", "…the
  carry propagates in the wrong direction. Let me fix le32."). **Two of the nine
  printed `✔ VERIFIED`, exited 0 and never mentioned the cap** — the only
  sentence naming it lived inside the `verification ran AND failed` arm, so a run
  capped with a passing command, with no command, or under `--no-run` was silent.
  `roundCapWarning` now prints unconditionally, below the verdict, and says the
  counter ended the run rather than the work.
- **The recovery is named where it is needed.** `--continue` has restored a
  conversation, re-run nothing and reused the saved id as the sticky routing key
  since it landed, and only somebody who already knew it existed could use it.
  A capped run now prints it. It is withheld under `--no-session` / `--dry-run`,
  where no record exists to continue.
  ⚠️ Not a bigger number: all nine capped runs were already at `--max-rounds`
  16–32, and the median run uses 31% of its rounds, so raising the ceiling would
  have saved none of them and cost everyone else nothing either. The cap is a
  handoff problem, not an arithmetic one.
- **`acuvo … && git push` no longer pushes a run that was cut off having proved
  nothing.** `round-cap` and `stuck` now fail the process verdict — and `--json`
  `failed` / `exitCode` with it — **when the run verified nothing**, which is the
  conditional shape a `truncated` stop has used since 2026-08-16.
  ⚠️ **Not unconditional, and the archive is why.** Of the 9 capped runs above, 7
  already exited 1 because their command ran and failed; the 2 that exited 0 both
  had a command that ran and PASSED, and the one of those with a verifier score
  on disk scored a **pass**. Failing every capped run would have caught nothing
  and failed correct work, so a capped run that verified still exits 0 and is
  answered by the warning above. The escalation ladder is untouched: `outOfRoad`
  still treats every capped or stuck run as a wall.
- **Documentation numbers are checked against the code in prose, not only in the
  README's options table.** `ENTERPRISE.md` said "5 rounds, ceiling 16" in three
  places — including the section recording the previous version of this same
  mistake — while `DEFAULT_MAX_ROUNDS` was 24 and `MAX_ROUNDS_LIMIT` 64, and the
  suite was green throughout. `test/docs-truth.test.mjs` now binds every number
  to the exported constant its clause names, resolving the module when the clause
  cites one. It found 30 such claims across the repo's prose and 3 that were
  wrong: the README's repo-map budget (6,000 where `DEFAULT_BUDGET_TOKENS` in
  `lib/repo-map.mjs` is 9,000) and two `BACKLOG.md` rows.

## [0.6.18] — 2026-08-28

### Added
- **The cost-unit meter is reachable, and it now refuses before a round.** The
  allowance was READ once and SET nowhere — no flag, no env var, no plan lookup
  — so every gate returned `allowed` and 40 green unit tests never noticed. A
  real run with 10 units then completed three rounds anyway, because the meter
  sat on the escalation ladder's budget rather than the one `runSession` builds.
  Both closed; `processMeter()` is a single seam so the next call site cannot
  omit it, and `ACUVO_UNIT_ALLOWANCE` makes it settable.
  ⚠️ The intended source is the PLAN, and `account.mjs` does not carry an
  allowance yet — plan-driven metering still needs a gateway change.
- **The refusal reaches the turn loop.** `meter.checkUsd(usd)` bridges the gap
  that had blocked it for weeks — `projectNext()` speaks dollars, `meter.check()`
  wanted units — and composes into `canContinue()`: one seam, four existing
  callers, refuse-only, a byte-for-byte no-op when no meter is present.
- **Creative work debits the same pool.** Wired inside `syncGpu()`, the drain
  every public method already passes through, so a GPU charge cannot go
  unclaimed. One rented video clip is 8.4% of an A$29 month — invisible while
  creative had its own ledger.
- **MCP servers suggest themselves.** `acuvo` now reads the project at session
  start and names the servers its files are evidence for — `pg` in a manifest
  suggests `dbhub`, `@playwright/test` suggests `playwright`, with the evidence
  quoted. It SUGGESTS and never boots: nothing runs until you say so. Only
  verified entries are ever named, and it adds nothing to the prompt or the tool
  offer.
- **Rewrite waste is reported to the model** on `write_file` and `write_files`,
  the signal the builder has had since 2026-08-20 and the CLI had never had.
  Advisory, never a veto — by the time a write arrives the tokens are already
  spent, so refusing buys a second round at full price.

### Fixed
- **`search_text` was answering with its own cache.** A search for a function
  returned exactly one hit — `.acuvo/index/symbols.json`, the derived symbol
  index — and never the file where it is defined. Not an empty answer a model
  would distrust, but a confident one pointing at a generated file nobody edits.
  `.acuvo/index/` is now skipped exactly as `.acuvo/sessions/` already was, and
  each skipped child reports its own reason instead of every skip claiming to be
  a session transcript.
- **The design verdict reached the model as escaped JSON**, and once as a
  705-token essay. Both corrected — 114 tokens, 3.7s.

### Notes
- The eyes are a second model **by necessity**: the build model declares `text`
  only and physically cannot receive an image. This does not fragment the prompt
  cache — the image never enters the build context, the verdict is capped and
  appended at the end — and four mutation-proven tests now pin that.

<!--
⚠️ The entries below accumulated from 0.2.1 through 0.6.17 without being cut
into per-version sections. They are SHIPPED, not pending. Left intact rather
than retro-assigned to versions we cannot now verify.
-->

## [0.2.1 – 0.6.17] — uncut

### Added
- **The four questions are the user's now, not constants.** Roman, standing:
  *"those 4 questions should be determined by the user, our CLI should be super
  customisable."* Each was hard-coded and unreachable from a flag, a variable or
  a file:

  | question | was | now |
  |---|---|---|
  | when is a task **DONE** | an inline rule in `turn.mjs` — any verification command exiting 0 closed the run after one grace round | `--done verified\|acceptance\|never` · `ACUVO_DONE` |
  | what may it **COST** | `DEFAULT_BUDGET_USD` | `--budget` (already existed) — now **crash-safe**, below |
  | **ASK or ACT** | `MAX_QUESTIONS = 3`, and `ACUVO_APPROVE` read straight from the env with nothing above it | `--approve auto\|always\|never` · `--max-questions 0-10` |
  | what to do when **STUCK** | an inline rule in `turn.mjs` — nudge once per loop, hard-stop on a repeat only under `--until-done` | `--on-stuck nudge\|stop\|ask` · `ACUVO_ON_STUCK` |

  ⭐ **One mechanism, not four.** All of them resolve through `lib/rcfile.mjs`,
  which already owned the precedence **flag > env var > `~/.acuvo/config.json` >
  `.acuvo/config.json` (this repo) > built-in default** — so they inherit its
  monotone-narrowing rule for free: a cloned repository may ask for *more*
  review and *fewer* interruptions, and is refused outright if it tries to
  answer DONE or STUCK, neither of which has a stricter direction.
  ⚠️ **Nothing changes for anyone who sets nothing.** Every default is the
  module's own constant rather than a retyped copy, and an unconfigured run
  resolves to an **empty** override object — nothing is applied at all.
  `test/four-questions-config.test.mjs` pins both.
- **`acuvo config`** — prints the four answers in force **and the layer that
  decided each**, because a knob nobody can find is not configurable. `--json`
  for the machine-readable form.
- **The cost ceiling now survives a crash.** It was enforced by a closure that
  died with the process: kill the terminal mid-round and the next invocation
  started a fresh meter at $0.00 against the same ceiling, so `--budget 0.50`
  meant *"fifty cents per surviving process"* and the ceiling got **looser the
  worse things went**. Runs now append their spend to `.acuvo/spend.jsonl`, keyed
  on the sticky session id that already survives a crash (it is what keeps the
  prompt cache warm across a resume), and a resumed run carries both the spend
  **and the tighter of the two ceilings** — so a crash cannot be a way to spend
  more. Proven on disk: a process spent $0.049 of a $0.05 ceiling and was killed;
  the next one, started with **`--budget none`**, still resolved to a $0.05
  ceiling with $0.049 already spent.
  ⚠️ An **unreadable** journal stops the run rather than silently starting a
  fresh ceiling (`policy.mjs`'s absent-is-not-malformed rule); a **half-written
  final line** — which is exactly what a crash leaves — is skipped, not fatal.
  ⚠️ `budget.mjs` still imports no `fs` and reads no clock: the reader and the
  appender arrive as arguments, which is why the whole resume rule is provable
  for $0.00.

- **`acuvo rewind` — undo what the agent did to your files.** Every run now
  copies the previous contents of each file it writes or deletes into
  `.acuvo/checkpoints/` (content-addressed, so ten rounds rewriting one file
  store one copy per distinct version) and prints one line when it finishes:
  `· checkpoint 20260814-084541-84u8 — 3 files can be put back`. `acuvo rewind`
  lists them; `acuvo rewind <id>` puts the tree back the way it was **before
  that run started**, including **deleting the files the agent created**, which
  `git checkout` cannot do because they are untracked. No model call, no cost,
  no API key, and it works in a directory that is not a git repository at all.
  Proven end to end on a real run: `math.mjs` rewritten, `README.md` created,
  `stale.txt` deleted — one command restored all three.
  ⚠️ **It refuses any file you changed yourself after the run.** Each entry
  records the sha256 of what the agent left; if the file on disk is not that, it
  is skipped with the reason, because a rewind that threw away your edit would
  be the accident rather than the fix. `--force` overrides and prints every such
  path as FORCED. A rewind that restored nothing because everything conflicted
  exits **3**, never 0 — `acuvo rewind <id> && npm test` must not test the tree
  it was asked to undo.
  ⚠️ **The bug only a real command line could find (twice, for $0.006):**
  written first with the `argv[0]` anchor `board` and `verify` use,
  `acuvo --dir <ws> rewind` did not dispatch — the word fell through as a TASK
  and a paid agent session read the workspace and did nothing. The verb is now
  claimed as the first POSITIONAL. `board`, `verify`, `leases` and `spend` still
  carry the original defect.
  ⚠️ **And the second one:** `evaluate` writes its snippet through the executor
  and deletes it with raw `unlinkSync`, so the first real run announced "3 files
  can be put back" when the user had two. The tool's own scratch file is now
  excluded by the pattern `evaluate.mjs` itself exports.
- **`--no-checkpoint`** turns the recording off; it is on by default, off
  automatically under `--dry-run`, and creates nothing until a run mutates
  something.
- **`delegate` — read-only subagents.** Hand a research question to a helper
  with its own fresh context and get back a ~900-character summary instead of
  everything it read. The helper is offered **twelve tools, every one a read**
  (`SUBAGENT_TOOL_NAMES`); it cannot write, edit, commit or run anything, it is
  capped at 6 rounds (4 by default), and **it cannot delegate again** —
  `MAX_SUBAGENT_DEPTH` is 1, because two levels is how a five-round task becomes
  a hundred model calls nobody authorised. It refuses rather than guessing when
  no credentials reached the dispatcher.
  ⚠️ **The bug that only a real run could find:** the dispatcher passed
  `depth + 1`, so the top-level `delegate` refused *itself* with "a helper cannot
  delegate again (depth 1)". All thirteen unit tests passed — every one called
  `runSubagent` directly and none came through the dispatcher.
- **`remember` / `forget` — facts that outlive a run.** One markdown file per
  fact in `.acuvo/memory/`, read back into the next session's prompt, so a run
  does not rediscover your real test command. Markdown on purpose: **these files
  are meant to be committed**, so they are diffable and reviewable in a PR — and
  that is exactly why a fact that pattern-matches a credential is refused
  outright rather than redacted. Bounded at 40 entries / 4,000 bytes / 400
  characters a fact, oldest evicted; every fact must carry a `why`, because a
  fact with no provenance cannot be judged later and a wrong memory is worse
  than no memory.
- **`--budget <usd>` and `--until-done`.** `--budget` stops before the round
  that would cross the figure you named (`0.50`, `25c`, `$2` all parse) and
  **refuses to start when it cannot afford one round** (`reason: "too-small"`)
  rather than spending money to discover it had none. `--until-done` keeps going
  while your declared criterion is unmet, the budget allows, and the loop is not
  going in circles — it **requires `--budget`, and there is no unbounded mode.**
- **`--doctor`.** Says what is actually working on this machine — key, model
  chain, every media endpoint, which tools would be offered, which command
  presets are enabled, git — with no API key, no network and no completion
  spent. Every dark or broken line names the exact variable that fixes it. Exit
  0 only when nothing is broken, so it works in CI; `--doctor --json` for the
  machine form.
  ⭐ **`MODAL_VIDEO_SECRET` is why this exists and it had been documented
  nowhere.** It is not a URL, so it never appears in an error about a missing
  endpoint: a correctly-set URL *without* it answers HTTP 200 with
  `{ok:false,error:"unauthorised"}` and reads like a broken service. Its absence
  made four working tools look broken. The doctor now separates **live**
  (reachable *and* authorised) from **dark** (unset) from **broken** (set, not
  answering).
- **`--replay <id>`.** Step through a saved run — every round, call, result and
  refusal. Runs nothing, writes nothing. `--only refusals|writes|runs|effects|
  reasoning` narrows it; `--replay <a> --diff <b>` compares two runs of the same
  task and names where they split.
- **`--design <file.html>`.** The design loop without the agent: render the
  page, look at it, print a verdict — and the actual pixels if your terminal
  speaks kitty or iTerm2.
- **Voice, file in and file out.** `--task-audio <file>` transcribes an audio
  file and runs what it says — **showing the transcript first and waiting**, so
  you can press Enter to cancel, `y` to run, or type a correction to fix a
  mis-heard word without retyping the task. `--say` speaks the closing verdict
  into a `.wav`. `--yes` is required to skip the confirmation, and required in a
  pipe, cron or CI where there is nobody to ask.
- **Command presets — other languages, off by default.** `python`, `go`, `rust`,
  `ruby`, `make` and `node-bin` add vetted build/test drivers (`pytest`, `go`,
  `cargo`, `rspec`, `make`, `eslint`/`prettier`/`jest`) on top of the fixed four.
  ⚠️ **`.acuvo/commands.json` may name presets and nothing else**, because that
  file lives in the workspace and the agent can write to the workspace — a grant
  of an arbitrary binary there would be the agent granting itself a program. An
  arbitrary binary can only be named in `ACUVO_ALLOW_COMMANDS`, in the parent
  environment, which the agent has no verb that reaches. Shells are refused at
  every layer including that one. A refusal now names the preset that would have
  allowed the command, instead of only saying no.
- **`run_program` — run a program with a REAL argument array.** One of the
  unreachable tools the wiring pass left out as
  "a product decision". `run_command` takes a *string* and cannot tell
  `node app.js add "buy milk"` from a model composing a second command, so it
  refuses the quote — which meant the agent could not execute the flags and
  arguments it had **itself just written**. Measured in three probe runs; two of
  them responded by documenting output that had never been produced. Each item
  of `args` is now exactly one argv slot, `shell: false`, nothing re-parses it.
  Same four binaries, same `validateCommand` (imported, never re-declared), same
  bounded spawn and scrubbed environment; withheld by `--no-run` and `--dry-run`
  at the offer *and* at the dispatcher. **Proven live on its first real
  opportunity:** the model chose it unprompted in round 2 of a fresh task and
  the run came back `✔ VERIFIED — node --test test/fizzbuzz.test.mjs exited 0`.
- **Fourteen tools the model could not previously reach.** `read_lines`,
  `read_around`, `fetch_url`, `plan_start`/`plan_step`/`plan_status`,
  `declare_acceptance`/`check_acceptance`, `list_sessions`, `read_skill`, and
  `find_definition`/`find_references`/`check_types`/`list_symbols`. Seven
  finished, tested modules were imported by nothing on the runtime path; they
  are now declared, dispatched, offered per round budget, and rendered to the
  model in a form it can act on. All multi-round only — in a single-shot turn
  every one of them is a dead button, and the offer still returns exactly
  `write_file` and `generate_image` for `--max-rounds 1`.
- **Skills.** `.acuvo/skills/*.md` — your team's procedures, no pull request
  needed. The catalogue (name, description, when) goes in the system prompt; the
  body loads only when the model calls `read_skill`. Measured 2026-08-11 with a
  three-rule skill and a task that never mentioned skills: `read_skill` was the
  model's **first** tool call and all three rules were obeyed.
- **The plan countdown.** With a plan recorded, every round now carries
  `plan: 1/3 done · 2 remaining: … · round 4 of 5`, in the conversation and in
  the tool results. No plan file means byte-identical behaviour to before.
- **Acceptance.** A **declared** criterion decides the exit code; a **derived**
  one (read out of your own task text) reports and never gates. Both are now in
  `--json` as `.acceptance` with `source`, `gating`, `verdict` and `unmet` —
  previously a run could emit `verification.passed: true` while the command the
  user actually named had failed, with nothing in the document to say so.

### Changed
- **The round ceiling is 16, raised from 8** (`MAX_ROUNDS_LIMIT`,
  `lib/cli-args.mjs`). The default is unchanged at 5. What made it safe
  was compaction — the constraint was never the round count, it was a
  transcript that grew without bound, and a 15-round session could not have
  existed under the old ceiling. `--budget` is the bound that actually matters
  to whoever pays: dollars, not a counter.
- **The repository is public.** `github.com/xxiautomate-star/acuvo-code` is open
  and clonable — verified by cloning it into an empty directory and running both
  the CLI and the suite out of the result; the clone carries `bin/`, `lib/`,
  `test/` and `bench/`, and there is no `node_modules` to fetch. The README and
  ENTERPRISE.md both said the URL 404s, which was true when written.
  ⚠️ **What is published is one squashed 0.2.0 commit and is well behind**: cloned
  and run, it is **1,192 tests with 4 failing** (`bundle.test.mjs` and
  `docs-truth.test.mjs` fail at file level, plus a `STUCK_PATTERNS` assertion)
  against 1,378 and 0 here. Documented rather than left for a stranger to find.
  **Neither `acuvo-code` nor `acuvo` is on npm**, so there is still no
  `npm install -g`.

### Fixed
- **⚠️ Documentation that had gone false, struck rather than quietly edited.**
  The README advertised a single-file bundle — `npm run bundle`, and a
  measurement, *"Verified 2026-08-11: 1,228,642 bytes, 42 modules · 13 node
  builtins · 1 inlined asset"*. **No such run ever happened.** `package.json`
  declares the script and `scripts/bundle.mjs` was never written, so the command
  exits 1 with `Cannot find module`, and all 44 tests in `test/bundle.test.mjs`
  skip themselves. A byte count nobody measured is the worst kind of
  documentation, because it reads as the most rigorous line on the page.
  Also corrected: "455 tests" (there are **1,378** across 61 files — 1,333 pass,
  45 skipped, 0 fail), "fifteen more tools" (**36** are registered), the
  `MAX_ROUNDS_LIMIT` = 8 stated three times in ENTERPRISE.md, and ENTERPRISE.md
  §5.2's "we have neither sub-agents nor task delegation" — both halves false
  since `delegate` shipped.
- **`.acuvo/` was documented as a directory to gitignore wholesale.** That would
  throw away the three things in it meant to travel with the repo: `skills/`,
  `memory/` and `commands.json`. The ignore rule in the README now keeps them.
- **⚠️ A SILENT GREEN: a failing test suite reported as exit 0 with no output.**
  `node --test` sets `NODE_TEST_CONTEXT` in every child. A nested `node --test`
  that inherited it believed it was a test *worker*, stopped printing TAP, and
  wrote a serialised stream to a parent that was not listening — so
  `run_command` returned **exit 0 and zero bytes** for a suite that failed.
  Measured side by side against the identical failing file, before the fix:
  `run_command → exit 0 · 0 bytes`, `run_program → exit 1 · 951 bytes`.
  `spawn-argv.mjs` had found it and deleted the variable locally, deliberately
  not touching the shared `scrubEnvironment` because a single-file lane must not
  change another verb's behaviour. Correct then; wrong once both verbs shipped —
  two spawners disagreeing about whether a suite passed is worse than either
  being wrong, and the disagreement was invisible until both ran. Now deleted in
  `scrubEnvironment`, so `run_command`, `run_program`, `evaluate` and `git` all
  agree. For an ordinary CLI user the variable is never set and this is a no-op.
- **The summary contradicted itself two lines apart.** A run with a declared
  criterion and no model tool calls printed
  `⚠ NOTHING WAS RUN … no command was executed this session`, and then, two
  lines below, `✖ UNMET — you asked that npm test pass; it ran and exited 1`.
  The acceptance sweep spawns the criterion at the end of the session, which is
  correctly kept out of `verification` — but the *sentence* claimed nothing had
  executed. The verdict is unchanged (a sweep run must never be able to turn a
  NOT-VERIFIED into a VERIFIED); only the sentence now tells the truth.
- **`run_program` counts as a run.** Third time for this defect: the list was
  keyed on the *name of the tool* rather than on whether a process ran, so a
  session that verified itself entirely through `run_program` would have been
  summarised as unverified. Its `command` is synthesised from `argv`, and it is
  excluded from the stale re-run — re-running a joined argv as a string would
  hand it straight back to the parser the tool exists to avoid.
- **A name collision between two different `run_program`s.** `acceptance.mjs`
  already listed `run_program` in its satisfying tools — meaning the *browser*
  client's verb, which returns `{command}`. The CLI's returns `{argv}` and no
  `command`, so the judge silently skipped our records and the sweep re-ran a
  criterion the session had already satisfied. `runSession` now translates,
  rather than teaching the judge a second shape it cannot see the other half of.
- **`check_acceptance` now counts as a run.** A criterion the model checked and
  watched exit 0 was reported as "nothing in this run satisfied it", re-run a
  second time by the end-of-run sweep, and then summarised as
  "⚠ NOTHING WAS RUN, so nothing here is verified". Every word of that was
  wrong: the bookkeeping was keyed on the *name of the tool* rather than on
  whether a process ran. Same defect `evaluate` had, one tool later.
- **The audit log's `model.answered` is no longer `null` on every run.** The
  session reported only the model that was *requested*, while `chain.mjs` fails
  over across up to four candidates — so a buyer asking "which model saw our
  source code" got no answer. Each round now records the model that replied, and
  the session carries the last one. Still `null` rather than guessed when
  nothing reported one.
- **Language-server tools are no longer offered where they cannot work.** The
  gate asked only "is any server installed". Measured on the integrating
  machine: a zero-dependency JavaScript package offered all four LSP tools
  because `rust-analyzer` sat on `PATH` from unrelated work, and every call
  could only answer "typescript-language-server is not installed". The gate is
  now the intersection of *installed* and *a language this project contains*.
- **Read results no longer arrive as escaped JSON.** `read_lines`,
  `read_around`, the four LSP verbs, `read_skill`, `fetch_url` and the plan
  tools were rendering through the generic `JSON.stringify` fallback — every
  newline a literal `\n`, cut to 2,000 characters against `read_file`'s 8,000.
  A model cannot copy an `edit_file` old\_string out of that. For `read_skill`
  it was also a security regression: the wrapper stating that a skill grants no
  tool and lifts no restriction was being stripped off.
- **The offer probes the workspace, not the shell's current directory.** A
  `--dir` run decided whether to show `read_skill` and the LSP tools by looking
  at wherever the operator happened to be standing.
- **`--no-run` is enforced at the dispatcher.** The flag withheld
  `check_acceptance` from the schemas, but a model can still emit a call for a
  tool it was never shown — a resumed session or a provider echoing an old tool
  list will do it. It is now refused where the command would be spawned.
- **ENTERPRISE.md §3.2 said the prompt ships `.env`. It does not, and had not
  for some time.** The audit read `CONTEXT_SKIP` and concluded from the
  constant; the guard is one line further on, in `gatherWorkspaceContext`, which
  runs every candidate through `refusedCommitPath` — the exact fix that section
  recommends. Re-measured on a fixture and pinned by a test asserting both
  directions. **MVP-PLAN.md said `--parallel` was not built**; it is, and was
  run end to end.

### Added
- **MCP client.** Connect to any Model Context Protocol server declared in
  `.acuvo/mcp.json`. Tools are namespaced `mcp__<server>__<tool>` so a remote
  tool can never shadow a local one. Verified live: the model called a tool we
  did not build and used the result.
- **`see_page`.** Renders HTML you wrote in a real browser, saves the screenshot
  into your workspace, and reports measured layout problems — invisible text,
  overflow, cramped sections. The edge is the **return value**, not the browser:
  it hands back a short measured verdict instead of an image. Measured
  2026-08-10 against a live Playwright MCP server, same page: **89 tokens
  against 3,072**, and the model never has to interpret its own screenshot.
- **Run lifecycle.** `--sessions` lists saved runs; `--resume <id>` / `--continue`
  carry one on by **rebuilding** the conversation, never replaying it — no file
  is rewritten and no command is re-run. `--no-session` opts out.
- **Audit log.** Every run appends one redacted JSON line to
  `.acuvo/audit/<date>.jsonl`: what was asked, what changed, what verified, what
  it cost. No file contents, no command output, no model prose, and secrets are
  pattern-redacted first. `--no-audit` opts out; `--dry-run` writes neither file.
- **`make_document`, `transcribe`, `speak`.** HTML → PDF/PNG/PPTX; audio → text
  with timestamped segments; text → audio.
- **`evaluate`.** Run a JavaScript snippet and see what it prints. Replaces
  `node -e`, which cannot work here because a command may not contain quotes.
  It is a **second code-execution path** and does not go through the command
  whitelist — `--no-run` and `--dry-run` both stop it, and the README's security
  section now says so instead of listing four programs and stopping.
- **Model chain.** Four **model ids** through one endpoint and one credential —
  not four vendors — with attempts bounded at four. A rate limit falls
  through; a bad key stops immediately. An empty HTTP 200 counts as a failure.
- **Streaming.** The model's reasoning appears as it arrives instead of after a
  20-second silence.
- **Project memory.** `ACUVO.md` (or `CONVENTIONS.md` / `AGENTS.md`) is read at
  the start of every session and its conventions are followed.
- **Git verbs** — `git_status`, `git_diff`, `git_log`, `git_commit`.
- **`delete_file`**, and **`--version`**.
- **Image generation is built in.** No configuration required.
- **Standalone test suite** — `npm test`, no network, no API key.

### Changed
- A passing command no longer ends the turn. It buys one closing round, so a
  task that says "fix it, then commit it" reaches the second half.
- The loop batches independent reads rather than spending a round on each.

### Fixed
- The summary reported "NOTHING WAS RUN" after a successful `evaluate`.
- `--version` required an API key — the first command anyone runs after
  installing refused to answer until they configured an account.
- Relative imports failed inside `evaluate` because the snippet was staged in a
  subdirectory while the tool description promised they worked.
- MCP servers could not start on Windows (`npx` is `npx.cmd`; ENOENT, then a
  bare shell script, then EINVAL). Now routed through node's own entry point.

### Security
- **`--dry-run` and `--no-run` now stop the MCP spawn.** They did not. A
  committed `.mcp.json` in a cloned repo was launched before a single file was
  read, under the two flags documented as the cautious ones — a false guarantee
  is worse than no flag, because it is the advice a careful person follows.
  Reproduced under both flags with a hostile config, and reproduced again
  without them to confirm the ordinary path still connects.
  ⚠️ **Still open:** an ordinary run with no flags spawns it with no prompt and
  an unscrubbed environment. Cloning an untrusted repo and running `acuvo` in it
  is user-level RCE today. See `ENTERPRISE.md` §3.1.
- MCP servers come only from a file the user wrote. There is deliberately no
  tool that lets the model add one, and a test asserts no such export exists.
- `git_commit` requires explicit paths. There is no "commit everything".
- `.env`, `*.pem` and `id_rsa` are never staged, whatever `.gitignore` says.
- Git commands are refused when the workspace sits inside a larger repository —
  git walks upward, so operating from a subdirectory would commit the whole
  outer project.

## [0.2.0] — 2026-08-10

First release intended to be installed by someone other than its author.
Added a licence, a README whose every command was run before it was written, a
`files` allowlist, and a test suite that works on a fresh clone.

## [0.1.0]

Internal. Write, run, read the failure, fix it.
