/**
 * ── ⚠️⚠️ `--plan` SAID "READ-ONLY UNTIL APPROVED" AND ONE LOCK WAS MISSING ──
 *
 * `--help` promises, verbatim (lib/cli-args.mjs):
 *
 *   "The planning phase is offered READING TOOLS ONLY — it cannot write,
 *    run or commit while it is proposing."
 *
 * The first half of that is true and is already pinned by
 * `plan-mode-gate.test.mjs`: `planModeToolNames` intersects the run's offer
 * with `ORIENT_TOOLS`, so `write_file` is never shown. The second half — *it
 * cannot write* — was **not enforced anywhere**, and this package already
 * knows why that matters. `tools.mjs`, at `run_program`'s own guard:
 *
 *   "a model can emit a call for a tool it was never shown (a stale
 *    conversation, a resumed session, a provider that echoes an old tool
 *    list), and the flag must be enforced where the command would actually be
 *    spawned, which is the dispatcher."
 *
 * ⭐ THE RUN HALF FOLLOWED THAT RULE. The proposal phase passes `allowRun:
 * false` (bin/acuvo.mjs), and `executeToolCall` refuses `run_command`,
 * `run_program`, `evaluate`, `repl`, `start_process`, `git_commit`,
 * `git_branch`, `git_push` and `check_acceptance` at the dispatcher whatever
 * the offer said. That half was already belt-and-braces.
 *
 * ⚠️⚠️ THE WRITE HALF HAD NO BRACES AT ALL. `executeToolCall` is a `switch` on
 * the tool NAME; `case 'write_file'` calls `executor.writeFile` with nothing
 * between them, and `allowRun` is not consulted because a write starts no
 * process. So a `write_file` call arriving during the proposal phase — from a
 * resumed transcript, a provider echoing yesterday's tool list, or a model
 * that simply guessed the name — landed on disk, in the phase whose entire
 * promise is that nothing lands on disk. Measured here, end to end, before
 * the fix (see the first two tests: they were RED, with the file present and
 * its bytes readable).
 *
 * The same hole covered `write_files`, `edit_file`, `delete_file` and
 * `move_file` — every verb in the dispatcher that reaches `executor.*` — and,
 * through `case 'delegate'`, everything a subagent handed the same executor
 * could do.
 *
 * ── ⭐ THE FIX IS THE EXECUTOR, NOT A SENTENCE IN THE PROMPT ─────────────────
 *
 * `planPhaseTask` already tells the model it is read-only. That is
 * reachability, not a gate: this repo's standing rule is that a gate the model
 * can talk its way past is not a gate. So the proposal phase now runs against
 * `planPhaseExecutor(executor)` — the same object with `writeFile`,
 * `deleteFile` and `moveFile` replaced by refusals. Every write verb in the
 * dispatcher goes through one of those three, including the ones a subagent
 * would use, so the refusal is structural and cannot be routed around by
 * naming a tool that was never offered.
 *
 * ⭐ $0.00 — every model call here is a scripted stub, every write is a temp
 * directory, and nothing touches the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { executeToolCall, toolNamesForRounds } from '../lib/tools.mjs';
import { planModeToolNames, planModeRounds } from '../lib/plan-coherence.mjs';
import { planPhaseExecutor, PLAN_PHASE_REFUSAL } from '../lib/cli-args.mjs';

const config = { apiKey: 'test-key', model: 'stub/requested-model' };

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * ⚠️ COMMENTS STRIPPED. `bin/acuvo.mjs` now EXPLAINS this wiring at length, so
 * a grep over the raw source would match the paragraph describing the fix and
 * pass with the fix deleted — the check-that-cannot-fail this repo has already
 * paid for. Measured while writing this: with the call removed but the comment
 * left in place, the raw-source version of this assertion still passed.
 */
const CLI_CODE = readFileSync(join(HERE, '..', 'bin', 'acuvo.mjs'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-planro-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return dir;
}

/**
 * A model that emits the scripted tool calls, one round at a time.
 *
 * ⚠️ IT EMITS NAMES IT WAS NEVER OFFERED, ON PURPOSE. That is the whole
 * counterexample: narrowing the OFFER is the belt, and this fixture is the
 * stale transcript / echoed tool list the braces exist for. A fixture that
 * only called offered tools could never have found this.
 */
function scriptedModel(rounds) {
  let i = 0;
  return async () => {
    const calls = rounds[i] ?? [];
    i += 1;
    if (calls.length === 0) return { ok: true, content: 'THE PLAN\n1. edit app.js', toolCalls: [], usage: null, finishReason: 'stop' };
    return {
      ok: true,
      content: 'proposing',
      model: 'stub/answering-model',
      toolCalls: calls.map((c, n) => ({
        id: `c${i}_${n}`,
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
      usage: null,
      finishReason: 'tool_calls',
    };
  };
}

/**
 * ⚠️ THE OPTIONS THE PROPOSAL PHASE ACTUALLY USES, COPIED FROM bin/acuvo.mjs.
 * Inventing a plausible-looking set here would test a phase that does not
 * exist — the defect lived in the exact combination `--plan` passes.
 */
function planPhaseOptions(root, { readOnlyExecutor }) {
  const rounds = planModeRounds(24);
  const offer = planModeToolNames(toolNamesForRounds(rounds, { allowRun: false, root, interactive: false }));
  assert.equal(offer.ok, true, offer.ok === false ? offer.error : '');
  const base = createLocalExecutor(root);
  return {
    executor: readOnlyExecutor ? planPhaseExecutor(base) : base,
    maxRounds: rounds,
    allowRun: false,
    toolNames: offer.names,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE COUNTEREXAMPLE, END TO END
 * ══════════════════════════════════════════════════════════════════════════ */

test('⚠️⚠️ a write_file the plan phase never offered must NOT reach disk', async (t) => {
  const root = workspace(t);
  const phase = planPhaseOptions(root, { readOnlyExecutor: true });

  /**
   * ⭐ THE OFFER IS CHECKED FIRST, so this test cannot pass vacuously by the
   * model being unable to name the tool. `write_file` is genuinely absent from
   * the offer AND the call is made anyway — which is the real-world case.
   */
  assert.equal(phase.toolNames.includes('write_file'), false, 'the premise moved: the plan offer now shows write_file');

  const outcome = await runSession({
    task: 'PLAN MODE — propose how to add a healthcheck route',
    config,
    onEvent: () => {},
    callModelImpl: scriptedModel([
      [{ name: 'write_file', args: { path: 'pwned.txt', content: 'the proposal phase wrote this' } }],
      [],
    ]),
    ...phase,
  });

  const rec = outcome.executed.find((e) => e.name === 'write_file');
  assert.ok(rec, 'the scripted call never reached the dispatcher — this fixture is not exercising the path');

  /**
   * ⭐ THE ASSERTION THAT MATTERS IS THE DISK, NOT THE RESULT OBJECT. An error
   * string is cheap and can be bolted on after a write has already happened;
   * the absence of the file is the fact. Before the fix this file existed and
   * `readFileSync` returned the model's bytes verbatim.
   */
  assert.equal(existsSync(join(root, 'pwned.txt')), false,
    'a --plan proposal phase wrote a file to disk before anyone approved anything');
  assert.equal(rec.result.ok, false, 'and the model must be TOLD it was refused, not left to assume it worked');
  assert.equal(rec.mutated, false, 'the run summary must not count a write that never happened');
  assert.match(rec.result.error, /plan/i, 'the refusal has to name the phase, or the model tries again all four rounds');
});

test('⚠️⚠️ and neither may edit_file, delete_file, move_file or write_files', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'app.js'), 'const a = 1;\n');
  writeFileSync(join(root, 'doomed.js'), 'delete me\n');
  const phase = planPhaseOptions(root, { readOnlyExecutor: true });

  const outcome = await runSession({
    task: 'PLAN MODE — propose a refactor',
    config,
    onEvent: () => {},
    callModelImpl: scriptedModel([
      [
        { name: 'edit_file', args: { path: 'app.js', old_string: 'const a = 1;', new_string: 'const a = 2;' } },
        { name: 'delete_file', args: { path: 'doomed.js' } },
        { name: 'move_file', args: { from: 'app.js', to: 'moved.js' } },
        { name: 'write_files', args: { files: [{ path: 'batch.txt', content: 'batched' }] } },
      ],
      [],
    ]),
    ...phase,
  });

  assert.equal(readFileSync(join(root, 'app.js'), 'utf8'), 'const a = 1;\n', 'edit_file changed a file during a proposal');
  assert.equal(existsSync(join(root, 'doomed.js')), true, 'delete_file removed a file during a proposal');
  assert.equal(existsSync(join(root, 'moved.js')), false, 'move_file renamed a file during a proposal');
  assert.equal(existsSync(join(root, 'batch.txt')), false, 'write_files wrote during a proposal');

  for (const verb of ['edit_file', 'delete_file', 'move_file', 'write_files']) {
    const rec = outcome.executed.find((e) => e.name === verb);
    assert.ok(rec, `${verb} never reached the dispatcher`);
    assert.equal(rec.result.ok, false, `${verb} succeeded during a read-only proposal`);
    assert.equal(rec.mutated, false, `${verb} was counted as a mutation`);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. THE READS MUST STILL WORK — a gate that breaks the phase is not a fix
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐ reading, listing and searching are untouched — the phase exists to LOOK', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'app.js'), 'const answer = 42;\n');
  const phase = planPhaseOptions(root, { readOnlyExecutor: true });

  const outcome = await runSession({
    task: 'PLAN MODE — propose a change to app.js',
    config,
    onEvent: () => {},
    callModelImpl: scriptedModel([
      [{ name: 'read_file', args: { path: 'app.js' } }, { name: 'list_dir', args: { path: '.' } }],
      [],
    ]),
    ...phase,
  });

  const read = outcome.executed.find((e) => e.name === 'read_file');
  assert.equal(read.result.ok, true, `reading was broken by the write gate: ${read.result.error}`);
  assert.match(read.result.content, /const answer = 42;/);

  const listed = outcome.executed.find((e) => e.name === 'list_dir');
  assert.equal(listed.result.ok, true, 'listing a directory writes nothing and must stay available');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. THE WRAPPER ITSELF — pure, and provably not a pass-through
 * ══════════════════════════════════════════════════════════════════════════ */

test('⭐ planPhaseExecutor refuses the three mutating methods and forwards the rest', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.txt'), 'hello\n');
  const base = createLocalExecutor(root);
  const ro = planPhaseExecutor(base);

  assert.equal(ro.root, base.root, 'root must survive — find_files and search_text are given it directly');
  assert.equal(ro.holder, base.holder, 'the lease holder identity must survive');
  assert.equal(ro.readFile('a.txt').ok, true);
  assert.equal(ro.listDir('.').ok, true);

  /**
   * ⚠️ `dryRun` IS THE SECOND HALF OF THE WRAPPER, and it is not decoration.
   * Six verbs (speak, transcribe, make_document, see_page, edit_image,
   * expand_image) are handed `executor.root` and `executor.dryRun` and write
   * through `fs` directly — the three method overrides above cannot see them.
   * They all honour `dryRun`, so this is what stops a name-guessed `speak`
   * leaving a .wav in a workspace nobody approved a change to.
   */
  assert.equal(ro.dryRun, true, 'the media verbs that bypass writeFile are only stopped by dryRun');
  assert.equal(base.dryRun, false, 'and the real executor must still be able to write once approved');

  for (const [method, callIt] of [
    ['writeFile', () => ro.writeFile('b.txt', 'x')],
    ['deleteFile', () => ro.deleteFile('a.txt')],
    ['moveFile', () => ro.moveFile('a.txt', 'c.txt')],
  ]) {
    const r = callIt();
    assert.equal(r.ok, false, `${method} was allowed through the read-only executor`);
    assert.equal(r.error, PLAN_PHASE_REFUSAL, `${method} refused with a different sentence — one refusal, one wording`);
  }

  // ⭐ And the disk agrees with the return values.
  assert.equal(existsSync(join(root, 'b.txt')), false);
  assert.equal(existsSync(join(root, 'c.txt')), false);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'hello\n');

  // ⚠️ The ORIGINAL executor must be untouched — the wrapper is a new object,
  // not a mutation of the one the approved run is about to use.
  assert.equal(base.writeFile('b.txt', 'x').ok, true, 'the wrapper mutated the real executor, so the approved run cannot write either');
  assert.equal(existsSync(join(root, 'b.txt')), true);
});

test('⭐ the refusal sentence names the phase AND the way through', () => {
  assert.match(PLAN_PHASE_REFUSAL, /plan/i, 'a model that is not told which mode it is in retries every round');
  assert.match(PLAN_PHASE_REFUSAL, /approv/i, 'and it must name the thing that unblocks it — a human approval');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. THE WIRING — the half a unit test structurally cannot see
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️⚠️ EVERY TEST ABOVE BUILDS ITS OWN PLAN-PHASE OPTIONS, and a test that
 * constructs its own collaborators cannot see a wiring defect
 * (`write-approval-wiring.test.mjs` is this package's written-up case of
 * exactly that). `bin/acuvo.mjs` calls `main()` at module scope, so it cannot
 * be imported without running the CLI — which is why this reads the source.
 */
test('⚠️⚠️ bin/acuvo.mjs actually HANDS the proposal phase the read-only executor', () => {
  assert.match(CLI_CODE, /import \{ parseArgv, USAGE, planPhaseExecutor \} from '\.\.\/lib\/cli-args\.mjs'/,
    'the lock is not even imported by the only file that can install it');

  const start = CLI_CODE.indexOf('if (opts.plan)');
  assert.ok(start > 0, 'the --plan block moved or was renamed — re-read this file before trusting it');
  const block = CLI_CODE.slice(start, start + 2_000);

  assert.match(block, /executor:\s*planPhaseExecutor\(executor\)/,
    'the proposal phase still runs against the WRITABLE executor — the counterexample is back');
  // ⭐ And the two locks that were already right must not have been dropped
  // while adding the third; all three belong to the same `oneTurn` call.
  assert.match(block, /allowRun:\s*false/, 'the run lock went missing');
  assert.match(block, /toolNames:\s*readOnly\.names/, 'the offer lock went missing');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. THE RUN HALF — a regression guard for the lock that was already right
 * ══════════════════════════════════════════════════════════════════════════ */

test('⚠️ the proposal phase also refuses run verbs at the dispatcher — belt (offer) and braces (allowRun)', async (t) => {
  const root = workspace(t);
  const ro = planPhaseExecutor(createLocalExecutor(root));

  const call = (name, args) => executeToolCall(
    { id: 'c', function: { name, arguments: JSON.stringify(args) } },
    ro,
    { allowRun: false },
  );

  const cmd = await call('run_command', { command: 'echo hi' });
  assert.equal(cmd.result.ok, false, 'a proposal must not run a command');

  const commit = await call('git_commit', { message: 'nope' });
  assert.equal(commit.result.ok, false, 'a proposal must not commit');
});
