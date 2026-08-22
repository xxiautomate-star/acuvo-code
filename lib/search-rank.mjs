/**
 * ── ⭐⭐ RANK THE PAGE. `search_text` HAD NO RELEVANCE AT ALL. ───────────────
 *
 * Measured 2026-08-18: `searchText` pushes matches in WALK ORDER — raw
 * filesystem traversal — and caps at `MAX_MATCHES = 60`. So a model hunting a
 * symbol got the first sixty files the directory walk happened to reach, and
 * read them top-down. Whether the DEFINITION was among them was luck; whether it
 * was near the top was pure luck.
 *
 * ⭐ THE SIGNAL THAT MATTERS IS "DEFINITION OR MENTION". A symbol has one
 * definition and many callers, and the model almost always wants the one.
 * `function x` / `class x` / `const x =` / `export` are cheap, high-precision
 * marks of that, and they cost one regex over a line that is already in memory.
 *
 * ── ⚠️ IT REORDERS THE PAGE. IT DOES NOT CHANGE WHICH FILES ARE ON IT. ──────
 * `total`, `unseen`, `nextOffset` and the offset window are all computed before
 * this runs and are untouched. Re-ranking ACROSS pages would mean collecting
 * every match before returning any, which breaks the bounded-scan contract
 * `search.mjs` is built around — and that contract is the reason a search on a
 * large repo does not read the whole thing. A better first page is worth having
 * without it.
 *
 * ⚠️ STABLE BY CONSTRUCTION. Equal scores keep walk order, so output stays
 * deterministic for the same tree. A search whose order shuffled between runs
 * would void the prompt cache on every round that ran one — the CLI's own
 * `repo-map.mjs` sorts by code point for exactly this reason.
 *
 * ⚠️ ITS OWN MODULE, NOT A FUNCTION INSIDE `search.mjs`. Pure, no filesystem,
 * no walk state — so the scoring is testable on plain objects rather than
 * needing a tree on disk.
 */

/** Regex-escape a user/model-supplied identifier. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The bare identifier a pattern is most likely hunting for.
 *
 * ⚠️ THE LAST WORD, NOT THE FIRST. A model searches `export function assemble`
 * or `class\s+Workspace` — the thing it wants is at the end, and the leading
 * words are the qualifier.
 */
export function identifierFrom(pattern) {
  const words = String(pattern || '')
    .replace(/[^A-Za-z0-9_$]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length ? words[words.length - 1] : '';
}

const DEFINING_KEYWORDS = 'function|class|const|let|var|export|def|interface|type|struct|fn';

/** Points for one match. Higher is more likely to be what was asked for. */
export function scoreMatch(match, ident) {
  const line = String(match?.line ?? match?.text ?? '');
  const path = String(match?.path ?? match?.file ?? '');
  let n = 0;

  if (ident) {
    const esc = escapeRe(ident);
    // A definition beats every mention of the same name.
    if (new RegExp(`(?:${DEFINING_KEYWORDS})\\s+${esc}\\b`, 'i').test(line)) n += 100;
    // A file NAMED for the symbol is usually its home.
    if (new RegExp(`(?:^|[/\\\\])${esc}\\b`, 'i').test(path)) n += 40;
  }

  // An exported thing is the one other files use.
  if (/\bexport\b/.test(line)) n += 20;

  /**
   * ⚠️ TESTS ARE DEMOTED, NOT EXCLUDED. A test file mentions a symbol
   * constantly and defines it never, so it crowds out the definition — but it
   * is often exactly what someone asked for ("where is this tested"). A
   * penalty lets a strong signal still win; a filter would not.
   */
  if (/\.(test|spec)\.[a-z]+$/i.test(path)) n -= 30;

  // Shallow paths are source; deep ones are usually fixtures or vendored.
  n -= Math.min(10, (path.match(/[/\\]/g) || []).length);
  return n;
}

/**
 * Sort one page of matches by relevance, stably.
 *
 * ⚠️ Returns the SAME array contents — this may never add, drop or alter a
 * match. Anything else would make `total` and `nextOffset` lie.
 */
export function rankMatches(matches, pattern) {
  if (!Array.isArray(matches) || matches.length < 2) return matches;
  const ident = identifierFrom(pattern);
  return matches
    .map((m, i) => ({ m, i, s: scoreMatch(m, ident) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map((x) => x.m);
}
