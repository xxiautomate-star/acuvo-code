# Parity map — Claude Code · Codex · Gemini CLI · Cursor vs Acuvo (CLI + builder)

Written 2026-09-27 on branch `terminal/slim-harness-parity`. Rival cells come from
LIVE reads that day (sources below); Acuvo cells were read off the code with a
`file:line`. **Re-read the sources before quoting this in a comparison** — rivals
ship weekly (Claude Code was at v2.1.283 on 2026-09-25; Codex at 0.157.1 on 2026-09-26).

Legend: **L** live · **P** partial · **—** missing · **n/a** not applicable to that surface ·
**?** could not be verified live (search quota ran out; marked rather than guessed).

## Sources (read 2026-09-27)

| product | where |
|---|---|
| Claude Code | code.claude.com/docs/en/{changelog, hooks, sub-agents, headless, mcp, checkpointing, workflows, tools-reference, sandboxing, github-actions, code-review, plugins/overview} |
| Codex | github.com/openai/codex/releases (0.157.1, 2026-09-26); learn.chatgpt.com/docs/codex/cli (the old developers.openai.com/codex 308-redirects here) |
| Gemini CLI | github.com/google-gemini/gemini-cli README |
| Cursor | cursor.com/docs/cli/overview; cursor.com/changelog |
| Aider | aider.chat/docs (modes, lint-test, watch) |
| MCP servers | developers.figma.com/docs/figma-mcp-server · canva.dev/docs/connect · developer.adobe.com/firefly-services · docs.higgsfield.ai · github.com/ahujasid/blender-mcp · github.com/microsoft/playwright-mcp · github.com/ChromeDevTools/chrome-devtools-mcp · developers.notion.com/docs/mcp · replicate.com/docs/reference/mcp · npm registry (replicate-mcp 0.9.0 Apache-2.0; @notionhq/notion-mcp-server 2.5.2 MIT; chrome-devtools-mcp 1.10.1 Apache-2.0) |

## The matrix

Acuvo CLI paths are under `acuvo-code/`; builder paths under `console/lib/`.

| feature | Claude Code | Codex | Gemini | Cursor | **Acuvo CLI** | **Acuvo builder** |
|---|---|---|---|---|---|---|
| Headless one-shot | L `-p` | L `exec` | L | L | L `acuvo "<task>"` | n/a (web) |
| Structured final output | L `--output-format json`, `--json-schema` | L `exec --json`, output schema | L | ? | L `--json` (`bin/acuvo.mjs` jsonDoc) — no schema-validated output | n/a |
| **Streaming NDJSON events** | L `stream-json` | L `exec --json` | L | ? | **L (built today)** `--output-format stream-json` `lib/stream-json.mjs` | n/a (UI streams) |
| Resume / continue | L | L `resume` | L | L | L `--resume`/`--continue` `bin/acuvo.mjs:508,747` | L project thread |
| Project memory file | L CLAUDE.md (+AGENTS.md) | L AGENTS.md | L GEMINI.md | L rules | L ACUVO.md/AGENTS.md/CLAUDE.md/**GEMINI.md (today)**/.cursorrules `lib/project-memory.mjs:76` | L `agentic-workspace-memory.ts` |
| `/init` writes the memory file | L | L | L | ? | **L (09-28)** `/init` drafts ACUVO.md from disk, never overwrites `lib/session-commands.mjs` | n/a |
| Custom slash commands | L | L | L extensions | ? | L `.acuvo/commands/*.md` `lib/slash.mjs:209` | n/a |
| Built-in slash commands | L ~40 | L | L | L | L 23 `lib/slash.mjs` — **+`/init` `/memory` `/review` `/compact` `/context` `/usage` `/permissions` (09-28)** | n/a |
| Skills | L SKILL.md, auto-load | ? | — | ? | L 3 shelves `lib/skills.mjs:457` | L `builder-skills.ts:31` |
| Plugins / marketplace | L marketplaces | — | L extensions | — | P local plugins, grant file `lib/plugins.mjs:362`; no marketplace | — |
| **Hook events** | L 33 events | ? | L | L | **P → 9 (09-28)**: Pre/PostToolUse, **PostToolUseFailure**, Stop, **StopFailure**, SessionStart, UserPromptSubmit, PreCompact, **PostCompact** `lib/hooks.mjs` (Claude Code: 32) | — (`app-hooks.ts` is app webhooks, not agent hooks) |
| **Sub-agents** | L files in `.claude/agents`, 3 deep, 20 concurrent | L parallel tasks | — | L parallel agents | L `delegate` read/write/verify, 1 deep `lib/subagent.mjs:356` | P `delegate` built, **never offered in 13,035 rows** (`builder-tool-shortlist.ts:1789`) |
| **Named sub-agent definitions** | L | — | — | — | **L (built today)** `.acuvo/agents` + reads `.claude/agents` `lib/agent-definitions.mjs` | — |
| Multi-agent workflow scripts | L workflows (≤1,000 agents) | — | — | — | P `--parallel` ≤4, `--best-of` 2–5 `lib/best-of.mjs:212`, board/leases | — |
| Plan mode | L | L | L | L Plan mode | L `--plan` `lib/cli-args.mjs:1195`, plan ledger | L `plan_start/plan_step` core `builder-tool-shortlist.ts:123` |
| Permission / approval modes | L 5 modes | L approvals + `/permissions` | L trusted folders | L | L `--approve auto/always/never` `lib/diff-preview.mjs:181`, `--no-run`, `--shell`, `--allow-*` | P plan gate |
| OS sandbox | L Seatbelt/bwrap (no native Windows) | L incl. native Windows | L Docker/Podman | L | P Node `--permission` sandbox `lib/sandbox.mjs:160` (no kernel sandbox — documented) | L Modal sandbox |
| Checkpoints / rewind | L code+conversation | ? | L checkpointing | L | L code `lib/checkpoint.mjs:236`, `/rewind`; conversation half via `/resume` | L `project-version-snapshot.ts:20` |
| Compaction | L auto + `/compact` | L | L | L | L auto `lib/compact.mjs:849` + manual `/compact [tokens]` (same pass, prefix kept) | L |
| Background processes | L `run_in_background` | ? | ? | ? | L `start_process` `lib/tools.mjs:582` | L `process` (machine group) |
| Monitor (watch output) | L Monitor | — | — | — | P `wait_for_output`/`read_log` `lib/tools.mjs:604` | — |
| Worktrees | L isolation: worktree | L cloud tasks | — | L | L `git_worktree` `lib/tools.mjs:422` | n/a |
| MCP client | L | L | L | L | L 21 curated + any npm/URL `lib/mcp-add.mjs:67` — replicate/notion reachable as bare packages | L `agentic-mcp.ts`, OAuth `mcp-oauth.ts` |
| MCP server (expose itself) | L `claude mcp serve` | L `codex mcp-server` | ? | — | L `acuvo-mcp` + `acuvo mcp install` | L `agentic-mcp-server.ts` |
| LSP / code intel | L | ? | ? | L | L `find_references`… `lib/tools.mjs:680`, `rename_symbol` | L `code_intel` `builder-tool-shortlist.ts:1090` |
| Notebook editing | L NotebookEdit | — | — | L | — | — |
| Web search / fetch | L | L `--search` | L | L | L `lib/tools.mjs:578-579` | L docs group `builder-tool-shortlist.ts:1341` |
| Image input | L | L `--image` | L | L | L `read_image` `lib/tools.mjs:580` | L attachments group |
| GitHub issue→PR | L Action + `@claude` | L `@codex review`, cloud | L Action | L Bugbot | P `--issue`, `gh_pr` `lib/tools.mjs:596`; **no Action** | L `github-pr.ts`, `github-push.ts` |
| Code review | L `/code-review`, managed review | L PR review | L Action | L Bugbot | L `review_code`, `--refute` | L `generated-code-review.ts` |
| Scheduled / cloud runs | L routines | L cloud tasks | — | L cloud agents | — (crons frozen by owner) | P app schedules only |
| Budget / spend ceiling | — | — | — | — | **L — ours alone** `--budget`, fleet budget | L plan metering |
| Repo map | P | ? | ? | L | L `lib/repo-map.mjs` | P |
| Watch mode (`AI!` comments) | — | — | — | — | — (Aider has it) | n/a |
| Voice in/out | ? | ? | ? | ? | L `lib/voice-task.mjs` | L av group |
| **Multimodal generation** | via MCP only | — | — | — | L `generate_image/video`, `speak`, `transcribe` + fal/engines | L image/av groups `builder-tool-shortlist.ts:767` |

### Multimodal tool classes reachable through MCP (2026-09-27)

| class | public API | MCP server | Acuvo today |
|---|---|---|---|
| Figma | yes | official remote Dev Mode MCP | nickname `figma` (figma-developer-mcp) |
| Canva | Connect API | no vendor-published one found | — (URL add works if one is found) |
| Adobe Express / Firefly | Firefly Services API | no vendor-published one found | — |
| Higgsfield | REST + SDKs | no vendor-published one found | creative engines; own engines |
| Hugging Face | yes | official `hf.co/mcp` (? page blocked; tools confirmed via connector) | catalogue `huggingface` |
| Blender | Python | `blender-mcp` (29.5k★) | catalogue `blender` `lib/mcp-defaults.mjs:704` |
| Browser | — | Playwright MCP (Apache-2.0), Chrome DevTools MCP | `playwright` (Chrome DevTools deliberately excluded) |
| Docs / sheets | Notion API | Notion official remote + npm | `acuvo mcp add @notionhq/notion-mcp-server` (bare package; no nickname) |
| Model zoo | Replicate API | official `replicate-mcp` | `acuvo mcp add replicate-mcp` (bare package; no nickname) |
| Voice | ElevenLabs | hosted MCP | own `speak`/voice engines |

## Ranked gaps — value for "build anything, any complexity" ÷ effort

| # | gap | value | effort | route | status |
|---|---|---|---|---|---|
| 1 | Context hooks (SessionStart, UserPromptSubmit, PreCompact) | high — team policy + context injection before spend | S | extend existing runner | **built** |
| 2 | Named sub-agents (`.acuvo/agents`, read `.claude/agents` as-is) | high — specialists; zero-rewrite import of Claude Code agents | M | wrap Claude Code's file format | **built** |
| 3 | `--output-format stream-json` | high — IDE/CI/SDK integration surface | S | same contract as Claude Code/Codex | **built** |
| 4 | `/agents`, `/hooks`, GEMINI.md | medium — discoverability, Gemini repos | S | providers | **built** |
| 5 | Curated `replicate` + `notion` MCP nicknames | medium — model zoo + docs in one word | S | integrate official servers | **reverted**: `KNOWN_SERVERS` must stay within the loader cap of 8 (`mcp-add.test.mjs` round trip); belongs in the `mcp-defaults.mjs` CATALOGUE instead — next |
| 6 | `/init` (write ACUVO.md from the repo) | medium | S (one paid turn) | slash `effect:'run'` | next |
| 7 | Manual `/compact` | medium | S–M (needs chat-loop access to messages) | reuse `compactMessages` | next |
| 8 | GitHub Action (`@acuvo` on issues/PRs) | high for teams | M | wrap `--issue` + `--output-format json` | **owner** (secrets, runner minutes) |
| 9 | Schema-validated final output (`--json-schema`) | medium | M | — | next |
| 10 | Notebook cell editing | low–medium | M | — | later |
| 11 | Watch mode (`AI!` comments, Aider) | medium | M | `fs.watch` + existing turn | later |
| 12 | Multi-level / concurrent sub-agents, workflow scripts | high at scale | L | — | later; spend-shaped |
| 13 | Scheduled / cloud runs | high | L | Modal/Coolify | **owner** (crons frozen) |
| 14 | Builder: agent hooks, named agents | medium | M | — | **blocked by byte ceiling + one-file artifacts** (see below) |

## What was built (CLI), and the evidence

All targeted tests green (203 + 124 across the touched clusters); every guard mutated
and shown to BITE, restored in a `finally` (7/7 killed). Driven in the real CLI:

- `printf '/hooks\n/agents\n' | acuvo --dir <ws>` lists the hooks per event and a
  `.claude/agents/reviewer.md` as `[read]`, reporting `WebFetch` and model `opus` as ignored.
- `acuvo --output-format stream-json "deploy with key sk-123"` in a workspace with a
  `UserPromptSubmit` gate: **5 stdout lines, all parse**, `init` → `memory` (GEMINI.md) →
  `SessionStart` hook → blocked `UserPromptSubmit` → `result` with `stoppedBecause:
  "prompt-blocked"`; **zero model calls**.
- ⚠️ Driving it found a real defect no unit test could: `rcfile.mjs` did not know
  `--output-format` decides `json`, so the config default `json:false` won and the banner
  and human lines went to stdout. Fixed (`FLAG_KEYS` + completion `FLAGS`), and pinned.

## The builder half — why nothing was added to it today

- **Byte ceiling:** root CLAUDE.md §2 records that no verb offered on every build can grow
  at all. Named agents would ride `delegate`, and `delegate` has **never been offered** (0 of
  13,035 audit rows) because our builds emit one-file artifacts — so a builder change here
  would be built-and-unreached, the defect this repo keeps shipping.
- **Hooks** in the builder are an owner-facing product decision (whose shell runs where, on
  Modal) — not a no-spend change.
- No `console/` file was changed on this branch, so the lever-9 payload is untouched.

## Owner decisions this map surfaces

1. **GitHub Action for Acuvo** (`@acuvo` on issues/PRs): needs a repo secret and CI minutes.
2. **Scheduled / cloud runs** (Claude Code routines, Codex cloud, Cursor cloud agents): crons
   are frozen account-wide.
3. **Builder decomposition into multi-file projects** — unlocks `delegate` and named agents
   in the builder for free (see §2 "our builds emit one-file artifacts").
4. **Plugin marketplace**: Claude Code and Gemini have one; ours is local-only.
