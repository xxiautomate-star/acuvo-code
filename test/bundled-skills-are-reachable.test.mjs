/**
 * ── ⚠️⚠️ 44 SKILLS SHIPPED IN THE TARBALL AND IN NEITHER BUNDLE ─────────────
 *
 * `test/skills-are-published.test.mjs` records the first flavour of this: the
 * shelf existed in the repo and `package.json`'s `files` array did not list it,
 * so `npm pack` shipped zero skills. That was fixed and guarded.
 *
 * ⚠️ THE SAME DEFECT WAS STILL LIVE ONE DISTRIBUTION LATER. `builtinSkillsRoot()`
 * read `join(dirname(fileURLToPath(import.meta.url)), '..')`, which is exactly
 * right for `lib/builtin-skills.mjs` inside an npm install and wrong by one
 * directory inside `dist/acuvo.mjs`: the bundler rewrites a bare
 * `import.meta.url` to a URL under the BUNDLE's own directory, so the arithmetic
 * yielded `<dist>` and looked for the shelf at `dist/skills/` — a directory that
 * has never existed. MEASURED 2026-08-29 end to end, with `--doctor` and nothing
 * else, from an empty workspace:
 *
 *     node bin/acuvo.mjs  --doctor    58 of 77 tools, read_skill offered
 *     node dist/acuvo.mjs --doctor    57 of 77 tools, read_skill DARK —
 *                                     "the bundled shelf is empty"
 *
 * ⚠️⚠️ AND THE BUNDLE IS WHAT THE BENCHMARK SCORES. `bench/terminal-bench`
 * uploads `dist/acuvo.mjs` to `/opt/acuvo.mjs` and nothing else — *"the agent is
 * ONE FILE"* — so `/opt/skills/` did not exist either. `tools.mjs` gates
 * `read_skill` on `skillsAvailable()`, so in every containerised trial the verb
 * was never offered and the SKILLS catalogue was never in the prompt. That is
 * the whole explanation for `read_skill` being called ZERO times in 1,379
 * recorded rounds: not a model that ignored it, a verb that was never on the
 * table.
 *
 * ── ⭐ WHAT THIS FILE ACTUALLY ASSERTS ──────────────────────────────────────
 *
 * Not "the code contains a string". The last test here BUILDS the real bundle,
 * drops it ALONE in a temp directory — the container's shape exactly — runs it,
 * and compares its own report with the source CLI's. A count that matches is a
 * fact about a process that ran; a grep over `scripts/bundle.mjs` would have
 * passed against the broken version too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { bundle } from '../scripts/bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELF = join(ROOT, 'skills');

const realReadFile = (id) => {
  try { return readFileSync(join(ROOT, id), 'utf8'); } catch { return null; }
};
const realReadDir = (id) => {
  try {
    return readdirSync(join(ROOT, id), { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  } catch { return null; }
};

test('⭐ the shelf on disk is real — a guard written against an empty one passes trivially', () => {
  const md = readdirSync(SHELF).filter((f) => f.endsWith('.md'));
  assert.ok(md.length > 10, `only ${md.length} skills on disk — this file would be blind`);
});

test('⚠️⚠️ every skill on the shelf is inlined into the bundle', () => {
  const { assets, code } = bundle({ entry: 'bin/acuvo.mjs', readFile: realReadFile, readDir: realReadDir });
  const onDisk = readdirSync(SHELF, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  /**
   * ⚠️ DERIVED FROM DISK, NEVER A COUNT. A number here gets "fixed" by editing
   * the test the next time somebody writes a skill, which is how the shelf grew
   * into three separate caps in this package's history.
   */
  const missing = onDisk.filter((name) => !assets.includes(`skills/${name}`));
  assert.deepEqual(missing, [], `these shelf files are not in the bundle: ${missing.join(', ')}`);
  assert.ok(code.includes('"skills/accessibility.md"'), 'the asset table does not carry a skill body');
});

test('⚠️ the directory reference is rewritten to the directory helper, not to a module URL', () => {
  const { code } = bundle({ entry: 'bin/acuvo.mjs', readFile: realReadFile, readDir: realReadDir });
  assert.ok(
    code.includes('__acuvo_assetDirUrl("skills/")'),
    'builtinSkillsRoot() is not resolving through the inlined shelf — it is back to package-root arithmetic '
    + 'against the bundle\'s own directory, which is the defect this file exists for',
  );
});

/* ── the synthetic cases: one directory, one file, one empty ──────────────── */

const tinyTree = (files) => ({
  readFile: (id) => (Object.prototype.hasOwnProperty.call(files, id) ? files[id] : null),
  readDir: (id) => {
    const prefix = `${id}/`;
    const names = Object.keys(files).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      .map((k) => k.slice(prefix.length));
    return names.length ? names : [];
  },
});

test('⭐ a trailing slash inlines the whole directory; the same name without one is a single file', () => {
  const dirCase = tinyTree({
    'entry.mjs': "const u = new URL('shelf/', import.meta.url);\nexport const u2 = u;\n",
    'shelf/a.md': 'AAA',
    'shelf/b.md': 'BBB',
  });
  const dir = bundle({ entry: 'entry.mjs', ...dirCase });
  assert.deepEqual(dir.assets, ['shelf/a.md', 'shelf/b.md']);
  assert.ok(dir.code.includes('__acuvo_assetDirUrl("shelf/")'));

  const fileCase = tinyTree({
    'entry.mjs': "const u = new URL('shelf', import.meta.url);\nexport const u2 = u;\n",
    shelf: 'ONE FILE',
  });
  const one = bundle({ entry: 'entry.mjs', ...fileCase });
  assert.deepEqual(one.assets, ['shelf']);
  assert.ok(one.code.includes('__acuvo_asset("shelf")'), 'a file reference must not go through the directory helper');
});

test('⚠️ a directory reference with no files is REFUSED at build time', () => {
  const empty = tinyTree({ 'entry.mjs': "export const u = new URL('shelf/', import.meta.url);\n" });
  assert.throws(
    () => bundle({ entry: 'entry.mjs', ...empty }),
    /has no files/,
    'an empty shelf must fail the BUILD — a bundle that ships an empty shelf in silence is the original defect',
  );
});

/* ── the end-to-end one: the container's shape, exactly ───────────────────── */

test('⚠️⚠️ the bundle ALONE in a directory offers the same tools as the source CLI', () => {
  const work = mkdtempSync(join(tmpdir(), 'acuvo-bundled-skills-'));
  try {
    const opt = join(work, 'opt');
    const proj = join(work, 'proj');
    mkdirSync(opt);
    mkdirSync(proj);

    // Build fresh rather than trusting whatever `dist/` happens to hold — a
    // stale bundle would make this test a statement about yesterday.
    const built = join(opt, 'acuvo.mjs');
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'bundle.mjs'), '--out', built], { cwd: ROOT });
    copyFileSync(built, join(opt, 'acuvo.mjs'));

    /**
     * ── ⚠️⚠️ THIS TEST WAS ASSERTING ON THE DOCTOR'S VERDICT ABOUT THE MACHINE
     *
     * It called `execFileSync`, which THROWS on a non-zero exit, and
     * `bin/acuvo.mjs` returns `EXIT_FAILED` from `--doctor` whenever
     * `summary.broken > 0` — i.e. whenever anything on the developer's machine
     * is red. So a test about **what is inside the bundle** failed because of a
     * media endpoint answering HTTP 400, a probe timing out under load, or a
     * rate-limited key.
     *
     * ⚠️ IT LOOKED LIKE FLAKINESS AND IT IS NOT. `scripts/test.mjs` hands the
     * run a throwaway `ACUVO_HOME`, so the credential-dependent checks report
     * `dark` rather than `broken` and the suite usually passes; only the
     * transient network checks were left to flip it, which they do under load.
     * Reproduced DETERMINISTICALLY 2026-09-01 by running this file with the
     * developer's real home visible:
     *
     *     env -u ACUVO_HOME node --test test/bundled-skills-are-reachable.test.mjs
     *     not ok 6 — Command failed: … \opt\acuvo.mjs --doctor
     *     (6 broken: see_page, speak, transcribe, make_document, read_document,
     *      read_table — all "configured … HTTP 400")
     *
     * ⭐ THE EXIT CODE IS NOT THIS TEST'S SIGNAL. The claim is "the bundle
     * offers the same tools as the source", and that claim lives in the tool
     * COUNT line, which `--doctor` prints on its way to either exit code. So the
     * output is read either way, and a doctor that printed nothing usable is
     * still caught — by the `count()` assertions below, which is where that
     * check belongs.
     *
     * ⚠️ A CRASH IS STILL A FAILURE. `error.stdout` is undefined if the process
     * never ran or died without writing; that falls through as `''` and the
     * count assertions go red with the output attached.
     */
    const run = (bin) => {
      try {
        return execFileSync(process.execPath, [bin, '--doctor'], {
          cwd: proj,
          encoding: 'utf8',
          env: { ...process.env, NO_COLOR: '1' },
        });
      } catch (err) {
        return typeof err?.stdout === 'string' ? err.stdout : '';
      }
    };

    const fromBundle = run(built);
    const fromSource = run(join(ROOT, 'bin', 'acuvo.mjs'));

    // ⭐ THE HARNESS PROVES ITSELF FIRST. If `--doctor` printed nothing useful
    // the two "not dark" assertions below would both pass on empty strings.
    const count = (text) => /tools offered here\s+(\d+) of (\d+)/.exec(text);
    const b = count(fromBundle);
    const s = count(fromSource);
    assert.ok(b, `the bundle's doctor printed no tool count:\n${fromBundle.slice(0, 400)}`);
    assert.ok(s, `the source doctor printed no tool count:\n${fromSource.slice(0, 400)}`);

    assert.equal(
      b[1], s[1],
      `the bundle offers ${b[1]} of ${b[2]} tools and the source offers ${s[1]} of ${s[2]} — `
      + 'the bundled distribution is missing a capability the source has',
    );
    assert.ok(
      !/read_skill\s+no skills are readable/.test(fromBundle),
      'the bundle reports its shelf as empty — 44 authored skills are unreachable in the one file '
      + 'the benchmark scores and the README tells strangers to run',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
