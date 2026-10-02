/**
 * #497 — `GIT_CONFIG_COUNT` / `_KEY_n` / `_VALUE_n` are scrubbed TOGETHER.
 *
 * MEASURED 2026-10-01 driving the published `acuvo` 0.6.25 in a shell that sets
 * them (CI runners and egress proxies do): the secret-name pattern dropped every
 * `GIT_CONFIG_KEY_n` and kept `GIT_CONFIG_COUNT`, so git died before doing
 * anything — "missing config key GIT_CONFIG_KEY_0" — and `/review` reported a
 * real repository as "not a git repository". The `_VALUE_n` half (which can hold
 * an `http.extraheader` credential) was the half passed through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scrubEnvironment } from '../lib/command.mjs';
import { gitEnvironment, resolveRepo } from '../lib/git.mjs';

const FAMILY = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'http.proxy',
  GIT_CONFIG_VALUE_0: 'http://127.0.0.1:9',
  GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_1: 'AUTHORIZATION: basic c2VjcmV0',
};

test('the whole family is dropped — never a COUNT without its KEYs', () => {
  const out = scrubEnvironment({ PATH: process.env.PATH, ...FAMILY });
  for (const name of Object.keys(FAMILY)) assert.equal(name in out, false, `${name} survived`);
  assert.equal(out.PATH, process.env.PATH);
});

test('a credential in GIT_CONFIG_VALUE_n does not reach a child process', () => {
  const out = scrubEnvironment({ ...FAMILY });
  assert.equal(Object.values(out).some((v) => String(v).includes('c2VjcmV0')), false);
});

test('unrelated GIT_ variables are untouched', () => {
  const out = scrubEnvironment({ GIT_EDITOR: 'true', GIT_CONFIG_NOSYSTEM: '1' });
  assert.equal(out.GIT_EDITOR, 'true');
  assert.equal(out.GIT_CONFIG_NOSYSTEM, '1');
});

test('end to end: a real repository is found when the parent shell sets the family', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-gitcfg-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'x');
  const saved = {};
  for (const [k, v] of Object.entries(FAMILY)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    // what git itself does with the env the CLI hands it
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, env: gitEnvironment() });
    assert.equal(r.status, 0, String(r.stderr));
    const repo = await resolveRepo(dir, { allowSubdirectory: true });
    assert.equal(repo.ok, true, JSON.stringify(repo));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
