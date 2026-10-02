/**
 * ── lib/usages.mjs — find_usages: EVERY USE OF A NAME IN CODE, NO SERVER NEEDED ──
 *
 * ⚠️ THE GAP THIS CLOSES (C2, 2026-09-07). `find_symbol` answers "where is X
 * DEFINED" from the persistent index, in O(1). `find_references` answers "where
 * is X USED" — but only through a language server or `typescript`, so on the
 * project this builder ships most (vanilla HTML + JS, no tsconfig) and on any
 * Python/Go/Rust tree without a server installed, the model has `search_text`,
 * which returns the word in comments, strings and prose as if they were calls.
 * The model then reads three wrong files, which is the round-burning failure
 * `lsp.mjs`'s header describes.
 *
 * ── WHAT THIS IS, HONESTLY ──────────────────────────────────────────────────
 * Not a parser. Zero dependencies is the point of this package, so there is no
 * AST. It is the identifier sweep `search_text` cannot do: **comments and
 * string literals are MASKED before matching** (spans replaced by spaces, so
 * every line and column stays exact), the match is a whole identifier (never
 * `handleClickOnce` for `handleClick`), and files the index says DEFINE the
 * name are marked, so the definition is told from the forty call sites.
 *
 * ⚠️ WHAT IT CANNOT DO, AND SAYS SO: follow a renamed import (`import { a as
 * b }`), tell a method `.save()` on one class from another's, or see a name
 * built at runtime. A language server does; when one is present the model has
 * `find_references` beside this and the schema says which to prefer.
 *
 * ── THE SHAPE IS `LspLocations`, DELIBERATELY ───────────────────────────────
 * Same fields as `find_definition`/`find_references` (`kind`, `count`, `shown`,
 * `truncated`, `locations[{path,line,column,excerpt}]`) so a reader of the
 * transcript — human or model — sees one vocabulary for "places in code".
 */

import { walkIndexable, openIndex, definitionsOf, MAX_INDEX_FILE_BYTES } from './repo-index.mjs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/** Locations returned per call. Same ceiling as `search_text`'s matches. */
export const MAX_USAGE_LOCATIONS = 60;
/** Files opened per call — a sweep must end. */
export const MAX_USAGE_FILES = 4_000;
export const EXCERPT_MAX_CHARS = 160;

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

const HASH_COMMENT_EXT = new Set(['py', 'pyx', 'pxd', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'pl', 'r', 'ex', 'exs', 'nim']);
const HTML_EXT = new Set(['html', 'htm', 'vue', 'svelte', 'xml', 'svg']);
const CSS_EXT = new Set(['css', 'scss', 'less']);

function extOf(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path));
  return m ? m[1].toLowerCase() : '';
}

/** Replace a span with spaces, newlines kept, so offsets survive. */
function blank(s) {
  return s.replace(/[^\n]/g, ' ');
}

/**
 * Mask comments and string literals for the file's language family.
 *
 * ⚠️ A STATE MACHINE PER CHARACTER, NOT A REGEX PER KIND, because `"//"` inside
 * a string and `'` inside a comment are exactly the cases a regex gets wrong.
 * Template literals are masked whole — `${}` holes are lost, which under-reports
 * a use inside a template; that is the honest direction (a miss, never a lie).
 */
export function maskCodeComments(source, path = '') {
  const src = String(source ?? '');
  const ext = extOf(path);
  if (HTML_EXT.has(ext)) return maskHtml(src);
  if (CSS_EXT.has(ext)) return maskGeneric(src, { block: true, line: false, hash: false });
  if (HASH_COMMENT_EXT.has(ext)) return maskGeneric(src, { block: false, line: false, hash: true, triple: ext === 'py' || ext === 'pyx' || ext === 'pxd' });
  return maskGeneric(src, { block: true, line: true, hash: false });
}

function maskGeneric(src, { block, line, hash, triple = false }) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (block && c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    if (line && c === '/' && c2 === '/') {
      let end = src.indexOf('\n', i); if (end === -1) end = n;
      out += blank(src.slice(i, end)); i = end; continue;
    }
    if (hash && c === '#') {
      let end = src.indexOf('\n', i); if (end === -1) end = n;
      out += blank(src.slice(i, end)); i = end; continue;
    }
    if (triple && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      const q = src.slice(i, i + 3);
      const end = src.indexOf(q, i + 3);
      const stop = end === -1 ? n : end + 3;
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j += 1; break; }
        // an unterminated single-line string ends at the line, so one stray
        // quote in prose cannot swallow the rest of the file
        if (c !== '`' && src[j] === '\n') break;
        j += 1;
      }
      out += blank(src.slice(i, j)); i = j; continue;
    }
    out += c; i += 1;
  }
  return out;
}

function maskHtml(src) {
  // comments, then string attributes inside tags are left alone (an id or a
  // handler name in an attribute IS a use); script/style bodies get the JS/CSS rules.
  let out = src.replace(/<!--[\s\S]*?-->/g, (m) => blank(m));
  out = out.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_m, a, body, z) => a + maskGeneric(body, { block: true, line: true, hash: false }) + z);
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, a, body, z) => a + maskGeneric(body, { block: true, line: false, hash: false }) + z);
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sweep the tree for whole-identifier uses of `name` in code.
 *
 * `impls` lets tests hand a fake file system; production reads the real tree
 * through the same walk the index uses (gitignore, skip dirs, credential-shaped
 * files withheld, size caps).
 */
export function findUsages(root, name, { impls = {}, limit = MAX_USAGE_LOCATIONS, index = null, save = true } = {}) {
  const symbol = String(name ?? '').trim();
  if (!IDENT_RE.test(symbol)) {
    return { ok: false, error: `"${symbol}" is not an identifier — find_usages takes one name (letters, digits, _ or $), e.g. "handleClick". For text or a pattern use search_text.` };
  }
  const max = Math.max(1, Math.min(Number(limit) || MAX_USAGE_LOCATIONS, MAX_USAGE_LOCATIONS));
  const walk = walkIndexable(root, impls);
  const readFile = impls.readFileImpl ?? ((rel) => { try { return readFileSync(join(root, rel), 'utf8'); } catch { return null; } });
  let idx = index;
  // ⚠️ `save:false` under --dry-run — the same rule `executeRepoIndexTool`
  // applies, so a lookup never leaves `.acuvo/index/symbols.json` in git status.
  if (!idx) { try { idx = openIndex(root, impls, { save }).index; } catch { idx = null; } }
  const defining = new Set(idx ? definitionsOf(idx, symbol) : []);
  const rx = new RegExp(`(?<![\\w$])${escapeRe(symbol)}(?![\\w$])`, 'g');

  const locations = [];
  let count = 0;
  let filesScanned = 0;
  let filesWithUses = 0;
  for (const entry of walk.files) {
    // ⚠️ the walk yields `{ path, size, mtimeMs }`, not strings — a bare
    // `readFile(entry)` opened nothing and reported 0 uses with a straight face.
    const rel = typeof entry === 'string' ? entry : entry?.path;
    if (typeof rel !== 'string') continue;
    if (filesScanned >= MAX_USAGE_FILES) break;
    const src = readFile(rel);
    if (typeof src !== 'string' || src.length > MAX_INDEX_FILE_BYTES) continue;
    filesScanned += 1;
    if (!src.includes(symbol)) continue;
    const masked = maskCodeComments(src, rel);
    const lines = src.split('\n');
    let lineStarts = null;
    let any = false;
    let m;
    rx.lastIndex = 0;
    while ((m = rx.exec(masked)) !== null) {
      any = true;
      count += 1;
      if (locations.length >= max) continue;
      if (!lineStarts) {
        lineStarts = [0];
        for (let k = 0; k < masked.length; k++) if (masked[k] === '\n') lineStarts.push(k + 1);
      }
      // binary search the line
      let lo = 0; let hi = lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= m.index) lo = mid; else hi = mid - 1; }
      const line = lo + 1;
      const column = m.index - lineStarts[lo] + 1;
      const raw = (lines[lo] ?? '').replace(/\r$/, '').trim();
      locations.push({
        path: rel, line, column,
        excerpt: raw.length > EXCERPT_MAX_CHARS ? `${raw.slice(0, EXCERPT_MAX_CHARS - 1)}…` : raw,
        ...(defining.has(rel) ? { defines: true } : {}),
      });
    }
    if (any) filesWithUses += 1;
  }
  const truncated = count > locations.length;
  const notes = [];
  if (truncated) notes.push(`${count} uses; showing the first ${locations.length} — narrow with search_text and a glob, or read the files listed`);
  if (defining.size === 0 && count > 0) notes.push('no file in the index DEFINES this name — it may come from a package, a global, or a file the index skips');
  if (walk.stats?.withheld) notes.push(`${walk.stats.withheld} credential-shaped file(s) were not opened`);
  notes.push('comments and strings were masked; source files only (an inline handler in HTML is not swept — search_text for that); a renamed import or a runtime-built name is not followed — use find_references when a language server is present');
  return {
    ok: true, kind: 'usages', symbol,
    count, shown: locations.length, truncated,
    filesScanned, filesWithUses,
    definingFiles: [...defining],
    locations,
    note: notes.join('. '),
  };
}

export const USAGES_TOOL_NAMES = ['find_usages'];

export function usagesToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'find_usages',
        description: [
          'Every use of a NAME in code across the project — comments and string literals masked, whole identifiers only,',
          'files that define the name marked. Works with no language server (a plain HTML/JS project, Python without',
          'pyright). Run it before renaming or deleting anything shared. It does not follow renamed imports;',
          'when find_references is offered, prefer that for TypeScript.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The identifier, e.g. "handleClick". One name, not a pattern.' },
            limit: { type: 'number', description: `How many locations to return. Defaults to ${MAX_USAGE_LOCATIONS}, which is the cap.` },
          },
          required: ['name'],
        },
      },
    },
  ];
}

export function executeUsagesTool(name, args = {}, { executor } = {}) {
  if (name !== 'find_usages') return { ok: false, error: `unknown usages tool "${name}"` };
  const root = executor?.root;
  if (typeof root !== 'string' || root === '') return { ok: false, error: 'find_usages needs a workspace on disk to sweep' };
  return findUsages(root, args.name, { limit: args.limit, save: executor?.dryRun !== true });
}

export function formatUsagesForModel(result) {
  if (!result?.ok) return `find_usages: ${result?.error ?? 'unknown failure'}`;
  const lines = [`${result.symbol}: ${result.count} use${result.count === 1 ? '' : 's'} in ${result.filesWithUses} file${result.filesWithUses === 1 ? '' : 's'} (${result.filesScanned} scanned)`];
  if (result.definingFiles?.length) lines.push(`  defined in: ${result.definingFiles.join(', ')}`);
  for (const l of result.locations) lines.push(`  ${l.path}:${l.line}:${l.column}${l.defines ? '  [defines]' : ''}  ${l.excerpt}`);
  if (result.note) lines.push(`  ⚠️ ${result.note}`);
  return lines.join('\n');
}
