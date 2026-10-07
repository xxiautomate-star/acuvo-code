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
  /**
   * ⭐⭐⭐ THE ONE THE FOUR PATTERNS BELOW WERE BUILT TO EXCLUDE.
   *
   * `findCommandFailureLoop` resets its chain on ANY real file change, and its
   * own comment defends that at length: *"a test failing with the identical
   * assertion while the model rewrites the code between every run… is iteration,
   * and it is what success looks like right up until the last round."*
   *
   * ⚠️ THAT IS TRUE OF THE FIRST TWO ROUNDS AND FALSE OF THE FOURTH. Editing one
   * file three separate times and getting a BYTE-IDENTICAL compiler error every
   * single time is not iteration — it is proof the edits are not reaching what
   * is failing. The model is almost always editing the wrong file, and the error
   * output is the receipt.
   *
   * This is Roman's rule, verbatim: *"If an agent modifies the exact same file
   * line three times without changing the error output of the compiler, the loop
   * must break, notify the user, and rollback to the last working state."*
   */
  'futile-edit-loop',
  'tool-error-loop',
  'repeated-command-failure',
  'no-progress',
  /**
   * ⭐⭐⭐ THE LOOP EVERY PATTERN ABOVE IS STRUCTURALLY BLIND TO, BECAUSE THEY
   * ALL WATCH TOOL CALLS AND THIS ONE LIVES IN THE PROSE.
   *
   * Measured on a real run, 2026-09-21: 24 rounds spent analysing a directory,
   * and rounds 14–17 and 21–23 opened with the BYTE-IDENTICAL sentence *"Let me
   * check the remaining docs and the current state of the app to complete the
   * picture."* The run then died on the round cap having produced no report at
   * all. Not one watcher fired, and each was right by its own definition:
   * `roundSignature` is `name(args)`, the model read three DIFFERENT files every
   * round, so every signature was unique and `findLongCycle` saw no cycle.
   *
   * ⚠️ THE UNIVERSE WAS WRONG, NOT THE ASSERTION — the failure this repo already
   * names as `a_guards_universe_matters_as_much_as_its_assertion`. A model that
   * restates the same intent verbatim while touching nothing is not gathering;
   * it has stopped deciding, and the round cap is about to eat the answer.
   */
  'restated-plan',
  /**
   * ⚠️ LAST ON PURPOSE. A period-1 cycle IS a repeated identical edit, and every
   * shorter pattern above states the same fact more precisely. This one exists
   * only for the loops the others structurally cannot see.
   */
  'long-cycle',
];

/** How many of the most recent rounds are examined. */
export const DEFAULT_WINDOW = 4;

/**
 * ── ⭐⭐ QUESTION 4 OF FOUR: WHAT TO DO WHEN IT IS STUCK ─────────────────────
 *
 * Until now this was not a setting, it was a hard-coded pair of rules in
 * `turn.mjs`: nudge once per distinct loop, and hard-stop on the SECOND sighting
 * **only under `--until-done`**. Both halves are good defaults and neither was
 * the user's to change.
 *
 * ⚠️ AND THE ASYMMETRY IS REAL, so the options are ordered by what they cost
 * when they are wrong — the same reasoning the header of this file opens with:
 *
 *   'nudge'  hint once per distinct loop, never stop.   ← TODAY, and the default
 *   'stop'   hint once, then end the run on a repeat.   cheapest, loses the work
 *   'ask'    hint once, then ask the human on a repeat. needs a terminal
 *
 * ⭐ `ask` DEGRADES TO `nudge`, NEVER TO `stop`. With no terminal there is
 * nobody to answer, and a run that silently ends because it was configured to
 * ask a question nobody could hear is the "least legible failure available"
 * `ask-user.mjs` refuses by name. Failing toward MORE work is the direction that
 * cannot throw away money already spent.
 *
 * ⚠️ AND `--until-done` KEEPS ITS HARD STOP WHATEVER THIS SAYS. An unbounded run
 * has no wall but money, and a proven loop that survived its own hint is exactly
 * the shape that spends a whole budget learning nothing. So `untilDone` raises
 * the floor from 'nudge' to 'stop'; it never lowers a stricter choice.
 */
export const STUCK_ACTIONS = Object.freeze(['nudge', 'stop', 'ask']);

/** What a user who has said nothing gets — byte-for-byte today's behaviour. */
export const DEFAULT_STUCK_ACTION = 'nudge';

/**
 * Decide what this sighting means. PURE — the caller does the nudging, the
 * stopping and the asking; this only says which.
 *
 * @param {object} args
 * @param {boolean} args.firstSighting  is this the first time THIS loop is seen?
 * @param {string}  [args.action]       the configured action
 * @param {boolean} [args.untilDone]    is this an unbounded run?
 * @param {boolean} [args.canAsk]       is there a human at this terminal?
 * @returns {{ do: 'nudge'|'stop'|'ask'|'nothing', reason: string }}
 */
/**
 * ── ⭐⭐⭐ THE ONE PATTERN THAT DOES NOT GET A HINT FIRST ─────────────────────
 *
 * Everything else here nudges once, because a hint is cheap and killing correct
 * work is not. `futile-edit-loop` is different, and the difference is that ITS
 * THRESHOLD ALREADY CONTAINS THE PATIENCE: it has watched three separate edits
 * land on one file and produce a byte-identical failure each time. A nudge here
 * would buy a FOURTH identical round before anything happened.
 *
 * ⚠️ AND IT IS THE ONLY PATTERN WHOSE EVIDENCE SUPPORTS A ROLLBACK. The other
 * six know that something is repeating; this one knows WHICH FILE was edited and
 * that the edits demonstrably changed nothing. That is what makes putting them
 * back a defensible act rather than a guess.
 *
 * ⚠️ `allowBreak: false` TURNS IT BACK INTO AN ORDINARY PATTERN, hint and all.
 * Someone who does not want a run stopped automatically must have a way to say
 * so that is not "delete the detector".
 */
export const BREAKING_PATTERNS = Object.freeze(['futile-edit-loop']);

export function stuckAction({ firstSighting, action = DEFAULT_STUCK_ACTION, untilDone = false, canAsk = false, pattern = null, allowBreak = true } = {}) {
  if (allowBreak && BREAKING_PATTERNS.includes(pattern)) {
    return {
      do: 'break',
      reason: 'the same file was edited three times and the failure did not change by one byte, so the next edit would be the fourth',
    };
  }
  /**
   * ⚠️ AN UNKNOWN ACTION IS THE DEFAULT, NOT A CRASH. The value is validated at
   * the config boundary (`rcfile.mjs` refuses an enum it does not know), so a
   * stranger arriving here means a caller passed one directly — and throwing
   * inside the loop this module exists to protect is worse than proceeding as
   * the ninety-nine users with no setting do.
   */
  const want = STUCK_ACTIONS.includes(action) ? action : DEFAULT_STUCK_ACTION;

  /**
   * ⭐ THE FIRST SIGHTING IS ALWAYS A NUDGE, WHATEVER THE SETTING. Stopping the
   * first time a pattern appears would kill a run one round before the hint it
   * has not yet been given could have worked, and the hint is the product.
   */
  if (firstSighting) return { do: 'nudge', reason: 'first sighting of this loop — one hint, no interruption' };

  // The loop survived its own hint.
  if (want === 'ask') {
    if (canAsk) return { do: 'ask', reason: 'this loop survived its hint and you asked to be consulted' };
    return { do: 'nudge', reason: 'you asked to be consulted, but there is no terminal to ask — continuing rather than ending a paid run on a heuristic' };
  }
  if (want === 'stop') return { do: 'stop', reason: 'this loop survived its hint and you asked to stop on a repeat' };

  /**
   * ⚠️ THE ONE PLACE `untilDone` STILL DECIDES ANYTHING. It raises 'nudge' to
   * 'stop' and nothing else, which is exactly the rule `turn.mjs` had inline.
   */
  if (untilDone) return { do: 'stop', reason: 'an unbounded run has no wall but money, and this loop survived its hint' };
  return { do: 'nothing', reason: 'already hinted about this loop; a bounded run still has its round ceiling' };
}

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

/* ══════════════════════════════════════════════════════════════════════════
 * the circuit breaker — "the edits are real and the error has not moved"
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️ THREE, AND IT IS THREE EDITS, NOT THREE FAILURES. One failure is a bug; a
 * failure after one edit is a miss; a failure after a SECOND edit is still
 * plausibly a multi-part fix. A third edit to the same file that moves the
 * compiler not one byte is where the evidence stops being ambiguous.
 */
export const FUTILE_EDIT_LIMIT = 3;

/**
 * ⚠️ A WIDER WINDOW THAN THE FOUR-ROUND ONE, BY ARITHMETIC. Three edit-and-run
 * pairs cannot fit in four rounds, so evaluating this pattern inside the default
 * window would make it structurally unreachable — the same defect `long-cycle`'s
 * header describes, and it is worth stating twice because it is invisible.
 */
export const FUTILE_HISTORY_ROUNDS = 16;

/**
 * ── ⭐⭐ WHY THE SIGNATURE IS THREE LINES AND NOT ONE ────────────────────────
 *
 * `firstErrorLine` is right for `repeated-command-failure`, whose job is to spot
 * a command that is not being changed at all. It is too weak HERE, because this
 * pattern is about to STOP A RUN and possibly PUT FILES BACK. A model genuinely
 * fixing errors one at a time in a large build can leave the first line
 * unchanged for several rounds while real progress happens behind it.
 *
 * ⭐ Three lines is enough that "the compiler said exactly the same thing" is a
 * claim about the output rather than about its first sentence, and still cheap
 * enough to be a string comparison over history we already hold.
 */
function errorSignature(result) {
  const pick = (text) => {
    if (typeof text !== 'string') return [];
    /**
     * ⚠️ NODE'S OWN RUNTIME WARNINGS ARE NOT THE ERROR, AND THEY CARRY A PID.
     * On Node 20 the workspace sandbox's `--experimental-permission` prints
     * `(node:12345) ExperimentalWarning: …` first on stderr, so every run had a
     * different signature and the breaker never fired (Node 20 CI cells,
     * 2026-10-02). Those lines — and their `(Use \`node --trace-warnings …\`)`
     * tail — are dropped before the three lines are taken.
     */
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .filter((l) => !/^\(node:\d+\) /.test(l) && !/^\(Use `node --trace-/.test(l))
      .slice(0, 3);
  };
  const lines = pick(result?.stderr).length ? pick(result?.stderr) : pick(result?.stdout);
  return lines.join(' ⏎ ').replace(/\s+/g, ' ').slice(0, 400);
}

/**
 * Three real edits to one file, three identical failures, no movement.
 *
 * ⚠️⚠️ EVERY CLAUSE HERE IS A GUARD AGAINST FLAGGING CORRECT WORK, and each one
 * removes a legitimate shape that would otherwise look identical:
 *
 *   · **an edit must have happened between two failures.** With no edit between
 *     them this is `repeated-command-failure`, which already states it better
 *     and does not stop anything.
 *   · **the same PATH must appear in every gap.** Editing three different files
 *     while one error persists is a normal wide fix; only "this exact file,
 *     again, and nothing moved" counts.
 *   · **the command must be the same command.** Two different builds failing is
 *     two facts, not one loop.
 *   · **any success clears everything.** A single green run means the previous
 *     rounds were the descent they looked like.
 *
 * @param {readonly object[]} events annotated events, oldest first
 */
function findFutileEditLoop(events) {
  let chain = null;
  let pending = new Set();
  /**
   * ⚠️⚠️ THE SCAN DOES NOT RETURN EARLY, AND THAT IS NOT A STYLE CHOICE.
   *
   * Returning at the first hit answers "did this ever happen", and the question
   * this function is asked every round is "is it happening NOW". A history that
   * loops three times and then goes GREEN has been rescued; reporting the loop
   * afterwards would break a run that had already fixed itself — and this
   * detector STOPS runs and puts files back, so a stale verdict is the most
   * expensive kind of wrong available here. Caught by its own test.
   */
  let found = null;

  for (const ev of events) {
    if (ev.changedDisk && ev.path) pending.add(ev.path);
    if (!ev.isRun || ev.result.ok !== true) continue;

    const command = commandOf(ev);
    if (!command) continue;

    if (!runFailed(ev.result)) {
      // ⭐ THE CLEAREST POSSIBLE "NOT STUCK". Everything before it was progress,
      //   including a loop that was in progress a moment ago.
      chain = null;
      found = null;
      pending = new Set();
      continue;
    }

    const exitCode = Number.isFinite(ev.result.exitCode) ? ev.result.exitCode : null;
    const signature = errorSignature(ev.result);
    const same = chain && chain.command === command && chain.exitCode === exitCode && chain.signature === signature;

    if (!same) {
      // A different error is the model peeling one off — a NEW chain, not a hit.
      chain = { command, exitCode, signature, gaps: [], rounds: [ev.label] };
      pending = new Set();
      continue;
    }

    /**
     * ⚠️ A FAILURE WITH NO EDIT BEHIND IT DOES NOT COUNT AND DOES NOT RESET.
     * Re-running the same failing command to look at the output again is a
     * perfectly ordinary thing to do, and neither proves nor disproves anything
     * about whether the edits are landing.
     */
    if (pending.size === 0) continue;

    chain.gaps.push(pending);
    chain.rounds.push(ev.label);
    pending = new Set();

    if (chain.gaps.length < FUTILE_EDIT_LIMIT) continue;

    const recent = chain.gaps.slice(-FUTILE_EDIT_LIMIT);
    let common = new Set(recent[0]);
    for (const gap of recent.slice(1)) common = new Set([...common].filter((p) => gap.has(p)));
    if (common.size === 0) continue;

    const paths = [...common].sort();
    found = {
      pattern: 'futile-edit-loop',
      evidence: {
        key: `futile-edit-loop:${paths.join(',')}:${command}:${exitCode}:${signature}`,
        paths,
        command,
        exitCode,
        errorLine: signature,
        /** How many real edits produced no movement — what gets rolled back. */
        edits: FUTILE_EDIT_LIMIT,
        count: chain.gaps.length,
        rounds: chain.rounds.slice(-(FUTILE_EDIT_LIMIT + 1)),
      },
    };
  }
  return found;
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
    case 'futile-edit-loop':
      return `\`${evidence.paths.join('`, `')}\` has been edited ${evidence.edits} times and \`${evidence.command}\` has `
        + `failed identically every time — same exit code (${evidence.exitCode}), same output: "${evidence.errorLine}". `
        + `The edits ARE landing on disk, so the file being edited is not the file the error is about. `
        + `Stop editing it. Read the failure output again and find the path it actually names, or run something smaller `
        + `that isolates which file the compiler is complaining about, before changing another line.`;
    case 'restated-plan':
      return `The last ${evidence.count} rounds have all opened with the same sentence — "${evidence.sentence}" `
        + `(rounds ${evidence.rounds.join(', ')}) — and nothing has been written or run in them. Gathering more `
        + `context has stopped changing the plan, which means you already have what you need. `
        + `⚠️ The round budget is finite and it will end this run mid-gather, so the answer would never be written down. `
        + `Stop reading and produce the deliverable NOW from what you already have, naming explicitly what you did not `
        + `get to — a partial answer that reaches the user beats a complete one that the round cap eats.`;
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
/**
 * ── ⭐ THE RESTATED PLAN ─────────────────────────────────────────────────────
 * How many consecutive rounds must open with the same sentence. Three, to match
 * `LONG_CYCLE_REPEATS` — two is a model finishing a thought it began, three is a
 * model that has stopped choosing.
 */
export const RESTATED_PLAN_REPEATS = 3;
/**
 * ⚠️ SHORT NOTES ARE EXEMPT, AND THIS IS THE GUARD THAT KEEPS IT HONEST.
 * `"Reading."` or `"One moment."` repeating is narration, not a stall, and a
 * detector that fired on them would cry wolf on every terse model.
 */
export const RESTATED_PLAN_MIN_CHARS = 24;

/**
 * Compare INTENT, not bytes: case, punctuation, ellipses and whitespace all
 * vary between rounds without the plan changing at all.
 * ⚠️ The real transcript's notes ended `"…"` on some rounds and `"."` on
 * others; a byte comparison would have missed three of the seven.
 */
export function normalisePlanText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\s+/g, ' ')
    .replace(/[.…]+\s*$/u, '')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * ⚠️⚠️ A ROUND THAT CHANGED THE WORLD RESETS THIS, exactly as
 * `findCommandFailureLoop` resets on a real file change. Saying the same
 * sentence while actually writing files is a model narrating badly, which is a
 * style complaint and not a stall — and stopping a run that IS producing work
 * would be far worse than the loop this catches.
 */
export function findRestatedPlan(rounds) {
  if (!Array.isArray(rounds) || rounds.length < RESTATED_PLAN_REPEATS) return null;

  let run = [];
  let key = '';
  for (const round of rounds) {
    const mutated = Array.isArray(round?.executed) && round.executed.some((r) => r && r.mutated === true);
    const norm = normalisePlanText(round?.note);
    if (mutated || norm.length < RESTATED_PLAN_MIN_CHARS) { run = []; key = ''; continue; }
    if (norm === key) {
      run.push(Number.isFinite(round?.round) ? round.round : run.length + 1);
    } else {
      key = norm;
      run = [Number.isFinite(round?.round) ? round.round : 1];
    }
    if (run.length >= RESTATED_PLAN_REPEATS) {
      return {
        pattern: 'restated-plan',
        evidence: { sentence: String(round?.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 160), count: run.length, rounds: [...run] },
      };
    }
  }
  return null;
}

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

  /**
   * ⚠️ ITS OWN, WIDER WINDOW — see `FUTILE_HISTORY_ROUNDS`. Three edit-and-run
   * pairs do not fit in four rounds, so evaluating this over `windowEvents`
   * would make it dead code that every test still passed.
   */
  const futileFrom = Math.max(0, roundMeta.length - FUTILE_HISTORY_ROUNDS);
  const futileEvents = events.filter((ev) => ev.roundIndex >= futileFrom);

  const hit = findThrashing(windowEvents)
    ?? findIdenticalWrite(windowEvents)
    ?? findFutileEditLoop(futileEvents)
    ?? findToolErrorLoop(windowEvents)
    ?? findCommandFailureLoop(windowEvents)
    ?? (windowMeta.length >= inertLimit ? findNoProgress(events, roundMeta, windowRounds, inertLimit) : null)
    /**
     * ⚠️ AFTER the tool-call patterns and BEFORE `long-cycle`, on purpose. If a
     * tool loop is also running, that diagnosis is more specific and names the
     * verb; this one fires for the case where the TOOLS look fine and only the
     * thinking has stalled — which is precisely the run that motivated it.
     */
    ?? findRestatedPlan(rounds)
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
