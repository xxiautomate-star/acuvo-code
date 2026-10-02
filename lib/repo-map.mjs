/**
 * ── lib/repo-map.mjs — LET THE MODEL SEE THE WHOLE REPO, CHEAPLY ────────────
 *
 * THE MEASURED DEFECT THIS REPLACES. `gatherWorkspaceContext` (lib/turn.mjs)
 * walks TWO directory levels and inlines whole file BODIES in ALPHABETICAL
 * order, capped at 12 files / 40KB. On any real repository that shows the model
 * roughly 5% of the paths, and spends thousands of tokens doing it — on
 * READMEs, changelogs and build junk, because alphabetical order is not
 * relevance order. The file the model actually needs is invisible.
 *
 * ⭐ AND AN INVISIBLE FILE IS NOT A NEUTRAL ABSENCE. A model that cannot see
 * `lib/chain.mjs` does not go looking for it; it invents a plausible
 * `src/chain.js` and writes there. Blindness does not read as blindness from
 * the inside — it reads as "that file does not exist".
 *
 * ⭐ THE ECONOMICS ARE THE ENTIRE ARGUMENT. A path is a handful of tokens; a
 * file is thousands. Listing two thousand paths costs less than inlining five
 * files. So this module trades CONTENT for COVERAGE, and the trade is not close.
 *
 * ── THE FOUR PROPERTIES THAT ARE LOAD-BEARING ───────────────────────────────
 *
 *   1. DETERMINISM. Same tree, same bytes, byte for byte, every run. `readdir`
 *      makes NO order promise, so every list here is sorted by CODE POINT (not
 *      `localeCompare`, which is ICU-dependent and therefore machine-dependent).
 *      There are no timestamps and no rendered ages anywhere in the output —
 *      "3 minutes ago" changes every single run. A map that reshuffles destroys
 *      the cached prompt prefix, and prefix stability is worth 3.05x.
 *
 *   2. HONEST TRUNCATION. It never implies completeness it does not have, it
 *      states the total, and it says WHERE the gaps are rather than only how
 *      many — a bare count is unactionable, a named directory is a next move.
 *
 *   3. NO CONTENT LEAVES. It emits paths and symbol NAMES, never a file body.
 *      The old pre-read shipped `.env` verbatim to four upstream providers; the
 *      prompt is an exfiltration path and this module treats it as one. It
 *      reuses `refusedCommitPath` from git.mjs deliberately — that list already
 *      means "must never leave this machine", and a second copy is the copy
 *      that goes stale.
 *
 *   4. THE GUESS IS LABELLED. Symbols come from a regex, not a parser. A wrong
 *      guess is acceptable; presenting one as authoritative is not, because a
 *      missing name would otherwise read as proof of absence.
 *
 * ⚠️ EVERY IMPL IS INJECTED. No clock, no randomness, no ambient `fs` inside
 * the logic — the defaults at the bottom are the only place the real
 * filesystem is touched, so every property above is provable with data.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { refusedCommitPath } from './secret-paths.mjs';
/**
 * ⚠️ THIS COMPARATOR WAS DEFINED HERE AND THE RULE WAS WRITTEN HERE — and the
 * two other modules that render into the prompt sorted with `localeCompare`
 * anyway. It now lives in one place, so a module cannot follow the comment
 * without also following the code. See `prefix-order.mjs`.
 */
import { byCodePoint } from './prefix-order.mjs';

/**
 * ⚠️ BYTE-IDENTICAL TO lib/search.mjs ON PURPOSE, AND GUARDED BY A TEST.
 *
 * Two ideas about which directories exist IS the bug: the map would tell the
 * model a file is absent that `search_text` can find, or list one that
 * `find_files` will never return. The drift guard in the test suite reads
 * search.mjs's declaration and compares. If you change one, change both.
 */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.vercel', 'coverage', '.turbo']);

/** Hidden DIRECTORIES that are ordinary source. Same list, same reasons. */
export const HIDDEN_DIRS_ALLOWED = new Set(['.github', '.vscode', '.husky', '.circleci', '.changeset', '.storybook']);

/**
 * ⚠️ HIDDEN FILES ARE WITHHELD BY DEFAULT, and this allowlist is the exception.
 *
 * The default has to be "withhold", because hidden files are overwhelmingly
 * config and credentials — `.env`, `.netrc`, `.pgpass`, `.npmrc`. An allowlist
 * is safe by construction in a way a denylist never is: a file nobody thought
 * of is excluded rather than leaked.
 *
 * ⭐ `.gitignore` earns its place because the model is repeatedly asked to add
 * a line to it, and a file it cannot see is a file it will recreate from
 * scratch and clobber.
 */
export const HIDDEN_FILES_ALLOWED = new Set([
  '.gitignore', '.gitattributes', '.gitmodules', '.dockerignore',
  '.editorconfig', '.nvmrc', '.node-version', '.prettierrc', '.eslintrc',
]);

/** Extensions we will try to read for symbols. Everything else yields nothing. */
/**
 * ── ⚠️⭐ NINE EXTENSIONS WAS THE BLIND SPOT, AND THE BENCH CORPUS NAMED IT ────
 *
 * MEASURED 2026-08-29 over the 139 terminal-bench runs in
 * `bench/terminal-bench/results/`: the single worst hunt in the corpus is
 * `full-89/fix-ocaml-gc__FvY8K7u`, which spent **8 of its 10 rounds** answering
 * "where is `pool_sweep` defined?" — two `find_files`, four `search_text` and
 * four `read_lines` — and then died on budget without making one edit. It
 * carried the SECOND LARGEST repo map in the whole corpus (~24.2k first-round
 * prompt tokens against a 13.1k median).
 *
 * ⭐ THE MAP WAS THERE, IT WAS HUGE, AND IT WAS NECESSARILY 100% BARE PATHS —
 * because that repository is C and OCaml, and this list held neither `.c` nor
 * `.ml`. `symbolsShown` for that run could not have been anything but zero. The
 * second-worst hunt, `deep100/build-cython-ext__X7sxaLN` (a seven-round
 * `list_dir`/`read_file` crawl through 25KB of source to find one identifier),
 * is Cython — `.pyx`, also absent.
 *
 * ⚠️ AND THE COST OF THE LIST BEING SHORT IS NOT "SLIGHTLY WORSE", IT IS
 * SILENT. An ineligible file renders as a bare path, which is exactly what a
 * file that genuinely defines nothing renders as. The model cannot tell "we did
 * not look" from "there is nothing there" — the same failure this module's
 * header indicts for invisible FILES, one level down, at the symbol.
 *
 * ⚠️ EVERY GROUP BELOW IS FIXTURE-TESTED (`repo-map-languages.test.mjs`) and
 * every group obeys the same rule the four originals do: RETURN NOTHING RATHER
 * THAN GARBAGE. A language whose pattern is unsure emits no name, because a
 * wrong name sends the model somewhere that does not exist.
 */
const SYMBOL_EXT = /\.(mjs|cjs|jsx?|tsx?|mts|cts|py|pyx|pxd|go|rs|c|h|cc|cpp|cxx|hpp|hh|ml|mli|java|cs|rb|php|sh|bash|zsh|kt|kts|swift|lua|vue|svelte|sql)$/i;

/** Source we would rather show than an asset when the budget is tight. */
const SOURCE_EXT = /\.(mjs|cjs|jsx?|tsx?|mts|cts|py|go|rs|rb|php|java|kt|swift|cs|c|h|cc|cpp|hpp|sql|sh|vue|svelte|css|scss|html)$/i;

/** Config and prose: worth listing, not worth crowding out a source file. */
const DOC_EXT = /\.(json|ya?ml|toml|ini|md|mdx|txt|env\.example)$/i;

/** Directories whose name answers "where are the tests". */
const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'e2e', 'testing']);

/**
 * ── ⚠️⚠️⭐ THE SCRIPT LIST WAS ALPHABETICAL, AND IT HID `npm test` ───────────
 *
 * The old line was `Object.keys(pkg.scripts).sort(byCodePoint).slice(0, 6)`.
 * Alphabetical order is not importance order — that is the argument this
 * module's own header makes about FILES, and the scripts list was doing exactly
 * what it condemns.
 *
 * ⚠️ MEASURED ON `console/`. It has 16 scripts. The first six alphabetically:
 *
 *     bench · bench:all · bench:apps · bench:creative · bench:creative:all ·
 *     bench:creative:selftest
 *
 * Six spellings of one verb, and `test`, `build`, `lint`, `dev`, `start` and
 * `type-check` were ALL cut. **A model that cannot see the project's own test
 * command cannot verify its work** — it invents one, runs `npm run tests`, gets
 * "missing script", and concludes the repo has no tests.
 *
 * ⚠️ AND THIS REPO SURVIVED BY ONE SLOT, WHICH IS WHY NOBODY SAW IT. We have
 * exactly six scripts (`bundle`, `bundle:mcp`, `machine`, `machine:stop`,
 * `test`, `test:raw`), so `test` was the sixth and made the cut by luck. Add one
 * script sorting before it and `npm test` disappears from our own map.
 *
 * ⭐ SO THE LIST IS RANKED BY WHAT AN AGENT NEEDS, and the ranking is ordered by
 * that need: how do I verify (`test`), how do I build it, how do I check it, how
 * do I run it. `format` last because it changes files rather than reporting on
 * them.
 */
export const SCRIPT_VERBS = Object.freeze([
  'test', 'build', 'lint', 'typecheck', 'type-check', 'check',
  'verify', 'e2e', 'dev', 'start', 'format',
]);

/**
 * ⭐ 8, NOT 6, AND THE NUMBER IS THE SMALLER HALF OF THE FIX. Eleven ranked
 * verbs cannot all fit, and that is fine — but six could not even hold the four
 * that matter alongside anything project-specific. A script line is ~30
 * characters, so the whole section costs ~70 tokens: it is not what the budget
 * is fighting over.
 */
export const MAX_SCRIPTS_SHOWN = 8;

/**
 * Choose which scripts to show.
 *
 * ⭐ THE SECOND RULE IS WHAT ACTUALLY KILLED `console/`: after the ranked verbs,
 * remaining slots take at most ONE script per `:` family. `bench:all` tells a
 * model nothing it did not learn from `bench`, and six of them told it nothing
 * six times while pushing out `test`. A family is the part before the first `:`.
 *
 * ⚠️ IT RETURNS THE OMITTED COUNT because a truncated list that does not say it
 * is truncated is the same lie the FILES section refuses to tell.
 */
export function rankScripts(names, max = MAX_SCRIPTS_SHOWN) {
  const all = [...new Set(names)].sort(byCodePoint);
  const chosen = [];
  const taken = new Set();
  for (const verb of SCRIPT_VERBS) {
    if (chosen.length >= max) break;
    if (!all.includes(verb) || taken.has(verb)) continue;
    chosen.push(verb);
    taken.add(verb);
  }
  const families = new Set(chosen.map((n) => n.split(':')[0]));
  for (const name of all) {
    if (chosen.length >= max) break;
    if (taken.has(name)) continue;
    const family = name.split(':')[0];
    if (families.has(family)) continue;
    chosen.push(name);
    taken.add(name);
    families.add(family);
  }
  return { chosen, omitted: all.length - chosen.length };
}

/**
 * ⚠️ NEVER READ FOR SYMBOLS ABOVE THIS. A 900KB generated bundle is not a file
 * whose export list helps anyone, and reading it costs real milliseconds per
 * entry across a big tree.
 *
 * ⚠️⚠️ IT WAS 512 KiB (copied from search.mjs) AND IT CAUGHT THE CORE MODULE.
 * `lib/turn.mjs` crossed 512 KiB on 2026-09-26, left the graph, scored 0 and
 * ranked LAST of 175 lib files — the map of this repo stopped naming the agent
 * loop. A file above this line is not merely unlisted-with-symbols, it is
 * RANKED AS NOTHING, so the ceiling must sit above real hand-written source
 * and below the bundle shape. `search.mjs` keeps 512 KiB: it SAYS when it skips.
 */
const MAX_SYMBOL_FILE_BYTES = 768 * 1024;

/** A pathological file cannot produce a thousand-symbol line. */
const MAX_SYMBOLS_PER_FILE = 64;
/** …and the RENDERED line is shorter still, because the model pays per token. */
const MAX_SYMBOLS_SHOWN = 6;

/**
 * ⚠️ THE WALK IS BOUNDED BY ENTRY COUNT, NOT BY DEPTH — that inversion is the
 * whole point of this module. Depth is what made the old pre-read blind; a
 * count is what actually protects against a pathological tree.
 */
export const DEFAULT_MAX_ENTRIES = 12_000;

/** A depth cap exists only so a symlink cycle cannot hang the process. */
const MAX_DEPTH = 24;

/**
 * ── ⚠️⚠️⭐ THE SYMBOL GRAPH HAS A CEILING, AND UNTIL 2026-08-26 IT WAS SILENT ──
 *
 * Symbols are extracted for the highest-priority files only; reads are not free.
 * That much was always true and is still the right trade. What was missing is
 * that on a large repository this ceiling BINDS HARD, and the ranking that
 * decides the order of the entire map is then computed on a fraction of the
 * evidence — with nothing, anywhere, saying so.
 *
 * ⚠️⚠️ MEASURED 2026-08-26, walking three real trees with this module's own
 * `orderForBudget` and counting how much of the symbol graph the ceiling admits:
 *
 *     tree                     files   symbol-eligible   in the graph   coverage
 *     console/                 2,854             2,470            759      30.7%
 *     the enclosing worktree   9,649             6,537            737      11.3%
 *     acuvo-code (this one)      545               459            459     100.0%
 *
 * ⭐ SO EVERY LOCAL MEASUREMENT SAID THE GRAPH WAS COMPLETE, because on THIS
 * package it is. This is the identical shape as the cross-task prefix defect
 * recorded further down ("it was invisible on this repository, which is why it
 * survived"): the regime that matters exists only on customer-sized trees, and
 * we do not have one checked out. 88.7% of the worktree's symbol graph is
 * missing and the map reports `rankEdges` as though that were the whole story.
 *
 * ── ⭐ THREE THINGS CHANGED, AND ONLY ONE OF THEM TOUCHES THE PROMPT ─────────
 *
 *   1. THE CEILING IS NOW A CAP ON *READS*, NOT ON SLOTS. The loop used to
 *      `slice(0, 800)` the baseline and only then test `SYMBOL_EXT` and the size
 *      limit, so a `.css`, a `.sql` or a 900KB bundle consumed one of the 800
 *      slots and returned nothing. ⚠️ MEASURED: 41 slots burned that way on
 *      `console/` and 63 on the worktree — the ceiling was quietly delivering
 *      737–759 files where it promised 800. Filtering BEFORE the slice costs
 *      nothing (an ineligible file never cost a read; it cost a slot) and is the
 *      only change here that can move a prompt byte, because a slightly larger
 *      graph is a slightly different ranking.
 *
 *   2. IT IS INJECTABLE (`opts.maxSymbolReads`). This module's header promises
 *      "EVERY IMPL IS INJECTED … so every property above is provable with data",
 *      and this constant was the one exception — which is why NO test in the
 *      suite has ever exercised the capped regime. The largest fixture anywhere
 *      in the repo-map tests is 2,000 files whose contents are the single
 *      character `x`: no exports, no identifiers, an EMPTY graph. The cliff was
 *      not merely untested, it was untestable without building an 800-file
 *      fixture with real cross-references. It is now one option away.
 *
 *   3. IT REPORTS ITSELF (`stats.graphFiles` / `graphFilesTotal` /
 *      `graphCapped`). ⚠️ STATS ONLY — DELIBERATELY NOT RENDERED. The honest
 *      instinct is to print "the symbol graph covered 759 of 2,470 files" into
 *      the map, and it is the wrong one twice over: it is an OPERATOR fact the
 *      model cannot act on, and `renderMap`'s own header records, with a
 *      measurement, that every fixed byte of prose is a file line the budget can
 *      no longer afford (61 bytes once bought the deepest directory band out of
 *      a fixture). `rankEdges`, `rankSeeds` and `rankIterations` set the
 *      precedent — the ranker's receipts live in `stats` and never in the
 *      prompt — and this follows it exactly.
 *
 * ⚠️ THE NUMBER ITSELF IS UNCHANGED AT 800, AND THAT IS ON PURPOSE. Raising it
 * is a wall-clock decision, not a correctness one: `repo-index.mjs` measured the
 * identical work at 2,506ms cold on a 2,400-file tree with identifiers on,
 * against ~550ms for the whole map today. Whether the extra coverage buys a
 * DIFFERENT map is now a question a test can answer instead of a guess — which
 * is the entire point of (2), and is the honest order to do this in.
 */
export const DEFAULT_MAX_SYMBOL_READS = 800;

/** How many directories the omission report names before it stops. */
const MAX_GAP_LINES = 10;

/**
 * ── ⭐ THE DEFAULT IS A MEASUREMENT, NOT A ROUND NUMBER ─────────────────────
 *
 * Measured against `gatherWorkspaceContext` on two real trees:
 *
 *   this repo (144 files) — old: 9,627 tokens for 12 file BODIES and a
 *                                two-level tree
 *                           new: 2,554 tokens for ALL 144 paths + symbols
 *   console/ (2,246 files) — old: 10,889 tokens, still 12 bodies, ~5% of paths
 *                            new at 6,000: 638 paths, 44 symbol lists
 *
 * So 6,000 is CHEAPER than what the old pre-read actually spent on both, and
 * buys an order of magnitude more coverage.
 *
 * ⭐ AND IT IS CHEAPER STILL ON EVERY ROUND AFTER THE FIRST. The map is
 * byte-identical run to run by construction, so it sits inside the cached
 * prompt prefix — 3.05x on DeepSeek. A stable 6,000 tokens costs about what an
 * unstable 2,000 does, which is exactly why determinism was worth building.
 *
 * ── ⚠️ RAISED 6,000 → 9,000 (2026-08-16). THE REASONING ABOVE IS ALL STILL
 *    TRUE; IT WAS JUST ANSWERING A DIFFERENT QUESTION ─────────────────────────
 *
 * Every number above is a comparison against the OLD pre-read, and against that
 * baseline 6,000 wins easily. It was never checked against the only question
 * that matters on a big repo — how much of the tree actually arrives. Measured
 * on `console/` (2,406 files) at 6,000: **659 files listed, and they came from
 * 7 of the 360 directories.** Nothing below depth 1 was visible at all.
 *
 * ⭐ THE ORDERING WAS THE BULK OF THAT (see `orderForBudget`) and its fix is
 * free. The raise is the smaller, second lever, and it is defensible on the same
 * ground the original number was chosen on: **9,000 is still below what the
 * pre-read this module replaced actually spent on BOTH trees** (9,627 and
 * 10,889). We have not made round 1 more expensive than the thing we deleted.
 *
 * ⚠️⚠️ AND IT IS A CEILING, NOT A SPEND — which is the whole reason the raise
 * is cheap. Measured: this repo's own 344 files render in 5,701 tokens, so they
 * fit under the OLD 6,000 with room to spare and cost exactly the same after the
 * raise as before it. Nothing changes for any repo that already fitted. The
 * extra tokens are spent only where the map was blind, which is precisely the
 * case that was paying 6,000 tokens to see 1.9% of the directories.
 */
export const DEFAULT_BUDGET_TOKENS = 9_000;

/**
 * ── ⭐ HOW MUCH OF THE BUDGET THE *QUESTION* MAY SPEND ──────────────────────
 *
 * See the ranking pass in `buildRepoMap` for the measurement. The first
 * `1 - TASK_TRANCHE_SHARE` of the map is chosen by a task-INVARIANT ranking and
 * is therefore byte-identical for every task in the repository; this share is
 * what the personalized ranking gets to spend on files the request itself named.
 *
 * ⚠️ IT IS RESERVED, NOT SPENT. With no seeds the reservation is zero and the
 * whole budget goes to the invariant tranche, so a task that names nothing gets
 * exactly the map it got before this existed.
 */
export const TASK_TRANCHE_SHARE = 0.25;

/**
 * ── ⚠️⚠️⭐ THE SHARE THAT PATHS MAY NOT SPEND, AND WHY IT HAD TO EXIST ───────
 *
 * MEASURED 2026-08-29, production code, two real trees:
 *
 *     tree                       files   paths listed   SYMBOL LISTS IN PROMPT
 *     console/                   3,443            687                        0
 *     the enclosing worktree     9,652            679                        0
 *
 * ⭐⭐ ZERO. NOT "FEW" — ZERO, ON EVERY REPOSITORY BIG ENOUGH TO TRUNCATE. And
 * the symbols were not missing, they were DISCARDED: 596 of the 687 files
 * console rendered (86.8%) had a symbol list already extracted and sitting in
 * memory when the map was built. We paid the reads and threw the answer away.
 *
 * ⭐ THE CAUSE IS ONE COMPARISON. The fit ran `symCount = fitSymbols(take)`
 * FIRST, then dropped paths until `used <= staticBudget` — so the drop loop
 * stopped at the exact instant paths alone filled the budget, and the
 * "dropping paths freed room; hand it back to symbols" pass that follows had,
 * by construction, nothing to hand back. Symbols were structurally last in the
 * queue and the queue always ran out.
 *
 * ⚠️ AND IT WAS INVISIBLE HERE. `acuvo-code` fits inside the budget, takes the
 * `take === ordered.length` branch, and shows 142 symbol lists — so every
 * measurement taken on this package said the feature worked. Same shape as the
 * graph ceiling above it: the regime that matters only exists on trees we do
 * not have checked out.
 *
 * ⭐ WHAT THE RESERVATION BUYS, MEASURED ACROSS THE SWEEP (console / worktree):
 *
 *     share   paths       symbol lists
 *     0.00    687 / 679          0 / 0    ← what shipped
 *     0.15    603 / 606         96 / 77
 *     0.25    547 / 560        187 / 127
 *     0.40    512 / 496        267 / 216
 *
 * ⚠️ 0.25 IS A JUDGEMENT AND IT IS THE CONSERVATIVE END OF THE CURVE. It keeps
 * ~80% of the paths the old map listed and takes the map from nothing to 187
 * annotated files. The paths it gives up are the LOWEST-ranked ones — the tail
 * of a PageRank ordering, on a tree where coverage was already 20% — and the
 * symbols it buys land on the HIGHEST-ranked files. That asymmetry is the whole
 * argument; without the ranking underneath it this trade would not be safe.
 *
 * ⚠️ IT IS A RESERVATION, NOT A SPEND, AND IT IS TASK-INVARIANT. A tree that
 * fits never reaches the branch that reads it, so nothing changes for a small
 * repository. It is a fraction of a constant budget, so `symCount` remains a
 * pure function of (tree, budget) and the cross-task prefix is untouched.
 */
export const SYMBOL_RESERVE_SHARE = 0.25;

/**
 * A mention that resolves to more files than this is naming a FILENAME, not a
 * file — `index.mjs` is not a reference to one module. See `namedFiles`.
 */
const MAX_FILES_PER_MENTION = 4;

/** And no sentence names more files than this. A cap, never a target. */
const MAX_NAMED_RELISTED = 8;

/**
 * ── THE TOKEN ESTIMATE ──────────────────────────────────────────────────────
 *
 * Deliberately crude, deliberately PESSIMISTIC. ~3.5 chars per token rather
 * than the usual 4, because paths tokenize worse than prose: every `/`, `-`
 * and `.` is a boundary. Under-estimating means the real prompt overruns the
 * budget the caller set, which is the failure that matters here.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3.5);
}


// ─────────────────────────────────────────────────────────────────────────────
// .gitignore
//
// ⚠️ THE OLD PRE-READ IGNORED .gitignore ENTIRELY, and therefore shipped the
// CONTENTS of gitignored files to the model provider. Those files are
// gitignored for a reason and the reason is frequently "it has a secret in it".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a `.gitignore` into ordered rules. Blank lines and comments vanish;
 * ORDER SURVIVES, because in git the LAST matching rule wins and a negation
 * that arrives before its pattern means nothing.
 */
export function parseGitignore(text) {
  const rules = [];
  if (typeof text !== 'string') return rules;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, '');
    if (line === '') continue;
    if (line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\#') || line.startsWith('\\!')) {
      // An escaped leading `#` or `!` is a LITERAL first character, not syntax.
      line = line.slice(1);
    }
    if (line === '') continue;
    rules.push({ pattern: line, negate, dirOnly: line.endsWith('/') });
  }
  return rules;
}

/**
 * Glob → regex source, with the one reading everyone else uses: `*` does not
 * cross a slash, and `**` spans ZERO OR MORE directories.
 *
 * ⚠️ THE ZERO CASE IS THE BUG search.mjs ALREADY FIXED ONCE. `docs/**"/"draft.md`
 * must match `docs/draft.md`. Reading `**` as "one or more" makes the pattern
 * silently miss the commonest case.
 */
function globSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const prevIsSlash = i === 0 || glob[i - 1] === '/';
        const nextIsSlash = glob[i + 2] === '/';
        if (prevIsSlash && nextIsSlash) {
          out += '(?:.*/)?';
          i += 2; // consume the second `*` and the `/` the group already covers
          continue;
        }
        out += '.*';
        i += 1;
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (c === '?') { out += '[^/]'; continue; }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

function compileRule(rule) {
  let p = rule.pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  // A leading slash anchors to the ignore file's own directory. So does an
  // interior slash — that is git's rule, not an approximation of it.
  let anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (p.includes('/')) anchored = true;
  return { rx: new RegExp(`^${globSource(p)}$`), anchored, dirOnly, negate: rule.negate };
}

/**
 * Build a matcher: `(relPath, isDir) => boolean`.
 *
 * ⭐ ANCESTORS ARE CHECKED SEPARATELY, and that is not an optimisation — it is
 * the semantics. `src/generated/` ignores `src/generated/x.js`, and the walk is
 * not the only caller, so the matcher cannot rely on "we never descended".
 */
export function makeIgnoreMatcher(rules) {
  const compiled = rules.map(compileRule);
  if (compiled.length === 0) return () => false;

  /** @returns {boolean | undefined} the last matching rule's verdict, or none. */
  const verdict = (rel, isDir) => {
    let out;
    for (const r of compiled) {
      if (r.dirOnly && !isDir) continue;
      if (r.anchored) {
        if (r.rx.test(rel)) out = !r.negate;
        continue;
      }
      // Unanchored: match the whole path or any trailing segment sequence.
      if (r.rx.test(rel)) { out = !r.negate; continue; }
      let hit = false;
      for (let i = 0; i < rel.length; i++) {
        if (rel[i] !== '/') continue;
        if (r.rx.test(rel.slice(i + 1))) { hit = true; break; }
      }
      if (hit) out = !r.negate;
    }
    return out;
  };

  return (rel, isDir = false) => {
    const own = verdict(rel, isDir);
    if (own !== undefined) return own;
    // No rule spoke about this path. An ignored ANCESTOR still buries it.
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      if (verdict(ancestor, true) === true) return true;
    }
    return false;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SYMBOLS — a regex guess, labelled as one
// ─────────────────────────────────────────────────────────────────────────────

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** SQL alone names things `schema.table`, and the qualifier is load-bearing. */
const SQL_NAME = /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*$/;
/**
 * ⚠️ RUBY PUTS THE PREDICATE AND THE BANG IN THE NAME. `empty?` and `save!` are
 * the real identifiers; validating them against the bare identifier rule drops
 * exactly the methods a reader is most likely to go looking for.
 */
const RB_NAME = /^[A-Za-z_]\w*[?!=]?$/;
/** The C family, which shares one pattern set and one keyword rejection list. */
const C_EXT = new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh']);
/** Words a naive regex catches that are syntax, not names. */
const NOT_A_NAME = new Set(['default', 'from', 'as', 'function', 'class', 'const', 'let', 'var', 'async', 'type', 'interface', 'enum']);

const JS_PATTERNS = [
  /^\s*export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*exports\.([A-Za-z_$][\w$]*)\s*=/gm,
];
/** `export { a, b as c }` and `module.exports = { a, b }` — a LIST, not a name. */
const JS_LIST_PATTERNS = [
  /^\s*export\s*\{([^}]*)\}/gm,
  /^\s*module\.exports\s*=\s*\{([^}]*)\}/gm,
];

/**
 * ⚠️ `^\s*`, NOT `^`, AND THAT IS THE FIX NOT THE TYPO. Anchored at column 0
 * this matched module-level `def` and `class` only, so every METHOD in every
 * Python class in the workspace was invisible — and `find_symbol`'s own tool
 * description promises "a function, class, const, type, struct or method".
 */
const PY_PATTERNS = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
  /^\s*class\s+([A-Za-z_]\w*)/gm,
];
/** Cython is Python plus `cdef`/`cpdef`, and the bench's #2 hunt was in it. */
const PYX_PATTERNS = [
  ...PY_PATTERNS,
  /^\s*(?:cdef|cpdef)\s+(?:class\s+)?(?:[\w*\[\], ]+\s+)?([A-Za-z_]\w*)\s*[(:]/gm,
];
const GO_PATTERNS = [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)/gm];
/** ⚠️ `pub(crate)` / `pub(super)` matched NOTHING — `pub\s+` needs the space. */
const RS_PATTERNS = [
  /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/gm,
  /^\s*pub(?:\([^)]*\))?\s+(?:struct|enum|trait|mod|type|const|static|union)\s+([A-Za-z_]\w*)/gm,
  /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/gm,
];

/**
 * ── C / C++ / HEADERS — the language the corpus's worst hunt was written in ──
 *
 * ⚠️ THE RETURN TYPE MUST START AT COLUMN 0 and the parameter list must contain
 * no parentheses of its own. That is deliberately strict: it is how a C
 * DEFINITION or PROTOTYPE is conventionally written and how a CALL inside a
 * function body (always indented) is not, so the common false positive — every
 * `foo(bar)` in the file — cannot match. A function pointer parameter defeats
 * it and that file simply contributes fewer names, which is the correct way to
 * be wrong here.
 *
 * ⚠️ A BARE `#define` IS DELIBERATELY NOT A SYMBOL. Measured on
 * `cffi/parse_c_type.h`: including constant macros took that header from 4
 * names to 98, and because names are sorted and the map shows six, all four
 * real functions were pushed out by `_CFFI_PRIM_*` enum constants. Only
 * FUNCTION-LIKE macros survive — those are callable, so they are what somebody
 * looking for a definition is actually looking for.
 */
const C_PATTERNS = [
  /^[A-Za-z_][A-Za-z0-9_ \t*&<>,:\[\]]*?\b([A-Za-z_]\w*)\s*\([^;()]*\)\s*(?:\{|;|$)/gm,
  /^\s*(?:typedef\s+)?(?:struct|union|enum|class|namespace)\s+([A-Za-z_]\w*)/gm,
  /^\s*#\s*define\s+([A-Za-z_]\w*)\(/gm,
];
/** Control flow reads exactly like a call. It is never a definition. */
const C_NOT_A_NAME = new Set([
  'if', 'for', 'while', 'switch', 'return', 'sizeof', 'do', 'else', 'defined',
  'case', 'catch', 'and', 'or', 'not', 'alignof', 'typeof', 'static_assert',
]);

const ML_PATTERNS = [
  /^\s*let\s+(?:rec\s+)?([a-z_]\w*)/gm,
  /^\s*(?:val|external)\s+([a-z_]\w*)/gm,
  /^\s*type\s+(?:'\w+\s+)?([a-z_]\w*)/gm,
  /^\s*(?:module|exception)\s+([A-Za-z_]\w*)/gm,
];

/** Java and C# share a shape: a modifier run, then a kind or a return type. */
const JVM_DECL = '(?:public|protected|private|internal|static|final|abstract|sealed|override|virtual|partial|async|suspend|open|data|inline|native|synchronized|readonly|unsafe|extern)';
/**
 * ⚠️ THE RETURN TYPE MAY CONTAIN SPACES AND THE FIRST VERSION FORBADE THEM.
 * `[\w.<>\[\],?]+` looks like it covers a generic, and it does — right up to
 * `Map<String, Integer>`, where the space after the comma ends the match and
 * the whole method vanishes. Generic arguments therefore get their own group
 * that is allowed to contain anything but a bracket or a parenthesis.
 */
const JVM_TYPE = '[\\w.]+(?:<[^<>()]*>)?(?:\\s*\\[\\s*\\])*';
const JVM_METHOD = `^\\s+(?:${JVM_DECL}\\s+)+(?:<[^<>()]+>\\s*)?${JVM_TYPE}\\s+([A-Za-z_]\\w*)\\s*\\(`;
const JAVA_PATTERNS = [
  new RegExp(`^\\s*(?:${JVM_DECL}\\s+)*(?:class|interface|enum|record|@interface)\\s+([A-Za-z_]\\w*)`, 'gm'),
  new RegExp(JVM_METHOD, 'gm'),
];
/**
 * ⚠️ `namespace` IS DELIBERATELY NOT HERE. It is dotted (`App.Core`), so the
 * capture would emit `App` — a name that is not declared anywhere and that
 * `find_symbol` would then answer with. A wrong name is worse than no name.
 */
const CS_PATTERNS = [
  new RegExp(`^\\s*(?:${JVM_DECL}\\s+)*(?:class|interface|enum|struct|record)\\s+([A-Za-z_]\\w*)`, 'gm'),
  new RegExp(JVM_METHOD, 'gm'),
];
const KT_PATTERNS = [
  new RegExp(`^\\s*(?:${JVM_DECL}\\s+)*fun\\s+(?:<[^>]+>\\s*)?(?:[\\w.<>]+\\.)?([A-Za-z_]\\w*)`, 'gm'),
  new RegExp(`^\\s*(?:${JVM_DECL}\\s+)*(?:class|object|interface|enum class)\\s+([A-Za-z_]\\w*)`, 'gm'),
];
const SWIFT_PATTERNS = [
  /^\s*(?:(?:public|private|internal|fileprivate|open|static|final|override|mutating|class)\s+)*func\s+([A-Za-z_]\w*)/gm,
  /^\s*(?:(?:public|private|internal|fileprivate|open|final)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/gm,
];
const RB_PATTERNS = [
  /^\s*def\s+(?:self\.)?([a-z_]\w*[?!=]?)/gm,
  /^\s*(?:class|module)\s+([A-Z]\w*)/gm,
];
const PHP_PATTERNS = [
  /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)/gm,
  /^\s*(?:(?:abstract|final)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/gm,
];
/** Both shell function forms. A name is only a name when a `{` follows it. */
const SH_PATTERNS = [
  /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/gm,
  /^\s*function\s+([A-Za-z_][\w-]*)\s*\{/gm,
];
const LUA_PATTERNS = [/^\s*(?:local\s+)?function\s+(?:[\w.:]+[.:])?([A-Za-z_]\w*)/gm];
/**
 * ⚠️ SQL NAMES ARE THE ONE CASE WHERE THE SCHEMA PREFIX MATTERS, so the capture
 * keeps it — `public.users` and `audit.users` are two different tables and
 * emitting `users` twice would say they are one.
 */
const SQL_PATTERNS = [
  /^\s*create\s+(?:or\s+replace\s+)?(?:global\s+|local\s+|temp\s+|temporary\s+|unique\s+|materialized\s+|recursive\s+)*(?:table|view|function|procedure|index|type|trigger|schema|sequence)\s+(?:if\s+not\s+exists\s+)?["`\[]?([A-Za-z_][\w.$]*)/gim,
];

/**
 * Exported symbol names for one file, by regex.
 *
 * ⚠️ IT RETURNS NOTHING RATHER THAN GARBAGE for a file it does not understand.
 * A markdown file containing the words "export function" is not a module, and
 * emitting `fake` from it would be worse than emitting nothing — the model
 * would go looking for a symbol that never existed.
 */
export function extractExports(path, source) {
  if (typeof source !== 'string' || source === '') return [];
  if (!SYMBOL_EXT.test(path)) return [];
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();

  const found = new Set();
  /**
   * ⚠️ `shape` IS A PARAMETER BECAUSE ONE LANGUAGE DISAGREES ABOUT WHAT A NAME
   * IS. Every other grammar here names things with a bare identifier; SQL names
   * them `schema.table`, and `public.users` is not the same object as
   * `audit.users`. Validating SQL against the identifier rule would silently
   * drop every qualified name — the majority of them in any real migration.
   */
  const add = (name, shape = IDENT) => {
    const n = String(name).trim();
    if (!shape.test(n)) return;
    if (NOT_A_NAME.has(n)) return;
    found.add(n);
  };

  const run = (patterns, reject = null, shape = IDENT) => {
    for (const rx of patterns) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(source)) !== null) {
        if (reject !== null && reject.has(m[1])) continue;
        add(m[1], shape);
      }
    }
  };

  /**
   * ⚠️ ORDER MATTERS ONLY IN THAT `.vue` AND `.svelte` FALL THROUGH TO THE JS
   * ARM DELIBERATELY. A single-file component is markup wrapped around a
   * `<script>` block, and the JS patterns are already anchored to line starts —
   * they find the component's exports and ignore the template.
   */
  if (ext === 'py') run(PY_PATTERNS);
  else if (ext === 'pyx' || ext === 'pxd') run(PYX_PATTERNS);
  else if (ext === 'go') run(GO_PATTERNS);
  else if (ext === 'rs') run(RS_PATTERNS);
  else if (C_EXT.has(ext)) run(C_PATTERNS, C_NOT_A_NAME);
  else if (ext === 'ml' || ext === 'mli') run(ML_PATTERNS);
  else if (ext === 'java') run(JAVA_PATTERNS, C_NOT_A_NAME);
  else if (ext === 'cs') run(CS_PATTERNS, C_NOT_A_NAME);
  else if (ext === 'kt' || ext === 'kts') run(KT_PATTERNS);
  else if (ext === 'swift') run(SWIFT_PATTERNS);
  else if (ext === 'rb') run(RB_PATTERNS, null, RB_NAME);
  else if (ext === 'php') run(PHP_PATTERNS);
  else if (ext === 'sh' || ext === 'bash' || ext === 'zsh') run(SH_PATTERNS);
  else if (ext === 'lua') run(LUA_PATTERNS);
  else if (ext === 'sql') run(SQL_PATTERNS, null, SQL_NAME);
  else {
    run(JS_PATTERNS);
    for (const rx of JS_LIST_PATTERNS) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(source)) !== null) {
        for (const piece of m[1].split(',')) {
          const parts = piece.trim().split(/\s+as\s+/);
          add(parts[parts.length - 1]);
        }
      }
    }
  }

  return [...found].sort(byCodePoint).slice(0, MAX_SYMBOLS_PER_FILE);
}

// ─────────────────────────────────────────────────────────────────────────────
// RANK — personalized PageRank over the symbol graph
//
// ── ⭐⭐ ALPHABETICAL IS NOT RELEVANCE ORDER, AND THIS FILE SAID SO FIRST ─────
//
// The header of this module indicts `gatherWorkspaceContext` for listing files
// in ALPHABETICAL order, because "alphabetical order is not relevance order".
// It was right, and then every ordering decision below it — which file a
// directory contributes first, which files survive a tight budget, which files
// are worth a symbol list — was settled by `byCodePoint` on the PATH. That is
// alphabetical order wearing a different hat.
//
// ⭐ WHAT REPLACES IT, AND WHERE IT CAME FROM. Aider (Apache-2.0) ranks a repo
// map with PERSONALIZED PAGERANK over a symbol graph: nodes are files, edges run
// reference → definition, and the personalization vector biases the walk toward
// the files the user actually named. This is a REIMPLEMENTATION from that
// published description — sparse power iteration, ~150 lines, zero
// dependencies. No Python was copied; Apache-2.0 would have permitted it, but
// the algorithm is the valuable part and it is three paragraphs long.
//
// ⭐ WHY PAGERANK AND NOT "COUNT THE REFERENCES". A raw reference count says
// `utils.js` is important because 40 files import it. PageRank says a file is
// important when IMPORTANT files reference it — the rank flows along the edges,
// so a helper used only by dead code sinks and a helper used by the entry point
// rises. That recursion is the whole reason the algorithm exists.
//
// ⚠️⚠️ THE INVARIANT THAT OUTRANKS THE FEATURE: DETERMINISM. This module's
// header treats byte-identical output as load-bearing for the cached prompt
// prefix, and it is worth 3.05x. Floating point is where a ranker leaks
// non-determinism, so four things are pinned, all of them here and none of them
// left to chance:
//
//   1. NODE IDS COME FROM A CODE-POINT SORT. Every array below is indexed by
//      that id, so the ORDER of every float accumulation is a property of the
//      paths and not of `readdir`, of a Map's insertion history, or of which
//      files happened to be read first.
//   2. EDGES ARE MATERIALISED SORTED BY TARGET ID. `a + b + c` and `c + b + a`
//      are different doubles. Fixing the summation order fixes the double.
//   3. THE ITERATION COUNT IS BOUNDED AND THE TOLERANCE IS A CONSTANT. Both are
//      pure functions of the input, so "how many iterations did it take" cannot
//      vary between two runs over the same tree. There is no wall clock and no
//      time budget anywhere in the loop — a deadline would make the answer
//      depend on how busy the machine was, which is exactly the bug.
//   4. SCORES ARE QUANTISED BEFORE THEY ARE COMPARED. Two files whose true
//      ranks differ by 1e-15 must not swap places on a rebuild; rounding to a
//      fixed quantum turns "almost equal" into "equal", and equal falls through
//      to the code-point tiebreak that was always there.
//
// ⚠️ AND IT IS ADDITIVE. With no graph and no mentions, every score is
// identical, every comparison ties, and the order falls through to exactly the
// comparator that shipped before this block existed. A repo of prose ranks the
// same as it always did.
// ─────────────────────────────────────────────────────────────────────────────

/** The standard damping factor. 0.85 is PageRank's own published constant. */
export const RANK_DAMPING = 0.85;

/**
 * ⚠️ A HARD CEILING, NOT A TARGET. Power iteration on a damped chain converges
 * geometrically at the damping factor, so 0.85^60 ≈ 6e-5 of the initial error
 * survives 60 rounds — far below the quantum below. The cap exists so a
 * pathological graph cannot spin, never as the normal exit.
 */
export const RANK_MAX_ITERATIONS = 60;

/** The normal exit. A CONSTANT, so the round count is a function of the tree. */
export const RANK_TOLERANCE = 1e-10;

/**
 * ⭐ THE QUANTUM IS THE DETERMINISM GUARD, and it is deliberately coarser than
 * double precision. Ranks on a big repo are ~1/N ≈ 1e-4; rounding at 1e-12
 * keeps eight significant figures of a real difference while collapsing the
 * last-bit noise that would otherwise reshuffle two equally-unimportant files
 * and invalidate the whole cached prefix.
 */
const RANK_QUANTUM = 1e12;

/**
 * How much of the teleport mass goes to the files the user named.
 *
 * ⚠️ NOT 1.0, AND THAT IS A DELIBERATE DEPARTURE. Aider's personalization dict
 * gives unnamed files ZERO teleport probability. That maximises task-focus and
 * it also means a repo where the user named one file has one seed for the
 * entire random walk — every file the graph does not connect to that seed
 * collapses to the same floor and the ordering among them is arbitrary. Keeping
 * 15% uniform preserves a STATIC importance ranking underneath the
 * task-specific one, which is what the budget cut needs when the user's message
 * mentions nothing at all.
 */
const RANK_SEED_SHARE = 0.85;

/**
 * ⚠️ A SYMBOL DEFINED IN MORE FILES THAN THIS IS A WORD, NOT A SYMBOL. `run`,
 * `main`, `handler` and `test` are defined everywhere; an edge to each of forty
 * definers is forty edges of noise. Dropping them bounds the edge count too,
 * which is what keeps this linear on a 12,000-file tree.
 */
const MAX_DEFINERS_PER_SYMBOL = 8;

/** Identifiers scanned per file, and how much of a file is scanned for them. */
const MAX_IDENTIFIERS_PER_FILE = 2_000;
const MAX_REF_SCAN_BYTES = 128 * 1024;

/** Below this length an identifier carries no signal and matches everything. */
const MIN_IDENT_LENGTH = 3;

/** An identifier the user actually typed is worth more than one they did not. */
const MENTIONED_IDENT_WEIGHT = 4;

/**
 * Keywords a bare identifier regex cannot tell from a name. They are never
 * definitions, so an edge built from one is always noise.
 */
const REF_STOPWORDS = new Set([
  'abstract', 'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch',
  'class', 'const', 'constructor', 'continue', 'crate', 'debugger', 'def',
  'default', 'del', 'delete', 'do', 'elif', 'else', 'enum', 'export', 'extends',
  'extern', 'false', 'False', 'final', 'finally', 'fmt', 'fn', 'for', 'from',
  'func', 'function', 'get', 'global', 'go', 'if', 'impl', 'implements',
  'import', 'in', 'instanceof', 'interface', 'is', 'lambda', 'let', 'loop',
  'match', 'mod', 'module', 'move', 'mut', 'new', 'nil', 'none', 'None', 'not',
  'null', 'or', 'package', 'pass', 'private', 'protected', 'pub', 'public',
  'raise', 'range', 'readonly', 'ref', 'require', 'return', 'select', 'self',
  'set', 'static', 'struct', 'super', 'switch', 'this', 'throw', 'trait', 'true',
  'True', 'try', 'type', 'typeof', 'undefined', 'unsafe', 'use', 'using', 'var',
  'void', 'where', 'while', 'with', 'yield',
]);

/**
 * Every identifier a file MENTIONS — the reference half of the graph.
 *
 * ⚠️ IT IS A BAG OF WORDS AND IT IS SUPPOSED TO BE. A parser would tell
 * definitions from uses; a regex cannot, and does not need to, because an
 * identifier only becomes an EDGE when some other file DEFINES it. A word that
 * nobody exports is silently dropped, which is the same "return nothing rather
 * than garbage" rule `extractExports` follows.
 */
export function extractIdentifiers(source) {
  const out = new Set();
  if (typeof source !== 'string' || source === '') return out;
  const text = source.length > MAX_REF_SCAN_BYTES ? source.slice(0, MAX_REF_SCAN_BYTES) : source;
  const rx = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const name = m[0];
    if (name.length < MIN_IDENT_LENGTH) continue;
    if (REF_STOPWORDS.has(name)) continue;
    out.add(name);
    if (out.size >= MAX_IDENTIFIERS_PER_FILE) break;
  }
  return out;
}

/**
 * Pull the file names and the words out of a free-text task description.
 *
 * ⭐ THIS IS THE HALF THAT MAKES THE RANKING TASK-SPECIFIC. Without it PageRank
 * produces a static importance score — better than alphabetical, but the same
 * for every question anyone ever asks. With it, "fix the retry in chain.mjs"
 * seeds the walk at `chain.mjs` and the files that reference it rise with it.
 */
export function parseMentions(task) {
  const files = new Set();
  const words = new Set();
  if (typeof task !== 'string' || task === '') return { files: [], words: [] };
  // Anything that looks like `name.ext` or `a/b/name.ext`, quotes and backticks
  // stripped by the character class rather than by a second pass.
  const fileRx = /[A-Za-z0-9_$.\/-]*[A-Za-z0-9_$-]\.[A-Za-z][A-Za-z0-9]{0,4}\b/g;
  let m;
  while ((m = fileRx.exec(task)) !== null) files.add(m[0].replace(/^\.\//, '').replace(/^\/+/, ''));
  const wordRx = /[A-Za-z_$][\w$]*/g;
  while ((m = wordRx.exec(task)) !== null) {
    const w = m[0];
    if (w.length < MIN_IDENT_LENGTH) continue;
    if (REF_STOPWORDS.has(w)) continue;
    words.add(w);
  }
  // ⚠️ SORTED, so the seed vector cannot depend on where in the sentence the
  // user happened to put a word.
  return { files: [...files].sort(byCodePoint), words: [...words].sort(byCodePoint) };
}

/**
 * Fold every way a caller can express "the user was talking about this" into
 * one shape: `{ task }` free text, `{ mentionedFiles }`, `{ mentionedWords }`.
 *
 * ⚠️ IT TOLERATES THE OPTIONS BEING FOLDED INTO THE SECOND ARGUMENT, for the
 * same reason `budgetTokens` does — a caller who writes
 * `buildRepoMap(root, { task })` means something obvious.
 */
export function normaliseMentions(opts = {}, impls = {}) {
  const task = opts?.task ?? impls?.task;
  const parsed = parseMentions(typeof task === 'string' ? task : '');
  const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x !== '') : []);
  const files = new Set(parsed.files);
  for (const f of asList(opts?.mentionedFiles ?? impls?.mentionedFiles)) files.add(f);
  const words = new Set(parsed.words);
  for (const w of asList(opts?.mentionedWords ?? impls?.mentionedWords)) words.add(w);
  return { files: [...files].sort(byCodePoint), words: [...words].sort(byCodePoint) };
}

/** Does `path` name the file the user mentioned? Basename counts; prefixes do not. */
function pathIsMentioned(path, mention) {
  const m = String(mention ?? '').replace(/^\.\//, '').replace(/^\/+/, '');
  if (m === '') return false;
  if (path === m) return true;
  if (path.endsWith(`/${m}`)) return true;
  const base = path.slice(path.lastIndexOf('/') + 1);
  const mbase = m.slice(m.lastIndexOf('/') + 1);
  return mbase.includes('.') && base === mbase;
}

/**
 * Personalized PageRank over the file graph.
 *
 * @param {string[]} paths                       every candidate file
 * @param {object}   [graph]
 * @param {Map<string,string[]>} graph.definitions  path → symbols it DEFINES
 * @param {Map<string,Iterable<string>>} graph.references path → identifiers it MENTIONS
 * @param {string[]} [graph.mentionedFiles]      files the user named
 * @param {string[]} [graph.mentionedWords]      identifiers the user typed
 * @returns {{ scores: Map<string,number>, edges: number, seeds: number, iterations: number }}
 */
export function rankFiles(paths, graph = {}) {
  const {
    definitions = new Map(),
    references = new Map(),
    mentionedFiles = [],
    mentionedWords = [],
  } = graph;

  // ⚠️ THE CODE-POINT SORT IS THE DETERMINISM ANCHOR. Every array below is
  // indexed by position in THIS list, so every float sum happens in this order.
  const nodes = [...new Set(paths)].sort(byCodePoint);
  const n = nodes.length;
  const scores = new Map();
  if (n === 0) return { scores, edges: 0, seeds: 0, iterations: 0 };
  const index = new Map();
  for (let i = 0; i < n; i++) index.set(nodes[i], i);

  // ── who defines what ──────────────────────────────────────────────────────
  const definers = new Map();
  for (let i = 0; i < n; i++) {
    const names = definitions.get(nodes[i]);
    if (!names) continue;
    for (const name of names) {
      if (typeof name !== 'string' || name.length < MIN_IDENT_LENGTH) continue;
      let list = definers.get(name);
      if (!list) { list = []; definers.set(name, list); }
      list.push(i);
    }
  }
  const mentionedWordSet = new Set(mentionedWords);

  // ── reference → definition edges ──────────────────────────────────────────
  const adjacency = [];
  for (let i = 0; i < n; i++) adjacency.push(null);
  let edgeCount = 0;
  for (let i = 0; i < n; i++) {
    const refs = references.get(nodes[i]);
    if (!refs) continue;
    let weights = null;
    for (const name of refs) {
      const list = definers.get(name);
      // A symbol everybody defines is a word; see MAX_DEFINERS_PER_SYMBOL.
      if (!list || list.length > MAX_DEFINERS_PER_SYMBOL) continue;
      // ⭐ SPLIT ACROSS THE DEFINERS. An ambiguous name must not hand full
      // weight to each candidate — that is how one popular word outranks a real
      // dependency edge.
      const share = (mentionedWordSet.has(name) ? MENTIONED_IDENT_WEIGHT : 1) / list.length;
      for (const to of list) {
        if (to === i) continue;
        if (weights === null) weights = new Map();
        weights.set(to, (weights.get(to) ?? 0) + share);
      }
    }
    if (weights === null) continue;
    // ⚠️ SORTED BY TARGET ID. See invariant 2 — the summation order is fixed
    // here, not inherited from whatever order the identifiers were seen in.
    const list = [...weights.entries()].sort((a, b) => a[0] - b[0]);
    adjacency[i] = list;
    edgeCount += list.length;
  }

  const outSum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const list = adjacency[i];
    if (!list) continue;
    let s = 0;
    for (const [, w] of list) s += w;
    outSum[i] = s;
  }

  // ── the personalization vector ────────────────────────────────────────────
  const seedWeights = new Float64Array(n);
  let seedTotal = 0;
  let seedCount = 0;
  for (let i = 0; i < n; i++) {
    const path = nodes[i];
    let s = 0;
    for (const mention of mentionedFiles) if (pathIsMentioned(path, mention)) s += 1;
    // ⭐ A PATH THAT CONTAINS A MENTIONED WORD IS A WEAKER SEED, NOT AN EQUAL
    // ONE. "the repo map" should lift `lib/repo-map.mjs`, but not as hard as
    // naming the file outright would.
    const lower = path.toLowerCase();
    for (const word of mentionedWords) {
      if (word.length < 4) continue;
      if (lower.includes(word.toLowerCase())) s += 0.25;
    }
    if (s > 0) { seedWeights[i] = s; seedTotal += s; seedCount += 1; }
  }

  const teleport = new Float64Array(n);
  const uniform = 1 / n;
  if (seedTotal > 0) {
    for (let i = 0; i < n; i++) {
      teleport[i] = (1 - RANK_SEED_SHARE) * uniform + RANK_SEED_SHARE * (seedWeights[i] / seedTotal);
    }
  } else {
    for (let i = 0; i < n; i++) teleport[i] = uniform;
  }

  // ── sparse power iteration ────────────────────────────────────────────────
  let rank = Float64Array.from(teleport);
  const next = new Float64Array(n);
  let iterations = 0;
  for (let iter = 0; iter < RANK_MAX_ITERATIONS; iter++) {
    iterations = iter + 1;
    // ⚠️ DANGLING MASS IS REDISTRIBUTED, NOT DROPPED. A file that references
    // nothing is a sink; leaking its mass would make the vector stop summing to
    // one and quietly rescale every comparison.
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outSum[i] === 0) dangling += rank[i];
    for (let i = 0; i < n; i++) next[i] = (1 - RANK_DAMPING) * teleport[i] + RANK_DAMPING * dangling * teleport[i];
    for (let i = 0; i < n; i++) {
      const list = adjacency[i];
      if (!list) continue;
      const share = (RANK_DAMPING * rank[i]) / outSum[i];
      for (const [to, w] of list) next[to] += share * w;
    }
    let delta = 0;
    for (let i = 0; i < n; i++) {
      delta += Math.abs(next[i] - rank[i]);
      rank[i] = next[i];
    }
    if (delta < RANK_TOLERANCE) break;
  }

  // ⚠️ QUANTISED ON THE WAY OUT — invariant 4. Callers compare these numbers to
  // decide an order that has to be byte-stable across rebuilds.
  for (let i = 0; i < n; i++) scores.set(nodes[i], Math.round(rank[i] * RANK_QUANTUM) / RANK_QUANTUM);
  return { scores, edges: edgeCount, seeds: seedCount, iterations };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY — which paths survive a tight budget
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⭐ THE ORDER IS THE PRODUCT WHEN THE BUDGET BITES. Alphabetical is what the
 * old pre-read used, and alphabetical is why two hundred `assets/img000.png`
 * crowded out the one `src/target.ts` the task was about.
 *
 * Lower is better. Source beats prose beats assets.
 */
function fileCategory(file, entryTargets) {
  if (file.path === 'package.json' || entryTargets.has(file.path)) return 0;
  if (SOURCE_EXT.test(file.path)) return 1;
  if (DOC_EXT.test(file.path)) return 2;
  return 3;
}

/** The directory a path sits in. `''` for a file at the root. */
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * ── ⚠️⚠️⭐ THE ORDER USED TO CONTAIN A DEPTH TERM, AND IT REBUILT THE EXACT
 *    BLINDNESS THIS MODULE WAS WRITTEN TO DELETE ────────────────────────────
 *
 * The old comparator was `category * 1_000_000 + min(depth, 40) * 10_000`, and
 * its stated reason was right in spirit: *"shallow beats deep, so the SHAPE of
 * the project survives even when most of it does not."* Wanting the shape to
 * survive is correct. Expressing it as a STRICT tiebreak ahead of the path is
 * what broke, because a strict ordering on depth is not a bias toward the
 * shape — it is a breadth-first cut, and a breadth-first cut is a DEPTH CLIFF.
 * Every file at depth N is listed before any file at depth N+1, so the budget
 * runs out inside one depth band and everything below it vanishes together.
 *
 * ⚠️⚠️ MEASURED ON `console/` (2,406 files, 360 directories) BEFORE THIS FIX:
 *
 *     depth 0 :   6 of   39 listed
 *     depth 1 : 653 of 1281 listed
 *     depth 2 :   0 of  482          ← the cliff
 *     depth 3 :   0 of  285
 *     depth 4+:   0 of  319
 *
 *   659 files listed, drawn from **7 of the 360 directories**. 1,610 of the
 *   1,747 omitted files were SOURCE — 1,017 `.ts` and 386 `.tsx`.
 *
 * ⭐ THIS IS THE SAME DEFECT THE HEADER OF THIS FILE ATTACKS BY NAME. It opens
 * by indicting `gatherWorkspaceContext` for walking "TWO directory levels", and
 * the replacement WALKED the whole tree and then threw everything past two
 * levels away at render time, for 6,000 tokens instead of 12 file bodies. The
 * walk was fixed and the ordering quietly undid it. That is worth stating
 * plainly, because "we already fixed that" is why nobody looked.
 *
 * ⭐⭐ AND IT MATTERS MORE THAN THE FILE COUNT, because of the header's own
 * argument: *"an invisible file is not a neutral absence … it reads as 'that
 * file does not exist'."* A model that can see 659 files from 7 directories does
 * not know 353 other directories exist. A model that can see ONE file in every
 * directory knows where everything lives and can `read_file` the rest. Reach
 * across the tree is the product; the count is a proxy that stopped tracking it.
 *
 * ── ⭐ SO THE CUT IS A BREADTH SAMPLE, NOT A PREFIX ─────────────────────────
 *
 * Files are dealt out one per directory per pass: every directory's first
 * source file, then every directory's second, and so on. The budget then runs
 * out at "the 7th file of the big directories" instead of "every directory
 * below depth 1". Measured at the same 6,000 tokens the cliff was measured at:
 * **453 files but 347 of 347 source directories, reaching depth 7.**
 *
 * ⚠️ DEPTH IS STILL HERE AND STILL DOES ITS JOB — it just ranks WITHIN a pass
 * rather than above one. Among all the directories' first files, the shallow
 * ones are listed first, so the shape still survives a budget too tight for a
 * full pass. That is what the original comment wanted; this is the ordering
 * that delivers it without the cliff.
 *
 * ⚠️ CATEGORY STILL OUTRANKS EVERYTHING, so `src/target.ts` still beats two
 * hundred `assets/img000.png` — the sample is taken within a category, so an
 * asset-only directory is not represented until every source file has been.
 *
 * ⚠️ DETERMINISM SURVIVES: the pass index is assigned after a CODE POINT sort,
 * so which file is a directory's "first" cannot depend on `readdir` order.
 *
 * ── ⭐⭐ AND `ranks` DECIDES *WHICH* FILE EACH DIRECTORY DEALS ───────────────
 *
 * Everything above settles HOW MANY files a directory contributes before its
 * neighbours get a second turn. Until `ranks` existed, WHICH one it contributed
 * was decided by `byCodePoint` on the path — the alphabetical relevance order
 * this module's own header opens by condemning, applied one directory at a
 * time. `ranks` is the personalized-PageRank score from `rankFiles`, and it
 * lands in exactly two places:
 *
 *   · THE DEAL ORDER — a directory offers its highest-ranked file first;
 *   · THE CROSS-DIRECTORY TIEBREAK, ahead of depth — so among every directory's
 *     first file, the one the symbol graph (and the user's own words) says
 *     matters is listed before the one whose name starts with `a`.
 *
 * ⚠️ DEPTH IS STILL HERE AND STILL RANKS WHAT THE GRAPH IS SILENT ABOUT.
 * Assets, prose, and every file the symbol reader never reached score
 * identically, tie on rank, and fall through to depth exactly as before — which
 * is the case the depth term was written for ("the SHAPE of the project
 * survives"). Rank only speaks where there is evidence to speak from.
 *
 * ⚠️ AND `ranks` IS OPTIONAL. Omit it and every comparison ties at 0, leaving
 * this comparator byte-for-byte the one that shipped before ranking existed.
 */
export function orderForBudget(files, entryTargets = new Set(), ranks = null) {
  const rankOf = (path) => (ranks ? (ranks.get(path) ?? 0) : 0);
  /**
   * ⚠️ THE DEAL ORDER, AND IT IS RANK-FIRST NOW. The pass counter below is
   * incremented in the order this array is walked, so THIS sort is what decides
   * which file a directory contributes FIRST — the question that used to be
   * answered by "whichever name sorts earliest", i.e. by alphabetical order.
   * The path is still the tiebreak, so an exact rank tie (every file, when no
   * ranks are supplied) reproduces the old deal exactly.
   */
  const byPath = [...files].sort((a, b) => (rankOf(b.path) - rankOf(a.path))
    || byCodePoint(a.path, b.path));
  const seen = new Map();
  const rows = byPath.map((file) => {
    const category = fileCategory(file, entryTargets);
    // The pass is counted per (directory, category) rather than per directory:
    // a directory's README must not consume the slot its `index.ts` needs.
    const key = `${dirOf(file.path)}\u0000${category}`;
    const pass = seen.get(key) ?? 0;
    seen.set(key, pass + 1);
    return { file, category, pass, depth: Math.min(file.depth, 40), rank: rankOf(file.path) };
  });
  rows.sort((a, b) => a.category - b.category
    || a.pass - b.pass
    || (b.rank - a.rank)
    || a.depth - b.depth
    || byCodePoint(a.file.path, b.file.path));
  return rows.map((r) => r.file);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE WALK
// ─────────────────────────────────────────────────────────────────────────────

function defaultImpls(root) {
  return {
    existsImpl: (rel) => existsSync(rel === '' ? root : join(root, rel)),
    readdirImpl: (rel) => readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true })
      .map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other' })),
    statImpl: (rel) => {
      const st = statSync(join(root, rel), { throwIfNoEntry: false });
      if (!st) return null;
      return { size: st.size, mtimeMs: st.mtimeMs, dir: st.isDirectory() };
    },
    readFileImpl: (rel) => {
      try { return readFileSync(join(root, rel), 'utf8'); } catch { return null; }
    },
  };
}

/**
 * Build the map.
 *
 * @param {string} root                 absolute path, used only by the default impls
 * @param {object} [impls]              existsImpl / readdirImpl / statImpl / readFileImpl
 * @param {object} [opts]               { budgetTokens, maxEntries, task, mentionedFiles,
 *                                        mentionedWords, rank }
 *
 * ⭐ `task` IS THE WHOLE POINT OF THE RANKING BEING *PERSONALIZED*. Pass the
 * user's own request and the walk is seeded at the files they named; pass
 * nothing and the ranking degrades to a static importance score, which is still
 * strictly better than alphabetical but is the same for every question.
 * @returns {{ ok: boolean, text: string, files: object[], truncated: boolean, stats: object, error?: string }}
 */
export function buildRepoMap(root, impls = {}, opts = {}) {
  const io = { ...defaultImpls(root), ...(impls || {}) };
  // Tolerate the options being folded into the second argument — a caller that
  // writes `buildRepoMap(root, { budgetTokens: 800 })` means something obvious
  // and refusing it would fail correct work.
  const budgetTokens = opts.budgetTokens ?? impls?.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const maxEntries = opts.maxEntries ?? impls?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  /**
   * ⚠️ INJECTABLE SO THE CAPPED REGIME IS REACHABLE FROM A TEST — see
   * `DEFAULT_MAX_SYMBOL_READS`. Folded into the second argument on the same
   * terms as `budgetTokens` and `maxEntries`, because a caller who writes
   * `buildRepoMap(root, { maxSymbolReads: 20 })` means something obvious.
   */
  const maxSymbolReads = opts.maxSymbolReads ?? impls?.maxSymbolReads ?? DEFAULT_MAX_SYMBOL_READS;

  const stats = {
    totalFiles: 0,
    listedFiles: 0,
    omittedFiles: 0,
    skippedDirs: 0,
    skippedDirNames: [],
    hidden: 0,
    withheld: 0,
    gitignored: 0,
    gitignoreUsed: false,
    unreadableDirs: 0,
    walkCapped: false,
    maxDepthReached: 0,
    entryPoints: [],
    budgetTokens,
    tokensEstimated: 0,
    /**
     * ⭐ DIRECTORY REACH, BECAUSE THE FILE COUNT STOPPED TRACKING THE PRODUCT.
     * See `orderForBudget`: 659 of 2,406 files reads as 27% coverage and was
     * actually 7 of 360 directories. A count of files cannot tell those two
     * apart; this pair can, and it is what the regression test binds to.
     */
    dirsTotal: 0,
    dirsListed: 0,
    /**
     * ⭐ THE RANKER'S OWN RECEIPTS. `rankEdges` is how much symbol graph was
     * actually found (zero means the ordering fell back to the old one, which
     * is a fact worth being able to read rather than infer), `rankSeeds` how
     * many files the user's own words lit up, `rankIterations` what the power
     * iteration cost — and because the tolerance is a constant, that number is
     * itself a determinism check: the same tree must converge in the same
     * number of rounds every time.
     */
    rankEdges: 0,
    rankSeeds: 0,
    rankIterations: 0,
    /**
     * ⭐ HOW MUCH OF THE SYMBOL GRAPH ACTUALLY EXISTS. `rankEdges` says how many
     * edges were found; it cannot say how many files were never opened, and on a
     * customer-sized tree that is the larger fact by far — 759 of 2,470 source
     * files on `console/`, 737 of 6,537 on the enclosing worktree. A ranking
     * computed on 11% of the evidence is not wrong, but reading `rankEdges: 1876`
     * without this pair reads as though the graph were complete.
     *
     * ⚠️ STATS ONLY. Nothing here is rendered into the map — see
     * `DEFAULT_MAX_SYMBOL_READS` for why printing it would cost coverage.
     */
    graphFiles: 0,
    graphFilesTotal: 0,
    graphCapped: false,
  };

  const fail = (error) => ({ ok: false, text: '', files: [], truncated: false, stats, error });

  let rootOk = false;
  try { rootOk = io.existsImpl('') !== false; } catch { rootOk = false; }
  if (!rootOk) return fail(`could not read the workspace root — it does not exist, or permission was denied (EACCES)`);

  const readdir = (rel) => {
    try {
      const out = io.readdirImpl(rel);
      return Array.isArray(out) ? out : null;
    } catch (err) {
      return { error: err };
    }
  };

  const rootEntries = readdir('');
  if (rootEntries === null || (rootEntries && rootEntries.error)) {
    const code = rootEntries?.error?.code ?? rootEntries?.error?.message ?? 'unknown';
    return fail(`could not read the workspace root: ${code}`);
  }

  /** @type {{path:string, depth:number, size:number, mtimeMs:number}[]} */
  const candidates = [];
  const skippedNames = new Set();
  let entriesSeen = 0;

  /**
   * ⚠️ AN EXPLICIT STACK, NOT RECURSION. A deep tree is exactly the case this
   * module exists to handle, and blowing the JS stack on it would be a comic
   * failure mode.
   */
  const stack = [{ rel: '', depth: 0, ignore: [] }];

  while (stack.length > 0) {
    if (entriesSeen >= maxEntries) { stats.walkCapped = true; break; }
    const dir = stack.pop();
    if (dir.depth > stats.maxDepthReached) stats.maxDepthReached = dir.depth;

    const listed = dir.rel === '' ? rootEntries : readdir(dir.rel);
    if (listed === null || (listed && listed.error)) {
      stats.unreadableDirs += 1;
      continue;
    }

    // ⚠️ SORTED HERE, ONCE. Everything downstream inherits a stable order, so
    // no property of the output can depend on what readdir felt like doing.
    const entries = [...listed]
      .filter((e) => e && typeof e.name === 'string')
      .sort((a, b) => byCodePoint(a.name, b.name));

    // A nested .gitignore governs its own subtree and nothing above it.
    let ignoreChain = dir.ignore;
    const gitignoreEntry = entries.find((e) => e.name === '.gitignore' && e.type === 'file');
    if (gitignoreEntry) {
      stats.gitignoreUsed = true;
      let text = null;
      try { text = io.readFileImpl(dir.rel === '' ? '.gitignore' : `${dir.rel}/.gitignore`); } catch { text = null; }
      const rules = parseGitignore(text);
      if (rules.length > 0) {
        ignoreChain = [...dir.ignore, { base: dir.rel, match: makeIgnoreMatcher(rules) }];
      }
    }

    const ignored = (rel, isDir) => {
      for (const layer of ignoreChain) {
        const scoped = layer.base === '' ? rel : rel.slice(layer.base.length + 1);
        if (layer.match(scoped, isDir)) return true;
      }
      return false;
    };

    const childDirs = [];
    for (const entry of entries) {
      if (entriesSeen >= maxEntries) { stats.walkCapped = true; break; }
      entriesSeen += 1;
      const name = entry.name;
      const rel = dir.rel === '' ? name : `${dir.rel}/${name}`;

      if (entry.type === 'dir') {
        if (SKIP_DIRS.has(name)) { stats.skippedDirs += 1; skippedNames.add(name); continue; }
        if (name.startsWith('.') && !HIDDEN_DIRS_ALLOWED.has(name)) { stats.hidden += 1; continue; }
        if (refusedCommitPath(`${rel}/`)) { stats.withheld += 1; continue; }
        if (ignored(rel, true)) { stats.gitignored += 1; continue; }
        if (dir.depth + 1 > MAX_DEPTH) continue;
        childDirs.push({ rel, depth: dir.depth + 1, ignore: ignoreChain });
        continue;
      }
      // ⚠️ A symlink, socket or fifo is neither. Skipping every non-file,
      // non-dir entry is what makes a cycle structurally impossible.
      if (entry.type !== 'file') continue;

      if (name.startsWith('.') && !HIDDEN_FILES_ALLOWED.has(name)) { stats.hidden += 1; continue; }
      if (refusedCommitPath(rel)) { stats.withheld += 1; continue; }
      if (ignored(rel, false)) { stats.gitignored += 1; continue; }

      let st = null;
      try { st = io.statImpl(rel); } catch { st = null; }
      candidates.push({
        path: rel,
        depth: dir.depth,
        size: typeof st?.size === 'number' ? st.size : 0,
        mtimeMs: typeof st?.mtimeMs === 'number' ? st.mtimeMs : 0,
      });
    }

    // Pushed in reverse so the stack pops them in sorted order. Purely
    // cosmetic for correctness, load-bearing for reading a debug dump.
    for (let i = childDirs.length - 1; i >= 0; i--) stack.push(childDirs[i]);
  }

  stats.skippedDirNames = [...skippedNames].sort(byCodePoint);
  stats.totalFiles = candidates.length;

  // ── package.json: entry points, scripts ───────────────────────────────────
  const pkg = readPackageJson(io, candidates);
  stats.entryPoints = pkg.entryPoints;
  const entryTargets = new Set(pkg.entryPoints.map((e) => e.target.replace(/^\.\//, '')));

  /**
   * ── ⚠️ THE BASELINE ORDER EXISTS ONLY TO CHOOSE WHAT TO READ ──────────────
   *
   * Ranking needs the symbol graph and the symbol graph needs file contents, so
   * something has to decide which 800 files are worth opening before any rank
   * exists. That is this call, and it is the SAME order (and therefore the same
   * 800 files, and the same read cost) as before ranking was added — the change
   * is what happens to the order afterwards, not what gets read.
   */
  const baseline = orderForBudget(candidates, entryTargets);

  /**
   * ⚠️ `opts.rank === false` turns the ranking off and restores the previous
   * ordering exactly — an escape hatch that costs one branch, and the only
   * honest way to A/B a change to the thing the whole prompt cache hangs on.
   * It is read HERE, above the loop, so a disabled ranker also skips the
   * identifier scan rather than computing a graph nobody will look at.
   */
  const rankEnabled = (opts.rank ?? impls?.rank) !== false;

  // ── symbols AND references, in ONE pass over the same files ───────────────
  /**
   * ── ⚠️⭐ ELIGIBILITY IS DECIDED BEFORE THE CEILING, NOT AFTER IT ────────────
   *
   * See `DEFAULT_MAX_SYMBOL_READS` for the measurement. The old loop sliced the
   * baseline to 800 and THEN tested these two predicates, so an ineligible file
   * spent a slot and returned nothing — 41 wasted slots on `console/`, 63 on the
   * enclosing worktree. Neither predicate needs the file's contents, so testing
   * them first is free: an ineligible file never cost a read either way.
   *
   * ⚠️ DETERMINISM IS UNTOUCHED. `filter` preserves order, and the order it
   * preserves is `baseline`'s, which is already a pure function of the tree.
   * Nothing here consults the task, so the graph — and therefore the invariant
   * ranking built on it — stays byte-identical across every task in the repo.
   */
  const graphEligible = baseline.filter((f) => SYMBOL_EXT.test(f.path) && f.size <= MAX_SYMBOL_FILE_BYTES);
  stats.graphFilesTotal = graphEligible.length;
  stats.graphCapped = graphEligible.length > maxSymbolReads;
  const references = new Map();
  for (const f of graphEligible.slice(0, maxSymbolReads)) {
    let src = null;
    try { src = io.readFileImpl(f.path); } catch { src = null; }
    if (typeof src !== 'string') continue;
    // ⚠️ COUNTED AFTER THE READ SUCCEEDS, NOT BEFORE. `graphFiles` has to mean
    // "files whose contents are actually in the graph"; counting the attempt
    // would report a complete graph on a tree where every read failed, which is
    // the precise failure the receipt exists to make visible.
    stats.graphFiles += 1;
    const names = extractExports(f.path, src);
    // ⚠️ AN EMPTY LIST IS LEFT UNDEFINED, NOT STORED AS []. `[]` renders as
    // "this file exports nothing", which is a claim a regex cannot make.
    if (names.length > 0) f.symbols = names;
    // ⭐ THE REFERENCE HALF OF THE GRAPH, AND IT COSTS NO EXTRA READ. The file
    // is already in memory; the identifiers are the edges. Nothing here reaches
    // the prompt — see `rankFiles`, which returns numbers, not names.
    if (rankEnabled) references.set(f.path, extractIdentifiers(src));
  }

  // ── ⭐ THE RANKING PASS ────────────────────────────────────────────────────
  const mentions = normaliseMentions(opts, impls);
  const ranking = rankEnabled
    ? rankFiles(candidates.map((f) => f.path), {
      definitions: new Map(candidates.filter((f) => f.symbols).map((f) => [f.path, f.symbols])),
      references,
      mentionedFiles: mentions.files,
      mentionedWords: mentions.words,
    })
    : { scores: null, edges: 0, seeds: 0, iterations: 0 };
  stats.rankEdges = ranking.edges;
  stats.rankSeeds = ranking.seeds;
  stats.rankIterations = ranking.iterations;

  /**
   * ── ⭐⭐⭐ THE SECOND RANKING, AND WHY A 34.6% LINE ITEM WAS UNSHAREABLE ─────
   *
   * `ECONOMICS.md` decomposes one real recorded run (task: "hi") and puts the
   * repo map at **34.6% of the entire prompt — 701 paths, ~8,900 tokens**. That
   * number is the budget below BINDING at its ceiling, exactly as designed; the
   * map was not failing to truncate. What nobody had measured is what the map
   * does to the PREFIX CACHE, and it is severe.
   *
   * ⚠️⚠️ MEASURED 2026-08-25 on `console/` (2,792 files, 382 directories), two
   * different real briefs, same tree, same 9,000-token budget:
   *
   *     shared prefix between the two maps    651 of 31,468 bytes    2.1%
   *     the same pair with `rank: false`   31,441 of 31,441 bytes  100.0%
   *
   * So the personalized half of the ranking — the thing that makes the map
   * task-specific — costs **97.9% of everything two tasks in the same repository
   * could have shared.** On the measured card a cache miss is 15.7x a cache hit,
   * so re-sending 31KB of map because the *question* changed is the single
   * largest avoidable miss in the user message.
   *
   * ⚠️ AND IT WAS INVISIBLE ON THIS REPOSITORY, which is why it survived. When
   * the tree FITS the budget the FILES section renders in path order whatever
   * the ranker decided, so `acuvo-code`'s own map is byte-identical across
   * tasks (100%) and every local measurement said the map was perfectly stable.
   * The defect only exists where the budget bites — i.e. on every real customer
   * repository and none of ours.
   *
   * ⭐ THE FIX IS THE ONE THIS FILE ALREADY APPLIES TO `LARGEST` AND `RECENTLY
   * CHANGED`: put the volatile section LAST. Those two were moved behind `FILES`
   * because they reshuffle when the agent writes a file; `FILES` itself is the
   * volatile section now, because it reshuffles when the QUESTION changes. So
   * the listing is split in two — a task-INVARIANT tranche chosen by the static
   * importance ranking, then the files the request itself lifted, appended.
   * Everything before the second block is byte-identical for every task in the
   * repository, and the second block is the only thing anyone pays twice for.
   *
   * ⚠️ NOTHING IS DROPPED AND NOTHING IS SUMMARISED. The personalized ranking
   * still decides the second tranche and still gets the user's own words; it
   * simply no longer decides the ORDER of the first 75% of the map. A file the
   * task points at is now guaranteed a place AND labelled as task-relevant,
   * which is strictly more information than an unmarked position in one list.
   *
   * ⚠️ IT COSTS A SECOND POWER ITERATION, AND ONLY WHEN IT CAN PAY FOR ITSELF.
   * With no seeds the two rankings are the same computation, so the static one
   * is simply the one already computed and this branch never runs.
   */
  const staticRanking = (rankEnabled && ranking.seeds > 0)
    ? rankFiles(candidates.map((f) => f.path), {
      definitions: new Map(candidates.filter((f) => f.symbols).map((f) => [f.path, f.symbols])),
      references,
    })
    : ranking;

  // ── priority order ────────────────────────────────────────────────────────
  /**
   * ⚠️ TWO ORDERS NOW, AND THE NAMES MATTER. `ordered` is the TASK-INVARIANT
   * one and it is what the budget is spent against — it carries the same name
   * because it plays the same role everything downstream expects. `personalOrder`
   * is the personalized one and it is consulted for one thing only: which files
   * the task lifted that the invariant cut did not already include.
   */
  const ordered = orderForBudget(candidates, entryTargets, staticRanking.scores);
  const personalOrder = ranking.seeds > 0
    ? orderForBudget(candidates, entryTargets, ranking.scores)
    : ordered;

  if (candidates.length === 0) {
    const text = 'REPO MAP — the workspace is empty (no files this agent may list)';
    stats.tokensEstimated = estimateTokens(text);
    return { ok: true, text, files: [], truncated: false, stats };
  }

  /**
   * ── ⭐ TWO LEVERS, AND THE ORDER BETWEEN THEM IS THE WHOLE DESIGN ──────────
   *
   * MEASURED on a real 2,246-file Next.js repo: an annotated line averages 93
   * characters, a bare path 28. So symbols cost 3.3x, and at a 3,000-token
   * budget they were buying 77 symbol lists at the price of 230 PATHS.
   *
   * ⚠️ THAT TRADE IS BACKWARDS AND IT INVERTS THE MODULE'S OWN THESIS. Coverage
   * is the product — the thing that turns "I cannot find it, I will invent a
   * plausible file" into "I can see it, let me open it". A symbol list is a
   * convenience on top; the model can always call `read_file`. So symbols are
   * surrendered FIRST and paths LAST, never the other way round.
   *
   * Lever A: how many of the highest-priority files carry symbols (all → none).
   * Lever B: how many files are listed at all (all → one).
   */
  /**
   * ⭐ THE FILES THE USER TYPED THE NAME OF, and the ONE thing allowed to appear
   * twice in the map.
   *
   * ⚠️ THE REASON IS THE SYMBOL BUDGET, and it is a real regression this design
   * caused before this list existed. Symbols in the invariant tranche are
   * allocated by the invariant ranking, so a file the request NAMED can no
   * longer buy its way into the symbol slice — measured on the 1,600-file
   * fixture, `pkg01/hub.mjs` was listed as a bare path in a run whose task was
   * literally "fix hub1Thing in pkg01/hub.mjs". Its export list is the single
   * most useful line in the whole map for that run.
   *
   * ⭐ SO A NAMED FILE IS RE-LISTED IN THE TASK BLOCK, WITH ITS SYMBOLS. Under a
   * heading that says "files this request names", a second appearance reads as
   * emphasis rather than contradiction, it is bounded by how many files fit in
   * one sentence, and it costs nothing cacheable — the block sits after the
   * prefix has already diverged.
   */
  /**
   * ⚠️⚠️ AND IT IS BOUNDED TWICE, BECAUSE THE MATCHER IS DELIBERATELY LOOSE.
   * `pathIsMentioned` matches on BASENAME, which is right for SEEDING a random
   * walk (a weak signal spread over candidates) and wrong for "re-list this
   * file": measured on the 1,600-file fixture, the mention `pkg/mod07/index.mjs`
   * matched every `index.mjs` in the tree and the task block filled with forty
   * of them, cutting the map from 98 listed files to 80.
   *
   * ⭐ SO A MENTION THAT MATCHES MANY FILES IS NOT NAMING A FILE — it is naming
   * a filename. That is the same rule this module already applies to symbols
   * (`MAX_DEFINERS_PER_SYMBOL`: "a symbol defined in more files than this is a
   * word, not a symbol"), and it fails in the safe direction: an over-broad
   * mention simply falls back to seeding the ranking, which is what it did
   * before this list existed.
   *
   * ⚠️ AND IT IS OFF ENTIRELY UNDER `rank: false`. That flag means "no
   * personalization"; a task block populated from the user's words would be the
   * escape hatch wired to nothing, which the suite already guards.
   */
  const namedFiles = [];
  if (rankEnabled && mentions.files.length > 0) {
    const seenNamed = new Set();
    for (const m of mentions.files) {
      const clean = m.replace(/^\.\//, '').replace(/^\/+/, '');
      /**
       * ⭐ A PATH BEATS A BASENAME, AND THE ORDER HERE IS THE WHOLE FIX. "fix
       * hub1Thing in pkg01/hub.mjs" names exactly one file — but its basename
       * `hub.mjs` also matches forty others, so a single loose pass counted 40
       * hits, tripped the cap, and dropped the one file the user actually typed.
       * Strict matches are taken alone whenever there are any.
       */
      const strict = ordered.filter((f) => f.path === clean || f.path.endsWith(`/${clean}`));
      const hits = strict.length > 0 ? strict : ordered.filter((f) => pathIsMentioned(f.path, m));
      if (hits.length === 0 || hits.length > MAX_FILES_PER_MENTION) continue;
      for (const f of hits) {
        if (seenNamed.has(f.path)) continue;
        if (namedFiles.length >= MAX_NAMED_RELISTED) break;
        seenNamed.add(f.path);
        namedFiles.push(f);
      }
    }
  }

  const render = (n, symCount, taskTake = 0) => {
    const chosen = ordered.slice(0, n);
    const inChosen = new Set(chosen.map((f) => f.path));
    /**
     * ⚠️ THE POOL IS "WHAT THE TASK LIFTED THAT THE INVARIANT CUT MISSED", in
     * personalized priority order, preceded by the files the request named
     * outright. Nothing else is ever repeated — the block is an addition.
     */
    const named = new Set(namedFiles.map((f) => f.path));
    const taskPool = [
      ...namedFiles,
      ...personalOrder.filter((f) => !inChosen.has(f.path) && !named.has(f.path)),
    ];
    const taskChosen = taskTake > 0 ? taskPool.slice(0, taskTake) : [];
    const inTask = new Set(taskChosen.map((f) => f.path));
    const omitted = ordered.filter((f) => !inChosen.has(f.path) && !inTask.has(f.path));
    /**
     * ── ⚠️⚠️⭐ TWO SYMBOL SETS, AND ONE WAS A REAL BUG BEFORE IT WAS TWO ───────
     *
     * `symAllowed` governs the INVARIANT block and may only ever be a function
     * of (tree, budget). The first version added the task tranche's files to the
     * same set — and because a NAMED file is deliberately present in BOTH blocks
     * (see `namedFiles`), that annotated it *in the static listing too*.
     * Measured on a 2,070-file fixture: `pkg/mod01/hub.mjs  [hub1Thing]` in one
     * run and `pkg/mod01/hub.mjs` in another, at byte 670 of a 31KB map — the
     * cross-task prefix collapsed straight back to **2.1%**, i.e. the entire
     * saving, undone by six characters inside a bracket.
     *
     * ⭐ SO THE TASK BLOCK GETS ITS OWN. Symbols there are free — everything in
     * that block sits after the prefix has already diverged, so annotating it
     * cannot invalidate a cached byte, and the export list of the file the user
     * named is the most useful line in the map for that run.
     *
     * ⚠️ AND ONLY WHEN THE TRANCHE IS ACTUALLY SEEDED. An unseeded tranche is
     * not a relevance list, it is the SAME ranking continued — annotating it is
     * the defect this module already has a test for ("symbol lists ate the
     * tokens that should have bought coverage"): measured on that fixture, it
     * cut a 600-token map from 120 listed paths to 75.
     */
    const annotate = (f, allowed) => {
      if (!f.symbols || !allowed.has(f.path)) return `  ${f.path}`;
      const shown = f.symbols.slice(0, MAX_SYMBOLS_SHOWN);
      const extra = f.symbols.length - shown.length;
      return `  ${f.path}  [${shown.join(', ')}${extra > 0 ? ` +${extra}` : ''}]`;
    };
    const symAllowed = new Set(ordered.slice(0, symCount).filter((f) => f.symbols).map((f) => f.path));
    const taskSymAllowed = ranking.seeds > 0
      ? new Set(taskChosen.filter((f) => f.symbols).map((f) => f.path))
      : symAllowed;
    const lineFor = (f) => annotate(f, symAllowed);
    const taskLineFor = (f) => annotate(f, taskSymAllowed);
    return {
      text: renderMap({
        chosen, taskChosen, omitted, ordered, stats, pkg, lineFor, taskLineFor, symAllowed, taskSymAllowed,
        taskSeeded: ranking.seeds > 0,
      }),
      chosen,
      taskChosen,
      omitted,
    };
  };

  /**
   * ── ⭐ THE STATIC TRANCHE IS FITTED AGAINST A *REDUCED* BUDGET ──────────────
   *
   * ⚠️ AND IT HAS TO BE, OR THE INVARIANT HALF STOPS BEING INVARIANT. If the
   * static tranche were fitted against the whole budget and the task block then
   * appended, the appended bytes would push the total over and the shrink loop
   * would cut the static tranche — by an amount that depends on how many files
   * the task lifted, i.e. on the task. Reserving the share up front is what
   * makes `take` a pure function of (tree, budget) and nothing else.
   *
   * ⭐ 25% IS THE SMALLER HALF OF THE DESIGN. Measured on `console/` at 9,000
   * tokens the map lists ~695 files, so a quarter is ~170 slots for the files a
   * request actually named — far more than any single task's mentions — while
   * three quarters of the map stays byte-shared with every other task in the
   * repository.
   *
   * ── ⚠️⚠️ "FAR MORE THAN ANY SINGLE TASK'S MENTIONS" IS THE WRONG REASON, AND
   *    IT WOULD TALK THE NEXT READER INTO GROWING THIS ─────────────────────────
   *
   * It presents over-provisioning as free. It is not: the reservation is taken
   * UNCONDITIONALLY, every reserved token sits AFTER the point where the prefix
   * diverges, and a token after the divergence is a cache MISS on every session
   * in that repository. The cost of this constant is linear in its value, with
   * no kink to hide behind.
   *
   * ⭐ SO IT WAS RE-DERIVED FROM A COST *AND* A BENEFIT (2026-08-25). Benefit is
   * measured as LIFTED files — files the task tranche shows that a fully
   * task-invariant map (share = 0) would never list at all; cost is the map
   * tokens falling after the divergence point. Three real briefs, 9,000 tokens:
   *
   *     `console/` — 2,792 files, map reaches 25% of the tree
   *       share  listed  lifted (3 briefs)   x-task prefix   miss tokens
   *       0.05     687        23/25/27           94.3%            513
   *       0.10     678        23/25/27           89.6%            936
   *       0.25     632        21/22/22           74.3%          2,315
   *       0.40     587        18/19/19           59.3%          3,662
   *
   *     the enclosing worktree — 9,574 files, map reaches 7% of the tree
   *       0.05     644        24/39/27           93.6%            574
   *       0.10     634        43/76/50           88.6%          1,021
   *       0.25     602       87/144/55           73.7%          2,366
   *       0.40     599      87/200/118           58.2%          3,760
   *
   * ⚠️⚠️ THE TWO TREES DISAGREE, AND THAT IS THE WHOLE ANSWER. On the mid-size
   * repo the benefit SATURATES by 0.10 and then goes BACKWARDS — past that point
   * the reservation is eating the static tranche faster than the task block can
   * re-cover it, so a bigger share buys fewer relevant files AND a worse cache.
   * On a repo where the budget reaches only 7% of the tree — which is the regime
   * of the real recorded run in `ECONOMICS.md` (701 of 9,085 files) — it is still
   * climbing steeply at 0.40, at a flat ~34 miss tokens per lifted file.
   *
   * ⭐ ONE CONSTANT HAS TO SERVE BOTH, so it is set where the large-repo curve is
   * still paying and the small-repo curve has not yet turned far: 0.25 is
   * over-provisioned on a mid-size tree by roughly 2.5x and correctly sized on a
   * large one. It is NOT a free parameter — moving it up is a straight cache
   * cost, and moving it below ~0.10 blinds the case that needs it most.
   *
   * ⚠️ AND THE FLOOR IT PROMISES IS NOW GUARDED. `repo-map-cross-task-prefix.test.mjs`
   * asserts the invariant half is byte-identical across different tasks, derives its
   * percentage floor from THIS constant rather than pinning a number, and fails in
   * BOTH directions — a map that becomes task-varying and a map that becomes
   * task-blind are each caught.
   *
   * ── ⚠️⚠️ AND IT IS RESERVED **UNCONDITIONALLY**, WHICH THE FIRST VERSION GOT
   *    WRONG AND THE MEASUREMENT CAUGHT ────────────────────────────────────────
   *
   * Reserving only when `seeds > 0` looks free — a task that names nothing
   * cannot use the tranche, so why hold it back? Because the reservation is what
   * fixes `take`, and a `take` that depends on whether the task happened to seed
   * is a `take` that depends on the task. Measured on `console/`, reserving
   * conditionally: an unseeded map and a seeded map shared **1.5%** of their
   * bytes — WORSE than the 18.8% before any of this — because the unseeded one
   * listed 695 files and the seeded one 520, so the two FILES sections diverged
   * within the first screen.
   *
   * ⭐ SO THE RESERVATION IS ALWAYS TAKEN AND THE SLOTS ARE NEVER WASTED: with
   * no seeds the tranche is filled by simply CONTINUING the same invariant order
   * (`personalOrder === ordered` in that case), and rendered under a heading
   * that says so. Same files, same count, same coverage as before — one extra
   * heading, and a map whose first three quarters is byte-identical for every
   * task in the repository including the ones that name nothing at all.
   */
  const taskBudget = Math.floor(budgetTokens * TASK_TRANCHE_SHARE);
  const staticBudget = budgetTokens - taskBudget;

  /** Largest symbol count that still fits, for a fixed file count. Monotonic. */
  const fitSymbols = (n) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateTokens(render(n, mid).text) <= staticBudget) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  let take = ordered.length;
  let symCount = ordered.length;
  let out = render(take, symCount);

  if (estimateTokens(out.text) > staticBudget) {
    /**
     * ── ⭐ PATHS ARE FITTED AGAINST A REDUCED TARGET, NOT THE WHOLE BUDGET ────
     *
     * See `SYMBOL_RESERVE_SHARE` for the measurement this replaces (zero symbol
     * lists on every truncated tree). The reserve is withheld from the PATH fit
     * so that the `fitSymbols` pass below has something left to spend; it is a
     * fraction of a constant, so `pathBudget` — and therefore `take` — stays a
     * pure function of (tree, budget).
     */
    /**
     * ⚠️⚠️ THE RESERVE IS ONLY TAKEN WHEN PATHS WERE GOING TO BE CUT ANYWAY,
     * AND THE FIRST VERSION OF THIS GOT IT WRONG IN A WAY THAT MEASURED AS A
     * REGRESSION. This branch is entered whenever the map with EVERY symbol
     * list is over budget — which includes trees whose PATHS fit comfortably
     * and only the annotations overflow. Reserving there pushed `take` below
     * `ordered.length`, which silently disabled the `take === ordered.length`
     * hand-back below; measured on this package, 142 symbol lists fell to 65
     * and ~2,000 tokens went unspent. A tree that fits must be untouched.
     */
    const pathsFitWhole = estimateTokens(render(ordered.length, 0).text) <= staticBudget;
    const pathBudget = pathsFitWhole
      ? staticBudget
      : staticBudget - Math.floor(staticBudget * SYMBOL_RESERVE_SHARE);
    stats.symbolReserveTokens = staticBudget - pathBudget;

    /**
     * ⭐ AN EXACT SEARCH, THEN THE OLD DESCENT AS A SAFETY NET — AND BOTH ARE
     * LOAD-BEARING. `render` is monotonic in the file count in every ordinary
     * case, so a binary search finds the LARGEST `take` that fits instead of
     * wherever a subtract-and-retry loop happens to land: measured on
     * `console/`, the descent stopped at take=441 where the search reaches
     * take=417, and the 24 extra paths it clung to cost 50 symbol lists.
     *
     * ⚠️ BUT MONOTONICITY IS NOT GUARANTEED. Listing one more file can DELETE a
     * line from the omission report, so `used` can dip. A binary search over a
     * non-monotonic predicate still terminates but may return an infeasible
     * `take`, so the original bounded descent is kept and run afterwards
     * against the same target. It is a no-op whenever the search was right,
     * which is the only reason it is safe to trust the search at all.
     */
    symCount = 0;
    {
      let lo = 1;
      let hi = take;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (estimateTokens(render(mid, 0).text) <= pathBudget) lo = mid;
        else hi = mid - 1;
      }
      take = lo;
    }
    out = render(take, symCount);
    // Still over? Only then does a PATH get dropped, from the lowest-priority
    // end, in batches. Bounded: a runaway here is a hang.
    for (let guard = 0; guard < 64 && take > 1; guard++) {
      const used = estimateTokens(out.text);
      if (used <= pathBudget) break;
      const excess = used - pathBudget;
      const perLine = Math.max(1, Math.ceil(used / Math.max(1, take)));
      take = Math.max(1, take - Math.max(1, Math.ceil(excess / perLine)));
      out = render(take, symCount);
    }
    // Now spend the reserve — against the FULL static budget, so nothing the
    // paths did not use is wasted either. One pass, after `take` has settled,
    // so this can never oscillate.
    const regained = fitSymbols(take);
    if (regained > symCount) {
      symCount = regained;
      out = render(take, symCount);
    }
  }

  /**
   * ── ⭐ ONLY NOW DOES THE TASK GET A VOTE, AND ONLY ON THE TAIL ─────────────
   *
   * ⚠️ EVERY BYTE ABOVE THIS POINT IS ALREADY DECIDED, so the block appended
   * here cannot move any of them. It is grown by binary search against the FULL
   * budget — monotonic in `taskTake`, so the search is exact — and it is
   * skipped entirely when nothing was omitted (a repo that fits has no file the
   * task could lift, because they are all already listed).
   */
  /**
   * ── ⭐ A TREE WITH NOTHING LEFT OVER GETS THE RESERVATION BACK ─────────────
   *
   * If every file is already listed there is nothing for the task tranche to
   * add, so the reserved quarter would simply go unspent — and the first thing
   * the fit gave up to make room was SYMBOLS. Measured on this package: 94
   * symbol lists survived against the reduced budget where the full budget had
   * paid for more, with ~2,275 tokens sitting idle.
   *
   * ⚠️ AND HANDING IT BACK HERE IS STILL INVARIANT, which is the only reason it
   * is allowed. The condition is `take === ordered.length` — a fact about the
   * tree and the budget, never about the task — so `symCount` remains a pure
   * function of the same two things. The same hand-back MUST NOT be done after
   * the task tranche is sized, because that count does depend on the task.
   */
  if (take === ordered.length && estimateTokens(out.text) <= budgetTokens) {
    let lo = symCount;
    let hi = take;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateTokens(render(take, mid).text) <= budgetTokens) lo = mid;
      else hi = mid - 1;
    }
    if (lo > symCount) {
      symCount = lo;
      out = render(take, symCount);
    }
  }

  let taskTake = 0;
  if (taskBudget > 0 && out.omitted.length > 0 && take < ordered.length) {
    let lo = 0;
    let hi = out.omitted.length + namedFiles.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateTokens(render(take, symCount, mid).text) <= budgetTokens) lo = mid;
      else hi = mid - 1;
    }
    taskTake = lo;
    if (taskTake > 0) out = render(take, symCount, taskTake);
  }
  /**
   * ⚠️ `files` CARRIES EVERY SYMBOL LIST THAT WAS EXTRACTED; `text` carries
   * only the ones the budget paid for. That is a deliberate asymmetry — a
   * programmatic caller should not lose data to a rendering decision — and
   * `symbolsShown` is the number that reconciles the two. Do not read a bare
   * path in `text` as "this file exports nothing".
   */
  stats.symbolsShown = ordered.slice(0, Math.min(symCount, take)).filter((f) => f.symbols).length;

  /**
   * ⚠️ `files` IS THE UNION OF BOTH TRANCHES. A programmatic caller asked "what
   * can the model see", and the answer is not "the invariant half" — splitting
   * the RENDER must not split the ANSWER.
   */
  // ⚠️ DEDUPED: a NAMED file is deliberately rendered twice (see `namedFiles`),
  // and a file counted twice would make `listedFiles + omittedFiles` disagree
  // with `totalFiles` — a total that does not add up is worse than no total.
  const seenPath = new Set();
  const shown = [...out.chosen, ...out.taskChosen].filter((f) => {
    if (seenPath.has(f.path)) return false;
    seenPath.add(f.path);
    return true;
  });
  const listed = [...shown].sort((a, b) => byCodePoint(a.path, b.path));
  stats.listedFiles = shown.length;
  stats.taskFiles = out.taskChosen.length;
  stats.omittedFiles = out.omitted.length;
  stats.dirsTotal = new Set(ordered.map((f) => dirOf(f.path))).size;
  stats.dirsListed = new Set(shown.map((f) => dirOf(f.path))).size;
  stats.tokensEstimated = estimateTokens(out.text);

  return {
    ok: true,
    text: out.text,
    files: listed.map((f) => ({ path: f.path, bytes: f.size, ...(f.symbols ? { symbols: f.symbols } : {}) })),
    truncated: out.omitted.length > 0 || stats.walkCapped,
    stats,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDERING
// ─────────────────────────────────────────────────────────────────────────────

function readPackageJson(io, candidates) {
  const empty = { entryPoints: [], scripts: [], scriptsOmitted: 0 };
  if (!candidates.some((f) => f.path === 'package.json')) return empty;
  let raw = null;
  try { raw = io.readFileImpl('package.json'); } catch { return empty; }
  if (typeof raw !== 'string') return empty;
  let pkg;
  // ⚠️ A REPO MID-EDIT STILL GETS A MAP. A half-typed package.json is a normal
  // state of a working tree, and it is not a reason to blind the model.
  try { pkg = JSON.parse(raw); } catch { return empty; }
  if (!pkg || typeof pkg !== 'object') return empty;

  const entryPoints = [];
  if (typeof pkg.main === 'string') entryPoints.push({ kind: 'main', name: 'main', target: pkg.main });
  if (typeof pkg.bin === 'string') entryPoints.push({ kind: 'bin', name: pkg.name ?? 'bin', target: pkg.bin });
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const name of Object.keys(pkg.bin).sort(byCodePoint)) {
      if (typeof pkg.bin[name] === 'string') entryPoints.push({ kind: 'bin', name, target: pkg.bin[name] });
    }
  }
  const scripts = [];
  let scriptsOmitted = 0;
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    // ⚠️ RANKED, NOT ALPHABETICAL — see `rankScripts`; alphabetical hid `npm test`.
    const runnable = Object.keys(pkg.scripts).filter((n) => typeof pkg.scripts[n] === 'string');
    const picked = rankScripts(runnable);
    scriptsOmitted = picked.omitted;
    for (const name of picked.chosen) {
      const cmd = pkg.scripts[name];
      scripts.push({ name, cmd: cmd.length > 70 ? `${cmd.slice(0, 70)}…` : cmd });
    }
  }
  return { entryPoints, scripts, scriptsOmitted };
}

function renderMap({ chosen, taskChosen = [], omitted, ordered, stats, pkg, lineFor, taskLineFor = lineFor, symAllowed, taskSymAllowed = symAllowed, taskSeeded = false }) {
  const total = ordered.length;
  /** Both tranches are listed; the totals must count both. */
  const chosenPaths = new Set(chosen.map((f) => f.path));
  const shownCount = chosen.length + taskChosen.filter((f) => !chosenPaths.has(f.path)).length;
  const truncated = omitted.length > 0 || stats.walkCapped;
  const parts = [];

  /**
   * ── ⭐⭐ THE COUNT WAS AT BYTE 0, AND IT IS THE THING THAT CHANGES MOST ──────
   *
   * ⚠️⚠️ MEASURED 2026-08-16 on this repo (346 files, a 19,950-byte / ~5,000-token
   * map), by building the map, creating ONE file, and building it again:
   *
   *     agent creates one new source file    13 of 19,975 bytes survive   0.1%
   *     agent creates one new test file      13 of 19,987 bytes survive   0.1%
   *     agent EDITS an existing file      19,760 of 19,952 bytes survive  99.0%
   *
   * The edit case is 99% because the fix below this function already moved
   * LARGEST and RECENTLY CHANGED behind FILES. The CREATE case was 0.1% because
   * of THIS LINE: `346 files` became `347 files` at byte 13, and a prefix cache
   * is worth nothing past its first differing byte, so the entire map — every
   * section, including the ones that did not change — was re-paid at full price.
   *
   * ⚠️ AND CREATING A FILE IS NOT AN EDGE CASE. It is what a coding agent does;
   * the CLI is then invoked again in the same repo, which is the whole shape of
   * the cache floor the pricing is sized on.
   *
   * ⭐ SAME INFORMATION, MOVED, NOT DROPPED. The counts render in `TOTALS` at the
   * very end, beside `NOT LISTED`, which is where the omission breakdown already
   * lives and is the more useful place to read them anyway. What stays here is
   * COMPLETE / INCOMPLETE — the one fact the model must have BEFORE it reads the
   * listing ("is this everything?"), and the one that does NOT move when a file
   * appears: it flips only when the repo crosses the token budget.
   *
   * ⚠️ THE HEADER MUST NAME WHERE THE NUMBERS WENT. A map that says INCOMPLETE
   * and never says how incomplete is unactionable, which is the defect the
   * original line was written to close — the fix is placement, not deletion.
   *
   * ⚠️⚠️ AND IT MUST BE SHORTER THAN WHAT IT REPLACED, NOT LONGER. The first
   * draft spent an explanatory sentence here and turned the depth-cliff test
   * red — measured, and the mechanism is exact: the map renders against a TOKEN
   * BUDGET, so every fixed byte of preamble is a file line the budget can no
   * longer afford. That fixture needed 401 estimated tokens to reach its 33rd
   * file and had 400; 61 bytes of new prose bought the deepest directory band
   * back out of the map. A caching change that quietly shrinks coverage is not a
   * win, so both lines below are SHORTER than the counted versions they replace.
   */
  parts.push(truncated
    ? 'REPO MAP — INCOMPLETE (counts at the end)'
    : 'REPO MAP — COMPLETE (counts at the end)');

  // ⭐ THE LABEL ONLY APPEARS WHEN THERE IS A GUESS TO LABEL. Printing it over
  // a map with no symbols spends tokens warning about nothing.
  if (chosen.some((f) => f.symbols && symAllowed.has(f.path))) {
    parts.push('symbol names are a regex guess, not a parse — a missing name proves nothing');
  }

  if (pkg.entryPoints.length > 0 || pkg.scripts.length > 0) {
    const lines = ['', 'ENTRY POINTS'];
    for (const e of pkg.entryPoints) lines.push(`  ${e.kind} ${e.name}  ${e.target}`);
    for (const s of pkg.scripts) lines.push(`  script ${s.name}  ${s.cmd}`);
    // ⚠️ SAID OUT LOUD, for the same reason the FILES section states its total:
    // a list that is silently short reads as the complete set, and the model
    // then believes a script it cannot see does not exist.
    if (pkg.scriptsOmitted > 0) {
      lines.push(`  ${pkg.scriptsOmitted} further script${pkg.scriptsOmitted === 1 ? '' : 's'} not shown — read package.json for the rest`);
    }
    parts.push(lines.join('\n'));
  }

  const testDirs = new Map();
  for (const f of chosen) {
    const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '';
    if (top && TEST_DIR_NAMES.has(top)) testDirs.set(top, (testDirs.get(top) ?? 0) + 1);
  }
  /**
   * ⚠️ NAMES HERE, COUNTS IN `TOTALS` — for the same measured reason as the
   * header. `test/  190 files` becomes `191 files` the moment the agent writes
   * one test, and this section sits AHEAD of the FILES listing, so with the
   * header fixed this line would simply become the new byte-13. The question
   * this section answers is "where are the tests", and a directory name answers
   * it whole; the size of the suite is a total, and totals now live together.
   */
  const testDirNames = [...testDirs.keys()].sort(byCodePoint);
  if (testDirs.size > 0) {
    parts.push(['', 'TESTS', ...testDirNames.map((name) => `  ${name}/`)].join('\n'));
  }

  const listed = [...chosen].sort((a, b) => byCodePoint(a.path, b.path));
  parts.push(['', 'FILES', ...listed.map(lineFor)].join('\n'));

  /**
   * ── ⭐⭐ THE TWO VOLATILE SECTIONS COME LAST, AND THAT IS THE WHOLE POINT ──
   *
   * ⚠️⚠️ THEY USED TO COME BEFORE `FILES`, AND IT COST ~60% OF THE MAP. Both
   * are ordered by something the AGENT ITSELF CHANGES — byte size and mtime — so
   * writing ONE file reshuffles them. Sitting ahead of `FILES` (hundreds of lines
   * on any real repo, against ~10 here) that meant a single write diverged the
   * prompt at roughly a third of the way in; from down here it diverges at ~95%.
   * The map is the bulk of round 1's user message, so this decides how much of a
   * fresh run can be served out of the previous run's cache — the common case for
   * a CLI, which is invoked over and over in the same repo.
   *
   * ⚠️ DETERMINISM AND STABILITY ARE DIFFERENT PROPERTIES, and only the first
   * was designed for. The header rule ("deterministic, never a rendered age") is
   * about `readdir` order and clocks; it says nothing about the agent's own
   * edits. Both are needed, and the fix for the second is placement, not sorting.
   *
   * ⚠️ SAME INFORMATION, SAME MAP — nothing is dropped, and no line changes.
   * A model reading top to bottom now meets the stable inventory first and the two
   * ranked hints after it, which is also the better reading order.
   */
  // ⚠️ TWO IS THE THRESHOLD, NOT THREE. A "largest files" list of one entry is
  // noise, but a two-file repo still has a biggest file and a newest one.
  if (chosen.length >= 2) {
    const largest = [...chosen]
      .sort((a, b) => (b.size - a.size) || byCodePoint(a.path, b.path))
      .slice(0, 5);
    parts.push(['', 'LARGEST', ...largest.map((f) => `  ${f.path}  ${f.size} bytes`)].join('\n'));

    /**
     * ⭐ AN ORDER, NEVER A TIMESTAMP. "modified 4 minutes ago" changes on every
     * single run, which changes the prompt prefix, which throws away the 3.05x
     * cache discount for a fact nobody reads. The rank carries the whole signal.
     */
    const recent = [...chosen]
      .sort((a, b) => (b.mtimeMs - a.mtimeMs) || byCodePoint(a.path, b.path))
      .slice(0, 5);
    parts.push(['', 'RECENTLY CHANGED — newest first', ...recent.map((f) => `  ${f.path}`)].join('\n'));
  }

  /**
   * ── ⭐⭐⭐ THE ONLY TASK-VARYING SECTION, AND IT IS DELIBERATELY DOWN HERE ───
   *
   * Everything above is chosen by a ranking that never sees the user's words,
   * so it is byte-identical for every task in this repository. This block is
   * the part that changes when the QUESTION changes, and putting it last is the
   * same move this file already made for `LARGEST` and `RECENTLY CHANGED` —
   * measured there at ~60% of the map, measured here at 97.9%.
   *
   * ⚠️ IT MUST SAY WHAT IT IS. An unlabelled second list of paths reads as a
   * contradiction of the first ("why is this file not in FILES?"). Naming it as
   * the task-relevant addition is what turns a rendering artefact into
   * information the model can use: these are the files the request itself
   * points at.
   */
  if (taskChosen.length > 0) {
    const lines = [
      '',
      /**
       * ⚠️⚠️ BOTH HEADINGS ARE SHORT, AND THE UNSEEDED ONE IS SHORTEST, BECAUSE
       * A HEADING IS PAID FOR IN FILES. Measured: the first draft spent a
       * sentence explaining the unseeded case and turned the depth-cliff fixture
       * red — at a 400-token budget, ~21 tokens of prose bought the deepest
       * directory band out of the map. `renderMap`'s own header records the
       * identical trap. Every fixed byte here is a file line the budget can no
       * longer afford.
       */
      taskSeeded ? 'ALSO RELEVANT — files this request names' : 'FILES (continued)',
    ];
    /**
     * ⚠️ THE GUESS LABEL IS REPEATED HERE RATHER THAN HOISTED, and the reason is
     * the prefix. The label at the top of the map is keyed on the STATIC tranche
     * only; keying it on this block instead would make the map's second line
     * depend on the task, which is the exact defect this split exists to remove.
     * A duplicated eleven-word caveat in the tail is the cheap half of that trade.
     */
    if (!chosen.some((f) => f.symbols && symAllowed.has(f.path))
      && taskChosen.some((f) => f.symbols && taskSymAllowed.has(f.path))) {
      lines.push('  symbol names are a regex guess, not a parse — a missing name proves nothing');
    }
    for (const f of [...taskChosen].sort((a, b) => byCodePoint(a.path, b.path))) lines.push(taskLineFor(f));
    parts.push(lines.join('\n'));
  }

  const notes = [];
  if (omitted.length > 0) {
    notes.push(`  omitted for budget  ${omitted.length} files — use find_files or search_text to reach them`);
    const byTop = new Map();
    for (const f of omitted) {
      const top = f.path.includes('/') ? `${f.path.slice(0, f.path.indexOf('/'))}/` : './';
      byTop.set(top, (byTop.get(top) ?? 0) + 1);
    }
    const gaps = [...byTop.entries()]
      .sort((a, b) => (b[1] - a[1]) || byCodePoint(a[0], b[0]))
      .slice(0, MAX_GAP_LINES);
    for (const [dir, n] of gaps) notes.push(`  ${dir}  ${n} files`);
  }
  if (stats.walkCapped) notes.push('  walk capped  the tree exceeded the entry limit and was cut short');
  if (stats.skippedDirNames.length > 0) notes.push(`  not walked  ${stats.skippedDirNames.join(', ')}`);
  if (stats.gitignored > 0) notes.push(`  gitignored  ${stats.gitignored} entries`);
  if (stats.hidden > 0) notes.push(`  hidden  ${stats.hidden} entries`);
  if (stats.withheld > 0) notes.push(`  withheld  ${stats.withheld} credential-shaped files`);
  if (stats.unreadableDirs > 0) notes.push(`  unreadable  ${stats.unreadableDirs} directories`);
  if (notes.length > 0) parts.push(['', 'NOT LISTED', ...notes].join('\n'));

  /**
   * ── ⭐⭐ EVERY NUMBER THAT MOVES WHEN A FILE APPEARS, IN ONE PLACE, LAST ─────
   *
   * ⚠️ THIS IS NOT A NEW FACT, IT IS A RELOCATED ONE. `${total} files found,
   * ${chosen.length} listed` used to be the first thirteen bytes of the map and
   * `test/ N files` the ~350th; both changed on any file creation and both sat
   * ahead of the FILES listing, which is the bulk of the map. Down here they
   * cost the tail instead of the whole thing.
   *
   * ⚠️ IT IS UNCONDITIONAL, unlike `NOT LISTED`. A map with nothing omitted
   * still has a total, and "how big is this project" is a question the model
   * answers wrongly by guessing if nothing states it.
   *
   * ⚠️ AND IT GOES AFTER `NOT LISTED`, NOT BEFORE. Both are volatile, so the
   * order between them costs nothing — but the omission breakdown is what a
   * reader wants immediately after "INCOMPLETE", and the totals are the summary
   * it adds up to.
   */
  const totals = [
    '',
    truncated ? `TOTALS  ${total} files found, ${shownCount} listed` : `TOTALS  ${total} files, all listed`,
    ...testDirNames.map((name) => `  ${name}/  ${testDirs.get(name)} files`),
  ];
  parts.push(totals.join('\n'));

  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// THE WIRING SEAM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one call `turn.mjs` needs.
 *
 * ⚠️ IT RETURNS A STRING AND NEVER THROWS. A pre-read is an optimisation, not
 * a precondition: an unreadable workspace must degrade to "no map" and let the
 * turn proceed, never take the turn down with it. That is why every failure
 * here is an empty string rather than an exception or an apology in the prompt.
 */
export function repoMapForExecutor(executor, opts = {}) {
  try {
    const root = executor?.root;
    if (!root || typeof root !== 'string') return '';
    if (!existsSync(root)) return '';
    const map = buildRepoMap(root, {}, opts);
    return map.ok ? map.text : '';
  } catch {
    return '';
  }
}
