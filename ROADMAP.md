# Acuvo Code — roadmap

> What is shipped, what is being worked on, and what is deliberately not planned.
> No dates: this page states direction and status, and every "shipped" row below can be
> checked against the source in this package. Where something is half-built, it says so —
> a roadmap that only lists wins is a brochure.

---

## Shipped

These are in the package you have. Each names the module you can read.

| capability | what it does | where |
|---|---|---|
| **The write → run → fix loop** | executes what it writes, reads the real exit code and stderr, and fixes the cause rather than regenerating | `lib/turn.mjs` |
| **`see_page` verdicts** | renders HTML in a real browser and returns *measured* defects — contrast, overflow, invisible text — not a screenshot for the model to interpret | `lib/media.mjs` |
| **The budget governor** | projects the next round's cost before spending it, stops before crossing your ceiling, and refuses to start a run it cannot afford | `lib/budget.mjs` |
| **`acuvo verify`** | re-runs the exact command a past run watched exit 0, for free, and says whether the claim still holds | `lib/verification-command.mjs` |
| **`acuvo rewind`** | restores the tree to how it looked before a run, including deleting files the agent created; refuses files you edited yourself | `lib/checkpoint.mjs` |
| **Audit log and `--replay`** | one JSON line per run, redacted, and a full replay of what happened without re-executing anything | `lib/audit.mjs` |
| **Escalation** | `--until-done` retries in a fresh context and then in parallel, each rung on its own slice of the budget | `lib/escalate.mjs` |
| **The plan ledger** | a plan that belongs to the task, checked for coherence rather than restated each round | `lib/plan.mjs` |
| **Project memory and skills** | facts and procedures stored as reviewable markdown under `.acuvo/`, diffable in a PR | `lib/memory-workspace.mjs` |
| **MCP client** | connects to the servers you declare in `.acuvo/mcp.json`, with consent recorded per config fingerprint | `lib/mcp.mjs` |
| **LSP tools** | definitions, references, type checks and symbol listing, when a language server is installed | `lib/lsp.mjs` |
| **Fleet coordination** | file leases, a shared board, `--claim`, and a ceiling across every terminal in the workspace | `lib/lease.mjs`, `lib/board.mjs` |
| **`acuvo --login`** | one account, written once, used by every run after it | `lib/login.mjs`, `lib/account.mjs` |
| **`acuvo --doctor`** | line by line, what is live, dark or broken on this machine, and the exact variable that fixes each dark line | `lib/doctor.mjs` |

---

## In progress

Honest status, not intentions.

**Distribution.** The package is not on npm yet, so there is no `npm install -g` route.
Clone or `npm link` in the meantime — both are documented in the README.

**The media half, reachable on first run.** `see_page`, `speak`, `transcribe`,
`make_document`, `read_document`, `read_table`, `edit_image` and `expand_image` are built
and their services answer, but they are gated on a credential that `--login` does not
currently issue. Until it does, these are an extra you configure, not something you get
by installing. Two endpoints — face and the premium image engine — are genuinely absent
rather than merely gated.

**Language coverage.** The command layer allows a small, readable set of binaries, and the
per-language presets that widen it are off by default. A Python, Go or Rust project can be
written to but not tested until the preset for it is enabled. Widening this safely — a real
argument grammar per language, not a blanket allowlist — is the work.

**A reproducible public benchmark.** No score is published on any page in this package,
and none will be until the corpus, the command and the result can be re-run by someone who
is not us. Nobody in this category publishes a reproducible number; being first is worth
more than a figure nobody can check.

**A review gate before a write lands.** `--approve` asks about destructive writes today.
A hunk-level diff you accept or reject before it is applied is not built.

---

## Not planned

Stating these saves an evaluation.

- **An editor extension.** This is a terminal tool. Inline completion and in-editor
  hunk review are what Cursor and Copilot are for, and this does not compete there.
- **A sandbox.** The agent runs commands on your machine, with your permissions. The
  boundary is an allowlist small enough to read in an afternoon, and `ENTERPRISE.md`
  documents exactly what it does and does not stop. If you need isolation, run it in a
  container you control — the tool will not pretend to provide it.
- **Self-hosted model serving.** Models are rented, not run here.
- **Opening pull requests on your behalf.** `--issue` stops at a local branch and prints
  the commands. Model-authored code arriving in a review queue under a human's name is a
  process failure, not a feature.

---

## How to read a claim on this page

Every capability above names a module. If a claim and the source disagree, the source is
right and the claim is a defect — `test/docs-truth.test.mjs` fails the build when the
documented defaults drift from the exported constants, which is the only version of this
promise that stays true.

For the security posture, the confirmed defect list and the categories where other tools
beat this one outright, read `ENTERPRISE.md`.
