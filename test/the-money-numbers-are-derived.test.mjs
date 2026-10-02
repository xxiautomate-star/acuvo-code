/**
 * ── ⚠️⚠️ THE FRONT DOOR UNDERSTATED THE SPEND CEILING BY 2.5x FOR TWO WEEKS ──
 *
 * `DEFAULT_BUDGET_USD` was deliberately raised $0.02 → $0.05 on 2026-08-19, and
 * the two strings a USER READS were not touched:
 *
 *   · `--help`, the `--budget` block:  "⭐ A $0.02 ceiling is ALREADY ON"
 *   · the no-key message in model.mjs: "The ceiling is $0.02 a run"
 *
 * ⭐ THE HARM IS NOT COSMETIC AND IT IS NOT SYMMETRIC. This number is the
 * promise about how much money the tool may spend on your behalf before it
 * stops, told to an owner who is pre-revenue and paying out of pocket. A stated
 * ceiling that is LOWER than the real one is the direction that costs money.
 *
 * ⚠️ `docs-truth.test.mjs` EXISTS AND MISSED IT — it checks numbers quoted about
 * FILES (line counts, tool counts), not numbers quoted about MONEY. This file is
 * the money half.
 *
 * ⭐ AND IT ASSERTS *DERIVED*, NOT *CORRECT*. Pinning the literal "$0.05" would
 * be the identical bug with a fresher number: the next person to change the
 * constant would have to remember two places again. What is pinned is that the
 * user-facing text moves when the constant moves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_BUDGET_USD } from '../lib/budget.mjs';
import { USAGE } from '../lib/cli-args.mjs';

const helpText = String(USAGE);

test('⭐ --help quotes the REAL default ceiling', () => {
  assert.ok(
    helpText.includes(`$${DEFAULT_BUDGET_USD} ceiling is ALREADY ON`),
    `--help must name $${DEFAULT_BUDGET_USD}; it says: ${helpText.split('\n').filter((l) => l.includes('ceiling is ALREADY')).join(' | ')}`,
  );
});

test('⚠️ and no user-facing money string still names the OLD $0.02 default', () => {
  /**
   * ⚠️ SOURCE TEXT, NOT THE RENDERED STRING, and deliberately so: the failure
   * was a hardcoded literal sitting in a template nobody re-read. Scanning the
   * two files for the stale number is what would have caught it on the day.
   *
   * ⚠️ COMMENTS ARE EXCLUDED. `budget.mjs` HAS to say "$0.02" — its whole
   * decision record is about raising it from there. Only lines that end up in
   * front of a user are checked, which is why this reads the quoted strings.
   */
  for (const file of ['lib/cli-args.mjs', 'lib/model.mjs']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const offenders = src.split(/\r?\n/)
      .map((line, i) => ({ line, n: i + 1 }))
      // a quoted string, not a comment line
      .filter(({ line }) => /^\s*[`'"]/.test(line))
      .filter(({ line }) => /\$0\.02\b/.test(line));
    assert.deepEqual(offenders, [], `${file} still shows a user $0.02 as the ceiling`);
  }
});

test('⭐ the constant is the single source — moving it moves the text', () => {
  /**
   * The regression this file exists for is "the constant changed and the words
   * did not". So the assertion is about the RELATIONSHIP: whatever the constant
   * is, the help says that.
   */
  assert.equal(typeof DEFAULT_BUDGET_USD, 'number');
  assert.ok(DEFAULT_BUDGET_USD > 0);
  const quoted = helpText.match(/A \$([0-9.]+) ceiling is ALREADY ON/);
  assert.ok(quoted, 'the help line must still exist to be checkable');
  assert.equal(Number(quoted[1]), DEFAULT_BUDGET_USD);
});
