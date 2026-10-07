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
import { ALLOW_DEPLOY_ENV } from '../lib/vercel.mjs';
import { BROWSER_SERVER_ENV } from '../lib/playtest.mjs';
// ⚠️ HERMETIC HOME (2026-09-26). A signed-in account now counts as a browser for `playtest` (the
// hosted drive — see `hostedDriveRoute`), so a developer's own ~/.acuvo/credentials.json changed
// what these tests saw and sent their "no browser" cases to the real gateway. Nothing here is about
// an account; `playtest-works-without-a-local-browser.test.mjs` is.
{
  const noAccount = mkdtempSync(join(tmpdir(), 'acuvo-no-account-'));
  process.env.HOME = noAccount;
  process.env.USERPROFILE = noAccount;
  delete process.env.ACUVO_HOME;
}

/**
 * ⚠️⚠️ TWO NAMED HOMES, BECAUSE THE OFFER STOPPED BEING A FUNCTION OF `env`
 * ALONE. Since 2026-08-26 six media verbs are offered to a SIGNED-IN customer
 * with no Modal variables at all, so what a run offers depends on
 * `~/.acuvo/credentials.json` — and a test that inherits the real home measures
 * whoever happens to be logged in. `renderVia`'s header records the sharper
 * version of this: a sibling test printed a live `xxi_live_…` token into node's
 * own failure output before homes were threaded.
 *
 * ⭐ The signed-in one is CREATED here rather than borrowed, so "a customer with
 * an account" is a fact this file states rather than one it inherits. The token
 * is obvious nonsense on purpose.
 */
const NO_ACCOUNT_HOME = '/acuvo-test-no-such-home';
const SIGNED_IN_HOME = (() => {
  const home = mkdtempSync(join(tmpdir(), 'acuvo-offer-account-'));
  mkdirSync(join(home, '.acuvo'), { recursive: true });
  writeFileSync(
    join(home, '.acuvo', 'credentials.json'),
    JSON.stringify({ token: 'not-a-real-token', gatewayUrl: 'https://acuvo.example.invalid/api/cli/v1/chat/completions' }),
  );
  return home;
})();

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
  /**
   * ⭐ `rename_symbol` SHARES THAT EXACT GATE and is here for the same reason,
   * not to quiet the assertion: it is offered only when `tsserverAvailable`
   * finds a real `typescript` in the workspace, which this fixture cannot
   * install. `test/rename-symbol.test.mjs` proves the pairing instead — it
   * asserts rename_symbol is offered if and only if find_references is.
   */
  'rename_symbol',
  /**
   * ⭐ THE THREE AST EDITS SHARE `rename_symbol`'s GATE EXACTLY — added
   * 2026-09-07. They are offered when the project has a real `typescript`,
   * which this fixture cannot install, so they are unreachable HERE for the
   * same reason and not for a different one.
   *
   * ⚠️ AND THE PAIRING IS PROVED ELSEWHERE RATHER THAN WAIVED HERE, which is
   * what makes this list an exemption instead of a hole:
   * `test/ts-edit.test.mjs` asserts all three are in `TOOL_NAMES` and carry a
   * schema, and `tools.mjs` pushes them from the SAME `if` that pushes
   * `rename_symbol` — one gate, four verbs, so a future edit cannot open one
   * without the others.
   */
  'insert_before_symbol', 'insert_after_symbol', 'replace_function_body',
  // Needs a terminal to answer.
  'ask_user',
]);

/** A workspace with every kind of evidence a gate looks for. */
function maximalRoot() {
  const root = mkdtempSync(join(tmpdir(), 'maximal-'));
  mkdirSync(join(root, 'migrations'), { recursive: true });
  writeFileSync(join(root, 'migrations', '001.sql'), 'CREATE TABLE t (id int);');
  writeFileSync(join(root, 'index.js'), 'console.log(1);');
  /**
   * ⭐ `profile_table` gates on a DELIMITED FILE existing in the workspace —
   * `tableEvidence`, the `inspect_db` shape one block down. Without this line the
   * guard reports a live verb as dark, which is the exact failure the note above
   * records for `ALLOW_PUSH_ENV`: the evidence a gate looks for has to be BUILT
   * here, not assumed.
   */
  writeFileSync(join(root, 'sample.csv'), 'a,b\n1,2\n');
  /**
   * ⭐ `inspect_binary` gates on a BINARY existing in the workspace —
   * `binaryEvidence`, the `tableEvidence` shape one line up. `.out` is on
   * `BINARY_EXTENSIONS`, and the bytes are a real ELF magic rather than random
   * filler so that this fixture also exercises the identify path if a future
   * assertion here wants it. Without this line the guard reports a live verb as
   * dark, which is the failure the `ALLOW_PUSH_ENV` note above records.
   */
  writeFileSync(join(root, 'a.out'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
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
  /**
   * ⭐ `vercel_preview` spends a PAID build, so it is double-gated exactly like
   * `git_push`: an explicit opt-in AND a credential. Both names are IMPORTED
   * rather than typed, for the reason the note above records — a guessed env
   * name reports a live verb as dark.
   */
  [ALLOW_DEPLOY_ENV]: '1',
  VERCEL_TOKEN: 'test-token',
  /**
   * ⭐ THE MOAT VERBS — cloned voice, designed voice, the talking head and
   * video. All four gate on BOTH a URL and a shared secret, because a URL
   * with no secret is a 401 wearing the costume of a working integration.
   */
  MODAL_VIDEO_SECRET: 'test-secret',
  MODAL_VOICE_CLONE_URL: 'https://example.invalid/clone',
  MODAL_VOICE_DESIGN_URL: 'https://example.invalid/design',
  MODAL_AVATAR_URL: 'https://example.invalid/avatar',
  MODAL_CHARACTER_LOCK_URL: 'https://example.invalid/character-lock',
  MODAL_VIDEO_URL: 'https://example.invalid/video',
  /**
   * ⭐ `playtest` gates on a browser MCP server existing in the WORKSPACE's own
   * config, plus this operator override naming which server it is. The override
   * is what a test can build — writing a `.acuvo/mcp.json` into `maximalRoot`
   * would prove the same thing while coupling this guard to that file's format.
   *
   * ⚠️ IMPORTED, NEVER TYPED, for the reason recorded two entries up: the first
   * two attempts at ALLOW_PUSH_ENV invented plausible names and the guard
   * cheerfully reported a live verb as dark.
   */
  [BROWSER_SERVER_ENV]: 'playwright',
});

test('⭐⭐ every declared tool is reachable under SOME configuration', () => {
  const root = maximalRoot();
  try {
    const declared = TOOL_SCHEMAS.map((t) => t.function.name);
    /**
     * ⭐ SIGNED IN IS A CONFIGURATION TOO. `media_chain` is gateway-only — it has
     * no operator-key route at all — so it is reachable only through an account.
     * The union is the honest reading of "under SOME configuration".
     */
    const offered = new Set([
      ...toolNamesForRounds(16, { root, allowRun: true, interactive: true, env: MAXIMAL_ENV }),
      ...toolNamesForRounds(16, { root, allowRun: true, interactive: true, env: MAXIMAL_ENV, home: SIGNED_IN_HOME }),
    ]);
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

/**
 * ⚠️⚠️ THIS TEST WENT RED ON 2026-08-26 AND IT WAS RIGHT TO. The media half
 * became ACCOUNT-aware — six tools that used to need OUR Modal credential are
 * now offered to any signed-in customer — so the surface a paying user's model
 * sees grew, and it grew on every turn of every session.
 *
 * ⭐ MEASURED, on a plain one-file project at 16 rounds:
 *
 *     signed out   52 tools   57,255 bytes
 *     signed in    58 tools   61,382 bytes   (+4,127, ≈1,030 tokens per turn)
 *     the six      see_page · speak · transcribe · make_document ·
 *                  read_document · read_table
 *
 * ⚠️ AND THE HOME IS NAMED IN BOTH DIRECTIONS ON PURPOSE. Left to the real one,
 * this assertion would measure a different surface on a signed-in laptop than on
 * a signed-out one and nobody would know which number the ceiling referred to.
 */
test('⚠️ the three additions cost what was measured, not more', () => {
  const plain = mkdtempSync(join(tmpdir(), 'cost-'));
  try {
    writeFileSync(join(plain, 'index.js'), 'console.log(1);');
    const names = toolNamesForRounds(16, { root: plain, env: {}, allowRun: true, home: NO_ACCOUNT_HOME });
    const bytes = JSON.stringify(toolSchemasFor(names)).length;
    /**
     * A ceiling, not an equality — the surface grows for good reasons. It is
     * here so a future addition that doubles it has to be deliberate.
     */
    /**
     * ⚠️ RAISED 60,000 → 62,000 ON 2026-09-07, AND THESE ARE THE DECISIONS:
     *   · `write_process` (C1) — the input half of background processes; a REPL
     *     and a y/N prompt were unreachable without it.
     *   · `find_usages` (C2, 722 bytes) — uses of a name with comments and
     *     strings masked, for the projects with no language server.
     * Measured signed out, plain one-file project, 16 rounds: 61,024 bytes.
     */
    assert.ok(bytes < 62_000, `the tool surface is ${bytes} bytes; something large was added without a decision`);

    /**
     * ⭐ AND THE ACCOUNT-REACHABLE HALF IS PRICED SEPARATELY, because it is the
     * surface a CUSTOMER pays for and nobody had ever measured it. A deliberate
     * ceiling here is what stops the next "just offer it to signed-in users"
     * from being free-looking.
     */
    const signedIn = toolNamesForRounds(16, { root: plain, env: {}, allowRun: true, home: SIGNED_IN_HOME });
    const gained = signedIn.filter((n) => !names.includes(n));
    assert.deepEqual(
      gained.sort(),
      /**
       * ── ⭐⭐ SIX BECAME EIGHT ON 2026-08-31, AND THE TWO NEW ONES ARE THE
       *        SAME FIX ONE LEVEL UP ────────────────────────────────────────
       *
       * `viral` and `podcast` are ORCHESTRATORS: neither owns a capability,
       * both compose `speak`. When the media half became account-aware, `speak`
       * moved to `speakVia` and these two were left gating on
       * `mediaConfig(env).speak` — which needs OUR Modal secret. So the verbs
       * were offered to exactly one machine in the world, ours, while the thing
       * they are built on had already been opened to every paying customer.
       *
       * ⚠️ THEY DO HAVE A GATEWAY ROUTE — `/speak`, the one they call. The
       * sentence below used to say "the six media verbs that have a gateway
       * route" and that was the whole confusion: reaching the route through an
       * orchestrator is still reaching it.
       *
       * ⚠️ AND THEY ARE NOT FREE — measured +3,601 B on top of the six (4,127 -> 7,728 total), which
       * is why the ceiling below moved from 5,000 to 9,000 deliberately rather
       * than being widened until green.
       */
      // ⭐ media_chain (2026-09-28) is the ninth: gateway-only, same offer rule as `viral`.
      ['make_document', 'read_document', 'read_table', 'see_page', 'speak', 'transcribe', 'viral', 'podcast', 'media_chain'].sort(),
      'signing in should unlock exactly the media verbs a customer account can actually reach',
    );
    const withAccount = JSON.stringify(toolSchemasFor(signedIn)).length;
    assert.ok(
      /**
       * ⚠️ RAISED 9,000 → 10,000 ON 2026-10-07 for `media_chain`, which shipped
       * in 0.6.25 without moving this line. Measured: 9,213 B total, so the
       * verb costs +1,485 B on every signed-in turn. Deliberate, recorded.
       */
      withAccount - bytes < 10_000,
      `signing in adds ${withAccount - bytes} bytes to every turn; 9,213 was measured (4,127 for the six + 3,601 for the two orchestrators + 1,485 for media_chain) — a jump means a schema grew unnoticed`,
    );
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
  /**
   * ⚠️ `playtest` IS ON THIS LIST BECAUSE IT GENUINELY VARIES, not to quiet the
   * assertion. Its gate reads `.acuvo/mcp.json` from the workspace, so it is
   * present in a repo with a browser server configured and absent in one
   * without — the same shape as `read_skill`, and the same reason it must be
   * declared after everything stable. Adding a name here is only ever correct
   * when the tool's OFFER depends on the project; anything else belongs above
   * the varying block, where its bytes stay in the shared prefix.
   */
  /**
   * ⚠️ `profile_table` IS ON THIS LIST FOR THE REASON THE NOTE ABOVE REQUIRES,
   * not to quiet the assertion: `tableProfileToolNames` calls `tableEvidence`,
   * which looks for a delimited file in the workspace root or one level down, so
   * the verb is present on a repository that ships data and absent on one that
   * does not. Same shape as `inspect_db`, one line up.
   */
  /**
   * ⚠️ `inspect_binary` IS ON THIS LIST FOR THE REASON THE NOTE ABOVE REQUIRES,
   * not to quiet the assertion: `binaryInspectToolNames` calls `binaryEvidence`,
   * which looks for a binary file in the workspace root or one level down, so the
   * verb is present on a repository that ships a compiled artifact and absent on
   * one that does not. Same shape as `profile_table`, one line up.
   */
  /**
   * ⚠️ `rename_symbol` IS ON THIS LIST FOR THE REASON THE NOTE ABOVE REQUIRES,
   * not to quiet the assertion: it is offered from the same gate as the four
   * navigation verbs beside it — a real `typescript` in the workspace — so it is
   * present on a TypeScript repo and absent on a Python one.
   */
  /**
   * ⚠️ THE THREE AST EDITS ARE ON THIS LIST FOR THE REASON THE NOTE ABOVE
   * REQUIRES, not to quiet the assertion: they are pushed from the SAME `if`
   * as `rename_symbol` one line up — a real `typescript` in the workspace — so
   * they appear and disappear with the PROJECT, which is the precise definition
   * of a schema that must sit after everything stable.
   */
  const VARIES = ['playtest', 'read_skill', 'find_definition', 'find_references', 'check_types', 'list_symbols',
    'rename_symbol', 'insert_before_symbol', 'insert_after_symbol', 'replace_function_body',
    'inspect_db', 'sample_db_rows', 'profile_table', 'inspect_binary'];
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
    /**
     * ⚠⚠ `withDb` GAINED AN `index.js` ON 2026-09-19, AND THE REASON IS THE
     * TEST'S OWN SUBJECT. Only `plain` carried a source file, so the two dirs
     * differed in TWO ways — the DB gate AND whether the workspace looked like
     * JavaScript at all. That second difference was inert only while nothing on
     * the machine could serve JS. `acuvo lsp install` puts a tsserver under
     * HOME, `languagesPresent` then lights the eight symbol verbs for `plain`
     * and not for `withDb`, and the prompts diverged on three LSP lines — red
     * here, and PASSING on a colleague's laptop that had not run the installer.
     *
     * ⭐ Pinning a fake HOME would also have made it deterministic, and would
     * have tested less: with both dirs looking like JavaScript this now asserts
     * the stronger thing — that the LSP lines are the SAME for two JS projects
     * — and it says the same thing on a machine with a server and one without.
     */
    writeFileSync(join(withDb, 'index.js'), 'console.log(1);');
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
