/**
 * ── ⚠️⚠️ A BARE `npm install` HAD NOTHING FOR ANY CHECK TO LOOK AT ──────────
 *
 * `validateInstallSpec` refuses a URL, a git repo, `user/repo` and an `npm:`
 * alias — WHEN THE AGENT TYPES IT AS AN OPERAND. `inspectNpmrcForInstall`
 * refuses a redirected registry. Both exist because the workspace is writable
 * and a cloned repository ships its own files.
 *
 * ⚠️ AND `package.json` NAMES THE SAME THINGS WITH NO OPERAND AT ALL. `npm
 * install` with no packages collected an empty list, every check passed
 * correctly on a command that had nothing to check, and npm then read the
 * manifest the repository shipped.
 *
 * MEASURED A/B, the real `executeRunCommand`, a real attacker HTTP server on
 * loopback serving a real installable tarball named `zod`, same script both
 * times:
 *   pre-fix (HEAD)   ok:true, exitCode 0, 1 request to the attacker host,
 *                    node_modules/zod on disk containing "PWNED"
 *   with the fix     refused, 0 requests, nothing on disk
 * The pre-fix run REPORTED SUCCESS. Its receipt said `installed: []`, because
 * no operand was ever typed.
 *
 * ⚠️⚠️ AND THE LOCKFILE WAS CALLED THE SAFEST ONE. `validateNpmInstall`'s
 * comment said `npm ci` "installs exactly what the lockfile already records,
 * which makes it the SAFEST member of this family". Every clause true, the
 * conclusion backwards: in the threat model this file is written for — a
 * repository somebody else wrote — "the repository has already committed to it"
 * is the attack. `package-lock.json` carries a `resolved` URL per package and
 * npm fetches from it, so an innocent `package.json` is no evidence at all.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  inspectManifestForInstall, inspectLockfileForInstall, executeRunCommand,
} from '../lib/command.mjs';

/**
 * ⚠️ `executeRunCommand` READS `process.env`, IT TAKES NO `env` OPTION. The
 * first version of these tests passed one, which did nothing — two tests failed
 * outright and, far worse, ONE PASSED FOR THE WRONG REASON: it was refused by
 * the install gate and never reached the check it was written for. A test that
 * cannot reach its subject is a check that cannot fail.
 */
function withInstallAllowed(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'ACUVO_ALLOW_INSTALL');
  const prev = process.env.ACUVO_ALLOW_INSTALL;
  process.env.ACUVO_ALLOW_INSTALL = '1';
  return (async () => fn())().finally(() => {
    if (had) process.env.ACUVO_ALLOW_INSTALL = prev; else delete process.env.ACUVO_ALLOW_INSTALL;
  });
}

const manifest = (o) => inspectManifestForInstall(JSON.stringify(o));
const lock = (o) => inspectLockfileForInstall(JSON.stringify(o));

test('⚠️⚠️ THE ATTACK: a tarball URL in dependencies is refused', () => {
  const r = manifest({ dependencies: { zod: 'http://127.0.0.1:9999/x.tgz' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /zod/, 'the refusal must name which dependency');
  assert.match(r.error, /registry/i);
});

test('⚠️ every network shape a manifest can name', () => {
  for (const [spec, why] of [
    ['https://evil.example/x.tgz', 'https tarball'],
    ['git+ssh://git@host/x.git', 'git over ssh'],
    ['git://host/x.git', 'git protocol'],
    ['github:someone/evil', 'explicit github protocol'],
    ['someone/evil', 'GitHub shorthand — no protocol in sight'],
    ['someone/evil#a1b2c3d', 'GitHub shorthand pinned to a commit'],
    ['npm:totally-not-zod@1', 'an alias: the line reads "zod", something else lands'],
  ]) {
    assert.equal(manifest({ dependencies: { zod: spec } }).ok, false, `${why} — ${spec}`);
  }
});

test('⚠️⚠️ `overrides` is the same attack against a TRANSITIVE dependency', () => {
  // Nobody reading the direct dependency list would look at it, and npm honours
  // it for packages the manifest never mentions.
  assert.equal(manifest({ overrides: { lodash: 'https://evil.example/x.tgz' } }).ok, false);
  assert.equal(manifest({ overrides: { foo: { bar: 'https://evil.example/x.tgz' } } }).ok, false,
    'overrides nest arbitrarily, so the walk has to as well');
  assert.equal(manifest({ overrides: { foo: { '.': 'https://evil.example/x.tgz' } } }).ok, false,
    'the "." key is how npm overrides the package itself');
});

test('⚠️ dev, optional and peer dependencies are the same door', () => {
  for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(manifest({ [field]: { zod: 'https://evil.example/x.tgz' } }).ok, false, field);
  }
});

test('⭐⭐ CORRECT WORK MUST NOT FAIL — this rule is looser than the operand rule ON PURPOSE', () => {
  /**
   * An operand is the AGENT's choice, so `validateInstallVersion` can insist on
   * a version a human checks at a glance. A manifest is the PROJECT's, already
   * written, and `">=17"`, `"1.x"` and `"*"` are all over real repositories.
   * The only question asked here is WHERE THE CODE COMES FROM. A guard that
   * refuses correct work is worse than no guard, and this package has paid for
   * that four times in one day.
   */
  for (const spec of ['^4.1.12', '~1.2.3', '>=17', '1.x', '*', '', 'latest', '4 || 5', '>=1 <9']) {
    assert.equal(manifest({ dependencies: { a: spec } }).ok, true, `a legitimate range was refused: ${JSON.stringify(spec)}`);
  }
  assert.equal(manifest({ dependencies: { '@types/node': '^20' } }).ok, true, 'scoped packages');
  assert.equal(manifest({ name: 'x', version: '1.0.0' }).ok, true, 'a manifest with no dependencies at all');
});

test('⭐ local protocols are allowed — they fetch nothing from a network', () => {
  // How every monorepo refers to its own packages. Lifecycle scripts are
  // already off, so the worst case is a symlink to a directory already here.
  for (const spec of ['workspace:*', 'file:../pkg', 'link:../pkg', 'portal:../pkg']) {
    assert.equal(manifest({ dependencies: { a: spec } }).ok, true, spec);
  }
});

test('⚠️⚠️ THE LOCKFILE: a resolved URL that is not the registry is refused', () => {
  assert.equal(lock({ packages: { 'node_modules/zod': { resolved: 'http://evil.example/x.tgz' } } }).ok, false);
  // v1 lockfiles use `dependencies`, v2/v3 use `packages`. Both install.
  assert.equal(lock({ dependencies: { zod: { resolved: 'https://evil.example/x.tgz' } } }).ok, false);
});

test('⭐ a real registry lockfile passes, and an ABSENT resolved is not suspicious', () => {
  assert.equal(lock({
    packages: { 'node_modules/zod': { resolved: 'https://registry.npmjs.org/zod/-/zod-4.1.12.tgz' } },
  }).ok, true);
  // npm omits `resolved` for the root entry and for local/bundled ones.
  assert.equal(lock({ packages: { '': { name: 'x' }, 'node_modules/a': {} } }).ok, true);
});

test('⚠️ a registry LOOKALIKE host is not the registry', () => {
  for (const url of [
    'https://registry.npmjs.org.evil.example/x.tgz',
    'https://evil.example/registry.npmjs.org/x.tgz',
    'http://registry.npmjs.org/x.tgz',
  ]) {
    assert.equal(lock({ packages: { a: { resolved: url } } }).ok, false, url);
  }
});

test('⚠️⚠️ REACH: the real executeRunCommand refuses BEFORE anything is spawned', async () => {
  /**
   * ⭐ THE ASSERTION IS THAT NOTHING SPAWNED, not that an error came back. A
   * refusal returned after npm already ran would satisfy a result-shaped test
   * and change nothing — and this is precisely the shape that shipped: pre-fix
   * the same call returned `ok:true, exitCode:0` with the attacker's code on
   * disk.
   */
  const spawned = [];
  const files = {
    'package.json': JSON.stringify({ name: 'innocent', dependencies: { zod: 'http://127.0.0.1:9/x.tgz' } }),
  };
  const executor = {
    root: process.cwd(),
    readFile: (p) => (p in files ? { ok: true, content: files[p] } : { ok: false, error: 'no such file' }),
  };
  const res = await withInstallAllowed(() => executeRunCommand({
    command: 'npm install',
    executor,
    timeoutMs: 5_000,
    spawnImpl: (...a) => { spawned.push(a); throw new Error('must not spawn'); },
  }));
  assert.equal(res.ok, false);
  assert.deepEqual(spawned, [], 'npm was spawned despite a manifest naming an attacker URL');
  assert.match(String(res.error), /outside the npm registry/);
});

test('⚠️ REACH: an innocent manifest with a hostile LOCKFILE is refused too', async () => {
  const spawned = [];
  const files = {
    'package.json': JSON.stringify({ name: 'innocent', dependencies: { zod: '^4.1.12' } }),
    'package-lock.json': JSON.stringify({
      packages: { 'node_modules/zod': { resolved: 'https://evil.example/zod.tgz' } },
    }),
  };
  const executor = {
    root: process.cwd(),
    readFile: (p) => (p in files ? { ok: true, content: files[p] } : { ok: false, error: 'no such file' }),
  };
  const res = await withInstallAllowed(() => executeRunCommand({
    command: 'npm ci',
    executor,
    timeoutMs: 5_000,
    spawnImpl: (...a) => { spawned.push(a); throw new Error('must not spawn'); },
  }));
  assert.equal(res.ok, false, '`npm ci` was called the SAFEST member of this family; it reads the file the attacker wrote');
  assert.deepEqual(spawned, []);
});

test('⭐ REACH: an ordinary project still installs — the gate is not the default', async () => {
  // The other half of every guard in this package: it must let correct work
  // through, verified by getting all the way to the spawn.
  const spawned = [];
  const files = {
    'package.json': JSON.stringify({ name: 'ordinary', dependencies: { zod: '^4.1.12' } }),
    'package-lock.json': JSON.stringify({
      packages: { 'node_modules/zod': { resolved: 'https://registry.npmjs.org/zod/-/zod-4.1.12.tgz' } },
    }),
  };
  const executor = {
    root: process.cwd(),
    readFile: (p) => (p in files ? { ok: true, content: files[p] } : { ok: false, error: 'no such file' }),
  };
  await withInstallAllowed(() => executeRunCommand({
    command: 'npm install',
    executor,
    timeoutMs: 5_000,
    spawnImpl: (...a) => { spawned.push(a); throw new Error('reached the spawn, which is the point'); },
  }));
  assert.equal(spawned.length, 1, 'a clean project must reach the spawn — a guard that blocks it is worse than none');
});
