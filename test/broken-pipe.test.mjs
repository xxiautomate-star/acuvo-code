/**
 * ── ⭐⭐⭐ `acuvo … | head` MUST NOT END IN A NODE STACK TRACE ───────────────
 *
 * ⚠️⚠️ `SHAKEDOWN.md` RECORDS THIS AS ALREADY PASSING, AND THE OBSERVATION WAS
 * TRUE WHILE THE CONCLUSION WAS WRONG:
 *
 *     "`--help | head -1` does not EPIPE."
 *
 * `acuvo --help` is 18,827 bytes (measured) and a pipe buffer is 64 KB, so the
 * entire document is accepted by the kernel before `head` has even exited. The
 * write never touches a closed pipe. That check was measuring the LENGTH of the
 * help text, not the behaviour of the CLI — and everything that streams (a
 * session transcript, `--json`, a long listing) is past 64 KB and does hit it.
 *
 * The two tests below are deliberately different in kind, and neither replaces
 * the other: the first drives the guard's decisions against fake streams, and
 * the second runs a REAL child process with a REAL closed pipe, because a guard
 * for an operating-system condition that is only ever tested against a stub is
 * how the last one of these got recorded as passing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBrokenPipeGuard } from '../lib/interrupt.mjs';

/** ⚠️ A `file://` URL, not a Windows path. `import "C:/…"` is ERR_UNSUPPORTED_ESM_URL_SCHEME
 *  — and it made the guarded test PASS VACUOUSLY: the child died on the import,
 *  so its stderr contained no EPIPE and the assertion read that as success. */
const LIB = new URL('../lib/interrupt.mjs', import.meta.url).href;

test('⚠️⚠️⚠️ a closed reader is swallowed — EPIPE never reaches the user as a crash', () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  assert.equal(installBrokenPipeGuard({ streams: [stdout, stderr], env: {} }), 2);

  /**
   * ⚠️ THE CONTROL. On an EventEmitter with no `'error'` listener, `emit` THROWS
   * — that is the entire mechanism of the crash, and asserting it here is what
   * stops this file passing vacuously if the guard were ever removed.
   */
  const unguarded = new EventEmitter();
  assert.throws(() => unguarded.emit('error', Object.assign(new Error('x'), { code: 'EPIPE' })));

  for (const code of ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']) {
    assert.doesNotThrow(
      () => stdout.emit('error', Object.assign(new Error(code), { code })),
      `${code} means the reader went away, which is not the user's problem`,
    );
  }
});

test('⚠️⚠️ anything that is NOT a broken pipe is rethrown, unchanged', () => {
  /**
   * ── THE TRAP THIS GUARD HAD TO STEP OVER ────────────────────────────────────
   *
   * Attaching an `'error'` listener to `process.stdout` silences EVERY stream
   * error, not just the one we came for. A full disk on a redirected stdout
   * (`ENOSPC`) would become a SILENT truncation of somebody's output file —
   * strictly worse than the stack trace being fixed, and completely invisible.
   */
  const stdout = new EventEmitter();
  installBrokenPipeGuard({ streams: [stdout], env: {} });
  const disk = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  assert.throws(() => stdout.emit('error', disk), /no space left/);
});

test('⚠️ the guard is idempotent — importing twice must not attach two listeners', () => {
  const stdout = new EventEmitter();
  assert.equal(installBrokenPipeGuard({ streams: [stdout], env: {} }), 1);
  assert.equal(installBrokenPipeGuard({ streams: [stdout], env: {} }), 0, 'already guarded');
  assert.equal(stdout.listenerCount('error'), 1);
});

test('⭐ ACUVO_NO_PIPE_GUARD=1 restores the old behaviour for anyone debugging a lost write', () => {
  const stdout = new EventEmitter();
  assert.equal(installBrokenPipeGuard({ streams: [stdout], env: { ACUVO_NO_PIPE_GUARD: '1' } }), 0);
  assert.throws(() => stdout.emit('error', Object.assign(new Error('e'), { code: 'EPIPE' })));
});

/**
 * ── ⭐⭐⭐ THE REAL THING: A REAL PROCESS, A REAL PIPE, A REAL READER LEAVING ──
 *
 * Reproduced on Node v22.17.0 before the guard existed:
 *
 *     node write-lots.mjs | head -1
 *     node:events:496   throw er;  // Unhandled 'error' event
 *     Error: EPIPE: broken pipe, write
 *         at Socket._write (node:internal/net:63:18)          exit = 1
 *
 * ⚠️ THIS IMPORTS THE LIBRARY THE WAY `bin/acuvo.mjs` DOES — a plain static
 * import — because the guard installs itself at module load and the thing worth
 * proving is that a caller cannot fail to get it. Asserting on the exported
 * function alone would prove the mechanism and miss the wiring, which is the
 * failure mode this package has recorded four times.
 */
test('⚠️⚠️⚠️ a real closed pipe produces no stack trace, in a real child process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-epipe-'));
  const script = join(dir, 'writer.mjs');
  writeFileSync(script, [
    `import ${JSON.stringify(LIB)};`,
    'for (let i = 0; i < 200000; i += 1) process.stdout.write(`line ${i} ${"x".repeat(60)}\\n`);',
  ].join('\n'), 'utf8');

  const stderr = await new Promise((resolve) => {
    const writer = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    writer.stderr.on('data', (c) => { err += c; });
    /**
     * ⚠️ THE READER TAKES ONE CHUNK AND LEAVES, which is what `head -1` is. The
     * writer is 200,000 lines — far past any pipe buffer — so the next write
     * after that lands on a closed pipe rather than in the kernel.
     */
    writer.stdout.once('data', () => { writer.stdout.destroy(); });
    writer.on('close', () => resolve(err));
  });

  assert.doesNotMatch(stderr, /Unhandled 'error' event/, `the guard did not hold:\n${stderr}`);
  assert.doesNotMatch(stderr, /EPIPE/, `an EPIPE stack reached the user:\n${stderr}`);
});

test('⚠️ and without the guard the same script DOES crash — the test above is not vacuous', async () => {
  /**
   * ⭐ THE SAME SCRIPT, WITH THE GUARD TURNED OFF BY ITS OWN ENV SWITCH. If this
   * ever stops crashing, the test above has stopped proving anything and both
   * need re-reading — a check that cannot fail is not a check.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-epipe-raw-'));
  const script = join(dir, 'writer.mjs');
  writeFileSync(script, [
    `import ${JSON.stringify(LIB)};`,
    'for (let i = 0; i < 200000; i += 1) process.stdout.write(`line ${i} ${"x".repeat(60)}\\n`);',
  ].join('\n'), 'utf8');

  const stderr = await new Promise((resolve) => {
    const writer = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ACUVO_NO_PIPE_GUARD: '1' },
    });
    let err = '';
    writer.stderr.on('data', (c) => { err += c; });
    writer.stdout.once('data', () => { writer.stdout.destroy(); });
    writer.on('close', () => resolve(err));
  });

  assert.match(stderr, /EPIPE|Unhandled 'error' event/, 'the unguarded path must still show the crash this guard removes');
});
