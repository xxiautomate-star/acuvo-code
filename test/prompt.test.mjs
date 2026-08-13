/**
 * The asker, and the two things about it that actually matter: it must never
 * hang when nobody is there, and it must never outlive its own question.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';

import { askOnce, createAsker, isInteractive } from '../lib/prompt.mjs';

/** A fake pair of streams. `isTTY` is the only thing the check looks at. */
function pipes({ tty = false } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = tty;
  output.isTTY = tty;
  return { input, output };
}

test('a typed answer comes back trimmed', async () => {
  const { input, output } = pipes();
  const answer = askOnce('Start these programs? [y/N] ', { input, output });
  input.write('  y  \n');
  assert.equal(await answer, 'y');
});

test('an empty line is an empty answer, NOT a missing one', async () => {
  /**
   * The difference is load-bearing at the consent gate: '' is a person pressing
   * enter, which means "no" by the prompt's own [y/N] default. `null` means
   * nobody was there at all. Collapsing them would make a deliberate refusal
   * indistinguishable from a broken pipe.
   */
  const { input, output } = pipes();
  const answer = askOnce('? ', { input, output });
  input.write('\n');
  assert.equal(await answer, '');
});

test('⚠️ a stream that ends mid-question resolves null instead of hanging forever', async () => {
  /**
   * The failure this prevents is the worst-shaped one available: an agent
   * waiting on input that will never arrive, in CI, until the job times out —
   * which reports nothing about what it was waiting for.
   */
  const { input, output } = pipes();
  const answer = askOnce('? ', { input, output });
  input.end();
  assert.equal(await answer, null);
});

test('⚠️ BOTH streams must be a TTY — a redirect is not a person', async () => {
  assert.equal(isInteractive(pipes({ tty: true })), true);
  assert.equal(isInteractive(pipes({ tty: false })), false);

  // `acuvo … < answers.txt` — stdout is a terminal, stdin is a file.
  const halfIn = pipes(); halfIn.output.isTTY = true;
  assert.equal(isInteractive(halfIn), false, 'a piped stdin means the "answer" is whatever the next line happens to be');

  // `acuvo … | tee log` — stdin is a terminal, the question scrolls into a file.
  const halfOut = pipes(); halfOut.input.isTTY = true;
  assert.equal(isInteractive(halfOut), false, 'a piped stdout means nobody can see the question they are being asked');
});

test('⭐ createAsker returns null when nobody is there — absence must stay absence', () => {
  /**
   * `checkMcpConsent` tests `typeof ask !== 'function'` and refuses with "there
   * is no terminal here to ask". Handing it a function that always answers ''
   * would produce the same refusal with a worse explanation, and would make a
   * real non-interactive run look like a user who declined.
   */
  assert.equal(createAsker(pipes({ tty: false })), null);
  assert.equal(typeof createAsker(pipes({ tty: true })), 'function');
});

test('⚠️⚠️ asking does NOT hold the event loop open — the process must still exit', async () => {
  /**
   * This package lost a day to a readline-shaped hang: a REPL session kept its
   * owner's loop alive, so the exit hook that would have cleaned it up could
   * never fire, and the suite did not run slowly — it HUNG. A long-lived
   * interface in the asker would put that back on the path every run touches.
   *
   * ⭐ Asserting on the EXIT is the only ground truth. `getActiveResourcesInfo`
   * lists unref'd handles too, so "a handle exists" proves nothing.
   *
   * ⚠️⚠️ AND IT MUST USE `process.stdin`, NOT A `PassThrough`. The first version of
   * this test fed readline a pair of in-memory streams — and deleting
   * `rl.close()` entirely left it GREEN. A PassThrough is a JavaScript object
   * with no OS resource behind it, so it cannot hold the event loop, so the
   * test could not observe the one defect it exists to catch. Mutation testing
   * found that; reading it would not have.
   *
   * A real piped stdin IS a libuv handle. The parent deliberately leaves the
   * pipe OPEN — an unclosed readline over it keeps the child alive forever,
   * which is precisely the hang being guarded against.
   */
  const url = new URL('../lib/prompt.mjs', import.meta.url).href;
  const script = `
    const { askOnce } = await import(${JSON.stringify(url)});
    const answer = await askOnce('? ', { input: process.stdin, output: process.stdout });
    process.stdout.write('answer:' + answer);
    // No process.exit(). The parent holds the stdin pipe open, so if readline
    // is still attached to it the loop never drains and this never exits.
  `;
  const { stdout } = await new Promise((res, rej) => {
    const child = execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      { timeout: 20_000 },
      (err, out, errOut) => (err
        ? rej(new Error(`the child did not exit cleanly (exit ${child.exitCode}, signal ${child.signalCode ?? 'none'}): ${err.message}\n--- stderr ---\n${errOut || '(empty)'}`))
        : res({ stdout: out })),
    );
    // Answer the question, then leave the pipe open on purpose.
    child.stdin.write('yes\n');
  });
  assert.match(stdout, /answer:yes/);
});
