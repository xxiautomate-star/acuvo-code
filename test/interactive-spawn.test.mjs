/**
 * ── ⚠️⭐ A UNIT TEST CANNOT PROVE A TERMINAL WORKS ───────────────────────────
 *
 * `interactive-prompts.test.mjs` pins every rule about what may be typed, and it
 * spawns nothing — which is exactly why it cannot tell you whether the pipe is
 * connected. This file spawns real processes and drives the real `spawnBounded`,
 * because the defect being fixed is "it sat there for 120 seconds", and no
 * assertion about a pure function can observe that.
 *
 * ⚠️ THE STALL WINDOW IS INJECTED, THE CONSTANT IS PINNED SEPARATELY. Eight
 * seconds per case would add a minute to the suite. `stallMs` is the same shape
 * of injection point as `spawnImpl`, and the real default is asserted below so
 * shortening it here cannot quietly become shortening it in production.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnBounded, formatRunForModel } from '../lib/command.mjs';
/** ⭐ The REACH test drives the shipped dispatcher, not just spawnBounded. */
import { executeToolCall } from '../lib/tools.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { INTERACTIVE_STALL_MS } from '../lib/interactive.mjs';

const NODE = process.execPath;
/**
 * ⚠️⚠️ 400ms WAS TOO SHORT AND IT HID A REAL BUG FOR HOURS.
 *
 * On an idle machine a `node -e` child prints its prompt in ~120ms, so a 400ms
 * window was never consumed by startup and every test passed. On the owner's
 * laptop — disk busy 86% of the time, Defender scanning 47,604 files — the same
 * spawn takes longer than the window, the watcher saw a process that had said
 * NOTHING, closed its stdin, and the run burned its full 60s timeout.
 *
 * ⭐ THAT WAS A DEFECT, NOT A FLAKE (see the `quietStalls` note in
 * `command.mjs`), and the fix is in the code. The window is widened here anyway,
 * because a test whose result depends on how busy the disk is measures the
 * laptop rather than the feature — and the whole point of injecting `stallMs` is
 * that the real 8-second constant is pinned separately.
 */
const STALL = 2_000;

/** A child that prints something and then waits forever for input. */
const waits = (text) => [`process.stdout.write(${JSON.stringify(text)}); process.stdin.resume(); setInterval(() => {}, 1000);`];

/**
 * A child that prints something, reads one line, reports what it got — and
 * STAYS ALIVE until it gets one.
 *
 * ⚠️ THE `setInterval` IS NOT DECORATION. Without it, a mode that closes stdin
 * makes readline emit 'close', nothing is left holding the event loop, and the
 * child exits 0 within milliseconds — so a test meant to prove "halt mode types
 * nothing" would pass because the child was already gone, not because nothing
 * was typed. That is a guard passing while checking nothing, and this repo has
 * a memory file about exactly that.
 */
const reads = (text) => [`
  process.stdout.write(${JSON.stringify(text)});
  const rl = require('node:readline').createInterface({ input: process.stdin });
  const alive = setInterval(() => {}, 1000);
  rl.on('line', (l) => { process.stdout.write('\\nRECEIVED:' + JSON.stringify(l) + '\\n'); clearInterval(alive); process.exit(0); });
`];

const run = (source, opts = {}) => spawnBounded({
  file: NODE,
  args: ['-e', source[0]],
  cwd: process.cwd(),
  timeoutMs: 60_000,
  stallMs: STALL,
  ...opts,
});

test('the real default constant is eight seconds, whatever these tests inject', () => {
  assert.equal(INTERACTIVE_STALL_MS, 8_000);
});

test('⭐ A HANGING PROMPT RETURNS IN SECONDS INSTEAD OF BURNING THE TIMEOUT', async () => {
  const started = Date.now();
  const r = await run(waits('Do you want to continue? [Y/n] '), { interactive: 'halt' });
  const elapsed = Date.now() - started;

  assert.ok(r.ok, r.error);
  assert.ok(r.awaitingInput, 'the run came back with no awaitingInput — the watcher did not fire');
  assert.equal(r.awaitingInput.kind, 'confirm-default-yes');
  assert.equal(r.awaitingInput.killed, true);
  assert.match(r.awaitingInput.prompt, /Do you want to continue/);
  /**
   * ⚠️ THE ASSERTION THAT MATTERS. The timeout is 60s; without the watcher this
   * returns at 60,000ms. A generous ceiling still fails by two orders of
   * magnitude if the feature is broken.
   */
  assert.ok(elapsed < 10_000, `took ${elapsed}ms — it hung`);
  assert.equal(r.answered, null, 'halt mode typed something, which it must never do');
});

test('⚠️ HALT MODE TYPES NOTHING — the child never receives a line', async () => {
  const r = await run(reads('Continue? [Y/n] '), { interactive: 'halt' });
  assert.ok(r.awaitingInput);
  assert.ok(!r.stdout.includes('RECEIVED:'), `something was typed into the child: ${r.stdout}`);
});

test('⭐ auto mode answers a safe confirmation and the child receives exactly "y"', async () => {
  const r = await run(reads('Continue? [Y/n] '), { interactive: 'auto' });
  assert.ok(r.ok, r.error);
  assert.match(r.stdout, /RECEIVED:"y"/, r.stdout);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.answered?.map((a) => a.reply), ['y']);
  assert.equal(r.awaitingInput, null);
});

test('⭐ auto mode accepts a printed default with a bare Enter', async () => {
  const r = await run(reads('package name: (my-app) '), { interactive: 'auto' });
  assert.match(r.stdout, /RECEIVED:""/, r.stdout);
  assert.deepEqual(r.answered?.map((a) => a.reply), ['']);
});

test('⚠️⚠️ AUTO MODE STILL REFUSES A PASSWORD, AND REDACTS IT', async () => {
  const r = await run(reads('Enter database password: '), { interactive: 'auto' });
  assert.ok(r.awaitingInput, 'no halt — a credential prompt was walked past');
  assert.equal(r.awaitingInput.kind, 'secret');
  assert.equal(r.answered, null);
  assert.ok(!r.stdout.includes('RECEIVED:'), 'a credential prompt was answered');
  assert.match(r.awaitingInput.prompt, /\[redacted\]/);
});

test('⚠️⚠️ AUTO MODE STILL REFUSES A DESTRUCTIVE CONFIRMATION', async () => {
  const r = await run(reads('This will DELETE 412 rows permanently. Continue? [Y/n] '), { interactive: 'auto' });
  assert.equal(r.awaitingInput?.kind, 'destructive');
  assert.ok(!r.stdout.includes('RECEIVED:'));
});

test('⚠️⚠️ AUTO MODE STILL REFUSES A LICENCE', async () => {
  const r = await run(reads('Do you accept the license terms? [Y/n] '), { interactive: 'auto' });
  assert.equal(r.awaitingInput?.kind, 'licence');
  assert.ok(!r.stdout.includes('RECEIVED:'));
});

test('⚠️ THE FALSE POSITIVE: a command that goes quiet mid-run is left alone', async () => {
  const source = [`
    console.log('compiling 412 files...');
    setTimeout(() => { console.log('done'); process.exit(0); }, ${STALL * 5});
  `];
  const r = await run(source, { interactive: 'auto' });
  assert.equal(r.awaitingInput, null, 'a healthy build was killed as if it had asked a question');
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /done/);
});

test('⚠️⚠️ THE STALL WINDOW IS RESPECTED — an un-newlined tail is not a prompt YET', async () => {
  /**
   * ⚠️ THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. Removing the stall check
   * entirely left the suite green, because every other false-positive case here
   * ends its output with a newline and dies on the shape test instead. The one
   * shape only the STALL protects is this one: a progress line with no newline
   * (`Downloading: `, `Working… `) while the program is genuinely busy.
   *
   * ⭐ It writes a prompt-shaped tail, works for LESS than the window, and
   * finishes. Fire the watcher instantly and it is killed mid-work.
   */
  const source = [`
    process.stdout.write('Fetching packages: ');
    setTimeout(() => { process.stdout.write('done\\n'); process.exit(0); }, ${Math.floor(STALL / 2)});
  `];
  const r = await run(source, { interactive: 'auto' });
  assert.equal(r.awaitingInput, null, 'a busy program with an un-newlined tail was killed as if it had asked a question');
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /done/);
});

test('⚠️⚠️ A PROGRAM THAT IS SLOW TO SPEAK IS NOT A PROGRAM THAT WENT QUIET', async () => {
  /**
   * ⚠️ THE REGRESSION THE SUITE FOUND ON A LOADED MACHINE. A process that has
   * produced ZERO bytes has not gone quiet — it has not started. Closing its
   * stdin on the first stall means it loses the pipe before it ever prints its
   * question, and the run then burns the whole command timeout.
   *
   * ⭐ It says nothing for longer than one stall window, THEN prompts. The
   * answer must still land.
   */
  const source = [`
    setTimeout(() => {
      process.stdout.write('Continue? [Y/n] ');
      const alive = setInterval(() => {}, 1000);
      process.stdin.on('data', (d) => { process.stdout.write('RECEIVED:' + JSON.stringify(d.toString().trim())); clearInterval(alive); process.exit(0); });
    }, ${Math.floor(STALL * 1.4)});
  `];
  const r = await run(source, { interactive: 'auto', timeoutMs: 30_000 });
  assert.match(r.stdout, /RECEIVED:"y"/, `a slow starter lost its stdin: ${JSON.stringify(r.stdout)}`);
  assert.equal(r.exitCode, 0);
});

test('⚠️ a command reading stdin without prompting still gets its EOF', async () => {
  /**
   * THE REGRESSION THIS FEATURE COULD HAVE INTRODUCED. Holding stdin open so a
   * question can be answered means a program that just reads stdin waits
   * forever. It must get EOF once the stall proves no question is coming.
   */
  const source = [`
    let n = 0;
    process.stdin.on('data', (d) => { n += d.length; });
    process.stdin.on('end', () => { process.stdout.write('EOF after ' + n + ' bytes\\n'); process.exit(0); });
  `];
  const r = await run(source, { interactive: 'auto' });
  assert.match(r.stdout, /EOF after 0 bytes/, r.stdout);
  assert.equal(r.exitCode, 0);
});

test('off mode restores the old behaviour exactly: stdin closed, nothing watched', async () => {
  const r = await run(waits('Continue? [Y/n] '), { interactive: 'off', timeoutMs: 2_000 });
  assert.equal(r.awaitingInput, null);
  assert.equal(r.answered, null);
  assert.equal(r.timedOut, true, 'off mode must not rescue a hang — that is what halt is for');
});

test('⭐ THE EXIT-TIME DETECTOR: a program that dies on EOF is explained, not blamed', async () => {
  /**
   * No stall at all — this program exits at once because stdin is closed. The
   * old result was a bare non-zero exit and a truncated banner, and the model's
   * most likely next move was to "fix" a program that is not broken.
   */
  const source = [`
    process.stdout.write('package name: (my-app) ');
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('close', () => process.exit(7));
  `];
  /**
   * ⚠️ THE STALL IS SET TO THIRTY SECONDS, WHICH IS THE ASSERTION. A wall-clock
   * comparison against a 400ms window was flaky — a cold `node` spawn on a busy
   * machine costs most of it, so the test measured the laptop rather than the
   * code. With a window this wide, RETURNING AT ALL proves the stall watcher was
   * not what produced the verdict.
   */
  const started = Date.now();
  const r = await run(source, { interactive: 'halt', stallMs: 30_000 });
  assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started}ms — something waited`);
  assert.equal(r.exitCode, 7, 'the REAL exit code must survive');
  assert.ok(r.awaitingInput, 'the prompt in the tail was not noticed');
  assert.equal(r.awaitingInput.killed, false);

  const rendered = formatRunForModel({ ...r, command: 'thing', passed: false });
  assert.match(rendered, /exit code: 7/, 'the exit code line was displaced');
  assert.match(rendered, /ended by itself/);
});

test('⚠️ a PASSING command is never re-explained as a prompt', async () => {
  const source = [`process.stdout.write('All good:'); process.exit(0);`];
  const r = await run(source, { interactive: 'halt' });
  assert.equal(r.exitCode, 0);
  assert.equal(r.awaitingInput, null, 'a passing run was flagged as waiting for input');
});

test('⚠️ the same question twice means the answer is not landing — it stops', async () => {
  /** A program that prints the same prompt forever no matter what it is told. */
  const source = [`
    process.stdout.write('Continue? [Y/n] ');
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', () => { process.stdout.write('Continue? [Y/n] '); });
  `];
  const r = await run(source, { interactive: 'auto' });
  assert.ok(r.awaitingInput, 'it kept answering a program that was not listening');
  assert.match(r.awaitingInput.why, /same question again/);
  assert.equal(r.answered.length, 1, `answered ${r.answered.length} times before stopping`);
});

test('⚠️ ask mode with nobody to ask degrades to halt, never to auto', async () => {
  const r = await run(reads('Continue? [Y/n] '), { interactive: 'ask' });
  assert.ok(r.awaitingInput);
  assert.ok(!r.stdout.includes('RECEIVED:'), 'ask mode with no asker typed something');
});

test('⭐⭐⭐ REACH: `ask` arrives through the real tool dispatcher, not just spawnBounded', async () => {
  /**
   * ⚠️ THE ASKER TRAVELS FOUR HOPS — `turn.mjs` → `executeToolCall` →
   * `executeRunCommand` → `spawnBounded` — and a mode that is unreachable in
   * production is a mode that does not exist. Every test above injects
   * `askInteractive` directly into `spawnBounded` and would pass with any one of
   * those hops missing. This one goes through the shipped dispatcher.
   *
   * ⚠️ AND THE ASKER IS THE RUNNER'S, NOT THE MODEL'S. `executeToolCall` also
   * takes `ask` — the BUDGETED asker capped at three questions per run, for
   * questions the model chose to ask. Wiring this to that one would let three
   * prompting commands silence every real question after them.
   */
  const dir = mkdtempSync(join(tmpdir(), 'acuvo-ask-reach-'));
  try {
    writeFileSync(join(dir, 'prompter.mjs'), [
      "process.stdout.write('Continue? [Y/n] ');",
      'const alive = setInterval(() => {}, 1000);',
      "process.stdin.on('data', (d) => { process.stdout.write('CHILD GOT ' + JSON.stringify(d.toString())); clearInterval(alive); process.exit(0); });",
    ].join('\n'));

    const asked = [];
    const before = process.env.ACUVO_INTERACTIVE;
    process.env.ACUVO_INTERACTIVE = 'ask';
    let rec;
    try {
      rec = await executeToolCall(
        { id: 'c1', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node prompter.mjs' }) } },
        createLocalExecutor(dir),
        { commandTimeoutMs: 60_000, interactiveAsk: async (q) => { asked.push(q); return 'y'; } },
      );
    } finally {
      if (before === undefined) delete process.env.ACUVO_INTERACTIVE;
      else process.env.ACUVO_INTERACTIVE = before;
    }

    assert.equal(asked.length, 1, 'the runner was never asked — a hop between turn.mjs and spawnBounded is missing');
    assert.match(asked[0], /Continue\? \[Y\/n\]/);
    assert.match(rec.result.stdout, /CHILD GOT "y/, rec.result.stdout);
    assert.equal(rec.result.exitCode, 0);
    assert.deepEqual(rec.result.answered?.map((a) => a.reply), ['y']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ ask mode with a human present sends the human\'s yes, and only a yes', async () => {
  const asked = [];
  const r = await run(reads('Continue? [Y/n] '), {
    interactive: 'ask',
    askInteractive: async (q) => { asked.push(q); return 'y'; },
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Continue\? \[Y\/n\]/);
  assert.match(r.stdout, /RECEIVED:"y"/, r.stdout);

  const refused = await run(reads('Continue? [Y/n] '), {
    interactive: 'ask',
    // ⚠️ A person typing a VALUE does not get it passed through — see humanDecision.
    askInteractive: async () => 'my-database-password',
  });
  assert.ok(!refused.stdout.includes('RECEIVED:'), refused.stdout);
  assert.ok(refused.awaitingInput);
});
