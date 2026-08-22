/**
 * ── ⭐⭐ THE AGENT COULD COMMIT AND COULD NOT DELIVER ─────────────────────────
 *
 * MEASURED 2026-08-14, through the real schema function:
 *
 *     node --input-type=module -e "import {gitToolSchemas} from './lib/git.mjs';
 *       console.log(gitToolSchemas().map(t => t.function.name).join(', '))"
 *     -> git_status, git_diff, git_log, git_commit
 *
 * Four verbs, none of which creates a ref or writes to a remote. "Finish the
 * work and open a PR" — the single most common end-of-task instruction a coding
 * agent gets — was reachable only through `--shell`, i.e. by handing over the
 * whole machine to obtain one `git push`. A capability gate escaped by granting
 * a strictly larger capability is not a gate.
 *
 * ── ⭐ AND THE CHEAPER HALF: THE READS WERE DARK IN EVERY MONOREPO ───────────
 * MEASURED in the acuvo-code checkout itself (a subdirectory of a larger repo),
 * before the fix:
 *
 *     gitStatus -> ok:false "this workspace is INSIDE a git repository…"
 *     gitDiff   -> ok:false                 (same)
 *     gitLog    -> ok:false                 (same)
 *
 * `git_status` and `git_diff` are READ-ONLY. They carry none of the "a commit
 * lands in a repository nobody pointed us at" risk that motivated the guard,
 * and refusing them costs a user their whole git surface for a directory layout
 * that is not exotic — it is what every monorepo package looks like.
 *
 * ── ⚠️ WHAT THIS FILE IS CAREFUL ABOUT ──────────────────────────────────────
 * · Every git assertion runs against a REAL repository. The subdirectory bug
 *   only exists against a real `rev-parse --show-toplevel`, and the scoping fix
 *   only works if git's own pathspec and `--relative` behave as claimed.
 * · The push assertions push to a LOCAL BARE REPOSITORY used as the remote.
 *   Nothing in this suite touches the network, and nothing is ever pushed
 *   anywhere real.
 * · The pull-request assertions inject `fetchImpl`, so the GitHub call is
 *   asserted by its PAYLOAD rather than by making it.
 * · Half the file asserts what must STILL BE REFUSED. A delivery verb that
 *   force-pushes, or pushes `main`, or accepts a URL as a "remote", is worse
 *   than not having one — see `feedback_checks_that_fail_correct_work`, and its
 *   mirror image: a gate that opens is worse than a gate that never existed.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  gitStatus, gitDiff, gitLog, gitCommit, gitBranch, gitPush,
  validateBranchName, protectedBranchRefusal, protectedBranches, PROTECTED_BRANCHES,
  pushEnabled, pushEnvironment, gitPushToolNames, gitToolSchemas,
  formatStatusForModel, ALLOW_PUSH_ENV, PROTECTED_BRANCHES_ENV, PUSH_ENV_KEEP,
} from '../lib/git.mjs';
import { executeToolCall, TOOL_NAMES, toolNamesForRounds } from '../lib/tools.mjs';

const made = [];
after(() => {
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const g = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

/**
 * A repository with a package inside it AND a bare repository standing in for
 * the remote. ⚠️ `realpathSync(tmpdir())` because macOS `/var` is a symlink to
 * `/private/var` and every path comparison in `resolveRepo` is realpath'd —
 * without it the tests would compare two spellings of one directory, which is
 * the exact bug the 8.3-short-name comment in git.mjs is about.
 */
function scratch(tag) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), `acuvo-deliver-${tag}-`));
  made.push(base);
  const repo = join(base, 'repo');
  const pkg = join(repo, 'packages', 'thing');
  const bare = join(base, 'remote.git');
  mkdirSync(pkg, { recursive: true });
  g(base, 'init', '-q', '--bare', bare);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'test@acuvo.local');
  g(repo, 'config', 'user.name', 'Acuvo Test');
  g(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'outer.md'), '# the outer repository\n');
  writeFileSync(join(pkg, 'a.js'), 'export const a = 1;\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'init');
  g(repo, 'remote', 'add', 'origin', bare);
  return { base, repo, pkg, bare };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. THE MONOREPO DARKENING — the cheapest win, and the one with a real user
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ the READ verbs work from a package inside a monorepo — all three were refused', async () => {
  const { repo, pkg } = scratch('reads');
  writeFileSync(join(pkg, 'a.js'), 'export const a = 2;\n');

  const status = await gitStatus(pkg);
  assert.equal(status.ok, true, `git_status must work in a subdirectory: ${status.error}`);
  const diff = await gitDiff(pkg);
  assert.equal(diff.ok, true, `git_diff must work in a subdirectory: ${diff.error}`);
  const log = await gitLog(pkg, { count: 5 });
  assert.equal(log.ok, true, `git_log must work in a subdirectory: ${log.error}`);

  // And each one SAYS it is a slice, so the model cannot mistake it for the whole.
  assert.equal(status.subdirectory, 'packages/thing');
  assert.equal(diff.subdirectory, 'packages/thing');
  assert.equal(log.subdirectory, 'packages/thing');
  assert.match(formatStatusForModel(status), /scoped to packages\/thing\//);
  void repo;
});

test('⭐ the reads are SCOPED — the outer repository\'s work in progress never appears', async () => {
  const { repo, pkg } = scratch('scope');
  // Somebody else's edit, in the outer repository. The old refusal existed to
  // stop us REPORTING this; scoping stops it just as dead, without going dark.
  writeFileSync(join(repo, 'outer.md'), '# edited by someone else\n');
  writeFileSync(join(pkg, 'a.js'), 'export const a = 2;\n');
  writeFileSync(join(pkg, 'b.js'), 'export const b = 3;\n');

  const status = await gitStatus(pkg);
  const paths = status.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['a.js', 'b.js'], 'only the workspace files, and named RELATIVE to the workspace');
  assert.ok(!paths.some((p) => p.includes('outer.md')), 'the outer repo\'s change must not leak in');

  const diff = await gitDiff(pkg);
  assert.match(diff.diff, /a\/a\.js/, '--relative must strip the packages/thing prefix out of the patch header');
  assert.ok(!diff.diff.includes('outer.md'), 'the diff must not carry the outer repository into the prompt');

  /**
   * ⭐ AND THE LOG, which a first pass of this file forgot to assert — the
   * mutation harness caught it: deleting the log's pathspec left all 21 tests
   * green. "Recent commits" in a monorepo package means recent commits TO THIS
   * PACKAGE; the whole-repo log is somebody else's history, and `git_log`'s own
   * schema tells the model to read it to learn the commit-message convention
   * for the directory it is in.
   */
  writeFileSync(join(repo, 'outer.md'), '# a second outer edit\n');
  g(repo, 'add', 'outer.md');
  g(repo, 'commit', '-qm', 'SOMEBODY ELSES COMMIT, outer only');
  const log = await gitLog(pkg, { count: 20 });
  const subjects = log.commits.map((c) => c.subject);
  assert.ok(!subjects.some((s) => s.includes('SOMEBODY ELSES')), `the outer repo's commits must not appear: ${subjects.join(' | ')}`);
  assert.deepEqual(subjects, ['init'], 'only commits that touched this package');
});

test('⚠️ the WRITE verbs are still refused in a subdirectory, and the refusal says the reads work', async () => {
  const { pkg } = scratch('writes');
  writeFileSync(join(pkg, 'b.js'), 'export const b = 3;\n');

  for (const [label, result] of [
    ['git_commit', await gitCommit(pkg, { message: 'nope', paths: ['b.js'] })],
    ['git_branch', await gitBranch(pkg, { name: 'nope' })],
    ['git_push', await gitPush(pkg, { env: { [ALLOW_PUSH_ENV]: '1' } })],
  ]) {
    assert.equal(result.ok, false, `${label} must still refuse from a subdirectory`);
    assert.match(result.error, /INSIDE a git repository/, label);
  }
  // ⭐ The refusal has to name the way forward, or the model spends a round
  // rediscovering that reading is allowed.
  const commit = await gitCommit(pkg, { message: 'nope', paths: ['b.js'] });
  assert.match(commit.error, /git_status, git_diff and git_log still work/);
});

test('the repository ROOT is byte-for-byte unchanged — no pathspec, no --relative, no subdirectory', async () => {
  const { repo } = scratch('root');
  writeFileSync(join(repo, 'outer.md'), '# changed\n');
  const status = await gitStatus(repo);
  assert.equal(status.ok, true);
  assert.equal(status.subdirectory, null, 'at the root there is no slice to declare');
  assert.deepEqual(status.files.map((f) => f.path), ['outer.md']);
  assert.equal(formatStatusForModel(status).includes('scoped to'), false);
});

// ───────────────────────────────────────────────────────────────────────────
// 2. BRANCH
// ───────────────────────────────────────────────────────────────────────────

test('⚠️ validateBranchName refuses every ref-format trap, pure and before git is spawned', () => {
  const refusals = [
    ['', /empty/],
    ['   ', /empty/],
    ['-rf', /may not start with "-"/],
    ['--force', /may not start with "-"/],
    ['my branch', /whitespace/],
    ['a..b', /"\.\."/],
    ['x@{1}', /"@\{"/],
    ['@', /shorthand for HEAD/],
    ['HEAD', /pointer to whichever branch/],
    ['refs/heads/x', /without the "refs\/heads\/" prefix/],
    ['a~1', /~ \^ : \? \* \[/],
    ['a^', /~ \^ : \? \* \[/],
    ['a:b', /~ \^ : \? \* \[/],
    ['a?b', /~ \^ : \? \* \[/],
    ['a*', /~ \^ : \? \* \[/],
    ['a\\b', /~ \^ : \? \* \[/],
    ['/leading', /begin or end with "\/"/],
    ['trailing/', /begin or end with "\/"/],
    ['a//b', /empty path segment/],
    ['.hidden', /begin with "\."/],
    ['feature/.hidden', /begin with "\."/],
    ['feature/x.lock', /\.lock/],
    ['x'.repeat(201), /over the 200/],
    [42, /branch name is required/],
    [null, /branch name is required/],
  ];
  for (const [input, rx] of refusals) {
    const r = validateBranchName(input);
    assert.equal(r.ok, false, `${JSON.stringify(input)} should be refused`);
    assert.match(r.error, rx, `${JSON.stringify(input)}: ${r.error}`);
  }
  // ⚠️ AND THE OTHER DIRECTION — a validator that refuses ordinary names is the
  // failure mode this repo has paid for four times in one day.
  for (const good of ['fix/login-timeout', 'feature/ABC-123_thing', 'v2.1-hotfix', 'roman', 'a/b/c']) {
    assert.equal(validateBranchName(good).ok, true, `${good} is a perfectly normal branch name`);
  }
});

test('⭐ git_branch creates, switches, and REUSES rather than clobbering', async () => {
  const { repo } = scratch('branch');

  const made1 = await gitBranch(repo, { name: 'fix/thing' });
  assert.deepEqual(
    { ok: made1.ok, branch: made1.branch, created: made1.created, previous: made1.previous },
    { ok: true, branch: 'fix/thing', created: true, previous: 'main' },
  );

  // A commit that only exists on the branch — the thing `-B` would silently eat.
  writeFileSync(join(repo, 'only-here.txt'), 'work\n');
  const committed = await gitCommit(repo, { message: 'work on the branch', paths: ['only-here.txt'] });
  assert.equal(committed.ok, true, committed.error);

  assert.equal((await gitBranch(repo, { name: 'main' })).ok, true);
  const back = await gitBranch(repo, { name: 'fix/thing' });
  assert.equal(back.created, false, 'an existing branch is switched to, never re-created');
  assert.match(g(repo, 'log', '--oneline', '-n1'), /work on the branch/, 'the branch commit survived');

  // Already there: a fact, not a failure.
  const again = await gitBranch(repo, { name: 'fix/thing' });
  assert.equal(again.ok, true);
  assert.equal(again.switched, false);
});

test('⚠️ a branch name that is also a valid object is CREATED, not switched to (detached-HEAD trap)', async () => {
  /**
   * `git rev-parse --verify <name>` resolves ANY object, so a probe on the bare
   * name reports "exists" for an abbreviated SHA and we would switch to a
   * DETACHED HEAD instead of creating the branch. The probe asks for
   * `refs/heads/<name>`, which can only be a branch.
   */
  const { repo } = scratch('sha');
  const sha = g(repo, 'rev-parse', '--short=7', 'HEAD').trim();
  const r = await gitBranch(repo, { name: sha });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.created, true, `"${sha}" is an object id, but as a branch name it does not exist yet`);
  assert.equal(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), sha, 'and HEAD is attached to it, not detached');
});

test('git_branch under --dry-run creates nothing', async () => {
  const { repo } = scratch('dry');
  const r = await gitBranch(repo, { name: 'fix/dry', dryRun: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /--dry-run/);
  assert.equal(g(repo, 'branch', '--list', 'fix/dry').trim(), '', 'nothing may exist afterwards');
});

// ───────────────────────────────────────────────────────────────────────────
// 3. PROTECTION — the half that must never open
// ───────────────────────────────────────────────────────────────────────────

test('⚠️⚠️ every protected branch is refused, and nothing the model controls can unprotect one', () => {
  for (const b of PROTECTED_BRANCHES) {
    assert.ok(protectedBranchRefusal(b, { env: {} }), `${b} must be protected`);
    assert.ok(protectedBranchRefusal(b.toUpperCase(), { env: {} }), `${b} must be protected case-insensitively`);
  }
  assert.equal(protectedBranchRefusal('fix/thing', { env: {} }), null, 'an ordinary branch is pushable');

  // Additive only. An emptied variable cannot empty the list.
  assert.ok(protectedBranchRefusal('acuvo', { env: { [PROTECTED_BRANCHES_ENV]: 'acuvo,redcell' } }));
  assert.ok(protectedBranchRefusal('main', { env: { [PROTECTED_BRANCHES_ENV]: '' } }), 'an empty list must not disarm it');
  assert.ok(protectedBranchRefusal('main', { env: { [PROTECTED_BRANCHES_ENV]: 'nothing-real' } }));
  assert.ok(protectedBranches({ [PROTECTED_BRANCHES_ENV]: 'acuvo' }).includes('main'));

  // The remote's own default counts, whatever it is called.
  assert.ok(protectedBranchRefusal('closer-local', { env: {}, defaultBranch: 'closer-local' }));
  assert.match(protectedBranchRefusal('closer-local', { env: {}, defaultBranch: 'closer-local' }), /default branch of the remote/);

  // And the refusal names the way forward rather than just saying no.
  assert.match(protectedBranchRefusal('main', { env: {} }), /git_branch/);
});

test('the push gate is OFF unless an operator names it, and the offer follows the gate', () => {
  assert.equal(pushEnabled({}), false);
  assert.equal(pushEnabled({ [ALLOW_PUSH_ENV]: '0' }), false);
  assert.equal(pushEnabled({ [ALLOW_PUSH_ENV]: '' }), false);
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(pushEnabled({ [ALLOW_PUSH_ENV]: on }), true, on);
  }
  // ⭐ THE COST ARGUMENT, asserted: a schema the model is never shown costs
  // nothing, so the default install pays zero tokens for a verb it has not
  // enabled.
  assert.deepEqual(gitPushToolNames({}, { allowRun: true }), []);
  assert.deepEqual(gitPushToolNames({ [ALLOW_PUSH_ENV]: '1' }, { allowRun: true }), ['git_push']);
  assert.deepEqual(gitPushToolNames({ [ALLOW_PUSH_ENV]: '1' }, { allowRun: false }), [], '--no-run withholds it too');
});

test('⚠️ pushEnvironment restores the ssh agent socket the scrub deletes — and nothing else', () => {
  /**
   * `SECRET_NAME` in command.mjs matches /AUTH/i, so `SSH_AUTH_SOCK` is scrubbed
   * — correct for every local verb, fatal for the one that authenticates to a
   * remote. This asserts the shape of the environment; the push proof itself
   * uses a local bare repo, which needs no credential, so SSH is reasoned about
   * rather than measured (said plainly in git.mjs).
   */
  const env = {
    PATH: 'p',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    SSH_AGENT_PID: '4242',
    OPENROUTER_API_KEY: 'sk-should-never-survive',
    GITHUB_TOKEN: 'ghp_should-never-survive',
  };
  const out = pushEnvironment(env);
  assert.equal(out.SSH_AUTH_SOCK, '/tmp/agent.sock');
  assert.equal(out.SSH_AGENT_PID, '4242');
  assert.equal(out.OPENROUTER_API_KEY, undefined, 'the model key must never reach a git child');
  assert.equal(out.GITHUB_TOKEN, undefined, 'git does not read it, and github.mjs fetches its own');
  assert.equal(out.GIT_TERMINAL_PROMPT, '0', 'a credential prompt with no terminal is a hang');
  assert.deepEqual(PUSH_ENV_KEEP.slice(), ['SSH_AUTH_SOCK', 'SSH_AGENT_PID'], 'the allowance is exactly two names');
});

// ───────────────────────────────────────────────────────────────────────────
// 4. PUSH — against a LOCAL BARE REPOSITORY, never anything real
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ git_push really pushes to a remote, and sets the upstream', async () => {
  const { repo, bare } = scratch('push');
  assert.equal((await gitBranch(repo, { name: 'fix/deliver' })).ok, true);
  writeFileSync(join(repo, 'shipped.txt'), 'the work\n');
  assert.equal((await gitCommit(repo, { message: 'ship it', paths: ['shipped.txt'] })).ok, true);

  const r = await gitPush(repo, { env: { [ALLOW_PUSH_ENV]: '1' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.branch, 'fix/deliver');
  assert.equal(r.remote, 'origin');

  // ⭐ THE PROOF IS IN THE OTHER REPOSITORY, not in our return value.
  assert.match(g(bare, 'branch', '--list'), /fix\/deliver/);
  assert.equal(g(bare, 'show', 'fix/deliver:shipped.txt'), 'the work\n');
  assert.match(g(repo, 'status', '-sb'), /origin\/fix\/deliver/, '--set-upstream, so the human\'s next `git pull` works');
});

test('⚠️⚠️ push refuses: the gate, a protected branch, a URL, an unknown remote, a detached HEAD', async () => {
  const { repo, bare } = scratch('refuse');

  const off = await gitPush(repo, { env: {} });
  assert.equal(off.ok, false);
  assert.match(off.error, new RegExp(ALLOW_PUSH_ENV));

  const on = { [ALLOW_PUSH_ENV]: '1' };
  const protectedPush = await gitPush(repo, { env: on });
  assert.equal(protectedPush.ok, false, 'HEAD is main');
  assert.match(protectedPush.error, /protected branch/);

  await gitBranch(repo, { name: 'fix/ok' });

  /**
   * ⭐ THE SHARPEST ONE. `git push https://somewhere-else/x HEAD` posts the
   * entire repository to an address the model chose, and reads as an ordinary
   * push in a transcript. The remote must be a NAME, and a name that the
   * repository already has.
   */
  const url = await gitPush(repo, { env: on, remote: 'https://evil.example/x.git' });
  assert.equal(url.ok, false);
  assert.match(url.error, /is not a remote name/);
  for (const bad of ['../../elsewhere', 'file:///tmp/x', 'git@github.com:o/r.git', '-x']) {
    const r = await gitPush(repo, { env: on, remote: bad });
    assert.equal(r.ok, false, `${bad} must not be accepted as a remote`);
  }

  const unknown = await gitPush(repo, { env: on, remote: 'upstream' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /no remote called "upstream"\. It has: origin/);

  const dry = await gitPush(repo, { env: on, dryRun: true });
  assert.equal(dry.ok, false);
  assert.match(dry.error, /--dry-run/);
  assert.equal(g(bare, 'branch', '--list').trim(), '', 'nothing may have reached the remote');

  g(repo, 'checkout', '-q', '--detach', 'HEAD');
  const detached = await gitPush(repo, { env: on });
  assert.equal(detached.ok, false);
  assert.match(detached.error, /HEAD is detached/);
});

test('⚠️ the remote DEFAULT branch is protected even when it is not called main', async () => {
  const { repo, bare } = scratch('default');
  // Give the clone an origin/HEAD, which is what a real `git clone` writes.
  await gitBranch(repo, { name: 'trunk-of-ours' });
  writeFileSync(join(repo, 'x.txt'), 'x\n');
  await gitCommit(repo, { message: 'x', paths: ['x.txt'] });
  assert.equal((await gitPush(repo, { env: { [ALLOW_PUSH_ENV]: '1' } })).ok, true);
  g(repo, 'remote', 'set-head', 'origin', 'trunk-of-ours');

  const blocked = await gitPush(repo, { env: { [ALLOW_PUSH_ENV]: '1' } });
  assert.equal(blocked.ok, false, 'once the remote calls it the default, it is protected');
  assert.match(blocked.error, /default branch of the remote/);
  void bare;
});

// ───────────────────────────────────────────────────────────────────────────
// 5. THE PULL REQUEST — asserted by its payload, never by making the call
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ openPullRequest posts the right payload and reports the PR url', async () => {
  const { repo } = scratch('pr');
  await gitBranch(repo, { name: 'fix/pr' });
  writeFileSync(join(repo, 'p.txt'), 'p\n');
  await gitCommit(repo, { message: 'p', paths: ['p.txt'] });

  const calls = [];
  const r = await gitPush(repo, {
    env: { [ALLOW_PUSH_ENV]: '1' },
    openPullRequest: true,
    pullRequestTitle: 'fix: the thing',
    pullRequestBody: 'Closes #42',
    pullRequestBase: 'main',
    detectImpl: () => ({ ok: true, owner: 'xxiautomate', repo: 'acuvo-code' }),
    tokenImpl: () => ({ ok: true, token: 'ghp_test', source: 'test' }),
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { status: 201, ok: true, json: async () => ({ number: 7, html_url: 'https://github.com/xxiautomate/acuvo-code/pull/7' }) };
    },
  });

  assert.equal(r.ok, true, r.error);
  assert.equal(calls.length, 1, 'exactly one API call');
  assert.equal(calls[0].url, 'https://api.github.com/repos/xxiautomate/acuvo-code/pulls');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer ghp_test');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    title: 'fix: the thing', head: 'fix/pr', base: 'main', body: 'Closes #42',
  });
  assert.deepEqual(r.pullRequest, {
    ok: true, number: 7, url: 'https://github.com/xxiautomate/acuvo-code/pull/7', base: 'main',
  });
});

test('⚠️ a PR that fails does NOT report the push as failed — the commits really are on the remote', async () => {
  const { repo, bare } = scratch('prfail');
  await gitBranch(repo, { name: 'fix/prfail' });
  writeFileSync(join(repo, 'q.txt'), 'q\n');
  await gitCommit(repo, { message: 'q', paths: ['q.txt'] });

  const r = await gitPush(repo, {
    env: { [ALLOW_PUSH_ENV]: '1' },
    openPullRequest: true,
    pullRequestTitle: 'fix: q',
    detectImpl: () => ({ ok: true, owner: 'o', repo: 'r' }),
    tokenImpl: () => ({ ok: false, error: 'No GitHub credentials found.' }),
    fetchImpl: async () => { throw new Error('must not be called without a token'); },
  });

  assert.equal(r.ok, true, 'the PUSH succeeded and must be reported as such');
  assert.equal(r.pullRequest.ok, false);
  assert.match(r.pullRequest.error, /No GitHub credentials/);
  assert.match(r.nextSteps.join('\n'), /gh pr create --head fix\/prfail/, 'and the human gets the command to finish it');
  assert.match(g(bare, 'branch', '--list'), /fix\/prfail/, 'the commits ARE there — retrying the push would be wrong');
});

test('a PR with no title is refused BEFORE anything leaves the machine', async () => {
  const { repo, bare } = scratch('notitle');
  await gitBranch(repo, { name: 'fix/notitle' });
  writeFileSync(join(repo, 'z.txt'), 'z\n');
  await gitCommit(repo, { message: 'z', paths: ['z.txt'] });

  const r = await gitPush(repo, { env: { [ALLOW_PUSH_ENV]: '1' }, openPullRequest: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /needs a pullRequestTitle/);
  assert.equal(g(bare, 'branch', '--list').trim(), '', 'and the push must not have happened');
});

test('GitHub\'s own 422 message survives — it is the only thing that distinguishes three causes', async () => {
  const { repo } = scratch('422');
  await gitBranch(repo, { name: 'fix/422' });
  writeFileSync(join(repo, 'w.txt'), 'w\n');
  await gitCommit(repo, { message: 'w', paths: ['w.txt'] });

  const r = await gitPush(repo, {
    env: { [ALLOW_PUSH_ENV]: '1' },
    openPullRequest: true,
    pullRequestTitle: 'fix: w',
    detectImpl: () => ({ ok: true, owner: 'o', repo: 'r' }),
    tokenImpl: () => ({ ok: true, token: 't' }),
    fetchImpl: async () => ({ status: 422, ok: false, json: async () => ({ errors: [{ message: 'A pull request already exists for o:fix/422.' }] }) }),
  });
  assert.equal(r.ok, true, 'still a successful push');
  assert.equal(r.pullRequest.ok, false);
  assert.match(r.pullRequest.error, /already exists for o:fix\/422/);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. REACH — the dispatcher and the registry, not just the library
// ───────────────────────────────────────────────────────────────────────────

test('⭐⭐ the new verbs REACH the model through the real dispatcher', async () => {
  /**
   * ⚠️ THIS PACKAGE'S SIGNATURE DEFECT IS THE FEATURE WHOSE PARTS ALL EXIST AND
   * WHICH NOTHING CALLS — shipped three times in one day. A green unit test on
   * `gitBranch` proves the function works and proves nothing about whether a
   * model can ever invoke it.
   */
  const { repo, bare } = scratch('reach');
  const executor = { root: repo, dryRun: false, env: { [ALLOW_PUSH_ENV]: '1' } };
  const call = (name, args) => executeToolCall({ id: 't1', function: { name, arguments: JSON.stringify(args) } }, executor, { allowRun: true });

  assert.ok(TOOL_NAMES.includes('git_branch') && TOOL_NAMES.includes('git_push'), 'both are in the registry');
  const offered = toolNamesForRounds(8, { allowRun: true, root: repo, env: { PATH: process.env.PATH, [ALLOW_PUSH_ENV]: '1' } });
  assert.ok(offered.includes('git_branch'), 'git_branch must be offered');
  assert.ok(offered.includes('git_push'), 'git_push must be offered when the gate is on');

  const branched = await call('git_branch', { name: 'fix/through-the-dispatcher' });
  assert.equal(branched.result.ok, true, JSON.stringify(branched.result));
  writeFileSync(join(repo, 'd.txt'), 'd\n');
  const committed = await call('git_commit', { message: 'd', paths: ['d.txt'] });
  assert.equal(committed.result.ok, true, JSON.stringify(committed.result));
  const pushed = await call('git_push', {});
  assert.equal(pushed.result.ok, true, JSON.stringify(pushed.result));
  assert.match(g(bare, 'branch', '--list'), /fix\/through-the-dispatcher/, 'a real commit, on a real remote, driven through executeToolCall');
});

test('⚠️ the gates hold at the DISPATCHER, not only at the offer', async () => {
  /**
   * `repl` RAN CODE and `start_process` STARTED A SERVER under `--no-run`
   * because their gate lived only in `toolNamesForRounds` — see
   * `test/no-run-holds-at-dispatcher.test.mjs`. A model can emit a call for a
   * tool it was never shown.
   */
  const { repo, bare } = scratch('gates');
  const call = (name, args, executor, allowRun) => executeToolCall(
    { id: 't1', function: { name, arguments: JSON.stringify(args) } }, executor, { allowRun },
  );

  const on = { root: repo, dryRun: false, env: { [ALLOW_PUSH_ENV]: '1' } };
  for (const name of ['git_commit', 'git_branch', 'git_push']) {
    const r = await call(name, { name: 'x', message: 'm', paths: ['outer.md'] }, on, false);
    assert.equal(r.result.ok, false, `${name} must be refused under --no-run`);
    assert.match(r.result.error, /--no-run/, name);
  }

  const off = { root: repo, dryRun: false, env: {} };
  const r = await call('git_push', {}, off, true);
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, new RegExp(ALLOW_PUSH_ENV));
  assert.equal(g(bare, 'branch', '--list').trim(), '', 'and nothing reached the remote');

  // ⭐ The reads are NOT gated by either — they execute nothing and leak nothing.
  const status = await call('git_status', {}, off, false);
  assert.equal(status.result.ok, true, 'git_status must survive --no-run');
});

test('the schemas are declared, named consistently, and every one has a dispatcher case', () => {
  const names = gitToolSchemas().map((t) => t.function.name);
  assert.deepEqual(names, ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch', 'git_push']);
  const push = gitToolSchemas().find((t) => t.function.name === 'git_push').function;
  // ⭐ The description has to warn, because the model reads it and nothing else.
  assert.match(push.description, /LEAVES THIS MACHINE/);
  assert.match(push.description, /never force-pushes/);
  assert.deepEqual(push.parameters.required, [], 'a plain push needs no arguments at all');
  assert.ok('openPullRequest' in push.parameters.properties, 'the PR rides on push rather than costing a second schema');
});
