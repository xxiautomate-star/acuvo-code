/**
 * ── ⭐⭐⭐ `--harness` MUST COST THE MODEL NOTHING ────────────────────────────
 *
 * The per-round fixed payload — the system prompt plus the WHOLE tool array —
 * is re-sent every single round, on every task, including "hi". It is pinned at
 * `< 1.3×` the one-shot prompt and it is nearly full. That ceiling is why this
 * feature is a FLAG and not a verb.
 *
 * ⚠️⚠️ AND "IT'S ONLY A FLAG" IS EXACTLY THE CLAIM THAT ROTS. The cheap way to
 * add a harness would be a `run_harness` tool schema, and a future round of
 * work will be tempted by it. This file makes that temptation fail loudly
 * instead of quietly costing ~700 bytes × every round × every user, forever.
 *
 * ⭐ ZERO IS ASSERTED BY CONSTRUCTION, NOT BY A REMEMBERED NUMBER. A hard-coded
 * byte total would go stale the first time an unrelated verb changed, and a
 * stale guard gets deleted rather than fixed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_SCHEMAS, TOOL_NAMES } from '../lib/tools.mjs';
import { systemPrompt } from '../lib/turn.mjs';
import { CORE_TOOLS } from '../lib/tool-shortlist.mjs';
import { HARNESS_IDS } from '../lib/harness.mjs';

test('⭐⭐⭐ the harness adds NO verb to the tool array', () => {
  for (const name of TOOL_NAMES) {
    assert.ok(
      !/harness/i.test(name),
      `${name} is a harness verb in the tool array — it would be re-sent every round of every task. Keep it a flag.`,
    );
  }
});

test('⭐⭐ the harness contributes ZERO bytes to the per-round tool payload', () => {
  const serialised = JSON.stringify(TOOL_SCHEMAS);
  const matches = serialised.match(/harness/gi) ?? [];
  assert.equal(
    matches.length, 0,
    `the word "harness" appears ${matches.length}× in the tool array; the byte delta of this feature against the model payload must be exactly 0`,
  );
  // And no harness id leaked into a description either.
  for (const id of HARNESS_IDS) {
    assert.ok(!new RegExp(`\\b${id}\\b`, 'i').test(serialised), `"${id}" reached the tool array`);
  }
});

test('⭐⭐ the harness contributes ZERO bytes to the system prompt', () => {
  /**
   * ⚠️ THE WIDEST PROMPT THE PRODUCT CAN BUILD, not the default one. A narrow
   * call would miss text that only appears with `--shell` or `--until-done`,
   * which is where an incautious addition would most plausibly land.
   */
  const widest = systemPrompt({
    maxRounds: 12, allowRun: true, untilDone: true, shell: true, offeredNames: [...TOOL_NAMES],
  });
  assert.ok(!/harness/i.test(widest), 'the system prompt names the harness — that is bytes on every round');
  for (const id of HARNESS_IDS) {
    assert.ok(!new RegExp(`\\b${id}\\b`, 'i').test(widest), `"${id}" reached the system prompt`);
  }
});

test('⚠️ the harness is not smuggled in as a CORE tool', () => {
  for (const name of CORE_TOOLS) assert.ok(!/harness/i.test(name));
});

test('⭐ the flag IS documented in --help, so the capability is reachable', async () => {
  /**
   * ⚠️ THE OTHER HALF OF THE BARGAIN. Costing the model nothing is only correct
   * if a HUMAN can still find it — an undocumented flag is the "built but
   * unreachable" failure this package treats as not-shipped. `--help` is the
   * front door, and it is free: it is never sent to a model.
   */
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const src = await readFile(fileURLToPath(new URL('../bin/acuvo.mjs', import.meta.url)), 'utf8');
  assert.match(src, /--harness <name>/, '--harness must appear in the usage text');
  for (const id of HARNESS_IDS) {
    assert.ok(src.includes(id), `--help must name the available harness "${id}"`);
  }
});
