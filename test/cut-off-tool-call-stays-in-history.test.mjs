/**
 * A tool call cut off by the reply limit must not poison the transcript. Found
 * by using it: a deck run's write_file was truncated, the executor refused it,
 * and the NEXT request died with HTTP 400 — "Assistant tool call
 * function.arguments must be valid JSON" — because the broken arguments were
 * echoed back into history. See `historySafeCall` in lib/turn.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSession, historySafeCall } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const CUT = '{"path":"deck.mjs","content":"const slides = [\\n  { title: \\"One';

test('the history copy of a cut-off call carries valid JSON; a good call is untouched', () => {
  const bad = { id: 'c1', type: 'function', function: { name: 'write_file', arguments: CUT } };
  assert.deepEqual(historySafeCall(bad).function.arguments, '{}');
  assert.equal(bad.function.arguments, CUT, 'the original is not mutated');
  const good = { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } };
  assert.equal(historySafeCall(good), good);
});

test('after a cut-off call, every later request carries only parseable tool arguments', async () => {
  const executor = createLocalExecutor(mkdtempSync(join(tmpdir(), 'acuvo-cutoff-')));
  const seen = [];
  let n = 0;
  await runSession({
    task: 'write deck.mjs',
    executor,
    config: { apiKey: 'k', model: 'm' },
    maxRounds: 3,
    onEvent: () => {},
    callModelImpl: async ({ messages }) => {
      seen.push(messages);
      n += 1;
      if (n === 1) {
        return { ok: true, content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: CUT } }], usage: {}, finishReason: 'tool_calls' };
      }
      return { ok: true, content: 'done', toolCalls: [], usage: {}, finishReason: 'stop' };
    },
  });
  assert.ok(seen.length >= 2, 'a second request was made');
  for (const msgs of seen.slice(1)) {
    for (const m of msgs) {
      for (const c of m.tool_calls ?? []) assert.doesNotThrow(() => JSON.parse(c.function.arguments), `unparseable: ${c.function.arguments.slice(0, 40)}`);
    }
  }
  const toolMsg = seen[1].find((m) => m.role === 'tool');
  assert.match(String(toolMsg?.content), /not valid JSON/, 'the model still reads why the call failed');
});
