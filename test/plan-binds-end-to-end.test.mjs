/**
 * ── ⚠️⚠️ UNIT TESTS CANNOT SEE THE DEFECT THIS PACKAGE ACTUALLY SHIPS ───────
 *
 * `lib/plan-coherence.mjs` had 1,084 lines and a full unit suite while being
 * imported by NOTHING. `best-of.mjs` had fifteen green tests that all injected
 * `runOne`, so every one of them would still have passed with the flag
 * unreachable from the command line. Built-but-unreached is this repo's
 * signature failure, and the only thing that settles it is driving the REAL
 * binary.
 *
 * So these tests spawn `bin/acuvo.mjs` against a stub completions endpoint on
 * 127.0.0.1 — the harness `test/cli-success-path.test.mjs` established, and the
 * reason `resolveApiUrl` refuses anything that is not loopback. No key, no
 * network, nothing spent.
 *
 * What they pin, all three observable rather than grepped:
 *
 *   1. `--plan` refuses in a pipe BEFORE the model call. Asserted by the stub
 *      seeing ZERO requests — the strongest available statement of "nothing was
 *      spent on a plan nobody could have approved".
 *   2. A drifting run says so ON THE TERMINAL. `turn.mjs` has emitted
 *      `plan-drift` since plan-coherence was wired in and `renderEvent` has no
 *      case for it, so until now the whole chain ended at the model.
 *   3. The RECONCILIATION block reaches the human report. `formatReconciliation`
 *      was imported by turn.mjs on line 64 and called nowhere; the one number
 *      nobody has ever been shown — how many steps marked done have evidence —
 *      was computed on every planned run and thrown away.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acuvo.mjs');

/** ⭐ Signed out, explicitly — see cli-success-path.test.mjs on why a bare `{}` is not. */
const SIGNED_OUT = { ACUVO_HOME: join(tmpdir(), `acuvo-plan-signed-out-${process.pid}`) };

async function stubModel(turns) {
  const seen = [];
  let i = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(body);
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
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

let n = 0;
const call = (name, args) => ({
  id: `c_${name}_${(n += 1)}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

/**
 * ⚠️ `spawn`, NEVER `spawnSync`. The stub server lives in THIS process, and a
 * synchronous child call blocks this event loop until the child exits — so the
 * server can never accept the child's connection and both sides wait for the
 * timeout. Recorded at length in cli-success-path.test.mjs; it is a deadlock,
 * not an error, and it looks exactly like a hung HTTP client.
 */
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
    const timer = setTimeout(() => { cp.kill(); reject(new Error(`the CLI did not exit within 40s\n${stdout}\n${stderr}`)); }, 40_000);
    cp.on('error', (e) => { clearTimeout(timer); reject(e); });
    cp.on('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. the gate is reachable, and it refuses before it spends
 * ══════════════════════════════════════════════════════════════════════════ */

test('⚠️⚠️ --plan in a pipe refuses, and the model is NEVER CALLED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-plan-nott-'));
  const stub = await stubModel([{ role: 'assistant', content: 'a plan' }]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '4', '--plan', 'port the auth module'],
      { ACUVO_API_URL: stub.url });

    assert.equal(
      stub.seen.length, 0,
      `--plan spent ${stub.seen.length} model call(s) producing a plan that structurally could not be approved — `
      + 'stdin/stdout are pipes here, so createAsker returns null and there is nobody to say yes',
    );
    assert.notEqual(r.status, 0, 'a run that was asked for and did not happen must not report success');
    assert.match(
      `${r.stdout}${r.stderr}`, /--plan/,
      `the refusal never names the flag that caused it:\n${r.stdout}\n${r.stderr}`,
    );
    assert.equal(
      /acuvo crashed|ReferenceError|TypeError/.test(`${r.stdout}${r.stderr}`), false,
      `the CLI crashed instead of refusing:\n${r.stdout}\n${r.stderr}`,
    );
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ the flag is REACHABLE — an unknown option would say so instead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-plan-known-'));
  const stub = await stubModel([{ role: 'assistant', content: 'a plan' }]);
  try {
    const r = await runCli(['--dir', dir, '--plan', 'x'], { ACUVO_API_URL: stub.url });
    assert.equal(
      /Unknown option/.test(`${r.stdout}${r.stderr}`), false,
      `--plan is documented and the parser rejects it:\n${r.stdout}\n${r.stderr}`,
    );
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. drift reaches the person, not only the model
 * ══════════════════════════════════════════════════════════════════════════ */

const DRIFT_TASK = 'port the auth module to esm';

test('⭐⭐ a run that abandons its own plan SAYS SO on the terminal', async () => {
  /**
   * The shape is the measured one from `plan-ledger.mjs`: a plan is recorded,
   * work happens, and `plan_step` is never called once. Here the work is also
   * on files no step names, which is what `detectDrift` can actually see —
   * four rounds (DRIFT_MIN_ROUNDS) with three distinct unattributed paths
   * (DRIFT_MIN_UNATTRIBUTED) and no mark in the window.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-drift-'));
  const stub = await stubModel([
    {
      role: 'assistant',
      content: 'Planning.',
      tool_calls: [call('plan_start', {
        task: DRIFT_TASK,
        steps: ['port lib/auth.ts to lib/auth.mjs', 'update the callers of lib/auth.ts', 'commit the port'],
      })],
    },
    { role: 'assistant', content: 'One.', tool_calls: [call('write_file', { path: 'scratchpad-one.md', content: 'a\n' })] },
    { role: 'assistant', content: 'Two.', tool_calls: [call('write_file', { path: 'scratchpad-two.md', content: 'b\n' })] },
    { role: 'assistant', content: 'Three.', tool_calls: [call('write_file', { path: 'scratchpad-three.md', content: 'c\n' })] },
    { role: 'assistant', content: 'Done.' },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '6', '--no-run', DRIFT_TASK], { ACUVO_API_URL: stub.url });
    const all = `${r.stdout}\n${r.stderr}`;

    assert.match(
      all, /plan drift/i,
      `four rounds of writes against an untouched three-step plan produced no drift line:\n${all}`,
    );
    assert.match(all, /scratchpad-/, `the drift line names no file, so a user cannot judge it:\n${all}`);
    /**
     * ⚠️ THE MODEL-FACING NUDGE MUST NOT BE WHAT LANDS ON SCREEN. It is 400-odd
     * characters written to give a model two exits; printing it at a terminal
     * buries the three filenames that matter. `driftBannerLine` rebuilds one
     * line from the same evidence, which is the whole reason it exists.
     */
    assert.equal(
      /\[plan coherence — automatic/.test(all), false,
      `the raw model nudge was printed to the user instead of the one-line banner:\n${all}`,
    );
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. the final report says what the model's own `done` was worth
 * ══════════════════════════════════════════════════════════════════════════ */

const CLAIM_TASK = 'write the alpha fixture';

test('⭐⭐ a step marked done over nothing is named in the FINAL REPORT', async () => {
  /**
   * Probe 1 run 3 in `plan-ledger.mjs`: the run reported ✔ VERIFIED while a
   * named deliverable was untouched, because `done` is ASSERTED and nothing has
   * ever looked. `reconcile` has looked since plan-coherence was wired in; its
   * answer went into the JSON result and no further.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-claimed-'));
  const stub = await stubModel([
    {
      role: 'assistant',
      content: 'Planning.',
      tool_calls: [call('plan_start', { task: CLAIM_TASK, steps: ['write alpha-fixture.txt', 'commit it'] })],
    },
    { role: 'assistant', content: 'Marking it done.', tool_calls: [call('plan_step', { id: 's1', state: 'done' })] },
    { role: 'assistant', content: 'All finished.' },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '5', '--no-run', CLAIM_TASK], { ACUVO_API_URL: stub.url });
    const all = `${r.stdout}\n${r.stderr}`;

    assert.match(all, /RECONCILIATION/, `the reconciliation block never reached the human report:\n${all}`);
    assert.match(
      all, /MARKED DONE, but/,
      `a step marked done with no file behind it was not called out:\n${all}`,
    );
    assert.match(
      all, /asserted without evidence 1/,
      `the headline count is wrong or missing — that number is the whole point of the block:\n${all}`,
    );
    /**
     * ⚠️ IT MUST NOT CLAIM TO HAVE JUDGED CORRECTNESS. The moment this block
     * reads as a verification verdict it becomes the `✔ VERIFIED` over an
     * untouched deliverable that produced plan-coherence.mjs in the first place.
     */
    assert.match(all, /says nothing about whether the finished work is correct/, all);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⚠️⚠️ a run with NO plan prints no reconciliation block at all', async () => {
  /**
   * Most runs never call `plan_start`. A block saying "nothing to reconcile" on
   * every one of them is a new line of noise in every summary to say nothing —
   * and noise is how people learn to skim the run where it mattered.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-noplan-'));
  const stub = await stubModel([
    { role: 'assistant', content: 'Writing.', tool_calls: [call('write_file', { path: 'plain.txt', content: 'x\n' })] },
    { role: 'assistant', content: 'Done.' },
  ]);
  try {
    const r = await runCli(['--dir', dir, '--max-rounds', '4', '--no-run', 'create plain.txt'], { ACUVO_API_URL: stub.url });
    const all = `${r.stdout}\n${r.stderr}`;
    assert.equal(/RECONCILIATION/.test(all), false, `a run with no plan printed a reconciliation block:\n${all}`);
    assert.equal(/plan drift/i.test(all), false, `a run with no plan reported drift:\n${all}`);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
