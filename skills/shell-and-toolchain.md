---
name: shell-and-toolchain
description: Probe before you call, install without blocking, read the exit code, and never spend a round asleep
when: Any shell command, apt or pip install, make or compile step, "command not found", or a timed-out run
---

# The shell and the toolchain

MEASURED across **139 real agent runs** of this CLI against Terminal-Bench 2.1.
Every number below is from those transcripts. Three of the top four causes of a
failed run were not reasoning failures — they were this file.

## 1. ⚠️⚠️ Probe first. `exit 127` cost 21 of 139 runs a round or more.

`exit 127` is *command not found*. It appeared **31 times across 21 transcripts**
(15%). The missing binaries were mundane: `file` ×11, `xxd` ×7, `python3` ×4,
`ps`, `time`, `curl`, `git` — a minimal container has none of them.

⭐ **Spend round one on a single combined probe** and never guess again:

```sh
command -v python3 pip3 make gcc g++ git curl wget jq xxd file unzip; cat /etc/os-release
```

`command -v` is a POSIX shell builtin, so it works where `which` itself is
missing, and it exits 1 for anything absent. One round buys the whole plan.

**Read the exit code, it is a diagnosis:**

| code | means | what to do |
|---|---|---|
| 126 | found, not executable | `chmod +x`, or you are running a directory |
| 127 | not found | it is not installed, or not on `PATH` |
| 124 | GNU `timeout` killed it | it did not fail — it was too slow |
| 130 | SIGINT (128+2) | interrupted |
| 137 | SIGKILL (128+9) | **usually the OOM killer**, not your bug |
| 139 | SIGSEGV (128+11) | a real crash; get a core or a backtrace |

## 2. ⚠️⚠️ Never run a long command in the foreground. 104 kills, 40 transcripts.

`✖ TIMED OUT after 120s — killed` and its longer siblings fired **104 times
across 40 of 139 transcripts (29%)**. The worst case retried the *same*
O(n²) workload four times, each time as a fresh script, each time killed — it
never shrank the input and never wrote a partial result to disk.

```sh
# the shape that survives a kill
nohup make -j4 > /tmp/build.log 2>&1 & echo $!
# ... then, in the SAME command as the wait, a bounded poll with an early exit
for i in $(seq 1 20); do grep -qE "Error|BUILD DONE" /tmp/build.log && break; sleep 5; done
tail -30 /tmp/build.log
```

⚠️ **The poll's own wall clock must be under the tool's timeout.** `seq 1 20`
with `sleep 5` is 100 seconds; it fits under a 120s cap, `seq 1 40` does not.

⚠️ **Wait for a pattern that also matches FAILURE**, never only for success — a
build that dies in three seconds otherwise costs you the whole timeout and tells
you nothing.

## 3. ⚠️⚠️ `sleep` is not a strategy. One run spent 29% of its budget asleep.

**62 bare `sleep` calls across 10 transcripts.** `caffe-cifar-10` used **24 of
its 84 rounds** on `sleep 115; echo done`. `compile-compcert` spent **rounds 10
through 31 of 32** on `sleep N; ps aux | grep dpkg` and never once ran the build
it was asked for. Both scored zero.

And the sleep gets killed too: `sleep 115` under a 120s cap is one retry away
from being the thing that times out.

⭐ **A round spent sleeping is a round spent. The readiness check and the wait
belong in the same command** — that is what the loop above is for. If you truly
have nothing to do, do something else useful and check the log next round.

## 4. ⚠️ apt: non-interactive, one at a time, and know the recovery

```sh
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends make gcc
```

- ⚠️ **`DEBIAN_FRONTEND=noninteractive` is not optional.** Without it `tzdata`
  asks for your geographic region on stdin and waits forever. It looks exactly
  like a slow download and it will never finish.
- ⚠️ Without `apt-get update` first you get `E: Unable to locate package` for a
  package that exists.
- ⚠️ **One apt job at a time.** Two hold the same lock and neither proceeds.

**The recovery, which appeared in 10 of 139 transcripts:**

```
E: dpkg was interrupted, you must manually run 'dpkg --configure -a' to correct the problem.
```

That is always the wreckage of a *previous install that was killed mid-way*.
Run `dpkg --configure -a` before any retry. ⚠️ **Never delete
`/var/lib/dpkg/lock`** — one transcript did, and it turns a five-second fix into
a broken package database.

## 5. ⚠️ pip on modern Debian/Ubuntu refuses to install at all

Debian 12+ and Ubuntu 24.04 ship PEP 668, so `pip install requests` fails with:

```
error: externally-managed-environment
```

Two correct answers, in order of preference:

```sh
python3 -m venv .venv && .venv/bin/pip install -q requests    # always right
pip3 install --break-system-packages -q requests              # disposable box only
```

⚠️ The system Python is `python3`; plain `python` frequently does not exist.

## 6. ⚠️ An empty output from a killed process is evidence of NOTHING

Four transcripts burned rounds theorising about signal semantics — *"the process
is being killed so hard that nothing flushes"* — when the answer was stdio
buffering. A killed process loses whatever is still in its buffer.

```sh
python3 -u script.py > /tmp/out.log 2>&1        # -u = unbuffered
PYTHONUNBUFFERED=1 python3 script.py            # same thing via env
stdbuf -oL -eL ./mytool > /tmp/out.log 2>&1     # for any C program
```

Make it unbuffered **and** durable before you form a hypothesis about it.

## 7. ⚠️ Check the size before you read the file

**14 refusals across 11 transcripts**, one of them an 844,949-byte CSV — over
the 200,000-byte read limit, so `read_file` returns nothing useful and the round
is gone.

```sh
ls -l data.csv; wc -l data.csv; head -3 data.csv; tail -2 data.csv
awk -F, '{s+=$6} END {print NR, s}' data.csv    # summarise, do not read
```

## 8. Shell correctness, briefly

- `set -euo pipefail` at the top of any script you write. Without `pipefail`,
  `false | tee log` exits **0** and your check passes on a failed command.
- Quote every variable: `"$file"`, not `$file`. A path with a space silently
  becomes two arguments.
- `cd` in a compound command affects only that command. Prefer absolute paths.
- `>` truncates before the command runs, so `sort f > f` empties `f`.
- `&&` chains only on success; `;` runs regardless. Choose deliberately.

## ⚠️ The retry rule

**After two failures of the same command class, you may not retry it.** Write
down the invariant that is failing and change something structural: a smaller
input, a different package source, a different tool, or ask. Nineteen
transcripts contain the model noticing its own loop — *"I need to stop looping"*
— and continuing anyway.

Related: `working-in-the-background` (dev servers and watchers, `start_process`),
`debugging` (reading the error literally), `finish-the-deliverable`.
