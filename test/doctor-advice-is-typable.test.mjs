import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ── ⚠️⚠️ EVERY FLAG THE DOCTOR TELLS YOU TO TYPE MUST EXIST ────────────────
 *
 * It advised "raise the round budget (--rounds N)" in TWO places. There is no
 * `--rounds` flag — it is `--max-rounds` — so `parseArgv` refuses it with
 * "unknown option" and the person is left with a tool that gave advice it then
 * rejected.
 *
 * ⭐ WORSE THAN SAYING NOTHING. The doctor's whole job is to be the one surface
 * you can trust when nothing else works; a fix line that fails turns the last
 * reliable thing into another dead end.
 *
 * ── ⚠️ SCOPED TO THE DOCTOR'S `fix:` LINES, AND THE FIRST VERSION WAS NOT ───
 * My first attempt scanned every string in `lib/` and flagged `--eval`,
 * `--ignore-scripts` and `--always-make` — node's, npm's and make's flags, named
 * legitimately in `command.mjs`'s allowlist. That is a check that fails correct
 * work, which this repo has shipped four times in one day before. A guard is
 * only worth having if the thing it points at is always wrong.
 */
const ROOT = join(import.meta.dirname, '..');

test('⚠️⚠️ every --flag in a doctor fix line can actually be typed', () => {
  const cli = readFileSync(join(ROOT, 'lib', 'cli-args.mjs'), 'utf8')
    + readFileSync(join(ROOT, 'bin', 'acuvo.mjs'), 'utf8');
  const known = new Set([...cli.matchAll(/'(--[a-z][a-z-]*)'/g)].map((m) => m[1]));
  assert.ok(known.size > 15, 'the flag list failed to parse — this test would pass vacuously');

  const doctor = readFileSync(join(ROOT, 'lib', 'doctor.mjs'), 'utf8');
  // Every `fix: '...'` / `fix: "..."` string — the lines we hand a user to type.
  const fixes = [...doctor.matchAll(/fix:\s*(['"`])((?:\.|(?!\1).)*)\1/g)].map((m) => m[2]);
  assert.ok(fixes.length > 5, `expected several fix lines, found ${fixes.length}`);

  const offenders = [];
  for (const fix of fixes) {
    for (const m of fix.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)) {
      if (!known.has(m[1])) offenders.push(`${m[1]}  (in: ${fix.slice(0, 70)})`);
    }
  }
  assert.deepEqual(offenders, [], 'the doctor advises flags the CLI would refuse');
});
