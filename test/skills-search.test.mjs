/**
 * ⭐ `/skills search | show | use` and the shared need-ranking (`skill-search.mjs`).
 * The builder runs a byte-identical copy of the same ranking — see
 * `console/lib/find-a-skill-by-need.test.ts` for its side.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSlash, runSlashCommand } from '../lib/slash.mjs';
import { discoverAllSkills, loadAnySkill } from '../lib/builtin-skills.mjs';
import { searchSkills, confidentSkill, parseTriggers, parseAppliesTo, foldWord } from '../lib/skill-search.mjs';

const root = process.cwd();
const context = {
  skills: () => discoverAllSkills(root).skills,
  loadSkill: (name) => loadAnySkill(root, name),
};
const run = (line) => runSlashCommand(parseSlash(line), context);

test('/skills search ranks by NEED and names the next command', () => {
  const out = run('/skills search the game stutters and the frame rate drops').output.join('\n');
  assert.match(out, /Skills for "the game stutters/);
  assert.match(out.split('\n')[1], /game-self-test/, 'the self-test skill leads');
  assert.match(out, /\/skills show game-self-test/);
});

test('/skills search on the CLI never offers a builder-only skill', () => {
  const out = run('/skills search take a card payment with stripe checkout').output.join('\n');
  assert.doesNotMatch(out, /^\s+payments\s/m, '`payments` is applies-to: builder');
});

test('/skills show prints version, surface and triggers WITHOUT attaching', () => {
  const r = run('/skills show deliver-a-file');
  assert.equal(r.inject, undefined, 'show must not attach');
  assert.match(r.output[0], /deliver-a-file · v2 · both · triggers: download/);
  assert.ok(r.output.some((l) => l.includes('function toCsv')));
});

test('/skills use <name> attaches exactly like /skills <name>', () => {
  const a = run('/skills use multi-file-app');
  const b = run('/skills multi-file-app');
  assert.ok(a.inject && a.inject.length > 1000);
  assert.equal(a.inject, b.inject);
});

test('a missed name is a search: the refusal carries the closest skills by need', () => {
  const r = loadAnySkill(root, 'export bookings to a csv file for excel');
  assert.equal(r.ok, false);
  assert.match(r.error, /closest by need: deliver-a-file/);
});

test('ranking: trigger phrases beat prose, folding joins plurals, confidence needs a margin', () => {
  const skills = [
    { name: 'alpha', description: 'about payments and money', triggers: ['take money'] },
    { name: 'beta', description: 'payments mentioned once' },
  ];
  const hits = searchSkills('how do I take money', skills);
  assert.equal(hits[0].name, 'alpha');
  assert.equal(confidentSkill(hits)?.name, 'alpha');
  assert.equal(foldWord('payments'), 'payment');
  assert.deepEqual(parseTriggers('a, B ,, c'), ['a', 'b', 'c']);
  assert.equal(parseAppliesTo('BUILDER'), 'builder');
  assert.equal(parseAppliesTo('typo'), 'both', 'a typo never hides a skill');
  assert.equal(searchSkills('', skills).length, 0);
  // mutation: the same need with the trigger removed is not confident any more
  assert.equal(confidentSkill(searchSkills('how do I take money', [{ ...skills[0], triggers: [] }, skills[1]])), null);
});
