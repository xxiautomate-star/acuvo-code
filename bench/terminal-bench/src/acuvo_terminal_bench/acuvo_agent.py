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
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
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
MAX_ROUNDS = 30

#: A hard per-task ceiling in dollars. Our own 13-task bench averages $0.0008 a
#: task, so $2 is not a constraint on any honest run — it is the blast radius if
#: one task loops.
BUDGET_USD = 2


class AcuvoAgent(BaseInstalledAgent):
    """Acuvo Code, driven headlessly inside a Terminal-Bench container."""

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
        Put node and the agent in the container.

        ⚠️ NodeSource, NOT nvm. nvm installs into a login shell's profile and
        harbor runs the agent as a NON-login subprocess, so an nvm-installed
        node is on PATH during install and gone by the time the agent runs.
        That failure surfaces as "acuvo: command not found" and looks like a
        bug in the agent.
        """
        await self.ensure_system_dependencies(environment, ("curl", "git", "ca-certificates"))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                # Node 22, only if the image does not already have node.
                "if ! command -v node >/dev/null 2>&1; then "
                "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1; "
                "  apt-get install -y -qq nodejs >/dev/null; "
                "fi; "
                # ⭐ THE WHOLE INSTALL. No npm install, not a fast one — none.
                "rm -rf /opt/acuvo-code; "
                "git clone --depth 1 https://github.com/xxiautomate-star/acuvo-code.git /opt/acuvo-code >/dev/null 2>&1; "
                # ⚠️ A wrapper, not a symlink: a symlink relies on the shebang
                # AND on the exec bit surviving the clone. Two lines always work.
                "printf '#!/bin/bash\\nexec node /opt/acuvo-code/bin/acuvo.mjs \"$@\"\\n' > /usr/local/bin/acuvo; "
                "chmod +x /usr/local/bin/acuvo; "
                # ⚠️ VERIFY WHAT WILL ACTUALLY RUN, not that files landed. `ls`
                # is not evidence — an install that copies a broken tree passes
                # it, and the failure then shows up as a task the agent "failed".
                "acuvo --version; "
                "acuvo --doctor >/dev/null"
            ),
        )

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
                f"acuvo --json --shell --max-rounds {MAX_ROUNDS} --budget {BUDGET_USD} {escaped} "
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
