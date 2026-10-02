/**
 * ── ⭐⭐⭐ A COMMAND THAT EXITS 0 IS NOT PROOF THE TASK IS DONE ───────────────
 *
 * Measured on Terminal-Bench 2.1, 2026-08-23 — 0/6, and the reason is here:
 *
 *   adaptive-rejection-sampler  4 rounds  stoppedBecause: verified
 *   bn-fit-modify               5 rounds  verified
 *   break-filter-js-from-html   5 rounds  verified
 *   build-cython-ext            8 rounds  verified
 *   caffe-cifar-10              4 rounds  verified
 *   cancel-async-tasks         16 rounds  round-cap
 *
 * Five of six stopped early believing they had finished, out of a 16-round
 * budget, and the independent verifier scored every one of them zero.
 *
 * ⚠️ THE RULE THAT DID IT: "if every `run_command` this round passed, stop" —
 * where `passed` is literally `exitCode === 0`. So `which R`, `ls`, `cat
 * setup.py`, `pip list` — commands the agent runs to ORIENT itself — each exit 0
 * and end the session. One transcript closes on *"R is not installed. Let me
 * check what's available and install R."* The agent was mid-sentence about work
 * it had not started.
 *
 * ⭐ `turn.mjs` ALREADY KNEW. Its own comment reads *"A COMMAND PASSED is not
 * THE THING YOU ASKED FOR PASSED"* — but that guard only ran under
 * `--until-done`. On an ordinary run, `ls` closed the job.
 *
 * ── ⚠️ WHY THIS IS A LIST AND NOT A MODEL JUDGEMENT ─────────────────────────
 *
 * Asking the model "was that a verification?" costs a round, is itself the thing
 * being wrong, and would let a model that wants to stop simply say yes. What a
 * command IS can be read from its name, deterministically, for free.
 *
 * ⚠️ AND THE BIAS IS DELIBERATE: unknown means NOT verification. Being wrong in
 * that direction costs extra rounds, bounded by the round cap and mostly cached.
 * Being wrong the other way hands back a half-finished job that reports success —
 * which is what we have been doing.
 */

/**
 * Programs whose whole purpose is to answer "does it work".
 *
 * ⚠️ MATCHED ON THE PROGRAM, NOT ANYWHERE IN THE STRING. `echo "run pytest"`
 * must not count, and neither must `cat test_foo.py`.
 */
const VERIFIERS = new Set([
  'pytest', 'tox', 'nose2', 'unittest',
  'jest', 'vitest', 'mocha', 'ava', 'tap',
  'tsc', 'eslint', 'ruff', 'mypy', 'flake8', 'pylint',
  'cargo', 'go', 'gradle', 'mvn', 'dotnet', 'rspec', 'rake', 'phpunit',
  'make', 'ninja', 'cmake', 'ctest', 'bazel',
]);

/**
 * Subcommands that make an otherwise ambiguous tool a verification.
 *
 * `cargo build` and `go test` check something; `cargo add` and `go get` do not.
 */
const VERIFY_SUBCOMMANDS = new Set(['test', 'check', 'build', 'lint', 'vet', 'verify', 'run']);

/** npm/pnpm/yarn scripts that mean "check it", as opposed to "install things". */
const SCRIPT_VERBS = new Set(['test', 'build', 'lint', 'typecheck', 'check', 'ci', 'verify']);

/**
 * Does this command exist to CHECK something?
 *
 * @param {string} command  the command line as the agent wrote it
 * @returns {boolean}
 */
export function looksLikeVerification(command) {
  const text = String(command ?? '').trim();
  if (!text) return false;

  /**
   * ⚠️⚠️ A CHAIN DISQUALIFIES THE WHOLE COMMAND, AND THIS CHECK COMES FIRST.
   *
   * Reading only the first token is not enough: `pytest || echo ok` starts with
   * a real verifier and exits 0 no matter what pytest did. `pytest > out.txt`
   * has the same problem in a different costume. We cannot tell which segment
   * produced the exit code without implementing shell semantics, so a command
   * that closes a session has to stand on its own.
   */
  if (/[;&|]|\|\||&&|[<>]|\$\(|`/.test(text)) return false;

  /**
   * ⚠️ ONLY THE FIRST SEGMENT. `ls && pytest` is not a verification round in any
   * sense we can rely on: we cannot tell which part produced the exit code, and
   * a chain that ENDS in a passing `echo` would otherwise qualify. Judge what
   * was actually invoked first, and let a genuine verification stand alone.
   */
  const tokens = text.split(/[\s]+/).filter(Boolean);
  if (tokens.length === 0) return false;

  // Strip a leading env assignment (`CI=1 pytest`) and a path (`./node_modules/.bin/jest`).
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i += 1;
  if (i >= tokens.length) return false;

  const program = String(tokens[i]).split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');
  const rest = tokens.slice(i + 1).filter((t) => !t.startsWith('-'));

  if (VERIFIERS.has(program)) {
    /**
     * ⚠️ `cargo`, `go`, `dotnet` and friends are only verifications for SOME
     * subcommands. `go get` installing a dependency is not evidence of anything.
     */
    if (['cargo', 'go', 'dotnet', 'gradle', 'mvn', 'bazel'].includes(program)) {
      return rest.length > 0 && VERIFY_SUBCOMMANDS.has(String(rest[0]));
    }
    return true;
  }

  // `python -m pytest`, `node --test`, `npx vitest run`
  if (program === 'python' || program === 'python3' || program === 'py') {
    return rest.some((t) => VERIFIERS.has(String(t)));
  }
  if (program === 'node') return tokens.includes('--test');
  if (program === 'npx' || program === 'pnpx' || program === 'bunx') {
    return rest.length > 0 && VERIFIERS.has(String(rest[0]));
  }
  if (program === 'npm' || program === 'pnpm' || program === 'yarn' || program === 'bun') {
    if (rest.length === 0) return false;
    const sub = String(rest[0]);
    if (sub === 'test' || sub === 'ci') return true;
    // `npm run build` / `npm run typecheck`, but not `npm run dev` or `npm install`.
    if (sub === 'run') return rest.length > 1 && SCRIPT_VERBS.has(String(rest[1]));
    return false;
  }

  return false;
}
