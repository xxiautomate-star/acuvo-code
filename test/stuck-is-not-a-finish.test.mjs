/**
 * ── ⚠️⚠️⭐ A RUN ABANDONED AS "STUCK" TOLD NOBODY, THROUGH THREE OF FOUR DOORS
 *
 * `round-cap-is-not-a-finish.test.mjs` records the same defect one stop-reason
 * over: the single sentence naming the stop lived inside the `else if (v.ran)`
 * arm of `formatSummary`'s verification block, so it could only be reached by a
 * run whose verification command had RUN AND FAILED.
 *
 * ⭐ `stuck` HAD THE IDENTICAL HOLE, EIGHT LINES BELOW THE CAP'S. All three
 * silent doors were REPRODUCED through `formatSummary` before anything was
 * touched, and the reproduction is the evidence:
 *
 *     stuck + verification PASSED     → `✔ VERIFIED`  … and nothing else   SILENT
 *     stuck + no command ever ran     → `⚠ NOTHING WAS RUN` … and nothing else  SILENT
 *     stuck + `--no-run`              → the file list … and nothing else   SILENT
 *     stuck + command RAN AND FAILED  → "It was repeating itself"          the only lit door
 *
 * ⚠️⚠️ AND THIS ONE IS WORSE THAN THE CAP, BECAUSE OF WHO ENDS THE RUN. A cap
 * is the user's own number running out. `stuck` is OUR heuristic deciding to
 * throw away rounds the user paid for and has NOT spent — `stuck.mjs`'s own
 * header prices the mistake: *"CALLING A WORKING RUN STUCK costs the user THE
 * WORK AND THE MONEY."* A judgement that expensive may not be made silently.
 *
 * ⭐ THESE TESTS PIN THE OBSERVABLE PROPERTY, not the sentence: a run the loop
 * watcher stopped says so in every verification state, a run that finished says
 * nothing of the kind, and the recovery offered is the one that does not simply
 * resume the loop.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatSummary, stuckWarning } from '../lib/turn.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acuvo.mjs');

/** See the sibling file: a machine with a login routes past the loopback seam. */
const SIGNED_OUT = { ACUVO_HOME: join(tmpdir(), `acuvo-signed-out-stuck-${process.pid}`) };

/** The shape `formatSummary` sees for a run the loop watcher ended. */
const circling = (over = {}) => ({
  ok: true,
  stage: 'done',
  model: 'stub/model',
  note: 'Let me try rewriting lib/mode.js again.',
  noteAlreadyShown: false,
  finishReason: 'tool_calls',
  usage: { cost: 0.0042, total_tokens: 21_000 },
  compactions: 0,
  executed: [{ id: '1', name: 'write_file', args: { path: 'lib/mode.js' }, result: { ok: true, path: 'lib/mode.js', bytes: 400 }, mutated: true }],
  rounds: [{ round: 7, executed: [{ name: 'write_file' }] }],
  roundsUsed: 7,
  maxRounds: 24,
  allowRun: true,
  stoppedBecause: 'stuck',
  acceptance: null,
  promisedButMissing: [],
  verification: { ran: false, passed: null, command: null, exitCode: null, timedOut: false, attempts: 0 },
  ...over,
});

/** The four doors, exactly as reproduced before the fix. */
const DOORS = {
  'passed — the silent door a green tick hides behind': { ran: true, passed: true, command: 'npm test', exitCode: 0, timedOut: false, attempts: 1 },
  'never ran': { ran: false, passed: null, command: null, exitCode: null, timedOut: false, attempts: 0 },
  'ran and failed — the only door that ever spoke': { ran: true, passed: false, command: 'npm test', exitCode: 1, timedOut: false, attempts: 2 },
};

/* ────────────────────────────────────────────────────────────────────────────
 * (1) THE PROPERTY — it says so, whatever the verification did
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐⭐ a run stopped as STUCK says so in EVERY verification state', () => {
  for (const [name, verification] of Object.entries(DOORS)) {
    const text = formatSummary(circling({ verification }), { resumeCommand: 'acuvo --continue' }).join('\n');
    assert.match(text, /GOING IN CIRCLES/, `verification ${name}: the loop stop was never mentioned:\n${text}`);
  }
});

test('⚠️ the third door: --no-run leaves NO verification object at all', () => {
  /**
   * ⚠️ `verification: null` IS ITS OWN DOOR, not a variant of "never ran". The
   * whole `if (v)` block is skipped, so every sentence inside it — including the
   * one that used to be the only mention of a stuck stop — is unreachable by
   * construction rather than by condition.
   */
  const text = formatSummary(circling({ allowRun: false, verification: null }), { resumeCommand: 'acuvo --continue' }).join('\n');
  assert.match(text, /GOING IN CIRCLES/, `a --no-run stuck stop said nothing:\n${text}`);
});

test('⚠️⚠️ the worst door: a PASSING command must not be the last word', () => {
  const text = formatSummary(
    circling({ verification: DOORS['passed — the silent door a green tick hides behind'] }),
    { resumeCommand: 'acuvo --continue' },
  ).join('\n');

  assert.match(text, /✔ VERIFIED/, 'the true statement about the command survives');
  assert.ok(
    text.indexOf('GOING IN CIRCLES') > text.indexOf('✔ VERIFIED'),
    'the warning must come AFTER the tick — the last thing on screen is the thing a person reads',
  );
});

test('⚠️ a run that finished says nothing about circles — the false-positive half', () => {
  for (const stoppedBecause of ['verified', 'no-tool-calls', 'round-cap', 'truncated', 'aborted', 'would-exceed', 'model-error']) {
    const text = formatSummary(
      circling({ stoppedBecause, verification: DOORS['ran and failed — the only door that ever spoke'] }),
      { resumeCommand: 'acuvo --continue' },
    ).join('\n');
    assert.doesNotMatch(text, /GOING IN CIRCLES/, `"${stoppedBecause}" is not a loop stop and must not claim to be`);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * (2) IT NEVER CLAIMS MORE THAN THE OUTCOME CARRIES
 * ──────────────────────────────────────────────────────────────────────────── */

test('⭐ "with N still unspent" is printed only when the arithmetic is actually true', () => {
  const early = stuckWarning(circling({ roundsUsed: 7, maxRounds: 24 })).join('\n');
  assert.match(early, /round 7 of 24, with 17 still unspent/);

  /**
   * ⚠️ THE PATH THAT MAKES THIS CONDITIONAL REAL: `detectStuck` runs at the top
   * of every round including the last, so a loop can be caught on round N of N.
   * "with 0 still unspent" is the precise-sounding wrong detail that teaches
   * people to stop reading warnings.
   */
  const onTheWall = stuckWarning(circling({ roundsUsed: 24, maxRounds: 24 })).join('\n');
  assert.match(onTheWall, /GOING IN CIRCLES/, 'the unconditional half is true on every path');
  assert.doesNotMatch(onTheWall, /still unspent/, 'it may not claim rounds were left when none were');

  const noNumbers = stuckWarning(circling({ roundsUsed: undefined, maxRounds: undefined })).join('\n');
  assert.match(noNumbers, /GOING IN CIRCLES/);
  assert.doesNotMatch(noNumbers, /still unspent/);
});

test('⭐ "the final round was still calling tools" is printed only when the record says so', () => {
  const withCalls = stuckWarning(circling({ rounds: [{ round: 7, executed: [{ name: 'edit_file' }] }] })).join('\n');
  assert.match(withCalls, /final round was still calling tools/);

  const noCalls = stuckWarning(circling({ rounds: [{ round: 7, executed: [] }] })).join('\n');
  assert.doesNotMatch(noCalls, /still calling tools/, 'it may not claim a fact the record does not carry');

  const noRecord = stuckWarning(circling({ rounds: undefined })).join('\n');
  assert.match(noRecord, /GOING IN CIRCLES/);
  assert.doesNotMatch(noRecord, /still calling tools/);
});

test('⚠️⚠️ the recovery is NOT a bare --continue — that resumes the loop', () => {
  /**
   * ⭐ THE ONE PLACE THIS DIFFERS FROM `roundCapWarning`. A capped run wants the
   * same conversation carried on unchanged. A CIRCLING one carried on unchanged
   * goes back into the circle, so the advice has to carry a new instruction.
   */
  const text = formatSummary(circling(), { resumeCommand: 'acuvo --continue' }).join('\n');
  assert.match(text, /acuvo --continue "…"/, 'the recovery must ask for a new instruction');
  assert.match(text, /Resuming it unchanged resumes the loop/, 'and must say why');
});

test('⚠️ the recovery is promised ONLY when there is a record to recover', () => {
  const bare = formatSummary(circling()).join('\n');
  assert.match(bare, /GOING IN CIRCLES/, 'the warning does not depend on persistence');
  assert.doesNotMatch(bare, /--continue/, 'a caller that saved nothing must not be told to continue');
});

test('⚠️ the loop stop is named ONCE, not twice, when the verification also failed', () => {
  const text = formatSummary(
    circling({ verification: DOORS['ran and failed — the only door that ever spoke'] }),
    { resumeCommand: 'acuvo --continue' },
  ).join('\n');
  assert.equal((text.match(/GOING IN CIRCLES/g) || []).length, 1);
  /**
   * The in-context line keeps the FACT ("It was repeating itself and stopped…")
   * and the block below owns the REMEDY. Two copies of "steer it" is how a
   * warning becomes wallpaper.
   */
  assert.equal((text.match(/steer/gi) || []).length, 0, `the old duplicate remedy is still in the verification arm:\n${text}`);
  assert.match(text, /It was repeating itself and stopped/, 'the in-context fact stays where it makes sense');
});

/* ────────────────────────────────────────────────────────────────────────────
 * (3) REACH — a person typing `acuvo` actually gets it
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ EVERY TEST ABOVE WOULD STAY GREEN IF `formatSummary` NEVER CALLED
 * `stuckWarning`, or if `bin/acuvo.mjs` stopped passing `resumeCommand`. This
 * package has shipped built-and-unreached repeatedly; the only answer is argv
 * in, bytes out.
 */

async function stubModel(turns) {
  let i = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `stub-${i}`,
        model: 'stub/model',
        choices: [{ message: turn, finish_reason: turn.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00001 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1/chat/completions`, close: () => new Promise((r) => server.close(r)) };
}

const call = (name, args) => ({ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [CLI, ...args], {
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', OPENROUTER_API_KEY: 'sk-or-v1-stub', ...SIGNED_OUT, ...env },
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d) => { stdout += d; });
    cp.stderr.on('data', (d) => { stderr += d; });
    cp.stdin.end('');
    const timer = setTimeout(() => { cp.kill(); reject(new Error(`the CLI did not exit within 30s\n${stdout}\n${stderr}`)); }, 30_000);
    cp.on('error', (e) => { clearTimeout(timer); reject(e); });
    cp.on('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

test('⭐⭐ REACH: a real `acuvo --on-stuck stop` run that circles says so and names the recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-stuck-'));
  /**
   * ⭐ BYTE-IDENTICAL WRITES TO ONE PATH — `stuck.mjs`'s `IDENTICAL_WRITE_LIMIT`
   * is 2, and it is the one pattern the detector calls PROVEN rather than
   * inferred: the second write changed nothing, which is a fact. Round 2 is the
   * first sighting (a nudge), round 3 is the repeat that stops it — well inside
   * the 8-round budget, so this cannot be a round cap wearing a disguise.
   */
  const stub = await stubModel([
    { role: 'assistant', content: 'Rewriting mode.js.', tool_calls: [call('write_file', { path: 'mode.js', content: 'export const mode = 1;\n' })] },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '8', '--no-run', '--on-stuck', 'stop', 'fix mode.js'], { ACUVO_API_URL: stub.url });

    assert.equal(
      /ReferenceError|TypeError|acuvo crashed/.test(`${r.stdout}${r.stderr}`),
      false,
      `the CLI crashed:\n${r.stdout}\n${r.stderr}`,
    );
    assert.match(r.stdout, /GOING IN CIRCLES/, `a run abandoned as stuck said nothing about it:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /RAN OUT OF ROUNDS/, `it stopped on the loop watcher, not the counter:\n${r.stdout}`);
    assert.match(r.stdout, /acuvo --continue/, `the recovery was never named:\n${r.stdout}`);

    // ⭐ AND THE ADVICE IS TRUE: the record it points at is on disk.
    const saved = readdirSync(join(dir, '.acuvo', 'sessions'));
    assert.equal(saved.length, 1, `--continue was promised with ${saved.length} records saved`);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ REACH: under --no-session the warning stays and the promise is withdrawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-stuck-nosave-'));
  const stub = await stubModel([
    { role: 'assistant', content: 'Rewriting mode.js.', tool_calls: [call('write_file', { path: 'mode.js', content: 'export const mode = 1;\n' })] },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '8', '--no-run', '--no-session', '--on-stuck', 'stop', 'fix mode.js'], { ACUVO_API_URL: stub.url });
    assert.match(r.stdout, /GOING IN CIRCLES/, `the warning must not depend on persistence:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /--continue/, `nothing was saved, so --continue must not be offered:\n${r.stdout}`);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️ REACH: a run that FINISHES gets none of this', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-stuck-clean-'));
  const stub = await stubModel([
    { role: 'assistant', content: 'Writing.', tool_calls: [call('write_file', { path: 'done.txt', content: 'ok\n' })] },
    { role: 'assistant', content: 'Done — done.txt now exists.' },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '8', '--no-run', '--on-stuck', 'stop', 'create done.txt'], { ACUVO_API_URL: stub.url });
    assert.doesNotMatch(r.stdout, /GOING IN CIRCLES/, `a finished run was told it was circling:\n${r.stdout}`);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
