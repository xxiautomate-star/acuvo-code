/**
 * ── ⭐⭐⭐ `--harness <name>` — DRIVING SOMEBODY ELSE'S AGENT LOOP ────────────
 *
 * Roman, four times, most recently today: *"the only way we are going to make an
 * exceptional product and everything in it like the harness etc, is by
 * integrating and wrapping, and you must continue to do it."*
 *
 * So this module does not reimplement an agent loop. `lib/turn.mjs` is 7,200
 * lines and it is ours; this is the OTHER door — the user hands a task to an
 * external harness they installed themselves, and Acuvo stays the thing they
 * ran, the thing that meters, and the thing that supplies the verbs.
 *
 * ── ⚠️⚠️ WHY THIS IS A FLAG AND NOT A VERB — THE BYTE CEILING ──────────────
 *
 * The tool array is re-sent to the model EVERY ROUND. A verb here would cost
 * bytes on every task including "hi", forever, to buy a capability the MODEL
 * has no reason to reach for — the user chooses a harness, not the agent.
 * `--harness` is parsed in `bin/acuvo.mjs` before `parseArgv`, appears in no
 * schema, and its byte delta against the model payload is therefore EXACTLY
 * ZERO. `test/harness-costs-no-model-bytes.test.mjs` pins that at zero by
 * building the real payload both ways, because "it's only a flag" is precisely
 * the kind of claim that rots.
 *
 * ── ⭐ WHY CODEX AND NOT CLAUDE CODE ────────────────────────────────────────
 *
 * Verified on disk at `@openai/codex@0.130.0`, not from a blog:
 * `package.json` declares `"license": "Apache-2.0"`, and we spawn the user's
 * OWN separately-installed binary — we vendor nothing, link nothing, and
 * redistribute nothing, so `dependencies: {}` is untouched and the install
 * stays native-build-free. Claude Code is `license: null` / all-rights-reserved
 * and its terms forbid building a competing product; it is not a candidate and
 * this module must never grow an adapter for it.
 *
 * ── ⚠️⚠️ THREE MEASURED FACTS THAT THE OBVIOUS IMPLEMENTATION GETS WRONG ────
 *
 * 1. **`wire_api = "chat"` IS GONE.** Codex 0.130.0 refuses to load a config
 *    containing it — *"`wire_api = "chat"` is no longer supported"* — and exits
 *    1 before sending a single request. It speaks the OpenAI **Responses** API.
 *    Anything here that assumes `/chat/completions` is wrong on the current
 *    release. Measured 2026-08-30.
 *
 * 2. **ON WINDOWS `codex` ON PATH IS A `.cmd` SHIM AND NODE CANNOT SPAWN IT.**
 *    `toolchain.mjs` `probe()` already reports `{installed: true, spawnable:
 *    false}` for exactly this reason (CVE-2024-27980, "BatBadBut"). Spawning it
 *    with `shell: true` would work and would also hand cmd.exe a task string the
 *    user typed — a command-injection surface in the one place we accept free
 *    text. `resolveHarness` instead reads the shim's sibling `node_modules` and
 *    spawns `process.execPath` against the package's own JS entry, so there is
 *    no shell on the path at all.
 *
 * 3. **CODEX REPORTS ITS OWN TOKENS.** `--json` ends a turn with
 *    `{"type":"turn.completed","usage":{input_tokens, cached_input_tokens,
 *    output_tokens, reasoning_output_tokens}}`. That is a DIFFERENT SPELLING
 *    from the one `budget.mjs` `splitFromUsage` reads, and feeding it raw would
 *    silently price every harness run at zero — `splitFromUsage` returns null
 *    when it cannot find `prompt_tokens`, `record()` would then find no split,
 *    and the round would be counted as cache-UNKNOWN and priced by projection.
 *    `normaliseUsage` below is the translation, and it is the whole reason
 *    metering follows.
 */

import { join, dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { probe } from './toolchain.mjs';

/**
 * ⚠️ THE NAME SHAPE IS A GUARD, NOT A FORMALITY. The harness id reaches
 * `resolveHarness` from the command line and is used to select a record here;
 * an unconstrained string that later reached a path join would be a traversal.
 * Ids are drawn from `HARNESSES` and nothing else — this only rejects early,
 * with a better sentence.
 */
const ID_SHAPE = /^[a-z][a-z0-9-]*$/;

/**
 * ── ⭐⭐ THE REGISTRY ────────────────────────────────────────────────────────
 *
 * One record per harness. `npmPackage` + `jsEntry` are how a Windows shim is
 * resolved back to something Node can spawn (fact 2 above); a harness that is a
 * real native binary leaves them null and is spawned directly.
 *
 * ⚠️ `licence` IS RECORDED BECAUSE THE ANSWER DECIDES WHETHER WE MAY SHIP THE
 * ADAPTER AT ALL, and because the last time this question was answered from a
 * blog post, two of three recommended repositories did not exist. Every value
 * here was read off the installed package on disk.
 */
export const HARNESSES = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    label: 'OpenAI Codex CLI',
    binary: 'codex',
    npmPackage: '@openai/codex',
    jsEntry: 'bin/codex.js',
    licence: 'Apache-2.0',
    install: 'npm i -g @openai/codex',
    /**
     * ⚠️ `exec` IS THE NON-INTERACTIVE SUBCOMMAND. Plain `codex` opens a TUI
     * and would hang forever behind a pipe — which is exactly what happened to
     * `opencode --help` while this was being written: it blocked past a 120s
     * timeout because the default subcommand is a full-screen interface.
     */
    argv: ['exec'],
    /** Emits one JSON object per line on stdout. Proven, see the header. */
    jsonFlag: '--json',
  }),
});

export const HARNESS_IDS = Object.freeze(Object.keys(HARNESSES));

/**
 * ── ⭐⭐ THE HONEST REFUSAL, IN `check_tools`' SHAPE ─────────────────────────
 *
 * `toolchain.mjs` already established what a refusal owes the reader: not that
 * something is missing, but the ONE LINE that changes it. Inventing a second
 * style of refusal for the same class of problem is how a codebase ends up with
 * two vocabularies for "not here".
 *
 * ⚠️ IT NEVER THROWS AND NEVER EXITS. The caller decides; this returns a
 * verdict. A refusal that calls `process.exit` cannot be unit-tested and cannot
 * be embedded in a larger report.
 *
 * @returns {{ok: true, id, label, command: string, args: string[], via: string}
 *          | {ok: false, id: string, reason: string, message: string}}
 */
export function resolveHarness(id, {
  env = process.env,
  platform = process.platform,
  exists = isRealFile,
  /**
   * ⚠️ INJECTABLE BECAUSE THE WINDOWS SHIM PATH IS THE ONE THAT MATTERS AND THE
   * ONE NOBODY CAN REACH. `probe` reads the real filesystem, so on a Linux CI
   * box — or on a Windows box where codex IS installed — the `.cmd` branch is
   * simply never executed and its guard passes while checking nothing. That is
   * this repo's most-repeated defect, so the seam exists to close it.
   */
  probeImpl = probe,
} = {}) {
  const key = String(id ?? '').trim().toLowerCase();
  if (!key) {
    return {
      ok: false,
      id: key,
      reason: 'no-name',
      message: `--harness needs the name of an agent harness to drive. Available: ${HARNESS_IDS.join(', ')}.`,
    };
  }
  if (!ID_SHAPE.test(key) || !Object.hasOwn(HARNESSES, key)) {
    return {
      ok: false,
      id: key,
      reason: 'unknown',
      message: `--harness does not know ${JSON.stringify(key)}. Available: ${HARNESS_IDS.join(', ')}.`,
    };
  }
  const h = HARNESSES[key];
  const found = probeImpl(h.binary, env, platform);
  if (!found.installed) {
    return {
      ok: false,
      id: key,
      reason: 'not-installed',
      /**
       * ⚠️ THE SENTENCE SAYS WHAT TO INSTALL *AND WHY IT IS NOT BUNDLED*. Acuvo
       * ships zero dependencies on purpose; a user who is told only "not found"
       * reasonably concludes the feature is broken rather than that it is a
       * deliberate, separately-installed backend.
       */
      message: `${h.label} is not on PATH, so --harness ${key} has nothing to drive.\n`
        + `  Install it:  ${h.install}\n`
        + `  Why it is not bundled: Acuvo ships with zero dependencies, so an external\n`
        + `  harness is always the user's own install — nothing is vendored into this package.\n`
        + `  ${h.label} is ${h.licence}.`,
    };
  }

  /**
   * ⭐ THE SPAWNABLE CASE. POSIX, or a real `.exe` on Windows.
   */
  if (found.spawnable) {
    return { ok: true, id: key, label: h.label, command: h.binary, args: [], via: 'path' };
  }

  /**
   * ── ⚠️⚠️ THE WINDOWS SHIM. Fact 2 in the header. ─────────────────────────
   *
   * The npm shim's own contents point at
   * `<shim dir>/node_modules/<pkg>/<entry>`, so that is what we look for rather
   * than parsing the batch file — parsing a generated `.cmd` would be a guess
   * about npm's codegen, while the layout is npm's documented contract.
   */
  const entry = h.npmPackage && h.jsEntry ? findNpmEntry(h, env, platform, exists) : null;
  if (entry) {
    return { ok: true, id: key, label: h.label, command: process.execPath, args: [entry], via: 'node-entry' };
  }

  return {
    ok: false,
    id: key,
    reason: 'shim-not-spawnable',
    /**
     * ⚠️ "INSTALLED" ALONE WOULD BE A LIE HERE, and it is the exact lie
     * `toolchain.mjs` calls out: the file demonstrably exists and spawning it
     * produces EINVAL. The user needs to know the difference or they will spend
     * the afternoon proving to themselves that the thing on their PATH is real.
     */
    message: `${h.label} is on PATH as a .cmd/.bat shim, which Node cannot spawn directly (CVE-2024-27980),\n`
      + `  and its JavaScript entry point could not be found next to the shim.\n`
      + `  Reinstall it:  ${h.install}\n`
      + `  Acuvo deliberately refuses to run it through a shell — the task text you type would\n`
      + `  then be parsed by cmd.exe, which is a command-injection surface we will not open.`,
  };
}

/**
 * ⚠️⚠️ ONE WHOLE PREDICATE, NOT `exists()` AND THEN A REAL `statSync`.
 *
 * The first version injected `exists` for the test and then called the REAL
 * `statSync` on the path it approved — so a synthetic path passed the first
 * check, threw on the second, and the Windows branch reported "not installed"
 * on a machine where it was installed. The seam has to cover the whole
 * question or it is not a seam, it is a trapdoor.
 */
export function isRealFile(p) {
  try { return existsSync(p) && statSync(p).isFile(); } catch { return false; }
}

/**
 * Walk each PATH directory looking for the shim's sibling package entry.
 *
 * ⚠️ IT CHECKS THE FILE EXISTS RATHER THAN TRUSTING THE LAYOUT. A global
 * install that has been partially removed leaves the shim behind, and spawning
 * `node <missing file>` fails with a stack trace instead of our sentence.
 */
function findNpmEntry(h, env, platform, exists) {
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  const rel = join('node_modules', ...h.npmPackage.split('/'), ...h.jsEntry.split('/'));
  for (const dir of dirs) {
    const candidate = join(dir, rel);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * ── ⭐⭐⭐ THE TRANSLATION THAT MAKES METERING WORK. Fact 3 in the header. ───
 *
 * Codex says `input_tokens` / `cached_input_tokens` / `output_tokens`.
 * `budget.mjs` `splitFromUsage` reads `prompt_tokens` / `completion_tokens` /
 * `prompt_tokens_details.cached_tokens` and returns **null** for anything else.
 *
 * ⚠️⚠️ A NULL SPLIT IS NOT A LOUD FAILURE, IT IS A SILENT DISCOUNT. `record()`
 * would count the round as cache-unknown, find no `costUsd`, find no `tokens`,
 * and fall through to `source: 'projected'` — pricing a real 46KB round at
 * whatever the trend guessed. The run would look metered and would not be.
 * That is the exact shape of the defect this repo has shipped before, so the
 * translation is a named, tested function rather than an inline object literal.
 *
 * ⭐ IT RETURNS null WHEN THERE IS NOTHING TO READ, so the caller can tell
 * "no usage was reported" apart from "zero tokens moved" — `record()` treats
 * those two completely differently and it is right to.
 *
 * @param {object} usage a codex `turn.completed` usage block
 * @returns {null | {prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: {cached_tokens}}}
 */
export function normaliseUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : null;
  if (!u) return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

  /**
   * ⚠️ ACCEPTS BOTH SPELLINGS. The wire (the Responses API `response.completed`
   * event) says `input_tokens` + `input_tokens_details.cached_tokens`; codex's
   * own JSONL flattens the same numbers to `cached_input_tokens`. One function
   * reads both so the proxy path and the stdout path cannot disagree about what
   * a run cost.
   */
  const input = n(u.input_tokens) ?? n(u.prompt_tokens);
  const output = n(u.output_tokens) ?? n(u.completion_tokens);
  if (input === null || output === null) return null;

  const details = u.input_tokens_details && typeof u.input_tokens_details === 'object' ? u.input_tokens_details : {};
  const cachedRaw = n(u.cached_input_tokens)
    ?? n(details.cached_tokens)
    ?? n(u.cached_tokens)
    ?? 0;
  /**
   * ⚠️ CLAMPED, for the same reason `splitFromUsage` clamps: a provider
   * reporting more cached than input tokens produces a negative fresh-input
   * term and UNDER-BILLS. Failing toward the expensive reading is the only safe
   * direction for a number that becomes a charge.
   */
  const cached = Math.min(cachedRaw, input);

  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: n(u.total_tokens) ?? input + output,
    prompt_tokens_details: { cached_tokens: cached },
  };
}

/**
 * Parse codex's JSONL stdout into events, tolerating partial lines.
 *
 * ⚠️ A CHUNK BOUNDARY IS NOT A LINE BOUNDARY. `child.stdout` emits whatever the
 * pipe had; a 46KB turn routinely splits a JSON object across two `data`
 * events. Parsing per-chunk would drop the `turn.completed` event — the one
 * carrying the usage — at random, which would look exactly like a harness that
 * sometimes forgets to report tokens.
 *
 * ⭐ A LINE THAT DOES NOT PARSE IS RETURNED AS TEXT, NEVER DROPPED. Codex
 * prints human-readable warnings to stdout in some modes, and swallowing them
 * would hide the reason a run did nothing.
 */
export function createJsonlReader() {
  let buffer = '';
  return {
    push(chunk) {
      buffer += String(chunk);
      const out = [];
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        out.push(parseLine(line));
      }
      return out;
    },
    /** Whatever never got its newline. Called on close so nothing is lost. */
    flush() {
      const line = buffer.trim();
      buffer = '';
      return line ? [parseLine(line)] : [];
    },
  };
}

function parseLine(line) {
  try {
    const v = JSON.parse(line);
    if (v && typeof v === 'object' && typeof v.type === 'string') return { kind: 'event', event: v };
    return { kind: 'text', text: line };
  } catch {
    return { kind: 'text', text: line };
  }
}

/**
 * The one-line human summary for an event, or null for events with nothing to
 * say. This is what makes an external harness's work show up in OUR ui instead
 * of as a wall of JSON.
 *
 * ⚠️ NULL MEANS "SHOW NOTHING", NOT "UNKNOWN EVENT". An unrecognised event type
 * still returns its type, because a silent unknown is how a new codex release
 * makes the surface look broken with no clue why.
 */
export function describeEvent(event) {
  const t = event?.type;
  if (!t) return null;
  switch (t) {
    case 'thread.started': return null;
    case 'turn.started': return null;
    case 'turn.completed': return null;
    case 'item.started': return null;
    case 'item.updated': return null;
    case 'item.completed': {
      const item = event.item ?? {};
      if (item.type === 'agent_message') return { level: 'message', text: String(item.text ?? '') };
      if (item.type === 'reasoning') return { level: 'dim', text: 'thinking' };
      if (item.type === 'command_execution') {
        return { level: 'step', text: `ran: ${String(item.command ?? '').slice(0, 120)}` };
      }
      /**
       * ⚠️ THE SHAPE IS `{ changes: [{ path, kind }], status }` (verified against
       * `exec_events.rs`), so the COUNT is available and a bare "changed files"
       * throws away the only number the user cares about — a harness that edited
       * one file and one that edited forty must not read identically.
       */
      if (item.type === 'file_change' || item.type === 'patch_apply') {
        const n = Array.isArray(item.changes) ? item.changes.length : 0;
        return { level: 'step', text: n ? `changed ${n} file${n === 1 ? '' : 's'}` : 'changed files' };
      }
      if (item.type === 'mcp_tool_call') {
        return { level: 'step', text: `acuvo verb: ${String(item.tool ?? item.name ?? 'tool')}` };
      }
      return { level: 'step', text: String(item.type ?? 'item') };
    }
    case 'error': return { level: 'error', text: String(event.message ?? 'error') };
    case 'turn.failed': return { level: 'error', text: String(event.error?.message ?? 'the harness turn failed') };
    default: return { level: 'dim', text: t };
  }
}

/**
 * Pull the usage block out of a `turn.completed` event.
 *
 * ── ⚠️⚠️⭐ IT IS CUMULATIVE, NOT PER-TURN, AND THE DOC-COMMENT UPSTREAM LIES ─
 *
 * `exec_events.rs` documents `Usage` as *"the usage of tokens during a turn"*.
 * It is not. `event_processor_with_jsonl_output.rs` fills it from
 * `usage_from_last_total()`, reading `ThreadTokenUsage.total` — the running
 * total for the whole thread — and throwing away the per-turn `.last`:
 *
 *     fn usage_from_last_total(&self) -> Usage {
 *         ... input_tokens: usage.total.input_tokens, ...
 *
 * ⚠️ SO SUMMING EVERY `turn.completed` DOUBLE-COUNTS. Two turns reporting a
 * running total of 10k then 25k are not 35k of work, they are 25k. On a
 * one-turn `codex exec` the two readings coincide, which is exactly why this
 * would have passed every quick test and over-reported on the first real
 * multi-turn run — the failure shape this package keeps shipping.
 *
 * ⭐ SO THE CALLER TAKES THE LAST READING, NEVER THE SUM. `latestUsage` below
 * is the only supported way to fold these, and it is named so that a future
 * `.reduce((a,b) => a+b)` looks as wrong as it is.
 *
 * ⚠️ NONE OF THIS APPLIES TO THE PROXY PATH, where each `response.completed`
 * is one genuine HTTP request's own usage and summing is correct.
 */
export function usageFromEvent(event) {
  if (event?.type !== 'turn.completed') return null;
  return normaliseUsage(event.usage);
}

/**
 * Fold codex's cumulative usage readings into the one that counts: the last.
 *
 * @param {object[]} readings in arrival order
 * @returns {object|null}
 */
export function latestUsage(readings) {
  if (!Array.isArray(readings) || readings.length === 0) return null;
  return readings[readings.length - 1];
}
