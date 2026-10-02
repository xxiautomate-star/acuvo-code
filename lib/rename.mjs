/**
 * ── ⭐⭐ THE FIRST VERB THAT EDITS CODE INSTEAD OF TEXT ──────────────────────
 *
 * Everything else in this package changes a file by matching a STRING.
 * `edit_file` finds `oldString` and swaps it; `write_files` replaces whole
 * contents. Both are the right tools for prose and for a file the model just
 * wrote. Both are the WRONG tool for a rename, and the failure is not
 * theoretical:
 *
 *   · `id` renamed by string replacement hits `id` inside `validId`, `id:` in a
 *     JSON fixture, `id` in a comment and `"id"` in a SQL string.
 *   · a symbol imported under an alias — `import { id as key }` — is renamed at
 *     the declaration and missed at all 40 call sites, so the build breaks in a
 *     file the model never opened.
 *   · the reverse: two DIFFERENT symbols that share a name (a local `id` in one
 *     function, an exported `id` in another) both get changed, and only one of
 *     them should have.
 *
 * A compiler knows which `id` is which because it resolved them. This module
 * asks the compiler and applies its answer.
 *
 * ── ⭐ WHAT ALREADY EXISTED, AND WHY THIS IS NOT A NEW ENGINE ───────────────
 *
 * `lsp.mjs` (1,613 lines) and `tsserver.mjs` (423 lines) already drive a real
 * language server and already resolve symbols — `find_definition` and
 * `find_references` are LSP/tsserver-backed, not regex. What was missing was
 * never "can we see symbols". It was **can we transform them**, atomically,
 * across files.
 *
 * ⭐ AND THE TRANSFORM WAS ALREADY FREE. tsserver implements rename natively and
 * we simply never asked. No new dependency was added, no library was adopted,
 * and none needed to be — this file is two requests and the careful application
 * of the answer. `package.json` still reads `"dependencies": {}`.
 *
 * ── ⚠️⚠️ tsserver ONLY. THE LSP BACKEND WAS BUILT, DRIVEN AND WITHDRAWN. ────
 *
 * `textDocument/rename` was wired and works — when the server is warm. Measured
 * 2026-09-01 against a fresh `typescript-language-server` on a 4-file fixture
 * (`userId` exported from one file, used in three, tsc exit 0):
 *
 *     +1.5s  1 file    +3.5s  1 file    +5.6s  3 files  ← the truth
 *     +2.5s  1 file    +4.6s  1 file    +6.6s  3 files
 *
 * Applying the cold answer took the fixture from **tsc exit 0 to exit 2**, with
 * two files importing a symbol that no longer existed. ⭐ AND NO SAMPLING RULE
 * RESCUES IT: the wrong answer is STABLE for ~4.2 seconds, so "ask twice and
 * accept a matching answer" returns the wrong one twice — a settle window was
 * built on that idea and deleted when this measurement killed it. The plateau
 * grows with project size, so any fixed spacing is a guess a bigger repo beats.
 *
 * tsserver, on the same fixture, answered COMPLETELY on its first request from
 * cold — 6 places in 3 files, tsc exit 0 after. So this verb takes the backend
 * that was measured right rather than the one that is more general, and Python,
 * Rust and Go get an honest refusal instead of a coin flip on their repository.
 *
 * ── ⚠️⚠️ THE FIVE THINGS THAT MAKE THIS DANGEROUS, EACH HANDLED BELOW ───────
 *
 * 1. **`prefixText`/`suffixText` — the silent code-breaker.** tsserver returns
 *    these on shorthand property spans. Renaming `foo` → `bar` in `{ foo }`
 *    must produce `{ foo: bar }`, and tsserver says so by returning
 *    `prefixText: "foo: "` on that one span. An implementation that ignores
 *    them — which is the obvious one, because the field is easy to miss —
 *    produces `{ bar }`, which COMPILES and silently changes which property the
 *    object has. That is the worst class of bug this tool could ship, so the
 *    plan carries a complete `newText` per span and never assumes the new name.
 *
 * 2. **Offsets shift as you edit.** Applying spans front-to-back invalidates
 *    every later column on the same line. Applied strictly BACK TO FRONT by
 *    absolute offset, so no applied edit can move an unapplied one.
 *
 * 3. **CRLF.** Splitting on `\n`, editing, and re-joining rewrites every line
 *    ending in the file — a one-symbol rename arrives as a whole-file diff. So
 *    the text is never split: line starts are indexed, spans become absolute
 *    offsets, and the untouched bytes are copied verbatim.
 *
 * 4. **Partial application is worse here than anywhere else.** A half-applied
 *    rename leaves some call sites pointing at a symbol that no longer exists —
 *    a broken workspace, where a half-applied `write_files` leaves a
 *    *consistent* workspace with work outstanding. So every path is resolved
 *    for WRITE before a single byte is written, and any refusal aborts the
 *    whole call with nothing done. See `preflight`.
 *
 * 5. **The server will happily rename into `node_modules`.** A symbol declared
 *    in a dependency's `.d.ts` has its declaration there, and tsserver usually
 *    (not always) refuses with `canRename: false`. `resolveInWorkspace(…,
 *    'write')` refuses it always — `node_modules` is in `WRITE_FORBIDDEN_ROOTS`
 *    — and that refusal is reached in preflight, before anything lands.
 *
 * ── ⭐ IT IS THE SINGLE-FILE WRITE PATH, IN A LOOP ──────────────────────────
 *
 * Every byte goes through `executor.writeFile`, exactly as `write-many.mjs`
 * does and for the same reason: leases, the project owner's `acuvo-rules.json`,
 * `--dry-run`, the `.acuvo/` refusal, the mutation count and the checkpoint
 * journal that backs `undo` all work unchanged, because this is not a second
 * way to write a file. A rename that bypassed the executor would be invisible
 * to every one of them.
 */

import { resolveInWorkspace } from './workspace.mjs';
import { planViaTypeScriptLib, typescriptLibAvailable } from './ts-rename.mjs';
import { tsserverAvailable, startTsserver, handlesFile as tsHandlesFile } from './tsserver.mjs';
import { languageForFile } from './lsp.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { relative, sep } from 'node:path';

/**
 * ⚠️ A RENAME THAT TOUCHES MORE FILES THAN THIS IS A MIGRATION. Same ceiling
 * `write_files` uses, for the same reason: past this point somebody wants to
 * read the change in pieces, and a tool that silently rewrites 200 files on one
 * call is one nobody can review.
 */
export const MAX_RENAME_FILES = 60;

/** Total spans. A symbol with more uses than this is one to stage by hand. */
export const MAX_RENAME_EDITS = 800;

/** Locations echoed back to the model. The rest are counted, never listed. */
export const MAX_REPORTED_FILES = 40;

/**
 * ── ⚠️ WHAT COUNTS AS A NAME ────────────────────────────────────────────────
 *
 * Deliberately conservative and deliberately NOT language-aware. A permissive
 * check here does not buy capability, it buys a corrupted file: the server will
 * splice whatever string it is given into every use site without judging it, so
 * `new_name: "foo bar"` produces N syntax errors across N files and a green
 * tool result.
 *
 * ⚠️ THIS IS THE ASCII IDENTIFIER, NOT THE UNICODE ONE. JavaScript, Python,
 * Rust and Go all permit non-ASCII identifiers, so this refuses a few names
 * that are legal. That is the right side to err on: a refusal costs one round
 * and says exactly what it wants, and there is no ambiguity about what it did.
 */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * ⚠️ NOT AN EXHAUSTIVE KEYWORD LIST AND MUST NOT PRETEND TO BE. These are the
 * words that, used as a name, produce a syntax error in every language this
 * tool can reach — so refusing them is always right. A longer list would start
 * refusing names that are legal in the language actually being edited (`type`
 * is a keyword in Go and an ordinary identifier in JavaScript), which is the
 * failure mode of a blocklist that tries to be clever.
 */
const UNIVERSALLY_RESERVED = new Set([
  'if', 'else', 'for', 'while', 'return', 'function', 'class', 'const', 'var',
  'true', 'false', 'null', 'import', 'export', 'new', 'this', 'break', 'continue',
]);

/**
 * Is this a name a compiler will accept?
 *
 * @param {unknown} name
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkNewName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'rename_symbol needs "new_name": the identifier to rename to.' };
  }
  const n = name.trim();
  if (n !== name) {
    // ⚠️ Trimming silently would rename to something the caller did not type,
    // and the whitespace is usually a sign the caller meant a phrase.
    return { ok: false, error: `"${name}" has leading or trailing whitespace. An identifier has none — send ${JSON.stringify(n)} if that is what you meant.` };
  }
  if (!IDENTIFIER.test(n)) {
    return {
      ok: false,
      error: `"${n}" is not a usable identifier. It must start with a letter, _ or $ and contain only letters, digits, _ and $ — no spaces, dots, dashes or brackets. `
        + 'This tool renames ONE symbol; it does not rewrite an expression.',
    };
  }
  if (UNIVERSALLY_RESERVED.has(n)) {
    return { ok: false, error: `"${n}" is a reserved word in every language this tool edits — renaming to it would produce a syntax error at every use site.` };
  }
  return { ok: true };
}

/**
 * ── ⚠️ OFFSETS, WITHOUT DESTROYING THE FILE'S LINE ENDINGS ──────────────────
 *
 * Returns the absolute character offset each 1-based line starts at.
 *
 * ⭐ THE POINT IS WHAT IT DOES *NOT* DO. `text.split(/\r?\n/)` then `join('\n')`
 * is the natural implementation and it silently converts a CRLF file to LF —
 * so a one-word rename lands as a diff touching every line, `git blame` is
 * destroyed, and on a repo with `core.autocrlf` the change may not even appear.
 * Indexing leaves every byte outside the spans exactly as it was found.
 *
 * @param {string} text
 * @returns {number[]} `starts[n]` is the offset of 1-based line `n + 1`
 */
export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/**
 * A 1-based line/column position to an absolute offset.
 *
 * ⚠️ COLUMNS ARE UTF-16 CODE UNITS, which is what both servers speak — tsserver
 * natively, and LSP because `startLanguageServer` declares
 * `positionEncodings: ['utf-16']`. A JavaScript string is indexed in UTF-16
 * code units too, so this is a direct addition and NOT a coincidence worth
 * relying on silently: a server negotiated down to utf-8 would need conversion
 * here, and the declaration above is what stops that happening.
 *
 * @returns {number|null} null when the position is not in the file at all
 */
export function offsetAt(starts, textLength, line, column) {
  if (!Number.isInteger(line) || line < 1 || line > starts.length) return null;
  if (!Number.isInteger(column) || column < 1) return null;
  const off = starts[line - 1] + (column - 1);
  if (off > textLength) return null;
  return off;
}

/**
 * ── ⭐ APPLY THE SPANS. BACK TO FRONT, AND REFUSING TO GUESS. ───────────────
 *
 * @param {string} text
 * @param {{line:number,column:number,endLine:number,endColumn:number,newText:string}[]} edits
 * @returns {{ ok: true, text: string, applied: number } | { ok: false, error: string }}
 */
export function applyEdits(text, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: 'no edits to apply' };
  }
  const starts = lineStarts(text);
  const resolved = [];
  for (const e of edits) {
    const start = offsetAt(starts, text.length, e.line, e.column);
    const end = offsetAt(starts, text.length, e.endLine, e.endColumn);
    /**
     * ⚠️ A POSITION OFF THE END OF THE FILE MEANS THE SERVER IS ANSWERING ABOUT
     * A DIFFERENT VERSION OF IT — the file changed under us between the query
     * and the write. Clamping would apply the edit to whatever text happens to
     * be at that offset now, which is how a rename lands in the middle of an
     * unrelated identifier. Refuse the whole file instead.
     */
    if (start === null || end === null) {
      return { ok: false, error: `the language server reported an edit at ${e.line}:${e.column}, which is not a position in this file — it has changed since the rename was planned. Nothing was written; re-run the rename.` };
    }
    if (end < start) {
      return { ok: false, error: `the language server reported a backwards edit range (${e.line}:${e.column} to ${e.endLine}:${e.endColumn}). Nothing was written.` };
    }
    resolved.push({ start, end, newText: String(e.newText ?? '') });
  }

  resolved.sort((a, b) => b.start - a.start || b.end - a.end);

  /**
   * ⚠️ OVERLAP IS A CORRUPT PLAN, NOT A CONFLICT TO RESOLVE. Two spans covering
   * the same characters means one would be spliced into text the other already
   * replaced, and the result is a mangled identifier that may still parse.
   * Detectable only here — the server will not tell us — and it is exactly the
   * kind of thing that works on every file in testing and destroys one file in
   * production.
   */
  for (let i = 1; i < resolved.length; i += 1) {
    // sorted descending: resolved[i] ends at or before resolved[i-1] starts
    if (resolved[i].end > resolved[i - 1].start) {
      return { ok: false, error: 'the language server returned overlapping edit ranges for one file, which cannot be applied without guessing. Nothing was written.' };
    }
  }

  let out = text;
  for (const r of resolved) out = out.slice(0, r.start) + r.newText + out.slice(r.end);
  return { ok: true, text: out, applied: resolved.length };
}

/**
 * ── ⭐ THE tsserver BACKEND ─────────────────────────────────────────────────
 *
 * `rename` returns `{ info, locs }` where `info.canRename` is the veto and
 * `locs` is grouped by file. Positions are 1-based `line`/`offset`, which is
 * this module's own convention, so no conversion.
 *
 * ⚠️ `findInComments` AND `findInStrings` ARE BOTH FALSE, DELIBERATELY. They
 * are what make a semantic rename degrade into the string replacement this file
 * exists to replace: `true` renames the word inside a comment and inside a SQL
 * literal, which is precisely the class of damage `edit_file` already causes.
 * A comment that mentions the old name is for a human to fix.
 */
async function planViaTsserver(root, file, line, column, newName) {
  const s = startTsserver(root);
  if (s.ok === false) return s;
  try {
    const r = resolveInWorkspace(root, file, 'read');
    if (!r.ok) return { ok: false, error: r.reason };
    if (!existsSync(r.absolute)) return { ok: false, error: `${r.relative} does not exist` };
    let text;
    try { text = readFileSync(r.absolute, 'utf8'); } catch (e) { return { ok: false, error: `could not read ${r.relative}: ${e?.message ?? e}` }; }
    await s.request('open', { file: r.absolute, fileContent: text, scriptKindName: /\.tsx?$/.test(r.absolute) ? 'TS' : 'JS' });

    /**
     * ── ⚠️⚠️ THE ONE LINE THAT STOPS THIS TOOL SILENTLY BREAKING OBJECTS ─────
     *
     * MEASURED 2026-09-01 against tsserver from `typescript` 5.x, by dumping the
     * raw `locs` payload both ways:
     *
     *   without this configure →  { start, end }                    ← no prefix
     *   with it                →  { start, end, prefixText: "…: " } ← the fix
     *
     * `providePrefixAndSuffixTextForRename` is **OFF unless asked for**, and
     * nothing about the rename response says so — you get a perfectly ordinary
     * span list. So the default behaviour renames the shorthand property
     * `{ userId }` to `{ accountId }`, which changes the object's SHAPE rather
     * than the variable's name. Against a pinned interface that is a type error;
     * in plain JavaScript it is silent, shipped, wrong code.
     *
     * ⭐ THIS IS WHY THE PLAN CARRIES A COMPLETE `newText` PER SPAN. VS Code
     * sets the same preference; we were the only client that did not.
     *
     * ⚠️ It must be sent AFTER `open` and BEFORE `rename` — a `configure` that
     * arrives after the request it was meant to shape changes nothing and looks
     * exactly like one that worked.
     */
    await s.request('configure', { preferences: { providePrefixAndSuffixTextForRename: true } });

    const res = await s.request('rename', {
      file: r.absolute, line, offset: column, findInComments: false, findInStrings: false,
    });
    if (res?.success === false) return { ok: false, error: `tsserver: ${res.message ?? 'rename failed'}` };

    const info = res?.body?.info;
    /**
     * ⭐ THE SERVER'S OWN REFUSAL, PASSED THROUGH VERBATIM. tsserver says things
     * like "You cannot rename elements that are defined in a library" or "You
     * cannot rename this element" — sentences that name the real reason. A
     * generic "rename failed" here would send the model guessing at a cause the
     * server had already told us.
     */
    if (info && info.canRename === false) {
      return { ok: false, error: `cannot rename that symbol: ${info.localizedErrorMessage ?? 'the compiler declined'}${info.localizedErrorMessage ? '' : ' (no reason given)'}` };
    }

    const files = [];
    for (const group of res?.body?.locs ?? []) {
      const edits = [];
      for (const loc of group?.locs ?? []) {
        if (!Number.isInteger(loc?.start?.line) || !Number.isInteger(loc?.end?.line)) continue;
        edits.push({
          line: loc.start.line,
          column: loc.start.offset,
          endLine: loc.end.line,
          endColumn: loc.end.offset,
          /**
           * ⭐⭐ THE `prefixText`/`suffixText` CASE — SEE THE HEADER, ITEM 1.
           * `{ foo }` renamed to `bar` must become `{ foo: bar }`, and this
           * field is the only thing that says so. Dropping it produces code
           * that COMPILES and is wrong.
           */
          newText: `${loc.prefixText ?? ''}${newName}${loc.suffixText ?? ''}`,
        });
      }
      if (edits.length > 0) files.push({ absolute: group.file, edits });
    }
    return {
      ok: true,
      via: 'tsserver',
      displayName: info?.displayName ?? null,
      kind: info?.kind ?? null,
      files,
    };
  } finally {
    s.stop();
  }
}

/**
 * ── ⚠️⚠️⚠️ THE PRECEDENCE IS THE OPPOSITE OF THE READ TOOLS', AND IT IS
 *    MEASURED, NOT PREFERRED ──────────────────────────────────────────────────
 *
 * `tools.mjs` gives the four READ verbs to a real language server when one is
 * installed, and falls back to tsserver. That is right for a read. It is wrong
 * for this verb, and the difference was found by driving both:
 *
 *   FIXTURE: 4 files, `userId` exported from one and used in three, tsc-clean.
 *
 *   tsserver.mjs, first request, cold  →  6 places in 3 files   ✅ COMPLETE
 *   typescript-language-server, cold   →  2 places in 1 file    ❌ INCOMPLETE
 *   typescript-language-server, +5s    →  8 places in 3 files   ✅ COMPLETE
 *
 * Applying the cold LSP answer produced exactly the disaster this whole module
 * exists to prevent — `tsc` went from **exit 0 to exit 2**, with two files
 * importing a symbol that no longer existed:
 *
 *     src/direct.ts(1,10): error TS2305: Module '"./model"' has no exported member 'userId'.
 *     src/other.ts(1,10):  error TS2305: Module '"./model"' has no exported member 'userId'.
 *
 * ⭐ THE ASYMMETRY THAT JUSTIFIES DIFFERENT PRECEDENCE: an incomplete READ is a
 * poor answer the model can notice and work around. An incomplete WRITE is a
 * repository that does not build, and nothing downstream can tell it apart from
 * a complete one. So this verb takes the backend that was measured correct on a
 * COLD start, and the read verbs keep theirs.
 *
 * ⚠️⚠️ AND THE READ VERBS HAVE THE SAME BUG. `find_references` reported **2
 * references in 1 file** on that fixture when the truth was 6 in 3 — confidently,
 * not truncated, with no warning. That is a defect in shipped behaviour, it is
 * NOT fixed by this file, and it is written down here because it is the more
 * important of the two findings. See the report accompanying this change.
 */
/**
 * ── ⭐ EXTENDED 2026-09-07: A SECOND BACKEND, AND THE PRECEDENCE IS UNMOVED ──
 *
 * `tsserver` stays first because it is the one that was MEASURED correct on a
 * cold start — the paragraph above is not weakened by a byte. What changed is
 * what happens when it cannot be reached at all: it used to be "no compiler
 * here", about a project with `typescript` sitting in `node_modules`.
 *
 * ⭐ `typescript` IS THE SAME ENGINE WITH ONE FEWER LAYER. tsserver is a
 * protocol wrapper around `ts.LanguageService`, and `findRenameLocations` is
 * the call its own rename handler makes. So the fallback is not a second
 * opinion of unknown quality — it is the same answer without the child process,
 * which is why it is reachable where `spawn` is not: a serverless function, a
 * locked-down sandbox, a full process table. See `ts-rename.mjs`.
 */
export function renameBackendFor(root, file) {
  if (!tsHandlesFile(file)) return null;
  if (tsserverAvailable(root)) return 'tsserver';
  if (typescriptLibAvailable(root)) return 'typescript';
  return null;
}

/**
 * Is there a language server that could rename this file if we trusted it?
 *
 * ⭐ USED ONLY TO WRITE A BETTER REFUSAL. A Python file in a project with
 * `pyright` installed is not "unsupported"; it is deliberately declined, and the
 * two deserve different sentences — the first sends the model to install
 * something, the second tells it the truth.
 */
export function lspCouldButIsNotTrusted(file) {
  return Boolean(languageForFile(file)) && !tsHandlesFile(file);
}

/**
 * ── ⚠️⚠️ PREFLIGHT — RULE 4 FROM THE HEADER, AND THE REASON THIS FILE IS SAFE
 *
 * Resolve EVERY file the plan touches for WRITE before writing any of them, and
 * abort the whole call on the first refusal.
 *
 * ⭐ Why this is not the same judgement `write-many.mjs` made. That file
 * deliberately reports partial success rather than rolling back, and its
 * reasoning is right for it: a bulk write that lands 44 of 45 files leaves a
 * workspace that is CONSISTENT with work outstanding, and the model can finish
 * it. A rename that lands 44 of 45 leaves a workspace that does not build,
 * where the remaining work is invisible unless you already know what happened.
 * The failure is different, so the answer is different.
 *
 * ⚠️ AND IT IS NOT A TRANSACTION, WHICH THIS COMMENT WILL NOT PRETEND. Preflight
 * removes every refusal we can know about in advance — outside the workspace,
 * `node_modules`, a locked path, a file another terminal holds. It cannot
 * remove a disk that fills up on the 30th write. What covers that is the
 * checkpoint journal every `executor.writeFile` already records into, so `acuvo
 * undo` restores the partial rename; the result says so rather than implying an
 * atomicity nobody implemented.
 */
function preflight(executor, files) {
  const refusals = [];
  const resolved = [];
  for (const f of files) {
    const rel = relative(executor.root, f.absolute);
    const inside = rel !== '' && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel);
    if (!inside) {
      refusals.push(`${f.absolute} is outside the workspace`);
      continue;
    }
    const relPosix = rel.split(sep).join('/');
    const r = resolveInWorkspace(executor.root, relPosix, 'write');
    if (!r.ok) { refusals.push(`${relPosix}: ${r.reason}`); continue; }
    resolved.push({ path: relPosix, absolute: r.absolute, edits: f.edits });
  }
  return { refusals, resolved };
}

/**
 * ── ⭐⭐ THE APPLY HALF, EXTRACTED 2026-09-07 SO THERE IS ONE WRITER ─────────
 *
 * `ts-edit.mjs` adds three AST verbs — `insert_before_symbol`,
 * `insert_after_symbol`, `replace_function_body` — that produce the SAME plan
 * shape this file already applies. Giving them their own writer would give them
 * their own copy of the five things that make this dangerous half safe:
 * preflight-every-path-before-any-byte, the back-to-front splice, the CRLF
 * rule, the overlap refusal, and `executor.writeFile` (leases, `--dry-run`,
 * `acuvo-rules.json`, the mutation count, the `undo` journal).
 *
 * ⚠️ THAT COPY IS THE ONE THAT GOES STALE. So the body of `renameSymbol` below
 * is now this function, called from both — the same argument the file already
 * makes for going through `executor.writeFile` rather than writing directly.
 *
 * @param {{ root: string, writeFile: Function }} executor
 * @param {{ files: {absolute: string, edits: object[]}[], via?: string, displayName?: string|null }} plan
 * @param {{ kind: string, label?: string, newName?: string, emptyHint: string }} about
 */
export async function applyPlannedEdits(executor, plan, about) {
  if (plan.files.length === 0) {
    return { ok: false, error: about.emptyHint };
  }
  if (plan.files.length > MAX_RENAME_FILES) {
    return { ok: false, error: `that change touches ${plan.files.length} files, over the ${MAX_RENAME_FILES} limit — a change that large is one somebody will want to read in pieces. Nothing was written.` };
  }
  const totalEdits = plan.files.reduce((n, f) => n + f.edits.length, 0);
  if (totalEdits > MAX_RENAME_EDITS) {
    return { ok: false, error: `that change touches ${totalEdits} places, over the ${MAX_RENAME_EDITS} limit. Nothing was written.` };
  }

  const { refusals, resolved } = preflight(executor, plan.files);
  if (refusals.length > 0) {
    return {
      ok: false,
      error: `nothing was written — this change touches ${refusals.length} file${refusals.length === 1 ? '' : 's'} that cannot be written, and applying only the rest would leave the code half-changed and broken:\n  ${refusals.slice(0, 10).join('\n  ')}`,
      refused: refusals,
    };
  }

  // Compute every new file body BEFORE writing any of them, for the same reason.
  const staged = [];
  for (const f of resolved) {
    let text;
    try { text = readFileSync(f.absolute, 'utf8'); } catch (e) {
      return { ok: false, error: `nothing was written — could not read ${f.path}: ${e?.message ?? e}` };
    }
    const applied = applyEdits(text, f.edits);
    if (!applied.ok) return { ok: false, error: `nothing was written — ${f.path}: ${applied.error}` };
    staged.push({ path: f.path, content: applied.text, edits: applied.applied, unchanged: applied.text === text });
  }

  const written = [];
  const failed = [];
  for (const s of staged) {
    const r = executor.writeFile(s.path, s.content);
    if (r?.ok) written.push({ path: r.path ?? s.path, edits: s.edits, dryRun: r.dryRun === true });
    else failed.push({ path: s.path, error: r?.error ?? 'the write was refused' });
  }

  const dryRun = written.length > 0 && written.every((w) => w.dryRun);
  return {
    ok: failed.length === 0,
    kind: about.kind,
    via: plan.via,
    symbol: about.label ?? plan.displayName ?? null,
    newName: about.newName,
    dryRun,
    files: written.length,
    edits: written.reduce((n, w) => n + w.edits, 0),
    written,
    failed,
    error: failed.length > 0
      ? `the change was applied to ${written.length} file${written.length === 1 ? '' : 's'} and then FAILED on ${failed[0].path}: ${failed[0].error}. `
        + 'The workspace is now half-changed and may not build. Run `acuvo undo` to put it back, or finish the remaining files by hand.'
      : undefined,
  };
}

/**
 * ── ⭐ THE VERB ─────────────────────────────────────────────────────────────
 *
 * @param {{ root: string, writeFile: Function, dryRun?: boolean }} executor
 * @param {{ file?: string, line?: number, column?: number, new_name?: string }} args
 * @param {{ env?: object, lspAvailable?: Function|null }} [opts]
 */
export async function renameSymbol(executor, args = {}, opts = {}) {
  const { file, line } = args;
  const column = args.column ?? args.col ?? args.character ?? 1;
  const newName = args.new_name ?? args.newName ?? args.name;

  if (typeof file !== 'string' || file === '') {
    return { ok: false, error: 'rename_symbol needs "file": the workspace-relative path the symbol appears in, plus a 1-based "line" and "column" pointing at it, and "new_name".' };
  }
  if (!Number.isInteger(line) || line < 1) {
    return {
      ok: false,
      /**
       * ⭐ THE SAME LESSON `checkLspArgs` RECORDS: a position-based tool told
       * "line is required" invites the caller to invent a line number, and the
       * second call fails too. Name the tool that produces one.
       */
      error: 'rename_symbol is position-based: it needs a 1-based "line" (and "column") pointing at the symbol itself, exactly as read_file and search_text print them. It cannot look a symbol up by name — call search_text or list_symbols first to get the position.',
    };
  }
  const nameCheck = checkNewName(newName);
  if (!nameCheck.ok) return nameCheck;

  const backend = renameBackendFor(executor.root, file, opts);
  if (!backend) {
    return {
      ok: false,
      error: lspCouldButIsNotTrusted(file)
        ? `rename_symbol does not cover ${file}. It is TypeScript/JavaScript only: a semantic rename is driven by tsserver, and the general language-server path was `
          + 'measured returning an INCOMPLETE answer for the first ~5 seconds after startup, which applies a half-rename and breaks the build. '
          + 'Rename this by hand — use find_references first so you change every site, and do not trust a plain search.'
        : `no compiler here can rename in ${file}. rename_symbol needs \`typescript\` installed in the project (npm i -D typescript) — it is what knows which "${String(newName)}" is which. `
          + 'Do NOT fall back to edit_file for a rename: string replacement hits the same word in comments, strings and unrelated symbols.',
    };
  }

  /**
   * ── ⚠️⚠️ THE SPAWN FAILING IS NOT THE PROJECT HAVING NO COMPILER ──────────
   *
   * `startTsserver` can fail with `typescript` plainly installed — no
   * `child_process` on this runtime, a read-only temp, a full process table.
   * Before the fallback that took the whole verb down and told the model "no
   * compiler here", which sends it to `edit_file` and to exactly the
   * string-replacement damage this module exists to prevent.
   *
   * ⭐ THE FALLBACK RUNS ONLY WHEN THE PRIMARY COULD NOT START, never when it
   * started and answered. A backend that disagreed with tsserver would be a
   * second opinion applied as a WRITE, and the header above says why that is the
   * one place a second opinion is not welcome.
   */
  let plan = backend === 'tsserver'
    ? await planViaTsserver(executor.root, file, line, column, newName)
    : await planViaTypeScriptLib(executor.root, file, line, column, newName);
  if (!plan.ok && backend === 'tsserver' && typescriptLibAvailable(executor.root)) {
    const viaLib = await planViaTypeScriptLib(executor.root, file, line, column, newName);
    if (viaLib.ok) plan = viaLib;
  }
  if (!plan.ok) return plan;

  /**
   * ⭐ ONE WRITER, SHARED WITH `ts-edit.mjs` — see `applyPlannedEdits` above.
   * Everything from here down used to be written out here; the three AST verbs
   * produce the same plan shape, and a second copy of the preflight, the
   * splice, the CRLF rule and the executor call is the copy that goes stale.
   */
  return applyPlannedEdits(executor, plan, {
    kind: 'rename',
    label: plan.displayName ?? null,
    newName,
    emptyHint: `the language server found nothing to rename at ${file}:${line}:${column}. Check the position is on the symbol itself — the column is 1-based and counts characters, not tabs-as-spaces. list_symbols on that file returns every symbol with its line.`,
  });
}

/**
 * What the model reads back.
 *
 * ── ⭐ EXTENDED 2026-09-07 TO THE THREE AST EDITS, AND FOR THE REASON THIS
 *      FUNCTION EXISTS AT ALL ────────────────────────────────────────────────
 *
 * They report a WRITE through the same `applyPlannedEdits`, so they carry the
 * same two facts a locations shape cannot hold — how many places changed, and
 * **the dry-run flag**. `turn.mjs`'s note on this case is explicit about the
 * second: *"a model that reads a dry run as applied re-plans on a workspace
 * that never changed."* Letting them fall through to the JSON default would
 * bury exactly that line in a field name.
 *
 * ⚠️ THE VERB'S OWN NAME IS USED, never the word "rename", because
 * `replace_function_body` did not rename anything and a model told it did will
 * go looking for the new name it was never given.
 */
export function formatRename(result) {
  const verb = result?.kind && result.kind !== 'rename' ? result.kind : 'rename_symbol';
  if (!result) return 'rename_symbol returned nothing';
  if (result.ok !== true) return `${verb}: ${result.error ?? 'unknown failure'}`;
  const lines = [];
  /**
   * ⭐ `newName` EXISTS ONLY FOR A RENAME. For the AST edits the interesting
   * label is the SYMBOL that was edited, and an arrow reading `formatPrice →
   * undefined` is how a model concludes the call half-failed.
   */
  const what = result.newName
    ? (result.symbol ? `${result.symbol} → ${result.newName}` : `→ ${result.newName}`)
    : `\`${result.symbol ?? '?'}\``;
  const did = result.newName ? 'renamed' : `applied ${verb} to`;
  const would = result.newName
    ? 'WOULD rename (dry run — nothing was written)'
    : `WOULD apply ${verb} (dry run — nothing was written) to`;
  lines.push(
    `${result.dryRun ? would : did} ${what}: `
    + `${result.edits} place${result.edits === 1 ? '' : 's'} in ${result.files} file${result.files === 1 ? '' : 's'} (via ${result.via})`,
  );
  for (const w of result.written.slice(0, MAX_REPORTED_FILES)) {
    lines.push(`  ${w.path}  (${w.edits} place${w.edits === 1 ? '' : 's'})`);
  }
  if (result.written.length > MAX_REPORTED_FILES) {
    lines.push(`  … and ${result.written.length - MAX_REPORTED_FILES} more files`);
  }
  /**
   * ⭐ THE NEXT MOVE, BECAUSE A RENAME IS NOT SELF-VERIFYING. The server resolved
   * the symbol, but a rename can still break a file it did not consider — a
   * string key, a dynamic import, a template. Naming the check is what turns a
   * plausible green into a verified one.
   */
  if (!result.dryRun) lines.push('  Now run check_types on one of the changed files, or the project\'s build, to confirm.');
  return lines.join('\n');
}

export function renameToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'rename_symbol',
      description: [
        'Rename a symbol EVERYWHERE, using the project\'s compiler — every real use across every file,',
        'in one call, without touching the same word in comments, strings or unrelated symbols.',
        '⚠️ USE THIS INSTEAD OF edit_file OR write_files FOR ANY RENAME. String replacement cannot tell',
        '`id` the variable from `id` inside `validId`, and it misses call sites that import the symbol',
        'under a different name — so it silently breaks files you never opened.',
        'Point line and column at the symbol itself (1-based, exactly as read_file and search_text print them);',
        'it does not take a symbol name. Either every file changes or none does.',
        'Follow it with check_types to confirm the project still compiles.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Workspace-relative source file the symbol appears in.' },
          line: { type: 'number', description: '1-based line the symbol appears on.' },
          column: { type: 'number', description: '1-based column of the symbol (default 1).' },
          new_name: { type: 'string', description: 'The new identifier. One name — not an expression.' },
        },
        required: ['file', 'line', 'new_name'],
      },
    },
  };
}

export const RENAME_TOOL_NAME = 'rename_symbol';
