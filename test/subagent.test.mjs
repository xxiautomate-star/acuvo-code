/**
 * ── ⭐⭐ SUBAGENTS — THE MISSING PRIMITIVE ───────────────────────────────────
 *
 * Researched 2026-08-11: *"for most development tasks in 2026, subagents are the
 * right answer"* — isolate noisy work in its own context window so the main
 * thread stays clean, and return DISTILLED summaries.
 *
 * We had none. `--parallel` runs N unrelated tasks typed by a human; it is not
 * delegation. What was missing is the main loop saying "go find where this is
 * defined across 400 files" and getting back 200 tokens instead of 50,000.
 *
 * ── ⭐ AND IT IS A MARGIN FEATURE, NOT ONLY A CONTEXT ONE ──────────────────
 * DeepSeek caches automatically and a hit costs up to 50x less, but only on a
 * prefix that repeats BYTE-FOR-BYTE. A subagent's exploration never touches the
 * parent's message array, so the parent's expensive cached head survives work
 * that would otherwise pollute it. Context hygiene and cost are the same lever.
 *
 * ── ⚠️ THE FOUR RULES, AND THE FAILURE EACH PREVENTS ───────────────────────
 *
 * 1. ⚠️⚠️ READ-ONLY BY DEFAULT. A subagent that writes can collide with the
 *    parent editing the same file, and whoever finishes second wins silently —
 *    the exact failure `parallel.mjs` was built to detect and cannot see here,
 *    because these run INSIDE one session. Research is the use case; the parent
 *    does the writing.
 * 2. ⚠️ NO RECURSION. A subagent that can spawn a subagent is an unbounded
 *    fork bomb billed to the user. Depth is capped and the tool is simply
 *    absent from a subagent's own offer.
 * 3. ⚠️ DISTILLED, NOT FORWARDED. Returning the transcript would defeat the
 *    entire purpose — the parent would pay for the context it delegated to
 *    avoid.
 * 4. ⚠️ A FAILURE IS DATA. A subagent that dies returns a reason the parent can
 *    act on; it never throws into the parent's loop.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  runSubagent,
  SUBAGENT_TOOL_NAMES,
  MAX_SUBAGENT_DEPTH,
  subagentToolSchemas,
  summariseForParent,
} from '../lib/subagent.mjs';

/** A runSession stand-in: no model, no network, no spend. */
function fakeSession(outcome) {
  return async (opts) => {
    fakeSession.lastOpts = opts;
    return outcome;
  };
}

const DONE = {
  ok: true,
  stage: 'done',
  model: 'test-model',
  note: 'computeTotal is defined in src/core/arithmetic/accumulate.mjs at line 3.',
  finishReason: 'stop',
  usage: { cost: 0.0004, total_tokens: 8_000 },
  executed: [
    { name: 'search_text', args: { pattern: 'computeTotal' }, result: { ok: true, matches: [{ path: 'a.mjs' }] }, mutated: false },
    { name: 'read_file', args: { path: 'src/core/arithmetic/accumulate.mjs' }, result: { ok: true, content: 'x'.repeat(40_000) }, mutated: false },
  ],
  rounds: [{ round: 1 }, { round: 2 }],
  roundsUsed: 2,
  maxRounds: 4,
  allowRun: false,
  stoppedBecause: 'no-tool-calls',
  verification: { ran: false, passed: null, command: null, exitCode: null, timedOut: false, attempts: 0 },
  acceptance: null,
  promisedButMissing: [],
};

const executor = { root: 'C:/fake/root', dryRun: false };
const config = { apiKey: 'k', model: 'test-model' };

test('⭐ returns a DISTILLED summary, not the transcript', async () => {
  const r = await runSubagent(
    { task: 'find where computeTotal is defined', executor, config },
    { sessionImpl: fakeSession(DONE) },
  );
  assert.equal(r.ok, true, r.error ?? '');
  assert.match(r.summary, /accumulate\.mjs/);

  const size = JSON.stringify(r).length;
  assert.ok(size < 2_000, `the parent was handed ${size} characters — a 40KB file read leaked through`);
  assert.equal(/x{1000,}/.test(JSON.stringify(r)), false, 'raw file contents reached the parent');
});

test('⭐ the parent is told what it COST, because it is paying for it', async () => {
  const r = await runSubagent(
    { task: 'find it', executor, config },
    { sessionImpl: fakeSession(DONE) },
  );
  assert.equal(r.costUsd, 0.0004);
  assert.equal(r.tokens, 8_000);
  assert.equal(r.roundsUsed, 2);
});

test('⚠️⚠️ READ-ONLY: a subagent is offered no tool that can write or run', async () => {
  await runSubagent({ task: 'look', executor, config }, { sessionImpl: fakeSession(DONE) });
  const offered = fakeSession.lastOpts.toolNames;
  assert.ok(Array.isArray(offered) && offered.length > 0, 'no tool list was passed — it would inherit the full surface');
  for (const banned of ['write_file', 'edit_file', 'delete_file', 'run_command', 'evaluate', 'git_commit']) {
    assert.equal(offered.includes(banned), false, `${banned} was offered to a subagent`);
  }
  assert.equal(fakeSession.lastOpts.allowRun, false, 'allowRun must be false — the dispatcher is the second lock');
});

test('⭐ it CAN do the thing it exists for: search and read', () => {
  for (const needed of ['search_text', 'find_files', 'read_file', 'list_dir']) {
    assert.ok(SUBAGENT_TOOL_NAMES.includes(needed), `${needed} missing — a researcher that cannot search is useless`);
  }
});

test('⚠️ NO RECURSION: a subagent is never offered the delegate tool', () => {
  assert.equal(SUBAGENT_TOOL_NAMES.includes('delegate'), false, 'a subagent that can delegate is a fork bomb');
});

test('⚠️ depth is capped, and the refusal explains itself', async () => {
  const r = await runSubagent(
    { task: 'go deeper', executor, config, depth: MAX_SUBAGENT_DEPTH },
    { sessionImpl: fakeSession(DONE) },
  );
  assert.equal(r.ok, false);
  assert.match(String(r.error), /depth|nest|deeper/i);
});

test('⚠️ a failed subagent returns a REASON, it does not throw', async () => {
  const failed = { ok: false, stage: 'failed', error: 'every provider in the chain failed', executed: [], rounds: [] };
  const r = await runSubagent({ task: 'x', executor, config }, { sessionImpl: fakeSession(failed) });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /provider/);
});

test('⚠️ a THROWING session is caught and reported, never propagated', async () => {
  const r = await runSubagent(
    { task: 'x', executor, config },
    { sessionImpl: async () => { throw new Error('socket exploded'); } },
  );
  assert.equal(r.ok, false);
  assert.match(String(r.error), /socket exploded/);
});

test('⚠️ an empty task is refused before a model is called', async () => {
  let called = false;
  for (const bad of ['', '   ', null, undefined]) {
    const r = await runSubagent(
      { task: bad, executor, config },
      { sessionImpl: async () => { called = true; return DONE; } },
    );
    assert.equal(r.ok, false, `task=${JSON.stringify(bad)} was accepted`);
  }
  assert.equal(called, false, 'a model was called for an empty task — that is money for nothing');
});

test('⚠️ the round budget is bounded, whatever the caller asks for', async () => {
  await runSubagent(
    { task: 'x', executor, config, maxRounds: 999 },
    { sessionImpl: fakeSession(DONE) },
  );
  assert.ok(fakeSession.lastOpts.maxRounds <= 8, `maxRounds=${fakeSession.lastOpts.maxRounds} — a subagent could outspend its parent`);
});

test('summariseForParent keeps the answer and drops the noise', () => {
  const s = summariseForParent(DONE);
  assert.match(s, /accumulate\.mjs/, 'the actual finding was lost');
  assert.equal(/x{1000,}/.test(s), false, 'file contents survived');
  assert.ok(s.length < 1_000, `summary is ${s.length} characters`);
});

test('⭐ a subagent that found nothing says so, rather than returning empty', () => {
  const nothing = { ...DONE, note: null, executed: [] };
  const s = summariseForParent(nothing);
  assert.ok(s.trim().length > 0, 'an empty string tells the parent nothing at all');
  assert.match(s, /nothing|no |could not|did not/i);
});

test('the tool schema exists, is named delegate, and demands a specific question', () => {
  const schemas = subagentToolSchemas();
  const d = schemas.find((s) => s.function.name === 'delegate');
  assert.ok(d, 'no delegate tool declared');
  assert.ok(d.function.parameters.required.includes('task'));
  assert.match(d.function.description, /read|research|search|find/i);
  // ⚠️ The model must know it gets a SUMMARY back, or it will delegate and then
  // ask for the same files again.
  assert.match(d.function.description, /summar/i);
});
