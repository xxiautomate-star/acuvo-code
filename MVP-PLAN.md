# Acuvo Code — the MVP, every layer

> Written 2026-08-10. Status of each item is **measured**, not estimated: ✅ means
> I ran it and watched it work, ⚠️ means built but unproven, ❌ means absent.
>
> ⭐ **The MVP bar, in one sentence:** a developer finds the repo, installs it in
> under two minutes, points it at their own project, and it does something on the
> first try that their current tool cannot do at all.
>
> Everything below either serves that sentence or is post-launch.

---

## 0. What this is, and what it is not

**It is not a cheaper Claude Code.** That framing loses: a developer running Cline
with their own DeepSeek key pays cost price and zero markup, so our price
advantage against the real competitor is **zero**. Measured: our whole 10-task
bench costs $0.0067, which is roughly what they would pay too.

⭐ **It is the terminal agent that can SEE, and that produces things that are not
code.** Two claims no competitor can make, both verified:

- `see_page` renders the HTML it wrote in a real browser and reads back measured
  defects. Cline, Aider and Claude Code are blind to their own output.
- One sentence → `invoice.pdf`, 147 KB, real PDF, via html → see_page →
  make_document. No coding involved.

⚠️ **The honest cost of that position:** it makes the tool harder to *position*.
"Terminal coding agent" and "creative tool" are different shelves. We keep the
media because it is already built and free to carry — not because it wins the
backend-engineer crowd. It will not.

---

## 1. Capability layer

| | status | note |
|---|---|---|
| write → run → read failure → fix | ✅ | 5/7 → 7/7 on the bench with **no model change** |
| Search (`find_files`, `search_text`) | ✅ | built in Node, never `new RegExp` on model input |
| Surgical `edit_file` | ✅ | ambiguous span REFUSED with the match count |
| `delete_file` | ✅ | its absence once captured an entire session |
| `evaluate` | ✅ | killed the `node -e` round tax — zero refusals on a full bench |
| Git verbs | ✅ | push/reset **inexpressible**; subdirectory trap refused |
| `see_page` | ✅ | the differentiator |
| `make_document` / `transcribe` / `speak` | ✅ | pdf/pptx/png, faster-whisper, Kokoro |
| `generate_image` | ⚠️ | baked in, **endpoint 502s** — Playwright fix committed, undeployed |
| MCP client | ✅ | model used a tool we did not build and wrote the answer to disk |
| Project memory (`ACUVO.md`) | ✅ | obeyed 3 conventions in one live run |
| Streaming | ✅ | tool-call fragments accumulated per index, tested at 7-byte chunks |
| Provider chain | ✅ | 4 providers; **empty HTTP 200 correctly retried** |
| Interactive sessions | ✅ | multi-turn; the re-sent prefix is byte-identical between rounds (100%, `test/cache-prefix-stability.test.mjs`) |
| **Parallel tasks** | ❌ | Roman has asked three times. Not built. |
| **Sub-agents** | ❌ | post-launch |

---

## 2. Install and distribution — *the layer that decides whether anyone tries it*

| | status |
|---|---|
| `bin` entry, zero dependencies, node ≥20 | ✅ |
| LICENSE (MIT) | ✅ — an unlicensed repo is legally unusable by whoever finds it |
| README with **verified** commands | ✅ — every command in it was run |
| `files` allowlist — 18 files, 82 kB | ✅ |
| Standalone tests (`npm test`, no network, no key) | ✅ 34 |
| `--version` / `--help` **without an API key** | ✅ — the first thing anyone runs |
| **A GitHub repo that actually exists** | ❌ **BLOCKER** |
| **npm publish** | ❌ decide: npm, or install-from-GitHub only |
| CI (tests on push) | ❌ |
| CHANGELOG | ❌ |
| Issue templates / CONTRIBUTING | ❌ |

⚠️ **The single biggest gap in this document:** the README says
`git clone https://github.com/xxiautomate-star/acuvo-code`. **That repo does not
exist.** Every other install detail is correct and the first command fails.

---

## 3. Terminal design — *the layer that decides whether they keep it*

⭐ Roman named this explicitly and it is under-built relative to capability.

| | status |
|---|---|
| Append-only output (pipes, `tee`, `>` all work) | ✅ deliberate — no alternate screen, no cursor addressing |
| Live streaming of the model's reasoning | ✅ bounded to 3 lines |
| Per-tool glyphs (`✎ ✂ · $ ✔ ✖`) | ✅ |
| Honest verdict line (`✔ VERIFIED` / `✖ NOT VERIFIED`) | ✅ and it caught itself lying today |
| Cost + tokens + rounds on every run | ✅ |
| **Colour** | ❌ everything is monochrome; no `NO_COLOR` support either |
| **Progress on long calls** | ❌ streaming covers the model, but a 60s `see_page` renders silently |
| **A final "what changed" diff** | ❌ we list files, never what changed inside them |
| **Error design** | ⚠️ refusals are excellent; crashes are a raw stack |
| **First-run experience** | ❌ no key → a wall of text. Should be one line and a link. |
| **`--json` for scripting** | ❌ |

---

## 4. GitHub and the developer's real workflow

| | status |
|---|---|
| Local git verbs | ✅ |
| Credential-file refusal (`.env`, `*.pem`, `id_rsa`) | ✅ |
| Subdirectory-trap refusal | ✅ |
| **Branch / checkout** | ❌ deliberate — but "work on a branch" is table stakes |
| **Push** | ❌ deliberate; needs an explicit `--allow-push` |
| **Open a PR** | ❌ the single most requested agent feature in this category |
| **Read an issue and fix it** | ❌ *the* killer loop: `acuvo --issue 42` |
| **CI-log-driven fixing** | ❌ post-launch |

⭐ `acuvo --issue 42` is the demo that sells this. Read the issue, branch, fix,
run tests, open a PR. Every piece except the GitHub API calls already exists.

---

## 5. Safety, and saying true things about it

| | status |
|---|---|
| No shell, character whitelist | ✅ |
| Four binaries, argument-checked | ✅ |
| npm script BODY validated before spawn | ✅ closes the best bypass in the package |
| Credentials scrubbed from children | ✅ |
| Path escapes refused (realpath, symlinks) | ✅ |
| MCP servers user-authored only — **no tool can add one** | ✅ asserted by test |
| README says plainly **"this is not a sandbox"** | ✅ |
| **Confirmation before destructive acts** | ❌ `delete_file` needs no approval |
| **Audit log of what ran** | ❌ printed, never persisted |

---

## 6. Economics — what the $29 plan must survive

Measured, not modelled: **$0.00067 per bench task**, $0.0067 for all ten.
Even a heavy user at 100 tasks/day is ~$2/month of tokens.

⭐ Code is not the expensive thing. Creative and voice are, and they are metered
separately (see `plan-catalog.ts` — three cost curves, three mechanics).

| | status |
|---|---|
| Cost printed per run | ✅ |
| Prompt caching — prefix stability 100% (asserted); provider-reported hit rate **46.7–95.8%, decided by routing** (measured 2026-08-14, n=4 real runs) | ✅ |
| **Usage counted against a plan** | ❌ the CLI is unmetered — a BYOK key today |
| **License/entitlement check** | ❌ |
| **BYOK vs managed decision** | ❌ **unmade, and it changes the product** |

⚠️ Today the CLI uses the user's own OpenRouter key, which means **it is free and
we earn nothing**. That is fine for launch and adoption, and it must be a
deliberate choice rather than an oversight.

---

## 7. The MVP cut line

**Ship when these are true, and not before:**

1. The GitHub repo exists and `git clone && npm link && acuvo --version` works
   from a clean machine.
2. `generate_image` actually returns an image.
3. First-run with no key is one helpful line, not a wall.
4. CI runs the 34 tests on push.
5. A CHANGELOG and a real README hero example.
6. One benchmark number published that anyone can reproduce.

**Explicitly NOT in the MVP:** parallel tasks, sub-agents, PR opening,
entitlements, colour, `--json`, audit log.

---

## 8. After publishing — the massive ideas

⭐ **`acuvo --issue 42`.** Read a GitHub issue, branch, fix, test, open a PR.
Everything but the API calls exists. This is the viral demo.

⭐ **The design loop as a product of its own.** We are the only terminal tool
that can look at a page. `acuvo --review ./site` — render every page, report
every invisible heading and overflow, fix them. Nobody ships this.

⭐ **Recipes.** `acuvo recipe meeting-notes recording.m4a` → transcribe →
summarise → PDF. The combinations already work; nothing surfaces them.

⭐ **Watch mode.** `acuvo --watch` fixes the failing test the moment it fails.

**Parallel terminals.** Roman's repeated ask: N tasks over one workspace with
conflict detection.

**The two-way MCP half.** Be an MCP *server*, so Claude Code and Cursor can call
Acuvo for the things they cannot do — render a page, make a PDF, clone a voice.
⭐ That turns competitors into distribution.

**A public benchmark.** Publish the corpus and our numbers. Nobody in this
category publishes reproducible results; being first is credibility that
marketing cannot buy.

---

## 9. The honest summary

The **capability layer is ahead of everything else** — nine features shipped
today, all verified by running them, none of which came from the model.

The **distribution layer is the bottleneck**, and it is unglamorous: a repo that
does not exist, no CI, no changelog, an image endpoint that 502s.

⚠️ And the thing no amount of building fixes: **zero users.** Every item above
makes the product better and not one of them distributes it.
