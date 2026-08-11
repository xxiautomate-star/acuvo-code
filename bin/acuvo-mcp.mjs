#!/usr/bin/env node
/**
 * ACUVO MCP SERVER — the entry point another agent spawns.
 *
 * Add to any MCP host (Claude Code, Cursor, Cline, Zed):
 *
 *   {
 *     "mcpServers": {
 *       "acuvo": {
 *         "command": "npx",
 *         "args": ["-y", "acuvo-code", "acuvo-mcp"],
 *         "env": { "RENDER_AUDIT_URL": "...", "MODAL_PRESS_URL": "...", "MODAL_VIDEO_SECRET": "..." }
 *       }
 *     }
 *   }
 *
 * ── ⚠️ THIS FILE'S ONLY JOB IS TO NOT BREAK STDIO ───────────────────────────
 * Under MCP, stdout is the wire. A banner, a warning, a stray `console.log` from
 * anything we import — any of it corrupts the JSON-RPC stream and the host
 * reports an unintelligible parse error instead of the real problem. So:
 * everything human goes to stderr, and there is no exception, including the
 * "helpful" line telling the user nothing is configured.
 *
 * ⚠️ AND IT MUST NOT EXIT WHEN IT HAS NOTHING TO OFFER. A server that dies
 * because no endpoint is configured shows up in the host as "failed to connect",
 * which sends the user looking for an install problem. It stays up, answers
 * `initialize`, and returns an EMPTY tool list — which is the truthful answer to
 * "what can you do" and is diagnosable in one glance at the host's UI.
 */

import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMcpServer, serve, SERVER_VERSION } from '../lib/mcp-server.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ── LOAD `.env`, SAME REASONING AS bin/acuvo.mjs ────────────────────────────
 * Measured there: without this, every media capability was dark on a machine
 * where all of them work, because nobody exports four variables by hand.
 *
 * ⚠️ THE PACKAGE DIRECTORY IS SEARCHED TOO, AND ONLY HERE DOES THAT MATTER. An
 * MCP server is spawned by a host with whatever cwd the host felt like using —
 * often the user's project, sometimes `/`. The `.env` sitting next to the code
 * is the only location that is reliably ours.
 *
 * ⚠️ A REAL ENVIRONMENT VARIABLE STILL WINS: `loadEnvFile` does not overwrite,
 * so the `env` block in the host's config beats any file. That is the right
 * precedence — the host's config is the thing the user can actually see.
 */
function loadEnv() {
  if (typeof process.loadEnvFile !== 'function') return;
  const candidates = [
    process.env.ACUVO_ENV_FILE,
    join(process.cwd(), '.env'),
    join(packageRoot, '.env'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try { process.loadEnvFile(file); } catch { /* malformed is not fatal — we may not need it */ }
  }
}

function log(line) {
  // stderr, always. See the header.
  try { process.stderr.write(`acuvo-mcp: ${line}\n`); } catch { /* nothing we can do */ }
}

async function main() {
  if (process.argv.includes('--version')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return 0;
  }
  if (process.argv.includes('--help')) {
    process.stdout.write([
      'acuvo-mcp — expose Acuvo\'s browser-backed capabilities over MCP (stdio).',
      '',
      'It speaks JSON-RPC on stdin/stdout and is meant to be spawned by an MCP host,',
      'not run by hand. Two tools, and only two:',
      '',
      '  see_page       render HTML in a real browser; get the screenshot and the',
      '                 measured layout/contrast defects back',
      '  make_document  turn HTML into a real PDF, PNG or PPTX',
      '',
      'It deliberately exposes NO file access and NO command execution — the agent',
      'calling it already has both, so offering them again would add no capability',
      'and one more attack surface.',
      '',
      'Environment:',
      '  RENDER_AUDIT_URL     render service (without it, see_page is not offered)',
      '  MODAL_PRESS_URL      document service (without it, make_document is not offered)',
      '  MODAL_VIDEO_SECRET   shared secret for both, if the services require one',
      '  ACUVO_MCP_OUT        where files are written (default: <tmp>/acuvo-mcp)',
      '  ACUVO_MCP_MAX_CALLS  lifetime call cap (default 200) — renders cost money',
      '',
    ].join('\n'));
    return 0;
  }

  loadEnv();

  const server = createMcpServer({ env: process.env });

  /**
   * ⭐ SAY WHAT IS LIVE, ON STDERR, BEFORE THE FIRST MESSAGE. Hosts surface a
   * server's stderr in their logs, and "0 tools" with no explanation is the
   * single most common MCP support question there is. This makes the answer
   * one line long.
   */
  const names = server.listTools().map((t) => t.name);
  log(`v${SERVER_VERSION} · ${names.length ? names.join(', ') : 'NO TOOLS — set RENDER_AUDIT_URL and/or MODAL_PRESS_URL'}`);
  log(`output directory: ${server.root}`);

  /**
   * ⚠️ A CRASH MUST NOT BE SILENT. Without these the process vanishes and the
   * host says "server exited"; with them the user gets the actual stack in the
   * place they are already looking.
   */
  process.on('uncaughtException', (err) => { log(`uncaught: ${err?.stack ?? err}`); });
  process.on('unhandledRejection', (err) => { log(`unhandled rejection: ${err?.stack ?? err}`); });

  await serve(server, { input: process.stdin, output: process.stdout, onLog: log });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`crashed before serving: ${err?.stack ?? err}`);
    process.exit(1);
  },
);
