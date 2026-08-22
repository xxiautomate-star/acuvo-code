/**
 * ── ⭐⭐ THE ACCOUNT — ACUVO'S KEY, NOT THE USER'S ───────────────────────────
 *
 * Acuvo Code is meant to work the way Claude Code does: you buy Acuvo credits,
 * you run the tool, and you never see a provider key. Today it does the
 * opposite — `readModelConfig` reads `OPENROUTER_API_KEY` out of the user's
 * environment and the first-run message tells a stranger to go and create one.
 * That is BYOK, it was never the plan, and it makes the product's storefront an
 * advertisement for somebody else.
 *
 * This module is the CLI half of the fix: where the account token lives, how it
 * is read and written, and how a run decides whether it is authenticated as an
 * Acuvo customer or falling back to a key the user brought.
 *
 * ── ⚠️⚠️ WHY THIS IS NOT IN THE WORKSPACE, AND IT IS NOT A STYLE CHOICE ─────
 *
 * This package already paid for that lesson once: a trust store that lives in
 * the workspace can be written by the agent that the trust store exists to
 * bound. `WRITE_FORBIDDEN_ROOTS` in workspace.mjs does not contain `.acuvo`, so
 * an agent can write `.acuvo/anything` — which would mean an agent able to mint
 * its own credentials, or to point its own gateway at a host it chose.
 *
 * ⭐ So the credential lives under HOME, outside every workspace, where no tool
 * in this package can reach it: nothing in `lib/tools.mjs` can read or write a
 * path outside the workspace root, by construction, and that containment is
 * already tested. The agent cannot exfiltrate a token it cannot open.
 *
 * ── ⚠️ THE PERMISSION PROMISE WE MUST NOT MAKE ──────────────────────────────
 *
 * `chmod 600` is a NO-OP on win32 — measured, and this project is developed on
 * Windows. So this returns what it ACTUALLY achieved rather than asserting a
 * mode it may not have got. A security control that reports success it did not
 * accomplish is worse than one that is absent, because it stops people looking.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Where an account lives. Under HOME, never under a workspace. */
export function accountDir(env = process.env, home = homedir()) {
  const override = String(env?.ACUVO_HOME ?? '').trim();
  return override || join(home, '.acuvo');
}

export function credentialsPath(env = process.env, home = homedir()) {
  return join(accountDir(env, home), 'credentials.json');
}

/**
 * ── ⭐ THE GATEWAY, AND WHY ITS URL IS NOT AN ARBITRARY OVERRIDE ────────────
 *
 * `model.mjs`'s `resolveApiUrl` accepts `ACUVO_API_URL` ONLY for loopback and
 * throws otherwise, because that variable decides where
 * `Authorization: Bearer <the user's provider key>` is SENT — a documented
 * exfiltration primitive if it were free-form.
 *
 * ⚠️ THE GATEWAY IS A DIFFERENT CASE AND THE DIFFERENCE IS THE CREDENTIAL. What
 * travels to the gateway is an ACUVO ACCOUNT TOKEN, which is ours, is scoped to
 * one account, and is revocable by us. It is not a provider key and it is not
 * the user's. So a configurable gateway host is a deployment knob, not a hole —
 * but only while that stays true, which is why `readAccount` never returns a
 * provider key and the gateway leg never receives one.
 */
export const DEFAULT_GATEWAY_URL = 'https://acuvo.xxiautomate.com/api/cli/v1/chat/completions';

/**
 * Read the stored account, if there is one.
 *
 * ⚠️ NEVER THROWS. A corrupt or half-written credentials file must degrade to
 * "not signed in" and let the run continue on whatever else is configured — a
 * crash on startup because a JSON file has a stray byte is a worse failure than
 * an unauthenticated run, and it is the one a user cannot diagnose.
 *
 * @returns {{ token: string, email: string | null, gatewayUrl: string } | null}
 */
export function readAccount(env = process.env, home = homedir()) {
  /**
   * ⭐ THE ENVIRONMENT WINS OVER THE FILE, so CI can authenticate without a
   * login step and without writing a credential to a build agent's disk.
   */
  const fromEnv = String(env?.ACUVO_TOKEN ?? '').trim();
  if (fromEnv) {
    return { token: fromEnv, email: null, gatewayUrl: gatewayUrlFrom(env, null) };
  }

  let raw;
  try {
    raw = readFileSync(credentialsPath(env, home), 'utf8');
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
  if (!token) return null;

  return {
    token,
    email: typeof parsed?.email === 'string' && parsed.email.trim() ? parsed.email.trim() : null,
    gatewayUrl: gatewayUrlFrom(env, parsed),
  };
}

/**
 * ⚠️ PRECEDENCE IS DELIBERATE: environment, then the stored file, then the
 * built-in default. The environment comes first so a developer can point a
 * local build at a staging gateway without editing a credential file — and so
 * the value used is always the one most recently and most explicitly chosen.
 */
function gatewayUrlFrom(env, stored) {
  const fromEnv = String(env?.ACUVO_GATEWAY_URL ?? '').trim();
  if (fromEnv) return fromEnv;
  const fromFile = typeof stored?.gatewayUrl === 'string' ? stored.gatewayUrl.trim() : '';
  return fromFile || DEFAULT_GATEWAY_URL;
}

/**
 * Store an account.
 *
 * @returns {{ ok: true, path: string, restricted: boolean, note: string | null }}
 *   `restricted` says whether the file permissions were actually narrowed —
 *   NOT whether we asked for it.
 */
export function writeAccount({ token, email = null, gatewayUrl = null }, env = process.env, home = homedir()) {
  const trimmed = String(token ?? '').trim();
  if (!trimmed) return { ok: false, error: 'a token is required' };

  const dir = accountDir(env, home);
  const path = credentialsPath(env, home);
  mkdirSync(dir, { recursive: true });

  const body = { token: trimmed };
  if (email) body.email = String(email).trim();
  if (gatewayUrl) body.gatewayUrl = String(gatewayUrl).trim();
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');

  /**
   * ⚠️ MEASURED: `chmod 600` is accepted and does nothing on win32. Reporting
   * "permissions restricted" there would be a security control announcing a
   * success it did not achieve, which stops the reader looking any further.
   */
  let restricted = false;
  let note = null;
  if (platform() === 'win32') {
    note = 'file permissions are not restricted on Windows — this file is readable by your user account';
  } else {
    try {
      chmodSync(path, 0o600);
      restricted = true;
    } catch {
      note = 'could not restrict file permissions';
    }
  }

  return { ok: true, path, restricted, note };
}

/** Remove a stored account. Idempotent — signing out twice is not an error. */
export function clearAccount(env = process.env, home = homedir()) {
  const path = credentialsPath(env, home);
  const existed = existsSync(path);
  try {
    rmSync(path, { force: true });
  } catch {
    return { ok: false, error: `could not remove ${path}` };
  }
  return { ok: true, existed, path };
}

/**
 * ── ⭐⭐ WHICH KEY IS THIS RUN USING, AND WHOSE MONEY IS IT? ─────────────────
 *
 * The one function that decides. It exists so the answer is computed in a single
 * place and can be REPORTED — a user must always be able to tell whether they
 * are spending Acuvo credits or their own provider balance, because those are
 * different people's money and confusing them is unforgivable.
 *
 * ── ⚠️⚠️ BYOK IS NOT A SUPPORTED PRODUCT MODE. IT IS A TRANSITIONAL ONE ─────
 *
 * This comment used to read: *"BYOK STAYS SUPPORTED, and that is not
 * indecision."* ⚠️ It was indecision, and it contradicted a product decision
 * that had already been made. Roman, twice (2026-08-14 and again 2026-08-16):
 * **BYOK = never — "it defeats the product completely."** If the user brings
 * their own key we are a free wrapper around somebody else's margin, and there
 * is no business under it. The reasoning is not about capability, it is that
 * the whole company is the gateway.
 *
 * ⚠️ SO WHY IS `'byok'` STILL HERE? Because removing it today would brick the
 * CLI, not free it. Measured 2026-08-16: there is **no `acuvo login` command
 * and no gateway server**, so `readAccount` can only succeed if somebody
 * hand-writes a credentials file — which means `'byok'` is currently the ONLY
 * mode that works, including for our own Terminal-Bench runs. Deleting the mode
 * before the thing that replaces it exists is not enforcing the rule, it is
 * shipping an unusable package.
 *
 * ⭐ THE ORDER, so nobody has to re-derive it:
 *   1. the gateway exists (holds OUR key, meters, bills, refuses at $0)
 *   2. `acuvo login` exists and writes an account
 *   3. THEN `'byok'` stops being a peer mode here — internal/dev only, or gone
 *
 * ⚠️⚠️ AND UNTIL THEN, NOBODY "IMPROVES" BYOK. No nicer key prompts, no BYOK
 * onboarding, no docs that present it as a way to use the product. Every such
 * change makes the paid path harder to introduce later and is work against the
 * business. This paragraph exists because the sentence it replaced was a
 * reasonable-sounding argument for exactly that, sitting in the codebase
 * looking like a decision.
 *
 * @returns {{ mode: 'account' | 'byok' | 'unconfigured', token: string,
 *             url: string | null, email: string | null }}
 */
export function resolveCredential(env = process.env, home = homedir()) {
  const account = readAccount(env, home);
  if (account) {
    return { mode: 'account', token: account.token, url: account.gatewayUrl, email: account.email };
  }
  const byok = String(env?.OPENROUTER_API_KEY ?? '').trim();
  if (byok) return { mode: 'byok', token: byok, url: null, email: null };
  return { mode: 'unconfigured', token: '', url: null, email: null };
}
