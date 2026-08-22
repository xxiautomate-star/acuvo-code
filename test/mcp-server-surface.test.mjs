/**
 * ── WHAT THIS FILE PINS: THE BOUNDARY, NOT THE PLUMBING ─────────────────────
 *
 * ⚠️ `lib/mcp-server.mjs` had ZERO tests before this file. Measured 2026-08-14:
 * `grep -rln "mcp-server.mjs" test/ lib/ bin/` matched `bin/acuvo-mcp.mjs` and
 * nothing else. That is how a published binary came to serve an empty tool list
 * with a handshake that named two tools — every part existed, nothing checked
 * that the parts met.
 *
 * ⭐ So the assertions here are deliberately about REACH and REFUSAL rather
 * than about shapes. The three that matter most:
 *
 *   1. SERVED ∪ REFUSED === TOOL_NAMES — a 50th tool in `tools.mjs` turns this
 *      red until somebody decides in writing whether a stranger may drive it.
 *      Neither an allowlist nor a denylist alone can do that: the first
 *      silently strands new tools, the second silently serves them.
 *   2. A refused tool that is CALLED ANYWAY does nothing. `tools/list` is
 *      advertising; a model can emit a call for a tool it was never shown, and
 *      `executeToolCall` will cheerfully dispatch `run_command` because it has
 *      no idea who is asking.
 *   3. The refusal is proven BY ITS ABSENCE ON DISK, not by an error string.
 *      An `isError` reply is what the code says happened; the missing file is
 *      what actually happened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { parse as parsePath } from 'node:path';

import { TOOL_NAMES } from '../lib/tools.mjs';
import {
  createMcpServer,
  resolveWorkspaceRoot,
  REFUSED_TOOL_REASONS,
  GENERAL_TOOL_NAMES,
  WORKSPACE_READ_TOOLS,
  WORKSPACE_WRITE_TOOLS,
  MEDIA_READ_TOOLS,
  GENERAL_DISPATCH_OPTIONS,
  TOOLS,
} from '../lib/mcp-server.mjs';

/** A throwaway project directory. Never the cwd — see the header of bin/. */
function scratchWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-mcp-test-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# hello\nsecond line\n', 'utf8');
  writeFileSync(join(dir, 'src', 'math.mjs'), 'export function add(a, b) { return a + b; }\n', 'utf8');
  return dir;
}

/** Drive the server the way a host does: one JSON-RPC message in, one out. */
async function call(server, name, args) {
  return server.handle({
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args },
  });
}

const listNames = (server) => server.listTools().map((t) => t.name);

/** No media services, so the media half is dark and the workspace half is the subject. */
const NO_MEDIA = Object.freeze({ RENDER_AUDIT_URL: '', MODAL_PRESS_URL: '', MODAL_DOC_READ_URL: '', MODAL_TABLE_READ_URL: '' });

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE UNION GUARD
// ─────────────────────────────────────────────────────────────────────────────

test('every tool in tools.mjs is either served or refused by name — no tool goes undecided', () => {
  const decided = new Set([...GENERAL_TOOL_NAMES, ...Object.keys(REFUSED_TOOL_REASONS)]);
  const undecided = TOOL_NAMES.filter((n) => !decided.has(n));
  assert.deepEqual(
    undecided, [],
    'a tool exists in tools.mjs that mcp-server.mjs neither serves nor refuses. '
    + 'Add it to a group in mcp-server.mjs, or give it a reason in REFUSED_TOOL_REASONS.',
  );
});

test('nothing is decided that does not exist — the refusal list cannot rot', () => {
  const real = new Set(TOOL_NAMES);
  const phantom = [...GENERAL_TOOL_NAMES, ...Object.keys(REFUSED_TOOL_REASONS)].filter((n) => !real.has(n));
  assert.deepEqual(phantom, [], 'mcp-server.mjs names a tool tools.mjs no longer has');
});

test('no tool is both served and refused', () => {
  const both = GENERAL_TOOL_NAMES.filter((n) => n in REFUSED_TOOL_REASONS);
  assert.deepEqual(both, []);
});

test('every refusal states a reason a model could act on', () => {
  for (const [name, why] of Object.entries(REFUSED_TOOL_REASONS)) {
    assert.equal(typeof why, 'string', `${name} has no reason`);
    assert.ok(why.length > 30, `${name}'s reason is too thin to be useful: ${why}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE GATES
// ─────────────────────────────────────────────────────────────────────────────

test('with no workspace root, not one workspace tool is offered', () => {
  const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: null });
  assert.deepEqual(listNames(server), []);
  assert.equal(server.workspaceRoot, null);
});

test('a workspace root turns on the reads and leaves the writes off', () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir });
    const names = listNames(server);
    for (const read of WORKSPACE_READ_TOOLS) assert.ok(names.includes(read), `${read} should be offered`);
    for (const write of WORKSPACE_WRITE_TOOLS) assert.ok(!names.includes(write), `${write} must NOT be offered by default`);
    assert.equal(server.writeEnabled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the write opt-in is what turns on the write verbs', () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir, allowWrite: true });
    const names = listNames(server);
    for (const write of WORKSPACE_WRITE_TOOLS) assert.ok(names.includes(write), `${write} should be offered`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ACUVO_MCP_WRITE=0 and =false are OFF — a truthy string is not a yes', () => {
  const dir = scratchWorkspace();
  try {
    for (const value of ['0', 'false', 'no', 'off', '']) {
      const server = createMcpServer({ env: { ...NO_MEDIA, ACUVO_MCP_WRITE: value }, workspaceRoot: dir });
      assert.equal(server.writeEnabled, false, `ACUVO_MCP_WRITE=${JSON.stringify(value)} must not enable writing`);
    }
    for (const value of ['1', 'true', 'yes', 'ON']) {
      const server = createMcpServer({ env: { ...NO_MEDIA, ACUVO_MCP_WRITE: value }, workspaceRoot: dir });
      assert.equal(server.writeEnabled, true, `ACUVO_MCP_WRITE=${value} should enable writing`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the media readers are offered only when their service is configured', () => {
  const dir = scratchWorkspace();
  try {
    const off = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir });
    for (const n of MEDIA_READ_TOOLS) assert.ok(!listNames(off).includes(n), `${n} must be dark with no service`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE ROOT ITSELF
// ─────────────────────────────────────────────────────────────────────────────

test('the filesystem root is refused as a workspace — containment would be vacuous', () => {
  const top = parsePath(process.cwd()).root;
  const out = resolveWorkspaceRoot(top);
  assert.equal(out.ok, false);
  assert.match(out.reason, /top of the filesystem/);
});

test('the home directory itself is refused; a directory inside it is not', () => {
  const home = homedir();
  const out = resolveWorkspaceRoot(home);
  assert.equal(out.ok, false);
  assert.match(out.reason, /home directory/);

  const dir = scratchWorkspace();
  try {
    assert.equal(resolveWorkspaceRoot(dir).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing root is a reported startup error, never a crash and never a silent cwd', () => {
  const missing = join(tmpdir(), 'acuvo-mcp-definitely-not-here-9f3a');
  assert.equal(existsSync(missing), false);
  const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: missing });
  assert.equal(server.workspaceRoot, null);
  assert.ok(server.workspaceError, 'the reason must survive to stderr');
  // ⚠️ The whole point: it did not fall back to cwd.
  assert.deepEqual(listNames(server), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. REACH — the tools that are listed actually WORK
// ─────────────────────────────────────────────────────────────────────────────

test('a listed read tool returns real file contents over JSON-RPC', async () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir });
    const reply = await call(server, 'read_file', { path: 'README.md' });
    assert.equal(reply.result.isError, undefined);
    assert.match(reply.result.content[0].text, /# hello/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('search_text finds a real match and reports its line', async () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir });
    const reply = await call(server, 'search_text', { pattern: 'function add' });
    assert.equal(reply.result.isError, undefined);
    assert.match(reply.result.content[0].text, /src\/math\.mjs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a listed write tool puts bytes on disk', async () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir, allowWrite: true });
    const reply = await call(server, 'write_file', { path: 'made.txt', content: 'by mcp' });
    assert.equal(reply.result.isError, undefined);
    assert.equal(readFileSync(join(dir, 'made.txt'), 'utf8'), 'by mcp');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. REFUSAL — and proven by the absence of the effect, not by the message
// ─────────────────────────────────────────────────────────────────────────────

test('a process-starting tool is refused even when CALLED DIRECTLY, and does not run', async () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir, allowWrite: true });
    assert.ok(!listNames(server).includes('run_command'), 'it must not even be listed');

    /**
     * ⭐ THE EFFECT, NOT THE STRING — and the probe has to be one that COULD
     * fire, which took two attempts.
     *
     * ⚠️ THE FIRST VERSION USED `node -e <js>` AND WAS A CHECK THAT CANNOT
     * FAIL. `command.mjs` refuses `-e` and refuses quotes outright — that is
     * the entire reason `run_program` exists — so with BOTH containment layers
     * deliberately removed the canary still never appeared, and the test
     * reported a wording mismatch as if that were the finding. A probe that the
     * allowlist would have blocked anyway proves nothing about the MCP gate.
     *
     * `node <file>` IS on the allowlist, so this one really does execute the
     * moment anything upstream of it stops refusing.
     */
    const canary = join(dir, 'ran.txt');
    const canaryJs = canary.replace(/\\/g, '/');
    writeFileSync(join(dir, 'ran.js'), `require('fs').writeFileSync(${JSON.stringify(canaryJs)}, 'x')\n`, 'utf8');
    for (const [name, args] of [
      ['run_command', { command: 'node ran.js' }],
      ['run_program', { program: 'node', args: ['ran.js'] }],
      ['evaluate', { code: `require('fs').writeFileSync(${JSON.stringify(canaryJs)},'x')` }],
      ['repl', { code: '1+1' }],
      ['start_process', { command: 'node -e "setTimeout(()=>{},9999)"' }],
      ['check_acceptance', {}],
      ['check_types', { path: 'src/math.mjs' }],
      ['git_status', {}],
    ]) {
      const reply = await call(server, name, args);
      /**
       * ⚠️ THE EFFECT IS ASSERTED FIRST, AND THE ORDER IS THE POINT. With the
       * message assertion first, a double mutation (drop the door check AND
       * flip allowRun) failed on the WORDING and never reached the question
       * that mattered — whether the command ran. A test whose loudest failure
       * is a string mismatch reports a typo where there is an execution.
       */
      assert.equal(existsSync(canary), false, `${name} EXECUTED — it wrote ${canary}`);
      assert.equal(reply.result.isError, true, `${name} must be refused`);
      assert.match(reply.result.content[0].text, /deliberately not served over MCP/, `${name}'s refusal must say why`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the dispatch options hold the boundary explicitly, not by inheriting a default', () => {
  /**
   * ⚠️ THIS IS THE SECOND LAYER AND NOTHING ELSE CAN SEE IT FAIL. The served
   * list already refuses run_command at the door, so flipping `allowRun` to
   * true here would pass every other test in this file — the guard would be
   * gone and the suite would stay green. `executeToolCall` defaults allowRun to
   * TRUE (tools.mjs:845), which is exactly why it must be written down here.
   */
  assert.equal(GENERAL_DISPATCH_OPTIONS.allowRun, false, 'an MCP host must never be able to start a process');
  assert.equal(GENERAL_DISPATCH_OPTIONS.shell, false, 'there is no shell over this transport');
  assert.equal(GENERAL_DISPATCH_OPTIONS.config, null, 'no model credentials reach a stranger\'s call');
  assert.equal(GENERAL_DISPATCH_OPTIONS.ask, null, 'there is no human on this end of a pipe');
  assert.equal(GENERAL_DISPATCH_OPTIONS.budget, null);
  assert.equal(GENERAL_DISPATCH_OPTIONS.subagentImpl, null, 'no nested model sessions');
});

test('generate_image is refused — it is the one tool that spends our GPU with no credential set', async () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir, allowWrite: true });
    const reply = await call(server, 'generate_image', { prompt: 'a cat', path: 'cat.png' });
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /unmetered GPU/);
    assert.equal(existsSync(join(dir, 'cat.png')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a write call with writing switched off leaves nothing on disk', async () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir });
    const reply = await call(server, 'write_file', { path: 'sneaky.txt', content: 'x' });
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /ACUVO_MCP_WRITE/);
    assert.equal(existsSync(join(dir, 'sneaky.txt')), false, 'the file was written despite the refusal');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a path that escapes the workspace is refused', async () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir });
    const reply = await call(server, 'read_file', { path: '../../../etc/passwd' });
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /escapes the workspace/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a credential file is refused even inside the workspace', async () => {
  const dir = scratchWorkspace();
  try {
    writeFileSync(join(dir, '.env'), 'API_KEY=super-secret-canary\n', 'utf8');
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir });
    const reply = await call(server, 'read_file', { path: '.env' });
    assert.equal(reply.result.isError, true);
    assert.ok(!reply.result.content[0].text.includes('super-secret-canary'), 'the secret leaked into the reply');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE TWO NAMES THAT EXIST TWICE
// ─────────────────────────────────────────────────────────────────────────────

test('the served see_page takes HTML, never a path — the tools.mjs version must not leak through', () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({
      env: { RENDER_AUDIT_URL: 'https://example.invalid/r', MODAL_PRESS_URL: '', MODAL_DOC_READ_URL: '', MODAL_TABLE_READ_URL: '' },
      workspaceRoot: dir,
    });
    const seePage = server.listTools().find((t) => t.name === 'see_page');
    assert.ok(seePage, 'see_page should be offered when the render service is set');
    assert.ok(seePage.inputSchema.properties.html, 'it must take html');
    assert.ok(!seePage.inputSchema.properties.path, 'a path parameter here is an arbitrary-file-read primitive');
    // And it is the object from TOOLS, not a converted tools.mjs schema.
    assert.equal(seePage, TOOLS.find((t) => t.name === 'see_page'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE HANDSHAKE MUST DESCRIBE THE LIST
// ─────────────────────────────────────────────────────────────────────────────

test('initialize does not advertise tools that tools/list will not contain', async () => {
  // ⚠️ THE ORIGINAL DEFECT, PINNED. The shipped instructions named see_page and
  // make_document unconditionally while the list came back empty.
  const bare = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: null });
  const reply = await bare.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const text = reply.result.instructions;
  assert.ok(!/\bsee_page\b/.test(text), 'the handshake names see_page while serving nothing');
  assert.ok(!/\bmake_document\b/.test(text), 'the handshake names make_document while serving nothing');
  assert.match(text, /serving no tools/);
});

test('the handshake names the workspace tools once they are real', async () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir });
    const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.match(reply.result.instructions, /READ-ONLY/);
    assert.match(reply.result.instructions, /Nothing here starts a process/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every listed tool carries an inputSchema — the MCP spelling, not "parameters"', () => {
  const dir = scratchWorkspace();
  try {
    const server = createMcpServer({ env: { ...NO_MEDIA }, workspaceRoot: dir, allowWrite: true });
    const tools = server.listTools();
    assert.ok(tools.length >= 10);
    for (const t of tools) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.inputSchema, 'object', `${t.name} has no inputSchema`);
      assert.equal(t.parameters, undefined, `${t.name} leaked the OpenAI shape`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
