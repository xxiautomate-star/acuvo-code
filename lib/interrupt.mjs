/**
 * ── ⭐⭐ THE FIRST CTRL-C ASKS; THE SECOND ONE INSISTS ───────────────────────
 *
 * Today Ctrl-C kills the process outright, and a killed run loses its SESSION
 * and its AUDIT LINE — so the run a user most wants to resume is the one that
 * leaves nothing behind. That is the worst possible moment to lose everything:
 * they interrupted because something was going wrong, and now there is no
 * transcript to look at and no record it ever ran.
 *
 * ⭐ So the first press asks the loop to stop at the end of its round — the
 * transcript saves, the cost is recorded, the changes are reported, `--resume`
 * works. The second press is the escape hatch, because a user who presses twice
 * has stopped negotiating and a tool that ignores that is broken.
 *
 * ── ⚠️⚠️ WHY THIS IS A SHARED POLICY AND NOT A SIXTH LISTENER ───────────────
 *
 * FIVE modules already register `SIGINT` — background, lsp, repl, tsserver and
 * turn — and each does `cleanup(); process.exit(code)`. Node runs listeners in
 * registration order, so whichever fires first exits, and a sixth listener that
 * merely wanted to be polite would be overruled by whichever of the five
 * happened to be loaded. Their cleanup is not optional either: it reaps real
 * child processes, and this package has already found two true orphans on this
 * machine.
 *
 * ⭐ So they keep their cleanup and consult `exitIsDeferred()` before exiting.
 * One line each, and the ownership stays where the children are.
 *
 * ── ⚠️ THE RULES THIS FILE MUST NOT BREAK, ALL LEARNED ALREADY ──────────────
 *
 *   · A SIGINT listener SUPPRESSES Node's default terminate-on-Ctrl-C. So a
 *     path that neither aborts nor exits leaves Ctrl-C doing nothing at all,
 *     which is a worse bug than the one being fixed.
 *   · Exit is 128+n, never 1. `bin/acuvo.mjs` spends 1 on "the code it wrote
 *     still does not pass"; an interrupt is a different answer to a different
 *     question and a script that cannot tell them apart retries the wrong one.
 *   · With NO graceful handler registered, behaviour is exactly as before —
 *     immediate exit. Every existing caller is unchanged.
 *
 * Zero dependencies, no timers, no I/O.
 */

/** The handler to call on a first interrupt, or null when nobody is listening. */
let graceful = null;
/** True once a first interrupt has been honoured, so the next one is fatal. */
let asked = false;
/**
 * ── ⚠️⚠️ ONE KEYPRESS, MANY LISTENERS, AND THE ANSWER MUST NOT CHANGE ───────
 *
 * THE DEFECT THIS EXISTS TO CLOSE, found by refutation and reproduced on the
 * real CLI: `asked` was consumed once per PROCESS, and Node invokes EVERY
 * SIGINT listener for a SINGLE delivery, synchronously, in registration order.
 * So with two listeners the first press did the graceful abort AND THEN DIED —
 * listener one deferred and printed "stopping after this round", listener two
 * saw `asked === true`, read that as "second press", and called
 * `process.exit()` on the spot. No summary, no session, no audit line, no
 * `--resume`. Strictly worse than the bug this file was written to fix, because
 * the old behaviour at least did not print a promise it then broke.
 *
 * ⚠️ AND TWO LISTENERS IS THE ORDINARY CASE, not a corner. `turn.mjs` installs
 * one unconditionally; `repl`, `start_process`, tsserver and LSP each install
 * another the moment the model uses that tool. ONE `repl` call was enough.
 *
 * ⭐ THE FIX IS TO MAKE THE DEFERRAL PER-DELIVERY. Every listener Node invokes
 * for one signal gets the same answer, and only a genuinely LATER press — a new
 * delivery, therefore a new tick — is fatal. `process.nextTick` runs after the
 * current stack unwinds, which is after the last listener for this delivery and
 * before any subsequent signal, so it is exactly the boundary we mean.
 *
 * ⚠️ THE OLD TEST COULD NOT HAVE CAUGHT THIS. It asserted `SIGINT_LISTENERS=1`
 * as if that were a constant of the system, in the one session shape where it
 * happens to be true. A number pinned in the only configuration that satisfies
 * it is not a guard.
 */
let deferringThisDelivery = false;

/**
 * Ask to be told about the first interrupt instead of dying on it.
 *
 * @param {(reason: string) => void} handler called once, on the first signal
 * @returns {() => void} dispose — MUST be called when the run ends, or a later
 *   Ctrl-C in the same process (an interactive session runs many turns) would
 *   be swallowed by a handler belonging to a run that finished long ago.
 */
export function onFirstInterrupt(handler) {
  const fn = typeof handler === 'function' ? handler : null;
  graceful = fn;
  asked = false;
  /**
   * ⚠️ THE DISPOSE ONLY CLEARS ITS OWN REGISTRATION, and that guard is not
   * theoretical tidiness. `dispose()` lands in a `finally`, and a `finally`
   * runs LATE — if a second run has already armed itself by then (the
   * escalation ladder runs rungs back to back, and the steering loop runs
   * segments back to back), an unguarded `graceful = null` would disarm the
   * LIVE run on behalf of a dead one. The symptom would be the worst one this
   * file knows: Ctrl-C doing nothing, intermittently.
   */
  return () => { if (graceful === fn) { graceful = null; asked = false; deferringThisDelivery = false; } };
}

/**
 * Called by the five signal handlers before they exit.
 *
 * ⚠️ IT HAS A SIDE EFFECT, AND THE NAME SAYS ONLY HALF OF THAT. The first call
 * consumes the graceful chance and fires the handler; the second returns false
 * so the caller exits. It is written this way because the alternative — a
 * separate `notice()` and `shouldExit()` — is two calls that five call sites
 * would eventually get out of order.
 *
 * @param {string} [reason] what to tell the run
 * @returns {boolean} true when the caller must NOT exit
 */
export function exitIsDeferred(reason = 'you pressed Ctrl-C', { schedule = process.nextTick } = {}) {
  if (!graceful) return false;
  /**
   * ⭐ THE SAME KEYPRESS, ARRIVING AT A SECOND LISTENER. It must get the same
   * answer as the first, or the press that was honoured also kills the process.
   * Checked BEFORE `asked`, because `asked` is already true by now.
   */
  if (deferringThisDelivery) return true;
  if (asked) return false;
  asked = true;
  const fn = graceful;
  try {
    fn(reason);
  } catch {
    /**
     * ⚠️ A THROWING HANDLER MUST NOT WEDGE THE PROCESS. If the graceful path is
     * broken, the honest outcome is the old one — exit now — not a Ctrl-C that
     * does nothing because our own callback failed.
     *
     * ⚠️ AND THE WINDOW IS DELIBERATELY NOT OPENED. A handler that threw did not
     * defer anything, so the remaining listeners for this delivery must exit
     * too — telling them to hold would be the wedge this comment forbids.
     */
    return false;
  }
  deferringThisDelivery = true;
  schedule(() => { deferringThisDelivery = false; });
  return true;
}

/** Test seam: forget any registered handler. Never called in production. */
export function resetInterruptState() {
  graceful = null;
  asked = false;
  deferringThisDelivery = false;
}

/** Whether a first interrupt has already been honoured — for messaging only. */
export function interruptAlreadyRequested() {
  return asked;
}

/**
 * ── ⚠️⭐ THE EXIT CODE. 128+n, AND THE REASON IS NOT STYLE ──────────────────
 *
 * `bin/acuvo.mjs` spends exit **1** on "the code it wrote still does not pass"
 * — a VERDICT. An interrupt is a different answer to a different question, and
 * a script that cannot tell them apart retries the wrong one: it would re-run
 * the agent because a human walked away, or give up on a fixable test failure.
 * 128+SIGINT(2) = 130 is the shell convention and collides with none of this
 * package's documented 0 / 1 / 2 / 3 / 64.
 */
export const EXIT_INTERRUPTED = 130;

/**
 * ⭐ WHAT THE FIRST PRESS SAYS, IMMEDIATELY. Exported so the test asserts the
 * exact sentence the user sees rather than a paraphrase, and so the promise it
 * makes ("press again to quit now") stays wired to the code that keeps it.
 *
 * ⚠️ IT NAMES BOTH HALVES ON PURPOSE. A press that silently changed a hidden
 * flag would read as Ctrl-C being broken — which is the failure this whole file
 * exists to avoid — and a user who is not told the second press is available
 * has no way to escape a round that hangs.
 */
export const FIRST_PRESS_NOTICE =
  'stopping after this round — press Ctrl-C again to quit now';

/**
 * ── ⭐⭐ ARM ONE RUN. The ONLY thing a caller has to get right is `dispose` ──
 *
 * Turns the module's policy into the three things a run actually needs: a
 * signal to hand `runSession`, a dispose to call when the run ends, and an
 * answer to "was this run interrupted?" for the exit code.
 *
 * ⚠️ THE ABORT HAPPENS BEFORE THE NOTICE, AND THE NOTICE IS IN A `finally`.
 * Order matters twice over. Aborting first means a `notify` that throws still
 * leaves the run cancelled; the `finally` means an abort that throws still
 * tells the user what happened. `exitIsDeferred` catches a throwing handler and
 * exits instead — so the worst case here is the OLD behaviour (immediate exit),
 * never a Ctrl-C that did nothing.
 *
 * ⚠️ ALWAYS ARMED, TTY OR NOT. A `kill -INT` from a CI runner or a supervisor
 * deserves the same graceful stop as a keypress; gating on `isTTY` would make
 * the unattended fleet the one place a stop still loses the transcript.
 *
 * @param {{ notify?: (notice: string, reason: string) => void, controller?: AbortController }} [opts]
 * @returns {{ signal: AbortSignal, dispose: () => void, wasInterrupted: () => boolean }}
 */
export function armInterrupt({ notify = () => {}, controller = new AbortController() } = {}) {
  let fired = false;
  const dispose = onFirstInterrupt((reason) => {
    fired = true;
    const why = typeof reason === 'string' && reason.trim() ? reason : 'you pressed Ctrl-C';
    try {
      controller.abort(why);
    } finally {
      notify(FIRST_PRESS_NOTICE, why);
    }
  });
  return { signal: controller.signal, dispose, wasInterrupted: () => fired };
}

/**
 * ── ⭐ DID THIS RUN END BECAUSE OF THE KEYPRESS, OR MERELY DURING IT? ───────
 *
 * ⚠️ BOTH HALVES ARE REQUIRED, and dropping either one produces a wrong exit
 * code in a real case:
 *
 *   · `interrupted` alone — a press that lands while the loop is already in its
 *     LAST round leaves `stoppedBecause: 'verified'`. The run finished, the
 *     tests passed, the work is on disk. Reporting 130 there would tell a
 *     script to retry a job that succeeded.
 *   · `stoppedBecause === 'aborted'` alone — the signal is also how a lost
 *     lease or a fleet ceiling stops a run (see `abort-signal.test.mjs`, which
 *     names three distinct causes on purpose). Those are not interrupts and
 *     must keep the ordinary verdict exit.
 *
 * @param {{ interrupted?: boolean, outcome?: { stoppedBecause?: string } | null }} state
 * @returns {boolean}
 */
export function wasAbortedByInterrupt({ interrupted, outcome } = {}) {
  return interrupted === true && outcome?.stoppedBecause === 'aborted';
}
