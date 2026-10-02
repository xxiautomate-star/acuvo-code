/**
 * ── 🪟🚨⭐⭐⭐ `spawn EINVAL` — EVERY GLOBALLY-INSTALLED MCP SERVER WAS DEAD ───
 *
 * MEASURED 2026-09-18, from Roman's own terminal, testing the CLI:
 *
 *     ✖ stitch-mcp unavailable: could not start: spawn EINVAL
 *
 * ⭐ THE CODE ALREADY PREDICTED THIS AND ONLY FIXED HALF. The note above
 * `nodeCliEntry` says, correctly, that resolving to a `.cmd` and spawning it by
 * absolute path is rejected with EINVAL — the BatBadBut protection
 * (CVE-2024-27980) doing its job. But its escape is keyed on the NAMES `npm` and
 * `npx`. A server configured as `"command": "stitch-mcp"` — which is what every
 * globally-installed Node CLI looks like — took the other branch and died.
 *
 * ⚠️ WHY NOT `shell: true`: it would hand a shell a command string assembled
 * from a config file, on the one path that also carries the user's API tokens in
 * its environment. `nodeShimEntry` interprets nothing — it READS a file already
 * on PATH and hands `node` an absolute `.js` path with `shell: false`.
 *
 * ⚠️ MUTATION-PROVEN:
 *   M1  the `%dp0%` spelling dropped from the pattern  → the real-shim row RED
 *   M2  the existsSync check removed                   → the refuses-to-guess row RED
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeShimEntry } from '../lib/mcp.mjs';

const WIN = process.platform === 'win32';

/** npm's real shim shape, copied from a live one on this machine. */
function writeShim(dir, name, target) {
  const cmd = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\' + target + '" %*',
  ].join('\r\n');
  const p = join(dir, name + '.cmd');
  writeFileSync(p, cmd);
  return p;
}

test('⭐ THE MEASURED DEFECT: a global shim resolves to the JS it would have run', { skip: !WIN }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-shim-'));
  mkdirSync(join(dir, 'node_modules', 'stitch-mcp'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'stitch-mcp', 'index.js'), '// entry\n');
  const shim = writeShim(dir, 'stitch-mcp', 'node_modules\\stitch-mcp\\index.js');

  const entry = nodeShimEntry(shim);
  assert.ok(entry, 'stitch-mcp died with spawn EINVAL because this returned nothing');
  assert.ok(entry.endsWith('index.js'));
});

test('⛔ it REFUSES rather than guesses — a shim whose target is not on disk', { skip: !WIN }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-shim-'));
  const shim = writeShim(dir, 'ghost', 'node_modules\\ghost\\index.js');
  assert.equal(
    nodeShimEntry(shim), null,
    'inventing a path makes a server fail in a NEW way instead of the way it fails today',
  );
});

test('⚠️ not a shim, not our business', { skip: !WIN }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-shim-'));
  const p = join(dir, 'plain.cmd');
  writeFileSync(p, '@echo hello\r\n');
  assert.equal(nodeShimEntry(p), null);
  assert.equal(nodeShimEntry(join(dir, 'thing.exe')), null, 'an .exe spawns fine and must not be rewritten');
});

test('⭐ POSIX is untouched — there are no .cmd shims there', () => {
  if (WIN) return;
  assert.equal(nodeShimEntry('/usr/local/bin/anything.cmd'), null);
});
