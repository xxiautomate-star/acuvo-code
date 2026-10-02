/**
 * ── ⭐⭐⭐ THE SEND-ONCE LEDGER ─────────────────────────────────────────────
 *
 * The CLI had NO read-dedupe — zero occurrences — while the builder has had one
 * since 2026-08. Because this package's history is APPEND-ONLY, a duplicate
 * result is not paid once: it is paid on the round it arrives and on every
 * round after it, so its cost is `characters × rounds remaining`.
 *
 * These tests pin four things:
 *
 *   1. the two traps from the builder's own header — CONTENT-keyed (never
 *      request-keyed, or the read after an edit is suppressed) and STARTS EMPTY
 *      (or the model is handed a pointer to bytes it never received);
 *   2. that it can never make a round BIGGER;
 *   3. the measured saving, end to end, through a real `runSession`;
 *   4. ⚠️ the interaction with `compact.mjs`, which without a guard would delete
 *      the very message the pointer points at.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createResultLedger, POINTER_MARK, isLedgerPointer } from '../lib/result-ledger.mjs';
import { compactMessages } from '../lib/compact.mjs';
import { runSession, formatSummary } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const big = (seed, n = 9_000) => `${seed}\n`.repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);
const rec = (name, args) => ({ name, args });

/* ────────────────────────────────────────────────────────────────────────────
 * (1) the two traps
 * ──────────────────────────────────────────────────────────────────────────── */

test('an identical repeat read returns a POINTER, not the bytes', () => {
  const l = createResultLedger();
  const text = big('line of source');
  assert.equal(l.forSend(rec('read_file', { path: 'a.ts' }), text, 1), text, 'the FIRST read must be sent in full');
  const second = l.forSend(rec('read_file', { path: 'a.ts' }), text, 2);
  assert.ok(isLedgerPointer(second), `second read was not a pointer: ${second.slice(0, 120)}`);
  assert.ok(second.length < text.length / 5, 'a pointer that is not much smaller is not worth having');
  assert.match(second, /a\.ts/, 'the pointer must name what it points at');
});

test('⚠️⚠️ THE TRAP: the read AFTER AN EDIT is sent in full, because the CONTENT changed', () => {
  /**
   * This is the failure a request-keyed ledger ships. `read_file {path:"a.ts"}`
   * is the SAME REQUEST before and after an edit, so a ledger keyed on the
   * request alone answers "you already have it" about bytes that no longer
   * exist — and suppresses the single read the model most needs.
   */
  const l = createResultLedger();
  const before = big('the old body');
  const after = big('the NEW body');
  l.forSend(rec('read_file', { path: 'a.ts' }), before, 1);
  const reread = l.forSend(rec('read_file', { path: 'a.ts' }), after, 2);
  assert.equal(reread, after, 'a re-read after an edit MUST return the new bytes in full');
  assert.ok(!isLedgerPointer(reread));
});

test('⚠️⚠️ THE OTHER TRAP: it starts EMPTY — nothing is a pointer until its bytes went out', () => {
  const l = createResultLedger();
  const text = big('never sent before');
  assert.equal(l.forSend(rec('read_file', { path: 'fresh.ts' }), text, 1), text);
  assert.equal(l.report().hits, 0, 'the first send of anything can never be a hit');
});

test('a one-character difference is a full send — the comparison is bytes, not "did we read this"', () => {
  const l = createResultLedger();
  const a = big('x');
  const b = `${a} `;
  l.forSend(rec('read_file', { path: 'a.ts' }), a, 1);
  assert.equal(l.forSend(rec('read_file', { path: 'a.ts' }), b, 2), b);
});

test('two DIFFERENT paths with identical content are both sent in full', () => {
  // ⚠️ The key is the request; the comparison is the content. Collapsing these
  // would answer "b.ts is already above" by pointing at a.ts.
  const l = createResultLedger();
  const text = big('same bytes');
  l.forSend(rec('read_file', { path: 'a.ts' }), text, 1);
  assert.equal(l.forSend(rec('read_file', { path: 'b.ts' }), text, 2), text);
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2) it can never make a round bigger
 * ──────────────────────────────────────────────────────────────────────────── */

test('a SHORT identical result is left alone — a pointer longer than the payload is a loss', () => {
  const l = createResultLedger();
  const tiny = 'exit 0';
  l.forSend(rec('run_command', { command: 'ls' }), tiny, 1);
  const again = l.forSend(rec('run_command', { command: 'ls' }), tiny, 2);
  assert.equal(again, tiny, 'replacing 6 characters with a 300-character sentence is a loss, every round');
  assert.equal(l.report().hits, 0);
});

test('every pointer this module emits is strictly smaller than what it replaced', () => {
  const l = createResultLedger();
  for (const [name, args] of [
    ['read_file', { path: 'some/deeply/nested/path/to/a/file.ts' }],
    ['run_command', { command: 'a'.repeat(400) }],
    ['evaluate', { command: 'node -e "console.log(1)"' }],
    ['list_dir', { path: '.' }],
  ]) {
    const text = big('payload', 20_000);
    l.forSend(rec(name, args), text, 1);
    const p = l.forSend(rec(name, args), text, 2);
    assert.ok(p.length < text.length, `${name} pointer was not smaller`);
  }
  const r = l.report();
  assert.equal(r.hits, 4);
  assert.ok(r.savedChars > 60_000, `expected a large saving, got ${r.savedChars}`);
});

test('tools OUTSIDE the read/command vocabulary are never deduplicated', () => {
  // ⚠️ `write_file`, `edit_file` and the creative verbs report an ACTION. Two
  // identical "wrote 400 bytes" lines describe two different events.
  const l = createResultLedger();
  const text = big('wrote it');
  l.forSend(rec('write_file', { path: 'a.ts' }), text, 1);
  assert.equal(l.forSend(rec('write_file', { path: 'a.ts' }), text, 2), text);
});

test('two ledgers do not share state — one per run, never module-level', () => {
  const text = big('shared?');
  const a = createResultLedger();
  const b = createResultLedger();
  a.forSend(rec('read_file', { path: 'x.ts' }), text, 1);
  assert.equal(b.forSend(rec('read_file', { path: 'x.ts' }), text, 1), text,
    'a second run was handed a pointer into a conversation it is not having');
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) the command case — the one the bench corpus actually measures
 * ──────────────────────────────────────────────────────────────────────────── */

test('a POLL whose output has not changed is answered with "nothing has changed"', () => {
  /**
   * MEASURED over the 139-run bench corpus: 204 of 1,057 commands (19.3%) were
   * byte-for-byte re-runs of a command issued earlier in the same run, across 44
   * runs. One run re-ran `tail -2 /tmp/rinstall.log; ps aux | ...` **36 times**.
   * The saving is real; so is the SIGNAL, which is the half a token count misses
   * — the model is polling and being told, in words, that it is.
   */
  const l = createResultLedger();
  const out = big('waiting for the install to finish', 4_000);
  l.forSend(rec('run_command', { command: 'tail -2 /tmp/rinstall.log' }), out, 3);
  const p = l.forSend(rec('run_command', { command: 'tail -2 /tmp/rinstall.log' }), out, 4);
  assert.ok(isLedgerPointer(p));
  assert.match(p, /NOTHING HAS CHANGED/, 'the pointer must tell the model the poll is not progressing');
  assert.match(p, /round 3/, 'it must say WHEN, so the model can scroll to it');
});

test('a poll whose output FINALLY changed is sent in full', () => {
  const l = createResultLedger();
  l.forSend(rec('run_command', { command: 'ls out/' }), big('nothing yet', 4_000), 1);
  const changed = big('BUILD COMPLETE', 4_000);
  assert.equal(l.forSend(rec('run_command', { command: 'ls out/' }), changed, 2), changed);
});

/* ────────────────────────────────────────────────────────────────────────────
 * (4) ⚠️⚠️ THE INTERACTION WITH THE COMPACTOR
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ the compactor must NOT delete the full copy a pointer points at', () => {
  /**
   * Without the `isLedgerPointer` guards in `compact.mjs`, these two passes
   * cancel out into a hole:
   *   · the ledger replaces the LATER identical result with a pointer;
   *   · `passSupersededReads` deletes the EARLIER one because "an identical
   *     read was issued again later".
   * The model is then told to scroll back to something that was deleted.
   */
  const full = big('the only copy of this file', 30_000);
  const pointer = `${POINTER_MARK} "a.ts" is UNCHANGED since it was last read (round 1), and that result is already above.`;
  const call = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    call('c1', 'read_file', { path: 'a.ts' }),
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: full },
    call('c2', 'read_file', { path: 'a.ts' }),
    { role: 'tool', tool_call_id: 'c2', name: 'read_file', content: pointer },
    // padding so the compactor has a reason to act and the pair is compactable
    ...Array.from({ length: 6 }, (_, i) => [
      call(`p${i}`, 'run_command', { command: `echo ${i}` }),
      { role: 'tool', tool_call_id: `p${i}`, name: 'run_command', content: big(`noise ${i}`, 20_000) },
    ]).flat(),
  ];
  const fit = compactMessages(messages, { budgetTokens: 4_000, keepLastRounds: 1 });
  const survivor = fit.messages[3].content;
  /**
   * ⚠️ THE ASSERTION IS ON THE STUB, NOT ON BYTE EQUALITY. `giant-results` may
   * legitimately cut the middle out of a very large read and say so — that is
   * compaction doing its declared job, and the text is still there. What must
   * never happen is `superseded-reads` replacing it with "an identical read was
   * issued later", because the only later read is a pointer BACK TO THIS ONE.
   */
  assert.ok(!/^\[superseded /.test(survivor),
    `the compactor stubbed the ONLY full copy of a.ts while a pointer claimed it was still above:\n${survivor.slice(0, 200)}`);
  assert.match(survivor, /the only copy of this file/, 'the content vanished entirely');
  // and the pointer itself is never stubbed either — there is nothing to win
  assert.ok(isLedgerPointer(fit.messages[5].content), 'the pointer was rewritten by the compactor');
});

test('⚠️⚠️ a pointer is never STUBBED either — read, pointer, edit, read again', () => {
  /**
   * ── THE SHAPE THE FIRST VERSION OF THIS FILE MISSED ────────────────────────
   *
   * Mutation testing found it: deleting the "skip a pointer as a candidate"
   * line in `passSupersededReads` left the suite GREEN, because in the simple
   * read → pointer transcript the pointer's index is always AFTER the newest
   * full copy and the ordinary `newest <= r.index` check already excludes it.
   *
   * ⭐ IT BECOMES REACHABLE THE MOMENT A FULL COPY ARRIVES LATER — read, point
   * back, EDIT, read again. Now the newest full copy is at the END, the pointer
   * sits between them, and without the guard the compactor stubs a
   * 300-character pointer into a ~350-character "[superseded …, N characters of
   * stale content were dropped]" — bigger than what it replaced, and a false
   * statement, since nothing was dropped.
   */
  const pointer = `${POINTER_MARK} "a.ts" is UNCHANGED since it was last read (round 1), and that result is already above.${' '.repeat(500)}`;
  const call = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    call('c1', 'read_file', { path: 'a.ts' }),
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: big('the ORIGINAL body', 5_000) },
    call('c2', 'read_file', { path: 'a.ts' }),
    { role: 'tool', tool_call_id: 'c2', name: 'read_file', content: pointer },
    call('c3', 'read_file', { path: 'a.ts' }),
    { role: 'tool', tool_call_id: 'c3', name: 'read_file', content: big('the EDITED body', 5_000) },
  ];
  /**
   * ⚠️ THE BUDGET AND `keepLastRounds: 0` ARE BOTH LOAD-BEARING, and the first
   * version of this test had neither. `superseded-reads` walks candidates
   * newest-first and STOPS the moment the transcript fits, so a 620-character
   * pointer beside two 5,000-character reads is never reached at an ordinary
   * budget. Squeezing hard is what makes the guard's own branch execute — and
   * without that squeeze, deleting the guard left the suite green.
   */
  const fit = compactMessages(messages, { budgetTokens: 200, keepLastRounds: 0 });
  const survivingPointer = fit.messages[5].content;
  assert.ok(!/^\[superseded /.test(survivingPointer),
    `the compactor stubbed a POINTER — it replaced ${pointer.length} characters with something larger `
    + `and claimed stale content was dropped:\n${survivingPointer.slice(0, 200)}`);
  assert.ok(isLedgerPointer(survivingPointer), 'the pointer was rewritten');
});

/* ────────────────────────────────────────────────────────────────────────────
 * (5) ⭐ THE MEASUREMENT, END TO END, THROUGH A REAL `runSession`
 * ──────────────────────────────────────────────────────────────────────────── */

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const usage = (prompt) => ({
  cost: 0.0001, total_tokens: prompt + 40, prompt_tokens: prompt, completion_tokens: 40,
  prompt_tokens_details: { cached_tokens: 0 },
});

test('⭐ MEASURED: a file read on four rounds is sent ONCE, and the saving compounds', async (t) => {
  const dir = workspace(t);
  const body = 'export const x = 1; // a line of a real source file\n'.repeat(160); // ~8.2 KB
  writeFileSync(join(dir, 'a.ts'), body);

  const READS = 4;
  const requests = [];
  let n = 0;
  const outcome = await runSession({
    task: 'read it repeatedly, the way a confused model does',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    maxRounds: 10,
    onEvent: () => {},
    callModelImpl: async (opts) => {
      requests.push(JSON.parse(JSON.stringify(opts.messages)));
      n += 1;
      if (n <= READS) {
        return {
          ok: true,
          content: 'looking again',
          toolCalls: [{ id: `c${n}`, function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.ts' }) } }],
          usage: usage(3_000), finishReason: 'tool_calls',
        };
      }
      return { ok: true, content: 'done', toolCalls: [], usage: usage(3_000), finishReason: 'stop' };
    },
  });

  const d = outcome.dedupe;
  assert.ok(d, 'the outcome must REPORT the saving — an invisible saving is indistinguishable from an unwired one');
  assert.equal(d.hits, READS - 1, `expected ${READS - 1} suppressed copies, got ${d.hits}`);

  /**
   * The two numbers, both taken from THIS run:
   *  · `full`    — the size of the one copy that was genuinely sent (round 2's
   *                transcript contains it verbatim).
   *  · `pointer` — what each later copy became.
   * The saving is `(full − pointer) × rounds it would have been re-sent`,
   * because the history is append-only.
   */
  const sent = requests[1].filter((m) => m.role === 'tool').map((m) => m.content);
  const full = sent[0].length;
  const pointers = requests.at(-1).filter((m) => m.role === 'tool' && isLedgerPointer(m.content));
  assert.equal(pointers.length, READS - 1);
  const pointerLen = pointers[0].content.length;

  const roundsUsed = outcome.roundsUsed;
  let byteRounds = 0;
  for (let r = 2; r <= READS; r += 1) byteRounds += (full - pointerLen) * (roundsUsed - r + 1);

  // The final request is the one that carries every earlier result. Compare it
  // against what it would have been with four full copies in it.
  const actualFinal = JSON.stringify(requests.at(-1)).length;
  const counterfactualFinal = actualFinal + (full - pointerLen) * (READS - 1);

  console.log(
    `\n  [ledger] read_file a.ts, ${full} chars, read ${READS}x over ${roundsUsed} rounds`
    + `\n  [ledger] final request: ${actualFinal.toLocaleString()} chars WITH the ledger`
    + ` vs ${counterfactualFinal.toLocaleString()} without  (−${(100 * (1 - actualFinal / counterfactualFinal)).toFixed(1)}%)`
    + `\n  [ledger] character-rounds kept off the wire: ${byteRounds.toLocaleString()}\n`,
  );

  assert.ok(actualFinal < counterfactualFinal * 0.75,
    `the ledger saved less than 25% of the final request: ${actualFinal} vs ${counterfactualFinal}`);
  assert.ok(d.savedChars > 6_000 * (READS - 1) * 0.8, `savedChars looks wrong: ${d.savedChars}`);

  // ⭐ and it is stated to the human, not only to the JSON
  const summary = formatSummary(outcome).join('\n');
  assert.match(summary, /identical tool results were not re-sent/,
    `the summary never mentioned the saving:\n${summary}`);
});

test('⭐ MEASURED: the read AFTER a real edit still arrives in full, through the whole loop', async (t) => {
  /**
   * ⚠️ THE END-TO-END VERSION OF THE TRAP. Unit-testing the ledger proves the
   * comparison; only driving the real loop proves that what reaches it is the
   * FINAL rendered text, so an edit really does change the bytes it compares.
   */
  const dir = workspace(t);
  writeFileSync(join(dir, 'a.ts'), 'const before = 1;\n'.repeat(400));

  const requests = [];
  let n = 0;
  const outcome = await runSession({
    task: 'read, edit, read again',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    maxRounds: 8,
    onEvent: () => {},
    callModelImpl: async (opts) => {
      requests.push(JSON.parse(JSON.stringify(opts.messages)));
      n += 1;
      const call = (name, args) => ({
        ok: true, content: '', usage: usage(3_000), finishReason: 'tool_calls',
        toolCalls: [{ id: `c${n}`, function: { name, arguments: JSON.stringify(args) } }],
      });
      if (n === 1) return call('read_file', { path: 'a.ts' });
      if (n === 2) return call('write_file', { path: 'a.ts', content: 'const after = 2;\n'.repeat(400) });
      if (n === 3) return call('read_file', { path: 'a.ts' });
      return { ok: true, content: 'done', toolCalls: [], usage: usage(3_000), finishReason: 'stop' };
    },
  });

  const finalTools = requests.at(-1).filter((m) => m.role === 'tool');
  const reads = finalTools.filter((m) => m.name === 'read_file');
  assert.equal(reads.length, 2);
  assert.ok(!isLedgerPointer(reads[1].content),
    'the read after the edit was suppressed — this is the exact bug a request-keyed ledger ships');
  assert.match(reads[1].content, /const after = 2/, 'the re-read must carry the NEW bytes');
  assert.equal(outcome.dedupe.hits, 0);
});
