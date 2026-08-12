/**
 * ── ⭐⭐ THE RUN LOG — EVIDENCE, NOT TELEMETRY ───────────────────────────────
 *
 * A regulated buyer cannot adopt an agent that edits their source and then
 * forgets it did. Their question is never "is it good", it is "show me what it
 * did on the fourteenth" — and today the only answer is a terminal scrollback
 * that closed. `--json` gave a script one object per invocation, which is the
 * same fact with the same lifetime: it exists until the pipe ends.
 *
 * ⭐ SO THIS FILE IS `--json` WITH A MEMORY, AND ALMOST NO NEW SHAPE. `toJson()`
 * in `report.mjs` already decided what a run IS — ok, rounds, verification,
 * changes, cost, refusals — and that shape is a stable contract we have already
 * paid for. Re-deriving it here would give us two answers to one question and
 * guarantee they drift. This module wraps it, corrects the one field it gets
 * wrong (see MODEL below), and makes it durable.
 *
 * ── ⚠️ WHAT AN AUDIT LOG IS NOT ─────────────────────────────────────────────
 * It is not a debug log and it must never become one. Every field here is a
 * field someone may one day have to hand to a regulator, which means every
 * field is a field that can leak. The pressure to add "and the model's reply,
 * for debugging" will be constant; the answer is a debug log somewhere else.
 *
 * ── ⚠️⚠️ AND THE FAILURE MODE THAT MATTERS MOST IS SILENCE ──────────────────
 * An audit log that quietly failed to write is worse than no audit log at all,
 * because the buyer believes they have evidence and does not go looking for it
 * until the day they need it. So nothing here throws — every function returns a
 * result — and the caller is expected to WARN when a write fails rather than
 * swallow it. A run must not die because logging did; a log must not fail
 * quietly because the run lived.
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { toJson } from './report.mjs';
import { ensureAcuvoDirIgnored } from './acuvo-dir.mjs';

/** Bump when a field changes meaning. Nobody reading this file in two years
 *  will know which writer produced a line, and guessing is how a compliance
 *  report ends up averaging two different definitions of `cost`. */
export const AUDIT_SCHEMA_VERSION = 1;

export const AUDIT_DIR = '.acuvo/audit';

/**
 * ⚠️ THE TASK IS TRUNCATED, THE HASH IS OF THE WHOLE THING. Someone pasting a
 * 40KB spec into `--task` must not silently get a 40KB line per run — but they
 * also must not be told the record covers the whole task when it holds a page
 * of it. The hash closes that gap: an operator holding the original can prove
 * it is the one this run acted on, without the log ever storing it.
 */
export const MAX_TASK_CHARS = 2_000;
/** One agent round can touch hundreds of files; the record stays a record. */
export const MAX_CHANGES = 200;
/** See `redact` — a bound on the input, not on the output. */
export const MAX_REDACT_CHARS = 20_000;

/**
 * ⚠️ THESE BOUND A LAPTOP'S DISK. THEY ARE NOT A RETENTION POLICY, and must
 * never be described as one to a buyer: a real retention obligation is measured
 * in years and is satisfied by shipping these files OFF the box, not by a CLI
 * deciding when a record stops mattering. Ninety daily files is what keeps a
 * machine running this every day from accumulating forever; an operator with an
 * obligation raises it and syncs the directory somewhere durable.
 */
export const MAX_AUDIT_FILES = 90;
export const MAX_AUDIT_TOTAL_BYTES = 32 * 1024 * 1024;

/* ────────────────────────────────────────────────────────────────────────────
 * SECRETS
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ── ⭐⭐ THE REAL CONTROL IS OMISSION, NOT REDACTION ─────────────────────────
 *
 * The brief is "must never record secrets", and a regex is the weakest possible
 * way to honour it. The strong control is the list of things this record does
 * not have fields for, and it is deliberate every time:
 *
 *   FILE CONTENTS      — never. `describeChange` already reports paths, byte
 *                        counts, line counts and the SHARE of a file replaced,
 *                        with no text. That is enough to answer "what did it
 *                        change" and it cannot leak a `.env` the agent read.
 *   COMMAND OUTPUT     — never. Test output routinely prints connection strings
 *                        and signed URLs on failure. We keep the exit code.
 *   THE MODEL'S PROSE  — never. `toJson` already omits `outcome.note`, and it
 *                        is the field most likely to quote a secret back.
 *   THE ENVIRONMENT    — never. `scrubEnvironment` in `command.mjs` keeps it out
 *                        of child processes; it has no business coming back in
 *                        through the log.
 *
 * ⭐ What is LEFT is exactly what cannot be omitted without destroying the
 * record's purpose: the task the human typed, the command that verified it, and
 * the error strings from refusals. Those three are user-authored or echo
 * user-authored text, so those three get scrubbed — and that is the whole job
 * of the regex below.
 *
 * ── ⚠️ IT IS A DENYLIST, AND THAT IS A CONSCIOUS EXCEPTION ──────────────────
 * Same exception `scrubEnvironment` makes, for the same reason, and it deserves
 * the same honest statement of the guarantee: this catches conventionally
 * shaped credentials. A bare 32-character password with no name in front of it
 * survives, because the pattern that caught it would also redact every git SHA
 * and half the file paths, and a log nobody can read is a log nobody keeps.
 * Treat it as one layer. The layer that actually holds is the omission list.
 *
 * ⭐ AND IT ERRS TOWARDS OVER-REDACTION. `keychain: <six chars>` gets masked.
 * That is the correct direction to be wrong in for a file whose entire promise
 * is that it contains no secrets.
 */
const REDACTIONS = [
  // First, because it is the only multi-line one and the others would shred it.
  [/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, '[redacted:private-key]'],
  [/\b(?:sk|rk)-(?:or-v1-)?[A-Za-z0-9_-]{16,}/g, '[redacted:api-key]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted:github-token]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted:github-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted:aws-key-id]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted:slack-token]'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, '[redacted:google-api-key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted:jwt]'],
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer [redacted]'],
  // `postgres://user:pass@host` — the credential nobody thinks of as a secret
  // because it looks like a URL, and the one most likely to be in a task.
  [/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@'],
  /**
   * The name-then-value rule, last so the specific shapes above win.
   *
   * ⚠️ THE NAME CLASS EXCLUDES `.` ON PURPOSE. With it, `lib/auth.mjs: <text>`
   * matched and the log started masking file references — an audit log that
   * hides which file was touched has redacted the evidence instead of the
   * secret.
   */
  [/\b([A-Za-z0-9_-]*(?:key|token|secret|password|passwd|credential|auth|dsn)[A-Za-z0-9_-]*)(["'\s]*[:=]\s*["']?)([^\s"',;]{6,})/gi,
    (_m, name, sep) => `${name}${sep}[redacted]`],
];

/**
 * Mask conventionally shaped credentials in a string. Pure.
 *
 * ⚠️ THE INPUT IS CAPPED BEFORE THE REGEXES RUN. The private-key pattern is a
 * lazy scan to a terminator that may not exist; handed a megabyte of BEGIN
 * markers it degrades badly, and "the audit writer hung" is a denial of service
 * with an innocent explanation. Nothing that reaches here is legitimately
 * longer than this anyway — the task is truncated to 2,000 characters and
 * refusal errors to 300.
 */
export function redact(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text.length > MAX_REDACT_CHARS ? text.slice(0, MAX_REDACT_CHARS) : text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Redact every string anywhere in a structure. Pure.
 *
 * ⭐ WHY THIS IS RECURSIVE AND NOT A LIST OF FIELDS. A named list — "scrub
 * task, command and refusals" — is a list someone forgets to extend the day
 * they add a field, and the failure is invisible: the log keeps writing, the
 * tests keep passing, and the new field carries the secret. Walking the whole
 * object means a field added by a future `toJson` is scrubbed before anyone
 * remembers this file exists.
 *
 * Keys are left alone: they are literals in our own source, never user text.
 */
export function deepRedact(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v);
    return out;
  }
  return value;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE RECORD
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ── ⚠️⚠️ THE MODEL THAT ANSWERED IS NOT THE MODEL THAT WAS ASKED FOR ────────
 *
 * `chain.mjs` exists because one provider is one outage, and its result says
 * which candidate replied (`model`, `usedFallback`, `chainTried` —
 * `chain.mjs:119-125`). ⚠️ `turn.mjs` throws all three away: the three
 * `rounds.push` calls (lines 824, 834, 894) record note/usage/finishReason and
 * no model, and the session returns `model: config.model` (line 1076) — the
 * REQUESTED one. Grep `lib/` and `bin/` for `reply.model` and there are no hits.
 *
 * So on a day OpenRouter rate-limits, the record would swear the work was done
 * by the model the user configured when a free fallback actually did it. For a
 * buyer whose whole reason for reading this file is "which system processed our
 * code", that is not a cosmetic inaccuracy — it is the log being wrong about
 * the only thing they came to check.
 *
 * ⭐ SO IT REPORTS `null` UNTIL THE LOOP TELLS US. This is `describeChange`'s
 * rule about a confidently wrong zero, applied where it costs something: a
 * script can test for `null`, and it cannot know that a model name is a guess.
 * The one-line fix in `turn.mjs` is in the handoff notes; this function reads
 * it the moment it lands and needs no change when it does.
 */
export function answeringModels(outcome) {
  const seen = [];
  for (const r of outcome?.rounds ?? []) {
    if (typeof r?.model === 'string' && r.model && !seen.includes(r.model)) seen.push(r.model);
  }
  // The session-level field is the other place the fix could land.
  if (seen.length === 0 && typeof outcome?.answeredModel === 'string' && outcome.answeredModel) {
    seen.push(outcome.answeredModel);
  }
  return seen;
}

/** SHA-256, hex. Of the ORIGINAL task — see MAX_TASK_CHARS. */
export function taskFingerprint(task) {
  return createHash('sha256').update(String(task ?? ''), 'utf8').digest('hex');
}

/**
 * Build the record. Pure — `now` and the id are injected, so a test asserts on
 * an exact line instead of on a regex with a timestamp hole in it.
 *
 * @param {any} outcome  the object `runSession` returned
 * @param {{ changes?: any[], task?: string|null, now?: Date|string, id?: string|null }} [opts]
 */
export function auditRecord(outcome, { changes = [], task = null, now = new Date(), id = null } = {}) {
  const at = typeof now === 'string' ? now : now.toISOString();
  const sha = taskFingerprint(task);

  /**
   * Redacted BEFORE truncation. The other order looks equivalent and is not:
   * a key at character 2,050 would be cut off today and survive the first time
   * someone raises the limit, which is the kind of regression that ships
   * because the test still passes.
   */
  const scrubbed = redact(String(task ?? ''));
  const trimmed = scrubbed.length > MAX_TASK_CHARS
    ? `${scrubbed.slice(0, MAX_TASK_CHARS)}…[+${scrubbed.length - MAX_TASK_CHARS} chars]`
    : scrubbed;

  const kept = changes.slice(0, MAX_CHANGES);

  /**
   * ⭐ THE SHAPE IS `toJson`'s, DELIBERATELY AND ENTIRELY. Two documents
   * describing one run must not disagree, and the surest way to make them agree
   * is for one of them to be the other.
   */
  const base = toJson(outcome, { changes: kept, task: trimmed });

  const answered = answeringModels(outcome);
  const run = {
    ...base,
    /**
     * Replaces `toJson`'s scalar `model`, which is the requested one. A record
     * that offered both under one key would be read as one fact.
     */
    model: {
      requested: base.model ?? null,
      // The last one is the one that produced the final state.
      answered: answered.length > 0 ? answered[answered.length - 1] : null,
      chain: answered,
    },
    ...(changes.length > kept.length ? { changesOmitted: changes.length - kept.length } : {}),
  };

  return {
    v: AUDIT_SCHEMA_VERSION,
    // Deterministic: the instant plus the task's fingerprint. Two runs collide
    // only if the same task starts in the same millisecond, and a random suffix
    // would have cost this function its purity for that.
    id: id ?? `${at}-${sha.slice(0, 8)}`,
    at,
    taskSha256: sha,
    /**
     * ⚠️ The wrapper above is exempt from the scrub because none of it comes
     * from the user or the model — it is a version, a clock and two hashes.
     * Everything that does is inside `run`, and all of it goes through the walk.
     */
    run: deepRedact(run),
  };
}

/**
 * One record, one line.
 *
 * ⚠️ NEVER TRUNCATE THE SERIALISED LINE TO FIT A BUDGET. A clipped JSON line is
 * not a smaller record, it is an unparseable one — the run would be logged and
 * simultaneously not exist, which is the worst of both. Every bound in this
 * file is therefore on an INPUT (task chars, change count, refusal length), so
 * the output is bounded by construction and always whole.
 *
 * ⭐ And this is why JSONL is the right format rather than a nicety:
 * `JSON.stringify` escapes control characters, so a task containing newlines
 * cannot break the one-record-per-line invariant the reader depends on.
 */
export function serializeRecord(record) {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Read a log back, tolerantly.
 *
 * ⭐ DAMAGED LINES ARE COUNTED, NOT SWALLOWED. A reader that silently skips
 * what it cannot parse turns "three records were destroyed" into "there were
 * three fewer runs" — and for an audit log that difference is the entire
 * question. The count is itself evidence, so it comes back with the records.
 */
export function parseAuditLog(text) {
  const records = [];
  let damaged = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      damaged += 1;
    }
  }
  return { records, damaged };
}

/* ────────────────────────────────────────────────────────────────────────────
 * DISK
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⭐ ISO DATES SO THE NAMES SORT CHRONOLOGICALLY, and UTC so they do not
 * reorder when the clock moves. Every prune decision below is a string sort;
 * `10-8-2026.jsonl` would make it a lie twice a year.
 */
export function dayFileName(at) {
  const iso = typeof at === 'string' ? at : at.toISOString();
  return `${iso.slice(0, 10)}.jsonl`;
}

/**
 * Decide which files to delete. Pure — the whole reason it is separate.
 *
 * @param {{name: string, bytes: number}[]} files
 * @returns {string[]} names to delete, oldest first
 */
export function planPrune(files, { maxFiles = MAX_AUDIT_FILES, maxTotalBytes = MAX_AUDIT_TOTAL_BYTES } = {}) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  let total = sorted.reduce((n, f) => n + (f.bytes || 0), 0);
  const doomed = [];
  /**
   * ⚠️ `> 1` NOT `> 0` — THE NEWEST FILE IS NEVER DELETED, even if it alone
   * blows the byte budget. It is the file we are appending to right now, so
   * pruning it would destroy the very run being recorded, and a single
   * pathological day would take the log with it every time.
   */
  while (sorted.length > 1 && (sorted.length > maxFiles || total > maxTotalBytes)) {
    const gone = sorted.shift();
    total -= gone.bytes || 0;
    doomed.push(gone.name);
  }
  return doomed;
}

/** What is on disk, in the shape `planPrune` wants. Never throws. */
function listAuditFiles(dir) {
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      out.push({ name, bytes: statSync(join(dir, name)).size });
    } catch {
      // Vanished between the listing and the stat — a parallel run pruned it.
      // Not our problem and not worth failing a write over.
    }
  }
  return out;
}

/**
 * Append one record, then keep the directory bounded.
 *
 * ── ⚠️ WHAT "CRASH-SAFE" HONESTLY MEANS HERE ────────────────────────────────
 * Not that the last write is atomic — it is one `writeSync` loop and a kill
 * between iterations leaves a partial line. The guarantee is the one that
 * matters: **a killed process cannot damage a record that was already written.**
 * Three things buy it, and all three are load-bearing:
 *
 *   1. `flag: 'a'` — O_APPEND. Every write goes to the end. Nothing ever seeks
 *      backwards, so there is no offset at which an earlier line lives that a
 *      later write could land on.
 *   2. ONE `appendFileSync` CALL for line-plus-newline. Two calls double the
 *      window in which a crash separates a record from its terminator, for no
 *      benefit; the newline is part of the buffer, not a follow-up.
 *   3. ⭐ PRUNING DELETES WHOLE FILES AND NEVER REWRITES ONE. This is the rule
 *      that keeps "append-only" and "bounded" from being in tension. The
 *      obvious way to cap a log — read it, drop the oldest lines, write it back
 *      — is a read-modify-write over live evidence, and a crash in the middle
 *      of it loses everything the file held. Rotating by day and unlinking old
 *      days means the bound never touches a byte that is still wanted.
 *
 * A torn tail therefore costs at most the record being written when the machine
 * died, and `parseAuditLog` reports it as damaged rather than hiding it.
 *
 * ⚠️ RETURNS A RESULT, NEVER THROWS — see the file header. The caller warns.
 */
export function appendAudit(root, record, { dir = AUDIT_DIR, maxFiles, maxTotalBytes } = {}) {
  const target = join(root, dir);
  let file;
  try {
    mkdirSync(target, { recursive: true });
    /**
     * ⚠️ THE MOMENT `.acuvo/` COMES INTO EXISTENCE IS THE MOMENT IT MUST STOP
     * DIRTYING THE TREE — and this is one of only two places it happens in a
     * normal run. Found by our own bench: the `git` task did the work correctly,
     * committed exactly the right file, and failed on `left the tree dirty:
     * ?? .acuvo/`.
     *
     * ⭐ HERE RATHER THAN AT STARTUP, deliberately. The first attempt called it
     * once in `bin/acuvo.mjs` and created the directory on every invocation —
     * including `--dry-run`, which promises to touch nothing. This path already
     * respects every opt-out, so hanging the ignore off it inherits all of them.
     */
    ensureAcuvoDirIgnored(root);
    file = join(target, dayFileName(record?.at ?? new Date()));
    appendFileSync(file, serializeRecord(record), { encoding: 'utf8', flag: 'a' });
  } catch (err) {
    return { ok: false, error: `could not write the audit record: ${err?.message ?? err}` };
  }

  /**
   * ⚠️ PRUNE FAILURES DO NOT FAIL THE WRITE. The record is already durable at
   * this point; reporting `ok: false` because a stale file could not be
   * unlinked would make the caller warn about a log that is, in fact, fine.
   */
  const pruned = [];
  for (const name of planPrune(listAuditFiles(target), { maxFiles, maxTotalBytes })) {
    try {
      unlinkSync(join(target, name));
      pruned.push(name);
    } catch {
      // Read-only directory, or another process got there first. Either way the
      // bound is advisory and the evidence is intact, which is the priority.
    }
  }

  return { ok: true, file, pruned };
}

/**
 * The whole job, from an outcome to a line on disk. This is what the CLI calls.
 *
 * @param {{ root: string, outcome: any, changes?: any[], task?: string|null, now?: Date|string }} args
 */
export function recordRun({ root, outcome, changes = [], task = null, now = new Date() }) {
  return appendAudit(root, auditRecord(outcome, { changes, task, now }));
}
