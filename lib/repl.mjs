/**
 * ── ⭐⭐ A REPL THE AGENT CONVERSES WITH — AND NOBODY ELSE HAS ONE ───────────
 *
 * `evaluate` writes a snippet to a file and runs it in a fresh process. So does
 * every other terminal coding agent: Claude Code, Cursor, Codex and Aider all
 * execute statelessly, and none of them can hold a value between two thoughts.
 *
 * ⚠️ THAT IS NOT HOW ANYBODY DEBUGS. A human loads the module, looks at a value,
 * pokes the object, tries the fix on the live thing. Statelessly, the agent must
 * RE-DERIVE THE ENTIRE SETUP to check one field — which is exactly why models
 * rewrite a whole script to answer a question a single expression would settle,
 * and why each of those rewrites is another paid round.
 *
 * Measured shape of the win: reading a config, parsing it, and inspecting one
 * nested key is three `evaluate` calls that each re-read and re-parse, or three
 * lines in one REPL session where line 2 can see line 1.
 *
 * ── WHY THIS IS RARE RATHER THAN MERELY MISSING ─────────────────────────────
 *
 * It is rare because it is annoying: `node -i` is built for a human, so driving
 * it means parsing prompts, echoes and continuation state, and that parser
 * breaks on the first multi-line paste. `repl-driver.mjs` sidesteps all of it
 * with a JSON-lines protocol we own — which is less code than the parser would
 * have been, and cannot be confused by output that happens to contain `> `.
 *
 * ⚠️ SAME GOVERNANCE AS EVERY OTHER PROCESS. `--no-run` withholds it, a dry run
 * refuses it, it is killed on exit and on Ctrl-C with the whole tree, and there
 * is a hard cap on how long one expression may run. A stateful process is more
 * useful than a stateless one and exactly as dangerous, so it gets exactly the
 * same locks.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { killProcessTree } from './command.mjs';

const DRIVER = fileURLToPath(new URL('./repl-driver.mjs', import.meta.url));

/** One expression should not be able to hang the run. */
export const DEFAULT_EVAL_TIMEOUT_MS = 15_000;
export const MAX_EVAL_TIMEOUT_MS = 60_000;

/** Source cap, matching `evaluate` — past this, it belongs in a file. */
export const MAX_CODE_CHARS = 4_000;

/** ⚠️ ONE SESSION PER WORKSPACE. Two would mean two truths about the same state. */
const sessions = new Map();
let hooked = false;

function installExitHooks() {
  if (hooked) return;
  hooked = true;
  const killAll = () => {
    for (const s of sessions.values()) releaseSession(s);
    sessions.clear();
  };
  process.once('exit', killAll);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGBREAK', 149]]) {
    try { process.once(sig, () => { killAll(); process.exit(code); }); } catch { /* no SIGBREAK off Windows */ }
  }
}

function start(root, { spawnImpl = spawn } = {}) {
  const child = spawnImpl(process.execPath, [DRIVER], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  const session = { child, root, buffer: '', pending: new Map(), seq: 0, defined: [] };

  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on?.('data', (chunk) => {
    session.buffer += chunk;
    let nl;
    while ((nl = session.buffer.indexOf('\n')) !== -1) {
      const line = session.buffer.slice(0, nl);
      session.buffer = session.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const entry = session.pending.get(msg.id);
      if (entry) { session.pending.delete(msg.id); clearTimeout(entry.timer); entry.resolve(msg); }
    }
  });

  child.stderr?.setEncoding?.('utf8');
  child.stderr?.on?.('data', () => { /* the driver reports errors as data, not on stderr */ });

  /**
   * ⚠️⚠️ A DEAD CHILD MUST NOT EVICT ITS OWN SUCCESSOR.
   *
   * `exit` arrives asynchronously — after `replReset` has already deleted this
   * entry and, very often, after a later `replEval` has registered a REPLACEMENT
   * session under the same root. An unconditional `sessions.delete(root)` then
   * removes the LIVE session's entry, so the next `replReset` reports "no REPL
   * was running" and nothing ever releases that child. It holds the event loop
   * open for the life of the process.
   *
   * Measured 2026-08-12: reset → eval → reset hangs forever; a single reset
   * exits in 0.4s. It is what hung the suite.
   */
  child.on?.('exit', () => {
    for (const [, e] of session.pending) {
      clearTimeout(e.timer);
      e.resolve({ ok: false, error: 'the REPL process exited — its state is gone. The next repl call starts a fresh one.' });
    }
    session.pending.clear();
    if (sessions.get(root) === session) sessions.delete(root);
  });

  /**
   * ⭐ A REPL CHILD MUST NEVER DECIDE WHEN ITS OWNER EXITS. Unref'd, the session
   * stays fully usable — unref only stops it holding the event loop. Without
   * this, a process that started a REPL and never reset it can never exit, and
   * `installExitHooks`'s cleanup deadlocks: it runs on 'exit', which cannot fire.
   */
  try { child.unref?.(); } catch { /* a stubbed child in a test */ }
  /**
   * ⚠️ `child.unref()` releases the PROCESS handle and nothing else — the three
   * pipes are separate libuv handles and each one holds the loop on its own.
   * Measured: with only the process unref'd, a session that is opened and never
   * reset still hangs its owner forever. Unref does not stop data flowing, so
   * replies still arrive; it only removes "a REPL is open" as a reason to stay
   * alive. While a call is in flight its own timeout timer keeps the loop up.
   */
  for (const pipe of [child.stdin, child.stdout, child.stderr]) {
    try { pipe?.unref?.(); } catch { /* a stubbed child in a test */ }
  }

  installExitHooks();
  sessions.set(root, session);
  return session;
}

/**
 * Evaluate one expression or block, keeping everything it defines.
 *
 * @returns {Promise<object>}
 */
export async function replEval(root, code, { timeoutMs = DEFAULT_EVAL_TIMEOUT_MS, dryRun = false, spawnImpl } = {}) {
  if (dryRun) {
    return { ok: false, error: 'this is a --dry-run, so nothing is evaluated (a REPL runs your code for real)' };
  }
  if (typeof code !== 'string' || code.trim() === '') {
    return { ok: false, error: 'code is required — the JavaScript to evaluate' };
  }
  if (code.length > MAX_CODE_CHARS) {
    return {
      ok: false,
      error: `the code is ${code.length} characters, over the ${MAX_CODE_CHARS} limit — write it to a real file and import it here instead`,
    };
  }

  const bounded = Math.min(Math.max(500, timeoutMs), MAX_EVAL_TIMEOUT_MS);
  const session = sessions.get(root) ?? start(root, { spawnImpl });
  const fresh = session.seq === 0;
  session.seq += 1;
  const id = session.seq;

  const reply = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      /**
       * ⚠️ A TIMEOUT KILLS THE SESSION, and it has to. The driver is
       * single-threaded, so an expression stuck in a loop means every later
       * call would queue behind it forever — a REPL that answers nothing is
       * worse than no REPL, because the model keeps waiting instead of trying
       * something else.
       */
      try { killProcessTree(session.child); } catch { /* gone */ }
      sessions.delete(root);
      resolve({
        ok: false,
        error: `the expression did not finish within ${bounded}ms, so the REPL was stopped and its state discarded. `
          + 'An infinite loop or a hanging await is the usual cause.',
      });
    }, bounded + 500);
    session.pending.set(id, { resolve, timer });
    try {
      session.child.stdin.write(`${JSON.stringify({ id, code, timeoutMs: bounded })}\n`);
    } catch (e) {
      clearTimeout(timer);
      session.pending.delete(id);
      resolve({ ok: false, error: `could not reach the REPL: ${e?.message ?? e}` });
    }
  });

  if (reply.defined) session.defined = reply.defined;
  return {
    ...reply,
    /**
     * ⭐ THE NAMES IT IS CARRYING, returned every time. The one thing a model
     * cannot know about a stateful tool is what state it is in, and guessing is
     * how it re-declares a const and gets a confusing error.
     */
    defined: session.defined,
    startedFresh: fresh,
  };
}

/**
 * ── ⚠️⚠️ STOPPING MUST NOT BE A RACE ────────────────────────────────────────
 *
 * `killProcessTree` is ASYNCHRONOUS on Windows: it spawns `taskkill /T /F` and
 * returns before the child is gone. Killing alone is therefore not enough to
 * let THIS process exit — we opened three pipes to that child, and Node keeps
 * an event loop alive for them. A process with no work left still cannot die.
 *
 * ⭐ That is not a theoretical window. It hung the full suite on 2026-08-12
 * with every test already passed, and it only bites under load — when the
 * machine is busy, the reaper is slow, which is exactly when the suite is
 * slowest and a hang is least distinguishable from work.
 *
 * ⚠️ AND KILLING FIRST IS BACKWARDS. `taskkill` guts the child mid-flight and
 * leaves this side's pipes half-open, so destroying them afterwards does not
 * return the libuv handles. Measured: `replReset` alone leaves one ProcessWrap
 * and five PipeWrap behind, and that one test hangs its own file.
 *
 * ⭐ THE DRIVER ALREADY KNOWS HOW TO DIE. `repl-driver.mjs` ends with
 * `rl.on('close', () => process.exit(0))` — closing its stdin IS the shutdown
 * signal. Ask nicely, unref so we never wait, and keep the reaper only as a
 * fallback for a driver wedged so badly it stopped reading stdin. Cooperative
 * shutdown is what actually releases the handles; the kill is insurance.
 */
const STOP_GRACE_MS = 2_000;

function releaseSession(session) {
  const child = session.child;
  // 1. The shutdown signal the driver is already listening for.
  try { child?.stdin?.end?.(); } catch { /* already closed */ }
  // 2. Never let a child we have finished with hold this process open.
  try { child?.unref?.(); } catch { /* a stubbed child in a test */ }
  // 3. Insurance only. Unref'd, so if we are exiting anyway it never fires and
  //    the OS reaps the child — nothing waits on this.
  try {
    const t = setTimeout(() => {
      try { killProcessTree(child); } catch { /* already gone */ }
    }, STOP_GRACE_MS);
    t.unref?.();
  } catch { /* no timers in this context */ }
}

/** Throw the session away. Idempotent — resetting nothing is a success. */
export function replReset(root) {
  const session = sessions.get(root);
  if (!session) return { ok: true, reset: false, note: 'no REPL was running, so there was nothing to clear' };
  releaseSession(session);
  sessions.delete(root);
  return { ok: true, reset: true, note: 'the REPL was stopped and every variable it held is gone' };
}

/** For tests and teardown. */
export function replStopAll() {
  for (const s of sessions.values()) releaseSession(s);
  sessions.clear();
}

export const REPL_TOOL_NAMES = ['repl', 'repl_reset'];

export function replToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'repl',
        description: [
          'Evaluate JavaScript in a session that REMEMBERS what you defined — the next call can see it.',
          'Top-level await works, so `const m = await import("./lib/thing.mjs")` then `m.parse("x")` on the next call',
          'is two lines instead of two whole scripts.',
          'Use this to INVESTIGATE: load a module, look at a real value, poke an object, try the fix on the live thing',
          'before you write it to a file. It runs in the workspace, so relative imports reach the project.',
          'A single expression returns its value; a block runs as statements.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'JavaScript. One expression returns its value; several statements run as a block.' },
          },
          required: ['code'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'repl_reset',
        description: 'Throw away the REPL session and everything it holds. Use it when the state has become confusing, or after changing a file you already imported — imports are cached, so a stale module is the one real trap here.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
}

export async function runReplTool(name, args = {}, { executor } = {}) {
  switch (name) {
    case 'repl':
      return replEval(executor.root, String(args.code ?? ''), { dryRun: executor.dryRun });
    case 'repl_reset':
      return replReset(executor.root);
    default:
      return { ok: false, error: `"${name}" is not a repl tool` };
  }
}
