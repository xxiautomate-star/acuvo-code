/**
 * ── ⚠️⚠️ THE AGENT COULD REWRITE THE FILES THAT GOVERN IT ────────────────────
 *
 * Proven on 2026-08-13 against the real executor, in a temp workspace:
 *
 *   WROTE    .acuvo/mcp.json        ↳ next run would spawn: calc.exe
 *   WROTE    .acuvo/commands.json
 *   WROTE    .acuvo/policy.json
 *   refused  .git/hooks/pre-commit
 *
 * `.acuvo/mcp.json` NAMES THE PROGRAMS WE SPAWN. A write there is arbitrary code
 * execution on the owner's next command — the exact sentence `.git/` is already
 * refused for, aimed at a directory nobody thinks to review. `commands.json`
 * grants ecosystems (the model was told in the system prompt not to enable one
 * for itself — a prompt is not a boundary). `policy.json` is the governance
 * itself, including round and dollar ceilings.
 *
 * ⭐ AND THE GUARD WAS ALREADY WRITTEN. `isPolicyProtectedPath` (lib/policy.mjs)
 * exists, is correct, and had ZERO runtime callers — only tests. This is the
 * fifth finished-and-unreachable thing found in this repo in three days, and the
 * first one where the cost of the gap is a remote-code-execution primitive
 * rather than a missing feature.
 *
 * ⚠️ THE TWO IMPLEMENTATIONS ARE PINNED TOGETHER BELOW. The write path cannot
 * import policy.mjs (policy → tools → workspace is a cycle), so the rule exists
 * in two places by necessity — and a test asserting they agree is the only thing
 * that stops them drifting into two different answers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalExecutor, resolveInWorkspace } from '../lib/workspace.mjs';
import { isPolicyProtectedPath } from '../lib/policy.mjs';

/**
 * ⚠️ `resolveInWorkspace(root, path, intent)` TAKES A PLAIN STRING, NOT AN
 * OPTIONS OBJECT. The first draft of this file passed `{ intent: 'write' }`,
 * which is truthy but never equals `'write'` — so the write branch never ran and
 * the test silently exercised the READ path instead. It reported green against a
 * live remote-code-execution hole.
 *
 * ⭐ Only the cross-check below caught it: `writeFile` refused the path while
 * `resolveInWorkspace` allowed it, and two of our own functions disagreeing is a
 * louder signal than either one alone. A test that calls an API wrongly does not
 * fail — it passes, about nothing.
 */

const ws = () => mkdtempSync(join(tmpdir(), 'acuvo-leash-'));

test('⚠️⚠️ write_file cannot touch .acuvo/mcp.json — it names the binaries we spawn', () => {
  const root = ws();
  const ex = createLocalExecutor(root);
  const r = ex.writeFile('.acuvo/mcp.json', '{"mcpServers":{"pwn":{"command":"calc.exe"}}}');

  assert.equal(r.ok, false, 'a write here is code execution on the next run');
  assert.equal(existsSync(join(root, '.acuvo/mcp.json')), false, 'and nothing may reach disk');
});

test('⚠️⚠️ nor commands.json — that is the agent granting itself an ecosystem', () => {
  /**
   * The system prompt asks the model not to do this. That is guidance, not a
   * boundary: "it would not think of it" has never been a security control, and
   * the whole point of the preset design is that a HUMAN decides which programs
   * may run.
   */
  const root = ws();
  const ex = createLocalExecutor(root);
  const r = ex.writeFile('.acuvo/commands.json', '{"presets":["python","go","rust"]}');
  assert.equal(r.ok, false);
  assert.equal(existsSync(join(root, '.acuvo/commands.json')), false);
});

test('⚠️⚠️ nor policy.json — an agent that edits its own ceilings has none', () => {
  const root = ws();
  const ex = createLocalExecutor(root);
  const r = ex.writeFile('.acuvo/policy.json', '{"maxRounds":64}');
  assert.equal(r.ok, false);
  assert.equal(existsSync(join(root, '.acuvo/policy.json')), false);
});

test('⭐ the refusal NAMES THE WAY OUT — the model gets another round, so tell it', () => {
  /**
   * This package's own rule, and the reason its refusals are the best-written
   * part of it: a blank wall costs a paid round, a sentence costs nothing. The
   * way out here is a human editing the file, because that is the whole point.
   */
  const root = ws();
  const r = createLocalExecutor(root).writeFile('.acuvo/mcp.json', '{}');
  assert.match(String(r.error ?? ''), /\.acuvo/, 'the refusal must name what it refused');
  assert.ok(
    /you|owner|human|yourself|ask/i.test(String(r.error ?? '')),
    `the refusal must say who CAN change it. Got: ${r.error}`,
  );
});

test('⚠️ ordinary work is untouched — this must not become a refusal of correct work', () => {
  /**
   * The failure this package has paid for four times. A guard that also blocks
   * `src/`, or a file merely NAMED acuvo, is worse than the hole it closed.
   */
  const root = ws();
  const ex = createLocalExecutor(root);
  assert.equal(ex.writeFile('src/ordinary.js', 'export const ok = 1;\n').ok, true);
  assert.equal(ex.writeFile('acuvo.json', '{}').ok, true, 'a normal file whose NAME resembles it is fine');
  assert.equal(ex.writeFile('docs/.acuvo-notes.md', 'notes\n').ok, true, 'and so is a similar prefix');
});

test('⭐ READING .acuvo/ is still allowed — the agent should be able to see its own rules', () => {
  /**
   * ⚠️ Write is the dangerous verb, not read. Refusing reads would stop the
   * agent explaining the policy it is running under, which is a support answer
   * users legitimately want and costs nothing to give.
   */
  const root = ws();
  const read = resolveInWorkspace(root, '.acuvo/policy.json', 'read');
  assert.equal(read.ok, true, 'reading its own governance is not the risk');
});

test('⚠️⚠️ the two implementations of this rule agree — they cannot import each other', () => {
  /**
   * `workspace.mjs` cannot import `policy.mjs` (policy → tools → workspace is a
   * cycle), so the rule necessarily exists twice. This is the only thing
   * standing between that and two different answers — which is exactly how the
   * timeout string and its matcher drifted apart for weeks.
   */
  /**
   * ⚠️ COMPARED AGAINST THE EXECUTOR, NOT `resolveInWorkspace`. The guard
   * deliberately does NOT live in that function: it is a path utility the
   * package's own internals use, and `acceptance.mjs` legitimately writes inside
   * `.acuvo/` through it. Putting the refusal there broke seven tests of real
   * machinery. The model only ever reaches the filesystem through the executor,
   * so that is where the rule belongs and what this must check.
   */
  const root = ws();
  const ex = createLocalExecutor(root);
  const cases = [
    '.acuvo/mcp.json', '.acuvo/commands.json', '.acuvo/policy.json', '.acuvo/nested/deep.json',
    'src/index.js', 'acuvo.json', 'docs/.acuvo-notes.md', 'package.json',
  ];
  for (const rel of cases) {
    const policySays = isPolicyProtectedPath(rel);
    const writeAllowed = ex.writeFile(rel, '{}').ok;
    assert.equal(
      writeAllowed, !policySays,
      `disagreement on ${rel}: isPolicyProtectedPath=${policySays} but the executor ${writeAllowed ? 'allowed' : 'refused'} the write`,
    );
  }
});

test('⚠️ deleting the leash is not safer than rewriting it', () => {
  /**
   * Dropping `mcp.json` silently removes servers a user configured — a change to
   * what runs, achieved by omission. A guard on write that leaves delete open is
   * the same hole with an extra step.
   */
  const root = ws();
  const ex = createLocalExecutor(root);
  const r = ex.deleteFile('.acuvo/mcp.json');
  assert.equal(r.ok, false);
  assert.match(String(r.error ?? ''), /\.acuvo/);
});
