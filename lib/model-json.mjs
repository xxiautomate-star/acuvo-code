/**
 * ── ⚠️⚠️ CLAMPED JSON IS UNPARSEABLE JSON ───────────────────────────────────
 *
 * `toolResultText` formats 24 of the 63 dispatched tools. The other 39 fall to
 * `default: clampOutput(JSON.stringify(result))` — and so does **every MCP
 * result**, whose names are `mcp__<server>__<tool>` and can never match a case.
 *
 * `clampOutput` is well built for what it was written for: it keeps 35% head and
 * 65% tail and splices `… N characters omitted …` between them, so nothing is
 * lost silently and trailing fields survive. On PROSE that degrades gracefully.
 *
 * ⚠️ On a serialised object it does not degrade — it breaks. The splice lands
 * mid-object and the result is no longer JSON at all. Measured on `git_diff`
 * against an ordinary 400-line refactor: an 8,030-character reply that
 * `JSON.parse` rejects. The model is then reading a broken object and inferring
 * its fields, which is the failure mode an earlier audit recorded as *"search
 * results were arriving 19% complete, as broken JSON"*.
 *
 * ⭐ THE FIX IS TO SHRINK THE PAYLOAD, NOT THE SYNTAX. Cut the big string
 * FIELDS inside the object until the whole thing fits, and the reply stays
 * valid JSON with every flag, every count and every pagination cursor intact.
 * A `diff` or a `stdout` is what is actually large; `ok`, `truncated` and
 * `nextPage` are bytes that must never be the ones sacrificed.
 *
 * ⚠️ It shrinks the LARGEST field first and re-measures each time, rather than
 * dividing a budget evenly. A result carrying one 9KB `diff` beside a 40-char
 * `path` should lose only diff — an even split would mangle both.
 */

/** Mirrors `clampOutput`'s split so truncation reads the same everywhere. */
function spliceMiddle(text, budget) {
  const head = Math.floor(budget * 0.35);
  const tail = budget - head;
  const omitted = text.length - budget;
  return `${text.slice(0, head)}\n\n… ${omitted} characters omitted …\n\n${text.slice(-tail)}`;
}

/**
 * ⚠️ A floor, so a field is never cut to uselessness. Below this there is no
 * point keeping the field's content at all — a 20-character window of a diff
 * tells the model nothing and still costs it a read.
 */
const MIN_FIELD_CHARS = 200;

/** Every string field big enough to be worth cutting, deepest-first by size. */
function largeStrings(value, path = [], out = []) {
  if (typeof value === 'string') {
    if (value.length > MIN_FIELD_CHARS) out.push({ path, length: value.length });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => largeStrings(v, [...path, i], out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) largeStrings(v, [...path, k], out);
  }
  return out;
}

function getAt(root, path) {
  return path.reduce((acc, key) => acc?.[key], root);
}

function setAt(root, path, next) {
  const parent = path.slice(0, -1).reduce((acc, key) => acc[key], root);
  parent[path[path.length - 1]] = next;
}

/**
 * ── ⚠️⚠️ THE SIZE IS USUALLY IN THE ARRAY, AND CUTTING STRINGS NEVER REACHED IT
 *
 * MEASURED 2026-08-24, rendering a realistic oversized result for all 69
 * dispatched tools through the real `toolResultText`: **11 of them returned the
 * `_note` fallback below and NOTHING ELSE.** `review_code` (60 findings),
 * `gh_issue` / `gh_pr` / `gh_run` (40 items), `read_log` (400 lines),
 * `inspect_db` (60 tables), `sample_db_rows` (300 rows), `list_engines`,
 * `list_sessions`, `web_search`, `read_table` — every one of them handed the
 * model 245 characters of apology in place of its answer.
 *
 * ⚠️ THAT IS WORSE THAN THE UNPARSEABLE JSON THIS MODULE WAS WRITTEN TO FIX.
 * Broken JSON at least carried the data; a note carries none, and the model's
 * only move is to call the tool again — which produces the same note. A tool
 * that can never answer is a tool that does not exist, which is this package's
 * standing definition of a dead button.
 *
 * ⭐ SO ARRAYS ARE SHRUNK THE WAY STRINGS ARE: keep as many entries as fit, and
 * replace the rest with ONE marker element that says how many went and what to
 * do about it. The reply stays valid JSON — a mixed-type array is legal and
 * models read it natively — and the loss is announced AT THE POINT IT HAPPENED
 * rather than in a field the model has to notice.
 *
 * ⚠️ THE MARKER IS AN INSTRUCTION, NOT A LABEL. "250 more omitted" tells the
 * model it is missing something; naming `offset` / `limit` / a narrower path
 * tells it what to do next. That is the same rule `read_file`'s truncation
 * notice and `search_text`'s capped-walk sentence already follow.
 */
const MIN_KEPT_ELEMENTS = 1;
/** How many shrink passes before we accept the structural floor. Bounded so a
 *  pathological shape cannot spin here — each pass is guaranteed to remove at
 *  least one element, so this is a ceiling and not a hope. */
const MAX_ARRAY_PASSES = 24;

const markerFor = (dropped) => `… ${dropped} more omitted — ask again with an offset, a limit, or a narrower path to see the rest …`;

/** Every array worth cutting, biggest serialised payload first. */
function largeArrays(value, path = [], out = []) {
  if (Array.isArray(value)) {
    /**
     * ⚠️ An array we have ALREADY cut carries our own marker as its last
     * element. Cutting it again is legitimate (it may still be too big), but it
     * must not stack markers, so `shrinkArrays` strips the previous one first.
     */
    if (value.length > MIN_KEPT_ELEMENTS) out.push({ path, length: value.length, size: JSON.stringify(value)?.length ?? 0 });
    value.forEach((v, i) => largeArrays(v, [...path, i], out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) largeArrays(v, [...path, k], out);
  }
  return out;
}

const isMarker = (v) => typeof v === 'string' && v.startsWith('… ') && v.includes('more omitted');

/**
 * Cut the biggest array until the whole reply fits, one array per pass.
 *
 * ⚠️ RE-DERIVED EVERY PASS RATHER THAN PLANNED ONCE. Truncating an array
 * invalidates every recorded path that pointed INTO it, and writing through a
 * stale index is how a "shrink" silently corrupts a neighbouring field.
 *
 * @returns {string} the re-serialised JSON
 */
function shrinkArrays(clone, json, maxChars) {
  for (let pass = 0; pass < MAX_ARRAY_PASSES && json.length > maxChars; pass += 1) {
    const arrays = largeArrays(clone).sort((a, b) => b.size - a.size);
    const target = arrays[0];
    if (!target || target.size < 200) break;

    const live = getAt(clone, target.path);
    if (!Array.isArray(live) || live.length <= MIN_KEPT_ELEMENTS) break;

    // Drop our own previous marker before measuring, so the count stays true.
    const already = isMarker(live[live.length - 1]);
    const body = already ? live.slice(0, -1) : live;
    const dropped0 = already ? Number(String(live[live.length - 1]).match(/\d+/)?.[0] ?? 0) : 0;
    if (body.length <= MIN_KEPT_ELEMENTS) break;

    const excess = json.length - maxChars;
    const perElement = Math.max(1, Math.round(target.size / Math.max(1, body.length)));
    // One element of slack for the marker itself, and always at least one fewer
    // than we had, so a pass can never be a no-op.
    const wanted = body.length - Math.ceil(excess / perElement) - 1;
    const keep = Math.min(body.length - 1, Math.max(MIN_KEPT_ELEMENTS, wanted));

    const kept = body.slice(0, keep);
    const dropped = body.length - keep + dropped0;
    setAt(clone, target.path, [...kept, markerFor(dropped)]);
    json = JSON.stringify(clone);
  }
  return json;
}

/** Shrink the large string fields, largest first. Extracted so it can run again
 *  AFTER the arrays are cut — a surviving element may itself carry a long body. */
function shrinkStrings(clone, json, maxChars) {
  const fields = largeStrings(clone).sort((a, b) => b.length - a.length);
  for (const field of fields) {
    if (json.length <= maxChars) break;
    const current = getAt(clone, field.path);
    if (typeof current !== 'string') continue;

    /**
     * How much this one field must give up for the whole reply to fit, with a
     * little slack for the `… N characters omitted …` marker we splice in.
     */
    const excess = json.length - maxChars;
    const budget = Math.max(MIN_FIELD_CHARS, current.length - excess - 80);
    if (budget >= current.length) continue;

    setAt(clone, field.path, spliceMiddle(current, budget));
    json = JSON.stringify(clone);
  }
  return json;
}

/**
 * ── ⭐⭐⭐ DID THIS TOOL FAIL, AND WHY? ASKED IN EXACTLY ONE PLACE ────────────
 *
 * ⚠️⚠️ THE COMMENT IN `turn.mjs` SAID THIS WAS ALREADY TRUE AND IT WAS NOT.
 * Fixing `wait_for_output`'s timeout, it argued: *"the lesson is not 'add a
 * field to that verb' — it is that this line is the single funnel every failure
 * passes through, and it was reading exactly one key."* The diagnosis was
 * right. The claim of singleness was wrong: an audit on 2026-09-01 found the
 * same funnel written out FOUR times, and only one of them had been fixed.
 *
 *   `turn.mjs` describeToolResult   — the MODEL's line   · reads error, reason ✅
 *   `turn.mjs` renderToolRecord     — the HUMAN's line   · read error only     ✖
 *   `read-window.mjs` formatWindow… — read_lines/around  · read error only     ✖
 *   `mcp-server.mjs` callGeneral    — the MCP surface    · read error only     ✖
 *
 * MEASURED on the exact fixture the original fix was written for
 * (`{ ok:false, reason:'timeout', waitedMs:30000, text:'listening on 3000' }`):
 *
 *   the model saw   "wait_for_output failed: timeout after 30s" + the log
 *   the human saw   "✖ wait_for_output: unknown error"
 *
 * So the terminal — the surface a person is actually watching — still showed
 * the defect that had been declared fixed, for the commonest outcome of the
 * verb. This function is what makes the singleness claim true.
 *
 * ⚠️ THE ORDER IS THE ORIGINAL ONE AND MUST NOT BE REARRANGED. `error` is a
 * sentence a verb wrote deliberately for a human; `reason` is a machine code
 * used only when nothing better exists. Preferring `reason` would replace good
 * messages with worse ones everywhere at once.
 *
 * ⭐ `message` AND `why` ARE READ TOO, AND THAT IS NEW. The audit found live
 * `ok: false` returns whose only explanation sits under one of those keys —
 * `budget.mjs` and `harness-run.mjs` use `message`, `lease.mjs` and
 * `websearch.mjs` use `why`. None of them reaches a tool result *today*, which
 * is exactly why this is the moment to read them: the cost is two `??` links,
 * and the alternative is discovering a fifth spelling the way we discovered the
 * first four.
 *
 * @param {unknown} result a tool result that has already failed the `ok` check
 * @returns {string} a human sentence, never an empty string
 */
export function failureReason(result) {
  const r = result ?? {};
  const text = (v) => (typeof v === 'string' && v.trim() ? v : null);
  const reason = text(r.reason)
    ? `${r.reason}${typeof r.waitedMs === 'number' ? ` after ${Math.round(r.waitedMs / 100) / 10}s` : ''}`
    : null;
  return text(r.error) ?? reason ?? text(r.message) ?? text(r.why) ?? 'unknown error';
}

/**
 * Did this tool fail? ⚠️ `!== true`, NEVER `=== false`.
 *
 * ⚠️⚠️ `mcp-server.mjs` ASKED IT THE OTHER WAY AND THAT IS THE `review_code`
 * BUG INVERTED — AND WORSE. `review_code` returned no `ok` field, so every
 * SUCCESS was reported to the model as a failure; over MCP the same result took
 * the SUCCESS branch, so a failure would have been reported as a success. Of
 * the two directions, this is the one that gets built on.
 */
export function toolFailed(result) {
  return !result || result.ok !== true;
}

/**
 * Serialise a tool result for the model, keeping it VALID JSON at any size.
 *
 * @param {unknown} result   the tool's return value
 * @param {number}  maxChars the same ceiling the formatted branches use
 * @returns {string} JSON that parses, whose large string fields may be spliced
 */
export function stringifyForModel(result, maxChars) {
  let json = JSON.stringify(result);
  if (typeof json !== 'string') return '';
  if (json.length <= maxChars) return json;

  /**
   * ⚠️ Deep-cloned, because this renders a LIVE result object that callers keep
   * using — the transcript writer and the usage recorder both read it after we
   * are done. Truncating in place would corrupt the record of what the tool
   * actually returned, which is the one copy that has to stay true.
   */
  /**
   * ⚠️ `structuredClone` THROWS ON WHAT `JSON.stringify` QUIETLY DROPS — a
   * function, a symbol, a live handle. A result carrying one would have made
   * this renderer throw INSIDE `toolResultText`, i.e. lose the whole round to a
   * TypeError, for a field that was never going to be sent anyway. The JSON
   * round-trip is the honest fallback: it clones exactly what we are about to
   * serialise, no more.
   */
  let clone;
  try {
    clone = structuredClone(result);
  } catch {
    try { clone = JSON.parse(json); } catch { return json.slice(0, maxChars); }
  }

  json = shrinkStrings(clone, json, maxChars);
  /**
   * ⭐ THEN THE STRUCTURE, AND THEN THE STRINGS AGAIN. Cutting prose first is
   * right — a 9KB diff beside a 40-char path should lose only the diff — but it
   * cannot touch a result whose size is 300 small rows, and that shape was
   * reaching the model as a note with no rows in it at all. Once the rows are
   * cut, the survivors may still carry long bodies, so the string pass runs a
   * second time over what is left.
   */
  json = shrinkArrays(clone, json, maxChars);
  if (json.length > maxChars) json = shrinkStrings(clone, json, maxChars);

  /**
   * ⚠️ THE HONEST FLOOR. If the size lives in structure rather than in strings —
   * ten thousand tiny array entries — no amount of field-cutting reaches it, and
   * cutting the JSON string would put us back where we started. Say so in a way
   * that still parses, and keep the fields that describe the result over the
   * ones that are the result.
   */
  if (json.length > maxChars) {
    const note = {
      ok: result?.ok,
      error: result?.error,
      _truncated: true,
      _note: `this result was ${json.length} characters and could not be reduced to ${maxChars} `
        + 'by trimming its text fields — its size is in structure, not prose. '
        + 'Request a narrower slice (a smaller range, an offset, or a single path).',
    };
    for (const [k, v] of Object.entries(result ?? {})) {
      if (typeof v === 'number' || typeof v === 'boolean') note[k] = v;
    }
    const fallback = JSON.stringify(note);
    return fallback.length <= maxChars ? fallback : JSON.stringify({ ok: false, _truncated: true });
  }

  return json;
}
