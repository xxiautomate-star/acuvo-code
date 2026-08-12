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

const README = read('README.md');
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

test('README names the REAL default model', () => {
  const row = optionRow('--model');
  assert.ok(
    row.includes(DEFAULT_MODEL),
    `README's --model row does not name ${DEFAULT_MODEL}. Row: ${row}`,
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

test('the docs do not promise an install route that does not exist', () => {
  /**
   * SHAKEDOWN.md defect #1: the README told strangers to clone a URL that 404s,
   * for a package that is unpublished — so a reader had zero working routes and
   * no way to tell that from a typo of their own. Publishing is the owner's
   * call. Instructing people to do something impossible is not.
   *
   * ⚠️ The URL may still be MENTIONED (it is in package.json's `repository`,
   * and the README explains that it 404s). What it may not be is presented as
   * an instruction — i.e. inside a fenced block as a command to run.
   */
  const fences = README.match(/```[\s\S]*?```/g) ?? [];
  const offenders = fences
    .filter((b) => /git clone\s+https?:\/\/github\.com/.test(b) || /npm (?:i|install)\s+(?:-g\s+)?acuvo/.test(b))
    .map((b) => b.split('\n').find((l) => /git clone|npm i/.test(l))?.trim());
  assert.deepEqual(
    offenders,
    [],
    `README tells the reader to run an install command that cannot work today (the repo 404s and the package is unpublished):\n${offenders.join('\n')}`,
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
  assert.ok(
    ENTERPRISE.includes(String(shipped)),
    `ENTERPRISE.md never states the real shipped-file count (${shipped}). It used to say 18 while shipping ${shipped}.`,
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
