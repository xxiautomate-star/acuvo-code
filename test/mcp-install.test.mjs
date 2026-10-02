import test from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACUVO_MCP_BINARY, ACUVO_SERVER_NAME,
  ACUVO_HOSTED_NAME, ACUVO_HOSTED_URL,
  stripBom, parseHostConfig, buildServerEntry, planInstall, describeInstall,
  buildHostedEntry, entryCarriesSecret,
  hostedTransportFor, HOSTED_TRANSPORT_BY_TOOL, HOSTED_UI_REASON,
} from '../lib/mcp-install.mjs';

const entryOf = (opts) => {
  const r = buildServerEntry(opts);
  assert.equal(r.ok, true, r.error);
  return r.entry;
};

// ── the binary ───────────────────────────────────────────────────────────────

test('⚠️ the entry points at acuvo-mcp, never at acuvo', () => {
  assert.equal(entryOf({ root: '/w' }).command, ACUVO_MCP_BINARY);
  assert.equal(ACUVO_MCP_BINARY, 'acuvo-mcp');
});

// ── the flag set ─────────────────────────────────────────────────────────────

test('no options is a bare command — which is the 0-tool server, honestly', () => {
  assert.deepEqual(entryOf({}), { command: 'acuvo-mcp', args: [] });
});

test('--root alone is the read-only workspace', () => {
  assert.deepEqual(entryOf({ root: '/w' }).args, ['--root', '/w']);
});

test('⭐ spending emits all three flags together', () => {
  assert.deepEqual(
    entryOf({ root: '/w', allowWrite: true, allowSpendUsd: 0.5 }).args,
    ['--root', '/w', '--allow-write', '--allow-spend', '0.5'],
  );
});

test('⚠️⚠️ spend WITHOUT write is refused, not silently written as a no-op', () => {
  const r = buildServerEntry({ root: '/w', allowSpendUsd: 0.5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /allow-write/);
});

test('⚠️ spend without a root is refused too', () => {
  assert.equal(buildServerEntry({ allowWrite: true, allowSpendUsd: 1 }).ok, false);
});

test('a non-positive ceiling is refused', () => {
  for (const v of [0, -1, 'abc']) {
    assert.equal(buildServerEntry({ root: '/w', allowWrite: true, allowSpendUsd: v }).ok, false, `accepted ${v}`);
  }
});

test('env values are carried, and the keys are ordered so the file is stable', () => {
  const e = entryOf({ root: '/w', env: { MODAL_PRESS_URL: 'https://b', RENDER_AUDIT_URL: 'https://a' } });
  assert.deepEqual(Object.keys(e.env), ['MODAL_PRESS_URL', 'RENDER_AUDIT_URL']);
});

test('blank env values are dropped rather than written as empty strings', () => {
  assert.equal(entryOf({ root: '/w', env: { RENDER_AUDIT_URL: '   ' } }).env, undefined);
});

// ── the BOM, which is a bug we already shipped ───────────────────────────────

test('⚠️⚠️ a UTF-8 BOM does not make a valid config unreadable', () => {
  const withBom = '﻿{"mcpServers":{}}';
  assert.throws(() => JSON.parse(withBom), 'precondition: raw JSON.parse really does throw on a BOM');
  assert.equal(stripBom(withBom).charCodeAt(0), 0x7b);
  assert.equal(parseHostConfig(withBom).ok, true);
});

// ── parsing refusals ─────────────────────────────────────────────────────────

test('an absent or empty file is {} and is NOT an error', () => {
  for (const t of ['', '   ', undefined, null]) {
    const r = parseHostConfig(t);
    assert.equal(r.ok, true);
    assert.equal(r.existed, false);
  }
});

test('⚠️ corrupt JSON STOPS — the alternative is overwriting somebody\'s config', () => {
  const r = parseHostConfig('{ this is not json');
  assert.equal(r.ok, false);
  assert.match(r.error, /refusing to overwrite/);
});

test('valid JSON that is not an object is refused', () => {
  assert.equal(parseHostConfig('[1,2]').ok, false);
  assert.equal(parseHostConfig('"hello"').ok, false);
});

// ── the scope/secret rule ────────────────────────────────────────────────────

test('⭐⭐ a project-scoped config REFUSES an entry carrying credentials', () => {
  const plan = planInstall({
    configText: '{}',
    scope: 'project',
    entry: entryOf({ root: '/w', env: { RENDER_AUDIT_URL: 'https://token.modal.run' } }),
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.action, 'refused');
  assert.match(plan.reason, /repository/);
});

test('⚠️ and force does NOT unlock it — the person harmed is not the one running the command', () => {
  const plan = planInstall({
    configText: '{}',
    scope: 'project',
    force: true,
    entry: entryOf({ root: '/w', env: { RENDER_AUDIT_URL: 'https://token.modal.run' } }),
  });
  assert.equal(plan.ok, false);
});

test('the same entry WITHOUT env is fine in a project config', () => {
  const plan = planInstall({ configText: '{}', scope: 'project', entry: entryOf({ root: '/w' }) });
  assert.equal(plan.action, 'added');
});

test('a user-scoped config accepts credentials', () => {
  const plan = planInstall({
    configText: '{}',
    scope: 'user',
    entry: entryOf({ root: '/w', env: { RENDER_AUDIT_URL: 'https://token.modal.run' } }),
  });
  assert.equal(plan.action, 'added');
});

// ── read-modify-write ────────────────────────────────────────────────────────

test('⭐ every other key and every other server survives', () => {
  const before = {
    numStartups: 42,
    projects: { '/a': { history: ['x'] } },
    mcpServers: { github: { command: 'gh-mcp', args: [] } },
  };
  const plan = planInstall({ configText: JSON.stringify(before), entry: entryOf({ root: '/w' }) });
  const after = JSON.parse(plan.text);
  assert.equal(after.numStartups, 42);
  assert.deepEqual(after.projects, before.projects);
  assert.deepEqual(after.mcpServers.github, before.mcpServers.github);
  assert.equal(after.mcpServers.acuvo.command, 'acuvo-mcp');
});

test('the VS Code key is honoured — it is `servers`, not `mcpServers`', () => {
  const plan = planInstall({ configText: '{}', key: 'servers', entry: entryOf({ root: '/w' }) });
  const after = JSON.parse(plan.text);
  assert.ok(after.servers[ACUVO_SERVER_NAME]);
  assert.equal(after.mcpServers, undefined);
});

test('a server map that is not an object is refused', () => {
  const plan = planInstall({ configText: '{"mcpServers":[]}', entry: entryOf({ root: '/w' }) });
  assert.equal(plan.ok, false);
});

// ── idempotence and clobbering ───────────────────────────────────────────────

test('⚠️ re-running with the same settings reports `unchanged`, not a fresh write', () => {
  const entry = entryOf({ root: '/w' });
  const first = planInstall({ configText: '{}', entry });
  const second = planInstall({ configText: first.text, entry });
  assert.equal(second.action, 'unchanged');
  assert.equal(second.text, null, 'nothing should be written on a no-op run');
});

test('⚠️⚠️ a DIFFERENT existing acuvo entry is not silently replaced', () => {
  const mine = entryOf({ root: '/w' });
  const theirs = entryOf({ root: '/their/careful/root', allowWrite: true });
  const existing = planInstall({ configText: '{}', entry: theirs }).text;
  const plan = planInstall({ configText: existing, entry: mine });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /already configured/);
});

test('force replaces it, and says `updated` rather than `added`', () => {
  const theirs = entryOf({ root: '/their/root', allowWrite: true });
  const existing = planInstall({ configText: '{}', entry: theirs }).text;
  const plan = planInstall({ configText: existing, entry: entryOf({ root: '/w' }), force: true });
  assert.equal(plan.action, 'updated');
  assert.deepEqual(JSON.parse(plan.text).mcpServers.acuvo.args, ['--root', '/w']);
});

test('a missing entry is refused rather than writing a broken server', () => {
  assert.equal(planInstall({ configText: '{}' }).ok, false);
});

// ── the human line ───────────────────────────────────────────────────────────

test('describeInstall names the tool, the scope and the outcome', () => {
  const host = { tool: 'Cursor', scope: 'project' };
  assert.match(describeInstall(host, { action: 'added' }), /Cursor \(project\): added/);
  assert.match(describeInstall(host, { action: 'unchanged' }), /already configured/);
  assert.match(describeInstall(host, { action: 'refused', reason: 'because' }), /skipped — because/);
});

// ── the output is a file a host can actually read back ───────────────────────

test('⭐ the written text round-trips through a strict parse and ends in a newline', () => {
  const plan = planInstall({ configText: '{}', entry: entryOf({ root: '/w', allowWrite: true, allowSpendUsd: 2 }) });
  assert.ok(plan.text.endsWith('\n'));
  assert.deepEqual(
    JSON.parse(plan.text).mcpServers.acuvo.args,
    ['--root', '/w', '--allow-write', '--allow-spend', '2'],
  );
});

// ── the hosted server: 161 tools, and a secret in a different pocket ─────────

test('⭐ the hosted entry is http with a bearer header', () => {
  const r = buildHostedEntry({ token: 'acuvo_sk_abc' });
  assert.equal(r.ok, true);
  assert.equal(r.entry.type, 'http');
  assert.equal(r.entry.url, ACUVO_HOSTED_URL);
  assert.equal(r.entry.headers.Authorization, 'Bearer acuvo_sk_abc');
});

test('⚠️ no key is refused rather than writing an entry that 401s forever', () => {
  for (const t of ['', '   ', null, undefined]) {
    assert.equal(buildHostedEntry({ token: t }).ok, false, `accepted ${JSON.stringify(t)}`);
  }
});

test('⚠️ a non-https hosted URL is refused — the header is a bearer token', () => {
  assert.equal(buildHostedEntry({ token: 'k', url: 'http://acuvo.example/api' }).ok, false);
});

test('the bridge transport is stdio via mcp-remote, for hosts with no http', () => {
  const e = buildHostedEntry({ token: 'k', transport: 'bridge' }).entry;
  assert.equal(e.command, 'npx');
  assert.ok(e.args.includes('mcp-remote'));
  assert.ok(e.args.some((a) => a === 'Authorization: Bearer k'));
});

test('⚠️⚠️ THE HOLE: a header secret is caught by the project-scope refusal too', () => {
  const entry = buildHostedEntry({ token: 'acuvo_sk_real' }).entry;
  assert.equal(entryCarriesSecret(entry), true, 'a bearer header IS a credential');
  const plan = planInstall({ configText: '{}', scope: 'project', entry, name: ACUVO_HOSTED_NAME });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /repository/);
});

test('and it installs fine into a user-scoped config', () => {
  const entry = buildHostedEntry({ token: 'acuvo_sk_real' }).entry;
  const plan = planInstall({ configText: '{}', scope: 'user', entry, name: ACUVO_HOSTED_NAME });
  assert.equal(plan.action, 'added');
  assert.equal(JSON.parse(plan.text).mcpServers['acuvo-cloud'].headers.Authorization, 'Bearer acuvo_sk_real');
});

test('entryCarriesSecret ignores empty pockets, so a bare stdio entry is safe in a repo', () => {
  assert.equal(entryCarriesSecret({ command: 'acuvo-mcp', args: ['--root', '/w'] }), false);
  assert.equal(entryCarriesSecret({ command: 'x', env: {}, headers: {} }), false);
  assert.equal(entryCarriesSecret({ command: 'x', env: { A: '  ' } }), false);
});

test('the two servers coexist under different names', () => {
  const local = entryOf({ root: '/w' });
  const cloud = buildHostedEntry({ token: 'k' }).entry;
  const a = planInstall({ configText: '{}', entry: local, name: ACUVO_SERVER_NAME });
  const b = planInstall({ configText: a.text, entry: cloud, name: ACUVO_HOSTED_NAME });
  const cfg = JSON.parse(b.text).mcpServers;
  assert.ok(cfg.acuvo && cfg['acuvo-cloud'], 'both survive — they are not a choice of one');
});

// ── ⭐⭐ THE HOSTED ENTRY REACHES ONLY HOSTS THAT CAN READ IT ─────────────────

test('Claude Desktop takes a remote server through its UI, not its config file', () => {
  assert.equal(hostedTransportFor('Claude Desktop'), 'ui');
  // Everything else in IMPORT_SOURCES reads an http entry from the file.
  for (const tool of ['Claude Code', 'Cursor', 'VS Code', 'Windsurf']) {
    assert.equal(hostedTransportFor(tool), 'http', tool);
  }
  // An unknown host keeps the shape this module emitted before the split.
  assert.equal(hostedTransportFor('Some New Editor'), 'http');
  assert.equal(Object.isFrozen(HOSTED_TRANSPORT_BY_TOOL), true);
});

/**
 * ── ⚠️⚠️⭐ THE GUARD THAT MATTERS DRIVES THE BINARY, NOT THE PREDICATE ───────
 *
 * The defect was never that `hostedTransportFor` answered wrongly — that
 * function did not exist. It was that the CALLER built one entry and wrote it
 * everywhere. A unit test on the predicate would have stayed green through the
 * entire bug, which is the whole lesson of `feedback_one_screenshot_beat_3621_tests`.
 * So this runs the real `acuvo mcp install` and reads what a person would read.
 *
 * ⚠️ NO `--yes`: this is the dry run. It must never write into the machine's
 * actual host configs, and `APPDATA`/`HOME` are pointed at a temp dir so that
 * a mistake here cannot reach the developer's real Claude Desktop config.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'acuvo.mjs');

function installDryRun(args) {
  const sandbox = mkdtempSync(join(tmpdir(), 'acuvo-install-'));
  return execFileSync(process.execPath, [CLI, 'mcp', 'install', ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: { ...process.env, APPDATA: sandbox, HOME: sandbox, USERPROFILE: sandbox, ACUVO_ENV_FILE: join(sandbox, 'none.env') },
  });
}

test('⚠️ `mcp install --hosted` SKIPS Claude Desktop and says where to go instead', () => {
  const out = installDryRun(['--hosted', '--key', 'xxi_live_' + 'k'.repeat(40), '--host', 'Claude Desktop']);
  assert.match(out, /Claude Desktop \(user\): skipped/, out);
  assert.ok(out.includes(HOSTED_UI_REASON), out);
  // and it hands over the URL, because the UI route needs the person to paste one
  assert.ok(out.includes(ACUVO_HOSTED_URL), out);
  assert.doesNotMatch(out, /Claude Desktop \(user\): added/, 'reporting "added" IS the defect');
});

test('⚠️ and the STDIO install into Claude Desktop is untouched — that shape it does read', () => {
  const out = installDryRun(['--host', 'Claude Desktop']);
  assert.match(out, /Claude Desktop \(user\): added/, out);
  assert.doesNotMatch(out, /Claude Desktop \(user\): skipped/, out);
});

/**
 * ── ⭐⭐⭐ THE README IS A PROMISE, AND THIS IS THE ONLY THING THAT KEEPS IT ──
 *
 * ⚠️ WRITTEN AFTER THIS EXACT GUARD CAUGHT ITS OWN AUTHOR. The first draft of
 * the README section printed `acuvo mcp install --root . --yes`. `mcp install`
 * takes `--dir`, not `--root` — the real binary answers *"Unknown option
 * --root"* — so the front-door install line in the package's front-door
 * document did not work. It was found by RUNNING it, which is the whole point:
 * a documented command nobody executes is the same defect as a tool nobody can
 * reach, and this package's own npm listing is where a stranger meets it.
 *
 * So: every `acuvo …` invocation in README.md is executed here, with `--yes`
 * stripped so the check itself never writes into a machine's host configs.
 */
test('⚠️⚠️ every `acuvo` command the README prints is a command that runs', () => {
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
  const invocations = readme
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('acuvo mcp '))
    .map((l) => l.split('#')[0].trim());

  assert.ok(invocations.length >= 2, `expected the install lines, found ${invocations.length}`);

  for (const line of invocations) {
    // ⚠️ `--yes` OUT. The dry run is the assertion; applying it is not.
    const args = line.split(/\s+/).slice(1).filter((a) => a !== '--yes');
    assert.equal(args[0], 'mcp', line);
    /**
     * ⚠️ `--hosted` NEEDS A KEY, AND THAT REFUSAL IS CORRECT — the README's own
     * first code block is `acuvo --login`. Supplying one here checks the FLAGS,
     * which is what this guard is for; "you are not logged in" is a different
     * message and a correct one, and asserting on it would pin the wrong thing.
     */
    const extra = args.includes('--hosted') && !args.includes('--key')
      ? ['--key', `xxi_live_${'k'.repeat(40)}`]
      : [];
    /**
     * ⚠️ AND A HOST TO AIM AT. The sandbox has no editor installed, so the
     * honest answer is "no MCP host configuration was found" — correct, and
     * not what this guard is asking. `--host` is the documented override that
     * creates one, so the flags still get exercised against a real plan.
     */
    if (!args.includes('--host')) extra.push('--host', 'Claude Code');
    const out = installDryRun([...args.slice(2), ...extra]);
    assert.doesNotMatch(out, /Unknown option/, `README prints a flag the CLI rejects: ${line}\n${out}`);
    assert.doesNotMatch(out, /No MCP host configuration/, `${line} reached no host\n${out}`);
  }
});

test('⚠️ the README quotes the hosted URL the code actually uses', () => {
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
  assert.ok(readme.includes(ACUVO_HOSTED_URL), `README must name ${ACUVO_HOSTED_URL}`);
  // and the server name, so `claude mcp add` and `acuvo mcp install` cannot
  // drift into installing two entries that fight over one slot
  assert.ok(readme.includes(ACUVO_HOSTED_NAME), `README must name ${ACUVO_HOSTED_NAME}`);
});
