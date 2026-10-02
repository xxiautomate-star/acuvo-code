/**
 * ── ⭐⭐⭐ THE METER MUST BE CONSTRUCTED, NOT MERELY ACCEPTED ────────────────
 *
 * `runHarness({ budget })` is OPTIONAL. That is deliberate — the function is
 * unit-testable without a governor — and it is also the exact hole this package
 * has fallen into before:
 *
 *     `unitAllowance` was read in one place and **set from nowhere**. The whole
 *     unit meter was unreachable. Forty green tests missed it; a real $0.0012
 *     run found it.
 *
 * An optional dependency that the only real call site forgets to pass produces a
 * feature that prints "metered", starts the proxy, reads every usage block, and
 * charges NOTHING against any ceiling. It looks supervised and is not. So this
 * file asserts the wiring at the one place it can rot: the dispatch in
 * `bin/acuvo.mjs`.
 *
 * ⚠️ SOURCE-LEVEL, AND THAT IS THE HONEST LIMIT OF IT. Spawning the real CLI
 * would need `codex` installed, which is a user's own install and cannot be a
 * test dependency — so `test/harness.test.mjs` §7 proves the governor MOVES on
 * a metered round, and this proves the CLI hands it over. Neither alone is
 * enough; that is why both exist.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/acuvo.mjs', import.meta.url));

async function dispatchSource() {
  const src = await readFile(BIN, 'utf8');
  const at = src.indexOf('runHarness({');
  assert.notEqual(at, -1, 'bin/acuvo.mjs must call runHarness — otherwise --harness is unreachable');
  // The call expression, generously bounded.
  return src.slice(at, at + 900);
}

test('⭐⭐⭐ the CLI passes a budget to runHarness — the meter is constructed', async () => {
  const call = await dispatchSource();
  assert.match(
    call, /\bbudget:/,
    'runHarness was called WITHOUT `budget:` — every harness round would be unmetered while the run still printed "metered". This is the `unitAllowance` defect exactly.',
  );
});

test('⭐⭐ the budget it passes is a real createBudget governor', async () => {
  const src = await readFile(BIN, 'utf8');
  assert.match(src, /const harnessBudget = createBudget\(\{/, 'the harness ceiling must be a real governor, not an object literal that merely has a record()');
  const block = src.slice(src.indexOf('const harnessBudget = createBudget({'), src.indexOf('const harnessBudget = createBudget({') + 400);
  // ⚠️ It must inherit the user's own --budget, not invent a private ceiling.
  assert.match(block, /limitUsd: opts\.budgetUsd/, '--budget must govern a harness run exactly as it governs our own');
  assert.match(block, /limitIsDefault/, 'the refusal wording depends on whether a human chose the number');
});

test('⚠️ the harness dispatch sits ABOVE the key check, so it needs no OPENROUTER_API_KEY', async () => {
  const src = await readFile(BIN, 'utf8');
  const harnessAt = src.indexOf('if (life.harness !== null)');
  const keyCheckAt = src.indexOf('THE KEY IS CHECKED BEFORE THE WORKSPACE IS TOUCHED');
  assert.ok(harnessAt > 0 && keyCheckAt > 0, 'both landmarks must exist');
  assert.ok(
    harnessAt < keyCheckAt,
    'an unmetered harness run spends none of our money, so demanding our key would refuse a legitimate command',
  );
});

test('⚠️ a refusal exits 64 and a failed run exits 1 — a script must tell them apart', async () => {
  const call = await dispatchSource();
  assert.match(call, /EXIT_USAGE/, "a refusal ('you have not installed it') must be a usage error");
  assert.match(call, /EXIT_OK : EXIT_FAILED|EXIT_FAILED/, 'a harness that ran and failed must not look like a typo');
});
