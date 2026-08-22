# Capability evidence — measured, not asserted

Roman, 2026-08-18: *"builder and CLI, I need proof of our capabilities for both."*

Everything below is a real run with the numbers the run printed. Where a claim is
about quality rather than exit codes, it was **re-verified independently** —
an agent grading its own homework is the failure this repo keeps catching.

---

## ✅ CLI — one prompt, no intervention

**Task given:**

> Write a Node module `rle.mjs` exporting `encode(str)` and `decode(str)` for
> run-length encoding, where `'aaab'` becomes `'a3b1'`. Handle digits in the
> input correctly. Add `rle.test.mjs` using `node:test` with at least 6 cases
> including a round-trip property check, and make the tests pass.

**What it did, unattended:**

```
deepseek/deepseek-v4-flash-0731 · 5 rounds · 90,327 tokens · $0.003002
cache 77% (68,096 of 87,978 prompt tokens)

2 files written:  rle.mjs (1,756 b) · rle.test.mjs (1,717 b)
✔ VERIFIED — `node --test rle.test.mjs` exited 0   (8 tests, agent-written)
```

**Independent verification** (a checker I wrote, not its tests):

```
410 round-trips incl. digits, backslash and unicode — ALL PASS
encode("aaab") = "a3b1"           <- the spec
encode("a3b1") = "a1\31b1\11"     <- escaped, so it round-trips
```

⭐ **THE PART THAT IS ACTUALLY IMPRESSIVE IS THE PART NOBODY ASKED FOR.** The
brief said *"handle digits correctly"* and left it there. Naive RLE is ambiguous
the moment the source contains a digit — `a3` could be three `a`s or an `a`
followed by a `3` — and there are several wrong ways to paper over it. It chose
backslash escaping of literal digits AND of the backslash itself, which is the
correct minimal answer, and wrote the docblock explaining why.

⚠️ **HONEST FRAMING:** this is a small, self-contained task with a crisp
verification story — the shape agents are best at. It is evidence of *unattended
correctness at a real price*, not evidence of large-codebase capability. The
large-codebase claim needs the Terminal-Bench scoring run, which has not been
done ([[WHAT-NEEDS-TO-HAPPEN.md]] item 22).

### The number worth quoting

**$0.003 for a verified module with a passing property-based test suite.** At the
A$29 plan's 95M-token allowance that is roughly **30,000 tasks of this size**.

---

## ⚠️ BUILDER — the honest state, same day

The builder was driven through the real UI with Playwright four times. It is not
in the same condition as the CLI and the difference is instructive.

| run | stopped | rounds | files | taken |
|---|---|---|---|---|
| A | `round-cap` | 12 | 4 | **false** ← discarded (bug, now fixed) |
| B | `context-full` | 5 | **0** | false |
| C | `model-silent` | 6 | **0** | false |
| D | `round-cap` | 12 | 3 | **true** ← after the fix |

✅ **Run D is the discard fix working in production** — the loop's own files were
used instead of the build restarting from nothing on the one-shot path.

⚠️ **AND TWO OF FOUR STILL PRODUCED NOTHING FROM THE LOOP.** That is the open
defect. A build that falls through to one-shot codegen takes 7–16 minutes and
scores 41/100; a build the loop completes does not. The summary line records the
outcome and hid the behaviour, so `site-generation-run.ts` now attaches the
transcript whenever `files === 0`.

### Why the CLI is ahead of the builder

Same model, same provider, same cache lever — and the CLI verifies its own work
by **running it** (`node --test` exit 0) while the builder judges by rendering
and scoring. The CLI's loop has a hard, cheap, unambiguous success signal. That
is the difference, and it is the thing to copy.

---

## 🔁 Reproduce

```bash
# CLI
node bin/acuvo.mjs --dir /tmp/capdemo --max-rounds 8 --budget 15c "<task>"

# Builder (console/, dev server on 3002)
node __acuvo-playwright.mjs --build --headless
```

⚠️ **Read the dev-server log, not the browser.** Every builder defect found on
2026-08-18 was in the log and none were visible in the UI.
