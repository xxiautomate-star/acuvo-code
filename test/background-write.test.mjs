/**
 * ── write_process — TALK TO A RUNNING PROCESS, TESTED WITH A REAL ONE ───────
 *
 * The pty transport was built against node-pty and withdrawn on the evidence
 * (README, ACUVO_PTY_MODULE). This is the zero-dependency half: a pipe the
 * model can write a line into. A stubbed child cannot test the thing that
 * matters — that the bytes reach a real stdin and the reply comes back through
 * the same log — so the subject is `node` itself, echoing what it is sent.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startBackground, checkBackground, stopBackground, stopAllBackground, writeBackground,
  backgroundToolSchemas, runBackgroundTool, BACKGROUND_TOOL_NAMES, MAX_WRITE_CHARS,
} from '../lib/background.mjs';

const made = [];
after(() => {
  stopAllBackground();
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-bgw-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"bgw","version":"1.0.0"}\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  return { root, dryRun: false, readFile: () => null };
}

async function until(fn, { timeoutMs = 15_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** A REPL-shaped process: it echoes each line it is sent, and quits on "quit". */
const ECHO = `
process.stdin.setEncoding('utf8');
console.log('ready');
process.stdin.on('data', (chunk) => {
  for (const line of String(chunk).split('\\n')) {
    if (!line) continue;
    if (line === 'quit') { console.log('bye'); process.exit(0); }
    console.log('echo:' + line);
  }
});
`;

test('⭐ a line written to a running process comes back through its own log', async () => {
  const ex = workspace({ 'echo.mjs': ECHO });
  const started = startBackground({ program: 'node', args: ['echo.mjs'], executor: ex });
  assert.equal(started.ok, true, started.error);
  const ready = await until(async () => ((await checkBackground(started.id)).output ?? '').includes('ready') ? true : null);
  assert.ok(ready, 'the echo process never said ready');

  const w = writeBackground(started.id, 'hello there');
  assert.equal(w.ok, true, w.error);
  assert.equal(w.wrote, Buffer.byteLength('hello there\n'));
  assert.match(w.note, /wait_for_output|check_process/);

  const echoed = await until(async () => ((await checkBackground(started.id)).output ?? '').includes('echo:hello there') ? true : null);
  assert.ok(echoed, 'the reply never arrived in the log');
  // the dialogue is legible: what was sent is in the log too, marked as input
  assert.match((await checkBackground(started.id)).output, /\[stdin\] hello there/);

  // and it can end the process the way a REPL ends: by being told to
  assert.equal(writeBackground(started.id, 'quit').ok, true);
  const gone = await until(async () => { const s = await checkBackground(started.id); return s.running === false ? s : null; });
  assert.ok(gone, 'the process did not exit on "quit"');
  assert.equal(gone.exitCode, 0);
  assert.match(gone.output ?? '', /bye/);

  // writing to an exited process is a plain refusal, not a crash
  const late = writeBackground(started.id, 'anyone?');
  assert.equal(late.ok, false);
  assert.match(late.error, /exited/);
  stopBackground(started.id);
});

test('the tool is offered, dispatched and bounded', async () => {
  assert.ok(BACKGROUND_TOOL_NAMES.includes('write_process'));
  const schema = backgroundToolSchemas().find((s) => s.function.name === 'write_process');
  assert.ok(schema, 'no schema for write_process');
  assert.deepEqual(schema.function.parameters.required, ['id', 'text']);
  assert.match(schema.function.description, /not a terminal/i);

  assert.equal((await runBackgroundTool('write_process', { id: 'bg-none', text: 'x' })).ok, false);
  assert.match(writeBackground('bg-none', 'x').error, /no background process/);

  const ex = workspace({ 'echo.mjs': ECHO });
  const started = startBackground({ program: 'node', args: ['echo.mjs'], executor: ex });
  assert.equal(started.ok, true, started.error);
  assert.equal(writeBackground(started.id, 42).ok, false, 'a non-string is refused, never coerced');
  const tooLong = writeBackground(started.id, 'a'.repeat(MAX_WRITE_CHARS + 1));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /under 4000/);
  // newline:false sends a bare keypress — the bytes say so
  const bare = await runBackgroundTool('write_process', { id: started.id, text: 'r', newline: false });
  assert.equal(bare.ok, true);
  assert.equal(bare.wrote, 1);
  stopBackground(started.id);
});
