/**
 * ── ⚠️⚠️ A HELPER CHILD MUST NEVER DECIDE WHEN ITS OWNER EXITS ──────────────
 *
 * This module exists because the same defect was found FOUR times in one night,
 * in four unrelated files, and each time it presented as something else.
 *
 * The shape: we `spawn` a long-lived helper — a REPL driver, tsserver, an LSP,
 * an MCP server — with `stdio: ['pipe','pipe','pipe']`. Node then keeps the
 * event loop alive for that child AND, separately, for each of its three pipes.
 * A process with no work left cannot exit. It does not crash and it does not
 * report anything; it simply sits there, which is indistinguishable from being
 * busy. Measured 2026-08-12: it made a 44-second test suite look like a
 * five-minute one, and a stranger's fresh clone of the public repo exit 1.
 *
 * ⭐ THE FOUR HANDLES ARE SEPARATE. `child.unref()` releases the process handle
 * and NOTHING ELSE — stdin, stdout and stderr are three more libuv handles and
 * any one of them holds the loop open on its own. Unreffing three of four is a
 * hang. That is precisely the mistake this file exists to stop repeating.
 *
 * ⭐ UNREF DOES NOT DETACH OR SILENCE. Data still flows, replies still arrive,
 * the child still runs. Unref removes exactly one thing: "a helper is open" as
 * a reason for the owner to stay alive. While a request is genuinely in flight,
 * that request's own timeout timer keeps the loop up — which is the correct
 * reason to be waiting, and the only one.
 *
 * ⚠️ AND KILLING IS NOT A SUBSTITUTE. `killProcessTree` spawns `taskkill` on
 * Windows and returns before the child is gone, so a kill-then-exit path is a
 * race that the busy machine loses. Detaching is a guarantee; killing is
 * housekeeping. Do both, in that order of trust.
 */

/**
 * Stop a spawned helper from holding its owner's event loop open.
 *
 * Safe to call on a stubbed child in a test, on a child that has already
 * exited, and more than once.
 *
 * @param {import('node:child_process').ChildProcess | null | undefined} child
 * @returns {boolean} whether anything was unref'd — false for a stub with no handles
 */
export function detachChild(child) {
  if (!child) return false;
  let touched = false;
  try { if (typeof child.unref === 'function') { child.unref(); touched = true; } } catch { /* stub */ }
  for (const pipe of [child.stdin, child.stdout, child.stderr]) {
    try { if (pipe && typeof pipe.unref === 'function') { pipe.unref(); touched = true; } } catch { /* closed */ }
  }
  return touched;
}

/**
 * Remove a session from a registry ONLY if that registry still holds this exact
 * session.
 *
 * ⚠️ THE BUG THIS PREVENTS: `child.on('exit')` fires asynchronously — long after
 * a reset removed the entry and a later call registered a REPLACEMENT under the
 * same key. An unconditional `map.delete(key)` in that late handler removes the
 * LIVE successor, so the next reset answers "nothing was running" while a real
 * child is still there, and no code path can ever release it.
 *
 * @param {Map<any, any>} registry
 * @param {any} key
 * @param {any} session the session THIS handler belongs to
 * @returns {boolean} whether the entry was removed
 */
export function deleteIfCurrent(registry, key, session) {
  if (!registry || typeof registry.get !== 'function') return false;
  if (registry.get(key) !== session) return false;
  registry.delete(key);
  return true;
}
