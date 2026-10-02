/**
 * ── ⭐⭐⭐ RENAME WITHOUT A LANGUAGE SERVER, USING THE PROJECT'S OWN COMPILER ─
 *
 * `rename.mjs` drives tsserver, and tsserver is a CHILD PROCESS speaking a
 * framed protocol over stdio. That is the right backend when it can be spawned
 * and it is the ONLY backend, which is the gap this file closes:
 *
 *   · a runtime where `child_process.spawn` is unavailable or refused
 *     (a serverless function, a locked-down sandbox) has Node, has the
 *     `typescript` package sitting in `node_modules`, and cannot rename;
 *   · a spawn that fails for any reason at all — a full process table, a
 *     read-only `/tmp`, an exec bit — takes the whole verb down with it, and
 *     the model is told "no compiler here" about a project that has one.
 *
 * ⭐ AND THERE IS NO NEW ENGINE HERE. `tsserver` is a protocol wrapper around
 * `ts.LanguageService`, and `findRenameLocations` is the exact call its own
 * `rename` handler makes. This file skips the wrapper: one `import()` of the
 * project's own `typescript`, one language service, one call. **No new
 * dependency** — `acuvo-code`'s `package.json` still reads
 * `"dependencies": {}`; the compiler belongs to the project being edited, and
 * when the project has none this refuses and says so.
 *
 * ── ⚠️⚠️ THE RULE THIS FILE INHERITS AND MUST NOT BREAK ────────────────────
 *
 * `rename.mjs`'s precedence note is measured, not preferred:
 *
 *     tsserver.mjs, first request, cold  →  6 places in 3 files   ✅ COMPLETE
 *     typescript-language-server, cold   →  2 places in 1 file    ❌ INCOMPLETE
 *
 * *"An incomplete READ is a poor answer the model can notice and work around.
 * An incomplete WRITE is a repository that does not build."* So this backend is
 * the FALLBACK, not the default, and `test/ts-rename.test.mjs` drives it over
 * the same four-file fixture and asserts the COMPLETE answer — because a
 * fallback nobody measured is how the incomplete-write disaster arrives by a
 * different road.
 *
 * ⭐ IT HAS NO COLD START TO BE WRONG DURING. The LSP answer was incomplete
 * because the server was still indexing in the background; here the program is
 * constructed synchronously from a known file list before the first query, so
 * there is no "still warming up" state for an answer to come out of.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MAX_WALK_UP, TS_EXTENSIONS } from './tsserver.mjs';

/** Directories never worth indexing, and one of them is why this is bounded at all. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '.turbo', '.vercel', '.cache', 'vendor', '.venv', '__pycache__',
]);

/**
 * ⚠️ A CEILING ON THE WALK, NOT A PREFERENCE. Without one, running this at the
 * root of a monorepo indexes tens of thousands of files to rename a local
 * variable — and the failure is a timeout the model reads as "the tool is
 * broken". A project past this is exactly a project that HAS a tsconfig, which
 * is the path that never walks.
 */
export const MAX_INDEXED_FILES = 1_500;
export const MAX_WALK_DEPTH = 12;

/**
 * Where is the project's own `typescript` library? Walks up exactly as
 * `findTsserver` does, and looks for the SIBLING file in the same package — so
 * the two backends can never disagree about which compiler this project has.
 *
 * ⚠️ NEVER IMPORTS ANYTHING. This runs on the offer path; it is one `existsSync`
 * per level and nothing else.
 */
export function findTypescriptLib(root, { maxUp = MAX_WALK_UP } = {}) {
  if (typeof root !== 'string' || root === '') return null;
  let dir = resolve(root);
  for (let i = 0; i < maxUp; i += 1) {
    const candidate = join(dir, 'node_modules', 'typescript', 'lib', 'typescript.js');
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch { /* unreadable level */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function typescriptLibAvailable(root) {
  return findTypescriptLib(root) !== null;
}

function isSource(name) {
  const m = /\.[a-z]+$/i.exec(name);
  return m ? TS_EXTENSIONS.has(m[0].toLowerCase()) : false;
}

/**
 * Every source file under `root`, bounded.
 *
 * ⚠️ USED ONLY WHEN THERE IS NO tsconfig. A project with one gets its file list
 * from the compiler itself, which is the same list `tsc` would build — guessing
 * at it when the answer is written down would be the wrong kind of clever.
 */
export function indexProjectSources(root, { max = MAX_INDEXED_FILES, maxDepth = MAX_WALK_DEPTH } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= max || depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.') && e.name !== '.') {
        if (SKIP_DIRS.has(e.name)) continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && isSource(e.name)) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(resolve(root), 0);
  return out;
}

/** offset → the 1-based line/column both backends and `applyEdits` speak. */
function placeOf(starts, offset) {
  // starts is ascending; find the last start <= offset.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/**
 * ── ⚠️⚠️ `allowJs`, AND WHERE IT ACTUALLY BITES — MEASURED, NOT ASSUMED ─────
 *
 * The first version of this comment claimed `allowJs` "is the half that makes
 * this useful at all", and a mutation proved that false: turning it OFF here
 * changed nothing for a plain-JS project. **What admits a `.js` file on THIS
 * path is `allowNonTsExtensions` plus the file being listed as a root** — the
 * walk lists it, so the service parses it either way.
 *
 * ⚠️⚠️ IT BITES ON THE tsconfig PATH INSTEAD, AND THERE IT IS DANGEROUS.
 * Measured 2026-09-07 against `typescript@5.9`, `include: ['.']` over one `.ts`
 * and one `.js`:
 *
 *     allowJs: true   →  ['/a.ts', '/util.js']
 *     allowJs: false  →  ['/a.ts']
 *
 * So in a mixed project the `.js` file is not in the program AT ALL, and a
 * rename crossing into it comes back CONFIDENTLY INCOMPLETE — `ok: true`, real
 * locations, one file missing. That is the incomplete-WRITE failure
 * `rename.mjs`'s header exists to prevent, arriving through a config option.
 * `projectFilesFor` therefore forces `allowJs: true` over the project's own
 * setting, and `ts-rename.test.mjs` drives a mixed project to prove it.
 *
 * ⚠️ `checkJs` STAYS OFF, the same call `agentic-code-seams.ts` makes on the
 * other surface: this answers WHERE, never whether-it-compiles.
 */
function fallbackOptions(ts) {
  return {
    allowJs: true,
    checkJs: false,
    allowNonTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
  };
}

/**
 * The file list and compiler options for this project.
 *
 * ⭐ tsconfig FIRST, because it is the project's own answer to "which files are
 * mine" and it already handles `include`, `exclude`, `paths` and project
 * references. The walk exists for the projects that have no tsconfig at all —
 * which is every plain-JavaScript project, i.e. most of what a build produces.
 */
export function projectFilesFor(ts, root) {
  const configPath = ts.findConfigFile(resolve(root), ts.sys.fileExists, 'tsconfig.json');
  if (configPath) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!read.error) {
      /**
       * ── ⚠️⚠️ FORCED **BEFORE** THE PARSE, NOT AFTER, AND A TEST CAUGHT IT ───
       *
       * The first version set `allowJs` on the RESULT — `{ ...parsed.options,
       * allowJs: true }` — which changes the compiler options and not the FILE
       * LIST, because `parseJsonConfigFileContent` has already expanded
       * `include` by then and a project saying `allowJs: false` expands it
       * WITHOUT its `.js` files. So the option looked forced, the program was
       * still missing the file, and the rename came back `ok: true` with one
       * file unrenamed — the confident-partial-write this module exists to
       * prevent, produced by the line meant to prevent it.
       *
       * ⭐ It is set on the CONFIG so the glob expansion sees it. We are not
       * overriding what the project compiles; we are saying that for the
       * purpose of finding every use of a symbol, a `.js` file that imports it
       * counts — which is true whatever `tsc` is configured to emit.
       */
      const config = {
        ...read.config,
        compilerOptions: { ...(read.config?.compilerOptions ?? {}), allowJs: true },
      };
      const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath));
      if (parsed.fileNames?.length) {
        return {
          fileNames: parsed.fileNames.slice(0, MAX_INDEXED_FILES),
          options: { ...parsed.options, allowJs: true },
          via: 'tsconfig',
        };
      }
    }
  }
  return { fileNames: indexProjectSources(root), options: fallbackOptions(ts), via: 'walk' };
}

/**
 * ── ⭐ THE BACKEND ─────────────────────────────────────────────────────────
 *
 * Same signature and same return shape as `planViaTsserver`, so `renameSymbol`
 * applies the answer through one code path whichever backend produced it.
 *
 * @returns {Promise<{ok:true, via:string, displayName:string|null, files:{absolute:string, edits:object[]}[]} | {ok:false, error:string}>}
 */
export async function planViaTypeScriptLib(root, file, line, column, newName, opts = {}) {
  const libPath = opts.libPath ?? findTypescriptLib(root);
  if (!libPath) {
    return {
      ok: false,
      error: 'no `typescript` in this project, so nothing here knows which uses of that name are the same symbol '
        + '(npm i -D typescript). Do NOT fall back to edit_file for a rename: string replacement hits the same word '
        + 'in comments, strings and unrelated symbols.',
    };
  }

  let ts;
  try {
    const mod = await (opts.load ?? ((p) => import(pathToFileURL(p).href)))(libPath);
    ts = mod?.default ?? mod;
  } catch (e) {
    return { ok: false, error: `the project's typescript could not be loaded: ${e?.message ?? e}` };
  }
  if (typeof ts?.createLanguageService !== 'function') {
    return { ok: false, error: `the typescript at ${libPath} does not expose a language service` };
  }

  const absolute = resolve(root, String(file).split('/').join(sep));
  let text;
  try { text = readFileSync(absolute, 'utf8'); } catch (e) {
    return { ok: false, error: `could not read ${file}: ${e?.message ?? e}` };
  }

  const { fileNames, options } = projectFilesFor(ts, root);
  /**
   * ⚠️ THE TARGET FILE IS FORCED INTO THE LIST. A file excluded by tsconfig — or
   * newly written and not yet on disk when the config was read — would otherwise
   * produce "nothing to rename" about a file that plainly has the symbol in it,
   * which reads as a broken tool rather than a configuration.
   */
  const roots = fileNames.includes(absolute) ? fileNames : [absolute, ...fileNames];

  /**
   * ⚠️ SNAPSHOTS ARE READ FRESH FROM DISK, and the version is derived from the
   * CONTENT. A constant version is how a language service hands back a parse of
   * the file as it was two edits ago — a stale answer that looks exactly like a
   * correct one, and here it would be applied as a write.
   */
  const textOf = (f) => {
    if (f === absolute) return text;
    try { return readFileSync(f, 'utf8'); } catch { return undefined; }
  };
  const host = {
    getScriptFileNames: () => roots,
    getScriptVersion: (f) => {
      const t = textOf(f);
      return t === undefined ? '0' : `${t.length}:${t.length ? t.charCodeAt(0) : 0}:${t.length ? t.charCodeAt(t.length - 1) : 0}`;
    },
    getScriptSnapshot: (f) => {
      const t = textOf(f);
      return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
    },
    getCurrentDirectory: () => resolve(root),
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  let svc;
  try { svc = ts.createLanguageService(host, ts.createDocumentRegistry()); } catch (e) {
    return { ok: false, error: `the language service could not be built: ${e?.message ?? e}` };
  }

  const starts = lineStartsOf(text);
  if (!Number.isInteger(line) || line < 1 || line > starts.length) {
    return { ok: false, error: `${file} has ${starts.length} line${starts.length === 1 ? '' : 's'}; there is no line ${line}.` };
  }
  const position = starts[line - 1] + (Math.max(1, column) - 1);
  if (position > text.length) {
    return { ok: false, error: `${file}:${line}:${column} is past the end of the file.` };
  }

  let locations;
  try {
    /**
     * ⚠️⚠️ `findInStrings` AND `findInComments` ARE BOTH FALSE, and this is the
     * same decision `planViaTsserver` documents rather than a copied default.
     * `true` renames the word inside a comment and inside a SQL literal, which
     * is precisely the damage a semantic rename exists to avoid.
     *
     * ⭐ `providePrefixAndSuffixTextForRename: true` IS LOAD-BEARING. Without it
     * `{ foo }` renamed to `bar` becomes `{ bar }` — which COMPILES and is
     * wrong, because the property was `foo`. With it the location carries
     * `prefixText: 'foo: '` and the shorthand expands correctly. This is item 1
     * of `rename.mjs`'s header, reproduced here because the same trap has two
     * doors.
     */
    locations = svc.findRenameLocations(absolute, position, false, false, {
      providePrefixAndSuffixTextForRename: true,
    });
  } catch (e) {
    return { ok: false, error: `the compiler refused that rename: ${e?.message ?? e}` };
  }
  if (!locations || locations.length === 0) {
    return { ok: true, via: 'typescript', displayName: null, files: [] };
  }

  /** The symbol under the cursor, for the sentence the model reads back. */
  let displayName = null;
  try {
    const quick = svc.getQuickInfoAtPosition(absolute, position);
    displayName = quick?.displayParts?.map((p) => p.text).join('') ?? null;
    if (displayName) displayName = displayName.split('\n')[0].slice(0, 120);
  } catch { /* a label is never worth failing a rename over */ }

  const byFile = new Map();
  const textCache = new Map([[absolute, text]]);
  for (const loc of locations) {
    const f = loc.fileName;
    if (!textCache.has(f)) {
      const t = textOf(f);
      if (t === undefined) continue;
      textCache.set(f, t);
    }
    const s = lineStartsOf(textCache.get(f));
    const a = placeOf(s, loc.textSpan.start);
    const b = placeOf(s, loc.textSpan.start + loc.textSpan.length);
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push({
      line: a.line,
      column: a.column,
      endLine: b.line,
      endColumn: b.column,
      newText: `${loc.prefixText ?? ''}${newName}${loc.suffixText ?? ''}`,
    });
  }

  return {
    ok: true,
    via: 'typescript',
    displayName,
    files: [...byFile.entries()].map(([absolutePath, edits]) => ({ absolute: absolutePath, edits })),
  };
}
