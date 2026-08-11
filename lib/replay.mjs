/**
 * ── ⭐⭐ REPLAY — STEP THROUGH A RUN THAT ALREADY HAPPENED ───────────────────
 *
 * "It did something weird on Tuesday" has no answer anywhere in this category.
 * It does here, and it costs nothing, because the two documents that answer it
 * are already being written on every run:
 *
 *   · `session.mjs` saves the whole conversation — every assistant thought,
 *     every tool call with its arguments, every result — secrets redacted on
 *     the way in.
 *   · `audit.mjs` appends one line per run — the verdict, the acceptance, the
 *     refusals, the money.
 *
 * This module turns those into a TIMELINE: round by round, what it thought,
 * what it called, what came back, where it was refused, how it ended. Plus the
 * two views that make it a tool rather than a log dump — a DIFF between two
 * runs of the same task, and a FILTER for the one question you actually have.
 *
 * ── ⚠️⚠️ THE INVARIANT: REPLAY EXECUTES NOTHING ─────────────────────────────
 *
 * Not a file written, not a command run, not a model called. `session.mjs`
 * holds the same line for resume — its `resumeMessages` returns `replayed:
 * false` and its header explains why a resume that re-executes is "a command
 * run twice by a user who typed it once". A replay that re-executes is worse:
 * the user asked to LOOK at what happened, and looking is the one operation
 * that must be safe on a run you already know went wrong.
 *
 * ⭐ THE INVARIANT IS ENFORCED BY THE IMPORT LIST, NOT BY DISCIPLINE. This file
 * imports one pure function and nothing else — no filesystem, no process, no
 * network, not one builtin. It is structurally incapable of the thing it must
 * not do, and `replay.test.mjs` asserts that from both directions: it replays a
 * record whose calls delete a real file and checks the file survives, AND it
 * reads this source and fails if a single builtin import ever appears.
 *
 * That is why loading and saving live at the EDGES — the caller does the I/O:
 *
 *     const loaded = loadSession(root, id);         // session.mjs touches disk
 *     const replay = replaySession(loaded.session); // this file never does
 *
 * ── ⚠️ VALIDATE THE RECORD, DO NOT TRUST IT ────────────────────────────────
 *
 * A record can be from an older build, half-written by a killed process, or
 * hand-edited by the person debugging with it. Every one of those must produce
 * a sentence, never a stack trace — `plan-ledger.mjs`'s rule, and it applies
 * harder here because the reader of a replay is already having a bad day.
 *
 * The split: IDENTITY fields are strict (a wrong version is a refusal, because
 * misreading a future shape is how a replay quietly describes a different run);
 * SECONDARY fields are tolerant and the repair is WARNED (a hand-edited record
 * missing its `commands` array is still worth reading, and a silent default
 * would be the lie).
 *
 * ── ⚠️ SECRETS ARE REDACTED ON THE WAY IN, AND AGAIN ON THE WAY OUT ────────
 *
 * `session.mjs` scrubs before it writes. This file scrubs again on read, and
 * the belt-and-braces is deliberate: records get hand-edited, older builds had
 * weaker redactors, and a key pasted into a transcript by a user is a shape no
 * writer has yet been asked about. Redaction happens ONCE, here, in the data
 * layer — so every renderer below (timeline, diff, filter) is safe by
 * construction rather than by each remembering to be. There is no opt-out flag,
 * because an opt-out flag is the thing someone eventually passes.
 *
 * ⚠️ AND REDACT BEFORE TRUNCATING, never after. `audit.mjs` names this exact
 * ordering trap: a key just past the clamp is hidden today and printed the
 * first time someone raises the limit, and the test still passes.
 */

/**
 * ⚠️ THE ONLY IMPORT, AND IT IS A PURE FUNCTION.
 *
 * `redactSecrets` is `session.mjs`'s hardened redactor — the one that already
 * knows `tokenCount = tokens.length` is code and `DB_PASSWORD=hunter2hunter` is
 * not. A second copy here would be the copy that goes stale, and a redactor
 * that has drifted is worse than an obvious hole: it reads as protection.
 */
import { redactSecrets } from './session.mjs';

/** Bump when the STEP SHAPE changes in a way a consumer must branch on. */
export const REPLAY_FORMAT_VERSION = 1;

/** The only `session.mjs` record version this file claims to understand. */
export const SUPPORTED_SESSION_VERSION = 1;

/** The only `audit.mjs` schema version this file claims to understand. */
export const SUPPORTED_AUDIT_VERSION = 1;

/**
 * Tools that PRODUCE A FILE in the workspace.
 *
 * ⚠️ Kept in step with `tools.mjs`'s `mutated: true` cases, and the membership
 * is not obvious for two of them: `see_page` reads a page and writes a
 * SCREENSHOT, and `speak` writes an audio file. Both are the kind of output a
 * "what did this run write" question is asking about, and both were invisible
 * to the first draft of this list.
 */
export const WRITING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'delete_file',
  'make_document',
  'generate_image',
  'speak',
  'see_page',
]);

/**
 * Tools that RUN A PROCESS.
 *
 * ⚠️ `git_commit` is here rather than in the writing set on purpose: it does
 * not write a file the user asked for, it changes repository state by running
 * git — and someone asking "what did this run execute" wants it in the answer.
 * `check_acceptance` is here for the reason `turn.mjs` spells out at length:
 * it spawns through the same gate `run_command` does, and a command does not
 * become less run because a different verb asked for it.
 */
export const RUNNING_TOOLS = new Set([
  'run_command',
  'run_program',
  'evaluate',
  'check_acceptance',
  'git_commit',
]);

/**
 * How much of one step's text is carried in the DATA.
 *
 * ⚠️ The renderer clamps FURTHER, and the hidden-character count it prints is
 * computed from `step.chars` — the ORIGINAL length — never from what survived
 * this clamp. Two clamps in series, each reporting against its own input, is
 * how a 500KB read gets described as "+800 characters".
 */
export const MAX_STEP_TEXT = 1_200;

/** How much of one step's text the timeline shows by default. */
export const MAX_RENDER_TEXT = 400;

/**
 * ⚠️ THE ALIGNMENT IS O(n·m). Real runs are tens of steps and a quadratic walk
 * over them is free; a pathological record is not this module's problem to
 * solve heroically, so past this many steps the diff falls back to a positional
 * comparison and SAYS it did. A slow correct answer nobody waits for is not an
 * answer.
 */
export const MAX_ALIGNED_STEPS = 600;

/* ────────────────────────────────────────────────────────────────────────────
 * PURE HELPERS
 * ──────────────────────────────────────────────────────────────────────────── */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Newlines normalised FIRST.
 *
 * ⚠️ Two reasons and both are load-bearing. A stray `\r` inside a rendered
 * timeline moves the cursor to column zero and overwrites the line above it —
 * on Windows, where every recorded command output is CRLF, that silently eats
 * the indentation of the whole report. And the redactor's assignment rule is
 * line-anchored (`^…$` with `/gm`), so a `DB_PASSWORD=…` line ending in `\r`
 * ends with a non-newline character and does not match. Normalising is
 * therefore cosmetic AND a security fix, which is not a coincidence: both bugs
 * come from pretending `\r\n` is one character.
 */
function normalizeText(value) {
  if (typeof value === 'string') return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (value === undefined || value === null) return '';
  // A multimodal round carries an array of parts. Keep it rather than dropping
  // it — an empty step where content existed is a hole with no marker.
  try {
    return JSON.stringify(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  } catch {
    return String(value);
  }
}

/** Normalise → redact → clamp, in that order, and report the TRUE length. */
function scrub(value, max = MAX_STEP_TEXT) {
  const normalized = normalizeText(value);
  const { text } = redactSecrets(normalized);
  const chars = text.length;
  if (chars <= max) return { text, chars };
  return { text: text.slice(0, max), chars };
}

/**
 * Redact every string inside a parsed structure.
 *
 * ⚠️ WHY THE PARSED OBJECT IS REDACTED RATHER THAN THE JSON TEXT REPARSED. A
 * replacement dropped into a JSON string could, in principle, break the quoting
 * and turn a readable argument list into `null`. Walking the parsed value
 * cannot produce invalid JSON because it never produces JSON at all — it edits
 * leaves in place.
 */
function redactDeep(value, depth = 0) {
  if (depth > 12) return value;
  if (typeof value === 'string') return redactSecrets(normalizeText(value)).text;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * One path spelling, so `lib\a.mjs` and `lib/a.mjs` are one file.
 *
 * ⚠️ NO CASE FOLDING. Windows is case-insensitive and Linux is not, and a
 * replay of a Linux run read on a Windows laptop must not merge `Makefile` and
 * `makefile` into one history. Getting the separator right is unambiguous;
 * getting the case right is a guess about a machine that is not this one.
 */
function normalizePath(p) {
  if (typeof p !== 'string' || p === '') return null;
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Which files does this call name? `tools.mjs` spells the argument four ways. */
function pathsOf(args) {
  if (!isPlainObject(args)) return [];
  const found = [];
  for (const key of ['path', 'file', 'filename', 'target', 'out']) {
    const norm = normalizePath(args[key]);
    if (norm && !found.includes(norm)) found.push(norm);
  }
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      const norm = normalizePath(p);
      if (norm && !found.includes(norm)) found.push(norm);
    }
  }
  return found;
}

/**
 * ⭐ HOW A REFUSAL IS RECOGNISED, AND WHY IT IS NOT A GUESS.
 *
 * `turn.mjs`'s `toolResultText` has exactly one line for a failed tool:
 *
 *     if (!result || result.ok !== true) return `${name} failed: ${error}`;
 *
 * So every refusal in every transcript begins with the tool's own name followed
 * by ` failed: `, and nothing else does — a success is rendered by a per-tool
 * formatter that never starts that way. Anchoring on the START of the content
 * (not a search) is what keeps a `read_file` result whose FILE happens to
 * contain that sentence from being reported as a refusal.
 */
function readRefusal(text, tool) {
  if (typeof text !== 'string') return null;
  const match = /^([A-Za-z_][A-Za-z0-9_]*) failed: ([\s\S]*)$/.exec(text);
  if (!match) return null;
  // When we know which tool answered, the prefix must be that tool. A record
  // where they disagree is a record to be suspicious of, not to reinterpret.
  if (tool && match[1] !== tool) return null;
  return match[2].trim();
}

/**
 * ── ⚠️⭐ A COMMAND THAT FAILED IS NOT A TOOL THAT FAILED ────────────────────
 *
 * `command.mjs` states the rule at the point it builds the result: "`ok: true`
 * MEANS THE COMMAND RAN, NOT THAT IT PASSED. Those are different facts and
 * conflating them is exactly how a loop ends up reporting success on a failing
 * test." So a run of `npm test` that exits 1 is a SUCCESSFUL `run_command` —
 * `ok: true`, no refusal, nothing in the transcript starting `run_command
 * failed:`.
 *
 * ⚠️ WHICH MAKES IT THE ENTIRE POINT OF THE DIFF. "It passed once and failed
 * once" is the question this module exists to answer, and until this function
 * existed the two runs differed only in a wall of stdout — reported as
 * "different output", buried among every other line that also differed. The
 * exit code is the one number the reader wants and it was not being read.
 *
 * ⚠️ IT NEVER GUESSES. Unrecognised shape ⇒ `passed: null`, and `null` here
 * means "this result does not say", never "it did not pass". A confidently
 * wrong `false` in a debugging view is worse than an absent field — `report.mjs`
 * makes the same argument for omitting `lines` rather than reporting zero.
 *
 * Two shapes, because there are two renderers:
 *   · `formatRunForModel` / `formatProgramRunForModel` emit a human line —
 *     `exit code: 1 (3.2s) — FAILED`. Both files, verified, emit it identically.
 *   · `evaluate` and the JSON default emit the result object itself, which is
 *     structured and needs no parsing at all.
 */
function readOutcome(text) {
  const none = { passed: null, exitCode: null, timedOut: false };
  if (typeof text !== 'string' || text === '') return none;

  // The structured shape first — reading data beats parsing a rendering.
  if (text.startsWith('{')) {
    try {
      const value = JSON.parse(text);
      if (isPlainObject(value) && ('exitCode' in value || 'passed' in value)) {
        return {
          passed: typeof value.passed === 'boolean' ? value.passed : (typeof value.exitCode === 'number' ? value.exitCode === 0 : null),
          exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
          timedOut: value.timedOut === true,
        };
      }
    } catch { /* not the structured shape; fall through to the rendered one */ }
  }

  if (/^TIMED OUT after /m.test(text)) return { passed: false, exitCode: null, timedOut: true };

  const line = /^exit code: (-?\d+) \([0-9.]+s\)(?: — (PASSED|FAILED))?$/m.exec(text);
  if (!line) return none;
  return {
    exitCode: Number(line[1]),
    passed: line[2] ? line[2] === 'PASSED' : Number(line[1]) === 0,
    timedOut: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE AUDIT LINE — the half of the story the session record does not hold
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Pull the run-level verdict out of one `audit.mjs` JSONL record.
 *
 * ⭐ THE SESSION RECORD AND THE AUDIT LINE ANSWER DIFFERENT QUESTIONS, which is
 * why replaying is better with both. The session holds WHAT HAPPENED, turn by
 * turn. The audit holds WHETHER IT WAS ACCEPTABLE — the declared criterion, the
 * verdict against it, the model chain that actually answered, the money. A
 * timeline that ends "stopped: no-tool-calls" and cannot say the declared
 * `npm test` was never satisfied is describing a success that was not one, and
 * `report.mjs` already documents that exact failure happening in production.
 *
 * @param {unknown} record one parsed line from `.acuvo/audit/YYYY-MM-DD.jsonl`
 * @returns {{ ok: true, at: string|null, acceptance: any, refusals: any[], changes: any[], verification: any, costUsd: number|null, tokens: number|null, model: any, stoppedBecause: string|null }
 *        | { ok: false, error: string }}
 */
export function auditContext(record) {
  if (!isPlainObject(record)) {
    return { ok: false, error: 'that is not an audit record — pass one parsed line from .acuvo/audit/<date>.jsonl' };
  }
  if (record.v !== SUPPORTED_AUDIT_VERSION) {
    return {
      ok: false,
      error: `audit record schema v${record.v} cannot be read by this build, which understands v${SUPPORTED_AUDIT_VERSION}. The timeline is still readable without it.`,
    };
  }
  if (!isPlainObject(record.run)) {
    return { ok: false, error: 'this audit record has no `run` block, so there is nothing in it to attach to a timeline' };
  }
  const run = redactDeep(record.run);
  return {
    ok: true,
    at: typeof record.at === 'string' ? record.at : null,
    acceptance: isPlainObject(run.acceptance) ? run.acceptance : null,
    refusals: Array.isArray(run.refusals) ? run.refusals : [],
    changes: Array.isArray(run.changes) ? run.changes : [],
    verification: isPlainObject(run.verification) ? run.verification : null,
    costUsd: typeof run.costUsd === 'number' ? run.costUsd : null,
    tokens: typeof run.tokens === 'number' ? run.tokens : null,
    model: isPlainObject(run.model) ? run.model : null,
    stoppedBecause: typeof run.stoppedBecause === 'string' ? run.stoppedBecause : null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE REPLAY
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {object} ReplayStep
 * @property {number} n      index into `steps` — stable, and what a diff quotes
 * @property {number} round  0 for the prologue, then 1..N, one per assistant turn
 * @property {'system'|'task'|'note'|'gap'|'reasoning'|'call'|'result'|'verdict'} kind
 */

/**
 * Turn a saved session record into an ordered, inert timeline.
 *
 * ⚠️ NOTHING HERE RUNS ANYTHING. See the header. `executed: false` is in the
 * returned object so a caller can ASSERT the property rather than trust this
 * comment — `resumeMessages` carries `replayed: false` for the same reason.
 *
 * @param {unknown} record a record from `loadSession(root, id).session`
 * @param {{ onStep?: (step: ReplayStep) => void, audit?: unknown, maxText?: number }} [opts]
 * @returns {{ ok: true, [k: string]: any } | { ok: false, error: string }}
 */
export function replaySession(record, opts = {}) {
  const { onStep = null, audit = undefined, maxText = MAX_STEP_TEXT } = opts ?? {};
  const warnings = [];

  /* ── identity: strict ─────────────────────────────────────────────────── */
  if (!isPlainObject(record)) {
    const what = record === null ? 'null' : Array.isArray(record) ? 'an array' : typeof record;
    return {
      ok: false,
      error: `there is no run to replay here — got ${what} where a saved session record was expected. `
        + 'Load one first: `loadSession(root, id).session`, or list what exists with `acuvo --sessions`.',
    };
  }
  if (record.version !== SUPPORTED_SESSION_VERSION) {
    return {
      ok: false,
      error: `this record is session format v${record.version}, and this build reads v${SUPPORTED_SESSION_VERSION}. `
        + 'It was written by a different version of Acuvo Code — the file is harmless where it is, but nothing here can honestly describe it.',
    };
  }
  if (!Array.isArray(record.messages)) {
    return {
      ok: false,
      error: 'this record has no `messages` array, so there is no conversation to step through. '
        + 'A run that died before its first round is saved and listable but holds no transcript.',
    };
  }

  /* ── secondary: tolerant, and the repair is said out loud ──────────────── */
  const files = Array.isArray(record.files) ? redactDeep(record.files) : (warnings.push('this record has no `files` list — it was hand-edited or written by an older build; the transcript below is unaffected'), []);
  const commands = Array.isArray(record.commands) ? redactDeep(record.commands) : (warnings.push('this record has no `commands` list — it was hand-edited or written by an older build; the transcript below is unaffected'), []);
  if (!isPlainObject(record.usage)) warnings.push('this record has no `usage` block, so the cost of this run is unknown — not zero');
  if (record.verification !== null && !isPlainObject(record.verification)) {
    warnings.push('this record has no `verification` block, so whether anything was proven is unknown — not "no"');
  }

  /* ── the audit line, if one was handed in ──────────────────────────────── */
  let auditInfo = null;
  if (audit !== undefined && audit !== null) {
    const ctx = auditContext(audit);
    if (ctx.ok) auditInfo = ctx;
    else warnings.push(`the audit line handed in could not be read (${ctx.error}) — the timeline below is from the session record alone`);
  }

  /* ── walk ─────────────────────────────────────────────────────────────── */
  const steps = [];
  const messages = record.messages;
  const push = (step) => {
    step.n = steps.length;
    steps.push(step);
    return step;
  };

  let i = 0;
  while (i < messages.length && messages[i]?.role === 'system') {
    const s = scrub(messages[i].content, maxText);
    push({ kind: 'system', round: 0, text: s.text, chars: s.chars });
    i += 1;
  }
  if (i < messages.length && messages[i]?.role === 'user') {
    const s = scrub(messages[i].content, maxText);
    push({ kind: 'task', round: 0, text: s.text, chars: s.chars });
    i += 1;
  }

  /**
   * ⚠️ THE HOLES GO IN BEFORE THE BODY, WHERE THE HOLE ACTUALLY IS.
   * `sanitizeMessages` drops the OLDEST droppable groups to fit the size cap
   * and injects its own note at exactly this position; a replay that mentioned
   * the gap in a footer would put the marker somewhere the run never was. A
   * reader scanning a timeline top to bottom has to meet the hole in order or
   * they will reason across it — the same failure the note in `session.mjs`
   * exists to prevent, one layer up.
   */
  const droppedGroups = Number.isInteger(record.droppedGroups) ? record.droppedGroups : 0;
  const droppedIncomplete = Number.isInteger(record.droppedIncomplete) ? record.droppedIncomplete : 0;
  if (droppedGroups > 0) {
    push({
      kind: 'gap',
      round: 0,
      reason: 'size',
      count: droppedGroups,
      text: `${droppedGroups} earlier round${droppedGroups === 1 ? '' : 's'} of this run were dropped when it was saved, to fit the record size limit. `
        + 'Their work may be on disk; it is not in this transcript.',
    });
  }
  if (droppedIncomplete > 0) {
    push({
      kind: 'gap',
      round: 0,
      reason: 'incomplete',
      count: droppedIncomplete,
      text: `${droppedIncomplete} incomplete round${droppedIncomplete === 1 ? '' : 's'} were dropped when this run was saved — `
        + 'a tool call that nothing ever answered, which is a PENDING action rather than a record of one.',
    });
  }

  /**
   * ⭐ THE CALL INDEX IS BUILT AS WE GO, NOT UP FRONT, and that is what lets an
   * orphan be spotted. A tool reply whose `tool_call_id` no preceding assistant
   * message declared is not a result of this conversation — it is damage. It is
   * kept (deleting evidence from a debugging view is the wrong instinct) and
   * FLAGGED, so nobody reads it as the answer to the call above it.
   */
  const callsById = new Map();
  let round = 0;
  let orphans = 0;

  for (; i < messages.length; i += 1) {
    const m = messages[i];
    const role = m?.role;

    if (role === 'assistant') {
      round += 1;
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const body = scrub(m.content, maxText);
      const isLast = i === messages.length - 1;

      if (body.chars > 0) {
        // ⭐ The FINAL assistant message with no calls is the ANSWER, and it is
        // a different thing from a mid-run thought. Collapsing the two makes a
        // timeline where the conclusion looks like one more deliberation.
        const kind = isLast && calls.length === 0 ? 'verdict' : 'reasoning';
        push({ kind, round, text: body.text, chars: body.chars });
      }

      for (const c of calls) {
        const tool = typeof c?.function?.name === 'string' ? c.function.name : 'unknown';
        const raw = typeof c?.function?.arguments === 'string' ? c.function.arguments : '';
        let parsed = null;
        let argsParsed = false;
        try {
          const value = JSON.parse(raw === '' ? '{}' : raw);
          if (isPlainObject(value)) { parsed = redactDeep(value); argsParsed = true; }
        } catch { /* an unparseable call is a fact about the run, not a crash */ }

        const rawScrub = scrub(raw, maxText);
        push({
          kind: 'call',
          round,
          tool,
          callId: typeof c?.id === 'string' ? c.id : null,
          args: parsed,
          argsParsed,
          argsRaw: rawScrub.text,
          chars: rawScrub.chars,
          // `session.mjs` replaces the arguments of a credential-touching call
          // with `{"withheld":true}`. Surface that as a fact rather than
          // rendering a mysterious one-key object.
          withheld: parsed?.withheld === true,
          paths: pathsOf(parsed),
          writes: WRITING_TOOLS.has(tool),
          runs: RUNNING_TOOLS.has(tool),
        });
        if (typeof c?.id === 'string') callsById.set(c.id, steps[steps.length - 1]);
      }
      continue;
    }

    if (role === 'tool') {
      const callId = typeof m?.tool_call_id === 'string' ? m.tool_call_id : null;
      const paired = callId ? callsById.get(callId) : undefined;
      const tool = typeof m?.name === 'string' && m.name
        ? m.name
        // Older records did not carry `name` on the reply; the call it answers does.
        : (paired?.tool ?? 'unknown');
      const body = scrub(m.content, maxText);
      const refusalText = readRefusal(body.text, tool === 'unknown' ? null : tool);
      const orphan = paired === undefined;
      if (orphan) orphans += 1;
      // ⚠️ Read from the FULL text, not the clamped one — the exit-code line is
      // near the top, but a long stdout ahead of it would push a `TIMED OUT`
      // marker past the clamp and turn a killed command into "does not say".
      const outcome = refusalText === null ? readOutcome(normalizeText(m?.content)) : { passed: false, exitCode: null, timedOut: false };

      push({
        kind: 'result',
        round: paired ? paired.round : round,
        tool,
        callId,
        // ⭐ `ok` IS ABOUT THE TOOL. `passed` IS ABOUT THE COMMAND. Keeping them
        // apart is `command.mjs`'s rule and this whole file inherits it.
        ok: refusalText === null,
        refusal: refusalText !== null,
        error: refusalText,
        passed: outcome.passed,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        text: body.text,
        chars: body.chars,
        orphan,
        writes: WRITING_TOOLS.has(tool),
        runs: RUNNING_TOOLS.has(tool),
      });
      continue;
    }

    // A `user` message after the opening one: an interactive follow-up, or the
    // marker `sanitizeMessages` injects where it removed rounds.
    const body = scrub(m?.content, maxText);
    push({ kind: 'note', round, role: role ?? 'unknown', text: body.text, chars: body.chars });
  }

  if (orphans > 0) {
    warnings.push(
      `${orphans} tool result${orphans === 1 ? '' : 's'} in this record answer a call that is not in the transcript (orphan). `
      + 'The record is damaged or was edited; those results are shown but are not attributed to any call.',
    );
  }

  const roundsRecorded = Number.isInteger(record.roundsUsed) ? record.roundsUsed : null;
  if (roundsRecorded !== null && roundsRecorded !== round) {
    /**
     * ⚠️⭐ MEASURED ON A REAL RUN, and it is not an error — it is the normal
     * shape. `stoppedBecause: 'no-tool-calls'` means the loop ended on an
     * assistant message that the saved `messages` array does not always carry,
     * so the record counts one more round than the transcript shows. Saying so
     * is the difference between a replay and a replay you can trust: without
     * this line, the final answer is simply missing and nothing says why.
     */
    warnings.push(
      `the transcript holds ${round} round${round === 1 ? '' : 's'} but the record counts ${roundsRecorded}. `
      + (roundsRecorded > round
        ? "The run's final answer was not saved with the conversation — the timeline ends one step before the run did."
        : 'The record undercounts its own transcript, which means it was edited.'),
    );
  }

  for (const s of steps) if (onStep) onStep(s);

  const counts = {
    calls: steps.filter((s) => s.kind === 'call').length,
    results: steps.filter((s) => s.kind === 'result').length,
    refusals: steps.filter((s) => s.kind === 'result' && s.refusal).length,
    writes: steps.filter((s) => s.kind === 'call' && s.writes).length,
    runs: steps.filter((s) => s.kind === 'call' && s.runs).length,
    reasoning: steps.filter((s) => s.kind === 'reasoning').length,
    orphans,
  };

  const taskStep = steps.find((s) => s.kind === 'task');
  return {
    ok: true,
    formatVersion: REPLAY_FORMAT_VERSION,
    /**
     * ⭐ THE PROPERTY, IN THE DATA. A caller — or a test — can assert on this
     * rather than on a promise made in a comment.
     */
    executed: false,
    id: typeof record.id === 'string' ? record.id : null,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : null,
    root: typeof record.root === 'string' ? record.root : null,
    task: scrub(record.task ?? taskStep?.text ?? '', maxText).text,
    model: typeof record.model === 'string' ? record.model : (auditInfo?.model?.answered ?? null),
    rounds: round,
    roundsRecorded,
    steps,
    counts,
    warnings,
    outcome: {
      stoppedBecause: typeof record.stoppedBecause === 'string' ? record.stoppedBecause : null,
      error: record.error ? scrub(record.error, maxText).text : null,
      resumable: record.resumable === true,
      truncated: record.truncated === true,
      verification: isPlainObject(record.verification) ? record.verification : (auditInfo?.verification ?? null),
      files,
      commands,
      costUsd: typeof record.usage?.cost === 'number' ? record.usage.cost : (auditInfo?.costUsd ?? null),
      tokens: typeof record.usage?.total_tokens === 'number' ? record.usage.total_tokens : (auditInfo?.tokens ?? null),
      // Audit-sourced. The transcript's own refusals are `filterSteps(steps, 'refusals')`;
      // these two answer different questions and must not be merged into one number.
      acceptance: auditInfo?.acceptance ?? null,
      refusals: auditInfo?.refusals ?? [],
      modelChain: auditInfo?.model?.chain ?? null,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE FILTERS — the question you actually have
 * ──────────────────────────────────────────────────────────────────────────── */

const FILTERS = ['all', 'refusals', 'writes', 'runs', 'effects', 'reasoning'];

/**
 * Narrow a timeline to one question.
 *
 * ⭐ A FILTERED CALL BRINGS ITS RESULT, AND A FILTERED RESULT BRINGS ITS CALL.
 * This is the whole difference between a filter and a grep. "Show me the
 * refusals" and getting `run_command failed: refused — not on the allowlist`
 * with no sight of the command that was refused is a worse answer than the
 * unfiltered log, because it looks complete.
 *
 * ⚠️ AN UNKNOWN FILTER THROWS. The alternative is returning `[]`, which reads
 * exactly like "this run had no refusals" — a typo becoming a clean bill of
 * health is the failure mode this whole package keeps being bitten by.
 *
 * @param {ReplayStep[]} steps
 * @param {'all'|'refusals'|'writes'|'runs'|'effects'|'reasoning'|{file: string}} [spec]
 * @returns {ReplayStep[]}
 */
export function filterSteps(steps, spec = 'all') {
  if (!Array.isArray(steps)) return [];

  if (isPlainObject(spec)) {
    if (typeof spec.file !== 'string' || spec.file === '') {
      throw new Error('filterSteps({ file }) needs a path — for example { file: "lib/turn.mjs" }');
    }
    const want = normalizePath(spec.file);
    const wantedIds = new Set();
    const keep = new Set();
    for (const s of steps) {
      if (s.kind !== 'call') continue;
      if (!s.paths?.includes(want)) continue;
      keep.add(s.n);
      if (s.callId) wantedIds.add(s.callId);
    }
    for (const s of steps) {
      if (s.kind === 'result' && s.callId && wantedIds.has(s.callId)) keep.add(s.n);
    }
    return steps.filter((s) => keep.has(s.n));
  }

  if (spec === 'all') return steps.slice();
  if (spec === 'reasoning') return steps.filter((s) => s.kind === 'reasoning' || s.kind === 'verdict');

  if (!FILTERS.includes(spec)) {
    throw new Error(`"${spec}" is not a replay filter. The ones that exist are: ${FILTERS.join(', ')}, or { file: "<path>" }.`);
  }

  const wantsCall = (s) => {
    if (spec === 'writes') return s.writes === true;
    if (spec === 'runs') return s.runs === true;
    if (spec === 'effects') return s.writes === true || s.runs === true;
    return false;
  };

  const keep = new Set();
  const wantedIds = new Set();

  if (spec === 'refusals') {
    for (const s of steps) {
      if (s.kind === 'result' && s.refusal) { keep.add(s.n); if (s.callId) wantedIds.add(s.callId); }
    }
    for (const s of steps) if (s.kind === 'call' && s.callId && wantedIds.has(s.callId)) keep.add(s.n);
    return steps.filter((s) => keep.has(s.n));
  }

  for (const s of steps) {
    if (s.kind !== 'call' || !wantsCall(s)) continue;
    keep.add(s.n);
    if (s.callId) wantedIds.add(s.callId);
  }
  for (const s of steps) if (s.kind === 'result' && s.callId && wantedIds.has(s.callId)) keep.add(s.n);
  return steps.filter((s) => keep.has(s.n));
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE DIFF — "it passed once and failed once. where did they split?"
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️⭐ THE KEY IS THE ACTION, NOT THE PROSE.
 *
 * Two runs of one task never word a thought identically — that is what a
 * sampled model IS. If the alignment keyed on text, every comparison would
 * "diverge" at the first sentence and the feature would be worth nothing. So
 * the alignment key is the SHAPE of the step (which tool, in which direction),
 * and prose differences are reported as differences without being called a
 * divergence.
 */
function alignKey(step) {
  if (step.kind === 'call') return `call:${step.tool}`;
  if (step.kind === 'result') return `result:${step.tool}`;
  return step.kind;
}

const isAction = (step) => step.kind === 'call' || step.kind === 'result';

/**
 * Longest common subsequence over alignment keys. Small inputs by construction;
 * see MAX_ALIGNED_STEPS for the guard.
 */
function alignSteps(a, b) {
  const n = a.length;
  const m = b.length;
  const ka = a.map(alignKey);
  const kb = b.map(alignKey);
  const table = [];
  for (let i = 0; i <= n; i += 1) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = ka[i] === kb[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { pairs.push([a[i], b[j]]); i += 1; j += 1; continue; }
    // ⚠️ THE TIE GOES TO "A DID SOMETHING EXTRA". It has to go somewhere, and
    // reporting the left run's extra step first keeps the rows in the order a
    // reader scans them: what A did, then what B did instead.
    if (table[i + 1][j] >= table[i][j + 1]) { pairs.push([a[i], null]); i += 1; }
    else { pairs.push([null, b[j]]); j += 1; }
  }
  while (i < n) { pairs.push([a[i], null]); i += 1; }
  while (j < m) { pairs.push([null, b[j]]); j += 1; }
  return pairs;
}

/** Positional fallback for pathological records — see MAX_ALIGNED_STEPS. */
function alignPositional(a, b) {
  const pairs = [];
  for (let k = 0; k < Math.max(a.length, b.length); k += 1) pairs.push([a[k] ?? null, b[k] ?? null]);
  return pairs;
}

/** What, if anything, is different about an aligned pair? */
function compare(a, b) {
  if (a.kind === 'call') {
    if (a.argsRaw !== b.argsRaw) {
      return { changed: true, prose: false, why: 'the same tool, called with different arguments' };
    }
    return { changed: false, prose: false, why: null };
  }
  if (a.kind === 'result') {
    if (a.refusal !== b.refusal) {
      const refused = a.refusal ? 'the first' : 'the second';
      return { changed: true, prose: false, why: `the same call came back differently — ${refused} run was refused and the other was not` };
    }
    /**
     * ⭐⭐ THE LINE THE WHOLE FEATURE IS FOR. Same command, same arguments, one
     * green and one red — and because `ok` is true on both sides (the tool
     * worked; the command did not) nothing above this catches it. Reported as
     * its own sentence rather than folded into "different output", where it
     * would sit indistinguishable among a hundred differing stdout lines.
     *
     * ⚠️ `null` IS NOT A VALUE HERE. A result whose shape does not state an
     * outcome must not be compared against one that does — that is how "we
     * could not tell" becomes "it failed".
     */
    if (a.passed !== null && b.passed !== null && a.passed !== b.passed) {
      const green = a.passed ? 'first' : 'second';
      const red = a.passed ? 'second' : 'first';
      const codes = `exit ${a.exitCode ?? '?'} vs exit ${b.exitCode ?? '?'}`;
      return { changed: true, prose: false, why: `the same command PASSED in the ${green} run and FAILED in the ${red} (${codes})` };
    }
    if (a.timedOut !== b.timedOut) {
      return { changed: true, prose: false, why: `the same command timed out in the ${a.timedOut ? 'first' : 'second'} run and not in the other` };
    }
    /**
     * ⚠️ NO `a.ok !== b.ok` CHECK, AND ITS ABSENCE IS DELIBERATE. `ok` is
     * defined as the complement of `refusal` one function above, so that branch
     * could never be reached — it would be a line that looks like a safety net
     * and catches nothing, which is the defect this codebase has shipped
     * before. Caught here by a mutation test that stayed green.
     */
    if (a.text !== b.text) return { changed: true, prose: false, why: 'the same call returned different output' };
    return { changed: false, prose: false, why: null };
  }
  if (a.text !== b.text) return { changed: true, prose: true, why: 'different wording, same shape' };
  return { changed: false, prose: false, why: null };
}

/** Accept a raw record or an already-built replay. */
function asReplay(value, side) {
  if (isPlainObject(value) && value.ok === true && Array.isArray(value.steps)) return value;
  const r = replaySession(value);
  if (r.ok) return r;
  return { ok: false, error: `the ${side} run could not be replayed: ${r.error}` };
}

/**
 * Compare two runs and answer the one question worth asking: where did they
 * stop doing the same thing?
 *
 * @param {unknown} runA a session record, or the result of `replaySession`
 * @param {unknown} runB likewise
 * @returns {{ ok: true, [k: string]: any } | { ok: false, error: string }}
 */
export function diffRuns(runA, runB) {
  const a = asReplay(runA, 'first');
  if (!a.ok) return a;
  const b = asReplay(runB, 'second');
  if (!b.ok) return b;

  const degraded = a.steps.length > MAX_ALIGNED_STEPS || b.steps.length > MAX_ALIGNED_STEPS;
  const pairs = degraded ? alignPositional(a.steps, b.steps) : alignSteps(a.steps, b.steps);

  const rows = [];
  const summary = { same: 0, changed: 0, onlyA: 0, onlyB: 0 };
  let proseDiffers = false;

  for (const [sa, sb] of pairs) {
    if (sa && sb) {
      const c = compare(sa, sb);
      if (!c.changed) { rows.push({ kind: 'same', a: sa, b: sb, prose: false, why: null }); summary.same += 1; continue; }
      if (c.prose) proseDiffers = true;
      rows.push({ kind: 'changed', a: sa, b: sb, prose: c.prose, why: c.why });
      summary.changed += 1;
      continue;
    }
    if (sa) { rows.push({ kind: 'only-a', a: sa, b: null, prose: !isAction(sa), why: 'only the first run did this' }); summary.onlyA += 1; continue; }
    rows.push({ kind: 'only-b', a: null, b: sb, prose: !isAction(sb), why: 'only the second run did this' }); summary.onlyB += 1;
  }

  /**
   * ⚠️ DIVERGENCE IS COMPUTED OVER ACTIONS ONLY. See `alignKey`. A prose-only
   * difference sets `proseDiffers` and nothing else — it is real, it is
   * reported, and it is not the answer to "where did they split".
   */
  let divergedAt = null;
  let divergence = null;
  for (let k = 0; k < rows.length; k += 1) {
    const row = rows[k];
    if (row.kind === 'same') continue;
    const actionA = row.a && isAction(row.a);
    const actionB = row.b && isAction(row.b);
    if (!actionA && !actionB) continue;

    divergedAt = k;
    let stepA = row.a;
    let stepB = row.b;
    /**
     * ⭐ A ONE-SIDED ROW IS HALF AN ANSWER. "A called edit_file" is only useful
     * next to "and B called write_file instead", so the opposite side is taken
     * from the nearest following row that supplies it. Without this the most
     * common divergence — two runs choosing different tools — reports one tool
     * and a null.
     */
    if (row.kind === 'only-a') {
      for (let p = k + 1; p < rows.length; p += 1) {
        if (rows[p].kind === 'only-b' && rows[p].b && isAction(rows[p].b)) { stepB = rows[p].b; break; }
        if (rows[p].kind === 'same') break;
      }
    } else if (row.kind === 'only-b') {
      for (let p = k + 1; p < rows.length; p += 1) {
        if (rows[p].kind === 'only-a' && rows[p].a && isAction(rows[p].a)) { stepA = rows[p].a; break; }
        if (rows[p].kind === 'same') break;
      }
    }
    divergence = {
      row: k,
      round: stepA?.round ?? stepB?.round ?? null,
      a: stepA,
      b: stepB,
      why: row.why ?? 'the two runs took different actions here',
    };
    break;
  }

  return {
    ok: true,
    formatVersion: REPLAY_FORMAT_VERSION,
    executed: false,
    degraded,
    sameTask: a.task === b.task,
    a: { id: a.id, task: a.task, model: a.model, rounds: a.rounds, stoppedBecause: a.outcome.stoppedBecause, costUsd: a.outcome.costUsd },
    b: { id: b.id, task: b.task, model: b.model, rounds: b.rounds, stoppedBecause: b.outcome.stoppedBecause, costUsd: b.outcome.costUsd },
    rows,
    summary,
    proseDiffers,
    divergedAt,
    divergence,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * RENDERING
 * ──────────────────────────────────────────────────────────────────────────── */

const IDENTITY = (t) => t;
const painter = (paint) => ({
  dim: paint?.dim ?? IDENTITY,
  bold: paint?.bold ?? IDENTITY,
  gold: paint?.gold ?? IDENTITY,
  green: paint?.green ?? IDENTITY,
  red: paint?.red ?? IDENTITY,
  cyan: paint?.cyan ?? IDENTITY,
});

/**
 * Show at most `max` characters, and be honest about the rest.
 *
 * ⚠️ THE HIDDEN COUNT IS AGAINST `chars` — the length BEFORE the data-layer
 * clamp — not against what reached this function. See MAX_STEP_TEXT.
 */
function show(step, max) {
  const text = String(step.text ?? '');
  const total = Number.isInteger(step.chars) ? step.chars : text.length;
  /**
   * ⚠️ TRIMMED FOR DISPLAY ONLY, AND `chars` IS UNTOUCHED. Models end almost
   * every message with a blank line or two; rendered verbatim they put a hole
   * between every thought and the call it introduced. Trimming in the DATA
   * would make the reported character count disagree with the record, which is
   * the one thing a replay may never do.
   */
  if (total <= max) return text.replace(/\s+$/, '');
  return `${text.slice(0, max).replace(/\s+$/, '')}… [+${total - max} chars]`;
}

/** Indent every line of a block, so a multi-line thought stays inside its row. */
function indent(text, pad) {
  return String(text).split('\n').map((line) => `${pad}${line}`).join('\n');
}

/** A one-line rendering of a call's arguments. */
function argsLine(step) {
  if (step.withheld) return '[withheld: this call touched a credential file]';
  if (!step.argsParsed) return `unparseable arguments: ${step.argsRaw.slice(0, 160)}`;
  const parts = [];
  for (const [k, v] of Object.entries(step.args ?? {})) {
    const value = typeof v === 'string'
      ? (v.length > 60 ? `${JSON.stringify(v.slice(0, 60))}… (${v.length} chars)` : JSON.stringify(v))
      : JSON.stringify(v);
    parts.push(`${k}=${value}`);
  }
  return parts.join('  ') || '(no arguments)';
}

/**
 * Render a run as a readable timeline.
 *
 * ⚠️ THE "NOTHING WAS RE-RUN" LINE IS IN THE HEADER, NOT THE FOOTER. Someone
 * reading a timeline of a run that deleted their files needs to know it is a
 * recording BEFORE they read the deletions, not after.
 *
 * @param {any} replay the object `replaySession` returned
 * @param {{ paint?: any, maxText?: number, filter?: any }} [opts]
 * @returns {string}
 */
export function formatTimeline(replay, opts = {}) {
  const p = painter(opts.paint);
  const max = opts.maxText ?? MAX_RENDER_TEXT;

  if (!isPlainObject(replay)) return 'nothing to replay — formatTimeline() needs the object replaySession() returned.\n';
  if (replay.ok !== true) return `${p.red('cannot replay this run')}\n  ${String(replay.error ?? 'no reason given')}\n`;

  const out = [];
  const money = typeof replay.outcome.costUsd === 'number' ? ` · $${replay.outcome.costUsd.toFixed(6)}` : '';
  out.push('');
  out.push(`${p.bold('run')} ${replay.id ?? '(no id)'} · ${replay.model ?? 'unknown model'} · ${replay.rounds} round${replay.rounds === 1 ? '' : 's'}${money}`);
  if (replay.task) out.push(`${p.dim('task')} ${show({ text: replay.task, chars: replay.task.length }, 160)}`);
  if (replay.root) out.push(`${p.dim('root')} ${replay.root}`);
  out.push(p.gold('⚠ REPLAY — nothing here was re-run. Every line below is what happened then.'));
  for (const w of replay.warnings) out.push(`${p.red('⚠')} ${w}`);
  out.push('');

  const steps = opts.filter === undefined ? replay.steps : filterSteps(replay.steps, opts.filter);
  if (steps.length === 0) {
    out.push('  nothing was recorded for this run — it stopped before any of the conversation was saved.');
    out.push(`  it ended: ${replay.outcome.stoppedBecause ?? 'unknown'}`);
    out.push('');
    return out.join('\n');
  }

  let shown = -1;
  for (const s of steps) {
    if (s.round !== shown && s.round > 0) {
      shown = s.round;
      out.push(p.dim(`── round ${s.round} ${'─'.repeat(Math.max(4, 46 - String(s.round).length))}`));
    }
    switch (s.kind) {
      case 'system':
        out.push(`  ${p.dim('system  ')} ${p.dim(`${s.chars} characters of instructions`)}`);
        break;
      case 'task':
        out.push(`  ${p.bold('task    ')} ${indent(show(s, max), '           ').trimStart()}`);
        break;
      case 'gap':
        out.push(`  ${p.red('⚠ gap   ')} ${indent(s.text, '           ').trimStart()}`);
        break;
      case 'note':
        out.push(`  ${p.dim('note    ')} ${indent(show(s, max), '           ').trimStart()}`);
        break;
      case 'reasoning':
        out.push(`  ${p.dim('thought ')} ${indent(show(s, max), '           ').trimStart()}`);
        break;
      case 'call':
        out.push(`  ${p.cyan('→ call  ')} ${p.bold(s.tool)}  ${p.dim(argsLine(s))}`);
        break;
      case 'result': {
        /**
         * ⚠️ A GREEN TICK NEXT TO A FAILING TEST IS THE LIE THIS PACKAGE KEEPS
         * FIGHTING. The tool succeeded and the command exited 1: three states,
         * not two, and they get three marks.
         */
        const mark = s.refusal
          ? p.red('✘ refused')
          : s.passed === false
            ? p.red('✘ FAILED ')
            : s.passed === true
              ? p.green('✔ passed ')
              : p.green('✔ result ');
        out.push(
          `  ${mark} ${s.orphan ? p.red('(ORPHAN — answers no call in this transcript) ') : ''}`
          + `${indent(show(s, max), '            ').trimStart()}`,
        );
        break;
      }
      case 'verdict':
        out.push(`  ${p.bold('answer  ')} ${indent(show(s, max), '           ').trimStart()}`);
        break;
      default:
        out.push(`  ${s.kind}: ${show(s, max)}`);
    }
  }

  out.push(p.dim(`── end ${'─'.repeat(44)}`));
  out.push(`  ${p.dim('stopped ')} ${replay.outcome.stoppedBecause ?? 'unknown'}`);
  if (replay.outcome.error) out.push(`  ${p.red('error   ')} ${replay.outcome.error}`);
  const v = replay.outcome.verification;
  if (v) {
    out.push(`  ${p.dim('verified')} ${v.ran ? 'ran' : 'NOTHING RAN'} · ${v.passed === true ? p.green('passed') : p.red('did not pass')} · ${v.command ?? 'no command'}`);
  }
  const acc = replay.outcome.acceptance;
  if (acc) {
    const unmet = (acc.unmet ?? []).map((u) => u?.command).filter(Boolean).join(', ');
    out.push(`  ${p.dim('accepted')} ${acc.verdict ?? 'unknown'}${acc.gating ? ' (gating)' : ''}${unmet ? ` · unmet: ${unmet}` : ''}`);
  }
  out.push(`  ${p.dim('counts  ')} ${replay.counts.calls} calls · ${replay.counts.refusals} refused · ${replay.counts.writes} writes · ${replay.counts.runs} runs`);
  out.push('');
  return out.join('\n');
}

/** One side of a diff row, rendered short. */
function rowLabel(step) {
  if (!step) return '';
  if (step.kind === 'call') return `call ${step.tool}  ${argsLine(step)}`;
  if (step.kind === 'result') {
    const state = step.refusal ? 'refused' : step.passed === false ? 'FAILED' : step.passed === true ? 'passed' : 'result';
    return `${state} ${step.tool}${step.exitCode === null ? '' : ` (exit ${step.exitCode})`}`;
  }
  return step.kind;
}

/**
 * Render a comparison of two runs.
 *
 * ⭐ THE DIVERGENCE IS AT THE TOP. It is the answer; the row list is the
 * working. A reader who has two runs open already knows they differ.
 *
 * @param {any} diff the object `diffRuns` returned
 * @param {{ paint?: any, rows?: number }} [opts]
 * @returns {string}
 */
export function formatDiff(diff, opts = {}) {
  const p = painter(opts.paint);
  if (!isPlainObject(diff)) return 'nothing to compare — formatDiff() needs the object diffRuns() returned.\n';
  if (diff.ok !== true) return `${p.red('cannot compare these runs')}\n  ${String(diff.error ?? 'no reason given')}\n`;

  const out = [''];
  out.push(`${p.bold('diff')} ${diff.a.id ?? '(a)'}  ↔  ${diff.b.id ?? '(b)'}`);
  out.push(diff.sameTask
    ? `${p.dim('task')} the same on both sides`
    : p.red(`⚠ DIFFERENT TASKS — these two runs were not asked the same thing:\n       A: ${diff.a.task}\n       B: ${diff.b.task}`));
  out.push(`${p.dim('   A')} ${diff.a.rounds} rounds · stopped ${diff.a.stoppedBecause ?? 'unknown'}`);
  out.push(`${p.dim('   B')} ${diff.b.rounds} rounds · stopped ${diff.b.stoppedBecause ?? 'unknown'}`);
  if (diff.degraded) out.push(p.red('⚠ these runs are too long to align properly; rows below are compared by position, not by shape'));
  out.push('');

  if (diff.divergence) {
    const d = diff.divergence;
    out.push(p.red(`⚠ DIVERGED at round ${d.round ?? '?'} — ${d.why}`));
    out.push(`    A: ${rowLabel(d.a) || '(nothing)'}`);
    out.push(`    B: ${rowLabel(d.b) || '(nothing)'}`);
  } else {
    out.push(p.green('✔ no divergence — both runs took the same actions, in the same order.'));
    if (diff.proseDiffers) {
      out.push(p.dim('  (the wording differs, which is what a sampled model does and is not a divergence)'));
    }
  }
  out.push('');

  const limit = opts.rows ?? 60;
  let printed = 0;
  for (const row of diff.rows) {
    if (row.kind === 'same') continue;
    if (printed >= limit) { out.push(p.dim(`  … ${diff.rows.length - printed} more rows`)); break; }
    printed += 1;
    const mark = row.kind === 'changed' ? '≠' : row.kind === 'only-a' ? 'A' : 'B';
    const paintRow = row.prose ? p.dim : IDENTITY;
    if (row.kind === 'changed') {
      out.push(paintRow(`  ${mark}  ${rowLabel(row.a)}`));
      out.push(paintRow(`     ${' '.repeat(0)}→  ${rowLabel(row.b)}   ${p.dim(row.why ?? '')}`));
    } else {
      out.push(paintRow(`  ${mark}  ${rowLabel(row.a ?? row.b)}`));
    }
  }

  out.push('');
  out.push(`${p.dim('summary')} ${diff.summary.same} same · ${diff.summary.changed} changed · ${diff.summary.onlyA} only in A · ${diff.summary.onlyB} only in B`);
  out.push('');
  return out.join('\n');
}
