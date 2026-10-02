/**
 * ── ⭐⭐⭐ `check_tools` — THE ONE QUESTION THE AGENT COULD NOT ASK ───────────
 *
 * MEASURED ACROSS OUR OWN 139 BENCH RUNS (`bench/terminal-bench/results/`,
 * 2026-08-29). The model issued **201 `which` / `command -v` segments in 52 of
 * the 139 runs** — the single most hand-rolled shell idiom in the corpus, and
 * the only one in the top five with **no verb behind it at all**. `ls` has
 * `list_dir`, `grep` has `search_text`, `head` has `read_lines`. "Is this
 * program here?" had nothing.
 *
 * ⚠️⚠️ AND `which` IS ONLY HALF THE QUESTION, WHICH IS WHY A SHELL DOES NOT
 * CLOSE THIS. On the surface a stranger actually installs there is no shell at
 * all, so the probe is not merely expensive — it is impossible. And even with
 * `--shell` on, `which python3` answers YES on a machine where this agent is
 * still refused it. That exact sequence is in the logs, verbatim, seven times:
 *
 *     ✖ start_process: "python3" is not a program this agent may run.
 *       Allowed: node, npm, npx, tsc.
 *     …
 *     I can't use start_process with python3. Let me use run_command with a
 *     background                    — run-fixed/build-cython-ext__knp6Tiw:134
 *
 * ⭐ SO THIS VERB ANSWERS BOTH HALVES IN ONE CALL: **is it installed**, and
 * **may this run execute it** — and when the answer to the second is no, the
 * one line a human adds to change that. `turn.mjs` already tells the model that
 * a workspace *may* enable python/go/rust/ruby/make/node-bin; it cannot tell it
 * whether THIS one has, because that is a fact about a file and a machine, not
 * about a prompt. The model's only way to find out was to spend a round being
 * refused.
 *
 * ── ⚠️⚠️ THE RESOLUTION IS THE SAME RESOLUTION `run_command` USES, AND THAT IS
 *    THE WHOLE CORRECTNESS ARGUMENT ────────────────────────────────────────
 *
 * An advisory that disagrees with the gate is worse than no advisory: the model
 * believes it, writes the command, and is refused anyway — having now paid for
 * both. So this module does not model the rules, it re-runs them, in the same
 * order `executeRunCommand` does (`lib/command.mjs`, the block whose own
 * comment is *"a project that declares its language gets that language"*):
 *
 *   1. `.acuvo/commands.json` read THROUGH THE EXECUTOR, so the path rules and
 *      the in-memory workspace behave identically here and there;
 *   2. `resolveCommandAllowlist({ configText, envValue: ACUVO_ALLOW_COMMANDS })`;
 *   3. and ONLY when neither source stated anything, `detectPresets()` over the
 *      root listing — the auto-enable branch. Getting step 3's condition wrong
 *      would make this verb under-report on exactly the Python and Go repos it
 *      exists to serve.
 *
 * ⚠️ `test/check-tools.test.mjs` §2 drives the REAL
 * `validateCommand` for every binary this verb calls runnable. A restatement of
 * the list would pass while checking nothing; running the gate is the only
 * assertion that bites when the two drift.
 *
 * ── ⚠️⚠️ A PROGRAM NAME IS NOT A PATH, AND THE REGEX IS A REAL GUARD ────────
 *
 * `resolveOnPath` joins each PATH directory to the string it is given, so
 * `check_tools {"programs":["../../../etc/shadow"]}` would probe absolute
 * filesystem locations and report which exist — a directory-listing oracle
 * reachable by a model, through a read-only verb, on somebody else's machine.
 * `NAME_SHAPE` below is what stops it, and it is deliberately the SAME shape
 * rule `command.mjs` `checkBinaryName` applies to a declared binary: a name, not
 * a file.
 *
 * ── ⭐ WHAT IT DELIBERATELY DOES NOT RETURN: THE ABSOLUTE PATH ───────────────
 *
 * `--doctor` prints it, because a human debugging their own PATH needs it. The
 * model does not: "installed" is the entire actionable fact, and the resolved
 * path is both a third-party disclosure of someone's directory layout and
 * ~40 tokens per program of nothing. The one exception is the Windows shim
 * case, where "installed" alone would be a lie — see `probe`.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveCommandAllowlist,
  buildAllowlist,
  COMMAND_PRESETS,
  PRESET_NAMES,
  COMMANDS_CONFIG_FILE,
  ALLOW_COMMANDS_ENV,
  ALLOW_INSTALL_ENV,
  installEnabled,
} from './command.mjs';
import { detectPresets } from './project-language.mjs';

export const TOOLCHAIN_TOOL_NAMES = ['check_tools'];

/**
 * ⚠️ THE SAME SHAPE RULE AS `command.mjs` `checkBinaryName`. A path is not a
 * program name, and accepting one turns a PATH probe into a filesystem probe.
 */
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * ⚠️ A CEILING ON THE ASK, because the result grows with it and the model has
 * no reason to know that. Twenty is more names than any real toolchain question
 * has; the refusal says the number rather than silently truncating, which is the
 * failure mode this package treats as the worst it can ship.
 */
export const MAX_PROGRAMS_PER_CALL = 20;

/**
 * Find a native executable on PATH.
 *
 * ⚠️ COPIED IN SHAPE FROM `lsp.mjs` `resolveOnPath` AND NOT IMPORTED FROM IT,
 * for one reason: that function is part of the language-server discovery path
 * and returns `{ ok, file }` / `{ ok: false, shim }`, a contract owned by that
 * module's needs. Importing it would couple a model-facing verb to a
 * discovery helper that has every right to change. The Windows `.cmd` rule it
 * documents (Node refuses to spawn `.cmd`/`.bat` without `shell: true` —
 * CVE-2024-27980, "BatBadBut") is the load-bearing part and is reproduced
 * verbatim in behaviour: a shim is present and NOT spawnable, and saying
 * "installed" without saying that produces an EINVAL from a path that
 * demonstrably exists.
 *
 * @returns {{ installed: boolean, spawnable: boolean }}
 */
export function probe(program, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of platform === 'win32' ? [...exts, ''] : ['']) {
      const candidate = join(dir, program + ext);
      try {
        if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      } catch { continue; /* an unreadable PATH entry is not a hit */ }
      const lower = candidate.toLowerCase();
      if (platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
        return { installed: true, spawnable: false };
      }
      return { installed: true, spawnable: true };
    }
  }
  return { installed: false, spawnable: false };
}

/** Which preset would unlock this binary? `command.mjs` keeps its own copy of
 *  this private, and it is four lines over an exported constant. */
export function presetFor(binary) {
  for (const [name, preset] of Object.entries(COMMAND_PRESETS)) {
    if (preset.binaries.includes(binary)) return name;
  }
  return null;
}

/**
 * Resolve the allowlist that `run_command` will ACTUALLY enforce for this
 * workspace — the three steps in the header, in that order.
 *
 * @returns {{ ok: true, binaries: string[], presetsOn: string[], stated: boolean }
 *           | { ok: false, error: string }}
 */
export function allowlistInForce(executor, env = process.env) {
  let configText = null;
  const read = typeof executor?.readFile === 'function' ? executor.readFile(COMMANDS_CONFIG_FILE) : { ok: false, error: 'no such file' };
  if (read.ok) {
    configText = read.content;
  } else if (!/^no such file/i.test(String(read.error ?? ''))) {
    return { ok: false, error: `${COMMANDS_CONFIG_FILE} exists but could not be read: ${read.error}` };
  }

  const resolved = resolveCommandAllowlist({ configText, envValue: env[ALLOW_COMMANDS_ENV] });
  if (!resolved.ok) return { ok: false, error: `the command allowlist could not be loaded: ${resolved.error}` };

  let binaries = [...(resolved.allowlist?.binaries ?? [])];
  let presetsOn = [...(resolved.presets ?? [])];
  const stated = (resolved.sources?.length ?? 0) > 0;

  /**
   * ⚠️ THE CONDITION IS `sources.length === 0`, NOT `presets.length === 0`, and
   * the difference is not pedantry: somebody who wrote `{"presets": []}` has
   * made a decision, and auto-detection overruling them on their own machine is
   * the bug `command.mjs` calls out in as many words. This branch mirrors that
   * file line for line.
   */
  if (!stated && typeof executor?.listDir === 'function') {
    try {
      const root = executor.listDir('.');
      const names = root?.ok && Array.isArray(root.entries)
        ? root.entries.filter((e) => e.type === 'file').map((e) => e.name)
        : [];
      const detected = detectPresets(names);
      if (detected.length > 0) {
        binaries = [...buildAllowlist({ presets: detected }).binaries];
        presetsOn = detected;
      }
    } catch {
      // Detection is a convenience. It must never be able to fail an answer.
    }
  }

  return { ok: true, binaries, presetsOn, stated };
}

/**
 * The verb.
 *
 * @param {object} executor the run's executor — read through it, never `fs`.
 * @param {{ programs?: unknown, shell?: boolean, env?: object }} opts
 */
export function checkTools(executor, { programs = undefined, shell = false, env = process.env } = {}) {
  const state = allowlistInForce(executor, env);
  if (!state.ok) return state;

  const { binaries, presetsOn } = state;
  const presetsOff = PRESET_NAMES.filter((p) => !presetsOn.includes(p));
  const allowed = new Set(binaries);

  /**
   * ⭐ `--shell` REPLACES THE FIRST HALF OF THE ANSWER AND NOT THE SECOND. With
   * a shell every program is permitted, so "may I" stops being interesting and
   * "is it here" becomes the whole question — which is exactly the 201 `which`
   * calls the bench recorded, all of them in shell mode.
   */
  const mayRun = (name) => shell || allowed.has(name);

  let asked = null;
  if (programs !== undefined && programs !== null) {
    if (!Array.isArray(programs)) {
      return { ok: false, error: 'programs must be an array of plain program names, e.g. ["python3","gcc"] — omit it entirely to list what is already runnable here' };
    }
    if (programs.length > MAX_PROGRAMS_PER_CALL) {
      return { ok: false, error: `${programs.length} programs is over the ${MAX_PROGRAMS_PER_CALL}-per-call limit — ask about the ones the task actually needs` };
    }
    asked = [];
    for (const raw of programs) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!NAME_SHAPE.test(name)) {
        return {
          ok: false,
          error: `${JSON.stringify(String(raw))} is not a plain program name — this checks PATH, so it takes a name like "python3", never a path like "/usr/bin/python3" or "../node"`,
        };
      }
      const found = probe(name, env);
      const entry = { name, installed: found.installed, runnable: found.installed && mayRun(name) };
      if (found.installed && !found.spawnable) {
        entry.note = 'a .cmd/.bat shim — present, but Node cannot spawn it directly';
        entry.runnable = false;
      }
      if (!entry.runnable && found.installed && !shell && !allowed.has(name)) {
        const preset = presetFor(name);
        entry.enableWith = preset
          ? `a human adds {"presets":["${preset}"]} to ${COMMANDS_CONFIG_FILE}, or sets ${ALLOW_COMMANDS_ENV}=${preset}`
          : `no preset provides ${name}; a human must declare it in ${COMMANDS_CONFIG_FILE} or start acuvo with --shell`;
      }
      asked.push(entry);
    }
  }

  /**
   * ⚠️ THE UNASKED HALF IS ALWAYS SMALL AND ALWAYS TRUE. Four binaries plus any
   * preset's, each probed once. It is what makes the no-argument call worth
   * making: "what can I already run here" is the question a model opens a
   * strange repository with.
   */
  const runnable = [];
  const missing = [];
  for (const b of binaries) {
    (probe(b, env).installed ? runnable : missing).push(b);
  }

  return {
    ok: true,
    ...(asked ? { programs: asked } : {}),
    runnable,
    ...(missing.length ? { allowedButNotInstalled: missing } : {}),
    presetsOn,
    ...(presetsOff.length && !shell
      ? { presetsAvailable: presetsOff, enablePreset: `a human adds {"presets":["<name>"]} to ${COMMANDS_CONFIG_FILE}, or sets ${ALLOW_COMMANDS_ENV}=<name> — do not write that file yourself` }
      : {}),
    shell,
    /**
     * ⚠️⚠️ WITHOUT THIS LINE THE NO-ARGUMENT ANSWER IS A PLAUSIBLE LIE UNDER
     * `--shell`. `runnable` is built from the ALLOWLIST, which is the ceiling
     * only while the shell is off; with it on, every installed program may be
     * run, and a bare `runnable: ["node","npm","npx","tsc"]` reads as "and
     * nothing else". Caught by reading the output rather than by a test, which
     * is the honest way to say where it came from — the `programs` path was
     * already correct, so every assertion passed while the summary misled.
     */
    ...(shell
      ? { shellNote: 'under --shell ANY installed program may be run — `runnable` lists only what would be allowed without it. Ask about a specific program to get the real answer.' }
      : {}),
    installs: installEnabled(env)
      ? 'npm install is enabled'
      // ⚠️ TWO WAYS IN, BOTH NAMED. The variable was the only documented door
      // and it appeared in no `--help`; the flag is the one a person can act on
      // without editing their shell profile. Naming only one is how a capability
      // stays reachable to whoever read the source.
      : `npm install is refused; a human enables it with ${ALLOW_INSTALL_ENV}=1 or by starting the run with acuvo --allow-install`,
  };
}

/**
 * ⚠️ THE DESCRIPTION IS THE FEATURE. A verb the model is not told to reach for
 * before writing a command is a verb it reaches for after being refused, which
 * is the round this exists to save — so the first sentence is an instruction
 * about WHEN, not a description of WHAT.
 */
export function toolchainToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'check_tools',
        description: [
          'Ask what this machine and this run can actually execute, BEFORE writing a command that gets refused.',
          'For each program it says whether it is installed on PATH, whether THIS run is allowed to run it, and',
          'if not, the one line a human adds to enable it — do not write that file yourself.',
          'Call it with no arguments to list what is already runnable here.',
          'One call replaces guessing: a refused or not-found command costs a whole round.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            programs: {
              type: 'array',
              items: { type: 'string' },
              description: `Optional. Plain program names, never paths, e.g. ["python3","pytest","gcc"]. Max ${MAX_PROGRAMS_PER_CALL}.`,
            },
          },
          required: [],
        },
      },
    },
  ];
}
