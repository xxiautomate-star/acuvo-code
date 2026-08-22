/**
 * ── ⭐⭐ THE ROUND TAX, REMOVED STRUCTURALLY ─────────────────────────────────
 *
 * Measured across five consecutive live runs and then again on the bench: the
 * model reaches for `node -e "import('./x.js').then(m => console.log(...))"` to
 * check a value. The double quotes die on `command.mjs`'s character whitelist,
 * the round is spent, the refusal is read, and the NEXT round writes a temp file
 * and runs that — which is what it should have done first.
 *
 * That is a ~20% tax on a five-round budget, and on the `git` bench task it was
 * the difference between committing and running out of rounds.
 *
 * ── ⚠️ I ALREADY TRIED THE PROMPT FIX AND IT DID NOT HOLD ───────────────────
 * An explicit rule was added naming the refusal and saying to write a file
 * instead. It still happened on the very next run. That is the third time in
 * this project a prompt rule has been obeyed narrowly or not at all, and the
 * lesson is consistent: **when a model keeps reaching for something, give it the
 * thing rather than another sentence telling it not to.**
 *
 * ⭐ So `evaluate` is exactly what `node -e` is for — run a snippet, see the
 * value — with the quoting problem removed because the source arrives as a JSON
 * string argument instead of inside a shell-shaped command line.
 *
 * ── ⚠️ WHY THIS DOES NOT WIDEN THE SECURITY BOUNDARY ────────────────────────
 * It cannot do anything `write_file` + `run_command` could not already do in two
 * calls, which is the honest test for any new capability. It writes into the
 * workspace through the SAME path rules, runs through the SAME bounded spawn
 * with the SAME scrubbed environment, and removes the file afterwards.
 *
 * ⚠️ `command.mjs` still refuses `node --eval` and that refusal STAYS. The
 * objection there was never "evaluating is dangerous" — it was that code passed
 * on a command line is never written to disk, so nothing it did can be reviewed
 * afterwards. Here the snippet IS a file for the duration of the run, and it is
 * echoed in the result, so the audit trail the flag protects is intact.
 */

import { unlinkSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { spawnBounded, scrubEnvironment, childEnvironment, clampOutput, DEFAULT_COMMAND_TIMEOUT_MS } from './command.mjs';
import { resolveInWorkspace } from './workspace.mjs';

/** A snippet longer than this is a program, and programs get written properly. */
export const MAX_SNIPPET_CHARS = 4_000;

/**
 * ── ⚠️ THE `finally` BELOW DOES NOT RUN WHEN THE PROCESS IS KILLED ──────────
 *
 * `turn.mjs` installs `process.on('SIGINT', () => { …; process.exit(130); })`
 * so that Ctrl-C during an interactive session exits deliberately. That exit
 * tears the process down mid-await, and a `finally` in a suspended async
 * function is simply never reached. Measured, against the code as it stood:
 *
 *   driver exit code : 130
 *   reached finally? : false
 *   workspace root   : [ '.acuvo-eval-25072-1786406877209.mjs' ]
 *
 * The scratch file is at the WORKSPACE ROOT — the user's repo. It dirties
 * `git status` and it is exactly the kind of file that ends up committed.
 *
 * ⭐ `process.exit()` DOES fire the `exit` event, even though a raw signal does
 * not (turn.mjs measured that separately and relies on the same fact). So one
 * `exit` hook over a registry of in-flight snippets closes the interrupt path,
 * and it is the same shape turn.mjs already uses for MCP connections.
 */
const pendingSnippets = new Set();
let exitHookInstalled = false;

/** Remove every snippet still in flight. Synchronous — an `exit` handler cannot await. */
export function flushPendingSnippets() {
  for (const abs of [...pendingSnippets]) {
    try { unlinkSync(abs); } catch { /* already gone, or never landed */ }
    pendingSnippets.delete(abs);
  }
}

function installExitHook() {
  // ⚠️ ONCE, not per call. `evaluate` runs many times per session and a
  // listener per call is how you get MaxListenersExceededWarning printed at a
  // user mid-conversation — the exact bug turn.mjs's registry was written for.
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', flushPendingSnippets);
}

/**
 * ── ⚠️⚠️ REAPING IS DELETING SOMEONE ELSE'S FILES ───────────────────────────
 *
 * `exit` covers an interrupt, but not a SIGKILL, a crashed terminal or a power
 * cut — and those leave the same litter. The next run sweeps it, which means
 * this code deletes files in a repo it did not write. So it is bounded three
 * ways, ALL of which must hold:
 *
 *   1. the name matches the generated pattern EXACTLY — `.acuvo-eval-<digits>-
 *      <digits>.mjs` and nothing else. Not `.acuvo-eval-notes.mjs`, not a
 *      `.bak`, not the same name without the leading dot;
 *   2. it is a plain FILE in the workspace ROOT. Never a directory, never a
 *      symlink, and this never recurses — a match one level down is untouched;
 *   3. it is OLDER than the threshold. A snippet from a live run in another
 *      terminal must survive, and since `spawnBounded` is capped at 120s a
 *      live snippet can never approach five minutes.
 *
 * It also skips anything this process still has in flight, and every failure is
 * swallowed: a reaper that can break `evaluate` is not worth having.
 */
export const STALE_SNIPPET_MS = 5 * 60_000;

/** The generated name, and only the generated name. */
export const SNIPPET_NAME_PATTERN = /^\.acuvo-eval-\d+-\d+\.mjs$/;

/**
 * @param {string} root workspace root — never recursed into
 * @returns {string[]} the names actually removed
 */
export function reapStaleSnippets(root, { now = Date.now(), olderThanMs = STALE_SNIPPET_MS } = {}) {
  const reaped = [];
  if (!root || typeof root !== 'string') return reaped;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return reaped; // missing or unreadable root is not this function's problem
  }

  for (const entry of entries) {
    if (!SNIPPET_NAME_PATTERN.test(entry.name)) continue;
    if (!entry.isFile()) continue; // a directory or symlink wearing the name
    const abs = join(root, entry.name);
    if (pendingSnippets.has(abs)) continue; // ours, and still running
    try {
      const st = lstatSync(abs);            // belt and braces: never follow a link
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < olderThanMs) continue; // could belong to a live run
      unlinkSync(abs);
      reaped.push(entry.name);
    } catch { /* raced with someone else, or not ours to delete */ }
  }
  return reaped;
}

/**
 * ── ⚠️ AT THE WORKSPACE ROOT, AND THE FIRST VERSION WAS NOT ─────────────────
 *
 * I staged this in `.acuvo/` and the tool description promised "relative
 * imports work". They did not. Node resolves a relative specifier against the
 * IMPORTING FILE, so `./src/math.mjs` from `.acuvo/eval-*.mjs` looked for
 * `.acuvo/src/math.mjs`:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module …/.acuvo/src/math.mjs
 *
 * ⭐ Found by RUNNING it, not by a test — the unit tests stubbed the executor
 * and never resolved a real import. The description was the bug: it made a
 * promise about module resolution that the file's location contradicted, and a
 * model reading it would have written correct code and been told it was wrong.
 *
 * So the snippet lives at the ROOT, where `./src/x.mjs` means what the model
 * thinks it means. The leading dot and the pid/timestamp keep it out of the way,
 * and the `finally` below removes it either way.
 */
function snippetPath() {
  return `.acuvo-eval-${process.pid}-${Date.now()}.mjs`;
}

/**
 * Run a JavaScript snippet in the workspace and return what it printed.
 *
 * @param {{ executor: any, source: unknown, timeoutMs?: number, spawnImpl?: Function }} args
 */
export async function evaluateSnippet({ executor, source, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, spawnImpl }) {
  if (executor.dryRun) {
    return { ok: false, error: 'this is a --dry-run, so nothing is executed (evaluate writes a file and runs it)' };
  }
  if (typeof source !== 'string' || !source.trim()) {
    return { ok: false, error: 'source is required — the JavaScript to run' };
  }
  if (source.length > MAX_SNIPPET_CHARS) {
    return {
      ok: false,
      error: `the snippet is ${source.length} characters, over the ${MAX_SNIPPET_CHARS} limit — write it to a real file and run that instead`,
    };
  }

  // Sweep anything a previous run was killed too hard to clean up. Bounded and
  // fail-safe (see reapStaleSnippets); it runs AFTER the dry-run guard above,
  // because a dry run must not delete anything either.
  try { reapStaleSnippets(executor.root); } catch { /* never break evaluate over litter */ }

  const rel = snippetPath();

  /**
   * ⚠️ RESOLVED BEFORE IT IS WRITTEN. The old order wrote the file first and
   * resolved second, so a resolve failure left a staged file with no path to
   * unlink it by — a leak on the one path that was supposed to be the safe one.
   */
  const target = resolveInWorkspace(executor.root, rel, 'read');
  if (!target.ok) return { ok: false, error: target.reason };

  // Registered BEFORE the write, so even a crash mid-write is covered.
  pendingSnippets.add(target.absolute);
  installExitHook();

  const written = executor.writeFile(rel, source);
  if (!written.ok) {
    pendingSnippets.delete(target.absolute);
    try { unlinkSync(target.absolute); } catch { /* never landed */ }
    return { ok: false, error: `could not stage the snippet: ${written.error}` };
  }

  try {
    const run = await spawnBounded({
      file: process.execPath,
      args: [target.absolute],
      cwd: executor.root,
      timeoutMs: Math.min(Math.max(1_000, timeoutMs), 120_000),
      spawnImpl,
      /**
       * ⚠️ THIS IS THE `node <a file the model wrote>` ROAD IN ITS PUREST FORM —
       * the snippet is staged and node is spawned on it. So it is the first
       * place an install launched from inside model-written code would reach
       * npm with lifecycle scripts ENABLED, while the gated `npm install` road
       * had them off. `childEnvironment` closes that asymmetry; it never
       * closes the road, and `validateInstallSpec`'s paragraph says so plainly.
       */
      env: childEnvironment({ file: process.execPath, args: [target.absolute] }, process.env),
    });
    if (!run.ok) return { ok: false, error: run.error };

    return {
      ok: true,
      // ⭐ ECHOED BACK. The snippet is gone from disk by the time the model reads
      // this, and a result whose cause cannot be inspected is how a wrong
      // conclusion gets built on. It is also what keeps the --eval audit
      // argument satisfied.
      source: clampOutput(source, 1_500).text,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      stdout: run.stdout,
      stderr: run.stderr,
      /**
       * ⚠️ `ok` MEANS IT RAN, `passed` MEANS IT SUCCEEDED. The same distinction
       * run_command makes, for the same reason: conflating them is exactly how a
       * loop reports success on a throwing snippet.
       */
      passed: run.exitCode === 0 && !run.timedOut,
    };
  } finally {
    /**
     * ⚠️ REMOVED IN A `finally`, INCLUDING ON TIMEOUT. A scratch file left in
     * someone's repo is the thing that ends up committed — this project already
     * watched the agent burn four rounds unable to delete one, and watched
     * `git status` go dirty because of it.
     */
    try { unlinkSync(target.absolute); } catch { /* already gone, or never landed */ }
    pendingSnippets.delete(target.absolute);
  }
}

export function evaluateToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'evaluate',
      description: [
        'Run a short piece of JavaScript in the workspace and see what it prints.',
        'USE THIS INSTEAD OF `node -e` — that is refused, because a command line here cannot',
        'contain quotes. This is the supported way to check a value, import one of your own',
        'modules and call it, or verify a function returns what you expect.',
        'The snippet runs as an ES module from the workspace root, so relative imports work',
        '(e.g. `import { sum } from "./src/math.mjs"`). It is deleted afterwards.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'The JavaScript to run. Use console.log to see anything.',
          },
        },
        required: ['source'],
      },
    },
  };
}
