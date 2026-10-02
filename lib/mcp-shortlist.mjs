/**
 * ── ⭐⭐⭐ MCP SCHEMAS GO THROUGH A SHORTLIST TOO ─────────────────────────────
 *
 * ⚠️⚠️ THE LEAK, MEASURED 2026-08-31 by connecting to all eleven catalogue
 * servers and summing their real schemas:
 *
 *     deepwiki 3 tools 1,207 B · docs 2/3,550 · grep 1/2,351 · mslearn 3/3,785
 *     cloudflare 2/1,123 · svelte 4/4,997 · astro 1/341 · awsdocs 5/6,370
 *     convex 4/4,917 · clerk 2/832 · hf 4/5,417
 *     ── 31 tools · 34,890 B ≈ 8,723 tokens ──
 *
 * `turn.mjs` built its tool block as `[...shortlisted, ...mcpSchemas]`, so every
 * one of those bytes was re-sent on EVERY round of EVERY task, including "hi".
 * Against the 64,710-byte default offer that is **+54%**. `@playwright/mcp`
 * alone is 24 tools / 17,361 B.
 *
 * ⭐ AND THAT IS WHY ELEVEN VERIFIED, KEY-FREE, WORKING SERVERS ARE SWITCHED
 * OFF. It was never a product decision — it was a number nobody could afford.
 * Both leading competitors solved it in the protocol layer: Codex has
 * `defer_loading` on the tool spec, Claude Code has `ToolSearch` with deferred
 * schemas. This module is our version, in this codebase's idiom.
 *
 * ── ⚠️⚠️ THE TRAP THIS MODULE HAD TO AVOID, AND IT IS ALREADY WRITTEN DOWN ──
 *
 * `tool-shortlist.mjs` excludes MCP names from `shouldWiden`, and its comment
 * explains why with a measurement: a model calling `mcp__deepwiki__ask_question`
 * — a tool it HAD — was read as "the shortlist was wrong", and the offer widened
 * permanently:
 *
 *     round 1   35 tools   33,384 B
 *     round 2   62 tools   63,577 B    +30,193 B (+90.4%) for the rest of the run
 *
 * ⭐ SO THERE ARE **TWO DOORS, NOT ONE**, and conflating them is the whole bug:
 *   · REGISTRY WIDEN — the model reached for one of OUR verbs it was not given.
 *     Restores the full registry offer. Expensive, permanent, already built.
 *   · MCP REVEAL — the model reached for a tool on a server we withheld.
 *     Reveals **that one server's** schemas and nothing else. Cheap, targeted.
 *
 * A withheld MCP call must take the SECOND door. Widening the registry to answer
 * it would buy nothing (widening cannot conjure a server) and cost 30KB a round,
 * which is precisely the regression that comment records.
 */

import { parseNamespaced } from './mcp.mjs';
import { catalogueEntry } from './mcp-defaults.mjs';

/**
 * ⚠️ THE META-VERB IS THE DOOR, AND IT IS THE ONLY THING WE PAY FOR
 * UNCONDITIONALLY. A shortlist with no way back is not a shortlist, it is a
 * capability deletion — and this repo's standing lesson is that a model cannot
 * reach for a tool it has never heard of ([[feedback_an_option_is_not_a_default]]).
 *
 * ⭐ IT NAMES THE SERVERS RATHER THAN DESCRIBING THEM. The whole saving is that
 * 31 tool schemas collapse into one sentence listing 11 words; spending a
 * per-server description here would rebuild a third of what we just removed.
 */
export const USE_TOOLSET_TOOL_NAME = 'use_toolset';

/**
 * Build the `use_toolset` schema for the servers actually connected.
 *
 * Returns `null` when there is nothing withheld — an empty door is pure cost.
 */
export function useToolsetSchema(withheldServers) {
  const names = [...new Set(withheldServers ?? [])].filter(Boolean).sort();
  if (names.length === 0) return null;
  return {
    type: 'function',
    function: {
      name: USE_TOOLSET_TOOL_NAME,
      description:
        `Load the tools for one connected server when you need it: ${names.join(', ')}. `
        + 'Their tools are not listed until you ask, to keep every round small.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', enum: names },
        },
        required: ['server'],
      },
    },
  };
}

/**
 * ⚠️ WORD-BOUNDARY MATCH, NOT `includes`. A server called `hf` would otherwise
 * be signalled by the word "shelf", and `grep` by "regrep" — the class of bug
 * `tool-shortlist.mjs` calls the paraphrase failure. The server name is also
 * matched against its own tool names, so "ask_question" reaches `deepwiki`
 * without the brief naming the server at all.
 */
/**
 * ── ⚠️⚠️ A TOOL NAME IS MOSTLY VERBS EVERY BRIEF USES ─────────────────────────
 *
 * Measured 2026-09-27 with Blender's real 32-tool surface (36,581 B of schemas):
 * 6 of 10 ordinary coding briefs lit it — "fix the failing test in
 * src/api/users.ts" (`api`), "refactor the node server" (`node`), "add a search
 * box" (`search`), "set up eslint" (`set`), "rename getUser … across the code"
 * (`code`), "prints the status of each row" (`status`). Each paid ~9k tokens a
 * round for a 3D server the task never touches.
 *
 * ⭐ So the words taken FROM TOOL NAMES skip the generic CRUD/plumbing
 * vocabulary below. The server's own name always counts, and so do the
 * catalogue's hand-written `signals` (e.g. `glb`, `mesh`, `3d` for Blender) —
 * those are chosen to mean the domain, which a tool-name token never is.
 * A distinctive tool word still works: "use ask question on the repo" still
 * reaches `deepwiki` through `ask`/`question`.
 */
export const GENERIC_TOOL_WORDS = Object.freeze(new Set([
  'get', 'set', 'list', 'create', 'update', 'delete', 'remove', 'add', 'edit', 'read', 'write',
  'run', 'execute', 'call', 'use', 'make', 'build', 'new', 'open', 'close', 'save', 'load',
  'search', 'find', 'query', 'fetch', 'lookup', 'check', 'status', 'info', 'details', 'describe',
  'code', 'type', 'types', 'text', 'api', 'node', 'nodes', 'data', 'file', 'files', 'name', 'names',
  'model', 'models', 'import', 'export', 'download', 'upload', 'preview', 'job', 'poll', 'via',
  'asset', 'assets', 'generate', 'generated', 'object', 'objects', 'user', 'users', 'page', 'pages',
  'item', 'items', 'tool', 'tools', 'url', 'value', 'values', 'config', 'settings', 'result',
  'results', 'record', 'feedback', 'categories', 'category', 'image', 'images', 'screenshot',
  'the', 'and', 'for', 'with', 'from', 'all', 'one', 'by',
]));

function hintsFor(server, hints) {
  const own = hints && typeof hints === 'object' ? hints[server] : null;
  if (Array.isArray(own)) return own;
  return catalogueEntry(server)?.signals ?? [];
}

function signals(task, server, toolNames, hints) {
  const text = String(task ?? '').toLowerCase();
  if (!text.trim()) return true; // ⚠️ No brief ⇒ offer everything. Same rule as the registry shortlist.
  const toolWords = (toolNames ?? [])
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC_TOOL_WORDS.has(w));
  const serverWords = String(server ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  // Hints are matched as whole phrases (they may hold a hyphen: `low-poly`).
  const words = [...serverWords, ...toolWords, ...hintsFor(server, hints).map((h) => String(h).toLowerCase())];
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text));
}

/**
 * Narrow a list of MCP schemas to the servers this task plausibly needs, plus
 * any the model has explicitly revealed.
 *
 * ⚠️ `revealed` IS ABSOLUTE AND STICKY, exactly like the registry `widened`
 * flag. Once the model has asked for a server, second-guessing it on the next
 * round is how a run oscillates between two wrong offers.
 *
 * Returns `{ schemas, withheld }` — `withheld` is the server list the door has
 * to advertise.
 */
export function shortlistMcpSchemas(task, schemas, { revealed = [], enabled = true, hints = null } = {}) {
  const all = Array.isArray(schemas) ? schemas : [];
  if (!enabled) return { schemas: all, withheld: [] };

  /** server -> its schemas, and server -> its bare tool names */
  const byServer = new Map();
  const toolsOf = new Map();
  const unparsed = [];
  for (const s of all) {
    const parsed = parseNamespaced(s?.function?.name);
    if (!parsed) { unparsed.push(s); continue; }
    if (!byServer.has(parsed.server)) { byServer.set(parsed.server, []); toolsOf.set(parsed.server, []); }
    byServer.get(parsed.server).push(s);
    toolsOf.get(parsed.server).push(parsed.tool);
  }

  const open = new Set(revealed ?? []);
  const kept = [];
  const withheld = [];
  for (const [server, list] of byServer) {
    if (open.has(server) || signals(task, server, toolsOf.get(server), hints)) kept.push(...list);
    else withheld.push(server);
  }

  /**
   * ⚠️ AN UNPARSEABLE NAME IS KEPT, NEVER DROPPED. If `namespacedName`'s format
   * ever changes, the failure mode must be "we paid for schemas we could have
   * narrowed", not "a connected server silently vanished". Same fail-open rule
   * as the registry shortlist's unclassified-verb fallback.
   */
  kept.push(...unparsed);
  return { schemas: kept, withheld: withheld.sort() };
}

/**
 * Did the model reach for a tool on a server we withheld? Returns the server
 * name to reveal, or `null`.
 *
 * ⚠️⚠️ THIS IS THE SECOND DOOR AND IT MUST NEVER TRIGGER THE FIRST. See the
 * header: answering a withheld-MCP call by widening the REGISTRY costs ~30KB a
 * round and cannot conjure the server. `shouldWiden` in `tool-shortlist.mjs`
 * skips MCP names on purpose; this function is the reason that skip is still
 * correct now that MCP schemas are narrowed.
 *
 * ⚠️ ONLY A CONNECTED SERVER IS REVEALED. A hallucinated `mcp__nope__x` returns
 * null rather than adding an empty namespace to the sticky reveal set.
 */
export function mcpRevealTarget(calledNames, connectedServers) {
  const known = new Set(connectedServers ?? []);
  for (const n of calledNames ?? []) {
    if (typeof n !== 'string') continue;
    const parsed = parseNamespaced(n);
    if (parsed && known.has(parsed.server)) return parsed.server;
  }
  return null;
}

/** Bytes a schema list costs on the wire — the unit every ceiling here uses. */
export function schemaBytes(schemas) {
  return JSON.stringify(schemas ?? []).length;
}
