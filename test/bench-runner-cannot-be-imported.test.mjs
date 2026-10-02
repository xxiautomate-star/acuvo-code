/**
 * ── 💰🚨⭐⭐⭐ IMPORTING THE BENCH RUNNER SPENDS REAL MONEY ──────────────────
 *
 * `bench/run.mjs` is top-level statements end to end, so `import()` of it does
 * not "load a module" — it **runs all 19 bench tasks against a real model**.
 *
 * ⚠️ IT HAS HAPPENED TWICE, AND THE SECOND TIME WAS WHILE FIXING THE FIRST.
 * A terminal typed `node -e "import('./bench/run.mjs')"` to see what the module
 * exported, started the sweep, and killed it at about $0.02. The guard written
 * to prevent that read:
 *
 *     if (process.argv[1] && import.meta.url !== pathToFileURL(process.argv[1]).href)
 *
 * and under `node -e` **`process.argv[1]` is `undefined`** — so the `&&`
 * short-circuited to false, the guard did not fire, and six tasks ran before it
 * was killed again. The defensive `&&` inverted the test in the exact case the
 * guard existed for.
 *
 * ⭐ THE LESSON IS THE PHRASING, NOT THE FLAG. "Refuse if obviously not a direct
 * run" defaults to PERMITTING when it cannot tell. "Run only if provably a
 * direct run" defaults to REFUSING. For a script that spends money the default
 * has to be refusal, and only the second phrasing gives you that.
 *
 * ── ⚠️ HOW THIS TEST AVOIDS BEING THE THIRD INCIDENT ───────────────────────
 *
 * It spawns a child with **`OPENROUTER_API_KEY` deleted**, so even a completely
 * broken guard cannot reach a model: `run.mjs` exits 2 on a missing key before
 * the first task. The assertion then distinguishes the two outcomes by their
 * text. A test of a money-spending guard must be safe when the guard is broken
 * — that is the whole point of the case it is testing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const RUNNER = fileURLToPath(new URL('../bench/run.mjs', import.meta.url));
const RUNNER_URL = pathToFileURL(RUNNER).href;

/** ⚠️ Never inherits the real key — see the header. */
function runChild(args) {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.ACUVO_HARNESS_KEY;
  return spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 60_000 });
}

test('🚨 `node -e "import(...)"` — the exact incident shape — is REFUSED', () => {
  const r = runChild(['-e', `import(${JSON.stringify(RUNNER_URL)}).catch((e) => { console.error(e.message); process.exit(3); })`]);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  assert.match(
    out,
    /is a SCRIPT, not a module/,
    `importing the runner did not refuse. Output was:\n${out.slice(0, 600)}`,
  );
  /**
   * ⚠️ AND IT MUST NOT HAVE GOT AS FAR AS THE KEY CHECK. That message
   * ("OPENROUTER_API_KEY is not set") means the guard let the module body run
   * and only the missing key stopped it — which on a machine WITH a key is the
   * incident, not a pass. This is the assertion that makes the safety harness
   * honest rather than a way of hiding the failure.
   */
  assert.doesNotMatch(
    out,
    /OPENROUTER_API_KEY is not set/,
    'the module body executed — only the absent key stopped it, so a machine with a key would have spent',
  );
});

test('⭐ and an ordinary `import` from another module is refused too', () => {
  const r = runChild(['--input-type=module', '-e',
    `import(${JSON.stringify(RUNNER_URL)}).catch((e) => { console.error(e.message); process.exit(3); })`]);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.match(out, /is a SCRIPT, not a module/, out.slice(0, 400));
});

test('⭐⭐ THE DECOY — running it as a script still works, and --list is still free', () => {
  /**
   * ⚠️ WITHOUT THIS THE GUARD COULD BE `throw new Error()` AT THE TOP and every
   * assertion above would pass while the bench had been bricked. `--list` exits
   * 0, needs no key, and prints the corpus — so it proves the module body runs
   * on the direct path.
   */
  const r = runChild([RUNNER, '--list']);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.equal(r.status, 0, `--list should exit 0; got ${r.status}\n${out.slice(0, 400)}`);
  assert.match(out, /Acuvo Code bench/, out.slice(0, 400));
  assert.doesNotMatch(out, /is a SCRIPT, not a module/, 'the guard fired on a legitimate direct run');
});

test('⚠️ the guard is phrased positively — "run only if provably direct"', () => {
  /**
   * ⭐ THE ONE SOURCE ASSERTION HERE, AND IT IS ABOUT THE SHAPE THAT FAILED.
   * The behavioural tests above cannot distinguish the broken phrasing from the
   * correct one on a machine where `process.argv[1]` happens to be set, and
   * this is precisely the mistake that was made once already: a leading
   * `process.argv[1] &&` makes "cannot tell" mean "permit".
   */
  /**
   * ⚠️⚠️ COMMENTS STRIPPED FIRST, AND THE FIRST VERSION OF THIS ASSERTION WAS
   * NOT. It went red against the CORRECT code, because `run.mjs`'s comment
   * quotes the broken phrasing verbatim in order to explain it. A source regex
   * satisfied — or here, failed — by a citation inside a comment is the trap
   * `publish-readiness.test.mjs` and `docs-truth.test.mjs` both already record
   * paying for; `publish-readiness` strips comments for exactly this reason and
   * this is the same `replace`.
   *
   * ⭐ It is also a small demonstration of why the three tests above are the
   * real guard: they drive the binary, and no amount of prose in a comment can
   * make a spawned process refuse or not refuse.
   */
  const src = readFileSync(RUNNER, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /const invokedDirectly =/, 'the direct-run test should be a named, positive condition');
  assert.match(src, /if \(!invokedDirectly\)/, 'and the refusal should be its negation, so the default is to refuse');
  assert.doesNotMatch(
    src,
    /if \(process\.argv\[1\] &&/,
    'this is the phrasing that let `node -e` through and spent money — see the header',
  );
});
