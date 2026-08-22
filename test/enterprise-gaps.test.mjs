/**
 * ── THE RANKED GAPS FROM ENTERPRISE.md §3, PINNED ──────────────────────────
 *
 * Each of these was an audited, reproduced finding with a `file:line` and a
 * measured repro. A gap closed without a test is a gap that reopens on the next
 * refactor, and three of these were still open weeks after being written down.
 *
 * ⚠️ COSTS $0.00 and touches no network: every spawn is injected, and the two
 * filesystem tests use a temp workspace.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveInWorkspace, createLocalExecutor } from '../lib/workspace.mjs';
import { findToken } from '../lib/github.mjs';
import { sessionFailed, formatSummary } from '../lib/turn.mjs';

const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acuvo-gap-'));
  made.push(root);
  return root;
}

// ── §3.4 the write guard checked only the FIRST path segment ───────────────

test('§3.4 a nested node_modules is refused, not just a root-level one', () => {
  /**
   * MEASURED IN THE AUDIT: every one of these returned {ok:true, created:true}
   * and landed on disk, because the guard was `has(segments[0])`. A monorepo has
   * a node_modules under every package, and a file written into one executes on
   * the next `npm run` exactly as a root-level one does.
   */
  const root = workspace();
  for (const p of [
    'packages/web/node_modules/vitest/dist/index.js',
    'apps/api/node_modules/.bin/anything',
    'a/b/c/.next/build.js',
    'vendor/thing/.git/hooks/pre-commit',
  ]) {
    const r = resolveInWorkspace(root, p, 'write');
    assert.equal(r.ok, false, `${p} should be refused for writing`);
    assert.match(r.reason, /refused/);
  }

  // ⚠️ Reading them stays allowed — the whole point of the distinction.
  assert.equal(resolveInWorkspace(root, 'packages/web/node_modules/x/index.js', 'read').ok, true);
});

test('§3.4 the guard does NOT refuse tracked, reviewable directories', () => {
  /**
   * ⚠️ A DELIBERATE DEPARTURE FROM THE AUDIT'S SUGGESTION, and the reasoning is
   * in `workspace.mjs`. `.github/`, `.husky/` and `.vscode/` are tracked and
   * appear in every diff, and "add a CI workflow" is an ordinary request. This
   * package treats refusing correct work as worse than the risk that refusal
   * avoids, and the protection there is review, which exists by construction.
   */
  const root = workspace();
  for (const p of ['.github/workflows/deploy.yml', '.husky/pre-commit', '.vscode/tasks.json']) {
    assert.equal(resolveInWorkspace(root, p, 'write').ok, true, `${p} should remain writable`);
  }
  // And a FILE whose name collides is not a directory anybody executes out of.
  assert.equal(resolveInWorkspace(root, 'src/node_modules.js', 'write').ok, true);
});

test('§3.4 the refusal survives the executor, not just the resolver', () => {
  const root = workspace();
  const ex = createLocalExecutor(root);
  const r = ex.writeFile('packages/web/node_modules/evil/index.js', 'module.exports=1\n');
  assert.equal(r.ok, false, 'the tool the model actually calls must refuse it');
  assert.equal(existsSync(join(root, 'packages', 'web', 'node_modules')), false, 'and nothing was created on the way');
});

// ── §3.3 `gh` resolved from the current directory on Windows ───────────────

test('§3.3 gh is resolved to an absolute path, never a bare name', () => {
  /**
   * MEASURED ON WINDOWS 11: a `gh.exe` in the current directory beat
   * `C:\\Program Files\\GitHub CLI\\gh.exe` under BOTH shell:true and
   * shell:false — libuv's own path search consults cwd before PATH. So the fix
   * is not "drop the shell option", it is "never pass a bare name".
   */
  let spawnedWith = null;
  findToken({
    env: { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, OPENROUTER_API_KEY: 'sk-secret' },
    runImpl: (file, args, opts) => { spawnedWith = { file, args, opts }; return { status: 1, stdout: '' }; },
  });

  if (spawnedWith === null) return; // no gh on this machine — the resolver refused, which is the safe answer

  assert.notEqual(spawnedWith.file, 'gh', 'a bare name is the bug');
  assert.match(spawnedWith.file, /[\\/]/, 'it must be a path, not a name');
  assert.equal(spawnedWith.opts.env.OPENROUTER_API_KEY, undefined, 'the child must not inherit the API key');
});

test('§3.3 no gh on PATH is "not installed", not a crash', () => {
  const r = findToken({ env: { PATH: '' }, runImpl: () => { throw new Error('must not be spawned'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /No GitHub credentials/);
});

test('§3.3 an explicit token still short-circuits before any spawn', () => {
  const r = findToken({ env: { GITHUB_TOKEN: 'ghp_x' }, runImpl: () => { throw new Error('must not be spawned'); } });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'GITHUB_TOKEN');
});

// ── §3.5 a provider outage exited 0 and could print ✔ VERIFIED ─────────────

test('§3.5 a run killed by the provider is a FAILED run', () => {
  /**
   * MEASURED: a stub that wrote a file in round 1 and returned a chain-exhausted
   * 429 in round 2 produced ok:true, sessionFailed:false, **exit code 0** and
   * `--json` saying `"error": null` — so `acuvo … && git commit && git push`
   * pushed a half-finished change.
   */
  const outage = { ok: true, stoppedBecause: 'model-error', executed: [], verification: { ran: false } };
  assert.equal(sessionFailed(outage), true, 'the shell must not be told this succeeded');
});

test('§3.5 ⚠️ the ACTIVE FALSE POSITIVE: verified work + a dead provider', () => {
  /**
   * The worse half of the finding. If round 1 ran a command that PASSED and the
   * outage hit the extension round, `verification.passed` is still true and the
   * summary printed `✔ VERIFIED` over a session that died with work outstanding.
   * The verdict was true about a command and wrong about the run.
   */
  const outcome = {
    ok: true,
    stoppedBecause: 'model-error',
    verification: { ran: true, passed: true, command: 'npm test' },
    executed: [],
    usage: { cost: 0.001 },
  };
  assert.equal(sessionFailed(outcome), true, 'a passing command does not make a dead run a success');

  const text = formatSummary(outcome).join('\n');
  assert.match(text, /DID NOT FINISH/, 'and the human summary must say so');
  assert.match(text, /provider/, 'naming the provider, not blaming the model for not running anything');
  assert.match(text, /do not chain a commit/i);
});

test('§3.5 an ordinary verified run is untouched', () => {
  // ⚠️ The other direction. A fix that fails correct work is the more expensive
  // mistake, so the healthy path must be byte-identical.
  const good = { ok: true, stoppedBecause: 'verified', verification: { ran: true, passed: true }, executed: [], usage: { cost: 0.001 } };
  assert.equal(sessionFailed(good), false);
  assert.doesNotMatch(formatSummary(good).join('\n'), /DID NOT FINISH/);
});

// ── §3.1 a committed .mcp.json spawned an attacker-chosen binary ───────────

import {
  checkMcpConsent, fingerprint, recordTrust, loadTrust, isTrusted,
  describeServers, trustStorePath, TRUST_ENV,
} from '../lib/mcp-consent.mjs';

const EVIL = [{ name: 'evil', command: 'node', args: ['evil.cjs'], env: {} }];

/** A trust store rooted in a temp dir, so no test can touch the real one. */
function isolated() {
  const home = workspace();
  return { env: { ACUVO_TRUST_DIR: home }, home };
}

test('§3.1 an unapproved MCP config does NOT spawn, and there is no terminal to ask', async () => {
  const { env, home } = isolated();
  const r = await checkMcpConsent(EVIL, { root: '/repo', env, home, isInteractive: false });
  assert.equal(r.allowed, false, 'this is the ordinary CI/pipe case and it must fail CLOSED');
  assert.match(r.reason, /not been approved/);
  // ⚠️ A refusal that does not say how to proceed gets worked around by
  // disabling something larger.
  assert.match(r.reason, new RegExp(TRUST_ENV));
  assert.match(r.reason, /interactively/);
});

test('§3.1 the prompt names the binary that will run', async () => {
  const { env, home } = isolated();
  const asked = [];
  const written = [];
  const r = await checkMcpConsent(EVIL, {
    root: '/repo', env, home, isInteractive: true,
    ask: (q) => { asked.push(q); return 'n'; },
    write: (s) => written.push(s),
  });
  assert.equal(r.allowed, false, 'anything but yes is no');
  const shown = written.join('');
  assert.match(shown, /node evil\.cjs/, 'the exact command must be visible before the decision');
  assert.match(shown, /your permissions/);
  assert.equal(asked.length, 1);
});

test('§3.1 approval is remembered per exact config, and a changed command re-asks', async () => {
  const { env, home } = isolated();

  const yes = await checkMcpConsent(EVIL, {
    root: '/repo', env, home, isInteractive: true, ask: () => 'y', write: () => {},
  });
  assert.equal(yes.allowed, true);
  assert.equal(yes.remember, true);
  recordTrust(yes.fingerprint, { root: '/repo', servers: EVIL, env, home });

  // Second run: no prompt at all.
  const again = await checkMcpConsent(EVIL, {
    root: '/repo', env, home, isInteractive: true,
    ask: () => { throw new Error('must not ask twice for the same config'); },
  });
  assert.equal(again.allowed, true);
  assert.equal(again.prompted, false);

  /**
   * ⚠️⚠️ THE ATTACK THIS DEFENDS: approve a benign config, then swap the binary.
   * The fingerprint covers command, args and env keys, so it re-asks.
   */
  const swapped = [{ name: 'evil', command: 'node', args: ['worse.cjs'], env: {} }];
  const third = await checkMcpConsent(swapped, {
    root: '/repo', env, home, isInteractive: false,
  });
  assert.equal(third.allowed, false, 'changing the command must invalidate consent');
});

test('§3.1 reformatting the config does NOT re-ask', () => {
  /**
   * ⚠️ The other direction, and it decides whether the prompt is respected. If
   * whitespace or key order re-prompted, people would learn to click through it,
   * and a prompt everyone clicks through is worse than no prompt.
   */
  /**
   * ── ⚠️⚠️ ONE ASSERTION HERE WAS PINNING A REMOTE CODE EXECUTION IN PLACE ───
   *
   * It read:
   *   assert.equal(fingerprint({TOKEN:'v'}), fingerprint({TOKEN:'DIFFERENT-VALUE'}),
   *     'env VALUES are not part of identity — only which keys are passed')
   *
   * That is not reformatting. Changing a value is a change to what gets
   * EXECUTED: an approved `{"env":{"NODE_OPTIONS":""}}` and a hostile
   * `{"env":{"NODE_OPTIONS":"--require ./pwn.cjs"}}` hashed identically, so a
   * `git pull` on a repository you had already approved ran the payload with no
   * prompt. An adversarial pass ran it end to end. The test was green the whole
   * time — it was asserting the hole.
   *
   * ⭐ The test's REASON is right and survives: whitespace and key order must
   * never re-prompt, because a prompt people are trained to click through is
   * worse than no prompt. Only the claim that a VALUE is cosmetic is retired.
   * See `mcp-consent-env-rce.test.mjs` for the other direction.
   */
  const order = [{ name: 'a', command: 'node', args: ['x.js'], env: { TOKEN: 'v', PATH: '/bin' } }];
  const reordered = [{ name: 'a', command: 'node', args: ['x.js'], env: { PATH: '/bin', TOKEN: 'v' } }];
  assert.equal(fingerprint(order), fingerprint(reordered), 'env key ORDER is cosmetic and must not re-ask');

  const changed = [{ name: 'a', command: 'node', args: ['x.js'], env: { TOKEN: 'DIFFERENT-VALUE', PATH: '/bin' } }];
  assert.notEqual(fingerprint(order), fingerprint(changed),
    'a changed env VALUE is a changed program — consent must not carry over');

  const two = [{ name: 'b', command: 'node', args: [] }, { name: 'a', command: 'node', args: [] }];
  const twoReordered = [{ name: 'a', command: 'node', args: [] }, { name: 'b', command: 'node', args: [] }];
  assert.equal(fingerprint(two), fingerprint(twoReordered), 'server order is not identity');
});

test('§3.1 the trust store lives OUTSIDE the workspace', () => {
  /**
   * ⚠️⚠️ THE WHOLE GAME. A trust file inside the repo would be committed by the
   * attacker ALREADY APPROVED — a lock whose key is taped to the door.
   */
  const repo = workspace();
  const p = trustStorePath({ env: {}, home: join('/home', 'someone') });
  assert.ok(!p.startsWith(repo), 'the store must not be reachable from the workspace');
  // ⚠️ Separator-agnostic: this asserted a POSIX slash and went red on Windows,
  // which is the platform the RCE was reproduced on.
  assert.ok(p.includes(join('home', 'someone')), `expected the home path, got ${p}`);
  assert.ok(p.endsWith(join('.acuvo', 'mcp-trust.json')));
});

test('§3.1 a corrupt trust store trusts NOTHING', () => {
  const { env, home } = isolated();
  const r = loadTrust({ env, home, readImpl: () => '{ this is not json' });
  assert.deepEqual(r.trusted, [], 'fail closed — the cost of being wrong the other way is the bug itself');
  assert.equal(isTrusted('abc', r), false);
});

test('§3.1 the documented escape works and is explicit', async () => {
  const { home } = isolated();
  const r = await checkMcpConsent(EVIL, { root: '/repo', env: { [TRUST_ENV]: '1' }, home, isInteractive: false });
  assert.equal(r.allowed, true);
  assert.match(r.reason, /without asking/);
  // ⚠️ Only an exact "1" — a stray empty string must not be an approval.
  const off = await checkMcpConsent(EVIL, { root: '/repo', env: { [TRUST_ENV]: '' }, home, isInteractive: false });
  assert.equal(off.allowed, false);
});

test('§3.1 no MCP config at all is not a decision anybody has to make', async () => {
  const { env, home } = isolated();
  const r = await checkMcpConsent([], { root: '/repo', env, home, isInteractive: false });
  assert.equal(r.allowed, true, 'the overwhelmingly common case must be silent');
});

test('§3.1 the run announces the binary BEFORE it spawns', async () => {
  /**
   * The audit log is written when the RUN ends and the `mcp` event fired after
   * `connectServer` returned — so every record of a spawn arrived after it, and
   * none named what was executed. A record that only survives the benign case is
   * not a record.
   */
  const { renderEvent } = await import('../lib/turn.mjs');
  const lines = renderEvent({ type: 'mcp-start', name: 'evil', command: 'node', args: ['evil.cjs'], env: [] }).join('\n');
  assert.match(lines, /node evil\.cjs/);
});

test('§3.1 the consent refusal is never truncated', async () => {
  /**
   * ⚠️ MEASURED ON THE REAL REPRODUCTION: the `mcp` renderer caps errors at 90
   * characters, so the refusal printed "…and there is no terminal he" — cutting
   * off the only sentence saying how to proceed.
   */
  const { renderEvent } = await import('../lib/turn.mjs');
  const reason = 'this workspace ships an MCP config that has not been approved, and there is no terminal here to ask.\nRun it once interactively to approve it, or set ACUVO_TRUST_MCP=1 if you have read the config yourself.';
  const out = renderEvent({ type: 'mcp', name: 'consent', ok: false, error: reason }).join('\n');
  assert.match(out, new RegExp(TRUST_ENV), 'the way out must survive rendering');
  assert.match(out, /interactively/);
});

// ── §3.6 the media half: a dry run posted anyway, and transcribe had no cap ──

import { transcribe, speak, makeDocument, seePage, MAX_TRANSCRIBE_BYTES, AUDIO_EXTENSIONS } from '../lib/media.mjs';

const MEDIA_ENV = { ACUVO_MEDIA_SECRET: 'test', RENDER_AUDIT_URL: 'https://example.invalid/r' };
const explodes = () => { throw new Error('the network was touched during a --dry-run'); };

test('§3.6 transcribe refuses to upload during a --dry-run', async () => {
  /**
   * ⚠️ IT TOOK NO `dryRun` AT ALL and `tools.mjs` called it without one, so a
   * run that promised "touch nothing, run nothing" base64'd a workspace file and
   * POSTed it to a metered GPU service. `fetchImpl` THROWS here, so a request
   * would fail this test rather than pass quietly on a machine with no network.
   *
   * ⚠️⚠️ AND ITS THREE SIBLINGS ARE DELIBERATELY NOT CHANGED. `seePage`,
   * `speak` and `makeDocument` also POST under `--dry-run`, which the audit
   * flagged as the same defect — but they have always used `dryRun` to mean
   * "do not WRITE", `designPass` passes it straight through to render-and-
   * critique, and 15+ tests encode that meaning. Changing what the flag means
   * underneath a shipped feature is a product decision, not a bug fix, and
   * forcing it here would have broken 13 tests written to protect the design
   * loop. Flagged in ENTERPRISE §3.6 instead of quietly redefined.
   */
  const r = await transcribe(process.cwd(), 'clip.wav', { env: MEDIA_ENV, fetchImpl: explodes, dryRun: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /dry-run/);
  assert.match(r.error, /metered/, 'and it names the cost it avoided');
});

test('§3.6 transcribe caps its upload, like speak always did', () => {
  // A cap was written for `speak` (5,000 chars) and omitted here, so ANY file at
  // ANY size was base64'd and posted.
  assert.ok(MAX_TRANSCRIBE_BYTES >= 5 * 1024 * 1024, 'big enough for a real recording');
  assert.ok(MAX_TRANSCRIBE_BYTES <= 100 * 1024 * 1024, 'small enough to not be a 200MB accident');
});

test('§3.6 transcribe refuses a file that is not a recording', async () => {
  const root = workspace();
  const junk = join(root, 'archive.zip');
  writeFileSync(junk, 'not audio');
  const r = await transcribe(root, 'archive.zip', { env: MEDIA_ENV, fetchImpl: explodes });
  assert.equal(r.ok, false);
  assert.match(r.error, /not an audio or video file/);
  // ⚠️ The useful half of the refusal: it names what WOULD work, so the model
  // fixes the argument instead of concluding the service is broken.
  assert.match(r.error, /\.wav/);
  assert.ok(AUDIO_EXTENSIONS.has('.mp3'));
});

// ── ⭐⭐ POLICY: 736 lines of admin control that nothing ever called ────────

import { loadPolicy, filterToolNames, mcpDecision, roundBudget, invocationDecision, OPEN_POLICY } from '../lib/policy.mjs';

test('⭐⭐ a forbidden tool is REMOVED FROM THE OFFER, not merely announced', async () => {
  /**
   * Measured 2026-08-12 by walking the import graph from both entry points:
   * `policy.mjs` was reachable from **nothing but its own test**. 736 lines,
   * fully documented, fully tested, and every run behaved as if an admin had
   * never been able to say no to anything.
   *
   * ⚠️ The load-bearing assertion is that the verb LEAVES THE OFFER. A policy
   * that only prints a warning is theatre: the model is still handed the tool
   * and still calls it.
   */
  const { toolNamesForRounds } = await import('../lib/tools.mjs');
  const offer = toolNamesForRounds(8, { allowRun: true, root: process.cwd() });
  assert.ok(offer.includes('run_command'), 'precondition: it is normally offered');

  const loaded = loadPolicy({ workspaceText: JSON.stringify({ forbidTools: ['run_command', 'delete_file'] }) });
  assert.equal(loaded.ok, true, loaded.error);
  const filtered = filterToolNames(loaded.policy, offer);

  assert.equal(filtered.includes('run_command'), false);
  assert.equal(filtered.includes('delete_file'), false);
  assert.equal(filtered.length, offer.length - 2, 'and nothing else was disturbed');
});

test('no policy file leaves the run byte-identical', async () => {
  // ⚠️ The overwhelmingly common case. A control that changes behaviour when
  // nobody configured it is a regression wearing a feature's clothes.
  const { toolNamesForRounds } = await import('../lib/tools.mjs');
  const offer = toolNamesForRounds(8, { allowRun: true, root: process.cwd() });
  assert.deepEqual(filterToolNames(loadPolicy({}).policy, offer), offer);
  assert.deepEqual(filterToolNames(OPEN_POLICY, offer), offer);
  assert.equal(mcpDecision(OPEN_POLICY).allowed, true);
});

test('the round ceiling is APPLIED, not just reported', () => {
  /**
   * ⚠️ `invocationDecision` returns the cap as a NOTE. If nothing then lowers
   * maxRounds, the note announces a limit that is not enforced — which is worse
   * than silence, because an operator reads it and believes it.
   */
  const p = loadPolicy({ workspaceText: JSON.stringify({ maxRounds: 2 }) }).policy;
  const capped = roundBudget(p, 12);
  assert.equal(capped.capped, true);
  assert.equal(capped.rounds, 2);
  assert.match(invocationDecision(p, { maxRounds: 12 }).notes.join(' '), /caps rounds at 2/);
});

test('requireDryRun refuses the run before anything is spent', () => {
  const p = loadPolicy({ workspaceText: JSON.stringify({ requireDryRun: true }) }).policy;
  const v = invocationDecision(p, { dryRun: false });
  assert.equal(v.ok, false);
  assert.match(v.violations[0], /may not write to disk/);
  assert.equal(invocationDecision(p, { dryRun: true }).ok, true);
});

test('⚠️ a workspace policy can only ever RESTRICT — the agent cannot widen it', () => {
  /**
   * ⭐⭐ THE DESIGN THAT MAKES THIS SAFE. `.acuvo/policy.json` lives in the
   * workspace and the agent can write to it, so authenticity is unsolvable.
   * Instead every merge takes the STRICTER value — a meet on a lattice — so
   * there is no value the agent can write that grants it anything it did not
   * already have. The worst it can do is restrict itself.
   */
  const admin = JSON.stringify({ maxRounds: 4, forbidTools: ['run_command'] });
  const agentTriesToWiden = JSON.stringify({ maxRounds: 60, forbidTools: [], allowMcp: true });

  const p = loadPolicy({ adminText: admin, workspaceText: agentTriesToWiden });
  assert.equal(p.ok, true, p.error);
  assert.equal(roundBudget(p.policy, 60).rounds, 4, 'the agent could not raise the ceiling');
  assert.ok((p.policy.forbidTools ?? []).includes('run_command'), 'nor un-forbid a verb');

  /**
   * ⭐ AND AN ABSURD VALUE IS REFUSED OUTRIGHT rather than clamped — stronger
   * than the lattice needs. `{"maxRounds": 999}` fails to parse at all
   * (ceiling 64), so the agent writing it kills its own run. That is a denial
   * of service against itself, which the module's header names as acceptable
   * and is not a security event.
   */
  const absurd = loadPolicy({ workspaceText: JSON.stringify({ maxRounds: 999 }) });
  assert.equal(absurd.ok, false);
  assert.match(absurd.error, /exceeds the maximum/);
});

test('a malformed policy stops the run rather than falling back to permissive', () => {
  // Absent means "no policy"; present-and-broken is a BROKEN CONTROL, and
  // quietly reverting to permissive is how an org finds out its restrictions
  // never applied — the same call `command.mjs` makes for its allowlist file.
  const bad = loadPolicy({ workspaceText: '{ this is not json' });
  assert.equal(bad.ok, false);
  assert.ok(bad.error.length > 5);
});
