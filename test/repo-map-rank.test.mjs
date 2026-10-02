/**
 * ── WHAT THIS SUITE IS GUARDING ─────────────────────────────────────────────
 *
 * `repo-map.mjs` opens by indicting the old pre-read for listing files in
 * ALPHABETICAL order, because "alphabetical order is not relevance order". It
 * was right — and then every ordering decision in the module was settled by
 * `byCodePoint` on the PATH, which is alphabetical order wearing a hat.
 *
 * The replacement is personalized PageRank over the symbol graph (nodes are
 * files, edges run reference → definition), reimplemented in JS from Aider's
 * published description. Two properties are load-bearing and they pull in
 * OPPOSITE directions, which is why both are tested here:
 *
 *   1. ⚠️⚠️ DETERMINISM OUTRANKS THE FEATURE. The map sits in the cached prompt
 *      prefix and prefix stability is worth 3.05x. A ranker that reshuffles by
 *      one float on a rebuild is worse than no ranker at all, so: fixed
 *      iteration bound, constant tolerance, code-point node ids, edges summed
 *      in a fixed order, scores quantised before comparison. The tests below
 *      prove byte-identity ACROSS PROCESSES, not just inside one.
 *   2. ⭐ RELEVANCE HAS TO ACTUALLY IMPROVE. A deterministic ranking that is no
 *      better than alphabetical is a deterministic waste of 900ms. So there are
 *      tests that a referenced file outranks an unreferenced one, and that
 *      naming a file in the task pulls it and its neighbourhood into a budget
 *      too tight to hold them otherwise.
 *
 * ⚠️ AND THE CHECKS MUST PASS CORRECT WORK. With no graph and no mentions every
 * score ties and the ordering must fall through to exactly the comparator that
 * shipped before ranking existed — asserted, because "additive" is a claim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  buildRepoMap,
  orderForBudget,
  rankFiles,
  parseMentions,
  extractIdentifiers,
  normaliseMentions,
  RANK_DAMPING,
  RANK_MAX_ITERATIONS,
  RANK_TOLERANCE,
} from '../lib/repo-map.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The same in-memory filesystem the sibling suite uses. */
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

const listedPaths = (map) => map.files.map((f) => f.path);

/**
 * A generated repository with a REAL, uneven import graph: 12 packages of 12
 * modules, each importing from its own package's hub and from two hubs chosen
 * by arithmetic — so some hubs are referenced twice and some twenty times, and
 * the ranking has something to actually rank. ~150 files, hundreds of edges,
 * and not one byte of it can be changed by another test running in parallel.
 */
function writeSyntheticRepo(root) {
  writeFileSync(join(root, 'package.json'), '{"name":"synthetic","main":"./pkg/mod00/index.mjs"}', 'utf8');
  for (let p = 0; p < 12; p++) {
    const pkg = join(root, 'pkg', `mod${String(p).padStart(2, '0')}`);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'index.mjs'), `export function hub${String(p).padStart(2, '0')}Thing() { return ${p}; }\n`, 'utf8');
    for (let f = 0; f < 12; f++) {
      const a = String((p * 7 + f) % 12).padStart(2, '0');
      const b = String((p + f * 5) % 12).padStart(2, '0');
      writeFileSync(join(pkg, `part${String(f).padStart(2, '0')}.mjs`), [
        `import { hub${a}Thing } from '../mod${a}/index.mjs';`,
        `import { hub${b}Thing } from '../mod${b}/index.mjs';`,
        `export function part${p}_${f}() { return hub${a}Thing() + hub${b}Thing(); }`,
        '',
      ].join('\n'), 'utf8');
    }
  }
}

/**
 * A tiny repo with a REAL dependency shape: `lib/core.mjs` is imported by three
 * modules, `lib/orphan.mjs` by nobody, and the alphabet is against the popular
 * one — `core` sorts after `alpha` and `beta`, so any improvement here cannot
 * be alphabetical order getting lucky.
 */
function graphFixture() {
  return {
    'lib/alpha.mjs': "import { coreThing } from './core.mjs';\nexport function alphaRun() { return coreThing(); }\n",
    'lib/beta.mjs': "import { coreThing } from './core.mjs';\nexport function betaRun() { return coreThing(); }\n",
    'lib/gamma.mjs': "import { coreThing } from './core.mjs';\nexport const gammaValue = coreThing();\n",
    'lib/core.mjs': 'export function coreThing() { return 1; }\n',
    'lib/orphan.mjs': 'export function orphanThing() { return 2; }\n',
  };
}

// ── 1. DETERMINISM — THE INVARIANT THAT OUTRANKS THE FEATURE ────────────────

test('⚠️⚠️ three runs over an identical tree are BYTE-IDENTICAL — a reshuffled map is a dead prompt cache', () => {
  const files = graphFixture();
  const runs = [0, 1, 2].map(() => buildRepoMap('/repo', makeFs(files), {
    budgetTokens: 400,
    task: 'fix coreThing in lib/core.mjs',
  }));
  assert.equal(runs[0].text, runs[1].text);
  assert.equal(runs[1].text, runs[2].text);
  assert.deepEqual(listedPaths(runs[0]), listedPaths(runs[2]));
});

test('⚠️⚠️ the map is byte-identical ACROSS PROCESSES on a real tree on disk — the only proof that survives a rebuild', () => {
  /**
   * ⭐ IN-PROCESS REPETITION IS THE WEAK VERSION OF THIS TEST. Three calls in
   * one process share a warm heap, the same Map insertion histories and the
   * same JIT state; a determinism bug that comes from any of those would pass.
   * The cache this protects is compared between SEPARATE `acuvo` invocations,
   * so this spawns separate processes, over a real directory on disk, with a
   * real float graph of hundreds of edges rather than a fixture's five.
   *
   * ⚠️ AND IT MAPS A GENERATED TREE, NOT THIS CHECKOUT. Pointing it at the repo
   * itself was measurably flaky: the suite runs in parallel and other tests
   * create files inside the tree, so two subprocesses seconds apart were
   * legitimately mapping DIFFERENT repositories and the failure said
   * "non-deterministic". A determinism test whose input can change underneath it
   * is not testing determinism.
   */
  /**
   * ⚠️⚠️ THE FIRST DRAFT OF THIS TEST PASSED WITHOUT MEASURING ANYTHING. It read
   * the root from `process.argv[2]`, which under `node --eval` is the SECOND
   * user argument and was therefore `undefined`. `buildRepoMap` refuses an
   * unreadable root by returning `text: ''`, three empty strings hash
   * identically, and the shape assertion `/^[0-9a-f]{64} \d+ \d+$/` matched the
   * sha256 of "" followed by `0 0`. Green, three times, over nothing.
   *
   * ⭐ THE FIX IS THE ASSERTION, NOT ONLY THE ARGUMENT. The root is embedded in
   * the script now, and the digest line carries the LISTED FILE COUNT so the
   * test cannot agree with itself about an empty map ever again.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-rank-determinism-'));
  let first;
  let second;
  let third;
  let listed;
  let edges;
  let iterations;
  try {
    writeSyntheticRepo(dir);
    const script = [
      'import { buildRepoMap } from ' + JSON.stringify(new URL('../lib/repo-map.mjs', import.meta.url).href) + ';',
      'import { createHash } from "node:crypto";',
      /**
       * ⚠️ THE BUDGET IS TIGHT ON PURPOSE. On a tree that FITS, the FILES
       * section renders in path order whatever the ranking decided, so the text
       * is identical however the ranker behaves — and hashing it would prove
       * nothing about the ranker at all. Only a truncated map lets the rank
       * order reach the bytes, which is the thing this test has to watch.
       */
      /**
       * ⚠️ 900 → 1,100 (2026-08-25). The map now spends a fixed share of the
       * budget on a separate task-varying block plus its heading, so 900 tokens
       * listed 97 files and the guard below demands >100 — a guard about the
       * subprocess actually mapping a repo, not about any particular number.
       * The budget is raised to keep that guard meaningful; `m.truncated` is
       * still asserted, so the ranking still reaches the bytes.
       */
      /**
       * ⚠️ 1,100 → 1,500 (2026-08-29), THE SAME DRIFT AS THE 900 → 1,100 ABOVE
       * AND FOR THE SAME KIND OF REASON. The allocator now withholds
       * `SYMBOL_RESERVE_SHARE` of the static budget from the PATH fit, so a
       * fixed token budget buys fewer paths and more symbol lists; at 1,100 the
       * subprocess listed 96 files and the >100 guard below — which exists only
       * to prove the subprocess mapped a real repository rather than an empty
       * string — stopped being about that. `m.truncated` is still asserted, so
       * the ranking still reaches the bytes and this test still watches it.
       */
      'const m = buildRepoMap(' + JSON.stringify(dir) + ', {}, { budgetTokens: 1500, task: "fix hub07Thing in pkg/mod07/index.mjs" });',
      'if (!m.truncated) throw new Error("fixture drift: the map fits the budget, so the ranking never reaches the text");',
      'process.stdout.write([createHash("sha256").update(m.text).digest("hex"), m.stats.listedFiles, m.stats.rankIterations, m.stats.rankEdges].join(" "));',
    ].join('\n');
    const run = () => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    first = run();
    second = run();
    third = run();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  [, listed, iterations, edges] = first.split(' ').map((x, i) => (i === 0 ? x : Number(x)));
  assert.ok(listed > 100, `the subprocess mapped ${listed} files — it is hashing an empty map, not a repo`);
  assert.ok(edges > 100, `the subprocess found ${edges} edges — the graph is not being built in a fresh process`);
  assert.ok(iterations > 0);

  assert.equal(first, second, `two processes produced different maps:\n${first}\n${second}`);
  assert.equal(second, third);
  /**
   * ⚠️ THE ITERATION COUNT IS IN THE DIGEST LINE ON PURPOSE. The tolerance is a
   * CONSTANT, so the same tree must converge in the same number of rounds; a
   * count that wandered would mean the float path itself is not reproducible,
   * even if the quantiser happened to hide it in the ordering this time.
   */
  assert.match(first, /^[0-9a-f]{64} \d+ \d+ \d+$/);
});

test('⚠️ ranking cannot inherit readdir order — a hostile filesystem produces the same map', () => {
  const files = graphFixture();
  const forward = buildRepoMap('/repo', makeFs(files, { order: 'sorted' }), { budgetTokens: 300, task: 'coreThing' });
  const backward = buildRepoMap('/repo', makeFs(files, { order: 'reverse' }), { budgetTokens: 300, task: 'coreThing' });
  assert.equal(forward.text, backward.text);
});

test('⚠️ rankFiles does not depend on the order its inputs are handed to it', () => {
  const definitions = new Map([
    ['lib/core.mjs', ['coreThing']],
    ['lib/alpha.mjs', ['alphaRun']],
    ['lib/beta.mjs', ['betaRun']],
  ]);
  const references = new Map([
    ['lib/alpha.mjs', new Set(['coreThing'])],
    ['lib/beta.mjs', new Set(['coreThing', 'alphaRun'])],
    ['lib/core.mjs', new Set(['unrelated'])],
  ]);
  const paths = ['lib/core.mjs', 'lib/alpha.mjs', 'lib/beta.mjs', 'lib/orphan.mjs'];
  const a = rankFiles(paths, { definitions, references });
  const b = rankFiles([...paths].reverse(), { definitions, references });
  assert.deepEqual([...b.scores.entries()].sort(), [...a.scores.entries()].sort());
  assert.equal(a.iterations, b.iterations, 'the same graph converged in a different number of rounds');
});

test('⭐ the scores are QUANTISED — last-bit float noise must not be able to reorder two files', () => {
  const { scores } = rankFiles(['a.mjs', 'b.mjs'], {
    definitions: new Map([['a.mjs', ['thing']]]),
    references: new Map([['b.mjs', new Set(['thing'])]]),
  });
  for (const [path, score] of scores) {
    // A quantum of 1e-12 means every score survives a round-trip through it.
    assert.equal(score, Math.round(score * 1e12) / 1e12, `${path} carries un-quantised precision`);
  }
});

test('⚠️ the tuning constants are CONSTANTS, not knobs read from an environment', () => {
  assert.equal(RANK_DAMPING, 0.85);
  assert.ok(Number.isInteger(RANK_MAX_ITERATIONS) && RANK_MAX_ITERATIONS > 0);
  assert.ok(RANK_TOLERANCE > 0 && RANK_TOLERANCE < 1e-6);
  const src = readSource();
  assert.ok(!/process\.env/.test(src),
    'an env var reached the ranker — the map would then differ between two machines on the same tree');
});

function readSource() {
  return execFileSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))',
    join(REPO_ROOT, 'lib', 'repo-map.mjs')], { encoding: 'utf8' });
}

// ── 2. THE ORDERING IS ADDITIVE — CORRECT WORK MUST STILL PASS ──────────────

test('⚠️ A CHECK THAT FAILS CORRECT WORK: with no ranks, orderForBudget is the function that shipped before', () => {
  const files = [];
  for (const d of ['x', 'y', 'z']) for (const f of ['a.js', 'b.js', 'c.js']) files.push({ path: `${d}/${f}`, depth: 1 });
  const forward = orderForBudget(files).map((f) => f.path);
  const backward = orderForBudget([...files].reverse()).map((f) => f.path);
  assert.deepEqual(backward, forward);
  assert.deepEqual(forward.slice(0, 3), ['x/a.js', 'y/a.js', 'z/a.js'],
    'the breadth sample changed shape when no ranks were supplied at all');
});

test('⚠️ an empty rank map ties every file and changes nothing', () => {
  const files = [];
  for (const d of ['x', 'y']) for (const f of ['a.js', 'b.js']) files.push({ path: `${d}/${f}`, depth: 1 });
  assert.deepEqual(orderForBudget(files, new Set(), new Map()).map((f) => f.path),
    orderForBudget(files).map((f) => f.path));
});

test('a repo of pure prose — no symbols, no graph — is ordered exactly as it was', () => {
  const files = { 'README.md': '# hi', 'docs/a.md': 'a', 'docs/b.md': 'b', 'notes.txt': 'n' };
  const ranked = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4000 });
  const unranked = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4000, rank: false });
  assert.equal(ranked.text, unranked.text);
  assert.equal(ranked.stats.rankEdges, 0, 'a prose repo produced symbol-graph edges');
});

test('⭐ `rank: false` restores the old ordering exactly — the escape hatch is real, not decorative', () => {
  /**
   * ⚠️ ASSERTED ON A TRUNCATED TREE, because on a repo that fits, the FILES
   * section renders in path order either way and `rank: false` would "pass"
   * with the flag wired to nothing. The buried-target fixture is the one place
   * the flag can be seen to do something: with ranking ON the user's own words
   * pull `zzz-target.mjs` into the cut, and with it OFF they must not.
   */
  const files = { 'lib/zzz-target.mjs': 'export function targetThing() { return 1; }\n' };
  for (let i = 0; i < 60; i++) {
    files[`lib/aaa${String(i).padStart(2, '0')}.mjs`] = `export function filler${i}() {}\n`;
  }
  const task = 'please fix lib/zzz-target.mjs';
  const off = buildRepoMap('/repo', makeFs(files), { budgetTokens: 130, task, rank: false });
  const on = buildRepoMap('/repo', makeFs(files), { budgetTokens: 130, task });
  assert.equal(off.stats.rankEdges, 0);
  assert.equal(off.stats.rankIterations, 0);
  assert.equal(off.stats.rankSeeds, 0, 'the flag left the personalization running');
  assert.ok(listedPaths(on).includes('lib/zzz-target.mjs'));
  assert.ok(!listedPaths(off).includes('lib/zzz-target.mjs'),
    'rank:false still produced the ranked cut — the escape hatch is wired to nothing');
});

// ── 3. RELEVANCE — THE REASON TO DO ANY OF THIS ─────────────────────────────

test('⭐ a file THREE modules reference outranks one nobody references — and it sorts LATER alphabetically', () => {
  const { scores, edges } = rankFiles(Object.keys(graphFixture()), {
    definitions: new Map([
      ['lib/core.mjs', ['coreThing']],
      ['lib/alpha.mjs', ['alphaRun']],
      ['lib/beta.mjs', ['betaRun']],
      ['lib/gamma.mjs', ['gammaValue']],
      ['lib/orphan.mjs', ['orphanThing']],
    ]),
    references: new Map([
      ['lib/alpha.mjs', new Set(['coreThing'])],
      ['lib/beta.mjs', new Set(['coreThing'])],
      ['lib/gamma.mjs', new Set(['coreThing'])],
      ['lib/orphan.mjs', new Set(['nothing'])],
    ]),
  });
  assert.ok(edges >= 3, `the graph has no edges at all: ${edges}`);
  assert.ok(scores.get('lib/core.mjs') > scores.get('lib/orphan.mjs'),
    'the module three files depend on ranks no higher than the one nobody imports');
  assert.ok(scores.get('lib/core.mjs') > scores.get('lib/alpha.mjs'),
    'alphabetical order would put alpha first, and rank did not overturn it');
});

test('⭐ importance is RECURSIVE, not a reference count — rank flows from important referrers', () => {
  /**
   * `hub` and `quiet` are each referenced ONCE. A reference COUNT calls them
   * equal. PageRank does not: `hub`'s referrer is itself referenced by ten
   * files, so it has rank to pass on, and `quiet`'s referrer is a leaf.
   */
  const definitions = new Map([['hub.mjs', ['hubThing']], ['quiet.mjs', ['quietThing']],
    ['popular.mjs', ['popularThing']], ['leaf.mjs', ['leafThing']]]);
  const references = new Map([
    ['popular.mjs', new Set(['hubThing'])],
    ['leaf.mjs', new Set(['quietThing'])],
  ]);
  const paths = ['hub.mjs', 'quiet.mjs', 'popular.mjs', 'leaf.mjs'];
  for (let i = 0; i < 10; i++) {
    paths.push(`fan${i}.mjs`);
    references.set(`fan${i}.mjs`, new Set(['popularThing']));
  }
  const { scores } = rankFiles(paths, { definitions, references });
  assert.ok(scores.get('hub.mjs') > scores.get('quiet.mjs'),
    'both are referenced exactly once, so only the recursion can tell them apart — and it did not');
});

test('⭐⭐ NAMING A FILE PULLS IT INTO A BUDGET TOO TIGHT TO HOLD IT — this is what "personalized" means', () => {
  // 60 files that sort before `zzz-target.mjs`, so alphabetical order buries it.
  const files = { 'lib/zzz-target.mjs': 'export function targetThing() { return 1; }\n' };
  for (let i = 0; i < 60; i++) {
    files[`lib/aaa${String(i).padStart(2, '0')}.mjs`] = `export function filler${i}() {}\n`;
  }
  const blind = buildRepoMap('/repo', makeFs(files), { budgetTokens: 130 });
  const aimed = buildRepoMap('/repo', makeFs(files), { budgetTokens: 130, task: 'please fix lib/zzz-target.mjs' });
  assert.equal(blind.truncated, true, 'the fixture no longer truncates, so it proves nothing');
  assert.ok(!listedPaths(blind).includes('lib/zzz-target.mjs'),
    'fixture drift: the unaimed map already showed the target, so the aimed one cannot demonstrate anything');
  assert.ok(listedPaths(aimed).includes('lib/zzz-target.mjs'),
    'the user named the file in their own request and the map still could not afford to show it');
  assert.ok(aimed.stats.rankSeeds >= 1, 'the mention lit up no seed at all');
});

test('⭐ a file whose PATH contains a mentioned word is seeded too, more weakly than a named file', () => {
  const files = { 'lib/billing-gate.mjs': 'export function gate() {}\n', 'lib/other.mjs': 'export function other() {}\n' };
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4000, task: 'the billing logic is wrong' });
  assert.ok(map.stats.rankSeeds >= 1, 'the word "billing" matched no path');
});

test('a mention of a file that does not exist seeds nothing and does not throw', () => {
  const map = buildRepoMap('/repo', makeFs(graphFixture()), { budgetTokens: 4000, task: 'fix src/not-here.ts' });
  assert.equal(map.ok, true);
  assert.equal(map.stats.rankSeeds, 0);
  assert.equal(map.stats.listedFiles, 5);
});

// ── 4. THE PIECES, ON THEIR OWN ─────────────────────────────────────────────

test('parseMentions pulls the file names and the words out of a real sentence', () => {
  const { files, words } = parseMentions('the retry in lib/chain.mjs breaks callChain — see breaker.mjs');
  assert.ok(files.includes('lib/chain.mjs'), `missed the path: ${JSON.stringify(files)}`);
  assert.ok(files.includes('breaker.mjs'));
  assert.ok(words.includes('callChain'));
  /**
   * ⚠️ LANGUAGE KEYWORDS ARE DROPPED; ENGLISH FILLER IS NOT, AND THAT IS
   * DELIBERATE. `import`/`const`/`return` are syntax and would build false
   * edges against any file that happens to export a symbol of that name. "the"
   * is merely useless: it is under the 4-character floor for path matching, and
   * it can only weight an edge if some file genuinely exports a symbol called
   * `the`. Filtering the English language here would be a dictionary this
   * module has no business shipping.
   */
  for (const kw of ['import', 'const', 'return', 'function']) {
    assert.ok(!words.includes(kw), `${kw} is syntax and would seed a false edge`);
  }
  assert.ok(!words.includes('in'), 'a two-character word became a seed');
});

test('parseMentions is order-independent and total — an empty task yields empty lists', () => {
  assert.deepEqual(parseMentions(''), { files: [], words: [] });
  assert.deepEqual(parseMentions(undefined), { files: [], words: [] });
  assert.deepEqual(parseMentions(null), { files: [], words: [] });
  const a = parseMentions('fix a.mjs then b.mjs');
  const b = parseMentions('fix b.mjs then a.mjs');
  assert.deepEqual(a.files, b.files, 'the seed set depends on where in the sentence a name appears');
});

test('normaliseMentions merges the free-text task with explicit lists, deduped and sorted', () => {
  const m = normaliseMentions({ task: 'fix lib/a.mjs', mentionedFiles: ['lib/b.mjs', 'lib/a.mjs'], mentionedWords: ['zzz'] });
  assert.deepEqual(m.files, ['lib/a.mjs', 'lib/b.mjs']);
  assert.ok(m.words.includes('zzz'));
  assert.deepEqual(normaliseMentions({}), { files: [], words: [] });
  assert.deepEqual(normaliseMentions({ mentionedFiles: 'not-an-array' }).files, [],
    'a caller passing the wrong type poisoned the seed vector instead of being ignored');
});

test('extractIdentifiers returns words, drops keywords, and is bounded', () => {
  const ids = extractIdentifiers('import { coreThing } from "./core.mjs";\nexport const x = coreThing();\n');
  assert.ok(ids.has('coreThing'));
  for (const kw of ['import', 'from', 'export', 'const']) {
    assert.ok(!ids.has(kw), `${kw} is syntax, not a symbol, and would become a false edge`);
  }
  const huge = Array.from({ length: 5000 }, (_, i) => `name${i}`).join(' ');
  assert.ok(extractIdentifiers(huge).size <= 2000, 'a pathological file produced an unbounded identifier set');
  assert.equal(extractIdentifiers('').size, 0);
  assert.equal(extractIdentifiers(null).size, 0);
});

test('rankFiles is total — an empty repo, a graph with no edges, and a self-reference all return cleanly', () => {
  assert.equal(rankFiles([]).scores.size, 0);
  const flat = rankFiles(['a.mjs', 'b.mjs']);
  assert.equal(flat.edges, 0);
  assert.equal(flat.scores.get('a.mjs'), flat.scores.get('b.mjs'),
    'two files with no graph between them must tie, or the fallback ordering is not the old one');
  // A file that references its own export is not an edge; a self-loop would
  // hand a module its own rank back and inflate it forever.
  const selfish = rankFiles(['a.mjs'], {
    definitions: new Map([['a.mjs', ['thing']]]),
    references: new Map([['a.mjs', new Set(['thing'])]]),
  });
  assert.equal(selfish.edges, 0, 'a file referencing its own symbol created a self-loop');
});

test('⭐ the ranks sum to one — a leaking vector rescales every comparison silently', () => {
  const { scores } = rankFiles(Object.keys(graphFixture()), {
    definitions: new Map([['lib/core.mjs', ['coreThing']]]),
    references: new Map([
      ['lib/alpha.mjs', new Set(['coreThing'])],
      ['lib/beta.mjs', new Set(['coreThing'])],
    ]),
  });
  const total = [...scores.values()].reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `the rank vector sums to ${total} — dangling mass is being dropped`);
});

// ── 5. NOTHING ABOUT THE RANKER REACHES THE PROMPT ──────────────────────────

test('⚠️ NO SCORE, NO EDGE AND NO IDENTIFIER EVER APPEARS IN THE TEXT — ranking decides ORDER, nothing else', () => {
  const map = buildRepoMap('/repo', makeFs({
    'lib/core.mjs': 'const SECRET_LOCAL = "hunter2";\nexport function coreThing() { return SECRET_LOCAL; }\n',
    'lib/alpha.mjs': "import { coreThing } from './core.mjs';\nexport function alphaRun() {}\n",
  }), { budgetTokens: 4000, task: 'fix coreThing' });
  assert.ok(!map.text.includes('hunter2'), 'the reference scan leaked a file body into the prompt');
  assert.ok(!map.text.includes('SECRET_LOCAL'),
    'a non-exported local identifier reached the map — the reference scan is for edges, never for display');
  assert.ok(!/rank|pagerank|score/i.test(map.text), 'the ranker described itself in the prompt');
});

test('the real repo ranks without changing what the map is allowed to say', () => {
  const map = buildRepoMap(REPO_ROOT, {}, { budgetTokens: 6000, task: 'fix the retry chain in lib/chain.mjs' });
  assert.equal(map.ok, true);
  assert.ok(map.stats.rankEdges > 100, `only ${map.stats.rankEdges} edges on a 400-file repo — the graph is not being built`);
  assert.ok(map.stats.rankIterations <= RANK_MAX_ITERATIONS);
  assert.ok(map.text.includes('lib/chain.mjs'),
    'the user named chain.mjs and the map of our own repo still does not list it');
  assert.ok(!map.text.includes('node_modules/'));
});
