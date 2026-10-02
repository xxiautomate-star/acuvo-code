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

import {
  createMcpServer, serve, SERVER_VERSION, DEFAULT_MCP_SPEND_USD, MAX_MCP_SPEND_USD,
} from '../lib/mcp-server.mjs';

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
      'not run by hand. Five gated groups, and nothing outside them:',
      '',
      '  browser (needs a service URL)',
      '    see_page       render HTML in a real browser; get the measured',
      '                   layout/contrast defects back',
      '    make_document  turn HTML into a real PDF, PNG or PPTX',
      '    Both take the HTML itself, never a file path.',
      '',
      '  workspace reads (needs --root)',
      '    read_file  read_lines  read_around  list_dir  find_files  search_text',
      '    find_symbol  review_code  profile_table',
      '',
      '  document reads (needs --root and a reader service)',
      '    read_document  read_table    PDF / DOCX / XLSX / scans -> text',
      '',
      '  workspace writes (needs --root AND --allow-write)',
      '    write_file  write_files  edit_file  delete_file  move_file  apply_patch',
      '',
      '  CREATIVE (needs --root AND --allow-write AND --allow-spend <usd>)',
      '    list_engines   what each Acuvo engine costs, before you spend one',
      '    generate_image draw a real image from a prompt, into the workspace',
      '    speak          read text aloud into an audio file (a FIXED voice —',
      '                   it cannot clone anybody; clone_voice is refused)',
      '    ⚠ These spend real money. Every call is priced, counted against the',
      '      ceiling you set, journalled to <root>/.acuvo/spend.jsonl so a restart',
      '      cannot refill it, and written to <root>/.acuvo/audit/ where',
      '      `acuvo spend` reads it. A call that would cross the ceiling is',
      '      refused before anything is sent.',
      '',
      'NOTHING STARTS A PROCESS. run_command, run_program, evaluate, repl,',
      'start_process, the acceptance verbs, git and the four LSP verbs are refused',
      'unconditionally, and there is no flag to turn them on: the calling agent',
      'already has a shell, and write + run composes into arbitrary code execution.',
      'The identity verbs — clone_voice, character_lock, talking_head — are refused',
      'unconditionally too, and NOT because of the money: they render a real',
      'person\'s voice or face, and there is nobody on the other end of a pipe to',
      'ask whether the caller has the right to it. generate_video and design_voice',
      'are refused because one call exhausts any sane ceiling for this transport.',
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
      '  --allow-spend <usd>  serve the creative group, with a hard ceiling of',
      '                       <usd> for the life of this server. A DOLLAR AMOUNT,',
      '                       not a yes/no — "--allow-spend true" is an error, not',
      '                       a default, because nobody is watching this run.',
      `                       Default with no number: $${DEFAULT_MCP_SPEND_USD}. Maximum: $${MAX_MCP_SPEND_USD}.`,
      '',
      'Environment:',
      '  ACUVO_MCP_ROOT       same as --root (the flag wins)',
      '  ACUVO_MCP_WRITE=1    same as --allow-write (only 1/true/yes/on count)',
      '  ACUVO_MCP_SPEND=0.25 same as --allow-spend (a dollar amount, never a yes)',
      '  RENDER_AUDIT_URL     render service (without it, see_page is not offered)',
      '  MODAL_PRESS_URL      document service (without it, make_document is not offered)',
      '  MODAL_DOC_READ_URL   document reader (without it, read_document is not offered)',
      '  MODAL_TABLE_READ_URL table reader (without it, read_table is not offered)',
      '  MODAL_TTS_URL        speech service (without it, speak is not offered)',
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

  /**
   * ── ⚠️ `--allow-spend` TAKES A NUMBER, AND BARE MEANS THE SMALL DEFAULT ─────
   *
   * `flagValue` returns null for a flag with nothing usable after it, so a bare
   * `--allow-spend` lands on `DEFAULT_MCP_SPEND_USD` rather than on "off" — an
   * operator who typed the flag meant to turn it on, and silently ignoring them
   * is the dead-switch failure this package keeps paying for. Everything else
   * about the value (yes-words, the cap, a negative) is refused inside
   * `resolveSpendCeiling`, which is where the message lives.
   */
  const spendFlag = process.argv.includes('--allow-spend') || process.argv.some((a) => a.startsWith('--allow-spend='))
    ? (flagValue(process.argv, '--allow-spend') ?? String(DEFAULT_MCP_SPEND_USD))
    : undefined;

  const server = createMcpServer({ env: process.env, workspaceRoot: rootArg, allowWrite, allowSpend: spendFlag });

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
   * ⚠️ THE LEDGER IS ANNOUNCED WHETHER OR NOT ANYTHING CAN SPEND, because the
   * question an operator asks after the fact is "where did the money go" and
   * the answer has to be visible before they need it. A refused ceiling is
   * SHOUTED for the same reason a refused root is: they typed a number and got
   * a server without creative tools, and the reason must not require reading
   * the source.
   */
  if (server.spendError) log(`SPEND CEILING REFUSED — ${server.spendError}`);
  else if (server.spendCeilingUsd === null) log('creative tools: off — pass --allow-spend <usd> to serve list_engines, generate_image and speak');
  else log(`creative tools: ON, ceiling $${server.spendCeilingUsd} for the life of this server${server.creativeEnabled ? '' : ' — but they also need --root and --allow-write, so they are NOT being served'}`);
  if (server.resumeNote) log(`spend ceiling carried over: ${server.resumeNote}`);
  log(`spend ledger: ${server.ledgerPath} (and .acuvo/audit/ beside it — read it with \`acuvo spend\`)`);

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
