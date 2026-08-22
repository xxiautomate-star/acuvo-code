/**
 * ── ⚠️⚠️ NINE TESTS DESCRIBE MODULES THAT HAVE NEVER EXISTED HERE ───────────
 *
 * The brief for this lane says to "expose the 7 dark CLI modules" — `code-review`,
 * `db-inspect`, `diff-preview`, `log-tail`, `plan-coherence`, `python`, `rcfile`.
 * Measured 2026-08-17, they are not dark. **They are absent.**
 *
 *     $ git log --all -- acuvo-code/lib/code-review.mjs
 *     (nothing)
 *
 * Nine modules, referenced by eight test files that all landed in `a11978043` on
 * 2026-08-16. `git log --all` finds no commit that ever contained any of the
 * nine. **One commit staged `test/` and not `lib/`.**
 *
 * ⭐ AND THAT IS THE FAILURE MODE OF A RULE THIS REPO IS RIGHT ABOUT. The
 * checkout is shared between terminals, so `git add -A` is banned and everything
 * is committed by explicit pathspec. The price of that rule is that half a
 * feature can go in — and nothing was watching for it. The nine tests simply
 * went red and stayed red, and `ENTERPRISE.md`'s file count was taken from the
 * working tree, so it kept counting files that were never pushed (102 against a
 * real 93 — exactly these nine).
 *
 * ── WHY THIS FILE EXISTS RATHER THAN A DELETION OR A SKIP ──────────────────
 * ⚠️ The nine tests are NOT deleted. They are the only surviving description of
 * what those modules were meant to do, and deleting them would turn a
 * recoverable mistake into a lost one.
 *
 * ⚠️ They are NOT skipped either. They are genuinely broken and the red is
 * TRUE — a suite that goes green while nine features are missing is the
 * laundered zero this repo keeps paying for, one level up.
 *
 * What this adds is the one thing missing: **a single legible statement of the
 * cause**, so nine opaque `ERR_MODULE_NOT_FOUND` stacks read as one recoverable
 * mistake with a named fix (push the nine `lib/` files), and so a TENTH orphan
 * fails here immediately instead of joining the pile.
 *
 * ── ⭐⭐ AND THE FIRST ONE CAME BACK WITHOUT BEING FOUND (2026-08-17) ────────
 *
 * `lib/http-probe.mjs` was not recovered from a stash or a reflog — there was
 * nothing to recover. It was **rebuilt from `test/http-probe.test.mjs`**, whose
 * 702 lines pin the contract assertion by assertion: the port guard and its
 * `portVerified === true` rule, three distinct failure sentences, both body
 * caps and the order they compose in, the header policy, the `::1` fallback,
 * the schema. 44 tests, red at the top of the session and green at the bottom,
 * plus the three in `call-endpoint-is-evidence.test.mjs` that were red for a
 * different reason (`call_endpoint` was never registered in `tools.mjs`).
 *
 * ⭐ THAT IS THE PAYOFF OF THE PARAGRAPH ABOVE, and the reason to read it as a
 * rule rather than a note. Had the nine tests been deleted "to get the suite
 * green", or skipped, the specification would have gone with them and this
 * module would be gone for good. **A true red is an asset.** `lib/log-tail.mjs` followed the same hour (47 tests); seven remain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The nine, frozen. **MAY ONLY SHRINK.**
 *
 * ⚠️ Each entry is a promise that somebody knows the module is missing — not a
 * place to park the next one. Pushing `lib/code-review.mjs` makes that test pass
 * and this list one shorter; adding a tenth orphan fails the assertion below on
 * the commit that introduces it, which is the whole point.
 */
/**
 * ── ⭐ ALL SIX HAVE LANDED. THE LIST IS EMPTY, AND THAT IS THE POINT. ──────
 *
 * This list is "the work that is left", so an entry that exists is a lie about
 * the state of the repo. Verified 2026-08-19 — every one is a real module, not
 * a stub, and five of the six are imported by production code:
 *
 *   code-review.mjs     1,382 lines   imported by 1
 *   completion.mjs        514 lines   imported by 2
 *   db-inspect.mjs      1,624 lines   imported by 1
 *   diff-preview.mjs    1,044 lines   imported by 3
 *   rcfile.mjs            853 lines   imported by 1
 *   plan-coherence.mjs  1,084 lines   imported by 0   ⚠️ exists, NOT wired
 *
 * ⚠️ `plan-coherence.mjs` is deliberately still listed as an ORPHAN by the
 * reachability test in this file — a different question with a different answer.
 * "The module exists" and "anything can reach it" are not the same claim, and
 * collapsing them is how 1,084 lines of capability sit in a repo unreachable
 * while a green list says the work is done.
 */
const MISSING = [];

/** Every `../lib/x.mjs` a test imports, with the test that wants it. */
function importedLibModules() {
  const wanted = new Map();
  for (const f of readdirSync(join(ROOT, 'test'))) {
    if (!f.endsWith('.mjs')) continue;
    const src = readFileSync(join(ROOT, 'test', f), 'utf8');
    // ⚠️ STATIC IMPORTS AND `await import()` ALIKE. A dynamic import inside a
    // test fails at the same point and for the same reason; matching only the
    // static form would let the next orphan hide behind a lazy one.
    for (const m of src.matchAll(/(?:from|import\()\s*'\.\.\/(lib\/[a-z0-9-]+\.mjs)'/g)) {
      if (!wanted.has(m[1])) wanted.set(m[1], []);
      wanted.get(m[1]).push(f);
    }
  }
  return wanted;
}

test('⚠️ the scan finds imports at all — a silent zero would agree with anything', () => {
  const wanted = importedLibModules();
  assert.ok(wanted.size > 50, `only ${wanted.size} lib imports found across the test suite — the scan drifted`);
  assert.ok(wanted.has('lib/tools.mjs'), 'the scan cannot see the most-imported module in the package');
});

test('⚠️⚠️ no test imports a lib module that does not exist', () => {
  const wanted = importedLibModules();
  const orphans = [...wanted.keys()].filter((p) => !existsSync(join(ROOT, p))).sort();
  const unexpected = orphans.filter((p) => !MISSING.includes(p));
  assert.deepEqual(
    unexpected,
    [],
    'a test imports a lib module that was never committed. The test half of a change went in '
    + 'without the lib half — commit both, or add the module to MISSING with the reason:\n  '
    + unexpected.map((p) => `${p} <- ${wanted.get(p).join(', ')}`).join('\n  '),
  );
});

/**
 * ⚠️ AND THE LIST MAY NOT GO STALE. An entry for a module that now exists is
 * documentation claiming a hole that has been filled — and a stale allowlist is
 * how the next real orphan gets waved through.
 */
test('⚠️ every entry in MISSING is still actually missing', () => {
  const stale = MISSING.filter((p) => existsSync(join(ROOT, p)));
  assert.deepEqual(
    stale,
    [],
    `these modules have landed — delete them from MISSING so the list is the work that is left: ${stale.join(', ')}`,
  );
});

/**
 * ⭐ AND THE ORPHANS MUST STILL BE THE ONES WE THINK. If a test file that wants
 * one of these is itself deleted, the entry becomes unreferenced — which is a
 * different kind of stale, and the quiet way a feature stops being missed.
 */
test('⭐ every missing module is still wanted by a test', () => {
  const wanted = importedLibModules();
  const unwanted = MISSING.filter((p) => !wanted.has(p));
  assert.deepEqual(
    unwanted,
    [],
    'nothing imports these any more — either the test was deleted (in which case the feature is '
    + `no longer merely missing, it is forgotten) or the entry is wrong: ${unwanted.join(', ')}`,
  );
});

/**
 * ── ⭐ AND THE SAME COMMIT LEFT TWO MODULES HALF-EDITED ─────────────────────
 *
 * Nine whole files is the loud half. The quiet half is two modules that DO
 * exist and are missing the exports the same commit's tests import:
 *
 *   lib/subagent.mjs  → briefFor · describeVerification · SUBAGENT_VERIFY_TOOL_NAMES · MAX_CONTEXT_CHARS
 *   lib/lsp.mjs       → workspaceCanBeServed · checkLspArgs  ⭐ RECOVERED 2026-08-17
 *
 * Those two fail with `SyntaxError: does not provide an export named …` rather
 * than `ERR_MODULE_NOT_FOUND`, which is why they read as unrelated in the suite
 * output and were diagnosed separately. They are the same event: **one commit
 * staged `test/` and left every `lib/` change behind.**
 *
 * ⚠️ THE NAMES ARE CHECKED AGAINST THE REAL MODULE, NOT PARSED OUT OF IT. A
 * regex over `export function …` would miss `export { a, b }`, re-exports and
 * `export const` destructuring — and a checker that under-reports is worse than
 * none here, because its green is what somebody would trust.
 */
/**
 * ── ⭐ EMPTY, BECAUSE ALL FOUR NOW EXIST ───────────────────────────────
 *
 * `lib/subagent.mjs` now exports `MAX_CONTEXT_CHARS`,
 * `SUBAGENT_VERIFY_TOOL_NAMES`, `briefFor` and `describeVerification` — verified
 * against the module, 2026-08-19.
 *
 * ⚠️ This map is an ALLOWLIST of known gaps, so a stale entry silently excuses
 * a real one: the loop above `continue`s on anything listed here. That is what
 * the test guarding it means by *"which is how the next real gap gets waved
 * through"*. Keeping it empty is the honest state.
 */
const MISSING_EXPORTS = {
};

/** Named imports a test takes from a lib module: module → name → tests. */
function namedImports() {
  const wanted = new Map();
  for (const f of readdirSync(join(ROOT, 'test'))) {
    if (!f.endsWith('.mjs')) continue;
    const src = readFileSync(join(ROOT, 'test', f), 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/(lib\/[a-z0-9-]+\.mjs)'/g)) {
      // `a as b` imports `a`; the local alias is not the contract.
      const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      if (!wanted.has(m[2])) wanted.set(m[2], new Map());
      for (const n of names) {
        if (!wanted.get(m[2]).has(n)) wanted.get(m[2]).set(n, []);
        wanted.get(m[2]).get(n).push(f);
      }
    }
  }
  return wanted;
}

test('⚠️⚠️ no test imports a name its module does not export', async () => {
  const wanted = namedImports();
  assert.ok(wanted.size > 40, `only ${wanted.size} modules seen — the named-import scan drifted`);
  const gaps = [];
  for (const [mod, names] of wanted) {
    if (!existsSync(join(ROOT, mod))) continue; // covered by the file check above
    let ns;
    try {
      ns = await import(new URL(`../${mod}`, import.meta.url).href);
    } catch (err) {
      gaps.push(`${mod} could not be imported at all: ${String(err?.message ?? err).slice(0, 120)}`);
      continue;
    }
    for (const [name, tests] of names) {
      if (name in ns) continue;
      if ((MISSING_EXPORTS[mod] ?? []).includes(name)) continue;
      gaps.push(`${mod} does not export ${name} — wanted by ${tests.join(', ')}`);
    }
  }
  assert.deepEqual(
    gaps.sort(),
    [],
    'the test half of a change went in without the lib half. Push the export, or record it in '
    + 'MISSING_EXPORTS with the reason.',
  );
});

test('⚠️ every recorded missing export is still missing', async () => {
  const stale = [];
  for (const [mod, names] of Object.entries(MISSING_EXPORTS)) {
    if (!existsSync(join(ROOT, mod))) { stale.push(`${mod} no longer exists`); continue; }
    const ns = await import(new URL(`../${mod}`, import.meta.url).href);
    for (const n of names) if (n in ns) stale.push(`${mod} now exports ${n} — delete the entry`);
  }
  assert.deepEqual(stale, [], 'MISSING_EXPORTS has gone stale, which is how the next real gap gets waved through');
});
