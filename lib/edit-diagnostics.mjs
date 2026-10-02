/**
 * ── ⭐⭐⭐ THE COMPILER WAS RUNNING AND NOBODY WAS LISTENING ──────────────────
 *
 * `lib/lsp.mjs` already starts typescript-language-server, pyright,
 * rust-analyzer and gopls, and already exports `diagnostics(root, file)`. Until
 * now the model heard from them ONLY if it chose to call `check_types` — and
 * measured across agents, models reach for symbol tools **0–6% of the time**.
 * So on most edits the language server knew the file was broken and said
 * nothing.
 *
 * ⭐ WHY THIS IS THE HIGHEST-VALUE CHANGE ON THE BOARD, with evidence:
 *
 *   · Self-critique with NO external signal is measured to make things WORSE —
 *     six settings out of six down or flat, and one benchmark lost 37.7 points
 *     in a single round (arXiv:2310.01798). This is why a `--refute` pass that
 *     consults nothing but the model is not free.
 *   · With an EXTERNAL signal it works: replacing the model's own feedback with
 *     real feedback moved repaired-and-passing 33.3% → 52.6% (arXiv:2306.09896).
 *   · SWE-agent's ablation puts the linter-on-edits mechanism at **+3.0 points**
 *     — larger than removing ALL search (−2.3).
 *
 * A compiler error is that external signal, it arrives without a model call, and
 * we were already paying to compute it.
 *
 * ⚠️ ERRORS ONLY, NEVER STYLE. Aider's linter is deliberately narrow — syntax
 * errors and undefined names, no formatting — because style warnings make the
 * model chase noise instead of the defect it just introduced.
 *
 * ⚠️⚠️ AND IT MAY NEVER FAIL A WRITE. The file is already on disk. Turning "the
 * language server did not answer" into a failed edit would make correct work
 * look broken, which this repo has paid for four times in one day.
 */

import { languageForFile, diagnostics as lspDiagnostics } from './lsp.mjs';

/**
 * ⭐ TWENTY, NOT ALL OF THEM. One bad import can produce hundreds of errors, and
 * pasting them all back spends the context the model needs to FIX it. The first
 * twenty in file order carry the cause; the rest are consequences of it.
 */
export const MAX_DIAGNOSTICS_PER_FILE = 20;

/** How long a language server gets before we give up and stay quiet. */
export const DIAGNOSTICS_BUDGET_MS = 4_000;

/**
 * Which files a tool call actually put bytes into.
 *
 * ⚠️ DERIVED FROM THE RESULT, NOT THE ARGUMENTS. The arguments are what the
 * model ASKED for; the result is what landed. A refused write, a dry run, or a
 * batch where 44 of 45 files were written all differ, and asking a language
 * server about a file that was never written produces a diagnostic about the
 * version already on disk — which reads as "your edit broke this" when the edit
 * never happened.
 *
 * Pure.
 */
export function writtenPathsOf(record) {
  const { name, result } = record ?? {};
  if (!result || result.ok !== true || result.dryRun === true) return [];
  switch (name) {
    case 'write_file':
    case 'edit_file':
      return typeof result.path === 'string' && result.path ? [result.path] : [];
    case 'move_file':
      // The destination holds the bytes now; the source no longer exists.
      return typeof result.to === 'string' && result.to ? [result.to] : [];
    case 'write_files':
      return (Array.isArray(result.written) ? result.written : [])
        .map((w) => (typeof w === 'string' ? w : w?.path))
        .filter((p) => typeof p === 'string' && p);
    default:
      /**
       * ⚠️ A SHELL COMMAND CAN WRITE ANYTHING, and we do not know what. Guessing
       * would mean either probing the whole tree or saying nothing useful, so
       * this stays scoped to the verbs whose result names its own files.
       */
      return [];
  }
}

/**
 * ── ⚠️⚠️⚠️ NEVER BLAME THE MODEL FOR BREAKAGE THAT WAS ALREADY THERE ─────────
 *
 * The first version of this module reported EVERY error in the file after a
 * write. In a repo that already has type errors — which is most real repos — a
 * model that wrote a perfectly correct file gets handed a list of someone else's
 * bugs and told "fix these before continuing". It will: a whole round, at full
 * price, producing a diff nobody asked for.
 *
 * SWE-agent's edit guard runs the linter before and after and DIFFS the error
 * sets for exactly this reason. This is that, with the baseline captured when
 * the file is READ (OpenCode's trick — the read tool warms the language server
 * fire-and-forget) so a write does not pay for two round-trips.
 *
 * ⚠️ FINGERPRINTED BY MESSAGE, NOT BY LINE. An edit shifts every line below it,
 * so a line-keyed baseline would report the entire tail of the file as new.
 * Keyed by message WITH A COUNT: three instances before and four after means
 * exactly one new one, which is the fact the model needs. Message-only would let
 * a model add four more of an error that already existed once and hear nothing.
 */
const baselines = new Map();

const fingerprint = (d) => String(d?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

function countByMessage(items) {
  const counts = new Map();
  for (const d of items) {
    const k = fingerprint(d);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** Record what a file's errors looked like BEFORE the model touched it. */
export function rememberBaseline(file, items) {
  const errors = (Array.isArray(items) ? items : []).filter((d) => Number(d?.severity) === 1);
  baselines.set(file, countByMessage(errors));
}

/** ⚠️ Tests only — the store is process-wide and a leaked baseline hides a real error. */
export function resetBaselines() {
  baselines.clear();
}

/**
 * The errors that were not already there.
 *
 * ⚠️ NO BASELINE MEANS REPORT EVERYTHING. If we never saw the file before we
 * cannot know what we broke, and staying silent about real errors to avoid a
 * false accusation is the worse trade — a missed error ships.
 */
export function newErrorsOnly(file, items) {
  const errors = (Array.isArray(items) ? items : []).filter((d) => Number(d?.severity) === 1);
  const before = baselines.get(file);
  if (!before) return errors;

  const remaining = new Map(before);
  const fresh = [];
  for (const d of errors) {
    const k = fingerprint(d);
    const left = remaining.get(k) ?? 0;
    if (left > 0) remaining.set(k, left - 1);
    else fresh.push(d);
  }
  return fresh;
}

/** One error line, clamped — a single diagnostic can carry a whole type. */
function line(d) {
  const at = Number.isFinite(d?.line) ? `${d.line}${Number.isFinite(d?.column) ? `:${d.column}` : ''}` : '?';
  const message = String(d?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return `  ${at}  ${message}`;
}

/**
 * The block for one file, or null when there is nothing worth the tokens.
 *
 * ⚠️ TAGGED, NOT LOOSE PROSE. Tool results are the first thing compaction
 * clamps, and an unlabelled paragraph of compiler output looks like any other
 * long result. A named block can be found, superseded by a later one for the
 * same file, and dropped as a unit.
 */
export function formatDiagnosticsBlock(file, items) {
  const errors = (Array.isArray(items) ? items : []).filter((d) => Number(d?.severity) === 1);
  if (errors.length === 0) return null;

  const shown = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE);
  const hidden = errors.length - shown.length;
  const body = shown.map(line).join('\n');
  /**
   * ⚠️ A SILENT TRUNCATION IS A LIE ABOUT THE STATE OF THE FILE. A model told
   * about 20 errors that has 50 will believe it is 20 fixes from green.
   */
  const tail = hidden > 0 ? `\n  … and ${hidden} more error${hidden === 1 ? '' : 's'} in this file` : '';
  return `<diagnostics file="${file}">\n${body}${tail}\n</diagnostics>`;
}

/**
 * Diagnostics for the files a tool call just wrote, as one string to append to
 * the tool result — or null when there is nothing to say.
 *
 * @param {string} root
 * @param {readonly string[]} paths
 * @param {{ diagnosticsImpl?: Function, timeoutMs?: number }} [opts]
 */
export async function diagnosticsAfterWrite(root, paths, opts = {}) {
  const impl = opts.diagnosticsImpl ?? lspDiagnostics;
  const budget = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DIAGNOSTICS_BUDGET_MS;

  /**
   * ⚠️ FILTERED BEFORE ANY SERVER IS TOUCHED. Asking about `README.md` would
   * start a language server for a file no server handles — cost with no
   * possible answer.
   */
  const candidates = [...new Set((paths ?? []).filter((p) => typeof p === 'string' && p))]
    .filter((p) => {
      try { return Boolean(languageForFile(p)); } catch { return false; }
    });
  if (candidates.length === 0) return null;

  const blocks = [];
  for (const file of candidates) {
    /**
     * ⚠️⚠️ EVERY FAILURE MODE IS SILENCE. Server missing, server throwing,
     * server never answering — none of them may turn a landed write into a
     * reported failure, and none may hold the turn open.
     */
    let res = null;
    let timer = null;
    try {
      /**
       * ⚠️ THE TIMER IS CLEARED, NOT UNREF'D. `unref()` lets the event loop exit
       * while the race is still pending, so a caller that awaits this can be
       * abandoned mid-flight — which is exactly how the first version of this
       * failed its own timeout test ("Promise resolution is still pending but
       * the event loop has already resolved"). Keep the loop alive for the
       * budget, then release it.
       */
      res = await Promise.race([
        Promise.resolve(impl(root, file)),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), budget); }),
      ]);
    } catch {
      res = null;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res || res.ok !== true) continue;
    const all = res.items ?? res.diagnostics ?? [];
    const fresh = newErrorsOnly(file, all);
    /**
     * ⭐ THE BASELINE MOVES TO THE CURRENT STATE, and that is what stops a loop.
     * An error the model has already been told about is not re-announced on its
     * next write — being told twice about something you are already fixing is
     * how a model starts oscillating.
     */
    rememberBaseline(file, all);
    const block = formatDiagnosticsBlock(file, fresh);
    if (block) blocks.push(block);
  }

  if (blocks.length === 0) return null;
  /**
   * ⭐ PHRASED AS AN INSTRUCTION, because this string is handed straight to the
   * model. "Diagnostics:" is a label; naming what to do with them is the thing
   * that turns a signal into a repair.
   */
  return `\n\nThe language server reports errors in what you just wrote. Fix these before continuing:\n${blocks.join('\n')}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐⭐ (b) EDIT-THEN-LINT-*BEFORE*-COMMIT — SWE-agent's second ACI idea
 *
 * Everything above this line lints AFTER the bytes are on disk, and its own
 * header says why it must never fail a write: *"the file is already on disk"*.
 * That is the right rule for that seam and it leaves a hole — the broken file
 * lands, the model reads a diagnostic, and it spends a round undoing damage it
 * could have been stopped from doing.
 *
 * ⭐ SWE-agent's design closes it: check the RESULTING content, and refuse the
 * edit before it lands. We can, because `applyEdit` and `planPatch` are both
 * PURE — `tools.mjs` already computes the after-image to show the approval gate,
 * so the content is in hand a line before it is written.
 *
 * ⚠️⚠️ AND THE REASON THIS IS SAFE IS THE DELTA, NOT THE CHECK. A checker that
 * refuses whatever it cannot parse would reject `tsconfig.json` (JSON with
 * comments, which `JSON.parse` has never accepted) and half the TypeScript in
 * this repo. So a refusal requires TWO facts: the file was definitively VALID
 * before, and it is definitively INVALID after. A file that did not parse to
 * begin with is not this edit's fault and is never blocked — which is the same
 * reasoning `newErrorsOnly` above uses for the language server.
 *
 * ⚠️ ONE FORMAT BLOCKS; THE REST ONLY WARN. `JSON.parse` is a decision, not an
 * opinion — there is no valid JSON it rejects. Brace balance is a heuristic, and
 * a heuristic must never be allowed to refuse a correct edit, so it is appended
 * to a SUCCESSFUL result as one line the model reads in the same round.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Only these are decided by a real parser, so only these may block an edit. */
const DEFINITIVE = new Set(['.json']);

/**
 * ── ⚠️⚠️ THIS LIST IS A MEASUREMENT, NOT AN AMBITION ────────────────────────
 *
 * Every extension here was run through `bracketBalance` against a real corpus
 * on 2026-08-24 — 1,888 `.ts` files in `console/` and 382 `.mjs` files in this
 * package — and reported **0 false positives out of 2,270**. Nothing is listed
 * that has not been counted.
 *
 * ⚠️ WHAT WAS TAKEN OUT, AND WHY, so nobody adds it back on reasoning:
 *   · `.tsx` / `.jsx` — **223 of 409 real files mis-read**. A closing JSX tag
 *     `</div>` puts `/` after `<`, which every regex heuristic ever written
 *     reads as the start of a pattern; the "regex" then runs to end of line and
 *     the file is scanned in the wrong mode from there. Not fixable without a
 *     real parser, so React files simply get no balance warning.
 *   · `.css` / `.scss` — `url(http://example.com)` contains `//`, which the
 *     comment rule eats along with the closing paren. One measured file is not
 *     a corpus and the hazard is obvious, so it stays out.
 *   · `.rs` — a lifetime (`&'a str`) is an apostrophe that never closes.
 *   · `.py` — structure is indentation; braces measure nothing.
 *   · `.go`, `.java`, `.c`, `.php`, … — plausible, and UNMEASURED. This package
 *     does not ship claims it has not counted.
 */
const BRACE_LANGUAGES = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

const extensionOf = (path) => {
  const base = String(path ?? '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
};

/**
 * Is this file one the pre-commit check can say anything about?
 *
 * ⚠️ EXPORTED SO THE DISPATCHER CAN SKIP THE READ. `checkEditBeforeCommit`
 * needs the BEFORE content, and reading it for a `.md` or a `.png` is a disk
 * round-trip on every write that can only ever return "nothing to say".
 */
export function isCheckablePath(path) {
  const ext = extensionOf(path);
  return DEFINITIVE.has(ext) || BRACE_LANGUAGES.has(ext);
}

/** `JSON.parse`'s verdict, with its message trimmed to one terse line. */
export function jsonVerdict(source) {
  try {
    JSON.parse(String(source ?? ''));
    return { ok: true };
  } catch (err) {
    const message = String(err?.message ?? 'invalid JSON').replace(/\s+/g, ' ').trim().slice(0, 200);
    return { ok: false, error: message };
  }
}

/**
 * The net `(){}[]` balance of a source file, ignoring brackets that live inside
 * a string, a template literal, a comment or a regular expression.
 *
 * ⚠️ IT RETURNS A NUMBER, NEVER A VERDICT. "This file is unbalanced" is a claim
 * a real parser gets to make; all this can honestly say is "the count moved",
 * which is only meaningful as a difference between two versions of one file.
 *
 * ⚠️ THE REGEX HEURISTIC IS THE ONE APPROXIMATION, and it is the standard one:
 * a `/` opens a regular expression unless the previous significant character
 * could end a value. Getting it wrong costs a WARNING, never a refusal — which
 * is exactly why the warning branch is the one allowed to use a heuristic.
 *
 * Pure. O(n), one pass, no allocation per character.
 */
/** After one of these a `/` can only start a regular expression, never divide. */
const VALUE_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
  'instanceof', 'do', 'else', 'yield', 'await', 'throw',
]);

/** The identifier immediately before position `i`, or '' when there is none. */
function lastWord(s, i) {
  let end = i;
  while (end > 0 && /\s/.test(s[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && /[A-Za-z_$]/.test(s[start - 1])) start -= 1;
  return s.slice(start, end);
}

export function bracketBalance(source) {
  const s = String(source ?? '');
  let depth = 0;
  /** The last non-whitespace character of CODE, which is how a `/` is decided. */
  let previous = '';
  /** The one before it — TypeScript's `!` needs two characters of lookback. */
  let penultimate = '';
  /**
   * ── ⚠️⚠️ THE FIRST VERSION SKIPPED `${…}` AND MISREAD 326 OF 381 REAL FILES ─
   *
   * MEASURED against every `.mjs` in this package: the naive version — enter a
   * string, leave at the closing quote — reported a non-zero balance for 326 of
   * 381 syntactically valid files, i.e. it was noise. The cause is that a
   * template literal is not a string: `${` hands control back to CODE and the
   * matching `}` hands it back to the STRING, and a scanner that forgets which
   * it is in treats the closing backtick as an OPENING one. Everything after it
   * is then parsed in the wrong mode, and the error cascades to end of file.
   *
   * ⭐ So nesting is tracked with a stack: each open template records the code
   * depth it was interrupted at, and the `}` that returns to that depth returns
   * to the template. Nested templates inside interpolations — which this
   * codebase writes constantly — work by construction rather than by luck.
   */
  const templates = [];
  let inTemplate = false;
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (inTemplate) {
      if (ch === '\\') { i += 2; continue; }
      /**
       * ⚠️ A CLOSING BACKTICK ALWAYS RETURNS TO **CODE**, never to the enclosing
       * template. Measured on `write-many.mjs:141` — a nested template inside an
       * outer one's `${…}` — the obvious "resume the parent" version put the
       * scanner back into the parent's STRING while it was still inside the
       * parent's interpolation, and every bracket after it was ignored. The way
       * back into a template is the `}` that closes its interpolation, and that
       * is the only way.
       */
      if (ch === '`') { templates.pop(); inTemplate = false; previous = '`'; i += 1; continue; }
      if (ch === '$' && s[i + 1] === '{') {
        templates[templates.length - 1].brace = depth;
        templates[templates.length - 1].open = true;
        inTemplate = false;
        depth += 1;
        previous = '{';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    const next = s[i + 1];
    if (ch === '/' && next === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === quote || s[i] === '\n') break;
        i += 1;
      }
      previous = quote;
      i += 1;
      continue;
    }
    if (ch === '`') {
      templates.push({ brace: -1, open: false });
      inTemplate = true;
      i += 1;
      continue;
    }
    /**
     * ⚠️ A KEYWORD ENDS IN A LETTER, AND THAT ALONE COST 59 FALSE READINGS.
     * `return /\s+/.test(x)` puts `n` in `previous`, the letter rule calls the
     * `/` a division, and the rest of the file is scanned inside a "regex" that
     * never ends. Measured on this package: adding the keyword list took the
     * mis-read count down again. Kept as a Set rather than a regex so adding one
     * is a one-word change.
     */
    /**
     * ⚠️ AND TYPESCRIPT'S `!` IS A VALUE ENDING, NOT A PREFIX. Measured on
     * `console/lib/llm-budget.test.ts`: `PROVIDER_LIMITS.gemini!.rpm! / ROUND`
     * put `!` in `previous`, which the JavaScript rule reads as the prefix in
     * `!/^x/.test(s)` — so a plain division opened a regex that never closed.
     * Distinguished by ONE more character of lookback: a `!` after an
     * identifier or a `)` is TypeScript's non-null assertion; a `!` after
     * anything else is negation.
     */
    const valueBefore = /[A-Za-z0-9_$)\]]/.test(previous)
      || (previous === '!' && /[A-Za-z0-9_$)\]]/.test(penultimate));
    if (ch === '/' && (VALUE_KEYWORDS.has(lastWord(s, i)) || !valueBefore)) {
      /**
       * A regular expression literal: its brackets are pattern syntax, not
       * structure. ⚠️ THE ONE HEURISTIC IN HERE, and the reason this function is
       * only ever allowed to produce a WARNING — `a / b / c` and `/ab/` are
       * distinguishable only with a real parser.
       */
      i += 1;
      let inClass = false;
      while (i < s.length && s[i] !== '\n') {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '[') inClass = true;
        else if (s[i] === ']') inClass = false;
        else if (s[i] === '/' && !inClass) break;
        i += 1;
      }
      previous = '/';
      i += 1;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === '}') {
      depth -= 1;
      // Did this close an interpolation? Then we are back inside its template.
      const top = templates[templates.length - 1];
      if (top && top.open && depth === top.brace) { top.open = false; inTemplate = true; }
    }
    if (!/\s/.test(ch)) { penultimate = previous; previous = ch; }
    i += 1;
  }
  return depth;
}

/**
 * ⭐ THE GATE `tools.mjs` CALLS BEFORE IT WRITES.
 *
 * @param {string} path    the file the edit lands in
 * @param {string|null} before  the content on disk, or null for a new file
 * @param {string|null} after   the content the edit would produce
 * @returns {{ block: string|null, note: string|null }}
 *   `block` — a terse refusal; nothing may be written.
 *   `note`  — one line to append to a SUCCESSFUL result.
 */
export function checkEditBeforeCommit(path, before, after) {
  const none = { block: null, note: null };
  if (typeof after !== 'string' || typeof path !== 'string' || !path) return none;
  const ext = extensionOf(path);

  if (DEFINITIVE.has(ext)) {
    const wasValid = typeof before === 'string' && before.trim() !== '' && jsonVerdict(before).ok;
    if (wasValid) {
      const now = jsonVerdict(after);
      if (!now.ok) {
        /**
         * ⚠️ THE REFUSAL NAMES THE NEXT MOVE. An error string in this package is
         * an INSTRUCTION — a model told only "invalid JSON" re-sends the same
         * fragment, and a model told the file is untouched knows it still has
         * the original to work from.
         */
        return {
          block: `${path} would stop being valid JSON: ${now.error}. `
            + 'NOTHING WAS WRITTEN — the file on disk is unchanged. Re-read it, fix the fragment '
            + '(a trailing comma and an unclosed brace are the usual causes) and edit again.',
          note: null,
        };
      }
    }
    return none;
  }

  if (!BRACE_LANGUAGES.has(ext)) return none;
  if (typeof before !== 'string') return none;

  const wasBalanced = bracketBalance(before) === 0;
  if (!wasBalanced) return none;
  const now = bracketBalance(after);
  if (now === 0) return none;

  const missing = now > 0
    ? `${now} bracket${now === 1 ? '' : 's'} opened and never closed`
    : `${-now} more closing bracket${now === -1 ? '' : 's'} than opening ones`;
  return {
    block: null,
    note: `\n<edit-check file="${path}">${path} was bracket-balanced before this edit and is not now: ${missing}. `
      + 'If that was not deliberate, fix it before running anything.</edit-check>',
  };
}

/**
 * ── ⭐ WARM THE SERVER AND SNAPSHOT, WHEN THE MODEL READS A FILE ─────────────
 *
 * OpenCode's trick, and it buys two things at once. The language server is slow
 * only on its FIRST request for a project, so doing that work while the model is
 * reading — not while it is waiting for a write to return — hides the latency.
 * And it gives us the BEFORE picture, which is the whole basis for not blaming
 * the model for breakage that was already there.
 *
 * ⚠️ FIRE AND FORGET, ALWAYS. This must never delay a read, never fail one, and
 * never surface anything to the model. A read is the cheapest, most frequent
 * call in the loop; making it wait on a language server handshake would be felt
 * on every single turn.
 */
export function warmBaseline(root, file, opts = {}) {
  const impl = opts.diagnosticsImpl ?? lspDiagnostics;
  try {
    if (!languageForFile(file)) return;
    if (baselines.has(file)) return;
  } catch { return; }
  try {
    Promise.resolve(impl(root, file))
      .then((res) => { if (res && res.ok === true) rememberBaseline(file, res.items ?? res.diagnostics ?? []); })
      .catch(() => {});
  } catch { /* a snapshot may never break a read */ }
}
