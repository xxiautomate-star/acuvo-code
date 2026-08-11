# Changelog

All notable changes to Acuvo Code. Dates are AEST.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- **Model chain.** Four **model ids** through the one OpenRouter endpoint and
  key — not four vendors — with attempts bounded at four. A rate limit falls
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
