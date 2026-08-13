/**
 * ── ⚠️⚠️ A CLONED REPOSITORY COULD RUN CODE, AND IT WAS REPORTED AS A ✔ ──────
 *
 * PROVEN 2026-08-13 in a scratch workspace, not argued:
 *
 *     .acuvo/acceptance.json  →  {"criteria":[{"command":"node payload.js"}]}
 *     payload.js              →  writeFileSync('PWNED.txt', …)
 *
 *     $ acuvo "say hello, change nothing"
 *     ✔ MET — `node payload.js` exited 0
 *     $ cat PWNED.txt
 *     a cloned repo executed this without being asked
 *
 * No prompt. No record. And the CLI printed the payload's execution as a
 * PASSING CHECK — the most reassuring possible rendering of an attack.
 *
 * ⭐ This is the SAME hole `mcp-consent.mjs` was written to close, one file
 * over. Its header says it exactly: *"Cloning an untrusted repository and typing
 * `acuvo` used to execute a binary that repository chose — no prompt, no record,
 * full environment. Consent, not a blocklist: a committed `.mcp.json` is a
 * legitimate thing to want. What was missing is that nobody ever agreed to it."*
 * Every word applies here, and `acceptance.json` was simply missed.
 *
 * ⚠️ THE ALLOWLIST IS NOT THE ANSWER, THOUGH IT LOOKS LIKE ONE. `command.mjs`
 * only permits vetted binaries, so this cannot run `curl`. It can run `node`,
 * and `node <a file in the repo>` is arbitrary code — the allowlist bounds the
 * BINARY, never the program. The probe above used nothing but `node`.
 *
 * ── ⭐ CONSENT ON AUTHORSHIP, WHICH IS WHY THIS DOES NOT BECOME A NAG ────────
 *
 * A prompt everybody clicks through is worse than no prompt, because it
 * launders the decision. So the ordinary path must never ask:
 *
 *   · the agent calls `declare_acceptance` during YOUR run → that is your own
 *     session authoring the file, so trust is recorded at the moment of writing
 *     and the next run recognises it silently.
 *   · a file that arrived any other way — a clone, a pull, a colleague — is
 *     unrecognised, and THAT is the only case that asks.
 *
 * The result: a person who uses this feature normally never sees a question,
 * and the question they do see means something specific.
 *
 * ── ⚠️ AND WHEN IT IS NOT TRUSTED, THE CRITERIA ARE IGNORED, NOT FATAL ──────
 *
 * Refusing to run at all would make a stray file a denial of service, and would
 * teach people to delete the safety feature. Unrecognised criteria are simply
 * not loaded: the run proceeds exactly as it would in a workspace with no
 * acceptance file, and says so once. Nothing untrusted is executed, and nothing
 * legitimate is blocked.
 */

import { fingerprint as hashOf, loadTrust, isTrusted, recordTrust, trustStorePath } from './mcp-consent.mjs';

/** `ACUVO_TRUST_ACCEPTANCE=1` — the non-interactive escape, mirroring MCP's. */
export const TRUST_ENV = 'ACUVO_TRUST_ACCEPTANCE';

/**
 * What is being approved: the COMMANDS, not the file.
 *
 * ⚠️ Reusing `mcp-consent.mjs`'s hash by shaping criteria into the same
 * `{name, command, args}` form it canonicalises. Reformatting the JSON or
 * editing a `why` must not re-prompt — a nag people learn to click through is
 * the failure mode — while changing a COMMAND must. The `kind` prefix keeps an
 * acceptance fingerprint from ever colliding with an MCP one in the shared
 * store, so approving a server can never silently approve a criterion.
 */
export function acceptanceFingerprint(criteria) {
  const shaped = (criteria ?? [])
    .map((c) => ({ name: 'acceptance', command: String(c?.command ?? ''), args: [] }))
    .sort((a, b) => a.command.localeCompare(b.command));
  return `acceptance:${hashOf(shaped)}`;
}

/** The text a person reads before deciding. Exported so a test can assert it names the command. */
export function describeCriteria(criteria, { root = '' } = {}) {
  const lines = [
    '',
    `  ⚠️  ${root || 'this workspace'} ships ${criteria.length} acceptance criterion${criteria.length === 1 ? '' : 's'}`,
    '      that nobody in this workspace has approved. Each one is a COMMAND that will be',
    '      run on your machine, and a passing run is reported as a ✔.',
    '',
  ];
  for (const c of criteria) {
    lines.push(`      $ ${c?.command ?? '(no command)'}`);
    if (c?.why) lines.push(`        (${c.why})`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * May these criteria be executed?
 *
 * @param {Array<{command?: string, why?: string}>} criteria
 * @param {object} opts
 * @param {string} [opts.root]
 * @param {null | ((q: string) => Promise<string|null>)} [opts.ask]
 * @param {boolean} [opts.isInteractive]
 * @returns {Promise<{allowed: boolean, reason: string, fingerprint: string, remember?: boolean}>}
 */
export async function checkAcceptanceConsent(criteria, {
  root = '',
  ask = null,
  isInteractive = false,
  env = process.env,
  home = undefined,
} = {}) {
  const list = Array.isArray(criteria) ? criteria.filter((c) => c && typeof c.command === 'string' && c.command.trim()) : [];
  const fp = acceptanceFingerprint(list);
  const base = { fingerprint: fp };

  // Nothing to run is nothing to approve — and must not print a question.
  if (list.length === 0) return { ...base, allowed: true, reason: 'no criteria' };

  if (String(env[TRUST_ENV] ?? '').trim() === '1') {
    return { ...base, allowed: true, reason: `${TRUST_ENV}=1 was set, so the criteria were accepted without asking` };
  }

  const store = loadTrust({ env, ...(home === undefined ? {} : { home }) });
  if (isTrusted(fp, store)) {
    return { ...base, allowed: true, reason: 'these exact criteria were approved in this workspace before' };
  }

  /**
   * ⚠️ FAIL CLOSED. In CI, a pipe or a task runner there is nobody to ask, and
   * "nobody objected" is not consent. The run continues with no criteria rather
   * than executing commands nobody agreed to — see the header for why this is
   * not fatal.
   */
  if (!isInteractive || typeof ask !== 'function') {
    return {
      ...base,
      allowed: false,
      reason: 'this workspace ships acceptance criteria that have not been approved, and there is no terminal here to ask.\n'
        + `  They were NOT run. Approve them interactively once, or set ${TRUST_ENV}=1 if you have read them and this is your own repository.`,
    };
  }

  const answer = String(await ask('    Run these commands? [y/N] ') ?? '').trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    return { ...base, allowed: false, reason: 'declined — the criteria were not run' };
  }
  return { ...base, allowed: true, remember: true, reason: 'approved for this workspace' };
}

/**
 * Record consent because THIS session authored the criteria.
 *
 * ⭐ Called when `declare_acceptance` writes the file. The user's own run
 * created it, so asking about it afterwards would be asking them to approve
 * their own instruction — the definition of a prompt people learn to ignore.
 *
 * ⚠️ Never fatal, exactly like `recordTrust`: failing to remember means asking
 * once next time, which is annoying and safe.
 */
export function trustAuthoredCriteria(criteria, { root = '', env = process.env, home = undefined } = {}) {
  const list = Array.isArray(criteria) ? criteria.filter((c) => c && typeof c.command === 'string' && c.command.trim()) : [];
  if (list.length === 0) return { ok: true, already: true };
  const fp = acceptanceFingerprint(list);
  return recordTrust(fp, {
    root,
    servers: list.map((c) => ({ name: 'acceptance', command: c.command, args: [] })),
    env,
    ...(home === undefined ? {} : { home }),
  });
}

export { trustStorePath };
