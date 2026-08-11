/**
 * ── ⚠️⚠️ A SEARCH THAT CLAIMS COMPLETENESS IT DOES NOT HAVE ─────────────────
 *
 * `search_text` and `find_files` walk the same tree through the same `walk()`
 * and share the same 4,000-file cap. When that cap bites, the answer covers a
 * fraction of the repo.
 *
 * `searchText` KNOWS THIS and says so — lib/search.mjs:286-292 documents the
 * exact bug and fixes it with `scanCapped`. **`findFiles` was never given the
 * same fix**, and computes `truncated: hits.length >= MAX_MATCHES` — the match
 * cap only. So a walk cut short after 4,000 of 12,000 files, finding 3 matches,
 * answers `truncated: false`: a complete-looking answer over a third of the
 * tree, printed directly beneath a comment reading "TRUNCATION IS REPORTED,
 * NEVER SILENT".
 *
 * ⭐ WHY THIS IS THE WORST CLASS OF DEFECT. A model told "12 files" stops
 * looking. A model told "the first 60 of many" keeps looking. The whole value of
 * the flag is that it changes behaviour, so getting it wrong does not degrade
 * the answer — it ends the search.
 *
 * ── ⚠️ AND THE SECOND LIE: HIDDEN DIRECTORIES ───────────────────────────────
 * `walk()` skips every entry starting with `.` and records nothing. Refusing
 * `.env` is right and load-bearing. But `.github`, `.vscode`, `.husky` and
 * `.circleci` are ordinary source, and today they are invisible to BOTH tools
 * AND absent from `skipped` — so "fix the CI workflow" is unanswerable, and the
 * reply is the exact matches:[] / truncated:false / skippedCount:0 triple the
 * module says means "it is not there".
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findFiles, searchText, MAX_FILES_SCANNED } from '../lib/search.mjs';

/** A tree big enough to blow the walk budget, with the needle at the far end. */
function oversizedTree() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-search-cap-'));
  // `walk` sorts entries, so `zz-last` is reached only after everything else.
  const perDir = 200;
  const dirs = Math.ceil((MAX_FILES_SCANNED * 1.5) / perDir);
  for (let d = 0; d < dirs; d += 1) {
    const dir = join(root, `pkg-${String(d).padStart(3, '0')}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < perDir; f += 1) {
      writeFileSync(join(dir, `mod-${f}.js`), 'export const x = 1;\n');
    }
  }
  const late = join(root, 'zz-last');
  mkdirSync(late, { recursive: true });
  writeFileSync(join(late, 'NEEDLE.config.js'), 'export const needleMarker = true;\n');
  return root;
}

test('⚠️⚠️ find_files must not report truncated:false when the WALK was cut short', () => {
  const root = oversizedTree();
  try {
    const r = findFiles(root, '**/*.config.js');
    assert.equal(r.ok, true);
    assert.ok(
      r.scanned >= MAX_FILES_SCANNED,
      `this fixture must actually hit the walk cap to be meaningful — scanned ${r.scanned}`,
    );
    assert.ok(
      r.files.length < 60,
      'the fixture is built so the MATCH cap is NOT what stops it; otherwise the test proves nothing',
    );

    // ⭐ THE ASSERTION. The walk stopped early, so "there may be more" is the
    // only honest answer, exactly as searchText already reports.
    assert.equal(
      r.truncated,
      true,
      'find_files answered truncated:false after a walk that stopped at the file cap — a claim of completeness over a fraction of the tree',
    );
    assert.equal(r.scanCapped, true, 'find_files must say WHICH cap bit, the same way searchText does');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('search_text already reports a capped walk, and must keep doing so', () => {
  const root = oversizedTree();
  try {
    const r = searchText(root, 'needleMarker');
    assert.equal(r.ok, true);
    assert.equal(r.scanCapped, true, 'the fixture must hit the cap for this to mean anything');
    assert.equal(r.truncated, true, 'searchText regressed — a capped walk is a truncation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ⚠️ The honesty half of the hidden-directory problem. Whether we WALK
 * `.github` is a product decision; whether we tell the truth about not walking
 * it is not. A model that is told a directory was skipped can ask for it
 * explicitly. A model told nothing concludes the file does not exist.
 */
test('⚠️ a hidden directory that is not searched must be REPORTED as skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-search-hidden-'));
  try {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n');
    writeFileSync(join(root, 'index.js'), 'export const hi = 1;\n');

    const r = searchText(root, 'runs-on');
    assert.equal(r.ok, true);

    const reported = r.matches.length > 0
      || (r.skippedCount ?? 0) > 0
      || (r.skipped ?? []).some((s) => String(s.path).includes('.github'));

    assert.ok(
      reported,
      'searching for CI config returned matches:[] with skippedCount:0 — the triple this module says means "not there", '
      + 'for a file that plainly is there. Either walk it or name it in `skipped`, but never answer "absent".',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ⚠️⚠️ THE GUARD THAT MUST SURVIVE ANY FIX. Refusing to surface `.env` into a
 * model's context is deliberate and load-bearing — search.mjs calls it "an
 * exfiltration channel with good intentions". Making hidden entries visible must
 * never make CREDENTIALS visible.
 */
test('a fix for hidden directories must NOT surface .env contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-search-env-'));
  try {
    writeFileSync(join(root, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-REALLOOKINGSECRET\n');
    writeFileSync(join(root, 'index.js'), 'export const hi = 1;\n');

    const r = searchText(root, 'sk-or-v1');
    assert.equal(r.ok, true);
    const leaked = JSON.stringify(r).includes('REALLOOKINGSECRET');
    assert.equal(leaked, false, 'the secret in .env was returned into the model context');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
