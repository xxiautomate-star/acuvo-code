/**
 * ── ⭐⭐ MCP — WHERE 33 TOOLS BECOMES 33 PLUS WHATEVER YOU ALREADY RUN ────────
 *
 * (It said 18. The registry was 18 for exactly as long as it took to wire the
 * modules that were already sitting in `lib/` — it is 33 now, `TOOL_NAMES` in
 * tools.mjs is the count, and a number written into prose is a number that goes
 * stale the first time anyone ships anything.)
 *
 * Every capability in this CLI so far is one we built. That ceiling is real: a
 * user whose work lives in Linear, Postgres, Sentry or their own internal
 * service has to wait for us to write an adapter, and we never will for most of
 * them.
 *
 * ⭐ Model Context Protocol is the escape from that. It is the one integration
 * that makes every OTHER integration somebody else's job — and the two-way
 * strategy this project already committed to (be drivable BY agents, and able to
 * drive every MCP server) only has one half built today.
 *
 * ── ⚠️ THE SECURITY SHAPE, WHICH IS THE WHOLE DESIGN ────────────────────────
 * An MCP server is **a program we spawn**. That is a categorically bigger deal
 * than anything else in this package: `command.mjs` spends four hundred lines
 * making sure a model cannot choose a program, and this file spawns one on
 * purpose.
 *
 * So the boundary moves rather than disappearing:
 *
 *   1. ⚠️ **THE USER CHOOSES THE SERVERS, NEVER THE MODEL.** They come from a
 *      config file the user wrote and can read. There is deliberately no
 *      `connect_mcp_server` tool — a model that can add its own capabilities is
 *      a model that can grant itself anything on the machine.
 *   2. **The config is per-project and committable**, same argument as
 *      ACUVO.md: a hidden per-user list means two developers get different
 *      agents and nobody can review what was granted.
 *   3. **Namespaced.** A server's `read_file` must never shadow ours; every
 *      remote tool is `mcp__<server>__<tool>`, so collisions are impossible and
 *      the transcript always says where a call went.
 *   4. **Bounded.** Servers are spawned lazily, capped in number and in tool
 *      count, and killed when the session ends. An MCP server that hangs must
 *      cost a timeout, not a terminal.
 *
 * ⚠️ AND THE HONEST LIMIT: a server the user configured can do anything its own
 * process can do. We are not sandboxing it and must not claim to. What we
 * guarantee is that nothing gets spawned that the user did not write down.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { detachChild } from './child-lifetime.mjs';

/** Where the user declares their servers. `.mcp.json` matches what other tools use. */
export const MCP_CONFIG_FILES = ['.acuvo/mcp.json', '.mcp.json'];

/** Bounds. Each exists because the failure it prevents is silent or expensive. */
export const MAX_SERVERS = 8;
export const MAX_TOOLS_PER_SERVER = 40;
export const HANDSHAKE_TIMEOUT_MS = 20_000;
export const CALL_TIMEOUT_MS = 120_000;

/**
 * Read and validate the server list.
 *
 * ⚠️ VALIDATION IS NOT CEREMONY HERE. This file names programs that will be
 * executed, so a malformed entry must be refused loudly rather than coerced into
 * something plausible — "helpfully" defaulting a missing command is how you
 * spawn the wrong binary.
 */
export function readMcpConfig(root, { files = MCP_CONFIG_FILES } = {}) {
  for (const rel of files) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      return { ok: false, error: `${rel} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    const raw = parsed?.mcpServers ?? parsed?.servers;
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `${rel} has no "mcpServers" object` };
    }
    const servers = [];
    for (const [name, spec] of Object.entries(raw)) {
      if (servers.length >= MAX_SERVERS) break;
      // ⚠️ The NAME becomes part of a tool id the model calls. Anything outside
      // this set could collide with our namespace separator and make a remote
      // tool indistinguishable from a local one.
      if (!/^[a-z0-9][a-z0-9_-]{0,30}$/i.test(name)) {
        return { ok: false, error: `"${name}" is not a usable server name (letters, digits, - and _ only)` };
      }
      const command = spec?.command;
      if (typeof command !== 'string' || !command.trim()) {
        return { ok: false, error: `server "${name}" has no "command"` };
      }
      const args = Array.isArray(spec?.args) ? spec.args.filter((a) => typeof a === 'string') : [];
      servers.push({ name, command, args, env: spec?.env && typeof spec.env === 'object' ? spec.env : {} });
    }
    return { ok: true, file: rel, servers };
  }
  return { ok: true, file: null, servers: [] };
}

/**
 * A JSON-RPC conversation over a child process's stdio.
 *
 * ⚠️ MESSAGES ARE NEWLINE-DELIMITED AND CAN SPLIT ACROSS READS — the same trap
 * the SSE parser has, for the same reason, and it fails the same way: fine on a
 * fast local server, corrupt under load. Buffer, then split.
 */
function createRpc(child, { onNotification = null } = {}) {
  let nextId = 1;
  const pending = new Map();
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      } else if (onNotification) {
        onNotification(msg);
      }
    }
  });

  return {
    request(method, params, timeoutMs) {
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ error: { message: `${method} timed out after ${Math.round(timeoutMs / 1000)}s` } });
        }, timeoutMs);
        /**
         * ⚠️ DELIBERATELY REF'D. The server's stdio is unref'd (see
         * child-lifetime.mjs) so an idle server cannot hold acuvo open — but
         * that also removes the anchor while a call is in flight, and Node then
         * settles the loop with this promise still pending. An in-flight request
         * is the one legitimate reason to stay alive; it is bounded by
         * CALL_TIMEOUT_MS and cleared on every resolution path below.
         */
        pending.set(id, {
          resolve: (m) => { clearTimeout(timer); resolve(m); },
        });
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          resolve({ error: { message: `could not write to the server: ${err?.message ?? err}` } });
        }
      });
    },
    notify(method, params) {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); } catch { /* dying anyway */ }
    },
  };
}

/**
 * Start one server and ask what it can do.
 *
 * ⚠️ NEVER THROWS. A broken server in a config must degrade to "that one is
 * unavailable" — the others still work, and the session still runs. A user with
 * five servers should not lose their whole tool surface because one of them has
 * a bad path.
 */
/**
 * ── ⚠️ WINDOWS CANNOT SPAWN `npx` WITHOUT A SHELL, AND MOST SERVERS ARE npx ──
 *
 * `spawn('npx', args, {shell:false})` fails with ENOENT on Windows: npx is
 * `npx.cmd`, and since the BatBadBut fix (CVE-2024-27980) Node refuses to run a
 * `.cmd` without `shell: true`. Measured here — every MCP server configured the
 * normal way (`"command": "npx"`) simply would not start.
 *
 * ⚠️ THE OBVIOUS FIX IS `shell: true` AND IT IS THE WRONG ONE. It would hand a
 * shell a command string assembled from a config file, reintroducing exactly the
 * injection surface `command.mjs` spends four hundred lines removing — on the
 * one path that also carries the user's API tokens in its environment.
 *
 * ⭐ So the executable is RESOLVED to a real file first and spawned by absolute
 * path. Same trick `buildInvocation` uses for npm, generalised: walk PATH with
 * PATHEXT, find what would actually have run, and run that.
 */
function nodeCliEntry(name) {
  /**
   * ⭐ THE ONLY WINDOWS-SAFE WAY TO RUN npm/npx WITHOUT A SHELL, and
   * `command.mjs` already proved it: spawn the real `node` we are running with
   * npm's own JavaScript entry point. No shim, no `.cmd`, no PATH lookup of
   * anything but node itself, identical behaviour on every platform.
   *
   * ⚠️ Resolving to `npx.cmd` and spawning it by absolute path does NOT work —
   * Node rejects it with EINVAL, which is the BatBadBut protection
   * (CVE-2024-27980) doing its job. Measured here, after the PATHEXT fix.
   */
  const dir = dirname(process.execPath);
  const file = name === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
  for (const c of [
    join(dir, 'node_modules', 'npm', 'bin', file),
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', file),
    join(dir, '..', 'node_modules', 'npm', 'bin', file),
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}

function resolveExecutable(command) {
  // An explicit path is used as given.
  if (command.includes('/') || command.includes(String.fromCharCode(92))) return command;
  if (process.platform !== 'win32') return command;

  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    /**
     * ⚠️ EXTENSIONS FIRST, BARE NAME LAST — and the other order is a real bug I
     * shipped for one commit. `C:\Program Files
odejs\` contains BOTH `npx`
     * (an extensionless bash script, there for Git Bash) and `npx.cmd`. Trying
     * '' first resolved to the bash script, which Windows cannot spawn: still
     * ENOENT, but now from a path that exists, which is much harder to diagnose.
     * cmd.exe consults PATHEXT for exactly this reason.
     */
    for (const ext of [...exts, '']) {
      const candidate = join(dir, command + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch { /* unreadable PATH entry */ }
    }
  }
  // ⚠️ Fall through unchanged rather than inventing a path. The spawn will fail
  // with ENOENT, which is a clearer error than a wrong file that exists.
  return command;
}

export async function connectServer(server, { root, spawnImpl = spawn } = {}) {
  let child;
  try {
    /**
     * ⚠️ npm and npx are routed through node's own entry point (see
     * nodeCliEntry); everything else is resolved on PATH. `--no` is injected
     * for npx so it can only run a package that is ALREADY INSTALLED — without
     * it, npx downloads and executes whatever name it was given, which is
     * remote code execution wearing a config file.
     */
    const bare = server.command;
    const entry = (bare === 'npm' || bare === 'npx') ? nodeCliEntry(bare) : null;
    const file = entry ? process.execPath : resolveExecutable(bare);
    const argv = entry
      ? [entry, ...(bare === 'npx' ? ['--no'] : []), ...server.args.filter((a) => a !== '-y' && a !== '--yes')]
      : server.args;
    child = spawnImpl(file, argv, {
      cwd: root,
      // ⚠️ NOT the scrubbed env used for run_command. An MCP server usually
      // NEEDS a token to be useful, and the user put it in the config
      // deliberately. This is the one place where withholding credentials would
      // break the feature rather than protect it — which is precisely why the
      // server list is user-authored and never model-authored.
      env: { ...process.env, ...server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (err) {
    return { ok: false, name: server.name, error: `could not start: ${err?.message ?? err}` };
  }

  /**
   * ⚠️ A FAILED SPAWN LEAVES `stdout` NULL, and `createRpc` then throws on
   * `.setEncoding` — which killed the process with NO OUTPUT AT ALL. That is
   * how the first real test of this file appeared to "hang": it had already
   * crashed, silently, before any error could be reported.
   */
  if (!child?.stdout || !child?.stdin) {
    return { ok: false, name: server.name, error: `could not start "${server.command}" (no stdio — is it installed and on PATH?)` };
  }

  /**
   * ⚠️ An MCP server must not decide when acuvo exits. Servers are spawned per
   * turn, so without this every turn that used one leaves a reason to stay
   * alive — see lib/child-lifetime.mjs.
   */
  detachChild(child);

  // A server that dies on startup must not leave the session waiting.
  let died = null;
  child.on('error', (e) => { died = e?.message ?? String(e); });
  child.stderr?.setEncoding('utf8');
  let stderrTail = '';
  child.stderr?.on('data', (d) => { stderrTail = (stderrTail + d).slice(-500); });

  const rpc = createRpc(child);
  const init = await rpc.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'acuvo-code', version: '0.2.0' },
  }, HANDSHAKE_TIMEOUT_MS);

  if (init?.error || died) {
    try { child.kill(); } catch { /* already gone */ }
    return {
      ok: false,
      name: server.name,
      // ⭐ stderr is included: an MCP server's real complaint ("missing API key")
      // arrives there, never in the RPC error, and without it the user gets
      // "initialize failed" and no idea why.
      error: `${init?.error?.message ?? died}${stderrTail ? ` — ${stderrTail.trim().slice(0, 200)}` : ''}`,
    };
  }
  rpc.notify('notifications/initialized', {});

  const listed = await rpc.request('tools/list', {}, HANDSHAKE_TIMEOUT_MS);
  if (listed?.error) {
    try { child.kill(); } catch { /* already gone */ }
    return { ok: false, name: server.name, error: listed.error.message };
  }

  const tools = (listed?.result?.tools ?? []).slice(0, MAX_TOOLS_PER_SERVER);
  return { ok: true, name: server.name, child, rpc, tools, truncated: (listed?.result?.tools ?? []).length > MAX_TOOLS_PER_SERVER };
}

/**
 * ⚠️ THE NAMESPACE IS A SAFETY PROPERTY, NOT TIDINESS. A server offering its own
 * `write_file` must not shadow ours, and the transcript must always show which
 * one ran. Double underscore because a single one is common inside tool names.
 */
export function namespacedName(server, tool) {
  return `mcp__${server}__${tool}`;
}

export function parseNamespaced(name) {
  const m = /^mcp__([a-z0-9_-]+)__(.+)$/i.exec(name ?? '');
  return m ? { server: m[1], tool: m[2] } : null;
}

/** Turn a server's advertised tools into schemas the model can be offered. */
export function mcpToolSchemas(connections) {
  const out = [];
  for (const c of connections) {
    if (!c.ok) continue;
    for (const t of c.tools) {
      if (!t?.name) continue;
      out.push({
        type: 'function',
        function: {
          name: namespacedName(c.name, t.name),
          // ⭐ The server's own description, prefixed with where it came from.
          // A model choosing between two similar tools needs to know which
          // system it is about to touch.
          description: `[${c.name}] ${t.description ?? 'no description provided'}`.slice(0, 900),
          parameters: t.inputSchema && typeof t.inputSchema === 'object'
            ? t.inputSchema
            : { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

/** Call a namespaced tool on whichever server owns it. */
export async function callMcpTool(connections, name, args) {
  const parsed = parseNamespaced(name);
  if (!parsed) return { ok: false, error: `"${name}" is not an MCP tool id` };
  const conn = connections.find((c) => c.ok && c.name === parsed.server);
  if (!conn) return { ok: false, error: `the "${parsed.server}" server is not connected` };

  const res = await conn.rpc.request('tools/call', { name: parsed.tool, arguments: args ?? {} }, CALL_TIMEOUT_MS);
  if (res?.error) return { ok: false, error: `${parsed.server}: ${res.error.message}` };

  const content = res?.result?.content ?? [];
  const text = content
    .map((c) => (c?.type === 'text' ? c.text : `[${c?.type ?? 'unknown'}]`))
    .join('\n')
    .slice(0, 20_000);
  /**
   * ⚠️ `isError` IS THE SERVER SAYING THE TOOL FAILED, on a successful RPC.
   * Treating it as success would hand the model a failure message formatted as
   * a result and let it build on top of it — the same silent-success class that
   * made the sandbox verifier useless this morning.
   */
  if (res?.result?.isError) return { ok: false, error: text || 'the tool reported an error' };
  return { ok: true, server: parsed.server, tool: parsed.tool, text };
}

/** Shut every server down. Called when the session ends, always. */
export function closeConnections(connections) {
  for (const c of connections) {
    if (!c.ok || !c.child) continue;
    try { c.child.kill(); } catch { /* already gone */ }
  }
}
