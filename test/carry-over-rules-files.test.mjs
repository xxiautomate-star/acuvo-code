/**
 * ── ⭐⭐⭐ THE CHEAPEST MIGRATION SURFACE WE HAVE ─────────────────────────────
 *
 * `project-memory.mjs` opens by arguing that accumulated project context is what
 * a wrapper can own — *"Claude Code has CLAUDE.md and it is a real part of why
 * people stay"* — and its `MEMORY_FILES` list then read `ACUVO.md`, `.acuvo.md`,
 * `CONVENTIONS.md` and `AGENTS.md`. Not `CLAUDE.md`. Not `.cursorrules`.
 *
 * ⚠️ AND WE ALREADY KNEW EVERY FORMAT. `skills/context-engineering.md` in this
 * same package lists `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.md` and
 * `AGENTS.md` under "Rules Files — always loaded, project-wide". We documented
 * the ecosystem and ingested one file from it.
 *
 * ⭐ WHY IT MATTERS MORE THAN ITS SIZE. Someone arriving because they hit a
 * weekly limit somewhere else has ALREADY written their project's brain down.
 * Making them rewrite it into `ACUVO.md` first is an entry fee charged at the
 * exact moment they are annoyed with a competitor. This file pins that we read
 * what they already have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectMemory, memoryPromptBlock, MEMORY_FILES, MAX_MEMORY_BYTES } from '../lib/project-memory.mjs';

/** A throwaway repo root with the given files written into it. */
function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-carryover-'));
  for (const [name, body] of Object.entries(files)) {
    const abs = join(root, name);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

test('a Claude Code project is understood on the first run', () => {
  const root = repoWith({ 'CLAUDE.md': '# Rules\nAlways use tabs.' });
  try {
    const m = readProjectMemory(root);
    assert.equal(m.found, true, 'a repo with a CLAUDE.md read as having no project notes');
    assert.equal(m.file, 'CLAUDE.md');
    assert.match(m.text, /Always use tabs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a Cursor project is understood on the first run', () => {
  const root = repoWith({ '.cursorrules': 'Prefer function components.' });
  try {
    const m = readProjectMemory(root);
    assert.equal(m.found, true);
    assert.equal(m.file, '.cursorrules');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a Copilot project is understood on the first run', () => {
  const root = repoWith({ '.github/copilot-instructions.md': 'Use pytest, never unittest.' });
  try {
    const m = readProjectMemory(root);
    assert.equal(m.found, true);
    assert.equal(m.file, '.github/copilot-instructions.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * ⚠️ ORDER IS PRECEDENCE, NOT DECORATION. `readProjectMemory` returns the FIRST
 * hit rather than the union, so the array's order is the whole policy. A repo
 * carrying both files is one where somebody deliberately wrote OURS.
 */
test('ours wins when a repo has both, and the neutral standard beats the vendor file', () => {
  const both = repoWith({ 'ACUVO.md': 'ours', 'CLAUDE.md': 'theirs' });
  try {
    assert.equal(readProjectMemory(both).file, 'ACUVO.md');
  } finally { rmSync(both, { recursive: true, force: true }); }

  const neutral = repoWith({ 'AGENTS.md': 'neutral', 'CLAUDE.md': 'vendor' });
  try {
    assert.equal(readProjectMemory(neutral).file, 'AGENTS.md');
  } finally { rmSync(neutral, { recursive: true, force: true }); }
});

/**
 * ⭐ THE USER MUST BE ABLE TO SEE WHICH FILE WE OBEYED. Silently honouring a
 * `CLAUDE.md` would be pleasant right up to the moment its rules are wrong and
 * nobody can work out where the agent's opinions came from.
 */
test('the prompt block names the file the rules actually came from', () => {
  const root = repoWith({ 'CLAUDE.md': 'Always use tabs.' });
  try {
    const block = memoryPromptBlock(readProjectMemory(root));
    assert.match(block, /from CLAUDE\.md/);
    assert.match(block, /do not change what you are allowed to run/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * ⚠️⚠️ NO NEW INJECTION BUDGET. A borrowed rules file is the same
 * attacker-controlled surface the module docstring already describes, so it must
 * inherit the same cap — not a friendlier one because it came from a competitor.
 * A real CLAUDE.md is routinely far larger than 4KB (this repo's own is), so
 * this is the common case, not an edge one.
 */
test('a borrowed rules file is capped and the truncation is announced', () => {
  const root = repoWith({ 'CLAUDE.md': 'x'.repeat(MAX_MEMORY_BYTES * 3) });
  try {
    const m = readProjectMemory(root);
    assert.equal(m.truncated, true, 'an oversized CLAUDE.md was not truncated');
    assert.match(m.text, /truncated at \d+ bytes/);
    assert.ok(
      Buffer.byteLength(m.text, 'utf8') < MAX_MEMORY_BYTES * 1.1,
      'the borrowed file was allowed past the cap that governs our own',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * ⚠️ NON-VACUITY. Every test above would still pass if `MEMORY_FILES` grew a
 * duplicate or lost `ACUVO.md`, so the list itself is pinned: ours first, the
 * neutral standard next, the vendor files after, and nothing named twice.
 */
test('the list itself is ordered ours-first and has no duplicates', () => {
  assert.equal(MEMORY_FILES[0], 'ACUVO.md');
  assert.ok(MEMORY_FILES.indexOf('AGENTS.md') < MEMORY_FILES.indexOf('CLAUDE.md'));
  assert.equal(new Set(MEMORY_FILES).size, MEMORY_FILES.length);
  for (const f of ['CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md']) {
    assert.ok(MEMORY_FILES.includes(f), `${f} is no longer read — a migration path went silent`);
  }
});
