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
const SYMBOL_EXT = /\.(mjs|cjs|jsx?|tsx?|mts|cts|py|go|rs)$/i;

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
 * ⚠️ NEVER READ FOR SYMBOLS ABOVE THIS. Matches search.mjs's ceiling. A 900KB
 * generated bundle is not a file whose export list helps anyone, and reading it
 * costs real milliseconds per entry across a big tree.
 */
const MAX_SYMBOL_FILE_BYTES = 512 * 1024;

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

/** Symbols are extracted for the highest-priority files only; reads are not free. */
const MAX_SYMBOL_READS = 800;

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

const PY_PATTERNS = [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^class\s+([A-Za-z_]\w*)/gm];
const GO_PATTERNS = [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)/gm];
const RS_PATTERNS = [
  /^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm,
  /^\s*pub\s+(?:struct|enum|trait|mod|type|const|static)\s+([A-Za-z_]\w*)/gm,
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
  const add = (name) => {
    const n = String(name).trim();
    if (!IDENT.test(n)) return;
    if (NOT_A_NAME.has(n)) return;
    found.add(n);
  };

  const run = (patterns) => {
    for (const rx of patterns) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(source)) !== null) add(m[1]);
    }
  };

  if (ext === 'py') run(PY_PATTERNS);
  else if (ext === 'go') run(GO_PATTERNS);
  else if (ext === 'rs') run(RS_PATTERNS);
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
 */
export function orderForBudget(files, entryTargets = new Set()) {
  const byPath = [...files].sort((a, b) => byCodePoint(a.path, b.path));
  const seen = new Map();
  const rows = byPath.map((file) => {
    const category = fileCategory(file, entryTargets);
    // The pass is counted per (directory, category) rather than per directory:
    // a directory's README must not consume the slot its `index.ts` needs.
    const key = `${dirOf(file.path)}\u0000${category}`;
    const pass = seen.get(key) ?? 0;
    seen.set(key, pass + 1);
    return { file, category, pass, depth: Math.min(file.depth, 40) };
  });
  rows.sort((a, b) => a.category - b.category
    || a.pass - b.pass
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
 * @param {object} [opts]               { budgetTokens, maxEntries }
 * @returns {{ ok: boolean, text: string, files: object[], truncated: boolean, stats: object, error?: string }}
 */
export function buildRepoMap(root, impls = {}, opts = {}) {
  const io = { ...defaultImpls(root), ...(impls || {}) };
  // Tolerate the options being folded into the second argument — a caller that
  // writes `buildRepoMap(root, { budgetTokens: 800 })` means something obvious
  // and refusing it would fail correct work.
  const budgetTokens = opts.budgetTokens ?? impls?.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const maxEntries = opts.maxEntries ?? impls?.maxEntries ?? DEFAULT_MAX_ENTRIES;

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

  // ── priority order ────────────────────────────────────────────────────────
  const ordered = orderForBudget(candidates, entryTargets);

  // ── symbols, for the files most likely to be shown ────────────────────────
  for (const f of ordered.slice(0, MAX_SYMBOL_READS)) {
    if (!SYMBOL_EXT.test(f.path)) continue;
    if (f.size > MAX_SYMBOL_FILE_BYTES) continue;
    let src = null;
    try { src = io.readFileImpl(f.path); } catch { src = null; }
    if (typeof src !== 'string') continue;
    const names = extractExports(f.path, src);
    // ⚠️ AN EMPTY LIST IS LEFT UNDEFINED, NOT STORED AS []. `[]` renders as
    // "this file exports nothing", which is a claim a regex cannot make.
    if (names.length > 0) f.symbols = names;
  }

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
  const render = (n, symCount) => {
    const chosen = ordered.slice(0, n);
    const omitted = ordered.slice(n);
    const symAllowed = new Set(ordered.slice(0, symCount).filter((f) => f.symbols).map((f) => f.path));
    const lineFor = (f) => {
      if (!f.symbols || !symAllowed.has(f.path)) return `  ${f.path}`;
      const shown = f.symbols.slice(0, MAX_SYMBOLS_SHOWN);
      const extra = f.symbols.length - shown.length;
      return `  ${f.path}  [${shown.join(', ')}${extra > 0 ? ` +${extra}` : ''}]`;
    };
    return { text: renderMap({ chosen, omitted, ordered, stats, pkg, lineFor, symAllowed }), chosen, omitted };
  };

  /** Largest symbol count that still fits, for a fixed file count. Monotonic. */
  const fitSymbols = (n) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateTokens(render(n, mid).text) <= budgetTokens) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  let take = ordered.length;
  let symCount = ordered.length;
  let out = render(take, symCount);

  if (estimateTokens(out.text) > budgetTokens) {
    symCount = fitSymbols(take);
    out = render(take, symCount);
    // Still over with zero symbols? Only then does a PATH get dropped, from the
    // lowest-priority end, in batches. Bounded: a runaway here is a hang.
    for (let guard = 0; guard < 64 && take > 1; guard++) {
      const used = estimateTokens(out.text);
      if (used <= budgetTokens) break;
      const excess = used - budgetTokens;
      const perLine = Math.max(1, Math.ceil(used / Math.max(1, take)));
      take = Math.max(1, take - Math.max(1, Math.ceil(excess / perLine)));
      out = render(take, symCount);
    }
    // Dropping paths freed room; hand it back to symbols rather than waste it.
    // One pass, after `take` has settled, so this can never oscillate.
    const regained = fitSymbols(take);
    if (regained > symCount) {
      symCount = regained;
      out = render(take, symCount);
    }
  }
  /**
   * ⚠️ `files` CARRIES EVERY SYMBOL LIST THAT WAS EXTRACTED; `text` carries
   * only the ones the budget paid for. That is a deliberate asymmetry — a
   * programmatic caller should not lose data to a rendering decision — and
   * `symbolsShown` is the number that reconciles the two. Do not read a bare
   * path in `text` as "this file exports nothing".
   */
  stats.symbolsShown = ordered.slice(0, Math.min(symCount, take)).filter((f) => f.symbols).length;

  const listed = [...out.chosen].sort((a, b) => byCodePoint(a.path, b.path));
  stats.listedFiles = out.chosen.length;
  stats.omittedFiles = out.omitted.length;
  stats.dirsTotal = new Set(ordered.map((f) => dirOf(f.path))).size;
  stats.dirsListed = new Set(out.chosen.map((f) => dirOf(f.path))).size;
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

function renderMap({ chosen, omitted, ordered, stats, pkg, lineFor, symAllowed }) {
  const total = ordered.length;
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
    truncated ? `TOTALS  ${total} files found, ${chosen.length} listed` : `TOTALS  ${total} files, all listed`,
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
