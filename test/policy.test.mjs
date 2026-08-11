/**
 * ── ⭐ THE POLICY SUITE — the tests are the argument ─────────────────────────
 *
 * `policy.mjs` makes one non-obvious claim: a policy file that the agent itself
 * can rewrite is still safe, because every merge moves toward LESS permission.
 * That claim is not something a reader should have to take on faith from a
 * comment, so the adversarial cases are written here as tests — a hostile
 * workspace file trying to unforbid a tool, raise a cap, turn MCP back on, and
 * escape a dry-run — and each one asserts the restriction survives.
 *
 * ⚠️ NO FILESYSTEM. Every decision function is pure and takes text, and the one
 * function that reads files takes its reader as an argument, so this suite never
 * creates a temp directory. A test that writes a policy file to disk to check
 * policy logic is testing `fs`.
 *
 * Runs on `node --test` with no dependencies, no network and no API key.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  OPEN_POLICY, WORKSPACE_POLICY_FILE, USER_POLICY_ENV, USER_POLICY_FILE,
  MAX_ROUNDS_CEILING, MAX_COST_CEILING_USD,
  parsePolicyDocument, mergePolicies, loadPolicy,
  toolDecision, filterToolNames, matchesModelPattern, modelDecision,
  roundBudget, costDecision, mcpDecision, invocationDecision,
  isPolicyProtectedPath, policyFingerprint, describePolicy, readPolicySources,
} from '../lib/policy.mjs';
import { TOOL_NAMES, toolNamesForRounds } from '../lib/tools.mjs';

/** Shorthand: build an effective policy from a workspace document alone. */
function ws(doc) {
  const r = loadPolicy({ workspaceText: JSON.stringify(doc) });
  assert.strictEqual(r.ok, true, r.ok ? '' : r.error);
  return r.policy;
}

// ── ⭐⭐ THE CENTRAL CLAIM: A WORKSPACE POLICY CAN ONLY EVER TIGHTEN ─────────

test('⭐⭐ a workspace policy CANNOT widen anything the admin restricted', () => {
  const admin = JSON.stringify({
    forbidTools: ['run_command', 'delete_file'],
    maxRounds: 2,
    maxCostUsd: 0.05,
    requireDryRun: true,
    allowModels: ['deepseek/*'],
    allowMcp: false,
  });
  // Exactly what a compromised agent would write to buy itself freedom.
  const hostile = JSON.stringify({
    forbidTools: [],
    maxRounds: MAX_ROUNDS_CEILING,
    maxCostUsd: MAX_COST_CEILING_USD,
    requireDryRun: false,
    allowModels: ['*'],
    allowMcp: true,
  });

  const r = loadPolicy({ adminText: admin, workspaceText: hostile });
  assert.strictEqual(r.ok, true);
  const p = r.policy;

  assert.deepStrictEqual(p.forbidTools, ['delete_file', 'run_command']);
  assert.strictEqual(p.maxRounds, 2);
  assert.strictEqual(p.maxCostUsd, 0.05);
  assert.strictEqual(p.requireDryRun, true, 'a dry-run requirement can never be unsaid');
  assert.strictEqual(p.allowMcp, false);
  // `allowModels: ["*"]` intersected with `deepseek/*` must NOT become "*".
  assert.deepStrictEqual(p.allowModels, ['deepseek/*']);
  assert.strictEqual(modelDecision(p, 'openai/gpt-5').allowed, false);
  assert.strictEqual(toolDecision(p, 'run_command').allowed, false);
});

test('⭐ the merge is commutative — "which file wins" is not a question you can ask', () => {
  const a = { forbidTools: ['run_command'], maxRounds: 5, allowMcp: true, allowModels: ['deepseek/*', 'z-ai/glm-4.6'] };
  const b = { forbidTools: ['delete_file'], maxRounds: 3, allowMcp: false, allowModels: ['deepseek/*'] };
  const base = { ...OPEN_POLICY, forbidTools: [], denyModels: [] };
  const ab = mergePolicies(mergePolicies(base, a), b);
  const ba = mergePolicies(mergePolicies(base, b), a);
  for (const k of ['forbidTools', 'allowTools', 'maxRounds', 'maxCostUsd', 'requireDryRun', 'allowModels', 'denyModels', 'allowMcp']) {
    assert.deepStrictEqual(ab[k], ba[k], `${k} must not depend on merge order`);
  }
});

test('⭐ the merge is idempotent — applying a policy twice changes nothing', () => {
  const base = { ...OPEN_POLICY, forbidTools: [], denyModels: [] };
  const layer = { forbidTools: ['delete_file'], maxCostUsd: 1, allowTools: ['read_file', 'write_file'] };
  const once = mergePolicies(base, layer);
  const twice = mergePolicies(once, layer);
  assert.deepStrictEqual(twice.forbidTools, once.forbidTools);
  assert.deepStrictEqual(twice.allowTools, once.allowTools);
  assert.strictEqual(twice.maxCostUsd, once.maxCostUsd);
});

test('a workspace policy CAN tighten — self-restriction is allowed and harmless', () => {
  const r = loadPolicy({
    adminText: JSON.stringify({ maxRounds: 8 }),
    workspaceText: JSON.stringify({ maxRounds: 2, forbidTools: ['delete_file'] }),
  });
  assert.strictEqual(r.policy.maxRounds, 2);
  assert.deepStrictEqual(r.policy.forbidTools, ['delete_file']);
});

test('⚠️ only the ADMIN layer may switch the workspace layer off', () => {
  const off = loadPolicy({
    adminText: JSON.stringify({ allowWorkspacePolicy: false, maxRounds: 6 }),
    workspaceText: JSON.stringify({ maxRounds: 0 }),
  });
  assert.strictEqual(off.ok, true);
  assert.strictEqual(off.policy.maxRounds, 6, 'the ignored workspace layer must not brick the run');
  assert.strictEqual(off.policy.sources.at(-1).ignored, true, 'and being ignored must be visible');

  // A workspace file reaching for the same key is refused, not silently dropped.
  const grab = loadPolicy({ workspaceText: JSON.stringify({ allowWorkspacePolicy: false }) });
  assert.strictEqual(grab.ok, false);
  assert.match(grab.error, /may only be set in the admin policy/);
});

// ── ⚠️ FAIL CLOSED ─────────────────────────────────────────────────────────

test('⚠️⚠️ a malformed policy STOPS THE RUN — it never falls back to "no policy"', () => {
  const broken = [
    '{ "maxRounds": 2, }',          // trailing comma
    '',                              // empty file
    '   ',
    'null',
    '[]',
    '"maxRounds"',
    '{ "maxRounds": "2" }',          // string where a number belongs
    '{ "maxRounds": 2.5 }',
    '{ "maxRounds": -1 }',
    '{ "maxCostUsd": -0.01 }',
    `{ "maxRounds": ${MAX_ROUNDS_CEILING + 1} }`,
    `{ "maxCostUsd": ${MAX_COST_CEILING_USD + 1} }`,
    '{ "requireDryRun": "false" }',  // truthy string — the dangerous coercion
    '{ "requireDryRun": 1 }',
    '{ "allowMcp": "no" }',
    '{ "forbidTools": {} }',
    '{ "forbidTools": ["read_file", 42] }',
    '{ "forbidTools": [""] }',
  ];
  for (const text of broken) {
    const r = loadPolicy({ workspaceText: text });
    assert.strictEqual(r.ok, false, `${JSON.stringify(text)} must be refused`);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
  }
});

test('⭐ an unknown key is an error — a misspelled cap reads exactly like a cap', () => {
  const r = loadPolicy({ workspaceText: '{ "maxRoundz": 2 }' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown setting "maxRoundz"/);
  // And the error lists what was available, so the fix is one read away.
  assert.match(r.error, /maxRounds/);
});

test('⚠️ a bare string where a list belongs is refused, not iterated character by character', () => {
  const r = loadPolicy({ workspaceText: '{ "forbidTools": "run_command" }' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /must be an array of strings/);
  assert.match(r.error, /\["run_command"\]/, 'the error must show the fix');
});

test('⭐ a tool name that cannot match is refused — "run_commands" forbids nothing', () => {
  const r = loadPolicy({ workspaceText: '{ "forbidTools": ["run_commands"] }' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not a tool this agent has/);
  assert.match(r.error, /run_command/, 'the near miss must be named');
});

test('an MCP tool name is validated by shape, because its registry does not exist yet', () => {
  assert.strictEqual(loadPolicy({ workspaceText: '{ "forbidTools": ["mcp__linear__create_issue"] }' }).ok, true);
  const bad = loadPolicy({ workspaceText: '{ "forbidTools": ["mcp_linear_create"] }' });
  assert.strictEqual(bad.ok, false, 'a near-miss prefix must not sail through as an unknown local tool');
});

test('an empty policy object is valid and restricts nothing', () => {
  const p = ws({});
  assert.deepStrictEqual(p.forbidTools, []);
  assert.strictEqual(p.maxRounds, null);
  assert.strictEqual(p.allowMcp, true);
  assert.deepStrictEqual(describePolicy(p), [], 'an unconfigured user sees no policy line at all');
});

test('the built-in default is the identity of the lattice — adding policy changes nothing', () => {
  for (const name of TOOL_NAMES) assert.strictEqual(toolDecision(OPEN_POLICY, name).allowed, true);
  assert.strictEqual(modelDecision(OPEN_POLICY, 'anything/at-all').allowed, true);
  assert.strictEqual(roundBudget(OPEN_POLICY, 8).rounds, 8);
  assert.strictEqual(costDecision(OPEN_POLICY, { spentUsd: 999, roundsUsed: 9 }).stop, false);
  assert.strictEqual(mcpDecision(OPEN_POLICY).allowed, true);
  assert.strictEqual(invocationDecision(OPEN_POLICY, { dryRun: false, maxRounds: 8 }).ok, true);
});

// ── tools ──────────────────────────────────────────────────────────────────

test('forbidTools removes a verb from the offer AND from dispatch', () => {
  const p = ws({ forbidTools: ['run_command', 'delete_file'] });
  const offered = filterToolNames(p, toolNamesForRounds(3, { allowRun: true, env: {} }));
  assert.ok(!offered.includes('run_command'));
  assert.ok(!offered.includes('delete_file'));
  assert.ok(offered.includes('write_file'), 'everything unmentioned survives');
  // ⚠️ The dispatch check is the one that matters: a model can emit a call for a
  // tool it was never shown.
  assert.strictEqual(toolDecision(p, 'run_command').allowed, false);
  assert.match(toolDecision(p, 'run_command').reason, /policy forbids run_command/);
});

test('allowTools is a whitelist, and it intersects rather than replaces', () => {
  const r = loadPolicy({
    adminText: JSON.stringify({ allowTools: ['read_file', 'write_file', 'list_dir'] }),
    workspaceText: JSON.stringify({ allowTools: ['read_file', 'run_command'] }),
  });
  assert.deepStrictEqual(r.policy.allowTools, ['read_file'], 'run_command was never on the admin list');
  assert.strictEqual(toolDecision(r.policy, 'write_file').allowed, false);
  assert.strictEqual(toolDecision(r.policy, 'read_file').allowed, true);
});

test('forbid beats allow when both name the same tool', () => {
  const p = ws({ allowTools: ['read_file', 'write_file'], forbidTools: ['write_file'] });
  assert.strictEqual(toolDecision(p, 'write_file').allowed, false);
});

test('`*` works on both sides, and an unnamed tool call is always refused', () => {
  assert.strictEqual(toolDecision(ws({ forbidTools: ['*'] }), 'read_file').allowed, false);
  assert.strictEqual(toolDecision(ws({ allowTools: ['*'] }), 'read_file').allowed, true);
  assert.strictEqual(toolDecision(OPEN_POLICY, '').allowed, false);
  assert.strictEqual(toolDecision(OPEN_POLICY, undefined).allowed, false);
});

test('filtering preserves order, because the order is a hint the model reads', () => {
  const p = ws({ forbidTools: ['list_dir'] });
  assert.deepStrictEqual(
    filterToolNames(p, ['read_file', 'list_dir', 'edit_file', 'write_file']),
    ['read_file', 'edit_file', 'write_file'],
  );
});

// ── models ─────────────────────────────────────────────────────────────────

test('model patterns are exact, vendor-prefixed, or `*` — and nothing else', () => {
  assert.ok(matchesModelPattern('*', 'anything'));
  assert.ok(matchesModelPattern('deepseek/*', 'deepseek/deepseek-v4-flash-0731'));
  assert.ok(!matchesModelPattern('deepseek/*', 'openai/gpt-5'));
  assert.ok(matchesModelPattern('z-ai/glm-4.6', 'z-ai/glm-4.6'));
  assert.ok(!matchesModelPattern('z-ai/glm-4.6', 'z-ai/glm-4.6-air'));
  // ⚠️ A regex in the file is DATA, never a pattern — no compilation, no
  // catastrophic backtracking, no match.
  assert.ok(!matchesModelPattern('.*', 'openai/gpt-5'));
  assert.ok(!matchesModelPattern('(a+)+b', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaac'));
});

test('⚠️ intersecting whitelists is over what they MATCH, not how they are spelled', () => {
  // The naive `Set.has` version made these empty — nothing allowed at all.
  const widened = loadPolicy({
    adminText: JSON.stringify({ allowModels: ['deepseek/*'] }),
    workspaceText: JSON.stringify({ allowModels: ['*'] }),
  }).policy;
  assert.strictEqual(modelDecision(widened, 'deepseek/deepseek-chat').allowed, true);
  assert.strictEqual(modelDecision(widened, 'openai/gpt-5').allowed, false);

  const narrowed = loadPolicy({
    adminText: JSON.stringify({ allowModels: ['deepseek/*'] }),
    workspaceText: JSON.stringify({ allowModels: ['deepseek/deepseek-chat', 'openai/gpt-5'] }),
  }).policy;
  assert.deepStrictEqual(narrowed.allowModels, ['deepseek/deepseek-chat']);

  // Genuinely disjoint whitelists intersect to nothing, and nothing means nothing.
  const disjoint = loadPolicy({
    adminText: JSON.stringify({ allowModels: ['openai/*'] }),
    workspaceText: JSON.stringify({ allowModels: ['deepseek/*'] }),
  }).policy;
  assert.deepStrictEqual(disjoint.allowModels, []);
  assert.strictEqual(modelDecision(disjoint, 'deepseek/deepseek-chat').allowed, false);
  assert.strictEqual(modelDecision(disjoint, 'openai/gpt-5').allowed, false);
});

test('denyModels beats allowModels, and both survive the merge', () => {
  const r = loadPolicy({
    adminText: JSON.stringify({ denyModels: ['openai/*'] }),
    workspaceText: JSON.stringify({ allowModels: ['openai/gpt-5', 'deepseek/deepseek-chat'] }),
  });
  assert.strictEqual(modelDecision(r.policy, 'openai/gpt-5').allowed, false, 'an explicit deny outranks a local allow');
  assert.strictEqual(modelDecision(r.policy, 'deepseek/deepseek-chat').allowed, true);
  assert.strictEqual(modelDecision(r.policy, 'z-ai/glm-4.6').allowed, false, 'not on the whitelist');
});

test('⚠️ the whitelist must reject the chain\'s built-in fallbacks, not just the primary', () => {
  // buildChain appends deepseek/deepseek-chat, z-ai/glm-4.6 and qwen3.7-flash
  // whether or not anyone asked for them — a jurisdiction rule enforced only on
  // the requested model is not enforced at all.
  const p = ws({ allowModels: ['openai/*'] });
  for (const fallback of ['deepseek/deepseek-chat', 'z-ai/glm-4.6', 'qwen/qwen3.7-flash']) {
    assert.strictEqual(modelDecision(p, fallback).allowed, false, `${fallback} must be refused`);
  }
  assert.strictEqual(modelDecision(p, '').allowed, false);
});

// ── rounds ─────────────────────────────────────────────────────────────────

test('a round cap lowers a request and never raises one', () => {
  const p = ws({ maxRounds: 2 });
  assert.deepStrictEqual(roundBudget(p, 8), { rounds: 2, capped: true, reason: 'policy caps rounds at 2 (you asked for 8)' });
  assert.strictEqual(roundBudget(p, 1).rounds, 1, 'a policy is a limit, not a default');
  assert.strictEqual(roundBudget(p, 1).capped, false);
  assert.strictEqual(roundBudget(p, 2).capped, false, 'exactly at the cap is not capped');
});

test('maxRounds: 0 is a real statement, not an absent one', () => {
  const p = ws({ maxRounds: 0 });
  assert.strictEqual(p.maxRounds, 0);
  assert.strictEqual(roundBudget(p, 3).rounds, 0);
});

// ── cost ───────────────────────────────────────────────────────────────────

test('⭐ the cost cap stops BEFORE the round that would cross it', () => {
  const p = ws({ maxCostUsd: 0.01 });
  // Under the cap with a cheap history: keep going.
  assert.strictEqual(costDecision(p, { spentUsd: 0.002, roundsUsed: 1, lastRoundUsd: 0.002 }).stop, false);
  // Still under, but the next round would cross it. A cap checked only after the
  // fact is a cap that is always breached once.
  const d = costDecision(p, { spentUsd: 0.009, roundsUsed: 3, lastRoundUsd: 0.004 });
  assert.strictEqual(d.stop, true);
  assert.match(d.reason, /would cost about/);
  // And at or over the cap, unconditionally.
  assert.strictEqual(costDecision(p, { spentUsd: 0.01, roundsUsed: 4 }).stop, true);
  assert.strictEqual(costDecision(p, { spentUsd: 0.5, roundsUsed: 4 }).stop, true);
});

test('⚠️⚠️ a provider that reports NO cost must not read as free', () => {
  const p = ws({ maxCostUsd: 5 });
  // aggregateUsage returns null when nothing reported usage; null through
  // arithmetic is 0, which would sit under a $5 cap forever.
  for (const spentUsd of [null, undefined, NaN, 'free']) {
    const d = costDecision(p, { spentUsd, roundsUsed: 2 });
    assert.strictEqual(d.stop, true, `${String(spentUsd)} must not count as $0`);
    assert.match(d.reason, /cannot be enforced/);
  }
  // ...but the first round is allowed, because you cannot learn whether a
  // provider reports cost without spending one.
  assert.strictEqual(costDecision(p, { spentUsd: null, roundsUsed: 0 }).stop, false);
});

test('maxCostUsd: 0 means spend nothing, and it is not treated as absent', () => {
  const p = ws({ maxCostUsd: 0 });
  assert.strictEqual(p.maxCostUsd, 0);
  assert.strictEqual(costDecision(p, { spentUsd: 0, roundsUsed: 1 }).stop, true);
});

test('no cap means no cost decision at all, even with unknown usage', () => {
  assert.strictEqual(costDecision(OPEN_POLICY, { spentUsd: null, roundsUsed: 7 }).stop, false);
});

// ── MCP + invocation ───────────────────────────────────────────────────────

test('allowMcp:false anywhere disables MCP everywhere', () => {
  const r = loadPolicy({
    adminText: JSON.stringify({ allowMcp: false }),
    workspaceText: JSON.stringify({ allowMcp: true }),
  });
  assert.strictEqual(mcpDecision(r.policy).allowed, false);
  assert.match(mcpDecision(r.policy).reason, /no server is spawned/);
});

test('⭐ requireDryRun REFUSES the run rather than quietly doing a different job', () => {
  const p = ws({ requireDryRun: true });
  const bad = invocationDecision(p, { dryRun: false, maxRounds: 3 });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.violations[0], /--dry-run/);
  assert.strictEqual(invocationDecision(p, { dryRun: true, maxRounds: 3 }).ok, true);
});

test('an over-budget round count is a NOTE, a denied model is a VIOLATION', () => {
  const p = ws({ maxRounds: 2, allowModels: ['deepseek/*'] });
  const d = invocationDecision(p, { dryRun: false, maxRounds: 8, model: 'openai/gpt-5' });
  assert.strictEqual(d.ok, false);
  assert.ok(d.violations.some((v) => /openai\/gpt-5/.test(v)));
  assert.ok(d.notes.some((n) => /caps rounds at 2/.test(n)));

  const ok = invocationDecision(p, { dryRun: false, maxRounds: 8, model: 'deepseek/deepseek-chat' });
  assert.strictEqual(ok.ok, true, 'a clamped budget is not a refusal');
  assert.strictEqual(ok.notes.length, 1);
});

test('forbidding run_command while --no-run was not passed is surfaced, not silently reconciled', () => {
  const d = invocationDecision(ws({ forbidTools: ['run_command'] }), { allowRun: true, dryRun: false });
  assert.ok(d.notes.some((n) => /nothing will be executed/.test(n)));
  assert.strictEqual(d.ok, true);
});

// ── the file itself ────────────────────────────────────────────────────────

test('⭐ the .acuvo directory is not the agent\'s to write to', () => {
  for (const p of ['.acuvo', '.acuvo/policy.json', '.acuvo/mcp.json', '.acuvo/nested/thing.txt']) {
    assert.strictEqual(isPolicyProtectedPath(p), true, `${p} must be protected`);
  }
  for (const p of ['src/app.js', 'acuvo.json', '.acuvorc', 'docs/.acuvo-notes.md', '']) {
    assert.strictEqual(isPolicyProtectedPath(p), false, `${p} must not be`);
  }
  assert.strictEqual(isPolicyProtectedPath(null), false);
});

test('the fingerprint is stable, order-independent, and changes when a rule changes', () => {
  const a = ws({ forbidTools: ['run_command', 'delete_file'], maxRounds: 2 });
  const b = ws({ forbidTools: ['delete_file', 'run_command'], maxRounds: 2 });
  assert.strictEqual(policyFingerprint(a), policyFingerprint(b), 'list order must not change the id');
  assert.notStrictEqual(policyFingerprint(a), policyFingerprint(ws({ forbidTools: ['run_command'], maxRounds: 2 })));
  assert.match(policyFingerprint(a), /^[0-9a-f]{8}$/);
});

test('⭐ a policy in force is printable, and names where each rule came from', () => {
  const r = loadPolicy({
    adminText: JSON.stringify({ forbidTools: ['run_command'], allowMcp: false }),
    adminLabel: '/etc/acuvo/policy.json',
    workspaceText: JSON.stringify({ maxCostUsd: 0.25 }),
  });
  const lines = describePolicy(r.policy);
  assert.ok(lines[0].includes('/etc/acuvo/policy.json'));
  assert.ok(lines[0].includes(WORKSPACE_POLICY_FILE));
  const body = lines.join('\n');
  assert.match(body, /tools forbidden: run_command/);
  assert.match(body, /MCP disabled/);
  assert.match(body, /\$0\.25 per run/);
});

// ── the one function that touches a disk ───────────────────────────────────

test('⚠️ absent is not malformed — a missing policy file is the normal case', () => {
  const enoent = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
  const r = readPolicySources('/repo', { env: {}, home: '/home/dev', readFileImpl: enoent });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.adminText, null);
  assert.strictEqual(r.workspaceText, null);
  assert.strictEqual(loadPolicy(r).ok, true);
});

test('⚠️ present-but-unreadable is a BROKEN CONTROL and stops the run', () => {
  const denied = () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; };
  const r = readPolicySources('/repo', { env: {}, home: '/home/dev', readFileImpl: denied });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /could not be read/);
});

test(`⚠️ ${USER_POLICY_ENV} pointing at nothing is an error; an absent ~/${USER_POLICY_FILE} is not`, () => {
  const enoent = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
  const bad = readPolicySources('/repo', { env: { [USER_POLICY_ENV]: '/etc/typo.json' }, readFileImpl: enoent });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /does not exist/);

  const fine = readPolicySources('/repo', { env: {}, home: '/home/dev', readFileImpl: enoent });
  assert.strictEqual(fine.ok, true);
});

test('both layers are read from the right places and labelled honestly', () => {
  const seen = [];
  const read = (abs) => {
    seen.push(abs);
    if (abs === '/etc/acuvo.json') return '{"maxRounds": 4}';
    if (abs === '/repo/.acuvo/policy.json') return '{"maxRounds": 2}';
    const e = new Error('nope'); e.code = 'ENOENT'; throw e;
  };
  const r = readPolicySources('/repo', { env: { [USER_POLICY_ENV]: '/etc/acuvo.json' }, home: '/home/dev', readFileImpl: read });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(seen, ['/etc/acuvo.json', '/repo/.acuvo/policy.json']);
  assert.strictEqual(r.adminLabel, '/etc/acuvo.json');
  assert.strictEqual(r.workspaceLabel, WORKSPACE_POLICY_FILE);

  const loaded = loadPolicy(r);
  assert.strictEqual(loaded.policy.maxRounds, 2);
  assert.deepStrictEqual(loaded.policy.sources.map((s) => s.trusted), [true, false]);
});

test('the env override replaces the home path rather than adding a third layer', () => {
  const seen = [];
  const read = (abs) => { seen.push(abs); const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
  readPolicySources('/repo', { env: { [USER_POLICY_ENV]: '/etc/acuvo.json' }, home: '/home/dev', readFileImpl: read }).ok;
  assert.ok(!seen.some((p) => p.includes('/home/dev')), 'the home file is not also consulted');
});

test('readPolicySources refuses to invent a reader', () => {
  assert.strictEqual(readPolicySources('/repo', { env: {} }).ok, false);
});

// ── parse-level details worth pinning ──────────────────────────────────────

test('a partial document states only what it said — silence is not a permissive value', () => {
  const r = parsePolicyDocument('{"maxRounds": 3}');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.policy), ['maxRounds']);
  // Which is what lets a later layer's cap survive: merging a document that
  // never mentioned maxCostUsd must not reset another layer's cost cap.
  const merged = loadPolicy({
    adminText: JSON.stringify({ maxCostUsd: 0.1 }),
    workspaceText: JSON.stringify({ maxRounds: 3 }),
  });
  assert.strictEqual(merged.policy.maxCostUsd, 0.1);
  assert.strictEqual(merged.policy.maxRounds, 3);
});

test('values are trimmed but never coerced', () => {
  const r = parsePolicyDocument('{"denyModels": ["  openai/*  "]}');
  assert.deepStrictEqual(r.policy.denyModels, ['openai/*']);
});
