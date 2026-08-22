/**
 * ── ⭐⭐ SHOW THE CHANGE BEFORE IT LANDS, NOT AFTER ──────────────────────────
 *
 * This agent writes a file and then tells you what it wrote. Every terminal
 * agent people compare us to shows the diff and asks first. That ordering is
 * the single biggest felt difference on a first run, and it is not a cosmetic
 * one: "I rewrote 200 lines of a 210-line file" reported afterwards is a
 * post-mortem, and reported beforehand it is a veto.
 *
 * `report.mjs` already saw half of this and said so out loud — *"the CLI tells
 * you WHICH files it touched and never WHAT it did to them"* — and deliberately
 * stopped short of a unified diff because a report that runs off the screen is
 * one nobody reads. That reasoning is right for a REPORT and wrong for a
 * PROMPT: a person about to answer y/n will read forty lines, and the cap is a
 * rendering problem, not a reason to withhold the diff.
 *
 * ── ⚠️⚠️ THIS IS NOT A SECURITY BOUNDARY, AND BUILDING IT AS ONE BREAKS IT ───
 *
 * The temptation is to make approval fail closed everywhere, the way
 * `mcp-consent.mjs` does. It is the wrong instinct here, and the difference is
 * worth stating precisely because getting it backwards is what kills the
 * feature:
 *
 *   `checkMcpConsent` guards a **foreign binary being executed**. There is no
 *   other control standing between a cloned repo and code running as you, so
 *   "nobody could be asked" has to mean "no".
 *
 *   A write is already guarded four times over before it reaches here:
 *   `resolveInWorkspace` confines it to the root, `WRITE_FORBIDDEN_ROOTS`
 *   refuses `.git` and friends, `MAX_WRITE_BYTES` bounds it, and
 *   `policy.requireDryRun` is the org control that says "this machine may not
 *   be written to at all". Approval is a **review affordance on top of those**,
 *   not a fifth lock.
 *
 * ⚠️ SO WHAT HAPPENS WITH NO TERMINAL IS THE WHOLE DESIGN QUESTION. In CI, in
 * `--parallel`, in the fleet, in a pipe, nobody can answer. `prompt.mjs` already
 * pays for that lesson in its own header: a prompt with no terminal must fail
 * with a message and NEVER block, because a hang is the least legible failure
 * there is. Blocking is off the table. That leaves two options and both are
 * wrong in isolation:
 *
 *   · **Refuse the write.** Then the day this merges, every unattended run
 *     stops working. The workaround people reach for is `ACUVO_APPROVE=never`
 *     in their shell profile — which switches review off on their laptop too.
 *     ⭐ A gate that breaks unattended runs gets globally disabled, and then it
 *     protects nobody. That is strictly worse than not shipping it.
 *   · **Write silently.** Then an operator who explicitly asked for a review
 *     gate gets no gate and no warning, which is the fail-open-on-a-typo shape
 *     `policy.mjs` refuses by name.
 *
 * ⭐ THE SPLIT IS ON WHETHER ANYBODY ASKED. Default (`auto`) with no terminal:
 * the write proceeds, is marked `reviewed: false`, and the reason says so, so
 * the run summary can count "4 files written without review". Explicit
 * (`--approve` / `ACUVO_APPROVE=always`) with no terminal: that is a stated
 * intent we cannot honour, so it refuses and names the way out — exactly the
 * `checkMcpConsent` shape, applied only where somebody actually stated the
 * intent.
 *
 * ── ⚠️⚠️ AND ASKING ABOUT EVERY WRITE IS THE SAME AS ASKING ABOUT NONE ──────
 *
 * `mcp-consent.mjs` says it twice in its own comments: *a nag people learn to
 * click through is worse than no prompt.* A 40-file build that asks 40 times
 * trains the exact reflex the feature exists to prevent, and the 41st question
 * — the one that mattered — gets the same reflex `y`.
 *
 * ⭐ THE GRANULARITY IS NOT "PER FILE" AND NOT "PER RUN". IT IS **PER
 * IRREVERSIBLE ACT**. Creating a file destroys nothing; you can delete it
 * afterwards and be exactly where you started. Overwriting or deleting content
 * that existed BEFORE this run destroys the only copy — that content exists
 * nowhere else on the machine. So:
 *
 *   create a new file                    → never asked   (nothing is lost)
 *   rewrite a file THIS RUN created      → never asked   (the agent revising
 *                                                         its own draft)
 *   write identical bytes                → never asked   (a no-op is not a
 *                                                         decision)
 *   scratch / build output               → never asked   (see the caveat below)
 *   overwrite pre-existing content       → ASK
 *   delete a pre-existing file           → ASK, highest risk
 *   a credential path, or `.acuvo/`      → ASK, whatever else is true
 *
 * On a realistic build that is a handful of questions, not forty, and every one
 * of them is a question a person would actually want.
 *
 * ⚠️ THE SCRATCH LIST IS A HEURISTIC AND IS LABELLED AS ONE. `dist/` being
 * regenerable is a convention, not a fact we can verify; someone's `dist/` is
 * hand-maintained. It is overridable for that reason, and it only ever
 * downgrades an overwrite to "not asked" — it never upgrades anything, so the
 * worst case is a question that should have been asked, in a directory whose
 * whole purpose is to be rebuilt.
 *
 * ⭐ AND `[a]ll remaining` IS A DELIBERATE ANSWER, NOT A CONVENIENCE. People
 * disengage from prompts; that is a fact about people, not a bug to design out.
 * The choice is whether disengagement is EXPLICIT and recorded once, or
 * simulated by forty reflex keystrokes. Offering "stop asking me" makes it the
 * former, and the run summary can then say "you approved the rest at file 3".
 *
 * ── ⚠️ THE DIFF ITSELF HAS TO BE HONEST ABOUT INVISIBLE CHANGES ─────────────
 *
 * A preview that renders a change as two identical-looking lines is worse than
 * no preview, because it invites a yes on a false reading. Three real cases,
 * all handled here rather than left to the eye:
 *
 *   · **CRLF ↔ LF.** Diffing lines with their terminators attached marks every
 *     line in the file changed and prints hundreds of `-foo` / `+foo` pairs.
 *     So lines are compared WITHOUT terminators and the ending change is
 *     reported in words instead: "line endings changed CRLF → LF".
 *   · **A trailing newline appearing or vanishing.** Zero visible line changes.
 *     Forced into a real `-`/`+` pair carrying git's
 *     `\ No newline at end of file` marker, which is the whole point of that
 *     marker existing.
 *   · **Trailing whitespace.** `-a` and `+a` where one has a space. Annotated
 *     on the line, because nobody has ever spotted that unaided.
 *
 * Pure throughout. No filesystem, no spawn, no network, no clock — the caller
 * supplies the before and after text, and every branch below is reachable from
 * a test with none of those things.
 */

/**
 * ⭐ IMPORTED, NEVER RE-IMPLEMENTED — `secret-paths.mjs` exists precisely
 * because two copies of "is this a credential?" drifted apart and which of a
 * user's secrets were protected depended on which verb the model picked.
 *
 * ⚠️ AND IT IS THE ONLY IMPORT, WHICH IS A MEASURED CONSTRAINT RATHER THAN A
 * PREFERENCE. `isPolicyProtectedPath` in `policy.mjs` answers the `.acuvo/`
 * question and would be the natural second import — but `policy.mjs` imports
 * `tools.mjs` → `command.mjs` → `workspace.mjs`, and `workspace.mjs` is where
 * this module gets called from. That is a cycle, and `secret-paths.mjs`'s own
 * header records what a cycle costs here: Node runs it happily, every test
 * passes, and `scripts/bundle.mjs` cannot topologically order it, so the break
 * lands at ship time. The `.acuvo/` predicate below is therefore a deliberate
 * two-line duplicate, and it is injectable so the lead can pass the real one in
 * from a layer that already has both.
 */
import { refusedCommitPath } from './secret-paths.mjs';

// ── caps ───────────────────────────────────────────────────────────────────

/**
 * Bigger than this and we do not attempt a diff.
 *
 * ⭐ Matched to `workspace.mjs`'s `MAX_READ_BYTES` (200_000) on purpose rather
 * than to `MAX_WRITE_BYTES` (400_000): a file this agent cannot READ as text is
 * one it cannot meaningfully show you either, so the two limits agreeing means a
 * user never meets a file that is diffable but not readable, or the reverse.
 */
export const MAX_DIFF_BYTES = 200_000;

/** A file taller than this is a data dump, not something a person reviews. */
export const MAX_DIFF_LINES = 20_000;

/**
 * ⚠️ ONE LONG LINE IS THE MINIFIED-BUNDLE CASE, and it defeats a line diff
 * completely: `dist/app.js` is a single 300KB line, so the "diff" is one `-`
 * and one `+` containing the entire file. Refusing is honest; printing that is
 * not a preview.
 */
export const MAX_DIFF_LINE_CHARS = 2_000;

/**
 * Myers is O((N+M)·D). D is small for real edits (the common prefix and suffix
 * are trimmed first), but two unrelated 5,000-line files have D ≈ 10,000 and
 * would take a noticeable second to compare for no benefit. Past this we say
 * "this file was replaced wholesale" — which is both true and the thing the
 * reviewer needed to know anyway.
 */
export const MAX_EDIT_DISTANCE = 3_000;

/** Unified-diff context lines either side of a change. Three is the universal default. */
export const DEFAULT_CONTEXT = 3;

/** How many diff lines a prompt prints before it truncates and says so. */
export const DEFAULT_PREVIEW_LINES = 60;

/** The way out of the truncation, named in the truncation message itself. */
export const DIFF_LINES_ENV = 'ACUVO_DIFF_LINES';

/** The env var that chooses the review mode, and the modes it accepts. */
export const APPROVE_ENV = 'ACUVO_APPROVE';
export const APPROVE_MODES = Object.freeze(['auto', 'always', 'never']);

/**
 * Directories whose contents are regenerated rather than authored. See the
 * header: a heuristic, only ever downgrades, and overridable.
 */
export const SCRATCH_PREFIXES = Object.freeze([
  'dist/', 'build/', 'out/', '.next/', '.turbo/', '.cache/',
  'coverage/', 'tmp/', '.tmp/', 'node_modules/',
]);

/** Risk, ordered. `auto` asks at `medium` and above. */
export const RISK_ORDER = Object.freeze({ none: 0, low: 1, medium: 2, high: 3 });

/**
 * Removing this fraction or more of a pre-existing file is the "it quietly
 * deleted something" case `report.mjs` was written to surface. It does not
 * change WHETHER we ask — an overwrite is asked about regardless — it changes
 * the risk label and the wording, so the dangerous one does not read like the
 * routine one.
 */
export const REWRITE_FRACTION = 0.5;

// ── line splitting ─────────────────────────────────────────────────────────

/**
 * Split into lines, keeping the terminators SEPARATELY.
 *
 * ⚠️ NOT `text.split('\n')`. That leaves a `\r` glued to the end of every line
 * of a CRLF file, which then compares unequal to the same line in an LF file and
 * marks the whole file changed. The terminators are kept because they are real
 * (a CRLF→LF flip is a genuine change) but they are compared separately, so the
 * change is reported once in words instead of once per line.
 *
 * A lone `\r` is a terminator too — old Mac line endings still turn up in
 * fixtures, and treating one as ordinary text would make a whole file into one
 * enormous line and then trip `MAX_DIFF_LINE_CHARS`.
 */
export function splitLines(text) {
  const s = String(text ?? '');
  const lines = [];
  const eols = [];
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\n') {
      lines.push(s.slice(start, i)); eols.push('\n'); start = i + 1;
    } else if (c === '\r') {
      if (s[i + 1] === '\n') { lines.push(s.slice(start, i)); eols.push('\r\n'); i += 1; } else { lines.push(s.slice(start, i)); eols.push('\r'); }
      start = i + 1;
    }
  }
  // Text after the last terminator is a line with no terminator — the case git
  // marks with `\ No newline at end of file`.
  if (start < s.length) {
    lines.push(s.slice(start));
    eols.push('');
    return { lines, eols, finalNewline: false };
  }
  return { lines, eols, finalNewline: true };
}

/** 'lf' | 'crlf' | 'cr' | 'mixed' | 'none' */
export function eolStyle(eols) {
  let lf = 0; let crlf = 0; let cr = 0;
  for (const e of eols) {
    if (e === '\n') lf += 1;
    else if (e === '\r\n') crlf += 1;
    else if (e === '\r') cr += 1;
  }
  const kinds = [lf > 0 ? 'lf' : null, crlf > 0 ? 'crlf' : null, cr > 0 ? 'cr' : null].filter(Boolean);
  if (kinds.length === 0) return 'none';
  if (kinds.length > 1) return 'mixed';
  return kinds[0];
}

// ── refusing to render ─────────────────────────────────────────────────────

/**
 * Can this pair be shown at all?
 *
 * ⭐ RETURNS THE REASON, AND THE REASON NAMES THE WAY OUT. "cannot render" on
 * its own is an obstacle; a reviewer who is told the file is binary and that
 * they can inspect it with `git diff` after the run has been given a decision.
 *
 * ⚠️ A REFUSAL TO *RENDER* IS NOT A REFUSAL TO *ASK*. The policy below still
 * runs, and the prompt still appears — it just carries sizes and a reason
 * instead of hunks. Silently skipping the question because we could not draw a
 * picture would mean the largest and least legible writes are the ones that
 * land unreviewed, which is precisely backwards.
 *
 * @returns {string|null}
 */
export function refuseToRender(before, after, { maxBytes = MAX_DIFF_BYTES, maxLines = MAX_DIFF_LINES, maxLineChars = MAX_DIFF_LINE_CHARS } = {}) {
  for (const [label, text] of [['the previous contents', before], ['the new contents', after]]) {
    if (text === null || text === undefined) continue;
    const s = String(text);
    if (s.includes('\u0000')) {
      return `${label} contain a NUL byte, so this is binary and a line diff of it would be noise. `
        + 'Inspect it with your own tools after the run (`git diff -- <path>` shows it as "Binary files differ").';
    }
    const bytes = Buffer.byteLength(s, 'utf8');
    if (bytes > maxBytes) {
      return `${label} are ${bytes} bytes, over the ${maxBytes}-byte preview limit. `
        + 'The change is still described by its counts below; review the file itself if the counts look wrong.';
    }
    const { lines } = splitLines(s);
    if (lines.length > maxLines) {
      return `${label} are ${lines.length} lines, over the ${maxLines}-line preview limit. `
        + 'The change is still described by its counts below; review the file itself if the counts look wrong.';
    }
    const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
    if (longest > maxLineChars) {
      return `${label} contain a ${longest}-character line, over the ${maxLineChars}-character limit — `
        + 'this is minified or generated, and a line diff of it shows the whole file as one changed line. '
        + 'Review the source it was generated from instead.';
    }
  }
  return null;
}

// ── the diff engine ────────────────────────────────────────────────────────

/**
 * Myers' greedy shortest-edit-script, returning ops or `null` when the two
 * files are too different to be worth aligning.
 *
 * ⚠️ `null` IS A REAL ANSWER AND MUST NOT BE TREATED AS "NO CHANGES". The
 * caller turns it into a wholesale replace, which is honest; a bug that read it
 * as "identical" would be a preview showing an empty diff for a total rewrite —
 * the single worst thing this module could do.
 */
function shortestEdit(a, b, maxEdits) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(maxEdits, n + m);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];

  for (let d = 0; d <= max; d += 1) {
    // ⚠️ Recorded BEFORE this round runs. The backtrack re-derives round d's
    // move from the state that preceded it, so storing the post-state here
    // would make every step off by one and silently mislabel insertions.
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m);
    }
  }
  return null;
}

function backtrack(trace, offset, n, m) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ sign: '=', oldIndex: x - 1, newIndex: y - 1 });
      x -= 1; y -= 1;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ sign: '+', oldIndex: -1, newIndex: y - 1 });
      else ops.push({ sign: '-', oldIndex: x - 1, newIndex: -1 });
    }
    x = prevX; y = prevY;
  }
  ops.reverse();
  return ops;
}

/**
 * Trim the shared head and tail before running Myers.
 *
 * Not an optimisation for its own sake: a one-line change in a 3,000-line file
 * has D = 2 after trimming and D = 2 before it only by luck of the algorithm's
 * shape. Trimming makes the `MAX_EDIT_DISTANCE` ceiling apply to how DIFFERENT
 * the files are rather than to how BIG they are, which is the property that
 * keeps ordinary edits to large files inside the fast path.
 */
function diffLines(a, b, maxEdits) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const mid = shortestEdit(midA, midB, maxEdits);
  if (mid === null) return null;

  const ops = [];
  for (let i = 0; i < head; i += 1) ops.push({ sign: '=', oldIndex: i, newIndex: i });
  for (const op of mid) {
    ops.push({
      sign: op.sign,
      oldIndex: op.oldIndex >= 0 ? op.oldIndex + head : -1,
      newIndex: op.newIndex >= 0 ? op.newIndex + head : -1,
    });
  }
  for (let i = 0; i < tail; i += 1) {
    ops.push({ sign: '=', oldIndex: a.length - tail + i, newIndex: b.length - tail + i });
  }
  return ops;
}

/** Every old line removed, then every new line added. The honest fallback. */
function wholesale(a, b) {
  const ops = [];
  for (let i = 0; i < a.length; i += 1) ops.push({ sign: '-', oldIndex: i, newIndex: -1 });
  for (let i = 0; i < b.length; i += 1) ops.push({ sign: '+', oldIndex: -1, newIndex: i });
  return ops;
}

function groupHunks(ops, context) {
  const changedAt = [];
  for (let i = 0; i < ops.length; i += 1) if (ops[i].sign !== '=') changedAt.push(i);
  if (changedAt.length === 0) return [];

  const groups = [];
  let start = changedAt[0];
  let end = changedAt[0];
  for (let i = 1; i < changedAt.length; i += 1) {
    // Two changes closer than 2×context share a hunk, otherwise their context
    // blocks would overlap and print the same lines twice.
    if (changedAt[i] - end <= context * 2 + 1) end = changedAt[i];
    else { groups.push([start, end]); start = changedAt[i]; end = changedAt[i]; }
  }
  groups.push([start, end]);

  // Running counts of how many old/new lines precede each op, so a hunk header
  // can be produced for a pure insertion (which has no old line to read a
  // number off).
  const oldBefore = new Array(ops.length);
  const newBefore = new Array(ops.length);
  let o = 0; let nw = 0;
  for (let i = 0; i < ops.length; i += 1) {
    oldBefore[i] = o; newBefore[i] = nw;
    if (ops[i].sign !== '+') o += 1;
    if (ops[i].sign !== '-') nw += 1;
  }

  return groups.map(([g0, g1]) => {
    const from = Math.max(0, g0 - context);
    const to = Math.min(ops.length - 1, g1 + context);
    const slice = ops.slice(from, to + 1);
    const oldLines = slice.filter((op) => op.sign !== '+').length;
    const newLines = slice.filter((op) => op.sign !== '-').length;
    return {
      oldStart: oldLines > 0 ? oldBefore[from] + 1 : oldBefore[from],
      oldLines,
      newStart: newLines > 0 ? newBefore[from] + 1 : newBefore[from],
      newLines,
      ops: slice,
    };
  });
}

function rangeText(start, count) {
  // git omits the count when it is 1; matching it means our output pastes into
  // `git apply` and into every diff viewer people already have.
  return count === 1 ? String(start) : `${start},${count}`;
}

/**
 * The unified diff for one file. PURE.
 *
 * `before === null` (or undefined) means the file did not exist — a creation.
 * `after === null` means it is being deleted. An EMPTY STRING is a real,
 * existing, empty file and is not the same thing as either; conflating them
 * would report "created" for a write that blanked a file, which is the exact
 * wording `tools.mjs` records as having frightened a reader once already.
 *
 * @param {string|null|undefined} before
 * @param {string|null|undefined} after
 * @param {string} path
 * @returns {{ok: true, ...} | {ok: false, ...}}
 */
export function diffUnified(before, after, path, {
  context = DEFAULT_CONTEXT,
  maxBytes = MAX_DIFF_BYTES,
  maxLines = MAX_DIFF_LINES,
  maxLineChars = MAX_DIFF_LINE_CHARS,
  maxEdits = MAX_EDIT_DISTANCE,
} = {}) {
  const rel = String(path ?? '');
  const existedBefore = before !== null && before !== undefined;
  const existsAfter = after !== null && after !== undefined;

  const kind = !existedBefore && existsAfter ? 'created'
    : existedBefore && !existsAfter ? 'deleted'
      : !existedBefore && !existsAfter ? 'absent'
        : String(before) === String(after) ? 'unchanged' : 'replaced';

  const base = {
    path: rel,
    kind,
    added: 0,
    removed: 0,
    beforeBytes: existedBefore ? Buffer.byteLength(String(before), 'utf8') : 0,
    afterBytes: existsAfter ? Buffer.byteLength(String(after), 'utf8') : 0,
  };

  if (kind === 'absent') {
    return { ok: false, ...base, reason: 'there is nothing to compare: the file neither existed before nor exists after' };
  }

  const refusal = refuseToRender(before, after, { maxBytes, maxLines, maxLineChars });
  if (refusal) {
    /**
     * ⚠️ `ok: false` HERE MEANS "NOT SHOWABLE", NOT "NOT HAPPENING". The counts
     * we can still compute are returned alongside, because a reviewer staring at
     * a refusal with no numbers has strictly less than they started with.
     */
    return { ok: false, ...base, reason: refusal, renderable: false };
  }

  const a = splitLines(existedBefore ? String(before) : '');
  const b = splitLines(existsAfter ? String(after) : '');

  const eol = {
    before: existedBefore ? eolStyle(a.eols) : 'none',
    after: existsAfter ? eolStyle(b.eols) : 'none',
    changed: false,
  };
  eol.changed = kind === 'replaced' && eol.before !== 'none' && eol.after !== 'none' && eol.before !== eol.after;

  if (kind === 'unchanged') {
    return {
      ok: true, ...base, eol, hunks: [], text: '', truncatedByDistance: false,
      noNewlineBefore: !a.finalNewline, noNewlineAfter: !b.finalNewline, invisible: false,
    };
  }

  let ops = diffLines(a.lines, b.lines, maxEdits);
  const truncatedByDistance = ops === null;
  if (truncatedByDistance) ops = wholesale(a.lines, b.lines);

  /**
   * ⚠️⚠️ A TRAILING NEWLINE THAT APPEARS OR VANISHES CHANGES ZERO LINES.
   * `"a\n"` → `"a"` is a real, byte-level change that every line-based diff
   * reports as nothing at all. Forcing the last line into a `-`/`+` pair is
   * what git does, and it is the only way the `\ No newline at end of file`
   * marker below ever gets somewhere to attach.
   */
  if (a.finalNewline !== b.finalNewline && existedBefore && existsAfter) {
    const last = ops[ops.length - 1];
    if (last && last.sign === '=') {
      ops = ops.slice(0, -1);
      ops.push({ sign: '-', oldIndex: last.oldIndex, newIndex: -1 });
      ops.push({ sign: '+', oldIndex: -1, newIndex: last.newIndex });
    }
  }

  const added = ops.filter((op) => op.sign === '+').length;
  const removed = ops.filter((op) => op.sign === '-').length;
  const hunks = groupHunks(ops, context).map(({ ops: hunkOps, ...h }) => ({
    ...h,
    lines: hunkOps.map((op) => ({
      /**
       * ⚠️ `=` IS AN INTERNAL TOKEN AND A UNIFIED DIFF USES A SPACE. Emitting
       * `=a` for a context line produced something that LOOKS like a diff in a
       * terminal and is rejected by `git apply`, by every review tool, and by
       * every editor's diff viewer. Caught by a test asserting `^ b$`; nothing
       * about the rendered output looked wrong to the eye.
       */
      sign: op.sign === '=' ? ' ' : op.sign,
      text: op.sign === '+' ? b.lines[op.newIndex] : a.lines[op.oldIndex],
      oldIndex: op.oldIndex,
      newIndex: op.newIndex,
    })),
  }));

  const result = {
    ok: true,
    ...base,
    added,
    removed,
    eol,
    hunks,
    truncatedByDistance,
    noNewlineBefore: existedBefore && !a.finalNewline,
    noNewlineAfter: existsAfter && !b.finalNewline,
    oldLineCount: a.lines.length,
    newLineCount: b.lines.length,
    /**
     * ⭐ THE FLAG THAT STOPS THE PREVIEW LYING. The bytes differ and the lines
     * do not, which today only happens for a pure line-ending flip. Without
     * this the renderer prints a header, no hunks, and reads as "nothing
     * changed" over a write that touches every byte in the file.
     */
    invisible: added === 0 && removed === 0 && kind === 'replaced',
  };
  result.text = renderUnified(result);
  return result;
}

/** `--- a/x` / `+++ b/x` / `@@` … — the pasteable form. */
export function renderUnified(diff) {
  if (!diff?.ok) return '';
  const lines = [];
  lines.push(`--- ${diff.kind === 'created' ? '/dev/null' : `a/${diff.path}`}`);
  lines.push(`+++ ${diff.kind === 'deleted' ? '/dev/null' : `b/${diff.path}`}`);
  for (const h of diff.hunks) {
    lines.push(`@@ -${rangeText(h.oldStart, h.oldLines)} +${rangeText(h.newStart, h.newLines)} @@`);
    for (const l of h.lines) {
      lines.push(`${l.sign}${l.text}`);
      if (l.sign !== '+' && diff.noNewlineBefore && l.oldIndex === diff.oldLineCount - 1) {
        lines.push('\\ No newline at end of file');
      } else if (l.sign === '+' && diff.noNewlineAfter && l.newIndex === diff.newLineCount - 1) {
        lines.push('\\ No newline at end of file');
      }
    }
  }
  return lines.join('\n');
}

// ── the policy ─────────────────────────────────────────────────────────────

/** `.acuvo/` — the directory holding `policy.json` and `mcp.json`. See the
 *  import note for why this is a deliberate duplicate rather than an import. */
export function isProtectedConfigPath(relPath) {
  if (typeof relPath !== 'string') return false;
  return relPath === '.acuvo' || relPath.startsWith('.acuvo/');
}

export function isScratchPath(relPath, prefixes = SCRATCH_PREFIXES) {
  const p = String(relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  return prefixes.some((prefix) => p === prefix.replace(/\/$/, '') || p.startsWith(prefix));
}

/**
 * Read the review mode.
 *
 * ⚠️ AN UNKNOWN VALUE IS AN ERROR, NOT A FALLBACK TO THE DEFAULT. `policy.mjs`
 * names this exact failure: `ACUVO_APPROVE=nver` is a person asking for a gate
 * and silently getting none, and the symptom is *everything works fine*.
 */
export function approvalMode({ env = process.env, flag = null } = {}) {
  if (flag !== null && flag !== undefined) {
    if (!APPROVE_MODES.includes(flag)) {
      return { ok: false, error: `review mode "${flag}" is not one of ${APPROVE_MODES.join(', ')}` };
    }
    return { ok: true, mode: flag, from: 'flag' };
  }
  const raw = String(env?.[APPROVE_ENV] ?? '').trim().toLowerCase();
  if (!raw) return { ok: true, mode: 'auto', from: 'default' };
  if (!APPROVE_MODES.includes(raw)) {
    return {
      ok: false,
      error: `${APPROVE_ENV}="${raw}" is not a review mode. Use one of ${APPROVE_MODES.join(', ')} — `
        + '"auto" asks only about writes that destroy something, "always" asks about every write, "never" asks about none.',
    };
  }
  return { ok: true, mode: raw, from: APPROVE_ENV };
}

/**
 * ⭐⭐ THE POLICY. Is a human's approval REQUIRED before this write lands, and
 * can it actually be obtained here?
 *
 * PURE. Everything it needs about the outside world — is there a terminal, did
 * this run create this file, what did the user already say — arrives as an
 * argument.
 *
 * @param {{path: string, before?: string|null, after?: string|null, exists?: boolean}} write
 * @returns {{required: boolean, satisfiable: boolean, risk: string, reason: string, blocked: boolean, reviewed: boolean, scope: string}}
 */
export function approvalDecision(write, {
  mode = 'auto',
  interactive = false,
  createdThisRun = null,
  sessionApproved = false,
  scratchPrefixes = SCRATCH_PREFIXES,
  isSecretPath = refusedCommitPath,
  isProtectedPath = isProtectedConfigPath,
  rewriteFraction = REWRITE_FRACTION,
} = {}) {
  const path = String(write?.path ?? '');
  const before = write?.before;
  const after = write?.after;
  const existedBefore = write?.exists ?? (before !== null && before !== undefined);
  const existsAfter = after !== null && after !== undefined;

  const madeByThisRun = typeof createdThisRun === 'function'
    ? Boolean(createdThisRun(path))
    : Boolean(createdThisRun && typeof createdThisRun.has === 'function' && createdThisRun.has(path));

  const risk = writeRisk({
    path, before, after, existedBefore, existsAfter, madeByThisRun,
    scratchPrefixes, isSecretPath, isProtectedPath, rewriteFraction,
  });

  const settled = (over) => ({
    required: false, satisfiable: true, blocked: false, reviewed: false, scope: 'write', risk: risk.level, ...over,
  });

  if (mode === 'never') {
    return settled({ reason: `review is switched off (${APPROVE_ENV}=never / --yes), so ${path} was written without asking` });
  }
  if (risk.level === 'none') {
    return settled({ reason: risk.why });
  }
  if (sessionApproved) {
    return settled({ reason: `you answered "all remaining" earlier in this run, so ${path} was not queried again` });
  }

  const needed = mode === 'always' || RISK_ORDER[risk.level] >= RISK_ORDER.medium;
  if (!needed) {
    return settled({ reason: risk.why });
  }

  if (!interactive) {
    if (mode === 'always') {
      /**
       * ⚠️ THE ONE FAIL-CLOSED BRANCH, AND THE ONLY ONE THAT EARNS IT. Somebody
       * stated an intent — "ask me about every write" — that cannot be honoured
       * here. Honouring it silently is impossible and ignoring it silently is
       * the fail-open shape `policy.mjs` refuses by name. So it stops, and it
       * names three ways forward rather than one.
       */
      return {
        required: true,
        satisfiable: false,
        blocked: true,
        reviewed: false,
        scope: 'write',
        risk: risk.level,
        reason: `${path}: you asked for every write to be approved, but stdin and stdout are not both terminals, so there is nobody here to ask `
          + '— and waiting for an answer that cannot arrive would hang this run instead of failing it.\n'
          + `Run it from a terminal to review the change, pass --yes (${APPROVE_ENV}=never) to write without review, `
          + `or ${APPROVE_ENV}=auto to review only the writes that destroy something.`,
      };
    }
    /**
     * ⭐ THE DEFAULT FAILS OPEN, DELIBERATELY, AND SAYS SO. See the header: a
     * review gate that breaks CI gets globally disabled and then protects
     * nobody. `reviewed: false` is what lets the run summary count these
     * honestly instead of implying they were seen.
     */
    return {
      required: false,
      satisfiable: false,
      blocked: false,
      reviewed: false,
      scope: 'write',
      risk: risk.level,
      reason: `${path}: ${risk.why}, but there is no terminal here to ask, so it was written WITHOUT review. `
        + `Run interactively to review it, or set ${APPROVE_ENV}=always to make an unattended run refuse rather than write.`,
    };
  }

  return {
    required: true,
    satisfiable: true,
    blocked: false,
    reviewed: false,
    scope: 'write',
    risk: risk.level,
    reason: risk.why,
  };
}

/**
 * How much of this write cannot be undone?
 *
 * ⭐ THE AXIS IS DESTRUCTION, NOT MODIFICATION. See the header. Everything here
 * is a statement about what stops existing if the write proceeds.
 */
export function writeRisk({
  path, before, after, existedBefore, existsAfter, madeByThisRun,
  scratchPrefixes = SCRATCH_PREFIXES,
  isSecretPath = refusedCommitPath,
  isProtectedPath = isProtectedConfigPath,
  rewriteFraction = REWRITE_FRACTION,
}) {
  /**
   * ⚠️ THE PATH CHECKS COME FIRST AND ARE NOT DOWNGRADEABLE. `.acuvo/mcp.json`
   * names a binary spawned on the NEXT run (`mcp-consent.mjs` exists entirely
   * because of that file), and a credential path is the one write whose damage
   * survives being reverted. Neither becomes safe by being small, new, or
   * inside `dist/`.
   */
  if (typeof isSecretPath === 'function' && isSecretPath(path)) {
    return { level: 'high', why: `${path} looks like a credential file, and this write ${existsAfter ? 'changes' : 'deletes'} it` };
  }
  if (typeof isProtectedPath === 'function' && isProtectedPath(path)) {
    return { level: 'high', why: `${path} is agent configuration — it decides what the NEXT run is allowed to do and which binaries it may spawn` };
  }

  if (existedBefore && !existsAfter) {
    return madeByThisRun
      ? { level: 'low', why: `${path} is being deleted, and this run created it — nothing that predates the run is lost` }
      : { level: 'high', why: `${path} is being DELETED, and its contents existed before this run started` };
  }

  if (!existedBefore) {
    return { level: 'low', why: `${path} is a new file — nothing is overwritten, and deleting it puts you back exactly where you were` };
  }

  /**
   * ⚠️ "IT EXISTS BUT WE COULD NOT READ IT" IS THE RISKIEST CASE, NOT A MISSING
   * ONE. A caller passes `exists: true` with no `before` when the file was too
   * big, binary, or unreadable. Falling through would compare the string
   * "undefined" against the new contents and produce a confidently wrong
   * "1 of its 1 pre-existing lines" — a number that reads like a measurement.
   */
  if (before === undefined || before === null) {
    return { level: 'high', why: `${path} exists but its current contents could not be read, so what this write overwrites cannot be shown to you` };
  }

  if (String(before) === String(after)) {
    // ⭐ A no-op write is not a decision, and asking about one teaches the
    // reflex that makes the real questions worthless.
    return { level: 'none', why: `${path} is written with identical contents — nothing changes` };
  }

  if (madeByThisRun) {
    return { level: 'low', why: `${path} was created by this run, so this is the agent revising its own draft` };
  }

  if (isScratchPath(path, scratchPrefixes)) {
    return { level: 'low', why: `${path} is under a build/scratch directory whose contents are regenerated rather than authored` };
  }

  const oldLines = splitLines(String(before)).lines.length;
  const newLines = splitLines(String(after)).lines.length;
  if (oldLines > 0) {
    const survives = commonLineCount(String(before), String(after));
    const lost = (oldLines - survives) / oldLines;
    if (lost >= rewriteFraction) {
      return {
        level: 'high',
        why: `${path} is being rewritten: ${oldLines - survives} of its ${oldLines} pre-existing lines do not appear in the new contents`
          + `${newLines < oldLines ? `, and the file shrinks to ${newLines} lines` : ''}`,
      };
    }
  }
  return { level: 'medium', why: `${path} already existed before this run, and this write replaces its contents` };
}

/**
 * How many of the old lines survive into the new text.
 *
 * ⚠️ DELIBERATELY A MULTISET COUNT, NOT THE LCS. It is used only to LABEL risk,
 * and it is O(n) rather than O(n·d) — running the full diff here would double
 * the work on every write for a heuristic, and `approvalDecision` is called for
 * writes that are never even shown.
 */
function commonLineCount(before, after) {
  const counts = new Map();
  for (const l of splitLines(after).lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  let survives = 0;
  for (const l of splitLines(before).lines) {
    const n = counts.get(l) ?? 0;
    if (n > 0) { counts.set(l, n - 1); survives += 1; }
  }
  return survives;
}

/**
 * Plan a whole batch in one pass — the granularity answer, made concrete.
 *
 * ⭐ The point is the SPLIT, not the loop: `auto` is the list a person is
 * actually asked about, and it is the short one. A caller that prints
 * `summariseApprovals` before the first question tells the user up front "6
 * files, 2 need you" — which is what stops the third question feeling like an
 * ambush and getting a reflex `y`.
 */
export function planApprovals(writes, options = {}) {
  const decisions = [];
  let sessionApproved = Boolean(options.sessionApproved);
  for (const w of writes ?? []) {
    const d = approvalDecision(w, { ...options, sessionApproved });
    decisions.push({ path: String(w?.path ?? ''), ...d });
    // ⚠️ Not mutated by this function: `sessionApproved` only ever arrives from
    // a real answer. Planning must not invent one.
  }
  return {
    decisions,
    ask: decisions.filter((d) => d.required && d.satisfiable),
    blocked: decisions.filter((d) => d.blocked),
    unreviewed: decisions.filter((d) => !d.required && !d.satisfiable),
    auto: decisions.filter((d) => !d.required && d.satisfiable),
  };
}

/** One line the caller can print before the first question. */
export function summariseApprovals(plan) {
  const total = plan?.decisions?.length ?? 0;
  const parts = [`${total} file${total === 1 ? '' : 's'} to write`];
  if (plan.ask.length) parts.push(`${plan.ask.length} need${plan.ask.length === 1 ? 's' : ''} your approval`);
  if (plan.blocked.length) parts.push(`${plan.blocked.length} cannot be approved here`);
  if (plan.unreviewed.length) parts.push(`${plan.unreviewed.length} will land without review`);
  if (plan.auto.length) parts.push(`${plan.auto.length} need no review`);
  return parts.join(' · ');
}

// ── the answer ─────────────────────────────────────────────────────────────

/**
 * Read what the human typed.
 *
 * ⚠️⚠️ EVERYTHING THAT IS NOT A YES IS NOT A YES. `null` (the stream ended
 * mid-question — `askOnce` returns exactly that) is an ABORT, empty is a
 * refusal, and an unrecognised word is a refusal that says which letters work.
 * A parser that fell through to "approve" on anything would turn a dying pipe
 * into consent, which is the failure `prompt.mjs`'s header spends a paragraph
 * on.
 */
export function interpretAnswer(raw) {
  if (raw === null || raw === undefined) {
    return { decision: 'abort', reason: 'the input ended before an answer arrived, and silence is not consent — nothing was written' };
  }
  const a = String(raw).trim().toLowerCase();
  if (a === 'y' || a === 'yes') return { decision: 'approve', reason: 'approved at the prompt' };
  if (a === 'a' || a === 'all') return { decision: 'approve-all', reason: 'approved, and the rest of this run will not be queried' };
  if (a === 'n' || a === 'no' || a === '') return { decision: 'reject', reason: 'declined at the prompt — the file was left as it was' };
  if (a === 'q' || a === 'quit') return { decision: 'abort', reason: 'stopped at the prompt — this write and everything after it was abandoned' };
  return {
    decision: 'reject',
    reason: `"${String(raw).trim()}" is not one of y / n / a / q, and an answer that is not a yes is treated as a no. `
      + 'The file was left as it was; answer y to apply it.',
  };
}

// ── the terminal view ──────────────────────────────────────────────────────

const NO_PAINT = { dim: (s) => s, bold: (s) => s, gold: (s) => s, green: (s) => s, red: (s) => s, cyan: (s) => s };

/** Honour the cap override, and refuse a nonsense one rather than silently ignoring it. */
export function previewLineCap({ env = process.env, fallback = DEFAULT_PREVIEW_LINES } = {}) {
  const raw = String(env?.[DIFF_LINES_ENV] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}

/**
 * The hunks, capped, with the cap STATED.
 *
 * ⚠️ "…and more" IS NOT A STATED CAP. A reader who is told 214 lines were
 * hidden but not why, or how to see them, has been told the preview is
 * incomplete and given no way to complete it — which is the same as being told
 * nothing, with extra anxiety.
 */
export function renderDiff(diff, { cap = DEFAULT_PREVIEW_LINES, paint = NO_PAINT, indent = '    ' } = {}) {
  if (!diff?.ok) return [];
  const out = [];
  const all = [];
  for (const h of diff.hunks) {
    all.push({ sign: '@', text: `@@ -${rangeText(h.oldStart, h.oldLines)} +${rangeText(h.newStart, h.newLines)} @@` });
    for (let i = 0; i < h.lines.length; i += 1) {
      const l = h.lines[i];
      let note = '';
      /**
       * ⭐ THE ANNOTATION THAT MAKES AN INVISIBLE EDIT VISIBLE. `-const a = 1;`
       * over `+const a = 1; ` are the same seven pixels wide in every terminal
       * ever made. Nobody catches this by looking, so the renderer says it.
       */
      const prev = h.lines[i - 1];
      if (l.sign === '+' && prev?.sign === '-' && prev.text !== l.text && prev.text.trimEnd() === l.text.trimEnd()) {
        note = paint.dim('    ⟵ trailing whitespace only');
      }
      all.push({ sign: l.sign, text: `${l.sign}${l.text}${note}` });
      if (l.sign !== '+' && diff.noNewlineBefore && l.oldIndex === diff.oldLineCount - 1) {
        all.push({ sign: '\\', text: '\\ No newline at end of file' });
      } else if (l.sign === '+' && diff.noNewlineAfter && l.newIndex === diff.newLineCount - 1) {
        all.push({ sign: '\\', text: '\\ No newline at end of file' });
      }
    }
  }

  const shown = all.slice(0, cap);
  for (const l of shown) {
    const colour = l.sign === '+' ? paint.green : l.sign === '-' ? paint.red : paint.dim;
    out.push(indent + colour(l.text));
  }
  if (all.length > shown.length) {
    out.push(indent + paint.dim(
      `… ${all.length - shown.length} more diff line${all.length - shown.length === 1 ? '' : 's'} hidden `
      + `(showing ${shown.length} of ${all.length}; the cap is ${cap}). `
      + `Set ${DIFF_LINES_ENV}=${all.length} to see all of it.`,
    ));
  }
  return out;
}

/**
 * The whole terminal view: what is changing, by how much, a capped look at it,
 * and the exact question.
 *
 * Returns the body and the prompt SEPARATELY, because the caller writes the
 * body to stderr and hands the prompt to `askOnce` — a single blob would print
 * the question twice or lose the cursor position.
 */
export function renderApproval(diff, decision, { cap = DEFAULT_PREVIEW_LINES, paint = NO_PAINT, path = null } = {}) {
  const rel = path ?? diff?.path ?? decision?.path ?? '';
  const lines = [];

  const kind = diff?.kind ?? 'replaced';
  const headline = kind === 'created' ? 'creates' : kind === 'deleted' ? 'DELETES' : 'changes';
  lines.push(`  ${paint.gold('✎')} ${paint.bold(rel)} — this ${headline} the file`);

  if (diff?.ok) {
    lines.push(`    ${paint.green(`+${diff.added}`)}  ${paint.red(`−${diff.removed}`)}`
      + (kind === 'replaced' ? paint.dim(`   (${diff.oldLineCount} lines → ${diff.newLineCount})`) : ''));
    if (diff.eol?.changed) {
      // ⭐ Reported in words rather than as N identical-looking ± pairs. See the header.
      lines.push(`    ${paint.dim(`line endings change ${diff.eol.before.toUpperCase()} → ${diff.eol.after.toUpperCase()} across the whole file`)}`);
    }
    if (diff.invisible) {
      lines.push(`    ${paint.dim('no line content changes — the bytes differ only in the line endings above')}`);
    }
    if (diff.noNewlineBefore !== diff.noNewlineAfter) {
      lines.push(`    ${paint.dim(diff.noNewlineAfter ? 'the trailing newline is REMOVED' : 'a trailing newline is added')}`);
    }
    if (diff.truncatedByDistance) {
      lines.push(`    ${paint.dim(`the two versions share too little to align (over ${MAX_EDIT_DISTANCE} edits), so this is shown as a wholesale replacement`)}`);
    }
    lines.push(...renderDiff(diff, { cap, paint }));
  } else {
    lines.push(`    ${paint.dim(`${diff?.beforeBytes ?? 0} bytes → ${diff?.afterBytes ?? 0} bytes`)}`);
    lines.push(`    ${paint.dim(`the change cannot be shown: ${diff?.reason ?? 'unknown'}`)}`);
  }

  if (decision?.risk === 'high') lines.push(`    ${paint.red('⚠')} ${decision.reason}`);
  else if (decision?.reason) lines.push(`    ${paint.dim(decision.reason)}`);

  return {
    body: lines.join('\n'),
    prompt: approvalPrompt(rel, kind),
    lines,
  };
}

/**
 * The exact question.
 *
 * ⚠️ `[y]es` IS LISTED FIRST AND IS STILL NOT THE DEFAULT — `interpretAnswer`
 * maps an empty answer to a refusal. The order reflects what a reviewer usually
 * wants; the default reflects what is safe when they hit return by accident.
 * `mcp-consent.mjs` uses `[y/N]` for the same reason, and this prompt has four
 * answers rather than two so the letters are spelled out.
 */
export function approvalPrompt(path, kind = 'replaced') {
  const verb = kind === 'deleted' ? 'Delete' : kind === 'created' ? 'Create' : 'Apply this change to';
  return `    ${verb} ${path}? [y]es / [n]o / [a]ll remaining / [q]uit `;
}
