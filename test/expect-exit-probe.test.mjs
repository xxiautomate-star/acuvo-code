/**
 * ── ⚠️⭐ A DELIBERATE ERROR-PATH PROBE IS NOT A RED SUITE (2026-09-26) ───────
 *
 * Found by using the CLI: documenting a CLI, the agent ran `npm test` (green) and
 * then `node bin/tasq.mjs bogus` to confirm the unknown-command path exits 2. It
 * wrote README.md afterwards, the final check re-ran the probe, and the summary
 * said "✖ NOT VERIFIED … the code does not pass". `run_command` now takes
 * `expectExit`, and the expectation survives the stale re-run.
 *
 * Same harness as `a-look-in-the-closing-round-is-read.test.mjs`: a real executor
 * and real processes, because `passed` is only set by a process that ran.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSession } from '../lib/turn.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { formatRunForModel } from '../lib/command.mjs';
import { withExpectedExit } from '../lib/tools.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-expect-exit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n", 'utf8');
  writeFileSync(join(dir, 'cli.mjs'), "console.error('unknown command: bogus');\nprocess.exitCode = 2;\n", 'utf8');
  return dir;
}

/** Round 1: the suite + the probe. Round 2: write the README (makes both stale). Round 3: done. */
function model(probeArgs) {
  let round = 0;
  return async () => {
    round += 1;
    if (round === 1) {
      return {
        ok: true, content: 'checking', finishReason: 'tool_calls', usage: null,
        toolCalls: [
          { id: 't1', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node --test ok.test.mjs' }) } },
          { id: 't2', function: { name: 'run_command', arguments: JSON.stringify(probeArgs) } },
        ],
      };
    }
    if (round === 2) {
      return {
        ok: true, content: 'writing the readme', finishReason: 'tool_calls', usage: null,
        toolCalls: [{ id: 'w1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'README.md', content: '# cli\n' }) } }],
      };
    }
    return { ok: true, content: 'Wrote README.md.', toolCalls: [], usage: null, finishReason: 'stop' };
  };
}

const run = (dir, probeArgs) => runSession({
  task: 'document the cli and check the error path',
  executor: createLocalExecutor(dir),
  config: { apiKey: 'test', model: 'test/model' },
  callModelImpl: model(probeArgs),
  maxRounds: 6,
  budgetUsd: null,
  onEvent: () => {},
});

test('a probe declared with expectExit passes on that code, through the stale re-run', async (t) => {
  const outcome = await run(workspace(t), { command: 'node cli.mjs', expectExit: 2 });
  assert.equal(outcome.verification.passed, true, JSON.stringify(outcome.verification));
  assert.deepEqual(outcome.verification.failingCommands, []);
  assert.equal(outcome.verification.command, 'node --test ok.test.mjs', 'the headline is the real check, not the probe');
});

test('without expectExit the same non-zero exit still fails the verdict (unchanged)', async (t) => {
  const outcome = await run(workspace(t), { command: 'node cli.mjs' });
  assert.equal(outcome.verification.passed, false);
  assert.deepEqual(outcome.verification.failingCommands, ['node cli.mjs']);
});

test('a probe that exits with a DIFFERENT code than expected is red', () => {
  const r = withExpectedExit({ ok: true, command: 'node cli.mjs', exitCode: 1, passed: false, stdout: '', stderr: 'boom', durationMs: 10 }, 2);
  assert.equal(r.passed, false);
  assert.match(formatRunForModel(r), /exit code: 1 \(0\.0s, expected 2\) — FAILED/);
  const ok = withExpectedExit({ ok: true, command: 'node cli.mjs', exitCode: 2, passed: false, stdout: '', stderr: 'x', durationMs: 10 }, 2);
  assert.equal(ok.passed, true);
  // A kill has no exit code to compare, and a non-integer expectation is ignored.
  assert.equal(withExpectedExit({ ok: true, timedOut: true, exitCode: null, passed: false }, 2).passed, false);
  assert.equal(withExpectedExit({ ok: true, exitCode: 2, passed: false }, '2').passed, false);
});
