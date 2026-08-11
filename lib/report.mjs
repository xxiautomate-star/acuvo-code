/**
 * ── ⭐ MACHINE-READABLE OUTPUT, AND A DIFF OF WHAT ACTUALLY CHANGED ──────────
 *
 * Two gaps the MVP plan named, and they are the same gap seen twice: the CLI
 * tells you WHICH files it touched and never WHAT it did to them, and it says
 * so only in prose a script cannot read.
 *
 * ── ⚠️ WHY "3 files written" IS NOT ENOUGH ──────────────────────────────────
 * It is the difference between trusting the agent and verifying it. A user who
 * has to open three files and read them has not been given a report; they have
 * been given homework. And the one place this matters most is the case where
 * the agent quietly deleted something while making an unrelated change —
 * exactly what `edit_file` exists to prevent and exactly what a file list
 * cannot show.
 *
 * ⭐ So: line counts per file, and for a REPLACED file, what it looked like
 * before. Not a full unified diff — a terminal report that runs off the screen
 * is one nobody reads — but enough that "it rewrote 200 lines of a 210-line
 * file" is visible at a glance, because that is usually a mistake.
 */

/** Count lines the way an editor does: a trailing newline is not a line. */
function lineCount(text) {
  if (!text) return 0;
  const n = String(text).split('\n').length;
  return String(text).endsWith('\n') ? n - 1 : n;
}

/**
 * Summarise one write.
 *
 * ⚠️ WORKS FROM THE RESULT OBJECT, NOT FROM DISK. Re-reading the file here
 * would report whatever it looks like NOW — including changes a later round, or
 * another parallel task, made afterwards. The result is what this write did.
 */
export function describeChange(record) {
  const r = record?.result ?? {};
  /**
   * ⚠️ `lines` IS OMITTED WHEN WE DO NOT HAVE THE CONTENT, and the first version
   * reported `lines: 0` for every write — because `write_file`'s result carries
   * a byte count and a path, not the text. A confidently wrong zero in a
   * machine-readable document is worse than an absent field: a script can check
   * for `undefined`, and it cannot know that a 0 is a lie.
   */
  const after = r.content === undefined ? null : lineCount(r.content);
  const base = {
    // ⚠️ `mutatedPath` WINS. A tool whose subject is not the file it wrote —
    // `see_page` reads a page and writes a screenshot — otherwise reports a
    // write against the file it only looked at. See the note in tools.mjs.
    path: record.mutatedPath ?? r.path,
    tool: record.name,
    bytes: r.bytes ?? r.screenshotBytes ?? 0,
    previousBytes: r.previousBytes ?? 0,
  };
  if (record.name === 'delete_file') return { ...base, kind: 'deleted' };
  // A screenshot is always a new file — never a replacement of the page it shows.
  if (record.name === 'see_page') return { ...base, kind: 'created' };
  if (r.created) return { ...base, kind: 'created', ...(after === null ? {} : { lines: after }) };
  if (record.name === 'edit_file') {
    return {
      ...base,
      kind: 'edited',
      // ⭐ The proportion is the signal. `replacedChars` against `fileChars`
      // answers "was this surgery or a rewrite" without printing the file.
      replacedChars: r.replacedChars ?? 0,
      fileChars: r.fileChars ?? 0,
      share: r.fileChars ? Math.min(1, (r.replacedChars ?? 0) / r.fileChars) : 0,
    };
  }
  return { ...base, kind: 'replaced', ...(after === null ? {} : { lines: after }) };
}

/**
 * ⚠️ THE LINE THAT SHOULD MAKE SOMEONE LOOK. A whole-file rewrite of an
 * existing file is how code silently disappears — the model re-emits what it
 * remembers and drops what it did not think to include. The file still parses,
 * the tests may still pass, and nobody notices until the missing thing was
 * load-bearing.
 */
export function rewriteWarnings(changes) {
  return changes
    .filter((c) => c.kind === 'replaced' && c.previousBytes > 400 && c.bytes < c.previousBytes * 0.6)
    .map((c) => `${c.path} shrank from ${c.previousBytes} to ${c.bytes} bytes — check nothing was dropped`);
}

/** Render the change list for a human. */
export function formatChanges(changes, { paint = null } = {}) {
  if (changes.length === 0) return [];
  const p = paint ?? { gold: (t) => t, dim: (t) => t, red: (t) => t };
  const lines = [];
  for (const c of changes) {
    if (c.kind === 'deleted') { lines.push(`  ${p.gold('deleted  ')} ${c.path}  ${p.dim(`(${c.bytes} bytes)`)}`); continue; }
    if (c.kind === 'edited') {
      const pct = Math.round(c.share * 100);
      lines.push(`  ${p.gold('edited   ')} ${c.path}  ${p.dim(`(${c.replacedChars} of ${c.fileChars} chars · ${pct}%)`)}`);
      continue;
    }
    const delta = c.kind === 'replaced' && c.previousBytes
      ? ` · was ${c.previousBytes}`
      : '';
    const size = c.lines === undefined ? `${c.bytes} bytes${delta}` : `${c.lines} lines, ${c.bytes} bytes${delta}`;
    lines.push(`  ${p.gold(`${c.kind === 'created' ? 'created  ' : 'replaced '}`)} ${c.path}  ${p.dim(`(${size})`)}`);
  }
  for (const w of rewriteWarnings(changes)) lines.push(`  ${p.red('⚠')} ${w}`);
  return lines;
}

/**
 * ── ⭐ `--json`: ONE OBJECT, ON STDOUT, AND NOTHING ELSE ────────────────────
 *
 * ⚠️ THE CONTRACT IS THE WHOLE VALUE. A script that has to grep prose is a
 * script that breaks the next time we improve a sentence — and we have improved
 * several today. So this shape is stable, and every human-facing line goes to
 * stderr when `--json` is on, leaving stdout parseable by `jq` with no flags.
 *
 * ⚠️ AND IT MUST NEVER CARRY COLOUR. An escape code inside a JSON string is
 * valid JSON and completely useless — the same class of bug that once had the
 * bench parse a cost of $7.50 out of a fixture's test name.
 */
export function toJson(outcome, { changes = [], task = null } = {}) {
  const v = outcome?.verification ?? {};
  return {
    ok: outcome?.ok !== false,
    task,
    model: outcome?.model ?? null,
    rounds: outcome?.roundsUsed ?? 0,
    stoppedBecause: outcome?.stoppedBecause ?? null,
    // ⭐ `ran` and `passed` stay SEPARATE, as everywhere else in this codebase.
    // Collapsing them is how a loop reports success on a failing test.
    verification: {
      ran: v.ran === true,
      passed: v.passed === true,
      command: v.command ?? null,
      exitCode: v.exitCode ?? null,
      attempts: v.attempts ?? 0,
    },
    /**
     * ── ⚠️⚠️ THE CRITERION THE USER NAMED, OR THE DOCUMENT LIES BY OMISSION ──
     *
     * `verification` answers "did SOMETHING this process ran exit 0". Acceptance
     * answers "was it the thing you asked for", and until this field existed the
     * second answer never left the terminal. Measured: a run whose declared
     * `npm test` was unmet emitted `verification.passed:true` with nothing in
     * the document to say a named criterion had been missed — and the pipeline
     * acceptance.mjs's own header calls out, `acuvo --json | jq
     * '.verification.passed'`, read green.
     *
     * ⚠️ `gating` IS PART OF THE SHAPE, not a footnote. A DECLARED criterion
     * decides the exit code; a DERIVED one is this runner's reading of the
     * user's prose and reports only. A consumer that cannot tell them apart
     * either ignores both or trusts both, and both are wrong.
     *
     * ⭐ `null` WHEN NOBODY NAMED ONE, which is most runs — an always-present
     * object with empty fields would make "no criterion" and "a criterion that
     * found nothing" the same document.
     */
    acceptance: outcome?.acceptance
      ? {
          source: outcome.acceptance.source ?? null,
          gating: outcome.acceptance.gating === true,
          verdict: outcome.acceptance.verdict?.verdict ?? null,
          unmet: (outcome.acceptance.verdict?.unmet ?? []).map((u) => ({
            command: u?.command ?? null,
            why: u?.why ?? null,
          })),
        }
      : null,
    changes,
    // A number a caller can budget against, not a sentence about money.
    costUsd: outcome?.usage?.cost ?? null,
    tokens: outcome?.usage?.total_tokens ?? null,
    // Refusals are data: a script retrying a run wants to know it asked for
    // something impossible rather than that the model was merely unlucky.
    refusals: (outcome?.executed ?? [])
      .filter((e) => e?.result?.ok === false)
      .map((e) => ({ tool: e.name, error: String(e.result.error ?? '').slice(0, 300) })),
    error: outcome?.ok === false ? (outcome.error ?? null) : null,
  };
}
