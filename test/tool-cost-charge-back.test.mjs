/**
 * ── ⚠️⚠️ TWO TOOLS THAT SPENT MONEY THE GOVERNOR COULD NOT SEE ─────────────
 *
 * `--budget` is the differentiator this package actually claims: *tell me the
 * price before it runs, and stop at the number you gave me.* A ceiling that
 * governs some of the spending is not a ceiling — it is a number on screen that
 * looks like control, which `delegate-budget.test.mjs` calls "the most
 * misleading of the three possible states".
 *
 * Two leaks, both in `tools.mjs`, both measured before the fix:
 *
 *   1. `delegate` was charged $0 on any provider that reports tokens but no
 *      `cost`. The guard was `result.costUsd > 0`, and `subagent.mjs:213`
 *      floors an unreported cost to exactly 0 — so the branch never ran and the
 *      TOKENS were discarded with it, even though `budget.record`
 *      (`budget.mjs:396-404`) exists to price precisely that case.
 *   2. `read_image` returns `costUsd` (`vision.mjs:261`) and nothing read it.
 *      Its only bound was a COUNT — `MAX_LOOKS_PER_PROCESS = 12`. A count is
 *      not a ceiling, and vision calls are the expensive per-token kind.
 *
 * ⭐ $0.00 to run: every model call here is a stub.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { executeToolCall } from '../lib/tools.mjs';
import { createBudget } from '../lib/budget.mjs';
import { createMemoryExecutor } from '../lib/memory-workspace.mjs';

const call = (name, args) => ({ id: '1', function: { name, arguments: JSON.stringify(args) } });

async function delegateWith(result, budget) {
  await executeToolCall(call('delegate', { task: 'read the module and summarise' }), createMemoryExecutor({}), {
    config: { apiKey: 'k' }, budget, subagentImpl: async () => result,
  });
  return budget;
}

// ── 1. delegate ────────────────────────────────────────────────────────────

test('⚠️⚠️ a helper that reports TOKENS but no cost is priced, not made free', async () => {
  /**
   * ⚠️ THE EXACT SHAPE A PROVIDER WITHOUT COST REPORTING PRODUCES.
   * `subagent.mjs:213` turns a missing `usage.cost` into `costUsd: 0`, so this
   * is not a contrived object — it is what `delegate` hands back on, for
   * example, a self-hosted endpoint.
   */
  const budget = await delegateWith(
    { ok: true, summary: 'done', costUsd: 0, tokens: 60_000, roundsUsed: 6, files: [] },
    createBudget({ limitUsd: 1 }),
  );
  const after = budget.canContinue();
  assert.ok(after.spentUsd > 0, 'a helper that burned 60,000 tokens cost more than nothing');
  assert.equal(after.estimated, true, 'and the total says out loud that it is an estimate');

  // ⭐ Priced by budget.mjs from the tokens, not by a number invented here.
  const [round] = budget.history();
  assert.equal(round.source, 'tokens', 'the fallback that already existed is the one doing the pricing');
  assert.equal(round.tokens, 60_000, 'and the tokens were not thrown away either');
});

test('a helper that reports a real cost is still charged exactly that', async () => {
  // ⚠️ THE REGRESSION GUARD. The fix must not double-charge or re-estimate the
  // case that already worked.
  const budget = await delegateWith(
    { ok: true, summary: 'done', costUsd: 0.30, tokens: 1_000, roundsUsed: 1, files: [] },
    createBudget({ limitUsd: 1 }),
  );
  assert.ok(Math.abs(budget.canContinue().spentUsd - 0.30) < 1e-9);
  assert.equal(budget.history()[0].source, 'reported');
});

test('a helper that ran rounds and reported NOTHING is charged the projection', async () => {
  /**
   * ⚠️ "Nothing to go on" is not "free" — `budget.mjs:400` already says so, and
   * charging the projection is "the one option that is neither free nor
   * invented". This branch was unreachable from `delegate` before.
   */
  const budget = createBudget({ limitUsd: 1 });
  budget.record({ costUsd: 0.05, tokens: 1_000 });
  await delegateWith({ ok: false, error: 'the helper crashed', costUsd: 0, tokens: 0, roundsUsed: 3, files: [] }, budget);
  const rounds = budget.history();
  assert.equal(rounds.length, 2, 'three wasted rounds must appear in the ledger');
  assert.equal(rounds[1].source, 'projected');
  assert.ok(rounds[1].costUsd > 0);
});

test('⚠️ but a helper that never ran a round is charged nothing — inventing money is the opposite failure', async () => {
  const budget = createBudget({ limitUsd: 1 });
  budget.record({ costUsd: 0.05, tokens: 1_000 });
  await delegateWith({ ok: false, error: 'no model credentials', costUsd: 0, tokens: 0, roundsUsed: 0, files: [] }, budget);
  assert.equal(budget.history().length, 1, 'a refusal before the first model call costs nothing');
});

// ── 2. read_image ──────────────────────────────────────────────────────────

/**
 * ⚠️ `readImage` IS REACHED THROUGH THE DISPATCHER, so the stub has to be the
 * real module's export. `visionImpl` does not exist as an injection point, so
 * the look is driven by a fake `fetchImpl` all the way through vision.mjs —
 * which also proves the cost the dispatcher charges is the cost the VISION
 * MODULE actually reported, not one this test made up.
 */
import { readImage } from '../lib/vision.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

/** A 1x1 PNG, so the format sniffer and the size reader both succeed. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function imageWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-vision-'));
  made.push(root);
  writeFileSync(join(root, 'shot.png'), PNG);
  return root;
}

test('⭐ a look that really happened is charged to the same ceiling the model rounds use', async () => {
  const root = imageWorkspace();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'a white pixel' } }],
      usage: { cost: 0.0042, total_tokens: 900 },
      model: 'fake/eyes',
    }),
  });

  // ⚠️ Straight through the real module first, to establish what it reports.
  const direct = await readImage({ root, path: 'shot.png', apiKey: 'k', fetchImpl });
  assert.equal(direct.ok, true, direct.error);
  assert.equal(direct.costUsd, 0.0042, 'vision.mjs has always reported this — nothing read it');
});

/**
 * ⚠️ NO `if (ok) … else …` IN THE ASSERTIONS BELOW, AND THAT IS DELIBERATE. The
 * first draft of this test had one, so it passed whether or not the wiring
 * existed — a check that cannot fail, which this repo has already shipped four
 * times. `readImage` falls back to `process.env.OPENROUTER_API_KEY` and to the
 * global `fetch` (`vision.mjs:147-149`), so the real dispatcher path can be
 * driven end to end, deterministically, for $0.
 */
async function throughDispatcher(root, budget, { reply }) {
  const executor = { root, dryRun: false, readFile: () => ({ ok: false, error: 'no such file' }) };
  const realFetch = globalThis.fetch;
  const realKey = process.env.OPENROUTER_API_KEY;
  globalThis.fetch = async () => reply;
  process.env.OPENROUTER_API_KEY = 'k';
  try {
    return await executeToolCall(
      call('read_image', { path: 'shot.png', question: 'what is it?' }),
      executor,
      { config: { apiKey: 'k' }, budget },
    );
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = realKey;
  }
}

const OK_REPLY = {
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content: 'a white pixel' } }],
    usage: { cost: 0.0042, total_tokens: 900 },
    model: 'fake/eyes',
  }),
};

test('⭐ a look that really happened reaches the ledger, through the dispatcher', async () => {
  const budget = createBudget({ limitUsd: 1 });
  const out = await throughDispatcher(imageWorkspace(), budget, { reply: OK_REPLY });
  assert.equal(out.result.ok, true, `the look should have succeeded: ${out.result.error}`);
  assert.ok(
    Math.abs(budget.canContinue().spentUsd - 0.0042) < 1e-9,
    `the vision call cost $0.0042 and the governor recorded ${budget.canContinue().spentUsd} — a count is not a ceiling`,
  );
  /**
   * ⚠️ THE HONEST LIMIT, PINNED SO NOBODY "FIXES" IT WITH THE WRONG NUMBER.
   * `vision.mjs:253-262` returns `costUsd` and `approxImageTokens` but never
   * `usage.total_tokens`. `approxImageTokens` is an estimate of the IMAGE, not
   * of the round, so recording it would corrupt the token total with a different
   * quantity under the same name. Dollars are exact; the token counter
   * under-reports a look until vision.mjs surfaces its usage.
   */
  assert.equal(budget.history()[0].tokens, 0, 'no token count is claimed, because vision.mjs does not report one');
  assert.equal(budget.history()[0].source, 'reported', 'and the dollar is measured, not estimated');
});

test('⚠️ a look that was REFUSED is charged nothing — a ledger that overcharges is fiction too', async () => {
  const budget = createBudget({ limitUsd: 1 });
  const out = await throughDispatcher(imageWorkspace(), budget, {
    reply: { ok: false, status: 402, text: async () => 'payment required', json: async () => ({}) },
  });
  assert.equal(out.result.ok, false, 'a 402 must abstain rather than describe the image');
  assert.equal(budget.canContinue().spentUsd, 0);
});
