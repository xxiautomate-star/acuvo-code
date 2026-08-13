/**
 * ── lib/compact.mjs — THE HORIZON ──────────────────────────────────────────
 *
 * ⚠️⭐⭐ THE DEFECT THIS EXISTS FOR: THERE IS NO CONTEXT MANAGEMENT AT ALL.
 * Grep `lib/turn.mjs` for history trimming and you find none — `messages` only
 * ever grows. Every round appends an assistant message plus one tool result per
 * call, and nothing is ever removed, replaced or shrunk. The round cap hides it
 * today: at 8 rounds a normal session simply ends before the wall. Raise the
 * horizon and the wall arrives instead of the cap, as a provider 400 or a
 * silent truncation, and the run dies in the middle of the work.
 *
 * That is the single biggest structural limit on this product. It is why the
 * CLI is an 8-round tool rather than an all-day one.
 *
 * ── ⭐ WHY THIS IS STRUCTURAL AND NOT A SUMMARISER ─────────────────────────
 *
 * The obvious fix is "ask the model to summarise the history". It is the wrong
 * fix here, for three reasons that are specific to an AGENTIC transcript:
 *
 *   1. THE BULK IS NOT PROSE. Measured on a real session (see the module test
 *      and the lane report): the assistant's own words are a rounding error.
 *      The weight is tool RESULTS — file bodies, command dumps, hit lists.
 *   2. MOST OF THAT WEIGHT IS PROVABLY STALE. The same file read three times is
 *      two dead copies and one live one, and which is which is a fact about the
 *      transcript, not a judgement call. No model is needed to know it.
 *   3. A SUMMARISER COSTS A MODEL CALL, ADDS LATENCY, AND CAN LIE. Structural
 *      compaction costs nothing, is deterministic, and can be tested. When the
 *      free, exact, verifiable version handles the bulk, spending a paid,
 *      approximate, unverifiable one on the same bytes is a bad trade.
 *
 * So this module is PURE: data in, data out. No LLM, no network, no clock, no
 * `Math.random()`. Given the same transcript and the same options it returns
 * the same bytes, which is what makes it testable at all.
 *
 * ── ⚠️⚠️ THE INVARIANT. IT IS THE WHOLE JOB ────────────────────────────────
 *
 * Every assistant message carrying `tool_calls` MUST keep a matching `tool`
 * message for EVERY call id, in order. OpenAI-shaped APIs hard-reject a history
 * where a `tool_call` has no answering `tool` message — and the rejection is a
 * 400 on that round AND on every round after it, because the broken history is
 * resent each time. From the outside the tool appears to break completely and
 * mysteriously, having worked a minute earlier.
 *
 * ⭐ SO COMPACTION REPLACES A RESULT'S CONTENT AND NEVER REMOVES A MESSAGE.
 * That is not a guideline in here, it is the shape of the code: the output
 * array is built by `map`, index for index, and the only field that can differ
 * is `content` on a `role: 'tool'` message. Nothing else is reachable.
 *
 * ⭐⭐ AND IT IS CHECKED, NOT ASSUMED. `structuralFingerprint()` serialises the
 * skeleton — roles, call ids, result ids, in order, with all content stripped —
 * and `compactMessages` compares the fingerprint of its own output against its
 * input. If they ever differ the compactor RETURNS THE INPUT UNCHANGED and says
 * so in the report. A compactor that would break the conversation hands the
 * conversation back. Losing the saving is a bad round; losing the session is
 * the product.
 *
 * ── WHAT IS NEVER COMPACTED ───────────────────────────────────────────────
 *
 *   · the system prompt(s) and the opening task — the cacheable prefix, and a
 *     history without them is not a session, it is a different session;
 *   · every message that is not `role: 'tool'` — assistant notes, plan banners
 *     and user turns are cheap and load-bearing, and touching them is how a
 *     resumed model starts reasoning about instructions it was never given;
 *   · the most recent `keepLastRounds` tool rounds, verbatim;
 *   · anything the NEWEST assistant message names. If the model just said "the
 *     earlier version of lib/slug.mjs", compacting that read deletes the thing
 *     it is in the middle of using.
 *
 * ── ⚠️ TOKENS ARE ESTIMATED AND THE REPORT SAYS SO ────────────────────────
 *
 * There is no tokeniser here and there must not be one — that is an npm
 * dependency, and this package's headline property is that it has none. Every
 * token number this module produces is `chars / 4`, the industry approximation
 * for English prose, and it is wrong in both directions: CJK and emoji cost
 * more per character, long repeated identifiers cost less. `report.method`
 * says this in words, because a number presented as exact when it is a guess is
 * the specific dishonesty this repo hunts.
 */

/** The industry approximation. English prose, roughly. See the header. */
export const CHARS_PER_TOKEN = 4;

/**
 * Every provider wraps each message in some role/format scaffolding that costs
 * tokens the content does not account for. ⚠️ This is a STATED GUESS, not a
 * measurement — it is here so a transcript of 400 tiny messages does not
 * estimate as almost free, which is the direction that hurts.
 */
export const MESSAGE_OVERHEAD_CHARS = 16;

export const DEFAULT_BUDGET_TOKENS = 24_000;
export const DEFAULT_KEEP_LAST_ROUNDS = 2;
/** Past this, a single tool result is clamped head-and-tail. */
export const DEFAULT_MAX_RESULT_CHARS = 4_000;
/**
 * The clamp halves when a fixed one cannot reach the budget, and stops here.
 * ⚠️ Below roughly this, a clamped result is nothing but its own apology — a
 * hole in the history dressed as a message. Refusing to reach the budget is the
 * honest failure; a transcript of stubs is the dishonest one.
 */
export const MIN_CLAMP_CHARS = 400;

export const TOKEN_ESTIMATE_NOTE =
  'every token number here is an ESTIMATE — characters divided by 4, the industry approximation. '
  + 'This package ships zero dependencies and therefore carries no tokeniser, so these are not exact counts '
  + 'and are least accurate on non-English text.';

/* ── tool vocabulary ─────────────────────────────────────────────────────── */

/** Tools whose result is a snapshot of a file or directory at a point in time. */
const READ_TOOLS = new Set(['read_file', 'read_lines', 'read_around', 'list_dir', 'read_skill']);

/** Tools whose result is the output of running something. */
const COMMAND_TOOLS = new Set(['run_command', 'run_program', 'evaluate', 'check_types', 'check_acceptance']);

/** Tools whose result is a list of places to look. */
const SEARCH_TOOLS = new Set(['search_text', 'find_files', 'find_definition', 'find_references', 'list_symbols']);

/**
 * Tools that constitute "acting on" a path. A search whose hits were later
 * opened or edited has done its job; the hit list is navigation exhaust.
 */
const ACT_TOOLS = new Set([
  'read_file', 'read_lines', 'read_around', 'edit_file', 'write_file', 'delete_file', 'make_document',
]);

/* ── estimation ──────────────────────────────────────────────────────────── */

/**
 * @param {unknown} text
 * @param {number} [charsPerToken]
 * @returns {number} an ESTIMATE, rounded up. Non-strings are 0 — they are not
 *   silently coerced, because `estimateTokens(someObject)` returning a number
 *   derived from "[object Object]" is a fake measurement.
 */
export function estimateTokens(text, charsPerToken = CHARS_PER_TOKEN) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const per = charsPerToken > 0 ? charsPerToken : CHARS_PER_TOKEN;
  return Math.ceil(text.length / per);
}

/**
 * The estimated character weight of ONE message, un-rounded.
 *
 * ⚠️ COUNTS `tool_calls`, AND THE FIRST VERSION DID NOT. An assistant message
 * that dispatches six calls often has empty `content` and several hundred
 * characters of JSON arguments; counting only `content` made the heaviest
 * messages in a parallel-call transcript estimate as free.
 */
function messageChars(m) {
  if (!m || typeof m !== 'object') return MESSAGE_OVERHEAD_CHARS;
  let chars = MESSAGE_OVERHEAD_CHARS;
  chars += typeof m.role === 'string' ? m.role.length : 0;
  chars += contentChars(m);
  if (typeof m.name === 'string') chars += m.name.length;
  if (typeof m.tool_call_id === 'string') chars += m.tool_call_id.length;
  if (Array.isArray(m.tool_calls)) {
    for (const c of m.tool_calls) {
      try { chars += JSON.stringify(c ?? null).length; } catch { chars += 64; }
    }
  }
  return chars;
}

function contentChars(m) {
  const c = m?.content;
  if (typeof c === 'string') return c.length;
  if (c == null) return 0;
  try { return JSON.stringify(c).length; } catch { return 0; }
}

/**
 * @param {unknown} messages
 * @param {number} [charsPerToken]
 * @returns {number} an ESTIMATE of the whole payload, rounded up ONCE at the
 *   end — per-message rounding would drift by hundreds of tokens over a long
 *   transcript and make `before - after` disagree with the sum of the parts.
 */
export function estimateMessagesTokens(messages, charsPerToken = CHARS_PER_TOKEN) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const per = charsPerToken > 0 ? charsPerToken : CHARS_PER_TOKEN;
  let chars = 0;
  for (const m of messages) chars += messageChars(m);
  return Math.ceil(chars / per);
}

/**
 * ── ⚠️⚠️ THE TOOL SCHEMAS ARE PART OF THE PAYLOAD AND WERE COUNTED AS ZERO ──
 *
 * `estimateMessagesTokens` measures MESSAGES. A chat completion sends messages
 * AND the `tools` array, and the provider counts both against the context — so
 * every round was under-measured by the whole offer.
 *
 * Measured 2026-08-13 on a bare machine: 34 tools, 26,287 characters of JSON
 * schema, **~6,572 tokens — 6.8% of the 96,000-token budget, invisible**. With
 * MCP servers attached it is far larger, because their schemas are written by
 * somebody else and nobody here is trimming them.
 *
 * ⭐ THE FAILURE THIS PREVENTS IS THE WORST-SHAPED ONE AVAILABLE: the compactor
 * reports headroom while the provider returns a context-length error. It looks
 * like a provider bug, it is not reproducible from the transcript we kept, and
 * compaction can never rescue it — compaction rewrites MESSAGES, and the offer
 * is not a message.
 *
 * ⚠️ Deliberately the same crude chars/4 as the rest of this module rather than
 * a real tokeniser. It is an ESTIMATE used to decide when to compact, and a
 * consistent estimate is worth more here than an accurate one that disagrees
 * with the number it is compared against.
 */
export function estimateToolOfferTokens(tools, charsPerToken = CHARS_PER_TOKEN) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  const per = charsPerToken > 0 ? charsPerToken : CHARS_PER_TOKEN;
  let chars = 0;
  for (const t of tools) {
    try { chars += JSON.stringify(t)?.length ?? 0; } catch { /* a circular schema is not worth crashing a run over */ }
  }
  return Math.ceil(chars / per);
}

/* ── structure ───────────────────────────────────────────────────────────── */

/**
 * Split a transcript into the untouchable HEAD and the rounds after it.
 *
 * The head is the leading `system` messages plus the first `user` message —
 * the rules and the task. A "round" is an assistant message with `tool_calls`
 * plus the `tool` messages answering it; anything else (a plan banner, a bare
 * assistant note, a follow-up user turn) is its own single-message round so
 * that indices stay total and nothing falls between the cracks.
 *
 * @param {unknown[]} messages
 * @returns {{ head: number[], rounds: number[][] }} INDICES, not messages —
 *   the caller needs to address the original array by position.
 */
export function groupRounds(messages) {
  const head = [];
  const rounds = [];
  if (!Array.isArray(messages)) return { head, rounds };
  let i = 0;
  while (i < messages.length && messages[i]?.role === 'system') head.push(i++);
  if (i < messages.length && messages[i]?.role === 'user') head.push(i++);
  while (i < messages.length) {
    const m = messages[i];
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const group = [i++];
      while (i < messages.length && messages[i]?.role === 'tool') group.push(i++);
      rounds.push(group);
      continue;
    }
    rounds.push([i++]);
  }
  return { head, rounds };
}

/**
 * ⭐⭐ THE SKELETON, WITH EVERY BYTE OF CONTENT REMOVED. Roles, call ids and
 * result ids, in order. Two transcripts with the same fingerprint are the same
 * conversation as far as an OpenAI-shaped provider is concerned; they differ
 * only in what was said, never in what was asked and answered.
 *
 * This is the guard `compactMessages` runs against itself. A compactor that
 * dropped, reordered or inserted a message changes the fingerprint, and the
 * change is caught before the payload ever reaches a provider.
 *
 * @param {unknown[]} messages
 * @returns {string}
 */
export function structuralFingerprint(messages) {
  if (!Array.isArray(messages)) return '[]';
  const skeleton = messages.map((m) => {
    const row = { r: m?.role ?? null };
    if (typeof m?.tool_call_id === 'string') row.a = m.tool_call_id;
    if (Array.isArray(m?.tool_calls)) {
      row.c = m.tool_calls.map((c) => `${c?.id ?? ''}:${c?.function?.name ?? c?.name ?? ''}`);
    }
    return row;
  });
  return JSON.stringify(skeleton);
}

/**
 * Is every declared call answered, in order?
 *
 * ⚠️ AN ORPHAN `tool` MESSAGE IS NOT A VIOLATION OF THIS RULE. The provider
 * rejects an unanswered CALL; a stray result with no declaring call is a
 * different (and rarer) problem, and reporting it here would make this checker
 * refuse histories the API accepts — a check that fails correct work.
 *
 * @param {unknown[]} messages
 * @returns {{ ok: boolean, checked: number, unanswered: string[] }}
 */
export function verifyToolPairing(messages) {
  const unanswered = [];
  let checked = 0;
  if (!Array.isArray(messages)) return { ok: true, checked: 0, unanswered };
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    const answers = [];
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === 'tool') answers.push(messages[j++].tool_call_id);
    const seen = new Set(answers);
    for (const c of m.tool_calls) {
      checked += 1;
      if (!seen.has(c?.id)) unanswered.push(String(c?.id ?? '(no id)'));
    }
  }
  return { ok: unanswered.length === 0, checked, unanswered };
}

/* ── request identity ────────────────────────────────────────────────────── */

/**
 * ⚠️⭐ WHY SUPERSESSION IS KEYED ON THE WHOLE REQUEST AND NOT ON THE PATH.
 *
 * The tempting rule is "the same file read twice — keep the last". It is WRONG
 * for windowed reads, and wrong in the expensive direction. `read_lines` of
 * lines 1–200 followed by `read_lines` of lines 201–400 is the same path and
 * two entirely different, entirely current pieces of information. Declaring the
 * first superseded deletes half the file the model just paged through, and the
 * model then reasons confidently about code it can no longer see.
 *
 * ⭐ So the identity is TOOL NAME + CANONICAL ARGUMENTS: the same request,
 * issued again. That is conservative by construction — it can miss a saving,
 * and it cannot invent one. Missing a saving costs context; inventing one costs
 * correctness, and only one of those is recoverable.
 */
function requestKey(name, args) {
  return `${name}|${canonicalJson(normaliseArgs(args))}`;
}

function normaliseArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = k === 'path' || k === 'file' || k === 'dir' ? normalisePath(v) : v;
  }
  return out;
}

/** `./lib\slug.mjs` and `lib/slug.mjs` are the same file to every human. */
function normalisePath(value) {
  if (typeof value !== 'string') return value;
  let p = value.replace(/\\/g, '/').trim();
  while (p.startsWith('./')) p = p.slice(2);
  return p.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function parseCallArgs(call) {
  const raw = call?.function?.arguments ?? call?.arguments;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // ⚠️ A model that emits malformed JSON arguments is common enough that
    // throwing here would take the whole session down over a comma. An
    // unparseable call simply has no identity, so it is never compacted.
    return {};
  }
}

/**
 * Index every call and every result, and join them by id.
 * @returns {{ calls: any[], results: any[] }}
 */
function indexTranscript(messages) {
  const byId = new Map();
  const calls = [];
  const results = [];
  messages.forEach((m, index) => {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        const name = c?.function?.name ?? c?.name ?? null;
        const args = parseCallArgs(c);
        const rec = { id: c?.id ?? null, name, args, index, path: pathOf(args) };
        calls.push(rec);
        if (rec.id != null && !byId.has(rec.id)) byId.set(rec.id, rec);
      }
    }
    if (m?.role === 'tool') {
      const call = m.tool_call_id != null ? byId.get(m.tool_call_id) : undefined;
      const name = (typeof m.name === 'string' && m.name) ? m.name : (call?.name ?? null);
      const args = call?.args ?? {};
      results.push({
        index,
        id: m.tool_call_id ?? null,
        name,
        args,
        path: pathOf(args),
        key: name ? requestKey(name, args) : null,
        chars: typeof m.content === 'string' ? m.content.length : -1,
      });
    }
  });
  return { calls, results };
}

function pathOf(args) {
  const p = args?.path ?? args?.file ?? args?.dir;
  return typeof p === 'string' && p ? normalisePath(p) : null;
}

function subjectLabel(name, args) {
  if (READ_TOOLS.has(name)) return pathOf(args) ?? name;
  if (COMMAND_TOOLS.has(name)) {
    if (typeof args?.command === 'string') return args.command;
    if (Array.isArray(args?.argv)) return args.argv.join(' ');
    return name;
  }
  if (SEARCH_TOOLS.has(name)) {
    const q = args?.pattern ?? args?.query ?? args?.name ?? args?.symbol;
    return typeof q === 'string' ? q : name;
  }
  return pathOf(args) ?? name;
}

/* ── text surgery ────────────────────────────────────────────────────────── */

/**
 * Slice without splitting a surrogate pair.
 *
 * ⚠️ FOUND BY TESTING A LEGITIMATE SHAPE, NOT A DEFECT. `String.slice` works on
 * UTF-16 code units, so cutting a run of emoji at an arbitrary offset produces
 * a lone high surrogate — a replacement character on screen and, worse, a byte
 * sequence that is not valid UTF-8 going back over the wire.
 */
function safeHead(s, n) {
  if (n >= s.length) return s;
  let end = n;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // do not leave a lone high surrogate
  return s.slice(0, Math.max(0, end));
}

function safeTail(s, n) {
  if (n >= s.length) return s;
  let start = s.length - n;
  const code = s.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1; // do not start on a lone low surrogate
  return s.slice(Math.min(s.length, start));
}

const n = (x) => x.toLocaleString('en-US');

/**
 * ── ⚠️ THE FIRST VERSION OF THIS WAS TOO LOOSE, AND THE TEST CAUGHT IT ──────
 *
 * It was `/(error|failed|assertion|…)/i`, on the reasoning that keeping one
 * line too many costs 80 characters and keeping none costs the model the reason
 * its build broke. That reasoning is right and the regex was still wrong: run
 * it over real TAP output and `ok 3 - filler assertion number 0` matches, so
 * the "first failing line" the compactor preserved was a PASSING line, and the
 * actual failure — the one fact worth keeping — was dropped. A stale result
 * that keeps the wrong line is worse than one that keeps none, because it reads
 * as evidence.
 *
 * ⭐ SO IT MATCHES NAMED CONVENTIONS, NOT KEYWORDS. Each entry below is a
 * specific runner's specific failure format. Anchoring and case matter: `FAIL`
 * at the start of a line is jest, `fail` inside a sentence is prose.
 */
const FAILURE_PATTERNS = [
  /^\s*not ok\b/,                                 // TAP / node:test
  /^\s*(FAIL|FAILED|ERROR|ERR)\b/,                // jest, mocha, ctest, many CI runners
  /^\s*[✗✘✖×⨯]\s/,                                 // vitest, ava, tap-spec
  /^\s*npm ERR!/,                                 // npm
  /^\s*panic:/,                                   // go
  /^Traceback \(most recent call last\)/,          // python
  /\b(Assertion|Type|Reference|Syntax|Range|Eval|URI)Error\b/, // js runtimes
  /(^|\s)Error:\s/,                               // thrown errors, tsc --pretty false
  /:\s*error\s(TS\d+|[A-Z]{1,4}\d+)/,              // tsc / msvc style "file(1,2): error TS2345"
  /\s{2}error\s{2}/,                              // eslint stylish
  /^\s*\d+\)\s/,                                  // mocha's numbered failure list
];

function isFailureLine(line) {
  for (const rx of FAILURE_PATTERNS) if (rx.test(line)) return true;
  return false;
}

/**
 * Keep the header of a command result (the `$ cmd` line and the exit/timeout
 * line, both written by `command.mjs`'s `formatRunForModel`) plus the first
 * failing line, and drop the rest.
 */
function gutCommandOutput(text) {
  const lines = text.split('\n');
  const kept = [];
  // The two header lines, when they are there. A result that does not look like
  // formatRunForModel output still keeps its first two lines, which is the
  // honest fallback: something is better than a bare stub.
  for (let i = 0; i < Math.min(2, lines.length); i += 1) kept.push(lines[i]);
  let firstFailure = null;
  for (let i = 2; i < lines.length; i += 1) {
    if (isFailureLine(lines[i])) { firstFailure = lines[i]; break; }
  }
  if (firstFailure !== null) kept.push(firstFailure.length > 400 ? `${safeHead(firstFailure, 400)}…` : firstFailure);
  return kept.join('\n');
}

/* ── the passes ──────────────────────────────────────────────────────────── */

/**
 * Every pass returns candidates OLDEST FIRST. Order matters twice over: oldest
 * content is the least likely to be load-bearing, and processing in transcript
 * order makes the result deterministic without a sort key.
 */
function passSupersededReads(messages, results, compactable) {
  const lastIndexForKey = new Map();
  // ⚠️ Built over ALL results, including protected ones. A protected recent read
  // still SUPERSEDES an old one — protection says "do not compact this message",
  // not "pretend this message does not exist".
  for (const r of results) if (r.key && READ_TOOLS.has(r.name)) lastIndexForKey.set(r.key, r.index);

  const out = [];
  for (const r of results) {
    if (!compactable.has(r.index) || !READ_TOOLS.has(r.name) || !r.key) continue;
    const newest = lastIndexForKey.get(r.key);
    if (newest === undefined || newest <= r.index) continue;
    const label = subjectLabel(r.name, r.args);
    out.push({
      index: r.index,
      pass: 'superseded-reads',
      tool: r.name,
      subject: label,
      content:
        `[superseded ${r.name} of ${label} — the identical read was issued again later in this session, and THAT result `
        + `is the current one. ${n(r.chars)} characters of stale content (~${n(estimateTokens(messages[r.index].content))} `
        + 'estimated tokens) were dropped here by the context compactor. Nothing about the file changed; only this stale copy was removed.]',
    });
  }
  return out;
}

function passStaleCommands(messages, results, compactable) {
  const lastIndexForKey = new Map();
  for (const r of results) if (r.key && COMMAND_TOOLS.has(r.name)) lastIndexForKey.set(r.key, r.index);

  const out = [];
  for (const r of results) {
    if (!compactable.has(r.index) || !COMMAND_TOOLS.has(r.name) || !r.key) continue;
    const newest = lastIndexForKey.get(r.key);
    if (newest === undefined || newest <= r.index) continue;
    const original = messages[r.index].content;
    const gutted = gutCommandOutput(original);
    const removed = original.length - gutted.length;
    // ⚠️ A "compaction" that grows the message is not a compaction. Short
    // outputs hit this constantly, and without the guard the report would count
    // savings that are losses.
    if (removed <= 200) continue;
    out.push({
      index: r.index,
      pass: 'stale-commands',
      tool: r.name,
      subject: subjectLabel(r.name, r.args),
      content:
        `${gutted}\n[stale command output — this exact command was re-run later in this session and the newer result `
        + `supersedes it. The exit status above and the first failing line are kept; ${n(removed)} characters of superseded `
        + `output (~${n(estimateTokens(original.slice(gutted.length)))} estimated tokens) were dropped by the context compactor.]`,
    });
  }
  return out;
}

function passGiantResults(messages, results, compactable, maxResultChars) {
  const out = [];
  for (const r of results) {
    if (!compactable.has(r.index)) continue;
    const original = messages[r.index].content;
    if (typeof original !== 'string' || original.length <= maxResultChars) continue;
    const headChars = Math.max(1, Math.floor(maxResultChars * 0.6));
    const tailChars = Math.max(1, maxResultChars - headChars);
    const headText = safeHead(original, headChars);
    const tailText = safeTail(original, tailChars);
    const removed = original.length - headText.length - tailText.length;
    if (removed <= 200) continue;
    out.push({
      index: r.index,
      pass: 'giant-results',
      tool: r.name ?? 'tool',
      subject: subjectLabel(r.name, r.args),
      content:
        `${headText}\n\n[… ${n(removed)} characters removed from the MIDDLE of this ${r.name ?? 'tool'} result `
        + `(~${n(Math.ceil(removed / CHARS_PER_TOKEN))} estimated tokens) to fit the context budget. `
        + `The text before and after this marker is verbatim. Re-run the tool if you need the middle. …]\n\n${tailText}`,
    });
  }
  return out;
}

function passDeadSearches(messages, results, calls, compactable) {
  const out = [];
  for (const r of results) {
    if (!compactable.has(r.index) || !SEARCH_TOOLS.has(r.name)) continue;
    const body = messages[r.index].content;
    if (typeof body !== 'string' || body.length === 0) continue;
    // Which of the paths this search surfaced were opened or edited AFTERWARDS?
    // "Afterwards" is the load-bearing word: a file opened BEFORE the search was
    // not found by it, and the search is still the only record of the others.
    const acted = [];
    for (const c of calls) {
      if (c.index <= r.index || !ACT_TOOLS.has(c.name) || !c.path) continue;
      if (body.includes(c.path) && !acted.includes(c.path)) acted.push(c.path);
    }
    if (acted.length === 0) continue;
    const hits = body.split('\n').filter((l) => l.trim()).length;
    const shown = acted.slice(0, 5).join(', ');
    out.push({
      index: r.index,
      pass: 'dead-searches',
      tool: r.name,
      subject: subjectLabel(r.name, r.args),
      content:
        `[dead search — ${r.name} for "${subjectLabel(r.name, r.args)}" returned ${n(hits)} hit lines, and the files it `
        + `pointed at were opened or edited later in this session (${shown}${acted.length > 5 ? `, +${acted.length - 5} more` : ''}). `
        + `The hit list has served its purpose, so ${n(body.length)} characters (~${n(estimateTokens(body))} estimated tokens) `
        + 'were dropped by the context compactor. Re-run the search if you need the full list again.]',
    });
  }
  return out;
}

/* ── the entry point ─────────────────────────────────────────────────────── */

/**
 * @typedef {object} CompactAction
 * @property {number} index      position in the message array
 * @property {string} pass       which pass made the change
 * @property {string} tool       the tool whose result was rewritten
 * @property {string} subject    the file, command or query it was about
 * @property {number} beforeChars
 * @property {number} afterChars
 *
 * @typedef {object} CompactReport
 * @property {string} method     ⚠️ says out loud that the tokens are estimates
 * @property {number} budgetTokens
 * @property {number} keepLastRounds
 * @property {number} beforeTokens
 * @property {number} afterTokens
 * @property {number} freedTokens
 * @property {number} freedPercent
 * @property {boolean} underBudget  false means compaction could NOT reach the budget
 * @property {number} totalMessages
 * @property {number} totalResults
 * @property {number} compactableResults
 * @property {string[]} protectedByReference  subjects the newest assistant message names
 * @property {{ ok: boolean, checked: number, unanswered: string[] }} inputPairing
 * @property {{ ok: boolean, checked: number, unanswered: string[] }} pairing
 * @property {boolean} refused   true when the guard rejected the compactor's own output
 * @property {{ pass: string, applied: number }[]} passes
 * @property {number} clampChars    the per-result clamp finally used (tightened if needed)
 * @property {number} tightenRounds how many times the clamp had to halve
 * @property {CompactAction[]} actions
 * @property {string[]} lines    a human-readable summary
 */

/**
 * Compact an agentic transcript by attacking stale TOOL RESULTS. Pure and
 * deterministic: no model, no network, no clock.
 *
 * ⭐ IT DOES THE LEAST DAMAGE THAT CLEARS THE BUDGET. The passes run in order of
 * how obviously dead their target is, and the loop STOPS the moment the estimate
 * is under `budgetTokens`. A transcript that already fits is returned byte-for-
 * byte unchanged, which is the common case and must cost nothing.
 *
 * @param {any[]} messages         an OpenAI-shaped message array
 * @param {object} [options]
 * @param {number} [options.budgetTokens]    target size. Default 24,000.
 * @param {number} [options.keepLastRounds]  recent tool rounds kept verbatim. Default 2.
 * @param {number} [options.maxResultChars]  clamp threshold for one result. Default 4,000.
 * @param {number} [options.charsPerToken]   the estimator's divisor. Default 4.
 * @returns {{ messages: any[], dropped: number, freedTokens: number, report: CompactReport }}
 *   `dropped` counts tool RESULTS whose body was stubbed, gutted or clamped —
 *   never messages, because messages are never removed.
 */
export function compactMessages(messages, options = {}) {
  const budgetTokens = Number.isFinite(options.budgetTokens) ? Math.max(0, options.budgetTokens) : DEFAULT_BUDGET_TOKENS;
  const keepLastRounds = Number.isFinite(options.keepLastRounds) ? Math.max(0, Math.floor(options.keepLastRounds)) : DEFAULT_KEEP_LAST_ROUNDS;
  const maxResultChars = Number.isFinite(options.maxResultChars) && options.maxResultChars > 0 ? Math.floor(options.maxResultChars) : DEFAULT_MAX_RESULT_CHARS;
  const charsPerToken = Number.isFinite(options.charsPerToken) && options.charsPerToken > 0 ? options.charsPerToken : CHARS_PER_TOKEN;

  const baseReport = {
    method: TOKEN_ESTIMATE_NOTE,
    budgetTokens,
    keepLastRounds,
    beforeTokens: 0,
    afterTokens: 0,
    freedTokens: 0,
    freedPercent: 0,
    underBudget: true,
    totalMessages: 0,
    totalResults: 0,
    compactableResults: 0,
    protectedByReference: [],
    inputPairing: { ok: true, checked: 0, unanswered: [] },
    pairing: { ok: true, checked: 0, unanswered: [] },
    refused: false,
    clampChars: 0,
    tightenRounds: 0,
    passes: [],
    actions: [],
    lines: [],
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages: [],
      dropped: 0,
      freedTokens: 0,
      report: { ...baseReport, lines: ['nothing to compact — the transcript is empty.'] },
    };
  }

  const beforeTokens = estimateMessagesTokens(messages, charsPerToken);
  const inputPairing = verifyToolPairing(messages);

  const { rounds } = groupRounds(messages);
  const { calls, results } = indexTranscript(messages);

  /**
   * ⭐ THE KEEP WINDOW COUNTS TOOL ROUNDS, NOT MESSAGES OR ENTRIES. A trailing
   * run of bare assistant notes and plan banners would otherwise eat the whole
   * window and protect nothing that costs anything.
   */
  const toolRoundStarts = rounds
    .filter((group) => group.some((i) => messages[i]?.role === 'tool'))
    .map((group) => group[0]);
  const protectFromIndex = keepLastRounds <= 0
    ? messages.length
    : (toolRoundStarts.length <= keepLastRounds ? (toolRoundStarts[0] ?? messages.length) : toolRoundStarts[toolRoundStarts.length - keepLastRounds]);

  /**
   * ⚠️ WHAT THE MODEL JUST NAMED IS OFF LIMITS. The newest assistant message is
   * the model's live train of thought; if it says "compare against the earlier
   * lib/slug.mjs" then that stale read is not stale, it is the working set.
   * Matching is a substring test on subjects of 3+ characters — shorter ones
   * would match by accident and protect everything.
   */
  const newestAssistant = [...messages].reverse().find((m) => m?.role === 'assistant');
  const newestText = typeof newestAssistant?.content === 'string' ? newestAssistant.content : '';
  const protectedByReference = [];
  const referencedSubjects = new Set();
  if (newestText) {
    for (const r of results) {
      const label = subjectLabel(r.name, r.args);
      if (typeof label === 'string' && label.length >= 3 && newestText.includes(label) && !referencedSubjects.has(label)) {
        referencedSubjects.add(label);
        protectedByReference.push(label);
      }
    }
  }

  const compactable = new Set();
  for (const r of results) {
    if (r.index >= protectFromIndex) continue;
    if (typeof messages[r.index].content !== 'string') continue; // never rewrite structured content
    if (messages[r.index].content.length === 0) continue;
    if (referencedSubjects.has(subjectLabel(r.name, r.args))) continue;
    compactable.add(r.index);
  }

  const report = {
    ...baseReport,
    beforeTokens,
    afterTokens: beforeTokens,
    totalMessages: messages.length,
    totalResults: results.length,
    compactableResults: compactable.size,
    protectedByReference,
    inputPairing,
    pairing: inputPairing,
    underBudget: beforeTokens <= budgetTokens,
  };

  if (beforeTokens <= budgetTokens || compactable.size === 0) {
    report.lines = [
      `${n(beforeTokens)} estimated tokens vs a ${n(budgetTokens)} budget — `
      + (beforeTokens <= budgetTokens ? 'already fits, nothing compacted.' : 'nothing is eligible for compaction.'),
    ];
    report.underBudget = beforeTokens <= budgetTokens;
    return { messages: messages.slice(), dropped: 0, freedTokens: 0, report };
  }

  // ── apply, cheapest-truth-first, and stop as soon as it fits ─────────────
  const working = messages.slice();
  const perMessageChars = messages.map((m) => messageChars(m));
  let totalChars = perMessageChars.reduce((a, b) => a + b, 0);
  const budgetChars = budgetTokens * charsPerToken;

  /** index -> the action that rewrote it. A Map, not an array, because the
   *  tightening loop below may REVISE an earlier clamp and must update the
   *  record rather than report the same message twice. */
  const applied = new Map();
  const passCounts = [];

  /** Apply one candidate, keeping `totalChars` and the action record in step. */
  const apply = (candidate, passName, { allowReclamp = false } = {}) => {
    const prior = applied.get(candidate.index);
    if (prior && !(allowReclamp && prior.pass === 'giant-results')) return false;
    const current = working[candidate.index];
    if (typeof current.content !== 'string') return false;
    // ⚠️ A candidate that does not shrink the message is skipped, not applied.
    if (candidate.content.length >= current.content.length) return false;
    working[candidate.index] = { ...current, content: candidate.content };
    const newChars = messageChars(working[candidate.index]);
    totalChars += newChars - perMessageChars[candidate.index];
    perMessageChars[candidate.index] = newChars;
    applied.set(candidate.index, {
      index: candidate.index,
      pass: passName,
      tool: candidate.tool,
      subject: candidate.subject,
      // ⚠️ ALWAYS the ORIGINAL length, even on a re-clamp — reporting the length
      // of a previous clamp as "before" would understate what was removed.
      beforeChars: prior?.beforeChars ?? current.content.length,
      afterChars: candidate.content.length,
    });
    return true;
  };

  /**
   * ── ⭐ THE ORDER IS BY HOW PROVABLY DEAD THE TARGET IS, NOT BY PASS NUMBER ──
   *
   * Because the loop stops the moment the transcript fits, the ORDER decides
   * what gets destroyed when only partial compaction is needed. The first three
   * passes target content that is dead as a matter of fact:
   *
   *   · a superseded read — an identical later read exists, this copy is stale;
   *   · a stale command   — the identical command was re-run, this result is old;
   *   · a dead search     — the files it found were subsequently opened or
   *                         edited, so the hit list has done its navigating.
   *
   * `giant-results` runs LAST because it is the only pass that cuts into
   * CURRENT information: it clamps the middle out of the one and only copy of
   * a live result. ⚠️ It is listed third in the brief and it is applied fourth
   * here, deliberately. Applying it earlier means a transcript holding one dead
   * search and one large live file read would gut the live file and leave the
   * dead search sitting there — strictly the worse of the two available cuts.
   * `report.passes` prints the applied order, so this is visible, not hidden.
   */
  const passes = [
    ['superseded-reads', () => passSupersededReads(messages, results, compactable)],
    ['stale-commands', () => passStaleCommands(messages, results, compactable)],
    ['dead-searches', () => passDeadSearches(messages, results, calls, compactable)],
    ['giant-results', () => passGiantResults(messages, results, compactable, maxResultChars)],
  ];

  outer:
  for (const [passName, build] of passes) {
    let count = 0;
    for (const candidate of build()) {
      if (totalChars <= budgetChars) { passCounts.push({ pass: passName, applied: count }); break outer; }
      if (apply(candidate, passName)) count += 1;
    }
    passCounts.push({ pass: passName, applied: count });
  }

  /**
   * ── ⭐⭐ THE CLAMP TIGHTENS. MEASURED, NOT GUESSED ─────────────────────────
   *
   * A FIXED clamp has a floor: `maxResultChars × compactable results`. On a real
   * captured session — 23 messages, twelve unique large `read_file` results,
   * nothing re-read and nothing searched — that floor made the compactor
   * PLATEAU: 33,128 → 25,816 estimated tokens at a budget of 24,000, and the
   * identical 25,816 at a budget of 8,000. Lowering the budget did nothing at
   * all, and the report said "22.1% freed" while the session was still four
   * times over its target.
   *
   * ⚠️ That plateau is this module failing at its actual job, and it gets worse
   * with exactly the thing it exists to unlock. At a 60-round horizon there are
   * a hundred results, so a 4,000-character floor is 400,000 characters — a
   * larger transcript than the one we started with.
   *
   * ⭐ So when the four passes leave it over budget, the clamp HALVES and the
   * clamp pass runs again, down to `MIN_CLAMP_CHARS`. Two properties make this
   * safe rather than merely aggressive:
   *
   *   · IT RE-CLAMPS FROM THE ORIGINAL, never on top of a previous clamp. A
   *     clamp of a clamp would nest "[… N characters removed …]" markers inside
   *     each other and the arithmetic in every one of them would be wrong.
   *   · IT NEVER OVERWRITES A STUB. A superseded-read stub is both smaller than
   *     any clamp and strictly more informative, so a clamp replacing one would
   *     be a loss in both directions.
   *
   * ⚠️ AND IT STOPS AT A FLOOR. Tightening to zero produces a tool result that
   * is nothing but an apology, which is a hole in the history dressed as a
   * message. If MIN_CLAMP_CHARS is not enough, the honest answer is
   * `underBudget: false` — which the report gives.
   */
  let clampChars = maxResultChars;
  let tightenRounds = 0;
  while (totalChars > budgetChars && clampChars > MIN_CLAMP_CHARS) {
    clampChars = Math.max(MIN_CLAMP_CHARS, Math.floor(clampChars / 2));
    tightenRounds += 1;
    let count = 0;
    for (const candidate of passGiantResults(messages, results, compactable, clampChars)) {
      if (totalChars <= budgetChars) break;
      if (apply(candidate, 'giant-results', { allowReclamp: true })) count += 1;
    }
    const row = passCounts.find((p) => p.pass === 'giant-results');
    if (row) row.applied = [...applied.values()].filter((a) => a.pass === 'giant-results').length;
    else passCounts.push({ pass: 'giant-results', applied: count });
  }

  // Transcript order, so the report reads like the conversation.
  const actions = [...applied.values()].sort((a, b) => a.index - b.index);

  /**
   * ⚠️⚠️ THE GUARD. If compaction changed the SHAPE of the conversation in any
   * way — a message removed, reordered, an id altered — the output is thrown
   * away and the input is returned. It cannot happen through the code above,
   * which only ever replaces `content` at a fixed index; this exists because
   * "it cannot happen" is what was said about the last five things that did.
   */
  if (structuralFingerprint(working) !== structuralFingerprint(messages)) {
    return {
      messages: messages.slice(),
      dropped: 0,
      freedTokens: 0,
      report: {
        ...report,
        refused: true,
        pairing: verifyToolPairing(working),
        lines: [
          'COMPACTION REFUSED: the compacted transcript did not match the shape of the original, '
          + 'which would make every following round a provider 400. The original history was returned unchanged.',
        ],
      },
    };
  }

  const afterTokens = estimateMessagesTokens(working, charsPerToken);
  const freedTokens = beforeTokens - afterTokens;
  const outputPairing = verifyToolPairing(working);

  report.afterTokens = afterTokens;
  report.freedTokens = freedTokens;
  report.freedPercent = beforeTokens > 0 ? Math.round((freedTokens / beforeTokens) * 1000) / 10 : 0;
  report.underBudget = afterTokens <= budgetTokens;
  report.pairing = outputPairing;
  report.passes = passCounts;
  report.actions = actions;
  report.clampChars = clampChars;
  report.tightenRounds = tightenRounds;
  report.lines = [
    `${n(beforeTokens)} → ${n(afterTokens)} estimated tokens (${report.freedPercent}% freed, ~${n(freedTokens)} tokens) `
    + `across ${actions.length} of ${results.length} tool results.`,
    ...passCounts.filter((p) => p.applied > 0).map((p) => `  ${p.pass}: ${p.applied}`),
    ...(tightenRounds > 0
      ? [`  the per-result clamp tightened ${tightenRounds}× — ${n(maxResultChars)} → ${n(clampChars)} chars — `
        + 'because a fixed clamp could not reach the budget.']
      : []),
    report.underBudget
      ? `  under the ${n(budgetTokens)} token budget.`
      : `  ⚠️ STILL OVER the ${n(budgetTokens)} token budget by ~${n(afterTokens - budgetTokens)} tokens — `
        + 'everything left is either recent, referenced, or the only copy.',
    `  ⚠️ ${TOKEN_ESTIMATE_NOTE}`,
  ];

  return { messages: working, dropped: actions.length, freedTokens, report };
}

/**
 * ── ⭐ THE WIRING SEAM (this module is useless until someone calls it) ──────
 *
 * A MODULE NOBODY IMPORTS IS NOT A FEATURE. In `lib/turn.mjs`, inside the round
 * loop, immediately BEFORE `const reply = await callModelImpl({... messages ...})`:
 *
 *     import { compactMessages } from './compact.mjs';           // top of file
 *
 *     const fit = compactMessages(messages, {
 *       budgetTokens: config.contextBudgetTokens ?? 24_000,
 *       keepLastRounds: 2,
 *     });
 *     if (fit.dropped > 0) {
 *       messages.length = 0;
 *       messages.push(...fit.messages);
 *       onEvent({ type: 'compact', round, report: fit.report });
 *     }
 *
 * ⚠️ `messages` is reassigned IN PLACE because the surrounding loop closes over
 * the same binding — rebinding it with `messages = fit.messages` would leave
 * later pushes writing to the old array on some code paths.
 *
 * ⚠️ AND IT MUST RUN BEFORE THE CALL, NOT AFTER. Compacting after the reply has
 * already been paid for saves nothing on the round that burst.
 */
