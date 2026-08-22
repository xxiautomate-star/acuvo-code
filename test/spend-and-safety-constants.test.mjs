/**
 * ── ⚠️⚠️ THIRTY CAPS THAT ANY NUMBER SATISFIED ─────────────────────────────
 *
 * An adversarial pass found `MAX_INSTALL_PACKAGES` could go 4 → 400 and
 * `MAX_STEERS` 3 → 10000 with the entire suite green, because every term in
 * their tests was derived from the constant itself — the array length, the
 * slice, the regex, even the test name. Assertions computed the way the code
 * computes them.
 *
 * ⚠️ IT ALSO EXPLAINED WHY FOUR EARLIER MUTATION CAMPAIGNS ALL MISSED IT,
 * INDEPENDENTLY. Each of them mutated the COMPARISON (`if (false && …)`), which
 * deletes the guard's existence and goes red — so the guard looked covered.
 * Nobody mutated the VALUE.
 *
 * ⚠️⚠️ AND A SWEEP OF THIS DIRECTORY FOUND THE SHAPE IS SYSTEMIC, NOT A PAIR:
 * 30 `MAX_*`/`MIN_*` constants are used inside assertions with no literal pin
 * anywhere in their file. Most are display caps where the exact number is a
 * taste decision and pinning it would be churn. THIS FILE PINS THE OTHER KIND —
 * the ones where the number bounds MONEY, a SPAWN, a NETWORK CALL or a BLAST
 * RADIUS, and where "any value passes" means the bound is decorative.
 *
 * ⭐ ONE FILE ON PURPOSE. A pin next to each constant would be fifteen diffs
 * nobody reads together; here, changing any bound in this package produces one
 * line in one place that a reviewer can see and question. The reason column is
 * quoted from each constant's own comment — not invented here — so this file
 * stays a mirror rather than a second opinion.
 *
 * ⚠️ THIS FILE DOES NOT ARGUE THE VALUES ARE RIGHT. It argues they are
 * DECISIONS. Changing one must be deliberate, in a diff, with this line
 * updated — never a silent side effect of a refactor.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { MAX_INSTALL_PACKAGES } from '../lib/command.mjs';
import { MAX_STEERS, MAX_STEER_CHARS } from '../lib/steer.mjs';
import { MIN_ATTEMPTS, MAX_ATTEMPTS } from '../lib/best-of.mjs';
import { MAX_SERVERS } from '../lib/mcp.mjs';
import { MAX_TAKEOVERS, MAX_TTL_MS, MIN_TTL_MS } from '../lib/lease.mjs';
import { MIN_PROJECTION_USD } from '../lib/escalate.mjs';
import { MAX_TIERS } from '../lib/model-tier.mjs';
import { MAX_FILES } from '../lib/write-many.mjs';
import { MAX_LEARNED_ENTRIES, MAX_LEARNED_BYTES } from '../lib/learned.mjs';

/**
 * name → [value, what the number bounds]. The second column answers "what goes
 * wrong if this is 100× bigger", which is the only question that makes a pin
 * worth having.
 */
const BOUNDS = [
  // ── money ──────────────────────────────────────────────────────────────
  [MAX_ATTEMPTS, 5, 'best-of attempts — each one is a whole paid run of the same task'],
  [MIN_ATTEMPTS, 2, 'best-of needs at least two, or "best of" is a word for one run'],
  [MAX_TIERS, 4, 'escalation rungs — a pasted list of ten models would be dead config that reads as if it were working'],
  [MIN_PROJECTION_USD, 0.0005, 'the floor under a rung projection; zero would wave through a rung the budget cannot pay for'],

  // ── what gets fetched, spawned or installed ────────────────────────────
  [MAX_INSTALL_PACKAGES, 4, 'names on one install line — each is an independent typosquat nobody eyeballs in a batch'],
  [MAX_SERVERS, 8, 'MCP servers started from one config, each a real child process'],

  // ── blast radius on disk ───────────────────────────────────────────────
  [MAX_FILES, 60, 'files in one write_many — more than this is a migration, and a migration wants review'],
  [MAX_LEARNED_ENTRIES, 40, 'notes carried between runs; unbounded, this is a file that grows for ever'],
  [MAX_LEARNED_BYTES, 4_000, 'bytes of those notes, for the same reason'],

  // ── what a hijacked file can spend or say ──────────────────────────────
  [MAX_STEERS, 3, 'mid-run redirections; this is the cap on what one rewritten steer file can spend'],
  [MAX_STEER_CHARS, 4000, 'characters of one steer — the file is written by a human in a hurry and a stray cat could fill it'],

  // ── correctness bounds on the lease ────────────────────────────────────
  [MAX_TAKEOVERS, 8, 'takeovers recorded on one lease; a hot path could be taken over for ever'],
  [MAX_TTL_MS, 3_600_000, 'the longest a lease may be held — an hour, after which a dead terminal stops blocking everyone'],
  [MIN_TTL_MS, 1_000, 'the shortest; below a second a healthy holder looks dead to the next renewal'],
];

test('⚠️⚠️ every spend-and-safety bound is the number it is meant to be', () => {
  const wrong = [];
  for (const [actual, expected, why] of BOUNDS) {
    if (actual !== expected) wrong.push(`  expected ${expected}, found ${actual} — ${why}`);
  }
  assert.equal(
    wrong.length, 0,
    'A bound in this package changed. That is allowed — but it is a DECISION, so update the line here and say why '
    + 'in the commit. It is never a side effect of a refactor.\n' + wrong.join('\n'),
  );
});

test('⭐ every entry is a real exported constant, not a literal compared to itself', () => {
  /**
   * ⚠️ THE FAILURE MODE OF THIS VERY FILE. If an import were dropped or
   * renamed, the value would arrive as `undefined` — and a table of
   * `undefined !== 5` would fail loudly, which is fine. But a table where
   * somebody "fixed" a failure by writing the literal into BOTH columns would
   * pass for ever while pinning nothing, which is precisely the defect the file
   * was written to close.
   */
  for (const [actual, expected, why] of BOUNDS) {
    assert.equal(typeof actual, 'number', `not a number — is the import still right? (${why})`);
    assert.ok(Number.isFinite(actual), why);
    assert.equal(typeof expected, 'number', why);
  }
  assert.ok(BOUNDS.length >= 14, `the table shrank to ${BOUNDS.length} — a deleted row is a silently unpinned bound`);
});

test('⚠️ the caps this package spends money through are ORDERED sensibly', () => {
  // A relationship a literal pin cannot express: these are not independent
  // numbers, and an edit that keeps each one "reasonable" can still break the
  // pair. MIN_TTL_MS above MAX_TTL_MS would make every lease unacquirable.
  assert.ok(MIN_ATTEMPTS < MAX_ATTEMPTS, 'best-of floor must sit under its ceiling');
  assert.ok(MIN_TTL_MS < MAX_TTL_MS, 'a lease floor above its ceiling makes every lease impossible');
  assert.ok(MAX_STEERS < MAX_ATTEMPTS * 10, 'steering must stay small relative to a paid run');
});
