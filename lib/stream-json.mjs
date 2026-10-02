/**
 * ── lib/stream-json.mjs — `--output-format stream-json` ─────────────────────
 *
 * Parity item (2026-09-27): `claude -p --output-format stream-json` and
 * `codex exec --json` both emit newline-delimited JSON as a run happens
 * (code.claude.com/docs/en/headless; learn.chatgpt.com/docs/codex/cli — both
 * read 2026-09-27). That is what an IDE panel, a CI log or an SDK wrapper
 * consumes; our `--json` only answered at the END, so a ten-minute run was ten
 * minutes of silence on stdout.
 *
 * THE CONTRACT — one object per line, stdout only, three kinds:
 *
 *     {"type":"init","version":"…","task":"…","cwd":"…"}
 *     {"type":"event","event":{…the loop's own onEvent object…}}   (many)
 *     {"type":"result", …the exact --json document… }               (last)
 *
 * ⭐ `event` CARRIES THE LOOP'S OWN EVENT OBJECT, NOT A SECOND VOCABULARY. The
 * terminal renderer and the JSON consumer see the same fact, the way
 * `hooks.mjs:announce` already insists on. A translated schema would be a
 * second opinion about what happened.
 *
 * ⚠️ A LINE MUST NEVER BREAK THE STREAM. An event can carry anything — a
 * function, a cycle, a BigInt, a 2 MB tool result. `streamLine` never throws,
 * replaces what JSON cannot hold, and caps long strings OUT LOUD, because one
 * unparseable line poisons every line after it for a naive `for line in
 * stdout: json.loads(line)` consumer.
 */

/** Strings longer than this inside an event are cut, with the cut marked. */
export const MAX_STREAM_STRING_CHARS = 8_000;

/**
 * Serialise one line. Never throws; always returns exactly one line ending in \n.
 *
 * @param {'init'|'event'|'result'|string} type
 * @param {Record<string, unknown>} payload
 */
export function streamLine(type, payload = {}) {
  const seen = new WeakSet();
  const replacer = (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value === 'string' && value.length > MAX_STREAM_STRING_CHARS) {
      return `${value.slice(0, MAX_STREAM_STRING_CHARS)}… [cut, ${value.length} characters total]`;
    }
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  };
  let body;
  try {
    body = JSON.stringify({ type, ...payload }, replacer);
  } catch (err) {
    body = JSON.stringify({ type, unserializable: true, error: String(err?.message ?? err) });
  }
  // JSON.stringify never emits a raw newline inside a string, so this is one line.
  return `${body}\n`;
}

/** The first line of a stream. */
export function initLine({ version = null, task = '', cwd = '' } = {}) {
  return streamLine('init', { version, task, cwd });
}

/** One loop event. */
export function eventLine(event) {
  return streamLine('event', { event: event ?? null });
}

/** The last line: the `--json` document, flattened into a `result` line. */
export function resultLine(doc) {
  const safe = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc : { value: doc };
  // ⚠️ The document's own `type` (if any) must not overwrite the line kind.
  const { type: _ignored, ...rest } = safe;
  return streamLine('result', rest);
}
