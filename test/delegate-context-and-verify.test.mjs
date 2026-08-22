/**
 * ── ⚠️⚠️ `delegate` HAD NO INPUT CHANNEL AND COULD NEVER PROVE ANYTHING ──────
 *
 * Two halves of one defect, measured on the shipped code 2026-08-16:
 *
 *  1. THE HELPER RECEIVED A TASK STRING AND NOTHING ELSE. `subagent.mjs` rule 3
 *     governs what comes BACK ("distilled, never forwarded") and is right. No
 *     rule was ever written for what goes IN, so the answer was one sentence by
 *     default rather than by decision — and a helper on a four-round allowance
 *     spends two of them rediscovering what the parent worked out a minute ago,
 *     then hands back a conclusion the parent has to reconcile with its own.
 *
 *  2. `allowRun: false` IN BOTH MODES, so a builder could never check its own
 *     work. ⭐ The reason it shipped with was CORRECT and is worth restating,
 *     because it is why this was not a one-line change: *"the isolated copy has
 *     no `node_modules` … a verification command run in there would fail for a
 *     reason that has nothing to do with the code, and the parent would act on
 *     that answer."* That is an argument about the COPY. So the copy changed —
 *     `runInIsolatedCopy({ linkNodeModules: true })` links the real dependency
 *     tree in, and only then is running a command worth anything.
 *
 * ── ⚠️⚠️ WHAT THIS FILE MOSTLY DEFENDS ─────────────────────────────────────
 *
 *  · A RESEARCHER STILL RUNS NOTHING. It works against the PARENT'S executor —
 *    the real workspace, not a copy — so a command there is unsupervised
 *    execution in the user's repository to answer a question.
 *  · A PLAIN `write:true` HELPER IS BYTE-FOR-BYTE UNCHANGED: same offer, same
 *    `allowRun: false`, same unlinked copy. `subagent-write.test.mjs` pins that
 *    and must stay green.
 *  · A VERIFICATION THAT COULD NOT HAVE WORKED IS NOT REPORTED AS ONE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runSubagent,
  briefFor,
  describeVerification,
  summariseForParent,
  subagentToolSchemas,
  SUBAGENT_TOOL_NAMES,
  SUBAGENT_WRITE_TOOL_NAMES,
  SUBAGENT_VERIFY_TOOL_NAMES,
  MAX_CONTEXT_CHARS,
  MAX_SUBAGENT_ROUNDS,
} from '../lib/subagent.mjs';
import { runInIsolatedCopy } from '../lib/handoff.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { createMemoryExecutor } from '../lib/memory-workspace.mjs';
import { executeToolCall } from '../lib/tools.mjs';

function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-dcv-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

/** Records everything `runSession` was handed. */
function spySession(outcome = {}) {
  const seen = [];
  const impl = async (opts) => {
    seen.push(opts);
    return {
      ok: true, note: 'done', executed: [], roundsUsed: 1,
      usage: { cost: 0.0002, total_tokens: 300 },
      ...outcome,
    };
  };
  impl.seen = seen;
  return impl;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ HALF ONE — THE CONTEXT CHANNEL
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ no context means the task text is byte-for-byte what it always was', () => {
  /**
   * ⚠️ NOT COSMETIC. The task is the head of the helper's cacheable prefix; a
   * wrapper added unconditionally would change every existing delegation's
   * prompt and throw away its cache discount to say nothing.
   */
  for (const nothing of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(briefFor('where is slugify defined?', nothing), 'where is slugify defined?');
  }
});

test('⭐⭐ the brief travels, is marked as ESTABLISHED, and sits AFTER the question', () => {
  const brief = briefFor('write the tests for parser.mjs', 'parser.mjs exports parse() and lex(); lex is already covered.');
  assert.ok(brief.startsWith('write the tests for parser.mjs'),
    'the question must be the first thing it reads — a brief on top buries it');
  assert.match(brief, /parser\.mjs exports parse\(\) and lex\(\)/);
  assert.match(brief, /already established/i, 'unlabelled context reads as more of the task');
  assert.match(brief, /Do not spend a round re-deriving it/,
    'the whole saving is the helper NOT redoing this work — the prompt has to say so');
});

test('⚠️ a huge brief is trimmed, and the helper is TOLD it was trimmed', () => {
  /**
   * ⚠️ Without a ceiling the cheapest way for a model to "give context" is to
   * paste a file, and delegation becomes the most expensive tool in the package
   * instead of the cheapest — the exact cost it exists to avoid.
   */
  const huge = 'x'.repeat(MAX_CONTEXT_CHARS * 3);
  const brief = briefFor('do the thing', huge);
  assert.ok(brief.length < MAX_CONTEXT_CHARS + 1_000, `the brief was ${brief.length} chars — the cap did nothing`);
  assert.match(brief, /was cut here/, 'a truncated brief that claims to be complete is worse than a short one');
});

test('⭐⭐ REACH: the context a caller passes actually reaches the session\'s task', async () => {
  const run = spySession();
  await runSubagent(
    {
      task: 'which files call slugify?',
      context: 'slugify moved to lib/text.mjs last week; the old lib/slug.mjs is a re-export.',
      executor: createMemoryExecutor({}),
      config: { apiKey: 'k' },
    },
    { sessionImpl: run },
  );
  assert.equal(run.seen.length, 1);
  assert.match(run.seen[0].task, /which files call slugify\?/);
  assert.match(run.seen[0].task, /slugify moved to lib\/text\.mjs/,
    'the brief never reached the model — the channel is built and unwired, this package\'s commonest defect');
});

test('⭐⭐ REACH: `context` survives the DISPATCHER too, not just runSubagent', async () => {
  /**
   * ⚠️ THIS IS THE STEP THAT IS ACTUALLY MISSED. Every unit test of
   * `runSubagent` can pass while `tools.mjs` never forwards the argument — the
   * exact shape of the `depth + 1` defect recorded in `tools.mjs`, where
   * thirteen tests were green and the real run refused itself.
   */
  let seen = null;
  const helper = async (a) => { seen = a; return { ok: true, summary: 'ok', costUsd: 0, tokens: 0, roundsUsed: 1, files: [] }; };
  await executeToolCall(
    { id: '1', function: { name: 'delegate', arguments: JSON.stringify({ task: 'find it', context: 'the parser lives in lib/parse.mjs' }) } },
    createMemoryExecutor({}),
    { config: { apiKey: 'k' }, subagentImpl: helper },
  );
  assert.equal(seen.context, 'the parser lives in lib/parse.mjs');
});

test('the schema offers `context` and warns against pasting file contents into it', () => {
  const [schema] = subagentToolSchemas();
  const props = schema.function.parameters.properties;
  assert.equal(props.context.type, 'string');
  assert.match(props.context.description, /NOT file contents/i,
    'without this the model pastes a file and delegation costs more than doing the work inline');
  assert.match(schema.function.description, /context/);
  // ⚠️ Still ONE tool. A second one costs ~250-300 tokens on every round of
  // every run whether or not anybody uses it.
  assert.equal(subagentToolSchemas().length, 1);
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ HALF TWO — VERIFICATION
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ a RESEARCHER still runs nothing — it works in the user\'s real workspace', async () => {
  const run = spySession();
  await runSubagent(
    { task: 'where is X', verify: true, executor: createMemoryExecutor({}), config: { apiKey: 'k' } },
    { sessionImpl: run },
  );
  assert.equal(run.seen[0].allowRun, false,
    'verify without write would put an unsupervised process in the user\'s real repository to answer a question');
  assert.deepEqual(run.seen[0].toolNames, [...SUBAGENT_TOOL_NAMES]);
});

test('⚠️ a plain write:true helper is UNCHANGED — same offer, same lock, same copy', async () => {
  const root = workspace({ 'a.txt': 'x\n' });
  try {
    const run = spySession();
    let isolateArgs = null;
    await runSubagent(
      { task: 'build it', write: true, executor: createLocalExecutor(root), config: { apiKey: 'k' } },
      {
        sessionImpl: run,
        isolateImpl: async (a) => { isolateArgs = a; return { ok: true, outcome: await a.run(root), written: [], refused: [], problems: [] }; },
        makeExecutor: createLocalExecutor,
      },
    );
    assert.equal(run.seen[0].allowRun, false, 'the old lock must still hold for a helper that did not ask to verify');
    assert.deepEqual(run.seen[0].toolNames, [...SUBAGENT_WRITE_TOOL_NAMES]);
    assert.equal(run.seen[0].toolNames.includes('run_command'), false);
    assert.equal(isolateArgs.linkNodeModules, false,
      'an unlinked copy is what makes the old allowRun:false argument still true for this helper');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐⭐ write+verify unlocks run_command, links the dependencies, and spends the whole allowance', async () => {
  const root = workspace({ 'a.txt': 'x\n' });
  try {
    const run = spySession();
    let isolateArgs = null;
    await runSubagent(
      { task: 'build it and prove it', write: true, verify: true, executor: createLocalExecutor(root), config: { apiKey: 'k' } },
      {
        sessionImpl: run,
        isolateImpl: async (a) => { isolateArgs = a; return { ok: true, outcome: await a.run(root), written: [], refused: [], problems: [], dependenciesLinked: true }; },
        makeExecutor: createLocalExecutor,
      },
    );
    assert.equal(run.seen[0].allowRun, true, 'the whole point: it may run the project\'s own check');
    assert.deepEqual(run.seen[0].toolNames, [...SUBAGENT_VERIFY_TOOL_NAMES]);
    assert.equal(run.seen[0].toolNames.includes('run_command'), true);
    assert.equal(isolateArgs.linkNodeModules, true,
      'running a command in a copy with no dependencies is the wrong-reason failure the old lock existed to avoid');
    /**
     * ⚠️ WRITE → RUN → READ THE FAILURE → FIX is four rounds before it has
     * looked at anything. The DEFAULT moves; the CEILING does not.
     */
    assert.equal(run.seen[0].maxRounds, MAX_SUBAGENT_ROUNDS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ an explicit maxRounds still wins, and is still clamped by the same ceiling', async () => {
  const root = workspace({ 'a.txt': 'x\n' });
  try {
    const run = spySession();
    await runSubagent(
      { task: 't', write: true, verify: true, maxRounds: 99, executor: createLocalExecutor(root), config: { apiKey: 'k' } },
      {
        sessionImpl: run,
        isolateImpl: async (a) => ({ ok: true, outcome: await a.run(root), written: [], refused: [], problems: [], dependenciesLinked: true }),
        makeExecutor: createLocalExecutor,
      },
    );
    assert.equal(run.seen[0].maxRounds, MAX_SUBAGENT_ROUNDS, 'a helper must never outspend its ceiling because it asked to');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ the string "false" is not a yes — for verify as for write', async () => {
  const root = workspace({ 'a.txt': 'x\n' });
  try {
    const run = spySession();
    await runSubagent(
      { task: 't', write: true, verify: 'false', executor: createLocalExecutor(root), config: { apiKey: 'k' } },
      {
        sessionImpl: run,
        isolateImpl: async (a) => ({ ok: true, outcome: await a.run(root), written: [], refused: [], problems: [] }),
        makeExecutor: createLocalExecutor,
      },
    );
    assert.equal(run.seen[0].allowRun, false, 'a model emits the string "false" about once in fifty — it must not start a process');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ── what the parent is told ─────────────────────────────────────────────── */

test('⭐⭐ the verdict reaches the parent as a FACT, and silence is never success', () => {
  assert.equal(describeVerification({ ran: true, passed: true, command: 'npm test', exitCode: 0 }, { offered: false }), '',
    'a helper that was never allowed to run must not be described as unverified — it was not asked');

  const ranNothing = describeVerification({ ran: false }, { offered: true });
  assert.match(ranNothing, /nothing/i);
  assert.match(ranNothing, /unproven/i, '"the tests pass" and "no test was run" must not read identically');

  const passed = describeVerification({ ran: true, passed: true, command: 'npm test', exitCode: 0 }, { offered: true });
  assert.match(passed, /VERIFIED/);
  assert.match(passed, /npm test/);

  const failed = describeVerification({ ran: true, passed: false, command: 'npm test', exitCode: 1 }, { offered: true });
  assert.match(failed, /NOT VERIFIED/);
  assert.match(failed, /still applied/i, 'the files are on disk whatever the verdict — hiding that is the worst state');
});

test('⚠️⚠️ the verdict is APPENDED, so a chatty helper cannot squeeze it out of the summary', () => {
  /**
   * `MAX_SUMMARY_CHARS` clamps the note. A verdict folded into the note would
   * be the first thing lost to a model that likes the sound of its own voice —
   * and it is the one sentence the parent cannot do without.
   */
  const outcome = {
    ok: true,
    note: 'y'.repeat(5_000),
    executed: [],
    verification: { ran: true, passed: false, command: 'npm test', exitCode: 1 },
  };
  const summary = summariseForParent(outcome, null, { verifyOffered: true });
  assert.match(summary, /NOT VERIFIED/, 'the verdict was clamped away with the note');
});

test('⚠️⚠️ a verification that could not have worked is NOT reported as one', async () => {
  /**
   * The link failed (no node_modules, or a filesystem that refuses links), so
   * every import in the copy failed to resolve. Reporting a red `npm test` here
   * would hand the parent a verdict about the ENVIRONMENT dressed as a verdict
   * about the code — precisely the wrong-reason failure the old lock avoided.
   */
  const root = workspace({ 'a.txt': 'x\n' });
  try {
    const result = await runSubagent(
      { task: 'build it', write: true, verify: true, executor: createLocalExecutor(root), config: { apiKey: 'k' } },
      {
        sessionImpl: async () => ({
          ok: true, note: 'built and tested', executed: [], roundsUsed: 2,
          usage: { cost: 0.001, total_tokens: 900 },
          verification: { ran: true, passed: false, command: 'npm test', exitCode: 1 },
        }),
        isolateImpl: async (a) => ({ ok: true, outcome: await a.run(root), written: [], refused: [], problems: [], dependenciesLinked: false }),
        makeExecutor: createLocalExecutor,
      },
    );
    assert.match(result.summary, /no dependencies linked/i);
    assert.match(result.summary, /inconclusive/i);
    assert.equal(result.verified, null, 'an unlinked run has no verdict worth handing back as structured data');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐ a linked, passing run hands back the structured verdict too', async () => {
  const root = workspace({ 'a.txt': 'x\n' });
  try {
    const result = await runSubagent(
      { task: 'build it', write: true, verify: true, executor: createLocalExecutor(root), config: { apiKey: 'k' } },
      {
        sessionImpl: async () => ({
          ok: true, note: 'built and tested', executed: [], roundsUsed: 3,
          usage: { cost: 0.001, total_tokens: 900 },
          verification: { ran: true, passed: true, command: 'npm test', exitCode: 0 },
        }),
        isolateImpl: async (a) => ({ ok: true, outcome: await a.run(root), written: [], refused: [], problems: [], dependenciesLinked: true }),
        makeExecutor: createLocalExecutor,
      },
    );
    assert.equal(result.verified.passed, true);
    assert.match(result.summary, /VERIFIED: it ran `npm test`/);
    assert.equal(/no dependencies linked/i.test(result.summary), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️⚠️ THE LINK ITSELF — the thing that could have destroyed a real node_modules
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ the real node_modules is reachable INSIDE the copy, and SURVIVES the copy being deleted', async () => {
  /**
   * ⚠️⚠️ THIS IS THE ASSERTION THE WHOLE FEATURE HANGS ON. `runInIsolatedCopy`
   * ends with `removeDir(copyRoot, { recursive: true, force: true })`. A
   * recursive delete that FOLLOWED the link would destroy the user's real
   * dependency tree — the single most damaging thing anything in this package
   * could do. Node's `rmSync` unlinks rather than descends; this proves it on
   * the machine the tests run on rather than trusting the documentation.
   */
  const root = workspace({ 'src/a.mjs': 'export const a = 1;\n', 'node_modules/dep/index.js': 'module.exports = 42;\n' });
  try {
    let sawDependency = false;
    const out = await runInIsolatedCopy({
      root,
      executor: createLocalExecutor(root),
      linkNodeModules: true,
      run: async (copyRoot) => {
        sawDependency = existsSync(join(copyRoot, 'node_modules', 'dep', 'index.js'));
        return { ok: true, executed: [] };
      },
    });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.dependenciesLinked, true, 'the link was not made, so a verification in there would have been meaningless');
    assert.equal(sawDependency, true, 'the helper could not reach the dependencies — `npm test` would fail for the wrong reason');
    assert.equal(readFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 42;\n',
      'THE REAL node_modules WAS DAMAGED BY THE COPY BEING DELETED — stop and fix this before anything else');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ without the flag, the copy is exactly what it always was — no dependencies at all', async () => {
  const root = workspace({ 'src/a.mjs': 'export const a = 1;\n', 'node_modules/dep/index.js': 'module.exports = 42;\n' });
  try {
    let sawDependency = null;
    const out = await runInIsolatedCopy({
      root,
      executor: createLocalExecutor(root),
      run: async (copyRoot) => {
        sawDependency = existsSync(join(copyRoot, 'node_modules'));
        return { ok: true, executed: [] };
      },
    });
    assert.equal(out.dependenciesLinked, false);
    assert.equal(sawDependency, false, 'COPY_SKIP_DIRS must still skip node_modules for every caller that did not ask');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ a link that cannot be made degrades — it never takes the delegation down', async () => {
  const root = workspace({ 'src/a.mjs': 'export const a = 1;\n', 'node_modules/dep/index.js': 'x\n' });
  try {
    const out = await runInIsolatedCopy({
      root,
      executor: createLocalExecutor(root),
      linkNodeModules: true,
      linkDir: () => { throw new Error('EPERM: a filesystem that refuses links'); },
      run: async () => ({ ok: true, executed: [] }),
    });
    assert.equal(out.ok, true, 'a failed link must not fail the build — a helper without tests beats no helper');
    assert.equal(out.dependenciesLinked, false, 'and it must SAY it did not happen, or the verdict is trusted wrongly');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ a workspace with no node_modules is not an error, it is just unlinked', async () => {
  const root = workspace({ 'src/a.mjs': 'export const a = 1;\n' });
  try {
    const out = await runInIsolatedCopy({
      root, executor: createLocalExecutor(root), linkNodeModules: true, run: async () => ({ ok: true, executed: [] }),
    });
    assert.equal(out.ok, true);
    assert.equal(out.dependenciesLinked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ NO RECURSION, still — a verifying helper is not offered delegate either', () => {
  assert.equal(SUBAGENT_VERIFY_TOOL_NAMES.includes('delegate'), false, 'a helper that can delegate is a fork bomb');
  // ⚠️ And no git verb: the copy still skips `.git`, so they would be dead
  // buttons the helper learns to apologise for, ~750 tokens a round.
  for (const dead of ['git_status', 'git_diff', 'git_log']) {
    assert.equal(SUBAGENT_VERIFY_TOOL_NAMES.includes(dead), false, `${dead} is dead inside the copy`);
  }
  // The verify offer is the write offer plus exactly one verb — one list, not two.
  assert.deepEqual(SUBAGENT_VERIFY_TOOL_NAMES, [...SUBAGENT_WRITE_TOOL_NAMES, 'run_command']);
});
