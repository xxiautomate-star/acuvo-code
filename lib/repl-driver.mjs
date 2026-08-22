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
import { Script, constants as vmConstants } from 'node:vm';
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

const SCRIPT_OPTIONS = {
  filename: 'repl',
  /**
   * ⚠️ WITHOUT THIS, `await import(...)` THROWS
   * ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING — code compiled through `vm` has no
   * module loader attached, so the single most valuable thing this REPL does
   * (open the project) failed while everything else worked.
   * `USE_MAIN_CONTEXT_DEFAULT_LOADER` borrows the real one, so imports resolve
   * exactly as they would in any other file, with no flags.
   */
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
};

/**
 * ── ⭐⭐ SEVERAL STATEMENTS NOW RETURN THE LAST ONE'S VALUE ──────────────────
 *
 * `const z = 5; z*2` used to answer `undefined`. Documented, not broken — but
 * ROUNDS ARE THE UNIT OF COST HERE, and it cost the model a whole extra round to
 * fetch a value it had already computed. That is the most expensive kind of
 * "documented".
 *
 * ⭐ AND THE FIX NEEDS NO PARSER, WHICH IS THE ONLY REASON IT IS SAFE. The
 * obvious implementation — find the last statement and prefix it with `return` —
 * is string surgery on JavaScript, and it corrupts the user's code the first
 * time a `;` appears inside a string literal or a submission ends in a `//`
 * comment. **V8 already computes this**: it is the completion value of a Script,
 * the exact thing `node -i` prints, and asking for it is free.
 *
 * ⚠️ WRAPPED IN A BLOCK, NOT RUN BARE, AND THAT BRACE IS LOAD-BEARING. MEASURED
 * both ways: run bare, a script-level `const` becomes a GLOBAL LEXICAL binding,
 * so the second submission of `const {q,w} = {q:1,w:2}` dies with "Identifier
 * 'q' has already been declared" — a stateful tool poisoned by its own history.
 * Inside a block those declarations are block-scoped and die with the
 * submission, exactly as they do inside today's function wrapper, and the
 * completion value still propagates out. Measured: bare 1st=3 2nd=THREW;
 * block 1st=3 2nd=3.
 *
 * ⚠️⚠️ THE FALLBACK IS COMPILE-ONLY, AND THAT IS THE SAFETY PROPERTY. Some
 * submissions are legal in a function body and illegal in a block — `return 9`
 * is the common one. Those are caught HERE, at `new Script`, before a single
 * byte of user code has run, so re-compiling them the old way cannot repeat a
 * side effect. VERIFIED by counting: a fallback submission that increments a
 * counter leaves it at 1, not 2. Anything that worked before still works, and
 * the failure direction is "behaves exactly as it did yesterday".
 *
 * ⚠️ `await` KEEPS THE WRAPPER, so a submission containing one still answers
 * `undefined` unless it says `return`. A completion value does not exist inside
 * a function body, and top-level await does not exist outside one; there is no
 * arrangement that gives both. The tool description says `return` out loud
 * instead of pretending otherwise.
 *
 * ⭐ FREE BUG FIX ON THE WAY PAST: today's wrapper is built on ONE LINE, so
 * `const p = 2\n// trailing comment` compiled to `(async () => { globalThis.p =
 * 2\n// trailing comment })()` — the closing brace landed INSIDE the comment and
 * the submission died with "Unexpected end of input", an error with nothing to
 * do with the user's code. Both forms now put the braces on their own lines.
 */
/**
 * ⚠️ THE NARROWING THAT KEEPS EVERY SINGLE-STATEMENT ANSWER EXACTLY AS IT WAS.
 *
 * These are the same two clauses `looksLikeExpression` uses to REJECT — a `;`
 * with something after it, or a newline — so between them the two functions
 * partition submissions into three cases with no overlap and no gap: one
 * expression, one statement, several statements. Only the third case changes.
 *
 * ⭐ IT IS ALSO THE CASE THE DEFECT NAMED: "one expression returns its value;
 * several statements run as a block". So `const q = 2` still answers
 * `undefined` — a lone declaration, and the answer the existing test pins — and
 * it stays cheap: a single `const big = readFileSync(…)` does not start dumping
 * a file into the reply as its assignment value.
 */
function looksMultiStatement(src) {
  const t = src.trim();
  return /;\s*\S/.test(t) || t.includes('\n');
}

function compileSubmission(src) {
  if (!looksLikeExpression(src) && looksMultiStatement(src)) {
    try {
      return { script: new Script(`{\n${src}\n}`, SCRIPT_OPTIONS), completion: true };
    } catch {
      /* not legal as a block — fall through to the wrapper, having run nothing */
    }
  }
  const body = looksLikeExpression(src) ? `return (${src});` : src;
  return { script: new Script(`(async () => {\n${body}\n})()`, SCRIPT_OPTIONS), completion: false };
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

    /**
     * ⭐ RUN IN *THIS* CONTEXT, either way. The real global is shared — so
     * `process`, `fetch` and timers behave exactly as they do in the code under
     * test — and the lifted declarations are already `globalThis.x =`, so they
     * outlive whichever wrapper was chosen.
     *
     * ⚠️ `vm.createContext` would also persist state and would quietly DIFFER:
     * a different global means a different `process`, and the value of this tool
     * is that what happens here is what happens there.
     */
    const compiled = compileSubmission(lifted.code);
    const result = await Promise.race([
      compiled.script.runInThisContext(),
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
