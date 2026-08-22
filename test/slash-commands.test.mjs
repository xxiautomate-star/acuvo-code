/**
 * ── WHAT THIS SUITE IS GUARDING ─────────────────────────────────────────────
 *
 * ⚠️ MEASURED 2026-08-16 before any of this existed: `grep -c "'/'"
 * lib/chat.mjs` → **0**. The interactive session understood four words and
 * nothing else, while `skills.mjs`, `mcp.mjs` and the budget ledger all worked
 * and were unreachable from the prompt.
 *
 * Three properties are load-bearing:
 *
 *   1. DISCOVERABILITY. An unknown command must name the near matches. A `/`
 *      surface whose failure mode is "unknown command" has solved nothing.
 *   2. A LEADING SLASH IS NOT ALWAYS A COMMAND. `/etc/hosts is wrong` is a task.
 *      Claiming it would eat the user's instruction — a check that fails correct
 *      work, which this codebase has paid for repeatedly.
 *   3. A COMMAND COSTS NOTHING. It must not call the model, must not count as a
 *      turn, and must not append to the history. `/cost` is asked by somebody
 *      watching their spend; answering it must not change the answer.
 *
 * ⭐ AND `/skills <name>` MUST ACTUALLY LOAD. Printing the skill to the terminal
 * would look identical from the outside and do nothing at all, because the model
 * never sees the terminal. There is a test below that drives the whole chat loop
 * and asserts the skill text reached `runOne`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSlash,
  suggestCommands,
  editDistance,
  helpLines,
  runSlashCommand,
  SLASH_COMMANDS,
} from '../lib/slash.mjs';
import { runChat } from '../lib/chat.mjs';

/** A writable that keeps what was written, so output is data. */
function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

/** A non-TTY input carrying scripted lines — the piped path `runChat` supports. */
function lines(...ls) {
  const body = `${ls.join('\n')}\n`;
  return { isTTY: false, async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8'); } };
}

// ── 1. WHAT IS A COMMAND, AND WHAT IS A SENTENCE ────────────────────────────

test('a bare word after a slash is a command', () => {
  assert.deepEqual(parseSlash('/help'), { name: 'help', args: '' });
  assert.deepEqual(parseSlash('/skills brief'), { name: 'skills', args: 'brief' });
  assert.deepEqual(parseSlash('/HELP'), { name: 'help', args: '' }, 'commands must not be case-sensitive');
  assert.deepEqual(parseSlash('/skills   brief  '), { name: 'skills', args: 'brief' });
});

test('⚠️⚠️ AN ABSOLUTE PATH IS A TASK, NOT A COMMAND — claiming it would eat the instruction', () => {
  for (const sentence of [
    '/etc/hosts is wrong, fix it',
    '/usr/local/bin/node is the wrong version',
    '/var/log/app.log has the stack trace',
    '/',
    '/ help',
    '  /help',
    '/2fa is broken',
  ]) {
    assert.equal(parseSlash(sentence), null,
      `"${sentence}" was claimed as a command — the user's instruction would have been answered with "unknown command"`);
  }
});

test('editDistance is a real metric, not a same/different flag', () => {
  assert.equal(editDistance('mcp', 'mcp'), 0);
  assert.equal(editDistance('mcp', 'mcpx'), 1);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

// ── 2. DISCOVERABILITY — THE WHOLE POINT ────────────────────────────────────

test('⭐ a typo names the command that was meant', () => {
  assert.deepEqual(suggestCommands('skil'), ['skills']);
  assert.deepEqual(suggestCommands('halp'), ['help']);
  assert.ok(suggestCommands('mdoel').includes('model'), 'a transposition found nothing');
});

test('⭐ a half-typed prefix is a match at any length — /s obviously means /skills', () => {
  assert.ok(suggestCommands('s').includes('skills'), 'a single-letter prefix suggested nothing');
  assert.ok(suggestCommands('c').includes('cost') && suggestCommands('c').includes('clear'));
});

test('⚠️ and something that resembles nothing gets NO suggestion rather than a padded list', () => {
  assert.deepEqual(suggestCommands('xyzzy'), [],
    'noise was offered as a suggestion, which teaches people to ignore the suggestion line');
  assert.deepEqual(suggestCommands(''), []);
});

test('an unknown command is answered here, with the near match, and never forwarded to the model', () => {
  const r = runSlashCommand({ name: 'skil', args: '' }, {});
  assert.equal(r.unknown, true);
  assert.match(r.output.join('\n'), /Did you mean \/skills\?/);
});

test('an unknown command with no near match still points somewhere useful', () => {
  const r = runSlashCommand({ name: 'xyzzy', args: '' }, {});
  assert.equal(r.unknown, true);
  assert.match(r.output.join('\n'), /\/help/);
});

// ── 3. /help IS GENERATED, SO IT CANNOT GO STALE ────────────────────────────

test('⭐ every registered command appears in /help — a hand-written list is the copy that rots', () => {
  const text = helpLines().join('\n');
  for (const c of SLASH_COMMANDS) {
    assert.ok(text.includes(c.usage), `${c.usage} is a command and is missing from /help`);
    assert.ok(text.includes(c.summary), `${c.name} has no summary in /help`);
  }
  assert.match(text, /exit/, '/help does not say how to leave');
});

test('every registered command is implemented — the registry and the switch can drift', () => {
  for (const c of SLASH_COMMANDS) {
    const r = runSlashCommand({ name: c.name, args: '' }, {});
    assert.ok(Array.isArray(r.output) && r.output.length > 0, `/${c.name} produced no output`);
    assert.ok(!/not implemented/.test(r.output.join('\n')), `/${c.name} is advertised by /help and not implemented`);
    assert.ok(!r.unknown, `/${c.name} is in the registry and reported as unknown`);
  }
});

// ── 4. THE PROVIDERS, AND THEIR ABSENCE ─────────────────────────────────────

test('⚠️ a missing provider is an answer, not a crash — /help must work in a session that wired nothing', () => {
  for (const c of SLASH_COMMANDS) {
    assert.doesNotThrow(() => runSlashCommand({ name: c.name, args: 'anything' }, {}));
  }
  assert.match(runSlashCommand({ name: 'cost', args: '' }, {}).output.join('\n'), /not available/);
});

test('⚠️ "no skills here" and "the catalogue was never wired" are different sentences', () => {
  const none = runSlashCommand({ name: 'skills', args: '' }, { skills: () => [] }).output.join('\n');
  const unwired = runSlashCommand({ name: 'skills', args: '' }, {}).output.join('\n');
  assert.match(none, /No skills found/);
  assert.match(unwired, /not available/);
  assert.notEqual(none, unwired,
    'a wired-but-empty catalogue and an unwired one read identically, so the user cannot tell which problem they have');
});

test('/skills lists what it was given', () => {
  const r = runSlashCommand({ name: 'skills', args: '' }, {
    skills: () => [{ name: 'brief', description: 'how we write briefs' }, { name: 'review', description: 'the checklist' }],
  });
  const text = r.output.join('\n');
  assert.match(text, /2 skills/);
  assert.match(text, /brief\s+how we write briefs/);
  assert.match(text, /review\s+the checklist/);
});

test('⭐⭐ /skills <name> INJECTS the skill — printing it would look identical and do nothing', () => {
  const r = runSlashCommand({ name: 'skills', args: 'brief' }, {
    skills: () => [{ name: 'brief', description: 'd' }],
    loadSkill: () => ({ ok: true, name: 'brief', body: 'ALWAYS START WITH THE MEASUREMENT' }),
  });
  assert.equal(r.inject, 'ALWAYS START WITH THE MEASUREMENT',
    'the skill body was not queued for the next turn, so the model never sees it');
  assert.match(r.output.join('\n'), /NEXT message/);
});

test('⚠️ the loader returns `body`; reading a field it does not emit ships an empty inject that reports success', () => {
  const r = runSlashCommand({ name: 'skills', args: 'brief' }, {
    skills: () => [],
    loadSkill: () => ({ ok: true, name: 'brief', body: '' }),
  });
  assert.ok(!r.inject, 'an empty skill was queued as though it carried something');
  assert.match(r.output.join('\n'), /empty/);
});

test('a misspelled skill name suggests the real one', () => {
  const r = runSlashCommand({ name: 'skills', args: 'brif' }, {
    skills: () => [{ name: 'brief', description: 'd' }],
    loadSkill: () => ({ ok: false, error: 'no skill named "brif"' }),
  });
  assert.match(r.output.join('\n'), /\/skills brief/);
});

test('⚠️ /mcp reports a BROKEN config as broken, not as "you have no servers"', () => {
  const broken = runSlashCommand({ name: 'mcp', args: '' }, {
    mcp: () => ({ source: 'a config error: .acuvo/mcp.json is not valid JSON', servers: [] }),
  }).output.join('\n');
  assert.match(broken, /config error/,
    'a syntax error in mcp.json was reported as an empty server list, sending the user to the wrong problem');
});

test('/mcp lists servers with transport, and omits a tool count it does not have', () => {
  const text = runSlashCommand({ name: 'mcp', args: '' }, {
    mcp: () => ({ source: '.acuvo/mcp.json', servers: [{ name: 'files', transport: 'stdio', status: 'configured' }] }),
  }).output.join('\n');
  assert.match(text, /files/);
  assert.match(text, /stdio/);
  assert.ok(!/\btools?\b/.test(text),
    '"0 tools" was printed for a server we never connected to — that reads as broken rather than as unknown');
});

test('/cost reports the SESSION total against the ceiling, and says when the ceiling is a default', () => {
  const text = runSlashCommand({ name: 'cost', args: '' }, {
    cost: () => ({ spentUsd: 0.0031, limitUsd: 0.02, limitIsDefault: true, turns: 3 }),
  }).output.join('\n');
  assert.match(text, /0\.003100/);
  assert.match(text, /3 turns/);
  assert.match(text, /0\.016900/, 'the remaining budget is not shown, which is the number the question was about');
  assert.match(text, /default/);
});

test('/model names the model and where the choice came from', () => {
  const text = runSlashCommand({ name: 'model', args: '' }, {
    model: () => ({ name: 'deepseek/deepseek-v4-flash', source: '--model' }),
  }).output.join('\n');
  assert.match(text, /deepseek\/deepseek-v4-flash/);
  assert.match(text, /--model/);
});

// ── 5. REACH — THROUGH THE REAL CHAT LOOP ───────────────────────────────────
//
// ⭐ ONLY THE END-TO-END RUN PROVES REACH. Every assertion above passes against
// a module nobody calls; this codebase has shipped that exact defect four times
// in one day, inside the commits fixing it. These drive `runChat` itself.

test('⭐⭐ REACH: a command is handled by the loop and NEVER reaches the model', async () => {
  const seen = [];
  const out = sink();
  const result = await runChat({
    runOne: async (task) => { seen.push(task); return { ok: true, messages: [] }; },
    render: () => {},
    input: lines('/help', 'do the actual work', 'exit'),
    output: out,
  });
  assert.deepEqual(seen, ['do the actual work'],
    '/help was forwarded to the model — it costs money and produces an essay about a command');
  assert.equal(result.turns, 1, 'a free command was counted as a paid turn');
  assert.match(out.text(), /Commands —/, '/help produced no help');
});

test('⭐⭐ REACH: /skills <name> puts the skill text in front of the NEXT task', async () => {
  const seen = [];
  const result = await runChat({
    runOne: async (task) => { seen.push(task); return { ok: true, messages: [] }; },
    render: () => {},
    input: lines('/skills brief', 'write the report', 'exit'),
    output: sink(),
    slashContext: {
      skills: () => [{ name: 'brief', description: 'd' }],
      loadSkill: () => ({ ok: true, name: 'brief', body: 'RULE: cite the measurement' }),
    },
  });
  assert.equal(result.turns, 1);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /RULE: cite the measurement/, 'the loaded skill never reached the model');
  assert.match(seen[0], /write the report/, 'the skill REPLACED the task instead of preceding it');
});

test('⚠️ REACH: the injected skill is used ONCE — a second task must not silently carry it', async () => {
  const seen = [];
  await runChat({
    runOne: async (task) => { seen.push(task); return { ok: true, messages: [] }; },
    render: () => {},
    input: lines('/skills brief', 'first task', 'second task', 'exit'),
    output: sink(),
    slashContext: {
      skills: () => [],
      loadSkill: () => ({ ok: true, name: 'brief', body: 'RULE: cite the measurement' }),
    },
  });
  assert.match(seen[0], /RULE: cite the measurement/);
  assert.ok(!/RULE: cite the measurement/.test(seen[1]),
    'the skill stayed armed and attached itself to an unrelated later question');
});

test('⭐⭐ REACH: /clear drops the history the loop is carrying', async () => {
  const histories = [];
  await runChat({
    runOne: async (task, prior) => {
      histories.push(prior);
      return { ok: true, messages: [{ role: 'system', content: 's' }, { role: 'user', content: task }] };
    },
    render: () => {},
    input: lines('one', 'two', '/clear', 'three', 'exit'),
    output: sink(),
  });
  assert.equal(histories[0], null, 'the first turn started with a history');
  assert.ok(Array.isArray(histories[1]), 'the second turn did not carry the first turn forward');
  assert.equal(histories[2], null, '/clear did not clear the history — the next turn still carried the conversation');
});

test('⚠️ REACH: an ordinary task beginning with a slash still reaches the model', async () => {
  const seen = [];
  await runChat({
    runOne: async (task) => { seen.push(task); return { ok: true, messages: [] }; },
    render: () => {},
    input: lines('/etc/hosts is wrong, fix it', 'exit'),
    output: sink(),
  });
  assert.deepEqual(seen, ['/etc/hosts is wrong, fix it'],
    'a path-shaped instruction was swallowed as a bad command and the user lost their sentence');
});

test('the session banner advertises /help — a surface nobody is told about is not a surface', async () => {
  const out = sink();
  await runChat({ runOne: async () => ({ ok: true, messages: [] }), render: () => {}, input: lines('exit'), output: out });
  assert.match(out.text(), /\/help/);
});
