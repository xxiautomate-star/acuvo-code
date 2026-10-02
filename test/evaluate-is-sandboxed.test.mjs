/**
 * ── 🚨⭐⭐⭐ `evaluate` WAS THE ONE `node <file>` THAT RAN UNSANDBOXED ────────
 *
 * `lib/command.mjs`'s `buildInvocation` carries the reason the sandbox attaches
 * where it does:
 *
 *   *"it is derived from the argv about to be spawned, so the three callers —
 *   `run_command`, `start_process` and `run_program` — cannot each forget it,
 *   and a future fourth caller cannot either. A second door with weaker locks
 *   is the failure mode."*
 *
 * ⚠️ `evaluate` WAS THE FOURTH CALLER AND IT FORGOT. It built `{ file:
 * process.execPath, args: [snippet] }` by hand and never went near the choke
 * point — so the one tool whose entire job is `node <file>` was the one
 * `node <file>` with no `--permission` flags on it.
 *
 * ⚠️ AND TWO PIECES OF PROSE WERE ASSERTING OTHERWISE. `evaluate.mjs`'s header
 * said *"it cannot do anything `write_file` + `run_command` could not already
 * do"*, and `--doctor` printed *"`node <file>` is confined to <workspace>"*.
 * Both were advertising a lock this door did not have.
 *
 * ── ⭐ THE DECOY IS THE POINT, AND IT IS TEST 2 ─────────────────────────────
 *
 * Copied deliberately from `sandbox-confines-node.test.mjs`, which argues it
 * better than I can: *"a test that asserts 'the file outside the workspace does
 * not exist' is exactly the shape of guard this package has caught passing
 * while checking nothing — it stays green if the script never ran, if the path
 * was mistyped, if the workspace was cleaned first."*
 *
 * So the same snippet, the same path, the same driver runs TWICE, and the
 * second run — `ACUVO_SANDBOX=off` — asserts the escape file DOES exist. That
 * is the assertion that cannot be satisfied by accident.
 *
 * ⚠️ NOTHING HERE IS STUBBED. A recorded argv proves we ASKED for a boundary,
 * never that a kernel enforced one. These spawn real Node.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalExecutor } from '../lib/workspace.mjs';
import { evaluateSnippet } from '../lib/evaluate.mjs';
import { sandboxSupport, SANDBOX_ENV } from '../lib/sandbox.mjs';

/** A snippet that tries to write OUTSIDE the workspace it was given. */
function escapeSnippet(target) {
  return `import { writeFileSync } from 'node:fs';\n`
    + `writeFileSync(${JSON.stringify(target)}, 'escaped');\n`
    + `console.log('wrote it');\n`;
}

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-evalbox-'));
  const outside = join(tmpdir(), `acuvo-ESCAPED-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  return { root, outside };
}

const support = sandboxSupport();

test('🚨 a snippet cannot write outside the workspace', { skip: support.available ? false : `no permission model here: ${support.reason}` }, async () => {
  const { root, outside } = scratch();
  try {
    const r = await evaluateSnippet({ executor: createLocalExecutor(root), source: escapeSnippet(outside) });

    assert.equal(r.ok, true, 'the tool itself must still work — this is a boundary, not a breakage');
    assert.equal(r.passed, false, 'the snippet tried to escape, so it must not report success');
    assert.equal(
      existsSync(outside),
      false,
      'the snippet wrote outside the workspace — evaluate is not going through buildInvocation',
    );
    /**
     * ⭐ AND THE RESULT SAYS A BOUNDARY WAS IN FORCE. Without this the model
     * reads a bare "Access to this API has been restricted" and has no way to
     * know a workspace boundary exists at all, which is how it concludes its
     * tool is broken rather than its code.
     */
    assert.equal(r.sandboxed, true, 'the result must report that a boundary was applied');
    assert.match(String(r.stderr ?? ''), /restricted|ERR_ACCESS_DENIED/i, 'and the denial must reach the caller');
  } finally {
    if (existsSync(outside)) unlinkSync(outside);
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐⭐ THE DECOY — with the sandbox off, the identical snippet DOES escape', async () => {
  /**
   * ⚠️ WITHOUT THIS THE TEST ABOVE IS WORTHLESS. It proves the snippet runs,
   * reaches the write, and lands on exactly that path — so the absence in test
   * one can only be the sandbox, and not a typo, a missing file or a spawn that
   * never happened.
   */
  const { root, outside } = scratch();
  const saved = process.env[SANDBOX_ENV];
  process.env[SANDBOX_ENV] = 'off';
  try {
    const r = await evaluateSnippet({ executor: createLocalExecutor(root), source: escapeSnippet(outside) });
    assert.equal(r.ok, true);
    assert.equal(r.passed, true, `the unsandboxed snippet should succeed; stderr was: ${String(r.stderr ?? '').slice(0, 200)}`);
    assert.equal(existsSync(outside), true, 'the decoy did not run — test 1 above therefore proves nothing');
    assert.equal(r.sandboxed, false, 'and it must say so, rather than claiming a boundary it did not apply');
  } finally {
    if (saved === undefined) delete process.env[SANDBOX_ENV];
    else process.env[SANDBOX_ENV] = saved;
    if (existsSync(outside)) unlinkSync(outside);
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐ ordinary in-workspace work is completely unaffected', async () => {
  /**
   * ⚠️ THE HALF THAT MATTERS MOST TO A USER. A hardening change that quietly
   * breaks the common path is worse than the hole it closed, and this package
   * has shipped that trade before. The snippet reads and writes inside the
   * workspace, which is what `evaluate` exists for.
   */
  const { root } = scratch();
  try {
    const executor = createLocalExecutor(root);
    executor.writeFile('data.txt', 'forty-two');
    const r = await evaluateSnippet({
      executor,
      source: "import { readFileSync, writeFileSync } from 'node:fs';\n"
        + "writeFileSync('out.txt', readFileSync('data.txt', 'utf8').toUpperCase());\n"
        + "console.log(readFileSync('out.txt', 'utf8'));\n",
    });
    assert.equal(r.ok, true);
    assert.equal(r.passed, true, `in-workspace work must still pass; stderr: ${String(r.stderr ?? '').slice(0, 300)}`);
    assert.match(r.stdout, /FORTY-TWO/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
