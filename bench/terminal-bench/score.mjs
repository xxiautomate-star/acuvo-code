#!/usr/bin/env node
/**
 * ── ⚠️⚠️⚠️ SCORE A RUN. READ `verifier/reward.txt`, NOTHING ELSE. ───────────
 *
 * This file exists because I reported 0/60 and then 0/12 to Roman, twice, and
 * both were wrong. My ad-hoc scoring read `is_resolved` / `resolved` / `reward`
 * off `result.json` — **none of those fields exist there** — and defaulted every
 * task to FAIL. The real answers were 11.7% and 33.3%.
 *
 * ⚠️ THE FAILURE MODE IS THE DANGEROUS ONE: a missing field read as a definite
 * "no". Same shape as the 416 that looked like an empty database, and the null
 * plan that rendered as "Unlimited". An ABSENCE became a CLAIM, and the claim was
 * that our own product could not do anything.
 *
 * ⭐ `verifier/reward.txt` is the number the harness actually wrote: `1` for a
 * resolved task, `0` otherwise. A task with no reward.txt has not been scored
 * yet and is EXCLUDED rather than counted as a failure — an unfinished task is
 * not a failed one.
 *
 * Usage:  node score.mjs [results/<job-name>]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';

const dir = process.argv[2] ?? 'results/run-fixed';

let scored = 0;
let passed = 0;
let unscored = 0;
/** Trials that died before producing a verdict — never a pass, never a fail, never a wait. */
const crashed = [];
const wins = [];
const losses = [];

for (const name of readdirSync(dir)) {
  const path = `${dir}/${name}`;
  try { if (!statSync(path).isDirectory()) continue; } catch { continue; }

  let reward = null;
  try { reward = readFileSync(`${path}/verifier/reward.txt`, 'utf8').trim(); } catch { /* not scored */ }

  const task = name.split('__')[0];
  if (reward === null) {
    /**
     * ⚠️ "UNSCORED" IS TWO DIFFERENT THINGS AND THEY MUST NOT SHARE A LABEL.
     * A trial still in flight has no verdict YET; one that wrote `exception.txt`
     * never will. Reporting the second as "still running" invites you to wait
     * for a number that is never coming.
     */
    let why = null;
    try { why = readFileSync(`${path}/exception.txt`, 'utf8').trim(); } catch { /* genuinely unscored */ }
    /**
     * ⚠️ THE LAST LINE, NOT THE FIRST. A Python traceback opens with
     * "Traceback (most recent call last):" — identical for every failure, so
     * grouping on it collapses every distinct cause into one meaningless row.
     * The exception itself is at the BOTTOM.
     */
    /**
     * ⚠️ STORED WHOLE, TRUNCATED ONLY AT DISPLAY. Cutting to 90 chars HERE and
     * normalising later cuts each line at a different point, so messages that
     * are identical once normalised still group apart — which is exactly the
     * fragmentation `normaliseCause` exists to prevent.
     */
    if (why) crashed.push({ task, why: why.split('\n').filter((l) => l.trim()).pop() ?? why });
    else unscored += 1;
    continue;
  }

  scored += 1;
  if (Number(reward) >= 1) { passed += 1; wins.push(task); } else losses.push(task);
}

/**
 * ⭐⭐⭐ A PERCENTAGE OVER THE SURVIVORS IS NOT A SCORE.
 *
 * This printed `37.5%` for a run that was 6 passes out of 16 SCORED trials on an
 * 89-task benchmark — 73 tasks never produced a `reward.txt` at all, 63 of them
 * killed together when the Docker daemon collapsed. That number was then quoted
 * against Claude Code's 89.1%/89 as though the denominators matched. One is a
 * benchmark result; the other is survivorship bias with a decimal point.
 *
 * ⚠️ The percentage is still shown when the run is incomplete — labelled as
 * covering the scored trials only — because suppressing it just moves the
 * arithmetic into someone's head, where it loses the caveat. What must never
 * appear again is a lone `37.5%` that reads like `89.1%`.
 */
/**
 * ⚠️⚠️ 63 IDENTICAL FAILURES MUST GROUP AS ONE, OR THE TAIL EATS THE SIGNAL.
 *
 * Every Docker collapse in this run ended with the SAME sentence carrying a
 * DIFFERENT project id and path — so exact grouping reported "63 distinct
 * causes" for what was one daemon dying once. A cause list that fragments is
 * worse than no cause list: it hides the single fact that explains the run.
 */
function normaliseCause(line) {
  return line
    .replace(/[A-Za-z]:\[^\s]+/g, '<path>')
    .replace(/\/[^\s]{8,}/g, '<path>')
    .replace(/for environment \S+/g, 'for environment <task>')
    .replace(/[0-9a-f]{8,}/gi, '<id>')
    .replace(/\d{4,}/g, '<n>')
    .slice(0, 90);
}

const total = scored + crashed.length + unscored;
const complete = crashed.length === 0 && unscored === 0;
const pct = scored ? ((100 * passed) / scored).toFixed(1) : '—';
console.log(`
  ${dir}`);
if (complete) {
  console.log(`  SCORE  ${passed}/${scored}  =  ${pct}%
`);
} else {
  console.log(`  ${passed}/${scored} scored trials passed  (${pct}% OF THE SCORED ONES — not a benchmark score)`);
  const parts = [];
  if (crashed.length) parts.push(`${crashed.length} crashed before producing a verdict`);
  if (unscored) parts.push(`${unscored} still running`);
  console.log(`  ⚠ ${total} tasks attempted: ${parts.join(', ')}.`);
  console.log(`  ⚠ NOT comparable to a published figure until the denominator is ${total}.
`);
}
if (crashed.length) {
  // Grouped: 63 identical Docker failures are ONE fact, not 63 findings.
  const why = new Map();
  for (const c of crashed) { const k = normaliseCause(c.why); why.set(k, (why.get(k) ?? 0) + 1); }
  console.log('  crashed:');
  for (const [reason, n] of [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`    ${String(n).padStart(3)} ×  ${reason}`);
  }
  /**
   * ⚠️ A TRUNCATED LIST SAYS SO. Printing five rows out of twenty silently
   * reads as "these are the causes", which is how a run gets diagnosed
   * against a fifth of its own evidence.
   */
  if (why.size > 5) console.log(`    …and ${why.size - 5} more distinct cause${why.size - 5 === 1 ? '' : 's'}`);
  console.log('');
}
if (wins.length) console.log(`  passed: ${wins.join(', ')}\n`);
if (losses.length) console.log(`  failed: ${losses.join(', ')}\n`);
