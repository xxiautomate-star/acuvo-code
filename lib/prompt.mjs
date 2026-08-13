/**
 * ── ⚠️⚠️ THIS PACKAGE HAS A TERMINAL AND NEVER ONCE USED IT TO ASK ───────────
 *
 * `turn.mjs` takes `mcpAsk` (the question-asker) and `mcpInteractive` (whether
 * anybody is there). Measured 2026-08-13: **three references in the whole
 * package, all three inside `turn.mjs`, and no caller anywhere supplies
 * either.** `mcpAsk` was permanently `null` and `mcpInteractive` permanently
 * `false`.
 *
 * ⭐ The good news first: `mcp-consent.mjs` FAILS CLOSED on a null asker, so
 * this was never a security hole — nothing was ever silently approved.
 *
 * ⚠️ The bad news is reach. `checkMcpConsent` refuses whenever it cannot ask,
 * so a committed `.mcp.json` could never be approved from a terminal at all;
 * the only way through was `ACUVO_TRUST_MCP=1`. The two-way MCP story — *be
 * drivable by agents and able to drive every MCP server* — was gated behind an
 * environment variable, on a question the user was standing right there to
 * answer. Same defect shape as `isPolicyProtectedPath` and `parseAuditLog`
 * before it: correct code, zero callers.
 *
 * ── ⚠️ WHY A NEW INTERFACE PER QUESTION, AND WHY IT IS CLOSED IMMEDIATELY ────
 *
 * `readline` holds the event loop open. This package has already lost a day to
 * exactly that: a REPL session kept its owner's loop alive, so the `'exit'`
 * hook that would have cleaned it up could never fire, and the suite did not
 * run slowly — it HUNG. A long-lived interface here would reintroduce that in
 * the one code path every run touches.
 *
 * So the interface is created for a single question and closed in a `finally`.
 * A question is a rare, human-speed event; the cost of building a readline is
 * nothing beside a person reading a prompt, and "cannot possibly outlive the
 * question" is worth far more than the microseconds.
 *
 * ── ⚠️ AND "NOBODY IS THERE" MUST BE AN ANSWER, NOT A HANG ──────────────────
 *
 * In CI, in a pipe, under a task runner, there is no one to type. An agent that
 * blocks forever waiting for input it will never receive is worse than one that
 * cannot ask at all, because it fails by TIMEOUT — the least legible failure
 * there is, and the one that burns a whole CI job to tell you nothing.
 *
 * `isInteractive()` requires BOTH streams to be TTYs, and every asker returns
 * `null` the moment the stream ends. `null` means "no answer exists", which the
 * caller is expected to treat as a refusal — never as a yes.
 */

import { createInterface } from 'node:readline';

/**
 * Is there a human at both ends?
 *
 * ⚠️ BOTH, not either. `acuvo … < answers.txt` has a TTY stdout and a piped
 * stdin — nobody is typing, but a prompt would still be printed and then
 * answered by whatever the next line of the file happened to be. And
 * `acuvo … | tee log` has a TTY stdin and a piped stdout, where the question
 * scrolls into a file the user is not watching while the run waits. Requiring
 * both is the only combination that means "a person can see the question and
 * answer it".
 */
export function isInteractive({ input = process.stdin, output = process.stdout } = {}) {
  return Boolean(input?.isTTY && output?.isTTY);
}

/**
 * One question, one answer, no residue.
 *
 * Returns the trimmed answer, or `null` when the stream ended before one
 * arrived (Ctrl-D, a pipe running dry, a closed terminal).
 *
 * @param {string} question  printed verbatim — the caller owns the wording
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [opts]
 * @returns {Promise<string|null>}
 */
export async function askOnce(question, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output, terminal: false });
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      /**
       * ⚠️ 'close' RESOLVES null RATHER THAN LEAVING THE PROMISE PENDING. A
       * pipe that runs out mid-question fires 'close' and never calls back, so
       * without this the await never returns and the process hangs holding a
       * question nobody will answer. Found the same way in `chat.mjs`, where
       * the next `rl.question()` threw ERR_USE_AFTER_CLOSE.
       */
      rl.once('close', () => done(null));
      rl.question(question, (answer) => done(String(answer ?? '').trim()));
    });
  } finally {
    // Unconditional: an interface that outlives its question holds the loop.
    try { rl.close(); } catch { /* already closed by the 'close' path above */ }
  }
}

/**
 * The asker `turn.mjs` wants, or `null` when there is nobody to ask.
 *
 * ⭐ RETURNING `null` WHEN NON-INTERACTIVE IS THE POINT, not a convenience.
 * `checkMcpConsent` tests `typeof ask !== 'function'` and refuses, so handing
 * it a function that always answers "" would convert an honest "there is no
 * terminal here" into a silent no — the same refusal with a worse explanation.
 * Absence has to stay absence.
 *
 * @returns {null | ((question: string) => Promise<string|null>)}
 */
export function createAsker({ input = process.stdin, output = process.stdout } = {}) {
  if (!isInteractive({ input, output })) return null;
  return (question) => askOnce(question, { input, output });
}
