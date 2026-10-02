/**
 * ── ⭐⭐⭐ 62 MB IN, 20 KB OUT — AND THE 20 KB IS THE PART THAT MATTERS ───────
 *
 * MEASURED on Roman's laptop, for ONE project: 41 Claude Code transcripts,
 * 665.4 MB total, **largest single session 62.3 MB**, median 11.5 MB. A 1M-token
 * context is about 4 MB of text.
 *
 * ⇒ **The largest single session is ~15× too big to replay into our biggest
 * window.** "Import the chat history" is not a hard feature, it is an impossible
 * one. Carry-over is DISTILLATION, not transport. `CARRY-OVER.md` §1.
 *
 * ── ⭐⭐ THE ARCHITECTURE THAT FALLS OUT OF THAT NUMBER ──────────────────────
 *
 * Two stages, and the order is the whole trick:
 *
 *   1. **MECHANICAL REDUCTION — this file.** Deterministic, free, no model, no
 *      network. Streams the JSONL and keeps only what a model could not
 *      reconstruct for itself.
 *   2. **MODEL DISTILLATION — later, and cheap BECAUSE of stage 1.** Summarising
 *      20 KB costs a fraction of a cent. Summarising 62 MB is not possible at
 *      any price.
 *
 * ⚠️ THE OBVIOUS BUILD IS ONE STAGE AND IT DOES NOT WORK: hand the transcript to
 * a model and ask for a summary. It does not fit, and chunking it means paying
 * to summarise megabytes of `ls` output.
 *
 * ── ⭐⭐⭐ WHAT WE KEEP, AND WHY IT IS MOSTLY THE FAILURES ────────────────────
 *
 * A transcript's SUCCESSES are already in the code — the new agent reads them
 * for free, faster and more accurately than any summary. What dies when the tab
 * closes, and exists nowhere else:
 *
 *   · what was TRIED AND FAILED, and why
 *   · what the user CORRECTED or rejected
 *   · the constraint discovered the hard way
 *
 * ⚠️ Without those, the new agent's first hour re-derives the wall the old one
 * already hit — and it is the FIRST thing a chat summary drops, because
 * summarisers optimise for what happened rather than what was ruled out.
 *
 * So the bulk of a transcript — successful tool results, file dumps, directory
 * listings — is DISCARDED ON PURPOSE. It is the restatable part.
 *
 * ── ⚠️ BOUNDED AT EVERY EDGE, BECAUSE THE INPUT IS ADVERSARIALLY LARGE ──────
 * A 62 MB file, lines that are themselves megabytes, and thousands of records.
 * Every accumulator here has a cap; nothing grows with the input.
 *
 * ── ⚠️⚠️ AND TRANSCRIPTS CONTAIN SECRETS ────────────────────────────────────
 * Tool output routinely prints API keys, and `~/.claude/.credentials.json` sits
 * one directory ABOVE the transcript store. Everything kept is redacted on the
 * way out. See `redactSecrets`.
 */

/** Caps. Each bounds a value that would otherwise grow with a 62 MB input. */
export const LIMITS = Object.freeze({
  maxLineBytes: 512 * 1024, // a single record larger than this is a payload, not a turn
  maxIntents: 40,
  maxFailures: 60,
  maxCorrections: 30,
  maxFiles: 120,
  textClip: 400, // per kept fragment
});

/**
 * ⚠️ CONSERVATIVE AND SHAPE-BASED, NOT NAME-BASED. Matching on `key`/`token` in
 * a VARIABLE NAME misses `ghp_...` printed bare in stdout, which is the actual
 * way a transcript leaks. These match the SHAPE of well-known credentials plus a
 * generic long-opaque-string rule.
 *
 * ⚠️ It will over-redact occasionally (a long hash reads as a secret). That is
 * the correct direction to be wrong in: a redacted hash costs a person one
 * question, a leaked token costs them their account.
 */
const SECRET_PATTERNS = [
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /**
   * ⚠️ NO `\b` BEFORE THE WORD, AND THAT IS NOT A TYPO. `\b` requires a
   * non-word character on the left, so it does NOT match inside
   * `DATABASE_PASSWORD=` — `_` and `P` are both word characters. The most
   * common real shape of a leaked credential in tool output is exactly an
   * env-var assignment with a prefix, so the boundary excluded the main case.
   */
  /(?:secret|token|password|passwd|api[_-]?key)\s*[:=]\s*["']?([^\s"']{12,})/gi,
];

export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    /**
     * ⚠️⚠️ `typeof === 'string'` IS LOAD-BEARING, AND THE OBVIOUS VERSION
     * SILENTLY DID NOTHING. `String.replace` calls back with
     * `(match, p1..pN, offset, string)` — so for a pattern with NO capture
     * group, the second argument is the OFFSET, a number. The first draft read
     * it as a capture: `offset` was truthy, so it ran `m.replace(12, '…')`,
     * which matches no substring and **returned the token unchanged**.
     *
     * ⭐ EVERY SECRET PATTERN WITHOUT A GROUP LEAKED, AND THE FUNCTION LOOKED
     * CORRECT. Caught only because the test asserted the token was ABSENT from
     * the output rather than that redaction "ran".
     */
    out = out.replace(re, (m, ...rest) => {
      const captured = typeof rest[0] === 'string' ? rest[0] : null;
      return captured ? m.replace(captured, '[redacted]') : '[redacted]';
    });
  }
  return out;
}

const clip = (s, n = LIMITS.textClip) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Pull the content blocks out of a record, whatever wrapper shape it uses. */
function blocksOf(rec) {
  const content = rec?.message?.content ?? rec?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

/**
 * ⚠️ AN ERROR IS A SHAPE *OR* A PREFIX, AND BOTH ARE NEEDED. `is_error` is the
 * honest signal and it is not always set — a command that exits non-zero often
 * comes back as ordinary text beginning "Error:". Relying on the flag alone
 * loses most real failures; relying on the text alone matches a file that merely
 * contains the word.
 */
function isFailure(block) {
  if (block?.is_error === true) return true;
  const t = typeof block?.content === 'string' ? block.content : '';
  return /^\s*(error|exception|traceback|fatal|refused|failed)\b/i.test(t)
    || /\b(command failed|exit code [1-9]|test(s)? failed|\d+ failed)\b/i.test(t.slice(0, 600));
}

/**
 * ⭐ A CORRECTION IS THE USER SAYING "NO". It is the highest-signal, lowest-volume
 * thing in a transcript: the human overruling the agent, which is a decision no
 * amount of reading the code can recover.
 */
const CORRECTION = /\b(no,|don't|do not|stop|revert|undo|that's wrong|thats wrong|not what i|instead of|actually,|wrong|nope|never )/i;

/**
 * Reduce one transcript to the parts a model could not reconstruct.
 *
 * @param lines an iterable of raw JSONL lines (a generator, so a 62 MB file is
 *   never held in memory as one string)
 */
export function reduceTranscript(lines, { limits = LIMITS } = {}) {
  const intents = [];
  const failures = [];
  const corrections = [];
  const files = new Set();
  let records = 0;
  let skippedHuge = 0;
  let bytesIn = 0;

  for (const raw of lines) {
    const line = typeof raw === 'string' ? raw : '';
    if (!line.trim()) continue;
    bytesIn += line.length;
    if (line.length > limits.maxLineBytes) { skippedHuge += 1; continue; }

    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    records += 1;

    const role = rec?.message?.role ?? rec?.type;

    for (const b of blocksOf(rec)) {
      if (b?.type === 'text' && role === 'user') {
        const text = clip(b.text);
        if (!text) continue;
        /**
         * ⚠️ A CORRECTION IS ALSO AN INTENT, AND IT IS FILED AS BOTH. Dropping it
         * from `intents` to avoid a duplicate would lose the thread of what the
         * user was asking for at the moment they pushed back.
         */
        if (CORRECTION.test(text) && corrections.length < limits.maxCorrections) {
          corrections.push(redactSecrets(text));
        }
        if (intents.length < limits.maxIntents) intents.push(redactSecrets(text));
      }

      if (b?.type === 'tool_use') {
        const p = b?.input?.file_path ?? b?.input?.path ?? b?.input?.notebook_path;
        if (typeof p === 'string' && files.size < limits.maxFiles) files.add(p);
      }

      /**
       * ⭐⭐ THE COLUMN THE WHOLE FEATURE EXISTS FOR. Successful tool results are
       * the bulk of the bytes and are discarded; failures are kept.
       */
      if (b?.type === 'tool_result' && isFailure(b) && failures.length < limits.maxFailures) {
        const body = typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content) ? b.content.map((c) => c?.text ?? '').join(' ') : '';
        const text = clip(body);
        if (text) failures.push(redactSecrets(text));
      }
    }
  }

  return {
    records,
    skippedHuge,
    bytesIn,
    intents,
    failures,
    corrections,
    files: [...files],
  };
}

/**
 * Render the reduction as the brief a model (or a person) reads.
 *
 * ⚠️ IT NEVER CLAIMS THE `DONE` COLUMN. A transcript records what the OLD agent
 * BELIEVED it had finished, and importing that belief unchecked is how we
 * inherit somebody else's *"builds clean"* at the moment of first impression —
 * this repo's own most expensive habit. The brief states the goal, the failures
 * and the corrections, and tells the reader to verify the rest against the tree.
 */
export function ledgerBrief(reduced) {
  if (!reduced || !reduced.records) return null;
  const out = [];
  const push = (title, items) => {
    if (!items.length) return;
    out.push('', title);
    for (const i of items) out.push(`  - ${i}`);
  };

  out.push('CARRIED OVER FROM A PREVIOUS SESSION (distilled, not replayed)');
  push('GOAL — what was being asked for, oldest first:', reduced.intents.slice(0, 8));
  push('⭐ REJECTED / FAILED — do NOT repeat these:', reduced.failures.slice(0, 12));
  push('⭐ THE USER CORRECTED THE LAST AGENT HERE:', reduced.corrections.slice(0, 8));
  push('FILES TOUCHED:', reduced.files.slice(0, 30));

  out.push(
    '',
    '⚠️ This is a DISTILLATION of a transcript, not the transcript. Nothing here is',
    '   evidence that anything works — the previous agent may have believed it',
    '   finished something it did not. Verify against the actual tree before',
    '   building on any of it.',
  );
  return out.join('\n');
}

/** How much was thrown away — the number that justifies the design. */
export function reductionRatio(reduced, briefText) {
  const out = Buffer.byteLength(briefText ?? '', 'utf8');
  if (!reduced?.bytesIn || !out) return null;
  return { bytesIn: reduced.bytesIn, bytesOut: out, ratio: reduced.bytesIn / out };
}
