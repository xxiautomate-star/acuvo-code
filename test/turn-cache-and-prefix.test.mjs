/**
 * ── ⭐⭐ THE MARGIN — MEASURED, NOT GUESSED ──────────────────────────────────
 *
 * MEASURED against the live API before any of this was written. DeepSeek caches
 * prompt prefixes automatically, and a cache HIT costs about 50× less than a
 * miss ($0.014/M vs the normal rate). Three identical calls:
 *
 *   call 1  prompt=3616 cached=0     $0.000512
 *   call 2  prompt=3616 cached=0     $0.000508
 *   call 3  prompt=3616 cached=3072  $0.000168   ← 3.05× cheaper
 *
 * OpenRouter returns that per call as `usage.prompt_tokens_details.cached_tokens`
 * and `runSession` already stores the raw `usage` object on every round.
 *
 * ⚠️ MEASURED DEFECT (probe, before the fix): `aggregateUsage` read exactly two
 * keys — `cost` and `total_tokens` — so a session that received
 * `cached_tokens: 3072` reported `{cost, total_tokens}` and nothing else. WE
 * RECEIVED THE NUMBER AND THREW IT AWAY, and nobody could tell a 10% hit rate
 * from a 90% one, which is the whole margin of the product.
 *
 * ── ⭐⭐ AND THE CONTRACT THAT KEEPS THE 50× ALIVE ──────────────────────────
 *
 * A cache hit requires the prefix to be IDENTICAL FROM TOKEN 0. Anything that
 * varies near the start voids it for the entire request. Nothing reported that
 * either, so this file pins the property the caching actually needs:
 *
 *   a. the system message is byte-identical across every round;
 *   b. round N's message array is a STRICT PREFIX of round N+1's — element for
 *      element, unchanged. Stronger than checking the system prompt alone, and
 *      it is the property the provider's prefix matcher is really testing.
 *   c. the stable-prefix length is reported as a PERCENTAGE, so a regression
 *      shows up as a number moving rather than a boolean flipping.
 *
 * ⚠️ MEASURED, AND IT IS ALREADY VIOLATED — BY COMPACTION, NOT BY THE BANNER.
 * The plan-ledger countdown was the suspect and it is innocent: it is APPENDED,
 * so the prefix survives it (proved below). The compactor is the culprit. From a
 * 16-round probe with fat tool results:
 *
 *   r11(22 msgs) -> r12(24): stable 22/22 = 100%
 *   r12(24 msgs) -> r13(26): stable  3/24 =  12.5%   ← first compaction
 *   r13(26 msgs) -> r14(28): stable  3/26 =  11.5%
 *   r14(28 msgs) -> r15(30): stable  7/28 =  25.0%
 *
 *   compaction round 13: 25943 → 23951 tokens — freed 7.7%
 *   compaction round 14: 26037 → 23046 tokens — freed 11.5%
 *
 * ⭐ THE PRICE, STATED PLAINLY: each compaction frees ~8% of the transcript and
 * voids the prefix cache on ~87% of it. When the provider caches, a miss costs
 * ~50× a hit, so that trade is a large net loss — and it was completely
 * invisible. It is NOT pinned as correct by this file: the tests below assert
 * that the session REPORTS the compaction and warns about the collapsed hit
 * rate, so a future change that makes compaction prefix-preserving passes here
 * rather than failing. A check that fails correct work is worse than no check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession, formatSummary, renderEvent, readCacheUsage } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

/* ────────────────────────────────────────────────────────────────────────────
 * fixtures
 * ──────────────────────────────────────────────────────────────────────────── */

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const config = { apiKey: 'k', model: 'deepseek/deepseek-chat' };

/** A usage object in OpenRouter's shape. */
const usageWith = (prompt, cached, cost = 0.0005) => ({
  cost,
  total_tokens: prompt + 84,
  prompt_tokens: prompt,
  completion_tokens: 84,
  prompt_tokens_details: { cached_tokens: cached },
});

/**
 * Drives a real session with an injected model and CAPTURES every request the
 * loop made — a deep copy, because `messages` is mutated in place by design.
 */
async function driveSession({ dir, script, maxRounds = 8, onEvent = () => {}, priorMessages = null }) {
  const requests = [];
  let n = 0;
  const outcome = await runSession({
    task: 'do the work',
    executor: createLocalExecutor(dir),
    config,
    maxRounds,
    ...(priorMessages ? { priorMessages } : {}),
    onEvent,
    callModelImpl: async (opts) => {
      requests.push(JSON.parse(JSON.stringify(opts.messages)));
      n += 1;
      return script(n, opts);
    },
  });
  return { outcome, requests };
}

/**
 * The property the cache actually needs, expressed as a number.
 * Returns, per consecutive pair, how much of the earlier request survived
 * unchanged at the front of the later one.
 */
function prefixStability(requests) {
  const pairs = [];
  for (let i = 0; i + 1 < requests.length; i += 1) {
    const a = requests[i];
    const b = requests[i + 1];
    let common = 0;
    while (common < a.length && common < b.length
      && JSON.stringify(a[common]) === JSON.stringify(b[common])) common += 1;
    pairs.push({
      from: i + 1,
      to: i + 2,
      of: a.length,
      stable: common,
      percent: a.length === 0 ? 100 : (common / a.length) * 100,
    });
  }
  return pairs;
}

/* ────────────────────────────────────────────────────────────────────────────
 * (1) the cache reading itself
 * ──────────────────────────────────────────────────────────────────────────── */

test('readCacheUsage reads the OpenRouter/DeepSeek shape', () => {
  assert.deepEqual(
    readCacheUsage(usageWith(3616, 3072)),
    { promptTokens: 3616, cachedTokens: 3072 },
  );
});

test('readCacheUsage reads a reported ZERO as zero, not as unknown', () => {
  // ⚠️ The distinction the whole feature turns on. A first call really does hit
  // nothing, and reporting that as "unknown" would hide a genuine 0%.
  assert.deepEqual(
    readCacheUsage(usageWith(3616, 0)),
    { promptTokens: 3616, cachedTokens: 0 },
  );
});

test('readCacheUsage reports UNKNOWN — never zero — when the provider omits the field', () => {
  // ⚠️⚠️ THE ONE THAT MUST NOT REGRESS. Rendering an absent field as "0% cached"
  // is a wrong answer that looks right, and it would send someone hunting a
  // cache problem that does not exist.
  assert.deepEqual(
    readCacheUsage({ cost: 0.0005, total_tokens: 3700, prompt_tokens: 3616 }),
    { promptTokens: 3616, cachedTokens: null },
  );
  assert.deepEqual(readCacheUsage(null), { promptTokens: null, cachedTokens: null });
  assert.deepEqual(readCacheUsage({}), { promptTokens: null, cachedTokens: null });
});

test('readCacheUsage understands the Anthropic shape, where input_tokens EXCLUDES the cache read', () => {
  /**
   * ⚠️ THE TRAP. Anthropic reports `input_tokens` as the UNCACHED remainder, so
   * treating it as the prompt total would report 3072 cached out of 544 — a hit
   * rate over 100%, from arithmetic that looks reasonable.
   */
  assert.deepEqual(
    readCacheUsage({ input_tokens: 544, cache_read_input_tokens: 3072, cache_creation_input_tokens: 0 }),
    { promptTokens: 3616, cachedTokens: 3072 },
  );
});

test('readCacheUsage refuses nonsense rather than inventing a number', () => {
  assert.deepEqual(
    readCacheUsage({ prompt_tokens: 'lots', prompt_tokens_details: { cached_tokens: -5 } }),
    { promptTokens: null, cachedTokens: null },
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * (1) …surfaced per round, per session, and in the summary
 * ──────────────────────────────────────────────────────────────────────────── */

test('a session surfaces cached vs uncached prompt tokens, per round and in total', async (t) => {
  const dir = workspace(t);
  const { outcome } = await driveSession({
    dir,
    script: (n) => (n === 1
      ? {
        ok: true,
        content: 'looking first',
        toolCalls: [{ id: 'c1', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
        usage: usageWith(3616, 0, 0.000512),
        finishReason: 'tool_calls',
      }
      : {
        ok: true, content: 'done', toolCalls: [],
        usage: usageWith(3616, 3072, 0.000168), finishReason: 'stop',
      }),
  });

  // per round — the number we were already receiving and discarding
  assert.deepEqual(outcome.rounds.map((r) => r.cache), [
    { promptTokens: 3616, cachedTokens: 0 },
    { promptTokens: 3616, cachedTokens: 3072 },
  ]);

  // per session
  const c = outcome.usage.cache;
  assert.equal(c.promptTokens, 7232);
  assert.equal(c.cachedTokens, 3072);
  assert.equal(c.uncachedTokens, 4160);
  assert.equal(c.roundsReported, 2);
  assert.equal(c.roundsUnknown, 0);
  assert.ok(Math.abs(c.hitRate - 3072 / 7232) < 1e-9, `hit rate was ${c.hitRate}`);
});

test('the end-of-run summary states the hit rate next to the cost', async (t) => {
  const dir = workspace(t);
  const { outcome } = await driveSession({
    dir,
    script: () => ({
      ok: true, content: 'done', toolCalls: [],
      usage: usageWith(3616, 3072, 0.000168), finishReason: 'stop',
    }),
  });
  const text = formatSummary(outcome).join('\n');
  const line = text.split('\n').find((l) => l.includes('$0.000168'));
  assert.ok(line, `no cost line in:\n${text}`);
  assert.ok(/cache 85%/.test(line), `cost line did not state the hit rate: ${line}`);
  assert.ok(line.includes('3072'), `cost line did not state the cached tokens: ${line}`);
  assert.ok(line.includes('3616'), `cost line did not state the prompt tokens: ${line}`);
});

test('a 0% hit rate is PRINTED — it is a real measurement, and the expensive one', async (t) => {
  const dir = workspace(t);
  const { outcome } = await driveSession({
    dir,
    script: () => ({
      ok: true, content: 'done', toolCalls: [],
      usage: usageWith(3616, 0, 0.000512), finishReason: 'stop',
    }),
  });
  const line = formatSummary(outcome).join('\n').split('\n').find((l) => l.includes('$0.000512'));
  assert.ok(/cache 0%/.test(line), `a measured zero must be shown, got: ${line}`);
});

test('a provider that reports nothing DEGRADES SILENTLY — never "0% cached"', async (t) => {
  const dir = workspace(t);
  const { outcome } = await driveSession({
    dir,
    script: () => ({
      ok: true, content: 'done', toolCalls: [],
      usage: { cost: 0.0005, total_tokens: 3700 }, finishReason: 'stop',
    }),
  });
  assert.equal(outcome.usage.cache, null, 'unknown must be null, not a zeroed object');
  const text = formatSummary(outcome).join('\n');
  assert.ok(text.includes('$0.000500'), 'the cost line must still print');
  assert.ok(!/cache/i.test(text), `invented a cache claim from nothing:\n${text}`);
});

test('a session where only SOME rounds report says how many did not', async (t) => {
  const dir = workspace(t);
  const { outcome } = await driveSession({
    dir,
    script: (n) => (n === 1
      ? {
        ok: true,
        content: 'looking',
        toolCalls: [{ id: 'c1', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
        // ⚠️ THE DANGEROUS SHAPE: it states its prompt size and says NOTHING
        // about caching. Counting those 9000 tokens as uncached would turn a
        // measured 85% into a fabricated 24%.
        usage: { cost: 0.0005, total_tokens: 9084, prompt_tokens: 9000, completion_tokens: 84 },
        finishReason: 'tool_calls',
      }
      : {
        ok: true, content: 'done', toolCalls: [],
        usage: usageWith(3616, 3072, 0.000168), finishReason: 'stop',
      }),
  });
  const c = outcome.usage.cache;
  assert.equal(c.roundsReported, 1);
  assert.equal(c.roundsUnknown, 1);
  // ⚠️ The silent round's prompt tokens are NOT counted as uncached. Doing so
  // would fabricate a low hit rate out of a provider's silence.
  assert.equal(c.promptTokens, 3616);
  const text = formatSummary(outcome).join('\n');
  assert.ok(/1 round unreported/.test(text), `did not disclose the silent round:\n${text}`);
});

/**
 * ── ⭐⭐ THE FLOOR IS ROUND 1, AND THE SESSION RATE HIDES IT ─────────────────
 *
 * `lib/plan.mjs` sizes the pricing ladder on holding a 90% cache floor. That
 * floor is a claim about a FRESH invocation's round 1 — the only round prefix
 * discipline controls. Rounds 2+ append tool results the provider has never seen
 * by definition, so their miss is arithmetic rather than a defect, and averaging
 * the two makes the floor unobservable.
 *
 * ⚠️⚠️ MEASURED 2026-08-16, two live runs in one workspace on
 * `deepseek-v4-flash`: 72.0% over 4 rounds, 49.2% over 2. Both numbers are
 * mostly a function of the round count. Neither answers the question the margin
 * depends on.
 */
test('⭐⭐ round 1 is reported as its own reading — a cold start is invisible in the session rate', async (t) => {
  const dir = workspace(t);
  const { outcome } = await driveSession({
    dir,
    script: (n) => (n === 1
      ? {
        // ⚠️ THE SHAPE THAT MOTIVATES THIS: round 1 stone cold (the prefix moved
        // since the last invocation), rounds after it nearly perfect.
        ok: true,
        content: 'looking',
        toolCalls: [{ id: 'c1', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
        usage: usageWith(8000, 0, 0.0011),
        finishReason: 'tool_calls',
      }
      : {
        ok: true, content: 'done', toolCalls: [],
        usage: usageWith(9000, 8704, 0.0002), finishReason: 'stop',
      }),
  });
  const c = outcome.usage.cache;
  // The session looks healthy…
  assert.ok(c.hitRate > 0.5, `expected a healthy-looking session rate, got ${c.hitRate}`);
  // …and the floor, which is what is actually priced, is zero.
  assert.ok(c.firstRound, 'the floor was not reported at all');
  assert.equal(c.firstRound.hitRate, 0);
  assert.equal(c.firstRound.promptTokens, 8000);
  assert.equal(c.firstRound.cachedTokens, 0);
});

test('⚠️ a SILENT round 1 leaves the floor null — round 2 is warm from round 1, not a floor', async (t) => {
  /**
   * ⚠️⚠️ THE TEMPTING WRONG IMPLEMENTATION IS "THE FIRST ROUND THAT REPORTED".
   * Here round 1 says nothing about caching and round 2 reports 85%; promoting
   * round 2 would publish 85% as the floor when round 2's cache was created by
   * round 1 moments earlier. That is not a partial measurement, it is a
   * different measurement wearing the floor's name.
   */
  const dir = workspace(t);
  const { outcome } = await driveSession({
    dir,
    script: (n) => (n === 1
      ? {
        ok: true,
        content: 'looking',
        toolCalls: [{ id: 'c1', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
        usage: { cost: 0.0005, total_tokens: 9084, prompt_tokens: 9000, completion_tokens: 84 },
        finishReason: 'tool_calls',
      }
      : {
        ok: true, content: 'done', toolCalls: [],
        usage: usageWith(3616, 3072, 0.000168), finishReason: 'stop',
      }),
  });
  const c = outcome.usage.cache;
  assert.equal(c.roundsReported, 1, 'the fixture stopped exercising the silent-round path');
  assert.ok(c.hitRate > 0.8, `the session rate should still be the measured 85%, got ${c.hitRate}`);
  assert.equal(c.firstRound, null, 'a later round was promoted to the floor');
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2) the prompt-prefix contract
 * ──────────────────────────────────────────────────────────────────────────── */

test('the system message is byte-identical across every round', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8');
  const { requests } = await driveSession({
    dir,
    maxRounds: 5,
    script: (n) => (n < 5
      ? {
        ok: true,
        content: `round ${n}`,
        toolCalls: [{ id: `c${n}`, function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } }],
        usage: usageWith(1000, 0), finishReason: 'tool_calls',
      }
      : { ok: true, content: 'done', toolCalls: [], usage: usageWith(1000, 900), finishReason: 'stop' }),
  });

  assert.ok(requests.length >= 4, `only ${requests.length} rounds ran`);
  const first = requests[0][0];
  assert.equal(first.role, 'system');
  for (const [i, msgs] of requests.entries()) {
    assert.equal(msgs[0].role, 'system', `round ${i + 1} did not lead with the system message`);
    assert.equal(msgs[0].content, first.content,
      `round ${i + 1} changed the system message — every byte after token 0 is uncacheable`);
  }
});

test('round N is a STRICT PREFIX of round N+1, and the plan countdown does not break it', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8');
  // A plan on disk, exactly as `plan_start` writes it — this is what injects a
  // fresh ROUND COUNTDOWN banner on every round, the prime suspect.
  mkdirSync(join(dir, '.acuvo'), { recursive: true });
  writeFileSync(join(dir, '.acuvo', 'plan.json'), `${JSON.stringify({
    version: 1,
    task: 'port the callbacks and then commit',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [
      { id: 's1', text: 'port the callbacks', state: 'todo' },
      { id: 's2', text: 'commit', state: 'todo' },
    ],
  })}\n`, 'utf8');

  const { requests } = await driveSession({
    dir,
    maxRounds: 6,
    script: (n) => (n < 6
      ? {
        ok: true,
        content: `round ${n}`,
        toolCalls: [{ id: `c${n}`, function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } }],
        usage: usageWith(1000, 0), finishReason: 'tool_calls',
      }
      : { ok: true, content: 'done', toolCalls: [], usage: usageWith(1000, 900), finishReason: 'stop' }),
  });

  const pairs = prefixStability(requests);
  assert.ok(pairs.length >= 4, `only ${pairs.length} transitions observed`);

  // ⭐ REPORTED AS A NUMBER, not as a boolean. A regression should show up as
  // 100% → 12.5% in the log, not merely as "a test went red".
  for (const p of pairs) {
    t.diagnostic(`round ${p.from} → ${p.to}: stable prefix ${p.stable}/${p.of} = ${p.percent.toFixed(1)}%`);
  }
  // A banner really was injected — otherwise this test proves nothing about it.
  const bannerRounds = requests.filter((msgs) => msgs.some(
    (m) => typeof m.content === 'string' && /that line is from the runner/.test(m.content),
  ));
  assert.ok(bannerRounds.length > 0, 'no plan banner was ever injected — the test is not exercising the suspect');

  for (const p of pairs) {
    assert.equal(p.stable, p.of,
      `round ${p.from} → ${p.to} kept only ${p.percent.toFixed(1)}% of the prefix: `
      + 'something varying was placed BEFORE the end of the transcript. Everything variable belongs at the END.');
  }
});

test('COMPACTION voids the prefix — and the run says so instead of hiding it', async (t) => {
  const dir = workspace(t);
  /**
   * ⚠️ WAS `.repeat(300)`, SIZED FOR A 24,000-TOKEN CEILING. That ceiling is now
   * 96,000: compacting at 2.3% of a 1,048,576-token window traded 8% fewer
   * tokens for 87% of them going from a cache HIT to a MISS, and a miss costs
   * ~50x a hit.
   *
   * ⭐ SIZED FROM ARITHMETIC, NOT GUESSED. 16 rounds read one file each; at ~68
   * chars a line, `.repeat(700)` is ~47.6k chars per file, ~762k chars total,
   * ~190k estimated tokens — comfortably past 96,000. The old 300 gave ~82k,
   * which is UNDER the new ceiling, so the probe stopped compacting and the
   * test correctly refused to pass while proving nothing.
   *
   * ⚠️ ENLARGED, NOT WEAKENED. The assertion below still requires compaction to
   * actually happen; loosening that instead would have deleted the only test
   * that watches this behaviour.
   */
  for (let i = 0; i < 24; i += 1) {
    writeFileSync(join(dir, `f${i}.txt`), (`line ${i} ${'y'.repeat(60)}\n`).repeat(700), 'utf8');
  }
  /**
   * ⚠️ THE TRANSCRIPT IS SEEDED, NOT GROWN, AND THAT IS THE FIX. Growing it by
   * reading files cannot reach the new 96,000-token ceiling: `read_file` refuses
   * anything over MAX_READ_BYTES (200,000), so 16 rounds cap out around 82k
   * estimated tokens whatever the fixture does. The old ceiling was 24,000, so
   * growth used to be enough; it is not any more, and enlarging the files
   * further just hits the read limit.
   *
   * ⭐ Seeding a large prior conversation exercises the SAME compaction path
   * this test was always about — it asserts the REPORTING, not how the tokens
   * got there.
   */
  const bulk = 'z'.repeat(40_000);
  const seeded = [
    { role: 'system', content: 'you are acuvo' },
    { role: 'user', content: 'do the work' },
  ];
  for (let i = 0; i < 12; i += 1) {
    seeded.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `s${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `f${i}.txt` }) } }],
    });
    seeded.push({ role: 'tool', tool_call_id: `s${i}`, name: 'read_file', content: `f${i}.txt:\n${bulk}` });
  }
  const compactions = [];
  const { outcome, requests } = await driveSession({
    dir,
    priorMessages: seeded,
    maxRounds: 16,
    onEvent: (e) => { if (e.type === 'compact') compactions.push(e); },
    script: (n) => (n < 16
      ? {
        ok: true,
        content: `round ${n}`,
        toolCalls: [{ id: `c${n}`, function: { name: 'read_file', arguments: JSON.stringify({ path: `f${n}.txt` }) } }],
        // Every round reports a collapsed hit rate, which is what the provider
        // does once the prefix is gone.
        usage: usageWith(6000, 200, 0.0009), finishReason: 'tool_calls',
      }
      : { ok: true, content: 'done', toolCalls: [], usage: usageWith(6000, 200, 0.0009), finishReason: 'stop' }),
  });

  assert.ok(compactions.length > 0, 'the probe never triggered compaction — it proves nothing');
  const pairs = prefixStability(requests);
  const worst = pairs.reduce((lo, p) => (p.percent < lo.percent ? p : lo), pairs[0]);
  t.diagnostic(`${compactions.length} compactions; worst transition round ${worst.from} → ${worst.to} `
    + `kept ${worst.stable}/${worst.of} = ${worst.percent.toFixed(1)}% of the prefix`);

  /**
   * ⚠️ THE ASSERTION IS ON THE REPORTING, NOT ON THE DAMAGE. Asserting "the
   * prefix IS broken" would pin the defect in place and fail the day somebody
   * makes compaction prefix-preserving — the check-that-fails-correct-work
   * failure this repo has been bitten by four times.
   */
  assert.equal(outcome.compactions, compactions.length,
    'the outcome must count the compactions, so the cost is attributable');

  const text = formatSummary(outcome).join('\n');
  assert.ok(/cache 3%/.test(text), `the collapsed hit rate was not reported:\n${text}`);
  assert.ok(/compact/i.test(text),
    `a low hit rate alongside compaction must name compaction as the cause:\n${text}`);
});

test('a healthy hit rate does NOT get the compaction warning', async (t) => {
  const dir = workspace(t);
  const { outcome } = await driveSession({
    dir,
    script: () => ({
      ok: true, content: 'done', toolCalls: [],
      usage: usageWith(3616, 3072, 0.000168), finishReason: 'stop',
    }),
  });
  const text = formatSummary(outcome).join('\n');
  assert.equal(outcome.compactions, 0);
  assert.ok(!/compact/i.test(text), `warned about compaction on a clean run:\n${text}`);
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) one render path — the note is printed ONCE
 * ──────────────────────────────────────────────────────────────────────────── */

/** A model that streams its prose the way a real provider does. */
function streamingScript(text, { chunk = 12 } = {}) {
  return async (_n, opts) => {
    for (let i = 0; i < text.length; i += chunk) opts.onText?.(text.slice(i, i + chunk));
    return { ok: true, content: text, toolCalls: [], usage: usageWith(1000, 900), finishReason: 'stop' };
  };
}

test('a note the terminal already streamed IN FULL is not printed a second time', async (t) => {
  const dir = workspace(t);
  const shown = [];
  const { outcome } = await driveSession({
    dir,
    onEvent: (e) => { if (e.type === 'stream') shown.push(e.text); },
    script: streamingScript('All done — the file is written.'),
  });

  /**
   * ⚠️ MEASURED DEFECT: the streamer never got flushed, so a note with no
   * trailing newline was cut and the tail silently dropped; the summary then
   * printed the whole thing again. Two copies, one of them broken.
   */
  const streamed = shown.join('').replace(/\s+/g, ' ').trim();
  assert.equal(streamed, 'All done — the file is written.',
    'the live printer dropped the tail of the note');

  assert.equal(outcome.noteAlreadyShown, true);
  const text = formatSummary(outcome).join('\n');
  assert.ok(!text.includes('All done'),
    `the note was rendered twice — once live, once in the summary:\n${text}`);
});

test('⚠️⚠️ the whole terminal prints the note EXACTLY ONCE — measured through renderEvent', async (t) => {
  /**
   * MEASURED, and it is why the first fix was not enough. There are THREE places
   * that can print the model's prose: the live stream, the `note` event, and the
   * summary. `renderEvent` suppresses the `note` event only when `streamed` is
   * true, and `streamed` was `live.linesPrinted() > 0` — a counter that
   * `flush()` does not increment. So a one-line closing sentence, which is most
   * of them, streamed to the terminal and then printed AGAIN one line below.
   *
   * This drives the real render path bin/acuvo.mjs uses and counts occurrences.
   */
  const dir = workspace(t);
  const printed = [];
  const note = 'All done — src/greet.js now exports greet().';
  const { outcome } = await driveSession({
    dir,
    onEvent: (e) => { const l = renderEvent(e); if (l.length > 0) printed.push(l.join('\n')); },
    script: streamingScript(note),
  });
  const whole = `${printed.join('\n')}\n${formatSummary(outcome).join('\n')}`;
  const hits = whole.split('src/greet.js now exports').length - 1;
  assert.equal(hits, 1, `the note appeared ${hits}× in the terminal:\n${whole}`);
});

test('a note too long to stream is PREVIEWED, marked as cut, and printed in full once', async (t) => {
  const dir = workspace(t);
  const long = Array.from({ length: 9 }, (_, i) => `line ${i} ${'w'.repeat(70)}`).join('\n');
  const shown = [];
  const { outcome } = await driveSession({
    dir,
    onEvent: (e) => { if (e.type === 'stream') shown.push(e.text); },
    script: streamingScript(long),
  });

  const streamed = shown.join('');
  assert.ok(streamed.length > 0, 'nothing was streamed at all');
  // ⚠️ THE PREVIEW MUST SAY IT IS A PREVIEW. Cut mid-word with no marker reads
  // as broken output, which is how a working tool loses trust.
  assert.ok(streamed.includes('…'), `a truncated preview carried no ellipsis:\n${streamed}`);

  assert.equal(outcome.noteAlreadyShown, false);
  const text = formatSummary(outcome).join('\n');
  assert.ok(text.includes('line 8'), 'the full note must appear exactly once, in the summary');
});

test('a run nobody watched still prints its note — suppression needs proof it was shown', async (t) => {
  /**
   * ⚠️⚠️ THE FAILURE THIS GUARDS. `--json`, the parallel fan-out and every test
   * pass an `onEvent` that discards. If "was it streamed?" were inferred from
   * the model having emitted deltas rather than from the text having been
   * emitted as events, those runs would lose their note entirely — a summary
   * that silently drops the model's answer.
   */
  const dir = workspace(t);
  const { outcome } = await driveSession({
    dir,
    onEvent: () => {},
    script: async () => ({
      ok: true, content: 'All done — the file is written.', toolCalls: [],
      usage: usageWith(1000, 900), finishReason: 'stop',
    }),
  });
  assert.equal(outcome.noteAlreadyShown, false);
  assert.ok(formatSummary(outcome).join('\n').includes('All done'),
    'a non-streaming run lost its note');
});
