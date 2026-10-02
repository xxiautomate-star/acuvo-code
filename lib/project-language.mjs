/**
 * ── ⭐⭐⭐ THE CORE LOOP DID NOT WORK OUTSIDE NODE, AND THE BENCH PROVED IT ───
 *
 * Measured 2026-08-23 on our own corpus: **12 of 13 tasks passed**, and the one
 * failure was `polyglot` — a Python repo where the task only closes if the agent
 * can execute `pytest`. It could not. The agent handled it correctly (it refused
 * and explained how to enable the preset rather than inventing a test result),
 * but the task was unfinishable.
 *
 * ⚠️ THE CAUSE IS NOT PYTHON-SHAPED. `resolveCommandAllowlist({})` returns
 * **zero presets**: python, go, rust, ruby, make and node-bin are all off unless
 * somebody writes `.acuvo/commands.json` or exports `ACUVO_ALLOW_COMMANDS`. So
 * out of the box the agent cannot run `pytest`, `go test`, `cargo test`, `rspec`
 * or `make` — which means "run the failing test, then fix the code", the loop
 * that makes a coding agent worth anything, silently does not work in most of
 * the languages people write.
 *
 * ⭐ AND NOBODY WOULD EVER REPORT IT AS A BUG. They would try it on their Django
 * project, watch it decline to run the tests, and conclude the tool is weak.
 *
 * ── ⚠️ WHY DETECTION IS SAFE HERE, STATED CAREFULLY ─────────────────────────
 *
 * This does NOT loosen what a preset permits. Each one is a grammar — the python
 * preset validates argv through `validatePythonArgv`, so `python -c "..."` and
 * arbitrary shell stay refused whether or not the preset is on. What changes is
 * only WHICH grammar is available, and it is decided by unambiguous evidence
 * the project itself carries: a `pyproject.toml` is not a hint that this might
 * be Python, it is Python declaring itself.
 *
 * ⚠️ AND `--no-run` STILL OUTRANKS ALL OF IT. Detection chooses among things the
 * user has already permitted the agent to do; it cannot grant execution to a run
 * that was launched without it.
 */

/**
 * The files a language uses to declare itself, and the preset each unlocks.
 *
 * ⚠️ MANIFESTS ONLY — NEVER SOURCE EXTENSIONS. A stray `.py` in a Node repo
 * (a build script, a vendored tool) must not turn the Python grammar on for the
 * whole workspace. A manifest is a statement of what the project IS; a file
 * extension is a statement about one file.
 */
export const LANGUAGE_MARKERS = Object.freeze([
  { preset: 'python', files: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'] },
  { preset: 'go', files: ['go.mod'] },
  { preset: 'rust', files: ['Cargo.toml'] },
  { preset: 'ruby', files: ['Gemfile', '.ruby-version'] },
  /**
   * ⚠️ `make` IS LAST AND IS NOT EXCLUSIVE. A Makefile sits beside a Cargo.toml
   * far more often than it stands alone, so it adds a grammar rather than
   * identifying the project.
   */
  { preset: 'make', files: ['Makefile', 'makefile', 'GNUmakefile'] },
]);

/**
 * Which presets this project has earned, from the manifests present at its root.
 *
 * Pure: it takes the list of filenames, not a directory, so every rule here is
 * testable without a disk.
 *
 * @param {readonly string[]} rootFiles  filenames (not paths) at the workspace root
 * @returns {string[]} preset names, in a stable order
 */
/**
 * A file that only exists because somebody intends to run a test suite.
 *
 * ── ⚠️ THIS RULE WAS ADDED BECAUSE A BENCHMARK FAILED, AND THAT IS WORTH
 *      SAYING OUT LOUD ────────────────────────────────────────────────────────
 *
 * The `polyglot` task is a Python repo containing exactly `stats.py` and
 * `test_stats.py` — no manifest — so the manifest-only rule above correctly
 * declined and the task was unpassable. Changing a rule to make a benchmark
 * pass is the shape of overfitting, so the question is whether the rule is
 * right INDEPENDENTLY of the benchmark.
 *
 * ⭐ It is, and the distinction is INTENT. A stray `build.py` in a Node repo is
 * somebody's script; `test_stats.py` or `conftest.py` is somebody declaring that
 * a pytest suite exists and is meant to be run. Plenty of real Python projects
 * — scripts, exercises, small libraries — carry no `pyproject.toml` at all, and
 * "run the failing test" is the one thing this agent is for.
 *
 * ⚠️ The blast radius is bounded either way: enabling the preset chooses a
 * GRAMMAR, and `validatePythonArgv` still refuses `python -c "..."` and anything
 * else outside it.
 */
function looksLikeAPytestSuite(names) {
  return names.some((f) => f === 'conftest.py' || /^test_.+\.py$/.test(f) || /^.+_test\.py$/.test(f));
}

export function detectPresets(rootFiles) {
  const names = (rootFiles ?? []).map((f) => String(f));
  const present = new Set(names);
  const out = [];
  for (const { preset, files } of LANGUAGE_MARKERS) {
    if (files.some((f) => present.has(f)) && !out.includes(preset)) out.push(preset);
  }
  if (!out.includes('python') && looksLikeAPytestSuite(names)) out.unshift('python');
  return out;
}

/**
 * One sentence for the banner or a refusal, naming what was turned on and why.
 *
 * ⚠️ THE REASON IS PART OF THE MESSAGE. "python enabled" reads as the tool
 * having decided something about the user's machine; "python enabled —
 * pyproject.toml" shows them the evidence and, if it is wrong, tells them
 * exactly which file to look at.
 */
export function describeDetected(rootFiles) {
  const present = new Set((rootFiles ?? []).map((f) => String(f)));
  const parts = [];
  for (const { preset, files } of LANGUAGE_MARKERS) {
    const hit = files.find((f) => present.has(f));
    if (hit) parts.push(`${preset} (${hit})`);
  }
  return parts.length ? parts.join(' · ') : null;
}
