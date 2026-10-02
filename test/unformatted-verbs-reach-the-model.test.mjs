/**
 * ── 💰🚨 46 OF 81 VERBS REACHED THE MODEL AS A JSON ENVELOPE ─────────────────
 *
 * `turn.mjs`'s `describeToolResult` is a switch with a `default:` that runs
 * `stringifyForModel`. On 2026-08-31 exactly **35 of the 81 names in
 * `TOOL_SCHEMAS` had a case** and the other 46 fell through — including
 * `git_diff`, `edit_file`, `web_search`, `apply_patch` and `review_code`, which
 * are among the most-called verbs in the package.
 *
 * ⭐ THE PRIOR DEFECT IS NOT THE ONE THAT REMAINS, AND THIS FILE PINS BOTH. The
 * `default:` branch once clamped to 2,000 characters while every formatted
 * branch got 8,000 — measured at the time: a `search_text` delivered 19% of its
 * matches, cut mid-structure so the JSON did not parse. That was fixed: the
 * default now uses the same `MAX_TOOL_RESULT_CHARS` and shrinks string FIELDS
 * rather than splicing the serialised object. The first two tests here exist so
 * it cannot silently come back, because nothing else in the suite measures it.
 *
 * ⚠️ THE FAILURE MODE IS SILENT, WHICH IS WHY IT LASTED. Deleting a `case` does
 * not break anything: the verb still runs, the model still reads something, and
 * the only symptoms are a bigger bill and worse reasoning. `review_code` is the
 * exception that proves it — it had no `ok` field, so it rendered as
 * "review_code failed: unknown error" on every SUCCESS, for as long as it has
 * existed, and 4,889 green tests never noticed.
 *
 * ⭐ SO THE ASSERTIONS ARE ON SHAPE, NOT ON BYTE COUNTS. A count would have to
 * be retyped every time a sentence is reworded — a guard that fails correct
 * work, which this repo has paid for repeatedly. "It is not an envelope, the
 * fact the model acts on is present, and what we deliberately dropped is gone"
 * survives rewording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { toolResultText } from '../lib/turn.mjs';
import { TOOL_SCHEMAS } from '../lib/tools.mjs';
import { executeReviewCode } from '../lib/code-review.mjs';

const rec = (name, result, extra = {}) => ({ id: 'c1', args: {}, name, result, ...extra });

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE CLAMP THE DEFAULT BRANCH USED TO LOSE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️⚠️ THE REGRESSION THIS PINS, IN ITS OWN WORDS: *"THE DEFAULT WAS 2,000
 * WHILE EVERY FORMATTED TOOL GOT 8,000"*. A verb with no case is unformatted
 * because nobody has got to it yet, which is an argument for MORE room, not
 * less — and 29 tools plus EVERY MCP result (`mcp__<server>__<tool>`, which no
 * case can ever match) ride this branch.
 */
test('⚠️⚠️ an unformatted verb gets the SAME budget as a formatted one, not a quarter of it', () => {
  const big = 'x'.repeat(40_000);
  const unformatted = toolResultText(rec('mcp__notion__query', { ok: true, page: big }));
  const formatted = toolResultText(rec('read_file', { ok: true, path: 'a.txt', bytes: 40_000, content: big }));
  assert.ok(
    unformatted.length > formatted.length / 2,
    `the unformatted branch delivered ${unformatted.length} chars where the formatted one delivered `
    + `${formatted.length} — the 2,000-vs-8,000 split is back, and it is paid by every MCP result`,
  );
  assert.ok(unformatted.length > 4_000, `only ${unformatted.length} characters survived the default branch`);
});

/**
 * ⚠️⚠️ AND CLAMPED JSON IS UNPARSEABLE JSON. The old pair spliced
 * "… N characters omitted …" into the MIDDLE of a serialised object. Measured
 * on `git_diff`: an ordinary 400-line refactor produced 8,030 characters that
 * `JSON.parse` rejects, so the model received a structure it could not read at
 * all — worse than a truncation it was told about.
 */
test('⚠️⚠️ an oversized unformatted result is still VALID JSON', () => {
  const out = toolResultText(rec('mcp__db__rows', {
    ok: true,
    rows: Array.from({ length: 400 }, (_, i) => ({ id: i, note: 'a'.repeat(80) })),
    cursor: 'abc123',
  }));
  assert.doesNotThrow(
    () => JSON.parse(out),
    `the default branch cut mid-structure, so the model got something that is not JSON:\n${out.slice(0, 300)}`,
  );
  assert.match(out, /"cursor":"abc123"/, 'the cursor was cut away — the model cannot ask for the rest');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. review_code — A WHOLE VERB THAT HAS NEVER WORKED
 * ──────────────────────────────────────────────────────────────────────────── */

const VULNERABLE = [
  "const jwt = require('jsonwebtoken');",
  "const token = jwt.sign(payload, 'shhh-dev-secret');",
  'function find(id) {',
  '  return db.query(`SELECT * FROM users WHERE id = ${id}`);',
  '}',
].join('\n');

/**
 * ⚠️⚠️⚠️ MEASURED 2026-08-31, on the real analyser: `executeReviewCode` returned
 * `{ path, findings, counts, summary, caveat }` with NO `ok`, and
 * `describeToolResult` opens with `if (result.ok !== true) return "<name>
 * failed: …"`. So a review that found two CRITICAL defects was announced to the
 * model as a crash and the findings were thrown away.
 *
 * ⭐ THE ASSERTION RUNS THE REAL ANALYSER rather than a fixture object,
 * deliberately: a hand-written `{ ok: true, findings: [...] }` would pass
 * happily while the production shape stayed broken, which is exactly how this
 * survived. The module's own suite reads `out.findings` directly and is right
 * to — it says nothing about the boundary two modules away.
 */
test('⚠️⚠️⚠️ a SUCCESSFUL review does not reach the model as "failed: unknown error"', () => {
  const result = executeReviewCode({ path: 'vuln.js', content: VULNERABLE });
  const out = toolResultText(rec('review_code', result));
  assert.ok(
    !/^review_code failed/.test(out),
    `every successful review is being announced as a crash:\n${out}`,
  );
  assert.match(out, /critical/, 'the severity was lost — "2 findings" without "critical" is not actionable');
  assert.match(out, /sql-string-concat/, 'the rule that fired was lost');
});

test('⭐ …and the FIX travels with the finding, because that is what turns the round into an edit', () => {
  const out = toolResultText(rec('review_code', executeReviewCode({ path: 'vuln.js', content: VULNERABLE })));
  assert.match(out, /fix:/, 'a finding without its fix names a problem the model cannot act on');
  assert.match(out, /Pattern review only/, 'the caveat was dropped — the model will quote a short list as an all-clear');
});

/**
 * ⚠️ THE ZERO CASE IS THE ONE THAT GETS QUOTED TO A HUMAN. It must not read as
 * a pass, and it must not read as a failure either.
 */
test('⚠️ a clean review is a RESULT, not a failure and not an all-clear', () => {
  const out = toolResultText(rec('review_code', executeReviewCode({ path: 'ok.js', content: 'export const a = 1;\n' })));
  assert.ok(!/^review_code failed/.test(out), `a clean file rendered as a crash:\n${out}`);
  assert.match(out, /not a guarantee/, 'the "this is not a pass" wording was lost');
});

/**
 * ── ⚠️⚠️ AND THE SECOND HALF: THE DISPATCHER NEVER PASSED A READER ───────────
 *
 * `tools.mjs` handed `executeReviewCode` a second argument of
 * `{ root: executor.root, executor }`, and the function reads `deps.read`.
 * Neither key is `read`, so `typeof deps.read !== 'function'` was true on every
 * dispatched call and `review_code {"path":"src/api.js"}` — the shape its own
 * schema asks for — answered *"could not read … and no content was supplied"*
 * every single time. The only way to reach the analyser was to re-send the
 * whole file as `content`, i.e. to pay for the source twice.
 *
 * ⭐ THIS IS AN END-TO-END TEST ON PURPOSE. The rendering tests above would all
 * have stayed green with the verb permanently unreachable — that is the
 * distinction this package records as *"only the end-to-end run proves reach"*.
 */
test('⚠️⚠️ review_code reads the file itself, as its own schema promises', async () => {
  const { executeToolCall } = await import('../lib/tools.mjs');
  const { createLocalExecutor } = await import('../lib/workspace.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'acuvo-review-'));
  try {
    writeFileSync(join(dir, 'api.js'), VULNERABLE);
    const record = await executeToolCall(
      { id: 'c1', function: { name: 'review_code', arguments: JSON.stringify({ path: 'api.js' }) } },
      createLocalExecutor(dir, {}),
      {},
    );
    const out = toolResultText(record);
    assert.ok(
      !/could not read/.test(out),
      `the dispatcher still passes no reader, so the verb is unreachable without re-sending the file:\n${out}`,
    );
    assert.match(out, /hardcoded-jwt-secret/, 'the analyser was never reached');

    /**
     * ⚠️ AND A MISSING FILE MUST CARRY THE WORKSPACE'S OWN REASON. The reader
     * THROWS on a refusal rather than returning it, so `executeReviewCode`'s
     * catch splices in the real message — which names `find_files` and
     * `list_dir` as the next move. A reader that returned the refusal object
     * instead would fall through to the generic "got no text for x", and the
     * model would learn nothing about WHY. (Found by mutating exactly that.)
     */
    const missing = await executeToolCall(
      { id: 'c2', function: { name: 'review_code', arguments: JSON.stringify({ path: 'nope.js' }) } },
      createLocalExecutor(dir, {}),
      {},
    );
    const refusal = toolResultText(missing);
    assert.match(refusal, /no such file/, `the workspace's own reason was swallowed:\n${refusal}`);
    assert.match(refusal, /find_files|list_dir/, 'the refusal names no next move');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * ⚠️ AND AN EXECUTOR WITH NO `readFile` MUST REFUSE, NOT CRASH. The browser
 * builder implements this dispatcher's verbs over a Map and gained `deleteFile`
 * only because somebody remembered — `move_file` carries the same note. A
 * `TypeError` mid-round costs the round and tells the model nothing.
 */
test('⚠️ an executor that cannot read refuses in a sentence rather than throwing', async () => {
  const { executeToolCall } = await import('../lib/tools.mjs');
  const record = await executeToolCall(
    { id: 'c1', function: { name: 'review_code', arguments: JSON.stringify({ path: 'api.js' }) } },
    { root: '.', dryRun: false },
    {},
  );
  const out = toolResultText(record);
  assert.match(out, /^review_code failed/, 'a refusal must arrive as a refusal');
  assert.match(out, /Pass `content`/, 'the refusal does not name the way out');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. git — THE VERBS `git_status` WAS FIXED WITHOUT
 * ──────────────────────────────────────────────────────────────────────────── */

const DIFF = [
  'diff --git a/src/api.js b/src/api.js',
  '--- a/src/api.js',
  '+++ b/src/api.js',
  '@@ -1,4 +1,4 @@',
  '-  const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`);',
  "+  const rows = await db.query('SELECT * FROM users WHERE id = $1', [id]);",
].join('\n');

/**
 * ⚠️ A DIFF IS THE WORST POSSIBLE PAYLOAD FOR `JSON.stringify`: newlines,
 * quotes and backslashes are the three characters it escapes, and the `-`/`+`
 * column only means anything at the START OF A LINE — which is precisely what
 * `\n` destroys.
 */
test('⭐⭐ git_diff arrives as a diff, with its +/- column intact', () => {
  const out = toolResultText(rec('git_diff', {
    ok: true, staged: false, path: null, subdirectory: null, diff: DIFF, truncated: false, empty: false,
  }));
  assert.ok(!out.includes('\\n'), `the diff arrived JSON-escaped, so no line starts with + or -:\n${out.slice(0, 200)}`);
  assert.ok(
    out.split('\n').some((l) => l.startsWith('+  const rows')),
    'the added line does not start the line, so the model cannot tell an addition from a removal',
  );
  assert.match(out, /unstaged/, 'staged-vs-unstaged is the fact that decides whether the next call is git_commit');
});

/**
 * ⚠️ AN EMPTY DIFF IS THE ANSWER TO "DID MY EDIT APPLY?", so it must be a
 * sentence. `git.mjs` computes `empty` for exactly this and the JSON default
 * handed the model `"diff":"","empty":true` and a blank line to interpret.
 */
test('⚠️ an empty git_diff says NO CHANGES and names the next move', () => {
  const out = toolResultText(rec('git_diff', {
    ok: true, staged: false, path: null, subdirectory: null, diff: '', truncated: false, empty: true,
  }));
  assert.match(out, /NO CHANGES/, 'a blank diff reads to the model as "the tool returned nothing"');
  assert.match(out, /staged/, 'the next move — look at the staged diff — is not named');
});

/**
 * ⚠️ TWO DIFFERENT CUTS, NAMED SEPARATELY. `truncated` is GIT's (it stopped
 * emitting inside `git.mjs`); our clamp is ours. Collapsing them tells a model
 * that narrowing the path cannot help, when for our cut it always can.
 */
test('⭐ a clamped git_diff says how much was cut AND how to get the rest', () => {
  const out = toolResultText(rec('git_diff', {
    ok: true,
    staged: false,
    path: null,
    subdirectory: null,
    diff: `${DIFF}\n${'+ a line of change\n'.repeat(2_000)}`,
    truncated: true,
    empty: false,
  }));
  assert.match(out, /characters of this diff were omitted/, 'the model was not told the diff was cut');
  assert.match(out, /git_diff again with a `path`/, 'a truncation with no stated next move is a dead end');
  assert.match(out, /git itself stopped emitting/, "git's own cut was collapsed into ours — narrowing cannot fix that one");
  assert.ok(out.length < 9_000, `${out.length} chars — this is re-sent on every later round`);
});

test('⭐ git_log renders one line per commit, not an array of objects', () => {
  const out = toolResultText(rec('git_log', {
    ok: true,
    empty: false,
    subdirectory: null,
    commits: [
      { hash: 'd20a8671cafe', author: 'Roman', when: '2 hours ago', subject: 'wire the formatters' },
      { hash: '9f0e410951ab', author: 'Roman', when: '3 hours ago', subject: 'doctrine: the whiteboard' },
    ],
  }));
  assert.ok(!out.includes('"hash"'), 'the raw field names are back — this is an envelope');
  assert.match(out, /wire the formatters/, 'the subject is the only part of a log entry anybody reads');
  assert.match(out, /2 commits/, 'the count went missing');
});

test('⚠️ an empty git_log is a sentence, not "commits: []"', () => {
  const out = toolResultText(rec('git_log', { ok: true, commits: [], empty: true, subdirectory: null }));
  assert.match(out, /no commits yet/i);
  assert.ok(!out.includes('[]'), 'an empty array reads as a bug in the tool');
});

test('⭐ git_commit leads with the hash and the honest file count', () => {
  const out = toolResultText(rec('git_commit', {
    ok: true, hash: 'cb29c59', message: 'parameterise the query', files: ['src/api.js', 'sales.csv'], fileCount: 2,
  }));
  assert.match(out, /cb29c59/, 'the hash is what a human is asked for next');
  assert.match(out, /2 files/, 'fileCount differs from the paths asked for whenever one was already clean');
  assert.ok(!out.includes('"files"'), 'raw field names are back');
});

/**
 * ⭐ THE PULL REQUEST URL IS THE ONE FACT A HUMAN WILL BE ASKED FOR, and it sat
 * inside a nested object behind field names the model had to dig through.
 */
test('⭐ git_push puts the pull request URL on its own line', () => {
  const out = toolResultText(rec('git_push', {
    ok: true,
    remote: 'origin',
    branch: 'friend/12-thing',
    output: '* [new branch] friend/12-thing -> friend/12-thing',
    pullRequest: { ok: true, number: 41, url: 'https://github.com/x/y/pull/41', base: 'main' },
    nextSteps: [],
  }));
  assert.match(out, /https:\/\/github\.com\/x\/y\/pull\/41/, 'the PR url is the deliverable');
  assert.match(out, /#41/);
});

test('⚠️ a push that succeeded with NO pull request says so loudly', () => {
  const out = toolResultText(rec('git_push', {
    ok: true,
    remote: 'origin',
    branch: 'b',
    output: '',
    pullRequest: { ok: false, error: 'a pull request already exists for this branch' },
    nextSteps: [],
  }));
  assert.match(out, /NO pull request/, 'the model will report a PR it never opened');
  assert.match(out, /already exists/, "github's own reason was dropped");
});

/**
 * ⚠️ `executeWorktree` already BUILDS `summary` with `formatWorktrees` — and the
 * JSON default sent the `worktrees` array beside it. The catalogue-twice defect
 * `list_engines` is already fixed for.
 */
test('⚠️ git_worktree does not send the list as both an array and a rendering', () => {
  const out = toolResultText(rec('git_worktree', {
    ok: true,
    worktrees: [{ path: '/tmp/wt/auth-fix', branch: 'acuvo/auth-fix', head: 'abc' }],
    summary: 'auth-fix — /tmp/wt/auth-fix on acuvo/auth-fix',
  }));
  assert.ok(!out.includes('"branch":'), 'the array is back alongside the rendering it duplicates');
  assert.match(out, /auth-fix/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE WRITING VERBS
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `write_file` has had a one-line rendering since the beginning; `edit_file` —
 * the verb every prompt in this repo tells the model to PREFER — never got one.
 */
test('⭐⭐ edit_file renders as a sentence with the before/after size', () => {
  const out = toolResultText(rec('edit_file', {
    ok: true, path: 'src/api.js', bytes: 420, replacedChars: 68, fileChars: 400, created: false, previousBytes: 400, dryRun: false,
  }));
  assert.ok(!out.includes('{"ok":'), 'it fell back to the JSON default');
  assert.match(out, /src\/api\.js/);
  assert.match(out, /400 → 420 bytes/, 'the size change is how the model confirms the edit was the size it meant');
});

/** ⚠️ A model told "edited app.js" when nothing was written builds on a change that does not exist. */
test('⚠️ edit_file still says it was a DRY RUN', () => {
  const out = toolResultText(rec('edit_file', {
    ok: true, path: 'src/api.js', bytes: 420, replacedChars: 68, fileChars: 400, dryRun: true,
  }));
  assert.match(out, /DRY RUN/);
  assert.match(out, /NOT edited/);
});

/**
 * ⚠️⚠️ THE SUITE ASKED FOR THIS IN WRITING AND NOBODY ANSWERED.
 * `apply-patch-tool.test.mjs` carries: *"IT IS NOT YET WIRED: `turn.mjs`'s
 * `toolResultText` needs one `case 'apply_patch'` arm, and that file is not this
 * lane's to edit."* A note in a test is not a wire.
 */
test('⭐⭐ apply_patch warns about a LOOSE HUNK MATCH, which JSON buried', () => {
  const out = toolResultText(rec('apply_patch', {
    ok: true,
    written: [{ path: 'a.js', bytes: 40, created: false }, { path: 'new.js', bytes: 12, created: true }],
    looseMatches: [{ path: 'a.js', pass: 'trim' }],
  }));
  assert.ok(!out.includes('"looseMatches"'), 'the warning is back inside a field name models read straight past');
  assert.match(out, /differs\s+from the one on disk|matched only after/, 'the stale-copy warning was lost');
  assert.match(out, /2 files changed/);
});

test('⭐ apply_patch still says it was a dry run', () => {
  const out = toolResultText(rec('apply_patch', { ok: true, written: [{ path: 'a.js', bytes: 4, dryRun: true }] }));
  assert.match(out, /nothing was written/i);
});

test('⭐ move_file names both ends and survives a dry run', () => {
  assert.match(
    toolResultText(rec('move_file', { ok: true, from: 'a.js', to: 'b.js', bytes: 40, replaced: false })),
    /a\.js → b\.js/,
  );
  assert.match(
    toolResultText(rec('move_file', { ok: true, from: 'a.js', to: 'b.js', bytes: 40, replaced: true, dryRun: true })),
    /DRY RUN/,
  );
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE READS THAT SENT THEIR PAYLOAD TWICE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️⚠️ `tools.mjs:3558` builds `{ ...result, text: formatResults(result) }`, so
 * the reply carried the ranked list as an ARRAY and the same rows again as
 * rendered prose — and the default sent both. That is the `list_engines` and
 * `transcribe` defect, on the one verb whose payload is other people's prose.
 */
test('⚠️⚠️ web_search does not put the results in the prompt twice', () => {
  const results = Array.from({ length: 8 }, (_, i) => ({
    title: `Result ${i}`, url: `https://example.com/${i}`, snippet: 'the snippet that repeats',
  }));
  const text = `8 results from duckduckgo:\n${results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n')}`;
  const out = toolResultText(rec('web_search', { ok: true, provider: 'duckduckgo', results, text }));
  assert.ok(!out.includes('"url":'), 'the results array is back alongside the rendering it duplicates');
  const occurrences = out.split('https://example.com/3').length - 1;
  assert.equal(occurrences, 1, `the URL appears ${occurrences} times — the array is being sent as well as the text`);
  assert.match(out, /Result 3/, 'the rendered list must survive — it is the answer');
});

/**
 * ⭐ THE RENDERING IS KEPT AND THE ARRAY DROPPED, because the fallback warning
 * — *"a degraded chain has to LOOK degraded"* — exists ONLY in `formatResults`'
 * output.
 */
test('⭐ a degraded web_search still announces itself', () => {
  const out = toolResultText(rec('web_search', {
    ok: true,
    provider: 'stackoverflow',
    results: [{ title: 'T', url: 'https://x/1', snippet: 's' }],
    tried: [{ provider: 'duckduckgo', why: 'bot check' }],
    text: 'note: duckduckgo failed (bot check) — these results come from the fallback, so coverage is narrower than usual.\n1 result from stackoverflow:\n1. T\n   https://x/1',
  }));
  assert.match(out, /fallback/, 'a thin fallback result presented as the whole web is the failure this exists for');
});

/**
 * ⚠️ `read_document` returns `pages[]` each carrying a `text`, AND a `text` that
 * is those same pages joined. On a hundred-page document that is the whole
 * document twice, in an APPEND-ONLY history.
 */
test('⚠️⚠️ read_document does not put the document in the prompt twice', () => {
  const line = 'the clause that decides the whole contract';
  const pages = Array.from({ length: 6 }, (_, i) => ({ page: i + 1, text: line }));
  const out = toolResultText(rec('read_document', {
    ok: true,
    path: 'contract.pdf',
    kind: 'pdf',
    pageCount: 12,
    pages,
    text: pages.map((p) => p.text).join('\n\n'),
    tables: [],
    tablesTruncated: false,
    ocrPages: [],
    notes: [],
    truncated: false,
    nextPage: 7,
  }));
  const occurrences = out.split(line).length - 1;
  assert.equal(occurrences, pages.length, `the text appears ${occurrences} times for ${pages.length} pages — the blob is back`);
  assert.match(out, /page 3/, 'the page numbers must survive — "where does it say that" is the question people have');
  assert.match(out, /from_page 7/, 'the cursor for the remaining pages was lost, so the model stops at page 6');
});

/**
 * ⭐ A TABLE IS A GRID AND MUST ARRIVE AS ONE. Through JSON every cell paid for
 * two quotes and a comma and the ROW STRUCTURE was carried by brackets.
 */
test('⭐ read_table arrives as rows a model can copy, not as nested arrays', () => {
  const out = toolResultText(rec('read_table', {
    ok: true,
    path: 'invoice.png',
    count: 1,
    tables: [{
      rows: 40,
      cols: 3,
      confidence: 0.91,
      rowsReturned: 2,
      grid: [['item', 'qty', 'price'], ['widget', '2', '19.00']],
    }],
  }));
  assert.ok(!out.includes('[['), 'the nested arrays are back');
  assert.match(out, /item \| qty \| price/, 'the header row is not readable as a row');
  assert.match(out, /38 more row/, 'the model was not told 38 rows were withheld, so it will treat 2 as the table');
});

test('⚠️ "no table found" is an answer, and says not to ask again', () => {
  const out = toolResultText(rec('read_table', {
    ok: true, path: 'photo.png', count: 0, tables: [], note: 'no table was detected on photo.png',
  }));
  assert.match(out, /no table was detected/);
  assert.ok(!out.includes('"tables":[]'), 'an empty array invites the model to retry the identical call');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE VERBS THAT COMPUTED A VERDICT AND THEN HID IT
 * ──────────────────────────────────────────────────────────────────────────── */

/** ⭐ The status line is the answer. A model reading a body without knowing it came back 500 "fixes" the parsing. */
test('⭐ call_endpoint leads with the status, then the body', () => {
  const out = toolResultText(rec('call_endpoint', {
    ok: true,
    url: 'http://127.0.0.1:3000/api/users',
    method: 'GET',
    status: 500,
    statusText: 'Internal Server Error',
    class: 'server error',
    headers: { 'x-vercel-id': 'syd1::abc', 'content-type': 'application/json' },
    contentType: 'application/json',
    body: '{"error":"column \\"emial\\" does not exist"}',
    bytes: 44,
    truncated: false,
    sentHeaders: ['authorization'],
    durationMs: 12,
    note: 'a 500 is the server, not the request',
  }));
  assert.ok(out.startsWith('GET http://127.0.0.1:3000/api/users → 500'), `the status is not first:\n${out.slice(0, 120)}`);
  assert.match(out, /emial/, 'the body — the actual reason — must survive');
  assert.match(out, /sent headers: authorization/, 'the receipt that auth was sent is how a 401 is interpreted');
  assert.ok(!out.includes('x-vercel-id'), 'a dozen platform headers are never the reason and are pure tax');
});

/**
 * ⭐ `playtest` computes `summary` with `verdictLine` — the same
 * verdict-computed-and-never-read defect recorded for `see_page` at 7.9x.
 */
test('⭐ playtest reports its verdict and refuses to let "unmeasured" be claimed', () => {
  const out = toolResultText(rec('playtest', {
    ok: true,
    drove: true,
    driver: 'playwright',
    server: 'dev',
    url: 'http://localhost:3000',
    loaded: true,
    actions: 3,
    measured: ['the accessibility tree'],
    unmeasured: ['the mobile layout'],
    warnings: ['favicon 404'],
    problems: ['console error: Cannot read properties of undefined (reading "map")'],
    summary: '1 problem on http://localhost:3000',
  }));
  assert.ok(!out.includes('"problems"'), 'the raw field names are back');
  assert.match(out, /Cannot read properties of undefined/, 'the defect it drove the browser to find was dropped');
  assert.match(out, /NOT measured/, 'the model will claim it verified the mobile layout');
});

test('⚠️ a playtest whose page never loaded says so in capitals', () => {
  const out = toolResultText(rec('playtest', {
    ok: true, drove: true, driver: 'playwright', url: 'http://localhost:3000', loaded: false,
    actions: 0, measured: [], unmeasured: ['everything'], problems: ['the page did not load: ECONNREFUSED'],
    summary: 'the page did not load',
  }));
  assert.match(out, /PAGE DID NOT LOAD/);
});

test('⭐ chart names the file, the column types, and how to open it', () => {
  const out = toolResultText(rec('chart', {
    ok: true,
    path: 'sales.html',
    bytes: 12_349,
    dryRun: false,
    source: 'sales.csv',
    rows: 4,
    delimiter: ',',
    columns: [{ name: 'month', type: 'date', missing: 0 }, { name: 'revenue', type: 'number', missing: 1 }],
    panels: [{}, {}],
    warnings: [],
    open: 'open sales.html in a browser — it is self-contained and works offline',
  }));
  assert.ok(!out.includes('"panels"'), 'the panel objects are back and the model can do nothing with them');
  assert.match(out, /month \(date\)/, 'a column read as text when it is a date is what makes a chart wrong');
  assert.match(out, /self-contained/, 'the next move was dropped');
});

test('⚠️ chart still says it was a DRY RUN', () => {
  const out = toolResultText(rec('chart', { ok: true, path: 'sales.html', bytes: 0, dryRun: true, source: 'sales.csv', rows: 4 }));
  assert.match(out, /DRY RUN/);
  assert.match(out, /NOT written/);
});

/**
 * ⚠️ `formatSchema` and `formatRows` were written, exported and tested in
 * `db-inspect.mjs` with ZERO production callers — the third instance of the
 * failure this file's header records for `formatStatusForModel`.
 */
test('⭐ inspect_db uses the module\'s own formatter, not JSON', () => {
  const out = toolResultText(rec('inspect_db', {
    ok: true,
    source: 'files',
    approximate: true,
    tableCount: 1,
    totalTables: 1,
    tables: [{
      name: 'users', schema: null, kind: 'table', file: 'schema.sql',
      columns: [{ name: 'id', type: 'uuid', primaryKey: true, notNull: true, unique: false, default: null }],
      columnsTruncated: false, primaryKey: ['id'], foreignKeys: [], indexes: [],
    }],
    sources: [], notes: [], unapplied: [],
  }));
  assert.ok(!out.includes('"columns":'), 'a schema is nested three deep — the worst possible shape for JSON.stringify');
  assert.match(out, /users/);
  assert.match(out, /APPROXIMATE/, 'the "this was reconstructed, not read from a live database" warning is load-bearing');
});

test('⭐ sample_db_rows arrives as rows', () => {
  const out = toolResultText(rec('sample_db_rows', {
    ok: true, table: 'users', columns: ['id', 'email'], rows: [{ id: 1, email: 'a@b.c' }],
    rowCount: 1, limit: 5, withheld: [], note: null,
  }));
  assert.match(out, /id \| email/);
  assert.ok(!out.includes('{"id":'), 'the row objects are back');
});

/* ────────────────────────────────────────────────────────────────────────────
 * 7. THE COVERAGE GUARD
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️⚠️ THE ONE THAT CATCHES A DELETED `case`. Every test above asserts on a
 * sentence, so a reworded sentence breaks it and a DELETED case breaks it too —
 * but only for the verb that has a test. This one names the whole priority set
 * in one place, so a case removed in a refactor cannot slip through on a verb
 * whose sentence nobody happened to pin.
 *
 * ⭐ THE CHECK IS "IT DOES NOT LOOK LIKE AN ENVELOPE", not a length. It cannot
 * be satisfied by a stub, because a stub returning `''` fails the second
 * assertion and a stub returning the JSON fails the first.
 */
const PRIORITY = {
  /**
   * ── ⭐⭐⭐ THE FINAL NINETEEN, ADDED 2026-09-01 ─────────────────────────────
   *
   * `describeToolResult` now has a case for all 81 registered verbs and the
   * `default:` branch survives for MCP results alone — `mcp__<server>__<tool>`
   * is a name no case can ever match, which is exactly why the first two tests
   * in this file pin the default's budget rather than deleting it.
   *
   * ⚠️ AND THE AUDIT'S HONEST ANSWER: it looked for more bugs of the
   * `review_code` class among these nineteen and found NONE. Every one returns
   * an explicit `ok: true` and every refusal carries an `error`. Two traps were
   * found instead, and both are pinned by name further down: `viral`/`podcast`
   * answer a declined spend gate with `{ok:true, spent:false}`, and
   * `vercel_preview` returns `ok:true` beside a non-null `error`.
   */
  check_tools: { ok: true, programs: [{ name: 'rg', installed: false, runnable: false, enableWith: '--preset search' }], runnable: ['git'], presetsOn: [], shell: false, installs: 'off' },
  evaluate: { ok: true, source: 'x', exitCode: 1, timedOut: false, durationMs: 120, stdout: 'hi', stderr: 'Error: boom', passed: false },
  find_symbol: { ok: true, name: 'foo', definitions: [{ path: 'a.js', alsoDefines: ['bar'] }], total: 1, indexedFiles: 9 },
  make_document: { ok: true, path: 'd.pdf', bytes: 12, dryRun: false },
  pipe_to_asset: { ok: true, generated: true, edited: true, assetPath: 'a.png', bytes: 9, codePath: 'x.tsx', reference: '/a.png', provider: 'fal' },
  syndicate: { ok: true, slug: 's', dir: 'd', files: [{ path: 'p', kind: 'blog', bytes: 4 }], next: 'go' },
  viral: { ok: true, spent: true, title: 'P', dir: 'd', video: 'v.mp4', seconds: 30, files: ['v.mp4'] },
  podcast: { ok: true, spent: true, title: 'P', dir: 'd', episode: 'e.wav', seconds: 30, files: ['e.wav'] },
  remember: { ok: true, name: 'n', path: 'p', evicted: ['old'] },
  forget: { ok: true, name: 'n' },
  list_sessions: { ok: true, sessions: [{ id: 'a', savedAt: 't', roundsUsed: 3, resumable: true, summary: 'did stuff' }], unreadable: 0 },
  ask_user: { ok: true, answer: 'yes', answered: true },
  declare_acceptance: { ok: true, path: '.acuvo/a.json', criteria: [{ command: 'npm test' }], unrunnable: [] },
  gh_issue: { ok: true, verb: 'list', exitCode: 0, json: [{ n: 1 }], truncated: false },
  gh_pr: { ok: true, verb: 'list', exitCode: 0, text: 'nothing open', truncated: false },
  gh_run: { ok: true, verb: 'list', exitCode: 0, text: 'ok', checksFailing: true },
  vercel_preview: { ok: true, id: 'd1', readyState: 'READY', url: 'https://x.vercel.app', buildsSpent: 1 },
  profile_table: { ok: true, path: 't.csv', bytes: 10, delimiter: ',', rows: 5, columnCount: 1, columns: [{ name: 'a', type: 'integer', min: 1, max: 5, mean: 3, distinct: 5 }] },
  inspect_binary: { ok: true, path: 'f.png', bytes: 100, mode: 'identify', types: [{ name: 'PNG', mime: 'image/png', extension: 'png' }] },
  delegate: { ok: true, summary: 'wrote a module', written: ['a.js'], refused: [], roundsUsed: 2, tokens: 100, costUsd: 0.001 },
  git_diff: { ok: true, staged: false, path: null, subdirectory: null, diff: DIFF, truncated: false, empty: false },
  git_log: { ok: true, commits: [{ hash: 'abc1234', author: 'R', when: 'now', subject: 's' }], empty: false, subdirectory: null },
  git_commit: { ok: true, hash: 'abc1234', message: 'm', files: ['a.js'], fileCount: 1 },
  git_branch: { ok: true, branch: 'feature/x', created: true, switched: true, previous: 'main' },
  git_push: { ok: true, remote: 'origin', branch: 'b', output: 'ok', pullRequest: null, nextSteps: [] },
  git_worktree: { ok: true, worktrees: [], summary: 'no worktrees' },
  edit_file: { ok: true, path: 'a.js', bytes: 10, replacedChars: 2, fileChars: 9, previousBytes: 9, dryRun: false },
  move_file: { ok: true, from: 'a.js', to: 'b.js', bytes: 10, replaced: false },
  apply_patch: { ok: true, written: [{ path: 'a.js', bytes: 4 }], looseMatches: [] },
  web_search: { ok: true, provider: 'p', results: [{ title: 't', url: 'u', snippet: 's' }], text: '1 result from p:\n1. t\n   u' },
  read_document: { ok: true, path: 'a.pdf', kind: 'pdf', pageCount: 1, pages: [{ page: 1, text: 'hello' }], text: 'hello', tables: [], notes: [], truncated: false, nextPage: null },
  read_table: { ok: true, path: 'a.png', count: 1, tables: [{ rows: 1, cols: 2, confidence: 1, rowsReturned: 1, grid: [['a', 'b']] }] },
  chart: { ok: true, path: 'c.html', bytes: 10, dryRun: false, source: 's.csv', rows: 1, columns: [{ name: 'a', type: 'text' }], panels: [], warnings: [], open: 'open c.html' },
  call_endpoint: { ok: true, url: 'http://127.0.0.1:3000/', method: 'GET', status: 200, statusText: 'OK', class: 'ok', headers: {}, contentType: 'text/html', body: 'hi', bytes: 2, truncated: false, sentHeaders: [], durationMs: 1 },
  playtest: { ok: true, drove: true, driver: 'd', url: 'u', loaded: true, actions: 0, measured: [], unmeasured: [], problems: [], summary: 'clean' },
  inspect_db: { ok: true, source: 'files', tableCount: 0, totalTables: 0, tables: [], sources: [], notes: [], unapplied: [] },
  sample_db_rows: { ok: true, table: 't', columns: ['a'], rows: [{ a: 1 }], rowCount: 1, limit: 5, withheld: [], note: null },
};

test('⚠️⚠️ none of the priority verbs falls back into the JSON default', () => {
  const fellBack = [];
  for (const [name, result] of Object.entries(PRIORITY)) {
    const out = toolResultText(rec(name, result));
    if (out.trim().startsWith('{') || out.includes('{"ok":') || out.includes('"ok":true')) fellBack.push(name);
    assert.ok(out.trim().length > 0, `${name} rendered as an empty string — the model reads that as silence`);
  }
  assert.deepEqual(fellBack, [], `these verbs lost their case and are back on the JSON default: ${fellBack.join(', ')}`);
});

/**
 * ⭐ THE HONEST NUMBER, ASSERTED AS A FLOOR, AND READ OUT OF THE SOURCE.
 *
 * ⚠️ A BEHAVIOURAL PROBE DOES NOT WORK HERE and was tried first: handing every
 * verb a synthetic `{ ok: true }` throws inside the branches that trust their
 * own result shape (`list_dir` does `result.entries.map`), so "it threw" and
 * "it has a case" become indistinguishable from "it has none". Reading the
 * `case` labels is deterministic and is the pattern
 * `tools-registry-wiring.test.mjs` already uses on `tools.mjs`.
 *
 * ⚠️ A FLOOR, NOT AN EXACT COUNT, for `scripts/test.mjs`'s stated reason:
 * pinning the precise number fails every commit that ADDS a formatter, which is
 * a guard that fails correct work. 35 of 81 was the state before this lane.
 */
test('⭐ the formatted set only ever grows', async () => {
  const src = await readFile(new URL('../lib/turn.mjs', import.meta.url), 'utf8');
  const from = src.indexOf('function describeToolResult');
  const to = src.indexOf('export function tailLines', from);
  assert.ok(from > 0 && to > from, 'describeToolResult moved — this guard is now checking nothing');
  const cases = new Set([...src.slice(from, to).matchAll(/^\s*case '([a-z_0-9]+)':/gm)].map((m) => m[1]));

  const names = TOOL_SCHEMAS.map((t) => t.function?.name).filter(Boolean);
  const formatted = names.filter((n) => cases.has(n));
  assert.ok(
    formatted.length >= 78,
    `only ${formatted.length} of ${names.length} verbs have a formatted branch — it was 81 of 81 when this line `
    + `was written, 53 before the last batch, and 35 before the lane. Missing: ${names.filter((n) => !cases.has(n)).join(', ')}`,
  );

  /**
   * ⚠️ AND EVERY PRIORITY VERB BY NAME. The floor alone can be satisfied by
   * deleting `git_diff` and adding a formatter for something nobody calls.
   */
  for (const name of Object.keys(PRIORITY)) {
    assert.ok(cases.has(name), `${name} lost its case and is back on the JSON default`);
  }
});

/**
 * ⚠️ AND THE REFUSAL PATH IS UNTOUCHED. Every case above sits behind
 * `if (result.ok !== true) return "<name> failed: …"`, and a formatter that
 * accidentally swallowed a refusal would be far worse than the envelope it
 * replaced — the model would read a failure as a success and build on it.
 */
test('⚠️ a refusal still arrives as a refusal for every verb given a formatter', () => {
  for (const name of Object.keys(PRIORITY)) {
    const out = toolResultText(rec(name, { ok: false, error: 'the disk is full' }));
    assert.match(out, /the disk is full/, `${name} swallowed its own refusal`);
    assert.match(out, new RegExp(`^${name} failed`), `${name} did not announce the failure as one`);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE ENVELOPE IS GONE — AND THE TWO TRAPS THAT REPLACE IT
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ THIS ONE IS EXACT, NOT A FLOOR, AND THAT IS DELIBERATE.
 *
 * The floor above exists because pinning a count fails every commit that ADDS a
 * formatter. That argument stops applying at 81 of 81: there is nothing left to
 * add, so the only way this can go red is a NEW VERB shipped without one — and
 * failing that commit is the correct outcome, not a guard failing correct work.
 * The message tells the author exactly what to do.
 */
test('⭐⭐ every registered verb has a formatter — the JSON envelope survives for MCP only', async () => {
  const src = await readFile(new URL('../lib/turn.mjs', import.meta.url), 'utf8');
  const from = src.indexOf('function describeToolResult');
  const to = src.indexOf('export function tailLines', from);
  const cases = new Set([...src.slice(from, to).matchAll(/^\s*case '([a-z_0-9]+)':/gm)].map((m) => m[1]));
  const missing = TOOL_SCHEMAS.map((t) => t.function?.name).filter(Boolean).filter((n) => !cases.has(n));
  assert.deepEqual(
    missing, [],
    `${missing.join(', ')} reach the model as escaped JSON. Add a case to describeToolResult — `
    + 'every other verb has one, and a new verb arriving without one is what this pins.',
  );
});

/**
 * ── ⚠️⚠️ THE `review_code` TRAP, PRE-LOADED, IN TWO PLACES ──────────────────
 *
 * `review_code` returned no `ok` field, so every SUCCESSFUL review reached the
 * model as "review_code failed: unknown error" for as long as it existed. The
 * audit that fixed it went looking for more of the same class among the last
 * nineteen verbs and found none — but it found two results that are ONE
 * LOOSENED CONDITION away from being the identical bug, and a comment cannot
 * fail a build.
 */
test('⚠️⚠️ the failure funnel reads `ok` and ONLY `ok` — vercel_preview returns ok:true WITH an error', () => {
  /**
   * A deployment can fail while the tool call succeeds, and `vercel.mjs` says
   * so with `{ ok: true, error: <the deployment's message> }`. If anyone ever
   * "simplifies" the funnel to `result.error ? failed : ok`, every healthy
   * status call starts reporting itself as a broken tool.
   */
  const out = toolResultText(rec('vercel_preview', {
    ok: true, id: 'd1', readyState: 'ERROR', url: 'https://x.vercel.app', error: 'Command "npm run build" exited 1',
  }));
  assert.doesNotMatch(out, /^vercel_preview failed/, 'a successful tool call was reported to the model as a failed one');
  assert.match(out, /Command "npm run build" exited 1/, 'the deployment error was dropped');
  assert.match(out, /THE DEPLOYMENT/, 'nothing told the model which of the two things failed');
});

test('⚠️⚠️ a DECLINED spend gate is `ok:true, spent:false` — and it must not read as a finished video', () => {
  for (const name of ['viral', 'podcast']) {
    const out = toolResultText(rec(name, {
      ok: true, spent: false, title: 'T', dir: 'd', next: 'no credits remain on this account',
    }));
    assert.doesNotMatch(out, /^\w+ failed/, `${name} declined a spend and it was reported as a tool failure`);
    assert.match(out, /NOTHING WAS PRODUCED/, `${name} declined to spend and the model could not tell`);
    assert.match(out, /no credits remain/, `${name} dropped the reason the gate gave`);
  }
});

/**
 * ⚠️ A FORMATTER THAT THROWS TURNS A WORKING TOOL INTO A FAILED ONE, which is
 * exactly the damage this whole lane exists to undo. Every branch is handed the
 * emptiest result that can still reach it.
 */
test('⚠️⚠️ no formatter can kill the session — a throw degrades to the envelope and SAYS so', () => {
  /**
   * MEASURED: eleven of the 81 threw on `{ ok: true }` — `list_dir` on
   * `result.entries.map`, `run_command` on `result.stdout.trim`, the four LSP
   * verbs on `result.locations`, and so on. `toolResultText` is called from the
   * round loop with no `try` around it, so that was not a rendering bug: it
   * ended the run, mid-round, after the tool had already done its work.
   */
  for (const name of TOOL_SCHEMAS.map((t) => t.function?.name).filter(Boolean)) {
    let out;
    assert.doesNotThrow(
      () => { out = toolResultText(rec(name, { ok: true })); },
      `${name}'s formatter threw — that propagates out of the round loop and ends the session`,
    );
    assert.ok(out.trim().length > 0, `${name} rendered as an empty string, which the model reads as silence`);
  }

  /**
   * ⭐ AND THE DEGRADATION IS LOUD. A formatter that silently falls back
   * forever is how a rendering bug survives a year — this package's own
   * recorded pattern. The note must name the verb and must not let the model
   * conclude the TOOL failed.
   */
  const broken = toolResultText(rec('list_dir', { ok: true }));
  assert.match(broken, /could not be rendered/, 'the fallback happened silently');
  assert.match(broken, /the tool itself did NOT fail/, 'the model will read a rendering failure as a tool failure');
  assert.doesNotMatch(broken, /^list_dir failed/);
});
