/**
 * ── ⚠️⚠️ "No files changed." IS A CLAIM ABOUT THE WORLD, AND WE CANNOT MAKE IT ─
 *
 * This summary has been wrong about exactly this once before. The filter named
 * `write_file`, so when `edit_file` shipped a real file changed on disk and the
 * run printed "No files changed." Filtering on `mutated` closed that route.
 *
 * It came back by another. MEASURED 2026-08-13 on a 45-file migration: the
 * agent did the whole job correctly by writing every file from inside
 * `evaluate`, nothing went through `executor.writeFile`, nothing set `mutated`,
 * and the run reported **"No files changed."**
 *
 * ⭐ The count cannot be fixed — a spawned process can write anything and this
 * summary has no way to see it. The SENTENCE can. "No files changed" is a claim
 * about the workspace; "nothing came through the file tools" is a claim about
 * what we observed, and only the second is ours to make.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatSummary } from '../lib/turn.mjs';

const outcome = (executed) => ({
  ok: true, stage: 'done', executed, rounds: [], roundsUsed: 1, maxRounds: 5,
  usage: null, note: null, verification: { ran: false, passed: false },
  acceptance: null, promisedButMissing: [], stoppedBecause: 'no-tool-calls', compactions: 0,
});

test('a run that truly did nothing still says so plainly', () => {
  const text = formatSummary(outcome([
    { name: 'read_file', args: {}, result: { ok: true }, mutated: false },
  ])).join('\n');
  assert.match(text, /No files changed\./);
});

test('⚠️⚠️ a run that STARTED A PROCESS must not claim the workspace is untouched', () => {
  const text = formatSummary(outcome([
    { name: 'evaluate', args: {}, result: { ok: true }, mutated: false },
  ])).join('\n');

  assert.ok(!/No files changed\./.test(text),
    'a command ran; claiming nothing changed is a statement about the world we cannot make');
  assert.match(text, /cannot see/, 'the limit has to be stated, not implied by omission');
  assert.match(text, /git status/, 'and it must say what to do about it');
});

test('⭐ every process-starting verb counts, not just evaluate', () => {
  for (const name of ['run_command', 'run_program', 'evaluate', 'repl', 'start_process']) {
    const text = formatSummary(outcome([{ name, args: {}, result: { ok: true }, mutated: false }])).join('\n');
    assert.ok(!/No files changed\./.test(text), `${name} can write files and the summary denied it`);
  }
});

test('⚠️ a REFUSED command does not trigger the caveat — it never ran', () => {
  const text = formatSummary(outcome([
    { name: 'run_command', args: {}, result: { ok: false, error: 'not allowed' }, mutated: false },
  ])).join('\n');
  assert.match(text, /No files changed\./,
    'a caveat that fires when nothing happened is noise, and noise is how a real warning gets ignored');
});

test('⭐ when the file tools DID write, the count is still the count', () => {
  const text = formatSummary(outcome([
    { name: 'write_file', args: { path: 'a.js' }, result: { ok: true, path: 'a.js', bytes: 10 }, mutated: true, mutatedPath: 'a.js' },
    { name: 'run_command', args: {}, result: { ok: true }, mutated: false },
  ])).join('\n');
  assert.match(text, /1 file written/);
  assert.ok(!/cannot see/.test(text), 'the caveat belongs on the empty case, not on every run that ran a command');
});
