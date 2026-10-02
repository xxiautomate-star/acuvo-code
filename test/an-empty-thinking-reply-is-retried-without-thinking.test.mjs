/**
 * An empty reply from a model with reasoning ON is retried once on the SAME model with reasoning
 * off, before the chain falls to another model. Found by using it, 2026-09-26: 2 of 3 real runs
 * lost their first file-writing round to `deepseek-chat` after `deepseek-v4-flash-0731` returned
 * "the model returned an empty reply". See the note in `chain.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { callChain } from '../lib/chain.mjs';

const FLASH = 'deepseek/deepseek-v4-flash-0731';
const EMPTY = { ok: false, error: 'the model returned an empty reply', usage: { prompt_tokens: 12000, completion_tokens: 6000 } };
const WROTE = { ok: true, content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }], usage: null };

function recorder(answer) {
  const calls = [];
  const impl = async (args) => { calls.push({ model: args.model, reasoning: args.env?.ACUVO_REASONING ?? null, messages: args.messages }); return answer(calls.length, args); };
  return { calls, impl };
}

const base = { apiKey: 'k', messages: [{ role: 'user', content: 'build it' }], tools: [], timeoutMs: 1000, maxTokens: 8000, sleepImpl: async () => {}, env: {} };

test('the same model answers once reasoning is off — no fallback, same messages', async () => {
  const r = recorder((n, a) => (a.env?.ACUVO_REASONING === 'off' ? WROTE : EMPTY));
  const out = await callChain({ ...base, model: FLASH, callImpl: r.impl });
  assert.equal(out.ok, true);
  assert.equal(out.usedFallback, false);
  assert.deepEqual(r.calls.map((c) => [c.model, c.reasoning]), [[FLASH, null], [FLASH, 'off']]);
  assert.equal(r.calls[0].messages, r.calls[1].messages, 'the prefix moved');
  assert.equal(out.billedFailures.length, 1, 'the empty attempt was billed and must be recorded');
});

test('it is tried once: a second empty reply falls to the rest of the chain', async () => {
  const r = recorder((n, a) => (a.model === FLASH ? EMPTY : WROTE));
  const out = await callChain({ ...base, model: FLASH, callImpl: r.impl });
  assert.equal(out.ok, true);
  assert.equal(out.usedFallback, true);
  assert.equal(r.calls.filter((c) => c.model === FLASH).length, 2);
  assert.match(out.fellBackFrom[0].error, /retried once with reasoning off/);
});

test('a model without reasoning on goes straight to the next candidate, as before', async () => {
  const r = recorder((n, a) => (a.model === 'deepseek/deepseek-chat' ? EMPTY : WROTE));
  await callChain({ ...base, model: 'deepseek/deepseek-chat', callImpl: r.impl });
  assert.equal(r.calls.filter((c) => c.model === 'deepseek/deepseek-chat').length, 1);
});

test('a 429 does not retry the same model — only an empty reply or a timeout does', async () => {
  const r = recorder((n, a) => (a.model === FLASH ? { ok: false, error: 'HTTP 429 rate limited', status: 429 } : WROTE));
  await callChain({ ...base, model: FLASH, callImpl: r.impl });
  assert.equal(r.calls.filter((c) => c.model === FLASH && c.reasoning === 'off').length, 0);
});

test('a TIMEOUT from a thinking model gets the same one retry without thinking', async () => {
  const TIMEOUT = { ok: false, error: 'No response from OpenRouter within 180s — the call was aborted rather than left hanging.', kind: 'timeout' };
  const r = recorder((n, a) => (a.env?.ACUVO_REASONING === 'off' ? WROTE : TIMEOUT));
  const out = await callChain({ ...base, model: FLASH, callImpl: r.impl });
  assert.equal(out.ok, true);
  assert.equal(out.usedFallback, false);
  assert.deepEqual(r.calls.map((c) => [c.model, c.reasoning]), [[FLASH, null], [FLASH, 'off']]);
});
