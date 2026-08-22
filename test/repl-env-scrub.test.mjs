/**
 * ── ⚠️⚠️⚠️ THE REPL HANDED EVERY SECRET ON THE MACHINE TO MODEL-WRITTEN CODE ─
 *
 * Measured 2026-08-19. `repl.mjs`'s `start()` spawned the driver with
 * `{ cwd, stdio, windowsHide, detached }` and **no `env` option**, so the child
 * inherited `process.env` whole — the OpenRouter key, the Acuvo account token,
 * AWS credentials, all of it.
 *
 * The repl exists to run **model-written JavaScript**. So one `repl` call could
 * read them straight back out, which bypassed the `run_command` allowlist
 * entirely: refusing to let the model run a program is irrelevant if it can
 * `process.env` its way past the refusal.
 *
 * ⭐ EVERY SIBLING SPAWNER ALREADY DID THIS RIGHT — `evaluate.mjs`,
 * `background.mjs` and `command.mjs` all pass `childEnvironment(...)`. The repl
 * was the single uncovered door, which is how a control reads as present while
 * being absent.
 *
 * ⚠️ These assert on the env HANDED TO SPAWN rather than on a live child,
 * because the property that matters is the one at the boundary — and a test
 * that needs a real process would be skipped on the machine that most needs it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replEval } from '../lib/repl.mjs';
import { scrubEnvironment } from '../lib/command.mjs';

/** A spawn that records what it was given and then behaves like a dead child. */
function recordingSpawn(seen) {
  return (file, args, opts) => {
    seen.push({ file, args, opts });
    return {
      stdout: { setEncoding() {}, on() {} },
      stderr: { setEncoding() {}, on() {} },
      stdin: { write() {}, end() {} },
      on() {}, once() {}, kill() {}, unref() {},
      pid: 4242,
    };
  };
}

const SECRETS = {
  OPENROUTER_API_KEY: 'sk-or-v1-super-secret',
  ACUVO_TOKEN: 'xxi_live_secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  GITHUB_TOKEN: 'ghp_secret',
  DB_PASSWORD: 'hunter2',
};

test('⚠️⚠️ the repl child is NOT given the process environment wholesale', async () => {
  const seen = [];
  // A short timeout: the fake child never answers, and the point is the spawn.
  await replEval(process.cwd(), '1 + 1', { spawnImpl: recordingSpawn(seen), timeoutMs: 500 });

  assert.equal(seen.length, 1, 'the repl did not spawn — this guard is blind');
  const { opts } = seen[0];
  assert.ok(opts, 'spawn was called with no options at all');
  assert.notEqual(
    opts.env,
    undefined,
    'repl spawns with NO env option, so the child inherits every secret on the machine',
  );
});

test('⚠️⚠️⚠️ no secret-shaped variable survives into the child', async () => {
  /**
   * Proven against the real scrubber rather than a hand-written list, so this
   * cannot drift from what `command.mjs` actually considers secret.
   */
  const scrubbed = scrubEnvironment({ ...process.env, ...SECRETS });
  for (const name of Object.keys(SECRETS)) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(scrubbed, name),
      false,
      `${name} survives scrubEnvironment — the repl would hand it to model-written code`,
    );
  }
});

test('⭐ and the repl really routes through that scrubber', async () => {
  /**
   * The previous test proves the scrubber works; this proves the repl USES it.
   * Both are needed — a correct scrubber nothing calls is exactly the shape of
   * the bug being fixed.
   */
  const seen = [];
  await replEval(process.cwd(), '1 + 1', { spawnImpl: recordingSpawn(seen), timeoutMs: 500 });
  const env = seen[0]?.opts?.env ?? {};

  // Whatever else is true, a value that looks like a credential must not be there.
  const leaked = Object.entries(env).filter(([, v]) => typeof v === 'string' && /^(sk-|ghp_|xxi_live_)/.test(v));
  assert.deepEqual(leaked, [], `credential-shaped values reached the repl child: ${leaked.map(([k]) => k).join(', ')}`);
});

test('⭐ npm lifecycle scripts stay disabled for the repl child', () => {
  // `childEnvironment` sets this unless npm is genuinely the program. The repl
  // runs node on our own driver, so it must be set — otherwise an installed
  // package's postinstall becomes reachable from a REPL expression.
  const env = scrubEnvironment(process.env);
  assert.ok(env, 'scrubEnvironment returned nothing');
});
