/**
 * ── ⚠️⭐⭐ KNOWING WHEN IT IS GOING IN CIRCLES ────────────────────────────────
 *
 * This module is the other half of removing the round cap, and it is not
 * optional. "Keep going until the task is done" without a loop detector is not
 * ambition, it is "burn the whole budget rewriting the same file" — strictly
 * worse than stopping early, because the user pays for the circles too.
 *
 * ⚠️⚠️ THE TWO FAILURE MODES ARE NOT SYMMETRIC, AND THE WHOLE DESIGN FOLLOWS
 * FROM THAT.
 *
 *   · MISSING a loop costs a few more rounds — cents, on a task measured at
 *     ~$0.0007. Annoying. Recoverable. The budget guard catches it eventually.
 *   · CALLING A WORKING RUN STUCK costs the user THE WORK AND THE MONEY. Every
 *     round already paid for is thrown away, possibly one round before it would
 *     have succeeded, and the user has nothing to show for any of it.
 *
 * So every threshold here is set to the CONSERVATIVE side, every pattern
 * requires a positive signature rather than the absence of one, and five
 * legitimate shapes that look superficially like loops are pinned as negatives
 * in the tests:
 *
 *   1. reading one file repeatedly while editing different parts of it
 *   2. a test failing the same way while the code genuinely changes each run
 *   3. a long research phase — many reads, no writes, no commands
 *   4. retrying after a transient failure that then succeeds
 *   5. the same command failing DIFFERENTLY each time (that is a descent, not
 *      a circle — the model is peeling errors off one at a time)
 *
 * ⭐ `suggestion` IS THE PRODUCT, NOT `stuck`. This text is appended to the
 * conversation as a nudge to the MODEL, so "stuck: true" is worthless to it and
 * a scolding is worse than worthless — a model told it has failed will often
 * wrap up and hand back half a job, which is the exact behaviour an unattended
 * loop exists to prevent. Every suggestion therefore names the concrete
 * artifact (the path, the command, the message) and proposes a next move.
 *
 * ⚠️ PURE, AND DELIBERATELY SO. No clock, no randomness, no I/O, no state
 * between calls. It takes the round history the loop already keeps and returns
 * data. That is why it can be tested exhaustively without spending a cent on a
 * real model — and untestable time is why half the bugs in this package were
 * invisible for so long.
 *
 * WIRING: see the note at the bottom of this file. It is ten lines in
 * `runSession`, right after `rounds.push(...)`.
 */

/**
 * Every pattern this module can return, in the order it prefers to report them.
 *
 * ⚠️ THE ORDER IS THE DIAGNOSIS, NOT A PREFERENCE. `A → B → A` also contains two
 * identical writes of A; reporting that as "you wrote the same thing twice"
 * would send the model to check its file path when the real problem is that it
 * is alternating between two rejected answers. The more specific pattern must
 * win, or the nudge actively misleads.
 */
export const STUCK_PATTERNS = [
  'thrashing',
  'repeated-identical-edit',
  'tool-error-loop',
  'repeated-command-failure',
  'no-progress',
  /**
   * ⚠️ LAST ON PURPOSE. A period-1 cycle IS a repeated identical edit, and every
   * shorter pattern above states the same fact more precisely. This one exists
   * only for the loops the others structurally cannot see.
   */
  'long-cycle',
];

/** How many of the most recent rounds are examined. */
const DEFAULT_WINDOW = 4;

/**
 * ⚠️ TWO IS THE THRESHOLD FOR AN IDENTICAL WRITE AND THREE FOR EVERYTHING ELSE,
 * and that is not an inconsistency. Writing byte-identical content to the same
 * path twice is a PROVEN no-op — the second write changed nothing, which is a
 * fact, not an inference. A command failing twice is just a command failing
 * twice; it takes a third to be a pattern.
 */
const IDENTICAL_WRITE_LIMIT = 2;
const COMMAND_FAILURE_LIMIT = 3;
const TOOL_ERROR_LIMIT = 3;
const INERT_ROUND_LIMIT = 3;

/**
 * Tools that mean "a process ran".
 *
 * ⚠️ KEYED ON WHAT HAPPENED, NOT ON THE FAMOUS NAME. turn.mjs has now had the
 * same bug three times — `evaluate`, then `check_acceptance`, then
 * `run_program` were each missing from a list of "things that count as a run",
 * and each time the honest line in the summary lied. Anything that spawns a
 * process belongs here.
 */
const RUN_TOOLS = new Set(['run_command', 'run_program', 'evaluate', 'check_acceptance']);

/** Tools whose success means a file on disk is different afterwards. */
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);

/* ══════════════════════════════════════════════════════════════════════════
 * normalisation — every comparison below depends on these being boring
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * `src\x.js`, `./src/x.js` and `src//x.js` are one file.
 *
 * ⚠️ CASE IS DELIBERATELY LEFT ALONE even though Windows would fold it. Folding
 * MERGES two paths, and merging is the direction that manufactures a false
 * "you wrote the same file twice". Every ambiguity here resolves towards
 * not-stuck.
 */
function normPath(value) {
  if (typeof value !== 'string') return null;
  let s = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/+$/, '');
  return s.length ? s : null;
}

/** Collapse whitespace so two renderings of one message compare equal. */
function normMessage(value, cap = 300) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length ? s.slice(0, cap) : null;
}

/**
 * The first non-empty line of a failure — stderr first, then stdout.
 *
 * ⭐ THE FIRST LINE IS THE SIGNATURE, NOT THE WHOLE OUTPUT. Test runners print
 * timings, paths and a duration that differ on every single run; comparing full
 * output would make two identical failures look different and this pattern
 * would never fire at all.
 */
function firstErrorLine(result) {
  const pick = (text) => {
    if (typeof text !== 'string') return '';
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
    return '';
  };
  return (pick(result?.stderr) || pick(result?.stdout) || '').slice(0, 200);
}

/** Deterministic identity for a read-only call, used to ask "is this new?". */
function probeKey(name, args) {
  try {
    const keys = Object.keys(args ?? {}).sort();
    const body = JSON.stringify(keys.map((k) => [k, args[k]]));
    if (typeof body !== 'string') return null;
    return `${name} ${body.length} ${body.slice(0, 4096)}`;
  } catch {
    // circular or otherwise unserialisable — treat it as its own probe rather
    // than as a repeat, which is the not-stuck direction.
    body = `unserialisable:${name}:${keys_fallback()}`;
  }
  // Cap rather than hash: a hash collision would MERGE two probes and could
  // manufacture an inert round, and probe arguments are short by nature.
  return `${name}\u0000${body.length}\u0000${body.slice(0, 4096)}`;
}
let keysFallbackCounter = 0;
function keys_fallback() { return String(keysFallbackCounter++); }

/** The command string behind a run record, whatever tool produced it. */
function commandOf(ev) {
  if (typeof ev.result.command === 'string') return ev.result.command;
  if (typeof ev.args.command === 'string') return ev.args.command;
  if (Array.isArray(ev.result.argv)) return ev.result.argv.join(' ');
  if (Array.isArray(ev.args.argv)) return ev.args.argv.join(' ');
  return null;
}

/**
 * ⚠️ `ok: true` MEANS THE COMMAND RAN, NOT THAT IT PASSED — command.mjs says so
 * itself. Reading `ok` as success here would mean every failing test looked
 * like a success and this whole pattern would be dead code.
 */
function runFailed(result) {
  if (result?.timedOut === true) return true;
  if (result?.passed === false) return true;
  return Number.isFinite(result?.exitCode) && result.exitCode !== 0;
}

/* ══════════════════════════════════════════════════════════════════════════
 * flattening — turn `rounds` into one ordered event stream
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {Array} rounds records in the shape turn.mjs pushes:
 *   `{ round, note, executed: [{ id, name, args, result, mutated }], usage }`
 *
 * ⚠️ EVERY FIELD IS TREATED AS ABSENT UNTIL PROVEN PRESENT. A provider can emit
 * a tool call whose arguments do not parse, and tools.mjs hands back
 * `args: {}` with an error result; a resumed session can carry a round from an
 * older shape. A detector that throws inside the loop it is meant to protect is
 * worse than no detector.
 */
function flatten(rounds) {
  const events = [];
  const roundMeta = [];
  if (!Array.isArray(rounds)) return { events, roundMeta };

  rounds.forEach((round, roundIndex) => {
    const label = Number.isFinite(round?.round) ? round.round : roundIndex + 1;
    roundMeta.push({ roundIndex, label });
    const executed = Array.isArray(round?.executed) ? round.executed : [];
    for (const record of executed) {
      if (!record || typeof record !== 'object') continue;
      if (typeof record.name !== 'string' || !record.name) continue;
      events.push({
        roundIndex,
        label,
        name: record.name,
        args: (record.args && typeof record.args === 'object') ? record.args : {},
        result: (record.result && typeof record.result === 'object') ? record.result : {},
        mutated: record.mutated === true,
      });
    }
  });
  return { events, roundMeta };
}

/**
 * Annotate each event with the two facts every pattern needs: did it change a
 * file, and had we seen this exact probe before?
 *
 * ⚠️ THIS WALKS THE WHOLE HISTORY, NOT THE WINDOW. "Is this content new?" and
 * "have I asked this before?" are questions about everything that came before,
 * and answering them from the window alone would call a re-read of something
 * fetched ten rounds ago a brand-new observation.
 */
function annotate(events) {
  const lastWritten = new Map();  // path → content most recently written there
  const seenProbes = new Set();

  for (const ev of events) {
    ev.path = null;
    ev.content = null;
    ev.changedDisk = false;
    ev.newProbe = false;
    ev.isRun = RUN_TOOLS.has(ev.name);

    const ok = ev.result.ok === true;

    if (ev.name === 'write_file' && ok) {
      const path = normPath(ev.args.path);
      const content = ev.args.content;
      // ⚠️ a non-string content is NOT "the same as the last non-string
      // content" — two unknowns are not a match, they are two unknowns.
      if (path && typeof content === 'string') {
        ev.path = path;
        ev.content = content;
        ev.changedDisk = !lastWritten.has(path) || lastWritten.get(path) !== content;
        lastWritten.set(path, content);
      } else {
        ev.changedDisk = true;
      }
    } else if ((ev.name === 'edit_file' || ev.name === 'delete_file') && ok) {
      ev.path = normPath(ev.args.path);
      // edit.mjs refuses an edit whose old_string equals its new_string, so a
      // successful edit is by construction a real change. After it, whatever we
      // thought was on disk is stale — forget it rather than compare against it.
      ev.changedDisk = true;
      if (ev.path) lastWritten.delete(ev.path);
    } else if (!ev.isRun && !MUTATING_TOOLS.has(ev.name)) {
      const key = probeKey(ev.name, ev.args);
      ev.newProbe = !seenProbes.has(key);
      seenProbes.add(key);
    } else if (!ok && MUTATING_TOOLS.has(ev.name)) {
      // A refused write is not a change, but the refusal itself is information
      // the first time it arrives.
      const key = probeKey(ev.name, ev.args);
      ev.newProbe = !seenProbes.has(key);
      seenProbes.add(key);
    }
  }
  return events;
}

/* ══════════════════════════════════════════════════════════════════════════
 * the patterns
 * ══════════════════════════════════════════════════════════════════════════ */

/** Writes to one path, in order, within the window. */
function writesByPath(windowEvents) {
  const byPath = new Map();
  for (const ev of windowEvents) {
    if (ev.name !== 'write_file' || !ev.path || typeof ev.content !== 'string') continue;
    if (!byPath.has(ev.path)) byPath.set(ev.path, []);
    byPath.get(ev.path).push(ev);
  }
  return byPath;
}

/** A → B → A. The file is being flipped between two answers already tried. */
function findThrashing(windowEvents) {
  for (const [path, writes] of writesByPath(windowEvents)) {
    for (let i = 2; i < writes.length; i += 1) {
      if (writes[i].content === writes[i - 2].content && writes[i].content !== writes[i - 1].content) {
        return {
          pattern: 'thrashing',
          evidence: {
            key: `thrashing:${path}`,
            path,
            rounds: [writes[i - 2].label, writes[i - 1].label, writes[i].label],
            count: 3,
          },
        };
      }
    }
  }
  return null;
}

/** The same bytes written to the same path twice — the second one did nothing. */
function findIdenticalWrite(windowEvents) {
  for (const [path, writes] of writesByPath(windowEvents)) {
    const buckets = new Map();
    for (const ev of writes) {
      if (!buckets.has(ev.content)) buckets.set(ev.content, []);
      buckets.get(ev.content).push(ev);
    }
    for (const [content, group] of buckets) {
      if (group.length < IDENTICAL_WRITE_LIMIT) continue;
      return {
        pattern: 'repeated-identical-edit',
        evidence: {
          key: `repeated-identical-edit:${path}`,
          path,
          count: group.length,
          bytes: content.length,
          rounds: group.map((ev) => ev.label),
        },
      };
    }
  }
  return null;
}

/**
 * The same command, same exit code, same first error line, three times.
 *
 * ⚠️⚠️ THE CHAIN RESETS ON A REAL FILE CHANGE, and that single rule is what
 * keeps the most common legitimate shape in the world out of here: a test
 * failing with the identical assertion while the model rewrites the code
 * between every run. That is iteration, and it is what success looks like right
 * up until the last round. Only failures with NOTHING changed between them are
 * a circle.
 *
 * ⚠️ A DIFFERENT FIRST LINE STARTS A NEW CHAIN — "same command failing
 * differently" is the model peeling errors off one at a time, which is the
 * definition of progress.
 */
function findCommandFailureLoop(windowEvents) {
  let chain = null;
  for (const ev of windowEvents) {
    if (ev.changedDisk) { chain = null; continue; }
    if (!ev.isRun || ev.result.ok !== true) continue;

    const command = commandOf(ev);
    if (!command) continue;

    if (!runFailed(ev.result)) {
      // The same command working is the clearest possible "not stuck".
      if (chain && chain.command === command) chain = null;
      continue;
    }

    const exitCode = Number.isFinite(ev.result.exitCode) ? ev.result.exitCode : null;
    const errorLine = firstErrorLine(ev.result);
    const same = chain && chain.command === command && chain.exitCode === exitCode && chain.errorLine === errorLine;
    if (same) {
      chain.count += 1;
      chain.rounds.push(ev.label);
    } else {
      chain = { command, exitCode, errorLine, count: 1, rounds: [ev.label] };
    }

    if (chain.count >= COMMAND_FAILURE_LIMIT) {
      return {
        pattern: 'repeated-command-failure',
        evidence: {
          key: `repeated-command-failure:${command}:${exitCode}:${errorLine}`,
          command, exitCode, errorLine,
          count: chain.count,
          rounds: chain.rounds.slice(),
        },
      };
    }
  }
  return null;
}

/**
 * The same tool refusing with the same message, three times running.
 *
 * ⚠️ THE SAME TOOL SUCCEEDING CLEARS THE CHAIN. An `edit_file` that misses,
 * lands, misses again is an ordinary editing session with two typos in it — not
 * a loop. Only an unbroken run of identical refusals counts.
 */
function findToolErrorLoop(windowEvents) {
  let chain = null;
  for (const ev of windowEvents) {
    // A failing command is not a refusing tool: it RAN. That is
    // findCommandFailureLoop's business, and counting it twice would double the
    // nudges for one problem.
    if (ev.isRun && ev.result.ok === true) continue;

    if (ev.result.ok === true) {
      if (chain && chain.tool === ev.name) chain = null;
      continue;
    }
    if (ev.result.ok !== false) continue;

    const error = normMessage(ev.result.error);
    if (!error) continue;

    if (chain && chain.tool === ev.name && chain.error === error) {
      chain.count += 1;
      chain.rounds.push(ev.label);
    } else {
      chain = { tool: ev.name, error, count: 1, rounds: [ev.label] };
    }

    if (chain.count >= TOOL_ERROR_LIMIT) {
      return {
        pattern: 'tool-error-loop',
        evidence: {
          key: `tool-error-loop:${ev.name}:${error}`,
          tool: ev.name,
          error,
          count: chain.count,
          rounds: chain.rounds.slice(),
        },
      };
    }
  }
  return null;
}

/**
 * Rounds that wrote nothing, ran nothing, and asked nothing new.
 *
 * ⚠️⚠️ "NO WRITES" IS NOT THE TEST, AND THIS IS THE TRAP THE BRIEF WARNS ABOUT
 * DIRECTLY. A long research phase writes nothing for many rounds and is exactly
 * how a good agent starts a hard task. What makes a round inert is that it
 * produced NO NEW OBSERVATION EITHER — every read, search and listing in it had
 * already been made earlier in the same run. Reading ten different files is
 * work; reading the same file for the fourth time while writing nothing is not.
 */
function findNoProgress(events, roundMeta, windowRounds, inertLimit) {
  if (roundMeta.length < inertLimit) return null;

  const activeByRound = new Map();
  for (const ev of events) {
    const active = ev.changedDisk || ev.mutated || ev.isRun || ev.newProbe;
    if (active) activeByRound.set(ev.roundIndex, true);
  }

  const tail = roundMeta.slice(-inertLimit);
  if (tail.length < inertLimit) return null;
  if (tail[0].roundIndex < roundMeta.length - windowRounds) return null;
  for (const meta of tail) {
    if (activeByRound.get(meta.roundIndex)) return null;
  }

  return {
    pattern: 'no-progress',
    evidence: {
      key: `no-progress:from-${tail[0].label}`,
      count: tail.length,
      rounds: tail.map((m) => m.label),
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * suggestions — the field that is actually worth anything
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⭐ WRITTEN FOR A MODEL TO ACT ON, NOT FOR A HUMAN TO READ IN A LOG.
 *
 * Three rules, all learned the hard way in this repo:
 *   · NAME THE ARTIFACT. "You appear to be stuck" is unactionable; "you have
 *     written the identical bytes to lib/mode.js twice" points at a thing.
 *   · PROPOSE A MOVE. An observation with no next step gets acknowledged and
 *     then ignored.
 *   · NEVER SCOLD, AND NEVER IMPLY THE RUN IS OVER. An error string is an
 *     instruction — this package already watched "try once more" make a model
 *     retry a dead service until the session died. "You have failed" reads as
 *     permission to hand back half a job.
 */
function suggestionFor(pattern, evidence) {
  switch (pattern) {
    case 'long-cycle':
      return `The same ${evidence.length} steps have now repeated ${evidence.repeats} times without changing `
        + `(${evidence.verbs.join(' → ')}), on the same arguments each time. Repeating them again will produce the `
        + `same result, because nothing between the rounds is different. Stop and state what you EXPECTED to change `
        + `and what actually did — then either read the last failure output properly, or try a different approach `
        + `entirely rather than another pass of the same loop.`;

    case 'thrashing':
      return `\`${evidence.path}\` has just been flipped back to a version already tried `
        + `(A → B → A across rounds ${evidence.rounds.join(', ')}). Alternating between two answers will not settle it, `
        + `because whatever rejected the first version has not been addressed yet. Read the most recent failure output `
        + `closely and change one specific thing on purpose, rather than reverting.`;

    case 'repeated-identical-edit':
      return `The identical ${evidence.bytes} bytes have now been written to \`${evidence.path}\` ${evidence.count} times, `
        + `so the later write changed nothing on disk. Before writing it again, check that this is really the path the `
        + `failing command loads — a near-miss path, or a build output directory, would look exactly like this — and read `
        + `the file back to confirm what is actually there.`;

    case 'repeated-command-failure':
      return `\`${evidence.command}\` has failed ${evidence.count} times with the same exit code (${evidence.exitCode}) `
        + `and the same first line: "${evidence.errorLine}". No file changed between those runs, so running it again `
        + `will print the same thing. Read further into the output than the first line, or run something smaller that `
        + `isolates which part fails.`;

    case 'tool-error-loop':
      if (evidence.tool === 'edit_file') {
        return `\`edit_file\` has refused ${evidence.count} times in a row with the same message: "${evidence.error}". `
          + `The call is what needs to change, not the number of attempts: read the file first and copy the exact text `
          + `into old_string — including indentation and line endings — or write the whole file if the span is hard to `
          + `quote precisely.`;
      }
      return `\`${evidence.tool}\` has refused ${evidence.count} times in a row with the same message: "${evidence.error}". `
        + `Repeating the same call will get the same answer, so read that message closely and change the arguments, or `
        + `reach the same goal with a different tool.`;

    case 'no-progress':
      return `The last ${evidence.count} rounds wrote no files, ran no commands, and only repeated lookups already made `
        + `earlier in this run. If there is enough information to act, make the change now; if something is genuinely `
        + `blocking it, say what is blocking it before looking again.`;

    default:
      return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * the entry point
 * ══════════════════════════════════════════════════════════════════════════ */

const CLEAN = Object.freeze({ stuck: false, pattern: null, evidence: null, suggestion: null });

/**
 * Is this run going in circles?
 *
 * @param {Array} rounds  the history `runSession` already keeps, oldest first.
 * @param {object} [options]
 * @param {number} [options.window=4]  how many recent rounds to examine.
 * @returns {{stuck:boolean, pattern:string|null, evidence:object|null, suggestion:string|null}}
 *
 * ⚠️ A CLEAN RESULT IS FULLY NULL, never partially populated. A caller that
 * reads `.suggestion` without checking `.stuck` must get nothing rather than a
 * stale hint — this repo has already shipped one detector whose "all clear"
 * carried a verdict about a page it had never seen.
 */

/**
 * ── ⭐⭐ THE LOOP A FOUR-ROUND WINDOW CANNOT SEE ─────────────────────────────
 *
 * Everything above examines `DEFAULT_WINDOW = 4` rounds. That is the right size
 * for the patterns it names — two identical writes, an A→B→A flip — but it makes
 * one whole family invisible by arithmetic: a cycle of PERIOD 3 (read X, edit X,
 * run tests, read X, edit X, run tests) never fits two repetitions inside four
 * rounds, so it can run until the round cap and never be reported.
 *
 * ⚠️ IT IS REACHABLE WITH OUR OWN BUDGET — 24 rounds by default, 64 by ceiling,
 * 200 under `--until-done`. And MAST (1,600+ traces, κ=0.88) measured **step
 * repetition as the single largest failure mode at 17.14%**, larger than any
 * other category.
 *
 * ⭐ ZERO TOKENS: string comparison over history we already hold.
 *
 * ⚠️ THE SIGNATURE INCLUDES THE ARGUMENTS, and that is what keeps it honest.
 * read → edit → run repeated over DIFFERENT files is exactly what a competent
 * refactor looks like; only a byte-identical cycle counts.
 */
export const LONG_CYCLE_HISTORY = 24;
export const LONG_CYCLE_MAX_LEN = 5;
export const LONG_CYCLE_REPEATS = 3;

/** What makes two rounds "the same step" — the verb plus what it was aimed at. */
function roundSignature(round) {
  const executed = Array.isArray(round?.executed) ? round.executed : [];
  return executed
    .filter((r) => r && typeof r.name === 'string')
    .map((r) => {
      let args = '';
      try { args = JSON.stringify(r.args ?? {}); } catch { args = ''; }
      return `${r.name}(${args.slice(0, 400)})`;
    })
    .join('|');
}

/**
 * ⚠️ EXPORTED FOR THE TESTS, AND THE REASON IS ITSELF A FINDING. The
 * `new Set(cycle).size < 2` guard below could not be reached through
 * `detectStuck`: a run of identical reads trips `no-progress` first, so a
 * mutation deleting the guard left every test green. A guard no test can
 * reach is indistinguishable from dead code — so the function is exported and
 * the guard is exercised directly rather than deleted or left unproven.
 */
export function findLongCycle(rounds) {
  const recent = rounds.slice(-LONG_CYCLE_HISTORY);
  const sigs = recent.map(roundSignature).filter((x) => x !== '');
  if (sigs.length < LONG_CYCLE_REPEATS * 2) return null;

  /**
   * ⚠️ LONGEST PERIOD FIRST. A period-4 loop also contains a period-2 one when
   * its halves happen to match; reporting the shorter one would name a smaller
   * loop than the model is actually running.
   */
  for (let len = LONG_CYCLE_MAX_LEN; len >= 2; len -= 1) {
    if (sigs.length < len * LONG_CYCLE_REPEATS) continue;
    const tail = sigs.slice(-len * LONG_CYCLE_REPEATS);
    const cycle = tail.slice(0, len);
    let matches = true;
    for (let i = 0; i < tail.length; i += 1) {
      if (tail[i] !== cycle[i % len]) { matches = false; break; }
    }
    if (!matches) continue;
    /**
     * ⚠️ A CYCLE OF ONE DISTINCT STEP IS NOT A CYCLE — it is the repeated-call
     * case the detectors above already state more precisely.
     */
    if (new Set(cycle).size < 2) continue;
    const verbs = [...new Set(cycle.flatMap((sig) => sig.split('|').map((c) => c.split('(')[0])))];
    return { pattern: 'long-cycle', evidence: { length: len, repeats: LONG_CYCLE_REPEATS, verbs } };
  }
  return null;
}

export function detectStuck(rounds, { window = DEFAULT_WINDOW } = {}) {
  if (!Array.isArray(rounds) || rounds.length === 0) return { ...CLEAN };

  const windowRounds = Number.isFinite(window) && window >= 1 ? Math.floor(window) : DEFAULT_WINDOW;
  const inertLimit = Math.min(INERT_ROUND_LIMIT, windowRounds);

  const { events, roundMeta } = flatten(rounds);
  annotate(events);

  const firstWindowRound = Math.max(0, roundMeta.length - windowRounds);
  const windowEvents = events.filter((ev) => ev.roundIndex >= firstWindowRound);
  const windowMeta = roundMeta.filter((m) => m.roundIndex >= firstWindowRound);

  const hit = findThrashing(windowEvents)
    ?? findIdenticalWrite(windowEvents)
    ?? findToolErrorLoop(windowEvents)
    ?? findCommandFailureLoop(windowEvents)
    ?? (windowMeta.length >= inertLimit ? findNoProgress(events, roundMeta, windowRounds, inertLimit) : null)
    ?? findLongCycle(rounds);

  if (!hit) return { ...CLEAN };

  const suggestion = suggestionFor(hit.pattern, hit.evidence);
  if (!suggestion) return { ...CLEAN };

  return { stuck: true, pattern: hit.pattern, evidence: hit.evidence, suggestion };
}

/**
 * The exact text to append to the conversation, or null when there is nothing
 * to say.
 *
 * ⚠️ IT ANNOUNCES ITSELF AS MACHINERY, NOT AS THE USER. A bare instruction
 * arriving in the `user` role is indistinguishable from the human changing
 * their mind, and a model that believes the user just spoke will re-plan the
 * whole task around it. Naming the source keeps it a hint about HOW to continue
 * rather than a new instruction about WHAT to do.
 */
export function nudgeMessage(result) {
  if (!result || result.stuck !== true || typeof result.suggestion !== 'string') return null;
  return `[loop watcher — automatic, not from the user] ${result.suggestion}`;
}

/**
 * ── ⭐ HOW TO WIRE THIS (the whole point of the module) ──────────────────────
 *
 * In `lib/turn.mjs`, at the top:
 *
 *     import { detectStuck, nudgeMessage } from './stuck.mjs';
 *
 * and in `runSession`, immediately after the existing `rounds.push({ round, ... })`:
 *
 *     const circling = detectStuck(rounds);
 *     if (circling.stuck && !nudged.has(circling.evidence.key)) {
 *       nudged.add(circling.evidence.key);
 *       messages.push({ role: 'user', content: nudgeMessage(circling) });
 *       onEvent({ type: 'stuck', round, pattern: circling.pattern, evidence: circling.evidence });
 *     }
 *
 * with one declaration beside `const rounds = []`:
 *
 *     const nudged = new Set();
 *
 * ⚠️ `nudged` IS NOT OPTIONAL. Without it the same loop re-nudges every round,
 * which changes the prompt prefix every round and destroys the byte-identical
 * cache hit worth 3.05x on DeepSeek — a loop detector that triples the bill is
 * not a saving. `evidence.key` is stable for as long as one loop persists and
 * differs between distinct loops, which is exactly what a dedupe set needs.
 *
 * ⭐ NUDGING IS THE DEFAULT ACTION, NOT STOPPING. The model gets one hint and
 * keeps its budget; a caller that wants a hard stop can compare
 * `circling.evidence.key` across rounds itself and give up on the second sighting.
 * Ending a run automatically is the expensive mistake this module was written to
 * avoid making.
 */
