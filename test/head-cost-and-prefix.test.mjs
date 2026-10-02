/**
 * ── ⭐⭐⭐ THE PROMPT HEAD IS THE BILL. THIS FILE MEASURES IT. ────────────────
 *
 * `ECONOMICS.md`, derived from the audit ledger and one saved transcript, and
 * reconciled to eight decimal places against what we were actually charged:
 *
 *   · cache-MISS input is **90.9%** of every dollar; output is **2.1%**
 *   · for the task **"hi"**, the head decomposed as
 *     **tool schemas 53.3% · repo map 34.6% · system 12.1% · the request 0.002%**
 *   · a cold round costs **12.9x** a warm one on byte-identical work, and two
 *     cold runs were **68.3%** of all measured spend
 *
 * So there are exactly two numbers worth defending here, and they pull against
 * each other:
 *
 *   **SIZE** — how many bytes a cold head costs. Smaller is cheaper.
 *   **SHARING** — how many of those bytes are byte-identical to the LAST head,
 *   so an upstream prefix cache can serve them at 1/15.7 of the price.
 *
 * ⚠️⚠️ AND SHARING IS THE ONE THAT IS EASY TO DESTROY BY ACCIDENT, because
 * nothing goes red when it happens: the output is still correct, the tests still
 * pass, the bill just triples. Both defects this file guards were found by
 * measuring, not by a failure — one had been shipping for weeks.
 *
 * ⚠️ ZERO NETWORK. Every number below is produced by constructing the prompt
 * pieces and counting characters. Nothing here calls a model.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { toolNamesForRounds, toolSchemasFor } from '../lib/tools.mjs';
import { orderForCachePrefix } from '../lib/tool-prefix.mjs';
import { shortlistTools, CORE_TOOLS } from '../lib/tool-shortlist.mjs';
import { buildRepoMap, DEFAULT_BUDGET_TOKENS, TASK_TRANCHE_SHARE } from '../lib/repo-map.mjs';

/**
 * ⚠️ 3.54, NOT 4. Reconciled in `ECONOMICS.md` against a real recorded run:
 * 90,993 characters of head against 25,707 billed prompt tokens. Paths and JSON
 * tokenize worse than prose, and using the prose number would understate every
 * figure below by 12%.
 */
const CHARS_PER_TOKEN = 3.54;
const tokens = (s) => Math.round(s.length / CHARS_PER_TOKEN);

const ROUNDS = 5;

/** The longest common prefix of two strings, in bytes. */
function sharedPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

const OFFER = toolNamesForRounds(ROUNDS, { allowRun: true, root: process.cwd() });

/** The tools block exactly as `turn.mjs` puts it on the wire. */
const toolBlock = (names, orderKey) => JSON.stringify(
  orderForCachePrefix(toolSchemasFor(names, { shell: true }), { maxRounds: ROUNDS, shortlist: orderKey ?? null }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1. SIZE — the shortlist has to fire on the task that motivated it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ THE DEFECT THIS REPLACES. `shortlistTools` returned the FULL offer for any
 * brief under twelve characters, so the recorded "hi" run — the one whose head
 * was 99.998% overhead — was the one case the shortlist could not touch.
 */
test('⭐⭐ the trivial task is where the head is ALL overhead, and it is now cut', () => {
  const full = toolBlock(OFFER, null);
  const trivial = shortlistTools('hi', OFFER);
  const cut = toolBlock(trivial, trivial);

  assert.ok(cut.length < full.length,
    `"hi" still carries the whole ${OFFER.length}-tool surface (${full.length} bytes) — `
    + 'the 53.3% line item is untouched');

  // The spine survives, which is what makes the cut safe.
  for (const t of ['read_file', 'write_file', 'edit_file', 'search_text', 'run_command']) {
    assert.ok(trivial.includes(t), `${t} is core and must survive an unsignalled brief`);
  }

  const pct = ((1 - cut.length / full.length) * 100).toFixed(1);
  console.log(`   tool block, task "hi"        ${OFFER.length} tools ${full.length}B ~${tokens(full)} tok`
    + `  ->  ${trivial.length} tools ${cut.length}B ~${tokens(cut)} tok  (-${pct}%)`);
});

test('⭐ and on a realistic multi-file brief', () => {
  const task = 'add a dark mode toggle to the settings page and update the tests';
  const full = toolBlock(OFFER, null);
  const narrow = shortlistTools(task, OFFER);
  const cut = toolBlock(narrow, narrow);
  assert.ok(narrow.length < OFFER.length, 'this brief no longer exercises the shortlist');
  const pct = ((1 - cut.length / full.length) * 100).toFixed(1);
  console.log(`   tool block, realistic task   ${OFFER.length} tools ${full.length}B ~${tokens(full)} tok`
    + `  ->  ${narrow.length} tools ${cut.length}B ~${tokens(cut)} tok  (-${pct}%)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SHARING — where the task-varying part is allowed to sit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── ⚠️⚠️⭐ THE ORDERING KEY DECIDES WHETHER THE SHORTLIST IS A SAVING AT ALL ──
 *
 * `turn.mjs` passes the PER-TASK shortlist to `orderForCachePrefix`, which
 * hoists those tools to the front of the block. That is exactly right for a
 * WIDEN — the narrow block becomes a byte prefix of the wide one, so re-admitting
 * the missing tools appends instead of rewriting — and exactly wrong for two
 * different TASKS, whose blocks then diverge within the first schema.
 *
 * ⭐ THIS TEST DOES NOT ASSERT WHICH KEY `turn.mjs` USES — it does not own that
 * decision. It asserts the PROPERTY that makes the choice: a task-invariant key
 * shares materially more of the block across tasks than a per-task one. If that
 * ever stops being true, the reasoning in `tool-shortlist.mjs`'s header is stale
 * and this goes red rather than silently misleading the next reader.
 */
test('⚠️⚠️ a per-task ordering key destroys the cross-task prefix; a constant one keeps it', () => {
  const a = shortlistTools('commit this and open a pull request for the auth fix', OFFER);
  const b = shortlistTools('start the dev server and check the api endpoint responds', OFFER);
  assert.notDeepEqual(a, b, 'the two briefs shortlist identically — they no longer exercise this');

  const perTask = sharedPrefix(toolBlock(a, a), toolBlock(b, b));
  const constant = sharedPrefix(toolBlock(a, CORE_TOOLS), toolBlock(b, CORE_TOOLS));
  const smaller = Math.min(toolBlock(a, a).length, toolBlock(b, b).length);

  console.log(`   cross-task tool prefix: per-task key ${perTask}B (${((perTask / smaller) * 100).toFixed(1)}%)`
    + `  vs  constant key ${constant}B (${((constant / smaller) * 100).toFixed(1)}%)`);

  assert.ok(constant > perTask * 1.5,
    `a task-invariant ordering key shared ${constant}B against the per-task key's ${perTask}B — `
    + 'the argument in tool-shortlist.mjs for passing CORE_TOOLS at turn.mjs:2966 no longer holds');
});

/**
 * ⚠️ AND THE WIDEN PROPERTY IS THE OTHER HALF OF THE SAME TRADE, kept here so
 * nobody "fixes" the cross-task number by breaking the append. A widen must
 * still extend the block rather than rewrite it.
 */
test('⚠️ widening still APPENDS under the per-task key', () => {
  const task = 'add a dark mode toggle to the settings page';
  const narrow = shortlistTools(task, OFFER);
  const wide = shortlistTools(task, OFFER, { widened: true });
  const n = toolBlock(narrow, narrow);
  const w = toolBlock(wide, narrow);
  // -1 for the narrow array's closing bracket, which the wide one has later.
  assert.equal(sharedPrefix(n, w), n.length - 1, 'a widen rewrote the cached prefix instead of appending');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE REPO MAP — 34.6% of the head, and it was 97.9% task-varying
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tree big enough that the budget BINDS. ⚠️ That is not incidental: on a repo
 * small enough to fit, the map renders in path order whatever the ranker
 * decided, so it is byte-identical across tasks and this whole class of defect
 * is invisible. Every repository we own is small enough to fit; no customer's is.
 */
let treeRoot = null;
function bigTree() {
  if (treeRoot) return treeRoot;
  const root = mkdtempSync(join(tmpdir(), 'acuvo-head-prefix-'));
  for (let p = 0; p < 45; p += 1) {
    const dir = join(root, 'pkg', `mod${String(p).padStart(2, '0')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hub.mjs'), `export function hub${p}Thing() { return ${p}; }
`);
    for (let i = 0; i < 45; i += 1) {
      writeFileSync(
        join(dir, `leaf${String(i).padStart(2, '0')}.mjs`),
        `import { hub${p}Thing } from './hub.mjs';
export const v${p}_${i} = hub${p}Thing();
`,
      );
    }
  }
  treeRoot = root;
  return root;
}

/** ⚠️ Built once and removed once — writing 2,000 files per test is the slowest thing here. */
after(() => { if (treeRoot) rmSync(treeRoot, { recursive: true, force: true }); });

test('⭐⭐ the repo map keeps a task-INVARIANT head and puts the task-varying part last', () => {
  const root = bigTree();
  {
    const one = buildRepoMap(root, {}, { task: 'fix hub01Thing in pkg/mod01/hub.mjs' });
    const two = buildRepoMap(root, {}, { task: 'rename hub29Thing inside pkg/mod29/hub.mjs' });
    const trivial = buildRepoMap(root, {}, { task: 'hi' });

    assert.equal(one.truncated, true, 'the fixture fits the budget, so the ranking never reaches the bytes');
    assert.ok(one.stats.rankSeeds > 0 && two.stats.rankSeeds > 0, 'neither brief seeded the ranking');
    assert.notEqual(one.text, two.text, 'the two maps are identical — personalization is not reaching the text');

    const share = (a, b) => sharedPrefix(a, b) / Math.min(a.length, b.length);
    console.log(`   repo map cross-task prefix   ${(share(one.text, two.text) * 100).toFixed(1)}%`
      + `   vs an unseeded task ${(share(one.text, trivial.text) * 100).toFixed(1)}%`
      + `   (${one.stats.listedFiles} files, ${one.stats.dirsListed}/${one.stats.dirsTotal} dirs, `
      + `~${tokens(one.text)} tok)`);

    /**
     * ⚠️ THE FLOOR IS THE RESERVATION. `1 - TASK_TRANCHE_SHARE` of the budget is
     * spent by a ranking that never sees the user's words, so that much of the
     * map must survive a change of question. Measured before this split, on a
     * real 2,792-file tree: **2.1%.**
     */
    const floor = (1 - TASK_TRANCHE_SHARE) * 0.9;
    assert.ok(share(one.text, two.text) > floor,
      `two tasks in the same repository shared only ${(share(one.text, two.text) * 100).toFixed(1)}% of the map — `
      + 'the invariant tranche is no longer invariant');
    assert.ok(share(one.text, trivial.text) > floor,
      'a seeded and an unseeded task diverged early — the reservation must be taken unconditionally');

    // ⭐ AND THE FILE THE REQUEST NAMED IS STILL REACHED, with its exports.
    const named = one.text.split('\n').filter((l) => l.includes('pkg/mod01/hub.mjs'));
    assert.ok(named.some((l) => l.includes('[')),
      'the file the request named lost its symbol list — personalization bought nothing');
  }
});

test('⚠️ two tasks that name nothing produce a byte-identical map', () => {
  const root = bigTree();
  {
    const a = buildRepoMap(root, {}, { task: 'hi' });
    const b = buildRepoMap(root, {}, { task: 'hello there' });
    assert.equal(a.text, b.text, 'two unseeded briefs produced different maps — nothing in them justifies a difference');
    assert.equal(a.stats.rankSeeds, 0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DETERMINISM — the invariant that outranks every saving above
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── ⚠️⚠️⭐ THREE FRESH PROCESSES, NOT THREE CALLS ───────────────────────────
 *
 * In-process repetition proves almost nothing: module state, memoised
 * derivations and a warm `Map` insertion order all survive between calls, and
 * every one of them is a way for the head to differ between two RUNS of the CLI
 * while looking stable inside one. Prefix caching is a property of separate
 * processes on separate days, so the proof has to be too.
 *
 * ⚠️ AND IT HASHES THE WHOLE HEAD — tools block AND repo map, for a trivial task
 * and a realistic one. A change to either that introduces a clock, a `readdir`
 * order, a locale-dependent sort or an unstable float turns this red, and the
 * cost of missing it is the 12.9x cold-round multiplier on every single request.
 */
test('⚠️⚠️⚠️ DETERMINISM: three separate processes build a byte-identical head', () => {
  const root = bigTree();
  let runs;
  {
    const script = [
      `import { toolNamesForRounds, toolSchemasFor } from ${JSON.stringify(new URL('../lib/tools.mjs', import.meta.url).href)};`,
      `import { orderForCachePrefix } from ${JSON.stringify(new URL('../lib/tool-prefix.mjs', import.meta.url).href)};`,
      `import { shortlistTools } from ${JSON.stringify(new URL('../lib/tool-shortlist.mjs', import.meta.url).href)};`,
      `import { buildRepoMap } from ${JSON.stringify(new URL('../lib/repo-map.mjs', import.meta.url).href)};`,
      'import { createHash } from "node:crypto";',
      `const root = ${JSON.stringify(root)};`,
      'const offer = toolNamesForRounds(5, { allowRun: true, root });',
      'const out = [];',
      'for (const task of ["hi", "fix hub07Thing in pkg/mod07/hub.mjs"]) {',
      '  const names = shortlistTools(task, offer);',
      '  const block = JSON.stringify(orderForCachePrefix(toolSchemasFor(names, { shell: true }), { maxRounds: 5, shortlist: names }));',
      '  const map = buildRepoMap(root, {}, { task });',
      '  if (!map.truncated) throw new Error("fixture drift: the map fits, so the ranking never reaches the bytes");',
      '  out.push(createHash("sha256").update(block + "\\u0000" + map.text).digest("hex") + ":" + names.length + ":" + map.stats.listedFiles + ":" + map.stats.rankIterations);',
      '}',
      'process.stdout.write(out.join(" "));',
    ].join('\n');
    const run = () => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    runs = [run(), run(), run()];
  }

  // ⚠️ The shape check first: a crash that printed nothing would otherwise
  // "pass" three times over. This is the same trap as a guard that cannot fail.
  assert.match(runs[0], /^[0-9a-f]{64}:\d+:\d+:\d+ [0-9a-f]{64}:\d+:\d+:\d+$/,
    `the subprocess did not produce two head digests: ${runs[0]}`);
  const [trivial, real] = runs[0].split(' ');
  assert.notEqual(trivial.split(':')[0], real.split(':')[0],
    'the two tasks produced the same head — the fixture cannot tell them apart, so nothing here is proven');

  assert.equal(runs[0], runs[1], `two processes built different heads:\n${runs[0]}\n${runs[1]}`);
  assert.equal(runs[1], runs[2], `the third process disagreed:\n${runs[1]}\n${runs[2]}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE HEADLINE NUMBER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ NOT AN ASSERTION ABOUT A TARGET — a printed receipt. The point of the whole
 * exercise is a number somebody can put next to `ECONOMICS.md`, and a number
 * that only exists in a commit message is a number nobody will ever re-derive.
 */
test('⭐ the head, priced', () => {
  const root = bigTree();
  {
    const rows = [
      ['hi', 'hi'],
      ['realistic', 'add a dark mode toggle in pkg/mod07/hub.mjs and update the tests'],
    ];
    const full = toolBlock(OFFER, null);
    for (const [label, task] of rows) {
      const names = shortlistTools(task, OFFER);
      const block = toolBlock(names, names);
      const map = buildRepoMap(root, {}, { task });
      const before = tokens(full) + tokens(buildRepoMap(root, {}, { task, rank: false }).text);
      const after = tokens(block) + tokens(map.text);
      console.log(`   HEAD ${label.padEnd(10)} tools ${String(tokens(full)).padStart(6)} -> ${String(tokens(block)).padStart(6)} tok`
        + `   map ${String(tokens(map.text)).padStart(6)} tok (${map.stats.listedFiles} files, ${map.stats.dirsListed}/${map.stats.dirsTotal} dirs)`
        + `   TOTAL ${before} -> ${after} tok  (-${((1 - after / before) * 100).toFixed(1)}%)`);
      assert.ok(after < before, `the head did not shrink for "${label}"`);
    }
    assert.equal(DEFAULT_BUDGET_TOKENS, 9_000, 'the map budget moved — re-derive the numbers above before trusting them');
  }
});
