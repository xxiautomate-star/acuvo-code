/**
 * ── ⚠️⚠️⭐ THE DOCTRINE FILE WAS CUT AT A BYTE OFFSET AND LOST THE RULE ──────
 *
 * MEASURED 2026-09-21, from a real run of this CLI at a monorepo root:
 *
 *     · reading CLAUDE.md (truncated)
 *
 * 4,000 bytes of a 53KB file survived — the introduction — and the line saying
 * the folder the agent had just been asked to analyse had been **DEAD since
 * July** did not. The run then spent 24 rounds, 1.38M tokens and $0.025 on it,
 * and produced no report.
 *
 * Three things are pinned here, and each of them failed in that run:
 *
 *   1. the line that carries a RULE survives, even at the very end of the file;
 *   2. the NEAREST notes file wins, so `console/CLAUDE.md` beats a 53KB root
 *      one — and the walk never leaves the workspace;
 *   3. the terminal line says WHAT was dropped and HOW MUCH, because the bare
 *      word "(truncated)" reads as a rounding rather than as a loss.
 *
 * ── ⚠️ MUTATION-PROVEN (each restored afterwards, `git diff` clean) ─────────
 *   M1  `SPREAD_BUCKETS` forced to 1 — i.e. the forward scan this replaced —
 *       → "a rule at the END of a long file survives" RED: the allowance is
 *         spent in §1 and the last section is never reached.
 *   M2  `memoryDirs` reduced to `[resolve(root)]` — i.e. the old root-only read
 *       → "the NEAREST notes file wins" RED.
 *   M3  `STRUCTURE_SHARE` forced to 0 → "every heading survives" RED.
 *
 * ── ⚠️⚠️ AND WHAT THIS DOES **NOT** FIX, SAID PLAINLY ───────────────────────
 *
 * Re-run against this repo's own root `CLAUDE.md` (55,087 bytes) at the 4,000
 * byte cap: **3,655 bytes, 57 of 765 lines, all 15 headings — and the NAME
 * REUSE line is still dropped.** 7% of a document cannot hold whichever
 * sentence happens to matter today, and no selection rule changes that. The
 * cure for the measured run is the SCOPED file (`acuvo-code/CLAUDE.md`,
 * `console/CLAUDE.md`), which is why the nearest-wins walk is half of this
 * change rather than a nicety.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  readProjectMemory, condenseMemory, memoryDirs, isLoadBearing,
  memoryPromptBlock, MAX_MEMORY_BYTES,
} from '../lib/project-memory.mjs';
import { renderEvent } from '../lib/turn.mjs';

/** The sentence the real run lost. It sits at the very bottom of the file. */
const THE_LOST_RULE = '⚠️ **NAME REUSE:** the `acuvo/` FOLDER is the DEAD data-solver — killed 2026-07-03.';

/**
 * A doctrine file shaped like the real one: a short introduction, a long body
 * whose EARLY sections are dense with marked lines (this is what exhausts a
 * forward scan), and the rule that matters in the last section.
 */
function doctrineFile() {
  const out = ['# ACUVO', '', '> Acuvo is the company. Everything else funds it.', ''];
  out.push('## 1. WHAT ACUVO IS', '');
  for (let i = 0; i < 200; i += 1) {
    out.push(`⚠️ early warning ${i} about something that is not the thing you need.`);
    out.push(`Ordinary prose line ${i} that explains the warning above in a relaxed way.`);
  }
  out.push('', '## 4. HOW THINGS ARE BUILT', '');
  for (let i = 0; i < 200; i += 1) {
    out.push(`Ordinary prose line ${i} in the middle of the document, carrying no rule at all.`);
  }
  out.push('', '## 8. THE OTHER CODEBASES', '');
  out.push('- **Revenue OS** — the cash engine, and it is not the headline here.');
  out.push(`- ${THE_LOST_RULE}`);
  return out.join('\n');
}

function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-notes-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

test('⭐⭐⭐ THE MEASURED DEFECT: a rule at the END of a long file survives the cut', () => {
  const raw = doctrineFile();
  assert.ok(Buffer.byteLength(raw, 'utf8') > 40_000, 'the fixture must be big enough to be cut');

  const cut = condenseMemory(raw, MAX_MEMORY_BYTES);
  assert.equal(cut.condensed, true);
  assert.ok(
    cut.text.includes(THE_LOST_RULE),
    'the rule in the LAST section was dropped — the allowance was spent on the first section again',
  );
  // And the head still opens the way the author wrote it.
  assert.ok(cut.text.startsWith('# ACUVO'), 'the file no longer opens as its author wrote it');
});

/**
 * ⭐⭐ THE TABLE OF CONTENTS IS KEPT WHOLE, AND IT IS THE PART THAT SURVIVES
 * A FILE TOO BIG FOR ANY SELECTION RULE.
 *
 * ⚠️ MEASURED HONESTLY on this repo's own 55KB root file at the 4KB cap: the
 * body line the real run needed is STILL dropped — 7% of a document cannot
 * hold the one sentence that happens to matter. What the structure pass does
 * guarantee is that the model can see the section exists and open the file;
 * a cut that hides WHAT it cut is the one that sends a run down a dead path.
 *
 * M3  `STRUCTURE_SHARE` forced to 0 → RED: "the heading ## 2. MIDDLE was dropped".
 */
test('⭐⭐ every heading survives, including the LAST section of a long file', () => {
  const raw = [
    '# DOCTRINE', '',
    ...Array.from({ length: 300 }, (_, i) => `⚠️ a long marked rule number ${i} that is wordy enough to eat the whole selection allowance on its own section.`),
    '## 2. MIDDLE', '',
    ...Array.from({ length: 300 }, (_, i) => `⚠️ another long marked rule ${i} that is wordy enough to eat the whole selection allowance on its own section.`),
    '## 3. THE LAST SECTION', '',
    '- the closing note nobody ever reads.',
  ].join('\n');
  const cut = condenseMemory(raw, MAX_MEMORY_BYTES);
  for (const h of ['# DOCTRINE', '## 2. MIDDLE', '## 3. THE LAST SECTION']) {
    assert.ok(cut.text.includes(h), `the heading "${h}" was dropped — the reader cannot tell what was cut`);
  }
});

test('⚠️ the cut stays under the cap, and prose without a rule in it is what goes', () => {
  const cut = condenseMemory(doctrineFile(), MAX_MEMORY_BYTES);
  assert.ok(
    Buffer.byteLength(cut.text, 'utf8') <= MAX_MEMORY_BYTES,
    `the condensed text is ${Buffer.byteLength(cut.text, 'utf8')} bytes, over the ${MAX_MEMORY_BYTES} cap`,
  );
  assert.ok(
    !cut.text.includes('Ordinary prose line 150 in the middle'),
    'unmarked middle prose survived, so nothing was actually selected',
  );
  assert.ok(cut.keptLines < cut.totalLines, 'it claims to have kept every line of a file it cut');
});

test('⚠️ the notice still says "truncated at N bytes" AND now says how much survived', () => {
  const cut = condenseMemory(doctrineFile(), MAX_MEMORY_BYTES);
  assert.match(cut.text, /truncated at \d+ bytes/, 'the announcement contract was broken');
  assert.match(cut.text, /\d+ of \d+ lines kept/);
  assert.match(cut.text, /\d+ of \d+ bytes/);
});

test('a file that fits is returned byte-for-byte, and says so', () => {
  const small = '# Notes\n- ES modules only\n';
  const cut = condenseMemory(small, MAX_MEMORY_BYTES);
  assert.equal(cut.condensed, false);
  assert.equal(cut.text, small);
  assert.equal(cut.keptLines, cut.totalLines);
});

test('⚠️ one enormous line has no structure to keep, so it falls back to the plain cut', () => {
  const cut = condenseMemory('x'.repeat(MAX_MEMORY_BYTES * 3), MAX_MEMORY_BYTES);
  assert.equal(cut.condensed, true);
  assert.match(cut.text, /truncated at \d+ bytes/);
  assert.ok(Buffer.byteLength(cut.text, 'utf8') <= MAX_MEMORY_BYTES);
});

test('⭐⭐ the NEAREST notes file wins — a scoped CLAUDE.md beats a root ACUVO.md', () => {
  const root = repoWith({
    'ACUVO.md': `# root\n${'the whole monorepo, at length. '.repeat(400)}`,
    'console/CLAUDE.md': '# console\n- Next 14, not 16.\n',
  });
  try {
    const near = readProjectMemory(root, { from: join(root, 'console') });
    assert.equal(near.file, 'CLAUDE.md');
    assert.equal(near.dir, 'console');
    assert.match(near.text, /Next 14, not 16/);
    // And the block NAMES the path, so a repo with three CLAUDE.mds is readable.
    assert.match(memoryPromptBlock(near), /console\/CLAUDE\.md/);

    // From the root itself, the root file is still the one.
    assert.equal(readProjectMemory(root, { from: root }).file, 'ACUVO.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ the walk never leaves the workspace', () => {
  const root = repoWith({ 'ACUVO.md': '# root\n' });
  try {
    const dirs = memoryDirs(root, join(root, 'a', 'b'));
    assert.equal(dirs[dirs.length - 1], resolve(root), 'the walk did not stop at the root');
    // A `from` outside the workspace considers the root and nothing else.
    assert.deepEqual(memoryDirs(root, tmpdir()), [resolve(root)]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ "NEVER" is a rule and "never" is a sentence — the marker must not fire on everything', () => {
  assert.equal(isLoadBearing('## A heading'), true);
  assert.equal(isLoadBearing('⚠️ do this carefully'), true);
  assert.equal(isLoadBearing('NEVER push to main'), true);
  assert.equal(isLoadBearing('we never really decided that, and it was fine'), false);
  assert.equal(isLoadBearing('just some ordinary prose about the project'), false);
  assert.equal(isLoadBearing(''), false);
});

test('⭐ the terminal line stops saying the bare word "(truncated)" and names the loss', () => {
  const line = renderEvent({
    type: 'memory',
    file: 'CLAUDE.md',
    dir: '.',
    truncated: true,
    keptLines: 61,
    totalLines: 1204,
    keptBytes: 3900,
    totalBytes: 53_000,
  }).join('\n');
  assert.ok(!/\(truncated\)/.test(line), 'the bare "(truncated)" is back — it says nothing about the loss');
  assert.match(line, /61 of 1204 lines/);
  assert.match(line, /51\.8KB/);
  assert.match(line, /7%/);

  // An untruncated read stays the one quiet line it always was.
  const whole = renderEvent({ type: 'memory', file: 'ACUVO.md', dir: '.', truncated: false }).join('\n');
  assert.match(whole, /reading ACUVO\.md/);
  assert.ok(!/kept/.test(whole));
});
