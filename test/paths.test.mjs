import { test } from 'node:test';
import assert from 'node:assert';
import { mentionedPaths } from '../lib/turn.mjs';

test('⚠️ a dotted IDENTIFIER is not a file — this fired on real output', () => {
  /**
   * Building a task API, the summary warned "the reply named 4 files it did not
   * write: assert.ok · created.body.id · assert.equal". Those are JavaScript
   * expressions the model quoted while explaining a test.
   * ⭐ A warning that fires on ordinary code is one people scroll past, and then
   * it protects nothing.
   */
  assert.deepStrictEqual(mentionedPaths('call assert.ok then check created.body.id via assert.equal'), []);
  assert.deepStrictEqual(mentionedPaths('res.statusCode and err.message and arr.length'), []);
});

test('...while real paths still come through', () => {
  const found = mentionedPaths('I created src/server.js, test/api.test.js and README.md');
  assert.deepStrictEqual(found.sort(), ['README.md', 'src/server.js', 'test/api.test.js']);
});

test('and the two older false-alarm guards still hold', () => {
  // Node.js is a product name; 1.2.3 is a version.
  assert.deepStrictEqual(mentionedPaths('using Node.js, bumped to version 1.2.3'), []);
});

test('⚠️⚠️ credentials never reach the prompt — the worst bug this package has had', async () => {
  /**
   * `gatherWorkspaceContext` reads every SMALL file into the prompt, and `.env`
   * is a small file. Verified leaking on 2026-08-10: an OpenRouter key, a
   * database password and a private key all appeared verbatim in the text sent
   * upstream — with no attacker, on an ordinary run, and `--dry-run` did not
   * stop it because a dry run still builds the prompt.
   *
   * ⭐ The retry chain made it worse: one rate limit fanned the same secrets to
   * three more providers.
   */
  const { createLocalExecutor } = await import('../lib/workspace.mjs');
  const { gatherWorkspaceContext } = await import('../lib/turn.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const ws = mkdtempSync(join(tmpdir(), 'acuvo-leak-'));
  try {
    writeFileSync(join(ws, 'package.json'), '{"name":"d"}\n');
    writeFileSync(join(ws, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-SECRET\n');
    writeFileSync(join(ws, '.env.local'), 'DB_PASSWORD=hunter2\n');
    writeFileSync(join(ws, 'id_rsa'), '-----BEGIN RSA PRIVATE KEY-----\n');
    writeFileSync(join(ws, 'server.pem'), 'certdata\n');
    writeFileSync(join(ws, 'app.mjs'), 'export const a = 1;\n');

    const text = gatherWorkspaceContext(createLocalExecutor(ws)).text;
    for (const secret of ['sk-or-v1-SECRET', 'hunter2', 'BEGIN RSA PRIVATE KEY', 'certdata']) {
      assert.ok(!text.includes(secret), `a credential reached the prompt: ${secret}`);
    }
    // ⚠️ And it must not over-filter — a pre-load that drops real source makes
    // the model write against a guess, which is the failure it exists to avoid.
    assert.ok(text.includes('export const a = 1'), 'real source was filtered out');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
