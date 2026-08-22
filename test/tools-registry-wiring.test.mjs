/**
 * ── THE REGISTRY WIRING — DOES THE MODEL ACTUALLY GET THESE TOOLS ───────────
 *
 * Ten modules in lib/ shipped finished, documented and tested, and were imported
 * by NOTHING on the runtime path. Their own tests were green the whole time —
 * which is the point of this file. A module test proves the module works; it
 * cannot prove a user can reach it. That gap is 39% of this package.
 *
 * So every assertion here goes through `TOOL_SCHEMAS`, `toolNamesForRounds` or
 * `executeToolCall` — the three doors the runtime actually opens — and never
 * imports the orphan modules to check them directly. If the registration line is
 * deleted, this file goes red; if the module is deleted, its own suite goes red.
 * Two different failures, two different files.
 *
 * ⚠️ AND THE DRIFT GUARD IS THE HEADLINE. tools.mjs's header promises that every
 * declared tool has a handler and vice versa, and names a TypeScript test in
 * `console/` as the thing that asserts it. That file is not in this package and
 * cannot run here, so for the CLI the promise was unenforced. It is enforced
 * below, in both directions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TOOL_SCHEMAS, TOOL_NAMES, toolNamesForRounds, toolSchemasFor,
  executeToolCall, skillsAvailable, lspAvailable,
} from '../lib/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_SOURCE = readFileSync(join(HERE, '..', 'lib', 'tools.mjs'), 'utf8');

/** A workspace that exists on disk. The dispatcher only needs `.root` for every
 *  tool wired here — none of them go through the executor's read/write. */
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-wiring-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return root;
}

const callFor = (name, args = {}) => ({ id: `c_${name}`, function: { name, arguments: JSON.stringify(args) } });

/** The tools this lane connected. Named explicitly rather than derived, so
 *  deleting a registration line cannot also delete the expectation of it. */
const NEWLY_WIRED = [
  'plan_start', 'plan_step', 'plan_status',
  'read_skill',
  'find_definition', 'find_references', 'check_types', 'list_symbols',
  'list_sessions',
  'declare_acceptance', 'check_acceptance',
  'fetch_url',
  'read_lines', 'read_around',
];

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE DRIFT GUARD — declared ⇔ dispatched, both directions
 * ──────────────────────────────────────────────────────────────────────────── */

/** Every `case 'name':` in the dispatcher, read from the source. Static because
 *  a switch cannot be introspected and because CALLING every tool to find out
 *  would spawn processes and hit the network. */
function dispatchedNames(source) {
  return new Set([...source.matchAll(/^\s*case '([a-z_]+)':/gm)].map((m) => m[1]));
}

test('⚠️⭐ THE DRIFT GUARD: every declared tool has a dispatch case', () => {
  const dispatched = dispatchedNames(TOOLS_SOURCE);
  // Sanity first — a regex that matched nothing would make this test vacuous,
  // which is the "check that passes against broken code" this repo has been
  // bitten by four times.
  assert.ok(dispatched.size >= 20, `only ${dispatched.size} case labels found — the extractor is broken, not the code`);
  assert.ok(dispatched.has('write_file'), 'the extractor must see the oldest case in the file');

  const missing = TOOL_NAMES.filter((n) => !dispatched.has(n));
  assert.deepStrictEqual(
    missing, [],
    `declared to the model with no handler — the model will call these and be told "unknown tool": ${missing.join(', ')}`,
  );
});

test('⚠️⭐ THE DRIFT GUARD, THE OTHER WAY: every dispatch case is a declared tool', () => {
  const declared = new Set(TOOL_NAMES);
  const orphanCases = [...dispatchedNames(TOOLS_SOURCE)].filter((n) => !declared.has(n));
  assert.deepStrictEqual(
    orphanCases, [],
    `dispatched but never declared, so nothing can ever call them: ${orphanCases.join(', ')}`,
  );
});

test('the drift guard is not vacuous — an undeclared name really is refused', async () => {
  const r = await executeToolCall(callFor('summon_a_pony'), { root: '/nowhere' });
  assert.strictEqual(r.result.ok, false);
  assert.match(r.result.error, /unknown tool "summon_a_pony"/);
});

test('every newly wired tool is in the registry and has a usable schema', () => {
  for (const name of NEWLY_WIRED) {
    assert.ok(TOOL_NAMES.includes(name), `${name} was never declared`);
    const [schema] = toolSchemasFor([name]);
    assert.ok(schema, `${name} has no schema to put in a payload`);
    assert.strictEqual(schema.type, 'function');
    assert.ok(schema.function.description.length > 40, `${name}'s description is the only documentation the model reads`);
    assert.strictEqual(schema.function.parameters.type, 'object');
  }
});

test('no tool name is declared twice', () => {
  const seen = new Map();
  for (const n of TOOL_NAMES) seen.set(n, (seen.get(n) ?? 0) + 1);
  const dupes = [...seen].filter(([, c]) => c > 1).map(([n]) => n);
  assert.deepStrictEqual(dupes, [], `a duplicate schema means the provider sees two definitions: ${dupes.join(', ')}`);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE OFFER — round budget, --no-run, availability
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ the newly wired tools reach the multi-round offer', () => {
  // The whole lane in one line: without this they are code nobody can call.
  const offered = toolNamesForRounds(5, { env: {}, root: workspaceless() });
  for (const n of ['plan_start', 'plan_step', 'plan_status', 'list_sessions', 'fetch_url', 'read_lines', 'read_around', 'declare_acceptance', 'check_acceptance']) {
    assert.ok(offered.includes(n), `${n} is wired but never offered — an unreachable capability`);
  }
});

/** A directory that exists and definitely has no .acuvo/ and no node_modules,
 *  so the availability gates answer "no" deterministically on any machine. */
function workspaceless() {
  return mkdtempSync(join(tmpdir(), 'acuvo-bare-'));
}

test('⚠️ every offered tool exists in the registry (the offer cannot invent a name)', () => {
  for (const n of toolNamesForRounds(5, { env: {}, root: workspaceless() })) {
    assert.ok(TOOL_NAMES.includes(n), `${n} is offered but not in the registry`);
  }
});

test('⚠️ a single-round turn is offered NONE of them — every one is a dead button there', () => {
  const one = toolNamesForRounds(1, { env: {}, root: workspaceless() });
  for (const n of NEWLY_WIRED) {
    assert.ok(!one.includes(n), `${n} must not be offered with no second round`);
  }
  // The pre-existing single-shot contract is untouched.
  assert.ok(one.includes('write_file'));
});

test('⚠️⭐ --no-run withholds acceptance, because check_acceptance EXECUTES commands', () => {
  const root = workspaceless();
  const withRun = toolNamesForRounds(5, { env: {}, allowRun: true, root });
  const without = toolNamesForRounds(5, { env: {}, allowRun: false, root });
  assert.ok(withRun.includes('check_acceptance'));
  assert.ok(withRun.includes('declare_acceptance'));
  assert.ok(!without.includes('check_acceptance'), '--no-run would be a lie by a side door');
  // Declaring without being able to check is a promise nothing can keep.
  assert.ok(!without.includes('declare_acceptance'));
  // …and the reads are unaffected, which is the point of the flag.
  assert.ok(without.includes('read_lines'));
  assert.ok(without.includes('plan_start'));
});

test('⚠️⭐ --no-run is enforced at the DISPATCHER too — a model can call what it was not shown', async () => {
  const root = workspaceless();
  let ran = 0;
  const executor = { root, runCommand: async () => { ran += 1; return { ok: true, exitCode: 0 }; } };
  const r = await executeToolCall(callFor('check_acceptance'), executor, { allowRun: false });
  assert.strictEqual(r.result.ok, false);
  assert.match(r.result.error, /--no-run/);
  assert.strictEqual(ran, 0, 'a refused acceptance check must not reach the runner');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. AVAILABILITY GATES — absent dependency means ABSENT TOOL, never a broken one
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️⚠️ THIS TEST WAS INVERTED ON 2026-08-17, DELIBERATELY, AND HERE IS WHY.
 *
 * It used to assert that `read_skill` is WITHHELD from a project with no
 * skills — correct behaviour when the only possible skills were ones a user
 * wrote, because offering a reader with nothing to read is a dead tool that
 * costs prompt tokens every round.
 *
 * That premise is now false. Acuvo SHIPS skills (`acuvo-code/skills/`, surfaced
 * by `lib/builtin-skills.mjs`), so the shelf is never empty: every project gets
 * the design-system, Next.js, Supabase, app-quality, verification and planning
 * skills whether or not it defines its own.
 *
 * ⭐ The gate is still on CONTENT, exactly as before — it is just that content
 * now always exists. The old assertion is kept below in inverted form rather
 * than deleted, so the change in behaviour is visible to whoever reads this
 * next instead of looking like a test that quietly disappeared.
 */
test('⭐ read_skill is ALWAYS offered, because Acuvo ships skills of its own', (t) => {
  const root = workspace(t);
  assert.strictEqual(skillsAvailable(root), true, 'the bundled shelf is never empty');
  assert.ok(toolNamesForRounds(5, { env: {}, root }).includes('read_skill'));

  // An empty PROJECT skills directory changes nothing — the bundle still stands.
  mkdirSync(join(root, '.acuvo', 'skills'), { recursive: true });
  assert.strictEqual(skillsAvailable(root), true, 'an empty project dir does not remove the bundled skills');
  assert.ok(toolNamesForRounds(5, { env: {}, root }).includes('read_skill'));
});

test('⭐ …and appears the moment one exists', (t) => {
  const root = workspace(t);
  mkdirSync(join(root, '.acuvo', 'skills'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'skills', 'deploy.md'), '# Deploy\n\nRun the migration first, then flip the flag.\n');
  assert.strictEqual(skillsAvailable(root), true);
  assert.ok(toolNamesForRounds(5, { env: {}, root }).includes('read_skill'), 'a written skill nobody can read is the whole bug');
});

test('⭐ the four lsp tools are withheld when no language server is installed…', (t) => {
  const root = workspace(t);
  // PATH is emptied so a machine with rust-analyzer or gopls installed answers
  // the same as one without — the gate, not the tester\'s laptop, decides.
  assert.strictEqual(lspAvailable(root, { PATH: '' }), false);
  const offered = toolNamesForRounds(5, { env: { PATH: '' }, root });
  for (const n of ['find_definition', 'find_references', 'check_types', 'list_symbols']) {
    assert.ok(!offered.includes(n), `${n} can only say "install it" here — a dead button`);
  }
});

test('⭐ …and appear when one is present in node_modules', (t) => {
  const root = workspace(t);
  const dir = join(root, 'node_modules', 'typescript-language-server', 'lib');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cli.mjs'), '// a language server, as far as discovery is concerned\n');
  /**
   * ⚠️ THE WORKSPACE HAS TO SPEAK THE LANGUAGE, and this line is the whole
   * reason the gate changed at integration. Installing a server proves the
   * MACHINE can answer; it says nothing about whether this project has a single
   * file the server could open. Measured on the integrating machine: a
   * zero-dependency JavaScript package offered all four tools because
   * `rust-analyzer` sat in `~/.cargo/bin` from unrelated work, and every one of
   * them could only ever reply "typescript-language-server is not installed".
   */
  writeFileSync(join(root, 'package.json'), '{ "name": "fixture" }\n');
  /**
   * ⚠️ AND IT HAS TO BE A SOURCE FILE, NOT package.json. `lspAvailable` gates on
   * `languagesPresent(root)`, which looks for files the server could actually
   * OPEN — a manifest is not one. Without this line the fixture installs a
   * server into a workspace with nothing to analyse, `languagesPresent` returns
   * an empty set, and the assertion below fails against code that is behaving
   * exactly as designed.
   *
   * ⭐ That is the "check that fails correct work" shape, caught for the fifth
   * time in this repo and the second time today: the gate was tightened for a
   * good reason and the fixture that predated it was never updated, so a red
   * test accused a correct product of being broken.
   */
  writeFileSync(join(root, 'index.ts'), 'export const answer: number = 42;\n');
  /**
   * ⚠️⚠️ AND IT HAS TO HAVE THE THING THE SERVER DRIVES — the SAME shape again,
   * one layer deeper, on 2026-08-17. `workspaceCanBeServed` (lsp.mjs) now checks
   * for `typescript/lib/tsserver.js`, because `typescript-language-server`
   * drives tsserver and does not contain one. A fixture with the server but not
   * the compiler installs something that starts and then cannot serve, so all
   * four verbs are dead buttons and the gate correctly keeps them shut.
   *
   * ⭐ The comment above says this is the "check that fails correct work" shape
   * caught for the fifth time. This is the sixth, and the resolution is the same
   * one: the gate tightened for a researched reason and a fixture predating it
   * accused correct code of being broken. The fixture moves, never the gate.
   */
  const tsLib = join(root, 'node_modules', 'typescript', 'lib');
  mkdirSync(tsLib, { recursive: true });
  writeFileSync(join(tsLib, 'tsserver.js'), '// what typescript-language-server actually drives\n');
  assert.strictEqual(lspAvailable(root, { PATH: '' }), true);
  const offered = toolNamesForRounds(5, { env: { PATH: '' }, root });
  for (const n of ['find_definition', 'find_references', 'check_types', 'list_symbols']) {
    assert.ok(offered.includes(n), `${n} is installed and still not offered`);
  }
});

test('⚠️ computing the offer never throws, whatever the root is', () => {
  for (const root of [undefined, '', '(memory)', join(tmpdir(), 'acuvo-does-not-exist-9f3a'), 42]) {
    assert.doesNotThrow(() => toolNamesForRounds(5, { env: {}, root }));
  }
  assert.strictEqual(skillsAvailable('(memory)'), false);
  assert.strictEqual(lspAvailable('(memory)', {}), false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. DISPATCH — the tool actually runs and returns the module's own answer
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ the plan ledger runs end to end through executeToolCall', async (t) => {
  const root = workspace(t);
  const executor = { root };

  const started = await executeToolCall(
    callFor('plan_start', { task: 'wire the orphans', steps: ['register schemas', 'add dispatch', 'test it'] }),
    executor,
  );
  assert.strictEqual(started.result.ok, true, JSON.stringify(started.result));
  assert.strictEqual(started.result.steps.length, 3);
  // ⚠️ .acuvo/plan.json is bookkeeping, not a deliverable — counting it would
  // put a phantom entry in "N files written" and make every parallel pair
  // collide on the same path.
  assert.strictEqual(started.mutated, false);

  const stepped = await executeToolCall(callFor('plan_step', { id: 's1', state: 'done' }), executor);
  assert.strictEqual(stepped.result.ok, true, JSON.stringify(stepped.result));
  assert.strictEqual(stepped.result.state, 'done');

  const status = await executeToolCall(callFor('plan_status'), executor);
  assert.strictEqual(status.result.exists, true);
  assert.strictEqual(status.result.outstanding.length, 2);
  // No round budget was passed, so the banner carries no countdown — plan-ledger
  // says outright that a WRONG countdown is worse than none.
  assert.ok(!/round/.test(status.result.banner), status.result.banner);
});

test('⭐ a round budget passed to the dispatcher reaches the banner', async (t) => {
  const root = workspace(t);
  const executor = { root };
  await executeToolCall(callFor('plan_start', { task: 't', steps: ['a', 'b'] }), executor);
  const status = await executeToolCall(callFor('plan_status'), executor, { round: { roundIndex: 3, maxRounds: 8 } });
  assert.match(status.result.banner, /round 3 of 8/);
});

test('⭐ read_skill returns the project\'s own procedure', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, '.acuvo', 'skills'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'skills', 'deploy.md'), '# Deploy\n\nRun the migration first.\n');
  const r = await executeToolCall(callFor('read_skill', { name: 'deploy' }), { root });
  assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
  assert.match(r.result.body, /Run the migration first/);
  assert.strictEqual(r.mutated, false);
});

test('⭐ read_lines and read_around window a real file', async (t) => {
  const root = workspace(t);
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
  lines[199] = 'const NEEDLE = 1;';
  writeFileSync(join(root, 'big.js'), `${lines.join('\n')}\n`);
  const executor = { root };

  const win = await executeToolCall(callFor('read_lines', { path: 'big.js', offset: 10, limit: 5 }), executor);
  assert.strictEqual(win.result.ok, true, JSON.stringify(win.result));
  assert.strictEqual(win.result.startLine, 10);
  assert.match(win.result.text, /^line 10\n/);
  assert.strictEqual(win.result.totalLines, 300);

  const around = await executeToolCall(callFor('read_around', { path: 'big.js', pattern: 'NEEDLE' }), executor);
  assert.strictEqual(around.result.ok, true, JSON.stringify(around.result));
  assert.strictEqual(around.result.matchCount, 1);
  assert.match(around.result.blocks[0].text, /const NEEDLE = 1;/);
});

test('⚠️ the dispatcher tells read-window WHICH tool was called rather than guessing', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'a.txt'), 'alpha\nbeta\n');
  // No `pattern`, so inference would also land on read_lines — the interesting
  // case is the reverse: read_lines called WITH a pattern must be refused as an
  // illegal argument, not silently promoted to read_around.
  const r = await executeToolCall(callFor('read_lines', { path: 'a.txt', pattern: 'beta' }), { root });
  assert.strictEqual(r.result.ok, false);
  assert.match(r.result.error, /pattern/);
});

test('⭐ list_sessions answers on a workspace that has never been run', async (t) => {
  const r = await executeToolCall(callFor('list_sessions', { limit: 3 }), { root: workspace(t) });
  assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
  assert.deepStrictEqual(r.result.sessions, []);
  assert.strictEqual(r.mutated, false);
});

test('⭐ declare_acceptance records the command, and check_acceptance runs it', async (t) => {
  const root = workspace(t);
  // ⭐ A REAL package.json, because `declare_acceptance` VALIDATES AT DECLARATION
  // TIME: it reads the npm script BODY through the same pure function the runner
  // uses, so a workspace with no package.json stores the criterion
  // `runnable: false` and check_acceptance correctly runs nothing. That is the
  // module's headline behaviour, and asserting the happy path needs a script the
  // allowlist accepts.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test test' } }));
  const seen = [];
  const executor = {
    root,
    // The injected runner — acceptance.mjs starts no process by itself, which is
    // what keeps ONE audited gate rather than two.
    runCommand: async (command) => { seen.push(command); return { ok: true, exitCode: 0, stdout: 'ok', stderr: '' }; },
  };

  const declared = await executeToolCall(callFor('declare_acceptance', { commands: ['npm test'] }), executor);
  assert.strictEqual(declared.result.ok, true, JSON.stringify(declared.result));
  assert.strictEqual(declared.result.criteria[0].command, 'npm test');

  const checked = await executeToolCall(callFor('check_acceptance'), executor);
  assert.strictEqual(checked.result.ok, true, JSON.stringify(checked.result));
  assert.deepStrictEqual(seen, ['npm test'], 'the criterion the USER named is the one that ran');
  assert.strictEqual(checked.result.criteria[0].passed, true);
});

test('⭐ fetch_url is reachable, and refuses an unknown argument BY NAME', async (t) => {
  const executor = { root: workspace(t) };
  // No network is touched on either path: both refusals happen before the request.
  const noUrl = await executeToolCall(callFor('fetch_url', {}), executor);
  assert.strictEqual(noUrl.result.ok, false);
  assert.match(noUrl.result.error, /needs a url/);

  const bogus = await executeToolCall(callFor('fetch_url', { url: 'https://example.com', headers: { a: 'b' } }), executor);
  assert.strictEqual(bogus.result.ok, false);
  assert.match(bogus.result.error, /does not accept "headers"/, 'silently dropping it teaches the model the header was sent');
});

test('⭐ an lsp tool with no server installed says what to install, and never spawns', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'x.ts'), 'export const a = 1;\n');
  const r = await executeToolCall(callFor('check_types', { file: 'x.ts' }), { root });
  assert.strictEqual(r.result.ok, false);
  assert.match(r.result.error, /typescript-language-server|not installed|npm i -D/);
  assert.strictEqual(r.mutated, false);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE MEMORY EXECUTOR — a workspace whose disk is a Map
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️ a memory workspace refuses the disk-bound tools with a sentence, not a crash', async () => {
  const executor = { root: '(memory)' };
  for (const [name, args, pattern] of [
    ['read_lines', { path: 'a.js' }, /held in memory/],
    ['read_around', { path: 'a.js', pattern: 'x' }, /held in memory/],
    ['check_types', { file: 'a.ts' }, /held in memory/],
    ['plan_start', { task: 't', steps: ['a'] }, /memory|disk/i],
    ['declare_acceptance', { commands: ['npm test'] }, /memory|disk/i],
    /**
     * ⚠️⚠️ `read_skill` LEFT THIS LIST ON 2026-08-17 AND THAT IS THE POINT.
     *
     * It belonged here while every skill lived in the user's `.acuvo/skills` —
     * a memory workspace has no disk, so there was nothing to read. Acuvo now
     * SHIPS skills inside the package (`lib/builtin-skills.mjs`), and those are
     * on the CLI's own disk regardless of what the workspace is.
     *
     * ⭐ This is the whole value of the change, not a side effect: THE BUILDER
     * RUNS ON A MEMORY EXECUTOR. Leaving `read_skill` disk-bound would have
     * meant the one surface with no skills of its own — the thing customers use
     * to build software — was also the one surface that could never read ours.
     * Its positive behaviour is asserted in the test below.
     */
  ]) {
    const r = await executeToolCall(callFor(name, args), executor);
    assert.strictEqual(r.result.ok, false, `${name} must refuse on a memory workspace`);
    assert.match(r.result.error, pattern, `${name}: ${r.result.error}`);
    assert.strictEqual(r.mutated, false);
  }
});

/**
 * ⭐⭐ THE BUILDER RUNS HERE. A memory workspace has no project on disk, so
 * before the skills were bundled this surface had access to nothing at all.
 */
test('⭐⭐ a memory workspace CAN read the skills Acuvo ships', async () => {
  const executor = { root: '(memory)' };

  const found = await executeToolCall(callFor('read_skill', { name: 'acuvo-design-system' }), executor);
  assert.strictEqual(found.result.ok, true, 'a bundled skill must load with no project on disk');
  assert.match(String(found.result.body ?? ''), /Content-Security-Policy/i, 'the real skill body, not a stub');
  assert.strictEqual(found.mutated, false, 'reading a skill changes nothing');

  // ⚠️ And an unknown name still refuses — naming what IS available, so the
  // model can correct itself instead of guessing again.
  const missing = await executeToolCall(callFor('read_skill', { name: 'no-such-skill' }), executor);
  assert.strictEqual(missing.result.ok, false);
  assert.match(missing.result.error, /acuvo-design-system/, 'the refusal lists what exists');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE CLAIMS IN THE COMMENTS — struck, because they were false
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️ the two "no other agent has this" claims are gone, and the honest one replaced them', () => {
  /**
   * Both were false: Playwright MCP and Chrome DevTools MCP are free and one
   * install away, and this was already struck from README.md on 2026-08-10.
   * A comment is documentation; a false comment is a claim someone repeats.
   */
  // ⚠️ THE ASSERTED FORMS, not the phrases. The replacement text QUOTES each
  // claim in order to strike it, and a test that banned the words outright would
  // fail the correction as well as the error — the trap this repo hit four times
  // in one day. So: the sentences as they stood, verbatim.
  assert.ok(!/`see_page` is the one no other terminal agent has/.test(TOOLS_SOURCE));
  assert.ok(!/It is the one capability no other coding agent has/.test(TOOLS_SOURCE));
  // …and the strike is visible rather than a silent deletion.
  assert.match(TOOLS_SOURCE, /IT IS NOT "the one capability no other coding agent has"/);
  // The defensible claim is the RETURN VALUE, not the browser.
  assert.match(TOOLS_SOURCE, /89-token/);
  assert.match(TOOLS_SOURCE, /3,072/);
  assert.match(TOOLS_SOURCE, /34x/);
});

test('the schema list and TOOL_NAMES cannot disagree', () => {
  assert.deepStrictEqual(TOOL_NAMES, TOOL_SCHEMAS.map((s) => s.function.name));
});
