# Acuvo Code on Terminal-Bench 2.1

The Harbor adapter that lets an independent benchmark score this CLI.

## Why

Every claim about where Acuvo Code ranks has been an **estimate**. Our own bench
(`bench/run.mjs`) says **11/13 tasks for $0.0103** — that proves the loop works
and says nothing about how it compares to Codex CLI or Claude Code, because it
is our bench measuring our own idea of a task. Terminal-Bench is the number
other people can check.

## The install is one clone, and that is the point

Every other adapter in this ecosystem installs a dependency tree: nvm, node,
`npm install -g <agent>@latest`, then a transitive graph resolved inside a
container with a cold cache. Acuvo Code has **zero dependencies**, so installing
it is `git clone` and nothing else — the same property we sell to an enterprise
("nothing to audit but this package"), showing up as an install step that cannot
break on a registry outage.

## ⚠️ It is scored with `--shell`, and that must travel with the number

Terminal-Bench tasks are largely *install this, compile that, grep the log* —
work the default allowlist (`node`, `npm`, `npx`, `tsc`) refuses **by design**.

- Scored **without** `--shell`, the number measures our safety policy, not our loop.
- Scored **with** it, we are reporting a mode that is **not the default install**.

Both are true, so both get said. Quoting the score without the flag would be
dishonest in the flattering direction.

## Run it

```bash
uv venv .venv
uv pip install --python .venv harbor
uv pip install --python .venv -e .

# ⭐ Costs nothing, needs no Docker: does harbor still accept the adapter?
.venv/Scripts/python.exe verify.py     # posix: .venv/bin/python verify.py

export OPENROUTER_API_KEY=sk-or-v1-...
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path acuvo_terminal_bench:AcuvoAgent \
  -m openrouter/deepseek/deepseek-v4-flash-0731 \
  --jobs-dir ./results \
  -n 4
```

**Docker must be running**, and each task pulls its own container image — budget
disk before a full run, not after.

## ⚠️⚠️ The published examples are out of date

Blog posts and third-party adapter repos implement
`_install_agent_template_path` / `create_run_agent_commands` and import
`ExecInput` from `harbor.agents.installed.base`. Against the harbor on PyPI
today **`ExecInput` is not in that module**, and the abstract methods are
`install`, `run`, `name`.

An adapter written from those examples **imports cleanly and fails the moment
harbor instantiates it** — after the images are pulled and the trial has
started, i.e. after the expensive part. That is what `verify.py` is for:
`py_compile` proves nothing, because a wrong-but-importable adapter compiles
perfectly.

## What `verify.py` pins

Nineteen checks, no Docker, no spend — including that `AgentContext` still has
`cost_usd`. An adapter that sets `context.cost` on a model whose field is
`cost_usd` reports **every run as free**, and free is the most flattering
possible way to be wrong.
