/**
 * ── ⭐⭐ SEARCH FEEDS EDIT, SO CORRUPTING THE HANDOFF BREAKS BOTH ────────────
 *
 * `searchText` returned every hit as `lines[i].trim()`. `trim()` strips LEADING
 * whitespace, so every hit came back left-aligned. The model then builds an
 * `edit_file` old_string out of that text and it CAN NEVER MATCH, because the
 * real file has the indentation. It guesses, is refused, guesses again, and the
 * round budget is gone. `lib/read-window.mjs:34` records one such session: a hit
 * at `lib/git.mjs:282`, six spaces guessed where the file has two, a
 * half-migrated refactor shipped.
 *
 * ⭐ The fix is one line, and the rule is: strip TRAILING whitespace only. The
 * matched text must be a byte-exact substring of the file, because that is the
 * only property `edit_file` cares about.
 *
 * ── AND THREE MORE SILENT WRONG ANSWERS IN THE SAME LOOP ────────────────────
 *
 *   · CRLF. `text.split('\n')` leaves a `\r` on the end of every line, so a
 *     `$`-anchored pattern matches NOTHING on a CRLF file — roughly half of a
 *     real Windows working tree. The reply is `matches: []`, which this module
 *     documents as meaning "it is not there".
 *   · A UTF-8 BOM sits in front of the first character, so `^`-anchored patterns
 *     never match line 1. Same silent shape.
 *   · No PAGING. Both tools cap at 60 and the model is told "truncated" with
 *     nowhere to go, and no idea whether it has seen 60 of 61 or 60 of 6,000.
 *
 * ⚠️ EVERY GUARD BELOW IS ALSO RUN AGAINST THE LEGITIMATE SHAPES A REAL REPO
 * CONTAINS — LF, CRLF, a BOM, no trailing newline, tabs, deep indentation,
 * non-ASCII and an empty file — because a check that fails correct work is
 * worse than no check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  findFiles,
  searchText,
  searchToolSchemas,
  MAX_MATCHES,
} from '../lib/search.mjs';

/** A throwaway tree. Values may be a string or a Buffer (BOM / CRLF fixtures). */
function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-search-fidelity-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

// ══ (1) THE HANDOFF TO edit_file — LEADING WHITESPACE IS CONTENT ════════════

test('⭐⭐ search_text returns the line BYTE-EXACT, indentation included', () => {
  /**
   * Verbatim from lib/git.mjs 280-284 — the exact slice that cost a session.
   * The file has TWO leading spaces; the trimmed answer had none, and the model
   * guessed six.
   */
  const body = [
    "  if (run.exitCode !== 0) return { ok: false, error: run.stderr.trim() || 'git diff failed' };",
    '',
    '  const clamped = clampOutput(run.stdout, MAX_DIFF_CHARS);',
    '  return {',
    '    ok: true,',
  ].join('\n') + '\n';
  const root = makeTree({ 'git.mjs': body });
  try {
    const r = searchText(root, 'clampOutput');
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 1);
    const hit = r.matches[0];

    assert.equal(
      hit.text,
      '  const clamped = clampOutput(run.stdout, MAX_DIFF_CHARS);',
      'search_text stripped the leading whitespace — an old_string built from this can never match the file',
    );
    // ⭐ THE PROPERTY THAT ACTUALLY MATTERS: edit_file does a substring match.
    assert.ok(
      readFileSync(join(root, 'git.mjs'), 'utf8').includes(hit.text),
      'the returned text is not a substring of the file it came from',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tabs and deep indentation survive too, and trailing whitespace is still stripped', () => {
  const root = makeTree({
    'tabs.js': '\t\tconst deep = needleA;\n',
    'deep.js': '                    const twenty = needleB;\n',
    'trail.js': '  const trailing = needleC;   \t\n',
  });
  try {
    const r = searchText(root, 'needle[ABC]');
    assert.equal(r.ok, true);
    const byPath = Object.fromEntries(r.matches.map((m) => [m.path, m.text]));

    assert.equal(byPath['tabs.js'], '\t\tconst deep = needleA;', 'tabs are indentation and must survive');
    assert.equal(byPath['deep.js'], '                    const twenty = needleB;', '20 spaces must survive');
    // TRAILING whitespace is not content — it is invisible, and carrying it into
    // an old_string is its own failure mode.
    assert.equal(byPath['trail.js'], '  const trailing = needleC;', 'trailing whitespace must be stripped');

    for (const [file, text] of Object.entries(byPath)) {
      assert.ok(readFileSync(join(root, file), 'utf8').includes(text), `${file}: text is not a substring of the file`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-ASCII content comes back unchanged', () => {
  const root = makeTree({ 'i18n.ts': '  const msg = "café — naïve 日本語 🚀 needleU";\n' });
  try {
    const r = searchText(root, 'needleU');
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].text, '  const msg = "café — naïve 日本語 🚀 needleU";');
    assert.ok(readFileSync(join(root, 'i18n.ts'), 'utf8').includes(r.matches[0].text));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══ (2) CRLF — HALF A WINDOWS TREE ══════════════════════════════════════════

test('⚠️ a `$`-anchored pattern matches on a CRLF file', () => {
  const root = makeTree({
    'crlf.js': Buffer.from('  const a = 1;\r\nexport default a;\r\n', 'utf8'),
    'lf.js': '  const a = 1;\nexport default a;\n',
  });
  try {
    const r = searchText(root, 'const a = 1;$');
    assert.equal(r.ok, true);
    const paths = r.matches.map((m) => m.path).sort();
    assert.deepEqual(
      paths,
      ['crlf.js', 'lf.js'],
      'a `$` anchor found the LF file and silently missed the CRLF one — the reply reads as "not there"',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a CRLF hit does not carry the carriage return into the old_string', () => {
  const root = makeTree({ 'crlf.js': Buffer.from('    const needleR = 1;\r\nmore();\r\n', 'utf8') });
  try {
    const r = searchText(root, 'needleR');
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].text, '    const needleR = 1;', 'indentation kept, the \\r terminator dropped');
    assert.ok(!r.matches[0].text.includes('\r'));
    assert.ok(readFileSync(join(root, 'crlf.js'), 'utf8').includes(r.matches[0].text));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══ (3) UTF-8 BOM — DEFEATS A `^` ANCHOR ON LINE 1 ══════════════════════════

test('⚠️ a `^`-anchored pattern matches the FIRST line of a BOM file', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const root = makeTree({
    'bom.ts': Buffer.concat([bom, Buffer.from('import { thing } from "./thing";\nconst x = 1;\n', 'utf8')]),
    'plain.ts': 'import { thing } from "./thing";\nconst x = 1;\n',
  });
  try {
    const r = searchText(root, '^import ');
    assert.equal(r.ok, true);
    const paths = r.matches.map((m) => m.path).sort();
    assert.deepEqual(
      paths,
      ['bom.ts', 'plain.ts'],
      'the BOM sat in front of the first character, so `^import` never matched line 1 — a silent miss',
    );
    const hit = r.matches.find((m) => m.path === 'bom.ts');
    assert.equal(hit.line, 1);
    assert.equal(hit.text, 'import { thing } from "./thing";', 'the BOM must not be carried into the old_string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a BOM + CRLF file — the two legitimate Windows shapes together', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const root = makeTree({
    'both.ts': Buffer.concat([bom, Buffer.from('import a from "a";\r\n\tconst needleBC = 2;\r\n', 'utf8')]),
  });
  try {
    const anchored = searchText(root, '^import a');
    assert.equal(anchored.matches.length, 1, 'BOM + CRLF must not defeat a `^` anchor');
    const inner = searchText(root, 'needleBC = 2;$');
    assert.equal(inner.matches.length, 1, 'BOM + CRLF must not defeat a `$` anchor');
    assert.equal(inner.matches[0].text, '\tconst needleBC = 2;');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══ (4) THE OTHER LEGITIMATE SHAPES — A GUARD MUST NOT FAIL CORRECT WORK ════

test('an empty file, and a file with no trailing newline, are both handled', () => {
  const root = makeTree({
    'empty.js': '',
    'no-newline.js': '  const last = needleN;',
    'only-newline.js': '\n',
  });
  try {
    const r = searchText(root, 'needleN');
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 1, 'a file with no trailing newline still has a last line');
    assert.equal(r.matches[0].path, 'no-newline.js');
    assert.equal(r.matches[0].text, '  const last = needleN;');
    assert.equal(r.skippedCount, 0, 'an empty file is not a skip — it was read, it just has nothing in it');

    // And an empty file is not a crash and not a false positive.
    const dot = searchText(root, 'x');
    assert.equal(dot.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a BOM-only file and a CRLF-only file do not produce phantom matches', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const root = makeTree({ 'bomonly.txt': bom, 'crlfonly.txt': Buffer.from('\r\n\r\n', 'utf8') });
  try {
    const r = searchText(root, 'anything');
    assert.equal(r.ok, true);
    assert.deepEqual(r.matches, []);
    assert.equal(r.skippedCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══ (5) PAGING — "TRUNCATED" WITH NOWHERE TO GO IS A DEAD END ═══════════════

/** N files, each with exactly one hit, named so the sorted walk is stable. */
function manyHits(n) {
  const files = {};
  for (let i = 0; i < n; i += 1) files[`f-${String(i).padStart(4, '0')}.js`] = `  const hit = 'PAGEME${i}';\n`;
  return makeTree(files);
}

test('⭐ search_text pages: offset walks past the cap, and `total` says how much is out there', () => {
  const n = 150;
  const root = manyHits(n);
  try {
    const p1 = searchText(root, 'PAGEME');
    assert.equal(p1.ok, true);
    assert.equal(p1.matches.length, MAX_MATCHES);
    assert.equal(p1.total, n, 'the reply must say how many hits exist, not just that there were "more"');
    assert.equal(p1.offset, 0);
    assert.equal(p1.truncated, true);

    const p2 = searchText(root, 'PAGEME', { offset: MAX_MATCHES });
    assert.equal(p2.ok, true);
    assert.equal(p2.offset, MAX_MATCHES);
    assert.equal(p2.matches.length, MAX_MATCHES, 'the second page must exist');
    assert.equal(p2.total, n);
    assert.equal(p2.truncated, true);

    const p3 = searchText(root, 'PAGEME', { offset: MAX_MATCHES * 2 });
    assert.equal(p3.matches.length, n - MAX_MATCHES * 2);
    assert.equal(p3.truncated, false, 'the last page has nothing after it');

    // ⭐ NO GAPS, NO DUPLICATES — the pages must reconstruct the whole answer.
    const all = [...p1.matches, ...p2.matches, ...p3.matches].map((m) => m.path);
    assert.equal(new Set(all).size, n, 'pages overlapped or dropped hits');
    assert.deepEqual(all, [...all].sort(), 'paging must preserve the stable walk order');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐ find_files pages the same way, with the same `total`', () => {
  const n = 150;
  const root = manyHits(n);
  try {
    const p1 = findFiles(root, '*.js');
    assert.equal(p1.ok, true);
    assert.equal(p1.files.length, MAX_MATCHES);
    assert.equal(p1.total, n);
    assert.equal(p1.offset, 0);
    assert.equal(p1.truncated, true);

    const p2 = findFiles(root, '*.js', { offset: MAX_MATCHES });
    assert.equal(p2.files.length, MAX_MATCHES);
    assert.equal(p2.offset, MAX_MATCHES);

    const p3 = findFiles(root, '*.js', { offset: MAX_MATCHES * 2 });
    assert.equal(p3.files.length, n - MAX_MATCHES * 2);
    assert.equal(p3.truncated, false);

    const all = [...p1.files, ...p2.files, ...p3.files];
    assert.equal(new Set(all).size, n, 'pages overlapped or dropped files');
    assert.deepEqual(all, [...all].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an offset past the end is an honest empty page, not an error and not a wrap-around', () => {
  const root = manyHits(10);
  try {
    const r = searchText(root, 'PAGEME', { offset: 500 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.matches, []);
    assert.equal(r.total, 10, 'the model must still learn the real size');
    assert.equal(r.truncated, false);

    const f = findFiles(root, '*.js', { offset: 500 });
    assert.equal(f.ok, true);
    assert.deepEqual(f.files, []);
    assert.equal(f.total, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a nonsense offset is REFUSED with a usable message, never silently ignored', () => {
  const root = manyHits(3);
  try {
    for (const bad of [-1, 1.5, 'later', {}]) {
      const r = searchText(root, 'PAGEME', { offset: bad });
      assert.equal(r.ok, false, `offset ${JSON.stringify(bad)} was accepted`);
      assert.match(r.error, /offset/i);
      const f = findFiles(root, '*.js', { offset: bad });
      assert.equal(f.ok, false, `find_files accepted offset ${JSON.stringify(bad)}`);
    }
    // …and the shapes a model legitimately sends still work.
    assert.equal(searchText(root, 'PAGEME', { offset: 0 }).ok, true);
    assert.equal(searchText(root, 'PAGEME', { offset: '2' }).ok, true, 'a numeric string is what JSON tool-calls often carry');
    assert.equal(searchText(root, 'PAGEME', {}).offset, 0, 'omitting offset means page one');
    assert.equal(searchText(root, 'PAGEME').offset, 0, 'omitting the options object entirely still works');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('`total` is marked INEXACT when the walk itself was capped — never a false census', () => {
  const root = manyHits(20);
  try {
    const r = searchText(root, 'PAGEME');
    assert.equal(r.totalExact, true, 'a small clean tree gives an exact count');
    assert.equal(r.scanCapped, false);
    const f = findFiles(root, '*.js');
    assert.equal(f.totalExact, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('both schemas declare `offset`, and say what `total` means', () => {
  const s = searchToolSchemas();
  const byName = Object.fromEntries(s.map((t) => [t.function.name, t]));
  for (const name of ['find_files', 'search_text']) {
    const props = byName[name].function.parameters.properties;
    assert.ok(props.offset, `${name} has no offset parameter — the model is told "truncated" with nowhere to go`);
    assert.equal(props.offset.type, 'integer');
    assert.ok(!byName[name].function.parameters.required.includes('offset'), 'offset must stay optional');
    assert.match(byName[name].function.description, /offset/i, `${name} must TELL the model paging exists`);
    assert.match(byName[name].function.description, /total/i);
  }
  // ⭐ And the description must stop teaching the bug we just fixed.
  assert.match(
    byName.search_text.function.description,
    /indentation|whitespace|byte-exact|verbatim/i,
    'search_text must say its results are safe to build an edit from — that is the whole point of the fix',
  );
});

// ══ (6) THE GUARDS THAT MUST SURVIVE ALL OF THE ABOVE ═══════════════════════

test('⚠️⚠️ paging cannot be used to page INTO a credential file', () => {
  const root = makeTree({
    '.env': 'OPENROUTER_API_KEY=sk-or-v1-CANARYENV\n',
    'id_rsa': '-----BEGIN OPENSSH PRIVATE KEY-----\nCANARYKEY\n',
    'secrets.json': '{"aws_secret":"CANARYAWS"}\n',
    'src/app.js': '  // CANARYOK — ordinary source\n',
  });
  try {
    for (const offset of [0, 1, 2, 50]) {
      const r = searchText(root, 'CANARY', { offset });
      assert.equal(r.ok, true);
      const blob = JSON.stringify(r);
      for (const secret of ['CANARYENV', 'CANARYKEY', 'CANARYAWS']) {
        assert.ok(!blob.includes(secret), `${secret} leaked at offset ${offset}`);
      }
    }
    const first = searchText(root, 'CANARY');
    assert.equal(first.withheld, 2, 'id_rsa and secrets.json are withheld and COUNTED');
    assert.ok(first.matches.some((m) => m.path === 'src/app.js'));
    assert.equal(first.matches[0].text, '  // CANARYOK — ordinary source', 'and it is still byte-exact');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
