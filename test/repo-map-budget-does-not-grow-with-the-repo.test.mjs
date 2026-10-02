/**
 * ── ⚠️⚠️⭐ THE MAP IS A CEILING, NOT A SPEND — AND NOTHING ASSERTED IT ────────
 *
 * `lib/repo-map.mjs` rides the CACHEABLE PROMPT PREFIX. Two properties make that
 * pay, and the sibling suites only ever pinned one of them:
 *
 *   · DETERMINISM — the same tree renders the same bytes. Pinned five times over
 *     (repo-map.test.mjs, -rank, -cross-task-prefix, -graph-ceiling), including
 *     across separate PROCESSES and with the symbol ceiling binding. Solid.
 *   · ⚠️ BOUNDEDNESS — the map costs the SAME on a 10,000-file repository as on
 *     a 500-file one. **Nothing tested this**, and it is the half that decides
 *     whether a real customer can afford us at all.
 *
 * ⭐ WHY THE EXISTING BUDGET TESTS DO NOT COVER IT. repo-map.test.mjs has "the
 * estimate stays inside the budget it was given", and it is a good test of the
 * wrong thing: it runs at budgets of 100, 400 and 1500 tokens on trees of a
 * handful of files, and it allows `budget * 1.25`. It proves the truncator obeys
 * an argument. It cannot see the failure that matters, which is a map whose cost
 * TRACKS THE TREE — because on a tree that small the budget never binds, and
 * every measurement is taken in the regime where there is nothing to truncate.
 *
 * ⚠️⚠️ AND THE FAILURE IT GUARDS AGAINST IS NOT HYPOTHETICAL, IT IS THE DEFECT
 * THIS MODULE REPLACED. `gatherWorkspaceContext` inlined file BODIES; its cost
 * was a function of what it found. The whole argument for the rewrite is in this
 * module's header — *"a path is a handful of tokens; a file is thousands"* — and
 * the thing that makes that argument TRUE at scale is the budget cut, which had
 * no regression test. A future edit that renders one extra fixed line per file,
 * or drops the truncation on a path nobody exercises, re-creates the old
 * economics silently: nothing errors, the maps just get bigger with the repo
 * until a large customer's first prompt is unaffordable.
 *
 * ── ⭐ MEASURED ON REAL TREES, 2026-08-26, at the shipped default of 9,000 ────
 *
 *     tree          files listed  dirs reached  est. tokens  chars
 *     acuvo-code      545    545         12/12        8,598  30,090
 *     console/      2,844    694       376/390        8,999  31,495
 *     the worktree  9,587    662      661/1931        8,992  31,471
 *
 * ⭐⭐ THAT IS THE PROPERTY, AND IT IS A GOOD ONE: the tree grows **17.6×**
 * (545 → 9,587 files) and the prompt grows **4.6%** (8,598 → 8,992 tokens).
 * Growth is paid in COVERAGE — the fraction of the repo that fits — never in
 * dollars. This suite is here so that stays true.
 *
 * ⚠️ SYNTHETIC TREES, ON PURPOSE, FOR THE SCALING ASSERTIONS. A test bound to
 * `console/` would go red when somebody adds a directory, and a test that walks
 * 9,587 real files takes 21 seconds. The trees below are generated, are
 * connected by real cross-references so the ranker has a graph to rank, and cost
 * milliseconds. One test at the bottom does check a real tree on disk, because a
 * conclusion drawn only from a fixture is a conclusion about the fixture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildRepoMap,
  estimateTokens,
  DEFAULT_BUDGET_TOKENS,
} from '../lib/repo-map.mjs';

/**
 * A synthetic repository of `n` source files that actually REFERENCE each other.
 *
 * ⚠️ THE CROSS-REFERENCES ARE LOAD-BEARING AND THE LARGEST FIXTURE IN THE REPO
 * LACKS THEM. `repo-map-graph-ceiling.test.mjs` records that the biggest tree
 * anywhere in these suites is "2,000 files whose contents are the single
 * character `x`: no exports, no identifiers, an EMPTY graph". A map built over
 * an empty graph never exercises `rankFiles`' real path — every score ties and
 * the order falls through to the code-point tiebreak. So a budget measured on
 * `x` files is a budget measured with the ranker switched off.
 *
 * ⭐ THE SHAPE IS DELIBERATELY UNEVEN: files are spread over a growing number of
 * directories at a growing depth, because `orderForBudget` deals one file per
 * (directory, category) per pass. A fixture with everything in one directory
 * would make the breadth sample trivial and hide exactly the regression this
 * file exists to catch.
 */
function syntheticRepo(n) {
  const files = {
    'package.json': JSON.stringify({ name: 'synthetic', scripts: { test: 'node --test', build: 'tsc' } }),
    'README.md': '# synthetic\n',
  };
  for (let i = 0; i < n; i++) {
    // 12 files per directory, so directory count grows with the tree.
    const dir = Math.floor(i / 12);
    // …and depth grows slowly with it, so deep bands exist to be sampled.
    const depth = 1 + (dir % 5);
    const segments = [];
    for (let d = 0; d < depth; d++) segments.push(`pkg${(dir + d) % 40}`);
    const path = `src/${segments.join('/')}/mod${i}.mjs`;
    // Each module exports two symbols and references two of its neighbours', so
    // the reference→definition graph is dense enough for PageRank to have work.
    const a = (i + 1) % n;
    const b = (i + 7) % n;
    files[path] = [
      `import { helper${a} } from './mod${a}.mjs';`,
      `export function helper${i}() { return helper${a}(); }`,
      `export const CONST${i} = helper${b};`,
      `// references: helper${a} helper${b} CONST${a}`,
    ].join('\n');
  }
  return files;
}

/** The synthetic-filesystem shape `buildRepoMap` injects. Mirrors repo-map.test.mjs. */
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
      // ⚠️ REVERSED, like the sibling suite: any order this test asserts must be
      // OUR sort and never the filesystem's accident.
      return [...seen].map(([name, type]) => ({ name, type })).reverse();
    },
    statImpl: (rel) => {
      if (norm.has(rel)) return { size: Buffer.byteLength(norm.get(rel), 'utf8'), mtimeMs: 0, dir: false };
      if (dirs.has(rel)) return { size: 0, mtimeMs: 0, dir: true };
      return null;
    },
    readFileImpl: (rel) => norm.get(rel) ?? null,
  };
}

/**
 * ── ⚠️ THE SIZES ARE SPLIT, AND MY FIRST VERSION OF THIS FILE GOT IT WRONG ───
 *
 * I originally asserted "100 files and 5,000 files cost the same" and the test
 * failed honestly: **1,590 tokens against 8,994.** That is not cost tracking the
 * repository — it is a small repo NOT BEING CHARGED THE CEILING. Recorded
 * because the mistake is the interesting part: "flat everywhere" is the wrong
 * invariant and would have forced the map to waste 7,400 tokens on a tiny repo
 * to satisfy it.
 *
 * ⭐ THE PROPERTY THAT IS ACTUALLY WANTED IS **SATURATION**: cost rises with the
 * tree only until the budget binds, and is FLAT for ever after. Measured
 * 2026-08-26 on the fixture below:
 *
 *        files   tokens   listed   truncated
 *          100    1,590      102   false      ← fits whole, pays for what it is
 *          500    8,179      502   false
 *        1,000    8,998      909   true       ← the budget starts to bind
 *        2,000    8,994      879   true
 *        5,000    8,994      879   true
 *       10,000    8,994      879   true       ← 10× the files, 4 tokens CHEAPER
 *
 * ⭐⭐ FOUR TOKENS OF SPREAD ACROSS A TENFOLD GROWTH. That is the number this
 * suite exists to defend, and it is why a large customer is affordable.
 */
const FITS = 100;
const SATURATED = [1_000, 2_000, 5_000, 10_000];
const SIZES = [FITS, ...SATURATED];

/** Build at the SHIPPED default budget — the number a real user actually pays. */
function mapAt(n) {
  return buildRepoMap('/synthetic', makeFs(syntheticRepo(n)), {});
}

// ── 1. ⚠️⚠️ THE INVARIANT: ONCE THE BUDGET BINDS, COST STOPS GROWING FOR EVER ─

test('⚠️⚠️⭐ past the point the budget binds, a 10× bigger repository costs the SAME — growth is paid in coverage, never in tokens', () => {
  const rows = SATURATED.map((n) => {
    const m = mapAt(n);
    assert.equal(m.ok, true, `the map failed to build at ${n} files: ${m.error}`);
    assert.equal(m.truncated, true, `a ${n}-file repo was expected to exceed the ${DEFAULT_BUDGET_TOKENS}-token budget`);
    return { n, tokens: m.stats.tokensEstimated };
  });

  for (const r of rows) {
    assert.ok(
      r.tokens <= DEFAULT_BUDGET_TOKENS,
      `a ${r.n}-file repo rendered ${r.tokens} tokens against a ${DEFAULT_BUDGET_TOKENS} budget. `
      + 'The budget is a CEILING; a map that overruns it is a prompt the caller never agreed to pay for.',
    );
  }

  /**
   * ⭐ THE REAL ASSERTION, AND THE BOUND IS TIGHT ON PURPOSE. Measured spread is
   * 4 tokens in 8,998 (0.04%); 2% leaves room for a rendering tweak and still
   * catches anything PER-FILE. A per-file cost cannot hide inside 2% across a
   * tenfold growth — it shows up as a multiple.
   */
  const lo = Math.min(...rows.map((r) => r.tokens));
  const hi = Math.max(...rows.map((r) => r.tokens));
  assert.ok(
    hi <= lo * 1.02,
    `across ${SATURATED[0]}–${SATURATED[SATURATED.length - 1]} files the map ranged ${lo}–${hi} tokens `
    + `(${(hi / lo).toFixed(3)}×). Past saturation the cost must be FLAT: something is now rendered per file `
    + 'without a budget cut, which is the exact economics of the `gatherWorkspaceContext` pre-read this module '
    + 'was written to delete.',
  );
});

test('⭐ a SMALL repository is not charged the ceiling — you pay for what you have, then you stop paying', () => {
  /**
   * ⚠️ THE OTHER HALF, AND IT IS THE ONE MY FIRST DRAFT WOULD HAVE BROKEN. A
   * "cost is always identical" rule is satisfied just as well by padding every
   * map to 9,000 tokens. It must be cheaper to map a small repo, or the ceiling
   * has quietly become a floor.
   */
  const m = mapAt(FITS);
  assert.equal(m.truncated, false, `${FITS} files should fit inside ${DEFAULT_BUDGET_TOKENS} tokens whole`);
  assert.ok(
    m.stats.tokensEstimated < DEFAULT_BUDGET_TOKENS * 0.5,
    `a ${FITS}-file repo cost ${m.stats.tokensEstimated} of a ${DEFAULT_BUDGET_TOKENS} budget. It fits entirely, `
    + 'so it should cost a fraction of the ceiling — a budget that is always fully spent is a floor, not a budget.',
  );
});

test('⭐ growth is absorbed by listing a SMALLER FRACTION of the repo — the honest trade, stated', () => {
  const small = mapAt(FITS);
  const large = mapAt(5_000);

  // The small tree fits whole; the large one cannot and must say so.
  assert.equal(small.truncated, false, 'a 100-file repo fits inside 9,000 tokens and must not claim truncation');
  assert.equal(large.truncated, true, 'a 5,000-file repo cannot fit in 9,000 tokens — it must admit that, not imply completeness');

  assert.ok(
    large.stats.listedFiles < large.stats.totalFiles,
    'the large map claims to list every file of a tree that cannot fit',
  );
  assert.ok(
    large.stats.omittedFiles > 0 && large.text.includes(String(large.stats.totalFiles)),
    'HONEST TRUNCATION (property 2 in the module header): the map must state the TOTAL, so a model knows '
    + 'what it cannot see. A truncated list that does not say it is truncated reads as proof of absence.',
  );
});

// ── 2. ⚠️ DETERMINISM *IN THE REGIME WHERE THE BUDGET BINDS* ─────────────────

test('⚠️⚠️ the map is byte-identical across rebuilds AT EVERY SIZE — including where truncation decides the contents', () => {
  /**
   * ⭐ WHY THIS IS NOT A DUPLICATE OF THE SIBLING DETERMINISM TESTS. Those build
   * trees that FIT. When nothing is cut, determinism is nearly free — the output
   * is every file, in a sorted order. The interesting case is when the budget
   * bites, because then the output is decided by the RANKER and the breadth
   * sample, and a float that lands differently changes which files survive.
   * repo-map.test.mjs says this in its own words at line ~781: determinism that
   * "survives only while nothing is capped … is backwards".
   */
  for (const n of SIZES) {
    const shas = [];
    for (let run = 0; run < 3; run++) {
      const m = mapAt(n);
      shas.push(createHash('sha256').update(m.text).digest('hex'));
    }
    assert.equal(
      new Set(shas).size, 1,
      `three builds of the same ${n}-file tree produced ${new Set(shas).size} different maps. `
      + 'A map that reshuffles between runs voids the cached prompt prefix, which is the entire reason this '
      + 'module sorts by code point and quantises its ranks.',
    );
  }
});

test('⭐ the ranker converges in the same number of rounds every time — a constant tolerance makes the round count itself a determinism check', () => {
  /**
   * `RANK_TOLERANCE` is a constant and there is no clock in the iteration, so
   * "how many rounds did it take" is a pure function of the tree. If this ever
   * varies, a float sum has become order-dependent — and that is the failure
   * that silently costs the cache discount long before anyone notices the map
   * looks different.
   */
  for (const n of [100, 1_000]) {
    const runs = [0, 1, 2].map(() => mapAt(n).stats.rankIterations);
    assert.equal(new Set(runs).size, 1, `the power iteration took ${runs.join('/')} rounds on identical ${n}-file trees`);
    assert.ok(runs[0] > 0, 'the ranker did not run at all — the fixture has no symbol graph and this suite is testing nothing');
  }
});

// ── 3. ⭐ THE ESTIMATE IS THE NUMBER THE BUDGET IS ENFORCED IN ───────────────

test('⚠️ `tokensEstimated` is the REAL cost of the rendered text, not a number kept in a separate variable', () => {
  /**
   * ⚠️ THE FAILURE THIS CATCHES IS THE ONE THAT WOULD MAKE EVERY OTHER TEST HERE
   * MEANINGLESS: a truncator that measures one string and returns another. Every
   * budget assertion in this file reads `stats.tokensEstimated`; if that number
   * is not derived from `map.text`, they all pass while the prompt overruns.
   */
  for (const n of SIZES) {
    const m = mapAt(n);
    assert.equal(
      m.stats.tokensEstimated, estimateTokens(m.text),
      `at ${n} files the map REPORTS ${m.stats.tokensEstimated} tokens but its text actually estimates at `
      + `${estimateTokens(m.text)}. The budget is enforced against the reported number, so a gap here is a `
      + 'budget that is not enforced at all.',
    );
  }
});

test('⭐ no timestamp, no age, no absolute path reaches the rendered map — every one of those changes between runs', () => {
  /**
   * The module header promises "no timestamps and no rendered ages anywhere in
   * the output". A single "3 minutes ago" would defeat the cache on every run
   * while every determinism test above still passed, because those build the
   * three maps within the same millisecond.
   */
  const text = mapAt(1_000).text;
  const year = String(new Date().getFullYear());
  for (const forbidden of [year, 'ago', 'GMT', 'T00:', 'Z\n', '/synthetic/']) {
    assert.ok(
      !text.includes(forbidden),
      `the rendered map contains ${JSON.stringify(forbidden)}. Anything derived from the clock or from an `
      + 'absolute path differs between two runs (or two machines) and silently voids the prompt cache.',
    );
  }
});

// ── 4. ⭐ AND THE SAME CONCLUSION, ON A REAL TREE ON DISK ────────────────────

test('⭐ the shipped default holds on this package\'s own real tree — a fixture proves a fixture', () => {
  /**
   * ⚠️ BOUND TO A CEILING, NEVER TO A FILE COUNT OR A HASH. `acuvo-code` gains
   * files every day; asserting "545 files, sha abc…" would go red on somebody
   * else's correct work, which this repo has paid for four separate times. The
   * only claim made here is the one that must never break: whatever this package
   * grows into, its map fits the budget.
   */
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const m = buildRepoMap(root, {}, {});
  assert.equal(m.ok, true, `the map could not be built over this package: ${m.error}`);
  assert.ok(m.stats.totalFiles > 100, 'this package should have hundreds of files — the walk found almost none, so the test is vacuous');
  assert.ok(
    m.stats.tokensEstimated <= DEFAULT_BUDGET_TOKENS,
    `this package's own map costs ${m.stats.tokensEstimated} tokens against a ${DEFAULT_BUDGET_TOKENS} ceiling`,
  );
  // Measured 2026-08-26: 545 files, 12/12 directories, 8,598 tokens.
  assert.equal(m.stats.dirsListed, m.stats.dirsTotal,
    'every directory in this package should still be represented — the breadth sample exists so that reach '
    + 'survives a tight budget, and losing it is the "depth cliff" regression by another route');
});
