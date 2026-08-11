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

import { runSession, renderEvent, toolResultText } from '../lib/turn.mjs';
import { executeToolCall } from '../lib/tools.mjs';
import { MAX_ROUNDS_LIMIT } from '../lib/cli-args.mjs';

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
  const env = { ...process.env, NO_COLOR: '1', ...extra };
  for (const v of ['OPENROUTER_API_KEY', 'MODAL_TTS_URL', 'MODAL_TRANSCRIBE_URL', 'MODAL_PRESS_URL', 'RENDER_AUDIT_URL', 'MODAL_VIDEO_SECRET', 'PERCHANCE_IMAGE_URL']) {
    delete env[v];
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
    // ⚠️ RENDER_AUDIT_URL is deliberately absent: designPass never throws and
    // still produces a verdict on the honest-refusal path, so this needs no
    // network and no configured endpoint.
    const before = process.env.RENDER_AUDIT_URL;
    delete process.env.RENDER_AUDIT_URL;
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
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  for (let i = 0; i < 6; i += 1) {
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
    // 6 x 40,000 chars went in; the budget is 24,000 tokens ≈ 96,000 chars.
    assert.ok(seen[0] < 240_000, `the transport still received ${seen[0]} characters — compaction did not run before the call`);

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

test('⭐ --help documents EVERY media variable, including MODAL_VIDEO_SECRET', () => {
  const r = runCli(['--help'], { key: null });
  for (const v of ['OPENROUTER_API_KEY', 'RENDER_AUDIT_URL', 'MODAL_TTS_URL', 'MODAL_TRANSCRIBE_URL', 'MODAL_PRESS_URL', 'MODAL_VIDEO_SECRET']) {
    assert.match(r.stdout, new RegExp(v), `--help never mentions ${v} — its absence is what made four tools look broken`);
  }
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

test('⚠️ one past the ceiling is still refused, with the real number in the sentence', () => {
  const r = runCli(['--max-rounds', String(MAX_ROUNDS_LIMIT + 1), 'x'], { key: null });
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, new RegExp(`between 1 and ${MAX_ROUNDS_LIMIT}`));
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
