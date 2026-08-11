/**
 * ── SEARCH MUST NOT LIE ABOUT WHAT IT LOOKED AT ─────────────────────────────
 *
 * Three defects, one theme: `searchText` returned an answer the model reads as
 * "I looked everywhere and it is not there", when in fact it had declined to
 * open files — and, in the third case, had opened files it must never open.
 *
 *   (a) a 601KB file and a UTF-16 file are skipped, and the reply still says
 *       `matches: [], truncated: false` — three fields that together assert
 *       completeness the function did not achieve.
 *   (b) `**\/*.json` never matched `package.json`, because the `/` in the
 *       expansion was mandatory. The BROADER pattern returned strictly FEWER
 *       results than the narrower `*.json`.
 *   (c) `id_rsa`, `secrets.json` and `config/credentials.yml` were read and
 *       their contents returned straight into the prompt — the same leak
 *       turn.mjs calls "THE WORST BUG THIS PACKAGE HAS HAD", through a second
 *       door nobody closed.
 *
 * The canaries below are fake and only ever exist inside a temp directory this
 * file creates and deletes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { globToRegExp, findFiles, searchText } from '../lib/search.mjs';

/** A throwaway tree. Values may be a string or a Buffer (for the UTF-16 case). */
function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-search-honesty-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** UTF-16LE with a BOM — legitimate text on Windows, full of NUL bytes. */
function utf16(s) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
}

// ── (a) SILENT SKIPS ────────────────────────────────────────────────────────

test('⚠️ a file too big to scan is REPORTED, not silently dropped', () => {
  const root = makeTree({
    'big.js': `const x = 'NEEDLE';\n${'// filler\n'.repeat(70_000)}`, // ~630KB
    'small.js': 'nothing interesting here\n',
  });
  try {
    const r = searchText(root, 'NEEDLE');
    assert.equal(r.ok, true);
    assert.deepEqual(r.matches, [], 'the oversized file genuinely cannot be scanned');
    // THE POINT: the caller must be able to tell "not there" from "not opened".
    assert.equal(r.skippedCount, 1, 'exactly one file was not looked at');
    assert.ok(Array.isArray(r.skipped), 'skipped must be an array the model can read');
    const entry = r.skipped.find((s) => s.path === 'big.js');
    assert.ok(entry, `big.js must appear in skipped, got ${JSON.stringify(r.skipped)}`);
    assert.match(entry.reason, /512KB|too large|size/i, `reason must say why: ${entry.reason}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️ a UTF-16 file skipped as binary is REPORTED, not silently dropped', () => {
  const root = makeTree({
    'u16.txt': utf16('NEEDLE here\n'),
    'plain.txt': 'ordinary text\n',
  });
  try {
    const r = searchText(root, 'NEEDLE');
    assert.equal(r.ok, true);
    assert.deepEqual(r.matches, []);
    assert.equal(r.skippedCount, 1);
    const entry = r.skipped.find((s) => s.path === 'u16.txt');
    assert.ok(entry, `u16.txt must appear in skipped, got ${JSON.stringify(r.skipped)}`);
    assert.match(entry.reason, /binary|NUL/i, `reason must say why: ${entry.reason}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clean search still reports zero skips — the field is not noise', () => {
  const root = makeTree({ 'a.js': 'const NEEDLE = 1;\n', 'b.js': 'nope\n' });
  try {
    const r = searchText(root, 'NEEDLE');
    assert.equal(r.matches.length, 1);
    assert.equal(r.skippedCount, 0);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.withheld, 0);
    assert.equal(r.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (b) `**/` MUST MATCH ZERO DIRECTORIES ───────────────────────────────────

test('⚠️ `**/` matches ZERO segments — the broader glob cannot return fewer files', () => {
  // Bash globstar, minimatch and ripgrep all agree: `**/*.json` includes the
  // top level. Ours required a slash, so it excluded exactly the file people
  // reach for this pattern to find.
  assert.ok(globToRegExp('**/*.json').test('package.json'), '**/*.json must match package.json');
  assert.ok(globToRegExp('**/*.json').test('src/a.json'));
  assert.ok(globToRegExp('**/*.json').test('src/deep/nested/b.json'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a.ts'), 'src/**/*.ts must match src/a.ts');
});

test('⚠️ findFiles: `**/*.json` returns AT LEAST what `*.json` returns', () => {
  const root = makeTree({
    'package.json': '{}',
    'src/a.json': '{}',
    'src/deep/b.json': '{}',
    'src/ignore.ts': '',
  });
  try {
    const broad = findFiles(root, '**/*.json');
    const narrow = findFiles(root, '*.json');
    assert.equal(broad.ok, true);
    assert.ok(broad.files.includes('package.json'), `missing package.json: ${JSON.stringify(broad.files)}`);
    assert.ok(broad.files.includes('src/a.json'));
    assert.ok(broad.files.includes('src/deep/b.json'));
    for (const f of narrow.files) {
      assert.ok(broad.files.includes(f), `the broader pattern dropped ${f} — that is backwards`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the globstar fix does not widen a single-star glob', () => {
  // Regression guard: `*` must still refuse to cross a slash.
  assert.ok(!globToRegExp('*.ts').test('src/a.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'));
  assert.ok(globToRegExp('a+b.ts').test('a+b.ts'), 'a regex metacharacter stays literal');
  assert.ok(globToRegExp('a?c.ts').test('abc.ts'));
  assert.ok(!globToRegExp('a?c.ts').test('a/c.ts'), '? must not cross a slash');
});

// ── (c) CREDENTIALS MUST NEVER REACH THE PROMPT ─────────────────────────────

test('⚠️⚠️ search_text NEVER returns the contents of a credential file', () => {
  const root = makeTree({
    'id_rsa': '-----BEGIN OPENSSH PRIVATE KEY-----\nCANARYKEY\n',
    'secrets.json': '{"aws_secret":"CANARYAWS"}\n',
    'config/credentials.yml': 'password: CANARYYML\n',
    'server.key': 'CANARYPEM\n',
    'src/app.js': '// CANARYOK — an ordinary source line\n',
  });
  try {
    const r = searchText(root, 'CANARY');
    assert.equal(r.ok, true);

    const blob = JSON.stringify(r);
    for (const secret of ['CANARYKEY', 'CANARYAWS', 'CANARYYML', 'CANARYPEM']) {
      assert.ok(!blob.includes(secret), `${secret} leaked into the search result: ${blob.slice(0, 400)}`);
    }

    // The ordinary file is still searched — the guard must not blind the tool.
    assert.ok(r.matches.some((m) => m.path === 'src/app.js'), 'a normal file must still match');

    // ⭐ And per (a): the withholding is COUNTED, never silent.
    assert.equal(r.withheld, 4, `four credential files were withheld, got ${r.withheld}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a glob-narrowed search cannot be used to aim at a credential file', () => {
  const root = makeTree({ 'secrets.json': '{"aws_secret":"CANARYAWS"}\n', 'ok.json': '{"a":1}\n' });
  try {
    const r = searchText(root, '.', { glob: '*.json' });
    assert.ok(!JSON.stringify(r).includes('CANARYAWS'), 'the glob path must be guarded too');
    assert.equal(r.withheld, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
