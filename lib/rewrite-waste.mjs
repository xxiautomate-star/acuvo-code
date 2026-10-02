/**
 * ── ⭐⭐⭐ THE PROMPT ALREADY SAYS IT. THE MODEL DOES IT ANYWAY. ──────────────
 *
 * `turn.mjs` has told the model since forever that `edit_file` changes PART of a
 * file and that rewriting a whole one is the most expensive move it can make.
 * The builder measured what that advice is worth: a real build emitted **~53,000
 * output tokens over 12 rounds** for a finished artifact of ~7,000 tokens, and
 * output was **56% of the bill** ($0.045 of $0.080).
 *
 * ⚠️ AND OUTPUT IS THE HALF NO CACHING WORK CAN EVER REACH. A prompt cache
 * discounts input; it discounts output by exactly nothing. `cost-units.mjs`
 * prices an output token at **11.25 units against a cache hit's 1** — so a
 * needless rewrite is the single most expensive thing that happens in a run.
 *
 * ── ⚠️⚠️ PORTED FROM THE BUILDER, WHERE IT WAS ALREADY PROVEN ───────────────
 *
 * `console/lib/rewrite-waste.ts` has shipped this since 2026-08-20, wired into
 * `agentic-build.ts` at the write site. **The CLI — the thing actually published
 * on npm — had no equivalent at all**, so the surface with paying users was the
 * surface with no signal. This is that module, unchanged in behaviour, as ESM
 * with no dependencies.
 *
 * ── ⭐ IT MEASURES RATHER THAN REFUSES, AND THAT IS THE WHOLE DESIGN ────────
 *
 * `loop-hygiene.ts` states the rule this follows: *"ADVISORY, NEVER A VETO …
 * our instinct in this codebase has been to REFUSE — and refusing is worse,
 * because the model keeps the better judgement about its own next step and a
 * false positive costs one sentence instead of a whole round."*
 *
 * ⚠️ AND REFUSING WOULD NOT EVEN SAVE THE MONEY. By the time a `write_file`
 * arrives the output tokens are ALREADY SPENT — the same reason `budget.record`
 * never throws. Refusing buys a second round at full price. What changes the
 * bill is the NEXT call, and what changes the next call is a number: self-
 * critique with no external signal went down or flat in six settings out of six,
 * while real feedback moved repaired-and-passing from 33.3% to 52.6%.
 *
 * "Prefer edit_file" is advice the model has already ignored. "You emitted
 * 24,000 characters to change 900" is a fact it can act on.
 */

/**
 * ⚠️ A SMALL FILE IS NOT WORTH A SENTENCE. Every character of feedback is paid
 * for on every subsequent round, so nagging about a 40-byte rewrite costs more
 * than the rewrite did.
 */
export const MIN_BYTES_TO_REPORT = 2_000;

/** Below this the rewrite genuinely changed most of the file — that is fine. */
export const MIN_WASTE_RATIO = 0.5;

/**
 * How much of a whole-file write was already on disk.
 *
 * ⚠️ MEASURED AS A COMMON PREFIX AND SUFFIX, not a real diff. A character-level
 * diff of two 30KB files on every write is real CPU on the hot path, and the
 * decision this feeds — "did you rewrite a file to change a little of it" — does
 * not need edit distance. Prefix + suffix catches the overwhelmingly common
 * shape: a change in the middle, or an appended block, with everything else
 * byte-identical.
 *
 * ⚠️ It UNDERSTATES waste for a change in two distant places, which is the safe
 * direction: it can only ever under-report, never accuse the model of waste it
 * did not commit.
 *
 * Pure.
 */
export function rewriteWaste(before, after) {
  const old = typeof before === 'string' ? before : '';
  const next = typeof after === 'string' ? after : String(after ?? '');
  if (!old || !next) {
    return { wrote: next.length, unchanged: 0, wasteRatio: 0, worthSaying: false };
  }

  const max = Math.min(old.length, next.length);
  let prefix = 0;
  while (prefix < max && old[prefix] === next[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < max - prefix
    && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1;

  const unchanged = Math.min(prefix + suffix, Math.min(old.length, next.length));
  const wasteRatio = next.length > 0 ? unchanged / next.length : 0;
  return {
    wrote: next.length,
    unchanged,
    wasteRatio,
    worthSaying: next.length >= MIN_BYTES_TO_REPORT && wasteRatio >= MIN_WASTE_RATIO,
  };
}

/**
 * The sentence handed back with the tool result, or null when there is nothing
 * worth the tokens.
 *
 * ⭐ IT NAMES THE ALTERNATIVE AND THE NUMBER. "Prefer edit_file" is the advice
 * the model already ignored; "you emitted 24,000 characters to change 900" is a
 * fact it can act on, and the difference between those two sentences is the
 * whole reason this module exists.
 */
export function rewriteWasteNote(path, waste) {
  if (!waste || !waste.worthSaying) return null;
  const changed = Math.max(0, waste.wrote - waste.unchanged);
  const pct = Math.round(waste.wasteRatio * 100);
  return `⚠️ You rewrote all ${waste.wrote.toLocaleString()} characters of \`${path}\` to change about `
    + `${changed.toLocaleString()} of them — ${pct}% of what you just emitted was already on disk. `
    + `Output is the most expensive thing you spend and it is never cached. Use \`edit_file\` for a change `
    + `this size; keep \`write_file\` for a file that is new or genuinely rewritten.`;
}

/**
 * ── ⭐⭐ THE READ THAT MAKES THE COMPARISON POSSIBLE, AND ITS COST BOUND ─────
 *
 * The builder holds the project in a Map, so `before` is free there. The CLI
 * writes to a real filesystem, so the old bytes have to be read back — and a
 * read on every single write would be a tax paid by every build, including the
 * overwhelming majority that write something small or something new.
 *
 * ⭐ SO THE CHEAP TEST COMES FIRST. A write under `MIN_BYTES_TO_REPORT` can
 * never be `worthSaying`, whatever is on disk, so there is nothing to learn from
 * reading — the guard is skipped before any I/O happens. Above that threshold a
 * disk read of at most a few hundred KB costs microseconds and is weighed
 * against output tokens at 11.25 units each.
 *
 * ⚠️ IT READS THROUGH THE EXECUTOR, never `fs`. That is what keeps the
 * in-memory backend, `--dry-run` and the read-only `--plan` executor answering
 * the same as the filesystem one — the rule `write_files`'s approval diff
 * already follows two hundred lines below.
 *
 * ⚠️ AND IT CANNOT FAIL A WRITE. An unreadable or absent file is simply "new",
 * which reports nothing. A bookkeeping read that could throw on the write path
 * would be a meter that breaks the build it is measuring.
 */
export function wasteNoteForWrite(executor, path, content) {
  if (typeof content !== 'string' || content.length < MIN_BYTES_TO_REPORT) return null;
  let before = null;
  try {
    const r = executor?.readFile?.(path);
    if (r && r.ok !== false && typeof r.content === 'string') before = r.content;
  } catch {
    return null;
  }
  if (before === null) return null;
  return rewriteWasteNote(path, rewriteWaste(before, content));
}
