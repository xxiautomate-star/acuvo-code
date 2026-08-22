/**
 * ── ⚠️⚠️ ONE VERB, FOUR PATHS, AND ONLY THREE WERE HARDENED ─────────────────
 *
 * `turn.mjs`'s automatic pre-load refuses credential files. `search.mjs` refuses
 * them. `repo-map.mjs` and `session.mjs` refuse them. All four use the same
 * shared list, `refusedCommitPath` (lib/git.mjs:100-107).
 *
 * The model-driven `read_file` used none of it. Probed against the real executor
 * on 2026-08-13:
 *
 *   LEAKED  .env · .env.local · id_rsa · server.pem · .npmrc
 *   LEAKED  config/credentials.yml · secrets.json
 *   search_text for the same canary matched ONLY src/app.js
 *
 * So search had been fixed and read had not — the "one verb, two paths, one
 * hardened" shape this repo has already paid for twice. `turn.mjs:112` calls
 * this class "THE WORST BUG THIS PACKAGE HAS HAD" in its own comment, and fixed
 * it in exactly one of the places it lives.
 *
 * ⭐ WHY IT MATTERS COMMERCIALLY, not just morally: a read here goes straight
 * into the prompt, which goes to a third-party model provider. "Does it send our
 * secrets to someone else's server" is a procurement gate, not a nice-to-have —
 * and the honest answer today was yes, if the model asked.
 *
 * ⚠️ THE LIST IS NOT RE-DECLARED HERE. Importing the same `refusedCommitPath`
 * the other three paths use is the whole point; a second copy of the patterns is
 * how the fourth path drifts back out of agreement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalExecutor } from '../lib/workspace.mjs';
import { executeToolCall } from '../lib/tools.mjs';
import { refusedCommitPath } from '../lib/secret-paths.mjs';

const CANARY = 'CANARY_SECRET_VALUE';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-credread-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const files = {
    '.env': `OPENROUTER_API_KEY=${CANARY}\n`,
    '.env.local': `STRIPE_SECRET=${CANARY}\n`,
    'id_rsa': `-----BEGIN PRIVATE KEY-----\n${CANARY}\n`,
    'server.pem': `-----BEGIN CERTIFICATE-----\n${CANARY}\n`,
    '.npmrc': `//registry.npmjs.org/:_authToken=${CANARY}\n`,
    'config/credentials.yml': `password: ${CANARY}\n`,
    'secrets.json': `{"aws_secret":"${CANARY}"}\n`,
    'src/app.js': 'export const ok = 1;\n',
  };
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  return root;
}

const CREDENTIALS = ['.env', '.env.local', 'id_rsa', 'server.pem', '.npmrc', 'config/credentials.yml', 'secrets.json'];

/**
 * ⚠️ `executeToolCall(call, EXECUTOR, options)` — the second argument is the
 * executor itself, not an options bag. The first draft of this helper passed
 * `{ root, dryRun, executor }` there, and every test in this file failed,
 * including the one asserting that ORDINARY source still reads. That last
 * failure is what gave it away: a control that fails on unfixed code is testing
 * the harness, not the product.
 *
 * ⭐ Third time in one session I have called an internal API with the wrong
 * shape (`resolveInWorkspace`'s intent, `budget.record`'s entry, this). The
 * cheap habit that catches all three: keep one assertion that MUST pass before
 * the fix, and disbelieve the whole file when it does not.
 */
const readVia = async (root, path) => {
  const rec = await executeToolCall(
    { id: '1', function: { name: 'read_file', arguments: JSON.stringify({ path }) } },
    createLocalExecutor(root),
    { allowRun: false },
  );
  return rec.result;
};

test('⭐⭐ read_file does not hand the model a credential file', async () => {
  const root = workspace();
  for (const rel of CREDENTIALS) {
    const r = await readVia(root, rel);
    const body = JSON.stringify(r);
    assert.ok(
      !body.includes(CANARY),
      `${rel} leaked its contents into the tool result — and a tool result goes straight into the prompt, `
      + 'which goes to a third-party provider',
    );
  }
});

test('⭐ and the refusal says WHY, so the model does not simply try again', async () => {
  const root = workspace();
  const r = await readVia(root, '.env');
  assert.equal(r.ok, false);
  assert.match(String(r.error ?? ''), /credential|secret/i, 'name the class of file');
  assert.ok(
    /ask|paste|owner|you|yourself|tell/i.test(String(r.error ?? '')),
    `say how the person CAN supply what is needed. Got: ${r.error}`,
  );
});

test('⚠️ ordinary source is completely untouched — this must not refuse correct work', async () => {
  const root = workspace();
  const r = await readVia(root, 'src/app.js');
  assert.equal(r.ok, true, 'reading source is the entire job');
  assert.match(String(r.content ?? ''), /export const ok/);
});

test('⚠️⚠️ the read path agrees with the list the other three paths already use', async () => {
  /**
   * The fourth path must not carry its own copy of the patterns. This asserts it
   * consults the SAME `refusedCommitPath` — so when someone adds `.pgpass` to
   * that list, all four paths gain it at once instead of three.
   */
  const root = workspace();
  for (const rel of [...CREDENTIALS, 'src/app.js']) {
    const listSays = refusedCommitPath(rel) !== null;
    const r = await readVia(root, rel);
    assert.equal(
      r.ok, !listSays,
      `disagreement on ${rel}: the shared list says ${listSays ? 'credential' : 'ordinary'} but read ${r.ok ? 'allowed' : 'refused'} it`,
    );
  }
});

test('⭐ the EXECUTOR still reads them — the guard belongs to the model, not the machinery', () => {
  /**
   * ⚠️ Learned an hour earlier on the `.acuvo/` guard: putting a model-facing
   * refusal into shared plumbing broke seven tests of legitimate internal work.
   * `session.mjs` and `repo-map.mjs` do their own filtering deliberately, and
   * `--doctor` must still be able to check whether a `.env` exists. So the low
   * level stays open and the MODEL's door is the one that is shut.
   */
  const root = workspace();
  const direct = createLocalExecutor(root).readFile('.env');
  assert.equal(direct.ok, true, 'internal callers keep working; only the tool dispatch refuses');
});
