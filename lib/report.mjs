/**
 * ── ⭐ MACHINE-READABLE OUTPUT, AND A DIFF OF WHAT ACTUALLY CHANGED ──────────
 *
 * Two gaps the MVP plan named, and they are the same gap seen twice: the CLI
 * tells you WHICH files it touched and never WHAT it did to them, and it says
 * so only in prose a script cannot read.
 *
 * ── ⚠️ WHY "3 files written" IS NOT ENOUGH ──────────────────────────────────
 * It is the difference between trusting the agent and verifying it. A user who
 * has to open three files and read them has not been given a report; they have
 * been given homework. And the one place this matters most is the case where
 * the agent quietly deleted something while making an unrelated change —
 * exactly what `edit_file` exists to prevent and exactly what a file list
 * cannot show.
 *
 * ⭐ So: line counts per file, and for a REPLACED file, what it looked like
 * before. Not a full unified diff — a terminal report that runs off the screen
 * is one nobody reads — but enough that "it rewrote 200 lines of a 210-line
 * file" is visible at a glance, because that is usually a mistake.
 */

/** Count lines the way an editor does: a trailing newline is not a line. */
function lineCount(text) {
  if (!text) return 0;
  const n = String(text).split('\n').length;
  return String(text).endsWith('\n') ? n - 1 : n;
}

/**
 * Summarise one write.
 *
 * ⚠️ WORKS FROM THE RESULT OBJECT, NOT FROM DISK. Re-reading the file here
 * would report whatever it looks like NOW — including changes a later round, or
 * another parallel task, made afterwards. The result is what this write did.
 */
/**
 * ── ⭐⭐ ONE RECORD CAN NAME MANY FILES, AND THIS FILE ASSUMED IT NAMED ONE ──
 *
 * `describeChange` is one-record-in, one-change-out, and that was true when the
 * only writers were `write_file` and `edit_file`. It stopped being true twice:
 *
 *   · `write_files` reports `written[{path,bytes,created}]` and has NO
 *     top-level `path`. MEASURED — `describeChange` on a 2-file bulk write
 *     returns `{"tool":"write_files","bytes":0,"previousBytes":0,
 *     "kind":"replaced"}`: no path at all, and the summary printed a line
 *     naming nothing.
 *   · `delegate` with `write: true` reports the same shape, and a real run
 *     printed `replaced src/calc.test.mjs (0 bytes)` for a file CREATED at
 *     510 bytes.
 *
 * ⭐ SO THE PLURAL IS THE FRONT DOOR NOW. `describeChange` is kept, unchanged
 * in behaviour for every single-file shape, because it is exported and pinned
 * by seven existing assertions — rewriting those to fit a new signature would
 * be changing the tests to suit the change, which is how a real guarantee gets
 * quietly relaxed.
 *
 * @param {any} record
 * @returns {any[]} one entry per file this record actually touched
 */
export function describeChanges(record) {
  const many = record?.result?.written;
  if (Array.isArray(many) && many.length > 0) {
    return many.map((f) => ({
      path: f.path,
      tool: record.name,
      bytes: f.bytes ?? 0,
      previousBytes: f.previousBytes ?? 0,
      /**
       * ⚠️ `deleted` FIRST. A delegated build can remove a file, and a
       * deletion reported as a "replaced with 0 bytes" is the summary telling
       * someone their file was BLANKED — the exact wording `tools.mjs:980`
       * records as having frightened a reader once already.
       */
      kind: f.deleted === true ? 'deleted' : (f.created === true ? 'created' : 'replaced'),
    }));
  }
  return [describeChange(record)];
}

export function describeChange(record) {
  const r = record?.result ?? {};
  /**
   * ⚠️ `lines` IS OMITTED WHEN WE DO NOT HAVE THE CONTENT, and the first version
   * reported `lines: 0` for every write — because `write_file`'s result carries
   * a byte count and a path, not the text. A confidently wrong zero in a
   * machine-readable document is worse than an absent field: a script can check
   * for `undefined`, and it cannot know that a 0 is a lie.
   */
  const after = r.content === undefined ? null : lineCount(r.content);
  const base = {
    // ⚠️ `mutatedPath` WINS. A tool whose subject is not the file it wrote —
    // `see_page` reads a page and writes a screenshot — otherwise reports a
    // write against the file it only looked at. See the note in tools.mjs.
    path: record.mutatedPath ?? r.path,
    tool: record.name,
    bytes: r.bytes ?? r.screenshotBytes ?? 0,
    previousBytes: r.previousBytes ?? 0,
  };
  if (record.name === 'delete_file') return { ...base, kind: 'deleted' };
  // A screenshot is always a new file — never a replacement of the page it shows.
  if (record.name === 'see_page') return { ...base, kind: 'created' };
  if (r.created) return { ...base, kind: 'created', ...(after === null ? {} : { lines: after }) };
  if (record.name === 'edit_file') {
    return {
      ...base,
      kind: 'edited',
      // ⭐ The proportion is the signal. `replacedChars` against `fileChars`
      // answers "was this surgery or a rewrite" without printing the file.
      replacedChars: r.replacedChars ?? 0,
      fileChars: r.fileChars ?? 0,
      share: r.fileChars ? Math.min(1, (r.replacedChars ?? 0) / r.fileChars) : 0,
    };
  }
  return { ...base, kind: 'replaced', ...(after === null ? {} : { lines: after }) };
}

/**
 * ⚠️ THE LINE THAT SHOULD MAKE SOMEONE LOOK. A whole-file rewrite of an
 * existing file is how code silently disappears — the model re-emits what it
 * remembers and drops what it did not think to include. The file still parses,
 * the tests may still pass, and nobody notices until the missing thing was
 * load-bearing.
 */
export function rewriteWarnings(changes) {
  return changes
    .filter((c) => c.kind === 'replaced' && c.previousBytes > 400 && c.bytes < c.previousBytes * 0.6)
    .map((c) => `${c.path} shrank from ${c.previousBytes} to ${c.bytes} bytes — check nothing was dropped`);
}

/** Render the change list for a human. */
export function formatChanges(changes, { paint = null } = {}) {
  if (changes.length === 0) return [];
  const p = paint ?? { gold: (t) => t, dim: (t) => t, red: (t) => t };
  const lines = [];
  for (const c of changes) {
    if (c.kind === 'deleted') { lines.push(`  ${p.gold('deleted  ')} ${c.path}  ${p.dim(`(${c.bytes} bytes)`)}`); continue; }
    if (c.kind === 'edited') {
      const pct = Math.round(c.share * 100);
      lines.push(`  ${p.gold('edited   ')} ${c.path}  ${p.dim(`(${c.replacedChars} of ${c.fileChars} chars · ${pct}%)`)}`);
      continue;
    }
    const delta = c.kind === 'replaced' && c.previousBytes
      ? ` · was ${c.previousBytes}`
      : '';
    const size = c.lines === undefined ? `${c.bytes} bytes${delta}` : `${c.lines} lines, ${c.bytes} bytes${delta}`;
    lines.push(`  ${p.gold(`${c.kind === 'created' ? 'created  ' : 'replaced '}`)} ${c.path}  ${p.dim(`(${size})`)}`);
  }
  for (const w of rewriteWarnings(changes)) lines.push(`  ${p.red('⚠')} ${w}`);
  return lines;
}

/**
 * ── ⭐ `--json`: ONE OBJECT, ON STDOUT, AND NOTHING ELSE ────────────────────
 *
 * ⚠️ THE CONTRACT IS THE WHOLE VALUE. A script that has to grep prose is a
 * script that breaks the next time we improve a sentence — and we have improved
 * several today. So this shape is stable, and every human-facing line goes to
 * stderr when `--json` is on, leaving stdout parseable by `jq` with no flags.
 *
 * ⚠️ AND IT MUST NEVER CARRY COLOUR. An escape code inside a JSON string is
 * valid JSON and completely useless — the same class of bug that once had the
 * bench parse a cost of $7.50 out of a fixture's test name.
 */
export function toJson(outcome, { changes = [], task = null } = {}) {
  const v = outcome?.verification ?? {};
  return {
    ok: outcome?.ok !== false,
    task,
    model: outcome?.model ?? null,
    rounds: outcome?.roundsUsed ?? 0,
    stoppedBecause: outcome?.stoppedBecause ?? null,
    // ⭐ `ran` and `passed` stay SEPARATE, as everywhere else in this codebase.
    // Collapsing them is how a loop reports success on a failing test.
    verification: {
      ran: v.ran === true,
      passed: v.passed === true,
      command: v.command ?? null,
      exitCode: v.exitCode ?? null,
      attempts: v.attempts ?? 0,
    },
    /**
     * ── ⚠️⚠️ THE CRITERION THE USER NAMED, OR THE DOCUMENT LIES BY OMISSION ──
     *
     * `verification` answers "did SOMETHING this process ran exit 0". Acceptance
     * answers "was it the thing you asked for", and until this field existed the
     * second answer never left the terminal. Measured: a run whose declared
     * `npm test` was unmet emitted `verification.passed:true` with nothing in
     * the document to say a named criterion had been missed — and the pipeline
     * acceptance.mjs's own header calls out, `acuvo --json | jq
     * '.verification.passed'`, read green.
     *
     * ⚠️ `gating` IS PART OF THE SHAPE, not a footnote. A DECLARED criterion
     * decides the exit code; a DERIVED one is this runner's reading of the
     * user's prose and reports only. A consumer that cannot tell them apart
     * either ignores both or trusts both, and both are wrong.
     *
     * ⭐ `null` WHEN NOBODY NAMED ONE, which is most runs — an always-present
     * object with empty fields would make "no criterion" and "a criterion that
     * found nothing" the same document.
     */
    acceptance: outcome?.acceptance
      ? {
          source: outcome.acceptance.source ?? null,
          gating: outcome.acceptance.gating === true,
          verdict: outcome.acceptance.verdict?.verdict ?? null,
          unmet: (outcome.acceptance.verdict?.unmet ?? []).map((u) => ({
            command: u?.command ?? null,
            why: u?.why ?? null,
          })),
        }
      : null,
    changes,
    /**
     * ── ⚠️⚠️ THE ANSWER ITSELF WAS NEVER IN THE MACHINE-READABLE DOCUMENT ────
     *
     * `note` is what the agent actually SAID — the reply a person reads to learn
     * what happened. It reached the terminal and stopped there, so anything
     * driving this tool through `--json` got the changes, the cost and the
     * verdict, and never the answer. Measured 2026-08-14: the field was absent
     * from the document on EVERY stop reason, not just the truncated ones.
     *
     * ⭐ This is the same defect as the cache reading and the compaction count
     * before it: computed on every run, returned on the outcome, and dropped at
     * the one line where it would have become visible. The pattern is that the
     * human summary is rich and the machine document is thin — which is the
     * wrong way round for a tool sold on being scriptable.
     */
    note: outcome?.note ?? null,
    /**
     * ⚠️ THE FILES THE REPLY CLAIMED AND THE DISK DOES NOT HAVE. The human
     * summary prints this in bold; a script could not see it at all. It is the
     * difference between "the agent says it wrote your migration" and "your
     * migration exists", and a gate that cannot read it has to trust prose.
     */
    promisedButMissing: outcome?.promisedButMissing ?? [],
    /**
     * ⭐ WITHOUT THE DENOMINATOR, `rounds` CANNOT DETECT A TRUNCATED RUN.
     * `rounds: 2` reads as a tidy little session; `rounds: 2, maxRounds: 2`
     * means it was cut off with work outstanding. The document already carries
     * `stoppedBecause: 'round-cap'`, but a consumer should not have to know our
     * internal vocabulary to spot the most common way a run ends early.
     */
    maxRounds: outcome?.maxRounds ?? null,
    /**
     * ⚠️ THE PROVIDER'S OWN STOP REASON, which is not ours. `length` means the
     * model was cut off mid-sentence — a truncated answer that our own
     * `stoppedBecause` will happily call `no-tool-calls`.
     */
    finishReason: outcome?.finishReason ?? null,
    /**
     * ⭐ Context for reading `verification.ran: false`. A run that COULD not
     * execute anything and a run that CHOSE not to verify are different facts,
     * and without this they look identical from outside.
     */
    allowRun: outcome?.allowRun ?? null,
    // A number a caller can budget against, not a sentence about money.
    costUsd: outcome?.usage?.cost ?? null,
    tokens: outcome?.usage?.total_tokens ?? null,
    /**
     * ── ⭐ THE HIT RATE, COMPUTED ON EVERY RUN AND NEVER ALLOWED OUT ──────────
     *
     * `aggregateCache` has run on every session since it was written and its
     * result was dropped right here, so the one number that explains why two
     * identical-looking runs cost 3x apart could not be read from outside the
     * process. Every caching claim this project has made was therefore belief
     * rather than evidence — including the ones in its own documentation.
     *
     * ⚠️ `null` WHEN NO ROUND REPORTED, never a zeroed object. "The provider
     * said nothing about caching" and "the provider cached nothing" are
     * different facts, and a consumer reading `hitRate: 0` cannot tell them
     * apart. `roundsUnknown` travels for the same reason: a rate measured over
     * 2 of 6 rounds is partial, and the reader has to be able to see that.
     */
    /**
     * ⭐⭐ `firstRound` IS THE FLOOR, AND IT IS THE ONE THE PRICING IS SIZED ON.
     * `lib/plan.mjs` states the cache rate *is* the margin and assumes a 90%
     * floor; the floor is a claim about a FRESH invocation's round 1, which is
     * the only round our prefix discipline controls. The session `hitRate` above
     * blends it with rounds 2+, whose misses are appended-and-therefore-new
     * tokens — arithmetic, not a defect. MEASURED 2026-08-16 on two live runs in
     * one workspace: 72.0% over 4 rounds and 49.2% over 2, neither of which says
     * anything about whether the second invocation inherited the first one's
     * prefix. `aggregateCache` carries the full argument.
     */
    cache: outcome?.usage?.cache
      ? {
          promptTokens: outcome.usage.cache.promptTokens,
          cachedTokens: outcome.usage.cache.cachedTokens,
          hitRate: outcome.usage.cache.hitRate,
          firstRound: outcome.usage.cache.firstRound ?? null,
          roundsReported: outcome.usage.cache.roundsReported,
          roundsUnknown: outcome.usage.cache.roundsUnknown,
        }
      : null,
    /**
     * ── ⭐⭐ WHICH UPSTREAM SERVED THE ROUNDS, AND DID THE PIN TAKE ───────────
     *
     * ⚠️ WITHOUT THIS, `cache.hitRate` IS RECORDED AND NOT DIAGNOSABLE. Measured
     * 2026-08-14: `deepseek-v4-flash-0731` has **28 upstream endpoints**, a
     * prompt cache lives on ONE of them, and the same 4-round task measured
     * 46.7% hit rate unpinned against 95.8% pinned. A durable 47% and a durable
     * 95% therefore sit in the audit log with nothing to say whether routing or
     * our own prefix moved — two problems with completely different fixes.
     *
     * ⚠️ `served` IS A COUNT PER PROVIDER, NOT A SINGLE NAME. A session
     * legitimately reaches several upstreams and that scatter IS the finding;
     * emitting one value would report the last round and hide the cold ones
     * before it.
     *
     * ⚠️ `pinMissed > 0` IS THE ONE THAT COSTS MONEY. `allow_fallbacks` is true
     * by design, and OpenRouter answers an unhonourable `order` list by ignoring
     * it rather than refusing it — so a pin that never takes has no symptom
     * except a worse bill. This field is that symptom.
     *
     * `null` when nothing was pinned and no round named a provider — the same
     * rule `cache` follows: silence is unknown, never zero.
     */
    providers: outcome?.providers
      ? {
          pin: outcome.providers.pin ?? null,
          served: outcome.providers.served ?? {},
          roundsUnknown: outcome.providers.roundsUnknown ?? 0,
          /**
           * ⚠️⚠️ `pinTook` MEANS THE **FIRST** NAME IN THE LIST, and it did not
           * used to. Any name counted as a success, which hid the one routing
           * event that costs money: a prompt cache lives on ONE upstream, so a
           * round served by the pin's SECOND name is available, billed, and
           * stone cold. Measured 2026-08-16, one byte-identical 46,171-byte
           * payload — StreamLake 98.3% cached at $0.000172, Baidu 0.0% cached
           * at $0.000791, **4.6×** — reported as `pinTook: 1, pinMissed: 0`.
           *
           * ⭐ `pinFellBack` is that round. The three counters are disjoint and
           * sum to the rounds that named a provider; `pinMissed` keeps its old
           * meaning (nobody in the list served it) and stays rare, because a
           * three-name list nearly always contains whoever answered.
           */
          pinTook: outcome.providers.pinTook ?? 0,
          pinFellBack: outcome.providers.pinFellBack ?? 0,
          pinMissed: outcome.providers.pinMissed ?? 0,
        }
      : null,
    /**
     * ⭐ THE DIRECT CAUSE OF A COLLAPSED `cache.hitRate`, shipped alongside the
     * effect. Compaction rewrites earlier messages and voids the prompt-prefix
     * cache from the first rewritten message onward, so emitting the hit rate
     * without the rewrite count makes the hit rate un-diagnosable from outside
     * the process — the same defect the `cache` block above was added to fix,
     * one layer down. Always a number: `0` is a fact about this run, not a
     * default standing in for "unknown".
     */
    compactions: outcome?.compactions ?? 0,
    // Refusals are data: a script retrying a run wants to know it asked for
    // something impossible rather than that the model was merely unlucky.
    refusals: (outcome?.executed ?? [])
      .filter((e) => e?.result?.ok === false)
      .map((e) => ({ tool: e.name, error: String(e.result.error ?? '').slice(0, 300) })),
    error: outcome?.ok === false ? (outcome.error ?? null) : null,
  };
}

/**
 * ── ⭐ A PATH SHORT ENOUGH TO READ ───────────────────────────────────────────
 *
 * The banner printed the absolute workspace root on every run — routinely 100+
 * characters, wrapping the one line that is supposed to orient you before
 * anything has happened. It is the first thing a new user sees and it looked
 * like a stack trace.
 *
 * ⚠️ SHORTENING A PATH IS LYING UNLESS THE LIE IS MARKED. `~` is universally
 * understood and reversible. An elision in the middle is NOT, so it carries a
 * `…` — a path silently missing three segments is a path that sends someone to
 * the wrong directory.
 *
 * ⚠️ AND THE LAST SEGMENT IS NEVER DROPPED. It is the segment that says WHICH
 * workspace this is; every parent above it is context. A shortener that keeps
 * the head and eats the tail has thrown away the only part being read.
 */
export function shortenRoot(root, home = process.env.HOME || process.env.USERPROFILE, max = 44) {
  const raw = typeof root === 'string' ? root : '';
  if (!raw) return raw;

  const sep = raw.includes('\\') ? '\\' : '/';
  const trimEnd = (s) => s.replace(/[\\/]+$/, '');
  let out = raw;

  // ⭐ `~` first: it is both the shortest form and the only lossless one.
  if (typeof home === 'string' && home.length > 1) {
    // ⚠️ Windows paths are case-insensitive; comparing them case-sensitively
    // misses the `~` on exactly the platform with the longest paths.
    const norm = (s) => (process.platform === 'win32' ? trimEnd(s).toLowerCase() : trimEnd(s));
    const h = norm(home);
    const r = norm(raw);
    if (r === h) out = '~';
    else if (r.startsWith(`${h}/`) || r.startsWith(`${h}\\`)) {
      out = `~${sep}${raw.slice(trimEnd(home).length + 1)}`;
    }
  }

  if (out.length <= max) return out;

  /**
   * ⚠️ ELIDE FROM THE MIDDLE, keeping the root marker and the deepest segments.
   * Losing "C:" or the leading "/" turns an absolute path into a relative one,
   * which is a different path, not a shorter one.
   */
  const parts = out.split(/[\\/]/).filter((p, i) => p !== '' || i === 0);
  if (parts.length <= 2) return out;

  const head = parts[0] === '' ? sep : parts[0];
  const tail = [];
  let width = head.length + 2; // the head plus the "…" segment
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    if (tail.length > 0 && width + parts[i].length + 1 > max) break;
    tail.unshift(parts[i]);
    width += parts[i].length + 1;
  }
  if (tail.length >= parts.length - 1) return out;
  return [head === sep ? '' : head, '…', ...tail].join(sep);
}
