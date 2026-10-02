/**
 * ── ⭐⭐⭐ THE FULL SWEEP: EVERYTHING ANOTHER TOOL LEFT ON THIS DISK ──────────
 *
 * `CARRY-OVER.md` L3. `mcp-import.mjs` took the servers; `project-memory.mjs`
 * took the rules file. This takes the rest — the assets a person BUILT UP over
 * months and would have to rebuild by hand:
 *
 *   · **slash commands**  `.claude/commands/*.md`, `.cursor/commands/*.md`
 *   · **skills**          `.claude/skills/<name>/SKILL.md`
 *   · **hooks**           `.claude/settings.json` → `hooks`
 *
 * ⭐ THESE ARE THE STICKIEST THING IN A CODING TOOL AND THE LEAST PORTABLE. A
 * model is rented and swappable; a `/deploy` command somebody wrote and refined
 * over four months is theirs, and having to rewrite it is the single most
 * concrete reason not to move.
 *
 * ── ⚠️⚠️ HOOKS ARE NOT LIKE THE OTHER TWO ───────────────────────────────────
 * A hook is a SHELL COMMAND the harness runs automatically on an event. Copying
 * one across is handing a new tool permission to run arbitrary commands on
 * events the user has forgotten they configured — the `mcp-import` hazard with
 * no prompt in front of it. They are found, COUNTED and shown, and the output
 * says in terms that they are not brought across. There is no code path here
 * that writes one.
 *
 * ── ⚠️ WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
 * It does not TRANSLATE anything. A Claude Code command's frontmatter, its
 * `allowed-tools`, its `$ARGUMENTS` convention — those are that tool's
 * semantics, and silently rewriting them into ours would produce a command that
 * looks imported and behaves differently. It reports what exists and where, and
 * conversion is a separate, explicit act.
 *
 * Pure: every filesystem touch is injected, matching `mcp-detect.mjs` and
 * `mcp-import.mjs`.
 */

/** Where other tools keep the assets a person accumulates. */
export const ASSET_SOURCES = Object.freeze([
  { tool: 'Claude Code', kind: 'commands', dir: '.claude/commands', ext: '.md' },
  { tool: 'Cursor', kind: 'commands', dir: '.cursor/commands', ext: '.md' },
  { tool: 'Claude Code', kind: 'skills', dir: '.claude/skills', ext: '.md', nested: true },
  { tool: 'Cursor', kind: 'rules', dir: '.cursor/rules', ext: '.md' },
]);

/** Where hooks hide. Reported, never carried. */
export const HOOK_SOURCES = Object.freeze([
  { tool: 'Claude Code', rel: '.claude/settings.json' },
  { tool: 'Claude Code', rel: '.claude/settings.local.json' },
]);

export const LIMITS = Object.freeze({ maxPerKind: 60, maxBytes: 128 * 1024 });

/**
 * Sweep one project for another tool's assets.
 *
 * @param io  { exists, readFile, listDir } — all injected.
 */
export function collectToolAssets({
  root = '.',
  exists = () => false,
  readFile = () => '',
  listDir = () => [],
  limits = LIMITS,
} = {}) {
  const assets = [];

  for (const source of ASSET_SOURCES) {
    const dir = `${root}/${source.dir}`;
    if (!exists(dir)) continue;

    let names;
    try { names = listDir(dir) ?? []; } catch { continue; }

    /**
     * ⚠️ SKILLS ARE A DIRECTORY PER SKILL, COMMANDS ARE A FILE PER COMMAND.
     * Listing a skills folder and counting `.md` files finds nothing, because
     * the markdown is one level down in `<name>/SKILL.md`. Treating them the
     * same reports "no skills" to somebody with twenty.
     */
    const items = source.nested
      ? names.filter((n) => !String(n).includes('.')).slice(0, limits.maxPerKind)
      : names.filter((n) => String(n).endsWith(source.ext)).slice(0, limits.maxPerKind);

    if (!items.length) continue;
    assets.push({
      tool: source.tool,
      kind: source.kind,
      dir: source.dir,
      count: items.length,
      names: items.map((n) => String(n).replace(/\.md$/, '')),
      truncated: names.length > limits.maxPerKind,
    });
  }

  return assets;
}

/**
 * Find configured hooks. Counted and named by EVENT, never by command.
 *
 * ⚠️ THE COMMAND STRING IS NOT RETURNED. A hook command is arbitrary shell, and
 * a hook config is a place people put paths, tokens and internal hostnames. The
 * count and the event are what a person needs to decide; the body is theirs to
 * open in their own editor.
 */
export function collectHooks({ root = '.', exists = () => false, readFile = () => '' } = {}) {
  const found = [];
  for (const source of HOOK_SOURCES) {
    const path = `${root}/${source.rel}`;
    if (!exists(path)) continue;
    let parsed;
    try {
      parsed = JSON.parse(String(readFile(path)).replace(/^﻿/, ''));
    } catch {
      found.push({ tool: source.tool, path, error: 'not valid JSON' });
      continue;
    }
    const hooks = parsed?.hooks;
    if (!hooks || typeof hooks !== 'object') continue;
    const events = Object.entries(hooks).map(([event, v]) => ({
      event,
      count: Array.isArray(v) ? v.length : 1,
    }));
    if (events.length) found.push({ tool: source.tool, path, events });
  }
  return found;
}

/**
 * Render the sweep.
 *
 * ⚠️ THE RULES STATUS IS PASSED IN, NOT COMPUTED HERE. `readProjectMemory`
 * touches the real disk directly, and importing it would make this whole module
 * untestable without one — the property `mcp-detect.mjs` and `mcp-import.mjs`
 * both hold. The CLI calls it and hands the answer in. Ends by stating what was NOT done, for the same reason
 * `mcp-import.describeImport` does: a reader seeing their own assets listed
 * inside a new tool reasonably assumes it took them.
 */
export function describeSweep({ assets = [], hooks = [], rules = null, mcp = null } = {}) {
  const lines = [];

  if (rules) {
    lines.push(`✓  rules — Acuvo already reads ${rules.file}${rules.truncated ? ' (over the 4KB cap; truncated)' : ''}.`);
  } else {
    lines.push('•  rules — none found. Acuvo reads ACUVO.md, AGENTS.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md.');
  }

  for (const a of assets) {
    lines.push(`•  ${a.kind} — ${a.count}${a.truncated ? '+' : ''} in ${a.dir} (${a.tool}): ${a.names.slice(0, 8).join(', ')}${a.names.length > 8 ? '…' : ''}`);
  }

  if (mcp && mcp.importable) lines.push(`•  mcp — ${mcp.importable} server(s) declared elsewhere. See: acuvo mcp import`);

  for (const h of hooks) {
    if (h.error) { lines.push(`⚠️  hooks — ${h.path}: ${h.error}`); continue; }
    const total = h.events.reduce((n, e) => n + e.count, 0);
    lines.push(`⚠️  hooks — ${total} on ${h.events.map((e) => e.event).join(', ')} in ${h.path}`);
  }

  if (!assets.length && !hooks.length && !rules && !(mcp && mcp.importable)) {
    return 'Nothing from another coding tool was found in this project.';
  }

  lines.push(
    '',
    '⚠️ Nothing was copied, converted or enabled. Commands and skills carry the',
    '   other tool\'s own conventions, so translating them silently would produce',
    '   something that looks imported and behaves differently.',
  );
  if (hooks.length) {
    lines.push(
      '⚠️ Hooks are shell commands the harness runs on an event. They are NOT',
      '   brought across — copying one grants a new tool permission to run',
      '   commands you may have configured months ago and forgotten.',
    );
  }
  return lines.join('\n');
}
