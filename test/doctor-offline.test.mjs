/**
 * ── ⚠️⚠️ `--doctor` PROMISED "NO API KEY AND NO NETWORK" AND SENT BOTH ───────
 *
 * `--help` and `README.md` both said it. `lib/doctor.mjs:1239-1240` sends
 * `Authorization: Bearer <the user's key>` to openrouter.ai/api/v1/key and
 * /credits, and every configured Modal endpoint gets pinged.
 *
 * ⭐ WHY THIS WAS THE WORST DOC BUG IN THE PACKAGE, not merely one of them:
 * `--doctor` is the command a security-conscious evaluator runs FIRST — and
 * they run it first BECAUSE they were told it was offline. They then find their
 * key in a corporate proxy log. The false claim and the audience it hurts are
 * perfectly aligned to end the evaluation on first contact.
 *
 * ⚠️ THE FIX IS NOT TO DELETE THE PROBES. "present, but it does NOT
 * authenticate" is the most valuable line the doctor prints and no offline
 * check can produce it. So the docs now say what it does, and `--offline`
 * delivers what they used to promise.
 *
 * ⭐ THE ONLY HONEST TEST OF "SENDS NOTHING" IS A FETCH THAT THROWS IF CALLED.
 * Asserting on the report's text would pass just as happily while a request
 * went out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDoctor } from '../lib/doctor.mjs';

/** An environment with everything configured, so there is plenty to probe. */
const LOUD_ENV = {
  OPENROUTER_API_KEY: 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd',
  RENDER_AUDIT_URL: 'https://example-render.modal.run',
  MODAL_PRESS_URL: 'https://example-press.modal.run',
  IMAGE_GEN_URL: 'https://example-image.modal.run',
  MODAL_VIDEO_SECRET: 'shhh',
};

test('⭐⭐ --offline sends NOTHING — proven by a fetch that throws if it is called', async () => {
  const calls = [];
  const explodingFetch = (url) => {
    calls.push(String(url));
    throw new Error(`--offline made a network request to ${url}`);
  };

  const report = await runDoctor({
    env: LOUD_ENV,
    fetchImpl: explodingFetch,
    skipNetwork: true,
    gitStatusImpl: () => ({ ok: false, error: 'not a repo' }),
    mcpConfigImpl: () => ({ ok: true, file: null, servers: [] }),
  });

  assert.deepEqual(calls, [], 'not one request may leave the machine under --offline');
  assert.ok(report, 'and it still produces a report — offline is not "broken"');
});

test('⚠️ without --offline it DOES probe — the honest default, asserted so the docs cannot drift again', async () => {
  /**
   * This test exists to make the README's warning load-bearing. If someone
   * later makes probing opt-in, this fails and they must update the docs in the
   * same commit — which is the whole mechanism that was missing before.
   */
  const calls = [];
  const countingFetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{}' };
  };

  await runDoctor({
    env: LOUD_ENV,
    fetchImpl: countingFetch,
    gitStatusImpl: () => ({ ok: false, error: 'not a repo' }),
    mcpConfigImpl: () => ({ ok: true, file: null, servers: [] }),
  });

  assert.ok(calls.length > 0, 'the default verifies over the network — say so in the docs');
  assert.ok(
    calls.some((u) => u.includes('openrouter.ai')),
    'and it is openrouter.ai the key is sent to, which is the part users must be told',
  );
});

test('offline defaults to false — an omitted option must not silently disable verification', async () => {
  const calls = [];
  const countingFetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{}' };
  };

  await runDoctor({
    env: LOUD_ENV,
    fetchImpl: countingFetch,
    skipNetwork: undefined,
    gitStatusImpl: () => ({ ok: false, error: 'not a repo' }),
    mcpConfigImpl: () => ({ ok: true, file: null, servers: [] }),
  });
  assert.ok(calls.length > 0, 'undefined is not offline');

  // ⚠️ Only the literal true disables it — a truthy string must not arm a mode
  // whose entire promise is "nothing left the machine".
  const strictly = [];
  await runDoctor({
    env: LOUD_ENV,
    fetchImpl: async (u) => { strictly.push(String(u)); return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{}' }; },
    skipNetwork: 'yes',
    gitStatusImpl: () => ({ ok: false, error: 'not a repo' }),
    mcpConfigImpl: () => ({ ok: true, file: null, servers: [] }),
  });
  assert.ok(strictly.length > 0, 'only === true turns probing off');
});
