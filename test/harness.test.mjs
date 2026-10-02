/**
 * ── ⭐⭐ `--harness` — THE GUARDS THAT HAD TO BITE ───────────────────────────
 *
 * Every assertion here was written against a defect that was REAL in this
 * feature at some point today, not against a happy path:
 *
 *   · §2 `normaliseUsage` — the translation whose absence prices a real round
 *     at zero, silently. Asserted THROUGH `budget.splitFromUsage`, because a
 *     restatement of the field names would go green while the two drifted.
 *   · §3 `latestUsage` — codex's usage is the thread's RUNNING TOTAL, so
 *     summing double-counts. Invisible on the one-turn run everybody tests.
 *   · §5 the SSE reader — an event split mid-JSON across a chunk boundary,
 *     which is what a real provider under load does and localhost never does.
 *   · §6 `countAcuvoTools` — codex nests MCP verbs in a `namespace`, so a flat
 *     count reports 1 for a server offering ten AND for one offering none.
 *   · §7 the gate — the half a log reader cannot do: refuse BEFORE spending.
 *   · §9 the task never reaches argv, so no shell can ever parse it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveHarness, normaliseUsage, latestUsage, createJsonlReader,
  usageFromEvent, describeEvent, HARNESS_IDS,
} from '../lib/harness.mjs';
import {
  startMeterProxy, createSseUsageReader, resolveUpstreamUrl,
  secretMatches, countAcuvoTools, FORWARDABLE,
} from '../lib/harness-meter.mjs';
import { chooseMode, buildCodexArgs, HARNESS_NOISE, CHILD_KEY_ENV, UPSTREAM_KEY_ENV } from '../lib/harness-run.mjs';
import { splitFromUsage, createBudget } from '../lib/budget.mjs';

/* ═══ §1 resolveHarness — the honest refusal ══════════════════════════════ */

test('§1 an unknown harness names the ones that exist', () => {
  const r = resolveHarness('claude-code', { env: { PATH: '' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown');
  for (const id of HARNESS_IDS) assert.match(r.message, new RegExp(id));
});

test('§1 a missing binary says what to install, and why it is not bundled', () => {
  const r = resolveHarness('codex', { env: { PATH: '/nowhere' }, platform: 'linux' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-installed');
  // The one line that changes the situation — `check_tools`' contract.
  assert.match(r.message, /npm i -g @openai\/codex/);
  // ⚠️ And WHY, or a user concludes the feature is broken rather than external.
  assert.match(r.message, /zero dependencies/i);
  assert.match(r.message, /Apache-2\.0/);
});

test('§1 ⚠️ a Windows .cmd shim resolves to the package JS entry, never a shell', () => {
  const env = { PATH: 'C:\\npm', PATHEXT: '.COM;.EXE;.CMD' };
  // Only the shim and the sibling entry exist.
  const present = new Set([
    'C:\\npm\\codex.CMD',
    'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
  ]);
  const r = resolveHarness('codex', {
    env,
    platform: 'win32',
    exists: (p) => present.has(p),
    // ⚠️ The real `probe` reads the real disk, so the shim branch would never
    // execute here and this guard would pass while checking nothing.
    probeImpl: () => ({ installed: true, spawnable: false }),
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.via, 'node-entry');
  // ⭐ THE WHOLE POINT: we spawn node, not the shim, so there is no cmd.exe.
  assert.equal(r.command, process.execPath);
  assert.deepEqual(r.args, ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js']);
});

test('§1 ⚠️ a shim with no resolvable entry REFUSES rather than claiming "installed"', () => {
  const r = resolveHarness('codex', {
    env: { PATH: 'C:\\npm', PATHEXT: '.CMD' },
    platform: 'win32',
    exists: (p) => p === 'C:\\npm\\codex.CMD',
    probeImpl: () => ({ installed: true, spawnable: false }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'shim-not-spawnable');
  assert.match(r.message, /CVE-2024-27980/);
  // It must explain the refusal to shell out, not silently do it.
  assert.match(r.message, /injection/i);
});

/* ═══ §2 the translation that makes metering work ═════════════════════════ */

test('§2 ⭐⭐ codex usage becomes something budget.splitFromUsage can PRICE', () => {
  // The exact shape codex 0.130.0 emits, measured.
  const codex = {
    input_tokens: 12345, cached_input_tokens: 10000,
    output_tokens: 678, reasoning_output_tokens: 100,
  };
  const raw = splitFromUsage(codex);
  // ⚠️⚠️ THE DEFECT, PINNED: fed raw, the governor cannot read it at all, and a
  // real round is priced by projection instead of by its tokens.
  assert.equal(raw, null, 'codex spelling must be unreadable to the governor — that is why the translation exists');

  const ours = normaliseUsage(codex);
  const split = splitFromUsage(ours);
  assert.notEqual(split, null, 'after translation the governor must be able to price it');
  assert.equal(split.prompt, 12345);
  assert.equal(split.cached, 10000);
  assert.equal(split.fresh, 2345);
  assert.equal(split.completion, 678);
});

test('§2 the Responses-API wire spelling reads identically to codex JSONL', () => {
  const wire = normaliseUsage({
    input_tokens: 900, input_tokens_details: { cached_tokens: 400 }, output_tokens: 20,
  });
  const jsonl = normaliseUsage({ input_tokens: 900, cached_input_tokens: 400, output_tokens: 20 });
  assert.deepEqual(wire, jsonl, 'the proxy and stdout paths must not disagree about what a run cost');
});

test('§2 ⚠️ cached is clamped to input, so a bad provider cannot UNDER-bill', () => {
  const u = normaliseUsage({ input_tokens: 100, cached_input_tokens: 5000, output_tokens: 1 });
  assert.equal(u.prompt_tokens_details.cached_tokens, 100);
  const split = splitFromUsage(u);
  assert.equal(split.fresh, 0, 'fresh input can never go negative');
});

test('§2 unreadable usage is null, never a zeroed object', () => {
  assert.equal(normaliseUsage(null), null);
  assert.equal(normaliseUsage({}), null);
  assert.equal(normaliseUsage({ input_tokens: 5 }), null, 'half a usage block is not a usage block');
});

/* ═══ §3 cumulative, not per-turn ═════════════════════════════════════════ */

test('§3 ⚠️⚠️ codex usage is CUMULATIVE — the fold takes the last, never the sum', () => {
  const readings = [
    normaliseUsage({ input_tokens: 10_000, cached_input_tokens: 0, output_tokens: 100 }),
    normaliseUsage({ input_tokens: 25_000, cached_input_tokens: 9_000, output_tokens: 400 }),
  ];
  const last = latestUsage(readings);
  assert.equal(last.prompt_tokens, 25_000);
  const summed = readings.reduce((a, b) => a + b.prompt_tokens, 0);
  assert.equal(summed, 35_000);
  assert.notEqual(last.prompt_tokens, summed, 'summing a running total over-reports every multi-turn run');
  assert.equal(latestUsage([]), null);
});

test('§3 usageFromEvent only reads turn.completed', () => {
  assert.equal(usageFromEvent({ type: 'turn.started' }), null);
  const u = usageFromEvent({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 } });
  assert.equal(u.prompt_tokens, 5);
});

/* ═══ §4 JSONL across chunk boundaries ════════════════════════════════════ */

test('§4 ⚠️ a JSON object split across two chunks is still ONE event', () => {
  const r = createJsonlReader();
  const line = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 2 } });
  const cut = Math.floor(line.length / 2);
  assert.deepEqual(r.push(line.slice(0, cut)), [], 'a partial line yields nothing yet');
  const got = r.push(`${line.slice(cut)}\n`);
  assert.equal(got.length, 1);
  assert.equal(got[0].event.type, 'turn.completed');
});

test('§4 a non-JSON line is surfaced as text, never dropped', () => {
  const r = createJsonlReader();
  const got = r.push('some human warning\n');
  assert.equal(got[0].kind, 'text');
  assert.equal(got[0].text, 'some human warning');
});

test('§4 a final line with no trailing newline survives flush', () => {
  const r = createJsonlReader();
  r.push('{"type":"turn.started"}');
  const got = r.flush();
  assert.equal(got.length, 1);
  assert.equal(got[0].event.type, 'turn.started');
});

test('§4 describeEvent never silently drops an unknown type', () => {
  const d = describeEvent({ type: 'some.future.event' });
  assert.notEqual(d, null);
  assert.match(d.text, /some\.future\.event/);
});

/* ═══ §5 the SSE reader ═══════════════════════════════════════════════════ */

function sseCompleted(usage) {
  return `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n\n`;
}

test('§5 ⚠️⚠️ an SSE event split mid-JSON across chunks is still read', () => {
  const r = createSseUsageReader();
  const block = sseCompleted({ input_tokens: 1000, input_tokens_details: { cached_tokens: 250 }, output_tokens: 50 });
  const cut = Math.floor(block.length / 2);
  assert.deepEqual(r.push(block.slice(0, cut)), [], 'half an event is not an event');
  const got = r.push(block.slice(cut));
  assert.equal(got.length, 1);
  assert.equal(got[0].prompt_tokens, 1000);
  assert.equal(got[0].prompt_tokens_details.cached_tokens, 250);
});

test('§5 ⚠️ a multi-line data: payload is concatenated, not truncated to line one', () => {
  const payload = JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 42, output_tokens: 7 } } });
  const half = Math.floor(payload.length / 2);
  // The SSE spec allows the payload to be split over several data: lines.
  const block = `event: response.completed\ndata: ${payload.slice(0, half)}\ndata: ${payload.slice(half)}\n\n`;
  const r = createSseUsageReader();
  const got = r.push(block);
  assert.equal(got.length, 1, 'taking only the first data: line yields invalid JSON and no usage at all');
  assert.equal(got[0].prompt_tokens, 42);
});

test('§5 [DONE] and unparseable blocks yield nothing rather than throwing', () => {
  const r = createSseUsageReader();
  assert.deepEqual(r.push('data: [DONE]\n\n'), []);
  assert.deepEqual(r.push('data: not json\n\n'), []);
  assert.deepEqual(r.flush(), []);
});

/* ═══ §6 counting our own verbs ═══════════════════════════════════════════ */

test('§6 ⚠️⚠️ a namespace contributes its MEMBERS, not 1', () => {
  const body = JSON.stringify({
    tools: [
      { type: 'function', name: 'shell_command' },
      {
        type: 'namespace',
        name: 'mcp__acuvo__',
        tools: [{ name: 'read_file' }, { name: 'search_text' }, { name: 'list_dir' }],
      },
    ],
  });
  assert.equal(countAcuvoTools(body), 3, 'counting the outer entry reports 1 for ten verbs AND for none');
});

test('§6 a registered-but-empty acuvo server counts ZERO — the measured defect', () => {
  // This is exactly what shipped before `--root` was passed: server present,
  // namespace present, no verbs inside it.
  const body = JSON.stringify({ tools: [{ type: 'namespace', name: 'mcp__acuvo__', tools: [] }] });
  assert.equal(countAcuvoTools(body), 0);
});

test('§6 a body that is not JSON counts zero rather than throwing', () => {
  assert.equal(countAcuvoTools('<html>502</html>'), 0);
});

/* ═══ §7 the proxy: auth, allowlist, and the GATE ═════════════════════════ */

test('§7 the upstream path allowlist refuses anything it does not know', () => {
  assert.equal(resolveUpstreamUrl('/v1/responses', 'https://x/v1'), 'https://x/v1/responses');
  assert.equal(resolveUpstreamUrl('/responses', 'https://x/v1'), 'https://x/v1/responses');
  // ⚠️ traversal and unknown paths are refused, not concatenated
  assert.equal(resolveUpstreamUrl('/v1/../../admin', 'https://x/v1'), null);
  assert.equal(resolveUpstreamUrl('/anything', 'https://x/v1'), null);
  for (const p of FORWARDABLE) assert.notEqual(resolveUpstreamUrl(p, 'https://x/v1'), null);
});

test('§7 secretMatches rejects empty, short and wrong secrets', () => {
  assert.equal(secretMatches('', ''), false, 'an empty expected secret must never match');
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abc', 'abd'), false);
  assert.equal(secretMatches('abc', 'abcd'), false, 'unequal lengths must not throw');
});

test('§7 ⭐⭐ the GATE refuses BEFORE the request is forwarded — nothing is spent', async () => {
  let upstreamCalls = 0;
  const proxy = await startMeterProxy({
    apiKey: 'sk-real',
    upstream: 'https://upstream.invalid/v1',
    gate: () => ({ ok: false, message: 'acuvo: budget reached' }),
    fetchImpl: async () => { upstreamCalls += 1; return new Response('{}', { status: 200 }); },
  });
  try {
    const res = await fetch(`${proxy.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.secret}`, 'content-type': 'application/json' },
      body: '{"model":"m"}',
    });
    assert.equal(res.status, 402, 'a refused call must be 402, not a dropped socket');
    assert.match((await res.json()).error.message, /budget reached/);
    // ⭐ THE ASSERTION THE WHOLE PROXY EXISTS FOR.
    assert.equal(upstreamCalls, 0, 'the gate must stop the call at the wire, not merely record it');
  } finally { await proxy.close(); }
});

test('§7 ⭐ the child secret NEVER reaches upstream — the real key is swapped in', async () => {
  let seenAuth = null;
  const proxy = await startMeterProxy({
    apiKey: 'sk-THE-REAL-KEY',
    upstream: 'https://upstream.invalid/v1',
    fetchImpl: async (_url, init) => {
      seenAuth = init.headers.authorization;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    await fetch(`${proxy.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.secret}` },
      body: '{"model":"m"}',
    });
    assert.equal(seenAuth, 'Bearer sk-THE-REAL-KEY');
    assert.ok(!String(seenAuth).includes(proxy.secret), 'the throwaway must not travel upstream');
  } finally { await proxy.close(); }
});

test('§7 an unauthorised caller on the port is refused 401 and never forwarded', async () => {
  let calls = 0;
  const proxy = await startMeterProxy({
    apiKey: 'sk-real',
    fetchImpl: async () => { calls += 1; return new Response('{}'); },
  });
  try {
    const res = await fetch(`${proxy.baseUrl}/responses`, {
      method: 'POST', headers: { authorization: 'Bearer guessed' }, body: '{}',
    });
    assert.equal(res.status, 401);
    assert.equal(calls, 0, 'another process on the machine must not be able to spend our money');
  } finally { await proxy.close(); }
});

test('§7 ⭐⭐ usage read off the wire reaches budget.record and moves the ceiling', async () => {
  const budget = createBudget({ limitUsd: 1 });
  const before = budget.stats().spentUsd;
  const usage = { input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500_000 };
  const proxy = await startMeterProxy({
    apiKey: 'sk-real',
    onUsage: (u) => budget.record(u),
    fetchImpl: async () => new Response(sseCompleted(usage), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }),
  });
  try {
    await fetch(`${proxy.baseUrl}/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${proxy.secret}` }, body: '{}',
    });
    const after = budget.stats();
    assert.ok(after.spentUsd > before, 'a metered harness round must move the ceiling');
    assert.equal(after.rounds, 1, 'and must count as exactly one round');
  } finally { await proxy.close(); }
});

test('§7 ⚠️ the proxy binds to loopback only', async () => {
  const proxy = await startMeterProxy({ apiKey: 'k', fetchImpl: async () => new Response('{}') });
  try {
    assert.match(proxy.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  } finally { await proxy.close(); }
});

/* ═══ §8 mode choice — the honest half ════════════════════════════════════ */

test('§8 no key means UNMETERED, and the reason names the variable that fixes it', () => {
  const m = chooseMode({});
  assert.equal(m.metered, false);
  assert.match(m.why, new RegExp(UPSTREAM_KEY_ENV));
});

test('§8 an explicit harness key meters, and beats OPENAI_API_KEY', () => {
  const m = chooseMode({ [UPSTREAM_KEY_ENV]: 'sk-a', OPENAI_API_KEY: 'sk-b' });
  assert.equal(m.metered, true);
  assert.equal(m.apiKey, 'sk-a');
});

test('§8 OPENAI_API_KEY alone is enough to meter', () => {
  const m = chooseMode({ OPENAI_API_KEY: 'sk-b' });
  assert.equal(m.metered, true);
  assert.equal(m.apiKey, 'sk-b');
});

/* ═══ §9 the argv contract ════════════════════════════════════════════════ */

test('§9 ⚠️⚠️ wire_api is "responses" — "chat" makes codex 0.130.0 exit 1', () => {
  const args = buildCodexArgs({ cwd: '/w', proxy: { baseUrl: 'http://127.0.0.1:1/v1' } });
  assert.ok(args.includes('model_providers.acuvo.wire_api="responses"'));
  assert.ok(!args.some((a) => /wire_api="chat"/.test(a)), 'codex refuses to load a config containing it');
});

test('§9 ⭐ the MCP registration passes --root, or the server serves ZERO verbs', () => {
  const args = buildCodexArgs({ cwd: '/my/workspace', mcpServerPath: '/a/bin/acuvo-mcp.mjs' });
  const line = args.find((a) => a.startsWith('mcp_servers.acuvo.args='));
  assert.ok(line, 'the acuvo MCP server must be registered');
  assert.match(line, /--root/, 'without --root acuvo-mcp boots fine and offers nothing — measured');
  assert.match(line, /my\/workspace|my\\\\workspace/);
});

test('§9 the child is told to read a THROWAWAY variable, never the real key', () => {
  const args = buildCodexArgs({ cwd: '/w', proxy: { baseUrl: 'http://127.0.0.1:1/v1' } });
  assert.ok(args.includes(`model_providers.acuvo.env_key=${JSON.stringify(CHILD_KEY_ENV)}`));
  assert.ok(!args.some((a) => a.includes(UPSTREAM_KEY_ENV)), 'the real key variable must not be named to the child');
});

test('§9 ⭐⭐ the TASK never appears in argv — it goes down stdin', () => {
  const task = 'rm -rf / & echo "pwned" | cat';
  const args = buildCodexArgs({ cwd: '/w' });
  for (const a of args) {
    assert.ok(!a.includes(task), 'free text in argv is one shell:true away from injection');
    assert.ok(!a.includes('pwned'));
  }
});

test('§9 a run without a proxy configures no provider at all', () => {
  const args = buildCodexArgs({ cwd: '/w' });
  assert.ok(!args.some((a) => a.startsWith('model_provider=')), 'unmetered runs must use codex own auth untouched');
});

/* ═══ §10 the noise filter must not swallow a real error ══════════════════ */

test('§10 ⚠️ the noise list hides the three measured lines and NOTHING else', () => {
  const noisy = [
    'WARNING: proceeding, even though we could not update PATH: ...',
    'Reading prompt from stdin...',
    'SUCCESS: The process with PID 1234 (child process of PID 99) has been terminated.',
  ];
  for (const n of noisy) assert.ok(HARNESS_NOISE.some((re) => re.test(n)), `should be hidden: ${n}`);

  const real = [
    'Error loading config.toml: `wire_api = "chat"` is no longer supported.',
    'stream disconnected before completion',
    'required MCP servers failed to initialize: acuvo',
    'ERROR: The process could not be terminated.',
  ];
  for (const r of real) assert.ok(!HARNESS_NOISE.some((re) => re.test(r)), `must NOT be hidden: ${r}`);
});
