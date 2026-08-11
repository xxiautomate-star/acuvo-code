/**
 * ── ⚠️ `evaluate` LEAVES A FILE IN SOMEONE ELSE'S REPO ──────────────────────
 *
 * `evaluateSnippet` stages `.acuvo-eval-<pid>-<ts>.mjs` at the WORKSPACE ROOT —
 * the user's repo, not a temp dir — and removes it in a `finally`.
 *
 * ⭐ A `finally` DOES NOT RUN WHEN THE PROCESS IS KILLED. `turn.mjs` installs
 * `process.on('SIGINT', () => { …; process.exit(130); })`, so Ctrl-C during an
 * `evaluate` tears the process down mid-await and the `finally` never executes.
 * The snippet stays. `git status` goes dirty, and the file that ends up
 * committed is one nobody wrote.
 *
 * Two things are pinned here:
 *   1. an interrupted run cleans up anyway (an `exit` hook, which DOES fire on
 *      an explicit `process.exit`, unlike a raw signal);
 *   2. a snippet stranded by an earlier CRASH — where not even `exit` ran, e.g.
 *      SIGKILL or a power cut — is reaped by the next run.
 *
 * ── ⚠️⚠️ REAPING IS DELETING SOMEONE'S FILES, SO IT IS BOUNDED THREE WAYS ───
 * A reaper that fails correct work is far worse than the litter it removes.
 * The tests below hold it to all three at once: the name must match the exact
 * generated pattern, the file must be old, and it must be a plain file in the
 * root — never a directory, never a nested match, never a near-miss name. The
 * fixtures deliberately carry LF, CRLF, a UTF-8 BOM, no trailing newline, tabs,
 * deep indentation, non-ASCII text and an empty file, because a reaper that
 * reads content at all would be the wrong design and this proves it does not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, utimesSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { evaluateSnippet, reapStaleSnippets, STALE_SNIPPET_MS } from '../lib/evaluate.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { rmDirWithRetry } from './_teardown.mjs';

const LIB_EVALUATE = pathToFileURL(resolve('lib/evaluate.mjs')).href;
const LIB_WORKSPACE = pathToFileURL(resolve('lib/workspace.mjs')).href;

const ws = () => mkdtempSync(join(tmpdir(), 'acuvo-eval-litter-'));
const snippets = (root) => readdirSync(root).filter((n) => n.startsWith('.acuvo-eval-'));

/** Backdate a path so it is unambiguously older than the stale threshold. */
function age(path, ms) {
  const when = (Date.now() - ms) / 1000;
  utimesSync(path, when, when);
}

/**
 * The legitimate shapes a real repo contains. Every fixture below gets one of
 * these as its body, so nothing can pass by accident on "it was empty anyway".
 */
const SHAPES = [
  ['lf', 'const a = 1;\nconst b = 2;\n'],
  ['crlf', 'const a = 1;\r\nconst b = 2;\r\n'],
  ['bom', '﻿const a = 1;\n'],
  ['bom-crlf', '﻿const a = 1;\r\n'],
  ['no-trailing-newline', 'const a = 1;'],
  ['tabs', '\tif (x) {\n\t\treturn 1;\n\t}\n'],
  ['deep-indent', `${' '.repeat(48)}return 1;\n`],
  ['non-ascii', '// héllo — ünïcode ✓ 日本語 🚀\n'],
  ['empty', ''],
];

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE INTERRUPT — the defect, reproduced through the real module in a real
 *    child process that really exits 130 mid-evaluate.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️⚠️ an INTERRUPTED evaluate leaves no snippet behind', async () => {
  const root = ws();
  const box = mkdtempSync(join(tmpdir(), 'acuvo-eval-driver-'));
  try {
    // The driver reproduces turn.mjs's interrupt exactly: process.exit(130)
    // while evaluateSnippet is mid-await. The snippet itself finishes on its
    // own a moment later, so nothing is orphaned by this test.
    writeFileSync(join(box, 'driver.mjs'), [
      `import { evaluateSnippet } from ${JSON.stringify(LIB_EVALUATE)};`,
      `import { createLocalExecutor } from ${JSON.stringify(LIB_WORKSPACE)};`,
      `const executor = createLocalExecutor(${JSON.stringify(root)});`,
      "setTimeout(() => process.exit(130), 700).unref?.();",
      "await evaluateSnippet({ executor, source: 'await new Promise(r => setTimeout(r, 2500));', timeoutMs: 30000 });",
      "console.log('REACHED THE FINALLY');",
    ].join('\n'));

    const run = spawnSync(process.execPath, [join(box, 'driver.mjs')], { encoding: 'utf8' });

    assert.equal(run.status, 130, `the driver did not take the interrupt path: ${run.stderr}`);
    assert.ok(
      !/REACHED THE FINALLY/.test(run.stdout),
      'the run was not actually interrupted — evaluate returned normally, so the defect was never exercised',
    );
    assert.deepEqual(
      snippets(root), [],
      'an interrupted evaluate left its scratch snippet in the workspace — this is the file that gets committed',
    );
  } finally {
    await rmDirWithRetry(box);
    await rmDirWithRetry(root);
  }
});

test('the normal path still removes its own snippet (the finally must not be dropped)', async () => {
  const root = ws();
  try {
    const executor = createLocalExecutor(root);
    const r = await evaluateSnippet({ executor, source: "console.log('hi');" });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.passed, true);
    assert.match(r.stdout, /hi/);
    assert.deepEqual(snippets(root), []);
  } finally {
    await rmDirWithRetry(root);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE REAPER — what it takes, and much more importantly what it must not.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ a stale snippet from a crashed run is reaped, whatever its content', () => {
  const root = ws();
  try {
    const stale = [];
    SHAPES.forEach(([tag, body], i) => {
      const name = `.acuvo-eval-${1000 + i}-${1700000000000 + i}.mjs`;
      writeFileSync(join(root, name), body);
      age(join(root, name), STALE_SNIPPET_MS + 60_000);
      stale.push([name, tag]);
    });

    const reaped = reapStaleSnippets(root);

    assert.equal(reaped.length, SHAPES.length, `reaped ${reaped.length} of ${SHAPES.length}`);
    for (const [name, tag] of stale) {
      assert.equal(existsSync(join(root, name)), false, `the ${tag} snippet survived the reaper`);
    }
  } finally {
    rmDirWithRetry(root);
  }
});

test('⚠️⚠️ THE REAPER NEVER DELETES A FILE A USER WROTE', () => {
  const root = ws();
  try {
    /** Every one of these must still be here afterwards. */
    const keep = [
      // near-miss names, all backdated well past the threshold
      ['.acuvo-eval-notes.mjs', 'lf'],                 // no pid-ts pair
      ['.acuvo-eval-.mjs', 'crlf'],                    // empty pid-ts
      ['.acuvo-eval-1-2.mjs.bak', 'bom'],              // wrong extension
      ['.acuvo-eval-1-2.js', 'tabs'],                  // wrong extension
      ['acuvo-eval-1-2.mjs', 'non-ascii'],             // no leading dot
      ['.acuvo-eval-a-b.mjs', 'no-trailing-newline'],  // non-numeric
      ['.acuvo-eval-1-2-3.mjs', 'deep-indent'],        // three segments
      ['.acuvo-evaluate-1-2.mjs', 'empty'],            // different prefix
      ['x.acuvo-eval-1-2.mjs', 'lf'],                  // prefixed
      ['notes.mjs', 'bom-crlf'],
      ['README.md', 'lf'],
    ];
    const bodies = Object.fromEntries(SHAPES);
    for (const [name, tag] of keep) {
      writeFileSync(join(root, name), bodies[tag]);
      age(join(root, name), STALE_SNIPPET_MS * 10);
    }

    // A perfectly-named, ancient snippet that is a DIRECTORY, not a file.
    mkdirSync(join(root, '.acuvo-eval-7-7.mjs'));
    writeFileSync(join(root, '.acuvo-eval-7-7.mjs', 'inside.txt'), 'not yours\n');
    age(join(root, '.acuvo-eval-7-7.mjs'), STALE_SNIPPET_MS * 10);

    // A perfectly-named, ancient snippet NESTED one level down. Never recurse.
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', '.acuvo-eval-8-8.mjs'), 'console.log(1);\n');
    age(join(root, 'src', '.acuvo-eval-8-8.mjs'), STALE_SNIPPET_MS * 10);

    // A correctly-named snippet that is TOO YOUNG — it may belong to a live run
    // in another terminal, and deleting it would break a correct process.
    writeFileSync(join(root, '.acuvo-eval-9-9.mjs'), 'console.log(1);\n');

    const reaped = reapStaleSnippets(root);
    assert.deepEqual(reaped, [], `the reaper deleted files it had no business touching: ${reaped.join(', ')}`);

    for (const [name] of keep) {
      assert.equal(existsSync(join(root, name)), true, `${name} was deleted`);
    }
    assert.equal(existsSync(join(root, '.acuvo-eval-7-7.mjs', 'inside.txt')), true, 'a directory was reaped');
    assert.equal(existsSync(join(root, 'src', '.acuvo-eval-8-8.mjs')), true, 'the reaper recursed');
    assert.equal(existsSync(join(root, '.acuvo-eval-9-9.mjs')), true, 'a live run\'s snippet was reaped');

    // and the contents are untouched, byte for byte
    assert.equal(readFileSync(join(root, 'notes.mjs'), 'utf8'), bodies['bom-crlf']);
  } finally {
    rmDirWithRetry(root);
  }
});

test('the reaper is fail-safe: a missing or unreadable root is not an error', () => {
  assert.deepEqual(reapStaleSnippets(join(tmpdir(), 'acuvo-nope-does-not-exist-xyz')), []);
  assert.deepEqual(reapStaleSnippets(''), []);
  assert.deepEqual(reapStaleSnippets(null), []);
});

test('⭐ evaluate reaps on the way in, so litter never accumulates', async () => {
  const root = ws();
  try {
    writeFileSync(join(root, '.acuvo-eval-4242-1700000000000.mjs'), 'console.log("stranded");\n');
    age(join(root, '.acuvo-eval-4242-1700000000000.mjs'), STALE_SNIPPET_MS + 60_000);
    writeFileSync(join(root, 'keep.mjs'), '﻿const keep = 1;\r\n');
    age(join(root, 'keep.mjs'), STALE_SNIPPET_MS * 10);

    const executor = createLocalExecutor(root);
    const r = await evaluateSnippet({ executor, source: 'console.log(1 + 1);' });

    assert.equal(r.ok, true, r.error);
    assert.equal(existsSync(join(root, '.acuvo-eval-4242-1700000000000.mjs')), false, 'the stale snippet was not reaped');
    assert.equal(existsSync(join(root, 'keep.mjs')), true);
    assert.deepEqual(snippets(root), []);
  } finally {
    await rmDirWithRetry(root);
  }
});

test('⚠️ a --dry-run deletes nothing at all', async () => {
  const root = ws();
  try {
    writeFileSync(join(root, '.acuvo-eval-5-5.mjs'), 'console.log(1);\n');
    age(join(root, '.acuvo-eval-5-5.mjs'), STALE_SNIPPET_MS * 10);
    const executor = createLocalExecutor(root, { dryRun: true });
    const r = await evaluateSnippet({ executor, source: 'console.log(1);' });
    assert.equal(r.ok, false);
    assert.equal(existsSync(join(root, '.acuvo-eval-5-5.mjs')), true, 'a dry run reaped a file');
  } finally {
    await rmDirWithRetry(root);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. THE SNIPPET ITSELF — the shapes real source arrives in must still run.
 * ──────────────────────────────────────────────────────────────────────────── */

test('⚠️ snippets with a BOM, CRLF, tabs, deep indentation or non-ASCII still run and still clean up', async () => {
  const root = ws();
  try {
    const executor = createLocalExecutor(root);
    const cases = [
      ['lf', "console.log('lf-ok');\n", /lf-ok/],
      ['crlf', "console.log('crlf-ok');\r\n", /crlf-ok/],
      ['bom', "﻿console.log('bom-ok');\n", /bom-ok/],
      ['bom-crlf', "﻿console.log('bomcrlf-ok');\r\n", /bomcrlf-ok/],
      ['no-trailing-newline', "console.log('nonl-ok');", /nonl-ok/],
      ['tabs', "if (true) {\n\tconsole.log('tab-ok');\n}\n", /tab-ok/],
      ['deep-indent', `${' '.repeat(40)}console.log('indent-ok');\n`, /indent-ok/],
      ['non-ascii', "console.log('héllo — 日本語 ✓ 🚀');\n", /日本語/],
    ];
    for (const [tag, source, expect] of cases) {
      const r = await evaluateSnippet({ executor, source });
      assert.equal(r.ok, true, `${tag}: ${r.error}`);
      assert.equal(r.passed, true, `${tag} did not exit 0: ${r.stderr}`);
      assert.match(r.stdout, expect, `${tag} printed: ${r.stdout}`);
      assert.deepEqual(snippets(root), [], `${tag} left a snippet behind`);
    }
    // An empty snippet is still refused, and refusing writes nothing.
    const empty = await evaluateSnippet({ executor, source: '' });
    assert.equal(empty.ok, false);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    await rmDirWithRetry(root);
  }
});
