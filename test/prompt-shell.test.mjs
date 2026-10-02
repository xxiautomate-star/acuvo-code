/**
 * ── ⭐⭐ `!command` AT THE PROMPT (Claude Code parity, 2026-09-26) ────────────
 *
 * Before: `!git status` was sent to the MODEL as a task — a paid round to run
 * a command the person could have typed, then refused by the allowlist anyway.
 * After: it runs in the user's shell, prints, and the output rides on the NEXT
 * message. No model is called for the `!` line itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { runChat } from '../lib/chat.mjs';
import {
  parseShellLine, runShellLine, shellContextBlock, clampTail, SHELL_MODE_MAX_CHARS,
} from '../lib/prompt-shell.mjs';

const piped = (lines) => Readable.from([lines.join('\n') + '\n']);
function sink() {
  const written = [];
  return { write: (s) => { written.push(s); return true; }, text: () => written.join('') };
}

test('parseShellLine: `!` must be the first character; a bare `!` is an empty command', () => {
  assert.deepEqual(parseShellLine('!git status'), { command: 'git status' });
  assert.deepEqual(parseShellLine('!'), { command: '' });
  assert.equal(parseShellLine(' !ls'), null);
  assert.equal(parseShellLine('ship it!'), null);
});

test('clampTail keeps the END — a test verdict is at the bottom of the log', () => {
  const long = `${'x'.repeat(SHELL_MODE_MAX_CHARS)}\nFAIL: the one line that matters`;
  const cut = clampTail(long);
  assert.ok(cut.endsWith('FAIL: the one line that matters'));
  assert.match(cut, /earlier characters cut/);
});

test('runShellLine goes through the user shell, scrubs secrets, and reports the exit code', async () => {
  let seen = null;
  const r = await runShellLine({
    command: 'echo hi',
    cwd: '/work',
    platform: 'linux',
    env: { SHELL: '/bin/bash', OPENROUTER_API_KEY: 'sk-secret', HOME: '/h' },
    runImpl: async (spec) => { seen = spec; return { ok: true, exitCode: 3, stdout: 'hi\n', stderr: 'warn', timedOut: false }; },
  });
  assert.equal(seen.file, '/bin/bash');
  assert.deepEqual(seen.args, ['-c', 'echo hi']);
  assert.equal(seen.cwd, '/work');
  assert.equal(seen.env.OPENROUTER_API_KEY, undefined, 'an !env must never hand the account key to a model');
  assert.equal(typeof seen.timeoutMs, 'number', 'unbounded is how `!npm run dev` hangs the prompt');
  assert.deepEqual(r, { ok: false, exitCode: 3, output: 'hi\nwarn', timedOut: false });
});

test('the held block is labelled as something the PERSON did', () => {
  const b = shellContextBlock([{ command: 'npm test', exitCode: 1, output: '1 failing' }]);
  assert.match(b, /^Commands I ran myself at the prompt/);
  assert.match(b, /\$ npm test\n1 failing\n\(exit 1\)/);
  assert.equal(shellContextBlock([]), '');
});

test('⭐⭐⭐ WIRED: `!cmd` costs no turn, and its output rides on the next message', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-shell-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = sink();
  const sent = [];
  const ranIn = [];
  const r = await runChat({
    root,
    input: piped(['!npm test', 'why is it failing?', 'exit']),
    output: out,
    runOne: async (task) => { sent.push(task); return { ok: true, messages: [] }; },
    render: () => {},
    expandRefs: (_root, text) => ({ text, attached: [], skipped: [] }),
    runShell: async ({ command, cwd }) => { ranIn.push([command, cwd]); return { ok: false, exitCode: 1, output: '1 failing: adds', timedOut: false }; },
  });
  assert.deepEqual(ranIn, [['npm test', root]]);
  assert.equal(r.turns, 1, 'the `!` line itself must not be a paid turn');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].startsWith('why is it failing?'));
  assert.match(sent[0], /\$ npm test\n1 failing: adds\n\(exit 1\)/);
  assert.match(out.text(), /1 failing: adds/, 'and the person saw it when they ran it');
});

test('⚠️ held output is sent ONCE, and /clear drops it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-shell-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sent = [];
  await runChat({
    root,
    input: piped(['!ls', '/clear', 'first', 'second', 'exit']),
    output: sink(),
    runOne: async (task) => { sent.push(task); return { ok: true, messages: [] }; },
    render: () => {},
    expandRefs: (_root, text) => ({ text, attached: [], skipped: [] }),
    runShell: async () => ({ ok: true, exitCode: 0, output: 'a.txt', timedOut: false }),
  });
  assert.deepEqual(sent, ['first', 'second']);
});

test('⚠️ with no root the loop behaves as before — `!ls` is a task, nothing is spawned', async () => {
  const sent = [];
  let spawned = false;
  await runChat({
    input: piped(['!ls', 'exit']),
    output: sink(),
    runOne: async (task) => { sent.push(task); return { ok: true, messages: [] }; },
    render: () => {},
    runShell: async () => { spawned = true; return { ok: true, exitCode: 0, output: '' }; },
  });
  assert.equal(spawned, false);
  assert.deepEqual(sent, ['!ls']);
});
