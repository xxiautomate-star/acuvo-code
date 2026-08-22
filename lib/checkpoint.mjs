/**
 * ── ⭐⭐ CHECKPOINT / REWIND — UNDO WHAT THE AGENT DID TO THE FILES ──────────
 *
 * MEASURED 2026-08-14, before this file existed: `grep -rn "checkpoint|rewind|
 * undo|snapshot|restore" lib bin` returned nothing that restores a file. Every
 * hit was something else — `lease-watch.mjs:46` snapshots foreign LEASES,
 * `memory-workspace.mjs:84` snapshots an in-memory Map. So the agent could
 * rewrite twelve files in five rounds and the only way back was git, and only
 * if the tree had been clean when it started.
 *
 * ⭐ THE INSIGHT THAT MAKES THIS CHEAP: every mutation already funnels through
 * TWO functions. `lib/workspace.mjs` `writeFile()` and `deleteFile()` are the
 * only doors — `write_files`, `edit_file` and the media verbs all call them
 * (`lib/write-many.mjs:22-24` says so in as many words). `writeFile` already
 * computes `existed` and `previousBytes` BEFORE writing, because the summary
 * needs them. Reading the previous BYTES at that same point is the whole
 * feature; everything below is bookkeeping around that one read.
 *
 * ── ⚠️⚠️ WHAT MAKES AN UNDO DANGEROUS, AND WHY THIS ONE REFUSES ─────────────
 *
 * A naive undo writes the old content back over whatever is there now. If the
 * USER edited that file after the agent did — the normal case, because you read
 * what it wrote and fixed a line — a blind restore destroys their edit while
 * calling itself a safety feature. So every entry records the sha256 of what
 * the agent LEFT, and `applyRewind` refuses any file whose current contents are
 * not that. `--force` overrides, and says what it is overriding.
 *
 * ⚠️ AND A CHECKPOINT THAT SILENTLY FAILED TO RECORD IS WORSE THAN NONE, for
 * exactly the reason `audit.mjs` gives about a log that quietly failed to
 * write: the operator believes they can undo, and finds out on the one day it
 * matters. So a file too large to store is recorded as an entry that says so
 * (`unrestorable`), `acuvo rewind` prints that count, and nothing here ever
 * pretends a file is recoverable when its bytes were never kept.
 *
 * ⚠️ NOTHING HERE THROWS ON AN EXPECTED FAILURE. A write must not die because
 * the journal could not be appended to — the work is the point, the record is
 * the service. Failures accumulate in `journal.errors` so the caller can WARN,
 * which is the same contract `audit.mjs` set.
 *
 * ── ⭐ WHY THE JOURNAL LIVES IN `.acuvo/` AND IS STILL SAFE ─────────────────
 *
 * The standing rule from the RCE we shipped was "the trust store must not live
 * in the workspace". This does live there — and it is already out of the
 * model's reach, because `agentWriteRefusal` (lib/workspace.mjs:428-433) hard-
 * refuses EVERY agent write under `.acuvo/` with two or more segments, which
 * `.acuvo/checkpoints/journal.jsonl` is. That refusal is load-bearing here for
 * a new reason: an agent that can rewrite its own undo history can hide what it
 * did. `test/checkpoint-agent-cannot-rewrite.test.mjs` pins it.
 *
 * ⭐ AND THE JOURNAL IS APPEND-ONLY. A rewind never edits or truncates it — it
 * appends nothing either. Undoing a rewind is therefore just another rewind to
 * an earlier point, and the record of what happened stays complete.
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { ensureAcuvoDirIgnored } from './acuvo-dir.mjs';
/**
 * ⚠️⚠️ FOUND BY RUNNING THE REAL CLI, NOT BY A UNIT TEST (2026-08-14). The first
 * end-to-end run announced "3 files can be put back" when the user had two:
 * `evaluate` writes its snippet THROUGH the executor
 * (lib/evaluate.mjs:202 `executor.writeFile(rel, source)`) and then removes it
 * with raw `unlinkSync` (lib/evaluate.mjs:246), which this journal never sees.
 * So the checkpoint held a create with no matching delete — an entry for a file
 * that no longer exists, which would have made `acuvo rewind` print a confusing
 * skip line about a scratch file the user never wrote.
 *
 * ⭐ IMPORTED, NEVER RE-TYPED. `evaluate.mjs` owns the shape of its own
 * temporary name; a second copy of that regex here is how the filter ends up
 * matching a name the tool stopped using.
 */
import { SNIPPET_NAME_PATTERN } from './evaluate.mjs';

/** Bump when a field changes meaning — a reader in a year cannot guess. */
export const CHECKPOINT_SCHEMA_VERSION = 1;

export const CHECKPOINT_DIR = '.acuvo/checkpoints';
export const JOURNAL_NAME = 'journal.jsonl';
export const BLOB_DIRNAME = 'blobs';

/**
 * ⚠️ A CEILING ON WHAT IS COPIED, NOT ON WHAT MAY BE WRITTEN. `MAX_WRITE_BYTES`
 * in workspace.mjs bounds the agent; this bounds our copy of the PREVIOUS
 * contents, which is a different file and can be far larger (a checked-in
 * dataset the agent rewrites). Above this the entry is still written, marked
 * `unrestorable`, so the user is told rather than surprised.
 */
export const MAX_CHECKPOINT_BYTES = 4_000_000;

/**
 * Is this the agent's OWN scratch file rather than the user's work?
 *
 * ⚠️ ONLY AT THE WORKSPACE ROOT AND ONLY THE EXACT GENERATED SHAPE, for the
 * same reason `evaluate.mjs`'s own sweeper is that strict: `src/.acuvo-eval-
 * notes.mjs` is somebody's file, and a checkpoint that quietly declines to
 * record a file because its name looked temporary is a checkpoint that loses
 * work.
 *
 * @param {string} relPath
 */
export function isToolScratch(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/');
  if (p.includes('/')) return false;
  return SNIPPET_NAME_PATTERN.test(p);
}

/** @param {Buffer|string} data */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * ⚠️ THE SAME SHAPE AS A SESSION ID (`lib/session.mjs:241`) ON PURPOSE, so an
 * operator reading `acuvo --sessions` and `acuvo rewind` is not learning two
 * id formats for the same run. It is deliberately NOT imported from there:
 * this module must stay loadable without dragging in session serialisation,
 * and the shape is asserted by a test rather than by a shared function.
 *
 * @param {Date} [now]
 */
export function newCheckpointId(now = new Date()) {
  const iso = new Date(now).toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  const salt = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${salt}`;
}

/** One entry, one line. JSONL because it is appended to under concurrency. */
export function serializeEntry(entry) {
  return `${JSON.stringify(entry)}\n`;
}

/**
 * ⭐ PURE. Given the journal text, give back the entries worth trusting.
 *
 * ⚠️ A TORN OR HALF-WRITTEN LINE IS COUNTED, NOT THROWN ON. Seven terminals
 * append to one file; a crash mid-append leaves a partial line, and losing the
 * other six hundred entries over it would be the worst possible reaction.
 *
 * @param {string} text
 * @returns {{ entries: object[], unreadable: number }}
 */
export function parseJournal(text) {
  const entries = [];
  let unreadable = 0;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      unreadable += 1;
      continue;
    }
    // The three fields every later step indexes on. An entry missing one of
    // them cannot be placed in the timeline, and guessing where it goes is how
    // a rewind restores the wrong version.
    if (!parsed || typeof parsed !== 'object'
      || typeof parsed.seq !== 'number' || !Number.isFinite(parsed.seq)
      || typeof parsed.path !== 'string' || parsed.path === ''
      || typeof parsed.runId !== 'string' || parsed.runId === '') {
      unreadable += 1;
      continue;
    }
    entries.push(parsed);
  }
  return { entries, unreadable };
}

/**
 * ⭐ PURE. Fold the entries into one row per run, newest first — what
 * `acuvo rewind` prints when you give it no id.
 *
 * @param {readonly object[]} entries
 */
export function groupRuns(entries) {
  /** @type {Map<string, any>} */
  const byRun = new Map();
  for (const e of entries) {
    let run = byRun.get(e.runId);
    if (!run) {
      run = {
        runId: e.runId, at: e.at ?? null, lastAt: e.at ?? null, firstSeq: e.seq, lastSeq: e.seq,
        paths: new Set(), writes: 0, deletes: 0, unrestorable: 0, task: null,
      };
      byRun.set(e.runId, run);
    }
    run.paths.add(e.path);
    if (e.verb === 'delete') run.deletes += 1; else run.writes += 1;
    if (e.unrestorable) run.unrestorable += 1;
    if (e.seq < run.firstSeq) { run.firstSeq = e.seq; run.at = e.at ?? run.at; }
    if (e.seq > run.lastSeq) { run.lastSeq = e.seq; run.lastAt = e.at ?? run.lastAt; }
    if (!run.task && typeof e.task === 'string' && e.task) run.task = e.task;
  }
  return [...byRun.values()]
    .map((r) => ({
      runId: r.runId,
      at: r.at,
      lastAt: r.lastAt,
      firstSeq: r.firstSeq,
      lastSeq: r.lastSeq,
      files: r.paths.size,
      writes: r.writes,
      deletes: r.deletes,
      unrestorable: r.unrestorable,
      task: r.task,
    }))
    .sort((a, b) => b.firstSeq - a.firstSeq);
}

/**
 * ── ⭐⭐ THE SEMANTICS, STATED ONCE: `rewind <id>` MEANS "PUT THE FILES BACK
 *        THE WAY THEY WERE BEFORE THAT RUN STARTED" ─────────────────────────
 *
 * So it covers that run AND everything after it, not that run alone. Undoing
 * an older run while a newer one sits on top of it would restore a version no
 * moment in time ever had — a "checkpoint" that produces a state that never
 * existed is not a checkpoint. This is why the plan works on `seq >= start`.
 *
 * For each path in that window: the FIRST entry holds the state to go back to,
 * and the LAST entry holds the state the agent left, which is what the current
 * file on disk must still match for a restore to be safe.
 *
 * ⭐ PURE — no disk, no clock. The whole decision is testable from three
 * literal entries, which is why the conflict rule below could be mutated and
 * watched to go red.
 *
 * @param {readonly object[]} entries
 * @param {string} runId
 */
export function planRewind(entries, runId) {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const start = sorted.find((e) => e.runId === runId);
  if (!start) {
    return { ok: false, error: `no checkpoint named "${runId}" — run \`acuvo rewind\` to see the ids that exist` };
  }
  const window = sorted.filter((e) => e.seq >= start.seq);
  /** @type {Map<string, object>} */
  const first = new Map();
  /** @type {Map<string, object>} */
  const last = new Map();
  for (const e of window) {
    if (!first.has(e.path)) first.set(e.path, e);
    last.set(e.path, e);
  }
  const ops = [...first.entries()].map(([path, f]) => {
    const l = last.get(path);
    const wasThere = f.beforeExisted === true;
    const stored = typeof f.beforeBlob === 'string' && f.beforeBlob !== '';
    return {
      path,
      // "restore" puts bytes back; "delete" removes a file the agent CREATED,
      // which is the case a git-based undo gets wrong (an untracked file
      // survives `git checkout .` and looks like it was always yours).
      action: wasThere ? 'restore' : 'delete',
      blob: stored ? f.beforeBlob : null,
      beforeBytes: typeof f.beforeBytes === 'number' ? f.beforeBytes : 0,
      /** What the agent LEFT — the current file must still be this. */
      expectSha: typeof l.afterSha === 'string' ? l.afterSha : null,
      expectExists: l.afterExists !== false,
      restorable: wasThere ? stored : true,
      reason: wasThere && !stored
        ? (typeof f.unrestorable === 'string' && f.unrestorable
          ? f.unrestorable
          : 'its previous contents were never stored')
        : null,
    };
  });
  ops.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, runId, fromSeq: start.seq, at: start.at ?? null, ops };
}

// ── THE EDGES: everything below this line touches a disk ────────────────────

function journalPaths(root, dir) {
  const base = join(String(root ?? ''), dir);
  return { base, journal: join(base, JOURNAL_NAME), blobs: join(base, BLOB_DIRNAME) };
}

function errText(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * ⚠️ A JOURNAL PATH IS TRUSTED ONLY BECAUSE OF WHERE IT CAME FROM — it is the
 * `relative` field `resolveInWorkspace` produced, already proven inside the
 * workspace. This re-checks anyway, because a journal is a FILE and a file can
 * be edited: a hand-written `"path": "../../.ssh/authorized_keys"` must not
 * turn `acuvo rewind` into an arbitrary-write primitive.
 */
function safeJoin(root, relPath) {
  const segments = String(relPath ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '.' || s === '..')) return null;
  if (/^[a-zA-Z]:$/.test(segments[0]) || String(relPath).startsWith('/')) return null;
  return join(root, ...segments);
}

/**
 * Open the journal for one run. Cheap: nothing is created until the first
 * mutation, so a run that writes nothing leaves no directory behind.
 *
 * @param {string} root
 * @param {{ runId?: string, now?: () => Date, dir?: string, maxBytes?: number, task?: string|null }} [opts]
 */
export function openJournal(root, {
  runId = newCheckpointId(), now = () => new Date(), dir = CHECKPOINT_DIR,
  maxBytes = MAX_CHECKPOINT_BYTES, task = null,
} = {}) {
  const paths = journalPaths(root, dir);
  /** @type {string[]} */
  const errors = [];
  let ready = false;
  let seq = 0;
  let recorded = 0;
  let unrestorable = 0;
  const touched = new Set();

  /**
   * ⚠️ THE SEQUENCE CONTINUES THE FILE, it does not restart at 0. `planRewind`
   * compares seq across runs to build the "everything after this point" window;
   * two runs both numbering from 1 would interleave into nonsense.
   */
  const ensure = () => {
    if (ready) return true;
    try {
      ensureAcuvoDirIgnored(root);
      mkdirSync(paths.blobs, { recursive: true });
      if (existsSync(paths.journal)) {
        const { entries } = parseJournal(readFileSync(paths.journal, 'utf8'));
        for (const e of entries) if (e.seq >= seq) seq = e.seq + 1;
      }
      ready = true;
      return true;
    } catch (e) {
      errors.push(`could not open the checkpoint journal: ${errText(e)}`);
      return false;
    }
  };

  return {
    runId,
    dir,
    get recorded() { return recorded; },
    get files() { return touched.size; },
    get unrestorable() { return unrestorable; },
    errors,

    /**
     * Record the state of `path` BEFORE it is changed. Call it immediately
     * before the mutation, never after — there is nothing to read afterwards.
     *
     * @param {{ verb: 'write'|'delete', path: string, absolute: string, after?: string|null }} m
     * @returns {{ ok: boolean, error?: string }}
     */
    record({ verb, path, absolute, after = null }) {
      /**
       * ⚠️ BEFORE `ensure()`, so a run whose only mutation is an `evaluate`
       * snippet still creates no checkpoint directory at all — the scratch file
       * is not work anybody can want back.
       */
      if (isToolScratch(path)) return { ok: true, skipped: 'the tool\'s own scratch file' };
      if (!ensure()) return { ok: false, error: errors[errors.length - 1] };
      const entry = {
        v: CHECKPOINT_SCHEMA_VERSION,
        seq,
        runId,
        at: new Date(now()).toISOString(),
        verb,
        path,
        beforeExisted: false,
        beforeBytes: 0,
        beforeSha: null,
        beforeBlob: null,
        afterExists: verb !== 'delete',
        afterBytes: 0,
        afterSha: null,
        unrestorable: null,
      };
      if (typeof task === 'string' && task) entry.task = task.slice(0, 120);

      try {
        if (existsSync(absolute)) {
          const stat = statSync(absolute);
          entry.beforeExisted = true;
          entry.beforeBytes = stat.size;
          if (stat.size > maxBytes) {
            // ⚠️ SAID OUT LOUD RATHER THAN SKIPPED. The entry still exists so
            // `acuvo rewind` can print "1 file cannot be restored"; dropping it
            // would make the undo look complete when it is not.
            entry.unrestorable = `it was ${stat.size} bytes, over the ${maxBytes}-byte checkpoint limit`;
          } else {
            const raw = readFileSync(absolute);
            const digest = sha256(raw);
            entry.beforeSha = digest;
            // ⭐ CONTENT-ADDRESSED, so rewriting one file ten rounds running
            // costs one copy per distinct version rather than ten.
            const blobFile = join(paths.blobs, digest);
            if (!existsSync(blobFile)) writeFileSync(blobFile, raw);
            entry.beforeBlob = digest;
          }
        }
      } catch (e) {
        entry.unrestorable = `its previous contents could not be read: ${errText(e)}`;
        errors.push(`checkpoint: ${path}: ${errText(e)}`);
      }

      if (verb !== 'delete' && typeof after === 'string') {
        const buf = Buffer.from(after, 'utf8');
        entry.afterBytes = buf.byteLength;
        entry.afterSha = sha256(buf);
      }

      try {
        appendFileSync(paths.journal, serializeEntry(entry), 'utf8');
      } catch (e) {
        errors.push(`checkpoint: could not record ${path}: ${errText(e)}`);
        return { ok: false, error: errText(e) };
      }
      seq += 1;
      recorded += 1;
      touched.add(path);
      if (entry.unrestorable) unrestorable += 1;
      return { ok: true };
    },
  };
}

/**
 * @param {string} root
 * @param {{ dir?: string }} [opts]
 */
export function readJournal(root, { dir = CHECKPOINT_DIR } = {}) {
  const paths = journalPaths(root, dir);
  if (!existsSync(paths.journal)) {
    return { ok: true, entries: [], unreadable: 0, path: paths.journal, empty: true };
  }
  let text;
  try {
    text = readFileSync(paths.journal, 'utf8');
  } catch (e) {
    return { ok: false, entries: [], unreadable: 0, path: paths.journal, error: `could not read ${paths.journal}: ${errText(e)}` };
  }
  const { entries, unreadable } = parseJournal(text);
  return { ok: true, entries, unreadable, path: paths.journal, empty: entries.length === 0 };
}

/**
 * Carry out a plan from `planRewind`.
 *
 * ⚠️ IT SKIPS RATHER THAN STOPS. A file you edited yourself blocks THAT file
 * and nothing else — aborting the whole rewind over one conflict would leave
 * the tree half-way between two states, which is the one outcome worse than
 * either.
 *
 * @param {string} root
 * @param {{ ok: true, runId: string, ops: any[] }} plan
 * @param {{ dryRun?: boolean, force?: boolean, dir?: string }} [opts]
 */
export function applyRewind(root, plan, { dryRun = false, force = false, dir = CHECKPOINT_DIR } = {}) {
  const paths = journalPaths(root, dir);
  const restored = [];
  const removed = [];
  const skipped = [];
  const failed = [];

  for (const op of plan.ops ?? []) {
    const absolute = safeJoin(root, op.path);
    if (!absolute) {
      failed.push({ path: op.path, error: 'that path is not inside the workspace — the journal line is not one this tool wrote' });
      continue;
    }
    if (!op.restorable) {
      skipped.push({ path: op.path, reason: op.reason ?? 'its previous contents were never stored' });
      continue;
    }

    // What is there NOW, against what the agent left.
    let currentSha = null;
    let currentExists = false;
    try {
      if (existsSync(absolute)) {
        currentExists = true;
        currentSha = sha256(readFileSync(absolute));
      }
    } catch (e) {
      failed.push({ path: op.path, error: `could not inspect it: ${errText(e)}` });
      continue;
    }

    /**
     * ⚠️⚠️ THE RULE THIS WHOLE FEATURE STANDS ON. Restoring over a file the
     * user changed after the run destroys their work while calling itself
     * safety. Three ways it can be untrue, and each gets its own sentence,
     * because "conflict" tells the reader nothing they can act on.
     */
    let conflict = null;
    if (op.expectExists && !currentExists) conflict = 'it is not there any more';
    else if (!op.expectExists && currentExists) conflict = 'a file is there that the agent had deleted';
    else if (op.expectExists && op.expectSha && currentSha !== op.expectSha) conflict = 'it changed after the agent wrote it';
    if (conflict && !force) {
      skipped.push({ path: op.path, reason: `${conflict} — rewinding would throw that away. Use --force if that is what you want.` });
      continue;
    }

    if (dryRun) {
      if (op.action === 'restore') restored.push({ path: op.path, bytes: op.beforeBytes, forced: Boolean(conflict) });
      else removed.push({ path: op.path, forced: Boolean(conflict) });
      continue;
    }

    try {
      if (op.action === 'restore') {
        const blobFile = join(paths.blobs, String(op.blob));
        const raw = readFileSync(blobFile);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, raw);
        restored.push({ path: op.path, bytes: raw.byteLength, forced: Boolean(conflict) });
      } else {
        if (currentExists) unlinkSync(absolute);
        removed.push({ path: op.path, forced: Boolean(conflict) });
      }
    } catch (e) {
      failed.push({ path: op.path, error: errText(e) });
    }
  }

  return {
    ok: failed.length === 0,
    runId: plan.runId,
    dryRun,
    forced: force,
    restored,
    removed,
    skipped,
    failed,
  };
}

/**
 * ⚠️ NOT CALLED BY THE RUN PATH, and that is deliberate: deleting somebody's
 * only way back while they are working is not a tidy-up. Exported so a future
 * `acuvo rewind --prune` has one implementation to call, and so the disk cost
 * is measurable rather than a guess.
 *
 * @param {string} root
 */
export function checkpointSize(root, { dir = CHECKPOINT_DIR } = {}) {
  const paths = journalPaths(root, dir);
  let bytes = 0;
  let blobs = 0;
  try {
    for (const name of readdirSync(paths.blobs)) {
      bytes += statSync(join(paths.blobs, name)).size;
      blobs += 1;
    }
  } catch { /* no checkpoints yet — zero is the honest answer */ }
  try {
    bytes += statSync(paths.journal).size;
  } catch { /* same */ }
  return { blobs, bytes };
}

// ── RENDERING ───────────────────────────────────────────────────────────────

function whenText(at) {
  if (typeof at !== 'string' || !at) return '';
  return `${at.slice(0, 10)} ${at.slice(11, 19)}`;
}

/**
 * @param {readonly any[]} runs
 * @param {{ blobs: number, bytes: number } | null} [size] what it costs on disk
 */
export function formatCheckpoints(runs, size = null) {
  if (!runs || runs.length === 0) {
    return [
      'no checkpoints in this workspace yet.',
      'Every run records the previous contents of each file it writes, so this fills up as soon as one does.',
    ];
  }
  const lines = [`${runs.length} checkpoint${runs.length === 1 ? '' : 's'}, newest first:`, ''];
  for (const r of runs) {
    const bits = [`${r.files} file${r.files === 1 ? '' : 's'}`];
    if (r.deletes > 0) bits.push(`${r.deletes} deleted`);
    if (r.unrestorable > 0) bits.push(`⚠ ${r.unrestorable} not restorable`);
    lines.push(`  ${r.runId}  ${whenText(r.at)}  ${bits.join(' · ')}`);
    if (r.task) lines.push(`      ${r.task}`);
  }
  lines.push('');
  lines.push('  acuvo rewind <id>            put the files back the way they were before that run');
  lines.push('  acuvo rewind <id> --dry-run  say what it would do, and touch nothing');
  /**
   * ⚠️⚠️ THE DISK COST IS PRINTED BECAUSE NOTHING PRUNES IT YET, and a store
   * that grows forever in somebody's workspace without ever saying so is the
   * quiet kind of defect. It is bounded by the content actually written (blobs
   * are content-addressed) — but "bounded" is not "small", and the honest move
   * is to show the number rather than to promise a cleanup that is not built.
   *
   * ⚠️ AND PRUNING IS NOT A ONE-LINE ADD-ON, which is why it is not here:
   * `audit.mjs` prunes whole day FILES precisely because seven terminals append
   * to one log, and rewriting a journal underneath a concurrent `appendFileSync`
   * is how you lose the entries you were trying to keep.
   */
  if (size && size.bytes > 0) {
    const mb = size.bytes / 1_000_000;
    const shown = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(size.bytes / 1000)} KB`;
    lines.push('');
    lines.push(`  ${shown} in .acuvo/checkpoints (${size.blobs} stored version${size.blobs === 1 ? '' : 's'}) — nothing prunes it yet; delete the directory to reclaim it.`);
  }
  return lines;
}

/** @param {any} result */
export function formatRewind(result) {
  const verb = result.dryRun ? 'would restore' : 'restored';
  const removedVerb = result.dryRun ? 'would delete' : 'deleted';
  const lines = [`rewind ${result.runId}${result.dryRun ? ' (dry run — nothing was touched)' : ''}`, ''];
  for (const r of result.restored) lines.push(`  ✔ ${verb} ${r.path}${r.forced ? ' (FORCED over your change)' : ''}`);
  for (const r of result.removed) lines.push(`  ✔ ${removedVerb} ${r.path} — the agent created it${r.forced ? ' (FORCED)' : ''}`);
  for (const s of result.skipped) lines.push(`  · skipped ${s.path}: ${s.reason}`);
  for (const f of result.failed) lines.push(`  ✗ ${f.path}: ${f.error}`);
  if (result.restored.length === 0 && result.removed.length === 0) {
    lines.push('  nothing was changed.');
  }
  lines.push('');
  const counts = [`${result.restored.length} restored`, `${result.removed.length} deleted`];
  if (result.skipped.length) counts.push(`${result.skipped.length} skipped`);
  if (result.failed.length) counts.push(`${result.failed.length} failed`);
  lines.push(`  ${counts.join(' · ')}`);
  return lines;
}
