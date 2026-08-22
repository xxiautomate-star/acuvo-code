/**
 * ── ⭐⭐ A PIN THAT DOES NOT TAKE HAS NO SYMPTOM EXCEPT A WORSE BILL ─────────
 *
 * MEASURED 2026-08-14, and this file exists because of it. `deepseek-v4-flash-0731`
 * is served by **28 upstream endpoints** on OpenRouter; a prompt cache lives on
 * exactly ONE of them. The same 4-round CLI task, n=2 per arm:
 *
 *     unpinned   48.6% hit  $0.002184   |  unpinned   46.7% hit  $0.002217
 *     DeepInfra  73.7% hit  $0.001492   |  DeepInfra  95.8% hit  $0.000910
 *
 * ⚠️ THE DEFECT IS NOT THE FALLBACK, IT IS THE SILENCE. `allow_fallbacks: true`
 * is deliberate and stays — "never single" is this package's standing rule, and
 * a cheaper request that does not happen is not cheaper. But OpenRouter does NOT
 * reject an `order` list it cannot honour: it treats it as an empty preference
 * and routes at random. Measured: `ACUVO_PROVIDER_ORDER=DeepSeek` 404s when sent
 * alone (the account's data policy excludes it), and inside the real payload it
 * fell back silently and measured **0.0% cached**. Three outcomes, not two —
 * honoured, rejected loudly, and accepted-ignored-billed — and the third was
 * indistinguishable from the first at every layer of this CLI.
 *
 * ⚠️ AND THE ROUTING WAS NEVER RECORDED. OpenRouter states the serving upstream
 * as `provider` on the response body AND on every SSE frame; both readers
 * dropped it. So a durable 47% and a durable 95% sat in the audit log with
 * nothing to distinguish "our prefix regressed" from "we were scattered across
 * cold caches" — two problems with entirely different fixes.
 *
 * ⚠️ IT COSTS $0.00. Every model here is a stub or a scripted function; the
 * assertions are about the bytes we send and the fields we keep, which is the
 * half we control and the only half a unit test can honestly pin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import {
  callModel, extractReply, pinOutcome, classifyHttpFailure, DEFAULT_PROVIDER_ORDER,
} from '../lib/model.mjs';
import { collectStream } from '../lib/stream.mjs';
import { runSession, aggregateProviders, formatSummary } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { toJson } from '../lib/report.mjs';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-provider-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"p","version":"1.0.0"}\n');
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  return root;
}

/** An SSE body as a byte stream, the shape `collectStream` actually consumes. */
function sseStream(frames) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

// ── ⭐ THE FIELD ITSELF: RECEIVED ON EVERY CALL, PREVIOUSLY THROWN AWAY ──────

test('⭐ extractReply keeps the serving provider off the response body', () => {
  const r = extractReply({
    provider: 'DeepInfra',
    choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    usage: { cost: 0.0001 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'DeepInfra');
});

test('⚠️ a body that names no provider is UNKNOWN, never guessed', () => {
  // ⚠️ The trap: defaulting to '' or to the pinned name would make "the provider
  // said nothing" look like "the pin took", which is the exact failure this
  // whole file exists to make impossible.
  const r = extractReply({ choices: [{ message: { content: 'hi' } }] });
  assert.equal(r.provider, null);
  const blank = extractReply({ provider: '', choices: [{ message: { content: 'hi' } }] });
  assert.equal(blank.provider, null);
  const wrongType = extractReply({ provider: { name: 'x' }, choices: [{ message: { content: 'hi' } }] });
  assert.equal(wrongType.provider, null);
});

test('⭐⭐ the STREAMING path keeps it too — and that is the path the CLI always takes', async () => {
  /**
   * ⚠️ `turn.mjs` passes `onText` on every round, so the streaming branch is the
   * CLI's ONLY branch. Capturing the provider solely in `extractReply` would
   * have instrumented the path nothing takes — a fix that measures 100% in
   * review and 0% in production.
   */
  const collected = await collectStream(sseStream([
    { provider: 'GMICloud', choices: [{ delta: { content: 'he' } }] },
    { provider: 'GMICloud', choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] },
    { usage: { cost: 0.0002 } },
  ]));
  assert.equal(collected.ok, true);
  assert.equal(collected.content, 'hello');
  assert.equal(collected.provider, 'GMICloud');

  const silent = await collectStream(sseStream([
    { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] },
  ]));
  assert.equal(silent.provider, null, 'a stream that never mentions it stays unknown');
});

// ── ⭐⭐ DID THE PIN TAKE ────────────────────────────────────────────────────

test('⭐⭐ pinOutcome distinguishes all five states, and NEVER guesses', () => {
  assert.equal(pinOutcome({ pin: null, served: 'DeepInfra' }), 'none', 'no pin is not a miss');
  assert.equal(pinOutcome({ pin: [], served: 'DeepInfra' }), 'none');
  assert.equal(pinOutcome({ pin: ['DeepInfra'], served: null }), 'unknown',
    'pinned but unreported must not be scored either way');
  assert.equal(pinOutcome({ pin: ['DeepInfra'], served: 'DeepInfra' }), 'took');
  assert.equal(pinOutcome({ pin: ['DeepInfra'], served: 'Decart' }), 'missed');
});

/**
 * ── ⚠️⚠️ THE ASSERTION THAT USED TO LIVE ABOVE ENCODED THE BUG ──────────────
 *
 * It read: *"A preference LIST is honoured if any of its names served it"* and
 * asserted `pinOutcome({ pin: ['DeepInfra','Novita'], served: 'Novita' })` was
 * `'took'`. True of AVAILABILITY, false of the thing the pin is for. **A prompt
 * cache lives on ONE upstream instance**, so the second name is a live provider
 * and a cold cache, and it was scored as a success at every layer.
 *
 * ⭐ MEASURED 2026-08-16, replaying ONE byte-identical 46,171-byte payload
 * against `order: [StreamLake, Baidu, GMICloud]`:
 *
 *     StreamLake (first)    11,520 of 11,714 cached   98.3%   $0.000172
 *     Baidu      (second)        0 of 11,714 cached    0.0%   $0.000791
 *
 * 4.6× on one round for identical bytes, reported as `pinTook: 1, pinMissed: 0`.
 * Over 40 pinned calls the scatter was StreamLake 38, Baidu 2 — a ~5% event that
 * nothing in this package could see, name, or price.
 */
test('⭐⭐ a fallback INSIDE the pin list is its own outcome — a live provider and a cold cache', () => {
  assert.equal(pinOutcome({ pin: ['DeepInfra', 'Novita'], served: 'DeepInfra' }), 'took',
    'the FIRST name is the only one whose cache we have been accumulating on');
  assert.equal(pinOutcome({ pin: ['DeepInfra', 'Novita'], served: 'Novita' }), 'fell-back',
    'available, billed, and cold — it must never read as `took`');
  assert.equal(pinOutcome({ pin: ['StreamLake', 'Baidu', 'GMICloud'], served: 'GMICloud' }), 'fell-back',
    'the third name is a fallback too, not a miss');
  assert.equal(pinOutcome({ pin: ['StreamLake', 'Baidu'], served: 'Relace' }), 'missed',
    'outside the list entirely is still the loud failure it always was');
});

test('⚠️ the comparison is case- and whitespace-insensitive, because one false alarm kills the real one', () => {
  // The catalogue writes `DeepInfra`; people type `deepinfra`. A "pin did not
  // take" warning caused by a capital letter teaches the reader to ignore the
  // warning, and then the genuine one costs 2.4x the bill unnoticed.
  assert.equal(pinOutcome({ pin: ['deepinfra'], served: 'DeepInfra' }), 'took');
  assert.equal(pinOutcome({ pin: [' DeepInfra '], served: 'DeepInfra' }), 'took');
});

test('⭐ the DEFAULT pin names a provider — the owner made that call', () => {
  /**
   * ── ⭐⭐ THIS ASSERTION DID ITS JOB AND IS NOW RETIRED ──────────────────────
   *
   * It read: *"naming a third party is the owner's call, not this file's… If
   * this assertion fails, somebody made that decision in a diff instead of in a
   * conversation."* That is exactly right, and it held the line for a day.
   *
   * ⭐ THE CONVERSATION HAPPENED. The owner's direction, verbatim: *"making the
   * caching real, the model switching real and locked."* So the decision was
   * made where it belonged and this test is being changed because of it, not in
   * spite of it.
   *
   * THE EVIDENCE IT WAS MADE ON, all measured:
   *   · 28 endpoints serve this model; a prompt cache lives on ONE instance
   *   · unpinned 48.6% / 46.7% cache at $0.002217 per task
   *   · pinned    73.7% / 95.8% cache at $0.000910 — 2.4x cheaper
   *   · StreamLake is cheapest at OUR real cache rate ($0.0327/M effective),
   *     not merely on the headline per-token price
   *   · ⚠️ 1 of the 28 publishes NO cache-read price, so unpinned a run can land
   *     where nothing caches at all and nothing says so
   *
   * ⚠️ WHAT MUST STAY TRUE, and is asserted below rather than assumed: this is a
   * PREFERENCE, not a lock. `allow_fallbacks` remains true, so an outage
   * degrades instead of killing every run at once. Measured on the bench the
   * same hour: one task of four fell back to Baidu and its cache dropped to 33%
   * — the pin improving the odds, not guaranteeing them, which is the honest
   * shape of it.
   */
  assert.ok(DEFAULT_PROVIDER_ORDER.trim().length > 0, 'an empty default is the routing lottery');
  assert.ok(!DEFAULT_PROVIDER_ORDER.includes(','), 'one preferred provider, not a list pretending to be a policy');
});

// ── ⭐ WHAT WE ASKED FOR TRAVELS BACK WITH WHAT WE GOT ──────────────────────

test('⭐ callModel returns the pin it sent, so the loop can compare', async () => {
  const bodies = [];
  const fake = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ provider: 'Decart', choices: [{ message: { content: 'x' } }], usage: {} }),
    };
  };

  const unpinned = await callModel({
    // ⚠️ EXPLICITLY UNPINNED — a bare {} now inherits the DEFAULT pin, and this
    // assertion is about the unpinned shape specifically.
    apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl: fake, env: { ACUVO_PROVIDER_ORDER: '' },
  });
  assert.equal(unpinned.providerPin, null, 'null, never [] — an empty array reads as "a pin that matched nothing"');
  assert.equal(unpinned.provider, 'Decart');

  const pinned = await callModel({
    apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl: fake,
    env: { ACUVO_PROVIDER_ORDER: 'DeepInfra, Novita' },
  });
  assert.deepEqual(pinned.providerPin, ['DeepInfra', 'Novita'],
    'the REPORTED pin is still the whole order, so the loop can compare what it asked for');

  /**
   * ⚠⚠ THIS FLIPPED, AND THE FALLBACK DID NOT GO AWAY — IT MOVED.
   *
   * The first attempt now locks to ONE upstream with `allow_fallbacks: false`,
   * because a preference over several providers lands wherever and the prompt
   * cache lives on exactly one of them (measured: 51.2% token-weighted across
   * 90 runs, round 1 non-zero on 3 of 16). Fallbacks are still there, on the
   * SECOND attempt, which only runs if the pinned upstream actually fails.
   *
   * So "the silence was the bug, not the fallback" still holds: nothing is
   * silent, and nothing is single — see provider-pin-per-model.test.mjs, which
   * pins both halves.
   */
  assert.equal(bodies[1].provider.only.length, 1, 'the warm attempt pins exactly one upstream');
  assert.equal(bodies[1].provider.order, undefined,
    'a manual order here disables OpenRouter sticky routing — see provider-pin-per-model.test.mjs');
});

test('⚠️ ACUVO_PROVIDER_STRICT is the opt-in hard pin, and is meaningless without a pin', async () => {
  const bodies = [];
  const fake = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }),
    };
  };
  await callModel({
    apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl: fake,
    env: { ACUVO_PROVIDER_ORDER: 'DeepInfra', ACUVO_PROVIDER_STRICT: '1' },
  });
  /**
   * ⭐ STRICT IS NOW A WHITELIST, WHICH IS THE TRUER STATEMENT OF IT. `only`
   * cannot be left at all, so an unavailable upstream is a 404 rather than a
   * silent re-route — exactly what `allow_fallbacks: false` was asking for,
   * said in the vocabulary that does not switch off sticky routing.
   */
  assert.ok(Array.isArray(bodies[0].provider.only), 'strict means a 404 instead of a silent re-route');
  assert.equal(bodies[0].provider.order, undefined, 'and not by an ordering, which would disable sticky routing');

  /**
   * ⚠️⚠️ STRICT WITHOUT AN EXPLICIT PIN MUST NOT HARDEN THE DEFAULT ONE.
   * Since DEFAULT_PROVIDER_ORDER names a provider, a naive implementation would
   * let this one flag turn our PREFERENCE into a LOCK on a provider the user
   * never chose — and the day it has a bad ten minutes, every run dies at once.
   * That is the 'never single' failure this package refuses. Strict is only ever
   * strict about a pin a human typed.
   */
  await callModel({
    apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl: fake,
    env: { ACUVO_PROVIDER_STRICT: '1' },
  });
  assert.notEqual(bodies[1].provider?.allow_fallbacks, false,
    'the default pin must stay a preference — strict may not promote it to a lock');
});

test('⚠️ a 404 that carried a pin names ACUVO_PROVIDER_ORDER — it used to blame the model id', () => {
  /**
   * MEASURED: `ACUVO_PROVIDER_ORDER=DeepSeek` 404s, and the message told the
   * reader to check `OPENROUTER_CODEGEN_MODEL` against the model catalogue. The
   * model was fine. Worse, that wording matches `isModelSpecific`, so `chain.mjs`
   * advanced through four model ids carrying the SAME bad pin — four times the
   * wait for the same answer, with every word pointing away from the cause.
   */
  const withPin = classifyHttpFailure(404, '{"error":{"message":"No endpoints found"}}', { pin: ['DeepSeek'] });
  assert.match(withPin, /ACUVO_PROVIDER_ORDER=DeepSeek/);
  assert.match(withPin, /data policy/i, 'the measured cause was an account exclusion, not a typo');

  // ⚠️ And an unpinned 404 is byte-identical to what it always was — a new
  // paragraph on every 404 would be noise on the common case.
  const without = classifyHttpFailure(404, '{"error":{"message":"No endpoints found"}}');
  assert.doesNotMatch(without, /ACUVO_PROVIDER_ORDER/);
  assert.equal(without, classifyHttpFailure(404, '{"error":{"message":"No endpoints found"}}', { pin: [] }));
});

// ── ⭐⭐ THE SESSION LEDGER: THE SCATTER IS THE FINDING ─────────────────────

test('⭐⭐ aggregateProviders counts EVERY upstream, because the scatter is the finding', () => {
  const agg = aggregateProviders([
    { provider: 'DeepInfra', providerPin: ['DeepInfra'] },
    { provider: 'Decart', providerPin: ['DeepInfra'] },
    { provider: 'DeepInfra', providerPin: ['DeepInfra'] },
    { provider: 'GMICloud', providerPin: ['DeepInfra'] },
  ]);
  // ⚠️ NOT collapsed to one name. A single value would report the last round and
  // hide the three cold caches before it — the same lie as averaging a partial
  // hit rate into a whole one.
  assert.deepEqual(agg.served, { DeepInfra: 2, Decart: 1, GMICloud: 1 });
  assert.deepEqual(agg.pin, ['DeepInfra']);
  assert.equal(agg.pinTook, 2);
  assert.equal(agg.pinMissed, 2);
  assert.equal(agg.roundsUnknown, 0);
});

test('⚠️ rounds that named no provider are counted apart, never scored as a miss', () => {
  const agg = aggregateProviders([
    { provider: 'DeepInfra', providerPin: ['DeepInfra'] },
    { provider: null, providerPin: ['DeepInfra'] },
    { usage: null },
  ]);
  assert.equal(agg.roundsUnknown, 2);
  assert.equal(agg.pinMissed, 0, 'silence is not evidence the pin failed');
  assert.equal(agg.pinTook, 1);
});

/**
 * ── ⭐⭐ THE REAL SHAPE OF A REAL SESSION, AND THE COUNTER THAT WAS MISSING ──
 *
 * The shipped pins name THREE providers, so `pinMissed` — nobody in the list
 * served the round — is nearly unreachable: one of the three almost always
 * answers. What actually happens, measured 2026-08-16 at ~5% of rounds (2 of
 * 40), is a fallback to the SECOND name, which is a live provider and a cold
 * cache: 0.0% cached at $0.000791 against 98.3% cached at $0.000172 for the
 * IDENTICAL payload. Before `pinFellBack` existed, this session reported
 * `pinTook: 3, pinMissed: 0` and looked perfect.
 */
test('⭐⭐ a fallback within the list is counted apart from a first-choice hit', () => {
  const pin = ['StreamLake', 'Baidu', 'GMICloud'];
  const agg = aggregateProviders([
    { provider: 'StreamLake', providerPin: pin },
    { provider: 'Baidu', providerPin: pin },
    { provider: 'StreamLake', providerPin: pin },
    { provider: 'Relace', providerPin: pin },
  ]);
  assert.equal(agg.pinTook, 2, 'only the FIRST name accumulates the cache');
  assert.equal(agg.pinFellBack, 1, 'the second name is available, billed, and cold');
  assert.equal(agg.pinMissed, 1, 'outside the list is still the loud failure');
  // ⚠️ Disjoint: every round that named a provider is in exactly one bucket.
  assert.equal(agg.pinTook + agg.pinFellBack + agg.pinMissed + agg.roundsUnknown, 4);
});

test('⚠️ nothing pinned and nothing reported produces null, not an empty ledger', () => {
  assert.equal(aggregateProviders([{ usage: {} }, { usage: {} }]), null);
  assert.equal(aggregateProviders([]), null);
  // But an unpinned run whose provider DID answer is a real reading.
  assert.deepEqual(aggregateProviders([{ provider: 'Relace' }]).served, { Relace: 1 });
  assert.equal(aggregateProviders([{ provider: 'Relace' }]).pin, null);
});

// ── ⭐ END TO END: A REAL SESSION, AND THE DOCUMENT IT LEAVES ───────────────

/** A scripted reply in the shape `callModel` returns, pin and all. */
const reply = (content, provider, providerPin = null, toolCalls = []) => ({
  ok: true, content, toolCalls, usage: { cost: 0.0005, total_tokens: 900 },
  finishReason: 'stop', model: 'fake/model', provider, providerPin,
});
const call = (name, args) => ({ id: `c${Math.random().toString(36).slice(2, 7)}`, function: { name, arguments: JSON.stringify(args) } });

async function drive(script) {
  const root = workspace();
  let i = 0;
  return runSession({
    task: 'read a.js and say what it exports',
    executor: createLocalExecutor(root),
    config: { apiKey: 'x', model: 'fake/model' },
    maxRounds: 5,
    allowRun: false,
    callModelImpl: async () => script[Math.min(i++, script.length - 1)],
    onEvent: () => {},
  });
}

test('⭐⭐ a real session records the routing, and --json carries it out of the process', async () => {
  const outcome = await drive([
    reply('reading', 'Decart', ['DeepInfra'], [call('read_file', { path: 'a.js' })]),
    reply('a exports a', 'DeepInfra', ['DeepInfra']),
  ]);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.providers.served, { Decart: 1, DeepInfra: 1 });
  assert.equal(outcome.providers.pinMissed, 1);
  assert.equal(outcome.providers.pinTook, 1);

  const doc = toJson(outcome);
  assert.ok(doc.providers, 'the routing must reach the JSON document, or the hit rate stays un-diagnosable');
  assert.deepEqual(doc.providers.served, { Decart: 1, DeepInfra: 1 });
  assert.deepEqual(doc.providers.pin, ['DeepInfra']);
  assert.equal(doc.providers.pinMissed, 1);
  // ⭐ And the direct cause of a collapsed hit rate ships with it.
  assert.equal(doc.compactions, 0, 'always a number: 0 is a fact about this run, not a default');
});

test('⚠️ an unpinned session still records WHO served it — that is the baseline', async () => {
  const outcome = await drive([reply('done', 'Relace')]);
  assert.deepEqual(outcome.providers.served, { Relace: 1 });
  assert.equal(outcome.providers.pin, null);
  assert.equal(toJson(outcome).providers.pin, null);
});

test('⚠️ a transport that says nothing about routing emits null, not a zeroed ledger', async () => {
  const outcome = await drive([reply('done', null)]);
  assert.equal(outcome.providers, null);
  assert.equal(toJson(outcome).providers, null, 'silence is unknown, never zero — the same rule `cache` follows');
});

test('⭐⭐ the summary SAYS the pin did not take, and names who served it instead', async () => {
  const outcome = await drive([
    reply('reading', 'Decart', ['DeepInfra'], [call('read_file', { path: 'a.js' })]),
    reply('done', 'Decart', ['DeepInfra']),
  ]);
  const text = formatSummary(outcome).join('\n');
  assert.match(text, /ACUVO_PROVIDER_ORDER=DeepInfra did not take/);
  assert.match(text, /Decart/, 'naming the upstream is what separates "check your spelling" from "check your data policy"');
});

/**
 * ⚠️⚠️ THIS WARNING WAS VERY NEARLY DEAD CODE. It fired only on `pinMissed`,
 * and with a three-name pin one of the three nearly always answers — so the
 * only routing failure it could ever report was the rare, loud one. The common
 * one (the first name skipped, a cold cache billed at 4.6×) printed nothing.
 */
test('⭐⭐ a fallback to the SECOND name is reported, and names the cache consequence', async () => {
  const pin = ['StreamLake', 'Baidu'];
  const outcome = await drive([
    reply('reading', 'StreamLake', pin, [call('read_file', { path: 'a.js' })]),
    reply('done', 'Baidu', pin),
  ]);
  assert.equal(outcome.providers.pinFellBack, 1);
  assert.equal(outcome.providers.pinMissed, 0, 'Baidu is IN the list — this was never a miss');
  const text = formatSummary(outcome).join('\n');
  assert.match(text, /StreamLake did not serve 1 round/);
  assert.match(text, /prompt cache lives on ONE upstream/,
    'the reader has to be told WHY an available provider cost them money');
  assert.match(text, /Baidu/, 'name who took it instead');
  // And it survives the trip into --json, which is what a script budgets against.
  assert.equal(toJson(outcome).providers.pinFellBack, 1);
});

test('⚠️ and it stays SILENT when the pin took, and when nothing was pinned', async () => {
  const took = await drive([reply('done', 'DeepInfra', ['DeepInfra'])]);
  assert.doesNotMatch(formatSummary(took).join('\n'), /did not take/);

  const none = await drive([reply('done', 'Relace')]);
  assert.doesNotMatch(formatSummary(none).join('\n'), /did not take/);

  // ⚠️ And silent when the provider never said who served it: warning on
  // silence would fire on every provider that does not report routing.
  const quiet = await drive([reply('done', null, ['DeepInfra'])]);
  assert.doesNotMatch(formatSummary(quiet).join('\n'), /did not take/);
});
