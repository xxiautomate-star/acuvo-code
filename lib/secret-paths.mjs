/**
 * ── ⚠️⚠️ THE ONE LIST OF PATHS THAT MUST NEVER LEAVE THIS MACHINE ───────────
 *
 * This lived in `git.mjs`, and it stays exactly as it was — only its address
 * changed. The move was forced by a CYCLE, and the cycle is worth recording
 * because it is the shape that decides where a shared rule can live at all:
 *
 *     lib/command.mjs → lib/workspace.mjs → lib/git.mjs → lib/command.mjs
 *
 * `workspace.mjs` gained `moveFile`, which has to consult this list — a rename
 * is the one verb that can relabel `.env` into something committable. Importing
 * it from `git.mjs` closed that loop. Node runs a cycle happily (the module
 * loaded, every test passed), so nothing looked wrong; `scripts/bundle.mjs`
 * cannot topologically order one, and `npm run bundle` would have failed at
 * ship time. The bundle test caught it, which is the whole reason that test
 * exists.
 *
 * ⭐ SO THE LIST IS NOW A LEAF: it imports nothing, and therefore anything may
 * import it. That is the property, not a tidiness preference.
 *
 * ⚠️⚠️ AND IT REALLY IS ONE LIST. `read-window.mjs` once kept a second one
 * (`CREDENTIAL_BASENAME`) for `read_lines` and `read_around`, written
 * separately, and the two DISAGREED. Measured 2026-08-13 through the real
 * dispatcher:
 *
 *   read_lines LEAKED : vault.pfx · keys.jks · secrets.json · credentials.yml
 *                       · service-account.json
 *   read_file  LEAKED : .git-credentials
 *
 * Each list covered holes the other left, so which of a user's secrets were
 * protected depended on which verb the model happened to pick. Add the next
 * pattern HERE and every consumer gains it at once.
 */

const NEVER_COMMIT = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|pfx|p12|key|keystore|jks)$/i,
  /(^|\/)(credentials|secrets?|service-account)\.(json|ya?ml)$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.aws\//i,
  // ⭐ Contributed by the list this one absorbed. Git stores plaintext
  // usernames and passwords here, which is precisely the file it is named for.
  /(^|\/)\.git-credentials$/i,
];

/**
 * @param {string} path a workspace-relative path
 * @returns {string|null} the refusal to show the model, or null if it is fine
 */
export function refusedCommitPath(path) {
  const hit = NEVER_COMMIT.find((rx) => rx.test(path));
  return hit ? `${path} looks like a credential file — this agent never commits one, because history keeps it after you delete it` : null;
}
