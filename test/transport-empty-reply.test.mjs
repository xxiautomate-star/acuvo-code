/**
 * ── ⚠️⚠️ A BILLED, EMPTY 200 IS REPORTED AS A SUCCESSFUL RUN ────────────────
 *
 * `extractReply` returns `{ ok: true, content: null, toolCalls: [] }` when a
 * provider answers 200 with a message that has no content and no tool calls.
 * That is a DEGENERATE 200: the call was made, the tokens were billed, and
 * there is nothing to act on. Reported as `ok: true`, it travels all the way
 * out as a finished session — exit 0, zero files changed, no error, and no
 * fallback ever attempted.
 *
 * ⭐ AND THE GUARD THAT WAS SUPPOSED TO CATCH IT IS DEAD CODE. `chain.mjs`
 * carries this, calling itself "the single most important line here":
 *
 *     if (/empty reply|no content|returned nothing/i.test(e)) return true;
 *
 * It matches on an ERROR STRING. `extractReply` never emits one for this case,
 * because it returns `ok: true` — so the most important line in the retry
 * classifier can never fire, and the chain has three healthy fallback models it
 * will never try.
 *
 * ⚠️ THE SHAPE TO GET RIGHT. `content: null` WITH tool calls is completely
 * normal — it is what every tool-calling turn looks like. Only the case where
 * there is neither content nor a tool call is degenerate. A guard that refuses
 * the normal shape would break every tool call in the product, which is exactly
 * the "check that fails correct work" this repo keeps paying for.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { extractReply } from '../lib/model.mjs';
import { isRetryable } from '../lib/chain.mjs';

const body = (message, extra = {}) => ({ choices: [{ message, finish_reason: 'stop' }], ...extra });

test('⚠️⚠️ a 200 with no content and no tool calls is a FAILURE, not a finished run', () => {
  const r = extractReply(body({ role: 'assistant', content: null }));
  assert.equal(
    r.ok,
    false,
    'a billed reply with nothing in it was reported as a successful turn — the session exits 0 having done nothing',
  );
});

test('an empty-string reply with no tool calls is the same failure', () => {
  for (const content of ['', '   ', '\n\n']) {
    const r = extractReply(body({ role: 'assistant', content }));
    assert.equal(r.ok, false, `content=${JSON.stringify(content)} with no tool calls must not be a success`);
  }
});

test('a message that is missing entirely is still a failure', () => {
  assert.equal(extractReply(body(undefined)).ok, false);
  assert.equal(extractReply({ choices: [] }).ok, false);
  assert.equal(extractReply({}).ok, false);
});

/**
 * ⭐ THE LINE THAT MAKES THE FIX WORTH ANYTHING. Returning ok:false is only half
 * of it — the error text has to be classified as RETRYABLE, or the chain still
 * refuses to fail over to the three healthy models behind it.
 */
test('⭐ the empty-reply error is classified retryable, so the chain actually fails over', () => {
  const r = extractReply(body({ role: 'assistant', content: null }));
  assert.equal(r.ok, false);
  assert.equal(
    isRetryable(r.error),
    true,
    `chain.mjs calls its empty-reply pattern "the single most important line here", but it does not match `
    + `the string extractReply actually produces: ${JSON.stringify(r.error)}`,
  );
});

/**
 * ⚠️⚠️ THE REGRESSION HALF, AND IT IS THE LOAD-BEARING ONE. `content: null` with
 * tool calls is what EVERY tool-calling turn looks like. If the guard above
 * catches this shape, every tool call in the product breaks.
 */
test('a tool call with null content is the NORMAL shape and must still succeed', () => {
  const r = extractReply(body({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }],
  }));
  assert.equal(r.ok, true, 'a normal tool-calling reply was refused — this would break every tool call in the CLI');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.content, null);
});

test('an empty-string content WITH tool calls also still succeeds', () => {
  const r = extractReply(body({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }],
  }));
  assert.equal(r.ok, true, 'providers commonly send "" rather than null alongside tool calls');
  assert.equal(r.toolCalls.length, 1);
});

test('an ordinary prose answer with no tool calls still succeeds', () => {
  const r = extractReply(body({ role: 'assistant', content: 'The bug is in src/parse.mjs line 12.' }));
  assert.equal(r.ok, true, 'a final prose answer is a legitimate end to a turn');
  assert.equal(r.content, 'The bug is in src/parse.mjs line 12.');
});

test('usage and finishReason survive on the success path', () => {
  const r = extractReply(body(
    { role: 'assistant', content: 'done' },
    { usage: { cost: 0.0004, total_tokens: 812 } },
  ));
  assert.equal(r.ok, true);
  assert.equal(r.usage.cost, 0.0004);
  assert.equal(r.finishReason, 'stop');
});
