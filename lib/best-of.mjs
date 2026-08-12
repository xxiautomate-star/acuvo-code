/**
 * ── ⭐⭐ BEST-OF-N — COST TURNED INTO CAPABILITY ─────────────────────────────
 *
 * Run the same task several times independently, then keep the attempt that
 * actually PASSED. This is not a trick; it is the one thing our price makes
 * possible and a competitor's price does not. A run here costs ~$0.001, so
 * three attempts cost a third of a cent. An agent billing a hundred times that
 * cannot offer this at all — not because they lack the idea, because the
 * arithmetic forbids it.
 *
 * ── ⚠️⚠️ THE SELECTION MUST NOT BE THE MODEL'S OPINION ─────────────────────
 *
 * The obvious design is to generate N answers and ask a model which is best.
 * That is N chances to be confidently wrong, aggregated by a judge with the
 * same blind spots — and this codebase has measured exactly that failure: a
 * critic scored five of six different pages identically, and an agent declared
 * a page "clean and balanced" that it had never rendered.
 *
 * ⭐ SO THE WINNER IS CHOSEN BY WHAT RAN. `sessionFailed()` already encodes the
 * honest verdict — did the verification command pass, did a declared acceptance
 * criterion hold. Selection is that verdict first, and taste never.
 *
 * ── ⚠️ IT MUST NEVER BE WORSE THAN N=1 ──────────────────────────────────────
 *
 * A single run that fails verification still leaves its files on disk; the user
 * gets something to look at. So when NO attempt verifies, this applies one
 * anyway and says plainly that none passed. Applying nothing would make asking
 * for three attempts worse than asking for one, which is the kind of surprise
 * that makes a feature untrustworthy.
 */

import { cpSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

/**
 * ⚠️ THE SAME SKIP SET THE REST OF THE PACKAGE USES. Copying `node_modules` for
 * each of three attempts turns a 40MB workspace into 1.2GB of I/O on a laptop
 * that may be on battery — and none of it is read by the agent, which reaches
 * dependencies through the executor, not by walking them.
 */
export const COPY_SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.vercel', 'coverage', '.turbo', '.acuvo',
]);

export const MIN_ATTEMPTS = 2;
export const MAX_ATTEMPTS = 5;

/**
 * ⚠️ A CEILING ON WHAT WILL BE COPIED, because the alternative is discovering
 * mid-run that a workspace contained a 4GB dataset. Refusing with the number is
 * a decision the user can act on; silently copying it is a hang they cannot.
 */
export const MAX_COPY_BYTES = 256 * 1024 * 1024;

export function measureWorkspace(root, { limit = MAX_COPY_BYTES } = {}) {
  let bytes = 0;
  let files = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (bytes > limit) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (COPY_SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        try { bytes += statSync(full).size; files += 1; } catch { /* vanished mid-walk */ }
      }
    }
  };
  walk(root);
  return { bytes, files, overLimit: bytes > limit };
}

/**
 * Score one finished attempt. Lower is better.
 *
 * ⚠️ THE FIRST DIGIT IS THE ONLY ONE THAT DECIDES CORRECTNESS. Rounds and cost
 * break ties BETWEEN VERIFIED ATTEMPTS — they can never promote a failing
 * attempt above a passing one, however cheap or fast it was. An agent that
 * picked the cheapest answer would learn to do nothing.
 */
export function scoreAttempt(attempt, { failed }) {
  if (!attempt || attempt.error) return { rank: 3, why: 'the attempt crashed' };
  const outcome = attempt.outcome;
  if (!outcome) return { rank: 3, why: 'the attempt produced no result' };

  const mutations = (outcome.executed ?? []).filter((e) => e?.mutated).length;

  if (!failed(outcome)) {
    const v = outcome.verification;
    /**
     * ── ⚠️⚠️ DOING NOTHING IS NOT SUCCEEDING ─────────────────────────────
     *
     * CAUGHT BY A REAL RUN, not by reasoning. An attempt that wrote no files
     * and ran no verification came back `ok: true`, so `failed()` said false,
     * so it ranked as a WIN — and then beat the attempt that actually did the
     * work, because the tie-break prefers fewer rounds and doing nothing takes
     * the fewest rounds of all.
     *
     * ⭐ That is the same trap the cheap-failure test was written to close, one
     * level deeper: I guarded against a cheap FAILURE outranking an expensive
     * success and missed that a cheap NO-OP outranks everything. An agent
     * rewarded for this learns that the optimal move is to do nothing quickly.
     *
     * `failed()` cannot see it — a run with no verification is not a run that
     * failed verification, and that distinction is correct everywhere else.
     * So the emptiness is judged here, where the alternatives are visible.
     */
    if (!v?.ran && mutations === 0) {
      return {
        rank: 2,
        why: 'changed nothing and verified nothing',
        rounds: outcome.roundsUsed ?? 0,
        cost: outcome.usage?.cost ?? 0,
      };
    }
    return {
      rank: 0,
      why: v?.ran
        ? `verified: ${v.command} passed`
        : `changed ${mutations} file${mutations === 1 ? '' : 's'}, nothing left failing`,
      rounds: outcome.roundsUsed ?? 0,
      cost: outcome.usage?.cost ?? 0,
    };
  }

  // Ran something and it failed — still more informative than never running.
  if (outcome.verification?.ran) {
    return { rank: 1, why: `ran ${outcome.verification.command} and it failed`, rounds: outcome.roundsUsed ?? 0, cost: outcome.usage?.cost ?? 0 };
  }
  return { rank: 2, why: outcome.stoppedBecause ? `stopped: ${outcome.stoppedBecause}` : 'nothing was verified', rounds: outcome.roundsUsed ?? 0, cost: outcome.usage?.cost ?? 0 };
}

export function pickWinner(attempts, { failed }) {
  const scored = attempts.map((a, i) => ({ index: i, attempt: a, score: scoreAttempt(a, { failed }) }));
  const ordered = [...scored].sort((a, b) => (
    a.score.rank - b.score.rank
    || (a.score.rounds ?? 99) - (b.score.rounds ?? 99)
    || (a.score.cost ?? 0) - (b.score.cost ?? 0)
    || a.index - b.index
  ));
  const winner = ordered[0];
  return {
    winner,
    scored,
    anyVerified: scored.some((s) => s.score.rank === 0),
  };
}

/**
 * Copy the files an attempt changed back into the real workspace.
 *
 * ⚠️ ONLY THE FILES THE ATTEMPT ITSELF REPORTED WRITING. Mirroring the whole
 * directory would also delete anything the user created while the attempts ran,
 * and would resurrect files an attempt deliberately deleted in a way the
 * report never mentioned. The change list is the attempt's own account of what
 * it did, and applying exactly that keeps the summary and the disk in agreement.
 */
export function applyAttempt(fromRoot, toRoot, outcome, { copy = cpSync, remove = rmSync } = {}) {
  const applied = [];
  const problems = [];
  for (const record of outcome?.executed ?? []) {
    if (!record?.mutated) continue;
    const path = record.args?.path;
    if (typeof path !== 'string' || path === '') continue;
    // ⚠️ Refuse anything that climbs out — the attempt ran in a copy, but the
    // path it reports is still a string from a model.
    if (path.includes('..') || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
      problems.push(`refused to apply a path that leaves the workspace: ${path}`);
      continue;
    }
    const src = join(fromRoot, path);
    const dest = join(toRoot, path);
    try {
      if (existsSync(src)) {
        copy(src, dest, { recursive: true, force: true });
        applied.push(path);
      } else if (existsSync(dest)) {
        // The attempt deleted it. Deleting it here is what "apply" means.
        remove(dest, { recursive: true, force: true });
        applied.push(path);
      }
    } catch (err) {
      problems.push(`${path}: ${String(err?.message ?? err)}`);
    }
  }
  return { applied, problems };
}

/**
 * Run one task N times in isolated copies and apply the best result.
 *
 * `runOne({ root, label })` must resolve to a SessionDone-shaped outcome.
 * Injected so this module never imports the turn loop — it is a strategy, not
 * a second engine.
 */
export async function runBestOf({
  root,
  attempts = 3,
  runOne,
  failed,
  pool,
  concurrency = 2,
  onEvent = () => {},
  makeTempDir = () => mkdtempSync(join(tmpdir(), 'acuvo-bestof-')),
  copyDir = cpSync,
  removeDir = rmSync,
  /**
   * ⚠️ INJECTABLE SO THE GUARD CAN BE TESTED AT ALL. With the limit hardcoded,
   * the only way to exercise the refusal is to actually build a 256MB workspace
   * in a test — so nobody does, and the one branch that protects a laptop from
   * copying a dataset three times is the one branch never run.
   */
  maxBytes = MAX_COPY_BYTES,
}) {
  const n = Math.max(MIN_ATTEMPTS, Math.min(MAX_ATTEMPTS, Number(attempts) || MIN_ATTEMPTS));

  const size = measureWorkspace(root, { limit: maxBytes });
  if (size.overLimit) {
    return {
      ok: false,
      error: `this workspace holds more than ${Math.round(maxBytes / 1024 / 1024)}MB of files that would have to be copied ${n} times. `
        + 'Run without --best-of here, or point --dir at the subdirectory the task actually touches.',
    };
  }

  const roots = [];
  try {
    for (let i = 0; i < n; i += 1) {
      const dir = makeTempDir();
      /**
       * ⚠️ `dereference: false` — a symlink copied as its target silently
       * doubles a workspace and breaks any code that checks `isSymbolicLink`.
       */
      copyDir(root, dir, {
        recursive: true,
        dereference: false,
        force: true,
        filter: (src) => {
          const rel = relative(root, src);
          if (rel === '') return true;
          return !rel.split(sep).some((part) => COPY_SKIP_DIRS.has(part));
        },
      });
      roots.push(dir);
    }

    onEvent({ type: 'best-of-start', attempts: n, files: size.files, bytes: size.bytes });

    const jobs = roots.map((dir, i) => () => runOne({ root: dir, label: `attempt ${i + 1}/${n}` })
      .then((outcome) => ({ outcome }))
      .catch((err) => ({ error: String(err?.message ?? err) })));

    const results = pool
      ? await pool(jobs, { concurrency })
      : await Promise.all(jobs.map((j) => j()));

    const { winner, scored, anyVerified } = pickWinner(results, { failed });

    const { applied, problems } = applyAttempt(roots[winner.index], root, winner.attempt?.outcome, {
      copy: copyDir,
      remove: removeDir,
    });

    return {
      ok: true,
      attempts: n,
      anyVerified,
      winnerIndex: winner.index,
      winner: winner.attempt?.outcome ?? null,
      applied,
      problems,
      scored: scored.map((s) => ({
        index: s.index,
        rank: s.score.rank,
        why: s.score.why,
        rounds: s.score.rounds ?? null,
        cost: s.score.cost ?? null,
      })),
      totalCost: results.reduce((sum, r) => sum + (r?.outcome?.usage?.cost ?? 0), 0),
    };
  } finally {
    // ⚠️ ALWAYS, even when an attempt threw. Three abandoned copies of a
    // workspace per invocation is how a temp directory becomes a disk problem
    // nobody connects back to this feature.
    for (const dir of roots) {
      try { removeDir(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/** Render the outcome for a human. */
export function formatBestOf(result) {
  if (!result?.ok) return String(result?.error ?? 'best-of failed');
  const lines = [];
  const verifiedCount = result.scored.filter((s) => s.rank === 0).length;

  lines.push(`best of ${result.attempts}: ${verifiedCount} verified, kept attempt ${result.winnerIndex + 1}`);
  for (const s of result.scored) {
    const mark = s.index === result.winnerIndex ? '→' : ' ';
    const cost = s.cost ? ` · $${s.cost.toFixed(4)}` : '';
    const rounds = s.rounds ? ` · ${s.rounds}r` : '';
    lines.push(`${mark} attempt ${s.index + 1}: ${s.why}${rounds}${cost}`);
  }

  /**
   * ⚠️ THE ALL-FAILED CASE SAYS SO IN THOSE WORDS. "kept attempt 2" on its own
   * reads like a success, and a user who asked for three attempts precisely
   * because the task was hard is the last person who should have to infer that
   * none of them worked.
   */
  if (!result.anyVerified) {
    lines.push('⚠ NONE of the attempts verified. The files from the least-bad one were applied so you have something to look at, but nothing here is proven.');
  }
  if (result.applied.length > 0) lines.push(`applied ${result.applied.length} file${result.applied.length === 1 ? '' : 's'} from the winner`);
  for (const p of result.problems) lines.push(`⚠ ${p}`);
  lines.push(`total spend across all attempts: $${result.totalCost.toFixed(4)}`);
  return lines.join('\n');
}
