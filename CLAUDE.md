# acuvo-code/ — the Acuvo CLI (npm `acuvo-code`)

> Open your editor or CLI **here**, not at the repo root. At the root a tool
> walks 88 directories, 17 git worktrees and a folder dead since July, truncates
> the 53KB root CLAUDE.md, and starts 8 MCP servers configured for other
> projects — 5 of which fail. That is not the CLI being bad. That is the CLI
> pointed at the wrong directory.

## What this is

The coding agent — the reference is **Claude Code**, for the harness: how an
agent behaves while it works. Binaries: `acuvo` and `acuvo-mcp`.
**~130 tools · 179 source files · ~130k LOC · 403 test files.**

    node bin/acuvo.mjs --version
    npm i -g acuvo-code          # what a user runs

## ⚠️ A published version number is not a published build

`package.json` and npm matching proves nothing — it has been wrong before, with
46 commits of fixes behind a version nobody bumped. **Check the publish TIME
against the last commit date:**

    npm view acuvo-code time.modified
    git log -1 --format=%ad -- .

## Roman's six-point definition of CLI-done

Caching solid **even when models switch** · token amounts proper · **everything
gated** · the harness is exceptional · capabilities · **all integrations.**

⭐ Item 1's controllable half is CLOSED and tested
(`test/cache-survives-model-switch.test.mjs`, 86 cache tests green). **A cache
cannot cross a provider — that is physics, not a bug.** What is tested is that
*our own bytes* stay stable across a switch, so switching back is not also cold.

## The harness lessons that cost real runs

- **A loop watcher that reads tool calls is blind to a model repeating itself in
  prose.** Measured 2026-09-21: a real run spent all 24 rounds, 1.38M tokens and
  $0.025 restating one sentence over unique file reads, then died on the round
  cap having written **no report at all**. Every watcher was right by its own
  definition; the universe was wrong. `lib/stuck.mjs` → `findRestatedPlan`.
- ⭐ **The damage was not the wasted rounds — it was that the user paid and got
  nothing.** A run that hits the cap must still produce a deliverable.
- **`runSession` has five other callers** — the chat loop, `delegate`,
  `best-of`, `refute`, the MCP server. A default retyped in `turn.mjs` changes
  behaviour for callers that never asked. Every default is the module's own
  constant on purpose.

## Testing

    node --test test/<cluster>*.test.mjs     # target the cluster you touched

⚠️ **Do not run the full suite** (403 files). And mutate any guard you add —
a guard that cannot fail is not a guard.

## Where the rest lives

    ../console/    the builder (the web product)
    ../CLAUDE.md   company doctrine        ../acuvo/   ⛔ DEAD since 2026-07-03
