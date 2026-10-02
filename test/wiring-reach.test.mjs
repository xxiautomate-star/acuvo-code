/**
 * ── ⭐⭐ THE ANTI-ORPHAN TEST — "A MODULE NOBODY IMPORTS IS NOT A FEATURE" ────
 *
 * This package's signature defect, found five times in one day: the capability
 * exists and the RUNTIME PATH DOES NOT REACH IT. 7,397 lines — 39% of the
 * package — once sat finished, tested and imported by nothing. A hardened
 * `editFile()` existed while the CLI dispatched around it to the unhardened one.
 *
 * ⚠️ EVERY OTHER TEST FILE HERE PROVES A MODULE IS CORRECT. This one proves a
 * module is REACHED — by spawning the real binary a user would type, or by
 * driving the real loop, and asserting the new behaviour comes out the far end.
 * A unit test on `lib/doctor.mjs` stays green forever while `--doctor` does not
 * exist; that is exactly the false green this file exists to make impossible.
 *
 * ⚠️ AND IT MUST NOT NEED A NETWORK, A KEY OR A CLOCK. Every assertion below
 * runs offline: the doctor is designed to work with `fetchImpl: null`, replay
 * reads a file this test writes, the design pass is driven in `--dry-run`, and
 * compaction is pure. A test that only passes on a configured machine is a test
 * that gets deleted the first week it fires in CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/** This test file's own directory — the package root is one level up. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

import { runSession, renderEvent, toolResultText } from '../lib/turn.mjs';
import { executeToolCall } from '../lib/tools.mjs';
import { MAX_ROUNDS_LIMIT_BUDGETED, MAX_ROUNDS_LIMIT } from '../lib/cli-args.mjs';

/**
 * ⚠️⚠️ SIGNED OUT, STATED EXPLICITLY. `...process.env, ACUVO_HOME: SIGNED_OUT_HOME` carries the developer's
 * real HOME, so on a machine where somebody has run `acuvo --login` the spawned
 * CLI gets a REAL account — and a signed-in run routes to our production gateway,
 * deliberately outranking the loopback test seam. The child then talks to
 * production instead of the stub and the assertions fail for a reason that has
 * nothing to do with the code.
 *
 * Measured 2026-08-23: seventeen tests went red the moment the product was used
 * for the first time.
 */
const SIGNED_OUT_HOME = join(tmpdir(), `acuvo-signed-out-${process.pid}`);

const CLI = fileURLToPath(new URL('../bin/acuvo.mjs', import.meta.url));

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 64;

/**
 * ⚠️ `input: ''` IS LOAD-BEARING. Interactive mode reads stdin; inheriting the
 * runner's would hang `node --test` forever on a terminal. An immediate EOF is
 * a pipe that ran out, which the chat loop treats as a clean end of session.
 *
 * ⚠️ AND THE MEDIA/KEY ENVIRONMENT IS SCRUBBED, not inherited. These assertions
 * are about REACHABILITY, not about whether this particular laptop happens to
 * have Modal configured — a test whose verdict depends on the developer's `.env`
 * is a test that means nothing in CI.
 */
function runCli(args, { key = null, cwd = undefined, env: extra = {} } = {}) {
  const env = { ...process.env, ACUVO_HOME: SIGNED_OUT_HOME, NO_COLOR: '1', ...extra };
  /**
   * ── ⚠️⚠️ EMPTY, NOT DELETED — `delete` IS DEFEATED BY OUR OWN .env LOADER ──
   *
   * `delete` leaves the variable ABSENT, and absent is exactly what
   * `bin/acuvo.mjs`'s `envLoad([root, cwd])` exists to fill: it calls
   * `process.loadEnvFile`, which fills an absent variable from `.env.local` and
   * leaves an existing one alone. MEASURED 2026-08-14:
   *
   *     was ''      -> loadEnvFile leaves it ''        (scrub holds)
   *     was absent  -> loadEnvFile sets it 'fromfile'  (scrub defeated)
   *
   * So on any machine with an `.env.local` beside the CLI, the scrub handed the
   * child back the very credentials it had just removed, and four tests in this
   * file failed by REACHING A LIVE SERVICE — `--design` really rendered a
   * screenshot and `--task-audio` really hit Modal. They were the only four
   * failures in a 1,947-test suite.
   *
   * ⭐ AND THIS FILE'S OWN HEADER PREDICTED IT: "a test whose verdict depends on
   * the developer's `.env` is a test that means nothing in CI". It had become
   * that test — the one guard for this package's signature defect class,
   * permanently red on the author's machine, training everyone to skip past it.
   *
   * ⭐ `''` IS NOT MERELY "NOT SET", IT IS THE DELIBERATE OFF SWITCH.
   * `lib/media.mjs`'s `withDefault` already distinguishes the two —
   * `k in env && trim() === ''` means OFF, unset means "use ours" — so an empty
   * string states the intent this scrub always had, and survives the file load.
   */
  for (const v of ['OPENROUTER_API_KEY', 'MODAL_TTS_URL', 'MODAL_TRANSCRIBE_URL', 'MODAL_PRESS_URL', 'RENDER_AUDIT_URL', 'MODAL_VIDEO_SECRET', 'PERCHANCE_IMAGE_URL']) {
    env[v] = '';
  }
  if (key !== null) env.OPENROUTER_API_KEY = key;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', input: '', timeout: 60_000, windowsHide: true, env, cwd,
  });
}

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'acuvo-wire-'));
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 1. --doctor  (lib/doctor.mjs)
 * ────────────────────────────────────────────────────────────────────────── */

test('⭐ --doctor is reachable and needs NO API key — the whole point of it', () => {
  const dir = tempWorkspace();
  try {
    const r = runCli(['--doctor', '--dir', dir], { key: null });
    // ⚠️ NOT "it exited 0". An unconfigured box legitimately reports broken
    // things; what must be true is that it RAN rather than demanding a key.
    assert.ok(!/OPENROUTER_API_KEY.*required|no API key/i.test(r.stderr ?? ''), `--doctor demanded configuration before answering: ${r.stderr}`);
    assert.match(r.stdout, /doctor/i, `--doctor printed no report. stdout=${JSON.stringify(r.stdout.slice(0, 300))} stderr=${JSON.stringify((r.stderr ?? '').slice(0, 300))}`);
    assert.match(r.stdout, /RUNTIME/, 'the report has no sections');
    // The section ids are the stable, greppable contract lib/doctor.mjs promises.
    assert.match(r.stdout, /model/i);
    assert.match(r.stdout, /media/i);
    // Every dark or broken line must name the variable that fixes it.
    assert.match(r.stdout, /MODAL_TTS_URL|OPENROUTER_API_KEY/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ --doctor --json emits exactly ONE object on stdout and nothing else', () => {
  const dir = tempWorkspace();
  try {
    const r = runCli(['--doctor', '--json', '--dir', dir], { key: null });
    assert.notStrictEqual(r.stdout.trim(), '', 'stdout was empty — --doctor --json must not be refused by the one-object guard');
    const doc = JSON.parse(r.stdout); // throws if prose leaked onto stdout
    assert.ok(Object.hasOwn(doc, 'ok'));
    assert.ok(Object.hasOwn(doc, 'summary'));
    assert.ok(Array.isArray(doc.sections) && doc.sections.length > 0);
    assert.strictEqual(typeof doc.summary.broken, 'number');
    assert.strictEqual(doc.ok, doc.summary.broken === 0, 'ok must equal "nothing is broken", as lib/doctor.mjs declares');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 2. --replay / --diff  (lib/replay.mjs)
 * ────────────────────────────────────────────────────────────────────────── */

/** A minimal saved run, in the shape lib/session.mjs writes. */
function writeSession(root, id, { task = 'add a healthcheck route', path = 'server.mjs' } = {}) {
  const dir = join(root, '.acuvo', 'sessions');
  mkdirSync(dir, { recursive: true });
  const record = {
    version: 1,
    id,
    savedAt: '2026-08-11T02:35:39.000Z',
    root,
    task,
    model: 'deepseek/deepseek-v4-flash',
    roundsUsed: 2,
    maxRounds: 5,
    stoppedBecause: 'verified',
    error: null,
    verification: { ran: true, passed: true, command: 'npm test' },
    usage: null,
    files: [path],
    commands: ['npm test'],
    resumable: true,
    truncated: false,
    droppedGroups: 0,
    droppedIncomplete: 0,
    redactions: 0,
    messages: [
      { role: 'system', content: 'you are acuvo' },
      { role: 'user', content: task },
      {
        role: 'assistant',
        content: 'writing it now',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path, content: 'export const ok = true;\n' }) } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'write_file', content: `created ${path} (24 bytes)` },
    ],
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

test('⭐ --replay <id> is reachable, runs NOTHING, and prints the timeline', () => {
  const dir = tempWorkspace();
  try {
    writeSession(dir, '20260811-023539-bg12');
    const r = runCli(['--replay', '20260811-023539-bg12', '--dir', dir], { key: null });
    assert.strictEqual(r.status, EXIT_OK, `--replay failed: ${r.stderr}`);
    assert.match(r.stdout, /write_file/, `the timeline never named the tool call. stdout=${JSON.stringify(r.stdout.slice(0, 400))}`);
    assert.match(r.stdout, /add a healthcheck route/);
    // ⚠️ Needs no key: reading a directory this tool wrote needs no account.
    assert.ok(!/OPENROUTER_API_KEY/.test(r.stderr ?? ''));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ --replay --json emits one object with the executed:false honesty flag', () => {
  const dir = tempWorkspace();
  try {
    writeSession(dir, '20260811-023539-bg12');
    const r = runCli(['--replay', '20260811-023539-bg12', '--json', '--dir', dir], { key: null });
    const doc = JSON.parse(r.stdout);
    assert.strictEqual(doc.ok, true);
    assert.strictEqual(doc.executed, false, 'a replay must state in the document that it ran nothing');
    assert.ok(Array.isArray(doc.steps) && doc.steps.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ --replay <a> --diff <b> names where two runs split', () => {
  const dir = tempWorkspace();
  try {
    writeSession(dir, '20260811-023539-aaaa', { path: 'server.mjs' });
    writeSession(dir, '20260811-024011-bbbb', { path: 'index.mjs' });
    const r = runCli(['--replay', '20260811-023539-aaaa', '--diff', '20260811-024011-bbbb', '--dir', dir], { key: null });
    assert.strictEqual(r.status, EXIT_OK, `--diff failed: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, 'the diff printed nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️ --replay with a missing value refuses rather than eating the next flag', () => {
  const r = runCli(['--replay', '--json'], { key: null });
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.strictEqual(r.stdout, '', 'a usage refusal must not put prose on stdout');
});

test('⚠️ --replay of an unknown id is a usage error naming how to list them', () => {
  const dir = tempWorkspace();
  try {
    const r = runCli(['--replay', 'nope', '--dir', dir], { key: null });
    assert.strictEqual(r.status, EXIT_USAGE);
    assert.match(r.stderr, /--sessions|no run/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 3. --design  (lib/design-loop.mjs)
 * ────────────────────────────────────────────────────────────────────────── */

test('⭐ --design is reachable and, with no renderer configured, says so by NAME', () => {
  const dir = tempWorkspace();
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title><h1>hi</h1>');
    const r = runCli(['--design', 'index.html', '--dir', dir], { key: null });
    // RENDER_AUDIT_URL is scrubbed by runCli, so this is the honest-refusal path.
    assert.strictEqual(r.status, EXIT_FAILED, `expected the unconfigured verdict, got ${r.status}: ${r.stderr}`);
    const all = `${r.stdout}${r.stderr}`;
    assert.match(all, /RENDER_AUDIT_URL/, `the failure must name the variable that fixes it: ${all.slice(0, 400)}`);
    // ⚠️ AND IT MUST NOT CLAIM AN ALL-CLEAR. designPass's whole contract is that
    // a look that did not happen makes no claim about the page.
    assert.ok(!/no problems|looks fine|all clear/i.test(all), `a failed look claimed the page was fine: ${all.slice(0, 400)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️ --design --json emits one object, never prose', () => {
  const dir = tempWorkspace();
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
    const r = runCli(['--design', 'index.html', '--json', '--dir', dir], { key: null });
    const doc = JSON.parse(r.stdout);
    assert.strictEqual(doc.ok, false);
    assert.strictEqual(typeof doc.verdict, 'string');
    // trustworthy:false — "we could not look" is never "it is fine".
    assert.notStrictEqual(doc.trustworthy, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 4. see_page → designPass verdict reaches the MODEL  (lib/design-loop.mjs
 *    through lib/tools.mjs AND lib/turn.mjs)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️⚠️ THIS TEST EXISTS BECAUSE ITS ABSENCE WAS CAUGHT BY A MUTATION. The
 * `toolResultText` test below stayed GREEN while `lib/tools.mjs` was reverted to
 * call the unhardened `seePage` — i.e. the whole design loop was unwired and the
 * suite said nothing. A verdict formatter with no verdict to format is the
 * package's signature bug wearing a passing test as a disguise.
 *
 * ⭐ THE DISCRIMINATOR IS A FIELD ONLY `designPass` PRODUCES. `seePage` returns
 * `ok/path/screenshot/findings`; `designPass` returns those PLUS `verdict`,
 * `trustworthy`, `checked` and `cost`. Asserting on one of those proves WHICH
 * implementation the dispatcher reached, which is the only thing in question.
 */
test('⭐⭐ the DISPATCHER reaches designPass, not the bare seePage underneath it', async () => {
  const dir = tempWorkspace();
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title><h1>hi</h1>');
    /**
     * ── 🚨💰⭐⭐⭐ THE COMMENT HERE WAS TRUE AND STOPPED BEING TRUE (2026-09-20) ─
     *
     * It read: *"RENDER_AUDIT_URL is deliberately absent: designPass never
     * throws and still produces a verdict on the honest-refusal path, so this
     * needs no network and no configured endpoint."* That was correct when
     * `renderVia` had ONE way in. It has had two since 2026-08-26 — unset
     * `RENDER_AUDIT_URL` now falls through to `accountRoute`, which reads
     * `~/.acuvo/credentials.json` and posts to `<gateway>/render` **on the
     * signed-in user's plan.**
     *
     * ⚠️ SO THIS TEST MADE A LIVE, BILLED RENDER CALL whenever it was run
     * outside `scripts/test.mjs`, which sets a throwaway `ACUVO_HOME` and is the
     * only reason it was ever green. `node --test test/wiring-reach.test.mjs` —
     * the invocation anyone reaches for to run one file — signs in as the
     * developer and spends their money. I ran it that way twice before noticing,
     * on a machine under a hard zero-spend rule.
     *
     * ⭐ THE ISOLATION IS NOW THE TEST'S OWN, not the runner's. `media.mjs`
     * already argues this exact point about `home` ("every test, for the reason
     * `renderVia`'s header records"); depending on an ambient env var for it is
     * the second place holding one opinion.
     */
    const before = process.env.RENDER_AUDIT_URL;
    const beforeHome = process.env.ACUVO_HOME;
    delete process.env.RENDER_AUDIT_URL;
    process.env.ACUVO_HOME = join(dir, '.throwaway-home');
    try {
      const record = await executeToolCall(
        { id: 'c1', function: { name: 'see_page', arguments: JSON.stringify({ path: 'index.html' }) } },
        { root: dir, dryRun: false },
        {},
      );
      assert.strictEqual(record.name, 'see_page');
      assert.strictEqual(typeof record.result.verdict, 'string', 'the result has no `verdict` — the dispatcher is calling seePage directly, so the design loop is unwired');
      assert.ok(Object.hasOwn(record.result, 'trustworthy'), 'the result has no `trustworthy` field, which only designPass produces');
      // ⚠️ AND A LOOK THAT FAILED MUST MAKE NO CLAIM ABOUT THE PAGE.
      assert.notStrictEqual(record.result.trustworthy, true);
      assert.ok(!/no problems|all clear/i.test(record.result.verdict), `a failed look claimed the page was fine: ${record.result.verdict}`);
    } finally {
      if (before !== undefined) process.env.RENDER_AUDIT_URL = before;
      if (beforeHome === undefined) delete process.env.ACUVO_HOME;
      else process.env.ACUVO_HOME = beforeHome;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⭐⭐⭐ the EYES\' verdict reaches the model as PROSE, not as escaped JSON', () => {
  /**
   * ⚠️⚠️ MEASURED 2026-08-28, BEFORE THE `case 'read_image'` EXISTED. `see_page`
   * was fixed for exactly this and `read_image` never was: a 191-character
   * verdict arrived as **352 characters of escaped JSON**, the observation
   * behind `\"` escapes among eight fields the model has no use for.
   *
   * ⭐ THIS IS WHAT MAKES THE SECOND MODEL WORTH PAYING FOR. Qwen can see and
   * DeepSeek cannot; the whole value is DeepSeek acting on what Qwen saw. A
   * verdict computed and then handed over as JSON is the design-loop failure
   * this file already records once.
   */
  const verdict = 'The heading reads "Wecome" — misspelled. The button overlaps the hero by ~12px.';
  const text = toolResultText({
    name: 'read_image',
    result: {
      ok: true, path: 'shot.png', text: verdict, model: 'qwen/qwen3.7-flash',
      mime: 'image/png', width: 1280, height: 800, approxImageTokens: 1365, costUsd: 0.000234,
    },
  });

  assert.ok(!text.startsWith('{'), 'the model is being handed raw JSON again');
  assert.ok(text.includes(verdict), 'the verdict itself must survive intact');
  assert.ok(!text.includes('\\"'), 'the quotes are escaped — this is JSON wearing a costume');
  // ⭐ The path and size are named: "overlaps by 12px" is not actionable without them.
  assert.ok(text.includes('shot.png') && text.includes('1280x800'));
  // ⚠️ And the bookkeeping fields must NOT be spent on prompt tokens.
  for (const noise of ['costUsd', 'approxImageTokens', 'mime', 'qwen/qwen3.7-flash']) {
    assert.ok(!text.includes(noise), `${noise} is bookkeeping, not something the model can act on`);
  }

  /**
   * ⚠️ AND AN ABSTENTION MUST ARRIVE AS ONE. `vision.mjs` refuses rather than
   * guessing precisely so the model never describes an image it did not see;
   * a refusal rendered as anything softer would re-open that hole.
   */
  const failed = toolResultText({ name: 'read_image', result: { ok: false, error: 'no OPENROUTER_API_KEY, so there is nothing that can look at this image.' } });
  assert.match(failed, /^read_image failed: /);
  assert.ok(!failed.includes('LOOKED AT'), 'a failed look must not read as a look');
});

test('⭐⭐ toolResultText hands the model the VERDICT, not 205 tokens of escaped JSON', () => {
  const verdict = 'LOOKED AT index.html at 1280x800. No problems found in: contrast, overflow.';
  const text = toolResultText({
    name: 'see_page',
    result: { ok: true, path: 'index.html', screenshot: '.acuvo/see/x.png', findings: [], verdict },
  });
  assert.strictEqual(text, verdict, 'the see_page result must render as its verdict — without this the module computes it and the model never reads it');
  // The pre-wiring behaviour was JSON.stringify of the whole record.
  assert.ok(!text.startsWith('{'), 'the model is being handed raw JSON again');
});

test('⚠️ a see_page result with NO verdict still renders something usable', () => {
  const text = toolResultText({ name: 'see_page', result: { ok: true, path: 'a.html', findings: ['x'] } });
  assert.ok(text.length > 0);
  assert.match(text, /a\.html/);
});

test('⚠️ a FAILED see_page still renders as a failure, not as an empty verdict', () => {
  const text = toolResultText({ name: 'see_page', result: { ok: false, error: 'RENDER_AUDIT_URL is not set' } });
  assert.match(text, /failed/);
  assert.match(text, /RENDER_AUDIT_URL/);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 5. COMPACTION INSIDE THE LOOP  (lib/compact.mjs through lib/turn.mjs)
 *    Not a flag. Driven through the real runSession with a stub transport.
 * ────────────────────────────────────────────────────────────────────────── */

/** A conversation far over the 24,000-token budget, in the shape the loop keeps. */
function bloatedPriorMessages() {
  const huge = 'x'.repeat(40_000); // ~10,000 tokens each
  const out = [
    { role: 'system', content: 'you are acuvo' },
    { role: 'user', content: 'read everything' },
  ];
  for (let i = 0; i < 26; i += 1) {
    out.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `big${i}.txt` }) } }],
    });
    out.push({ role: 'tool', tool_call_id: `c${i}`, name: 'read_file', content: `big${i}.txt (40000 bytes):\n${huge}` });
  }
  out.push({ role: 'assistant', content: 'done reading' });
  return out;
}

test('⭐⭐ the loop COMPACTS an over-budget history BEFORE it pays for the call', async () => {
  const dir = tempWorkspace();
  try {
    const seen = [];
    const events = [];
    const outcome = await runSession({
      task: 'now summarise it',
      priorMessages: bloatedPriorMessages(),
      executor: { root: dir, dryRun: true, readFile: () => ({ ok: false, error: 'no' }), writeFile: () => ({ ok: false, error: 'no' }), listDir: () => ({ ok: false, error: 'no' }) },
      config: { apiKey: 'k', model: 'm' },
      maxRounds: 1,
      allowRun: false,
      onEvent: (e) => events.push(e),
      callModelImpl: async ({ messages }) => {
        // ⚠️ MEASURED AT THE TRANSPORT — the only place that proves compaction
        // happened BEFORE the call rather than after it, which is the entire
        // point of where it is wired.
        seen.push(messages.map((m) => (typeof m.content === 'string' ? m.content.length : 0)).reduce((a, b) => a + b, 0));
        return { ok: true, content: 'ok', toolCalls: [], usage: null, finishReason: 'stop' };
      },
    });
    assert.strictEqual(outcome.ok, true, `session failed: ${outcome.error}`);
    assert.strictEqual(seen.length, 1);
    // 26 x 40,000 chars went in. ⚠️ WAS 6 — the ceiling moved from 24,000 to
    // 96,000 estimated tokens (a cache-hit is ~50x a miss, and compacting at 2.3%
    // of a 1M window was a six-fold loss), so a fixture sized for the old budget
    // no longer triggers compaction at all and proved nothing.
    assert.ok(seen[0] < 1_040_000, `the transport still received ${seen[0]} characters — compaction did not run before the call`);

    const compact = events.find((e) => e.type === 'compact');
    assert.ok(compact, 'no `compact` event was emitted — silent compaction is indistinguishable from amnesia');
    assert.ok(compact.report.freedTokens > 0, 'the event claimed a compaction that freed nothing');
    assert.ok(Array.isArray(compact.report.lines) && compact.report.lines.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ an UNDER-budget conversation is untouched and emits no compact event', async () => {
  const dir = tempWorkspace();
  try {
    const events = [];
    let received = null;
    await runSession({
      task: 'hello',
      priorMessages: [
        { role: 'system', content: 'you are acuvo' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      executor: { root: dir, dryRun: true, readFile: () => ({ ok: false, error: 'no' }), writeFile: () => ({ ok: false, error: 'no' }), listDir: () => ({ ok: false, error: 'no' }) },
      config: { apiKey: 'k', model: 'm' },
      maxRounds: 1,
      allowRun: false,
      onEvent: (e) => events.push(e),
      callModelImpl: async ({ messages }) => {
        received = messages.map((m) => m.content);
        return { ok: true, content: 'ok', toolCalls: [], usage: null, finishReason: 'stop' };
      },
    });
    assert.deepStrictEqual(received, ['you are acuvo', 'hi', 'hello', 'hello']);
    assert.strictEqual(events.filter((e) => e.type === 'compact').length, 0, 'a short conversation must cost nothing and say nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️ the `compact` event PRINTS — an event printer that falls through is silent amnesia', () => {
  const lines = renderEvent({
    type: 'compact',
    round: 4,
    report: {
      method: 'structural compaction (every token figure is an estimate: chars/4)',
      beforeTokens: 61_000, afterTokens: 21_000, freedTokens: 40_000, freedPercent: 65,
      underBudget: true, dropped: 3,
      lines: ['compacted the history: 61,000 → 21,000 estimated tokens (65% freed)'],
    },
  });
  assert.ok(lines.length > 0, 'renderEvent returned nothing for a `compact` event');
  assert.match(lines.join('\n'), /compact/i);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 6. --task-audio / --say  (lib/voice-task.mjs)
 * ────────────────────────────────────────────────────────────────────────── */

test('⭐ --task-audio is reachable and names MODAL_TRANSCRIBE_URL when it is absent', () => {
  const dir = tempWorkspace();
  try {
    writeFileSync(join(dir, 'note.wav'), 'not really audio');
    const r = runCli(['--task-audio', 'note.wav', '--yes', '--dir', dir], { key: 'sk-or-v1-deliberately-invalid' });
    // 2 = not configured. The point is that it REACHED voice-task, not parseArgv.
    assert.strictEqual(r.status, 2, `expected the unconfigured exit, got ${r.status}. stderr=${r.stderr}`);
    assert.match(r.stderr, /MODAL_TRANSCRIBE_URL/);
    assert.ok(!/unknown option|unrecognised/i.test(r.stderr), '--task-audio never reached the voice module');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️ --task-audio --json is NOT refused by the one-object guard', () => {
  const dir = tempWorkspace();
  try {
    writeFileSync(join(dir, 'note.wav'), 'x');
    const r = runCli(['--task-audio', 'note.wav', '--yes', '--json', '--dir', dir], { key: 'sk-or-v1-deliberately-invalid' });
    // Without the guard fix this dies at EXIT_USAGE with "must run one task".
    assert.notStrictEqual(r.status, EXIT_USAGE, `--task-audio --json was refused before transcribing: ${r.stderr}`);
    assert.match(r.stderr, /MODAL_TRANSCRIBE_URL/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⚠️ --task-audio with a missing value refuses rather than eating the next flag', () => {
  const r = runCli(['--task-audio', '--json'], { key: null });
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /--task-audio/);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 7. --help IS THE FRONT DOOR. A capability only the changelog knows about is
 *    the same orphan by another name.
 * ────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ every new flag appears in --help', () => {
  const r = runCli(['--help'], { key: null });
  assert.strictEqual(r.status, EXIT_OK);
  for (const flag of ['--doctor', '--replay', '--diff', '--only', '--design', '--task-audio', '--say', '--yes', '--sessions', '--resume']) {
    assert.match(r.stdout, new RegExp(flag.replace(/-/g, '\\-')), `--help never mentions ${flag}`);
  }
});

/**
 * ── ⚠️ `OPENROUTER_API_KEY` LEFT THIS LIST 2026-08-25 ───────────────────────
 *
 * The rest of the list is unchanged and the test's purpose is intact: a media
 * variable that is READ but never DOCUMENTED is what made four tools look
 * broken, and that is still guarded.
 *
 * ⭐ THE SUPPLIER KEY IS A DIFFERENT KIND OF VARIABLE AND WAS THE ODD ONE OUT
 * HERE ALL ALONG. The Modal entries tell an owner how to turn on a capability
 * they have paid for. The supplier key told everyone reading `--help` the name
 * of who we buy from and how to route around us — on the surface people read
 * while deciding whether to subscribe. Roman: *"we don't want to advertise our
 * business mechanics — we might as well say: don't pay for us, just pay directly
 * to these guys."*
 *
 * ⚠️ NOT DELETED, MOVED. `lib/model.mjs` still reads the variable, and both
 * `--doctor` and `--whoami` report the credential actually in force — so someone
 * who has it exported still finds out, from a diagnostic they chose to run.
 */
test('⭐ --help documents EVERY media variable, including MODAL_VIDEO_SECRET', () => {
  const r = runCli(['--help'], { key: null });
  for (const v of ['RENDER_AUDIT_URL', 'MODAL_TTS_URL', 'MODAL_TRANSCRIBE_URL', 'MODAL_PRESS_URL', 'MODAL_VIDEO_SECRET']) {
    assert.match(r.stdout, new RegExp(v), `--help never mentions ${v} — its absence is what made four tools look broken`);
  }
  assert.ok(
    !/OPENROUTER_API_KEY/.test(r.stdout),
    'the supplier key is back in --help, which is a shipped surface read by people deciding whether to pay us',
  );
});

test('⚠️ the usage line is a command a user would actually type', () => {
  const r = runCli(['--help'], { key: null });
  assert.ok(!/node acuvo-code\/bin\/acuvo\.mjs/.test(r.stdout), 'the usage line still shows the dev invocation nobody installs');
  assert.match(r.stdout, /^\s+acuvo "/m, 'the usage line must show `acuvo "<task>"`');
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 8. THE HORIZON. Compaction is what makes a higher ceiling safe.
 * ────────────────────────────────────────────────────────────────────────── */

test('⭐ the round ceiling was raised now that the history is bounded', () => {
  assert.ok(MAX_ROUNDS_LIMIT > 8, `MAX_ROUNDS_LIMIT is still ${MAX_ROUNDS_LIMIT}`);
  const r = runCli(['--max-rounds', String(MAX_ROUNDS_LIMIT), '--dir', tempWorkspace(), 'x'], { key: null });
  // Unconfigured, so it stops at the key check — but NOT at "1-8".
  assert.ok(!/between 1 and/.test(r.stderr ?? ''), `--max-rounds ${MAX_ROUNDS_LIMIT} was rejected by the parser`);
});

test('⚠️ one past the ceiling is still refused — but WHICH ceiling now depends on the budget', () => {
  /**
   * ── ⚠️ UPDATED 2026-08-23 WHEN THE LONG-HORIZON CEILING WAS LIFTED ─────
   *
   * This asserted a single fixed number, and the number moved for a reason:
   * money bounds every ordinary run (`DEFAULT_BUDGET_USD`, checked before each
   * round), so the round count is a runaway backstop rather than the thing
   * protecting the bill.
   *
   * ⭐ THE TEST'S INTENT IS PRESERVED EXACTLY — a number past the ceiling is
   * still refused, and the refusal still names the real number. What changed is
   * that there are now two ceilings, and the low one is the case that actually
   * needs defending: `--budget none` removes the money governor, so rounds are
   * all that is left.
   */
  const budgeted = runCli(['--max-rounds', String(MAX_ROUNDS_LIMIT_BUDGETED + 1), 'x'], { key: null });
  assert.strictEqual(budgeted.status, EXIT_USAGE);
  assert.match(budgeted.stderr, new RegExp(`between 1 and ${MAX_ROUNDS_LIMIT_BUDGETED}`));

  // With the money governor removed, the OLD low ceiling still applies.
  const unbudgeted = runCli(['--max-rounds', String(MAX_ROUNDS_LIMIT + 1), '--budget', 'none', 'x'], { key: null });
  assert.strictEqual(unbudgeted.status, EXIT_USAGE);
  assert.match(unbudgeted.stderr, /needs a budget to bound it/);
});

test('⭐⭐⭐ a long-horizon run is allowed when a budget is bounding it', () => {
  /**
   * Roman, 2026-08-23: *"yes we need long horizon ceiling gone."* Measured the
   * same day: a bench task ran every round it was given and stopped at
   * `round-cap` rather than failing — a cap that is REACHED is a cap deciding
   * the outcome.
   */
  const r = runCli(['--max-rounds', '500', '--dir', tempWorkspace(), 'x'], { key: null });
  assert.ok(!/between 1 and/.test(r.stderr ?? ''), '--max-rounds 500 was rejected by the parser');
  assert.ok(!/needs a budget/.test(r.stderr ?? ''), 'the default budget should already bound this');
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 9. REGRESSION. A user who passes NO new flag must see what they saw before.
 * ────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ no new flag ⇒ nothing changed: the ordinary refusals are byte-identical', () => {
  const dir = tempWorkspace();
  try {
    const noKey = runCli(['do a thing', '--dir', dir], { key: null });
    assert.strictEqual(noKey.status, 2);
    assert.strictEqual(noKey.stdout, '', 'the unconfigured path must still put nothing on stdout');

    const badDir = runCli(['--dir', '', 'x'], { key: 'sk-x' });
    assert.strictEqual(badDir.status, EXIT_USAGE);
    assert.match(badDir.stderr, /--dir was given an empty value/);

    const par = runCli(['--json', '--parallel', 'a', 'b'], { key: 'sk-x' });
    assert.strictEqual(par.stdout, '');
    assert.strictEqual(par.status, EXIT_USAGE);
    assert.match(par.stderr, /run one task per invocation/);

    const ver = runCli(['--version'], { key: null });
    assert.strictEqual(ver.status, EXIT_OK);
    assert.match(ver.stdout, /^acuvo-code \d+\.\d+\.\d+\n$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ --sessions still works and still needs no key', () => {
  const dir = tempWorkspace();
  try {
    writeSession(dir, '20260811-023539-bg12');
    const r = runCli(['--sessions', '--json', '--dir', dir], { key: null });
    const doc = JSON.parse(r.stdout);
    assert.ok(Array.isArray(doc.sessions));
    assert.strictEqual(doc.sessions.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 10. THE BUNDLER IS REACHABLE AS A COMMAND (scripts/bundle.mjs)
 * ────────────────────────────────────────────────────────────────────────── */

test('⭐ `npm run bundle` exists and points at the real script', async () => {
  const pkg = JSON.parse(
    await import('node:fs/promises').then((fs) => fs.readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')),
  );
  assert.ok(pkg.scripts.bundle, 'package.json has no "bundle" script — the bundler is a file nobody can run');
  assert.match(pkg.scripts.bundle, /scripts\/bundle\.mjs/);
  assert.ok(pkg.scripts['bundle:mcp'], 'the MCP entry point has no bundle script');
});

// ── ⭐⭐ THE IMPORT GRAPH ITSELF ────────────────────────────────────────────

test('every module is reachable from a real entry point, or is named here', async () => {
  /**
   * ⚠️⚠️ THIS PACKAGE'S SIGNATURE FAILURE IS NOT BAD CODE, IT IS GOOD CODE
   * NOBODY CONNECTED. 7,397 lines (39%) once sat finished, documented and
   * unit-tested while imported by nothing; `budget.mjs`, `lease.mjs`,
   * `repo-map.mjs`, `stuck.mjs` and `best-of.mjs` all lived there. Measured
   * again 2026-08-12 and `policy.mjs` — 736 lines of admin control, the
   * enterprise checklist item most likely to be asked about — was reachable
   * from nothing but its own test.
   *
   * ⭐ Every previous guard tested a MODULE. This one tests the GRAPH: it walks
   * imports from the two binaries and fails on anything it cannot reach. A
   * module that unit-tests perfectly and is imported by nobody now has
   * somewhere to fail.
   *
   * ⚠️ THE ALLOWLIST IS THE HONEST PART. Two modules are genuinely not wired
   * yet; naming them here makes that a recorded decision instead of a silent
   * fact, and adding a third requires someone to type its name.
   */
  const { readdirSync, readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

  const files = [
    ...readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => `lib/${f}`),
    ...readdirSync(path.join(root, 'bin')).filter((f) => f.endsWith('.mjs')).map((f) => `bin/${f}`),
  ];

  const imports = {};
  for (const f of files) {
    const src = readFileSync(path.join(root, f), 'utf8');
    /**
     * ⚠️ THREE KINDS OF EDGE, AND ONLY THE FIRST IS OBVIOUS.
     * `import … from './x.mjs'` is the easy one. But a file can also be
     * referenced as a SUBPROCESS ENTRY POINT — `new URL('./repl-driver.mjs',
     * import.meta.url)` handed to `spawn` — which is every bit as wired as an
     * import and invisible to a naive walk. Caught by this guard flagging
     * `repl-driver.mjs` the hour it shipped: the honest fix is to see the edge,
     * not to add an excuse for it.
     *
     * ⭐ AND THE THIRD, ADDED 2026-08-19 FOR THE SAME REASON: a DYNAMIC
     * `await import('./x.mjs')`. `bin/acuvo.mjs` loads the login, account and
     * doctor modules that way on purpose — they are needed by one flag each, so
     * importing them statically would pay their parse cost on every single run
     * of a CLI whose startup time a user feels.
     *
     * ⚠️ A lazily-loaded module is not an unreachable one, and treating it as
     * one would push a correctly-wired file onto `KNOWN_UNWIRED` — turning an
     * allowlist that exists to SHRINK into the place where real wiring goes to
     * be forgotten. Third pattern, same principle: see the edge.
     */
    const rel = (spec) => path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
    imports[f] = [...new Set([
      ...[...src.matchAll(/from '(\.[^']+)'/g)].map((m) => rel(m[1])),
      ...[...src.matchAll(/new URL\('(\.[^']+)',\s*import\.meta\.url\)/g)].map((m) => rel(m[1])),
      ...[...src.matchAll(/\bimport\('(\.[^']+)'\)/g)].map((m) => rel(m[1])),
    ])];
  }

  const seen = new Set();
  const stack = ['bin/acuvo.mjs', 'bin/acuvo-mcp.mjs'];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of imports[f] ?? []) if (!seen.has(d)) stack.push(d);
  }

  /** Known-unwired, deliberately. Shrink this list; never grow it silently. */
  const KNOWN_UNWIRED = new Set([
    /**
     * ⚠️⚠️ `lib/localize.mjs` — **DECIDED, NOT QUEUED** (2026-09-19).
     * The reasoning, the measurements and the one experiment that reopens it
     * are in `DECISION-localize-files.md`; the instrument is
     * `scripts/zz-what-localize-would-cost.mjs`. Read those, not this comment,
     * before changing anything — a summary here would be the second copy that
     * goes stale, which is exactly how the paragraph this one replaced rotted.
     *
     * ⚠️ THE PARAGRAPH THAT SAT HERE FOR A MONTH WAS STALE IN ITS LOAD-BEARING
     * CLAUSE. It said registering this means deciding whether the tool dispatch
     * layer may make model calls, *"which no other verb does"* — and
     * `lib/tools.mjs`'s own `delegate` case says verbatim *"`delegate` IS THE
     * FIRST TOOL THAT NEEDS TO CALL A MODEL ITSELF"*, with the whole seam built
     * out: injection point, credential refusal, parent-budget remainder,
     * charge-back on failure. So the architecture question was answered before
     * the excuse was written, and it held up a decision for a month on a
     * reason that had already expired.
     *
     * ⭐ THE ACTUAL REASON IT IS NOT WIRED, in one line: the module's 15-17x is
     * measured **over a no-file baseline**, and this CLI is not at one — it
     * already ships a task-seeded repo map and eleven file-finding verbs on
     * every task. The schema is cheap (741 B/round, 1.2-2.6%); the price is
     * 3-4 model calls a call; the increment over what already ships is
     * unmeasured. That is a measurement to make, not a wiring task to do.
     */
    'lib/localize.mjs',
    /**
     * ⭐⭐ `lib/repo-index.mjs` WAS HERE FOR ONE DAY AND IS NOT ANY MORE
     * (2026-08-25). Its excuse was a genuine open decision, not a shrug: the
     * two candidate call sites — feeding `repo-map.mjs`'s ranker, or backing a
     * lookup verb — differ in whether index output reaches the PROMPT, and
     * anything that reaches the prompt must be byte-identical per tree or it
     * breaks prefix caching (production 51.2%, our largest cost lever).
     *
     * ⭐ IT WAS RESOLVED WITH MEASUREMENTS, BOTH ON THIS TREE. The ranker side
     * changes NOTHING here — 0 of 143 symbol lists differ between the map and
     * the index — so it would have bought ~530ms of wall clock while putting a
     * mutable on-disk cache into the causal chain of the prompt head. The
     * lookup side cannot touch a prefix at all (a tool result lands in the
     * tail) and fixes a measured wrong answer: `search_text` returns total=0,
     * scanCapped=true for `rankFiles`, `byCodePoint` and `openIndex`, all three
     * defined in `lib/`. So it is `find_symbol` in `lib/tools.mjs`.
     *
     * ⚠️ AND THE WIRING FOUND A COLLISION NOTHING HAD CHECKED: the module
     * declared `find_definition`, which `lib/lsp.mjs` already declares
     * unconditionally. Registering it would have put two schemas with different
     * parameter shapes under one name. Renamed to `find_symbol`.
     */
    /**
     * ⭐ `lib/mcp-defaults.mjs` WAS HERE AND IS NOT ANY MORE (2026-08-14). Its
     * excuse read "a curated MCP server catalogue with no surface that offers
     * it yet" — 500 lines of hand-verified integration work with zero
     * importers. `--doctor` now imports it (`mcpCatalogueChecks` in
     * lib/doctor.mjs) and prints the catalogue in the MCP section, so the
     * excuse expired and the guard below caught it on the first full run.
     *
     * ⭐ THIS IS THE ALLOWLIST WORKING IN THE DIRECTION NOBODY DESIGNS FOR.
     * A stale exemption is not a harmless leftover: the next reader takes it as
     * a live statement that the module is unreachable, which is how a shipped
     * capability stays invisible. Shrinking this list is the point of it.
     */
    /**
     * ── ⚠️⚠️ `lib/memory-workspace.mjs` — THE EXCUSE IS AN INTENTION, NOT A FACT
     *    (re-measured 2026-09-19) ────────────────────────────────────────────
     *
     * The line here read: *"built for 'one loop, two clients', and the second
     * client is the console, which does not run this binary."* The first half is
     * true and the second half is doing work it has not earned — it reads as
     * "reached by the other client", and **it is reached by neither.**
     *
     * MEASURED: `grep -rn createMemoryExecutor console/` finds exactly ONE hit,
     * and it is a COMMENT in `console/lib/plan-drift.test.ts` saying the
     * `exports` map was added on 2026-08-16 *"so the console could reach
     * `createMemoryExecutor`"*. `could` is the whole finding. The console
     * genuinely imports `acuvo-code/lib/plan.mjs` through that map, so the
     * channel works — nothing has ever imported the executor through it.
     *
     * ⭐ SO THIS IS A REAL DARK CAPABILITY AND ITS OWNER IS NOT THIS PACKAGE.
     * The CLI cannot use it — the CLI has a disk; that is what
     * `createLocalExecutor` is for — so no amount of work in `acuvo-code/`
     * closes it. The one line that would is a `createMemoryExecutor` call in
     * the console's builder, which is where `turn.mjs`'s write→run→fix loop
     * would meet the generated-files Map. That is a `console/` change and this
     * guard must not be read as permission to fake it from here.
     *
     * ⚠️ AND DO NOT "FIX" IT BY IMPORTING IT SOMEWHERE IN `lib/` TO TURN THIS
     * ENTRY GREEN. An import with no caller is this allowlist's own failure mode
     * with the evidence removed.
     */
    'lib/memory-workspace.mjs',
  ]);

  const orphans = files.filter((f) => !seen.has(f) && !KNOWN_UNWIRED.has(f));
  assert.deepEqual(
    orphans,
    [],
    `these modules are reachable from no entry point: ${orphans.join(', ')}. `
      + 'Wire them, delete them, or add them to KNOWN_UNWIRED with a reason — a capability nobody can reach has not shipped.',
  );

  // ⚠️ And the allowlist must not rot: a name here that IS now wired is a stale
  // excuse, and the next person reads it as still-unwired.
  for (const f of KNOWN_UNWIRED) {
    assert.equal(seen.has(f), false, `${f} is in KNOWN_UNWIRED but is now reachable — remove it from the list`);
  }
});

/**
 * ── ⭐⭐⭐ THE GENERALISED VERSION OF THE `localize_files` FINDING ────────────
 *
 * The module walk above catches a FILE nothing imports. It cannot catch the
 * thing that actually costs us: a module that IS imported, or is not, and holds
 * a finished **tool-schema factory that `tools.mjs` never pushes.** That is what
 * `lib/localize.mjs` was for a month — 834 lines, 27 green tests, a schema and a
 * dispatcher both built for registration, offered to no model.
 *
 * ⭐ AUDITED 2026-09-19 across every `*ToolSchemas` export in `lib/`: **43
 * factories, 42 registered, one not** — and the one was `localizeToolSchemas`.
 * So this shape is rare, which is exactly why it needs a guard rather than a
 * habit: a second one would go unnoticed for the same month.
 *
 * ⚠️ THE ESCAPE IS A WRITTEN DECISION, NOT AN ALLOWLIST ENTRY HERE. A name in a
 * `Set` in a test file is the shape of excuse that rotted for `localize.mjs`
 * (its stated blocker was already false when it was written) and for
 * `memory-workspace.mjs` (its excuse names a second client that has never
 * imported it). A `DECISION-*.md` has to carry the reasoning where a reader will
 * find it, and it is the artifact this repo already uses for exactly this —
 * `DECISION-provider-pins-2026-09-18.md`, `DECISION-the-first-fallback-is-unpinned.md`.
 *
 * ⚠️ IT MATCHES ON THE FACTORY NAME, not on prose about it. A decision document
 * that discusses the module in general terms without naming the export it is
 * declining to register has not said which capability it decided about.
 */
test('⭐⭐ every *ToolSchemas factory is registered, or a DECISION-*.md says why not', () => {
  const pkg = path.join(HERE, '..');
  const libDir = path.join(pkg, 'lib');

  const declared = new Set();
  for (const f of fs.readdirSync(libDir).filter((n) => n.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(libDir, f), 'utf8');
    for (const m of src.matchAll(/^export function (\w*ToolSchemas)\b/gm)) declared.add(m[1]);
  }
  assert.ok(declared.size > 20, `only found ${declared.size} tool-schema factories — the scan is broken, not the code`);

  const toolsSrc = fs.readFileSync(path.join(libDir, 'tools.mjs'), 'utf8');
  /**
   * ⚠️ "REGISTERED" MEANS NAMED IN A `TOOL_SCHEMAS.push`, and the push may span
   * many lines — several of these are `push(...xToolSchemas({ … }))` with a
   * multi-line argument object. A one-line regex over the push call reported
   * FIVE false positives on the first run of this audit (`avatar`, `imageEdit`,
   * `media`, `mcp`, `localize`) and four of them were correctly wired. So the
   * test is "does tools.mjs reference the factory at all, outside its import" —
   * a factory this file never mentions cannot be pushed by it.
   *
   * ⚠️ `mcpToolSchemas` IS THE ONE THAT IS NOT IN `tools.mjs` AND IS STILL
   * REACHED: `turn.mjs` calls it per-run, because MCP verbs depend on which
   * servers connected and so cannot be a module-load-time constant. That is why
   * the whole package is scanned for the call, not just `tools.mjs`.
   */
  const everySrc = ['lib', 'bin']
    .flatMap((d) => fs.readdirSync(path.join(pkg, d)).filter((n) => n.endsWith('.mjs')).map((n) => `${d}/${n}`))
    .map((rel) => ({ rel, src: fs.readFileSync(path.join(pkg, rel), 'utf8') }));

  const decisions = fs.readdirSync(pkg).filter((n) => /^DECISION-.*\.md$/.test(n))
    .map((n) => fs.readFileSync(path.join(pkg, n), 'utf8')).join('\n');

  const undecided = [];
  for (const name of declared) {
    const called = everySrc.some(({ rel, src }) => {
      if (rel.endsWith(`/${name.replace(/ToolSchemas$/, '')}.mjs`)) return false;
      // The declaring module itself does not count, nor does a bare import line.
      return new RegExp(`${name}\\s*\\(`).test(src.replace(new RegExp(`^import .*${name}.*$`, 'gm'), ''));
    });
    if (called) continue;
    if (new RegExp(`\\b${name}\\b`).test(decisions)) continue;
    undecided.push(name);
  }

  assert.deepEqual(undecided, [],
    `these tool-schema factories are offered to no model and no DECISION-*.md names them: ${undecided.join(', ')}. `
    + 'Register it, or write the decision down — a dark capability nobody has decided about is this repo\'s most repeated defect.');
});
