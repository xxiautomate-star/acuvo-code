/**
 * ── WHAT THIS SUITE IS GUARDING, AND WHY IT DID NOT EXIST ───────────────────
 *
 * `repo-map.mjs` splits its listing in two: a task-INVARIANT tranche chosen by
 * a ranking that never sees the user's words, then a task tranche appended
 * after it. The whole point of that split is a PROPERTY, not a feature —
 * *every byte before the task block is identical for every task in the
 * repository*, so two different questions about the same tree share a cached
 * prompt prefix instead of re-paying for the map.
 *
 * ⚠️⚠️ AND NOTHING ASSERTED IT. The sibling suites prove DETERMINISM (the same
 * task twice) and RELEVANCE (a named file is lifted). Neither one compares two
 * DIFFERENT tasks, which is the only comparison the saving lives in — so the
 * property could be destroyed by a change that leaves every existing test green.
 *
 * ⭐ THAT IS NOT HYPOTHETICAL; IT ALREADY HAPPENED ONCE. `buildRepoMap`'s own
 * comment records the first version of this split annotating a task-named file
 * inside the STATIC listing — six characters inside a bracket — which collapsed
 * the cross-task prefix from 74.4% straight back to 2.1%. It was found by an
 * ad-hoc measurement on a repository outside this package, not by the suite.
 *
 * ── ⭐ WHAT IT IS WORTH, SO THE GUARD IS NOT MISTAKEN FOR PEDANTRY ──────────
 *
 * MEASURED 2026-08-25 on `console/` (2,792 files, 382 directories), same tree,
 * same 9,000-token budget, three different real briefs:
 *
 *     personalised ordering, one FILES block      651 of 31,464 bytes   2.1%
 *     invariant tranche + task tranche         23,420 of 31,496 bytes  74.4%
 *
 * The map is ~8,900 tokens of a ~25,700-token cold head, and on the measured
 * card a cache miss is 15.7x a cache hit. Restated as money: a second session
 * in the same repository pays $0.00431 of input under the personalised ordering
 * and $0.00166 under the split — 61.5% of the warm-session input bill.
 *
 * ── ⚠️ THE CHECKS BIND TO THE SEAM, NOT TO A PERCENTAGE ─────────────────────
 *
 * A test that pinned "74.4%" would go red for every legitimate fixture change
 * and green for the one regression that matters (a leak of six characters moves
 * the number by nothing on a small fixture). So the primary assertion is
 * STRUCTURAL: slice both maps at the task-block heading and compare the halves
 * byte for byte. The percentage floor below it is secondary, and it is derived
 * from `TASK_TRANCHE_SHARE` rather than hard-coded, so it follows the constant.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRepoMap, TASK_TRANCHE_SHARE } from '../lib/repo-map.mjs';

/** The same in-memory filesystem the sibling suites use. Nothing touches disk. */
function makeFs(files, { order = 'reverse' } = {}) {
  const norm = new Map();
  for (const [p, v] of Object.entries(files)) norm.set(p, { content: v, mtimeMs: 0 });
  const dirs = new Set(['']);
  for (const p of norm.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    existsImpl: (rel) => norm.has(rel) || dirs.has(rel),
    readdirImpl: (rel) => {
      if (!dirs.has(rel)) return null;
      const prefix = rel === '' ? '' : `${rel}/`;
      const seen = new Map();
      for (const p of norm.keys()) {
        if (rel !== '' && !p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) seen.set(rest, 'file');
        else seen.set(rest.slice(0, slash), 'dir');
      }
      const out = [...seen].map(([name, type]) => ({ name, type }));
      if (order === 'reverse') out.reverse();
      return out;
    },
    statImpl: (rel) => {
      if (norm.has(rel)) return { size: Buffer.byteLength(norm.get(rel).content, 'utf8'), mtimeMs: 0, dir: false };
      if (dirs.has(rel)) return { size: 0, mtimeMs: 0, dir: true };
      return null;
    },
    readFileImpl: (rel) => (norm.has(rel) ? norm.get(rel).content : null),
  };
}

/**
 * 12 packages x (1 hub + 12 parts) = 157 files with a REAL reference graph:
 * every part imports two hubs chosen by arithmetic, so some hubs are referenced
 * twenty times and some twice, and the ranking has something to rank.
 *
 * ⚠️ IT MUST NOT FIT THE BUDGET. On a tree that fits, the FILES section renders
 * in path order whatever the ranker decided, the task tranche is empty, and
 * every assertion below passes over a map that has no task-varying part at all.
 * `truncated` is asserted in each test for exactly that reason.
 */
function syntheticRepo() {
  const files = { 'package.json': '{"name":"synthetic","main":"./pkg/mod00/index.mjs"}' };
  for (let p = 0; p < 12; p++) {
    const dir = `pkg/mod${String(p).padStart(2, '0')}`;
    files[`${dir}/index.mjs`] = `export function hub${String(p).padStart(2, '0')}Thing() { return ${p}; }\n`;
    for (let f = 0; f < 12; f++) {
      const a = String((p * 7 + f) % 12).padStart(2, '0');
      const b = String((p + f * 5) % 12).padStart(2, '0');
      files[`${dir}/part${String(f).padStart(2, '0')}.mjs`] = [
        `import { hub${a}Thing } from '../mod${a}/index.mjs';`,
        `import { hub${b}Thing } from '../mod${b}/index.mjs';`,
        `export function part${p}_${f}() { return hub${a}Thing() + hub${b}Thing(); }`,
        '',
      ].join('\n');
    }
  }
  return files;
}

/** Tight enough that the budget bites; wide enough that the map is a real map. */
const BUDGET = 1_100;

const SEEDED_A = 'fix hub03Thing in pkg/mod03/index.mjs';
const SEEDED_B = 'rewrite hub09Thing inside pkg/mod09/index.mjs';
/** Names nothing a regex can turn into a seed — the degenerate case. */
const UNSEEDED_A = 'hi';
const UNSEEDED_B = 'go on then';

const build = (task) => buildRepoMap('/repo', makeFs(syntheticRepo()), { budgetTokens: BUDGET, task });

/**
 * Everything before the task block. Both headings are recognised: a SEEDED
 * tranche renders "ALSO RELEVANT", an unseeded one renders "FILES (continued)",
 * and the invariant half must be identical across both.
 */
function invariantHalf(text) {
  const seeded = text.indexOf('\nALSO RELEVANT');
  const unseeded = text.indexOf('\nFILES (continued)');
  const cut = seeded >= 0 ? seeded : unseeded;
  return { cut, text: cut >= 0 ? text.slice(0, cut) : text };
}

function sharedPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// ── 1. THE PROPERTY THE SAVING IS ────────────────────────────────────────────

test('⚠️⚠️⭐ the INVARIANT tranche is byte-identical across DIFFERENT tasks — this is the whole cache saving', () => {
  const maps = [SEEDED_A, SEEDED_B, UNSEEDED_A].map(build);
  for (const m of maps) {
    assert.equal(m.truncated, true,
      'fixture drift: the tree fits the budget, so there is no task tranche and this test proves nothing');
  }
  const halves = maps.map((m) => invariantHalf(m.text));
  for (const h of halves) {
    assert.ok(h.cut > 0, 'no task block was rendered at all — the split this suite guards does not exist in the output');
  }
  assert.equal(halves[1].text, halves[0].text,
    'two DIFFERENT tasks produced different bytes BEFORE the task block — the map is task-varying again and every '
    + 'cross-session cache hit on it is gone (measured cost: 74.4% -> 2.1% shared prefix on console/)');
  assert.equal(halves[2].text, halves[0].text,
    'a task that names NOTHING produced a different invariant half from one that names a file — the reservation is '
    + 'supposed to be unconditional, so an unseeded map must share the same first three quarters');
});

test('⭐ the prefix survives INTACT up to the task block — a symbol annotation in the static listing is a six-character regression', () => {
  const a = build(SEEDED_A);
  const b = build(SEEDED_B);
  const none = build(UNSEEDED_A);
  const inv = invariantHalf(a.text).text.length;

  assert.ok(sharedPrefix(a.text, b.text) >= inv,
    `two seeded maps diverged at byte ${sharedPrefix(a.text, b.text)} of an invariant half ${inv} bytes long — `
    + 'something inside the static listing is reading the task');
  assert.ok(sharedPrefix(a.text, none.text) >= inv,
    'a seeded map and an unseeded map diverged inside the invariant half');
});

test('⭐ two tasks that seed NOTHING produce byte-identical maps — an unnamed question costs no cache at all', () => {
  const a = build(UNSEEDED_A);
  const b = build(UNSEEDED_B);
  assert.equal(a.stats.rankSeeds, 0, 'fixture drift: this task seeded the ranking, so it is not the unseeded case');
  assert.equal(b.stats.rankSeeds, 0, 'fixture drift: this task seeded the ranking, so it is not the unseeded case');
  assert.equal(a.text, b.text,
    'two tasks with no mentions rendered different maps — the tranche is supposed to CONTINUE the invariant order '
    + 'when there is nothing to personalise');
});

// ── 2. THE CHECKS THAT FAIL CORRECT WORK ────────────────────────────────────

/**
 * ⚠️ WITHOUT THIS, DELETING PERSONALIZATION SCORES A PERFECT 100% AND PASSES
 * EVERY TEST ABOVE. A map that ignores the task is maximally cacheable and
 * completely useless; the guard has to prove the tail still moves.
 */
test('⚠️ A CHECK THAT FAILS CORRECT WORK: the TASK block does vary between tasks', () => {
  const a = build(SEEDED_A);
  const b = build(SEEDED_B);
  const tailA = a.text.slice(invariantHalf(a.text).cut);
  const tailB = b.text.slice(invariantHalf(b.text).cut);
  assert.notEqual(tailA, tailB,
    'two different tasks produced the same task block — the personalized ranking is no longer reaching the output, '
    + 'so the map is cheap and blind rather than cheap and relevant');
  assert.ok(a.stats.rankSeeds > 0 && b.stats.rankSeeds > 0, 'neither task seeded the ranking — fixture drift');
});

test('⚠️ the STATIC tranche size is a function of (tree, budget) and never of the task', () => {
  const filesSection = (text) => {
    const start = text.indexOf('\nFILES\n');
    assert.ok(start >= 0, 'the map has no FILES section');
    const rest = text.slice(start + 7);
    const end = rest.indexOf('\n\n');
    return (end < 0 ? rest : rest.slice(0, end)).split('\n').filter((l) => l.startsWith('  '));
  };
  const counts = [SEEDED_A, SEEDED_B, UNSEEDED_A, UNSEEDED_B].map((t) => filesSection(build(t).text).length);
  assert.equal(new Set(counts).size, 1,
    `the FILES section held ${counts.join(', ')} lines for four different tasks — \`take\` is reading the task, which `
    + 'is the exact defect the unconditional reservation exists to prevent');
});

// ── 3. THE FLOOR, DERIVED FROM THE CONSTANT RATHER THAN PINNED ──────────────

test('⭐ the cross-task shared prefix stays at the floor `TASK_TRANCHE_SHARE` promises', () => {
  const a = build(SEEDED_A);
  const b = build(SEEDED_B);
  const share = sharedPrefix(a.text, b.text) / Math.max(a.text.length, b.text.length);
  /**
   * ⚠️ THE TARGET IS `1 - TASK_TRANCHE_SHARE` AND THE SLACK IS THE TAIL. `NOT
   * LISTED` and `TOTALS` sit after the task block and count files, so they move
   * with it; on this fixture they are ~2% of the map and on `console/` ~1%.
   * Measured here: 79.6%. Measured on console/ at 9,000 tokens: 74.4%. Five
   * points of slack covers both without leaving room for a real regression —
   * the failure this catches lands at 2%, not at 68%.
   */
  const floor = 1 - TASK_TRANCHE_SHARE - 0.05;
  assert.ok(share >= floor,
    `two tasks shared only ${(100 * share).toFixed(1)}% of the map against a floor of ${(100 * floor).toFixed(1)}% — `
    + 'the split is no longer delivering what the constant reserves');
});

// ── 4. DETERMINISM, IN THE PRESENCE OF THE SPLIT ────────────────────────────

/**
 * ⚠️ THE SIBLING SUITE ALREADY PROVES THIS ACROSS PROCESSES, and that is the
 * stronger test. It is repeated here because determinism and cross-task
 * invariance are the two halves of one claim, and a change to the split that
 * made the TASK block non-deterministic would be strictly worse than either
 * option this design was choosing between — a map that reshuffles for the same
 * question pays full price twice for identical bytes.
 */
test('⚠️⚠️ three runs of the same (tree, task) are byte-identical — for the seeded AND the unseeded tranche', () => {
  for (const task of [SEEDED_A, SEEDED_B, UNSEEDED_A]) {
    const runs = [0, 1, 2].map(() => build(task));
    assert.equal(runs[1].text, runs[0].text, `the map reshuffled between runs for task ${JSON.stringify(task)}`);
    assert.equal(runs[2].text, runs[1].text, `the map reshuffled between runs for task ${JSON.stringify(task)}`);
  }
});
