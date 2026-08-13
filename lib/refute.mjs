/**
 * ── ⭐⭐ THE SECOND OPINION — VERIFICATION THAT COSTS WHAT THE WORK COSTS ─────
 *
 * Every coding agent grades its own homework. It writes the code, decides the
 * code is good, and reports success — and the failure mode this package has
 * documented more than any other is not bad code, it is a TRUE-LOOKING CLAIM
 * about code. Four separate probes in this repository's own history printed
 * `✔ VERIFIED` over work that was wrong, incomplete, or never run.
 *
 * `acceptance.mjs` fixed half of that: the criterion is now the USER's command,
 * decided before the work, and only that command exiting 0 satisfies it. What it
 * cannot see is everything the criterion does not cover — a fix that passes the
 * named test and breaks the caller, a function renamed in four places and used
 * in five, a test quietly weakened to make itself pass.
 *
 * ⭐ SO A SECOND AGENT IS ASKED TO BREAK THE CLAIM. Not to review it, not to
 * summarise it — to REFUTE it, with a fresh context and no sight of the first
 * agent's reasoning, because inheriting the reasoning inherits the blind spot
 * that produced it.
 *
 * ── ⭐⭐ AND THIS IS ONLY AFFORDABLE HERE ────────────────────────────────────
 *
 * A measured task on this stack costs $0.001–0.003. Doubling that to check the
 * answer is a rounding error. An agent priced at frontier rates cannot make
 * "verify everything, always" a default — it would double a bill somebody is
 * already unhappy about — so this is a capability that follows from the cost
 * base rather than from cleverness, and it is not one a competitor can simply
 * decide to copy.
 *
 * ── ⚠️ THE BURDEN OF PROOF IS ON THE REFUTER, DELIBERATELY ──────────────────
 *
 * An adversarial reviewer that defaults to "something is probably wrong" fails
 * correct work, which this package treats as worse than the bug it was hunting.
 * So uncertainty is NOT a refutation: the refuter must produce a concrete,
 * checkable reason — a command that fails, a caller that no longer resolves, a
 * requirement in the task that nothing addresses. Anything softer is recorded
 * as a doubt and changes no verdict.
 *
 * ⚠️ IT CANNOT WRITE. A refuter that fixes what it finds is no longer refuting,
 * and its "fix" would land unreviewed on top of work somebody was about to
 * inspect. Read and RUN only — running is essential, because the strongest
 * refutation is a command that fails.
 */

import { REFUTER_TOOL_NAMES } from './refute-tools.mjs';

/** Enough to look, run something, and look again. Not enough to go exploring. */
export const DEFAULT_REFUTE_ROUNDS = 4;
export const MAX_REFUTE_ROUNDS = 8;

/**
 * The whole prompt. Written out rather than assembled, because the exact framing
 * is the mechanism: "find what is wrong" produces invented findings, and "check
 * the work" produces agreement.
 */
export function refutePrompt({ task, claim }) {
  return [
    'You are the SECOND opinion on work another agent has just finished. You did not do it and you have not seen how it was done.',
    '',
    'THE TASK IT WAS GIVEN:',
    task,
    '',
    'WHAT IT CLAIMS IT DID:',
    claim || '(it made no claim)',
    '',
    'YOUR JOB IS TO REFUTE THAT CLAIM, not to review it and not to improve it.',
    'Look at the workspace as it is now. Run the tests. Run the thing. Grep for the callers.',
    'You are trying to find a SPECIFIC, CHECKABLE reason the claim is false — for example:',
    '  · a command that fails when the claim says it passes',
    '  · a caller, import or reference that no longer resolves',
    '  · a requirement stated in the task that nothing in the workspace addresses',
    '  · a test that was changed to make itself pass rather than the code fixed',
    '',
    '⚠️ YOU MAY NOT WRITE, EDIT OR DELETE ANYTHING. You have no tools that can.',
    '',
    '⚠️ UNCERTAINTY IS NOT A REFUTATION. "This could be fragile", "there may be edge cases",',
    '"I would have done it differently" — none of those are refutations, and reporting them as',
    'though they were will fail work that is correct, which is worse than missing a bug.',
    'If you cannot find a concrete reason the claim is false, say so plainly.',
    '',
    'Finish with exactly one of these two lines, on its own line, as the last line of your reply:',
    '  REFUTED: <the specific reason, and the evidence you got it from>',
    '  NOT REFUTED: <what you checked>',
  ].join('\n');
}

/**
 * ⚠️ PARSED FROM THE LAST LINE, AND ONLY THE LAST LINE. A model discussing the
 * word "REFUTED" mid-answer ("I could not find anything that would be REFUTED
 * by the tests") must not flip a verdict. Anchoring to the final line makes the
 * verdict a thing it has to DECIDE rather than a word it happens to use.
 *
 * ⚠️ AND AN UNPARSEABLE REPLY IS **NOT REFUTED**, not an error. The burden is on
 * the refuter; a second opinion that could not express itself has not made a
 * case, and failing the run on that would be the "check that fails correct
 * work" trap wearing a new hat.
 */
export function parseRefuteVerdict(text) {
  const lines = String(text ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (/^REFUTED\s*:/i.test(last)) {
    const reason = last.replace(/^REFUTED\s*:\s*/i, '').trim();
    // A refutation with no reason is an assertion, and an assertion is not evidence.
    if (reason.length < 12) return { refuted: false, reason: '', unclear: true, note: `the refuter answered "${last}" with no reason, so nothing was proven` };
    return { refuted: true, reason };
  }
  if (/^NOT\s+REFUTED\s*:/i.test(last)) {
    return { refuted: false, reason: last.replace(/^NOT\s+REFUTED\s*:\s*/i, '').trim() };
  }
  return { refuted: false, reason: '', unclear: true, note: 'the refuter did not end with a verdict line, so its answer decides nothing' };
}

/**
 * Run the second opinion.
 *
 * @param {object} args
 * @param {string} args.task     what the first agent was asked to do
 * @param {string} args.claim    what it says it did
 * @param {object} args.executor
 * @param {object} args.config
 * @param {number} [args.budgetUsd]  the refuter's ceiling — normally the parent's remainder
 * @param {Function} [args.sessionImpl] injected for tests
 */
export async function refuteClaim({
  task, claim, executor, config, budgetUsd = null, fleetGate = null,
  maxRounds = DEFAULT_REFUTE_ROUNDS, commandTimeoutMs, onEvent, sessionImpl = null,
} = {}) {
  if (!task || !String(task).trim()) {
    return { ok: false, error: 'a second opinion needs the original task — without it there is no claim to test' };
  }
  const run = sessionImpl ?? (await import('./turn.mjs')).runSession;
  const rounds = Math.min(Math.max(1, Math.floor(maxRounds) || DEFAULT_REFUTE_ROUNDS), MAX_REFUTE_ROUNDS);

  let outcome;
  try {
    outcome = await run({
      task: refutePrompt({ task, claim }),
      executor,
      config,
      maxRounds: rounds,
      /**
       * ⚠️ `allowRun` TRUE, and it is the point. The strongest refutation
       * available is a command that fails, and a reviewer that can only read is
       * reduced to opinion — which this prompt explicitly refuses to accept.
       */
      allowRun: true,
      toolNames: [...REFUTER_TOOL_NAMES],
      budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : null,
      fleetGate,
      commandTimeoutMs,
      onEvent,
    });
  } catch (err) {
    // ⚠️ A dead refuter must not fail work that may be perfectly good.
    return { ok: false, error: `the second opinion crashed: ${err?.message ?? String(err)}`, costUsd: 0 };
  }

  const usage = outcome?.usage ?? null;
  const costUsd = Number.isFinite(usage?.cost) ? usage.cost : 0;
  if (!outcome || outcome.ok !== true) {
    return { ok: false, error: outcome?.error ?? 'the second opinion returned nothing', costUsd };
  }

  const verdict = parseRefuteVerdict(outcome.content ?? outcome.note ?? '');
  return { ok: true, ...verdict, costUsd, roundsUsed: outcome.roundsUsed ?? 0 };
}

/** One line for the person watching, and it must not overclaim either way. */
export function formatRefutation(result) {
  if (!result?.ok) return `second opinion unavailable: ${result?.error ?? 'unknown'}`;
  if (result.refuted) return `✖ SECOND OPINION REFUTES IT — ${result.reason}`;
  if (result.unclear) return `· second opinion reached no verdict — ${result.note}. The first verdict stands unchanged.`;
  return `✔ second opinion could not refute it${result.reason ? ` — checked: ${result.reason}` : ''}`;
}
