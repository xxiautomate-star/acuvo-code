/**
 * ── ⭐⭐ `!` AT THE PROMPT — RUN A COMMAND YOURSELF, AND LET THE AGENT SEE IT ──
 *
 * Parity audit 2026-09-26 against Claude Code's interactive-mode docs: `!` at
 * the start of the input is *"Shell mode: run a command directly, add its output
 * to the session"*. Acuvo had nothing of the kind — `!git status` went to the
 * MODEL as a task, which paid for a round to run a command the person could
 * have typed themselves, and was then REFUSED anyway on a default install,
 * because `git` is not on `run_command`'s allowlist.
 *
 * ⭐ THE PERSON IS THE ONE RUNNING IT, SO THE AGENT'S ALLOWLIST DOES NOT APPLY.
 * `command.mjs` restricts what the MODEL may execute. A line the human typed at
 * their own keyboard is no different from the same line typed in their own
 * shell one window over — refusing it would protect nobody. It runs through the
 * user's shell (`buildShellInvocation`), bounded by the same timeout and
 * process-tree kill `run_command` uses (`spawnBounded`), so a `!npm run dev`
 * that never exits cannot hang the prompt.
 *
 * ⚠️ IT COSTS NOTHING UNTIL YOU ASK SOMETHING. The output is printed and HELD;
 * it rides along with the NEXT message you send, labelled as commands you ran,
 * and only then does a model see it. Claude Code sends it straight away; a
 * pre-revenue CLI whose users watch every cent should not spend a round on
 * `!ls`. (`/clear` drops anything held.)
 *
 * ⚠️ THE ENVIRONMENT IS SCRUBBED (`scrubEnvironment`) — the same rule every
 * spawn in this package follows. Acuvo loads `.env` files; an `!env` whose
 * output is then attached to a model call must not carry the account key.
 */

import { spawnBounded, buildShellInvocation, scrubEnvironment } from './command.mjs';

/** Long enough for `npm test`, short enough that a forgotten server is killed. */
export const SHELL_MODE_TIMEOUT_MS = 120_000;

/**
 * ⚠️ PER COMMAND, AND THE TAIL IS KEPT. A test run's verdict is at the END; a
 * head-cut 40KB log would attach the banner and drop the one line that failed.
 */
export const SHELL_MODE_MAX_CHARS = 4_000;

/** At most this many held results ride on one message — oldest dropped first. */
export const SHELL_MODE_MAX_HELD = 5;

/**
 * Is this line a shell-mode line, and if so what command?
 *
 * ⚠️ `!` MUST BE THE FIRST CHARACTER. `" !important"` or a sentence ending in
 * `!` is prose. A bare `!` is returned as an empty command so the caller can
 * say how to use it rather than sending `!` to a model.
 *
 * @returns {{ command: string } | null}
 */
export function parseShellLine(line) {
  const raw = String(line ?? '');
  if (!raw.startsWith('!')) return null;
  return { command: raw.slice(1).trim() };
}

/** Keep the tail, and say how much was cut. */
export function clampTail(text, max = SHELL_MODE_MAX_CHARS) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `…[${s.length - max} earlier characters cut]\n${s.slice(-max)}`;
}

/**
 * Run one command through the user's shell.
 *
 * @param {{ command: string, cwd: string, timeoutMs?: number, runImpl?: Function, env?: object, platform?: string }} o
 * @returns {Promise<{ ok: boolean, exitCode: number|null, output: string, timedOut: boolean, error?: string }>}
 */
export async function runShellLine({
  command, cwd, timeoutMs = SHELL_MODE_TIMEOUT_MS,
  runImpl = spawnBounded, env = process.env, platform = process.platform,
}) {
  const inv = buildShellInvocation(command, { platform, env });
  if (!inv.ok) return { ok: false, exitCode: null, output: '', timedOut: false, error: inv.error };
  let res;
  try {
    res = await runImpl({ file: inv.file, args: inv.args, cwd, timeoutMs, env: scrubEnvironment(env) });
  } catch (err) {
    return { ok: false, exitCode: null, output: '', timedOut: false, error: String(err?.message ?? err) };
  }
  if (!res || res.ok !== true) {
    return { ok: false, exitCode: null, output: '', timedOut: false, error: res?.error ?? 'the command could not be started' };
  }
  const output = [res.stdout, res.stderr]
    .map((s) => String(s ?? '').replace(/\s+$/, ''))
    .filter(Boolean)
    .join('\n');
  return { ok: res.exitCode === 0 && res.timedOut !== true, exitCode: res.exitCode ?? null, output, timedOut: res.timedOut === true };
}

/**
 * The block that rides on the next message.
 *
 * ⭐ LABELLED AS SOMETHING THE PERSON DID. Without the label a model reads a
 * failing test log with no question attached and has to guess whether it is
 * being asked to fix it; with it, the message the person types next says what
 * they want and the log is the evidence.
 *
 * @param {{ command: string, exitCode: number|null, output: string, timedOut?: boolean, error?: string }[]} held
 */
export function shellContextBlock(held) {
  const list = Array.isArray(held) ? held.slice(-SHELL_MODE_MAX_HELD) : [];
  if (list.length === 0) return '';
  const parts = list.map((h) => {
    const status = h.error
      ? `could not run: ${h.error}`
      : h.timedOut ? 'killed after the timeout' : `exit ${h.exitCode}`;
    return [`$ ${h.command}`, clampTail(h.output) || '(no output)', `(${status})`].join('\n');
  });
  return ['Commands I ran myself at the prompt, and what they printed:', '', ...parts].join('\n');
}
