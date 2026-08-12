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
 * only ever connects to **a port this module started itself**, on loopback,
 * discovered from that process's own output. Not "loopback is allowed now" —
 * "this specific port, because we launched the thing listening on it". A
 * capability the model cannot aim anywhere else.
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
 */

import { spawn } from 'node:child_process';

import {
  validateCommand,
  buildInvocation,
  buildShellInvocation,
  resolveCommandAllowlist,
  scrubEnvironment,
  killProcessTree,
  clampOutput,
  MAX_COMMAND_TIMEOUT_MS,
} from './command.mjs';

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
        process.exit(code);
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
 * The port a process announced, or null. Exported because "we only probe a port
 * we started" is a security claim, and it is only true if this is testable.
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
 * Start a long-running command.
 *
 * @returns {{ok: true, id: string, pid: number|null, note: string}|{ok: false, error: string}}
 */
export function startBackground({
  command,
  executor,
  shell = false,
  spawnImpl = spawn,
  env = process.env,
}) {
  if (executor?.dryRun) {
    return { ok: false, error: 'this is a --dry-run, so nothing is started (a server writes logs and binds a port, which a dry run promises not to do)' };
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
   * ⚠️ THE SAME TWO PATHS `executeRunCommand` USES, AND THEY SHARE NOTHING.
   * `command.mjs` states the reason: a validator that sometimes validates is the
   * shape that produces a "safe" mode which quietly is not.
   */
  let invocation;
  if (shell) {
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
    invocation = buildInvocation(valid, executor.root);
    if (invocation.ok === false) return { ok: false, error: invocation.error };
  }

  counter += 1;
  const id = `bg${counter}`;
  const rec = {
    id,
    command,
    log: '',
    truncated: false,
    port: null,
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
      env: scrubEnvironment(env),
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
export async function checkBackground(id, { probe = probePort } = {}) {
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
          'Returns an id. Call check_process with that id in a LATER round to read its output and find out',
          'which port it bound. Everything started this way is killed automatically when this run ends.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command, e.g. "npm run dev". Same rules and allowlist as run_command.' },
          },
          required: ['command'],
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
      return startBackground({ command: String(args.command ?? ''), executor, shell, env });
    case 'check_process':
      return checkBackground(String(args.id ?? ''));
    case 'stop_process':
      return stopBackground(String(args.id ?? ''));
    default:
      return { ok: false, error: `unknown background tool "${name}"` };
  }
}
