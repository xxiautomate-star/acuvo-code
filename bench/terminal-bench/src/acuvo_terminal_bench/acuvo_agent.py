"""
Harbor agent adapter so Acuvo Code can be scored on Terminal-Bench 2.1.

── ⚠️ WHY THIS EXISTS ───────────────────────────────────────────────────────
Every claim about where this CLI ranks has been an ESTIMATE. Our own 13-task
bench says 11/13 for $0.0103, which proves the loop works and says nothing about
how it compares to Codex CLI or Claude Code — it is our bench, measuring our own
idea of a task. Terminal-Bench is the number other people can check.

── ⚠️⚠️ THE PUBLISHED EXAMPLES ARE OUT OF DATE, AND I ONLY FOUND OUT BY
       INSTALLING HARBOR ───────────────────────────────────────────────────
The adapter examples in blog posts and third-party repos implement
`_install_agent_template_path` and `create_run_agent_commands`, and import
`ExecInput` from `harbor.agents.installed.base`. Against the harbor actually on
PyPI today, **`ExecInput` does not exist there**, and the abstract methods are
`install`, `run` and `name`. An adapter written from those examples imports
cleanly enough to look finished and fails the moment harbor instantiates it.

⭐ So this file is written against the INSTALLED source (`aider.py` is the
clearest shipped example), and the import is asserted by a test rather than
assumed. `python -m py_compile` proves nothing here: a wrong-but-importable
adapter compiles perfectly.

── ⭐⭐ THE INSTALL STEP IS ONE CLONE, AND THAT IS THE PRODUCT ARGUMENT ──────
Every other agent here installs a dependency tree — nvm, node, `npm install -g`,
and a transitive graph resolved inside a container with a cold cache. Acuvo Code
has ZERO dependencies, so installing it is `git clone` and nothing else. That is
not a benchmark trick; it is the property we sell to an enterprise ("nothing to
audit but this package") showing up as a shorter install script that cannot
break on a registry outage.

── ⚠️ IT RUNS WITH `--shell`, DISCLOSED, NOT HIDDEN ─────────────────────────
Terminal-Bench tasks are largely "install this, compile that, grep the log" —
work the default allowlist (node, npm, npx, tsc) refuses BY DESIGN. Scored
without `--shell`, the number would measure our safety policy rather than our
loop. Scored with it, we are reporting a mode that is NOT the default install.
Both facts have to travel with the score, so they are written here.
"""

import json
import shlex
import urllib.request
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Where harbor mounts the agent's log directory INSIDE the container. The same
# directory is synced back to `self.logs_dir` on the host, which is how
# `populate_context_post_run` can read a file the container wrote.
AGENT_DIR = "/logs/agent"
RESULT_FILE = f"{AGENT_DIR}/acuvo-result.json"
STDERR_FILE = f"{AGENT_DIR}/acuvo-stderr.log"

#: Long-horizon tasks need a long-horizon budget. Our default of 5 rounds is
#: tuned for a person at a keyboard; a round cap is a BUDGET, not a difficulty
#: setting, and reporting a score produced by an artificially short one would
#: measure the flag rather than the agent.
# ⚠️⚠️ 16 IS THE CLI'S REAL CEILING (`MAX_ROUNDS_LIMIT`, lib/cli-args.mjs), AND
# THIS SAID 30. Measured 2026-08-12: the first trial that ever reached the agent
# died instantly with
#     --max-rounds must be a whole number between 1 and 16 (got "30")
# — the CLI printed its usage text and exited, the result document was 0 bytes,
# and the trial scored 0 for a reason that had nothing to do with the task.
#
# ⚠️ AND verify.py ENFORCED THE WRONG VALUE: it asserted `MAX_ROUNDS >= 20`,
# which the CLI cannot accept. Nineteen green checks, one of them actively
# requiring an invalid invocation. It now reads the ceiling out of cli-args.mjs
# instead of naming a number.
#
# ⭐ The ceiling is NOT raised to flatter the benchmark. 16 was chosen with
# measured reasoning as a blast radius; scoring at the product's real limit is
# the number we would have to defend anyway, and if it proves too few that is a
# finding about the product rather than a knob to turn.
MAX_ROUNDS = 16

#: Pinned deliberately — see the install step. A benchmark result produced
#: against "whatever node was latest that week" cannot be reproduced, and an
#: unreproducible number is an anecdote with a decimal point.
NODE_VERSION = "v22.17.0"

#: ⚠️⚠️ A HARD PER-TASK CEILING, AND IT IS DELIBERATELY TIGHT. This was $2, and
#: that was careless with someone else's money: 89 tasks x $2 is $178 if one bug
#: makes every task loop. Our own 13-task bench averages $0.0008 a task and the
#: most expensive real run measured all day was $0.0029 — so $0.10 is still a
#: 34x margin over anything honest, while capping a total runaway at $8.90
#: across the whole dataset instead of $178.
#:
#: ⭐ A BUDGET IS A BLAST RADIUS, NOT AN ALLOWANCE. Sizing it by "what could a
#: task possibly need" invites the worst case. Sizing it by "what has one ever
#: actually cost, times a wide margin" makes the worst case affordable.
BUDGET_USD = 0.10

# ⚠️⚠️ 600s, NOT THE CLI's DEFAULT 180. Measured 2026-08-12 on the first trial
# where the agent genuinely ran: it read `decomp.c` and `data.txt`, began reasoning
# about an arithmetic-coded LZ77 decompressor, and died on
#     ✖ model: No response from OpenRouter within 180s
# with $0.000000 spent and nothing written. The default is tuned for an
# interactive session where a person is waiting; a Terminal-Bench task is a hard
# reasoning problem and the model legitimately thinks for minutes.
#
# ⚠️ IT TRAVELS WITH THE NUMBER, exactly like `--shell`. Scored with the default
# timeout, the result measures our impatience rather than our loop; scored with
# this, we are reporting a configuration that is not the default install. Both
# are true, so both get said. The CLI's own ceiling is 900s (`cli-args.mjs`).
REQUEST_TIMEOUT_S = 600


class AcuvoAgent(BaseInstalledAgent):
    """Acuvo Code, driven headlessly inside a Terminal-Bench container."""

    #: ⚠️⚠️ WITHOUT THIS, `self.model_connection` RESOLVES TO NOTHING. The base
    #: class defaults `MODEL_CONNECTION` to None and then declines to resolve a
    #: provider at all — `provider: None, api_key: ''` — even with
    #: OPENROUTER_API_KEY plainly set in the environment. The third real trial
    #: died on our own "needs an OpenRouter key" guard while the key was sitting
    #: right there, 73 characters of it.
    #:
    #: ⭐ THE GUARD IS WHY THE DIAGNOSIS TOOK MINUTES INSTEAD OF HOURS. It named
    #: the exact missing thing at the exact call site, so the search was "why is
    #: harbor not resolving the key" rather than "why did a container do
    #: nothing". A refusal that names what it wanted is worth more than a
    #: fallback that silently proceeds without it.
    #:
    #: `passthrough=True` because Acuvo Code reads OPENROUTER_API_KEY under that
    #: exact name — the same reason aider, goose, opencode and pi set it.
    MODEL_CONNECTION = ModelConnectionSpec(default_provider="openrouter", passthrough=True)

    @staticmethod
    @override
    def name() -> str:
        return "acuvo-code"

    @override
    def get_version_command(self) -> str | None:
        return "acuvo --version"

    @override
    def parse_version(self, stdout: str) -> str:
        # `acuvo --version` prints "acuvo-code 0.2.0".
        return stdout.strip().removeprefix("acuvo-code").strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        """
        Put node and the agent in the container **without touching the network
        from inside it**.

        ── ⚠️⚠️ WHY THIS WAS REWRITTEN: TWO RUNS, ZERO SIGNAL ─────────────────

        The previous install ran `ensure_system_dependencies(("curl","git"))`,
        curl'd a 52MB node tarball and `git clone`d the repo. Measured
        2026-08-12 across two real runs — 89 trials then 12 — **every completed
        trial errored**, and the exception says it outright:

            Command failed (exit 2): ... curl -fsSL "https://nodejs.org/dist/..."
            stdout: bash: line 1: curl: command not found

        `ensure_system_dependencies` did not actually leave curl in the
        container, so node could never be fetched and **the agent never ran
        once**. Those were not task failures; they were an empty denominator.

        ⭐ SO NOTHING IS FETCHED FROM INSIDE ANY MORE. Both artefacts are pushed
        in with `environment.upload_file`:

          · **the agent is ONE FILE.** `dist/acuvo.mjs` is a 1.75MB bundle of all
            59 modules that runs with the source tree nowhere on any path. No
            clone, no git, no registry — which is the honest form of the
            zero-dependency claim this adapter is here to demonstrate.
          · **node is a host-cached tarball**, downloaded once on the machine
            running the benchmark and reused by every trial after.

        The only things assumed inside the container are `tar` and `gzip`, which
        every Linux image has — a far smaller assumption than curl, git and a
        working apt mirror.

        ⚠️ THE ARCHITECTURE IS ASKED FOR, NEVER GUESSED. This machine is Windows
        on ARM and Docker runs arm64 images by default, so shipping the x64
        tarball would produce an "Exec format error" that reads like a broken
        agent. One `uname -m` costs nothing and removes the class.
        """
        arch_probe = await self.exec_as_root(environment, command="uname -m")
        machine = (getattr(arch_probe, "stdout", "") or "").strip()
        node_arch = "arm64" if machine in ("aarch64", "arm64") else "x64"

        tarball = self._host_node_tarball(node_arch)
        bundle = self._host_bundle()

        await environment.upload_file(tarball, "/tmp/node.tar.gz")
        await environment.upload_file(bundle, "/opt/acuvo.mjs")

        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                # ⚠️ Only extract when node is genuinely absent: some images ship
                # one, and overwriting it wastes the trial's setup budget.
                "if ! command -v node >/dev/null 2>&1; then "
                "  tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 "
                "    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md; "
                "fi; "
                "rm -f /tmp/node.tar.gz; "
                # ⚠️ A wrapper, not a symlink: a symlink relies on the shebang AND
                # on the exec bit surviving the upload. Two lines always work.
                "printf '#!/bin/bash\nexec node /opt/acuvo.mjs \"$@\"\n' > /usr/local/bin/acuvo; "
                "chmod +x /usr/local/bin/acuvo; "
                # ⚠️ VERIFY WHAT WILL ACTUALLY RUN, not that files landed. `ls` is
                # not evidence — an install that copies a broken bundle passes it,
                # and the failure then shows up as a task the agent "failed".
                "acuvo --version"
            ),
        )

    # ── host-side artefacts, prepared once and reused by every trial ─────────

    @staticmethod
    def _repo_root() -> Path:
        """
        ⚠️ FOUR LEVELS, AND IT WAS THREE FOR ONE RUN. This file is
        `<repo>/bench/terminal-bench/src/acuvo_terminal_bench/acuvo_agent.py`, so
        `parents[3]` is `bench/` and the bundle was looked for at `bench/dist/`.
        Asserted below rather than counted again — a path computed by arithmetic
        on `__file__` is the kind of thing that is quietly wrong on someone
        else's checkout.
        """
        root = Path(__file__).resolve().parents[4]
        if not (root / "package.json").is_file():
            raise RuntimeError(
                f"_repo_root() resolved to {root}, which is not the acuvo-code checkout "
                "(no package.json). The adapter moved; fix the parents[] depth."
            )
        return root

    def _host_bundle(self) -> Path:
        """
        The single-file agent. ⚠️ REFUSES RATHER THAN SHIPPING A STALE ONE: a
        bundle from last week silently benchmarks last week's code, and the
        number would be attributed to today's.
        """
        bundle = self._repo_root() / "dist" / "acuvo.mjs"
        if not bundle.is_file():
            raise FileNotFoundError(
                f"{bundle} is missing — run `node scripts/bundle.mjs --out dist/acuvo.mjs` "
                "before benchmarking, so the number belongs to the code you are testing."
            )
        return bundle

    def _host_node_tarball(self, arch: str) -> Path:
        """
        Node, downloaded ONCE on the host and cached. Every trial after the first
        pays nothing — which is the difference between 12 tarballs and one.
        """
        cache = self._repo_root() / "bench" / "terminal-bench" / ".cache"
        cache.mkdir(parents=True, exist_ok=True)
        name = f"node-{NODE_VERSION}-linux-{arch}.tar.gz"
        local = cache / name
        if not local.is_file() or local.stat().st_size < 1_000_000:
            url = f"https://nodejs.org/dist/{NODE_VERSION}/{name}"
            tmp = local.with_suffix(".part")
            urllib.request.urlretrieve(url, tmp)
            tmp.replace(local)
        return local

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        escaped = shlex.quote(instruction)
        access = self.model_connection

        api_key = access.api_key
        if not api_key:
            raise ValueError(
                "Acuvo Code needs an OpenRouter key. Run harbor with "
                "-m openrouter/<model> and OPENROUTER_API_KEY set."
            )

        # ⚠️ THE MODEL ID KEEPS ITS VENDOR PREFIX. Harbor spells models
        # "provider/model", and so does OpenRouter — "openrouter/deepseek/
        # deepseek-v4-flash-0731" must become "deepseek/deepseek-v4-flash-0731",
        # so exactly ONE leading segment is removed, never split on the last "/".
        model_id = self.model_name or ""
        if model_id.startswith("openrouter/"):
            model_id = model_id[len("openrouter/"):]

        env = {
            **access.env,
            "OPENROUTER_API_KEY": api_key,
        }
        if model_id:
            env["OPENROUTER_CODEGEN_MODEL"] = model_id

        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {AGENT_DIR}; "
                # ⚠️ `--json` puts ONE object on stdout and every human line on
                # stderr, which is why the redirect below captures a parseable
                # document rather than a document with a banner glued to it.
                #
                # ⚠️ `|| true` — a non-zero exit means the agent could not make
                # the task pass, which is a RESULT, not a harness failure. Left
                # to fail, harbor would raise NonZeroAgentExitCodeError and the
                # trial would be recorded as an error rather than a miss,
                # quietly deleting our real failures from the denominator.
                f"acuvo --json --shell --max-rounds {MAX_ROUNDS} --budget {BUDGET_USD} "
                f"--timeout {REQUEST_TIMEOUT_S} {escaped} "
                f"> {RESULT_FILE} 2> {STDERR_FILE} || true"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """
        Report what the run cost, read from the CLI's own JSON document.

        ⚠️ EVERY FIGURE IS READ, NEVER RECOMPUTED. `--json` already carries
        `usage.cost` from the provider's own accounting (every request is sent
        with `usage: {include: true}`), so re-deriving a price from token counts
        would publish an estimate beside a measurement and call both the same.

        ⚠️ AND A MISSING FILE IS REPORTED, NOT ZEROED. A run that died before
        writing anything did not cost nothing, and recording 0 tokens would make
        a broken harness look like an efficient agent — the most flattering
        possible way to be wrong.
        """
        result_file = self.logs_dir / "acuvo-result.json"
        if not result_file.exists():
            print(f"[acuvo] no result document at {result_file} — cost is UNKNOWN, not zero")
            return

        try:
            doc = json.loads(result_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            print(f"[acuvo] result document unreadable ({exc}) — cost is UNKNOWN, not zero")
            return

        usage = doc.get("usage") or {}
        context.n_input_tokens = int(usage.get("prompt_tokens") or 0)
        context.n_output_tokens = int(usage.get("completion_tokens") or 0)

        # ⭐ The cached half is reported separately because it is 50x cheaper,
        # and an agent whose margin comes from cache hits should be visible as
        # such rather than averaged into one token count.
        cached = ((usage.get("prompt_tokens_details") or {}).get("cached_tokens"))
        if cached is not None:
            context.n_cache_tokens = int(cached)

        cost = usage.get("cost")
        if cost is not None:
            context.cost_usd = float(cost)
