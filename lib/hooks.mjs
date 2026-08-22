/**
 * ── ⭐⭐⭐ LIFECYCLE HOOKS — SHELL COMMANDS AROUND THE TOOL LOOP ─────────────
 *
 * **Every policy this CLI had was a sentence in a prompt asking the model
 * nicely.** That is the defect. The package has real enforcement in two narrow
 * places — `policy.mjs` withholds a tool from the OFFER, and `command.mjs`
 * refuses a program at the SPAWN — and neither of them is reachable by the
 * person who actually has the rule. A team that wants
 *
 *     · format every file the agent writes
 *     · never let it touch `infra/` or `migrations/`
 *     · run the linter after each edit and tell the model what broke
 *     · ping me when a session ends
 *
 * had nowhere to put any of it, and the only remaining lever was more prose in
 * the system prompt — which is a request, not a control. Claude Code ships
 * hooks and it is one of the concrete reasons teams adopt an agent: the agent
 * runs inside THEIR rules rather than the vendor's.
 *
 * ── ⭐ THE ONE BEHAVIOUR EVERYTHING ELSE IS SUBORDINATE TO ──────────────────
 *
 * **A `PreToolUse` hook that exits non-zero BLOCKS the tool call.** A hook that
 * can observe but not refuse is a logger, and a logger is not a policy. The
 * refusal is handed back as an ordinary failed tool record, so the model reads
 * it the same way it reads any other refusal — and it carries the hook's own
 * stderr, because "blocked" with no reason is a wall the model will walk into
 * again on the next round at full token price.
 *
 * ── ⚠️⚠️ AND THE FAILURE MODE THIS FILE IS MOSTLY DEFENDING AGAINST ─────────
 *
 * This repository's signature defect is capability that is built and never
 * reached (`wiring-reach.test.mjs` exists because 39% of the package was once
 * imported by nothing). The hook-shaped version of that defect is **a gate that
 * silently lets everything through**: an event name with a typo, a `tools:`
 * entry that matches nothing, a command that is not installed on this machine,
 * a hook that hangs and gets killed. Each one leaves the user believing they
 * have a control they do not have — which is strictly worse than having no
 * hooks, because they stop watching.
 *
 * So, stated as rules:
 *
 *   1. A configuration mistake is REFUSED AT PARSE TIME with the typo quoted.
 *      Nothing is dropped, ignored, or clamped into something else.
 *   2. A hook that CANNOT BE RUN (spawn failure, timeout) is an ERROR, and for
 *      `PreToolUse` it BLOCKS. A gate that could not answer has not said yes.
 *   3. A hook that ran and failed is announced on `onEvent` every time. There
 *      is no path through this file where a non-zero exit produces silence.
 *
 * ── ⚠️ WHY EVERY HOOK IS SPAWNED WITH A TIMEOUT ────────────────────────────
 *
 * A hook is somebody's shell command running INSIDE the agent's tool loop, on
 * the critical path of every single tool call. Without a bound, the ordinary
 * accidents — `git commit` opening `$EDITOR`, an `npm install` stopping on an
 * audit prompt, a linter walking `node_modules`, a `curl` to a host that
 * blackholes — stop the agent forever with nothing on screen, and the agent has
 * no way to tell a slow hook from a hung one. `spawnBounded` already owns that
 * problem for `run_command`: a timer, a process-TREE kill (so what the hook
 * spawned dies too), and a settle grace so the promise cannot be left pending.
 * Hooks reuse it rather than growing a second, unaudited spawner.
 *
 * ⭐ 30 SECONDS BY DEFAULT, and the number is chosen rather than round:
 * `prettier` on a large file and `eslint` on a package are single-digit
 * seconds, `tsc --noEmit` on a medium repo is tens — so the default has to
 * clear a formatter comfortably while still being an interval a person will sit
 * through per tool call. Anything longer is a build, and a build belongs in
 * `check_acceptance`, not in a gate that runs before every write.
 *
 * ── ⚠️ THE SUPPLY-CHAIN NOTE, STATED RATHER THAN IMPLIED ────────────────────
 *
 * `.acuvo/hooks.json` is arbitrary shell that this CLI executes. It sits under
 * `.acuvo/`, which `acuvo-dir.mjs` makes SELF-IGNORING (`*` in its own
 * `.gitignore`), so it is a local file by construction and a `git clone` does
 * not normally carry one. That is the same trust boundary `.acuvo/commands.json`
 * already lives on. It is deliberately NOT the same as `.mcp.json`, which is
 * committed and which `turn.mjs` had to gate behind `--dry-run`/`--no-run`
 * after exactly this class of finding.
 *
 * ⭐ PURE, INJECTABLE, AND SPAWNER-FREE ON THE PARSE PATH. Everything above
 * `createHookRunner` is a function of its arguments, and the runner takes its
 * spawner as `runImpl` — so the blocking behaviour, the timeout plumbing and
 * the environment can all be proven without starting a process.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnBounded, buildShellInvocation, scrubEnvironment } from './command.mjs';

/** Where a workspace declares its hooks. Beside `.acuvo/commands.json`. */
export const HOOKS_CONFIG_FILE = '.acuvo/hooks.json';

/**
 * The three moments. Deliberately small:
 *   · `PreToolUse`  — before a tool runs, and it can REFUSE.
 *   · `PostToolUse` — after a tool ran, with its outcome. Cannot refuse.
 *   · `Stop`        — the session is over.
 *
 * ⚠️ NO `SessionStart`. A hook that fires before the workspace is gathered has
 * nothing to be about, and every event added here is a spawn on somebody's
 * critical path — the list grows when a real request names one, not before.
 */
export const HOOK_EVENTS = Object.freeze(['PreToolUse', 'PostToolUse', 'Stop']);

/** See the timeout paragraph in the header for why 30s and not a round number. */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/**
 * ⚠️ A CEILING, AND A CONFIG ABOVE IT IS REFUSED RATHER THAN CLAMPED. Silently
 * clamping would leave someone believing their 10-minute hook is configured
 * while it is killed at two — which is the "check that cannot fail" shape, one
 * layer down. Two minutes is already four times the longest plausible gate.
 */
export const MAX_HOOK_TIMEOUT_MS = 120_000;

/**
 * ── ⚠️ THE ENVIRONMENT HAS A HARD KERNEL LIMIT, AND `write_file` WOULD HIT IT ─
 *
 * Linux caps a single `execve` argument/environment string at `MAX_ARG_STRLEN`
 * (128 KB) and the whole block at roughly 2 MB; Windows caps the environment
 * block at 32 KB *characters*. A `write_file` call carries the file's entire
 * CONTENT in its arguments — the commonest thing anyone hooks — so passing
 * arguments through verbatim would make every hook on the most-hooked tool die
 * with `E2BIG` or a truncated block, on exactly the files that matter most.
 *
 * ⭐ 4,000 characters is enough for every path, command, URL and query this CLI
 * passes, and the truncation is MARKED. Silent truncation is the bug class this
 * package treats as the worst it can ship.
 */
export const MAX_HOOK_ENV_CHARS = 4_000;

/**
 * ⚠️ A CAP ON THE COUNT, because the timeout is PER HOOK. Thirty-two hooks at
 * the default bound is a 16-minute worst case on a single tool call, which is a
 * hang wearing a configuration's clothes. Nobody legitimately has more.
 */
export const MAX_HOOKS = 32;

/* ── configuration ───────────────────────────────────────────────────────── */

/**
 * Parse a `.acuvo/hooks.json` document.
 *
 * The accepted shape, kept flat on purpose — Claude Code's nested
 * `{event: [{matcher, hooks: [{type, command}]}]}` has three levels of nesting
 * to express one fact, and every extra level is another place a typo hides:
 *
 * ```json
 * {
 *   "hooks": [
 *     { "event": "PreToolUse",  "tools": ["write_file", "edit_file"],
 *       "command": "node .acuvo/guard.mjs" },
 *     { "event": "PostToolUse", "tools": ["write_file"],
 *       "command": "npx prettier --write \"$ACUVO_TOOL_ARG_PATH\"" },
 *     { "event": "Stop", "command": "notify-send 'acuvo finished'" }
 *   ]
 * }
 * ```
 *
 * ⚠️ MATCHING IS EXACT NAMES PLUS `*`, NOT A REGEX. A regex matcher is how you
 * get the failure this repo already measured on its own classifiers — a pattern
 * that looks right, matches nothing, and reports success by staying quiet. An
 * exact name can be CHECKED against the tool list, which is what turns a typo
 * from a silent no-op into the error below.
 *
 * @param {string} text
 * @param {{ label?: string, knownTools?: string[]|null }} [opts]
 *   `knownTools` is the dispatcher's real tool list. Optional so this file has
 *   no import edge to `tools.mjs`; `turn.mjs` supplies `TOOL_NAMES`.
 * @returns {{ ok: true, hooks: Array<object> } | { ok: false, error: string }}
 */
export function parseHooksConfig(text, { label = HOOKS_CONFIG_FILE, knownTools = null } = {}) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? ''));
  } catch (err) {
    return { ok: false, error: `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: `${label} must be a JSON object with a "hooks" array` };
  }
  const raw = doc.hooks;
  if (raw === undefined) return { ok: true, hooks: [] };
  if (!Array.isArray(raw)) return { ok: false, error: `${label}: "hooks" must be an array` };
  if (raw.length > MAX_HOOKS) {
    return { ok: false, error: `${label} declares ${raw.length} hooks; the limit is ${MAX_HOOKS} (each one has its own timeout, so the worst case is the sum)` };
  }

  const known = Array.isArray(knownTools) && knownTools.length > 0 ? new Set(knownTools) : null;
  const hooks = [];
  for (const [i, entry] of raw.entries()) {
    const at = `${label} hook #${i + 1}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `${at} must be an object` };
    }
    const event = entry.event;
    if (!HOOK_EVENTS.includes(event)) {
      /**
       * ⚠️ THE TYPO IS QUOTED BACK. `"PreToolCall"` silently registering nothing
       * is the exact silent-gate failure this file exists to refuse, and a user
       * reading "unknown event" without seeing their own string will look in the
       * wrong place first.
       */
      return { ok: false, error: `${at}: "${String(event)}" is not a hook event — the events are ${HOOK_EVENTS.join(', ')}` };
    }
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (!command) return { ok: false, error: `${at} has no "command" — a hook with nothing to run is a control that protects nothing` };

    let tools = null;
    if (entry.tools !== undefined) {
      if (event === 'Stop') {
        // No tool is in flight at session stop, so a `tools` filter here would
        // read as "only when the session ends after write_file" and mean nothing.
        return { ok: false, error: `${at}: a Stop hook has no tool to match, so "tools" cannot apply to it` };
      }
      if (!Array.isArray(entry.tools) || entry.tools.some((t) => typeof t !== 'string' || !t.trim())) {
        return { ok: false, error: `${at}: "tools" must be an array of tool names, or ["*"] for every tool` };
      }
      tools = entry.tools.map((t) => t.trim());
      if (known) {
        for (const t of tools) {
          /**
           * ⚠️ A NAMESPACED NAME IS AN MCP TOOL AND IS NOT IN OUR LIST. `turn.mjs`
           * routes `server.tool` to the MCP connection BEFORE the local
           * dispatcher, so those names are real, are hookable, and can never
           * appear in `TOOL_NAMES`. Checking them against it would refuse
           * correct configuration — worse than not checking at all.
           */
          if (t === '*' || t.includes('.')) continue;
          if (!known.has(t)) {
            return { ok: false, error: `${at}: "${t}" is not a tool this CLI has — a hook on a name that never fires protects nothing. Tools: ${[...known].join(', ')}` };
          }
        }
      }
    }

    let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
    if (entry.timeoutMs !== undefined) {
      if (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs <= 0 || entry.timeoutMs > MAX_HOOK_TIMEOUT_MS) {
        return { ok: false, error: `${at}: "timeoutMs" must be between 1 and ${MAX_HOOK_TIMEOUT_MS} — a hook runs on the critical path of a tool call` };
      }
      timeoutMs = Math.floor(entry.timeoutMs);
    }

    hooks.push({
      event,
      tools,
      command,
      timeoutMs,
      /** A short, stable handle for events and error text. */
      label: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `${event} #${i + 1}`,
    });
  }
  return { ok: true, hooks };
}

/**
 * Read `.acuvo/hooks.json` from a workspace.
 *
 * ⚠️ THE THREE OUTCOMES ARE DISTINCT AND MUST STAY THAT WAY: absent (fine, no
 * hooks), present-and-valid (hooks), present-and-broken (an ERROR the caller
 * must surface). Collapsing the third into the first is how a user ends up
 * running unhooked while believing they are gated — the silent pass, one layer
 * above the runner.
 *
 * @param {{ root: string, readFileImpl?: (p: string) => string, knownTools?: string[]|null }} opts
 */
export function loadHooks({ root, readFileImpl = (p) => readFileSync(p, 'utf8'), knownTools = null }) {
  const path = HOOKS_CONFIG_FILE;
  let text;
  try {
    text = readFileImpl(join(String(root ?? ''), HOOKS_CONFIG_FILE));
  } catch (err) {
    // ENOENT is "no hooks configured". Anything else — a permission error, a
    // directory where a file should be — is a fact the user needs, not a silent
    // fallback to unhooked.
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { ok: true, found: false, hooks: [], path };
    return { ok: false, found: true, hooks: [], path, error: `${path} could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = parseHooksConfig(text, { label: path, knownTools });
  if (!parsed.ok) return { ok: false, found: true, hooks: [], path, error: parsed.error };
  return { ok: true, found: true, hooks: parsed.hooks, path };
}

/**
 * Which hooks fire for this event and tool, in file order.
 *
 * ⭐ FILE ORDER IS THE CONTRACT. Hooks are a chain of gates and people write
 * them assuming the cheap one runs first; re-ordering them (by specificity, by
 * name) would be a surprise nobody can see in the file they wrote.
 *
 * @param {Array<object>} hooks
 * @param {'PreToolUse'|'PostToolUse'|'Stop'} event
 * @param {string|null} toolName
 */
export function hooksFor(hooks, event, toolName) {
  return (Array.isArray(hooks) ? hooks : []).filter((h) => {
    if (h.event !== event) return false;
    if (event === 'Stop') return true;
    // A hook with no `tools` key is a hook on everything — the same meaning as
    // ["*"], and the shape most people write first.
    if (h.tools === null) return true;
    return h.tools.includes('*') || h.tools.includes(toolName);
  });
}

/* ── what the command can see ────────────────────────────────────────────── */

/** Cap a value and SAY SO. See MAX_HOOK_ENV_CHARS for the kernel limit. */
function capped(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  if (s.length <= MAX_HOOK_ENV_CHARS) return s;
  return `${s.slice(0, MAX_HOOK_ENV_CHARS)}… [truncated, ${s.length} characters total]`;
}

/**
 * Turn an argument key into an environment variable name.
 * `path` → `ACUVO_TOOL_ARG_PATH`, `pullRequestTitle` → `ACUVO_TOOL_ARG_PULLREQUESTTITLE`.
 *
 * ⚠️ NON-ALPHANUMERIC BECOMES `_`, and a key that reduces to nothing is DROPPED
 * rather than exported as `ACUVO_TOOL_ARG_` — an empty-named variable is
 * rejected by `execve` on POSIX and would fail the spawn of every hook on that
 * tool, turning one odd argument name into "hooks are broken".
 */
function argEnvName(key) {
  const cleaned = String(key).replace(/[^A-Za-z0-9]/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return cleaned ? `ACUVO_TOOL_ARG_${cleaned}` : null;
}

/**
 * The variables a hook command reads.
 *
 * ⭐ WHY THE ENVIRONMENT AND NOT STDIN. `spawnBounded` opens the child with
 * `stdio: ['ignore', 'pipe', 'pipe']` — there is no stdin to write to, and
 * changing that would mean a second settle path in the one spawner whose
 * timeout/tree-kill logic everything else in this package depends on. The
 * environment reaches a `cmd.exe` one-liner and a `sh -c` one-liner identically,
 * which is what a cross-platform hook needs.
 *
 * ⭐ AND WHY THE SCALARS ARE BROKEN OUT SEPARATELY. `ACUVO_TOOL_ARGS` is the
 * complete, honest record — but the hook people actually write is
 * `npx prettier --write "$ACUVO_TOOL_ARG_PATH"`, and neither `sh` nor `cmd` has
 * a JSON parser. Requiring `jq` would make the feature unusable on most of the
 * machines it is for.
 *
 * ⚠️ OBJECT AND ARRAY ARGUMENTS GET NO SCALAR. `ACUVO_TOOL_ARG_HEADERS='[object
 * Object]'` is a string that looks like data and is not, and a shell has no way
 * to tell. They are in `ACUVO_TOOL_ARGS` in full, which is the honest place.
 */
export function hookEnvironment({ event, toolName = null, args = null, result = null, session = null, root = '' } = {}) {
  /** @type {Record<string,string>} */
  const env = { ACUVO_HOOK_EVENT: String(event) };
  if (root) env.ACUVO_WORKSPACE_ROOT = String(root);

  if (toolName) env.ACUVO_TOOL_NAME = String(toolName);
  if (args !== null && typeof args === 'object') {
    env.ACUVO_TOOL_ARGS = capped(JSON.stringify(args));
    for (const [k, v] of Object.entries(args)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') continue;
      const name = argEnvName(k);
      if (name) env[name] = capped(String(v));
    }
  }
  if (result !== null && typeof result === 'object') {
    env.ACUVO_TOOL_OK = result.ok === true ? '1' : '0';
    if (typeof result.error === 'string' && result.error) env.ACUVO_TOOL_ERROR = capped(result.error);
  }
  if (session !== null && typeof session === 'object') {
    env.ACUVO_SESSION_OK = session.ok === true ? '1' : '0';
    if (session.stoppedBecause != null) env.ACUVO_SESSION_STOPPED_BECAUSE = String(session.stoppedBecause);
    if (Number.isFinite(session.roundsUsed)) env.ACUVO_SESSION_ROUNDS = String(session.roundsUsed);
  }
  return env;
}

/* ── the runner ──────────────────────────────────────────────────────────── */

/** The tail of whatever the hook said, for the model and for the terminal. */
function outputOf(res) {
  const text = `${res?.stderr ?? ''}${res?.stdout ?? ''}`.trim();
  return text.length > 600 ? `…${text.slice(-600)}` : text;
}

/**
 * Build the per-session hook runner.
 *
 * @param {{
 *   hooks?: Array<object>,
 *   root?: string,
 *   onEvent?: (e: any) => void,
 *   runImpl?: (spec: {file: string, args: string[], cwd: string, timeoutMs: number, env: Record<string,string>}) => Promise<any>,
 *   baseEnv?: Record<string, string|undefined>,
 *   platform?: string,
 * }} opts
 */
export function createHookRunner({
  hooks = [],
  root = process.cwd(),
  onEvent = () => {},
  /**
   * ⚠️ `spawnBounded` BY DEFAULT AND NOT A SECOND SPAWNER. It is the function
   * that owns the timeout, the process-TREE kill, the output caps and the
   * settle grace — the four things that stand between "a hook" and "the agent
   * is hung and nobody knows why". Injectable so the blocking behaviour can be
   * proven without starting a process.
   */
  runImpl = null,
  baseEnv = process.env,
  platform = process.platform,
} = {}) {
  const list = Array.isArray(hooks) ? hooks : [];
  const run = runImpl ?? ((spec) => spawnBounded(spec));

  /**
   * Run one hook and classify the outcome into the only three things a caller
   * can act on.
   *
   * ⚠️ `error` AND `failed` ARE DIFFERENT AND MUST NOT BE MERGED. `failed` is
   * the hook DECIDING — a linter found problems, a guard refused a path — and
   * for `PreToolUse` that decision is the product. `error` is the hook never
   * getting to decide: not installed, could not start, killed at the timeout.
   * Both stop a `PreToolUse` call, but only `error` is a configuration problem
   * the USER has to fix, and rendering them identically would send someone
   * hunting a policy bug when their `$PATH` is wrong.
   *
   * @returns {Promise<{ kind: 'ok'|'failed'|'error', hook: object, output: string, error?: string, exitCode?: number|null, durationMs?: number }>}
   */
  const runOne = async (hook, env) => {
    const invocation = buildShellInvocation(hook.command, { platform, env: baseEnv });
    if (!invocation.ok) return { kind: 'error', hook, output: '', error: invocation.error };

    let res;
    try {
      res = await run({
        file: invocation.file,
        args: invocation.args,
        cwd: root,
        // ⚠️ ALWAYS A NUMBER. `spawnBounded` arms its timer from this value; an
        // undefined here is an unbounded child, which is the hang this whole
        // module promises cannot happen.
        timeoutMs: hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
        /**
         * ⚠️ SCRUBBED, THEN OUR VARIABLES ON TOP. A hook is a user's command,
         * but it is spawned by a process holding `OPENROUTER_API_KEY` — and
         * `scrubEnvironment` is the one audited place that knows which names
         * must never survive a spawn. Composing here rather than passing
         * `process.env` keeps hooks on the same footing as `run_command`.
         */
        env: { ...scrubEnvironment(baseEnv), ...env },
      });
    } catch (err) {
      // A spawner that THROWS is a broken spawner, and a hook that cannot be
      // run must never be reported as a hook that passed.
      return { kind: 'error', hook, output: '', error: err instanceof Error ? err.message : String(err) };
    }

    if (!res || res.ok !== true) {
      return { kind: 'error', hook, output: '', error: res?.error ?? 'the hook could not be started' };
    }
    if (res.timedOut === true) {
      return {
        kind: 'error', hook, output: outputOf(res), durationMs: res.durationMs ?? null,
        error: `the hook timed out after ${hook.timeoutMs}ms and was killed`,
      };
    }
    if (res.exitCode === 0) {
      return { kind: 'ok', hook, output: outputOf(res), exitCode: 0, durationMs: res.durationMs ?? null };
    }
    return { kind: 'failed', hook, output: outputOf(res), exitCode: res.exitCode ?? null, durationMs: res.durationMs ?? null };
  };

  /** One announcement shape, so a JSON consumer and the terminal see the same fact. */
  const announce = (outcome, { event, tool = null, blocked = false }) => {
    if (outcome.kind === 'error') {
      onEvent({ type: 'hook-error', event, tool, hook: outcome.hook.label, command: outcome.hook.command, error: outcome.error, output: outcome.output, blocked });
      return;
    }
    onEvent({
      type: 'hook',
      event,
      tool,
      hook: outcome.hook.label,
      command: outcome.hook.command,
      ok: outcome.kind === 'ok',
      blocked,
      exitCode: outcome.exitCode ?? null,
      output: outcome.output,
      durationMs: outcome.durationMs ?? null,
    });
  };

  /** Read `{ id, function: { name, arguments } }` without ever throwing on it. */
  const readCall = (call) => {
    const name = call?.function?.name ?? call?.name ?? null;
    let args = call?.args ?? null;
    if (args === null) {
      try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { args = {}; }
    }
    return { id: call?.id ?? null, name, args };
  };

  return {
    /** True when this workspace configured anything at all. */
    enabled: list.length > 0,
    count: list.length,
    hooks: list,

    /**
     * ⭐⭐⭐ THE GATE. Runs every matching `PreToolUse` hook in order and, on the
     * first refusal, hands back a ready-made failed tool record for the caller
     * to push in place of the call.
     *
     * ⚠️ THE RECORD IS BUILT HERE ON PURPOSE. `turn.mjs` pushes tool records
     * onto `executed`, feeds them to `toolResultText`, and counts `mutated` for
     * the "N files written" line. A blocked call must look like every other
     * refusal — `ok: false`, `mutated: false`, an error the model can read —
     * or one of those three consumers grows a special case for hooks and
     * eventually disagrees with the other two.
     */
    async before(call) {
      const { id, name, args } = readCall(call);
      const matching = hooksFor(list, 'PreToolUse', name);
      if (matching.length === 0) return { ok: true };

      const env = hookEnvironment({ event: 'PreToolUse', toolName: name, args, root });
      for (const hook of matching) {
        const outcome = await runOne(hook, env);
        if (outcome.kind === 'ok') {
          announce(outcome, { event: 'PreToolUse', tool: name });
          continue;
        }
        /**
         * ⚠️⚠️ AN ERROR BLOCKS TOO, AND THIS IS THE DECISION THE WHOLE MODULE
         * TURNS ON. A `PreToolUse` hook exists to answer one question. If it
         * could not be started or had to be killed, it did not answer — and
         * treating "no answer" as "yes" is precisely the silent gate this file
         * was written to make impossible. The cost is stated: a typo in the
         * command halts the agent's tool calls. That is the loud failure, and it
         * is the one a user can fix in ten seconds; the quiet one costs them the
         * policy they thought they had.
         */
        announce(outcome, { event: 'PreToolUse', tool: name, blocked: true });
        const why = outcome.kind === 'error'
          ? `could not run (${outcome.error})`
          : `exited ${outcome.exitCode}`;
        const said = outcome.output ? `\n${outcome.output}` : '';
        return {
          ok: false,
          hook,
          kind: outcome.kind,
          output: outcome.output,
          record: {
            id,
            name,
            args,
            mutated: false,
            /**
             * ⭐ THE HOOK'S OWN WORDS GO TO THE MODEL. "Blocked" with no reason
             * is a wall it walks into again next round at full token price; the
             * stderr of a guard script is usually the exact instruction needed
             * ("infra/ is protected — ask a human"). And it is told this is a
             * POLICY, so it stops retrying and reports instead.
             */
            result: {
              ok: false,
              blockedByHook: hook.label,
              error: `blocked by the PreToolUse hook "${hook.label}" — it ${why}. `
                + 'This is a workspace policy, not a transient failure: do not retry the same call. '
                + `Do the work another way, or say that the policy stopped you.${said}`,
            },
          },
        };
      }
      return { ok: true };
    },

    /**
     * `PostToolUse`. Cannot block — the tool has already run and the file is
     * already on disk — so its whole job is to be LOUD and to hand the failures
     * back to the caller.
     */
    async after(record) {
      const name = record?.name ?? null;
      const matching = hooksFor(list, 'PostToolUse', name);
      if (matching.length === 0) return { ok: true, failures: [] };

      const env = hookEnvironment({
        event: 'PostToolUse', toolName: name, args: record?.args ?? null, result: record?.result ?? null, root,
      });
      const failures = [];
      for (const hook of matching) {
        const outcome = await runOne(hook, env);
        // ⚠️ NEVER `blocked: true` HERE. Claiming to have blocked something that
        // already happened would be a false statement in the audit stream.
        announce(outcome, { event: 'PostToolUse', tool: name, blocked: false });
        if (outcome.kind !== 'ok') {
          failures.push({ hook: hook.label, kind: outcome.kind, error: outcome.error ?? null, output: outcome.output, exitCode: outcome.exitCode ?? null });
        }
      }
      return { ok: failures.length === 0, failures };
    },

    /**
     * `Stop`. Fires where the session ends.
     *
     * ⚠️ IT MUST NEVER THROW AND NEVER CHANGE THE OUTCOME. A notifier that is
     * not installed is not a reason to lose a completed run's summary, its
     * cost, or its saved session — the failure is reported and the return value
     * is advisory.
     */
    async stop(session) {
      const matching = hooksFor(list, 'Stop', null);
      if (matching.length === 0) return { ok: true, failures: [] };

      const env = hookEnvironment({ event: 'Stop', session: session ?? null, root });
      const failures = [];
      for (const hook of matching) {
        const outcome = await runOne(hook, env);
        announce(outcome, { event: 'Stop', tool: null, blocked: false });
        if (outcome.kind !== 'ok') {
          failures.push({ hook: hook.label, kind: outcome.kind, error: outcome.error ?? null, output: outcome.output, exitCode: outcome.exitCode ?? null });
        }
      }
      return { ok: failures.length === 0, failures };
    },
  };
}
