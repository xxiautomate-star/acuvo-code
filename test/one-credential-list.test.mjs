/**
 * ── ⚠️⚠️ TWO CREDENTIAL LISTS, TWO ANSWERS, SIBLING TOOLS ───────────────────
 *
 * `NEVER_COMMIT` (lib/git.mjs) guards the automatic pre-load, `search_text`,
 * `repo-map` and `session`. `CREDENTIAL_BASENAME` (lib/read-window.mjs) guards
 * `read_lines` and `read_around`. They were written separately and they
 * disagreed. Measured 2026-08-13 through the real dispatcher:
 *
 *   read_lines LEAKED : vault.pfx · keys.jks · secrets.json · credentials.yml
 *                       · service-account.json
 *   read_file  LEAKED : .git-credentials
 *
 * Each list covered holes the other left, so which secrets were protected
 * depended on which verb the model happened to pick. That is not a policy, it is
 * an accident with two authors.
 *
 * ⭐ ONE LIST NOW. `read-window.mjs` delegates to `refusedCommitPath`, and
 * `.git-credentials` — which only the other list had — is folded into it. The
 * union is strictly safer than either half, and there is one place to add
 * `.pgpass` when someone remembers it.
 *
 * ⚠️ THIS TEST IS TABLE-DRIVEN ACROSS TOOLS ON PURPOSE. A per-tool test is what
 * allowed the divergence: each one passed, about its own list.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalExecutor } from '../lib/workspace.mjs';
import { executeToolCall } from '../lib/tools.mjs';
import { refusedCommitPath } from '../lib/secret-paths.mjs';

const CANARY = 'CANARY_SECRET_VALUE';

/** Every shape either list ever claimed to cover, plus a control. */
const FILES = [
  '.env', '.env.local', 'id_rsa', 'id_ed25519', 'server.pem', 'app.key',
  'store.p12', 'vault.pfx', 'keys.jks', '.npmrc', '.git-credentials',
  'secrets.json', 'credentials.yml', 'service-account.json',
];
const ORDINARY = ['src/app.js', 'README.md', 'package.json'];

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-onelist-'));
  for (const n of [...FILES, 'README.md', 'package.json']) writeFileSync(join(root, n), `V=${CANARY}\n`);
  return root;
}

const call = async (root, name, args) => {
  const rec = await executeToolCall(
    { id: '1', function: { name, arguments: JSON.stringify(args) } },
    createLocalExecutor(root),
    { allowRun: false },
  );
  return rec.result;
};

const leaked = (result) => JSON.stringify(result ?? {}).includes(CANARY);

test('⭐⭐ every credential shape is refused by BOTH read verbs — no verb-shopping', async () => {
  const root = workspace();
  for (const file of FILES) {
    const viaRead = await call(root, 'read_file', { path: file });
    const viaLines = await call(root, 'read_lines', { path: file, offset: 1, limit: 5 });
    assert.ok(!leaked(viaRead), `read_file leaked ${file}`);
    assert.ok(!leaked(viaLines), `read_lines leaked ${file} — the model can simply pick the other verb`);
  }
});

test('⭐⭐ the shared list is the single source of truth for both', async () => {
  /**
   * ⚠️ Asserted against `refusedCommitPath` itself, so a file added to that list
   * is covered by every consumer at once. Without this, the next person adds
   * `.pgpass` to one of them and the divergence starts again from zero.
   */
  for (const file of FILES) {
    assert.ok(
      refusedCommitPath(file) !== null,
      `${file} is guarded by a tool but absent from the shared list — that is how the two drifted apart`,
    );
  }
});

test('⚠️ ordinary files are untouched by BOTH — the guard must not eat correct work', async () => {
  const root = workspace();
  for (const file of ORDINARY.filter((f) => !f.includes('/'))) {
    const viaRead = await call(root, 'read_file', { path: file });
    const viaLines = await call(root, 'read_lines', { path: file, offset: 1, limit: 5 });
    assert.equal(viaRead.ok, true, `read_file refused ordinary ${file}`);
    assert.equal(viaLines.ok, true, `read_lines refused ordinary ${file}`);
  }
  assert.equal(refusedCommitPath('src/app.js'), null);
  assert.equal(refusedCommitPath('README.md'), null);
});

test('⚠️ .env.example is refused too, and that is the deliberate cost of a rule with no exceptions', () => {
  /**
   * read-window.mjs already argued this in its own comment: "harmless-looking
   * .env variants are fine" is how the rule dies. Recorded here so nobody
   * "fixes" it later without meeting the argument.
   */
  assert.ok(refusedCommitPath('.env.example') !== null);
});
