/**
 * ── ⭐⭐⭐ lib/localize.mjs — WHICH FILES, AND NOTHING ELSE ───────────────────
 *
 * THE MEASUREMENT THIS MODULE EXISTS FOR. File-level localization is worth a
 * **15-17x improvement over a no-file baseline** — larger than any prompt,
 * model or harness change measured on this codebase. Everything downstream (the
 * edit, the patch, the verifier) operates on whatever files arrived; if the
 * right file is not among them, none of it can succeed.
 *
 * ── ⚠️ FOUR RESULTS THAT CONTRADICT THE OBVIOUS DESIGN ──────────────────────
 *
 *   1. **LLM-selected files BEAT gold.** Model-chosen files scored **60.6%**
 *      using **8.5 files**; the gold buggy-files-only set scored **56.2%** using
 *      **1.25**. Surrounding context is not slack — it is the difference. So
 *      this module PADS a thin answer rather than trusting a precise one.
 *   2. **The optimum is 6-10 files.** Not one, not fifty. Both bounds are
 *      enforced here (`padToWindow`).
 *   3. **Line-level narrowing DEGRADES results.** Cutting a file down to the
 *      suspect lines removes the context that made the file useful and adds
 *      noise. ⚠️ THERE IS DELIBERATELY NO LINE-RANGE STEP IN THIS MODULE, and
 *      adding one would be a regression, not a feature.
 *   4. **The winning approach uses NO EMBEDDINGS AT ALL.** No index, no vector
 *      store, no similarity. Repo tree → an explicit "which folders are
 *      IRRELEVANT" filter → 5-10 files ordered by importance → skeletons →
 *      stop. The negative filter is the step almost nobody copies and it is the
 *      one that makes the rest cheap.
 *
 * Remaining headroom for PERFECT localization is **+7.7 points**, so this is not
 * a place to spend forever — it is a place to stop being blind.
 *
 * ── ⚠️ WHAT THIS MODULE IS NOT ─────────────────────────────────────────────
 *
 * It is NOT `repo-map.mjs`. That module renders a budgeted list of FILES with
 * exported symbol names, and it is the right thing for round 1 of every turn.
 * This one renders DIRECTORIES, because the question here is different: the
 * model is being asked which folders to throw away, and a file list cannot be
 * thrown away by the folder. The two are complementary and share `estimateTokens`
 * and `byCodePoint` rather than re-deriving them.
 *
 * ⚠️⚠️ IT MAKES NO MODEL CALLS AND CANNOT. There is no import of `model.mjs`
 * or `chain.mjs` anywhere in this file; every model interaction goes through an
 * injected `askImpl`, and with no `askImpl` the loop refuses to run. That is not
 * a testing convenience — it means a bug in this module cannot cost money,
 * because there is no client in scope for it to call.
 *
 * ⭐ EVERY EXPORT BELOW IS PURE except `localize`, which is async only because
 * `askImpl` is. No clock, no randomness, no ambient `fs`.
 */

import { estimateTokens } from './repo-map.mjs';
import { byCodePoint } from './prefix-order.mjs';

/**
 * ⭐ THE DEFAULT IS SMALL ON PURPOSE — 2,000, against `repo-map`'s 9,000.
 *
 * The tree is not the payload, it is a QUESTION: "which of these folders can we
 * throw away?". Measured on the shape this module targets — 50,000 files over
 * 40 packages — the whole tree renders in ~90 lines, roughly 400 tokens, so the
 * budget is not what limits a real monorepo. It limits the pathological case of
 * a repo with thousands of near-empty directories, which is precisely where an
 * unbounded renderer would have produced tens of thousands of tokens to say
 * almost nothing.
 */
export const DEFAULT_TREE_BUDGET_TOKENS = 2_000;

/**
 * ⭐ 6 AND 10 ARE THE MEASURED WINDOW, not a taste call. Below 6 the model is
 * working without the surrounding context that beat gold; above 10 the extra
 * files measure as noise. Both ends are enforced.
 */
export const OPTIMAL_MIN_FILES = 6;
export const OPTIMAL_MAX_FILES = 10;

/**
 * ⚠️ THE LOOP IS BOUNDED BECAUSE A MODEL CAN NAME A NEW FILE FOREVER. Three
 * rounds is: name → look at skeletons → confirm. A run that has not converged
 * by then is not going to, and every extra round is a whole model call.
 */
export const MAX_LOCALIZE_ROUNDS = 3;

/** How many directories the omission note names before it stops. */
const MAX_GAP_LINES = 8;

/** A skeleton line longer than this is a minified file, not a signature. */
const MAX_LINE_CHARS = 200;

/** A signature spanning more lines than this is not a signature any more. */
const MAX_SIGNATURE_LINES = 8;

/** Source extensions a padding sibling may have. Prose is not a code sibling. */
const SOURCE_EXT = /\.(mjs|cjs|jsx?|tsx?|mts|cts|py|go|rs|rb|php|java|kt|swift|cs|c|h|cc|cpp|hpp|vue|svelte)$/i;

// ─────────────────────────────────────────────────────────────────────────────
// PATHS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One spelling of a path, so two spellings of the same file cannot read as two
 * files. ⚠️ THE BACKSLASH CASE IS NOT HYPOTHETICAL — this project is developed
 * on Windows, and a model handed `lib\localize.mjs` in one round and
 * `lib/localize.mjs` in the next would never reach a fixed point.
 */
export function normalizePath(p) {
  if (typeof p !== 'string') return '';
  let out = p.replace(/\\/g, '/').trim();
  while (out.startsWith('./')) out = out.slice(2);
  while (out.startsWith('/')) out = out.slice(1);
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/** The directory a path sits in. `''` — not `'.'` — for a file at the root. */
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function depthOf(dir) {
  if (dir === '') return 0;
  return dir.split('/').length;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TREE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Index every directory implied by a list of paths.
 *
 * ⭐ `own` AND `subtree` ARE BOTH NEEDED, and keeping only one is the bug.
 * `own` alone makes a parent whose children were pruned look empty; `subtree`
 * alone makes a package root look like it holds 1,250 files directly. The model
 * decides whether to cut a folder on the size of what it is cutting, which is
 * `subtree`, and decides whether to look inside on `own`.
 *
 * @param {string[]} paths
 * @returns {Map<string, {dir: string, own: number, subtree: number, depth: number}>}
 */
export function buildDirIndex(paths) {
  const index = new Map();
  const touch = (dir) => {
    let row = index.get(dir);
    if (!row) {
      row = { dir, own: 0, subtree: 0, depth: depthOf(dir) };
      index.set(dir, row);
    }
    return row;
  };
  touch('');

  for (const raw of Array.isArray(paths) ? paths : []) {
    const path = normalizePath(raw);
    if (path === '') continue;
    const dir = dirOf(path);
    touch(dir).own += 1;
    // Every ancestor counts it in its subtree, including the root sentinel.
    let cursor = dir;
    for (;;) {
      touch(cursor).subtree += 1;
      if (cursor === '') break;
      cursor = dirOf(cursor);
    }
  }
  return index;
}

/**
 * Render the directory tree, under a hard budget.
 *
 * ── ⭐⭐ WHY DIRECTORIES, AND WHY THIS IS THE SIZE ANSWER ────────────────────
 *
 * A 50,000-file monorepo must not produce a 50,000-line prompt. It does not,
 * and not because of the budget — because the UNIT is a directory. Measured on
 * exactly that shape (40 packages × 1,250 files): **90 lines, and all 40
 * packages visible**. The budget is the second line of defence, for a tree that
 * is pathological in directories rather than files.
 *
 * ── ⭐ SHALLOW FIRST, AND WHY THAT IS NOT `repo-map`'s DEPTH CLIFF ──────────
 *
 * `repo-map.mjs` documents, with numbers, that ordering a FILE list by depth
 * produced "659 files listed, drawn from 7 of 360 directories" — a cliff. The
 * ordering here is depth-first-shallow anyway, and the inversion is the point:
 * the model is choosing folders to DISCARD, and a folder subsumes its subtree.
 * Cutting `docs/` cuts every `docs/**` whether or not `docs/deep/deeper/` was
 * ever printed. So a shallow line is worth more than a deep one here in a way
 * it never is in a file list, and a deep directory that was not shown is not
 * invisible — its files are still counted in its parent's `subtree`.
 *
 * @param {string[]} paths
 * @param {{budgetTokens?: number}} [opts]
 */
export function renderTree(paths, opts = {}) {
  const budgetTokens = opts.budgetTokens ?? DEFAULT_TREE_BUDGET_TOKENS;
  const index = buildDirIndex(paths);
  const filesTotal = index.get('')?.subtree ?? 0;

  // Directories with nothing in their subtree cannot exist here (they are only
  // created by a path), but a defensive filter costs nothing and keeps the
  // renderer honest if the index is ever fed directly.
  const rows = [...index.values()].filter((r) => r.subtree > 0);
  rows.sort((a, b) => a.depth - b.depth || b.subtree - a.subtree || byCodePoint(a.dir, b.dir));

  const lineFor = (r) => {
    const name = r.dir === '' ? './' : `${r.dir}/`;
    const deeper = r.subtree - r.own;
    if (deeper > 0) return `  ${name}  ${r.own} files (+${deeper} deeper)`;
    return `  ${name}  ${r.own} files`;
  };

  const render = (n) => {
    const shown = rows.slice(0, n);
    const hidden = rows.slice(n);
    const parts = [
      'REPO TREE — directories only. Counts are files directly in the folder;',
      '"+N deeper" is everything below it, shown or not.',
      '',
      ...[...shown].sort((a, b) => byCodePoint(a.dir, b.dir)).map(lineFor),
    ];
    if (hidden.length > 0) {
      /**
       * ⚠️ NAMED PARENTS, NOT A BARE COUNT. `repo-map.mjs` learned this the
       * same way: "42 directories omitted" is unactionable, while "src/  31
       * directories" is a next move — and here it is more than a courtesy,
       * because the model is about to declare folders irrelevant and must not
       * declare one irrelevant on the strength of a listing it cannot see.
       */
      const byTop = new Map();
      for (const r of hidden) {
        const top = r.dir.includes('/') ? `${r.dir.slice(0, r.dir.indexOf('/'))}/` : `${r.dir}/`;
        byTop.set(top, (byTop.get(top) ?? 0) + 1);
      }
      const gaps = [...byTop.entries()]
        .sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))
        .slice(0, MAX_GAP_LINES);
      parts.push('', `NOT SHOWN  ${hidden.length} of ${rows.length} directories — deepest first`);
      for (const [top, n2] of gaps) parts.push(`  under ${top}  ${n2} directories`);
    }
    parts.push('', `TOTALS  ${rows.length} directories, ${filesTotal} files`);
    return parts.join('\n');
  };

  // Largest prefix that fits. Monotonic in `n`, so a binary search is exact and
  // cannot loop — a renderer that hangs on a big repo is the failure this whole
  // module is meant to prevent.
  let lo = 0;
  let hi = rows.length;
  if (estimateTokens(render(hi)) > budgetTokens) {
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateTokens(render(mid)) <= budgetTokens) lo = mid;
      else hi = mid - 1;
    }
  } else {
    lo = rows.length;
  }

  const text = render(lo);
  const tokens = estimateTokens(text);
  return {
    text,
    dirsTotal: rows.length,
    dirsShown: lo,
    filesTotal,
    truncated: lo < rows.length,
    tokens,
    /**
     * ── ⚠️ THE BUDGET BOUNDS THE LISTING, NOT THE FRAME, AND IT SAYS SO ──────
     *
     * Measured while writing this: at `budgetTokens: 60` the renderer returned
     * 127 tokens with ZERO directories listed, because the header, the
     * NOT-SHOWN note and the totals are a fixed ~120-token frame. A budget below
     * the frame cannot be met by dropping lines, and the only two honest
     * options are to return a truncated frame that lies about being a tree, or
     * to return the frame and FLAG the overrun.
     *
     * ⭐ Flagging is the one that cannot mislead. A caller that must fit a hard
     * ceiling can test this and drop the tree entirely; a caller that cannot
     * still gets a tree that states its own totals. Silently exceeding the
     * budget while reporting nothing is the shape this repo keeps paying for.
     */
    budgetOverrun: tokens > budgetTokens,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE NEGATIVE FILTER — the step almost nobody copies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a model-named list of IRRELEVANT folders to a path list.
 *
 * ── ⭐ WHY ASK WHAT TO THROW AWAY RATHER THAN WHAT TO KEEP ──────────────────
 *
 * A "which folders matter" question makes the model commit to a small set from
 * a listing it has only skimmed, and everything it forgot is gone. A "which
 * folders are irrelevant" question is answered from confidence: `docs/`,
 * `vendor/`, `fixtures/` are obviously not where a login bug lives, and
 * anything the model is unsure about simply survives. The failure mode of the
 * first question is losing the answer; the failure mode of the second is doing
 * less work than we hoped. Those are not comparable costs.
 *
 * ── ⚠️ TWO GUARDS, BOTH OF THEM LOAD-BEARING ───────────────────────────────
 *
 *   · SEGMENT MATCHING. `src/app` must not delete `src/apple.js`. A bare
 *     `startsWith` does exactly that, silently, and the file it eats is a source
 *     file in the same directory as the one the model actually wanted.
 *   · REFUSAL. A filter that removes EVERY candidate is rejected whole. An
 *     empty candidate set does not read downstream as "the filter was wrong",
 *     it reads as "this repo has no relevant files" — an error disguised as an
 *     answer, which is the one shape this codebase keeps paying for.
 *
 * @returns {{kept: string[], removed: string[], unmatched: string[], rejected: string[], refused: boolean, reason: string}}
 */
export function applyIrrelevantFilter(paths, folders) {
  const all = (Array.isArray(paths) ? paths : []).map(normalizePath).filter((p) => p !== '');
  const rejected = [];
  const wanted = [];
  for (const raw of Array.isArray(folders) ? folders : []) {
    const f = normalizePath(raw);
    // ⚠️ `.`, `/`, `` and `..` all mean "the whole repo" after normalization.
    // They are rejected here rather than caught by the emptiness guard below,
    // so the caller can tell a bad ENTRY from an over-broad but legitimate one.
    if (f === '' || f === '.' || f === '..') { rejected.push(String(raw)); continue; }
    wanted.push(f);
  }

  const hits = new Map(wanted.map((f) => [f, 0]));
  const kept = [];
  const removed = [];
  for (const p of all) {
    let cut = null;
    for (const f of wanted) {
      // Equality catches a folder name that is actually a file; the trailing
      // slash is what makes this a SEGMENT match rather than a prefix match.
      if (p === f || p.startsWith(`${f}/`)) { cut = f; break; }
    }
    if (cut === null) kept.push(p);
    else { removed.push(p); hits.set(cut, hits.get(cut) + 1); }
  }

  const unmatched = [...hits.entries()].filter(([, n]) => n === 0).map(([f]) => f).sort(byCodePoint);

  if (all.length > 0 && kept.length === 0) {
    return {
      kept: all,
      removed: [],
      unmatched,
      rejected,
      refused: true,
      reason: 'the filter would have removed every candidate file, so it was not applied',
    };
  }

  return { kept, removed, unmatched, rejected, refused: false, reason: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SKELETON — signatures and declarations, never a body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ EXTENSION → LANGUAGE, and an unknown one produces NOTHING.
 * `repo-map.mjs` states the rule for symbol names and it is stronger here: a
 * markdown file containing the words "export function" is not a module, and a
 * fabricated skeleton is worse than no skeleton because the model reads a
 * skeleton as a PARSE and stops looking.
 */
function languageOf(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ''));
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (['mjs', 'cjs', 'js', 'jsx'].includes(ext)) return 'js';
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'ts';
  if (ext === 'py') return 'py';
  return null;
}

/** Words that begin a STATEMENT, not a declaration. A body line, in short. */
const JS_CONTROL = /^(if|for|while|switch|catch|return|else|do|try|throw|await|yield|case|break|continue|new|delete|typeof|void)\b/;

const JS_DECL = [
  /^export\s+default\b/,
  /^export\s+(async\s+)?function\b/,
  /^export\s+(abstract\s+)?class\b/,
  /^export\s+(const|let|var)\b/,
  /^export\s+(type|interface|enum|namespace|declare)\b/,
  /^export\s*[{*]/,
  /^import\b/,
  /^(async\s+)?function\s*\*?\s*[A-Za-z_$]/,
  /^(abstract\s+)?class\s+[A-Za-z_$]/,
  /^(const|let|var)\s+[A-Za-z_$][\w$]*\s*[:=]/,
  /^(type|interface|enum|namespace|declare)\s+[A-Za-z_$]/,
  /^module\.exports\b/,
  /^exports\.[A-Za-z_$]/,
];

/** Inside a class body: `run(x) {`, `async run(x) {`, `get size() {`, `#priv(` … */
const JS_MEMBER = /^((public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*[#*]?[A-Za-z_$][\w$]*\s*[(<]/;

const PY_DECL = [
  /^(async\s+)?def\s+/,
  /^class\s+/,
  /^@[A-Za-z_]/,
  /^(import|from)\s+/,
  /^[A-Z_][A-Z0-9_]*\s*[:=]/,
];

/** Parens/brackets still open at the end of a line — i.e. the signature runs on. */
function openDelta(line) {
  let d = 0;
  let str = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (str) {
      if (c === '\\') { i += 1; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '(' || c === '[') d += 1;
    else if (c === ')' || c === ']') d -= 1;
  }
  return d;
}

/**
 * ⭐ THE BODY IS CUT AT THE BRACE, not at the line. `export function f(a) { return a; }`
 * is a declaration AND a body on one line, and keeping it whole leaks exactly
 * what the skeleton exists to drop.
 */
function trimBody(line, language) {
  let out = line;
  if (language !== 'py') {
    /**
     * ⚠️⚠️ THE FIRST VERSION ATE EVERY IMPORT, AND THE TEST CAUGHT IT.
     * `import { readFileSync } from 'node:fs';` rendered as the single word
     * `import` — the brace-cut fired on a BINDING LIST. An import line that
     * says nothing about what was imported is worse than no import line: the
     * model reads "this file imports something" and learns nothing, while
     * paying for the line. On an import/export the braces ARE the payload.
     */
    /**
     * ⚠️⚠️ THE FIRST FIX FOR THAT WAS `/^(import|export)\b/` AND IT WAS TOO
     * WIDE — a second test caught it. It exempted `export function f(a) {
     * return SECRET; }` as well, so a one-line function body was reproduced
     * verbatim in the "signatures only" output. The exemption belongs to the
     * two forms where a brace is a BINDING LIST rather than a block: an import,
     * and a re-export (`export { a }` / `export * from`). `export function`,
     * `export class` and `export const` all open real bodies.
     */
    const isBindingList = /^import\b/.test(out) || /^export\s*[{*]/.test(out);
    const brace = isBindingList ? -1 : out.indexOf('{');
    // ⚠️ NOT WHEN THE BRACE IS THE TYPE. `function f(o: { a: number })` opens a
    // brace inside the parameter list; cutting there destroys the signature.
    if (brace >= 0 && openDelta(out.slice(0, brace)) <= 0) out = out.slice(0, brace).replace(/\s+$/, '');
  } else {
    const colon = out.lastIndexOf(':');
    if (colon >= 0 && colon === out.length - 1) out = out.slice(0, colon + 1);
  }
  if (out.length > MAX_LINE_CHARS) out = `${out.slice(0, MAX_LINE_CHARS)}…`;
  return out;
}

/**
 * Signatures and declarations for one file, with line numbers, no bodies.
 *
 * ── ⭐ WHY THIS IS THE STEP THAT MAKES 6-10 FILES AFFORDABLE ────────────────
 *
 * The window is 6-10 files because that is what measures best — but ten whole
 * files is tens of thousands of tokens and blows the round budget on its own.
 * A skeleton is what makes the measured optimum reachable rather than
 * theoretical: the model sees the shape of ten files for the price of two, and
 * then spends `read_file` on the one or two it actually needs.
 *
 * ── ⭐ THE LINE NUMBERS ARE THE ELISION MARKER ──────────────────────────────
 *
 * There is no `// …` between kept lines, because the gap in the numbering says
 * the same thing for free AND says how big the gap is. They are also the only
 * way back: a model that wants the body of `run()` reads `read_around` at that
 * number instead of re-reading the file.
 *
 * ⚠️ THE OUTPUT IS A REGEX GUESS AND SAYS SO. A missing member proves nothing.
 *
 * @returns {{ok: boolean, language: string|null, text: string, linesKept: number, linesTotal: number, bytesIn: number, bytesOut: number, reason: string}}
 */
export function extractSkeleton(path, source, opts = {}) {
  const language = languageOf(path);
  const bytesIn = typeof source === 'string' ? source.length : 0;
  const nothing = (reason) => ({
    ok: false, language, text: '', linesKept: 0, linesTotal: 0, bytesIn, bytesOut: 0, reason,
  });

  if (typeof source !== 'string' || source === '') return nothing('the file is empty or could not be read');
  if (!language) return nothing(`no skeleton for this file type — read it with read_file if you need it`);

  const maxLines = opts.maxLines ?? 400;
  const lines = source.split(/\r?\n/);
  const kept = [];

  let classIndent = -1;
  let carry = 0; // parens still open from an unfinished signature

  for (let i = 0; i < lines.length && kept.length < maxLines; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const indent = raw.length - raw.trimStart().length;

    if (carry > 0) {
      // ⚠️ A SIGNATURE THAT SPANS LINES IS ONE SIGNATURE. Cutting it at the
      // first line leaves `export function wide(` — a fragment that tells the
      // model the function exists and lies about how it is called.
      kept.push({ n: i + 1, text: trimBody(trimmed, language) });
      carry += openDelta(trimmed);
      if (carry < 0) carry = 0;
      continue;
    }

    if (trimmed === '') continue;

    if (language === 'py') {
      if (!PY_DECL.some((rx) => rx.test(trimmed))) continue;
      kept.push({ n: i + 1, text: `${' '.repeat(Math.min(indent, 8))}${trimBody(trimmed, language)}` });
      const d = openDelta(trimmed);
      if (d > 0) carry = Math.min(d, MAX_SIGNATURE_LINES);
      continue;
    }

    // JS/TS. Class membership is tracked by indentation rather than by counting
    // braces: a member is a line INSIDE a class that looks callable, and the
    // class ends at the first line indented no further than the class itself.
    if (classIndent >= 0 && indent <= classIndent && !/^[})\]]/.test(trimmed)) classIndent = -1;

    /**
     * ── ⚠️⚠️ INDENTATION IS WHAT SEPARATES A DECLARATION FROM A LOCAL ──────
     *
     * The first version matched `^(const|let|var)\s+\w+\s*[:=]` at ANY indent
     * and therefore kept `const intermediate = a * SECRET_BODY_TOKEN;` — a line
     * from inside a function body, which is exactly the thing a skeleton exists
     * to drop. It is not a small leak either: locals are the majority of lines
     * in most functions, so the "skeleton" was reproducing the file.
     *
     * ⭐ A skeleton is MODULE-LEVEL structure plus CLASS MEMBERS, and both of
     * those have a known indentation. `import`/`export` are exempt because a
     * `declare module { … }` block legitimately indents them.
     */
    const isDecl = indent === 0
      ? JS_DECL.some((rx) => rx.test(trimmed))
      : /^(export|import)\b/.test(trimmed) && JS_DECL.some((rx) => rx.test(trimmed));
    const isMember = classIndent >= 0
      && indent > classIndent
      && !JS_CONTROL.test(trimmed)
      && JS_MEMBER.test(trimmed)
      // ⚠️ A CALL IS NOT A MEMBER. `doSomething(x);` matches JS_MEMBER's shape
      // exactly; what separates a declaration from a call is that a declaration
      // OPENS A BODY on the same line or runs on to the next.
      && (trimmed.includes('{') || openDelta(trimmed) > 0 || /[)>]\s*[:;]?\s*$/.test(trimmed))
      && !trimmed.endsWith(';');

    if (!isDecl && !isMember) continue;

    kept.push({ n: i + 1, text: `${classIndent >= 0 && isMember ? '  ' : ''}${trimBody(trimmed, language)}` });

    if (/^(export\s+)?(abstract\s+)?class\s/.test(trimmed) || /^export\s+default\s+class\s/.test(trimmed)) {
      classIndent = indent;
    }
    const d = openDelta(trimmed);
    if (d > 0) carry = Math.min(d, MAX_SIGNATURE_LINES);
  }

  if (kept.length === 0) return nothing('no declarations found — this file may be data, or all body');

  const width = String(lines.length).length;
  const body = kept.map((k) => `${String(k.n).padStart(width, ' ')}: ${k.text}`).join('\n');
  const text = `${path}  — signatures only (a regex guess; a missing member proves nothing)\n${body}`;

  return {
    ok: true,
    language,
    text,
    linesKept: kept.length,
    linesTotal: lines.length,
    bytesIn,
    bytesOut: text.length,
    reason: '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE WINDOW
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enforce the measured 6-10 file window.
 *
 * ⭐ PADDING IS THE COUNTER-INTUITIVE HALF, and it is the finding this whole
 * module is built on: LLM-selected files at **8.5 files scored 60.6%**, gold
 * buggy-files-only at **1.25 files scored 56.2%**. A precise answer measured
 * WORSE than a loose one. So a model that names two files is not rewarded for
 * its confidence — its neighbours are added, because "the file next to the bug"
 * is where the caller, the type and the test live.
 *
 * ⚠️ SIBLINGS ONLY, AND SOURCE ONLY. Padding with `docs/x.md` spends the window
 * on something that cannot contain the answer; padding from an unrelated
 * directory is the noise that line-level narrowing was measured to introduce.
 */
export function padToWindow(chosen, allPaths, min = OPTIMAL_MIN_FILES, max = OPTIMAL_MAX_FILES) {
  const all = (Array.isArray(allPaths) ? allPaths : []).map(normalizePath).filter(Boolean);
  const files = [];
  const seen = new Set();
  for (const raw of Array.isArray(chosen) ? chosen : []) {
    const p = normalizePath(raw);
    if (p === '' || seen.has(p)) continue;
    seen.add(p);
    files.push(p);
  }

  const before = files.length;
  if (files.length < min) {
    const dirs = [...new Set(files.map(dirOf))];
    const siblings = all
      .filter((p) => !seen.has(p) && SOURCE_EXT.test(p) && dirs.includes(dirOf(p)))
      .sort(byCodePoint);
    for (const s of siblings) {
      if (files.length >= min) break;
      seen.add(s);
      files.push(s);
    }
  }

  const out = files.slice(0, max);
  return { files: out, padded: Math.max(0, out.length - before), truncated: files.length > max };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FIXED POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Has the model stopped asking for new files?
 *
 * ⚠️ "NOTHING NEW", NOT "THE SAME LIST". Context is monotone — a file that was
 * put in the prompt last round is still in the prompt — so a round that drops a
 * file it named before has still added nothing and the loop is done. Testing
 * for an identical list would spin forever against a model that reorders, which
 * they do, and each spin is a whole paid round.
 */
export function convergence(inContext, named) {
  const have = new Set((Array.isArray(inContext) ? inContext : []).map(normalizePath).filter(Boolean));
  const added = [];
  for (const raw of Array.isArray(named) ? named : []) {
    const p = normalizePath(raw);
    if (p === '' || have.has(p) || added.includes(p)) continue;
    added.push(p);
  }
  return { converged: added.length === 0, added, union: [...have, ...added] };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE LOOP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agentless's sequence, with every model call injected.
 *
 *   tree → "which folders are IRRELEVANT" → 5-10 files by importance →
 *   skeletons → ask again → stop when nothing new is named.
 *
 * ⚠️ NO EMBEDDINGS, NO INDEX, NO SIMILARITY SEARCH. That is not a shortcut —
 * it is the approach that measured best, and it is why this module has zero
 * dependencies and needs no build step.
 *
 * ⚠️⚠️ AND NO LINE RANGES. Line-level narrowing measured WORSE than whole
 * files. If a future round of this module grows a "which lines" step, it is
 * undoing a measurement, not adding a feature.
 *
 * @param {object} o
 * @param {string[]} o.paths      every candidate path in the repo
 * @param {(req: {step: string, task: string, tree?: string, candidates?: string[], skeletons?: string}) => Promise<string[]>} o.askImpl
 * @param {(path: string) => string|null} [o.readImpl]
 */
export async function localize({
  paths = [],
  task = '',
  askImpl = null,
  readImpl = () => null,
  budgetTokens = DEFAULT_TREE_BUDGET_TOKENS,
  minFiles = OPTIMAL_MIN_FILES,
  maxFiles = OPTIMAL_MAX_FILES,
  maxRounds = MAX_LOCALIZE_ROUNDS,
} = {}) {
  const stats = { askCalls: 0, skeletonBytesIn: 0, skeletonBytesOut: 0 };
  const fail = (error) => ({
    ok: false, error, files: [], skeletons: [], rounds: 0, converged: false,
    tree: '', irrelevant: [], unmatched: [], refused: false, stats,
  });

  /**
   * ⚠️ THIS IS THE SPEND GUARD, AND IT IS STRUCTURAL. The module imports no
   * model client, so "no askImpl" is not a missing option — it is the absence
   * of any way to make a call at all. Refusing here makes that explicit rather
   * than returning a plausible empty answer.
   */
  if (typeof askImpl !== 'function') {
    return fail('localize needs an askImpl — this module makes no model calls of its own');
  }

  const candidates = (Array.isArray(paths) ? paths : []).map(normalizePath).filter(Boolean);
  if (candidates.length === 0) return fail('no candidate paths — nothing to localize against');

  try {
    // ── 1. the tree, and the negative filter ────────────────────────────────
    const tree = renderTree(candidates, { budgetTokens });
    stats.askCalls += 1;
    const folders = await askImpl({ step: 'irrelevant', task, tree: tree.text });
    const filtered = applyIrrelevantFilter(candidates, folders);

    // ── 2..N. files, skeletons, fixed point ────────────────────────────────
    let context = [];
    let skeletons = [];
    let rounds = 0;
    let converged = false;

    for (let r = 0; r < Math.max(1, maxRounds); r++) {
      rounds += 1;
      stats.askCalls += 1;
      const named = await askImpl({
        step: 'files',
        task,
        tree: tree.text,
        candidates: filtered.kept,
        skeletons: skeletons.map((s) => s.text).join('\n\n'),
        round: rounds,
      });

      const conv = convergence(context, named);
      context = conv.union;
      if (conv.converged) { converged = true; break; }

      /**
       * ⚠️ SKELETONS ARE BUILT ONLY FOR WHAT IS NEW. Re-reading a file the
       * model already has in context spends I/O to produce bytes that are
       * already in the prompt — and it would also move them, which costs the
       * prompt cache the whole tail of the message.
       */
      for (const p of conv.added.slice(0, maxFiles)) {
        let src = null;
        try { src = readImpl(p); } catch { src = null; }
        const sk = extractSkeleton(p, src);
        stats.skeletonBytesIn += sk.bytesIn;
        stats.skeletonBytesOut += sk.bytesOut;
        if (sk.ok) skeletons.push({ path: p, text: sk.text });
      }
    }

    const windowed = padToWindow(context, filtered.kept, minFiles, maxFiles);
    // Only keep skeletons for files that survived the window, so the two halves
    // of the answer can never disagree about which files were chosen.
    skeletons = skeletons.filter((s) => windowed.files.includes(s.path));

    return {
      ok: true,
      files: windowed.files,
      skeletons,
      rounds,
      converged,
      tree: tree.text,
      irrelevant: (Array.isArray(folders) ? folders : []).map(normalizePath).filter(Boolean),
      unmatched: filtered.unmatched,
      refused: filtered.refused,
      padded: windowed.padded,
      stats,
      error: '',
    };
  } catch (err) {
    // ⚠️ NEVER THROWS. Localization is an optimisation on top of a turn, exactly
    // as `repoMapForExecutor` is; a provider hiccup must degrade to "we did not
    // narrow it down" and let the turn proceed, never take the turn down.
    return fail(err?.message ? String(err.message) : String(err));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REACHABILITY — schema, dispatch, and the sentence that says it exists
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⭐ THREE PARTS OR IT SCORES ZERO. A capability needs a SCHEMA (the model can
 * name it), a DISPATCH (calling it does something), and a DESCRIPTION (the
 * model knows it exists and when to reach). This repo has shipped
 * built-but-unreachable four times in one day; the schema and the handler live
 * here together so wiring is one import and one case rather than three edits in
 * three files that can drift apart.
 */
export function localizeToolSchemas() {
  return [{
    type: 'function',
    function: {
      name: 'localize_files',
      description:
        'Work out WHICH FILES a task touches, before reading any of them. Renders the repo as a directory tree, '
        + 'discards folders that are irrelevant, then returns 6-10 files ordered by importance with a signatures-only '
        + 'skeleton of each. Use this FIRST on an unfamiliar or large repository — file-level localization measures '
        + '15-17x better than working without it, and 6-10 files with surrounding context measures better than one '
        + 'exact file. Do not ask it for line ranges: narrowing below the file measures WORSE.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What you are trying to change or fix, in one sentence.' },
        },
        required: ['task'],
      },
    },
  }];
}

/**
 * The dispatch half. `deps` carries the seam: the caller supplies `paths`,
 * `askImpl` and `readImpl`, so this function is as network-free as the rest of
 * the module.
 */
export async function runLocalizeTool(args = {}, deps = {}) {
  const task = typeof args.task === 'string' ? args.task : '';
  const res = await localize({ ...deps, task });
  if (!res.ok) return { ok: false, error: res.error };
  const header = res.converged
    ? `localized to ${res.files.length} files in ${res.rounds} round${res.rounds === 1 ? '' : 's'}`
    : `localized to ${res.files.length} files — did NOT converge in ${res.rounds} rounds, so treat this as a starting point`;
  return {
    ok: true,
    files: res.files,
    converged: res.converged,
    text: [header, '', ...res.files.map((f, i) => `  ${i + 1}. ${f}`), '', ...res.skeletons.map((s) => s.text)].join('\n'),
  };
}
