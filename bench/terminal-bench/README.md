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

## ⚠️⚠️ CONCURRENCY IS WHAT LOST THE LAST TWO RUNS

Measured, not guessed. `deep100` attempted 89 tasks, scored **16**, and lost
**63 to one fact** — `RuntimeError: Docker compose command failed`, the daemon
collapsing under concurrent containers on a Windows laptop. `run-fixed` lost 71
the same way. Every percentage quoted from those runs was arithmetic over the
survivors.

⚠️ **A crashed trial is invisible in the worst way.** It writes `exception.txt`
and no `reward.txt`, so it is neither a pass nor a fail — it simply is not there.
A run can read "37.5%" while three quarters of it never started.

**So:**

1. **`-n 1` on Windows.** `-n 4` is what killed both runs. Slower and finished
   beats faster and lost.
2. **Score honestly.** `node score.mjs <dir>` refuses to print a bare percentage
   when the run is incomplete, and groups the crash causes.
3. **Re-run what the HOST lost, not what you failed:**

```bash
node retry-crashed.mjs results/<run>            # what died on the host, and why
node retry-crashed.mjs results/<run> --command  # the harbor line, at -n 1
```

⭐ It separates a Docker collapse (retryable — the host gave up) from an
`AgentTimeoutError` (**not** retryable — that one is ours). Re-running a task
that genuinely failed would inflate the score, which is the opposite of the point.

⚠️ **The real fix is an x86-64 Linux host.** Until then every number here
measures Docker Desktop as much as it measures the agent. Not the Oracle ARM box
— the images are amd64 and emulation already made `apt` take 20+ minutes.

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

## ⚠️⚠️ IT DOES NOT PRODUCE A NUMBER ON THIS MACHINE YET (2026-08-12)

Two real runs, both zero signal. Recorded here because the next person will
otherwise spend the same afternoon.

**Run 1 — `-n 20`, 89 trials, 19 completed / 19 errored.** ⚠️ `-n` is
`--n-concurrent`, **not** the task count; `-l/--n-tasks` is the limit. Twenty
containers each apt-installing curl+git and pulling a **52MB node tarball** is
~1GB of concurrent download, and every trial died on `AgentSetupTimeoutError`.

**Run 2 — `-l 12 -n 2 --timeout-multiplier 2.5`, 6 completed / 6 errored.** The
concurrency was not the whole story. The exception text says it exactly:

```
Command failed (exit 2): ... curl -fsSL "https://nodejs.org/dist/..."
stdout: bash: line 1: curl: command not found
gzip: stdin: unexpected end of file
```

⭐ **`ensure_system_dependencies(("curl","git"))` did not actually leave curl in
the container.** So `install` cannot download node, and the trial dies before the
model is called once. It is not our agent failing tasks — the agent never ran.

### The fix, specified

**Stop needing the network inside the container.** Both of the things `install`
fetches can be handed to it instead:

- `dist/acuvo.mjs` is a **single 1.4MB bundle** (`node scripts/bundle.mjs`) and is
  the whole agent — no clone, no git.
- node itself is the only real dependency, and the tarball can be cached once on
  the host rather than pulled per container.

Harbor's installed-agent base exposes file upload; using it for both removes curl,
git and every network round trip from setup. That is also the honest version of the
claim this README already makes — "the install is one clone, and that is the
point" becomes "the install is one file".

⚠️ Until that lands, quoting any Terminal-Bench number for Acuvo Code would be
quoting an empty set.

## ⚠️⚠️ THIS RUNS ON SOMEBODY'S PERSONAL LAPTOP — RULES, NOT SUGGESTIONS

2026-08-12: a run here made the owner's machine unusable. *"I cannot even watch
Netflix, I can't even change tabs."* Twenty containers on 8 cores, and — the real
cause — **no `~/.wslconfig` at all**, so WSL2 (which is what Docker Desktop runs
on) helped itself to every logical processor and most of the 15.6GB of RAM.

⭐ The instruction was explicitly **not** "do less work". It was *"we need to be
able to control my laptop"*. So: a ceiling and a kill switch, never a smaller
ambition.

**Before any run:**

```bash
node scripts/machine.mjs status     # is a ceiling in place, and are we already running?
```

It refuses to start heavy work when `~/.wslconfig` sets no `processors=` and
`memory=` — a warning at the top of a two-hour unattended run is a warning nobody
is present to read.

**Run it quietly, and never above `-n 1` on this machine:**

```bash
node scripts/machine.mjs run -- .venv/Scripts/harbor.exe run ... -l 12 -n 1
```

`-n` is CONCURRENCY. `-n 20` is twenty containers, and it is what caused this.

**After any run — always:**

```bash
node scripts/machine.mjs stop       # containers, orphaned docker.exe, then the VM
```

⚠️ **Killing harbor does NOT clean up.** Measured: after `pkill harbor`, **21
orphaned `docker.exe` / `docker-compose.exe` processes** were still resident. The
containers were gone and the machine was still being hammered. `stop` kills
containers first, then the processes, then shuts the VM down so its RAM is
returned immediately rather than held until reboot.
