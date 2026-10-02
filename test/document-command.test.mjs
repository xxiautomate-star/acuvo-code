/**
 * ── ⭐⭐⭐ `acuvo document <page.html> <out.pdf>` — THE PRESS, FROM A SHELL ───
 *
 * ⚠️⚠️ WHY THIS IS A COMMAND AND NOT A BUILDER TOOL. `make_document` as a tool
 * in the console builder costs 527 bytes of schema plus a prompt line, against
 * SIXTEEN characters of headroom in a ceiling that is DERIVED (`oneShot / 3` in
 * `cost-levers-stay-on.test.ts`) and therefore cannot be ratcheted. The build VM
 * already has this binary on its PATH and a 45-minute `cli.run` key in
 * `ACUVO_TOKEN`, which `account.mjs` reads — so a model reaches the press
 * through `run_command` for zero schema bytes and zero prompt bytes.
 *
 * ⚠️ THE TWO TRAPS THIS FILE EXISTS TO HOLD SHUT, both already paid for in
 * `cli-args.mjs`:
 *
 *  1. **"document" IS ORDINARY ENGLISH.** `acuvo document the API` must stay a
 *     task. The shape is the guard — an HTML path as the second word is not
 *     something an instruction contains — exactly as `verify` guards on a run
 *     id rather than a list of English words.
 *  2. **A NEAR MISS MUST BE REFUSED, NOT RUN.** The `rewind` block records what
 *     the other answer costs: `acuvo --dir <ws> rewind` fell through as a task
 *     and spent a paid agent session doing nothing. Twice, measured, in money.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgv, KNOWN_COMMAND_WORDS } from '../lib/cli-args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = (argv) => { const r = parseArgv(argv); return r.ok === false ? r : r.options; };

test('⭐ the three shapes dispatch, and the format follows the output extension', () => {
  for (const [out, why] of [['report.pdf', 'pdf'], ['deck.pptx', 'pptx'], ['shot.png', 'png']]) {
    const o = opt(['document', 'page.html', out]);
    assert.equal(o.command, 'document', why);
    assert.deepEqual(o.documentArgs, ['page.html', out]);
    assert.equal(o.task, '', 'it also became a task, so it would run twice');
  }
  assert.equal(opt(['document', 'page.htm', 'p.pdf']).command, 'document', '.htm is html too');
});

/**
 * ⚠️⚠️ THE DEFECT `cli-args.mjs` RECORDS AGAINST ITS OWN OLDER COMMANDS:
 * `board`, `verify`, `leases` and `spend` anchor on `argv[0]`, so a flag in
 * front of them means they never dispatch and become a PAID task run. This one
 * anchors on `prompts[0]`, which is the fix `rewind` already carries.
 */
test('⭐⭐ a flag in front still dispatches — it is not born with the argv[0] bug', () => {
  const o = opt(['--dir', '/tmp/ws', 'document', 'page.html', 'out.pdf']);
  assert.equal(o.command, 'document');
  assert.deepEqual(o.documentArgs, ['page.html', 'out.pdf']);
});

test('⚠️⚠️ "document the API" is an instruction and stays one', () => {
  for (const argv of [
    ['document', 'the', 'API'],
    ['document the API for me'],
    ['document', 'this', 'function', 'properly'],
    ['document why the migration is ordered that way'],
  ]) {
    const o = opt(argv);
    assert.notEqual(o.command, 'document', `${JSON.stringify(argv)} was claimed as a command`);
    assert.ok(o.task.length > 0, `${JSON.stringify(argv)} became neither command nor task`);
  }
});

/**
 * ⚠️⚠️ A REFUSAL IS FREE; A TASK RUN IS NOT. Both of these are unmistakably
 * this command typed slightly wrong — an HTML file is named — so falling
 * through to a paid agent session is the one outcome that costs the user money
 * to render nothing.
 */
test('⚠️⚠️ a near miss is refused by name rather than charged for', () => {
  for (const argv of [
    ['document', 'page.html'],
    ['document', 'page.html', 'out.docx'],
    ['document', 'page.html', 'out.pdf', 'landscape'],
  ]) {
    const r = parseArgv(argv);
    assert.equal(r.ok, false, `${JSON.stringify(argv)} was not refused`);
    assert.match(r.error, /acuvo document <page\.html>/, 'the refusal does not show the working shape');
    assert.match(r.error, /\.pdf, \.png or \.pptx/);
  }
});

test('⚠️ and it is a known command word, so a mistyped invocation is diagnosed', () => {
  assert.ok(KNOWN_COMMAND_WORDS.includes('document'));
});

/**
 * ⭐⭐ THE OFFER MUST BE REACHABLE, which in this repo means NAMED. The prompt
 * rule the builder states about itself — *"the shortest path has to be named or
 * it is not taken"* — applies to a shell command nobody documents just as much
 * as to a verb nobody mentions.
 */
test('⭐⭐ --help names it, and the skill a model would open carries the command', () => {
  const args = readFileSync(join(HERE, '..', 'lib', 'cli-args.mjs'), 'utf8');
  assert.match(args, /acuvo document <page\.html> <out\.pdf\|png\|pptx>/, '--help does not name it');

  const skill = readFileSync(join(HERE, '..', 'skills', 'creative-engines.md'), 'utf8');
  assert.match(skill, /acuvo document report\.html report\.pdf/, 'the skill does not show the command');
  assert.match(skill, /make_document/, 'the skill does not list the verb');
  assert.match(skill, /ACUVO_TOKEN/, 'the skill does not say how it authenticates in a build machine');
});

/**
 * ⚠️ THE DISPATCH IS REAL, not just parsed. A command word that parses and then
 * falls through to the agent is the same paid-run defect from the other side,
 * and nothing above would notice it.
 */
test('⭐⭐⭐ bin/acuvo.mjs actually handles the command and returns a failure code', () => {
  const bin = readFileSync(join(HERE, '..', 'bin', 'acuvo.mjs'), 'utf8');
  assert.match(bin, /opts\.command === 'document'/, 'the parser claims a word nothing dispatches');
  const block = bin.slice(bin.indexOf("opts.command === 'document'"), bin.indexOf("opts.command === 'engines'"));
  assert.match(block, /makeDocument\(/, 'the dispatch does not reach the press');
  assert.match(block, /EXIT_FAILED/, 'a failed press would exit 0 and a script could not tell');
  assert.ok(!/console\.log\(/.test(block), 'output should go through process.stdout like its neighbours');
});
