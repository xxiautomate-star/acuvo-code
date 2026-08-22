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
/**
 * ⭐ IMPORTED, NEVER RE-IMPLEMENTED — the same rule `search.mjs` follows for
 * `refusedCommitPath`. "Is this variable name a secret?" already has one answer
 * in this package, with its caveats written next to it; a second copy here is
 * the copy that goes stale the day somebody adds a pattern to the first.
 */
import { secretlyNamed } from './command.mjs';

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
    .map((s) => {
      const base = {
        name: String(s?.name ?? ''),
        command: String(s?.command ?? ''),
        args: Array.isArray(s?.args) ? s.args.map(String) : [],
        /**
         * ── ⚠️⚠️ ENV VALUES, NOT ENV KEYS. THIS WAS AN RCE. ─────────────────
         *
         * Hashing `Object.keys` meant an approved
         *     {"env": {"NODE_OPTIONS": ""}}
         * and a hostile
         *     {"env": {"NODE_OPTIONS": "--require ./pwn.cjs"}}
         * produced the IDENTICAL fingerprint, `isTrusted` matched, no prompt
         * was shown, and `mcp.mjs` spawned the server with the payload. Proven
         * end to end by an adversarial pass: the code executed.
         *
         * ⚠️ THE ASYMMETRY WAS ALREADY WRITTEN DOWN AND POINTING THE OTHER WAY.
         * The paragraph below hashes HEADER values because they decide "WHICH
         * CREDENTIAL travels". An env value decides WHAT CODE RUNS, which is
         * strictly worse, and it was the one hashed by name only. `command.mjs`
         * knew it too — `REFUSED_NODE_FLAGS` refuses `--require`, `--import`,
         * `--loader` and `--env-file` BY NAME for ordinary commands. The
         * knowledge existed; this door did not consult it.
         *
         * ⭐ VALUES ARE HASHED UNEXPANDED, exactly like headers, so repointing
         * `${A}` at `${B}` re-prompts.
         *
         * ⚠️ THIS INVALIDATES EXISTING CONSENT FOR CONFIGS THAT CARRY ENV —
         * `["A","B"]` and `[["A","v"],["B","v"]]` do not hash alike — and that
         * is the correct blast radius rather than a regrettable one: those are
         * precisely the approvals that were unsound. A config with no env
         * hashes to `[]` either way and nobody is re-prompted for it.
         */
        env: Object.entries(s?.env ?? {})
          .map(([k, v]) => [String(k), String(v)])
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      };
      /**
       * ── ⚠️⚠️ A REMOTE SERVER'S DESTINATION IS PART OF WHAT WAS APPROVED ────
       *
       * `readMcpConfig` sets `command` to the URL for a remote server, so the
       * host is already inside the hash — but the HEADERS are not, and they are
       * the half that decides WHICH CREDENTIAL travels. Approving
       *     {"url":"https://x.example/mcp"}
       * must not silently approve
       *     {"url":"https://x.example/mcp","headers":{"Authorization":"Bearer ${GITHUB_TOKEN}"}}
       * on the next `git pull`. Header VALUES are hashed unexpanded, so
       * repointing `${A}` to `${B}` re-prompts too.
       *
       * ⭐ THE EXTRA KEYS ARE ADDED ONLY WHEN THEY EXIST, AND THAT IS
       * DELIBERATE. `JSON.stringify` is order- and presence-sensitive, so
       * unconditionally adding `transport:"stdio"` here would change the hash of
       * every stdio config in the world and re-prompt every existing user for a
       * config they already approved — a nag people learn to click through,
       * which this file's own header calls worse than no prompt.
       */
      if (s?.transport && s.transport !== 'stdio') {
        base.transport = String(s.transport);
        base.url = String(s.url ?? '');
        base.headers = Object.entries(s?.headers ?? {})
          .map(([k, v]) => [String(k), String(v)])
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      }
      return base;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Is this server one we reach over the network rather than one we start? */
export function isRemote(server) {
  return server?.transport === 'http' || server?.transport === 'sse';
}

/** `${VAR}` / `$VAR` inside a header value — the names about to leave the machine. */
export function headerEnvRefs(server) {
  const names = [];
  for (const value of Object.values(server?.headers ?? {})) {
    for (const m of String(value).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
      names.push(m[1] ?? m[2]);
    }
  }
  return [...new Set(names)];
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

/**
 * The text a person reads before deciding. Exported so a test can assert it
 * names the binary — and, since 2026-08-15, the HOST.
 *
 * ── ⚠️⚠️ A REMOTE SERVER SPAWNS NOTHING, WHICH IS THE BIGGER QUESTION ───────
 *
 * The instinct is that "no process is started" makes this a smaller decision
 * than the spawn it replaces, so it can ride along on the same yes. It is the
 * opposite: a spawned server runs code we did not write *on this machine*; a
 * remote one sends the workspace's contents — file bodies, error messages,
 * whatever the model puts in a tool call — to a computer belonging to whoever
 * the config names. There is no sandbox and no undo on data that has left.
 *
 * ⭐ SO THE PROMPT SAYS WHAT ACTUALLY HAPPENS, PER SERVER. A user reading
 * "Start these programs?" over a list containing a URL learns nothing, and a
 * consent screen that describes the wrong action is consent to nothing.
 */
export function describeServers(servers, { root = '' } = {}) {
  const list = servers ?? [];
  const local = list.filter((s) => !isRemote(s));
  const remote = list.filter((s) => isRemote(s));

  const lines = [];
  const what = [
    local.length > 0 ? 'starts the programs it names' : null,
    remote.length > 0 ? 'sends this workspace\'s data to the hosts it names' : null,
  ].filter(Boolean).join(' and ');
  lines.push(`⚠️  This workspace ships an MCP config, and running it ${what}.`);
  if (root) lines.push(`    ${root}`);
  lines.push('');
  for (const s of list) {
    if (isRemote(s)) {
      lines.push(`    ${s.name}:  ${s.transport === 'sse' ? 'SSE' : 'HTTP'} to ${s.url}`);
      const refs = headerEnvRefs(s);
      if (refs.length > 0) {
        // ⭐ NAMES THE VARIABLE, NEVER ITS VALUE. This line is the entire defence
        // against a cloned repository pointing your token at a host it chose:
        // the user is told which secret is about to travel and where.
        lines.push(`      sending your ${refs.join(', ')} to ${hostOf(s.url)}`);
      }
      /**
       * ⚠️ A LITERAL HEADER VALUE IS REDACTED, NOT PRINTED. `mcp.json` is one of
       * the few files people type a raw token into (doctor.mjs pays for the same
       * fact in `redactConfigEcho`), and this text goes to the terminal, to CI
       * logs and into whatever gets pasted into a bug report.
       */
      const literal = Object.entries(s.headers ?? {}).filter(([, v]) => !String(v).includes('$'));
      if (literal.length > 0) lines.push(`      with headers (values hidden): ${literal.map(([k]) => k).join(', ')}`);
      continue;
    }
    lines.push(`    ${s.name}:  ${s.command} ${(s.args ?? []).join(' ')}`.trimEnd());
    /**
     * ── ⚠️⚠️ THE VALUE IS SHOWN. A NAME ALONE APPROVES CODE NOBODY SAW. ─────
     *
     * This printed `with env: NODE_OPTIONS` and stopped there, so the sentence
     * the user agreed to was identical whether the value was `""` or
     * `--require ./pwn.cjs`. The whole point of this prompt is that a cloned
     * repository cannot run code you did not look at, and the payload lives in
     * the value.
     *
     * ⚠️ IT IS NOT THE SAME CALL AS THE HEADER ONE ABOVE, AND THE DIFFERENCE
     * IS REAL. A header value is a CREDENTIAL BEING SENT — printing it leaks a
     * secret to the terminal, to CI logs and into pasted bug reports, and the
     * name alone is enough to decide ("sending your GITHUB_TOKEN to x.example"
     * is the whole question). An env value is WHAT THE PROCESS RUNS WITH, and
     * the name alone decides nothing.
     *
     * ⭐ So: show the value, redacted when the NAME says it is a secret, using
     * `command.mjs`'s one list rather than a second copy of it. `PATH` and
     * `NODE_OPTIONS` are visible; `GITHUB_TOKEN` is not.
     */
    const env = Object.entries(s.env ?? {});
    if (env.length > 0) {
      const shown = env.map(([k, v]) => {
        if (secretlyNamed(k)) return `${k}=<hidden>`;
        const value = String(v);
        return `${k}=${value.length > 120 ? `${value.slice(0, 119)}…` : value}`;
      });
      lines.push(`      with env: ${shown.join('  ')}`);
    }
  }
  lines.push('');
  if (local.length > 0) {
    lines.push('    These run with your permissions and see your environment. If you cloned this');
    lines.push('    repository from someone else, read the config before agreeing.');
  }
  if (remote.length > 0) {
    lines.push('    Anything the agent sends a remote server — file contents, errors, your prompt —');
    lines.push('    leaves this machine and cannot be recalled. If you cloned this repository from');
    lines.push('    someone else, check the hosts above before agreeing.');
  }
  return lines.join('\n');
}

function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return String(url); }
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
  /**
   * ⚠️ THE QUESTION MATCHES WHAT IS ABOUT TO HAPPEN. "Start these programs?" over
   * a list of URLs is a question about the wrong action, and a yes to the wrong
   * question is not consent to the right one.
   */
  const anyLocal = servers.some((s) => !isRemote(s));
  const anyRemote = servers.some((s) => isRemote(s));
  const question = anyLocal && anyRemote ? '    Start these programs and connect to these hosts? [y/N] '
    : anyRemote ? '    Connect to these hosts? [y/N] '
      : '    Start these programs? [y/N] ';
  const answer = String(await ask(question) ?? '').trim().toLowerCase();
  const yes = answer === 'y' || answer === 'yes';
  return {
    ...base,
    prompted: true,
    allowed: yes,
    remember: yes,
    reason: yes ? 'approved at the prompt' : 'declined at the prompt',
  };
}
