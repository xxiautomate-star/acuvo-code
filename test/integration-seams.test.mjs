/**
 * ── THE SEAMS BETWEEN THE LANES ─────────────────────────────────────────────
 *
 * Four agents wired capability into four files in parallel, each blind to the
 * others. Every one of them left a note saying "this needs one word in a file I
 * do not own". This file tests the words.
 *
 * ⚠️ WHY IT IS A SEPARATE FILE FROM THE LANES' OWN TESTS. Each lane proved its
 * half: `tools-registry-wiring` proves a tool is declared and dispatched,
 * `turn-plan-and-acceptance` proves the loop reads a plan, `lifecycle-wiring`
 * proves a session is saved. None of them could prove the two halves MEET,
 * because the meeting point was in the other lane's file. A tool that is
 * declared, dispatched, offered and then rendered to the model as 2,000
 * characters of escaped JSON is wired and broken, and no single-lane test can
 * see that.
 *
 * ⚠️ EVERY TEST HERE WAS MUTATED AND WATCHED GO RED before it was kept — the
 * repo's rule, learned four times: a check that passes against broken code is
 * worse than no check. The mutations are named in the comment above each block
 * so the next person can repeat them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runSession, toolResultText, formatSummary, gatherWorkspaceContext,
} from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { toolNamesForRounds, lspAvailable, languagesPresent } from '../lib/tools.mjs';
import { toJson } from '../lib/report.mjs';

function workspace(t, name = 'acuvo-seams-') {
  const dir = mkdtempSync(join(tmpdir(), name));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows handle lag */ } });
  return dir;
}

/** A model that asks for exactly the calls it is given, one round at a time. */
function scriptedModel(rounds) {
  let i = 0;
  const seen = [];
  const impl = async (opts) => {
    seen.push(opts);
    const calls = rounds[i] ?? [];
    i += 1;
    if (calls.length === 0) return { ok: true, content: 'done', toolCalls: [], usage: null, finishReason: 'stop' };
    return {
      ok: true,
      content: 'working',
      model: 'stub/answering-model',
      toolCalls: calls.map((c, n) => ({ id: `c${i}_${n}`, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
      usage: null,
      finishReason: 'tool_calls',
    };
  };
  impl.seen = seen;
  return impl;
}

const config = { apiKey: 'test-key', model: 'stub/requested-model' };

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE FORMATTERS — a read tool the model cannot read from is not wired
 *
 * MUTATION: delete the `read_lines`/`read_around` case from `toolResultText`
 * and this block goes red on the escaped-newline assertion.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⭐ read_lines reaches the model as TEXT, not as escaped JSON', (t) => {
  const root = workspace(t);
  const body = ['const alpha = 1;', 'const beta = 2;', 'const gamma = 3;'].join('\n');
  writeFileSync(join(root, 'src.js'), `${body}\n`, 'utf8');

  const executor = createLocalExecutor(root);
  const result = { ok: true, ...JSON.parse(JSON.stringify({})) };
  // Go through the real dispatcher rather than hand-building a result, so a
  // change to the tool's return shape breaks this too.
  return import('../lib/tools.mjs').then(async ({ executeToolCall }) => {
    const record = await executeToolCall(
      { id: 'x', function: { name: 'read_lines', arguments: JSON.stringify({ path: 'src.js', offset: 1, limit: 3 }) } },
      executor,
      {},
    );
    assert.strictEqual(record.result.ok, true, 'the fixture must actually read, or this proves nothing');
    const text = toolResultText(record);
    assert.ok(text.includes('const beta = 2;'), 'the model must be able to see the line it asked for');
    assert.ok(
      !text.includes('\\n'),
      'rendered through the JSON default: every newline arrives as a literal backslash-n, and an '
      + 'old_string copied out of it can never match the file',
    );
    assert.ok(text.length > 0 && result.ok === true);
  });
});

test('⚠️⚠️ read_skill keeps its SAFETY WRAPPER on the way to the model', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, '.acuvo', 'skills'), { recursive: true });
  writeFileSync(
    join(root, '.acuvo', 'skills', 'deploy.md'),
    '---\nname: deploy\ndescription: how this project ships\n---\n\nRun the migration first, then flip the flag.\n',
    'utf8',
  );
  const { executeToolCall } = await import('../lib/tools.mjs');
  const record = await executeToolCall(
    { id: 'x', function: { name: 'read_skill', arguments: JSON.stringify({ name: 'deploy' }) } },
    createLocalExecutor(root),
    {},
  );
  assert.strictEqual(record.result.ok, true);
  const text = toolResultText(record);
  assert.ok(text.includes('Run the migration first'), 'the body has to arrive');
  /**
   * ⚠️ THIS IS THE SECURITY HALF. A skill is prose written into the repository,
   * so it is untrusted text entering the conversation. skills.mjs's rule is that
   * the only safe way to hand it over is wrapped in a restatement that it grants
   * no tool and lifts no restriction — and the JSON default would have pasted
   * the prose in naked.
   */
  assert.match(text, /not (a )?(permission|instruction)|grants? you no|cannot give you|does not (grant|override)|no permission/i);
});

test('⚠️ fetch_url arrives as the PAGE plus a continuation instruction', () => {
  // Built directly rather than fetched: the shape is fetch-text.mjs's, and this
  // test is about the RENDERING, which is the half that lives in turn.mjs.
  const text = toolResultText({
    name: 'fetch_url',
    result: {
      ok: true,
      url: 'https://example.com/doc',
      finalUrl: 'https://example.com/doc',
      status: 200,
      totalChars: 40_000,
      fromCache: false,
      text: 'Section One\n\nThe body of the page.',
      nextOffset: 12_000,
    },
  });
  assert.ok(text.includes('Section One'), 'the page has to arrive');
  assert.ok(!text.includes('\\n'), 'escaped through JSON.stringify, a fetched document is unreadable prose');
  assert.match(text, /HTTP 200/);
  assert.match(
    text, /offset 12000/,
    'the free continuation was a field buried in JSON — a model that does not notice it reports the page as truncated and stops',
  );
});

test('⭐ the plan tools return the BANNER, which is the only part worth sending', async (t) => {
  const root = workspace(t);
  const { executeToolCall } = await import('../lib/tools.mjs');
  const executor = createLocalExecutor(root);
  const started = await executeToolCall(
    { id: 'p', function: { name: 'plan_start', arguments: JSON.stringify({ task: 'port it', steps: ['port', 'commit'] }) } },
    executor,
    { round: { roundIndex: 2, maxRounds: 6 } },
  );
  assert.strictEqual(started.result.ok, true);
  const text = toolResultText(started);
  assert.match(text, /plan: 0\/2 done/);
  assert.ok(!text.includes('{'), 'a banner rendered as JSON is a banner nobody reads');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE ROUND NUMBER — the countdown only exists if the loop hands it over
 *
 * MUTATION: drop `round: { roundIndex: round, maxRounds }` from the
 * executeToolCall call in `runSession` and the clause disappears → red.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ the loop tells the plan ledger WHERE IN THE BUDGET it is', async (t) => {
  const root = workspace(t);
  const outcome = await runSession({
    task: 'plan the work',
    executor: createLocalExecutor(root),
    config,
    maxRounds: 4,
    callModelImpl: scriptedModel([
      [{ name: 'plan_start', args: { task: 'port it', steps: ['port', 'test', 'commit'] } }],
      [],
    ]),
  });
  const record = outcome.executed.find((e) => e.name === 'plan_start');
  assert.ok(record, 'the fixture must actually call the tool');
  assert.match(
    String(record.result.banner),
    /round 1 of 4/,
    'the model was shown a plan with no idea how many rounds were left — which is the exact defect '
    + 'plan-ledger.mjs was written to remove (round 8 of 8 byte-identical to round 1)',
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE OFFER PROBES THE RIGHT TREE — `--dir` used to probe the shell's cwd
 *
 * MUTATION: remove `root: executor.root` from the `toolNamesForRounds` call in
 * `runSession` and this goes red, because the process cwd (this package) has no
 * .acuvo/skills.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ a --dir run offers read_skill for the DIRECTORY IT IS WORKING IN', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, '.acuvo', 'skills'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'skills', 'house-style.md'), '---\nname: house-style\n---\n\nTabs, never spaces.\n', 'utf8');

  const model = scriptedModel([[]]);
  await runSession({ task: 'do nothing', executor: createLocalExecutor(root), config, maxRounds: 3, callModelImpl: model });

  const offeredNames = (model.seen[0].tools ?? []).map((s) => s.function.name);
  assert.ok(
    offeredNames.includes('read_skill'),
    'the workspace has skills and the model was not offered the verb that opens them — the offer probed '
    + 'the shell\'s current directory instead of the workspace',
  );
});

test('⚠️ and a workspace with NO skills is not offered the verb (the gate still shuts)', async (t) => {
  const root = workspace(t);
  const model = scriptedModel([[]]);
  await runSession({ task: 'do nothing', executor: createLocalExecutor(root), config, maxRounds: 3, callModelImpl: model });
  const offeredNames = (model.seen[0].tools ?? []).map((s) => s.function.name);
  assert.ok(!offeredNames.includes('read_skill'), 'a project with no skills must not be shown a dead button');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE CATALOGUE — read_skill takes a NAME, so the names have to be somewhere
 *
 * MUTATION: delete the `skillsBlock` lines from `runSession` and the system
 * message loses the SKILLS heading → red.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ the skills CATALOGUE is in the system prompt, or the tool is undiscoverable', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, '.acuvo', 'skills'), { recursive: true });
  writeFileSync(
    join(root, '.acuvo', 'skills', 'release.md'),
    '---\nname: release\ndescription: how we cut a release\nwhen: shipping a version\n---\n\nTag, then publish.\n',
    'utf8',
  );
  const model = scriptedModel([[]]);
  await runSession({ task: 'ship it', executor: createLocalExecutor(root), config, maxRounds: 3, callModelImpl: model });

  const system = model.seen[0].messages.find((m) => m.role === 'system').content;
  assert.match(system, /SKILLS/, 'read_skill tells the model to use a name "exactly as it appears in the SKILLS list"');
  assert.match(system, /release/, 'the catalogue must name the skill that exists');
  assert.match(system, /how we cut a release/, 'a name with no description is a list the model cannot choose from');
  /** ⚠️ The prompt-injection guard travels WITH the catalogue, always. */
  assert.match(system, /notes, not permissions|cannot give you a tool/i);
});

test('⚠️ no skills, no catalogue — the prompt is byte-identical to a project without them', async (t) => {
  const bare = workspace(t);
  const model = scriptedModel([[]]);
  await runSession({ task: 'ship it', executor: createLocalExecutor(bare), config, maxRounds: 3, callModelImpl: model });
  const system = model.seen[0].messages.find((m) => m.role === 'system').content;
  assert.ok(!system.includes('SKILLS ('), 'a catalogue of nothing is prompt tokens spent on nothing');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. `--no-run` IS ENFORCED AT THE DISPATCHER, not only in the offer
 *
 * MUTATION: drop `allowRun` from the executeToolCall call in `runSession` and
 * the refusal becomes a real `npm test` → red.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⭐ a model that calls check_acceptance under --no-run is REFUSED, not obeyed', async (t) => {
  const root = workspace(t);
  const outcome = await runSession({
    task: 'check it',
    executor: createLocalExecutor(root),
    config,
    maxRounds: 3,
    allowRun: false,
    // The model was never shown this tool. It asks anyway — a stale conversation,
    // a resumed session, or a provider echoing an old tool list all do this.
    callModelImpl: scriptedModel([[{ name: 'check_acceptance', args: {} }], []]),
  });
  const record = outcome.executed.find((e) => e.name === 'check_acceptance');
  assert.ok(record, 'the fixture must actually reach the dispatcher');
  assert.strictEqual(record.result.ok, false, '--no-run would be a lie by a side door');
  assert.match(record.result.error, /--no-run/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. A COMMAND RUN BY check_acceptance IS A COMMAND THAT RAN
 *
 * MUTATION: delete the `record.name === 'check_acceptance'` block from the
 * round loop and the summary goes back to "NOTHING WAS RUN" → red.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ check_acceptance counts as a run — the honesty line stopped lying pessimistically', async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  writeFileSync(
    join(root, '.acuvo', 'acceptance.json'),
    `${JSON.stringify({ version: 1, declaredAt: new Date().toISOString(), criteria: [{ command: 'node --version', phrase: 'node --version', kind: 'bare', runnable: true }] })}\n`,
    'utf8',
  );

  const events = [];
  const outcome = await runSession({
    task: 'confirm the toolchain',
    executor: createLocalExecutor(root),
    config,
    maxRounds: 3,
    onEvent: (e) => events.push(e),
    callModelImpl: scriptedModel([[{ name: 'check_acceptance', args: {} }], []]),
  });

  const record = outcome.executed.find((e) => e.name === 'check_acceptance');
  assert.strictEqual(record.result.ok, true, 'the criterion must genuinely run for this to mean anything');
  assert.strictEqual(record.result.criteria[0].ran, true);

  const summary = formatSummary(outcome).join('\n');
  assert.ok(
    !summary.includes('NOTHING WAS RUN'),
    'a command ran through the same audited gate run_command uses, and the one line whose whole job is '
    + 'honesty said nothing had been run',
  );
  assert.strictEqual(outcome.verification.ran, true);

  /** ⚠️ AND IT MUST NOT BE RUN A SECOND TIME by the end-of-run sweep. */
  const reruns = events.filter((e) => e.type === 'acceptance-check');
  assert.deepStrictEqual(
    reruns, [],
    'the sweep re-ran a criterion the session had just watched pass — minutes of somebody\'s laptop to '
    + 'learn something already known',
  );
  assert.strictEqual(outcome.acceptance.verdict.verdict, 'met');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. THE MACHINE CONTRACT — --json carried a green field over a missed criterion
 *
 * MUTATION: delete the `acceptance:` key from `toJson` → red.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ --json reports the criterion the user named, with its weight', () => {
  const doc = toJson({
    ok: true,
    verification: { ran: true, passed: true, command: 'node --check x.js', exitCode: 0, attempts: 1 },
    acceptance: {
      source: 'declared',
      gating: true,
      verdict: { verdict: 'unmet', unmet: [{ command: 'npm test', why: 'it ran and exited 1' }] },
    },
  }, { changes: [], task: 't' });

  assert.strictEqual(doc.verification.passed, true, 'the fixture is the dangerous shape: something passed');
  assert.ok(doc.acceptance, 'a consumer reading .verification.passed saw green and had no way to know better');
  assert.strictEqual(doc.acceptance.verdict, 'unmet');
  assert.strictEqual(doc.acceptance.gating, true);
  assert.deepStrictEqual(doc.acceptance.unmet, [{ command: 'npm test', why: 'it ran and exited 1' }]);
});

test('⭐ and it is null when nobody named one — most runs', () => {
  assert.strictEqual(toJson({ ok: true }, {}).acceptance, null);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 8. THE COMPLIANCE FIELD — every audit record shipped "answered": null
 *
 * MUTATION: remove `model: reply.model ?? null` from the rounds.push calls → red.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ the session reports WHICH model answered, not only which was asked for', async (t) => {
  const root = workspace(t);
  const outcome = await runSession({
    task: 'anything',
    executor: createLocalExecutor(root),
    config,
    maxRounds: 3,
    callModelImpl: scriptedModel([[{ name: 'list_dir', args: { path: '.' } }], []]),
  });
  assert.strictEqual(outcome.model, 'stub/requested-model', 'the requested model is still reported, unchanged');
  assert.strictEqual(
    outcome.answeredModel, 'stub/answering-model',
    'chain.mjs fails over across four providers, so "which model saw our source code" had no answer at all',
  );
  const { recordRun, answeringModels } = await import('../lib/audit.mjs');
  assert.deepStrictEqual(answeringModels(outcome), ['stub/answering-model']);
  const logged = recordRun({ root, outcome, changes: [], task: 'anything' });
  assert.strictEqual(logged.ok, true);
});

test('⚠️ and it is null rather than guessed when no round reported one', async (t) => {
  const root = workspace(t);
  const outcome = await runSession({
    task: 'anything',
    executor: createLocalExecutor(root),
    config,
    maxRounds: 2,
    callModelImpl: async () => ({ ok: true, content: 'no model field', toolCalls: [], usage: null, finishReason: 'stop' }),
  });
  assert.strictEqual(outcome.answeredModel, null, 'a script can test for null; it cannot test for "our best guess"');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 9. THE LSP GATE IS AN INTERSECTION — installed AND spoken here
 *
 * MUTATION: make `lspAvailable` ignore `languagesPresent` and the JavaScript
 * fixture starts offering four tools that can only say "install it" → red on
 * any machine with any language server, which is what the integrating machine
 * turned out to be.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ a server installed for a language this project does not contain is still a dead button', (t) => {
  const root = workspace(t);
  // A Go-only workspace, and only a TypeScript server on the machine.
  writeFileSync(join(root, 'go.mod'), 'module example.com/x\n', 'utf8');
  writeFileSync(join(root, 'main.go'), 'package main\n', 'utf8');
  const lsDir = join(root, 'node_modules', 'typescript-language-server', 'lib');
  mkdirSync(lsDir, { recursive: true });
  writeFileSync(join(lsDir, 'cli.mjs'), '// discoverable\n', 'utf8');

  assert.deepStrictEqual([...languagesPresent(root)], ['go']);
  assert.strictEqual(
    lspAvailable(root, { PATH: '' }), false,
    'check_types on a .go file with only a TypeScript server can only ever answer "gopls is not installed"',
  );
  for (const n of ['find_definition', 'check_types']) {
    assert.ok(!toolNamesForRounds(5, { env: { PATH: '' }, root }).includes(n));
  }
});

test('⭐ …and the intersection OPENS when the project speaks the installed language', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'package.json'), '{ "name": "x" }\n', 'utf8');
  const lsDir = join(root, 'node_modules', 'typescript-language-server', 'lib');
  mkdirSync(lsDir, { recursive: true });
  writeFileSync(join(lsDir, 'cli.mjs'), '// discoverable\n', 'utf8');
  assert.strictEqual(lspAvailable(root, { PATH: '' }), true);
  assert.ok(toolNamesForRounds(5, { env: { PATH: '' }, root }).includes('check_types'));
});

test('⭐ a manifest one level down counts — that is how real repositories are shaped', (t) => {
  const root = workspace(t);
  mkdirSync(join(root, 'crates', 'core'), { recursive: true });
  writeFileSync(join(root, 'crates', 'Cargo.toml'), '[workspace]\n', 'utf8');
  assert.ok(languagesPresent(root).has('rust'));
});

test('⚠️ the language probe never recurses into node_modules, and never throws', (t) => {
  const root = workspace(t);
  mkdirSync(join(root, 'node_modules', 'somedep'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'somedep', 'Cargo.toml'), '[package]\n', 'utf8');
  assert.ok(!languagesPresent(root).has('rust'), 'a dependency\'s language is not this project\'s language');
  assert.doesNotThrow(() => languagesPresent(join(tmpdir(), 'acuvo-does-not-exist-31f7')));
});

/* ────────────────────────────────────────────────────────────────────────────
 * 10. THE REGRESSION GUARD — a user who passes no new flag gets the old run
 *
 * This is the part people skip. Every capability above is opt-in by the shape
 * of the workspace or by a flag; the plain run must be untouched.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⭐ a plain workspace, no flags: the offer and the prompt are what they always were', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'index.js'), 'export const a = 1;\n', 'utf8');
  const model = scriptedModel([[]]);
  const outcome = await runSession({ task: 'read it', executor: createLocalExecutor(root), config, maxRounds: 5, callModelImpl: model });

  const offered = (model.seen[0].tools ?? []).map((s) => s.function.name);
  // No .acuvo/skills → no read_skill. No language server for JS here → no lsp.
  assert.ok(!offered.includes('read_skill'));
  const system = model.seen[0].messages.find((m) => m.role === 'system').content;
  assert.ok(!system.includes('SKILLS ('));
  // No plan file → no banner, so the conversation is exactly the old one.
  assert.ok(!model.seen[0].messages.some((m) => typeof m.content === 'string' && m.content.startsWith('plan:')));
  // No criterion anywhere → acceptance is null, and the exit verdict is untouched.
  assert.strictEqual(outcome.acceptance, null);
  assert.strictEqual(toJson(outcome, {}).acceptance, null);
});

/**
 * ⚠️ THE SHIPPED PACKAGE HAS TO EXPOSE WHAT IT SHIPS. `bin/acuvo-mcp.mjs` is in
 * `files` and speaks the protocol (probed 2026-08-11: it answers `initialize`
 * and `tools/list`), but `bin` declared only `acuvo` — so after `npm i -g` the
 * MCP server could be started only by naming a path inside `node_modules`. That
 * is the same unreachability defect as an unregistered tool, one layer out, and
 * it matters more here because being drivable BY other agents is the stated
 * strategy.
 */
test('⚠️ every executable this package ships is reachable by name after install', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  for (const [name, rel] of Object.entries(pkg.bin ?? {})) {
    assert.ok(existsSync(join(here, '..', rel)), `${name} points at ${rel}, which is not in the package`);
  }
  assert.ok(pkg.bin['acuvo-mcp'], 'bin/acuvo-mcp.mjs ships and must be invocable by name');
});

test('⚠️ a single-round turn is still exactly two tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-oneshot-'));
  assert.deepStrictEqual(toolNamesForRounds(1, { root }), ['write_file', 'generate_image']);
  rmSync(root, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 11. THE CLAIM THE DOCUMENTS STILL MADE — §3.2, and it was already fixed
 *
 * ENTERPRISE.md listed "the prompt ships .env" as an open finding. It is not
 * open: `gatherWorkspaceContext` runs every candidate through
 * `refusedCommitPath`. Pinned here so the correction to the document cannot
 * drift back out of agreement with the code.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ credentials never reach the prompt — and the source next to them does', (t) => {
  const root = workspace(t);
  writeFileSync(join(root, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-SENTINEL-A\n', 'utf8');
  writeFileSync(join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=SENTINEL-B\n', 'utf8');
  writeFileSync(join(root, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nSENTINEL-C\n', 'utf8');
  writeFileSync(join(root, 'server.pem'), '-----BEGIN CERTIFICATE-----\nSENTINEL-D\n', 'utf8');
  writeFileSync(join(root, 'index.js'), 'export const hi = 1;\n', 'utf8');

  const context = gatherWorkspaceContext(createLocalExecutor(root));
  assert.strictEqual(context.ok, true);
  for (const sentinel of ['SENTINEL-A', 'SENTINEL-B', 'SENTINEL-C', 'SENTINEL-D']) {
    assert.ok(!context.text.includes(sentinel), `${sentinel} went upstream — and chain.mjs fans that out to four providers`);
  }
  assert.ok(context.text.includes('export const hi = 1;'), 'refusing everything would pass this test and break the tool');
});
