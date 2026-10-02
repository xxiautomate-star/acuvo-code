/**
 * ── 💰⭐⭐⭐ THE TOKENS WE PAID FOR AND NEVER COUNTED ─────────────────────────
 *
 * THE DEFECT, IN ONE SENTENCE: the CLI captured the provider's `usage` object
 * **only on the success return**, so every round that was BILLED AND THEN FAILED
 * contributed zero prompt tokens, zero completion tokens and zero cached tokens
 * to the meter, the journal, the audit record and the `--json` summary.
 *
 * ⚠️ THE FAILURE THAT COSTS MONEY IS THE ONE THIS TOOL RETRIES ON PURPOSE. Read
 * `model.mjs`'s own header for the degenerate 200: *"The call happened, the
 * tokens were billed, and there is nothing to act on."* `chain.mjs` calls its
 * empty-reply pattern *"the single most important line here"* and fails over to
 * another model on it. So the expensive path is not exotic — it is designed:
 *
 *     round N  →  send a 12k-token prompt, 11k of it cached
 *              →  provider bills us, returns an empty completion
 *              →  chain discards the attempt, tries another model
 *              →  succeeds, reports ONE usage object
 *
 * Everything before the last line was free as far as this package could tell.
 *
 * ⚠️ AND THE OLD SUITE PROVED NOBODY HAD LOOKED. The last case in
 * `test/transport-empty-reply.test.mjs` is named *"usage and finishReason
 * survive on the SUCCESS path"*. That was the only path anybody checked, and the
 * file directly above it enumerates the failure shapes in detail.
 *
 * ⭐ THE SHARPEST SINGLE PIECE OF EVIDENCE. `turn.mjs` annotates every round
 * with a cache reading and says why:
 *
 *     // ⚠️ ANNOTATED HERE RATHER THAN AT THE THREE `rounds.push` SITES… and the
 *     // third push site (the mid-loop model error) is the one that would have
 *     // been forgotten — it is also the one where a provider that billed and
 *     // then failed is most worth accounting for.
 *
 *     for (const r of rounds) r.cache = readCacheUsage(r.usage);
 *
 * …while that third push site, two thousand lines away, wrote a hard-coded
 * `usage: null`. So the derivation ran on a field that was STRUCTURALLY ALWAYS
 * NULL: a correct computation over a guaranteed absence, which is this repo's
 * signature defect wearing the costume of a fix.
 *
 * ── WHAT THIS FILE PINS ──────────────────────────────────────────────────────
 *
 *   A. the source seam — `extractReply` and `collectStream` carry the bill out
 *      of a billed failure, in both provider shapes;
 *   B. propagation — `callModel` forwards it on all three failure legs;
 *   C. the chain — every attempt it walks away from is countable, and NONE is
 *      counted twice (the double-charge is the failure mode of the fix itself);
 *   D. REACH — a real `runSession` charges those tokens to a real meter. Nothing
 *      above this line proves a customer's bill changed; only D does.
 *
 * ⚠️ AND THE REGRESSION HALF, WHICH IS LOAD-BEARING: an UNBILLED failure — a
 * DNS fault, a 429, a 402 — must still record `null`. Unknown is not zero, and a
 * fix that turns every transport error into a fabricated `0 tokens` would be
 * worse than the hole it closed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractReply, callModel } from '../lib/model.mjs';
import { collectStream } from '../lib/stream.mjs';
import { callChain } from '../lib/chain.mjs';
import { runSession, readCacheUsage } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

/* ────────────────────────────────────────────────────────────────────────────
 * fixtures
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A usage object in the shape OpenRouter/DeepSeek actually return — the one
 * `console.cli_usage` stores column for column. The numbers are the measured
 * order of magnitude for a real CLI round (10k–30k prompt tokens, most of it
 * cached), not round decoration: the whole point is that discarding one of
 * these is a material charge, not a rounding error.
 */
const usageWith = (prompt, cached, cost = 0.0005, completion = 84) => ({
  cost,
  total_tokens: prompt + completion,
  prompt_tokens: prompt,
  completion_tokens: completion,
  prompt_tokens_details: { cached_tokens: cached },
});

const BILLED = usageWith(11903, 11776, 0.00020398, 30);

const body = (message, extra = {}) => ({ choices: [{ message, finish_reason: 'stop' }], ...extra });

/** Yield an SSE stream from pre-built frames. */
async function* sse(frames) {
  for (const f of frames) yield `data: ${JSON.stringify(f)}\n\n`;
  yield 'data: [DONE]\n\n';
}

/** The parts of `Response` that `callModel` touches. */
function fakeRes({ status = 200, contentType = null, body: stream = undefined, json = null }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    body: stream,
    json: async () => json,
    text: async () => '',
  };
}

const CALL = {
  apiKey: 'sk-or-v1-TESTKEYTESTKEYTEST',
  model: 'test/model',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-billed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A meter that records every debit. This is the object `budget.mjs` calls at the
 * one place every round passes, and `entry` is the RAW provider usage — so
 * asserting on it is asserting on exactly what the unit meter and the price
 * split see.
 */
function recordingMeter() {
  const debits = [];
  return {
    debits,
    debit: (entry) => { debits.push(entry); },
    /** Present so the governor's gate path exists; it never refuses here. */
    checkUsd: () => ({ allowed: true, reason: 'unmetered', remaining: null, message: null }),
    debitUsd: () => {},
  };
}

/** Sum a list of raw usage objects the way an invoice would. */
const totals = (list) => list.reduce((acc, u) => {
  const c = readCacheUsage(u);
  return {
    prompt: acc.prompt + (c.promptTokens ?? 0),
    cached: acc.cached + (c.cachedTokens ?? 0),
    completion: acc.completion + (typeof u?.completion_tokens === 'number' ? u.completion_tokens : 0),
  };
}, { prompt: 0, cached: 0, completion: 0 });

/* ────────────────────────────────────────────────────────────────────────────
 * A. THE SOURCE SEAM
 * ──────────────────────────────────────────────────────────────────────────── */

test('A1 ⭐ a billed-but-empty 200 carries prompt, completion AND cached tokens off extractReply', () => {
  const r = extractReply(body({ role: 'assistant', content: null }, { usage: BILLED, provider: 'DeepInfra' }));

  assert.equal(r.ok, false, 'the degenerate 200 must still be a failure — that half is not being relaxed');
  assert.ok(r.usage, 'the provider billed us for 11,903 prompt tokens and the failure reported nothing');
  assert.equal(r.usage.prompt_tokens, 11903);
  assert.equal(r.usage.completion_tokens, 30);
  assert.deepEqual(
    readCacheUsage(r.usage),
    { promptTokens: 11903, cachedTokens: 11776 },
    'cached_tokens is the field the whole margin turns on and it must survive the failure path',
  );
  assert.equal(r.provider, 'DeepInfra', 'a round that failed on a cold upstream is the one worth attributing');
});

test('A2 ⚠️ REGRESSION: a failure with no usage still reports null — unknown is not zero', () => {
  const r = extractReply(body({ role: 'assistant', content: null }));
  assert.equal(r.ok, false);
  assert.equal(r.usage, null, 'a provider that stated no usage must not be recorded as having used 0 tokens');
  assert.deepEqual(readCacheUsage(r.usage), { promptTokens: null, cachedTokens: null });
});

test('A3 ⚠️ REGRESSION: the success path is unchanged, usage and all', () => {
  const r = extractReply(body({ role: 'assistant', content: 'done' }, { usage: BILLED, provider: 'DeepInfra' }));
  assert.equal(r.ok, true);
  assert.equal(r.usage.prompt_tokens, 11903);
  assert.equal(r.provider, 'DeepInfra');
});

test('A4 ⭐ the STREAMED empty reply carries its bill — this is the leg the CLI always takes', async () => {
  /**
   * ⚠️ `turn.mjs` passes `onText` on every round, so streaming is the CLI's only
   * branch (`stream.mjs` says so in its own header). A usage object dropped here
   * is a usage object dropped for 100% of real traffic.
   */
  const collected = await collectStream(sse([
    { provider: 'DeepInfra', choices: [{ delta: { role: 'assistant' } }] },
    { provider: 'DeepInfra', choices: [{ delta: {}, finish_reason: 'length' }] },
    { provider: 'DeepInfra', usage: BILLED, choices: [] },
  ]));

  assert.equal(collected.ok, false, 'no content and no tool calls is still a failure');
  assert.match(collected.error, /empty reply/);
  assert.ok(collected.usage, 'the usage frame arrived and was parsed, then thrown away with the failure');
  assert.deepEqual(readCacheUsage(collected.usage), { promptTokens: 11903, cachedTokens: 11776 });
  assert.equal(collected.provider, 'DeepInfra');
});

test('A5 ⚠️ a stream that sent NOTHING reports usage null, not an invented zero', async () => {
  const collected = await collectStream((async function* () { /* silence */ })());
  assert.equal(collected.ok, false);
  assert.match(collected.error, /closed without sending anything/);
  assert.equal(collected.usage, null, 'nothing arrived, so nothing is known — null, never 0');
});

/* ────────────────────────────────────────────────────────────────────────────
 * B. PROPAGATION THROUGH callModel — all three failure legs
 * ──────────────────────────────────────────────────────────────────────────── */

test('B1 ⭐ callModel forwards the bill on the STREAMING empty-reply failure', async () => {
  const fetchImpl = async () => fakeRes({
    contentType: 'text/event-stream',
    body: sse([{ provider: 'DeepInfra', choices: [{ delta: {} }] }, { usage: BILLED, choices: [] }]),
  });
  const r = await callModel({ ...CALL, onText: () => {}, fetchImpl });

  assert.equal(r.ok, false);
  assert.deepEqual(readCacheUsage(r.usage), { promptTokens: 11903, cachedTokens: 11776 },
    'collectStream captured the bill and callModel dropped it on the way out');
});

test('B2 ⭐ callModel forwards the bill on the NON-STREAMING empty-reply failure', async () => {
  const json = body({ role: 'assistant', content: '' }, { usage: BILLED, provider: 'DeepInfra' });
  const fetchImpl = async () => fakeRes({ contentType: 'application/json', json });
  // No `onText` → the whole-body leg.
  const r = await callModel({ ...CALL, fetchImpl });

  assert.equal(r.ok, false);
  assert.deepEqual(readCacheUsage(r.usage), { promptTokens: 11903, cachedTokens: 11776 });
});

test('B3 ⭐ …and on the leg where a provider IGNORED stream:true and answered with JSON', async () => {
  /**
   * ⚠️ This leg exists because `stream:true` is a request, not a guarantee — see
   * case C in `model-transport-hardening-q4w`. It is a real, paid path, so it
   * needs the same accounting as the other two.
   */
  const json = body({ role: 'assistant', content: null }, { usage: BILLED });
  const fetchImpl = async () => fakeRes({
    contentType: 'application/json',
    body: (async function* () { yield JSON.stringify(json); })(),
    json,
  });
  const r = await callModel({ ...CALL, onText: () => {}, fetchImpl });

  assert.equal(r.ok, false);
  assert.deepEqual(readCacheUsage(r.usage), { promptTokens: 11903, cachedTokens: 11776 });
});

test('B4 ⚠️ REGRESSION: a transport fault carries no invented usage', async () => {
  const fetchImpl = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  const r = await callModel({ ...CALL, onText: () => {}, fetchImpl });
  assert.equal(r.ok, false);
  assert.ok(r.usage == null, 'a call that never reached a provider was not billed and must report nothing');
});

/* ────────────────────────────────────────────────────────────────────────────
 * C. THE CHAIN — every attempt countable, none counted twice
 * ──────────────────────────────────────────────────────────────────────────── */

/** A `callImpl` driven by a script keyed on attempt number. */
const chainOf = (script) => {
  let n = 0;
  return async (opts) => { n += 1; return script(n, opts); };
};

const CHAIN_CALL = {
  apiKey: 'k',
  model: 'deepseek/deepseek-chat',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  sleepImpl: async () => {},
};

test('C1 ⭐⭐ a chain that RECOVERS still reports what the attempts it discarded cost', async () => {
  /**
   * ⚠️ THE WORST CASE IS THE ONE THAT LOOKS FINE. This run exits 0 with one
   * usage object and no error on screen. Two paid calls happened first.
   */
  /**
   * ⚠️ THE CANDIDATES ARE SUPPLIED, NOT INHERITED. This case needs a THIRD
   * attempt to exist, and it used to get one by accident: the default fallback
   * list happened to hold three names, one of which deduped against the
   * primary. Removing Qwen from the coding chain on 2026-08-31 took the count
   * to two and turned a metering test red for a reason that has nothing to do
   * with metering.
   *
   * ⭐ The coupling was the defect, not the deletion. What this test is FOR is
   * "a run that recovers still reports the bills it walked away from" — that is
   * true at any chain length, so the length is now stated here instead of being
   * borrowed from a product decision that is free to move.
   */
  const res = await callChain({
    ...CHAIN_CALL,
    env: { ACUVO_FALLBACK_MODELS: 'test/second,test/third' },
    callImpl: chainOf((n) => (n < 3
      ? { ok: false, error: 'the model returned an empty reply', usage: usageWith(11903, 11776, 0.0002, 30) }
      : { ok: true, content: 'done', toolCalls: [], usage: usageWith(9000, 8000, 0.0001, 40) })),
  });

  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
  assert.equal(res.billedFailures.length, 2,
    'two attempts were billed and walked away from; the chain reported only the winner');
  assert.deepEqual(totals(res.billedFailures), { prompt: 23806, cached: 23552, completion: 60 });

  // ⚠️ DISJOINT. The winner's own usage must not also appear in the list, or the
  // caller charges the same tokens twice — the failure mode of this very fix.
  assert.ok(
    !res.billedFailures.some((u) => u.prompt_tokens === 9000),
    'the successful attempt was double-counted: it is both `usage` and a `billedFailure`',
  );
});

test('C2 ⚠️⚠️ a chain that STOPS EARLY does not double-charge the attempt it returns', async () => {
  /**
   * `stoppedEarly` spreads `...res`, so the attempt's own usage is already
   * visible to the caller as `res.usage`. Putting it in `billedFailures` too
   * would bill it twice — and a meter that over-charges is a worse defect than
   * one that under-charges, because it is the one a customer notices.
   */
  const res = await callChain({
    ...CHAIN_CALL,
    callImpl: chainOf(() => ({ ok: false, error: 'HTTP 401 invalid api key', usage: BILLED })),
  });

  assert.equal(res.ok, false);
  assert.equal(res.stoppedEarly, true);
  assert.equal(res.usage.prompt_tokens, 11903, 'the caller still sees this attempt as `usage`');
  assert.deepEqual(res.billedFailures, [], 'it must NOT also be listed as a discarded bill');
});

test('C3 ⭐ when every candidate fails, every bill is still reported', async () => {
  const res = await callChain({
    ...CHAIN_CALL,
    callImpl: chainOf(() => ({ ok: false, error: 'HTTP 502 upstream error', usage: usageWith(5000, 4000, 0.0001, 10) })),
  });

  assert.equal(res.ok, false);
  assert.ok(res.attempts >= 2, `the chain should have tried several candidates, tried ${res.attempts}`);
  assert.equal(res.billedFailures.length, res.attempts,
    'the exhausted return synthesises its own error and carries no `usage`, so every attempt is new information');
  // ⚠️ And it carries no `usage` of its own, which is what makes the line above safe.
  assert.equal(res.usage, undefined);
});

test('C4 ⚠️ REGRESSION: attempts that cost nothing add nothing', async () => {
  const res = await callChain({
    ...CHAIN_CALL,
    callImpl: chainOf(() => ({ ok: false, error: 'HTTP 502 upstream error' })),
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.billedFailures, [], 'a failure with no usage is unknown, and unknown must add no rows');
});

/* ────────────────────────────────────────────────────────────────────────────
 * D. REACH — a real session, a real meter
 *
 * ⚠️ NOTHING ABOVE THIS LINE PROVES A BILL CHANGED. This repo ships
 * built-and-unreached work constantly; the only evidence that counts is the end
 * of the wire. `meter.debit` is the exact call `budget.mjs` makes at the one
 * place every round passes, and `entry` is the raw provider usage object.
 * ──────────────────────────────────────────────────────────────────────────── */

test('D1 ⭐⭐⭐ a session charges the meter for the attempts the chain threw away', async (t) => {
  const dir = workspace(t);
  const meter = recordingMeter();

  const outcome = await runSession({
    task: 'do the work',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    maxRounds: 2,
    meter,
    // One round. The chain recovered after two billed-empty attempts, which is
    // invisible from here — the run looks completely clean.
    callModelImpl: async () => ({
      ok: true,
      content: 'done',
      toolCalls: [],
      usage: usageWith(9000, 8000, 0.0001, 40),
      billedFailures: [usageWith(11903, 11776, 0.0002, 30), usageWith(12100, 11800, 0.0002, 25)],
    }),
  });

  assert.equal(outcome.ok, true);
  const t2 = totals(meter.debits);
  assert.equal(meter.debits.length, 3, `the winner plus its two discarded attempts, got ${meter.debits.length}`);
  assert.equal(t2.prompt, 9000 + 11903 + 12100,
    'the discarded attempts never reached the meter — 24,003 paid prompt tokens priced at zero');
  assert.equal(t2.cached, 8000 + 11776 + 11800, 'cached_tokens is the margin and it must reach the meter too');
  assert.equal(t2.completion, 40 + 30 + 25);
});

test('D2 ⭐⭐⭐ a mid-loop model failure records its REAL usage on the round, not a hard-coded null', async (t) => {
  const dir = workspace(t);
  const meter = recordingMeter();

  const outcome = await runSession({
    task: 'do the work',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    maxRounds: 4,
    meter,
    callModelImpl: async (opts) => {
      const first = opts.messages.filter((m) => m.role === 'assistant').length === 0;
      return first
        ? {
          ok: true,
          content: 'looking',
          toolCalls: [{ id: 'c1', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
          usage: usageWith(9000, 0, 0.0009, 40),
          finishReason: 'tool_calls',
        }
        : { ok: false, error: 'the model returned an empty reply', usage: BILLED, provider: 'DeepInfra' };
    },
  });

  const failed = outcome.rounds[outcome.rounds.length - 1];
  assert.ok(failed.error, `the last round should be the failure, got ${JSON.stringify(failed)}`);
  assert.deepEqual(
    failed.cache,
    { promptTokens: 11903, cachedTokens: 11776 },
    "turn.mjs annotates every round with a cache reading and calls the model-error push site "
    + '"the one where a provider that billed and then failed is most worth accounting for" — '
    + 'then hard-coded `usage: null` there, so the annotation could only ever produce nulls',
  );
  assert.equal(failed.provider, 'DeepInfra', 'the upstream that billed the failed round must be attributable');

  // …and it reaches the meter with the split intact, which is what prices it.
  const charged = meter.debits.find((u) => u?.prompt_tokens === 11903);
  assert.ok(charged, 'the failed round was charged a projection instead of its stated bill');
  assert.equal(charged.completion_tokens, 30);
});

test('D3 ⚠️⚠️ REGRESSION: an UNBILLED mid-loop failure still records null, never a fabricated zero', async (t) => {
  const dir = workspace(t);

  const outcome = await runSession({
    task: 'do the work',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    maxRounds: 4,
    callModelImpl: async (opts) => {
      const first = opts.messages.filter((m) => m.role === 'assistant').length === 0;
      return first
        ? {
          ok: true,
          content: 'looking',
          toolCalls: [{ id: 'c1', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
          usage: usageWith(9000, 0, 0.0009, 40),
          finishReason: 'tool_calls',
        }
        : { ok: false, error: 'Could not reach OpenRouter: the DNS lookup failed (ENOTFOUND).' };
    },
  });

  const failed = outcome.rounds[outcome.rounds.length - 1];
  assert.ok(failed.error);
  assert.equal(failed.usage, null, 'a call that never reached a provider must not be recorded as 0 tokens used');
  assert.deepEqual(failed.cache, { promptTokens: null, cachedTokens: null },
    'unknown stays unknown — a fabricated 0% cached is a wrong answer that looks right');
});
