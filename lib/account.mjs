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
import { spawnSync } from 'node:child_process';
import { homedir, platform, userInfo } from 'node:os';
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
 * @returns {{ token: string, email: string | null, gatewayUrl: string, plan: string | null } | null}
 */
/**
 * ── ⚠️⚠️⭐ `plan` WAS PROMISED BY A COMMENT AND DROPPED BY THIS FUNCTION ─────
 *
 * `cost-units.mjs`'s `planFromAccount` reads `acct.plan` and its comment states:
 * *"The moment the login response carries `plan`, this function starts returning
 * it and the gate begins firing with no other change."*
 *
 * ⚠️ THAT WAS NOT TRUE. This function returned exactly `{ token, email,
 * gatewayUrl }`, so `acct.plan` was `undefined` even for a credentials file that
 * already held one. The gateway could have started sending `plan` at login and
 * **nothing would have changed**, because the field was being discarded one
 * layer below the place that documented waiting for it. "One field away" was two.
 *
 * ⭐ It is carried now, so the remaining half really is the server's alone.
 * ⚠️ NEVER SYNTHESISED. A file with no plan yields `null` — "we do not know" —
 * and `allowanceFrom` treats unknown as UNMETERED. Guessing a tier here would be
 * a guardrail refusing a paying customer, which this package's own rule
 * (`fal-spend-cap.mjs`, `allowanceFrom`) forbids in preference to the leak.
 */
export function readAccount(env = process.env, home = homedir()) {
  /**
   * ⭐ THE ENVIRONMENT WINS OVER THE FILE, so CI can authenticate without a
   * login step and without writing a credential to a build agent's disk.
   */
  const fromEnv = String(env?.ACUVO_TOKEN ?? '').trim();
  if (fromEnv) {
    /**
     * ⚠️ `plan: null`, NOT the file's. A token supplied by the environment is a
     * DIFFERENT account from the one on disk — pairing it with the stored
     * account's plan would meter one customer against another's allowance.
     */
    return { token: fromEnv, email: null, gatewayUrl: gatewayUrlFrom(env, null), plan: null };
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
    /**
     * ⚠️⚠️⭐ THE FIX ABOVE WAS APPLIED TO THE BRANCH THAT DID NOT MATTER.
     *
     * The comment on this function has said since it was written that `plan` was
     * "promised by a comment and dropped by this function", and the repair went
     * into the `ACUVO_TOKEN` branch — where the correct answer is a hardcoded
     * `null` anyway, because an environment token is a different account. The
     * FILE branch, the one every signed-in user takes, still returned an object
     * with no `plan` key, so `acct.plan` was `undefined` for everybody and
     * `planFromAccount` fell through to the cached `/engines` tier every time.
     *
     * ⭐ A COMMENT DESCRIBING A FIX IS NOT THE FIX, and a two-branch function is
     * where that gap hides: the branch you are looking at when you write the
     * comment is not necessarily the branch the product runs.
     *
     * ⚠️ NEVER SYNTHESISED. A credentials file with no plan yields `null` — "we
     * do not know" — never `'free'`, which would invent a ceiling and refuse a
     * paying customer's round.
     *
     * ⚠️⚠️ NOTHING WRITES THIS YET, AND THE OBVIOUS WAY TO WIRE IT IS A TRAP.
     * `verifyToken` answers `{ ok, kind, status }` — the login response carries
     * no plan — so today every user takes the `/engines` tier that
     * `capturePlanAfterLogin` primes. **Do not "fix" that by having
     * `capturePlanAfterLogin` copy the catalogue tier in here.** This field
     * OUTRANKS the catalogue precisely because it is meant to be the account's
     * own answer; make it a mirror of the catalogue and the override stops
     * meaning anything — and it gets worse, because the catalogue is age-gated
     * by `PLAN_FROM_CATALOGUE_MAX_AGE_MS` and a credentials file is not, so a
     * tier copied here becomes a ceiling that never expires. An upgrade would
     * leave the customer pinned to the plan they had on the day they logged in.
     * The write side belongs to the GATEWAY sending `plan` at login.
     */
    plan: typeof parsed?.plan === 'string' && parsed.plan.trim() ? parsed.plan.trim() : null,
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
export function writeAccount({ token, email = null, gatewayUrl = null, plan = null }, env = process.env, home = homedir()) {
  const trimmed = String(token ?? '').trim();
  if (!trimmed) return { ok: false, error: 'a token is required' };

  const dir = accountDir(env, home);
  const path = credentialsPath(env, home);
  mkdirSync(dir, { recursive: true });

  const body = { token: trimmed };
  if (email) body.email = String(email).trim();
  if (gatewayUrl) body.gatewayUrl = String(gatewayUrl).trim();
  /**
   * ⚠️ WRITTEN ONLY WHEN THE SERVER SENDS ONE. An absent plan must stay absent
   * rather than become `"free"`: absent means "the gateway has not told us",
   * which resolves to unmetered, and `"free"` is a 10M-unit ceiling that would
   * start refusing a customer on no evidence at all.
   */
  if (plan) body.plan = String(plan).trim();
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');

  /**
   * ⚠️ MEASURED: `chmod 600` is accepted and does nothing on win32. Reporting
   * "permissions restricted" there would be a security control announcing a
   * success it did not achieve, which stops the reader looking any further.
   */
  let restricted = false;
  let note = null;
  if (platform() === 'win32') {
    /**
     * ── ⭐⭐ WINDOWS CAN RESTRICT THIS FILE. IT JUST CANNOT DO IT WITH chmod ───
     *
     * Roman's first successful login printed *"WARNING: could not restrict
     * permissions on the credentials file — check it yourself"*, which is an
     * honest message and a bad one: it hands a security problem back to the user
     * with no way to act on it, in the first thirty seconds of using the product.
     *
     * ⭐ `icacls` is the NTFS equivalent and ships with Windows. `/inheritance:r`
     * drops the inherited ACEs — the ones that let Administrators and often
     * `Users` read it — and `/grant:r USER:F` leaves exactly one principal. That
     * is `chmod 600`, spelled the way this filesystem spells it.
     *
     * ⚠️ SPAWNED, NOT SHELLED. `spawnSync` with an argv array means a username
     * containing a space or a quote is an argument, never syntax. This file's
     * whole job is to hold a credential; it must not be the place that
     * introduces a command injection.
     *
     * ⚠️ AND A FAILURE IS STILL REPORTED HONESTLY. If icacls is missing or the
     * volume is FAT32 (no ACLs at all), `restricted` stays false and the note
     * says so, because the previous behaviour was right about the principle: a
     * security control must never announce a success it did not achieve.
     */
    try {
      const user = userInfo().username;
      const r = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5_000,
      });
      if (r.status === 0) restricted = true;
      else note = 'could not restrict file permissions with icacls — this file may be readable by other accounts on this machine';
    } catch {
      note = 'could not restrict file permissions on Windows — this file may be readable by other accounts on this machine';
    }
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
/** The one way to deliberately spend your own provider credit. */
export const BYOK_OPT_IN_ENV = 'ACUVO_BYOK';

export function resolveCredential(env = process.env, home = homedir()) {
  const account = readAccount(env, home);
  if (account) {
    return { mode: 'account', token: account.token, url: account.gatewayUrl, email: account.email };
  }

  const byok = String(env?.OPENROUTER_API_KEY ?? '').trim();

  /**
   * ── ⚠️⚠️ A STRAY KEY IN THE ENVIRONMENT NO LONGER SILENTLY TAKES OVER ──────
   *
   * This used to fall straight through to `OPENROUTER_API_KEY`, and the cost of
   * that was measured on Roman's own machine 2026-08-23: **no account file, so
   * every CLI run he had ever made was billed to his personal OpenRouter
   * balance and bypassed our metering entirely.** `console.cli_usage` had ONE
   * CLI row for that reason — the owner of the product was not using the
   * metered path, so the meter could not have been validated even in principle.
   *
   * ⭐ AND THAT IS THE MILD VERSION. For a paying customer it is a billing
   * failure: a stray key in a shell profile means they burn THEIR OWN credit
   * believing their plan covers it, and the first evidence is someone else's
   * invoice. Roman's rule — *"BYOK = never, it defeats the product completely"*
   * — is the product argument; this is the same conclusion reached from the
   * billing side.
   *
   * ⚠️ NOT DELETED, GATED. Removing the mode outright would brick the machines
   * that legitimately run on a key today, including our own dev boxes and CI.
   * Requiring `ACUVO_BYOK=1` keeps that door open for anyone who MEANT it while
   * closing the one nobody chose.
   */
  /**
   * ⚠️⚠️ AND THE FIX IS A WARNING, NOT A GATE — I TRIED THE GATE FIRST AND IT
   * WAS THE WRONG SHAPE.
   *
   * Requiring `ACUVO_BYOK=1` to use a key at all turned 12 tests red across 45
   * files, and the first one to fail was the guard that exists precisely to stop
   * this: *"BYOK still works — nobody using it today gets broken."* It was
   * right. The harm here is the SILENCE, not the fallback: somebody who
   * deliberately exports a key and gets billed for it has no complaint, while
   * somebody with a stray key in a shell profile never learns why their Acuvo
   * credits are untouched.
   *
   * ⭐ So the fallback stays and `unspoken` carries the distinction: opted in
   * means they chose this, absent means they probably did not and should be
   * told once, loudly, with the command that fixes it.
   */
  const optedIn = String(env?.[BYOK_OPT_IN_ENV] ?? '').trim() === '1';
  if (byok) return { mode: 'byok', token: byok, url: null, email: null, unspoken: !optedIn };

  return { mode: 'unconfigured', token: '', url: null, email: null };
}
