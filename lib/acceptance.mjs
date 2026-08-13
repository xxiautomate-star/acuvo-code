/**
 * ── ⭐⭐ THE VERDICT IS ABOUT THE COMMAND THE USER NAMED ─────────────────────
 *
 * `turn.mjs` already refuses to call a failing run a pass — its verdict comes
 * from an exit code this process observed, never from the model's prose. That
 * fixed the loud lie. It does not touch the quiet one, which is the one that
 * has actually shipped:
 *
 *   THE RUN VERIFIES SOMETHING, AND SOMETHING IS NOT THE THING THAT WAS ASKED.
 *
 * Four probes, all exit 0, all with a green banner, 2026-08-10:
 *
 *   probe 1 run 1  told "It MUST pass: npm test"
 *                  printed ✔ VERIFIED — `node --test test/api.test.js` exited 0
 *                  the delivered project's own `npm test` runs ZERO tests
 *   probe 1 runs 3+4  printed ✔ VERIFIED — `evaluate` exited 0, where `evaluate`
 *                  was a throwaway snippet used to look at stdout. Run 3 never
 *                  wrote the README it was asked for.
 *   probe 2 probe3 told "Then run the test suite", called run_command ZERO
 *                  times, printed ✔ VERIFIED — `evaluate` exited 0 over a
 *                  half-migrated refactor (git.mjs:282 and command.mjs:539-540
 *                  still called the new signature positionally).
 *   probe 4 run 2  exited 0 with --json {"verification":{"passed":true}} on a
 *                  run that silently dropped the requested commit — so the
 *                  pipeline our own README advertises,
 *                  `acuvo --json | jq '.verification.passed'`, returned true,
 *                  and `acuvo … && git push` would have pushed it.
 *
 * ⭐ THE COMMON SHAPE: verification was DERIVED FROM WHAT HAPPENED. Whatever the
 * model chose to run last became the criterion. A criterion the subject picks
 * after the fact is not a criterion, it is a summary — and `turn.mjs:1164`'s
 * `promisedButMissing` cannot close it either, because it scans the paths named
 * in the MODEL's final sentence and fired on none of probe 1's four runs.
 *
 * So the criterion is fixed BEFORE the work, from the USER's words, and the
 * only thing that can satisfy it is that exact command exiting 0.
 *
 * ── ⚠️ WHY `evaluate` CAN NEVER SATISFY ONE ─────────────────────────────────
 * `evaluate` is a scratch snippet: written to a temp file, run, deleted. It is
 * genuinely useful and `turn.mjs` is right to count it as "code was proven to
 * run". It is also the exact mechanism by which three of the four false ticks
 * were produced, because a snippet the model wrote to inspect stdout exits 0
 * whatever the project does. Only `run_command`/`run_program` records can
 * satisfy a criterion here. Nothing else — not `see_page`, not `git_*`, not a
 * media tool.
 *
 * ── ⚠️ WHAT THIS MODULE DELIBERATELY DOES NOT DO ────────────────────────────
 * It does not set the exit code, and it does not touch `verification`. It
 * returns a verdict object; the wiring decides what to do with it. A module
 * that both judges and sentences is a module nobody can test one half of.
 *
 * It also never REWRITES a criterion into something that happens to run. If the
 * runner cannot execute `npm test` because the script body contains a glob, the
 * answer is "you asked for `npm test`, and this runner refuses it because …" —
 * substituting a command that works is precisely what probe 1 run 1 did.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { validateCommand, validateNpmScriptChain } from './command.mjs';
import { resolveInWorkspace } from './workspace.mjs';
import { trustAuthoredCriteria } from './acceptance-consent.mjs';

/**
 * ⚠️ NOT IMPORTED ON PURPOSE: `executeRunCommand`. This module is allowed to
 * decide whether a criterion passed; it is not allowed to be a second way of
 * starting a process. The wiring injects a runner (a closure over
 * `executeRunCommand`, or over the sandbox runner in the browser client), which
 * keeps every spawn in this package behind the one gate that was audited for it.
 */

/** Where the declaration lives, so a resumed session inherits it. Same
 *  `.acuvo/` directory as `mcp.json` and the audit log. */
export const ACCEPTANCE_FILE = '.acuvo/acceptance.json';

/**
 * ⚠️ FIVE. Not a round number chosen for tidiness — a run with nine acceptance
 * criteria has no acceptance criterion, it has a wishlist, and the verdict
 * degenerates into "something is red" which is what we already had. The refusal
 * says which one to keep.
 */
export const MAX_CRITERIA = 5;
/** A criterion longer than this is a paragraph, and a paragraph cannot exit 0. */
export const MAX_CRITERION_CHARS = 240;
/** Per criterion, in `check_acceptance`. The model pays for every character. */
export const MAX_OUTPUT_CHARS = 400;
/** Scanning more than this of a task string buys nothing and costs time. */
const MAX_TASK_SCAN = 8_000;

/** Bump when a stored field changes meaning; a stale file must not be read as
 *  a current one by a later version. */
export const ACCEPTANCE_SCHEMA_VERSION = 1;

/**
 * The tools whose records are allowed to SATISFY a criterion. `run_program` is
 * here because the browser client names its executor's verb that; both mean
 * "a real process ran and this is its exit code".
 */
const SATISFYING_TOOLS = new Set(['run_command', 'run_program']);
/**
 * The tools that count as "something was executed at all" — which is a
 * different question, and the difference is the whole point. `evaluate` ran
 * code, so the run is not inert; it still cannot satisfy anything.
 */
const EXECUTION_TOOLS = new Set(['run_command', 'run_program', 'evaluate']);

/* ────────────────────────────────────────────────────────────────────────────
 * DERIVING — the pure half, and the part that has to be conservative
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A command starts with one of these or it is not treated as a command. This is
 * the whitelist that makes extraction safe to run over arbitrary prose: a
 * backticked `lib/thing.mjs` or a quoted 'don't' cannot become a criterion,
 * because neither starts with a program name.
 */
const COMMAND_LEADS = [
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'tsc', 'vitest', 'jest', 'mocha',
  'make', 'cargo', 'go', 'python3', 'python', 'pytest', 'ruby', 'rake', 'dotnet', 'gradle', 'mvn',
];

/**
 * ── ⚠️⚠️ `make` AND `go` ARE ALSO ORDINARY ENGLISH VERBS ─────────────────────
 *
 * Measured 2026-08-13 on sentences a person would actually type:
 *
 *   "run npm test and make sure it passes"        -> npm test, **make**
 *   "make sure the build works"                   -> **make**
 *   "please make certain the suite is green"      -> **make certain**
 *   "go through the tests and make sure they pass"-> **go through**, **make**
 *
 * Every bolded one is a criterion the user never asked for, and it then reports
 * `✖ UNMET — you asked that make pass; it was never run`. That is this
 * package's worst failure mode by its own rule: correct work reported as failed,
 * on the most ordinary phrasing in software — "make sure it passes" is how
 * people ASK for verification, and asking for verification was inventing a
 * phantom build.
 *
 * ⭐ ONLY THESE TWO LEADS NEED IT. Nobody writes "npm the thing" or "pytest the
 * suite"; `make` and `go` are the only entries in COMMAND_LEADS that are common
 * English verbs, so a general rule would cost precision for no gain.
 *
 * ⚠️ A STOPWORD LIST, NOT A TARGET WHITELIST, deliberately. Whitelisting known
 * targets (`make test`, `make build`) would refuse a project's own real target —
 * `make migrate`, `make e2e` — and refusing a criterion the user really typed is
 * the same class of error in the other direction. These words are never a
 * Makefile target or a `go` subcommand in any repository.
 */
const ENGLISH_AFTER_LEAD = new Set([
  'sure', 'certain', 'it', 'its', "it's", 'them', 'they', 'the', 'a', 'an', 'this', 'that',
  'those', 'these', 'your', 'my', 'our', 'us', 'ahead', 'through', 'on', 'back', 'over',
  'and', 'to', 'into', 'for', 'no', 'not', 'any', 'all', 'both', 'each', 'everything',
]);

/**
 * Is this token a command lead, or just a word in a sentence?
 * `make test` is a command. `make sure` is a request.
 */
function leadIsCommand(lead, next) {
  if (lead !== 'make' && lead !== 'go') return true;
  const w = String(next ?? '').toLowerCase().replace(/[^a-z'-]/g, '');
  // A lead with nothing after it is prose too — "just make it pass".
  if (!w) return false;
  return !ENGLISH_AFTER_LEAD.has(w);
}

/**
 * ⚠️ THE OPENING QUOTE MUST BE IMMEDIATELY FOLLOWED BY A PROGRAM NAME, and the
 * closing one is a backreference. Written the obvious way — `/'([^']+)'/` — the
 * apostrophe in "don't run 'npm test'" opens a span, and the real criterion is
 * eaten by the mispairing. Anchoring on the lead makes that impossible instead
 * of unlikely.
 */
const QUOTED_COMMAND = new RegExp(
  `(['"\`])(${COMMAND_LEADS.join('|')})\\b([^'"\`\\n]{0,220})\\1`,
  'g',
);

/**
 * A sentence has to CLAIM something before a command inside it is a criterion.
 * Without this, "I used `npm test` yesterday" becomes a promise the run is then
 * judged against.
 */
const ACCEPTANCE_MARKER =
  /\b(must|should|shall|has to|have to|needs? to|ensure|make sure|verify|verifies|confirm|prove|required|passes?|passing|green|succeeds?)\b|\bexits?\s+(?:with\s+)?(?:code\s+)?0\b/i;

/**
 * ⭐ A PHRASE IS A CRITERION TOO, AND IT IS THE HONEST ONE. "Then run the test
 * suite" names no command — probe 2's probe3 was given exactly that and ran
 * nothing, then claimed a tick. Recording it with `command: null` means the
 * verdict can say "you asked for the test suite and nothing was run" instead of
 * the module inventing `npm test` and grading against a command the user never
 * typed.
 */
const PHRASE_PATTERNS = [
  /\b(?:then\s+)?run\s+the\s+(?:full\s+|whole\s+|entire\s+)?(?:test\s+suite|tests|suite|unit\s+tests)\b/i,
  /\bmake\s+sure\s+(?:the\s+|all\s+)?tests?\s+(?:still\s+)?pass(?:es)?\b/i,
  /\ball\s+(?:the\s+)?tests?\s+(?:must\s+|should\s+)?pass\b/i,
];

/** Words that end a bare command. `npm test must pass` is two tokens of
 *  command and then English. */
const STOP_WORDS = new Set([
  'must', 'should', 'shall', 'has', 'have', 'had', 'needs', 'need', 'will', 'would', 'can', 'could',
  'and', 'or', 'but', 'then', 'at', 'with', 'to', 'so', 'that', 'this', 'it', 'is', 'are', 'was',
  'were', 'be', 'exit', 'exits', 'exited', 'pass', 'passes', 'passing', 'passed', 'green', 'all',
  'the', 'a', 'an', 'in', 'on', 'of', 'from', 'after', 'before', 'when', 'if', 'does', 'do', 'still',
  'again', 'please', 'make', 'sure', 'ensure', 'verify', 'print', 'prints', 'printing', 'output',
  'outputs', 'usage', 'end', 'finally', 'also', 'without', 'error', 'errors', 'clean', 'first',
]);

/** trim + collapse internal whitespace. Case-SENSITIVE: `NPM TEST` is not the
 *  command, and pretending otherwise would let a near-miss count. */
function normaliseCommand(raw) {
  return String(raw).trim().replace(/\s+/g, ' ');
}

/** Sentence boundaries WITH offsets, so "order of appearance" is a real order.
 *  `:` is deliberately not a boundary — "It MUST pass: npm test" is one claim,
 *  and splitting it would strand the command in a sentence with no marker. */
function splitSentences(text) {
  const out = [];
  const boundary = /(?<=[.!?;])\s+|\n+/g;
  let start = 0;
  let m;
  while ((m = boundary.exec(text)) !== null) {
    out.push({ text: text.slice(start, m.index), start });
    start = m.index + m[0].length;
  }
  out.push({ text: text.slice(start), start });
  return out.filter((s) => s.text.trim().length > 0);
}

/** Strip the punctuation English leaves on the end of a token. Interior dots
 *  survive, because `todo.js` is a filename and `test.` is not a command. */
const cleanToken = (t) => t.replace(/[.,;:!?)\]]+$/, '');

/** Consume a bare command starting at token `i`, stopping at the first word
 *  that is English rather than argument. Bounded at 8 tokens. */
function bareCommandFrom(tokens, i) {
  const parts = [];
  for (let j = i; j < tokens.length && parts.length < 8; j += 1) {
    const raw = tokens[j];
    const cleaned = cleanToken(raw);
    if (!cleaned) break;
    if (j > i) {
      if (!/^[A-Za-z0-9._\-/=:@]+$/.test(cleaned)) break;
      if (STOP_WORDS.has(cleaned.toLowerCase())) break;
    }
    parts.push(cleaned);
    if (/[.,;:!?]$/.test(raw)) break;
  }
  return parts.join(' ');
}

/**
 * Extract the criteria a user literally named.
 *
 * PURE. Returns `[{ command, phrase, kind, confidence }]`, deduped, in order of
 * appearance, at most MAX_CRITERIA. `command` is null for a phrase criterion.
 *
 * ⚠️ IT NEVER INVENTS A COMMAND. Every returned `command` is a substring of the
 * input. "Then run the test suite" does NOT become `npm test`, however obvious
 * that guess looks — an invented criterion fails a run that did the right thing
 * under a different name, and once it does that twice nobody reads the verdict.
 *
 * ⚠️ `source` EXISTS TO STOP THE MODEL GRADING ITSELF. The only sources are the
 * user's task text and an explicit `declare_acceptance` call. Pointed at the
 * model's own output this returns nothing at all, because a model that can
 * write its own criterion has no criterion — that is the failure being fixed,
 * arriving through a different door.
 *
 * @param {unknown} taskText
 * @param {{ source?: 'user' | 'model' | string }} [opts]
 */
export function deriveAcceptance(taskText, { source = 'user' } = {}) {
  if (source !== 'user') return [];
  if (typeof taskText !== 'string' || !taskText.trim()) return [];
  const text = taskText.slice(0, MAX_TASK_SCAN);

  /** @type {{ command: string | null, phrase: string, kind: string, confidence: number, at: number }[]} */
  const found = [];

  for (const sentence of splitSentences(text)) {
    const claims = ACCEPTANCE_MARKER.test(sentence.text);
    const covered = [];

    if (claims) {
      QUOTED_COMMAND.lastIndex = 0;
      let q;
      while ((q = QUOTED_COMMAND.exec(sentence.text)) !== null) {
        const command = normaliseCommand(`${q[2]}${q[3]}`);
        covered.push([q.index, q.index + q[0].length]);
        if (!command || command.length > MAX_CRITERION_CHARS) continue;
        found.push({
          command,
          phrase: sentence.text.trim().slice(0, MAX_CRITERION_CHARS),
          kind: q[1] === '`' ? 'backticked' : 'quoted',
          confidence: q[1] === '`' ? 0.9 : 0.8,
          at: sentence.start + q.index,
        });
      }

      // Bare: `MUST pass: npm test`, and `npm test must pass at the end`.
      const tokenRe = /\S+/g;
      const tokens = [];
      let t;
      while ((t = tokenRe.exec(sentence.text)) !== null) tokens.push({ value: t[0], index: t.index });
      for (let i = 0; i < tokens.length; i += 1) {
        const { value, index } = tokens[i];
        if (covered.some(([a, b]) => index >= a && index < b)) continue;
        const lead = cleanToken(value).toLowerCase();
        if (!COMMAND_LEADS.includes(lead)) continue;
        // "make sure it passes" is a request for verification, not a build.
        if (!leadIsCommand(lead, cleanToken(tokens[i + 1]?.value ?? ''))) continue;
        const command = normaliseCommand(bareCommandFrom(tokens.slice(i).map((x) => x.value), 0));
        if (!command || command.length > MAX_CRITERION_CHARS) continue;
        found.push({
          command,
          phrase: sentence.text.trim().slice(0, MAX_CRITERION_CHARS),
          kind: 'bare',
          confidence: 0.6,
          at: sentence.start + index,
        });
      }
    }

    // A phrase only counts when the sentence named no command — otherwise
    // "run the tests with `npm test`" would be recorded twice, once vaguely.
    const namedACommand = found.some(
      (f) => f.at >= sentence.start && f.at < sentence.start + sentence.text.length,
    );
    if (!namedACommand) {
      for (const pattern of PHRASE_PATTERNS) {
        const m = sentence.text.match(pattern);
        if (!m) continue;
        found.push({
          command: null,
          phrase: m[0].trim().slice(0, MAX_CRITERION_CHARS),
          kind: 'phrase',
          confidence: 0.3,
          at: sentence.start + (m.index ?? 0),
        });
        break; // one phrase per sentence; they overlap by design
      }
    }
  }

  found.sort((a, b) => a.at - b.at);
  const seen = new Set();
  const out = [];
  for (const f of found) {
    const key = f.command ?? `phrase:${f.phrase.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ command: f.command, phrase: f.phrase, kind: f.kind, confidence: f.confidence });
    if (out.length >= MAX_CRITERIA) break;
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * DECLARING — the durable half
 * ──────────────────────────────────────────────────────────────────────────── */

/** A workspace with no disk has nowhere to put this, and saying so beats
 *  writing a file into a Map nobody reads back. */
const isMemoryWorkspace = (root) => root === '(memory)' || root === undefined || root === null;

function acceptancePath(root) {
  const r = resolveInWorkspace(root, ACCEPTANCE_FILE, 'write');
  if (!r.ok) return { ok: false, error: `cannot use ${ACCEPTANCE_FILE} in this workspace: ${r.reason}` };
  /**
   * ⚠️ THE ASSERTION IS CHEAP AND THE FAILURE IT CATCHES IS NOT. This module is
   * only ever allowed to write inside `.acuvo/`. `resolveInWorkspace` already
   * guarantees "inside the workspace"; this guarantees "inside our own corner
   * of it", so a future edit to ACCEPTANCE_FILE cannot quietly turn a verdict
   * store into a file that overwrites someone's source.
   */
  if (r.relative !== ACCEPTANCE_FILE) {
    return { ok: false, error: 'the acceptance file must live inside .acuvo/ — refusing to write anywhere else' };
  }
  return { ok: true, absolute: r.absolute, relative: r.relative };
}

/**
 * For an `npm test` / `npm run <script>` criterion, ask the same question
 * `executeRunCommand` will ask: can this runner execute what package.json says?
 * Anything else is runnable as far as declaration can tell.
 */
function npmChainVerdict(root, valid) {
  if (valid.binary !== 'npm') return { ok: true };
  const r = resolveInWorkspace(root, 'package.json', 'read');
  if (!r.ok) return { ok: false, error: `cannot run npm here: ${r.reason}` };
  let text;
  try {
    text = readFileSync(r.absolute, 'utf8');
  } catch {
    return { ok: false, error: 'cannot run npm here: there is no package.json in this workspace, so there is no script to run' };
  }
  const chain = validateNpmScriptChain(valid.npmScript, text);
  return chain.ok ? { ok: true } : { ok: false, error: chain.error };
}

/**
 * Record the exact strings that must pass. Called by the agent through
 * `declare_acceptance`, or by the wiring with the output of `deriveAcceptance`.
 *
 * ⭐ EACH ONE IS VALIDATED AT DECLARATION TIME, AND THAT IS THE POINT. If the
 * runner cannot execute `npm test` — because the script body contains a glob,
 * say — the criterion is stored `runnable: false` WITH the runner's own reason,
 * and the reason comes back immediately. The run then says
 *
 *   "you asked for `npm test`, and this runner refuses its script body because
 *    of the glob"
 *
 * instead of quietly running something else and calling that verified, which is
 * exactly what probe 1 run 1 did.
 *
 * @param {string} root
 * @param {{ commands?: unknown }} args
 */
export function declareAcceptance(root, { commands } = {}) {
  if (isMemoryWorkspace(root)) {
    return {
      ok: false,
      error: 'this workspace is held in memory, so there is no .acuvo/ to record criteria in. Pass the criteria straight to checkAcceptance instead of declaring them.',
    };
  }
  if (!Array.isArray(commands)) {
    return { ok: false, error: 'commands must be an array of command strings, e.g. ["npm test"]' };
  }
  if (commands.length === 0) {
    return { ok: false, error: 'declare at least one command, or do not call this tool — an empty declaration is the same as declaring nothing' };
  }
  if (commands.length > MAX_CRITERIA) {
    return {
      ok: false,
      error: `${commands.length} criteria were given and at most ${MAX_CRITERIA} are accepted. Declare only the commands whose failure means the task is not done — a longer list is a wishlist, and every entry weakens the verdict.`,
    };
  }

  const criteria = [];
  for (const raw of commands) {
    if (typeof raw !== 'string') return { ok: false, error: 'every criterion must be a string' };
    const command = normaliseCommand(raw);
    if (!command) return { ok: false, error: 'a criterion cannot be empty' };
    if (command.length > MAX_CRITERION_CHARS) {
      return {
        ok: false,
        error: `a criterion is ${command.length} characters, over the ${MAX_CRITERION_CHARS} limit. Declare the command itself, not a description of it.`,
      };
    }
    const verdict = validateCommand(command);
    if (!verdict.ok) {
      criteria.push({ command, runnable: false, reason: verdict.error });
      continue;
    }
    /**
     * ⚠️ `npm test` PASSES `validateCommand` AND STILL MAY NOT BE RUNNABLE, and
     * that gap is the probe-1 defect exactly. `executeRunCommand` reads the
     * script BODY before spawning npm (a script can be anything, including a
     * glob this runner refuses) — so a declaration that stopped at the word
     * "npm" would promise a criterion the runner will reject at the moment it
     * matters, which is the moment the model has no rounds left to react.
     *
     * `validateNpmScriptChain` is the same pure function `executeRunCommand`
     * uses, so the reason the model is given now is the reason it would have
     * been given later, word for word.
     */
    const chained = npmChainVerdict(root, verdict);
    criteria.push(chained.ok ? { command, runnable: true, reason: null } : { command, runnable: false, reason: chained.error });
  }

  const target = acceptancePath(root);
  if (!target.ok) return target;
  const payload = {
    version: ACCEPTANCE_SCHEMA_VERSION,
    declaredAt: new Date().toISOString(),
    criteria,
  };
  try {
    mkdirSync(dirname(target.absolute), { recursive: true });
    writeFileSync(target.absolute, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not record the criteria: ${err instanceof Error ? err.message : String(err)}` };
  }

  /**
   * ── ⭐ CONSENT ON AUTHORSHIP — WHY THIS FEATURE NEVER PROMPTS IN NORMAL USE ─
   *
   * A workspace acceptance file is now gated by consent, because a cloned
   * repository shipping one could execute code and have it reported as ✔ (see
   * `lib/acceptance-consent.mjs` for the proof). But criteria written HERE were
   * written by the user's own session, milliseconds ago, at their instruction —
   * asking them to approve that later would be asking them to consent to their
   * own command, and a prompt with no real decision in it is one people learn
   * to click through.
   *
   * ⚠️ Deliberately not fatal. Failing to record trust means the next run asks
   * once, which is mildly annoying and completely safe; failing the DECLARATION
   * because a trust file could not be written would break the feature to
   * protect it.
   */
  try { trustAuthoredCriteria(criteria, { root }); } catch { /* the next run asks; nothing is lost */ }

  const unrunnable = criteria.filter((c) => !c.runnable);
  return {
    ok: true,
    path: target.relative,
    criteria,
    unrunnable,
    /**
     * ⚠️ RETURNED IMMEDIATELY, not saved for the summary. The model has rounds
     * left right now; told at the end, "this runner cannot execute your
     * criterion" is an obituary.
     */
    note: unrunnable.length
      ? unrunnable.map((c) => `\`${c.command}\` cannot be run here: ${c.reason}`).join(' ')
      : null,
  };
}

/**
 * Read back what a previous round (or a previous session) declared.
 * `found: false` is not an error — most runs declare nothing.
 */
export function loadAcceptance(root) {
  if (isMemoryWorkspace(root)) return { ok: true, found: false, criteria: [] };
  const target = acceptancePath(root);
  if (!target.ok) return { ok: true, found: false, criteria: [] };
  if (!existsSync(target.absolute)) return { ok: true, found: false, criteria: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(target.absolute, 'utf8'));
  } catch (err) {
    // Corrupt state must not read as "nothing was declared" — that is a silent
    // downgrade to the behaviour this module exists to remove.
    return { ok: false, error: `${ACCEPTANCE_FILE} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Delete it or declare the criteria again.` };
  }
  const criteria = Array.isArray(parsed?.criteria) ? parsed.criteria.filter((c) => c && typeof c.command === 'string') : [];
  return { ok: true, found: criteria.length > 0, criteria, declaredAt: parsed?.declaredAt ?? null };
}

/* ────────────────────────────────────────────────────────────────────────────
 * EVALUATING — the rule that kills the false tick
 * ──────────────────────────────────────────────────────────────────────────── */

/** Accept criteria as objects or as bare strings, so the wiring can pass
 *  either without a shim that could disagree with this one. */
function asCriterion(entry) {
  if (typeof entry === 'string') {
    const command = normaliseCommand(entry);
    return command ? { command, phrase: command, kind: 'bare', runnable: true, reason: null } : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const command = typeof entry.command === 'string' ? normaliseCommand(entry.command) : null;
  const runnable = command ? entry.runnable !== false : false;
  return {
    command,
    phrase: typeof entry.phrase === 'string' ? entry.phrase : (command ?? ''),
    kind: typeof entry.kind === 'string' ? entry.kind : (command ? 'bare' : 'phrase'),
    runnable,
    reason: entry.reason ?? (command ? null : 'no command was named, so nothing can be run to satisfy it'),
  };
}

/** The command a tool record actually ran, or null. Falls back to the
 *  arguments only when the result did not echo it — a refused command has no
 *  validated string of its own. */
function recordCommand(record) {
  const fromResult = record?.result?.command;
  if (typeof fromResult === 'string' && fromResult.trim()) return normaliseCommand(fromResult);
  const fromArgs = record?.args?.command;
  if (typeof fromArgs === 'string' && fromArgs.trim()) return normaliseCommand(fromArgs);
  return null;
}

/**
 * Decide the verdict. PURE.
 *
 * ⚠️ A CRITERION IS SATISFIED ONLY BY AN EXACT COMMAND MATCH AND exit 0. Not by
 * output text ("all tests passed" is a string the model can write), not by a
 * near-miss (`node --test test/api.test.js` is not `npm test`; that WAS the
 * probe-1 defect, and the two commands there did genuinely different things),
 * and never by an `evaluate` record.
 *
 * @param {{ declared?: unknown[], executed?: any[] }} args
 */
export function evaluateAcceptance({ declared = [], executed = [] } = {}) {
  const criteria = (Array.isArray(declared) ? declared : []).map(asCriterion).filter(Boolean).slice(0, MAX_CRITERIA);
  const records = Array.isArray(executed) ? executed : [];

  // Every command that a REAL runner exited 0 on. The only currency accepted.
  const passedCommands = new Map(); // command → exitCode
  const ranCommands = new Map();    // command → last exitCode seen (pass or fail)
  let executedAnything = false;
  let evaluateRan = false;

  for (const r of records) {
    const name = r?.name;
    if (!EXECUTION_TOOLS.has(name)) continue;
    if (r?.result?.ok !== true) continue; // a refusal is not an execution
    executedAnything = true;
    if (name === 'evaluate') { evaluateRan = true; continue; }
    if (!SATISFYING_TOOLS.has(name)) continue;
    const command = recordCommand(r);
    if (!command) continue;
    const exitCode = r.result.exitCode;
    ranCommands.set(command, exitCode);
    if (exitCode === 0) passedCommands.set(command, 0);
    else passedCommands.delete(command); // a later red overrides an earlier green
  }

  const judged = criteria.map((c) => {
    const ran = c.command !== null && ranCommands.has(c.command);
    const satisfied = c.runnable && c.command !== null && passedCommands.has(c.command);
    return {
      command: c.command,
      phrase: c.phrase,
      kind: c.kind,
      runnable: c.runnable,
      reason: c.reason,
      ran,
      exitCode: ran ? ranCommands.get(c.command) : null,
      satisfied,
    };
  });

  const runnable = judged.filter((c) => c.runnable);
  const unmet = runnable.filter((c) => !c.satisfied).map((c) => ({
    command: c.command,
    why: c.ran ? `it ran and exited ${c.exitCode}` : 'it was never run',
  }));

  const declaredSet = new Set(runnable.map((c) => c.command));
  const incidental = [...passedCommands.keys()].filter((cmd) => !declaredSet.has(cmd)).slice(0, MAX_CRITERIA);
  /** ⚠️ Named explicitly, because in three of the four probes it was the ONLY
   *  thing that "passed", and a verdict that omits it reads as "nothing ran". */
  if (evaluateRan) incidental.push('evaluate');

  let verdict;
  let reason = null;
  if (criteria.length === 0) {
    verdict = 'none-declared';
    reason = 'no acceptance criterion was declared for this run';
  } else if (runnable.length === 0) {
    verdict = 'unrunnable';
    reason = judged.map((c) => c.reason).find(Boolean) ?? 'no declared criterion can be executed by this runner';
  } else if (!executedAnything) {
    verdict = 'not-run';
  } else if (unmet.length === 0) {
    verdict = 'met';
  } else {
    verdict = 'unmet';
  }

  return {
    verdict,
    reason,
    criteria: judged,
    unmet,
    incidental,
    declaredCount: criteria.length,
    satisfiedCount: runnable.filter((c) => c.satisfied).length,
  };
}

/**
 * Three sentences that must never blur into each other, because the whole
 * defect was one sentence being used for all three states.
 *
 * PURE.
 */
export function formatVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') return '— nothing was declared, so nothing here is a criterion';
  const v = verdict.verdict;

  if (v === 'none-declared') return '— nothing was declared, so nothing here is a criterion';

  if (v === 'met') {
    const met = verdict.criteria.filter((c) => c.satisfied).map((c) => `\`${c.command}\` exited 0`);
    return `✔ MET — ${met.join('; ')}`;
  }

  if (v === 'unrunnable') {
    const c = verdict.criteria[0] ?? {};
    const named = c.command ? `\`${c.command}\`` : `"${c.phrase ?? 'the criterion'}"`;
    // The runner's reason is a whole sentence of its own and already ends in a
    // full stop as often as not; two in a row reads like a typo in the one line
    // someone is meant to trust.
    // ⚠️ AND IT SAYS WHEN IT CUT. Silently trimmed, the sentence read
    // "…so run one plain command." — a truncation that looks like the runner's
    // complete sentence is worse than a longer line.
    const full = String(verdict.reason ?? 'no reason was recorded');
    const cut = full.length > 220;
    const because = `${full.slice(0, 220).replace(/[.\s]+$/, '')}${cut ? ' … (reason truncated)' : '.'}`;
    return `⚠ NOT A VERDICT — you asked for ${named}, and it cannot be run here: ${because} Nothing in this run is checked against it.`;
  }

  // unmet / not-run — the same shape, deliberately, because both mean the thing
  // you asked for did not pass. What differs is the tail.
  /**
   * ⚠️ ONE CRITERION KEEPS THE SHORT SENTENCE; SEVERAL PAIR EACH COMMAND WITH ITS
   * OWN REASON. Joining the commands and the reasons as two separate lists
   * produced "`a` and `b` pass; it was never run; it ran and exited 1", which
   * leaves the reader to guess which reason belongs to which command — and
   * guessing is the failure this whole module exists to remove.
   */
  const single = verdict.unmet.length <= 1;
  const asked = single
    ? verdict.unmet.map((u) => `\`${u.command}\``).join('')
    : verdict.unmet.map((u) => `\`${u.command}\` (${u.why})`).join(' and ');
  const why = v === 'not-run'
    ? 'nothing was executed in this run'
    : (single ? (verdict.unmet[0]?.why ?? 'it was never run') : 'none of them is satisfied');
  const passers = verdict.incidental.filter((c) => c !== 'evaluate');
  const tail = [];
  if (passers.length) tail.push(`these did pass: ${passers.join(', ')}`);
  if (verdict.incidental.includes('evaluate')) {
    tail.push('`evaluate` exited 0, but it is a scratch snippet and can never satisfy a criterion');
  }
  return `✖ UNMET — you asked that ${asked} pass; ${why}${tail.length ? ` (${tail.join('; ')})` : ''}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * CHECKING — running the criteria, through someone else's runner
 * ──────────────────────────────────────────────────────────────────────────── */

/** Keep the tail: a test runner's verdict is at the bottom. */
function clampTail(text, max = MAX_OUTPUT_CHARS) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  return `… ${s.length - max} characters omitted …\n${s.slice(-max)}`;
}

/**
 * Run every runnable criterion and return the verdict.
 *
 * ⚠️ `runner` IS REQUIRED AND IS THE ONLY WAY ANYTHING RUNS. This module does
 * not import a spawner. The CLI injects a closure over `executeRunCommand`
 * (allowlist, no shell, scrubbed environment); the browser client injects its
 * sandbox. Neither is reimplemented here, which is what keeps there being one
 * audited gate rather than two.
 *
 * @param {{ root?: string, runner?: (command: string) => Promise<any>, declared?: unknown[] }} args
 */
export async function checkAcceptance({ root, runner, declared } = {}) {
  if (typeof runner !== 'function') {
    return {
      ok: false,
      error: 'check_acceptance has no runner. This is a wiring fault, not something to retry — the caller must inject one; nothing in this module may start a process by itself.',
    };
  }

  let criteria = declared;
  if (!Array.isArray(criteria)) {
    if (isMemoryWorkspace(root)) {
      const verdict = evaluateAcceptance({ declared: [], executed: [] });
      return {
        ok: true,
        criteria: [],
        verdict: { ...verdict, reason: 'this workspace is held in memory, so no criteria could be stored or read' },
      };
    }
    const loaded = loadAcceptance(root);
    if (!loaded.ok) return loaded;
    criteria = loaded.criteria;
  }

  const normalised = criteria.map(asCriterion).filter(Boolean).slice(0, MAX_CRITERIA);
  const rows = [];
  /** Synthetic tool records, so ONE function decides the verdict whether the
   *  commands were run by the agent or by this tool. Two deciders would drift. */
  const executed = [];

  for (const c of normalised) {
    if (!c.runnable || !c.command) {
      rows.push({ command: c.command, ran: false, exitCode: null, passed: false, output: c.reason ?? 'not runnable' });
      continue;
    }
    let result;
    try {
      result = await runner(c.command);
    } catch (err) {
      // A runner that throws is a bug in the wiring, not a failing criterion —
      // reporting it as "exited 1" would blame the user's code for our fault.
      rows.push({
        command: c.command, ran: false, exitCode: null, passed: false,
        output: `the runner threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (!result || result.ok !== true) {
      rows.push({
        command: c.command, ran: false, exitCode: null, passed: false,
        output: result?.error ?? 'the runner refused this command',
      });
      continue;
    }
    const exitCode = result.exitCode ?? null;
    rows.push({
      command: c.command,
      ran: true,
      exitCode,
      passed: exitCode === 0 && result.timedOut !== true,
      output: clampTail(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
    });
    executed.push({ name: 'run_command', args: { command: c.command }, result: { ok: true, command: c.command, exitCode } });
  }

  return { ok: true, criteria: rows, verdict: evaluateAcceptance({ declared: normalised, executed }) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE TOOLS
 * ──────────────────────────────────────────────────────────────────────────── */

export function acceptanceToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'declare_acceptance',
        description: [
          'Record the exact command(s) the USER said must pass, copied verbatim from their words.',
          'Call this ONCE, early, before doing the work — a criterion chosen after the fact is a summary, not a criterion.',
          'Do not paraphrase, do not substitute an equivalent command, and do not declare a command the user did not name:',
          'if they said `npm test`, declare `npm test`, even if you would rather run the test file directly.',
          `At most ${MAX_CRITERIA} commands. If one cannot be run here you are told immediately, with the reason.`,
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            commands: {
              type: 'array',
              items: { type: 'string' },
              description: 'The verbatim commands that must exit 0, e.g. ["npm test"].',
            },
          },
          required: ['commands'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_acceptance',
        description: [
          'Run every declared acceptance criterion and report, per command, whether it exited 0.',
          'This is the only thing that clears the criteria — a passing `evaluate` snippet or a different',
          'command that happens to exit 0 never does.',
        ].join(' '),
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];
}
