/**
 * ── ⭐⭐ THE HARD HALF, SECOND ROUND — WHERE COMPLEX WORK ACTUALLY BREAKS ─────
 *
 * MEASURED BEFORE WRITING THIS: `bench/tasks.mjs` carries 13 tasks, the largest
 * fixture in the whole corpus is SIX files, and the round budgets run 3–8. Flash
 * scores 12/13 on it. That number is real but it is a number about EASY work —
 * we have no evidence at all about anything larger, and "we cannot improve
 * complex coding" is the direct consequence of never having measured it.
 *
 * ⭐ WHAT MAKES A TASK HARD HERE. Not length, and not obscure APIs. Every task
 * below fails for a reason that only exists when several files are true at once:
 *
 *   renamewide  a rename across 18 files where `sed` breaks four things
 *   twohops     the symptom is in file A, the cause is in file C, via B
 *   wiring      one feature, four modules that must agree, plus a new test
 *   reconcile   the obvious fix turns a DIFFERENT passing test red
 *   staledoc    the doc and the comment both lie; the code is the truth
 *   deadcode    the dead module is the most-mentioned one in the repo
 *
 * ⚠️ MECHANICAL GRADING ONLY — see the header of `bench/run.mjs`. No model
 * judges anything here. Every check is a pure function of the files on disk:
 * an exact string, an exact file list, or a `node -e` probe that imports the
 * generated module and asks it a question the visible test never asked. A bench
 * whose grader can be wrong tells you nothing about the thing it grades.
 *
 * ⚠️ AND EVERY TASK CARRIES AT LEAST ONE CHECK AIMED AT A PLAUSIBLE WRONG
 * ANSWER, not merely at an absent one. "The file exists" is satisfied by
 * garbage; "the tests pass" is satisfied by editing the test. The interesting
 * failures all LOOK like successes, so each task names the specific wrong answer
 * a competent-but-hasty agent would produce and has a check that fires on it:
 *
 *   renamewide  sed'ing `getUser` → `loadUser` (kills getUserRole, MOCK.getUser,
 *               the LegacyClient method and an analytics STRING)
 *   twohops     patching the middle file with `n + 1` — visible test goes green,
 *               the broken function stays broken for everyone else
 *   wiring      special-casing 'csv' inside cli.run() without registering it
 *   reconcile   fixing the SHARED helper, which silently changes email subjects
 *   staledoc    believing the doc: exponential from 100ms, and a src/config.mjs
 *               that never existed
 *   deadcode    deleting util/dates.mjs, which grep says nobody mentions
 *
 * ── HOW THE LEAD WIRES THIS IN (one line, in bench/tasks.mjs) ────────────────
 *     import { HARD_TASKS_V2 } from './hard-tasks-v2.mjs'; TASKS.push(...HARD_TASKS_V2);
 *
 * The export shape is exactly `HARD_TASKS` in `hard-tasks.mjs`: an array of
 * { id, what, rounds, setup: { files }, prompt, checks: [(ws, res) => null|string] }.
 * Nothing here reads `res` — grading is file-pure, which is also why the whole
 * corpus can be self-checked offline for $0 (see test/hard-bench-v2.test.mjs).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * ⚠️ NORMALISED ON THE WAY IN. A guard that fails correct work is worse than no
 * guard: a BOM is what a Windows editor writes and CRLF is what Windows git
 * checks out, and neither is a cheat. Every content check below reads through
 * this, so `\r\n` can never be mistaken for a changed file.
 */
const norm = (text) => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

const read = (ws, p) => { try { return norm(readFileSync(join(ws, p), 'utf8')); } catch { return ''; } };

/**
 * ⚠️⚠️ A CHECK THAT CANNOT FAIL — MEASURED, NOT THEORISED. Node's test runner
 * exports `NODE_TEST_CONTEXT=child-v8` into everything it spawns, and a nested
 * `node --test` that inherits it switches to the child reporter and **exits 0
 * even when its tests fail**. Proven here: same fixture, same command, exit 1
 * from a shell and exit 0 from inside `node --test`.
 *
 * Every "the suite passes" check in this file is worthless without the delete
 * below — they were all silently green against deliberately broken solutions in
 * the first run of test/hard-bench-v2.test.mjs, which is exactly the class of
 * defect this repo keeps finding: not a wrong answer, an answer that cannot be
 * wrong. bench/run.mjs is a plain script so production runs were never affected,
 * but a check whose correctness depends on who invoked it is not a check.
 */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runs(ws, args) {
  const r = spawnSync(process.execPath, args, { cwd: ws, encoding: 'utf8', timeout: 60_000, env: childEnv() });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** file:// URL for a workspace file, so a probe imports the REAL generated module. */
const url = (ws, rel) => JSON.stringify(`file:///${join(ws, rel).replace(/\\/g, '/')}`);

/**
 * Run a snippet against the generated code; return the thrown message, or null.
 *
 * ⚠️ THE THROWN LINE, NOT THE FIRST LINE CONTAINING "Error". Node echoes the
 * offending source above the stack, and that echo contains `throw new Error(`,
 * so a loose /Error/ match reports the PROBE'S OWN SOURCE CODE back as the
 * diagnosis — 160 characters of `import { MAX_ATTEMPTS } from "file:///…"` in
 * place of "MAX_ATTEMPTS = 5". The bench still failed the right task; it just
 * described it with the one string in the output that carries no information.
 */
function probe(ws, source) {
  const r = runs(ws, ['--input-type=module', '-e', source]);
  if (r.ok) return null;
  const lines = r.out.split('\n');
  const thrown = lines.find((l) => /^\s*(?:Uncaught )?[A-Za-z]*Error: /.test(l));
  const line = thrown ?? lines.find((l) => /Error/.test(l)) ?? lines[0] ?? 'failed';
  return line.trim().replace(/^(?:Uncaught )?[A-Za-z]*Error: /, '').slice(0, 160);
}

/** Every test file this corpus ships is pinned by an exact assertion substring. */
const unchanged = (ws, rel, marker, what) =>
  read(ws, rel).includes(marker) ? null : `IT EDITED ${rel} — ${what} is gone. Making a test agree with the code is not fixing the code.`;

const missing = (ws, rels) => rels.filter((r) => !existsSync(join(ws, r)));

// ═══════════════════════════════════════════════════════════════════════════
// 1 · renamewide — 18 files, and four traps a search-and-replace walks into
// ═══════════════════════════════════════════════════════════════════════════

const CONSUMERS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

/**
 * ⭐ THE CONSUMERS ARE DELIBERATELY NOT UNIFORM. Seven plain named imports are
 * the easy majority; the last three are the ones that separate "understood the
 * reference" from "replaced a substring": a namespace import (`store.getUser`),
 * an aliased import (only the left-hand side moves) and a re-export.
 */
function consumerFile(name, i) {
  if (name === 'hotel') {
    return `import * as store from '../store.mjs';\n\nexport function hotel(id) {\n  return store.getUser(id).name;\n}\n`;
  }
  if (name === 'india') {
    return `import { getUser as fetchOne } from '../store.mjs';\n\nexport function india(id) {\n  return fetchOne(id).name;\n}\n`;
  }
  if (name === 'juliet') {
    return `export { getUser as juliet } from '../store.mjs';\n`;
  }
  return `import { getUser } from '../store.mjs';\n\nexport function ${name}(id) {\n  return getUser(${i}).name;\n}\n`;
}

const RENAME_FILES = {
  'package.json': '{"name":"demo","type":"module","scripts":{"test":"node --test src/index.test.mjs"}}\n',
  'src/store.mjs':
    'export function getUser(id) {\n'
    + '  return { id, name: "user-" + id };\n'
    + '}\n',
  // ⚠️ TRAP 1 — SUBSTRING COLLISION. `getUserRole` contains `getUser`.
  'src/roles.mjs':
    'export function getUserRole(id) {\n'
    + '  return "role-" + id;\n'
    + '}\n',
  // ⚠️ TRAP 2 — A SAME-NAMED METHOD on an unrelated class, part of a public API.
  'src/legacy.mjs':
    'export class LegacyClient {\n'
    + '  getUser(id) {\n'
    + '    return { id, via: "legacy" };\n'
    + '  }\n'
    + '}\n',
  // ⚠️ TRAP 3 — A STRING LITERAL. Wire formats do not rename when code does.
  'src/analytics.mjs':
    'export const EVENT_GET_USER = "getUser";\n\n'
    + 'export function eventFor(action) {\n'
    + '  return "app." + action;\n'
    + '}\n',
  // ⚠️ TRAP 4 — A MEMBER NAME on a test double, pinned by the suite.
  'src/mock.mjs':
    'export const MOCK = {\n'
    + '  getUser: (id) => ({ id, name: "mock-" + id }),\n'
    + '};\n',
  'src/index.mjs':
    "export { getUser } from './store.mjs';\n"
    + CONSUMERS.map((n) => `export { ${n} } from './consumers/${n}.mjs';\n`).join(''),
  /**
   * ⭐ THE SUITE NEVER NAMES THE RENAMED SYMBOL, which is what makes the
   * "did not edit the test" check honest: a correct rename requires ZERO edits
   * here, so any edit at all is either a cheat or collateral damage.
   */
  'src/index.test.mjs':
    "import { test } from 'node:test';\n"
    + "import assert from 'node:assert';\n"
    + `import { ${CONSUMERS.join(', ')} } from './index.mjs';\n`
    + "import { getUserRole } from './roles.mjs';\n"
    + "import { LegacyClient } from './legacy.mjs';\n"
    + "import { EVENT_GET_USER } from './analytics.mjs';\n"
    + "import { MOCK } from './mock.mjs';\n\n"
    + "test('every consumer still resolves a user', () => {\n"
    + CONSUMERS.slice(0, 7).map((n, i) => `  assert.strictEqual(${n}(${i}), 'user-${i}');\n`).join('')
    + "  assert.strictEqual(hotel(7), 'user-7');\n"
    + "  assert.strictEqual(india(8), 'user-8');\n"
    + "  assert.strictEqual(juliet(9).name, 'user-9');\n"
    + '});\n\n'
    + "test('the role helper is a different function', () => {\n"
    + "  assert.strictEqual(getUserRole(7), 'role-7');\n"
    + '});\n\n'
    + "test('the legacy client keeps its method', () => {\n"
    + "  assert.strictEqual(new LegacyClient().getUser(2).via, 'legacy');\n"
    + '});\n\n'
    + "test('the analytics event name is wire format, not code', () => {\n"
    + "  assert.strictEqual(EVENT_GET_USER, 'getUser');\n"
    + '});\n\n'
    + "test('the mock keeps its member name', () => {\n"
    + "  assert.strictEqual(typeof MOCK.getUser, 'function');\n"
    + '});\n',
};
for (const [i, name] of CONSUMERS.entries()) RENAME_FILES[`src/consumers/${name}.mjs`] = consumerFile(name, i);

/** Files whose `getUser` IS the symbol being renamed — none may keep it. */
const RENAME_MOVERS = ['src/store.mjs', 'src/index.mjs', ...CONSUMERS.map((n) => `src/consumers/${n}.mjs`)];

// ═══════════════════════════════════════════════════════════════════════════
// 2 · twohops — the failing test names a file two imports away from the bug
// ═══════════════════════════════════════════════════════════════════════════

const TWOHOPS_FILES = {
  'package.json': '{"name":"demo","type":"module","scripts":{"test":"node --test src/report.test.mjs"}}\n',
  /**
   * ⚠️ THE BUG IS HERE, AND NOTHING THE USER SEES MENTIONS THIS FILE. The
   * off-by-one returns n-1 items. `report.mjs` is where the symptom shows,
   * `aggregate.mjs` is the hop in between, and both look correct in isolation —
   * which is the entire point: reading the failing file cannot solve this.
   */
  'src/window.mjs':
    'export function lastN(items, n) {\n'
    + '  return items.slice(items.length - n + 1);\n'
    + '}\n',
  'src/aggregate.mjs':
    "import { lastN } from './window.mjs';\n\n"
    + 'export function sumRecent(values, n) {\n'
    + '  return lastN(values, n).reduce((a, b) => a + b, 0);\n'
    + '}\n',
  'src/report.mjs':
    "import { sumRecent } from './aggregate.mjs';\n\n"
    + 'export function summary(values) {\n'
    + '  return { recentTotal: sumRecent(values, 3) };\n'
    + '}\n',
  'src/report.test.mjs':
    "import { test } from 'node:test';\n"
    + "import assert from 'node:assert';\n"
    + "import { summary } from './report.mjs';\n\n"
    + "test('the recent total covers the last three values', () => {\n"
    + '  assert.strictEqual(summary([1, 2, 3, 4, 5]).recentTotal, 12);\n'
    + '});\n',
};

// ═══════════════════════════════════════════════════════════════════════════
// 3 · wiring — one feature, four modules that must agree, plus a new test
// ═══════════════════════════════════════════════════════════════════════════

const WIRING_ROWS = "[{ id: 1, name: 'ada' }, { id: 2, name: 'grace' }]";
const WIRING_CSV = 'id,name\n1,ada\n2,grace';

const WIRING_FILES = {
  'package.json': '{"name":"demo","type":"module","scripts":{"test":"node --test src/cli.test.mjs"}}\n',
  'src/formats/json.mjs':
    'export function renderJson(rows) {\n'
    + '  return JSON.stringify(rows);\n'
    + '}\n',
  'src/formats/text.mjs':
    'export function renderText(rows) {\n'
    + "  return rows.map((r) => Object.values(r).join(' ')).join('\\n');\n"
    + '}\n',
  'src/formats/registry.mjs':
    "import { renderJson } from './json.mjs';\n"
    + "import { renderText } from './text.mjs';\n\n"
    + 'const FORMATS = {\n  json: renderJson,\n  text: renderText,\n};\n\n'
    + 'export function render(format, rows) {\n'
    + '  const fn = FORMATS[format];\n'
    + "  if (!fn) throw new Error('unknown format: ' + format);\n"
    + '  return fn(rows);\n'
    + '}\n\n'
    + 'export function formatNames() {\n'
    + '  return Object.keys(FORMATS);\n'
    + '}\n',
  // ⚠️ Kept in sync with the registry BY HAND — the second place to change.
  'src/validate.mjs':
    "export const ALLOWED = ['json', 'text'];\n\n"
    + 'export function isAllowed(format) {\n'
    + '  return ALLOWED.includes(format);\n'
    + '}\n',
  // ⚠️ And the usage line is a third hand-written copy of the same list.
  'src/cli.mjs':
    "import { render } from './formats/registry.mjs';\n"
    + "import { isAllowed } from './validate.mjs';\n\n"
    + "const SUPPORTED = 'json, text';\n\n"
    + 'export function run(argv, rows) {\n'
    + "  const i = argv.indexOf('--format');\n"
    + "  const format = i === -1 ? 'text' : argv[i + 1];\n"
    + '  if (!isAllowed(format)) {\n'
    + '    return \'error: unsupported format "\' + format + \'" (supported: \' + SUPPORTED + \')\';\n'
    + '  }\n'
    + '  return render(format, rows);\n'
    + '}\n',
  /**
   * ⭐ THE EXISTING TEST IS WRITTEN FORMAT-AGNOSTICALLY ON PURPOSE. It asserts
   * the error message lists every name `formatNames()` reports — so registering
   * csv without updating the usage line turns this green test RED, and the agent
   * has to keep three hand-maintained lists agreeing. That is the coordination
   * the task measures, and it is graded by the fixture's own suite.
   */
  'src/cli.test.mjs':
    "import { test } from 'node:test';\n"
    + "import assert from 'node:assert';\n"
    + "import { run } from './cli.mjs';\n"
    + "import { formatNames } from './formats/registry.mjs';\n\n"
    + `const ROWS = ${WIRING_ROWS};\n\n`
    + "test('text is the default format', () => {\n"
    + "  assert.strictEqual(run([], ROWS), '1 ada\\n2 grace');\n"
    + '});\n\n'
    + "test('the error message lists every supported format', () => {\n"
    + "  const msg = run(['--format', 'xml'], ROWS);\n"
    + "  assert.ok(msg.startsWith('error:'), msg);\n"
    + "  for (const name of formatNames()) assert.ok(msg.includes(name), 'the usage line omits ' + name);\n"
    + '});\n',
};

// ═══════════════════════════════════════════════════════════════════════════
// 4 · reconcile — the obvious fix turns a DIFFERENT passing test red
// ═══════════════════════════════════════════════════════════════════════════

const RECONCILE_FILES = {
  'package.json': '{"name":"demo","type":"module","scripts":{"test":"node --test src/preview.test.mjs src/subject.test.mjs"}}\n',
  // ⭐ ONE helper, TWO callers with different requirements. Changing it is the
  // obvious move and it is the wrong one.
  'src/truncate.mjs':
    'export function truncate(s, n) {\n'
    + '  return s.length > n ? s.slice(0, n) + "…" : s;\n'
    + '}\n',
  'src/preview.mjs':
    "import { truncate } from './truncate.mjs';\n\n"
    + 'export function preview(s) {\n'
    + '  return truncate(s, 18);\n'
    + '}\n',
  'src/subject.mjs':
    "import { truncate } from './truncate.mjs';\n\n"
    + 'export function subject(s) {\n'
    + '  return truncate(s, 10);\n'
    + '}\n',
  'src/preview.test.mjs':
    "import { test } from 'node:test';\n"
    + "import assert from 'node:assert';\n"
    + "import { preview } from './preview.mjs';\n\n"
    + "test('preview never cuts a word in half', () => {\n"
    + "  assert.strictEqual(preview('the quick brown fox jumps'), 'the quick brown…');\n"
    + '});\n\n'
    + "test('short text is left alone', () => {\n"
    + "  assert.strictEqual(preview('the quick'), 'the quick');\n"
    + '});\n',
  /**
   * ⚠️ THIS ONE IS ALREADY GREEN, and it is the whole task. Email subject lines
   * are cut to exactly ten characters on purpose; a word-aware truncate() would
   * return 'hello…' and nobody would notice until the suite ran.
   */
  'src/subject.test.mjs':
    "import { test } from 'node:test';\n"
    + "import assert from 'node:assert';\n"
    + "import { subject } from './subject.mjs';\n\n"
    + "test('subject cuts at exactly ten characters', () => {\n"
    + "  assert.strictEqual(subject('hello world x'), 'hello worl…');\n"
    + '});\n\n'
    + "test('a short subject is untouched', () => {\n"
    + "  assert.strictEqual(subject('hi'), 'hi');\n"
    + '});\n',
};

// ═══════════════════════════════════════════════════════════════════════════
// 5 · staledoc — the doc lies, the comment lies, the code is the truth
// ═══════════════════════════════════════════════════════════════════════════

const STALEDOC_FILES = {
  'package.json': '{"name":"demo","type":"module","scripts":{"test":"node --test src/retry.test.mjs"}}\n',
  /**
   * ⚠️ EVERY FACT IN THIS DOC IS FALSE, and all of it is the kind of false a
   * real repo accumulates: a file that was renamed, constants that were renamed,
   * a policy that changed from exponential to linear and a default that moved.
   * An agent that reads docs first and code second writes 100 * 2 ** n here.
   */
  'docs/RETRIES.md':
    '# Retry policy\n\n'
    + 'Retry behaviour is configured in `src/config.mjs`:\n\n'
    + '- `RETRY_BASE_MS` — the first delay, **100ms** by default.\n'
    + '- `MAX_RETRIES` — how many attempts we make, **5** by default.\n\n'
    + 'The delay for attempt *n* is `RETRY_BASE_MS * 2 ** n` — exponential, so\n'
    + '100ms, 200ms, 400ms, 800ms, 1600ms.\n\n'
    + 'Edit `src/config.mjs` to change either value.\n',
  'src/retry.mjs':
    '// Exponential backoff: the delay doubles on every attempt, starting at 100ms.\n'
    + 'const BACKOFF_START_MS = 50;\n\n'
    + 'export const MAX_ATTEMPTS = 3;\n\n'
    + 'export function delayFor(attempt) {\n'
    + '  return BACKOFF_START_MS * (attempt + 1);\n'
    + '}\n',
  // ⭐ The only artefact in the fixture that tells the truth — because it runs.
  'src/retry.test.mjs':
    "import { test } from 'node:test';\n"
    + "import assert from 'node:assert';\n"
    + "import { delayFor, MAX_ATTEMPTS } from './retry.mjs';\n\n"
    + "test('the first three delays', () => {\n"
    + '  assert.deepStrictEqual([0, 1, 2].map(delayFor), [50, 100, 150]);\n'
    + '});\n\n'
    + "test('three attempts', () => {\n"
    + '  assert.strictEqual(MAX_ATTEMPTS, 3);\n'
    + '});\n',
};

// ═══════════════════════════════════════════════════════════════════════════
// 6 · deadcode — the dead module is the most-mentioned file in the repo
// ═══════════════════════════════════════════════════════════════════════════

const DEADCODE_FILES = {
  'package.json': '{"name":"demo","type":"module","scripts":{"test":"node --test src/index.test.mjs"}}\n',
  // ⚠️ DECOY 1 — prose. grep says legacy-parser is load-bearing.
  'README.md':
    '# report\n\n'
    + 'Formats a report line and tracks one event.\n\n'
    + 'The legacy wire format is handled by `src/legacy-parser.mjs`, which was\n'
    + 'written for the old exporter. See `parseLegacy` for the pipe-delimited\n'
    + 'shape.\n',
  'src/index.mjs':
    "import { formatReport } from './report.mjs';\n"
    + "import { track } from './telemetry.mjs';\n\n"
    + 'export function main(title, ms) {\n'
    + "  return { line: formatReport(title, ms), event: track('report.render') };\n"
    + '}\n',
  // ⚠️ DECOY 2 — a stale comment naming the dead file from live code.
  'src/report.mjs':
    "import { isoDay, titleCase } from './util/index.mjs';\n\n"
    + '// Historically this parsed the old wire format with legacy-parser.mjs; the\n'
    + '// current path goes through util/strings.mjs instead.\n'
    + 'export function formatReport(title, ms) {\n'
    + "  return titleCase(title) + ' — ' + isoDay(ms);\n"
    + '}\n',
  /**
   * ⭐ THE BARREL IS THE WHOLE DIFFICULTY. `report.mjs` imports `isoDay` from
   * `./util/index.mjs`, so the string "dates" appears in exactly ONE line of the
   * repo — the `export *` below. A text search ranks `util/dates.mjs` as the
   * least-referenced file in the project, and it is the one that must survive.
   * Following that requires resolving a re-export, which is what the LSP verbs
   * are for and what search_text structurally cannot give.
   */
  'src/util/index.mjs':
    "export * from './dates.mjs';\n"
    + "export * from './strings.mjs';\n",
  'src/util/dates.mjs':
    'export function isoDay(ms) {\n'
    + '  return new Date(ms).toISOString().slice(0, 10);\n'
    + '}\n',
  'src/util/strings.mjs':
    'export function titleCase(s) {\n'
    + '  return s.replace(/\\b[a-z]/g, (c) => c.toUpperCase());\n'
    + '}\n',
  'src/telemetry.mjs':
    "import { EVENTS } from './events.mjs';\n\n"
    + 'export function track(name) {\n'
    + "  return EVENTS.includes(name) ? name : 'unknown';\n"
    + '}\n',
  // ⚠️ DECOY 3 — an event literally named for the dead module's job.
  'src/events.mjs':
    "export const EVENTS = ['report.render', 'parse.legacy'];\n",
  // ⭐ THE DEAD ONE. Imported by nothing, mentioned by everything.
  'src/legacy-parser.mjs':
    'export function parseLegacy(line) {\n'
    + "  return line.split('|').map((s) => s.trim());\n"
    + '}\n',
  'src/index.test.mjs':
    "import { test } from 'node:test';\n"
    + "import assert from 'node:assert';\n"
    + "import { main } from './index.mjs';\n\n"
    + "test('the entry point still works', () => {\n"
    + "  const out = main('quarterly results', 0);\n"
    + "  assert.strictEqual(out.line, 'Quarterly Results — 1970-01-01');\n"
    + "  assert.strictEqual(out.event, 'report.render');\n"
    + '});\n',
};

const DEADCODE_SURVIVORS = [
  'package.json', 'README.md', 'src/index.mjs', 'src/report.mjs', 'src/telemetry.mjs',
  'src/events.mjs', 'src/util/index.mjs', 'src/util/dates.mjs', 'src/util/strings.mjs',
  'src/index.test.mjs',
];

// ═══════════════════════════════════════════════════════════════════════════

export const HARD_TASKS_V2 = [
  {
    id: 'renamewide',
    what: 'HARD — rename across 18 files where search-and-replace breaks four things',
    // 18 files. Read the tree, read the definition, edit 12, run the suite, and
    // still have room to recover from one wrong edit.
    rounds: 14,
    setup: { files: RENAME_FILES },
    prompt:
      'Rename the exported function `getUser` in src/store.mjs to `loadUser`, and update every place that '
      + 'uses it so the project still works. Nothing else may be renamed: `getUserRole` in src/roles.mjs is a '
      + 'different function, `LegacyClient.getUser` in src/legacy.mjs is a different API, `MOCK.getUser` in '
      + 'src/mock.mjs is a member name other code depends on, and the string "getUser" in src/analytics.mjs is '
      + 'a wire-format event name that must not change. Do not edit src/index.test.mjs. When you are done run '
      + '`node --test src/index.test.mjs` and make sure it passes.',
    checks: [
      (ws) => runs(ws, ['--test', 'src/index.test.mjs']).ok ? null : 'the suite does not pass after the rename',
      /**
       * ⚠️ THE PARTIAL RENAME. Twelve files must move together; a rename that
       * edits the definition and misses one import site still "works" in the
       * file it touched and explodes at the call.
       */
      (ws) => {
        const stale = RENAME_MOVERS.filter((f) => /\bgetUser\b/.test(read(ws, f)));
        return stale.length === 0 ? null : `getUser still appears in ${stale.join(', ')} — the rename was partial`;
      },
      (ws) => /export function loadUser/.test(read(ws, 'src/store.mjs')) ? null : 'the definition itself was never renamed',
      (ws) => {
        const unmoved = RENAME_MOVERS.filter((f) => !/\bloadUser\b/.test(read(ws, f)));
        return unmoved.length === 0 ? null : `loadUser never reached ${unmoved.join(', ')}`;
      },
      // ── The four traps a `sed s/getUser/loadUser/g` walks straight into ──
      (ws) => /export function getUserRole/.test(read(ws, 'src/roles.mjs')) && !/loadUserRole/.test(read(ws, 'src/roles.mjs'))
        ? null : 'SUBSTRING COLLISION: getUserRole was renamed too — it is a different function',
      (ws) => /getUser\(id\)/.test(read(ws, 'src/legacy.mjs')) ? null : 'LegacyClient.getUser was renamed — that is a different API',
      (ws) => /getUser:/.test(read(ws, 'src/mock.mjs')) ? null : 'MOCK.getUser was renamed — that member name is depended on',
      (ws) => /"getUser"|'getUser'/.test(read(ws, 'src/analytics.mjs'))
        ? null : 'THE STRING LITERAL CHANGED: the analytics event name is wire format, not code',
      // Anti-cheat: a correct rename needs zero edits to the suite.
      (ws) => unchanged(ws, 'src/index.test.mjs', "assert.strictEqual(EVENT_GET_USER, 'getUser')", 'the wire-format assertion'),
      (ws) => unchanged(ws, 'src/index.test.mjs', 'assert.strictEqual(typeof MOCK.getUser', 'the mock member assertion'),
      (ws) => {
        const gone = missing(ws, Object.keys(RENAME_FILES));
        return gone.length === 0 ? null : `files were deleted rather than edited: ${gone.join(', ')}`;
      },
      (ws) => {
        const bad = probe(ws, `import { loadUser, hotel, india, juliet } from ${url(ws, 'src/index.mjs')};`
          + "if (loadUser(3).name !== 'user-3') throw new Error('loadUser(3).name = ' + loadUser(3).name);"
          + "if (hotel(7) !== 'user-7') throw new Error('the namespace import broke: ' + hotel(7));"
          + "if (india(8) !== 'user-8') throw new Error('the aliased import broke: ' + india(8));"
          + "if (juliet(9).name !== 'user-9') throw new Error('the re-export broke');");
        return bad ? `the renamed module does not work through the barrel: ${bad}` : null;
      },
    ],
  },

  {
    id: 'twohops',
    what: 'HARD — the symptom is in report.mjs, the cause is two imports away',
    rounds: 9,
    setup: { files: TWOHOPS_FILES },
    prompt:
      '`node --test src/report.test.mjs` fails. Find the real cause and fix it there — `lastN(items, n)` is '
      + 'meant to return the last n items. Do not edit the test.',
    checks: [
      (ws) => runs(ws, ['--test', 'src/report.test.mjs']).ok ? null : 'the test still fails',
      (ws) => unchanged(ws, 'src/report.test.mjs', 'summary([1, 2, 3, 4, 5]).recentTotal, 12', 'the expected total'),
      /**
       * ⚠️⚠️ THE PLAUSIBLE WRONG ANSWER, and it is green. Patching the middle
       * file to call `lastN(values, n + 1)` makes the visible test pass while
       * leaving `lastN` broken for every other caller — the exact shape of a fix
       * applied at the symptom instead of the cause. Only a probe against the
       * cause file can tell the two apart.
       */
      (ws) => {
        const bad = probe(ws, `import { lastN } from ${url(ws, 'src/window.mjs')};`
          + "const got = lastN(['a','b','c','d'], 2).join(',');"
          + "if (got !== 'c,d') throw new Error('lastN([a,b,c,d], 2) = [' + got + '], expected [c,d]');"
          + "const all = lastN(['a','b','c'], 3).join(',');"
          + "if (all !== 'a,b,c') throw new Error('lastN([a,b,c], 3) = [' + all + '], expected [a,b,c]');");
        return bad ? `lastN itself is still wrong — the fix was applied at the symptom, not the cause: ${bad}` : null;
      },
      (ws) => {
        const bad = probe(ws, `import { summary } from ${url(ws, 'src/report.mjs')};`
          + 'const got = summary([10, 20, 30, 40]).recentTotal;'
          + "if (got !== 90) throw new Error('summary([10,20,30,40]).recentTotal = ' + got + ', expected 90');");
        return bad ? `the fix does not generalise past the one tested case: ${bad}` : null;
      },
      (ws) => !/recentTotal:\s*12\b/.test(read(ws, 'src/report.mjs')) ? null : 'it hardcoded the expected total',
      (ws) => {
        const bad = probe(ws, `import { sumRecent } from ${url(ws, 'src/aggregate.mjs')};`
          + 'const got = sumRecent([1, 2, 3, 4, 5], 2);'
          + "if (got !== 9) throw new Error('sumRecent([1,2,3,4,5], 2) = ' + got + ', expected 9');");
        return bad ? `sumRecent no longer means "the last n": ${bad}` : null;
      },
    ],
  },

  {
    id: 'wiring',
    what: 'HARD — one feature, four modules that must agree, plus a new test',
    rounds: 14,
    setup: { files: WIRING_FILES },
    prompt:
      'Add a `csv` output format. `render("csv", rows)` must return a header line of the first row\'s keys in '
      + 'order, then one line per row of that row\'s values in the same key order, comma-separated, lines joined '
      + 'with "\\n" and NO trailing newline — so [{id:1,name:"ada"},{id:2,name:"grace"}] becomes '
      + '"id,name\\n1,ada\\n2,grace". An empty array returns an empty string. Values never contain commas, so do '
      + 'not quote anything. It must work through the CLI too: run(["--format","csv"], rows). "xml" must still be '
      + 'rejected. Add a new test file src/csv.test.mjs covering it, do not edit src/cli.test.mjs, and run both '
      + 'test files.',
    checks: [
      (ws) => existsSync(join(ws, 'src/formats/csv.mjs')) ? null : 'no src/formats/csv.mjs — the format was not built as a module like its siblings',
      (ws) => runs(ws, ['--test', 'src/cli.test.mjs']).ok ? null : 'the EXISTING suite does not pass — the three format lists no longer agree',
      (ws) => unchanged(ws, 'src/cli.test.mjs', "for (const name of formatNames()) assert.ok(msg.includes(name)", 'the usage-line assertion'),
      (ws) => existsSync(join(ws, 'src/csv.test.mjs')) ? null : 'the new test file src/csv.test.mjs was never written',
      (ws) => /csv/i.test(read(ws, 'src/csv.test.mjs')) ? null : 'src/csv.test.mjs does not mention csv — it tests something else',
      (ws) => runs(ws, ['--test', 'src/csv.test.mjs']).ok ? null : 'the test it wrote for its own feature does not pass',
      (ws) => {
        const bad = probe(ws, `import { render, formatNames } from ${url(ws, 'src/formats/registry.mjs')};`
          + `const want = ${JSON.stringify(WIRING_CSV)};`
          + `const got = render('csv', ${WIRING_ROWS});`
          + "if (got !== want) throw new Error('render(csv) = ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want));"
          + "if (render('csv', []) !== '') throw new Error('an empty array should render as an empty string, got ' + JSON.stringify(render('csv', [])));"
          + "if (!formatNames().includes('csv')) throw new Error('csv is not REGISTERED — formatNames() = ' + formatNames().join(','));");
        return bad ? `the registry half is wrong: ${bad}` : null;
      },
      /**
       * ⚠️ THE PLAUSIBLE WRONG ANSWER: special-case 'csv' inside run(), which
       * makes the CLI work while the registry — the thing every other consumer
       * uses — never learns the format exists. The probe above catches the
       * registry side; this one catches the reverse, a registry entry the CLI
       * still rejects.
       */
      (ws) => {
        const bad = probe(ws, `import { run } from ${url(ws, 'src/cli.mjs')};`
          + `const want = ${JSON.stringify(WIRING_CSV)};`
          + `const got = run(['--format', 'csv'], ${WIRING_ROWS});`
          + "if (got !== want) throw new Error('run(--format csv) = ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want));");
        return bad ? `the CLI does not reach the new format: ${bad}` : null;
      },
      (ws) => {
        const bad = probe(ws, `import { isAllowed } from ${url(ws, 'src/validate.mjs')};`
          + "if (isAllowed('csv') !== true) throw new Error('validate still rejects csv');"
          + "if (isAllowed('xml') !== false) throw new Error('validate now accepts ANYTHING — xml passed');");
        return bad ? `the validator is wrong: ${bad}` : null;
      },
    ],
  },

  {
    id: 'reconcile',
    what: 'HARD — the obvious fix turns a different, already-passing test red',
    rounds: 11,
    setup: { files: RECONCILE_FILES },
    prompt:
      '`node --test src/preview.test.mjs` fails: preview() cuts words in half. Fix it so a preview breaks at the '
      + 'last whitespace at or before the 18-character limit instead, falling back to the current hard cut when '
      + 'there is no whitespace to break at. Email subject lines must keep cutting at exactly 10 characters, '
      + 'unchanged. Do not edit either test file, and run both of them.',
    checks: [
      (ws) => runs(ws, ['--test', 'src/preview.test.mjs', 'src/subject.test.mjs']).ok
        ? null : 'the two suites do not both pass — the fix broke the other caller',
      (ws) => unchanged(ws, 'src/preview.test.mjs', "preview('the quick brown fox jumps'), 'the quick brown…'", 'the word-break assertion'),
      (ws) => unchanged(ws, 'src/subject.test.mjs', "subject('hello world x'), 'hello worl…'", 'the ten-character assertion'),
      /**
       * ⚠️ THE PLAUSIBLE WRONG ANSWER: make truncate() itself word-aware. It is
       * one edit, it turns the failing test green, and it silently changes every
       * email subject in the product from 'hello worl…' to 'hello…'.
       */
      (ws) => {
        const bad = probe(ws, `import { subject } from ${url(ws, 'src/subject.mjs')};`
          + "const got = subject('hello world x');"
          + "if (got !== 'hello worl…') throw new Error('subject(\"hello world x\") = ' + JSON.stringify(got) + \", expected 'hello worl…'\");"
          + "if (subject('hi') !== 'hi') throw new Error('short subjects must be untouched, got ' + JSON.stringify(subject('hi')));");
        return bad ? `the SHARED helper was changed and email subjects moved with it: ${bad}` : null;
      },
      (ws) => {
        const bad = probe(ws, `import { preview } from ${url(ws, 'src/preview.mjs')};`
          + "const w = preview('the quick brown fox jumps');"
          + "if (w !== 'the quick brown…') throw new Error('preview(long) = ' + JSON.stringify(w));"
          // A case neither test covers: no whitespace at all → the hard cut.
          + "const n = preview('abcdefghijklmnopqrstuvwxyz');"
          + "if (n !== 'abcdefghijklmnopqr…') throw new Error('with no whitespace it must fall back to the hard cut, got ' + JSON.stringify(n));"
          // And the happy path: exactly at the limit is not truncated at all.
          + "const e = preview('exactly eighteen c');"
          + "if (e !== 'exactly eighteen c') throw new Error('18 characters is not over the limit, got ' + JSON.stringify(e));");
        return bad ? `preview() is wrong: ${bad}` : null;
      },
    ],
  },

  {
    id: 'staledoc',
    what: 'HARD — the doc and the code comment both lie; only the code is true',
    rounds: 9,
    setup: { files: STALEDOC_FILES },
    prompt:
      'Cap the retry delay at 400ms: no delay delayFor() returns may exceed 400. Keep the existing progression '
      + 'below the cap exactly as it is, keep the existing constants and their names, and change nothing else. '
      + 'Then run `node --test src/retry.test.mjs`.',
    checks: [
      (ws) => runs(ws, ['--test', 'src/retry.test.mjs']).ok ? null : 'the existing test fails — the progression below the cap was changed',
      (ws) => unchanged(ws, 'src/retry.test.mjs', 'assert.deepStrictEqual([0, 1, 2].map(delayFor), [50, 100, 150])', 'the delay assertion'),
      /**
       * ⚠️⚠️ THE PLAUSIBLE WRONG ANSWER IS WRITTEN DOWN IN THE FIXTURE. docs/
       * RETRIES.md says the base is 100ms and the growth is exponential, and the
       * comment directly above the constant says the same. An agent that trusts
       * either produces 100, 200, 400 — and it produces it confidently.
       */
      (ws) => {
        const want = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => Math.min(400, 50 * (n + 1)));
        const bad = probe(ws, `import { delayFor } from ${url(ws, 'src/retry.mjs')};`
          + `const want = ${JSON.stringify(want)};`
          + 'const got = want.map((_, n) => delayFor(n));'
          + "if (got.join(',') !== want.join(',')) throw new Error('delays are [' + got.join(',') + '], expected [' + want.join(',') + ']');");
        return bad ? `the progression is wrong — the doc's exponential-from-100 is fiction: ${bad}` : null;
      },
      (ws) => {
        const bad = probe(ws, `import { MAX_ATTEMPTS } from ${url(ws, 'src/retry.mjs')};`
          + "if (MAX_ATTEMPTS !== 3) throw new Error('MAX_ATTEMPTS = ' + MAX_ATTEMPTS + ', and nothing asked for it to change');");
        return bad ? `it changed MAX_ATTEMPTS to match the doc's "5": ${bad}` : null;
      },
      // The doc names a file that has never existed. Creating it is believing it.
      (ws) => !existsSync(join(ws, 'src/config.mjs'))
        ? null : 'it CREATED src/config.mjs — the file the stale doc describes, which the code never had',
      (ws) => /BACKOFF_START_MS/.test(read(ws, 'src/retry.mjs'))
        ? null : 'BACKOFF_START_MS is gone — the constants were told to stay as they are, doc or no doc',
      (ws) => existsSync(join(ws, 'docs/RETRIES.md')) ? null : 'it deleted the documentation instead of leaving it alone',
    ],
  },

  {
    id: 'deadcode',
    what: 'HARD — delete the one dead module, in a repo where grep points the wrong way',
    rounds: 10,
    setup: { files: DEADCODE_FILES },
    prompt:
      'Exactly one module under src/ is dead: nothing reachable from src/index.mjs imports it, directly or '
      + 'indirectly. Delete that file and only that file — do not delete or edit anything else. Then run '
      + '`node --test src/index.test.mjs`.',
    checks: [
      (ws) => !existsSync(join(ws, 'src/legacy-parser.mjs'))
        ? null : 'src/legacy-parser.mjs is still there — the dead module was never found',
      /**
       * ⚠️⚠️ THE PLAUSIBLE WRONG ANSWER: src/util/dates.mjs. The string "dates"
       * appears in exactly one line of this repo (the `export *` barrel), while
       * "legacy-parser" appears in three — so every text-frequency heuristic
       * picks the live file. Resolving the re-export is the only way through.
       */
      (ws) => {
        const gone = missing(ws, DEADCODE_SURVIVORS);
        return gone.length === 0 ? null : `it deleted live files: ${gone.join(', ')}`;
      },
      (ws) => runs(ws, ['--test', 'src/index.test.mjs']).ok ? null : 'the suite does not pass — something reachable was removed',
      (ws) => unchanged(ws, 'src/index.test.mjs', "assert.strictEqual(out.line, 'Quarterly Results — 1970-01-01')", 'the entry-point assertion'),
      // The barrel is the thing that made this hard; it must survive intact.
      (ws) => read(ws, 'src/util/index.mjs') === DEADCODE_FILES['src/util/index.mjs']
        ? null : 'src/util/index.mjs was rewritten — the barrel it had to understand was supposed to stay untouched',
      (ws) => /from '\.\/util\/index\.mjs'/.test(read(ws, 'src/report.mjs'))
        ? null : 'src/report.mjs no longer imports through the barrel — it was edited, and nothing asked for that',
      (ws) => {
        const bad = probe(ws, `import { main } from ${url(ws, 'src/index.mjs')};`
          + "const out = main('quarterly results', 0);"
          + "if (out.line !== 'Quarterly Results — 1970-01-01') throw new Error('line = ' + JSON.stringify(out.line));"
          + "if (out.event !== 'report.render') throw new Error('event = ' + JSON.stringify(out.event));");
        return bad ? `the entry point no longer works: ${bad}` : null;
      },
    ],
  },
];

/**
 * ⭐ Exported for the offline self-check in test/hard-bench-v2.test.mjs, which
 * lays each fixture down, applies a hand-written CORRECT solution and a
 * hand-written PLAUSIBLE-WRONG one, and asserts the checks pass the first and
 * fail the second. A check nobody has watched go red is not evidence.
 */
export const HARD_V2_IDS = HARD_TASKS_V2.map((t) => t.id);
