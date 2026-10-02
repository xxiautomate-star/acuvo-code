/**
 * ── ⭐⭐ THE STICKIEST THING IN A CODING TOOL IS THE LEAST PORTABLE ──────────
 *
 * A model is rented and swappable. A `/deploy` command somebody refined over
 * four months is theirs, and having to rewrite it is the most concrete reason
 * not to move. This pins that we FIND those assets, that we never silently
 * convert them, and that hooks — which are shell commands — are never carried.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectToolAssets, collectHooks, describeSweep } from '../lib/tool-import.mjs';

const io = (tree) => ({
  exists: (p) => Object.prototype.hasOwnProperty.call(tree, p),
  listDir: (p) => tree[p] ?? [],
  readFile: (p) => tree[p] ?? '',
});

test('finds slash commands a person built up', () => {
  const a = collectToolAssets({
    root: 'r',
    ...io({ 'r/.claude/commands': ['deploy.md', 'review.md', 'notes.txt'] }),
  });
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'commands');
  assert.deepEqual(a[0].names, ['deploy', 'review']);
});

/**
 * ⚠️ SKILLS ARE A DIRECTORY PER SKILL; COMMANDS ARE A FILE PER COMMAND. Counting
 * `.md` files in a skills folder finds nothing, because the markdown is one
 * level down in `<name>/SKILL.md` — and reports "no skills" to somebody with
 * twenty of them.
 */
test('reads the skills shape, which is a directory per skill', () => {
  const a = collectToolAssets({
    root: 'r',
    ...io({ 'r/.claude/skills': ['pdf-tools', 'brand-voice', 'README.md'] }),
  });
  assert.equal(a[0].kind, 'skills');
  assert.deepEqual(a[0].names, ['pdf-tools', 'brand-voice']);
});

test('finds Cursor commands and rules directories too', () => {
  const a = collectToolAssets({
    root: 'r',
    ...io({ 'r/.cursor/commands': ['ship.md'], 'r/.cursor/rules': ['style.md', 'api.md'] }),
  });
  assert.deepEqual(a.map((x) => x.kind).sort(), ['commands', 'rules']);
});

test('nothing found is nothing claimed', () => {
  assert.deepEqual(collectToolAssets({ root: 'r', ...io({}) }), []);
  assert.match(describeSweep({}), /Nothing from another coding tool/);
});

/**
 * ⚠️⚠️ A HOOK IS A SHELL COMMAND THE HARNESS RUNS ON AN EVENT. The command
 * string must never leave this module: hook configs are where people put paths,
 * tokens and internal hostnames, and the count plus the event is all anyone
 * needs to decide.
 */
test('hooks are counted by event and the command never escapes', () => {
  const cmd = 'curl -H "Authorization: Bearer sk-realtoken" https://internal.corp/notify';
  const h = collectHooks({
    root: 'r',
    ...io({ 'r/.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [{ command: cmd }, { command: 'x' }] } }) }),
  });
  assert.equal(h[0].events[0].event, 'PreToolUse');
  assert.equal(h[0].events[0].count, 2);
  const all = JSON.stringify(h) + describeSweep({ hooks: h });
  assert.equal(all.includes('sk-realtoken'), false, 'a hook command leaked');
  assert.equal(all.includes('internal.corp'), false, 'a hook command leaked');
});

test('the sweep says plainly that hooks are not brought across', () => {
  const h = collectHooks({
    root: 'r',
    ...io({ 'r/.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ command: 'x' }] } }) }),
  });
  const out = describeSweep({ hooks: h });
  assert.match(out, /NOT/);
  assert.match(out, /shell commands/);
});

test('a BOM in settings.json is an encoding, not a broken file', () => {
  const h = collectHooks({
    root: 'r',
    ...io({ 'r/.claude/settings.json': `﻿${JSON.stringify({ hooks: { Stop: [{ command: 'x' }] } })}` }),
  });
  assert.equal(h[0].error, undefined);
});

/**
 * ⭐ THE OUTPUT MUST NOT IMPLY IT CONVERTED ANYTHING. A command carries the other
 * tool's frontmatter and `$ARGUMENTS` semantics; silently rewriting it produces
 * something that looks imported and behaves differently.
 */
test('the sweep states that nothing was copied or converted', () => {
  const a = collectToolAssets({ root: 'r', ...io({ 'r/.claude/commands': ['deploy.md'] }) });
  const out = describeSweep({ assets: a });
  assert.match(out, /Nothing was copied, converted or enabled/);
});

/**
 * ⚠️ THE SECOND CASE HERE WAS A WRONG TEST, NOT A WRONG BEHAVIOUR. It asserted
 * that `{rules: null}` renders a "none found" line — but with no assets, no
 * hooks and no MCP either, the honest answer is that nothing from another tool
 * is here at all, and a rules line under that heading would be noise. Fixed
 * toward the code rather than the other way round.
 */
test('reports which rules file is already in force', () => {
  assert.match(describeSweep({ rules: { file: 'CLAUDE.md' } }), /already reads CLAUDE\.md/);
  assert.match(
    describeSweep({ rules: { file: 'CLAUDE.md' }, assets: [{ kind: 'commands', dir: '.claude/commands', tool: 'Claude Code', count: 1, names: ['ship'] }] }),
    /already reads CLAUDE\.md/,
  );
  assert.match(describeSweep({ rules: null }), /Nothing from another coding tool/);
});

/**
 * ⭐ FOUND ON THIS REPO THE FIRST TIME THE COMMAND RAN FOR REAL: a CLAUDE.md
 * larger than MAX_MEMORY_BYTES is silently cut, and the person relying on the
 * rules at the bottom of it never knows. Saying so is the whole point of
 * surfacing which file is in force.
 */
test('says when the rules file in force is being truncated', () => {
  assert.match(describeSweep({ rules: { file: 'CLAUDE.md', truncated: true } }), /truncated/);
});
