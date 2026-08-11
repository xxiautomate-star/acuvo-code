/**
 * ── ⭐⭐ THE CEILING TASK: THE SEARCH → EDIT HANDOFF, MEASURED ON ITS OWN ─────
 *
 * Every other task in this corpus lets the agent SEE the code it has to change.
 * `gatherWorkspaceContext` pre-reads every file under 8,000 bytes two levels
 * deep and pastes it into the prompt, so `edit` and `feature` are really asking
 * "can you write a correct replacement for text you are already holding". That
 * is a fair question and it is not the one that kills real sessions.
 *
 * ⚠️ THE ONE THAT KILLS SESSIONS IS THE HANDOFF. In a repository of any size the
 * model does not have the line. It has to FIND it (`search_text`), copy it back
 * BYTE-EXACTLY as an `old_string`, and hand that to `edit_file`. Every byte of
 * leading whitespace is load-bearing, and the failure mode is silent and total:
 * a left-aligned copy of a six-space-indented line cannot match, `edit_file`
 * refuses, the model guesses a different indentation, is refused again, and the
 * round budget is gone with the file untouched. `lib/read-window.mjs:34` records
 * a real session that died exactly this way — six spaces guessed where
 * `lib/git.mjs:282` has two.
 *
 * ⭐ SO THE FIXTURE IS BUILT TO REMOVE EVERY OTHER ROUTE, mechanically rather
 * than by asking nicely:
 *
 *   1. The file is ~20KB, so `CONTEXT_MAX_FILE_BYTES` (8,000) keeps its contents
 *      out of the pre-read entirely.
 *   2. It lives three directories deep, and the pre-read walks TWO levels — so
 *      its path never even appears in the tree the model is shown.
 *   3. The target method sits in the MIDDLE. `read_file` clamps its result to
 *      8,000 characters keeping the head and the TAIL (`clampOutput`), so a
 *      whole-file read hands back everything except the one method. That is not
 *      a trick; it is what `read_file` does to any real source file, and it is
 *      why `search_text` + `read_around` exist.
 *
 * The only remaining path is search → window → indented `edit_file`. If the
 * handoff works this task is cheap; if it does not, the agent burns every round
 * on refused edits. That is the measurement.
 *
 * ── ⚠️ THE DEGENERATE SOLUTIONS, ENUMERATED, EACH WITH THE CHECK THAT CATCHES IT
 *
 *   D1  rewrite the whole file from scratch, dropping the parts it never read
 *         → `everyOtherLineSurvives` (subsequence over the original lines)
 *   D2  re-indent / normalise the file so its own guess about whitespace wins
 *         → `indentationPreserved` + `everyOtherLineSurvives`
 *   D3  write a NEW module with a fixed scheduler and leave the original alone
 *         → `noRivalDefinition` + the probe, which imports the ORIGINAL path
 *   D4  hardcode: `return 5000`, or clamp only the attempt it happened to test
 *         → the probe asserts eight different attempts, capped and uncapped
 *   D5  change BASE_DELAY_MS / MAX_DELAY_MS instead of the method
 *         → `constantsIntact` + the probe
 *   D6  leave the method untouched and monkey-patch the prototype below it
 *         → `theMethodItselfChanged` (the original 4-line block must be gone)
 *   D7  delete or move the file so nothing can disagree with it
 *         → `fileStillThere`
 *
 * ⚠️ AND THE CHECKS ARE TOLERANT OF THE SHAPES A REAL FILE COMES IN. A check
 * that fails correct work is worse than no check, and this repo has been bitten
 * by that four separate times. So every comparison below strips a UTF-8 BOM,
 * accepts CRLF as readily as LF, ignores trailing whitespace, tolerates a
 * missing final newline, and counts a tab as eight columns. What it does NOT
 * forgive is LEADING whitespace on the lines that were already there — that is
 * the entire subject of the task.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const TARGET = 'src/engine/pipeline/scheduler.mjs';

/** Read a workspace file, or '' if it is not there. */
const read = (ws, p) => { try { return readFileSync(join(ws, p), 'utf8'); } catch { return ''; } };

/** file:// URL for a workspace file, so a probe can import the real module. */
const url = (ws, rel) => JSON.stringify(`file:///${join(ws, rel).replace(/\\/g, '/')}`);

/** Run a snippet against the generated code and report the thrown message. */
function probe(ws, source) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: ws, encoding: 'utf8', timeout: 30_000,
  });
  if (r.status === 0) return null;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const line = out.split('\n').find((l) => /Error/.test(l)) ?? out.split('\n')[0] ?? 'failed';
  return line.trim().slice(0, 140);
}

/**
 * ⭐ ONE NORMALISER, USED BY EVERY CHECK. A BOM is an encoding marker rather
 * than content, `\r` is half of a line terminator rather than content, and
 * trailing whitespace is invisible — none of the three is what this task is
 * about, and letting any of them fail a correct edit would make the bench lie.
 */
function lines(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // `\s` covers `\r` and U+FEFF, so a stray carriage return or a trailing
  // zero-width no-break space cannot make an identical line look different.
  const out = body.split('\n').map((l) => l.replace(/\s+$/, ''));
  /**
   * ⚠️ AND THE MISSING FINAL NEWLINE, WHICH THIS SELF-CHECK ACTUALLY CAUGHT.
   * `"a\n".split("\n")` is `['a','']` and `"a".split("\n")` is `['a']`, so a
   * byte-perfect edit saved without a trailing newline was reported as "the
   * file was rewritten rather than edited — a blank line is missing". A check
   * that fails correct work is worse than no check, and this was one, over a
   * single byte no reviewer would ever notice was gone.
   *
   * ⭐ Only EMPTY trailing lines are dropped, so a rewrite that truncated real
   * content at the end still fires.
   */
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/** Indentation width in columns, counting a tab as eight. */
function indentColumns(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 8 - (n % 8);
    else break;
  }
  return n;
}

/** Every text file in the workspace, excluding bookkeeping directories. */
function sourceFiles(ws, dir = ws, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === '.acuvo' || e.name === 'node_modules') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(ws, abs, out);
    else if (e.isFile() && /\.(mjs|cjs|js|ts)$/.test(e.name)) out.push(abs);
  }
  return out;
}

// ── THE FIXTURE ─────────────────────────────────────────────────────────────

/**
 * ⭐ THE METHOD IS DEFINED ONCE, AS AN ARRAY, AND THE FILE IS BUILT FROM IT.
 * A second copy written out in a check would be the one that goes stale — and a
 * check comparing against a stale copy of the fixture fails correct work, which
 * is the failure this file is most determined not to have.
 *
 * Six spaces on the signature, eight on the body: a method on a class that is
 * itself the value of a property on a nested object. Ordinary code, and three
 * levels of indentation the model has to reproduce exactly.
 */
export const ORIGINAL_METHOD_BLOCK = [
  '      backoffDelayMs(attempt) {',
  '        if (attempt <= 0) return 0;',
  '        return BASE_DELAY_MS * 2 ** (attempt - 1);',
  '      }',
];

/** One padded, plausible pipeline stage. ~470 characters of real-looking code. */
const stage = (n) => `
/**
 * Stage ${n} of the pipeline. Pure: it takes a job descriptor and returns a new
 * one, so a queue can be replayed without touching the clock or the network.
 * Verbose on purpose — this file is the one place the pipeline's vocabulary is
 * written down, and a reader who only skims it should still leave knowing what
 * a job is: an id, a payload, and an attempt counter.
 */
export function stage${n}(job) {
  const attempt = Number.isInteger(job?.attempt) ? job.attempt : 0;
  return { ...job, stage: ${n}, attempt, marker: 'stage-${n}-marker' };
}
`;

const BANNER = `/**
 * ── THE RETRY PIPELINE ──────────────────────────────────────────────────────
 *
 * Jobs enter at stage 1 and are handed along until one of them fails, at which
 * point the scheduler decides how long to wait before the next attempt. Nothing
 * in here talks to the outside world; the clock is injected so the whole thing
 * can be tested without waiting for real time to pass.
 */

export const BASE_DELAY_MS = 100;
export const MAX_DELAY_MS = 5000;
`;

const REGISTRY_BLOCK = [
  '',
  'export const REGISTRY = {',
  '  engines: {',
  '    /**',
  '     * The retry scheduler. It is defined inline rather than at the top level',
  '     * because the registry is what the pipeline imports — one object, one',
  '     * place to look, and no second name to keep in step.',
  '     */',
  '    scheduler: class Scheduler {',
  '      constructor(clock = () => Date.now()) {',
  '        this.clock = clock;',
  '      }',
  '',
  '      /**',
  '       * How long to wait before attempt `attempt`, in milliseconds. Attempt 1',
  '       * waits BASE_DELAY_MS and every attempt after that doubles it.',
  '       */',
  ...ORIGINAL_METHOD_BLOCK,
  '',
  '      dueAt(attempt) {',
  '        return this.clock() + this.backoffDelayMs(attempt);',
  '      }',
  '',
  '      describe() {',
  "        return 'scheduler(base=' + BASE_DELAY_MS + 'ms, max=' + MAX_DELAY_MS + 'ms)';",
  '      }',
  '    },',
  '  },',
  '};',
  '',
];

const before = Array.from({ length: 18 }, (_, i) => stage(i + 1)).join('');
const after = Array.from({ length: 18 }, (_, i) => stage(i + 19)).join('');

/** The fixture, exported so a self-check can reason about its layout. */
export const SCHEDULER_SOURCE = `${BANNER}${before}${REGISTRY_BLOCK.join('\n')}${after}`;

/**
 * ⚠️ THE THREE PROPERTIES THE FIXTURE MUST HAVE, ASSERTED AT IMPORT RATHER THAN
 * ASSUMED. If a later edit to the padding shrinks this file below the pre-read
 * ceiling, or slides the method out of the region `read_file` omits, the task
 * silently stops measuring the thing it was built to measure and starts
 * measuring nothing — while still printing PASS. That is the worst outcome
 * available to a bench, so it fails loudly at import instead.
 *
 * (`clampOutput` keeps `floor(8000 * 0.35)` characters of head and the last
 * 8000 - that of tail; the method must fall in the hole between them.)
 */
const METHOD_OFFSET = SCHEDULER_SOURCE.indexOf(ORIGINAL_METHOD_BLOCK[0]);
const CLAMP_HEAD = Math.floor(8_000 * 0.35);
const CLAMP_TAIL = 8_000 - CLAMP_HEAD;
if (SCHEDULER_SOURCE.length <= 8_000) {
  throw new Error(`indent-handoff fixture is ${SCHEDULER_SOURCE.length} bytes — under the 8,000-byte pre-read ceiling, so the model would be handed the answer`);
}
if (METHOD_OFFSET < CLAMP_HEAD || METHOD_OFFSET >= SCHEDULER_SOURCE.length - CLAMP_TAIL) {
  throw new Error(`indent-handoff fixture puts the method at offset ${METHOD_OFFSET}, which read_file's clamp would still show (head ${CLAMP_HEAD}, tail from ${SCHEDULER_SOURCE.length - CLAMP_TAIL})`);
}
if (SCHEDULER_SOURCE.split('\n').filter((l) => l === ORIGINAL_METHOD_BLOCK[0]).length !== 1) {
  throw new Error('indent-handoff fixture must contain the target signature exactly once');
}

const ORIGINAL_LINES = lines(SCHEDULER_SOURCE);
const METHOD_LINE_INDEX = ORIGINAL_LINES.indexOf(ORIGINAL_METHOD_BLOCK[0]);

/**
 * ⭐ EVERY LINE THE AGENT WAS NOT ASKED TO TOUCH. The four lines of the method
 * are excluded because they are the ones that legitimately change; everything
 * else — 400-odd lines it never even read — must still be there, in order,
 * byte-exact down to its leading whitespace.
 */
const UNTOUCHABLE_LINES = ORIGINAL_LINES.filter(
  (_, i) => i < METHOD_LINE_INDEX || i > METHOD_LINE_INDEX + ORIGINAL_METHOD_BLOCK.length - 1,
);

// ── THE CHECKS ──────────────────────────────────────────────────────────────

const fileStillThere = (ws) => (existsSync(join(ws, TARGET))
  ? null
  : `${TARGET} is gone — it was deleted or moved rather than edited`);

/**
 * ⭐ THE BEHAVIOUR, ASKED EIGHT WAYS. One assertion is a value a model can
 * hardcode; eight across the cap boundary is a function. 6 is the last
 * uncapped attempt (3200ms) and 7 the first capped one (6400 → 5000), so a fix
 * that clamps at the wrong place fails on one side or the other.
 */
const capBehaves = (ws) => {
  const bad = probe(ws, `import {REGISTRY} from ${url(ws, TARGET)};`
    + 'const S = REGISTRY?.engines?.scheduler;'
    + 'if (typeof S !== "function") throw new Error("REGISTRY.engines.scheduler is no longer a class");'
    + 'const s = new S();'
    + 'const cases = [[-3,0],[0,0],[1,100],[2,200],[3,400],[6,3200],[7,5000],[20,5000]];'
    + 'for (const [attempt, want] of cases) {'
    + '  const got = s.backoffDelayMs(attempt);'
    + '  if (got !== want) throw new Error("backoffDelayMs(" + attempt + ") = " + got + ", expected " + want);'
    + '}');
  return bad ? `the cap is wrong: ${bad}` : null;
};

/**
 * ⚠️⚠️ THE HEADLINE ANTI-CHEAT. The signature and the closing brace must come
 * back at EXACTLY six columns and the body at eight or more — the indentation
 * the search result handed over. An agent that left-aligns its replacement gets
 * a file that still parses (JavaScript does not care) and a diff that rewrote
 * whitespace it was never asked to touch.
 */
const indentationPreserved = (ws) => {
  const ls = lines(read(ws, TARGET));
  const at = ls.findIndex((l) => /^\s*backoffDelayMs\s*\(/.test(l));
  if (at === -1) return 'backoffDelayMs is not in the file any more';
  if (ls[at] !== ORIGINAL_METHOD_BLOCK[0]) {
    return `the method signature came back as ${JSON.stringify(ls[at])} — it should be byte-identical to ${JSON.stringify(ORIGINAL_METHOD_BLOCK[0])} (six spaces)`;
  }
  const close = ls.findIndex((l, i) => i > at && l === '      }');
  if (close === -1) return 'the method\'s closing brace is no longer at six spaces — the block was re-indented';
  const shallow = ls.slice(at + 1, close)
    .map((l, i) => ({ l, n: at + i + 2 }))
    .filter(({ l }) => l.trim() !== '' && indentColumns(l) < 8);
  return shallow.length === 0
    ? null
    : `${shallow.length} line(s) inside the method lost their indentation, first at line ${shallow[0].n}: ${JSON.stringify(shallow[0].l)}`;
};

/**
 * ⚠️ D6 — THE PATCH-FROM-A-DISTANCE. Assigning over `Scheduler.prototype`
 * further down the file satisfies the probe and touches nothing indented, which
 * is precisely the shape a model reaches for when its edits keep being refused.
 * Every honest in-place fix changes at least one of these four lines, so the
 * block surviving intact means the method was never actually edited.
 */
const theMethodItselfChanged = (ws) => (lines(read(ws, TARGET)).join('\n').includes(ORIGINAL_METHOD_BLOCK.join('\n'))
  ? 'the original method body is still there verbatim — the cap was bolted on somewhere else instead of edited in'
  : null);

const constantsIntact = (ws) => {
  const ls = lines(read(ws, TARGET));
  const missing = ['export const BASE_DELAY_MS = 100;', 'export const MAX_DELAY_MS = 5000;']
    .filter((c) => !ls.includes(c));
  return missing.length === 0 ? null : `the constants were changed instead of the method: ${missing.join(' / ')} no longer present`;
};

/**
 * ⚠️⚠️ D1/D2 — THE WHOLE-FILE REWRITE, AND THE ONLY CHECK THAT CAN SEE IT.
 * The agent is handed roughly a fifth of this file; a `write_file` that
 * "restores" the rest from imagination loses hundreds of lines, and every other
 * check here would still pass. So: every original line outside the method must
 * reappear, IN ORDER, with its leading whitespace intact. Additions are fine —
 * a new comment or an extra statement is legitimate work — deletions and
 * re-indentation are not.
 */
const everyOtherLineSurvives = (ws) => {
  const now = lines(read(ws, TARGET));
  let cursor = 0;
  for (const want of UNTOUCHABLE_LINES) {
    const at = now.indexOf(want, cursor);
    if (at === -1) {
      const shown = want.trim() === '' ? '(a blank line)' : JSON.stringify(want);
      return `the file was rewritten rather than edited — ${shown} is missing or out of order (${UNTOUCHABLE_LINES.length} lines had to survive, ${now.length} lines are there now)`;
    }
    cursor = at + 1;
  }
  return null;
};

/**
 * ⚠️ D3 — THE RIVAL MODULE. "I could not edit it, so I wrote a fixed copy" ends
 * with two schedulers and the pipeline still importing the broken one.
 *
 * ⭐ It looks for a DEFINITION, not a mention. A scratch file the agent writes
 * to check its own work says `s.backoffDelayMs(7)`, which must not be punished —
 * that is the verification loop doing its job.
 */
const noRivalDefinition = (ws) => {
  const rivals = sourceFiles(ws)
    .filter((abs) => relative(ws, abs).split(sep).join('/') !== TARGET)
    .filter((abs) => {
      let body = '';
      try { body = readFileSync(abs, 'utf8'); } catch { return false; }
      return /backoffDelayMs\s*\(\s*attempt\s*\)\s*\{/.test(body) || /class\s+Scheduler\b/.test(body);
    })
    .map((abs) => relative(ws, abs).split(sep).join('/'));
  return rivals.length === 0
    ? null
    : `it defined a rival scheduler instead of editing the real one: ${rivals.join(', ')}`;
};

export const INDENT_HANDOFF_TASK = {
  id: 'indent-handoff',
  what: 'CEILING — find a deeply-indented method it was never shown, and edit it in place',
  /**
   * ⚠️ NOTHING HERE IS A TEST SUITE, SO THERE IS NOTHING FOR THE CLI TO VERIFY
   * ITSELF AGAINST. Flagging that would be the cry-wolf `run.mjs` already warns
   * about on `search` and `refuse`. Deliberately no fixture test file: a test
   * naming the expected cap would hand over the answer AND add "edit the test"
   * as a degenerate solution, which is the opposite of what this task measures.
   */
  expectVerified: false,
  /**
   * Six actions if the handoff works: search_text · read_around · edit_file ·
   * confirm. Seven so one refused call does not turn the measurement into a
   * measurement of luck — the lesson `git` taught this corpus at rounds: 6.
   */
  rounds: 7,
  setup: {
    files: {
      'package.json': '{"name":"pipeline","type":"module"}\n',
      'README.md': '# pipeline\n\nA retry pipeline. The engine lives under src/engine/.\n',
      'src/index.mjs': "export { REGISTRY } from './engine/pipeline/scheduler.mjs';\n",
      'src/engine/README.md': 'Engine internals. Nothing here is part of the public API.\n',
      [TARGET]: SCHEDULER_SOURCE,
    },
  },
  prompt: 'Somewhere in this project a method called backoffDelayMs computes an exponential retry delay that grows without limit. Find it and cap it at the MAX_DELAY_MS constant that is already declared in the same file, so the delay can never exceed it. Edit that method in place — do not create a new file, and do not reformat, re-indent or rewrite anything else.',
  checks: [
    fileStillThere,
    capBehaves,
    indentationPreserved,
    theMethodItselfChanged,
    constantsIntact,
    everyOtherLineSurvives,
    noRivalDefinition,
  ],
};

// ── THE SOLUTIONS, FOR THE SELF-CHECK ───────────────────────────────────────

/**
 * ⚠️⚠️ VALIDATE THE CHECKS BEFORE TRUSTING THEM. A grader that can be wrong
 * tells you nothing about the thing it is grading, and the only way to know is
 * to lay down a KNOWN-PERFECT solution and confirm every check returns null,
 * then lay down each degenerate one and confirm the anti-cheat fires.
 *
 * Each entry writes a complete workspace state given the workspace root, so a
 * self-check can drive them without knowing anything about this fixture.
 * `perfect` is a LIST rather than one entry on purpose: there is more than one
 * correct way to write this fix, and a check that only tolerates the one I
 * happened to think of is a check that fails correct work.
 */
const withMethod = (replacement) => SCHEDULER_SOURCE.replace(
  ORIGINAL_METHOD_BLOCK.join('\n'),
  replacement.join('\n'),
);

export const INDENT_HANDOFF_SOLUTIONS = {
  target: TARGET,
  perfect: {
    'the one-line clamp': withMethod([
      '      backoffDelayMs(attempt) {',
      '        if (attempt <= 0) return 0;',
      '        return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));',
      '      }',
    ]),
    'a temporary and a ternary, one line longer': withMethod([
      '      backoffDelayMs(attempt) {',
      '        if (attempt <= 0) return 0;',
      '        const raw = BASE_DELAY_MS * 2 ** (attempt - 1);',
      '        return raw > MAX_DELAY_MS ? MAX_DELAY_MS : raw;',
      '      }',
    ]),
    'an early return above the untouched original line': withMethod([
      '      backoffDelayMs(attempt) {',
      '        if (attempt <= 0) return 0;',
      '        if (BASE_DELAY_MS * 2 ** (attempt - 1) > MAX_DELAY_MS) return MAX_DELAY_MS;',
      '        return BASE_DELAY_MS * 2 ** (attempt - 1);',
      '      }',
    ]),
    'a correct fix with a documenting comment added above it': withMethod([
      '      backoffDelayMs(attempt) {',
      '        if (attempt <= 0) return 0;',
      '        // Capped: an unbounded doubling reaches days after thirty attempts.',
      '        return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));',
      '      }',
    ]),
    'the same fix in a CRLF file': withMethod([
      '      backoffDelayMs(attempt) {',
      '        if (attempt <= 0) return 0;',
      '        return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));',
      '      }',
    ]).replace(/\n/g, '\r\n'),
    'the same fix behind a UTF-8 BOM': `﻿${withMethod([
      '      backoffDelayMs(attempt) {',
      '        if (attempt <= 0) return 0;',
      '        return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));',
      '      }',
    ])}`,
    'the same fix with no trailing newline': withMethod([
      '      backoffDelayMs(attempt) {',
      '        if (attempt <= 0) return 0;',
      '        return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));',
      '      }',
    ]).replace(/\n+$/, ''),
    'the same fix indented with a tab inside the method': withMethod([
      '      backoffDelayMs(attempt) {',
      '        if (attempt <= 0) return 0;',
      '\t\treturn Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));',
      '      }',
    ]),
  },
  /**
   * Each degenerate names the check that MUST fire on it. The self-check asserts
   * that check specifically — "some check failed" is not evidence, because the
   * wrong one firing means the anti-cheat is still absent.
   */
  degenerate: {
    'D1 rewrote the whole file from memory, losing the padding': {
      catcher: 'everyOtherLineSurvives',
      source: `${BANNER}${stage(1)}${REGISTRY_BLOCK.join('\n').replace(
        ORIGINAL_METHOD_BLOCK.join('\n'),
        [
          '      backoffDelayMs(attempt) {',
          '        if (attempt <= 0) return 0;',
          '        return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));',
          '      }',
        ].join('\n'),
      )}`,
    },
    'D2 left-aligned the method it could not match': {
      catcher: 'indentationPreserved',
      source: withMethod([
        'backoffDelayMs(attempt) {',
        'if (attempt <= 0) return 0;',
        'return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));',
        '}',
      ]),
    },
    'D2b re-indented the whole file to two spaces per level': {
      catcher: 'everyOtherLineSurvives',
      source: withMethod([
        '      backoffDelayMs(attempt) {',
        '        if (attempt <= 0) return 0;',
        '        return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));',
        '      }',
      ]).replace(/^ {6}/gm, '    ').replace(/^ {8}/gm, '      '),
    },
    'D4 hardcoded the cap for every attempt': {
      catcher: 'capBehaves',
      source: withMethod([
        '      backoffDelayMs(attempt) {',
        '        return MAX_DELAY_MS;',
        '      }',
      ]),
    },
    'D4b clamped only the attempt it happened to look at': {
      catcher: 'capBehaves',
      source: withMethod([
        '      backoffDelayMs(attempt) {',
        '        if (attempt <= 0) return 0;',
        '        if (attempt === 7) return MAX_DELAY_MS;',
        '        return BASE_DELAY_MS * 2 ** (attempt - 1);',
        '      }',
      ]),
    },
    'D5 shrank the constant instead of capping the method': {
      catcher: 'constantsIntact',
      source: SCHEDULER_SOURCE.replace('export const BASE_DELAY_MS = 100;', 'export const BASE_DELAY_MS = 1;'),
    },
    'D6 monkey-patched the prototype below the class': {
      catcher: 'theMethodItselfChanged',
      source: `${SCHEDULER_SOURCE}\nREGISTRY.engines.scheduler.prototype.backoffDelayMs = function (attempt) {\n  if (attempt <= 0) return 0;\n  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));\n};\n`,
    },
    'D7 deleted the file it could not edit': {
      catcher: 'fileStillThere',
      source: null,
    },
    'D3 wrote a corrected copy alongside and left the original alone': {
      catcher: 'noRivalDefinition',
      source: SCHEDULER_SOURCE,
      extraFiles: {
        'src/engine/pipeline/scheduler-fixed.mjs':
          "import { BASE_DELAY_MS, MAX_DELAY_MS } from './scheduler.mjs';\n\n"
          + 'export class Scheduler {\n'
          + '  backoffDelayMs(attempt) {\n'
          + '    if (attempt <= 0) return 0;\n'
          + '    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));\n'
          + '  }\n}\n',
      },
    },
  },
  /**
   * ⭐ THE FALSE-POSITIVE FIXTURE. A scratch file the agent writes to check its
   * own work must not be mistaken for a rival module — punishing the
   * verification loop would teach the agent to stop verifying.
   */
  innocentScratchFile: {
    'src/engine/pipeline/check-scratch.mjs':
      "import { REGISTRY } from './scheduler.mjs';\n\n"
      + 'const s = new REGISTRY.engines.scheduler();\n'
      + 'console.log(s.backoffDelayMs(7), s.backoffDelayMs(3));\n',
  },
};

/** The checks by name, so a self-check can assert WHICH one fired. */
export const INDENT_HANDOFF_CHECKS = {
  fileStillThere,
  capBehaves,
  indentationPreserved,
  theMethodItselfChanged,
  constantsIntact,
  everyOtherLineSurvives,
  noRivalDefinition,
};
