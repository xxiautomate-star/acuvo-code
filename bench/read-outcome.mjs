/**
 * ── ⭐⭐ WHAT THE BENCH BELIEVES ABOUT A RUN ─────────────────────────────────
 *
 * Every number the bench reports used to be scraped out of the human summary
 * with a regex, and this file's siblings record THREE separate times that
 * pattern matched the wrong thing: a fixture's own "$7.50" read as the run's
 * cost, and a summary warning captured instead of the model's reply.
 *
 * ⭐ A benchmark whose inputs come from prose we keep improving is a benchmark
 * that scores the improvements as regressions. `--json` now carries all of it
 * structurally, so the document is the source of truth for NUMBERS and the
 * transcript stays the source for BEHAVIOUR.
 *
 * ⚠️ THE PROSE FALLBACK STAYS, and is not vestigial: a run that crashes before
 * emitting a document still has a transcript, and a bench that reports zero for
 * a run that really cost money is worse than one that reads a regex.
 *
 * Pure, and separate from the runner, so the part with a three-bug history is
 * the part that can be tested without spawning a process or spending anything.
 */
export function readOutcome(doc, out = '') {
  const text = String(out ?? '');
  return {
    cost: typeof doc?.costUsd === 'number'
      ? doc.costUsd
      : Number(text.match(/tokens\s*·\s*\$([0-9.]+)/)?.[1] ?? 0),
    rounds: typeof doc?.rounds === 'number'
      ? doc.rounds
      : Number(text.match(/·\s*(\d+) rounds?\s*·/)?.[1] ?? 0),
    /**
     * ⚠️ `verification.passed` IS THE FACT; "✔ VERIFIED" is a rendering of it.
     * Reading the glyph meant the bench agreed with whatever the summary said —
     * including, until today, a fabricated green check for an HTTP probe that
     * was never a command and had no exit code.
     */
    verified: typeof doc?.verification?.passed === 'boolean'
      ? doc.verification.passed === true
      : /✔ VERIFIED/.test(text),
  };
}
