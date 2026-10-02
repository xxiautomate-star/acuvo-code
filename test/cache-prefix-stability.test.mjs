/**
 * ── ⭐⭐ THE CACHE IS THE MARGIN, SO THE PREFIX IS THE PRODUCT ───────────────
 *
 * A cached prompt prefix is billed at a fraction of an uncached one — measured on
 * DeepSeek at 3–4x cheaper, and up to 50x on some providers. The cache is keyed
 * on an EXACT BYTE PREFIX: everything up to the first differing byte is reused,
 * and everything from that byte on is paid for in full.
 *
 * ⚠️ SO ONE CHANGED CHARACTER EARLY IN THE CONVERSATION COSTS MORE THAN A
 * THOUSAND ADDED AT THE END. A timestamp in the system prompt, a round counter
 * that lives near the top, a file listing that reorders — each is invisible in
 * review, silent at runtime, and multiplies the bill of every later round.
 *
 * Real runs measured 2026-08-12 reported **0%, 32%, 33%** cache hit rates. That
 * is either the provider warming up (rounds 1–2 are legitimately cold) or our own
 * prefix moving. Those two have very different fixes, and nothing in this package
 * could tell them apart — this file can.
 *
 * ⚠️ IT COSTS $0.00: the model is scripted, so the assertion is about the BYTES
 * WE SEND, which is the half we control and the only half worth testing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { resetVisionState, MAX_LOOKS_PER_PROCESS } from '../lib/vision.mjs';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function workspace({ plan = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-cache-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"c","version":"1.0.0"}\n');
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.js'), 'export const b = 2;\n');
  /**
   * ⚠⚠ WITHOUT THIS, THE ONE PER-ROUND INJECTION HAD ZERO COVERAGE. Every
   * test in this file used to run against a workspace with no `.acuvo/plan.json`,
   * so `planBannerFor` returned null on every round ("no plan file ⇒ no banner",
   * turn.mjs) and the round countdown — the only thing in the loop that injects
   * VARYING text per round, and therefore the only realistic way to rewrite the
   * prefix — was never exercised by the file whose whole purpose is protecting
   * the prefix. The banner is append-only today and these tests pass with it on;
   * a regression that spliced it into the middle would have shipped green.
   */
  if (plan) {
    mkdirSync(join(root, '.acuvo'), { recursive: true });
    writeFileSync(join(root, '.acuvo', 'plan.json'), JSON.stringify({
      version: 1,
      task: 'look at a.js and b.js, then say what they export',
      steps: [
        { id: 's1', text: 'read a.js', state: 'done' },
        { id: 's2', text: 'read b.js', state: 'doing' },
        { id: 's3', text: 'report what they export', state: 'todo' },
      ],
    }, null, 2));
  }
  return root;
}

/**
 * What a provider actually caches: the serialised conversation, in order. Role
 * and content both matter, because both are sent.
 *
 * ⚠️⚠️ THE SEPARATORS ARE WRITTEN AS `\u0000` / `\u0001`, NOT AS THE RAW
 * CHARACTERS, and that is not style. They used to be literal control characters
 * in the source, which render as NOTHING in every viewer — so the split below
 * read on screen as `payload.split('')[0]`. A `split('')` returns single
 * CHARACTERS, which would make `assert.equal(new Set(system).size, 1)` in the
 * workspace-reorder test pass on a set of identical one-character strings: a
 * guard that can never fail, arrived at by an edit nobody could see. Any editor
 * "strip control characters", any lint autofix, any copy through a sanitising
 * channel does exactly that, and no test goes red. Same bytes at runtime,
 * visible in review.
 *
 * ⚠️ AND IT COVERS `tool_calls` / `tool_call_id`. Those fields are SENT and
 * were not serialised, so the assistant message's synthesised ids
 * (`call_${round}_${i}`) and the model's tool arguments were invisible to every
 * assertion in this file — a reordering or a re-numbering there would have
 * shipped green.
 */
function serialise(messages) {
  return messages.map((m) => [
    m.role,
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    m.tool_calls ? JSON.stringify(m.tool_calls) : '',
    m.tool_call_id ?? '',
  ].join('\u0000')).join('\u0001');
}

/** Length of the shared leading byte-run between two strings. */
function sharedPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

const reply = (content, toolCalls = []) => ({
  ok: true, content, toolCalls, usage: { cost: 0.0005, total_tokens: 900 }, finishReason: 'stop', model: 'fake/model',
});
const call = (name, args) => ({ id: `c${Math.random().toString(36).slice(2, 7)}`, function: { name, arguments: JSON.stringify(args) } });

/** Drive a real multi-round session and capture what was sent each round. */
async function capture(root, script, extra = {}) {
  const sent = [];
  /**
   * ⭐⭐ THE TOOLS ARRAY IS SERIALISED AHEAD OF THE MESSAGES IN THE PROVIDER'S
   * CACHED PREFIX, so a one-byte change there costs 100% of the prefix rather
   * than a suffix — and this file, whose entire job is prefix stability, measured
   * `opts.messages` and never looked at `opts.tools`. It is free to record: the
   * model is scripted.
   */
  const toolShapes = [];
  let i = 0;
  const model = async (opts) => {
    sent.push(serialise(opts.messages));
    toolShapes.push(JSON.stringify(opts.tools ?? null));
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return step;
  };
  const outcome = await runSession({
    task: 'look at a.js and b.js, then say what they export',
    executor: createLocalExecutor(root),
    config: { apiKey: 'x', model: 'fake/model' },
    maxRounds: 5,
    allowRun: false,
    callModelImpl: model,
    onEvent: () => {},
    ...extra,
  });
  return { sent, toolShapes, outcome };
}

// ── ⭐⭐ the property the margin depends on ─────────────────────────────────

test('⭐⭐ every round RE-SENDS the previous round\'s bytes unchanged', async () => {
  /**
   * The cache reuses everything up to the first differing byte. If round N+1's
   * payload does not START with round N's payload, the divergence point is where
   * we begin paying full price — and the earlier it is, the more it costs.
   */
  const root = workspace();
  const { sent } = await capture(root, [
    reply('reading', [call('read_file', { path: 'a.js' })]),
    reply('reading more', [call('read_file', { path: 'b.js' })]),
    reply('a exports a, b exports b'),
  ]);

  assert.ok(sent.length >= 3, `expected at least 3 rounds, got ${sent.length}`);

  for (let i = 1; i < sent.length; i += 1) {
    const prev = sent[i - 1];
    const cur = sent[i];
    const shared = sharedPrefix(prev, cur);
    /**
     * ⚠️ THE WHOLE OF THE PREVIOUS PAYLOAD MUST SURVIVE. Anything less means we
     * rewrote history — and rewriting history is the one thing that turns a
     * cheap continuation into a full-price call.
     */
    assert.equal(
      shared,
      prev.length,
      `round ${i + 1} diverged from round ${i} at byte ${shared} of ${prev.length}. `
        + `Round ${i} ended: ${JSON.stringify(prev.slice(Math.max(0, shared - 80), shared + 40))}\n`
        + `Round ${i + 1} has:  ${JSON.stringify(cur.slice(Math.max(0, shared - 80), shared + 40))}`,
    );
  }
});

test('the system message — the most valuable bytes — never changes', async () => {
  /**
   * ⚠️ IT IS FIRST, SO IT IS THE CHEAPEST THING TO GET WRONG AND THE MOST
   * EXPENSIVE. A byte that moves here invalidates the ENTIRE conversation behind
   * it, every round, for the whole session.
   */
  const root = workspace();
  const { sent } = await capture(root, [
    reply('one', [call('read_file', { path: 'a.js' })]),
    reply('two', [call('list_dir', { path: '.' })]),
    reply('done'),
  ]);

  const systemOf = (payload) => payload.split('\u0001')[0];
  const first = systemOf(sent[0]);
  for (let i = 1; i < sent.length; i += 1) {
    assert.equal(systemOf(sent[i]), first, `the system message changed at round ${i + 1}`);
  }
  // ⚠️ And it must be substantial — a tiny system message means the cacheable
  // prefix is tiny, which is the same problem wearing different clothes.
  assert.ok(first.length > 500, `the system message is only ${first.length} bytes`);
});

test('⚠️ growth is at the END — the prefix never shrinks', async () => {
  const root = workspace();
  const { sent } = await capture(root, [
    reply('a', [call('read_file', { path: 'a.js' })]),
    reply('b', [call('read_file', { path: 'b.js' })]),
    reply('c'),
  ]);
  for (let i = 1; i < sent.length; i += 1) {
    assert.ok(
      sent[i].length >= sent[i - 1].length,
      `round ${i + 1} sent FEWER bytes than round ${i} — history was rewritten, and the cache is gone`,
    );
  }
});

test('the cacheable share rises with each round', async () => {
  /**
   * ⭐ THE NUMBER THAT MATTERS COMMERCIALLY. Round 1 is legitimately 0% — nothing
   * is cached yet. By round 3 the great majority of the payload should be bytes
   * the provider has already seen, and if it is not, the loop is re-sending
   * work rather than continuing it.
   */
  const root = workspace();
  const { sent } = await capture(root, [
    reply('a', [call('read_file', { path: 'a.js' })]),
    reply('b', [call('read_file', { path: 'b.js' })]),
    reply('c', [call('list_dir', { path: '.' })]),
    reply('done'),
  ]);

  const shares = sent.map((cur, i) => (i === 0 ? 0 : sharedPrefix(sent[i - 1], cur) / cur.length));
  const last = shares[shares.length - 1];
  assert.ok(
    last > 0.7,
    `only ${(last * 100).toFixed(1)}% of the final round was a re-send of bytes already sent — `
      + `the cacheable share should be well above 70% by then. Shares: ${shares.map((s) => `${(s * 100).toFixed(0)}%`).join(' ')}`,
  );
});

test('a workspace listing does not reorder between rounds', async () => {
  /**
   * ⚠️ A REAL AND INVISIBLE CACHE KILLER: `readdir` order is not guaranteed
   * stable across calls on every filesystem, and a file list that reshuffles
   * rewrites the workspace context — which sits in the SYSTEM message, i.e. the
   * most expensive possible place to change a byte.
   */
  const root = workspace();
  const { sent } = await capture(root, [reply('x'), reply('y'), reply('z')]);
  const system = sent.map((p) => p.split('\u0001')[0]);
  assert.equal(new Set(system).size, 1, 'the workspace context is not byte-identical across rounds');
});

test('⭐⭐ the TOOLS array is byte-identical every round — it sits AHEAD of the messages', async () => {
  /**
   * ⭐ THE PART OF THE PREFIX THIS FILE COULD NOT SEE. A provider serialises the
   * tool schemas BEFORE the conversation, so a single byte moving there costs
   * 100% of the prefix rather than a suffix — and every assertion above measured
   * `opts.messages` only.
   *
   * It holds by construction today: the offer is built ONCE outside the loop and
   * the same array object is passed on every round, and `toolSchemasFor` filters
   * over a literal source-ordered registry so the caller's name order cannot
   * reorder the payload. This pins that, because "true by construction" is a
   * property of the construction, and constructions get edited.
   */
  const root = workspace();
  const { toolShapes } = await capture(root, [
    reply('a', [call('read_file', { path: 'a.js' })]),
    reply('b', [call('list_dir', { path: '.' })]),
    reply('done'),
  ]);
  assert.ok(toolShapes.length >= 3, `expected at least 3 rounds, got ${toolShapes.length}`);
  assert.equal(
    new Set(toolShapes).size,
    1,
    'the tool offer changed mid-session. It precedes the messages in the cached prefix, so this costs '
      + 'the WHOLE prompt, not the tail.',
  );
  // ⚠️ And it must be substantial — an empty offer would satisfy the check above
  // while meaning the agent was handed no tools at all.
  assert.ok(JSON.parse(toolShapes[0]).length > 5, 'the offer should be a real tool set');
});

test('⭐⭐ the round countdown is APPENDED — with a plan file on disk, which is the case that was never tested', async () => {
  /**
   * ⚠️ THE GAP THIS CLOSES. `planBannerFor` returns null when there is no
   * `.acuvo/plan.json`, and no test in this file created one — so the round
   * countdown, the ONLY per-round varying injection in the loop, had zero
   * coverage in the file that exists to protect the prefix. The banner is
   * pushed at the TAIL today (after the previous round's assistant and tool
   * messages), which is correct and cheap; a regression that spliced it into
   * the prefix instead would have shipped green.
   */
  const root = workspace({ plan: true });
  const { sent } = await capture(root, [
    reply('reading', [call('read_file', { path: 'a.js' })]),
    reply('reading more', [call('read_file', { path: 'b.js' })]),
    reply('done'),
  ]);
  assert.ok(sent.length >= 3, `expected at least 3 rounds, got ${sent.length}`);
  /**
   * ⚠️⚠️ FIRST, PROVE THE FIXTURE IS REACHING THE CODE. A plan.json that
   * `parsePlan` rejects (wrong key names, a missing `task`, an id that fails
   * /^s[1-9][0-9]*$/) produces NO banner and no error — and this test would then
   * pass while testing exactly what it passed before, which is the whole defect
   * it was written to close. Assert the banner is in the payload before
   * asserting anything about where it sits.
   */
  assert.ok(
    sent.some((p) => /plan: \d+\/\d+ done/.test(p)),
    'the plan fixture never produced a banner — parsePlan rejected it, so this test is vacuous',
  );
  for (let i = 1; i < sent.length; i += 1) {
    const shared = sharedPrefix(sent[i - 1], sent[i]);
    assert.equal(
      shared,
      sent[i - 1].length,
      `with a plan on disk, round ${i + 1} diverged from round ${i} at byte ${shared} of ${sent[i - 1].length} — `
        + 'the countdown banner is rewriting history instead of being appended.',
    );
  }
});

// ── ⭐ THE HALF WE DO NOT CONTROL: WHICH INSTANCE SERVES THE ROUND ──────────

test('the provider preference is ON by default and keeps fallbacks either way', async () => {
  /**
   * ⭐ THE MEASUREMENT THAT MOTIVATES THIS. With a scripted model, rounds 2 and 3
   * were a **97.0% and 97.9% byte-identical re-send** of the round before, and
   * the `tools` array was identical every round — our side of the cache contract
   * is essentially optimal.
   *
   * ⚠️ AND REAL RUNS THE SAME DAY REPORTED 0%, 32% AND 33%. A prompt cache lives
   * on ONE upstream instance, and OpenRouter routes freely behind a single model
   * id — `model.mjs` already documents the variation ("Baidu vs StreamLake on
   * the same model id"). Round 2 landing elsewhere is a cold cache that no
   * prefix discipline can fix.
   *
   * ⚠️ SO THIS IS A PREFERENCE, NOT A PIN. "Never single" is the standing rule:
   * `allow_fallbacks` stays true, because a cheaper request that does not happen
   * is not cheaper.
   */
  const { callModel, PROVIDER_PIN_BY_MODEL } = await import('../lib/model.mjs');
  const FLASH_MODEL = 'deepseek/deepseek-v4-flash-0731';
  const bodies = [];
  const fake = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }) };
  };

  /**
   * ⚠️ THIS ASSERTION IS INVERTED, AND ON PURPOSE. It read 'unset must send no
   * provider field at all — byte-identical to before', which was the right
   * default while nobody had chosen a provider. The owner has since chosen one:
   * unpinned measured 46.7% cache at $0.002217 a task against 95.8% at $0.000910
   * pinned, and 1 of the 28 endpoints caches nothing at all. What must NOT change
   * is the fallback — and that is what the rest of this test now guards.
   */
  /**
   * ── ⚠️⚠️ TWO PREMISES HERE CHANGED, AND BOTH WERE THE BUG ─────────────────
   *
   * 1. The model was `'m'` — a name nothing serves. It used to inherit the
   *    global pin, which is exactly the defect: `StreamLake` does not serve
   *    `deepseek-v4-pro-0813` either, so pro asked for a provider that could
   *    not answer and routed freely. MEASURED on the 13-task bench: pro was
   *    served by GMICloud 13 of 13 times, at 2.8x DeepSeek's own token price
   *    and 28x on cache reads. An unknown model is now left UNPINNED, so this
   *    asserts against a model we have actually measured.
   *
   * 2. `order.length === 1` — "one preferred provider, not a policy". One name
   *    plus `allow_fallbacks: true` degrades to the WHOLE open market the
   *    moment that provider has a bad day, which is how a cheap run silently
   *    becomes an expensive one. Two or three cheap endpoints in order degrade
   *    to another CHEAP one first. Still a preference, never a lock — and THAT
   *    is what this test is really for, asserted unchanged below.
   */
  await callModel({ apiKey: 'k', model: FLASH_MODEL, messages: [{ role: 'user', content: 'hi' }], fetchImpl: fake, env: {} });
  /**
   * ⚠⚠ THIS TEST DIAGNOSED THE BUG AND THEN CONCLUDED THE WRONG FIX.
   *
   * Its own comment above is exactly right: *"a prompt cache lives on ONE
   * upstream instance … round 2 landing elsewhere is a cold cache that no prefix
   * discipline can fix."* It then kept `allow_fallbacks: true`, reasoning that
   * "a cheaper request that does not happen is not cheaper" — true, but it is a
   * false choice.
   *
   * ⭐ The first attempt now LOCKS to one upstream (`allow_fallbacks: false`) and
   * a second attempt with the full list runs only if that upstream actually
   * fails. Measured on a real task immediately after: round 1 went 0% → 98%,
   * the run went 32% → 65%, and cost fell $0.0025 → $0.0017.
   *
   * -- AND THEN THE LOCK ITSELF WAS THE REMAINING HALF OF THE BUG ----------
   *
   * `provider.order` is what OpenRouter's own prompt-caching docs name as the
   * thing that DISABLES their sticky routing: *"Sticky routing is not used when
   * you specify a manual provider order via `provider.order`."* Sticky routing
   * is what pins the SERVER inside a provider's fleet -- the exact gap the
   * comment above correctly identifies and then could not close, because
   * StreamLake is a fleet and locking to the company never locked the machine.
   *
   * So the lock is now a WHITELIST: same one upstream, nothing outside it, and
   * no manual ordering for OpenRouter to give priority over.
   */
  /**
   * ⚠️⚠️ DERIVED FROM THE PIN, NEVER TYPED. This line has been hand-corrected
   * twice — StreamLake → DeepInfra (2026-08-27) → and it went red again on
   * 2026-09-10 when the lead moved to `Sail Research`. **The name is not what
   * this test is about**: it is about the warm attempt being a real one-name
   * LOCK rather than a preference list. `provider-pin-per-model.test.mjs`
   * pins WHICH endpoint leads, deliberately, in one place; a second copy here
   * is a second opinion that only ever goes stale.
   */
  assert.deepEqual(bodies[0].provider.only, [PROVIDER_PIN_BY_MODEL[FLASH_MODEL][0]],
    'the warm attempt must be a real lock on the pinned lead endpoint');
  assert.equal(bodies[0].provider.order, undefined,
    'an ORDER here switches off the server pinning this lock exists to get');

  await callModel({
    apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl: fake,
    env: { ACUVO_PROVIDER_ORDER: 'deepseek, novita' },
  });
  assert.deepEqual(bodies[1].provider.only, ['deepseek'], 'the warm attempt sends the LEAD of the order as written');
  // ⭐ An explicit two-name pin is warmed the same way: attempt 1 locks to the
  // first, and "never single" is kept by the retry, not by the first request.
  assert.equal(bodies[1].provider.order, undefined, 'the warm attempt locks by whitelist, not by ordering');

  // ⚠️ A blank or comma-only value is not a configuration.
  await callModel({ apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl: fake, env: { ACUVO_PROVIDER_ORDER: ' , ' } });
  assert.equal('provider' in bodies[2], false);
});

// ── ⭐⭐⭐ AND NOW THE RUN REPORTS IT ITSELF ─────────────────────────────────

/**
 * Everything above measures prefix stability from OUTSIDE, in a test. That
 * proved the property and told a USER nothing: a run that came back with a 31%
 * cache rate gave nobody a way to tell "our bytes moved" from "the provider
 * routed us to a cold machine" — and those have completely different fixes, one
 * of which is ours and one of which is not.
 *
 * Measured 2026-08-19: four cold runs went 65 / 98 / 31 / 98 while the shared
 * prefix across two COMPLETELY DIFFERENT tasks was 99.9% byte-identical. Three
 * separate assurances that caching was "at 90%" were wrong, and part of why
 * nobody could settle it is that the run summary reported only the rate.
 *
 * `lib/cache-floor.mjs` had the instrument all along and was imported by
 * nothing — `wiring-reach.test.mjs` was naming it as unreachable.
 */
test('⭐⭐⭐ the run summary reports OUR half of the cache contract, not just the provider\'s', async () => {
  const root = workspace();
  const { outcome } = await capture(root, [
    reply('reading', [call('read_file', { path: 'a.js' })]),
    reply('reading', [call('read_file', { path: 'b.js' })]),
    reply('they export a and b'),
  ]);

  const prefix = outcome.usage?.cache?.prefix;
  assert.ok(prefix, 'the run reported no prefix measurement at all — the instrument is unreachable again');
  assert.ok(prefix.rounds >= 2, 'a prefix reading needs at least one round to compare against');
  /**
   * ⭐ THE ASSERTION THAT MATTERS. An append-only loop re-sends the previous
   * round's bytes unchanged, so stability is exactly 1. Anything less means we
   * voided our own cache, and `driftRounds` says when.
   */
  assert.equal(prefix.minStability, 1, `we voided our own prefix on rounds ${prefix.driftRounds.join(', ')}`);
  assert.deepEqual(prefix.driftRounds, []);
});

test('⚠️ a single-round run reports NO prefix figure rather than a fictitious 100%', async () => {
  /**
   * There is nothing to compare a first prompt against. Reporting 100% would be
   * inventing a measurement out of an absence — the same class as printing
   * "0% cached" for a provider that said nothing, which `aggregateCache`
   * already refuses to do.
   */
  const root = workspace();
  const { outcome } = await capture(root, [reply('done in one')]);
  assert.equal(outcome.usage?.cache?.prefix ?? null, null);
});

test('⭐ the instrument is genuinely wired — a moved prefix is DETECTED, not assumed absent', async () => {
  /**
   * ⚠️ WITHOUT THIS THE TEST ABOVE CANNOT FAIL FOR THE RIGHT REASON. A wiring
   * that always reported `minStability: 1` — because it compared a string with
   * itself, say — would pass every assertion above and detect nothing ever.
   * So the same helper the product uses is asked to score a prefix that really
   * did move.
   */
  const { sharedPrefixBytes, wireBytes } = await import('../lib/cache-floor.mjs');
  const a = wireBytes({ tools: [{ name: 't' }], messages: [{ role: 'system', content: 'ONE' }] });
  const b = wireBytes({ tools: [{ name: 't' }], messages: [{ role: 'system', content: 'TWO' }] });
  const shared = sharedPrefixBytes(a, b);
  assert.ok(shared < a.length, 'a changed system message must not report a perfect prefix');
  assert.ok(shared > 10, 'and the shared head before the divergence must still be counted');
});

test('⚠️⚠️ the INSTRUMENT is right before its readings mean anything — JSON\'s closing bracket is not drift', async () => {
  /**
   * `wireBytes` wraps everything in one object, which is correct for comparing
   * two different requests and WRONG for comparing round N to round N+1:
   * `{"messages":[a,b]}` is not a prefix of `{"messages":[a,b,c]}` because `]}`
   * sits between them.
   *
   * ⭐ MEASURED WHEN IT HAPPENED: a perfectly stable loop scored 32,272 of
   * 32,274 bytes and the two missing ones were `]}` — reported as drift on
   * every single round. A reading like that sends somebody hunting a bug that
   * does not exist, which is worse than no reading at all.
   */
  const { wireBytes, appendOnlyWireBytes, sharedPrefixBytes } = await import('../lib/cache-floor.mjs');
  const before = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];
  const after = [...before, { role: 'assistant', content: 'A' }];
  const tools = [{ name: 't' }];

  // The envelope version loses the tail — this is the trap, asserted so it stays known.
  const wa = wireBytes({ tools, messages: before });
  const wb = wireBytes({ tools, messages: after });
  assert.ok(sharedPrefixBytes(wa, wb) < wa.length, 'if this ever equals, the envelope trap is gone and the comment above is stale');

  // The append-only version makes round N an EXACT prefix of round N+1.
  const aa = appendOnlyWireBytes({ tools, messages: before });
  const ab = appendOnlyWireBytes({ tools, messages: after });
  assert.equal(sharedPrefixBytes(aa, ab), aa.length, 'an appended message must strictly EXTEND the string');

  // ⚠️ And it must still DETECT a real change, or it is a measurement that
  // always says "perfect" — the exact failure mode this file exists to prevent.
  const changed = appendOnlyWireBytes({ tools, messages: [{ role: 'system', content: 'DIFFERENT' }, ...before.slice(1)] });
  assert.ok(sharedPrefixBytes(aa, changed) < aa.length, 'a changed system message must not report a perfect prefix');
});

// ── ⭐⭐⭐ THE EYES: A SECOND MODEL THAT MUST NOT TOUCH THE FIRST'S CACHE ────

/**
 * ⚠️⚠️ THE GAP THIS SECTION CLOSES. Everything above this line protects the
 * BUILD path, and the build model is `deepseek-v4-flash-0731`, whose input
 * modalities are `["text"]` — **it physically cannot see**. So looking at a
 * screenshot requires a SECOND model (`qwen3.7-flash`, 7x cheaper than
 * DeepSeek's own vision variant), and a second model is exactly the thing this
 * file exists to be afraid of: a model switch mid-session is how a cache dies.
 *
 * ⭐ IT IS SAFE TODAY, AND ONLY BY THREE PROPERTIES OF THE CURRENT CODE:
 *
 *   1. the IMAGE never enters the build payload at all — it goes to Qwen and
 *      nowhere else, because DeepSeek could not receive it if we tried;
 *   2. only the VERDICT comes back, capped at `max_tokens: 900` — a bounded
 *      string, not a re-description of the page;
 *   3. it arrives as a TOOL RESULT, APPENDED at the end, so the cacheable
 *      prefix in front of it stays byte-identical.
 *
 * ⚠️ ALL THREE ARE BEHAVIOURS, NOT INVARIANTS, and this file grepped for
 * `vision`, `read_image` and `image` and matched NOTHING — the one path that
 * introduces a second model was the one path the prefix guard did not cover.
 * A future change that inserts the verdict mid-context, or raises that
 * `max_tokens`, or lets an image description into the system prompt, would
 * collapse the cache with **no error and no symptom except a worse bill**.
 * That is the shape of every expensive defect in this repo.
 *
 * ⚠️ AND THE COST IS NOT THE QUESTION. Measured: one look is $0.000234, twelve
 * (the per-run cap) is $0.0028 — 0.016% of an A$29 month. The eyes were never a
 * margin decision. What they can damage is the BUILD path's cache, which is,
 * and that is the only thing asserted here.
 */

/** A real 1×1 PNG: `sniffImage` reads magic bytes, so a fake string will not do. */
const PNG_1X1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * The verdict the fake eyes return. Deliberately distinctive: the test asserts
 * it REACHES the build conversation, because a vision path that silently no-ops
 * would satisfy every "no image in the payload" assertion below perfectly.
 */
const VERDICT = 'ACUVO-VISION-VERDICT the heading reads "Hello" and the button overlaps it.';

function visionWorkspace() {
  const root = workspace();
  writeFileSync(join(root, 'shot.png'), Buffer.from(PNG_1X1_B64, 'base64'));
  return root;
}

/**
 * Drive a session in which the model LOOKS at an image, capturing both halves:
 * what went to the build model, and what went to the eyes.
 *
 * ⚠️ `tools.mjs` calls `readImage({ ...args, root })` with no `fetchImpl`, so
 * the eyes use the GLOBAL fetch and the ambient `OPENROUTER_API_KEY`. Stubbing
 * both is what makes this cost $0.00 — and restoring both in a `finally` is
 * what stops this file poisoning every suite that runs after it.
 */
async function captureWithEyes(root, script) {
  const realFetch = globalThis.fetch;
  const realKey = process.env.OPENROUTER_API_KEY;
  const visionRequests = [];
  resetVisionState();
  process.env.OPENROUTER_API_KEY = 'test-key-not-real';
  globalThis.fetch = async (url, opts) => {
    visionRequests.push({ url: String(url), body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: VERDICT } }],
        usage: { cost: 0.000234, prompt_tokens: 1400, completion_tokens: 40 },
      }),
      text: async () => '',
    };
  };
  try {
    /**
     * ⚠️⚠️ THE TASK TEXT IS LOAD-BEARING, AND FINDING THAT OUT WAS THE POINT.
     * `read_image` lives in the `media` shortlist group (`tool-shortlist.mjs`),
     * so it is offered only when the brief's own words select that group. The
     * first version of this fixture inherited `capture`'s default task — *"look
     * at a.js and b.js, then say what they export"* — which selects no media
     * group, and the offered set came back as 25 tools with **no `read_image`
     * in it**. The scripted model called the verb anyway and the executor
     * dispatched it on NAME, so the eyes fired from a session that never
     * offered them and every assertion here passed against an unreachable verb.
     *
     * ⭐ `image` is the trigger word. Keep one in this task or the offer
     * assertion below is testing the shortlist's default, not the eyes.
     */
    const captured = await capture(root, script, {
      task: 'look at the rendered image shot.png and say whether the heading is correct',
    });
    return { ...captured, visionRequests };
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = realKey;
    resetVisionState();
  }
}

const EYES_SCRIPT = [
  reply('let me read the source', [call('read_file', { path: 'a.js' })]),
  reply('now let me look at the render', [call('read_image', { path: 'shot.png' })]),
  reply('the heading is fine, the button is not'),
];

test('⭐⭐⭐ the EYES never put an image into the build payload — the second model is the cache risk', async () => {
  const root = visionWorkspace();
  const { sent, toolShapes, visionRequests } = await captureWithEyes(root, EYES_SCRIPT);

  /**
   * ⚠️⚠️ VACUITY FIRST, EXACTLY AS THE PLAN-BANNER TEST DOES IT. If `read_image`
   * were not offered in this session, or the executor refused the path, the
   * tool would never fire — and every assertion below would pass while proving
   * nothing at all, which is the failure mode this whole file was written
   * against. Prove the eyes RAN before asserting what they did not do.
   */
  assert.equal(visionRequests.length, 1, `the eyes did not fire — ${visionRequests.length} vision calls. This test is vacuous.`);
  assert.match(visionRequests[0].url, /openrouter\.ai/, 'the look did not go to the vision provider');

  /**
   * ⚠️⚠️ AND THE VERB MUST BE OFFERED, WHICH IS A SEPARATE FACT FROM IT RUNNING.
   * MEASURED, by deleting `names.push('read_image')` from `tools.mjs` and
   * re-running: **all sixteen tests still passed.** The scripted model in this
   * file emits the call whatever it was handed, and the executor dispatches on
   * NAME, so the eyes fired from a session that never offered them. Every
   * assertion here was true of a verb no real model could have reached.
   *
   * ⭐ So the offer is asserted directly. This is the one line that turns
   * "the vision path is cache-safe" into "the vision path is cache-safe AND
   * exists", and without it this whole section is a test of a dead verb.
   */
  const offered = JSON.parse(toolShapes[0]).map((t) => t.function?.name ?? t.name);
  assert.ok(
    offered.includes('read_image'),
    `read_image was never offered to the model — the eyes are unreachable in a real run. Offered: ${offered.join(', ')}`,
  );
  assert.ok(
    sent.some((p) => p.includes('ACUVO-VISION-VERDICT')),
    'the verdict never reached the build conversation — the look happened and its answer was dropped',
  );

  /**
   * ⭐ PROPERTY 1. The image goes to Qwen and NOWHERE ELSE. DeepSeek is
   * text-only; an image reaching it does not fail loudly, it gets dropped or
   * answered-about from the filename in confident prose. And in cache terms a
   * multi-hundred-KB base64 blob in the conversation is the most expensive
   * possible thing to put in a prefix.
   */
  for (const [i, payload] of sent.entries()) {
    assert.equal(payload.includes(PNG_1X1_B64.slice(0, 24)), false, `round ${i + 1} carried raw image bytes to the build model`);
    assert.equal(payload.includes('data:image/'), false, `round ${i + 1} carried a data: image URI to the build model`);
    assert.equal(payload.includes('image_url'), false, `round ${i + 1} carried an image_url part to the build model`);
  }
});

test('⭐⭐ the verdict is CAPPED at 900 tokens and reasoning is off — an unbounded look is an unbounded prefix', async () => {
  const root = visionWorkspace();
  const { visionRequests } = await captureWithEyes(root, EYES_SCRIPT);
  assert.equal(visionRequests.length, 1, 'the eyes did not fire — this test is vacuous');
  const body = visionRequests[0].body;

  /**
   * ⭐ PROPERTY 2. The verdict re-enters the build context ONCE as fresh input
   * and is cached forever after — but only because it is bounded. Raising this
   * ceiling is the single cheapest edit that would quietly make the eyes
   * expensive, and nothing else in the repo would notice.
   */
  assert.ok(body.max_tokens <= 900, `the vision call may return up to ${body.max_tokens} tokens into the build context`);

  /**
   * ⚠️ AND REASONING STAYS OFF. Measured on this account: a reasoning model
   * charges its thinking against `max_tokens` and can spend ALL of it — 15,999
   * reasoning tokens and an EMPTY reply. An empty reply from a vision model is
   * indistinguishable from "I saw nothing", which is the one output this module
   * must never produce.
   */
  assert.equal(body.reasoning?.enabled, false, 'reasoning is on, so the look can burn its whole budget and answer nothing');

  /**
   * ⭐ AND IT IS A DIFFERENT MODEL FROM THE ONE BUILDING. If these ever became
   * the same id, either the build model grew eyes (it has not) or the eyes were
   * pointed at a text-only model that will answer from the filename.
   */
  assert.notEqual(body.model, 'fake/model', 'the eyes were pointed at the build model, which cannot see');
  assert.ok(String(body.model).length > 0, 'the vision call named no model');
});

test('⭐⭐⭐ a look is APPENDED — the prefix in front of the verdict stays byte-identical', async () => {
  /**
   * ⭐ PROPERTY 3, AND THE ONE THIS FILE ACTUALLY EXISTS FOR. The verdict
   * arrives as a tool result at the END. `turn.mjs` states the rule it depends
   * on: *"APPENDED, never inserted. The system message and the workspace
   * context are the cacheable prefix; a line added to the END leaves that
   * prefix byte-identical."*
   *
   * ⚠️ A regression that spliced the verdict into the system message — an
   * entirely reasonable-looking "give the model the visual context up front"
   * change — would void the whole prefix on every round after the first look,
   * and produce no error and no failing test anywhere else in this package.
   */
  const root = visionWorkspace();
  const { sent } = await captureWithEyes(root, EYES_SCRIPT);
  assert.ok(sent.length >= 3, `expected at least 3 rounds, got ${sent.length}`);

  const verdictRound = sent.findIndex((p) => p.includes('ACUVO-VISION-VERDICT'));
  assert.ok(verdictRound > 0, 'the verdict never reached a build payload — this test is vacuous');

  for (let i = 1; i < sent.length; i += 1) {
    const shared = sharedPrefix(sent[i - 1], sent[i]);
    assert.equal(
      shared,
      sent[i - 1].length,
      `the look rewrote history: round ${i + 1} diverged from round ${i} at byte ${shared} of ${sent[i - 1].length}.\n`
        + `Round ${i} ended: ${JSON.stringify(sent[i - 1].slice(Math.max(0, shared - 80), shared + 40))}\n`
        + `Round ${i + 1} has:  ${JSON.stringify(sent[i].slice(Math.max(0, shared - 80), shared + 40))}`,
    );
  }

  /**
   * ⚠️ AND THE SYSTEM MESSAGE SPECIFICALLY — the most expensive bytes in the
   * request, and the most tempting place to put "what the page looks like".
   */
  const systemOf = (p) => p.split('\u0001')[0];
  assert.equal(new Set(sent.map(systemOf)).size, 1, 'the system message changed across a look');
  assert.equal(systemOf(sent[0]).includes('ACUVO-VISION-VERDICT'), false, 'the verdict was hoisted into the system message');
});

test('⚠️ the per-run look cap is real — an unbounded number of looks is an unbounded tail', async () => {
  /**
   * ⭐ THE OTHER BOUND. `max_tokens` caps ONE verdict; `MAX_LOOKS_PER_PROCESS`
   * caps how many of them can accumulate at the end of the conversation. Both
   * are needed: twelve uncapped looks is a different bill from one.
   *
   * ⚠️ Asserted through the CAP ITSELF rather than by driving 13 rounds, because
   * a loop that stops early for an unrelated reason would make a round-driving
   * version of this test pass while proving nothing.
   */
  assert.ok(Number.isFinite(MAX_LOOKS_PER_PROCESS), 'the look cap is not a number');
  assert.ok(MAX_LOOKS_PER_PROCESS > 0 && MAX_LOOKS_PER_PROCESS <= 20, `the per-run look cap is ${MAX_LOOKS_PER_PROCESS}`);
});
