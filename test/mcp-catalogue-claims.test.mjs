/**
 * ── ⭐⭐ THE CLAIMS, BOUND TO THE THINGS THEY ARE CLAIMS ABOUT ───────────────
 *
 * Two different failures live in this file, and they are the same failure.
 *
 * 1. **The catalogue can lie about a package.** `lib/mcp-defaults.mjs` names npm
 *    packages that users are told to globally install. It already shipped one
 *    that was a stranger's dependency-confusion canary (`mcp-server-git`,
 *    removed 2026-08-14), and its header now states a rule about dist-tags —
 *    while claiming, in the same sentence, "AND IT IS NOW A TEST".
 *
 *    ⚠️⚠️ THERE WAS NO SUCH TEST. Checked 2026-08-14: `grep -n "latest"
 *    test/mcp-defaults.test.mjs` returned nothing. The sentence asserting the
 *    rule was enforced was the ONLY thing enforcing it. That is the same shape
 *    as every other defect this repo keeps finding — a guard that exists as
 *    prose — and it is why this file exists. It is a test now.
 *
 * 2. **A document can lie about a count.** `NEXT.md` said "66 lib modules, 96
 *    test files" while 78 and 121 were on disk. Nothing broke, so nobody looked.
 *
 * ── ⚠️⚠️ HOW THESE ASSERTIONS ARE WRITTEN, AND WHY IT IS NOT THE OBVIOUS WAY ─
 *
 * This repo has a scar: a build-failing guard was **satisfied by a line
 * number**. It looked for "66 files", 68 shipped, and it passed anyway because
 * the string "68" appeared inside `lib/command.mjs:68`. A bare number search
 * over a document will eventually match a version, a year, a port or a line
 * reference, and then the guard is decoration.
 *
 * ⭐ SO EVERY ASSERTION BELOW BINDS THE NUMBER TO ITS NOUN — the regexes capture
 * `(\d+) lib modules`, not `\d+` — and then compares the captured value to a
 * FRESHLY MEASURED one. A number that drifts fails; a number that appears
 * somewhere else in the file cannot satisfy it.
 *
 * ⚠️ AND THESE ARE ASSERTIONS OVER PARSED VALUES, NOT OVER PROSE. `BACKLOG.md`
 * explicitly rejects regexes over English ("a machine for turning correct work
 * red") and that rejection is right. The difference: a count next to its noun is
 * a DATUM that has exactly one correct value, and the failure message below
 * prints both numbers and the file, so the fix is mechanical rather than
 * interpretive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { CATALOGUE, catalogueEntry, packageOf } from '../lib/mcp-defaults.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/* ───────────────────── 1. THE CATALOGUE'S PACKAGE CLAIMS ────────────────── */

/**
 * ⚠️ THE DIST-TAG BUG IS SILENT AND PERMANENT, which is why it earns a test
 * rather than a comment. `packageOf` is the KEY looked up in the `installed`
 * Set, and an installed package is recorded under its bare NAME. Every MCP
 * README in the world writes `@playwright/mcp@latest`, so the moment someone
 * pastes one in, `assessEntry` looks up `"@playwright/mcp@latest"`, never finds
 * it, and reports a perfectly working, globally installed server as **dark
 * forever** — with a "fix" telling the user to install what they already have.
 *
 * ⭐ A check that can never pass is exactly as useless as one that can never
 * fail, and this repo has now shipped one of each.
 */
test('⭐⭐ no catalogue entry carries a dist-tag — a tagged spec is dark forever', () => {
  for (const e of CATALOGUE) {
    for (const arg of e.args) {
      if (arg.startsWith('-')) continue;
      /**
       * ⚠️ `lastIndexOf`, NOT `indexOf`. A scoped package BEGINS with `@`, so
       * looking for the first one flags every scoped package as tagged. The
       * tag, if any, is after the LAST `@` — and only when that `@` is not at
       * position 0.
       */
      const at = arg.lastIndexOf('@');
      assert.equal(
        at > 0,
        false,
        `"${e.name}" names the package spec "${arg}", which carries a dist-tag. `
        + `packageOf() would return "${arg.slice(0, at)}" as the lookup key against an `
        + `installed package recorded as "${arg.slice(0, at)}" — but the spec npx runs `
        + `differs, and this entry can never be reported installed. Drop the tag.`,
      );
    }
  }
});

test('every entry that needs a download resolves to a package name we can look up', () => {
  for (const e of CATALOGUE) {
    if (!e.needsDownload) continue;
    const pkg = packageOf(e);
    assert.ok(pkg, `"${e.name}" needs a download but packageOf() found no package in its args`);
    /**
     * ⚠️ THE INSTALL LINE AND THE SPAWNED PACKAGE MUST BE THE SAME PACKAGE.
     * They are written in two different fields by hand, so they can disagree —
     * and the symptom would be an install command that "succeeds" and leaves
     * the entry dark, which reads to a user as our precheck being broken.
     */
    assert.ok(
      e.install.includes(pkg),
      `"${e.name}" spawns ${pkg} but its install line (${e.install}) never mentions it — `
      + `following that line would not make this entry live.`,
    );
  }
});

/**
 * ⭐ THE INVERSE OF THE EXISTING `/NOT RUN/` ASSERTION, and the pair is what
 * makes `verified` mean anything. That test proves an UNVERIFIED entry admits it.
 * This one proves a VERIFIED entry is not still carrying the note it had while
 * it was inert — which is exactly the state `playwright` was in for one day, and
 * exactly what a careless promotion leaves behind.
 */
test('⭐ a verified entry does not still say it was never run', () => {
  for (const e of CATALOGUE) {
    if (!e.verified) continue;
    assert.ok(
      !/NOT RUN/.test(e.note),
      `"${e.name}" is marked verified but its note still says NOT RUN — `
      + `it was promoted without rewriting what actually happened.`,
    );
  }
});

/**
 * ⚠️ A NAME THAT `readMcpConfig` REJECTS POISONS THE WHOLE CONFIG, not just its
 * own entry: the reader returns `{ok:false}` for the FILE. So one bad catalogue
 * name added here would make the rendered starter config unreadable in full.
 */
test('every catalogue name is unique and survives readMcpConfig\'s name rule', () => {
  const seen = new Set();
  for (const e of CATALOGUE) {
    assert.equal(seen.has(e.name), false, `"${e.name}" appears twice — the second would shadow the first`);
    seen.add(e.name);
    assert.match(
      e.name,
      /^[a-z0-9][a-z0-9_-]{0,30}$/i,
      `"${e.name}" is not a name readMcpConfig will accept, and one bad name rejects the entire file`,
    );
  }
});

/**
 * ⭐ THE ENTRY THIS EXPANSION WAS FOR. Browser automation was the single
 * capability nothing in the 49-tool registry could reach — nothing can click or
 * fill a live page — and `docs` is the one addition that needs no credential at
 * all. Both were connected and CALLED through the real client before being
 * written down; this pins them so a later edit cannot quietly drop either.
 */
test('⭐ the verified integration surface is present and opt-in', () => {
  for (const name of ['browser', 'playwright', 'docs']) {
    const e = catalogueEntry(name);
    assert.ok(e, `the "${name}" entry is gone — it was verified by running it, not by assuming it`);
    assert.equal(e.verified, true, `"${name}" was demoted to unverified without a note explaining it`);
    /**
     * ⚠️ NOT A DEFAULT, AND THIS IS THE LOAD-BEARING HALF. Each needs a
     * download, and `mcp.mjs` injects `--no` to npx, so an enabled-by-default
     * download entry is a GUARANTEED 20-second stall before the user's first
     * prompt. Rule 1 is not bent for the capabilities we most want.
     */
    assert.equal(e.enabledByDefault, false, `"${name}" needs a download, so enabling it by default buys a 20s stall`);
    assert.equal(e.needsDownload, true);
  }
  // ⭐ docs is the no-signup one; that is why it was chosen over Notion/Supabase.
  assert.deepEqual(catalogueEntry('docs').credentials, [], 'docs earned its slot by needing no account — a credential here changes the argument');
});

/* ───────────────────── 2. THE DOCUMENTS' COUNT CLAIMS ───────────────────── */

/**
 * ── ⚠️⚠️ THE ASSERTION I WROTE FIRST, WHY IT WENT RED, AND WHY IT IS GONE ────
 *
 * The obvious guard was: parse `(\d+) lib modules` out of NEXT.md and compare it
 * to `readdirSync`. It was written, it ran, and it CORRECTLY caught the live
 * defect — NEXT.md claimed 66 modules and 96 test files while 78 and 121 were on
 * disk.
 *
 * ⚠️ THEN IT WENT RED AGAIN TWENTY MINUTES LATER, AT 124 TEST FILES, because two
 * other agents working this same checkout added test files. The guard would have
 * failed **their correct work**, and forced every agent in every lane to edit a
 * planning document to land an unrelated test.
 *
 * ⭐ A CHECK THAT FAILS CORRECT WORK IS WORSE THAN NO CHECK — this repo has paid
 * for that four times — so the defect class is closed from the other side: the
 * counts were REMOVED from NEXT.md, and this asserts they do not come back. It
 * can only fail if somebody re-introduces a hardcoded, fast-drifting inventory
 * count, which is the actual defect.
 *
 * ⭐ THE DISTINCTION THAT DECIDES WHICH GUARD TO WRITE: bind a number to its noun
 * when the noun has ONE owner and changes rarely — the README's tool count is
 * bound to `TOOL_NAMES.length` below and passes. When the noun is a shared,
 * fast-drifting inventory, do not state the number at all; publish the command.
 */
test('⭐⭐ NEXT.md does not re-introduce a hardcoded inventory count', (t) => {
  /**
   * ⚠️⚠️ SKIPS WHEN NEXT.md IS NOT ON DISK, AND THAT IS NOT LAZINESS.
   *
   * `package.json` ships `test/` deliberately (commit ed08f2710, "ship the
   * tests, and add CI that would have caught the false green") so a reviewer can
   * run them against the code they installed — ENTERPRISE.md now says so out
   * loud. But the tarball does NOT carry the repo-only working notes this test
   * reads.
   *
   * MEASURED 2026-08-15: repo `npm test` = 0 failures; `npm install` of the
   * tarball then `npm test` = 3 failures, all of them tests whose SUBJECT was
   * not shipped. A reviewer taking us up on "run them yourself" met a red suite
   * on a perfectly healthy build — which discredits the 2,500 tests that were
   * telling the truth. 43 other tests here already skip when their subject is
   * absent; these now follow the pattern instead of being the exception.
   */
  if (!existsSync(join(ROOT, 'NEXT.md'))) return t.skip('NEXT.md is a repo-only working note and is not in the published tarball');
  const next = read('NEXT.md');

  /**
   * ⚠️ ANCHORED ON THE NOUN, NOT ON A BARE NUMBER. This repo shipped a guard
   * that passed because the number it hunted for appeared inside a
   * `lib/command.mjs:68` line reference — "66 files" was satisfied by a line
   * number while 68 files shipped. `(\d[\d,]*)\s+lib modules` can only be
   * satisfied by a number actually claiming to count lib modules.
   *
   * ⚠️ CODE BLOCKS AND THE EXPLANATION ARE STRIPPED FIRST. The document now
   * teaches this lesson, so it necessarily QUOTES the old wrong numbers ("said
   * 66 and 96") and shows the `ls lib/*.mjs | wc -l` recipe. A guard that
   * cannot tell a documented mistake from a live claim would make the file
   * unable to explain itself — the same "regex over English" trap BACKLOG.md
   * rejects. Only prose outside the fenced blocks and outside the blockquote
   * postmortem is treated as a live claim.
   */
  const live = next
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('>') && !l.trimStart().startsWith('#'))
    .join('\n')
    .replace(/```[\s\S]*?```/g, '');

  for (const noun of ['lib modules', 'test files']) {
    const m = new RegExp(String.raw`(\d[\d,]*)\s+${noun}`).exec(live);
    assert.equal(
      m,
      null,
      `NEXT.md states "${m?.[0]}" as a live claim. That count drifts every time any of the `
      + `three concurrent lanes adds a file, so it WILL go stale — it already did, at 66 and 96. `
      + `Publish the command that measures it instead, or move the number into the postmortem `
      + `blockquote where it is labelled as history.`,
    );
  }
});

/**
 * ⭐ THE TOOL COUNT IS THE NUMBER A BUYER REPEATS, so it is the one that must
 * never be typed from memory. It is bound here to `TOOL_NAMES.length` — the
 * registry itself — rather than to another document.
 */
test('⭐ the README\'s tool-registry count equals the registry', () => {
  const readme = read('README.md');
  const m = /The registry holds \*\*(\d+) tools\*\*/.exec(readme);
  assert.ok(m, 'README lost its "The registry holds **N tools**" sentence — that is the count everything else is checked against');
  assert.equal(
    Number(m[1]),
    TOOL_NAMES.length,
    `README says the registry holds ${m[1]} tools; TOOL_NAMES.length is ${TOOL_NAMES.length}.`,
  );
});
