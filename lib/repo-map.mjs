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

import { refusedCommitPath } from './git.mjs';

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
 */
export const DEFAULT_BUDGET_TOKENS = 6_000;

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

/** Code-point comparison. ⚠️ NOT `localeCompare` — ICU differs per machine. */
function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
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
 * Lower is better. Source beats prose beats assets; shallow beats deep, so the
 * SHAPE of the project survives even when most of it does not; and the tiebreak
 * is the path itself, so nothing depends on walk order.
 */
function priority(file, entryTargets) {
  let category = 3;
  if (SOURCE_EXT.test(file.path)) category = 1;
  else if (DOC_EXT.test(file.path)) category = 2;
  if (file.path === 'package.json' || entryTargets.has(file.path)) category = 0;
  return category * 1_000_000 + Math.min(file.depth, 40) * 10_000;
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
  const ordered = [...candidates].sort((a, b) => {
    const d = priority(a, entryTargets) - priority(b, entryTargets);
    return d !== 0 ? d : byCodePoint(a.path, b.path);
  });

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
  const empty = { entryPoints: [], scripts: [] };
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
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const name of Object.keys(pkg.scripts).sort(byCodePoint).slice(0, 6)) {
      const cmd = pkg.scripts[name];
      if (typeof cmd === 'string') scripts.push({ name, cmd: cmd.length > 70 ? `${cmd.slice(0, 70)}…` : cmd });
    }
  }
  return { entryPoints, scripts };
}

function renderMap({ chosen, omitted, ordered, stats, pkg, lineFor, symAllowed }) {
  const total = ordered.length;
  const truncated = omitted.length > 0 || stats.walkCapped;
  const parts = [];

  parts.push(truncated
    ? `REPO MAP — ${total} files found, ${chosen.length} listed (INCOMPLETE)`
    : `REPO MAP — ${total} files, all listed (COMPLETE)`);

  // ⭐ THE LABEL ONLY APPEARS WHEN THERE IS A GUESS TO LABEL. Printing it over
  // a map with no symbols spends tokens warning about nothing.
  if (chosen.some((f) => f.symbols && symAllowed.has(f.path))) {
    parts.push('symbol names are a regex guess, not a parse — a missing name proves nothing');
  }

  if (pkg.entryPoints.length > 0 || pkg.scripts.length > 0) {
    const lines = ['', 'ENTRY POINTS'];
    for (const e of pkg.entryPoints) lines.push(`  ${e.kind} ${e.name}  ${e.target}`);
    for (const s of pkg.scripts) lines.push(`  script ${s.name}  ${s.cmd}`);
    parts.push(lines.join('\n'));
  }

  const testDirs = new Map();
  for (const f of chosen) {
    const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '';
    if (top && TEST_DIR_NAMES.has(top)) testDirs.set(top, (testDirs.get(top) ?? 0) + 1);
  }
  if (testDirs.size > 0) {
    const lines = ['', 'TESTS'];
    for (const name of [...testDirs.keys()].sort(byCodePoint)) lines.push(`  ${name}/  ${testDirs.get(name)} files`);
    parts.push(lines.join('\n'));
  }

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

  const listed = [...chosen].sort((a, b) => byCodePoint(a.path, b.path));
  parts.push(['', 'FILES', ...listed.map(lineFor)].join('\n'));

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
