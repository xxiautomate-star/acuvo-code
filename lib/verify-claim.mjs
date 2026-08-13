/**
 * ── ⭐⭐ `acuvo verify` — RE-CHECKING A PAST CLAIM, FOR NOTHING ───────────────
 *
 * Every run already writes a receipt. `lib/audit.mjs` records, per run:
 *
 *     id · at · taskSha256 · task · model · rounds · stoppedBecause
 *     verification: { ran, passed, command: "npm test", exitCode: 0, attempts }
 *     acceptance · changes[] · costUsd · tokens · refusals[]
 *
 * That `command` is the whole thing. It is not a summary of what the agent
 * believed — it is the exact command this process observed exiting 0, and it is
 * on disk. Which means a claim made yesterday can be tested today by RUNNING it
 * again, mechanically, with **no model call and no cost at all**.
 *
 * ⭐ NOBODY ELSE CAN BUILD THIS, and the reason is worth stating precisely: it
 * is not hard, it is downstream. You cannot re-check a machine-checkable verdict
 * until you HAVE a machine-checkable verdict, and an agent whose success
 * criterion is its own closing paragraph has nothing to re-check. Everything
 * here rests on `acceptance.mjs` fixing the criterion before the work and
 * `turn.mjs` recording the exit code rather than the opinion.
 *
 * ── ⚠️ WHAT A FAILED RE-CHECK MEANS, AND WHAT IT DOES NOT ───────────────────
 *
 * A claim that no longer holds does NOT mean the agent lied. Somebody may have
 * edited the file since; a dependency may have moved; the test may be flaky. The
 * honest reading is "this claim is no longer true", and that is exactly the
 * useful one — it is the difference between *the agent said it passed* and *it
 * passes*, and only the second is worth gating a deploy on.
 *
 * ⚠️ AND "NO CHECKABLE CLAIM" IS NOT A PASS. A run that never ran a command made
 * no claim this can test, and reporting that as success would be the quiet
 * dishonesty every verdict in this package exists to prevent.
 */

import { AUDIT_DIR, parseAuditLog } from './audit.mjs';
import { readAuditFiles } from './spend.mjs';

/**
 * Every recorded run, newest first.
 *
 * ⚠️ Reads through `readAuditFiles`, the same reader `acuvo spend` uses, so a
 * change to how the log is stored cannot leave one command working and the
 * other silently blind.
 */
export function loadRuns(root, { readImpl = readAuditFiles } = {}) {
  let files;
  try {
    files = readImpl(root, { dir: AUDIT_DIR });
  } catch (err) {
    return { ok: false, error: `could not read the run log: ${err?.message ?? err}`, runs: [] };
  }
  const runs = [];
  let damaged = 0;
  for (const f of files ?? []) {
    const parsed = parseAuditLog(f?.text ?? '');
    damaged += parsed.damaged;
    for (const rec of parsed.records) runs.push(rec);
  }
  runs.sort((a, b) => String(b?.at ?? '').localeCompare(String(a?.at ?? '')));
  return { ok: true, runs, damaged };
}

/**
 * Find one run by id, or the most recent that made a checkable claim.
 *
 * ⭐ "Most recent WITH A CLAIM" rather than simply "most recent": the common
 * case is `acuvo verify` typed straight after some work, and the last record
 * might be a read-only question that ran nothing. Silently checking that one and
 * reporting "nothing to check" would be technically true and useless.
 */
export function pickRun(runs, id = null) {
  if (id) {
    const exact = runs.find((r) => r?.id === id);
    if (exact) return { ok: true, run: exact };
    const prefix = runs.filter((r) => String(r?.id ?? '').startsWith(id));
    if (prefix.length === 1) return { ok: true, run: prefix[0] };
    if (prefix.length > 1) return { ok: false, error: `"${id}" matches ${prefix.length} runs — give more of the id` };
    return { ok: false, error: `no run here has the id "${id}". \`acuvo verify\` with no id takes the most recent one that made a checkable claim.` };
  }
  const claimed = runs.find((r) => typeof r?.run?.verification?.command === 'string' && r.run.verification.command.trim());
  if (claimed) return { ok: true, run: claimed };
  if (runs.length > 0) return { ok: true, run: runs[0] };
  return { ok: false, error: 'no runs have been recorded in this workspace yet' };
}

/**
 * Re-run the command a past run claims it verified.
 *
 * `runner` is injected — it is `executeRunCommand` in the CLI, so the re-check
 * goes through exactly the audited gate the original did, and a test can drive
 * it without spawning anything.
 *
 * @returns {Promise<{ok: boolean, status: 'holds'|'broken'|'unclaimed'|'error', ...}>}
 */
export async function recheckClaim(record, { runner, timeoutMs } = {}) {
  const v = record?.run?.verification ?? {};
  const command = typeof v.command === 'string' ? v.command.trim() : '';

  if (!command || v.ran !== true) {
    return {
      ok: true,
      status: 'unclaimed',
      id: record?.id ?? null,
      message: 'that run never executed a command, so it made no claim this can re-check. '
        + 'Nothing here is evidence either way — which is not the same as it having passed.',
    };
  }
  if (typeof runner !== 'function') return { ok: false, status: 'error', error: 'no runner was supplied' };

  let result;
  try {
    result = await runner(command, { timeoutMs });
  } catch (err) {
    return { ok: false, status: 'error', id: record?.id ?? null, command, error: `could not re-run it: ${err?.message ?? err}` };
  }
  if (result?.ok !== true) {
    return { ok: false, status: 'error', id: record?.id ?? null, command, error: result?.error ?? 'the command could not be started' };
  }

  const holds = result.exitCode === 0;
  return {
    ok: true,
    status: holds ? 'holds' : 'broken',
    id: record?.id ?? null,
    at: record?.at ?? null,
    command,
    claimedExit: Number.isFinite(v.exitCode) ? v.exitCode : 0,
    actualExit: result.exitCode,
    /** What the run said it changed — the first thing to look at if it broke. */
    changes: (record?.run?.changes ?? []).map((c) => c.path).filter(Boolean),
  };
}

/** The report. It must never make a claim it did not test. */
export function formatRecheck(r) {
  if (!r) return 'nothing to report';
  if (r.status === 'error') return `could not re-check ${r.id ?? ''}: ${r.error}`;
  if (r.status === 'unclaimed') return `· run ${r.id ?? '(unknown)'} — ${r.message}`;

  const head = `run ${r.id}${r.at ? `  (${r.at})` : ''}`;
  if (r.status === 'holds') {
    return [`✔ THE CLAIM STILL HOLDS — ${head}`, `    \`${r.command}\` exits ${r.actualExit}, as it did then. No model was called; this cost nothing.`].join('\n');
  }
  const lines = [
    `✖ THE CLAIM NO LONGER HOLDS — ${head}`,
    `    \`${r.command}\` claimed exit ${r.claimedExit} and now exits ${r.actualExit}.`,
  ];
  if (r.changes.length > 0) lines.push(`    That run changed: ${r.changes.slice(0, 8).join(', ')}${r.changes.length > 8 ? `, +${r.changes.length - 8} more` : ''}`);
  /**
   * ⚠️ SAYS WHAT IT DOES NOT KNOW. A broken re-check is not proof the agent
   * lied — a person may have edited the file since, a dependency may have
   * moved, the test may be flaky. Presenting it as an accusation would make the
   * command untrustworthy the first time it was wrong about a cause.
   */
  lines.push('    This does not say the run lied — the file may have changed since. It says the claim is not true now.');
  return lines.join('\n');
}
