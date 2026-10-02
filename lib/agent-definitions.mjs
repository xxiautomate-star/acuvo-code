/**
 * ── lib/agent-definitions.mjs — NAMED SPECIALISTS FOR `delegate` ───────────
 *
 * Parity item (2026-09-27). Claude Code lets a project define sub-agents as
 * Markdown files with YAML frontmatter in `.claude/agents/` — a name, a
 * description, the tools it may hold, and a system prompt in the body
 * (code.claude.com/docs/en/sub-agents, read 2026-09-27). Codex and Cursor have
 * no equivalent file format; Claude Code's is the de-facto one.
 *
 * ⭐ WE READ THEIR FILES AS WELL AS OURS. The doctrine is "wrap and integrate":
 * a team that already wrote `.claude/agents/code-reviewer.md` gets that agent
 * in Acuvo with no rewrite. `.acuvo/agents/` wins on a name clash, because a
 * file there is an explicit choice to address US — the same rule
 * `project-memory.mjs` applies to `ACUVO.md` over `CLAUDE.md`.
 *
 *     .acuvo/agents/<name>.md      ours
 *     .claude/agents/<name>.md     Claude Code's, read as-is
 *
 *     ---
 *     name: test-writer
 *     description: Writes focused unit tests for one module
 *     tools: Read, Grep, Glob, Write, Edit
 *     ---
 *     You write small, fast node:test tests. Never touch production code.
 *
 * ── ⚠️⚠️ THE ONE PLACE WE DELIBERATELY DIFFER: TOOLS NARROW, NEVER WIDEN ────
 *
 * In Claude Code an agent with no `tools:` line INHERITS EVERY TOOL. Here an
 * agent with no `tools:` line is a READ-ONLY researcher, and a `tools:` line can
 * only select from what `delegate` already allows a helper to hold
 * (`SUBAGENT_VERIFY_TOOL_NAMES`). A definition file is text in a repository —
 * one `git pull` from a stranger — and a file must never be the thing that
 * hands a helper `git_push`, a shell, or a second level of delegation. So a
 * definition picks its MODE by what it names:
 *
 *     only read verbs            → researcher (reads the real workspace)
 *     any write verb             → builder (isolated copy, applied back)
 *     `run_command` / `Bash`     → verifying builder (runs the project's check)
 *
 * Tools it names that a helper can never hold are REPORTED in `ignoredTools`,
 * not silently dropped — a reviewer who wrote `tools: WebFetch` deserves to be
 * told it did nothing.
 *
 * ⚠️ `model:` IS HONOURED ONLY WHEN IT IS A PROVIDER MODEL ID (`vendor/model`).
 * Claude Code's `sonnet`/`opus`/`haiku` aliases mean nothing to our router, and
 * guessing a mapping would move someone's spend on a word. The run's budget
 * still bounds whatever model a file names.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { SUBAGENT_TOOL_NAMES, SUBAGENT_WRITE_TOOL_NAMES, SUBAGENT_VERIFY_TOOL_NAMES } from './subagent.mjs';

/** Searched in order; the first definition of a name wins. */
export const AGENT_DIRS = Object.freeze(['.acuvo/agents', '.claude/agents']);

/** A body past this is cut, and the cut is announced — it rides every call. */
export const MAX_AGENT_PROMPT_CHARS = 6_000;
export const MAX_AGENTS = 40;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 200;

/**
 * Claude Code's tool names → ours. Only names with a real equivalent a helper
 * may hold appear here; everything else lands in `ignoredTools`.
 */
export const CLAUDE_TOOL_ALIASES = Object.freeze({
  read: ['read_file', 'read_lines', 'read_around'],
  grep: ['search_text'],
  glob: ['find_files', 'list_dir'],
  ls: ['list_dir'],
  lsp: ['find_definition', 'find_references', 'list_symbols'],
  edit: ['edit_file'],
  multiedit: ['edit_file'],
  write: ['write_file', 'write_files'],
  bash: ['run_command'],
});

const WRITE_VERBS = new Set(SUBAGENT_WRITE_TOOL_NAMES.filter((t) => !SUBAGENT_TOOL_NAMES.includes(t)));

function oneLine(raw, max) {
  // eslint-disable-next-line no-control-regex
  const flat = String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** A name a person can type: `Code Reviewer.md` → `code-reviewer`. Never a path. */
export function normalizeAgentName(raw) {
  const cleaned = oneLine(raw, 120).toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return cleaned ? cleaned.slice(0, 64) : null;
}

/**
 * Parse one definition file. `key: value` frontmatter; `tools` may be a
 * comma list or a YAML `- item` list. Unknown keys are ignored.
 *
 * @returns {{ ok: true, meta: Record<string, any>, body: string } | { ok: false, error: string }}
 */
export function parseAgentFile(raw) {
  const text = String(raw ?? '').replace(/^﻿/, '');
  const opens = /^---[ \t]*\r?\n/.exec(text);
  if (!opens) return { ok: true, meta: {}, body: text.trim() };
  const rest = text.slice(opens[0].length);
  const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(rest);
  if (!close) return { ok: false, error: 'the frontmatter opens with --- and never closes' };
  const block = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length).trim();

  /** @type {Record<string, any>} */
  const meta = {};
  let listKey = null;
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item && listKey) {
      meta[listKey].push(item[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    let value = line.slice(at + 1).trim();
    if (value === '') { meta[key] = []; listKey = key; continue; }
    listKey = null;
    if (value.length > 1 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    meta[key] = value;
  }
  return { ok: true, meta, body };
}

/**
 * Map the names a file lists to the verbs a helper may hold, and derive the
 * mode. ⚠️ Pure — this is the security decision, so it is reviewable alone.
 *
 * @param {string|string[]|undefined} listed
 */
export function resolveAgentTools(listed) {
  const raw = Array.isArray(listed)
    ? listed
    : (typeof listed === 'string' ? listed.split(',') : []);
  const names = raw.map((s) => String(s).trim()).filter(Boolean);
  if (names.length === 0) {
    return { mode: 'read', toolNames: [...SUBAGENT_TOOL_NAMES], ignoredTools: [] };
  }
  const allowed = new Set(SUBAGENT_VERIFY_TOOL_NAMES);
  const picked = new Set();
  const ignoredTools = [];
  for (const name of names) {
    // `Bash(npm test:*)` — a Claude Code permission pattern — is its tool.
    const bare = name.replace(/\(.*\)$/, '').trim();
    const alias = CLAUDE_TOOL_ALIASES[bare.toLowerCase()];
    const mapped = alias ?? (allowed.has(bare) ? [bare] : null);
    if (!mapped) { ignoredTools.push(name); continue; }
    for (const m of mapped) if (allowed.has(m)) picked.add(m);
  }
  const hasRun = picked.has('run_command');
  const hasWrite = [...picked].some((t) => WRITE_VERBS.has(t));
  const mode = hasRun ? 'verify' : (hasWrite ? 'write' : 'read');
  /**
   * ⚠️ A RUN VERB WITH NOTHING TO WRITE IS STILL A BUILDER. `run_command`
   * exists for a helper only inside an isolated copy (subagent.mjs — a
   * researcher runs against the REAL workspace and must never execute there),
   * so naming `Bash` alone promotes the agent to a verifying builder rather
   * than handing a researcher a process in the user's repository.
   */
  const ceiling = mode === 'verify' ? SUBAGENT_VERIFY_TOOL_NAMES
    : (mode === 'write' ? SUBAGENT_WRITE_TOOL_NAMES : SUBAGENT_TOOL_NAMES);
  const toolNames = ceiling.filter((t) => picked.has(t));
  // A read verb or two is needed to do anything at all; never hand back an empty offer.
  if (!toolNames.some((t) => SUBAGENT_TOOL_NAMES.includes(t))) toolNames.unshift('read_file', 'search_text', 'find_files');
  return { mode, toolNames: [...new Set(toolNames)], ignoredTools };
}

/**
 * Discover every definition under the workspace (and `~/.acuvo/agents`).
 *
 * @param {{ root: string, home?: string|null, readDirImpl?: Function, readFileImpl?: Function }} opts
 */
export function loadAgentDefinitions({
  root,
  home = homedir(),
  readDirImpl = (p) => readdirSync(p),
  readFileImpl = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const dirs = AGENT_DIRS.map((d) => ({ dir: d, abs: join(String(root ?? ''), d) }));
  if (home) dirs.push({ dir: '~/.acuvo/agents', abs: join(home, '.acuvo', 'agents') });

  const agents = [];
  const problems = [];
  const seen = new Set();
  for (const { dir, abs } of dirs) {
    let entries;
    try { entries = readDirImpl(abs); } catch { continue; }
    for (const file of [...entries].map(String).filter((f) => f.toLowerCase().endsWith('.md')).sort()) {
      if (agents.length >= MAX_AGENTS) { problems.push({ file: `${dir}/${file}`, reason: `more than ${MAX_AGENTS} agents — the rest were not loaded` }); break; }
      let raw;
      try { raw = readFileImpl(join(abs, file)); } catch (err) { problems.push({ file: `${dir}/${file}`, reason: String(err?.message ?? err) }); continue; }
      if (String(raw).length > MAX_FILE_BYTES) { problems.push({ file: `${dir}/${file}`, reason: `larger than ${MAX_FILE_BYTES} bytes` }); continue; }
      const parsed = parseAgentFile(raw);
      if (!parsed.ok) { problems.push({ file: `${dir}/${file}`, reason: parsed.error }); continue; }
      const name = normalizeAgentName(parsed.meta.name || file);
      if (!name) { problems.push({ file: `${dir}/${file}`, reason: 'no usable name' }); continue; }
      if (seen.has(name)) continue; // first directory wins — see the header
      seen.add(name);
      const tools = resolveAgentTools(parsed.meta.tools);
      let prompt = parsed.body;
      const truncated = prompt.length > MAX_AGENT_PROMPT_CHARS;
      if (truncated) prompt = `${prompt.slice(0, MAX_AGENT_PROMPT_CHARS)}\n[the definition was cut at ${MAX_AGENT_PROMPT_CHARS} characters]`;
      const model = typeof parsed.meta.model === 'string' && /^[\w.-]+\/[\w.:-]+$/.test(parsed.meta.model.trim())
        ? parsed.meta.model.trim() : null;
      agents.push({
        name,
        description: oneLine(parsed.meta.description || '', MAX_DESCRIPTION_CHARS),
        file: `${dir}/${file}`,
        prompt,
        truncated,
        model,
        ignoredModel: model === null && typeof parsed.meta.model === 'string' && parsed.meta.model.trim() ? parsed.meta.model.trim() : null,
        ...tools,
      });
    }
  }
  return { agents, problems };
}

/** Find one agent by the name the model (or a person) typed. */
export function findAgent(defs, rawName) {
  const want = normalizeAgentName(rawName);
  return want ? (defs?.agents ?? []).find((a) => a.name === want) ?? null : null;
}

/**
 * The task a named helper is given: its standing instructions first, then the
 * job. ⚠️ Instructions BEFORE the task here (unlike `briefFor`'s context, which
 * goes after): a definition is WHO the helper is, and a system-prompt-shaped
 * text belongs at the head.
 */
export function taskForAgent(agent, task) {
  if (!agent?.prompt) return task;
  return `--- YOU ARE THE "${agent.name}" AGENT. YOUR STANDING INSTRUCTIONS ---\n${agent.prompt}\n--- end of instructions ---\n\n${task}`;
}

/**
 * The block that tells the parent model which specialists exist. Empty when
 * there are none, so a workspace without agents pays zero bytes.
 */
export function agentsPromptBlock(defs) {
  const list = defs?.agents ?? [];
  if (list.length === 0) return '';
  const lines = list.map((a) => `- ${a.name} (${a.mode === 'read' ? 'reads' : (a.mode === 'write' ? 'builds' : 'builds + runs checks')})${a.description ? ` — ${a.description}` : ''}`);
  return `Specialist agents this workspace defines — pass the name as \`agent\` to \`delegate\`:\n${lines.join('\n')}`;
}

/** The `/agents` listing, and `acuvo agents`. */
export function describeAgents(defs) {
  const list = defs?.agents ?? [];
  const out = [];
  if (list.length === 0) {
    out.push('No agents defined. Add one as .acuvo/agents/<name>.md (or keep your .claude/agents/*.md — they are read as-is):');
    out.push('  ---\n  name: test-writer\n  description: Writes focused unit tests\n  tools: Read, Grep, Write\n  ---\n  You write small node:test tests. Never touch production code.');
  }
  for (const a of list) {
    out.push(`${a.name}  [${a.mode}]  ${a.file}`);
    if (a.description) out.push(`    ${a.description}`);
    out.push(`    tools: ${a.toolNames.join(', ')}`);
    if (a.ignoredTools.length) out.push(`    ⚠ ignored (a helper can never hold these): ${a.ignoredTools.join(', ')}`);
    if (a.model) out.push(`    model: ${a.model}`);
    if (a.ignoredModel) out.push(`    ⚠ model "${a.ignoredModel}" ignored — only a provider id like vendor/model is honoured`);
  }
  for (const p of defs?.problems ?? []) out.push(`⚠ ${p.file}: ${p.reason}`);
  return out.join('\n');
}
