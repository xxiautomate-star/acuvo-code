/**
 * ── ⭐⭐ THE AGENT COULD START FROM AN ISSUE AND COULD NOT PARTICIPATE ────────
 *
 * MEASURED 2026-08-15, before this file existed:
 *
 *     node --input-type=module -e "import {TOOL_NAMES} from './lib/tools.mjs';
 *       console.log(TOOL_NAMES.filter(n => /git|hub|pr|issue/.test(n)).join(', '))"
 *     -> git_status, git_diff, git_log, git_commit, git_branch, git_push
 *
 * Six git verbs and zero GitHub verbs, on a machine where `gh` v2.90.0 is
 * installed AND authenticated. `acuvo --issue 42` reads one issue at startup and
 * that is the whole surface: mid-run the model could not list issues, read a
 * pull request, read a review comment, or find out why CI was red.
 *
 * ── ⚠️ WHAT THIS FILE IS CAREFUL ABOUT ──────────────────────────────────────
 * · NOTHING here touches the network, spawns gh, or needs a credential. The
 *   planner is pure and every impure edge (`resolveOnPath`, `spawn`, `env`) is
 *   injected — otherwise the only honest test is "if gh happens to exist here",
 *   which passes for the wrong reason on the author's laptop and gets deleted
 *   the first week it fires in CI. (`github.mjs:findToken` states the same rule.)
 * · Roughly half the file asserts what must remain UNREACHABLE. A read-only
 *   GitHub surface that can be talked into `pr merge` is worse than none.
 * · ⭐ And the other half asserts that ORDINARY LEGITIMATE USAGE STILL WORKS —
 *   every verb, every filter, a search query full of colons and quotes, a small
 *   payload that must NOT be flagged truncated. See
 *   `feedback_checks_that_fail_correct_work`: a guard that fails correct work is
 *   worse than no guard.
 *
 * ⚠️ HONEST GAP, STATED RATHER THAN HIDDEN: no test in here proves that gh
 * itself accepts these arguments. The argv words and every `--json` field name
 * were verified by hand against gh 2.90.0 (`gh <cmd> --json zzz` prints the
 * available fields), and one end-to-end read was run manually against a public
 * repository. A committed test that shells out to the real gh would be a network
 * test that fails in CI for reasons unrelated to this code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  planGh, runGh, executeGh, resolveGh, ghEnvironment, ghToolNames, ghToolSchemas,
  classifyGhFailure, capJsonPayload, capTextPayload,
  validateRepo, validateNumber, validateLimit, validateLogin, validateLabel, validateSearch,
  GH_NOUNS, GH_ENV_KEEP, MAX_GH_LIMIT, DEFAULT_GH_LIMIT, MAX_GH_OUTPUT_CHARS, MAX_RUN_ID,
  RUN_STATUSES,
} from '../lib/gh.mjs';

/** Every (noun, action) pair the module claims to support. */
const EVERY_VERB = Object.entries(GH_NOUNS).flatMap(([noun, actions]) => actions.map((a) => [noun, a]));

/** Parameters that make each verb plan successfully. */
const MINIMAL = {
  'issue.list': {}, 'issue.view': { number: 42 }, 'issue.comments': { number: 42 },
  'pr.list': {}, 'pr.view': { number: 7 }, 'pr.comments': { number: 7 },
  'pr.diff': { number: 7 }, 'pr.checks': { number: 7 },
  'run.list': {}, 'run.view': { runId: 991 }, 'run.failed': { runId: 991 },
};

const planAll = () => EVERY_VERB.map(([noun, action]) => {
  const p = planGh(noun, { action, ...MINIMAL[`${noun}.${action}`] });
  assert.equal(p.ok, true, `${noun}.${action} must plan: ${p.error}`);
  return p;
});

/** A fake gh child. ⚠️ No real process, no real gh, no network. */
function fakeSpawn({ stdout = '', stderr = '', code = 0 } = {}, record = null) {
  return (file, args, opts) => {
    record?.push({ file, args, opts });
    const child = new EventEmitter();
    child.pid = 4242;
    for (const s of ['stdout', 'stderr']) {
      child[s] = new EventEmitter();
      child[s].setEncoding = () => {};
      child[s].destroy = () => {};
    }
    child.kill = () => {};
    child.unref = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('exit', code, null);
      child.emit('close', code, null);
    });
    return child;
  };
}

const GH_PRESENT = () => ({ ok: true, file: '/usr/bin/gh' });
const GH_ABSENT = () => null;

// ───────────────────────────────────────────────────────────────────────────
// 1. THE WRITE VERBS ARE INEXPRESSIBLE — not refused, ABSENT
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ no argv this planner can produce contains a write subcommand or an HTTP method', () => {
  /**
   * ⚠️ THIS IS THE ONE ASSERTION THE WHOLE FILE EXISTS FOR. It does not ask
   * "does the validator refuse merge" — a validator can be mis-written. It takes
   * the UNION of every argument vector the planner can emit and proves the
   * dangerous words are not in it. A word that never appears cannot be reached
   * by a model that guesses well.
   */
  const everyArg = planAll().flatMap((p) => p.args);
  const forbidden = [
    'create', 'close', 'reopen', 'comment', 'edit', 'delete', 'merge', 'ready', 'review',
    'approve', 'lock', 'unlock', 'pin', 'transfer', 'checkout', 'rerun', 'cancel', 'download',
    'watch', 'api', 'release', 'secret', 'variable', 'workflow', 'repo', 'auth', 'alias',
    'extension', 'codespace', 'gist', 'config', '-X', '--method', 'POST', 'PATCH', 'PUT', 'DELETE',
    '--web', '-w', '--jq', '--template', '--force',
  ];
  for (const word of forbidden) {
    assert.equal(
      everyArg.some((a) => a === word || a.startsWith(`${word}=`)),
      false,
      `"${word}" must never appear in a planned argv, and it did: ${everyArg.join(' ')}`,
    );
  }
  // And the only subcommand words that DO appear are the nine read verbs'.
  const words = new Set(everyArg.filter((a) => !a.startsWith('--')));
  assert.deepEqual(
    [...words].filter((w) => !/^\d+$/.test(w)).sort(),
    ['diff', 'checks', 'issue', 'list', 'pr', 'run', 'view'].sort(),
  );
});

test('⭐ a write ACTION is refused, and the refusal hands the work back rather than just saying no', () => {
  const cases = [
    ['issue', 'close'], ['issue', 'comment'], ['issue', 'create'], ['issue', 'edit'], ['issue', 'delete'],
    ['pr', 'merge'], ['pr', 'review'], ['pr', 'approve'], ['pr', 'ready'], ['pr', 'checkout'],
    ['run', 'rerun'], ['run', 'cancel'], ['run', 'download'], ['run', 'watch'],
    ['issue', 'api'], ['pr', 'secret'], ['run', 'release'],
  ];
  for (const [noun, action] of cases) {
    const r = planGh(noun, { action, number: 1, runId: 1 });
    assert.equal(r.ok, false, `${noun}.${action} must be refused`);
    // ⭐ The way out, not just the obstacle: it names the command to run, and it
    // names what IS available here.
    /**
     * ── ⚠️ THIS ASSERTED A SENTENCE, AND THE SENTENCE STOPPED BEING TRUE ──────
     *
     * It used to require the phrase "READS GitHub and never writes". Once
     * `ACUVO_GH_WRITE` existed that became a claim the refusal must NOT make —
     * with the switch off, `comment` is refused because writes are DISABLED
     * (something an operator can change), and telling the model "this agent
     * never writes" is a falsehood it cannot correct by asking.
     *
     * ⭐ SO THE TEST NOW ASSERTS THE INTENT INSTEAD OF THE WORDING: a reason, a
     * command a human can run, and the list of what IS available. That is what
     * this test was always for; the exact phrase was incidental, and pinning
     * incidental wording is how a test starts defending a stale policy.
     */
    assert.match(r.error, /switched off in this workspace|changes or ends something other people/, `${noun}.${action}: must say why`);
    assert.match(r.error, /Run it yourself when you are ready: `gh /, `${noun}.${action}: must name the command`);
    for (const available of GH_NOUNS[noun]) {
      assert.ok(r.error.includes(available), `${noun}.${action}: must list "${available}" as available`);
    }
  }
});

/**
 * ⚠️ AND THE REASON MUST BE THE RIGHT ONE IN EACH MODE. Two different facts wear
 * the same refusal: "writes are off here" and "this write is never allowed". A
 * model told the wrong one either gives up on something an operator could enable,
 * or keeps retrying something that will never be enabled.
 */
test('⭐ the refusal gives the reason that is actually true, per mode', () => {
  const off = planGh('issue', { action: 'comment', number: 1 }, {});
  assert.equal(off.ok, false);
  assert.match(off.error, /switched off in this workspace/);
  assert.match(off.error, /ACUVO_GH_WRITE/);

  const on = planGh('pr', { action: 'merge', number: 1 }, { ACUVO_GH_WRITE: '1' });
  assert.equal(on.ok, false);
  assert.match(on.error, /changes or ends something other people/);
  assert.doesNotMatch(on.error, /switched off/);
});

test('an unknown noun and a missing action are both refused, naming what exists', () => {
  for (const noun of ['repo', 'release', 'secret', 'api', '', null, 42, 'ISSUE '.trim().toLowerCase() + 'x']) {
    const r = planGh(noun, { action: 'list' });
    if (noun === 'issue') continue;
    assert.equal(r.ok, false, `noun "${noun}" must be refused`);
    assert.match(r.error, /issue, pr, run/);
  }
  const noAction = planGh('pr', {});
  assert.equal(noAction.ok, false);
  assert.match(noAction.error, /needs an action.*list, view, diff, checks/s);
});

test('⚠️ an action is matched against the TABLE, not against the schema enum', () => {
  // A provider echoing a stale tool list, or a resumed session, can send any
  // string. `git.mjs:gitPush` makes the same argument about checking the gate at
  // the dispatcher as well as at the offer.
  for (const junk of ['LIST; gh pr merge 1', 'vi ew', '../view', 'view.', 'view;', 'merge', 'list,view']) {
    const r = planGh('pr', { action: junk, number: 1 });
    assert.equal(r.ok, false, `action "${junk}" must be refused`);
  }
  /**
   * ⭐ AND SURROUNDING WHITESPACE IS FORGIVEN, DELIBERATELY. A JSON tool call
   * arriving as `"view\n"` or `"LIST "` is a model being sloppy about a value
   * that is otherwise exactly right, and refusing it costs a paid round to
   * discover a rule nobody would guess. `validateCommitMessage` trims for the
   * same reason. ⚠️ Trimming is not the same as being loose: everything above
   * still fails, because trimming cannot turn junk into a table key.
   */
  for (const forgiven of ['view\n', ' view', 'VIEW', ' View ', '\tview\t']) {
    const r = planGh('pr', { action: forgiven, number: 1 });
    assert.equal(r.ok, true, `action "${JSON.stringify(forgiven)}" is a clean value with whitespace: ${r.error}`);
    assert.deepEqual(r.args.slice(0, 3), ['pr', 'view', '1']);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. THE ARGUMENTS — where a model string meets a parser we do not own
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ a HOST in "repo" is refused — gh accepts [HOST/]OWNER/REPO and would use your credential there', () => {
  const bad = [
    'evil.example.com/owner/name',
    'github.enterprise.internal/a/b',
    'https://github.com/a/b',
    'git@github.com:a/b',
    'a/b/c/d',
    '../../etc/passwd',
    'a/../../b',
    '-flag/name',
    'owner',
    'owner/',
  ];
  for (const r of bad) {
    const p = planGh('issue', { action: 'list', repo: r });
    assert.equal(p.ok, false, `repo "${r}" must be refused`);
  }
  assert.match(validateRepo('evil.com/a/b').error, /read the first part as a HOST/);
  assert.match(validateRepo('https://github.com/a/b').error, /just "owner\/name"/);

  // ⭐ And the legitimate forms still work, including the dotted and dashed
  // names GitHub really issues.
  for (const good of ['cli/cli', 'owner/repo.js', 'a-b/c_d', 'XXIautomate/claude-build', 'x/y.github.io']) {
    const p = planGh('issue', { action: 'list', repo: good });
    assert.equal(p.ok, true, `repo "${good}" must be accepted: ${p.error}`);
    assert.ok(p.args.includes(`--repo=${good}`), `repo must reach the argv as one element`);
  }
  assert.deepEqual(validateRepo(null), { ok: true, repo: null });
  assert.deepEqual(validateRepo(''), { ok: true, repo: null });
});

test('⭐ a URL or a branch is not a number — gh would accept both and read another repository', () => {
  const bad = [
    'https://github.com/someone/private/pull/1', 'main', '42abc', '-1', 0, -3, 1.5,
    '1; rm -rf /', '', null, undefined, {}, [], NaN, Infinity, 99_999_999,
  ];
  for (const n of bad) {
    const p = planGh('pr', { action: 'view', number: n });
    assert.equal(p.ok, false, `number ${JSON.stringify(n)} must be refused`);
  }
  assert.match(validateNumber('main').error, /positive whole number/);
  assert.match(validateNumber('main').error, /A URL or a branch name is not accepted/);

  // Legitimate: a number, and the string form a JSON tool call often produces.
  assert.deepEqual(planGh('pr', { action: 'view', number: 7 }).args[2], '7');
  assert.deepEqual(planGh('pr', { action: 'view', number: '7' }).args[2], '7');
});

test('⭐⭐ a REAL 11-digit run id is accepted — one ceiling for all nouns killed the CI verbs', () => {
  /**
   * MEASURED 2026-08-15: `gh run list --repo cli/cli` returns
   * databaseId 31882889895. The first draft capped every number at 9,999,999,
   * so `run view` and `run failed` — the entire "why did CI fail" story — were
   * refused against every real repository, with a message that called a run id
   * an "issue or pull request number". Green suite, dead feature.
   */
  const real = 31_882_889_895;
  for (const action of ['view', 'failed']) {
    const p = planGh('run', { action, runId: real });
    assert.equal(p.ok, true, `run ${action} must accept a real run id: ${p.error}`);
    assert.ok(p.args.includes(String(real)), 'and pass it through unmangled');
  }
  assert.equal(planGh('run', { action: 'failed', runId: real, job: 55_123_456_789 }).ok, true, 'job ids are just as large');

  // ⚠️ But an issue number keeps the tight ceiling — the two are different nouns.
  assert.equal(planGh('issue', { action: 'view', number: real }).ok, false);
  assert.equal(planGh('run', { action: 'view', runId: 1e16 }).ok, false, 'absurd values are still refused');
  // ⭐ And the refusal names the parameter it actually rejected.
  assert.match(validateNumber(1e16, 'runId', MAX_RUN_ID).error, /runId .* too large to be a real runId/);
  assert.equal(/issue or pull request/.test(validateNumber(1e16, 'runId', MAX_RUN_ID).error), false);
});

test('limit is CLAMPED not refused, and the default is stated once', () => {
  const at = (v) => planGh('issue', { action: 'list', limit: v }).args.find((a) => a.startsWith('--limit='));
  assert.equal(at(undefined), `--limit=${DEFAULT_GH_LIMIT}`);
  assert.equal(at(5), '--limit=5');
  assert.equal(at(500), `--limit=${MAX_GH_LIMIT}`);
  assert.equal(at(0), '--limit=1');
  assert.equal(at(-9), '--limit=1');
  assert.equal(at(7.9), '--limit=7');
  assert.equal(planGh('issue', { action: 'list', limit: 'lots' }).ok, false);
  assert.equal(validateLimit('12').value, 12);
});

test('a login, a label and a branch may not start with "-" — pflag would read it as a flag', () => {
  assert.equal(planGh('issue', { action: 'list', author: '--json' }).ok, false);
  assert.equal(planGh('issue', { action: 'list', labels: ['-x'] }).ok, false);
  assert.match(validateLabel('-x').error, /would be read as a flag/);
  assert.equal(planGh('pr', { action: 'list', head: '-b' }).ok, false);
  assert.equal(planGh('run', { action: 'list', workflow: '--help' }).ok, false);

  // ⭐ Legitimate values pass, including "@me", which is the question people ask.
  assert.ok(planGh('issue', { action: 'list', author: '@me' }).args.includes('--author=@me'));
  assert.ok(planGh('issue', { action: 'list', assignee: 'octocat' }).args.includes('--assignee=octocat'));
  assert.equal(validateLogin('a'.repeat(40), 'author').ok, false, 'a 40-char login is not a login');
  assert.equal(validateLogin('octo-cat').ok, true);
});

test('⭐ a search query keeps its spaces, colons and quotes — it is ONE argv element, and no shell exists', () => {
  const q = 'is:open label:"needs triage" sort:updated-desc "exact phrase"';
  const p = planGh('pr', { action: 'list', search: q });
  assert.equal(p.ok, true, p.error);
  const el = p.args.filter((a) => a.startsWith('--search='));
  assert.equal(el.length, 1, 'the query must not be split across arguments');
  assert.equal(el[0], `--search=${q}`);
  // Control characters are still out: they corrupt output, not just parsing.
  assert.equal(planGh('pr', { action: 'list', search: 'a\u0000b' }).ok, false);
  assert.equal(planGh('pr', { action: 'list', search: 'x'.repeat(500) }).ok, false);
  assert.equal(validateSearch('').value, null);
});

test('⚠️ every flag is emitted as --name=value, so a dash-leading value can never be re-read as a flag', () => {
  for (const p of planAll()) {
    for (const a of p.args) {
      if (!a.startsWith('--')) continue;
      assert.ok(
        a.includes('=') || a === '--log-failed',
        `"${a}" in ${p.verb} is a bare flag; only --log-failed (which takes no value) may be one`,
      );
    }
  }
});

test('the enum parameters refuse a value gh does not know, and name the vocabulary', () => {
  assert.equal(planGh('issue', { action: 'list', state: 'merged' }).ok, false, 'issues cannot be merged');
  assert.equal(planGh('pr', { action: 'list', state: 'merged' }).ok, true);
  assert.equal(planGh('run', { action: 'list', status: 'red' }).ok, false);
  assert.match(planGh('run', { action: 'list', status: 'red' }).error, /failure/);
  for (const s of RUN_STATUSES) {
    assert.equal(planGh('run', { action: 'list', status: s }).ok, true, `${s} is gh's own vocabulary`);
  }
  assert.equal(planGh('issue', { action: 'list', labels: Array(20).fill('bug') }).ok, false);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. --json WHERE gh SUPPORTS IT, AND NOWHERE ELSE
// ───────────────────────────────────────────────────────────────────────────

test('⭐ structured output is requested on every verb gh supports it on — and NOT on the two it does not', () => {
  const jsonOf = (noun, action) => {
    const p = planGh(noun, { action, ...MINIMAL[`${noun}.${action}`] });
    return { plan: p, field: p.args.find((a) => a.startsWith('--json=')) };
  };
  for (const [noun, action] of EVERY_VERB) {
    const { plan, field } = jsonOf(noun, action);
    const key = `${noun}.${action}`;
    if (key === 'pr.diff' || key === 'run.failed') {
      /**
       * ⚠️ NOT A STYLE CHOICE. `gh run view --log-failed --json x` is an error —
       * they are mutually exclusive — and `gh pr diff` has no --json at all. A
       * schema that let the model believe otherwise would produce a verb that
       * fails on every machine.
       */
      assert.equal(field, undefined, `${key} must NOT ask for --json`);
      assert.equal(plan.json, false);
      continue;
    }
    assert.ok(field, `${key} must ask for --json`);
    assert.equal(plan.json, true);
    const fields = field.slice('--json='.length).split(',');
    // ⚠️ Only 3 for the comments verbs, deliberately: their whole point is to
    // carry ONE expensive field and nothing that competes with it for budget.
    assert.ok(fields.length >= 3, `${key} asks for only ${fields.length} fields`);
    for (const f of fields) assert.match(f, /^[a-zA-Z]+$/, `"${f}" is not a gh field name`);
  }
});

const fieldsOf = (noun, params) => planGh(noun, params).args.find((a) => a.startsWith('--json=')).slice('--json='.length).split(',');

test('⭐⭐ the heavy content is on its OWN action, because together it does not fit', () => {
  /**
   * ── THE DEFECT THE FIRST END-TO-END CALL FOUND ────────────────────────────
   *
   * MEASURED against cli/cli #9000 on 2026-08-15, per field, in characters:
   *     body 6,949 · comments 4,971 · reviews 2,609 · latestReviews 2,096
   *     all the metadata together ≈ 500
   *     the capture ceiling (MAX_CAPTURED_CHARS) = 8,000
   *
   * Asking `view` for body AND comments AND reviews produced 12,320 characters
   * for an issue and 17,403 for a PR — so both verbs failed on an ORDINARY item,
   * while every unit test stayed green. Splitting them is the fix, and this test
   * is what stops someone helpfully merging them back together.
   */
  const issueView = fieldsOf('issue', { action: 'view', number: 1 });
  const issueComments = fieldsOf('issue', { action: 'comments', number: 1 });
  assert.ok(issueView.includes('body'), 'view carries the body');
  assert.equal(issueView.includes('comments'), false, 'view must NOT also carry the comments — that is what blew the budget');
  assert.ok(issueComments.includes('comments'), 'comments carries the discussion');

  const prView = fieldsOf('pr', { action: 'view', number: 1 });
  const prComments = fieldsOf('pr', { action: 'comments', number: 1 });
  for (const needed of ['body', 'files', 'headRefName', 'baseRefName', 'mergeable']) {
    assert.ok(prView.includes(needed), `pr view must read "${needed}"`);
  }
  for (const heavy of ['comments', 'reviews', 'latestReviews']) {
    assert.equal(prView.includes(heavy), false, `pr view must NOT carry "${heavy}"`);
  }
  // ⭐ And the review feedback IS reachable — on its own call.
  for (const needed of ['reviews', 'comments', 'reviewDecision']) {
    assert.ok(prComments.includes(needed), `pr comments must read "${needed}" — without it "address the review feedback" is unanswerable`);
  }
  // ⚠️ latestReviews is a SUBSET of reviews and cost 2,096 characters to repeat
  // information already present. Dropping it is what makes pr comments fit.
  assert.equal(prComments.includes('latestReviews'), false, 'latestReviews duplicates reviews and is what pushed this over the ceiling');
});

/**
 * ⭐ REAL BYTE COSTS, measured 2026-08-15 with `gh <verb> --json <one field>`
 * against cli/cli #9000 (a perfectly ordinary issue and PR). This is the table
 * that turns "that looks big" into an arithmetic test anyone can re-run.
 */
const MEASURED_FIELD_COST = {
  body: 6_949, comments: 4_971, reviews: 2_609, latestReviews: 2_096, files: 403,
  labels: 147, author: 98, title: 63, headRefName: 52, url: 47, createdAt: 37, updatedAt: 37,
  mergeStateStatus: 31, reviewDecision: 30, baseRefName: 24, mergeable: 24, milestone: 19,
  state: 19, changedFiles: 19, stateReason: 19, additions: 18, isDraft: 18, deletions: 16,
  number: 16, assignees: 17,
};
const CAPTURE_CEILING = 8_000;

test('⭐⭐ every single-item field set fits under the capture ceiling — by arithmetic, not by hope', () => {
  /**
   * ⚠️ THE ASSERTION THE FIRST DRAFT NEEDED AND DID NOT HAVE. Asking `view` for
   * body + comments + reviews at once measured 12,320 characters for an issue
   * and 17,403 for a PR against an 8,000 ceiling — both verbs dead on arrival
   * for any real repository, with a fully green suite.
   */
  for (const [noun, action] of [['issue', 'view'], ['issue', 'comments'], ['pr', 'view'], ['pr', 'comments']]) {
    const cost = fieldsOf(noun, { action, number: 1 })
      .reduce((sum, f) => sum + (MEASURED_FIELD_COST[f] ?? 300), 0);
    assert.ok(
      cost <= CAPTURE_CEILING,
      `${noun}.${action} costs ~${cost} measured characters, over the ${CAPTURE_CEILING} that can be captured — split it, do not merge field sets back together`,
    );
  }
});

test('⭐ the DEFAULT list size fits too — a default that always truncates is a broken default', () => {
  // Measured per item at these field sets: 546 (issue), 562 (pr), 298 (run).
  for (const [noun, perItem] of [['issue', 546], ['pr', 562], ['run', 298]]) {
    const limit = Number(planGh(noun, { action: 'list' }).args.find((a) => a.startsWith('--limit=')).slice(8));
    assert.equal(limit, DEFAULT_GH_LIMIT);
    assert.ok(
      limit * perItem <= CAPTURE_CEILING,
      `${noun} list defaults to ${limit} × ~${perItem} = ${limit * perItem} characters, over the ${CAPTURE_CEILING} ceiling`,
    );
  }
  // ⚠️ And the advertised maximum must be a number that can be delivered at all
  // — 100 was ~56,000 characters into an 8,000-character pipe.
  assert.ok(MAX_GH_LIMIT <= 30, `a maximum of ${MAX_GH_LIMIT} cannot be delivered through the capture buffer`);
});

test('pr diff asks for no colour explicitly rather than trusting NO_COLOR', () => {
  const p = planGh('pr', { action: 'diff', number: 3 });
  assert.deepEqual(p.args, ['pr', 'diff', '3', '--color=never']);
});

test('run failed asks for the FAILED steps only, and accepts an optional job', () => {
  assert.deepEqual(planGh('run', { action: 'failed', runId: 9 }).args, ['run', 'view', '9', '--log-failed']);
  assert.deepEqual(planGh('run', { action: 'failed', runId: 9, job: 5 }).args, ['run', 'view', '9', '--log-failed', '--job=5']);
  assert.equal(planGh('run', { action: 'failed', runId: 9, job: 'x' }).ok, false);
  // ⚠️ Never `--log`: a full CI log is megabytes of successful setup output.
  for (const p of planAll()) assert.equal(p.args.includes('--log'), false);
});

// ───────────────────────────────────────────────────────────────────────────
// 4. THE CAP — and SAYING it was capped
// ───────────────────────────────────────────────────────────────────────────

test('⭐ an ordinary small payload is NOT flagged truncated (a cap that fires early is a lie too)', () => {
  const small = capJsonPayload([{ number: 1, title: 'fix the thing' }], MAX_GH_OUTPUT_CHARS);
  assert.equal(small.truncated, false);
  assert.equal(small.capNote, null);
  assert.equal(small.omitted, 0);
  assert.deepEqual(JSON.parse(small.text), [{ number: 1, title: 'fix the thing' }]);

  const text = capTextPayload('diff --git a/x b/x\n+one line\n', 12_000, 'diff');
  assert.equal(text.truncated, false);
  assert.equal(text.capNote, null);
});

test('⭐⭐ a huge LIST is cut by dropping items, stays valid JSON, and says how many of how many', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ number: i, title: `issue number ${i}`, body: 'x'.repeat(200) }));
  const cap = capJsonPayload(many, 4_000);
  assert.equal(cap.truncated, true);
  assert.ok(cap.text.length <= 4_000, `the cap must actually cap: ${cap.text.length} > 4000`);
  // Still parseable — that is the point of cutting items rather than characters.
  const parsed = JSON.parse(cap.text);
  assert.ok(parsed.length >= 1 && parsed.length < 400);
  assert.equal(cap.omitted, 400 - parsed.length);
  assert.match(cap.capNote, new RegExp(`Showing ${parsed.length} of 400`));
  assert.match(cap.capNote, /Narrow it/);
  // ⭐ The full value survives for a caller that wants to summarise.
  assert.equal(cap.json.length, 400);
});

test('⚠️ one over-budget item is returned rather than an empty list, because [] would say "there are none"', () => {
  const one = capJsonPayload([{ body: 'y'.repeat(50_000) }], 500);
  const parsed = JSON.parse(one.text);
  assert.equal(parsed.length, 1, 'never zero: an empty list is a confident falsehood about what was asked for');
  assert.equal(one.truncated, true);
  assert.match(one.capNote, /Showing 1 of 1/);
});

test('⭐⭐ a huge OBJECT is clamped and the note says the JSON is no longer valid — silence here would be the bug', () => {
  const pr = { number: 1, body: 'z'.repeat(60_000), reviews: [{ body: 'change this' }] };
  const cap = capJsonPayload(pr, 2_000);
  assert.equal(cap.truncated, true);
  assert.ok(cap.omitted > 0);
  assert.match(cap.capNote, /TRUNCATED and no longer valid JSON/);
  assert.match(cap.capNote, /do not assume a field is absent/);
  assert.throws(() => JSON.parse(cap.text), 'the clamped text is genuinely not JSON — which is exactly why it must be announced');
  assert.equal(cap.json.body.length, 60_000, 'the parsed value is still whole');
});

test('⭐ a capped diff and a capped log each name a DIFFERENT way out', () => {
  const big = 'diff --git a/a b/a\n'.repeat(4_000);
  const diff = capTextPayload(big, 1_000, 'diff');
  assert.equal(diff.truncated, true);
  assert.match(diff.capNote, /cut from the MIDDLE/);
  assert.match(diff.capNote, /gh_pr \{ action: "view" \}.*read_file/s, 'the way out of a huge diff is the file list');

  const log = capTextPayload(big, 1_000, 'log');
  assert.match(log.capNote, /Read the tail/);
  assert.notEqual(log.capNote, diff.capNote, 'two different situations need two different sentences');
});

// ───────────────────────────────────────────────────────────────────────────
// 5. gh MISSING vs gh UNAUTHENTICATED — two failures, two sentences
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ "not installed" and "not authenticated" are different sentences with different fixes', () => {
  const missing = resolveGh({}, { resolveImpl: GH_ABSENT });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-installed');
  assert.match(missing.error, /not installed/);
  assert.match(missing.error, /winget install GitHub\.cli|brew install gh/);
  assert.match(missing.error, /acuvo --issue N/, 'must name the path that works without gh');

  const unauth = classifyGhFailure('gh: To get started with GitHub CLI, please run:  gh auth login');
  assert.equal(unauth.reason, 'not-authenticated');
  assert.match(unauth.error, /installed but has no usable credential/);
  assert.match(unauth.error, /gh auth login/);
  assert.match(unauth.error, /GH_TOKEN/);

  /**
   * ⭐ THE DISTINCTION THAT MATTERS IS SYMMETRIC, so assert it in both
   * directions: telling someone to install a program they already have wastes a
   * round exactly as badly as telling someone to sign in to one they do not.
   * (⚠️ The not-installed message DOES mention `gh auth login` — as the second
   * step after installing, which is correct advice. The wrong assertion here was
   * "never mention it", and that is a check that fails correct work.)
   */
  assert.notEqual(missing.error, unauth.error);
  assert.match(missing.error, /winget install|brew install|cli\.github\.com/, 'the missing-gh failure must name an install');
  assert.equal(
    /not installed|winget install|brew install/.test(unauth.error), false,
    'the auth failure must not tell you to install a program you already have',
  );
  assert.equal(/not installed/.test(unauth.error), false, 'the auth failure must not claim gh is missing');
});

test('⭐⭐ gh\'s OWN "no GitHub remote" error says `gh auth login` — and must NOT be classified as an auth failure', () => {
  /**
   * VERBATIM from gh 2.90.0, measured 2026-08-15:
   *   failed to determine base repo: none of the git remotes configured for this
   *   repository point to a known GitHub host. To tell gh about a new GitHub
   *   host, please use `gh auth login`
   *
   * An auth check written as "does it mention gh auth login" classifies this
   * wrongly, and the model then spends a paid round telling a signed-in user to
   * sign in while the actual fix goes unmentioned. This is the reason
   * `classifyGhFailure` tests the specific cause before the generic one.
   */
  const real = 'failed to determine base repo: none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`';
  const c = classifyGhFailure(real);
  assert.equal(c.reason, 'no-github-repo', 'the specific cause must win over the generic one');
  assert.match(c.error, /repo: "owner\/name"/, 'the way out is the repo parameter');
  assert.match(c.error, /red herring/, 'and it must say why gh\'s own advice is wrong here');
});

test('404 stays ambiguous on purpose, 403 names the scope, and an unknown error is passed through', () => {
  assert.equal(classifyGhFailure('HTTP 404: Not Found').reason, 'not-found');
  assert.match(classifyGhFailure('Could not resolve to a PullRequest').error, /private repository your token cannot see/);
  assert.equal(classifyGhFailure('HTTP 403: Resource not accessible').reason, 'forbidden');
  assert.match(classifyGhFailure('API rate limit exceeded').error, /rate limit/);
  assert.equal(classifyGhFailure('some brand new gh error'), null, 'an unrecognised error must be passed through, not mislabelled');
  assert.equal(classifyGhFailure(''), null);
});

test('a .cmd shim is refused honestly rather than by quietly opening a shell', () => {
  const shim = resolveGh({}, { resolveImpl: () => ({ ok: false, shim: 'C:\\scoop\\shims\\gh.cmd' }) });
  assert.equal(shim.ok, false);
  assert.equal(shim.reason, 'shim');
  assert.match(shim.error, /needs a shell, which this agent never opens/);
  assert.match(shim.error, /gh\.exe|GitHub CLI/, 'must name the way out');
  assert.notEqual(shim.error, resolveGh({}, { resolveImpl: GH_ABSENT }).error);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. THE ENVIRONMENT A gh CHILD GETS
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ the GitHub token reaches the GitHub child and NOTHING ELSE does', () => {
  const env = {
    GH_TOKEN: 'gho_from_env',
    GITHUB_TOKEN: 'ghp_from_ci',
    GH_ENTERPRISE_TOKEN: 'ghe_x',
    GITHUB_ENTERPRISE_TOKEN: 'ghe_y',
    // ⚠️ Every one of these is deleted by scrubEnvironment and must STAY deleted.
    OPENROUTER_API_KEY: 'sk-or-secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    DATABASE_CONNECTION_STRING: 'postgres://u:p@h/db',
    SESSION_COOKIE: 'c',
    // Ordinary, and needed: gh's own non-secret configuration.
    GH_HOST: 'github.com',
    GH_CONFIG_DIR: '/home/u/.config/gh',
    PATH: '/usr/bin',
  };
  const out = ghEnvironment(env);

  for (const keep of GH_ENV_KEEP) {
    assert.equal(out[keep], env[keep], `${keep} must reach the gh child — CI has no other credential`);
  }
  for (const leak of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_CONNECTION_STRING', 'SESSION_COOKIE']) {
    assert.equal(out[leak], undefined, `${leak} must NOT reach a gh child — it has no business with it`);
  }
  /**
   * ── ⚠️⚠️ THESE TWO ASSERTIONS USED TO PIN THE VULNERABILITY ───────────────
   *
   * They read:
   *     // Not scrubbed in the first place, so they survive without a keep-list entry.
   *     assert.equal(out.GH_HOST, 'github.com');
   *     assert.equal(out.GH_CONFIG_DIR, '/home/u/.config/gh');
   *
   * The comment was true and the test was holding the hole in place. "Survives
   * without a keep-list entry" means **the parent's value passes straight
   * through** — and this file hands the child `GH_ENTERPRISE_TOKEN` on purpose,
   * justified by the argument that these tokens "already travel to GitHub by
   * design". ⭐ That argument only holds while something guarantees which host
   * GitHub IS, and `GH_HOST` is exactly that something. A cloned repo with
   * `GH_HOST=attacker.example` in its `.env` got our enterprise token posted
   * there. The fixture even used `github.com`, so the test could never notice.
   *
   * ⭐ Both are now dropped unconditionally, and the enterprise tokens with
   * them — a credential whose only meaning is against an enterprise host is
   * worthless once the host is gone. GitHub Enterprise is reached through
   * `ACUVO_GH_HOST`, a name a workspace `.env` is forbidden from introducing.
   * Driven in full by `gh-host-cannot-be-chosen-by-a-repo.test.mjs`.
   */
  assert.equal(out.GH_HOST, undefined, 'a repo must not be able to choose the host our token is sent to');
  assert.equal(out.GH_CONFIG_DIR, undefined, 'a gh config file can itself name a host and carry credentials');
  assert.equal(out.GH_ENTERPRISE_TOKEN, undefined, 'no host, so no destination worth forwarding a secret to');
  assert.equal(out.GITHUB_ENTERPRISE_TOKEN, undefined);
  assert.equal(out.PATH, '/usr/bin');
});

test('the gh child cannot hang on a pager or a prompt, and is not charged for colour', () => {
  const out = ghEnvironment({ GH_FORCE_TTY: '80', PAGER: 'less' });
  assert.equal(out.GH_PAGER, 'cat');
  assert.equal(out.PAGER, 'cat', 'a pager waits for a keypress that will never come');
  assert.equal(out.GH_PROMPT_DISABLED, '1');
  assert.equal(out.NO_COLOR, '1');
  assert.equal(out.GH_NO_UPDATE_NOTIFIER, '1');
  assert.equal(out.GH_FORCE_TTY, undefined, 'a forced TTY makes gh truncate titles to a window width');
});

// ───────────────────────────────────────────────────────────────────────────
// 7. RUNNING IT — with no gh, no network and no credential anywhere
// ───────────────────────────────────────────────────────────────────────────

test('a refused plan never reaches spawn', async () => {
  let spawned = 0;
  const spy = () => { spawned += 1; throw new Error('must not be reached'); };
  const r = await executeGh('/tmp/x', 'pr', { action: 'merge', number: 1 }, { spawnImpl: spy, resolveImpl: GH_PRESENT, env: {} });
  assert.equal(r.ok, false);
  assert.equal(spawned, 0);

  // And neither does a bad argument.
  const r2 = await executeGh('/tmp/x', 'pr', { action: 'view', number: 'https://github.com/a/b/pull/1' }, { spawnImpl: spy, resolveImpl: GH_PRESENT, env: {} });
  assert.equal(r2.ok, false);
  assert.equal(spawned, 0);
});

test('⭐ the whole path runs: absolute gh, the workspace as cwd, the planned argv, parsed JSON back', async () => {
  const calls = [];
  const body = JSON.stringify([{ number: 12, title: 'the bug', state: 'OPEN' }]);
  const r = await executeGh('/work/repo', 'issue', { action: 'list', state: 'open', limit: 3 }, {
    env: { GITHUB_TOKEN: 't' },
    resolveImpl: GH_PRESENT,
    spawnImpl: fakeSpawn({ stdout: body }, calls),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/gh', 'an ABSOLUTE path — a gh.exe in cwd beats PATH on Windows');
  assert.equal(calls[0].opts.cwd, '/work/repo', 'gh resolves the repository from cwd');
  assert.equal(calls[0].opts.shell, false);
  assert.deepEqual(calls[0].args.slice(0, 2), ['issue', 'list']);
  assert.ok(calls[0].args.includes('--limit=3'));
  assert.equal(calls[0].opts.env.GITHUB_TOKEN, 't');
  assert.deepEqual(r.json, [{ number: 12, title: 'the bug', state: 'OPEN' }]);
  assert.equal(r.truncated, false);
  assert.equal(r.verb, 'issue.list');
});

test('⭐⭐ pr checks exits NON-ZERO exactly when CI is red — that is the answer, not a failure', async () => {
  /**
   * `gh pr checks` returns 8 for pending and non-zero when a check has failed.
   * Reporting "the tool broke" for the one case the model asked about would be
   * the single most misleading thing this module could do.
   */
  const body = JSON.stringify([{ name: 'build', state: 'FAILURE', bucket: 'fail' }]);
  const r = await executeGh('/w', 'pr', { action: 'checks', number: 4 }, {
    env: {}, resolveImpl: GH_PRESENT, spawnImpl: fakeSpawn({ stdout: body, code: 8 }),
  });
  assert.equal(r.ok, true, `a red CI must be a RESULT: ${r.error}`);
  assert.equal(r.checksFailing, true);
  assert.equal(r.json[0].state, 'FAILURE');

  // ⚠️ But a non-zero exit with NO output is still a real failure.
  const broken = await executeGh('/w', 'pr', { action: 'checks', number: 4 }, {
    env: {}, resolveImpl: GH_PRESENT, spawnImpl: fakeSpawn({ stderr: 'HTTP 404: Not Found', code: 1 }),
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'not-found');
});

test('⭐ an all-green run logs nothing — reported as an ANSWER, not as an empty string', async () => {
  const r = await executeGh('/w', 'run', { action: 'failed', runId: 5 }, {
    env: {}, resolveImpl: GH_PRESENT, spawnImpl: fakeSpawn({ stdout: '' }),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.empty, true);
  assert.match(r.note, /nothing failed/);
});

test('the two unavailability failures survive the whole runGh path, distinctly', async () => {
  let spawned = 0;
  const missing = await executeGh('/w', 'issue', { action: 'list' }, {
    env: {}, resolveImpl: GH_ABSENT, spawnImpl: () => { spawned += 1; },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-installed');
  assert.equal(spawned, 0, 'a missing gh must not be spawned anyway');

  const unauth = await executeGh('/w', 'issue', { action: 'list' }, {
    env: {}, resolveImpl: GH_PRESENT,
    spawnImpl: fakeSpawn({ stderr: 'gh: To get started with GitHub CLI, please run: gh auth login', code: 4 }),
  });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.reason, 'not-authenticated');
  assert.notEqual(unauth.error, missing.error);
});

test('gh answering with something other than JSON is reported with what it actually printed', async () => {
  const r = await executeGh('/w', 'issue', { action: 'list' }, {
    env: {}, resolveImpl: GH_PRESENT, spawnImpl: fakeSpawn({ stdout: 'A new release of gh is available!\n[]' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-json');
  assert.match(r.error, /A new release of gh is available/, 'nobody diagnoses this without seeing the output');
});

test('⭐⭐ a huge diff comes back capped, and the count includes what the CAPTURE BUFFER ate', async () => {
  /**
   * ── THE DEFECT THIS TEST FOUND, AND WHY IT SURVIVED A READ-THROUGH ────────
   *
   * `spawnBounded` clamps each stream to MAX_CAPTURED_CHARS (8,000) BEFORE
   * returning, so this module's own 16,000-character "generous diff cap" could
   * never fire. A 210,000-character diff arrived already cut to 8,000, the local
   * cap found nothing to trim, and the result went back `truncated: false` —
   * a confident "here is the diff" about 4% of the diff.
   *
   * ⭐ So the assertion is not "did our cap fire". It is "does the reported loss
   * match the real one", which is the only version of this that cannot pass for
   * the wrong reason.
   */
  const huge = 'diff --git a/f b/f\n@@ -1 +1 @@\n-old\n+new\n'.repeat(5_000);
  const r = await executeGh('/w', 'pr', { action: 'diff', number: 1 }, {
    env: {}, resolveImpl: GH_PRESENT, spawnImpl: fakeSpawn({ stdout: huge }),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.truncated, true, 'output that lost 200KB must not report truncated:false');
  assert.ok(r.text.length < huge.length);
  // ⭐ The number is checked against the INPUT, not against what survived.
  assert.equal(
    r.omitted + r.text.length >= huge.length * 0.97, true,
    `omitted (${r.omitted}) + kept (${r.text.length}) must account for the ${huge.length} gh produced`,
  );
  assert.match(r.capNote, /only 8000 can be captured/);
  assert.match(r.capNote, /gh_pr \{ action: "view" \}/, 'and still name the way out');

  /**
   * ⭐⭐ AND THE NUMBERS IN THE SENTENCE MUST ADD UP. Measured on a real
   * `run --log-failed`, the first version printed "31 characters were cut from
   * the MIDDLE … (1039 of those characters were dropped while capturing)" —
   * 1,039 of 31. On a message whose only job is to be believed about missing
   * data, arithmetic that visibly fails is the worst possible defect.
   */
  const headline = Number(/^⚠️ (\d+) characters were cut/.exec(r.capNote)[1]);
  assert.equal(headline, r.omitted, 'the headline number must be the TOTAL that was cut');
  const fromCapture = Number(/(\d+) because gh produced/.exec(r.capNote)[1]);
  const toFit = Number((/and (\d+) more to fit/.exec(r.capNote) ?? [0, 0])[1]);
  assert.equal(fromCapture + toFit, headline, `the breakdown (${fromCapture} + ${toFit}) must sum to the headline (${headline})`);
  // ⚠️ produced = cut + survived, within the length of the "… N characters
  // omitted …" marker `clampOutput` inserts — that marker is OUR text, not
  // gh's, so the identity is approximate by exactly that much and no more.
  const produced = Number(/gh produced (\d+) characters/.exec(r.capNote)[1]);
  const drift = Math.abs(produced - (headline + r.text.length));
  assert.ok(drift <= 200, `produced (${produced}) must equal cut (${headline}) + survived (${r.text.length}) bar the inserted marker; drift was ${drift}`);
});

test('⭐⭐ JSON lost to the capture buffer is neither blamed on gh nor thrown away', async () => {
  /**
   * TWO WRONG ANSWERS WERE SHIPPED HERE BEFORE THIS ONE, both found by running
   * the real thing rather than by reading the code:
   *  1. Fall through to the parse error — "gh returned something else". False:
   *     gh returned perfect JSON and WE cut the middle out of it. The model
   *     re-runs the identical call and gets the identical answer.
   *  2. Refuse with `ok: false` and "ask for less". Honest, and a dead end:
   *     measured against cli/cli #9000, this fires on an ORDINARY issue, and
   *     there is no unit smaller than one issue to ask for.
   * ⭐ So: return what survived — head AND tail, so the number and title are in
   * it — with a warning that cannot be missed and a narrower verb named.
   */
  const many = JSON.stringify(Array.from({ length: 900 }, (_, i) => ({ number: i, body: 'x'.repeat(60) })));
  const r = await executeGh('/w', 'issue', { action: 'list', limit: 100 }, {
    env: {}, resolveImpl: GH_PRESENT, spawnImpl: fakeSpawn({ stdout: many }),
  });
  assert.equal(r.ok, true, 'partial content beats no content');
  assert.equal(r.json, null, 'a half-parsed object with missing fields is the lie this avoids');
  assert.equal(r.truncated, true);
  assert.ok(r.omitted > 0);
  assert.match(r.capNote, /NOT VALID JSON AND FIELDS ARE MISSING/);
  assert.match(r.capNote, /Do not conclude a field is empty or absent/);
  assert.equal(/returned something else/.test(r.capNote), false, 'must not blame gh for our own buffer');
  assert.ok(r.text.length > 0, 'the surviving head and tail must come back');

  // ⭐ And on a view, the note names the narrower verb that actually exists.
  const view = await executeGh('/w', 'pr', { action: 'view', number: 1 }, {
    env: {}, resolveImpl: GH_PRESENT, spawnImpl: fakeSpawn({ stdout: JSON.stringify({ number: 1, body: 'x'.repeat(40_000) }) }),
  });
  assert.equal(view.ok, true);
  assert.match(view.capNote, /use action "comments"/, 'a way out the model can actually take');
});

// ───────────────────────────────────────────────────────────────────────────
// 8. THE OFFER — and that it cannot drift from the dispatcher
// ───────────────────────────────────────────────────────────────────────────

test('⭐ every action in every schema enum is a verb the planner really has, and vice versa', () => {
  // ⚠️ THE DRIFT TEST. A schema that offers an action the planner does not
  // implement is a tool call that always fails; a planner verb no schema offers
  // is capability that is built and never reached — this package's signature
  // defect.
  const schemas = ghToolSchemas();
  assert.equal(schemas.length, 3);
  for (const s of schemas) {
    const noun = s.function.name.replace(/^gh_/, '');
    const enumerated = s.function.parameters.properties.action.enum;
    assert.deepEqual([...enumerated].sort(), [...GH_NOUNS[noun]].sort(), `gh_${noun} enum must equal the verb table`);
    for (const action of enumerated) {
      assert.equal(planGh(noun, { action, number: 1, runId: 1 }).ok, true, `gh_${noun} offers "${action}" — the planner must implement it`);
    }
    assert.deepEqual(s.function.parameters.required, ['action']);
    assert.match(s.function.description, /only READS GitHub/, 'the model must be told it is read-only before it tries');
  }
  assert.deepEqual(schemas.map((s) => s.function.name), ['gh_issue', 'gh_pr', 'gh_run']);
});

test('no schema mentions a write action anywhere, including in prose', () => {
  const blob = JSON.stringify(ghToolSchemas());
  for (const word of ['"create"', '"merge"', '"comment"', '"close"', '"approve"', '"rerun"', '"api"']) {
    assert.equal(blob.includes(word), false, `${word} must not appear as an offered value`);
  }
});

test('⭐ the schemas are not offered at all on a machine with no gh — a schema nobody sees costs nothing', () => {
  assert.deepEqual(ghToolNames({}, { resolveImpl: GH_ABSENT }), []);
  assert.deepEqual(ghToolNames({}, { resolveImpl: GH_PRESENT }), ['gh_issue', 'gh_pr', 'gh_run']);
  // ⚠️ And a shim is "cannot run it", so it must not be offered either.
  assert.deepEqual(ghToolNames({}, { resolveImpl: () => ({ ok: false, shim: 'x.cmd' }) }), []);
});

test('planGh is PURE — no environment, no disk, no clock reaches it', () => {
  const a = planGh('pr', { action: 'list', state: 'open', limit: 10, labels: ['bug'] });
  const b = planGh('pr', { action: 'list', state: 'open', limit: 10, labels: ['bug'] });
  assert.deepEqual(a, b);
  // The same call under a hostile environment produces the same argv.
  const saved = process.env.GH_HOST;
  process.env.GH_HOST = 'evil.example.com';
  try {
    assert.deepEqual(planGh('pr', { action: 'list', state: 'open', limit: 10, labels: ['bug'] }), a);
  } finally {
    if (saved === undefined) delete process.env.GH_HOST; else process.env.GH_HOST = saved;
  }
});

test('⭐ the ordinary full-parameter call every verb will actually receive still plans cleanly', () => {
  const ok = [
    ['issue', { action: 'list', state: 'all', limit: 20, labels: ['bug', 'help wanted'], assignee: '@me', author: 'octocat', search: 'sort:updated', repo: 'cli/cli' }],
    ['issue', { action: 'view', number: 1234, repo: 'cli/cli' }],
    ['pr', { action: 'list', state: 'open', limit: 5, head: 'fix/login-timeout', base: 'main', author: '@me', labels: ['bug'], search: 'draft:false' }],
    ['pr', { action: 'view', number: 88 }],
    ['pr', { action: 'diff', number: 88, repo: 'a/b' }],
    ['pr', { action: 'checks', number: 88 }],
    ['run', { action: 'list', limit: 10, branch: 'closer-local', workflow: 'ci.yml', status: 'failure' }],
    ['run', { action: 'view', runId: 17_000_000 > 9_999_999 ? 999_999 : 1 }],
    ['run', { action: 'failed', runId: 999_999, job: 12_345 }],
  ];
  for (const [noun, params] of ok) {
    const p = planGh(noun, params);
    assert.equal(p.ok, true, `${noun}.${params.action} with real parameters must work: ${p.error}`);
    assert.ok(p.args.length >= 2);
    assert.equal(typeof p.maxChars, 'number');
  }
});
