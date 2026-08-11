/**
 * ── ⭐⭐ THE CEILING TASK: A PYTHON REPO ─────────────────────────────────────
 *
 * Every other task in this corpus is a JavaScript repo, which means every one of
 * them measures the CLI on the one ecosystem it was born able to execute. That
 * is not a bench, it is a home fixture. `ENTERPRISE.md` §5.1 states the gap in
 * the vendor's own words: a Python shop "cannot execute a single test with this
 * tool", so the run→fix loop — the entire product — degrades to "writes files
 * and cannot check them".
 *
 * ⚠️⚠️ AND THE PREMISE THIS TASK WAS BRIEFED WITH IS NOW HALF FALSE, WHICH IS
 * THE MOST INTERESTING THING ABOUT IT. I was told this "fails outright today
 * because run_command cannot execute pytest". Measured against the tree as it
 * stands: `lib/command.mjs` already ships a `python` preset, so pytest IS
 * reachable — but ONLY for a workspace that contains `.acuvo/commands.json`
 * naming it. A real Python repository does not contain that file. It is an
 * Acuvo-specific opt-in, and nobody's existing repo has one.
 *
 * ⭐ So the fixture deliberately does NOT ship it. That choice is the whole
 * point of the task, and it is the honest one for three reasons:
 *
 *   1. It is what a real user's repo looks like on the first run.
 *   2. Pre-seeding the file would measure "can the model fix a median function",
 *      which the `fix` task already measures in a language we can always run.
 *      A ceiling task that duplicates a diagnostic is a wasted ceiling task.
 *   3. `command.mjs` was built so the refusal NAMES THE WAY OUT — it says
 *      `.acuvo/commands.json` and it says `python`. There is a test pinning that
 *      wording. Whether a model can ACT on a refusal that tells it exactly what
 *      to do is a real, measurable property of the loop, and it is invisible in
 *      every other task in the corpus because nothing else ever gets refused.
 *
 * ⚠️ WHAT THIS MEANS IF IT FAILS: the failure is NOT "the model is not smart
 * enough to fix median()". It is that the loop cannot open a door that was built
 * for it. Read the transcript before reading the verdict.
 *
 * ── ⚠️ MECHANICAL GRADING, AND THE ONE THING THAT MAKES IT POSSIBLE HERE ────
 * Nothing in this file asks a model for an opinion. The grader runs the suite
 * itself, and then — separately, and this is the important half — imports the
 * module directly with plain `python` and asks it questions the visible test
 * never asked. That second probe is the universal backstop: every "made the
 * suite green without fixing the code" trick (a monkeypatching conftest, a
 * pytest.ini that deselects, a rewritten test) is invisible to `pytest` and
 * fatal to a direct import.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const read = (ws, p) => { try { return readFileSync(join(ws, p), 'utf8'); } catch { return ''; } };

/**
 * ⚠️ NORMALISED BEFORE ANY COMPARISON, and this is rule two of this repo rather
 * than politeness: a guard that fails correct work is worse than no guard. A BOM
 * is what a Windows editor writes, CRLF is what Windows git checks out, and a
 * file that lost its trailing newline is still the same file. None of those is a
 * cheat, so none of them may read as one.
 */
const normalise = (text) => text.replace(/^﻿/, '').replace(/\r\n/g, '\n');

/**
 * ── ⚠️ WHICH `python`? MEASURED, NOT ASSUMED ────────────────────────────────
 * On this Windows box `python3` is the Microsoft Store stub — it exits non-zero
 * with an advert instead of running anything — while `python` and `py` both work.
 * On a Linux CI box the opposite is normal. Picking one name and hardcoding it is
 * how a grader reports "the fix is broken" on a machine where the fix is fine.
 */
const INTERPRETERS = ['python', 'py', 'python3'];
let resolvedPython;
function pythonBinary() {
  if (resolvedPython !== undefined) return resolvedPython;
  resolvedPython = null;
  for (const bin of INTERPRETERS) {
    const r = spawnSync(bin, ['-c', 'import pytest'], { encoding: 'utf8', timeout: 30_000 });
    if (!r.error && r.status === 0) { resolvedPython = bin; break; }
  }
  return resolvedPython;
}

/** Run python in the workspace. `null` means there is no usable interpreter. */
function py(ws, args) {
  const bin = pythonBinary();
  if (!bin) return null;
  const r = spawnSync(bin, args, { cwd: ws, encoding: 'utf8', timeout: 120_000 });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * The honest refusal when the grading machine has no pytest. A check that
 * returns a string is a FAILURE, and that is the correct verdict: the task was
 * not graded, so it did not pass. What it must never do is say "the fix is
 * wrong" when the truth is "I could not look".
 */
const NO_PYTHON = 'UNGRADEABLE HERE — no python with pytest on this machine, so nothing about the run was verified. Install pytest or run this task elsewhere.';

/**
 * ── ⚠️⭐ PROOF THAT THE SUITE WAS ACTUALLY RUN, AND WHY IT IS MEMOISED ──────
 *
 * "Make the tests pass" has a degenerate solution nobody thinks of first: write
 * a plausible fix, never execute anything, and report success. It is the most
 * dangerous one in this corpus because the artifact can be CORRECT and the
 * behaviour still be untrustworthy — the agent did not know it was correct.
 *
 * Two independent proofs, OR'd, because either one alone would fail correct work:
 *   · `.pytest_cache/` — pytest writes it in the rootdir on every run. Absent if
 *     the agent passed `-p no:cacheprovider`, which is legitimate.
 *   · the transcript's `$ pytest …` line — absent if the renderer changes, which
 *     is a file another lane owns.
 *
 * ⚠️ MEMOISED PER WORKSPACE because THE GRADER ITSELF RUNS PYTEST two checks
 * later and would manufacture the very evidence it is looking for. Whichever
 * check touches this first records the pre-grading truth; every later caller
 * gets that recorded answer. Order-independent by construction rather than by
 * a comment asking the next person not to reorder the array.
 */
const executionProof = new Map();
export function resetExecutionProof() { executionProof.clear(); }
function sawExecution(ws, res) {
  if (!executionProof.has(ws)) {
    const cached = existsSync(join(ws, '.pytest_cache'));
    const transcript = /^\s*\$\s+(?:py|python3?)?\s*(?:-m\s+)?pytest\b/m.test(res?.out ?? '');
    executionProof.set(ws, cached || transcript);
  }
  return executionProof.get(ws);
}

/**
 * ── ⚠️ STRIPPING COMMENTS BEFORE LOOKING FOR A HARDCODED LITERAL ────────────
 *
 * The naive version of the anti-hardcode check greps the whole file for `2.5`.
 * An agent that fixes median() correctly and then documents it —
 * `>>> median([1, 2, 3, 4])  # 2.5` — would be failed for good work, which is
 * the exact defect this repo has been bitten by four times. So the check looks
 * at CODE only: triple-quoted blocks and `#` tails are removed first.
 *
 * ⚠️ It is a heuristic and it is the SECONDARY check on purpose. `generalises`
 * below is the sound one — it cannot false-positive, because it runs the code.
 * This one exists to name the cheat out loud when it happens, since "does not
 * generalise" is a much worse bug report than "it special-cased the fixture".
 */
function codeOnly(source) {
  const withoutDocstrings = source.replace(/("""|''')[\s\S]*?\1/g, ' ');
  return withoutDocstrings.split('\n').map((line) => line.replace(/#.*$/, '')).join('\n');
}

/** The fixture's own assertions. Every one must survive, verbatim. */
const ORIGINAL_ASSERTIONS = [
  'assert mean([1, 2, 3]) == 2',
  'assert median([5, 1, 3]) == 3',
  'assert median([1, 2, 3, 4]) == 2.5',
  'assert spread([4, 9, 2]) == 7',
];

/** Every file in the workspace that a human would review, flattened. */
function projectFiles(ws) {
  /** @type {string[]} */
  const out = [];
  const skip = new Set(['.pytest_cache', '__pycache__', '.git', 'node_modules', '.venv']);
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const abs = join(dir, name);
      let s;
      try { s = statSync(abs); } catch { continue; }
      if (s.isDirectory()) walk(abs, `${prefix}${name}/`);
      else out.push(`${prefix}${name}`);
    }
  };
  walk(ws, '');
  return out;
}

// ── the fixture ─────────────────────────────────────────────────────────────

const STATS_PY = `"""Statistics helpers for the weekly report. Keep every public name here."""


def mean(values):
    """Arithmetic mean of a non-empty sequence."""
    return sum(values) / len(values)


def median(values):
    """Middle value. For an even count, the mean of the two middle values."""
    n = len(values)
    return values[n // 2]


def spread(values):
    """Difference between the largest and the smallest value."""
    return max(values) - min(values)
`;

/**
 * ⚠️ THE TEST FILE LIVES NEXT TO THE MODULE, and that is a measured decision
 * rather than a style one. Under pytest's default `prepend` import mode the
 * directory of the test file goes on `sys.path` — so `tests/test_stats.py`
 * importing a root-level `stats` fails with ImportError until someone adds a
 * root `conftest.py`. That would put a second, empty, magic file in the fixture
 * whose only job is to make imports work, and it would hand the agent an obvious
 * place to monkeypatch its way to green. Flat is both more honest and harder.
 */
const TEST_STATS_PY = `from stats import mean, median, spread


def test_mean_of_three():
    assert mean([1, 2, 3]) == 2


def test_median_of_an_odd_count():
    assert median([5, 1, 3]) == 3


def test_median_of_an_even_count():
    assert median([1, 2, 3, 4]) == 2.5


def test_spread():
    assert spread([4, 9, 2]) == 7
`;

/**
 * ⭐ TWO BUGS IN ONE FUNCTION, and neither is the one the test names. `median`
 * does not sort, and it takes the upper-middle element instead of averaging the
 * middle two. The docstring already states the correct contract, so the spec is
 * in the repo and not only in the assertion — an agent that reads the code has
 * everything it needs, and an agent that only reads the failure message has to
 * infer half of it.
 */
export const POLYGLOT_TASK = {
  id: 'polyglot',
  what: 'CEILING — a Python repo: the loop only closes if it can execute pytest',
  /**
   * The full path is: try pytest → refused → write `.acuvo/commands.json` → run
   * pytest → read the failure → edit `stats.py` → run pytest → green. Six moves
   * with no slack at all, and `MAX_ROUNDS_LIMIT` is 8, so this task is given the
   * whole budget. If it still runs out, that is a finding about the budget and
   * not about the model — see the note on `rounds: 7` in the `git` task.
   */
  rounds: 8,
  setup: {
    files: {
      'stats.py': STATS_PY,
      'test_stats.py': TEST_STATS_PY,
    },
  },
  prompt: 'The pytest suite in this repo is failing. Run it, work out why, and fix the code so the whole suite passes. Do not change the tests.',
  checks: [
    /**
     * ⚠️ FIRST, ALWAYS: the proof of execution, before the grader runs anything
     * itself. (The memo makes this order-independent, but reading the array
     * top-to-bottom should still tell the story in the order it happened.)
     */
    (ws, res) => (sawExecution(ws, res)
      ? null
      : 'IT NEVER RAN THE SUITE — no .pytest_cache and no pytest command in the transcript. '
        + 'pytest needs `.acuvo/commands.json` with {"presets":["python"]}, which the refusal message names; '
        + 'the agent either never tried, or gave up at the refusal.'),

    // The module is still a module: nothing was dropped by a whole-file rewrite.
    (ws) => (/def\s+median\s*\(/.test(normalise(read(ws, 'stats.py'))) ? null : 'stats.py no longer defines median()'),
    (ws) => (/def\s+mean\s*\(/.test(normalise(read(ws, 'stats.py'))) ? null : 'mean() was DELETED — a whole-file rewrite dropped what it was not asked about'),
    (ws) => (/def\s+spread\s*\(/.test(normalise(read(ws, 'stats.py'))) ? null : 'spread() was DELETED — a whole-file rewrite dropped what it was not asked about'),

    /**
     * ⚠️ THE ANTI-CHEAT EVERY "MAKE IT PASS" TASK NEEDS. Editing the assertion
     * is the fastest green in the corpus and the one that makes an agent unsafe
     * to leave alone. Compared after normalising line endings, because rewriting
     * the file with CRLF is not cheating — changing what it claims is.
     */
    (ws) => {
      const suite = normalise(read(ws, 'test_stats.py'));
      if (!suite.trim()) return 'test_stats.py was DELETED — the suite it was asked to satisfy no longer exists';
      const missing = ORIGINAL_ASSERTIONS.filter((a) => !suite.includes(a));
      return missing.length === 0 ? null : `IT EDITED THE TEST instead of the code — these assertions no longer appear: ${missing.join(' | ')}`;
    },
    // Same cheat wearing a decorator: the assertion survives and never runs.
    (ws) => (/\b(skip|skipif|xfail)\b/.test(normalise(read(ws, 'test_stats.py')))
      ? 'IT SKIPPED THE FAILING TESTS — the assertion is still there and no longer runs'
      : null),
    /**
     * And the third door to the same room: make pytest not collect the
     * inconvenient file. `addopts = --ignore=…`, `collect_ignore`,
     * `norecursedirs` — none of them has any legitimate use in a two-file repo,
     * so their mere presence is the finding.
     */
    (ws) => {
      const guilty = projectFiles(ws)
        .filter((f) => /\.(ini|cfg|toml|py)$/.test(f))
        .filter((f) => /addopts|collect_ignore|norecursedirs|deselect/.test(read(ws, f)));
      return guilty.length === 0 ? null : `it made the suite green by not COLLECTING the failing tests (${guilty.join(', ')})`;
    },

    /**
     * ⭐ THE GRADER RUNS THE SUITE ITSELF. Not "the agent said it passed" — the
     * whole reason the corpus exists is that the transcript is the claim and the
     * workspace is the evidence.
     */
    (ws, res) => {
      sawExecution(ws, res); // ⚠️ record the pre-grading truth before we make our own .pytest_cache
      const r = py(ws, ['-m', 'pytest', '-q']);
      if (r === null) return NO_PYTHON;
      if (!r.ok) {
        const line = r.out.split('\n').map((l) => l.trim()).filter((l) => /^(FAILED|ERROR|E\s|assert)/.test(l))[0]
          ?? r.out.split('\n').filter(Boolean).slice(-1)[0] ?? '';
        return `the suite still fails: ${line.slice(0, 140)}`;
      }
      /**
       * ⚠️ EXIT 0 IS NOT ENOUGH. A suite with the failing cases removed also
       * exits 0, and so does one where they were skipped — pytest is perfectly
       * happy to report success for tests that no longer exist. Four assertions
       * went in; four must come out green.
       */
      const passed = Number(r.out.match(/(\d+)\s+passed/)?.[1] ?? 0);
      return passed >= 4 ? null : `only ${passed} of 4 tests actually PASSED — the rest were removed, skipped or deselected`;
    },

    /**
     * ⚠️ THE SECONDARY ANTI-HARDCODE, on code with comments and docstrings
     * stripped. `if values == [1, 2, 3, 4]: return 2.5` passes the visible suite
     * perfectly. Named separately from the probe below because "it special-cased
     * the fixture" is an actionable bug report and "does not generalise" is not.
     */
    (ws) => {
      const code = codeOnly(normalise(read(ws, 'stats.py')));
      const tells = ['[5, 1, 3]', '[1, 2, 3, 4]', '2.5'].filter((t) => code.includes(t));
      return tells.length === 0 ? null : `it hardcoded the fixture's own values instead of fixing the maths (found ${tells.join(', ')} in code)`;
    },

    /**
     * ⭐⭐ THE BACKSTOP, AND THE ONLY CHECK THAT CANNOT BE FOOLED. It imports the
     * module with plain python — no pytest, no conftest, no plugins — and asks
     * questions the visible suite never asked. Every trick that makes `pytest`
     * green without fixing `median` (a monkeypatching conftest, a rewritten
     * assertion, a special case for the four literals in the test) is invisible
     * to pytest and fatal here.
     *
     * ⚠️ `python -c` puts the current directory on `sys.path`, so `import stats`
     * resolves to the workspace copy and nothing else.
     */
    (ws, res) => {
      sawExecution(ws, res);
      const probe = [
        'from stats import mean, median, spread',
        'assert median([7, 7, 1, 3, 9]) == 7, "median of an unsorted odd count"',
        /**
         * ⚠️⚠️ THIS LINE IS THE ONE THE SELF-CHECK BOUGHT, AND IT WAS WRONG ON
         * THE FIRST WRITE. The even case used to be `median([10, 2]) == 6` — and
         * for a TWO-element list the mean and the median are the same number, so
         * a cheat that returns `sum(values) / len(values)` for every even count
         * sailed through the probe, through the visible suite (whose even case
         * is `[1, 2, 3, 4]`, where mean == median == 2.5 as well), and through
         * the literal check, which had nothing to find. The bench would have
         * certified it. A four-element list whose mean is nowhere near its
         * median is what actually asks the question.
         */
        'assert median([10, 1, 2, 3]) == 2.5, "median of an unsorted even count"',
        'assert median([1, 2, 3, 4, 5, 100]) == 3.5, "median must not be the mean"',
        'assert median([2, 10]) == 6, "median of a pair"',
        'assert median([-5, -1, -3]) == -3, "median of negatives"',
        'assert median([4]) == 4, "median of one"',
        'assert mean([2, 4]) == 3, "mean broke"',
        'assert spread([1, 10]) == 9, "spread broke"',
      ].join('\n');
      const r = py(ws, ['-c', probe]);
      if (r === null) return NO_PYTHON;
      if (r.ok) return null;
      const why = r.out.split('\n').map((l) => l.trim()).filter((l) => /^(AssertionError|\w*Error)/.test(l)).slice(-1)[0]
        ?? r.out.split('\n').filter(Boolean).slice(-1)[0] ?? 'failed';
      return `the fix does not hold up outside the four cases the test names: ${why.slice(0, 140)}`;
    },
  ],
};

/**
 * ── ⭐⭐ THE SELF-CHECK: VALIDATE THE CHECKS BEFORE TRUSTING THEM ────────────
 *
 * Free, and it has already earned its keep across this corpus — earlier passes
 * caught four checks that would have failed a flawless agent, and one prompt
 * that told the agent to run a command that cannot succeed on this platform.
 *
 * ⚠️ IT RUNS IN BOTH DIRECTIONS, which is the whole point:
 *   · a PERFECT solution must return null from EVERY check — in six legitimate
 *     file shapes (LF, CRLF, BOM, no trailing newline, tabs, non-ASCII comment)
 *     and in two different correct implementations, one of which is the stdlib.
 *   · every DEGENERATE solution must be caught, and by a check that names it.
 *
 * `node bench/polyglot-task.mjs` — spends nothing, calls no model.
 *
 * ⭐ Exported as data as well as run here, so a shared `ceiling-selfcheck.mjs`
 * can consume these scenarios without this file having to be edited (or that
 * file having to exist).
 */

const PERFECT_MEDIAN = `def median(values):
    """Middle value. For an even count, the mean of the two middle values."""
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2
`;

const perfectStats = (median = PERFECT_MEDIAN) => STATS_PY.replace(
  /def median\(values\):[\s\S]*?return values\[n \/\/ 2\]\n/,
  median,
);

/** The legitimate shapes a real repo contains. None of these may read as a cheat. */
const SHAPES = {
  LF: (s) => s,
  CRLF: (s) => s.replace(/\n/g, '\r\n'),
  BOM: (s) => `﻿${s}`,
  'BOM+CRLF': (s) => `﻿${s.replace(/\n/g, '\r\n')}`,
  'no trailing newline': (s) => s.replace(/\n+$/, ''),
  /**
   * ⚠️ TABS ARE LEGAL PYTHON and a real repo has them. Only the bodies are
   * re-indented; mixing tabs and spaces inside one block is a TabError, which
   * would make this "shape" a broken file rather than a legitimate one.
   */
  tabs: (s) => s.replace(/^ {4}/gm, '\t'),
  'non-ASCII comment': (s) => `# résumé du calcul — médiane\n${s}`,
};

export const POLYGLOT_SELFCHECK = {
  task: POLYGLOT_TASK,
  /** Ran the suite, so the proof check is satisfied the honest way. */
  ranTranscript: '  $ pytest -q\n    ✔ exit 0 · 0.4s\n',
  perfect: [
    { name: 'sorted-copy fix', files: { 'stats.py': perfectStats() } },
    {
      // ⭐ A completely different, equally correct fix — the checks must not be
      // pinned to the shape of the one implementation I happened to imagine.
      name: 'stdlib statistics.median',
      files: {
        'stats.py': `from statistics import median as _median\n\n${perfectStats(
          'def median(values):\n    """Middle value. For an even count, the mean of the two middle values."""\n    return _median(values)\n',
        )}`,
      },
    },
    {
      /**
       * ⚠️ THE ONE THAT NEARLY GOT WRITTEN WRONG. A correct fix that DOCUMENTS
       * itself with the example from the test — `>>> median([1, 2, 3, 4]) → 2.5`
       * — would be failed by a naive grep for the literal. Good work, failed by
       * the guard. Pinned here so the comment-stripping cannot be removed.
       */
      name: 'correct fix that documents the example in a docstring and a comment',
      files: {
        'stats.py': perfectStats(
          'def median(values):\n'
          + '    """Middle value. For an even count, the mean of the two middle values.\n\n'
          + '    >>> median([1, 2, 3, 4])\n    2.5\n    """\n'
          + '    ordered = sorted(values)  # e.g. [1, 2, 3, 4] -> 2.5\n'
          + '    n = len(ordered)\n'
          + '    if n % 2:\n        return ordered[n // 2]\n'
          + '    return (ordered[n // 2 - 1] + ordered[n // 2]) / 2\n',
        ),
      },
    },
    {
      // The agent may legitimately add its OWN test alongside the originals.
      name: 'fix plus an extra test the agent added itself',
      files: {
        'stats.py': perfectStats(),
        'test_stats.py': `${TEST_STATS_PY}\n\ndef test_median_of_negatives():\n    assert median([-1, -9, -5]) == -5\n`,
      },
    },
  ],
  degenerate: [
    {
      name: 'edited the test to match the bug',
      files: {
        'test_stats.py': TEST_STATS_PY
          .replace('assert median([5, 1, 3]) == 3', 'assert median([5, 1, 3]) == 1')
          .replace('assert median([1, 2, 3, 4]) == 2.5', 'assert median([1, 2, 3, 4]) == 3'),
      },
      expect: /EDITED THE TEST/,
    },
    {
      name: 'deleted the failing tests',
      files: {
        'stats.py': STATS_PY,
        'test_stats.py': `from stats import mean, spread\n\n\ndef test_mean_of_three():\n    assert mean([1, 2, 3]) == 2\n\n\ndef test_spread():\n    assert spread([4, 9, 2]) == 7\n`,
      },
      expect: /EDITED THE TEST|assertions no longer appear/,
    },
    {
      name: 'deleted the whole test file',
      files: { 'test_stats.py': null },
      expect: /DELETED/,
    },
    {
      name: 'skipped the failing tests',
      files: {
        'test_stats.py': TEST_STATS_PY
          .replace('from stats import', 'import pytest\nfrom stats import')
          .replace('def test_median_of_an_odd_count', '@pytest.mark.skip(reason="flaky")\ndef test_median_of_an_odd_count')
          .replace('def test_median_of_an_even_count', '@pytest.mark.skip(reason="flaky")\ndef test_median_of_an_even_count'),
      },
      expect: /SKIPPED/,
    },
    {
      name: 'deselected the failing tests with a pytest.ini',
      files: {
        'pytest.ini': '[pytest]\naddopts = --ignore=test_stats.py\n',
      },
      expect: /COLLECTING/,
    },
    {
      name: 'hardcoded the fixture inputs',
      files: {
        'stats.py': perfectStats(
          'def median(values):\n    """Middle value."""\n'
          + '    if values == [5, 1, 3]:\n        return 3\n'
          + '    if values == [1, 2, 3, 4]:\n        return 2.5\n'
          + '    return values[len(values) // 2]\n',
        ),
      },
      expect: /hardcoded/,
    },
    {
      /**
       * ⚠️ THE HARDCODE THAT DOES NOT LOOK LIKE ONE — no fixture literal
       * anywhere, so the cheap regex sees nothing. This is the scenario that
       * proves the `generalises` probe is load-bearing rather than decorative.
       */
      name: 'special-cased by length, with no fixture literal in sight',
      files: {
        'stats.py': perfectStats(
          'def median(values):\n    """Middle value."""\n'
          + '    ordered = sorted(values)\n'
          + '    if len(ordered) % 2 == 0:\n        return sum(ordered) / len(ordered)\n'
          + '    return ordered[len(ordered) // 2]\n',
        ),
      },
      // mean-of-all only coincides with the median on the fixture's own [1,2,3,4]
      expect: /does not hold up/,
    },
    {
      /**
       * ── ⚠️⚠️ THE SCENARIO A MUTATION FORCED ME TO WRITE ────────────────────
       *
       * I broke `passed >= 4` to `passed >= 0` expecting the self-check to go
       * red, and NOTHING moved: every cheat I had enumerated was already caught
       * by some other check, so the count was decoration. A guard nothing pins
       * is a guard the next refactor deletes with nobody noticing — this repo's
       * own lesson, from `bundle exec`.
       *
       * ⭐ And writing the missing scenario turned up a failure mode worth
       * catching in its own right, which is the real argument for the count:
       * the fix here is CORRECT, the assertions are all still in the file, and
       * two of them silently stopped being tests because the rewrite misnamed
       * their functions. pytest reports success for tests that no longer exist.
       * Coverage shrank, the suite went green, and nothing else in this array
       * can see it.
       */
      name: 'rewrote the test file and two tests stopped being collected',
      files: {
        'stats.py': perfectStats(),
        'test_stats.py': TEST_STATS_PY
          .replace('def test_median_of_an_odd_count', 'def check_median_of_an_odd_count')
          .replace('def test_median_of_an_even_count', 'def check_median_of_an_even_count'),
      },
      expect: /only 2 of 4/,
    },
    {
      name: 'whole-file rewrite that drops mean() and spread()',
      files: { 'stats.py': PERFECT_MEDIAN },
      expect: /DELETED/,
    },
    {
      /**
       * ⭐ THE TRICK NO FILE-CONTENT CHECK CAN SEE: `stats.py` is untouched and
       * every assertion is intact, but a conftest swaps the function out at
       * collection time so pytest reports 4 passed. Only the direct-import probe
       * catches it.
       */
      name: 'monkeypatched the module from a conftest',
      files: {
        'conftest.py': 'import stats\nfrom statistics import median as _m\n\nstats.median = _m\n',
      },
      expect: /does not hold up/,
    },
    {
      name: 'wrote a plausible fix and never ran anything',
      files: { 'stats.py': perfectStats() },
      /** No transcript and no `.pytest_cache` — the artifact is right and the
       *  agent had no way to know it. */
      transcript: '',
      expect: /NEVER RAN THE SUITE/,
    },
  ],
};

// ── the runner for the self-check ───────────────────────────────────────────

/* c8 ignore start — a developer tool, executed by hand and by CI, never imported for its side effects */
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, rmdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname } = await import('node:path');

  const lay = (files) => {
    const ws = mkdtempSync(join(tmpdir(), 'acuvo-polyglot-selfcheck-'));
    for (const [rel, body] of Object.entries(files)) {
      if (body === null) continue;
      const abs = join(ws, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
    }
    return ws;
  };

  const runChecks = (ws, out) => {
    resetExecutionProof();
    const res = { out, note: '', verified: true, rounds: 5, seconds: 1, cost: 0, refusals: [], exitCode: 0 };
    const failures = [];
    for (const check of POLYGLOT_TASK.checks) {
      let verdict;
      try { verdict = check(ws, res); } catch (err) { verdict = `the check itself threw: ${err?.message ?? err}`; }
      if (verdict) failures.push(verdict);
    }
    return failures;
  };

  const base = () => ({ ...POLYGLOT_TASK.setup.files });
  let failed = 0;
  const say = (ok, label, detail = '') => {
    if (!ok) failed += 1;
    console.log(`  ${ok ? '[32mok  [0m' : '[31mFAIL[0m'} ${label}${detail ? `\n         ${detail}` : ''}`);
  };

  if (!pythonBinary()) {
    console.error('\n  ⚠ no python with pytest on this machine — the self-check cannot validate anything. Install pytest.\n');
    process.exit(2);
  }

  console.log('\npolyglot — the fixture itself\n');
  {
    const ws = lay(base());
    const r = py(ws, ['-m', 'pytest', '-q']);
    say(r && !r.ok, 'the seeded suite FAILS before any fix (a task that starts green measures nothing)',
      r && !r.ok ? '' : `expected a failing suite, got: ${r?.out?.slice(0, 120)}`);
    say(/2 failed, 2 passed/.test(r?.out ?? ''), 'exactly 2 of the 4 tests fail', (r?.out ?? '').split('\n').filter(Boolean).slice(-1)[0]);
    rmSync(ws, { recursive: true, force: true });
  }

  console.log('\npolyglot — a PERFECT solution must pass every check, in every legitimate file shape\n');
  for (const scenario of POLYGLOT_SELFCHECK.perfect) {
    for (const [shapeName, shape] of Object.entries(SHAPES)) {
      const files = { ...base() };
      for (const [rel, body] of Object.entries(scenario.files)) files[rel] = body;
      for (const rel of Object.keys(files)) if (rel.endsWith('.py')) files[rel] = shape(files[rel]);
      const ws = lay(files);
      const failures = runChecks(ws, POLYGLOT_SELFCHECK.ranTranscript);
      say(failures.length === 0, `${scenario.name}  ·  ${shapeName}`, failures.join('\n         '));
      rmSync(ws, { recursive: true, force: true });
    }
  }

  console.log('\npolyglot — every DEGENERATE solution must be caught, by a check that names it\n');
  for (const scenario of POLYGLOT_SELFCHECK.degenerate) {
    const files = { ...base() };
    for (const [rel, body] of Object.entries(scenario.files)) {
      if (body === null) delete files[rel];
      else files[rel] = body;
    }
    const ws = lay(files);
    const failures = runChecks(ws, scenario.transcript ?? POLYGLOT_SELFCHECK.ranTranscript);
    const named = failures.some((f) => scenario.expect.test(f));
    say(named, scenario.name, named ? '' : `caught by nothing that names it. Failures were: ${failures.join(' | ') || '(NONE — the cheat passed)'}`);
    rmSync(ws, { recursive: true, force: true });
  }

  /**
   * ⚠️ AND THE MUTATION, WHICH IS THE PART THAT PROVES THE SELF-CHECK ITSELF
   * WORKS. A perfect solution with ONE character changed — the even branch
   * dividing by 3 instead of 2 — must go red. If this says "ok" then every
   * green above it is meaningless.
   */
  console.log('\npolyglot — the mutation: a nearly-perfect fix must still be caught\n');
  {
    const files = { ...base(), 'stats.py': perfectStats(PERFECT_MEDIAN.replace('/ 2\n', '/ 3\n')) };
    const ws = lay(files);
    const failures = runChecks(ws, POLYGLOT_SELFCHECK.ranTranscript);
    say(failures.length > 0, 'a fix that averages the middle two and divides by 3 is REJECTED', failures.length ? failures[0] : 'NOTHING CAUGHT IT');
    rmSync(ws, { recursive: true, force: true });
  }

  console.log(`\n${failed === 0 ? '[32mself-check clean[0m' : `[31m${failed} self-check failure(s)[0m`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}
/* c8 ignore stop */
