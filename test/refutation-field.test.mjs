/**
 * ── ⚠️⚠️ `--refute` WAS A SILENT NO-OP UNDER `--json` ───────────────────────
 *
 * `secondOpinion` was called THIRTY LINES BELOW the `if (opts.json)` early
 * return, so `--json --refute` accepted the flag, charged nothing, ran no
 * refutation, and left NO field in the document to say it had been skipped.
 * Found independently by three dogfood agents and confirmed by source read.
 *
 * ⚠️ THAT IS THE EXACT COMBINATION CI USES — `--json` to parse, `--refute` for
 * the trust gate. So the one mode where nobody is watching the terminal was the
 * one that dropped the check, and a script acted on the unchecked claim.
 *
 * These pin the SHAPE, because the shape is where the defect can come back: a
 * consumer that cannot tell "skipped" from "passed" has the original bug again,
 * one layer down.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { refutationField } from '../lib/refute.mjs';

test('⭐ not asked for is its own state, and says nothing about a verdict', () => {
  const f = refutationField(false, null);
  assert.deepEqual(f, { asked: false, ran: false });
  // ⚠️ The absence of `refuted` is deliberate: a `refuted: false` here would
  // read as "we checked and it held", which is precisely the lie.
  assert.ok(!('refuted' in f));
  assert.ok(!('ok' in f));
});

test('⚠️⚠️ asked-but-skipped is NOT the same as asked-and-passed', () => {
  const skipped = refutationField(true, null, true);
  assert.equal(skipped.asked, true);
  assert.equal(skipped.ran, false);
  assert.match(skipped.reason, /already failed/);
  assert.ok(!('refuted' in skipped), 'a skipped check must not report a verdict');
});

test('⭐ a clean refutation carries the real fields refuteClaim returns', () => {
  /**
   * ⚠️ MY FIRST VERSION EMITTED `verdict: opinion.verdict`, WHICH DOES NOT
   * EXIST on that result — so the document carried a permanent `null`
   * describing nothing, and a consumer could reasonably have keyed off it.
   * Inventing a field name is the same defect as inventing a constant, and it
   * was one grep away from being right.
   */
  const f = refutationField(true, {
    ok: true, refuted: false, reason: 'ran npm test which exited 0',
    costUsd: 0.00064, roundsUsed: 3,
  });
  assert.equal(f.ran, true);
  assert.equal(f.ok, true);
  assert.equal(f.refuted, false);
  assert.equal(f.reason, 'ran npm test which exited 0');
  assert.equal(f.costUsd, 0.00064);
  assert.equal(f.roundsUsed, 3);
});

test('⚠️⚠️ UNCLEAR is its own state — silence is not clearance', () => {
  /**
   * Measured in dogfooding: the refuter fails to produce a parseable verdict in
   * roughly one run of three. You pay for a second full agent run and get
   * nothing back. Flattening that into `refuted: false` would let a gate read
   * "the refuter said nothing" as "the refuter cleared it".
   */
  const f = refutationField(true, {
    ok: true, refuted: false, unclear: true,
    note: 'the refuter did not end with a verdict line, so its answer decides nothing',
    costUsd: 0.001, roundsUsed: 4,
  });
  assert.equal(f.unclear, true);
  assert.equal(f.refuted, false);
  assert.match(f.reason, /decides nothing/, 'the note must survive as the reason');
});

test('⚠️ a CRASHED refuter reports ok:false, never a clean bill of health', () => {
  const f = refutationField(true, { ok: false, error: 'the second opinion crashed: boom', costUsd: 0 });
  assert.equal(f.ok, false);
  assert.equal(f.refuted, false);
  assert.match(f.reason, /crashed/);
});

test('⭐ a real refutation is unambiguous', () => {
  const f = refutationField(true, { ok: true, refuted: true, reason: 'the test asserts nothing', costUsd: 0.0009, roundsUsed: 2 });
  assert.equal(f.refuted, true);
  assert.equal(f.ok, true);
});

test('⚠️ missing numbers are null, never 0 — an unknown cost is not a free one', () => {
  const f = refutationField(true, { ok: true, refuted: false });
  assert.equal(f.costUsd, null);
  assert.equal(f.roundsUsed, null);
});
