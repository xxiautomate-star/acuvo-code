/**
 * ── ⭐⭐⭐ THE POLYGLOT PRESETS ACTUALLY RUN — NOT "ARE ALLOWED TO" ──────────
 *
 * `python-reach.test.mjs` proves the GRAMMAR accepts `python -m pytest -q`.
 * `command-polyglot-allowlist.test.mjs` proves the preset offers the binaries.
 * Neither spawns anything. "Allowed" and "runs" are different claims, and this
 * package has shipped the gap between them enough times to name it.
 *
 * ⚠️ THE MEASUREMENT THAT MOTIVATED THE WHOLE PYTHON GRAMMAR was a bench task
 * that failed because `pytest -q` was refused. Proving the refusal is gone
 * without proving the command RUNS would close the ticket and not the defect.
 *
 * ⭐ SO THIS SPAWNS A REAL PYTEST against a real two-test file — one passing,
 * one failing — and requires the FAILURE TEXT to come back. A runner that
 * reported a clean exit for a suite with a broken test would be worse than one
 * that refused, because the agent would believe it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { executeRunCommand } from '../lib/command.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';

/**
 * ⚠️ A SKIP-IF-ABSENT TEST ON A MACHINE WITHOUT PYTHON IS A TEST THAT CANNOT
 * FAIL, which is the trap this repo has a file of lessons about. So absence is
 * DETECTED and REPORTED rather than assumed, and the assertions below run
 * wherever Python exists — which is the developer machine and any CI image with
 * it installed.
 */
function pythonAvailable() {
  for (const bin of ['python', 'python3', 'py']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return null;
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'pyrun-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  // The operator opts the ecosystem in — exactly what a real user does.
  writeFileSync(join(root, '.acuvo', 'commands.json'), JSON.stringify({ presets: ['python'] }));
  writeFileSync(join(root, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  writeFileSync(
    join(root, 'test_calc.py'),
    'from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_broken():\n    assert add(2, 2) == 5\n',
  );
  return root;
}

test('⭐⭐ `python -m pytest -q` SPAWNS and hands back the real failure', async (t) => {
  const bin = pythonAvailable();
  if (!bin) {
    t.diagnostic('no python on this machine — the spawn half is unverified here');
    return;
  }
  const root = workspace();
  try {
    const r = await executeRunCommand({ command: 'python -m pytest -q', executor: createLocalExecutor(root) });
    assert.equal(r.ok, true, `the runner refused: ${r.error ?? ''}`);
    /**
     * ⚠️ EXIT 1 IS THE CORRECT ANSWER HERE, and asserting exit 0 would be
     * asserting the wrong thing: one of the two tests genuinely fails. A
     * non-zero exit with real stderr IS a successful run — `code-sandbox.ts`
     * states the same rule for its own executor.
     */
    assert.equal(r.exitCode, 1, 'a suite with one broken test exited 0 — the runner is not really running it');
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.match(out, /test_broken/, 'the failing test is not named in the output — the agent cannot fix what it cannot see');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⭐ the bare `pytest` door runs too — one grammar, two doors', async (t) => {
  const bin = pythonAvailable();
  if (!bin) { t.diagnostic('no python on this machine'); return; }
  const root = workspace();
  try {
    const r = await executeRunCommand({ command: 'pytest -q', executor: createLocalExecutor(root) });
    assert.equal(r.ok, true, `the runner refused: ${r.error ?? ''}`);
    assert.match(`${r.stdout ?? ''}${r.stderr ?? ''}`, /test_broken/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️⚠️ and the refusals are enforced by the RUNNER, not only by the grammar', async () => {
  /**
   * The half that matters most. A validator that refuses `pip install` is worth
   * nothing if the executor can be reached another way — so this asserts the
   * refusal at the layer that actually spawns, on a machine where python is
   * genuinely installed and would otherwise succeed.
   */
  const root = workspace();
  try {
    for (const command of ['python -m pip install requests', 'python -c "print(1)"', 'python -m http.server']) {
      const r = await executeRunCommand({ command, executor: createLocalExecutor(root) });
      assert.equal(r.ok, false, `${command} was EXECUTED — the runner does not enforce the grammar`);
      assert.ok(String(r.error ?? '').length > 20, `${command} was refused without a reason a model could act on`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ── ⭐⭐ RUST, THE SAME CLAIM AND THE SAME PROOF ────────────────────────────
 *
 * `COMMAND_PRESETS.rust` allows `cargo test` and refuses `cargo install`. Six
 * presets are declared — python, go, rust, ruby, make, node-bin — and only the
 * toolchains actually installed on a machine can be proven there. Python and
 * Rust are installed here; the rest are asserted at the grammar and honestly
 * unproven at the spawn, which is what the diagnostics below say rather than
 * quietly passing.
 */
function cargoAvailable() {
  const r = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

function rustWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'rsrun-'));
  mkdirSync(join(root, '.acuvo'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.acuvo', 'commands.json'), JSON.stringify({ presets: ['rust'] }));
  writeFileSync(join(root, 'Cargo.toml'), [
    '[package]',
    'name = "probe"',
    'version = "0.1.0"',
    'edition = "2021"',
    '',
    '[dependencies]',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'src', 'lib.rs'), [
    'pub fn add(a: i32, b: i32) -> i32 { a + b }',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use super::*;',
    '    #[test]',
    '    fn ok() { assert_eq!(add(2, 3), 5); }',
    '    #[test]',
    '    fn broken() { assert_eq!(add(2, 2), 5); }',
    '}',
    '',
  ].join('\n'));
  return root;
}

test('⭐⭐ `cargo test` SPAWNS and hands back the real panic', async (t) => {
  if (!cargoAvailable()) { t.diagnostic('no cargo on this machine — the spawn half is unverified here'); return; }
  const root = rustWorkspace();
  try {
    /**
     * ⚠️ `--offline` SO THIS NEVER REACHES THE NETWORK. A test that downloads a
     * crate index is a test that fails on a plane and passes for the wrong
     * reason on a fast connection. The fixture has no dependencies, so offline
     * is not a limitation here — it is the whole point.
     */
    const r = await executeRunCommand({ command: 'cargo test --offline', executor: createLocalExecutor(root), timeoutMs: 240_000 });
    assert.equal(r.ok, true, `the runner refused: ${r.error ?? ''}`);
    /**
     * ⚠️ 101 IS RUST'S TEST-FAILURE EXIT CODE, not a crash. One of the two tests
     * genuinely fails, so a zero here would mean the suite never ran.
     */
    assert.equal(r.exitCode, 101, 'a crate with one failing test exited cleanly — the runner is not really running it');
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.match(out, /tests::broken/, 'the failing test is not named — the agent cannot fix what it cannot see');
    assert.match(out, /left: 4/, 'the assertion values are missing, and they are the whole diagnosis');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('⚠️⚠️ and `cargo install` is refused by the RUNNER, on a machine where it would work', async (t) => {
  if (!cargoAvailable()) { t.diagnostic('no cargo on this machine'); return; }
  const root = rustWorkspace();
  try {
    for (const command of ['cargo install ripgrep', 'cargo publish', 'cargo run']) {
      const r = await executeRunCommand({ command, executor: createLocalExecutor(root) });
      assert.equal(r.ok, false, `${command} was EXECUTED — the runner does not enforce the grammar`);
      assert.ok(String(r.error ?? '').length > 20, `${command} was refused without a reason a model could act on`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
