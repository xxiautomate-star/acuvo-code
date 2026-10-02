/**
 * ── ⚠️ A CHAIN RECOVERY ON THE SAME MODEL IS SAID OUT LOUD (2026-09-26) ──────
 *
 * Found by using it: a README run was charged for 13 budget records over 12
 * rounds and the screen said nothing — the `model-switch` line speaks once per
 * NEW model, so a same-model retry (reasoning off after an empty/timed-out
 * thinking reply) or a fallback to an already-announced model was silent, and a
 * round that burned a 180 s timeout looked like the model thinking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession, renderEvent } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const MODEL = 'deepseek/deepseek-v4-flash-0731';
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-silent-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a same-model recovery emits one dim model-retry line naming the cause', async (t) => {
  const events = [];
  await runSession({
    task: 'do the work',
    executor: createLocalExecutor(workspace(t)),
    config: { apiKey: 'k', model: MODEL },
    maxRounds: 2,
    budgetUsd: null,
    onEvent: (e) => events.push(e),
    callModelImpl: async () => ({
      ok: true, content: 'done', toolCalls: [], finishReason: 'stop', model: MODEL, usage: null,
      fellBackFrom: [{ model: MODEL, error: 'No response from OpenRouter within 180s — the call was aborted rather than left hanging. (retried once with reasoning off)' }],
    }),
  });
  const retries = events.filter((e) => e.type === 'model-retry');
  assert.equal(retries.length, 1);
  assert.equal(events.filter((e) => e.type === 'model-switch').length, 0, 'the same model answered — not a switch');
  const line = strip(renderEvent(retries[0]).join('\n'));
  assert.match(line, /failed first: No response from OpenRouter within 180s/);
  assert.match(line, /answered by deepseek\/deepseek-v4-flash-0731/);
});

test('a clean round emits nothing new', async (t) => {
  const events = [];
  await runSession({
    task: 'do the work',
    executor: createLocalExecutor(workspace(t)),
    config: { apiKey: 'k', model: MODEL },
    maxRounds: 2,
    budgetUsd: null,
    onEvent: (e) => events.push(e),
    callModelImpl: async () => ({ ok: true, content: 'done', toolCalls: [], finishReason: 'stop', model: MODEL, usage: null, fellBackFrom: [] }),
  });
  assert.equal(events.filter((e) => e.type === 'model-retry').length, 0);
});
