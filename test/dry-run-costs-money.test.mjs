/**
 * ── ⚠️⚠️⚠️ `--dry-run` DOES NOT PREVENT SPEND, AND THREE SURFACES SAID IT DID ─
 *
 * Reported and confirmed 2026-08-31: `--best-of 3 --dry-run` charged three real
 * model runs and produced nothing.
 *
 * ⭐ THE MECHANISM IS NOT A BUG, THE DESCRIPTION WAS. `--dry-run` sets `dryRun`
 * on the EXECUTOR, so tool calls are refused — AFTER the model has produced
 * them. `lib/cli-args.mjs` states this correctly in the `--plan` comment
 * (*"prints the writes it would have made — after the model has already decided
 * what they are"*) while its own help line said **"run nothing"** and the
 * runtime banner said **"nothing written, nothing run"**. The one flag a
 * cautious user reaches for first was the one described as free.
 *
 * ⚠️ AND UNDER `--best-of N` IT IS GUARANTEED WASTE, not merely surprising:
 * every attempt has writes suppressed, so all N workspaces come back identical
 * to the original, `pickWinner` ranks nothing and `applyAttempt` copies nothing
 * back. N model runs, zero possible result.
 *
 * ⭐ These assertions read the SHIPPED STRINGS rather than a copy of them, so
 * the claim cannot drift back into the text it was corrected out of.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = readFileSync(join(ROOT, 'lib/cli-args.mjs'), 'utf8');
const BIN = readFileSync(join(ROOT, 'bin/acuvo.mjs'), 'utf8');

/** The `--help` text is an exported array of literals; pull the flag's lines. */
function helpLinesFor(flag) {
  const lines = HELP.split('\n');
  const at = lines.findIndex((l) => l.includes(`'  ${flag} `));
  assert.ok(at > -1, `the ${flag} help line is gone — this guard is reading nothing`);
  return lines.slice(at, at + 4).join('\n');
}

test('⚠️ the --dry-run help line does not promise that nothing runs', () => {
  const block = helpLinesFor('--dry-run');
  /**
   * ⚠️ THE POSITIVE CONTROL FIRST. If the slice stops finding the flag's own
   * text, every assertion below passes by looking at the wrong lines — which is
   * how this repo has shipped guards that were green because they were blind.
   */
  assert.match(block, /Print what WOULD be written/, 'control: the dry-run help block was not located');

  assert.doesNotMatch(
    block,
    /run nothing|nothing is run|nothing runs/i,
    '`--dry-run` help promises that nothing runs. The model DOES run and the user IS billed; '
    + 'that sentence is what made `--best-of 3 --dry-run` look free.',
  );
  assert.match(
    block,
    /STILL BILLED|still billed/,
    'the `--dry-run` help must say the run is still billed — the cost is the thing users get wrong.',
  );
});

test('⚠️ the runtime banner does not promise that nothing runs', () => {
  assert.match(BIN, /DRY RUN \(nothing written\)/, 'control: the dry-run banner was not located');
  assert.doesNotMatch(
    BIN,
    /DRY RUN \(nothing written, nothing run\)/,
    'the banner printed at the moment of truth still says "nothing run". It is billed.',
  );
  assert.match(
    BIN,
    /DRY RUN \(nothing written\)[^']*still billed/,
    'the dry-run banner must name the cost, not only the writes.',
  );
});

/**
 * ⭐⭐ THE MONEY GUARD. `--best-of N --dry-run` must be refused BEFORE
 * `runBestOf` is reached, because `runBestOf` is where the N model runs are
 * paid for. This asserts the ORDER, not merely the presence of a check.
 */
test('⭐⭐ --best-of + --dry-run is refused before any attempt is started', () => {
  const branch = BIN.slice(BIN.indexOf('if (opts.bestOf >= 2 && !opts.untilDone) {'));
  assert.ok(branch.length > 500, 'the best-of branch moved — this guard is reading nothing');

  const refusal = branch.indexOf('if (opts.dryRun) {');
  const spend = branch.indexOf('await runBestOf({');
  assert.ok(refusal > -1, '`--best-of --dry-run` is not refused; N model runs would be charged for a guaranteed no-op');
  assert.ok(spend > -1, 'control: `runBestOf` is no longer called from this branch');
  assert.ok(
    refusal < spend,
    'the `--dry-run` refusal sits AFTER `runBestOf` — the attempts, and the whole bill, happen first.',
  );
  assert.match(
    branch.slice(refusal, spend),
    /charged|billed/,
    'the refusal must tell the user it is about money, or it reads as an arbitrary restriction.',
  );
});
