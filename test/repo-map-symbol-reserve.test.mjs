/**
 * ── THE MEASURED DEFECT THIS SUITE EXISTS FOR ───────────────────────────────
 *
 * ⭐⭐ MEASURED 2026-08-29 AGAINST PRODUCTION CODE, on two real trees:
 *
 *     tree                       files   paths listed   SYMBOL LISTS IN PROMPT
 *     console/                   3,443            687                        0
 *     the enclosing worktree     9,652            679                        0
 *
 * ZERO. Not "few" — zero, on every repository big enough to truncate. And the
 * symbols were not missing, they were DISCARDED: 596 of the 687 files console
 * rendered (86.8%) had a symbol list already extracted and sitting in memory
 * when the map was built. We paid for the reads and threw the answer away.
 *
 * ⭐ THE CAUSE WAS ONE COMPARISON. The fit chose `symCount` first, then dropped
 * paths until `used <= staticBudget` — so the drop loop stopped at the instant
 * PATHS ALONE filled the budget, and the "dropping paths freed room; hand it
 * back to symbols" pass that follows had, by construction, nothing to hand
 * back. Symbols were structurally last in a queue that always ran out.
 *
 * ⚠️⚠️ AND IT WAS INVISIBLE ON THIS PACKAGE, WHICH IS WHY IT SURVIVED.
 * `acuvo-code` fits inside the budget, takes the `take === ordered.length`
 * branch, and showed 142 symbol lists — so every measurement anyone took here
 * said the feature worked. Exactly the shape of the graph-ceiling defect
 * recorded in `repo-map.mjs`: the regime that matters exists only on
 * customer-sized trees, and we do not have one checked out. Hence the
 * `bigTree()` fixture below, whose only job is to be too big to fit.
 *
 * ── ⚠️ WHAT MUST NOT REGRESS WHILE FIXING IT ────────────────────────────────
 *
 * The reserve moves prompt bytes, so all three of the module's load-bearing
 * properties are re-asserted here rather than assumed: it stays deterministic,
 * it stays task-INVARIANT (`symCount` may not depend on the request, or the
 * cross-task prefix collapses and that is worth 3.05x), and it is ADDITIVE —
 * a tree that already fitted must take no reserve at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRepoMap, SYMBOL_RESERVE_SHARE, TASK_TRANCHE_SHARE } from '../lib/repo-map.mjs';

/** The same literal filesystem the sibling suites use. Reversed on purpose. */
function makeFs(files) {
  const norm = new Map(Object.entries(files));
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
      return [...seen].map(([name, type]) => ({ name, type })).reverse();
    },
    statImpl: (rel) => {
      if (norm.has(rel)) return { size: Buffer.byteLength(norm.get(rel), 'utf8'), mtimeMs: 0, dir: false };
      if (dirs.has(rel)) return { size: 0, mtimeMs: 0, dir: true };
      return null;
    },
    readFileImpl: (rel) => (norm.has(rel) ? norm.get(rel) : null),
  };
}

/**
 * ⚠️ THE PATHS ARE LONG AND NESTED ON PURPOSE. This is not decoration: the
 * whole trade the reserve makes is "a path line for a symbol line", so its
 * value depends on what a path COSTS. A flat fixture of `lib/mod007.mjs` has
 * 18-character paths and understates the trade by a factor of two; the paths
 * below are the shape of the real repository the defect was measured on
 * (`app/api/tenant/[tenantId]/…`, ~43 characters).
 *
 * ⭐ AND EVERY LEAF IMPORTS ITS HUB, so there is a real symbol graph for the
 * ranking to travel. With no edges PageRank is uniform, the "highest-ranked
 * files get the symbols" claim is untestable, and this suite would be asserting
 * an accident.
 */
function bigTree({ packages = 40, leaves = 24 } = {}) {
  const files = {};
  for (let p = 0; p < packages; p += 1) {
    const dir = `app/api/tenant/module${String(p).padStart(2, '0')}`;
    files[`${dir}/hub.mjs`] = `export function hub${p}Thing() { return ${p}; }\nexport const HUB${p} = ${p};\n`;
    for (let i = 0; i < leaves; i += 1) {
      files[`${dir}/handlers/leaf${String(i).padStart(2, '0')}/route.mjs`] =
        `import { hub${p}Thing } from '../../hub.mjs';\nexport const v${p}_${i} = hub${p}Thing();\n`;
    }
  }
  return files;
}

// ── 1. THE DEFECT ITSELF ────────────────────────────────────────────────────

test('⭐⭐ a TRUNCATED map renders symbol lists — it used to render exactly zero', () => {
  const files = bigTree();
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 2_000 });

  assert.ok(map.truncated, 'fixture drift: this tree fits the budget, so the defect regime is not being exercised');
  assert.ok(map.stats.symbolsShown > 0,
    'a truncated map showed ZERO symbol lists — paths are eating the whole budget again, which is the entire defect');

  /**
   * ⭐ AND THE SYMBOLS WERE ALREADY PAID FOR. This is the number that made the
   * defect indefensible rather than merely unfortunate: the extraction had
   * already happened and the rendering threw it away.
   */
  const extracted = map.files.filter((f) => f.symbols && f.symbols.length).length;
  assert.ok(extracted > 0 && map.stats.symbolsShown <= extracted);
});

test('⚠️ the reserve is a RECEIPT, not a hidden constant — stats say how much was withheld', () => {
  const map = buildRepoMap('/repo', makeFs(bigTree()), { budgetTokens: 2_000 });
  const staticBudget = 2_000 - Math.floor(2_000 * TASK_TRANCHE_SHARE);
  assert.equal(map.stats.symbolReserveTokens, Math.floor(staticBudget * SYMBOL_RESERVE_SHARE),
    'the reserve reported does not match the share the module says it takes');
});

// ── 2. ADDITIVE — A TREE THAT FITTED MUST BE UNTOUCHED ─────────────────────

/**
 * ⚠️⚠️ THE FIRST VERSION OF THE FIX FAILED THIS, AND ONLY A MEASUREMENT CAUGHT
 * IT. The reserve branch is entered whenever the map WITH EVERY SYMBOL LIST is
 * over budget — which includes trees whose PATHS fit comfortably and only the
 * annotations overflow. Reserving there pushed `take` below `ordered.length`,
 * which silently disabled the `take === ordered.length` hand-back that gives
 * such a tree its symbols; measured on this package, 142 symbol lists fell to
 * 65 and ~2,000 tokens went unspent. The reserve must be taken ONLY when paths
 * were going to be cut anyway.
 */
test('⭐ a tree whose paths fit takes NO reserve, and keeps every path it had', () => {
  const files = {};
  for (let i = 0; i < 60; i += 1) {
    files[`lib/mod${String(i).padStart(3, '0')}.mjs`] = 'export function alpha() {}\nexport const BETA = 1;\nexport class Gamma {}\n';
  }
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 1_400 });

  assert.equal(map.stats.listedFiles, 60, 'a tree whose paths fit lost a path to the reserve');
  assert.equal(map.stats.omittedFiles, 0);
  assert.ok(map.stats.symbolsShown > 0, 'a fitting tree lost its symbol lists — the hand-back branch was disabled');
  assert.ok(!map.stats.symbolReserveTokens,
    `the reserve was taken on a tree that did not need truncating (${map.stats.symbolReserveTokens} tokens)`);
});

// ── 3. COVERAGE IS STILL THE PRODUCT ───────────────────────────────────────

test('⚠️ the reserve is BOUNDED — paths keep the clear majority of the map', () => {
  const files = bigTree();
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 2_000 });

  const fileLines = map.text.split('\n').filter((l) => /^\s{2,}\S+\.mjs/.test(l));
  const annotation = fileLines.reduce((n, l) => n + (l.includes('[') ? l.length - l.indexOf('[') : 0), 0);
  const paths = fileLines.reduce((n, l) => n + (l.includes('[') ? l.indexOf('[') : l.length), 0);
  assert.ok(annotation < paths,
    `symbol lists took ${annotation} bytes against ${paths} for the paths — the bonus has become the product`);
  assert.ok(map.stats.tokensEstimated <= 2_000, 'the reserve pushed the map over its budget');
});

// ── 4. THE INVARIANTS THAT OUTRANK THE FEATURE ─────────────────────────────

test('⚠️⚠️ determinism survives the reserve — three builds are byte-identical', () => {
  const files = bigTree();
  const runs = [0, 1, 2].map(() => buildRepoMap('/repo', makeFs(files), { budgetTokens: 2_000, task: 'fix hub7Thing' }));
  assert.equal(runs[0].text, runs[1].text);
  assert.equal(runs[1].text, runs[2].text);
});

/**
 * ⚠️⚠️ THE ONE THAT WOULD COST REAL MONEY. `symCount` and `take` must be pure
 * functions of (tree, budget). If the reserve ever became a function of the
 * TASK, the invariant tranche would diverge inside the first screen and the
 * cross-task prompt prefix — worth 3.05x — would collapse. The floor is derived
 * from `TASK_TRANCHE_SHARE` rather than pinned, so the constant and the guard
 * cannot drift apart.
 */
test('⚠️⚠️ the reserve is TASK-INVARIANT — two different tasks share the invariant head', () => {
  const files = bigTree();
  const a = buildRepoMap('/repo', makeFs(files), { budgetTokens: 2_000, task: 'fix hub01Thing in app/api/tenant/module01/hub.mjs' });
  const b = buildRepoMap('/repo', makeFs(files), { budgetTokens: 2_000, task: 'fix hub31Thing in app/api/tenant/module31/hub.mjs' });

  assert.notEqual(a.text, b.text, 'fixture drift: the two tasks produce identical maps, so nothing below is being tested');

  let shared = 0;
  while (shared < Math.min(a.text.length, b.text.length) && a.text[shared] === b.text[shared]) shared += 1;
  const floor = (1 - TASK_TRANCHE_SHARE) * 0.8;
  assert.ok(shared / a.text.length >= floor,
    `only ${(100 * shared / a.text.length).toFixed(1)}% of the map is shared between two tasks — the invariant tranche has become task-varying`);
});

/**
 * ⭐ THE SYMBOLS MUST LAND ON THE FILES THE RANKING PUT FIRST, not on whichever
 * files the walk happened to reach. That asymmetry is the whole argument for
 * the trade: the paths given up are the tail of a PageRank ordering and the
 * symbols bought land at its head. Without it, this change would be spending
 * coverage on noise.
 */
test('⭐ the symbol lists land on the HIGHEST-RANKED files, which is what makes the trade worth it', () => {
  const files = bigTree();
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 2_000 });

  const annotated = map.text.split('\n').filter((l) => /^\s{2,}\S+\.mjs/.test(l) && l.includes('['));
  assert.ok(annotated.length > 0);
  /**
   * Every leaf imports its hub, so the hubs are what the graph flows into and
   * what PageRank lifts. A `handlers/leaf.../route.mjs` carrying symbols while
   * a `hub.mjs` does not would mean the annotations are following the walk
   * order rather than the rank.
   */
  const hubs = annotated.filter((l) => l.includes('/hub.mjs')).length;
  assert.ok(hubs >= annotated.length / 2,
    `only ${hubs} of ${annotated.length} annotated files are hubs — the symbols are not following the ranking`);
});
