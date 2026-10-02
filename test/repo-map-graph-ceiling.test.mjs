/**
 * ── WHAT THIS SUITE IS GUARDING, AND WHY IT DID NOT EXIST BEFORE ────────────
 *
 * `repo-map.mjs` ranks the whole map with personalized PageRank over a symbol
 * graph. That graph is built by reading files, reads are not free, so there is a
 * ceiling on how many get read — `DEFAULT_MAX_SYMBOL_READS`, 800.
 *
 * ⚠️⚠️ ON EVERY TREE WE ACTUALLY OWN, THAT CEILING NEVER BINDS, WHICH IS EXACTLY
 * WHY IT WAS NEVER TESTED. Measured 2026-08-26 with the module's own walk:
 *
 *     tree                     files   symbol-eligible   in the graph   coverage
 *     acuvo-code (this one)      545               459            459     100.0%
 *     console/                 2,854             2,470            800      32.4%
 *     the enclosing worktree   9,649             6,393            800      12.5%
 *
 * And the map is byte-identical at every ceiling on `acuvo-code` (sha
 * `35e1a8e8a0c5` at 800, 2,000 and 8,000) while `console/` and the worktree
 * produce a DIFFERENT map at each one. So the entire capped regime — the one
 * every customer repository lives in — was invisible to the suite.
 *
 * ⚠️ AND IT WAS NOT MERELY UNTESTED, IT WAS UNREACHABLE. The ceiling was a
 * module-private constant, so no test could lower it, and the largest fixture
 * anywhere in the repo-map tests is 2,000 files whose contents are the single
 * character `x` — no exports, no identifiers, an EMPTY graph. Reaching the cliff
 * meant writing an 800-file fixture with real cross-references on every run.
 * `opts.maxSymbolReads` makes it a twelve-file fixture instead, which is the
 * whole reason it was made injectable.
 *
 * ── THE FOUR PROPERTIES PINNED HERE ─────────────────────────────────────────
 *
 *   1. ⚠️⚠️ DETERMINISM SURVIVES THE CAP. This is the one that outranks the
 *      feature everywhere in this module: the map rides the cached prompt prefix
 *      and a map that reshuffles voids it. A cap makes determinism HARDER, not
 *      easier — it introduces a cliff, and which files fall off it must be a
 *      function of the tree and nothing else. The sibling suites prove byte
 *      identity only in the uncapped regime.
 *   2. ⭐ THE CEILING CAPS READS, NOT SLOTS. It used to `slice(0, 800)` and only
 *      then test eligibility, so a `.css` file or a 900KB bundle spent a slot and
 *      returned nothing — measured at 41 wasted slots on `console/` and 63 on the
 *      worktree, a ceiling quietly delivering 737–759 where it promised 800.
 *   3. ⭐ THE RECEIPTS ARE HONEST. `graphFiles` / `graphFilesTotal` /
 *      `graphCapped` have to mean what they say, including when reads FAIL.
 *   4. ⚠️ AND THEY NEVER REACH THE PROMPT. Same rule `rankEdges` already follows.
 *      A number rendered into the map is a file line the budget can no longer
 *      afford, and `renderMap`'s header records that trap with a measurement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRepoMap,
  DEFAULT_MAX_SYMBOL_READS,
} from '../lib/repo-map.mjs';

/**
 * The same in-memory filesystem the sibling suites use, kept byte-compatible
 * with them on purpose — a second idea about what a fixture filesystem is would
 * be the same class of bug `repo-map.mjs` warns about for `SKIP_DIRS`.
 *
 * ⚠️ `order: 'reverse'` IS THE DEFAULT HERE TOO. A fixture that hands entries
 * back in sorted order cannot catch a module that inherited `readdir`'s order,
 * because sorted is the answer it was supposed to compute.
 */
function makeFs(files, { order = 'reverse' } = {}) {
  const norm = new Map();
  for (const [p, v] of Object.entries(files)) {
    norm.set(p, typeof v === 'string'
      ? { content: v, mtimeMs: 0 }
      : { content: v.content ?? '', mtimeMs: v.mtimeMs ?? 0, size: v.size });
  }
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
      if (order === 'sorted') out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return out;
    },
    statImpl: (rel) => {
      if (norm.has(rel)) {
        const f = norm.get(rel);
        return { size: f.size ?? Buffer.byteLength(f.content, 'utf8'), mtimeMs: f.mtimeMs, dir: false };
      }
      if (dirs.has(rel)) return { size: 0, mtimeMs: 0, dir: true };
      return null;
    },
    readFileImpl: (rel) => (norm.has(rel) ? norm.get(rel).content : null),
  };
}

/**
 * A repository big enough that a LOWERED ceiling bites, with a real, uneven
 * reference graph so the ranking has something to rank: 8 packages of 10
 * modules, each part importing two hubs chosen by arithmetic, so some hubs are
 * referenced twice and some sixteen times.
 *
 * ⭐ 88 SOURCE FILES, NOT 800. The point of the injectable ceiling is that the
 * capped regime no longer costs an 800-file fixture to reach — the cliff is a
 * property of `eligible > cap`, not of the number 800, so a cap of 20 over 88
 * files exercises exactly the same code path as 800 over 6,393.
 */
function bigGraphFixture() {
  const files = { 'package.json': '{"name":"capped","main":"./pkg0/hub.mjs"}' };
  for (let p = 0; p < 8; p++) {
    files[`pkg${p}/hub.mjs`] = `export function hub${p}Thing() { return ${p}; }\n`;
    for (let f = 0; f < 10; f++) {
      const a = (p * 3 + f) % 8;
      const b = (p + f * 5) % 8;
      files[`pkg${p}/part${String(f).padStart(2, '0')}.mjs`] = [
        `import { hub${a}Thing } from '../pkg${a}/hub.mjs';`,
        `import { hub${b}Thing } from '../pkg${b}/hub.mjs';`,
        `export function part${p}_${f}() { return hub${a}Thing() + hub${b}Thing(); }`,
        '',
      ].join('\n');
    }
  }
  return files;
}

// ── 1. ⚠️⚠️ DETERMINISM, IN THE REGIME NOTHING ELSE COVERS ───────────────────

test('⚠️⚠️ the map is byte-identical across runs WHEN THE SYMBOL CEILING BINDS', () => {
  const files = bigGraphFixture();
  const runs = [0, 1, 2].map(() => buildRepoMap('/repo', makeFs(files), {
    budgetTokens: 4_000,
    maxSymbolReads: 20,
  }));
  assert.equal(runs[0].stats.graphCapped, true,
    'the fixture no longer trips the ceiling — this suite is asserting nothing');
  assert.equal(runs[1].text, runs[0].text, 'the map reshuffled between runs while capped — the prompt cache is dead');
  assert.equal(runs[2].text, runs[1].text, 'the map reshuffled between runs while capped — the prompt cache is dead');
});

test('⚠️⚠️ a hostile readdir order cannot change WHICH files fall off the ceiling', () => {
  const files = bigGraphFixture();
  const opts = { budgetTokens: 4_000, maxSymbolReads: 20 };
  const forward = buildRepoMap('/repo', makeFs(files, { order: 'sorted' }), opts);
  const backward = buildRepoMap('/repo', makeFs(files, { order: 'reverse' }), opts);
  assert.equal(forward.stats.graphCapped, true);
  assert.equal(forward.stats.graphFiles, backward.stats.graphFiles,
    'the ceiling admitted a different NUMBER of files depending on readdir order');
  assert.equal(forward.text, backward.text,
    'the capped graph inherited readdir order, so the map reshuffles run to run and the cached prefix is destroyed');
});

/**
 * ⚠️ THE CAP MUST NOT LEAK THE TASK INTO THE GRAPH. The invariant tranche of the
 * map is chosen by a ranking that never sees the user's words — that is the
 * whole cross-task cache saving `repo-map-cross-task-prefix.test.mjs` defends.
 * If the CEILING were applied after any task-aware ordering, the graph itself
 * would become task-dependent and every downstream guarantee would go with it.
 */
test('⚠️⚠️ the capped graph is the SAME graph for two different tasks', () => {
  const files = bigGraphFixture();
  const opts = { budgetTokens: 4_000, maxSymbolReads: 20 };
  const a = buildRepoMap('/repo', makeFs(files), { ...opts, task: 'fix hub3Thing in pkg3/hub.mjs' });
  const b = buildRepoMap('/repo', makeFs(files), { ...opts, task: 'rewrite part7_2 in pkg7/part02.mjs' });
  assert.ok(a.stats.rankSeeds > 0 && b.stats.rankSeeds > 0, 'neither task seeded — the comparison is vacuous');
  assert.equal(a.stats.graphFiles, b.stats.graphFiles,
    'the symbol graph changed size with the question — the ceiling is reading task-ranked files');
  assert.equal(a.stats.rankEdges, b.stats.rankEdges,
    'the symbol graph changed shape with the question — the invariant tranche cannot be invariant');
});

// ── 2. ⭐ THE CEILING CAPS READS, NOT SLOTS ──────────────────────────────────

/**
 * ⚠️⚠️ THIS IS THE REGRESSION GUARD FOR A MEASURED DEFECT, NOT A HYPOTHETICAL.
 * The loop used to slice the baseline to the ceiling and only THEN test
 * `SYMBOL_EXT` and the size limit. Ineligible files sort into the same
 * high-priority band as source (`SOURCE_EXT` covers `.css`, `.scss`, `.html`,
 * `.sql`, `.sh`, `.vue`, `.svelte`), so they landed inside the window and spent
 * slots that returned nothing. Measured on the real trees: 41 slots burned on
 * `console/` (759 of a promised 800) and 63 on the enclosing worktree (737).
 */
test('⭐ files that can never yield a symbol do not consume a slot in the ceiling', () => {
  const files = {};
  // 30 stylesheets that sort BEFORE the source files and are `SOURCE_EXT`, so
  // they sit in the same priority band and would have eaten the whole window.
  for (let i = 0; i < 30; i++) files[`a-styles/s${String(i).padStart(2, '0')}.css`] = `.c${i} { color: red; }\n`;
  for (let i = 0; i < 10; i++) files[`z-src/m${String(i).padStart(2, '0')}.mjs`] = `export function thing${i}() { return ${i}; }\n`;

  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4_000, maxSymbolReads: 10 });

  assert.equal(map.stats.graphFilesTotal, 10, 'only the 10 .mjs files are symbol-eligible');
  assert.equal(map.stats.graphFiles, 10,
    `the ceiling delivered ${map.stats.graphFiles} of the 10 files it promised — ineligible files are eating slots again`);
  const withSymbols = map.files.filter((f) => f.symbols).length;
  assert.equal(withSymbols, 10, `only ${withSymbols} of 10 source files got symbols`);
});

test('⭐ a file above the per-file size limit does not consume a slot either', () => {
  const files = {};
  // `size` is honoured by the fixture's statImpl, so this is a 1MB file that
  // costs nothing to declare — the same shape as a generated bundle in a repo.
  for (let i = 0; i < 5; i++) {
    files[`a-huge/big${i}.mjs`] = { content: `export function big${i}() {}\n`, size: 1024 * 1024 };
  }
  for (let i = 0; i < 5; i++) files[`z-src/s${i}.mjs`] = `export function small${i}() { return ${i}; }\n`;

  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4_000, maxSymbolReads: 5 });

  assert.equal(map.stats.graphFilesTotal, 5, 'the oversized files should not even be counted as eligible');
  assert.equal(map.stats.graphFiles, 5,
    'an oversized file consumed a slot in the ceiling — the promised read count is not being delivered');
  assert.equal(map.files.filter((f) => f.symbols).length, 5);
});

/**
 * ⚠️⚠️ THE CEILING IS FOR GENERATED BUNDLES, AND IT CAUGHT THE CORE MODULE.
 *
 * On 2026-09-26 `lib/turn.mjs` grew past 512 KiB (524,521 bytes at acb00a83f;
 * ~539KB in a CRLF checkout). It silently left the symbol graph, scored 0, and
 * ranked LAST of 175 lib files — so the map of this repo stopped naming the
 * agent loop at all. A hand-written module in the 500–700KB band is real
 * source; the bundles the ceiling exists for are the 900KB–1MB+ shape above.
 */
test('⭐ a large HAND-WRITTEN module (~600KB) stays in the symbol graph', () => {
  const files = {
    'lib/core.mjs': { content: 'export function runSession() {}\n', size: 600 * 1024 },
    'lib/leaf.mjs': 'export const unused = 1;\n',
  };
  for (let i = 0; i < 4; i++) files[`lib/caller${i}.mjs`] = `import { runSession } from './core.mjs';\nrunSession();\n`;
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4_000 });
  const core = map.files.find((f) => f.path === 'lib/core.mjs');
  assert.ok(core?.symbols?.includes('runSession'),
    'a 600KB source file was dropped from the symbol graph — the bundle ceiling is catching real modules');
});

// ── 3. ⭐ THE RECEIPTS ARE HONEST ────────────────────────────────────────────

test('⭐ graphCapped is true exactly when eligible files outnumber the ceiling', () => {
  const files = bigGraphFixture();
  const under = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4_000, maxSymbolReads: 10_000 });
  assert.equal(under.stats.graphCapped, false, 'a ceiling nothing reaches reported itself as binding');
  assert.equal(under.stats.graphFiles, under.stats.graphFilesTotal,
    'an uncapped run left files out of the graph');

  const over = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4_000, maxSymbolReads: 20 });
  assert.equal(over.stats.graphCapped, true);
  assert.equal(over.stats.graphFiles, 20, 'the capped run did not read exactly the ceiling');
  assert.ok(over.stats.graphFilesTotal > over.stats.graphFiles,
    'graphFilesTotal must count the whole eligible set, not the admitted one');
});

/**
 * ⚠️ A RECEIPT THAT COUNTS ATTEMPTS IS A RECEIPT THAT LIES. On a tree where
 * every read fails — a permissions problem, a racing checkout — counting the
 * slice rather than the successful reads would report a complete symbol graph
 * over an empty one, which is the precise failure the receipt exists to expose.
 */
test('⚠️ graphFiles counts reads that SUCCEEDED, not slots that were attempted', () => {
  const files = bigGraphFixture();
  const io = makeFs(files);
  const blind = {
    ...io,
    // Everything the walk needs still works; only the content read fails, which
    // is exactly how an unreadable file presents.
    readFileImpl: (rel) => (rel === 'package.json' ? io.readFileImpl(rel) : null),
  };
  const map = buildRepoMap('/repo', blind, { budgetTokens: 4_000, maxSymbolReads: 20 });
  assert.equal(map.stats.graphFiles, 0,
    'unreadable files were counted into the symbol graph — the receipt reports coverage it does not have');
  assert.equal(map.stats.rankEdges, 0, 'edges appeared without a single readable file');
  assert.ok(map.stats.graphFilesTotal > 0, 'eligibility is a property of the path and size, so it survives a failed read');
  assert.equal(map.ok, true, 'a repo whose files cannot be read must still get a map — the pre-read is an optimisation');
});

// ── 4. ⚠️ AND NONE OF IT REACHES THE PROMPT ──────────────────────────────────

/**
 * ⚠️⚠️ THE HONEST INSTINCT IS TO PRINT THIS, AND IT IS THE WRONG ONE TWICE.
 * "the symbol graph covered 800 of 6,393 files" is an OPERATOR fact the model
 * cannot act on, and `renderMap`'s header records the measurement that settles
 * it: a fixed byte of prose is a file line the budget can no longer afford — 61
 * bytes once bought the deepest directory band out of a fixture. `rankEdges`,
 * `rankSeeds` and `rankIterations` set the precedent; this follows it.
 */
test('⚠️ the graph receipts live in stats and never in the map text', () => {
  const files = bigGraphFixture();
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4_000, maxSymbolReads: 20 });
  assert.equal(map.stats.graphCapped, true);
  for (const word of ['graphFiles', 'graphCapped', 'symbol graph', 'ceiling']) {
    assert.ok(!map.text.includes(word), `"${word}" reached the prompt — the receipts are stats-only`);
  }
  // The counts themselves must not appear as a rendered claim either.
  assert.ok(!/\b20 of \d+\b/.test(map.text), 'a graph-coverage sentence was rendered into the map');
});

// ── 5. ⚠️ AND THE DEFAULT IS UNCHANGED ───────────────────────────────────────

/**
 * ⚠️ THIS IS A COST CONTROL, NOT TRIVIA. Raising the ceiling is a wall-clock
 * decision: measured 2026-08-26, the enclosing worktree builds its map in
 * 2,693ms at 800 and 8,745ms with the ceiling lifted (3.2x), and `console/` goes
 * 882ms → 1,911ms. The CLI pays that on every invocation. If someone raises the
 * default they should have to change this line and read that number first.
 */
test('⚠️ the shipped ceiling is still 800 — raising it is a 3.2x wall-clock decision', () => {
  assert.equal(DEFAULT_MAX_SYMBOL_READS, 800);
  const files = bigGraphFixture();
  const explicit = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4_000, maxSymbolReads: DEFAULT_MAX_SYMBOL_READS });
  const implicit = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4_000 });
  assert.equal(implicit.text, explicit.text, 'the default no longer matches DEFAULT_MAX_SYMBOL_READS');
});

/**
 * ⚠️ THE OPTION MUST BE READABLE FROM THE SECOND ARGUMENT TOO. `budgetTokens`
 * and `maxEntries` both tolerate being folded into `impls`, because a caller who
 * writes `buildRepoMap(root, { maxSymbolReads: 20 })` means something obvious
 * and refusing it would fail correct work. An option honoured in only one of the
 * two positions is the kind of half-wiring this package has shipped before.
 */
test('⚠️ maxSymbolReads is honoured whether it arrives as opts or folded into impls', () => {
  const files = bigGraphFixture();
  const viaOpts = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4_000, maxSymbolReads: 20 });
  const viaImpls = buildRepoMap('/repo', { ...makeFs(files), budgetTokens: 4_000, maxSymbolReads: 20 });
  assert.equal(viaOpts.stats.graphFiles, 20);
  assert.equal(viaImpls.stats.graphFiles, 20, 'the option was ignored when folded into the second argument');
  assert.equal(viaImpls.text, viaOpts.text);
});
