/**
 * ── ⚠️⚠️ CLONING A REPO AND TYPING `acuvo` RAN A BINARY THAT REPO CHOSE ─────
 *
 * ENTERPRISE.md §3.1, re-reproduced 2026-08-11 against the real CLI. A workspace
 * containing `evil.mjs` and a committed
 * `.mcp.json = {"mcpServers":{"evil":{"command":"node","args":["evil.mjs"]}}}`:
 *
 *     --dry-run       → no PWNED.txt   ✅ gate holds
 *     --no-run        → no PWNED.txt   ✅ gate holds
 *     --max-rounds 2  → PWNED.txt      ⚠️ written
 *
 * The default is 5 rounds, so the third line is **every ordinary invocation**.
 * No prompt, no consent, and the child got the full unscrubbed environment.
 *
 * ⭐ THE FIX IS CONSENT, NOT A BLOCKLIST. An `.mcp.json` is a legitimate and
 * useful thing to commit — that is the whole point of the file — so refusing it
 * outright would break the feature for everyone to stop an attacker. What was
 * missing is that **nobody ever agreed to it**. The file is committable and
 * reviewable by design, so the right shape is *read this once*, keyed to the
 * exact contents, not a per-run nag.
 *
 * ── ⚠️⚠️ THE TRUST STORE IS NOT IN THE WORKSPACE, AND THAT IS THE WHOLE GAME ─
 *
 * A `.acuvo/mcp-trust.json` inside the repo would be **committed by the attacker
 * already approved**. The record has to live somewhere the repository cannot
 * reach, so it lives under the user's home directory. Anything else is a lock
 * whose key is taped to the door.
 *
 * ── ⚠️ AND IT FAILS CLOSED WHERE NOBODY CAN ANSWER ─────────────────────────
 *
 * In CI, a pipe, or any non-interactive shell there is no one to ask, and
 * "nobody objected" is not the same as "somebody agreed" — the rule
 * `voice-task.mjs` already states out loud for a much smaller decision. So a
 * non-interactive run does not spawn, and says exactly how to allow it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** Where the record lives — under HOME, never under the workspace. */
export const TRUST_FILE = '.acuvo/mcp-trust.json';

/** The deliberate, documented escape for automation that has already reviewed the file. */
export const TRUST_ENV = 'ACUVO_TRUST_MCP';

export const TRUST_VERSION = 1;

/** How many records to keep. A trust store is small by nature; this stops it growing forever. */
export const MAX_TRUST_RECORDS = 200;

export function trustStorePath({ env = process.env, home = homedir() } = {}) {
  const override = env.ACUVO_TRUST_DIR?.trim();
  return join(override || home, TRUST_FILE);
}

/**
 * What the user is being asked to approve: the exact servers, not the file.
 *
 * ⚠️ HASHED FROM THE RESOLVED SERVERS, NOT THE RAW BYTES. Reformatting the JSON,
 * adding a comment or changing key order must not invalidate consent — but
 * changing a `command`, an `arg` or an `env` key absolutely must. Hashing the
 * file text would re-prompt on a whitespace change (a nag people learn to click
 * through, which is worse than no prompt) and hashing only names would miss the
 * attack entirely.
 */
export function fingerprint(servers) {
  const canonical = (servers ?? [])
    .map((s) => ({
      name: String(s?.name ?? ''),
      command: String(s?.command ?? ''),
      args: Array.isArray(s?.args) ? s.args.map(String) : [],
      env: Object.keys(s?.env ?? {}).sort(),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function loadTrust({ env = process.env, home = homedir(), readImpl = readFileSync } = {}) {
  const file = trustStorePath({ env, home });
  if (!existsSync(file)) return { v: TRUST_VERSION, trusted: [] };
  try {
    const parsed = JSON.parse(readImpl(file, 'utf8'));
    const trusted = Array.isArray(parsed?.trusted) ? parsed.trusted : [];
    return { v: TRUST_VERSION, trusted };
  } catch {
    /**
     * ⚠️ A CORRUPT STORE IS "NOTHING IS TRUSTED", NEVER "EVERYTHING IS". Fail
     * closed: the cost of being wrong here is a prompt, and the cost of the
     * other default is the exact bug this file exists to close.
     */
    return { v: TRUST_VERSION, trusted: [] };
  }
}

export function isTrusted(fp, store) {
  return (store?.trusted ?? []).some((t) => t?.fingerprint === fp);
}

export function recordTrust(fp, { root, servers, env = process.env, home = homedir(), writeImpl = writeFileSync, now = () => new Date().toISOString() } = {}) {
  const file = trustStorePath({ env, home });
  const store = loadTrust({ env, home });
  if (isTrusted(fp, store)) return { ok: true, already: true, file };

  store.trusted.unshift({
    fingerprint: fp,
    at: now(),
    root: String(root ?? ''),
    // ⚠️ Recorded so a person auditing the store later can see WHAT they said
    // yes to. A list of opaque hashes is not a record anybody can review.
    servers: (servers ?? []).map((s) => ({ name: s.name, command: s.command, args: s.args ?? [] })),
  });
  store.trusted = store.trusted.slice(0, MAX_TRUST_RECORDS);

  try {
    mkdirSync(dirname(file), { recursive: true });
    writeImpl(file, `${JSON.stringify({ v: TRUST_VERSION, trusted: store.trusted }, null, 2)}\n`, 'utf8');
    return { ok: true, file };
  } catch (e) {
    // ⚠️ Never fatal. Failing to REMEMBER consent means asking again next time,
    // which is annoying and safe. Refusing to run because we could not write a
    // file would be neither.
    return { ok: false, error: e?.message ?? String(e), file };
  }
}

/** The text a person reads before deciding. Exported so a test can assert it names the binary. */
export function describeServers(servers, { root = '' } = {}) {
  const lines = [];
  lines.push('⚠️  This workspace ships an MCP config, and running it starts the programs it names.');
  if (root) lines.push(`    ${root}`);
  lines.push('');
  for (const s of servers ?? []) {
    lines.push(`    ${s.name}:  ${s.command} ${(s.args ?? []).join(' ')}`.trimEnd());
    const keys = Object.keys(s.env ?? {});
    if (keys.length > 0) lines.push(`      with env: ${keys.join(', ')}`);
  }
  lines.push('');
  lines.push('    These run with your permissions and see your environment. If you cloned this');
  lines.push('    repository from someone else, read the config before agreeing.');
  return lines.join('\n');
}

/**
 * Decide whether the servers in this workspace may be spawned.
 *
 * Pure decision + injectable IO, so every branch is testable and none of them
 * needs a terminal.
 *
 * @returns {Promise<{allowed: boolean, reason: string, fingerprint: string, prompted: boolean, remember: boolean}>}
 */
export async function checkMcpConsent(servers, {
  root = '',
  env = process.env,
  home = homedir(),
  isInteractive = Boolean(process.stdin?.isTTY && process.stdout?.isTTY),
  ask = null,
  write = (s) => process.stderr.write(s),
} = {}) {
  const fp = fingerprint(servers);
  const base = { fingerprint: fp, prompted: false, remember: false };

  if (!servers || servers.length === 0) {
    return { ...base, allowed: true, reason: 'no servers configured' };
  }

  /**
   * ⭐ THE DELIBERATE ESCAPE, and it is an environment variable rather than a
   * flag on purpose: the people who need it are CI pipelines and containers,
   * which set env and do not retype a command line.
   */
  if (String(env[TRUST_ENV] ?? '').trim() === '1') {
    return { ...base, allowed: true, reason: `${TRUST_ENV}=1 was set, so the config was accepted without asking` };
  }

  if (isTrusted(fp, loadTrust({ env, home }))) {
    return { ...base, allowed: true, reason: 'this exact config was approved before' };
  }

  if (!isInteractive || typeof ask !== 'function') {
    /**
     * ⚠️ FAILS CLOSED, AND SAYS THE ONE THING THAT UNBLOCKS IT. An error that
     * only refuses gets worked around by disabling something larger.
     */
    return {
      ...base,
      allowed: false,
      reason: 'this workspace ships an MCP config that has not been approved, and there is no terminal here to ask.\n'
        + `Run it once interactively to approve it, or set ${TRUST_ENV}=1 if you have read the config yourself.`,
    };
  }

  write(`\n${describeServers(servers, { root })}\n`);
  const answer = String(await ask('    Start these programs? [y/N] ') ?? '').trim().toLowerCase();
  const yes = answer === 'y' || answer === 'yes';
  return {
    ...base,
    prompted: true,
    allowed: yes,
    remember: yes,
    reason: yes ? 'approved at the prompt' : 'declined at the prompt',
  };
}
