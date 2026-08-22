/**
 * ── ⚠️⚠️⚠️ THE CLI COULD NOT CHANGE A FILE IN A REAL TERMINAL ───────────────
 *
 * Measured 2026-08-19. `runSession` built its write approver with
 * `budgetedAsker(mcpAsk)` — an asker that returns an OBJECT, because it wraps
 * the model's `ask_user` TOOL and has to carry a refusal reason back to the
 * model. `interpretAnswer` takes a STRING.
 *
 *   String({ ok: true, answer: 'y' })  ===  '[object Object]'
 *
 * which matches none of y/a/n/q and falls through to the closing
 * `return { decision: 'reject' }`. **The user typed `y`, the write was
 * declined**, the model was told not to retry, and the run ended
 * "No files changed."
 *
 * ⭐⭐ WHY 3,600 GREEN TESTS NEVER SAW IT — and this is the part worth keeping:
 *
 *   1. With no TTY the gate FAILS OPEN (`diff-preview.mjs`), so CI, pipes and
 *      `--parallel` never reach the broken line. The suite runs headless.
 *   2. Every existing write-approval test injects a raw string asker straight
 *      into `createWriteApprover`. They test the UNIT perfectly and never build
 *      the composition production builds.
 *
 * ⚠️ **A test that constructs its own collaborators cannot see a wiring
 * defect.** That is the whole lesson, and it is why this file asserts the
 * PAIRING rather than the behaviour of either side.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { budgetedAsker } from '../lib/ask-user.mjs';
import { interpretAnswer, approvalPrompt } from '../lib/diff-preview.mjs';
import { createWriteApprover } from '../lib/write-approval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TURN = readFileSync(join(HERE, '..', 'lib', 'turn.mjs'), 'utf8');
/** Comments stripped: a guard that greps source otherwise matches the comment explaining the fix. */
const TURN_CODE = TURN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── the contract mismatch itself ────────────────────────────────────────────

test('⚠️⚠️ interpretAnswer on a budgetedAsker result is a REJECTION', async () => {
  /**
   * The bug, reproduced from the two real modules. If this ever stops being a
   * rejection someone changed one of the two contracts, and the wiring
   * assertion below needs re-reading rather than trusting.
   */
  const asker = budgetedAsker(async () => 'y');
  const result = await asker('Apply changes to app.js?');

  assert.equal(typeof result, 'object', 'budgetedAsker no longer returns an object — re-check the wiring below');
  assert.equal(interpretAnswer(result).decision, 'reject');
  assert.equal(interpretAnswer('y').decision, 'approve');
});

// ── the wiring, which is what actually broke ────────────────────────────────

test('⚠️⚠️⚠️ runSession passes the RAW asker to createWriteApprover', () => {
  /**
   * `ask: askUser` was the entire defect. `askUser` is `budgetedAsker(mcpAsk)`;
   * the approver needs `mcpAsk` itself.
   */
  const call = /createWriteApprover\(\{\s*ask:\s*([A-Za-z_$][\w$]*)/.exec(TURN_CODE);
  assert.ok(call, 'could not find the createWriteApprover call in turn.mjs — this guard is blind');
  assert.equal(
    call[1],
    'mcpAsk',
    `createWriteApprover receives \`${call[1]}\`. It must receive the RAW asker (mcpAsk): a budgeted asker `
    + 'returns an object, interpretAnswer stringifies it to "[object Object]", and every interactive write is refused.',
  );
});

test('⭐ and budgetedAsker is still used for the model-facing ask_user tool', () => {
  // The fix must not delete the budget — it belongs to the MODEL's questions,
  // just not to a system-initiated write approval. Removing it entirely would
  // let the model interrogate the user without limit.
  assert.match(TURN_CODE, /budgetedAsker\(mcpAsk\)/, 'the ask_user budget was removed rather than re-pointed');
});

test('⭐ the other two consumers already took the raw asker', () => {
  // `checkMcpConsent` and the acceptance prompt were always correct, which is
  // why this looked like a working system: two of three call sites were right.
  assert.match(TURN_CODE, /ask:\s*mcpAsk/);
  assert.match(TURN_CODE, /acceptanceAsk:\s*mcpAsk/);
});

// ── end to end through the real approver ────────────────────────────────────

test('⚠️⚠️ END TO END: a human typing `y` gets the write APPLIED', async () => {
  /**
   * The composition production builds, with the only substitution being the
   * terminal itself. Before the fix this asserted `allowed === false`.
   */
  const { approve } = createWriteApprover({
    ask: async () => 'y',          // a real terminal hands back a string
    isInteractive: true,
    env: {},
  });
  const verdict = await approve({ path: 'app.js', before: 'a', after: 'b', exists: true });
  assert.equal(verdict.allowed, true, 'a human typed y and the write was still refused');
  assert.equal(verdict.reviewed, true);
});

test('⭐ and typing `n` still refuses — the gate is not simply disabled', async () => {
  // The failure mode of "fix the approval bug" is to make everything approve.
  const { approve } = createWriteApprover({
    ask: async () => 'n',
    isInteractive: true,
    env: {},
  });
  const verdict = await approve({ path: 'app.js', before: 'a', after: 'b', exists: true });
  assert.equal(verdict.allowed, false);
});

test('⚠️ an asker that returns an object is refused LOUDLY, not silently', async () => {
  /**
   * Defence in depth. If someone re-points this at a budgeted asker one day,
   * the write is still refused — but the reason must not read as "the user
   * declined", because that sends the next person to debug the human.
   */
  const { approve } = createWriteApprover({
    ask: async () => ({ ok: true, answer: 'y' }),
    isInteractive: true,
    env: {},
  });
  const verdict = await approve({ path: 'app.js', before: 'a', after: 'b', exists: true });
  assert.equal(verdict.allowed, false, 'an object answer must never be read as consent');
});

// ── ⚠️⚠️ AND YOU CAN SEE WHAT YOU ARE APPROVING ─────────────────────────────

test('⚠️⚠️ the diff is SHOWN before the question is asked', async () => {
  /**
   * Measured 2026-08-19: all 1,044 lines of `diff-preview.mjs`'s renderer —
   * `renderDiff`, `renderApproval`, `approvalPrompt` — had **zero production
   * callers**. The prompt a user actually saw was the bare fallback
   * `Apply changes to <path>?`: no diff, and no mention of `a` or `q` even
   * though `interpretAnswer` accepts both.
   *
   * ⭐ "Approve this" without showing what "this" is trains people to type `y`
   * reflexively — which is the same as having no gate, except it looks like one.
   */
  const seen = [];
  let asked = null;
  const { approve } = createWriteApprover({
    ask: async (q) => { asked = q; return 'y'; },
    isInteractive: true,
    env: {},
    show: (t) => seen.push(t),
  });

  await approve({
    path: 'math.mjs',
    before: 'export function add(a,b){\n  return a+b;\n}\n',
    after: 'export function add(a,b){\n  if (!a) throw new Error("a");\n  return a+b;\n}\n',
    exists: true,
  });

  const body = seen.join('\n');
  assert.ok(seen.length > 0, 'nothing was shown — the user approved a change they could not see');
  assert.match(body, /math\.mjs/, 'the diff does not name the file');
  assert.match(body, /@@/, 'no unified hunk header — this is not a diff');
  assert.match(body, /\+\s*if \(!a\) throw/, 'the added line is not shown');
});

test('⚠️ the prompt offers all four answers interpretAnswer accepts', () => {
  // y/n/a/q are all handled; offering two of them makes the other two secrets.
  const p = approvalPrompt('x.mjs', 'replaced');
  for (const bit of ['[y]es', '[n]o', '[a]ll', '[q]uit']) {
    assert.ok(p.includes(bit), `the prompt does not offer ${bit}: ${p}`);
  }
});

test('⭐ a NEW file is not queried at all, and that is the design', async () => {
  /**
   * ⚠️ MY FIRST VERSION OF THIS TEST ASSERTED THE WRONG THING — it expected a
   * "Create x?" prompt. A file that did not exist before is never queried:
   * `approvalDecision` only requires review when a write would REPLACE
   * something that was already there. Overwriting a person's file is the risk;
   * adding one is not, and prompting for every new file in a scaffold would
   * train people to hold down `y`.
   */
  let asked = null;
  const { approve } = createWriteApprover({
    ask: async (q) => { asked = q; return 'y'; },
    isInteractive: true,
    env: {},
    show: () => {},
  });
  const v = await approve({ path: 'new.mjs', before: null, after: 'const a = 1;\n', exists: false });
  assert.equal(asked, null, 'a brand-new file should not need approval');
  assert.equal(v.allowed, true);
  assert.equal(v.reviewed, false, 'and it must not CLAIM to have been reviewed');
});

test('⭐ the shown diff and the question come from ONE call, so they cannot disagree', async () => {
  /**
   * `renderApproval` returns `{ body, prompt }` together. Composing the prompt
   * separately is how "Delete x?" ends up printed over a diff that changes.
   */
  let asked = null;
  const seen = [];
  const { approve } = createWriteApprover({
    ask: async (q) => { asked = q; return 'y'; },
    isInteractive: true,
    env: {},
    show: (t) => seen.push(t),
  });
  await approve({ path: 'edit.mjs', before: 'a\n', after: 'b\n', exists: true });

  assert.match(seen.join('\n'), /edit\.mjs — this changes the file/);
  assert.match(asked, /Apply this change to edit\.mjs\?/,
    'the question must describe the same operation the diff shows');
});

test('⚠️ a diff that cannot be rendered still lets the write be approved', async () => {
  // A renderer that threw would turn "we could not draw this" into "your change
  // was rejected" — the worst possible trade for a display feature.
  const { approve } = createWriteApprover({
    ask: async () => 'y',
    isInteractive: true,
    env: {},
    show: () => { throw new Error('terminal exploded'); },
  });
  const v = await approve({ path: 'a.mjs', before: 'x', after: 'y', exists: true });
  assert.equal(v.allowed, true, 'a display failure refused a write');
});
