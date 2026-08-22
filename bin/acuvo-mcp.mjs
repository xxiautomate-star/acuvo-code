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

/**
 * ── ⚠️ WHY THE ROOT IS AN ARGUMENT AND NOT `process.cwd()` ──────────────────
 *
 * A host spawns its MCP servers with whatever working directory it happens to
 * have — often the user's home, sometimes `/`. Taking cwd as the workspace
 * would make the containment check in `workspace.mjs` pass for every file on
 * the machine: a boundary that exists in the code and nowhere in reality. So
 * the directory is typed by the person editing the host config, exactly the way
 * they type the server list in `mcp.json`.
 *
 * Both spellings, because both appear in real host configs: `--root /path` and
 * `--root=/path`. `ACUVO_MCP_ROOT` works too and loses to the flag, since an
 * `args` array is more visible in a config file than an `env` block.
 */
function flagValue(argv, flag) {
  const exact = argv.indexOf(flag);
  if (exact !== -1 && argv[exact + 1] !== undefined && !argv[exact + 1].startsWith('-')) return argv[exact + 1];
  const joined = argv.find((a) => a.startsWith(`${flag}=`));
  if (joined) return joined.slice(flag.length + 1);
  return null;
}

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
      'not run by hand. Four gated groups, and nothing outside them:',
      '',
      '  browser (needs a service URL)',
      '    see_page       render HTML in a real browser; get the measured',
      '                   layout/contrast defects back',
      '    make_document  turn HTML into a real PDF, PNG or PPTX',
      '    Both take the HTML itself, never a file path.',
      '',
      '  workspace reads (needs --root)',
      '    read_file  read_lines  read_around  list_dir  find_files  search_text',
      '',
      '  document reads (needs --root and a reader service)',
      '    read_document  read_table    PDF / DOCX / XLSX / scans -> text',
      '',
      '  workspace writes (needs --root AND --allow-write)',
      '    write_file  write_files  edit_file  delete_file',
      '',
      'NOTHING STARTS A PROCESS. run_command, run_program, evaluate, repl,',
      'start_process, the acceptance verbs, git and the four LSP verbs are refused',
      'unconditionally, and there is no flag to turn them on: the calling agent',
      'already has a shell, and write + run composes into arbitrary code execution.',
      'generate_image is refused too — it is the one tool that reaches an',
      'XXIautomate endpoint with no credential set at all, so every call would be',
      'unmetered GPU on our bill.',
      '',
      'Options:',
      '  --root <dir>         the ONE directory the workspace tools may touch.',
      '                       Never inferred from the working directory: a host',
      '                       spawns servers wherever it likes, and a root of / or',
      '                       ~ makes the containment check meaningless. Without',
      '                       it, only the browser tools are served.',
      '  --allow-write        also serve write_file, write_files, edit_file and',
      '                       delete_file. Off by default; a read-only Acuvo is a',
      '                       lens, a writing one changes somebody\'s repository.',
      '',
      'Environment:',
      '  ACUVO_MCP_ROOT       same as --root (the flag wins)',
      '  ACUVO_MCP_WRITE=1    same as --allow-write (only 1/true/yes/on count)',
      '  RENDER_AUDIT_URL     render service (without it, see_page is not offered)',
      '  MODAL_PRESS_URL      document service (without it, make_document is not offered)',
      '  MODAL_DOC_READ_URL   document reader (without it, read_document is not offered)',
      '  MODAL_TABLE_READ_URL table reader (without it, read_table is not offered)',
      '  MODAL_VIDEO_SECRET   shared secret for those services, if they require one',
      '  ACUVO_MCP_OUT        where rendered files are written (default: <tmp>/acuvo-mcp)',
      '  ACUVO_MCP_MAX_CALLS  lifetime render cap (default 200) — renders cost money',
      '',
      'Example host config:',
      '  "acuvo": {',
      '    "command": "npx",',
      '    "args": ["-y", "acuvo-code", "acuvo-mcp", "--root", "/path/to/project"],',
      '    "env": { "RENDER_AUDIT_URL": "..." }',
      '  }',
      '',
    ].join('\n'));
    return 0;
  }

  loadEnv();

  // ⚠️ The flag beats the env var: an `args` array is visible in a host config,
  // an `env` block is the thing people forget they set months ago.
  const rootArg = flagValue(process.argv, '--root') ?? process.env.ACUVO_MCP_ROOT ?? null;
  const allowWrite = process.argv.includes('--allow-write') ? true : undefined;

  const server = createMcpServer({ env: process.env, workspaceRoot: rootArg, allowWrite });

  /**
   * ⭐ SAY WHAT IS LIVE, ON STDERR, BEFORE THE FIRST MESSAGE. Hosts surface a
   * server's stderr in their logs, and "0 tools" with no explanation is the
   * single most common MCP support question there is. This makes the answer
   * one line long.
   */
  const names = server.listTools().map((t) => t.name);
  log(`v${SERVER_VERSION} · ${names.length} tool${names.length === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}`);
  if (names.length === 0) {
    log('NO TOOLS. Set RENDER_AUDIT_URL and/or MODAL_PRESS_URL for the browser tools, and/or pass --root <dir> for the workspace tools.');
  }
  /**
   * ⚠️ A REFUSED ROOT IS SHOUTED, NOT SWALLOWED. The operator typed a directory
   * and got a server without workspace tools; if the reason is only visible by
   * reading this source, they will conclude the feature does not work.
   */
  if (server.workspaceError) log(`WORKSPACE ROOT REFUSED — ${server.workspaceError}`);
  else if (server.workspaceRoot) log(`workspace: ${server.workspaceRoot} (${server.writeEnabled ? 'read + WRITE' : 'read-only'})`);
  else log('workspace: none — pass --root <dir> to serve the file tools');
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
