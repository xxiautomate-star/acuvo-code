/**
 * ── ⭐⭐⭐ THE OTHER DIRECTION: PUTTING ACUVO INTO SOMEBODY ELSE'S HOST ───────
 *
 * `mcp.mjs` spawns other people's servers. `mcp-server.mjs` lets other people
 * call us. `mcp-import.mjs` reads the configs other tools already wrote. This
 * file is the one move none of those make: **writing our own entry into Claude
 * Code, Cursor, VS Code, Windsurf or Claude Desktop** so a person can actually
 * reach Acuvo from the editor they already use.
 *
 * ── ⚠️⚠️⚠️ WHY THIS HAD TO EXIST, MEASURED 2026-08-31 ───────────────────────
 *
 * `acuvo-mcp` with no flags serves **ZERO tools**. Verified by running the real
 * binary and asking it `tools/list` — not inferred from the source. That is the
 * CORRECT behaviour (every group gated; a dark tool is withdrawn, never
 * degraded) and it is also a terrible first five minutes: you install the
 * package, paste the obvious three-line config into Claude Code, and get an
 * empty server with the explanation sitting in a log file the host swallowed.
 *
 * ⭐ The capability ladder is real and nobody could have guessed it:
 *
 *   0 tools   no flags
 *   11 tools  `--root <dir>`
 *   19 tools  `--root <dir> --allow-write --allow-spend <usd>`
 *   +1 each   RENDER_AUDIT_URL, MODAL_PRESS_URL
 *
 * ⚠️ THE CREATIVE GROUP NEEDS ALL THREE FLAGS AT ONCE and the middle one is not
 * guessable — the engines write their output into the workspace, so image
 * generation needs `--allow-write`, which reads like a file-editing permission
 * and not like a drawing one. `--allow-spend` alone silently does nothing. This
 * file exists so nobody has to know that.
 *
 * ── ⚠️⚠️ THE RULE THAT SHAPED THE WHOLE MODULE: SOME CONFIGS ARE IN THE REPO ─
 *
 * `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json` are PROJECT-scoped —
 * they sit inside the user's working tree and get committed. `~/.claude.json`
 * and the Windsurf/Desktop files are USER-scoped and never do.
 *
 * ⭐ So a secret may be written to a user-scoped file and MUST NOT be written to
 * a project-scoped one. Our engine URLs carry a token in the hostname; putting
 * them in `.cursor/mcp.json` would push a live GPU endpoint to GitHub the next
 * time that person committed, and nothing in the editor would have warned them.
 * `planInstall` refuses that combination by construction rather than by asking
 * the caller to remember.
 *
 * ⚠️ PURE — NO I/O, NO `process`, NO `fs`. Text and objects in, text and a
 * decision out. Same split `mcp-import.mjs` and `agentic-mcp.ts` both make, and
 * for the same reason: this is the part worth testing exhaustively, and it
 * cannot be tested exhaustively if it needs a real Claude Desktop installed.
 */

/** The name our entry takes in a host's server map. */
export const ACUVO_SERVER_NAME = 'acuvo';

/**
 * ⚠️ THE BINARY IS `acuvo-mcp`, NOT `acuvo`. Two binaries ship from one
 * package and only one of them speaks MCP on stdin. Pointing a host at `acuvo`
 * produces a server that prints human help to stdout and never answers a
 * single JSON-RPC frame — which presents as "the host says it connected and
 * then nothing works", the least debuggable failure available.
 */
export const ACUVO_MCP_BINARY = 'acuvo-mcp';

/** Env vars that light the browser/press group. Values are SECRETS. */
export const ENGINE_ENV_KEYS = Object.freeze(['RENDER_AUDIT_URL', 'MODAL_PRESS_URL']);

/**
 * ⭐⭐⭐ THE HOSTED SERVER, WHICH IS THE ONE THAT HAS EVERYTHING.
 *
 * `acuvo-mcp` (stdio) serves at most 19 tools and needs OUR engine URLs to
 * serve even those — which is fine on our machines and useless to a stranger.
 * `POST /api/mcp/rpc` is a real Streamable-HTTP MCP server over the SAME
 * executor as the product: **161 tools**, authenticated by the account's own
 * key, plan-gated and audit-rowed. Verified live 2026-08-31 — it answers 401
 * unauthenticated in production.
 *
 * ⚠️ SO THE TWO SERVERS ARE NOT COMPETITORS AND MUST NOT BE DESCRIBED AS A
 * CHOICE OF ONE. The hosted one cannot see your files; the local one cannot
 * reach your account's engines. Installing both is the correct answer, and
 * `--hosted` exists so the 161-tool half stops being invisible.
 */
export const ACUVO_HOSTED_URL = 'https://acuvo.xxiautomate.com/api/mcp/rpc';
export const ACUVO_HOSTED_NAME = 'acuvo-cloud';

/**
 * ── ⚠️⚠️⭐ NOT EVERY HOST CAN USE THE HOSTED ENTRY, AND ONE OF THEM CANNOT ───
 *
 * ⚠️ THIS IS A DEFECT WE SHIPPED, FOUND 2026-09-19. The header above already
 * said Claude Desktop cannot read an `http` entry — and the one caller of
 * `buildHostedEntry` built the entry ONCE, with the default transport, and
 * wrote that same object into every host in `IMPORT_SOURCES`. A real dry run
 * printed:
 *
 *     Claude Desktop (user): added  …/Claude/claude_desktop_config.json
 *
 * which is precisely the invisible failure this module's header exists to end:
 * the installer reports success and the host shows nothing. The `bridge`
 * branch of `buildHostedEntry` was written for exactly this and had ZERO
 * callers outside its own unit test.
 *
 * ⭐ VERIFIED FIRST-HAND against modelcontextprotocol.io on 2026-09-19, not
 * recalled: the "connect to local MCP servers" page documents
 * `claude_desktop_config.json` with `command`/`args` only, and the "connect to
 * remote MCP servers" page routes Claude Desktop through the **Custom
 * Connectors UI** (Settings → Connectors → Add custom connector → paste the
 * URL → authenticate). Neither page defines a `type`/`url` shape for that file.
 *
 * ⚠️ AND THE FIX IS A SKIP, NOT THE BRIDGE. Writing the `mcp-remote` entry
 * would put the customer's whole Acuvo account key through a SOLE-MAINTAINER
 * npm package sitting in the credential path — the documented reason
 * `lib/mcp-defaults.mjs` refuses `mcp-remote` from the curated catalogue. That
 * argument does not get weaker because the remote server is ours. So the
 * `bridge` branch stays available to a caller that wants it and is
 * deliberately not reached from here; do not "wire it up" without taking that
 * decision again, in the open.
 *
 * ⚠️ `HOSTED_TRANSPORT_BY_TOOL` DESCRIBES THE **HOSTED** INSTALL ONLY. The
 * stdio install writes `command`/`args`, which is the shape every one of these
 * hosts documents — Claude Desktop included — so `acuvo mcp install` without
 * `--hosted` is unaffected and must stay that way.
 *
 * ⚠️ Windsurf is carried at `'http'` because that is what this module already
 * emitted; it is the STATUS QUO, not a verified claim. If somebody proves it
 * needs the bridge, this is the one line to change.
 */
export const HOSTED_TRANSPORT_BY_TOOL = Object.freeze({
  'Claude Code': 'http',
  Cursor: 'http',
  'VS Code': 'http',
  Windsurf: 'http',
  'Claude Desktop': 'ui',
});

/** What a host does with a REMOTE server: `'http'` from its config, or `'ui'`
 *  — meaning the config file is not the way in and a human uses the app. An
 *  unknown tool is `'http'`, matching what this module emitted before. */
export function hostedTransportFor(tool) {
  return HOSTED_TRANSPORT_BY_TOOL[String(tool ?? '')] ?? 'http';
}

/** Why a `'ui'` host is skipped, in words a person can act on. */
export const HOSTED_UI_REASON =
  'this app does not take a remote server from its config file — '
  + 'add it in the app instead: Settings → Connectors → Add custom connector';

/**
 * ⚠️⚠️ A SECRET IS NOT ONLY AN `env` VALUE, AND ASSUMING IT WAS LEFT A HOLE.
 *
 * The stdio entry carries credentials in `env`, so the project-scope refusal
 * originally looked there and nowhere else. A HOSTED entry carries the account
 * key in `headers.Authorization` — a strictly worse secret than a Modal URL,
 * because it is the customer's whole account — and it would have sailed
 * straight into a committed `.cursor/mcp.json`.
 *
 * ⭐ Found by adding the feature the guard did not yet know about, which is the
 * argument for writing the guard against the CONCEPT ("does this entry carry a
 * credential") rather than against the one shape that existed at the time.
 */
export function entryCarriesSecret(entry) {
  if (!entry || typeof entry !== 'object') return false;
  /**
   * ⚠️ `Boolean(...)`, NOT THE BARE CHAIN. `o && typeof o === 'object' && …`
   * yields `undefined` when the pocket is absent, and a predicate that answers
   * `undefined` instead of `false` is one `=== false` away from a caller
   * deciding a secret-bearing entry is safe. Caught by a strict-equality test,
   * which is exactly why the test asserts `false` and not merely falsiness.
   */
  const has = (o) => Boolean(o && typeof o === 'object'
    && Object.values(o).some((v) => typeof v === 'string' && v.trim()));
  return has(entry.env) || has(entry.headers);
}

/**
 * Build the entry for the hosted server.
 *
 * ⚠️ `type: 'http'` IS NOT UNIVERSAL. Claude Code, Cursor and VS Code speak it;
 * Claude Desktop still needs the `mcp-remote` stdio bridge. Emitting the http
 * shape everywhere would write a config that a host silently ignores, which
 * presents as "it connected and there are no tools" — the same invisible
 * failure this whole module exists to end.
 */
export function buildHostedEntry({ url = ACUVO_HOSTED_URL, token = '', transport = 'http' } = {}) {
  const key = String(token ?? '').trim();
  if (!key) {
    return { ok: false, error: 'no account key — run `acuvo --login` first, or pass --key' };
  }
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, error: 'the hosted server must be an https URL' };
  }
  if (transport === 'bridge') {
    return {
      ok: true,
      entry: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${key}`] },
    };
  }
  return { ok: true, entry: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } };
}

/**
 * Strip a UTF-8 BOM.
 *
 * ⚠️⚠️ THIS IS NOT DEFENSIVE PROGRAMMING, IT IS A BUG WE ALREADY SHIPPED.
 * `JSON.parse` throws on a leading U+FEFF, and PowerShell's `>`, `Out-File` and
 * Notepad all write one by default. A perfectly valid Cursor config was read as
 * "not valid JSON" for exactly this reason, and the failure was invisible until
 * the real command ran. Every read in this module goes through here.
 */
export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse a host config.
 *
 * ⚠️ AN EMPTY OR ABSENT FILE IS `{}`, WHICH IS NOT THE SAME AS A CORRUPT ONE.
 * "Nothing installed yet" must proceed; "this file is not JSON" must STOP,
 * because the alternative is overwriting a config a person spent an afternoon
 * on with a fresh object containing only us.
 */
export function parseHostConfig(text) {
  const raw = stripBom(text ?? '').trim();
  if (!raw) return { ok: true, config: {}, existed: false };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'the config file is valid JSON but not an object — refusing to replace it' };
    }
    return { ok: true, config: parsed, existed: true };
  } catch (err) {
    return { ok: false, error: `the config file is not valid JSON (${String(err?.message ?? err).split('\n')[0]}) — refusing to overwrite it` };
  }
}

/**
 * Build the `acuvo` server entry for a host.
 *
 * ⭐ FLAGS ARE EMITTED AS A SET, NEVER PIECEMEAL. `--allow-spend` without
 * `--root` and `--allow-write` is a no-op that looks like a configuration, so
 * asking for spend without a root is refused here rather than written out and
 * discovered later as an empty tool list.
 */
export function buildServerEntry({
  root = null,
  allowWrite = false,
  allowSpendUsd = null,
  env = {},
  binary = ACUVO_MCP_BINARY,
} = {}) {
  const args = [];
  if (root) args.push('--root', root);
  if (allowWrite) args.push('--allow-write');
  if (allowSpendUsd != null) {
    if (!root || !allowWrite) {
      return { ok: false, error: 'spending needs --root and --allow-write as well; the engines write their output into the workspace' };
    }
    if (!(Number(allowSpendUsd) > 0)) {
      return { ok: false, error: 'a spend ceiling must be a positive number of dollars' };
    }
    args.push('--allow-spend', String(allowSpendUsd));
  }
  const entry = { command: binary, args };
  const envKeys = Object.keys(env).filter((k) => typeof env[k] === 'string' && env[k].trim());
  if (envKeys.length) {
    entry.env = {};
    for (const k of envKeys.sort()) entry.env[k] = env[k];
  }
  return { ok: true, entry };
}

/**
 * Decide what installing into one host would do, WITHOUT doing it.
 *
 * Returns `{ ok, action, text, reason }` where `action` is one of
 * `added` · `updated` · `unchanged` · `refused`.
 *
 * ⚠️ `unchanged` IS A REAL OUTCOME AND MUST NOT BE REPORTED AS SUCCESS-BY-WRITE.
 * Re-running an installer is the normal case, and a tool that says "installed!"
 * every time teaches people it worked even on the run where it did not.
 */
export function planInstall({
  configText = '',
  key = 'mcpServers',
  entry,
  name = ACUVO_SERVER_NAME,
  scope = 'user',
  force = false,
} = {}) {
  if (!entry || typeof entry !== 'object') {
    return { ok: false, action: 'refused', reason: 'no server entry was supplied' };
  }

  /**
   * ⭐⭐ THE SECRET/SCOPE REFUSAL. A project-scoped config lives in the user's
   * repository. Our engine URLs are credentials — the token is in the hostname
   * — so writing them there stages a live GPU endpoint for the next commit.
   * Refused by construction: the caller cannot opt out of this one, because the
   * person who would be harmed is not the person running the command.
   */
  if (scope === 'project' && entryCarriesSecret(entry)) {
    return {
      ok: false,
      action: 'refused',
      /**
       * ⚠️ THE WORDING SAID "environment values" AND THAT WENT STALE THE HOUR
       * `--hosted` LANDED — that entry carries the account key in an
       * `Authorization` header, not in `env`. A refusal that names the wrong
       * field sends the reader to check something that is already empty.
       */
      reason: 'this config lives inside the repository, and the entry carries a credential '
        + '(an account key or an engine URL) — install into the user-scoped config instead',
    };
  }

  const parsed = parseHostConfig(configText);
  if (!parsed.ok) return { ok: false, action: 'refused', reason: parsed.error };

  const config = parsed.config;
  const existingMap = config[key];
  if (existingMap != null && (typeof existingMap !== 'object' || Array.isArray(existingMap))) {
    return { ok: false, action: 'refused', reason: `"${key}" exists but is not an object — refusing to replace it` };
  }

  const servers = { ...(existingMap ?? {}) };
  const prior = servers[name];
  const identical = prior != null && JSON.stringify(prior) === JSON.stringify(entry);
  if (identical) {
    return { ok: true, action: 'unchanged', text: null, reason: 'the same entry is already there' };
  }
  /**
   * ⚠️ AN EXISTING ENTRY IS SOMEBODY'S DECISION UNTIL THEY SAY OTHERWISE. It
   * may carry a hand-tuned root or a spend ceiling they chose deliberately;
   * silently replacing it is how an installer destroys a working setup and
   * reports success.
   */
  if (prior != null && !force) {
    return {
      ok: false,
      action: 'refused',
      reason: `"${name}" is already configured here with different settings — re-run with force to replace it`,
    };
  }

  servers[name] = entry;
  /**
   * ⭐ READ-MODIFY-WRITE, AND EVERY OTHER KEY SURVIVES. These files hold far
   * more than servers — Claude Code's `~/.claude.json` carries project history
   * and preferences. Regenerating the object from our fields would delete all
   * of it, and it would look exactly like a successful install.
   */
  const next = { ...config, [key]: servers };
  return {
    ok: true,
    action: prior == null ? 'added' : 'updated',
    text: `${JSON.stringify(next, null, 2)}\n`,
    reason: null,
  };
}

/** One line a human can read, per host. */
export function describeInstall(host, plan) {
  const where = `${host.tool} (${host.scope})`;
  if (plan.action === 'added') return `${where}: added`;
  if (plan.action === 'updated') return `${where}: updated`;
  if (plan.action === 'unchanged') return `${where}: already configured`;
  return `${where}: skipped — ${plan.reason}`;
}
