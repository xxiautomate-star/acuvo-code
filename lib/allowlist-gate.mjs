/**
 * ── ⭐⭐ WHICH PROGRAMS MAY RUN *HERE* — RESOLVED ONCE, FOR EVERY DOOR ────────
 *
 * There are four ways to start a process in this package and, until 2026-08-29,
 * they did not agree about what was permitted:
 *
 *   run_command   {command:"make test"}          → ran
 *   start_process {command:"make test"}          → ran
 *   run_program   {program:"make", args:["test"]} → REFUSED
 *   start_process {program:"make", args:["test"]} → REFUSED
 *
 * All four in the SAME workspace, in the SAME process, with the same operator
 * configuration. Measured — the table above is literal output, not a sketch.
 *
 * The cause was not a missing check, it was a missing LOOKUP. `executeRunCommand`
 * and `startBackground`'s string branch each carried their own copy of "read
 * `.acuvo/commands.json`, read `ACUVO_ALLOW_COMMANDS`, otherwise detect the
 * project's language" — and `spawn-argv.mjs`, which serves the two argv doors,
 * carried none, so it gated on the frozen four for ever.
 *
 * ── ⚠️ WHY THAT WAS A SAFETY BUG AND NOT MERELY AN INCONSISTENCY ────────────
 *
 * The argv form is the SAFE one. There is no string, so there is no tokenizer,
 * no character whitelist to be clever about, and no way for `"buy milk"` or a
 * `;` to be re-read as anything but data. The string form is the one that has to
 * defend a parser, and under `--shell` it *is* the parser.
 *
 * So the package refused the safe door and permitted the unsafe one, and the
 * agent noticed. In our own Terminal-Bench transcripts the refusal
 * `"…is not a program this agent may run"` appears seven times, and in the round
 * immediately after each one the model abandons `run_program`/`start_process`
 * and reaches for a `run_command` string instead — once literally narrating it:
 * *"I can't use start_process with python3. Let me use run_command."* One of
 * those downgrades then timed out at 121s doing, blocking, the exact job
 * `start_process` exists to do in the background.
 *
 * ⭐ A GATE THAT IS CHEAPER TO ROUTE AROUND THAN TO SATISFY IS NOT A GATE. The
 * fix is not to tighten the string door — it is to stop the safe door being the
 * strict one. One resolver, four callers, one answer.
 *
 * ── ⚠️ WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
 *
 * · It does not WIDEN anything. Every binary it can return was already reachable
 *   through `run_command` in the same workspace one second earlier; the presets,
 *   the config file and the detection rules are all unchanged and all still
 *   `command.mjs`'s. This module only asks the question in a second place.
 * · It does not loosen a grammar. A preset is a grammar, not a licence: with the
 *   python preset on, `python -m pip install requests` stays refused by
 *   `checkFlagValue`, through either door.
 * · It never fails a run. Detection is a convenience; a read error or a strange
 *   directory falls back to the built-in four, which is the behaviour that
 *   existed before this file.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  ALLOW_COMMANDS_ENV,
  COMMANDS_CONFIG_FILE,
  DEFAULT_ALLOWLIST,
  buildAllowlist,
  resolveCommandAllowlist,
} from './command.mjs';
import { detectPresets } from './project-language.mjs';

/**
 * Resolve the allowlist in force for one workspace root.
 *
 * ⚠️ THE PRECEDENCE IS `executeRunCommand`'s, COPIED DELIBERATELY RATHER THAN
 * IMPROVED. An explicit `.acuvo/commands.json` or `ACUVO_ALLOW_COMMANDS` WINS
 * and detection does not add to it — somebody who listed exactly what this agent
 * may run has made a decision, and quietly extending it would be the tool
 * overruling them on their own machine. If this rule ever changes it must change
 * for both doors at once, which is why there is now only one place to change it.
 *
 * ⚠️ A MALFORMED CONFIG FILE FAILS THE CALL, IT DOES NOT FALL BACK. `{}` with a
 * typo'd key is refused by `parseCommandsConfig` for the reason that file gives
 * — a setting that reads as a grant and grants nothing is the accident the whole
 * design refuses. Falling back to "the default four" here would be safe in the
 * permission sense and WRONG in the honesty sense: the operator would be told
 * nothing while their file did nothing.
 *
 * @param {string} root workspace root
 * @param {{ env?: object, readFileImpl?: (p: string) => string, listDirImpl?: (p: string) => string[] }} [deps]
 * @returns {{ ok: true, allowlist: import('./command.mjs').Allowlist, stated: boolean, detected: string[] }
 *          | { ok: false, error: string }}
 */
export function resolveWorkspaceAllowlist(root, { env = process.env, readFileImpl, listDirImpl } = {}) {
  const readFile = readFileImpl ?? ((p) => readFileSync(p, 'utf8'));
  const listDir = listDirImpl ?? ((p) => readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name));

  let configText = null;
  if (typeof root === 'string' && root) {
    try {
      configText = readFile(join(root, ...COMMANDS_CONFIG_FILE.split('/')));
    } catch {
      // ⚠️ ABSENT IS THE COMMON CASE AND IS NOT AN ERROR. Unlike `policy.mjs`,
      // this file GRANTS rather than restricts, so an unreadable one can only
      // ever cost capability — it can never quietly widen anything.
      configText = null;
    }
  }

  const resolved = resolveCommandAllowlist({ configText, envValue: env?.[ALLOW_COMMANDS_ENV] });
  if (!resolved.ok) return { ok: false, error: `the command allowlist could not be loaded: ${resolved.error}` };

  const stated = (resolved.sources?.length ?? 0) > 0;
  if (stated) return { ok: true, allowlist: resolved.allowlist, stated: true, detected: [] };

  let detected = [];
  try {
    detected = detectPresets(listDir(root));
  } catch {
    detected = [];
  }
  if (detected.length === 0) return { ok: true, allowlist: resolved.allowlist, stated: false, detected: [] };
  return { ok: true, allowlist: buildAllowlist({ presets: detected }), stated: false, detected };
}

/**
 * The same question, answered without ever failing — for a call site that has no
 * way to report an error and must not become the first thing that breaks a run.
 *
 * ⚠️ IT RETURNS THE **DEFAULT** ON FAILURE, NEVER A WIDER LIST. That direction
 * is the only one that is safe to guess: the worst outcome is a refusal the
 * operator can read and act on, rather than a program running because a JSON
 * file could not be parsed.
 */
export function workspaceAllowlistOrDefault(root, deps) {
  const r = resolveWorkspaceAllowlist(root, deps);
  return r.ok ? r.allowlist : DEFAULT_ALLOWLIST;
}
