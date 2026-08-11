/**
 * ── ⭐⭐ THE INTEGRATION PASS — WHAT FOUR BLIND LANES LEFT BEHIND ────────────
 *
 * Four agents wired capability into four files in parallel, each unable to see
 * the others. This file is the first thing that looks at the package as ONE
 * package, and it pins the two classes of defect that only appear at that
 * altitude:
 *
 *   (1) THE LAST ORPHAN. `lib/spawn-argv.mjs` — 801 lines, finished, tested,
 *       imported by nothing but its own test — was skipped by the wiring lane
 *       as "a product decision". It is now wired, and every claim about the
 *       wiring is proven by RUNNING it rather than by reading it.
 *
 *   (2) THE COLLISION CLASS. Parallel work produces a specific family of bug:
 *       a tool declared twice, a schema with no dispatch (or the reverse), a
 *       verb offered in the wrong round budget, a flag added by two lanes, a
 *       write to stdout that breaks `--json`. Those are asserted here
 *       STRUCTURALLY, so the guard does not depend on anyone remembering to
 *       re-check them the next time work is split.
 *
 * ⚠️⚠️ ONE FINDING IS THE REASON THIS FILE IS NOT JUST A REGISTRY CHECK.
 * `acceptance.mjs` already listed `run_program` in `SATISFYING_TOOLS` — but it
 * meant the BROWSER client's verb, which returns `{command: 'npm test'}`. The
 * CLI's `run_program` returns `{argv: ['npm','test']}` and no `command` at all,
 * because having no string to re-parse is the entire reason it exists. Two
 * different verbs, one name, and the judge silently skipped ours. It failed in
 * the safe direction (a criterion gets re-run rather than falsely passed), and
 * it was still wrong. `runSession` now translates. That is pinned below.
 *
 * ⚠️ EVERY TEST HERE WAS MUTATED AND WATCHED GO RED before it was kept.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TOOL_SCHEMAS, TOOL_NAMES, toolNamesForRounds, executeToolCall, SINGLE_SHOT_TOOL_NAMES,
} from '../lib/tools.mjs';
import { runSession, toolResultText, formatSummary } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { createMemoryExecutor } from '../lib/memory-workspace.mjs';
import { evaluateAcceptance } from '../lib/acceptance.mjs';

/* ────────────────────────────────────────────────────────────────────────────
 * fixtures
 * ──────────────────────────────────────────────────────────────────────────── */

function workspace(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-integrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

const call = (name, args) => ({ id: 't1', function: { name, arguments: JSON.stringify(args) } });

/** A model that calls one tool in round 1 and then stops. */
function oneToolModel(name, args) {
  let round = 0;
  return async () => {
    round += 1;
    if (round === 1) {
      return {
        ok: true, content: 'running it', usage: null, finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', function: { name, arguments: JSON.stringify(args) } }],
      };
    }
    return { ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' };
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * (1) THE COLLISION CLASS — structural, machine-independent
 * ════════════════════════════════════════════════════════════════════════════ */

test('⚠️ no tool is declared twice — the first thing parallel registration breaks', () => {
  const seen = new Set();
  const duplicates = [];
  for (const name of TOOL_NAMES) {
    if (seen.has(name)) duplicates.push(name);
    seen.add(name);
  }
  assert.deepEqual(duplicates, [], `these tools are registered more than once: ${duplicates.join(', ')}`);
});

/**
 * ⚠️ THE DISPATCH SIDE IS READ OUT OF THE SOURCE, not asked of the module.
 * Calling every tool to see whether it answers would EXECUTE them; and the
 * failure being hunted is a schema whose handler nobody wrote, which shows up as
 * the `default` branch at runtime and looks exactly like a typo from outside.
 */
test('⚠️⚠️ every declared tool has a dispatch case, and every case is declared', () => {
  const source = readFileSync(new URL('../lib/tools.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function executeToolCall'));
  const cases = new Set([...body.matchAll(/^\s*case '([a-z_0-9]+)':/gm)].map((m) => m[1]));

  const declaredWithoutHandler = TOOL_NAMES.filter((n) => !cases.has(n));
  assert.deepEqual(declaredWithoutHandler, [],
    `declared to the model with no handler — it would answer "unknown tool": ${declaredWithoutHandler.join(', ')}`);

  const handledWithoutSchema = [...cases].filter((n) => !TOOL_NAMES.includes(n));
  assert.deepEqual(handledWithoutSchema, [],
    `dispatched but never declared, so no model can ever reach it: ${handledWithoutSchema.join(', ')}`);
});

/**
 * ⭐ THE ROUND BUDGET IS THE OTHER HALF OF THE OFFER, and four lanes pushing
 * into one list is exactly how a read tool ends up in the single-shot offer —
 * the dead button this package refuses to ship.
 */
test('⚠️ a single-shot turn still offers ONLY write_file (+ image), whatever was added', () => {
  // ⚠️ `generate_image` is the ONE legitimate extra: it writes a file, so its
  // result has somewhere to go even with no second round, and it is configured
  // by default. Everything else appearing here is the dead-button defect.
  const offered = toolNamesForRounds(1, { root: process.cwd() }).filter((n) => n !== 'generate_image');
  assert.deepEqual(offered, [...SINGLE_SHOT_TOOL_NAMES],
    'something was added to the one-round offer; a tool whose result has nowhere to go is a dead button');
  // …and with the image service explicitly switched off, the offer is bare.
  assert.deepEqual(
    toolNamesForRounds(1, { env: { PERCHANCE_IMAGE_URL: '' }, root: process.cwd() }),
    [...SINGLE_SHOT_TOOL_NAMES],
  );
});

test('⚠️ --no-run withholds EVERY verb that can start a process', () => {
  const offered = toolNamesForRounds(5, { allowRun: false, env: {}, root: process.cwd() });
  for (const forbidden of ['run_command', 'run_program', 'evaluate', 'check_acceptance', 'declare_acceptance', 'git_commit']) {
    assert.ok(!offered.includes(forbidden), `--no-run still offered ${forbidden}`);
  }
  // …and the loop does not collapse: the reads survive, which is the whole
  // point of the flag being the honest middle setting rather than an off switch.
  assert.ok(offered.includes('read_file') && offered.includes('write_file') && offered.includes('git_diff'));
});

/**
 * ⚠️ TWO PARSERS NOW KNOW ABOUT FLAGS — `extractLifecycleFlags` in bin, and
 * `parseArgv` in cli-args. That is a deliberate, documented seam, and the risk
 * it carries is a lane adding the same flag to both, where one silently eats it
 * before the other is asked. This asserts they are DISJOINT.
 */
test('⚠️ no flag is claimed by both argv parsers', () => {
  const bin = readFileSync(new URL('../bin/acuvo.mjs', import.meta.url), 'utf8');
  const lifecycleBlock = bin.slice(bin.indexOf('function extractLifecycleFlags'), bin.indexOf('async function main()'));
  const lifted = new Set([...lifecycleBlock.matchAll(/arg(?:\.startsWith\(|\s*===\s*)'(--[a-z-]+)/g)].map((m) => m[1]));
  assert.ok(lifted.size >= 5, 'the lifecycle stripper stopped recognising its own flags');

  const args = readFileSync(new URL('../lib/cli-args.mjs', import.meta.url), 'utf8');
  const parserFlags = new Set([...args.matchAll(/'(--[a-z-]+)'/g)].map((m) => m[1]));

  const both = [...lifted].filter((f) => parserFlags.has(f));
  assert.deepEqual(both, [], `claimed by BOTH bin/acuvo.mjs and lib/cli-args.mjs: ${both.join(', ')}`);
});

/**
 * ⚠️⚠️ THE `--json` CONTRACT IS ONE DOCUMENT ON STDOUT AND NOTHING ELSE, and a
 * lane that adds a friendly line to a lifecycle path is how it breaks. Every
 * `process.stdout.write` in bin must be inside a json branch or an else of one.
 * Read structurally rather than run, because proving it by running would need
 * one live completion per path.
 */
test('⚠️ session persistence writes nothing to stdout, so --json stays one document', () => {
  const bin = readFileSync(new URL('../bin/acuvo.mjs', import.meta.url), 'utf8');
  const at = bin.indexOf('const persistRun =');
  assert.notEqual(at, -1, 'persistRun moved or was renamed — this guard is now looking at nothing');
  const persist = bin.slice(at, bin.indexOf('\n  };', at));
  assert.ok(persist.length > 200 && /saveSession/.test(persist) && /recordRun/.test(persist),
    'the slice no longer covers both records — the guard would pass vacuously');
  assert.ok(!/process\.stdout\.write/.test(persist),
    'the session/audit writer printed to stdout; --json promises exactly one document there');
  // A failed write must still be VISIBLE — silence is the defect audit.mjs names.
  assert.ok(/process\.stderr\.write/.test(persist), 'a failed record must be announced on stderr');
});

/**
 * ⚠️ THE DOUBLE-SAVE HAZARD session.mjs warned about. Its own registration note
 * proposes calling `saveSession` inside `runSession`; the CLI lane put it in
 * bin instead. If both had landed, every run would write two session files.
 */
test('⚠️ saveSession is called from exactly one module on the runtime path', () => {
  const bin = readFileSync(new URL('../bin/acuvo.mjs', import.meta.url), 'utf8');
  const turn = readFileSync(new URL('../lib/turn.mjs', import.meta.url), 'utf8');
  assert.ok(/saveSession\(/.test(bin), 'the CLI stopped saving sessions');
  assert.ok(!/^\s*(?:const .* = )?saveSession\(/m.test(turn) && !/from '\.\/session\.mjs'/.test(turn),
    'lib/turn.mjs also imports session.mjs — two savers means two files per run');
});

/* ════════════════════════════════════════════════════════════════════════════
 * (2) run_program — REACHABLE, AND PROVEN BY SPAWNING SOMETHING
 * ════════════════════════════════════════════════════════════════════════════ */

test('run_program is declared, and offered in every multi-round run that may execute', () => {
  assert.ok(TOOL_NAMES.includes('run_program'), 'the schema never reached the registry');
  assert.ok(toolNamesForRounds(2, { env: {}, root: process.cwd() }).includes('run_program'));
});

/**
 * ⭐⭐ THE POINT OF THE WHOLE MODULE, IN ONE ASSERTION. `run_command` cannot
 * express this: the quote is refused by the character whitelist, which is why
 * the agent could never execute the argument handling it had just written.
 */
test('⭐ an argument with a SPACE survives as ONE argv slot — the thing run_command cannot do', async (t) => {
  const dir = workspace(t, {
    'bin/echo.mjs': 'console.log(JSON.stringify(process.argv.slice(2)));\n',
  });
  const record = await executeToolCall(
    call('run_program', { program: 'node', args: ['bin/echo.mjs', 'add', 'buy milk', '--pri', 'high'] }),
    createLocalExecutor(dir),
    { commandTimeoutMs: 20_000 },
  );
  assert.equal(record.result.ok, true, record.result.error);
  assert.equal(record.result.exitCode, 0);
  assert.deepEqual(JSON.parse(record.result.stdout.trim()), ['add', 'buy milk', '--pri', 'high']);
  assert.equal(record.mutated, false, 'a program run must not inflate the "N files written" line');
});

test('⚠️ --no-run is enforced at the DISPATCHER, not only at the offer', async (t) => {
  const dir = workspace(t, { 'bin/echo.mjs': 'console.log("ran");\n' });
  const record = await executeToolCall(
    call('run_program', { program: 'node', args: ['bin/echo.mjs'] }),
    createLocalExecutor(dir),
    { commandTimeoutMs: 20_000, allowRun: false },
  );
  assert.equal(record.result.ok, false);
  assert.match(record.result.error, /--no-run/);
});

test('⚠️ --dry-run refuses it, because a program can write to disk', async (t) => {
  const dir = workspace(t, { 'bin/w.mjs': "import {writeFileSync} from 'node:fs';writeFileSync('made.txt','x');\n" });
  const record = await executeToolCall(
    call('run_program', { program: 'node', args: ['bin/w.mjs'] }),
    createLocalExecutor(dir, { dryRun: true }),
    { commandTimeoutMs: 20_000 },
  );
  assert.equal(record.result.ok, false);
  assert.match(record.result.error, /dry-run/);
  assert.equal(existsSync(join(dir, 'made.txt')), false, 'a dry run promised to touch nothing and touched something');
});

test('⚠️ the four-binary allowlist is the same one, not a second copy', async (t) => {
  const dir = workspace(t, {});
  const record = await executeToolCall(
    call('run_program', { program: 'curl', args: ['https://example.com'] }),
    createLocalExecutor(dir), { commandTimeoutMs: 20_000 },
  );
  assert.equal(record.result.ok, false);
  assert.match(record.result.error, /not a program this agent may run/);
  assert.match(record.result.error, /node, npm, npx, tsc/);
});

test('⚠️ a node flag refused by command.mjs is refused here, in command.mjs\'s own words', async (t) => {
  const dir = workspace(t, { 'bin/x.mjs': 'console.log(1);\n' });
  const record = await executeToolCall(
    call('run_program', { program: 'node', args: ['--eval', 'require("fs").writeFileSync("pwned.txt","x")'] }),
    createLocalExecutor(dir), { commandTimeoutMs: 20_000 },
  );
  assert.equal(record.result.ok, false);
  assert.equal(existsSync(join(dir, 'pwned.txt')), false);
});

/**
 * ⭐ THE FORMATTER IS NOT COSMETIC. Rendered through the JSON default a result
 * arrives escaped and clipped at 2,000 characters; rendered through
 * `formatRunForModel` it prints `$ undefined`, because a run_program result has
 * no `command`. The argv is the receipt that the quoted argument survived.
 */
test('⭐ the model is shown the ARGV, not escaped JSON and not "$ undefined"', () => {
  const text = toolResultText({
    name: 'run_program',
    result: {
      ok: true, program: 'node', argv: ['node', 'bin/todo.js', 'add', 'buy milk'],
      exitCode: 0, timedOut: false, durationMs: 120, passed: true, stdout: 'added\n', stderr: '',
    },
  });
  assert.match(text, /\["node","bin\/todo\.js","add","buy milk"\]/);
  assert.match(text, /exit code: 0/);
  assert.ok(!/undefined/.test(text));
});

/**
 * ── ⚠️⚠️⚠️ THE SILENT GREEN, AND WIRING THE SECOND SPAWNER IS WHAT EXPOSED IT ──
 *
 * `node --test` sets `NODE_TEST_CONTEXT` in every child. A nested `node --test`
 * that inherits it believes it is a test WORKER, stops printing TAP, and writes
 * a serialised stream to a parent that is not listening — so the run reports
 * **exit 0 with zero output** for a suite that failed.
 *
 * `spawn-argv.mjs` deleted the variable in its own spawner and deliberately did
 * NOT touch the shared `scrubEnvironment`, because a single-file lane must not
 * change another verb's behaviour. Correct then; wrong once both verbs ship.
 * MEASURED side by side on the identical failing file, before the fix:
 *
 *   run_command  → exitCode 0 · 0 bytes      run_program → exitCode 1 · 951 bytes
 *
 * ⚠️ THIS TEST ONLY MEANS ANYTHING BECAUSE IT RUNS UNDER `node --test`, which is
 * the condition being defended. If the suite is ever driven by a runner that
 * does not set the variable, the guard silently stops testing anything — so it
 * ASSERTS THE PRECONDITION FIRST rather than passing vacuously.
 */
test('⚠️⚠️ a nested failing suite is red through BOTH spawners — no silent green', async (t) => {
  assert.equal(typeof process.env.NODE_TEST_CONTEXT, 'string',
    'this guard is only meaningful under `node --test`; the precondition it defends is absent');

  const dir = workspace(t, {
    'test/red.test.mjs': "import test from 'node:test';import assert from 'node:assert';test('red',()=>assert.equal(1,2));\n",
  });
  const viaCommand = await executeToolCall(
    call('run_command', { command: 'node --test test/red.test.mjs' }),
    createLocalExecutor(dir), { commandTimeoutMs: 60_000 },
  );
  const viaProgram = await executeToolCall(
    call('run_program', { program: 'node', args: ['--test', 'test/red.test.mjs'] }),
    createLocalExecutor(dir), { commandTimeoutMs: 60_000 },
  );
  assert.equal(viaCommand.result.exitCode, 1, 'run_command reported a FAILING suite as exit 0');
  assert.equal(viaProgram.result.exitCode, 1, 'run_program reported a FAILING suite as exit 0');
  assert.ok(viaCommand.result.stdout.length > 100, 'run_command produced no output for a suite that printed a failure');
  assert.ok(viaProgram.result.stdout.length > 100, 'run_program produced no output for a suite that printed a failure');
});

/* ════════════════════════════════════════════════════════════════════════════
 * (3) THE HONESTY ACCOUNTING — the bug this repo has now had three times
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️⚠️ `runs` WAS KEYED ON THE NAME OF THE TOOL rather than on whether a process
 * ran. It was wrong for `evaluate`, then wrong again for `check_acceptance`, and
 * both times the summary said "NOTHING WAS RUN" about a session that had just
 * executed a test suite. This pins the third one before a user finds it.
 */
test('⚠️⚠️ a session whose only execution was run_program is NOT reported as unverified', async (t) => {
  const dir = workspace(t, {
    'package.json': '{"name":"x","version":"1.0.0"}\n',
    'test/ok.test.mjs': "import test from 'node:test';import assert from 'node:assert';test('t',()=>assert.ok(true));\n",
  });
  const outcome = await runSession({
    task: 'run the tests',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: 2,
    commandTimeoutMs: 30_000,
    callModelImpl: oneToolModel('run_program', { program: 'node', args: ['--test', 'test/ok.test.mjs'] }),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verification.ran, true, 'a real process ran and the verdict said nothing did');
  assert.equal(outcome.verification.passed, true);
  const summary = formatSummary(outcome).join('\n');
  assert.ok(!/NOTHING WAS RUN/.test(summary), summary);
});

/**
 * ⚠️⚠️ THE NAME COLLISION. `acceptance.mjs` counts `run_program` records — but
 * reads `result.command`, which the browser client sets and this one does not.
 * Without the translation in `runSession` the criterion is judged UNMET and the
 * suite is run a second time by the sweep.
 */
test('⚠️⚠️ a criterion satisfied by run_program is judged MET, despite the two verbs sharing a name', async (t) => {
  const dir = workspace(t, {
    'package.json': '{"name":"x","version":"1.0.0"}\n',
    'test/ok.test.mjs': "import test from 'node:test';import assert from 'node:assert';test('t',()=>assert.ok(true));\n",
    '.acuvo/acceptance.json': `${JSON.stringify({
      version: 1, declaredAt: new Date().toISOString(),
      criteria: [{ command: 'node --test test/ok.test.mjs', phrase: 'node --test test/ok.test.mjs', kind: 'command', runnable: true }],
    })}\n`,
  });
  /**
   * ⚠️⚠️ THE EVENT LIST IS THE REAL ASSERTION, AND WITHOUT IT THIS TEST PASSED
   * AGAINST BROKEN CODE — caught by mutation, which is exactly why the rule
   * exists. Remove the translation and the verdict is STILL `met`: the sweep
   * notices the criterion looks unsatisfied, runs the suite a second time, and
   * that second run legitimately passes. The user-visible damage is not a wrong
   * verdict, it is `npm test` executing twice — so the thing to pin is that
   * nothing was re-run, not that the answer was green.
   */
  const events = [];
  const outcome = await runSession({
    task: 'make the tests pass',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: 2,
    commandTimeoutMs: 30_000,
    onEvent: (e) => events.push(e),
    callModelImpl: oneToolModel('run_program', { program: 'node', args: ['--test', 'test/ok.test.mjs'] }),
  });
  assert.ok(outcome.acceptance, 'a declared criterion produced no verdict at all');
  assert.equal(outcome.acceptance.verdict.verdict, 'met',
    `the judge could not see the run_program record: ${JSON.stringify(outcome.acceptance.verdict)}`);
  assert.deepEqual(events.filter((e) => e.type === 'acceptance-check'), [],
    'the sweep re-ran a criterion the session had already satisfied — the judge could not read the run_program record');
});

/** The raw shape, so the failure above is attributable rather than mysterious. */
test('the judge cannot read a raw CLI run_program record — which is WHY it is translated', () => {
  const raw = evaluateAcceptance({
    declared: [{ command: 'npm test', phrase: 'npm test', kind: 'command', runnable: true }],
    executed: [{ name: 'run_program', args: { program: 'npm', args: ['test'] }, result: { ok: true, argv: ['npm', 'test'], exitCode: 0 } }],
  });
  assert.notEqual(raw.verdict, 'met', 'if this ever passes, acceptance.mjs learned the argv shape and turn.mjs can stop translating');

  const translated = evaluateAcceptance({
    declared: [{ command: 'npm test', phrase: 'npm test', kind: 'command', runnable: true }],
    executed: [{ name: 'run_command', args: { command: 'npm test' }, result: { ok: true, command: 'npm test', exitCode: 0 } }],
  });
  assert.equal(translated.verdict, 'met');
});

/**
 * ⚠️⚠️ THE SUMMARY CONTRADICTED ITSELF TWO LINES APART — FOUND BY RUNNING THE
 * BINARY, not by reading it. Measured verbatim, 2026-08-11:
 *
 *   ⚠ NOTHING WAS RUN, so nothing here is verified — no command was executed
 *     this session.
 *   ✖ UNMET — you asked that `npm test` pass; it ran and exited 1
 *
 * The acceptance sweep spawns the declared criterion through the same audited
 * gate at the end of the session, and its run is deliberately kept out of
 * `executed` so it cannot contaminate the file count or `verification`. That is
 * right. What was wrong is the SENTENCE, which claimed nothing had executed.
 *
 * ⭐ AND THE VERDICT MUST NOT MOVE. `verification.ran` stays false — the MODEL
 * proved nothing, which is the fact this line exists to state, and folding a
 * sweep-run into it would let a green sweep turn a NOT-VERIFIED into a VERIFIED.
 */
test('⚠️⚠️ the summary cannot say "no command was executed" after the sweep executed one', async (t) => {
  const dir = workspace(t, {
    'package.json': '{"name":"x","version":"1.0.0","scripts":{"test":"node --test test/red.test.mjs"}}\n',
    'test/red.test.mjs': "import test from 'node:test';import assert from 'node:assert';test('red',()=>assert.equal(1,2));\n",
    '.acuvo/acceptance.json': `${JSON.stringify({
      version: 1, declaredAt: new Date().toISOString(),
      criteria: [{ command: 'npm test', phrase: 'npm test', kind: 'command', runnable: true }],
    })}\n`,
  });
  const outcome = await runSession({
    task: 'write NOTES.md and touch nothing else',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: 2,
    commandTimeoutMs: 60_000,
    callModelImpl: async () => ({ ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' }),
  });

  assert.equal(outcome.acceptance?.verdict?.verdict, 'unmet', 'the sweep did not run the declared criterion at all');
  // The verdict itself must be untouched: the model proved nothing and still has not.
  assert.equal(outcome.verification.ran, false, 'a sweep-run leaked into verification — that is a way to PASS dressed as honesty');

  const summary = formatSummary(outcome).join('\n');
  assert.ok(/it ran and exited 1/.test(summary), summary);
  assert.ok(!/no command was executed this session/.test(summary),
    `the summary says nothing executed, two lines above saying the criterion ran:\n${summary}`);
});

/* ════════════════════════════════════════════════════════════════════════════
 * (4) THE SECOND EXECUTOR — tested against the REAL object, not a stub
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ `lib/memory-workspace.mjs` is the tenth module and it is the one that CANNOT
 * be reached from `node bin/acuvo.mjs` — it is the browser client's half of the
 * seam, and inventing a `--memory` flag to "make it reachable" would be a fake
 * product surface. What CAN be proven from here is the half that lives in this
 * package: the `(memory)` guards in the dispatcher were unit-tested against a
 * bare `{ root: '(memory)' }` literal, which is not the object they will meet.
 * These run against the real executor.
 */
test('⭐ the real memory executor is refused by every disk-bound verb, each naming the alternative', async () => {
  const executor = createMemoryExecutor({ files: { 'index.js': 'export const x = 1;\n' } });
  assert.equal(executor.root, '(memory)');

  for (const [name, args, expect] of [
    ['run_program', { program: 'node', args: ['index.js'] }, /run_command/],
    ['read_lines', { path: 'index.js' }, /read_file/],
    ['read_around', { path: 'index.js', pattern: 'x' }, /read_file/],
    ['check_types', { path: 'index.js' }, /search_text/],
    ['git_status', {}, /git/],
  ]) {
    const record = await executeToolCall(call(name, args), executor, { commandTimeoutMs: 5_000 });
    assert.equal(record.result.ok, false, `${name} was NOT refused on a memory workspace`);
    assert.match(record.result.error, expect, `${name}'s refusal does not name what to do instead`);
  }
});

test('⭐ and the verbs that DO work there still work — the guard is per-capability, not a blanket', async () => {
  const executor = createMemoryExecutor({ files: { 'index.js': 'export const x = 1;\n' } });
  const read = await executeToolCall(call('read_file', { path: 'index.js' }), executor, {});
  assert.equal(read.result.ok, true);
  assert.match(read.result.content, /export const x/);

  const wrote = await executeToolCall(call('write_file', { path: 'new.js', content: 'ok\n' }), executor, {});
  assert.equal(wrote.result.ok, true);
  assert.equal(wrote.mutated, true);
  assert.equal(executor.snapshot()['new.js'], 'ok\n');
});

/* ════════════════════════════════════════════════════════════════════════════
 * (5) THE FLAGLESS RUN IS UNCHANGED — the regression nobody checks
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ A user who passes no new flag must get what they got before. The two files
 * the lifecycle lane creates are `.acuvo/sessions/` and `.acuvo/audit/`, and
 * `runSession` itself must create NEITHER — they are bin's job, so a library
 * caller (and the web console) is untouched.
 */
test('⚠️ runSession writes no session file and no audit line — persistence belongs to the CLI', async (t) => {
  const dir = workspace(t, { 'index.js': 'export const x = 1;\n' });
  await runSession({
    task: 'do nothing',
    executor: createLocalExecutor(dir),
    config: { apiKey: 'not-used', model: 'stub' },
    maxRounds: 2,
    callModelImpl: async () => ({ ok: true, content: 'nothing to do', toolCalls: [], usage: null, finishReason: 'stop' }),
  });
  const acuvo = join(dir, '.acuvo');
  const wrote = existsSync(acuvo) ? readdirSync(acuvo) : [];
  assert.ok(!wrote.includes('sessions'), 'runSession saved a session; bin already does, so every run would save two');
  assert.ok(!wrote.includes('audit'), 'runSession wrote an audit line; bin already does, so every run would log twice');
});
