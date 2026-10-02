/**
 * ── ⚠️⭐ FIVE OF SEVEN SUBCOMMANDS WERE INVISIBLE ───────────────────────────
 *
 * MEASURED 2026-09-07 by reading the dispatch in `bin/acuvo.mjs` against the
 * help text: the binary answers `config`, `engines`, `spend`, `verify`, `board`,
 * `rewind` and `leases`. `--help` listed **two**.
 *
 * Every one of the missing five works and prints something a person wants:
 * `acuvo spend` reported a night of real runs at 0.669 cents; `acuvo engines`
 * prices every creative engine from the live account. None could be found
 * without reading the source.
 *
 * ⚠️ This is the command-level half of a defect already measured at the verb
 * level — *"26 of 82 verbs are mentioned nowhere a user looks."* **A capability
 * nobody can find is indistinguishable from one that does not exist.**
 *
 * ⭐ THE GUARD IS DERIVED, NOT LISTED. It reads the dispatch and the help and
 * compares them, so a subcommand added tomorrow fails this test until it is
 * documented. A hand-written list of seven names would pass forever while the
 * eighth went missing — which is exactly how this happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bin = readFileSync(join(here, '..', 'bin', 'acuvo.mjs'), 'utf8');
const help = readFileSync(join(here, '..', 'lib', 'cli-args.mjs'), 'utf8');

/**
 * Every subcommand the binary actually answers.
 *
 * ⚠️⚠️⭐ THIS GUARD WAS NARROWER THAN ITS OWN COMMIT MESSAGE CLAIMED. The first
 * version read only `opts.command === 'x'` and I described it as catching "the
 * eighth subcommand the day it is written". It would not have: `acuvo mcp add`,
 * `mcp list`, `mcp search`, `mcp import`, `mcp install` and `mcp remove` are
 * parsed as WORD PAIRS in the argv loop (`arg === 'mcp' && argv[i + 1] === …`),
 * never touch `opts.command`, and were invisible to it. Six real commands, one
 * blind spot.
 *
 * ⭐ They turned out to be documented — but by somebody's diligence, not by this
 * test, which is the distinction that matters. A census that quietly excludes a
 * whole dispatch SHAPE is the same defect as a hand-written list, one level up.
 */
function dispatched() {
  const byOpts = [...bin.matchAll(/opts\.command === '([a-z-]+)'/g)].map((m) => m[1]);
  const byWord = [...bin.matchAll(/\barg === '([a-z][a-z-]*)'\s*&&\s*argv\[i \+ 1\]/g)].map((m) => m[1]);
  return new Set([...byOpts, ...byWord]);
}

test('the binary still dispatches the commands this guard knows about', () => {
  const cmds = dispatched();
  assert.ok(cmds.size >= 5, `only ${cmds.size} subcommands found — the dispatch shape changed and this guard is now blind`);
});

test('every dispatched subcommand appears in --help', () => {
  /**
   * ⚠️ BUILT FROM `String.raw`, NOT A PLAIN TEMPLATE LITERAL. The first version
   * of this line used `` `^\s*'\s{2}...` `` — and in a template literal `\s` is
   * just `s`, so the pattern read `^s*'s{2}engines`, matched nothing, and
   * reported all seven commands undocumented including the two that always were.
   * A guard that over-reports is still a guard that is not measuring.
   */
  /**
   * ⚠️ TWO SHAPES, BOTH REAL. The `opts.command` family is written bare —
   * `'  engines               …'` — while the word-pair family is written with
   * the binary in front, `'  acuvo mcp list        …'`, because "mcp" alone is
   * not a thing you can type. Accepting only the first form reported `mcp` as
   * undocumented against a help text that documents it six times, which is the
   * instrument being wrong rather than the product. Verified by driving
   * `acuvo --help` before changing anything.
   */
  const helpLine = (c) => new RegExp(String.raw`^\s*'\s\s(?:acuvo )?${c}[ \[]`, 'm');
  const missing = [...dispatched()].filter((c) => !helpLine(c).test(help));
  assert.deepEqual(
    missing,
    [],
    `these subcommands work but --help never mentions them, so nobody can find them: ${missing.join(', ')}`,
  );
});

/**
 * ⚠️ THE HEADING MATTERS AS MUCH AS THE LIST. Someone scanning `--help` for
 * "what else can this do" needs a place to look; five lines buried among forty
 * option flags is only slightly better than absent.
 */
test('the commands have their own heading, not a line among the flags', () => {
  assert.match(help, /'Commands — run instead of a task/, 'the Commands heading is gone');
});
