/**
 * ── ⭐⭐⭐ THE LARGEST MEASURED LEVER, AND THE ONE WE HAD NO CODE FOR ─────────
 *
 * File-level localization is worth **15-17x** over a no-file baseline. These
 * tests pin the four properties that make `lib/localize.mjs` worth the tokens,
 * and each one exists because the obvious implementation gets it wrong:
 *
 *   1. the tree is DIRECTORIES, so 50,000 files cannot become 50,000 lines;
 *   2. the negative filter matches on SEGMENT boundaries, so `src/app` cannot
 *      delete `src/apple.js`, and it REFUSES a filter that empties the repo;
 *   3. a skeleton drops BODIES, and the test proves it by looking for a token
 *      that only exists inside one;
 *   4. the fixed point stops when a round names nothing new — not when a round
 *      names the same list, which is a different and weaker condition.
 *
 * ⚠️ NOT ONE TEST HERE MAKES A MODEL CALL. `localize()` takes `askImpl`; the
 * module imports nothing from `model.mjs` or `chain.mjs`, so a network call is
 * not something a bug could reintroduce — there is no client in scope to call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDirIndex,
  renderTree,
  applyIrrelevantFilter,
  extractSkeleton,
  padToWindow,
  convergence,
  localize,
  localizeToolSchemas,
  runLocalizeTool,
  OPTIMAL_MIN_FILES,
  OPTIMAL_MAX_FILES,
} from '../lib/localize.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE TREE
// ─────────────────────────────────────────────────────────────────────────────

test('the index counts files DIRECTLY in a directory and files in its subtree separately', () => {
  const index = buildDirIndex(['a/b/one.js', 'a/b/two.js', 'a/three.js', 'root.js']);
  assert.equal(index.get('a').own, 1);
  assert.equal(index.get('a').subtree, 3);
  assert.equal(index.get('a/b').own, 2);
  assert.equal(index.get('a/b').subtree, 2);
  // The root sentinel is '' and holds only the files that sit at the top level.
  assert.equal(index.get('').own, 1);
  assert.equal(index.get('').subtree, 4);
});

test('⚠️⚠️ A 50,000-FILE MONOREPO MUST NOT PRODUCE A 50,000-LINE PROMPT', () => {
  /**
   * The whole reason this renders directories rather than files. 50,000 files
   * spread over 40 directories is 40 lines of signal; the file list that
   * `repo-map.mjs` renders would be 50,000 lines, and no budget-driven cut of
   * a file list can tell the model that a directory exists at all once its
   * files are gone.
   */
  const paths = [];
  for (let d = 0; d < 40; d++) {
    for (let f = 0; f < 1250; f++) paths.push(`pkg${String(d).padStart(2, '0')}/src/file${f}.ts`);
  }
  assert.equal(paths.length, 50_000);

  const out = renderTree(paths);
  const lines = out.text.split('\n').length;
  assert.ok(lines < 200, `expected a tree of tens of lines, got ${lines}`);
  assert.equal(out.filesTotal, 50_000);
  // Every one of the 40 packages must be visible — reach is the product.
  assert.equal(out.dirsShown, out.dirsTotal);
  assert.equal(out.truncated, false);
});

test('the tree honours a hard budget, and says how much it withheld', () => {
  const paths = [];
  for (let d = 0; d < 400; d++) paths.push(`d${String(d).padStart(3, '0')}/sub/deep/x.ts`);

  const full = renderTree(paths);
  assert.ok(full.tokens > 400, 'the fixture must be big enough for the budget to bite');

  const tight = renderTree(paths, { budgetTokens: 400 });
  assert.ok(tight.tokens <= 400, `budget overrun: ${tight.tokens} > 400`);
  assert.equal(tight.budgetOverrun, false);
  assert.equal(tight.truncated, true);
  assert.ok(tight.dirsShown < tight.dirsTotal);
  assert.match(tight.text, /NOT SHOWN/);
  // ⚠️ A truncated tree that does not state its total is the lie repo-map.mjs
  // refuses to tell; the total is what turns "incomplete" into a next move.
  assert.ok(tight.text.includes(String(tight.dirsTotal)));
});

test('⚠️ A BUDGET SMALLER THAN THE FRAME IS FLAGGED, NOT SILENTLY EXCEEDED', () => {
  /**
   * Measured: at 60 tokens the renderer emits 127 with ZERO directories listed,
   * because the header + totals are a fixed ~120-token frame. Dropping lines
   * cannot fix that, so the only honest options are to lie or to flag. A caller
   * with a genuinely hard ceiling reads `budgetOverrun` and drops the tree.
   */
  const paths = Array.from({ length: 50 }, (_, i) => `d${i}/x.ts`);
  const impossible = renderTree(paths, { budgetTokens: 5 });
  assert.equal(impossible.budgetOverrun, true);
  assert.equal(impossible.dirsShown, 0);
  // It still states the totals — that is the one fact a zero-line tree can give.
  assert.ok(impossible.text.includes(String(impossible.dirsTotal)));
});

test('⭐⭐ EVERY SHALLOW DIRECTORY SURVIVES A BUDGET THAT CUTS THOUSANDS OF DEEP ONES', () => {
  /**
   * MEASURED on this package's own worktree: 12,880 files in **2,506
   * directories**, distributed 1 / 9 / 4 / 5 / 104 / 383 / 351 / 323 / 472 /
   * 548 / 262 / 35 / 9 by depth. At the default 2,000-token budget the tree
   * renders **94 directories in 102 lines**, and the 94 are every directory at
   * depth 0-2 plus as much of depth 3 as fits.
   *
   * ⭐ THAT IS THE WHOLE DESIGN WORKING. The 2,400 unshown directories are
   * bench output nested six deep under one top-level folder — and the model can
   * delete every one of them by naming that ONE folder, which it can see. A
   * renderer that spent its budget depth-first would have shown a thousand
   * bench directories and hidden the folder that subsumes them.
   */
  const paths = [];
  for (const top of ['src', 'lib', 'docs', 'bench']) {
    paths.push(`${top}/index.ts`);
    for (let i = 0; i < 600; i++) paths.push(`${top}/gen/a${i}/b/c/d/e/deep.ts`);
  }
  const out = renderTree(paths);
  for (const top of ['src/', 'lib/', 'docs/', 'bench/']) {
    assert.ok(out.text.includes(`  ${top}  `), `a top-level directory was cut: ${top}`);
  }
  assert.equal(out.truncated, true);
  assert.ok(out.dirsShown < 400, 'the deep directories must NOT all be shown');
  // The subtree count is how a hidden directory still tells on itself.
  assert.match(out.text, /bench\/ {2}1 files \(\+600 deeper\)/);
});

test('⭐ SHALLOW FIRST BEATS BIG — a tiny top-level folder outranks a huge deep one', () => {
  /**
   * ⚠️ THIS TEST EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT. Deleting the
   * depth term from the tree's comparator left every other assertion green,
   * because on ordinary trees "biggest subtree first" happens to put top-level
   * directories first anyway. The two orderings only diverge on the case that
   * matters: a SMALL shallow folder against a LARGE deep one.
   *
   * ⭐ And shallow must win, because a folder is the unit of the decision the
   * tree is being rendered for. `tiny/` holds one file, but naming it as
   * irrelevant is a legal move the model can only make if it can see it;
   * `big/x/y/z/` holds fifty, and every one of them is already discarded the
   * moment the model discards `big/`. Showing the child instead of the parent
   * spends the budget on a line that cannot change the outcome.
   *
   * `repo-map.mjs` measured the opposite conclusion for a FILE list — depth-first
   * ordering there produced "659 files from 7 of 360 directories", a cliff.
   * Both are right: a file cannot be discarded by its parent, and a directory can.
   */
  const paths = ['tiny/one.ts'];
  for (let i = 0; i < 50; i++) paths.push(`big/x/y/z/w/f${i}.ts`);

  // MEASURED on this fixture: the whole 7-directory tree costs 101 tokens, so
  // 100 is the budget that forces exactly one cut and makes the ordering visible.
  const out = renderTree(paths, { budgetTokens: 100 });
  assert.equal(out.truncated, true, 'the budget must actually bite for this to prove anything');
  assert.ok(out.dirsShown < out.dirsTotal);
  assert.ok(out.text.includes('  tiny/  '), 'a one-file top-level folder was cut for a deep one');
  assert.ok(!out.text.includes('  big/x/y/z/w/  '), 'the deepest directory outranked a top-level one');
});

test('the tree is deterministic — same paths, same bytes, in any input order', () => {
  const paths = ['b/two.ts', 'a/one.ts', 'c/three.ts'];
  const a = renderTree(paths).text;
  const b = renderTree([...paths].reverse()).text;
  assert.equal(a, b);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE NEGATIVE FILTER
// ─────────────────────────────────────────────────────────────────────────────

test('⚠️ THE FILTER MATCHES SEGMENTS — `src/app` must not delete `src/apple.js`', () => {
  const paths = ['src/app/main.ts', 'src/apple.js', 'src/appliance/x.ts'];
  const out = applyIrrelevantFilter(paths, ['src/app']);
  assert.deepEqual(out.removed, ['src/app/main.ts']);
  assert.deepEqual(out.kept, ['src/apple.js', 'src/appliance/x.ts']);
});

test('the filter removes a whole subtree and reports folders that matched nothing', () => {
  const paths = ['docs/a.md', 'docs/deep/b.md', 'src/x.ts'];
  const out = applyIrrelevantFilter(paths, ['docs/', './vendor', 'node_modules']);
  assert.deepEqual(out.kept, ['src/x.ts']);
  assert.equal(out.removed.length, 2);
  // ⭐ A named folder that matched nothing is a HALLUCINATED folder, and the
  // caller has to be able to see that it was one.
  assert.deepEqual(out.unmatched, ['node_modules', 'vendor']);
});

test('⚠️⚠️ A FILTER THAT WOULD EMPTY THE REPO IS REFUSED, NOT APPLIED', () => {
  /**
   * The failure mode that makes a negative filter worse than no filter: one
   * bad line ("." or the repo root) and localization has zero candidates, which
   * reads downstream as "this repo has no relevant files" rather than as an
   * error. Refusing is recoverable; an empty candidate set is not.
   */
  const paths = ['src/x.ts', 'src/y.ts'];
  const out = applyIrrelevantFilter(paths, ['src']);
  assert.equal(out.refused, true);
  assert.deepEqual(out.kept, paths);
  assert.equal(out.removed.length, 0);
  assert.match(out.reason, /every/i);
});

test('a folder entry of "." or "/" is rejected outright, never applied', () => {
  /**
   * ⚠️ THE FIRST VERSION OF THIS TEST WAS DECORATIVE, and a mutation proved it:
   * deleting the rejection guard left it green, because after normalization
   * none of these entries happens to MATCH anything either. "Removes nothing"
   * is true for both the guarded and the unguarded code.
   *
   * ⭐ The observable difference is the BOOKKEEPING. A rejected entry goes to
   * `rejected`; an accepted-but-useless one goes to `unmatched`, which is the
   * field that means "the model named a folder that does not exist". Conflating
   * a malformed entry with a hallucinated one makes the hallucination signal
   * useless, and that signal is how a caller decides to stop trusting the step.
   */
  const paths = ['a.ts', 'b/c.ts'];
  for (const bad of ['.', '/', './', '']) {
    const out = applyIrrelevantFilter(paths, [bad]);
    assert.deepEqual(out.kept, paths, `"${bad}" must be rejected`);
    assert.equal(out.removed.length, 0);
    assert.deepEqual(out.rejected, [bad], `"${bad}" must be recorded as REJECTED`);
    assert.deepEqual(out.unmatched, [], `"${bad}" must not be reported as a missing folder`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE SKELETON
// ─────────────────────────────────────────────────────────────────────────────

const TS_FIXTURE = [
  "import { readFileSync } from 'node:fs';",
  '',
  'const SECRET_BODY_TOKEN = 1;',
  '',
  'export interface Options {',
  '  depth: number;',
  '}',
  '',
  'export function compute(a: number, b: number): number {',
  '  const intermediate = a * SECRET_BODY_TOKEN;',
  '  if (intermediate > 3) {',
  '    return intermediate + b;',
  '  }',
  '  return b;',
  '}',
  '',
  'export class Engine {',
  '  constructor(private opts: Options) {',
  '    this.opts = opts;',
  '  }',
  '',
  '  async run(input: string): Promise<void> {',
  '    for (const ch of input) {',
  '      console.log(ch);',
  '    }',
  '  }',
  '}',
].join('\n');

test('⭐ THE SKELETON KEEPS SIGNATURES AND DROPS BODIES — proven by a token only a body has', () => {
  const out = extractSkeleton('src/engine.ts', TS_FIXTURE);
  assert.equal(out.ok, true);
  assert.equal(out.language, 'ts');
  for (const sig of ['export function compute', 'export class Engine', 'constructor', 'async run', 'export interface Options']) {
    assert.ok(out.text.includes(sig), `signature missing: ${sig}`);
  }
  /**
   * ⚠️ THE IMPORT KEEPS ITS BINDINGS. The first version cut every line at its
   * first `{`, so this rendered as the single word "import" — a line that costs
   * tokens and says nothing. On an import the braces ARE the payload.
   */
  assert.ok(out.text.includes('readFileSync'), 'the import lost its binding list');
  assert.ok(out.text.includes('node:fs'));
  // The declaration of the constant survives (it is a declaration); the USE of
  // it inside compute()'s body must not.
  assert.ok(!out.text.includes('intermediate'), 'a body line survived the skeleton');
  assert.ok(!out.text.includes('console.log'), 'a body line survived the skeleton');
});

test('a skeleton costs a FRACTION of the file — and the numbers are reported', () => {
  const out = extractSkeleton('src/engine.ts', TS_FIXTURE);
  assert.ok(out.bytesOut < out.bytesIn * 0.75, `skeleton was ${out.bytesOut}/${out.bytesIn} bytes`);
  assert.ok(out.linesKept < out.linesTotal);
  assert.equal(typeof out.bytesIn, 'number');
});

test('line numbers survive, because they are how the model reaches the body it skipped', () => {
  const out = extractSkeleton('src/engine.ts', TS_FIXTURE);
  // `export function compute` is on line 9 of the fixture (1-indexed).
  assert.match(out.text, /\b9\b[^\n]*export function compute/);
});

test('python skeletons keep def/class/decorators and drop the body', () => {
  const py = [
    'import os',
    '',
    '@dataclass',
    'class Thing:',
    '    def method(self, x):',
    '        total = x + 1',
    '        return total',
    '',
    'async def main(argv):',
    '    print(argv)',
  ].join('\n');
  const out = extractSkeleton('app/main.py', py);
  assert.equal(out.ok, true);
  assert.equal(out.language, 'py');
  assert.ok(out.text.includes('class Thing'));
  assert.ok(out.text.includes('def method'));
  assert.ok(out.text.includes('async def main'));
  assert.ok(out.text.includes('@dataclass'));
  assert.ok(!out.text.includes('total = x + 1'));
});

test('⚠️ AN UNKNOWN LANGUAGE RETURNS NOTHING RATHER THAN GARBAGE', () => {
  /**
   * repo-map.mjs's rule, and it applies harder here: a markdown file containing
   * the words "export function" is not a module, and a fabricated skeleton is
   * worse than no skeleton because the model treats it as a parse.
   */
  const out = extractSkeleton('README.md', 'export function notReal() {}\nprose');
  assert.equal(out.ok, false);
  assert.equal(out.text, '');
  assert.ok(out.reason.length > 0);
});

test('⚠️ A ONE-LINE FUNCTION IS STILL A BODY — the brace is where the cut happens', () => {
  /**
   * ⚠️ THIS TEST EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT. Disabling the
   * brace-cut in `trimBody` left every other skeleton assertion green, because
   * the fixture's bodies all sat on their own lines. `export function f(a) {
   * return SECRET; }` is a declaration AND a body on one line, and it is an
   * extremely common shape — one-line getters, guards and re-exports.
   */
  const src = 'export function f(a) { return SECRET_ONE_LINER; }';
  const out = extractSkeleton('a.ts', src);
  assert.ok(out.text.includes('export function f(a)'));
  assert.ok(!out.text.includes('SECRET_ONE_LINER'), 'a one-line body survived the skeleton');
});

test('a multi-line signature is kept whole, not cut at the first line', () => {
  const src = [
    'export function wide(',
    '  first: string,',
    '  second: number,',
    '): void {',
    '  doSomethingSecret();',
    '}',
  ].join('\n');
  const out = extractSkeleton('a.ts', src);
  assert.ok(out.text.includes('first: string'));
  assert.ok(out.text.includes('second: number'));
  assert.ok(!out.text.includes('doSomethingSecret'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE WINDOW AND THE FIXED POINT
// ─────────────────────────────────────────────────────────────────────────────

test('⭐ 6-10 FILES IS THE MEASURED OPTIMUM, so a thin answer is PADDED with siblings', () => {
  /**
   * LLM-selected files scored 60.6% using 8.5 files; gold buggy-files-only
   * scored 56.2% using 1.25. Surrounding context is not slack, it is the
   * difference, so a model that names two files gets its neighbours added.
   */
  const all = [
    'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts',
    'docs/x.md',
    // ⚠️ A SOURCE FILE IN AN UNRELATED DIRECTORY. Without it this test could not
    // tell "siblings" from "any source file", and a mutation that padded from
    // anywhere in the repo stayed green — the only non-sibling was prose, which
    // the extension filter rejected for a different reason entirely.
    // ⚠️ AND IT MUST SORT *BEFORE* THE REAL SIBLINGS. The first attempt named it
    // `unrelated/z.ts`, which sorts after every `src/*`, so the sibling pool
    // filled up before the mutation could reach it and the test stayed green
    // anyway. A negative test has to put the wrong answer first.
    'aaa-unrelated/z.ts',
  ];
  const out = padToWindow(['src/a.ts', 'src/b.ts'], all);
  assert.ok(out.files.length >= OPTIMAL_MIN_FILES, `only ${out.files.length} files`);
  assert.equal(out.files[0], 'src/a.ts', 'the model\'s own ordering must survive');
  assert.ok(out.padded > 0);
  // Padding comes from the same directories, and prose is not a code sibling.
  assert.ok(!out.files.includes('docs/x.md'));
  assert.ok(!out.files.includes('aaa-unrelated/z.ts'), 'padding reached outside the chosen directories');
});

test('the window is a CEILING too — more than 10 files is cut back', () => {
  const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
  const out = padToWindow(many, many);
  assert.equal(out.files.length, OPTIMAL_MAX_FILES);
  assert.equal(out.files[0], 'src/f0.ts');
});

test('⚠️ CONVERGENCE IS "NOTHING NEW", NOT "THE SAME LIST"', () => {
  /**
   * A round that drops a file it named before has still added nothing, and
   * context is monotone — the dropped file is already in the prompt. Testing
   * for an identical list would loop forever on a model that reorders.
   */
  assert.equal(convergence(['a.ts', 'b.ts'], ['b.ts', 'a.ts']).converged, true);
  assert.equal(convergence(['a.ts', 'b.ts'], ['a.ts']).converged, true);
  const grown = convergence(['a.ts'], ['a.ts', 'c.ts']);
  assert.equal(grown.converged, false);
  assert.deepEqual(grown.added, ['c.ts']);
  // Path spellings that mean the same file must not read as new.
  assert.equal(convergence(['a/b.ts'], ['./a/b.ts', 'a\\b.ts']).converged, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE LOOP — every model call injected, none of them real
// ─────────────────────────────────────────────────────────────────────────────

const REPO = [
  'src/auth/login.ts', 'src/auth/session.ts', 'src/auth/token.ts',
  'src/ui/button.tsx', 'src/ui/modal.tsx',
  'docs/guide.md', 'docs/api.md',
  'vendor/lib.js',
];

test('localize runs tree → irrelevant → files → skeletons → fixed point, with no network', async () => {
  const calls = [];
  const askImpl = async ({ step }) => {
    calls.push(step);
    if (step === 'irrelevant') return ['docs', 'vendor'];
    return ['src/auth/login.ts', 'src/auth/session.ts'];
  };
  const out = await localize({
    paths: REPO,
    askImpl,
    readImpl: (p) => `export function ${p.includes('login') ? 'login' : 'session'}() {\n  hidden();\n}\n`,
  });

  assert.equal(out.ok, true);
  assert.deepEqual(calls, ['irrelevant', 'files', 'files']);
  assert.equal(out.converged, true);
  assert.equal(out.rounds, 2);
  assert.ok(out.files.includes('src/auth/login.ts'));
  // The negative filter really removed the folders it named.
  assert.ok(!out.files.some((f) => f.startsWith('docs/')));
  assert.deepEqual(out.irrelevant, ['docs', 'vendor']);
  // Skeletons were built, and they are skeletons.
  assert.ok(out.skeletons.length > 0);
  assert.ok(!out.skeletons.some((s) => s.text.includes('hidden()')));
});

test('⚠️ THE LOOP IS BOUNDED — a model that names a new file every round still stops', async () => {
  let n = 0;
  const askImpl = async ({ step }) => {
    if (step === 'irrelevant') return [];
    n += 1;
    return [`src/auth/login.ts`, `src/ui/button.tsx`, `src/gen${n}.ts`];
  };
  const out = await localize({ paths: [...REPO, 'src/gen1.ts', 'src/gen2.ts', 'src/gen3.ts', 'src/gen4.ts'], askImpl, maxRounds: 3 });
  assert.equal(out.ok, true);
  assert.equal(out.converged, false);
  assert.equal(out.rounds, 3);
});

test('localize never throws — an askImpl that explodes becomes ok:false', async () => {
  const out = await localize({ paths: REPO, askImpl: async () => { throw new Error('provider down'); } });
  assert.equal(out.ok, false);
  assert.match(out.error, /provider down/);
});

test('⚠️ NO askImpl MEANS NO RUN — the module cannot spend by accident', async () => {
  /**
   * ⚠️ THE FIRST VERSION OF THIS TEST WAS DECORATIVE. It asserted only that the
   * error mentions "askImpl" — and deleting the guard entirely left it GREEN,
   * because the loop then called `null(...)`, threw "askImpl is not a function",
   * and the catch produced a message that still matched. A test that passes
   * whether or not the guard exists is not testing the guard.
   *
   * ⭐ The property that actually distinguishes them is that NOTHING RAN:
   * `askCalls` is incremented before each call, so zero proves the refusal
   * happened up front rather than inside a failed call.
   */
  const out = await localize({ paths: REPO });
  assert.equal(out.ok, false);
  assert.equal(out.stats.askCalls, 0, 'the run reached a call site before refusing');
  assert.match(out.error, /makes no model calls of its own/);
});

test('⭐ REACHABILITY — the tool is declared, dispatchable, and describes itself', () => {
  const schemas = localizeToolSchemas();
  assert.equal(schemas.length, 1);
  const fn = schemas[0].function;
  assert.equal(fn.name, 'localize_files');
  // The third part of reachability: a sentence that tells the model it exists
  // and when to reach for it. A schema with no description is unreachable.
  assert.ok(fn.description.length > 80);
  assert.match(fn.description, /which files/i);
  assert.equal(typeof runLocalizeTool, 'function');
});

test('the tool handler refuses a request it cannot satisfy instead of returning an empty answer', async () => {
  const res = await runLocalizeTool({ task: 'fix login' }, { paths: [], askImpl: async () => [] });
  assert.equal(res.ok, false);
  assert.ok(res.error.length > 0);
});
