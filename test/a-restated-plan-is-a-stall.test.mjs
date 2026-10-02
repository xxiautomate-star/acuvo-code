/**
 * ── ⭐⭐⭐ THE LOOP THAT COST A REAL RUN ITS ENTIRE ANSWER ────────────────────
 *
 * Roman ran `acuvo` against a directory on 2026-09-21 and watched it spend all
 * 24 rounds, 1.38M tokens and $0.025 reading files — then die on the round cap
 * having written no report at all. His words: *"it barely even works."*
 *
 * The transcript's own evidence: rounds 14, 15, 16, 17 and again 21, 22, 23 all
 * opened with the BYTE-IDENTICAL sentence
 *
 *     "Let me check the remaining docs and the current state of the app to
 *      complete the picture."
 *
 * ⚠️⚠️ AND NOT ONE WATCHER FIRED — every one of them correctly. `roundSignature`
 * is `name(args)`; the model read three DIFFERENT files every round, so every
 * signature was unique and `findLongCycle` saw no cycle. The universe was wrong,
 * not the assertion (`a_guards_universe_matters_as_much_as_its_assertion`).
 *
 * These tests are built from that transcript rather than an invented fixture,
 * so a regression here is a regression against the run that actually happened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectStuck, nudgeMessage, findRestatedPlan, normalisePlanText,
  STUCK_PATTERNS, RESTATED_PLAN_REPEATS, RESTATED_PLAN_MIN_CHARS,
} from '../lib/stuck.mjs';

/** The real sentence, verbatim from the transcript. */
const SENTENCE = 'Let me check the remaining docs and the current state of the app to complete the picture.';

/** A round that reads three DIFFERENT files — which is why the tool watchers stayed silent. */
function readingRound(round, files, note = SENTENCE) {
  return {
    round,
    note,
    executed: files.map((path) => ({ name: 'read_file', args: { path }, result: { bytes: 1024 }, mutated: false })),
  };
}

test('the real transcript: four identical sentences over unique reads is caught', () => {
  const rounds = [
    readingRound(13, ['acuvo/MESS_AUDIT.md', 'acuvo/NIGHT_BUILD.md'], 'There is a major pivot documented. Let me check the remaining docs.'),
    readingRound(14, ['acuvo/COLLAB.md', 'acuvo/COMMANDER_BRIEF.md', 'acuvo/COWORK_PROMPT.md']),
    readingRound(15, ['acuvo/BOOTSTRAP.md', 'acuvo/DATA_STRATEGY.md', 'acuvo/SOURCES_INBOX.md']),
    readingRound(16, ['acuvo/ASSEMBLY_MAP.md', 'acuvo/COWORK_FIREHOSE.md', 'acuvo/_LEGACY.md']),
  ];

  const hit = findRestatedPlan(rounds);
  assert.ok(hit, 'the stall the real run died of must be detected');
  assert.equal(hit.pattern, 'restated-plan');
  assert.equal(hit.evidence.count, RESTATED_PLAN_REPEATS);
  assert.deepEqual(hit.evidence.rounds, [14, 15, 16]);
});

test('it fires at round 16, saving the eight rounds the real run wasted', () => {
  // The real run went to 24. Detection on the third restatement ends it at 16.
  const rounds = [];
  for (let r = 14; r <= 24; r += 1) rounds.push(readingRound(r, [`f${r}a.md`, `f${r}b.md`, `f${r}c.md`]));
  const hit = findRestatedPlan(rounds);
  assert.ok(hit);
  assert.equal(hit.evidence.rounds.at(-1), 16, 'must fire on the third restatement, not the last round');
});

test('the tool-call watchers genuinely could not see it — the reads are all unique', () => {
  const rounds = [
    readingRound(14, ['a.md', 'b.md', 'c.md']),
    readingRound(15, ['d.md', 'e.md', 'f.md']),
    readingRound(16, ['g.md', 'h.md', 'i.md']),
  ];
  const sigs = new Set(rounds.map((r) => r.executed.map((e) => `${e.name}(${JSON.stringify(e.args)})`).join('|')));
  assert.equal(sigs.size, 3, 'every round signature is distinct — this is why long-cycle was blind');
  assert.ok(findRestatedPlan(rounds), 'and this detector still catches it');
});

test('⚠️ a round that WROTE something resets it — narrating badly while working is not a stall', () => {
  const rounds = [
    readingRound(14, ['a.md']),
    { round: 15, note: SENTENCE, executed: [{ name: 'write_file', args: { path: 'src/app.js' }, result: {}, mutated: true }] },
    readingRound(16, ['b.md']),
  ];
  assert.equal(findRestatedPlan(rounds), null, 'work in progress must never be stopped for repeating a sentence');
});

test('two restatements is a thought being finished, not a stall', () => {
  const rounds = [readingRound(14, ['a.md']), readingRound(15, ['b.md'])];
  assert.equal(findRestatedPlan(rounds), null);
});

test('short narration is exempt — "Reading." repeating is not a loop', () => {
  const short = 'Reading.';
  assert.ok(short.length < RESTATED_PLAN_MIN_CHARS);
  const rounds = [1, 2, 3, 4].map((r) => readingRound(r, [`f${r}.md`], short));
  assert.equal(findRestatedPlan(rounds), null);
});

test('intent is compared, not bytes: the transcript varied "…" and "." between rounds', () => {
  const a = normalisePlanText('Let me check the remaining docs and the current state of the app to complete the…');
  const b = normalisePlanText('Let me check the remaining docs and the current state of the app to complete the.');
  const c = normalisePlanText('  LET ME check the remaining   docs and the current state of the app to complete the  ');
  assert.equal(a, b);
  assert.equal(b, c, 'case and whitespace must not hide a restatement');
});

test('a model that actually changes its plan each round is never flagged', () => {
  const rounds = [
    readingRound(14, ['a.md'], 'Mapping the directory structure before reading anything in depth.'),
    readingRound(15, ['b.md'], 'The engine is the interesting part — reading model.ts and evaluate.ts now.'),
    readingRound(16, ['c.md'], 'One pivot doc contradicts the README. Checking which is newer.'),
    readingRound(17, ['d.md'], 'Enough to answer. Writing the summary.'),
  ];
  assert.equal(findRestatedPlan(rounds), null);
});

test('it reaches detectStuck, is a registered pattern, and produces a usable nudge', () => {
  const rounds = [14, 15, 16].map((r) => readingRound(r, [`f${r}a.md`, `f${r}b.md`]));
  const result = detectStuck(rounds);

  assert.equal(result.stuck, true);
  assert.equal(result.pattern, 'restated-plan');
  assert.ok(STUCK_PATTERNS.includes('restated-plan'), 'must be a declared pattern, not an ad-hoc string');

  const msg = nudgeMessage(result);
  assert.ok(msg, 'a detected stall with no message would be a silent intervention');
  assert.match(msg, /loop watcher/i, 'the nudge must announce itself as machinery, not as the user');
  assert.match(result.suggestion, /produce the deliverable/i,
    'the whole point: the real run died with no report, so the hint must say to write one');
  assert.match(result.suggestion, /round budget is finite/i,
    'and it must name the round cap, which is what actually killed that run');
});

test('the evidence quotes the sentence back, so the user can see what it saw', () => {
  const rounds = [14, 15, 16].map((r) => readingRound(r, [`f${r}.md`]));
  const hit = findRestatedPlan(rounds);
  assert.match(hit.evidence.sentence, /complete the picture/);
  assert.ok(hit.evidence.sentence.length <= 160, 'evidence must stay short enough to print');
});

test('empty, malformed and missing-note rounds do not throw', () => {
  assert.equal(findRestatedPlan(null), null);
  assert.equal(findRestatedPlan([]), null);
  assert.equal(findRestatedPlan([{}, {}, {}]), null);
  assert.equal(findRestatedPlan([{ note: null }, { note: 42 }, { note: {} }]), null);
  assert.equal(normalisePlanText(undefined), '');
});
