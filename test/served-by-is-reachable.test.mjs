/**
 * ── ⭐⭐⭐ A CORRECT EXPLANATION BEHIND AN ALWAYS-FALSE CONDITION ─────────────
 *
 * `cacheClause` renders `· served by X` when the cache rate is poor, and says
 * why in its own comment: *"printing the rate without it was reporting a symptom
 * with the cause deleted… on a bad one it is the whole answer."*
 *
 * ⚠️⚠️ `outcome.servedBy` was READ at the render site and ASSIGNED NOWHERE in
 * the package — not even declared on the `SessionDone` typedef. So the suffix
 * could not render on any run, ever, since the day it was written. The rate was
 * printed and the cause was permanently absent.
 *
 * ⭐ AND IT IS THE EXACT READING THAT WOULD HAVE EXPOSED StreamLake — an upstream
 * serving DeepSeek at $0.22/$0.66 against the pinned $0.08/$0.18, 2.75x, for six
 * days, found only by a hand-written SQL query against the console's usage
 * table. The CLI could have said it out loud at the end of every bad run.
 *
 * These tests exist because "the field is populated" and "the sentence renders"
 * are different claims, and this defect lived in the gap between them.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const SRC = readFileSync(join(LIB, 'turn.mjs'), 'utf8');

/**
 * ⚠️ Comments stripped. A comment DESCRIBING `servedBy` is indistinguishable
 * from an assignment to a regex, and this very file is heavily commented — the
 * trap that made two guards elsewhere in this repo green over nothing today.
 * The `//` rule preserves `https://`, which a naive strip eats.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}
const CODE = code(SRC);

test('MUTATION PROOF — comments really are stripped and code survives', () => {
  assert.ok(SRC.includes('the whole answer'), 'the prose anchor should exist in the raw source');
  assert.ok(!CODE.includes('the whole answer'), 'prose should be gone from the stripped source');
  assert.ok(CODE.includes('function cacheClause'), 'code should survive stripping');
});

test('⭐⭐ servedBy is ASSIGNED, not merely read', () => {
  // The original defect in one assertion: the field was read at the render site
  // and produced nowhere.
  assert.match(CODE, /const servedBy = \(\(\) => \{/, 'servedBy must be computed');
  assert.match(CODE, /\n\s*servedBy,/, 'and returned on the session outcome');
});

test('⭐ it is derived from the rounds, which is where the provider actually lands', () => {
  assert.match(CODE, /rounds\[i\]\s*&&\s*rounds\[i\]\.provider/);
});

test('⚠️ MOST RECENT non-null, not the first — failover happens mid-session', () => {
  /**
   * `chain.mjs` fails over across upstreams inside one run. Naming the FIRST
   * provider would attribute a bad cache rate to one that stopped serving
   * several rounds ago — a confident, wrong answer, which is worse than none.
   */
  const fn = /const servedBy = \(\(\) => \{[\s\S]*?\}\)\(\);/.exec(CODE)?.[0] ?? '';
  assert.ok(fn.length > 0, 'the derivation should be findable');
  assert.match(fn, /for \(let i = rounds\.length - 1; i >= 0; i -= 1\)/, 'must scan backwards');
});

test('⚠️ an unattributed run stays null — it does not guess', () => {
  const fn = /const servedBy = \(\(\) => \{[\s\S]*?\}\)\(\);/.exec(CODE)?.[0] ?? '';
  assert.match(fn, /return null;/, 'no name found must yield null, never a placeholder');
  // ⚠️ And nothing may substitute a friendly-looking default: 'unknown' printed
  // as a provider name is a fabricated attribution.
  assert.ok(!/return '[^']+';/.test(fn), 'must not return a literal stand-in name');
});

test('⭐ the field is DECLARED on SessionDone, so the next reader can see it exists', () => {
  // It was absent from the typedef, which is why nothing ever set it — the
  // shape itself said the field was not part of the contract.
  assert.match(SRC, /servedBy: string \| null/);
});

test('⚠️ the render site still consumes it — the two halves must stay connected', () => {
  assert.match(CODE, /cacheClause\(outcome\.usage\?\.cache, outcome\.servedBy\)/);
  // And the clause is still conditional on a poor rate: on a good run the
  // upstream name is noise, which is the behaviour the original chose.
  assert.match(CODE, /servedBy && pct < 50/);
});
