/**
 * ── lib/repo-index.mjs — THE INDEX THAT SURVIVES THE SESSION ────────────────
 *
 * ⚠️ WHAT THIS IS NOT. It is not a second repo map, and it does not render into
 * the prompt. `repo-map.mjs` answers one question — *"what does this repository
 * look like?"* — once per run, as a budgeted blob of PATHS, and it is very good
 * at it. This module answers a different one, on demand, in O(1):
 *
 *     "where is `rankFiles` DEFINED?"
 *
 * Today that question costs a `search_text` regex sweep over the whole tree,
 * which returns every MENTION — the definition, forty call sites, and the word
 * in three comments — with no way to tell them apart. The model then reads two
 * or three wrong files to find the right one. An index turns that into one
 * answer and zero wasted reads.
 *
 * ── ⭐ WHY A PERSISTENT INDEX AND NOT A PER-RUN ONE ─────────────────────────
 *
 * MEASURED on this machine, `buildRepoMap` with everything on:
 *
 *     acuvo-code (487 files) 544ms — readdir 2 · stat 11 · readFile 94 · CPU 437
 *     console  (2,781 files) 669ms — readdir 29 · stat 44 · readFile 104 · CPU 492
 *
 * ⭐ THE I/O IS NOT THE COST. Roughly 80% of both numbers is CPU spent running
 * the export regexes and the identifier scanner over 6–7 MB of source, and
 * **every byte of that work is thrown away when the process exits.** The next
 * invocation in the same repository — which is the normal shape of a CLI —
 * redoes all of it to reach the identical answer.
 *
 * So the unit of caching is the per-file extraction, keyed to the file's own
 * identity, and the win is proportional to how little changed. An agent that
 * edits one file should pay for one file.
 *
 * ⭐ MEASURED, ON THESE TWO REAL TREES, THROUGH `openIndex` (defaults):
 *
 *                          files   cold      warm     one file changed   on disk
 *     acuvo-code            410    276ms     11ms     ~98ms              63KB
 *     console             2,400  1,089ms     89ms     —                 322KB
 *
 *   **25x on this repo, 12x on console**, and the warm number is dominated by
 *   the `stat` sweep the walk cannot avoid — that is the floor, not a leftover.
 *
 *
 * ── HOW STALENESS IS DECIDED, AND WHAT THAT COSTS ───────────────────────────
 *
 *   1. PER FILE: `size` + `mtimeMs`, taken from the same `stat` the walk has to
 *      do anyway. This is what git, make, tsc and every incremental build system
 *      use, and it is ~0 extra work. ⚠️ ITS KNOWN HOLE, STATED RATHER THAN
 *      HIDDEN: an edit that changes neither size nor mtime is invisible to it.
 *      ⭐ MEASURED, AND NARROWER THAN THE FOLKLORE: an attempt to build that
 *      case on this machine failed. Writing the same byte count and then
 *      restoring the timestamp with `utimesSync` still moved `mtimeMs`, because
 *      `utimesSync` rounds to whole milliseconds while NTFS keeps 100ns ticks
 *      (1787580371823 against 1787580371823.4138). On any filesystem with
 *      sub-millisecond stamps the hole needs a same-tick, same-size write. It is
 *      real on coarse-timestamp filesystems, so (2) exists — but do not describe
 *      it as common.
 *   2. SO EVERY ENTRY ALSO CARRIES A CONTENT HASH, computed at extraction time
 *      from text that is already in memory — free on the write side. It is not
 *      checked on the fast path (checking it would mean reading every file,
 *      which is the cost we are removing). `verifyIndex` checks it, which turns
 *      "I think this is fresh" into something a test can prove.
 *   3. WHOLE-INDEX: the `format` number, and an `extractor` FINGERPRINT — an
 *      FNV-1a hash of the SOURCE TEXT of `extractExports` and
 *      `extractIdentifiers` themselves. ⭐ This is the invalidation that
 *      otherwise gets forgotten: change a regex in `repo-map.mjs` and every
 *      cached symbol list is silently wrong, forever, with no version bump to
 *      remind anyone. Hashing the functions makes that impossible — the
 *      algorithm invalidates its own cache.
 *   4. DELETION: a path in the index that the walk did not see is pruned.
 *
 * ── ⚠️⚠️ DETERMINISM, WHICH OUTRANKS THE FEATURE ────────────────────────────
 *
 * Production sits at 51.2% prompt-prefix cache and that is the single biggest
 * cost lever we have. Two rules protect it, and neither is optional:
 *
 *   · THE INDEX NEVER RENDERS INTO THE PROMPT. Not the file, not its stats, not
 *     a timing. What reaches the model is a tool RESULT — an answer to a
 *     question the model asked — and answers are sorted by code point with no
 *     clock, no duration and no run counter anywhere in them.
 *   · THE INDEX FILE ITSELF IS BYTE-IDENTICAL for the same tree: the string
 *     table is sorted and rebuilt from scratch on every save, rows are sorted by
 *     path, and every list inside a row is sorted. A cache whose bytes depend on
 *     the order files happened to be read in is a cache nobody can diff.
 *
 * ── ZERO DEPENDENCIES, AND IT COSTS NOTHING TO SAY SO ───────────────────────
 *
 * JSON plus `node:fs`. No sqlite, no lmdb, no embedding model, no tree-sitter.
 * The one thing a real dependency would buy is a PARSER instead of a regex, and
 * that is already the accepted trade in `repo-map.mjs` — the names are labelled
 * a guess, and this module repeats the label rather than laundering it.
 *
 * ── AND IT EXTENDS `repo-map.mjs` RATHER THAN COPYING IT ────────────────────
 *
 * The skip lists, the hidden-file allowlists, the `.gitignore` engine, both
 * extractors and the comparator are all IMPORTED. ⚠️ Two ideas about which
 * directories exist IS the bug — the same argument `repo-map.mjs` makes about
 * `search.mjs`. The two constants it does not export (`SYMBOL_EXT`,
 * `MAX_SYMBOL_FILE_BYTES`) are mirrored here and pinned by a drift guard in
 * `test/repo-index.test.mjs` that reads its source and compares.
 *
 * ⚠️ EVERY IMPL IS INJECTED, for the same reason as `repo-map.mjs`: no ambient
 * `fs` inside the logic, so determinism and staleness are provable with data
 * rather than asserted in a comment.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ACUVO_DIR, ensureAcuvoDirIgnored } from './acuvo-dir.mjs';
import { byCodePoint } from './prefix-order.mjs';
import { refusedCommitPath } from './secret-paths.mjs';
import {
  HIDDEN_DIRS_ALLOWED,
  HIDDEN_FILES_ALLOWED,
  SKIP_DIRS,
  extractExports,
  extractIdentifiers,
  makeIgnoreMatcher,
  parseGitignore,
} from './repo-map.mjs';

/**
 * ⚠️ MIRRORED FROM `repo-map.mjs`, WHICH DOES NOT EXPORT THEM, AND GUARDED BY A
 * TEST THAT READS ITS SOURCE. If the map decides a `.zig` file has symbols and
 * this list does not, the index answers "no definition" for a symbol the map
 * can see — the exact disagreement `repo-map.mjs`'s own `SKIP_DIRS` comment
 * exists to prevent. If you change one, change both; the test will tell you.
 */
export const INDEX_EXT = /\.(mjs|cjs|jsx?|tsx?|mts|cts|py|pyx|pxd|go|rs|c|h|cc|cpp|cxx|hpp|hh|ml|mli|java|cs|rb|php|sh|bash|zsh|kt|kts|swift|lua|vue|svelte|sql)$/i;
export const MAX_INDEX_FILE_BYTES = 768 * 1024;

/** A depth cap exists only so a symlink cycle cannot hang the process. */
const MAX_DEPTH = 24;

/** The walk is bounded by entries seen, not by depth — same inversion as the map. */
export const MAX_WALK_ENTRIES = 40_000;

/**
 * ⚠️ A CEILING ON WHAT IS INDEXED, NOT ON WHAT EXISTS. A monorepo with 40,000
 * source files would produce an index larger than the repository's own source,
 * and an incremental refresh that stats all of them. The cut is taken in CODE
 * POINT order so it is the same cut on every machine, and `filesSkippedForCap`
 * is reported so a caller can say "indexed 5,000 of 12,000" instead of quietly
 * answering "not found" for the other 7,000.
 */
export const MAX_INDEXED_FILES = 5_000;

/** Bump when the on-disk shape changes. A mismatch discards the file. */
export const INDEX_FORMAT = 1;

/** Where it lives. `.acuvo/` already ignores itself, so this never dirties a tree. */
export const INDEX_REL_PATH = `${ACUVO_DIR}/index/symbols.json`;

/** How many sibling symbols a definition row shows before it says "+N". */
const MAX_SIBLING_SYMBOLS = 6;

/** Suggestions when nothing matches exactly. */
const MAX_SUGGESTIONS = 8;

/** Hard cap on `limit`, so one call cannot flood a round with 4,000 paths. */
export const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// HASHING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FNV-1a, 32-bit, plus the length.
 *
 * ⚠️ NOT A SECURITY HASH AND NEVER USED AS ONE. It answers "is this the same
 * text as last time", where an adversary does not exist and a collision costs a
 * stale symbol list. Appending the length makes the commonest accidental
 * collision — two different files of different sizes — impossible rather than
 * merely unlikely, and `node:crypto` would be a heavier import for a question
 * this cheap.
 */
export function hashText(text) {
  const s = typeof text === 'string' ? text : '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= s.charCodeAt(i) >>> 8;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length.toString(36)}.${h.toString(36)}`;
}

/**
 * ── ⭐ THE CACHE INVALIDATION NOBODY REMEMBERS TO DO BY HAND ────────────────
 *
 * The extractors live in another module. Somebody widens a regex there — say
 * `export abstract class` — and every entry this index already holds is now a
 * wrong answer, with nothing anywhere to notice. A hand-maintained version
 * constant only works if the person editing `repo-map.mjs` knows this file
 * exists, and the whole history of this repository says they will not.
 *
 * ⭐ SO THE FINGERPRINT IS THE ALGORITHM'S OWN SOURCE TEXT.
 * `Function.prototype.toString` is specified to return it exactly, and
 * `scripts/bundle.mjs` renames nothing (per-module scope is the whole point of
 * its design), so a bundled CLI and a checkout produce the SAME fingerprint —
 * they will share an index rather than thrashing it.
 */
export function extractorFingerprint() {
  return hashText(`${extractExports.toString()}\u0000${extractIdentifiers.toString()}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE WALK
//
// ⚠️ IT IS THE MAP'S WALK, ASSEMBLED FROM THE MAP'S OWN EXPORTS. Only the
// selection differs: the map lists everything and this only opens files that
// could hold a symbol.
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
    writeFileImpl: (rel, text) => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp`;
      writeFileSync(tmp, text, 'utf8');
      // ⚠️ ATOMIC. A half-written index that still parses is the worst outcome:
      // it answers confidently and wrongly. rename() is atomic on every platform
      // we run on, so a crash mid-save leaves the OLD index, which is merely stale.
      try { renameSync(tmp, abs); } catch (err) {
        try { unlinkSync(tmp); } catch { /* the temp file is not worth a failure */ }
        throw err;
      }
    },
  };
}

/**
 * Every file in the tree that could hold a symbol.
 *
 * @returns {{ files: {path:string,size:number,mtimeMs:number}[], stats: object }}
 */
export function walkIndexable(root, impls = {}) {
  const io = { ...defaultImpls(root), ...(impls || {}) };
  const stats = {
    entriesSeen: 0,
    filesFound: 0,
    filesSkippedForCap: 0,
    filesTooLarge: 0,
    gitignored: 0,
    hidden: 0,
    withheld: 0,
    skippedDirs: 0,
    unreadableDirs: 0,
    walkCapped: false,
  };

  const readdir = (rel) => {
    try {
      const out = io.readdirImpl(rel);
      return Array.isArray(out) ? out : null;
    } catch { return null; }
  };

  let rootOk = false;
  try { rootOk = io.existsImpl('') !== false; } catch { rootOk = false; }
  if (!rootOk) return { files: [], stats };

  const found = [];
  const stack = [{ rel: '', depth: 0, ignore: [] }];

  while (stack.length > 0) {
    if (stats.entriesSeen >= MAX_WALK_ENTRIES) { stats.walkCapped = true; break; }
    const dir = stack.pop();
    const listed = readdir(dir.rel);
    if (listed === null) { stats.unreadableDirs += 1; continue; }

    const entries = [...listed]
      .filter((e) => e && typeof e.name === 'string')
      .sort((a, b) => byCodePoint(a.name, b.name));

    // A nested .gitignore governs its own subtree and nothing above it — the
    // map's rule, and the map's matcher.
    let ignoreChain = dir.ignore;
    if (entries.some((e) => e.name === '.gitignore' && e.type === 'file')) {
      let text = null;
      try { text = io.readFileImpl(dir.rel === '' ? '.gitignore' : `${dir.rel}/.gitignore`); } catch { text = null; }
      const rules = parseGitignore(text);
      if (rules.length > 0) ignoreChain = [...dir.ignore, { base: dir.rel, match: makeIgnoreMatcher(rules) }];
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
      if (stats.entriesSeen >= MAX_WALK_ENTRIES) { stats.walkCapped = true; break; }
      stats.entriesSeen += 1;
      const name = entry.name;
      const rel = dir.rel === '' ? name : `${dir.rel}/${name}`;

      if (entry.type === 'dir') {
        if (SKIP_DIRS.has(name)) { stats.skippedDirs += 1; continue; }
        // ⚠️ THE CREDENTIAL RULE IS CHECKED FIRST, AHEAD OF "hidden", WHICH IS A
        // DELIBERATE DEPARTURE FROM `repo-map.mjs`'s ORDER. Over there the two
        // are interchangeable because the outcome is the same — excluded either
        // way. Here the ORDER decides which counter moves, and a `withheld` that
        // never increments because `hidden` always got there first is a guard
        // nobody can prove still works. Same exclusions, provable reason.
        if (refusedCommitPath(`${rel}/`)) { stats.withheld += 1; continue; }
        if (name.startsWith('.') && !HIDDEN_DIRS_ALLOWED.has(name)) { stats.hidden += 1; continue; }
        if (ignored(rel, true)) { stats.gitignored += 1; continue; }
        if (dir.depth + 1 > MAX_DEPTH) continue;
        childDirs.push({ rel, depth: dir.depth + 1, ignore: ignoreChain });
        continue;
      }
      if (entry.type !== 'file') continue;
      if (!INDEX_EXT.test(name)) continue;
      // ⚠️ THE SAME WITHHOLDING LIST AS THE MAP AND THE COMMIT GUARD, AND FIRST
      // FOR THE REASON ABOVE. A file that must never leave this machine must not
      // have its symbol names cached either — `.env.mjs` is a real shape, and it
      // would otherwise be excluded as "hidden", which is a weaker promise.
      if (refusedCommitPath(rel)) { stats.withheld += 1; continue; }
      if (name.startsWith('.') && !HIDDEN_FILES_ALLOWED.has(name)) { stats.hidden += 1; continue; }
      if (ignored(rel, false)) { stats.gitignored += 1; continue; }

      let st = null;
      try { st = io.statImpl(rel); } catch { st = null; }
      const size = typeof st?.size === 'number' ? st.size : 0;
      if (size > MAX_INDEX_FILE_BYTES) { stats.filesTooLarge += 1; continue; }
      found.push({ path: rel, size, mtimeMs: typeof st?.mtimeMs === 'number' ? st.mtimeMs : 0 });
    }

    for (let i = childDirs.length - 1; i >= 0; i--) stack.push(childDirs[i]);
  }

  found.sort((a, b) => byCodePoint(a.path, b.path));
  stats.filesFound = found.length;
  if (found.length > MAX_INDEXED_FILES) {
    stats.filesSkippedForCap = found.length - MAX_INDEXED_FILES;
    found.length = MAX_INDEXED_FILES;
  }
  return { files: found, stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE INDEX ITSELF
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An empty, valid, in-memory index.
 *
 * ⚠️ `idents` IS PART OF THE HEADER, NOT A CALLER'S OPINION. An index written
 * without identifier bags cannot answer a caller who wants them, and the entries
 * look perfectly fresh by size and mtime — so a mode change has to be visible in
 * the FILE or it becomes a silently half-populated cache.
 */
export function emptyIndex(withIdentifiers = false) {
  return { format: INDEX_FORMAT, extractor: extractorFingerprint(), idents: withIdentifiers === true, entries: new Map() };
}

/**
 * ── SERIALISATION — INTERNED, SORTED, AND DIFFABLE ─────────────────────────
 *
 * ⭐ THE STRING TABLE IS NOT A MICRO-OPTIMISATION, IT IS THE DIFFERENCE BETWEEN
 * A CACHE AND A LIABILITY. Identifier bags repeat enormously across a codebase —
 * `readFileSync`, `path`, `result` appear in hundreds of files — so writing them
 * out per file multiplies the same bytes by the file count. Interning collapses
 * that to one copy plus an integer.
 *
 * ⚠️ THE TABLE IS REBUILT FROM SCRATCH ON EVERY SAVE, never appended to. An
 * append-only table accumulates the names of deleted files forever AND makes the
 * bytes depend on the history of the index rather than on the tree — which is
 * exactly the non-determinism this module exists to avoid.
 *
 * One row per line so a human (and `git diff`, if someone ever un-ignores it)
 * can read what changed.
 */
export function serialiseIndex(index) {
  const entries = [...index.entries.entries()].sort((a, b) => byCodePoint(a[0], b[0]));

  const seen = new Set();
  for (const [, e] of entries) {
    for (const s of e.symbols) seen.add(s);
    for (const s of e.idents) seen.add(s);
  }
  const strings = [...seen].sort(byCodePoint);
  const id = new Map();
  for (let i = 0; i < strings.length; i++) id.set(strings[i], i);

  const rows = entries.map(([path, e]) => JSON.stringify([
    path,
    e.size,
    e.mtimeMs,
    e.hash,
    e.symbols.map((s) => id.get(s)),
    e.idents.map((s) => id.get(s)),
  ]));

  return [
    '{',
    `"format":${JSON.stringify(index.format)},`,
    `"extractor":${JSON.stringify(index.extractor)},`,
    `"idents":${index.idents === false ? 'false' : 'true'},`,
    `"strings":${JSON.stringify(strings)},`,
    '"files":[',
    rows.join(',\n'),
    ']}',
    '',
  ].join('\n');
}

/**
 * Parse an index back.
 *
 * ⚠️ IT RETURNS `null` FOR ANYTHING IT DOES NOT FULLY UNDERSTAND rather than a
 * partially-populated index. A cache that half-loads answers half the questions
 * wrongly and the caller cannot tell which half; discarding it costs one rebuild.
 */
export function parseIndex(text) {
  if (typeof text !== 'string' || text === '') return null;
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (raw.format !== INDEX_FORMAT) return null;
  if (typeof raw.extractor !== 'string') return null;
  if (typeof raw.idents !== 'boolean') return null;
  if (!Array.isArray(raw.strings) || !Array.isArray(raw.files)) return null;

  const strings = raw.strings;
  const entries = new Map();
  const names = (list) => {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const i of list) {
      const s = strings[i];
      if (typeof s === 'string') out.push(s);
    }
    return out;
  };
  for (const row of raw.files) {
    if (!Array.isArray(row) || row.length < 6) return null;
    const [path, size, mtimeMs, hash] = row;
    if (typeof path !== 'string' || typeof size !== 'number' || typeof mtimeMs !== 'number') return null;
    if (typeof hash !== 'string') return null;
    entries.set(path, { size, mtimeMs, hash, symbols: names(row[4]), idents: names(row[5]) });
  }
  return { format: raw.format, extractor: raw.extractor, idents: raw.idents, entries };
}

/**
 * Read the index off disk.
 *
 * ⚠️ A FINGERPRINT MISMATCH IS A SILENT, DELIBERATE DISCARD — not an error and
 * not a warning. It means the extractors changed under a valid cache, which is
 * a normal consequence of shipping a new version, and the correct response is to
 * rebuild rather than to tell a user about our own internals.
 */
export function loadIndex(root, impls = {}) {
  const io = { ...defaultImpls(root), ...(impls || {}) };
  let text = null;
  try { text = io.readFileImpl(INDEX_REL_PATH); } catch { text = null; }
  const parsed = parseIndex(text);
  if (!parsed) return { index: emptyIndex(), loaded: false, reason: text ? 'unreadable' : 'absent' };
  if (parsed.extractor !== extractorFingerprint()) {
    return { index: emptyIndex(), loaded: false, reason: 'extractor-changed' };
  }
  return { index: parsed, loaded: true, reason: 'ok' };
}

/**
 * Write it back.
 *
 * ⚠️ IT NEVER THROWS. A read-only checkout, a full disk or a sandbox with no
 * write access must degrade to "no cache next time", never take down the answer
 * the model is waiting on. Losing a cache is a slower run; losing the run is a
 * failed task.
 */
export function saveIndex(root, index, impls = {}) {
  const io = { ...defaultImpls(root), ...(impls || {}) };
  try { ensureAcuvoDirIgnored(root); } catch { /* the litter guard is best-effort */ }
  try {
    io.writeFileImpl(INDEX_REL_PATH, serialiseIndex(index));
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * ── ⭐ THE INCREMENTAL STEP — THE WHOLE POINT OF THE MODULE ─────────────────
 *
 * Given the walk's file list, bring the index up to date and touch nothing else.
 * A hit costs one integer comparison. A miss costs one read plus two regex
 * passes — exactly what EVERY file used to cost, every run.
 *
 * ── ⚠️⚠️ `withIdentifiers` DEFAULTS TO **FALSE**, AND THE NUMBERS ARE WHY ────
 *
 * The identifier bag exists only to feed a symbol GRAPH (`rankFiles` in
 * `repo-map.mjs`). `find_symbol` never reads one, and `repo-map.mjs` is
 * DELIBERATELY not wired to this module — see the decision recorded above
 * `REPO_INDEX_TOOL_NAMES`, where candidate (a) was measured and rejected:
 * 0 of 143 symbol lists differ on this tree, so the graph it would feed is the
 * graph the map already builds. So today it feeds NOTHING, and that is a
 * decision rather than an omission. Measured, same trees, same machine:
 *
 *     acuvo-code (410 files)  idents on: 717ms cold · 30ms warm · 1,531KB
 *                             idents off: 276ms cold · 11ms warm ·    63KB
 *     console  (2,400 files)  idents on: 2,506ms cold · 152ms warm · 5,574KB
 *                             idents off: 1,089ms cold ·  89ms warm ·   322KB
 *
 * ⭐ 24x THE DISK AND 4x THE WARM COST, TO STORE SOMETHING NOTHING READS. That
 * is the "wire it or delete it" rule applied to a data field: the capability
 * stays (flip the flag the same day `repo-map.mjs` starts consuming it, and the
 * mode change re-indexes itself), but it is not switched on to be admired.
 */
export function refreshIndex(index, files, root, impls = {}, opts = {}) {
  const io = { ...defaultImpls(root), ...(impls || {}) };
  const withIdentifiers = opts.withIdentifiers === true;
  const report = { hits: 0, misses: 0, pruned: 0, unreadable: 0, bytesRead: 0, modeChanged: false };

  // ⚠️ A MODE CHANGE INVALIDATES EVERY ENTRY, and it has to, because the stale
  // ones are stale in a way `size`/`mtimeMs` cannot see: they are FRESH and
  // INCOMPLETE. Discarding is one rebuild; not discarding is a graph with holes
  // in it that nothing downstream can detect.
  if (index.idents !== withIdentifiers) {
    index.entries.clear();
    index.idents = withIdentifiers;
    report.modeChanged = true;
  }

  const wanted = new Set();
  for (const f of files) {
    wanted.add(f.path);
    const prev = index.entries.get(f.path);
    if (prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs) {
      report.hits += 1;
      continue;
    }
    let src = null;
    try { src = io.readFileImpl(f.path); } catch { src = null; }
    if (typeof src !== 'string') { report.unreadable += 1; index.entries.delete(f.path); continue; }
    report.misses += 1;
    report.bytesRead += src.length;
    index.entries.set(f.path, {
      size: f.size,
      mtimeMs: f.mtimeMs,
      hash: hashText(src),
      symbols: extractExports(f.path, src),
      idents: withIdentifiers ? [...extractIdentifiers(src)].sort(byCodePoint) : [],
    });
  }

  for (const path of [...index.entries.keys()]) {
    if (wanted.has(path)) continue;
    index.entries.delete(path);
    report.pruned += 1;
  }
  return report;
}

/**
 * Load → walk → refresh → save, in one call.
 *
 * ⚠️ `save: false` IS FOR TESTS AND FOR ANY CALLER THAT MUST NOT TOUCH THE
 * WORKSPACE. Everything else about the path is identical, so a test proves the
 * real code and not a parallel one.
 *
 * @returns {{ index: object, walk: object, refresh: object, saved: boolean, loaded: boolean, reason: string }}
 */
export function openIndex(root, impls = {}, opts = {}) {
  const loadedState = loadIndex(root, impls);
  const { files, stats } = walkIndexable(root, impls);
  const refresh = refreshIndex(loadedState.index, files, root, impls, opts);
  let saved = false;
  // ⭐ NO WRITE WHEN NOTHING MOVED. The commonest call is "nothing changed", and
  // rewriting a megabyte to say so would burn more time than the lookup saves —
  // and would touch the file's mtime for no reason a reader could act on.
  const dirty = refresh.misses > 0 || refresh.pruned > 0 || refresh.modeChanged || !loadedState.loaded;
  if (opts.save !== false && dirty) saved = saveIndex(root, loadedState.index, impls).ok;
  return { index: loadedState.index, walk: stats, refresh, saved, loaded: loadedState.loaded, reason: loadedState.reason };
}

/**
 * Re-read every indexed file and compare the stored content hash.
 *
 * ⭐ THIS IS THE HONEST ANSWER TO "HOW DO YOU KNOW mtime IS ENOUGH". It is the
 * expensive check the fast path deliberately skips, kept so the claim is
 * testable rather than merely asserted — and so a user who suspects a stale
 * answer has something to run.
 */
export function verifyIndex(index, root, impls = {}) {
  const io = { ...defaultImpls(root), ...(impls || {}) };
  const stale = [];
  let checked = 0;
  for (const [path, e] of [...index.entries.entries()].sort((a, b) => byCodePoint(a[0], b[0]))) {
    let src = null;
    try { src = io.readFileImpl(path); } catch { src = null; }
    if (typeof src !== 'string') { stale.push(path); continue; }
    checked += 1;
    if (hashText(src) !== e.hash) stale.push(path);
  }
  return { checked, stale, ok: stale.length === 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERIES
// ─────────────────────────────────────────────────────────────────────────────

/** Every path that DEFINES `name`, in code-point order. */
export function definitionsOf(index, name) {
  const want = String(name ?? '');
  if (want === '') return [];
  const out = [];
  for (const [path, e] of index.entries) if (e.symbols.includes(want)) out.push(path);
  return out.sort(byCodePoint);
}

/** What one file defines. `null` when the file is not indexed at all — which is */
/** NOT the same as "it defines nothing", and callers must not conflate them.   */
export function symbolsOf(index, path) {
  const e = index.entries.get(String(path ?? ''));
  return e ? [...e.symbols] : null;
}

/**
 * ── ⭐ "NOT FOUND" MUST NEVER BE THE WHOLE ANSWER ───────────────────────────
 *
 * Measured behaviour from our own transcripts: a search that reports "does not
 * exist" when it had merely stopped looking sends the model off to INVENT the
 * thing. So a miss returns the closest names that genuinely DO exist, and the
 * ranking is a fixed, deterministic ladder rather than a fuzzy score:
 *
 *   0 exact · 1 case-insensitive exact · 2 prefix · 3 substring
 *
 * ⚠️ Ties break on code point, never on iteration order, or two runs over the
 * same tree would disagree about which five of nine suggestions to show.
 */
export function searchSymbols(index, query, opts = {}) {
  const q = String(query ?? '');
  const limit = Math.max(1, Math.min(MAX_RESULTS, Number.isInteger(opts.limit) ? opts.limit : DEFAULT_RESULTS));
  if (q === '') return { exact: false, matches: [], suggestions: [], total: 0 };

  const lower = q.toLowerCase();
  const byName = new Map();
  for (const [path, e] of index.entries) {
    for (const s of e.symbols) {
      let tier = -1;
      if (s === q) tier = 0;
      else if (s.toLowerCase() === lower) tier = 1;
      else if (s.toLowerCase().startsWith(lower)) tier = 2;
      else if (s.toLowerCase().includes(lower)) tier = 3;
      if (tier < 0) continue;
      let row = byName.get(s);
      if (!row) { row = { name: s, tier, paths: [] }; byName.set(s, row); }
      row.paths.push(path);
    }
  }
  const rows = [...byName.values()].sort((a, b) => a.tier - b.tier || byCodePoint(a.name, b.name));
  for (const r of rows) r.paths.sort(byCodePoint);

  const exactRows = rows.filter((r) => r.tier === 0);
  if (exactRows.length > 0) {
    const paths = exactRows.flatMap((r) => r.paths).sort(byCodePoint);
    return {
      exact: true,
      matches: paths.slice(0, limit).map((path) => ({ path, siblings: siblingSymbols(index, path, q) })),
      suggestions: [],
      total: paths.length,
    };
  }
  return {
    exact: false,
    matches: [],
    suggestions: rows.slice(0, MAX_SUGGESTIONS).map((r) => ({ name: r.name, paths: r.paths.slice(0, 3) })),
    total: 0,
  };
}

/** The other names a defining file exports — cheap context, so the model does */
/** not have to open the file to learn what else is in it.                     */
function siblingSymbols(index, path, exclude) {
  const e = index.entries.get(path);
  if (!e) return [];
  const others = e.symbols.filter((s) => s !== exclude);
  const shown = others.slice(0, MAX_SIBLING_SYMBOLS);
  return others.length > shown.length ? [...shown, `+${others.length - shown.length}`] : shown;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TOOL — ⚠️ THE HALF THAT DECIDES WHETHER ANY OF THE ABOVE EXISTS
//
// ── ⭐⭐ WIRED 2026-08-25, AND WHICH SIDE IT WAS WIRED TO IS THE DECISION ────
//
// This module sat in `KNOWN_UNWIRED` with a stated blocker: WHERE it plugs in
// decides whether index output reaches the PROMPT, and anything that reaches
// the prompt must be byte-identical per tree or it breaks prefix caching —
// production measured at 51.2%, our single largest cost lever. Two candidates,
// resolved with numbers rather than taste. Both were measured on this repo.
//
// ── CANDIDATE (a): FEED `repo-map.mjs`'s RANKER ──────────────────────────────
//
// `buildRepoMap` opens up to `MAX_SYMBOL_READS` (800) files per run and calls
// `extractExports` + `extractIdentifiers` on each. That is exactly what this
// module caches, so on paper it is a free speed-up.
//
// ⚠️ MEASURED, ON THIS TREE, AND IT KILLS THE PREMISE:
//
//     repo-map full build                     547ms · 498 files · 7,768 tokens
//     index cold / warm (idents off)          298ms / 14ms ·    64KB on disk
//     index cold / warm (idents ON)           730ms / 32ms · 1,555KB on disk
//     symbol lists where map and index DIFFER   0 of 143
//
//   ⭐ ZERO OF 143. On this repository — 498 files, under the 800-read ceiling —
//   feeding the index changes NOT ONE BYTE of what the model sees. The whole
//   upside is ~530ms of wall clock. It buys no tokens, no coverage, no ranking.
//
//   ⭐ AND THE UPSIDE ONLY APPEARS WHERE THE RISK IS WORST. The ranking would
//   change only on a repo with MORE than 800 source files, because that is the
//   only place the index (5,000) sees files the map never opened. That is
//   precisely the repo whose map is largest, whose prompt head is most
//   expensive, and where a cache miss costs the most.
//
//   ⭐ AND THE RANKER NEEDS IDENTIFIERS: 64KB -> 1,555KB, a 24x on-disk cost, to
//   feed a graph that on this tree produces an identical answer.
//
// ⚠️⚠️ THE ARITHMETIC, STATED PLAINLY. The map is 27,185 bytes / 7,768 estimated
// tokens and it IS the prompt head. Wiring (a) puts a PERSISTENT, MUTABLE,
// ON-DISK artifact into the causal chain that produces those bytes. This module
// documents its own staleness hole (a same-tick, same-size write is invisible to
// `size`+`mtimeMs`), and it takes two caps the map does not take — 5,000 indexed
// files and 512KB per file. Any one of those disagreeing with a fresh extraction
// makes the map differ from the map a clean checkout would produce, silently,
// and every round re-pays ~7,800 tokens at cold-read prices. Trading a 530ms
// speed-up for a chance at that is a bet nobody should take.
//
// ── CANDIDATE (b): A LOOKUP VERB. ⭐ CHOSEN, AND IT IS NOT A CONSOLATION ──────
//
// A tool RESULT lands in the message tail, after every byte of the cached
// prefix. It is structurally incapable of invalidating a prefix — which is why
// this side needs no determinism argument at all, only a usefulness one.
//
// ⚠️⚠️ AND THE USEFULNESS IS NOT THEORETICAL. MEASURED ON THIS REPOSITORY,
// through the real `searchText`, 2026-08-25:
//
//     search_text "rankFiles"          total=0   scanned=4000   scanCapped=true
//     search_text "byCodePoint"        total=0   scanned=4000   scanCapped=true
//     search_text "openIndex"          total=0   scanned=4000   scanCapped=true
//
//   ⭐ ALL THREE ARE DEFINED IN `lib/`. The scan budget is spent inside
//   `bench/` — on `.pyc` files, among others — before the walk ever reaches
//   them. `search_text` is honest about it (`turn.mjs` prints "THE WALK WAS CUT
//   SHORT"), but honest-and-empty still costs the model a round and a narrowing
//   guess. This index answers all three in O(1), because `walkIndexable`
//   rejects a non-source extension before it ever spends a read.
//
//   That is the argument, and it is the one from `repo-map.mjs`'s own header:
//   an invisible file is not a neutral absence — it reads as "that does not
//   exist", and the model invents one.
//
// ── ⚠️⚠️ AND THE NAME HAD TO CHANGE, WHICH NOBODY HAD CHECKED ────────────────
//
// This module declared `find_definition`. ⭐ SO DOES `lib/lsp.mjs`, and it is
// pushed into `TOOL_SCHEMAS` unconditionally (`lspToolSchemas()`; only the
// OFFER is gated on a language server). Registering a second schema under that
// name would have put a DUPLICATE into the wire payload with a different
// parameter shape — `{file, line, column}` against `{name}` — and whichever the
// provider resolved to, the other would silently never be callable.
//
// ⚠️ THE COLLISION TEST IN `test/repo-index-on-this-repo.test.mjs` COULD NOT
// CATCH IT. It asserted `collisions.length <= 1` against the CURRENT registry,
// which is trivially true for a name declared once by somebody else — a check
// that cannot fail. It now asserts the name is disjoint from `LSP_TOOL_NAMES`
// and appears exactly once after wiring.
//
// ⭐ AND THE TWO ARE GENUINELY DIFFERENT VERBS, so renaming loses nothing:
// LSP's `find_definition` needs a file, a line and a column — you must already
// know where the symbol is USED. This one takes a bare NAME and needs no
// language server, no install, and no TypeScript in the user's project.
// ─────────────────────────────────────────────────────────────────────────────

export const REPO_INDEX_TOOL_NAMES = ['find_symbol'];

export function repoIndexToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'find_symbol',
        description: [
          'Find the file that DEFINES a symbol — a function, class, const, type, struct or method — anywhere in the workspace, by NAME alone.',
          'Use this FIRST whenever you need to open the file something is defined in. Do not guess a path, and do not grep for it.',
          '`search_text` returns every MENTION of a name — the definition plus every call site and every comment — and cannot tell them apart;',
          'worse, it stops after a bounded number of files, so on a large repository it answers "no matches" for symbols that certainly exist.',
          'This reads a whole-repository symbol index instead, so it answers definition sites only, in one call, with no scan limit to fall off.',
          'If nothing matches exactly you get the closest symbol names that DO exist, so an empty answer never means "invent it" — it means "you wanted one of these".',
          'The index is persistent under .acuvo/ and re-reads only the files that changed since the last call, so calling it repeatedly in one session is effectively free.',
          'Names come from a regex, not a parser: a missing name proves nothing. If you expected a definition and did not get one, fall back to search_text with a narrow glob.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The symbol name, e.g. "rankFiles". Exact first; a partial name still returns the closest real names.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_RESULTS,
              description: `How many definition sites to return. Defaults to ${DEFAULT_RESULTS}, capped at ${MAX_RESULTS}.`,
            },
          },
          required: ['name'],
        },
      },
    },
  ];
}

/**
 * Execute it.
 *
 * ⚠️ IT NEVER THROWS AND IT NEVER RETURNS A BARE FALSE. Every failure path
 * carries a sentence the model can act on — an in-memory executor is told to use
 * `search_text`, an empty index is told why it is empty — because "ok: false"
 * with no next move costs a whole round.
 *
 * ⚠️ AND NOTHING IN THE RESULT IS A CLOCK, A DURATION OR A RUN COUNTER. The
 * reply is a pure function of (tree, query): the same question over the same
 * tree returns the same bytes, which is what keeps a multi-round conversation
 * inside its cached prefix.
 *
 * ── ⚠️⚠️ THE DRY-RUN RULE LIVES HERE, NOT AT THE CALL SITE ──────────────────
 *
 * `openIndex` writes `.acuvo/index/symbols.json`. Under `--dry-run` the whole
 * promise is that nothing appears on disk, and a cache file is still a file.
 * Deriving `save` from `executor.dryRun` INSIDE this function is deliberate:
 * this package's own lesson is that a fix a second caller has to remember to
 * copy is a fix for one caller (`feedback_a_fix_that_cannot_be_imported`), and
 * `executeToolCall` is not the only door — the MCP server dispatches through
 * the same seam, and a library embedder can call this directly.
 *
 * ⚠️ AN EXPLICIT `opts.save` STILL WINS, because the tests need to run the
 * production path with the one byte that touches the workspace diverted.
 */
export function executeRepoIndexTool(name, args = {}, executor = {}, impls = {}, opts = {}) {
  if (name !== 'find_symbol') {
    return { ok: false, error: `unknown tool: ${name}` };
  }
  const symbol = typeof args?.name === 'string' ? args.name.trim() : '';
  if (symbol === '') {
    return { ok: false, error: 'pass the symbol name you are looking for, e.g. { "name": "rankFiles" }.' };
  }
  const root = executor?.root;
  if (!root || typeof root !== 'string') {
    return {
      ok: false,
      error: 'this workspace is held in memory rather than on disk, so there is nothing to index — use search_text instead.',
    };
  }

  const runOpts = Object.hasOwn(opts ?? {}, 'save')
    ? opts
    : { ...opts, save: executor?.dryRun !== true };

  let state;
  try {
    state = openIndex(root, impls, runOpts);
  } catch (err) {
    return {
      ok: false,
      error: `the index could not be built (${err instanceof Error ? err.message : String(err)}) — use search_text instead.`,
    };
  }

  const found = searchSymbols(state.index, symbol, { limit: args?.limit });
  const indexedFiles = state.index.entries.size;

  if (indexedFiles === 0) {
    return {
      ok: true,
      name: symbol,
      definitions: [],
      note: 'nothing in this workspace could be indexed — no source files with extractable symbols were found. Use find_files and search_text.',
    };
  }

  if (found.exact) {
    return {
      ok: true,
      name: symbol,
      definitions: found.matches.map((m) => (m.siblings.length > 0
        ? { path: m.path, alsoDefines: m.siblings }
        : { path: m.path })),
      ...(found.total > found.matches.length ? { truncated: true } : {}),
      total: found.total,
      indexedFiles,
    };
  }

  return {
    ok: true,
    name: symbol,
    definitions: [],
    ...(found.suggestions.length > 0
      ? {
        note: `no symbol is defined with exactly that name. These exist — did you mean one of them?`,
        didYouMean: found.suggestions,
      }
      : {
        note: 'no symbol with that name, or anything like it, is defined in this workspace. It may be defined in a dependency, or built at runtime — try search_text.',
      }),
    indexedFiles,
  };
}
