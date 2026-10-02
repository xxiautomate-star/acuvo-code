/**
 * ── ⚠️⚠️⭐ FIVE DEAD SERVERS TOOK HALF THE SCREEN BEFORE THE FIRST QUESTION ──
 *
 * MEASURED 2026-09-21, a real run of this CLI at a monorepo root: EIGHT MCP
 * servers configured for OTHER projects were started, FIVE failed, and their
 * red result lines — each carrying a truncated stack trace — filled the terminal
 * before the model had been asked anything. Every line was true. Together they
 * buried the run.
 *
 *     ✖ github unavailable: Connection closed
 *     ✖ apify unavailable: TypeError dialing https://mcp.apify.com/ (ECONNRESET)
 *     ✖ blender unavailable: Connection closed
 *     …
 *
 * ⭐ THE FIX IS A SUMMARY, NOT A DELETION, AND THE DIFFERENCE IS THE WHOLE
 * TEST. A collapsed line that loses the NAMES would leave somebody unable to
 * tell which capability the run does not have; `ACUVO_MCP_VERBOSE=1` brings the
 * errors back.
 *
 * ⚠️ AND `mcp-start` IS DELIBERATELY NOT COLLAPSED. It is printed BEFORE the
 * spawn and names the binary a repository chose to run as you. Its own comment
 * in `turn.mjs` prices that: *"a record that only survives the benign case is
 * not a record."* Collapsing a security disclosure to save a line is a
 * different trade from collapsing a result, and it is not one a terminal
 * should make on its own.
 *
 * ── ⚠️ MUTATION-PROVEN (each restored, `git diff` clean afterwards) ─────────
 *   M1  the `if (!MCP_VERBOSE) return [];` guard deleted
 *       → "eight servers do not cost eight lines" RED.
 *   M2  the `mcp-summary` emit deleted from `runSession`
 *       → "the summary actually reaches the terminal" RED.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderEvent, connectAllServers } from '../lib/turn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The measured fleet: eight configured, three up, five dead. */
const FLEET = [
  { name: 'spine', ok: true, tools: new Array(12).fill(0) },
  { name: 'figma', ok: true, tools: new Array(9).fill(0) },
  { name: 'vercel', ok: true, tools: new Array(10).fill(0) },
  { name: 'github', ok: false, tools: [], error: 'Connection closed' },
  { name: 'apify', ok: false, tools: [], error: 'TypeError dialing https://mcp.apify.com/ (ECONNRESET)' },
  { name: 'blender', ok: false, tools: [], error: 'Connection closed' },
  { name: 'comfyui', ok: false, tools: [], error: 'Connection closed' },
  { name: 'context7', ok: false, tools: [], error: 'Connection closed' },
];

const summaryEvent = {
  type: 'mcp-summary',
  total: FLEET.length,
  connected: FLEET.filter((c) => c.ok).length,
  tools: FLEET.reduce((n, c) => n + (c.ok ? c.tools.length : 0), 0),
  failed: FLEET.filter((c) => !c.ok).map((c) => c.name),
};

test('⭐⭐⭐ THE MEASURED DEFECT: eight servers do not cost eight lines', () => {
  const lines = FLEET.flatMap((c) => renderEvent({
    type: 'mcp', name: c.name, ok: c.ok, count: c.tools.length, error: c.error,
  }));
  assert.deepEqual(lines, [], `${lines.length} per-server lines survived:\n${lines.join('\n')}`);

  const summary = renderEvent(summaryEvent);
  assert.equal(summary.length, 1, 'the summary is not one line');
  assert.match(summary[0], /3\/8 connected/);
});

test('⭐⭐ the NAMES survive — a count cannot be acted on and a name can', () => {
  const line = renderEvent(summaryEvent).join('');
  for (const dead of ['github', 'apify', 'blender', 'comfyui', 'context7']) {
    assert.ok(line.includes(dead), `"${dead}" failed and the user was never told which one`);
  }
  assert.match(line, /5 failed/);
  // And the way back to the detail is on the line itself.
  assert.match(line, /ACUVO_MCP_VERBOSE/);
});

test('⚠️ a fleet that all came up says so quietly, and offers no debugging hint', () => {
  const line = renderEvent({ type: 'mcp-summary', total: 2, connected: 2, tools: 7, failed: [] }).join('');
  assert.match(line, /2\/2 connected/);
  assert.match(line, /7 tools/);
  assert.ok(!/failed/.test(line));
  assert.ok(!/ACUVO_MCP_VERBOSE/.test(line), 'nothing went wrong — do not advertise a debug flag');
});

test('⚠️⚠️ the CONSENT refusal is never collapsed — it is the only line that says how to proceed', () => {
  const reason = 'this repo ships .mcp.json and nobody has agreed to it — run acuvo --trust-mcp';
  const out = renderEvent({ type: 'mcp', name: 'consent', ok: false, count: 0, error: reason }).join('\n');
  assert.match(out, /--trust-mcp/, 'a refusal that does not fit its own instructions is useless');
});

test('⚠️⚠️ `mcp-start` is NOT collapsed — it names the binary before the spawn', () => {
  const out = renderEvent({
    type: 'mcp-start', name: 'evil', command: 'node', args: ['evil.cjs'], env: [],
  }).join('\n');
  assert.match(out, /evil\.cjs/, 'the pre-spawn disclosure was collapsed away with the results');
});

test('⭐ ACUVO_MCP_VERBOSE=1 brings every error back — the detail is hidden, not deleted', () => {
  /**
   * ⚠️ A CHILD PROCESS, because the flag is read at module load exactly as
   * `paint` is. Setting `process.env` in-process would prove nothing about
   * what a user actually gets.
   */
  const script = [
    "import { renderEvent } from './lib/turn.mjs';",
    "process.stdout.write(JSON.stringify([",
    "  renderEvent({ type: 'mcp', name: 'github', ok: false, count: 0, error: 'Connection closed' }),",
    "  renderEvent({ type: 'mcp', name: 'spine', ok: true, count: 12 }),",
    "]));",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: join(HERE, '..'),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ACUVO_MCP_VERBOSE: '1' },
  });
  assert.equal(r.status, 0, `the child failed:\n${r.stderr}`);
  const [failed, connected] = JSON.parse(r.stdout);
  assert.match(failed.join(''), /github unavailable: Connection closed/);
  assert.match(connected.join(''), /spine connected \(12 tools\)/);
});

/**
 * ── ⭐⭐⭐ REACH: THE SUMMARY IS EMITTED BY A REAL `runSession`, NOT BY ME ────
 *
 * ⚠️ EVERY TEST ABOVE WOULD STAY GREEN IF `runSession` NEVER EMITTED THE
 * EVENT. This package has shipped built-and-unreached repeatedly, and a
 * renderer for an event nobody sends is exactly that shape — the collapse
 * would then simply DELETE the per-server lines and print nothing at all,
 * which is strictly worse than the noise it replaced.
 *
 * ⚠️ TWO SERVERS THAT CANNOT START, ON PURPOSE. `node -e process.exit(1)` is
 * local, needs no network and no key, and reproduces the measured shape: the
 * failure path is the one that produced half a screen.
 */
test('⭐⭐⭐ REACH: a real runSession emits the summary, and the failures print nothing', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { runSession } = await import('../lib/turn.mjs');
  const { createLocalExecutor } = await import('../lib/workspace.mjs');

  const root = mkdtempSync(join(tmpdir(), 'acuvo-mcp-noise-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'mcp.json'), JSON.stringify({
    mcpServers: {
      alpha: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
      beta: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
    },
  }));
  writeFileSync(join(root, 'package.json'), '{"name":"x","version":"1.0.0"}\n');

  const events = [];
  process.env.ACUVO_TRUST_MCP = '1';
  try {
    await runSession({
      task: 'say hello',
      executor: createLocalExecutor(root),
      config: { apiKey: 'x', model: 'fake/model' },
      maxRounds: 2,
      allowRun: true,
      onEvent: (e) => events.push(e),
      callModelImpl: async () => ({
        ok: true, content: 'hello', toolCalls: [], finishReason: 'stop',
        usage: { cost: 0, total_tokens: 5 }, model: 'fake/model',
      }),
    });
  } finally {
    delete process.env.ACUVO_TRUST_MCP;
    rmSync(root, { recursive: true, force: true });
  }

  const summaries = events.filter((e) => e.type === 'mcp-summary');
  assert.equal(summaries.length, 1, 'runSession never emitted the summary — the collapse deletes rather than replaces');
  assert.equal(summaries[0].total, 2);
  assert.equal(summaries[0].connected, 0);
  assert.deepEqual([...summaries[0].failed].sort(), ['alpha', 'beta']);

  // And what a person would actually see: one line for the fleet, none per server.
  const perServer = events.filter((e) => e.type === 'mcp' && e.name !== 'consent').flatMap(renderEvent);
  assert.deepEqual(perServer, [], `per-server lines printed:\n${perServer.join('\n')}`);
  assert.match(renderEvent(summaries[0]).join(''), /0\/2 connected.*alpha, beta/);
});

test('⚠️ `connectAllServers` still emits ONE event per server — the summary is the caller\'s', async () => {
  /**
   * The summary is a property of the FLEET, so it belongs to the caller that
   * has the fleet. Moving it inside this function would break the contract
   * `mcp-connect-parallel.test.mjs` pins and make the per-server events
   * untestable without eight real servers.
   */
  const events = [];
  await connectAllServers([{ name: 'a' }, { name: 'b' }], {
    root: '/tmp',
    onEvent: (e) => events.push(e),
    connectImpl: async (srv) => ({ ok: true, name: srv.name, tools: [] }),
  });
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.type === 'mcp'), 'connectAllServers grew a second event type');
});
