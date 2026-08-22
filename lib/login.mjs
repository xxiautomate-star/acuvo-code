/**
 * ── ⚠️⚠️⚠️ THE ONE MISSING LINK IN THE PAID PRODUCT ─────────────────────────
 *
 * Measured 2026-08-19. Every part of "you buy Acuvo credits and never see a
 * provider key" exists EXCEPT the step that stores the credential:
 *
 *   ✅ the user mints a key in the console          `app/[tenantSlug]/api-keys`
 *   ✅ the gateway verifies it and meters usage     `/api/cli/v1/chat/completions`
 *   ✅ the CLI reads it                             `account.mjs:resolveCredential`
 *   ❌ NOTHING EVER WRITES `~/.acuvo/credentials`
 *
 * `writeAccount` is exported, documented, and called by **nothing but its own
 * tests**. So `resolveCredential` finds no account, falls through to
 * `OPENROUTER_API_KEY`, and every user is on BYOK — which `account.mjs`'s own
 * header calls out as *"never the plan"* and which makes *"the product's
 * storefront an advertisement for somebody else."*
 *
 * ⭐ One command is the difference between a wrapper and a product. This is it.
 *
 * ── ⚠️ WHY IT VERIFIES BEFORE IT WRITES ─────────────────────────────────────
 *
 * A saved-but-invalid token is the worst outcome available: every later run
 * fails at the model call, far from the mistake, with an error about chat
 * completions rather than about login. Verifying costs one round trip at the
 * only moment the user is thinking about credentials.
 *
 * ── ⚠️ AND WHY THE TOKEN CAN COME FROM STDIN ────────────────────────────────
 *
 * `acuvo --login xxi_live_…` puts a live credential in shell history, in
 * `ps` output, and in any terminal recording. `gh auth login --with-token`
 * reads stdin for exactly this reason. Both spellings are supported; the piped
 * one is the one the docs should show.
 *
 * Pure and dependency-free apart from an injected `fetch`, so the whole thing
 * is testable without a network or a home directory.
 */

/** The shape the console mints — `generateApiKey()` in `lib/api-auth.ts`. */
const TOKEN_RE = /^xxi_live_[0-9a-f]{64}$/;

/**
 * Is this the right SHAPE? Cheap, offline, and it catches the overwhelmingly
 * common mistakes — a pasted prefix from the UI table, a truncated copy, a
 * whole `Authorization: Bearer …` header, or somebody's OpenRouter key.
 *
 * ⚠️ Shape is not validity. It never claims the key works; that is the
 * gateway's answer and this function must not be mistaken for it.
 */
export function validateTokenShape(raw) {
  const token = String(raw ?? '').trim();
  if (!token) {
    return { ok: false, reason: 'no token given. Paste the key you created at Settings → API keys, or pipe it: `acuvo --login < key.txt`' };
  }
  if (/^Bearer\s/i.test(token)) {
    return { ok: false, reason: 'that is a whole Authorization header — pass just the key, starting `xxi_live_`' };
  }
  if (token.startsWith('sk-') || token.startsWith('sk_')) {
    return { ok: false, reason: 'that looks like a provider key (OpenRouter/OpenAI). Acuvo Code uses an ACUVO key so your usage is billed to your Acuvo credits — create one at Settings → API keys.' };
  }
  if (!token.startsWith('xxi_live_')) {
    return { ok: false, reason: 'an Acuvo key starts `xxi_live_`. Create one at Settings → API keys and copy the whole value — it is only shown once.' };
  }
  if (!TOKEN_RE.test(token)) {
    return { ok: false, reason: 'that key looks truncated. The console shows an abbreviated PREFIX in the table; copy the full value from the dialog shown when you created it.' };
  }
  return { ok: true, token };
}

/**
 * Ask the gateway whether the key actually works, with the smallest possible
 * request.
 *
 * ⚠️ `max_tokens: 1` because this is a real completion and therefore a real
 * (tiny) charge against the user's credits. Verifying must not be something a
 * user pays meaningfully for, and a request that bills a cent to check a
 * password would be a bad trade.
 *
 * ⚠️ THE FAILURE MODES ARE SEPARATED ON PURPOSE. "Your key is wrong",
 * "your account has no credit" and "we could not reach the gateway" need three
 * different actions from the user, and collapsing them into "login failed" is
 * how someone on a plane deletes a perfectly good credential.
 */
export async function verifyToken(token, gatewayUrl, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(gatewayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'probe', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message ?? '')));
    return {
      ok: false,
      kind: 'unreachable',
      reason: aborted
        ? `the gateway did not answer within ${Math.round(timeoutMs / 1000)}s. Your key was NOT saved; try again when you have a connection.`
        : `could not reach the gateway (${String(err?.message ?? err)}). Your key was NOT saved.`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: 'rejected', reason: 'the gateway rejected that key. Check it was copied whole, and that it has the `cli.run` scope.' };
  }
  if (res.status === 402) {
    return { ok: false, kind: 'no-credit', reason: 'that key is valid but the account has no credits. Top up, then log in again.' };
  }
  /**
   * ⭐ ANY OTHER STATUS COUNTS AS AUTHENTICATED, and that is deliberate. A 400
   * about the `probe` model, a 429, a 500 — all of them mean the gateway got
   * past auth to have an opinion about the request. Demanding a 200 would make
   * login fail whenever the upstream provider was briefly unhappy, which is
   * precisely when a user should still be able to configure their machine.
   */
  return { ok: true, kind: 'ok', status: res.status };
}

/** Never print a live credential. The prefix is enough to identify it. */
export function maskToken(token) {
  const t = String(token ?? '');
  return t.length <= 17 ? t : `${t.slice(0, 17)}…`;
}

/**
 * The human line for `--whoami`, from `resolveCredential`'s result.
 *
 * ⚠️ `byok` IS REPORTED AS A WARNING, not as a success. It works, but it bills
 * the user's own provider account instead of their Acuvo credits, which means
 * they are paying twice and we are metering nothing — so the state has to be
 * visible rather than silently fine.
 */
export function describeAuth(cred) {
  if (!cred || cred.mode === 'unconfigured') {
    return {
      ok: false,
      line: 'Not logged in. Create a key at Settings → API keys (scope `cli.run`), then: acuvo --login < key.txt',
    };
  }
  if (cred.mode === 'byok') {
    return {
      ok: true,
      warn: true,
      line: 'Using OPENROUTER_API_KEY from your environment (BYOK).\n'
        + '  ⚠️ This bills YOUR provider account, not your Acuvo credits, and nothing is metered.\n'
        + '  Run `acuvo --login` with an Acuvo key to use your credits instead.',
    };
  }
  return {
    ok: true,
    line: `Logged in as ${cred.email ?? 'an Acuvo account'} (${maskToken(cred.token)})\n  gateway: ${cred.url}`,
  };
}
