/**
 * ── 💰⚠️ THE HEADLINE COST INCLUDES THE ATTEMPTS THE CHAIN THREW AWAY (2026-09-26)
 *
 * Found by using it: a real run printed `12 rounds · … · $0.011895` and, one line
 * below, `budget: $0.0161 of $0.1500 spent · 13 rounds`. The budget and the meter
 * were charged for a discarded billed attempt (billed-failures-are-metered D1);
 * `outcome.usage` — the headline, `--json`, the audit record's `costUsd` — was
 * summed from the winning rounds only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession, formatSummary } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

const usage = (prompt, cost) => ({
  cost, total_tokens: prompt + 40, prompt_tokens: prompt, completion_tokens: 40,
  prompt_tokens_details: { cached_tokens: Math.floor(prompt * 0.9) },
});

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-headline-cost-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('outcome.usage and the summary line count the discarded billed attempt', async (t) => {
  const outcome = await runSession({
    task: 'do the work',
    executor: createLocalExecutor(workspace(t)),
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    maxRounds: 2,
    budgetUsd: null,
    // Round 1 looks at the directory (so the summary is not a quiet greeting) and
    // its chain threw one billed attempt away; round 2 finishes.
    callModelImpl: (() => { let n = 0; return async () => (++n === 1
      ? { ok: true, content: 'looking', finishReason: 'tool_calls', usage: usage(9000, 0.001), billedFailures: [usage(12000, 0.004)],
          toolCalls: [{ id: 'l1', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }] }
      : { ok: true, content: 'done', toolCalls: [], finishReason: 'stop', usage: usage(9000, 0.001) }); })(),
  });
  assert.equal(outcome.ok, true);
  assert.ok(Math.abs(outcome.usage.cost - 0.006) < 1e-12, `cost ${outcome.usage.cost}`);
  assert.equal(outcome.usage.total_tokens, 9040 + 9040 + 12040);
  assert.deepEqual(outcome.usage.discarded, { attempts: 1, cost: 0.004 });
  const text = formatSummary(outcome).join('\n');
  assert.match(text, /\$0\.006000 \(incl\. \$0\.004000 for 1 discarded attempt\)/);
});

test('a run with no discarded attempts reads exactly as before', async (t) => {
  const outcome = await runSession({
    task: 'do the work',
    executor: createLocalExecutor(workspace(t)),
    config: { apiKey: 'k', model: 'deepseek/deepseek-chat' },
    maxRounds: 2,
    budgetUsd: null,
    callModelImpl: async () => ({ ok: true, content: 'done', toolCalls: [], finishReason: 'stop', usage: usage(9000, 0.001) }),
  });
  assert.equal(outcome.usage.discarded, undefined);
  assert.doesNotMatch(formatSummary(outcome).join('\n'), /discarded/);
});
