/**
 * ── ⭐⭐ THE BENCH IS GRADED BEFORE IT EVER GRADES A MODEL ────────────────────
 *
 * `bench/hard-tasks-v2.mjs` costs money to run and a model to run it, so nothing
 * in it can be trusted on inspection. This file proves the checks offline, for
 * $0 and with no network, by handing each task two solutions written by hand:
 *
 *   · the CORRECT one — every check must return null. A guard that fails correct
 *     work is worse than no guard, and this repo has shipped that defect four
 *     times in one day. Half of every assertion below is the happy path.
 *   · a PLAUSIBLE WRONG one — the answer a fast, competent agent actually
 *     produces. Not an empty workspace: a workspace where the requested change
 *     was made, the visible test is green, and something else is quietly broken.
 *     At least one check must fire, and it must be the check that NAMES the
 *     mistake, so a bench failure reads as a diagnosis instead of a shrug.
 *
 * ⚠️⚠️ THE FINDING THAT JUSTIFIES THE WHOLE FILE: for `renamewide`, the naive
 * `s/getUser/loadUser/g` LEAVES THE SUITE GREEN. Every one of the fixture's five
 * tests passes, because the sed renamed the assertions in the test file too. If
 * the only check were "the tests pass", the bench would certify a rename that
 * broke a public method, a member name and a wire-format event string. The four
 * trap checks are the entire value of that task and they are asserted below.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

/**
 * ⚠️ DYNAMIC IMPORT, AND THE STATIC VERSION IS A KNOWN SHIPPING BUG. package.json
 * ships `test/` but NOT `bench/`, so a static import of a bench file throws at
 * MODULE LOAD in a clean install and node --test reports the whole file as one
 * failure on a perfectly healthy build. Same pattern as
 * test/bench-reads-the-document.test.mjs.
 */
const BENCH_DIR = new URL('../bench/', import.meta.url);
const MOD = new URL('../bench/hard-tasks-v2.mjs', import.meta.url);
const load = async () => (await import(MOD.href)).HARD_TASKS_V2;

/** The runner passes a result object; nothing in this corpus reads it. */
const RES = { note: '', out: '', refusals: [], cost: 0, rounds: 0, verified: true };

const byId = (tasks, id) => {
  const t = tasks.find((x) => x.id === id);
  assert.ok(t, `task ${id} vanished from the corpus`);
  return t;
};

/** Lay a fixture down, then apply a patch: a string replaces, `null` deletes. */
function lay(task, patch = {}) {
  const ws = mkdtempSync(join(tmpdir(), `hardv2-${task.id}-`));
  const files = { ...task.setup.files, ...patch };
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;
    const abs = join(ws, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return ws;
}

/** Every failure string the task's checks produce, in order. */
function grade(task, ws) {
  const out = [];
  for (const check of task.checks) {
    let verdict;
    try { verdict = check(ws, RES); } catch (err) { verdict = `the check itself threw: ${err?.message ?? err}`; }
    if (verdict) out.push(verdict);
  }
  return out;
}

/**
 * The two assertions every task gets. `expect` is a regex that must match one of
 * the failures on the wrong solution — a bench that fires the WRONG check is
 * only accidentally right.
 */
function bothWays(task, { correct, wrong, expect, wrongName }) {
  const good = lay(task, correct);
  const goodFailures = grade(task, good);
  rmSync(good, { recursive: true, force: true });
  assert.deepStrictEqual(
    goodFailures, [],
    `${task.id}: the CORRECT solution was marked wrong by ${goodFailures.length} check(s) — a guard that fails correct work is worse than no guard`,
  );

  const bad = lay(task, wrong);
  const badFailures = grade(task, bad);
  rmSync(bad, { recursive: true, force: true });
  assert.ok(badFailures.length > 0, `${task.id}: "${wrongName}" passed every check — the bench certifies the wrong answer`);
  assert.ok(
    badFailures.some((f) => expect.test(f)),
    `${task.id}: "${wrongName}" was caught, but by nothing that names it. Failures were: ${badFailures.join(' | ')}`,
  );
  return badFailures;
}

// ═══════════════════════════════════════════════════════════════════════════

test('⭐⭐ renamewide — a correct rename passes, and a naive sed is caught by four traps', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'renamewide');
  const files = task.setup.files;

  // The correct rename: only the files where `getUser` IS the symbol move.
  const movers = Object.keys(files).filter((f) => f === 'src/store.mjs' || f === 'src/index.mjs' || f.startsWith('src/consumers/'));
  const correct = Object.fromEntries(movers.map((f) => [f, files[f].replace(/\bgetUser\b/g, 'loadUser')]));

  /**
   * ⚠️ THE PLAUSIBLE WRONG ANSWER, and it is one command: replace the substring
   * everywhere. It is what a shell-minded agent reaches for first and it is
   * indistinguishable from the right answer until you look at four other files.
   */
  const naive = Object.fromEntries(Object.entries(files)
    .filter(([f]) => f !== 'package.json')
    .map(([f, body]) => [f, body.replace(/getUser/g, 'loadUser')]));

  const failures = bothWays(task, {
    correct,
    wrong: naive,
    wrongName: 'sed s/getUser/loadUser/g across every file',
    expect: /wire format|STRING LITERAL/i,
  });

  // The four traps, each named separately — this is the evidence that the task
  // measures what it claims to.
  for (const [what, pattern] of [
    ['the substring collision', /SUBSTRING COLLISION/],
    ['the same-named method', /LegacyClient/],
    ['the member name', /MOCK\.getUser/],
    ['the wire-format string', /wire format/],
    ['the edited test file', /IT EDITED/],
  ]) {
    assert.ok(failures.some((f) => pattern.test(f)), `${what} was not caught by the naive sed. Failures: ${failures.join(' | ')}`);
  }

  /**
   * ⚠️⚠️ AND THIS IS THE POINT. Under the naive sed the FIXTURE'S OWN SUITE IS
   * GREEN — the sed renamed the assertions too. Asserting it explicitly stops
   * anyone "simplifying" this task down to `node --test`.
   */
  const ws = lay(task, naive);
  const suiteOnly = grade(task, ws)[0];
  rmSync(ws, { recursive: true, force: true });
  assert.ok(
    !/the suite does not pass/.test(suiteOnly ?? ''),
    'the naive sed was expected to leave the suite GREEN — if it now fails the suite, the trap checks are no longer load-bearing and this comment is a lie',
  );
});

test('renamewide — a rename that misses ONE of eighteen files is caught', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'renamewide');
  const files = task.setup.files;
  const movers = Object.keys(files).filter((f) => f === 'src/store.mjs' || f === 'src/index.mjs' || f.startsWith('src/consumers/'));
  // Everything renamed except the namespace-import consumer — the one file where
  // the reference does not look like a bare identifier at the import line.
  const partial = Object.fromEntries(movers
    .filter((f) => f !== 'src/consumers/hotel.mjs')
    .map((f) => [f, files[f].replace(/\bgetUser\b/g, 'loadUser')]));
  const ws = lay(task, partial);
  const failures = grade(task, ws);
  rmSync(ws, { recursive: true, force: true });
  assert.ok(failures.some((f) => /the rename was partial/.test(f)), `a partial rename was not named. Failures: ${failures.join(' | ')}`);
  assert.ok(failures.some((f) => /the suite does not pass/.test(f)), 'a partial rename must also break the suite');
});

test('⭐⭐ twohops — fixing the cause passes, patching the symptom does not', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'twohops');

  const failures = bothWays(task, {
    correct: {
      'src/window.mjs': 'export function lastN(items, n) {\n  return items.slice(Math.max(0, items.length - n));\n}\n',
    },
    /**
     * ⚠️ THE SYMPTOM FIX: pass n + 1 from the middle file. The failing test goes
     * green, `lastN` stays broken for every other caller, and the diff looks
     * like a one-character bug fix.
     */
    wrong: {
      'src/aggregate.mjs':
        "import { lastN } from './window.mjs';\n\n"
        + 'export function sumRecent(values, n) {\n'
        + '  return lastN(values, n + 1).reduce((a, b) => a + b, 0);\n'
        + '}\n',
    },
    wrongName: 'compensating in aggregate.mjs with n + 1',
    expect: /the fix was applied at the symptom, not the cause/,
  });

  // ⭐ The symptom fix leaves the visible test GREEN — same lesson as renamewide.
  assert.ok(!failures.some((f) => /the test still fails/.test(f)), 'the n+1 patch was expected to make the visible test pass');
});

test('twohops — hardcoding the expected total is caught twice', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'twohops');
  const ws = lay(task, {
    'src/report.mjs':
      "import { sumRecent } from './aggregate.mjs';\n\n"
      + 'export function summary(values) {\n'
      + '  return { recentTotal: 12 };\n'
      + '}\n',
  });
  const failures = grade(task, ws);
  rmSync(ws, { recursive: true, force: true });
  assert.ok(failures.some((f) => /hardcoded the expected total/.test(f)), `the hardcode was not named. Failures: ${failures.join(' | ')}`);
  assert.ok(failures.some((f) => /does not generalise/.test(f)), 'the generalisation probe should also have fired');
});

test('twohops — editing the failing test is caught', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'twohops');
  const ws = lay(task, {
    'src/report.test.mjs': task.setup.files['src/report.test.mjs'].replace('recentTotal, 12', 'recentTotal, 9'),
  });
  const failures = grade(task, ws);
  rmSync(ws, { recursive: true, force: true });
  assert.ok(failures.some((f) => /IT EDITED src\/report\.test\.mjs/.test(f)), `editing the test was not named. Failures: ${failures.join(' | ')}`);
});

// ── wiring ─────────────────────────────────────────────────────────────────

const CSV_MODULE =
  'export function renderCsv(rows) {\n'
  + "  if (rows.length === 0) return '';\n"
  + '  const keys = Object.keys(rows[0]);\n'
  + "  const lines = [keys.join(',')];\n"
  + "  for (const row of rows) lines.push(keys.map((k) => String(row[k])).join(','));\n"
  + "  return lines.join('\\n');\n"
  + '}\n';

const CSV_REGISTRY =
  "import { renderJson } from './json.mjs';\n"
  + "import { renderText } from './text.mjs';\n"
  + "import { renderCsv } from './csv.mjs';\n\n"
  + 'const FORMATS = {\n  json: renderJson,\n  text: renderText,\n  csv: renderCsv,\n};\n\n'
  + 'export function render(format, rows) {\n'
  + '  const fn = FORMATS[format];\n'
  + "  if (!fn) throw new Error('unknown format: ' + format);\n"
  + '  return fn(rows);\n'
  + '}\n\n'
  + 'export function formatNames() {\n'
  + '  return Object.keys(FORMATS);\n'
  + '}\n';

const CSV_TEST =
  "import { test } from 'node:test';\n"
  + "import assert from 'node:assert';\n"
  + "import { render } from './formats/registry.mjs';\n\n"
  + "test('csv renders a header and one line per row', () => {\n"
  + "  const got = render('csv', [{ id: 1, name: 'ada' }, { id: 2, name: 'grace' }]);\n"
  + "  assert.strictEqual(got, 'id,name\\n1,ada\\n2,grace');\n"
  + '});\n\n'
  + "test('an empty array is an empty string', () => {\n"
  + "  assert.strictEqual(render('csv', []), '');\n"
  + '});\n';

test('⭐⭐ wiring — four coordinated edits pass; a CLI special-case does not', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'wiring');

  bothWays(task, {
    correct: {
      'src/formats/csv.mjs': CSV_MODULE,
      'src/formats/registry.mjs': CSV_REGISTRY,
      'src/validate.mjs': "export const ALLOWED = ['json', 'text', 'csv'];\n\nexport function isAllowed(format) {\n  return ALLOWED.includes(format);\n}\n",
      'src/cli.mjs': task.setup.files['src/cli.mjs'].replace("const SUPPORTED = 'json, text';", "const SUPPORTED = 'json, text, csv';"),
      'src/csv.test.mjs': CSV_TEST,
    },
    /**
     * ⚠️ THE PLAUSIBLE WRONG ANSWER: make the CLI do it. The user's sentence is
     * satisfied end to end — `run(['--format','csv'], rows)` returns exactly the
     * right CSV — and every other consumer of the registry still has no idea the
     * format exists. This is the one a hasty agent actually writes.
     */
    wrong: {
      'src/cli.mjs':
        "import { render } from './formats/registry.mjs';\n"
        + "import { isAllowed } from './validate.mjs';\n\n"
        + "const SUPPORTED = 'json, text, csv';\n\n"
        + 'function toCsv(rows) {\n'
        + "  if (rows.length === 0) return '';\n"
        + '  const keys = Object.keys(rows[0]);\n'
        + "  return [keys.join(','), ...rows.map((r) => keys.map((k) => String(r[k])).join(','))].join('\\n');\n"
        + '}\n\n'
        + 'export function run(argv, rows) {\n'
        + "  const i = argv.indexOf('--format');\n"
        + "  const format = i === -1 ? 'text' : argv[i + 1];\n"
        + "  if (format === 'csv') return toCsv(rows);\n"
        + '  if (!isAllowed(format)) {\n'
        + '    return \'error: unsupported format "\' + format + \'" (supported: \' + SUPPORTED + \')\';\n'
        + '  }\n'
        + '  return render(format, rows);\n'
        + '}\n',
      'src/csv.test.mjs':
        "import { test } from 'node:test';\n"
        + "import assert from 'node:assert';\n"
        + "import { run } from './cli.mjs';\n\n"
        + "test('csv via the cli', () => {\n"
        + "  assert.strictEqual(run(['--format', 'csv'], [{ id: 1, name: 'ada' }, { id: 2, name: 'grace' }]), 'id,name\\n1,ada\\n2,grace');\n"
        + '});\n',
    },
    wrongName: 'special-casing csv inside cli.run()',
    expect: /not REGISTERED|no src\/formats\/csv\.mjs/,
  });
});

test('wiring — registering csv but forgetting the usage line turns the EXISTING suite red', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'wiring');
  const ws = lay(task, {
    'src/formats/csv.mjs': CSV_MODULE,
    'src/formats/registry.mjs': CSV_REGISTRY,
    'src/validate.mjs': "export const ALLOWED = ['json', 'text', 'csv'];\n\nexport function isAllowed(format) {\n  return ALLOWED.includes(format);\n}\n",
    'src/csv.test.mjs': CSV_TEST,
    // cli.mjs deliberately untouched — three lists, only two updated.
  });
  const failures = grade(task, ws);
  rmSync(ws, { recursive: true, force: true });
  assert.ok(
    failures.some((f) => /the three format lists no longer agree/.test(f)),
    `the missed usage line was not caught. Failures: ${failures.join(' | ')}`,
  );
});

test('wiring — a validator that accepts anything is caught', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'wiring');
  const ws = lay(task, {
    'src/formats/csv.mjs': CSV_MODULE,
    'src/formats/registry.mjs': CSV_REGISTRY,
    'src/validate.mjs': 'export const ALLOWED = null;\n\nexport function isAllowed() {\n  return true;\n}\n',
    'src/cli.mjs': task.setup.files['src/cli.mjs'].replace("const SUPPORTED = 'json, text';", "const SUPPORTED = 'json, text, csv';"),
    'src/csv.test.mjs': CSV_TEST,
  });
  const failures = grade(task, ws);
  rmSync(ws, { recursive: true, force: true });
  assert.ok(failures.some((f) => /accepts ANYTHING/.test(f)), `the open validator was not named. Failures: ${failures.join(' | ')}`);
});

test('⭐⭐ reconcile — fixing the caller passes; fixing the shared helper breaks email subjects', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'reconcile');

  bothWays(task, {
    correct: {
      'src/preview.mjs':
        "import { truncate } from './truncate.mjs';\n\n"
        + 'const LIMIT = 18;\n\n'
        + 'export function preview(s) {\n'
        + '  if (s.length <= LIMIT) return s;\n'
        + '  const cut = s.slice(0, LIMIT);\n'
        + "  const at = cut.lastIndexOf(' ');\n"
        + "  return at === -1 ? truncate(s, LIMIT) : s.slice(0, at) + '…';\n"
        + '}\n',
    },
    /**
     * ⚠️ THE PLAUSIBLE WRONG ANSWER, and it is the SMALLER diff: teach the
     * shared helper to break on whitespace. preview.test.mjs goes green, and
     * every email subject in the product silently changes shape.
     */
    wrong: {
      'src/truncate.mjs':
        'export function truncate(s, n) {\n'
        + '  if (s.length <= n) return s;\n'
        + '  const cut = s.slice(0, n);\n'
        + "  const at = cut.lastIndexOf(' ');\n"
        + "  return (at === -1 ? cut : s.slice(0, at)) + '…';\n"
        + '}\n',
    },
    wrongName: 'making the shared truncate() word-aware',
    expect: /email subjects moved with it/,
  });
});

test('reconcile — an always-ellipsis preview is caught by the happy path', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'reconcile');
  const ws = lay(task, {
    // Word-aware, and correct on the failing case — but it truncates text that
    // was never over the limit. Only a check on text SHORTER than 18 sees it.
    'src/preview.mjs':
      'export function preview(s) {\n'
      + "  const at = s.slice(0, 18).lastIndexOf(' ');\n"
      + "  return (at === -1 ? s.slice(0, 18) : s.slice(0, at)) + '…';\n"
      + '}\n',
  });
  const failures = grade(task, ws);
  rmSync(ws, { recursive: true, force: true });
  assert.ok(failures.length > 0, 'a preview that always adds an ellipsis passed every check');
  assert.ok(failures.some((f) => /preview\(\) is wrong|do not both pass/.test(f)), `caught, but not named. Failures: ${failures.join(' | ')}`);
});

test('⭐⭐ staledoc — trusting the code passes; trusting the doc fails five ways', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'staledoc');

  const failures = bothWays(task, {
    correct: {
      'src/retry.mjs':
        '// Exponential backoff: the delay doubles on every attempt, starting at 100ms.\n'
        + 'const BACKOFF_START_MS = 50;\n'
        + 'const MAX_DELAY_MS = 400;\n\n'
        + 'export const MAX_ATTEMPTS = 3;\n\n'
        + 'export function delayFor(attempt) {\n'
        + '  return Math.min(MAX_DELAY_MS, BACKOFF_START_MS * (attempt + 1));\n'
        + '}\n',
    },
    /**
     * ⚠️ THE PLAUSIBLE WRONG ANSWER IS SPELLED OUT IN THE FIXTURE'S OWN DOCS:
     * a src/config.mjs holding RETRY_BASE_MS = 100 and MAX_RETRIES = 5, and an
     * exponential delayFor. Every line of it is defensible if you read the
     * documentation and the comment and never ran the test.
     */
    wrong: {
      'src/config.mjs': 'export const RETRY_BASE_MS = 100;\nexport const MAX_RETRIES = 5;\n',
      'src/retry.mjs':
        "import { RETRY_BASE_MS, MAX_RETRIES } from './config.mjs';\n\n"
        + 'export const MAX_ATTEMPTS = MAX_RETRIES;\n\n'
        + 'export function delayFor(attempt) {\n'
        + '  return Math.min(400, RETRY_BASE_MS * 2 ** attempt);\n'
        + '}\n',
    },
    wrongName: 'believing docs/RETRIES.md',
    expect: /is fiction|CREATED src\/config\.mjs/,
  });

  for (const [what, pattern] of [
    ['the invented config file', /CREATED src\/config\.mjs/],
    ['the wrong progression', /the progression is wrong/],
    ['the changed attempt count', /MAX_ATTEMPTS = 5/],
    ['the vanished constant', /BACKOFF_START_MS is gone/],
    ['the red suite', /the existing test fails/],
  ]) {
    assert.ok(failures.some((f) => pattern.test(f)), `${what} was not caught. Failures: ${failures.join(' | ')}`);
  }
});

test('staledoc — capping at the wrong value is caught even though the suite stays green', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'staledoc');
  const ws = lay(task, {
    // 50, 100, 150 — the visible test's three values are untouched. The cap is
    // simply wrong, and only the probe past attempt 2 can see it.
    'src/retry.mjs':
      'const BACKOFF_START_MS = 50;\n\n'
      + 'export const MAX_ATTEMPTS = 3;\n\n'
      + 'export function delayFor(attempt) {\n'
      + '  return Math.min(800, BACKOFF_START_MS * (attempt + 1));\n'
      + '}\n',
  });
  const failures = grade(task, ws);
  rmSync(ws, { recursive: true, force: true });
  assert.ok(!failures.some((f) => /the existing test fails/.test(f)), 'the fixture suite was expected to stay green here');
  assert.ok(failures.some((f) => /the progression is wrong/.test(f)), `a 800ms cap slipped through. Failures: ${failures.join(' | ')}`);
});

test('⭐⭐ deadcode — deleting the dead module passes; deleting the least-mentioned one does not', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'deadcode');

  bothWays(task, {
    correct: { 'src/legacy-parser.mjs': null },
    /**
     * ⚠️ THE PLAUSIBLE WRONG ANSWER, and a text search actively recommends it:
     * "dates" appears in ONE line of the repo, "legacy-parser" in three. Ranking
     * files by how often they are mentioned deletes the live one.
     */
    wrong: { 'src/util/dates.mjs': null },
    wrongName: 'deleting util/dates.mjs, the least-mentioned file',
    expect: /it deleted live files: src\/util\/dates\.mjs/,
  });
});

test('deadcode — deleting nothing, and deleting extra, are both caught', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const task = byId(await load(), 'deadcode');

  const untouched = lay(task, {});
  const a = grade(task, untouched);
  rmSync(untouched, { recursive: true, force: true });
  assert.ok(a.some((f) => /the dead module was never found/.test(f)), `doing nothing passed. Failures: ${a.join(' | ')}`);

  // Deleted the right file AND rewrote the barrel it was supposed to leave alone.
  const overreach = lay(task, {
    'src/legacy-parser.mjs': null,
    'src/util/index.mjs': "export { isoDay } from './dates.mjs';\nexport { titleCase } from './strings.mjs';\n",
  });
  const b = grade(task, overreach);
  rmSync(overreach, { recursive: true, force: true });
  assert.ok(b.some((f) => /the barrel it had to understand/.test(f)), `the rewritten barrel was not caught. Failures: ${b.join(' | ')}`);
});

test('every v2 task is mechanically gradable and generously budgeted', async (t) => {
  if (!existsSync(BENCH_DIR)) return t.skip('bench/ is not shipped in the published tarball');
  const tasks = await load();
  assert.strictEqual(tasks.length, 6);
  for (const task of tasks) {
    assert.ok(task.id && task.what && task.prompt, `${task.id}: missing a field the runner prints`);
    assert.ok(task.checks.length >= 5, `${task.id}: ${task.checks.length} checks is thin for a hard task`);
    // ⭐ The hard half exists because the round budgets in the easy half (3–8)
    // cannot fit multi-file work. If one of these drops back into that range,
    // the task stops measuring capability and starts measuring luck.
    assert.ok(task.rounds >= 9, `${task.id}: ${task.rounds} rounds is an easy-half budget`);
    assert.ok(Object.keys(task.setup.files).length >= 4, `${task.id}: fixture is too small to be hard`);
  }
  // No id may collide with the existing corpus — run.mjs selects by id.
  const ids = tasks.map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate task id');
});
