/**
 * ── ⭐⭐ THE TWENTY SECONDS OF NOTHING ────────────────────────────────────────
 *
 * The CLI prints a round header and then goes silent for the length of a model
 * call — measured at 8–40s depending on the task. Nothing moves. There is no way
 * to tell "thinking" from "hung", and the only honest thing a user can do is
 * wait and hope.
 *
 * ⭐ FOR A TERMINAL TOOL, PERCEIVED SPEED IS THE PRODUCT. The critique of this
 * whole category got that right: developers will not switch to save a fraction
 * of a cent, and they absolutely will switch for something that feels alive.
 * Nothing here makes the model faster. It makes the wait legible, which is the
 * thing people actually experience.
 *
 * ── ⚠️ THE TRAP THAT MAKES STREAMING HARDER THAN IT LOOKS ───────────────────
 * Content streams as simple text deltas. **Tool calls do not.** They arrive as
 * fragments keyed by an index, split at arbitrary byte boundaries:
 *
 *   {index:0, id:"call_1", function:{name:"write_file", arguments:""}}
 *   {index:0, function:{arguments:"{\\"pa"}}
 *   {index:0, function:{arguments:"th\\":\\"src/a.js\\""}}
 *
 * A naive reader that JSON.parses each fragment sees garbage; one that keeps
 * only the last delta loses the name. They must be ACCUMULATED PER INDEX and
 * parsed only at the end — and because the JSON is incomplete until the final
 * fragment, nothing downstream may look at it early.
 *
 * ⚠️ AND A DELTA CAN SPLIT AN SSE FRAME. A chunk from the socket is not a line;
 * `data: {"cho` can arrive with the rest in the next read. The buffer below is
 * the whole reason this is a module and not four lines in `model.mjs`.
 */

/**
 * Parse a Server-Sent Events byte stream into JSON payloads.
 *
 * Yields each `data:` object. Ignores comments, blank lines and `[DONE]`.
 *
 * ⚠️ THE BUFFER IS THE POINT. Splitting each chunk on newlines independently
 * drops any line straddling a chunk boundary — which under load is most of the
 * interesting ones, and produces a stream that works perfectly on a fast
 * connection and corrupts on a slow one.
 */
export async function* parseSse(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;      // keep-alive comment
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        yield JSON.parse(payload);
      } catch {
        /**
         * ⚠️ A MALFORMED FRAME IS SKIPPED, NOT THROWN. One bad line must not
         * destroy a response that is 90% delivered — the user would lose real
         * work to a provider's formatting hiccup.
         */
      }
    }
  }
}

/**
 * Accumulate streamed deltas into the same shape `extractReply` produces, so
 * everything downstream is unchanged.
 *
 * `onText` is called with each content fragment as it arrives — that callback is
 * the entire user-visible payoff.
 */
export async function collectStream(stream, { onText = null } = {}) {
  let content = '';
  /** @type {Map<number, {id: string|null, name: string, args: string}>} */
  const calls = new Map();
  let finishReason = null;
  let usage = null;
  let sawAnything = false;

  for await (const evt of parseSse(stream)) {
    sawAnything = true;
    // Usage arrives on its own frame at the end when `usage.include` is set.
    if (evt.usage) usage = evt.usage;
    const choice = evt.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      if (onText) onText(delta.content);
    }

    for (const tc of delta.tool_calls ?? []) {
      /**
       * ⚠️ KEYED BY `index`, NOT BY ORDER OF ARRIVAL. Fragments for two
       * concurrent tool calls interleave, and appending to "the last one" would
       * splice one call's arguments into another's — producing valid-looking
       * JSON that writes the wrong file.
       */
      const i = tc.index ?? 0;
      if (!calls.has(i)) calls.set(i, { id: null, name: '', args: '' });
      const acc = calls.get(i);
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') acc.args += tc.function.arguments;
    }
  }

  if (!sawAnything) {
    return { ok: false, error: 'the stream closed without sending anything' };
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({
      id: c.id ?? `call_${i}`,
      type: 'function',
      function: { name: c.name, arguments: c.args },
    }))
    .filter((c) => c.function.name);

  /**
   * ⚠️ AN EMPTY RESULT IS A FAILURE, AND THE CHAIN MUST BE ABLE TO SEE IT.
   * Same trap as the non-streaming path: a reasoning budget can consume the
   * whole reply and close the stream having sent only role frames. Reported in
   * the exact words `chain.mjs` treats as retryable, so a fallback happens
   * instead of the loop reporting "the model said nothing" as a result.
   */
  if (!content.trim() && toolCalls.length === 0) {
    return { ok: false, error: 'the model returned an empty reply' };
  }

  return { ok: true, content: content || null, toolCalls, finishReason, usage };
}

/**
 * ── ⭐ THE LIVE LINE ─────────────────────────────────────────────────────────
 *
 * Prints streamed prose as it arrives, wrapped, indented, and truncated to a few
 * lines — the reasoning is orientation, not the deliverable.
 *
 * ⚠️ NO CURSOR ADDRESSING, NO SPINNER, NO ALTERNATE SCREEN. The same rule the
 * interactive session follows: output stays append-only so `>` redirection,
 * piping and `tee` keep working, and a transcript remains a file you can read.
 * A UI that only behaves in the terminal it was tested in is worse than plain
 * text everywhere.
 */
export function createLivePrinter({ write, maxLines = 3, width = 88 } = {}) {
  let buffer = '';
  let printed = 0;
  let stopped = false;

  return {
    onText(fragment) {
      if (stopped) return;
      buffer += fragment;
      // Emit only complete lines, so a word is never split across two writes.
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (printed >= maxLines) { stopped = true; return; }
        write(`  ${line.slice(0, width)}\n`);
        printed += 1;
      }
      /**
       * ⭐ A LONG UNBROKEN PARAGRAPH STILL SHOWS SOMETHING. Models often stream
       * one enormous line, and a printer that waits for `\n` would sit silent
       * through exactly the case this feature exists for.
       */
      if (buffer.length > width && printed < maxLines) {
        const cut = buffer.lastIndexOf(' ', width);
        const take = cut > 20 ? cut : width;
        write(`  ${buffer.slice(0, take).trim()}\n`);
        buffer = buffer.slice(take);
        printed += 1;
      }
    },
    /** Anything left that never got a newline. */
    flush() {
      if (stopped || printed >= maxLines) return;
      const rest = buffer.trim();
      if (rest) write(`  ${rest.slice(0, width)}\n`);
      buffer = '';
    },
    linesPrinted: () => printed,
  };
}
