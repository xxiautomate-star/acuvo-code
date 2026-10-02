/**
 * ── ⭐⭐⭐ THREE EDITS THAT NAME A SYMBOL INSTEAD OF MATCHING A LINE ──────────
 *
 * `edit_file` finds `oldString` and swaps it, and it is the right tool for
 * prose and for a file the model just wrote. It is the wrong tool for
 * "add a helper above `formatPrice`" or "replace the body of `handleSubmit`",
 * and the way it is wrong is the same way a string rename is wrong:
 *
 *   · `}` appears on 47% of the lines of a typical source file, so a body
 *     replacement anchored on braces matches the wrong function;
 *   · `export function x` is unique until somebody adds an overload, a
 *     re-export or a `.d.ts` line beside it, and then it silently is not;
 *   · to insert ABOVE a function the model has to reproduce its first line
 *     byte-for-byte — including the JSDoc it forgot was there — and the
 *     `exactly once` matcher refuses, costing a round to discover.
 *
 * ⭐ A COMPILER KNOWS WHERE `formatPrice` IS. This module asks the project's
 * OWN `typescript` for the node, converts its span to the same
 * `{line,column,endLine,endColumn,newText}` shape `rename.mjs` already applies,
 * and hands it to the same `applyEdits` — back-to-front, CRLF-safe,
 * overlap-refusing. **No new dependency**; `acuvo-code`'s `package.json` still
 * reads `"dependencies": {}`.
 *
 * ── ⚠️ ONE FILE, NO PROGRAM, AND THAT IS DELIBERATE ────────────────────────
 *
 * `ts-rename.mjs` builds a LanguageService because a rename crosses files.
 * These three do not: every one of them edits inside the file it is given, so a
 * single `createSourceFile` parse answers them — no tsconfig, no file walk, no
 * document registry, and nothing to be stale. Reaching for the program here
 * would buy nothing and cost the walk.
 *
 * ⚠️⚠️ AMBIGUITY IS REFUSED, NEVER RESOLVED BY GUESSING. Two declarations of a
 * name in one file is the case where picking either is a coin flip that edits
 * real code, so the refusal NAMES both lines and the model chooses.
 */
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { findTypescriptLib } from './ts-rename.mjs';
import { applyPlannedEdits } from './rename.mjs';
import { handlesFile as tsHandlesFile } from './tsserver.mjs';

/** A body longer than this is a new file, not an edit. Same spirit as MAX_RENAME_EDITS. */
export const MAX_INSERT_CHARS = 20_000;

/** offset → the 1-based line/column `applyEdits` speaks. */
function placeOf(starts, offset) {
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

async function loadTs(root, opts = {}) {
  const libPath = opts.libPath ?? findTypescriptLib(root);
  if (!libPath) {
    return {
      ok: false,
      error: 'no `typescript` in this project, so nothing here can find a symbol by name (npm i -D typescript). '
        + 'Do NOT fall back to edit_file for this: matching a brace or a signature line hits the wrong function '
        + 'the moment the file has two of them.',
    };
  }
  try {
    const mod = await (opts.load ?? ((p) => import(pathToFileURL(p).href)))(libPath);
    const ts = mod?.default ?? mod;
    if (typeof ts?.createSourceFile !== 'function') {
      return { ok: false, error: `the typescript at ${libPath} does not expose a parser` };
    }
    return { ok: true, ts };
  } catch (e) {
    return { ok: false, error: `the project's typescript could not be loaded: ${e?.message ?? e}` };
  }
}

/**
 * ── ⚠️⚠️ WHAT COUNTS AS "THE DECLARATION OF `x`" ───────────────────────────
 *
 * Only TOP-LEVEL declarations, and only the four shapes a person means when
 * they say "the function": a `function` statement, a `class`, and a `const`/
 * `let` initialised to a function or an arrow. A local inside another function
 * is deliberately NOT matched — "insert before `helper`" where `helper` is a
 * closure three levels down is a request whose answer nobody can predict from
 * the outside, and editing the wrong one is silent.
 *
 * ⭐ EXPORT MODIFIERS ARE PART OF THE NODE. `export function x` starts at
 * `export`, so an insertion before it lands above the export and not between
 * the keyword and the declaration.
 */
function topLevelDeclarations(ts, sf, name) {
  const out = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) {
      if (st.name?.text === name) out.push({ node: st, decl: st, kind: ts.isClassDeclaration(st) ? 'class' : 'function' });
      continue;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name) continue;
        const init = d.initializer;
        const fnLike = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        /**
         * ⚠️ THE STATEMENT IS THE ANCHOR, THE DECLARATOR IS THE BODY OWNER, and
         * conflating them breaks both verbs. An insertion goes above
         * `export const x = …` (the statement); a body replacement goes inside
         * the arrow (the declarator's initializer). One node cannot be both.
         */
        out.push({ node: st, decl: d, kind: fnLike ? 'function' : 'value' });
      }
      continue;
    }
    /**
     * ⭐ `export default function x` and `export { x }` are deliberately absent.
     * The first is reachable as a function declaration when it is named; the
     * second is a re-export whose declaration is elsewhere, and inserting
     * "before" a re-export is not what anybody asking for it means.
     */
  }
  return out;
}

function describeCandidates(starts, cands) {
  return cands.map((c) => {
    const p = placeOf(starts, c.node.getStart());
    return `line ${p.line}`;
  }).join(', ');
}

/** Every top-level name in the file, for a refusal that helps rather than shrugs. */
function topLevelNames(ts, sf) {
  const names = [];
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names.push(st.name.text);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    }
  }
  return names;
}

/**
 * Resolve `(root, file, symbol)` to exactly one top-level declaration, or a
 * refusal that says what it found instead.
 */
async function locate(root, file, symbol, opts = {}) {
  if (typeof file !== 'string' || file === '') {
    return { ok: false, error: 'this needs "file": the workspace-relative source file the symbol is declared in.' };
  }
  if (typeof symbol !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) {
    return { ok: false, error: 'this needs "symbol": the NAME of a top-level function, class or const — not a line, not an expression.' };
  }
  if (!tsHandlesFile(file)) {
    return { ok: false, error: `${file} is not TypeScript or JavaScript, so there is no syntax tree to edit. Use edit_file.` };
  }

  const loaded = await loadTs(root, opts);
  if (!loaded.ok) return loaded;
  const { ts } = loaded;

  const absolute = resolve(root, String(file).split('/').join(sep));
  let text;
  try { text = readFileSync(absolute, 'utf8'); } catch (e) {
    return { ok: false, error: `could not read ${file}: ${e?.message ?? e}` };
  }

  const sf = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const starts = lineStartsOf(text);
  const cands = topLevelDeclarations(ts, sf, symbol);

  if (cands.length === 0) {
    const names = [...new Set(topLevelNames(ts, sf))];
    return {
      ok: false,
      error: `no top-level \`${symbol}\` is declared in ${file}.`
        + (names.length
          ? ` This file declares: ${names.slice(0, 20).join(', ')}${names.length > 20 ? `, and ${names.length - 20} more` : ''}.`
          : ' This file declares nothing at the top level.')
        + ' ⚠️ A symbol declared INSIDE another function is deliberately not matched — say which top-level one you mean.',
    };
  }
  if (cands.length > 1) {
    return {
      ok: false,
      error: `${file} declares \`${symbol}\` ${cands.length} times (${describeCandidates(starts, cands)}), so editing "the" one `
        + 'would be a coin flip on real code. Rename one of them first, or use edit_file with enough surrounding text to be unambiguous.',
    };
  }
  return { ok: true, ts, sf, text, starts, absolute, hit: cands[0] };
}

function checkText(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    return `this needs "${what}": the code to put there.`;
  }
  if (value.length > MAX_INSERT_CHARS) {
    return `that is ${value.length} characters, over the ${MAX_INSERT_CHARS} limit — at that size write the file instead.`;
  }
  return null;
}

/**
 * ── ⚠️⚠️ THE DOC COMMENT IS PART OF WHAT YOU ARE INSERTING BEFORE ───────────
 *
 * `node.getStart()` skips leading trivia, so inserting there lands BETWEEN a
 * function's JSDoc and the function — which reads as though the doc belongs to
 * the new code and leaves the old function undocumented. `getFullStart()` is
 * the other extreme: it includes every blank line back to the previous
 * statement, so an insertion there attaches to the wrong end of the gap.
 *
 * ⭐ THE ANSWER IS THE START OF THE FIRST LEADING COMMENT, when there is one,
 * and the node start otherwise. `getLeadingCommentRanges` is the compiler's own
 * answer to "what trivia belongs to this node", so this is read from it rather
 * than guessed with a regex.
 */
function insertionStart(ts, text, node) {
  const full = node.getFullStart();
  const ranges = ts.getLeadingCommentRanges(text, full) ?? [];
  return ranges.length > 0 ? ranges[0].pos : node.getStart();
}

/** `{ok:true, files:[{absolute, edits}]}` — the shape `renameSymbol` applies. */
function oneEdit(absolute, starts, start, end, newText) {
  const a = placeOf(starts, start);
  const b = placeOf(starts, end);
  return {
    ok: true,
    via: 'typescript',
    files: [{ absolute, edits: [{ line: a.line, column: a.column, endLine: b.line, endColumn: b.column, newText }] }],
  };
}

export async function planInsertBeforeSymbol(root, args = {}, opts = {}) {
  const bad = checkText(args.text, 'text');
  if (bad) return { ok: false, error: bad };
  const at = await locate(root, args.file, args.symbol, opts);
  if (!at.ok) return at;
  const start = insertionStart(at.ts, at.text, at.hit.node);
  /**
   * ⭐ ONE BLANK LINE BETWEEN, ALWAYS, and it is not cosmetic: without it the
   * inserted code and the existing declaration share a line the moment the
   * model's text does not end in a newline, which is a syntax error in some
   * shapes and unreadable in all of them.
   */
  const body = args.text.replace(/\s+$/, '');
  return oneEdit(at.absolute, at.starts, start, start, `${body}\n\n`);
}

export async function planInsertAfterSymbol(root, args = {}, opts = {}) {
  const bad = checkText(args.text, 'text');
  if (bad) return { ok: false, error: bad };
  const at = await locate(root, args.file, args.symbol, opts);
  if (!at.ok) return at;
  /**
   * ⚠️ `getEnd()` ON THE STATEMENT, which includes the closing brace and any
   * semicolon — the declarator's end would land before the `;` of
   * `const x = () => {};` and produce `const x = () => {}<new code>;`.
   */
  const end = at.hit.node.getEnd();
  const body = args.text.replace(/^\s+/, '');
  return oneEdit(at.absolute, at.starts, end, end, `\n\n${body}`);
}

export async function planReplaceFunctionBody(root, args = {}, opts = {}) {
  const bad = checkText(args.body, 'body');
  if (bad) return { ok: false, error: bad };
  const at = await locate(root, args.file, args.symbol, opts);
  if (!at.ok) return at;
  const { ts, hit } = at;

  /**
   * ⚠️ THE BODY OWNER IS NOT ALWAYS THE ANCHOR NODE. `function x(){}` carries
   * its own body; `const x = () => {}` carries it on the declarator's
   * initializer. Asking the statement for a body would find none and refuse a
   * perfectly ordinary modern function.
   */
  const owner = ts.isFunctionDeclaration(hit.node) ? hit.node : hit.decl.initializer;
  const body = owner && owner.body;
  if (!body || !ts.isBlock(body)) {
    /**
     * ⭐ THE REFUSAL NAMES WHAT IT ACTUALLY IS. "not a function" sends a model
     * looking for a typo; "`x` is a class" tells it to pick a method, and
     * "a concise arrow with no block" tells it the shape is `=> expr`.
     */
    const what = hit.kind === 'class'
      ? 'a class — replace one of its methods, not the class'
      : owner && (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner))
        ? 'a concise arrow with no `{ }` body — there is no block to replace. Use edit_file for a one-expression arrow'
        : 'not a function';
    return { ok: false, error: `\`${args.symbol}\` in ${args.file} is ${what}.` };
  }

  /**
   * ⚠️ INSIDE THE BRACES, NEVER INCLUDING THEM. Replacing the whole block would
   * make the model responsible for emitting `{` and `}` correctly, and a
   * missing brace here destroys the file rather than failing.
   */
  const start = body.getStart() + 1;
  const end = body.getEnd() - 1;
  const inner = args.body.replace(/^\n+/, '').replace(/\s+$/, '');
  return oneEdit(at.absolute, at.starts, start, end, `\n${inner}\n`);
}

/**
 * ── ⭐ THE VERB — ONE APPLY PATH, SHARED WITH `rename_symbol` ───────────────
 *
 * ⚠️ IT DELIBERATELY DOES NOT WRITE ANYTHING ITSELF. `rename.mjs` already owns
 * the dangerous half — preflight every path for WRITE before a byte lands, the
 * back-to-front splice, the CRLF rule, the overlap refusal, and
 * `executor.writeFile` so leases, `--dry-run`, `acuvo-rules.json`, the mutation
 * count and the `undo` journal all keep working. A second writer would be a
 * second place for every one of those to be forgotten.
 *
 * ⭐ SO THE THREE VERBS ARE A PLANNER PLUS `applyPlannedEdits`, and the plan
 * shape is `planViaTsserver`'s exactly.
 */
export const TS_EDIT_TOOL_NAMES = ['insert_before_symbol', 'insert_after_symbol', 'replace_function_body'];

const PLANNERS = {
  insert_before_symbol: planInsertBeforeSymbol,
  insert_after_symbol: planInsertAfterSymbol,
  replace_function_body: planReplaceFunctionBody,
};

/**
 * ── ⭐ THE ONE ENTRY POINT THE DISPATCHER CALLS ────────────────────────────
 *
 * @param {string} name one of `TS_EDIT_TOOL_NAMES`
 * @param {{ root: string, writeFile: Function }} executor
 */
export async function runTsEdit(name, executor, args = {}, opts = {}) {
  const plan = PLANNERS[name];
  if (!plan) return { ok: false, error: `unknown edit verb: ${String(name)}` };
  const planned = await plan(executor.root, args, opts);
  if (!planned.ok) return planned;
  /**
   * ⚠️ THE EMPTY CASE IS UNREACHABLE HERE AND IS ANSWERED ANYWAY. Every planner
   * either refuses or returns exactly one edit, so `files: []` would mean a
   * planner changed shape — and a silent no-op write is the worst way to learn
   * that. `applyPlannedEdits` takes the sentence rather than assuming.
   */
  return applyPlannedEdits(executor, planned, {
    kind: name,
    label: String(args.symbol ?? ''),
    emptyHint: `nothing to change for \`${String(args.symbol ?? '')}\` — the planner produced no edit, which should not happen. Report it and use edit_file.`,
  });
}

export function tsEditToolSchemas() {
  const where = {
    file: { type: 'string', description: 'Workspace-relative .ts/.tsx/.js/.jsx file the symbol is declared in.' },
    symbol: { type: 'string', description: 'NAME of the top-level function, class or const. Not a line number.' },
  };
  return [
    {
      type: 'function',
      function: {
        name: 'insert_before_symbol',
        description: 'Insert code ABOVE a named top-level declaration, above its doc comment. No anchor text: '
          + 'the compiler finds the symbol.',
        parameters: {
          type: 'object',
          properties: { ...where, text: { type: 'string', description: 'The code to insert. A blank line is added after it.' } },
          required: ['file', 'symbol', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'insert_after_symbol',
        description: 'Insert code BELOW a named top-level declaration, after its brace and semicolon. '
          + 'No anchor text.',
        parameters: {
          type: 'object',
          properties: { ...where, text: { type: 'string', description: 'The code to insert. A blank line is added before it.' } },
          required: ['file', 'symbol', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_function_body',
        /**
         * ⚠️⚠️ THE ONE COPY OF THE edit_file RULE, AND IT HAS TO BE IN THE OFFER.
         *
         * All three schemas used to carry their own version of "use this instead
         * of edit_file". Lever 10 reclaimed those 232 characters on 2026-09-07 —
         * correctly, on the grounds that it was *"one rule said three times in a
         * payload sent every round"* — but the rule then existed **nowhere the
         * model reads before choosing**. Every surviving `edit_file` mention in
         * this module is inside an ERROR RESULT, which arrives only after the
         * model has already picked an AST verb; it cannot change the decision it
         * was written to change. That is this repo's own test for moving a line
         * out of a prompt: not *"is it duplicated"* but *"does the duplicate
         * arrive in time"*. One copy, in the standing offer, costs **84 bytes** a
         * round against the 232 the lever saved.
         *
         * ⚠️ THE COST WAS COMPUTED, NOT MEASURED, and that is stated rather than
         * hidden: lever 10 lives in `console/` and needs a node_modules this
         * worktree does not have. Through its OWN formula (`ceil(len/4)` over the
         * stringified schemas, against `CONTEXT_BUDGET_TOKENS`) 84 chars is **21
         * est tokens**, taking 24,275/96,000 = 0.2529 to ~0.2531 against a 0.26
         * ceiling — ~664 est tokens of headroom left. **Re-run lever 10.**
         */
        description: 'Replace everything INSIDE a named function\'s braces, keeping its signature, doc and export. '
          + 'Works on `function x(){}` and `const x = () => {}`. Give the body WITHOUT the outer braces. '
          + 'Prefer these three over edit_file: they anchor on the NAME, not on a line that repeats.',
        parameters: {
          type: 'object',
          properties: { ...where, body: { type: 'string', description: 'The new body, WITHOUT the surrounding { }.' } },
          required: ['file', 'symbol', 'body'],
        },
      },
    },
  ];
}
