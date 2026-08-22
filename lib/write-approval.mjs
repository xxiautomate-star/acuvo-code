/**
 * ── ⭐⭐ THE PER-RUN HALF OF WRITE APPROVAL ─────────────────────────────────
 *
 * `diff-preview.mjs` is complete and was reachable from nothing. Its own running
 * list entry says exactly what was missing, and it is only this:
 *
 *   > `executeToolCall` "is a pure switch over a single call and has no memory of
 *   > the round before it", and `approvalDecision` needs two facts that span
 *   > rounds — `createdThisRun` (so the agent revising its own draft is never
 *   > queried) and `sessionApproved` (the "all remaining" answer).
 *
 * So this file is the memory, and nothing else. All the judgement — what counts
 * as risky, what a diff looks like, what the prompt says — already lives in
 * `diff-preview.mjs` and is not duplicated here.
 *
 * ── ⚠️ THE GATE IS ON THE MODEL'S DOOR, NOT IN THE EXECUTOR ─────────────────
 * `tools.mjs` states the rule for the credential guard and it applies verbatim:
 * *"THE GUARD IS HERE, ON THE MODEL'S DOOR, NOT IN THE EXECUTOR … a model-facing
 * refusal pushed down into shared plumbing broke seven tests of legitimate
 * internal work."* Approval is a model-facing refusal. Hooking
 * `workspace.writeFile` would gate `--doctor`, checkpoint restores and the
 * acceptance harness too — none of which is a model asking to change your files.
 *
 * ── ⚠️⚠️ AND IT NEVER BLOCKS AN UNATTENDED RUN ─────────────────────────────
 * `diff-preview.mjs`'s header settles this and the reasoning is inherited whole:
 * a gate that breaks CI, `--parallel` and the fleet gets globally disabled with
 * `ACUVO_APPROVE=never` in a shell profile, and then it protects nobody on the
 * laptop either. With no terminal there is nobody to ask, so the write proceeds
 * and the decision says so. **This is a review affordance, not a fifth lock** —
 * the write is already confined by `resolveInWorkspace`, `WRITE_FORBIDDEN_ROOTS`,
 * `MAX_WRITE_BYTES` and `policy.requireDryRun` before it ever reaches here.
 */
import {
  approvalDecision, approvalMode, interpretAnswer,
  diffUnified, renderApproval, approvalPrompt, previewLineCap,
} from './diff-preview.mjs';

/**
 * Build the per-run approver. One per turn; the closure IS the memory.
 *
 * @param {object} opts
 * @param {(question: string) => Promise<string>|string} [opts.ask] the existing
 *   asker seam. Absent = unattended, and every write settles unreviewed.
 * @param {boolean} [opts.isInteractive]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string|null} [opts.flag] `--yes` / `--approve=<mode>` if given.
 * @returns {{ approve: (write: object) => Promise<object>, noteCreated: (path: string) => void, state: object }}
 */
/**
 * ── ⚠️⚠️⚠️ PEOPLE WERE APPROVING CHANGES THEY COULD NOT SEE ─────────────────
 *
 * Measured 2026-08-19: all 1,044 lines of `diff-preview.mjs`'s renderer —
 * `renderDiff`, `renderApproval`, `approvalPrompt` — had **zero production
 * callers**. The prompt a user actually got was the bare fallback
 * `Apply changes to <path>?`, with no diff and no mention of `a` or `q`, even
 * though `interpretAnswer` accepts all four.
 *
 * ⭐ THE DIFF IS THE PRODUCT HERE. Claude Code's primary output is the diff;
 * "approve this" without showing what "this" is trains people to type `y`
 * reflexively, which is the same as having no gate at all — worse, because it
 * looks like one.
 */
export function createWriteApprover({
  ask = null, isInteractive = false, env = process.env, flag = null,
  /**
   * Where the diff is printed. STDERR by default, deliberately: stdout is the
   * `--json` contract, and a review that corrupted a machine-readable document
   * would be a worse bug than the one this fixes.
   */
  show = (text) => process.stderr.write(`${text}
`),
  paint = null,
} = {}) {
  /**
   * ⚠️ `approvalMode` RETURNS `{ ok, mode, from }`, NOT A STRING — and passing the
   * object straight through silently disabled the feature: `approvalDecision`
   * compares `mode === 'never'`, an object never matches, so `ACUVO_APPROVE=never`
   * kept prompting. Caught by its own test, which is the only reason it is not
   * still doing that.
   */
  const { mode } = approvalMode({ env, flag });
  /** Files this run brought into existence. Revising your own draft is not a change to REVIEW. */
  const createdThisRun = new Set();
  const state = { sessionApproved: false, asked: 0, approved: 0, refused: 0 };

  /**
   * ⚠️ A PATH IS RECORDED AS "OURS" ONLY WHEN IT DID NOT EXIST BEFORE. Recording
   * every written path would mean the second edit of a file the user wrote is
   * treated as our own draft and never queried — which is precisely the review
   * this exists to perform.
   */
  const noteCreated = (path) => {
    const p = String(path ?? '').trim();
    if (p) createdThisRun.add(p);
  };

  const approve = async (write) => {
    const decision = approvalDecision(write, {
      mode,
      interactive: Boolean(isInteractive && ask),
      createdThisRun,
      sessionApproved: state.sessionApproved,
    });

    // Nothing to ask, or nobody to ask. `diff-preview` has already encoded which.
    if (!decision.required || !decision.satisfiable || typeof ask !== 'function') {
      return { ...decision, allowed: true };
    }

    state.asked += 1;

    /**
     * ⭐⭐ SHOW THE CHANGE BEFORE ASKING ABOUT IT. `diffUnified` refuses to
     * render something enormous and says so rather than printing 40,000 lines
     * into a terminal, so the cap is its problem, not ours.
     *
     * ⚠️ NEVER FAILS THE WRITE. A renderer that threw would turn "we could not
     * draw this" into "your change was rejected", which is the worst possible
     * trade for a display feature.
     */
    const kind = write?.kind
      ?? (write?.after === null || write?.after === undefined ? 'deleted'
        : (write?.before === null || write?.before === undefined ? 'created' : 'replaced'));
    /**
     * ⭐ `renderApproval` HANDS BACK BOTH HALVES — `{ body, prompt }` — so the
     * diff and the question it belongs to cannot drift apart. Composing the
     * prompt separately here is how a change ends up shown beside the wrong
     * verb: "Delete" printed over a diff that creates.
     */
    let question = null;
    try {
      const diff = diffUnified(write?.before ?? '', write?.after ?? '', write?.path ?? '', {});
      const rendered = renderApproval(diff, decision, {
        cap: previewLineCap({ env }),
        path: write?.path ?? '',
        ...(paint ? { paint } : {}),
      });
      if (rendered?.body) show(rendered.body);
      question = rendered?.prompt ?? null;
    } catch { /* a diff we cannot draw is not a reason to refuse a write */ }

    let answer;
    try {
      answer = await ask(decision.prompt ?? question ?? approvalPrompt(write?.path ?? '', kind));
    } catch {
      /**
       * ⚠️ AN ASKER THAT THROWS MEANS NOBODY ANSWERED, NOT "NO". A closed pipe
       * mid-run must not turn into a refusal that looks like the user vetoing
       * the work — that is the least legible failure available, because the
       * agent then reports being blocked by a person who was never there.
       */
      return { ...decision, allowed: true, reviewed: false, reason: 'nobody could be asked, so the write proceeded' };
    }

    /**
     * ⚠️ FOUR OUTCOMES, NOT TWO, and `diff-preview.mjs` owns the vocabulary:
     * `approve` · `approve-all` · `reject` · `abort`. Collapsing them to a
     * boolean here would lose the two that matter most — `approve-all` is what
     * stops the prompt firing forty times, and `abort` means STOP THE RUN rather
     * than "skip this file", which the agent must not treat as a retryable no.
     */
    const verdict = interpretAnswer(answer);
    if (verdict.decision === 'approve-all') state.sessionApproved = true;
    const allowed = verdict.decision === 'approve' || verdict.decision === 'approve-all';
    if (allowed) state.approved += 1;
    else state.refused += 1;
    return {
      ...decision,
      allowed,
      reviewed: true,
      aborted: verdict.decision === 'abort',
      answer: verdict,
      reason: verdict.reason,
    };
  };

  /**
   * ── ⭐ THE BULK CASE: ONE QUESTION FOR THE WHOLE BATCH ─────────────────────
   *
   * ⚠️ Asking per file turns one intent — "apply this refactor" — into forty
   * prompts, and a prompt answered forty times is answered without reading by
   * the third.
   *
   * ⚠️ AND IT ASKS IF **ANY** FILE NEEDS IT, not if all of them do. A batch of
   * thirty-nine scratch files plus one rewrite of `server.js` is exactly the
   * shape a review exists to catch, and an "all" rule would wave it through.
   * The answer then governs the whole batch, which is what the person was shown.
   */
  const approveMany = async (writes) => {
    const list = Array.isArray(writes) ? writes : [];
    if (list.length === 0) return { allowed: true, required: false, reason: 'nothing to write' };

    const decisions = list.map((w) => approvalDecision(w, {
      mode,
      interactive: Boolean(isInteractive && ask),
      createdThisRun,
      sessionApproved: state.sessionApproved,
    }));
    const riskiest = decisions.find((d) => d.required && d.satisfiable);
    if (!riskiest || typeof ask !== 'function') {
      return { allowed: true, required: false, reason: 'no file in this batch needed review' };
    }

    state.asked += 1;
    let answer;
    try {
      answer = await ask(
        `${riskiest.prompt ?? 'Apply these changes?'} (${list.length} file${list.length === 1 ? '' : 's'} in this batch)`,
      );
    } catch {
      return { allowed: true, reviewed: false, reason: 'nobody could be asked, so the batch proceeded' };
    }
    const verdict = interpretAnswer(answer);
    if (verdict.decision === 'approve-all') state.sessionApproved = true;
    const allowed = verdict.decision === 'approve' || verdict.decision === 'approve-all';
    if (allowed) state.approved += 1;
    else state.refused += 1;
    return { allowed, reviewed: true, aborted: verdict.decision === 'abort', reason: verdict.reason };
  };

  return { approve, approveMany, noteCreated, state };
}

/**
 * ⭐ THE REFUSAL THE MODEL SEES. It has to read as a decision a person made, not
 * as a tool failure — otherwise the agent's next move is to retry the write,
 * which is the worst possible response to "no".
 */
export function refusedWriteResult(path) {
  return {
    ok: false,
    refused: true,
    error: `the change to ${path} was declined by the person running this. Do not retry the same write — ask what they want different, or move on to another part of the task.`,
  };
}
