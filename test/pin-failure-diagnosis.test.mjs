/**
 * ── ⭐ A BAD PIN COST FOUR ROUND TRIPS AND BLAMED THE WRONG THING ────────────
 *
 * `ACUVO_PROVIDER_ORDER` visibility shipped, and an adversarial review then
 * found the diagnosis loop it was written to fix was still intact: only the
 * WORDING had changed. `provider: { order: ['NotAProvider'] }` narrows the
 * endpoint set to nothing, OpenRouter answers "No endpoints found for <model>",
 * `isModelSpecific` matched on that sentence, and the chain advanced through all
 * four candidates re-sending the identical bad pin — four round trips to learn
 * one fact about an environment variable, with the model id named in the
 * headline having never been the problem.
 *
 * ⚠️ THE ROOT CAUSE WAS NARROWER AND DULLER THAN THE SYMPTOM: `providerPin` was
 * returned on all three SUCCESS paths in `callModel` and on NONE of the failure
 * paths. The chain cannot reason about a cause it is never told about. Every
 * test here would have passed while that was true, except the ones that assert
 * the pin survives a failure — which is the whole point.
 *
 * The file also pins three assertions an adversarial pass found could be
 * deleted with the suite still green: `compactions` asserted only against the
 * constant `0`, and `pinTook` / `roundsUnknown` promised by name in the README
 * and never checked on the emitted document.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { isModelSpecific, callChain } from '../lib/chain.mjs';
import { callModel } from '../lib/model.mjs';
import { formatSummary } from '../lib/turn.mjs';
import { toJson } from '../lib/report.mjs';

const NO_ENDPOINTS = 'OpenRouter does not serve that model (HTTP 404). No endpoints found for deepseek/deepseek-v4-flash-0731.';

test('⭐ an endpoint failure UNDER A PIN is not a fact about the model', () => {
  // Unpinned, this is the OpenCode case the branch exists for: a genuinely dead
  // model id, where advancing to a different id is exactly right.
  assert.equal(isModelSpecific(NO_ENDPOINTS), true);
  // Pinned, the same sentence proves nothing — the pin is identical on every
  // candidate, so trying three more spends three more round trips to fail the
  // same way.
  assert.equal(isModelSpecific(NO_ENDPOINTS, { pinned: true }), false);
});

test('⚠️⚠️ callModel returns providerPin ON A FAILURE — the root cause, and the chain fixture cannot see it', async () => {
  /**
   * ⭐ THE TEST THAT ACTUALLY GUARDS THE FIX. Every chain test above hands
   * `callChain` a fake whose failure already carries `providerPin`, so all of
   * them stay green while the real `callModel` withholds it — which is the
   * defect as it actually shipped. This one drives the real function with an
   * injected transport and asserts the key survives an HTTP failure.
   */
  const res = await callModel({
    apiKey: 'k',
    model: 'deepseek/deepseek-v4-flash-0731',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    env: { ACUVO_PROVIDER_ORDER: 'NotAProvider' },
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: { message: 'No endpoints found for deepseek/deepseek-v4-flash-0731.' } }),
    }),
  });

  assert.equal(res.ok, false);
  assert.deepEqual(res.providerPin, ['NotAProvider'], 'the pin must survive the failure path, or the chain cannot diagnose it');
});

test('⭐ an unpinned failure reports no pin, so nothing is invented', async () => {
  const res = await callModel({
    apiKey: 'k',
    model: 'a/one',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    // ⚠️ EXPLICITLY UNPINNED. A bare {} used to mean 'no pin'; since the
    // default names a provider it no longer does, and this test is about the
    // UNPINNED path specifically.
    env: { ACUVO_PROVIDER_ORDER: '' },
    fetchImpl: async () => ({
      ok: false, status: 404, headers: { get: () => null },
      text: async () => '{"error":{"message":"No endpoints found."}}',
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.providerPin, null);
});

test('⚠️ a pin does NOT disclaim the unambiguous model failures', () => {
  // These cannot be produced by narrowing the provider set, so a pin must not
  // buy them a free pass — that would break failover for a retired model id.
  for (const message of [
    'HTTP 404: model not found',
    'that model does not exist',
    'unknown model id',
    'deprecated model — use the successor',
  ]) {
    assert.equal(isModelSpecific(message, { pinned: true }), true, message);
  }
  // And a bad key is still not model-specific, pinned or not.
  assert.equal(isModelSpecific('HTTP 401 invalid api key', { pinned: true }), false);
});

test('⚠️⚠️ the chain STOPS on a pin-caused 404 instead of spending every candidate', async () => {
  const tried = [];
  const res = await callChain({
    apiKey: 'k',
    model: 'deepseek/deepseek-v4-flash-0731',
    messages: [],
    // ⭐ THE FIXTURE IS THE FIX: the failure carries `providerPin`, which is
    // what `callModel` withheld. Drop that key and this test fails, which is
    // the assertion doing its job.
    callImpl: async ({ model }) => {
      tried.push(model);
      return { ok: false, error: NO_ENDPOINTS, providerPin: ['NotAProvider'] };
    },
    sleepImpl: async () => {},
  });

  assert.equal(res.ok, false);
  assert.equal(tried.length, 1, `expected to stop after one attempt, tried: ${tried.join(' → ')}`);
  assert.equal(res.stoppedEarly, true);
});

test('⭐ without the pin on the failure, the chain still fails over — the old behaviour is intact', async () => {
  const tried = [];
  await callChain({
    apiKey: 'k',
    model: 'a/one',
    messages: [],
    callImpl: async ({ model }) => {
      tried.push(model);
      return { ok: false, error: NO_ENDPOINTS };
    },
    sleepImpl: async () => {},
  });
  assert.ok(tried.length > 1, 'an unpinned dead model id must still advance through the chain');
});

test('⚠️ callChain FORWARDS env to the model call', async () => {
  // It is destructured so a library caller can configure a call without
  // touching process.env, and it reached only buildChain — so a caller's
  // provider pin was silently ignored while callModel read the ambient
  // environment instead.
  let seen = 'never called';
  await callChain({
    apiKey: 'k',
    model: 'a/one',
    messages: [],
    env: { ACUVO_PROVIDER_ORDER: 'DeepInfra' },
    callImpl: async ({ env }) => {
      seen = env?.ACUVO_PROVIDER_ORDER ?? 'absent';
      return { ok: true, text: 'hi', usage: {} };
    },
    sleepImpl: async () => {},
  });
  assert.equal(seen, 'DeepInfra');
});

test('⚠️ a FAILED run still reports that the pin did not take', () => {
  // The early return for a failed outcome sat ~330 lines above the warning, so
  // the surface the fix exists to populate went silent in exactly the case
  // where someone is already debugging.
  const lines = formatSummary({
    ok: false,
    error: 'every provider in the chain failed after 4 attempts.',
    providers: { pin: ['NotAProvider'], served: { DigitalOcean: 3 }, roundsUnknown: 0, pinTook: 0, pinMissed: 3 },
  });
  const text = lines.join('\n');
  assert.match(text, /ACUVO_PROVIDER_ORDER=NotAProvider/);
  assert.match(text, /did not take on 3 rounds/);
  assert.match(text, /DigitalOcean/);
});

test('⚠️ a failed run with NO pin says nothing about routing', () => {
  const text = formatSummary({ ok: false, error: 'boom' }).join('\n');
  assert.doesNotMatch(text, /ACUVO_PROVIDER_ORDER/);
});

const outcomeWith = (extra) => ({ ok: true, stage: 'done', usage: {}, executed: [], rounds: [], ...extra });

test('⚠️⚠️ compactions carries the REAL count, not a constant', () => {
  // Asserted only against 0 before, so replacing the expression with a literal
  // `0` left the whole suite green — a check that cannot fail, guarding the
  // exact defect it was written for.
  assert.equal(toJson(outcomeWith({ compactions: 3 })).compactions, 3);
  assert.equal(toJson(outcomeWith({ compactions: 0 })).compactions, 0);
});

test('⚠️ every field the README promises by name is on the document', () => {
  // README documents `providers: {pin, served, roundsUnknown, pinTook,
  // pinFellBack, pinMissed}`. Three of the six could be deleted with the suite
  // green. ⭐ `pinFellBack` joined the list on 2026-08-16: a round served by a
  // LATER name in the pin is a live provider on a cold cache, measured at 4.6×
  // the cost of the same bytes on the first name, and it used to be counted as
  // `pinTook` — a healthy reading for the one routing event that costs money.
  const doc = toJson(outcomeWith({
    providers: { pin: ['DeepInfra'], served: { DeepInfra: 2, Novita: 1 }, roundsUnknown: 1, pinTook: 2, pinFellBack: 0, pinMissed: 1 },
  }));
  assert.deepEqual(doc.providers, {
    pin: ['DeepInfra'],
    served: { DeepInfra: 2, Novita: 1 },
    roundsUnknown: 1,
    pinTook: 2,
    pinFellBack: 0,
    pinMissed: 1,
  });
});
