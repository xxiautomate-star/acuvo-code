"""
Prove the adapter still satisfies harbor's contract, without Docker and without
spending a cent.

── ⚠️ WHY THIS FILE EXISTS ──────────────────────────────────────────────────
`python -m py_compile` proves nothing here. The first version of this adapter
compiled perfectly and was wrong in every way that matters: it implemented
`_install_agent_template_path` and `create_run_agent_commands` and imported
`ExecInput` from `harbor.agents.installed.base`, because that is what the
published examples show. Against the harbor actually on PyPI today, `ExecInput`
is not in that module and the abstract methods are `install`, `run`, `name`.

⭐ A WRONG-BUT-IMPORTABLE ADAPTER IS THE DANGEROUS SHAPE. It looks finished, and
it fails at the moment harbor instantiates it — which is after the images have
been pulled and the trial has started, i.e. after the expensive part.

Run:  .venv/Scripts/python.exe verify.py     (Windows)
      .venv/bin/python verify.py             (posix)
Exits non-zero on the first thing that is not true.
"""

import inspect
import sys
import re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")
        FAILURES.append(label)


print("acuvo-code · Terminal-Bench adapter contract")

from acuvo_terminal_bench import AcuvoAgent  # noqa: E402
from harbor.agents.installed.base import BaseInstalledAgent  # noqa: E402
from harbor.models.agent.context import AgentContext  # noqa: E402

check("imports resolve", True)
check("subclasses BaseInstalledAgent", issubclass(AcuvoAgent, BaseInstalledAgent))

missing = sorted(getattr(AcuvoAgent, "__abstractmethods__", frozenset()))
check("every abstract method implemented", not missing, f"missing: {missing}")

check("name() is the id harbor will register", AcuvoAgent.name() == "acuvo-code", AcuvoAgent.name())
check("install() is a coroutine", inspect.iscoroutinefunction(AcuvoAgent.install))
check("run() is a coroutine", inspect.iscoroutinefunction(AcuvoAgent.run))

# ⚠️ GUARDED, so one broken contract does not abort the other twelve checks.
# Proven by mutation: renaming `install` made this raise
# "Can't instantiate abstract class AcuvoAgent" — correct, but it killed the
# run before the summary, which turns a precise report into a stack trace.
agent = None
try:
    agent = AcuvoAgent(logs_dir=Path("."), model_name="openrouter/deepseek/deepseek-v4-flash-0731")
    check("harbor can construct it", True)
except Exception as exc:  # noqa: BLE001 — any failure here is the finding
    check("harbor can construct it", False, str(exc))

check("version parses", agent is not None and agent.parse_version("acuvo-code 0.2.0") == "0.2.0")

# ⚠️ THE FIELDS COST IS REPORTED THROUGH. `AgentContext` gained/renamed fields
# between versions — an adapter that sets `context.cost` on a model whose field
# is `cost_usd` reports every run as free, and free is the most flattering
# possible way to be wrong.
fields = set(getattr(AgentContext, "model_fields", {}))
for field in ("n_input_tokens", "n_output_tokens", "n_cache_tokens", "cost_usd"):
    check(f"AgentContext still has `{field}`", field in fields, f"fields are {sorted(fields)}")

# ⚠️ The exact strings the run command depends on, asserted rather than trusted.
from acuvo_terminal_bench.acuvo_agent import MAX_ROUNDS, BUDGET_USD, RESULT_FILE, REQUEST_TIMEOUT_S  # noqa: E402

# ⚠️⚠️ READ FROM THE CLI, NEVER NAMED HERE. This asserted `MAX_ROUNDS >= 20`
# while the CLI refuses anything over 16 — so the verifier REQUIRED an
# invocation the product rejects, and every trial died printing usage text with
# nineteen checks green. A constant that names another component's limit is a
# guess until something compares them.
_cli_args = (Path(__file__).parent / "../../lib/cli-args.mjs").resolve().read_text(encoding="utf-8")
_m = re.search(r"MAX_ROUNDS_LIMIT\s*=\s*(\d+)", _cli_args)
_ceiling = int(_m.group(1)) if _m else None
check("the CLI's round ceiling was found", _ceiling is not None, str(_ceiling))
check(
    "the round budget is accepted by the CLI",
    _ceiling is not None and 1 <= MAX_ROUNDS <= _ceiling,
    f"asking {MAX_ROUNDS}, CLI accepts 1..{_ceiling}",
)
check("the round budget is long-horizon", MAX_ROUNDS >= 8, str(MAX_ROUNDS))
check("a per-task dollar ceiling exists", BUDGET_USD > 0, str(BUDGET_USD))

# ⚠️ The CLI's own bound, read rather than named — same lesson as MAX_ROUNDS.
_tm = re.search(r"n < 5 \|\| n > (\d+)", _cli_args)
_tmax = int(_tm.group(1)) if _tm else None
check("the request timeout is accepted by the CLI",
      _tmax is not None and 5 <= REQUEST_TIMEOUT_S <= _tmax,
      f"asking {REQUEST_TIMEOUT_S}s, CLI accepts 5..{_tmax}s")
check("the request timeout beats the CLI default of 180s",
      REQUEST_TIMEOUT_S > 180,
      f"{REQUEST_TIMEOUT_S}s — a hard task legitimately thinks for minutes")
check("the result document lands in the synced log dir", RESULT_FILE.startswith("/logs/agent/"), RESULT_FILE)

src = Path(__file__).parent / "src/acuvo_terminal_bench/acuvo_agent.py"
text = src.read_text(encoding="utf-8")
check("the run uses --shell (most TB tasks are unreachable without it)", "--shell" in text)
check("the run uses --json (one parseable object)", "--json" in text)
check("a non-zero exit is a RESULT, not a harness error", "|| true" in text)
"""
⚠️⚠️ ASSERT THE POSITIVE PROPERTY. Two attempts at the negative both failed on
the PROSE: `"nvm" not in text` matched the comment explaining why nvm is
avoided, and `"nvm install" not in text` matched "nvm installs into a login
shell's profile" inside that same comment.

⭐ A negative check over source text is fragile by construction — it forbids
naming the thing it forbids, so it punishes exactly the change that documents
itself. Asserting what the install DOES use is unambiguous, cannot be tripped by
a sentence, and is the fact anyone actually cares about. (Third time in two days
for the same family of mistake: see `formatChanges` in bin, and
`awk '\\bchanges\\b'`.)

⚠️ NodeSource is gone from that assertion because NodeSource itself is gone: it
cost four network round-trips and a package manager, and blew harbor's
agent-setup budget — the first real trial died with AgentSetupTimeoutError after
6m09s, before the model was called once. It is one pinned tarball now.
"""
check(
    "node is a PINNED tarball, so the result is reproducible",
    "nodejs.org/dist/" in text and "NODE_VERSION" in text,
)

print()
if FAILURES:
    print(f"{len(FAILURES)} check(s) failed")
    sys.exit(1)
print("adapter satisfies the installed harbor contract")
