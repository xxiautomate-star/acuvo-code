/**
 * ── WHAT THIS SUITE IS GUARDING ─────────────────────────────────────────────
 *
 * The measured defect: `gatherWorkspaceContext` (lib/turn.mjs) walks TWO
 * directory levels and inlines whole files in ALPHABETICAL order, capped at 12
 * files / 40KB. On a real repo the model therefore sees roughly 5% of the paths
 * and spends thousands of tokens on READMEs and build junk, while the file it
 * needs is invisible. A model that cannot see a file does not go looking — it
 * invents a plausible one and writes there.
 *
 * ⭐ THE ECONOMICS ARE THE WHOLE ARGUMENT. A path is a handful of tokens; a
 * file is thousands. Listing two thousand paths costs less than inlining five
 * files. So this module trades CONTENT for COVERAGE.
 *
 * Four properties are load-bearing and every one of them has its own tests:
 *
 *   1. DETERMINISM. Same tree, same bytes, byte for byte, every run — including
 *      when the filesystem hands directory entries back in a different order,
 *      which it does. A map that reshuffles destroys the cached prompt prefix,
 *      and prefix stability is worth 3.05x on DeepSeek. This is why there are
 *      no timestamps and no relative ages anywhere in the output.
 *   2. HONEST TRUNCATION. It must never imply it is complete when it is not,
 *      and it must say WHERE the gaps are, not merely how many.
 *   3. NO CONTENT LEAVES. It emits paths and symbol NAMES. Never a file body,
 *      never a gitignored path, never a credential-shaped path.
 *   4. THE GUESS IS LABELLED. Symbols come from a regex, not a parser. A wrong
 *      guess is acceptable; presenting one as authoritative is not.
 *
 * ⚠️ AND THE CHECKS MUST PASS CORRECT WORK. There are deliberate tests for the
 * legitimate shapes — a repo with NO .gitignore must have nothing ignored, a
 * repo that fits the budget must be reported COMPLETE, and a source file with
 * no exports must not be labelled as having none it does not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRepoMap,
  repoMapForExecutor,
  estimateTokens,
  parseGitignore,
  makeIgnoreMatcher,
  extractExports,
  SKIP_DIRS,
  HIDDEN_DIRS_ALLOWED,
  DEFAULT_BUDGET_TOKENS,
} from '../lib/repo-map.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A whole filesystem as a literal, so every test below is pure data in and pure
 * data out — no disk, no clock, no network, and therefore no flake.
 *
 * ⚠️ `readdirImpl` RETURNS ITS ENTRIES REVERSED ON PURPOSE. A real `readdir`
 * makes no order promise, and the determinism this module sells is worthless if
 * it is really just inheriting the filesystem's accidental sort. Reversing here
 * means any test that asserts an order is asserting OUR sort.
 */
function makeFs(files, { order = 'reverse' } = {}) {
  const norm = new Map();
  for (const [p, v] of Object.entries(files)) {
    norm.set(p, typeof v === 'string'
      ? { content: v, mtimeMs: 0 }
      : { content: v.content ?? '', mtimeMs: v.mtimeMs ?? 0, size: v.size });
  }
  const dirs = new Set(['']);
  for (const p of norm.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    existsImpl: (rel) => norm.has(rel) || dirs.has(rel),
    readdirImpl: (rel) => {
      if (!dirs.has(rel)) return null;
      const prefix = rel === '' ? '' : `${rel}/`;
      const seen = new Map();
      for (const p of norm.keys()) {
        if (rel !== '' && !p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) seen.set(rest, 'file');
        else seen.set(rest.slice(0, slash), 'dir');
      }
      const out = [...seen].map(([name, type]) => ({ name, type }));
      if (order === 'reverse') out.reverse();
      if (order === 'sorted') out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return out;
    },
    statImpl: (rel) => {
      if (norm.has(rel)) {
        const f = norm.get(rel);
        return { size: f.size ?? Buffer.byteLength(f.content, 'utf8'), mtimeMs: f.mtimeMs, dir: false };
      }
      if (dirs.has(rel)) return { size: 0, mtimeMs: 0, dir: true };
      return null;
    },
    readFileImpl: (rel) => (norm.has(rel) ? norm.get(rel).content : null),
  };
}

/** Every file line in the FILES section, path only. */
function listedPaths(map) {
  return map.files.map((f) => f.path);
}

// ── 1. THE TOKEN ESTIMATE ───────────────────────────────────────────────────

test('estimateTokens is monotonic and never returns 0 for non-empty text', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a') >= 1);
  assert.ok(estimateTokens('a'.repeat(400)) > estimateTokens('a'.repeat(40)));
});

test('estimateTokens is in the right ballpark for a path list — the number the budget is spent in', () => {
  const paths = Array.from({ length: 100 }, (_, i) => `packages/app/src/components/Widget${i}.tsx`).join('\n');
  const t = estimateTokens(paths);
  // ~45 chars per path. A path is single-digit-to-teens tokens, never hundreds.
  assert.ok(t > 100 && t < 2000, `100 paths estimated at ${t} tokens — that cannot be right`);
});

// ── 2. THE PATH LIST, AND THE POINT OF THE WHOLE MODULE ─────────────────────

test('every file in the tree is listed — including ones four levels down that the old two-level walk could never see', () => {
  const fs = makeFs({
    'package.json': '{"name":"x"}',
    'src/a.js': 'x',
    'src/deep/deeper/deepest/target.js': 'export const found = 1;',
    'src/deep/deeper/other.js': 'x',
  });
  const map = buildRepoMap('/repo', fs);
  assert.equal(map.ok, true);
  assert.ok(listedPaths(map).includes('src/deep/deeper/deepest/target.js'),
    'the four-levels-deep file is exactly the one the old pre-read could not see');
  assert.equal(map.stats.totalFiles, 4);
  assert.equal(map.stats.listedFiles, 4);
});

test('paths are sorted deterministically even when readdir hands entries back in a hostile order', () => {
  const files = {
    'z.js': 'x', 'a.js': 'x', 'm/b.js': 'x', 'm/a.js': 'x', 'B.js': 'x',
  };
  const forward = buildRepoMap('/repo', makeFs(files, { order: 'sorted' }));
  const backward = buildRepoMap('/repo', makeFs(files, { order: 'reverse' }));
  assert.equal(forward.text, backward.text, 'the map reshuffled with readdir order — the cache prefix is dead');
  assert.deepEqual(listedPaths(forward), [...listedPaths(forward)].sort());
});

test('two runs over an identical tree are byte-identical — prefix stability is worth 3.05x', () => {
  const files = { 'a.js': 'x', 'b/c.js': 'y', 'README.md': '# hi' };
  const one = buildRepoMap('/repo', makeFs(files));
  const two = buildRepoMap('/repo', makeFs(files));
  assert.equal(one.text, two.text);
});

test('sorting is by CODE POINT, not locale — an ICU-dependent sort is a different prefix on a different machine', () => {
  const fs = makeFs({ 'Zebra.js': 'x', 'apple.js': 'x', 'Banana.js': 'x' });
  const map = buildRepoMap('/repo', fs);
  const paths = listedPaths(map);
  // Code-point order puts every capital before every lowercase. localeCompare
  // does not, and that is the whole difference this asserts.
  assert.deepEqual(paths, ['Banana.js', 'Zebra.js', 'apple.js']);
});

// ── 3. SKIP RULES — AND THEY MUST NOT DISAGREE WITH search.mjs ──────────────

test('the build/dependency directories are never walked', () => {
  const fs = makeFs({
    'src/a.js': 'x',
    'node_modules/left-pad/index.js': 'x',
    '.git/objects/ab/cdef': 'x',
    'dist/bundle.js': 'x',
    'build/out.js': 'x',
    'coverage/lcov.info': 'x',
    '.turbo/log': 'x',
    '.vercel/output.json': 'x',
    '.next/trace': 'x',
  });
  const map = buildRepoMap('/repo', fs);
  assert.deepEqual(listedPaths(map), ['src/a.js']);
  for (const bad of ['node_modules', '.git/', 'dist/bundle', 'coverage/']) {
    assert.ok(!map.text.includes(`${bad}/left-pad`), `walked into ${bad}`);
  }
  assert.ok(map.stats.skippedDirs >= 8, `expected every skipped dir counted, got ${map.stats.skippedDirs}`);
});

test('a skipped directory is NAMED, not silently dropped — the model has to know where it cannot see', () => {
  const fs = makeFs({ 'src/a.js': 'x', 'node_modules/p/i.js': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.match(map.text, /node_modules/, 'the map never mentions node_modules, so the gap is invisible');
});

test('⭐ DRIFT GUARD: the skip set is byte-identical to lib/search.mjs — two ideas about the tree is the bug', () => {
  const src = readFileSync(join(REPO_ROOT, 'lib', 'search.mjs'), 'utf8');
  const m = src.match(/const SKIP_DIRS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'lib/search.mjs no longer declares SKIP_DIRS the way this guard reads it — update the guard, do not delete it');
  const theirs = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual([...SKIP_DIRS].sort(), theirs,
    'repo-map.mjs and search.mjs disagree about which directories exist. The model would be told a file is absent that search can find, or the reverse.');
});

test('⭐ DRIFT GUARD: the hidden-directory allowlist matches lib/search.mjs too', () => {
  const src = readFileSync(join(REPO_ROOT, 'lib', 'search.mjs'), 'utf8');
  const m = src.match(/const HIDDEN_DIRS_ALLOWED = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'lib/search.mjs no longer declares HIDDEN_DIRS_ALLOWED the way this guard reads it');
  const theirs = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual([...HIDDEN_DIRS_ALLOWED].sort(), theirs);
});

test('.github is walked because CI workflows are ordinary source people ask an agent to change', () => {
  const fs = makeFs({ '.github/workflows/ci.yml': 'on: push', 'src/a.js': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.ok(listedPaths(map).includes('.github/workflows/ci.yml'));
});

test('an ordinary hidden directory is NOT walked, and is counted rather than forgotten', () => {
  const fs = makeFs({ '.aws/config': 'x', '.cache/blob': 'x', 'src/a.js': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.deepEqual(listedPaths(map), ['src/a.js']);
  assert.ok(map.stats.hidden >= 2, `hidden entries were dropped without a count: ${map.stats.hidden}`);
});

test('a hidden FILE is never listed — hidden files are overwhelmingly config and credentials', () => {
  const fs = makeFs({ '.env': 'OPENROUTER_API_KEY=sk-or-v1-real', 'src/a.js': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.ok(!map.text.includes('.env'));
  assert.ok(!map.text.includes('sk-or-v1'));
});

// ── 4. CREDENTIALS. THE PROMPT IS AN EXFILTRATION PATH. ─────────────────────

test('credential-shaped paths are never listed, and reuse git.mjs\'s list rather than a second copy', () => {
  const fs = makeFs({
    'config/secrets.json': '{"pw":"hunter2"}',
    'keys/server.pem': 'x',
    'deploy/id_rsa': 'x',
    'src/a.js': 'x',
  });
  const map = buildRepoMap('/repo', fs);
  assert.deepEqual(listedPaths(map), ['src/a.js']);
  for (const bad of ['secrets.json', 'server.pem', 'id_rsa', 'hunter2']) {
    assert.ok(!map.text.includes(bad), `${bad} reached the prompt`);
  }
  assert.equal(map.stats.withheld, 3);
});

test('withheld files are reported as a COUNT — silently vanishing is how "not found" becomes a lie', () => {
  const fs = makeFs({ '.env': 'x', 'src/a.js': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.ok(/withheld|credential|hidden/i.test(map.text), 'nothing in the text admits something was held back');
});

test('⚠️ NO FILE BODY EVER REACHES THE TEXT — the map is paths, and content is what the old pre-read leaked', () => {
  const body = 'const DATABASE_PASSWORD = "correct-horse-battery-staple";';
  const fs = makeFs({ 'src/config.js': body, 'README.md': 'a very long readme body indeed' });
  const map = buildRepoMap('/repo', fs);
  assert.ok(!map.text.includes('correct-horse-battery-staple'));
  assert.ok(!map.text.includes('a very long readme body indeed'));
});

// ── 5. .gitignore ───────────────────────────────────────────────────────────

test('parseGitignore drops blanks and comments and keeps order', () => {
  const rules = parseGitignore('\n# a comment\n*.log\n\n  \nbuild/\n!keep.log\n');
  assert.deepEqual(rules.map((r) => r.pattern), ['*.log', 'build/', 'keep.log']);
  assert.equal(rules[2].negate, true);
  assert.equal(rules[1].dirOnly, true);
});

test('parseGitignore honours an escaped leading hash and an escaped bang', () => {
  const rules = parseGitignore('\\#notacomment\n\\!literal\n');
  assert.deepEqual(rules.map((r) => r.pattern), ['#notacomment', '!literal']);
  assert.equal(rules[1].negate, false);
});

test('the matcher: unanchored patterns match at any depth, anchored ones only at the root', () => {
  const m = makeIgnoreMatcher(parseGitignore('*.log\n/root-only.txt\nsrc/generated/\n'));
  assert.equal(m('a.log', false), true);
  assert.equal(m('deep/nested/a.log', false), true);
  assert.equal(m('root-only.txt', false), true);
  assert.equal(m('sub/root-only.txt', false), false, 'a leading slash means ROOT ONLY and this matched deeper');
  assert.equal(m('src/generated', true), true);
  assert.equal(m('src/generated/x.js', false), true, 'a file under an ignored directory is ignored');
});

test('the matcher: a trailing-slash pattern matches a DIRECTORY, not a file of the same name', () => {
  const m = makeIgnoreMatcher(parseGitignore('build/\n'));
  assert.equal(m('build', true), true);
  assert.equal(m('build', false), false, 'build/ ignored a FILE called build — that is not what the trailing slash means');
});

test('the matcher: last rule wins, so a negation re-includes', () => {
  const m = makeIgnoreMatcher(parseGitignore('*.log\n!keep.log\n'));
  assert.equal(m('debug.log', false), true);
  assert.equal(m('keep.log', false), false);
  assert.equal(m('logs/keep.log', false), false);
});

test('the matcher: ** spans zero or more directories, the same reading bash, minimatch and ripgrep use', () => {
  const m = makeIgnoreMatcher(parseGitignore('docs/**/draft.md\n'));
  assert.equal(m('docs/draft.md', false), true, '** must match ZERO directories — the same bug search.mjs fixed');
  assert.equal(m('docs/a/b/draft.md', false), true);
  assert.equal(m('other/draft.md', false), false);
});

test('the matcher: * does not cross a slash', () => {
  const m = makeIgnoreMatcher(parseGitignore('src/*.js\n'));
  assert.equal(m('src/a.js', false), true);
  assert.equal(m('src/deep/a.js', false), false);
});

test('a gitignored file is not listed, and the omission is counted', () => {
  const fs = makeFs({
    '.gitignore': 'secret-notes.md\ntmp/\n',
    'secret-notes.md': 'private',
    'tmp/scratch.js': 'x',
    'src/a.js': 'x',
  });
  const map = buildRepoMap('/repo', fs);
  assert.deepEqual(listedPaths(map), ['.gitignore', 'src/a.js']);
  assert.equal(map.stats.gitignored, 2);
  assert.equal(map.stats.gitignoreUsed, true);
});

test('a NESTED .gitignore applies to its own subtree and not to a sibling', () => {
  const fs = makeFs({
    'packages/a/.gitignore': 'out.js\n',
    'packages/a/out.js': 'x',
    'packages/a/keep.js': 'x',
    'packages/b/out.js': 'x',
  });
  const map = buildRepoMap('/repo', fs);
  const paths = listedPaths(map);
  assert.ok(!paths.includes('packages/a/out.js'));
  assert.ok(paths.includes('packages/b/out.js'), 'a nested ignore leaked into a sibling package');
  assert.ok(paths.includes('packages/a/keep.js'));
});

test('⚠️ A CHECK THAT FAILS CORRECT WORK: no .gitignore means NOTHING is ignored', () => {
  const fs = makeFs({ 'a.log': 'x', 'build.js': 'x', 'tmp.txt': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.deepEqual(listedPaths(map), ['a.log', 'build.js', 'tmp.txt']);
  assert.equal(map.stats.gitignored, 0);
  assert.equal(map.stats.gitignoreUsed, false);
});

test('an empty or comments-only .gitignore ignores nothing', () => {
  const fs = makeFs({ '.gitignore': '# nothing here\n\n', 'a.log': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.ok(listedPaths(map).includes('a.log'));
  assert.equal(map.stats.gitignored, 0);
});

// ── 6. SYMBOLS — A GUESS, LABELLED AS ONE ───────────────────────────────────

test('extractExports finds the ordinary JS/TS export shapes', () => {
  const src = [
    'export function buildRepoMap() {}',
    'export async function walkTree() {}',
    'export const DEFAULT_BUDGET = 4000;',
    'export let mutable = 1;',
    'export class Mapper {}',
    'export default function main() {}',
    'export { alpha, beta as gamma };',
    'function notExported() {}',
  ].join('\n');
  const names = extractExports('lib/x.mjs', src);
  for (const want of ['buildRepoMap', 'walkTree', 'DEFAULT_BUDGET', 'mutable', 'Mapper', 'main', 'alpha', 'gamma']) {
    assert.ok(names.includes(want), `missed ${want} in ${JSON.stringify(names)}`);
  }
  assert.ok(!names.includes('notExported'));
});

test('extractExports handles CommonJS, because half the world is still on it', () => {
  const names = extractExports('lib/x.js', 'exports.doThing = () => {};\nmodule.exports = { alpha, beta };\n');
  assert.ok(names.includes('doThing'));
  assert.ok(names.includes('alpha') && names.includes('beta'));
});

test('extractExports reads python, go and rust top-level definitions', () => {
  assert.deepEqual(extractExports('a.py', 'def run():\n    pass\nclass Thing:\n    def inner(self): pass\n').sort(), ['Thing', 'run']);
  assert.ok(extractExports('a.go', 'func Serve() {}\ntype Config struct{}\n').includes('Serve'));
  assert.ok(extractExports('a.rs', 'pub fn parse() {}\npub struct Cfg;\n').includes('parse'));
});

test('extractExports returns nothing rather than garbage for a file it does not understand', () => {
  assert.deepEqual(extractExports('a.md', '# export function fake() {}'), []);
  assert.deepEqual(extractExports('a.json', '{"export": 1}'), []);
  assert.deepEqual(extractExports('a.mjs', ''), []);
});

test('extractExports never emits a name that is not a plausible identifier', () => {
  const names = extractExports('a.mjs', 'export const \u0000\uFFFD = 1;\nexport function 9bad() {}\nexport const ok_1$ = 2;\n');
  for (const n of names) assert.match(n, /^[A-Za-z_$][\w$]*$/, `emitted a junk symbol: ${JSON.stringify(n)}`);
  assert.ok(names.includes('ok_1$'));
});

test('extractExports is bounded — a pathological file cannot produce a thousand-symbol line', () => {
  const src = Array.from({ length: 500 }, (_, i) => `export const sym${i} = ${i};`).join('\n');
  const names = extractExports('a.mjs', src);
  assert.ok(names.length <= 64, `emitted ${names.length} symbols from one file`);
});

test('symbols appear beside their path in the map', () => {
  const fs = makeFs({ 'lib/chain.mjs': 'export function callChain() {}\nexport const RETRIES = 3;\n' });
  const map = buildRepoMap('/repo', fs);
  assert.match(map.text, /lib\/chain\.mjs.*callChain/);
  assert.deepEqual(map.files.find((f) => f.path === 'lib/chain.mjs').symbols, ['RETRIES', 'callChain']);
});

test('⭐ the guess is LABELLED as a guess — never presented as authoritative', () => {
  const fs = makeFs({ 'lib/a.mjs': 'export function x() {}' });
  const map = buildRepoMap('/repo', fs);
  assert.match(map.text, /regex|guess|not a parse/i,
    'the map shows symbols with no warning that they came from a regex — a missing name would read as proof of absence');
});

test('a source file with no exports gets no symbol annotation at all, and is not claimed to have none', () => {
  const fs = makeFs({ 'src/side-effects.js': 'console.log("hi");\n' });
  const map = buildRepoMap('/repo', fs);
  assert.ok(map.text.includes('src/side-effects.js'));
  assert.ok(!/side-effects\.js.*\[/.test(map.text), 'annotated an empty symbol list, which reads as "this file exports nothing"');
});

test('symbol extraction never reads a binary or oversized file', () => {
  const fs = makeFs({
    'a.mjs': { content: 'export const x = 1;', size: 900_000 },
    'b.mjs': 'export const \u0000bad = 1;',
  });
  const map = buildRepoMap('/repo', fs);
  assert.deepEqual(map.files.find((f) => f.path === 'a.mjs').symbols, undefined, 'read a 900KB file for symbols');
  assert.ok(!map.text.includes('\u0000'));
});

test('a read that fails during symbol extraction degrades to no symbols, never to a crash', () => {
  const fs = makeFs({ 'a.mjs': 'export const x = 1;' });
  const map = buildRepoMap('/repo', { ...fs, readFileImpl: () => { throw new Error('EACCES'); } });
  assert.equal(map.ok, true);
  assert.ok(listedPaths(map).includes('a.mjs'));
});

// ── 7. ORIENTATION SIGNALS ──────────────────────────────────────────────────

test('entry points come out of package.json — bin, main and scripts', () => {
  const fs = makeFs({
    'package.json': JSON.stringify({
      name: 'acuvo-code',
      main: './lib/index.mjs',
      bin: { acuvo: './bin/acuvo.mjs' },
      scripts: { test: 'node --test test/*.test.mjs', build: 'node scripts/bundle.mjs' },
    }),
    'lib/index.mjs': 'x',
    'bin/acuvo.mjs': 'x',
  });
  const map = buildRepoMap('/repo', fs);
  assert.match(map.text, /ENTRY POINTS/);
  assert.match(map.text, /bin\/acuvo\.mjs/);
  assert.match(map.text, /lib\/index\.mjs/);
  assert.match(map.text, /node --test/);
  assert.deepEqual(map.stats.entryPoints.map((e) => e.target).sort(), ['./bin/acuvo.mjs', './lib/index.mjs'].sort());
});

test('a string `bin` is an entry point too', () => {
  const fs = makeFs({ 'package.json': JSON.stringify({ name: 'p', bin: './cli.js' }), 'cli.js': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.match(map.text, /cli\.js/);
});

test('⚠️ A MALFORMED package.json IS NOT FATAL — a repo mid-edit still gets a map', () => {
  const fs = makeFs({ 'package.json': '{ this is not json', 'src/a.js': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.equal(map.ok, true);
  assert.ok(listedPaths(map).includes('src/a.js'));
  assert.deepEqual(map.stats.entryPoints, []);
});

test('the test directory is named, with a count, because "where are the tests" is the second question anyone asks', () => {
  const fs = makeFs({ 'test/a.test.mjs': 'x', 'test/b.test.mjs': 'x', 'src/a.js': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.match(map.text, /TESTS/);
  assert.match(map.text, /test\/.*2/);
});

test('the biggest files are ranked by size, descending, with the path as the tiebreak', () => {
  const fs = makeFs({
    'small.js': { content: 'x', size: 10 },
    'huge.js': { content: 'x', size: 90_000 },
    'mid.js': { content: 'x', size: 5_000 },
    'b-tie.js': { content: 'x', size: 5_000 },
  });
  const map = buildRepoMap('/repo', fs);
  const section = map.text.split('LARGEST')[1].split('\n\n')[0];
  const order = ['huge.js', 'b-tie.js', 'mid.js'].map((p) => section.indexOf(p));
  assert.ok(order[0] < order[1] && order[1] < order[2], `LARGEST is out of order:\n${section}`);
});

test('⭐ recency is an ORDER and never a timestamp — a rendered age changes every run and breaks the cache prefix', () => {
  const fs = makeFs({
    'old.js': { content: 'x', mtimeMs: 1_000 },
    'newest.js': { content: 'x', mtimeMs: 9_000 },
    'mid.js': { content: 'x', mtimeMs: 5_000 },
  });
  const map = buildRepoMap('/repo', fs);
  const section = map.text.split('RECENTLY CHANGED')[1].split('\n\n')[0];
  assert.ok(section.indexOf('newest.js') < section.indexOf('mid.js'));
  assert.ok(section.indexOf('mid.js') < section.indexOf('old.js'));
  for (const stamp of ['9000', '5000', '1000', 'ago', 'GMT', ':']) {
    assert.ok(!section.includes(stamp), `a timestamp (${stamp}) leaked into the map and will change the prefix every run`);
  }
});

test('recency ties break on path so the order can never depend on walk order', () => {
  const fs = makeFs({ 'b.js': { content: 'x', mtimeMs: 7 }, 'a.js': { content: 'x', mtimeMs: 7 } });
  const map = buildRepoMap('/repo', fs);
  const section = map.text.split('RECENTLY CHANGED')[1];
  assert.ok(section.indexOf('a.js') < section.indexOf('b.js'));
});

test('the signal sections are omitted entirely rather than printed empty', () => {
  const fs = makeFs({ 'a.js': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.ok(!map.text.includes('ENTRY POINTS'), 'printed an ENTRY POINTS heading with nothing under it');
  assert.ok(!map.text.includes('TESTS'));
});

// ── 8. THE BUDGET AND HONEST TRUNCATION ─────────────────────────────────────

test('a repo that fits is reported COMPLETE and truncated is false', () => {
  const fs = makeFs({ 'a.js': 'x', 'b/c.js': 'x' });
  const map = buildRepoMap('/repo', fs, { budgetTokens: 4000 });
  assert.equal(map.truncated, false);
  assert.match(map.text, /COMPLETE/);
  assert.ok(!/INCOMPLETE/.test(map.text));
});

test('a tight budget truncates, says so loudly, and gives the exact numbers', () => {
  const files = {};
  for (let i = 0; i < 400; i++) files[`src/module${String(i).padStart(3, '0')}/index.js`] = 'x';
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 200 });
  assert.equal(map.truncated, true);
  assert.match(map.text, /INCOMPLETE/);
  assert.ok(map.stats.listedFiles < 400 && map.stats.listedFiles > 0);
  assert.equal(map.stats.omittedFiles, 400 - map.stats.listedFiles);
  assert.ok(map.text.includes(String(map.stats.totalFiles)), 'the total is not stated, so "some were omitted" is unactionable');
});

test('⚠️ a truncated map NEVER claims completeness', () => {
  const files = {};
  for (let i = 0; i < 300; i++) files[`f${i}.js`] = 'x';
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 120 });
  assert.equal(map.truncated, true);
  assert.ok(!/\bCOMPLETE\b(?!LY)/.test(map.text.replace(/INCOMPLETE/g, '')), 'the word COMPLETE survives in a truncated map');
});

test('⭐ truncation says WHERE the gaps are, per directory — a bare count is unactionable', () => {
  const files = { 'src/main.js': 'x' };
  for (let i = 0; i < 300; i++) files[`vendor/lib${String(i).padStart(3, '0')}.js`] = 'x';
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 150 });
  assert.equal(map.truncated, true);
  assert.match(map.text, /vendor\//);
  assert.ok(/vendor\/[^\n]*\d/.test(map.text), 'no per-directory omission count — the model cannot tell where it is blind');
});

test('the estimate stays inside the budget it was given', () => {
  const files = {};
  for (let i = 0; i < 2000; i++) files[`src/deep/path/to/module${i}/index.js`] = 'x';
  for (const budget of [100, 400, 1500]) {
    const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: budget });
    assert.ok(map.stats.tokensEstimated <= budget * 1.25,
      `budget ${budget} produced ${map.stats.tokensEstimated} estimated tokens`);
  }
});

test('a truncated map still tells the model how to reach what is missing', () => {
  const files = {};
  for (let i = 0; i < 300; i++) files[`f${i}.js`] = 'x';
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 120 });
  assert.match(map.text, /find_files|search_text/, 'the map admits a gap and offers no way to close it');
});

test('the budget favours source over assets — the file the model needs is a .ts, not a .png', () => {
  const files = { 'src/target.ts': 'x' };
  for (let i = 0; i < 200; i++) files[`assets/img${String(i).padStart(3, '0')}.png`] = 'x';
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 120 });
  assert.ok(listedPaths(map).includes('src/target.ts'),
    'the one source file was crowded out by two hundred images — that is the defect this module exists to fix');
});

test('the budget favours shallow over deep, so the shape of the project survives a tight budget', () => {
  const files = { 'index.js': 'x' };
  for (let i = 0; i < 200; i++) files[`a/b/c/d/e/deep${String(i).padStart(3, '0')}.js`] = 'x';
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 100 });
  assert.ok(listedPaths(map).includes('index.js'));
});

test('DEFAULT_BUDGET_TOKENS is a real number and is what an omitted option uses', () => {
  assert.ok(Number.isInteger(DEFAULT_BUDGET_TOKENS) && DEFAULT_BUDGET_TOKENS > 500);
  const fs = makeFs({ 'a.js': 'x' });
  assert.equal(buildRepoMap('/repo', fs).stats.budgetTokens, DEFAULT_BUDGET_TOKENS);
});

// ── 9. FAILURE AND EDGE SHAPES ──────────────────────────────────────────────

test('an unreadable root is a refusal with an empty text, never a throw', () => {
  const map = buildRepoMap('/nope', {
    existsImpl: () => false,
    readdirImpl: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    statImpl: () => null,
    readFileImpl: () => null,
  });
  assert.equal(map.ok, false);
  assert.equal(map.text, '');
  assert.match(map.error, /EACCES|could not|permission/i);
  assert.deepEqual(map.files, []);
});

test('an empty repo says it is empty rather than printing a headless map', () => {
  const map = buildRepoMap('/repo', makeFs({}));
  assert.equal(map.ok, true);
  assert.match(map.text, /empty/i);
  assert.equal(map.stats.totalFiles, 0);
  assert.equal(map.truncated, false);
});

test('an unreadable SUBDIRECTORY is skipped and counted, and does not abort the walk', () => {
  const fs = makeFs({ 'a.js': 'x', 'locked/inner.js': 'x', 'z.js': 'x' });
  const guarded = {
    ...fs,
    readdirImpl: (rel) => {
      if (rel === 'locked') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return fs.readdirImpl(rel);
    },
  };
  const map = buildRepoMap('/repo', guarded);
  assert.equal(map.ok, true);
  assert.deepEqual(listedPaths(map), ['a.js', 'z.js']);
  assert.ok(map.stats.unreadableDirs >= 1);
});

test('a symlink (or any non-file, non-dir entry) is skipped — no walk can loop', () => {
  const fs = makeFs({ 'a.js': 'x' });
  const withLink = {
    ...fs,
    readdirImpl: (rel) => (rel === '' ? [...fs.readdirImpl(rel), { name: 'loop', type: 'other' }] : fs.readdirImpl(rel)),
  };
  const map = buildRepoMap('/repo', withLink);
  assert.deepEqual(listedPaths(map), ['a.js']);
  assert.ok(!map.text.includes('loop/'));
});

test('the entry cap bounds a pathological tree, and the cap is reported', () => {
  const files = {};
  for (let i = 0; i < 500; i++) files[`f${i}.js`] = 'x';
  const map = buildRepoMap('/repo', makeFs(files), { maxEntries: 50, budgetTokens: 100_000 });
  assert.ok(map.stats.walkCapped === true);
  assert.ok(map.stats.totalFiles <= 51, `walk cap ignored: saw ${map.stats.totalFiles}`);
  assert.match(map.text, /INCOMPLETE/);
});

test('the depth cap stops an infinitely deep tree without hanging', () => {
  const deep = {
    existsImpl: () => true,
    statImpl: () => ({ size: 1, mtimeMs: 0, dir: false }),
    readFileImpl: () => null,
    // every directory contains one more directory, forever
    readdirImpl: () => [{ name: 'down', type: 'dir' }, { name: 'leaf.js', type: 'file' }],
  };
  const map = buildRepoMap('/repo', deep, { maxEntries: 500 });
  assert.equal(map.ok, true);
  assert.ok(map.stats.maxDepthReached <= 32);
});

test('a file whose stat fails is still listed by path — the path is the product', () => {
  const fs = makeFs({ 'a.js': 'x', 'b.js': 'x' });
  const map = buildRepoMap('/repo', { ...fs, statImpl: (rel) => (rel === 'b.js' ? null : fs.statImpl(rel)) });
  assert.deepEqual(listedPaths(map), ['a.js', 'b.js']);
});

// ── 10. THE WIRING SEAM ─────────────────────────────────────────────────────

test('repoMapForExecutor returns a string for a real root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-repomap-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'export function hello() {}\n', 'utf8');
    writeFileSync(join(dir, 'package.json'), '{"name":"t","bin":"./src/a.mjs"}', 'utf8');
    const text = repoMapForExecutor({ root: dir });
    assert.match(text, /src\/a\.mjs/);
    assert.match(text, /hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ repoMapForExecutor returns EMPTY STRING for an executor with no root — never throws into the turn', () => {
  assert.equal(repoMapForExecutor(undefined), '');
  assert.equal(repoMapForExecutor({}), '');
  assert.equal(repoMapForExecutor({ root: null }), '');
  assert.equal(repoMapForExecutor({ root: join(tmpdir(), 'definitely-not-here-acuvo-xyz') }), '');
});

test('the real default impls walk a real directory — the fakes are not testing themselves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-repomap-real-'));
  try {
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(dir, 'lib', 'deep', 'deeper'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'x', 'utf8');
    writeFileSync(join(dir, 'lib', 'deep', 'deeper', 'found.mjs'), 'export const FOUND = 1;\n', 'utf8');
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n', 'utf8');
    writeFileSync(join(dir, 'ignored.txt'), 'x', 'utf8');
    const map = buildRepoMap(dir);
    assert.equal(map.ok, true);
    const paths = listedPaths(map);
    assert.ok(paths.includes('lib/deep/deeper/found.mjs'), `real walk missed the deep file: ${paths.join(', ')}`);
    assert.ok(!paths.some((p) => p.startsWith('node_modules')));
    assert.ok(!paths.includes('ignored.txt'), 'the real walk ignored .gitignore');
    assert.match(map.text, /FOUND/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ the map of THIS repo beats the old two-level pre-read on coverage, at a fraction of the tokens', () => {
  const map = buildRepoMap(REPO_ROOT, {}, { budgetTokens: 4000 });
  assert.equal(map.ok, true);
  // The old pre-read showed at most 12 file BODIES; this shows every path.
  assert.ok(map.stats.listedFiles > 60, `only ${map.stats.listedFiles} paths listed for this repo`);
  assert.ok(map.stats.tokensEstimated <= 5000, `${map.stats.tokensEstimated} tokens is not cheap`);
  assert.ok(map.text.includes('lib/turn.mjs'));
  assert.ok(map.text.includes('lib/repo-map.mjs'));
  assert.ok(!map.text.includes('node_modules/'));
});

/**
 * ── 10b. THE FOUR TESTS THAT WERE MISSING, FOUND BY MUTATION ────────────────
 *
 * ⚠️ EVERY ONE OF THESE EXISTS BECAUSE A DELIBERATE BREAK SURVIVED THE SUITE
 * ABOVE. 38 mutations were applied to lib/repo-map.mjs one at a time; 29 were
 * caught, five were behaviourally equivalent (a second guard already covered
 * them), and these four were REAL HOLES — the code was right, the check was
 * not, and a later edit could have silently undone the property.
 *
 * ⭐ Two of them passed FOR THE WRONG REASON, which is the dangerous shape.
 * The `.env` test above passes because git.mjs happens to call `.env` a
 * credential, not because hidden files are withheld. The markdown test above
 * passes because its fixture had a `#` in front of the word `export`, not
 * because the extension gate exists. Both would have kept passing with the
 * property deleted.
 */

test('⚠️ under the ENTRY CAP the same tree yields the same files — walk order must not decide who the model sees', () => {
  const files = {};
  for (let i = 0; i < 60; i++) files[`f${String(i).padStart(2, '0')}.js`] = 'x';
  const sorted = buildRepoMap('/repo', makeFs(files, { order: 'sorted' }), { maxEntries: 20, budgetTokens: 100_000 });
  const reversed = buildRepoMap('/repo', makeFs(files, { order: 'reverse' }), { maxEntries: 20, budgetTokens: 100_000 });
  assert.equal(sorted.text, reversed.text,
    'the entry cap cut a DIFFERENT set of files depending on readdir order — determinism survives only while nothing is capped, which is backwards');
  assert.ok(listedPaths(sorted).includes('f00.js'),
    'the cap kept the tail of the directory rather than the head, so the sort happened after the damage');
});

test('⚠️ a hidden file git.mjs does NOT call a credential is still withheld — the allowlist is the whole defence', () => {
  const fs = makeFs({
    '.netrc': 'machine example.com login bob password hunter2',
    '.myrc': 'token=abc123',
    'src/a.js': 'x',
  });
  const map = buildRepoMap('/repo', fs);
  assert.deepEqual(listedPaths(map), ['src/a.js']);
  assert.ok(!map.text.includes('.netrc'), '.netrc is not on git.mjs\'s list, so ONLY the hidden-file rule stops it');
  assert.ok(!map.text.includes('.myrc'));
  assert.ok(!map.text.includes('hunter2'));
  assert.equal(map.stats.hidden, 2);
});

test('⚠️ A CHECK THAT FAILS CORRECT WORK: the hidden allowlist still lets .gitignore through', () => {
  const fs = makeFs({ '.gitignore': 'nothing\n', '.editorconfig': 'root = true', 'src/a.js': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.ok(listedPaths(map).includes('.gitignore'),
    'the model is routinely asked to add a line to .gitignore, and a file it cannot see is one it recreates from scratch');
  assert.ok(listedPaths(map).includes('.editorconfig'));
});

test('⚠️ real export syntax inside a MARKDOWN file yields nothing — the extension gate is the check, not the regex', () => {
  const md = ['# Docs', '', '```js', 'export function fake() {}', 'export const FAKE_TOKEN = 1;', '```'].join('\n');
  assert.deepEqual(extractExports('README.md', md), [],
    'a documented example became a symbol, and the model will go looking for a function that does not exist');
  assert.deepEqual(extractExports('notes.txt', 'export class Ghost {}'), []);
  assert.deepEqual(extractExports('config.json', 'export const x = 1;'), []);
  const map = buildRepoMap('/repo', makeFs({ 'README.md': md }));
  assert.ok(!map.text.includes('fake'));
  assert.ok(!map.text.includes('FAKE_TOKEN'));
});

test('⭐ a directory with NOTHING listed is still NAMED with its count — otherwise the blind spot is invisible', () => {
  const files = { 'src/main.js': 'x' };
  for (let i = 0; i < 40; i++) files[`vendor/pkg${String(i).padStart(2, '0')}/asset.png`] = 'x';
  const map = buildRepoMap('/repo', makeFs(files), { budgetTokens: 80 });
  assert.equal(map.truncated, true);
  assert.deepEqual(listedPaths(map), ['src/main.js'],
    'fixture drift: this test only proves anything while every vendor file is omitted');
  assert.match(map.text, /vendor\/ {2}40 files/,
    'a directory with zero listed files vanished from the map, so the model has no idea it exists at all');
});

/**
 * ── 10c. THE TWO LEVERS, AND THE ORDER BETWEEN THEM ─────────────────────────
 *
 * ⚠️ FOUND BY LOOKING AT THE OUTPUT, NOT BY A FAILING TEST. Rendered against a
 * real 2,246-file repo the first version listed only 140 paths at a 3,000-token
 * budget, because an annotated line averages 93 characters against 28 for a
 * bare path. It was buying 77 symbol lists at the price of 230 PATHS — which
 * inverts the entire thesis of the module. Coverage is the product.
 */

test('⭐ symbols are surrendered BEFORE paths — coverage is the product, a symbol list is only the bonus', () => {
  const files = {};
  for (let i = 0; i < 120; i++) {
    files[`lib/mod${String(i).padStart(3, '0')}.mjs`] = 'export function alpha() {}\nexport const BETA = 1;\nexport class Gamma {}\n';
  }
  const roomy = buildRepoMap('/repo', makeFs(files), { budgetTokens: 4000 });
  const tight = buildRepoMap('/repo', makeFs(files), { budgetTokens: 600 });

  assert.equal(roomy.stats.listedFiles, 120);
  assert.ok(roomy.stats.symbolsShown > 100, 'a roomy budget should keep the symbols it can afford');

  assert.ok(tight.stats.symbolsShown < roomy.stats.symbolsShown, 'the tight budget kept as many symbol lists as the roomy one');
  assert.ok(tight.stats.listedFiles >= 90,
    `only ${tight.stats.listedFiles} paths survived a tight budget — symbol lists ate the tokens that should have bought coverage`);
  assert.ok(tight.stats.tokensEstimated <= 600);
});

test('a bare path in a budget-trimmed map does NOT mean the file exports nothing — files keeps what text dropped', () => {
  const files = {};
  for (let i = 0; i < 120; i++) files[`lib/mod${String(i).padStart(3, '0')}.mjs`] = 'export const ALPHA = 1;\n';
  const tight = buildRepoMap('/repo', makeFs(files), { budgetTokens: 600 });
  const sample = tight.files.find((f) => f.path === 'lib/mod000.mjs');
  assert.deepEqual(sample.symbols, ['ALPHA'], 'the structured result lost data to a rendering decision');
  assert.ok(tight.stats.symbolsShown < tight.stats.listedFiles, 'fixture drift: this budget was not tight enough to drop any symbols');
});

test('symbolsShown counts the symbol lists actually RENDERED, not the files scanned', () => {
  const fs = makeFs({ 'a.mjs': 'export const A = 1;', 'b.mjs': 'console.log(1);', 'c.txt': 'x' });
  const map = buildRepoMap('/repo', fs);
  assert.equal(map.stats.symbolsShown, 1,
    'it counted files rather than symbol lists — the one number that reconciles `text` with `files` has to be exact, or it is worse than absent');
});

// ── 11. THE MODULE'S OWN DISCIPLINE ─────────────────────────────────────────

test('⚠️ the module contains no Date.now() and no Math.random() — untestable time is why bugs here stay invisible', () => {
  const src = readFileSync(join(REPO_ROOT, 'lib', 'repo-map.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/Date\.now\(\)/.test(code), 'Date.now() in the logic');
  assert.ok(!/Math\.random\(\)/.test(code), 'Math.random() in the logic');
});

test('⚠️ zero dependencies — node: built-ins only', () => {
  const src = readFileSync(join(REPO_ROOT, 'lib', 'repo-map.mjs'), 'utf8');
  const imports = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(spec.startsWith('node:') || spec.startsWith('./'), `non-builtin import: ${spec}`);
  }
});
