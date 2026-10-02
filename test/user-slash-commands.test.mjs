/**
 * ── COMMANDS THE PROJECT WRITES ITSELF — `.acuvo/commands/<name>.md` ─────────
 *
 * Roman, 2026-08-25: *"are we done with the CLI, does it have crazy
 * functionality and options like you?"* The honest answer, measured that day,
 * was six slash commands — all ours — and no way for a user to add a seventh.
 * This file is the guard on the answer to that.
 *
 * What it pins, in the order the failures would actually bite:
 *
 *   1. ⭐ A command RUNS THIS TURN (`effect: 'run'`), not the next one. The
 *      obvious implementation reuses `/skills`'s `inject`, and that ships a
 *      `/ship` that appears to work and does nothing until you type again.
 *   2. ⚠️ A BUILT-IN ALWAYS WINS, and the shadowed file is ANNOUNCED. A
 *      checked-in `help.md` that silently replaced `/help` would take away the
 *      one command a stuck user reaches for.
 *   3. ⚠️ ARGUMENTS ARE NEVER SILENTLY DISCARDED — including from a body that
 *      forgot `$ARGUMENTS`, which is the case that looks like the command
 *      ignoring you.
 *   4. ⚠️ IT COSTS ZERO HEAD BYTES. Nothing about these reaches the system
 *      prompt, so a user who writes none pays nothing on every round forever.
 *   5. Every existing `/` guarantee survives: an unwired session still gets a
 *      working `/help`, and a provider that throws does not kill the prompt.
 *
 * ⚠️ THE DISCOVERY HALF IS DELIBERATELY NOT RE-TESTED HERE. `bin/acuvo.mjs`
 * wires `discoverSkills`/`loadSkill` at a different `dir`, so frontmatter,
 * duplicate names, binary files, size caps and workspace containment are
 * already covered by `skills.test.mjs`. Re-asserting them would be a second
 * copy of the contract. What IS asserted below is that the wiring exists at
 * all — the reach failure this repository keeps paying for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import {
  RESERVED_COMMAND_NAMES,
  SLASH_COMMANDS,
  USER_COMMANDS_DIR,
  expandCommand,
  helpLines,
  parseSlash,
  runSlashCommand,
  userCommands,
} from '../lib/slash.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A session whose project defines two commands. */
const withCommands = (bodies) => ({
  commands: () => Object.keys(bodies).map((name) => ({ name, description: `run ${name}` })),
  loadCommand: (name) => (name in bodies
    ? { ok: true, name, file: `${USER_COMMANDS_DIR}/${name}.md`, body: bodies[name] }
    : { ok: false, error: `no command named "${name}"` }),
});

// ── 1. IT RUNS THIS TURN ────────────────────────────────────────────────────

test('⭐ a project command is sent as THIS turn, not queued for the next one', () => {
  const ctx = withCommands({ ship: 'Run the tests, then tag a release.' });
  const r = runSlashCommand(parseSlash('/ship'), ctx);
  assert.equal(r.effect, 'run', '/ship did not ask the loop to run anything');
  assert.equal(r.task, 'Run the tests, then tag a release.');
  assert.equal(r.inject, undefined,
    'the body was queued for the NEXT message — /ship would look like it worked and do nothing');
  assert.ok(!r.unknown, 'a defined command was reported as unknown');
});

test('the confirmation names the file and the size, so a wrong file is visible before it is paid for', () => {
  const ctx = withCommands({ ship: 'ship it' });
  const text = runSlashCommand(parseSlash('/ship'), ctx).output.join('\n');
  assert.match(text, /\.acuvo\/commands\/ship\.md/);
  assert.match(text, /this turn/);
});

test('⚠️ an EMPTY command file is refused rather than sent — a blank file must not become a paid round', () => {
  const r = runSlashCommand(parseSlash('/blank'), withCommands({ blank: '   \n\n  ' }));
  assert.notEqual(r.effect, 'run');
  assert.match(r.output.join('\n'), /empty/i);
});

test('a command whose file cannot be read says so, and does not run', () => {
  const ctx = {
    commands: () => [{ name: 'ship', description: '' }],
    loadCommand: () => ({ ok: false, error: 'could not read .acuvo/commands/ship.md: permission denied' }),
  };
  const r = runSlashCommand(parseSlash('/ship'), ctx);
  assert.notEqual(r.effect, 'run');
  assert.match(r.output.join('\n'), /permission denied/);
});

// ── 2. A BUILT-IN ALWAYS WINS, AND THE SHADOW IS ANNOUNCED ──────────────────

test('⚠️⚠️ a file called help.md CANNOT replace /help — the escape hatch is not overridable', () => {
  const ctx = withCommands({ help: 'this must never run' });
  const r = runSlashCommand(parseSlash('/help'), ctx);
  assert.notEqual(r.effect, 'run', 'a project file took over /help');
  assert.match(r.output.join('\n'), /Commands —/, '/help stopped being /help');
});

test('⭐ …and the shadowed file is REPORTED in /help, because a file that can never run is the invisible bug', () => {
  const ctx = withCommands({ help: 'x', cost: 'y', ship: 'z' });
  const text = runSlashCommand(parseSlash('/help'), ctx).output.join('\n');
  assert.match(text, /SHADOWED/);
  assert.match(text, /commands\/help\.md/);
  assert.match(text, /commands\/cost\.md/);
  assert.match(text, /\/ship/, 'the usable command vanished from /help along with the shadowed ones');
});

test('every built-in name is reserved, derived from the registry rather than retyped', () => {
  assert.deepEqual([...RESERVED_COMMAND_NAMES], SLASH_COMMANDS.map((c) => c.name));
  for (const name of RESERVED_COMMAND_NAMES) {
    const { usable, shadowed } = userCommands(withCommands({ [name]: 'x' }));
    assert.deepEqual(usable, [], `${name} was offered as a project command`);
    assert.deepEqual(shadowed, [name]);
  }
});

// ── 3. ARGUMENTS ────────────────────────────────────────────────────────────

test('$ARGUMENTS receives everything typed after the command', () => {
  const r = runSlashCommand(parseSlash('/check src/app.ts and lib/db.ts'),
    withCommands({ check: 'Review $ARGUMENTS carefully.' }));
  assert.equal(r.task, 'Review src/app.ts and lib/db.ts carefully.');
});

test('$1…$9 take one word each, and a missing one is empty rather than the literal $3', () => {
  assert.equal(expandCommand('from $1 to $2', 'alpha beta'), 'from alpha to beta');
  assert.equal(expandCommand('[$1][$3]', 'only'), '[only][]',
    '$3 was left in the prompt, which asks the model what $3 means');
});

test('⚠️ a body that forgot the placeholder STILL receives what was typed — silence here looks like being ignored', () => {
  const r = runSlashCommand(parseSlash('/check src/app.ts'),
    withCommands({ check: 'Review the code.' }));
  assert.match(r.task, /Review the code\./);
  assert.match(r.task, /src\/app\.ts/, 'the path the user typed was silently discarded');
});

test('…and a command typed with NO arguments gains no stray trailer', () => {
  assert.equal(expandCommand('Review the code.', ''), 'Review the code.');
  assert.equal(expandCommand('Review $ARGUMENTS.', ''), 'Review .');
});

// ── 4. IT COSTS ZERO HEAD BYTES ─────────────────────────────────────────────

test('⭐ nothing about project commands reaches the system prompt — the whole feature is free per round', () => {
  const prompt = readFileSync(join(PKG, 'lib/prompt.mjs'), 'utf8');
  assert.ok(!prompt.includes(USER_COMMANDS_DIR),
    `${USER_COMMANDS_DIR} is named in prompt.mjs — that is head bytes on every round of every run`);
  assert.ok(!/slash\.mjs/.test(prompt),
    'prompt.mjs imports the slash surface; the model must never be told these exist');
});

// ── 5. NOTHING THAT ALREADY WORKED STOPPED WORKING ──────────────────────────

test('⚠️ a session that wired no command provider still gets a working /help', () => {
  const text = helpLines().join('\n');
  for (const c of SLASH_COMMANDS) assert.ok(text.includes(c.usage), `${c.usage} vanished from /help`);
  assert.match(text, /exit/);
  assert.match(text, /\.acuvo\/commands/, '/help never tells anyone the feature exists');
});

test('⚠️ a provider that THROWS is an empty list, not a dead prompt', () => {
  const boom = { commands: () => { throw new Error('disk on fire'); } };
  assert.doesNotThrow(() => runSlashCommand(parseSlash('/help'), boom));
  assert.deepEqual(userCommands(boom), { usable: [], shadowed: [], wired: false });
  assert.deepEqual(userCommands({ commands: () => 'not an array' }), { usable: [], shadowed: [], wired: true });
});

test('a catalogued command with no loadCommand provider says so instead of crashing', () => {
  const r = runSlashCommand(parseSlash('/ship'), { commands: () => [{ name: 'ship' }] });
  assert.notEqual(r.effect, 'run');
  assert.match(r.output.join('\n'), /not available/);
});

test('⭐ a typo is answered with the PROJECT\'s command, not only with ours', () => {
  const r = runSlashCommand(parseSlash('/shp'), withCommands({ ship: 'x' }));
  assert.equal(r.unknown, true);
  assert.match(r.output.join('\n'), /\/ship/);
});

test('an unknown command is still unknown when the project defines others', () => {
  const r = runSlashCommand(parseSlash('/xyzzy'), withCommands({ ship: 'x' }));
  assert.equal(r.unknown, true);
  assert.match(r.output.join('\n'), /\/help/);
});

// ── 6. THE WIRING EXISTS — THE FAILURE THIS REPO KEEPS PAYING FOR ───────────

test('⭐⭐ bin/acuvo.mjs actually supplies both providers, and chat.mjs actually acts on effect:"run"', () => {
  const bin = readFileSync(join(PKG, 'bin/acuvo.mjs'), 'utf8');
  assert.match(bin, /commands:\s*\(\)\s*=>/, 'the slash context has no commands provider — /ship would never be found');
  assert.match(bin, /loadCommand:\s*\(name\)\s*=>/, 'nothing can load a command body');
  assert.match(bin, /USER_COMMANDS_DIR/, 'the directory is retyped somewhere instead of imported');

  const chat = readFileSync(join(PKG, 'lib/chat.mjs'), 'utf8');
  assert.match(chat, /effect === 'run'/,
    'chat.mjs prints the command and then `continue`s — the expansion is discarded and the turn never happens');
  assert.match(chat, /userCommands\(slashContext\)/,
    'the input box menu lists only the built-ins, so a project command is invisible to everyone but its author');
});
