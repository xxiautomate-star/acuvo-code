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
