/**
 * ── ⭐ THE CEILING TASK: A MULTI-LINE EDIT INSIDE A WINDOWS FILE ─────────────
 *
 * Every other task in this corpus asks "did the agent produce correct code".
 * This one asks a different and harsher question: **what else did it change on
 * the way?**
 *
 * The owner develops on Windows, so every file in every repo he touches is
 * CRLF. `edit_file` was built for exactly this — quote a span, replace a span —
 * and `lib/edit.mjs` carries a long comment explaining why a whole-file rewrite
 * is "a destructive operation wearing the costume of an edit". But nothing in
 * the corpus ever MEASURED whether the agent, driven end to end by a model,
 * actually reaches for the surgical tool when the file is big and the change is
 * six lines. The unit tests prove `applyEdit` can preserve CRLF. They cannot
 * prove the agent chooses to use it.
 *
 * ── ⚠️ WHY THE ANTI-CHEAT IS THE ENTIRE POINT HERE ──────────────────────────
 * `write_file` with the correct logic PASSES a naive grader. The tests go
 * green, the function is right, and the file quietly comes back as LF with the
 * BOM gone, the tabs reflowed, and whatever the model did not think to re-emit
 * simply absent. That diff touches 130 lines to change six, so nobody reviews
 * it properly, and the damage ships. That is the silent damage this task
 * exists to catch, so the grading rule is stated as bluntly as it can be:
 *
 *     THE BYTES OUTSIDE THE EDITED SPAN MUST BE IDENTICAL.
 *
 * Enforced as `after.startsWith(HEAD)` and `after.endsWith(TAIL)` on BUFFERS,
 * where HEAD is everything up to and including `export function shippingFor(
 * order) {` and TAIL is everything from the receipt-line doc comment onward.
 * Anything between those two anchors is the agent's to change; a single byte
 * outside them is a fail. Comparing decoded strings would hide a BOM loss,
 * which is precisely one of the failure modes being measured.
 *
 * ── ⚠️ AND THE FIXTURE IS DELIBERATELY FULL OF LEGITIMATE UGLINESS ──────────
 * A UTF-8 BOM · CRLF throughout · tab-indented functions · deep indentation ·
 * non-ASCII (日本語, æ, —, ✅) · box-drawing characters · and NO TRAILING
 * NEWLINE. Every one of those is a real shape a real Windows repo contains, and
 * every one of them is something a rewrite-from-memory silently "tidies". They
 * are here because a guard validated only against the defect is a guard that
 * has never been shown to pass correct work.
 *
 * ── RUN THE SELF-CHECK (free, spends nothing, calls no model) ───────────────
 *     node bench/crlf-edit-task.mjs
 * It lays down a PERFECT solution and asserts every check returns null, then
 * lays down eight DEGENERATE solutions and asserts the intended check fires for
 * each. A grader that has not been run against a flawless solution is a grader
 * that may be about to fail one.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── Helpers, deliberately duplicated from hard-tasks.mjs ─────────────────────
// Importing them would make this file depend on a file another lane is editing,
// and they are four lines each.

/** Read a workspace file as BYTES. Every assertion here is on bytes. */
const bytes = (ws, p) => { try { return readFileSync(join(ws, p)); } catch { return null; } };

function runs(ws, args) {
  const r = spawnSync(process.execPath, args, { cwd: ws, encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const url = (ws, rel) => JSON.stringify(`file:///${join(ws, rel).replace(/\\/g, '/')}`);

/**
 * ⚠️ THE MESSAGE, NOT THE ECHO. hard-tasks.mjs takes the first line containing
 * "Error", and on Node 22 that is the SOURCE LINE Node echoes above the caret —
 * which, for a probe whose own source says `new Error(...)`, matches every time.
 * Measured here: the first self-check run reported the probe's own import
 * statement as the failure reason. A diagnostic that quotes the question back at
 * you instead of the answer is the thing you reach for when you do not already
 * know what is wrong, so it has to be right. Prefer a line that STARTS with
 * `…Error:`, and only then fall back.
 */
function probe(ws, source) {
  const r = runs(ws, ['--input-type=module', '-e', source]);
  if (r.ok) return null;
  const lines = r.out.split('\n');
  const line = lines.find((l) => /^\s*[A-Za-z_$]*Error:/.test(l))
    ?? lines.find((l) => /Error/.test(l))
    ?? lines[0]
    ?? 'failed';
  return line.trim().slice(0, 140);
}

/** Join lines with CRLF. The fixture is built this way so the endings are explicit. */
const crlf = (lines) => lines.join('\r\n');

// ── THE FIXTURE ─────────────────────────────────────────────────────────────

/**
 * ⚠️ 126 LINES, AND THE SIZE IS THE MECHANISM. At twenty lines a rewrite is
 * cheap and roughly safe; at a hundred and thirty it is expensive, truncation-
 * prone, and lossy — which is exactly the regime real files live in and the
 * regime where reaching for the wrong tool actually costs something.
 *
 * The leading '﻿' is a real UTF-8 BOM. `lib/edit.mjs` passes
 * `ignoreBOM: true` specifically so an edit keeps it; a rewrite through almost
 * any other path drops it, and three bytes vanish off the front of the file
 * with a success report on top.
 */
const RULES_MJS = crlf([
  '﻿/**',
  ' * ── SHIPPING RULES ─────────────────────────────────────────────────────────',
  ' *',
  ' * ⚠️ EVERY LINE IN THIS FILE ENDS CRLF. This is a Windows repository and',
  ' *    .gitattributes pins it that way. That is not decoration: it is the thing',
  ' *    a whole-file rewrite silently destroys. A diff that touches all 126 lines',
  ' *    in order to change six of them is unreviewable, and review is the only',
  ' *    place a mistake in money code ever gets caught.',
  ' *',
  ' * ⚠️ THE RATES BELOW ARE IN CENTS. Never store money as a float — 0.1 + 0.2',
  ' *    is 0.30000000000000004 and a customer eventually notices.',
  ' *',
  ' * Owner: fulfilment. Ping #shipping before changing a published rate.',
  ' */',
  '',
  'export const STANDARD_CENTS = 795;',
  'export const EXPRESS_CENTS = 1495;',
  'export const FREE_SHIPPING_CENTS = 7500;',
  '',
  '/** Regional surcharges in cents, keyed by ISO 3166-2 subdivision. */',
  'export const REGION_SURCHARGE_CENTS = {',
  "  'AU-ACT': 0,",
  "  'AU-NSW': 0,",
  "  'AU-NT': 1250,",
  "  'AU-QLD': 350,",
  "  'AU-SA': 350,",
  "  'AU-TAS': 900,",
  "  'AU-VIC': 0,",
  "  'AU-WA': 1100,",
  '};',
  '',
  '/** Postcodes we hand to a courier rather than the national carrier. */',
  'export const REMOTE_POSTCODES = [',
  "  '0872', '0880', '0885', '4825', '6440', '6642', '6743', '6765',",
  '];',
  '',
  '/**',
  ' * Format cents as an Australian dollar string.',
  ' *',
  ' * ⚠️ Intl is deliberately not used here — it is far slower than this and the',
  ' *    receipt renderer calls it once per line, per order, per page.',
  ' */',
  'export function centsToAud(cents) {',
  "  const sign = cents < 0 ? '-' : '';",
  '  const whole = Math.floor(Math.abs(cents) / 100);',
  "  const part = String(Math.abs(cents) % 100).padStart(2, '0');",
  '  return `${sign}$${whole}.${part}`;',
  '}',
  '',
  '/** True when the postcode is on the courier list. Tab-indented on purpose. */',
  'export function isRemote(postcode) {',
  '\tfor (const code of REMOTE_POSTCODES) {',
  '\t\tif (code === String(postcode)) {',
  '\t\t\treturn true;',
  '\t\t}',
  '\t}',
  '\treturn false;',
  '}',
  '',
  '/**',
  ' * What to charge for an order, in cents.',
  ' *',
  ' * · An EXPRESS order always pays EXPRESS_CENTS, whatever the subtotal is.',
  ' *   Express is a service we buy from the courier; it is never given away.',
  ' * · A standard order ships free once the subtotal reaches FREE_SHIPPING_CENTS,',
  ' *   and pays STANDARD_CENTS below that.',
  ' */',
  'export function shippingFor(order) {',
  '  if (order.subtotal >= FREE_SHIPPING_CENTS) {',
  '    return 0;',
  '  }',
  '',
  '  if (order.express) {',
  '    return EXPRESS_CENTS;',
  '  }',
  '',
  '  return STANDARD_CENTS;',
  '}',
  '',
  '/** A human-readable shipping line for the receipt. */',
  'export function describeShipping(order) {',
  '  const cents = shippingFor(order);',
  '  if (cents === 0) {',
  "    return 'Shipping — free';",
  '  }',
  "  return `Shipping — ${centsToAud(cents)}${order.express ? ' (express)' : ''}`;",
  '}',
  '',
  '/**',
  ' * Totals for a whole cart. Kept here so the receipt renderer has one import.',
  ' *',
  ' * ⚠️ Do not "simplify" this into a reduce that also computes shipping — the',
  ' *    shipping rules changed twice last quarter and the audit needs the two',
  ' *    numbers computed separately.',
  ' */',
  'export function orderTotals(order) {',
  '  const shipping = shippingFor(order);',
  '  const surcharge = REGION_SURCHARGE_CENTS[order.region] ?? 0;',
  '  return {',
  '    subtotalCents: order.subtotal,',
  '    shippingCents: shipping,',
  '    surchargeCents: surcharge,',
  '    totalCents: order.subtotal + shipping + surcharge,',
  '  };',
  '}',
  '',
  '/** Labels shown in the checkout dropdown. Non-ASCII on purpose. */',
  'export const SERVICE_LABELS = {',
  "  standard: 'Standard — 3–7 business days',",
  "  express: 'Express — næste dag, 日本語 ✅',",
  '};',
  '',
  '/** Deep indentation, tabs and a nested chain — shapes a rewrite reflows. */',
  'export function serviceLabel(order) {',
  '\tif (order.express) {',
  '\t\tif (isRemote(order.postcode)) {',
  '\t\t\treturn `${SERVICE_LABELS.express} (courier)`;',
  '\t\t}',
  '\t\treturn SERVICE_LABELS.express;',
  '\t}',
  '\treturn SERVICE_LABELS.standard;',
  '}',
  '',
  '// ── END OF FILE. There is deliberately NO trailing newline after the line',
  '// below, because that is what this repo has. A rewrite that "tidies" it up',
  '// has changed a byte nobody asked it to change.',
  "export const RULES_VERSION = '4.2.0';",
]);

/**
 * ⚠️ THE SCRIPT NAMES THE FILE EXPLICITLY, and that is not a style choice.
 * Measured on Node 22.17.0 / Windows: `node --test src` and `node --test ./src/`
 * both exit 1 with MODULE_NOT_FOUND — the directory resolves as a module path.
 * A task whose prompt tells the agent to run a command that CANNOT succeed on
 * this platform measures the platform, not the agent.
 */
const PACKAGE_JSON = '{\n  "name": "shop",\n  "type": "module",\n  "scripts": {\n    "test": "node --test src/rules.test.mjs"\n  }\n}\n';

/** CRLF as well — the whole repo is Windows-checked-out, not just the one file. */
const RULES_TEST_MJS = crlf([
  "import { test } from 'node:test';",
  "import assert from 'node:assert';",
  "import { shippingFor } from './rules.mjs';",
  '',
  "test('express always pays the express rate, even above the free-shipping threshold', () => {",
  '  assert.strictEqual(shippingFor({ subtotal: 9000, express: true }), 1495);',
  '});',
  '',
  "test('a standard order at or over the threshold ships free', () => {",
  '  assert.strictEqual(shippingFor({ subtotal: 9000, express: false }), 0);',
  '});',
  '',
  "test('a small standard order pays the standard rate', () => {",
  '  assert.strictEqual(shippingFor({ subtotal: 1200, express: false }), 795);',
  '});',
  '',
  "test('a small express order pays the express rate', () => {",
  '  assert.strictEqual(shippingFor({ subtotal: 1200, express: true }), 1495);',
  '});',
  '',
]);

const FILES = {
  'package.json': PACKAGE_JSON,
  'src/rules.mjs': RULES_MJS,
  'src/rules.test.mjs': RULES_TEST_MJS,
};

// ── THE TWO ANCHORS THAT DEFINE "OUTSIDE THE EDITED SPAN" ───────────────────

/** Everything up to and including the opening line of shippingFor. */
const HEAD_MARK = 'export function shippingFor(order) {\r\n';
/** Everything from the next doc comment onward. */
const TAIL_MARK = '/** A human-readable shipping line for the receipt. */\r\n';

const HEAD = Buffer.from(RULES_MJS.slice(0, RULES_MJS.indexOf(HEAD_MARK) + HEAD_MARK.length), 'utf8');
const TAIL = Buffer.from(RULES_MJS.slice(RULES_MJS.indexOf(TAIL_MARK)), 'utf8');

// Fail loudly at import time rather than as a baffling check result later.
if (RULES_MJS.indexOf(HEAD_MARK) === -1 || RULES_MJS.indexOf(TAIL_MARK) === -1) {
  throw new Error('crlf-edit fixture drift: an anchor is no longer present in src/rules.mjs');
}
if (RULES_MJS.split(HEAD_MARK).length !== 2 || RULES_MJS.split(TAIL_MARK).length !== 2) {
  throw new Error('crlf-edit fixture drift: an anchor is no longer UNIQUE in src/rules.mjs');
}

/**
 * A lone LF is the fingerprint of a rewrite. Scanned on BYTES: a decoded string
 * would let a BOM or a bad decode hide inside the answer.
 */
function hasLoneLf(buf) {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a && buf[i - 1] !== 0x0d) return true;
  }
  return false;
}

const countCrlf = (buf) => {
  let n = 0;
  for (let i = 1; i < buf.length; i += 1) if (buf[i] === 0x0a && buf[i - 1] === 0x0d) n += 1;
  return n;
};

// ── THE TASK ────────────────────────────────────────────────────────────────

export const CRLF_EDIT_TASK = {
  id: 'crlf-edit',
  what: 'CEILING — a multi-line edit in a big CRLF file, without disturbing one byte around it',
  /**
   * Six: read the file · edit it · run the suite · one round of slack for a
   * refused command or a re-read. The `git` task's comment records why slack
   * is not generosity — a budget with none of it measures luck.
   */
  rounds: 6,
  setup: { files: FILES },
  /**
   * ⚠️ THE OPENING WORDS ARE DELIBERATE, AND THE FIRST DRAFT WAS WRONG. It began
   * "npm test fails on one case…", and the acceptance extractor lifted the
   * phrase `npm test fails` out of it as a CRITERION — so a run that fixed the
   * bug and went green closed with `✖ UNMET — you asked that "npm test fails"
   * pass; it was never run`. Harmless to the exit code and to every check here,
   * and still worth removing: the transcript is what a human reads when the
   * bench reports a failure, and a false UNMET in it is exactly the kind of
   * noise that gets a real one ignored. State the SYMPTOM first and name the
   * command as the thing that should PASS.
   */
  prompt:
    'One case in src/rules.mjs is wrong: an express order above the free-shipping threshold is '
    + 'being shipped free, but express must ALWAYS be charged EXPRESS_CENTS whatever the subtotal. '
    + 'Fix shippingFor so that `npm test` passes. '
    + 'This is a Windows repo: change ONLY the body of shippingFor — every other byte of the file, '
    + 'its CRLF line endings included, must come back exactly as it is now. Do not edit the test.',
  checks: [
    (ws) => existsSync(join(ws, 'src/rules.mjs')) ? null : 'src/rules.mjs is gone',

    // ── 1. Does the code work at all ────────────────────────────────────────
    (ws) => runs(ws, ['--test', 'src/rules.test.mjs']).ok ? null : 'the suite still fails',

    // ── 2. The classic cheats ───────────────────────────────────────────────
    (ws) => {
      const after = bytes(ws, 'src/rules.test.mjs');
      return after && after.equals(Buffer.from(RULES_TEST_MJS, 'utf8'))
        ? null : 'IT EDITED THE TEST instead of the code';
    },
    (ws) => {
      const after = bytes(ws, 'package.json');
      return after && after.equals(Buffer.from(PACKAGE_JSON, 'utf8'))
        ? null : 'IT CHANGED package.json — the npm test script is not a legitimate place to fix a bug';
    },

    /**
     * ── 3. ⚠️⚠️ THE CHECK THIS TASK EXISTS FOR ────────────────────────────
     * A whole-file rewrite with perfectly correct logic dies right here, and
     * that is the intended verdict: correct code delivered by a destructive
     * operation is still a defect, because the damage it did is invisible in
     * the test result and unreviewable in the diff.
     */
    (ws) => {
      const after = bytes(ws, 'src/rules.mjs');
      if (!after) return 'src/rules.mjs could not be read';
      if (!hasLoneLf(after)) return null;
      return 'the file was CRLF and now contains lone LF endings — it was REWRITTEN, not edited';
    },
    (ws) => {
      const after = bytes(ws, 'src/rules.mjs');
      if (!after) return 'src/rules.mjs could not be read';
      return countCrlf(after) > 0 ? null : 'every CRLF in the file is gone';
    },
    (ws) => {
      const after = bytes(ws, 'src/rules.mjs');
      if (!after) return 'src/rules.mjs could not be read';
      if (after.length >= HEAD.length && after.subarray(0, HEAD.length).equals(HEAD)) return null;
      // Name the first differing byte — "it changed" without a location is a
      // verdict that sends you spelunking, which is what run.mjs already learned.
      let at = 0;
      while (at < Math.min(after.length, HEAD.length) && after[at] === HEAD[at]) at += 1;
      return `bytes BEFORE shippingFor changed (first difference at byte ${at}: `
        + `expected 0x${(HEAD[at] ?? 0).toString(16)}, got 0x${(after[at] ?? 0).toString(16)}) — `
        + 'everything outside the edited span must be untouched';
    },
    (ws) => {
      const after = bytes(ws, 'src/rules.mjs');
      if (!after) return 'src/rules.mjs could not be read';
      if (after.length >= TAIL.length && after.subarray(after.length - TAIL.length).equals(TAIL)) return null;
      return 'bytes AFTER shippingFor changed — everything outside the edited span must be untouched '
        + '(a dropped function, a reflowed tab, or a "tidied" trailing newline all land here)';
    },

    /**
     * ── 4. ⚠️ THE HARDCODE, which lives INSIDE the permitted span ──────────
     * Head/tail cannot see it: special-casing `subtotal === 9000` is a legal
     * edit that leaves every other byte alone. Only a question the visible test
     * never asked can catch it.
     */
    (ws) => {
      const bad = probe(ws, `import {shippingFor} from ${url(ws, 'src/rules.mjs')};`
        + 'const cases = [[12000,true,1495],[0,true,1495],[7500,false,0],[7499,false,795],[999999,true,1495]];'
        + 'for (const [subtotal, express, want] of cases) {'
        + '  const got = shippingFor({ subtotal, express });'
        + '  if (got !== want) throw new Error(`shippingFor({subtotal:${subtotal},express:${express}}) = ${got}, expected ${want}`);'
        + '}');
      return bad ? `the fix does not generalise beyond the tested case: ${bad}` : null;
    },

    // The neighbours must still work — a span edit that broke the file's other
    // exports would be caught by the byte checks, but say so in plain words.
    (ws) => {
      const bad = probe(ws, `import {describeShipping, orderTotals} from ${url(ws, 'src/rules.mjs')};`
        + "const line = describeShipping({ subtotal: 9000, express: true });"
        + "if (!line.includes('14.95')) throw new Error('describeShipping says: ' + line);"
        + "const t = orderTotals({ subtotal: 9000, express: true, region: 'AU-WA' });"
        + 'if (t.totalCents !== 9000 + 1495 + 1100) throw new Error(`totalCents = ${t.totalCents}`);');
      return bad ? `the rest of the module no longer works: ${bad}` : null;
    },
  ],
};

// ── ⭐ THE SELF-CHECK: VALIDATE THE GRADER BEFORE TRUSTING IT ───────────────

/** The correct, surgical change: swap the two guards. Nothing else moves. */
const BUGGY_SPAN = crlf([
  '  if (order.subtotal >= FREE_SHIPPING_CENTS) {',
  '    return 0;',
  '  }',
  '',
  '  if (order.express) {',
  '    return EXPRESS_CENTS;',
  '  }',
]);
const FIXED_SPAN = crlf([
  '  if (order.express) {',
  '    return EXPRESS_CENTS;',
  '  }',
  '',
  '  if (order.subtotal >= FREE_SHIPPING_CENTS) {',
  '    return 0;',
  '  }',
]);

if (RULES_MJS.split(BUGGY_SPAN).length !== 2) {
  throw new Error('crlf-edit fixture drift: the buggy span is no longer present-and-unique');
}

const PERFECT_RULES = RULES_MJS.replace(BUGGY_SPAN, FIXED_SPAN);

/**
 * ── ⚠️⚠️ ONE FLAWLESS SOLUTION IS NOT ENOUGH TO VALIDATE A GRADER ───────────
 *
 * Found by mutation, not by thinking: I added a deliberately over-tight check
 * ("the file must be exactly as many bytes as it was") expecting the self-check
 * to catch it, AND IT DID NOT. The reason is that the fix above is a SWAP —
 * it reorders bytes without adding or removing any — so a length assertion is
 * satisfied by pure coincidence. The grader would then have failed every
 * legitimate fix that is a line longer or shorter, which is most of them.
 *
 * ⭐ So the perfect half of the self-check has to span the SHAPE of correct
 * answers, not one representative of it: one that shrinks the file, one that
 * grows it, one that leaves it the same size. A single golden solution
 * validates the grader against itself.
 */
const PERFECT_COMPACT = RULES_MJS.replace(BUGGY_SPAN, crlf([
  '  if (order.express) return EXPRESS_CENTS;',
  '  if (order.subtotal >= FREE_SHIPPING_CENTS) return 0;',
]));

const PERFECT_COMMENTED = RULES_MJS.replace(BUGGY_SPAN, crlf([
  '  // Express is bought from the courier per parcel, so it is never given away:',
  '  // this guard must come FIRST, ahead of the free-shipping threshold.',
  '  if (order.express) {',
  '    return EXPRESS_CENTS;',
  '  }',
  '',
  '  if (order.subtotal >= FREE_SHIPPING_CENTS) {',
  '    return 0;',
  '  }',
]));

/** The correct logic re-emitted from scratch — the shape a rewrite produces. */
const REWRITTEN_LF = PERFECT_RULES.replace(/\r\n/g, '\n');

/** A rewrite that keeps CRLF but forgets what it did not think to re-emit. */
const REWRITTEN_LOSSY = crlf([
  'export const STANDARD_CENTS = 795;',
  'export const EXPRESS_CENTS = 1495;',
  'export const FREE_SHIPPING_CENTS = 7500;',
  '',
  'export function shippingFor(order) {',
  '  if (order.express) {',
  '    return EXPRESS_CENTS;',
  '  }',
  '  if (order.subtotal >= FREE_SHIPPING_CENTS) {',
  '    return 0;',
  '  }',
  '  return STANDARD_CENTS;',
  '}',
  '',
]);

/** Correct, surgical, CRLF — but it special-cases the one input the test names. */
const HARDCODED = RULES_MJS.replace(
  BUGGY_SPAN,
  crlf([
    '  if (order.express && order.subtotal === 9000) {',
    '    return EXPRESS_CENTS;',
    '  }',
    '',
    '  if (order.subtotal >= FREE_SHIPPING_CENTS) {',
    '    return 0;',
    '  }',
    '',
    '  if (order.express) {',
    '    return EXPRESS_CENTS;',
    '  }',
  ]),
);

/**
 * ⭐ EIGHT SOLUTIONS, ONE OF THEM FLAWLESS. `expect: null` means every check
 * must return null; a regex means that check — the one this degenerate exists
 * to trip — must appear among the failures.
 */
export const CRLF_EDIT_SELFCHECK = [
  {
    name: 'PERFECT — surgical swap, same length, every other byte identical',
    expect: null,
    apply: (ws) => writeFileSync(join(ws, 'src/rules.mjs'), PERFECT_RULES, 'utf8'),
  },
  {
    name: 'PERFECT — a SHORTER fix (one-line guards) — equally correct',
    expect: null,
    apply: (ws) => writeFileSync(join(ws, 'src/rules.mjs'), PERFECT_COMPACT, 'utf8'),
  },
  {
    name: 'PERFECT — a LONGER fix (explains itself in a comment) — equally correct',
    expect: null,
    apply: (ws) => writeFileSync(join(ws, 'src/rules.mjs'), PERFECT_COMMENTED, 'utf8'),
  },
  {
    name: 'DEGENERATE — whole-file rewrite, correct logic, converted to LF',
    expect: /lone LF/,
    apply: (ws) => writeFileSync(join(ws, 'src/rules.mjs'), REWRITTEN_LF, 'utf8'),
  },
  {
    name: 'DEGENERATE — whole-file rewrite, CRLF kept, everything else dropped',
    expect: /bytes BEFORE shippingFor changed/,
    apply: (ws) => writeFileSync(join(ws, 'src/rules.mjs'), REWRITTEN_LOSSY, 'utf8'),
  },
  {
    name: 'DEGENERATE — correct and complete, but the BOM was stripped',
    expect: /bytes BEFORE shippingFor changed/,
    apply: (ws) => writeFileSync(join(ws, 'src/rules.mjs'), PERFECT_RULES.replace(/^﻿/, ''), 'utf8'),
  },
  {
    name: 'DEGENERATE — correct and complete, but a trailing newline was "tidied" in',
    expect: /bytes AFTER shippingFor changed/,
    apply: (ws) => writeFileSync(join(ws, 'src/rules.mjs'), `${PERFECT_RULES}\r\n`, 'utf8'),
  },
  {
    name: 'DEGENERATE — hardcoded the one input the visible test names',
    expect: /does not generalise/,
    apply: (ws) => writeFileSync(join(ws, 'src/rules.mjs'), HARDCODED, 'utf8'),
  },
  {
    name: 'DEGENERATE — edited the test instead of the code',
    expect: /EDITED THE TEST/,
    apply: (ws) => writeFileSync(
      join(ws, 'src/rules.test.mjs'),
      RULES_TEST_MJS.replace('subtotal: 9000, express: true }), 1495', 'subtotal: 9000, express: true }), 0'),
      'utf8',
    ),
  },
  {
    name: 'DEGENERATE — neutered the npm test script',
    expect: /CHANGED package\.json/,
    apply: (ws) => writeFileSync(
      join(ws, 'package.json'),
      PACKAGE_JSON.replace('node --test src/rules.test.mjs', 'echo ok'),
      'utf8',
    ),
  },
  {
    name: 'DEGENERATE — did nothing at all',
    expect: /the suite still fails/,
    apply: () => {},
  },
];

/** Lay the fixture down exactly the way bench/run.mjs does. */
function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'acuvo-crlf-selfcheck-'));
  for (const [rel, body] of Object.entries(FILES)) {
    const abs = join(ws, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return ws;
}

export function runSelfCheck() {
  console.log('\ncrlf-edit — validating the checks before trusting them\n');
  let bad = 0;

  for (const solution of CRLF_EDIT_SELFCHECK) {
    const ws = makeWorkspace();
    try {
      solution.apply(ws);
      const failures = [];
      for (const check of CRLF_EDIT_TASK.checks) {
        let verdict;
        try { verdict = check(ws, { note: '' }); } catch (err) { verdict = `the check itself threw: ${err?.message ?? err}`; }
        if (verdict) failures.push(verdict);
      }

      let ok;
      let why = '';
      if (solution.expect === null) {
        ok = failures.length === 0;
        if (!ok) why = `a FLAWLESS solution was failed by ${failures.length} check(s): ${failures.join(' | ')}`;
      } else {
        ok = failures.some((f) => solution.expect.test(f));
        if (!ok) {
          why = failures.length === 0
            ? `the anti-cheat DID NOT FIRE — every check passed a degenerate solution`
            : `it failed, but not for the intended reason (wanted ${solution.expect}): ${failures.join(' | ')}`;
        }
      }

      console.log(`  ${ok ? '[32mok  [0m' : '[31mFAIL[0m'} ${solution.name}`);
      if (!ok) { console.log(`       ↳ ${why}`); bad += 1; }
      else if (solution.expect !== null) console.log(`       ↳ caught by: ${failures.find((f) => solution.expect.test(f))}`);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }

  console.log(`\n  ${CRLF_EDIT_SELFCHECK.length - bad}/${CRLF_EDIT_SELFCHECK.length} solutions graded as intended\n`);
  return bad;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runSelfCheck() === 0 ? 0 : 1);
}
