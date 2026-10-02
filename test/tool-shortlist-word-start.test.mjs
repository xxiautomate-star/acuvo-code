/**
 * A shortlist group word must START a word. See `wordStarts` in
 * lib/tool-shortlist.mjs — found by a real run on a cloned repo, where `ci`
 * inside "dependencies" lit `vcs` and the model committed unasked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupsForTask, wordStarts } from '../lib/tool-shortlist.mjs';

test('a word hidden inside another word lights nothing', () => {
  const real = 'Add two tokens to this formatter, add tape tests, and install the dev dependencies so npm test passes.';
  assert.ok(!groupsForTask(real).includes('vcs'), '`ci` inside "dependencies" must not offer git_commit');
  assert.ok(!groupsForTask('fix the invoice total').includes('media'), '`voice` inside "invoice"');
  assert.ok(!groupsForTask('the snake grows when it eats; arrow keys steer').includes('db'), '`row` inside "grows"/"arrow"');
  assert.ok(!groupsForTask('raise the RETRY_LIMIT to 5').includes('repl'), '`try` inside "retry"');
  assert.ok(!groupsForTask('write a short report of what changed').includes('process'), '`port` inside "report"');
});

test('a real word still lights its group, suffixes included', () => {
  assert.ok(groupsForTask('commit this when you are done').includes('vcs'));
  assert.ok(groupsForTask('split it into two commits').includes('vcs'));
  assert.ok(groupsForTask('open a PR for it').includes('vcs'));
  assert.ok(groupsForTask('do it in isolation from main').includes('vcs'), 'prefix word `isolat`');
  assert.ok(groupsForTask('start the dev server on port 3000').includes('process'));
});

test('a word that starts with punctuation keeps matching after a name', () => {
  assert.equal(wordStarts('why does loader.dll crash', '.dll'), true);
  assert.equal(wordStarts('dependencies', 'ci'), false);
  assert.equal(wordStarts('ci is red', 'ci'), true);
});

test('a two-letter word must be the whole word; a deck lights make_document', () => {
  const deck = groupsForTask('Make a 6-slide deck and save it as deck.pptx. Prove the .pptx has 6 slides.');
  assert.ok(!deck.includes('vcs'), '`pr` must not match "Prove"');
  assert.ok(deck.includes('docs'), 'a deck is a document: make_document turns HTML into PPTX');
  assert.ok(groupsForTask('open a PR and check CI').includes('vcs'));
  assert.ok(groupsForTask('review my open PRs').includes('vcs'));
  assert.ok(!groupsForTask('print the product price for each city').includes('vcs'));
  assert.ok(!groupsForTask('add a volume slider').includes('docs'), 'a UI slider is not a deck');
});
