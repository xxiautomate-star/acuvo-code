/**
 * ── THE PROCESS THAT HOLDS THE STATE ───────────────────────────────────────
 *
 * Spawned once per REPL session and talked to over stdin/stdout in JSON lines.
 * It is deliberately NOT `node -i`: the interactive REPL is built for a human,
 * so its output is prompts, echoes and continuation state, and every agent that
 * has tried to drive one ends up writing a parser for `> ` that breaks on the
 * first multi-line paste. A protocol we own is smaller than that parser, and
 * cannot be confused by output that happens to contain a prompt character.
 *
 * ⚠️ IT RUNS IN THE WORKSPACE, so `await import('./lib/thing.mjs')` reaches the
 * project being worked on. A REPL that cannot open the project it is sitting in
 * is a calculator.
 *
 * Protocol, one JSON object per line each way:
 *   in   { id, code, timeoutMs }
 *   out  { id, ok, value, error, logs, ms, defined }
 */

import { createInterface } from 'node:readline';
import { inspect } from 'node:util';
import { runInThisContext, constants as vmConstants } from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_VALUE_CHARS = 4_000;
const MAX_LOG_CHARS = 4_000;

/** Names this session is carrying, so the model never has to guess its own state. */
const defined = new Set();

/**
 * ⚠️⚠️ DECLARATIONS BECOME ASSIGNMENTS, AND THE FIRST VERSION DID NOT DO THIS.
 *
 * It wrapped each submission in an AsyncFunction body. Measured immediately:
 * `const a = 21` then `a * 2` gave **"a is not defined"** — a `const` inside a
 * function body dies with the call, so the one property this tool exists for was
 * the one it did not have. A stateful REPL that forgets is `evaluate` with extra
 * moving parts.
 *
 * Top-level await forces a wrapper, and a wrapper re-introduces that scope
 * problem, so a leading declaration is rewritten onto `globalThis` instead.
 *
 * ⚠️ DELIBERATELY CONSERVATIVE: simple `const x =`, `let x =`, `function f`,
 * `class C`. Destructuring (`const { a, b } = …`) is left alone and therefore
 * does NOT persist — said plainly in the tool description rather than
 * half-handled, because a transform that is wrong about `const [a, ...rest] = x`
 * would corrupt the user's code rather than fail it.
 */
function liftDeclarations(src) {
  const names = [];
  const out = src
    .replace(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, (_m, name) => {
      names.push(name);
      return `globalThis.${name} =`;
    })
    .replace(/^[ \t]*(function|class)\s+([A-Za-z_$][\w$]*)/gm, (_m, kind, name) => {
      names.push(name);
      return `globalThis.${name} = ${kind} ${name}`;
    });
  return { code: out, names };
}

/**
 * ⚠️ RELATIVE IMPORTS RESOLVE AGAINST THIS FILE, NOT THE WORKSPACE. Measured:
 * `await import("./lib/budget.mjs")` returned ERR_MODULE_NOT_FOUND pointing at
 * this driver's own directory. The specifier is rewritten to an absolute file
 * URL from the working directory, which IS the workspace.
 */
function absolutiseImports(src) {
  return src.replace(/\bimport\(\s*(['"])(\.[^'"]*)\1\s*\)/g, (_m, q, spec) => {
    const url = pathToFileURL(resolve(process.cwd(), spec)).href;
    return `import(${q}${url}${q})`;
  });
}

function render(value) {
  if (value === undefined) return 'undefined';
  try {
    const text = typeof value === 'string'
      ? value
      : inspect(value, { depth: 3, maxArrayLength: 50, breakLength: 100 });
    return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}\n… (truncated)` : text;
  } catch (e) {
    return `[unrenderable: ${e?.message ?? e}]`;
  }
}

/**
 * ⭐ THE LAST EXPRESSION IS RETURNED. `const x = 2` yielding undefined is
 * correct; `x * 3` yielding nothing would make the tool write-only. Same
 * heuristic every REPL uses — a lone expression is returned, anything that
 * starts with a statement keyword runs as a block.
 */
function looksLikeExpression(src) {
  const t = src.trim();
  if (t === '') return false;
  if (/^(const|let|var|function|class|import|export|return|if|for|while|switch|try|throw|do|globalThis\.)/.test(t)) return false;
  if (/;\s*\S/.test(t)) return false;
  if (t.includes('\n')) return false;
  return true;
}

async function run(code, timeoutMs) {
  const logs = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  const capture = (...args) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : render(a))).join(' '));
  };
  console.log = capture;
  console.error = capture;
  console.warn = capture;

  const started = Date.now();
  try {
    const lifted = liftDeclarations(absolutiseImports(code));
    for (const n of lifted.names) defined.add(n);

    const body = looksLikeExpression(lifted.code) ? `return (${lifted.code});` : lifted.code;

    /**
     * ⭐ ONE async IIFE, run in THIS context. Top-level await works, the real
     * global is shared — so `process`, `fetch` and timers behave exactly as they
     * do in the code under test — and the lifted declarations are already
     * `globalThis.x =`, so they outlive the wrapper.
     *
     * ⚠️ `vm.createContext` would also persist state and would quietly DIFFER:
     * a different global means a different `process`, and the value of this tool
     * is that what happens here is what happens there.
     */
    const result = await Promise.race([
      runInThisContext(`(async () => { ${body} })()`, {
        filename: 'repl',
        /**
         * ⚠️ WITHOUT THIS, `await import(...)` THROWS
         * ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING — code compiled through `vm`
         * has no module loader attached, so the single most valuable thing this
         * REPL does (open the project) failed while everything else worked.
         * `USE_MAIN_CONTEXT_DEFAULT_LOADER` borrows the real one, so imports
         * resolve exactly as they would in any other file, with no flags.
         */
        importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);

    return { ok: true, value: render(result), logs, ms: Date.now() - started };
  } catch (e) {
    /**
     * ⚠️ THE STACK IS KEPT. Returning only `e.message` for a TypeError deep in
     * the project makes debugging harder than a console.log would have been.
     */
    return {
      ok: false,
      error: String(e?.stack ?? e ?? 'unknown error').slice(0, MAX_VALUE_CHARS),
      logs,
      ms: Date.now() - started,
    };
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const text = line.trim();
  if (text === '') return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg?.code === undefined) return;

  const out = await run(String(msg.code), Number(msg.timeoutMs) || 15_000);
  out.id = msg.id;
  out.defined = [...defined];
  const joined = (out.logs ?? []).join('\n');
  out.logs = joined.length > MAX_LOG_CHARS ? `${joined.slice(0, MAX_LOG_CHARS)}\n… (truncated)` : joined;
  process.stdout.write(`${JSON.stringify(out)}\n`);
});

/**
 * ⚠️ A CLOSED STDIN MEANS THE PARENT IS GONE. Exit rather than linger as an
 * orphan holding the workspace open — the failure this repo has already paid for
 * twice, once with a pid that ran until reboot.
 */
rl.on('close', () => process.exit(0));
