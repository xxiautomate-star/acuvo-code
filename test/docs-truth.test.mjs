/**
 * ── ⭐⭐ THE ONE CLASS OF DEFECT 455 TESTS COULD NOT SEE ──────────────────────
 *
 * On 2026-08-11 an audit of README.md, CHANGELOG.md and ENTERPRISE.md against
 * the source found:
 *
 *   · `--max-rounds` documented as 3. It is 5.
 *   · `--max-tokens` documented as 8000. It is 12000.
 *   · "18 shipped files". There are 41.
 *   · A headline claim — "no other terminal agent can look at its own output" —
 *     that a free plugin disproves in one command.
 *   · Thirty-four `file:line` citations, most of them rotted in under a week.
 *
 * The whole suite was green throughout, and would have stayed green forever,
 * because **a test that reads a constant and a document that states a number
 * never meet.** Every other test in this package asserts something about the
 * code. This one asserts that what we TELL people about the code is true.
 *
 * ── ⚠️ WHY THIS IS NOT "TESTING THE DOCS", WHICH WOULD BE SILLY ─────────────
 * It does not check prose, tone or completeness. It checks exactly three things
 * that are load-bearing and mechanically checkable:
 *
 *   1. Every default the README prints in its options table equals the exported
 *      constant. A user reads that table to decide what to pass.
 *   2. A struck claim stays struck. This one was removed from the README on
 *      2026-08-10 and survived in four other places — deletion in one file is
 *      not deletion, and only a test makes it stick.
 *   3. The documents do not describe a capability that has since been removed
 *      from the code, and do not omit one the code exposes.
 *
 * ── ⚠️ AND THE THING THIS FILE MUST NOT BECOME ──────────────────────────────
 * A doc test that fails when someone improves the writing is a tax, and it will
 * be deleted the first week it fires wrongly. So every assertion here keys off
 * a NUMBER or an IDENTIFIER, never a sentence. Rephrase any paragraph freely;
 * change what a flag defaults to without updating the table, and it goes red.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MAX_ROUNDS, MAX_ROUNDS_LIMIT } from '../lib/cli-args.mjs';
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from '../lib/model.mjs';
import { DEFAULT_COMMAND_TIMEOUT_MS, ALLOWED_BINARIES } from '../lib/command.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * ── ⚠️⚠️ THE DOCUMENT THIS GUARDS MOVED ON 2026-09-15, AND IT STILL GUARDS IT ──
 *
 * `README.md` was 1,459 lines carrying 66 warning markers and a "do not read
 * this page as…" disclaimer — the right content in the wrong place. A front door
 * that leads with its own caveats reads as unfinished to a stranger, so the
 * honest engineering record moved VERBATIM to `docs/STATUS.md` and the README
 * became a front door.
 *
 * ⭐ NOTHING HERE IS WEAKENED. Every assertion below still runs, against the
 * same text, at its new address — the flag-defaults table is in STATUS.md
 * (51 rows, counted). The rule this file exists for is unchanged: a default a
 * READER sees must equal the exported constant. Repointing a guard at a moved
 * document is correct; deleting an assertion because the file got shorter is
 * not, and that is the mistake this note exists to prevent.
 */
const README = read('docs/STATUS.md');
/** ⭐ and the new front door must not silently lose the install line */
const FRONT_DOOR = read('README.md');
const CHANGELOG = read('CHANGELOG.md');
const ENTERPRISE = read('ENTERPRISE.md');
const IMAGEGEN = read('lib/imagegen.mjs');

/**
 * The README states its defaults in a markdown table. Pull the row for a flag
 * and return its cell, so the assertion is against what a reader actually sees
 * rather than against a substring that might live in a paragraph somewhere.
 */
function optionRow(flag) {
  const line = README.split('\n').find((l) => l.startsWith(`| \`${flag}`));
  assert.ok(line, `README.md has no options-table row for ${flag} — if the flag was removed, remove it here too`);
  return line;
}

/** Every integer in a table row, so "1–8" and "Default 5" are both visible. */
function numbersIn(row) {
  return (row.match(/\d[\d,]*/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
}

test('README documents the REAL --max-rounds default and ceiling', () => {
  const row = optionRow('--max-rounds');
  const nums = numbersIn(row);
  assert.ok(
    nums.includes(DEFAULT_MAX_ROUNDS),
    `README's --max-rounds row does not mention the real default ${DEFAULT_MAX_ROUNDS}. Row: ${row}`,
  );
  assert.ok(
    nums.includes(MAX_ROUNDS_LIMIT),
    `README's --max-rounds row does not mention the real ceiling ${MAX_ROUNDS_LIMIT}. Row: ${row}`,
  );
  /**
   * ⚠️ THE TRAP THAT CAUSED THE ORIGINAL BUG, ASSERTED DIRECTLY. There are two
   * constants called DEFAULT_MAX_ROUNDS — lib/turn.mjs (3, the library
   * fallback) and lib/cli-args.mjs (5, what the CLI uses). The docs cited the
   * first and described the second. If they ever converge this assertion is
   * harmless; while they differ, the README must not print the wrong one.
   */
  const turnDefault = 3;
  if (DEFAULT_MAX_ROUNDS !== turnDefault) {
    assert.ok(
      !nums.includes(turnDefault),
      `README's --max-rounds row mentions ${turnDefault} — that is lib/turn.mjs's LIBRARY fallback, not the CLI default (${DEFAULT_MAX_ROUNDS}). This exact confusion is why this test exists. Row: ${row}`,
    );
  }
});

test('README documents the REAL --max-tokens default', () => {
  const row = optionRow('--max-tokens');
  assert.ok(
    numbersIn(row).includes(DEFAULT_MAX_TOKENS),
    `README's --max-tokens row does not mention the real default ${DEFAULT_MAX_TOKENS}. Row: ${row}`,
  );
});

test('README documents the REAL --command-timeout and --timeout defaults', () => {
  const cmd = optionRow('--command-timeout');
  assert.ok(
    numbersIn(cmd).includes(DEFAULT_COMMAND_TIMEOUT_MS / 1000),
    `README's --command-timeout row does not mention ${DEFAULT_COMMAND_TIMEOUT_MS / 1000}s. Row: ${cmd}`,
  );
  const t = optionRow('--timeout');
  assert.ok(
    numbersIn(t).includes(DEFAULT_TIMEOUT_MS / 1000),
    `README's --timeout row does not mention ${DEFAULT_TIMEOUT_MS / 1000}s. Row: ${t}`,
  );
});

/**
 * ── ⚠️⚠️ INVERTED 2026-08-26. THIS REQUIRED THE VENDOR MODEL ID IN THE README ─
 *
 * It asserted the `--model` row contains `DEFAULT_MODEL` — the raw upstream id.
 * The intent was right and worth keeping in spirit: a README that names a
 * default which is not the default is a lie a reader cannot check.
 *
 * ⭐ BUT THE README IS SHIPPED IN THE NPM TARBALL AND RENDERED ON THE PACKAGE
 * PAGE, which is the surface someone reads while deciding whether to subscribe.
 * Roman: *"we don't want to sound unprofessional nor advertise our business
 * mechanics — we might as well say: don't pay for us, just pay directly to
 * these guys!!!"* An outside reader already reached that exact conclusion once,
 * in writing, from the website's install block.
 *
 * ⭐ THE HONESTY REQUIREMENT SURVIVES, RE-AIMED AT OUR OWN NAMES. The row must
 * still name the real default — `acuvo-flash` — and `acuvo-models.mjs` is the
 * one mapping from that name to whatever we route to, so the README stays
 * checkable without publishing the supply chain. The mapping itself is already
 * pinned by `labelForModelId` tests.
 *
 * ⚠️ A raw upstream id still PARSES, so no existing script breaks. It is simply
 * not the spelling these docs use.
 */
test('README names the real default model by ITS ACUVO NAME, never the vendor id', () => {
  const row = optionRow('--model');
  assert.ok(
    /acuvo-flash/.test(row),
    `README's --model row does not name the default (acuvo-flash). Row: ${row}`,
  );
  assert.ok(
    !row.includes(DEFAULT_MODEL),
    `README's --model row publishes the upstream id ${DEFAULT_MODEL}. The README ships in the npm `
    + 'tarball and renders on the package page — use the Acuvo name.',
  );
});

test('README lists exactly the binaries the command layer allows', () => {
  /**
   * ⚠️ Scoped to the "What it can execute" section on purpose. `node` appears
   * all over this README in shell examples, so a whole-file search would pass
   * on a section that had been emptied.
   */
  const start = README.indexOf('## What it can execute');
  assert.ok(start > -1, 'README lost its "What it can execute" section — that section is the security disclosure');
  const section = README.slice(start, README.indexOf('\n## ', start + 10));
  for (const bin of ALLOWED_BINARIES) {
    assert.ok(
      section.includes(`\`${bin}\``),
      `ALLOWED_BINARIES contains "${bin}" and the README's execution section never names it. A program a user cannot see in the docs is a program they did not agree to.`,
    );
  }
});

/**
 * ── ⚠️⚠️ THE STRUCK CLAIM ───────────────────────────────────────────────────
 *
 * "Every other terminal agent is blind to its own output" was removed from the
 * README on 2026-08-10 after a market sweep proved it false — Playwright MCP
 * and Chrome DevTools MCP are free and one install away. It then survived in
 * CHANGELOG.md, ENTERPRISE.md (twice) and lib/imagegen.mjs, because deleting a
 * sentence from one file is not deleting a claim.
 *
 * ⭐ The defensible version is the RETURN VALUE: 89 tokens of measured verdict
 * against 3,072 for a screenshot. That claim survives a customer typing
 * `claude mcp add playwright`, which is the only test a marketing claim has to
 * pass.
 */
const FALSE_UNIQUENESS = [
  /no other (?:terminal|coding) agent can/i,
  /the two jobs no other/i,
  /the thing no other coding agent can do/i,
  /every other terminal (?:coding )?agent is\s+blind/i,
  /cannot do this at any price/i,
];

for (const [label, text] of [
  ['README.md', README],
  ['CHANGELOG.md', CHANGELOG],
  ['ENTERPRISE.md', ENTERPRISE],
  ['lib/imagegen.mjs', IMAGEGEN],
]) {
  test(`${label} does not re-assert the struck "nobody else can see" claim`, () => {
    /**
     * ⚠️ The documents are ALLOWED to quote the struck claim while explaining
     * that it was struck — that is the honest record and deleting it would hide
     * the correction. So a match only fails if the same line does not also mark
     * it as false/struck.
     */
    const lines = text.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
      if (!FALSE_UNIQUENESS.some((rx) => rx.test(line))) return;
      const context = lines.slice(Math.max(0, i - 3), i + 4).join(' ');
      const disowned = /\b(false|struck|used to|no longer|was wrong|previously|corrected|disprov)/i.test(context);
      if (!disowned) offenders.push(`${label}:${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(
      offenders,
      [],
      `A claim struck on 2026-08-10 as FALSE has come back:\n${offenders.join('\n')}\n\nPlaywright MCP and Chrome DevTools MCP are free and one install away. Say "89 tokens of measured verdict against 3,072 for a screenshot" instead — that one survives a demo.`,
    );
  });
}

test('the README installs the package that is ACTUALLY published', () => {
  /**
   * ── ⚠️⚠️ THIS GUARD OUTLIVED ITS OWN PREMISE, AND IT COST US THE FRONT DOOR
   *
   * It was written for SHAKEDOWN.md defect #1: the README told strangers to
   * clone a URL that 404'd, for a package that was unpublished. Correct then.
   *
   * ⭐ BOTH FACTS STOPPED BEING TRUE. Verified 2026-08-27:
   *     registry.npmjs.org/acuvo-code   → 0.6.17, published 2026-08-23
   *     github.com/xxiautomate-star/acuvo-code → 200, public
   *
   * ⚠️ So the guard was banning a WORKING install command from the README, and
   * the README duly had none — the single most important line for a stranger,
   * absent, enforced by a test that was green. **A guard that pins a fact which
   * has since changed is worse than no guard**, because it is trusted.
   *
   * ⭐ IT IS NOT DELETED. It is INVERTED to the claim that is true now and still
   * worth protecting: the README must install the name that exists. The old
   * failure mode — telling people to install something that 404s — is caught by
   * checking the name against `package.json` rather than banning the command.
   *
   * ⚠️ `acuvo` (unscoped) is NOT ours — the registry 404s for it. CLAUDE.md
   * still says "npm `acuvo`" and is wrong; the published name is `acuvo-code`.
   */
  const pkgName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;
  const fences = README.match(/```[\s\S]*?```/g) ?? [];
  /**
   * ⚠️ ONLY LINES THAT INSTALL *OUR* PACKAGE. The first version of this checked
   * every `npm i` in the file and went red on
   * `npm i -g @modelcontextprotocol/server-filesystem` — a correct example of
   * installing somebody ELSE's MCP server. A guard that fails on legitimate
   * documentation is a guard people delete.
   */
  const installs = fences
    .flatMap((b) => b.split('\n'))
    .filter((l) => /npm (?:i|install)\s+(?:-g\s+)?(?:@?acuvo|\S*\bacuvo\b)/i.test(l))
    .map((l) => l.trim());

  assert.ok(
    installs.length > 0,
    'The README has no command installing this package in a fenced block. A stranger cannot run '
    + 'a package they are not told how to install, and it is the first thing anybody looks for.',
  );

  const wrong = installs.filter((l) => !l.includes(pkgName));
  assert.deepEqual(
    wrong,
    [],
    `The README installs a package name that is not the one this repo publishes ("${pkgName}"):\n`
    + `${wrong.join('\n')}\nThe unscoped name "acuvo" is NOT ours — registry.npmjs.org/acuvo 404s.`,
  );
});

test('every in-package file ENTERPRISE.md cites actually exists', () => {
  /**
   * The citations were converted from `file:line` to `file` + symbol because
   * line numbers rotted within a week. A file path can still rot — a module
   * gets renamed and the citation silently points at nothing. This catches
   * that half; nothing can catch a symbol rename except reading it.
   */
  const cited = new Set(
    (ENTERPRISE.match(/`((?:lib|bin|test)\/[\w.-]+\.mjs)`/g) ?? [])
      .map((m) => m.replace(/`/g, '')),
  );
  assert.ok(cited.size > 10, `expected ENTERPRISE.md to cite many modules, found ${cited.size} — did the citation format change?`);
  const missing = [...cited].filter((rel) => !existsSync(join(ROOT, rel)));
  assert.deepEqual(missing, [], `ENTERPRISE.md cites files that do not exist: ${missing.join(', ')}`);
});

test('ENTERPRISE.md states the real shipped-file count', () => {
  /**
   * It said 18 for months; there are 41. The number is quoted at reviewers as
   * "the entire auditable surface", so being wrong about it is the kind of
   * thing that costs a reviewer's trust in everything around it.
   */
  const shipped =
    readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs')).length +
    readdirSync(join(ROOT, 'bin')).filter((f) => f.endsWith('.mjs')).length;
  /**
   * ⚠️⚠️ ANCHORED TO THE WORD "files", NOT A BARE `includes`.
   *
   * `ENTERPRISE.includes(String(shipped))` is what this used to be, and on
   * 2026-08-13 it was caught passing on a document that said **66 files while
   * 68 shipped** — because `68` appeared on line 9 inside the unrelated
   * citation `lib/command.mjs:68`. The build-failing count was being satisfied
   * by a LINE NUMBER.
   *
   * ⭐ The failure mode is worth naming because it is not rare: a substring
   * test over a long document will eventually match something by coincidence,
   * and the longer the document grows the likelier that is. Every digit in
   * every file path, line number, dollar figure and date is a chance to pass
   * for the wrong reason. Bind the number to the noun it counts.
   */
  assert.match(
    ENTERPRISE,
    new RegExp(`\\b${shipped}\\s+files\\b`),
    `ENTERPRISE.md does not say "${shipped} files" — the real shipped count of lib/*.mjs + bin/*.mjs. `
    + 'A bare substring match once let this pass on a line number while the sentence was wrong by two.',
  );
  /**
   * ⚠️ Same allowance as the struck-claim test, and it caught this file out on
   * its first run: the document is ALLOWED to quote the wrong number while
   * saying it was wrong. Forbidding the quote would force us to hide the
   * correction, which is the opposite of what this whole test file is for.
   */
  const lines = ENTERPRISE.split('\n');
  const asserted = lines.filter((line, i) => {
    if (!/\b18 shipped files\b/.test(line)) return false;
    const context = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
    return !/\b(said|used to|was|stale|out of date|no longer|corrected)\b/i.test(context);
  });
  assert.deepEqual(
    asserted,
    [],
    `ENTERPRISE.md asserts "18 shipped files" as current; there are ${shipped}.`,
  );
});

test('⚠️⚠️ ENTERPRISE.md states the real shipped LINE count too — the half that kept slipping', () => {
  /**
   * ── ⚠️⚠️ THE GUARD ABOVE ONLY EVER CHECKED FILES ───────────────────────────
   *
   * ENTERPRISE.md says, in as many words, that `test/docs-truth.test.mjs`
   * "fails the build if this number drifts" — and it only ever failed on the
   * FILE count. So "41 files" was caught within a day while "about 19,700
   * lines" sat wrong for four days (the real figure had reached 52,931) and
   * "49,578 lines" for one, inside the paragraph whose entire purpose is to
   * tell a reviewer these numbers are checked. Found by an adversarial pass.
   *
   * ⭐ A TOLERANCE, AND IT IS NOT LAZINESS. The file count changes only when a
   * module lands; a line count changes on almost every commit, so an exact pin
   * would go red constantly and become a nag — and a nag is a guard people
   * learn to edit rather than read (this repo's own argument, made twice about
   * consent prompts). 2% of ~53,000 is ~1,000 lines: two or three substantial
   * modules of drift before anyone is asked to look.
   *
   * ⚠️ AND IT IS ANCHORED TO THE WORD "lines", for the same reason the count
   * above is anchored to "files": on 2026-08-13 a bare substring match passed
   * on a document saying 66 files while 68 shipped, because `68` appeared in
   * the citation `lib/command.mjs:68`. A build-failing number satisfied by a
   * line number is not a guard.
   */
  const countLines = (dir) => readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.mjs'))
    .reduce((n, f) => n + readFileSync(join(ROOT, dir, f), 'utf8').split('\n').length - 1, 0);
  const real = countLines('lib') + countLines('bin');

  const quoted = [...ENTERPRISE.matchAll(/\b([0-9][0-9,]{2,})\s+lines\b/g)]
    .map((m) => Number(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
  assert.ok(quoted.length > 0, 'ENTERPRISE.md no longer quotes a line count at all — say the number or drop the claim');

  const TOLERANCE = 0.02;
  const off = quoted.filter((n) => Math.abs(n - real) / real > TOLERANCE);
  /**
   * ⚠️ Same allowance the file-count test needs: the document is ALLOWED to
   * quote a superseded figure while SAYING it was superseded. Forbidding that
   * would force the corrections to be deleted, which is the opposite of what
   * this file is for.
   */
  const lines = ENTERPRISE.split('\n');
  const stillAsserted = off.filter((n) => lines.some((line, i) => {
    if (!new RegExp(`\\b${n.toLocaleString('en-US')}\\s+lines\\b|\\b${n}\\s+lines\\b`).test(line)) return false;
    const context = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
    return !/\b(said|used to|was|stale|sat wrong|out of date|no longer|corrected|superseded)\b/i.test(context);
  }));

  assert.deepEqual(
    stillAsserted, [],
    `ENTERPRISE.md asserts a line count more than ${TOLERANCE * 100}% from the real ${real.toLocaleString('en-US')} `
    + `(lib/*.mjs + bin/*.mjs). Update the figure, or mark the old one as superseded in the sentence around it.`,
  );
});

test('`evaluate` is disclosed as an execution path wherever execution is described', () => {
  /**
   * ⚠️ THE OMISSION THIS TEST EXISTS FOR. The README's "What it can execute"
   * section said "four programs, and nothing else" and listed the command
   * whitelist — while `evaluate` (lib/evaluate.mjs) stages a model-written
   * snippet and spawns node on it WITHOUT passing through validateCommand at
   * all. It is bounded in other ways and it is not a new capability, but a
   * security section that enumerates execution paths has to enumerate it.
   */
  const start = README.indexOf('## What it can execute');
  const section = README.slice(start, README.indexOf('\n## ', start + 10));
  assert.ok(
    /\bevaluate\b/.test(section),
    'README\'s execution section never mentions `evaluate`, which runs model-written JavaScript without going through the command whitelist.',
  );
  assert.ok(
    /\bevaluate\b/.test(ENTERPRISE),
    'ENTERPRISE.md never mentions `evaluate` — §2.1 claims the model cannot pick a program, and this is the path that argument does not cover.',
  );
});

test('the audit log is documented as shipped, and its real directory is named', () => {
  /**
   * ENTERPRISE.md §2.2 item 4 read "No audit log … nothing is persisted" and
   * listed it as an enterprise blocker. It ships now. This asserts the doc
   * moved WITH the code — and, more usefully, that it names the real path, so
   * a compliance reader is not sent to a directory that does not exist.
   */
  const audit = join(ROOT, 'lib/audit.mjs');
  assert.ok(existsSync(audit), 'lib/audit.mjs is gone but the docs describe an audit log');
  const dir = readFileSync(audit, 'utf8').match(/AUDIT_DIR\s*=\s*'([^']+)'/)?.[1];
  assert.ok(dir, 'could not read AUDIT_DIR out of lib/audit.mjs');
  for (const [label, text] of [['README.md', README], ['ENTERPRISE.md', ENTERPRISE], ['CHANGELOG.md', CHANGELOG]]) {
    assert.ok(
      text.includes(dir),
      `${label} describes the audit log but never names its real location (${dir}).`,
    );
  }
  assert.ok(
    !/\*\*No audit log\.\*\*/.test(ENTERPRISE),
    'ENTERPRISE.md still lists "No audit log" as a gap, but lib/audit.mjs ships and writes one.',
  );
});

// ── ⭐⭐ A FLAG THAT NOBODY DOCUMENTED IS A FLAG NOBODY CAN USE ─────────────

test('every flag the parser accepts has a row in the README options table', () => {
  /**
   * ⚠️ MEASURED 2026-08-12: three of twenty-one flags — `--best-of`, `--shell`
   * and `--max-tier` — appeared NOWHERE in README.md. Two of them had shipped
   * days earlier. `--shell` in particular changes what the tool is allowed to
   * execute, so the undocumented one was also the most consequential.
   *
   * The tests above check that documented DEFAULTS are true. Nothing checked
   * that a flag was documented at all, so the drift was silent and permanent —
   * `acuvo --help` knew, and the file people actually read did not.
   *
   * ⭐ DERIVED FROM THE PARSER, never a typed-out list, so a flag added tomorrow
   * fails this test until somebody writes the row.
   */
  const source = read('lib/cli-args.mjs');
  const flags = [...new Set([...source.matchAll(/arg === '(--[a-z-]+)'/g)].map((m) => m[1]))];

  assert.ok(flags.length >= 15, `only found ${flags.length} flags — the regex has rotted`);

  const undocumented = flags.filter((f) => !README.includes(`| \`${f}`));
  assert.deepEqual(
    undocumented,
    [],
    `these flags have no README options-table row: ${undocumented.join(', ')}. `
      + 'Add a row, or remove the flag — a flag only --help knows about is one nobody finds.',
  );
});

test('the README does not promise flags the parser has never heard of', () => {
  /**
   * ⚠️ The other direction, and the more embarrassing one: documentation for a
   * flag that does not exist sends the reader to an error message.
   *
   * ⚠️ BOTH SOURCES, AND FINDING OUT WHY WAS THE POINT. This first checked only
   * `cli-args.mjs` and flagged six REAL flags as invented — `--sessions`,
   * `--resume`, `--continue`, `--no-session`, `--no-audit`, `--replay` — because
   * they are parsed in `bin/acuvo.mjs` instead. The CLI's surface is defined in
   * two files, which is worth knowing and is exactly the sort of thing a
   * documentation test discovers.
   */
  const sources = read('lib/cli-args.mjs') + read('bin/acuvo.mjs');
  const rows = [...README.matchAll(/^\| `(--[a-z-]+)/gm)].map((m) => m[1]);
  const invented = [...new Set(rows)].filter((f) => !sources.includes(`'${f}'`));
  assert.deepEqual(invented, [], `the README documents flags the parser does not accept: ${invented.join(', ')}`);
});

test('the README states the real size of the tool registry', async () => {
  /**
   * ⚠️ It said 36 while shipping 45 — and the sentence around it invites the
   * reader to "count it yourself", which is the worst place to be wrong. Same
   * reasoning as the ENTERPRISE.md file-count test: a number quoted at a
   * sceptical reader has to survive them checking it.
   *
   * ⚠️ It also named `TOOL_NAMES`, which is not what holds them. A citation that
   * does not resolve is a second wrong fact in the same sentence.
   */
  const { TOOL_SCHEMAS } = await import('../lib/tools.mjs');
  assert.ok(
    README.includes(`**${TOOL_SCHEMAS.length} tools**`),
    `README does not state the real registry size (${TOOL_SCHEMAS.length}).`,
  );
  assert.ok(README.includes('`TOOL_SCHEMAS`'), 'and it must cite the export that actually holds them');
});

test('⭐⭐ the caching claim is split into the half we control and the half we measured', (t) => {
  /**
   * ⚠️⚠️ SKIPS WHEN MVP-PLAN.md IS NOT ON DISK, AND THAT IS NOT LAZINESS.
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
  if (!existsSync(join(ROOT, 'MVP-PLAN.md'))) return t.skip('MVP-PLAN.md is a repo-only working note and is not in the published tarball');

  /**
   * ⚠️ THE DEFECT THIS PINS, MEASURED 2026-08-14. The README told a buyer "the
   * unchanged prompt prefix caches at ~97%", and MVP-PLAN.md shipped
   * "97.2% measured, 4.3× cut" as a ✅ row. Neither number is produced by any
   * artefact in this repository. The only in-repo measurement is the three-call
   * probe in `test/turn-cache-and-prefix.test.mjs` — prompt=3616, cached=3072,
   * which is 84.9% and "3.05× cheaper". Real 4-round CLI runs the same day came
   * in at 46.7% and 48.6% unpinned.
   *
   * ⚠️⚠️ AND THE TWO NUMBERS ARE DIFFERENT CLAIMS, which is why quoting one
   * figure was always going to be wrong. ~97% is a property of the BYTES WE SEND
   * (prefix stability — ours, asserted, true). The hit rate is what the PROVIDER
   * reports, and it is decided by which of 28 upstream endpoints served the
   * round. Selling the first as if it were the second is the caching equivalent
   * of reporting `booked` as `won`.
   *
   * ⚠️ KEYED OFF NUMBERS AND IDENTIFIERS, per this file's own rule — rephrase
   * the prose freely; put the unsourced 97.2% back and it goes red.
   */
  const MVP = readFileSync(join(ROOT, 'MVP-PLAN.md'), 'utf8');

  for (const [name, text] of [['README.md', README], ['MVP-PLAN.md', MVP]]) {
    assert.ok(
      !/97\.2%|caches at ~97%/.test(text),
      `${name} still quotes the unsourced 97.2% / ~97% cache figure. No artefact in this repo produces it; `
        + 'the measured pair is prefix stability (asserted, 100% between consecutive rounds) and a '
        + 'provider-reported hit rate of 46.7–95.8% depending on routing.',
    );
    assert.ok(
      text.includes('46.7'),
      `${name} must state the measured hit-rate floor (46.7%, 2026-08-14) next to any caching claim, `
        + 'so the reader sees what routing costs rather than only the best case.',
    );
  }

  // ⭐ And the README has to name the lever, since it is the difference between
  // the two numbers and it is off by default.
  assert.ok(README.includes('ACUVO_PROVIDER_ORDER'), 'the README must name the variable that moves the hit rate');
});

// ── ⭐⭐⭐ THE CLASS THIS FILE COULD NOT SEE: A NUMBER STATED IN PROSE ────────

/**
 * ── ⚠️⚠️ EVERY NUMERIC ASSERTION ABOVE PARSES THE README'S OPTIONS TABLE ────
 *
 * MEASURED 2026-08-29. `ENTERPRISE.md` said **"5 rounds, ceiling 16"** in §1.4,
 * §4.2 and §5.2 while the real constants were `DEFAULT_MAX_ROUNDS` 24 /
 * `MAX_ROUNDS_LIMIT` 64 / `MAX_ROUNDS_LIMIT_BUDGETED` 1000 — stale by two
 * revisions. Worse, §3.8, the section whose entire subject is the 2026-08-11
 * "the docs said 3, it is 5" correction, still asserted "it is 5" in the
 * present tense. **This file was green throughout**, because `optionRow()`
 * reads a markdown TABLE and `ENTERPRISE.md` is read only to check that the
 * files it cites exist. Nothing in the package read a number out of a sentence.
 *
 * ── ⚠️ THE SHAPE, WHICH IS THE ONLY REASON THIS IS NOT A TAX ────────────────
 * The lazy version — flag every number near every constant — is deleted the
 * first week it fires wrongly, and this file's own header says so. So the
 * binding is deliberately narrow, and each rule below is here because the loose
 * version produced a false positive that is named with it:
 *
 *   1. **Clause, not paragraph.** "`MAX_ROUNDS_LIMIT` = 64, `lib/cli-args.mjs`;
 *      `DEFAULT_COMMAND_TIMEOUT_MS` + output caps" is ONE table cell and TWO
 *      claims. A paragraph-wide window read the 64 as a claim about the timeout.
 *   2. **The cited module resolves an ambiguous name.** Nineteen exported names
 *      exist twice with different values — `DEFAULT_BUDGET_TOKENS` is 24,000 in
 *      `compact.mjs` and 9,000 in `repo-map.mjs`. When the clause names the
 *      file, only that file's value counts, and that is what caught the README.
 *   3. **A released CHANGELOG section is frozen.** "The round ceiling is 16,
 *      raised from 8" is the true record of a shipped release and rewriting it
 *      would be the lie. `## [Unreleased]` is not frozen.
 *   4. **Citations are not values.** ``clampOutput` `:1506`` and
 *      `lib/command.mjs:1654` are line numbers; dates, `§` refs and semver are
 *      not values either. A build-failing number satisfied by a LINE NUMBER is
 *      the exact defect the shipped-file test above already records.
 *
 * ⭐ THE ESCAPE IS THE TRUTH, NOT A COMMENT. A clause may quote any number of
 * superseded figures as long as it also states the real one — which is what
 * §5.2 does today ("previously said 3, then 8, then 5") and why it is green.
 * There is no prose allow-list to game.
 *
 * ⚠️ WHAT IT STILL CANNOT SEE, said plainly rather than pretended away: prose
 * that binds a number to a MODULE rather than to the constant name — §3.8's
 * "one in `lib/turn.mjs` (value 3 …) and one in `lib/cli-args.mjs` (value 5 …)"
 * passes, because 3 is a real value of that name and the clause states it.
 * Catching that needs a parser for English, not one for numbers.
 *
 * VERIFIED TO BITE: run against `git show 47a23fc5e^:acuvo-code/ENTERPRISE.md`
 * it reports 4 wrong claims, at §1.4, §4.2 and §5.2 — all three stale lines —
 * and 0 against the file as it stands.
 */

/** Every `export const NAME = <number>` in lib/ and bin/: name -> module -> value. */
function exportedNumericConstants() {
  const byName = new Map();
  for (const dir of ['lib', 'bin']) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (!f.endsWith('.mjs')) continue;
      const src = readFileSync(join(ROOT, dir, f), 'utf8');
      for (const m of src.matchAll(/^export const ([A-Z][A-Z0-9_]{2,}) = (-?\d[\d_]*(?:\.\d+)?(?:e-?\d+)?);/gm)) {
        const value = Number(m[2].replace(/_/g, ''));
        if (!Number.isFinite(value)) continue;
        if (!byName.has(m[1])) byName.set(m[1], new Map());
        byName.get(m[1]).set(`${dir}/${f}`, value);
      }
    }
  }
  return byName;
}

/**
 * ⚠️ A DOC MAY LEGITIMATELY RESCALE A CONSTANT. `DEFAULT_COMMAND_TIMEOUT_MS` is
 * 120,000 and every sentence about it says "120s" — demanding the raw literal
 * would fail correct writing, which is the failure mode this file fears most.
 */
function acceptableRenderings(value) {
  const out = new Set([value]);
  if (value % 1000 === 0) out.add(value / 1000);        // ms -> s, 400_000 -> "400k"
  if (value % 60000 === 0) out.add(value / 60000);      // ms -> minutes
  if (value % 1024 === 0) out.add(value / 1024);        // bytes -> KiB
  if (value > 0 && value < 1) out.add(value * 100);     // a fraction -> a percentage
  return out;
}

/** Numbers a sentence ASSERTS — never a citation, a date, a § ref or a version. */
function assertedNumbers(text) {
  return [...text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/§\s?\d+(?:\.\d+)*/g, ' ')
    .replace(/`:\d+(?:-\d+)?`/g, ' ')
    .replace(/\.(?:mjs|ts|tsx|js|json|md|sh|py):\d+(?:-\d+)?/g, ' ')
    .replace(/\bv?\d+\.\d+\.\d+\b/g, ' ')
    .matchAll(/\b(\d[\d,_]*(?:\.\d+)?)\b/g)]
    .map((m) => Number(m[1].replace(/[,_]/g, '')))
    .filter(Number.isFinite);
}

/**
 * Split into the units English binds a number inside: a table cell, a
 * semicolon-separated item, a sentence, a list entry. A parenthetical citation
 * — "(`DEFAULT_MAX_ROUNDS`, `lib/cli-args.mjs`)" — stays inside the clause it
 * annotates, which is the whole point.
 */
const CLAUSE_BREAK = /\||;\s|(?<=[a-z)\]`*_,])[.!?](?:\*\*)?\s+(?=[A-Z`*(⭐⚠])|\n\s*(?=[-*+]\s|\d+\.\s)/;

function clausesOf(text) {
  const out = [];
  let at = 0;
  for (const para of text.split(/\n\s*\n/)) {
    let inner = 0;
    for (const c of para.split(CLAUSE_BREAK)) {
      if (c === undefined) continue;
      out.push({ text: c, offset: at + inner });
      inner += c.length + 1;
    }
    at += para.length + 2;
  }
  return out;
}

/** Byte ranges of a CHANGELOG's released sections — a historical record. */
function frozenRanges(doc, text) {
  if (doc !== 'CHANGELOG.md') return [];
  const heads = [...text.matchAll(/^## \[([^\]]+)\]/gm)];
  return heads
    .map((h, i) => (/unreleased/i.test(h[1]) ? null : [h.index, heads[i + 1]?.index ?? text.length]))
    .filter(Boolean);
}

function proseNumberClaims(doc, text, constants, nameRx) {
  const frozen = frozenRanges(doc, text);
  const claims = [];
  for (const clause of clausesOf(text)) {
    if (frozen.some(([a, b]) => clause.offset >= a && clause.offset < b)) continue;
    const named = new Set([...clause.text.matchAll(nameRx)].map((m) => m[1]));
    if (named.size === 0) continue;
    const stated = new Set(assertedNumbers(clause.text));
    if (stated.size === 0) continue;
    for (const name of named) {
      const byModule = constants.get(name);
      const cited = [...byModule.keys()].filter((m) => clause.text.includes(m));
      const values = cited.length > 0 ? cited.map((m) => byModule.get(m)) : [...byModule.values()];
      const ok = new Set();
      for (const v of values) for (const r of acceptableRenderings(v)) ok.add(r);
      claims.push({
        doc,
        name,
        values,
        cited,
        satisfied: [...ok].some((r) => stated.has(r)),
        line: text.slice(0, clause.offset).split('\n').length,
        stated: [...stated],
        clause: clause.text.replace(/\s+/g, ' ').trim().slice(0, 180),
      });
    }
  }
  return claims;
}

test('⭐⭐⭐ every number the prose docs state about an exported constant is the real one', () => {
  const constants = exportedNumericConstants();
  assert.ok(constants.size > 200, `only ${constants.size} exported numeric constants found — the regex has rotted`);
  const nameRx = new RegExp(`(?<![A-Za-z0-9_])(${[...constants.keys()].join('|')})(?![A-Za-z0-9_])`, 'g');

  /**
   * ⚠️ `readdirSync`, NOT A TYPED LIST — so it is tarball-safe by construction.
   * The published package ships four of these (README, CHANGELOG, ENTERPRISE,
   * ROADMAP) and the repo has more; a reviewer running `npm test` against the
   * tarball sees fewer files, never a red test whose subject is absent. Same
   * rule the caching test above states in longhand.
   */
  const docs = readdirSync(ROOT).filter((f) => f.endsWith('.md'));
  assert.ok(docs.includes('README.md') && docs.includes('ENTERPRISE.md'), `the docs are missing: ${docs.join(', ')}`);

  const claims = docs.flatMap((doc) => proseNumberClaims(doc, read(doc), constants, nameRx));
  /**
   * ⚠️ A POPULATION FLOOR, BECAUSE THE EXPENSIVE FAILURE HERE IS SILENCE. If
   * the clause splitter or the name regex rots, every claim disappears and the
   * assertion below passes on an empty list forever — the "guard that passes
   * while checking nothing" this repo has found five times in one day.
   */
  assert.ok(
    claims.length >= 10,
    `only ${claims.length} numeric claims found across ${docs.length} documents — the binder has rotted `
    + 'and this test would now pass by finding nothing. It found 30 on 2026-08-29.',
  );

  const wrong = claims.filter((c) => !c.satisfied);
  assert.deepEqual(
    wrong.map((c) => `${c.doc}:~${c.line} states ${c.stated.join('/')} for ${c.name}`
      + ` (really ${c.values.join(' or ')}${c.cited.length ? ` in ${c.cited.join(', ')}` : ''}) — "${c.clause}"`),
    [],
    'A document states a number for an exported constant that the code does not agree with. Either the '
    + 'sentence is stale, or it quotes a superseded figure without also stating the current one — state '
    + 'both, the way ENTERPRISE.md §5.2 does, and this passes.',
  );
});

/**
 * ── ⚠️⚠️⚠️ A CORRECTION THAT DOES NOT DELETE THE THING IT CORRECTS ─────────
 *
 * Found 2026-09-10, in **two documents at once**, and no test above could see
 * it. `README.md` carried, on consecutive lines:
 *
 *     The registry holds **84 tools** (`TOOL_SCHEMAS`, `lib/tools.mjs` — count it yourself, and
 *     The registry holds **85 tools** (`TOOL_SCHEMAS`, `lib/tools.mjs` — count it yourself, and
 *
 * and `ENTERPRISE.md` carried two "the package ships **N files**" sentences the
 * same way — 172 immediately above 173. Somebody inserted the corrected sentence
 * and never deleted the old one. Both counts were then ALSO wrong (87 and 174),
 * so the freshness tests above fired and this shape was repaired as a side
 * effect rather than as itself.
 *
 * ⭐ IT IS ITS OWN DEFECT AND IT SURVIVES A CORRECT NUMBER. Fix one twin and the
 * document reads "**87 tools**" above "**85 tools**": every freshness assertion
 * in this file passes, and the page still cannot be quoted, because a reader has
 * no way to tell which line is live. Only the SHAPE catches that.
 *
 * ⚠️ NARROW ON PURPOSE — adjacent lines, both carrying a digit, identical once
 * every number is masked, and long enough that coincidence is implausible. A
 * markdown table of numbered rows differs in its prose and does not match.
 * Measured across all four shipped documents: it finds nothing today, and it
 * finds both twins when either is put back.
 */
test('⚠️⚠️ no document carries the SAME sentence twice with two different numbers', () => {
  const MIN_MASKED_LENGTH = 25;
  const mask = (line) => line.replace(/[0-9][0-9,.]*/g, '#').trim();
  const twins = [];
  for (const doc of ['README.md', 'ENTERPRISE.md', 'CHANGELOG.md', 'ROADMAP.md']) {
    const lines = read(doc).split('\n').map((l) => l.replace(/\r$/, ''));
    for (let i = 1; i < lines.length; i += 1) {
      const a = lines[i - 1];
      const b = lines[i];
      if (a === b) continue;                              // an exact repeat is not this defect
      if (!/[0-9]/.test(a) || !/[0-9]/.test(b)) continue; // the defect is about a NUMBER that moved
      const masked = mask(a);
      if (masked.length < MIN_MASKED_LENGTH || masked !== mask(b)) continue;
      twins.push(`${doc}:${i} — "${a.trim().slice(0, 80)}" / "${b.trim().slice(0, 80)}"`);
    }
  }
  assert.deepEqual(
    twins, [],
    'Two adjacent lines say the same sentence with different numbers. One of them is a correction that '
    + 'was inserted without deleting what it corrected — delete the stale one, or say in the prose which '
    + 'is superseded, so a reader can tell them apart.',
  );
});

/**
 * ── ⚠️⚠️ THE README STATES A TEST-FILE COUNT, SO IT GETS THE SAME TREATMENT ─
 * AS EVERY OTHER NUMBER ON THE PAGE.
 *
 * It said **455**, then **1,378 tests across 61 files**, and by 2026-09-10 the real
 * figures were 5,690 across 383 — quadrupled underneath a sentence in the section
 * whose entire job is to tell a reviewer what running the suite will show them.
 * Nothing in this file could see it: the guards above bind the TOOL registry and
 * the SHIPPED file/line counts, and the test corpus is neither.
 *
 * ⭐ THE FILE COUNT IS PINNED AND THE TEST TOTAL IS NOT, and the split is the whole
 * design. A file lands when somebody adds one — rarely, deliberately, and worth a
 * one-word edit. A test total moves on almost every commit, and an exact pin on it
 * is a check that fails correct work, which this repo has paid for repeatedly.
 *
 * ⚠️ ANCHORED TO THE WORD "files", never a bare substring — the same reason the two
 * ENTERPRISE guards are: a build-failing number satisfied by a line number inside a
 * citation is not a guard, and that has happened in this file once already.
 */
test('⚠️⚠️ the README states the real number of TEST FILES', () => {
  const realFiles = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).length;
  assert.match(
    README,
    new RegExp('\\b' + realFiles + '\\s+files\\b'),
    'README.md does not say "' + realFiles + ' files" — the real count of test/*.test.mjs. The Tests '
    + 'section has now been wrong twice (455, then "1,378 tests across 61 files"), each time for weeks, '
    + 'in the paragraph that tells a reviewer what to expect when they run it.',
  );
});

/**
 * ── ⭐ THE FRONT DOOR MUST STAY A FRONT DOOR ────────────────────────────────
 *
 * Roman, 2026-09-15: make it read *"exactly how a billion dollar company would
 * do it."* Every winner in this niche has the same shape — one promise, one
 * install line, a few features, links — and the failure mode is a README that
 * grows back into an engineering log one honest caveat at a time. This is the
 * ratchet against that.
 */
test('README is a front door, not a status report', () => {
  /** ⚠️ counted without a newline escape on purpose — four have been eaten by a
   *  shell heredoc in this session alone; `split(/\r?\n/)` needs none. */
  const lines = FRONT_DOOR.split(/\r?\n/).length;
  assert.ok(lines < 200, `README is ${lines} lines — the caveats belong in docs/STATUS.md`);
  assert.ok(/npm i -g acuvo-code/.test(FRONT_DOOR), 'the install line is gone from the front door');
  assert.ok(/docs\/STATUS\.md/.test(FRONT_DOOR), 'the front door no longer links the honest record');

  const warnings = (FRONT_DOOR.match(/⚠|⛔/g) || []).length;
  assert.ok(warnings <= 2, `${warnings} warning markers on the front door — move them to docs/STATUS.md`);
});
