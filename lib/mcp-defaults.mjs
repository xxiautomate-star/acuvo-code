/**
 * ── ⭐⭐ MCP DEFAULTS — THE CURATED SET, AND WHY IT IS SO SMALL ──────────────
 *
 * `mcp.mjs` proved this CLI is a working MCP client: read a config, spawn the
 * servers, namespace their tools, call them, shut them down. What it does NOT
 * do is tell a new user which servers are worth having. Neither does anyone
 * else — Claude Code, Cursor, Cline and Codex all speak MCP, and all four hand
 * you an empty config file and wish you luck.
 *
 * ⭐ THE OPPORTUNITY IS THE DEFAULT SET, NOT THE PROTOCOL. MCP access is an
 * open standard and is not our edge. "Acuvo arrives already able to do X" is a
 * claim none of the others make, and it is integration work, not invention.
 *
 * ── ⚠️⚠️ AND THE HARD PART IS THE HONESTY, WHICH COST THIS FILE ITS SIZE ────
 *
 * The obvious version of this module is forty servers copied off a README. I
 * measured what that would actually do on this machine, through the real
 * `connectServer`, and the numbers killed it:
 *
 *   · `npx -y @modelcontextprotocol/server-filesystem` — REFUSED. `mcp.mjs`
 *     deliberately injects `--no` and strips `-y`, so npx may only run a
 *     package that is ALREADY INSTALLED. npx spent 12s asking the registry and
 *     then said "npx canceled due to missing packages and no YES option".
 *   · `npx firecrawl-mcp` — the package IS installed globally here, and it
 *     still failed: "Either FIRECRAWL_API_KEY or FIRECRAWL_API_URL must be
 *     provided".
 *   · `node <packageRoot>/bin/acuvo-mcp.mjs` — connected in **156ms** with no
 *     download and no credentials, and offered **zero tools**, because its two
 *     tools are gated on RENDER_AUDIT_URL / MODAL_PRESS_URL.
 *
 * ⚠️⚠️ **A DARK ENTRY COSTS 20 SECONDS, NOT NOTHING.** Both failures above were
 * reported by `connectServer` at **20,052ms** and **20,083ms** — the full
 * `HANDSHAKE_TIMEOUT_MS`. The underlying process had already died in under a
 * second; the client waits out the whole budget regardless. So a "harmless"
 * default that happens to be unconfigured is a **20-second stall before the
 * user's first prompt**, and four of them is a minute and a half.
 *
 * ⭐ THAT is why this module exists and why it is PURE. The point is not to
 * publish a list. The point is to decide, WITHOUT SPAWNING ANYTHING, which
 * entries provably cannot work here, so they are never spawned and never
 * charged for. `assessCatalogue` is a precheck, and every 'dark' it returns is
 * 20 seconds the session does not spend.
 *
 * ── THE RULES, ENFORCED BY TESTS RATHER THAN BY INTENTION ───────────────────
 *   1. Nothing that needs a DOWNLOAD is enabled by default. It cannot work —
 *      `--no` forbids the install — so enabling it buys a guaranteed 20s stall.
 *   2. Nothing that needs CREDENTIALS is enabled by default, for the same
 *      arithmetic: no key, no handshake, 20s gone.
 *   3. Nothing UNVERIFIED is enabled by default. An entry nobody ran is a
 *      promise, and this repo has spent the day deleting promises.
 *   4. Every entry that needs a download must carry the exact install command,
 *      because "install it yourself" without the line to paste is not help.
 *
 * ⚠️ WHAT I PERSONALLY RAN, so nobody has to guess which claims are load-bearing:
 *   · `acuvo`      — VERIFIED, end to end, through `readMcpConfig` +
 *                    `connectServer`. Connected, listed tools, closed clean.
 *   · `filesystem` — VERIFIED FAILING. I ran it and watched npx refuse.
 *   · `firecrawl`  — VERIFIED FAILING. I ran it and read its own complaint.
 * Everything else in `CATALOGUE` is marked `verified: false` and is INERT: it
 * can never be enabled, never be rendered active, and exists only so the
 * availability report can name the install command. I did not run those, and
 * the entry says so rather than implying otherwise by sitting in a list.
 *
 * ⚠️ THE HONEST LIMIT OF THIS FILE: it decides what CANNOT work. It cannot
 * promise that a `live` entry WILL work — a key can be revoked and a package
 * can be broken. `live` here means "nothing we can check from memory rules it
 * out", which is a smaller claim than it looks and is deliberately worded that
 * way everywhere it surfaces.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { MAX_SERVERS, HANDSHAKE_TIMEOUT_MS, MCP_CONFIG_FILES } from './mcp.mjs';

/**
 * ⭐ IMPORTED, NOT RETYPED. `readMcpConfig` silently `break`s past the 9th
 * server, so a renderer with its own idea of the cap would emit a config whose
 * tail is dropped without a word. The cap has to be the same number by
 * construction, not by comment.
 */
export { MAX_SERVERS, HANDSHAKE_TIMEOUT_MS, MCP_CONFIG_FILES };

/** Where `renderStarterConfig`'s output is meant to be written. */
export const STARTER_CONFIG_FILE = MCP_CONFIG_FILES[0];

/**
 * The token standing in for this package's install directory inside `args`.
 *
 * ⚠️ A LITERAL ABSOLUTE PATH CANNOT LIVE IN THE CATALOGUE. The catalogue is a
 * constant; the path is different on every machine and is not knowable until
 * someone asks for a rendered config. Substituting at render time keeps the
 * data pure and keeps the rendered file correct.
 */
export const PACKAGE_ROOT_TOKEN = '{ACUVO_PACKAGE_ROOT}';

/** This package's root, for the default substitution. Computed, no I/O. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ⚠️ Measured, and it is the whole argument for the precheck: this is what a
 * dark entry costs at session start. Not a guess — `connectServer` returned at
 * 20,052ms and 20,083ms for the two failures described in the header.
 */
export const DARK_ENTRY_COST_MS = HANDSHAKE_TIMEOUT_MS;

/**
 * ── THE CATALOGUE ───────────────────────────────────────────────────────────
 *
 * Fields, and why each one is here rather than being obvious from the command:
 *
 *   name          becomes `mcp__<name>__<tool>`, so it must satisfy the server
 *                 name rule in `readMcpConfig` or the whole config is rejected.
 *   purpose       one honest line. Not marketing — what you get.
 *   command/args  exactly what `mcp.mjs` will spawn. No shell, no expansion.
 *   needsDownload true when the package is not already on the machine. Under
 *                 this client that means it CANNOT self-install.
 *   install       the line to paste. Required whenever needsDownload is true.
 *   credentials   [{ env, required, why }]. `required: false` means the server
 *                 starts without it but offers fewer tools.
 *   verified      did I personally run it, through the real client?
 *   note          what running it actually did, or why it is unverified.
 *   enabledByDefault  only ever true when verified && !needsDownload && no
 *                 required credentials. Tests enforce this; see the header.
 */
export const CATALOGUE = Object.freeze([
  Object.freeze({
    name: 'acuvo',
    purpose: 'Render HTML in a real browser and get the screenshot plus measured layout and contrast defects back; turn HTML into a PDF, PNG or PPTX.',
    command: 'node',
    args: Object.freeze([`${PACKAGE_ROOT_TOKEN}/bin/acuvo-mcp.mjs`]),
    /**
     * ⭐ THE ONLY ENTRY THAT NEEDS NO DOWNLOAD, because we ship it. `bin/
     * acuvo-mcp.mjs` is in this package's `files` list, so it is on disk the
     * moment acuvo-code is.
     *
     * ⚠️ AND IT IS SPAWNED AS `node <abs path>`, NOT AS `acuvo-mcp`. I tried
     * the bare bin name and got ENOENT: the shim is `acuvo-mcp.cmd`, and
     * `resolveExecutable` only finds it when PATH is separated the Windows way
     * — under Git Bash PATH is `:`-separated and the lookup misses entirely.
     * `node` resolves as `node.exe` everywhere, and an absolute script path
     * needs no lookup at all.
     */
    needsDownload: false,
    install: null,
    credentials: Object.freeze([
      Object.freeze({ env: 'RENDER_AUDIT_URL', required: false, why: 'without it the `see_page` tool is not offered' }),
      Object.freeze({ env: 'MODAL_PRESS_URL', required: false, why: 'without it the `make_document` tool is not offered' }),
      Object.freeze({ env: 'MODAL_VIDEO_SECRET', required: false, why: 'only if those services require a shared secret' }),
    ]),
    verified: true,
    note: 'Ran it: connected in 156ms with no download and no credentials, and offered zero tools — its two tools are gated on the URLs above. It stays up and answers with an empty list rather than dying, so it costs a spawn and never a 20s timeout.',
    enabledByDefault: true,
  }),

  Object.freeze({
    name: 'filesystem',
    purpose: 'Read and write files under directories you name — the reference MCP server, and the usual first one people add.',
    command: 'npx',
    args: Object.freeze(['-y', '@modelcontextprotocol/server-filesystem', '.']),
    needsDownload: true,
    install: 'npm i -g @modelcontextprotocol/server-filesystem',
    credentials: Object.freeze([]),
    verified: true,
    note: 'Ran it: REFUSED. `mcp.mjs` injects `--no` and strips `-y`, so npx may only run an already-installed package. npx spent 12s on the registry then said "npx canceled due to missing packages and no YES option", and connectServer still reported it at 20,083ms. Install it globally first and this entry works.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'firecrawl',
    purpose: 'Fetch and crawl web pages as clean markdown, including JavaScript-rendered ones.',
    command: 'npx',
    args: Object.freeze(['-y', 'firecrawl-mcp']),
    needsDownload: true,
    install: 'npm i -g firecrawl-mcp',
    credentials: Object.freeze([
      Object.freeze({ env: 'FIRECRAWL_API_KEY', required: true, why: 'the server refuses to start without it' }),
    ]),
    verified: true,
    note: 'Ran it with the package already installed globally: it still failed, with its own message — "Either FIRECRAWL_API_KEY or FIRECRAWL_API_URL must be provided" — and connectServer reported it at 20,052ms. This is the entry that proves the credential rule is about latency, not tidiness.',
    enabledByDefault: false,
  }),

  /**
   * ── ⚠️ BELOW HERE: UNVERIFIED, AND THEREFORE INERT ────────────────────────
   * I did not run these. They are real, widely-used servers and the commands
   * are the documented ones, but "documented" is not "measured" and this file
   * refuses to blur the two. They can never be enabled and are never rendered
   * active; they exist so the availability report can hand over an install
   * command instead of a shrug. Promote one by RUNNING it and rewriting `note`
   * with what happened.
   */
  Object.freeze({
    name: 'git',
    purpose: 'Read repository history, diffs and blame directly, without spending shell rounds on `git log` output.',
    command: 'npx',
    args: Object.freeze(['-y', 'mcp-server-git']),
    needsDownload: true,
    install: 'npm i -g mcp-server-git',
    credentials: Object.freeze([]),
    verified: false,
    note: 'NOT RUN by me. Listed for the install command only. Needs a download, so it cannot start under this client until it is installed.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'github',
    purpose: 'Issues and pull requests — open, read and comment on your issue tracker from inside a run.',
    command: 'npx',
    args: Object.freeze(['-y', '@modelcontextprotocol/server-github']),
    needsDownload: true,
    install: 'npm i -g @modelcontextprotocol/server-github',
    credentials: Object.freeze([
      Object.freeze({ env: 'GITHUB_PERSONAL_ACCESS_TOKEN', required: true, why: 'every call is authenticated; the server will not start without it' }),
    ]),
    verified: false,
    note: 'NOT RUN by me. Listed for the install command only. Needs both a download and a token, so it is dark twice over.',
    enabledByDefault: false,
  }),

  Object.freeze({
    name: 'postgres',
    purpose: 'Run read-only queries against a Postgres database and inspect its schema.',
    command: 'npx',
    args: Object.freeze(['-y', '@modelcontextprotocol/server-postgres']),
    needsDownload: true,
    install: 'npm i -g @modelcontextprotocol/server-postgres',
    credentials: Object.freeze([
      Object.freeze({ env: 'POSTGRES_CONNECTION_STRING', required: true, why: 'there is nothing to connect to without it' }),
    ]),
    verified: false,
    note: 'NOT RUN by me. Listed for the install command only. Needs both a download and a connection string.',
    enabledByDefault: false,
  }),
]);

/** Look one up by name. Returns null rather than throwing — callers branch anyway. */
export function catalogueEntry(name) {
  return CATALOGUE.find((e) => e.name === name) ?? null;
}

/**
 * Substitute `PACKAGE_ROOT_TOKEN` in an entry's args.
 *
 * ⚠️ FORWARD SLASHES ARE LEFT ALONE ON PURPOSE. Windows accepts them in a path
 * passed to `node`, and rewriting them to backslashes would put an escape
 * character into a JSON file that a human is expected to read and edit.
 */
export function resolveArgs(entry, { packageRoot = PACKAGE_ROOT } = {}) {
  const root = String(packageRoot).split(String.fromCharCode(92)).join('/');
  return (entry?.args ?? []).map((a) => a.split(PACKAGE_ROOT_TOKEN).join(root));
}

/** The `mcp.mjs` server spec for an entry — what `connectServer` wants. */
export function toServerSpec(entry, { packageRoot = PACKAGE_ROOT } = {}) {
  return {
    name: entry.name,
    command: entry.command,
    args: resolveArgs(entry, { packageRoot }),
    env: {},
  };
}

/** The credentials an entry cannot start without. */
export function requiredCredentials(entry) {
  return (entry?.credentials ?? []).filter((c) => c.required);
}

function present(env, name) {
  const v = env?.[name];
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * ── ⭐ THE PRECHECK — DECIDE WITHOUT SPAWNING ───────────────────────────────
 *
 * Returns doctor's shape (`state` / `detail` / `fix`) so a doctor lane can drop
 * these straight into its check list without a translation layer.
 *
 * `installed` is INJECTED rather than probed. Whether a package is on disk is
 * an I/O question, and this module stays pure so it is testable with no
 * network and no filesystem. A caller that knows (the doctor, which is already
 * allowed to look) passes a Set of package names; a caller that does not gets
 * the honest answer that a download-needing entry cannot be assumed present.
 *
 * ⚠️ `state: 'live'` IS THE WEAKER CLAIM IT LOOKS LIKE. It means "nothing
 * checkable rules this out", not "this will work". A revoked key looks exactly
 * like a good one from here, and the wording of `detail` never pretends
 * otherwise.
 */
export function assessEntry(entry, { env = process.env, installed = null, packageRoot = PACKAGE_ROOT } = {}) {
  const base = {
    id: `mcp.${entry.name}`,
    label: entry.name,
    entry: entry.name,
    purpose: entry.purpose,
    verified: entry.verified,
    enabledByDefault: entry.enabledByDefault,
  };

  // ⚠️ DOWNLOAD FIRST: it is the reason that cannot be worked around by setting
  // a variable, so reporting a missing key on a package that is not even here
  // would send the user to fix the second problem first.
  if (entry.needsDownload) {
    const known = installed instanceof Set ? installed : null;
    const pkg = packageOf(entry);
    if (!known || !known.has(pkg)) {
      return {
        ...base,
        state: 'dark',
        detail: known
          ? `${pkg} is not installed — this client passes npx \`--no\`, so it cannot download it`
          : `needs ${pkg}, and whether it is installed was not checked — this client passes npx \`--no\`, so it cannot download it`,
        fix: `${entry.install} — then re-run. Leaving it unconfigured costs a ${Math.round(DARK_ENTRY_COST_MS / 1000)}s timeout every session it is enabled.`,
        costMs: DARK_ENTRY_COST_MS,
      };
    }
  }

  const missing = requiredCredentials(entry).filter((c) => !present(env, c.env));
  if (missing.length > 0) {
    const names = missing.map((c) => c.env).join(', ');
    return {
      ...base,
      state: 'dark',
      detail: `${names} ${missing.length === 1 ? 'is' : 'are'} not set — ${missing[0].why}`,
      fix: `set ${names}. Until then this server cannot start, and enabling it costs a ${Math.round(DARK_ENTRY_COST_MS / 1000)}s timeout every session.`,
      costMs: DARK_ENTRY_COST_MS,
    };
  }

  const optionalMissing = (entry.credentials ?? []).filter((c) => !c.required && !present(env, c.env));
  const detail = optionalMissing.length > 0
    ? `can start; ${optionalMissing.map((c) => c.env).join(', ')} not set, so it will offer fewer tools`
    : 'can start, and nothing checkable rules it out';

  return {
    ...base,
    state: 'live',
    detail,
    /**
     * ⚠️ EACH REASON STAYS ATTACHED TO ITS VARIABLE. Joining the names and then
     * joining the reasons produced "without it …; without it …", where "it"
     * pointed at nothing — three variables and three dangling pronouns.
     */
    fix: optionalMissing.length > 0
      ? `set ${optionalMissing.map((c) => `${c.env} (${c.why})`).join('; ')}`
      : null,
    costMs: 0,
    command: `${entry.command} ${resolveArgs(entry, { packageRoot }).join(' ')}`.trim(),
  };
}

/** The npm package an entry runs, for install checks. Null when we ship it. */
export function packageOf(entry) {
  if (!entry?.needsDownload) return null;
  // The first arg that is not a flag is the package npx would run.
  return (entry.args ?? []).find((a) => !a.startsWith('-')) ?? null;
}

/** Assess every entry. Same order as the catalogue, so output is stable. */
export function assessCatalogue({ env = process.env, installed = null, packageRoot = PACKAGE_ROOT } = {}) {
  return CATALOGUE.map((e) => assessEntry(e, { env, installed, packageRoot }));
}

/**
 * The entries that should actually be spawned here: enabled by default AND
 * assessed live.
 *
 * ⚠️ BOTH CONDITIONS, NOT EITHER. `enabledByDefault` is a property of the
 * catalogue; `live` is a property of this machine right now. An entry can be a
 * fine default and still be dark today, and spawning it anyway is the 20s
 * stall this whole module exists to avoid.
 */
export function defaultServerSpecs({ env = process.env, installed = null, packageRoot = PACKAGE_ROOT } = {}) {
  const assessed = new Map(assessCatalogue({ env, installed, packageRoot }).map((a) => [a.entry, a]));
  return CATALOGUE
    .filter((e) => e.enabledByDefault && assessed.get(e.name)?.state === 'live')
    .slice(0, MAX_SERVERS)
    .map((e) => toServerSpec(e, { packageRoot }));
}

/**
 * ── THE STARTER CONFIG ──────────────────────────────────────────────────────
 *
 * ⚠️ `mcp.json` IS STRICT JSON, SO THE EXPLANATIONS CANNOT BE COMMENTS. They go
 * in `_disabled`, a key `readMcpConfig` never reads (it takes `mcpServers` ??
 * `servers` and nothing else). The user gets the whole catalogue in the file
 * they are already editing, with the reason each one is off and the command
 * that turns it on — and the client still only ever spawns what is in
 * `mcpServers`.
 *
 * ⚠️ CAPPED AT `MAX_SERVERS`, because `readMcpConfig` drops the overflow with a
 * bare `break` — no error, no warning. Rendering a 10-entry config would be
 * rendering two entries that silently never run.
 */
export function renderStarterConfig({ env = process.env, installed = null, packageRoot = PACKAGE_ROOT } = {}) {
  const assessed = new Map(assessCatalogue({ env, installed, packageRoot }).map((a) => [a.entry, a]));

  const mcpServers = {};
  const _disabled = {};

  for (const entry of CATALOGUE) {
    const a = assessed.get(entry.name);
    const active = entry.enabledByDefault && a?.state === 'live' && Object.keys(mcpServers).length < MAX_SERVERS;
    if (active) {
      mcpServers[entry.name] = {
        command: entry.command,
        args: resolveArgs(entry, { packageRoot }),
      };
      continue;
    }
    _disabled[entry.name] = {
      what: entry.purpose,
      why_off: a?.detail ?? 'not enabled by default',
      to_enable: a?.fix ?? null,
      verified_by_us: entry.verified,
      note: entry.note,
      command: entry.command,
      args: resolveArgs(entry, { packageRoot }),
    };
  }

  return {
    // ⭐ A header the user reads before the servers, in a key the client ignores.
    _readme: [
      `Written by acuvo-code. Only "mcpServers" is read; "_disabled" is documentation.`,
      `Move an entry from _disabled into mcpServers to turn it on — its "to_enable" says what it needs first.`,
      `A server that cannot start costs a ${Math.round(DARK_ENTRY_COST_MS / 1000)}s timeout at session start, which is why they are off.`,
      `At most ${MAX_SERVERS} servers are read; anything past that is silently ignored.`,
    ].join(' '),
    mcpServers,
    _disabled,
  };
}

/** The starter config as the text to write to `.acuvo/mcp.json`. */
export function renderStarterConfigJson(opts = {}) {
  return `${JSON.stringify(renderStarterConfig(opts), null, 2)}\n`;
}

/**
 * A human-readable availability report — what is usable here and what is dark,
 * with the reason and the fix on the same line as the name.
 */
export function formatAvailability(report) {
  const rows = Array.isArray(report) ? report : assessCatalogue(report ?? {});
  const live = rows.filter((r) => r.state === 'live');
  const lines = [
    `MCP defaults — ${live.length} of ${rows.length} usable here`,
    '',
  ];
  for (const r of rows) {
    const mark = r.state === 'live' ? 'live' : 'dark';
    const flag = r.verified ? '' : ' (unverified — never enabled)';
    lines.push(`  ${mark.padEnd(4)}  ${r.label.padEnd(12)} ${r.detail}${flag}`);
    if (r.fix) lines.push(`        ${' '.repeat(12)} → ${r.fix}`);
  }
  const stalled = rows.filter((r) => r.state === 'dark' && r.enabledByDefault);
  if (stalled.length > 0) {
    lines.push('', `  ⚠️ ${stalled.length} default(s) would stall this session by ${Math.round((stalled.length * DARK_ENTRY_COST_MS) / 1000)}s if spawned — they are skipped.`);
  }
  return lines.join('\n');
}

/**
 * Doctor-shaped checks. Kept separate from `assessCatalogue` so the doctor's
 * list is not flooded: one line per entry is right for `--mcp`, but the health
 * report wants the summary plus only the entries a user can act on.
 */
export function doctorChecks({ env = process.env, installed = null, packageRoot = PACKAGE_ROOT } = {}) {
  const rows = assessCatalogue({ env, installed, packageRoot });
  const live = rows.filter((r) => r.state === 'live');
  const summary = {
    id: 'mcp.defaults',
    label: 'MCP defaults',
    state: live.length > 0 ? 'live' : 'dark',
    verified: true,
    detail: `${live.length} of ${rows.length} catalogue entries usable here${live.length ? ` (${live.map((r) => r.label).join(', ')})` : ''}`,
    fix: live.length > 0 ? null : `run with --mcp-init to write ${STARTER_CONFIG_FILE}, then install or configure one`,
  };
  return [summary, ...rows.filter((r) => r.enabledByDefault)];
}
