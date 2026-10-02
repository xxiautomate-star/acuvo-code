/**
 * ── ⭐⭐ THE TWO BUILT, TESTED, UNREACHABLE VERBS ───────────────────────────
 *
 * `git_push` and `vercel_preview` are complete and correct, and both are
 * withheld unless an operator names them — `ACUVO_ALLOW_PUSH=1` /
 * `ACUVO_ALLOW_DEPLOY=1`, each checked at the OFFER and again at the DISPATCHER.
 * Until now those variables appeared in no `--help` and no options table, so two
 * shipped capabilities were reachable only by someone who had read the source.
 *
 * ⚠️ THE ANSWER IS NOT "TURN THEM ON BY DEFAULT", AND THIS FILE PINS THE
 * NUMBER THAT SAYS WHY. The offer is re-sent on every round of every run, so
 * default-on is a permanent tax on 100% of runs to make two IRREVERSIBLE verbs
 * available — a push is visible to people who are not at this keyboard, a deploy
 * spends a paid build the instant it lands, and across the 139-run bench corpus
 * neither was called once.
 *
 * ⭐ So the gate shape is PER RUN, TYPED BY A HUMAN: discoverable in `--help`,
 * free on every run that does not pass it, and — unlike the environment
 * variable alone — impossible for a cloned repository to set.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseArgv, USAGE, KNOWN_FLAG_SPELLINGS } from '../lib/cli-args.mjs';
import { toolNamesForRounds, toolSchemasFor, executeToolCall } from '../lib/tools.mjs';
import { ALLOW_PUSH_ENV, gitPushToolNames } from '../lib/git.mjs';
import { ALLOW_DEPLOY_ENV, vercelToolNames } from '../lib/vercel.mjs';
import { loadEnvFiles } from '../lib/env-file.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const opts = (argv) => {
  const p = parseArgv(argv);
  assert.equal(p.ok, true, `parse failed: ${p.error}`);
  return p.options;
};

/* ── (1) the flags exist, parse, and default to OFF ───────────────────────── */

test('--allow-push and --allow-deploy parse as booleans and default to OFF', () => {
  const off = opts(['do the thing']);
  assert.equal(off.allowPush, false);
  assert.equal(off.allowDeploy, false);

  const on = opts(['do the thing', '--allow-push', '--allow-deploy']);
  assert.equal(on.allowPush, true);
  assert.equal(on.allowDeploy, true);
  assert.equal(on.task, 'do the thing', 'a boolean flag must not eat the task');
});

test('⚠️ they are BOOLEANS, not value flags — the mistake this parser has made before', () => {
  /**
   * `--no-auto-lease` and `--no-checkpoint` both shipped documented in the
   * README and the help text while answering `Unknown option`, because they
   * were written into the branch that only runs for names in
   * `FLAGS_WITH_VALUES`. The proof is that the NEXT argument survives.
   */
  const p = opts(['--allow-push', 'the actual task']);
  assert.equal(p.allowPush, true);
  assert.equal(p.task, 'the actual task', 'the flag swallowed its successor — it is in the wrong branch');
});

test('both are declared, documented, and named in --help', () => {
  assert.ok(KNOWN_FLAG_SPELLINGS.includes('--allow-push'));
  assert.ok(KNOWN_FLAG_SPELLINGS.includes('--allow-deploy'));
  const help = Array.isArray(USAGE) ? USAGE.join('\n') : String(USAGE);
  assert.match(help, /--allow-push/);
  assert.match(help, /--allow-deploy/);
  // ⚠️ THE HELP MUST NAME THE BLAST RADIUS. "enables git_push" is unweighable.
  assert.match(help, /cannot be undone|not at this keyboard/, 'the push line does not say what a push costs you');
  assert.match(help, /paid build/, 'the deploy line does not say a deploy spends money');
});

/* ── (2) ⭐ THE MEASUREMENT THAT DECIDES THE DEFAULT ───────────────────────── */

test('⭐ MEASURED: offering both costs 4%+ of the tool block, on EVERY round of EVERY run', () => {
  const names = (env) => toolNamesForRounds(20, { allowRun: true, env, root: process.cwd() });
  const bytes = (n) => Buffer.byteLength(JSON.stringify(toolSchemasFor(n)), 'utf8');

  const base = bytes(names({}));
  const push = bytes(names({ [ALLOW_PUSH_ENV]: '1' })) - base;
  const deploy = bytes(names({ [ALLOW_DEPLOY_ENV]: '1' })) - base;

  console.log(
    `\n  [offer] base ${base.toLocaleString()} B`
    + ` · +git_push ${push.toLocaleString()} B`
    + ` · +vercel_preview ${deploy.toLocaleString()} B`
    + ` · both = ${(100 * (push + deploy) / base).toFixed(1)}% of the block, re-sent every round\n`,
  );

  assert.ok(push > 500, `git_push should cost real bytes, measured ${push}`);
  assert.ok(deploy > 500, `vercel_preview should cost real bytes, measured ${deploy}`);
  /**
   * ⚠️ THE POINT OF THIS ASSERTION IS THE COMMENT IT FORCES SOMEONE TO READ.
   * The brief that produced this file asserted flipping these flags "costs ZERO
   * bytes". It does not: the schema is free only while the tool is NOT OFFERED.
   * If this ever fails because the schemas shrank, re-measure before concluding
   * the trade has changed.
   */
  assert.ok(push + deploy > 0.03 * base,
    `both together were ${(100 * (push + deploy) / base).toFixed(1)}% of the offer — re-derive the default if this is now negligible`);
});

test('⚠️ and they cost EXACTLY NOTHING while off — the reason the default is off, not the reason it is on', () => {
  const names = (env) => toolNamesForRounds(20, { allowRun: true, env, root: process.cwd() });
  const off = names({});
  assert.ok(!off.includes('git_push'), 'git_push is offered on a bare machine');
  assert.ok(!off.includes('vercel_preview'), 'vercel_preview is offered on a bare machine');
});

/* ── (3) ⭐ THE FLAG REACHES THE OFFER — not just the parser ───────────────── */

test('⭐ the flag reaches the OFFER: setting the variable is what the offer reads', () => {
  /**
   * `bin/acuvo.mjs` translates `--allow-push` into `process.env[ALLOW_PUSH_ENV]`
   * AFTER `envLoad`, so no second gate is created. This asserts the thing the
   * flag actually does — that the offer functions read exactly that variable —
   * rather than asserting a boolean travelled between two objects.
   */
  assert.deepEqual(gitPushToolNames({ [ALLOW_PUSH_ENV]: '1' }, { allowRun: true }), ['git_push']);
  assert.deepEqual(gitPushToolNames({}, { allowRun: true }), []);
  assert.deepEqual(vercelToolNames({ [ALLOW_DEPLOY_ENV]: '1' }, { allowRun: true }), ['vercel_preview']);
  assert.deepEqual(vercelToolNames({}, { allowRun: true }), []);

  // ⚠️ AND `--no-run` STILL WINS. Two gates, and the stricter one holds.
  assert.deepEqual(gitPushToolNames({ [ALLOW_PUSH_ENV]: '1' }, { allowRun: false }), []);
  assert.deepEqual(vercelToolNames({ [ALLOW_DEPLOY_ENV]: '1' }, { allowRun: false }), []);
});

test('bin/acuvo.mjs sets the variable AFTER envLoad, never before', () => {
  /**
   * ⚠️⚠️ THE ORDER IS THE SECURITY PROPERTY. `env-file.mjs` strips these names
   * when a workspace `.env.local` sets them — one file in a cloned repo used to
   * flip every switch we have. Setting the operator's flag BEFORE that pass
   * would hand the loader something to strip and the flag would silently do
   * nothing; setting it after makes the rule literal: a repository may never
   * widen, an operator may, and the operator speaks last.
   */
  const src = readFileSync(join(here, '..', 'bin', 'acuvo.mjs'), 'utf8');
  const load = src.indexOf('envLoad([root, process.cwd()])');
  const push = src.indexOf(`process.env[ALLOW_PUSH_ENV] = '1'`);
  const deploy = src.indexOf(`process.env[ALLOW_DEPLOY_ENV] = '1'`);
  assert.ok(load > 0, 'the env loader call moved — re-check this ordering by hand');
  assert.ok(push > load, 'the --allow-push flag is applied BEFORE envLoad, so the loader can strip it');
  assert.ok(deploy > load, 'the --allow-deploy flag is applied BEFORE envLoad, so the loader can strip it');
});

test('⚠️ a cloned repository still cannot set either one — the flag did not open a back door', () => {
  const env = {};
  const load = () => { env[ALLOW_PUSH_ENV] = '1'; env[ALLOW_DEPLOY_ENV] = '1'; };
  loadEnvFiles(['/nonexistent-but-the-loader-is-injected'], { load, env });
  assert.equal(ALLOW_PUSH_ENV in env, false, 'a repo turned pushing on');
  assert.equal(ALLOW_DEPLOY_ENV in env, false, 'a repo turned deploying on');
});

/* ── (4) the dispatcher still refuses, and says how to change that ─────────── */

test('⚠️ the DISPATCHER refuses a push the offer never made, and names the way in', async () => {
  /**
   * A model can emit a call for a tool it was never shown — a resumed session,
   * a provider echoing a stale list. `no-run-holds-at-dispatcher.test.mjs`
   * records what a gate that lives only in the offer is worth.
   */
  const r = await executeToolCall(
    { id: '1', function: { name: 'git_push', arguments: '{}' } },
    { root: here, env: {} },
    { allowRun: true },
  );
  assert.equal(r.result.ok, false, 'a push went through with the gate off');
  assert.match(r.result.error, new RegExp(ALLOW_PUSH_ENV), 'the refusal does not name the way to enable it');
});
