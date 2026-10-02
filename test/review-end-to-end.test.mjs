/**
 * #497 — `/init` and `/review` driven through the REAL binary, the way a person
 * types them, against a loopback stub model (no paid call).
 *
 * Two defects this pins, both measured 2026-10-01 driving the binary:
 *  1. In a shell that sets GIT_CONFIG_COUNT/KEY_n/VALUE_n (CI runners, egress
 *     proxies) every git call died, so `/review` called a real repository
 *     "not a git repository". The parent env below sets that family on purpose.
 *  2. The generated review task (a diff) went through `@path` expansion, and every
 *     `@@ -1,3 +1,3 @@` hunk header was announced as "@@ — no such file".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acuvo.mjs');

async function stub() {
  const bodies = [];
  const server = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      bodies.push(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 's', model: 'stub/model',
        choices: [{ message: { role: 'assistant', content: 'src/add.js: add now subtracts — bug.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, bodies, close: () => new Promise((r) => server.close(r)) };
}

function repoWithABug() {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-review-'));
  const g = (...a) => spawnSync('git', a, { cwd: dir, env: { ...process.env, GIT_CONFIG_COUNT: '0' } });
  g('init', '-q');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(dir, 'add.js'), 'export const add = (a, b) => a + b;\n');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(join(dir, 'add.js'), 'export const add = (a, b) => a - b;\n');
  return dir;
}

function drive(dir, input, url) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [BIN, '--dir', dir], {
      cwd: dir,
      env: {
        ...process.env, NO_COLOR: '1', HOME: mkdtempSync(join(tmpdir(), 'acuvo-home-')),
        ACUVO_API_URL: url, OPENROUTER_API_KEY: 'sk-or-v1-stub', ACUVO_TOKEN: '', ACUVO_BYOK: '1',
        // ⚠️ the family a CI runner / proxy sets — the CLI must not break git with it
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat',
      },
    });
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { out += d; });
    cp.stdin.end(input);
    const t = setTimeout(() => { cp.kill(); reject(new Error(`timeout\n${out}`)); }, 60_000);
    cp.on('close', () => { clearTimeout(t); resolve(out); });
  });
}

test('/init writes ACUVO.md; /review reads the diff, sends it once, and announces no phantom @@ file', async () => {
  const s = await stub();
  const dir = repoWithABug();
  try {
    const out = await drive(dir, '/init\n/review\n/exit\n', s.url);
    assert.equal(existsSync(join(dir, 'ACUVO.md')), true, out);
    assert.match(readFileSync(join(dir, 'ACUVO.md'), 'utf8'), /npm run test/);
    assert.doesNotMatch(out, /not a git repository/, out);
    assert.match(out, /changed files? on/);
    assert.doesNotMatch(out, /@@ — no such file/, out);
    assert.equal(s.bodies.length, 1, 'exactly one model call');
    assert.match(s.bodies[0], /a - b/, 'the diff reached the model');
    assert.match(out, /add now subtracts/);
  } finally {
    await s.close();
  }
});
