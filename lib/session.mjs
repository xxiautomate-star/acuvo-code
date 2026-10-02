/**
 * ── ⭐⭐ SESSION PERSISTENCE — THE HORIZON PROBLEM, ATTACKED FROM THE SIDE ───
 *
 * Every run of this CLI starts from nothing. `runSession` builds a system
 * prompt, pre-reads the workspace, spends rounds gathering, and then the
 * process exits and all of it evaporates. The round cap is not a soft limit —
 * `stoppedBecause: 'round-cap'` is the MOST COMMON way a real task ends, and
 * when it does, the user's only recovery is to re-type the prompt and pay for
 * the entire gather a second time.
 *
 * ⭐ THE PLAN LEDGER ALREADY PROVED HALF OF THIS. `plan-ledger.mjs` found that
 * re-issuing an identical command spent 3 of its 4 rounds re-deriving what the
 * previous process had held in memory seconds earlier, and it fixed the WHAT:
 * the outstanding deliverables survive. This file fixes the HOW-MUCH-IS-KNOWN:
 * the conversation itself survives, so a resumed run does not re-read the files
 * it already read, re-run the searches it already ran, or re-discover the shape
 * of a project it already walked. A plan says "3 steps left". A session says
 * "and here is everything I learned getting to them."
 *
 * ── ⚠️ THE THREE RULES THAT MAKE THIS SAFE, AND WHY EACH ONE EXISTS ─────────
 *
 * 1. **NO SECRET IS EVER WRITTEN HERE.** A message history contains file
 *    CONTENTS — `gatherWorkspaceContext` pre-reads the tree, and `read_file`
 *    results are verbatim. `turn.mjs` documents the worst bug this package has
 *    had: that pre-load put `OPENROUTER_API_KEY=sk-or-v1-…`, a database
 *    password and a private key into the prompt, and the provider chain fanned
 *    them to four companies. Writing that same transcript to a FILE is the same
 *    leak with a longer half-life — a prompt is gone when the process is; a
 *    session sits in `.acuvo/` until someone tars the directory up.
 *
 *    So two guards, matching the two the rest of the package already uses:
 *    · `refusedCommitPath` (git.mjs) — the credential-FILE list, reused rather
 *      than re-typed, exactly as `gatherWorkspaceContext` reuses it. A tool call
 *      that touched `.env` or `id_rsa` has its content WITHHELD, not redacted:
 *      the whole file is the secret, so there is nothing in it worth keeping.
 *    · a redactor for conventionally-named credentials, whose name pattern is
 *      the same one `scrubEnvironment` (command.mjs) applies to a child's
 *      environment. See SECRET_NAME below for why it is a copy and what pins it.
 *
 *    ⚠️ AND IT REDACTS RATHER THAN REFUSING, WHICH IS THE OPPOSITE OF
 *    `plan-ledger.mjs`. That file refuses, because its input is the model's own
 *    words chosen milliseconds ago and it can simply choose different ones.
 *    Here the input is a transcript that already happened; refusing to persist
 *    it throws away an entire run's work to avoid writing eight characters we
 *    can just as easily replace. `audit.mjs` settled this argument first: a log
 *    that refuses to be written is a log that does not exist.
 *
 * 2. **A RESUME RECONSTRUCTS CONTEXT AND NEVER REPLAYS A SIDE EFFECT.** This is
 *    the rule with teeth. A recorded round looks like
 *    `assistant(tool_calls) → tool(result)`, and an assistant message carrying
 *    `tool_calls` is not a memory of an action — in an OpenAI-shaped payload it
 *    is a PENDING action. Hand back a history ending in a dangling
 *    `tool_calls` with no matching result and two things happen: most providers
 *    reject the conversation outright, and any that accept it invite the model
 *    to reissue the call it already made. If the call was `run_command`, the
 *    resume just re-ran it. So a trailing unanswered call group is DROPPED, and
 *    `dropDanglingCalls` below is the whole of that guarantee.
 *
 *    This module spawns nothing, imports no `child_process`, and returns only
 *    inert message objects. `test/session.test.mjs` asserts that statically,
 *    because "it doesn't currently" is not a guarantee anyone can rely on.
 *
 * 3. **IT CANNOT GROW WITHOUT BOUND.** `.acuvo/` is a hidden directory in
 *    somebody's project. A file that quietly accumulates megabytes there is a
 *    bug even when every byte is correct. One session is capped
 *    (MAX_SESSION_BYTES), the directory is capped (MAX_SESSIONS), and both caps
 *    are enforced by DROPPING THE OLDEST, never by refusing to write the newest
 *    — a persistence layer whose failure mode is "your most recent run was not
 *    saved" is worse than useless, because you only find out when you need it.
 *
 * ── ⚠️ WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────
 *   · It does not wire itself in. `saveSession` is called by the caller that
 *     owns the loop; see REGISTRATION_SNIPPET at the bottom.
 *   · It offers the model NO resume tool. A model rewriting its own message
 *     history mid-run is precisely the side-effect replay hazard rule 2 exists
 *     to prevent, and there is no task for which it is the right answer.
 *     `session_list` is read-only and that is the entire model-facing surface.
 *   · It never judges a session. "Was the work correct" is the auditor's
 *     question; this file records only what happened and why it stopped.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveInWorkspace } from './workspace.mjs';
import { refusedCommitPath } from './secret-paths.mjs';
import { ensureAcuvoDirIgnored } from './acuvo-dir.mjs';
/** ⭐ The same expansion the run summary uses, so the two counts cannot disagree. */
import { describeChanges } from './report.mjs';

/** Scratch, alongside `plan.json`, `mcp.json` and the screenshots `see_page`
 *  writes. A session is scratch of exactly that kind: useful to the next run,
 *  never part of the user's source tree. */
export const SESSION_DIR = '.acuvo/sessions';
export const SESSION_VERSION = 1;

/** One session file. Roughly a large transcript; past this the value of the
 *  extra history is lower than the cost of reading it back into a prompt. */
export const MAX_SESSION_BYTES = 240_000;
/** How many session files may exist. Twenty is several days of real work and
 *  about five megabytes worst case. */
export const MAX_SESSIONS = 20;
/** Per-message ceiling. A single `read_file` of a 200KB source file would
 *  otherwise be most of the budget on its own. */
export const MAX_MESSAGE_CHARS = 8_000;
/**
 * ── ⚠️⚠️ THE HEAD GETS ITS OWN CEILING, AND THE OLD ONE WAS A CACHE BUG ─────
 *
 * MEASURED 2026-08-22 on a real run against a stub provider, not reasoned about:
 *
 *     live system message   12,118 chars
 *     saved system message   8,117 chars   ← MAX_MESSAGE_CHARS + the truncation note
 *
 * `MAX_MESSAGE_CHARS` was applied to EVERY message including the system one, so
 * a `--resume` handed the provider a prompt that diverged from the original at
 * **character 8,121 of message zero**. Measured end to end (original round-2
 * payload vs resumed round-1 payload): the byte-identical common prefix was
 * **60.8%**, and prefix caching matches from the first token and stops at the
 * first difference — so the divergence being inside message 0 means the WHOLE
 * restored conversation was re-bought at full price. `lib/chat.mjs` puts the
 * value of that prefix at 97.2% cached / 4.3x cheaper; this threw all of it
 * away, silently, on the one code path whose entire justification is not paying
 * twice for work already done.
 *
 * ⚠️ AND THE MONEY IS THE SMALLER HALF. The 4,118 characters that fell off the
 * end of that system message were the SKILLS BLOCK — so a resumed model was
 * reasoning under rules it had never been shown, which is exactly the failure
 * `compact.mjs`'s header names ("the resumed model starts reasoning about
 * instructions it was never given").
 *
 * ⭐ SO THE HEAD IS CAPPED SEPARATELY AND GENEROUSLY. It is bounded by
 * construction anyway — the system message is a prompt this package assembles,
 * and the first user message is `repo-map.mjs`'s output, which has its own
 * budget. 60,000 is ~5x the largest head observed and still a quarter of
 * MAX_SESSION_BYTES, so the file cap below stays the real bound.
 *
 * ⚠️ IT IS A CAP, NOT AN EXEMPTION. A head that somehow exceeds it is still
 * truncated rather than allowed to blow the file limit — but the record then
 * carries `headTruncated: true` so `resumeMessages` can SAY the cache will miss
 * instead of letting someone believe they got the discount.
 */
export const MAX_HEAD_CHARS = 60_000;
export const MAX_TASK_CHARS = 400;
/** The metadata lists are for a HUMAN reading `--sessions`, so they are short
 *  by intent — the full detail is in the messages. */
export const MAX_FILES_RECORDED = 200;
export const MAX_COMMANDS_RECORDED = 100;
export const MAX_COMMAND_OUTPUT_CHARS = 1_500;

/** `memory-workspace.mjs` names the disk-less executor this. */
const MEMORY_ROOT = '(memory)';
const MEMORY_REFUSAL =
  'this workspace has no disk, so a session cannot be saved — there is nothing to resume from and nothing to do about it here';

const err = (e) => (e instanceof Error ? e.message : String(e));

/**
 * ── ⚠️ A DELIBERATE COPY OF `command.mjs`'s SECRET_NAME, AND WHAT PINS IT ───
 *
 * The brief for this module says to scrub "the same conventionally-named
 * credentials the command executor scrubs". The honest way to do that would be
 * to import the pattern — but `command.mjs` does not export it, and this module
 * is not permitted to edit that file. A copy is therefore the only option, and
 * an uncommented copy is how two definitions of "what is a secret" drift until
 * one of them is wrong.
 *
 * ⭐ SO THE TEST PINS THEM WITHOUT EITHER FILE KNOWING ABOUT THE OTHER. It
 * drives the REAL `scrubEnvironment` with a probe environment of ~30 variable
 * names and asserts that every name it strips is a name this pattern matches,
 * and vice versa. The two definitions cannot diverge silently; they can only
 * diverge in a red test that names the offending variable.
 *
 * ⚠️ It is a denylist, and `command.mjs` already explains why that is the
 * conscious exception here: an allowlist of variable names would refuse half of
 * every real project's configuration. `MY_DB_STRING` survives it. This is one
 * layer, not the boundary — rule 1's file-level withholding is the other.
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SESSION|COOKIE|AUTH|_DSN$|CONNECTION_STRING)/i;

/**
 * Literal secrets, recognised by SHAPE rather than by the name next to them.
 * Same list `plan-ledger.mjs` uses to REFUSE, used here to REPLACE — see the
 * header for why the two files answer the same threat differently.
 */
const SECRET_SHAPES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\b(?:sk|rk)-or-v1-[A-Za-z0-9_-]{16,}/g, '[redacted openrouter key]'],
  [/\bsk-[A-Za-z0-9]{16,}/g, '[redacted api key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted aws key id]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted github token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted slack token]'],
];

/**
 * `NAME=value`, `NAME: value`, `"name": "value"` — the assignment form, which
 * is how a credential appears inside a file the agent read rather than inside a
 * key it happened to print.
 *
 * ⚠️ THE VALUE TEST IS WHAT KEEPS THIS FROM EATING THE TRANSCRIPT, AND THE
 * FIRST VERSION OF IT WAS NOT ENOUGH. Matching on the NAME alone turns
 * `let tokenCount = tokens.length;` into `let tokenCount = [redacted]` — caught
 * by the test on the first run, and it is the failure that matters more than
 * the leak in one specific way: a resumed session full of redacted CODE is
 * worse than no resume at all, because the model reasons confidently about text
 * that is not what the file says. A missing secret is a hole you can see.
 *
 * ⭐ SO THE DISCRIMINATOR IS THE FORM OF THE LINE, NOT THE NAME ON IT. Three
 * shapes are credentials-in-a-file and everything else is code:
 *   · QUOTED    — `"apiKey": "abcd1234efgh"`. A quoted literal next to a secret
 *                 name is a hardcoded secret whether it is JSON, YAML or source.
 *   · ENV-STYLE — `DB_PASSWORD=hunter2hunter`, `export GITHUB_TOKEN=aaaa…`. No
 *                 declaration keyword, `=`, no spaces around it: that is a
 *                 dotenv line or a shell export, never an expression.
 *   · OPAQUE    — an unquoted value with letters AND digits and no dotted
 *                 access, not preceded by const/let/var. `hunter2secret` in a
 *                 YAML file qualifies; `tokens.length` and `someVariable` do
 *                 not.
 * A `const`/`let`/`var` line with an unquoted value is never touched, which is
 * what makes `apiKey = process.env.OPENROUTER_API_KEY` survive intact — and it
 * should survive, because the thing it names is not in the file.
 */
const ASSIGNMENT = /^([ \t]*(?:export[ \t]+)?)(const[ \t]+|let[ \t]+|var[ \t]+)?(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\3([ \t]*)([:=])([ \t]*)(\S+)[ \t]*$/gm;
const CODE_SHAPED = /[()${}[\]]|process\.env|import\.meta|require\(/;

/**
 * @param {unknown} text
 * @returns {{ text: string, redactions: number }}
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', redactions: 0 };
  let out = text;
  let hits = 0;
  for (const [rx, replacement] of SECRET_SHAPES) {
    out = out.replace(rx, () => { hits += 1; return replacement; });
  }
  out = out.replace(ASSIGNMENT, (whole, lead, decl, quote, name, before, sep, after, value) => {
    if (!SECRET_NAME.test(name)) return whole;
    if (CODE_SHAPED.test(value)) return whole;
    const bare = value.replace(/^["'`]|["'`,;]+$/g, '');
    if (bare.length < 8) return whole;

    const quoted = /^["'`]/.test(value);
    const envStyle = !decl && sep === '=' && before === '' && after === '';
    const opaque = !decl && !bare.includes('.') && /[0-9]/.test(bare) && /[A-Za-z]/.test(bare);
    if (!quoted && !envStyle && !opaque) return whole;

    hits += 1;
    return `${lead}${decl ?? ''}${quote}${name}${quote}${before}${sep}${after}[redacted]`;
  });
  return { text: out, redactions: hits };
}

/**
 * Would persisting THIS path's contents be persisting a credential file?
 *
 * ⭐ Reuses git.mjs deliberately. That list is already the package's single
 * answer to "files that must never leave this machine", it is already tested,
 * and a second copy is the one that goes stale. `turn.mjs` reuses it for the
 * same reason on the prompt path.
 *
 * @param {unknown} path
 * @returns {boolean}
 */
export function isCredentialPath(path) {
  return typeof path === 'string' && path !== '' && refusedCommitPath(path) !== null;
}

/**
 * ── ⚠️ NO COLONS. This is a FILENAME. ──────────────────────────────────────
 * The obvious id is an ISO timestamp, and `2026-08-10T23:05:11.402Z` cannot be
 * stored on Windows — `workspace.mjs` refuses `:` outright as a character the
 * filesystem will not hold, so the save would fail on the owner's own laptop
 * and nowhere else. `plan-ledger.mjs` hit the identical wall naming its
 * quarantine files and solved it the same way.
 *
 * ⭐ UTC AND FIXED-WIDTH, so lexical order IS chronological order. `listSessions`
 * and `pruneSessions` then need no stat call and no date parsing to know which
 * session is the oldest — a sort of the directory listing is the answer.
 */
export function newSessionId(now = new Date()) {
  const iso = new Date(now).toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  const salt = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${salt}`;
}

const ID_SHAPE = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{2,8}$/;

/**
 * Resolve a file inside the session directory and PROVE it is inside it.
 *
 * ⚠️ EXPORTED FOR THE SAME REASON `resolvePlanFile` IS. Every caller in this
 * module passes an id that this module generated, so the prefix assertion can
 * never fire in production — which is exactly why it would rot unnoticed if it
 * were private. The test drives it with `../../outside`, an absolute path and a
 * traversal spelling.
 *
 * @returns {{ ok: true, absolute: string, relative: string, root: string } | { ok: false, error: string }}
 */
export function resolveSessionFile(root, name) {
  if (typeof root !== 'string' || root.trim() === '') {
    return { ok: false, error: 'no workspace directory was given, so a session cannot be stored' };
  }
  if (root === MEMORY_ROOT) return { ok: false, error: MEMORY_REFUSAL };
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'a session needs an id — call newSessionId(), or pass one from list_sessions' };
  }
  /**
   * ⚠️ A SESSION ID IS ONE FILENAME, NOT A PATH — and the first version of this
   * function did not say so. `resolveInWorkspace` is handed `${SESSION_DIR}/${name}`,
   * so an id of `/etc/passwd` normalised to `.acuvo/sessions/etc/passwd`: still
   * safely inside the workspace, but a nested directory nobody asked for, and a
   * containment check that returns `ok` for `/etc/passwd` reads like a hole even
   * when it is not one. Caught by the test that drives this with absolute paths.
   *
   * The single-segment rule is also what keeps the id and the FILENAME the same
   * string, which is what `listSessions` and `pruneSessions` both rely on.
   */
  if (/[\\/]/.test(name)) {
    return { ok: false, error: `a session id is a single name, not a path — "${name}" contains a directory separator` };
  }

  const r = resolveInWorkspace(root, `${SESSION_DIR}/${name}`, 'write');
  if (!r.ok) return { ok: false, error: r.reason };
  if (!r.relative.startsWith(`${SESSION_DIR}/`)) {
    return { ok: false, error: `sessions are only ever written inside ${SESSION_DIR}/ — "${r.relative}" is outside it` };
  }
  return { ok: true, absolute: r.absolute, relative: r.relative, root: r.root };
}

function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} characters — this is a saved session, not the live file; read the file again if you need the rest]`;
}

/**
 * ── THE PAIRING RULE ───────────────────────────────────────────────────────
 * An OpenAI-shaped conversation is rejected outright when a `tool` message
 * references an id that no preceding `tool_calls` declared — `turn.mjs` already
 * documents that as an HTTP 400 which reads like a bug in the prompt. Trimming
 * a history one message at a time breaks that invariant on the first cut, so
 * this module never handles messages individually: it groups them, and a group
 * is atomic.
 *
 *   · an assistant message WITH tool_calls, plus every `tool` message answering
 *     it, is ONE group
 *   · anything else is a group of one
 *
 * @param {any[]} messages
 * @returns {{ head: any[], groups: any[][] }}
 */
function groupMessages(messages) {
  const head = [];
  const groups = [];
  let i = 0;
  // The system message and the opening user message are the cacheable prefix —
  // the task, the workspace shape, the rules. They are never candidates for
  // dropping, because a history without them is not a resume, it is a new run
  // with confusing extra context.
  while (i < messages.length && messages[i]?.role === 'system') head.push(messages[i++]);
  if (i < messages.length && messages[i]?.role === 'user') head.push(messages[i++]);

  while (i < messages.length) {
    const m = messages[i];
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const group = [m];
      i += 1;
      while (i < messages.length && messages[i]?.role === 'tool') group.push(messages[i++]);
      groups.push(group);
      continue;
    }
    groups.push([m]);
    i += 1;
  }
  return { head, groups };
}

/**
 * ── ⚠️⭐ THE SIDE-EFFECT GUARD ─────────────────────────────────────────────
 *
 * A session can stop in the middle of a round: `stoppedBecause: 'model-error'`
 * breaks the loop right after the assistant message was pushed, and a Ctrl-C
 * lands wherever it lands. What survives is an assistant message carrying
 * `tool_calls` that nothing ever answered.
 *
 * That is not a record of an action. In a replayed payload it is a PENDING
 * action, and the two things that happen next are both bad: strict providers
 * reject the whole conversation, and lenient ones let the model helpfully
 * reissue the call. If the call was `run_command`, the resume just re-ran it —
 * silently, as its first act, before the user has said anything.
 *
 * So an unanswered call group is dropped, and the caller is TOLD how many, so
 * the resume can say "the last round was incomplete and was discarded" rather
 * than pretending the history is whole.
 *
 * ⚠️ It drops the GROUP, never just the assistant message. Keeping the partial
 * tool replies would leave orphaned `tool` messages — the exact 400 the pairing
 * rule exists to prevent, arrived at from the other direction.
 */
function dropDanglingCalls(groups) {
  const kept = [];
  let dropped = 0;
  for (const group of groups) {
    const head = group[0];
    if (head?.role === 'assistant' && Array.isArray(head.tool_calls) && head.tool_calls.length > 0) {
      const answered = new Set(group.slice(1).map((m) => m?.tool_call_id));
      const unanswered = head.tool_calls.filter((c) => !answered.has(c?.id));
      if (unanswered.length > 0) { dropped += 1; continue; }
    }
    kept.push(group);
  }
  return { groups: kept, dropped };
}

/**
 * Which tool_call ids touched a credential file?
 *
 * The leak this closes is specific and easy to miss: the model calls
 * `read_file` on `.env`, and the SECRET is not in the assistant message (which
 * contains only the path) — it is in the `tool` message that answers it. So the
 * ids have to be collected from the call and applied to the reply.
 */
function credentialCallIds(group) {
  const head = group[0];
  const ids = new Set();
  if (head?.role !== 'assistant' || !Array.isArray(head.tool_calls)) return ids;
  for (const call of head.tool_calls) {
    let args = {};
    try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { /* an unparseable call cannot name a path */ }
    const candidates = [args.path, args.file, args.filename, args.pattern];
    if (candidates.some((p) => isCredentialPath(p))) ids.add(call?.id);
  }
  return ids;
}

const WITHHELD =
  '[withheld: this tool call touched a credential file, so its contents were not saved with the session. '
  + 'Read the file again in this run if you need it.]';

/**
 * The keys a saved message may carry, in the order this module falls back to
 * when the source message does not state one of its own.
 *
 * ⚠️ `role` IS PINNED FIRST AND THE REST FOLLOW THE SOURCE — see `orderedKeys`.
 */
const MESSAGE_KEYS = ['role', 'content', 'name', 'tool_call_id', 'tool_calls'];

/**
 * ── ⚠️⭐ THE SAVED MESSAGE MUST SERIALISE IN THE ORDER THE LIVE ONE DID ──────
 *
 * MEASURED 2026-08-22, on the end-to-end crash-and-resume run this file exists
 * for. With the head truncation fixed the restored prompt matched the original
 * for 13,305 of 13,700 characters — and then diverged, on this:
 *
 *     live  : {"role":"tool","tool_call_id":"c_write_file","name":…,"content":…}
 *     saved : {"role":"tool","content":…,"name":…,"tool_call_id":"c_write_file"}
 *
 * Same message, same bytes of meaning, different JSON. `turn.mjs` pushes tool
 * replies as `{role, tool_call_id, name, content}`; this function rebuilt them
 * as `{role, content, name, tool_call_id}` because that is the order the code
 * happened to assign in. Nothing was lost and nothing was wrong — the payload
 * simply stopped being byte-identical at the first tool result, which is round
 * one of every real session.
 *
 * ⭐ SO THE SOURCE'S OWN KEY ORDER IS PRESERVED. Reading `Object.keys(message)`
 * costs nothing and makes the property hold for message shapes this module has
 * not been taught about yet, which an explicit hand-written order would not.
 * `role` is forced first because a `tool_calls`-only object would otherwise
 * bury it, and every consumer reads `role` first.
 */
function orderedKeys(message) {
  const seen = new Set(['role']);
  const keys = ['role'];
  for (const k of Object.keys(message ?? {})) {
    if (!MESSAGE_KEYS.includes(k) || seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  // Anything the source did not name (or named in a shape we skipped) still has
  // to be emitted if we produce a value for it — appended, never interleaved.
  for (const k of MESSAGE_KEYS) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  return keys;
}

/**
 * Scrub and cap one message. Returns a NEW object — the caller's array belongs
 * to a live session that may still be in use, and mutating it here would edit
 * the conversation a running loop is about to send.
 */
function sanitizeMessage(message, { withhold = false, maxChars = MAX_MESSAGE_CHARS } = {}) {
  const value = {};
  let redactions = 0;

  if (typeof message?.content === 'string') {
    if (withhold) {
      value.content = WITHHELD;
      redactions += 1;
    } else {
      const r = redactSecrets(message.content);
      redactions += r.redactions;
      value.content = truncate(r.text, maxChars);
    }
  } else if (message?.content !== undefined) {
    // Non-string content (an array of parts, from a multimodal round). Keep the
    // shape by stringifying rather than dropping it — a missing `content` on an
    // assistant message is another way to earn a 400.
    const r = redactSecrets(JSON.stringify(message.content));
    redactions += r.redactions;
    value.content = truncate(r.text, maxChars);
  }

  if (typeof message?.name === 'string') value.name = message.name;
  if (typeof message?.tool_call_id === 'string') value.tool_call_id = message.tool_call_id;

  if (Array.isArray(message?.tool_calls)) {
    value.tool_calls = message.tool_calls.map((call) => {
      const raw = String(call?.function?.arguments ?? '{}');
      // ⚠️ The ARGUMENTS of a write_file to `.env` contain the file body. The
      // reply is not the only place a credential lives.
      let args = raw;
      if (isCredentialCall(call)) {
        args = JSON.stringify({ withheld: true });
        redactions += 1;
      } else {
        const r = redactSecrets(raw);
        redactions += r.redactions;
        args = truncate(r.text, maxChars);
      }
      return {
        id: call?.id,
        type: call?.type ?? 'function',
        function: { name: call?.function?.name, arguments: args },
      };
    });
  }

  const out = {};
  for (const key of orderedKeys(message)) {
    if (key === 'role') { out.role = message?.role; continue; }
    if (value[key] !== undefined) out[key] = value[key];
  }
  return { message: out, redactions };
}

function isCredentialCall(call) {
  let args = {};
  try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { return false; }
  return [args.path, args.file, args.filename].some((p) => isCredentialPath(p));
}

/**
 * The full sanitising pass: drop dangling calls, withhold credential contents,
 * redact what is left, cap each message, then cap the WHOLE record by dropping
 * the oldest middle groups.
 *
 * ⚠️ IT DROPS FROM THE MIDDLE, AND THE DIRECTION MATTERS. The head is the task
 * and the workspace shape; the tail is what the model was doing when the budget
 * ran out. Both ends are load-bearing and the middle is the part a resumed run
 * can most afford to re-derive. Dropping the tail to save the middle would
 * produce a session that resumes into work already done.
 *
 * @param {any[]} messages
 * @param {{ maxBytes?: number, maxChars?: number }} [opts]
 */
export function sanitizeMessages(messages, { maxBytes = MAX_SESSION_BYTES, maxChars = MAX_MESSAGE_CHARS } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], redactions: 0, droppedGroups: 0, droppedIncomplete: 0, truncated: false, headTruncated: false };
  }
  const { head, groups } = groupMessages(messages);
  const pruned = dropDanglingCalls(groups);

  let redactions = 0;
  /**
   * ⭐ THE HEAD IS THE CACHEABLE PREFIX, so it is capped at MAX_HEAD_CHARS and
   * not at the per-message ceiling — see MAX_HEAD_CHARS for the measurement that
   * forced this apart. `headTruncated` is reported rather than hidden: a resume
   * whose first message was clipped cannot hit the prompt cache, and the person
   * paying for it is entitled to know that before the bill.
   */
  let headTruncated = false;
  const headCap = Math.max(maxChars, MAX_HEAD_CHARS);
  const cleanHead = head.map((m) => {
    const s = sanitizeMessage(m, { maxChars: headCap });
    redactions += s.redactions;
    if (typeof m?.content === 'string' && m.content.length > headCap) headTruncated = true;
    return s.message;
  });
  const cleanGroups = pruned.groups.map((group) => {
    const withheldIds = credentialCallIds(group);
    return group.map((m) => {
      const withhold = m?.role === 'tool' && withheldIds.has(m.tool_call_id);
      const s = sanitizeMessage(m, { withhold, maxChars });
      redactions += s.redactions;
      return s.message;
    });
  });

  // Byte cap, enforced by dropping the oldest droppable group and re-measuring.
  // Measuring is cheap next to the alternative (estimating, and being wrong on
  // the one transcript that mattered).
  let kept = cleanGroups;
  let droppedGroups = 0;
  const size = () => JSON.stringify([...cleanHead, ...kept.flat()]).length;
  while (kept.length > 0 && size() > maxBytes) {
    kept = kept.slice(1);
    droppedGroups += 1;
  }

  const out = [...cleanHead, ...kept.flat()];
  if (droppedGroups > 0) {
    /**
     * ⚠️ SAY THAT THE HOLE IS THERE. A history with a silent gap is a history
     * the model will reason across as if it were continuous — it sees its own
     * earlier message, then a much later one, and infers a step it never took.
     * One user message costs nothing and turns a lie into a known unknown.
     *
     * Inserted after the head, which is exactly where the hole is.
     */
    out.splice(cleanHead.length, 0, {
      role: 'user',
      content: `[${droppedGroups} earlier round${droppedGroups === 1 ? '' : 's'} of this session were dropped to fit the saved-session size limit. `
        + 'Their work may already be on disk — check before redoing anything.]',
    });
  }

  return {
    messages: out,
    redactions,
    droppedGroups,
    droppedIncomplete: pruned.dropped,
    truncated: droppedGroups > 0,
    headTruncated,
  };
}

/**
 * Pull the FACTS out of a finished session: what was written, what was run, and
 * what happened when it ran.
 *
 * ⚠️ Read from `outcome.executed`, not from the messages. The tool records are
 * structured; the messages are the model-facing rendering of them, and parsing
 * a rendering back into data is how a summary starts disagreeing with the run.
 */
function extractActivity(executed) {
  const files = [];
  const commands = [];
  if (!Array.isArray(executed)) return { files, commands };

  for (const record of executed) {
    const name = record?.name;
    const result = record?.result;
    /**
     * ── 🚨⭐⭐ THE THIRD COPY OF "THE LIST OF WRITING TOOLS WENT STALE" ───────
     *
     * ⚠️ MEASURED ON A REAL RUN, 2026-09-18. A run that wrote two files printed:
     *
     *     acuvo --sessions
     *     20260918-024158-70wt · 4r · 0 files · 1 cmd · …
     *
     * while `acuvo rewind` said `2 files` about the same run and the audit
     * record listed both by name. The tool was **`apply_patch`**, one of the
     * structural edit verbs, and this branch tested four hardcoded names that
     * did not include it.
     *
     * ⭐ `turn.mjs` ALREADY FIXED THIS EXACT BUG AND WROTE DOWN THE CURE: *"the
     * moment a SECOND writing tool existed the summary went blind to it …
     * `mutated` is the flag every tool already sets to mean 'this touched the
     * disk', so filtering on it covers whatever gets added next without anyone
     * remembering to come back here."* The summary was changed; this was not,
     * so the fix reached one of the two places that count files.
     *
     * ⚠️ AND IT IS NOT COSMETIC. `--sessions` is how you choose what to
     * `--resume`, and the resumed context is built from this record — so a run
     * whose whole output was invisible here resumed as a run that had done
     * nothing.
     *
     * ⚠️ `evaluate` IS `mutated: false` BY DESIGN (it writes a snippet and
     * deletes it), so it cannot be double-counted here and as a command below.
     */
    /**
     * ⚠️ `mutated` **OR** THE OLD NAMES, NEVER `mutated` ALONE. Switching purely
     * to the flag looked cleaner and broke `session.test.mjs`, whose records
     * predate it and set no flag — and a caller that builds an `executed` list
     * by hand (a resumed session, a library consumer, an older record already on
     * disk) is the same shape. This repo's rule is that a new layer is a no-op
     * for everything that already worked; keeping both keeps it one.
     */
    const isWrite = record?.mutated === true
      || name === 'write_file' || name === 'edit_file' || name === 'delete_file' || name === 'make_document';
    if (isWrite) {
      /**
       * ⭐ ONE RECORD CAN NAME MANY FILES — `apply_patch` and any delegated
       * build carry a `written` array, which is why the count said 0 and why a
       * `.map` here would say 1. `describeChanges` is the same expansion the
       * run summary renders, so the two can no longer disagree about what
       * happened in the same run.
       */
      for (const change of describeChanges(record)) {
        if (typeof change.path !== 'string') continue;
        if (files.length >= MAX_FILES_RECORDED) break;
        files.push({
          path: change.path,
          action: change.kind === 'deleted' ? 'deleted' : (change.kind === 'created' ? 'created' : 'changed'),
          ok: result?.ok === true,
          bytes: typeof change.bytes === 'number' ? change.bytes : undefined,
        });
      }
      continue;
    }
    if (name === 'run_command' || name === 'evaluate') {
      if (commands.length >= MAX_COMMANDS_RECORDED) continue;
      const command = result?.command ?? (name === 'evaluate' ? 'evaluate' : record?.args?.command);
      /**
       * ⚠️ THE OUTPUT IS KEPT, BUT ONLY AS EVIDENCE. A resumed run must be able
       * to see that `npm test` failed and HOW — that is the single most useful
       * thing in the record. It must never be able to mistake it for a fresh
       * result, which is why `at` is dropped and the resume note says plainly
       * that nothing here was re-run.
       */
      const tail = redactSecrets(String(result?.stderr || result?.stdout || '').trim());
      commands.push({
        command: typeof command === 'string' ? command : String(command ?? 'unknown'),
        ok: result?.ok === true,
        passed: result?.passed ?? null,
        exitCode: result?.exitCode ?? null,
        timedOut: result?.timedOut === true,
        output: tail.text ? truncate(tail.text, MAX_COMMAND_OUTPUT_CHARS) : undefined,
      });
    }
  }
  return { files, commands };
}

/**
 * @typedef {{ ok: false, error: string }} SessionRefused
 * @typedef {{ ok: true, id: string, path: string, bytes: number, redactions: number, droppedGroups: number, droppedIncomplete: number, pruned: string[], resumable: boolean }} SessionSaved
 */

/**
 * Persist a finished (or abandoned) run.
 *
 * ⚠️ `outcome` may be a FAILURE. `runSession` returns `{ok:false, stage, error}`
 * when round 1 could not reach the model, and that run is still worth a record:
 * it is the one a user is most likely to re-issue, and knowing it died in
 * `gather` rather than mid-work is what stops them re-running it unchanged.
 * A failed session is saved and listable; it is simply not RESUMABLE, and the
 * record says so rather than leaving the caller to infer it.
 *
 * ── ⭐⭐⭐ `meta.live` — THE HALF THAT SURVIVES A LAPTOP DYING ────────────────
 *
 * MEASURED 2026-08-22 before this existed: a run was SIGKILLed mid-round after
 * two completed rounds and two files written, and `.acuvo/sessions/` **did not
 * exist at all**. Not empty — absent. The checkpoint journal survived (it is
 * appended per write), so the FILES could be put back and the CONVERSATION that
 * produced them was gone. Every save happened at the end of a turn, so the one
 * run you would most want to carry on — the one that died — was the only kind
 * that left nothing to carry on from.
 *
 * ⭐ A live save is the same record, written early and rewritten as the run
 * goes. `closedCleanly: false` is the crash marker; the final save at the end of
 * the turn passes the SAME id and flips it true. So there is exactly one file
 * per turn, exactly as before, and the only new state on disk is one boolean.
 *
 * ⚠️ `pid` IS RECORDED BECAUSE "NOT CLOSED" AND "STILL RUNNING" LOOK IDENTICAL
 * ON DISK. Seven terminals in one workspace is the documented normal case here;
 * offering to resume a conversation another live process is in the middle of
 * would be worse than never offering at all. `findCrashedSession` refuses any
 * record whose pid still answers.
 *
 * @param {string} root
 * @param {any} outcome the SessionOutcome from turn.mjs
 * @param {{ task?: string, id?: string, now?: Date, keep?: number, live?: boolean, pid?: number }} [meta]
 * @returns {SessionSaved | SessionRefused}
 */
export function saveSession(root, outcome, meta = {}) {
  const id = typeof meta.id === 'string' && meta.id ? meta.id : newSessionId(meta.now ?? new Date());
  if (!ID_SHAPE.test(id)) {
    return { ok: false, error: `session id "${id}" is not the expected YYYYMMDD-HHMMSS-xxxx shape — use newSessionId()` };
  }
  const f = resolveSessionFile(root, `${id}.json`);
  if (!f.ok) return f;

  const failed = !outcome || outcome.ok !== true;
  const clean = sanitizeMessages(outcome?.messages ?? []);
  const { files, commands } = extractActivity(outcome?.executed);
  const taskText = redactSecrets(String(meta.task ?? '')).text;

  const record = {
    version: SESSION_VERSION,
    id,
    savedAt: new Date(meta.now ?? Date.now()).toISOString(),
    root: f.root,
    task: truncate(taskText, MAX_TASK_CHARS),
    /**
     * ⚠️⚠️ `model` IS THE MODEL THAT WAS **ASKED FOR** — `turn.mjs` sets it from
     * `config.model` — and this record had no other model field at all.
     *
     * `audit.mjs` and `report.mjs` both hit the same value and both widened it
     * deliberately (`{requested, answered, chain}` and `modelsAnswered`),
     * documenting at length why: `chain.mjs` may answer from a different
     * candidate, so on a day the primary is rate-limited a record that says only
     * `model` swears the configured model did work a fallback did.
     * `saveSession` was the one persistent record left out.
     *
     * ⚠️ AND IT MADE THE READER'S FALLBACK DEAD CODE. `replay.mjs` reads
     * `typeof record.model === 'string' ? record.model : (auditInfo?.model?.answered ?? null)`
     * — but this always wrote a string, so the audit-sourced answered model could
     * never be reached and the replay header printed the requested one.
     *
     * ⚠️ THE SCALAR IS UNCHANGED. Scripts read `model`, and "what did I ask for"
     * is a real question; the fix is the fields beside it, never a redefinition.
     * Both are omitted rather than null when the loop never named one — absent
     * means "the transport did not say", and `null` would read as "nothing".
     */
    model: outcome?.model ?? null,
    ...(typeof outcome?.answeredModel === 'string' && outcome.answeredModel
      ? { answeredModel: outcome.answeredModel }
      : {}),
    ...(Array.isArray(outcome?.modelsAnswered) && outcome.modelsAnswered.length > 0
      ? { modelsAnswered: [...outcome.modelsAnswered] }
      : {}),
    roundsUsed: typeof outcome?.roundsUsed === 'number' ? outcome.roundsUsed : 0,
    maxRounds: typeof outcome?.maxRounds === 'number' ? outcome.maxRounds : null,
    // ⚠️ `stage` is the honest answer for a failure — "round-cap" would be a
    // lie about a run that never reached round 2.
    stoppedBecause: failed ? `failed:${outcome?.stage ?? 'unknown'}` : String(outcome?.stoppedBecause ?? 'unknown'),
    error: failed ? redactSecrets(String(outcome?.error ?? '')).text || null : null,
    verification: outcome?.verification
      ? { ran: outcome.verification.ran === true, passed: outcome.verification.passed ?? null, command: outcome.verification.command ?? null }
      : null,
    usage: outcome?.usage ?? null,
    files,
    commands,
    // Dropping every message is a legitimate outcome (a failure before round 1)
    // and it is the difference between a listable record and a resumable one.
    resumable: clean.messages.length > 0,
    truncated: clean.truncated,
    /**
     * ⚠️ A CLIPPED HEAD MEANS THE PROMPT CACHE CANNOT HIT ON RESUME — see
     * MAX_HEAD_CHARS. Recorded so `resumeMessages` states it instead of leaving
     * someone to discover it on the invoice.
     */
    headTruncated: clean.headTruncated === true,
    droppedGroups: clean.droppedGroups,
    droppedIncomplete: clean.droppedIncomplete,
    redactions: clean.redactions,
    /**
     * ⚠️ FALSE MEANS "THIS PROCESS NEVER GOT TO THE END", NOT "IT FAILED". A run
     * that stopped at the round cap closed cleanly; a run whose laptop shut is
     * the one this flag is for. Absent (an older record) is read as TRUE, so
     * upgrading never manufactures a crash offer for a run that finished fine.
     */
    closedCleanly: meta.live !== true,
    pid: typeof meta.pid === 'number' ? meta.pid : process.pid,
    messages: clean.messages,
  };

  const written = writeRecord(f, record);
  if (!written.ok) return written;
  /**
   * ⚠️ THE SECOND PLACE `.acuvo/` COMES INTO EXISTENCE IN A NORMAL RUN. A run
   * with `--no-audit` but sessions on would otherwise create the directory with
   * nothing to keep it out of the user's `git status` — which is the defect our
   * own bench caught on the `git` task, arriving through a different door.
   *
   * ⭐ AFTER the write, not before: if the session could not be saved there is
   * no directory of ours to hide, and creating one to ignore it would be the
   * litter it exists to prevent.
   */
  ensureAcuvoDirIgnored(root);
  const pruned = pruneSessions(root, { keep: meta.keep ?? MAX_SESSIONS });

  return {
    ok: true,
    id,
    path: f.relative,
    bytes: written.bytes,
    redactions: clean.redactions,
    droppedGroups: clean.droppedGroups,
    droppedIncomplete: clean.droppedIncomplete,
    pruned: pruned.ok ? pruned.removed : [],
    resumable: record.resumable,
  };
}

/**
 * ⚠️ UNIQUE TEMP NAME, THEN RENAME — the same rule and the same reason as
 * `savePlan`. A fixed `.tmp` shared by two processes is worse than no temp file
 * at all: both write to it and the rename publishes an interleaving of two
 * documents, which then looks like a bug in the parser.
 */
let tmpCounter = 0;

function writeRecord(f, record) {
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const bytes = Buffer.byteLength(body, 'utf8');
  const tmp = `${f.absolute}.${process.pid}-${tmpCounter++}.tmp`;
  try {
    mkdirSync(dirname(f.absolute), { recursive: true });
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, f.absolute);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return { ok: false, error: `could not write ${f.relative}: ${err(e)}` };
  }
  return { ok: true, bytes };
}

/**
 * ⚠️ VALIDATE THE FILE, DO NOT TRUST IT — `plan-ledger.mjs`'s rule, and it
 * applies harder here because this file is bigger and a half-written one from a
 * killed process is a realistic thing to find. Returns null for anything it does
 * not fully recognise, and null means "treat as absent", never "throw".
 */
function parseSession(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.version !== SESSION_VERSION) return null;
  if (typeof data.id !== 'string' || !ID_SHAPE.test(data.id)) return null;
  if (!Array.isArray(data.messages)) return null;
  if (!Array.isArray(data.files) || !Array.isArray(data.commands)) return null;
  return data;
}

/**
 * @param {string} root
 * @param {string} id
 * @returns {{ ok: true, session: any } | SessionRefused}
 */
export function loadSession(root, id) {
  const f = resolveSessionFile(root, `${String(id).replace(/\.json$/, '')}.json`);
  if (!f.ok) return f;
  if (!existsSync(f.absolute)) {
    /**
     * ⚠️ AN ERROR STRING IS AN INSTRUCTION. "not found" alone sends the reader
     * back to guess another id; naming the command that lists them ends the
     * guessing in one step.
     */
    return { ok: false, error: `no saved session "${id}" in this workspace — run with --sessions to see the ids that exist` };
  }
  let raw;
  try { raw = readFileSync(f.absolute, 'utf8'); } catch (e) {
    return { ok: false, error: `could not read ${f.relative}: ${err(e)}` };
  }
  const session = parseSession(raw);
  if (!session) {
    return { ok: false, error: `${f.relative} is not a session this version can read — it is corrupt or was written by a newer build. Start a fresh run; the file is harmless where it is.` };
  }
  return { ok: true, session };
}

/**
 * Rebuild the conversation so a follow-up round starts with everything the
 * previous run learned.
 *
 * ⭐ THE RETURNED ARRAY IS EXACTLY WHAT `runSession({ priorMessages })` WANTS.
 * That path already exists for interactive chat — it appends one user message
 * and rebuilds nothing — so resume needs no new plumbing in the loop, which is
 * the whole reason this shape was chosen over a summary string.
 *
 * ⚠️ IT RE-RUNS NOTHING. Every command in the record is history and is labelled
 * as history in the note below. The dangling-call guard has already removed the
 * only structure that could have caused a replay; the note is what stops the
 * model doing it on purpose because it assumed the environment was unchanged.
 *
 * @param {string} root
 * @param {string} id
 * @returns {{ ok: true, id: string, task: string, messages: any[], note: string, rootChanged: boolean, replayed: false } | SessionRefused}
 */
export function resumeMessages(root, id) {
  const loaded = loadSession(root, id);
  if (!loaded.ok) return loaded;
  const s = loaded.session;

  if (!s.resumable || s.messages.length === 0) {
    return {
      ok: false,
      error: `session ${s.id} has no saved conversation (it stopped at "${s.stoppedBecause}" before anything was recorded), so there is nothing to resume. Start a fresh run with the same task.`,
    };
  }

  /**
   * ⚠️ A SESSION IS ONLY VALID IN THE WORKSPACE IT WAS RECORDED IN. Every path
   * in the history is relative to that root, and every file content is a
   * snapshot of that tree. Resuming elsewhere is not refused — a directory can
   * legitimately be moved or renamed — but it is ANNOUNCED, because a model
   * that believes it already read `src/index.js` when it read a different
   * project's `src/index.js` produces confident nonsense.
   */
  const rootChanged = typeof s.root === 'string' && s.root !== '' && normalizeRoot(s.root) !== normalizeRoot(root);

  const bits = [
    `Resuming a previous session (${s.id}, saved ${s.savedAt}).`,
    `It used ${s.roundsUsed}${s.maxRounds ? ` of ${s.maxRounds}` : ''} round${s.roundsUsed === 1 ? '' : 's'} and stopped because: ${s.stoppedBecause}.`,
    'Everything above this line ALREADY HAPPENED — the files were written and the commands were run in that earlier process.',
    'Nothing has been re-run for you now. Treat the tool results above as a record, not as fresh output:',
    'if a command mattered and the code has changed since, run it again yourself.',
  ];
  if (s.files.length > 0) {
    bits.push(`Files it touched: ${s.files.slice(0, 12).map((f) => f.path).join(', ')}${s.files.length > 12 ? `, +${s.files.length - 12} more` : ''}.`);
  }
  if (s.closedCleanly === false) {
    /**
     * ⚠️ SAY THAT IT DIED, because the model's own transcript gives it no way to
     * tell. A record closed at the round cap and a record whose process was
     * killed look identical from the inside — and the difference matters: the
     * killed one may have started a tool call whose EFFECT landed while its
     * result never did, so "check the disk before redoing anything" is advice
     * only this branch can honestly give.
     */
    bits.push('⚠️ That run was killed mid-round (the process never reached the end), so its final round may be missing from this history even though its work may already be on disk.');
  }
  if (s.droppedIncomplete > 0) {
    bits.push('Its last round was incomplete and has been discarded, so the final tool call it started never finished.');
  }
  if (s.truncated) {
    bits.push('Some middle rounds were dropped to fit the session size limit; work may exist on disk that is not in this history.');
  }
  if (rootChanged) {
    bits.push(`⚠️ This session was recorded in a DIFFERENT workspace (${s.root}). Paths and file contents above may not describe the tree you are in — verify before trusting them.`);
  }
  const note = bits.join(' ');

  /**
   * The note rides as a `user` message rather than a `system` one on purpose:
   * `runSession` treats a continuing turn's message list as opaque and appends
   * the new task after it, so a second system message in the middle would sit
   * behind the first one's rules and read as an override attempt. A user turn
   * is what it actually is — the operator saying "here is where we left off".
   */
  return {
    ok: true,
    id: s.id,
    task: s.task,
    messages: [...s.messages, { role: 'user', content: note }],
    note,
    rootChanged,
    /**
     * ⭐ WHETHER THE DISCOUNT SURVIVED. The first two messages ARE the cacheable
     * prefix, so a record whose head was clipped resumes into a prompt that
     * differs from the original at message zero and cannot hit the cache at all
     * — see MAX_HEAD_CHARS for the 60.8% this was measured at before the head
     * got its own ceiling. Reported so the CLI can say so out loud; silence here
     * is how a 4.3x price difference goes unnoticed.
     */
    headTruncated: s.headTruncated === true,
    crashed: s.closedCleanly === false,
    replayed: false,
  };
}

const normalizeRoot = (p) => (process.platform === 'win32' ? String(p).toLowerCase().replace(/\\/g, '/') : String(p));

/**
 * The recent sessions, newest first, one line each.
 *
 * ⚠️ A CORRUPT FILE IS COUNTED, NOT THROWN. The listing is what a user reaches
 * for when something has already gone wrong, so it is the last place that may
 * fail on a bad file. Unreadable entries are reported as a number.
 *
 * @param {string} root
 * @param {{ limit?: number }} [opts]
 */
export function listSessions(root, { limit = 10 } = {}) {
  const dir = resolveSessionFile(root, 'probe.json');
  if (!dir.ok) return { ok: false, error: dir.error };
  const absDir = dirname(dir.absolute);
  if (!existsSync(absDir)) return { ok: true, sessions: [], unreadable: 0 };

  let names;
  try { names = readdirSync(absDir); } catch (e) {
    return { ok: false, error: `could not list ${SESSION_DIR}: ${err(e)}` };
  }
  // Lexical order IS chronological — see newSessionId. Newest first.
  const ids = names.filter((n) => n.endsWith('.json') && ID_SHAPE.test(n.slice(0, -5))).sort().reverse();

  const sessions = [];
  let unreadable = 0;
  for (const name of ids) {
    if (sessions.length >= limit) break;
    let raw;
    try { raw = readFileSync(`${absDir}/${name}`, 'utf8'); } catch { unreadable += 1; continue; }
    const s = parseSession(raw);
    if (!s) { unreadable += 1; continue; }
    sessions.push({
      id: s.id,
      savedAt: s.savedAt,
      task: s.task,
      roundsUsed: s.roundsUsed,
      files: s.files.length,
      commands: s.commands.length,
      stoppedBecause: s.stoppedBecause,
      resumable: s.resumable === true,
      // ⚠️ ABSENT READS AS CLEAN. Records written before this field existed are
      // finished runs, and inventing a crash for them would greet every upgrade
      // with an offer to recover something that never broke.
      closedCleanly: s.closedCleanly !== false,
      pid: typeof s.pid === 'number' ? s.pid : null,
      summary: summarizeSession(s),
    });
  }
  return { ok: true, sessions, unreadable };
}

/**
 * ── ⭐⭐⭐ "MY LAPTOP CRASHED. WHERE DID MY CONVERSATION GO?" ────────────────
 *
 * The one question this module existed to answer and could not. `listSessions`
 * shows you everything and makes you pick; `--continue` takes the newest and
 * asks nothing. Neither of them tells you, unprompted, that the run you were in
 * the middle of never finished — and a recovery you have to already know about
 * is a recovery for the person who does not need it.
 *
 * ⚠️ THREE THINGS MUST ALL BE TRUE, and each one has a case behind it:
 *
 *   · `closedCleanly === false` — it really did die mid-run. A run that stopped
 *     at the round cap is FINISHED; offering to rescue it would train people to
 *     dismiss this prompt, which is how the real one gets dismissed too.
 *   · `resumable` — there is a conversation to restore. A record with no
 *     messages can be listed and cannot be continued, and offering it would be
 *     a promise the next step breaks.
 *   · the pid does not answer — nobody is running it RIGHT NOW. Seven terminals
 *     in one workspace is the documented normal case for this tool, and every
 *     one of them holds an open live record. Without this check, opening a
 *     second terminal would offer to "recover" the session the first one is
 *     still working in.
 *
 * ⚠️ AND IT NEVER THROWS. It runs on the startup path of every ordinary run, so
 * a corrupt file or an unreadable directory must cost the offer and nothing
 * else.
 *
 * @param {string} root
 * @param {{ limit?: number, selfPid?: number, isAlive?: (pid: number) => boolean }} [opts]
 * @returns {{ ok: true, crashed: null | { id: string, savedAt: string, task: string, roundsUsed: number, files: number, pid: number | null, summary: string } } | SessionRefused}
 */
export function findCrashedSession(root, { limit = 5, selfPid = process.pid, isAlive = pidIsAlive } = {}) {
  let listed;
  try { listed = listSessions(root, { limit }); } catch (e) { return { ok: false, error: err(e) }; }
  if (!listed.ok) return listed;

  for (const s of listed.sessions) {
    if (s.closedCleanly) continue;
    if (!s.resumable) continue;
    /**
     * ⚠️ OUR OWN PID IS "ALIVE" TRIVIALLY, so it is excluded explicitly rather
     * than relied on. A process that re-enters this function after writing its
     * own live record would otherwise skip it for the right reason by accident,
     * and an accident is not a guard.
     */
    if (s.pid !== null && (s.pid === selfPid || isAlive(s.pid))) continue;
    return {
      ok: true,
      crashed: {
        id: s.id, savedAt: s.savedAt, task: s.task, roundsUsed: s.roundsUsed,
        files: s.files, pid: s.pid, summary: s.summary,
      },
    };
  }
  return { ok: true, crashed: null };
}

/**
 * ── ⭐⭐ CLOSE THE BOOK ON A CRASHED RECORD ONCE IT HAS BEEN DEALT WITH ──────
 *
 * ⚠️ WITHOUT THIS THE OFFER IS IMMORTAL, and that is not a small defect — it is
 * the one that makes the whole feature useless. The crash marker lives in the
 * record, so a session recovered on Monday still says "I never finished" on
 * Tuesday, Wednesday and every run after that. A warning that fires when nothing
 * is wrong teaches people to dismiss it without reading, and then the real one
 * gets dismissed too.
 *
 * ⭐ IT IS CALLED ON BOTH ANSWERS — accepted and declined. Accepting carries the
 * conversation into a NEW record, so the old one is history. Declining is a
 * decision, and re-asking somebody who already said no is how a prompt becomes
 * noise. Neither answer deletes anything: the record stays listable, replayable
 * and `--resume <id>`-able, it simply stops volunteering.
 *
 * ⚠️ IT NEVER THROWS AND IT NEVER PARTIALLY WRITES. Same temp-then-rename as
 * `saveSession`, and an unreadable or unparseable file is reported, not raised —
 * this runs on the startup path of an ordinary run.
 *
 * @param {string} root
 * @param {string} id
 * @returns {{ ok: true, id: string, changed: boolean } | SessionRefused}
 */
export function markSessionClosed(root, id) {
  const loaded = loadSession(root, id);
  if (!loaded.ok) return loaded;
  if (loaded.session.closedCleanly !== false) return { ok: true, id: loaded.session.id, changed: false };

  const f = resolveSessionFile(root, `${String(id).replace(/\.json$/, '')}.json`);
  if (!f.ok) return f;
  const written = writeRecord(f, { ...loaded.session, closedCleanly: true });
  if (!written.ok) return written;
  return { ok: true, id: loaded.session.id, changed: true };
}

/**
 * Does this pid still answer?
 *
 * ⚠️ `EPERM` MEANS ALIVE, NOT DEAD, and reading it the other way is the
 * dangerous direction: a pid owned by another user exists, and treating it as
 * gone is how we offer to resume a conversation somebody else is having. Only
 * `ESRCH` — no such process — is an answer of "no".
 */
export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== 'ESRCH';
  }
}

/**
 * ⭐ THE EXACT SENTENCE A PERSON SEES AFTER THEIR LAPTOP DIED, exported so the
 * test asserts what they read rather than a paraphrase of it — the rule
 * `interrupt.mjs` set for FIRST_PRESS_NOTICE, for the same reason: the promise
 * this line makes has to stay wired to the code that keeps it.
 *
 * ⚠️ IT NAMES THE COMMAND. "A previous run did not finish" with no next step is
 * a notification, not a recovery, and the person reading it has just lost work.
 */
export function crashOfferLines(crashed, { command = 'acuvo --continue' } = {}) {
  const when = String(crashed?.savedAt ?? '').slice(0, 16).replace('T', ' ');
  const task = String(crashed?.task ?? '').replace(/\s+/g, ' ').trim();
  return [
    `  ⚠ a run in this workspace never finished — it stopped mid-round at ${when} (UTC).`,
    `    ${crashed?.roundsUsed ?? 0} round${crashed?.roundsUsed === 1 ? '' : 's'} and ${crashed?.files ?? 0} file change${crashed?.files === 1 ? '' : 's'} were recorded: ${task.length > 64 ? `${task.slice(0, 63)}…` : task}`,
    `    Its conversation was saved. Carry on from it with:  ${command}`,
  ];
}

/**
 * One line, and it has to earn its width: the id (which is what you type to
 * resume), when, how far it got, what it produced, and why it stopped. The task
 * is LAST and clipped, because it is the part you already recognise.
 */
export function summarizeSession(s) {
  const when = String(s.savedAt ?? '').slice(0, 16).replace('T', ' ');
  const parts = [
    s.id,
    when,
    `${s.roundsUsed}r`,
    `${s.files.length} file${s.files.length === 1 ? '' : 's'}`,
    `${s.commands.length} cmd`,
    s.stoppedBecause,
  ];
  if (!s.resumable) parts.push('not resumable');
  const task = String(s.task ?? '').replace(/\s+/g, ' ').trim();
  return `${parts.join(' · ')} — ${task.length > 60 ? `${task.slice(0, 59)}…` : task}`;
}

/**
 * Keep the newest `keep` sessions; delete the rest.
 *
 * ⚠️ IT DELETES THE OLDEST, NOT THE LARGEST, and it never refuses to save the
 * newest. A cap enforced from the wrong end — "the directory is full, your run
 * was not saved" — fails at exactly the moment the feature is needed, and the
 * user finds out a day later when the resume they were counting on is missing.
 *
 * ⚠️ AND IT SWEEPS `.tmp` LEFTOVERS. A process killed between `writeFileSync`
 * and `renameSync` leaves one behind; without this they are the one thing in
 * here that genuinely grows for ever, because they match no id shape and so no
 * other code path will ever look at them again.
 */
export function pruneSessions(root, { keep = MAX_SESSIONS } = {}) {
  const dir = resolveSessionFile(root, 'probe.json');
  if (!dir.ok) return { ok: false, error: dir.error };
  const absDir = dirname(dir.absolute);
  if (!existsSync(absDir)) return { ok: true, removed: [] };

  let names;
  try { names = readdirSync(absDir); } catch (e) {
    return { ok: false, error: `could not list ${SESSION_DIR}: ${err(e)}` };
  }

  const removed = [];
  const ids = names.filter((n) => n.endsWith('.json') && ID_SHAPE.test(n.slice(0, -5))).sort();
  const doomed = keep > 0 ? ids.slice(0, Math.max(0, ids.length - keep)) : ids;

  for (const name of names) {
    const stale = name.endsWith('.tmp') && olderThanAnHour(`${absDir}/${name}`);
    if (!doomed.includes(name) && !stale) continue;
    try { unlinkSync(`${absDir}/${name}`); removed.push(name); } catch {
      // Locked by another process, or already gone. Pruning is housekeeping —
      // it must never be able to fail a save.
    }
  }
  return { ok: true, removed };
}

/** A `.tmp` younger than an hour may belong to a live process writing right
 *  now. Deleting it would be this module racing itself. */
function olderThanAnHour(path) {
  try { return Date.now() - statSync(path).mtimeMs > 3_600_000; } catch { return false; }
}

/**
 * ⚠️ ONE READ-ONLY TOOL, AND NO RESUME TOOL. See the header: a model that can
 * rewrite its own message history mid-run is the side-effect replay hazard this
 * module is built around. Resume is an OPERATOR action, taken between runs,
 * from the command line. What the model may do is LOOK — knowing that the same
 * task was attempted an hour ago and died at the round cap is context worth
 * having, and it costs one small tool result.
 */
export function sessionToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'list_sessions',
        description: [
          'List recent saved runs of this CLI in this workspace: when each ran, how many rounds it used,',
          'how many files it wrote, and why it stopped.',
          'Use it when the task looks like a continuation of earlier work — a previous run may already have',
          'written some of what you were asked for.',
          'This is READ-ONLY: it cannot resume anything and it re-runs nothing. To actually continue a',
          'session the person running this CLI passes --resume <id>.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: 'How many to list, newest first. Default 10.' },
          },
          required: [],
        },
      },
    },
  ];
}

/**
 * ── THE REGISTRATION SNIPPET — NOT WIRED IN, ON PURPOSE ─────────────────────
 *
 * Three edits, in three files, none of which this module makes:
 *
 *   1. lib/tools.mjs — offer the read-only tool
 *        import { listSessions, sessionToolSchemas } from './session.mjs';
 *        …in TOOL_SCHEMAS:      ...sessionToolSchemas(),
 *        …in executeToolCall:   case 'list_sessions':
 *                                 return { id, name, args,
 *                                          result: listSessions(executor.root, { limit: args.limit }),
 *                                          mutated: false };
 *
 *   2. lib/turn.mjs — save at the end of a run. AFTER `releaseMcp()`, before
 *      the return, so a save can never keep a child process alive:
 *        import { saveSession } from './session.mjs';
 *        const saved = saveSession(executor.root, outcome, { task });
 *        if (saved.ok) onEvent({ type: 'session', id: saved.id, redactions: saved.redactions });
 *      ⚠️ Never let a failed save fail the run — the work is already on disk.
 *
 *   3. bin/acuvo.mjs — the operator surface:
 *        --sessions          → listSessions(root).sessions.map(s => s.summary)
 *        --resume <id>       → const r = resumeMessages(root, id);
 *                              if (!r.ok) { fail(r.error); }
 *                              runSession({ ..., priorMessages: r.messages });
 *      ⚠️ `--resume` with no follow-up task is a valid request ("carry on"), so
 *      pass the ORIGINAL task (`r.task`) when the user gives no new one.
 */
export const REGISTRATION_SNIPPET = `// lib/tools.mjs
import { listSessions, sessionToolSchemas } from './session.mjs';
export const TOOL_SCHEMAS = [ /* … */ ...sessionToolSchemas() ];
// in executeToolCall's switch:
case 'list_sessions':
  return { id, name, args, result: listSessions(executor.root, { limit: args.limit }), mutated: false };

// lib/turn.mjs — after releaseMcp(), before the return
import { saveSession } from './session.mjs';
const saved = saveSession(executor.root, outcome, { task });
if (saved.ok) onEvent({ type: 'session', id: saved.id, redactions: saved.redactions });

// bin/acuvo.mjs
if (flags.sessions) for (const s of listSessions(root).sessions) console.log(s.summary);
if (flags.resume) {
  const r = resumeMessages(root, flags.resume);
  if (!r.ok) return fail(r.error);
  await runSession({ ...opts, task: task || r.task, priorMessages: r.messages });
}`;
