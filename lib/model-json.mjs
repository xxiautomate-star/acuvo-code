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
  const clone = structuredClone(result);
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
