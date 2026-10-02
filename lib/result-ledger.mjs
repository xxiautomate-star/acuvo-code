/**
 * ── ⭐⭐⭐ THE SEND-ONCE LEDGER — THE CLI's MISSING `shownToModel` ───────────
 *
 * The builder (`console/lib/agentic-build.ts`) has had this since 2026-08. This
 * package had **zero occurrences of it**: every repeat `read_file` was a second
 * full copy of bytes the model already had, and — because the history here is
 * APPEND-ONLY — that copy is then re-sent on every round for the rest of the
 * session. The cost of one duplicate is `bytes × rounds remaining`, not `bytes`.
 *
 * `compact.mjs` already knows this is waste: its `superseded-reads` and
 * `stale-commands` passes exist to delete exactly these duplicates. But those
 * passes only run when the transcript crosses the compaction water mark, and
 * ⚠️ **MEASURED OVER THE 139-RUN BENCH CORPUS, COMPACTION FIRED ZERO TIMES** —
 * including on the run that burned 5,654,530 tokens over 84 rounds. So in
 * practice the duplicate is paid in full, always. And when compaction *does*
 * fire it pays for the saving by REWRITING THE PREFIX, which voids the cache on
 * everything behind the cut. This ledger buys the same saving for nothing: the
 * bytes never enter the transcript, so no earlier byte moves and the cached
 * prefix is untouched.
 *
 * ── THE TWO TRAPS, INHERITED FROM THE BUILDER'S HEADER ─────────────────────
 *
 * ⚠️ **KEYED ON CONTENT, NEVER ON "did we send this before".** A ledger keyed on
 * the request alone would suppress the read that matters most — the one AFTER an
 * edit. Here the request is only the MAP KEY; the decision is a byte comparison
 * of the outgoing text against what last went out for that key. Any difference
 * at all — an edit, a rebuild, a poll whose output finally changed, a different
 * exit code — falls straight through and is sent in full.
 *
 * ⚠️⚠️ **IT STARTS EMPTY AND NOTHING MAY SEED IT.** The builder's first attempt
 * seeded it from the workspace and handed the model a pointer to bytes it had
 * never been given. The invariant here is literal and is the reason `remember`
 * is only ever called with the string the caller is about to push:
 *
 *   ⭐ a key appears in this ledger only after its exact bytes went into the
 *     transcript, and the bytes recorded are the bytes that went out.
 *
 * ── ⚠️ AND A POINTER THAT IS BIGGER THAN THE PAYLOAD IS A LOSS ─────────────
 *
 * `compact.mjs`'s `stale-commands` pass carries the same guard (`removed <= 200`
 * → skip) for the same reason: most command outputs are two lines, and a
 * "this is identical to earlier" sentence is longer than `ok`. Below the floor
 * the original is sent unchanged, so the ledger can never make a round bigger.
 */

import {
  COMMAND_TOOLS, LEDGER_POINTER_MARK, READ_TOOLS, isLedgerPointer, requestKey, subjectLabel,
} from './compact.mjs';

/**
 * ⚠️ THE SENTINEL IS LOAD-BEARING AND IS MATCHED, NOT PARSED. `compact.mjs`
 * needs to recognise a pointer so its supersede passes do not delete the very
 * message a pointer points AT — see its `LEDGER_POINTER_MARK` block and the two
 * call sites in `passSupersededReads` / `passStaleCommands`. It leads the string
 * so the test is a `startsWith` and cannot be fooled by a file that quotes it.
 *
 * ⚠️ RE-EXPORTED, NEVER RE-SPELLED. The literal is defined once, in the module
 * that has to recognise it, and the dependency runs one way only.
 */
export const POINTER_MARK = LEDGER_POINTER_MARK;
export { isLedgerPointer };

/**
 * The floor a saving must clear before a pointer replaces the real text.
 *
 * ⚠️ NOT ZERO, AND NOT A TASTE JUDGEMENT. The pointer sentence is ~300
 * characters; replacing a 40-character `exit 0` with it costs 260 characters
 * per round for the rest of the run. 600 keeps every replacement a clear win
 * even against the longest pointer this module emits.
 */
export const MIN_POINTER_SAVING_CHARS = 600;

/** Tools whose result this ledger will consider deduplicating. */
export function ledgerCovers(name) {
  return READ_TOOLS.has(name) || COMMAND_TOOLS.has(name);
}

function readPointer(label, text, round) {
  return `${POINTER_MARK} "${label}" is UNCHANGED since it was last read${round ? ` (round ${round})` : ''}, `
    + `and that result — all ${text.length.toLocaleString()} characters of it — is already above in this `
    + 'conversation, so it is not repeated here. Scroll back rather than re-reading. '
    + 'If you edit the file, the next read returns the new content in full.';
}

function commandPointer(label, text, round) {
  const short = label.length > 120 ? `${label.slice(0, 117)}...` : label;
  return `${POINTER_MARK} \`${short}\` produced BYTE-IDENTICAL output to when it was last run${round ? ` (round ${round})` : ''} — `
    + `same exit status, same ${text.length.toLocaleString()} characters — so it is already above and is not repeated here. `
    + '⚠️ NOTHING HAS CHANGED SINCE. Re-running it again will not change that; '
    + 'change something first, or take a different approach.';
}

/**
 * Build a per-run ledger.
 *
 * ⚠️ PER RUN, NEVER MODULE-LEVEL STATE. `runSession` can be called more than
 * once in one process (subagents, `delegate`, the test suite), and a ledger
 * shared between two transcripts would hand run B a pointer into run A's
 * history — the "pointer to bytes it never received" bug, rebuilt at a
 * different scope.
 */
export function createResultLedger({ minSaving = MIN_POINTER_SAVING_CHARS } = {}) {
  /** key → { text, round } — the exact string last SENT for this request. */
  const sent = new Map();
  const savings = [];

  return {
    /**
     * What should actually be pushed for this record.
     *
     * @param {{ name?: string, args?: object }} record
     * @param {string} text the fully-rendered result, exactly as it would be sent
     * @param {number|null} round
     * @returns {string} `text`, or a pointer to the identical earlier copy
     */
    forSend(record, text, round = null) {
      const name = record?.name;
      if (typeof text !== 'string' || !name || !ledgerCovers(name)) return text;
      const key = requestKey(name, record?.args ?? {});
      const prev = sent.get(key);
      if (!prev || prev.text !== text) {
        // ⭐ RECORD WHAT WENT OUT. Not the file, not the result object — the
        // string the caller is about to put in the transcript.
        sent.set(key, { text, round });
        return text;
      }
      const label = subjectLabel(name, record?.args ?? {});
      const pointer = READ_TOOLS.has(name)
        ? readPointer(label, text, prev.round)
        : commandPointer(label, text, prev.round);
      if (text.length - pointer.length < minSaving) return text;
      savings.push({ round, name, subject: label, saved: text.length - pointer.length });
      return pointer;
    },

    /** What this ledger kept out of the transcript. Read-only; for the receipt. */
    report() {
      const saved = savings.reduce((s, r) => s + r.saved, 0);
      return { hits: savings.length, savedChars: saved, entries: [...savings] };
    },
  };
}
