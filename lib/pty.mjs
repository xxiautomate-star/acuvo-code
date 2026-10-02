/**
 * ── ⚠️⭐⭐ A REAL TERMINAL, WITHOUT TAKING A DEPENDENCY ──────────────────────
 *
 * `package.json` says `"dependencies": {}` and a test asserts it. That is not
 * tidiness — `ENTERPRISE.md` sells it, and it is the reason this package can be
 * dropped into a locked-down environment without a supply-chain review. The
 * whole of `command.mjs` is written on top of "the agent cannot pick a program";
 * a native module that compiles at install time is a second, much larger surface
 * arriving through the front door.
 *
 * ── ⚖️ THE LICENCE, READ FROM THE TARBALL AND NOT FROM THE BADGE ────────────
 *
 * `node-pty@1.1.0`, `npm pack`ed and unpacked on 2026-09-01. **MIT**, and the
 * LICENSE file carries three stacked MIT notices that agree with each other:
 * Christopher Jeffrey (2012–2015), Daniel Imms (2016), Microsoft (2018–present).
 * The bundled `deps/winpty` is MIT by its own README. No headcount clause, no
 * commercial restriction, no field-of-use limit.
 *
 * ⚠️ THE MANIFEST FIELD AND THE LICENCE FILE AGREE HERE, WHICH IS THE ONLY
 * REASON THAT SENTENCE IS WORTH ANYTHING. They did not for Remotion — npm said
 * `ISC` while the real terms were a paid company licence above three people —
 * so a licence verdict in this repo is not allowed to cite the metadata field.
 *
 * ── ⚠️⚠️ AND THE LICENCE IS NOT THE REASON IT IS REFUSED AS A DEPENDENCY ────
 *
 * The same unpacked tarball, measured rather than assumed:
 *
 *   · `"scripts": { "install": "node scripts/prebuild.js || node-gyp rebuild",
 *      "postinstall": "node scripts/post-install.js" }`  ← TWO lifecycle scripts
 *   · `"dependencies": { "node-addon-api": "^7.1.0" }`   ← not zero-dep itself
 *   · `binding.gyp`, `src/*.cc`, `deps/winpty`           ← C++, compiled on miss
 *   · 63 MB unpacked, 58 MB of it prebuilt per-platform binaries, plus two
 *     unsigned Windows executables (`conpty.dll`, `OpenConsole.exe`)
 *
 * ⭐ THE DECIDING SENTENCE: `command.mjs` forces `--ignore-scripts` on every
 * install this agent performs, and argues at length that a package which runs
 * code at install time is a package a HUMAN should install. Depending on
 * node-pty would make this package require, of its own users, the exact thing it
 * refuses to let its own agent do. That is not a licence problem; it is a
 * consistency problem, and it is why the answer is "optional, never bundled".
 *
 * ⭐ SO IT WAS BUILT AS AN UPGRADE, NEVER A DEPENDENCY — AND THEN THE UPGRADE
 * WAS MEASURED AND WITHDRAWN. See the block at the bottom of this file: routing
 * commands through node-pty left the CLI process unable to exit. What survives
 * is DETECTION: this module answers whether a real terminal is available, and
 * `doctor` prints the answer alongside what runs instead. Commands always go
 * through pipes plus `interactive.mjs`, which detects the prompt and stops with
 * it quoted rather than hanging on it.
 *
 * ── ⚠️⚠️ WHY THE WORKSPACE'S OWN `node-pty` IS REFUSED, WHICH IS THE OBVIOUS
 *    IMPLEMENTATION AND IS AN ESCALATION ─────────────────────────────────────
 *
 * The natural design resolves `node-pty` from the workspace, because that is
 * where a JavaScript project would have it. It is also a full compromise of this
 * process:
 *
 *     write_file('node_modules/node-pty/index.js', <anything>)
 *     run_command('npm test')
 *
 * — and the second line loads the first into the CLI's OWN process, with the
 * CLI's own environment, before any allowlist is consulted. Everything else in
 * this package is careful that agent-written code runs only in a CHILD, with a
 * scrubbed environment and a pinned cwd. Importing from the workspace hands that
 * up in one move, and it would look like a convenience.
 *
 * ⭐ THEREFORE TWO SOURCES, BOTH OUTSIDE THE AGENT'S REACH:
 *   1. `ACUVO_PTY_MODULE` — an absolute path an operator typed. The agent has no
 *      verb that reaches a parent process's environment; same argument
 *      `ACUVO_ALLOW_INSTALL` and `ACUVO_POLICY_FILE` are built on.
 *   2. this package's OWN `node_modules`, which the agent's file tools cannot
 *      write to (they refuse every path outside the workspace).
 * The workspace is not a source and there is no setting that makes it one.
 */

import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

/** The operator's route. Absolute path to a directory or entry file. */
export const PTY_MODULE_ENV = 'ACUVO_PTY_MODULE';

/**
 * ⚠️ CACHED, INCLUDING THE FAILURE. Retrying a missing native module on every
 * command would pay the resolver cost hundreds of times to learn the same thing,
 * and a partially-built `node-pty` can take real time to fail.
 */
let cached = null;

/**
 * @typedef {{ ok: true, pty: any, from: string } | { ok: false, why: string }} PtyLoad
 */

/**
 * Load `node-pty`, or explain why there isn't one. NEVER THROWS.
 *
 * @param {{ env?: object, requireImpl?: Function }} [opts]
 * @returns {PtyLoad}
 */
export function loadPty({ env = process.env, requireImpl = null } = {}) {
  if (cached && !requireImpl) return cached;
  const result = resolvePty({ env, requireImpl });
  if (!requireImpl) cached = result;
  return result;
}

/** ⚠️ Test-only. A module-level cache that no test can clear is a flaky suite. */
export function resetPtyCache() { cached = null; }

function resolvePty({ env, requireImpl }) {
  const req = requireImpl ?? createRequire(import.meta.url);

  const declared = String(env?.[PTY_MODULE_ENV] ?? '').trim();
  if (declared) {
    /**
     * ⚠️ ABSOLUTE ONLY. A relative path resolves against a cwd that IS the
     * workspace, which is the one directory this module has just spent forty
     * lines explaining it will not load from.
     */
    if (!isAbsolute(declared)) {
      return { ok: false, why: `${PTY_MODULE_ENV} must be an absolute path (it was ${JSON.stringify(declared)}); a relative one would resolve inside the workspace, which the agent can write to` };
    }
    try {
      const mod = req(declared);
      if (typeof mod?.spawn !== 'function') {
        return { ok: false, why: `${PTY_MODULE_ENV} points at ${declared}, which loaded but has no spawn() — that is not node-pty` };
      }
      return { ok: true, pty: mod, from: declared };
    } catch (err) {
      return { ok: false, why: `${PTY_MODULE_ENV} points at ${declared} and it could not be loaded: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  try {
    const mod = req('node-pty');
    if (typeof mod?.spawn !== 'function') return { ok: false, why: 'a node-pty was found next to this package but has no spawn()' };
    return { ok: true, pty: mod, from: 'this package\'s own node_modules' };
  } catch {
    return {
      ok: false,
      why: `no node-pty is available, which is the normal case — this package has zero dependencies on purpose. Commands run through pipes instead, and an interactive prompt is detected and reported rather than answered. Installing node-pty and setting ${PTY_MODULE_ENV} makes this line report on it, but does NOT change how commands run — that transport was built, driven, and withdrawn; see lib/pty.mjs.`,
    };
  }
}

/**
 * A one-line answer for `doctor`.
 *
 * ⭐ IT SAYS WHAT THE FALLBACK DOES, not just that the module is missing. A
 * diagnostic that reports an absence without saying what happens instead reads
 * as a fault when it is the designed state.
 */
export function ptyStatus({ env = process.env } = {}) {
  const load = loadPty({ env });
  /**
   * ⚠️⚠️ "PRESENT" IS NOT "USED", AND SAYING SO IS THE WHOLE POINT OF THIS
   * LINE. An operator who installed node-pty and set the variable would
   * otherwise read a green `live` and conclude their commands run in a terminal.
   * They do not — see the measurement block below — and a diagnostic that
   * implies a capability the code declined to use is worse than none.
   */
  if (load.ok) {
    return {
      available: true,
      detail: `node-pty is installed and loadable from ${load.from}, but commands are NOT routed through it: driving it left this process unable to exit (a worker-thread handle leak inside the library) and repainted the captured output with terminal escapes. Prompts are still detected and reported through pipes.`,
    };
  }
  return { available: false, detail: load.why };
}

/**
 * ── ⚠️⚠️⚠️ THERE WAS AN ADAPTER HERE, AND DRIVING IT IS WHY IT IS GONE ───────
 *
 * `ptyChildAdapter` shaped an `IPty` like a `ChildProcess` so `spawnBounded`
 * could keep its timeout, tree kill, output caps and env scrub unchanged. It
 * worked — `viaPty` came back `true` and the command's output arrived — and it
 * is deleted, because driving it produced three measurements that make the
 * transport unshippable on this platform (node-pty 1.1.0, Windows, node 22):
 *
 *   1. **The host process could no longer exit.** After a pty command settled
 *      cleanly at exit 0, `process.getActiveResourcesInfo()` still held
 *      `MessagePort, PipeWrap, PipeWrap, ProcessWrap, Timeout, Timeout`.
 *      Importing node-pty on its own is clean and exits immediately, so it is
 *      SPAWNING that leaks — inside a worker thread `detachChild` cannot reach.
 *   2. **`conpty_console_list_agent.js` crashed every run** with
 *      `Error: AttachConsole failed`: we spawn `windowsHide: true` with no
 *      console attached, which is exactly what it cannot do.
 *   3. **A terminal repaints, and the model is billed for it.** `console.log("hi")`
 *      came back as `[?9001h[?1004h[?25l[2J[m[Hhi
]0;`.
 *
 * ⭐ SO THIS MODULE KEEPS ONLY WHAT IT CAN DO HONESTLY: answer whether a real
 * terminal is available and say what runs instead. `doctor` prints it. Leaving
 * the adapter here unwired would be the "built and unreached" defect this
 * package ships more often than any other, and re-wiring it would trade a
 * timeout that ends for a hang that does not.
 *
 * ── ⭐⭐⭐ RE-MEASURED 2026-09-01, AND THE BLOCKER IS CONTAINABLE ────────────
 *
 * The paragraph above used to end: *"the blocker is (1), it is inside node-pty"*
 * — full stop. That is true and it is not the whole sentence, and the missing
 * half is the one that matters to whoever picks this up next.
 *
 * ⚠️ FIRST, THE WITHDRAWAL STILL STANDS ON ITS OWN TERMS. node-pty is still at
 * **1.1.0** (published 2026-08-03; npm checked 2026-09-01) — the exact version
 * that was withdrawn, so nothing was fixed upstream. Driving it IN PROCESS on
 * node 22 / Windows reproduces the leak precisely:
 *
 *     pty child exits 0, marker captured, 546 bytes of output
 *     after settle: getActiveResourcesInfo() = ["MessagePort","PipeWrap"]
 *                   _getActiveHandles()      = 2  [MessagePort, Socket]
 *     THE PROCESS NEVER EXITS — killed by the wrapper at 31s.
 *
 * ⭐⭐ BUT THE LEAK IS A PROPERTY OF *LOADING node-pty IN THIS PROCESS*, NOT OF
 * DRIVING A PTY. Run the library in a short-lived CHILD that speaks JSON lines
 * over stdio, and the handles it strands die with that child. Measured, same
 * machine, same library, same interactive `cmd.exe` session:
 *
 *     helper process exits 0, pty exit code 0 propagated, marker captured
 *     after settle: getActiveResourcesInfo() = []
 *                   _getActiveHandles()      = 0
 *     THE PARENT EXITS ON ITS OWN — exit code 0, 4s wall clock.
 *
 * ⭐ And the other two objections move as well, measured the same way:
 *   · `conpty_console_list_agent` did NOT crash — the helper's stderr was EMPTY,
 *     where in-process it raised `AttachConsole failed` every run.
 *   · the repaint is real and is strippable: `cmd /c echo hello` returns 7 bytes
 *     through a pipe and **77 through a pty, 70 of them (90.9%) escapes**, and
 *     stripping SGR/OSC recovers `"hello\r\n"` byte for byte.
 *
 * ── ⚠️⚠️ AND IT IS STILL NOT WIRED. THAT IS DELIBERATE. ────────────────────
 *
 * What the measurement buys is that the blocker is no longer a reason to stop;
 * it does not by itself make the transport shippable. Routing commands through
 * a pty means changing `command.mjs` — the allowlist, the env scrub, the output
 * caps, the tree-kill, and `interactive.mjs`'s prompt detection, which is built
 * on the *pipe* behaviour that a pty changes (a prompt that no longer withholds
 * its newline is a prompt that detector stops seeing). That is a large edit to
 * the most safety-critical file here, and landing it half-verified is the exact
 * defect this package names most often.
 *
 * ⭐ SO: the containment is PROVEN and the transport is NOT BUILT, on purpose,
 * rather than a half-transport being left in `lib/` for someone to find and
 * assume works. Whoever takes it on starts from a solved exit path — and the
 * acceptance test is unchanged and is still the only one that matters:
 * `process.getActiveResourcesInfo()` after a settled run, plus a real timed run
 * that terminates on its own. Not "does the command work", which it always did.
 */
