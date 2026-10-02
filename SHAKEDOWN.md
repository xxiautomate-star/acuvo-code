# SHAKEDOWN — Acuvo Code, non-code surfaces

**Date:** 2026-08-10 · **Version audited:** 0.2.0 · **Platform:** Windows 11, Node 22.17.0
**Method:** seven adversarial passes over install/distribution, terminal rendering, process
lifecycle, network transport, filesystem containment, the machine contract, and the docs.
239 checks run. Every defect below was reproduced at least twice; the ones marked
**RE-VERIFIED** were reproduced again by the synthesis pass with the commands shown.

> **Scope note.** This audit attacked everything *except* the coding loop's model quality.
> The agent loop itself is not the problem. Nearly every defect here is in the layer between
> that loop and the person or script using it.

---

## THE VERDICT

**No — do not hand this to a stranger today, and do not publish it today.**

The engine is better than its packaging by a wide margin: the command allowlist is real and
holds under attack, the environment scrubber genuinely strips credentials from child processes,
path containment survived junctions, encoded traversal, UNC paths and a NUL byte, the git verbs
are safe by construction, the no-key first-run message is the best thing in the package, and
316 tests pass offline in under a second. That is a real foundation. But a stranger cannot
install it (the only documented install route 404s and the package is unpublished), and if they
could, four of the five ways to invoke it break their documented contract in silence: `--json`
emits human prose on `stdout` under `--parallel`, `--issue` and interactive mode; `--dry-run`
reports files as `created` with no dry-run marker; `edit_file` silently destroys bytes in any
file that is not valid UTF-8 while returning `ok: true`; and `--command-timeout` never fires
for `npm test` — the flagship verification command — leaving the agent hung forever with an
orphaned process tree. Those are not rough edges. They are the tool being confidently wrong
in the exact places a user has no way to check it.

**The smallest set that changes the verdict to yes:**

1. **A working install path.** Publish to npm, or push the repo the README clones. Right now
   there are zero. Add `test/` to `files` so `npm test` in an installed copy is not a false green.
2. **Stop the silent data loss.** `edit_file` must refuse a non-UTF-8 file, not mangle it.
3. **Bound the command.** `--command-timeout` must fire for `npm test`, and the kill must take
   the process tree with it.
4. **Make `--json` honest or make it refuse.** Either every path emits one object on stdout, or
   `--json` with `--parallel`/`--issue`/interactive exits 64.
5. **Correct the README's two spend defaults** (`--max-rounds` is 5, not 3; `--max-tokens` is
   12000, not 8000) and disclose that `generate_image` posts the user's prompt to an
   XXI-operated endpoint by default.

Everything else on this list can ship as known debt with an honest CHANGELOG.

---

## RANKED BY BLAST RADIUS

Ranked by how many users hit it × how badly × **how silently**. A wrong answer that looks
right outranks a crash, because a crash gets reported and a wrong answer gets believed.

| # | Defect | Sev | Silent? | Who hits it |
|---|---|---|---|---|
| 1 | No working install path at all (dead clone URL, unpublished, `npm test` = false green in a packed copy, `acuvo-mcp` has no bin entry) | high | partly | 100% of strangers, at step 1 |
| 2 | `edit_file` destroys bytes in non-UTF-8 files and returns `ok: true` | **critical** | **yes** | anyone with a cp1252/latin-1/Shift-JIS file |
| 3 | The `--json` machine contract lies on 4 of 5 paths, and `ok: true` accompanies exit 1 | high | **yes** | every scripted/CI user |
| 4 | `--command-timeout` never fires for `npm test`; kill is not a tree kill | **critical** | no (hang) | anyone whose test script does not exit |
| 5 | `search_text` / `find_files` lie to the model (silent skips, `**/` misses top level, credentials returned) | high | **yes** | every session that searches |
| 6 | Network layer reports the wrong model, fails valid 200s, echoes the API key, and cannot diagnose any transport error | high | **yes** | everyone on a proxy or a flaky link |
| 7 | Path whitelist makes 27% of a Next.js repo unreachable; search returns paths read refuses | high | no | every Next.js / non-ASCII user |
| 8 | README's two spend defaults are wrong (3 vs 5 rounds, 8000 vs 12000 tokens) | high | **yes** | everyone budgeting from docs |
| 9 | `generate_image` posts prompts to an XXI Modal endpoint by default; README says the opposite | high | **yes** | every installed copy |
| 10 | Security section omits `evaluate`, a second execution path with none of the documented guards | high | **yes** | anyone auditing before trusting |
| 11 | Terminal rendering: `FORCE_COLOR=0` ignored, subprocess ANSI re-emitted into pipes, lone surrogates in `--json`, no width awareness | medium | mixed | CI logs, narrow panes |
| 12 | Lifecycle: no signal handler, listener leak warning on turn 11, `.acuvo-eval-*` debris, unbounded `.acuvo/` artifacts, MCP respawn per turn | medium | mixed | interactive users |
| 13 | `git_commit`'s guard is lexical only — a junction stages content from outside the workspace | high | **yes** | rare, but permanent history |
| 14 | Exit 0 when verification never ran (`--no-run`, `--max-rounds 1`, refused test command) | medium | **yes** | `acuvo && git push` users |
| 15 | Undeletable debris filenames, cwd `.env` bleed, empty prompt → exit 0, no `--` terminator, no stdin prompt | low–med | mixed | scripters |

---

## THE THREE REPAIRS TO DO FIRST

Chosen for severity × smallness × non-collision. One file each, three different files.

1. **`lib/edit.mjs`** — refuse non-UTF-8 instead of corrupting it (#2).
2. **`lib/command.mjs`** — make the timeout actually fire, and kill the tree (#4).
3. **`lib/search.mjs`** — stop lying to the model about what was searched (#5).

Details in [Appendix: repair instructions](#appendix--repair-instructions).

---

# DEFECTS BY SURFACE

---

## 1. INSTALL & DISTRIBUTION

### 1.1 The only documented install path 404s — HIGH
`README.md:32` says `git clone https://github.com/xxiautomate-star/acuvo-code`.

```bash
git ls-remote https://github.com/xxiautomate-star/acuvo-code
# remote: Repository not found.
curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/xxiautomate-star/acuvo-code
# 404
```

The same URL is `repository.url` in `package.json:27`, so `npm docs` / `npm bugs` and the npm
page's repo link all land on a 404. The package is also unpublished (registry 404 for both
`acuvo-code` and `acuvo`, so the names are free). **There is no `npm install` alternative
documented.** Today the package has zero working install paths for a stranger, and every
instruction below README line 32 is untestable by its intended audience.

### 1.2 `npm test` in an installed copy is a silent false green — MEDIUM
**RE-VERIFIED:** `files` is `["bin/","lib/","README.md","LICENSE","CHANGELOG.md"]` — `test/` is
absent — while `scripts.test` is `node --test test/*.test.mjs`.

```bash
npm pack --pack-destination /tmp/tb
mkdir -p /tmp/tb/consumer && cd /tmp/tb/consumer && npm init -y
npm install /tmp/tb/acuvo-code-0.2.0.tgz
cd node_modules/acuvo-code && npm test
# tests 0 / pass 0 / fail 0 — exit 0
```

Node's `--test` exits 0 when the glob matches nothing, so a consumer or CI running the
dependency's test script gets a green having executed nothing. In the clone the same command
runs 316 tests, all passing. Add `test/` to `files`, or drop the script.

### 1.3 `bin/acuvo-mcp.mjs` ships with no `bin` entry — HIGH
**RE-VERIFIED:** `package.json.bin` is `{"acuvo":"./bin/acuvo.mjs"}`. The file is shipped
(5.6 kB in `npm pack`), works when run directly (`acuvo-mcp: v0.2.0 · NO TOOLS — set
RENDER_AUDIT_URL and/or MODAL_PRESS_URL`, exit 0), and `bin/acuvo-mcp.mjs:5-15` documents an
MCP host config of `npx -y acuvo-code acuvo-mcp`.

That config cannot work. `npx -y acuvo-code acuvo-mcp` resolves to the `acuvo` bin with argv
`["acuvo-mcp"]`, and `parseArgv(['acuvo-mcp'])` returns `task: "acuvo-mcp"`. With a key present
— and `bin/acuvo.mjs:98-103` auto-loads `.env` from cwd, so one often is — the MCP host starts
a **paid coding session** whose banner is written to `stdout`, which is the JSON-RPC wire. That
is precisely the stdout corruption the file's own header exists to prevent.

Fix: add `"acuvo-mcp": "./bin/acuvo-mcp.mjs"` to `bin`, or correct the snippet to
`"command": "node", "args": ["<path>/bin/acuvo-mcp.mjs"]`.

### 1.4 The no-key remedy crashes on Windows — MEDIUM
`MISSING_KEY_MESSAGE` suggests `node --env-file=.env "$(which acuvo)"`. On Windows `which acuvo`
resolves to npm's POSIX shell shim, and Node parses it as JavaScript:

```
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
          ^^^^^^^
SyntaxError: missing ) after argument list
```

The message already prints PowerShell syntax, so it knows it has Windows users. And
`bin/acuvo.mjs:98-104` already auto-loads `.env` from the workspace root and cwd, so on
Node ≥20.12 the flag is unnecessary — the hint should just be deleted.

### 1.5 `generate_image` posts every prompt to an XXI-operated endpoint by default — HIGH
```bash
node --input-type=module -e "import {imageConfig} from './lib/imagegen.mjs'; console.log(JSON.stringify(imageConfig({})))"
# {"base":"https://xxiautomate-star--acuvo-perchance-images-serve.modal.run",...,"configured":true,"usingDefault":true}
curl -s -X POST -H 'content-type: application/json' -d '{}' \
  https://xxiautomate-star--acuvo-perchance-images-serve.modal.run/generate
# {"error":"prompt required"} HTTP 400 — live, unauthenticated
```

`toolNamesForRounds(3, {env:{}})` includes `generate_image` with **no env set at all**, while
`README.md:188` says media tools are "only offered when their endpoint is configured" and
`lib/tools.mjs:188` still carries the comment "Absent `PERCHANCE_IMAGE_URL` the model is never
told the capability exists." Both are false. A stranger installing an MIT "zero dependency" CLI
gets undisclosed egress of their prompts to the vendor, and the vendor gets an uncapped,
unauthenticated compute bill from every installed copy. Either gate it as documented, or
disclose it in the install path with the opt-out (`PERCHANCE_IMAGE_URL=`).

### 1.6 Smaller items
- `package.json` has no `author`, `homepage`, or `bugs`. `npm bugs` falls back to the 404 repo.
- `--json` on the unconfigured path emits **empty stdout** (message goes to stderr, exit 2), so
  the documented `acuvo --json ... | jq` pipeline dies with a jq parse error rather than a cause.
  Exit 2 means a status-checking script is still safe.

### What passed here
`npm link` into a temp prefix works first try and leaves the real global prefix untouched.
`--version`/`-v`/`--help` work with no key, exit 0. The no-key error names the env var, gives
bash *and* PowerShell syntax, links openrouter.ai/keys, states the typical cost and default
model, and exits 2 rather than 1. Unknown flag → exit 64 with full usage. `npm pack` ships
36 files / 192.6 kB with no `.env`, no `bench/`, no docs sprawl, and **zero secret-shaped
strings**. LICENSE is real MIT and matches `package.json`. No install/prepare/prepack scripts.
Line endings are pure LF and the shebang is clean despite `core.autocrlf=true` — checked
specifically, because that is normally how a Windows-packed tarball ships broken. The `>=20`
Node floor is honest: `process.loadEnvFile` is feature-guarded and there is no use of global
`fetch`, `Object.groupBy`, `Promise.withResolvers`, `fs.glob`, `util.styleText`, or
`import.meta.dirname`. Installing the packed tarball into a clean consumer works, including
into a path containing spaces.

---

## 2. THE MACHINE CONTRACT (exit codes, `--json`, flags, stdin)

### 2.1 `--json` is silently ignored by `--parallel`, `--issue`, and interactive mode — HIGH
Three independent passes hit this from different directions. `--help` states:
*"`--json` — One JSON object on stdout, nothing else. Human output goes to stderr, so
`acuvo --json ... | jq` just works."*

```bash
# --parallel
node bin/acuvo.mjs --dir /tmp/ws --parallel --json --max-rounds 1 --no-run "task one" "task two" 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{JSON.parse(s);console.log('VALID')}catch(e){console.log('NOT JSON: '+e.message)}})"
# NOT JSON: Unexpected token 'r', "\n  running 2 "... is not valid JSON

# --issue
node bin/acuvo.mjs --dir /tmp/ws4 --issue 1 --json --dry-run --max-rounds 1 1>out.json 2>/dev/null
# out.json → "  · reading owner/repo#1 (via gh auth token)"

# interactive / piped — the documented automation path
printf 'refactor the parser\nand then add tests\n' | node bin/acuvo.mjs --json >out.json
# out.json → 'Type what you want done. "exit" to leave.\n\n› refactor the parser\n\n✖ ...'
```

Cause: `bin/acuvo.mjs:201-258` (the `--issue` and `--parallel` branches) and `:260-266`
(interactive) return before the `if (opts.json)` block at `:279` and write to `process.stdout`
unconditionally. Confusingly, the *banner* is correctly routed to stderr in all three, so the
flag looks honoured. Either emit JSON, or reject the combination at exit 64.

### 2.2 `--dry-run --json` reports files as created — HIGH
```bash
cd $(mktemp -d) && node .../bin/acuvo.mjs --json --dry-run --max-rounds 1 "create DRY.txt containing hello" </dev/null 2>/dev/null
# {"ok":true,...,"changes":[{"path":"DRY.txt","tool":"write_file","bytes":5,"kind":"created"}],"error":null}
ls DRY.txt   # No such file or directory
node -e "console.log(Object.hasOwnProperty.call(require('./out.json'),'dryRun'))"  # false
```

The JSON is byte-identical in shape to a real write. The only signal is the human banner
"DRY RUN (nothing written, nothing run)" — which `--json` deliberately sends to stderr, i.e.
exactly where a machine consumer is told not to look. A script doing
`acuvo --json --dry-run ... | jq -r .changes[].path | xargs git add` believes files exist.
Fix: a top-level `"dryRun": true`, or `kind: "would-create"`.

### 2.3 `ok: true` on a run that exits 1 — HIGH
```bash
# a workspace whose npm test exits 1
node .../bin/acuvo.mjs --json --max-rounds 2 "Run npm test to observe state. Do NOT fix anything." </dev/null >out.json
echo $?   # 1  (correct — `&& echo yes` was correctly suppressed)
node -e "const j=require('./out.json');console.log(j.ok, j.verification)"
# true { ran: true, passed: false, exitCode: 1 }
```

The object cannot reproduce the process verdict. A consumer must reimplement `sessionFailed()`
— `j.ok && !(j.verification.ran && !j.verification.passed)` — and nothing says so. Today
`acuvo --json ... | jq -e .ok && git push` pushes code whose suite exits 1: the exact silent
success `bin/acuvo.mjs`'s own header says the exit code exists to prevent. Add a field the exit
code is derived from (`"failed": true` or `"exitCode": 1`).

### 2.4 Exit 0 when verification never ran — MEDIUM
`sessionFailed()` is `v?.ran && v.passed !== true`, so "not verified" collapses into "passed".
Reproduced with a workspace whose own test script contains quotes, so `run_command` refused it:

```
CHANGED: yes, exit 0
verification = { ran:false, passed:false, command:null, exitCode:null, attempts:0 }
refusals[0]  = run_command refused (quotes in the workspace's test script)
```

`--no-run` and `--max-rounds 1` (whose banner literally reads "will NOT run anything") produce
the same exit 0. `acuvo --no-run "fix the bug" && git push` always pushes. Needs a three-state
verdict: verified-pass 0, verified-fail 1, not-verified distinct.

### 2.5 Interactive/piped mode always exits 0 — MEDIUM
Two turns both printed `✖ OpenRouter rejected the API key (HTTP 401)`; exit 0.
`cat prompts.txt | acuvo && deploy` deploys after a session where nothing succeeded. Defensible
for a TTY; not for the piped case that `chat.mjs`'s own header calls the automation path.

### 2.6 A revoked key exits 1, not 2 — MEDIUM
`OPENROUTER_API_KEY=sk-or-v1-invalid` → exit 1, same code as a failing test suite and a
transient provider error. A retry loop keyed on exit 1 spins forever on a 401. `bin/acuvo.mjs`
documents 2 as "not configured", and a revoked key is a configuration fault.

### 2.7 An empty prompt opens a session and exits 0 — MEDIUM
`acuvo ""` and `acuvo "   "` print the banner, print `Type what you want done`, and exit 0 with
stdin at EOF. `acuvo "$TASK"` with `TASK` unset is the commonest scripting accident there is.
Same shape for `acuvo --model "add a healthcheck route"` — the value-flag eats the prompt.

### 2.8 No way to pass a large or multi-line prompt — MEDIUM
100 kB argv → `env: 'node': Argument list too long`, exit 126, with no mention of acuvo.
`printf 'line one\nline two\n' | acuvo` runs **two independent cold tasks**, not one multi-line
instruction. There is no `acuvo -` and no documented argv ceiling.

### 2.9 `--version` / `-v` work but are absent from `--help` — LOW
**RE-VERIFIED:** `node bin/acuvo.mjs --help | grep -c -- '--version'` → `0`, while
`--version` prints `acuvo-code 0.2.0`. `README.md:63` calls `--help` "the authoritative list"
and `README.md:57` calls `--version` the install-verification command.
`bin/acuvo.mjs`'s own comment: it "is the first thing anyone types when reporting a bug".
Also: `parseArgv`'s `CliOptions` typedef does not declare `version`, though `bin/acuvo.mjs:67`
reads it.

### 2.10 `model` is `null` in the JSON on every failure — LOW
Even with `--model` passed explicitly: `error` says "nope/does-not-exist-xyz is not a valid
model ID" while `model` is `null`. The field is null exactly in the runs where a fleet operator
most needs it. `config.model` is known before the call.

### 2.11 No `--` terminator — LOW
`acuvo "--fix the login bug"` → `Unknown option --fix the login bug.` exit 64, and `acuvo --`
also fails because `--` itself starts with `--`. Support POSIX `--`, and truncate the offending
token at the first space so the error does not quote the user's sentence back as a flag name.

### What passed here
All four documented exit codes produced deliberately and confirmed: 0, 1 (verification failed;
401; 400; parallel file conflict), 2 (no key), 64 (every bad flag). `acuvo ... && echo yes`
correctly did **not** print `yes` when `npm test` exited 1. Parallel conflict detection works.
Flag validation is excellent — 23 bad-value variants all exit 64 with a complete sentence
quoting the offending value; a value-flag followed by another `--flag` is caught rather than
swallowed; missing trailing values give "X needs a value."; duplicate flags are last-wins;
flags after the prompt still parse. On the one-shot path `--json` stdout purity is real (5/5
runs parsed). The JSON shape was stable across success, verification-failure, tool-refusal and
transport-error, with `ran` and `passed` correctly separate and `costUsd` null only when no
call completed. No stack trace escaped in ~45 invocations.

---

## 3. FILESYSTEM & WORKSPACE CONTAINMENT

### 3.1 `edit_file` destroys bytes in non-UTF-8 files and returns `ok: true` — **CRITICAL**
**RE-VERIFIED 2026-08-10.** `lib/edit.mjs:100` reads `utf8`, `:118` writes `utf8`, and the only
binary guard (`:111`) tests for a NUL byte — which latin-1 / cp1252 / Shift-JIS text does not
contain.

```bash
node --input-type=module -e "
import fs from 'node:fs';
import {editFile} from './lib/edit.mjs';
fs.writeFileSync('latin1.txt', Buffer.from([0x48,0x65,0x6c,0x6c,0x6f,0x20,0xff,0xfe,0xe9,0xe8,0x0a,0x53,0x45,0x43,0x52,0x45,0x54]));
console.log('BEFORE', fs.readFileSync('latin1.txt').toString('hex'));
console.log('RESULT', JSON.stringify(editFile(process.cwd(),'latin1.txt','SECRET','PUBLIC')));
console.log('AFTER ', fs.readFileSync('latin1.txt').toString('hex'));"
```

```
BEFORE 48656c6c6f20fffee9e80a534543524554                (17 bytes)
RESULT {"ok":true,"path":"latin1.txt","bytes":25,"replacedChars":6,"fileChars":17,"created":false,"previousBytes":25,"dryRun":false}
AFTER  48656c6c6f20efbfbdefbfbdefbfbdefbfbd0a5055424c4943 (25 bytes)
```

`ff fe e9 e8` were each replaced by U+FFFD and are **gone permanently**. `previousBytes: 25` is
itself wrong — the file was 17. `workspace.mjs` `readFile` does the same lossy read, so the
model is shown corrupted content too. An `ok: true` on an operation that silently destroyed
four bytes of the user's file is the one outcome that must never happen; the module already
refuses NUL-containing files for exactly this reason.

### 3.2 Every Next.js App Router path is unreachable — HIGH
`lib/workspace.mjs:144` whitelists path segments as `/^[A-Za-z0-9._-]+$/`.

```
read_file  app/[tenantSlug]/CommandHero.tsx
→ unsupported characters in path segment "[tenantSlug]"
```

Same for `(dashboard)`, `[...slug]`, `@modal`, `My Component.tsx`, `café.js`, `日本語.ts`.
Measured on the real repos: **console/ = 565 of 2,077 tracked files (27%) unreachable**;
claude-build root = 691 of 10,693.

Worse, `find_files` and `search_text` happily return those paths. On a fixture,
`search_text('SECRETMARKER')` returned `app/dashboard/[id]/page.tsx` with the matching line and
`read_file` on that exact path then refused. **The two halves of the tool disagree**, and the
agent is handed a path it can never open.

End to end the agent burns rounds on it: round 1 refusal, round 2 "The write_file tool refuses
non-ASCII characters in the path... perhaps I need another way", lists the directory, gives up.
Exit 0, `ok: true`, task not done.

The safety goal (no traversal, no reserved Windows chars, no control chars) is achievable with
a denylist of `< > : " | ? * \ /`, control chars, `..`, and reserved device names, while
permitting spaces, brackets, parens, `@` and Unicode letters. At minimum the refusal must tell
the model to retry with an ASCII name, and search must not emit paths read will reject.

### 3.3 `read_file` / `read_window` throw on an unreadable file, killing the whole session — HIGH
`lib/workspace.mjs:265` calls `readFileSync` unwrapped (`statSync` *is* wrapped). Because
`gatherWorkspaceContext` (`lib/turn.mjs:175`) reads every small file in the top two directory
levels **before the first model call**, one permission-denied file in the workspace root aborts
the run with a raw stack:

```
Error: EPERM: operation not permitted, open '...locked.txt'
```

The file's own header states the contract: *"Returns plain data (never throws for an expected
failure)... not something that should kill the process."* `writeFile` and `deleteFile` handle
EPERM correctly; only the read paths are unguarded. The pre-load already does
`if (!read.ok) continue`.

### 3.4 `search_text` returns credential file contents into the prompt — HIGH
```bash
node --input-type=module -e "...searchText(d,'CANARY')..."
# {"path":"config/credentials.yml","line":1,"text":"password: CANARYYML"}
# {"path":"id_rsa","line":2,"text":"CANARYKEY"}
# {"path":"secrets.json","line":1,"text":"{\"aws_secret\":\"CANARYAWS\"}"}
```

`turn.mjs:112-135` documents this class as "THE WORST BUG THIS PACKAGE HAS HAD" and fixes it in
the automatic pre-load by reusing `refusedCommitPath`. **`search_text` applies no such filter**,
feeds the same prompt through the same 4-provider chain, and is callable in round 1. Only
dot-prefixed files are skipped, and only incidentally via the hidden-file rule. `read_file`
returns them in full.

### 3.5 `search_text` reports "no matches" for files it skipped — MEDIUM
**RE-VERIFIED 2026-08-10.**

```
searchText(dir,'NEEDLE') -> {"ok":true,"pattern":"NEEDLE","matches":[],"truncated":false,"scanned":4}
```
…in a directory where `big.js` (601 kB, over the 512 kB cap) and `u16.txt` (UTF-16) both
contain `NEEDLE` on line 1. `matches:[]` says it does not exist, `truncated:false` says nothing
was cut, `scanned:4` says everything was looked at. All three together are a confident
falsehood. Confirmed on a 50 MB fixture too: 0 matches for `xxxxxxxxxx`.

The module already treats truncation as sacred — *"TRUNCATION IS REPORTED, NEVER SILENT... a
model told the first will stop looking"*. The same reasoning applies to skipped files.

### 3.6 `find_files` — `**/*` never matches a top-level file — MEDIUM
**RE-VERIFIED 2026-08-10.**

```
globToRegExp('**/*.json') = /^.*\/[^/]*\.json$/i     ← the literal / is mandatory
'**/*.json' -> [ 'src/a.json' ]                      ← package.json missing
'*.json'    -> [ 'package.json', 'src/a.json' ]
```

The broader-looking pattern returns strictly fewer results than the narrower one. Every glob
the model has seen (bash globstar, minimatch, ripgrep) treats `**/` as zero-or-more
directories. An agent asking for `**/*.json` in a repo root is told `package.json` does not
exist, and acts on that.

### 3.7 `git_commit`'s path guard is lexical only — HIGH
`lib/git.mjs:392` uses `normalizeRelativePath`, not `resolveInWorkspace`, so it never
realpaths — and git follows junctions:

```bash
cmd /c mklink /J C:/repo/jct C:/outside
git add --dry-run -- jct/secret.txt        # add 'jct/secret.txt'  (exit 0)
normalizeRelativePath('jct/secret.txt')    # {"ok":true,"path":"jct/secret.txt"}
refusedCommitPath('jct/secret.txt')        # ALLOWED
```

Every *file* tool refuses this exact path with "path escapes the workspace through a symlink";
the git tool does not, because it runs only the lexical half. The header's own example —
*"notes can be a symlink to C:\Windows\System32"* — is the case the tool that writes permanent
history does not guard. `git_diff` has the same gap on the read side.
(A real commit was not executed — out of scope — but both halves are proven and the code
between them is a direct spawn.)

### 3.8 Undeletable debris — MEDIUM
The whitelist permits dot-only segments (`...`, `....`), trailing-dot names (`trail.`) and
Windows reserved device names (`nul`, `con`, `aux`, `com1`, `lpt1`). All write `ok: true` and
create real on-disk entries. Removing them: `rmdir /s /q ....` → "The directory is not empty."
(exit 145, though it is empty); `Remove-Item -Recurse -Force ....` → "does not exist";
`del nul` → exit 123. Explorer, cmd and PowerShell all fail; only Git Bash `rm -rf` works.
**No traversal escape occurs** — this is debris in the user's project, not a breach.

### 3.9 `list_dir` reports "no such directory" for a permission error — MEDIUM
`{"ok":false,"error":"no such directory: sub"}` while `test -d` confirms it exists. The
`readdirSync` catch collapses EACCES/EPERM into the ENOENT wording. A model told a directory
does not exist will invent one and write elsewhere. `write_file` gets this right.

### 3.10 `--dir ""` silently operates on the current directory — MEDIUM
`bin/acuvo.mjs:73` is `resolve(opts.dir ?? process.cwd())` — `??` does not catch `""`.
`parseArgv(['--dir','','task'])` returns `ok: true, dir: ""`, `existsSync` passes, and the run
proceeds against cwd with no warning. `acuvo --dir "$PROJECT" ...` with `$PROJECT` unset points
a file-writing agent at wherever the shell happens to be. (`--dir "   "` correctly errors.)

### 3.11 A `.env` from cwd is loaded even when `--dir` points elsewhere — MEDIUM
`bin/acuvo.mjs:99` loops `[join(root,'.env'), join(process.cwd(),'.env')]`. Verified: with
`OPENROUTER_API_KEY` unset in the environment and a `.env` in cwd, a run with
`--dir C:/temp-acuvo-elsewhere` found the key and reached the model (401 on the fake key)
instead of exiting 2. The same path injects `OPENROUTER_CODEGEN_MODEL` — so
`acuvo --dir ./some-cloned-repo "fix the tests"` lets **that repo choose the model you pay for**
(a `.env` naming `anthropic/claude-opus-4.1` was honoured, banner and all). Also injects
`RENDER_AUDIT_URL` / `IMAGE_GEN_URL`, which `see_page` then POSTs page HTML to. The base URL is
hardcoded, so this is a cost/trust issue rather than key exfiltration.

### 3.12 Smaller items
- **Case collisions:** `write_file('foo.js')` over an existing `Foo.js` returns `path:"foo.js"`
  while the on-disk name stays `Foo.js`; `deleteFile('FOO.JS')` deletes `Foo.js` and echoes the
  caller's spelling. Size accounting is honest (`previousBytes:14, created:false`) — only the
  name is wrong. Downstream this shows up as a phantom rename in git.
- **`see_page`** reports a *refused* asset as "was not found", sending the model to hunt for a
  missing file instead of fixing an out-of-workspace reference. Containment itself held.

### What passed here
Path containment is genuinely solid and could not be broken. Refused by construction, verified
through `resolveInWorkspace` **and** the real executor: `../outside/x`, `..\outside\x`,
`src/../../outside/x`, `/etc/passwd`, `C:/Windows/win.ini`, `\\server\share\x`, `%2e%2e/...`,
an embedded NUL byte, and a URL. A Windows **junction** planted inside the workspace is refused
for read/list/write/edit/read_window. A workspace *reached* through a junction works correctly
(`realpathSync` on the root). `see_page`'s asset inliner is clean: `<link>`, `<script src>` and
`<img src>` pointing at a junction, `../outside/`, `C:/Windows/win.ini` and `file:///...` all
failed to inline and the canary never entered the HTML, including from a nested page. An
**end-to-end model-driven run** told to read those paths got three clean refusals surfaced to
the model and exited "No files changed". Writes into `.git/` and `node_modules/` are refused
with a good reason; deleting a directory is refused. Exotic workspace roots all work end to end:
`my project (v2)`, `проект-日本語`, `emoji-🚀-dir`, trailing-backslash `--dir`. `--dir <missing>`
and `--dir <a file>` print a clear message. A 50 MB file, a 200,001-byte read and a 400,001-byte
write are refused with exact byte counts. A PNG named `sprite.js` is refused as binary by
`read_file`, `read_window` **and** `edit_file` — all three agree. UTF-16LE is refused rather
than mangled. MAX_DEPTH=12 and MAX_PATH_LENGTH=255 hold. On a 10,693-file repo root: listDir
0.1 s, pre-load 0.1 s, find_files 0.2 s, search_text 1.8 s — no hang. **Credential exclusion
from the automatic pre-load holds**: with `.env`, `.env.local`, `id_rsa`, `.npmrc`,
`secrets.json` and `config/credentials.yml` present, `gatherWorkspaceContext` inlined only
`index.js` and not one canary reached the prompt.

---

## 4. PROCESS LIFECYCLE & SIGNALS

### 4.1 `--command-timeout` never fires for `npm test` / `npm run` — **CRITICAL**
Self-bounding library harness, no model call:

```js
const r = await executeRunCommand({ command:'npm test', executor, timeoutMs: 4000 });
```
against a workspace whose `test` script is `node server.mjs` (a `setInterval` that never exits):

```
{"VERDICT":"NEVER RESOLVED","waitedMs":20019}
```

Reproduced four times: at a 20 s guard, a 15 s guard, the tool's own 2-minute ceiling, and
**end to end through the real binary**, where acuvo printed `── round 1/2 ──` and produced
nothing for over 120 s despite `--command-timeout 5`. There is no session-level deadline
anywhere in the package, so nothing ever rescues it.

**Root cause, re-verified by reading `lib/command.mjs:539-592`:** the timer fires and calls
`child.kill('SIGKILL')`, but the promise is only settled from `child.on('close', ...)`.
`close` requires *both* process exit *and* EOF on the captured stdout/stderr pipes. npm runs the
script as a further descendant; that descendant inherited the pipe write handles, survives the
kill, and EOF never arrives. `finish()` is never called.

**Isolation control:** the identical hanging script invoked as `node hang.mjs` — a direct child
with no descendants — resolves correctly at 4,154 ms with `signal: SIGKILL`. Only the
descendant case hangs.

This outranks a normal timeout bug because `npm test` is the CLI's own flagship verification
command, and a hung agent has no recovery short of the user finding and killing it.

### 4.2 The kill is not a process-tree kill — HIGH
A timed-out command's descendants are orphaned and run forever:

```
hang-pids.json  {"self":20240,"plain":24428,"detached":24472}
after timeout + harness exit → all three node.exe still running
Get-CimInstance: pid 13128's ParentProcessId 19836 no longer exists   ← a true orphan
```

Reproduced three times including end to end (`node server.mjs` pid 24876 alive with a dead
parent 21380). `child.kill('SIGKILL')` is `TerminateProcess` against the direct child on
Windows and a single-pid signal on POSIX; libuv's job object only reaps descendants when the
**root** node process dies, not when an intermediate child is killed. Every timed-out
`npm test` that started a server, a watcher or a worker pool leaves it running for the life of
the machine — the exact failure class `lib/turn.mjs:779-781` says it is defending against
("the failure that had 38 node processes on this machine today").

### 4.3 No SIGINT/SIGTERM handler, and the `exit` cleanup is proven inert — MEDIUM
`grep -rn "SIGINT\|SIGTERM\|SIGHUP\|SIGBREAK" bin lib` returns **two comments and no handler**.
Empirically, `process.once('exit', ...)` does not run on any signal:

```
{"sig":"SIGINT","code":1}  marker: started pid=N|      ← 'exit-handler-ran' never written
{"sig":"SIGTERM","code":1} marker: started pid=N|
{"sig":"SIGKILL","code":1} marker: started pid=N|
```

So `process.once('exit', cleanup)` at `lib/turn.mjs:795` — the line whose comment says it
exists so the CLI "cannot leave orphaned processes behind" — never executes on an interrupt.
**On Windows this is masked by libuv's job object** (verified: a hard-killed acuvo reaped its
MCP child 21792 and grandchild 27588), so I could not reproduce an actual MCP orphan here. On
Linux/macOS there is no job object and nothing left to kill the servers; that is reasoned, not
measured, and is stated as such. Separately, the exit code on interrupt is **1** —
indistinguishable from "the code it wrote still does not pass".

### 4.4 `exit` listeners accumulate one per session — MEDIUM
```
(node:26844) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
11 exit listeners added to [process]. MaxListeners is 10.
{"sessions":14,"exitListeners":14}
```
`runSession` registers `process.once('exit', cleanup)` and never removes it, while
`bin/acuvo.mjs:138` calls `runSession` once per interactive turn. A user having a normal
conversation is shown a Node memory-leak warning on message 11 that is a bug in acuvo, not in
their project. `--parallel` has no task cap either.

### 4.5 Interrupted `evaluate` leaves `.acuvo-eval-*` debris in the repo root — MEDIUM
`.acuvo-eval-29852-1786359725802.mjs` survived a hard kill of pid 29852. The `unlinkSync` is in
a `finally` (`lib/evaluate.mjs:130`) that a signal death never reaches. The filename embeds a
dead pid and a timestamp, so every interrupt adds one more, and there is no startup sweeper for
the pattern anywhere. These land unignored in the repo root and show up in `git status`.

### 4.6 `.acuvo/` media artifacts grow without bound — MEDIUM
`lib/media.mjs` writes `.acuvo/render-${Date.now()}.png`, `speech-${Date.now()}.wav`,
`document-${Date.now()}.${fmt}`. The only prune logic in the package is `planPrune` in
`lib/audit.mjs`, scoped to `.acuvo/audit`. Timestamped names guarantee accumulation. The MCP
server's output directory has the same shape (its staged *input* HTML is correctly discarded in
a `finally`; the produced PNG/PDF/PPTX are not). `lib/audit.mjs:56` frames its caps as
"THESE BOUND A LAPTOP'S DISK" — the artifacts are far larger than log lines.

### 4.7 MCP servers respawn on every interactive turn — MEDIUM
4 turns → 4 full spawn/handshake/kill cycles (pids 28332, 26632, 25472, 13908). `mcpConns` is a
local of `runSession`, torn down per turn. A 20-turn conversation with 3 servers performs 60
spawns, 60 `initialize`/`tools-list` handshakes and 60 kills. All processes did die, so this is
churn and latency rather than a leak — but it is 60 more chances at the orphan class above.

### 4.8 The MCP server's `uncaughtException` handler logs and continues — LOW
`bin/acuvo-mcp.mjs:121-122` registers handlers that write to stderr and return, suppressing
Node's terminate-on-uncaught. The process stays alive with corrupted state, stdin open, and any
in-flight request unanswered. A host treats a server *exit* as restartable; a server that stays
up and silently drops replies presents as an unexplained hang.

### 4.9 Zero test coverage for this entire class — LOW
`grep -rln "SIGINT\|SIGTERM\|orphan\|closeConnections\|timedOut" test/` returns **nothing**.
The suite is fully green over 4.1, which is a total failure of a documented flag on the most
common command the agent runs, because every spawn-touching test injects a `spawnImpl` stub.
Stubs are right for the refusal-logic tests but structurally cannot catch anything here.

### What passed here
`bin/acuvo-mcp.mjs` exits 0 in 197 ms when the host closes stdin. Killing the real CLI mid-run
with a live MCP server left **no orphans on Windows** (job object). `closeConnections` does kill
spawned servers on the normal path — 8 processes across 4 sessions, all confirmed gone. A normal
end-to-end run left no `.acuvo-eval-*` files and no strays. The model HTTP call is bounded by
`AbortSignal.timeout`. `spawnBounded` uses `stdio:['ignore','pipe','pipe']` and
`windowsHide:true`, so a child that prompts cannot silently block the terminal and no console
windows flash. `shell:false` on every path, with npm/npx resolved to their JS entry points
rather than `.cmd` shims. Audit logs *are* pruned (`MAX_AUDIT_FILES=90` plus a byte cap).
`git add` uses an explicit pathspec, never `-A`. `--help | head -1` does not EPIPE. Direct
`node <file>` timeout works exactly as documented (killed at 4.15 s against a 4 s budget).

---

## 5. NETWORK & TRANSPORT

### 5.1 A mid-stream connection drop crashes with a raw undici stack — HIGH
```
acuvo crashed — this is a bug in acuvo-code, not in your project:
TypeError: terminated
    at Fetch.onAborted (node:internal/deps/undici/undici:11132:53)
```
Exit 1; under `--json`, **stdout is empty** (`Unexpected end of JSON input`). The chain never
tries a fallback and the whole session summary — including the file round 1 already wrote to
disk — is lost. Cause: `callModel`'s try/catch wraps only `fetchImpl(...)`
(`lib/model.mjs:312-328`); the body read at `:349` is unguarded, so the abort escapes past
`turn.mjs:894-905`'s deliberate "a mid-loop model failure is not a whole-session failure"
handling and out of `main()`. The file's own header: *"a coding agent that hangs, or dies on
`Cannot read properties of undefined`, is worse than one that does not exist."*

### 5.2 A timeout is not retryable, contradicting `chain.mjs`'s own header — HIGH
**RE-VERIFIED 2026-08-10:**
```
timeout string: "No response from OpenRouter within 180s — the call was aborted rather than left hanging."
isRetryable(timeout) = false
```
`lib/chain.mjs:18` states the contract: *"RETRY  429 (rate limit) · 5xx (their fault) ·
**timeout** · connection error"*. End to end against a hanging stub, the log shows exactly
**one** request; the other three chain entries are never tried.

Worse: `test/smoke.test.mjs:157` asserts `isRetryable('the request timed out after 180s') ===
true` — a hand-written string `describeTransportError` never emits — so **the suite is green
while the behaviour is broken**. The same regex lists `ECONNRESET`/`ECONNREFUSED`/`ENOTFOUND`,
which are also unreachable (see 5.7); connection errors only retry by accident, because
"could not reach" happens to match.

### 5.3 The reported model names the one that FAILED, not the one that answered — HIGH
Stub log: `REQ#1 deepseek-v4-flash-0731` (429), `REQ#2 deepseek-chat` (answered).
CLI JSON: `"model": "deepseek/deepseek-v4-flash-0731"`. The human run says the primary too, and
nothing anywhere says a fallback was used. `usedFallback` and `chainTried` are computed at
`lib/chain.mjs:123-124` and consumed by nothing outside the test file.

`lib/chain.mjs:99`: *"⚠️ THE RESULT SAYS WHICH MODEL ANSWERED. A silent downgrade that returns
a weaker model's output without saying so is the dishonest version of this feature."*
Any benchmarking or cost-attribution script reading this field gets a factually wrong answer.

### 5.4 Any 200 that is not an SSE stream is a hard failure — HIGH
A textbook `200 {"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}` reports
`✖ the stream closed without sending anything`. In the 429-then-ok run the stub log proves
provider 2 returned a **valid completion** and the CLI still failed — and the error is not
retryable, so the chain stopped after 2 attempts.

`model.mjs:340-348` documents a fallback for exactly this ("a provider that ignored
`stream:true`... Falling through to the whole-body path is more useful than failing") but gates
it on `if (!res.body)`, and undici always populates `res.body` on a body-bearing response. The
branch can never execute. Any provider or gateway answering with whole JSON turns a paid
successful completion into a hard failure.

### 5.5 The API key is printed verbatim when an upstream echoes request headers — HIGH
```
authorization: Bearer sk-or-v1-SECRETCANARY99887766554433221100
```
**RE-VERIFIED by reading `lib/model.mjs:164-172`:** `classifyHttpFailure` takes
`(bodyText||'').slice(0,400)` and prints it as `detail`, unredacted, in every branch. Corporate
proxies and API gateways routinely echo the offending request in an error page, so the key lands
in terminal scrollback, CI job logs, and whatever the user pastes into a bug report. Redact
`/sk-or-v1-[A-Za-z0-9]+/` and any `authorization:` line in the same function that already
truncates for readability.

### 5.6 `HTTP_PROXY` / `HTTPS_PROXY` are silently ignored — HIGH
A local stub playing the proxy received **zero** requests while the CLI reported
`Could not reach OpenRouter: fetch failed / Check the network`.
`grep -rn 'PROXY|ProxyAgent|setGlobalDispatcher' lib/` returns nothing but prose comments.
Node's fetch ignores proxy env vars unless a `ProxyAgent` is installed. A developer whose only
egress is a corporate proxy cannot use the CLI at all, and is told the network is at fault when
the network is fine. `README.md` has zero mentions of proxy, firewall, offline, or
`NODE_EXTRA_CA_CERTS`.

### 5.7 Every transport failure collapses to "fetch failed" — MEDIUM
DNS failure, connection refused, a self-signed TLS MITM, and a corporate 407 all print the
identical two lines. The real causes are available and discarded: `ENOTFOUND`, `ECONNREFUSED`,
`DEPTH_ZERO_SELF_SIGNED_CERT`. `describeTransportError` (`lib/model.mjs:197-204`) uses only
`err.message`, which is always the literal string "fetch failed" — while **two other modules in
the same package already use `err?.cause?.code` correctly** (`lib/github.mjs:100`,
`lib/media.mjs:122`). On a blackhole IP the user sits in silence for 44 s before getting that
message. The self-signed case should say "if you are behind a corporate proxy, set
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem`" — verified: that env var does fix it.

Also: *"this repo has a documented captive-portal problem on some wifi"* is internal monorepo
context shipping to end users of a published npm package.

### 5.8 Retries fire with zero backoff and ignore `Retry-After` — MEDIUM
```
REQ#1 +0ms · REQ#2 +18ms · REQ#3 +22ms · REQ#4 +25ms
```
The whole chain is exhausted in 25 ms. `retry-after: 30` is never read
(`grep -rn 'retry-after' lib/` → nothing). Against a real per-minute limiter this hits the same
limit four times and on some providers extends the penalty window. The user-facing message says
"Wait and re-run" — advice the tool does not take itself.

### 5.9 A 404/400 on the primary model stops the chain — MEDIUM
`lib/chain.mjs:129-137` stops early on anything non-retryable, justified as "a bad key or a
malformed request will fail identically on every provider". True for 401/402, **false for
404/400-invalid-model**, because each chain entry sends a *different* model id. When
`DEFAULT_MODEL` is eventually retired by OpenRouter, every unconfigured install stops working
instantly even though three configured fallbacks are healthy.

### 5.10 The empty-200 matcher misses three of its four call sites — MEDIUM
**RE-VERIFIED:**
```
isRetryable("the stream closed without sending anything")            = false
isRetryable("the model returned no choices — nothing to act on")     = false
isRetryable("OpenRouter returned a 200 with a body that is not JSON.")= false
```
`lib/chain.mjs:85-90` calls the empty-200 test *"the single most important line here"*.
`lib/stream.mjs:135` was deliberately worded to match it; `extractReply` and the two
200-with-bad-body errors in `callModel` were not. Latent today because production always
streams — fix the matcher, not four call sites' wording.

### 5.11 The "provider chain" is four models behind ONE host — LOW
Only two URLs exist in the package and both are `openrouter.ai`. A dead-host run does four DNS
lookups of the same hostname and reports "every provider in the chain failed". `chain.mjs`'s
header opens *"⭐⭐ NEVER SINGLE — a one-provider agent is a one-provider outage"*, but the
redundancy is against **model** availability, not provider availability, so the stated failure
mode is entirely unmitigated. `OPENROUTER_URL` is also not env-overridable, so a self-hosted
gateway or an on-prem LiteLLM proxy cannot be pointed at.

### 5.12 `ACUVO_FALLBACK_MODELS` works but is documented nowhere — LOW
Verified working (trims whitespace, preserves order, dedupes). README mentions: 0. `--help`
mentions: 0. The one lever a user has for provider resilience is invisible.

### What passed here
A **real** OpenRouter call works end to end (3.2 s, file written,
`deepseek/deepseek-v4-flash-0731 · 1081 tokens · $0.000088`), so every failure above is real,
not a broken harness. **Failover does happen** and is provable (429 → fallback answered). The
stop-early table is correct and fast for 401/402/404: exactly one request each, 0.8–1.3 s, each
message naming the cause and the fix (402 links openrouter.ai/credits and suggests a `:free`
model). Missing key: 0.8 s, exit 2, an excellent first-run message; a whitespace-only key is
treated as missing. The empty-200 reasoning-budget case **is** handled on the streaming path —
a stream of role-only frames retried all four chain entries. `lib/github.mjs` is the model for
how to do this, naming `ENOTFOUND` / `ECONNREFUSED` / `DEPTH_ZERO_SELF_SIGNED_CERT` every time.
The circuit breaker works (107 ms → 1 ms with "not responding this session"). **No credential
forwarding on a cross-origin 307 redirect.** `--json` on a clean model failure emits exactly one
valid JSON object. `NODE_EXTRA_CA_CERTS` does work against a self-signed MITM. `lib/mcp.mjs` is
stdio-only — no HTTP attack surface.

---

## 6. TERMINAL RENDERING

### 6.1 Under `--json`, colour is decided from stdout while every human line goes to stderr — MEDIUM
On a real console (obtained via `conhost.exe`, not faked):
```
TTY stdout=true stderr=false
err.txt: ^[[33m  ✎ created  a.ts^[[0m^[[2m  (9 bytes)^[[0m     ESC=4
```
`createPainter()` defaults to `process.stdout`, so `acuvo --json 2> run.log` writes ANSI into a
redirected log. The inverse is the same bug: `acuvo --json > out.json` in a live terminal makes
stdout a file, so colour is disabled and the user's terminal gets monochrome progress. The
flag's primary documented use case is exactly where colour is wrong in **both** directions.
`lib/colour.mjs`'s own header states the contract it is breaking.

### 6.2 `FORCE_COLOR=0` does not disable colour — MEDIUM
```
FORCE_COLOR=0 -> ESC=4   (colour still emitted)
NO_COLOR=1    -> ESC=0   (correct)
```
`lib/colour.mjs:46` avoids forcing colour ON for `'0'` but never forces it OFF, so
`return Boolean(stream?.isTTY)` on the next line re-enables it. `FORCE_COLOR=0` is the de-facto
kill switch (Node's docs and the supports-color convention both define 0 as disable). Invisible
until someone standardises on it in a Makefile or CI config.

### 6.3 Subprocess ANSI and cursor-control are re-printed verbatim into a pipe — MEDIUM
With `NO_COLOR=1 TERM=dumb FORCE_COLOR=0` all set and stdout a pipe:
```
      ^[[31mAssertionError: expected ^[[32m404^[[31m to equal 200^[[0m
      ^[[2Kmore output after a clear-line
```
The CLI's *own* colour is correctly suppressed; the re-emitted subprocess text is not.
`\x1b[2K` is an erase-line — replaying that log in a terminal wipes the preceding line. The
failure excerpt is the CLI's report about the run, not a transparent tty passthrough, so it owns
the bytes. `stripColour` already exists at `lib/colour.mjs:80`.

### 6.4 Truncation splits surrogate pairs — MEDIUM
```
mcp   : "xxx\ud83d"  lone surrogate = true
label : "yy\ud83d…"  lone surrogate = true
json  :              lone surrogate = true
```
`turn.mjs:637` `.slice(0,90)`, `parallel.mjs:99` `.slice(0,39)`, `report.mjs:145` `.slice(0,300)`
and `command.mjs:479-481`'s head/tail slices all cut at UTF-16 code-unit boundaries. On screen
the orphan renders as U+FFFD; in `--json` Node emits `\ud83d`, which is well-formed JSON but
**not encodable as UTF-8** — any consumer decoding it into a UTF-8 file, a Postgres text column
or a strict socket will error or substitute. Fix: `[...s].slice(0,n).join('')`.

### 6.5 Nothing reads terminal width — MEDIUM
`grep -rn 'stdout.columns\|getWindowSize\|process.env.COLUMNS' lib bin` → **none**. Rules are
hardcoded at 42 / 45 / 66 columns; `--help`'s longest line is 119 chars.
```
COLUMNS=20: 18/30 lines overflow   COLUMNS=40: 16/30
COLUMNS=60: 11/30                  COLUMNS=80:  5/30
help lines wider than 40: 22 of 32
```
At 40 columns the round rule leaves a two-character orphan row `──`, and
`      AssertionError: expected 404 to eq` continues at column 0 as `ual 200`, destroying the
nesting the whole report layout depends on. Even at 80 the CLI writes its own 96-char line.
Nothing needs to reflow at ≥80; a 40-column pane should not shred.

### 6.6 The end-of-run summary is unpainted while the live stream is painted — LOW
```
LIVE   : "\e[33m  ✎ created  a.ts\e[0m\e[2m  (9 bytes)\e[0m"
SUMMARY: "  created   a.ts  (9 bytes)"
```
`formatChanges` accepts `{ paint }` and implements the whole painted path; neither of its two
call sites passes one. The feature is written and unreachable, and the report block looks washed
out next to the stream above it.

### 6.7 An EMPTY `WEZTERM_PANE` is treated as WezTerm — LOW
```
WEZTERM_PANE=""    -> "kitty"
KITTY_WINDOW_ID="" -> null      ← every sibling check is a truthiness test
```
`lib/terminal-graphics.mjs:73` is the only branch written as `!== undefined`. A shell rc, a
container spec, or an ssh/tmux env passthrough that exports the name without a value trips it,
and the consequence is what the file's own header forbids: *"a few kilobytes of base64 vomited
into a pipe is worse than any missing feature."*

### What passed here
Plain pipe with no env set: **zero** ANSI bytes on stdout across the full renderer. On a real
Windows console: colour ON by default, `NO_COLOR=1` → OFF, `TERM=dumb` → OFF, and
`NO_COLOR=1 + FORCE_COLOR=1` → OFF (NO_COLOR correctly wins). The one-shot `--json` path is
clean: a real run with a CJK+emoji task produced 820 bytes of strictly-parseable JSON on stdout
with 0 ESC bytes, every human line on stderr. Inline-image gating is correctly conservative:
kitty env + non-TTY → null, unknown TERM on a TTY → null, and the 1.5 MB ceiling declines out
loud. Unicode content round-trips byte-exact through the `read_lines` gutter — CJK, Arabic RTL,
combining marks, a 4-person ZWJ family emoji; a file with no trailing newline reports 3 lines,
not 4; CRLF is preserved. A workspace path containing `日本語 🚀 dir` works end to end. Usage
errors write 0 bytes to stdout; `--version`/`--help` write 0 bytes to stderr. Interactive mode
with stdin closed exits 0 cleanly. Output is capped at 8,000 chars with a declared head/tail
split. **There is no column-alignment code padding against user text anywhere** — every
`padEnd`/`padStart` operates on ASCII-only tokens, so the classic wide-character padding bug
does not exist here.

---

## 7. DOCUMENTATION TRUTH

### 7.1 The two spend defaults are both wrong — HIGH
**RE-VERIFIED 2026-08-10:**
| claim | README | `--help` | code |
|---|---|---|---|
| `--max-rounds` | Default **3** (`README.md:69`) | default **5** | `cli-args.mjs:96` = **5** |
| `--max-tokens` | Default **8000** (`README.md:72`) | default **12000** | `model.mjs:97` = **12_000** |

`README.md:63` asserts *"Every flag below is real; run `acuvo --help` for the authoritative
list"* while the two disagree. A user budgeting a batch from the README under-counts paid
completions by 67% and the per-reply ceiling by 50% — and `cli-args.mjs:78-80` measures the same
task at $0.000378 on 3 rounds vs $0.000784 on 5, a **107% increase**.

The irony is documented in the source: `cli-args.mjs:110-113` explains that the `--help` line
was made interpolated *precisely so* a hardcoded number could not lie once the constant moved.
The fix was applied to `--help` and never to the README. (`turn.mjs:700` still exports a
separate `DEFAULT_MAX_ROUNDS = 3` for library callers — the divergence `cli-args.mjs:24-30`
names as real debt, and almost certainly where the stale README number came from.)

### 7.2 The security section omits `evaluate`, a second execution path — HIGH
`grep -c evaluate README.md` → **0**. Yet `toolNamesForRounds(5,{env:{}})` offers it in every
multi-round run, and it executes model-authored source:

```
{"ok":true,"exitCode":0,"stdout":"SPAWNED: arbitrary-program-ran\n"}
```
— the snippet spawned `cmd`, a program the documented allowlist refuses. The source never passes
the character whitelist (it arrives as a JSON string, by design), the file *is* `unlinkSync`'d
in a `finally` so it is not left on disk, and `renderToolRecord` has no `evaluate` case, so the
**user sees only `· evaluate`** — the source is echoed to the model, never to the human.

`README.md:147` titles the section *"What it can execute — read this before trusting it"*;
`:149` says *"Four programs, and nothing else"*; `:155` says *"`node --eval` is refused (code
that never touches disk cannot be reviewed afterwards)"*; `:165` gives the mitigation as *"the
code is on disk, written by tools that could not leave the workspace, and shown to you before it
runs"*. All three are false for `evaluate`. This is **not** a claim that `evaluate` is unsafe —
`evaluate.mjs:24-34` makes a defensible case that it adds nothing over write+run. It is that the
one section a reader is told to consult before trusting the tool does not mention it exists.

### 7.3 The MCP client and server are undocumented — MEDIUM
README mentions "MCP" exactly once (`:21`), and only to name Playwright MCP and Chrome DevTools
MCP as *competitors*. Meanwhile the CHANGELOG headlines *"**MCP client.** Connect to any Model
Context Protocol server declared in `.acuvo/mcp.json` … Verified live"*, and on disk sit
`lib/mcp.mjs` (16.5 kB), `lib/mcp-server.mjs` (34.5 kB), `bin/acuvo-mcp.mjs` (5.6 kB) and a
19 kB `MCP-MVP.md`. A stranger concludes acuvo cannot speak MCP in either direction. The
`.acuvo/mcp.json` config that drives the client is documented nowhere a first-time reader looks,
and `MCP-MVP.md` contains zero occurrences of the string `acuvo-mcp`, so there is no second door.

### 7.4 The README still teaches the obsolete `--env-file` dance — MEDIUM
`README.md:51-55` tells users to run `node --env-file=.env acuvo-code/bin/acuvo.mjs`, while
`bin/acuvo.mjs:98-103` already auto-loads `.env` from the workspace root and cwd. The code's own
comment at `:86-88` says so: *"It also removes the `--env-file` dance the README documents"*.
Two consequences, and the second matters more: users perform an obsolete ritual, **and**
`acuvo --dir some/other/repo` silently reads that repo's `.env` into the agent process with
nothing in the README saying so (see 3.11). The README boasts at `:159` that the child gets a
scrubbed environment, which makes an undocumented read of a third-party `.env` into the *parent*
a gap in exactly the section claiming rigour.

### 7.5 The screenshot-cost comparison is roughly 10× off — MEDIUM
`README.md:21`, arguing against Playwright MCP / Chrome DevTools MCP: *"What they return is an
image, which costs fifteen to twenty-five thousand tokens"*. Against published per-image
accounting: Anthropic bills ~(w×h)/750 with the long edge downscaled to 1568 px, capping a
screenshot near ~1,600 tokens; OpenAI GPT-4o high-detail caps at 85 + 170×16 = 2,805; Gemini
bills 258 per tile. A 1280×3000 full-page capture lands near 1,400 tokens, not 15,000–25,000.

This is the load-bearing sentence of the product's central differentiation, and it is unsourced.
The underlying argument survives at true numbers (200 measured tokens vs ~1,500 uninterpreted
ones is still ~7× plus a better answer), so the fix is to state a defensible figure.
**⚠️ Evidence basis, stated honestly:** this is arithmetic from published vendor tokenizer rules,
not a live measurement — a real Playwright MCP screenshot call could not be reproduced here.
Treat as a claim needing a citation, not a proven falsehood.

### 7.6 `--help`'s "Environment" block lists 2 of 10 variables — MEDIUM
It names `OPENROUTER_API_KEY` and `OPENROUTER_CODEGEN_MODEL`. The code also reads
`RENDER_AUDIT_URL`/`MODAL_RENDER_AUDIT_URL`, `MODAL_TTS_URL`, `MODAL_TRANSCRIBE_URL`,
`MODAL_PRESS_URL`, `MODAL_VIDEO_SECRET`, `PERCHANCE_IMAGE_URL`, `GITHUB_TOKEN`/`GH_TOKEN`,
`ACUVO_FALLBACK_MODELS` and `ACUVO_INLINE_IMAGES`. `see_page` is the capability the README leads
with, and the only way to turn it on is an env var `--help` never names. The README's media
table covers 5 of these; neither source covers `MODAL_VIDEO_SECRET`, `ACUVO_FALLBACK_MODELS` or
`ACUVO_INLINE_IMAGES`.

### 7.7 The media table omits `MODAL_VIDEO_SECRET` — MEDIUM
`media.mjs:88` reads it and all four endpoints post it (render `:249`, speak `:371`, transcribe
`:392`, document `:418`). `bin/acuvo-mcp.mjs:94` documents it verbatim. README: zero matches. A
reader who configures exactly what the table lists may get auth failures. The table is presented
as the complete gate for each optional tool, and it is complete for URLs and silent on the
credential.

### 7.8 "One file of Node" — there are 34 lib modules and 2 binaries — LOW
`README.md:5`. `ls lib/*.mjs | wc -l` → 34 (turn.mjs alone is 83 kB). "Zero dependencies" is
true and verified (both dependency maps are `{}`); "no framework" and "no install-time build
step" are true. Only "one file" is false, and it is in the second sentence a reader sees — it
reads as *"this is small enough to audit before I run it on my machine"*, which makes it the
wrong sentence to be wrong.

### 7.9 Only exit codes 0 and 1 are documented — LOW
`README.md:84` mentions 1. The CLI also returns 2 and 64, and `bin/acuvo.mjs:15-17` calls exit
codes "part of the contract". A CI script written from the README treats a missing key or a
typo'd flag as an unclassified failure.

### What passed here (a large majority of the README survived)
**Every claim in "What it can execute" held under probing** — 17 command strings through
`validateCommand`: `node <file>`, `node --test`, `npm test`, `npm run <script>`,
`npx vitest run`, `tsc --noEmit` all ALLOW; `rm`, `git`, `python`, `npm install`, `npm ci`,
`npx create-react-app` all REFUSE; `npm test && curl x` dies on the `&` character, not a
blacklist, exactly as described; `node --eval` dies on the quote and `node -p` gets the
documented reason. `ALLOWED_BINARIES` really is exactly `['node','npm','npx','tsc']` — "four
programs" is literally true. npm-script-body validation including `pre`/`post` hooks is real.
**Environment scrubbing is real and measured**: `OPENROUTER_API_KEY`, `AWS_SECRET_ACCESS_KEY`,
`GITHUB_TOKEN` and `MY_PASSWORD` all stripped, and a live `evaluate` snippet confirmed
`process.env.OPENROUTER_API_KEY` is absent inside the child. **Every git claim**: only 4 verbs
exist, so push/reset/checkout/rebase/merge genuinely are inexpressible; `gitCommit` hard-refuses
without `paths`; `NEVER_COMMIT` covers `.env`, `id_rsa`/`id_ed25519`, `*.pem|pfx|p12|key`,
`credentials.json`, `.npmrc`, `.aws/`; the inside-a-larger-repo refusal exists with the exact
stated reasoning. `--version`/`--help` work with no key. `npm test` = 316 tests, no network, no
key, and the areas the README names all have real coverage; the "deeper suite in the parent
monorepo" exists. The `--json` shape is exactly as documented on the one-shot path.
`sessionFailed` implements "exit 1 if the last command it ran still fails" precisely. The media
table's 5 env var **names** are all correct, and "a tool whose service is absent is never
mentioned" holds for the 4 media tools. `--no-run` correctly withholds `run_command`, `evaluate`
and `git_commit` while keeping reads and writes. `--max-rounds 1` really is write-only. gh login
reuse is real. The `--parallel ... --concurrency 3` example parses. Model default, `--timeout`
180 and `--command-timeout` 120 all match the constants. The bench really does have 7 tasks.

---

# APPENDIX — REPAIR INSTRUCTIONS

Three repairs, one file each, no overlap. Chosen for severity × smallness.

## R1 — `lib/edit.mjs`: refuse non-UTF-8 instead of destroying it

`editFile` reads with `readFileSync(target.absolute, 'utf8')` at line 100 and writes back with
`writeFileSync(..., 'utf8')` at line 118. Any byte sequence that is not valid UTF-8 decodes to
U+FFFD and is written back as `ef bf bd`, permanently. The existing binary guard at line 111
only checks for `\u0000`, which latin-1 / cp1252 / Shift-JIS text does not contain.

Read the file as a **Buffer**, then either (a) verify a lossless round trip
(`buf.equals(Buffer.from(buf.toString('utf8'), 'utf8'))`) or (b) decode with
`new TextDecoder('utf-8', { fatal: true })` inside a try/catch. On failure return
`{ ok: false, error: '<path> is not valid UTF-8 — refusing to edit it as text' }`, matching the
wording style of the existing binary and UTF-16 refusals. Keep the NUL check.

Also fix `previousBytes`: it currently reports the *post-decode* byte length (25 for a 17-byte
file). It must be the true on-disk size before the write — take it from the Buffer's `length`
(or a `statSync` before writing).

Regression test to add: write `Buffer.from([0x48,0x65,0x6c,0x6c,0x6f,0x20,0xff,0xfe,0xe9,0xe8,
0x0a,0x53,0x45,0x43,0x52,0x45,0x54])`, call `editFile(root,'latin1.txt','SECRET','PUBLIC')`,
assert `ok === false` and assert the file's bytes are unchanged.

## R2 — `lib/command.mjs`: make the timeout fire, and kill the tree

Two coupled bugs in `spawnBounded` (~lines 539-592).

**(a) Settle on the right event.** The promise resolves only from `child.on('close', ...)`,
which requires EOF on the captured stdout/stderr pipes. When the timeout SIGKILLs npm, npm's
script descendant survives holding the inherited pipe write handles, EOF never arrives,
`finish()` is never called, and the tool call hangs forever. Add `child.on('exit', ...)`, or arm
a short grace timer (~500-1000 ms) inside the timeout handler that calls `finish({ ok: true,
exitCode: null, signal: 'SIGKILL', timedOut: true, ... })` with whatever output was captured,
regardless of pipe state. Keep `close` as the normal-path settle so full output is still
collected when the process exits cleanly; `settled` already guards the double-resolve.

**(b) Kill the descendant tree.** `child.kill('SIGKILL')` is `TerminateProcess` against the
direct child on Windows and a single-pid signal on POSIX, so servers, watchers and worker pools
started by the command are orphaned and run until reboot. On Windows spawn
`taskkill /T /F /PID <child.pid>` (`windowsHide: true`, output ignored, wrapped in try/catch).
On POSIX, spawn with `detached: true` and kill the group with `process.kill(-child.pid,
'SIGKILL')`, falling back to the single-pid kill if that throws. Keep the existing
`try { ... } catch { /* already gone */ }` shape — a failure to kill must never throw.

Regression test to add (the class has **zero** coverage today, which is why the suite is green
over a totally broken flag): a workspace whose `package.json` `test` script runs a script that
spawns a child and then `setInterval`s forever. Assert `executeRunCommand({command:'npm test',
timeoutMs: 4000})` resolves within ~6 s with `timedOut: true`, and assert the recorded grandchild
pid is gone afterwards. Must use a real spawn, not the `spawnImpl` stub.

## R3 — `lib/search.mjs`: stop lying to the model about what was searched

Three defects, all in this file, all producing silent wrong answers the agent believes.

**(a) Report skipped files.** `searchText` skips files over the size cap (line ~152) and files
containing a NUL byte (~158) and returns `{matches: [], truncated: false, scanned: N}` — three
fields that together assert "everything was looked at and the string is not there". Add
`skipped: [{ path, reason: 'over 512KB' | 'binary' }]` (or at minimum a count) to the result, so
"not found" and "not looked at" are distinguishable. The module already treats truncation as
sacred for exactly this reason — apply the same rule to skips.

**(b) Fix `**/`.** `globToRegExp('**/*.json')` produces `/^.*\/[^/]*\.json$/i`, where the `/` is
mandatory, so `**/*.json` misses top-level `package.json` while the narrower `*.json` finds it.
`**/` must match **zero or more** directory segments — emit `(?:.*\/)?` for a `**/` prefix, per
bash globstar / minimatch / ripgrep semantics. Add cases asserting `**/*.json` returns both
`package.json` and `src/a.json`, and that `**/*.tsx` at a repo root includes the top-level file.

**(c) Apply the credential filter.** `searchText` returns the contents of `id_rsa`,
`secrets.json` and `config/credentials.yml` straight into the prompt. `turn.mjs:112-135` calls
this class "THE WORST BUG THIS PACKAGE HAS HAD" and fixed it for the automatic pre-load by
reusing `refusedCommitPath` from `lib/git.mjs` — the same guard must apply here, since the tool
is callable in round 1 and feeds the same prompt. Withhold matching files and report
`withheld: N` rather than silently dropping them (see (a) — the whole point is that skips are
never silent). Import `refusedCommitPath`; do not re-implement the list.

---

## HOUSEKEEPING

No processes were left running by this audit. `tasklist | grep -i node` checked clean at the
end of every pass. The source tree was treated as read-only except for this file; all mutation
happened in temp copies under the session scratchpad.
