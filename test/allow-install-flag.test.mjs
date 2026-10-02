/**
 * ── ⭐⭐ THE THIRD OPERATOR SWITCH, AND THE ONE THAT HAD NO FLAG ────────────
 *
 * `npm install` has been gated on `ACUVO_ALLOW_INSTALL` since it shipped. The
 * honest charge is NOT that it was undocumented — `README.md` has a whole
 * section on it and `validateNpm`'s refusal has always named the variable. It is
 * that there was no FLAG and no `--help` row, so the only way to learn the
 * escape was to be refused first and read the whole refusal. Measured before
 * this file existed:
 *
 *     node bin/acuvo.mjs --help | grep -ci install   →  the install lines only,
 *                                                       none of them the gate
 *
 * ⭐ SO THE SHAPE IS COPIED FROM `--allow-push` / `--allow-deploy`, deliberately
 * and to the letter: a per-run flag typed by a human, applied to
 * `process.env[ALLOW_INSTALL_ENV]` AFTER `envLoad`, creating no second gate and
 * opening no back door for a cloned repository.
 *
 * ⚠️⚠️ AND THE BOUNDARY DOES NOT MOVE — that is what most of this file asserts.
 * `--allow-install` buys exactly what the variable already bought: `npm install`
 * and `npm ci`, under the same narrowing. `npm exec`, `npm publish`, `npx
 * <anything but vitest/tsc>` and every other ecosystem's installer are refused
 * with the flag on, and a test that only proved the flag WORKS would have missed
 * a change that quietly widened any of them.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseArgv, USAGE, KNOWN_FLAG_SPELLINGS } from '../lib/cli-args.mjs';
import {
  ALLOW_INSTALL_ENV,
  NPX_REFUSAL_WAY_OUT,
  installEnabled,
  validateCommand,
  validateNpmInstallArgv,
} from '../lib/command.mjs';
import { loadEnvFiles, workspaceMaySet } from '../lib/env-file.mjs';
import { planSingleSpawn } from '../lib/spawn-argv.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const help = Array.isArray(USAGE) ? USAGE.join('\n') : String(USAGE);
const opts = (argv) => {
  const p = parseArgv(argv);
  assert.equal(p.ok, true, `parse failed: ${p.error}`);
  return p.options;
};

/* ── (1) the flag exists, parses, and defaults to OFF ──────────────────────── */

test('--allow-install parses as a boolean and defaults to OFF', () => {
  assert.equal(opts(['do the thing']).allowInstall, false);
  const on = opts(['do the thing', '--allow-install']);
  assert.equal(on.allowInstall, true);
  assert.equal(on.task, 'do the thing', 'a boolean flag must not eat the task');
});

test('⚠️ it is a BOOLEAN, not a value flag — the mistake this parser has made twice', () => {
  /**
   * `--no-auto-lease` and `--no-checkpoint` both shipped documented in the
   * README and the help text while answering `Unknown option`, because they were
   * written into the branch that only runs for names in `FLAGS_WITH_VALUES`. The
   * proof is that the NEXT argument survives.
   */
  const p = opts(['--allow-install', 'the actual task']);
  assert.equal(p.allowInstall, true);
  assert.equal(p.task, 'the actual task', 'the flag swallowed its successor — it is in the wrong branch');
});

test('it is declared, completed, documented in --help AND in the reference document', () => {
  assert.ok(KNOWN_FLAG_SPELLINGS.includes('--allow-install'),
    'missing from KNOWN_FLAG_SPELLINGS — typed without dashes it becomes a paid agent run again');
  assert.match(help, /--allow-install/, '--help does not name the flag, which is the entire defect this fixes');
  // ⚠️ THE HELP LINE MUST STATE THE BLAST RADIUS, not the subcommand. "enables
  // npm install" is unweighable; "downloads and runs code from the registry" is
  // the fact a reader decides on.
  assert.match(help, /downloads and runs code from the registry/,
    'the --allow-install line does not say what an install actually does');
  // ⭐ AND IT MUST NAME WHAT STAYS REFUSED. A flag called "allow install" reads
  // as "installs work now", and `npm exec` / `npm publish` / pip / cargo do not.
  assert.match(help, /Still refused with it: npm exec, npm publish/,
    'the help line implies more than the flag buys');
  /**
   * ── ⚠️⚠️ THE DOCUMENT MOVED ON 2026-09-15 AND THIS GUARD DID NOT ──────────
   *
   * `README.md` went from 1,459 lines of caveats to an 84-line front door, and
   * the whole flag-options table moved VERBATIM into `docs/STATUS.md`. The
   * repointing was done in `docs-truth.test.mjs`, which even carries a note
   * saying *"repointing a guard at a moved document is correct; deleting an
   * assertion because the file got shorter is not"* — and TWO other guards that
   * read the same table were missed, so they went red and stayed red.
   *
   * ⭐ The assertion is unchanged, at the address the row now has. The rule this
   * protects is still "a human can find the flag without being refused first",
   * and `--help` (asserted three lines above) is the other half of it.
   */
  const reference = readFileSync(join(here, '..', 'docs', 'STATUS.md'), 'utf8');
  assert.ok(reference.includes('| `--allow-install`'),
    'no options-table row in docs/STATUS.md — the reference document lost the flag');
});

/* ── (2) ⭐ THE FLAG REACHES THE DOOR — not just the parser ────────────────── */

test('⭐ the flag reaches the GATE: the variable it sets is the one the gate reads', () => {
  /**
   * `bin/acuvo.mjs` translates `--allow-install` into
   * `process.env[ALLOW_INSTALL_ENV]`, and `executeRunCommand` reads exactly that
   * — `command.mjs` states the rule: *"THE ENVIRONMENT IS READ EXACTLY ONCE,
   * HERE, AND NOWHERE DEEPER."* So the assertion is that the gate function reads
   * that variable, not that a boolean travelled between two objects.
   */
  assert.equal(installEnabled({ [ALLOW_INSTALL_ENV]: '1' }), true);
  assert.equal(installEnabled({}), false);
});

test('bin/acuvo.mjs sets the variable AFTER envLoad, never before', () => {
  /**
   * ⚠️⚠️ THE ORDER IS THE SECURITY PROPERTY, and it is the same one
   * `allow-push-and-deploy-flags.test.mjs` pins. `env-file.mjs` strips every
   * `ACUVO_` name a workspace `.env.local` declares; applying the operator's
   * flag BEFORE that pass would hand the loader something to delete and the flag
   * would silently do nothing.
   */
  const src = readFileSync(join(here, '..', 'bin', 'acuvo.mjs'), 'utf8');
  const load = src.indexOf('envLoad([root, process.cwd()])');
  const install = src.indexOf(`process.env[ALLOW_INSTALL_ENV] = '1'`);
  assert.ok(load > 0, 'the env loader call moved — re-check this ordering by hand');
  assert.ok(install > 0, 'bin/acuvo.mjs never applies --allow-install, so the flag parses and does nothing');
  assert.ok(install > load, '--allow-install is applied BEFORE envLoad, so the loader can strip it');
});

test('⚠️ a cloned repository still cannot set it — the flag did not open a back door', () => {
  assert.equal(workspaceMaySet(ALLOW_INSTALL_ENV), false,
    'a workspace .env.local may set the install gate — one cloned repo now owns a downloader');
  const env = {};
  const load = () => { env[ALLOW_INSTALL_ENV] = '1'; };
  loadEnvFiles(['/nonexistent-but-the-loader-is-injected'], { load, env });
  assert.equal(ALLOW_INSTALL_ENV in env, false, 'a repo turned installs on');
});

/* ── (3) the gate itself, through BOTH doors ───────────────────────────────── */

test('⭐ both doors agree: refused with the gate off, accepted with it on', () => {
  /**
   * `run_command` reaches install through `validateCommand`; `run_program`
   * through `validateNpmInstallArgv`. A flag that opened one and not the other
   * would be the "second, laxer path" `command.mjs`'s header exists to forbid.
   */
  assert.equal(validateCommand('npm install zod', { allowInstall: false }).ok, false);
  assert.equal(validateCommand('npm install zod', { allowInstall: true }).ok, true);
  assert.equal(validateNpmInstallArgv(['install', 'zod'], { allowInstall: false }).ok, false);
  assert.equal(validateNpmInstallArgv(['install', 'zod'], { allowInstall: true }).ok, true);
});

test('⭐ the refusal names BOTH ways in, flag first', () => {
  const r = validateCommand('npm install zod', { allowInstall: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /--allow-install/,
    'the refusal names only the environment variable — which is how this capability stayed hidden');
  assert.match(r.error, new RegExp(`${ALLOW_INSTALL_ENV}=1`),
    'the variable must stay named too: somebody scripting a CI job cannot type a flag into a container image');
});

/* ── (4) ⚠️⚠️ THE BOUNDARY DID NOT MOVE ───────────────────────────────────── */

test('⚠️ with the flag ON, everything that was refused for a REASON is still refused', () => {
  const on = { allowInstall: true };
  for (const cmd of [
    'npm exec cowsay',      // runs registry code and records nothing
    'npm publish',          // uploads this repository
    'npx prisma migrate dev', // a migration mutates a database rewind cannot restore
    'npx create-react-app x',
    'pip install requests',
    'cargo add serde',
    'bundle install',
  ]) {
    const r = validateCommand(cmd, on);
    assert.equal(r.ok, false, `"${cmd}" was allowed by --allow-install — the boundary moved`);
  }
});

test('⚠️ and the install narrowing survives the flag', () => {
  const on = { allowInstall: true };
  for (const cmd of [
    'npm install https://example.com/x.tgz',
    'npm install file:../evil',
    'npm install zod@npm:evil-package',
    'npm install a b c d e',
  ]) {
    assert.equal(validateCommand(cmd, on).ok, false, `"${cmd}" got past the install shape whitelist`);
  }
});

/* ── (5) the refusal that is NOT gettable, and says so honestly ────────────── */

test('⭐ the npx refusal is actionable, and does NOT invent a switch that cannot enforce itself', () => {
  const r = validateCommand('npx prisma migrate dev', { allowInstall: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /npx runs a package from the registry/);
  // ⭐ It has to say what to DO. The old message stated a rule and stopped, so
  // the reader could only conclude the product cannot do it.
  assert.match(r.error, /--shell/, 'the refusal names no way in at all');
  // ⚠️⚠️ AND IT MUST NOT PROMISE A NARROWER GATE. There is no --allow-migrate,
  // because nothing here can read DATABASE_URL and tell staging from production,
  // and `acuvo rewind` restores FILES only.
  assert.ok(!/--allow-migrate/.test(r.error), 'the refusal advertises a switch that does not exist');
  assert.match(r.error, /restores files only/,
    'the refusal does not say why a migration cannot get a gate of its own');
  assert.ok(NPX_REFUSAL_WAY_OUT.length > 100, 'the shared way-out sentence has been emptied');
});

test('⚠️ BOTH npx doors carry the same way out — one helpful door and one dead end is still a dead end', () => {
  /**
   * ⚠️⚠️ THE FIRST DRAFT OF THIS TEST GREPPED `lib/spawn-argv.mjs` FOR THE
   * CONSTANT'S NAME AND DID NOT BITE. Deleting the interpolation from the
   * refusal left the IMPORT line behind, so the source still contained the
   * string and the guard stayed green while `run_program` answered a migration
   * request with a dead end. A guard that reads the source instead of the door
   * is the failure mode this repo has a memory of; the fix is to call the real
   * planner and read the sentence it actually returns.
   */
  const r = planSingleSpawn({ root: here, program: 'npx', args: ['prisma', 'migrate', 'dev'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /--shell/,
    'run_program\'s npx refusal names no way in, while run_command\'s does — one dead end is still a dead end');
  assert.match(r.error, /restores files only/);
});
