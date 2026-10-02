/**
 * ── ⭐⭐⭐ THE HOLE `command.mjs` NAMES AND DOES NOT CLOSE ────────────────────
 *
 * `command.mjs` is honest about its own boundary, and the last paragraph of its
 * header is the reason this file exists, quoted verbatim:
 *
 *   "⚠️ AND THE HOLE THAT IS *NOT* CLOSED, NAMED RATHER THAN HIDDEN: the code
 *    the command runs can do anything Node can do, including writing outside
 *    the workspace. **The mitigation is not a technical one** — it is that the
 *    code is ON DISK, was written by tools that could not leave the workspace,
 *    and is shown to you."
 *
 * ⚠️ MEASURED ON THIS MACHINE BEFORE A LINE OF THIS FILE WAS WRITTEN (Windows
 * 11 arm64, Node v22.17.0). A script the agent wrote, run through the ordinary
 * `node <file>` door — the FIRST entry on the default four-binary allowlist:
 *
 *     write to a path outside the workspace   → ALLOWED
 *     read a credential file outside it       → ALLOWED, contents returned
 *     spawn a further child process           → ALLOWED
 *
 * That is not a flaw in the allowlist. The allowlist is doing its job perfectly:
 * it stopped the agent COMPOSING a command and stopped it PICKING a program. It
 * has no opinion at all about what the program does once it is running, and it
 * cannot have one, because it is a string check and this is a kernel question.
 *
 * ── ⭐ WHAT WE TOOK FROM CODEX CLI, AND WHAT WE COULD NOT ───────────────────
 *
 * `openai/codex` (Apache-2.0 — verified by reading `LICENSE` at the repo root,
 * 10,926 bytes, "Apache License / Version 2.0, January 2004") answers this with
 * `codex-rs/sandboxing`: one `SandboxManager`, three OS backends behind it, and
 * a `violation.rs` that turns a denial back into something the MODEL can read.
 *
 * ⚠️ NONE OF ITS THREE BACKENDS CAN SHIP HERE, and pretending otherwise would
 * be the failure mode this package is built to avoid. Their sizes, read from
 * the GitHub contents API rather than remembered:
 *   · `windows-sandbox-rs/` — ~400 KB of Rust over Win32 restricted tokens,
 *     ACLs, AppContainer capabilities, the Windows Filtering Platform and a
 *     separate desktop. Unreachable from a package with `"dependencies": {}`
 *     and no native addon; there is no pure-JS route to `CreateRestrictedToken`.
 *   · `seatbelt.rs` + `*.sbpl` — macOS only, and it is genuinely portable in
 *     shape (generate policy text, exec `/usr/bin/sandbox-exec`)…
 *   · `bwrap.rs` / `landlock.rs` — Linux only, and `bwrap` is not installed on
 *     this machine (`which bwrap` → nothing), Landlock needs raw syscalls.
 * ⚠️ …and BOTH of the portable-in-shape ones are unprovable from here: this is
 * a Windows box, `wsl -l -v` lists only a stopped `docker-desktop`, and the
 * Docker daemon is down. Shipping an untested `sandbox-exec` argv builder would
 * be a guard that passes while checking nothing, in a file whose whole subject
 * is guards that check nothing. It is NOT here. See `notDone` in the report.
 *
 * ⭐ SO WHAT SHIPPED IS THE IDEA WITH A BACKEND WE CAN PROVE: **Node's own
 * permission model**, which is an in-process enforcement layer in the V8/libuv
 * boundary — not a string check — and which works on all three platforms with
 * zero dependencies because it is already inside the binary we are spawning.
 * `process.execPath` IS the sandbox host. Codex's contribution to this file is
 * its SHAPE, which is the part worth copying:
 *   1. a named backend, so "sandboxed" is a fact with a value, never a hope
 *      (their `SandboxType` / `get_platform_sandbox`) → `sandboxSupport()`;
 *   2. the boundary computed from the argv about to be spawned, at one choke
 *      point (their `SandboxManager`) → `nodeSandboxFlags()` at
 *      `buildInvocation`, which is the ONE place `run_command`, `start_process`
 *      and `run_program` all pass through;
 *   3. a denial translated back for the model rather than left as a stack trace
 *      (their `violation.rs` / `denial.rs`) → `classifyDenial()`.
 *
 * ⭐ AND ON POINT 3 OURS IS STRICTLY BETTER THAN THEIRS, for a reason that is
 * not cleverness but luck of the backend. `denial.rs` has to GUESS — it greps
 * the output for `["operation not permitted", "permission denied", "read-only
 * file system", "seccomp", "sandbox", "landlock", "failed to write file"]` and
 * says so in its own comment: *"We don't have a fully deterministic way to tell
 * if our command failed because of the sandbox."* Node does not guess. It names
 * the permission and the resource, and this is the literal captured stderr:
 *
 *     code: 'ERR_ACCESS_DENIED',
 *     permission: 'FileSystemWrite',
 *     resource: '\\\\?\\C:\\Users\\angus\\x-esc.txt'
 *
 * so `classifyDenial` parses facts, not keywords, and cannot fire on a test
 * whose own output happens to contain the word "sandbox".
 *
 * ── ⚠️⚠️ WHAT THIS DOES **NOT** BUY. READ BEFORE SELLING IT ─────────────────
 *
 * 1. **THE NETWORK IS NOT GATED.** Measured, not assumed: under the full flag
 *    set a `net.connect()` returned `ECONNREFUSED`, i.e. the socket was created
 *    and the port refused it — the permission model has no network permission
 *    (`process.allowedNodeEnvironmentFlags` contains no `--allow-net`). A
 *    sandboxed script can still POST the workspace anywhere. Codex closes this
 *    with a whole separate crate (`network-proxy`); we have not.
 * 2. **IT COVERS `node <file>` ONLY.** `npm`, `npx` and `tsc` are deliberately
 *    NOT sandboxed: they legitimately read the npm cache, the global prefix and
 *    a user `.npmrc`, all outside the workspace, so scoping them to the
 *    workspace does not harden them — it breaks them. `npm test` therefore
 *    still runs an unsandboxed script body, which is exactly why the script-body
 *    validation in `command.mjs` remains the load-bearing guard there and this
 *    is an addition to it, never a replacement.
 * 3. **`--shell` IS OUTSIDE ALL OF IT.** Under `--shell` the spawned program is
 *    `sh -c`, not node, and there is nothing here to attach to. The sentence in
 *    `command.mjs` — "with `--shell` this agent can run ANY program … there is
 *    no clever middle setting" — is unchanged by this file.
 *
 * ── ⚠️⚠️⭐ THE MIDDLE MODE I ARGUED AGAINST, AND THE MEASUREMENT THAT WON ───
 *
 * THIS FILE FIRST SHIPPED WITH TWO MODES AND A PARAGRAPH HERE EXPLAINING WHY A
 * `--allow-child-process` MIDDLE MODE WOULD BE WORTHLESS. The argument was
 * `command.mjs`'s own line about `--shell` — *"There is no clever middle
 * setting"* — and it was written BEFORE the suite had been run. It was wrong,
 * and the number that made it wrong is worth keeping:
 *
 *   full CLI suite, sandbox on vs `ACUVO_SANDBOX=off`, same tree, same minute:
 *     · filesystem denials caused by this file  … 0 test regressions
 *     · child-process denials caused by this file … 5, in 4 files
 *   and EVERY ONE of the five was node spawning node or npm to do ordinary work:
 *     `node --test <glob>` · `npm test` in a script body · `node setup.js`
 *     running an install · the DONE default running its check · run_program's
 *     verification. Not exotic. The most common thing an agent's script does.
 *
 * ⭐ SO THE REAL SHAPE OF THE TRADE, WHICH ONLY THE MEASUREMENT SHOWS:
 *   · The FILESYSTEM boundary is free. It broke nothing at all.
 *   · The CHILD-PROCESS denial is what costs, and it costs a lot.
 *
 * ⚠️ AND THE THING THAT MUST NOT BE SOFTENED WHEN SELLING THIS: with child
 * processes allowed, the filesystem boundary DOES NOT SURVIVE A DELIBERATE
 * ESCAPE. Node's permission model is per-process and is NOT inherited, so a
 * sandboxed script can `spawn(process.execPath, ['-e', …])` and that child has
 * no boundary at all. Node says so itself, and we do not suppress the sentence,
 * only the repetition of it:
 *
 *     SecurityWarning: The flag --allow-child-process must be used with extreme
 *     caution. It could invalidate the permission model.
 *
 * So the honest statement of what each mode buys, and neither is oversold:
 *
 *   `workspace` (DEFAULT) — makes an ACCIDENT impossible and a CARELESS
 *      mistake impossible: the misjudged `../../` relative path, the script
 *      that writes its output to `~`, the injected "read the .env next door and
 *      print it" that a model complies with in one obvious line. It does not
 *      stop an attacker who knows this paragraph. Cost: zero, measured.
 *   `strict` — also denies child processes, workers, native addons and WASI, so
 *      the boundary holds against a deliberate escape too. Cost: the five
 *      capabilities above. This is the mode for an unattended run on someone
 *      else's repository, and it is opt-in because it is not free.
 *   `off` — the behaviour before this file existed.
 *
 * ⚠️ THE `SecurityWarning` IS SUPPRESSED IN `workspace` MODE, BY TYPE, AND ONLY
 * THERE. `--disable-warning=SecurityWarning` is verified to leave
 * `DeprecationWarning` untouched, so nothing the agent needs to see is lost. It
 * is suppressed because the warning is addressed to a HUMAN choosing node flags
 * once, and here it would be re-printed into the model's captured stderr on
 * every single run — a per-round token cost and a line the model must reason
 * around, attached to a configuration it did not choose. What the warning says
 * is instead said once, to the human, by `describeSandbox()` and by this header.
 */

import { sep as pathSep } from 'node:path';

/**
 * `off` = the behaviour before this file existed · `workspace` = the filesystem
 * boundary, which measured zero cost · `strict` = also no child process, worker,
 * addon or WASI, which measured five. See the header for the numbers.
 */
export const SANDBOX_MODES = Object.freeze(['off', 'workspace', 'strict']);
export const DEFAULT_SANDBOX_MODE = 'workspace';
export const SANDBOX_ENV = 'ACUVO_SANDBOX';

/**
 * ⚠️ SUPPRESSED BY TYPE, NOT BY BLANKET. `--no-warnings` and `NODE_NO_WARNINGS`
 * would also swallow the `DeprecationWarning` an agent genuinely needs to read;
 * `--disable-warning=SecurityWarning` was verified to leave that one through.
 */
export const SECURITY_WARNING_FLAG = '--disable-warning=SecurityWarning';
export const ALLOW_CHILD_FLAG = '--allow-child-process';

/**
 * The stable spelling is `--permission` (Node 23+); `--experimental-permission`
 * is the Node 20/22 name and both are accepted by v22.17.0, measured. We prefer
 * the stable one when the running binary offers it and fall back rather than
 * refusing, because a Node that only knows the experimental spelling can still
 * enforce.
 */
export const PERMISSION_FLAGS = Object.freeze(['--permission', '--experimental-permission']);

/**
 * ⚠️ EVERY ONE OF THESE MUST EXIST OR WE DO NOT CLAIM A SANDBOX. A Node that
 * knows `--permission` but not `--allow-fs-write` would happily start with an
 * EMPTY write allowance, and the run would fail on its first legitimate write
 * looking like a bug in the agent. Checking the whole set is what makes
 * `available: false` mean "fall back cleanly" instead of "break quietly".
 */
export const REQUIRED_FLAGS = Object.freeze(['--allow-fs-read', '--allow-fs-write']);

/**
 * Ask the binary we are about to spawn what it can do — not the changelog.
 *
 * ⭐ `process.allowedNodeEnvironmentFlags` is THE right source here and it is a
 * coincidence worth stating: `buildInvocation` spawns `process.execPath`, i.e.
 * this exact interpreter, so a set read in-process describes the child exactly.
 * It costs no spawn, no probe and no clock. If that ever stops being true —
 * someone passes a different `execPath` — pass `flags: null` and this returns
 * unavailable, which is the safe direction.
 */
export function sandboxSupport({
  flags = process.allowedNodeEnvironmentFlags,
  version = process.versions?.node ?? '',
} = {}) {
  const has = (f) => {
    try { return Boolean(flags && typeof flags.has === 'function' && flags.has(f)); }
    /* c8 ignore next */
    catch { return false; }
  };
  const flag = PERMISSION_FLAGS.find(has) ?? null;
  const missing = REQUIRED_FLAGS.filter((f) => !has(f));
  /**
   * ⚠️ NOT IN `REQUIRED_FLAGS`. A Node too old for `--disable-warning` can still
   * enforce the boundary perfectly — it just also prints one SecurityWarning per
   * run. Refusing to sandbox at all over a cosmetic line would trade a real
   * security property for tidiness, which is the wrong direction.
   */
  const canSuppressSecurityWarning = has('--disable-warning');
  if (!flag) {
    return { available: false, flag: null, missing: [...PERMISSION_FLAGS], version, canSuppressSecurityWarning,
      reason: `this Node (v${version}) has no permission model — neither ${PERMISSION_FLAGS.join(' nor ')} is a recognised flag` };
  }
  if (missing.length) {
    return { available: false, flag, missing, version, canSuppressSecurityWarning,
      reason: `this Node (v${version}) knows ${flag} but not ${missing.join(', ')}, so a boundary here could not be described` };
  }
  return { available: true, flag, missing: [], version, canSuppressSecurityWarning, reason: null };
}

/**
 * ⚠️ THE COMMA. Node's permission flags once took a comma-separated list, and
 * a workspace whose path contains a comma is a real thing on a real disk. On
 * v22.17.0 the comma no longer splits — measured, the write inside such a
 * workspace was ALLOWED — but Node prints
 *
 *     Warning: The --allow-fs-write CLI flag has changed. Passing a
 *     comma-separated list of paths is no longer valid.
 *
 * on EVERY run in that directory, into the stderr this package captures and
 * hands to the model. That is a paid-for, confusing line attached to a correct
 * run forever, and on an older Node in the supported range it is not a warning
 * at all — it is a silently wrong boundary. So a comma disables the sandbox
 * with a stated reason, which is the fail-open direction and is visible.
 */
export function rootIsDescribable(root) {
  const value = String(root ?? '');
  if (!value) return { ok: false, reason: 'no workspace root was given' };
  if (value.includes(',')) {
    return { ok: false, reason: 'the workspace path contains a comma, which Node\'s permission flags cannot describe unambiguously' };
  }
  return { ok: true, reason: null };
}

/**
 * `<root><sep>*` — one flag value, not two.
 *
 * ⭐ MEASURED rather than assumed: the trailing `*` form ALONE already permits
 * `readdirSync(root)`, `statSync(root)` and `realpathSync(root)`, and
 * `process.permission.has('fs.read', root)` returns true under it. Passing the
 * bare directory as a second value is therefore argv noise, and argv noise on
 * the most security-sensitive line in the package is how a future reader
 * concludes the bare form was load-bearing and keeps it.
 */
export function sandboxRootSpec(root, { sep = pathSep } = {}) {
  const value = String(root ?? '').replace(/[\\/]+$/, '');
  return `${value}${sep}*`;
}

/**
 * Resolve the mode. Env beats the default; anything unrecognised is a REFUSAL
 * to guess rather than a silent fallback to `off`, because "ACUVO_SANDBOX=on"
 * quietly meaning "off" is the worst answer available.
 */
export function resolveSandboxMode({ env = process.env, requested = null } = {}) {
  const raw = requested ?? env?.[SANDBOX_ENV] ?? null;
  if (raw == null || raw === '') return { mode: DEFAULT_SANDBOX_MODE, source: 'default', error: null };
  const value = String(raw).trim().toLowerCase();
  if (SANDBOX_MODES.includes(value)) {
    return { mode: value, source: requested != null ? 'flag' : SANDBOX_ENV, error: null };
  }
  return {
    mode: DEFAULT_SANDBOX_MODE,
    source: 'default',
    error: `${SANDBOX_ENV}=${raw} is not a mode. Use one of: ${SANDBOX_MODES.join(', ')}.`,
  };
}

/**
 * The whole decision, in one pure function, returning the flags to splice in
 * front of the script path — and a `reason` whenever it returns none, because
 * "the sandbox silently did not apply" is the failure this package keeps
 * finding in other people's guards.
 */
export function nodeSandboxFlags(root, {
  mode = DEFAULT_SANDBOX_MODE,
  support = sandboxSupport(),
  sep = pathSep,
} = {}) {
  if (mode === 'off') return { on: false, flags: [], mode, reason: `${SANDBOX_ENV}=off` };
  if (!support.available) return { on: false, flags: [], mode, reason: support.reason };
  const describable = rootIsDescribable(root);
  if (!describable.ok) return { on: false, flags: [], mode, reason: describable.reason };
  const spec = sandboxRootSpec(root, { sep });
  /**
   * ⚠️ ORDER IS NOT COSMETIC. Node stops treating these as its own options at
   * the first non-option argument, so every one of them must precede the script
   * path. `buildInvocation` splices this array in FRONT of `rest`.
   */
  const flags = [support.flag, `--allow-fs-read=${spec}`, `--allow-fs-write=${spec}`];
  /**
   * ⭐ THE ONE LINE THAT IS THE WHOLE MEASURED TRADE-OFF. Granting this is what
   * takes the regression count from 5 to 0, and it is also what makes the
   * boundary survivable by a deliberate escape. Both halves are true; see the
   * header. `strict` withholds it and pays the five.
   */
  const childAllowed = mode !== 'strict';
  if (childAllowed && support.canSuppressSecurityWarning) {
    flags.push(ALLOW_CHILD_FLAG, SECURITY_WARNING_FLAG);
  } else if (childAllowed) {
    flags.push(ALLOW_CHILD_FLAG);
  }
  return { on: true, mode, reason: null, spec, childAllowed, flags };
}

/**
 * ⚠️ THE REGEXES ARE BUILT FROM LITERALS, NOT FROM TEMPLATE STRINGS.
 *
 * This lane was handed the trap explicitly: a `RegExp` assembled from a template
 * literal containing a single backslash before `b` is the BACKSPACE character,
 * matches nothing, and the guard goes green against text that plainly contains
 * the word. Nothing here is assembled. These four are literal `/…/` regexes so
 * there is no escaping layer between what is written and what is matched.
 */
const DENIED_CODE = /ERR_ACCESS_DENIED/;
const DENIED_PERMISSION = /permission:\s*'([^']+)'/;
const DENIED_RESOURCE = /resource:\s*'([^']*)'/;

/**
 * The Windows long-path prefix Node stamps onto the resource it reports. It is
 * true and it is noise; a model reading `\\?\C:\Users\…` has to work out that
 * it is the same path it typed.
 */
const WIN_LONG_PATH = /^\\\\\?\\/;

/**
 * Turn a denial back into a sentence with a next move in it.
 *
 * ⚠️ IT FIRES ONLY WHEN WE ACTUALLY SANDBOXED. `sandboxed: false` returns
 * `denied: false` unconditionally, so a program that prints the string
 * `ERR_ACCESS_DENIED` in its own test output — which a test suite for THIS
 * feature certainly does — can never be reported as a sandbox denial. Codex's
 * `denial.rs` guards the same way with `if sandbox_type == SandboxType::None`.
 */
export function classifyDenial({ exitCode = 0, stdout = '', stderr = '', sandboxed = false } = {}) {
  if (!sandboxed) return { denied: false, permission: null, resource: null, lines: [] };
  if (exitCode === 0) return { denied: false, permission: null, resource: null, lines: [] };
  const text = `${String(stderr ?? '')}\n${String(stdout ?? '')}`;
  if (!DENIED_CODE.test(text)) return { denied: false, permission: null, resource: null, lines: [] };

  const permission = DENIED_PERMISSION.exec(text)?.[1] ?? null;
  const rawResource = DENIED_RESOURCE.exec(text)?.[1] ?? null;
  const resource = rawResource ? rawResource.replace(/\\\\/g, '\\').replace(WIN_LONG_PATH, '') : null;

  const what = {
    FileSystemRead: 'READ a file outside the workspace',
    FileSystemWrite: 'WRITE a file outside the workspace',
    ChildProcess: 'spawn another process',
    WorkerThreads: 'start a worker thread',
    Addon: 'load a native addon',
    WASI: 'start a WASI instance',
  }[permission] ?? 'do something outside the workspace boundary';

  const lines = [
    `⚠️ SANDBOX DENIED THIS — the exit code above is the sandbox, not a bug in the code.`,
    `The script tried to ${what}${resource ? `: ${resource}` : ''}.`,
    `acuvo runs \`node <file>\` with Node's permission model scoped to the workspace, so a`,
    `script it wrote cannot read your credentials or write outside the project.`,
    `Fix the script to stay inside the workspace. If the path outside really is the point of`,
    `the task, the human — not you — can re-run with ${SANDBOX_ENV}=off.`,
  ];
  return { denied: true, permission, resource, lines };
}

/**
 * One line for `--doctor` and for anyone asking "is it actually on here?".
 * Deliberately says the negative case in full: a doctor line that only prints
 * when things are fine is a doctor line nobody reads.
 */
export function describeSandbox({ root = process.cwd(), env = process.env, support = sandboxSupport() } = {}) {
  const { mode, source, error } = resolveSandboxMode({ env });
  const decided = nodeSandboxFlags(root, { mode, support });
  if (decided.on) {
    /**
     * ⚠️ THE `workspace` LINE SAYS THE WEAKNESS OUT LOUD. It is the sentence
     * Node's own suppressed SecurityWarning would have said, moved to the place
     * a human actually reads, which is the whole justification for suppressing
     * the repetition of it in every captured stderr.
     */
    const caveat = decided.childAllowed
      ? 'Child processes are ALLOWED, and a spawned child does NOT inherit this boundary — this stops accidents and careless writes, not a deliberate escape. ACUVO_SANDBOX=strict closes that too, at the cost of `npm test`-style spawns from inside a script.'
      : 'strict: child processes, workers, native addons and WASI are denied as well.';
    return { on: true, line: `sandbox: ON (${decided.mode}) — \`node <file>\` is confined to ${decided.spec} (Node ${support.version} permission model, ${support.flag}). ${caveat} Network is NOT gated; npm/npx/tsc and --shell are outside it entirely.`, error };
  }
  return { on: false, line: `sandbox: OFF — ${decided.reason}. A script run by \`node <file>\` can read and write anywhere this user can.`, error };
}
