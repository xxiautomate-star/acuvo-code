/**
 * ── ⚠️⚠️ A TOOL CAN BE DECLARED AND NEVER OFFERED ───────────────────────────
 *
 * Measured 2026-08-20: `TOOL_SCHEMAS` declares 63 tools and
 * `toolNamesForRounds` named 46. Thirteen of the seventeen absent are honestly
 * environment-gated — LSP, the media secret, an explicit render URL, the
 * git-push opt-in, `ask_user` needing a terminal.
 *
 * ⭐ THREE WERE GATED ON NOTHING. `review_code`, `inspect_db` and
 * `sample_db_rows` sit directly under a comment explaining why they are
 * declared unconditionally — *"they read what is already on disk — no endpoint
 * of ours, no process, no key"* — and no code path ever put their names in the
 * list, so the model could not call them.
 *
 * ⚠️ `code-review.mjs` even prints *"run `review_code` on the file for the full
 * list"*: a hint, shown to a human, pointing at a verb the model was never
 * offered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TOOL_SCHEMAS, toolNamesForRounds, dbEvidence, toolSchemasFor } from '../lib/tools.mjs';
import { ALLOW_PUSH_ENV } from '../lib/git.mjs';

/**
 * ⚠️ WHAT A TEST GENUINELY CANNOT PRODUCE — a language server binary and a
 * human at a terminal. Everything else is configuration, and the assertion
 * below sets it, because "is this tool reachable on MY machine" is a much
 * weaker question than "is it reachable under ANY configuration".
 *
 * ⭐ My first version of this test asked the weak question and failed on its
 * own repo: the .sql files here are bench fixtures, not a schema, so the
 * database gate correctly said no and the test called the tools dark.
 */
const CANNOT_BE_SIMULATED = new Set([
  // A language server the project actually speaks, installed on the box.
  'find_definition', 'find_references', 'check_types', 'list_symbols',
  // Needs a terminal to answer.
  'ask_user',
]);

/** A workspace with every kind of evidence a gate looks for. */
function maximalRoot() {
  const root = mkdtempSync(join(tmpdir(), 'maximal-'));
  mkdirSync(join(root, 'migrations'), { recursive: true });
  writeFileSync(join(root, 'migrations', '001.sql'), 'CREATE TABLE t (id int);');
  writeFileSync(join(root, 'index.js'), 'console.log(1);');
  return root;
}

/** Every environment switch a gate reads, turned on. */
const MAXIMAL_ENV = Object.freeze({
  ACUVO_MEDIA_SECRET: 'test-secret',
  RENDER_AUDIT_URL: 'https://example.invalid/render',
  DATABASE_URL: 'postgres://example.invalid/db',
  // ⚠️ The real name, read from lib/git.mjs rather than guessed — my first
  // two attempts invented plausible ones and the test reported git_push dark.
  [ALLOW_PUSH_ENV]: '1',
});

test('⭐⭐ every declared tool is reachable under SOME configuration', () => {
  const root = maximalRoot();
  try {
    const declared = TOOL_SCHEMAS.map((t) => t.function.name);
    const offered = new Set(toolNamesForRounds(16, {
      root, allowRun: true, interactive: true, env: MAXIMAL_ENV,
    }));
    const dark = declared.filter((n) => !offered.has(n) && !CANNOT_BE_SIMULATED.has(n));
    assert.deepEqual(
      dark, [],
      `declared, and reachable under no configuration this test can build: ${dark.join(', ')}. `
      + 'Either wire it into toolNamesForRounds or add it to CANNOT_BE_SIMULATED with a reason.',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('⚠️ the gated list is not a dumping ground — every name on it still exists', () => {
  const declared = new Set(TOOL_SCHEMAS.map((t) => t.function.name));
  const stale = [...CANNOT_BE_SIMULATED].filter((n) => !declared.has(n));
  assert.deepEqual(stale, [], `these are listed as unsimulatable but no longer declared: ${stale.join(', ')}`);
});

test('⭐ review_code rides every session — it needs no key and applies to any file', () => {
  const plain = mkdtempSync(join(tmpdir(), 'plain-'));
  try {
    writeFileSync(join(plain, 'index.js'), 'console.log(1);');
    const names = toolNamesForRounds(16, { root: plain, env: {}, allowRun: true });
    assert.ok(names.includes('review_code'), 'review_code is not offered on an ordinary project');
  } finally { rmSync(plain, { recursive: true, force: true }); }
});

/**
 * ⚠️⚠️ THE DB PAIR COSTS 835 TOKENS ON EVERY TURN, in a package whose binding
 * constraint is the token budget. So it follows the shape `skillsAvailable` and
 * `lspAvailable` already use: offered where there is evidence it can answer.
 * A gate that is always true is not a gate.
 */
test('⚠️ the database tools are offered on evidence, and only on evidence', () => {
  const plain = mkdtempSync(join(tmpdir(), 'nodb-'));
  const withSql = mkdtempSync(join(tmpdir(), 'db-'));
  try {
    writeFileSync(join(plain, 'index.js'), 'console.log(1);');
    mkdirSync(join(withSql, 'migrations'), { recursive: true });
    writeFileSync(join(withSql, 'migrations', '001_init.sql'), 'CREATE TABLE users (id int primary key);');

    assert.equal(dbEvidence(plain, {}), false, 'a plain JS project claims database evidence');
    assert.equal(dbEvidence(withSql, {}), true, 'a migrations directory is not recognised');
    assert.equal(dbEvidence(plain, { DATABASE_URL: 'postgres://x' }), true, 'an explicit connection string is ignored');

    const off = toolNamesForRounds(16, { root: plain, env: {}, allowRun: true });
    assert.ok(!off.includes('inspect_db'), 'the DB tools are offered where they cannot answer');
    const on = toolNamesForRounds(16, { root: withSql, env: {}, allowRun: true });
    assert.ok(on.includes('inspect_db') && on.includes('sample_db_rows'), 'the DB tools are missing where they apply');
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(withSql, { recursive: true, force: true });
  }
});

test('⚠️ the three additions cost what was measured, not more', () => {
  const plain = mkdtempSync(join(tmpdir(), 'cost-'));
  try {
    writeFileSync(join(plain, 'index.js'), 'console.log(1);');
    const names = toolNamesForRounds(16, { root: plain, env: {}, allowRun: true });
    const bytes = JSON.stringify(toolSchemasFor(names)).length;
    /**
     * A ceiling, not an equality — the surface grows for good reasons. It is
     * here so a future addition that doubles it has to be deliberate.
     */
    assert.ok(bytes < 60_000, `the tool surface is ${bytes} bytes; something large was added without a decision`);
  } finally { rmSync(plain, { recursive: true, force: true }); }
});

/**
 * ── ⚠️⚠️ A GATE THAT COSTS HALF A SECOND IS WORSE THAN A MISSING TOOL ───────
 *
 * The first `dbEvidence` called `readSchemaFromWorkspace`, which walks the tree
 * for every .sql file and parses what it finds. Measured on this repo:
 * **478ms per call**, and it is called once per turn. The CLI suite went from
 * 111s to 285s with one run cancelled — that is how it was noticed.
 *
 * ⭐ It now probes conventional locations with `existsSync` and memoises per
 * root. The trade is stated in the source rather than hidden: SQL in an
 * unconventional place will not be found, which is a miss and not a break.
 */
test('⚠️ the database gate is cheap enough to run every turn', () => {
  const root = maximalRoot();
  try {
    const started = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) dbEvidence(root, {});
    const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 200;
    assert.ok(
      perCallMs < 1,
      `dbEvidence costs ${perCallMs.toFixed(2)}ms per call — it runs once per turn, and the version `
      + 'that walked the tree cost 478ms and cancelled a test run.',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⚠️ …and the memo cannot answer for the wrong workspace', () => {
  const withDb = maximalRoot();
  const without = mkdtempSync(join(tmpdir(), 'nodb2-'));
  try {
    writeFileSync(join(without, 'index.js'), 'console.log(1);');
    assert.equal(dbEvidence(withDb, {}), true);
    assert.equal(dbEvidence(without, {}), false, 'the cache leaked one root’s answer to another');
    assert.equal(dbEvidence(withDb, {}), true, 'the second lookup disturbed the first');
  } finally {
    rmSync(withDb, { recursive: true, force: true });
    rmSync(without, { recursive: true, force: true });
  }
});

/**
 * ── ⭐⭐⭐ DECLARATION ORDER IS THE PROMPT-CACHE PREFIX ──────────────────────
 *
 * `toolSchemasFor` returns `TOOL_SCHEMAS.filter(...)`, so the WIRE ORDER is the
 * order of the pushes in `tools.mjs`, not the order a caller asks for. Every
 * tool declared AFTER a conditional group is re-sent cold whenever that group's
 * presence changes, though its bytes are identical.
 *
 * Measured 2026-08-20 between two real project shapes:
 *
 *     conditional groups mid-list   69.2% shared prefix  (34,561 B)
 *     conditional groups LAST       93.3% shared prefix  (46,608 B)
 *
 * ⭐ ~12,000 bytes — roughly 3,000 tokens — paid at cold-read prices on the
 * first round every time a user moved between project shapes.
 */
test('⭐⭐ the tools that vary between projects are declared LAST', () => {
  const order = TOOL_SCHEMAS.map((t) => t.function.name);
  const VARIES = ['read_skill', 'find_definition', 'find_references', 'check_types', 'list_symbols',
    'inspect_db', 'sample_db_rows'];
  const firstVarying = Math.min(...VARIES.map((n) => order.indexOf(n)).filter((i) => i >= 0));
  const stableAfter = order.slice(firstVarying).filter((n) => !VARIES.includes(n));
  assert.deepEqual(
    stableAfter, [],
    `these are declared AFTER a project-varying tool, so they are re-sent cold whenever it appears `
    + `or disappears: ${stableAfter.join(', ')}. Move the varying groups to the end of the push block.`,
  );
});

test('⭐ …and the shared prefix between two project shapes stays high', () => {
  const plain = mkdtempSync(join(tmpdir(), 'pfx-a-'));
  const withDb = mkdtempSync(join(tmpdir(), 'pfx-b-'));
  try {
    writeFileSync(join(plain, 'index.js'), 'console.log(1);');
    mkdirSync(join(withDb, 'migrations'), { recursive: true });
    writeFileSync(join(withDb, 'migrations', '001.sql'), 'CREATE TABLE t (id int);');

    const ser = (root) => JSON.stringify(toolSchemasFor(
      toolNamesForRounds(16, { root, env: {}, allowRun: true })));
    const a = ser(plain), b = ser(withDb);
    /**
     * ⚠️ The two surfaces must actually DIFFER, or this passes for the wrong
     * reason — a gate that never fires makes every prefix identical.
     */
    assert.notEqual(a, b, 'the two project shapes produced the same tool surface; the DB gate never fired');

    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    const pct = (100 * i) / Math.max(a.length, b.length);
    assert.ok(
      pct > 90,
      `only ${pct.toFixed(1)}% of the tool surface is a shared prefix (was 69.2% before the reorder, `
      + '93.3% after). Something conditional moved back up the declaration block.',
    );
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(withDb, { recursive: true, force: true });
  }
});

/**
 * ⚠️ THE ASSUMPTION THE ABOVE RESTS ON. Ordering the tool block only helps while
 * the SYSTEM PROMPT is identical across projects — it sits in front, and a
 * single differing byte there makes every tool byte cold regardless.
 */
test('⚠️ the system prompt does not vary by project, or the ordering buys nothing', async () => {
  const { systemPrompt } = await import('../lib/turn.mjs');
  const plain = mkdtempSync(join(tmpdir(), 'sp-a-'));
  const withDb = mkdtempSync(join(tmpdir(), 'sp-b-'));
  try {
    writeFileSync(join(plain, 'index.js'), 'console.log(1);');
    mkdirSync(join(withDb, 'migrations'), { recursive: true });
    writeFileSync(join(withDb, 'migrations', '001.sql'), 'CREATE TABLE t (id int);');
    const p = (root) => String(systemPrompt({
      maxRounds: 16, allowRun: true,
      offeredNames: toolNamesForRounds(16, { root, env: {}, allowRun: true }),
    }));
    assert.equal(p(plain), p(withDb),
      'the system prompt now differs by project, so it invalidates the cache before the tools do');
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(withDb, { recursive: true, force: true });
  }
});
