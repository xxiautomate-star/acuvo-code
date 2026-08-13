/**
 * ── ⭐⭐ THE BULK EDIT WAS ALREADY HAPPENING — JUST NOT WHERE ANYTHING COULD SEE IT ─
 *
 * Measured 2026-08-13. Given "add a parameter to every one of these 45 modules",
 * the agent did not call `write_file` 45 times across 45 rounds. It wrote a
 * loop inside `evaluate` and did all 45 in ONE call, correctly, in six rounds.
 * That is the right instinct and it is how a person would do it.
 *
 * ⚠️ But `evaluate` starts a process, so every accounting mechanism this package
 * has was blind to it:
 *
 *   · no `mutated` flag  → the run reported "No files changed" after 45 writes
 *   · no lease claim     → another terminal's file could be overwritten silently
 *   · no `mutatedPath`   → `parallel.mjs`'s collision detection saw nothing
 *   · no credential gate → the write path's refusals never ran
 *
 * ⭐ THE ANSWER IS NOT TO FORBID `evaluate`. It is to make the operation the
 * model actually wants a FIRST-CLASS one, so the effective technique and the
 * governed technique are the same technique. Every write here goes through
 * `executor.writeFile`, which means leases, refusals, dry-run and the change
 * count all work exactly as they do for a single file — because it IS the
 * single-file path, called in a loop.
 *
 * ── ⚠️ PARTIAL SUCCESS IS REPORTED, NOT ROLLED BACK ─────────────────────────
 *
 * The obvious instinct is all-or-nothing. It is wrong here, for a reason worth
 * writing down: a rollback needs to restore the previous contents of files this
 * tool may have just created, in a workspace another terminal may be writing to
 * concurrently — a second, more dangerous write path, invented to tidy the
 * failure of the first. Reporting exactly which files landed and which were
 * refused is honest, is what the model needs in order to retry the remainder,
 * and cannot itself corrupt anything.
 */

/** More than this in one call is a migration, and a migration wants review. */
export const MAX_FILES = 60;
/** The sum of all contents. `write_file`'s own per-file ceiling still applies. */
export const MAX_TOTAL_BYTES = 2_000_000;

export function writeManyToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'write_files',
        description: [
          'Write SEVERAL files in one call. Use this instead of many separate write_file calls',
          'when a change touches more than two or three files — a rename across a package, adding',
          'a parameter to every module, generating a set of tests.',
          'DO NOT reach for a script inside `evaluate` to do bulk edits: writes made that way are',
          'invisible to the file leases that stop two terminals colliding, and to the "files changed"',
          'count the person reads at the end.',
          `At most ${MAX_FILES} files per call. Each file replaces its whole contents, exactly like write_file.`,
          'If some are refused, the rest still land and you are told which did what.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              description: 'The files to write. Each replaces the whole file.',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Workspace-relative path.' },
                  content: { type: 'string', description: 'The complete new contents.' },
                },
                required: ['path', 'content'],
              },
            },
          },
          required: ['files'],
        },
      },
    },
  ];
}

/**
 * @param {{ writeFile: (path: string, content: string) => any }} executor
 * @param {{ files?: unknown }} args
 */
export function writeMany(executor, { files } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: 'write_files needs a non-empty `files` array — each entry is { path, content }' };
  }
  if (files.length > MAX_FILES) {
    return {
      ok: false,
      error: `${files.length} files in one call is over the ${MAX_FILES} limit. Split it — a change that large is one somebody will want to read in pieces.`,
    };
  }

  /**
   * ⚠️ VALIDATED BEFORE ANYTHING IS WRITTEN. A malformed entry halfway down the
   * list would otherwise leave the first half applied and the call refused,
   * which is the worst of both answers: work done, and an error saying it was
   * not.
   */
  let total = 0;
  const seen = new Set();
  for (const [i, f] of files.entries()) {
    if (!f || typeof f !== 'object') return { ok: false, error: `files[${i}] is not an object — each entry is { path, content }` };
    if (typeof f.path !== 'string' || !f.path.trim()) return { ok: false, error: `files[${i}] has no path` };
    if (typeof f.content !== 'string') return { ok: false, error: `files[${i}] (${f.path}) has no content string` };
    /**
     * ⚠️ THE SAME PATH TWICE IS A MISTAKE, NOT AN INSTRUCTION. One of the two
     * contents would silently win, and which one is an implementation detail of
     * iteration order — exactly the kind of thing that looks fine in testing
     * and loses somebody's work once.
     */
    const key = f.path.trim();
    if (seen.has(key)) return { ok: false, error: `${key} appears twice in one call — one of the two would silently win` };
    seen.add(key);
    total += Buffer.byteLength(f.content, 'utf8');
  }
  if (total > MAX_TOTAL_BYTES) {
    return { ok: false, error: `refusing to write ${total} bytes in one call (limit ${MAX_TOTAL_BYTES})` };
  }

  const written = [];
  const refused = [];
  for (const f of files) {
    // ⭐ THE SINGLE-FILE PATH, in a loop. Every guard it has — leases,
    // credential refusals, `.acuvo/` protection, dry-run — applies unchanged,
    // because this is not a second way to write a file.
    const r = executor.writeFile(f.path, f.content);
    if (r?.ok) written.push({ path: r.path ?? f.path, bytes: r.bytes ?? Buffer.byteLength(f.content, 'utf8'), created: r.created === true, dryRun: r.dryRun === true });
    else refused.push({ path: f.path, error: r?.error ?? 'the write was refused' });
  }

  return {
    /**
     * ⚠️ `ok` IS FALSE WHEN NOTHING LANDED, and true when some did. A call that
     * wrote 44 of 45 files did real work the model must not repeat blindly, and
     * one that wrote none is a failure it should react to. Collapsing the two
     * into "partial" would leave the model guessing which it had.
     */
    ok: written.length > 0,
    written,
    refused,
    error: written.length === 0
      ? `no file was written. ${refused.length === 1 ? refused[0].error : `${refused.length} paths were refused — the first was: ${refused[0]?.error ?? 'unknown'}`}`
      : undefined,
  };
}

/** What the model reads back. Names every refusal, because it has to retry them. */
export function formatWriteMany(result) {
  if (!result) return 'write_files returned nothing';
  if (result.ok !== true && (result.written?.length ?? 0) === 0) return `write_files: ${result.error}`;
  const lines = [];
  const w = result.written ?? [];
  const dry = w.some((f) => f.dryRun);
  lines.push(`${w.length} file${w.length === 1 ? '' : 's'} ${dry ? 'WOULD be written (dry run — nothing was)' : 'written'}:`);
  for (const f of w.slice(0, 60)) lines.push(`  ${f.created ? 'created ' : 'replaced'} ${f.path} (${f.bytes} bytes)`);
  if ((result.refused?.length ?? 0) > 0) {
    lines.push(`${result.refused.length} refused — these still need doing:`);
    for (const f of result.refused.slice(0, 20)) lines.push(`  ${f.path}: ${f.error}`);
  }
  return lines.join('\n');
}
