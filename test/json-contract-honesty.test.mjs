/**
 * ── ⭐ `--json` MUST MEAN WHAT `--help` SAYS IT MEANS ────────────────────────
 *
 * The help text promises "One JSON object on stdout, nothing else". Measured on
 * 2026-08-10, that was true on ONE of the four paths through `bin/acuvo.mjs`:
 *
 *   · `--parallel`   wrote "running 2 tasks" and a summary table to stdout and
 *                    returned before the `if (opts.json)` block existed for it
 *   · interactive    wrote a whole conversation to stdout, same early return
 *   · `--issue`      wrote four progress lines to stdout, then the object
 *   · one-shot       honoured it
 *
 * ⚠️ THE FAILURE IS NOT "NO JSON", IT IS "JSON PLUS PROSE" — `| jq` dies on the
 * first line and the user blames jq. So the contract this file holds is the
 * BYTE COUNT ON STDOUT, not the exit code alone: an invocation that cannot
 * produce one object must produce ZERO bytes there and say why on stderr.
 *
 * ⚠️ AND THE GUARD HAS TO FIRE BEFORE THE KEY CHECK. Refusing after the banner
 * has printed emits the very prose it exists to prevent, so the parallel case
 * below asserts an empty stdout, not merely a non-zero exit.
 *
 * ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT COVER: the SHAPE of the object
 * (`failed`, `exitCode`, `dryRun`). Reaching it costs a real completion against
 * a real provider, and a test suite that spends money — or needs a network on a
 * fresh clone — is a test suite people delete. That half was verified live and
 * the run is recorded in the change log; this half runs offline, every time.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/acuvo.mjs', import.meta.url));

const EXIT_OK = 0;
const EXIT_USAGE = 64;

/**
 * ⚠️ `input: ''` IS LOAD-BEARING, not tidiness. Interactive mode reads stdin;
 * inheriting the runner's would hang `npm test` forever on a terminal and drain
 * something unrelated in CI. An immediate EOF is a pipe that ran out, which the
 * chat loop already treats as a clean end of session.
 */
function runCli(args, { key = null } = {}) {
  const env = { ...process.env, NO_COLOR: '1' };
  if (key === null) delete env.OPENROUTER_API_KEY;
  else env.OPENROUTER_API_KEY = key;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input: '',
    timeout: 30_000,
    windowsHide: true,
    env,
  });
}

test('⚠️⚠️ --json --parallel is REFUSED before a single byte reaches stdout', () => {
  /**
   * A key is set on purpose: without one the process would die at the
   * configuration check and this would pass for the wrong reason, proving only
   * that an unconfigured machine cannot run tasks. With one, the unfixed binary
   * gets all the way into the parallel branch and prints prose.
   */
  const r = runCli(['--json', '--parallel', 'add a test', 'write the README', '--timeout', '5'], { key: 'sk-or-v1-deliberately-invalid' });
  assert.strictEqual(r.stdout, '', `stdout must be empty, got: ${JSON.stringify(r.stdout.slice(0, 200))}`);
  assert.strictEqual(r.status, EXIT_USAGE, 'a combination the flag cannot honour is a usage error');
  // ⚠️ An error that does not name a working invocation costs the reader a
  // round trip through --help. "try again" would be worse than silence: nothing
  // about retrying this command can change the answer.
  assert.match(r.stderr, /run one task per invocation/);
  assert.ok(!/try again/i.test(r.stderr), 'retrying cannot help — the message must say what to do INSTEAD');
});

test('⚠️ --json with no task is REFUSED rather than opening a conversation', () => {
  const r = runCli(['--json'], { key: 'sk-or-v1-deliberately-invalid' });
  // Unfixed this printed 'Type what you want done. "exit" to leave.' to stdout
  // and exited 0 — a script piping to jq saw prose and a success code.
  assert.strictEqual(r.stdout, '', `stdout must be empty, got: ${JSON.stringify(r.stdout.slice(0, 200))}`);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.notStrictEqual(r.status, EXIT_OK);
});

test('⭐ an interactive session with NO --json is still perfectly fine', () => {
  /**
   * The guard must refuse a COMBINATION, never the mode. If this ever starts
   * exiting 64 the fix has quietly deleted the feature it was meant to protect.
   */
  const r = runCli([], { key: 'sk-or-v1-deliberately-invalid' });
  assert.strictEqual(r.status, EXIT_OK);
  assert.match(r.stdout, /Type what you want done/);
});

test('⚠️⚠️ --dir "" is refused, never silently resolved to the current directory', () => {
  /**
   * `resolve(opts.dir ?? process.cwd())` — and `??` does not catch an empty
   * string. `acuvo --dir "$PROJECT"` with PROJECT unset therefore pointed a
   * FILE-WRITING agent at whatever directory the shell happened to be in, with
   * no message. `--dir "   "` already errored, which made the empty case an
   * inconsistency as well as a hazard.
   *
   * No key here: the check must sit ABOVE the configuration check, so an
   * unconfigured machine still gets told the real problem. Unfixed, this exits
   * 2 ("no API key") — a true statement about the wrong thing.
   */
  const r = runCli(['--dir', '', 'add a healthcheck route']);
  assert.strictEqual(r.status, EXIT_USAGE, `expected a usage error, got ${r.status}: ${r.stderr.slice(0, 200)}`);
  assert.match(r.stderr, /--dir was given an empty value/);
  assert.match(r.stderr, /omit --dir/, 'the message must name the working alternative');
});

test('a blank --dir is refused the same way as an empty one', () => {
  const r = runCli(['--dir', '   ', 'x']);
  assert.strictEqual(r.status, EXIT_USAGE);
  assert.match(r.stderr, /--dir was given an empty value/);
});
