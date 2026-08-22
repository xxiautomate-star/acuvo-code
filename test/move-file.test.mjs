/**
 * ── ⭐⭐ RENAMING WAS IMPOSSIBLE, NOT MERELY EXPENSIVE ───────────────────────
 *
 * With no move verb, the only way to rename was read_file + write_file +
 * delete_file: three rounds of a five-round default, and the file's whole
 * content through the model's context twice. MEASURED against the real
 * executor, two entirely ordinary files could not do it at all:
 *
 *   a 250KB source file  → read_file refuses, "over the 200000-byte read limit"
 *   logo.png             → read_file refuses as binary — which is the GOOD
 *                          outcome, because the alternative is a silent
 *                          corruption on the way back out
 *
 * So an agent could not rename a large module or move an image into `assets/`,
 * and the only explanation it received was a read error about a file it never
 * wanted to read in the first place.
 *
 * ⚠️⚠️ AND THE OBVIOUS IMPLEMENTATION LAUNDERS CREDENTIALS. `git.mjs` refuses
 * to COMMIT `.env`, `id_rsa` and `*.pem` BY PATH, so `move_file('.env',
 * 'notes/env.txt')` then `git_commit` would put the secret in history with
 * every check passing — the name it is checked under being one the agent chose.
 * Verified against the real `refusedCommitPath` before a line was written:
 * `.env` REFUSED, `notes/env.txt` allowed.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { executeToolCall, toolNamesForRounds, toolSchemasFor } from '../lib/tools.mjs';
import { openJournal, readJournal, planRewind, applyRewind } from '../lib/checkpoint.mjs';

const made = [];
function ws() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-move-'));
  made.push(root);
  return root;
}
const cleanup = () => {
  for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
};

/** A real PNG, so "binary" is a fact rather than a fixture full of high bytes. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c6360000002000100ffff0300000600055d0a2db40000000049454e44ae426082', 'hex',
);

const move = (ex, args) => executeToolCall(
  { id: 'm', function: { name: 'move_file', arguments: JSON.stringify(args) } }, ex, {},
);

test('⭐⭐ a file TOO LARGE TO READ can be moved — this was impossible', async (t) => {
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root);
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(250_000));

  // The control: this is exactly why the verb exists.
  assert.equal(ex.readFile('big.txt').ok, false, 'if read_file starts accepting 250KB, this test is measuring nothing');

  const r = await move(ex, { from: 'big.txt', to: 'src/big.txt' });
  assert.equal(r.result.ok, true, r.result.error);
  assert.equal(statSync(join(root, 'src', 'big.txt')).size, 250_000, 'every byte must survive');
  assert.equal(existsSync(join(root, 'big.txt')), false, 'a move that leaves the source behind is a copy');
});

test('⭐⭐ a BINARY file can be moved, byte-identical — this was impossible', async (t) => {
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root);
  writeFileSync(join(root, 'logo.png'), PNG);
  assert.equal(ex.readFile('logo.png').ok, false, 'the control: read_file must still refuse binary');

  const r = await move(ex, { from: 'logo.png', to: 'assets/img/logo.png' });
  assert.equal(r.result.ok, true, r.result.error);
  const landed = readFileSync(join(root, 'assets', 'img', 'logo.png'));
  assert.ok(landed.equals(PNG), 'the bytes changed — a rename that corrupts is worse than one that refuses');
  assert.equal(existsSync(join(root, 'assets', 'img')), true, 'parent directories must be created, as write_file does');
});

test('⚠️⚠️ THE LAUNDERING: moving a credential OUT of the protected namespace is refused', async (t) => {
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root);
  writeFileSync(join(root, '.env'), 'OPENROUTER_API_KEY=sk-real\n');

  const r = await move(ex, { from: '.env', to: 'notes/env.txt' });
  assert.equal(r.result.ok, false, 'the secret would have become committable under a name the agent chose');
  assert.match(r.result.error, /credential/i);
  assert.equal(existsSync(join(root, '.env')), true, 'and nothing may have moved before the refusal');
  assert.equal(existsSync(join(root, 'notes', 'env.txt')), false);
});

test('⚠️ every credential shape git.mjs refuses, not just .env', async (t) => {
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root);
  for (const [name, dest] of [
    ['id_rsa', 'docs/key.txt'],
    ['server.pem', 'docs/cert.txt'],
    ['credentials.json', 'docs/creds.json'],
    ['.npmrc', 'docs/npmrc.txt'],
  ]) {
    writeFileSync(join(root, name), 'secret');
    // eslint-disable-next-line no-await-in-loop
    const r = await move(ex, { from: name, to: dest });
    assert.equal(r.result.ok, false, `${name} was launderable to ${dest}`);
  }
});

test('⭐⭐ a rename INSIDE the protected namespace still works — blanket refusal would fail correct work', async (t) => {
  /**
   * `.env` → `.env.bak` is still refused at commit time, so nothing is
   * laundered and there is no reason to block it. Refusing every move of a
   * credential-shaped path would also block renaming `.env.example`, which is
   * an ordinary thing to do. A guard that fails correct work is worse than no
   * guard — this package has paid for that four times in one day.
   */
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root);
  writeFileSync(join(root, '.env.example'), 'KEY=\n');
  const r = await move(ex, { from: '.env.example', to: '.env.sample' });
  assert.equal(r.result.ok, true, r.result.error);
  assert.equal(existsSync(join(root, '.env.sample')), true);
});

test('⚠️ the destination is never silently overwritten', async (t) => {
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root);
  writeFileSync(join(root, 'a.txt'), 'A');
  writeFileSync(join(root, 'b.txt'), 'B');

  const refused = await move(ex, { from: 'a.txt', to: 'b.txt' });
  assert.equal(refused.result.ok, false);
  assert.match(refused.result.error, /overwrite: true/, 'a refusal that does not say what to pass instead is an obstacle');
  assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'B', 'the destination must be untouched');
  assert.equal(existsSync(join(root, 'a.txt')), true, 'and so must the source');

  const allowed = await move(ex, { from: 'a.txt', to: 'b.txt', overwrite: true });
  assert.equal(allowed.result.ok, true, allowed.result.error);
  assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'A');
  assert.equal(allowed.result.replaced, true, 'the receipt must say a file was replaced');
});

test('⚠️⚠️ it cannot escape the workspace, in either direction', async (t) => {
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root);
  writeFileSync(join(root, 'a.txt'), 'A');

  const out = await move(ex, { from: 'a.txt', to: '../escaped.txt' });
  assert.equal(out.result.ok, false, 'a move OUT of the workspace is a write outside it');
  const inward = await move(ex, { from: '../../secrets.txt', to: 'stolen.txt' });
  assert.equal(inward.result.ok, false, 'a move IN from outside is a read of somebody else\'s file');
  assert.equal(existsSync(join(root, 'a.txt')), true);
});

test('⚠️ the write-forbidden roots hold — .git/hooks is remote code execution wearing a filename', async (t) => {
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root);
  writeFileSync(join(root, 'payload.sh'), '#!/bin/sh\necho pwned\n');
  const r = await move(ex, { from: 'payload.sh', to: '.git/hooks/pre-commit' });
  assert.equal(r.result.ok, false, 'a move is a write, and the write rules apply to both ends');
});

test('⚠️ a DIRECTORY is refused, and the reason names the checkpoint', async (t) => {
  /**
   * The journal records one path per mutation, so a directory move would be a
   * single entry covering an unknown number of files and `acuvo rewind` would
   * restore none of them. An undo that lies is worse than a verb that is
   * missing.
   */
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.js'), 'a');
  const r = await move(ex, { from: 'src', to: 'lib' });
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /rewind|checkpoint/i, 'the refusal must say WHY, or it reads as arbitrary');
  assert.equal(existsSync(join(root, 'src', 'a.js')), true);
});

test('⚠️ a missing source says so, and moving a file onto itself is refused', async (t) => {
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root);
  const missing = await move(ex, { from: 'nope.txt', to: 'x.txt' });
  assert.equal(missing.result.ok, false);
  assert.match(missing.result.error, /no such file/);

  writeFileSync(join(root, 'a.txt'), 'A');
  // `./a.txt` and `a.txt` resolve to one file — the check is on the RESOLVED
  // path, or two spellings would look like two files and the source would be
  // deleted by its own move.
  const self = await move(ex, { from: './a.txt', to: 'a.txt' });
  assert.equal(self.result.ok, false);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'A', 'the file must survive its own no-op move');

  /**
   * ⚠️ WITH overwrite: true, AND THAT IS THE ONLY CASE WHERE THE SAME-FILE
   * CHECK IS LOAD-BEARING. Found by a surviving mutation: deleting the check
   * left the suite green, because without `overwrite` the destination-exists
   * guard catches it anyway. With `overwrite` it does not — `renameSync(x, x)`
   * is a silent no-op, so the run would report a successful move and a
   * `replaced: true` receipt for a file that never went anywhere. My test was
   * weaker than the code; the mutation is what said so.
   */
  const selfForced = await move(ex, { from: './a.txt', to: 'a.txt', overwrite: true });
  assert.equal(selfForced.result.ok, false, 'a file moved onto itself must be refused, not reported as replaced');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'A');
});

test('⚠️ --dry-run moves nothing but runs every check first', async (t) => {
  t.after(cleanup);
  const root = ws();
  const ex = createLocalExecutor(root, { dryRun: true });
  writeFileSync(join(root, 'a.txt'), 'A');

  const r = await move(ex, { from: 'a.txt', to: 'src/a.txt' });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.dryRun, true);
  assert.equal(existsSync(join(root, 'src', 'a.txt')), false, 'a dry run that moved the file is not a dry run');
  assert.equal(existsSync(join(root, 'a.txt')), true);

  // And a refusal must still be a refusal in a preview, or the preview is of a
  // different command.
  writeFileSync(join(root, '.env'), 'K=v');
  const refused = await move(ex, { from: '.env', to: 'notes/env.txt' });
  assert.equal(refused.result.ok, false);
});

test('⚠️⚠️ the move is UNDOABLE — `acuvo rewind` puts the file back where it was', async (t) => {
  /**
   * ⭐ THE CLAIM I WROTE INTO THE CODE, CHECKED RATHER THAN ASSERTED. The move
   * records two journal entries before touching disk: a `delete` of the source
   * (which snapshots its bytes — the journal reads a BUFFER, so this works for
   * exactly the binary and oversized files this verb exists for) and a `write`
   * of the destination, which did not exist. A rewind must therefore restore
   * the source AND remove the destination.
   */
  t.after(cleanup);
  const root = ws();
  writeFileSync(join(root, 'logo.png'), PNG);

  const journal = openJournal(root, { runId: 'run-move' });
  const ex = createLocalExecutor(root, { journal });
  const r = await move(ex, { from: 'logo.png', to: 'assets/logo.png' });
  assert.equal(r.result.ok, true, r.result.error);
  assert.equal(existsSync(join(root, 'logo.png')), false);

  applyRewind(root, planRewind(readJournal(root).entries, 'run-move'));

  assert.equal(existsSync(join(root, 'logo.png')), true, 'the source was not restored — the undo is a lie');
  assert.ok(readFileSync(join(root, 'logo.png')).equals(PNG), 'restored, but not byte-identical');
  assert.equal(existsSync(join(root, 'assets', 'logo.png')), false, 'the destination was left behind — that is a copy, not an undo');
});

test('⭐ the verb is OFFERED and its schema is well-formed — built is not the same as reachable', () => {
  const names = toolNamesForRounds(64, { allowRun: true });
  assert.ok(names.includes('move_file'), 'the model is never told the verb exists');
  const [schema] = toolSchemasFor(['move_file']);
  assert.ok(schema, 'offered by name with no schema behind it is worse than absent');
  assert.deepEqual(schema.function.parameters.required, ['from', 'to']);
  assert.equal(schema.function.parameters.properties.overwrite.type, 'boolean');
});

test('⚠️ an executor with no moveFile says so instead of crashing the round', async () => {
  /**
   * The browser builder implements this dispatcher's verbs over a Map. A
   * `TypeError: executor.moveFile is not a function` mid-round costs the round
   * and tells the model nothing it can act on.
   */
  const r = await move({ root: '/tmp', dryRun: false }, { from: 'a', to: 'b' });
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /write_file/, 'the refusal must name the way through');
  assert.equal(r.mutated, false);
});
