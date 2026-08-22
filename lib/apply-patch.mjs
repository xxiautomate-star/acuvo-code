/**
 * ── ⭐⭐⭐ EDIT FAILURES ARE AN APPLICATION PROBLEM, NOT A COMPREHENSION ONE ──
 *
 * Measured across harnesses: removing flexible patch application caused a **9x
 * increase in editing errors**. The model understood the change; the patch would
 * not land.
 *
 * ⚠️ AND `diff -u` IS THE REASON. A unified diff header —
 *
 *     @@ -14,7 +14,9 @@
 *
 * — carries four numbers, and **an LLM cannot compute any of them.** After its
 * own earlier edits it has no line-accurate view of the file, so every hunk
 * header is a guess that must be exactly right or the patch is rejected wholesale.
 *
 * ⭐ SO THE NUMBERS ARE DELETED. `@@` becomes a bare marker that may optionally
 * carry the enclosing function or heading, and the location is found by SEARCHING
 * for the context lines. That is Codex's `apply_patch` grammar, and it is the
 * format the strongest agents converged on independently.
 *
 * ⭐ ADD / DELETE / UPDATE ARE ALL FIRST CLASS, so a six-file refactor is ONE
 * atomic blob rather than six separate edits that can half-apply. Half-applied
 * refactors are the failure that leaves a repo worse than before it started.
 *
 * ⚠️⚠️ FOUR MATCHING PASSES, DECREASING IN STRICTNESS, and the last one is not
 * a nicety. Models emit typographic punctuation — U+2018/2019 for quotes,
 * U+2013/2014 for dashes — into source code they were shown with ASCII. An
 * exact-match-only patcher rejects a semantically perfect edit because the model
 * smart-quoted a string. Normalising punctuation on BOTH sides is the fix.
 */

export const BEGIN = '*** Begin Patch';
export const END = '*** End Patch';

/** ⚠️ A patch is bounded so a runaway generation cannot be applied. */
export const MAX_PATCH_BYTES = 400_000;
export const MAX_FILES_PER_PATCH = 40;

/**
 * ── ⚠️ THE PUNCTUATION MAP, WHICH IS PASS FOUR ─────────────────────────────
 * Every character here is one a model substitutes for an ASCII original when it
 * is "tidying" text it is really quoting.
 */
const PUNCT = new Map([
  ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"],
  ['“', '"'], ['”', '"'], ['„', '"'], ['‟', '"'],
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['–', '-'],
  ['—', '-'], ['―', '-'], ['−', '-'],
  [' ', ' '], [' ', ' '], [' ', ' '],
  ['…', '...'],
]);

export function normalisePunctuation(line) {
  let out = '';
  for (const ch of String(line ?? '')) out += PUNCT.get(ch) ?? ch;
  return out;
}

/** The four passes, strictest first. Each returns a comparable form of a line. */
const PASSES = Object.freeze([
  { name: 'exact', of: (l) => l },
  { name: 'right-strip', of: (l) => l.replace(/\s+$/, '') },
  { name: 'trim', of: (l) => l.trim() },
  { name: 'punctuation', of: (l) => normalisePunctuation(l).trim() },
]);

/**
 * Parse the envelope into operations. Returns `{ ok, ops }` or `{ ok: false, error }`.
 *
 * ⚠️ EVERY REFUSAL NAMES THE LINE. A parser that says "invalid patch" costs the
 * model a round of guessing, and this format is written BY the model — so the
 * error message is part of the interface, not an afterthought.
 */
export function parsePatch(text) {
  const raw = String(text ?? '');
  if (raw.length > MAX_PATCH_BYTES) {
    return { ok: false, error: `patch is ${raw.length} bytes and the limit is ${MAX_PATCH_BYTES}` };
  }
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const begin = lines.findIndex((l) => l.trim() === BEGIN);
  if (begin === -1) return { ok: false, error: `a patch must start with "${BEGIN}"` };
  const end = lines.findIndex((l, i) => i > begin && l.trim() === END);
  if (end === -1) return { ok: false, error: `a patch must finish with "${END}" — none was found` };

  const ops = [];
  let cur = null;
  for (let i = begin + 1; i < end; i += 1) {
    const line = lines[i];
    const t = line.trim();
    const add = /^\*\*\* Add File:\s*(.+)$/.exec(t);
    const upd = /^\*\*\* Update File:\s*(.+)$/.exec(t);
    const del = /^\*\*\* Delete File:\s*(.+)$/.exec(t);
    const mov = /^\*\*\* Move to:\s*(.+)$/.exec(t);

    if (add) { cur = { kind: 'add', path: add[1].trim(), lines: [] }; ops.push(cur); continue; }
    if (upd) { cur = { kind: 'update', path: upd[1].trim(), hunks: [] }; ops.push(cur); continue; }
    if (del) { cur = { kind: 'delete', path: del[1].trim() }; ops.push(cur); continue; }
    if (mov) {
      if (!cur || cur.kind !== 'update') return { ok: false, error: `line ${i + 1}: "Move to" must follow an "Update File"` };
      cur.moveTo = mov[1].trim(); continue;
    }
    if (!cur) return { ok: false, error: `line ${i + 1}: content before any "*** Add/Update/Delete File:" header` };

    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.lines.push(line.slice(1));
      else if (t === '') cur.lines.push('');
      else return { ok: false, error: `line ${i + 1}: every line of an added file must start with "+"` };
      continue;
    }
    if (cur.kind === 'update') {
      if (t.startsWith('@@')) { cur.hunks.push({ marker: t.slice(2).trim(), lines: [] }); continue; }
      if (cur.hunks.length === 0) cur.hunks.push({ marker: '', lines: [] });
      const h = cur.hunks[cur.hunks.length - 1];
      if (line.startsWith('+')) h.lines.push({ op: '+', text: line.slice(1) });
      else if (line.startsWith('-')) h.lines.push({ op: '-', text: line.slice(1) });
      else if (line.startsWith(' ')) h.lines.push({ op: ' ', text: line.slice(1) });
      else if (line === '') h.lines.push({ op: ' ', text: '' });
      else return { ok: false, error: `line ${i + 1}: a hunk line must begin with " ", "+" or "-" (got ${JSON.stringify(line.slice(0, 20))})` };
      continue;
    }
    return { ok: false, error: `line ${i + 1}: content after a Delete File header` };
  }

  if (ops.length === 0) return { ok: false, error: 'the patch contains no file operations' };
  if (ops.length > MAX_FILES_PER_PATCH) {
    return { ok: false, error: `patch touches ${ops.length} files and the limit is ${MAX_FILES_PER_PATCH}` };
  }
  return { ok: true, ops };
}

/**
 * Find where a hunk's context sits in the file, trying each pass in turn.
 *
 * ⚠️ RETURNS THE PASS THAT SUCCEEDED, because a match found only by the loosest
 * pass is worth reporting: it means the model's copy of the file disagreed with
 * the real one, and that is information the caller should be able to surface.
 */
export function locateHunk(fileLines, hunk) {
  const want = hunk.lines.filter((l) => l.op !== '+').map((l) => l.text);
  if (want.length === 0) return { ok: false, error: 'hunk has no context or removal lines to locate' };

  for (const pass of PASSES) {
    const needle = want.map(pass.of);
    const hay = fileLines.map(pass.of);
    const hits = [];
    for (let i = 0; i + needle.length <= hay.length; i += 1) {
      let match = true;
      for (let j = 0; j < needle.length; j += 1) {
        if (hay[i + j] !== needle[j]) { match = false; break; }
      }
      if (match) hits.push(i);
      if (hits.length > 1) break;
    }
    /**
     * ⚠️⚠️ AMBIGUITY IS A REFUSAL, NOT A COIN FLIP. Two identical regions mean
     * we do not know which the model meant, and picking one silently edits the
     * wrong place — the single worst outcome available to a patcher, because it
     * looks like success.
     */
    if (hits.length > 1) {
      return { ok: false, error: `that context appears more than once — add a line or two around it so it is unique` };
    }
    if (hits.length === 1) return { ok: true, index: hits[0], pass: pass.name };
  }
  const first = want.find((l) => l.trim()) ?? want[0];
  return { ok: false, error: `context not found in the file. The first line looked for was ${JSON.stringify(first.slice(0, 80))}` };
}

/** Apply one update hunk to an array of lines. */
function applyHunk(fileLines, hunk) {
  const at = locateHunk(fileLines, hunk);
  if (!at.ok) return at;
  const out = fileLines.slice(0, at.index);
  let cursor = at.index;
  for (const l of hunk.lines) {
    if (l.op === ' ') { out.push(fileLines[cursor]); cursor += 1; }
    else if (l.op === '-') { cursor += 1; }
    else out.push(l.text);
  }
  out.push(...fileLines.slice(cursor));
  return { ok: true, lines: out, pass: at.pass };
}

/**
 * Apply a parsed patch to a file map.
 *
 * ⚠️⚠️ ALL OR NOTHING. A patch that fails on file four must not leave files one
 * to three changed — a half-applied refactor is worse than a rejected one,
 * because the repo is now in a state neither the model nor the user expects.
 * Every operation is computed against a COPY and committed only at the end.
 *
 * @param {Record<string,string>} files
 * @param {string} patchText
 */
export function applyPatch(files, patchText) {
  const parsed = parsePatch(patchText);
  if (!parsed.ok) return parsed;

  const next = { ...files };
  const changed = [];
  const looseMatches = [];

  for (const op of parsed.ops) {
    if (op.kind === 'add') {
      if (Object.prototype.hasOwnProperty.call(next, op.path)) {
        return { ok: false, error: `${op.path} already exists — use "Update File" to change it` };
      }
      next[op.path] = op.lines.join('\n');
      changed.push({ path: op.path, kind: 'added' });
      continue;
    }
    if (op.kind === 'delete') {
      if (!Object.prototype.hasOwnProperty.call(next, op.path)) {
        return { ok: false, error: `cannot delete ${op.path} — it does not exist` };
      }
      delete next[op.path];
      changed.push({ path: op.path, kind: 'deleted' });
      continue;
    }
    // update
    if (!Object.prototype.hasOwnProperty.call(next, op.path)) {
      return { ok: false, error: `cannot update ${op.path} — it does not exist. Use "Add File" to create it` };
    }
    let lines = next[op.path].split('\n');
    for (const hunk of op.hunks) {
      const res = applyHunk(lines, hunk);
      if (!res.ok) return { ok: false, error: `${op.path}: ${res.error}` };
      lines = res.lines;
      if (res.pass !== 'exact') looseMatches.push({ path: op.path, pass: res.pass });
    }
    const target = op.moveTo || op.path;
    if (op.moveTo) {
      delete next[op.path];
      changed.push({ path: op.path, kind: 'moved', to: op.moveTo });
    } else {
      changed.push({ path: op.path, kind: 'updated' });
    }
    next[target] = lines.join('\n');
  }

  return { ok: true, files: next, changed, looseMatches };
}

/* ════════════════════════════════════════════════════════════════════════════
 * THE CLI TOOL — the engine above, wired to a real workspace
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── ⭐⭐⭐ WHY THIS IS THE TOP LEVER, MEASURED ON A REAL BUILD ──────────────
 *
 * One build: 28 model calls, 378,507 prompt tokens, ~4 cents.
 *
 *     prompt cache   83.2%, and 100% steady-state on a stable prefix
 *     OUTPUT         $0.045 of $0.080 — 56% of the spend, ~53,000 tokens
 *
 * The cache is at its ceiling and **a prompt cache cannot discount output at
 * all**. Output is dominated by re-emitting whole files through `write_file`,
 * and a patch is 10-50x smaller than the file it changes. It is also the
 * accuracy fix: removing flexible patch application cost a measured 9x increase
 * in editing errors (see this file's header).
 *
 * ── ⚠️⚠️ AND WHY THE GATE, NOT THE ENGINE, IS THE HARD PART ─────────────────
 *
 * A patch writes N files at once. Every write in this CLI goes through
 * `executor.writeFile` / `deleteFile`, and that ONE door carries the file
 * leases, the `.acuvo/` leash, the `node_modules`/`.git` refusals, `--dry-run`
 * and the `--plan` read-only executor. So this module never touches `fs`: it
 * READS through the executor, computes the whole changeset in memory, and
 * writes through the same door `write_file` uses. A second door would be a
 * safety regression larger than the cost win.
 *
 * ⭐ THE WORK IS SPLIT IN TWO — `planPatch` then `commitPatch` — because the
 * approval gate needs the complete file list BEFORE anything lands. That is the
 * same shape `write_files` uses: one question for the whole batch, carrying
 * every path, so a person sees the scope rather than answering forty prompts.
 */

/**
 * ⚠️⚠️ A RENAME INSIDE A PATCH WOULD BE A SECOND MOVE PATH THAT SKIPS THE
 * CREDENTIAL GUARD, so `*** Move to:` is refused here even though the engine
 * supports it. `executor.moveFile` refuses `.env` → `notes/env.txt` because
 * `git.mjs` checks committability BY PATH: a rename is exactly how a secret
 * becomes committable under a name the agent chose. Implementing a move as a
 * write plus a delete would route around that guard, and "two doors, one
 * hardened" is the failure this package has already paid for — a hardened
 * `editFile()` existed for weeks while the dispatcher called the unhardened one.
 *
 * ⭐ The engine keeps the capability because its other client is a Map, where
 * none of that applies. The refusal belongs on the door the model reaches.
 */
const MOVE_REFUSAL = 'this patch uses "*** Move to:", and apply_patch does not rename files. Use move_file for the '
  + 'rename — it is the only verb that checks a move does not carry a credential path out of the namespace '
  + 'git_commit refuses (.env -> notes/env.txt), and it handles large and binary files a patch cannot read. '
  + 'Rename first, then send a patch against the new path.';

/**
 * ⭐ THE SENTENCE THAT MAKES THE CAPABILITY REAL. A schema and a handler are two
 * thirds of reachability; telling the model WHEN to reach for this is the third,
 * and it is the one this repo forgets. Without it a coder model keeps emitting
 * whole files, which is the 56%-of-spend this verb exists to cut.
 *
 * ⚠️ IT STATES THE REASON, NOT JUST THE RULE. A rule with no reason is the first
 * thing a model drops when the task gets hard.
 */
export function applyPatchToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'apply_patch',
        description: [
          'Change one or more EXISTING files by sending only the lines that differ.',
          'PREFER THIS OVER write_file whenever the file already exists: write_file makes you re-emit the whole',
          'file, and emitting output tokens is 56% of what a run costs and is the one part a prompt cache can',
          'never discount. A patch is typically 10-50x smaller, and flexible patch application also measures 9x',
          'FEWER editing errors than rewriting a file from memory.',
          'FORMAT — no line numbers anywhere, the location is found by searching for your context lines:',
          '*** Begin Patch / *** Update File: <path> / @@ / a few unchanged context lines prefixed with a space,',
          'lines to remove prefixed with "-", lines to add prefixed with "+" / *** End Patch.',
          '"*** Add File: <path>" (every line prefixed "+") and "*** Delete File: <path>" may appear in the same',
          'patch. Give enough surrounding context that each hunk matches exactly one place in the file.',
          'ALL OR NOTHING: if any hunk or any file fails, nothing is written at all — so a refactor across',
          `several files is one atomic call. At most ${MAX_FILES_PER_PATCH} files per patch.`,
          'Renaming is NOT supported here — use move_file, then patch the new path.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            patch: {
              type: 'string',
              description: 'The whole patch, from "*** Begin Patch" to "*** End Patch" inclusive.',
            },
          },
          required: ['patch'],
        },
      },
    },
  ];
}

const byteLength = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

/**
 * Work out the entire changeset WITHOUT touching disk.
 *
 * ⚠️ EVERY READ GOES THROUGH THE EXECUTOR, never through `fs` — the in-memory
 * executor the browser builder uses has no filesystem, and a direct read here
 * would make this silently wrong in the one place the registry exists to serve.
 *
 * @returns {{ok: true, writes: Array, deletes: Array, batch: Array, looseMatches: Array}
 *           | {ok: false, error: string}}
 */
export function planPatch(executor, patchText) {
  const parsed = parsePatch(patchText);
  if (!parsed.ok) return parsed;
  if (parsed.ops.some((op) => op.moveTo)) return { ok: false, error: MOVE_REFUSAL };

  /**
   * The file map the engine works on. An `add` is looked up too — a successful
   * read is how `applyPatch` learns the path is taken and refuses with "already
   * exists — use Update File to change it".
   *
   * ⚠️ AN UNREADABLE PATH IS NOT PROOF OF ABSENCE. A binary or over-large file
   * reads `ok: false`, so an `Add File` over one lands as a plain overwrite —
   * exactly as destructive as `write_file` on the same path and no more. The
   * RESULT still tells the truth, because `created` comes from the executor's
   * own existence check rather than from this map.
   */
  const before = {};
  for (const op of parsed.ops) {
    let read;
    try { read = executor.readFile(op.path); } catch { read = null; }
    const got = read && read.ok !== false && typeof read.content === 'string';
    if (got) before[op.path] = read.content;
    else if (op.kind !== 'add') {
      return {
        ok: false,
        error: `cannot ${op.kind} ${op.path}: ${read?.error ?? 'it could not be read'}`,
      };
    }
  }

  const applied = applyPatch(before, patchText);
  if (!applied.ok) return applied;

  /**
   * ── ⚠️ DERIVED FROM THE FINAL STATE, NOT FROM `changed[]` ──────────────────
   *
   * `changed[]` is a LOG of operations, and one path can appear in it more than
   * once: a patch may carry two `Update File` headers for one file, or add a
   * file and delete it again. Walking the log would write that path twice — the
   * second write's `before` would be a value that no longer exists on disk, so
   * a rollback would restore the wrong bytes — and for add-then-delete it would
   * try to write `undefined`.
   *
   * ⭐ `applied.files` is the END STATE, which is the only thing disk should be
   * asked to become. The log is used only for the ORDER, so the person reviewing
   * and the model reading the result see the paths in the order they wrote them.
   */
  const touched = [];
  for (const c of applied.changed) if (!touched.includes(c.path)) touched.push(c.path);

  const writes = [];
  const deletes = [];
  for (const path of touched) {
    const existed = Object.prototype.hasOwnProperty.call(before, path);
    if (!Object.prototype.hasOwnProperty.call(applied.files, path)) {
      deletes.push({ path, before: existed ? before[path] : null });
      continue;
    }
    const after = applied.files[path];
    /**
     * ⚠️ A PATH THE PATCH TOUCHED AND LEFT BYTE-IDENTICAL IS NOT A WRITE. Writing
     * it would put the file in the "N files changed" count, in the checkpoint
     * journal and in `parallel.mjs`'s collision detection, for a change that does
     * not exist — the same class of lie as `see_page` reporting "replaced
     * index.html" for a photograph.
     */
    if (existed && before[path] === after) continue;
    writes.push({ path, before: existed ? before[path] : null, after, exists: existed });
  }

  /**
   * ⚠️ A PATCH THAT NETS TO NOTHING IS TOLD SO, NOT REPORTED AS A SUCCESS WITH
   * ZERO FILES. Every hunk matched — so the file already says what the patch
   * asks for — and that is a fact the model must have: silently "succeeding"
   * here is how an agent loops sending the same patch, or worse, reports the
   * work done. This package's standing rule is that a zero-effect success is
   * the worst answer available.
   */
  if (writes.length === 0 && deletes.length === 0) {
    return {
      ok: false,
      error: 'every hunk in this patch matched, and applying it changes nothing — the files already contain '
        + 'exactly what it asks for. Nothing was written. Re-read the file before deciding what still needs doing.',
    };
  }

  /**
   * ⭐ THE BATCH THE APPROVER SEES, in `write_files`' shape — `{path, before,
   * after, exists}`. `approvalDecision` derives "created / replaced / DELETED"
   * from `after` being null, so a deletion has to arrive as a null rather than
   * as an empty file, or the person is shown a blanking instead of a removal.
   */
  const batch = [
    ...writes,
    ...deletes.map((d) => ({ path: d.path, before: d.before, after: null, exists: true })),
  ];

  return { ok: true, writes, deletes, batch, looseMatches: applied.looseMatches ?? [] };
}

/**
 * ── ⚠️⚠️ ALL OR NOTHING ALL THE WAY TO DISK ────────────────────────────────
 *
 * `planPatch` already guarantees it for APPLICATION failures — the engine
 * computes against a copy, so a hunk that will not match refuses before a byte
 * moves. This function closes the other half: a write that the EXECUTOR refuses
 * halfway through the changeset.
 *
 * `write_files` deliberately reports partial success and does not roll back, and
 * that is right THERE: it is N independent writes, and its header argues that a
 * rollback would need to restore contents it never read. Neither is true here.
 * A patch is ONE changeset — half a refactor on disk is a repo in a state
 * neither the model nor the user expects — and `planPatch` is already holding
 * every file's previous bytes, because it needed them to compute the new ones.
 *
 * ⭐ AND THE RESTORE CANNOT ITSELF BE REFUSED BY THE GUARD THAT STOPPED US. Any
 * path already written passed the path rules and, when leases are on, is one
 * this run now HOLDS — `auto-lease.mjs` is re-entrant and renews rather than
 * re-acquiring. So the rollback goes back through the same door, and the only
 * residual failure is real I/O, which is reported rather than swallowed.
 *
 * ⚠️ WHAT REMAINS OPEN, STATED HONESTLY: this reacts to the first refusal
 * instead of preventing it. A true preflight needs the lease claimer, and that
 * lives in a closure inside `createLocalExecutor` — exposing it is a one-line
 * change to a file this lane does not own. The behaviour the user sees is the
 * same; the difference is one wasted write-and-restore per conflict.
 */
export function commitPatch(executor, plan) {
  /** What we have done, newest last. Each entry knows how to undo itself. */
  const undo = [];
  const written = [];

  const rollback = (why) => {
    const restored = [];
    const stuck = [];
    for (const step of [...undo].reverse()) {
      // A dry run put nothing on disk, so there is nothing to put back.
      if (step.dryRun) continue;
      const r = step.before === null
        ? executor.deleteFile(step.path)
        : executor.writeFile(step.path, step.before);
      if (r?.ok) restored.push(step.path);
      else stuck.push({ path: step.path, error: r?.error ?? 'the restore was refused' });
    }
    /**
     * ⚠️ A FAILED RESTORE MUST NOT REPORT AS "NOTHING HAPPENED". Those paths ARE
     * changed on disk, and the run summary counts `written[]` — so they go in it,
     * flagged, and the error names them. Silence here would be the one outcome
     * worse than the half-apply itself.
     */
    return {
      ok: false,
      written: stuck.map((s) => ({ path: s.path, bytes: 0, stale: true })),
      error: stuck.length === 0
        ? `${why}. Nothing was changed — the whole patch was rolled back, so the files are exactly as they were. `
          + 'Fix that one path and send the patch again.'
        : `${why}. The patch was rolled back, but ${stuck.length} file(s) could NOT be restored and are still `
          + `modified on disk: ${stuck.map((s) => `${s.path} (${s.error})`).join('; ')}. Check them before continuing.`,
      rolledBack: restored,
      rollbackFailed: stuck,
    };
  };

  for (const w of plan.writes) {
    const r = executor.writeFile(w.path, w.after);
    if (!r?.ok) return rollback(`${w.path}: ${r?.error ?? 'the write was refused'}`);
    const path = r.path ?? w.path;
    written.push({
      path,
      bytes: r.bytes ?? byteLength(w.after),
      created: r.created === true,
      dryRun: r.dryRun === true,
    });
    undo.push({ path, before: w.exists ? w.before : null, dryRun: r.dryRun === true });
  }

  /**
   * ⭐ DELETES LAST. A patch that removes a module and rewrites its importers in
   * one call should leave the importers correct before the file disappears —
   * and if the delete is the operation that gets refused, the rollback has less
   * to undo.
   */
  for (const d of plan.deletes) {
    const r = executor.deleteFile(d.path);
    if (!r?.ok) return rollback(`${d.path}: ${r?.error ?? 'the delete was refused'}`);
    const path = r.path ?? d.path;
    written.push({ path, bytes: r.bytes ?? 0, deleted: true, dryRun: r.dryRun === true });
    undo.push({ path, before: d.before, dryRun: r.dryRun === true });
  }

  return { ok: true, written, looseMatches: plan.looseMatches ?? [] };
}

/**
 * What the model reads back.
 *
 * ⚠️ THE LOOSE MATCHES ARE REPORTED, NOT HIDDEN. A hunk that only matched on the
 * trim or punctuation pass means the model's copy of the file disagreed with the
 * real one — that is a fact it should act on before sending the next patch, and
 * `locateHunk` computes it precisely so somebody can say so.
 */
export function formatApplyPatch(result) {
  if (!result) return 'apply_patch returned nothing';
  if (result.ok !== true) return `apply_patch: ${result.error}`;
  const w = result.written ?? [];
  const dry = w.some((f) => f.dryRun);
  const lines = [
    `${w.length} file${w.length === 1 ? '' : 's'} ${dry ? 'WOULD change (dry run — nothing was written)' : 'changed'}:`,
  ];
  for (const f of w.slice(0, MAX_FILES_PER_PATCH)) {
    const verb = f.deleted ? 'deleted ' : (f.created ? 'created ' : 'patched ');
    lines.push(`  ${verb} ${f.path}${f.deleted ? '' : ` (${f.bytes} bytes)`}`);
  }
  for (const m of result.looseMatches ?? []) {
    lines.push(`  ⚠ ${m.path}: a hunk matched only after ${m.pass} normalisation — your copy of this file differs `
      + 'from the one on disk. Re-read it before the next patch.');
  }
  return lines.join('\n');
}
