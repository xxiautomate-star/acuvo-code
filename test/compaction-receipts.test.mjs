/**
 * ── ⚠️⚠️ THE COMPACTOR'S FLOOR STILL SCALED WITH THE RESULT COUNT ───────────
 *
 * The tightening loop (`compact.mjs`, 2026-08-13) fixed the FIXED-clamp
 * plateau: 4,000 characters per result became 400. It did not fix the shape of
 * the floor, which is still N × a constant — and measured on this module's own
 * output a floor-clamped result is **~714 characters**, because the clamp keeps
 * 400 characters PLUS the ~310-character marker explaining the cut.
 *
 * So at the 60-round horizon this module exists to unlock:
 *
 *     100 results × 714 chars ≈  71,400 chars ≈ 17,850 estimated tokens
 *     200 results × 714 chars ≈ 142,800 chars ≈ 35,700 estimated tokens  ← over
 *                                                  a 24,000-token budget on
 *                                                  its own, whatever we ask for
 *
 * ⭐ THE FIFTH PASS KEEPS ONE LINE PER RESULT AND MAKES IT A POINTER. 400
 * characters of head-and-tail from a source file are two fragments nobody can
 * act on; the same space spent naming the tool and the subject that fetch it
 * back is a fact the model can DO something with. Recovery is the difference.
 *
 * ── ⚠️⚠️ WHAT THIS FILE MOSTLY DEFENDS: WHEN IT MUST *NOT* RUN ──────────────
 *
 * The first version ran on any over-budget transcript and went red on four
 * existing tests — every one an UNREACHABLE budget (10 or 100 tokens against an
 * untouchable head). There the receipt destroyed the last copy of a body and
 * STILL reported `underBudget: false`: the most destructive cut in the module,
 * spent for nothing. The precondition is therefore derived rather than
 * invented — simulate receipting everything eligible, and take the pass only if
 * that clears the budget.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compactMessages, MIN_CLAMP_CHARS } from '../lib/compact.mjs';

/* ── transcript builders (re-derived here, like compact.test.mjs does) ────── */

let idSeq = 0;
const nextId = () => `receipt_call_${++idSeq}`;

const call = (name, args, id = nextId()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const head = () => [
  { role: 'system', content: 'You are acuvo, a terminal coding agent.' },
  { role: 'user', content: 'TASK: work through this large repository.' },
];
function round(note, name, args, body) {
  const c = call(name, args);
  return [{ role: 'assistant', content: note, tool_calls: [c] }, { role: 'tool', tool_call_id: c.id, name, content: body }];
}

/** N distinct large file reads — nothing superseded, nothing searched, nothing re-run. */
function manyBigReads(n, chars = 8_000) {
  const msgs = [...head()];
  for (let i = 0; i < n; i += 1) {
    msgs.push(...round(`reading ${i}`, 'read_file', { path: `src/mod${i}.ts` }, `HEAD${i}\n${'x'.repeat(chars)}\nTAIL${i}`));
  }
  return msgs;
}

const toolsOf = (out) => out.messages.filter((m) => m.role === 'tool');

/**
 * ⚠️ MEASURED, NOT PICKED. On the 60-read fixture below, clamping alone floors
 * at **11,871 estimated tokens** whatever budget is asked for, and receipting
 * everything eligible lands at ~4,600. 8,000 sits between the two, so the
 * fixture is unreachable by the old code and reachable by the new — and it
 * leaves a MIX (37 receipts, 23 clamps) rather than a clean sweep, which is what
 * makes the "tallies still add up" and "cheaper stubs are never overwritten"
 * assertions below capable of failing at all.
 */
const BUDGET = 8_000;

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ THE DEFECT, STATED AS ARITHMETIC
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ the floor no longer scales at ~714 chars a result — a budget the clamp cannot reach is now reached', () => {
  const msgs = manyBigReads(60);

  /**
   * ⭐⭐ THE OLD FLOOR, MEASURED RATHER THAN ASSERTED FROM ARITHMETIC. A budget
   * of 1 token is unreachable by anything, so the receipts precondition refuses
   * and this run is EXACTLY what the module did before the fifth pass existed:
   * every result clamped to `MIN_CLAMP_CHARS`, and that total is the floor.
   *
   * ⚠️ Without this control the fixture could quietly stop biting — a smaller
   * clamp marker, a leaner transcript — and the test would keep passing while
   * proving nothing. "The guard was satisfied by coincidence" is a recorded
   * failure in this repo; a measured control is the cure.
   */
  const clampOnly = compactMessages(msgs, { budgetTokens: 1, keepLastRounds: 0, maxResultChars: 4_000 });
  assert.equal(clampOnly.report.clampChars, MIN_CLAMP_CHARS, 'the control must have driven the clamp to its floor');
  assert.equal(clampOnly.report.passes.find((p) => p.pass === 'receipts'), undefined, 'and it must not have receipted');
  assert.ok(clampOnly.report.afterTokens > BUDGET,
    `clamping alone floors at ${clampOnly.report.afterTokens} tokens; the fixture must be UNREACHABLE at ${BUDGET} or this proves nothing`);

  const out = compactMessages(msgs, { budgetTokens: BUDGET, keepLastRounds: 0, maxResultChars: 4_000 });
  assert.equal(out.report.underBudget, true, 'the whole point: a budget clamping could not reach is now reached');
  assert.ok(out.report.afterTokens <= BUDGET);
  const receipts = out.report.passes.find((p) => p.pass === 'receipts');
  assert.ok(receipts && receipts.applied > 0, 'and it was the fifth pass that got there, not something else');
});

test('⭐⭐ a receipt is ONE LINE, names the tool and subject, and says how to get it back', () => {
  const out = compactMessages(manyBigReads(60), { budgetTokens: BUDGET, keepLastRounds: 0 });
  const receipted = out.report.actions.filter((a) => a.pass === 'receipts');
  assert.ok(receipted.length > 0, 'the fixture must actually produce receipts');

  for (const a of receipted) {
    const text = out.messages[a.index].content;
    assert.equal(text.includes('\n'), false, `a receipt with a newline is not a receipt: ${JSON.stringify(text.slice(0, 120))}`);
    assert.match(text, /read_file/, 'the TOOL that fetches it back must be named');
    assert.match(text, /src\/mod\d+\.ts/, 'and the SUBJECT, or the model cannot re-issue the call');
    assert.match(text, /Re-run/, 'a drop that does not say how to recover is just a hole');
    /**
     * ⚠️ THE CHARACTER COUNT MUST BE THE ORIGINAL, not the length of whatever
     * clamp this replaced. A receipt sitting on top of a 400-char clamp that
     * claimed "400 chars removed" would understate its own cut by 20x — the
     * quietly-wrong number this package refuses to ship.
     */
    const stated = Number(/([\d,]+) chars/.exec(text)[1].replace(/,/g, ''));
    assert.equal(stated, a.beforeChars, `the receipt claims ${stated} chars but ${a.beforeChars} were there`);
  }
});

test('⭐ a receipt really is far smaller than the floor clamp it replaces', () => {
  const out = compactMessages(manyBigReads(60), { budgetTokens: BUDGET, keepLastRounds: 0 });
  const receipted = out.report.actions.filter((a) => a.pass === 'receipts');
  for (const a of receipted) {
    assert.ok(a.afterChars < MIN_CLAMP_CHARS,
      `a receipt of ${a.afterChars} chars is no better than the ${MIN_CLAMP_CHARS}-char clamp floor it replaced`);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️⚠️ WHEN IT MUST NOT RUN — the half that four existing tests demanded
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ an UNREACHABLE budget does not get the destructive cut — the head and tail survive', () => {
  /**
   * One giant result and a budget of 100 tokens. The head alone is bigger than
   * that, so no amount of compaction reaches it. Receipting would destroy the
   * only copy of the body AND still report `underBudget: false` — losing twice.
   */
  const body = `HEAD-MARKER\n${'m'.repeat(60_000)}\nTAIL-MARKER`;
  const msgs = [...head(), ...round('r', 'fetch_url', { url: 'https://x' }, body)];
  const out = compactMessages(msgs, { budgetTokens: 100, keepLastRounds: 0, maxResultChars: 2_000 });

  const text = toolsOf(out)[0].content;
  assert.ok(text.startsWith('HEAD-MARKER'), 'the head must survive a budget nothing could reach');
  assert.ok(text.endsWith('TAIL-MARKER'), 'and the tail');
  assert.equal(out.report.passes.find((p) => p.pass === 'receipts'), undefined,
    'the pass must not even be recorded as run when it could not have helped');
  assert.equal(out.report.underBudget, false, 'and the honest failure is still reported');
});

test('⚠️ a transcript that fits after tightening never reaches the fifth pass', () => {
  const msgs = manyBigReads(14, 9_000);
  const out = compactMessages(msgs, { budgetTokens: 3_000, keepLastRounds: 0, maxResultChars: 4_000 });
  assert.ok(out.report.tightenRounds > 0, 'the fixture must drive tightening');
  assert.equal(out.report.underBudget, true);
  assert.equal(out.report.passes.find((p) => p.pass === 'receipts'), undefined,
    'receipts are the LAST resort — a transcript clamping can save must keep its verbatim head and tail');
});

test('⚠️⚠️ POSTCONDITION: whenever the fifth pass RUNS, it reaches the budget — swept across 196 of them', () => {
  /**
   * ── ⚠️⚠️ WRITTEN BECAUSE A MUTATION SURVIVED, WHICH IS THE ONLY REASON A
   * TEST LIKE THIS EVER GETS WRITTEN ────────────────────────────────────────
   *
   * Deleting the `prior.pass !== 'giant-results'` line from the ELIGIBILITY loop
   * left every test in this file green. `apply` has its own copy of that guard,
   * so nothing was actually overwritten — but the SIMULATION started counting
   * savings it could never take, over-promised, and let receipts run on
   * transcripts they could not rescue. Measured with the line deleted: **11 of
   * 196 budgets destroyed content AND still reported `underBudget: false`**,
   * which is precisely the losing-twice outcome the precondition exists to stop.
   *
   * ⭐ A single fixture could not see it, because the flip needs the stubs'
   * phantom savings to be worth more than the margin. So this asserts the
   * PROPERTY instead of a number: if the pass ran, the budget was reached. That
   * is true by construction of the precondition and cannot be satisfied by
   * coincidence.
   */
  const msgs = [...head()];
  // 40 reads that a later identical read supersedes → 40 cheap stubs the
  // simulation must NOT count as receiptable.
  for (let i = 0; i < 40; i += 1) msgs.push(...round(`dup ${i}`, 'read_file', { path: `src/dup${i}.ts` }, `D${i}\n${'d'.repeat(6_000)}`));
  for (let i = 0; i < 40; i += 1) msgs.push(...round(`uniq ${i}`, 'read_file', { path: `src/u${i}.ts` }, `U${i}\n${'u'.repeat(6_000)}`));
  for (let i = 0; i < 40; i += 1) msgs.push(...round(`dup again ${i}`, 'read_file', { path: `src/dup${i}.ts` }, `fresh ${i}`));

  let ran = 0;
  const violations = [];
  for (let b = 500; b <= 20_000; b += 100) {
    const out = compactMessages(msgs, { budgetTokens: b, keepLastRounds: 0, maxResultChars: 4_000 });
    if (!out.report.passes.some((p) => p.pass === 'receipts')) continue;
    ran += 1;
    if (!out.report.underBudget) violations.push(`${b} → ${out.report.afterTokens}`);
  }
  assert.ok(ran > 10, `the sweep only reached the fifth pass ${ran} times — the fixture is not exercising it`);
  assert.deepEqual(violations, [],
    'the fifth pass destroyed content and STILL missed the budget at these budgets — it must never be taken unless it works');
});

test('⚠️ a transcript already under budget is returned byte-for-byte, as it always was', () => {
  const msgs = manyBigReads(3, 200);
  const out = compactMessages(msgs, { budgetTokens: 100_000, keepLastRounds: 0 });
  assert.equal(out.dropped, 0);
  assert.deepEqual(out.messages, msgs);
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️ WHAT A RECEIPT MAY NEVER OVERWRITE
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ a receipt never replaces a superseded-read stub — that stub is smaller AND more informative', () => {
  /**
   * The same file read twice plus enough unrelated bulk to drive the compactor
   * all the way to the fifth pass. The stale copy must keep the sentence saying
   * a later identical read supersedes it; a receipt would replace an explanation
   * with a pointer to a call the model has ALREADY made.
   */
  const msgs = [...head()];
  msgs.push(...round('first', 'read_file', { path: 'src/dup.ts' }, `DUP\n${'d'.repeat(30_000)}`));
  for (let i = 0; i < 60; i += 1) {
    msgs.push(...round(`reading ${i}`, 'read_file', { path: `src/mod${i}.ts` }, `HEAD${i}\n${'x'.repeat(8_000)}\nTAIL${i}`));
  }
  msgs.push(...round('again', 'read_file', { path: 'src/dup.ts' }, 'the current dup.ts'));

  const out = compactMessages(msgs, { budgetTokens: BUDGET, keepLastRounds: 0 });
  const stale = toolsOf(out)[0];
  assert.match(stale.content, /superseded read_file of src\/dup\.ts/,
    'the fifth pass overwrote a cheaper, better stub');
  const [firstAction] = out.report.actions;
  assert.equal(firstAction.pass, 'superseded-reads');
});

test('⚠️ a result already SMALLER than its receipt is left exactly alone', () => {
  /**
   * `apply` refuses any candidate that would GROW a message, and a receipt is
   * ~150 characters — so a 30-character tool result must come through untouched
   * even on the harshest budget. A "compaction" that grows the payload is the
   * defect `passStaleCommands` already guards against.
   */
  const msgs = manyBigReads(60);
  msgs.push(...round('tiny', 'read_file', { path: 'src/tiny.ts' }, 'ok'));
  const out = compactMessages(msgs, { budgetTokens: BUDGET, keepLastRounds: 0 });
  const last = toolsOf(out).at(-1);
  assert.equal(last.content, 'ok');
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️⚠️ THE INVARIANT, RE-DERIVED — a receipt must not break the conversation
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ INVARIANT: every tool_call still has its answering tool message, in order', () => {
  const msgs = manyBigReads(60);
  const out = compactMessages(msgs, { budgetTokens: BUDGET, keepLastRounds: 0 });

  assert.equal(out.report.refused, false, 'the structural guard must not have had to reject this');
  assert.equal(out.messages.length, msgs.length, 'a message was removed — that is a 400 on every round after it');
  for (let i = 0; i < msgs.length; i += 1) {
    assert.equal(out.messages[i].role, msgs[i].role, `role changed at ${i}`);
    assert.equal(out.messages[i].tool_call_id, msgs[i].tool_call_id, `tool_call_id changed at ${i}`);
  }
  // Re-derived rather than borrowed from the implementation's own checker.
  for (let i = 0; i < out.messages.length; i += 1) {
    const m = out.messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    const answers = [];
    let j = i + 1;
    while (j < out.messages.length && out.messages[j].role === 'tool') answers.push(out.messages[j++].tool_call_id);
    for (const c of m.tool_calls) assert.ok(answers.includes(c.id), `call ${c.id} lost its answer`);
  }
});

test('⚠️ the report SAYS the bodies were dropped whole — silence about the harshest cut is the dishonesty', () => {
  const out = compactMessages(manyBigReads(60), { budgetTokens: BUDGET, keepLastRounds: 0 });
  const said = out.report.lines.join('\n');
  assert.match(said, /one-line\s+receipt/, 'the summary must name the pass that destroyed the content');
  assert.match(said, /Nothing of those bodies is kept/);
});

test('⚠️ the pass tallies still sum to the number of actions after a receipt replaces a clamp', () => {
  const out = compactMessages(manyBigReads(60), { budgetTokens: BUDGET, keepLastRounds: 0 });
  const summed = out.report.passes.reduce((a, p) => a + p.applied, 0);
  assert.equal(summed, out.report.actions.length,
    'a clamp that became a receipt was counted twice — a report whose rows do not add up is a quietly wrong number');
});
