/**
 * ── ⭐ THE PARITY COMMANDS: /init · /review · /compact · /context · /memory ──
 *
 * Read live off code.claude.com/docs/en/commands on 2026-09-28: every rival
 * terminal agent answers these five at the prompt, and this CLI answered
 * *"is not a command"* to all of them. None of them needed a new mechanism —
 * each is an existing module reached from the one place a person sits:
 *
 *   /init     project-memory.mjs (MEMORY_FILES, readProjectMemory) +
 *             project-language.mjs (detectPresets) + repo-map.mjs (rankScripts)
 *   /review   git.mjs (gitStatus, gitDiff) + code-review.mjs (reviewWrittenFiles)
 *   /compact  compact.mjs (compactMessages) — the SAME pass the run loop uses
 *   /context  compact.mjs (estimateMessagesTokens)
 *   /memory   project-memory.mjs (readProjectMemory)
 *
 * ⚠️ `slash.mjs` stays pure. Everything here that touches a disk or git is
 * called by a PROVIDER in `bin/acuvo.mjs` or by the (already async, already
 * impure) chat loop through an `effect`, which is the seam `/doctor` set.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MEMORY_FILES, readProjectMemory, MAX_MEMORY_BYTES } from './project-memory.mjs';
import { describeDetected } from './project-language.mjs';
import { rankScripts, SKIP_DIRS } from './repo-map.mjs';
import { compactMessages, estimateMessagesTokens } from './compact.mjs';
import { gitStatus, gitDiff } from './git.mjs';
import { reviewWrittenFiles, formatReviewSummary } from './code-review.mjs';

/* ── /init ─────────────────────────────────────────────────────────────── */

/** The file /init writes. Ours: first in `MEMORY_FILES`, so it wins precedence. */
export const INIT_FILE = MEMORY_FILES[0];

/** Directories whose NAME says what they hold, so the draft can say it too. */
const DIR_ROLES = Object.freeze({
  src: 'source', lib: 'source', app: 'app routes / source', pages: 'pages', components: 'UI components',
  test: 'tests', tests: 'tests', __tests__: 'tests', spec: 'tests', e2e: 'end-to-end tests',
  bin: 'executables', scripts: 'scripts', docs: 'documentation', public: 'static assets',
  static: 'static assets', migrations: 'database migrations', supabase: 'Supabase config / migrations',
  prisma: 'Prisma schema', packages: 'workspace packages', apps: 'workspace apps', api: 'API',
  cmd: 'Go entry points', internal: 'internal packages', config: 'configuration',
});

/**
 * Draft a project memory file from facts on disk. PURE: the caller supplies
 * the root listing and the parsed package.json.
 *
 * ⭐ IT ONLY WRITES WHAT IT CAN SEE. A draft that invents conventions is a
 * file the model trusts on every request; the placeholders are left as
 * placeholders so the person fills in what only they know.
 *
 * @param {{ rootFiles?: string[], dirs?: string[], pkg?: any, name?: string }} facts
 * @returns {string}
 */
export function draftProjectMemory({ rootFiles = [], dirs = [], pkg = null, name = '' } = {}) {
  const lines = [`# ${INIT_FILE}`, '',
    'Notes for Acuvo Code, drafted by `/init` from what is on disk. Read at the start of every',
    'session and sent with every request — keep it short and correct it where it is wrong.', ''];

  lines.push('## Project');
  const title = String(pkg?.name ?? name ?? '').trim();
  const desc = String(pkg?.description ?? '').trim();
  if (title) lines.push(`- ${title}${desc ? ` — ${desc}` : ''}`);
  const stacks = describeDetected(rootFiles);
  if (stacks) lines.push(`- Stack: ${stacks}`);
  if (pkg && typeof pkg === 'object') {
    if (pkg.type === 'module') lines.push('- ES modules (`"type": "module"`) — use `import`, not `require`.');
    const deps = Object.keys({ ...(pkg.dependencies ?? {}) });
    if (deps.length) lines.push(`- Runtime dependencies: ${deps.slice(0, 12).join(', ')}${deps.length > 12 ? `, +${deps.length - 12} more` : ''}`);
    else if (pkg.dependencies && Object.keys(pkg.dependencies).length === 0) lines.push('- Zero runtime dependencies — do not add one without asking.');
  }
  const known = dirs.filter((d) => DIR_ROLES[d]);
  if (known.length) lines.push(`- Layout: ${known.map((d) => `\`${d}/\` ${DIR_ROLES[d]}`).join(' · ')}`);
  lines.push('');

  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : null;
  const shown = scripts ? rankScripts(Object.keys(scripts)).chosen : [];
  lines.push('## Commands');
  if (shown.length) {
    for (const s of shown) lines.push(`- \`npm run ${s}\` → \`${String(scripts[s]).slice(0, 120)}\``);
  } else if (rootFiles.includes('Makefile')) {
    lines.push('- `make` — see the Makefile targets');
  } else if (rootFiles.includes('pyproject.toml')) {
    lines.push('- (e.g. `pytest` — fill in how to test and run this project)');
  } else {
    lines.push('- (how to build, test and run this project)');
  }
  lines.push('');

  lines.push('## Conventions', '- (the rules a newcomer would get wrong)', '');
  lines.push('## Do not', '- (files or areas the agent must not touch)', '');
  return lines.join('\n');
}

/**
 * `/init` against a real directory.
 *
 * ⚠️ NEVER OVERWRITES. An existing ACUVO.md is someone's work. And when another
 * memory file (CLAUDE.md, AGENTS.md …) is already read, the draft would shadow
 * it — `ACUVO.md` is first in precedence — so that needs `--force`.
 *
 * @param {string} root
 * @param {{ force?: boolean }} [opts]
 * @returns {{ ok: boolean, wrote?: string, lines: string[] }}
 */
export function initProjectMemory(root, { force = false } = {}) {
  const target = join(root, INIT_FILE);
  if (existsSync(target)) {
    return { ok: false, lines: [`${INIT_FILE} already exists — nothing was written. Edit it, or see it with /memory.`] };
  }
  const existing = readProjectMemory(root, { from: root });
  if (existing?.found && !force) {
    return {
      ok: false,
      lines: [
        `this project already has memory: ${existing.dir === '.' ? '' : `${existing.dir}/`}${existing.file} (read every session).`,
        `/init --force writes ${INIT_FILE} anyway — it would take precedence over ${existing.file}.`,
      ],
    };
  }
  let entries = [];
  try { entries = readdirSync(root); } catch (err) {
    return { ok: false, lines: [`the workspace could not be listed: ${String(err?.message ?? err)}`] };
  }
  const dirs = [];
  const rootFiles = [];
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    let isDir = false;
    try { isDir = statSync(join(root, e)).isDirectory(); } catch { continue; }
    (isDir ? dirs : rootFiles).push(e);
  }
  let pkg = null;
  if (rootFiles.includes('package.json')) {
    try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { pkg = null; }
  }
  const text = draftProjectMemory({ rootFiles, dirs, pkg, name: root.split(/[\\/]/).filter(Boolean).pop() });
  try { writeFileSync(target, text, { flag: 'wx' }); } catch (err) {
    return { ok: false, lines: [`${INIT_FILE} could not be written: ${String(err?.message ?? err)}`] };
  }
  const size = Buffer.byteLength(text);
  return {
    ok: true,
    wrote: INIT_FILE,
    lines: [
      `wrote ${INIT_FILE} (${size} bytes, ${text.split('\n').length} lines) — it is read at the start of every session.`,
      ...(size > MAX_MEMORY_BYTES ? [`⚠ over the ${MAX_MEMORY_BYTES}-byte cap; it will be condensed when read.`] : []),
      'fill in Conventions and Do not — those are the lines only you know.',
    ],
  };
}

/* ── /memory ───────────────────────────────────────────────────────────── */

/** @returns {string[]} */
export function describeMemory(root) {
  const m = readProjectMemory(root, { from: root });
  if (!m?.found) {
    return [`no project memory here. Looked for: ${MEMORY_FILES.join(', ')}.`, '/init drafts one from what is on disk.'];
  }
  const where = `${m.dir === '.' ? '' : `${m.dir}/`}${m.file}`;
  const lines = [`${where} — ${m.totalBytes} bytes, sent with every request${m.truncated ? ` (condensed to ${m.keptBytes} bytes: over the ${MAX_MEMORY_BYTES}-byte cap)` : ''}.`, ''];
  const body = String(m.text ?? '').split('\n');
  lines.push(...body.slice(0, 40));
  if (body.length > 40) lines.push(`… ${body.length - 40} more lines — open ${where} to edit.`);
  return lines;
}

/* ── /compact · /context ───────────────────────────────────────────────── */

/**
 * Compact the chat history NOW, on request. The same `compactMessages` pass
 * the run loop applies on its own — stale tool results are stubbed, the
 * conversation's opening (the cached prefix) and the last rounds stay
 * verbatim, and no message is ever removed.
 *
 * ⚠️ A transcript already under the target comes back BYTE-IDENTICAL, and
 * that is reported rather than dressed up as a saving.
 *
 * @param {any[]|null} history
 * @param {{ targetTokens?: number }} [opts]
 */
export function compactHistory(history, { targetTokens = null } = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return { changed: false, messages: history, lines: ['nothing to compact — no conversation yet.'] };
  }
  const before = estimateMessagesTokens(history);
  const target = Number.isFinite(targetTokens) && targetTokens > 0
    ? Math.floor(targetTokens)
    : Math.max(2_000, Math.floor(before / 2));
  const fit = compactMessages(history, { budgetTokens: target, keepLastRounds: 2 });
  const after = estimateMessagesTokens(fit.messages);
  if (!fit.dropped || after >= before) {
    return {
      changed: false,
      messages: history,
      before,
      after: before,
      lines: [`~${before.toLocaleString()} tokens across ${history.length} messages — nothing stale to compact (no old tool output to stub).`,
        '/clear starts cold if you want the context gone.'],
    };
  }
  const idx = fit.report?.firstRewrittenIndex;
  return {
    changed: true,
    messages: fit.messages,
    before,
    after,
    lines: [
      `compacted ~${before.toLocaleString()} → ~${after.toLocaleString()} tokens (${fit.dropped} stale tool result${fit.dropped === 1 ? '' : 's'} stubbed, no message removed).`,
      ...(Number.isInteger(idx) ? [`messages 0–${Math.max(0, idx - 1)} untouched, so the cached prefix up to there still hits.`] : []),
    ],
  };
}

/** @returns {string[]} */
export function describeContext(history, { budgetTokens = null } = {}) {
  if (!Array.isArray(history) || history.length === 0) return ['no conversation yet — the next turn starts cold.'];
  const total = estimateMessagesTokens(history);
  const byRole = {};
  for (const m of history) {
    const role = String(m?.role ?? 'other');
    byRole[role] = (byRole[role] ?? 0) + estimateMessagesTokens([m]);
  }
  const lines = [`~${total.toLocaleString()} tokens of conversation across ${history.length} messages${Number.isFinite(budgetTokens) ? ` (the run compacts past ~${budgetTokens.toLocaleString()})` : ''}.`];
  for (const [role, n] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${role.padEnd(10)} ~${n.toLocaleString()}  ${Math.round((n / Math.max(1, total)) * 100)}%`);
  }
  lines.push('/compact stubs stale tool output; /clear drops it all.');
  return lines;
}

/* ── /review ───────────────────────────────────────────────────────────── */

/** Files under `rel` (workspace-relative, `/`-separated), at most `max`. */
function listFiles(root, rel, max) {
  const out = [];
  const walk = (r) => {
    if (out.length >= max) return;
    let names = [];
    try { names = readdirSync(join(root, r)); } catch { return; }
    for (const n of names.sort()) {
      if (out.length >= max) return;
      if (SKIP_DIRS.has(n)) continue;
      const child = `${r}/${n}`;
      let st;
      try { st = statSync(join(root, child)); } catch { continue; }
      if (st.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk(rel);
  return out;
}

/** The instruction handed to the model with the diff. */
export const REVIEW_INSTRUCTION = 'Review the uncommitted changes below for CORRECTNESS BUGS — logic errors, broken edge cases, '
  + 'wrong API use, missing error handling, security holes, and tests that no longer match. '
  + 'Read any file you need for context. Report findings as `path:line — problem — fix`, most severe first. '
  + 'Do NOT edit any file; this is a review, not a fix. If you find nothing real, say so plainly.';

/**
 * `/review [--local] [path]` against the workspace's git state.
 *
 * ⭐ TWO LAYERS, THE CHEAP ONE FIRST. The pattern reviewer runs locally on
 * every changed file for free; the model then reviews the diff itself. With
 * `--local` only the free layer runs, and nothing is spent.
 *
 * @param {string} root
 * @param {{ args?: string, spawnImpl?: any, read?: (p: string) => string }} [opts]
 * @returns {Promise<{ lines: string[], task?: string }>}
 */
export async function reviewWorkingTree(root, { args = '', spawnImpl, read } = {}) {
  const words = String(args ?? '').trim().split(/\s+/).filter(Boolean);
  const local = words.includes('--local');
  const path = words.find((w) => !w.startsWith('--')) ?? null;

  const status = await gitStatus(root, { spawnImpl });
  if (!status.ok) return { lines: [`/review needs a git repository: ${status.error}`] };
  /**
   * ⚠️ `status --porcelain` COLLAPSES an untracked directory to `src/`. Left
   * as-is, the pattern scan "reads" a directory and the model is told to read
   * one — so it is expanded to its files here (bounded, skip-dirs honoured).
   */
  const expanded = [];
  for (const f of status.files) {
    if (!(f.untracked && f.path.endsWith('/'))) { expanded.push(f); continue; }
    for (const p of listFiles(root, f.path.replace(/\/$/, ''), 50)) expanded.push({ ...f, path: p });
  }
  const under = (p) => !path || p === path || p.startsWith(`${path.replace(/\/$/, '')}/`);
  /** ⚠️ `.acuvo/` is this CLI's own ledger (spend.jsonl, sessions) — never the person's change. */
  const changed = expanded.filter((f) => !/D/.test(f.code) && under(f.path) && !f.path.startsWith('.acuvo/'));
  if (changed.length === 0) return { lines: [path ? `no uncommitted changes under ${path}.` : 'no uncommitted changes — nothing to review.'] };

  const [unstaged, staged] = await Promise.all([
    gitDiff(root, { path, staged: false, spawnImpl }),
    gitDiff(root, { path, staged: true, spawnImpl }),
  ]);
  /**
   * ⚠️ `a/` `b/` PREFIXES STRIPPED. Measured driving the binary 2026-09-28: the
   * end-of-run check read `a/src/index.js` and `b/src/index.js` out of the
   * task as "files the request named that do not exist" and warned about both.
   */
  const diff = [staged.ok ? staged.diff : '', unstaged.ok ? unstaged.diff : ''].filter((d) => d && d.trim()).join('\n')
    .replace(/^diff --git a\/(\S+) b\/(\S+)$/gm, 'diff --git $1 $2')
    .replace(/^(---|\+\+\+) [ab]\//gm, '$1 ');
  const untracked = changed.filter((f) => f.untracked).map((f) => f.path);

  const reader = read ?? ((p) => readFileSync(join(root, p), 'utf8'));
  const pattern = reviewWrittenFiles(changed.map((f) => f.path), { read: reader });
  const lines = [
    `${changed.length} changed file${changed.length === 1 ? '' : 's'}${status.branch ? ` on ${status.branch}` : ''}: ${changed.slice(0, 8).map((f) => f.path).join(', ')}${changed.length > 8 ? ` +${changed.length - 8}` : ''}`,
  ];
  const summary = formatReviewSummary(pattern);
  lines.push(...(summary.length ? summary : [`pattern review: ${pattern.reviewed.length} file${pattern.reviewed.length === 1 ? '' : 's'} scanned, nothing flagged (a short list is not a clean bill of health).`]));
  if (local) return { lines: [...lines, '--local: the model was not asked. /review without it sends the diff for a full review.'] };

  const truncated = (staged.ok && staged.truncated) || (unstaged.ok && unstaged.truncated);
  const task = [
    REVIEW_INSTRUCTION,
    ...(untracked.length ? [`New untracked files (not in the diff — read them): ${untracked.join(', ')}`] : []),
    ...(truncated ? ['The diff was truncated; read the changed files for the rest.'] : []),
    '',
    '```diff',
    diff || '(no tracked changes — only the untracked files above)',
    '```',
  ].join('\n');
  lines.push('sending the diff to the model for a correctness review…');
  return { lines, task };
}
