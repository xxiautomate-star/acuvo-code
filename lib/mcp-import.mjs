/**
 * ── ⭐⭐⭐ THEIR TOOLS ARRIVE WITH THEM ───────────────────────────────────────
 *
 * Someone moving here because a weekly limit stopped them has already connected
 * Linear, Postgres, Sentry and a browser to the tool they are leaving. Making
 * them re-declare all of it is an entry fee charged at the exact moment they are
 * annoyed with somebody else — and it is the step `mcp-detect.mjs` already
 * identifies as the one nobody takes: *"a person has to know that MCP exists,
 * know which server answers their problem, know its npm name, and write a JSON
 * block before anything happens."*
 *
 * They already wrote the JSON block. It is just in another tool's directory.
 *
 * ── ⚠️ WHAT WAS ALREADY DONE, SO THIS DOES NOT REDO IT ──────────────────────
 * `mcp.mjs` reads `MCP_CONFIG_FILES = ['.acuvo/mcp.json', '.mcp.json']`, and
 * **`.mcp.json` IS Claude Code's project-level config filename**. So a Claude
 * Code user's PROJECT servers already work here with no import at all. That row
 * is reported as `alreadyRead` rather than offered, because telling someone you
 * imported a file you were already reading is a lie that inflates the feature.
 *
 * What is genuinely unreachable is every OTHER location and shape:
 *   · Cursor        `.cursor/mcp.json`                    (project)
 *   · VS Code       `.vscode/mcp.json`                    (project) ⚠️ different key
 *   · Claude Code   `~/.claude.json`                      (user-level servers)
 *   · Claude Desktop  platform-specific app-data path     (user)
 *   · Windsurf      `~/.codeium/windsurf/mcp_config.json` (user)
 *
 * ── ⚠️⚠️⚠️ THE THREE RULES, INHERITED NOT REINVENTED ────────────────────────
 *
 * 1. **IT NEVER CONNECTS ANYTHING, AND NEVER WRITES A CONFIG.** An MCP server
 *    declaration is `command` + `args` — importing and starting one is remote
 *    code execution with a friendly name. `mcp-detect.mjs` rule 3 already says
 *    silence is what consent forbids; this returns a suggestion for a HUMAN.
 * 2. **ENV VALUES ARE NEVER RETURNED — ONLY KEYS.** `mcp-consent.mjs` says
 *    *"mcp.json is one of the few files people type a raw token into"*. An
 *    importer that echoed a config into a terminal, a log or a prompt would be
 *    the fastest credential leak in the product.
 * 3. **A BROKEN CONFIG IS REPORTED, NEVER GUESSED AT.** A file that will not
 *    parse is named as unreadable. Repairing somebody's JSON silently is how you
 *    spawn the wrong binary.
 *
 * Pure: every filesystem touch is injected, so the whole importer is testable
 * without a disk — the same shape `mcp-detect.mjs` uses.
 */

/**
 * Where other tools keep their MCP declarations.
 *
 * ⚠️ `key` IS NOT DECORATION. VS Code uses `servers`; everyone else uses
 * `mcpServers`. Assuming one shape reads a valid VS Code config as empty and
 * reports "nothing to import" to a user staring at six servers.
 */
export const IMPORT_SOURCES = Object.freeze([
  { tool: 'Claude Code', scope: 'project', rel: '.mcp.json', key: 'mcpServers', alreadyRead: true },
  { tool: 'Cursor', scope: 'project', rel: '.cursor/mcp.json', key: 'mcpServers' },
  { tool: 'VS Code', scope: 'project', rel: '.vscode/mcp.json', key: 'servers' },
  { tool: 'Claude Code', scope: 'user', home: '.claude.json', key: 'mcpServers' },
  { tool: 'Windsurf', scope: 'user', home: '.codeium/windsurf/mcp_config.json', key: 'mcpServers' },
  {
    tool: 'Claude Desktop',
    scope: 'user',
    /**
     * ⚠️ PLATFORM-SPECIFIC, AND `darwin` IS NOT THE SAME AS `linux` HERE.
     * Resolved through the injected platform so the test can prove all three
     * rather than only the one the test machine happens to be.
     */
    appData: {
      win32: ['Claude', 'claude_desktop_config.json'],
      darwin: ['Claude', 'claude_desktop_config.json'],
      linux: ['Claude', 'claude_desktop_config.json'],
    },
    key: 'mcpServers',
  },
]);

/** A config bigger than this is not a config. Bounded read, same as everywhere. */
export const MAX_CONFIG_BYTES = 256 * 1024;

const joinPath = (...parts) => parts.filter(Boolean).join('/');

/**
 * Resolve a source to an absolute-ish path, or null when it cannot exist here.
 *
 * ⚠️ RETURNS null RATHER THAN A GUESS. A Claude Desktop path on a platform we
 * have no entry for is unknown, not `undefined/Claude/...`.
 */
export function resolveSourcePath(source, { root, home, platform, appDataDir }) {
  if (source.rel) return joinPath(root, source.rel);
  if (source.home) return joinPath(home, source.home);
  if (source.appData) {
    const parts = source.appData[platform];
    if (!parts) return null;
    const base = appDataDir || (platform === 'darwin' ? joinPath(home, 'Library/Application Support') : joinPath(home, '.config'));
    return joinPath(base, ...parts);
  }
  return null;
}

/**
 * Summarise one declared server WITHOUT carrying its secrets.
 *
 * ⭐ `envKeys` AND NOT `env`. The names are what a person needs to see to decide
 * ("it wants GITHUB_TOKEN"); the values are the thing that must never leave this
 * function. Rule 2, enforced here rather than at every call site — a caller that
 * forgets to redact is a caller that leaks, so the redaction is not optional and
 * not the caller's job.
 */
export function summariseServer(name, decl) {
  const d = decl && typeof decl === 'object' ? decl : {};
  const remote = typeof d.url === 'string' && d.url;
  return {
    name: String(name),
    kind: remote ? 'remote' : 'stdio',
    // For a remote server the destination IS the identity, so it is shown.
    target: remote ? String(d.url) : String(d.command ?? ''),
    argCount: Array.isArray(d.args) ? d.args.length : 0,
    envKeys: d.env && typeof d.env === 'object' ? Object.keys(d.env).sort() : [],
    /**
     * ⚠️ A DECLARATION WITH NEITHER IS BROKEN, AND SAYING SO IS THE POINT.
     * `readMcpConfig` would reject it later with a message about OUR file; a
     * person needs to know it was already broken where it came from.
     */
    usable: Boolean(remote || d.command),
  };
}

/**
 * Find every MCP server declared by another tool on this machine.
 *
 * @returns {{ sources: object[], importable: number, alreadyRead: number }}
 */
export function collectImportableServers({
  root = '.',
  home = '',
  platform = process.platform,
  appDataDir = '',
  exists = () => false,
  readFile = () => '',
} = {}) {
  const sources = [];

  for (const source of IMPORT_SOURCES) {
    const path = resolveSourcePath(source, { root, home, platform, appDataDir });
    if (!path || !exists(path)) continue;

    let raw;
    try {
      raw = readFile(path);
    } catch {
      sources.push({ ...describeSource(source), path, error: 'unreadable' });
      continue;
    }
    if (typeof raw !== 'string' || raw.length > MAX_CONFIG_BYTES) {
      sources.push({ ...describeSource(source), path, error: 'too large to be a config' });
      continue;
    }

    let parsed;
    try {
      /**
       * ── ⚠️⚠️ THE BOM, FOUND BY RUNNING THE REAL COMMAND ────────────────────
       *
       * `JSON.parse` throws on a leading U+FEFF, and a UTF-8 BOM is what every
       * Windows tool writes by default — PowerShell's `Set-Content -Encoding
       * utf8`, Notepad, and plenty of editors. Caught 2026-08-31 the first time
       * this ran outside a unit test: a byte-for-byte VALID Cursor config was
       * reported as *"not valid JSON"*.
       *
       * ⭐ AND THAT IS THE WORST SHAPE OF WRONG ANSWER WE COULD GIVE HERE. The
       * user opens the file, sees perfectly good JSON, and concludes our
       * importer is broken — which it was. Rule 3 says name a broken config
       * rather than repair it; a BOM is not a broken config, it is an encoding,
       * and stripping it is decoding rather than guessing.
       */
      parsed = JSON.parse(raw.replace(/^﻿/, ''));
    } catch {
      // Rule 3 — named, never repaired.
      sources.push({ ...describeSource(source), path, error: 'not valid JSON' });
      continue;
    }

    const block = parsed?.[source.key];
    const servers = block && typeof block === 'object'
      ? Object.entries(block).map(([n, d]) => summariseServer(n, d))
      : [];
    if (!servers.length) continue;

    sources.push({ ...describeSource(source), path, servers });
  }

  const importable = sources
    .filter((s) => !s.alreadyRead && !s.error)
    .reduce((n, s) => n + s.servers.length, 0);
  const alreadyRead = sources
    .filter((s) => s.alreadyRead)
    .reduce((n, s) => n + (s.servers?.length ?? 0), 0);

  return { sources, importable, alreadyRead };
}

function describeSource(source) {
  return {
    tool: source.tool,
    scope: source.scope,
    alreadyRead: Boolean(source.alreadyRead),
    servers: [],
  };
}

/**
 * Render the finding for a person in a terminal.
 *
 * ⭐ IT ENDS BY SAYING NOTHING HAPPENED. The single most important line in the
 * output is the one confirming no server was started and no file was written —
 * because the reader's reasonable assumption, on seeing a list of their servers
 * appear in a new tool, is that it connected them.
 */
export function describeImport(result) {
  if (!result || !result.sources.length) return null;
  const lines = [];

  for (const s of result.sources) {
    if (s.error) {
      lines.push(`⚠️  ${s.tool} (${s.scope}) — ${s.path}: ${s.error}`);
      continue;
    }
    if (s.alreadyRead) {
      lines.push(`✓  ${s.tool} (${s.scope}) — ${s.servers.length} server(s) in ${s.path}, already read by Acuvo. Nothing to do.`);
      continue;
    }
    lines.push(`•  ${s.tool} (${s.scope}) — ${s.path}`);
    for (const srv of s.servers) {
      const env = srv.envKeys.length ? `, needs ${srv.envKeys.join(', ')}` : '';
      const broken = srv.usable ? '' : '  ⚠️ no command or url — broken where it came from';
      lines.push(`     ${srv.name}  [${srv.kind}] ${srv.target}${srv.argCount ? ` +${srv.argCount} args` : ''}${env}${broken}`);
    }
  }

  if (!result.importable) {
    lines.push('', 'Nothing new to import.');
    return lines.join('\n');
  }

  lines.push(
    '',
    `${result.importable} server(s) could be brought across.`,
    '⚠️ Nothing has been started and nothing has been written. An MCP server runs a',
    '   command on this machine, so copying one is your decision, not ours.',
    '   Review the commands above, then: acuvo mcp add <name>',
  );
  return lines.join('\n');
}
