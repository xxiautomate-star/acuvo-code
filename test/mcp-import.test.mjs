/**
 * ── ⭐⭐ THEIR TOOLS ARRIVE WITH THEM — WITHOUT THEIR SECRETS, AND WITHOUT BOOTING
 *
 * `mcp-detect.mjs` names the real blocker: nobody writes the JSON block. A
 * migrating user already wrote it, in another tool's directory. This pins that
 * we find it, that we never carry a secret out of it, and that finding it starts
 * nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectImportableServers, summariseServer, resolveSourcePath, describeImport, IMPORT_SOURCES,
} from '../lib/mcp-import.mjs';

/** A fake disk: paths → contents. */
function disk(files) {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFile: (p) => files[p],
  };
}
const CURSOR = 'repo/.cursor/mcp.json';
const VSCODE = 'repo/.vscode/mcp.json';
const opts = (files) => ({ root: 'repo', home: 'home', platform: 'linux', ...disk(files) });

test('finds a Cursor config the CLI could never read before', () => {
  const r = collectImportableServers(opts({
    [CURSOR]: JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'] } } }),
  }));
  assert.equal(r.importable, 1);
  const src = r.sources.find((s) => s.tool === 'Cursor');
  assert.equal(src.servers[0].name, 'linear');
  assert.equal(src.servers[0].kind, 'stdio');
  assert.equal(src.servers[0].argCount, 2);
});

/**
 * ⚠️ VS CODE USES `servers`, EVERYONE ELSE USES `mcpServers`. Assuming one shape
 * reads a valid config as empty and tells a user with six servers that there is
 * nothing to import — a silent wrong answer, not an error.
 */
test('reads the VS Code shape, whose key is different', () => {
  const r = collectImportableServers(opts({
    [VSCODE]: JSON.stringify({ servers: { pg: { command: 'dbhub' } } }),
  }));
  assert.equal(r.importable, 1, 'the VS Code `servers` key was not read');

  const wrongKey = collectImportableServers(opts({
    [VSCODE]: JSON.stringify({ mcpServers: { pg: { command: 'dbhub' } } }),
  }));
  assert.equal(wrongKey.importable, 0, 'VS Code was read under the wrong key');
});

/**
 * ⭐⭐ THE RULE THIS FILE EXISTS FOR. `mcp-consent.mjs`: *"mcp.json is one of the
 * few files people type a raw token into."* An importer that echoed a value into
 * a terminal, a log or a prompt would be the fastest credential leak we have.
 */
test('carries env KEYS and never env VALUES', () => {
  const secret = 'ghp_REALTOKENVALUE123';
  const r = collectImportableServers(opts({
    [CURSOR]: JSON.stringify({
      mcpServers: { gh: { command: 'gh-mcp', env: { GITHUB_TOKEN: secret, OTHER: 'x' } } },
    }),
  }));
  const srv = r.sources[0].servers[0];
  assert.deepEqual(srv.envKeys, ['GITHUB_TOKEN', 'OTHER']);
  assert.equal(JSON.stringify(r).includes(secret), false, 'a secret VALUE survived into the result');
  assert.equal((describeImport(r) ?? '').includes(secret), false, 'a secret VALUE survived into the output');
});

/**
 * ⚠️ `.mcp.json` IS CLAUDE CODE'S PROJECT CONFIG AND `mcp.mjs` ALREADY READS IT.
 * Reporting it as an import would inflate the feature with a file that already
 * worked — the kind of claim this repo has shipped before.
 */
test('does not claim credit for the file we already read', () => {
  const r = collectImportableServers(opts({
    'repo/.mcp.json': JSON.stringify({ mcpServers: { deepwiki: { command: 'x' } } }),
  }));
  assert.equal(r.importable, 0);
  assert.equal(r.alreadyRead, 1);
  assert.match(describeImport(r), /already read by Acuvo/);
  assert.match(describeImport(r), /Nothing new to import/);
});

test('a broken declaration is named, not repaired', () => {
  const r = collectImportableServers(opts({
    [CURSOR]: JSON.stringify({ mcpServers: { bad: { args: ['x'] } } }),
  }));
  assert.equal(r.sources[0].servers[0].usable, false);
  assert.match(describeImport(r), /no command or url/);
});

/**
 * ⚠️⚠️ FOUND BY RUNNING THE REAL COMMAND, NOT BY A UNIT TEST. Every unit above
 * passed while a byte-for-byte valid Cursor config written by PowerShell was
 * reported as "not valid JSON" — because `JSON.parse` throws on a leading
 * U+FEFF and a UTF-8 BOM is what Windows tooling writes by default.
 *
 * ⭐ The worst shape of wrong answer available here: the user opens the file,
 * sees good JSON, and concludes our importer is broken.
 */
test('a UTF-8 BOM is an encoding, not a broken config', () => {
  const r = collectImportableServers(opts({
    [CURSOR]: `﻿${JSON.stringify({ mcpServers: { linear: { command: 'npx' } } })}`,
  }));
  assert.equal(r.sources[0].error, undefined, 'a BOM was reported as invalid JSON');
  assert.equal(r.importable, 1);
});

test('unparseable JSON is reported as unparseable', () => {
  const r = collectImportableServers(opts({ [CURSOR]: '{ not json' }));
  assert.equal(r.sources[0].error, 'not valid JSON');
  assert.equal(r.importable, 0);
});

test('a remote server keeps its destination, because that is its identity', () => {
  const s = summariseServer('sentry', { url: 'https://mcp.sentry.dev/sse', type: 'http' });
  assert.equal(s.kind, 'remote');
  assert.equal(s.target, 'https://mcp.sentry.dev/sse');
  assert.equal(s.usable, true);
});

/**
 * ⚠️ RETURNS null RATHER THAN A GUESS on a platform with no entry — a path built
 * out of `undefined` is a path that could exist by accident.
 */
test('platform paths resolve per platform and refuse to guess', () => {
  const desktop = IMPORT_SOURCES.find((s) => s.tool === 'Claude Desktop');
  const mac = resolveSourcePath(desktop, { root: 'r', home: 'h', platform: 'darwin' });
  assert.match(mac, /Library\/Application Support\/Claude\/claude_desktop_config\.json$/);
  assert.equal(resolveSourcePath(desktop, { root: 'r', home: 'h', platform: 'sunos' }), null);
});

/**
 * ⭐⭐ THE MOST IMPORTANT LINE IN THE OUTPUT. On seeing their own servers listed
 * inside a new tool, a reader's reasonable assumption is that it connected them.
 * An importer that starts a server is remote code execution with a friendly name.
 */
test('the output states plainly that nothing was started or written', () => {
  const r = collectImportableServers(opts({
    [CURSOR]: JSON.stringify({ mcpServers: { linear: { command: 'npx' } } }),
  }));
  const out = describeImport(r);
  assert.match(out, /Nothing has been started and nothing has been written/);
  assert.match(out, /your decision/);
});

test('an empty machine says nothing at all', () => {
  assert.equal(describeImport(collectImportableServers(opts({}))), null);
});
